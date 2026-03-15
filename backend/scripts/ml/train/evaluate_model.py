"""
Comprehensive evaluation of the best crowd prediction model.
Runs on validation set and geographic holdout set.
Generates plots and SHAP analysis.
"""

import json
import logging
import pickle
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import seaborn as sns

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

SCRIPT_DIR = Path(__file__).parent
MODELS_DIR = SCRIPT_DIR.parent / 'models'
PLOTS_DIR = SCRIPT_DIR / 'plots'


def compute_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> dict:
    """Compute regression metrics."""
    y_pred = np.clip(y_pred, 0, 100)
    errors = np.abs(y_true - y_pred)
    return {
        'rmse': round(float(np.sqrt(np.mean((y_true - y_pred) ** 2))), 4),
        'mae': round(float(np.mean(errors)), 4),
        'r2': round(float(1 - np.sum((y_true - y_pred) ** 2) / np.sum((y_true - np.mean(y_true)) ** 2)), 4),
        'median_ae': round(float(np.median(errors)), 4),
        'within_5': round(float(np.mean(errors <= 5) * 100), 1),
        'within_10': round(float(np.mean(errors <= 10) * 100), 1),
        'within_15': round(float(np.mean(errors <= 15) * 100), 1),
    }


def plot_residuals(y_true, y_pred, title, filename):
    """Predicted vs actual scatter plot."""
    fig, ax = plt.subplots(1, 1, figsize=(8, 8))
    ax.scatter(y_true, y_pred, alpha=0.05, s=1, color='#1a2744')
    ax.plot([0, 100], [0, 100], 'r--', linewidth=1, label='Perfect')
    ax.set_xlabel('Actual Busyness (%)', fontsize=12)
    ax.set_ylabel('Predicted Busyness (%)', fontsize=12)
    ax.set_title(title, fontsize=14)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.legend()
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / filename, dpi=150)
    plt.close()
    logger.info(f'  Saved {filename}')


def plot_error_distribution(errors, title, filename):
    """Histogram of prediction errors."""
    fig, ax = plt.subplots(1, 1, figsize=(10, 6))
    ax.hist(errors, bins=50, color='#1a2744', edgecolor='white', alpha=0.8)
    ax.axvline(x=0, color='red', linestyle='--', linewidth=1)
    ax.set_xlabel('Prediction Error (Predicted - Actual)', fontsize=12)
    ax.set_ylabel('Count', fontsize=12)
    ax.set_title(title, fontsize=14)
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / filename, dpi=150)
    plt.close()
    logger.info(f'  Saved {filename}')


def plot_per_hour(y_true, y_pred, hours, title, filename):
    """Average error by hour of day."""
    df = pd.DataFrame({'actual': y_true, 'pred': y_pred, 'hour': hours})
    df['error'] = np.abs(df['pred'] - df['actual'])
    hourly = df.groupby('hour')['error'].mean()

    fig, ax = plt.subplots(1, 1, figsize=(12, 5))
    ax.bar(hourly.index, hourly.values, color='#1a2744', alpha=0.8)
    ax.set_xlabel('Hour of Day', fontsize=12)
    ax.set_ylabel('Mean Absolute Error', fontsize=12)
    ax.set_title(title, fontsize=14)
    ax.set_xticks(range(24))
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / filename, dpi=150)
    plt.close()
    logger.info(f'  Saved {filename}')


def plot_per_category(y_true, y_pred, categories, title, filename):
    """Average error by venue category."""
    df = pd.DataFrame({'actual': y_true, 'pred': y_pred, 'category': categories})
    df['error'] = np.abs(df['pred'] - df['actual'])
    cat_err = df.groupby('category')['error'].mean().sort_values()

    fig, ax = plt.subplots(1, 1, figsize=(10, max(6, len(cat_err) * 0.4)))
    ax.barh(cat_err.index, cat_err.values, color='#1a2744', alpha=0.8)
    ax.set_xlabel('Mean Absolute Error', fontsize=12)
    ax.set_title(title, fontsize=14)
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / filename, dpi=150)
    plt.close()
    logger.info(f'  Saved {filename}')


def plot_per_city(y_true, y_pred, cities, title, filename):
    """Average error by city."""
    df = pd.DataFrame({'actual': y_true, 'pred': y_pred, 'city': cities})
    df['error'] = np.abs(df['pred'] - df['actual'])
    city_err = df.groupby('city')['error'].mean().sort_values()

    fig, ax = plt.subplots(1, 1, figsize=(10, max(6, len(city_err) * 0.5)))
    ax.barh(city_err.index, city_err.values, color='#1a2744', alpha=0.8)
    ax.set_xlabel('Mean Absolute Error', fontsize=12)
    ax.set_title(title, fontsize=14)
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / filename, dpi=150)
    plt.close()
    logger.info(f'  Saved {filename}')


def plot_feature_importance(model, feature_cols, filename, top_n=30):
    """Feature importance bar chart."""
    if hasattr(model, 'feature_importances_'):
        importances = model.feature_importances_
    else:
        logger.warning('Model has no feature_importances_ attribute')
        return

    indices = np.argsort(importances)[-top_n:]
    top_features = [feature_cols[i] for i in indices]
    top_importances = importances[indices]

    fig, ax = plt.subplots(1, 1, figsize=(10, max(8, top_n * 0.35)))
    ax.barh(top_features, top_importances, color='#1a2744', alpha=0.8)
    ax.set_xlabel('Feature Importance', fontsize=12)
    ax.set_title(f'Top {top_n} Feature Importances', fontsize=14)
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / filename, dpi=150)
    plt.close()
    logger.info(f'  Saved {filename}')


def run_shap_analysis(model, X_sample, feature_cols):
    """SHAP analysis on a sample of data."""
    try:
        import shap
    except ImportError:
        logger.warning('SHAP not installed, skipping SHAP analysis')
        return

    logger.info('Running SHAP analysis (1000 samples)...')

    # Sample 1000 rows for SHAP
    n = min(1000, len(X_sample))
    idx = np.random.RandomState(42).choice(len(X_sample), n, replace=False)
    X_shap = X_sample[idx]

    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(X_shap)

    # Summary plot (beeswarm)
    fig, ax = plt.subplots(1, 1, figsize=(12, 10))
    shap.summary_plot(shap_values, X_shap, feature_names=feature_cols, show=False, max_display=20)
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / 'shap_summary.png', dpi=150, bbox_inches='tight')
    plt.close()
    logger.info('  Saved shap_summary.png')

    # Bar plot (mean absolute SHAP)
    fig, ax = plt.subplots(1, 1, figsize=(10, 8))
    shap.summary_plot(shap_values, X_shap, feature_names=feature_cols,
                      plot_type='bar', show=False, max_display=20)
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / 'shap_bar.png', dpi=150, bbox_inches='tight')
    plt.close()
    logger.info('  Saved shap_bar.png')

    # Dependence plots for top 5 features
    mean_abs_shap = np.abs(shap_values).mean(axis=0)
    top5_idx = np.argsort(mean_abs_shap)[-5:][::-1]

    for i, feat_idx in enumerate(top5_idx):
        fig, ax = plt.subplots(1, 1, figsize=(8, 5))
        shap.dependence_plot(feat_idx, shap_values, X_shap,
                             feature_names=feature_cols, show=False, ax=ax)
        plt.tight_layout()
        fname = f'shap_dep_{feature_cols[feat_idx]}.png'
        plt.savefig(PLOTS_DIR / fname, dpi=150, bbox_inches='tight')
        plt.close()
        logger.info(f'  Saved {fname}')


def main():
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)

    # Load model
    logger.info('Loading model...')
    with open(SCRIPT_DIR / 'best_model.pkl', 'rb') as f:
        model_data = pickle.load(f)
    model = model_data['model']
    model_name = model_data['name']
    feature_cols = model_data['feature_cols']
    logger.info(f'Model: {model_name}, Features: {len(feature_cols)}')

    # Load training features for city-based CV evaluation
    with open(SCRIPT_DIR / 'features_train.pkl', 'rb') as f:
        train_data = pickle.load(f)
    X_train_all, y_train_all = train_data['X'], train_data['y']
    train_cities = train_data.get('cities')

    # Load raw training data for category/hour info
    train_df = pd.read_csv(SCRIPT_DIR / 'training_data.csv')
    train_df = train_df.dropna(subset=['busyness_pct'])

    # =================== CITY-BASED CV EVALUATION ===================
    logger.info('\n=== Leave-One-City-Out CV Evaluation ===')
    from sklearn.base import clone
    from sklearn.model_selection import GroupKFold

    unique_cities = np.unique(train_cities)
    cv = GroupKFold(n_splits=len(unique_cities))

    val_pred_all = np.full(len(y_train_all), np.nan)
    for train_idx, val_idx in cv.split(X_train_all, y_train_all, groups=train_cities):
        m = clone(model)
        m.fit(X_train_all[train_idx], y_train_all[train_idx])
        val_pred_all[val_idx] = m.predict(X_train_all[val_idx])
    val_pred_all = np.clip(val_pred_all, 0, 100)

    val_metrics = compute_metrics(y_train_all, val_pred_all)

    logger.info(f'RMSE: {val_metrics["rmse"]}')
    logger.info(f'MAE: {val_metrics["mae"]}')
    logger.info(f'R²: {val_metrics["r2"]}')
    logger.info(f'Median AE: {val_metrics["median_ae"]}')
    logger.info(f'Within 5 pts: {val_metrics["within_5"]}%')
    logger.info(f'Within 10 pts: {val_metrics["within_10"]}%')
    logger.info(f'Within 15 pts: {val_metrics["within_15"]}%')

    # Per-city CV breakdown
    logger.info('\nPer-city CV results:')
    for city in unique_cities:
        mask = train_cities == city
        city_metrics = compute_metrics(y_train_all[mask], val_pred_all[mask])
        logger.info(f'  {city}: RMSE={city_metrics["rmse"]}, MAE={city_metrics["mae"]}, R²={city_metrics["r2"]}')

    logger.info('\nGenerating CV plots...')
    plot_residuals(y_train_all, val_pred_all, 'City CV: Predicted vs Actual', 'val_residuals.png')
    plot_error_distribution(val_pred_all - y_train_all, 'City CV: Error Distribution', 'val_error_dist.png')

    if 'hour' in train_df.columns:
        plot_per_hour(y_train_all, val_pred_all, train_df['hour'].values[:len(y_train_all)],
                      'City CV: MAE by Hour', 'val_per_hour.png')

    if 'venue_category' in train_df.columns:
        plot_per_category(y_train_all, val_pred_all, train_df['venue_category'].values[:len(y_train_all)],
                          'City CV: MAE by Category', 'val_per_category.png')

    if train_cities is not None:
        plot_per_city(y_train_all, val_pred_all, train_cities,
                      'City CV: MAE by City', 'val_per_city.png')

    # =================== HOLDOUT SET ===================
    holdout_path = SCRIPT_DIR / 'features_holdout.pkl'
    holdout_metrics = None
    if holdout_path.exists():
        logger.info('\n=== Holdout Set Evaluation (Geographic Generalization) ===')
        with open(holdout_path, 'rb') as f:
            holdout_data = pickle.load(f)
        X_hold, y_hold = holdout_data['X'], holdout_data['y']
        hold_cities = holdout_data.get('cities', None)

        hold_pred = np.clip(model.predict(X_hold), 0, 100)
        holdout_metrics = compute_metrics(y_hold, hold_pred)

        logger.info(f'RMSE: {holdout_metrics["rmse"]}')
        logger.info(f'MAE: {holdout_metrics["mae"]}')
        logger.info(f'R²: {holdout_metrics["r2"]}')
        logger.info(f'Median AE: {holdout_metrics["median_ae"]}')
        logger.info(f'Within 5 pts: {holdout_metrics["within_5"]}%')
        logger.info(f'Within 10 pts: {holdout_metrics["within_10"]}%')
        logger.info(f'Within 15 pts: {holdout_metrics["within_15"]}%')

        # Generalization check
        rmse_ratio = holdout_metrics['rmse'] / val_metrics['rmse'] if val_metrics['rmse'] > 0 else 0
        logger.info(f'\nHoldout/Validation RMSE ratio: {rmse_ratio:.2f}')
        if rmse_ratio < 1.2:
            logger.info('Model generalizes well to unseen cities!')
        else:
            logger.warning(f'Holdout RMSE is {(rmse_ratio-1)*100:.0f}% higher than validation — potential overfitting')

        logger.info('\nGenerating holdout plots...')
        plot_residuals(y_hold, hold_pred, 'Holdout: Predicted vs Actual', 'holdout_residuals.png')
        plot_error_distribution(hold_pred - y_hold, 'Holdout: Error Distribution', 'holdout_error_dist.png')

        if hold_cities is not None:
            plot_per_city(y_hold, hold_pred, hold_cities,
                          'Holdout: MAE by City', 'holdout_per_city.png')
    else:
        logger.info('No holdout data found, skipping geographic evaluation')

    # =================== FEATURE IMPORTANCE ===================
    logger.info('\n=== Feature Importance ===')
    plot_feature_importance(model, feature_cols, 'feature_importance.png')

    # =================== SHAP ANALYSIS ===================
    logger.info('\n=== SHAP Analysis ===')
    run_shap_analysis(model, X_train_all, feature_cols)

    # =================== SAVE METRICS ===================
    meta_path = MODELS_DIR / 'model_metadata.json'
    with open(meta_path, 'r') as f:
        metadata = json.load(f)

    metadata['evaluation'] = {
        'validation': val_metrics,
        'holdout': holdout_metrics,
        'holdout_cities': ['miami', 'tokyo', 'barcelona'],
    }

    with open(meta_path, 'w') as f:
        json.dump(metadata, f, indent=2)

    logger.info('\n=== Summary ===')
    logger.info(f'Model: {model_name}')
    logger.info(f'City CV RMSE: {val_metrics["rmse"]}')
    logger.info(f'City CV R²: {val_metrics["r2"]}')
    logger.info(f'City CV within 10 pts: {val_metrics["within_10"]}%')
    if holdout_metrics:
        logger.info(f'Holdout RMSE: {holdout_metrics["rmse"]}')
        logger.info(f'Holdout R²: {holdout_metrics["r2"]}')
        logger.info(f'Holdout within 10 pts: {holdout_metrics["within_10"]}%')
    logger.info('Evaluation complete!')


if __name__ == '__main__':
    main()
