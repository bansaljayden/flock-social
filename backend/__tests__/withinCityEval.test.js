'use strict';
// ---------------------------------------------------------------------------
// SOURCE-LEVEL PINS FOR scripts/ml/train/within_city_eval.py
//
// within_city_eval.py is the only measurement of the crowd model on the
// population it actually serves in cities it has already seen (see
// scripts/ml/WITHIN-CITY-EVAL.md). Its whole claim rests on three properties
// that a reader cannot verify and a future edit can break silently:
//
//   1. It REFITS with the shipped recipe. The script cannot import
//      train_model.FIXED_PARAMS, because importing train_model runs a
//      module-level CUDA probe, so the params are copied. A copy drifts. If
//      someone tunes train_model.py and this file is not updated, the eval
//      keeps reporting confident numbers about a model nobody ships.
//
//   2. It uses prepare_features.serving_population_mask, imported, not a second
//      local definition of who gets served. That is audit finding 6's whole
//      point and quick_eval.py already obeys it.
//
//   3. It writes NOTHING into train/ or models/. The retrain artifacts were
//      being read by other processes while this ran, and an eval script that
//      can overwrite best_model.pkl is one typo from destroying a 21-minute
//      training run.
//
// These are static-source assertions on purpose. Running the eval needs the
// 632MB training CSV and four XGBoost fits; that is not a unit test. What IS
// checkable in a second is that the script still describes the shipped model.
// ZERO paid API calls, no database, no model load.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TRAIN_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'train');
const EVAL_PATH = path.join(TRAIN_DIR, 'within_city_eval.py');
const TRAIN_MODEL_PATH = path.join(TRAIN_DIR, 'train_model.py');
const METADATA_PATH = path.join(__dirname, '..', 'scripts', 'ml', 'models',
  'model_metadata.json');

const read = (p) => fs.readFileSync(p, 'utf8');

// Pull a `NAME = { ... }` python dict literal out of a source file and parse the
// scalar key/value pairs. Deliberately dumb: it only has to handle the two
// literals below, and anything it cannot parse fails loudly rather than
// returning a partial dict that would compare equal by accident.
function pythonDict(source, name) {
  const start = source.indexOf(`${name} = {`);
  assert.ok(start >= 0, `${name} not found`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  assert.ok(close > open, `${name} is not a single-brace literal any more`);
  const body = source.slice(open + 1, close);
  const out = {};
  for (const part of body.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^'([^']+)'\s*:\s*([0-9.]+)$/);
    assert.ok(m, `cannot parse ${name} entry: ${trimmed}`);
    out[m[1]] = Number(m[2]);
  }
  return out;
}

test('within_city_eval refits with train_model.py\'s shipped hyperparameters', () => {
  const evalParams = pythonDict(read(EVAL_PATH), 'FIXED_PARAMS');
  const trainParams = pythonDict(read(TRAIN_MODEL_PATH), 'FIXED_PARAMS');
  assert.deepStrictEqual(
    evalParams, trainParams,
    'within_city_eval.py FIXED_PARAMS has drifted from train_model.py. The '
    + 'within-city numbers in scripts/ml/WITHIN-CITY-EVAL.md describe a model '
    + 'that is no longer the one being trained. Re-copy the params and re-run '
    + 'the eval before trusting anything in that file.');
});

test('within_city_eval reconstructs with the clamp the metadata ships', () => {
  const src = read(EVAL_PATH);
  const m = src.match(/^CLAMP = \((-?[0-9.]+), (-?[0-9.]+)\)/m);
  assert.ok(m, 'CLAMP literal not found in within_city_eval.py');
  const clamp = [Number(m[1]), Number(m[2])];
  const meta = JSON.parse(read(METADATA_PATH));
  assert.deepStrictEqual(
    clamp, meta.delta_clamp_range,
    'within_city_eval.py clamps the delta differently from '
    + 'model_metadata.json.delta_clamp_range, so its reconstruction is not the '
    + 'one services/mlPredictor.js performs and its accuracy numbers are not '
    + 'the product\'s accuracy.');
});

test('within_city_eval imports the serving population rather than redefining it', () => {
  const src = read(EVAL_PATH);
  assert.match(
    src, /from prepare_features import serving_population_mask/,
    'within_city_eval.py must import serving_population_mask from '
    + 'prepare_features — the same predicate prepare_features filters TRAINING '
    + 'with and quick_eval.py gates on (audit finding 6).');
  assert.doesNotMatch(
    src, /^def serving_population_mask/m,
    'within_city_eval.py defines its OWN serving_population_mask. Two '
    + 'definitions of who gets served is exactly the drift the import exists '
    + 'to prevent.');
});

test('within_city_eval never writes into train/ or models/', () => {
  const src = read(EVAL_PATH);
  // Every write in the script must be addressed at SCRATCH. Any open(...,'w'/'wb')
  // whose path expression mentions SCRIPT_DIR or MODELS is a write into the
  // live retrain artifacts.
  const writes = src.match(/open\([^)]*,\s*'w[b]?'\)/g) || [];
  assert.ok(writes.length > 0, 'expected the script to write its results file');
  for (const w of writes) {
    assert.doesNotMatch(
      w, /SCRIPT_DIR|MODELS_DIR/,
      `within_city_eval.py writes into the retrain directory: ${w}. `
      + 'best_model.pkl, features_train.pkl, features_holdout.pkl and '
      + 'model_metadata.json are read by quick_eval.py and evaluate_model.py '
      + 'and must be treated as read-only by this script.');
  }
  assert.match(
    src, /RESULTS_PATH = SCRATCH \/ 'results\.json'/,
    'results.json must land in the scratch directory, not next to the model.');
});

test('within_city_eval pins the device and thread count it reports', () => {
  const src = read(EVAL_PATH);
  assert.match(src, /FLOCK_TRAIN_DEVICE/,
    'the device must be pinned: CUDA histogram training is not bit-reproducible '
    + '(train_model.resolve_device).');
  assert.match(src, /FLOCK_TRAIN_THREADS/,
    'the thread count must be pinned: n_jobs changes the fitted model by up to '
    + '2.06 busyness points (train_model.resolve_threads).');
  assert.match(src, /raise SystemExit\('within_city_eval\.py refuses to run on anything but cpu/,
    'the script must refuse a non-cpu device rather than quietly producing '
    + 'numbers nobody can reproduce.');
});

test('within_city_eval proves its splits are disjoint before scoring them', () => {
  const src = read(EVAL_PATH);
  assert.match(src, /def assert_split_disjoint/,
    'the split audit is the load-bearing part of this measurement.');
  for (const splitter of ['date_split', 'scattered_date_split', 'venue_split',
    'venue_with_anchor_split']) {
    assert.match(src, new RegExp(`def ${splitter}\\(`),
      `${splitter} is missing — WITHIN-CITY-EVAL.md reports its number.`);
  }
  assert.match(src, /def paired_familiarity_test/,
    'the paired familiarity test is the only unconfounded evidence in the file '
    + 'about whether buying more observations per venue helps.');
});
