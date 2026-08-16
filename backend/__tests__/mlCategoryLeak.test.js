// ---------------------------------------------------------------------------
// Source-level pins for the category-baseline label leak in
// scripts/ml/train/prepare_features.py.
//
// THE LEAK. category_baseline and refined_category_baseline are means of
// busyness_pct — the LABEL. build_category_baseline_maps fits them on the whole
// training frame and add_baseline_features applies them to that same frame,
// while train_model.py splits with GroupKFold(n_splits=n_cities) grouped on
// city. So a city a fold holds out has already contributed to the category
// cells its own rows are then scored against, and training_metrics comes out
// optimistic. The SHIP GATE is not affected: it is measured on the separate
// holdout cities, whose rows contribute to neither map (main() passes the
// training maps into the holdout call instead of refitting).
//
// CLOSED ON 2026-08-16 (round 21), for the REPORTED metrics.
// train_model.FoldCategoryBaselines rebuilds both maps from each fold's own
// training cities. The shipped artifact is still fitted on the whole-frame
// matrix on purpose — that map is what mlPredictor.js serves, and inference has
// no held-out group — so what moved is the number, not the model. These pins now
// protect the fix as well as the record; the history below is kept because both
// wrong turns were plausible and one of them shipped for a round.
//
// WHY THIS FILE EXISTED BEFORE THE FIX. Round 14 tried the fix, measured it
// on a synthetic fixture over three independent draws (10 training cities,
// GroupKFold on city, identical hyperparameters; the delta label's only
// learnable signal is a per-city deviation, so an honest model cannot beat the
// predict-zero floor on a city it never saw) and rejected it. Against the
// per-fold refit as the honest reference — whose final model is the same
// artifact and scores identically on a pristine 3-city holdout — how far each
// regime's REPORTED cross-validated number sits below the truth:
//
//     whole-frame fit (what ships today)      MAE 0.21..0.42 low, w10 1.4..2.1pp high
//     leave-one-city-out computed once        MAE 1.52..3.05 low, w10 10.4..20.5pp high
//     K-fold block encoding, K = 2 / 3 / 5    MAE -0.05..0.80 low, no ordering in K
//     per-fold refit                          the reference
//
// The cheap "compute the leave-one-out map once" formulation understates the
// error by FIVE TO SEVEN TIMES what the leak it claims to remove does, because
// the feature then varies by city inside a fold and its deviation from the
// cell's typical value is an invertible function of the held-out city's own
// labels. Block encoding is not monotone in K. Only a per-fold refit is honest,
// and it is honest because inside a fold the map is one value per cell shared
// by that fold's training and validation rows — a property prepare_features.py
// cannot have, since it emits one feature matrix and has no folds.
//
// So the pins below protect three things:
//   1. the half that DOES belong here — the per-fold sufficient statistics that
//      travel in features_train.pkl, and their positional alignment with X;
//   2. the holdout path, which is already correct and must not be "simplified"
//      into a refit;
//   3. the honesty of the record — prepare_features.py and train_model.py must
//      not disagree about whether the leak is open, and the disproved
//      formulation must not be reintroduced by someone who only read the
//      one-line lever in RETRAIN.md.
//
// There is no Python test runner in this repo, so these are source-level pins.
// Do not relax one to make a retrain run.
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ML_DIR = path.join(__dirname, '..', 'scripts', 'ml');
const TRAIN_DIR = path.join(ML_DIR, 'train');
const read = (p) => fs.readFileSync(p, 'utf8');

const PREPARE_PY = read(path.join(TRAIN_DIR, 'prepare_features.py'));
const TRAIN_PY = read(path.join(TRAIN_DIR, 'train_model.py'));
const QUICK_EVAL_PY = read(path.join(TRAIN_DIR, 'quick_eval.py'));
const RETRAIN_MD = read(path.join(ML_DIR, 'RETRAIN.md'));

// Docstrings and `#` comments stripped, so a pin that must mean "no CODE does
// this" is neither satisfied nor defeated by prose about it.
const PREPARE_CODE = PREPARE_PY
  .replace(/"""[\s\S]*?"""/g, '')
  .replace(/#[^\n]*/g, '');

// ── 1. The half that belongs in prepare_features.py ────────────────────────

test('the per-fold sufficient statistics are built and shipped in the training pickle', () => {
  assert.match(PREPARE_CODE, /def build_category_cell_aggregates\(/,
    'build_category_cell_aggregates is the only thing that lets train_model.py refit '
    + 'the category baselines inside a fold without a second pass over the CSV — this '
    + 'script is the last step that still holds the labels in a frame');
  assert.match(PREPARE_CODE, /def index_category_cells\(/,
    'and the positional half must be a SEPARATE function, because it runs at a '
    + 'different point in main() than the aggregation does');
  assert.match(PREPARE_CODE, /cell_aggregates = build_category_cell_aggregates\(train_df, LEAVE_OUT_COL\)/,
    'main() must actually build them, and on the training frame');
  assert.match(PREPARE_CODE, /'category_cell_stats': cell_stats,/,
    'they must travel inside features_train.pkl; a statistic that is computed and '
    + 'not shipped is a comment');
  assert.match(PREPARE_CODE, /LEAVE_OUT_COL = 'city'/,
    "the leave-out group must be the city — that is what train_model.py's GroupKFold "
    + 'groups on, so any other granularity does not match the folds');
});

test('the sums are fitted BEFORE the serving filter and the indexes attached AFTER', () => {
  // Round 21. This ordering is the whole correctness of the refit and it is
  // counter-intuitive in both directions, so both halves are pinned.
  //
  // The SUMS must be fitted on the pre-filter frame because that is the frame
  // build_category_baseline_maps fits the shipped map on, and the trainer's job
  // is to rebuild THAT map minus one city. Fitted after the filter instead —
  // which is what round 14 shipped — a fold map moved category_baseline on 99.9%
  // of the corpus's rows by a mean of 9.27 points, while removing the held-out
  // city moved it on 74.9% by 0.17. The confound was 54x the effect, and the
  // "leak-corrected" CV number would have described a model with a category
  // feature the artifact does not carry.
  //
  // The INDEXES must be attached after every row filter because row_cell and
  // row_group are POSITIONAL indexes into X; computing them earlier is the same
  // misalignment audit finding 10 found in evaluate_model.py, where a per-hour
  // diagnostic was drawn on scrambled pairs.
  const filterAt = PREPARE_CODE.indexOf('train_df = train_df[serving_population_mask(');
  const aggAt = PREPARE_CODE.indexOf('cell_aggregates = build_category_cell_aggregates(');
  const indexAt = PREPARE_CODE.indexOf('cell_stats = index_category_cells(');
  assert.ok(filterAt > 0, 'the serving-population filter must still be there');
  assert.ok(aggAt > 0 && indexAt > 0, 'both halves must be called in main()');
  assert.ok(aggAt < filterAt,
    'build_category_cell_aggregates must run BEFORE the serving-population filter, '
    + 'on the same population build_category_baseline_maps is fitted on. Otherwise '
    + 'the per-fold map differs from the shipped feature by a population change '
    + 'fifty-four times the size of the leak it removes.');
  assert.ok(indexAt > filterAt,
    'index_category_cells must run AFTER the filter — row_cell / row_group are '
    + 'positional indexes into X, and X is the filtered matrix');
  assert.match(PREPARE_CODE, /'fit_population': 'pre_serving_filter'/,
    'and the pickle must SAY which population it was fitted on, so the trainer can '
    + 'refuse the other one instead of silently reporting a confounded number');
  assert.match(PREPARE_CODE, /CELL_STATS_VERSION = 2/,
    'the block is versioned so an old features_train.pkl is refused rather than '
    + 'consumed');
  assert.match(PREPARE_CODE, /len\(cell_stats\['row_group'\]\) != len\(train_df\)/,
    'the alignment must be CHECKED, not assumed — and with a raise, not a bare '
    + '`assert`, which python -O strips');
  assert.match(PREPARE_CODE, /if \(rows_counts > block\['counts'\]\)\.any\(\)/,
    'and the matrix rows must be proven a SUBSET of the rows the aggregates were '
    + 'fitted on; that is what distinguishes "wider population, same run" from '
    + '"two unrelated runs"');
});

test('the trainer proves the refit is the shipped map minus one city, before it trains', () => {
  assert.match(TRAIN_PY, /def verify_reproduces_shipped\(self, X\)/,
    'the one assertion that makes this design checkable rather than argued: hold out '
    + 'NO city and the rebuilt columns must equal the shipped columns exactly');
  assert.match(TRAIN_PY, /shipped_repro = fold_cats\.verify_reproduces_shipped\(X\)/,
    'and it must actually run in main(), before any fold is fitted — a number written '
    + 'into the artifact after thirty folds is too late to be a check');
  assert.match(TRAIN_PY, /CELL_STATS_MIN_VERSION = 2/,
    'a v1 pickle must be refused. v1 aggregated after the serving filter, so its '
    + '"corrected" number describes a model that is not the one saved.');
  assert.match(TRAIN_PY, /'shipped_column_reproduced_max_abs_diff': shipped_repro/,
    'and the evidence must land in model_metadata.json, not only in a log line — the '
    + 'artifact should carry the proof, not the claim');

  const suite = path.join(TRAIN_DIR, 'test_fold_category_baselines.py');
  assert.ok(fs.existsSync(suite),
    'the property must also be tested on a synthetic corpus through the real '
    + 'pipeline functions, so it is checkable without a 900MB pickle');
  const suiteSrc = read(suite);
  assert.match(suiteSrc, /def test_negative_control_old_population\(\)/,
    'including a negative control that rebuilds the statistics the pre-round-21 way '
    + 'and requires the suite to catch it. Without it the suite could pass on the '
    + 'confounded pipeline.');
  assert.match(read(path.join(TRAIN_DIR, 'run_training.sh')),
    /python test_fold_category_baselines\.py/,
    'and run_training.sh must run it — before train_model.py, so a broken refit '
    + 'costs seconds rather than a full training run');
});

test('the shipped statistics carry the cell keys, so the smoothing can be redone per fold', () => {
  assert.match(PREPARE_CODE, /'cells': \[tuple\(c\.split\('\\x1f'\)\) for c in cell_levels\]/,
    'the coarse map is smoothed across ADJACENT HOURS within (venue_category, '
    + 'day_of_week); without the cell key tuples a fold cannot rebuild that '
    + 'neighbour structure and would ship an unsmoothed feature the model never saw');
  assert.match(PREPARE_CODE, /'recipe':/,
    'the recipe string is how the consuming side in train_model.py gets the exact '
    + 'arithmetic instead of re-deriving it');
  assert.match(PREPARE_CODE, /def _smooth_category_hours\(/,
    'the smoothing is one function shared by the full-frame map and any per-fold '
    + 'rebuild, so the two cannot drift into different blends');
});

// ── 2. The holdout path, which is already correct ──────────────────────────

test('the holdout frame is scored with the TRAINING maps and never refits its own', () => {
  assert.match(PREPARE_CODE, /holdout_df, _ = add_baseline_features\(holdout_df, cat_maps=cat_baseline_maps\)/,
    'the holdout must be handed the training maps. Refitting on the holdout is the '
    + 'round-10 bug: held-out labels building held-out features, which inflates every '
    + 'number the SHIP GATE is decided on.');
  const holdoutRefit = /add_baseline_features\(holdout_df\)(?!\s*,)/.test(PREPARE_CODE)
    || /build_category_baseline_maps\(holdout_df\)/.test(PREPARE_CODE);
  assert.equal(holdoutRefit, false,
    'nothing may fit a category baseline map on the holdout frame');
});

test('the two category features are only ever read from cat_maps, never from a per-group map', () => {
  const assigns = PREPARE_CODE.split('\n')
    .filter((l) => /\[['"](?:refined_)?category_baseline['"]\]\s*=/.test(l))
    .map((l) => l.trim());
  assert.ok(assigns.length > 0, 'the features must still be produced');
  for (const line of assigns) {
    assert.ok(/cat_maps\[/.test(line) || /\.fillna\(/.test(line),
      'every assignment to category_baseline / refined_category_baseline must come '
      + `from cat_maps or a fallback fillna. Offending line: ${line}\n`
      + '  A per-city ("leave-one-out computed once") map applied here measured '
      + '+2.82 MAE of optimism against +0.34 for doing nothing — it is a BIGGER '
      + 'leak, because the feature then varies by city inside a fold and the '
      + "held-out city's own level can be read back off it. See RETRAIN.md lever 2.");
  }
  const lookups = [...PREPARE_CODE.matchAll(/\.index\.map\(([^)]*)/g)].map((m) => m[1].trim());
  for (const arg of lookups) {
    assert.match(arg, /^cat_maps\[/,
      `every category lookup must be keyed on cat_maps, got .index.map(${arg}). `
      + 'A lookup keyed on the leave-out group is the disproved formulation.');
  }
});

// ── 3. The honesty of the record ───────────────────────────────────────────

test('the metadata records where each map was fitted and that the leak is still open', () => {
  assert.match(PREPARE_CODE, /'category_baseline_fit': category_baseline_fit,/,
    'model_metadata.json must say where these two label-means were fitted and where '
    + 'they were applied; an artifact must not require reading the source to find out');
  assert.match(PREPARE_CODE, /'residual_leak': \(\s*'OPEN IN THIS FILE/,
    'this file still fits the maps on the frame it applies them to and cannot do '
    + 'otherwise — being constant within a fold is what makes the correction honest, '
    + 'and prepare_features has no folds. The metadata must keep saying so, and must '
    + 'point at where it IS corrected, rather than either claiming a clean close or '
    + 'leaving a reader to think the reported CV is still inflated.');
  assert.match(PREPARE_CODE, /'per_fold_inputs_shipped': True/,
    'and it must record that the raw material for the real fix is in the pickle');
});

test('prepare_features.py and train_model.py agree about whether the leak is open', () => {
  const trainerSaysOpen = /'known_residual_leak'/.test(TRAIN_PY);
  const prepSaysOpen = /'residual_leak': \(\s*'OPEN/.test(PREPARE_PY);
  assert.equal(trainerSaysOpen, prepSaysOpen,
    'train_model.py writes metadata.training_contracts.known_residual_leak and '
    + 'prepare_features.py writes metadata.corpus_contract.category_baseline_fit. '
    + 'They describe the SAME leak and land in the SAME file. If one is removed the '
    + 'other must be updated in the same change, or model_metadata.json contradicts '
    + 'itself about whether a known leak exists.');
});

test('RETRAIN.md warns off the disproved formulation instead of just naming the lever', () => {
  assert.match(RETRAIN_MD, /per-fold refit/i,
    'lever 2 must say the recomputation has to be PER-FOLD');
  assert.match(RETRAIN_MD, /computed once/i,
    'and must name the compute-once formulation that looks equivalent and is not');
  assert.match(RETRAIN_MD, /category_cell_stats/,
    'and must point at the statistics already shipped for it, so the lever is not '
    + 're-scoped as "needs a CV refactor" by the next reader');
  assert.match(RETRAIN_MD, /1\.52 – 3\.05|1\.52-3\.05/,
    'the measured understatement belongs in the doc — a claim this '
    + 'counter-intuitive will be re-litigated unless the numbers are written down');
});

// ── 4. Guards this change was not allowed to weaken ────────────────────────

test('the guards round 14 was not allowed to weaken are intact', () => {
  assert.equal((PREPARE_PY.match(/def serving_population_mask\(/g) || []).length, 1,
    'serving_population_mask must remain the SINGLE definition of the population '
    + 'production scores with the model (audit finding 6)');
  assert.match(QUICK_EVAL_PY, /from prepare_features import[^\n]*serving_population_mask/,
    'quick_eval.py must import it rather than re-implementing the gate slice');

  const exportBlock = PREPARE_PY.match(/EXPORT_COLUMNS: List\[str\] = \[([\s\S]*?)\n\]/);
  assert.ok(exportBlock, 'EXPORT_COLUMNS must still be a literal list');
  const cols = [...exportBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.equal(cols.length, 44,
    'the export contract is 44 columns since round 20 appended label_source and '
    + 'vendor_forecast_pct; round 14 must not have added or dropped one');
  assert.ok(cols.includes('venue_id') && cols.includes('label_provenance'),
    'venue_id drives the baseline smoothing and label_provenance drives the '
    + 'vendor-forecast sample weight');

  assert.match(PREPARE_CODE, /def enforce_calendar_contract\(/,
    'the undated-row refusal must still exist');
  assert.match(PREPARE_PY, /raise CorpusContractError\(\s*f'\{stats\["rows_without_month"\]\} rows/,
    'prepare_features.py must keep REFUSING rows with no usable month/season rather '
    + 'than filling them with zeros — month=0 with all four season one-hots at 0 is '
    + 'a point inference can never produce (audit finding 5)');
});
