"""The free SportsDB ablation (2026-08-30).

Answers ONE question with the data already paid for: do the game-night
features reduce error on the frozen corpus, measured the way the ship gate
measures?

    python sports_ablation.py          (from backend/scripts/ml/train/)

Prerequisites: prepare_features.py has been re-run with
FLOCK_SPORTS_FEATURES=1 in the environment AFTER sports_events.csv existed,
so the pickles carry the sports_* columns and observed_date. The flag exists
because the sports family is ablation-only: a normal retrain must never
featurise columns serving cannot compute. This
script fits the SAME model twice on the SAME rows, identical fixed
hyperparameters (the v2.3.0 search values every shipped model has carried
since), differing only in whether the sports columns are visible.

THE SPLIT IS FORWARD IN TIME AND THE EVAL SLICE IS PA, deliberately: the
geographic holdout (miami, tokyo, barcelona) is exactly where the
market-gated sports features are all zero by design, so it can measure only
noise for this family. Instead both models fit on every row dated at or
before the house prequential cutoff (2026-03-28, the same date the qmap's
confidence figure was measured on) plus all undated weekly rows, and are
scored on PA realtime served rows AFTER the cutoff, date-block
bootstrapped. The geographic holdout still runs as a NO-HARM check: sports
columns are all zero there, so the two fits should land within noise of
each other, and a real gap would mean the family disturbs cities it cannot
describe.

No API is touched, nothing ships, nothing is exported: this is a
measurement, and RETRAIN.md's sequencing says the $9/mo gets cancelled if
it earns nothing.

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

CUTOFF = '2026-03-28'  # the recorded house prequential cutoff, not a choice made here
PA = ('philly', 'lehigh')


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
            'FLOCK_SPORTS_FEATURES=1 set and sports_events.csv present '
            '(exportSportsEvents.js writes it); the ablation compares columns '
            'inside ONE feature build, never across two.')
    if 'observed_date' not in tr:
        raise SystemExit('train pickle lacks observed_date; re-run prepare_features.py (2026-08-30 dump).')
    if 'is_realtime' not in cols:
        raise SystemExit('is_realtime missing from feature_cols; wrong pickle generation.')

    sports_idx = [cols.index(c) for c in SPORTS_COLS]
    keep_idx = [i for i in range(len(cols)) if i not in set(sports_idx)]

    dates_tr = np.asarray(tr['observed_date'])
    rt_tr = tr['X'][:, cols.index('is_realtime')] == 1
    served_tr = tr['baseline'] > 0
    pa_tr = np.isin(tr['cities'], list(PA))

    fit_mask = (dates_tr == '') | (dates_tr <= CUTOFF)
    eval_mask = pa_tr & rt_tr & served_tr & (dates_tr > CUTOFF)
    game_col = tr['X'][:, cols.index('sports_game_today')]
    print(f'Fit rows: {int(fit_mask.sum())} of {len(dates_tr)} '
          f'(undated weekly plus dated on or before {CUTOFF})')
    print(f'PA eval rows after cutoff: {int(eval_mask.sum())} '
          f'({int((eval_mask & (game_col == 1)).sum())} on game nights)')
    if eval_mask.sum() < 1000:
        raise SystemExit('Fewer than 1000 PA eval rows; the split is wrong, not the corpus.')

    print(f'Training pair on {int(fit_mask.sum())} rows x {len(cols)} features '
          f'({len(SPORTS_COLS)} sports columns ablated in the baseline fit)...')
    Xf = tr['X'][fit_mask]
    m_with = fit(Xf, tr['y'][fit_mask], tr['sample_weight'][fit_mask], 'with-sports')
    m_without = fit(Xf[:, keep_idx], tr['y'][fit_mask], tr['sample_weight'][fit_mask], 'without-sports')

    Xe = tr['X'][eval_mask]
    base_e = tr['baseline'][eval_mask]
    y = tr['y_actual'][eval_mask]
    pred_with = reconstruct(m_with.predict(Xe), base_e)
    pred_without = reconstruct(m_without.predict(Xe[:, keep_idx]), base_e)

    a = metrics(y, pred_with)
    b = metrics(y, pred_without)
    print('\n========== SPORTS ABLATION (PA forward slice, qmap disarmed) ==========')
    print(f'  without sports: MAE {b["mae"]:.3f}  W10 {b["within_10"]:.2f}%  W20 {b["within_20"]:.2f}%')
    print(f'  with sports:    MAE {a["mae"]:.3f}  W10 {a["within_10"]:.2f}%  W20 {a["within_20"]:.2f}%')
    print(f'  delta:          MAE {a["mae"]-b["mae"]:+.3f}  W10 {a["within_10"]-b["within_10"]:+.2f}pp  '
          f'W20 {a["within_20"]-b["within_20"]:+.2f}pp')

    game_e = game_col[eval_mask] == 1
    if game_e.any():
        ag = metrics(y[game_e], pred_with[game_e])
        bg = metrics(y[game_e], pred_without[game_e])
        print(f'  game nights only ({int(game_e.sum())} rows): '
              f'MAE {bg["mae"]:.3f} -> {ag["mae"]:.3f} ({ag["mae"]-bg["mae"]:+.3f}), '
              f'W10 {bg["within_10"]:.2f}% -> {ag["within_10"]:.2f}% ({ag["within_10"]-bg["within_10"]:+.2f}pp)')

    boot = date_block_bootstrap(dates_tr[eval_mask], y, pred_with, pred_without)
    if boot:
        print(f'  date-block bootstrap ({boot["resamples"]} resamples over {boot["date_blocks"]} days):')
        print(f'    W10 delta CI  [{boot["w10_delta_ci"][0]:+.2f}, {boot["w10_delta_ci"][1]:+.2f}]pp')
        print(f'    MAE delta CI  [{boot["mae_delta_ci"][0]:+.3f}, {boot["mae_delta_ci"][1]:+.3f}]')
        real = boot['w10_delta_ci'][0] > 0 or boot['mae_delta_ci'][1] < 0
        print(f'  VERDICT: {"lift is real on this corpus" if real else "no lift distinguishable from day noise"}')
    else:
        print('  (too few eval dates; bootstrap skipped, point estimates only)')

    # No-harm check on the geographic holdout, where every sports column is
    # zero by the market gate.
    rt_ho = ho['X'][:, cols.index('is_realtime')] == 1
    served_ho = ho['baseline'] > 0
    hmask = rt_ho & served_ho
    hw = reconstruct(m_with.predict(ho['X'][hmask]), ho['baseline'][hmask])
    hwo = reconstruct(m_without.predict(ho['X'][hmask][:, keep_idx]), ho['baseline'][hmask])
    hy = ho['y_actual'][hmask]
    print(f'\n  no-harm (geo holdout, sports all zero, {int(hmask.sum())} rows): '
          f'MAE {metrics(hy, hwo)["mae"]:.3f} -> {metrics(hy, hw)["mae"]:.3f}')

    # Where the trees actually spent the sports columns, for color.
    gains = m_with.get_booster().get_score(importance_type='gain')
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
