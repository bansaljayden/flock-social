'use strict';
// ---------------------------------------------------------------------------
// ROUND 23 — venue_feedback as a LABEL source (RETRAIN.md "next lever 1").
//
// Every label in the training corpus comes from BestTime, so a model trained on
// it can only be rewarded for agreeing with one vendor. `venue_feedback` is the
// only label source in this product that is independent of that vendor. This
// file pins the export path that carries it, and — just as importantly — pins
// the interlocks that stop it reaching training before the modelling questions
// it raises have been answered:
//
//   1. THE MAPPING. crowd_level is a 3-point human perception; busyness_pct is
//      BestTime's percentage of a venue's own typical peak. No mapping between
//      them is justifiable from anything in this repository, so the exporter
//      has NO DEFAULT and refuses to emit a row without an operator-supplied,
//      measured one. A wrong mapping is worse than no export.
//   2. THE WEIGHT TIER. prepare_features.py assigns sample weights from
//      label_provenance, and its ladder ends in an ELSE of 1.0. A 'user_report'
//      row that arrived without its own tier would outrank every live BestTime
//      observation in the corpus on the strength of a three-way tap — the exact
//      defect rounds 10 and 20 were written about. The final test in this file
//      makes that impossible to land by halves.
//   3. THE CLOCK. venue_feedback bucket keys were UTC before migration 021.
//      PRE-RETRAIN-AUDIT finding 13 named "a fourth clock in the hour column"
//      as the reason not to build this path. It is checked, not assumed.
//
// The database tests use the repo's embedded Postgres and the real migration
// chain. Zero paid API calls, zero contact with production.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;

// Distinct from e2e-local.js's 59595, feedbackBackfillMigration's 59641,
// mlClockAxisBackfill's 59643, mlCorpusDedupe's 59647, mlExportContracts' 59723.
const PG_PORT = 59751;
const DB_NAME = 'flock_feedback_label_test';
const CONN = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;

// Pinned before any require below: scripts/ml/* call dotenv on backend/.env,
// which points at the live Railway database, and dotenv never overwrites a
// variable that is already set.
process.env.DATABASE_URL = CONN;
process.env.PGSSLMODE = 'disable';

const TRAIN_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'train');
const PREPARE_SRC = fs.readFileSync(path.join(TRAIN_DIR, 'prepare_features.py'), 'utf8');

const exporter = require('../scripts/ml/train/export_training_data');
const buildBaselines = require('../scripts/ml/buildBaselines');

const HEADER_COLUMNS = exporter.HEADER.split(',');
const {
  FEEDBACK_LABEL_SOURCE,
  FEEDBACK_ENABLE_ENV,
  FEEDBACK_CROWD_MAP_ENV,
  FEEDBACK_EXCLUSION_REASONS,
  MIN_FEEDBACK_REPORTERS,
  parseFeedbackCrowdMap,
  feedbackExportRequested,
  groupFeedbackCells,
  feedbackCellToTrainingRow,
  feedbackCensus,
  exportFeedbackCity,
  newFeedbackCounters,
} = exporter;

// A mapping used ONLY by these tests. It is not a recommendation and no
// production path may read it: the whole point of the design is that the
// numbers come from measurement, and there is nothing to measure yet.
const TEST_MAP = { 1: 18, 2: 47, 3: 79 };

// ===========================================================================
// PART 1 — the mapping gate. No database.
// ===========================================================================

test('the exporter has no default crowd_level -> busyness_pct mapping', () => {
  let err;
  try { parseFeedbackCrowdMap(undefined); } catch (e) { err = e; }
  assert.ok(err, 'an absent mapping must be refused');
  assert.equal(err.code, 'FEEDBACK_MAP_MISSING');
  // The refusal has to explain WHY, not merely that. This is the one decision
  // in the path that cannot be recovered from downstream.
  assert.match(err.message, /different quantities/);
  assert.match(err.message, /delta/i);
  assert.throws(() => parseFeedbackCrowdMap(''), /FLOCK_FEEDBACK_CROWD_MAP/);
  assert.throws(() => parseFeedbackCrowdMap('   '), /FLOCK_FEEDBACK_CROWD_MAP/);
});

test('a partial, out-of-range or non-monotone mapping is refused', () => {
  assert.throws(() => parseFeedbackCrowdMap('not json'), /not valid JSON/);
  assert.throws(() => parseFeedbackCrowdMap('[20,50,80]'), /JSON object/);
  // A partial map is the dangerous one: it looks like a mapping and silently
  // drops every report of the missing level, biasing the corpus toward
  // whichever nights survive.
  assert.throws(() => parseFeedbackCrowdMap('{"1":20,"2":50}'), /exactly the keys/);
  assert.throws(() => parseFeedbackCrowdMap('{"1":20,"2":50,"3":80,"4":90}'), /exactly the keys/);
  assert.throws(() => parseFeedbackCrowdMap('{"1":-1,"2":50,"3":80}'), /0-100/);
  assert.throws(() => parseFeedbackCrowdMap('{"1":20,"2":50,"3":140}'), /0-100/);
  assert.throws(() => parseFeedbackCrowdMap('{"1":"20","2":50,"3":80}'), /0-100/);
  // crowd_level is an ORDINAL. A map that is not increasing asserts otherwise.
  assert.throws(() => parseFeedbackCrowdMap('{"1":80,"2":50,"3":20}'), /strictly increasing/);
  assert.throws(() => parseFeedbackCrowdMap('{"1":20,"2":20,"3":80}'), /strictly increasing/);
  assert.deepEqual(parseFeedbackCrowdMap('{"1":18,"2":47,"3":79}'), TEST_MAP);
});

test('the path is OFF unless explicitly asked for', () => {
  assert.equal(feedbackExportRequested({}), false);
  assert.equal(feedbackExportRequested({ [FEEDBACK_ENABLE_ENV]: '' }), false);
  assert.equal(feedbackExportRequested({ [FEEDBACK_ENABLE_ENV]: '0' }), false);
  assert.equal(feedbackExportRequested({ [FEEDBACK_ENABLE_ENV]: 'false' }), false);
  assert.equal(feedbackExportRequested({ [FEEDBACK_ENABLE_ENV]: '1' }), true);
  assert.equal(feedbackExportRequested({ [FEEDBACK_ENABLE_ENV]: 'true' }), true);
});

// ===========================================================================
// PART 2 — the row builder. No database.
// ===========================================================================

const baseCandidate = (over = {}) => ({
  feedback_id: 1,
  user_id: 1,
  crowd_level: 2,
  day_of_week: 5,
  hour: 21,
  created_at: '2026-05-08T02:00:00.000Z',
  local_date: '2026-05-07',
  clock_agrees: true,
  venue_id: 7,
  city: 'philly',
  google_place_id: 'ChIJfeedback1',
  google_types: ['bar', 'food'],
  latitude: 39.95,
  longitude: -75.16,
  venue_category: 'bar',
  price_level: 2,
  rating: 4.5,
  review_count: 300,
  baseline_busyness: 60,
  ...over,
});

const cellOf = (rows) => groupFeedbackCells(rows)[0];

test('one account is one opinion, however many times it reports', () => {
  // Six reports from one user for the same venue-hour-date. Under the old
  // shape of this bug (crowdEngine round 15) they would have arrived as six
  // independent voices, clearing the reporter floor by themselves.
  const rows = [1, 2, 3, 4, 5, 6].map((i) => baseCandidate({
    feedback_id: i, user_id: 42, crowd_level: 3,
    created_at: `2026-05-08T0${i}:00:00.000Z`,
  }));
  const cell = cellOf(rows);
  assert.equal(cell.votes.size, 1, 'six reports from one account are one vote');
  assert.equal(feedbackCellToTrainingRow(cell, TEST_MAP).excluded, 'below_reporter_floor');

  // And the vote kept is the NEWEST — people correct themselves.
  const revised = cellOf([
    baseCandidate({ feedback_id: 1, user_id: 42, crowd_level: 1, created_at: '2026-05-08T01:00:00.000Z' }),
    baseCandidate({ feedback_id: 2, user_id: 42, crowd_level: 3, created_at: '2026-05-08T04:00:00.000Z' }),
  ]);
  assert.equal([...revised.votes.values()][0].row.crowd_level, 3);
});

test('a cell below the reporter floor is excluded, not exported', () => {
  for (const n of [1, 2]) {
    const rows = Array.from({ length: n }, (_, i) => baseCandidate({ feedback_id: i, user_id: i + 1 }));
    const out = feedbackCellToTrainingRow(cellOf(rows), TEST_MAP);
    assert.equal(out.excluded, 'below_reporter_floor', `${n} reporter(s) must not produce a label`);
    assert.equal(FEEDBACK_EXCLUSION_REASONS.below_reporter_floor.kind, 'absence');
  }
  const enough = Array.from({ length: MIN_FEEDBACK_REPORTERS },
    (_, i) => baseCandidate({ feedback_id: i, user_id: i + 1 }));
  assert.ok(feedbackCellToTrainingRow(cellOf(enough), TEST_MAP).row);
});

test('an exported feedback row is a 44-column row that names itself', () => {
  const rows = [
    baseCandidate({ feedback_id: 1, user_id: 1, crowd_level: 3 }),
    baseCandidate({ feedback_id: 2, user_id: 2, crowd_level: 3 }),
    baseCandidate({ feedback_id: 3, user_id: 3, crowd_level: 2 }),
  ];
  const out = feedbackCellToTrainingRow(cellOf(rows), TEST_MAP);
  const fields = exporter.rowToCsv(out.row).split(',');
  assert.equal(fields.length, 44, 'the feedback path must not change the export contract');
  const at = (name) => fields[HEADER_COLUMNS.indexOf(name)];

  // Distinguishable for the rest of its life. Both the raw column and the
  // derived one, and they agree — prepare_features.py checks exactly that.
  assert.equal(at('label_source'), FEEDBACK_LABEL_SOURCE);
  assert.equal(at('label_provenance'), FEEDBACK_LABEL_SOURCE);
  assert.equal(exporter.labelProvenance(out.row), FEEDBACK_LABEL_SOURCE);
  assert.notEqual(at('label_provenance'), 'unknown',
    "'unknown' is the weight-1.0 pool; a human report must never land in it");

  // A moment, not a typical week — so it is is_realtime, and it is anchored on
  // the same baseline every other row in the file is anchored on.
  assert.equal(at('is_realtime'), '1');
  assert.equal(at('baseline_busyness'), '60');

  // Mean of the mapped votes: (79 + 79 + 47) / 3 = 68.33 -> 68.
  assert.equal(at('busyness_pct'), '68');

  // Dated from the report's OWN venue-local date, with the calendar derived
  // from it rather than from an insert timestamp (audit finding 5).
  assert.equal(at('observed_date'), '2026-05-07');
  assert.equal(at('month'), '5');
  assert.equal(at('season'), 'spring');

  // BestTime was never asked about this moment: empty, never 0.
  assert.equal(at('vendor_forecast_pct'), '');
});

test('a feedback-labelled row carries no feedback FEATURES — that would be the leak', () => {
  const rows = [1, 2, 3].map((i) => baseCandidate({ feedback_id: i, user_id: i }));
  const out = feedbackCellToTrainingRow(cellOf(rows), TEST_MAP);
  const fields = exporter.rowToCsv(out.row).split(',');
  const at = (name) => fields[HEADER_COLUMNS.indexOf(name)];

  // avg_user_crowd / user_feedback_count / avg_prediction_error are a per-venue
  // aggregate over the SAME reports. avg_prediction_error is literally
  // `mapped(crowd_level) - predicted_score`, i.e. this row's own label minus a
  // model output. Feeding it back in would hand the row its answer.
  for (const col of ['avg_user_crowd', 'user_feedback_count', 'avg_prediction_error']) {
    assert.equal(at(col), '', `${col} must be EMPTY on a feedback-labelled row, not 0 and not the aggregate`);
  }
  // Weather and events were never observed for this moment and are not
  // recoverable. Empty is the honest field; 0 would assert 0 degrees.
  for (const col of ['temperature', 'humidity', 'wind_speed', 'weather_condition', 'weather_condition_code']) {
    assert.equal(at(col), '', `${col} must be empty, not an invented reading`);
  }
});

test('rows that cannot be labelled are excluded by NAME, and the corrupt ones stop the run', () => {
  const three = (over) => [1, 2, 3].map((i) => baseCandidate({ feedback_id: i, user_id: i, ...over }));

  // ABSENCE — counted and skipped.
  assert.equal(feedbackCellToTrainingRow(cellOf(three({ local_date: null })), TEST_MAP).excluded,
    'no_observation_date');
  assert.equal(feedbackCellToTrainingRow(cellOf(three({ venue_category: null })), TEST_MAP).excluded,
    'no_venue_attributes');

  // CORRUPT — a counted skip would hide a broken invariant.
  assert.equal(feedbackCellToTrainingRow(cellOf(three({ clock_agrees: false })), TEST_MAP).excluded,
    'clock_disagreement');
  assert.equal(feedbackCellToTrainingRow(cellOf(three({ crowd_level: 4 })), TEST_MAP).excluded,
    'unmappable_crowd_level');

  // The two kinds are distinguished, and every reason carries its reason.
  assert.equal(FEEDBACK_EXCLUSION_REASONS.clock_disagreement.kind, 'corrupt');
  assert.equal(FEEDBACK_EXCLUSION_REASONS.unmappable_crowd_level.kind, 'corrupt');
  assert.equal(FEEDBACK_EXCLUSION_REASONS.no_observation_date.kind, 'absence');
  assert.equal(FEEDBACK_EXCLUSION_REASONS.no_venue_attributes.kind, 'absence');
  for (const [name, spec] of Object.entries(FEEDBACK_EXCLUSION_REASONS)) {
    assert.ok(['absence', 'corrupt'].includes(spec.kind), `${name} has no kind`);
    assert.ok(spec.why && spec.why.length > 30, `${name} does not say why`);
  }

  // A single bad crowd_level poisons the whole cell rather than being averaged
  // out of existence with the two good votes.
  const mixed = cellOf([
    baseCandidate({ feedback_id: 1, user_id: 1, crowd_level: 2 }),
    baseCandidate({ feedback_id: 2, user_id: 2, crowd_level: 2 }),
    baseCandidate({ feedback_id: 3, user_id: 3, crowd_level: 9 }),
  ]);
  assert.equal(feedbackCellToTrainingRow(mixed, TEST_MAP).excluded, 'unmappable_crowd_level');
});

// ===========================================================================
// PART 3 — against a real database.
// ===========================================================================

const PLACE_A = 'ChIJfeedbackPhilly1';
const PLACE_B = 'ChIJfeedbackPhilly2';   // no ml_training_data rows at all
const PLACE_OFFCORPUS = 'ChIJfeedbackNotOurs';  // not in ml_venues

let pg;
let pool;
let roPool;
let dataDir;
const venueIds = {};
const userIds = [];

test.before(async () => {
  dataDir = path.join(os.tmpdir(), 'flock-fblabel-pg-' + Date.now());
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres',
    port: PG_PORT, persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB_NAME);
  pool = new Pool({ connectionString: CONN });

  const { migrate } = require('../db/migrate');
  await migrate(pool);

  for (const [key, place] of [['a', PLACE_A], ['b', PLACE_B]]) {
    const { rows } = await pool.query(
      `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude,
                              venue_category, google_types, timezone, price_level, rating, review_count)
       VALUES ($1, 'Feedback Bar', 'philly', 39.95, -75.16, 'bar',
               ARRAY['bar','food'], 'America/New_York', 2, 4.5, 300)
       RETURNING id`,
      [place]
    );
    venueIds[key] = rows[0].id;
  }

  // Weekly corpus for venue A only, so A has a baseline and venue attributes
  // and B has neither. Friday 21:00 local.
  await pool.query(
    `INSERT INTO ml_training_data
       (venue_id, collection_mode, hour_axis, day_of_week, hour, venue_category,
        busyness_pct, month, season, temperature, weather_condition, collected_at)
     VALUES ($1, 'weekly', 'venue_local', 5, 21, 'bar', 60, 5, 'spring', 20.0,
             'few clouds', NOW())`,
    [venueIds.a]
  );

  for (let i = 0; i < 4; i += 1) {
    const { rows } = await pool.query(
      `INSERT INTO users (email, password, name) VALUES ($1, 'x', $2) RETURNING id`,
      [`fb${i}@example.test`, `Reporter ${i}`]
    );
    userIds.push(rows[0].id);
  }

  await pool.query('ANALYZE ml_training_data');
  await pool.query('ANALYZE ml_venues');
  const refresh = await buildBaselines.refreshCollectedBaselines(pool);
  assert.equal(refresh.ok, true);

  roPool = new Pool({
    connectionString: CONN,
    options: '-c default_transaction_read_only=on',
  });
});

test.after(async () => {
  if (roPool) await roPool.end();
  if (pool) await pool.end();
  if (pg) await pg.stop();
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    console.warn(`[mlFeedbackLabels] could not remove ${dataDir}: ${err.message}`);
  }
});

// 2026-05-08 01:00Z is 2026-05-07 21:00 in America/New_York — a Thursday. The
// UTC clock would file it as Friday 01:00, which is precisely the bug migration
// 021 backfilled.
const AT_UTC = '2026-05-08T01:00:00Z';
const LOCAL_DOW = 4;      // Thursday, venue-local
const LOCAL_HOUR = 21;
const LOCAL_DATE = '2026-05-07';

async function insertFeedback({ place, userId, level, verified = true, dow = LOCAL_DOW,
  hour = LOCAL_HOUR, at = AT_UTC }) {
  await pool.query(
    `INSERT INTO venue_feedback
       (user_id, venue_place_id, venue_name, crowd_level, day_of_week, hour, verified, created_at)
     VALUES ($1, $2, 'Feedback Bar', $3, $4, $5, $6, $7)`,
    [userId, place, level, dow, hour, verified, at]
  );
}

test('the census reports coverage without ever gating on it', async () => {
  const empty = await feedbackCensus(roPool, true);
  assert.equal(empty.available, true);
  assert.equal(Number(empty.verified_rows), 0);
  assert.equal(Number(empty.clock_disagreements), 0);

  // A database whose venue_feedback predates migration 003 has no way to tell a
  // presence-verified report from a Sybil one, so the path reports unavailable
  // rather than widening what counts as evidence.
  assert.deepEqual(await feedbackCensus(roPool, false), { available: false });

  await insertFeedback({ place: PLACE_A, userId: userIds[0], level: 3 });
  await insertFeedback({ place: PLACE_A, userId: userIds[1], level: 3 });
  await insertFeedback({ place: PLACE_A, userId: userIds[2], level: 2 });
  // Unverified: excluded at the source, never counted as a candidate.
  await insertFeedback({ place: PLACE_A, userId: userIds[3], level: 1, verified: false });
  // A venue we have no corpus for at all.
  await insertFeedback({ place: PLACE_OFFCORPUS, userId: userIds[0], level: 3 });

  const census = await feedbackCensus(roPool, true);
  assert.equal(Number(census.verified_rows), 4, 'the unverified row must not be counted');
  assert.equal(Number(census.in_ml_venues), 3);
  assert.equal(Number(census.with_usable_timezone), 3);
  assert.equal(Number(census.clock_disagreements), 0);
});

test('the real query joins on venue, clock and baseline, and emits one row per cell', async () => {
  const counters = newFeedbackCounters();
  const written = [];
  const stream = { write: (chunk) => { written.push(chunk); return true; } };

  await exportFeedbackCity(roPool, 'philly', stream, TEST_MAP, counters);

  assert.equal(counters.candidates, 3, 'only verified rows at a venue in ml_venues are candidates');
  assert.equal(counters.cells, 1);
  assert.equal(counters.emitted, 1);
  assert.equal(counters.reporters, 3);
  assert.deepEqual(counters.corrupt, []);

  const lines = written.join('').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const fields = lines[0].split(',');
  assert.equal(fields.length, 44);
  const at = (name) => fields[HEADER_COLUMNS.indexOf(name)];
  assert.equal(at('venue_id'), String(venueIds.a));
  assert.equal(at('day_of_week'), String(LOCAL_DOW));
  assert.equal(at('hour'), String(LOCAL_HOUR));
  assert.equal(at('observed_date'), LOCAL_DATE);
  assert.equal(at('label_source'), FEEDBACK_LABEL_SOURCE);
  assert.equal(at('city'), 'philly');
  assert.equal(at('venue_category'), 'bar');
  // The baseline the weekly row produced is on (dow 5, hour 21); this cell is
  // (dow 4, hour 21), so the anchor is legitimately 0 and the serving-population
  // filter in prepare_features.py will drop it. That is the correct outcome and
  // it is asserted so a future join bug cannot quietly invent an anchor.
  assert.equal(at('baseline_busyness'), '0');
});

test('a venue with no corpus row is excluded by name, never exported with nulls', async () => {
  for (const uid of userIds.slice(0, 3)) {
    await insertFeedback({ place: PLACE_B, userId: uid, level: 2 });
  }
  const counters = newFeedbackCounters();
  const stream = { write: () => true };
  await exportFeedbackCity(roPool, 'philly', stream, TEST_MAP, counters);
  assert.equal(counters.cells, 2);
  assert.equal(counters.emitted, 1);
  assert.equal(counters.excluded.no_venue_attributes, 1);
  assert.deepEqual(counters.corrupt, []);
});

test('a UTC-bucketed row is caught by the census and refuses the run', async () => {
  // Written the way routes/feedback.js wrote them before the venue-local fix:
  // EXTRACT(DOW/HOUR FROM NOW()) on the server clock. Migration 021's predicate
  // is "the stored keys disagree with created_at rendered in the venue's zone",
  // and that predicate is a fixed point of the current write path — so a
  // disagreeing row proves 021 has not run here.
  await insertFeedback({ place: PLACE_A, userId: userIds[3], level: 1, dow: 5, hour: 1 });

  const census = await feedbackCensus(roPool, true);
  assert.equal(Number(census.clock_disagreements), 1);

  const counters = newFeedbackCounters();
  const stream = { write: () => true };
  await exportFeedbackCity(roPool, 'philly', stream, TEST_MAP, counters);
  assert.equal(counters.corrupt.length, 1);
  assert.equal(counters.corrupt[0].reason, 'clock_disagreement');
  // And it never becomes a row.
  assert.equal(counters.excluded.clock_disagreement, 1);

  await pool.query('DELETE FROM venue_feedback WHERE day_of_week = 5 AND hour = 1');
});

test('runExport is dormant by default and refuses a flag without a mapping', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-fblabel-out-'));
  try {
    delete process.env[FEEDBACK_ENABLE_ENV];
    delete process.env[FEEDBACK_CROWD_MAP_ENV];
    const dormant = await exporter.runExport({ pool: roPool, outDir, log: () => {} });
    assert.equal(dormant.feedback.enabled, false);
    assert.equal(dormant.feedback.emitted, 0);
    const csv = fs.readFileSync(path.join(outDir, 'training_data.csv'), 'utf8');
    assert.ok(!csv.includes(FEEDBACK_LABEL_SOURCE),
      'the default export must contain no feedback-labelled row');

    // Flag on, mapping absent: refused, and refused before any CSV survives.
    process.env[FEEDBACK_ENABLE_ENV] = '1';
    await assert.rejects(
      () => exporter.runExport({ pool: roPool, outDir, log: () => {} }),
      (err) => err.code === 'FEEDBACK_MAP_MISSING'
    );
    assert.equal(fs.existsSync(path.join(outDir, 'training_data.csv')), false,
      'a refused export must leave no readable corpus behind');

    // Flag on with a mapping: the rows appear, named.
    process.env[FEEDBACK_CROWD_MAP_ENV] = JSON.stringify(TEST_MAP);
    const enabled = await exporter.runExport({ pool: roPool, outDir, log: () => {} });
    assert.equal(enabled.feedback.enabled, true);
    assert.equal(enabled.feedback.emitted, 1);
    const withFeedback = fs.readFileSync(path.join(outDir, 'training_data.csv'), 'utf8')
      .split('\n').filter((l) => l.includes(`,${FEEDBACK_LABEL_SOURCE},`));
    assert.equal(withFeedback.length, 1);
    assert.equal(withFeedback[0].split(',').length, 44);
  } finally {
    delete process.env[FEEDBACK_ENABLE_ENV];
    delete process.env[FEEDBACK_CROWD_MAP_ENV];
    fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// ===========================================================================
// PART 4 — THE HANDOFF, made unlandable by halves.
//
// The exporter can name a feedback row. It cannot weight one: sample weights
// are assigned in prepare_features.py, which this change may not edit. Today
// its ladder is `is_realtime != 1 -> 0.05, forecast -> 0.3, else 1.0`, so a
// 'user_report' row would take the ELSE branch — a coarse three-way tap
// outranking every live BestTime observation in the corpus.
//
// That cannot happen today, because prepare_features.py's LABEL_SOURCE_VALUES
// does not contain 'user_report' and enforce_label_contract raises on the first
// such row by name. The danger is the HALF-DONE change: someone adds the value
// to LABEL_SOURCE_VALUES to make the error go away, and the rows sail into the
// 1.0 pool in silence. That is the shape of the defect round 10 and round 20
// both existed to fix.
//
// So this test pins the pair. Either the value is absent from
// LABEL_SOURCE_VALUES (the interlock stands), or it is present AND the sample
// weight ladder names it (the interlock was replaced by a real tier). There is
// no third state.
// ===========================================================================

test('prepare_features.py cannot accept user_report labels without weighting them', () => {
  const domain = PREPARE_SRC.match(/^LABEL_SOURCE_VALUES\s*=\s*\{([^}]*)\}/m);
  assert.ok(domain, 'LABEL_SOURCE_VALUES is no longer a set literal in prepare_features.py');
  const accepted = domain[1].includes(`'${FEEDBACK_LABEL_SOURCE}'`);

  const ladder = PREPARE_SRC.match(/train_df\['sample_weight'\]\s*=\s*np\.where\(([\s\S]*?)\n\s*\)/);
  assert.ok(ladder, 'the sample-weight ladder is no longer an np.where in prepare_features.py');
  const weighted = ladder[1].includes(FEEDBACK_LABEL_SOURCE);

  if (accepted) {
    assert.ok(weighted,
      `prepare_features.py now ACCEPTS label_source='${FEEDBACK_LABEL_SOURCE}' but its `
      + 'sample-weight ladder does not mention it, so every human report trains at weight '
      + '1.0 — outranking BestTime live observations on the strength of a three-way tap. '
      + 'Add the tier (the argued value is 0.15: above a weekly snapshot, below a vendor '
      + 'forecast) in the same change that widens the domain.');
  } else {
    assert.ok(!weighted,
      `prepare_features.py weights '${FEEDBACK_LABEL_SOURCE}' rows but still rejects the `
      + 'value in LABEL_SOURCE_VALUES, so the weight branch is dead code and no such row '
      + 'can reach it. Widen the domain in the same change.');
    // And the exporter's own derived column must keep agreeing with the Python
    // recomputation for every value the corpus can actually contain.
    for (const [mode, source, expected] of [
      ['weekly', null, 'weekly'],
      ['realtime', 'live', 'live'],
      ['realtime', 'forecast', 'forecast'],
      ['realtime', null, 'unknown'],
      ['realtime', FEEDBACK_LABEL_SOURCE, FEEDBACK_LABEL_SOURCE],
    ]) {
      assert.equal(exporter.labelProvenance({ collection_mode: mode, label_source: source }), expected);
    }
  }
});
