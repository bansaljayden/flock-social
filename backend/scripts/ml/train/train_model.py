"""
Train XGBoost model for crowd prediction.
Uses city-based (leave-one-city-out) cross-validation to prevent geographic overfitting.
"""

import json
import logging
import pickle
import time
from pathlib import Path

import numpy as np
from sklearn.base import clone
from sklearn.model_selection import GroupKFold, RandomizedSearchCV
from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
from xgboost import XGBRegressor

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

SCRIPT_DIR = Path(__file__).parent
MODELS_DIR = SCRIPT_DIR.parent / 'models'
RANDOM_STATE = 42


def load_data():
    """Load prepared feature matrices."""
    with open(SCRIPT_DIR / 'features_train.pkl', 'rb') as f:
        train_data = pickle.load(f)
    return train_data


def evaluate_city_cv(model, X, y, cv, groups, baseline=None, y_actual=None) -> dict:
    """Compute regression metrics using leave-one-city-out cross-validation.
    Retrains the model for each fold to get honest out-of-fold predictions.

    If baseline + y_actual are provided (delta-label training), reconstructs
    absolute predictions as baseline + clamp(delta, -30, +30) and reports
    metrics on absolute scale vs y_actual. Otherwise reports on y directly.
    """
    all_preds = np.full(len(y), np.nan)
    for train_idx, val_idx in cv.split(X, y, groups=groups):
        m = clone(model)
        m.fit(X[train_idx], y[train_idx])
        all_preds[val_idx] = m.predict(X[val_idx])

    if baseline is not None and y_actual is not None:
        # Reconstruct absolute prediction: baseline + clamped delta
        clamped_delta = np.clip(all_preds, -30, 30)
        absolute_preds = np.clip(baseline + clamped_delta, 0, 100)
        target = y_actual
    else:
        absolute_preds = np.clip(all_preds, 0, 100)
        target = y

    errors = np.abs(target - absolute_preds)
    return {
        'rmse': round(float(np.sqrt(mean_squared_error(target, absolute_preds))), 4),
        'mae': round(float(mean_absolute_error(target, absolute_preds)), 4),
        'r2': round(float(r2_score(target, absolute_preds)), 4),
        'median_ae': round(float(np.median(errors)), 4),
        'within_5': round(float(np.mean(errors <= 5) * 100), 1),
        'within_10': round(float(np.mean(errors <= 10) * 100), 1),
        'within_15': round(float(np.mean(errors <= 15) * 100), 1),
    }


def train_xgboost(X, y, cv, groups, baseline=None, y_actual=None) -> tuple:
    """Train XGBoost with randomized hyperparameter search + city-based CV."""
    logger.info('\n=== Training XGBoost ===')
    start = time.time()

    param_dist = {
        'n_estimators': [200, 500, 800, 1200, 1500],
        'max_depth': [4, 6, 8, 10, 12],
        'learning_rate': [0.01, 0.03, 0.05, 0.1],
        'min_child_weight': [1, 3, 5, 7],
        'subsample': [0.7, 0.8, 0.9],
        'colsample_bytree': [0.7, 0.8, 0.9],
        'reg_alpha': [0, 0.1, 0.5, 1.0],
        'reg_lambda': [1.0, 1.5, 2.0, 3.0],
    }

    base_model = XGBRegressor(
        random_state=RANDOM_STATE,
        tree_method='hist',
        n_jobs=-1,
        verbosity=0,
    )

    search = RandomizedSearchCV(
        base_model, param_dist,
        n_iter=8,
        cv=cv,
        scoring='neg_root_mean_squared_error',
        random_state=RANDOM_STATE,
        n_jobs=1,
        verbose=0,
    )
    search.fit(X, y, groups=groups)

    model = search.best_estimator_
    best_params = search.best_params_

    logger.info(f'Best params: {best_params}')
    logger.info('Computing leave-one-city-out metrics...')
    metrics = evaluate_city_cv(model, X, y, cv, groups, baseline=baseline, y_actual=y_actual)
    elapsed = time.time() - start

    logger.info(f'City CV RMSE: {metrics["rmse"]:.4f}, MAE: {metrics["mae"]:.4f}, R²: {metrics["r2"]:.4f}')
    logger.info(f'Within 10 pts: {metrics["within_10"]}%')
    logger.info(f'Training time: {elapsed:.1f}s')

    return model, metrics, best_params, elapsed


def main():
    logger.info('Loading prepared features...')
    data = load_data()
    X, y = data['X'], data['y']
    feature_cols = data['feature_cols']
    cities = data.get('cities')
    baseline = data.get('baseline')
    y_actual = data.get('y_actual')
    label_type = data.get('label_type', 'absolute')

    if cities is None:
        raise ValueError('City information not found in features. Re-run prepare_features.py.')

    logger.info(f'Data shape: {X.shape}, Label type: {label_type}, Label range: [{y.min():.1f}, {y.max():.1f}]')
    if label_type == 'delta':
        logger.info(f'Training on DELTA label (busyness - popular_times). Metrics reported on absolute scale via baseline reconstruction.')

    unique_cities = np.unique(cities)
    n_cities = len(unique_cities)
    logger.info(f'Cities ({n_cities}): {", ".join(unique_cities)}')
    for city in unique_cities:
        count = np.sum(cities == city)
        logger.info(f'  {city}: {count} rows ({count/len(cities)*100:.1f}%)')

    # Leave-one-city-out cross-validation
    cv = GroupKFold(n_splits=n_cities)
    logger.info(f'Using GroupKFold with {n_cities} splits (leave-one-city-out)')

    # Train XGBoost only
    model, metrics, params, elapsed = train_xgboost(X, y, cv, cities, baseline=baseline, y_actual=y_actual)

    logger.info(f'\n*** XGBoost Results ***')
    logger.info(f'    RMSE: {metrics["rmse"]:.4f}')
    logger.info(f'    MAE: {metrics["mae"]:.4f}')
    logger.info(f'    R²: {metrics["r2"]:.4f}')
    logger.info(f'    Within 10 pts: {metrics["within_10"]}%')

    # Save model (already trained on full dataset by RandomizedSearchCV refit)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    model_path = SCRIPT_DIR / 'best_model.pkl'
    with open(model_path, 'wb') as f:
        pickle.dump({
            'model': model,
            'name': 'xgboost',
            'feature_cols': feature_cols,
        }, f)
    logger.info(f'Saved model to {model_path}')

    # Update metadata
    meta_path = MODELS_DIR / 'model_metadata.json'
    with open(meta_path, 'r') as f:
        metadata = json.load(f)

    metadata['best_model'] = 'xgboost'
    metadata['best_params'] = {k: str(v) for k, v in params.items()}
    metadata['training_metrics'] = metrics
    metadata['cv_method'] = f'GroupKFold(n_splits={n_cities}) — leave-one-city-out'
    metadata['training_cities'] = unique_cities.tolist()

    with open(meta_path, 'w') as f:
        json.dump(metadata, f, indent=2)

    logger.info('Updated model_metadata.json')
    logger.info('Training complete!')


if __name__ == '__main__':
    main()
