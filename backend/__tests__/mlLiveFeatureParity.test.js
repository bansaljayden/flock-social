// ---------------------------------------------------------------------------
// THE LIVE FEATURES ARE ONE COMPUTATION, AND SERVING'S IS THE REFERENCE.
//
// last_live_dev, last_live_age_h, recent_offset, recent_offset_n and
// curve_prev_hour are what mlPredictor.liveFeatureValues returns from the
// venue's stored offset row (the newest readings buildRecentDeviation.js keeps,
// migrations 092 and 093) and the served curve an hour earlier. A model trained
// on them is only served what it learned if prepare_features.add_live_features
// computes the same five numbers from the export.
//
// This builds one random grid of venues, weekly curves (with slots that have
// no row and rows holding 0) and live readings (with forecast-labelled ones,
// readings at slots whose curve is not positive, gaps past the lag cap and the
// offset's 28-day window, midnight and week wraps, and dates that are not
// calendar dates), and runs:
//
//   serving   the real liveFeatureValues, over exactly the lists the builder
//             would have stored right after each row's own hourly sweep (the
//             row's own reading INCLUDED in them, as it is in production),
//             with the curve blended by the real blendBaselineRows;
//   training  prepare_features.build_neighbor_table / build_live_reading_table
//             / smooth_baseline_hours / add_live_features over the same rows
//             written as export rows;
//
// and requires every value to agree on every row, before and after the
// float32 cast the model sees. It also runs test_live_features.py, which
// pins that nothing at or after a row's slot reaches its features.
//
// Skipped, not failed, where Python with pandas is absent (the
// mlSmoothingParity.test.js rule). Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

process.env.TZ = 'UTC';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-live-parity';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { _internals: I } = require('../services/mlPredictor');

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

const DAY_MS = 86400000;
const dateOf = (dayNum) => new Date(dayNum * DAY_MS).toISOString().slice(0, 10);
const dowOf = (dayNum) => new Date(dayNum * DAY_MS).getUTCDay();

function buildGrid() {
  const r = rng(20260927);
  const venues = [];
  for (let id = 1; id <= 14; id++) {
    const curve = new Int16Array(168).fill(-1);
    for (let s = 0; s < 168; s++) {
      const u = r();
      if (u < 0.12) continue;                                 // no row
      curve[s] = u < 0.22 ? 0 : 5 + Math.floor(r() * 90);      // a row holding 0, or a value
    }
    venues.push({ id, curve: id === 14 ? null : curve });      // 14: live readings, no weekly curve
  }
  const start = Math.round(Date.UTC(2026, 7, 1) / DAY_MS);     // 2026-08-01
  const rows = [];
  for (const v of venues) {
    if (!v.curve) continue;
    for (let s = 0; s < 168; s++) {
      if (v.curve[s] < 0) continue;
      rows.push({ venue_id: v.id, day_of_week: Math.floor(s / 24), hour: s % 24, busyness_pct: v.curve[s],
        baseline_busyness: v.curve[s], is_realtime: 0, label_source: '', observed_date: null,
        latitude: 40.6 + v.id * 0.01, longitude: -75.4 });
    }
  }
  for (const v of venues) {
    // Bursts of consecutive hours, then gaps of up to three days, over ~60 days
    // (past the 28-day offset window).
    let t = (start + Math.floor(r() * 5)) * 24 + Math.floor(r() * 24);
    const end = (start + 60) * 24;
    while (t < end) {
      const burst = 1 + Math.floor(r() * 8);
      for (let k = 0; k < burst && t < end; k++, t++) {
        const day = Math.floor(t / 24);
        const hour = t % 24;
        const src = r() < 0.12 ? 'forecast' : 'live';
        const own = v.curve ? v.curve[dowOf(day) * 24 + hour] : -1;
        rows.push({ venue_id: v.id, day_of_week: dowOf(day), hour, busyness_pct: Math.floor(r() * 101),
          baseline_busyness: own >= 0 ? own : 0, is_realtime: 1, label_source: src, observed_date: dateOf(day),
          latitude: 40.6 + v.id * 0.01, longitude: -75.4 });
      }
      t += Math.floor(r() * 72);
    }
  }
  // Dates that are not calendar dates: never a reading, never a served slot.
  rows.push({ ...rows[rows.length - 1], observed_date: '2026-02-31', busyness_pct: 50 });
  rows.push({ ...rows[rows.length - 1], observed_date: '2026-9-01', busyness_pct: 50 });
  return { venues, rows };
}

// What buildRecentDeviation.js would have stored right after slot t's sweep:
// the builder's population, newest slot first, at or before t.
function storedLists(readings, t) {
  const upTo = readings.filter((e) => e.slot <= t).sort((a, b) => b.slot - a.slot);
  const recent = upTo.slice(0, I.NOWCAST_READINGS_KEPT)
    .map((e) => ({ v: e.y, d: e.date, dow: e.dow, h: e.hour, at: null }));
  const offset = upTo.filter((e) => e.slot >= t - I.OFFSET_WINDOW_HOURS).slice(0, I.OFFSET_READINGS_KEPT)
    .map((e) => ({ dev: e.dev, d: e.date, h: e.hour }));
  return { recent, offset };
}

function curveRows(curve, dow, hour) {
  if (!curve) return [];
  const { prevHour, nextHour, prevDay, nextDay } = I.baselineNeighborSlots(dow, hour);
  const out = [];
  for (const [d, h] of [[dow, hour], [prevDay, prevHour], [nextDay, nextHour]]) {
    const v = curve[d * 24 + h];
    if (v >= 0) out.push({ day_of_week: d, hour: h, baseline: String(v), source: 'collected', updated_at: null });
  }
  return out;
}

function served(grid) {
  const byId = new Map(grid.venues.map((v) => [v.id, v]));
  const readings = new Map();
  for (const row of grid.rows) {
    if (row.is_realtime !== 1 || row.label_source !== 'live') continue;
    const v = byId.get(row.venue_id);
    const day = I.slotDayNumber(row.observed_date);
    if (!v.curve || day === null) continue;
    const own = v.curve[row.day_of_week * 24 + row.hour];
    if (!(own > 0)) continue;
    if (!readings.has(v.id)) readings.set(v.id, []);
    readings.get(v.id).push({ slot: day * 24 + row.hour, y: row.busyness_pct, dev: row.busyness_pct - own,
      date: row.observed_date, dow: row.day_of_week, hour: row.hour });
  }
  return grid.rows.map((row) => {
    const v = byId.get(row.venue_id);
    const smoothed = I.blendBaselineRows(curveRows(v.curve, row.day_of_week, row.hour), row.day_of_week, row.hour).data;
    const p = I.baselineNeighborSlots(row.day_of_week, row.hour);
    const curvePrev = I.blendBaselineRows(curveRows(v.curve, p.prevDay, p.prevHour), p.prevDay, p.prevHour).data;
    const day = row.observed_date ? I.slotDayNumber(row.observed_date) : null;
    if (day === null) {
      // Undated (weekly anchors, a malformed date): serving never scores
      // one, and training gives it the missing values.
      return { ...I.liveFeatureValues(null, null, smoothed, curvePrev), dated: false };
    }
    const t = day * 24 + row.hour;
    const { recent, offset } = storedLists(readings.get(v.id) || [], t);
    const entry = {
      readings: I.parseRecentReadings(JSON.stringify(recent)),
      offsetReadings: I.parseOffsetReadings(JSON.stringify(offset)),
      fresh: true,
    };
    // The slot through the serving clock, exactly as predictBusyness takes it.
    const ts = new Date(Date.UTC(...row.observed_date.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0)), row.hour, 30));
    assert.equal(I.venueSlotOf(ts), t);
    return { ...I.liveFeatureValues(entry, I.venueSlotOf(ts), smoothed, curvePrev), dated: true };
  });
}

const DRIVER = `
import sys, json
import numpy as np, pandas as pd
sys.path.insert(0, sys.argv[1])
import prepare_features as pf
rows = pd.DataFrame(json.load(open(sys.argv[2])))
nt = pf.build_neighbor_table([rows])
table = pf.build_live_reading_table([rows], nt)
df = pf.smooth_baseline_hours(rows.copy())
df = pf.add_live_features(df, table, nt)
out = {c: [float(x) for x in df[c]] for c in pf.LIVE_FEATURE_NAMES}
out.update({c + '_f32': [float(x) for x in df[c].to_numpy().astype(np.float32)] for c in pf.LIVE_FEATURE_NAMES})
out['names'] = pf.LIVE_FEATURE_NAMES
out['consts'] = [pf.LIVE_MISSING_AGE_H, pf.NOWCAST_MAX_LAG_HOURS, pf.OFFSET_WINDOW_HOURS,
                 pf.OFFSET_MAX_READINGS, pf.DEVIATION_MIN_READINGS, pf.DEVIATION_CLAMP]
print('RESULT ' + json.dumps(out))
`;

function runPython(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-live-'));
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

const skip = PY_PANDAS ? false : 'python with pandas not available';

test('add_live_features gives every row the five values liveFeatureValues serves', { skip }, (t) => {
  const grid = buildGrid();
  const js = served(grid);
  const py = runPython(grid.rows);
  assert.deepEqual(py.names, [...I.LIVE_FEATURE_NAMES]);
  assert.deepEqual(py.consts, [I.LIVE_MISSING_AGE_H, I.NOWCAST_MAX_LAG_HOURS, I.OFFSET_WINDOW_HOURS,
    I.OFFSET_MAX_READINGS, I.DEVIATION_MIN_READINGS, I.DEVIATION_CLAMP]);

  // The grid must exercise what decides the answer.
  const dated = js.filter((x) => x.dated);
  const lags = new Set(dated.filter((x) => x.last_live_age_h !== I.LIVE_MISSING_AGE_H).map((x) => x.last_live_age_h));
  assert.ok(lags.size >= 8, `only lags ${[...lags]} reached`);
  assert.ok(dated.some((x) => x.last_live_age_h === I.LIVE_MISSING_AGE_H), 'rows with no reading inside the lag cap');
  assert.ok(dated.some((x) => x.recent_offset_n === I.OFFSET_MAX_READINGS), 'rows whose offset hits the depth');
  assert.ok(dated.some((x) => x.recent_offset_n > 0 && x.recent_offset_n < I.OFFSET_MAX_READINGS), 'shallow offsets');
  assert.ok(dated.some((x) => !Number.isInteger(x.recent_offset)), 'even-count medians between two values');
  assert.ok(js.some((x) => x.curve_prev_hour === 0) && js.some((x) => x.curve_prev_hour > 0));

  const diff = [];
  const f32diff = [];
  grid.rows.forEach((row, i) => {
    for (const c of I.LIVE_FEATURE_NAMES) {
      if (py[c][i] !== js[i][c]) diff.push({ i, c, venue: row.venue_id, date: row.observed_date, hour: row.hour, python: py[c][i], serving: js[i][c] });
      if (py[`${c}_f32`][i] !== Math.fround(js[i][c])) f32diff.push({ i, c });
    }
  });
  t.diagnostic(`${grid.rows.length} rows (${dated.length} dated), lags reached ${[...lags].sort((a, b) => a - b).join(',')}; ${diff.length} disagreements`);
  assert.deepEqual(diff.slice(0, 10), [], `${diff.length} values disagree`);
  assert.deepEqual(f32diff.slice(0, 10), [], `${f32diff.length} values disagree after the float32 cast`);
});

test('test_live_features.py passes: nothing at or after a row\'s slot reaches its features', { skip }, () => {
  const r = spawnSync(PY_PANDAS, ['test_live_features.py'], { cwd: TRAIN_DIR, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /ok {3}test_nothing_at_or_after_the_slot_moves_a_feature/);
  assert.match(r.stdout, /\b0 failure\(s\)/);
});

test('serving builds the five features for an artifact that lists them, and defaults them otherwise', async () => {
  const log = console.log;
  console.log = () => {};
  try { await require('../services/mlPredictor').init(); } finally { console.log = log; }
  const venue = { place_id: 'p', types: ['bar'], location: { latitude: 40.6, longitude: -75.4 } };
  const map = I.buildFeatureMap(venue, null, new Date(Date.UTC(2026, 8, 6, 19, 30)), null, null, 50, null);
  for (const c of I.LIVE_FEATURE_NAMES) assert.equal(map[c], I.LIVE_FEATURE_DEFAULTS[c], c);
  assert.equal(map.last_live_age_h, I.LIVE_MISSING_AGE_H);
  const live = { last_live_dev: 12, last_live_age_h: 1, recent_offset: -4.5, recent_offset_n: 7, curve_prev_hour: 44 };
  const withLive = I.buildFeatureMap(venue, null, new Date(Date.UTC(2026, 8, 6, 19, 30)), null, null, 50, null, { live });
  for (const c of I.LIVE_FEATURE_NAMES) assert.equal(withLive[c], live[c], c);
  assert.equal(I.artifactReadsLiveFeatures({ feature_names: ['hour', 'curve_prev_hour'] }), true);
  assert.equal(I.artifactLearnsOffset({ feature_names: ['hour', 'curve_prev_hour'] }), false);
  assert.equal(I.artifactLearnsOffset({ feature_names: ['recent_offset'] }), true);
  // A stale offset row carries no offset, as a switched number's does not.
  const entry = { readings: [], offsetReadings: I.parseOffsetReadings([{ dev: 10, d: '2026-09-06', h: 10 }, { dev: 20, d: '2026-09-06', h: 11 }]), fresh: false };
  assert.equal(I.liveFeatureValues(entry, I.slotDayNumber('2026-09-06') * 24 + 19, 50, 0).recent_offset_n, 0);
  assert.equal(I.liveFeatureValues({ ...entry, fresh: true }, I.slotDayNumber('2026-09-06') * 24 + 19, 50, 0).recent_offset, 15);
});
