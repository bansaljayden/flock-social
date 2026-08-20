// ---------------------------------------------------------------------------
// Source-level pins for scripts/ml/train/train_model.py — the script that
// actually fits the crowd model.
//
// The 2026-08-15 pre-retrain audit hardened prepare_features.py and
// quick_eval.py and never looked at the trainer, which had no checks at all: it
// accepted whatever the pickle held and wrote numbers into model_metadata.json
// that nothing verified. Every pin below was written after reproducing the
// corresponding defect on a synthetic fixture (no database, no paid API):
//
//   * the popular_times baseline back in the feature matrix under another name
//     trained happily and reported an excellent number;
//   * a target that was not `y_actual - baseline` was still reconstructed as
//     `baseline + clamp(delta)`, which is invisible in training and wrong in
//     serving, because the server adds the model's output to a baseline;
//   * `delta_clamp_range` in the metadata could say one thing while the trainer
//     hardcoded another, so the reported metrics described a reconstruction
//     services/mlPredictor.js would never perform;
//   * training on CUDA with `n_jobs=-1` and reporting as if the run were
//     reproducible: same seed, same data, CPU vs GPU moved predictions by 2.02
//     busyness points and 16 threads vs 1 by 2.06.
//
// There is no Python test runner in this repo, so these are source-level pins.
// They cannot check the arithmetic; they can make it impossible for a leak
// guard, the seed, the held-out early-stopping set or the delta contract to be
// removed without a red test. If one fails, the message names what it protects.
// Do not relax a pin to make a retrain run.
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ML_DIR = path.join(__dirname, '..', 'scripts', 'ml');
const TRAIN_DIR = path.join(ML_DIR, 'train');
const read = (p) => fs.readFileSync(p, 'utf8');

const TRAIN_PY = read(path.join(TRAIN_DIR, 'train_model.py'));
const PREPARE_PY = read(path.join(TRAIN_DIR, 'prepare_features.py'));
const QUICK_EVAL_PY = read(path.join(TRAIN_DIR, 'quick_eval.py'));
const PREDICTOR_JS = read(path.join(__dirname, '..', 'services', 'mlPredictor.js'));
const METADATA = JSON.parse(read(path.join(ML_DIR, 'models', 'model_metadata.json')));

// Python source with docstrings and `#` comments removed, so a pin that must
// mean "no CODE does this" is not satisfied or defeated by prose about it.
const TRAIN_CODE = TRAIN_PY
  .replace(/"""[\s\S]*?"""/g, '')
  .replace(/#[^\n]*/g, '');

// Pull the quoted keys out of a python dict literal assigned to `name`.
function pyDictKeys(source, name) {
  const m = source.match(new RegExp(`^${name}\\s*=\\s*\\{([\\s\\S]*?)^\\}`, 'm'));
  assert.ok(m, `${name} is not defined as a multi-line dict literal in train_model.py`);
  return [...m[1].matchAll(/^\s*'([^']+)':/gm)].map((x) => x[1]);
}

// ── Leakage ────────────────────────────────────────────────────────────────

test('the trainer refuses the label, the target and the popular_times baseline as features', () => {
  const forbidden = pyDictKeys(TRAIN_PY, 'FORBIDDEN_FEATURES');
  for (const name of ['busyness_pct', 'delta_label', 'baseline_busyness',
    'has_venue_baseline', 'venue_id', 'sample_weight', 'label_provenance']) {
    assert.ok(forbidden.includes(name),
      `${name} must stay in FORBIDDEN_FEATURES. This is a delta model: score = ` +
      'baseline + clamp(delta), so baseline_busyness as a FEATURE is the answer, ' +
      'and the ml_overfitting_fixes doctrine calls that leak THE BIG ONE.');
  }
  for (const name of ['latitude', 'longitude', 'lat_bin', 'lng_bin']) {
    assert.ok(forbidden.includes(name),
      `${name} must stay in FORBIDDEN_FEATURES — the doctrine drops lat/lng because ` +
      'they act as a city lookup table and are how v1.0 got val R2 0.90 / holdout 0.42.');
  }
  assert.match(TRAIN_PY, /assert_no_forbidden_features\(feature_cols\)/,
    'the name-level leak guard must actually be called from main()');
});

test('a forbidden quantity arriving under a new column name is still caught', () => {
  // The name guard only knows the names round 10 knew. The value-level scan is
  // what catches a re-derived baseline called something innocuous.
  assert.match(TRAIN_PY, /def assert_no_label_shaped_feature\(/,
    'the value-level copy detector must exist');
  assert.match(TRAIN_PY, /leak_scan = assert_no_label_shaped_feature\(X, feature_cols, \{/,
    'the copy detector must be called from main() with the real feature matrix');
  for (const probe of ['baseline_busyness', 'busyness_pct', 'delta_label']) {
    assert.ok(TRAIN_PY.includes(`'${probe}`),
      `the copy detector must probe ${probe}`);
  }
  const threshold = TRAIN_PY.match(/COPY_DETECTION_THRESHOLD = ([\d.]+)/);
  assert.ok(threshold && Number(threshold[1]) <= 0.99 && Number(threshold[1]) > 0.9,
    'the copy threshold must stay tight enough to catch a renamed baseline and loose ' +
    'enough not to fire on an all-zero dead slot (the delta label is exactly 0 on the ' +
    '~84% of training rows that are weekly snapshots)');
});

test('the serving population is imported from prepare_features, never re-implemented', () => {
  assert.match(TRAIN_PY, /from prepare_features import serving_population_mask/,
    'a third private copy of "baseline > 0" is a third thing to drift. ' +
    'prepare_features filters training with it and quick_eval gates with it.');
  assert.ok(!/def serving_population_mask/.test(TRAIN_CODE),
    'train_model.py must not define its own serving_population_mask');
  assert.match(PREPARE_PY, /def serving_population_mask\(baseline\)/,
    'prepare_features.py owns the single definition');
});

// ── The split ──────────────────────────────────────────────────────────────

test('cross-validation is leave-one-city-out and every fold is verified city-disjoint', () => {
  assert.match(TRAIN_PY, /cv = GroupKFold\(n_splits=n_cities\)/,
    'n_splits must equal the number of cities, or a fold holds out more than one ' +
    'city and it is no longer leave-one-city-out');
  assert.match(TRAIN_PY, /folds = assert_group_disjoint\(cv, X, y, cities\)/,
    'the fold check must run, grouped on city, before any fold is trained');
  assert.match(TRAIN_PY, /overlap = g_tr & g_va/,
    'the check must compare the train and validation city sets of each fold');
  assert.match(TRAIN_PY, /if not np\.all\(seen == 1\)/,
    'every row must be predicted exactly once. A row left unpredicted leaves NaN ' +
    'in the out-of-fold vector, every metric becomes NaN, and the bare NaN token ' +
    'written into model_metadata.json is not valid JSON.');
  // Do not regress the holdout: the city-level train/holdout split lives in the
  // exporter, and the trainer must not carve its own row-level split out of it.
  assert.ok(!/train_test_split/.test(TRAIN_CODE),
    'a random row split would put the same venue on both sides. The split is ' +
    'city-level and stays that way.');
});

test('folds are refit with their own sample weights, and the weight tiers are checked', () => {
  assert.match(TRAIN_PY, /Xtr, Xva = X\[tr\], X\[va\]/,
    'the fold matrices must be built by fancy indexing, which COPIES. The per-fold ' +
    'category refit writes its map into them, and the final model is fitted on X ' +
    'itself afterwards — a view here would leave one fold\'s map in the shipped ' +
    'artifact\'s features.');
  assert.match(TRAIN_PY, /m\.fit\(Xtr, y\[tr\], sample_weight=sample_weight\[tr\]\)/,
    'each leave-one-city-out fold must refit WITH the weights of its own training ' +
    'rows, or the reported metrics describe a model that was never trained');
  assert.match(TRAIN_PY, /raise LeakageError\(\s*f?'The per-fold category refit mutated feature column/,
    'and X must be proven unmutated after the fold loop, not assumed — the final ' +
    'fit reads it, and the shipped metadata.category_baselines must match the ' +
    'features the shipped model was fitted on');
  assert.match(TRAIN_PY, /weight_tiers = assert_weighting_matches_provenance\(/,
    'the weight/provenance contract must be checked');
  assert.match(TRAIN_PY, /if weights != sorted\(weights\)/,
    'weekly <= vendor-forecast <= live-observed. A vendor forecast outranking a live ' +
    'observation teaches the model to reproduce BestTime rather than reality.');
});

// ── Reproducibility ────────────────────────────────────────────────────────

test('the seed, the device and the thread count are all pinned and recorded', () => {
  assert.match(TRAIN_PY, /^RANDOM_STATE = 42$/m, 'the seed is pinned');
  assert.match(TRAIN_PY, /random_state=RANDOM_STATE/,
    'the estimator must take the pinned seed');
  assert.ok(!/n_jobs=-1/.test(TRAIN_CODE),
    'n_jobs=-1 means "however many cores this box has", and the thread count changes ' +
    'the model: 16 threads vs 1 moved fixture predictions by 2.06 busyness points. ' +
    'RANDOM_STATE does not cover it. Use resolve_threads() and record the value.');
  assert.match(TRAIN_PY, /def resolve_device\(\)/);
  assert.match(TRAIN_PY, /def resolve_threads\(\)/);
  assert.match(TRAIN_PY, /FLOCK_TRAIN_DEVICE/,
    'the device must be pinnable, not only probed — CPU and CUDA produce different ' +
    'models from the same seed and the same data (fixture: 2.02 busyness points)');
  assert.match(TRAIN_PY, /metadata\['training_environment'\]/,
    'the device, the thread count and the library versions must land in metadata, or ' +
    'nobody can tell what produced the artifact');
  assert.match(TRAIN_PY, /'bit_reproducible': reproducible/,
    'the artifact must state whether it can be reproduced at all');
});

test('a non-finite number can never be written into model_metadata.json', () => {
  assert.match(TRAIN_PY, /json\.dumps\(metadata, indent=2, allow_nan=False\)/,
    'Python writes a bare NaN / Infinity token and reads it back happily; JSON.parse ' +
    'does not, so one non-finite number stops mlPredictor.init() reading the file at ' +
    'all and the backend silently serves the rule engine.');
  assert.match(TRAIN_PY, /if not all\(np\.isfinite\(v\) for v in out\.values\(\)\)/,
    'metrics must be checked finite where they are computed, not only at write time');
});

// ── Early stopping and the tuning metric ───────────────────────────────────

test('early stopping, when used, is held out by whole cities and scored on the gate metric', () => {
  assert.match(TRAIN_PY, /def early_stopping_split\(groups/,
    'the early-stopping validation set must be built from the city groups');
  assert.match(TRAIN_PY, /val = np\.isin\(g, held\)/,
    'the held-out set must be whole cities. A random row split puts the same venue ' +
    'Tuesday 9 PM on both sides and the stopping round is chosen on seen rows.');
  assert.match(TRAIN_PY, /eval_set=\[\(Xva, y\[va\]\)\]/,
    'early stopping must evaluate on the held-out rows');
  assert.match(TRAIN_PY, /probe\.fit\(Xtr, y\[tr\]/,
    'and must train on the complement of them');
  assert.match(TRAIN_PY, /fold_cats\.columns_for_fold\(held\)/,
    'and the category label-means must be refitted on this split\'s training side ' +
    'too. Otherwise the stopping round — an integer that goes into the shipped ' +
    'model — is chosen against cities that helped build their own features.');
  assert.match(TRAIN_PY, /def gate_mae\(y_true, y_pred\)/,
    'the stopping metric must be MAE on the reconstructed absolute scale — the same ' +
    'quantity quick_eval.py gates on. A model stopped on RMSE and gated on MAE is a ' +
    'coin flip.');
  assert.match(TRAIN_PY, /list\(history\)\[-1\] != 'gate_mae'/,
    'XGBoost keeps its own default rmse alongside a custom metric and stops on the ' +
    'LAST one; verify the round chosen is the minimum of OUR series');
  assert.match(TRAIN_PY, /if 'early_stopping_rounds' in params or 'eval_metric' in params/,
    'nothing may reach the final full-data fit with early stopping baked into the ' +
    'params: that fit has no eval_set, so the stopping round would come from ' +
    'training rows');
});

test('the hyperparameter search is either really run or honestly labelled', () => {
  // Audit finding 19: the search object was CONSTRUCTED and never fitted on the
  // weighted path, while metadata.best_params presented a hardcoded dict as its
  // output.
  assert.match(TRAIN_PY, /'source': 'fixed_from_v2\.3\.0_search'/,
    'when no search runs, metadata must say the params are fixed values');
  assert.match(TRAIN_PY, /'searched_this_run': False/,
    'and must say so in a machine-readable way');
  assert.match(TRAIN_PY, /scoring='neg_mean_absolute_error'/,
    'the search must score on MAE. On a delta model MAE on the label IS the gate\'s ' +
    'MAE up to the clamp, while RMSE optimises a different loss from the one that ' +
    'decides whether the artifact ships.');
  assert.ok(!/neg_root_mean_squared_error/.test(TRAIN_CODE),
    'the RMSE scorer was the misalignment; it must not come back');
  assert.match(TRAIN_PY, /set_fit_request\(sample_weight=True\)/,
    'if the search runs on the weighted path the weights must be routed per fold — ' +
    'unrouted, sklearn hands the FULL weight vector to a fold fitting on a subset, ' +
    'which is why the search was never fitted at all');
});

// ── The delta target, against services/mlPredictor.js ──────────────────────

test('the target the model learns is the delta the server adds to the baseline', () => {
  assert.match(TRAIN_PY, /def assert_delta_label\(/);
  assert.match(TRAIN_PY, /assert_delta_label\(y, y_actual, baseline, label_type\)/,
    'the label contract must be checked in main(), not assumed');
  assert.match(TRAIN_PY, /implied = np\.asarray\(y_actual, dtype=np\.float64\) - np\.asarray\(baseline, dtype=np\.float64\)/,
    'the check is literally y == y_actual - baseline');
  assert.match(TRAIN_PY, /if label_type != 'delta'/,
    'a non-delta label must stop the run: mlPredictor.js only reconstructs ' +
    'baseline + clamp(delta) when metadata.label_type is "delta", and otherwise ' +
    'ships the raw model output as the score');
});

test('the clamp used in training is the one the server will apply', () => {
  assert.match(TRAIN_PY, /def resolve_clamp\(metadata/);
  assert.match(TRAIN_PY, /raw = metadata\.get\('delta_clamp_range'\)/,
    'the clamp must be read from the metadata mlPredictor.js reads, not hardcoded. ' +
    'Hardcoding meant a metadata edit silently made every reported metric describe ' +
    'a reconstruction production would never perform.');
  assert.match(TRAIN_PY, /clamp = resolve_clamp\(metadata\)/);

  // Training's own reconstruction still reads the metadata key and reconstructs
  // the doctrinal way: clamp the delta, add the baseline, clip to 0..100.
  assert.match(TRAIN_PY, /return np\.clip\(baseline \+ np\.clip\(raw_delta, lo, hi\), 0, 100\)/,
    'training must clamp the delta first, add it to the baseline, then clip to the ' +
    '0..100 busyness range');

  // THE SERVE CLAMP IS DELIBERATELY WIDER THAN THE TRAINING-TIME RECORD.
  //
  // Until 2026-08-19 there was one number in three places and this test pinned
  // all three equal. The dispersion lab (scripts/ml/train/RETRAIN-V27-LOG.md)
  // then measured the shipped model as too NARROW — prediction sd 21.6 against
  // an actual 36.65 — and found exactly one widener that clears the ship gate:
  // clamp the delta at +/-50 and push scores outside [25, 65] by one point
  // (within-10 +0.26pp CI [+0.17, +0.37], MAE-neutral, 2000-resample date-block
  // bootstrap). So mlPredictor.reconstructScore now overrides
  // metadata.delta_clamp_range (+/-30) on purpose, and that key keeps its
  // original meaning: the range the TRAINING run reported against.
  //
  // What must still hold, and is what this section pins now: the ship gate
  // scores the reconstruction PRODUCTION PERFORMS. quick_eval.py's reconstruct()
  // and mlPredictor's reconstructScore are one formula in two languages, so
  // their four constants are compared number by number rather than described
  // twice in prose.
  const serveClampLo = PREDICTOR_JS.match(/const DELTA_CLAMP_LO = (-?\d+);/);
  const serveClampHi = PREDICTOR_JS.match(/const DELTA_CLAMP_HI = (-?\d+);/);
  const pushLow = PREDICTOR_JS.match(/const EXTREMES_PUSH_LOW = (-?\d+);/);
  const pushHigh = PREDICTOR_JS.match(/const EXTREMES_PUSH_HIGH = (-?\d+);/);
  assert.ok(serveClampLo && serveClampHi && pushLow && pushHigh,
    'mlPredictor.js must declare the serve clamp and the extremes-push band as named constants');
  assert.match(PREDICTOR_JS, /score = reconstructScore\(rawOutput, baseline \|\| 0\);/,
    'the delta path must go through reconstructScore — the one place the serve ' +
    'reconstruction is written down');

  const gateClamp = QUICK_EVAL_PY.match(
    /np\.clip\(baseline \+ np\.clip\(raw_delta, (-?\d+), (-?\d+)\), 0, 100\)/);
  assert.ok(gateClamp, 'quick_eval.py must still reconstruct with an explicit clamp');
  assert.deepEqual(
    [Number(gateClamp[1]), Number(gateClamp[2])],
    [Number(serveClampLo[1]), Number(serveClampHi[1])],
    'the ship gate must clamp exactly as the server does, or the gate is deciding on a ' +
    'reconstruction production never performs');

  const gatePush = QUICK_EVAL_PY.match(
    /np\.where\(score < (\d+), score - 1, np\.where\(score > (\d+), score \+ 1, score\)\)/);
  assert.ok(gatePush, 'quick_eval.py must apply the same extremes push the server applies');
  assert.deepEqual(
    [Number(gatePush[1]), Number(gatePush[2])],
    [Number(pushLow[1]), Number(pushHigh[1])],
    'the push band must be identical on both sides');

  // The trainer's own fallback still has to match the artifact it produced:
  // that pair is the training-time record, and a mismatch there means a model
  // was MEASURED against a range its own metadata does not state.
  const trainerDefault = TRAIN_PY.match(/DEFAULT_DELTA_CLAMP = \((-?[\d.]+), (-?[\d.]+)\)/);
  assert.ok(trainerDefault, 'train_model.py must declare DEFAULT_DELTA_CLAMP');
  assert.deepEqual(METADATA.delta_clamp_range,
    [Number(trainerDefault[1]), Number(trainerDefault[2])],
    'the shipped artifact\'s delta_clamp_range must match the trainer\'s fallback');
  // And the serve clamp may only ever be WIDER than the recorded training
  // range. Narrower would mean production truncates deltas the reported
  // metrics counted in full — the direction that flatters the model.
  assert.ok(Number(serveClampLo[1]) <= METADATA.delta_clamp_range[0]
    && Number(serveClampHi[1]) >= METADATA.delta_clamp_range[1],
    'the serve clamp must not be narrower than the range training reported against');
  assert.equal(METADATA.label_type, 'delta',
    'the shipped artifact is a delta model; these pins describe a delta model');
});

test('the score quantile map is one table in two languages, and both default OFF', () => {
  // The qmap (2026-08-20, unarmed behind CROWD_QMAP_ENABLED) is a post-hoc
  // recalibration of the PUBLISHED number. It has the same failure mode the
  // clamp had before it was pinned: if the gate scores one table and production
  // serves another, the gate's verdict describes a product nobody shipped. So
  // the two knot arrays are compared number by number, the flag name is
  // compared as a string, and both sides are required to be off by default.
  const nums = (src, name) => {
    const m = src.match(new RegExp(name + String.raw`\s*=\s*(?:np\.array\()?\[([^\]]*)\]`));
    return m ? m[1].split(',').map((v) => Number(v.trim())) : null;
  };
  const jsX = nums(PREDICTOR_JS, 'QMAP_X');
  const jsY = nums(PREDICTOR_JS, 'QMAP_Y');
  const pyX = nums(QUICK_EVAL_PY, 'QMAP_X');
  const pyY = nums(QUICK_EVAL_PY, 'QMAP_Y');
  assert.ok(jsX && jsY, 'mlPredictor.js must declare QMAP_X and QMAP_Y as literal arrays');
  assert.ok(pyX && pyY, 'quick_eval.py must declare the same two arrays');
  assert.deepEqual(jsX, pyX, 'the qmap x knots differ between the serve path and the gate');
  assert.deepEqual(jsY, pyY, 'the qmap y knots differ between the serve path and the gate');
  assert.equal(jsX.length, jsY.length);

  // Same artifact string on both sides: the table is one model's quantile grid
  // and applying it to another model is the silent-wrongness case both sides
  // refuse.
  const jsFit = PREDICTOR_JS.match(/const QMAP_FITTED_ON = '([^']+)';/);
  const pyFit = QUICK_EVAL_PY.match(/QMAP_FITTED_ON = '([^']+)'/);
  assert.ok(jsFit && pyFit, 'both sides must record the artifact the table was fitted on');
  assert.equal(jsFit[1], pyFit[1], 'the two sides disagree about which model the table belongs to');
  assert.equal(jsFit[1], METADATA.model_version,
    'the shipped artifact is not the one this table was fitted on — refit it or do not enable it');

  // One flag name, read the same way on both sides, defaulting off.
  assert.match(PREDICTOR_JS, /process\.env\.CROWD_QMAP_ENABLED === 'true'/,
    'the serve path must gate on CROWD_QMAP_ENABLED === true, so unset means off');
  assert.match(QUICK_EVAL_PY, /os\.environ\.get\('CROWD_QMAP_ENABLED', ''\)\.lower\(\) == 'true'/,
    'the gate must read the same variable the same way');
  assert.match(QUICK_EVAL_PY, /'score_qmap_enabled': bool\(QMAP_ENABLED\)/,
    'a gate run must record which reconstruction produced its numbers');

  // The map runs AFTER reconstructScore and BEFORE getLabel. Both halves matter:
  // the first because the table's x grid is the distribution of reconstructed
  // scores, the second because a band that describes a different number than
  // the card shows is the bug this ordering exists to prevent.
  const iRecon = PREDICTOR_JS.indexOf('score = reconstructScore(rawOutput, baseline || 0);');
  const iQmap = PREDICTOR_JS.indexOf('score = applyScoreQuantileMap(score);');
  const iLabel = PREDICTOR_JS.indexOf('const label = getLabel(score);');
  assert.ok(iRecon > 0 && iQmap > 0 && iLabel > 0);
  assert.ok(iRecon < iQmap && iQmap < iLabel,
    'the qmap must sit between the reconstruction and the label assignment');
});

// ── Honest reporting ───────────────────────────────────────────────────────

test('the metric published to users is labelled with the population it was measured on', () => {
  // mlPredictor.js line ~1256 publishes metadata.training_metrics.within_15
  // verbatim as the venue card's `confidence`, and that figure is a blend in
  // which ~84% of rows are weekly snapshots where busyness_pct EQUALS
  // baseline_busyness by construction.
  assert.match(PREDICTOR_JS, /metadata\.training_metrics\?\.within_15/,
    'this pin exists because the server publishes that key as user-facing confidence');
  assert.match(TRAIN_PY, /'population': \(/,
    'training_metrics must carry a plain statement of which rows it covers');
  assert.match(TRAIN_PY, /metadata\['training_metrics_by_population'\] = slices/,
    'the realtime-served slice must be reported alongside the blend, so the number ' +
    'production actually achieves is visible next to the number it publishes');
  assert.match(TRAIN_PY, /'realtime_served': \(rt & served,/,
    'the served slice is is_realtime AND baseline > 0, the same predicate the gate uses');
  assert.match(TRAIN_PY, /metadata\['training_loco_per_city'\] = per_city/,
    'per-fold numbers must be recorded: a whole fold that is a 48-row city is noise, ' +
    'and blending it into the headline hides that');
  assert.match(TRAIN_PY, /metadata\['training_contracts'\]/,
    'the artifact must record which contracts were verified to produce it');
});

test('the trainer only writes numbers it measured, and never invents a search result', () => {
  assert.match(TRAIN_PY, /metadata\['best_params'\] = params/,
    'best_params must be the params that were actually fitted');
  assert.ok(!/best_params = \{\s*'subsample'/.test(TRAIN_CODE),
    'the fixed dict must not be assigned to a name that reads as a search result; ' +
    'it is FIXED_PARAMS, and metadata.hyperparameters says so');
  assert.match(TRAIN_PY, /^FIXED_PARAMS = \{/m);
  assert.match(TRAIN_PY, /metadata\['hyperparameters'\] = \{\*\*hp_info, 'params': params\}/);
});
