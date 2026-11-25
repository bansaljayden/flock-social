// ---------------------------------------------------------------------------
// THE MODEL'S SIZE MOVES ONLY THROUGH ITS TWO SWITCHES, UNDER node --test.
//
// The November runbook (2026-11-25) lets the capacity probe choose a deeper or
// longer model on training cities. That choice reaches every candidate and the
// final refit through FLOCK_MAX_DEPTH and FLOCK_N_ESTIMATORS in train_model.py,
// recorded in metadata.hyperparameters.size_switches and in best_params, which
// final_refit_gate.py compares. This runs scripts/ml/train/test_size_switches.py:
// unset is the registered 800 trees at depth 8; set, only depth and tree count
// move and the fitted booster has that size; a malformed value or a switch
// beside the search stops the run. Skipped, not failed, where Python with
// pandas, scikit-learn and xgboost is absent.
//
// Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
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

test('test_size_switches.py passes: the registered size unless a switch names another, recorded, refused when malformed',
  { skip: PY_TRAIN ? false : 'python with pandas, scikit-learn and xgboost not available' }, () => {
    const env = { ...process.env };
    for (const k of ['FLOCK_MAX_DEPTH', 'FLOCK_N_ESTIMATORS', 'FLOCK_HYPERPARAM_SEARCH', 'FLOCK_EARLY_STOPPING_ROUNDS']) delete env[k];
    const r = spawnSync(PY_TRAIN, ['test_size_switches.py'], { cwd: TRAIN_DIR, encoding: 'utf8', env });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const summary = r.stdout.match(/(\d+)\/(\d+) passed/);
    assert.ok(summary, r.stdout);
    assert.equal(summary[1], summary[2]);
    assert.ok(Number(summary[2]) >= 7, `only ${summary[2]} checks ran`);
  });

test('the trainer documents both switches and records which one set the size', () => {
  const src = fs.readFileSync(path.join(TRAIN_DIR, 'train_model.py'), 'utf8');
  assert.match(src, /FLOCK_MAX_DEPTH=<int 1\.\.16>/);
  assert.match(src, /FLOCK_N_ESTIMATORS=<int 1\.\.20000>/);
  assert.match(src, /hp_info\['size_switches'\] = /);
  assert.match(src, /params = \{\*\*FIXED_PARAMS, \*\*sizes\}/);
});
