// ---------------------------------------------------------------------------
// THE NEIGHBOUR FEATURES ARE ONE COMPUTATION, AND SERVING'S IS THE REFERENCE.
//
// log_neighbor_count and neighbor_baseline_same_hour are what
// mlPredictor.getNeighborActivity returns: a box of +/-NEIGHBOR_BOX_DEG around
// the venue's coordinates rounded by toFixed(3), every venue in it with an
// ml_venue_baselines row for the slot, that row's raw value, the venue itself
// taken back out. prepare_features.py used to compute something else: a
// 0.005-degree grid of SMOOTHED baselines, venues keyed on rounded
// coordinates, realtime rows at slots no weekly row holds counted as
// neighbours. On the 8,006 live September readings bandEval.js replays, the
// count disagreed on 58.6% of rows (by 1.58 venues on average) and the mean by
// 3.3 points on average (p90 7.0), so the model was served neighbour values it
// never trained on.
//
// This runs the real getNeighborActivity, against a pool that answers its two
// statements from one random grid, and prepare_features.build_neighbor_table /
// add_neighbor_features over the same grid as export rows, and requires the
// same count and the same mean on every row. The grid carries the shapes that
// decide it: box edges exactly on the boundary and one ulp beyond it, coordinates
// whose third decimal is an exact rounding tie, two venues at one address,
// baseline rows holding 0, slots with no row, a venue with live readings and no
// weekly row, a venue alone in its box. The arithmetic this replaced is kept in
// the driver, verbatim, so the test also shows it disagreeing on the same grid.
//
// Skipped, not failed, where Python with pandas is absent (the
// mlSmoothingParity.test.js rule). Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-neighbor-parity';

const pool = require('../config/database');
const { _internals: I } = require('../services/mlPredictor');

const TRAIN_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'train');
const BOX = I.NEIGHBOR_BOX_DEG;

const PY_PANDAS = (() => {
  for (const bin of ['python', 'python3']) {
    const probe = spawnSync(bin, ['-c', 'import pandas, numpy'], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
})();

// Deterministic, so a failure reproduces.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The adjacent doubles, for coordinates one ulp outside a box edge.
function ulpStep(x, up) {
  const f = new Float64Array([x]);
  const b = new BigInt64Array(f.buffer);
  b[0] += (x > 0) === up ? 1n : -1n;
  return f[0];
}

const placeIdOf = (id) => `ChIJneighbourParity${String(id).padStart(4, '0')}`;

function buildGrid() {
  const r = rng(20260926);
  const round7 = (x) => Math.round(x * 1e7) / 1e7;
  const venues = [];
  const add = (lat, lng, extra = {}) => {
    const v = { id: venues.length + 1, lat, lng, ...extra };
    venues.push(v);
    return v;
  };
  // Four neighbourhoods, each about three boxes wide, on both sides of the
  // equator and the meridian.
  const CLUSTERS = [[40.6023, -75.4714], [25.7617, -80.1918], [-33.8688, 151.2093], [-34.6037, -58.3816]];
  for (const [clat, clng] of CLUSTERS) {
    for (let k = 0; k < 14; k++) add(round7(clat + (r() - 0.5) * 0.024), round7(clng + (r() - 0.5) * 0.024));
  }
  const tags = {};
  // Two venues at one address: two ml_venues rows, both counted.
  tags.twin = add(venues[3].lat, venues[3].lng).id;
  // Third-decimal ties that are exact in binary (m + odd/16): toFixed takes the
  // larger magnitude, so 40.5625 -> 40.563 and -75.3125 -> -75.313, where a
  // round-half-to-even would centre the box on 40.562 and -75.312. The two
  // venues after it sit inside the first box and outside the second.
  tags.tie = add(40.5625, -75.3125).id;
  tags.tieDecides = [add(40.5702, -75.3125).id, add(40.5625, -75.3202).id];
  add(40.5565, -75.3085);
  // Four-decimal coordinates ending in 5: not representable, so the exact
  // binary value decides which way they round.
  add(40.6005, -75.4705);
  add(40.6015, -75.4715);
  add(25.7615, -80.1925);
  // Every box edge. The range scan's BETWEEN is `bLat - BOX <= x <= bLat + BOX`
  // with both ends computed in float8, so a venue exactly on a computed edge is
  // inside and one ulp beyond it is outside. |x - bLat| <= BOX, the tempting
  // rewrite, disagrees wherever the computed edge rounded away from the centre
  // (for a coordinate in [16, 64) it always does, in [64, 256) never), so each
  // edge is placed around a centre where it did.
  const away = (b, sign) => Math.abs((b + sign * BOX) - b) > BOX;
  tags.edges = [];
  for (const [axis, sign] of [['lat', 1], ['lat', -1], ['lng', 1], ['lng', -1]]) {
    const c = venues.slice(0, 14 * CLUSTERS.length).find((v) => away(Number(v[axis].toFixed(3)), sign));
    assert.ok(c, `no centre whose ${axis} edge rounds away from it`);
    const edge = Number(c[axis].toFixed(3)) + sign * BOX;
    const beyond = ulpStep(edge, sign > 0);
    const at = (x) => (axis === 'lat' ? add(x, c.lng) : add(c.lat, x)).id;
    tags.edges.push({ centre: c.id, axis, inside: at(edge), outside: at(beyond) });
  }
  // Alone in its box: serving answers {count: 0, mean: 0}.
  tags.alone = add(41.2, -76.9).id;
  // Live readings and no weekly row: asked about, never anybody's neighbour.
  tags.noCurve = add(round7(40.6023 + 0.001), round7(-75.4714 - 0.002), { noCurve: true }).id;

  for (const v of venues) {
    v.placeId = placeIdOf(v.id);
    if (v.noCurve) { v.curve = null; continue; }
    v.curve = new Int16Array(168).fill(-1);
    for (let s = 0; s < 168; s++) {
      const u = r();
      if (u < 0.15) continue;                          // no baseline row for the slot
      v.curve[s] = u < 0.35 ? 0 : 5 * Math.floor(r() * 21); // a row holding 0, or a value
    }
  }

  // Export rows: every weekly row, then realtime rows at random slots, some
  // where the venue has no weekly row (the exporter's COALESCE gives those 0).
  const rows = [];
  for (const v of venues) {
    if (!v.curve) continue;
    for (let s = 0; s < 168; s++) {
      if (v.curve[s] < 0) continue;
      rows.push({ venue_id: v.id, day_of_week: Math.floor(s / 24), hour: s % 24,
        baseline_busyness: v.curve[s], is_realtime: 0, latitude: v.lat, longitude: v.lng });
    }
  }
  for (const v of venues) {
    for (let k = 0; k < 25; k++) {
      const s = Math.floor(r() * 168);
      rows.push({ venue_id: v.id, day_of_week: Math.floor(s / 24), hour: s % 24,
        baseline_busyness: v.curve && v.curve[s] >= 0 ? v.curve[s] : 0, is_realtime: 1,
        latitude: v.lat, longitude: v.lng });
    }
  }
  return { venues, rows, tags };
}

// ── The two statements getNeighborActivity runs, answered from the grid ─────
// Each is matched on its own clauses, the range scan on its exact BETWEEN
// arithmetic, so a change to serving's SQL fails here instead of being modelled
// with the old meaning. An unrecognised statement is recorded and fails the test.
let GRID = null;
const unknown = [];
const realQuery = pool.query;
pool.query = (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (/FROM ml_venues v JOIN ml_venue_baselines b ON b\.google_place_id = v\.google_place_id/.test(sql)
      && /WHERE v\.latitude BETWEEN \$1 - \$3::float AND \$1 \+ \$3::float AND v\.longitude BETWEEN \$2 - \$3::float AND \$2 \+ \$3::float/.test(sql)
      && /GROUP BY b\.day_of_week, b\.hour/.test(sql)) {
    // Postgres evaluates `$1 - $3::float` in float8, which is this arithmetic.
    const [lat, lng, box] = params.map(Number);
    const latLo = lat - box;
    const latHi = lat + box;
    const lngLo = lng - box;
    const lngHi = lng + box;
    const cnt = new Array(168).fill(0);
    const sum = new Array(168).fill(0);
    for (const v of GRID.venues) {
      if (!v.curve) continue; // the JOIN: no baseline rows, no row out
      if (!(v.lat >= latLo && v.lat <= latHi && v.lng >= lngLo && v.lng <= lngHi)) continue;
      for (let s = 0; s < 168; s++) if (v.curve[s] >= 0) { cnt[s]++; sum[s] += v.curve[s]; }
    }
    const rows = [];
    for (let s = 0; s < 168; s++) {
      // COUNT(*)::int, and SUM(smallint) arrives from pg as a bigint string.
      if (cnt[s] > 0) rows.push({ dow: Math.floor(s / 24), hour: s % 24, cnt: cnt[s], sum_bl: String(sum[s]) });
    }
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  if (/FROM ml_venues v JOIN ml_venue_baselines b ON b\.google_place_id = v\.google_place_id/.test(sql)
      && /WHERE v\.google_place_id = \$1$/.test(sql)) {
    const v = GRID.byPlace.get(params[0]);
    const rows = [];
    if (v && v.curve) {
      for (let s = 0; s < 168; s++) {
        if (v.curve[s] >= 0) rows.push({ lat: v.lat, lng: v.lng, dow: Math.floor(s / 24), hour: s % 24, baseline: v.curve[s] });
      }
    }
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  unknown.push(sql);
  return Promise.resolve({ rows: [], rowCount: 0 });
};

test.after(() => {
  pool.query = realQuery;
  return pool.end().catch(() => {});
});

// build_neighbor_table + add_neighbor_features over the rows, and the
// arithmetic they replaced, verbatim, over the smoothed baselines it read.
const DRIVER = `
import sys, json
import numpy as np, pandas as pd
sys.path.insert(0, sys.argv[1])
import prepare_features as pf

def legacy_neighbor_features(df):
    df['_vkey'] = df['latitude'].round(5).astype(str) + '_' + df['longitude'].round(5).astype(str)
    vb = (
        df[pf.vendor_provenance_mask(df)]
        .groupby(['_vkey', 'day_of_week', 'hour'])
        .agg(bl=('baseline_busyness', 'mean'), lat=('latitude', 'first'), lng=('longitude', 'first'))
        .reset_index()
    )
    vb['bx'] = (vb['lat'] / 0.005).round().astype(np.int32)
    vb['by'] = (vb['lng'] / 0.005).round().astype(np.int32)
    bucket = (
        vb.groupby(['bx', 'by', 'day_of_week', 'hour'])
        .agg(b_sum=('bl', 'sum'), b_cnt=('bl', 'size'))
        .reset_index()
    )
    shifted = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            s = bucket.copy()
            s['bx'] = s['bx'] + dx
            s['by'] = s['by'] + dy
            shifted.append(s)
    window = (
        pd.concat(shifted, ignore_index=True)
        .groupby(['bx', 'by', 'day_of_week', 'hour'])
        .agg(w_sum=('b_sum', 'sum'), w_cnt=('b_cnt', 'sum'))
        .reset_index()
    )
    vb = vb.merge(window, on=['bx', 'by', 'day_of_week', 'hour'], how='left')
    vb['neighbor_count'] = (vb['w_cnt'].fillna(1) - 1).clip(lower=0)
    vb['neighbor_baseline_same_hour'] = np.where(
        vb['neighbor_count'] > 0,
        (vb['w_sum'].fillna(vb['bl']) - vb['bl']) / vb['neighbor_count'].replace(0, 1),
        0.0,
    )
    nb = vb[['_vkey', 'day_of_week', 'hour', 'neighbor_count', 'neighbor_baseline_same_hour']]
    df = df.merge(nb, on=['_vkey', 'day_of_week', 'hour'], how='left')
    df['neighbor_count'] = df['neighbor_count'].fillna(0)
    df['neighbor_baseline_same_hour'] = df['neighbor_baseline_same_hour'].fillna(0).clip(0, 100)
    return df

rows = pd.DataFrame(json.load(open(sys.argv[2])))
table = pf.build_neighbor_table([rows])
out = pf.add_neighbor_features(rows.copy(), table)
legacy = legacy_neighbor_features(pf.smooth_baseline_hours(rows.copy()))
print('RESULT ' + json.dumps({
    'count': [float(x) for x in out['neighbor_count']],
    'mean': [float(x) for x in out['neighbor_baseline_same_hour']],
    'log_count_f32': [float(x) for x in out['log_neighbor_count'].to_numpy().astype(np.float32)],
    'mean_f32': [float(x) for x in out['neighbor_baseline_same_hour'].to_numpy().astype(np.float32)],
    'legacy_count': [float(x) for x in legacy['neighbor_count']],
    'legacy_mean': [float(x) for x in legacy['neighbor_baseline_same_hour']],
    'venues_with_curve': table['venues_with_curve'],
}))
`;

function runPython(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-neighbours-'));
  const driver = path.join(dir, 'drive.py');
  const data = path.join(dir, 'rows.json');
  fs.writeFileSync(driver, DRIVER);
  fs.writeFileSync(data, JSON.stringify(rows));
  let r;
  try {
    r = spawnSync(PY_PANDAS, [driver, TRAIN_DIR, data], { encoding: 'utf8', maxBuffer: 1 << 27 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no RESULT line in:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice(7));
}

test('add_neighbor_features gives every row the count and mean getNeighborActivity serves', { skip: PY_PANDAS ? false : 'python with pandas not available' }, async (t) => {
  GRID = buildGrid();
  GRID.byPlace = new Map(GRID.venues.map((v) => [v.placeId, v]));
  const byId = new Map(GRID.venues.map((v) => [v.id, v]));
  I.__resetNeighborCaches();

  const served = [];
  for (const row of GRID.rows) {
    const v = byId.get(row.venue_id);
    served.push(await I.getNeighborActivity(v.placeId, row.latitude, row.longitude, row.day_of_week, row.hour));
  }
  assert.deepEqual(unknown, [], 'the stub pool did not model a statement getNeighborActivity ran');

  // The grid has to exercise what decides the answer, or equality proves little.
  const at = (id) => GRID.rows.map((row, i) => (row.venue_id === id ? i : -1)).filter((i) => i >= 0);
  assert.ok(at(GRID.tags.alone).every((i) => served[i].count === 0), 'the lone venue has no neighbours');
  assert.ok(served.filter((s) => s.count > 0).length > GRID.rows.length / 2, 'most rows must have neighbours');
  const selfSubtracted = GRID.rows.filter((row) => byId.get(row.venue_id).curve
    && byId.get(row.venue_id).curve[row.day_of_week * 24 + row.hour] >= 0).length;
  assert.ok(selfSubtracted > 1000 && selfSubtracted < GRID.rows.length, 'rows with and without an own baseline row');
  for (const e of GRID.tags.edges) {
    const c = byId.get(e.centre);
    const cLat = Number(c.lat.toFixed(3));
    const cLng = Number(c.lng.toFixed(3));
    const between = (v) => v.lat >= cLat - BOX && v.lat <= cLat + BOX && v.lng >= cLng - BOX && v.lng <= cLng + BOX;
    const abs = (v) => Math.abs(v.lat - cLat) <= BOX && Math.abs(v.lng - cLng) <= BOX;
    const inside = byId.get(e.inside);
    assert.ok(between(inside), `the ${e.axis} edge venue ${e.inside} is inside the box`);
    assert.ok(!abs(inside), `the ${e.axis} edge venue ${e.inside} must be one an |x - centre| test would drop`);
    assert.ok(!between(byId.get(e.outside)), `the venue one ulp beyond the ${e.axis} edge is outside`);
  }
  const tie = byId.get(GRID.tags.tie);
  assert.equal(tie.lat.toFixed(3), '40.563', 'the tie rounds to the larger magnitude');
  assert.equal(tie.lng.toFixed(3), '-75.313');
  for (const id of GRID.tags.tieDecides) {
    const v = byId.get(id);
    assert.ok(v.lat <= 40.563 + BOX && v.lng >= -75.313 - BOX, `venue ${id} is in the box toFixed centres`);
    assert.ok(v.lat > 40.562 + BOX || v.lng < -75.312 - BOX, `venue ${id} is outside a half-to-even box`);
  }

  const py = runPython(GRID.rows);
  assert.equal(py.count.length, GRID.rows.length);
  assert.equal(py.venues_with_curve, GRID.venues.filter((v) => v.curve).length);

  const diff = [];
  const featureDiff = [];
  let legacyDiff = 0;
  GRID.rows.forEach((row, i) => {
    const s = served[i];
    if (py.count[i] !== s.count || py.mean[i] !== s.mean) {
      diff.push({ ...row, python: [py.count[i], py.mean[i]], serving: [s.count, s.mean] });
    }
    // The two values the model is handed, as the Float32Array holds them.
    if (py.log_count_f32[i] !== Math.fround(Math.log1p(s.count)) || py.mean_f32[i] !== Math.fround(s.mean)) {
      featureDiff.push({ ...row, python: [py.log_count_f32[i], py.mean_f32[i]], serving: [Math.fround(Math.log1p(s.count)), Math.fround(s.mean)] });
    }
    if (py.legacy_count[i] !== s.count || Math.abs(py.legacy_mean[i] - s.mean) > 1e-9) legacyDiff++;
  });
  t.diagnostic(`${GRID.rows.length} rows over ${GRID.venues.length} venues: the replaced arithmetic disagrees with serving on ${legacyDiff}, this one on ${diff.length}`);
  assert.deepEqual(diff.slice(0, 10), [], `${diff.length} of ${GRID.rows.length} rows disagree`);
  assert.deepEqual(featureDiff.slice(0, 10), [], `${featureDiff.length} feature values disagree after the float32 cast`);
  // The grid tells the two apart: the old arithmetic is wrong on it.
  assert.ok(legacyDiff > GRID.rows.length * 0.25,
    `the replaced grid arithmetic disagrees on only ${legacyDiff} of ${GRID.rows.length} rows; the grid no longer tells them apart`);
});
