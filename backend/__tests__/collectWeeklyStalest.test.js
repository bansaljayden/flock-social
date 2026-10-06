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
    if (NO_FORECAST.has(name)) return null;
    return { venueId, days: WEEK, epochAnalysis: 1786000000 };
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
