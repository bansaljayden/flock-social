// ---------------------------------------------------------------------------
// THE SPORTS FEATURES ARE ONE COMPUTATION, TRAINING AND SERVING.
//
// prepare_features.add_sports_features builds six game-night columns from
// train/sports_events.csv (exportSportsEvents.js over ml_sports_events).
// Until 2026-09-26 serving computed none of them, so a model trained with them
// read "no game" on every request. mlPredictor.sportsFeatureValues now computes
// them from the same table (cached, read whole); this runs both over one random
// grid and requires the same six values on every row:
//
//   * arenas: home games with coordinates, several games at one arena, home
//     games with no coordinates, away games (which have none);
//   * dates with a home game, with only away games, with an evening game, with
//     a missing start time, and dates with nothing;
//   * venues from on top of an arena to 100 km out, so both the 60 km market
//     gate and the 10 km "near" gate are crossed, plus undated rows (weekly
//     anchors) and a row with no coordinates.
//
// The serving table is built twice, from the CSV through bandEval's reader and
// from rows shaped the way pg returns ml_sports_events, and must agree.
//
// Skipped, not failed, where Python with pandas is absent. Run: node --test
// ---------------------------------------------------------------------------

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-sports-parity';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { _internals: I } = require('../services/mlPredictor');
const B = require('../scripts/ml/train/bandEval');

const TRAIN_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'train');

const PY_PANDAS = (() => {
  for (const bin of ['python', 'python3']) {
    const probe = spawnSync(bin, ['-c', 'import pandas, numpy'], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
})();

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

const ARENAS = [[39.90083333333333, -75.1675], [39.9012, -75.1720], [40.6048, -75.3786], [40.6973, -75.2104]];
const DATES = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10));

function buildGrid() {
  const r = rng(20260928);
  const events = [];
  let id = 1;
  for (const d of DATES) {
    const n = Math.floor(r() * 4);          // 0-3 games that date
    for (let k = 0; k < n; k++) {
      const home = r() < 0.55;
      const a = ARENAS[Math.floor(r() * ARENAS.length)];
      const noCoords = home && r() < 0.1;
      const hour = Math.floor(r() * 24);
      const time = r() < 0.08 ? '' : `${String(hour).padStart(2, '0')}:${r() < 0.5 ? '05' : '30'}:00`;
      events.push({ id: `${id++}:t`, league: 'NFL', team: 't', is_home: home ? 1 : 0, date: d, time,
        lat: home && !noCoords ? a[0] : null, lon: home && !noCoords ? a[1] : null });
    }
  }
  const rows = [];
  for (let k = 0; k < 900; k++) {
    const a = ARENAS[Math.floor(r() * ARENAS.length)];
    // Up to ~100 km from an arena, denser near it.
    const km = 100 * r() ** 2;
    const ang = 2 * Math.PI * r();
    const lat = a[0] + (km / 111.0) * Math.cos(ang);
    const lng = a[1] + (km / (111.0 * Math.cos(a[0] * Math.PI / 180))) * Math.sin(ang);
    const undated = r() < 0.1;
    rows.push({ latitude: lat, longitude: lng, observed_date: undated ? null : DATES[Math.floor(r() * DATES.length)] });
  }
  rows.push({ latitude: null, longitude: null, observed_date: DATES[0] });
  return { events, rows };
}

const DRIVER = `
import sys, json
import numpy as np, pandas as pd
sys.path.insert(0, sys.argv[1])
import prepare_features as pf
rows = pd.DataFrame(json.load(open(sys.argv[2])))
rows['latitude'] = pd.to_numeric(rows['latitude'], errors='coerce')
rows['longitude'] = pd.to_numeric(rows['longitude'], errors='coerce')
df = pf.add_sports_features(rows.copy(), path=sys.argv[3])
out = {c: [float(x) for x in df[c]] for c in pf.SPORTS_FEATURE_NAMES}
out.update({c + '_f32': [float(x) for x in df[c].to_numpy().astype(np.float32)] for c in pf.SPORTS_FEATURE_NAMES})
out['consts'] = [pf.SPORTS_DIST_CAP_KM, pf.SPORTS_LOCAL_KM, pf.SPORTS_HOME_NEAR_KM]
out['names'] = pf.SPORTS_FEATURE_NAMES
print('RESULT ' + json.dumps(out))
`;

test('add_sports_features and sportsFeatureValues agree on every row of a random grid', { skip: PY_PANDAS ? false : 'python with pandas not available' }, (t) => {
  const { events, rows } = buildGrid();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-sports-'));
  const csv = path.join(dir, 'sports_events.csv');
  const data = path.join(dir, 'rows.json');
  const driver = path.join(dir, 'drive.py');
  // exportSportsEvents.js's header and field order.
  const lines = ['sportsdb_event_id,league,team_key,is_home,event_local_date,event_local_time,venue_lat,venue_lon',
    ...events.map((e) => [e.id, e.league, e.team, e.is_home, e.date, e.time, e.lat == null ? '' : e.lat, e.lon == null ? '' : e.lon].join(','))];
  fs.writeFileSync(csv, lines.join('\n') + '\n');
  fs.writeFileSync(data, JSON.stringify(rows));
  fs.writeFileSync(driver, DRIVER);
  let r;
  try {
    r = spawnSync(PY_PANDAS, [driver, TRAIN_DIR, data, csv], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(r.status, 0, r.stderr);
    const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    assert.ok(line, r.stdout + r.stderr);
    const py = JSON.parse(line.slice(7));
    assert.deepEqual(py.names, [...I.SPORTS_FEATURE_NAMES]);
    assert.deepEqual(py.consts, [I.SPORTS_DIST_CAP_KM, I.SPORTS_LOCAL_KM, I.SPORTS_HOME_NEAR_KM]);

    const fromCsv = I.buildSportsTable(B.readSportsCsv(csv));
    // The same schedule as pg returns it: booleans, numbers, NULLs.
    const fromPg = I.buildSportsTable(events.map((e) => ({ is_home: e.is_home === 1, event_local_date: e.date,
      event_local_time: e.time || null, venue_lat: e.lat, venue_lon: e.lon })));
    const js = rows.map((row) => I.sportsFeatureValues(fromCsv, row.latitude, row.longitude, row.observed_date));
    const js2 = rows.map((row) => I.sportsFeatureValues(fromPg, row.latitude, row.longitude, row.observed_date));
    assert.deepEqual(js2, js, 'the CSV and the table read give the same answers');

    // The grid crosses both gates.
    assert.ok(js.some((x) => x.sports_game_today === 1) && js.some((x, i) => x.sports_game_today === 0 && rows[i].observed_date));
    assert.ok(js.some((x) => x.sports_home_within_10km === 1));
    assert.ok(js.some((x) => x.sports_home_game_today === 1 && x.sports_home_within_10km === 0 && x.sports_home_dist_km < I.SPORTS_DIST_CAP_KM));
    assert.ok(js.some((x) => x.sports_game_today === 1 && x.sports_home_game_today === 0), 'away-only dates');
    assert.ok(js.some((x) => x.sports_evening_game === 1) && js.some((x) => x.sports_game_today === 1 && x.sports_evening_game === 0));

    const diff = [];
    const f32 = [];
    let ulps = 0;
    rows.forEach((row, i) => {
      for (const c of I.SPORTS_FEATURE_NAMES) {
        const a = py[c][i];
        const b = js[i][c];
        if (a !== b) {
          // numpy's and V8's sin/asin may differ in the last bit of a
          // distance; that is not a disagreement unless it survives float32
          // or crosses a gate (the integer columns would show it).
          if (c === 'sports_home_dist_km' && Math.abs(a - b) < 1e-9) ulps++;
          else diff.push({ i, c, python: a, serving: b, row });
        }
        if (py[`${c}_f32`][i] !== Math.fround(b)) f32.push({ i, c });
      }
    });
    t.diagnostic(`${rows.length} rows, ${events.length} games, ${fromCsv.arenas.length} arenas; `
      + `${diff.length} disagreements (${ulps} last-bit distance differences)`);
    assert.deepEqual(diff.slice(0, 10), [], `${diff.length} values disagree`);
    assert.deepEqual(f32.slice(0, 10), [], `${f32.length} values disagree after the float32 cast`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the schedule is read once per cache window, and a failed read serves no-game values', async () => {
  const pool = require('../config/database');
  const real = pool.query;
  let calls = 0;
  let fail = false;
  const err = console.error;
  console.error = () => {};
  pool.query = async (text) => {
    assert.match(String(text), /FROM ml_sports_events/);
    calls++;
    if (fail) throw new Error('down');
    return { rows: [{ is_home: true, event_local_date: '2026-09-04', event_local_time: '19:05:00', venue_lat: 40.6, venue_lon: -75.47 }] };
  };
  try {
    I.__resetSportsCache();
    const [a, b] = await Promise.all([I.getSportsTable(), I.getSportsTable()]);
    assert.equal(a, b);
    await I.getSportsTable();
    assert.equal(calls, 1, 'coalesced and cached');
    assert.equal(I.sportsFeatureValues(a, 40.61, -75.47, '2026-09-04').sports_home_within_10km, 1);
    I.__resetSportsCache();
    fail = true;
    assert.equal(await I.getSportsTable(), null);
    await I.getSportsTable();
    assert.equal(calls, 2, 'a failure is remembered briefly rather than retried per request');
    assert.deepEqual(I.sportsFeatureValues(null, 40.61, -75.47, '2026-09-04'), {
      sports_game_today: 0, sports_games_count: 0, sports_evening_game: 0,
      sports_home_game_today: 0, sports_home_dist_km: I.SPORTS_DIST_CAP_KM, sports_home_within_10km: 0,
    });
  } finally {
    pool.query = real;
    console.error = err;
    I.__resetSportsCache();
  }
});
