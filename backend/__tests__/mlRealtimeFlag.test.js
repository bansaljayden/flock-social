// ---------------------------------------------------------------------------
// is_realtime IS CARRIED, NOT A FEATURE, UNDER node --test.
//
// mlPredictor.buildFeatureMap sets is_realtime to 1 on every prediction, so as a
// feature it only told the model which label regime a training row came from
// (PRE-RETRAIN-AUDIT finding 18). It left the feature set on 2026-09-25 and
// every training script reads it from the key both pickles carry, through
// prepare_features.realtime_flags; mlTrainingContracts.test.js pins that no
// script still reads it out of X by position. This runs
// scripts/ml/train/test_realtime_flag.py, which checks the reading itself: the
// carried key first, the incumbent's pre-key pickle by position, and a pickle
// with neither refused rather than read as all weekly. Skipped, not failed,
// where Python with pandas, scikit-learn and xgboost is absent.
//
// Serving needs no change for it: orderFeatureVector builds the vector from the
// artifact's own feature_names, so an artifact that does not list is_realtime
// never reads the 1 buildFeatureMap still sets for v2.6.0-starling.
//
// Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const TRAIN_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'train');

const PY_TRAIN = (() => {
  for (const bin of ['python', 'python3']) {
    const probe = spawnSync(bin, ['-c', 'import pandas, numpy, sklearn, xgboost'], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
})();

test('test_realtime_flag.py passes: the carried flag is read, the feature is gone and refused',
  { skip: PY_TRAIN ? false : 'python with pandas, scikit-learn and xgboost not available' }, () => {
    const r = spawnSync(PY_TRAIN, ['test_realtime_flag.py'], { cwd: TRAIN_DIR, encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const summary = r.stdout.match(/(\d+)\/(\d+) passed/);
    assert.ok(summary, r.stdout);
    assert.equal(summary[1], summary[2]);
    assert.ok(Number(summary[2]) >= 7, `only ${summary[2]} checks ran`);
  });

test('an artifact without is_realtime in feature_names builds a vector without it', () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-realtime-flag';
  const { _internals: I } = require('../services/mlPredictor');
  const features = { hour: 20, is_realtime: 1, day_of_week: 5 };
  const withIt = I.orderFeatureVector(features, ['day_of_week', 'hour', 'is_realtime']);
  const without = I.orderFeatureVector(features, ['day_of_week', 'hour']);
  assert.deepEqual(Array.from(withIt), [5, 20, 1]);
  assert.deepEqual(Array.from(without), [5, 20], 'the flag serving sets is dropped by name, not by position');
  // The shipped artifact still lists it, which is why buildFeatureMap keeps the key.
  const meta = require('../scripts/ml/models/model_metadata.json');
  assert.ok(meta.feature_names.includes('is_realtime'), 'the shipped v2.6.0-starling lists it');
});
