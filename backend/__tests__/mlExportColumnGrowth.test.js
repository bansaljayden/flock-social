'use strict';
// ---------------------------------------------------------------------------
// ROUND 20: THE EXPORT CONTRACT GREW FROM 42 COLUMNS TO 44, AND THE TWO NEW
// COLUMNS ARE CARRIED, NOT FEATURISED.
//
// Migration 025 added `label_source` and `vendor_forecast_pct` to
// ml_training_data. `vendor_forecast_pct` is BestTime's own forecast for the
// same moment as the label, handed over in the same response at no extra API
// call, and it is what makes a 'live' label falsifiable instead of an unbacked
// assertion. Neither column reached anything, because the export contract did
// not name them: prepare_features.py refuses any CSV that is not the contract,
// so a column the exporter does not write is a column the model can never see.
//
// This file pins the four things that growth had to get right, none of which
// the existing contract tests can see:
//
//   1. THE GROWTH IS APPEND-ONLY AND AGREED. Both new names sit at the END of
//      both lists, so no column an older reader knows changed index, and the
//      first 42 are pinned literally so a reorder cannot hide inside a passing
//      count. (mlPipelineContracts/mlExportContracts pin the count and the
//      equality; they cannot tell 44-in-a-new-order from 44.)
//   2. EMPTY IS NOT ZERO. `vendor_forecast_pct` is NULL on all 3,912,357 rows
//      in the corpus today and 0 is a legal forecast — a venue the vendor
//      expects to be empty. If those two ever collapse into each other, 3.9M
//      "nobody asked" rows silently become 3.9M "the vendor predicted empty",
//      and no count, no header check and no row-width check would notice.
//   3. A PRE-ROUND-20 CSV FAILS BY NAME. The columns are carried, not features,
//      so a 42-column CSV would still TRAIN — which is exactly why its absence
//      has to be an error. The real prepare_features.py is executed to prove
//      the refusal names both missing columns.
//   4. THEY ARE NOT FEATURES, AND THE TWO CHECK EACH OTHER. `label_provenance`
//      is a pure function of (is_realtime, label_source), so carrying the raw
//      column beside the derived one turns redundancy into a checksum; and a
//      'forecast' row whose vendor forecast differs from its own label means
//      collectRealtime.classifyReading has drifted.
//
// ZERO paid API calls. The Postgres instance is created and destroyed here; the
// Python half is skipped when pandas is unavailable, and every claim it makes
// also has a source-level pin so a skip cannot silently remove coverage.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');

// This suite boots its own embedded Postgres, so its port must be distinct from
// e2e-local.js's 59595 and from every sibling suite that does the same. It used
// to be the hardcoded 59761, which held right up until a run was killed: the
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
const PG_PORT = pickEmbeddedPgPort('mlExportColumnGrowth');
const DB_NAME = 'flock_column_growth_test';
const CONN = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;

// scripts/ml/* call dotenv.config() on backend/.env, which points at the LIVE
// Railway database. dotenv never overwrites an already-set variable, so pinning
// these before the require below guarantees nothing here can reach production.
process.env.DATABASE_URL = CONN;
process.env.PGSSLMODE = 'disable';

const TRAIN_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'train');
const PREPARE_PY_PATH = path.join(TRAIN_DIR, 'prepare_features.py');
const PREPARE_SRC = fs.readFileSync(PREPARE_PY_PATH, 'utf8');

const exporter = require('../scripts/ml/train/export_training_data');

const HEADER_COLUMNS = exporter.HEADER.split(',');
const NEW_COLUMNS = ['label_source', 'vendor_forecast_pct'];

// The 42 columns the contract carried before round 20, verbatim. Written out
// rather than derived so that "the growth was append-only" is a claim about a
// fixed historical list and not about whatever the file happens to say today.
const COLUMNS_BEFORE_ROUND_20 = [
  'venue_id',
  'day_of_week', 'hour', 'month', 'season',
  'is_holiday', 'is_school_break',
  'venue_category', 'price_level', 'rating', 'review_count',
  'temperature', 'humidity', 'wind_speed',
  'weather_condition', 'weather_condition_code', 'is_raining',
  'event_nearby', 'event_distance_km', 'event_size', 'event_type', 'event_hours_until',
  'has_nearby_event', 'nearest_event_distance_km', 'nearest_event_attendance',
  'total_nearby_events', 'total_nearby_attendance', 'nearest_event_type',
  'baseline_busyness', 'is_realtime',
  'busyness_pct',
  'city',
  'google_type_1', 'google_type_2', 'google_type_3',
  'latitude', 'longitude',
  'avg_user_crowd', 'user_feedback_count', 'avg_prediction_error',
  'observed_date', 'label_provenance',
];

function pyStringList(source, name) {
  const m = source.match(new RegExp(`^${name}[^=]*=\\s*\\[([\\s\\S]*?)^\\]`, 'm'));
  assert.ok(m, `${name} is not a multi-line list literal in the Python source`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

// ---------------------------------------------------------------------------
// 1. THE GROWTH ITSELF
// ---------------------------------------------------------------------------

test('the contract grew to 44 by APPENDING, so no existing column moved', () => {
  assert.equal(COLUMNS_BEFORE_ROUND_20.length, 42, 'the historical list is wrong');
  assert.equal(HEADER_COLUMNS.length, 44,
    'round 20 added exactly two columns: label_source and vendor_forecast_pct');
  assert.deepEqual(HEADER_COLUMNS.slice(0, 42), COLUMNS_BEFORE_ROUND_20,
    'the first 42 columns must be untouched, in their original order. A count check ' +
    'cannot tell a reorder from a clean addition, and the CSV is consumed positionally ' +
    'by anything that reads it without a header.');
  assert.deepEqual(HEADER_COLUMNS.slice(42), NEW_COLUMNS);
});

test('prepare_features.py declares the identical 44, in the identical order', () => {
  const declared = pyStringList(PREPARE_SRC, 'EXPORT_COLUMNS');
  assert.deepEqual(declared, HEADER_COLUMNS,
    'export_training_data.HEADER and prepare_features.EXPORT_COLUMNS have drifted. ' +
    'They are the same contract written twice and must be changed in the same commit.');
  assert.equal(new Set(declared).size, 44, 'a column name is repeated');
  for (const c of NEW_COLUMNS) {
    assert.equal(declared.filter((x) => x === c).length, 1,
      `${c} appears more than once in the contract`);
  }
});

test('vendor_forecast_pct is probed as optional, not assumed to exist', () => {
  // A database that has not applied migration 025 does not have the column, and
  // naming a column that does not exist is a hard SQL error — the failure mode
  // the removed `ALTER TABLE` in this file used to paper over by creating it.
  assert.ok(Object.prototype.hasOwnProperty.call(exporter.OPTIONAL_COLUMNS, 'vendor_forecast_pct'),
    'vendor_forecast_pct must be in OPTIONAL_COLUMNS so preflight() probes for it ' +
    'through information_schema');
  const absent = exporter.cityQuery('philly',
    { label_source: true, observed_date: true, hour_axis: true, vendor_forecast_pct: false });
  assert.match(absent.text, /NULL AS vendor_forecast_pct/,
    'with the column absent the export must select NULL, not error and not create it');
  const present = exporter.cityQuery('philly',
    { label_source: true, observed_date: true, hour_axis: true, vendor_forecast_pct: true });
  assert.match(present.text, /t\.vendor_forecast_pct/);
  assert.ok(!/NULL AS vendor_forecast_pct/.test(present.text));
});

test('probing for the new column added no write to a read-only script', () => {
  const src = fs.readFileSync(path.join(TRAIN_DIR, 'export_training_data.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
    .replace(/--[^\n]*/g, ' ');
  for (const re of [/\bALTER\s+TABLE\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i,
    /\bDELETE\s+FROM\b/i, /\bDROP\s+/i, /\bTRUNCATE\b/i, /\bCREATE\s+(TABLE|INDEX)\b/i]) {
    assert.ok(!re.test(src),
      `export_training_data.js contains ${re}. It is run by hand against the live ` +
      'Railway database; a missing optional column is probed, never created.');
  }
});

// ---------------------------------------------------------------------------
// 2. EMPTY IS NOT ZERO — the whole point of the column
// ---------------------------------------------------------------------------

const at = (line, name) => line.split(',')[HEADER_COLUMNS.indexOf(name)];

test('an absent vendor forecast is an EMPTY field and a zero forecast is "0"', () => {
  const base = { collection_mode: 'realtime', label_source: 'live', busyness_pct: 40 };
  const cases = [
    ['column absent from the row object', {}, ''],
    ['explicit null (every row in the corpus today)', { vendor_forecast_pct: null }, ''],
    ['explicit undefined', { vendor_forecast_pct: undefined }, ''],
    ['a real forecast of zero', { vendor_forecast_pct: 0 }, '0'],
    ['a real forecast', { vendor_forecast_pct: 45 }, '45'],
    ['pg handing back a numeric string', { vendor_forecast_pct: '45' }, '45'],
  ];
  for (const [what, over, expected] of cases) {
    const got = at(exporter.rowToCsv({ ...base, ...over }), 'vendor_forecast_pct');
    assert.equal(got, expected,
      `${what}: wrote ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}. ` +
      'A missing forecast and a forecast of zero are different facts — 0 says the vendor ' +
      'predicted an empty venue, empty says nobody asked, and 3,912,357 rows are the ' +
      'second kind. If these ever collapse, every one of them becomes a fabricated ' +
      'vendor prediction and nothing downstream can tell.');
  }
  // And the same value never reads as zero after the CSV round trip.
  assert.notEqual(at(exporter.rowToCsv({ ...base }), 'vendor_forecast_pct'), '0');

  // The third state, which is neither: a value nothing can read. It must NOT be
  // normalised to empty here — that would file it among the 3.9 million rows
  // that are legitimately empty and it would never be found. It is passed
  // through so prepare_features.py can refuse it by name.
  assert.equal(at(exporter.rowToCsv({ ...base, vendor_forecast_pct: 'n/a' }), 'vendor_forecast_pct'),
    'n/a',
    'a corrupt value and an absent one are different problems; laundering the first ' +
    'into the second is how it stops being findable');
});

test('label_source is carried RAW, and label_provenance keeps masking as before', () => {
  const line = (row) => exporter.rowToCsv(row);
  const raw = (row) => at(line(row), 'label_source');
  const derived = (row) => at(line(row), 'label_provenance');

  const live = { collection_mode: 'realtime', label_source: 'live' };
  assert.equal(raw(live), 'live');
  assert.equal(derived(live), 'live');

  const fc = { collection_mode: 'realtime', label_source: 'forecast' };
  assert.equal(raw(fc), 'forecast');
  assert.equal(derived(fc), 'forecast');

  // The 457,402 legacy rows: nothing to say, so nothing is said. Not the string
  // 'null', not 'unknown' — the derived column is where 'unknown' belongs.
  const legacy = { collection_mode: 'realtime', label_source: null };
  assert.equal(raw(legacy), '');
  assert.equal(derived(legacy), 'unknown');

  // A weekly row is named by its mode; the raw column shows what was actually
  // stored. This is the mask that made the raw column worth carrying.
  const weeklyMasked = { collection_mode: 'weekly', label_source: 'live' };
  assert.equal(derived(weeklyMasked), 'weekly');
  assert.equal(raw(weeklyMasked), 'live',
    'labelProvenance() reports weekly whatever the column says. Carrying the raw value ' +
    'is what lets prepare_features.py see that a weekly row was written with a source ' +
    'at all, instead of the fact being erased on the way out.');

  // An out-of-domain value must NOT be laundered here. Migration 025's CHECK is
  // what stops one being written; the exporter's job is to show that it was.
  const bogus = { collection_mode: 'realtime', label_source: 'Live' };
  assert.equal(derived(bogus), 'unknown',
    'the derived column has always demoted an unrecognised source to unknown — where ' +
    'it is trained at weight 1.0, which is exactly the risk');
  assert.equal(raw(bogus), 'Live',
    'the raw column must show the value that caused the demotion. Normalising it here ' +
    'would hide a database whose CHECK constraint was never applied.');
});

test('a text value in either new column still cannot shift the CSV', () => {
  const line = exporter.rowToCsv({
    collection_mode: 'realtime', label_source: 'live,forecast', vendor_forecast_pct: 12,
  });
  const fields = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { fields.push(cur); cur = ''; }
    else cur += c;
  }
  fields.push(cur);
  assert.equal(fields.length, 44);
  assert.equal(fields[HEADER_COLUMNS.indexOf('label_source')], 'live,forecast');
  assert.equal(fields[HEADER_COLUMNS.indexOf('vendor_forecast_pct')], '12');
});

// ---------------------------------------------------------------------------
// 3. CARRIED, NOT FEATURISED — source-level pins that hold even when the
//    Python half below is skipped.
// ---------------------------------------------------------------------------

test('neither new column can become a model feature', () => {
  const excludeBlock = PREPARE_SRC.match(/exclude = \{([\s\S]*?)\n    \}/);
  assert.ok(excludeBlock, 'get_feature_columns no longer builds an `exclude` set literal');
  for (const c of NEW_COLUMNS) {
    assert.ok(new RegExp(`'${c}'`).test(excludeBlock[1]),
      `${c} is not in get_feature_columns' exclude set. vendor_forecast_pct EQUALS ` +
      'busyness_pct on every forecast-sourced row by construction, so as a raw feature ' +
      'it hands the model the label on that whole slice; label_source encodes the label ' +
      'regime the way sample_weight does. Both are also empty on 100% of the corpus ' +
      'today, so today they would simply be dead slots.');
  }
});

test('the carried columns ride into both pickles, with NaN preserved', () => {
  assert.match(PREPARE_SRC, /keep_extra = \[[\s\S]*?'label_source', 'vendor_forecast_pct'\]/,
    'the holdout frame is narrowed to feature_cols + keep_extra; without these two names ' +
    'there the columns are silently dropped before the pickle is written');
  for (const frame of ['train_df', 'holdout_df']) {
    assert.ok(new RegExp(`pd\\.to_numeric\\(\\s*\\n?\\s*${frame}\\['vendor_forecast_pct'\\], errors='coerce'\\)`)
      .test(PREPARE_SRC),
      `${frame}'s vendor_forecast_pct must reach the pickle as a float with NaN intact`);
  }
  // The one thing that must never happen to them.
  assert.ok(!/\['vendor_forecast_pct'\]\.fillna\(0\)/.test(PREPARE_SRC),
    'vendor_forecast_pct must never be filled with 0 — that turns "we have no forecast" ' +
    'into "the vendor predicted an empty venue" on every row in the corpus');
  assert.match(PREPARE_SRC, /train_df\[feature_cols\] = train_df\[feature_cols\]\.fillna\(0\)/,
    'the blanket fillna(0) must stay scoped to feature_cols, which is what keeps it away ' +
    'from every carried column');
});

test('the two columns are made to check each other, and the run stops when they disagree', () => {
  assert.match(PREPARE_SRC, /def derive_label_provenance\(/,
    'label_provenance is a pure function of (is_realtime, label_source); recomputing it ' +
    'is what turns a redundant column into a checksum on the exporter');
  assert.match(PREPARE_SRC, /def audit_label_columns\(/);
  assert.match(PREPARE_SRC, /def enforce_label_contract\(/);
  const calls = [...PREPARE_SRC.matchAll(/enforce_label_contract\(\w+, '(\w+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(calls.sort(), ['holdout', 'train'],
    'both CSVs must be checked, the way the weather and calendar contracts are');
  assert.match(PREPARE_SRC, /forecast_rows_disagreeing_with_vendor/,
    "the invariant that makes a 'live' label falsifiable: on a forecast row the two " +
    'numbers came out of one variable in collectRealtime.classifyReading');
  assert.match(PREPARE_SRC, /'label_provenance_coverage'/,
    'coverage must be recorded in model_metadata.json so an artifact cannot claim a ' +
    'vendor-forecast downweight that applied to zero rows');
});

test('zero coverage is REPORTED, never a refusal', () => {
  // Both columns are empty on the whole corpus today. A gate on ABSENCE would
  // block every retrain until a fresh collection run finishes — which is
  // over-correcting, and not what this change is for. The audit half must
  // therefore be pure measurement; only the enforce half may stop the run, and
  // only on a CONTRADICTION.
  // \r?\n throughout: this file is checked out with CRLF endings on Windows.
  const body = PREPARE_SRC.match(/def audit_label_columns\([\s\S]*?\r?\n\r?\ndef /);
  assert.ok(body, 'audit_label_columns is gone');
  assert.ok(!/\braise\b/.test(body[0]),
    'audit_label_columns must only measure. Anything that stops the run belongs in ' +
    'enforce_label_contract, where a reader can see the whole list of stop conditions ' +
    'at once and check that none of them is merely "this column is empty".');
  assert.match(PREPARE_SRC, /NO realtime row names its label_source/,
    'an all-unknown corpus must produce a WARNING that says what it costs, not a stop');
});

// ---------------------------------------------------------------------------
// 4. THE REAL EXPORTER, AGAINST A REAL POSTGRES.
//
// Source pins prove the exporter INTENDS to carry the columns. Only a database
// proves a stored value arrives in the CSV, and that a NULL one arrives empty.
// ---------------------------------------------------------------------------

const PLACE = 'ChIJgrowthPhilly1';

let pg;
let pool;
let roPool;
let dataDir;
let outDir;
let venueId;

test.before(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-growth-out-'));
  dataDir = path.join(os.tmpdir(), 'flock-growth-pg-' + Date.now());
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'mlExportColumnGrowth', port: PG_PORT, databaseDir: dataDir,
  });
  // Not pg.start(): the wrapper turns embedded-postgres's bare reject() into an
  // error that names the suite, the port, and whether an orphan is holding it.
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = new Pool({ connectionString: CONN });

  const { migrate } = require('../db/migrate');
  await migrate(pool);

  const { rows } = await pool.query(
    `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude,
                            venue_category, google_types, timezone, price_level, rating, review_count)
     VALUES ($1, 'Growth Bar', 'philly', 39.95, -75.16, 'bar',
             ARRAY['bar','food'], 'America/New_York', 2, 4.5, 300)
     RETURNING id`,
    [PLACE]
  );
  venueId = rows[0].id;

  const insert = (mode, dow, hour, busyness, date, source, vendor) => pool.query(
    `INSERT INTO ml_training_data
       (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category,
        busyness_pct, month, season, observed_date, label_source, vendor_forecast_pct,
        collected_at)
     VALUES ($1, $2, 'venue_local', $3, $4, 'bar', $5, 5, 'spring', $6, $7, $8, NOW())`,
    [venueId, mode, dow, hour, busyness, date, source, vendor]
  );

  // The weekly anchor, so the realtime rows carry a real baseline.
  await insert('weekly', 5, 20, 60, null, null, null);
  // A LIVE row whose vendor counterfactual differs from the observation. This is
  // the row the whole column exists for: 90 observed against a vendor that said
  // 55 is a 35-point disagreement, and until round 19 the 55 was discarded.
  await insert('realtime', 5, 20, 90, '2026-08-16', 'live', 55);
  // A FORECAST row: the two numbers are one number, by construction.
  await insert('realtime', 5, 20, 70, '2026-08-17', 'forecast', 70);
  // A LIVE row with a vendor forecast of ZERO — the value that must not be
  // confusable with "no forecast".
  await insert('realtime', 5, 20, 25, '2026-08-18', 'live', 0);
  // A legacy row: collected before either column existed.
  await insert('realtime', 5, 20, 45, '2026-05-08', null, null);

  await pool.query('ANALYZE ml_training_data');
  await pool.query('ANALYZE ml_venues');

  roPool = new Pool({
    connectionString: CONN,
    options: '-c default_transaction_read_only=on',
  });
});

test.after(async () => {
  if (roPool) await roPool.end();
  if (pool) await pool.end();
  if (pg) await pg.stop();
  for (const dir of [dataDir, outDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.warn(`[mlExportColumnGrowth] could not remove ${dir}: ${err.message}`);
    }
  }
});

function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const header = lines[0].split(',');
  return {
    header,
    rows: lines.slice(1).map((l) => Object.fromEntries(
      l.split(',').map((v, i) => [header[i], v]))),
  };
}

test('a stored vendor forecast reaches the CSV, and a NULL one arrives empty', async () => {
  await exporter.runExport({ pool: roPool, outDir, log: () => {} });
  const csv = readCsv(path.join(outDir, 'training_data.csv'));
  assert.deepEqual(csv.header, HEADER_COLUMNS);

  const byDate = Object.fromEntries(csv.rows.filter((r) => r.is_realtime === '1')
    .map((r) => [r.observed_date, r]));
  assert.deepEqual(Object.keys(byDate).sort(),
    ['2026-05-08', '2026-08-16', '2026-08-17', '2026-08-18']);

  const live = byDate['2026-08-16'];
  assert.equal(live.label_source, 'live');
  assert.equal(live.label_provenance, 'live');
  assert.equal(live.busyness_pct, '90');
  assert.equal(live.vendor_forecast_pct, '55',
    "the counterfactual: what BestTime would have said with no live data. This is the " +
    'number WITHIN-CITY-EVAL.md section 9 wanted and could not produce, and it is now ' +
    'measurable on every future row at no extra API call.');

  const forecast = byDate['2026-08-17'];
  assert.equal(forecast.label_source, 'forecast');
  assert.equal(forecast.vendor_forecast_pct, forecast.busyness_pct,
    "on a forecast row the two are one number by construction — this is the invariant " +
    "that makes a 'live' claim falsifiable, because a 'live' row that always agreed " +
    'with its own counterfactual would expose a repeat of the round-19 bug at once');

  const zero = byDate['2026-08-18'];
  assert.equal(zero.vendor_forecast_pct, '0',
    'a genuine vendor forecast of zero must survive as 0');

  const legacy = byDate['2026-05-08'];
  assert.equal(legacy.label_source, '', 'unrecoverable, and said so by saying nothing');
  assert.equal(legacy.label_provenance, 'unknown');
  assert.equal(legacy.vendor_forecast_pct, '',
    'EMPTY, not 0. Every one of the 457,402 rows collected before 2026-08-15 looks like ' +
    'this row, and a 0 here would fabricate a vendor prediction for all of them.');

  // A weekly row describes no moment BestTime was asked about.
  const weekly = csv.rows.find((r) => r.is_realtime === '0');
  assert.equal(weekly.label_source, '');
  assert.equal(weekly.vendor_forecast_pct, '');
  assert.equal(weekly.label_provenance, 'weekly');
});

test('the export still refuses to write, with the new column selected', async () => {
  await assert.rejects(
    () => roPool.query(`UPDATE ml_training_data SET vendor_forecast_pct = 1`),
    (err) => err.code === '25006',
    'the export pool must reject writes at the server, not merely avoid them'
  );
});

test('preflight counts the coverage instead of guessing at it', async () => {
  const all = { label_source: true, observed_date: true, hour_axis: true, vendor_forecast_pct: true };
  const cov = await exporter.labelCoverage(roPool, all);
  assert.equal(Number(cov.realtime_rows), 4);
  assert.equal(Number(cov.named), 3, 'three rows name live/forecast; the legacy row does not');
  assert.equal(Number(cov.with_vendor_forecast), 3,
    'the vendor forecast of 0 must be COUNTed — COUNT(col) counts non-nulls, and a zero ' +
    'forecast is not a missing one');

  // And on a database that never applied migration 025 the census is 0, not an error.
  const none = { ...all, label_source: false, vendor_forecast_pct: false };
  const cov2 = await exporter.labelCoverage(roPool, none);
  assert.equal(Number(cov2.realtime_rows), 4);
  assert.equal(Number(cov2.named), 0);
  assert.equal(Number(cov2.with_vendor_forecast), 0);
});

test('an export from a database without migration 025 still produces 44 columns', async () => {
  // The state every restored backup and staging clone is in. The column must be
  // empty, never absent — a 43-column CSV would fail the contract check for the
  // wrong reason and send the reader looking at the exporter.
  const outDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-growth-out2-'));
  try {
    const q = exporter.cityQuery('philly',
      { label_source: false, observed_date: true, hour_axis: true, vendor_forecast_pct: false });
    const { rows } = await roPool.query(q);
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.equal(r.vendor_forecast_pct, null);
      assert.equal(r.label_source, null);
      const line = exporter.rowToCsv(r);
      assert.equal(line.split(',').length, 44);
      assert.equal(at(line, 'vendor_forecast_pct'), '');
      assert.equal(at(line, 'label_source'), '');
    }
  } finally {
    fs.rmSync(outDir2, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. THE REAL prepare_features.py, EXECUTED.
//
// The contract check, the feature exclusion and the cross-column validation are
// Python; there is no Python test runner in this repo, so they are driven
// directly. The CSVs handed to it are produced by the REAL exporter above, so
// what the Python side reads is what the JS side writes.
// ---------------------------------------------------------------------------

const PY = (() => {
  for (const bin of ['python', 'python3']) {
    const probe = spawnSync(bin, ['-c', 'import pandas, numpy'], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
})();

const DRIVER = `
import importlib.util, json, sys
from pathlib import Path
import pandas as pd

REAL, FIX = Path(sys.argv[1]), Path(sys.argv[2])
spec = importlib.util.spec_from_file_location('prepare_under_test', REAL)
mod = importlib.util.module_from_spec(spec)
sys.modules['prepare_under_test'] = mod
spec.loader.exec_module(mod)

out = {'export_columns': list(mod.EXPORT_COLUMNS)}

def attempt(name, fn):
    rec = {'raised': None, 'message': ''}
    try:
        rec['value'] = fn()
    except BaseException as err:
        rec['raised'] = type(err).__name__
        rec['message'] = str(err)
    out[name] = rec

good_path = FIX / 'good.csv'
good = pd.read_csv(good_path)

# 1. A pre-round-20 CSV must be refused BY NAME.
stale_path = FIX / 'stale.csv'
stale = pd.read_csv(stale_path)
attempt('stale_refusal',
        lambda: mod.require_export_columns(stale, stale_path, 'training_data.csv'))
attempt('good_accepted',
        lambda: mod.require_export_columns(good, good_path, 'training_data.csv'))

# 2. An absent vendor forecast must read as NaN, never as 0.
empty_rows = good[good['label_source'].isna()]
out['nan_not_zero'] = {
    'rows_with_empty_source': int(len(empty_rows)),
    'their_vendor_is_all_nan': bool(empty_rows['vendor_forecast_pct'].isna().all()),
    'any_zero_where_empty': int((empty_rows['vendor_forecast_pct'] == 0).sum()),
    'genuine_zero_rows': int((good['vendor_forecast_pct'] == 0).sum()),
    'dtype_is_numeric': bool(pd.api.types.is_numeric_dtype(good['vendor_forecast_pct'])),
}

# 3. Neither column may appear in the feature set.
frame = good.copy()
frame['some_real_feature'] = 1.0
cols = mod.get_feature_columns(frame)
out['feature_columns'] = {
    'label_source_is_a_feature': 'label_source' in cols,
    'vendor_forecast_is_a_feature': 'vendor_forecast_pct' in cols,
    'label_provenance_is_a_feature': 'label_provenance' in cols,
    'real_feature_survived': 'some_real_feature' in cols,
}

# 4. The clean corpus passes; each corruption stops the run by name.
attempt('clean_audit', lambda: mod.enforce_label_contract(
    mod.audit_label_columns(good, 'train'), 'train'))
out['clean_stats'] = mod.audit_label_columns(good, 'train')

def first_row_where(d, source):
    return d.index[(d['label_source'] == source).to_numpy()][0]

def corrupt(source, column, value):
    def go():
        d = good.copy()
        d.loc[first_row_where(d, source), column] = value
        return mod.enforce_label_contract(mod.audit_label_columns(d, 'train'), 'train')
    return go

attempt('bad_domain', corrupt('live', 'label_source', 'Live'))
attempt('provenance_mismatch', corrupt('live', 'label_provenance', 'unknown'))
attempt('forecast_disagrees', corrupt('forecast', 'vendor_forecast_pct', 3))
attempt('vendor_out_of_range', corrupt('live', 'vendor_forecast_pct', 250))

print('REPORT ' + json.dumps(out, default=str))
`;

test('prepare_features.py, run for real', {
  skip: PY ? false : 'python with pandas/numpy not available',
}, async (t) => {
  const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-growth-py-'));
  try {
    // The CSV under test is what the real exporter really wrote.
    const src = fs.readFileSync(path.join(outDir, 'training_data.csv'), 'utf8');
    fs.writeFileSync(path.join(fix, 'good.csv'), src);
    // ...and the stale one is the same corpus minus exactly round 20's columns.
    const stale = src.split('\n').filter(Boolean)
      .map((l) => l.split(',').slice(0, 42).join(',')).join('\n') + '\n';
    fs.writeFileSync(path.join(fix, 'stale.csv'), stale);

    const driver = path.join(fix, 'drive.py');
    fs.writeFileSync(driver, DRIVER);
    const r = spawnSync(PY, [driver, PREPARE_PY_PATH, fix], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const line = r.stdout.split('\n').find((l) => l.startsWith('REPORT '));
    assert.ok(line, `no report from the driver:\n${r.stdout}\n${r.stderr}`);
    const rep = JSON.parse(line.slice(7));

    await t.test('EXPORT_COLUMNS as Python actually parses it', () => {
      assert.deepEqual(rep.export_columns, HEADER_COLUMNS,
        'the source-level pin reads the list out of the text; this reads it out of the ' +
        'interpreter, which is the list that will actually be enforced');
    });

    await t.test('a pre-round-20 CSV is refused, naming both missing columns', () => {
      assert.equal(rep.stale_refusal.raised, 'CorpusContractError',
        'a 42-column CSV must not be accepted. The two new columns are CARRIED, so such ' +
        'a file would train perfectly well — which is exactly why it has to stop here: ' +
        'a CSV that predates the exporter is never only missing the columns you noticed.');
      for (const c of NEW_COLUMNS) {
        assert.ok(rep.stale_refusal.message.includes(c),
          `the refusal does not name ${c}. "Missing 2 columns" sends the reader looking; ` +
          'naming them ends the search.');
      }
      assert.ok(/44/.test(rep.stale_refusal.message),
        'the message must state the contract width the exporter writes');
      assert.equal(rep.good_accepted.raised, null,
        'the current export must pass its own contract check');
    });

    await t.test('an absent forecast is NaN, and a real zero is zero', () => {
      const n = rep.nan_not_zero;
      assert.ok(n.rows_with_empty_source > 0, 'the fixture must contain legacy rows');
      assert.equal(n.their_vendor_is_all_nan, true,
        'pandas must read the empty field as NaN. If it ever reads as 0, every one of ' +
        'the 3,912,357 rows in the corpus becomes a fabricated vendor prediction of ' +
        '"empty venue" and no shape check anywhere would notice.');
      assert.equal(n.any_zero_where_empty, 0);
      assert.equal(n.genuine_zero_rows, 1,
        'the one row with a real vendor forecast of 0 must still be 0');
      assert.equal(n.dtype_is_numeric, true);
    });

    await t.test('neither carried column is offered to the model', () => {
      const f = rep.feature_columns;
      assert.equal(f.label_source_is_a_feature, false);
      assert.equal(f.vendor_forecast_is_a_feature, false,
        'vendor_forecast_pct equals busyness_pct on every forecast-sourced row, so as a ' +
        'raw feature it is the label. It is also empty on 100% of the corpus today, ' +
        'which would make it the twelfth dead slot of 106.');
      assert.equal(f.label_provenance_is_a_feature, false, 'unchanged from round 10');
      assert.equal(f.real_feature_survived, true,
        'the exclusion must be by name, not by having broken get_feature_columns');
    });

    await t.test('the clean corpus passes and reports honest coverage', () => {
      assert.equal(rep.clean_audit.raised, null,
        `a valid export must not raise: ${rep.clean_audit.message}`);
      const s = rep.clean_stats;
      assert.equal(s.realtime_rows, 4);
      assert.equal(s.label_source_named, 3);
      assert.equal(s.vendor_forecast_present, 3,
        'three of four realtime rows carry a forecast — including the one whose forecast ' +
        'is 0, which a truthiness test would have dropped');
      assert.equal(s.label_provenance_mismatches, 0);
      assert.equal(s.forecast_rows_disagreeing_with_vendor, 0);
      assert.equal(s.label_source_empty_on_realtime, 1);
      // Both columns describe realtime rows only, so the weekly row must not
      // count against coverage. On the real corpus, which is 88% weekly, a
      // whole-frame denominator would hold the reported coverage near zero
      // forever and the day it stops being zero would never be visible.
      assert.equal(s.label_source_on_non_realtime_rows, 0);
      assert.equal(s.vendor_forecast_on_non_realtime_rows, 0);
      assert.equal(s.vendor_forecast_present_pct_of_realtime, 75,
        '3 of 4 realtime rows, not 3 of 5 total');
    });

    await t.test('each way the two columns can disagree stops the run by name', () => {
      const expected = {
        bad_domain: /outside the domain/,
        provenance_mismatch: /label_provenance/,
        forecast_disagrees: /vendor_forecast_pct differs/,
        vendor_out_of_range: /outside 0-100/,
      };
      for (const [name, re] of Object.entries(expected)) {
        assert.equal(rep[name].raised, 'CorpusContractError',
          `${name}: the run continued. Every one of these is silent if ignored — an ` +
          "out-of-domain label_source simply reappears as 'unknown' and rejoins the " +
          'weight-1.0 pool, which is the defect round 19 was written about.');
        assert.match(rep[name].message, re, `${name}: the message does not name the problem`);
      }
    });
  } finally {
    fs.rmSync(fix, { recursive: true, force: true });
  }
});
