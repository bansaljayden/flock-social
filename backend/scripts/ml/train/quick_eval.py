"""
Fast eval: compute popular_times-only baseline + ship-gate verdict using
the already-trained model. Skips the redundant LOCO re-training that
evaluate_model.py does.

Training metrics: re-uses LOCO CV numbers from model_metadata.json (already
computed honestly in train_model.py).
Holdout: one forward pass with the full-trained model.
"""

import json
import logging
import pickle
from pathlib import Path

import numpy as np

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

SCRIPT_DIR = Path(__file__).parent
MODELS_DIR = SCRIPT_DIR.parent / 'models'


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
    }


def main():
    logger.info('Loading training features...')
    with open(SCRIPT_DIR / 'features_train.pkl', 'rb') as f:
        train_data = pickle.load(f)
    train_baseline = train_data['baseline']
    train_y_actual = train_data['y_actual']
    train_cities = train_data['cities']
    # is_realtime is feature index in the X matrix — find it
    feature_cols = train_data['feature_cols']
    is_realtime_col = feature_cols.index('is_realtime') if 'is_realtime' in feature_cols else None
    train_X = train_data['X']
    train_is_realtime = train_X[:, is_realtime_col].astype(int) if is_realtime_col is not None else np.zeros(len(train_y_actual), dtype=int)

    logger.info('Loading holdout features + trained model...')
    with open(SCRIPT_DIR / 'features_holdout.pkl', 'rb') as f:
        hold_data = pickle.load(f)
    X_hold = hold_data['X']
    hold_baseline = hold_data['baseline']
    hold_y_actual = hold_data['y_actual']
    hold_cities = hold_data['cities']
    hold_is_realtime = X_hold[:, is_realtime_col].astype(int) if is_realtime_col is not None else np.zeros(len(hold_y_actual), dtype=int)

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
    raw_pred = model.predict(X_hold)
    clamped_delta = np.clip(raw_pred, -30, 30)
    hold_pred_absolute = np.clip(hold_baseline + clamped_delta, 0, 100)
    hold_baseline_pred = np.clip(hold_baseline, 0, 100)

    model_hold_metrics = metrics(hold_y_actual, hold_pred_absolute)
    baseline_hold_metrics = metrics(hold_y_actual, hold_baseline_pred)

    logger.info('\n========== HOLDOUT SET (miami + tokyo + barcelona, never seen during training) ==========')
    logger.info(f'Model     — RMSE: {model_hold_metrics["rmse"]}  MAE: {model_hold_metrics["mae"]}  R²: {model_hold_metrics["r2"]}  W10: {model_hold_metrics["within_10"]}%')
    logger.info(f'Baseline  — RMSE: {baseline_hold_metrics["rmse"]}  MAE: {baseline_hold_metrics["mae"]}  R²: {baseline_hold_metrics["r2"]}  W10: {baseline_hold_metrics["within_10"]}%')

    hold_mae_delta = baseline_hold_metrics['mae'] - model_hold_metrics['mae']
    hold_r2_delta = model_hold_metrics['r2'] - baseline_hold_metrics['r2']
    logger.info(f'Δ         — MAE improvement: {hold_mae_delta:+.4f}  R² improvement: {hold_r2_delta:+.4f}')

    # ============= REALTIME-ONLY HOLDOUT (THE HONEST TEST) =============
    # Realtime rows are where actual ≠ baseline. If model can't beat baseline here,
    # it has no signal beyond the baseline itself.
    rt_mask = hold_is_realtime == 1
    rt_count = int(rt_mask.sum())
    weekly_count = int((~rt_mask).sum())
    logger.info(f'\n========== HOLDOUT BREAKDOWN ({rt_count:,} realtime / {weekly_count:,} weekly) ==========')
    if rt_count >= 100:
        rt_model_metrics = metrics(hold_y_actual[rt_mask], hold_pred_absolute[rt_mask])
        rt_baseline_metrics = metrics(hold_y_actual[rt_mask], hold_baseline_pred[rt_mask])
        rt_mae_delta = rt_baseline_metrics['mae'] - rt_model_metrics['mae']
        rt_r2_delta = rt_model_metrics['r2'] - rt_baseline_metrics['r2']
        logger.info(f'REALTIME-only:')
        logger.info(f'  Model     — MAE: {rt_model_metrics["mae"]}  R²: {rt_model_metrics["r2"]}  W10: {rt_model_metrics["within_10"]}%')
        logger.info(f'  Baseline  — MAE: {rt_baseline_metrics["mae"]}  R²: {rt_baseline_metrics["r2"]}  W10: {rt_baseline_metrics["within_10"]}%')
        logger.info(f'  Δ         — MAE improvement: {rt_mae_delta:+.4f}  R² improvement: {rt_r2_delta:+.4f}')
    else:
        logger.info(f'Skipping realtime-only (only {rt_count} rows — too few to be meaningful)')
        rt_model_metrics = None
        rt_baseline_metrics = None
        rt_mae_delta = None
        rt_r2_delta = None
    if weekly_count >= 100:
        wk_model_metrics = metrics(hold_y_actual[~rt_mask], hold_pred_absolute[~rt_mask])
        wk_baseline_metrics = metrics(hold_y_actual[~rt_mask], hold_baseline_pred[~rt_mask])
        logger.info(f'WEEKLY-only (mostly tautological if baseline = avg of weekly):')
        logger.info(f'  Model     — MAE: {wk_model_metrics["mae"]}  R²: {wk_model_metrics["r2"]}')
        logger.info(f'  Baseline  — MAE: {wk_baseline_metrics["mae"]}  R²: {wk_baseline_metrics["r2"]}')

    # Per-holdout-city
    logger.info('\nPer-holdout-city breakdown:')
    for city in np.unique(hold_cities):
        mask = hold_cities == city
        cm = metrics(hold_y_actual[mask], hold_pred_absolute[mask])
        bm = metrics(hold_y_actual[mask], hold_baseline_pred[mask])
        logger.info(f'  {city:10s} — Model MAE: {cm["mae"]:6.2f} (baseline {bm["mae"]:6.2f}, Δ={bm["mae"]-cm["mae"]:+5.2f})  R²: {cm["r2"]:.3f} (baseline {bm["r2"]:.3f})')

    # ============= SHIP VERDICT (REALTIME-WEIGHTED) =============
    # The honest test is realtime-only on holdout: where actual ≠ baseline, can the model help?
    # Overall holdout numbers will look great because most rows are weekly-where-actual=baseline.
    logger.info('\n========== SHIP GATE: model must beat baseline by ≥5 MAE OR ≥0.10 R² ==========')
    train_pass = (train_mae_delta >= 5.0) or (train_r2_delta >= 0.10)
    hold_pass = (hold_mae_delta >= 5.0) or (hold_r2_delta >= 0.10)
    rt_pass = None
    if rt_mae_delta is not None:
        rt_pass = (rt_mae_delta >= 5.0) or (rt_r2_delta >= 0.10)

    logger.info(f'Training (LOCO CV):       MAE Δ={train_mae_delta:+.2f}  R² Δ={train_r2_delta:+.3f}  → {"PASS" if train_pass else "FAIL"}')
    logger.info(f'Holdout overall:          MAE Δ={hold_mae_delta:+.2f}  R² Δ={hold_r2_delta:+.3f}  → {"PASS" if hold_pass else "FAIL"}')
    if rt_pass is not None:
        logger.info(f'Holdout REALTIME-only ★:  MAE Δ={rt_mae_delta:+.2f}  R² Δ={rt_r2_delta:+.3f}  → {"PASS" if rt_pass else "FAIL"}    ← THE HONEST TEST')

    # Ship requires: at minimum the realtime-only test passes (if we have enough realtime rows)
    # Otherwise fall back to the weaker overall test.
    if rt_pass is not None:
        if rt_pass:
            logger.info('VERDICT: ✅ SHIP — model beats baseline on realtime rows (where actual ≠ baseline).')
        else:
            logger.info('VERDICT: ❌ DO NOT SHIP — model does not beat baseline on realtime rows. Overall numbers are misleading (mostly weekly-where-baseline-trivially-wins).')
    else:
        if hold_pass:
            logger.info('VERDICT: ⚠️ PROVISIONAL SHIP — too few realtime rows to test honestly; passes overall holdout. Collect more realtime data and re-eval.')
        else:
            logger.info('VERDICT: ❌ DO NOT SHIP — fails overall holdout and not enough realtime to verify.')

    # Save to metadata
    meta['ship_gate'] = {
        'training_mae_improvement': round(train_mae_delta, 4),
        'training_r2_improvement': round(train_r2_delta, 4),
        'holdout_mae_improvement': round(hold_mae_delta, 4),
        'holdout_r2_improvement': round(hold_r2_delta, 4),
        'training_pass': bool(train_pass),
        'holdout_pass': bool(hold_pass),
        'overall_pass': bool(train_pass and hold_pass),
        'criteria': 'MAE down ≥5 OR R² up ≥0.10 vs popular_times-only baseline',
    }
    meta['evaluation'] = {
        'training_loco_cv': model_train_metrics,
        'training_baseline': baseline_train_metrics,
        'holdout': model_hold_metrics,
        'holdout_baseline': baseline_hold_metrics,
        'holdout_cities': sorted(np.unique(hold_cities).tolist()),
    }
    with open(MODELS_DIR / 'model_metadata.json', 'w') as f:
        json.dump(meta, f, indent=2)
    logger.info(f'\nSaved verdict to {MODELS_DIR / "model_metadata.json"}')


if __name__ == '__main__':
    main()
