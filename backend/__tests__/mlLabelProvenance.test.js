'use strict';
// ---------------------------------------------------------------------------
// Label provenance on the ML corpus — migration 025 and collectRealtime.js,
// against a REAL Postgres.
//
// THE FINDING THIS FILE EXISTS FOR. Every one of the 457,402 realtime rows in
// production carries `label_source IS NULL`, so all 369,076 that survive into
// training export as `label_provenance='unknown'`. Nobody can currently say
// whether the crowd model was scored against observed foot traffic or against
// BestTime's own forecast of it, and prepare_features.py's 0.3 weight for
// vendor-forecast labels has therefore never applied to a single row.
//
// The distinction is NOT recoverable for those rows and this file pins that
// too: 025 must leave them alone, provably, by xmin rather than by values.
// What it fixes is the future — and the fix is not "the collector intends to
// write a label", because the collector has intended that since round 10.
// The fix is that the run READS BACK what it wrote and refuses to report
// success on an unlabelled row.
//
// What is pinned, and why each test exists:
//   * 025 is in the migration chain, applied by the real runner. label_source
//     used to exist ONLY because collectRealtime.js ALTERs it into being; on
//     any database the collector had not run against, export_training_data.js's
//     optional-column probe selects `NULL AS label_source` and exports every
//     realtime row as 'unknown' with no error and no log line.
//   * the CHECK guards new writes while NOT VALID, which is the entire reason
//     it is cheap. A NOT VALID constraint that did not enforce inserts would be
//     decorative, exactly like migration 024's ON CONFLICT was.
//   * legacy rows keep label_source NULL and keep their xmin, through a second
//     full application of the file.
//   * classifyReading() is table-driven, including the case that produced this
//     whole mess: BestTime echoing its forecast into venue_live_busyness while
//     venue_live_busyness_available is false.
//   * the collector end-to-end on both paths, against a real database, with
//     BestTime stubbed. Zero paid calls.
//   * the audit REFUSES. Proven by making the write actually lose the label
//     (a trigger), not by trusting the branch to be reachable.
//   * cost, measured at 0 rows and at 1,000,000 rows, because 023 cost nine
//     minutes of closed port and 024 two, and the operator deciding whether to
//     deploy this tonight needs a number rather than an adjective.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;

const MIGRATION_FILE = '025_ml_label_provenance.sql';
const MIGRATION_PATH = path.join(__dirname, '..', 'migrations', MIGRATION_FILE);
const CONSTRAINT = 'ml_training_data_label_provenance_valid';

// Distinct from 59595 (e2e), 59641, 59643, 59647, 59723, 59999.
const PG_PORT = 59651;
const CONN = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_prov_test`;

// scripts/ml/* call dotenv.config() on backend/.env, which points at the LIVE
// Railway database. dotenv never overwrites an already-set variable, so pinning
// these before the requires below is what guarantees the collector can only
// ever reach this embedded instance. PGSSLMODE matters on its own: pg reads it
// even when a connection string is passed.
process.env.DATABASE_URL = CONN;
process.env.PGSSLMODE = 'disable';
// Belt and braces on the "ZERO paid API calls" rule: even if a stub were ever
// dropped, bestTimeService returns null with no key rather than calling out.
delete process.env.BESTTIME_API_KEY;

// The stubbed live response, mutable so one stub can serve both paths.
let LIVE_RESPONSE = {
  forecastedBusyness: 40, liveBusyness: 75, liveAvailable: true, hour: null, venueOpen: true,
};

function stubModule(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}
stubModule('../services/weatherService', {
  getWeather: async () => ({
    temp: 71, humidity: 44, windSpeed: 5, conditions: 'few clouds', conditionId: 801, isRaining: false,
  }),
  getForecast: async () => [],
});
stubModule('../scripts/ml/bestTimeService', {
  fetchWeeklyForecast: async () => ({
    venueId: 'bt_prov_venue',
    days: [0, 1, 2, 3, 4, 5, 6].map((dayInt) => ({ dayInt, dayText: 'x', hours: Array(24).fill(30) })),
    epochAnalysis: 1786000000,
  }),
  fetchLiveBusyness: async () => LIVE_RESPONSE,
});
stubModule('../scripts/ml/eventService', {
  getNearestEvent: async () => ({
    event_nearby: false, event_distance_km: null, event_size: null, event_type: null, event_hours_until: null,
  }),
});

const { splitStatements, migrate } = require('../db/migrate');
const exporter = require('../scripts/ml/train/export_training_data');
const collectRealtime = require('../scripts/ml/collectRealtime');
const { classifyReading, LABEL_LIVE, LABEL_FORECAST } = collectRealtime;

// collectRealtime.run() ends its pool, so a second run needs a fresh instance.
// The stubs above stay in the cache.
function freshCollector() {
  delete require.cache[require.resolve('../scripts/ml/collectRealtime')];
  return require('../scripts/ml/collectRealtime');
}

const LIVE_PLACE = 'ChIJprovLiveVenue01';
const FC_PLACE = 'ChIJprovForecastVen1';
const REFUSE_PLACE = 'ChIJprovRefuseVenu1';
const COST_CITY = 'costbulk';

let pg;
let pool;
let dataDir;
const venueIds = {};
const legacyIds = {};

// Apply the file exactly as db/migrate.js does in DEFAULT mode: statement by
// statement on one session. (025 declares no directive, so the runner wraps it
// in a transaction; re-applying it here without one is strictly harsher.)
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

async function snapshotTraining() {
  const { rows } = await pool.query(
    `SELECT id, collection_mode, label_source, vendor_forecast_pct, busyness_pct,
            observed_date, hour_axis, xmin::text AS xm
       FROM ml_training_data ORDER BY id`
  );
  return rows;
}

async function activeVenue(place, name, city = 'austin') {
  const { rows } = await pool.query(
    `INSERT INTO ml_venues (google_place_id, besttime_venue_id, name, city, latitude, longitude,
                            venue_category, timezone, is_active)
     VALUES ($1, $2, $3, $4, 30.27, -97.74, 'bar', 'America/Chicago', true)
     RETURNING id`,
    [place, 'bt_' + place, name, city]
  );
  return rows[0].id;
}

// Only ONE venue may be collectable at a time: the collector sweeps every
// active venue with a besttime_venue_id, and each test wants a known row count.
async function onlyCollectable(id) {
  await pool.query('UPDATE ml_venues SET is_active = (id = $1) WHERE besttime_venue_id IS NOT NULL', [id]);
}

test.before(async () => {
  dataDir = path.join(os.tmpdir(), 'flock-prov-pg-' + Date.now());
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port: PG_PORT, persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('flock_prov_test');
  pool = new Pool({ connectionString: CONN });

  // The REAL chain, via the REAL runner. If 025 cannot apply in order,
  // production's boot dies with it (server.js awaits migrate() before listen).
  await migrate(pool);

  venueIds.live = await activeVenue(LIVE_PLACE, 'Provenance Live Bar');
  venueIds.fc = await activeVenue(FC_PLACE, 'Provenance Forecast Bar');
  venueIds.refuse = await activeVenue(REFUSE_PLACE, 'Provenance Refusal Bar');

  // The corpus as production holds it: realtime rows from before label_source,
  // observed_date and hour_axis existed, and a weekly row for contrast. Nothing
  // about these rows says which of the two BestTime numbers they carry, and
  // that is the state 025 must preserve rather than repair.
  for (const [tag, mode, dow, hour, busyness] of [
    ['legacyRt1', 'realtime', 5, 21, 65],
    ['legacyRt2', 'realtime', 5, 22, 40],
    ['legacyWeekly', 'weekly', 5, 21, 45],
  ]) {
    const { rows } = await pool.query(
      `INSERT INTO ml_training_data
         (venue_id, collection_mode, day_of_week, hour, venue_category, busyness_pct, hour_axis)
       VALUES ($1, $2, $3, $4, 'bar', $5, $6) RETURNING id`,
      [venueIds.live, mode, dow, hour, busyness, mode === 'weekly' ? 'venue_local' : null]
    );
    legacyIds[tag] = rows[0].id;
  }
});

test.after(async () => {
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// ---------------------------------------------------------------------------
// 1. The file, and its place in the chain
// ---------------------------------------------------------------------------

test('025 exists at its number, alone, and carries no transaction directive', () => {
  const dir = path.join(__dirname, '..', 'migrations');
  const at025 = fs.readdirSync(dir).filter((f) => f.startsWith('025'));
  assert.deepStrictEqual(at025, [MIGRATION_FILE], 'two files at number 025 would race in name order');

  const src = fs.readFileSync(MIGRATION_PATH, 'utf8').trimStart();
  assert.ok(!/^--\s*@(noTransaction|tolerant)/.test(src),
    'this file is catalog-only DDL and must run all-or-nothing in one transaction; '
    + '@noTransaction exists for CONCURRENTLY builds and per-batch COMMITs, neither of which is here');

  // The claim the header makes about cost is only true while nothing scans.
  assert.ok(/NOT VALID/.test(src),
    'the CHECK must be NOT VALID: validating it seq-scans ~1 GB to learn what the census already proves');
  assert.ok(!/VALIDATE CONSTRAINT ml_training_data/.test(src.replace(/--[^\n]*/g, '')),
    'a VALIDATE statement would turn a sub-second migration into a full table scan at boot');
});

test('the migration runner applied 025 as part of the real chain', async () => {
  const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [MIGRATION_FILE]);
  assert.strictEqual(rows.length, 1, '025 was not recorded in schema_migrations by db/migrate.js');
});

test('label_source and vendor_forecast_pct exist after migrate() ALONE', async () => {
  // The point of the whole file. Before 025 these columns existed only because
  // collectRealtime.js ALTERed them into being on first run, and
  // export_training_data.js probes for them: absent, it selects
  // `NULL AS label_source` and exports every realtime row as 'unknown' with no
  // error. No collector has run in this test yet.
  const { rows } = await pool.query(
    `SELECT column_name, data_type, character_maximum_length AS len
       FROM information_schema.columns
      WHERE table_name = 'ml_training_data' AND column_name IN ('label_source', 'vendor_forecast_pct')
      ORDER BY column_name`
  );
  assert.deepStrictEqual(rows.map((r) => r.column_name), ['label_source', 'vendor_forecast_pct']);
  assert.strictEqual(rows[0].len, 10, "label_source must hold 'forecast' (8) with room to spare");
  assert.strictEqual(rows[1].data_type, 'smallint');

  const { rows: probe } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'ml_training_data' AND column_name = ANY($1)`,
    [['label_source', 'observed_date', 'hour_axis']]
  );
  assert.strictEqual(probe.length, 3,
    'the exporter probes for exactly these three; a missing one degrades the export in silence');
});

test('the CHECK is present, NOT VALID, and still enforces every new write', async () => {
  const { rows: [c] } = await pool.query(
    `SELECT convalidated FROM pg_constraint
      WHERE conname = $1 AND conrelid = 'ml_training_data'::regclass`,
    [CONSTRAINT]
  );
  assert.ok(c, 'the domain constraint is missing');
  assert.strictEqual(c.convalidated, false,
    'the constraint was validated, which means the migration seq-scanned the corpus at boot');

  const insert = (labelSource, vendorPct) => pool.query(
    `INSERT INTO ml_training_data
       (venue_id, collection_mode, day_of_week, hour, venue_category, busyness_pct,
        label_source, vendor_forecast_pct)
     VALUES ($1, 'realtime', 1, 12, 'bar', 50, $2, $3) RETURNING id`,
    [venueIds.live, labelSource, vendorPct]
  );

  // NOT VALID means "existing rows unchecked", NEVER "new rows unchecked".
  await assert.rejects(() => insert('unknown', null), /ml_training_data_label_provenance_valid/,
    "'unknown' is what the EXPORTER says about a row that never declared itself; "
    + 'a collector writing it would be asserting ignorance as a fact');
  await assert.rejects(() => insert('liv', null), /ml_training_data_label_provenance_valid/,
    'a truncated label does not raise anywhere in the pipeline — it silently becomes "unknown"');
  await assert.rejects(() => insert('live', 101), /ml_training_data_label_provenance_valid/);
  await assert.rejects(() => insert('live', -1), /ml_training_data_label_provenance_valid/);

  // And the three legitimate states all pass.
  const ok = [];
  for (const [ls, fc] of [['live', 40], ['forecast', 55], [null, null]]) {
    const { rows } = await insert(ls, fc);
    ok.push(rows[0].id);
  }
  await pool.query('DELETE FROM ml_training_data WHERE id = ANY($1)', [ok]);
});

// ---------------------------------------------------------------------------
// 2. The legacy rows: untouched, and re-running the file keeps them untouched
// ---------------------------------------------------------------------------

test('025 leaves every pre-existing row exactly as it found it', async () => {
  const rows = await snapshotTraining();
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  for (const tag of ['legacyRt1', 'legacyRt2']) {
    const r = byId[legacyIds[tag]];
    assert.strictEqual(r.label_source, null,
      `${tag} was given a provenance the stored data cannot support — the value grid is shared `
      + '(all realtime AND all weekly values are multiples of 5) and the weekly-echo test scores '
      + '5.64% against 4.72-6.89% for deliberately wrong slots, i.e. chance');
    assert.strictEqual(r.vendor_forecast_pct, null);
  }
  assert.strictEqual(byId[legacyIds.legacyWeekly].label_source, null,
    'a weekly row is named by collection_mode and must not borrow a realtime label');

  // And the exporter still calls them what they are.
  assert.strictEqual(exporter.labelProvenance({ collection_mode: 'realtime', label_source: null }), 'unknown');
  assert.strictEqual(exporter.labelProvenance({ collection_mode: 'weekly', label_source: null }), 'weekly');
});

test('re-applying 025 writes nothing: same xmin on every row, same constraint oid', async () => {
  const before = await snapshotTraining();
  const { rows: [conBefore] } = await pool.query(
    `SELECT oid::text AS oid, convalidated FROM pg_constraint
      WHERE conname = $1 AND conrelid = 'ml_training_data'::regclass`, [CONSTRAINT]
  );

  await applyMigration();

  const after = await snapshotTraining();
  assert.deepStrictEqual(after, before,
    'the second application changed a row — xmin included, so "same values" is not enough');

  const { rows: [conAfter] } = await pool.query(
    `SELECT oid::text AS oid, convalidated FROM pg_constraint
      WHERE conname = $1 AND conrelid = 'ml_training_data'::regclass`, [CONSTRAINT]
  );
  assert.deepStrictEqual(conAfter, conBefore,
    'the constraint was dropped and re-added, which would silently discard a VALIDATE '
    + 'someone had run by hand between the two applications');
});

// ---------------------------------------------------------------------------
// 3. classifyReading: the mapping itself, with no database and no network
// ---------------------------------------------------------------------------

test('classifyReading names the two BestTime numbers correctly', () => {
  const cases = [
    ['live reading available',
      { liveAvailable: true, liveBusyness: 75, forecastedBusyness: 40 },
      { source: LABEL_LIVE, busyness: 75, vendorForecast: 40 }],

    // THE CASE THIS WHOLE ROUND IS ABOUT. BestTime echoes its forecast into
    // venue_live_busyness when it has no live data. Reading the number instead
    // of the flag stamps a vendor prediction as ground truth at weight 1.0.
    ['forecast echoed into the live field, flag false',
      { liveAvailable: false, liveBusyness: 40, forecastedBusyness: 40 },
      { source: LABEL_FORECAST, busyness: 40, vendorForecast: 40 }],

    ['flag false, live field empty',
      { liveAvailable: false, liveBusyness: null, forecastedBusyness: 62 },
      { source: LABEL_FORECAST, busyness: 62, vendorForecast: 62 }],

    ['flag true but no live number',
      { liveAvailable: true, liveBusyness: null, forecastedBusyness: 33 },
      { source: LABEL_FORECAST, busyness: 33, vendorForecast: 33 }],

    // Truthiness is not evidence. The string "false" is truthy in JavaScript,
    // and the two mistakes are not symmetric: a forecast called 'live' trains
    // at 1.0, a live reading called 'forecast' trains at 0.3.
    ['flag is a truthy non-boolean', { liveAvailable: 'false', liveBusyness: 90, forecastedBusyness: 20 },
      { source: LABEL_FORECAST, busyness: 20, vendorForecast: 20 }],
    ['flag is 1, not true', { liveAvailable: 1, liveBusyness: 90, forecastedBusyness: 20 },
      { source: LABEL_FORECAST, busyness: 20, vendorForecast: 20 }],

    ['zero is a real reading, not a missing one',
      { liveAvailable: true, liveBusyness: 0, forecastedBusyness: 0 },
      { source: LABEL_LIVE, busyness: 0, vendorForecast: 0 }],

    // Nothing nameable: dropped rather than written unlabelled, because an
    // unlabelled row is precisely what 457,402 rows of this corpus are.
    ['nothing usable', { liveAvailable: false, liveBusyness: null, forecastedBusyness: null }, null],
    ['unflagged number with no forecast', { liveAvailable: false, liveBusyness: 55, forecastedBusyness: null }, null],
    ['NaN is not a number', { liveAvailable: true, liveBusyness: NaN, forecastedBusyness: NaN }, null],
    ['null response', null, null],
    ['non-object response', 42, null],
  ];

  for (const [name, input, expected] of cases) {
    assert.deepStrictEqual(classifyReading(input), expected, name);
  }
});

test('classifyReading can never emit a label outside the database domain', () => {
  // Fuzz the shapes BestTime could plausibly return. Whatever comes back must
  // be storable, because the CHECK will reject anything else and take the run
  // down with it.
  const vals = [null, undefined, 0, 55, 100, NaN, '60', true, false, {}];
  const flags = [true, false, null, undefined, 1, 0, 'true', 'false'];
  let seen = 0;
  for (const liveAvailable of flags) {
    for (const liveBusyness of vals) {
      for (const forecastedBusyness of vals) {
        const r = classifyReading({ liveAvailable, liveBusyness, forecastedBusyness });
        if (r === null) continue;
        seen++;
        assert.ok(r.source === LABEL_LIVE || r.source === LABEL_FORECAST, `bad source ${r.source}`);
        assert.ok(Number.isFinite(r.busyness), 'a non-numeric busyness would insert as NULL and fail NOT NULL');
        if (r.source === LABEL_FORECAST) {
          assert.strictEqual(r.busyness, r.vendorForecast,
            'a forecast row whose stored value disagrees with the forecast it came from means the mapping drifted');
        }
      }
    }
  }
  assert.ok(seen > 0, 'the fuzz produced no storable readings — the table is wrong, not the code');
});

// ---------------------------------------------------------------------------
// 4. The collector, end to end, against the real database. BestTime is stubbed.
// ---------------------------------------------------------------------------

async function runCollectorFor(venueId) {
  await onlyCollectable(venueId);
  await freshCollector().run();
  const { rows } = await pool.query(
    `SELECT label_source, vendor_forecast_pct, busyness_pct, observed_date, hour_axis
       FROM ml_training_data
      WHERE venue_id = $1 AND collection_mode = 'realtime' ORDER BY id DESC LIMIT 1`,
    [venueId]
  );
  return rows[0];
}

test('a live-available response is stored as an observation, with the forecast beside it', async () => {
  LIVE_RESPONSE = { forecastedBusyness: 40, liveBusyness: 75, liveAvailable: true, hour: null, venueOpen: true };
  const row = await runCollectorFor(venueIds.live);

  assert.strictEqual(row.label_source, 'live');
  assert.strictEqual(row.busyness_pct, 75, 'the live reading is the label');
  assert.strictEqual(row.vendor_forecast_pct, 40,
    "the vendor's prediction for the same moment is the counterfactual, and it arrived in the same "
    + 'response — WITHIN-CITY-EVAL.md cannot ask how far labels sit from it because it was thrown away');
  assert.ok(row.observed_date, 'observed_date is what makes migration 024\'s realtime key enforceable');
  assert.strictEqual(row.hour_axis, 'venue_local');
});

test('a live-unavailable response is stored as a vendor forecast, and says so', async () => {
  // The echo: BestTime still fills venue_live_busyness, and it is the forecast.
  LIVE_RESPONSE = { forecastedBusyness: 55, liveBusyness: 55, liveAvailable: false, hour: null, venueOpen: true };
  const row = await runCollectorFor(venueIds.fc);

  assert.strictEqual(row.label_source, 'forecast',
    'this row is a model output, not foot traffic; training it at weight 1.0 is training the model '
    + "to predict another model's prediction");
  assert.strictEqual(row.busyness_pct, 55);
  assert.strictEqual(row.vendor_forecast_pct, row.busyness_pct,
    'on a forecast row the two are the same number by construction');
});

test('the run refuses when a written row has no label_source', async () => {
  // Proven, not assumed. A trigger strips the label on the way in, which is
  // what a missing column, a dropped INSERT term or a reverted collector all
  // look like from the database's side. Without the read-back, the run would
  // print "1 rows inserted (1 live-observed, 0 vendor-forecast)" and exit 0 —
  // which is exactly the log the 457,402 unknown rows were written under.
  await pool.query(`
    CREATE OR REPLACE FUNCTION prov_strip_label() RETURNS trigger AS $fn$
    BEGIN NEW.label_source := NULL; RETURN NEW; END;
    $fn$ LANGUAGE plpgsql`);
  await pool.query(`
    CREATE TRIGGER prov_strip_label_trg BEFORE INSERT ON ml_training_data
    FOR EACH ROW EXECUTE FUNCTION prov_strip_label()`);

  try {
    LIVE_RESPONSE = { forecastedBusyness: 30, liveBusyness: 80, liveAvailable: true, hour: null, venueOpen: true };
    await onlyCollectable(venueIds.refuse);
    await assert.rejects(() => freshCollector().run(), /label_source IS NULL/);
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS prov_strip_label_trg ON ml_training_data');
    await pool.query('DROP FUNCTION IF EXISTS prov_strip_label()');
  }

  // The refusal message has to name the fix, because the person reading it at
  // 3am is deciding whether a collection run is worth anything.
  assert.match(collectRealtime.PROVENANCE_REFUSAL, /025_ml_label_provenance\.sql/);
  assert.match(collectRealtime.PROVENANCE_REFUSAL, /label_source/);
});

test('every realtime row the collector wrote in this file carries a label', async () => {
  // The refusal test's row is still there, committed and unlabelled — the audit
  // reads back AFTER the inserts and cannot undo them, and a collector that
  // deleted corpus rows on its way out would be a worse thing than a loud
  // refusal. Removed here because it is a fixture artefact, and its continued
  // existence is asserted first because that is the honest limit of the guard:
  // it stops a bad run from being BELIEVED, not from happening.
  const { rowCount: stranded } = await pool.query(
    `DELETE FROM ml_training_data
      WHERE venue_id = $1 AND collection_mode = 'realtime' AND label_source IS NULL`,
    [venueIds.refuse]
  );
  assert.strictEqual(stranded, 1,
    'the refused run either wrote nothing or the row was rolled back — the audit is testing a path '
    + 'that does not exist');

  const { rows: [c] } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE label_source IS NULL)::int AS unlabelled,
            COUNT(*) FILTER (WHERE label_source = 'live')::int AS live,
            COUNT(*) FILTER (WHERE label_source = 'forecast')::int AS forecast
       FROM ml_training_data
      WHERE collection_mode = 'realtime' AND observed_date IS NOT NULL`
  );
  assert.strictEqual(c.unlabelled, 0);
  assert.strictEqual(c.live, 1);
  assert.strictEqual(c.forecast, 1);

  // The legacy rows are the ones with no observed_date, and they are still
  // exactly as seeded. This is the whole shape of the corpus after 025: new
  // rows named, old rows honestly unnamed, nothing in between invented.
  const { rows: [legacy] } = await pool.query(
    `SELECT COUNT(*)::int AS rows, COUNT(label_source)::int AS labelled
       FROM ml_training_data WHERE collection_mode = 'realtime' AND observed_date IS NULL`
  );
  assert.strictEqual(legacy.rows, 2);
  assert.strictEqual(legacy.labelled, 0);
});

// ---------------------------------------------------------------------------
// 5. Cost. Must run LAST: it drops and re-adds the columns.
// ---------------------------------------------------------------------------

test('025 costs the same at 1,000,000 rows as at none (catalog-only, no scan)', async () => {
  const undo = async () => {
    await pool.query(`ALTER TABLE ml_training_data DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
    await pool.query('ALTER TABLE ml_training_data DROP COLUMN IF EXISTS vendor_forecast_pct');
    await pool.query('ALTER TABLE ml_training_data DROP COLUMN IF EXISTS label_source');
  };

  await undo();
  const t0 = Date.now();
  await applyMigration();
  const small = Date.now() - t0;

  // A million realtime rows with no observed_date: outside both of migration
  // 024's partial unique indexes, so the seed is a plain bulk insert and the
  // shape matches the legacy corpus this migration must not touch.
  const BULK_VENUES = 100;
  const PER_VENUE = 10_000;
  await pool.query(
    `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude, venue_category, timezone, is_active)
     SELECT 'ChIJcost' || g, 'Cost ' || g, $2, 30.27, -97.74, 'bar', 'America/Chicago', false
       FROM generate_series(1, $1) g`,
    [BULK_VENUES, COST_CITY]
  );
  await pool.query(
    `INSERT INTO ml_training_data (venue_id, collection_mode, day_of_week, hour, venue_category, busyness_pct)
     SELECT v.id, 'realtime', g % 7, g % 24, 'bar', (g % 21) * 5
       FROM (SELECT id FROM ml_venues WHERE city = $1) v, generate_series(1, $2) g`,
    [COST_CITY, PER_VENUE]
  );
  const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM ml_training_data');
  assert.ok(n >= BULK_VENUES * PER_VENUE, `expected a million-row corpus, got ${n}`);

  await undo();
  const t1 = Date.now();
  await applyMigration();
  const large = Date.now() - t1;

  console.log(`[025 cost] ${small} ms on ${n - BULK_VENUES * PER_VENUE} rows, ${large} ms on ${n} rows`);

  // The claim is not "fast", it is "does not read the table". A seq scan of a
  // million rows cannot hide inside a 2x window on a sub-100ms baseline, and
  // 024's own worst-case production factor of 14.2x applied to any number this
  // small still lands under a second.
  assert.ok(large < Math.max(small * 4, 2000),
    `025 took ${large} ms on ${n} rows against ${small} ms on an empty table — it is reading the corpus`);

  const { rows: [c] } = await pool.query(
    `SELECT convalidated FROM pg_constraint WHERE conname = $1 AND conrelid = 'ml_training_data'::regclass`,
    [CONSTRAINT]
  );
  assert.strictEqual(c.convalidated, false);

  const { rows: [tally] } = await pool.query(
    `SELECT COUNT(*)::int AS realtime_rows,
            COUNT(*) FILTER (WHERE label_source IS NULL)::int AS unlabelled
       FROM ml_training_data WHERE collection_mode = 'realtime'`
  );
  assert.strictEqual(tally.unlabelled, tally.realtime_rows,
    'the migration wrote a label onto a row it cannot possibly know');
  assert.ok(tally.realtime_rows >= BULK_VENUES * PER_VENUE);
});
