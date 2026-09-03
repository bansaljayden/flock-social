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
    return { forecastedBusyness: 35, liveBusyness: 62, liveAvailable: true, hour: null, venueOpen: true };
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
