'use strict';
// ---------------------------------------------------------------------------
// HARVESTED VENUES MOVE NOBODY ELSE'S SCORE UNTIL A RETRAIN MEASURES THEM.
//
// scripts/ml/harvestVenueFilter.js adds venues as ml_venues rows with
// besttime_status 'harvested', and buildBaselines gives each a served curve
// within the hour. Two of the shipped model's inputs, log_neighbor_count and
// neighbor_baseline_same_hour, are computed over every venue with a curve in a
// box around the one being scored, so without a guard every existing venue's
// score would move by an amount nothing had measured. Pinned here, against a
// real migrated Postgres and the real predictor:
//
//   * the neighbour scan, and the whole served prediction, of every ordinary
//     venue is identical with harvested rows present and absent;
//   * a harvested venue still gets its own baseline and a model-backed score,
//     and is served the ordinary neighbourhood with nothing subtracted;
//   * the training export leaves harvested venues out by default (rows,
//     feedback and owner labels alike), includes them only when asked, and
//     says which it did, so training sees the neighbourhood serving sees;
//   * addDemandVenues lists a demanded harvested row as a promotion candidate
//     instead of silently counting it as present;
//   * the four copies of the status literal agree.
//
// Nothing here reaches BestTime, Google or production: DATABASE_URL points at
// the embedded database before any require, and the vendor keys are fakes.
//
// Run: node --test __tests__/harvestedIsolation.test.js  (from backend/)
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Pool } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');

const PG_PORT = pickEmbeddedPgPort('harvestedIsolation');
const CONN = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/flock_harvested_test`;
process.env.DATABASE_URL = CONN;
process.env.PGSSLMODE = 'disable';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-harvested-isolation';
// Set so the dotenv the ML scripts run at require cannot load a real key into
// this process; nothing here calls the vendor.
process.env.BESTTIME_API_KEY = 'not-a-real-key';
process.env.BESTTIME_API_KEY_PUBLIC = 'not-a-real-key';
delete process.env.TICKETMASTER_API_KEY;
delete process.env.ML_SHIP_GATE_OVERRIDE;

const { migrate } = require('../db/migrate');
const harvester = require('../scripts/ml/harvestVenueFilter');
const exporter = require('../scripts/ml/train/export_training_data');
const ownerExport = require('../scripts/ml/train/ownerLabelExport');
const demand = require('../scripts/ml/addDemandVenues');
const { refreshCollectedBaselines } = require('../scripts/ml/buildBaselines');
const predictorPool = require('../config/database');
const mlPredictor = require('../services/mlPredictor');

const I = mlPredictor._internals;

let pg;
let pool;
let roPool;
let dataDir;
const outDirs = [];

// Ordinary venues around one Center City block (one neighbour box), one far
// away; harvested venues in the same box and one alone.
const ORDINARY = [
  { tag: 'n1', lat: 39.9501, lng: -75.1651, seed: 11 },
  { tag: 'n2', lat: 39.9510, lng: -75.1640, seed: 23 },
  { tag: 'n3', lat: 39.9490, lng: -75.1660, seed: 37 },
  { tag: 'n4', lat: 39.9520, lng: -75.1620, seed: 41 },
  { tag: 'n5', lat: 39.9900, lng: -75.2500, seed: 53 },
];
const HARVESTED = [
  { tag: 'h1', lat: 39.9502, lng: -75.1652, seed: 61 },
  { tag: 'h2', lat: 39.9495, lng: -75.1645, seed: 71 },
  { tag: 'h3', lat: 40.0100, lng: -75.3000, seed: 83 },
];
const ids = {};
const placeOf = (tag) => `ChIJharvestIsolate${tag.padStart(3, '0')}`;
// A curve with gaps, different per venue: slot i holds (seed + 7i) % 97 + 1
// unless (i + seed) % 11 == 0.
const curveOf = (seed) => Array.from({ length: 168 }, (_, i) => ((i + seed) % 11 === 0 ? null : ((seed + 7 * i) % 97) + 1));

async function addVenue(v, { harvested }) {
  const { rows } = await pool.query(
    `INSERT INTO ml_venues (google_place_id, besttime_venue_id, name, city, latitude, longitude, venue_category,
                            rating, review_count, timezone, is_active, besttime_status)
     VALUES ($1, $2, $3, 'philly', $4, $5, 'bar', 4.3, 200, 'America/New_York', $6, $7) RETURNING id`,
    [placeOf(v.tag), `ven_isolate_${v.tag}`, `Venue ${v.tag}`, v.lat, v.lng, !harvested,
      harvested ? harvester.HARVEST_STATUS : 'found']
  );
  ids[v.tag] = rows[0].id;
  const values = [];
  const params = [];
  curveOf(v.seed).forEach((b, i) => {
    if (b === null) return;
    params.push(ids[v.tag], Math.floor(i / 24), i % 24, b);
    const k = params.length - 4;
    values.push(`($${k + 1}, 'weekly', 'venue_local', $${k + 2}, $${k + 3}, 7, 'fall', 'bar', 2, 4.3, 200, $${k + 4}, false, 'no_observation_date')`);
  });
  await pool.query(
    `INSERT INTO ml_training_data (venue_id, collection_mode, hour_axis, day_of_week, hour, month, season, venue_category,
                                   price_level, rating, review_count, busyness_pct, events_observed, events_unavailable_reason)
     VALUES ${values.join(', ')}`,
    params
  );
}

const SLOTS = [0, 17, 45, 90, 116, 130, 167];
const WEATHER = { temp: 70, humidity: 55, windSpeed: 4, isRaining: false, conditionId: 800 };
const TS = new Date(2026, 7, 14, 20, 0, 0, 0);
const venueFor = (v) => ({
  place_id: placeOf(v.tag),
  name: `Venue ${v.tag}`,
  types: ['bar', 'point_of_interest', 'establishment'],
  rating: 4.3,
  price_level: 2,
  user_ratings_total: 200,
  location: { latitude: v.lat, longitude: v.lng },
});

function resetPredictorCaches() {
  I.__resetNeighborCaches();
  I.__resetVenueLookupCaches();
  I.__resetRecentDeviationCache();
}

// Everything the ordinary venues are served that depends on other venues.
async function servedToOrdinary() {
  resetPredictorCaches();
  const out = {};
  for (const v of ORDINARY) {
    const neighbours = [];
    for (const s of SLOTS) {
      neighbours.push(await I.getNeighborActivity(placeOf(v.tag), v.lat, v.lng, Math.floor(s / 24), s % 24));
    }
    const p = await mlPredictor.predictBusyness(venueFor(v), WEATHER, TS);
    out[v.tag] = { neighbours, score: p.score, confidence: p.confidence, method: p.predictionMethod };
  }
  return out;
}

let before;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-harvested-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'harvestedIsolation', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase('flock_harvested_test');
  pool = new Pool({ connectionString: CONN });
  await migrate(pool);
  roPool = new Pool({ connectionString: CONN, options: '-c default_transaction_read_only=on' });
  for (const v of ORDINARY) await addVenue(v, { harvested: false });
  const r = await refreshCollectedBaselines(pool);
  assert.equal(r.ok, true);
});

test.after(async () => {
  await predictorPool.end().catch(() => {});
  await roPool?.end().catch(() => {});
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  for (const d of [dataDir, ...outDirs]) {
    try {
      if (d) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      console.warn(`[harvestedIsolation] could not remove ${d}: ${err.message}`);
    }
  }
});

test('the ordinary venues are served by the model, with neighbours, before any harvest', async () => {
  before = await servedToOrdinary();
  for (const v of ORDINARY) assert.equal(before[v.tag].method, 'ml', `${v.tag} was not scored by the model`);
  assert.ok(before.n1.neighbours.some((n) => n.count >= 2), 'the Center City box has neighbours to disturb');
  assert.ok(before.n5.neighbours.every((n) => n.count === 0), 'n5 is alone');
});

test('with harvested venues in the box and their baselines built, nothing served to an ordinary venue moves', async () => {
  for (const v of HARVESTED) await addVenue(v, { harvested: true });
  const r = await refreshCollectedBaselines(pool);
  assert.equal(r.ok, true);
  // They did get curves: this is the state an hourly refresh leaves.
  const { rows: [b] } = await pool.query(
    'SELECT COUNT(DISTINCT google_place_id)::int AS venues FROM ml_venue_baselines WHERE google_place_id = ANY($1)',
    [HARVESTED.map((v) => placeOf(v.tag))]
  );
  assert.equal(b.venues, 3, 'buildBaselines did not give the harvested venues their own curves');
  // And they sit in the box: the same range scan without the exclusion counts more.
  const { rows: [raw] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ml_venues v JOIN ml_venue_baselines b ON b.google_place_id = v.google_place_id
      WHERE v.latitude BETWEEN 39.950 - $1::float AND 39.950 + $1::float
        AND v.longitude BETWEEN -75.165 - $1::float AND -75.165 + $1::float`,
    [I.NEIGHBOR_BOX_DEG]
  );
  const { rows: [kept] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ml_venues v JOIN ml_venue_baselines b ON b.google_place_id = v.google_place_id
      WHERE v.latitude BETWEEN 39.950 - $1::float AND 39.950 + $1::float
        AND v.longitude BETWEEN -75.165 - $1::float AND -75.165 + $1::float
        AND v.besttime_status IS DISTINCT FROM 'harvested'`,
    [I.NEIGHBOR_BOX_DEG]
  );
  assert.ok(raw.n > kept.n, 'the harvested venues are not in the box, so this test proves nothing');

  const after = await servedToOrdinary();
  assert.deepEqual(after, before, 'a harvested venue moved an ordinary venue\'s neighbour features or score');
});

test('a harvested venue gets its own model-backed score and the ordinary neighbourhood, nothing subtracted', async () => {
  resetPredictorCaches();
  const { rows: baselines } = await pool.query(
    `SELECT v.google_place_id, b.day_of_week, b.hour, b.baseline FROM ml_venues v
       JOIN ml_venue_baselines b ON b.google_place_id = v.google_place_id
      WHERE v.besttime_status IS DISTINCT FROM 'harvested'`
  );
  const byPlace = new Map();
  for (const r of baselines) byPlace.set(`${r.google_place_id}|${r.day_of_week * 24 + r.hour}`, Number(r.baseline));
  for (const h of HARVESTED) {
    const bLat = Number(h.lat.toFixed(3));
    const bLng = Number(h.lng.toFixed(3));
    const inBox = ORDINARY.filter((o) => o.lat >= bLat - I.NEIGHBOR_BOX_DEG && o.lat <= bLat + I.NEIGHBOR_BOX_DEG
      && o.lng >= bLng - I.NEIGHBOR_BOX_DEG && o.lng <= bLng + I.NEIGHBOR_BOX_DEG);
    for (const s of SLOTS) {
      const got = await I.getNeighborActivity(placeOf(h.tag), h.lat, h.lng, Math.floor(s / 24), s % 24);
      const vals = inBox.map((o) => byPlace.get(`${placeOf(o.tag)}|${s}`)).filter((x) => x !== undefined);
      const want = vals.length === 0 ? { count: 0, mean: 0 }
        : { count: vals.length, mean: Math.max(0, Math.min(100, vals.reduce((a, x) => a + x, 0) / vals.length)) };
      assert.deepEqual(got, want, `${h.tag} slot ${s}`);
    }
    const p = await mlPredictor.predictBusyness(venueFor(h), WEATHER, TS);
    assert.equal(p.predictionMethod, 'ml', `${h.tag} was not scored by the model from its own baseline`);
  }
  // The control: a place with no row at all is the rule engine's.
  const none = await mlPredictor.predictBusyness(venueFor({ tag: 'zz', lat: 39.95, lng: -75.165 }), WEATHER, TS);
  assert.equal(none.predictionMethod, 'rule_engine_no_baseline');
});

// ---------------------------------------------------------------------------
// The export.
// ---------------------------------------------------------------------------
function exportedVenueIds(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const header = lines[0].split(',');
  const at = header.indexOf('venue_id');
  assert.ok(at >= 0, 'no venue_id column');
  return new Set(lines.slice(1).map((l) => Number(l.split(',')[at])));
}

async function exportTo(opts) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-harvested-export-'));
  outDirs.push(outDir);
  const logs = [];
  const result = await exporter.runExport({ pool: roPool, outDir, log: (m) => logs.push(String(m)), ...opts });
  return { result, ids: exportedVenueIds(result.trainPath), log: logs.join('\n') };
}

test('the export leaves harvested venues out by default, includes them when asked, and says which', async () => {
  const harvestedIds = HARVESTED.map((v) => ids[v.tag]);
  const ordinaryIds = ORDINARY.map((v) => ids[v.tag]);
  const rowsOf = async (vids) => (await pool.query(
    'SELECT COUNT(*)::int AS n FROM ml_training_data WHERE venue_id = ANY($1) AND busyness_pct IS NOT NULL', [vids]
  )).rows[0].n;

  const dflt = await exportTo({});
  for (const id of ordinaryIds) assert.ok(dflt.ids.has(id), `ordinary venue ${id} missing from the default export`);
  for (const id of harvestedIds) assert.ok(!dflt.ids.has(id), `harvested venue ${id} reached the default export`);
  assert.equal(dflt.result.trainCount, await rowsOf(ordinaryIds));
  assert.deepEqual(dflt.result.harvested, { included: false, venues: 3, rows: await rowsOf(harvestedIds) });
  assert.match(dflt.log, /Harvested venues \(besttime_status 'harvested'\): 3 venues, \d+ labelled rows, EXCLUDED/);

  const incl = await exportTo({ includeHarvested: true });
  for (const id of [...ordinaryIds, ...harvestedIds]) assert.ok(incl.ids.has(id), `venue ${id} missing with --include-harvested`);
  assert.equal(incl.result.trainCount, await rowsOf([...ordinaryIds, ...harvestedIds]));
  assert.match(incl.log, /INCLUDED \(--include-harvested\)/);
});

test('every label path of the export carries the same exclusion, and only one flag turns it off', () => {
  const clause = "besttime_status IS DISTINCT FROM 'harvested'";
  assert.ok(exporter.cityQuery('philly').text.includes(`v.${clause}`));
  assert.ok(!exporter.cityQuery('philly', {}, { includeHarvested: true }).text.includes(clause));
  assert.ok(exporter.feedbackCandidateQuery('philly').text.includes(`v.${clause}`));
  assert.ok(!exporter.feedbackCandidateQuery('philly', { includeHarvested: true }).text.includes(clause));
  const owner = ownerExport.ownerCandidateQuery('philly', 'SELECT 1 AS baseline', {}, exporter.harvestedClause('v', false)).text;
  assert.ok(owner.includes(`v.${clause}`));
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ml', 'train', 'export_training_data.js'), 'utf8');
  assert.match(src, /venueClause: harvestedClause\('v', includeHarvested\)/, 'the owner path is handed the exclusion');

  assert.deepEqual(exporter.parseExportArgs(['node', 'x']), { includeHarvested: false });
  assert.deepEqual(exporter.parseExportArgs(['node', 'x', '--include-harvested']), { includeHarvested: true });
  assert.match(exporter.parseExportArgs(['node', 'x', '--include-harvest']).error, /Unknown argument "--include-harvest"/,
    'a misspelt flag must not quietly produce the default export');
});

// ---------------------------------------------------------------------------
// The demand list.
// ---------------------------------------------------------------------------
test('a demanded harvested row is a promotion candidate, listed apart, never counted as present', async () => {
  await pool.query(
    'INSERT INTO venue_checkins (venue_place_id) VALUES ($1), ($1), ($2), ($3)',
    [placeOf('h1'), 'ChIJharvestIsolateMissing', placeOf('n1')]
  );
  const { rows: missing } = await pool.query(demand.MISSING_DEMAND_SQL);
  assert.deepEqual(missing.map((r) => r.place_id), ['ChIJharvestIsolateMissing']);
  const { rows: promotable } = await pool.query(demand.HARVESTED_DEMAND_SQL);
  assert.deepEqual(promotable.map((r) => r.place_id), [placeOf('h1')]);
  assert.equal(promotable[0].venue_row_id, ids.h1);
  assert.equal(promotable[0].checkins, 2);
  const report = demand.promotionReport(promotable).join('\n');
  assert.match(report, /1 demanded venues are in ml_venues only as inactive harvested rows/);
  assert.match(report, new RegExp(`PROMOTE\\? ml_venues\\.id=${ids.h1} Venue h1 \\[philly/bar\\]`));
  assert.match(report, /PUTS IT IN THE HOURLY LIVE SWEEP/);

  // Once promoted it is an ordinary active row and leaves the list.
  await pool.query('UPDATE ml_venues SET is_active = true WHERE id = $1', [ids.h1]);
  const { rows: afterPromotion } = await pool.query(demand.HARVESTED_DEMAND_SQL);
  assert.deepEqual(afterPromotion, []);
  await pool.query('UPDATE ml_venues SET is_active = false WHERE id = $1', [ids.h1]);
});

test('the four copies of the status literal agree', () => {
  assert.equal(harvester.HARVEST_STATUS, 'harvested');
  assert.equal(I.HARVESTED_STATUS, harvester.HARVEST_STATUS);
  assert.equal(exporter.HARVESTED_STATUS, harvester.HARVEST_STATUS);
  assert.equal(demand.HARVESTED_STATUS, harvester.HARVEST_STATUS);
});
