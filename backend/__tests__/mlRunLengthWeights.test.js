// ---------------------------------------------------------------------------
// ONE WEIGHT PER VENDOR UPDATE, UNDER node --test.
//
// 81% of consecutive-hour live readings of a venue are identical: BestTime's
// live value refreshes more slowly than the hourly sweep reads it, so one
// vendor estimate is stored for several hours running. prepare_features.py
// divides each live row's tier weight by the length of its run of identical
// consecutive-hour readings (FLOCK_RUN_LENGTH_WEIGHTS, default on), solves the
// weekly anchor weight against the divided total, and train_model.py checks
// weight x divisor per tier. The arithmetic is pinned by
// scripts/ml/train/test_run_length_weights.py; this file runs it with the rest
// of the backend suite. Skipped, not failed, where Python with pandas is absent
// (the mlTrainingContracts rule).
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

test('test_run_length_weights.py passes: what a run is, who is divided, and how it composes with the tiers',
  { skip: PY_TRAIN ? false : 'python with pandas, scikit-learn and xgboost not available' }, () => {
    const env = { ...process.env };
    delete env.FLOCK_RUN_LENGTH_WEIGHTS;
    delete env.FLOCK_WEEKLY_ANCHOR_WEIGHT;
    const r = spawnSync(PY_TRAIN, ['test_run_length_weights.py'], { cwd: TRAIN_DIR, encoding: 'utf8', env });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const summary = r.stdout.match(/(\d+)\/(\d+) passed/);
    assert.ok(summary, r.stdout);
    assert.equal(summary[1], summary[2]);
    assert.ok(Number(summary[2]) >= 9, `only ${summary[2]} checks ran`);
  });
