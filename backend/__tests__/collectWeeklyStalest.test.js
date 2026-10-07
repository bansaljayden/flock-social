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
const { spawn } = require('node:child_process');

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
// lines before the requires keep this suite on its own instance, and keep the
// real BestTime key out of it: the collector refuses to start without a key,
// and this one is never sent, because BestTime is stubbed below.
process.env.DATABASE_URL = CONN;
process.env.PGSSLMODE = 'disable';
process.env.BESTTIME_API_KEY = 'not-a-real-key';

// What the collector did, in order: ['call', venue name] for each BestTime
// call and ['sleep', ms] for each pause.
const EVENTS = [];
// Venue names BestTime has no forecast for. Every other venue gets a week.
const NO_FORECAST = new Set();
// Venue names whose ask fails, each with what the stub throws for it.
const FAILS = new Map();
// The id a by-name lookup is answered with.
let byNameAnswer = null;
// Venue names, each with something to run once, right after the corpus-locked
// transaction that follows BestTime's week for it commits. Asked by id, a
// venue takes the lock for its weekly insert alone, so that is the commit.
const AFTER_COMMIT = new Map();
let afterNextCommit = null;

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
    afterNextCommit = AFTER_COMMIT.get(name) || null;
    return { venueId: venueId || byNameAnswer, days: WEEK, epochAnalysis: 1786000000 };
  },
});
// The one-second pacing is load-bearing in production and pure latency here,
// so sleep records the pause and returns at once. The lock is the real one,
// with a place to stand between its COMMIT and whatever the collector does
// next.
const realConfig = require('../scripts/ml/config');
stubModule('../scripts/ml/config', {
  ...realConfig,
  sleep: async (ms) => { EVENTS.push(['sleep', ms]); },
  withCorpusWriteLock: async (lockPool, fn) => {
    const out = await realConfig.withCorpusWriteLock(lockPool, fn);
    const then = afterNextCommit;
    afterNextCommit = null;
    if (then) await then();
    return out;
  },
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
// way every writer of weekly rows (this collector, the harvest and
// discoverBestTime.js) stamps it.
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

// discoverBestTime.js run for real, BestTime's venue search answered by a
// stub in place of fetch: the first query of the city returns `venues`, every
// other query none. Anything else it asks for throws, so nothing leaves.
async function runDiscovery(cityKey, venues) {
  const savedFetch = globalThis.fetch;
  const savedArgv = process.argv;
  let answered = false;
  globalThis.fetch = async (url) => {
    const { pathname } = new URL(String(url));
    if (pathname === '/api/v1/venues/search') {
      return new Response(JSON.stringify({ status: 'OK', job_id: 'job_stalest', collection_id: 'col_stalest' }));
    }
    if (pathname === '/api/v1/venues/progress') {
      const answer = answered ? [] : venues;
      answered = true;
      return new Response(JSON.stringify({ job_finished: true, venues: answer }));
    }
    throw new Error(`discoverBestTime asked for ${pathname}, which this stub does not answer`);
  };
  process.argv = [savedArgv[0], savedArgv[1], `--cities=${cityKey}`];
  try {
    delete require.cache[require.resolve('../scripts/ml/discoverBestTime')];
    await require('../scripts/ml/discoverBestTime').discover();
  } finally {
    globalThis.fetch = savedFetch;
    process.argv = savedArgv;
  }
}

// One venue as BestTime's venue search returns it, forecast included.
function searchHit(venueId, name) {
  return {
    venue_id: venueId,
    venue_name: name,
    venue_address: '1 Test Street, Philadelphia',
    venue_lat: 39.95,
    venue_lon: -75.16,
    venue_type: 'BAR',
    venue_types: ['bar'],
    venue_foot_traffic_forecast: [0, 1, 2, 3, 4, 5, 6].map((dayInt) => ({
      day_int: dayInt, day_raw: Array.from({ length: 24 }, (_, slot) => 20 + slot),
    })),
  };
}

test('a venue discoverBestTime found today is not refreshed ahead of a month-old curve', async () => {
  // discoverBestTime.js writes a full week for every venue its search
  // returns, and it stamped neither column this order reads, so the venue it
  // found today was first in line at the next refresh.
  const stale = await addVenue('philly', 'Philly Month Old Curve', 'ven_stalest_philly_old', '30 days');
  await addWeek(stale, '30 days');
  await runDiscovery('philly', [searchHit('ven_stalest_discovered', 'Discovered Today')]);

  assert.deepStrictEqual(
    await piece(['--city=philly', '--only-found', '--order=stalest', '--limit=1']),
    ['Philly Month Old Curve']
  );
  // The stamp says when the rows landed: no earlier than the newest of them.
  const { rows } = await pool.query(
    `SELECT COUNT(t.id)::int AS weekly, v.last_collected_at >= MAX(t.collected_at) AS stamped
       FROM ml_venues v
       JOIN ml_training_data t ON t.venue_id = v.id AND t.collection_mode = 'weekly'
      WHERE v.besttime_venue_id = 'ven_stalest_discovered'
      GROUP BY v.id`
  );
  assert.deepStrictEqual(rows, [{ weekly: 168, stamped: true }]);
});

const MIGRATION_125 = '125_ml_venues_stalest_stamps.sql';

test('migration 125 stamps a venue holding weekly rows and no stamp from its newest row, once', async () => {
  const city = 'stalest_backfill';
  // What discoverBestTime.js left before it stamped: a fresh week, written
  // over a few minutes, and no stamp at all.
  const fresh = await addVenue(city, 'Discovered Before The Fix', 'ven_backfill_fresh');
  await pool.query(
    `INSERT INTO ml_training_data
       (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, busyness_pct, collected_at)
     SELECT $1, 'weekly', 'venue_local', d, h, 'restaurant', 40,
            NOW() - interval '2 hours' - d * interval '1 minute'
       FROM generate_series(0, 6) d, generate_series(0, 23) h`,
    [fresh]
  );
  const stale = await addVenue(city, 'Backfill Month Old Curve', 'ven_backfill_old', '30 days');
  await addWeek(stale, '30 days');
  // Two the backfill must leave alone, out of the pieces' city: a venue with
  // only a live reading has no curve, and a stamp already set is kept even
  // when a newer weekly row exists (the file fills NULLs and nothing else).
  const liveOnly = await addVenue('stalest_backfill_other', 'Live Reading Only', 'ven_backfill_live');
  await pool.query(
    `INSERT INTO ml_training_data
       (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, busyness_pct, collected_at)
     VALUES ($1, 'realtime', 'venue_local', 2, 19, 'restaurant', 55, NOW() - interval '1 hour')`,
    [liveOnly]
  );
  const kept = await addVenue('stalest_backfill_other', 'Stamp Already Set', 'ven_backfill_kept');
  await addWeek(kept, '1 hour');
  await pool.query(`UPDATE ml_venues SET last_collected_at = NOW() - interval '10 days' WHERE id = $1`, [kept]);
  const stampOf = async (id) => (await pool.query('SELECT last_collected_at FROM ml_venues WHERE id = $1', [id])).rows[0].last_collected_at;
  const keptBefore = await stampOf(kept);

  // 125 again, now that there is something for it to do.
  await pool.query('DELETE FROM schema_migrations WHERE name = $1', [MIGRATION_125]);
  await migrate(pool);

  assert.deepStrictEqual(
    await piece([`--city=${city}`, '--only-found', '--order=stalest', '--limit=1']),
    ['Backfill Month Old Curve']
  );
  const { rows: [exact] } = await pool.query(
    `SELECT v.last_collected_at = MAX(t.collected_at) AS exact
       FROM ml_venues v
       JOIN ml_training_data t ON t.venue_id = v.id AND t.collection_mode = 'weekly'
      WHERE v.id = $1
      GROUP BY v.id`,
    [fresh]
  );
  assert.deepStrictEqual(exact, { exact: true }, 'the stamp is not the newest weekly row');
  assert.strictEqual(await stampOf(liveOnly), null, 'a venue with no weekly row was stamped');
  assert.deepStrictEqual(await stampOf(kept), keptBefore, 'a stamp that was already set moved');

  // A replay writes nothing: not a value, not a row version.
  const snapshot = async () => (await pool.query(
    'SELECT id, last_collected_at, xmin::text AS version FROM ml_venues ORDER BY id'
  )).rows;
  const before = await snapshot();
  await pool.query('DELETE FROM schema_migrations WHERE name = $1', [MIGRATION_125]);
  await migrate(pool);
  assert.deepStrictEqual(await snapshot(), before, 'a replay of 125 rewrote a venue row');
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

// What bestTimeService throws for a 429.
const rateLimited = () => Object.assign(new Error('BestTime 429 (weekly)'), { transient: true });

test('a by-name ask that gets no answer is stamped apart from the attempt; a row unmapped mid-ask keeps its stamp', async () => {
  // A by-name venue that got no answer has not had its admission, so its
  // besttime_attempted_at stays NULL and --skip-attempted still offers it.
  // It gets besttime_name_unanswered_at instead, which only --order=stalest
  // reads. A timeout is handled the same way (stampFailedAsk says why). A row
  // the venue repair unmaps mid-run keeps the stamp the repair preserved, the
  // same way the found stamp is held to the id the forecast was bought with.
  const city = 'stalest_unstamped';
  FAILS.set('By Name 503', throttle);
  FAILS.set('By Name 429', rateLimited);
  FAILS.set('By Name Times Out', timeout);
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
  await addVenue(city, 'By Name 429', null);
  await addVenue(city, 'By Name Times Out', null);
  await addVenue(city, 'Unmapped While Asked', 'ven_unmapped_mid_ask', '40 days');

  assert.deepStrictEqual(
    await piece([`--city=${city}`, '--max-new=3']),
    ['By Name 503', 'By Name 429', 'By Name Times Out', 'Unmapped While Asked']
  );
  const { rows } = await pool.query(
    `SELECT name, besttime_status, besttime_attempted_at IS NULL AS never_asked,
            besttime_attempted_at < NOW() - interval '39 days' AS old_stamp_kept,
            besttime_name_unanswered_at IS NOT NULL AS unanswered
       FROM ml_venues WHERE city = $1 ORDER BY name`,
    [city]
  );
  assert.deepStrictEqual(rows, [
    { name: 'By Name 429', besttime_status: null, never_asked: true, old_stamp_kept: null, unanswered: true },
    { name: 'By Name 503', besttime_status: null, never_asked: true, old_stamp_kept: null, unanswered: true },
    { name: 'By Name Times Out', besttime_status: null, never_asked: true, old_stamp_kept: null, unanswered: true },
    { name: 'Unmapped While Asked', besttime_status: 'duplicate', never_asked: false, old_stamp_kept: true, unanswered: false },
  ]);
});

test('a by-name venue that never gets an answer stops starving the rest of a limited run', async () => {
  // Under --order=stalest --limit=N --max-new=M, a by-name venue whose
  // lookup drew a 503 every time was first in every run, because nothing was
  // stamped on it, and with --limit=1 the venue behind it was never asked.
  // A 429 or a timeout did the same.
  const city = 'stalest_by_name';
  FAILS.set('By Name Always 503', throttle);
  await addVenue(city, 'By Name Always 503', null);
  await addVenue(city, 'By Name Never Asked', null);
  byNameAnswer = 'ven_by_name_never_asked';

  const args = [`--city=${city}`, '--order=stalest', '--limit=1', '--max-new=1'];
  assert.deepStrictEqual(await piece(args), ['By Name Always 503']);
  // The old code asked it again here, and in every run after.
  assert.deepStrictEqual(await piece(args), ['By Name Never Asked']);

  // No answer, so no admission: an admission run still offers it, and it is
  // the one venue in the city BestTime never answered about.
  assert.deepStrictEqual(
    await piece([`--city=${city}`, '--skip-attempted', '--order=stalest', '--max-new=1']),
    ['By Name Always 503']
  );
  const { rows } = await pool.query(
    `SELECT name, besttime_venue_id, besttime_status, besttime_attempted_at IS NULL AS never_answered
       FROM ml_venues WHERE city = $1 ORDER BY name`,
    [city]
  );
  assert.deepStrictEqual(rows, [
    { name: 'By Name Always 503', besttime_venue_id: null, besttime_status: null, never_answered: true },
    { name: 'By Name Never Asked', besttime_venue_id: 'ven_by_name_never_asked', besttime_status: 'found', never_answered: false },
  ]);
});

// Serves of a venue's place in the last day, by one user, for --order=served.
async function serve(venueId, times) {
  const { rows: [user] } = await pool.query(
    `INSERT INTO users (email, password, name) VALUES ($1, 'x', 'Order Test') RETURNING id`,
    [`order.serves.${venueId}@example.com`]
  );
  await pool.query(
    `INSERT INTO served_predictions (user_id, venue_place_id, score, served_at)
     SELECT $1, v.google_place_id, 50, NOW() - interval '1 day'
       FROM ml_venues v, generate_series(1, $3) n
      WHERE v.id = $2`,
    [user.id, venueId, times]
  );
}

test('--order=reviews and --order=served move a by-name venue back once its ask goes unanswered', async () => {
  // Neither order changes between runs. A by-name venue whose lookup drew a
  // 503 every time was the most reviewed (or most served) venue in line in
  // every run, so it was asked first every time, and under --limit=1 the
  // venue behind it never was. The stamp the failure leaves now moves it back.
  for (const order of ['reviews', 'served']) {
    const city = `order_${order}`;
    const failing = `${order} Always 503`;
    const waiting = `${order} Never Asked`;
    FAILS.set(failing, throttle);
    const a = await addVenue(city, failing, null);
    const b = await addVenue(city, waiting, null);
    if (order === 'reviews') {
      await pool.query('UPDATE ml_venues SET review_count = 500 WHERE id = $1', [a]);
      await pool.query('UPDATE ml_venues SET review_count = 20 WHERE id = $1', [b]);
    } else {
      // Ahead on serves alone: by reviews alone the other venue would lead.
      await pool.query('UPDATE ml_venues SET review_count = 20 WHERE id = $1', [a]);
      await pool.query('UPDATE ml_venues SET review_count = 500 WHERE id = $1', [b]);
      await serve(a, 3);
      await serve(b, 1);
    }
    byNameAnswer = `ven_order_${order}_waiting`;

    const args = [`--city=${city}`, '--skip-attempted', `--order=${order}`, '--limit=1', '--max-new=1'];
    // Nothing has gone unanswered yet, so the order's own first venue.
    assert.deepStrictEqual(await piece(args), [failing], `--order=${order}, first run`);
    // The old order asked it again here, and in every run after.
    assert.deepStrictEqual(await piece(args), [waiting], `--order=${order}, second run`);
    // The other venue was answered and leaves the line; the unanswered one is
    // still in it, moved back and not dropped.
    assert.deepStrictEqual(await piece(args), [failing], `--order=${order}, third run`);
  }
});

test('an unanswered ask that BestTime has answered since does not move a venue back', async () => {
  // A 404 retry selects venues that were answered before. A venue that drew a
  // 503 and was answered after it is not one that keeps failing, so it keeps
  // its place; one whose newest ask went unanswered does not.
  for (const [label, unansweredAgo, first] of [
    ['Answered Since', '50 days', 'most'],
    ['Unanswered Last', '35 days', 'less'],
  ]) {
    const names = { most: `${label} Most Reviewed`, less: `${label} Less Reviewed` };
    const city = `order_${label.replace(' ', '_').toLowerCase()}`;
    const most = await addVenue(city, names.most, null, '40 days');
    const less = await addVenue(city, names.less, null, '40 days');
    await pool.query(
      `UPDATE ml_venues SET review_count = 500, besttime_status = '404',
              besttime_name_unanswered_at = NOW() - $2::interval
        WHERE id = $1`,
      [most, unansweredAgo]
    );
    await pool.query(`UPDATE ml_venues SET review_count = 20, besttime_status = '404' WHERE id = $1`, [less]);
    NO_FORECAST.add(names.most);
    NO_FORECAST.add(names.less);
    assert.deepStrictEqual(
      await piece([`--city=${city}`, '--skip-collected', '--retry-404', '--order=reviews', '--limit=1', '--max-new=1']),
      [names[first]],
      `unanswered ${unansweredAgo} ago, answered 40 days ago`
    );
  }
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

// The venue repair run the way an operator runs it: its own process,
// --commit, pointed at this suite's database through the variables pinned at
// the top of the file. Resolves with its exit code and output.
const REPAIR_SCRIPT = path.join(__dirname, '..', 'scripts', 'ml', 'repairBestTimeDiscoveredVenues.js');
function runRepair() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [REPAIR_SCRIPT, '--commit'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, DATABASE_URL: CONN, PGSSLMODE: 'disable' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 120000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ status: null, stdout, stderr: `${stderr}${err}` }); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

const VENUE_ID_INDEX = 'ml_venues_besttime_venue_id_uniq';

test('a venue the repair unmaps right after its week commits ends with no stamp', async () => {
  // Two Google places BestTime resolves to one venue id. The repair keeps the
  // richer listing's mapping and takes from the other the weekly rows bought
  // with the shared id, the mapping and the stamp that said those rows landed.
  // The collector wrote that stamp in its own UPDATE after the insert had
  // committed, so a repair that ran between the two was undone: the rival
  // ended with a fresh stamp, no id and no weekly rows.
  const city = 'stamp_race';
  // 060 built the unique index on this empty database; production held such
  // pairs because it could not, and the repair builds it again at the end.
  await pool.query(`DROP INDEX IF EXISTS ${VENUE_ID_INDEX}`);
  try {
    // The keeper sits outside the run's city, so only the rival and the
    // control are asked. A week each and more reviews: the repair keeps it.
    const keeper = await addVenue('stamp_race_keeper', 'Race Keeper', 'ven_stamp_race');
    await addWeek(keeper, '2 days');
    const rival = await addVenue(city, 'Race Rival', 'ven_stamp_race');
    // Asked after the rival (ids in order): the run goes on past the race,
    // and a venue nothing unmapped is stamped in the commit that holds its rows.
    const control = await addVenue(city, 'Race Control', 'ven_stamp_race_control');
    await pool.query('UPDATE ml_venues SET review_count = 900 WHERE id = $1', [keeper]);
    await pool.query('UPDATE ml_venues SET review_count = 16 WHERE id = $1', [rival]);

    let repair = null;
    AFTER_COMMIT.set('Race Rival', async () => { repair = await runRepair(); });
    assert.deepStrictEqual(await piece([`--city=${city}`, '--only-found']), ['Race Rival', 'Race Control']);
    assert.ok(repair, "the repair never ran after the rival's week committed");
    assert.strictEqual(repair.status, 0, `the repair exited ${repair.status}\n${repair.stdout}\n${repair.stderr}`);
    assert.match(repair.stdout, /1 real rows unmapped \(168 weekly rows/, 'the repair did not strip the rival of its week');

    const { rows } = await pool.query(
      `SELECT v.name, v.besttime_venue_id, v.besttime_status, v.last_collected_at,
              COUNT(t.id)::int AS weekly, MAX(t.collected_at) AS newest
         FROM ml_venues v
         LEFT JOIN ml_training_data t ON t.venue_id = v.id AND t.collection_mode = 'weekly'
        WHERE v.id = ANY($1)
        GROUP BY v.id
        ORDER BY v.name`,
      [[keeper, rival, control]]
    );
    const at = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.deepStrictEqual(
      {
        id: at['Race Rival'].besttime_venue_id,
        status: at['Race Rival'].besttime_status,
        weekly: at['Race Rival'].weekly,
        stamp: at['Race Rival'].last_collected_at,
      },
      { id: null, status: 'duplicate', weekly: 0, stamp: null },
      'the rival was left with a stamp for a week it no longer has'
    );
    assert.strictEqual(at['Race Keeper'].besttime_venue_id, 'ven_stamp_race');
    assert.strictEqual(at['Race Keeper'].weekly, 168);
    assert.strictEqual(at['Race Control'].weekly, 168);
    assert.deepStrictEqual(at['Race Control'].last_collected_at, at['Race Control'].newest,
      "the control's stamp was not made in the transaction that wrote its rows");
  } finally {
    AFTER_COMMIT.clear();
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${VENUE_ID_INDEX} ON ml_venues (besttime_venue_id) WHERE besttime_venue_id IS NOT NULL`
    ).catch(() => {});
  }
});
