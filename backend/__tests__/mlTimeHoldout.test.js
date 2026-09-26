// ---------------------------------------------------------------------------
// THE TIME HOLDOUT AND THE WEEKLY ANCHOR WEIGHT, UNDER node --test.
//
// prepare_features.py decides which live readings the band gate may score
// (resolve_time_holdout / split_time_holdout: every realtime row on or after
// the cutoff leaves the TRAINING frame before anything is fitted on it) and how
// much of the loss the weekly anchors carry (resolve_weekly_anchor_weight). A
// held-out row left in training scores itself, and nothing downstream could
// tell, so the properties are pinned by scripts/ml/train/test_time_holdout.py
// and this file runs it with the rest of the backend suite. Skipped, not
// failed, where Python with pandas is absent (the mlTrainingContracts rule).
//
// Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TRAIN_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'train');

const PY_PANDAS = (() => {
  for (const bin of ['python', 'python3']) {
    const probe = spawnSync(bin, ['-c', 'import pandas, numpy'], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
})();

test('test_time_holdout.py passes: the cutoff, the split, the served-baseline blend and the anchor weight',
  { skip: PY_PANDAS ? false : 'python with pandas not available' }, () => {
    const r = spawnSync(PY_PANDAS, ['test_time_holdout.py'], { cwd: TRAIN_DIR, encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const summary = r.stdout.match(/(\d+)\/(\d+) passed/);
    assert.ok(summary, r.stdout);
    assert.equal(summary[1], summary[2]);
    assert.ok(Number(summary[2]) >= 11, `only ${summary[2]} checks ran`);
  });

test('the pipeline runs the band gate last and the exporter is not skipped', () => {
  const sh = fs.readFileSync(path.join(TRAIN_DIR, 'run_training.sh'), 'utf8').replace(/\r\n/g, '\n');
  const order = ['node export_training_data.js', 'python prepare_features.py', 'python train_model.py',
    'python evaluate_model.py', 'python quick_eval.py', 'python export_model.py', 'node bandEval.js --gate'];
  let at = -1;
  for (const step of order) {
    const i = sh.indexOf(step);
    assert.ok(i > at, `${step} is missing or out of order in run_training.sh`);
    at = i;
  }
});
