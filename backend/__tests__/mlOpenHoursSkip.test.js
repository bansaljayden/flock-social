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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');

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
  await pg?.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
  await freshCollector().run();

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
  CALLED = [];
  process.argv.push('--no-open-hours');
  try {
    await freshCollector().run();
  } finally {
    process.argv.splice(process.argv.indexOf('--no-open-hours'), 1);
  }
  assert.strictEqual(CALLED.length, 4,
    'with the filter off every venue in scope is called, including the shut one');
  assert.ok(CALLED.includes('bt_' + CLOSED_PLACE));
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
