// ---------------------------------------------------------------------------
// THE SERVED BASELINE AND THE TRAINED BASELINE ARE ONE NUMBER.
//
// This is a delta model: production publishes baseline + delta, where the
// baseline is mlPredictor.blendBaselineRows over the ml_venue_baselines rows
// for the slot and its two clock neighbours, and training learns
// delta = busyness - smooth_baseline_hours(...) in prepare_features.py. If the
// two disagree on any slot, the model is served a baseline it never trained
// against there, and whether production answers with the model at all (a
// positive baseline) can differ from whether training kept the row.
//
// They did disagree, on one shape (2026-09-25): a slot whose own baseline row
// holds 0 beside a positive neighbour. blendBaselineRows blends it to a
// positive number and serves the model; smooth_baseline_hours kept the 0, and
// the serving-population filter then dropped every such row from training and
// from the gate. 160 of the 7,920 live September readings bandEval.js scores
// sit on that shape. A slot with NO baseline row stays 0 on both sides.
//
// This runs both implementations over the same random grid of venues, zeros,
// holes and realtime rows, and requires equality on every row. Skipped, not
// failed, where Python with pandas is absent (the same rule as
// mlTrainingContracts.test.js).
//
// Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-smoothing-parity';

const { _internals: I } = require('../services/mlPredictor');

const TRAIN_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'train');

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

function buildGrid() {
  const r = rng(20260925);
  const venues = [];
  const rows = [];
  for (let v = 1; v <= 8; v++) {
    const curve = new Array(168).fill(null);
    for (let s = 0; s < 168; s++) {
      const u = r();
      if (u < 0.12) continue;                           // no baseline row at all
      curve[s] = u < 0.35 ? 0 : 5 * Math.floor(r() * 21); // a row holding 0, or a value
    }
    venues.push({ id: v, curve });
    for (let s = 0; s < 168; s++) {
      if (curve[s] !== null) rows.push({ venue_id: v, day_of_week: Math.floor(s / 24), hour: s % 24, baseline_busyness: curve[s], is_realtime: 0 });
    }
    // realtime rows at random slots, some of them where no weekly row exists;
    // the exporter's COALESCE hands those a baseline of 0
    for (let k = 0; k < 40; k++) {
      const s = Math.floor(r() * 168);
      rows.push({ venue_id: v, day_of_week: Math.floor(s / 24), hour: s % 24, baseline_busyness: curve[s] === null ? 0 : curve[s], is_realtime: 1 });
    }
  }
  return { venues, rows };
}

// What production serves for a row: getBaseline's three-row query, then the blend.
function served(venue, dow, hour) {
  const { prevHour, nextHour, prevDay, nextDay } = I.baselineNeighborSlots(dow, hour);
  const rows = [];
  for (const [d, h] of [[dow, hour], [prevDay, prevHour], [nextDay, nextHour]]) {
    const v = venue.curve[d * 24 + h];
    if (v !== null) rows.push({ day_of_week: d, hour: h, baseline: String(v) });
  }
  return I.blendBaselineRows(rows, dow, hour).data;
}

const DRIVER = `
import sys, json
import pandas as pd
sys.path.insert(0, sys.argv[1])
import prepare_features as pf
rows = json.load(open(sys.argv[2]))
out = pf.smooth_baseline_hours(pd.DataFrame(rows))
print('RESULT ' + json.dumps([float(x) for x in out['baseline_busyness'].tolist()]))
`;

test('smooth_baseline_hours gives every row the baseline blendBaselineRows serves', { skip: PY_PANDAS ? false : 'python with pandas not available' }, () => {
  const { venues, rows } = buildGrid();
  const byId = new Map(venues.map((v) => [v.id, v]));
  const expected = rows.map((row) => served(byId.get(row.venue_id), row.day_of_week, row.hour));

  // The grid must contain the shape this test exists for, and the one it must not change.
  const zeroBlended = rows.filter((row, i) => row.baseline_busyness === 0 && expected[i] > 0);
  const noRowRealtime = rows.filter((row) => row.is_realtime === 1 && byId.get(row.venue_id).curve[row.day_of_week * 24 + row.hour] === null);
  assert.ok(zeroBlended.length >= 20, `only ${zeroBlended.length} zero slots with a positive neighbour`);
  assert.ok(noRowRealtime.length >= 10, `only ${noRowRealtime.length} realtime rows at slots with no baseline row`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-smoothing-'));
  const driver = path.join(dir, 'drive.py');
  const data = path.join(dir, 'rows.json');
  fs.writeFileSync(driver, DRIVER);
  fs.writeFileSync(data, JSON.stringify(rows));
  let r;
  try {
    r = spawnSync(PY_PANDAS, [driver, TRAIN_DIR, data], { encoding: 'utf8', maxBuffer: 1 << 26 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no RESULT line in:\n${r.stdout}\n${r.stderr}`);
  const got = JSON.parse(line.slice(7));
  assert.equal(got.length, rows.length);
  const diff = [];
  rows.forEach((row, i) => {
    if (got[i] !== expected[i]) diff.push({ ...row, python: got[i], production: expected[i] });
  });
  assert.deepEqual(diff.slice(0, 10), [], `${diff.length} of ${rows.length} rows disagree`);
});
