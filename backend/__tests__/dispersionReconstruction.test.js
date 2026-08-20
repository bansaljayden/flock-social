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
