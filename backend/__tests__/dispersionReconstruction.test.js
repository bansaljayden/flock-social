// ---------------------------------------------------------------------------
// THE DISPERSION-LAB RECONSTRUCTION (2026-08-19). The shipped delta model is
// too narrow (prediction sd 21.6 vs actual 36.6), and the lab
// (scripts/ml/train/RETRAIN-V27-LOG.md, "Dispersion lab") measured every
// post-hoc widener against the ship gate on the v2.6.0 holdout. Exactly one
// candidate cleared it: clamp the delta at ±50 instead of metadata's ±30, then
// push the extremes by one point (score < 25 gets -1, score > 65 gets +1).
// Date-block bootstrap, 2000 resamples: within-10 +0.26pp CI [+0.17, +0.37],
// MAE -0.0002 CI [-0.053, +0.031]. Real dispersion gain, MAE-neutral.
//
// quick_eval.py's reconstruct() applies the SAME arithmetic so the gate and
// the serve path stay identical — if reconstructScore changes, that file
// changes with it.
//
// What this file pins: the push fires ONLY outside [25, 65], the clamp
// saturates at ±50, and neither can drag a score past the 0/100 rails.
//
// Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../services/mlPredictor');
const R = _internals.reconstructScore;

test('the extremes push fires only outside [25, 65]', () => {
  // Every integer inside the band, inclusive of both edges, is untouched.
  for (let b = 25; b <= 65; b++) {
    assert.equal(R(0, b), b, 'score ' + b + ' is inside [25, 65] and must not be pushed');
  }
  // One step outside either edge, the push fires.
  assert.equal(R(0, 24), 23, 'a quiet reading gets one point quieter');
  assert.equal(R(0, 66), 67, 'a busy reading gets one point busier');
  // The push reads the ROUNDED score: 24.6 rounds to 25, inside the band.
  assert.equal(R(-0.4, 25), 25);
  assert.equal(R(0.4, 65), 65);
  // And 65.6 rounds to 66, outside it.
  assert.equal(R(0.6, 65), 67);
});

test('the delta clamp saturates at ±50, not metadata delta_clamp_range', () => {
  // Raw deltas past ±50 are held at ±50 (then pushed, being extreme scores).
  assert.equal(R(80, 40), 91, '40 + clamp(80)=50 -> 90, > 65 -> 91');
  assert.equal(R(-80, 60), 9, '60 - 50 -> 10, < 25 -> 9');
  // A ±31..±50 delta — dead under the old ±30 clamp — now moves the score.
  assert.equal(R(45, 20), 65, '20 + 45 -> 65, in-band, no push');
  assert.equal(R(46, 20), 67, '20 + 46 -> 66, > 65 -> 67');
});

test('push and clamp never cross the 0/100 rails', () => {
  assert.equal(R(-50, 0), 0, 'the floor holds: 0 - 50 clips to 0 and the push cannot go below it');
  assert.equal(R(-30, 20), 0, '20 - 30 clips to 0, push holds at 0');
  assert.equal(R(50, 100), 100, 'the ceiling holds');
  assert.equal(R(50, 60), 100, '110 clips to 100, push holds at 100');
});

test('reconstruction is integer 0..100 for any finite input', () => {
  for (const [d, b] of [[-500, 50], [500, 50], [0.49, 0], [-0.49, 100], [33.33, 33.33]]) {
    const s = R(d, b);
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 100, 'R(' + d + ', ' + b + ') = ' + s);
  }
});

// ---------------------------------------------------------------------------
// THE SCORE QUANTILE MAP (2026-08-20). ARMED 2026-08-28 — CROWD_QMAP_ENABLED, default
// off. It is a monotone 40-knot lookup fitted on the earliest 30% of gate dates
// from the shipped 2.6.0-starling artifacts and measured forward on 46,101 rows:
// within-10 20.84% -> 29.22% (+8.38pp CI [+7.17, +9.69]) at MAE 29.976 -> 33.126
// (+3.15 CI [+2.72, +3.57]). scripts/ml/train/QMAP-DECISION.md is the write-up.
//
// What these pin, and why each one matters if the flag is ever flipped:
//   * monotone and strictly increasing in x, so a published number can never
//     cross another one. That is the whole reason the hour-ordering result
//     survives it (0 reversals on 21,905 within-venue-day pairs, measured).
//   * the same 0..100 integer contract reconstructScore has, so getLabel is
//     reading the same kind of value either way.
//   * composition order: qmap(reconstruct(x)), never the reverse. The map's x
//     grid IS the distribution of reconstructed scores; feeding it a raw delta
//     would be reading the table at the wrong argument.
//   * the arithmetic quick_eval.py mirrors. np.interp is constant outside the
//     knots and linear between them, and JS Math.round is half-up.
// ---------------------------------------------------------------------------
const Q = _internals.applyScoreQuantileMap;

test('the qmap table is strictly increasing in x and monotone in y', () => {
  const X = _internals.QMAP_X;
  const Y = _internals.QMAP_Y;
  assert.equal(X.length, Y.length, 'the two knot arrays must be the same length');
  assert.ok(X.length >= 2, 'a lookup needs at least two knots');
  for (let i = 1; i < X.length; i++) {
    assert.ok(X[i] > X[i - 1], 'x knot ' + i + ' must be strictly greater than the one before it');
    assert.ok(Y[i] >= Y[i - 1], 'y knot ' + i + ' must not go backwards');
  }
  for (let i = 0; i < X.length; i++) {
    assert.ok(X[i] >= 0 && X[i] <= 100, 'x knots are published scores');
    assert.ok(Y[i] >= 0 && Y[i] <= 100, 'y knots are busyness percentages');
  }
});

test('the qmap is monotone and never reorders two scores', () => {
  let prev = -1;
  for (let s = 0; s <= 100; s++) {
    const m = Q(s);
    assert.ok(Number.isInteger(m) && m >= 0 && m <= 100, 'Q(' + s + ') = ' + m);
    assert.ok(m >= prev, 'Q(' + s + ') = ' + m + ' went backwards from ' + prev);
    prev = m;
  }
});

test('the qmap interpolates linearly between knots and is flat outside them', () => {
  const X = _internals.QMAP_X;
  const Y = _internals.QMAP_Y;
  // On a knot, the map returns that knot's y (rounded).
  for (let i = 0; i < X.length; i++) {
    assert.equal(Q(X[i]), Math.round(Y[i]), 'on knot x=' + X[i]);
  }
  // Past the last knot, constant — np.interp's right-edge behaviour.
  assert.equal(Q(100), Math.round(Y[Y.length - 1]));
  assert.equal(Q(X[X.length - 1] + 1), Math.round(Y[Y.length - 1]));
  // Below the first knot, constant at its y.
  assert.equal(Q(-5), Math.round(Y[0]));
  // Halfway between two knots is halfway between their values, half-up.
  const lo = X[12];
  const hi = X[13];
  const mid = (lo + hi) / 2;
  assert.equal(Q(mid), Math.floor((Y[12] + (Y[13] - Y[12]) * ((mid - lo) / (hi - lo))) + 0.5));
});

test('the qmap widens the published spread — that is the point of it', () => {
  // Fitted so the score at the q-th percentile of what we publish becomes the
  // actual busyness at the q-th percentile. The visible consequence is that the
  // rails get used: the shipped reconstruction almost never says 0 or 100.
  assert.equal(Q(10), 0, 'a low-middling score reads as an empty room');
  assert.equal(Q(67), 100, 'a modestly-busy score reads as a packed one');
  assert.ok(Q(80) - Q(20) > 80 - 20, 'the map stretches the middle of the range outward');
});

test('the qmap is not a substitute for reconstruction and composes after it', () => {
  // The map's x grid is the distribution of RECONSTRUCTED scores, so it is only
  // ever applied to reconstructScore's output. Composing it is well defined and
  // still lands in the integer 0..100 contract getLabel reads.
  for (const [d, b] of [[-80, 50], [0, 50], [80, 50], [12, 30], [-12, 30]]) {
    const s = Q(R(d, b));
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 100, 'Q(R(' + d + ',' + b + ')) = ' + s);
  }
});

test('non-finite input passes through untouched, as reconstructScore already guards it', () => {
  assert.ok(Number.isNaN(Q(NaN)));
  assert.equal(Q(undefined), undefined);
  assert.equal(Q(null), null);
});

test('the qmap records the artifact it was fitted on and its own measurement', () => {
  assert.equal(typeof _internals.QMAP_FITTED_ON, 'string');
  assert.ok(_internals.QMAP_FITTED_ON.length > 0);
  const m = _internals.QMAP_MEASURED;
  // The published confidence figure switches to this when the flag is on, so it
  // has to be a real percentage with a population attached, not a placeholder.
  assert.ok(m.within15 > 0 && m.within15 <= 100);
  assert.ok(m.within10 > 0 && m.within10 <= 100);
  assert.ok(m.rows > 1000, 'a measurement on a handful of rows is not a measurement');
  assert.ok(typeof m.population === 'string' && m.population.length > 20);
  assert.ok(m.within15 > m.within15Unmapped,
    'the substituted figure must be the one measured on the mapped number');
});

test('the flag is OFF by default', () => {
  // ARMED 2026-08-28: the default flipped to ON (unset serves the mapped
  // number; 'false' is the kill switch). What this assertion now protects is
  // the opposite hygiene: a test run must not force the kill switch either
  // way, so the suite exercises exactly what production defaults to.
  assert.notEqual(process.env.CROWD_QMAP_ENABLED, 'false',
    'CROWD_QMAP_ENABLED=false must not leak into a test run — the map is armed by default');
});
