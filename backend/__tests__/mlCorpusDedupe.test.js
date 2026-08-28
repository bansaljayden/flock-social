'use strict';
// ---------------------------------------------------------------------------
// Migration 024 — ml_training_data gets the unique key its INSERTs have been
// naming since 006, its duplicate rows are collapsed, and the calendar columns
// collectWeekly never wrote are stamped. Against a REAL Postgres.
//
// None of this can be checked against a scripted pg fake. The survivor rule is
// a window function over rows that differ in every column; "the migration did
// not rewrite this row" is an xmin claim; `ON CONFLICT ... WHERE` inference
// against a PARTIAL unique index either works in the server or it does not; and
// the invalid-index cleanup can only be exercised by actually failing a
// CREATE INDEX CONCURRENTLY. So this file boots the repo's embedded-postgres
// dev dependency, applies the real migration chain with db/migrate.js, and runs
// 024 the way the runner does — statement by statement, on one session.
//
// What is pinned, and why each fixture row exists:
//   * a weekly group of three rows differing in EVERY column that can differ —
//     busyness, collected_at, baseline, epoch, weather, month. Newest wins.
//   * a group spanning a LEGACY ('besttime_index') row and a CORRECTED
//     ('venue_local') row where the legacy row is the NEWER one. The corrected
//     row must win anyway: its `hour` means the venue's wall clock, the legacy
//     row's means a BestTime array index six hours away, and recency must never
//     promote a wrong number.
//   * a group tied on collected_at (one batched INSERT gives 168 rows the same
//     timestamp) — besttime_epoch breaks it.
//   * a group tied on everything — id breaks it, so the rule is a TOTAL order
//     and the test can name the survivor.
//   * a row with NULL collected_at against a dated one — NULLS LAST, no
//     evidence loses.
//   * THREE UNDATED realtime rows at one (venue, dow, hour). These must ALL
//     survive. The index the audit specified keys realtime rows on
//     COALESCE(observed_date,'1970-01-01'), which would collapse them into one
//     and destroy paid, weight-1.0 observations whose dates are unrecoverable.
//     This is the deviation from that spec and this row is why.
//   * dated realtime rows on two different dates — both survive; two rows on
//     the same date — collapsed.
//   * the whole file run twice — the second run must write NOTHING (xmin).
//   * a CREATE INDEX CONCURRENTLY that FAILS partway, leaving an invalid index,
//     followed by a re-run that must clean it up and rebuild.
//   * both collectors re-run against the finished schema: no stacking, weekly
//     REFRESHES in place, realtime DOES NOTHING, and both now write
//     weather_condition_code, month and season.
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

const MIGRATION_FILE = '024_ml_training_data_unique_slot.sql';
const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', MIGRATION_FILE);
const WEEKLY_INDEX = 'ml_training_data_weekly_slot_uniq';
const REALTIME_INDEX = 'ml_training_data_realtime_slot_uniq';

// This suite boots its own embedded Postgres, so its port must be distinct from
// e2e-local.js's 59595 and from every sibling suite that does the same. It used
// to be the hardcoded 59647, which held right up until a run was killed: the
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
const PG_PORT = pickEmbeddedPgPort('mlCorpusDedupe');
const CONN = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_dedupe_test`;

// scripts/ml/* call dotenv.config() on backend/.env, which points at the LIVE
// Railway database. dotenv never overwrites an already-set variable, so pinning
// these before the requires below guarantees the collectors can only ever see
// this embedded instance. PGSSLMODE matters even with a connection string.
process.env.DATABASE_URL = CONN;
process.env.PGSSLMODE = 'disable';

// ---------------------------------------------------------------------------
// Stubs. ZERO paid API calls: BestTime and OpenWeatherMap are both replaced in
// the module cache before the collectors are required.
// ---------------------------------------------------------------------------
function stubModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

// Mutable so a SECOND collection run can return different numbers, which is the
// only way to tell "refreshed in place" apart from "did nothing".
let weeklyBusynessFor = (localHour) => localHour * 2;
let weeklyEpoch = 1786000000;
// BestTime hands back an array indexed by SLOT; slot s is the venue's (s+6)%24.
const forecastHours = () => Array.from({ length: 24 }, (_, slot) => weeklyBusynessFor((slot + 6) % 24));

const WEATHER_CONDITION_ID = 502; // OWM "heavy intensity rain"
stubModule('../services/weatherService', {
  getWeather: async () => ({
    temp: 61, humidity: 80, windSpeed: 7,
    conditions: 'heavy intensity rain',
    conditionId: WEATHER_CONDITION_ID,
    isRaining: true,
  }),
  getForecast: async () => [],
});
stubModule('../scripts/ml/bestTimeService', {
  fetchWeeklyForecast: async () => ({
    venueId: 'bt_dedupe_venue',
    days: [0, 1, 2, 3, 4, 5, 6].map((dayInt) => ({ dayInt, dayText: 'x', hours: forecastHours() })),
    epochAnalysis: weeklyEpoch,
  }),
  fetchLiveBusyness: async () => ({
    forecastedBusyness: 40, liveBusyness: 71, liveAvailable: true, hour: null, venueOpen: true,
  }),
});
stubModule('../scripts/ml/eventService', {
  getNearestEvent: async () => ({
    event_nearby: false, event_distance_km: null, event_size: null, event_type: null, event_hours_until: null,
  }),
});

const { splitStatements, migrate } = require('../db/migrate');
const { getSeason } = require('../scripts/ml/config');
const { venueCalendar } = require('../scripts/ml/collectWeekly');

// Both collectors call pool.end() when their run finishes, so a second run
// needs a fresh module instance. The stubs above stay in the cache.
function freshCollector(request) {
  delete require.cache[require.resolve(request)];
  return require(request);
}

const DUP_PLACE = 'ChIJdedupeDupVenue1';
const CAL_PLACE = 'ChIJdedupeCalendar1';
const COLLECT_PLACE = 'ChIJdedupeCollector1';

let pg;
let pool;
let dataDir;
const venueIds = {};
const ids = {}; // tag -> ml_training_data.id

// ---------------------------------------------------------------------------
// The fixture. Every weekly row declares an axis because migration 023's CHECK
// constraint requires it; the two unique indexes are dropped first because
// migrate() created them against an empty table and production's corpus
// predates them.
//
// `keep: true` marks the row the survivor rule must choose.
// ---------------------------------------------------------------------------
const T = (s) => new Date(s); // collected_at literals, UTC

const WEEKLY_SEED = [
  // 1. Differs in every column that can differ. Newest collected_at wins.
  { tag: 'everyA', venue: 'dup', dow: 2, hour: 19, busyness: 10, collected: T('2026-03-01T04:00:00Z'), axis: 'venue_local', epoch: 100, baseline: 1, month: null, temp: 40 },
  { tag: 'everyB', venue: 'dup', dow: 2, hour: 19, busyness: 20, collected: T('2026-05-01T04:00:00Z'), axis: 'venue_local', epoch: 200, baseline: 2, month: 7, temp: 90, keep: true },
  { tag: 'everyC', venue: 'dup', dow: 2, hour: 19, busyness: 30, collected: T('2026-04-01T04:00:00Z'), axis: 'venue_local', epoch: 300, baseline: 3, month: null, temp: 65 },

  // 2. Legacy vs corrected, with the LEGACY row newer. Corrected must win.
  { tag: 'legacyNew', venue: 'dup', dow: 3, hour: 8, busyness: 88, collected: T('2026-06-01T04:00:00Z'), axis: 'besttime_index', epoch: 900 },
  { tag: 'correctedOld', venue: 'dup', dow: 3, hour: 8, busyness: 44, collected: T('2026-03-01T04:00:00Z'), axis: 'venue_local', epoch: 100, keep: true },

  // 3. collected_at ties (one batched INSERT stamps 168 rows identically).
  { tag: 'epochLow', venue: 'dup', dow: 4, hour: 12, busyness: 51, collected: T('2026-04-02T10:00:00Z'), axis: 'venue_local', epoch: 500 },
  { tag: 'epochHigh', venue: 'dup', dow: 4, hour: 12, busyness: 52, collected: T('2026-04-02T10:00:00Z'), axis: 'venue_local', epoch: 900, keep: true },

  // 4. Tied on everything the rule looks at except id.
  { tag: 'idLow', venue: 'dup', dow: 5, hour: 13, busyness: 61, collected: T('2026-04-03T10:00:00Z'), axis: 'venue_local', epoch: null },
  { tag: 'idHigh', venue: 'dup', dow: 5, hour: 13, busyness: 62, collected: T('2026-04-03T10:00:00Z'), axis: 'venue_local', epoch: null, keep: true },

  // 5. A row that cannot say when it was collected must not outrank one that can.
  { tag: 'undated', venue: 'dup', dow: 1, hour: 6, busyness: 5, collected: null, axis: 'venue_local', epoch: null },
  { tag: 'dated', venue: 'dup', dow: 1, hour: 6, busyness: 6, collected: T('2026-03-05T10:00:00Z'), axis: 'venue_local', epoch: null, keep: true },

  // 6. A lone undated row: survives, and its calendar is NOT invented.
  { tag: 'loneUndated', venue: 'dup', dow: 1, hour: 7, busyness: 7, collected: null, axis: 'venue_local', epoch: null, keep: true },

  // 7. A row that already carries a month keeps it, and gets the season that
  //    month implies — not the season its collected_at implies.
  { tag: 'monthKept', venue: 'dup', dow: 1, hour: 9, busyness: 9, collected: T('2026-04-15T10:00:00Z'), axis: 'venue_local', epoch: null, month: 11, keep: true },

  // 8. An ordinary, unduplicated row: a fixed point, pinned by xmin.
  { tag: 'lonely', venue: 'dup', dow: 0, hour: 15, busyness: 33, collected: T('2026-04-04T10:00:00Z'), axis: 'venue_local', epoch: 700, month: 4, season: 'spring', keep: true },
];

// Twelve calendar rows, one per month, on a venue whose timezone is garbage —
// the migration must never consult ml_venues.timezone (023 refused to for the
// same reason) and must reproduce config.getSeason() exactly.
for (let m = 1; m <= 12; m++) {
  WEEKLY_SEED.push({
    tag: `cal${m}`, venue: 'cal', dow: 0, hour: m - 1, busyness: m,
    collected: T(`2026-${String(m).padStart(2, '0')}-15T12:00:00Z`),
    axis: 'venue_local', epoch: null, keep: true,
  });
}

const REALTIME_SEED = [
  // Dated duplicates of one venue-hour-date: collapsed, newest wins.
  { tag: 'rtDupOld', venue: 'dup', dow: 6, hour: 21, busyness: 80, collected: T('2026-05-10T02:05:00Z'), date: '2026-05-10' },
  { tag: 'rtDupNew', venue: 'dup', dow: 6, hour: 21, busyness: 85, collected: T('2026-05-10T02:40:00Z'), date: '2026-05-10', keep: true },
  // Same venue-hour, a DIFFERENT date: a separate observation, must survive.
  { tag: 'rtOtherDate', venue: 'dup', dow: 6, hour: 21, busyness: 90, collected: T('2026-05-17T02:10:00Z'), date: '2026-05-17', keep: true },
  // THE ROWS THE SPEC'D INDEX WOULD HAVE DELETED. Three undated legacy
  // observations at one (venue, dow, hour). Nothing can prove they are the same
  // observation, so all three stay.
  { tag: 'rtUndated1', venue: 'dup', dow: 6, hour: 22, busyness: 11, collected: T('2026-04-05T02:00:00Z'), date: null, keep: true },
  { tag: 'rtUndated2', venue: 'dup', dow: 6, hour: 22, busyness: 22, collected: T('2026-04-12T02:00:00Z'), date: null, keep: true },
  { tag: 'rtUndated3', venue: 'dup', dow: 6, hour: 22, busyness: 33, collected: T('2026-04-19T02:00:00Z'), date: null, keep: true },
];

async function snapshotTraining() {
  const { rows } = await pool.query(
    // xmin identifies the last writing transaction: an untouched row keeps its
    // xmin, a rewritten-to-the-same-values row would not.
    `SELECT id, venue_id, collection_mode, day_of_week, hour, hour_axis, month, season,
            busyness_pct, baseline_busyness, observed_date, besttime_epoch,
            collected_at, xmin::text AS xm
     FROM ml_training_data ORDER BY id`
  );
  return rows;
}

const byTag = (rows) => Object.fromEntries(
  Object.entries(ids).map(([tag, id]) => [tag, rows.find((r) => r.id === id)])
);

// Apply the migration exactly as db/migrate.js does in @noTransaction mode:
// each statement separately, autocommitting, on ONE session. CREATE INDEX
// CONCURRENTLY refuses to run inside a transaction block and the DO block may
// only COMMIT because it is not inside one.
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

async function indexState(name) {
  const { rows } = await pool.query(
    `SELECT i.indisvalid, i.indisunique, pg_get_indexdef(i.indexrelid) AS def
       FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1`,
    [name]
  );
  return rows[0] || null;
}

test.before(async () => {
  dataDir = path.join(os.tmpdir(), 'flock-dedupe-pg-' + Date.now());
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'mlCorpusDedupe', port: PG_PORT, databaseDir: dataDir,
  });
  // Not pg.start(): the wrapper turns embedded-postgres's bare reject() into an
  // error that names the suite, the port, and whether an orphan is holding it.
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_dedupe_test');

  pool = new Pool({ connectionString: CONN });

  // The REAL chain, via the REAL runner: 024 must apply cleanly in order, or
  // production's boot (server.js awaits migrate() before listen) dies with it.
  await migrate(pool);

  for (const [key, place, tz, city, name] of [
    ['dup', DUP_PLACE, 'America/New_York', 'philly', 'Dedupe Venue'],
    ['cal', CAL_PLACE, 'Gotham/Nowhere', 'philly', 'Calendar Venue (unusable timezone)'],
    ['collect', COLLECT_PLACE, 'America/Chicago', 'austin', 'Collector Venue'],
  ]) {
    const { rows } = await pool.query(
      `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude, venue_category, timezone)
       VALUES ($1, $2, $3, 30.27, -97.74, 'bar', $4) RETURNING id`,
      [place, name, city, tz]
    );
    venueIds[key] = rows[0].id;
  }

  // migrate() applied 024 to an EMPTY corpus, so the unique indexes already
  // exist. Production's corpus predates them; reconstruct that state.
  await pool.query(`DROP INDEX ${WEEKLY_INDEX}`);
  await pool.query(`DROP INDEX ${REALTIME_INDEX}`);

  const insert = async (r, mode) => {
    const { rows } = await pool.query(
      `INSERT INTO ml_training_data
         (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category,
          busyness_pct, baseline_busyness, besttime_epoch, month, season, temperature,
          observed_date, collected_at)
       VALUES ($1, $2, $3, $4, $5, 'bar', $6, $7, $8, $9, $10, $11, $12,
               COALESCE($13::timestamptz, NULL))
       RETURNING id`,
      [
        venueIds[r.venue], mode, r.axis ?? null, r.dow, r.hour, r.busyness,
        r.baseline ?? null, r.epoch ?? null, r.month ?? null, r.season ?? null,
        r.temp ?? null, r.date ?? null, r.collected ?? null,
      ]
    );
    ids[r.tag] = rows[0].id;
  };

  for (const r of WEEKLY_SEED) await insert(r, 'weekly');
  for (const r of REALTIME_SEED) await insert(r, 'realtime');
});

test.after(async () => {
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('024 exists at its number, is the only file there, and declares @noTransaction', () => {
  const src = fs.readFileSync(MIGRATION_PATH, 'utf8');
  assert.ok(
    /^--\s*@noTransaction/.test(src.trimStart()),
    'CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and the batch loop COMMITs per batch '
    + 'so a killed deploy resumes instead of restarting — both require @noTransaction'
  );
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  assert.deepStrictEqual(
    files.filter((f) => f.startsWith('024')), [MIGRATION_FILE],
    'two files at number 024 would race in name order'
  );
  // It must sort AFTER 023, whose rotation it depends on having run. It need
  // not be last forever — a later migration is fine, and pinning "last" here
  // would turn someone else's 025 into a failure in this file.
  const prev = files[files.indexOf(MIGRATION_FILE) - 1];
  assert.ok(prev && prev.startsWith('023'), `024 must follow 023 in name order, not ${prev}`);

  // The heavy statements must be batched with a per-batch COMMIT. Migration 023
  // took the API down for nine minutes; an unbatched rewrite here would do it
  // again and, worse, would restart from zero on every killed deploy.
  assert.ok(/COMMIT;/.test(src), 'the loop does not commit per batch');
  assert.ok(/CREATE UNIQUE INDEX CONCURRENTLY/.test(src), 'the index is not built CONCURRENTLY');
  assert.ok(/NOT i\.indisvalid/.test(src), 'missing the 008/013/014/018 invalid-index cleanup');
});

test('the migration runner applied 024 as part of the real chain', async () => {
  const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [MIGRATION_FILE]);
  assert.strictEqual(rows.length, 1, '024 was not recorded in schema_migrations by db/migrate.js');
});

let beforeMigration; // xmin snapshot taken while the corpus is still duplicated

test('the fixture really is duplicated, and the corpus really has no unique key yet', async () => {
  beforeMigration = byTag(await snapshotTraining());
  assert.strictEqual(await indexState(WEEKLY_INDEX), null, 'the weekly unique index was not dropped for seeding');
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT venue_id, day_of_week, hour FROM ml_training_data
        WHERE collection_mode = 'weekly'
        GROUP BY 1, 2, 3 HAVING COUNT(*) > 1
     ) g`
  );
  assert.strictEqual(rows[0].n, 5, 'the weekly fixture does not hold the five duplicate groups the rule is judged on');
});

test('the survivor rule keeps exactly one row per weekly slot, and the right one', async () => {
  await applyMigration();

  const rows = byTag(await snapshotTraining());
  for (const r of [...WEEKLY_SEED, ...REALTIME_SEED]) {
    if (r.keep) assert.ok(rows[r.tag], `${r.tag}: the survivor was deleted`);
    else assert.strictEqual(rows[r.tag], undefined, `${r.tag}: a losing duplicate survived`);
  }

  // Stated one at a time so a failure says WHICH clause of the rule broke.
  assert.strictEqual(rows.everyB.busyness_pct, 20, 'newest collected_at did not win');
  assert.strictEqual(rows.everyB.baseline_busyness, 2, 'the survivor is not a whole row from one fetch');
  assert.strictEqual(rows.correctedOld.busyness_pct, 44,
    "a 'besttime_index' row won on recency — its hour is a BestTime array index, six hours from what the column means");
  assert.strictEqual(rows.epochHigh.busyness_pct, 52, 'besttime_epoch did not break the collected_at tie');
  assert.strictEqual(rows.idHigh.busyness_pct, 62, 'the rule is not a total order');
  assert.strictEqual(rows.dated.busyness_pct, 6, 'a row with NULL collected_at outranked a dated one');

  // A row that was neither a duplicate nor missing a calendar stamp must not be
  // rewritten at all — not even to the same values. xmin, not values.
  assert.strictEqual(rows.lonely.xm, beforeMigration.lonely.xm,
    'a complete, unduplicated row was rewritten; on 3.5M rows that is the whole cost of the migration for nothing');

  // And nothing is left over: one row per weekly slot, everywhere.
  const { rows: [dupes] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT venue_id, day_of_week, hour FROM ml_training_data
        WHERE collection_mode = 'weekly' GROUP BY 1, 2, 3 HAVING COUNT(*) > 1
     ) g`
  );
  assert.strictEqual(dupes.n, 0);
});

test('undated realtime rows are preserved — the deviation from the specified index', async () => {
  const rows = byTag(await snapshotTraining());
  // The audit specified a key of COALESCE(observed_date,'1970-01-01'), which
  // maps all three of these onto ONE key. They are legacy observations from
  // three different weeks whose dates cannot be reconstructed from a busyness
  // number, and they carry sample weight 1.0 in training.
  assert.deepStrictEqual(
    [rows.rtUndated1.busyness_pct, rows.rtUndated2.busyness_pct, rows.rtUndated3.busyness_pct],
    [11, 22, 33],
    'undated realtime observations were collapsed — that is unrecoverable data loss'
  );
  // Dated ones on different dates are separate observations too.
  assert.strictEqual(rows.rtOtherDate.busyness_pct, 90);
  // But two pulls of the same venue-hour on the same date are one observation.
  assert.strictEqual(rows.rtDupNew.busyness_pct, 85);
  assert.strictEqual(rows.rtDupOld, undefined);
});

test('month and season are stamped from collected_at, and match config.getSeason for all twelve months', async () => {
  const rows = byTag(await snapshotTraining());

  for (let m = 1; m <= 12; m++) {
    const row = rows[`cal${m}`];
    assert.strictEqual(row.month, m, `cal${m}: month`);
    assert.strictEqual(row.season, getSeason(m),
      `cal${m}: the migration's season CASE disagrees with scripts/ml/config.js getSeason`);
  }

  // A row that already carried a month keeps it, and gets the season THAT month
  // implies — not the season its collection date implies.
  assert.strictEqual(rows.monthKept.month, 11, 'an existing month was overwritten');
  assert.strictEqual(rows.monthKept.season, 'fall',
    'season was derived from collected_at instead of from the month the row ends up with');

  // A row with no collected_at is SKIPPED, not guessed. This is the line
  // between backfilling a date the row carries and inventing one.
  assert.strictEqual(rows.loneUndated.month, null, 'a month was invented for a row with no collected_at');
  assert.strictEqual(rows.loneUndated.season, null, 'a season was invented for a row with no collected_at');

  // Nothing else is left at month 0 / NULL except that one honest gap.
  const { rows: [gap] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ml_training_data
      WHERE (month IS NULL OR season IS NULL) AND collected_at IS NOT NULL`
  );
  assert.strictEqual(gap.n, 0, 'a datable row was left without a calendar stamp');
});

test('both unique indexes exist, are unique, are valid, and are partial in the right way', async () => {
  const weekly = await indexState(WEEKLY_INDEX);
  const realtime = await indexState(REALTIME_INDEX);
  for (const [name, ix] of [[WEEKLY_INDEX, weekly], [REALTIME_INDEX, realtime]]) {
    assert.ok(ix, `${name} was not created`);
    assert.strictEqual(ix.indisunique, true, `${name} is not UNIQUE — the ON CONFLICT target would be decorative again`);
    assert.strictEqual(ix.indisvalid, true, `${name} is INVALID: present to the catalog, never used by the planner`);
  }
  assert.match(weekly.def, /\(venue_id, day_of_week, hour\)/);
  assert.match(weekly.def, /collection_mode\)?::text = 'weekly'/);
  assert.match(weekly.def, /hour_axis\)?::text = 'venue_local'/,
    "the weekly index is not scoped to the corrected axis — 023's rotation would hit 23505 on its intermediate state, "
    + 'and a besttime_index hour would be treated as the same slot as a venue-local one');
  assert.match(realtime.def, /\(venue_id, day_of_week, hour, observed_date\)/);
  assert.match(realtime.def, /observed_date IS NOT NULL/,
    'the realtime index is not restricted to dated rows, so undated legacy observations are at risk');
});

test('migration 023 stays re-runnable: its rotation is not rejected by the new unique index', async () => {
  // 023 shifts every weekly row by six hours, so rows chase each other around
  // the 168-cell week — slot 0 lands where slot 18 sits. Postgres checks a
  // unique index per ROW, not at statement end, so an axis-blind key would
  // reject the intermediate state and 023 would stop being the permanent
  // repair tool its header claims to be. Re-run the whole of 023 here; it is
  // the migration mlClockAxisBackfill.test.js owns, and this is the interaction
  // between the two files.
  const seeded = [];
  for (let slot = 0; slot < 24; slot++) {
    const { rows } = await pool.query(
      `INSERT INTO ml_training_data
         (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, busyness_pct, collected_at)
       VALUES ($1, 'weekly', 'besttime_index', 6, $2, 'bar', $3, NOW()) RETURNING id`,
      [venueIds.collect, slot, slot]
    );
    seeded.push(rows[0].id);
  }

  const client = await pool.connect();
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'migrations', '023_backfill_ml_weekly_local_hours.sql'), 'utf8');
    for (const stmt of splitStatements(src)) await client.query(stmt);
  } finally {
    client.release(true);
  }

  const { rows: moved } = await pool.query(
    `SELECT hour, day_of_week, hour_axis, busyness_pct FROM ml_training_data
      WHERE id = ANY($1) ORDER BY busyness_pct`,
    [seeded]
  );
  assert.strictEqual(moved.length, 24, '023 lost rows to the unique index');
  for (const r of moved) {
    const slot = r.busyness_pct;
    assert.strictEqual(r.hour_axis, 'venue_local');
    assert.strictEqual(r.hour, (slot + 6) % 24, `slot ${slot} did not rotate`);
    assert.strictEqual(r.day_of_week, slot >= 18 ? 0 : 6, `slot ${slot} did not roll the day`);
  }

  await pool.query('DELETE FROM ml_training_data WHERE id = ANY($1)', [seeded]);
});

test('the constraint is real: a second weekly row for the same slot is now rejected', async () => {
  const args = [venueIds.dup];
  await assert.rejects(
    pool.query(
      `INSERT INTO ml_training_data (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, busyness_pct)
       VALUES ($1, 'weekly', 'venue_local', 0, 15, 'bar', 99)`,
      args
    ),
    (err) => err.code === '23505' && new RegExp(WEEKLY_INDEX).test(err.constraint || err.message),
    'ml_training_data still accepts a duplicate weekly slot'
  );
  // And realtime, on a date already recorded.
  await assert.rejects(
    pool.query(
      `INSERT INTO ml_training_data (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, busyness_pct, observed_date)
       VALUES ($1, 'realtime', 'venue_local', 6, 21, 'bar', 99, DATE '2026-05-10')`,
      args
    ),
    (err) => err.code === '23505',
    'ml_training_data still accepts a duplicate realtime venue-hour-date'
  );
  // An undated realtime row is outside the partial index and stays insertable —
  // that exemption is what keeps the legacy rows safe.
  const { rows: [extra] } = await pool.query(
    `INSERT INTO ml_training_data (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, busyness_pct)
     VALUES ($1, 'realtime', 'venue_local', 6, 22, 'bar', 44) RETURNING id`,
    args
  );
  await pool.query('DELETE FROM ml_training_data WHERE id = $1', [extra.id]);
});

test('running the whole migration twice writes NOTHING the second time (fixed point, pinned by xmin)', async () => {
  const before = await snapshotTraining();

  // Through db/migrate.js itself this time, on a POPULATED table with the
  // indexes already in place — which is how production will re-encounter it.
  await pool.query('DELETE FROM schema_migrations WHERE name = $1', [MIGRATION_FILE]);
  await migrate(pool);
  const { rows: reapplied } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [MIGRATION_FILE]);
  assert.strictEqual(reapplied.length, 1, 'the runner did not record the re-application');

  assert.deepStrictEqual(await snapshotTraining(), before, 'the second run changed or rewrote rows');
  assert.strictEqual((await indexState(WEEKLY_INDEX)).indisvalid, true);
  assert.strictEqual((await indexState(REALTIME_INDEX)).indisvalid, true);
});

test('a CREATE INDEX CONCURRENTLY that dies partway leaves an invalid index, and a re-run repairs it', async () => {
  // The failure mode 008/013/014/018 all carry cleanup for, reproduced for real
  // rather than asserted from the source: drop the index, reintroduce the
  // duplicate the index forbids, and let the build fail on it.
  await pool.query(`DROP INDEX ${WEEKLY_INDEX}`);
  // Deliberately OLDER than `lonely`, the legitimate occupant of that slot, so
  // the assertion below names one specific survivor.
  const { rows: [stray] } = await pool.query(
    `INSERT INTO ml_training_data
       (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category, busyness_pct, collected_at)
     VALUES ($1, 'weekly', 'venue_local', 0, 15, 'bar', 99, TIMESTAMPTZ '2020-01-01 00:00:00Z') RETURNING id`,
    [venueIds.dup]
  );

  await assert.rejects(
    pool.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${WEEKLY_INDEX}
         ON ml_training_data (venue_id, day_of_week, hour)
         WHERE collection_mode = 'weekly' AND hour_axis = 'venue_local'`
    ),
    (err) => err.code === '23505',
    'the duplicate did not fail the build, so this test proves nothing'
  );

  const broken = await indexState(WEEKLY_INDEX);
  assert.ok(broken, 'the failed build left nothing behind — adjust the fixture, not the cleanup');
  assert.strictEqual(broken.indisvalid, false, 'the leftover index is valid, so there is nothing to clean up');

  // Now the whole point: `IF NOT EXISTS` alone would see that name and skip it
  // forever. Re-running the migration must drop it, collapse the duplicate it
  // choked on, and rebuild a VALID index.
  await applyMigration();

  const repaired = await indexState(WEEKLY_INDEX);
  assert.strictEqual(repaired.indisvalid, true, 'the invalid index was skipped by IF NOT EXISTS instead of dropped');
  assert.strictEqual(repaired.indisunique, true);
  const { rows: gone } = await pool.query('SELECT 1 FROM ml_training_data WHERE id = $1', [stray.id]);
  assert.strictEqual(gone.length, 0, 'the duplicate that broke the build survived the re-run');
  const { rows: [survivor] } = await pool.query(
    `SELECT id, busyness_pct FROM ml_training_data
      WHERE venue_id = $1 AND collection_mode = 'weekly' AND day_of_week = 0 AND hour = 15`,
    [venueIds.dup]
  );
  assert.strictEqual(survivor.id, ids.lonely, 'the older stray row won — the survivor rule is not recency');
});

test('collectWeekly re-runs against the finished schema: refreshed in place, never stacked', async () => {
  const collectWeekly = freshCollector('../scripts/ml/collectWeekly');
  const weekOf = async () => {
    const { rows } = await pool.query(
      `SELECT day_of_week, hour, hour_axis, month, season, busyness_pct, weather_condition_code, besttime_epoch
         FROM ml_training_data
        WHERE venue_id = $1 AND collection_mode = 'weekly'
        ORDER BY day_of_week, hour`,
      [venueIds.collect]
    );
    return rows;
  };

  process.argv.push('--city=austin'); // leave the fixture venues alone
  try {
    await collectWeekly.run();
  } finally {
    process.argv.pop();
  }

  const first = await weekOf();
  assert.strictEqual(first.length, 168, 'a full week did not survive the insert');
  const expected = venueCalendar({ timezone: 'America/Chicago' });
  for (const r of first) {
    assert.strictEqual(r.hour_axis, 'venue_local');
    assert.strictEqual(r.busyness_pct, r.hour * 2, 'the collector wrote the array index as the hour');
    assert.strictEqual(r.weather_condition_code, WEATHER_CONDITION_ID,
      'weather_condition_code is still NULL — the ten weather_* features stay dead');
    assert.strictEqual(r.month, expected.month, 'month was not stamped at collection');
    assert.strictEqual(r.season, expected.season, 'season was not stamped at collection');
    assert.strictEqual(r.season, getSeason(r.month));
  }

  // THE WHOLE POINT. Re-run with different numbers: still 168 rows, and the
  // stored week is the NEW read, not the old one and not both.
  weeklyBusynessFor = (localHour) => localHour * 3;
  weeklyEpoch = 1786999999;
  const collectWeeklyAgain = freshCollector('../scripts/ml/collectWeekly');
  process.argv.push('--city=austin');
  try {
    await collectWeeklyAgain.run();
  } finally {
    process.argv.pop();
    weeklyBusynessFor = (localHour) => localHour * 2;
    weeklyEpoch = 1786000000;
  }

  const second = await weekOf();
  assert.strictEqual(second.length, 168,
    'the re-run stacked a second copy of the week — ON CONFLICT is decorative again');
  for (const r of second) {
    assert.strictEqual(r.busyness_pct, r.hour * 3, 'the re-collection did not refresh the stored snapshot');
    assert.strictEqual(Number(r.besttime_epoch), 1786999999, 'besttime_epoch was left stale by the DO UPDATE');
  }
});

test('collectRealtime re-runs against the finished schema: the second pull of an hour is dropped, not stacked', async () => {
  // PA-scoped by default since 2026-08-28 (besttimeRefreshPrep.test.js); this
  // suite's fixture city is its own, and what is under test is dedupe, not
  // scope, so the global sweep is opted into for this test.
  process.argv.push('--all-cities');

  const before = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ml_training_data WHERE venue_id = $1 AND collection_mode = 'realtime'`,
    [venueIds.collect]
  );
  assert.strictEqual(before.rows[0].n, 0);

  await freshCollector('../scripts/ml/collectRealtime').run();

  const { rows: first } = await pool.query(
    `SELECT day_of_week, hour, hour_axis, month, season, busyness_pct, weather_condition_code, observed_date
       FROM ml_training_data WHERE venue_id = $1 AND collection_mode = 'realtime'`,
    [venueIds.collect]
  );
  assert.strictEqual(first.length, 1);
  assert.strictEqual(first[0].busyness_pct, 71, 'the live reading is the label');
  assert.strictEqual(first[0].hour_axis, 'venue_local');
  assert.strictEqual(first[0].weather_condition_code, WEATHER_CONDITION_ID,
    'weather_condition_code is still NULL on realtime rows');
  assert.ok(first[0].month >= 1 && first[0].month <= 12);
  assert.strictEqual(first[0].season, getSeason(first[0].month));
  assert.ok(first[0].observed_date, 'observed_date is what makes the realtime key enforceable');

  // Second pull inside the same clock hour: the same observation re-read.
  await freshCollector('../scripts/ml/collectRealtime').run();
  const { rows: [after] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ml_training_data WHERE venue_id = $1 AND collection_mode = 'realtime'`,
    [venueIds.collect]
  );
  assert.strictEqual(after.n, 1,
    'the realtime collector stacked a second row for the same venue-hour-date');
});

test('a collector refuses to run against a database that has not applied 024', async () => {
  // These scripts are also pointed at databases that have not booted the current
  // server (that is why they self-create their columns). A column can be added
  // from here; a unique index cannot, because building one means first deciding
  // what to do with the duplicates already stored. Without this check Postgres
  // raises 42P10 once per venue, the per-venue catch logs it as "Batch insert
  // error", and thousands of venues report 0 rows with no stated cause.
  const { requireSlotIndex, WEEKLY_SLOT_INDEX } = require('../scripts/ml/collectWeekly');
  assert.strictEqual(WEEKLY_SLOT_INDEX, WEEKLY_INDEX);
  await requireSlotIndex(pool, WEEKLY_INDEX); // present and valid: no throw

  await assert.rejects(
    () => requireSlotIndex(pool, 'ml_training_data_no_such_index'),
    /does not exist on this database.*024_ml_training_data_unique_slot\.sql/s
  );

  // And an INVALID leftover is refused too — it enforces itself on every insert
  // while the planner ignores it, which is the worst of both.
  await pool.query('UPDATE pg_index SET indisvalid = false WHERE indexrelid = $1::regclass', [WEEKLY_INDEX]);
  try {
    await assert.rejects(() => requireSlotIndex(pool, WEEKLY_INDEX), /INVALID/);
  } finally {
    await pool.query('UPDATE pg_index SET indisvalid = true WHERE indexrelid = $1::regclass', [WEEKLY_INDEX]);
  }
});

test('venueCalendar falls back to UTC rather than losing a venue to a bad timezone string', () => {
  const at = Date.parse('2026-07-04T18:00:00Z');
  assert.deepStrictEqual(venueCalendar({ timezone: 'Gotham/Nowhere' }, at), { month: 7, season: 'summer' });
  assert.deepStrictEqual(venueCalendar({ timezone: null }, at), { month: 7, season: 'summer' });
  assert.deepStrictEqual(venueCalendar({}, at), { month: 7, season: 'summer' });
  // A real zone is used when it works — 18:00 UTC on Jan 1 is still Dec 31 in
  // New York, and the month must follow the venue, not the server.
  assert.deepStrictEqual(
    venueCalendar({ timezone: 'America/New_York' }, Date.parse('2026-01-01T02:00:00Z')),
    { month: 12, season: 'winter' }
  );
});
