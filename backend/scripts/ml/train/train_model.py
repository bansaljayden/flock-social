"""
Train XGBoost, LightGBM, and Random Forest models for crowd prediction.
Selects the best model based on validation RMSE.
"""

import json
import logging
import pickle
import time
from pathlib import Path

import numpy as np
from sklearn.model_selection import train_test_split, RandomizedSearchCV
from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
from xgboost import XGBRegressor
from lightgbm import LGBMRegressor
from sklearn.ensemble import RandomForestRegressor

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


def evaluate(model, X, y, prefix: str = '') -> dict:
    """Compute regression metrics."""
    preds = model.predict(X)
    preds = np.clip(preds, 0, 100)
    rmse = np.sqrt(mean_squared_error(y, preds))
    mae = mean_absolute_error(y, preds)
    r2 = r2_score(y, preds)
    median_ae = np.median(np.abs(y - preds))
    return {
        f'{prefix}rmse': round(float(rmse), 4),
        f'{prefix}mae': round(float(mae), 4),
        f'{prefix}r2': round(float(r2), 4),
        f'{prefix}median_ae': round(float(median_ae), 4),
    }


def train_xgboost(X_train, y_train, X_val, y_val) -> tuple:
    """Train XGBoost with randomized hyperparameter search."""
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
        n_iter=50,
        cv=3,
        scoring='neg_root_mean_squared_error',
        random_state=RANDOM_STATE,
        n_jobs=-1,
        verbose=0,
    )
    search.fit(X_train, y_train)

    model = search.best_estimator_
    elapsed = time.time() - start

    metrics = evaluate(model, X_val, y_val)
    logger.info(f'Best params: {search.best_params_}')
    logger.info(f'Val RMSE: {metrics["rmse"]:.4f}, MAE: {metrics["mae"]:.4f}, R²: {metrics["r2"]:.4f}')
    logger.info(f'Training time: {elapsed:.1f}s')

    return model, metrics, search.best_params_, elapsed


def train_lightgbm(X_train, y_train, X_val, y_val) -> tuple:
    """Train LightGBM with randomized hyperparameter search."""
    logger.info('\n=== Training LightGBM ===')
    start = time.time()

    param_dist = {
        'n_estimators': [200, 500, 800, 1200],
        'max_depth': [4, 6, 8, 10, -1],
        'learning_rate': [0.01, 0.03, 0.05, 0.1],
        'num_leaves': [31, 63, 127, 255],
        'min_child_samples': [5, 10, 20, 50],
        'subsample': [0.7, 0.8, 0.9],
        'colsample_bytree': [0.7, 0.8, 0.9],
        'reg_alpha': [0, 0.1, 0.5],
        'reg_lambda': [0, 0.1, 0.5, 1.0],
    }

    base_model = LGBMRegressor(
        random_state=RANDOM_STATE,
        n_jobs=-1,
        verbose=-1,
    )

    search = RandomizedSearchCV(
        base_model, param_dist,
        n_iter=50,
        cv=3,
        scoring='neg_root_mean_squared_error',
        random_state=RANDOM_STATE,
        n_jobs=-1,
        verbose=0,
    )
    search.fit(X_train, y_train)

    model = search.best_estimator_
    elapsed = time.time() - start

    metrics = evaluate(model, X_val, y_val)
    logger.info(f'Best params: {search.best_params_}')
    logger.info(f'Val RMSE: {metrics["rmse"]:.4f}, MAE: {metrics["mae"]:.4f}, R²: {metrics["r2"]:.4f}')
    logger.info(f'Training time: {elapsed:.1f}s')

    return model, metrics, search.best_params_, elapsed


def train_random_forest(X_train, y_train, X_val, y_val) -> tuple:
    """Train Random Forest with randomized hyperparameter search."""
    logger.info('\n=== Training Random Forest ===')
    start = time.time()

    param_dist = {
        'n_estimators': [200, 500],
        'max_depth': [10, 15, 20],
        'min_samples_split': [5, 10],
        'min_samples_leaf': [2, 4],
        'max_features': ['sqrt', 0.5],
    }

    base_model = RandomForestRegressor(
        random_state=RANDOM_STATE,
        n_jobs=2,
    )

    search = RandomizedSearchCV(
        base_model, param_dist,
        n_iter=15,
        cv=3,
        scoring='neg_root_mean_squared_error',
        random_state=RANDOM_STATE,
        n_jobs=1,
        verbose=0,
    )
    search.fit(X_train, y_train)

    model = search.best_estimator_
    elapsed = time.time() - start

    metrics = evaluate(model, X_val, y_val)
    logger.info(f'Best params: {search.best_params_}')
    logger.info(f'Val RMSE: {metrics["rmse"]:.4f}, MAE: {metrics["mae"]:.4f}, R²: {metrics["r2"]:.4f}')
    logger.info(f'Training time: {elapsed:.1f}s')

    return model, metrics, search.best_params_, elapsed


def main():
    logger.info('Loading prepared features...')
    data = load_data()
    X, y = data['X'], data['y']
    feature_cols = data['feature_cols']
    logger.info(f'Data shape: {X.shape}, Label range: [{y.min()}, {y.max()}]')

    # Train/validation split (80/20)
    X_train, X_val, y_train, y_val = train_test_split(
        X, y, test_size=0.2, random_state=RANDOM_STATE,
    )
    logger.info(f'Train: {X_train.shape[0]} rows, Val: {X_val.shape[0]} rows')

    # Train all three models
    results = {}

    xgb_model, xgb_metrics, xgb_params, xgb_time = train_xgboost(X_train, y_train, X_val, y_val)
    results['xgboost'] = {
        'model': xgb_model, 'metrics': xgb_metrics,
        'params': xgb_params, 'time': xgb_time,
    }

    lgbm_model, lgbm_metrics, lgbm_params, lgbm_time = train_lightgbm(X_train, y_train, X_val, y_val)
    results['lightgbm'] = {
        'model': lgbm_model, 'metrics': lgbm_metrics,
        'params': lgbm_params, 'time': lgbm_time,
    }

    rf_model, rf_metrics, rf_params, rf_time = train_random_forest(X_train, y_train, X_val, y_val)
    results['random_forest'] = {
        'model': rf_model, 'metrics': rf_metrics,
        'params': rf_params, 'time': rf_time,
    }

    # Pick best model (lowest RMSE, tiebreak by speed)
    logger.info('\n=== Model Comparison ===')
    for name, r in results.items():
        logger.info(f'{name:15s} | RMSE: {r["metrics"]["rmse"]:.4f} | MAE: {r["metrics"]["mae"]:.4f} | '
                     f'R²: {r["metrics"]["r2"]:.4f} | Time: {r["time"]:.1f}s')

    # Sort by RMSE, then by time for tiebreaking within 0.5 RMSE
    ranked = sorted(results.items(), key=lambda x: (x[1]['metrics']['rmse'], x[1]['time']))
    best_name = ranked[0][0]

    # Check if top two are within 0.5 RMSE — pick faster one
    if len(ranked) >= 2:
        diff = abs(ranked[0][1]['metrics']['rmse'] - ranked[1][1]['metrics']['rmse'])
        if diff < 0.5 and ranked[1][1]['time'] < ranked[0][1]['time']:
            best_name = ranked[1][0]
            logger.info(f'Models within 0.5 RMSE — picking faster: {best_name}')

    best = results[best_name]
    logger.info(f'\n*** Best model: {best_name} ***')
    logger.info(f'    RMSE: {best["metrics"]["rmse"]:.4f}')
    logger.info(f'    MAE: {best["metrics"]["mae"]:.4f}')
    logger.info(f'    R²: {best["metrics"]["r2"]:.4f}')

    # Save best model
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    model_path = SCRIPT_DIR / 'best_model.pkl'
    with open(model_path, 'wb') as f:
        pickle.dump({
            'model': best['model'],
            'name': best_name,
            'feature_cols': feature_cols,
        }, f)
    logger.info(f'Saved best model to {model_path}')

    # Also save train/val split for evaluation
    split_path = SCRIPT_DIR / 'train_val_split.pkl'
    with open(split_path, 'wb') as f:
        pickle.dump({
            'X_train': X_train, 'y_train': y_train,
            'X_val': X_val, 'y_val': y_val,
        }, f)

    # Update metadata
    meta_path = MODELS_DIR / 'model_metadata.json'
    with open(meta_path, 'r') as f:
        metadata = json.load(f)

    metadata['best_model'] = best_name
    metadata['best_params'] = {k: str(v) for k, v in best['params'].items()}
    metadata['training_metrics'] = best['metrics']
    metadata['all_model_results'] = {
        name: {
            'metrics': r['metrics'],
            'time': round(r['time'], 1),
        }
        for name, r in results.items()
    }

    with open(meta_path, 'w') as f:
        json.dump(metadata, f, indent=2)

    logger.info('Updated model_metadata.json')
    logger.info('Training complete!')


if __name__ == '__main__':
    main()
