"""
SHIP GATE. Scores the freshly-trained model on the holdout, compares it to the
popular_times baseline AND to the incumbent artifact, and writes the verdict
mlPredictor.init() reads.

Training metrics: re-uses LOCO CV numbers from model_metadata.json (already
computed honestly in train_model.py).
Holdout: one forward pass with the full-trained model.

Two audit fixes live here:

  Finding 6 — the gate slice is now filtered to the population production
  actually serves. mlPredictor routes any venue with no baseline to the rule
  engine, and prepare_features filters TRAINING to baseline > 0 for exactly that
  reason; the gate did not, so it was decided partly on rows the product never
  scores with this model. The filter is not re-implemented here — it is imported
  from prepare_features so the two cannot drift.

  Finding 7 — the incumbent comparison now exists. RETRAIN.md claimed this
  script "re-runs the incumbent on the same holdout every time"; it never loaded
  a second model, so a retrain worse than v2.5 that still beat the raw baseline
  would have shipped. The incumbent is required by default.
"""

import json
import logging
import os
import pickle
from pathlib import Path

import numpy as np

from prepare_features import serving_population_mask

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

SCRIPT_DIR = Path(__file__).parent
MODELS_DIR = SCRIPT_DIR.parent / 'models'
INCUMBENT_DIR = MODELS_DIR / 'incumbent'

# Relative-improvement thresholds (unchanged doctrine).
GATE_MAE_IMPROVEMENT = 5.0
GATE_R2_IMPROVEMENT = 0.10

# Absolute floor (audit finding 8). The gate is `baseline + clamp(delta)` versus
# `baseline` on the same rows, so any error SHARED by both sides cancels and the
# gate cannot see corpus-wide corruption.
#
# 2026-08-18: the floor is now DERIVED FROM MEASUREMENT, not a constant. The old
# constant (29.2, kept below as the no-incumbent fallback) was v2.5's realtime
# within-10 measured on the PRE-clock-fix axis; on the corrected axis the
# incumbent itself scores far below it, so the constant stopped meaning "do not
# ship something users would be worse off with" and started meaning "ship
# nothing". Per RETRAIN.md / MODEL-METRICS.md: re-derive the floor from
# measurement, do not lower it to admit a model. The honest measurement of
# "worse off" is the incumbent scored on the SAME corrected holdout rows, so
# the floor is the incumbent's measured within-10 on the head-to-head slice,
# and the challenger's within-10 is compared on those identical rows. The
# derivation is recorded in ship_gate.floor_derivation.
STATIC_FLOOR_FALLBACK = 29.2  # pre-clock-fix v2.5 figure; used only when no
                              # incumbent exists (ML_ALLOW_NO_INCUMBENT path).

# Explicit, recorded escape hatches. Neither may be used for a release.
ALLOW_NO_INCUMBENT = os.environ.get('ML_ALLOW_NO_INCUMBENT', '').lower() == 'true'
ALLOW_APPROXIMATE_INCUMBENT = os.environ.get('ML_ALLOW_APPROXIMATE_INCUMBENT', '').lower() == 'true'


def metrics(y_true, y_pred):
    y_pred = np.clip(y_pred, 0, 100)
    errors = np.abs(y_true - y_pred)
    return {
        'rmse': round(float(np.sqrt(np.mean((y_true - y_pred) ** 2))), 4),
        'mae': round(float(np.mean(errors)), 4),
        'r2': round(float(1 - np.sum((y_true - y_pred) ** 2) / np.sum((y_true - np.mean(y_true)) ** 2)), 4),
        'within_5': round(float(np.mean(errors <= 5) * 100), 1),
        'within_10': round(float(np.mean(errors <= 10) * 100), 1),
        'within_15': round(float(np.mean(errors <= 15) * 100), 1),
        'within_20': round(float(np.mean(errors <= 20) * 100), 1),
    }


def reconstruct(raw_delta, baseline):
    """Production's reconstruction, byte-for-byte with mlPredictor.js
    reconstructScore (dispersion lab 2026-08-19, RETRAIN-V27-LOG.md):
    baseline + clamp(delta, -50, 50), clipped 0-100, then the 1-point extremes
    push -- scores < 25 get -1, > 65 get +1, re-clipped. The clamp deliberately
    overrides metadata.delta_clamp_range (+-30, the training-time record): the
    lab measured +-50 + push as the only candidate clearing the gate (W10
    +0.26pp CI [+0.17, +0.37], MAE -0.0002, 2000-resample date-block
    bootstrap). The gate must score the reconstruction production actually
    performs, so if reconstructScore changes, this changes with it. (Serving
    rounds to an integer at the end; this stays float, the convention every
    prior gate number was computed under -- sub-half-point, direction-free.)

    Then, ONLY when CROWD_QMAP_ENABLED=true, the score quantile map below --
    the same flag and the same table mlPredictor reads. Off by default, and
    ship_gate.score_qmap_enabled records which arithmetic produced the run's
    numbers so a verdict cannot be read against the wrong reconstruction."""
    score = np.clip(baseline + np.clip(raw_delta, -50, 50), 0, 100)
    score = np.where(score < 25, score - 1, np.where(score > 65, score + 1, score))
    score = np.clip(score, 0, 100)
    if QMAP_ENABLED:
        score = apply_score_qmap(score)
    # ROUNDED since 2026-08-28, closing WITHIN-CITY-EVAL.md 10.1: production
    # publishes Math.round()ed integers onto a corpus whose baselines are all
    # integers and whose labels are all multiples of 5, so an unrounded float
    # here scored a predictor that can never land exactly on the inclusive
    # within-N boundary against a baseline that lands there on 2.3-3.8% of
    # rows. That artifact understated the model's within-10 by about a point
    # in every city and flipped philly's sign. Both the challenger and the
    # incumbent flow through this same function, so the head-to-head stays
    # internally comparable; numbers from runs before this date are about one
    # point lower for reconstruction-artifact reasons, not model reasons.
    return np.round(score)


# ---------------------------------------------------------------------------
# score-qmap — the SAME two arrays services/mlPredictor.js carries, applied with
# the same np.interp semantics (constant at both ends, linear between knots), so
# the gate scores the arithmetic production performs. ARMED by default since
# 2026-08-28 (Jayden: within-10 is the primary metric); CROWD_QMAP_ENABLED=false
# is the kill switch on both sides, and a run's reconstruction is recorded
# either way so a verdict cannot be read against the wrong arithmetic.
#
# The one deliberate difference is the final rounding, and it is the difference
# that already existed between reconstructScore and this function: serving
# publishes an integer, the gate stays float because every prior gate number was
# computed that way. If the table changes on either side, it changes on both.
#
# Fitted 2026-08-20 on the earliest 30% of gate dates (<= 2026-03-28, 21,148
# rows) from the shipped 2.6.0-starling artifacts and scored forward on 46,101.
# The table is that artifact's quantile grid; mlPredictor refuses to apply it to
# any other model_version and so does this (QMAP_FITTED_ON below is checked by
# __tests__/mlTrainingContracts.test.js against the JS constant).
# ---------------------------------------------------------------------------
QMAP_ENABLED = os.environ.get('CROWD_QMAP_ENABLED', 'true').lower() != 'false'
QMAP_FITTED_ON = '2.6.0-starling'
QMAP_X = np.array([0, 5, 8, 10, 12, 14, 16, 18, 20, 21, 23, 25, 27, 28, 29, 31,
                   32, 34, 35, 36, 37, 39, 40, 42, 43, 45, 46, 48, 50, 51, 53,
                   55, 58, 60, 63, 67, 70, 74, 80, 89], dtype=float)
QMAP_Y = np.array([0, 0, 0, 0, 5, 5, 5, 5, 5, 5, 10, 10, 10, 15, 15, 20, 20, 25,
                   25, 30, 30, 35, 40, 40, 45, 50, 55, 55, 60, 65, 70, 75, 80,
                   85, 95, 100, 100, 100, 100, 100], dtype=float)


def apply_score_qmap(score):
    return np.clip(np.interp(score, QMAP_X, QMAP_Y), 0, 100)


def realtime_flags(X, feature_cols, n_rows):
    if 'is_realtime' not in feature_cols:
        return np.zeros(n_rows, dtype=int)
    return X[:, feature_cols.index('is_realtime')].astype(int)


# ---------------------------------------------------------------------------
# Incumbent comparison (audit finding 7)
# ---------------------------------------------------------------------------
def compare_incumbent(gate_mask, hold_y_actual, challenger_pred, current_feature_cols,
                      X_hold, hold_baseline):
    """Score the previous artifact on the SAME holdout rows as the challenger.

    Returns (result_dict, incumbent_passes). `incumbent_passes` is False whenever
    the comparison could not be made honestly — an unavailable comparison is a
    gate failure, not a free pass.
    """
    model_path = INCUMBENT_DIR / 'best_model.pkl'
    if not model_path.exists():
        if ALLOW_NO_INCUMBENT:
            logger.warning(
                'NO INCUMBENT at %s and ML_ALLOW_NO_INCUMBENT=true — shipping '
                'without a regression check. This is only correct for the FIRST '
                'model ever trained.', model_path)
            return {'status': 'absent_acknowledged',
                    'note': 'ML_ALLOW_NO_INCUMBENT=true — no regression check was performed'}, True
        logger.error(
            'NO INCUMBENT at %s. The gate cannot tell whether this model is better '
            'than the one in production.\n'
            '  Before training, run:\n'
            '    mkdir -p models/incumbent\n'
            '    cp models/crowd_model.onnx models/model_metadata.json models/incumbent/\n'
            '    cp train/best_model.pkl train/features_holdout.pkl models/incumbent/\n'
            '  If this genuinely is the first model, set ML_ALLOW_NO_INCUMBENT=true.',
            model_path)
        return {'status': 'absent', 'reason': 'models/incumbent/best_model.pkl not found'}, False

    with open(model_path, 'rb') as f:
        inc_data = pickle.load(f)
    inc_model = inc_data['model']
    inc_feature_cols = list(inc_data.get('feature_cols') or [])

    inc_version = None
    inc_meta_path = INCUMBENT_DIR / 'model_metadata.json'
    if inc_meta_path.exists():
        try:
            inc_version = json.loads(inc_meta_path.read_text(encoding='utf-8')).get('model_version')
        except (json.JSONDecodeError, OSError):
            inc_version = None

    # Case A — identical feature set: score the incumbent on the challenger's own
    # matrix. Same rows, same columns, nothing approximated.
    if inc_feature_cols == list(current_feature_cols):
        inc_pred = reconstruct(inc_model.predict(X_hold), hold_baseline)
        inc_baseline = hold_baseline
        basis = 'same_rows_same_features'
        comparable = True
        rows_note = None
    else:
        # Case B — the feature set changed (findings 4 and 5 both change columns).
        # The honest comparison is the incumbent run through its OWN preserved
        # holdout pickle, on the same holdout ROWS.
        inc_hold_path = INCUMBENT_DIR / 'features_holdout.pkl'
        if not inc_hold_path.exists():
            logger.error(
                'The feature set changed (%d incumbent columns vs %d now) and '
                'models/incumbent/features_holdout.pkl was not preserved, so the '
                'incumbent cannot consume this X and has no X of its own. '
                'No honest comparison is possible.',
                len(inc_feature_cols), len(current_feature_cols))
            return {'status': 'incomparable',
                    'reason': 'feature set changed and incumbent features_holdout.pkl was not preserved',
                    'incumbent_feature_count': len(inc_feature_cols),
                    'challenger_feature_count': len(current_feature_cols),
                    'incumbent_version': inc_version}, False

        with open(inc_hold_path, 'rb') as f:
            inc_hold = pickle.load(f)
        inc_y_actual = np.asarray(inc_hold['y_actual'], dtype=float)
        inc_baseline = np.asarray(inc_hold['baseline'], dtype=float)
        if len(inc_y_actual) != len(hold_y_actual):
            logger.error('Incumbent holdout has %d rows, current has %d — the row masks '
                         'cannot be applied to both.', len(inc_y_actual), len(hold_y_actual))
            return {'status': 'incomparable',
                    'reason': 'incumbent holdout row count differs from the current holdout',
                    'incumbent_rows': len(inc_y_actual),
                    'challenger_rows': len(hold_y_actual),
                    'incumbent_version': inc_version}, False
        same_rows = np.array_equal(inc_y_actual, np.asarray(hold_y_actual, dtype=float))
        inc_pred = reconstruct(inc_model.predict(inc_hold['X']), inc_baseline)
        if same_rows:
            basis = 'same_rows_preserved_features'
            comparable = True
            rows_note = None
        else:
            basis = 'approximate_different_rows'
            comparable = False
            rows_note = ('the two holdout exports have the same row COUNT but different '
                         'y_actual values — they are not the same rows')
            logger.error('APPROXIMATE incumbent comparison: %s', rows_note)

    # Both models must be judged on rows BOTH of them would serve. The LOO
    # baseline change and the smoothing fix move which rows have a baseline at
    # all, and scoring the incumbent on a row where ITS baseline is 0 caps its
    # reconstruction at clamp(delta) <= 50 against actuals up to 100 — that would
    # flatter the challenger and make this arm easier to pass, not harder.
    cmp_mask = gate_mask & serving_population_mask(inc_baseline)
    dropped = int(gate_mask.sum() - cmp_mask.sum())
    if int(cmp_mask.sum()) < 100:
        logger.error('Only %d rows are servable under BOTH the incumbent and the '
                     'challenger baselines — too few for an honest comparison.',
                     int(cmp_mask.sum()))
        return {'status': 'incomparable',
                'reason': 'fewer than 100 rows servable under both baselines',
                'comparable_rows': int(cmp_mask.sum()),
                'incumbent_version': inc_version}, False
    if dropped:
        logger.warning('%d gate rows have no incumbent baseline and are excluded from '
                       'the head-to-head (both models scored on the remaining %d).',
                       dropped, int(cmp_mask.sum()))

    inc_metrics = metrics(hold_y_actual[cmp_mask], inc_pred[cmp_mask])
    new_metrics = metrics(hold_y_actual[cmp_mask], challenger_pred[cmp_mask])
    mae_change = round(inc_metrics['mae'] - new_metrics['mae'], 4)  # positive = challenger better

    logger.info('\n========== INCUMBENT COMPARISON (%s, %d rows) ==========',
                basis, int(cmp_mask.sum()))
    logger.info('Incumbent %s — MAE: %s  R²: %s  W10: %s%%',
                inc_version or '(version unrecorded)', inc_metrics['mae'],
                inc_metrics['r2'], inc_metrics['within_10'])
    logger.info('Challenger        — MAE: %s  R²: %s  W10: %s%%',
                new_metrics['mae'], new_metrics['r2'], new_metrics['within_10'])
    logger.info('Δ MAE vs incumbent: %+.4f (positive = challenger better)', mae_change)

    no_regression = mae_change >= 0
    result = {
        'status': 'compared',
        # Consumed by the GATE-B evaluation in main and stripped before the
        # metadata write: aligned per-row arrays for the head-to-head rows.
        '_gate_rows': {
            'y': hold_y_actual[cmp_mask],
            'challenger': np.asarray(challenger_pred)[cmp_mask],
            'incumbent': inc_pred[cmp_mask],
            'cmp_mask': cmp_mask,
        },
        '_metrics_pair': (inc_metrics, new_metrics),
        'basis': basis,
        'comparable': comparable,
        'incumbent_version': inc_version,
        'comparable_rows': int(cmp_mask.sum()),
        'gate_rows_without_incumbent_baseline': dropped,
        'incumbent_realtime_mae': inc_metrics['mae'],
        'incumbent_realtime_r2': inc_metrics['r2'],
        'incumbent_realtime_within_10': inc_metrics['within_10'],
        'new_realtime_mae': new_metrics['mae'],
        'new_realtime_within_10': new_metrics['within_10'],
        'mae_improvement_vs_incumbent': mae_change,
        'no_regression': bool(no_regression),
        'rows_note': rows_note,
    }
    if not comparable and not ALLOW_APPROXIMATE_INCUMBENT:
        logger.error('Comparison is approximate and ML_ALLOW_APPROXIMATE_INCUMBENT is not set — '
                     'treating it as a gate failure.')
        return result, False
    if not no_regression:
        logger.error('REGRESSION: the challenger is %.4f MAE WORSE than the incumbent on '
                     'the gate slice.', -mae_change)
    return result, bool(no_regression)


def date_block_bootstrap(dates, y_true, pred_challenger, pred_incumbent,
                         n_resamples=2000, seed=26):
    """CI for (challenger - incumbent) deltas by resampling observation DATES
    with replacement, the same block structure every measured qmap number used
    (RETRAIN.md GATE-B: 2000-resample date-block bootstrap). Rows sharing a
    date move together, so day-level weather and event shocks stay intact
    inside each resample instead of being shuffled away."""
    dates = np.asarray(dates)
    uniq = np.unique(dates)
    if len(uniq) < 5:
        return None  # too few blocks for a CI anyone should trust
    idx_by_date = {d: np.where(dates == d)[0] for d in uniq}
    rng = np.random.default_rng(seed)
    w10_deltas = np.empty(n_resamples)
    mae_deltas = np.empty(n_resamples)
    for i in range(n_resamples):
        take = rng.choice(uniq, size=len(uniq), replace=True)
        rows = np.concatenate([idx_by_date[d] for d in take])
        ec = np.abs(y_true[rows] - pred_challenger[rows])
        ei = np.abs(y_true[rows] - pred_incumbent[rows])
        w10_deltas[i] = (np.mean(ec <= 10) - np.mean(ei <= 10)) * 100
        mae_deltas[i] = np.mean(ec) - np.mean(ei)
    return {
        'w10_delta_ci': [round(float(np.percentile(w10_deltas, 2.5)), 2),
                         round(float(np.percentile(w10_deltas, 97.5)), 2)],
        'mae_delta_ci': [round(float(np.percentile(mae_deltas, 2.5)), 3),
                         round(float(np.percentile(mae_deltas, 97.5)), 3)],
        'resamples': n_resamples,
        'date_blocks': int(len(uniq)),
    }


# ---------------------------------------------------------------------------
# GATE-B — ARMED 2026-08-28 as the EITHER-PATH gate. RETRAIN.md drafted B1-B5
# to replace the two MAE-protective baseline arms for a candidate that SPENDS
# MAE to buy within-10, and Jayden took that trade when he armed the qmap. The
# arming interpretation, recorded here because the draft predated the decision:
#
#   * The legacy arms (beat the popular-times baseline, no MAE regression) and
#     GATE-B's B1-B3 are ALTERNATIVE admission paths: a routine retrain that
#     does not spend MAE still ships the old way, and a deliberate
#     dispersion-spending candidate ships the B way. Requiring B1's +5pp of
#     every future incremental retrain would end shipping permanently, which
#     the draft cannot have meant.
#   * Arm 3 (the absolute within-10 floor, re-derived per run) and arm 4's
#     comparability requirement bind on BOTH paths. Arm 4's no-MAE-regression
#     clause is subsumed by B2's priced allowance on the B path, exactly as
#     B2's own derivation prices it against the incumbent.
#   * B4's ordering half: the fixed table was measured 2026-08-20 at zero
#     reversals over 144,956 pairs. That measurement belongs to THIS table, so
#     gate_b() re-verifies monotonicity by enumeration every run and fails if
#     the table stops being the measured one, rather than re-measuring pairs
#     it has no harness for.
#   * B5 is a serving property (band from the mapped number, confidence from
#     the map's own measurement); mlPredictor.js implements both and the node
#     suites pin them. Recorded in the verdict as a pointer, not re-proved
#     here.
#   * mae_vs_baseline_broken is written with both figures whenever the mapped
#     number spends MAE against the popular-times baseline, per the draft:
#     the strongest argument against the trade appears in the verdict itself.
# ---------------------------------------------------------------------------
GATE_B_W10_MIN = 5.0
GATE_B_W10_CI_LOWER_MIN = 2.5
GATE_B_MAE_MAX = 3.5
GATE_B_MAE_CI_UPPER_MAX = 4.0
# The 2026-08-20 measured table, fingerprinted: B4 fails if the arrays change,
# because the zero-reversal pair measurement belongs to these exact knots.
GATE_B_MEASURED_TABLE = (float(np.sum(QMAP_X)), float(np.sum(QMAP_Y)), len(QMAP_X))


def gate_b(y_true, pred_challenger, pred_incumbent, dates,
           inc_metrics, new_metrics):
    """Evaluate B1-B4. Returns (passed, detail dict)."""
    w10_delta = round(new_metrics['within_10'] - inc_metrics['within_10'], 2)
    mae_regress = round(new_metrics['mae'] - inc_metrics['mae'], 4)
    w20_delta = round(new_metrics['within_20'] - inc_metrics['within_20'], 2)
    ci = date_block_bootstrap(dates, y_true, pred_challenger, pred_incumbent) if dates is not None else None

    b1 = w10_delta >= GATE_B_W10_MIN and ci is not None and ci['w10_delta_ci'][0] > GATE_B_W10_CI_LOWER_MIN
    b2 = mae_regress <= GATE_B_MAE_MAX and ci is not None and ci['mae_delta_ci'][1] < GATE_B_MAE_CI_UPPER_MAX
    b3 = w20_delta >= 0
    mapped = apply_score_qmap(np.arange(0, 101, dtype=float))
    monotone = bool(np.all(np.diff(mapped) >= 0))
    table_ok = (float(np.sum(QMAP_X)), float(np.sum(QMAP_Y)), len(QMAP_X)) == GATE_B_MEASURED_TABLE
    b4 = monotone and table_ok
    passed = bool(b1 and b2 and b3 and b4)
    return passed, {
        'b1_w10_delta': w10_delta, 'b1_pass': bool(b1),
        'b2_mae_regress': mae_regress, 'b2_pass': bool(b2),
        'b3_w20_delta': w20_delta, 'b3_pass': bool(b3),
        'b4_monotone': monotone, 'b4_table_is_measured': bool(table_ok), 'b4_pass': bool(b4),
        'b5_note': 'serving property: band from mapped number, confidence from QMAP_MEASURED (mlPredictor.js, pinned by node suites)',
        'bootstrap': ci,
    }


def main():
    logger.info('Loading training features...')
    with open(SCRIPT_DIR / 'features_train.pkl', 'rb') as f:
        train_data = pickle.load(f)
    train_baseline = train_data['baseline']
    train_y_actual = train_data['y_actual']
    feature_cols = train_data['feature_cols']

    logger.info('Loading holdout features + trained model...')
    with open(SCRIPT_DIR / 'features_holdout.pkl', 'rb') as f:
        hold_data = pickle.load(f)
    X_hold = hold_data['X']
    # The gate reads is_realtime out of X BY POSITION. If the two pickles were
    # written by different runs, that position means something else and the gate
    # slice is silently the wrong rows.
    if list(hold_data['feature_cols']) != list(feature_cols):
        raise SystemExit(
            'features_train.pkl and features_holdout.pkl carry different feature '
            f'columns ({len(feature_cols)} vs {len(hold_data["feature_cols"])}). They '
            'are from different prepare_features.py runs. Re-run prepare_features.py.'
        )
    hold_baseline = np.asarray(hold_data['baseline'], dtype=float)
    hold_y_actual = np.asarray(hold_data['y_actual'], dtype=float)
    hold_cities = hold_data['cities']
    hold_is_realtime = realtime_flags(X_hold, feature_cols, len(hold_y_actual))

    with open(SCRIPT_DIR / 'best_model.pkl', 'rb') as f:
        model_data = pickle.load(f)
    model = model_data['model']

    # ============= TRAINING SET BASELINE COMPARISON =============
    # Model CV metrics already in metadata (computed honestly via LOCO in train_model.py)
    with open(MODELS_DIR / 'model_metadata.json') as f:
        meta = json.load(f)
    model_train_metrics = meta['training_metrics']

    train_baseline_pred = np.clip(train_baseline, 0, 100)
    baseline_train_metrics = metrics(train_y_actual, train_baseline_pred)

    logger.info('\n========== TRAINING SET (LOCO CV) ==========')
    logger.info(f'Model     — RMSE: {model_train_metrics["rmse"]}  MAE: {model_train_metrics["mae"]}  R²: {model_train_metrics["r2"]}  W10: {model_train_metrics["within_10"]}%')
    logger.info(f'Baseline  — RMSE: {baseline_train_metrics["rmse"]}  MAE: {baseline_train_metrics["mae"]}  R²: {baseline_train_metrics["r2"]}  W10: {baseline_train_metrics["within_10"]}%')

    train_mae_delta = baseline_train_metrics['mae'] - model_train_metrics['mae']
    train_r2_delta = model_train_metrics['r2'] - baseline_train_metrics['r2']
    logger.info(f'Δ         — MAE improvement: {train_mae_delta:+.4f}  R² improvement: {train_r2_delta:+.4f}')

    # ============= HOLDOUT SET (one forward pass) =============
    logger.info('\nPredicting on holdout (one forward pass)...')
    hold_pred_absolute = reconstruct(model.predict(X_hold), hold_baseline)
    hold_baseline_pred = np.clip(hold_baseline, 0, 100)

    model_hold_metrics = metrics(hold_y_actual, hold_pred_absolute)
    baseline_hold_metrics = metrics(hold_y_actual, hold_baseline_pred)

    logger.info('\n========== HOLDOUT SET (miami + tokyo + barcelona, never seen during training) ==========')
    logger.info(f'Model     — RMSE: {model_hold_metrics["rmse"]}  MAE: {model_hold_metrics["mae"]}  R²: {model_hold_metrics["r2"]}  W10: {model_hold_metrics["within_10"]}%')
    logger.info(f'Baseline  — RMSE: {baseline_hold_metrics["rmse"]}  MAE: {baseline_hold_metrics["mae"]}  R²: {baseline_hold_metrics["r2"]}  W10: {baseline_hold_metrics["within_10"]}%')

    hold_mae_delta = baseline_hold_metrics['mae'] - model_hold_metrics['mae']
    hold_r2_delta = model_hold_metrics['r2'] - baseline_hold_metrics['r2']
    logger.info(f'Δ         — MAE improvement: {hold_mae_delta:+.4f}  R² improvement: {hold_r2_delta:+.4f}')

    # ============= THE GATE SLICE: realtime AND servable =============
    # Audit finding 6. `served` is the SAME predicate prepare_features filters
    # training with — imported, not re-implemented.
    served = serving_population_mask(hold_baseline)
    rt_all = hold_is_realtime == 1
    rt_mask = rt_all & served
    rt_count = int(rt_mask.sum())
    excluded_no_baseline = int((rt_all & ~served).sum())
    weekly_count = int((~rt_all & served).sum())
    logger.info(
        '\n========== HOLDOUT BREAKDOWN ==========\n'
        f'  gate slice (realtime AND baseline>0): {rt_count:,}\n'
        f'  EXCLUDED realtime rows with baseline==0: {excluded_no_baseline:,} '
        f'(production routes these to the rule engine; the model reconstructs '
        f'0 + clamp(delta) <= 50 against actuals up to 100)\n'
        f'  weekly rows with baseline>0: {weekly_count:,}'
    )

    # Kept as a labelled diagnostic so the change in the gate basis is visible.
    rt_unfiltered = None
    if int(rt_all.sum()) >= 100:
        u_model = metrics(hold_y_actual[rt_all], hold_pred_absolute[rt_all])
        u_base = metrics(hold_y_actual[rt_all], hold_baseline_pred[rt_all])
        rt_unfiltered = {
            'rows': int(rt_all.sum()),
            'model_mae': u_model['mae'], 'baseline_mae': u_base['mae'],
            'model_within_10': u_model['within_10'],
            'mae_improvement': round(u_base['mae'] - u_model['mae'], 4),
            'r2_improvement': round(u_model['r2'] - u_base['r2'], 4),
            'note': 'DIAGNOSTIC ONLY — includes rows production never scores with this model',
        }
        logger.info(f'REALTIME unfiltered (diagnostic, {rt_unfiltered["rows"]:,} rows): '
                    f'model MAE {u_model["mae"]}  baseline MAE {u_base["mae"]}  '
                    f'W10 {u_model["within_10"]}%')

    if rt_count >= 100:
        rt_model_metrics = metrics(hold_y_actual[rt_mask], hold_pred_absolute[rt_mask])
        rt_baseline_metrics = metrics(hold_y_actual[rt_mask], hold_baseline_pred[rt_mask])
        rt_mae_delta = rt_baseline_metrics['mae'] - rt_model_metrics['mae']
        rt_r2_delta = rt_model_metrics['r2'] - rt_baseline_metrics['r2']
        logger.info('GATE SLICE (realtime, baseline>0):')
        logger.info(f'  Model     — MAE: {rt_model_metrics["mae"]}  R²: {rt_model_metrics["r2"]}  W10: {rt_model_metrics["within_10"]}%')
        logger.info(f'  Baseline  — MAE: {rt_baseline_metrics["mae"]}  R²: {rt_baseline_metrics["r2"]}  W10: {rt_baseline_metrics["within_10"]}%')
        logger.info(f'  Δ         — MAE improvement: {rt_mae_delta:+.4f}  R² improvement: {rt_r2_delta:+.4f}')
    else:
        logger.info(f'Gate slice has only {rt_count} rows — too few to be meaningful')
        rt_model_metrics = None
        rt_baseline_metrics = None
        rt_mae_delta = None
        rt_r2_delta = None

    # LIVE-OBSERVED-only diagnostic (round 13). The gate slice mixes label
    # provenances: 'live' rows are real observed foot traffic, but 'forecast'
    # rows carry BestTime's OWN forecast as the label — beating the popular_times
    # baseline there measures agreement with a vendor's model, not with reality.
    # Reported and persisted but NOT the gate basis: rows collected before
    # label_source existed are 'unknown' and cannot be separated retroactively,
    # so gating on live-only would judge new models on a much thinner slice than
    # the incumbent was judged on.
    live_slice = None
    hold_prov = hold_data.get('label_provenance')
    if hold_prov is not None and rt_count >= 100:
        hold_prov = np.asarray(hold_prov)
        live_mask = rt_mask & (hold_prov == 'live')
        live_count = int(live_mask.sum())
        if live_count >= 100:
            lv_model = metrics(hold_y_actual[live_mask], hold_pred_absolute[live_mask])
            lv_base = metrics(hold_y_actual[live_mask], hold_baseline_pred[live_mask])
            live_slice = {
                'rows': live_count,
                'model_mae': lv_model['mae'], 'baseline_mae': lv_base['mae'],
                'mae_improvement': round(lv_base['mae'] - lv_model['mae'], 4),
                'r2_improvement': round(lv_model['r2'] - lv_base['r2'], 4),
            }
            logger.info(f'LIVE-OBSERVED-only (diagnostic, {live_count:,} rows):')
            logger.info(f'  Model MAE: {lv_model["mae"]}  Baseline MAE: {lv_base["mae"]}  '
                        f'Δ MAE: {live_slice["mae_improvement"]:+.4f}  Δ R²: {live_slice["r2_improvement"]:+.4f}')
        else:
            logger.info(f'LIVE-OBSERVED-only: only {live_count} rows — skipping diagnostic')
    if weekly_count >= 100:
        wk = ~rt_all & served
        wk_model_metrics = metrics(hold_y_actual[wk], hold_pred_absolute[wk])
        wk_baseline_metrics = metrics(hold_y_actual[wk], hold_baseline_pred[wk])
        logger.info(f'WEEKLY-only (mostly tautological if baseline = avg of weekly):')
        logger.info(f'  Model     — MAE: {wk_model_metrics["mae"]}  R²: {wk_model_metrics["r2"]}')
        logger.info(f'  Baseline  — MAE: {wk_baseline_metrics["mae"]}  R²: {wk_baseline_metrics["r2"]}')

    # Per-holdout-city, on the gate slice — audit finding 16 wants this visible.
    logger.info('\nPer-holdout-city breakdown (gate slice):')
    per_city = {}
    for city in np.unique(hold_cities):
        mask = (hold_cities == city) & rt_mask
        if int(mask.sum()) < 50:
            logger.info(f'  {city:10s} — only {int(mask.sum())} gate rows, skipping')
            continue
        cm = metrics(hold_y_actual[mask], hold_pred_absolute[mask])
        bm = metrics(hold_y_actual[mask], hold_baseline_pred[mask])
        per_city[str(city)] = {'rows': int(mask.sum()), 'model_mae': cm['mae'],
                               'baseline_mae': bm['mae'], 'model_within_10': cm['within_10']}
        logger.info(f'  {city:10s} — Model MAE: {cm["mae"]:6.2f} (baseline {bm["mae"]:6.2f}, '
                    f'Δ={bm["mae"]-cm["mae"]:+5.2f})  W10: {cm["within_10"]}%')

    # ============= INCUMBENT (audit finding 7) =============
    incumbent = None
    incumbent_pass = None
    gate_b_result = None
    gate_b_pass = False
    if rt_count >= 100:
        incumbent, incumbent_pass = compare_incumbent(
            rt_mask, hold_y_actual, hold_pred_absolute, feature_cols, X_hold, hold_baseline)
        # GATE-B (armed 2026-08-28): evaluated whenever the mapped
        # reconstruction is in force and the head-to-head produced aligned
        # rows. Dates come from the holdout pickle; an older pickle without
        # observed_date yields no bootstrap, B1/B2's CI arms cannot hold, and
        # admission falls back to the legacy path with that fact logged.
        if QMAP_ENABLED and incumbent and incumbent.get('_gate_rows'):
            rows = incumbent.pop('_gate_rows')
            inc_m, new_m = incumbent.pop('_metrics_pair')
            hold_dates_all = hold_data.get('observed_date')
            gate_dates = None
            if hold_dates_all is not None:
                # cmp_mask is a FULL-length holdout mask (compare_incumbent
                # indexes hold_y_actual with it directly), so it applies to
                # the full-length dates array as-is. Chaining [rt_mask] first
                # shortened the array and made this an IndexError on exactly
                # the well-formed runs the gate exists to admit.
                gate_dates = np.asarray(hold_dates_all)[rows['cmp_mask']] \
                    if len(np.asarray(hold_dates_all)) == len(hold_y_actual) else None
            if gate_dates is None:
                logger.warning('GATE-B: features_holdout.pkl carries no observed_date '
                               '(re-run prepare_features.py); the CI arms cannot be '
                               'evaluated, so only the legacy path can admit this run.')
            gate_b_pass, gate_b_result = gate_b(
                rows['y'], rows['challenger'], rows['incumbent'], gate_dates, inc_m, new_m)
            logger.info('\n========== GATE-B (armed 2026-08-28) ==========')
            logger.info('  B1 within-10 vs incumbent: %+.2fpp (need >= +%.1f, CI low > +%.1f) -> %s',
                        gate_b_result['b1_w10_delta'], GATE_B_W10_MIN, GATE_B_W10_CI_LOWER_MIN,
                        'PASS' if gate_b_result['b1_pass'] else 'FAIL')
            logger.info('  B2 MAE regress vs incumbent: %+.3f (need <= +%.1f, CI high < +%.1f) -> %s',
                        gate_b_result['b2_mae_regress'], GATE_B_MAE_MAX, GATE_B_MAE_CI_UPPER_MAX,
                        'PASS' if gate_b_result['b2_pass'] else 'FAIL')
            logger.info('  B3 within-20 delta: %+.2fpp (need >= 0) -> %s',
                        gate_b_result['b3_w20_delta'], 'PASS' if gate_b_result['b3_pass'] else 'FAIL')
            logger.info('  B4 monotone + measured table -> %s',
                        'PASS' if gate_b_result['b4_pass'] else 'FAIL')
        elif incumbent:
            incumbent.pop('_gate_rows', None)
            incumbent.pop('_metrics_pair', None)

    # ============= SHIP VERDICT =============
    logger.info('\n========== SHIP GATE ==========')
    logger.info('Criteria (ALL must hold):')
    logger.info('  1. vs popular_times on the gate slice: MAE down ≥%.0f OR R² up ≥%.2f',
                GATE_MAE_IMPROVEMENT, GATE_R2_IMPROVEMENT)
    logger.info('  2. the MAE arm must not REGRESS (Δ MAE ≥ 0) even when the R² arm carries it')
    logger.info('  3. absolute floor: realtime within-10 ≥ the incumbent\'s measured within-10 '
                'on the same corrected holdout rows (fallback %.1f%% only if no incumbent)',
                STATIC_FLOOR_FALLBACK)
    logger.info('  4. no regression against the incumbent artifact')

    # ---- Floor derivation (2026-08-18). RETRAIN.md: re-derive the floor from
    # measurement, do not lower it to admit a model. "Worse off" means "worse
    # than the incumbent users get today", so the floor is the incumbent's
    # within-10 measured THIS RUN on the corrected holdout (head-to-head slice,
    # rows where both models have a baseline), and the challenger's within-10 is
    # taken on those identical rows so the comparison is apples to apples.
    if incumbent and incumbent.get('status') == 'compared':
        floor_value = incumbent['incumbent_realtime_within_10']
        floor_basis = 'incumbent_measured_within_10_same_rows'
        floor_subject_within10 = incumbent['new_realtime_within_10']
        floor_derivation = (
            f"floor = incumbent {incumbent.get('incumbent_version') or '(unversioned)'} "
            f"within-10 = {floor_value}%, measured this run on the same "
            f"{incumbent['comparable_rows']} corrected-axis holdout rows "
            f"({incumbent['basis']}); challenger within-10 on those rows = "
            f"{floor_subject_within10}%. Replaces the stale pre-clock-fix "
            f"constant {STATIC_FLOOR_FALLBACK}% per RETRAIN.md/MODEL-METRICS.md."
        )
    else:
        floor_value = STATIC_FLOOR_FALLBACK
        floor_basis = 'static_fallback_pre_clock_fix'
        floor_subject_within10 = rt_model_metrics['within_10'] if rt_model_metrics else None
        floor_derivation = (
            f'no measured incumbent available — stale pre-clock-fix constant '
            f'{STATIC_FLOOR_FALLBACK}% used as the floor. Not acceptable for a release.'
        )

    train_pass = (train_mae_delta >= GATE_MAE_IMPROVEMENT) or (train_r2_delta >= GATE_R2_IMPROVEMENT)
    hold_pass = (hold_mae_delta >= GATE_MAE_IMPROVEMENT) or (hold_r2_delta >= GATE_R2_IMPROVEMENT)

    rt_pass = floor_pass = None
    if rt_mae_delta is not None:
        relative_pass = (rt_mae_delta >= GATE_MAE_IMPROVEMENT) or (rt_r2_delta >= GATE_R2_IMPROVEMENT)
        no_mae_regression = rt_mae_delta >= 0
        rt_pass = bool(relative_pass and no_mae_regression)
        floor_pass = bool(floor_subject_within10 is not None
                          and floor_subject_within10 >= floor_value)
        logger.info(f'  1+2 relative:  MAE Δ={rt_mae_delta:+.2f}  R² Δ={rt_r2_delta:+.3f}  '
                    f'→ {"PASS" if rt_pass else "FAIL"}')
        logger.info(f'  3   floor:     within-10 ={floor_subject_within10}% vs floor '
                    f'{floor_value}% ({floor_basis})  → {"PASS" if floor_pass else "FAIL"}')
        logger.info(f'  4   incumbent: → {"PASS" if incumbent_pass else "FAIL"}')

    logger.info(f'Diagnostics — training (LOCO CV) {"PASS" if train_pass else "FAIL"}, '
                f'holdout overall {"PASS" if hold_pass else "FAIL"} '
                f'(both dominated by rows where baseline == label)')

    admission_path = None
    if rt_pass is not None:
        # EITHER-PATH ADMISSION (GATE-B armed 2026-08-28, see the block above
        # gate_b()): the legacy arms admit a routine retrain exactly as
        # before; B1-B3 admit a deliberate dispersion-spending candidate. The
        # floor (arm 3) binds on both paths, and an honest incumbent
        # comparison is required on both, with the legacy path additionally
        # requiring arm 4's no-MAE-regression exactly as it always has.
        legacy_admission = bool(rt_pass and incumbent_pass)
        if legacy_admission:
            admission_path = 'legacy'
        elif gate_b_pass and incumbent is not None and incumbent.get('status') == 'compared':
            admission_path = 'gate_b'
        overall_pass = bool(floor_pass and admission_path is not None)
        gate_basis = 'holdout_realtime_served'
        verdict = 'ship' if overall_pass else 'do_not_ship'
        if overall_pass and admission_path == 'legacy':
            logger.info('VERDICT: ✅ SHIP (legacy path) — beats the popular_times baseline on '
                        'the served realtime rows, clears the absolute floor, and does not '
                        'regress against the incumbent.')
        elif overall_pass:
            logger.info('VERDICT: ✅ SHIP (GATE-B path) — spends bounded MAE for a within-10 '
                        'gain that clears B1-B4, and clears the absolute floor.')
        else:
            reasons = []
            if not rt_pass:
                reasons.append('does not beat the popular_times baseline on the gate slice')
            if not floor_pass:
                reasons.append(f'realtime within-10 below the {floor_value}% floor ({floor_basis})')
            if not incumbent_pass:
                reasons.append('no honest incumbent comparison, or a regression against it '
                               'that GATE-B did not admit either')
            if QMAP_ENABLED and gate_b_result is not None and not gate_b_pass:
                reasons.append('GATE-B arms not met')
            logger.info('VERDICT: ❌ DO NOT SHIP — %s.', '; '.join(reasons))
    else:
        overall_pass = False
        gate_basis = 'insufficient_gate_rows'
        verdict = 'do_not_ship'
        logger.info('VERDICT: ❌ DO NOT SHIP — fewer than 100 servable realtime holdout rows, '
                    'so nothing honest can be measured. The aggregate holdout number is not a '
                    'substitute: most of those rows are weekly snapshots where the label equals '
                    'the baseline by construction.')

    meta['ship_gate'] = {
        # Decision — realtime holdout rows that production would actually serve.
        'overall_pass': overall_pass,
        'gate_basis': gate_basis,
        'verdict': verdict,
        'realtime_rows': rt_count,
        'excluded_no_baseline_rows': excluded_no_baseline,
        'realtime_mae_improvement': round(rt_mae_delta, 4) if rt_mae_delta is not None else None,
        'realtime_r2_improvement': round(rt_r2_delta, 4) if rt_r2_delta is not None else None,
        'realtime_within_10': rt_model_metrics['within_10'] if rt_model_metrics else None,
        'realtime_within_10_floor': floor_value,
        'floor_basis': floor_basis,
        'floor_subject_within_10': floor_subject_within10,
        'floor_derivation': floor_derivation,
        # Which reconstruction produced every number above. False is the shipped
        # state; a run with it True scored a DIFFERENT published number than the
        # gate's thresholds were calibrated against, and the two-metric
        # alternative in RETRAIN.md is the only gate that may read it.
        'score_qmap_enabled': bool(QMAP_ENABLED),
        'score_qmap_fitted_on': QMAP_FITTED_ON if QMAP_ENABLED else None,
        # GATE-B record (armed 2026-08-28). The draft's own requirement: when
        # the mapped number spends MAE against the popular-times baseline, the
        # verdict says so with both figures, in the artifact, not in a doc.
        'admission_path': admission_path,
        'gate_b': gate_b_result,
        'mae_vs_baseline_broken': bool(rt_mae_delta is not None and rt_mae_delta < 0),
        'mae_vs_baseline_figures': ({
            'model_mae': rt_model_metrics['mae'],
            'popular_times_mae': rt_baseline_metrics['mae'],
        } if rt_model_metrics else None),
        'realtime_pass': rt_pass,
        'floor_pass': floor_pass,
        'incumbent_pass': incumbent_pass,
        'incumbent': incumbent,
        # Diagnostic: the pre-fix slice, and the live-observed-only slice.
        'realtime_unfiltered_diagnostic': rt_unfiltered,
        'live_slice': live_slice,
        'per_city': per_city,
        # Diagnostics only — dominated by weekly rows where baseline == label.
        'training_mae_improvement': round(train_mae_delta, 4),
        'training_r2_improvement': round(train_r2_delta, 4),
        'holdout_mae_improvement': round(hold_mae_delta, 4),
        'holdout_r2_improvement': round(hold_r2_delta, 4),
        'training_pass_diagnostic': bool(train_pass),
        'holdout_pass_diagnostic': bool(hold_pass),
        'criteria': (
            f'On the holdout rows production actually serves (is_realtime == 1 AND '
            f'baseline_busyness > 0, the same serving_population_mask prepare_features '
            f'filters training with): MAE down ≥{GATE_MAE_IMPROVEMENT} OR R² up '
            f'≥{GATE_R2_IMPROVEMENT} vs the popular_times baseline, AND no MAE regression '
            f'vs that baseline, AND within-10 ≥ the incumbent measured on the same rows '
            f'this run ({floor_value}%, {floor_basis}), AND no MAE '
            f'regression vs the incumbent artifact.'
        ),
    }
    meta['evaluation'] = {
        'training_loco_cv': model_train_metrics,
        'training_baseline': baseline_train_metrics,
        'holdout': model_hold_metrics,
        'holdout_baseline': baseline_hold_metrics,
        'holdout_cities': sorted(str(c) for c in np.unique(hold_cities)),
    }
    with open(MODELS_DIR / 'model_metadata.json', 'w') as f:
        json.dump(meta, f, indent=2)
    logger.info(f'\nSaved verdict to {MODELS_DIR / "model_metadata.json"}')


if __name__ == '__main__':
    main()
