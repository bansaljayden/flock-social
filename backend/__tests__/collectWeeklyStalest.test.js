'use strict';
// ---------------------------------------------------------------------------
// collectWeekly --order=stalest against a REAL Postgres, run piece after piece
// the way the refresh windows run it, with BestTime stubbed. Zero paid calls.
//
// The refresh runs as `--only-found --order=stalest --limit=N` between the
// hourly live runs, and each piece is meant to start where the last one
// stopped. A venue BestTime has no forecast for writes no weekly rows; the
// collector only stamps its besttime_attempted_at. The order used to read the
// weekly rows alone, so those venues kept their place at the head of the line
// and every piece asked them again: on 2026-10-06 the third lehigh window
// opened with the 40 venues the first window had already asked, and only 2 of
// them had a forecast the second time.
//
// Each piece here loads a fresh copy of the collector, the way each window is
// a fresh process, and the stub records which venues were asked, in order.
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

const PG_PORT = pickEmbeddedPgPort('collectWeeklyStalest');
const CONN = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_stalest_test`;

// scripts/ml/* call dotenv.config() on backend/.env, which points at the LIVE
// Railway database, and dotenv never overwrites an already-set variable. These
// lines before the requires keep this suite on its own instance.
process.env.DATABASE_URL = CONN;
process.env.PGSSLMODE = 'disable';
delete process.env.BESTTIME_API_KEY;

// What the collector did, in order: ['call', venue name] for each BestTime
// call and ['sleep', ms] for each pause.
const EVENTS = [];
// Venue names BestTime has no forecast for. Every other venue gets a week.
const NO_FORECAST = new Set();
// Venue names whose ask fails, each with what the stub throws for it.
const FAILS = new Map();
// The id a by-name lookup is answered with.
let byNameAnswer = null;

function stubModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}
const WEEK = [0, 1, 2, 3, 4, 5, 6].map((dayInt) => ({
  dayInt, dayText: 'x', hours: Array.from({ length: 24 }, (_, slot) => 20 + slot),
}));
stubModule('../scripts/ml/bestTimeService', {
  fetchWeeklyForecast: async (name, _address, venueId) => {
    EVENTS.push(['call', name]);
    if (FAILS.has(name)) throw await FAILS.get(name)();
    if (NO_FORECAST.has(name)) return null;
    return { venueId: venueId || byNameAnswer, days: WEEK, epochAnalysis: 1786000000 };
  },
});
// The one-second pacing is load-bearing in production and pure latency here,
// so sleep records the pause and returns at once.
const realConfig = require('../scripts/ml/config');
stubModule('../scripts/ml/config', {
  ...realConfig,
  sleep: async (ms) => { EVENTS.push(['sleep', ms]); },
});

const { migrate } = require('../db/migrate');

let pg;
let pool;
let dataDir;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), 'flock-stalest-pg-' + Date.now());
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'collectWeeklyStalest', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_stalest_test');
  pool = new Pool({ connectionString: CONN });
  await migrate(pool);
});

test.after(async () => {
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// One piece: a fresh copy of the collector (run() ends its pool) run with
// these flags. Returns the venue names it asked BestTime about, in order.
async function piece(args) {
  EVENTS.length = 0;
  delete require.cache[require.resolve('../scripts/ml/collectWeekly')];
  const { run } = require('../scripts/ml/collectWeekly');
  const savedArgv = process.argv;
  const savedExit = process.exitCode;
  process.argv = [savedArgv[0], savedArgv[1], ...args];
  try {
    await run();
  } finally {
    process.argv = savedArgv;
  }
  const exitCode = process.exitCode;
  process.exitCode = savedExit;
  assert.notStrictEqual(exitCode, 1, `the collector refused: ${args.join(' ')}`);
  return EVENTS.filter(([kind]) => kind === 'call').map(([, name]) => name);
}

// `askedAgo` is when this collector last asked BestTime about the venue
// (besttime_attempted_at); null for never.
async function addVenue(city, name, besttimeId, askedAgo = null) {
  const { rows } = await pool.query(
    `INSERT INTO ml_venues (google_place_id, besttime_venue_id, name, city, latitude, longitude,
                            venue_category, timezone, is_active, besttime_attempted_at)
     VALUES ($1, $2, $3, $4, 40.60, -75.47, 'restaurant', 'America/New_York', true, NOW() - $5::interval)
     RETURNING id`,
    [`ChIJstalest_${name.replace(/\W+/g, '_')}`, besttimeId, name, city, askedAgo]
  );
  return rows[0].id;
}

// A full week of weekly rows written `age` ago, stamped on the venue row the
// way both writers of weekly rows (this collector and the harvest) stamp it.
async function addWeek(venueId, age) {
  await pool.query(
    `INSERT INTO ml_training_data
       (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, busyness_pct, collected_at)
     SELECT $1, 'weekly', 'venue_local', d, h, 'restaurant', 40, NOW() - $2::interval
       FROM generate_series(0, 6) d, generate_series(0, 23) h`,
    [venueId, age]
  );
  await pool.query('UPDATE ml_venues SET last_collected_at = NOW() - $2::interval WHERE id = $1', [venueId, age]);
}

test('each piece moves past the venues the last one asked, misses included', async () => {
  const city = 'stalest_pieces';
  // Inserted in this order, so the ids run the same way. Four venues hold a
  // BestTime id with no forecast behind it, the kind that stalled 10-06.
  for (const n of [1, 2, 3, 4]) {
    NO_FORECAST.add(`No Forecast ${n}`);
    await addVenue(city, `No Forecast ${n}`, `ven_stalest_nf${n}`);
  }
  // The harvest refreshed this curve an hour ago. It stamps no attempt, so
  // only last_collected_at says the curve is fresh.
  const harvested = await addVenue(city, 'Harvested Last Hour', 'ven_stalest_harvested');
  await addWeek(harvested, '1 hour');
  // This collector refreshed this one a month ago, and the hourly live sweep
  // read it a minute ago, which says nothing about how old the curve is.
  const stale = await addVenue(city, 'Month Old Curve', 'ven_stalest_old', '30 days');
  await addWeek(stale, '30 days');
  await pool.query(
    `INSERT INTO ml_training_data
       (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, busyness_pct, collected_at)
     VALUES ($1, 'realtime', 'venue_local', 2, 19, 'restaurant', 55, NOW() - interval '1 minute')`,
    [stale]
  );

  const args = [`--city=${city}`, '--only-found', '--order=stalest', '--limit=2'];
  // Never asked and no curve: first.
  assert.deepStrictEqual(await piece(args), ['No Forecast 1', 'No Forecast 2']);
  // The old order asked 1 and 2 again here, and in every piece after.
  assert.deepStrictEqual(await piece(args), ['No Forecast 3', 'No Forecast 4']);
  // Then the month-old curve before the one the harvest wrote an hour ago,
  // although only the month-old one was ever asked by this collector.
  assert.deepStrictEqual(await piece(args), ['Month Old Curve', 'Harvested Last Hour']);
  // Everything has been asked once, so the line starts over with the venue
  // asked longest ago.
  assert.deepStrictEqual(await piece(args), ['No Forecast 1', 'No Forecast 2']);

  // The two that answered were refreshed in place, and the misses still
  // have no rows: only the attempt moved them.
  const { rows } = await pool.query(
    `SELECT v.name, COUNT(t.id)::int AS weekly
       FROM ml_venues v
       LEFT JOIN ml_training_data t ON t.venue_id = v.id AND t.collection_mode = 'weekly'
      WHERE v.city = $1
      GROUP BY v.name ORDER BY v.name`,
    [city]
  );
  assert.deepStrictEqual(rows, [
    { name: 'Harvested Last Hour', weekly: 168 },
    { name: 'Month Old Curve', weekly: 168 },
    { name: 'No Forecast 1', weekly: 0 },
    { name: 'No Forecast 2', weekly: 0 },
    { name: 'No Forecast 3', weekly: 0 },
    { name: 'No Forecast 4', weekly: 0 },
  ]);
});

// The BestTime calls that were not followed by the one-second pause before
// the next call, or before the end of the run.
function unpaced(events) {
  const out = [];
  events.forEach(([kind, name], k) => {
    if (kind !== 'call') return;
    const after = events.slice(k + 1);
    const nextCall = after.findIndex(([next]) => next === 'call');
    const between = nextCall === -1 ? after : after.slice(0, nextCall);
    if (!between.some(([next, ms]) => next === 'sleep' && ms >= 1000)) out.push(name);
  });
  return out;
}

test('a miss and a duplicate are paced like a refresh', async () => {
  // Both went straight on to the next venue, so a run of misses went out back
  // to back at network speed: one 2026-10-06 window made sixteen failed calls
  // in a row, most of them unpaced, and drew a 503 right after.
  const city = 'stalest_pacing';
  NO_FORECAST.add('Pacing Miss A');
  NO_FORECAST.add('Pacing Miss B');
  await addVenue(city, 'Pacing Miss A', 'ven_pacing_a');
  await addVenue(city, 'Pacing Miss B', 'ven_pacing_b');
  // No BestTime id, so a by-name lookup, answered with the id the next row
  // already holds.
  byNameAnswer = 'ven_pacing_holder';
  await addVenue(city, 'Pacing Twin', null);
  await addVenue(city, 'Pacing Holder', 'ven_pacing_holder');

  const asked = await piece([`--city=${city}`, '--max-new=1']);
  assert.deepStrictEqual(asked, ['Pacing Miss A', 'Pacing Miss B', 'Pacing Twin', 'Pacing Holder']);
  assert.deepStrictEqual(unpaced(EVENTS), []);
  // The twin went down the duplicate branch: left unmapped and marked.
  const { rows: [twin] } = await pool.query(
    `SELECT besttime_venue_id, besttime_status FROM ml_venues WHERE city = $1 AND name = 'Pacing Twin'`,
    [city]
  );
  assert.deepStrictEqual(twin, { besttime_venue_id: null, besttime_status: 'duplicate' });
});

// What bestTimeService throws for a 503, and for a call cut by its deadline.
const throttle = () => Object.assign(new Error('BestTime 503 (weekly)'), { transient: true });
const timeout = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

test('a venue asked by id moves back when its ask draws a 503 or fails', async () => {
  // Only an answer used to stamp the ask. A 503 or a failed call stamped
  // nothing, so under this order those venues kept their old place while
  // every venue around them moved back, and after one pass they opened every
  // piece. On 2026-10-06 the same seven lehigh venues drew a 503 every time
  // they were asked, each one followed by a 60 s wait.
  const city = 'stalest_failures';
  FAILS.set('Always 503', throttle);
  FAILS.set('Always Times Out', timeout);
  await addVenue(city, 'Always 503', 'ven_fail_503');
  await addVenue(city, 'Always Times Out', 'ven_fail_timeout');
  const older = await addVenue(city, 'Curve 20 Days', 'ven_fail_20d', '20 days');
  await addWeek(older, '20 days');
  const newer = await addVenue(city, 'Curve 10 Days', 'ven_fail_10d', '10 days');
  await addWeek(newer, '10 days');

  const args = [`--city=${city}`, '--only-found', '--order=stalest', '--limit=2'];
  assert.deepStrictEqual(await piece(args), ['Always 503', 'Always Times Out']);
  // The old code asked these two again here, and in every piece after.
  assert.deepStrictEqual(await piece(args), ['Curve 20 Days', 'Curve 10 Days']);
  assert.deepStrictEqual(await piece(args), ['Always 503', 'Always Times Out']);

  // Stamped as asked and nothing else. Neither failure says anything about
  // the venue, so neither is marked 404, and neither has a curve.
  const { rows } = await pool.query(
    `SELECT name, besttime_status, besttime_attempted_at IS NOT NULL AS asked, last_collected_at
       FROM ml_venues WHERE city = $1 AND name LIKE 'Always %' ORDER BY name`,
    [city]
  );
  assert.deepStrictEqual(rows, [
    { name: 'Always 503', besttime_status: null, asked: true, last_collected_at: null },
    { name: 'Always Times Out', besttime_status: null, asked: true, last_collected_at: null },
  ]);
});

test('a 503 on a by-name ask, or on a row unmapped while it was asked, stamps nothing', async () => {
  // A by-name venue keeps its NULL stamp, so --skip-attempted still offers
  // its admission. A row the venue repair unmaps mid-run keeps the stamp the
  // repair preserved, the same way the found stamp is held to the id the
  // forecast was bought with.
  const city = 'stalest_unstamped';
  FAILS.set('By Name 503', throttle);
  FAILS.set('Unmapped While Asked', async () => {
    // What repairBestTimeDiscoveredVenues.js writes on a rival row.
    await pool.query(
      `UPDATE ml_venues
          SET besttime_venue_id = NULL, besttime_status = 'duplicate',
              besttime_attempted_at = COALESCE(besttime_attempted_at, NOW())
        WHERE name = 'Unmapped While Asked'`
    );
    return throttle();
  });
  await addVenue(city, 'By Name 503', null);
  await addVenue(city, 'Unmapped While Asked', 'ven_unmapped_mid_ask', '40 days');

  assert.deepStrictEqual(
    await piece([`--city=${city}`, '--max-new=1']),
    ['By Name 503', 'Unmapped While Asked']
  );
  const { rows } = await pool.query(
    `SELECT name, besttime_attempted_at IS NULL AS never_asked,
            besttime_attempted_at < NOW() - interval '39 days' AS old_stamp_kept
       FROM ml_venues WHERE city = $1 ORDER BY name`,
    [city]
  );
  assert.deepStrictEqual(rows, [
    { name: 'By Name 503', never_asked: true, old_stamp_kept: null },
    { name: 'Unmapped While Asked', never_asked: false, old_stamp_kept: true },
  ]);
});

test('the throttle budget counts 503s in a row, not 503s in a run', async () => {
  // The count was never reset, so a run stopped at its fortieth 503 however
  // many answers came between them, and said "40 consecutive throttles". The
  // 10-06 passes drew their 503s from the same venues every time, seven in
  // lehigh and twelve in philly, each one between answers.
  const between = 'throttle_between';
  for (let n = 10; n <= 50; n++) {
    FAILS.set(`Between 503 ${n}`, throttle);
    NO_FORECAST.add(`Between Answer ${n}`);
    await addVenue(between, `Between 503 ${n}`, `ven_between_503_${n}`);
    await addVenue(between, `Between Answer ${n}`, `ven_between_answer_${n}`);
  }
  // 41 throttles, each followed by an answer: the run reaches the end.
  const asked = await piece([`--city=${between}`, '--only-found']);
  assert.strictEqual(asked.length, 82, `the run stopped after ${asked.at(-1)}`);

  // Forty in a row still stop it.
  const wall = 'throttle_wall';
  for (let n = 10; n <= 50; n++) {
    FAILS.set(`Wall 503 ${n}`, throttle);
    await addVenue(wall, `Wall 503 ${n}`, `ven_wall_503_${n}`);
  }
  await addVenue(wall, 'After The Wall', 'ven_after_the_wall');
  const walled = await piece([`--city=${wall}`, '--only-found']);
  assert.strictEqual(walled.length, 40);
  assert.strictEqual(walled.at(-1), 'Wall 503 49');
});
