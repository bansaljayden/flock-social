'use strict';
// ---------------------------------------------------------------------------
// The open-hours call filter in scripts/ml/collectRealtime.js, against a REAL
// Postgres, with BestTime stubbed. Zero paid calls.
//
// WHAT IS BEING PINNED. The collector paces at one call per second and that
// pacing is not negotiable (two account-wide 403s bought it), so the only way
// to run the sweep more often is to stop making calls that cannot return
// anything. A venue that is shut has one possible answer, and before
// 2026-09-03 we spent a second of the cron's wall clock asking for it: the last
// unfiltered run reported 245 rows against 1,149 skips.
//
// The filter reads the venue's OWN weekly forecast curve — the rows the model
// trains on, on the venue_local axis since migration 023 — and treats a venue
// as open at local hour H when that curve rises above zero anywhere in
// H-2..H+2 on any day of the week. Everything unknown resolves toward spending
// the call: no weekly rows means call, a curve that does not cover all 24 hours
// means call, a failed lookup means call everything, a clock disagreement means
// call.
//
// The tests below are written so the wall clock cannot make them flake. The
// fixtures are seeded RELATIVE to the venue's current local hour: one venue is
// open now, one is open twelve hours from now (so it is shut now, and stays
// shut across any minute this suite could straddle, because the padding is two
// hours), one has no weekly curve at all, and one has a curve covering only
// three hours of the day.
//
// What must NOT change is what a row contains. The last test reads the row the
// open venue produced and asserts hour, hour_axis and label_source are exactly
// what the collector wrote before this filter existed.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');
const { removeTempDir } = require('./helpers/removeTempDir');

const PG_PORT = pickEmbeddedPgPort('mlOpenHoursSkip');
const CONN = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_openhours_test`;

// scripts/ml/* call dotenv.config() on backend/.env, which points at the LIVE
// Railway database, and dotenv never overwrites an already-set variable. These
// three lines before the requires are the only thing standing between this
// suite and production.
process.env.DATABASE_URL = CONN;
process.env.PGSSLMODE = 'disable';
delete process.env.BESTTIME_API_KEY;

// Every besttime id this run asked about, in order. The whole suite is an
// assertion about the CONTENTS of this array.
let CALLED = [];
// Section 4 makes the stubbed answers slow, so the collector's calls overlap
// the way BestTime's slow hours make them overlap in production, and counts
// how many were open at once. Zero delay everywhere else.
let LIVE_DELAY_MS = 0;
let OPEN_CALLS = 0;
let PEAK_OPEN_CALLS = 0;

function stubModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}
stubModule('../services/weatherService', {
  getWeather: async () => ({
    temp: 68, humidity: 50, windSpeed: 4, conditions: 'clear sky', conditionId: 800, isRaining: false,
  }),
  getForecast: async () => [],
});
stubModule('../scripts/ml/bestTimeService', {
  fetchWeeklyForecast: async () => { throw new Error('the realtime collector must never fetch a weekly forecast'); },
  fetchLiveBusyness: async (venueId) => {
    CALLED.push(venueId);
    OPEN_CALLS++;
    PEAK_OPEN_CALLS = Math.max(PEAK_OPEN_CALLS, OPEN_CALLS);
    try {
      if (LIVE_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, LIVE_DELAY_MS));
      return { forecastedBusyness: 35, liveBusyness: 62, liveAvailable: true, hour: null, venueOpen: true };
    } finally {
      OPEN_CALLS--;
    }
  },
});
stubModule('../scripts/ml/eventService', {
  getNearestEvent: async () => ({
    event_nearby: false, event_distance_km: null, event_size: null, event_type: null, event_hours_until: null,
  }),
});
// The one-second pacing is load-bearing in production and pure latency here.
// Stubbing sleep leaves the pacing line untouched in the collector (a test that
// edited it would be a test that changed the thing it guards) while keeping the
// suite to seconds rather than minutes.
const realConfig = require('../scripts/ml/config');
stubModule('../scripts/ml/config', { ...realConfig, sleep: async () => {} });

const { migrate } = require('../db/migrate');
const { getLocalTime } = realConfig;
const collectRealtime = require('../scripts/ml/collectRealtime');

// collectRealtime.run() ends its pool, so a second run needs a fresh instance.
// The stubs above stay in the cache.
function freshCollector() {
  delete require.cache[require.resolve('../scripts/ml/collectRealtime')];
  return require('../scripts/ml/collectRealtime');
}

// philly is one of the two cities the collector sweeps BY DEFAULT, so this
// suite exercises the scoped mask query (the `city = ANY($2)` branch) rather
// than the --all-cities one. Its timezone comes from config.CITIES, which is
// also where the collector gets it.
const CITY = 'philly';
const TZ = realConfig.CITIES[CITY].tz;

const OPEN_PLACE = 'ChIJopenHoursOpenVen';
const CLOSED_PLACE = 'ChIJopenHoursShutVen';
const BLIND_PLACE = 'ChIJopenHoursBlindVn';
const PARTIAL_PLACE = 'ChIJopenHoursPartial';

let pg;
let pool;
let dataDir;
const venueIds = {};
let nowHour;

async function activeVenue(place, name) {
  const { rows } = await pool.query(
    `INSERT INTO ml_venues (google_place_id, besttime_venue_id, name, city, latitude, longitude,
                            venue_category, timezone, is_active)
     VALUES ($1, $2, $3, $4, 39.95, -75.16, 'bar', $5, true)
     RETURNING id`,
    [place, 'bt_' + place, name, CITY, TZ]
  );
  return rows[0].id;
}

// A full 24-hour weekly curve for one day of the week: `busyHours` carry real
// traffic, every other hour is the zero BestTime writes for a shut venue. That
// is the exact shape of the production corpus, which is what the filter reads.
async function seedWeeklyCurve(venueId, busyHours, hoursCovered = 24) {
  for (let hour = 0; hour < hoursCovered; hour++) {
    await pool.query(
      `INSERT INTO ml_training_data
         (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, busyness_pct)
       VALUES ($1, 'weekly', 'venue_local', 3, $2, 'bar', $3)`,
      [venueId, hour, busyHours.includes(hour) ? 45 : 0]
    );
  }
}

test.before(async () => {
  dataDir = path.join(os.tmpdir(), 'flock-openhours-pg-' + Date.now());
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'mlOpenHoursSkip', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_openhours_test');
  pool = new Pool({ connectionString: CONN });
  await migrate(pool);

  nowHour = getLocalTime(TZ).hour;

  venueIds.open = await activeVenue(OPEN_PLACE, 'Open Right Now Bar');
  venueIds.closed = await activeVenue(CLOSED_PLACE, 'Small Hours Bar');
  venueIds.blind = await activeVenue(BLIND_PLACE, 'No Weekly Curve Bar');
  venueIds.partial = await activeVenue(PARTIAL_PLACE, 'Half a Curve Bar');

  // Open now, and only now. Twelve hours away is ten hours clear of the two
  // hours of padding, so neither fixture can drift into the other's band while
  // the suite runs.
  await seedWeeklyCurve(venueIds.open, [nowHour]);
  await seedWeeklyCurve(venueIds.closed, [(nowHour + 12) % 24]);
  // venueIds.blind gets no weekly rows at all, on purpose.
  // venueIds.partial gets THREE hours of curve, none of them now. Judged on
  // that, it would look shut; it must be called anyway, because three hours of
  // rows is a hole in our collection rather than a fact about the venue.
  await seedWeeklyCurve(venueIds.partial, [(nowHour + 12) % 24], 3);
});

test.after(async () => {
  await pool?.end().catch(() => {});
  // The shared pool buildRecentDeviation queries through, closed before the
  // server stops so its idle connections are not cut from under it.
  const shared = require.cache[require.resolve('../config/database')];
  if (shared) await shared.exports.end().catch(() => {});
  await pg?.stop().catch(() => {});
  removeTempDir(dataDir, 'mlOpenHoursSkip');
});

// ---------------------------------------------------------------------------
// 1. The rule itself, with no database in the way
// ---------------------------------------------------------------------------

test('a venue shut in its local small hours is not callable; the same venue in the evening is', () => {
  const { buildOpenHourMask, isOpenAtHour } = collectRealtime;
  // An evening bar: BestTime's curve for it rises at 5 PM and runs to midnight.
  const bar = buildOpenHourMask([17, 18, 19, 20, 21, 22, 23]);

  for (const smallHour of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
    assert.strictEqual(isOpenAtHour(bar, smallHour), false,
      `hour ${smallHour} is outside the curve and its padding; calling it buys a second of cron for nothing`);
  }
  for (const evening of [18, 19, 20, 21, 22, 23]) {
    assert.strictEqual(isOpenAtHour(bar, evening), true, `hour ${evening} is prime live-data time`);
  }
});

test('the padding is two hours wide, on both sides, and wraps midnight', () => {
  const { buildOpenHourMask, isOpenAtHour, OPEN_HOUR_PAD } = collectRealtime;
  assert.strictEqual(OPEN_HOUR_PAD, 2,
    'measured on production 2026-09-03: +/-2 week-wide is the only candidate rule that would '
    + 'not have dropped one of the 1,198 live readings ever collected (+/-1 loses 7, none loses 18)');

  const lateBar = buildOpenHourMask([23]);
  assert.deepStrictEqual(
    [...Array(24).keys()].filter((h) => isOpenAtHour(lateBar, h)),
    [0, 1, 21, 22, 23],
    'an hour band has to wrap midnight or every late venue loses its closing hours'
  );
});

test('no evidence means call: an unknown never costs a reading', () => {
  const { buildOpenHourMask, isOpenAtHour } = collectRealtime;
  for (const hour of [0, 4, 11, 20]) {
    assert.strictEqual(isOpenAtHour(undefined, hour), true, 'a venue with no weekly curve must be called');
    assert.strictEqual(isOpenAtHour(null, hour), true, 'a failed lookup must call everything');
  }
  // A curve of nothing but zeros is what BestTime writes for a venue it has no
  // model for. That is genuinely no evidence of an open hour anywhere.
  assert.strictEqual(buildOpenHourMask([]), 0);
  assert.strictEqual(isOpenAtHour(0, 20), false);
});

// ---------------------------------------------------------------------------
// 2. The collector, end to end, against a real database
// ---------------------------------------------------------------------------

test('the sweep calls the open venue and the unknown one, and never calls the shut one', async () => {
  CALLED = [];
  const lines = [];
  const log = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  let fresh;
  try {
    fresh = freshCollector();
    await fresh.run();
  } finally {
    console.log = log;
  }

  assert.ok(CALLED.includes('bt_' + OPEN_PLACE),
    'the venue whose own weekly curve is busy at this local hour must be called');
  assert.ok(CALLED.includes('bt_' + BLIND_PLACE),
    'a venue with no weekly curve has no evidence against it and must be called');
  assert.ok(CALLED.includes('bt_' + PARTIAL_PLACE),
    'a venue whose weekly rows cover only part of the day may not be judged by them');
  assert.ok(!CALLED.includes('bt_' + CLOSED_PLACE),
    `the venue whose curve is busy only at ${(nowHour + 12) % 24}:00 local was called at `
    + `${nowHour}:00 local; that call can only ever return "no live data"`);
  assert.strictEqual(CALLED.length, 3, 'exactly three of the four venues are worth a call right now');

  // NARROWER OPEN-HOURS RULES, counted on these calls: only the open venue has
  // a full curve to judge by (Wednesday, busy at nowHour), and it came back
  // live. The week-wide band keeps it; a same-weekday band keeps it only on a
  // Wednesday (or across midnight into one), so the expectation is computed
  // on the venue's local clock as the run ends.
  const { NARROWER_OPEN_HOUR_RULES, narrowRuleCalls, weekDayMasks } = fresh;
  const local = getLocalTime(TZ);
  const days = weekDayMasks([3 * 24 + nowHour]);
  const skipped = NARROWER_OPEN_HOUR_RULES.map((rule) => (narrowRuleCalls(days, local.dayOfWeek, local.hour, rule) ? 0 : 1));
  assert.strictEqual(skipped[2], 0, 'the week-wide band covers the hour the venue is busy at');
  assert.ok(lines.includes('[ML:Realtime] Narrower open-hours rules on this run\'s calls to venues with a full curve '
    + '(calls each would not have made, live readings among them): main scope, 1 calls (1 live): '
    + NARROWER_OPEN_HOUR_RULES.map((rule, i) => `${rule.label} ${skipped[i]} (${skipped[i]} live)`).join(', ') + '.'),
  `no narrower-rules line for the one judged call: ${lines.filter((l) => /Narrower/.test(l)).join(' | ') || 'none printed'}`);
});

test('the row the open venue produced is unchanged by the filter', async () => {
  const { rows } = await pool.query(
    `SELECT hour, hour_axis, label_source, collection_mode, observed_date, busyness_pct, vendor_forecast_pct
       FROM ml_training_data WHERE venue_id = $1 AND collection_mode = 'realtime'`,
    [venueIds.open]
  );
  assert.strictEqual(rows.length, 1);
  const row = rows[0];
  assert.strictEqual(row.hour_axis, 'venue_local', 'the hour axis is the collector\'s, not the filter\'s');
  assert.strictEqual(row.label_source, 'live');
  assert.strictEqual(row.busyness_pct, 62);
  assert.strictEqual(row.vendor_forecast_pct, 35);
  assert.ok(row.hour === nowHour || row.hour === (nowHour + 1) % 24,
    'the row still carries the true venue-local hour the collector computed');
  assert.ok(row.observed_date, 'observed_date is what migration 024 keys the realtime slot on');

  const { rows: shut } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ml_training_data WHERE venue_id = $1 AND collection_mode = 'realtime'`,
    [venueIds.closed]
  );
  assert.strictEqual(shut[0].n, 0, 'a venue that was never called cannot have written a row');
});

test('--no-open-hours calls everything, so the filter can always be stood down', async () => {
  // The sweep above recorded this hour's rows, and a venue that already holds
  // its row for the hour is not called again (ALREADY RECORDED THIS HOUR), so
  // the hour starts clean here: this test is about the open-hours filter.
  const fixtures = [venueIds.open, venueIds.closed, venueIds.blind, venueIds.partial];
  await pool.query(`DELETE FROM ml_training_data WHERE collection_mode = 'realtime' AND venue_id = ANY($1::int[])`, [fixtures]);
  const sweepNoFilter = async () => {
    CALLED = [];
    process.argv.push('--no-open-hours');
    try {
      await freshCollector().run();
    } finally {
      process.argv.splice(process.argv.indexOf('--no-open-hours'), 1);
    }
  };
  const slot = () => { const t = getLocalTime(TZ); return `${t.dateStr} ${t.hour}`; };
  const slotBefore = slot();
  await sweepNoFilter();
  assert.strictEqual(CALLED.length, 4,
    'with the filter off every venue in scope is called, including the shut one');
  assert.ok(CALLED.includes('bt_' + CLOSED_PLACE));

  // Swept again inside the same local hour, every venue already holds the
  // row its answer would make, so none is called, and a run that wrote
  // nothing for that reason is not refused as empty. (If the hour turned at
  // any point across the two sweeps the rows can be in different hours, and
  // the second sweep rightly calls.)
  try {
    await sweepNoFilter();
    if (slot() === slotBefore) {
      assert.deepStrictEqual(CALLED, [], 'a venue already recorded this local hour was called again');
    }
  } finally {
    // The next section tests the closed-hours path alone, with no rows in
    // the way.
    await pool.query(`DELETE FROM ml_training_data WHERE collection_mode = 'realtime' AND venue_id = ANY($1::int[])`, [fixtures]);
  }
});

// ---------------------------------------------------------------------------
// 3. The refusal that an all-closed sweep would otherwise trip
// ---------------------------------------------------------------------------

test('a sweep where every venue is shut writes nothing and does NOT refuse', async () => {
  // The old zero-rows guard refused any completed run that wrote no rows unless
  // every venue had been called and skipped. A 4 AM sweep under this filter
  // calls nobody, so that guard would have exited non-zero every night. The
  // guard is still there — it just counts the uncalled venues as accounted for.
  await pool.query('UPDATE ml_venues SET is_active = (id = $1)', [venueIds.closed]);
  CALLED = [];
  try {
    await freshCollector().run();
    assert.strictEqual(CALLED.length, 0, 'the only active venue is shut at this local hour');
  } finally {
    await pool.query('UPDATE ml_venues SET is_active = true');
  }
});

// ---------------------------------------------------------------------------
// 4. Overlapping calls, through the real write path
//
// Since 2026-09-25 the sweep lets several calls wait on BestTime at once
// (collectRealtimeConcurrency.test.js pins the scheduling on a simulated
// clock). What only a real database can show is that the overlap reaches the
// write path intact: each venue is written once, through the corpus lock, and
// the counters the summary prints are the rows the audit reads back.
// ---------------------------------------------------------------------------

test('overlapping calls write exactly one row per venue, and the summary agrees with the table', async () => {
  // Twelve more venues with no weekly curve, so the filter calls every one of
  // them at any hour. Answers take 150 ms, and this suite's sleep stub makes
  // the start pace instant, so the only thing bounding how many calls are open
  // at once is the collector's in-flight limit.
  const extra = [];
  for (let i = 0; i < 12; i++) {
    extra.push(await activeVenue(`ChIJoverlapVenue${String(i).padStart(4, '0')}`, `Overlap Bar ${i}`));
  }
  const lines = [];
  const savedLog = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  CALLED = [];
  LIVE_DELAY_MS = 150;
  PEAK_OPEN_CALLS = 0;
  try {
    await freshCollector().run();
  } finally {
    console.log = savedLog;
    LIVE_DELAY_MS = 0;
  }

  // The calls really did overlap, and never beyond the limit.
  assert.ok(PEAK_OPEN_CALLS > 1, 'no two calls were ever open at once, so nothing here tested overlap');
  assert.ok(PEAK_OPEN_CALLS <= collectRealtime.DEFAULT_MAX_IN_FLIGHT,
    `${PEAK_OPEN_CALLS} calls were open at once`);
  assert.strictEqual(new Set(CALLED).size, CALLED.length, 'a venue was called twice in one run');

  // Every new venue wrote exactly one row.
  for (const id of extra) {
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ml_training_data WHERE venue_id = $1 AND collection_mode = 'realtime'`,
      [id]
    );
    assert.strictEqual(r.n, 1, `venue ${id} has ${r.n} realtime rows`);
  }

  // The summary's count is the count the provenance audit read back.
  const done = lines.find((l) => /\] Done\. \d+ rows inserted/.test(l));
  const audit = lines.find((l) => /Provenance audit: \d+ rows written/.test(l));
  assert.ok(done && audit, 'the summary line or the audit line is missing');
  const inserted = Number(done.match(/Done\. (\d+) rows inserted/)[1]);
  const written = Number(audit.match(/Provenance audit: (\d+) rows written/)[1]);
  assert.strictEqual(inserted, written, 'the tally and the table disagree about what this run wrote');
  assert.ok(inserted >= extra.length, `${inserted} rows written for ${extra.length} new venues`);
  assert.ok(lines.some((l) => /Calls in flight at once: peak \d+ of \d+ allowed\./.test(l)));
});

test('a venue whose clock cannot be read fails the run only after the calls in flight are written', async () => {
  // A time zone Intl does not know makes getLocalTime throw RangeError. Six
  // venues ahead of it are still waiting on (stubbed, slow) BestTime when the
  // sweep reaches it. The run must still fail, as it always has, but only
  // after those six answers are written: before, the error left the sweep at
  // once, run() ended the pg pool, and the answers came back to a pool that
  // was gone.
  //
  // The order is pinned by demand: the six are served venues, so they lead
  // the city, and the broken one is the only venue nobody was shown.
  await pool.query('UPDATE ml_venues SET is_active = false');
  const { rows: [user] } = await pool.query(
    "INSERT INTO users (email, password, name) VALUES ('clock-test@example.invalid', 'x', 'Clock Test') RETURNING id"
  );
  const good = [];
  for (let i = 0; i < 6; i++) {
    const place = `ChIJclockGoodVenue${i}`;
    good.push(await activeVenue(place, `Clock Good ${i}`));
    for (let s = 0; s < 6 - i; s++) {
      await pool.query(
        'INSERT INTO served_predictions (user_id, venue_place_id, score) VALUES ($1, $2, 50)', [user.id, place]);
    }
  }
  const { rows: [broken] } = await pool.query(
    `INSERT INTO ml_venues (google_place_id, besttime_venue_id, name, city, latitude, longitude,
                            venue_category, timezone, is_active)
     VALUES ('ChIJclockBrokenZone', 'bt_ChIJclockBrokenZone', 'Broken Zone Bar', $1, 39.95, -75.16,
             'bar', 'Gotham/Nowhere', true)
     RETURNING id`,
    [CITY]
  );

  const errors = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
  console.error = (...args) => { errors.push(args.map(String).join(' ')); };
  CALLED = [];
  LIVE_DELAY_MS = 300;
  try {
    await assert.rejects(freshCollector().run(),
      (err) => err instanceof RangeError && /Gotham\/Nowhere/.test(err.message));
  } finally {
    Object.assign(console, saved);
    LIVE_DELAY_MS = 0;
    await pool.query('UPDATE ml_venues SET is_active = (id <> $1)', [broken.id]);
  }

  assert.deepStrictEqual(CALLED, good.map((_, i) => `bt_ChIJclockGoodVenue${i}`),
    'the six served venues were not the calls in flight, or the broken one was called');
  for (const id of good) {
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM ml_training_data WHERE venue_id = $1 AND collection_mode = 'realtime'`, [id]);
    assert.strictEqual(r.n, 1, `venue ${id}'s answer was lost when the run failed`);
  }
  assert.ok(!errors.some((e) => /after calling end on the pool/.test(e)),
    `a write reached an ended pool: ${errors.find((e) => /after calling end/.test(e))}`);
});

// ---------------------------------------------------------------------------
// 5. The post-sweep precompute the nowcast reads (migration 092)
//
// run() ends every completed sweep with scripts/ml/buildRecentDeviation.js,
// which now also stores each venue's newest live readings beside its offset
// for services/mlPredictor.js (CROWD_NOWCAST_ENABLED). Pinned here, against the
// real schema: which readings are stored and in what order, that a venue whose
// readings aged out is set back to NULL, and that a database without the
// column (the collector deployed before the main service booted 092) still
// gets its offsets. The venues below are inactive, so no sweep calls them.
// ---------------------------------------------------------------------------

const PRECOMPUTE_PLACE = 'ChIJprecomputeNowcast';
const STALE_PLACE = 'ChIJprecomputeStaleOne';

async function seedPrecompute() {
  const venue = async (place) => (await pool.query(
    `INSERT INTO ml_venues (google_place_id, besttime_venue_id, name, city, latitude, longitude,
                            venue_category, timezone, is_active)
     VALUES ($1, $2, $1, $3, 39.95, -75.16, 'bar', $4, false) RETURNING id`,
    [place, 'bt_' + place, CITY, TZ]
  )).rows[0].id;
  const fresh = await venue(PRECOMPUTE_PLACE);
  const stale = await venue(STALE_PLACE);
  const today = new Date();
  const date = today.toISOString().slice(0, 10);
  const dow = today.getUTCDay();
  // A positive curve everywhere except hour 9, which reads zero.
  for (const place of [PRECOMPUTE_PLACE, STALE_PLACE]) {
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        await pool.query(
          `INSERT INTO ml_venue_baselines (google_place_id, day_of_week, hour, baseline, source)
           VALUES ($1, $2, $3, $4, 'collected')`, [place, d, h, h === 9 ? 0 : 40]);
      }
    }
  }
  const reading = (id, hour, pct, label, hoursAgo, obsDate = date, obsDow = dow) => pool.query(
    `INSERT INTO ml_training_data (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category,
                                   busyness_pct, label_source, observed_date, collected_at)
     VALUES ($1, 'realtime', 'venue_local', $2, $3, 'bar', $4, $5, $6, NOW() - make_interval(hours => $7::int))`,
    [id, obsDow, hour, pct, label, obsDate, hoursAgo]);
  await reading(fresh, 9, 70, 'live', 5);       // its slot's curve is zero: not an offset reading, not stored
  await reading(fresh, 10, 20, 'live', 4);
  await reading(fresh, 11, 30, 'live', 3);
  await reading(fresh, 12, 40, 'live', 2);
  await reading(fresh, 13, 50, 'live', 1);
  await reading(fresh, 14, 99, 'forecast', 0);  // a vendor forecast, never a reading
  // Three days old: inside the offset's 28 days, outside the readings' window.
  const old = new Date(today.getTime() - 3 * 86400000);
  await reading(stale, 12, 60, 'live', 72, old.toISOString().slice(0, 10), old.getUTCDay());
  await reading(stale, 13, 65, 'live', 71, old.toISOString().slice(0, 10), old.getUTCDay());
  return { date, staleDate: old.toISOString().slice(0, 10) };
}

test('the precompute stores each venue\'s newest live readings, newest first, and NULL where none is recent', async () => {
  const { date, staleDate } = await seedPrecompute();
  const { buildRecentDeviation, READINGS_KEPT } = require('../scripts/ml/buildRecentDeviation');
  const quiet = console.error;
  console.error = () => {};
  let res;
  try { res = await buildRecentDeviation(); } finally { console.error = quiet; }
  assert.strictEqual(res.readings.error, null, 'the readings statement ran');
  assert.strictEqual(res.offsetReadings.error, null, 'and the offset readings statement');
  const row = async (place) => (await pool.query(
    `SELECT n_readings, recent_readings, offset_pct, offset_readings
       FROM ml_venue_recent_deviation WHERE google_place_id = $1`, [place])).rows[0];

  const fresh = await row(PRECOMPUTE_PLACE);
  assert.strictEqual(fresh.n_readings, 4, 'the offset counts the four live readings on a positive curve');
  assert.strictEqual(READINGS_KEPT, 3);
  assert.deepStrictEqual(fresh.recent_readings.map((r) => [r.h, r.v, r.d]), [[13, 50, date], [12, 40, date], [11, 30, date]],
    'the newest three live readings, newest first; not the forecast, not the zero-curve slot');
  for (const r of fresh.recent_readings) {
    assert.ok(Number.isInteger(r.dow) && typeof r.at === 'string', 'each carries its weekday and when it was taken');
  }

  // What serving reads back is what the nowcast picks from.
  const I = require('../services/mlPredictor')._internals;
  const parsed = I.parseRecentReadings(fresh.recent_readings);
  assert.strictEqual(I.pickNowcastReading(parsed, I.slotDayNumber(date) * 24 + 13).value, 40,
    'scoring 13:00, the 13:00 reading is skipped and 12:00 is used');

  const stale = await row(STALE_PLACE);
  assert.strictEqual(stale.n_readings, 2, 'three-day-old readings still make an offset');
  assert.strictEqual(stale.recent_readings, null, 'but nothing the nowcast could use');

  // The offset and the readings behind it (migration 093), each venue's own:
  // every live reading on a positive curve, newest slot first, each as its
  // distance from that slot's curve of 40. Two venues side by side are what
  // shows a reading filed under the wrong place, whichever key the statements
  // rank on.
  assert.strictEqual(fresh.offset_pct, -5, 'the median of -20, -10, 0 and 10');
  assert.deepStrictEqual(fresh.offset_readings.map((r) => [r.h, r.dev, r.d]),
    [[13, 10, date], [12, 0, date], [11, -10, date], [10, -20, date]]);
  assert.strictEqual(stale.offset_pct, 22.5, 'the median of 20 and 25');
  assert.deepStrictEqual(stale.offset_readings.map((r) => [r.h, r.dev, r.d]),
    [[13, 25, staleDate], [12, 20, staleDate]]);

  // Readings that age out are cleared on the next run, not left behind.
  await pool.query(`UPDATE ml_training_data SET collected_at = collected_at - interval '4 days'
                     WHERE venue_id = (SELECT id FROM ml_venues WHERE google_place_id = $1)`, [PRECOMPUTE_PLACE]);
  console.error = () => {};
  try { await buildRecentDeviation(); } finally { console.error = quiet; }
  assert.strictEqual((await row(PRECOMPUTE_PLACE)).recent_readings, null);
});

test('without the column (092 not yet booted), the offsets are still rebuilt', async () => {
  const { buildRecentDeviation } = require('../scripts/ml/buildRecentDeviation');
  await pool.query('ALTER TABLE ml_venue_recent_deviation RENAME COLUMN recent_readings TO recent_readings_hidden');
  await pool.query("UPDATE ml_venue_recent_deviation SET updated_at = NOW() - interval '1 day'");
  const quiet = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const res = await buildRecentDeviation();
    assert.ok(res.written > 0, 'the offset statement still wrote');
    assert.match(String(res.readings.error), /recent_readings/);
    assert.ok(errors.some((e) => /Recent readings not stored \(the offset was\)/.test(e)));
    const { rows: [r] } = await pool.query(
      "SELECT updated_at > NOW() - interval '1 minute' AS fresh FROM ml_venue_recent_deviation WHERE google_place_id = $1",
      [STALE_PLACE]);
    assert.strictEqual(r.fresh, true);
  } finally {
    console.error = quiet;
    await pool.query('ALTER TABLE ml_venue_recent_deviation RENAME COLUMN recent_readings_hidden TO recent_readings');
  }
});

test('each of the three aggregates gets the job\'s two minutes in its own transaction, and the pool keeps the API\'s cap', async () => {
  // From 2026-10-27 the API's 15-second cap on config/database.js's pool, which
  // this file runs on inside the hourly collector, cancelled the offset
  // statement in 22 of 52 runs. SET LOCAL lifts it for one statement only.
  const {
    buildRecentDeviation, describeStatementSeconds, JOB_STATEMENT_TIMEOUT_MS,
  } = require('../scripts/ml/buildRecentDeviation');
  const appPool = require('../config/database');
  assert.strictEqual(JOB_STATEMENT_TIMEOUT_MS, 120000);
  const capBefore = (await appPool.query('SHOW statement_timeout')).rows[0].statement_timeout;
  const sessions = [];
  const realConnect = appPool.connect;
  appPool.connect = function connect(cb) {
    // pool.query checks a client out through here with a callback: not a job statement.
    if (typeof cb === 'function') return realConnect.call(this, cb);
    return realConnect.call(this).then((client) => {
      const said = [];
      sessions.push(said);
      return new Proxy(client, {
        get(target, prop) {
          if (prop === 'query') {
            return (text, ...rest) => { said.push(String(text).trim().split('\n')[0].trim()); return target.query(text, ...rest); };
          }
          const v = target[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    });
  };
  let res;
  try { res = await buildRecentDeviation(); } finally { appPool.connect = realConnect; }
  assert.ok(res.written > 0 && res.readings.error === null && res.offsetReadings.error === null, 'all three statements ran');
  assert.ok(typeof res.seconds === 'number' && res.seconds >= 0, 'the run says how long it took');
  // The cap is on each statement, so each statement's own time is reported:
  // the three, inside the total, in the words the collector's hourly line prints.
  const { offset, recentReadings, offsetReadings } = res.statementSeconds;
  for (const s of [offset, recentReadings, offsetReadings]) assert.ok(typeof s === 'number' && s >= 0);
  assert.ok(offset + recentReadings + offsetReadings <= res.seconds + 1e-6, 'the total covers the three');
  assert.match(describeStatementSeconds(res.statementSeconds),
    /^offsets \d+\.\ds, recent readings \d+\.\ds, offset readings \d+\.\ds$/);
  assert.strictEqual(describeStatementSeconds({ offset: 24.94, recentReadings: 13.06, offsetReadings: 31.8 }),
    'offsets 24.9s, recent readings 13.1s, offset readings 31.8s');
  assert.strictEqual(sessions.length, 3, 'the offset, the recent readings and the offset readings, one transaction each');
  for (const said of sessions) {
    assert.deepStrictEqual([said[0], said[1], said[3]], ['BEGIN', 'SET LOCAL statement_timeout = 120000', 'COMMIT']);
    assert.match(said[2], /^(INSERT INTO ml_venue_recent_deviation|WITH ranked AS \()/);
  }
  const capAfter = (await appPool.query('SHOW statement_timeout')).rows[0].statement_timeout;
  assert.strictEqual(capAfter, capBefore, 'the connection went back with the cap it came with');
});

// ---------------------------------------------------------------------------
// 5. The fill's open share reads the same weekly rows (2026-10-30)
// ---------------------------------------------------------------------------
// loadBusyNow decides which fill cities a run reaches first, so its query is
// pinned against real rows: a venue counts only when its own weekly row at its
// city's local day and hour is above zero on the venue_local axis, and only
// when the venue is active and has a BestTime id. A fixed instant keeps the
// wall clock out of it: 12:30 UTC on Friday 30 October 2026 is Friday 19:30 in
// Bangkok and Friday 12:30 in London, day 5 by config.getLocalTime.

test('loadBusyNow returns each fill city\'s venues busy at its own local day and hour, and nothing else', async () => {
  const at = new Date('2026-10-30T12:30:00Z');
  const venue = async (place, city, { active = true, besttime = true } = {}) => {
    const { rows } = await pool.query(
      `INSERT INTO ml_venues (google_place_id, besttime_venue_id, name, city, latitude, longitude,
                              venue_category, timezone, is_active)
       VALUES ($1, $2, $1, $3, 0, 0, 'bar', $4, $5)
       RETURNING id`,
      [place, besttime ? 'bt_' + place : null, city, realConfig.CITIES[city].tz, active]
    );
    return rows[0].id;
  };
  const row = (venueId, day, hour, busyness, { mode = 'weekly', axis = 'venue_local' } = {}) => pool.query(
    `INSERT INTO ml_training_data
       (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, busyness_pct)
     VALUES ($1, $2, $3, $4, $5, 'bar', $6)`,
    [venueId, mode, axis, day, hour, busyness]
  );
  const ids = {
    busy: await venue('ChIJfillBusyBangkok1', 'bangkok'),
    zero: await venue('ChIJfillZeroBangkok1', 'bangkok'),
    thursday: await venue('ChIJfillThurBangkok1', 'bangkok'),
    hourEarlier: await venue('ChIJfillHr18Bangkok1', 'bangkok'),
    inactive: await venue('ChIJfillGoneBangkok1', 'bangkok', { active: false }),
    noBestTime: await venue('ChIJfillNoBtBangkok1', 'bangkok', { besttime: false }),
    liveOnly: await venue('ChIJfillLiveBangkok1', 'bangkok'),
    oldAxis: await venue('ChIJfillAxisBangkok1', 'bangkok'),
    london: await venue('ChIJfillBusyLondon01', 'london'),
    londonAt19: await venue('ChIJfillLon19London1', 'london'),
  };
  await row(ids.busy, 5, 19, 40);
  await row(ids.zero, 5, 19, 0);
  await row(ids.thursday, 4, 19, 40);
  await row(ids.hourEarlier, 5, 18, 40);
  await row(ids.inactive, 5, 19, 40);
  await row(ids.noBestTime, 5, 19, 40);
  await row(ids.liveOnly, 5, 19, 55, { mode: 'realtime', axis: null });
  await row(ids.oldAxis, 5, 19, 40, { axis: 'besttime_index' });
  await row(ids.london, 5, 12, 30);
  // Busy at Bangkok's hour, which is not London's.
  await row(ids.londonAt19, 5, 19, 30);

  const busy = await collectRealtime.loadBusyNow(['bangkok', 'london', 'seoul', 'atlantis'], { at, db: pool });
  // A name config.js does not know is left out; a known city with nothing busy is an empty set.
  assert.deepStrictEqual([...busy.keys()], ['bangkok', 'london', 'seoul']);
  assert.deepStrictEqual([...busy.get('bangkok')], [ids.busy]);
  assert.deepStrictEqual([...busy.get('london')], [ids.london]);
  assert.deepStrictEqual([...busy.get('seoul')], []);
  assert.deepStrictEqual([...(await collectRealtime.loadBusyNow([], { at, db: pool })).keys()], []);
});

test('loadOpenHourMasks also gives each judged venue its busy hours by weekday, when asked', async () => {
  const { loadOpenHourMasks, buildOpenHourMask } = collectRealtime;
  const { rows: [{ id: weekly }] } = await pool.query(
    `INSERT INTO ml_venues (google_place_id, besttime_venue_id, name, city, latitude, longitude,
                            venue_category, timezone, is_active)
     VALUES ('ChIJnarrowRulesWeek1', 'bt_ChIJnarrowRulesWeek1', 'Weekday Bar', $1, 39.95, -75.16, 'bar', $2, true)
     RETURNING id`, [CITY, TZ]);
  // A full Wednesday curve busy at 22:00, and one Friday hour at 01:00. Its
  // week-wide mask has both hours; its weekday masks keep them apart.
  for (let hour = 0; hour < 24; hour++) {
    await pool.query(
      `INSERT INTO ml_training_data (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, busyness_pct)
       VALUES ($1, 'weekly', 'venue_local', 3, $2, 'bar', $3)`, [weekly, hour, hour === 22 ? 40 : 0]);
  }
  await pool.query(
    `INSERT INTO ml_training_data (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, busyness_pct)
     VALUES ($1, 'weekly', 'venue_local', 5, 1, 'bar', 20)`, [weekly]);

  const weekDays = new Map();
  const masks = await loadOpenHourMasks([CITY], { weekDays, db: pool });
  assert.strictEqual(masks.get(weekly), buildOpenHourMask([22, 1]));
  assert.deepStrictEqual(weekDays.get(weekly), [0, 0, 0, 1 << 22, 0, 1 << 1, 0]);
  // Every judged venue gets both, and a venue with a partial curve neither.
  assert.deepStrictEqual([...weekDays.keys()].sort(), [...masks.keys()].sort());
  assert.ok(!masks.has(venueIds.partial) && !weekDays.has(venueIds.partial));
  assert.deepStrictEqual(weekDays.get(venueIds.closed), [0, 0, 0, 1 << ((nowHour + 12) % 24), 0, 0, 0]);
  // Not asked: the same masks, and the query has no slots to read.
  const plain = await loadOpenHourMasks([CITY], { db: pool });
  assert.deepStrictEqual([...plain.entries()].sort(), [...masks.entries()].sort());
});

// ALREADY RECORDED THIS HOUR: the lookup returns exactly the venues whose
// realtime row for that local day, hour and date exists, which are exactly
// the rows storeReading's ON CONFLICT would refuse a second time.
test('loadRecordedThisHour finds the venues holding this local hour\'s realtime row, and nothing else', async () => {
  const { loadRecordedThisHour } = collectRealtime;
  const venue = async (place) => (await pool.query(
    `INSERT INTO ml_venues (google_place_id, besttime_venue_id, name, city, latitude, longitude,
                            venue_category, timezone, is_active)
     VALUES ($1, $2, $1, $3, 39.95, -75.16, 'bar', $4, true) RETURNING id`,
    [place, 'bt_' + place, CITY, TZ])).rows[0].id;
  const row = (venueId, mode, day, hour, date) => pool.query(
    `INSERT INTO ml_training_data (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category,
                                   busyness_pct, observed_date, label_source)
     VALUES ($1, $2, 'venue_local', $3, $4, 'bar', 40, $5, $6)`,
    [venueId, mode, day, hour, date, mode === 'realtime' ? 'live' : null]);
  const ids = {
    now: await venue('ChIJrecordedNow00001'),
    otherHour: await venue('ChIJrecordedHour0001'),
    otherDate: await venue('ChIJrecordedDate0001'),
    weeklyOnly: await venue('ChIJrecordedWeekly01'),
    never: await venue('ChIJrecordedNever001'),
  };
  // Sunday 2026-11-01, 01:00 local: the repeated hour at the end of DST.
  const local = { dateStr: '2026-11-01', dayOfWeek: 0, hour: 1 };
  await row(ids.now, 'realtime', 0, 1, '2026-11-01');
  await row(ids.otherHour, 'realtime', 0, 2, '2026-11-01');
  await row(ids.otherDate, 'realtime', 0, 1, '2026-10-25');
  // The same day, hour and date, but a weekly row: only the mode keeps it out.
  await row(ids.weeklyOnly, 'weekly', 0, 1, '2026-11-01');

  const all = Object.values(ids);
  const recorded = await loadRecordedThisHour(all, local, { db: pool });
  assert.deepStrictEqual([...recorded], [ids.now]);
  // Only the venues asked about, and an empty list asks nothing.
  assert.deepStrictEqual([...(await loadRecordedThisHour([ids.never, ids.otherHour], local, { db: pool }))], []);
  assert.deepStrictEqual([...(await loadRecordedThisHour([], local, { db: pool }))], []);
});

// buildBaselines.collectedBaselinesDue decides whether the hourly run's tail
// rebuilds the baselines, and so when its fill stops, so it is pinned against
// real rows: due before any rebuild has left a mark, not due once one has,
// due for any week written after it however soon (a tolerance once hid
// those), not due again for production's 0.495 s late stamp once a rebuild
// has recorded it, due when the newest stamp moves backwards, and due at the
// daily hour whatever the stamps say. Explicit instants, an hour ahead of
// anything the tests above seeded, keep the order independent of how fast
// this runs.
test('collectedBaselinesDue: due exactly when the newest weekly stamp is not the last rebuild\'s mark', async () => {
  const {
    collectedBaselinesDue, refreshCollectedBaselines, DAILY_REBUILD_UTC_HOUR,
  } = require('../scripts/ml/buildBaselines');
  const offHour = new Date(Date.UTC(2026, 9, 30, (DAILY_REBUILD_UTC_HOUR + 6) % 24, 30, 0));
  const dailyHour = new Date(Date.UTC(2026, 9, 30, DAILY_REBUILD_UTC_HOUR, 30, 0));
  const base = Date.now() + 3600 * 1000;
  const at = (ms) => new Date(base + ms);
  // A week written the way the weekly writers write one: the rows, and the
  // venue's last_collected_at, in one transaction. `stampAt` defaults to the
  // rows' own instant, which is what one NOW() gives.
  const writeWeek = async (place, rowsAt, stampAt = rowsAt) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [{ id }] } = await client.query(
        `INSERT INTO ml_venues (google_place_id, besttime_venue_id, name, city, latitude, longitude,
                                venue_category, timezone, is_active)
         VALUES ($1, $2, $1, $3, 39.95, -75.16, 'bar', $4, true)
         RETURNING id`, [place, 'bt_' + place, CITY, TZ]);
      await client.query(
        `INSERT INTO ml_training_data
           (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, busyness_pct, collected_at)
         SELECT $1, 'weekly', 'venue_local', d, h, 'bar', 30, $2
           FROM generate_series(0, 6) d, generate_series(0, 23) h`, [id, rowsAt]);
      await client.query('UPDATE ml_venues SET last_collected_at = $2 WHERE id = $1', [id, stampAt]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };
  const due = async () => collectedBaselinesDue(pool, { at: offHour });
  const rebuild = async () => assert.strictEqual((await refreshCollectedBaselines(pool)).ok, true);

  // The loadBusyNow fixture above leaves a weekly row on the old axis, which
  // the rebuild refuses to average (REFUSAL_MESSAGE); it has served its test.
  await pool.query(`DELETE FROM ml_training_data
                     WHERE collection_mode = 'weekly' AND hour_axis IS DISTINCT FROM 'venue_local'`);
  // No rebuild has run against this database yet, so there is no mark.
  await pool.query('DROP TABLE IF EXISTS ml_baseline_marks');
  const none = await due();
  assert.deepStrictEqual(none, { due: true, reason: 'no rebuild has recorded a mark yet' });

  await writeWeek('ChIJbaselineDueWeek1', at(0));
  await rebuild();
  const caughtUp = await due();
  assert.strictEqual(caughtUp.due, false, caughtUp.reason);
  assert.match(caughtUp.reason, new RegExp(`^no weekly curve written since the last rebuild \\(.+, mark ${at(0).toISOString().replace(/\./g, '\\.')}\\)$`));
  // The daily hour rebuilds whatever the stamps say.
  assert.strictEqual((await collectedBaselinesDue(pool, { at: dailyHour })).due, true);

  // Production on 2026-10-31: rows at one instant, the stamp 0.495 s after
  // them (a stamp written after COMMIT). A rebuild records that stamp, so
  // afterwards it reads as caught up, as it should.
  await writeWeek('ChIJbaselineLateStamp', at(60 * 1000), at(60 * 1000 + 495));
  assert.strictEqual((await due()).due, true);
  await rebuild();
  assert.strictEqual((await due()).due, false);

  // A week written a moment after a rebuild is a new week: what the five
  // second tolerance read as nothing (mlClockAxisBackfill.test.js).
  await writeWeek('ChIJbaselineDueWeek2', at(60 * 1000 + 600));
  const soon = await due();
  assert.strictEqual(soon.due, true, soon.reason);
  assert.strictEqual(soon.reason, `a weekly curve was written at ${at(60 * 1000 + 600).toISOString()}, `
    + `after the last rebuild's mark (${at(60 * 1000 + 495).toISOString()})`);
  await rebuild();
  assert.strictEqual((await due()).due, false);
  const { rows: [{ n }] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ml_venue_baselines WHERE google_place_id = 'ChIJbaselineDueWeek2'`);
  assert.strictEqual(n, 168, 'the week written after the mark was not rebuilt');

  // Production's stamps come from NOW(), which keeps microseconds, and a mark
  // that passed through a JS Date (milliseconds) never equalled one: the
  // first night read "due" every hour (2026-10-31 00:07 EDT). A stamp with
  // microseconds, rebuilt, must read as caught up.
  await writeWeek('ChIJbaselineMicroStmp', at(120 * 1000));
  await pool.query(`UPDATE ml_venues SET last_collected_at = $1::timestamptz + interval '0.000123 seconds'
                     WHERE google_place_id = 'ChIJbaselineMicroStmp'`, [at(120 * 1000)]);
  assert.strictEqual((await due()).due, true);
  await rebuild();
  const micro = await due();
  assert.strictEqual(micro.due, false, micro.reason);

  // A repair that clears the newest venue's stamp moves the newest stamp
  // backwards: the baselines may have changed, so that is due too.
  await pool.query(`UPDATE ml_venues SET last_collected_at = NULL WHERE google_place_id = 'ChIJbaselineMicroStmp'`);
  const moved = await due();
  assert.strictEqual(moved.due, true, moved.reason);
  assert.match(moved.reason, /^the newest weekly stamp moved from .+ to .+ since the last rebuild$/);
  await rebuild();
  assert.strictEqual((await due()).due, false);
});
