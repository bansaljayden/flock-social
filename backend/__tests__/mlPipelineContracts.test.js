// ---------------------------------------------------------------------------
// Source-level pins for the Python training pipeline.
//
// The 2026-08-15 pre-retrain audit found that three shipped fixes never reached
// a model artifact, because every one of prepare_features.py's guards was a
// SOFT `if column in df.columns` that skipped the work and logged a warning
// nobody read. There is no Python test runner in this repo, so these are
// source-level pins: they cannot check that the arithmetic is right, but they
// can make it impossible for a soft guard, a positional shift, an unfiltered
// gate slice, or a missing incumbent comparison to come back unnoticed.
//
// If you are here because one of these failed: the assertion message names the
// audit finding. Do not relax the pin to make it pass.
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ML_DIR = path.join(__dirname, '..', 'scripts', 'ml');
const TRAIN_DIR = path.join(ML_DIR, 'train');

const read = (p) => fs.readFileSync(p, 'utf8');
const PREPARE = read(path.join(TRAIN_DIR, 'prepare_features.py'));
const QUICK_EVAL = read(path.join(TRAIN_DIR, 'quick_eval.py'));
const EVALUATE = read(path.join(TRAIN_DIR, 'evaluate_model.py'));
const RETRAIN_MD = read(path.join(ML_DIR, 'RETRAIN.md'));

// export_training_data.js is read as TEXT, never required: requiring it runs
// dotenv against backend/.env (which points at the live Railway database) and
// constructs a pg Pool. A contract test has no business doing either.
const EXPORT_JS = read(path.join(TRAIN_DIR, 'export_training_data.js'));
const HEADER_COLUMNS = (() => {
  const m = EXPORT_JS.match(/const HEADER = \[([\s\S]*?)\]\.join\(','\)/);
  assert.ok(m, 'export_training_data.js no longer declares HEADER as a joined array literal');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
})();

// Python list literals are the only structured data we can read out of a .py
// file without a Python runtime. Pull the string entries out of a named list.
function pyStringList(source, name) {
  const m = source.match(new RegExp(`^${name}[^=]*=\\s*\\[([\\s\\S]*?)^\\]`, 'm'));
  assert.ok(m, `${name} is not defined as a multi-line list literal in the Python source`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

// ── Finding 1: the corpus contract, and no soft column guards ───────────────

test('prepare_features pins the exporter\'s exact 44-column contract', () => {
  const declared = pyStringList(PREPARE, 'EXPORT_COLUMNS');
  const exported = HEADER_COLUMNS;
  assert.deepEqual(declared, exported,
    'EXPORT_COLUMNS in prepare_features.py has drifted from export_training_data.js HEADER. ' +
    'The whole point of the contract check is that these two agree; if the exporter gained ' +
    'or lost a column, update both in the same change.');
  // 42 until round 20, which appended label_source and vendor_forecast_pct.
  // mlExportColumnGrowth.test.js owns the detail of that growth; this stays a
  // bare count so a silent addition anywhere cannot slip past both files.
  assert.equal(exported.length, 44);
  assert.ok(exported.includes('venue_id') && exported.includes('label_provenance'),
    'venue_id drives baseline smoothing and label_provenance drives the vendor-forecast ' +
    'sample weight — the 40-column pre-round-10 export lacked both');
});

test('the contract is enforced on BOTH csvs before any feature is built', () => {
  assert.match(PREPARE, /def require_export_columns\(/);
  assert.match(PREPARE, /raise CorpusContractError\(/);
  const calls = [...PREPARE.matchAll(/require_export_columns\(\s*(\w+)/g)].map((m) => m[1]);
  assert.ok(calls.includes('train_df'), 'training_data.csv is not contract-checked');
  assert.ok(calls.includes('holdout_df'), 'holdout_data.csv is not contract-checked');
});

test('the soft column guards that let three fixes ship into nothing are gone', () => {
  // Each of these silently skipped real work when the column was absent.
  const banned = [
    [/if\s+'venue_id'\s+in\s+df\.columns/, 'skipped baseline smoothing entirely'],
    [/if\s+'label_provenance'\s+not\s+in\s+train_df\.columns/, 'weighted every vendor forecast at 1.0'],
    [/if\s+'observed_date'\s+not\s+in\s+df\.columns/, 'zeroed the special-night features'],
    [/if\s+'baseline_busyness'\s+not\s+in\s+holdout_df\.columns/, 'made the holdout baseline 0'],
    [/if\s+'city'\s+in\s+train_df\.columns/, 'dropped the city grouping from the pickle'],
    [/df\.get\('is_weekend'/, 'zeroed the event interaction features'],
    [/df\.get\('is_dinner_hour'/, 'zeroed the event interaction features'],
  ];
  for (const [re, damage] of banned) {
    assert.ok(!re.test(PREPARE),
      `soft guard ${re} is back in prepare_features.py — when it fires it ${damage}, ` +
      'and the only signal is a log line. Raise CorpusContractError instead.');
  }
});

test('the escape hatches default to require and are recorded in metadata', () => {
  assert.match(PREPARE, /FLOCK_WEATHER_POLICY['"]\s*,\s*['"]require['"]/,
    'the weather policy must default to require, not to a silent drop');
  assert.match(PREPARE, /FLOCK_CALENDAR_POLICY['"]\s*,\s*['"]require['"]/,
    'the calendar policy must default to require, not to a silent drop');
  assert.match(PREPARE, /'corpus_contract':/,
    'model_metadata.json must record which policy produced the artifact');
  assert.match(PREPARE, /'weather_policy': WEATHER_POLICY/);
  assert.match(PREPARE, /'calendar_policy': CALENDAR_POLICY/);
  assert.match(PREPARE, /'dropped_features': sorted\(DROPPED_FEATURES\)/);
});

// ── Finding 3: the baseline smoothing is no longer positional ───────────────

test('baseline smoothing never uses a positional shift on the raw frame', () => {
  assert.ok(!/groupby\(\['venue_id',\s*'day_of_week'\]\)\['baseline_busyness'\]\.shift\(/.test(PREPARE),
    'the positional shift(1)/shift(-1) is back. It is the PREVIOUS ROW, not the previous ' +
    'HOUR: with k rows in a (venue, dow, hour) cell — 16% of cells hold more than one, ' +
    'realtime cells reach 8 — k-1 of them get smoothed against their own hour.');
  assert.match(PREPARE, /def smooth_baseline_hours\(/);
  assert.match(PREPARE, /df = smooth_baseline_hours\(df\)/,
    'smooth_baseline_hours must actually be called from add_baseline_features');
  // Its defining property: collapse duplicates first, then lay them on a full grid.
  assert.match(PREPARE, /groupby\(\['venue_id', 'day_of_week', 'hour'\]/);
  assert.match(PREPARE, /MultiIndex\.from_product\(\s*\n?\s*\[venues, range\(7\), range\(24\)\]/,
    'the 7x24 reindex is what makes a MISSING hour a real gap instead of a silent ' +
    'positional neighbour');
  assert.match(PREPARE, /np\.roll\(arr, 1, axis=1\)/,
    'neighbours must wrap across the day boundary the way mlPredictor.getBaseline does');
});

// ── Finding 4: weather codes are recovered, not left constant ───────────────

test('every weather description in the shipped corpus maps to a condition code', () => {
  // The 25 distinct non-empty weather_condition values in the 2026-08-12
  // training_data.csv export (3.29M rows carry one of these).
  const OBSERVED = [
    'clear sky', 'overcast clouds', 'broken clouds', 'few clouds', 'scattered clouds',
    'haze', 'light rain', 'mist', 'heavy intensity rain', 'moderate rain',
    'light intensity shower rain', 'fog', 'thunderstorm', 'light intensity drizzle',
    'very heavy rain', 'light snow', 'thunderstorm with light rain', 'drizzle', 'snow',
    'smoke', 'thunderstorm with rain', 'ragged thunderstorm', 'extreme rain', 'sand',
    'thunderstorm with heavy rain',
  ];
  const mapBlock = PREPARE.match(/WEATHER_DESCRIPTION_CODES[^=]*=\s*\{([\s\S]*?)^\}/m);
  assert.ok(mapBlock, 'WEATHER_DESCRIPTION_CODES is missing — weather_condition_code is ' +
    'NULL on 100% of the corpus and without this map ten features are constant');
  const mapped = new Set([...mapBlock[1].matchAll(/'([^']+)':\s*\d+/g)].map((m) => m[1]));
  const unmapped = OBSERVED.filter((d) => !mapped.has(d));
  assert.deepEqual(unmapped, [],
    'these descriptions occur in the shipped corpus but have no OpenWeatherMap code — ' +
    'they would stop the next retrain');
  assert.match(PREPARE, /def recover_weather_codes\(/);
  assert.match(PREPARE, /unmapped_descriptions/,
    'unmapped descriptions must be reported by name, never bucketed to "other" in silence');
});

// ── Finding 6: the gate measures the rows production serves ─────────────────

test('the gate\'s row filter is IMPORTED from training, not re-implemented', () => {
  assert.match(PREPARE, /def serving_population_mask\(/,
    'the single definition of "rows production scores with the model" must live in ' +
    'prepare_features.py');
  assert.match(PREPARE, /train_df\[serving_population_mask\(train_df\['baseline_busyness'\]\)\]/,
    'the TRAINING filter must go through serving_population_mask');
  assert.match(QUICK_EVAL, /from prepare_features import serving_population_mask/,
    'quick_eval.py must import the predicate rather than re-implement `baseline > 0`; ' +
    'that divergence is exactly how the gate came to be measured on rows production ' +
    'refuses to serve');
  assert.match(QUICK_EVAL, /served = serving_population_mask\(hold_baseline\)/);
  assert.match(QUICK_EVAL, /rt_mask = rt_all & served/,
    'the gate slice must be realtime AND servable');
  assert.match(QUICK_EVAL, /'excluded_no_baseline_rows': excluded_no_baseline/,
    'the number of rows the fix removed from the gate must be reported, not hidden');
  assert.match(QUICK_EVAL, /realtime_unfiltered_diagnostic/,
    'the pre-fix unfiltered number stays as a labelled diagnostic so the change is visible');
});

// ── Finding 7: the incumbent comparison exists and is required ──────────────

test('quick_eval loads and scores the incumbent artifact', () => {
  assert.match(QUICK_EVAL, /INCUMBENT_DIR = MODELS_DIR \/ 'incumbent'/);
  assert.match(QUICK_EVAL, /def compare_incumbent\(/);
  assert.match(QUICK_EVAL, /inc_model = inc_data\['model'\]/,
    'a SECOND model must actually be loaded — the audit found quick_eval.py loaded ' +
    'exactly one model and one baseline while RETRAIN.md claimed otherwise');
  assert.match(QUICK_EVAL, /inc_model\.predict\(/);
  // Both honest bases, and the refusal when neither is available.
  assert.match(QUICK_EVAL, /same_rows_same_features/);
  assert.match(QUICK_EVAL, /same_rows_preserved_features/);
  assert.match(QUICK_EVAL, /'status': 'incomparable'/,
    'a feature-set change with no preserved holdout pickle must be reported as ' +
    'incomparable, not quietly skipped');
  assert.match(QUICK_EVAL, /np\.array_equal\(inc_y_actual/,
    'the two holdouts must be verified to be the SAME ROWS before the numbers are compared');
});

test('an absent or dishonest incumbent comparison fails the gate', () => {
  assert.match(QUICK_EVAL, /overall_pass = bool\(rt_pass and floor_pass and incumbent_pass\)/,
    'incumbent_pass must be ANDed into the verdict; a comparison that only prints is ' +
    'the same as no comparison');
  assert.match(QUICK_EVAL, /ML_ALLOW_NO_INCUMBENT/,
    'the first-model-ever case needs an explicit, named opt-out — never a default pass');
  assert.match(QUICK_EVAL, /ML_ALLOW_APPROXIMATE_INCUMBENT/);
  assert.match(QUICK_EVAL, /'incumbent': incumbent/,
    'the comparison must be persisted into ship_gate so it can be read after the fact');
});

test('the gate did not get weaker: MAE may not regress and there is an absolute floor', () => {
  assert.match(QUICK_EVAL, /no_mae_regression = rt_mae_delta >= 0/,
    'v2.5 passed by failing the MAE arm by 2.7 points and clearing the R2 arm by 0.0026');
  // The floor used to be the constant 29.2, carried over from before the clock
  // axis was corrected. Nothing could meet it: measured on the corrected
  // holdout the INCUMBENT itself scores 19.3, so the constant was not a bar,
  // it was a wall. It is now derived from the incumbent's own measured
  // within-10 on the same rows, which is the honest version of the same
  // intent: a challenger must be at least as good as what users already have.
  // The constant survives only for the no-incumbent path.
  assert.match(QUICK_EVAL, /floor_value = incumbent\['incumbent_realtime_within_10'\]/,
    'the floor must be measured against the incumbent, not a constant nobody can meet');
  assert.match(QUICK_EVAL, /floor_basis = 'incumbent_measured_within_10_same_rows'/,
    'the basis must be recorded so a reader knows which floor was applied');
  assert.match(QUICK_EVAL, /STATIC_FLOOR_FALLBACK = 29\.2/,
    'the old constant stays as the fallback when there is no incumbent to measure');
  assert.match(QUICK_EVAL, /rt_pass = bool\(relative_pass and no_mae_regression\)/);
  assert.match(QUICK_EVAL, /GATE_MAE_IMPROVEMENT = 5\.0/);
  assert.match(QUICK_EVAL, /GATE_R2_IMPROVEMENT = 0\.10/);
});

// ── Finding 10: the diagnostics are aligned to the rows they describe ───────

test('evaluate_model never positionally truncates the raw CSV against the matrix', () => {
  assert.ok(!/read_csv\(SCRIPT_DIR \/ 'training_data\.csv'\)/.test(EVALUATE),
    'evaluate_model.py must not re-read the raw CSV. It has 3.57M rows against a ' +
    '2.07M-row filtered feature matrix, and the truncation that reconciled them ' +
    'paired every prediction with an unrelated row\'s hour.');
  assert.ok(!/\.values\[:len\(y_train_all_eval\)\]/.test(EVALUATE),
    'the positional truncation is back');
  assert.match(EVALUATE, /train_hours = train_data\.get\('hour'\)/,
    'hour must travel inside the pickle, aligned to the same rows as the predictions');
  assert.match(EVALUATE, /train_categories = train_data\.get\('venue_category'\)/);
  assert.match(EVALUATE, /len\(train_hours\) == len\(y_train_all_eval\)/,
    'the alignment must be length-checked, and the plot skipped rather than drawn wrong');
  assert.match(PREPARE, /'hour': train_df\['hour'\]\.values/,
    'prepare_features must write the aligned hour column into features_train.pkl');
  assert.match(PREPARE, /'venue_category': train_df\['venue_category'\]/);
});

test('the LOCO refit uses the sample weights the model was actually trained with', () => {
  assert.match(EVALUATE, /m\.fit\(X_train_all\[train_idx\], y_train_all\[train_idx\],\s*\n?\s*sample_weight=train_weight\[train_idx\]\)/,
    'refitting each fold unweighted made evaluation.validation describe a model that ' +
    'was never trained and never shipped — the v2.3.1 blend IS the training regime');
});

// ── The runbook has to match the pipeline ───────────────────────────────────

test('RETRAIN.md starts the retrain at the export, not at prepare_features', () => {
  const exportIdx = RETRAIN_MD.indexOf('node export_training_data.js');
  const prepareIdx = RETRAIN_MD.indexOf('python prepare_features.py');
  assert.ok(exportIdx > -1,
    'the runbook must name the export step — starting at prepare_features.py is how ' +
    'three rounds of fixes retrained from a stale 40-column CSV');
  assert.ok(prepareIdx > -1);
  assert.ok(exportIdx < prepareIdx,
    'the export must come BEFORE prepare_features.py in the runbook');
});

test('RETRAIN.md tells you to preserve the incumbent before anything overwrites it', () => {
  assert.match(RETRAIN_MD, /mkdir -p models\/incumbent/);
  assert.match(RETRAIN_MD, /cp train\/best_model\.pkl train\/features_holdout\.pkl models\/incumbent\//,
    'the holdout pickle must be preserved too — when the feature set changes it is the ' +
    'only way to score the incumbent on the same rows');
  assert.match(RETRAIN_MD, /holdout_realtime_served/,
    'the runbook must name the gate basis a reader should verify');
});

test('RETRAIN.md no longer claims an incumbent comparison that did not exist', () => {
  assert.ok(!/`quick_eval\.py` does this and writes the\n> verdict into `ship_gate`/.test(RETRAIN_MD),
    'the old claim that quick_eval.py already re-ran the incumbent is what made the ' +
    'missing comparison invisible for three rounds');
  assert.ok(!/21\.46 vs\n> the incumbent's 22\.77/.test(RETRAIN_MD),
    'those figures are reproducible from no script in this repo and appear in no ' +
    'checked-in log; do not quote them as a bar');
});

test('RETRAIN.md carries a status for every blocking audit finding', () => {
  const section = RETRAIN_MD.slice(RETRAIN_MD.indexOf('## Pre-retrain audit status'));
  assert.ok(section.length > 0, 'the audit status board is missing from RETRAIN.md');
  for (let i = 1; i <= 8; i++) {
    assert.match(section, new RegExp(`^\\| ${i} \\|`, 'm'),
      `blocking finding ${i} has no row in the status board`);
  }
  // This used to grep for one exact index expression. The point was never that
  // expression: it was that finding 2 must not be left as the vague instruction
  // "add a unique constraint", because the shape is where the data loss hides.
  // The migration that landed deliberately chose a DIFFERENT shape and wrote
  // down why the specified one would have destroyed rows, which satisfies the
  // intent better than the literal text did. So the pin asks for what actually
  // matters: the finding is closed by a NAMED migration, and the key's shape is
  // written down somewhere a reader can find it.
  assert.match(section, /`?024_ml_training_data_unique_slot\.sql`?/,
    'finding 2 must be closed by a named migration, not by a promise');
  assert.match(RETRAIN_MD, /unique key on `ml_training_data`/i,
    'the chosen key shape and the reasoning behind it must be written down, since ' +
    'that is where the data loss hides');
  assert.match(section, /dinnerPeakAccuracy\.test\.js:332/,
    'finding 8 is only partly closed: the test that pins the bent clock axis must be ' +
    'inverted as part of the clock fix, and the runbook has to say so');
});

// ── Round 22: dead feature slots ────────────────────────────────────────────
//
// A constant feature column is the quietest defect this pipeline has. It is
// never a split, so it produces no wrong number to notice; metadata advertises
// it, mlPredictor.js builds it, and the feature-parity gate happily confirms
// that both sides compute the same nothing. The last run carried ELEVEN of 106.
// Ten were true statements about a ten-week corpus. One, cold_outdoor, was a
// Celsius threshold applied to a Fahrenheit column — dead in training AND at
// inference, with parity green throughout. The old check was a logger.warning
// that lumped all eleven together, so no reader could tell those apart.

const PREDICTOR_JS = read(path.join(__dirname, '..', 'services', 'mlPredictor.js'));

test('a constant feature column must be explained or it stops the run', () => {
  assert.match(PREPARE, /def enforce_dead_slot_contract\(/,
    'the dead-slot report must be a contract, not a log line: eleven dead slots ' +
    'survived four rounds behind a warning that said "some of these are ' +
    'legitimately sparse" without saying which');
  assert.match(PREPARE, /dead_slot_record = enforce_dead_slot_contract\(constant_cols, feature_cols\)/,
    'the contract must actually be called on the final feature set');
  assert.match(PREPARE, /raise CorpusContractError\(\s*\n?\s*f'\{len\(unexplained\)\} feature\(s\) are CONSTANT/,
    'an unexplained constant column must RAISE. Downgrading it to a warning is ' +
    'the exact regression this pin exists to stop.');
  assert.ok(!/logger\.warning\(\s*\n?\s*'DEAD SLOTS — %d of %d features are CONSTANT across the training frame '\s*\n?\s*'and can never be split on: %s'/.test(PREPARE),
    'the old passive dead-slot warning is back in place of the contract');
});

test('every name excused as expected-sparse carries a reason and a fill-in condition', () => {
  const block = PREPARE.match(/EXPECTED_SPARSE_FEATURES: Dict\[str, str\] = \{([\s\S]*?)^\}/m);
  assert.ok(block, 'EXPECTED_SPARSE_FEATURES is not a dict literal any more');
  const names = [...block[1].matchAll(/^\s{4}'([^']+)':/gm)].map((x) => x[1]);
  assert.ok(names.length >= 10,
    'the inventory should still name the ten explained dead slots of the last run');
  assert.ok(!names.includes('cold_outdoor'),
    'cold_outdoor is a UNIT BUG, not a sparse feature. Excusing it here would ' +
    'restore the dead slot behind a justification and defeat the whole contract.');
  // The list is an inventory, not an excuse list: it has to say what would make
  // each entry stop being constant, or it becomes permanent.
  assert.match(block[1], /FILLS IN/,
    'an entry that does not say what makes it fill in is an excuse, not an inventory');
  assert.match(block[1], /audit finding 13/i,
    'the four venue_feedback slots must keep pointing at the lookahead leak that ' +
    'arms on the very day they stop being constant');
});

test('the dead-slot hatch defaults to require and is recorded in the artifact', () => {
  assert.match(PREPARE, /FLOCK_DEAD_SLOT_POLICY['"]\s*,\s*['"]require['"]/,
    'the dead-slot policy must default to require, not to a silent warn');
  assert.match(PREPARE, /'dead_slot_policy': DEAD_SLOT_POLICY/,
    'model_metadata.json must record which policy produced the artifact');
  assert.match(PREPARE, /'dead_slots': dead_slot_record/,
    'an artifact that ships a dead column must carry the justification for it');
});

test('cold_outdoor uses the same Fahrenheit threshold in training and in serving', () => {
  // services/weatherService.js fetches OpenWeatherMap with units=imperial, so
  // the corpus temperature column is °F (minimum 14.7). `< 5` is -15°C: it was
  // false on all 1,934,988 training rows and on every live reading, and BOTH
  // files carried it, so parity was green while the slot was dead on both
  // sides. A parity check cannot find a unit error; only the value-level
  // dead-slot contract above can.
  const py = PREPARE.match(/COLD_OUTDOOR_MAX_TEMP_F = ([\d.]+)/);
  assert.ok(py, 'prepare_features.py no longer names the cold_outdoor threshold');
  const js = PREDICTOR_JS.match(/cold_outdoor: \(Number\.isFinite\(temp\) && temp < ([\d.]+)/);
  assert.ok(js, 'mlPredictor.js no longer computes cold_outdoor from a literal threshold');
  assert.equal(parseFloat(js[1]), parseFloat(py[1]),
    'training and serving disagree about what "cold" is. The model would be fed a ' +
    'feature it was never trained on, silently, on cold clear nights.');
  assert.equal(parseFloat(py[1]), 41,
    '41°F is 5°C, the line the author plainly meant, in the units the corpus is ' +
    'collected in. 5 is the Celsius original and can never fire.');
  assert.match(PREPARE, /units=imperial/,
    'the reason the threshold is 41 has to stay next to the threshold');
});
