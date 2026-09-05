'use strict';
// ---------------------------------------------------------------------------
// THE TWO ENDS OF THE RETRAIN PIPELINE, against real systems.
//
// scripts/ml/train/export_training_data.js turns the production database into
// the CSV every later step reads, and scripts/ml/train/export_model.py turns the
// trained model into the ONNX artifact services/mlPredictor.js loads. Neither
// had ever been reviewed. Between them they own four things that cannot be
// checked by reading:
//
//   1. the 45-column contract prepare_features.py refuses to run without;
//   2. `baseline_busyness` — this is a DELTA model, so the anchor the export
//      writes IS the answer, and it must equal the anchor buildBaselines.js
//      puts in ml_venue_baselines for mlPredictor to add the delta to;
//   3. the hour axis: after migration 023 a weekly row that does not declare
//      `hour_axis = 'venue_local'` holds a BestTime array index six hours off
//      the venue clock, and it must not reach the CSV;
//   4. FEATURE ORDER. The ONNX graph consumes positions; metadata.feature_names
//      is the only record of what each position means. If those two lists ever
//      disagree in ORDER, every width check in the stack still passes,
//      onnxruntime does not throw, and every served number is built from a
//      shuffled vector. That case is reproduced below against the real
//      mlPredictor.verifyModelShape — it returns NO problems — which is exactly
//      why export_model.py has to be the thing that catches it.
//
// So: a real Postgres (the repo's embedded-postgres dev dependency, the full
// migration chain via db/migrate.js) for the exporter, and the real Python
// export driven against a synthetic model fixture for the ONNX side. ZERO paid
// API calls; the database is created and destroyed here.
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
// to be the hardcoded 59723, which held right up until a run was killed: the
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
const PG_PORT = pickEmbeddedPgPort('mlExportContracts');
const DB_NAME = 'flock_export_test';
const CONN = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;

// scripts/ml/* call dotenv.config() on backend/.env, which points at the LIVE
// Railway database. dotenv never overwrites an already-set variable, so pinning
// these before any require below guarantees nothing here can reach production.
process.env.DATABASE_URL = CONN;
process.env.PGSSLMODE = 'disable';

const TRAIN_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'train');
const EXPORT_JS_PATH = path.join(TRAIN_DIR, 'export_training_data.js');
const EXPORT_PY_PATH = path.join(TRAIN_DIR, 'export_model.py');
const EXPORT_JS_SRC = fs.readFileSync(EXPORT_JS_PATH, 'utf8');
const EXPORT_PY_SRC = fs.readFileSync(EXPORT_PY_PATH, 'utf8');
const PREPARE_SRC = fs.readFileSync(path.join(TRAIN_DIR, 'prepare_features.py'), 'utf8');

// Safe to require now, and that is itself part of the fix: this module used to
// run dotenv against backend/.env and construct a pg Pool at import time.
const exporter = require('../scripts/ml/train/export_training_data');
const buildBaselines = require('../scripts/ml/buildBaselines');
const mlPredictor = require('../services/mlPredictor');

const HEADER_COLUMNS = exporter.HEADER.split(',');

// ---------------------------------------------------------------------------
// 1. THE COLUMN CONTRACT — no database needed.
//
// mlPipelineContracts.test.js already pins HEADER against prepare_features.py's
// EXPORT_COLUMNS list. What nothing pinned is the OTHER half: that rowToCsv
// emits those columns, in that order, that many of them. A field added to the
// header and forgotten in the row builder shifts every column after it by one
// and still produces a file prepare_features accepts.
// ---------------------------------------------------------------------------

function pyStringList(source, name) {
  const m = source.match(new RegExp(`^${name}[^=]*=\\s*\\[([\\s\\S]*?)^\\]`, 'm'));
  assert.ok(m, `${name} is not a multi-line list literal in the Python source`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('the exporter writes exactly the 45 columns prepare_features.py demands', () => {
  assert.equal(HEADER_COLUMNS.length, 45);
  assert.deepEqual(HEADER_COLUMNS, pyStringList(PREPARE_SRC, 'EXPORT_COLUMNS'),
    'export HEADER and prepare_features.EXPORT_COLUMNS have drifted — the contract ' +
    'check exists precisely so these two agree');
  assert.equal(new Set(HEADER_COLUMNS).size, 45, 'a column name is repeated');
});

test('rowToCsv emits one field per header column, in the header order', () => {
  // Values chosen so every field is DISTINCT and identifiable by position: a
  // reordering or a dropped field cannot look like a pass.
  const row = {
    venue_id: 1, day_of_week: 2, hour: 3, month: 4, season: 'spring',
    is_holiday: true, is_school_break: false,
    venue_category: 'bar', price_level: 5, rating: 4.5, review_count: 6,
    temperature: 7.5, humidity: 8, wind_speed: 9.5,
    weather_condition: 'few clouds', weather_condition_code: 801, is_raining: false,
    event_nearby: true, event_distance_km: 10, event_size: 11, event_type: 'music',
    event_hours_until: 12,
    has_nearby_event: true, nearest_event_distance_km: 13, nearest_event_attendance: 14,
    total_nearby_events: 15, total_nearby_attendance: 16, nearest_event_type: 'sports',
    baseline_busyness: 17, collection_mode: 'realtime', busyness_pct: 18,
    city: 'philly', google_types: ['bar', 'food', 'point_of_interest'],
    latitude: 39.95, longitude: -75.16,
    avg_user_crowd: 19, user_feedback_count: 20, avg_prediction_error: 21,
    stored_observed_date: '2026-05-10', label_source: 'live',
  };
  const fields = exporter.rowToCsv(row).split(',');
  assert.equal(fields.length, HEADER_COLUMNS.length,
    `rowToCsv wrote ${fields.length} fields for a ${HEADER_COLUMNS.length}-column header`);

  const at = (name) => fields[HEADER_COLUMNS.indexOf(name)];
  assert.equal(at('venue_id'), '1');
  assert.equal(at('hour'), '3');
  assert.equal(at('season'), 'spring');
  assert.equal(at('is_holiday'), '1');
  assert.equal(at('is_school_break'), '0');
  assert.equal(at('weather_condition_code'), '801');
  assert.equal(at('baseline_busyness'), '17');
  assert.equal(at('is_realtime'), '1');
  assert.equal(at('busyness_pct'), '18');
  assert.equal(at('google_type_1'), 'bar');
  assert.equal(at('google_type_3'), 'point_of_interest');
  assert.equal(at('observed_date'), '2026-05-10');
  assert.equal(at('label_provenance'), 'live');
});

test('a comma, a quote or a newline in a text column cannot shift the columns', () => {
  const row = {
    collection_mode: 'weekly', google_types: ['a,b', 'c"d', 'e\nf'],
    venue_category: 'bar, grill', weather_condition: 'rain "heavy"',
    city: 'nyc', nearest_event_type: 'arts\r\nmusic',
  };
  const line = exporter.rowToCsv(row);
  // Parse it the way a CSV reader does, not by splitting on commas.
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
  assert.equal(fields.length, HEADER_COLUMNS.length);
  assert.equal(fields[HEADER_COLUMNS.indexOf('google_type_1')], 'a,b');
  assert.equal(fields[HEADER_COLUMNS.indexOf('google_type_2')], 'c"d');
  assert.equal(fields[HEADER_COLUMNS.indexOf('venue_category')], 'bar, grill');
  assert.equal(fields[HEADER_COLUMNS.indexOf('nearest_event_type')], 'arts\r\nmusic',
    'a lone CR breaks a CSV reader the same way a LF does and must be quoted');
});

test('label provenance never claims more confidence than the row has', () => {
  const p = exporter.labelProvenance;
  assert.equal(p({ collection_mode: 'weekly', label_source: 'live' }), 'weekly',
    'a weekly snapshot is never a live observation, whatever label_source says');
  assert.equal(p({ collection_mode: 'realtime', label_source: 'live' }), 'live');
  assert.equal(p({ collection_mode: 'realtime', label_source: 'forecast' }), 'forecast',
    'a vendor forecast must be distinguishable — it is weighted 0.3, not 1.0');
  assert.equal(p({ collection_mode: 'realtime', label_source: null }), 'unknown');
  assert.equal(p({ collection_mode: 'realtime', label_source: 'nonsense' }), 'unknown');
});

// ---------------------------------------------------------------------------
// 2. READ-ONLY AGAINST PRODUCTION — source-level.
//
// This script is run by hand against the live Railway database. It opened with
// `ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS label_source ...` —
// DDL, on production, from a script whose entire job is to read.
// ---------------------------------------------------------------------------

// Comments in this file DESCRIBE the ALTER TABLE that was removed, so the scan
// below runs on code with every comment form stripped out.
const EXPORT_JS_CODE = EXPORT_JS_SRC
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ')
  .replace(/--[^\n]*/g, ' ');

test('the exporter contains no statement that writes', () => {
  const banned = [
    /\bALTER\s+TABLE\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i,
    /\bDELETE\s+FROM\b/i, /\bDROP\s+/i, /\bTRUNCATE\b/i, /\bCREATE\s+(TABLE|INDEX)\b/i,
  ];
  for (const re of banned) {
    assert.ok(!re.test(EXPORT_JS_CODE),
      `export_training_data.js contains ${re} — it is run against production by hand ` +
      'and must only ever read. A missing optional column is probed through ' +
      'information_schema, not created.');
  }
  assert.match(EXPORT_JS_SRC, /default_transaction_read_only=on/,
    'the connection must be opened read-only so a stray write is a server error');
  assert.match(EXPORT_JS_SRC, /BEGIN READ ONLY/);
  assert.match(EXPORT_JS_SRC, /information_schema\.columns/);
});

test('the exporter streams through a cursor instead of buffering a city', () => {
  assert.match(EXPORT_JS_SRC, /DECLARE \$\{name\} NO SCROLL CURSOR FOR/,
    'a plain pool.query() materialises every row of a city as a JS object before ' +
    'one byte is written; the largest city is hundreds of thousands of rows');
  assert.match(EXPORT_JS_SRC, /FETCH FORWARD \$\{FETCH_SIZE\} FROM/);
  assert.ok(!/for \(const row of rows\) \{\s*stream\.write/.test(EXPORT_JS_SRC),
    'the synchronous unbounded write loop is back — it never yields, so the whole ' +
    'file accumulates in the WriteStream buffer');
  assert.match(EXPORT_JS_SRC, /stream\.once\('drain'/,
    'write() backpressure must be awaited');
});

test('a partial export can never be left where prepare_features.py will read it', () => {
  assert.match(EXPORT_JS_SRC, /\.partial/);
  assert.match(EXPORT_JS_SRC, /fs\.renameSync\(trainTmp, trainPath\)/,
    'the CSV must only appear at its real path once it is complete: a truncated file ' +
    'still has the right header and the right 45 columns, so the contract check ' +
    'passes and the retrain runs on a silently shortened corpus');
});

// ---------------------------------------------------------------------------
// 3. THE EXPORTER AGAINST A REAL POSTGRES.
// ---------------------------------------------------------------------------

const PHILLY_PLACE = 'ChIJexportPhilly1';   // train city
const MIAMI_PLACE = 'ChIJexportMiami1';     // holdout city
const NOBASE_PLACE = 'ChIJexportNoBase1';   // realtime rows, no weekly coverage

let pg;
let pool;        // writable — fixtures and buildBaselines
let roPool;      // what the export actually runs on
let dataDir;
let outDir;
const venueIds = {};

const T = (s) => new Date(s);

// The weekly corpus: one row per (venue, dow, hour) — migration 024's unique
// key — so ml_venue_baselines.baseline for a slot is exactly this number.
const WEEKLY = [
  { venue: 'philly', dow: 5, hour: 20, busyness: 60 },
  { venue: 'philly', dow: 5, hour: 21, busyness: 70 },
  { venue: 'philly', dow: 5, hour: 22, busyness: 40 },
  { venue: 'philly', dow: 2, hour: 12, busyness: 0 },   // closed hour: anchor 0
  { venue: 'miami', dow: 6, hour: 19, busyness: 55 },
];

// Realtime rows. The pair at (5, 20) is the load-bearing fixture: two live
// observations of ONE slot, 20 points apart. Under the round-13 leave-one-out
// anchor (computed across BOTH modes) each of them would have been anchored
// partly on the OTHER one — a different number per row, and a number production
// cannot compute. Under the production definition both are anchored on 60.
const REALTIME = [
  { venue: 'philly', dow: 5, hour: 20, busyness: 90, date: '2026-05-08', source: 'live' },
  { venue: 'philly', dow: 5, hour: 20, busyness: 70, date: '2026-05-15', source: 'live' },
  { venue: 'philly', dow: 5, hour: 21, busyness: 75, date: '2026-05-08', source: 'forecast' },
  { venue: 'miami', dow: 6, hour: 19, busyness: 80, date: '2026-05-09', source: 'live' },
  { venue: 'nobase', dow: 3, hour: 18, busyness: 44, date: '2026-05-06', source: 'live' },
];

const BULK_VENUES = 200;   // x 168 slots = 33,600 weekly rows, > FETCH_SIZE

function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);
  const header = lines[0].split(',');
  return {
    header,
    rows: lines.slice(1).map((line) => {
      const parts = line.split(',');
      return Object.fromEntries(header.map((h, i) => [h, parts[i]]));
    }),
  };
}

const dbAvailable = { ok: false, reason: '' };

test.before(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-export-out-'));
  dataDir = path.join(os.tmpdir(), 'flock-export-pg-' + Date.now());
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'mlExportContracts', port: PG_PORT, databaseDir: dataDir,
  });
  // Not pg.start(): the wrapper turns embedded-postgres's bare reject() into an
  // error that names the suite, the port, and whether an orphan is holding it.
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = new Pool({ connectionString: CONN });

  const { migrate } = require('../db/migrate');
  await migrate(pool);

  // `label_source` is NOT in the migration chain — collectRealtime.js creates it
  // with its own ADD COLUMN IF NOT EXISTS on first run. That is precisely what
  // the exporter's `ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS
  // label_source` was covering for: DDL on production, from a read-only script,
  // to avoid a hard SQL error on a database where the collector had not run.
  // The fix is to probe instead, so both states are exercised: here the column
  // exists (the collector has run), and the optional-column test below runs the
  // query as though it did not.
  await pool.query(`ALTER TABLE ml_training_data ADD COLUMN IF NOT EXISTS label_source VARCHAR(10)`);

  for (const [key, place, city, name] of [
    ['philly', PHILLY_PLACE, 'philly', 'Export Bar'],
    ['miami', MIAMI_PLACE, 'miami', 'Holdout Bar'],
    ['nobase', NOBASE_PLACE, 'philly', 'No Baseline Bar'],
  ]) {
    const { rows } = await pool.query(
      `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude,
                              venue_category, google_types, timezone, price_level, rating, review_count)
       VALUES ($1, $2, $3, 39.95, -75.16, 'bar', ARRAY['bar','food','point_of_interest'],
               'America/New_York', 2, 4.5, 300)
       RETURNING id`,
      [place, name, city]
    );
    venueIds[key] = rows[0].id;
  }

  const insert = (r, mode) => pool.query(
    `INSERT INTO ml_training_data
       (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category,
        busyness_pct, month, season, temperature, weather_condition,
        observed_date, label_source, collected_at)
     VALUES ($1, $2, 'venue_local', $3, $4, 'bar', $5, 5, 'spring', 20.0, 'few clouds',
             $6, $7, $8)`,
    [venueIds[r.venue], mode, r.dow, r.hour, r.busyness,
      r.date ?? null, r.source ?? null, T('2026-05-20T12:00:00Z')]
  );
  for (const r of WEEKLY) await insert(r, 'weekly');
  for (const r of REALTIME) await insert(r, 'realtime');

  // Round 26: one live row carrying the legacy event type eventService.js wrote
  // until 2026-09-04. The exporter must carry it AS STORED (the raw corpus is
  // not to look cleaner than it is) and its preflight census must name it.
  const { rows: evented } = await pool.query(
    `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude,
                            venue_category, google_types, timezone, price_level, rating, review_count)
     VALUES ('ChIJexportEvented1', 'Concert Bar', 'philly', 39.95, -75.16, 'bar',
             ARRAY['bar'], 'America/New_York', 2, 4.5, 300)
     RETURNING id`
  );
  venueIds.evented = evented[0].id;
  await pool.query(
    `INSERT INTO ml_training_data
       (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category,
        busyness_pct, month, season, temperature, weather_condition,
        observed_date, label_source, collected_at,
        has_nearby_event, total_nearby_events, nearest_event_attendance,
        nearest_event_distance_km, nearest_event_type, events_observed)
     VALUES ($1, 'realtime', 'venue_local', 5, 21, 'bar', 85, 9, 'fall', 71.0, 'clear sky',
             '2026-09-02', 'live', $2, true, 1, NULL, 0.8, 'concert', true)`,
    [venueIds.evented, T('2026-09-02T01:00:00Z')]
  );

  // A bulk city so the cursor has to FETCH more than once.
  const { rows: bulk } = await pool.query(
    `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude,
                            venue_category, google_types, timezone)
     SELECT 'ChIJbulk' || g, 'Bulk ' || g, 'austin', 30.27, -97.74, 'restaurant',
            ARRAY['restaurant'], 'America/Chicago'
       FROM generate_series(1, $1) g
     RETURNING id`,
    [BULK_VENUES]
  );
  await pool.query(
    `INSERT INTO ml_training_data
       (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category,
        busyness_pct, month, season, collected_at)
     SELECT v, 'weekly', 'venue_local', d, h, 'restaurant', (d * 7 + h) % 101, 5, 'spring', NOW()
       FROM unnest($1::int[]) v,
            generate_series(0, 6) d,
            generate_series(0, 23) h`,
    [bulk.map((r) => r.id)]
  );

  // Without statistics the planner turns the baseline aggregate into a nested
  // loop and the fixture export takes ~17s instead of ~1s. Production has
  // statistics; a test that does not is measuring the wrong thing.
  await pool.query('ANALYZE ml_training_data');
  await pool.query('ANALYZE ml_venues');
  await pool.query('ANALYZE venue_feedback');

  // ml_venue_baselines built by the ONE writer production uses.
  const refresh = await buildBaselines.refreshCollectedBaselines(pool);
  assert.equal(refresh.ok, true, 'the fixture corpus must be baseline-buildable');

  roPool = new Pool({
    connectionString: CONN,
    options: '-c default_transaction_read_only=on',
  });
  dbAvailable.ok = true;
});

test.after(async () => {
  if (roPool) await roPool.end();
  if (pool) await pool.end();
  if (pg) await pg.stop();
  // Windows holds the cluster's files open for a moment after pg_ctl returns,
  // so a plain rmSync races it and throws EPERM. Retry, and never let cleanup
  // of a temp directory be the thing that fails a test run.
  for (const dir of [dataDir, outDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      console.warn(`[mlExportContracts] could not remove ${dir}: ${err.message}`);
    }
  }
});

const quiet = () => {};

test('the export runs to completion on a READ-ONLY connection', async () => {
  const result = await exporter.runExport({ pool: roPool, outDir, log: quiet });
  assert.ok(result.trainCount > 0 && result.holdoutCount > 0);

  // And the same connection genuinely refuses to write, so "no writes" is a
  // property of the session, not of the reader's attention.
  await assert.rejects(
    () => roPool.query(`INSERT INTO ml_venue_baselines (google_place_id, day_of_week, hour, baseline)
                        VALUES ('x', 0, 0, 1)`),
    (err) => err.code === '25006',
    'the export pool must reject writes at the server (25006), not merely avoid them'
  );
});

test('every exported row carries 45 fields under the exact header', () => {
  for (const file of ['training_data.csv', 'holdout_data.csv']) {
    const csv = readCsv(path.join(outDir, file));
    assert.deepEqual(csv.header, HEADER_COLUMNS, `${file}: header`);
    for (const line of fs.readFileSync(path.join(outDir, file), 'utf8')
      .split('\n').filter(Boolean)) {
      assert.equal(line.split(',').length, 45, `${file}: a row with the wrong field count`);
    }
  }
});

test('the holdout cities are whole cities, in the holdout file only', () => {
  const train = readCsv(path.join(outDir, 'training_data.csv'));
  const hold = readCsv(path.join(outDir, 'holdout_data.csv'));
  assert.deepEqual([...new Set(hold.rows.map((r) => r.city))].sort(), ['miami']);
  assert.ok(!train.rows.some((r) => exporter.HOLDOUT_CITIES.includes(r.city)),
    'a holdout city leaked into the training file — the split is city-level by design');
  assert.ok(train.rows.some((r) => r.city === 'philly'));
});

// ── The anchor. This is a delta model; the anchor IS the answer. ────────────

test('baseline_busyness equals ml_venue_baselines, row for row', async () => {
  const { rows: stored } = await pool.query(
    `SELECT google_place_id, day_of_week, hour, baseline FROM ml_venue_baselines`
  );
  const key = (p, d, h) => `${p}|${d}|${h}`;
  const table = new Map(stored.map((r) => [key(r.google_place_id, r.day_of_week, r.hour), Number(r.baseline)]));

  const { rows: venues } = await pool.query(`SELECT id, google_place_id FROM ml_venues`);
  const placeOf = new Map(venues.map((v) => [String(v.id), v.google_place_id]));

  let checked = 0;
  for (const file of ['training_data.csv', 'holdout_data.csv']) {
    for (const r of readCsv(path.join(outDir, file)).rows) {
      const place = placeOf.get(r.venue_id);
      const expected = table.get(key(place, Number(r.day_of_week), Number(r.hour))) ?? 0;
      assert.equal(Number(r.baseline_busyness), expected,
        `venue ${place} dow ${r.day_of_week} hour ${r.hour}: the exporter anchored the ` +
        `delta label on ${r.baseline_busyness} while mlPredictor.getBaseline will serve ` +
        `${expected}. A delta model reconstructs score = baseline + clamp(delta), so any ` +
        'gap here is a systematic error on every prediction — and one the ship gate ' +
        'cannot see, because it compares baseline+delta against the same baseline.');
      checked++;
    }
  }
  assert.ok(checked > 30000, `only ${checked} rows compared`);
});

test('a realtime row is never anchored on any realtime label, its own or a sibling\'s', () => {
  const rows = readCsv(path.join(outDir, 'training_data.csv')).rows
    .filter((r) => r.venue_id === String(venueIds.philly) && r.is_realtime === '1'
      && r.day_of_week === '5' && r.hour === '20');
  assert.equal(rows.length, 2, 'both observations of the slot must be exported');
  const busyness = rows.map((r) => Number(r.busyness_pct)).sort((a, b) => a - b);
  assert.deepEqual(busyness, [70, 90]);
  for (const r of rows) {
    assert.equal(Number(r.baseline_busyness), 60,
      'both rows must be anchored on the WEEKLY value (60), which is what ' +
      'ml_venue_baselines holds. Round 13 computed this leave-one-out across BOTH ' +
      'collection modes, so these two rows would have been anchored on 70 and 90 ' +
      "respectively — each on the other's label, a near-label the serving path can " +
      'never compute. Self-exclusion was not the whole leak; sibling-inclusion was.');
  }
  // The delta labels these rows carry, stated so a change is visible:
  assert.deepEqual(rows.map((r) => Number(r.busyness_pct) - Number(r.baseline_busyness)).sort(),
    [10, 30]);
});

test('a weekly row is anchored on the number production stores for its slot', () => {
  const rows = readCsv(path.join(outDir, 'training_data.csv')).rows
    .filter((r) => r.venue_id === String(venueIds.philly) && r.is_realtime === '0');
  const at = (d, h) => rows.find((r) => r.day_of_week === String(d) && r.hour === String(h));
  // delta == 0: the v2.3.1 "most moments are typical" anchor, weight 0.05.
  assert.equal(at(5, 20).baseline_busyness, '60');
  assert.equal(at(5, 20).busyness_pct, '60');
  // A closed hour anchors at 0 and prepare_features' baseline>0 filter drops it,
  // exactly as production routes a baseline-less venue to the rule engine.
  assert.equal(at(2, 12).baseline_busyness, '0');
});

test('a venue with no weekly coverage exports anchor 0, not a borrowed number', () => {
  const rows = readCsv(path.join(outDir, 'training_data.csv')).rows
    .filter((r) => r.venue_id === String(venueIds.nobase));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].baseline_busyness, '0',
    'no weekly row for the slot means no prior; production would route this venue to ' +
    'the rule engine and prepare_features drops the row');
});

test('observed_date comes from the stored column, and weekly rows have none', () => {
  const rows = readCsv(path.join(outDir, 'training_data.csv')).rows
    .filter((r) => r.venue_id === String(venueIds.philly));
  const rt = rows.filter((r) => r.is_realtime === '1').map((r) => r.observed_date).sort();
  assert.deepEqual(rt, ['2026-05-08', '2026-05-08', '2026-05-15'],
    'collectRealtime stamps observed_date and migration 024 keys the realtime unique ' +
    'index on it — the stored value is authoritative, not a recomputation');
  for (const r of rows.filter((r) => r.is_realtime === '0')) {
    assert.equal(r.observed_date, '',
      'a weekly row is a synthetic typical week; its insert time is not an observation date');
  }
});

test('label_provenance survives the round trip through the database', () => {
  const rows = readCsv(path.join(outDir, 'training_data.csv')).rows
    .filter((r) => r.venue_id === String(venueIds.philly));
  const counts = {};
  for (const r of rows) counts[r.label_provenance] = (counts[r.label_provenance] || 0) + 1;
  assert.equal(counts.live, 2);
  assert.equal(counts.forecast, 1,
    'a vendor forecast must arrive labelled — prepare_features weights it 0.3, not 1.0');
  assert.equal(counts.weekly, 4);
});

// ── Round 26: the event-type vocabulary ─────────────────────────────────────

test('a legacy event type is carried as stored, and the preflight census names it', async () => {
  // eventService.js wrote 'concert' for the Music segment until 2026-09-04 and
  // collectRealtime.js copied it into nearest_event_type from 2026-09-01: 1,964
  // live rows in production carry it. The CSV must carry the value AS STORED,
  // because the exporter normalising it would leave the raw corpus looking
  // cleaner than it is; the mapping (concert -> music, by the fixed function's
  // own reading) lives in prepare_features.py, which is pinned separately.
  const rows = readCsv(path.join(outDir, 'training_data.csv')).rows
    .filter((r) => r.venue_id === String(venueIds.evented));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].nearest_event_type, 'concert',
    'the exporter must not launder a stored event type — the census is what names it');
  assert.equal(rows[0].has_nearby_event, '1');
  assert.equal(rows[0].events_observed, '1');
  assert.equal(rows[0].nearest_event_attendance, '',
    'an unpublished capacity is NULL and must reach the CSV as the empty field, not 0');

  const lines = [];
  const pre = await exporter.preflight(roPool, (l) => lines.push(l));
  assert.deepEqual(pre.eventTypes.outside, [{ type: 'concert', rows: 1 }],
    'the census must single out the value the etype one-hot cannot describe');
  assert.ok(lines.some((l) => /outside the etype vocabulary/.test(l) && /concert \(1\)/.test(l)),
    'the export must say, before it starts, which stored values fall outside the vocabulary');
  assert.ok(lines.some((l) => /concert -> music, film -> other/.test(l)),
    'and name the two legacy readings prepare_features.py applies');
});

test('the census sees the value through whitespace and case, and only the vocabulary passes', async () => {
  const seen = await exporter.eventTypeCensus({
    query: async () => ({ rows: [
      { type: 'music', rows: '10' }, { type: ' Sports ', rows: '2' },
      { type: 'concert', rows: '3' }, { type: 'rave', rows: '1' },
    ] }),
  });
  assert.deepEqual(seen.outside.map((v) => v.type), ['concert', 'rave']);
  assert.deepEqual(seen.values.map((v) => v.rows), [10, 2, 3, 1], 'bigint counts arrive as numbers');
});

test('a city larger than one cursor FETCH is exported whole', () => {
  const rows = readCsv(path.join(outDir, 'training_data.csv')).rows
    .filter((r) => r.city === 'austin');
  assert.equal(rows.length, BULK_VENUES * 168,
    'the cursor loop dropped or duplicated rows across FETCH boundaries');
  assert.ok(rows.length > exporter.FETCH_SIZE,
    'the bulk fixture must exceed one FETCH or this test proves nothing');
});

// ── The hour axis ───────────────────────────────────────────────────────────

test('an undeclared or legacy-axis weekly row stops the export dead', async () => {
  // Reconstruct the pre-023 state. The CHECK constraints 023 added make this
  // impossible through normal writes, which is the point — they are dropped
  // here to reproduce a corpus that predates them.
  await pool.query('ALTER TABLE ml_training_data DROP CONSTRAINT ml_training_data_weekly_axis_declared');
  await pool.query(
    `INSERT INTO ml_training_data (venue_id, collection_mode, hour_axis, day_of_week, hour,
                                   venue_category, busyness_pct, month, season)
     VALUES ($1, 'weekly', NULL, 1, 4, 'bar', 33, 5, 'spring')`,
    [venueIds.philly]
  );
  try {
    await assert.rejects(
      () => exporter.runExport({ pool: roPool, outDir, log: quiet }),
      (err) => err.code === 'UNDECLARED_HOUR_AXIS' && /six hours off the venue clock/.test(err.message),
      'a weekly row that does not declare venue_local holds a BestTime array index; ' +
      'exporting it corrupts its own delta label, the baseline group it lands in, and ' +
      'the category baselines shipped in model_metadata.json'
    );
    // And it must not have left a readable corpus behind.
    assert.ok(!fs.existsSync(path.join(outDir, 'training_data.csv')),
      'the refusal left the previous export in place — prepare_features.py would ' +
      'accept it and the retrain would silently run on stale data');
    assert.ok(!fs.existsSync(path.join(outDir, 'training_data.csv.partial')));

    // The same is true of an explicitly legacy row.
    await pool.query(`UPDATE ml_training_data SET hour_axis = 'besttime_index'
                       WHERE hour_axis IS NULL AND collection_mode = 'weekly'`);
    await assert.rejects(() => exporter.runExport({ pool: roPool, outDir, log: quiet }),
      (err) => err.code === 'UNDECLARED_HOUR_AXIS');
  } finally {
    await pool.query(`DELETE FROM ml_training_data WHERE hour_axis IS DISTINCT FROM 'venue_local'`);
    await pool.query(`ALTER TABLE ml_training_data
                        ADD CONSTRAINT ml_training_data_weekly_axis_declared
                        CHECK (collection_mode <> 'weekly' OR hour_axis IS NOT NULL)`);
  }
});

test('a realtime row without an axis stamp is NOT a refusal', async () => {
  // Realtime rows have always been on the venue clock, stamped or not. Refusing
  // them would throw away every pre-2026-08-15 observation — the weight-1.0
  // rows the model actually learns from.
  await pool.query(`UPDATE ml_training_data SET hour_axis = NULL WHERE collection_mode = 'realtime'`);
  try {
    const r = await exporter.runExport({ pool: roPool, outDir, log: quiet });
    const rt = readCsv(path.join(outDir, 'training_data.csv')).rows.filter((x) => x.is_realtime === '1');
    // philly 3 + nobase 1 + the round-26 evented row 1; miami is holdout.
    assert.equal(rt.length, 5, 'undeclared realtime rows must still export');
    assert.ok(r.trainCount > 0);
  } finally {
    await pool.query(`UPDATE ml_training_data SET hour_axis = 'venue_local' WHERE collection_mode = 'realtime'`);
  }
});

test('a failure mid-export leaves no CSV at all', async () => {
  // Stand in for a previous run's output — the file a failed export must not
  // leave behind. Writing it directly rather than running another full export.
  fs.writeFileSync(path.join(outDir, 'training_data.csv'), exporter.HEADER + '\n');
  fs.writeFileSync(path.join(outDir, 'holdout_data.csv'), exporter.HEADER + '\n');

  let calls = 0;
  const flaky = {
    query: (...a) => roPool.query(...a),
    connect: async () => {
      if (++calls > 1) throw new Error('connection lost mid-export');
      return roPool.connect();
    },
  };
  await assert.rejects(() => exporter.runExport({ pool: flaky, outDir, log: quiet }),
    /connection lost mid-export/);
  for (const f of ['training_data.csv', 'holdout_data.csv',
    'training_data.csv.partial', 'holdout_data.csv.partial']) {
    assert.ok(!fs.existsSync(path.join(outDir, f)),
      `${f} survived a failed export, a truncated corpus passes the 45-column contract check`);
  }
});

test('the exporter tolerates a database without the optional columns', async () => {
  // A database whose server has never booted the current chain has no
  // label_source and no observed_date. A missing column is a hard SQL error,
  // which is what the ALTER TABLE this file used to run was hiding.
  const optional = { label_source: false, observed_date: false, hour_axis: true };
  const q = exporter.cityQuery('philly', optional);
  assert.match(q.text, /NULL AS label_source/);
  assert.match(q.text, /NULL AS stored_observed_date/);
  const { rows } = await roPool.query(q);
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.label_source, null);
    assert.equal(r.stored_observed_date, null);
  }
  // And the fallback path still dates the realtime rows, from collected_at.
  const rt = rows.filter((r) => r.collection_mode === 'realtime');
  assert.ok(rt.length > 0);
  assert.ok(rt.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(exporter.observedDate(r))),
    'with no stored observed_date the venue-local date must be derived from collected_at');
});

test('the anchor aggregate is buildBaselines\' statement, not a second definition', () => {
  const norm = (s) => s.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const mine = norm(exporter.BASELINE_AGGREGATE_SQL);
  const theirs = norm(buildBaselines.UPSERT_SQL);
  for (const clause of [
    "collection_mode = 'weekly'",
    "hour_axis = 'venue_local'",
    'busyness_pct is not null',
    'group by v2.google_place_id, t2.day_of_week, t2.hour'.replace(/t2\.|v2\./g, ''),
  ]) {
    const c = clause.replace(/t2\.|v2\./g, '');
    assert.ok(norm(mine).replace(/t2\.|v2\./g, '').includes(c),
      `the export's anchor aggregate is missing "${c}"`);
    assert.ok(theirs.replace(/t\.|v\./g, '').includes(c),
      `buildBaselines' UPSERT no longer contains "${c}" — the two definitions have drifted ` +
      'and the export must be brought back in line with it, not the other way round');
  }
  assert.match(mine, /round\(avg\(t2\.busyness_pct\)\)/,
    'the same rounding buildBaselines applies before storing a smallint');
});

// ---------------------------------------------------------------------------
// 4. THE ONNX ARTIFACT.
//
// The server's own load gate is the specification, so it is imported and run
// rather than described.
// ---------------------------------------------------------------------------

const FEATURES = ['aa_feat', 'bb_feat', 'cc_feat', 'hour', 'is_weekend', 'rating'];

// Exactly the metadata export_model.py guarantees, and a session shaped the way
// it verifies the graph before letting it become crowd_model.onnx.
function exportedMetadata(over = {}) {
  return {
    feature_names: [...FEATURES],
    feature_count: FEATURES.length,
    feature_types: FEATURES.map(() => 'float'),
    onnx_input_name: 'input',
    model_version: '2.6.0-test',
    model_name: 'Starling',
    model_type: 'xgboost',
    label_type: 'delta',
    delta_clamp_range: [-30, 30],
    feedback_error_semantics: 'mapped',
    trained_at: new Date().toISOString(),
    training_metrics: { within_15: 83.6 },
    ship_gate: { overall_pass: true, verdict: 'ship', gate_basis: 'holdout_realtime_served' },
    ...over,
  };
}

function exportedSession(over = {}) {
  return {
    inputNames: ['input'],
    outputNames: ['variable'],
    inputMetadata: [{ name: 'input', isTensor: true, type: 'float32', shape: ['', FEATURES.length] }],
    outputMetadata: [{ name: 'variable', isTensor: true, type: 'float32', shape: ['', 1] }],
    ...over,
  };
}

test('what export_model.py guarantees is exactly what the server demands', () => {
  const problems = mlPredictor._internals.verifyModelShape(exportedSession(), exportedMetadata());
  assert.deepEqual(problems, [],
    'an artifact exported by export_model.py must pass mlPredictor.verifyModelShape ' +
    'with nothing to say; anything else is a model that loads nowhere');
  assert.equal(mlPredictor._internals.evaluateShipGate(exportedMetadata()).promote, true);
});

test('each guarantee the export makes is load-bearing at load time', () => {
  const cases = [
    ['feature_count disagrees with feature_names', exportedSession(), exportedMetadata({ feature_count: 99 })],
    ['the graph is wider than the metadata says', exportedSession({
      inputMetadata: [{ name: 'input', shape: ['', 99] }],
    }), exportedMetadata()],
    ['onnx_input_name is not an input of the graph', exportedSession(), exportedMetadata({ onnx_input_name: 'X' })],
    ['feature_types is a different width', exportedSession(), exportedMetadata({ feature_types: ['float'] })],
    ['the head is a classifier, not a regressor', exportedSession({
      outputNames: ['label', 'probabilities'],
    }), exportedMetadata()],
    ['the head is wider than one value', exportedSession({
      outputMetadata: [{ name: 'variable', shape: ['', 3] }],
    }), exportedMetadata()],
    ['there is no within_15 to publish as confidence', exportedSession(), exportedMetadata({ training_metrics: {} })],
    ['there are no feature_names at all', exportedSession(), exportedMetadata({ feature_names: undefined })],
  ];
  for (const [what, session, meta] of cases) {
    const problems = mlPredictor._internals.verifyModelShape(session, meta);
    assert.ok(problems.length > 0, `${what}: the server would have loaded this`);
  }
  assert.equal(mlPredictor._internals.evaluateShipGate(exportedMetadata({ ship_gate: undefined })).promote,
    false, 'no ship gate must fail closed');
});

test('THE ORDER BUG: the server cannot see a shuffled feature_names, so the export must', () => {
  const shuffled = [...FEATURES];
  [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
  const problems = mlPredictor._internals.verifyModelShape(
    exportedSession(), exportedMetadata({ feature_names: shuffled })
  );
  assert.deepEqual(problems, [],
    'REPRODUCTION: with the same names in a different order every width check passes, ' +
    'onnxruntime does not throw, and mlPredictor builds each inference vector by walking ' +
    'the WRONG order. Nothing downstream can catch it — which is why export_model.py ' +
    'compares best_model.pkl feature_cols against metadata.feature_names and refuses.');
});

test('export_model.py refuses before it writes, and writes the names from the pickle', () => {
  assert.match(EXPORT_PY_SRC, /def check_feature_order\(/);
  // Order matters: the refusals must all precede the conversion and the writes.
  const orderIdx = EXPORT_PY_SRC.indexOf('check_feature_order(feature_cols, metadata)');
  const convertIdx = EXPORT_PY_SRC.indexOf('onnx_model = convert(');
  const writeIdx = EXPORT_PY_SRC.indexOf('write_atomic(onnx_path');
  assert.ok(orderIdx > 0 && convertIdx > orderIdx && writeIdx > convertIdx,
    'the feature-order check must run BEFORE the conversion and before any write');
  assert.match(EXPORT_PY_SRC, /metadata\['feature_names'\] = feature_cols/,
    'the names shipped must come from the same object that defined the ONNX column ' +
    'order, so the two cannot be sourced independently again');
  assert.match(EXPORT_PY_SRC, /metadata\['feature_count'\] = n_features/);
  assert.match(EXPORT_PY_SRC, /def write_atomic\(/);
  assert.match(EXPORT_PY_SRC, /os\.replace\(tmp, path\)/,
    'a killed export must leave the previous artifact pair intact, not a new .onnx ' +
    'beside an old .json');
  for (const key of ['ship_gate', 'training_metrics', 'category_baselines', 'top_google_types']) {
    assert.ok(EXPORT_PY_SRC.includes(`'${key}'`),
      `${key} is read by mlPredictor on the load path and must be required here`);
  }
  assert.match(EXPORT_PY_SRC, /model\.predict\(probe\)/,
    'the converted graph must be checked against the trained model it claims to be');
  assert.match(EXPORT_PY_SRC, /!= sorted\(feature_cols\)/,
    'mlPipeline.test.js pins feature_names against prepare_features\' sorted order — ' +
    'the only checkable half of the positional contract, so the export must not ' +
    'produce a list that breaks it');
});

// ── The Python side, actually executed, when the environment allows ─────────

const PY = (() => {
  for (const bin of ['python', 'python3']) {
    const probe = spawnSync(bin, ['-c', 'import onnxruntime, onnxmltools, xgboost, numpy'],
      { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
})();

const META_FIXTURE = {
  feature_names: FEATURES,
  feature_count: FEATURES.length,
  ship_gate: { overall_pass: true, verdict: 'ship', gate_basis: 'holdout_realtime_served' },
  training_metrics: { within_15: 83.6 },
  category_encoding: { bar: 0 },
  top_google_types: ['bar'],
  category_baselines: { bar_5_20: 50.0 },
  refined_baselines: { bar_1_1_5_20: 50.0 },
};

// The REAL export_model.py, executed against a synthetic model. Two spawns:
// importing xgboost + onnxruntime costs seconds each, so the four refusal cases
// share one process and report as JSON.
//
// `refusals` mutates model_metadata.json, snapshots BOTH artifacts, calls
// main(), and records what happened AND whether either file changed. "It
// refused" and "it refused without leaving a half-written pair behind" are two
// different claims, and after a crash the second is the one that matters.
const DRIVER = `
import importlib.util, json, pickle, sys
from pathlib import Path
import numpy as np
REAL, FIX, MODE = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
TRAIN, MODELS = FIX / 'train', FIX / 'models'
META = MODELS / 'model_metadata.json'
ONNX = MODELS / 'crowd_model.onnx'
FEATURES = ${JSON.stringify(FEATURES)}

def build():
    TRAIN.mkdir(parents=True, exist_ok=True); MODELS.mkdir(parents=True, exist_ok=True)
    import xgboost as xgb
    rng = np.random.default_rng(7)
    X = rng.normal(size=(200, len(FEATURES))).astype(np.float32)
    y = (X[:, 0] * 3 - X[:, 1]).astype(np.float32)
    m = xgb.XGBRegressor(n_estimators=8, max_depth=3, tree_method='hist'); m.fit(X, y)
    with open(TRAIN / 'best_model.pkl', 'wb') as f:
        pickle.dump({'model': m, 'name': 'xgboost', 'feature_cols': list(FEATURES)}, f)
    META.write_text(json.dumps(json.loads(r'''${JSON.stringify(META_FIXTURE)}'''), indent=2), encoding='utf-8')

def load_module():
    spec = importlib.util.spec_from_file_location('export_model_under_test', REAL)
    mod = importlib.util.module_from_spec(spec)
    sys.modules['export_model_under_test'] = mod
    spec.loader.exec_module(mod)
    mod.SCRIPT_DIR, mod.MODELS_DIR = TRAIN, MODELS
    return mod

def attempt(mod, name, mutate):
    meta = json.loads(META.read_text(encoding='utf-8'))
    meta['feature_names'] = list(FEATURES)
    meta['ship_gate'] = {'overall_pass': True, 'verdict': 'ship'}
    meta['training_metrics'] = {'within_15': 83.6}
    mutate(meta)
    META.write_text(json.dumps(meta, indent=2), encoding='utf-8')
    before_onnx, before_meta = ONNX.read_bytes(), META.read_bytes()
    result = {'case': name, 'raised': None, 'message': ''}
    try:
        mod.main()
    except BaseException as err:
        result['raised'] = type(err).__name__
        result['message'] = str(err)
    result['onnx_unchanged'] = ONNX.read_bytes() == before_onnx
    result['meta_unchanged'] = META.read_bytes() == before_meta
    return result

def shuffle(meta):
    n = list(meta['feature_names']); n[0], n[1] = n[1], n[0]; meta['feature_names'] = n

if MODE == 'build':
    build()
    load_module().main()
else:
    mod = load_module()
    report = [
        attempt(mod, 'order_drift', shuffle),
        attempt(mod, 'no_ship_gate', lambda m: m.pop('ship_gate', None)),
        attempt(mod, 'no_within_15', lambda m: m.__setitem__('training_metrics', {'mae': 1})),
        attempt(mod, 'feature_set_changed',
                lambda m: m.__setitem__('feature_names', list(FEATURES) + ['zz_extra'])),
    ]
    print('REPORT ' + json.dumps(report))
`;

test('export_model.py, run for real', { skip: PY ? false : 'python with onnxruntime/onnxmltools/xgboost not available' }, async (t) => {
  const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-onnx-fix-'));
  const driver = path.join(fix, 'drive.py');
  fs.writeFileSync(driver, DRIVER);
  const metaPath = path.join(fix, 'models', 'model_metadata.json');
  const onnxPath = path.join(fix, 'models', 'crowd_model.onnx');
  const py = (mode, env = {}) => spawnSync(PY, [driver, EXPORT_PY_PATH, fix, mode],
    { encoding: 'utf8', env: { ...process.env, ...env } });

  try {
    await t.test('a clean export produces an artifact the server would load', () => {
      const r = py('build', { MODEL_VERSION: '2.6.0-contracttest' });
      assert.equal(r.status, 0, r.stderr);
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      assert.deepEqual(meta.feature_names, FEATURES,
        'the names shipped must be the pickle\'s column order');
      assert.equal(meta.feature_count, FEATURES.length);
      assert.equal(meta.feature_types.length, FEATURES.length);
      assert.equal(meta.model_version, '2.6.0-contracttest',
        'MODEL_VERSION must reach the artifact — a hardcoded version made every retrain '
        + 'ship under the previous model\'s name');
      assert.equal(meta.onnx_input_name, 'input');
      assert.equal(meta.label_type, 'delta');
      assert.deepEqual(meta.delta_clamp_range, [-30, 30]);
      assert.equal(meta.feedback_error_semantics, 'mapped');
      assert.ok(fs.statSync(onnxPath).size > 0);
      // The point of the whole file: what the export writes, the server loads.
      assert.deepEqual(
        mlPredictor._internals.verifyModelShape(
          exportedSession({
            inputNames: [meta.onnx_input_name],
            inputMetadata: [{ name: meta.onnx_input_name, shape: ['', meta.feature_count] }],
          }), meta),
        [], 'the exported metadata does not satisfy mlPredictor.verifyModelShape');
      assert.equal(mlPredictor._internals.evaluateShipGate(meta).promote, true);
    });

    await t.test('every incoherent artifact is refused, and refused before any write', () => {
      const r = py('refusals');
      assert.equal(r.status, 0, r.stderr);
      const line = r.stdout.split('\n').find((l) => l.startsWith('REPORT '));
      assert.ok(line, `no report from the driver:\n${r.stdout}\n${r.stderr}`);
      const report = Object.fromEntries(JSON.parse(line.slice(7)).map((x) => [x.case, x]));

      const expected = {
        order_drift: /FEATURE ORDER DRIFT/,
        no_ship_gate: /ship_gate/,
        no_within_15: /within_15/,
        feature_set_changed: /FEATURE SET MISMATCH/,
      };
      for (const [name, re] of Object.entries(expected)) {
        const c = report[name];
        assert.ok(c, `${name} was not attempted`);
        assert.equal(c.raised, 'ExportContractError',
          `${name}: the export did not refuse (raised ${c.raised || 'nothing'})`);
        assert.match(c.message, re, `${name}: the message does not name the problem`);
        assert.equal(c.onnx_unchanged, true,
          `${name}: crowd_model.onnx was rewritten by an export that refused`);
        assert.equal(c.meta_unchanged, true,
          `${name}: model_metadata.json was rewritten by an export that refused — the `
          + 'previous artifact pair must survive a failed export intact');
      }
    });
  } finally {
    fs.rmSync(fix, { recursive: true, force: true });
  }
});
