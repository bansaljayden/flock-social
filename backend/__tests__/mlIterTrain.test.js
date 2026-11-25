// ---------------------------------------------------------------------------
// AN X KEPT BESIDE ITS PICKLE TRAINS THE SAME MODEL, UNDER node --test.
//
// The November third candidate (about 54 to 90 million training rows) does not
// fit the training PC as one in-memory X plus the copies a fit makes of it, so
// prepare_features.py may write X to a .npy beside features_train.pkl
// (features_io.py) and train_model.py reads it memory-mapped, fitting and
// predicting a row chunk at a time (RowChunks, predict_rows). This runs
// scripts/ml/train/test_iter_train.py, which fits train_model.train_xgboost on
// one fixture with X in memory and beside a pickle, at chunk sizes that split
// cities, and requires the same booster bytes, parameters, metrics, out-of-fold
// predictions and fold shifts, with and without early stopping. Skipped, not
// failed, where Python with pandas, scikit-learn and xgboost is absent.
//
// Run: node --test  (from backend/)
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TRAIN_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'train');
const read = (name) => fs.readFileSync(path.join(TRAIN_DIR, name), 'utf8');

const PY_TRAIN = (() => {
  for (const bin of ['python', 'python3']) {
    const probe = spawnSync(bin, ['-c', 'import pandas, numpy, sklearn, xgboost'], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
})();

test('test_iter_train.py passes: row chunks fit the booster the whole matrix fits',
  { skip: PY_TRAIN ? false : 'python with pandas, scikit-learn and xgboost not available' }, () => {
    const env = { ...process.env, FLOCK_TRAIN_DEVICE: 'cpu' };
    for (const k of ['FLOCK_MAX_DEPTH', 'FLOCK_N_ESTIMATORS', 'FLOCK_HYPERPARAM_SEARCH', 'FLOCK_EARLY_STOPPING_ROUNDS']) delete env[k];
    const r = spawnSync(PY_TRAIN, ['test_iter_train.py'], { cwd: TRAIN_DIR, encoding: 'utf8', env, timeout: 600000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const summary = r.stdout.match(/(\d+)\/(\d+) passed/);
    assert.ok(summary, r.stdout);
    assert.equal(summary[1], summary[2]);
    assert.ok(Number(summary[2]) >= 9, `only ${summary[2]} checks ran`);
  });

test('the chunked fits keep the weights, the fold maps and the reads through features_io', () => {
  const src = read('train_model.py');
  assert.match(src, /data = load_features\(features_path, verify=True\)/,
    'the trainer opens its pickle through features_io, with the X file checked against it');
  assert.match(src, /m\.fit\(RowChunks\(X, train_rows, y, sample_weight, fold_cats=fold_cats,\s*fold_cols=fold_cols, chunk_rows=chunk_rows\), None\)/,
    'each chunked fold fits WITH its own rows\' weights and the fold\'s category map');
  assert.match(src, /model\.fit\(RowChunks\(X, None, y, sample_weight, chunk_rows=chunk_rows\), None\)/,
    'the shipped fit from chunks carries the weights and no fold map');
  assert.match(src, /probe\.fit\(RowChunks\(X, tr, y, sample_weight, fold_cats=fold_cats, fold_cols=fold_cols,/,
    'early stopping from chunks trains on the complement of the held-out cities, with their map');
  assert.match(src, /eval_set=\[\(RowChunks\(X, va, y, fold_cats=fold_cats, fold_cols=fold_cols,/,
    'and evaluates on the held-out cities, unweighted as the in-memory eval set is');
  assert.match(src, /if reads_in_chunks\(X\):\s*raise ValueError\(\s*'FLOCK_HYPERPARAM_SEARCH=true, but X lives beside the pickle/,
    'the search fits whole in-memory copies and is refused on an X kept beside the pickle');
  assert.match(src, /block = np\.array\(X\[start:stop\], order='C'\)/,
    'a chunk is always a copy, so a fold map is never written into X');

  const evaluate = read('evaluate_model.py');
  assert.match(evaluate, /m\.fit\(RowChunks\(X_train_all, train_idx, y_train_all, train_weight\), None\)/,
    'evaluate_model\'s chunked folds refit with the training weights too');
  assert.match(evaluate, /train_data = load_features\(SCRIPT_DIR \/ 'features_train\.pkl', verify=True\)/);

  const gate = read('quick_eval.py');
  assert.match(gate, /train_data = load_features\(SCRIPT_DIR \/ 'features_train\.pkl'\)\n/,
    'the gate reads only baseline, y_actual and feature_cols, so an X beside the pickle stays mapped');
  assert.match(gate, /hold_data = load_features\(SCRIPT_DIR \/ 'features_holdout\.pkl', mmap=False\)/);

  for (const name of ['train_model.py', 'evaluate_model.py', 'quick_eval.py', 'sports_ablation.py',
    'train_two_head.py', 'within_city_eval.py', 'eval_two_head.py', 'hour_ranking_eval.py']) {
    const code = read(name).replace(/"""[\s\S]*?"""/g, '').replace(/#[^\n]*/g, '');
    assert.ok(!/open\([^)]*features_(train|holdout)\.pkl[^)]*\)/.test(code)
      && !/open\((hp|inc_hold_path|holdout_path|features_path)\b/.test(code),
    `${name} opens a feature pickle with open(); read it through features_io.load_features`);
  }
  for (const name of ['sports_ablation.py', 'train_two_head.py']) {
    assert.match(read(name), /if x_is_external\((tr|data)\):\s*\n(\s*#[^\n]*\n)*\s*raise SystemExit/,
      `${name} fits in memory and must refuse an X kept beside the pickle`);
  }
});
