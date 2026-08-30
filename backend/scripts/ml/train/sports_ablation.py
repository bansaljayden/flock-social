"""The free SportsDB ablation (2026-08-30).

Answers ONE question with the data already paid for: do the game-night
features reduce error on the frozen corpus's realtime holdout, measured the
way the ship gate measures?

    python sports_ablation.py          (from backend/scripts/ml/train/)

Prerequisites: prepare_features.py has been re-run AFTER sports_events.csv
existed, so the pickles carry the sports_* columns. This script then fits
the SAME model twice on the SAME rows and split, identical fixed
hyperparameters (the v2.3.0 search values every shipped model has carried
since), differing only in whether the sports columns are visible, and
compares on the realtime served slice with the same reconstruction and the
same date-block bootstrap GATE-B uses. No API is touched, nothing ships,
nothing is exported: this is a measurement, and RETRAIN.md's sequencing says
the $9/mo gets cancelled if it earns nothing.

The quantile map is DISARMED for both fits on purpose: it was fitted on the
incumbent's output distribution and applying it to two fresh fits would
measure the map's interaction with each, not the features' skill. Raw
reconstruction, same on both sides, is the honest comparison.
"""

import os
import pickle
import sys

os.environ['CROWD_QMAP_ENABLED'] = 'false'  # before quick_eval import, see docstring

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from quick_eval import metrics, reconstruct, date_block_bootstrap  # noqa: E402

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# The fixed hyperparameters every shipped model since v2.3.0 has carried
# (model_metadata.json hyperparameters.params, source fixed_from_v2.3.0_search).
PARAMS = {
    'n_estimators': 800, 'max_depth': 8, 'learning_rate': 0.01,
    'subsample': 0.9, 'colsample_bytree': 0.8, 'min_child_weight': 7,
    'reg_lambda': 1.0, 'reg_alpha': 0.5,
}

SPORTS_COLS = ['sports_game_today', 'sports_games_count', 'sports_evening_game',
               'sports_home_game_today', 'sports_home_dist_km', 'sports_home_within_10km']


def fit(X, y, w, label):
    from xgboost import XGBRegressor
    try:
        model = XGBRegressor(**PARAMS, tree_method='hist', device='cuda',
                             random_state=26, n_jobs=-1)
        model.fit(X, y, sample_weight=w)
        print(f'  [{label}] fitted on cuda')
    except Exception as err:  # noqa: BLE001 - any GPU failure falls back whole
        print(f'  [{label}] cuda unavailable ({err}); fitting on cpu')
        model = XGBRegressor(**PARAMS, tree_method='hist',
                             random_state=26, n_jobs=-1)
        model.fit(X, y, sample_weight=w)
    return model


def main():
    with open(os.path.join(SCRIPT_DIR, 'features_train.pkl'), 'rb') as f:
        tr = pickle.load(f)
    with open(os.path.join(SCRIPT_DIR, 'features_holdout.pkl'), 'rb') as f:
        ho = pickle.load(f)

    cols = list(tr['feature_cols'])
    missing = [c for c in SPORTS_COLS if c not in cols]
    if missing:
        raise SystemExit(
            f'Pickles lack {missing}. Re-run prepare_features.py with '
            'sports_events.csv present (exportSportsEvents.js writes it); the '
            'ablation compares columns inside ONE feature build, never across two.')

    sports_idx = [cols.index(c) for c in SPORTS_COLS]
    keep_idx = [i for i in range(len(cols)) if i not in set(sports_idx)]

    # The gate slice: realtime rows the serving population would actually see
    # (baseline > 0), the same mask quick_eval's arms use. is_realtime is a
    # feature column, so the mask comes from the matrix itself rather than
    # from provenance strings whose vocabulary has drifted across exports.
    if 'is_realtime' not in cols:
        raise SystemExit('is_realtime missing from feature_cols; wrong pickle generation.')
    rt = ho['X'][:, cols.index('is_realtime')] == 1
    served = ho['baseline'] > 0
    mask = rt & served
    print(f'Holdout: {len(ho["y"])} rows, gate slice {int(mask.sum())} (rt {int(rt.sum())}, served {int(served.sum())})')
    if mask.sum() < 100:
        raise SystemExit('Fewer than 100 gate rows; the slice mask is wrong, not the corpus.')

    print(f'Training pair on {tr["X"].shape[0]} rows x {len(cols)} features '
          f'({len(SPORTS_COLS)} sports columns ablated in the baseline fit)...')
    m_with = fit(tr['X'], tr['y'], tr['sample_weight'], 'with-sports')
    m_without = fit(tr['X'][:, keep_idx], tr['y'], tr['sample_weight'], 'without-sports')

    pred_with = reconstruct(m_with.predict(ho['X']), ho['baseline'])
    pred_without = reconstruct(m_without.predict(ho['X'][:, keep_idx]), ho['baseline'])

    y = ho['y_actual'][mask]
    a = metrics(y, pred_with[mask])
    b = metrics(y, pred_without[mask])
    print('\n========== SPORTS ABLATION (gate slice, qmap disarmed) ==========')
    print(f'  without sports: MAE {b["mae"]:.3f}  W10 {b["within_10"]:.2f}%  W20 {b["within_20"]:.2f}%')
    print(f'  with sports:    MAE {a["mae"]:.3f}  W10 {a["within_10"]:.2f}%  W20 {a["within_20"]:.2f}%')
    print(f'  delta:          MAE {a["mae"]-b["mae"]:+.3f}  W10 {a["within_10"]-b["within_10"]:+.2f}pp  '
          f'W20 {a["within_20"]-b["within_20"]:+.2f}pp')

    dates_all = np.asarray(ho.get('observed_date', np.array([''] * len(ho['y']))))[mask]
    dated = dates_all != ''
    boot = None
    if dated.any():
        boot = date_block_bootstrap(dates_all[dated], y[dated],
                                    pred_with[mask][dated], pred_without[mask][dated])
    if boot:
        print(f'  date-block bootstrap ({boot["resamples"]} resamples over {boot["date_blocks"]} days):')
        print(f'    W10 delta CI  [{boot["w10_delta_ci"][0]:+.2f}, {boot["w10_delta_ci"][1]:+.2f}]pp')
        print(f'    MAE delta CI  [{boot["mae_delta_ci"][0]:+.3f}, {boot["mae_delta_ci"][1]:+.3f}]')
        real = boot['w10_delta_ci'][0] > 0 or boot['mae_delta_ci'][1] < 0
        print(f'  VERDICT: {"lift is real on this corpus" if real else "no lift distinguishable from day noise"}')
    else:
        print('  (no dates on the gate slice; bootstrap skipped, point estimates only)')

    # Where the trees actually spent the sports columns, for color.
    gains = m_with.get_booster().get_score(importance_type='gain')
    booster_names = m_with.get_booster().feature_names or [f'f{i}' for i in range(len(cols))]
    by_col = {}
    for k, v in gains.items():
        name = cols[int(k[1:])] if k.startswith('f') and k[1:].isdigit() else k
        by_col[name] = v
    ranked = sorted(by_col.items(), key=lambda kv: -kv[1])
    rank_of = {name: i + 1 for i, (name, _) in enumerate(ranked)}
    print('\n  sports columns by gain rank (of', len(ranked), 'used features):')
    for c in SPORTS_COLS:
        print(f'    {c}: rank {rank_of.get(c, "unused")}')


if __name__ == '__main__':
    main()
