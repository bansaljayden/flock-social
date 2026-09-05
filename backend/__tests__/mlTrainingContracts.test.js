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

test('review_count is filled the same way in training and in serving', () => {
  // TWO HALVES OF ONE IMPUTATION, which is the shape this file exists to guard.
  //
  // prepare_features.py used to do review_count.fillna(0) while filling `rating`
  // with the median. Zero is not a neutral fill: it is the minimum of the range
  // and it means "nobody has ever been here", so a venue with no Google data was
  // described to the model as average-rated with no reviews. That pairing is a
  // learnable signature for the collection path rather than the venue, which is
  // the same leakage shape as the weekly weather defect. The trainer now imputes
  // the median and publishes it as median_review_count.
  //
  // Serving must follow the ARTIFACT, not the trainer's current source: a model
  // trained on the zero fill has to be served the zero fill, or every cold venue
  // moves under weights that never saw that value. So the metadata key is the
  // switch, and the shipped v2.6.0-starling, which predates it, keeps its zero.
  assert.match(PREPARE_PY, /median_review_count/,
    'the trainer no longer computes a review_count median');
  assert.ok(!/\['review_count'\]\.fillna\(0\)/.test(PREPARE_PY),
    'the trainer still fills review_count with a measured zero');

  const fill = PREDICTOR_JS.slice(PREDICTOR_JS.indexOf('const reviewCount ='));
  const expr = fill.slice(0, fill.indexOf(';'));
  assert.match(expr, /metadata\.median_review_count/,
    'serving cannot follow a median-trained model, so training and serving would skew');
  assert.ok(!/\|\|\s*0\s*$/.test(expr.trim()),
    'an unconditional zero fill ignores what the loaded model was trained on');
  // A real zero is a measurement and must survive, so the chain is `??`, not `||`.
  assert.ok(!expr.includes('||'),
    '`||` would replace a genuine Google answer of zero reviews with the median');

  // And the switch has to be honest about the artifact actually loaded.
  if (METADATA.median_review_count === undefined) {
    assert.strictEqual(METADATA.model_version, '2.6.0-starling',
      'a model with no median_review_count is a pre-median artifact; if the shipped '
      + 'version changed, confirm it really was trained with the zero fill');
  }
});

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
  // The qmap (2026-08-20, armed by default since 2026-08-28) is a post-hoc
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
  assert.match(PREDICTOR_JS,
    /String\(process\.env\.CROWD_QMAP_ENABLED \|\| ''\)\.toLowerCase\(\) !== 'false'/,
    'the serve path reads the flag case-insensitively, exactly as quick_eval.py '
      + 'does, so CROWD_QMAP_ENABLED=FALSE cannot disarm one side only');
  assert.match(QUICK_EVAL_PY, /os\.environ\.get\('CROWD_QMAP_ENABLED', 'true'\)\.lower\(\) != 'false'/,
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

// ── Round 26 (2026-09-04): nothing reaches the matrix that nobody measured ──
//
// prepare_features.py is read as source below and, when a Python with pandas
// is on the box, actually executed on fixtures. The source pins say what the
// code must contain; the fixture run says what it must DO to a row, which is
// the half a regex cannot check. Neither touches the CSVs, the pickles, the
// models directory or a database.

const { spawnSync } = require('child_process');
const os = require('os');

// export_training_data.js is read as TEXT, never required: requiring it runs
// dotenv against backend/.env, which points at the live Railway database.
const EXPORT_JS = read(path.join(TRAIN_DIR, 'export_training_data.js'));

function pyStringList(source, name) {
  const m = source.match(new RegExp(`^${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`, 'm'));
  assert.ok(m, `${name} is not a list literal in the Python source`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function pyStringDict(source, name) {
  const m = source.match(new RegExp(`^${name}[^=]*=\\s*\\{([\\s\\S]*?)\\}`, 'm'));
  assert.ok(m, `${name} is not a dict literal in the Python source`);
  return Object.fromEntries([...m[1].matchAll(/'([^']+)':\s*'([^']+)'/g)].map((x) => [x[1], x[2]]));
}

test('(a) one event-type vocabulary in three files, and the two legacy words map by their reading', () => {
  // eventService.mapEventType returned 'concert' for Ticketmaster's Music
  // segment and 'film' for Film from commit 25113d2 to 73c0374; the fixed
  // function returns 'music' for Music and lets Film fall through to 'other'.
  // Production holds 1,964 live realtime rows written under the old function
  // (philly 1,547, lehigh 417, 2026-09-01 to 09-04). Without the alias each
  // trained as has_nearby_event = 1 with all five etype slots at 0, a corner
  // serving never produces.
  const prepare = pyStringList(PREPARE_PY, 'EVENT_TYPE_VOCABULARY');
  const exporter = (() => {
    const m = EXPORT_JS.match(/const EVENT_TYPE_VOCABULARY = \[([^\]]*)\];/);
    assert.ok(m, 'export_training_data.js must declare EVENT_TYPE_VOCABULARY');
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  })();
  const serving = [...PREDICTOR_JS.matchAll(/etype_(\w+): nearestType === '(\w+)' \? 1 : 0/g)]
    .map((m) => { assert.equal(m[1], m[2]); return m[1]; });
  assert.deepEqual(prepare, ['music', 'sports', 'arts', 'family', 'other']);
  assert.deepEqual(exporter, prepare, 'the exporter census and the trainer disagree about the vocabulary');
  assert.deepEqual(serving, prepare, 'buildFeatureMap emits a different set of etype_* slots than training builds');

  const aliases = pyStringDict(PREPARE_PY, 'LEGACY_EVENT_TYPE_ALIASES');
  assert.deepEqual(aliases, { concert: 'music', film: 'other' },
    'the aliases are the OLD mapEventType outputs read through the NEW one, nothing more');
  assert.match(PREPARE_PY, /def normalise_event_types\(/);
  assert.match(PREPARE_PY, /normalise_event_types\(train_df, 'train'\)/, 'the training CSV must be normalised');
  assert.match(PREPARE_PY, /normalise_event_types\(holdout_df, 'holdout'\)/, 'so must the holdout');
  assert.match(PREPARE_PY, /raise CorpusContractError\(\s*\n?\s*f'\[\{label\}\] nearest_event_type carries/,
    'a value outside the vocabulary that no alias covers must stop the run by name');
  assert.match(PREPARE_PY, /for etype in EVENT_TYPE_VOCABULARY:/,
    'the one-hot must be built over the named vocabulary, not a second literal list');
  // And the exporter says so before a two-hour run, without laundering the column.
  assert.match(EXPORT_JS, /async function eventTypeCensus\(db\)/);
  assert.match(EXPORT_JS, /const eventTypes = await eventTypeCensus\(db\);/, 'preflight must run the census');
  assert.ok(!/CASE\s+t\.nearest_event_type/i.test(EXPORT_JS) && !/REPLACE\(t\.nearest_event_type/i.test(EXPORT_JS),
    'the export must carry nearest_event_type as stored; the mapping belongs to prepare_features.py');
});

test('(c)(g) a missing weather reading is filled the way serving fills it, and the norms see only readings', () => {
  // Weekly rows carry no weather since repairWeeklyWeather.js. The city-month
  // MEDIAN this file used to fill with gave every weekly venue-batch one
  // temperature on all 168 rows (18,621 of 18,621 venues on the 2026-08-30
  // export), fed 88% imputed values into the climate norms (moved by up to
  // 3.56F) and left the weekly rows with a nonzero per-city anomaly while
  // serving hands an imputed temperature to the model with anomaly 0.
  assert.ok(!/city_month_temp/.test(PREPARE_PY), 'the city-month median fill is back');
  assert.ok(!/global_temp_median/.test(PREPARE_PY), 'the global median fill is back');
  assert.ok(!/= 20\.0\s*$/m.test(PREPARE_PY.split('def add_weather_features')[1].split('\ndef ')[0]),
    'the literal 20.0 fallback temperature is back');
  assert.match(PREPARE_PY, /def fit_temperature_norms\(/);
  assert.match(PREPARE_PY, /observed = df\['temperature'\]\.notna\(\)\.to_numpy\(\)/,
    'the norms must be fitted from rows that carry a reading');
  assert.match(PREPARE_PY, /temp_norms = fit_temperature_norms\(train_df\)\s*\n\s*train_df = add_weather_features\(train_df, temp_norms\)/,
    'the table must be fitted BEFORE any fill and handed to the fill');
  assert.match(PREPARE_PY, /holdout_df = add_weather_features\(holdout_df, temp_norms\)/,
    'the holdout must be filled from the TRAIN table, not a table fitted on its own rows');
  assert.match(PREPARE_PY, /df\['temperature'\] = pd\.to_numeric\(df\['temperature'\], errors='coerce'\)\.fillna\(df\['temp_norm'\]\)/,
    'a missing temperature takes its (band, month) norm');
  assert.match(PREPARE_PY, /return keys\.map\(table\)\.astype\(float\)\.fillna\(global_mean\)/,
    'and the table mean when the cell has none: climateNorm then globalTempNorm, in that order');
  assert.match(PREPARE_PY, /'temp_norm_counts'/, 'the row count behind each norm must ship beside it');

  // The three constants, value for value, against buildFeatureMap.
  const fills = (() => {
    const m = PREPARE_PY.match(/WEATHER_NO_READING_FILLS: Dict\[str, float\] = \{([^}]*)\}/);
    assert.ok(m, 'prepare_features.py must name the no-reading fills in one dict');
    return Object.fromEntries([...m[1].matchAll(/'(\w+)':\s*(-?[\d.]+)/g)].map((x) => [x[1], Number(x[2])]));
  })();
  const serveHumidity = PREDICTOR_JS.match(/const humidity = weather\?\.humidity \?\? (-?[\d.]+);/);
  const serveWind = PREDICTOR_JS.match(/const windSpeed = weather\?\.wind_speed \?\? weather\?\.windSpeed \?\? (-?[\d.]+);/);
  const serveRain = PREDICTOR_JS.match(/const isRaining = \(weather\?\.is_raining \?\? weather\?\.isRaining\) \? 1 : (\d);/);
  assert.ok(serveHumidity && serveWind && serveRain, 'buildFeatureMap no longer fills the three slots with literals');
  assert.deepEqual(fills, {
    humidity: Number(serveHumidity[1]), wind_speed: Number(serveWind[1]), is_raining: Number(serveRain[1]),
  }, 'training and serving disagree about what a missing reading looks like; the weekly ' +
     'rows would train an outage vector serving never builds');
  assert.match(PREDICTOR_JS, /const temp = tempForFeature\(weather, lat, month\);/,
    'serving must impute temperature through the climate norm, which is what training now mirrors');
  assert.match(PREPARE_PY, /'weather_observed': train_df\['weather_observed'\]\.values\.astype\(np\.int8\)/,
    'which rows carry a reading must ride the pickle as a carried column');
  assert.match(PREPARE_PY, /'weather_observed',\r?\n/, 'and be excluded from the feature set');
});

test('(d) an unknown-provenance realtime row is not a live label, and the default says no', () => {
  // 4,577 live rows (2026-09-01 to 09-04) now sit beside 457,402 rows whose
  // label_source is NULL and unrecoverable (migration 025). The old guard
  // raised only when EVERY realtime row was unknown, so it stopped firing the
  // day the first live row landed and left the 457,402 at weight 1.0 with
  // nothing said.
  assert.match(PREPARE_PY, /def exclude_unknown_provenance\(/);
  assert.match(PREPARE_PY, /train_df, unknown_train = exclude_unknown_provenance\(train_df, 'train'\)/);
  assert.match(PREPARE_PY, /holdout_df, unknown_holdout = exclude_unknown_provenance\(holdout_df, 'holdout'\)/,
    'the holdout is subject to the same rule: a gate scored on rows that may be the vendor forecast is not a gate on reality');
  assert.match(PREPARE_PY, /return df\[~unknown\], record/, 'the default must drop the rows');
  assert.match(PREPARE_PY, /UNKNOWN_PROVENANCE_ENV = 'ML_ALLOW_UNKNOWN_PROVENANCE'/);
  assert.match(PREPARE_PY, /\.strip\(\)\.lower\(\) == 'true'/, 'only an explicit true admits them');
  assert.ok(!/rt_prov == \['unknown'\]/.test(PREPARE_PY),
    'the all-unknown guard is back; it cannot fire on a corpus with one live row');
  assert.match(PREPARE_PY, /'unknown_provenance': unknown_provenance_record/,
    'the artifact must record whether unprovable rows were admitted');
  // There is no downweight tier for them, and that is deliberate: the trainer
  // demands one weight for every non-forecast realtime row.
  assert.match(TRAIN_PY, /tiers\['realtime_observed'\] = rt & \(prov != 'forecast'\)/);
  assert.match(PREPARE_PY, /assert_weighting_matches_provenance requires every\s*\n?#?\s*non-forecast realtime row to carry ONE weight/,
    'the reason there is no tier must stay next to the decision');
});

test('(e)(f) the split stays whole-city, the holdout never fits on itself, and is_realtime is named for what it is', () => {
  assert.ok(!/train_test_split|\.sample\(frac/.test(PREPARE_PY),
    'prepare_features.py must not carve a row-level split out of the city-level one');
  assert.match(PREPARE_PY, /add_baseline_features\(holdout_df, cat_maps=cat_baseline_maps\)/);
  assert.match(PREPARE_PY, /add_climate_anomaly\(holdout_df, norms=temp_norms\)/);
  assert.match(PREPARE_PY, /holdout_df\['review_count'\]\.fillna\(venue_metadata\['median_review_count'\]\)/);
  assert.ok(!/holdout_df\.groupby\(\['city', 'month'\]\)/.test(PREPARE_PY),
    'a per-city statistic fitted on the holdout is a holdout self-fit');
  assert.match(EXPORT_JS, /const isHoldout = HOLDOUT_CITIES\.includes\(city\);/,
    'the exporter routes whole cities; a venue is in exactly one city, so no venue can sit on both sides');
  // is_realtime is a provenance flag hardcoded to 1 at serving (PRE-RETRAIN-AUDIT
  // finding 18). It stays a feature only because quick_eval, train_model,
  // sports_ablation and hour_ranking_eval read it out of X by position; the
  // carried key is the step that lets them stop, and the reason is written
  // where the key is.
  assert.match(PREPARE_PY, /'is_realtime': train_df\['is_realtime'\]\.values\.astype\(np\.int8\)/);
  assert.match(PREPARE_PY, /'is_realtime': holdout_df\['is_realtime'\]\.values\.astype\(np\.int8\)/);
  assert.match(PREPARE_PY, /PRE-RETRAIN-AUDIT finding 18/);
  assert.match(QUICK_EVAL_PY, /X\[:, feature_cols\.index\('is_realtime'\)\]/,
    'the day quick_eval stops reading the flag from X is the day it can leave feature_cols');
});

test('no blanket fill, and coordinates are a contract rather than an equator', () => {
  assert.match(PREPARE_PY, /def refuse_unfilled_features\(/);
  assert.ok(!/\[feature_cols\]\.fillna\(0\)/.test(PREPARE_PY),
    'the blanket fillna(0) turned the first forgotten fill into a measured zero');
  assert.match(PREPARE_PY, /def require_coordinates\(/);
  assert.match(PREPARE_PY, /require_coordinates\(train_df, train_path, 'training_data.csv'\)/);
  assert.match(PREPARE_PY, /require_coordinates\(holdout_df, holdout_path, 'holdout_data.csv'\)/);
  assert.ok(!/df\['latitude'\]\.fillna\(0\)/.test(PREPARE_PY),
    'a coordinate-less row was being trained at 0N 0E');
});

// The fixture run. Skipped, not failed, where Python with pandas is absent.
const PY_PANDAS = (() => {
  for (const bin of ['python', 'python3']) {
    const probe = spawnSync(bin, ['-c', 'import pandas, numpy'], { encoding: 'utf8' });
    if (probe.status === 0) return bin;
  }
  return null;
})();

const FIXTURE_DRIVER = `
import sys, json, os
import numpy as np, pandas as pd
sys.path.insert(0, sys.argv[1])
os.environ.pop('ML_ALLOW_UNKNOWN_PROVENANCE', None)
import prepare_features as pf
out = {}
ev = pd.DataFrame({
    'nearest_event_type': ['music', 'concert', 'film', None, 'sports', 'Concert '],
    'has_nearby_event': [1, 1, 1, 0, 1, 1],
    'nearest_event_attendance': [100, 200, 300, None, 400, 500],
    'total_nearby_events': [1, 1, 1, None, 1, 1],
    'total_nearby_attendance': [100, 200, 300, None, 400, 500],
    'nearest_event_distance_km': [1, 1, 1, None, 1, 1],
    'is_weekend': [0, 1, 0, 1, 0, 1], 'is_dinner_hour': [1, 1, 0, 0, 1, 1],
    'venue_category': ['bar'] * 6,
})
stats = pf.normalise_event_types(ev, 'fixture')
ev = pf.add_event_features(ev)
out['event'] = {
    'aliased': stats['legacy_values_aliased'],
    'music': ev['etype_music'].tolist(), 'other': ev['etype_other'].tolist(),
    'sports': ev['etype_sports'].tolist(),
    'slots_sum': ev[[f'etype_{t}' for t in pf.EVENT_TYPE_VOCABULARY]].sum(axis=1).tolist(),
}
try:
    pf.normalise_event_types(pd.DataFrame({'nearest_event_type': ['rave']}), 'bad')
    out['event']['unknown_raises'] = False
except pf.CorpusContractError as e:
    out['event']['unknown_raises'] = 'rave' in str(e)
w = pd.DataFrame({
    'latitude': [40.0, 40.0, 40.0, 30.0, 40.0], 'longitude': [-75.0] * 5,
    'month': [5, 5, 5, 5, 5], 'hour': [20, 20, 20, 20, 9],
    'temperature': [60.0, 70.0, None, None, 80.0],
    'humidity': [30.0, 40.0, None, None, 60.0], 'wind_speed': [3.0, 4.0, None, None, 5.0],
    'is_raining': [1, 0, None, None, 0],
    'weather_condition_code': [800, 803, None, None, 500],
    'is_weekend': [0] * 5, 'is_dinner_hour': [1, 1, 1, 1, 0],
})
norms = pf.fit_temperature_norms(w)
w = pf.add_weather_features(w, norms)
w, _ = pf.add_climate_anomaly(w, norms)
out['weather'] = {
    'cells': norms[['lat_band', 'month', 'temp_norm', 'n_obs']].values.tolist(),
    'temperature': w['temperature'].tolist(), 'anomaly': w['temp_anomaly'].tolist(),
    'humidity': w['humidity'].tolist(), 'wind': w['wind_speed'].tolist(), 'rain': w['is_raining'].tolist(),
    'unknown': w['weather_unknown'].tolist(), 'observed': w['weather_observed'].tolist(),
    'refit_same': bool(len(pf.fit_temperature_norms(w)) == len(norms)
                       and np.allclose(pf.fit_temperature_norms(w)['temp_norm'], norms['temp_norm'])),
}
p = pd.DataFrame({'is_realtime': [1, 1, 0, 1], 'label_provenance': ['live', 'unknown', 'weekly', None]})
kept, rec = pf.exclude_unknown_provenance(p, 'fixture')
os.environ['ML_ALLOW_UNKNOWN_PROVENANCE'] = 'true'
kept2, rec2 = pf.exclude_unknown_provenance(p, 'fixture')
out['prov'] = {'default_rows': len(kept), 'default_levels': kept['label_provenance'].fillna('unknown').tolist(),
               'excluded': rec['rows_excluded'], 'admitted_rows': len(kept2), 'admitted_policy': rec2['policy']}
try:
    pf.refuse_unfilled_features(pd.DataFrame({'a': [1.0, None], 'b': [1.0, 2.0]}), ['a', 'b'], 'fixture')
    out['refuse'] = False
except pf.CorpusContractError as e:
    out['refuse'] = "'a': 1" in str(e)
try:
    pf.require_coordinates(pd.DataFrame({'latitude': [1.0, None], 'longitude': [1.0, 2.0]}), 'x.csv', 'fixture')
    out['coords'] = False
except pf.CorpusContractError:
    out['coords'] = True
print('RESULT ' + json.dumps(out))
`;

test('prepare_features.py, run on fixtures', { skip: PY_PANDAS ? false : 'python with pandas not available' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-prep-fixture-'));
  const driver = path.join(dir, 'drive.py');
  fs.writeFileSync(driver, FIXTURE_DRIVER);
  let r;
  try {
    r = spawnSync(PY_PANDAS, [driver, TRAIN_DIR], { encoding: 'utf8', env: { ...process.env } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no RESULT line in:\n${r.stdout}\n${r.stderr}`);
  const out = JSON.parse(line.slice(7));

  // (a) 'concert' trains as music, 'film' as other, case and whitespace do not
  // matter, an absent type lights no slot, and a sixth word stops the run.
  assert.deepEqual(out.event.aliased, { concert: 2, film: 1 });
  assert.deepEqual(out.event.music, [1, 1, 0, 0, 0, 1]);
  assert.deepEqual(out.event.other, [0, 0, 1, 0, 0, 0]);
  assert.deepEqual(out.event.sports, [0, 0, 0, 0, 1, 0]);
  assert.deepEqual(out.event.slots_sum, [1, 1, 1, 0, 1, 1],
    'every row with a type lights exactly one slot; the all-zero corner is gone');
  assert.equal(out.event.unknown_raises, true);

  // (c) the norm is the mean of the three READINGS in band 40 (60, 70, 80 ->
  // 70); the two rows with no reading take it (band 30 has no cell, so it
  // takes the table mean, also 70 here) and sit at anomaly 0; the other three
  // slots take serving's outage values; weather_unknown marks the two rows.
  assert.deepEqual(out.weather.cells, [[40, 5, 70, 3]]);
  assert.deepEqual(out.weather.temperature, [60, 70, 70, 70, 80]);
  assert.deepEqual(out.weather.anomaly, [-10, 0, 0, 0, 10]);
  assert.deepEqual(out.weather.humidity, [30, 40, 50, 50, 60]);
  assert.deepEqual(out.weather.wind, [3, 4, 0, 0, 5]);
  assert.deepEqual(out.weather.rain, [1, 0, 0, 0, 0]);
  assert.deepEqual(out.weather.unknown, [0, 0, 1, 1, 0]);
  assert.deepEqual(out.weather.observed, [1, 1, 0, 0, 1]);
  assert.equal(out.weather.refit_same, true,
    'refitting after the fill must give the same table: the imputed rows never feed it');

  // (d) by default the two unknown rows go and the live and weekly rows stay;
  // the hatch admits all four.
  assert.equal(out.prov.default_rows, 2);
  assert.deepEqual(out.prov.default_levels, ['live', 'weekly']);
  assert.equal(out.prov.excluded, 2);
  assert.equal(out.prov.admitted_rows, 4);
  assert.equal(out.prov.admitted_policy, 'admit_at_live_weight');

  assert.equal(out.refuse, true, 'a NaN feature column must be named, not zeroed');
  assert.equal(out.coords, true);
});
