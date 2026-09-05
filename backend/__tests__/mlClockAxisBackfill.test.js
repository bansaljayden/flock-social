'use strict';
// ---------------------------------------------------------------------------
// Migration 023 — the ML corpus's weekly rows move onto the venue wall clock,
// against a REAL Postgres.
//
// The migration is arithmetic plus a day rollover plus a predicate that must
// separate two collectors writing different clocks into one column. None of
// that can be checked against a scripted pg fake: the rollover is a SQL CASE
// reading pre-update values, the "did not touch it" claim is an xmin claim, and
// the whole file depends on a DO block being allowed to COMMIT (which requires
// db/migrate.js's @noTransaction mode and the simple query protocol). So this
// file boots the repo's embedded-postgres dev dependency, applies the real
// migration chain with db/migrate.js, and then runs 023 the way the runner
// does — statement by statement, on one session.
//
// What is pinned, and why each row exists:
//   * a full 24-slot Saturday — slots 18..23 must roll into SUNDAY, which is
//     also the week boundary (6 -> 0), the case a naive "+1 day" gets wrong.
//   * slot 17 and slot 18 of a midweek day — the two rows either side of the
//     rollover edge.
//   * a realtime row sitting at the SAME venue/day/hour a corrected weekly row
//     lands on. Its hour was always a true wall clock hour; correcting it would
//     corrupt it. Untouched is proven by xmin, not by values.
//   * a weekly row already stamped 'venue_local' (written by the fixed
//     collector) — a fixed point, also proven by xmin.
//   * a weekly row explicitly stamped 'besttime_index' — the disease stated out
//     loud, must be corrected like a NULL one.
//   * a venue with an unusable timezone — this transform never consults one, so
//     it must be corrected exactly like any other venue and must not raise.
//   * the whole file run twice — the second run must write NOTHING anywhere
//     (identical xmin), pinning "idempotent by construction".
//   * ml_venue_baselines, which is derived-and-stored: rebuilt onto the new
//     axis, stale slots dropped, source='google' rows untouched, and
//     buildBaselines.js re-run afterwards must change nothing.
//
// The expected (day, hour) pairs are derived by calling the collector's own
// exported bestTimeSlotToLocal(), not hand-copied — if collectWeekly.js and the
// SQL ever disagree about the shift, that is the failure this file reports.
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

const MIGRATION_FILE = '023_backfill_ml_weekly_local_hours.sql';
const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', MIGRATION_FILE);

// This suite boots its own embedded Postgres, so its port must be distinct from
// e2e-local.js's 59595 and from every sibling suite that does the same. It used
// to be the hardcoded 59643, which held right up until a run was killed: the
// orphaned postgres kept the port and broke every LATER run of this file
// permanently, reported only as `hookFailed: undefined`.
//
// pickEmbeddedPgPort keeps the distinctness, by giving each suite a disjoint
// range of its own, and adds orphan-immunity on top of it. The candidate port
// starts from a process.pid-derived offset, so a fresh run never starts where an
// orphan of some dead process sits, and it is then confirmed free by an actual
// bind. See __tests__/helpers/embeddedPgPort.js.
// It resolves SYNCHRONOUSLY, which is not a nicety: CONN below is assigned to
// process.env.DATABASE_URL at module scope, before the requires, for the reason
// the next comment gives. An awaited port would arrive far too late.
const PG_PORT = pickEmbeddedPgPort('mlClockAxisBackfill');
const CONN = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_axis_test`;

// scripts/ml/* call dotenv.config() on backend/.env, which points at the LIVE
// Railway database. dotenv never overwrites a variable that is already set, so
// pinning these two before the requires below guarantees the collector modules
// can only ever see this embedded instance — and PGSSLMODE in particular,
// because pg reads it even when a connection string is passed.
process.env.DATABASE_URL = CONN;
process.env.PGSSLMODE = 'disable';

// Both collectors destructure their dependencies at require time, so the stubs
// have to be in the module cache BEFORE the requires below. Nothing here
// reaches BestTime: the whole point of this change is that the correction is
// arithmetic on rows already paid for.
function stubModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}
// Busyness depends ONLY on the venue-local hour: slot s of any BestTime day is
// the venue's (s+6)%24, and carries 4x that hour. So a row that lands on hour h
// must read 4h, and a row still on the array-index axis cannot.
const FORECAST_HOURS = Array.from({ length: 24 }, (_, slot) => ((slot + 6) % 24) * 4);
stubModule('../services/weatherService', {
  getWeather: async () => ({ temp: 70, humidity: 50, windSpeed: 3, conditions: 'Clear', isRaining: false }),
  getForecast: async () => [],
});
stubModule('../scripts/ml/bestTimeService', {
  fetchWeeklyForecast: async () => ({
    venueId: 'bt_axis_venue',
    days: [0, 1, 2, 3, 4, 5, 6].map((dayInt) => ({ dayInt, dayText: 'x', hours: FORECAST_HOURS })),
    epochAnalysis: 1786000000,
  }),
  fetchLiveBusyness: async () => ({
    forecastedBusyness: 50, liveBusyness: 64, liveAvailable: true, hour: null, venueOpen: true,
  }),
});
stubModule('../scripts/ml/eventService', {
  getNearestEvent: async () => ({
    event_nearby: false, event_distance_km: null, event_size: null, event_type: null, event_hours_until: null,
  }),
});

const { splitStatements, migrate } = require('../db/migrate');
const collectWeekly = require('../scripts/ml/collectWeekly');
const collectRealtime = require('../scripts/ml/collectRealtime');
const { bestTimeSlotToLocal, BESTTIME_DAY_START_HOUR } = collectWeekly;
const { refreshCollectedBaselines } = require('../scripts/ml/buildBaselines');

const NY_PLACE = 'ChIJaxisNewYork01';   // ordinary venue, real timezone
const NOTZ_PLACE = 'ChIJaxisNoZone001'; // ml_venues.timezone is garbage

let pg;
let pool;
let dataDir;
const venueIds = {};

// Seed plan. `slot` is what the OLD collectWeekly wrote: a BestTime day_raw
// index, not an hour. busyness values are deliberately distinct so a row that
// moved to the wrong slot cannot pass by coincidence.
const WEEKLY_SEED = [];
for (let slot = 0; slot < 24; slot++) {
  // Saturday: the rollover crosses the week boundary into Sunday.
  WEEKLY_SEED.push({ tag: `sat${slot}`, venue: 'ny', day: 6, slot, busyness: slot * 4, axis: null });
}
// Either side of the rollover edge, midweek.
WEEKLY_SEED.push({ tag: 'wed17', venue: 'ny', day: 3, slot: 17, busyness: 71, axis: null });
WEEKLY_SEED.push({ tag: 'wed18', venue: 'ny', day: 3, slot: 18, busyness: 73, axis: null });
// The disease stated out loud rather than left NULL.
WEEKLY_SEED.push({ tag: 'declaredIndex', venue: 'ny', day: 1, slot: 20, busyness: 77, axis: 'besttime_index' });
// A venue whose timezone is unusable — this transform never reads one.
WEEKLY_SEED.push({ tag: 'noTz0', venue: 'notz', day: 2, slot: 0, busyness: 11, axis: null });
WEEKLY_SEED.push({ tag: 'noTz1', venue: 'notz', day: 2, slot: 1, busyness: 13, axis: null });

// Already on the venue clock: written by the FIXED collector. Not a slot — a
// real hour — and it must not move.
const FIXED_POINT = { tag: 'alreadyLocal', venue: 'ny', day: 4, hour: 19, busyness: 81, axis: 'venue_local' };

// Realtime rows: `hour` here was ALWAYS the venue wall clock. rt2020 lands on
// exactly the slot Saturday index 14 is corrected into (6, 20), the adjacency
// that makes a sloppy predicate visible.
const REALTIME_SEED = [
  { tag: 'rt2020', venue: 'ny', day: 6, hour: 20, busyness: 97, baseline: 42 },
  { tag: 'rt0300', venue: 'ny', day: 0, hour: 3, busyness: 9, baseline: 5 },
];

const ids = {}; // tag -> ml_training_data.id

const expectedLocal = (row) => bestTimeSlotToLocal(row.slot, row.day);

async function snapshotTraining() {
  const { rows } = await pool.query(
    // xmin identifies the last writing transaction: an untouched row keeps its
    // xmin, a rewritten-to-the-same-values row would not.
    `SELECT id, venue_id, collection_mode, day_of_week, hour, hour_axis,
            busyness_pct, baseline_busyness, xmin::text AS xm
     FROM ml_training_data ORDER BY id`
  );
  return rows;
}

async function snapshotBaselines() {
  const { rows } = await pool.query(
    `SELECT google_place_id, day_of_week, hour, baseline, source, xmin::text AS xm
     FROM ml_venue_baselines ORDER BY google_place_id, day_of_week, hour`
  );
  return rows;
}

const byTag = (rows) => Object.fromEntries(
  Object.entries(ids).map(([tag, id]) => [tag, rows.find((r) => r.id === id)])
);

// Apply the migration exactly as db/migrate.js does in @noTransaction mode:
// each statement separately, autocommitting, on ONE session (the SET
// statement_timeout in the file is session scoped, and the DO block may only
// COMMIT because it is not inside a transaction block).
async function applyMigration() {
  const client = await pool.connect();
  try {
    for (const stmt of splitStatements(fs.readFileSync(MIGRATION_PATH, 'utf8'))) {
      await client.query(stmt);
    }
  } finally {
    client.release(true);
  }
}

test.before(async () => {
  dataDir = path.join(os.tmpdir(), 'flock-axis-pg-' + Date.now());
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'mlClockAxisBackfill', port: PG_PORT, databaseDir: dataDir,
  });
  // Not pg.start(): the wrapper turns embedded-postgres's bare reject() into an
  // error that names the suite, the port, and whether an orphan is holding it.
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_axis_test');

  pool = new Pool({ connectionString: CONN });

  // The REAL chain, via the REAL runner: 023 must apply cleanly in order, or
  // production's boot (server.js awaits migrate() before listen) dies with it.
  await migrate(pool);

  for (const [key, place, tz, name] of [
    ['ny', NY_PLACE, 'America/New_York', 'Axis NY Venue'],
    ['notz', NOTZ_PLACE, 'Gotham/Nowhere', 'Axis No-Timezone Venue'],
  ]) {
    const { rows } = await pool.query(
      `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude, venue_category, timezone)
       VALUES ($1, $2, 'philly', 39.95, -75.16, 'restaurant', $3) RETURNING id`,
      [place, name, tz]
    );
    venueIds[key] = rows[0].id;
  }

  // migrate() applied 023 to an EMPTY corpus, so it also installed the
  // constraint that forbids an undeclared weekly row. Production's corpus
  // predates the constraint, so reconstruct that state: drop it, seed the rows
  // the old collectors wrote, and let the migration re-add it. (That the file
  // can be re-applied at all is one of its claims.)
  await pool.query('ALTER TABLE ml_training_data DROP CONSTRAINT ml_training_data_weekly_axis_declared');

  const insertRow = async (tag, venue, mode, day, hour, busyness, axis, baseline) => {
    const { rows } = await pool.query(
      `INSERT INTO ml_training_data
         (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, busyness_pct, baseline_busyness)
       VALUES ($1, $2, $3, $4, $5, 'restaurant', $6, $7) RETURNING id`,
      [venueIds[venue], mode, axis, day, hour, busyness, baseline ?? null]
    );
    ids[tag] = rows[0].id;
  };

  for (const r of WEEKLY_SEED) await insertRow(r.tag, r.venue, 'weekly', r.day, r.slot, r.busyness, r.axis);
  await insertRow(FIXED_POINT.tag, FIXED_POINT.venue, 'weekly', FIXED_POINT.day, FIXED_POINT.hour,
    FIXED_POINT.busyness, FIXED_POINT.axis);
  for (const r of REALTIME_SEED) await insertRow(r.tag, r.venue, 'realtime', r.day, r.hour, r.busyness, null, r.baseline);

  // Derived-and-stored data as it stands BEFORE the fix: collected baselines on
  // the old axis, plus a Google-sourced row that was never on this axis.
  for (const [place, day, hour, baseline, source] of [
    [NY_PLACE, 6, 20, 3, 'collected'],   // real key after the fix -> overwritten
    [NOTZ_PLACE, 2, 0, 11, 'collected'], // old-axis key with no backing row -> deleted
    [NOTZ_PLACE, 2, 1, 13, 'collected'], // ditto
    [NOTZ_PLACE, 5, 12, 64, 'google'],   // not ours, must survive
  ]) {
    await pool.query(
      `INSERT INTO ml_venue_baselines (google_place_id, day_of_week, hour, baseline, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [place, day, hour, baseline, source]
    );
  }
});

test.after(async () => {
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  // Guarded for the same reason stop() is guarded above it: on Windows the
  // postgres process can still hold a handle to its data directory just after
  // it reports exit, so this rmdir raises EBUSY under a parallel run. This is a
  // scratch directory under os.tmpdir() and nothing reads it again, so failing
  // to delete it is not a result. Leaving it unguarded meant a suite whose
  // every assertion passed reported red on the weather.
  try {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.warn(`[mlClockAxisBackfill] could not remove ${dataDir}: ${err.message}`);
  }
});

test('023 exists at its number and declares @noTransaction (the DO block COMMITs)', () => {
  const src = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.ok(
    /^--\s*@noTransaction/.test(src.trimStart()),
    'the batch loop COMMITs per batch, which Postgres only allows outside a transaction block; '
    + 'the all-or-nothing form costs the same but risks db/migrate.js STATEMENT_TIMEOUT_MS on a '
    + '3.6M-row rewrite, and losing that bet is a boot loop that never makes progress'
  );
  const dir = path.join(__dirname, '..', 'migrations');
  const at023 = fs.readdirSync(dir).filter((f) => f.startsWith('023'));
  assert.deepStrictEqual(at023, [MIGRATION_FILE], 'two files at number 023 would race in name order');
});

test('the migration runner applied 023 as part of the real chain', async () => {
  const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [MIGRATION_FILE]);
  assert.strictEqual(rows.length, 1, '023 was not recorded in schema_migrations by db/migrate.js');
});

test('the backfill moves every weekly row to its venue-local hour, rolling the day for slots 18-23', async () => {
  // Fixture sanity first: every seeded slot must actually differ from its
  // corrected position, or the test proves nothing.
  for (const r of WEEKLY_SEED) {
    const want = expectedLocal(r);
    assert.notDeepStrictEqual({ day: r.day, hour: r.slot }, { day: want.dayOfWeek, hour: want.hour },
      `fixture ${r.tag}: the stored slot already equals the local hour`);
  }

  await applyMigration(); // must not throw — the garbage-timezone venue is in the table

  const rows = byTag(await snapshotTraining());
  for (const r of WEEKLY_SEED) {
    const want = expectedLocal(r);
    assert.strictEqual(rows[r.tag].hour, want.hour, `${r.tag}: hour`);
    assert.strictEqual(rows[r.tag].day_of_week, want.dayOfWeek, `${r.tag}: day_of_week`);
    assert.strictEqual(rows[r.tag].hour_axis, 'venue_local', `${r.tag}: axis not declared`);
    assert.strictEqual(rows[r.tag].busyness_pct, r.busyness, `${r.tag}: the LABEL must never move`);
  }

  // Hard literals, so a broken derivation cannot silently agree with broken
  // SQL. BestTime's day starts at 06:00.
  assert.strictEqual(BESTTIME_DAY_START_HOUR, 6);
  assert.deepStrictEqual([rows.sat0.day_of_week, rows.sat0.hour], [6, 6], 'Saturday slot 0 is Saturday 6 AM');
  assert.deepStrictEqual([rows.sat17.day_of_week, rows.sat17.hour], [6, 23], 'Saturday slot 17 is Saturday 11 PM');
  // The week boundary: Saturday's small hours belong to SUNDAY, day 0.
  assert.deepStrictEqual([rows.sat18.day_of_week, rows.sat18.hour], [0, 0], 'Saturday slot 18 is Sunday midnight');
  assert.deepStrictEqual([rows.sat23.day_of_week, rows.sat23.hour], [0, 5], 'Saturday slot 23 is Sunday 5 AM');
  // Midweek, either side of the edge.
  assert.deepStrictEqual([rows.wed17.day_of_week, rows.wed17.hour], [3, 23]);
  assert.deepStrictEqual([rows.wed18.day_of_week, rows.wed18.hour], [4, 0], 'Wednesday slot 18 is Thursday midnight');
  // Explicitly declared index rows are the same disease and are corrected too.
  assert.deepStrictEqual([rows.declaredIndex.day_of_week, rows.declaredIndex.hour], [2, 2]);
  // A venue with an unusable timezone is corrected identically — the transform
  // never consults one, unlike 021's.
  assert.deepStrictEqual([rows.noTz0.day_of_week, rows.noTz0.hour], [2, 6]);
  assert.deepStrictEqual([rows.noTz1.day_of_week, rows.noTz1.hour], [2, 7]);
});

test('realtime rows are untouched — not even rewritten to the same values (xmin proof)', async () => {
  const rows = byTag(await snapshotTraining());
  const corrected = new Set(WEEKLY_SEED.map((r) => rows[r.tag].xm));

  for (const r of REALTIME_SEED) {
    assert.strictEqual(rows[r.tag].day_of_week, r.day, `${r.tag}: a realtime hour was corrected — that CORRUPTS it`);
    assert.strictEqual(rows[r.tag].hour, r.hour, `${r.tag}: hour moved`);
    assert.strictEqual(rows[r.tag].hour_axis, null, `${r.tag}: legacy realtime rows are left unstamped by design`);
    assert.strictEqual(rows[r.tag].baseline_busyness, r.baseline, `${r.tag}: baseline_busyness moved`);
    assert.ok(!corrected.has(rows[r.tag].xm),
      `${r.tag} shares a writing transaction with the corrected weekly rows — the predicate touched it`);
  }

  // rt2020 sits at (day 6, hour 20), exactly where Saturday slot 14 landed.
  assert.strictEqual(rows.sat14.day_of_week, rows.rt2020.day_of_week);
  assert.strictEqual(rows.sat14.hour, rows.rt2020.hour);
  assert.notStrictEqual(rows.sat14.xm, rows.rt2020.xm, 'adjacency is the point: one moved, the other did not');
});

test('a weekly row already on the venue clock is a fixed point (xmin proof)', async () => {
  const rows = byTag(await snapshotTraining());
  const corrected = new Set(WEEKLY_SEED.map((r) => rows[r.tag].xm));
  assert.strictEqual(rows.alreadyLocal.day_of_week, FIXED_POINT.day);
  assert.strictEqual(rows.alreadyLocal.hour, FIXED_POINT.hour);
  assert.ok(!corrected.has(rows.alreadyLocal.xm),
    'a row written by the fixed collector was rewritten — the shift would be applied twice over two deploys');
});

test('running the whole migration twice writes nothing the second time (fixed point, pinned by xmin)', async () => {
  const beforeT = await snapshotTraining();
  const beforeB = await snapshotBaselines();

  // Through db/migrate.js itself this time, on a POPULATED table: the batch
  // loop, its per-batch COMMIT and the constraint statements all have to
  // survive the runner's @noTransaction path, which is how production will run
  // them. (The first application above is the same statements on the same kind
  // of session; this one is the runner.)
  await pool.query('DELETE FROM schema_migrations WHERE name = $1', [MIGRATION_FILE]);
  await migrate(pool);
  const { rows: reapplied } = await pool.query(
    'SELECT 1 FROM schema_migrations WHERE name = $1', [MIGRATION_FILE]
  );
  assert.strictEqual(reapplied.length, 1, 'the runner did not record the re-application');

  assert.deepStrictEqual(await snapshotTraining(), beforeT, 'the second run changed or rewrote training rows');
  assert.deepStrictEqual(await snapshotBaselines(), beforeB, 'the second run changed or rewrote baseline rows');
});

test('an undeclared weekly row can no longer be inserted at all', async () => {
  // The guard that ends this class of bug. A collector that forgets the column
  // now fails loudly instead of silently seeding a second clock.
  await assert.rejects(
    pool.query(
      `INSERT INTO ml_training_data (venue_id, collection_mode, day_of_week, hour, venue_category, busyness_pct)
       VALUES ($1, 'weekly', 3, 12, 'restaurant', 50)`,
      [venueIds.ny]
    ),
    (err) => err.code === '23514' && /weekly_axis_declared/.test(err.constraint || err.message),
    'a weekly row with no hour_axis was accepted'
  );
  // And the vocabulary is closed: a near-miss spelling reads as "not
  // venue_local" everywhere, so it must not be storable either.
  await assert.rejects(
    pool.query(
      `INSERT INTO ml_training_data (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, busyness_pct)
       VALUES ($1, 'weekly', 'local', 3, 12, 'restaurant', 50)`,
      [venueIds.ny]
    ),
    (err) => err.code === '23514',
    "hour_axis = 'local' was accepted"
  );
  // A realtime row still needs no stamp — that exemption is what keeps the
  // legacy realtime rows from needing a rewrite.
  await pool.query(
    `INSERT INTO ml_training_data (venue_id, collection_mode, day_of_week, hour, venue_category, busyness_pct)
     VALUES ($1, 'realtime', 3, 12, 'restaurant', 50)`,
    [venueIds.ny]
  );
  await pool.query(`DELETE FROM ml_training_data WHERE collection_mode = 'realtime' AND busyness_pct = 50`);
});

test('ml_venue_baselines is rebuilt on the corrected axis, and only the collected half is touched', async () => {
  const rows = await snapshotBaselines();
  const at = (place, day, hour) => rows.find(
    (r) => r.google_place_id === place && r.day_of_week === day && r.hour === hour
  );

  // Saturday slot 14 (busyness 56) became Saturday 20:00. The realtime row at
  // the same slot reads 97 and must NOT be averaged in — that missing
  // collection_mode filter is the second half of the two-clock bug.
  assert.strictEqual(at(NY_PLACE, 6, 20).baseline, 56, 'the realtime reading leaked into the baseline');
  // The overnight block is filed under Sunday now.
  assert.strictEqual(at(NY_PLACE, 0, 0).baseline, 18 * 4);
  assert.strictEqual(at(NY_PLACE, 0, 5).baseline, 23 * 4);
  assert.strictEqual(at(NY_PLACE, 6, 6).baseline, 0);
  // Nothing is left at the old-axis keys the corpus no longer backs.
  assert.strictEqual(at(NOTZ_PLACE, 2, 0), undefined, 'a stale collected slot survived the rebuild');
  assert.strictEqual(at(NOTZ_PLACE, 2, 1), undefined, 'a stale collected slot survived the rebuild');
  assert.strictEqual(at(NOTZ_PLACE, 2, 6).baseline, 11);
  assert.strictEqual(at(NOTZ_PLACE, 2, 7).baseline, 13);
  // Google-sourced rows are on their own axis and are not ours to rewrite.
  const google = at(NOTZ_PLACE, 5, 12);
  assert.strictEqual(google.baseline, 64);
  assert.strictEqual(google.source, 'google');
});

test('re-running buildBaselines.js after the migration is safe and changes nothing', async () => {
  // Scope item 3: the rebuild path has to be repeatable, and the migration and
  // the script have to be the same statement. If they had drifted, this run
  // would rewrite rows and the xmin snapshot would move.
  const before = await snapshotBaselines();
  const result = await refreshCollectedBaselines(pool);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.upserted, 0, 'buildBaselines rewrote slots the migration had already written');
  assert.strictEqual(result.deleted, 0, 'buildBaselines deleted slots the migration had left');
  assert.deepStrictEqual(await snapshotBaselines(), before, 'buildBaselines is not a fixed point after 023');
});

test('buildBaselines refuses to average a corpus that still holds index-axis rows', async () => {
  // The failure mode this guard exists for: half a corpus converted, a rebuild
  // run anyway, and every affected venue served a baseline six hours off.
  const { rows } = await pool.query(
    `INSERT INTO ml_training_data
       (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, busyness_pct)
     VALUES ($1, 'weekly', 'besttime_index', 5, 9, 'restaurant', 88) RETURNING id`,
    [venueIds.ny]
  );
  const strayId = rows[0].id;

  const before = await snapshotBaselines();
  const refused = await refreshCollectedBaselines(pool);
  assert.strictEqual(refused.ok, false, 'the rebuild ran against a mixed-axis corpus');
  assert.deepStrictEqual(await snapshotBaselines(), before, 'a refused rebuild still wrote');

  // And the migration is a permanent repair, not a one-shot: re-running it
  // converts the stray row and the rebuild works again.
  await applyMigration();
  const { rows: [fixed] } = await pool.query(
    'SELECT day_of_week, hour, hour_axis FROM ml_training_data WHERE id = $1', [strayId]
  );
  assert.deepStrictEqual(
    [fixed.day_of_week, fixed.hour, fixed.hour_axis],
    [5, 15, 'venue_local'],
    'a fresh index-axis row was not repaired by re-running the migration'
  );
  assert.strictEqual((await refreshCollectedBaselines(pool)).ok, true);

  await pool.query('DELETE FROM ml_training_data WHERE id = $1', [strayId]);
});

test('the SQL and collectWeekly.js compute the same shift for all 168 slots', async () => {
  // The convention pin. collectWeekly.js writes new rows with its JS transform;
  // 023 corrects old rows with a SQL one. If those ever disagree the corpus
  // splits in half again, so ask Postgres for its answer to every slot of every
  // day and compare with the exported function.
  const { rows } = await pool.query(`
    SELECT d AS day, s AS slot,
           (s + 6) % 24 AS hour,
           CASE WHEN s >= 18 THEN (d + 1) % 7 ELSE d END AS dow
    FROM generate_series(0, 6) d, generate_series(0, 23) s
    ORDER BY d, s
  `);
  assert.strictEqual(rows.length, 168);
  for (const r of rows) {
    const want = bestTimeSlotToLocal(r.slot, r.day);
    assert.deepStrictEqual({ hour: r.hour, dayOfWeek: r.dow }, want,
      `day ${r.day} slot ${r.slot}: SQL and collectWeekly.js disagree`);
  }
});

test('the fixed collectors run for real, land on one clock, and the corpus accepts them', async () => {
  // The other half of the job: a backfill that corrects history is worthless if
  // the next collection puts the corpus straight back on two clocks. This runs
  // BOTH collectors end to end against the migrated database — no BestTime call
  // (the service is stubbed), so it also proves the INSERT statements
  // themselves are well formed and satisfy the new CHECK constraint, which
  // counting placeholders by eye does not.
  const AUSTIN_PLACE = 'ChIJaxisAustin0001';
  const { rows: [venue] } = await pool.query(
    `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude, venue_category, timezone)
     VALUES ($1, 'Axis Collector Venue', 'austin', 30.27, -97.74, 'bar', 'America/Chicago') RETURNING id`,
    [AUSTIN_PLACE]
  );

  process.argv.push('--city=austin'); // leave the venues the earlier tests own alone
  try {
    await collectWeekly.run();
  } finally {
    process.argv.pop();
  }

  const { rows: weekly } = await pool.query(
    `SELECT day_of_week, hour, hour_axis, busyness_pct FROM ml_training_data
     WHERE venue_id = $1 AND collection_mode = 'weekly' ORDER BY day_of_week, hour`,
    [venue.id]
  );
  assert.strictEqual(weekly.length, 168, 'a full week did not survive the insert — check the CHECK constraint');
  for (const r of weekly) {
    assert.strictEqual(r.hour_axis, 'venue_local', 'the collector did not declare its axis');
    assert.strictEqual(r.busyness_pct, r.hour * 4,
      `hour ${r.hour} carries the busyness of slot ${r.hour}: the collector wrote the array index as the hour`);
  }

  // collectRealtime is PA-scoped by default since 2026-08-28 (the cron-bomb
  // guard in besttimeRefreshPrep.test.js); this venue is in austin, so the
  // scope is named the same way the weekly call above names it.
  process.argv.push('--city=austin');
  try {
    await collectRealtime.run();
  } finally {
    process.argv.pop();
  }

  const { rows: rt } = await pool.query(
    `SELECT day_of_week, hour, hour_axis, busyness_pct, baseline_busyness FROM ml_training_data
     WHERE venue_id = $1 AND collection_mode = 'realtime'`,
    [venue.id]
  );
  assert.strictEqual(rt.length, 1);
  assert.strictEqual(rt[0].hour_axis, 'venue_local');
  assert.strictEqual(rt[0].busyness_pct, 64, 'the live reading is the label');
  // THE JOIN OF THE TWO CLOCKS. collectRealtime stamps this from the weekly
  // rows at its own venue-local hour. Before the fix the weekly row sitting
  // there held the busyness of six hours later, so this was 4*((h+18)%24).
  assert.strictEqual(rt[0].baseline_busyness, rt[0].hour * 4,
    'the realtime row was stamped with a baseline from a different hour — the corpus is back on two clocks');

  // And the table production actually serves agrees with both.
  const { rows: [bl] } = await pool.query(
    `SELECT baseline FROM ml_venue_baselines WHERE google_place_id = $1 AND day_of_week = $2 AND hour = $3`,
    [AUSTIN_PLACE, rt[0].day_of_week, rt[0].hour]
  );
  assert.strictEqual(bl.baseline, rt[0].hour * 4, 'ml_venue_baselines is on a different axis from the corpus');
});

// ---------------------------------------------------------------------------
// The third writer of this column, which was still on the other clock.
//
// This file's whole subject is that `hour` means the venue's wall clock and
// that migration 023's SQL and collectWeekly's bestTimeSlotToLocal must never
// disagree about the transform. RETRAIN.md recorded a third writer as "still
// broken, deliberately out of scope": scripts/ml/discoverBestTime.js iterated
// the same day_raw array, wrote the ARRAY INDEX, and never set hour_axis. Since
// 023 that meant migration 023's ml_training_data_weekly_axis_declared CHECK
// raised 23514 on every row it wrote, and its catch suppressed only 23505 — so
// it logged an error per row, printed "Training rows inserted: 0" and exited 0.
//
// It is fixed by IMPORTING the transform, and that is the part worth pinning
// here rather than in the collector's own suite: a third copy of `(slot + 6)`
// is a third thing that can drift from the SQL this file compares against.
// ---------------------------------------------------------------------------
test('the discovery collector shares this transform rather than keeping its own', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'ml', 'discoverBestTime.js'), 'utf8'
  );
  assert.match(src, /bestTimeSlotToLocal[\s\S]{0,120}?\} = require\('\.\/collectWeekly'\);/,
    'discoverBestTime.js does not import the shared slot transform');
  assert.ok(!/function bestTimeSlotToLocal/.test(src),
    'discoverBestTime.js defines its own copy of the transform this file pins against the SQL');
  assert.match(src, /const local = bestTimeSlotToLocal\(slot, jsDayOfWeek\);/);
  // The day rollover comes with it. The old loop wrote day_of_week from a local
  // ternary and never rolled slots 18-23 into the next day at all.
  assert.ok(!/dayInt === 6 \? 0 : dayInt \+ 1/.test(src));
  assert.match(src, /const jsDayOfWeek = bestTimeDayToJsDay\(day\.day_int\);/);
  // And the row states which clock it is on, which is what the CHECK requires.
  const insert = src.slice(src.indexOf('INSERT INTO ml_training_data'));
  assert.ok(insert.slice(0, insert.indexOf('VALUES')).includes('hour_axis'),
    'the discovery collector still writes an undeclared weekly row');
  assert.match(src, /HOUR_AXIS_VENUE_LOCAL/,
    "the axis literal is hand-typed instead of taken from the collector that defines it");
});
