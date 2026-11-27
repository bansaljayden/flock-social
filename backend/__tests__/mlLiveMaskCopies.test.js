// ---------------------------------------------------------------------------
// MASKED COPIES OF THE REALTIME TRAINING ROWS, UNDER node --test.
//
// Four of the crowd model's live features are built from a venue's past live
// readings, and with no reading serving sends their missing values. The live
// feed stopped on 2026-11-25 and 2.8.0-starling trained on almost no row in
// that state. prepare_features.py can append copies of the realtime training
// rows with those features masked (FLOCK_LIVE_MASK_COPIES=on; off by default,
// in-memory preparation only), and train_model.py, evaluate_model.py,
// quick_eval.py and final_refit_gate.py each tell a copy from an original row.
//
// This runs scripts/ml/train/test_live_mask_copies.py: off writes what the
// preparation always wrote; on appends exactly the copies the rule calls for,
// in order, everything but the masked features the source row's; the trainer
// checks each copy against its source, still refuses a cell with more original
// rows than the frame it was fitted on, and reports every earlier number on
// original rows with the two copy populations beside them; the two refusals;
// the final refit's policy check; and an end-to-end miniature (prepare, train
// 20 small trees, evaluate, point gate), off and on. A golden mismatch under
// numpy or pandas versions other than the goldens' is reported as SKIP, shown
// here as a diagnostic. Skipped, not failed, where Python with pandas,
// scikit-learn and xgboost is absent.
//
// Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ML_DIR = path.join(__dirname, '..', 'scripts', 'ml');
const TRAIN_DIR = path.join(ML_DIR, 'train');
const read = (name) => fs.readFileSync(path.join(TRAIN_DIR, name), 'utf8');

const PY_TRAIN = (() => {
  for (const bin of ['python', 'python3']) {
    const probe = spawnSync(bin, ['-c', 'import pandas, numpy, sklearn, xgboost'], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
})();

// spawnSync blocks the event loop, so the test's own timeout cannot fire while
// it runs: the child gets its own, and the test a minute more to report it.
const RUN_MS = 600000;

test('test_live_mask_copies.py passes: off is unchanged, on appends the copies, the trainer tells them apart',
  { skip: PY_TRAIN ? false : 'python with pandas, scikit-learn and xgboost not available', timeout: RUN_MS + 60000 },
  (t) => {
    const env = { ...process.env };
    for (const k of ['FLOCK_LIVE_MASK_COPIES', 'FLOCK_LIVE_FEATURES', 'FLOCK_MAX_DEPTH', 'FLOCK_N_ESTIMATORS',
      'FLOCK_HYPERPARAM_SEARCH', 'FLOCK_EARLY_STOPPING_ROUNDS', 'FLOCK_TRAIN_DEVICE', 'FLOCK_TRAIN_THREADS',
      'FLOCK_PREP_STREAM', 'FLOCK_PREP_STREAM_MIN_ROWS', 'FLOCK_FINAL_REFIT', 'FLOCK_WEEKLY_ANCHOR_WEIGHT',
      'FLOCK_RUN_LENGTH_WEIGHTS']) delete env[k];
    const r = spawnSync(PY_TRAIN, ['test_live_mask_copies.py'], {
      cwd: TRAIN_DIR, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, timeout: RUN_MS,
    });
    const stdout = r.stdout || '';
    assert.equal(r.status, 0, [
      `status ${r.status}, signal ${r.signal}${r.error ? `, error ${r.error.message}` : ''}`,
      stdout, (r.stderr || '').slice(-4000)].join('\n'));
    for (const line of stdout.match(/^SKIP .*$/gm) || []) t.diagnostic(line);
    const summary = stdout.match(/(\d+)\/(\d+) passed/);
    assert.ok(summary, stdout);
    assert.equal(summary[1], summary[2]);
    assert.ok(Number(summary[2]) >= 19, `only ${summary[2]} checks ran`);
  });

test('the switch is a recorded policy, off by default, with no bypass in the trainer', () => {
  const prepare = read('prepare_features.py');
  assert.match(prepare, /LIVE_MASK_COPIES_ENV = 'FLOCK_LIVE_MASK_COPIES'/);
  assert.match(prepare, /LIVE_MASK_COPIES_POLICY = _policy\(LIVE_MASK_COPIES_ENV, 'off', \{'off', 'on'\}\)/,
    'the switch is declared with _policy and is off unless set');
  assert.match(prepare, /\*\*\(\{'live_mask_copies': live_mask_copies\} if live_mask_copies else \{\}\),/,
    'the record is written into corpus_contract only when the switch is on, so off metadata is unchanged');
  assert.match(prepare, /train_data, live_mask_copies = with_live_mask_copies\(train_data\)/,
    'main() appends the copies to the finished training dict');
  const streamed = prepare.slice(prepare.indexOf('def main_streamed('));
  assert.match(streamed, /require_live_mask_copies_possible\(streamed=True\)/,
    'the streamed preparation refuses the switch before its first pass');
  assert.ok(!/with_live_mask_copies|append_live_mask_copies/.test(streamed),
    'the streamed preparation must not make copies');
  assert.ok(!/masked_copy|MASKED_COPY_KEY/.test(prepare.slice(prepare.indexOf('def holdout_pickle_dict('),
    prepare.indexOf('def write_model_metadata('))), 'the holdout pickle never gets copies');

  const trainer = read('train_model.py');
  assert.match(trainer, /def assert_masked_copies\(/);
  assert.match(trainer, /if \(original_counts > counts\)\.any\(\):/,
    'the subset rule is held on the original rows');
  for (const name of fs.readdirSync(TRAIN_DIR).filter((n) => n.endsWith('.py') && !n.startsWith('test_'))) {
    assert.ok(!/FLOCK_AUGMENTED_COPIES/.test(read(name)), `${name} reads a bypass variable`);
  }
  assert.match(trainer, /slices = slice_report\(y_actual, absolute, is_realtime, baseline, masked_copy=masked_copy\)/);
  assert.match(trainer, /'realtime_offset_only': \(/);
  assert.match(trainer, /'realtime_no_reading': \(/);

  assert.match(read('quick_eval.py'), /original_rows = masked_copy_blocks\(masked_copy_flags\(train_data\)\)\['original'\]/,
    'the gate measures the training baseline on the rows training_metrics describes');
  assert.match(read('evaluate_model.py'), /copy_blocks = masked_copy_blocks\(masked_copy_flags\(train_data\)\)/);
  assert.match(read('final_refit_gate.py'), /out\.extend\(live_mask_copies_problems\(rc, gc\)\)/,
    'a final refit must be prepared with the gated run\'s policy');
});

test('RETRAIN.md documents the switch, its reason and the exploratory result', () => {
  const md = fs.readFileSync(path.join(ML_DIR, 'RETRAIN.md'), 'utf8').replace(/\r\n/g, '\n').replace(/\s+/g, ' ');
  assert.match(md, /FLOCK_LIVE_MASK_COPIES=on/);
  assert.match(md, /exploratory, chosen on the November verdict's own days/);
  for (const figure of ['84.5%', '87.1%', '88.7%', '0.13']) {
    assert.ok(md.includes(figure), `RETRAIN.md no longer quotes ${figure}`);
  }
  assert.match(md, /gated like any other/);
});
