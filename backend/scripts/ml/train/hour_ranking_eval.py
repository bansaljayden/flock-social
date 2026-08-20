"""
WITHIN-VENUE HOUR-RANKING EVALUATION.

The question this answers, and the one it does NOT answer.

  ASKED HERE: inside ONE venue on ONE day, does the model order two hours the
  same way reality does? That is the claim "go at 9pm instead of 8pm". It is a
  RANKING claim, and its unit is a pair of hours at the same venue.

  NOT ASKED HERE: is the published number right (that is MODEL-METRICS.md, MAE
  29.42 / within-10 20.7%), and is venue A busier than venue B at one hour
  (that is the strip, measured 43.1% backwards in ADVISOR-GROUNDING.md). Both
  are different questions with different units. Do not conflate them.

Read-only. Loads the SHIPPED v2.6.0-starling artifacts from models/incumbent/
(train/best_model.pkl and train/features_holdout.pkl were overwritten by the
v2.7 prep on 2026-08-18 22:55 — see RETRAIN-V27-LOG.md "Dispersion lab"), and
writes nothing outside the output directory.

Reproduce:

    cd backend/scripts/ml/train
    FLOCK_TRAIN_THREADS=4 python hour_ranking_eval.py

Results land in <out>/hour_ranking_results.json. Default <out> is the value of
FLOCK_EVAL_OUT, else a `hour_ranking_out` directory next to this file's parent
that is NOT one of the protected artifact paths.
"""

import json
import os
import pickle
import sys
from pathlib import Path

THREADS = os.environ.get('FLOCK_TRAIN_THREADS', '4')
for _v in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS',
           'NUMEXPR_NUM_THREADS'):
    os.environ.setdefault(_v, THREADS)

import numpy as np
import pandas as pd

SCRIPT_DIR = Path(__file__).parent
ML_DIR = SCRIPT_DIR.parent
INCUMBENT = ML_DIR / 'models' / 'incumbent'
HOLDOUT_CSV = SCRIPT_DIR / 'holdout_data.csv'

OUT_DIR = Path(os.environ.get('FLOCK_EVAL_OUT', SCRIPT_DIR / 'hour_ranking_out'))

# The gate numbers this run must reproduce before anything below it is trusted.
# From RETRAIN-V27-LOG.md CP1 and gate_v27_cpu.log.
EXPECT_ROWS = 67249
EXPECT_MODEL_MAE = 29.4191
EXPECT_MODEL_W10 = 20.67
EXPECT_BASE_MAE = 31.4782
EXPECT_BASE_W10 = 19.16

RNG_SEED = 42
BOOTSTRAP_RESAMPLES = 1000

# TRUE-gap buckets. Labels are integers, so [1,5] means gap in {1..5}.
BUCKETS = [
    ('1-5', 1, 5),
    ('5-10', 6, 10),
    ('10-20', 11, 20),
    ('20+', 21, 10**9),
]


def log(msg=''):
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# Reconstruction — production's, byte-for-byte with mlPredictor.reconstructScore
# ---------------------------------------------------------------------------
def reconstruct_served(raw_delta, baseline):
    """What a user is shown: round(clip(baseline + clamp(delta, -50, 50))) then
    the 1-point extremes push. Integer, because the app compares integers."""
    score = np.clip(np.round(baseline + np.clip(raw_delta, -50.0, 50.0)), 0, 100)
    score = np.where(score < 25, np.maximum(0, score - 1),
                     np.where(score > 65, np.minimum(100, score + 1), score))
    return score.astype(np.int32)


def reconstruct_gate_legacy(raw_delta, baseline):
    """The +-30 unrounded reconstruction every published gate number was
    computed under (MODEL-METRICS.md, gate logs). Used only to prove the
    artifact is the shipped one."""
    return np.clip(baseline + np.clip(raw_delta, -30.0, 30.0), 0, 100)


def reconstruct_serve_float(raw_delta, baseline):
    """Production arithmetic without the final rounding — the sensitivity arm,
    so a reader can see how much of any tie rate is the rounding."""
    score = np.clip(baseline + np.clip(raw_delta, -50.0, 50.0), 0, 100)
    score = np.where(score < 25, score - 1, np.where(score > 65, score + 1, score))
    return np.clip(score, 0, 100)


def point_metrics(y_true, y_pred):
    y_pred = np.clip(y_pred, 0, 100)
    err = np.abs(y_true - y_pred)
    return {
        'mae': round(float(err.mean()), 4),
        'within_10': round(float((err <= 10).mean() * 100), 2),
        'r2': round(float(1 - np.sum((y_true - y_pred) ** 2)
                          / np.sum((y_true - y_true.mean()) ** 2)), 4),
    }


# ---------------------------------------------------------------------------
# Load + reproduce
# ---------------------------------------------------------------------------
def load_and_reproduce():
    mp = INCUMBENT / 'best_model.pkl'
    hp = INCUMBENT / 'features_holdout.pkl'
    for p in (mp, hp, HOLDOUT_CSV):
        if not p.exists():
            sys.exit(f'MISSING: {p}')

    with open(hp, 'rb') as f:
        hold = pickle.load(f)
    with open(mp, 'rb') as f:
        bundle = pickle.load(f)

    model = bundle['model']
    model_cols = list(bundle.get('feature_cols') or [])
    hold_cols = list(hold['feature_cols'])
    if model_cols != hold_cols:
        sys.exit('feature_cols disagree between best_model.pkl and features_holdout.pkl')

    X = hold['X']
    y = np.asarray(hold['y_actual'], dtype=float)
    baseline = np.asarray(hold['baseline'], dtype=float)
    cities = np.asarray(hold['cities'])
    is_realtime = X[:, hold_cols.index('is_realtime')].astype(int)

    # The gate slice: exactly quick_eval's `serving_population_mask(baseline) &
    # is_realtime`. Reimplemented as `baseline > 0` here only because importing
    # prepare_features drags the whole v2.7 module in; the predicate is one
    # comparison and is asserted against the published row count below.
    gate = (is_realtime == 1) & (baseline > 0)
    n_gate = int(gate.sum())

    log('========== REPRODUCTION ==========')
    log(f'  artifact: {mp} ({mp.stat().st_size:,} bytes)')
    log(f'  holdout rows: {len(y):,}   gate rows: {n_gate:,}  (expected {EXPECT_ROWS:,})')
    if n_gate != EXPECT_ROWS:
        log(f'  *** GATE SLICE DID NOT REPRODUCE: {n_gate} != {EXPECT_ROWS} ***')

    raw_delta = model.predict(X)
    legacy = reconstruct_gate_legacy(raw_delta, baseline)
    served = reconstruct_served(raw_delta, baseline).astype(float)
    base_pred = np.clip(baseline, 0, 100)

    m_legacy = point_metrics(y[gate], legacy[gate])
    m_served = point_metrics(y[gate], served[gate])
    m_base = point_metrics(y[gate], base_pred[gate])
    log(f'  model (legacy +-30 gate arithmetic): MAE {m_legacy["mae"]}  W10 {m_legacy["within_10"]}%'
        f'   [expected {EXPECT_MODEL_MAE} / {EXPECT_MODEL_W10}%]')
    log(f'  model (production serve, +-50+push, rounded): MAE {m_served["mae"]}  W10 {m_served["within_10"]}%')
    log(f'  popular-times baseline alone: MAE {m_base["mae"]}  W10 {m_base["within_10"]}%'
        f'   [expected {EXPECT_BASE_MAE} / {EXPECT_BASE_W10}%]')

    exact = (m_legacy['mae'] == EXPECT_MODEL_MAE and m_legacy['within_10'] == EXPECT_MODEL_W10
             and m_base['mae'] == EXPECT_BASE_MAE and m_base['within_10'] == EXPECT_BASE_W10
             and n_gate == EXPECT_ROWS)
    log(f'  EXACT REPRODUCTION: {exact}')
    if not exact:
        log('  *** the numbers below are NOT on the published gate slice ***')

    # Row identity, proven not assumed. features_holdout.pkl carries no
    # venue_id and no date; holdout_data.csv does. prepare_features' holdout
    # path only drops null labels and never reorders, so a positional join is
    # legitimate ONLY if it verifies. It is verified on three columns.
    csv = pd.read_csv(HOLDOUT_CSV, usecols=[
        'venue_id', 'day_of_week', 'hour', 'busyness_pct', 'is_realtime',
        'baseline_busyness', 'observed_date', 'city', 'venue_category'])
    align = {
        'row_count_matches': len(csv) == len(y),
        'y_actual_identical': bool(np.array_equal(csv['busyness_pct'].to_numpy(dtype=float), y)),
        'hour_identical': bool(np.array_equal(csv['hour'].to_numpy(dtype=int),
                                              np.asarray(hold['hour']).astype(int))),
        'is_realtime_identical': bool(np.array_equal(csv['is_realtime'].to_numpy(dtype=int), is_realtime)),
        'city_identical': bool(np.array_equal(csv['city'].astype(str).to_numpy(), cities.astype(str))),
    }
    # NOT checked for identity on purpose: the pickle's `baseline` is the
    # neighbour-SMOOTHED anchor (prepare_features.smooth_baseline_hours,
    # floor(0.6*h + 0.2*prev + 0.2*next + 0.5)), while holdout_data.csv carries
    # the raw popular-times column. They differ on 182,327 of 395,464 rows by up
    # to 17 points. The smoothed one is what the model's delta is added to and
    # what every published "baseline alone" number is, so it is the primary
    # baseline arm here; the raw column is carried as a third predictor because
    # smoothing is itself a curve-shape edit and its effect on ordering is worth
    # seeing.
    log('  row alignment (pickle <-> holdout_data.csv):')
    for k, v in align.items():
        log(f'    {k:24s} {v}')
    if not all(align.values()):
        sys.exit('row alignment failed — venue_id/date cannot be trusted, stopping')

    df = csv[gate].copy()
    df['y'] = y[gate]
    df['pred_model'] = served[gate]
    df['pred_model_float'] = reconstruct_serve_float(raw_delta, baseline)[gate]
    df['pred_model_legacy'] = legacy[gate]
    df['pred_base'] = base_pred[gate]
    df = df.reset_index(drop=True)

    repro = {
        'gate_rows': n_gate,
        'expected_gate_rows': EXPECT_ROWS,
        'exact_reproduction': bool(exact),
        'model_legacy_clamp30': m_legacy,
        'model_production_serve': m_served,
        'popular_times_baseline': m_base,
        'row_alignment': align,
        'date_range': [str(df['observed_date'].min()), str(df['observed_date'].max())],
    }
    return df, repro


# ---------------------------------------------------------------------------
# Pair construction
# ---------------------------------------------------------------------------
def build_pairs(df, keys, require_distinct_hour=True, same_hour_only=False):
    """All unordered pairs of rows sharing `keys`. Returns arrays of the two
    sides' true values and each predictor's values, plus the group id."""
    idx_by_group = df.groupby(keys, sort=False).indices
    a_list, b_list, g_list = [], [], []
    for gi, (_, idx) in enumerate(idx_by_group.items()):
        n = len(idx)
        if n < 2:
            continue
        ii, jj = np.triu_indices(n, k=1)
        a_list.append(idx[ii])
        b_list.append(idx[jj])
        g_list.append(np.full(len(ii), gi, dtype=np.int64))
    if not a_list:
        return None
    a = np.concatenate(a_list)
    b = np.concatenate(b_list)
    g = np.concatenate(g_list)

    hour = df['hour'].to_numpy()
    if require_distinct_hour:
        keep = hour[a] != hour[b]
    elif same_hour_only:
        keep = hour[a] == hour[b]
    else:
        keep = np.ones(len(a), dtype=bool)
    a, b, g = a[keep], b[keep], g[keep]

    return {
        'a': a, 'b': b, 'group': g,
        'venue': df['venue_id'].to_numpy()[a],
        'y_a': df['y'].to_numpy()[a], 'y_b': df['y'].to_numpy()[b],
        'preds': {
            'model': (df['pred_model'].to_numpy()[a], df['pred_model'].to_numpy()[b]),
            'baseline': (df['pred_base'].to_numpy()[a], df['pred_base'].to_numpy()[b]),
            'model_unrounded': (df['pred_model_float'].to_numpy()[a], df['pred_model_float'].to_numpy()[b]),
        },
    }


def order_outcomes(y_a, y_b, p_a, p_b):
    """+1 correct, -1 backwards, 0 predictor tie. True ties must be filtered
    out before this is called."""
    true_sign = np.sign(y_a - y_b)
    pred_sign = np.sign(p_a - p_b)
    out = np.zeros(len(y_a), dtype=np.int8)
    out[(pred_sign != 0) & (pred_sign == true_sign)] = 1
    out[(pred_sign != 0) & (pred_sign != true_sign)] = -1
    return out


def bucket_table(pairs, pred_name):
    p_a, p_b = pairs['preds'][pred_name]
    y_a, y_b = pairs['y_a'], pairs['y_b']
    gap = np.abs(y_a - y_b)
    tie_truth = gap == 0

    rows = []
    # ties in truth, reported separately and never scored as right or wrong
    rows.append({
        'bucket': 'true tie (gap 0)',
        'n_pairs': int(tie_truth.sum()),
        'correct_pct': None, 'backwards_pct': None,
        'pred_tie_pct': round(float((np.sign(p_a - p_b)[tie_truth] == 0).mean() * 100), 2)
                        if tie_truth.any() else None,
        'accuracy_excl_pred_ties': None,
    })

    scored = ~tie_truth
    out_all = order_outcomes(y_a, y_b, p_a, p_b)

    def summarize(label, mask):
        n = int(mask.sum())
        if n == 0:
            return {'bucket': label, 'n_pairs': 0, 'correct_pct': None,
                    'backwards_pct': None, 'pred_tie_pct': None,
                    'accuracy_excl_pred_ties': None}
        o = out_all[mask]
        c = int((o == 1).sum()); w = int((o == -1).sum()); t = int((o == 0).sum())
        return {
            'bucket': label, 'n_pairs': n,
            'correct_pct': round(c / n * 100, 2),
            'backwards_pct': round(w / n * 100, 2),
            'pred_tie_pct': round(t / n * 100, 2),
            'accuracy_excl_pred_ties': round(c / (c + w) * 100, 2) if (c + w) else None,
        }

    for label, lo, hi in BUCKETS:
        rows.append(summarize(label, scored & (gap >= lo) & (gap <= hi)))
    rows.append(summarize('ALL non-tied', scored))
    return rows


def paired_bootstrap(pairs, gap_lo, gap_hi, resamples=BOOTSTRAP_RESAMPLES, seed=RNG_SEED):
    """Venue-block bootstrap of (model correct% - baseline correct%) on one
    gap bucket. Blocks are venues, because a venue's hours are not independent
    draws."""
    y_a, y_b = pairs['y_a'], pairs['y_b']
    gap = np.abs(y_a - y_b)
    mask = (gap >= gap_lo) & (gap <= gap_hi) & (gap > 0)
    if mask.sum() < 50:
        return None
    m = order_outcomes(y_a, y_b, *pairs['preds']['model'])[mask]
    b = order_outcomes(y_a, y_b, *pairs['preds']['baseline'])[mask]
    venues = pairs['venue'][mask]
    uv, vidx = np.unique(venues, return_inverse=True)
    order = np.argsort(vidx, kind='stable')
    vidx_s = vidx[order]
    m_s = (m == 1).astype(np.float64)[order]
    b_s = (b == 1).astype(np.float64)[order]
    starts = np.searchsorted(vidx_s, np.arange(len(uv)))
    ends = np.searchsorted(vidx_s, np.arange(len(uv)), side='right')
    m_sum = np.add.reduceat(m_s, starts) if len(uv) else np.array([])
    b_sum = np.add.reduceat(b_s, starts) if len(uv) else np.array([])
    counts = (ends - starts).astype(np.float64)

    rng = np.random.default_rng(seed)
    diffs = np.empty(resamples)
    nv = len(uv)
    for i in range(resamples):
        pick = rng.integers(0, nv, nv)
        cn = counts[pick].sum()
        diffs[i] = (m_sum[pick].sum() - b_sum[pick].sum()) / cn * 100
    obs = ((m == 1).mean() - (b == 1).mean()) * 100
    return {
        'observed_diff_pp': round(float(obs), 3),
        'ci95': [round(float(np.percentile(diffs, 2.5)), 3),
                 round(float(np.percentile(diffs, 97.5)), 3)],
        'resamples': resamples, 'venue_blocks': int(nv), 'n_pairs': int(mask.sum()),
    }


# ---------------------------------------------------------------------------
# Quietest-open-hour
# ---------------------------------------------------------------------------
def quietest_hour(df, keys, pred_col, seed=RNG_SEED):
    """For each group, take the predictor's argmin hour and ask where it sits
    in the TRUE ordering.

    Ties in the prediction are handled by expectation under uniform random
    tie-breaking, which is what an app that picks the first minimum does on
    average and does not flatter either predictor.

    'Open' is proxied by membership in the gate slice: the hours that exist in
    this venue-day are the hours production has both a live reading and a
    baseline for. The corpus carries no opening-hours column, so this is the
    only defensible candidate set, and it is a GENEROUS one: it hands the
    predictor a shortlist of at most 5 hours instead of a whole day.
    """
    y = df['y'].to_numpy()
    p = df[pred_col].to_numpy()
    groups = df.groupby(keys, sort=False).indices

    per_size = {}
    for _, idx in groups.items():
        n = len(idx)
        if n < 2:
            continue
        yy = y[idx]
        pp = p[idx]
        mn = pp.min()
        cand = np.flatnonzero(pp == mn)          # predicted-quietest set
        ys = np.sort(yy)
        # inclusive top-k: an hour is top-k if its true value <= the k-th smallest
        def topk_hit(k):
            if k >= n:
                return None
            thr = ys[k - 1]
            return float(np.mean(yy[cand] <= thr))
        # true percentile: 0 = quietest, 1 = busiest, average ranks for ties
        ranks = pd.Series(yy).rank(method='average').to_numpy()
        pct = float(np.mean((ranks[cand] - 1) / (n - 1)))

        rec = per_size.setdefault(n, {'groups': 0, 'exact': 0.0, 'top2': 0.0,
                                      'top3': 0.0, 'top2_n': 0, 'top3_n': 0,
                                      'pct': 0.0, 'chance_exact': 0.0,
                                      'chance_top2': 0.0, 'chance_top2_n': 0,
                                      'chance_top3': 0.0, 'chance_top3_n': 0,
                                      'pred_tie_groups': 0})
        rec['groups'] += 1
        rec['exact'] += topk_hit(1) if n > 1 else 0.0
        rec['chance_exact'] += float(np.mean(yy <= ys[0]))
        if len(cand) > 1:
            rec['pred_tie_groups'] += 1
        if n > 2:
            rec['top2'] += topk_hit(2); rec['top2_n'] += 1
            rec['chance_top2'] += float(np.mean(yy <= ys[1])); rec['chance_top2_n'] += 1
        if n > 3:
            rec['top3'] += topk_hit(3); rec['top3_n'] += 1
            rec['chance_top3'] += float(np.mean(yy <= ys[2])); rec['chance_top3_n'] += 1
        rec['pct'] += pct

    out = []
    tot = {'groups': 0, 'exact': 0.0, 'pct': 0.0, 'chance_exact': 0.0,
           'top2': 0.0, 'top2_n': 0, 'top3': 0.0, 'top3_n': 0,
           'chance_top2': 0.0, 'chance_top3': 0.0, 'pred_tie_groups': 0}
    for n in sorted(per_size):
        r = per_size[n]
        out.append({
            'hours_in_group': n, 'groups': r['groups'],
            'exact_pct': round(r['exact'] / r['groups'] * 100, 2),
            'chance_exact_pct': round(r['chance_exact'] / r['groups'] * 100, 2),
            'top2_pct': round(r['top2'] / r['top2_n'] * 100, 2) if r['top2_n'] else None,
            'chance_top2_pct': round(r['chance_top2'] / r['chance_top2_n'] * 100, 2) if r['chance_top2_n'] else None,
            'top3_pct': round(r['top3'] / r['top3_n'] * 100, 2) if r['top3_n'] else None,
            'chance_top3_pct': round(r['chance_top3'] / r['chance_top3_n'] * 100, 2) if r['chance_top3_n'] else None,
            'mean_true_percentile': round(r['pct'] / r['groups'], 4),
            'pred_tie_groups': r['pred_tie_groups'],
        })
        for k in ('groups', 'exact', 'pct', 'chance_exact', 'top2', 'top2_n',
                  'top3', 'top3_n', 'chance_top2', 'chance_top3', 'pred_tie_groups'):
            tot[k] += r[k]
    overall = {
        'hours_in_group': 'ALL (>=2)', 'groups': tot['groups'],
        'exact_pct': round(tot['exact'] / tot['groups'] * 100, 2),
        'chance_exact_pct': round(tot['chance_exact'] / tot['groups'] * 100, 2),
        'top2_pct': round(tot['top2'] / tot['top2_n'] * 100, 2) if tot['top2_n'] else None,
        'chance_top2_pct': round(tot['chance_top2'] / tot['top2_n'] * 100, 2) if tot['top2_n'] else None,
        'top3_pct': round(tot['top3'] / tot['top3_n'] * 100, 2) if tot['top3_n'] else None,
        'chance_top3_pct': round(tot['chance_top3'] / tot['top3_n'] * 100, 2) if tot['top3_n'] else None,
        'mean_true_percentile': round(tot['pct'] / tot['groups'], 4),
        'pred_tie_groups': tot['pred_tie_groups'],
    }
    out.append(overall)
    return out


def print_bucket_table(title, rows_model, rows_base):
    log(f'\n--- {title} ---')
    log(f'{"bucket":<18}{"n pairs":>10}{"model ok%":>11}{"model back%":>13}'
        f'{"model tie%":>12}{"base ok%":>10}{"base back%":>12}{"base tie%":>11}')
    for rm, rb in zip(rows_model, rows_base):
        def f(v, w, d=2):
            return f'{v:>{w}.{d}f}' if isinstance(v, float) else f'{"-":>{w}}'
        log(f'{rm["bucket"]:<18}{rm["n_pairs"]:>10,}'
            f'{f(rm["correct_pct"],11)}{f(rm["backwards_pct"],13)}{f(rm["pred_tie_pct"],12)}'
            f'{f(rb["correct_pct"],10)}{f(rb["backwards_pct"],12)}{f(rb["pred_tie_pct"],11)}')


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    df, repro = load_and_reproduce()

    results = {'reproduction': repro, 'seed': RNG_SEED, 'threads': THREADS}

    # ---- Arm A: same venue, same calendar day, different hours (the strict arm)
    log('\n========== ARM A: within-venue, within-CALENDAR-DAY hour pairs ==========')
    grp = df.groupby(['venue_id', 'observed_date']).size()
    log(f'  venue-day groups: {len(grp):,}   with >=2 scored hours: {int((grp >= 2).sum()):,}')
    log(f'  group-size histogram: {dict(grp.value_counts().sort_index())}')
    pairs_a = build_pairs(df, ['venue_id', 'observed_date'])
    log(f'  hour pairs: {len(pairs_a["a"]):,}')
    rows_a_m = bucket_table(pairs_a, 'model')
    rows_a_b = bucket_table(pairs_a, 'baseline')
    rows_a_mu = bucket_table(pairs_a, 'model_unrounded')
    print_bucket_table('ARM A — model (production served score) vs popular-times baseline',
                       rows_a_m, rows_a_b)
    results['arm_a'] = {
        'definition': 'same venue_id, same observed_date, different hour; gate slice only',
        'groups_total': int(len(grp)),
        'groups_with_2plus': int((grp >= 2).sum()),
        'group_size_histogram': {int(k): int(v) for k, v in grp.value_counts().sort_index().items()},
        'n_pairs': int(len(pairs_a['a'])),
        'model': rows_a_m, 'baseline': rows_a_b, 'model_unrounded': rows_a_mu,
    }

    boot = {}
    for label, lo, hi in BUCKETS:
        boot[label] = paired_bootstrap(pairs_a, lo, hi)
    boot['ALL non-tied'] = paired_bootstrap(pairs_a, 1, 10**9)
    results['arm_a']['venue_block_bootstrap_model_minus_baseline'] = boot
    log('\n  venue-block bootstrap, model correct% - baseline correct% (1000 resamples):')
    for k, v in boot.items():
        if v:
            log(f'    {k:<14} {v["observed_diff_pp"]:+.2f}pp  CI95 [{v["ci95"][0]:+.2f}, {v["ci95"][1]:+.2f}]'
                f'  n={v["n_pairs"]:,} over {v["venue_blocks"]:,} venues')

    # ---- Arm B: same venue, same weekday, pooled across dates
    log('\n========== ARM B: within-venue, within-WEEKDAY, pooled across dates ==========')
    log('  (larger n, but each pair may span two different nights, so the true gap')
    log('   carries night-to-night variation on top of hour-of-day shape)')
    grp_b = df.groupby(['venue_id', 'day_of_week']).size()
    pairs_b = build_pairs(df, ['venue_id', 'day_of_week'])
    log(f'  venue-weekday groups with >=2 hours: {int((grp_b >= 2).sum()):,}   pairs: {len(pairs_b["a"]):,}')
    rows_b_m = bucket_table(pairs_b, 'model')
    rows_b_b = bucket_table(pairs_b, 'baseline')
    print_bucket_table('ARM B — model vs baseline', rows_b_m, rows_b_b)
    results['arm_b'] = {
        'definition': 'same venue_id, same day_of_week, different hour, any date',
        'n_pairs': int(len(pairs_b['a'])), 'model': rows_b_m, 'baseline': rows_b_b,
    }

    # ---- Arm C (control): same venue, same weekday, SAME hour, different dates
    log('\n========== ARM C (NULL CONTROL): same venue, same weekday, SAME hour, different nights ==========')
    log('  Nothing about hour-of-day shape can help here. If A and B do not beat C')
    log('  at the same gap, the ordering is coming from level, not from the curve.')
    pairs_c = build_pairs(df, ['venue_id', 'day_of_week'],
                          require_distinct_hour=False, same_hour_only=True)
    if pairs_c is not None and len(pairs_c['a']):
        rows_c_m = bucket_table(pairs_c, 'model')
        rows_c_b = bucket_table(pairs_c, 'baseline')
        log(f'  pairs: {len(pairs_c["a"]):,}')
        print_bucket_table('ARM C — model vs baseline (null control)', rows_c_m, rows_c_b)
        results['arm_c'] = {
            'definition': 'same venue_id, same day_of_week, SAME hour, different observed_date',
            'n_pairs': int(len(pairs_c['a'])), 'model': rows_c_m, 'baseline': rows_c_b,
        }
    else:
        results['arm_c'] = None
        log('  no same-hour repeat pairs exist')

    # ---- Quietest open hour
    log('\n========== QUIETEST OPEN HOUR (venue-day groups, gate slice) ==========')
    q_model = quietest_hour(df, ['venue_id', 'observed_date'], 'pred_model')
    q_base = quietest_hour(df, ['venue_id', 'observed_date'], 'pred_base')
    log(f'{"n hours":<10}{"groups":>9}{"| model exact%":>16}{"top2%":>9}{"top3%":>9}{"pctile":>9}'
        f'{"| base exact%":>15}{"top2%":>9}{"top3%":>9}{"pctile":>9}{"| chance exact%":>17}')
    for rm, rb in zip(q_model, q_base):
        def f(v, w):
            return f'{v:>{w}.2f}' if isinstance(v, float) else f'{"-":>{w}}'
        log(f'{str(rm["hours_in_group"]):<10}{rm["groups"]:>9,}'
            f'{f(rm["exact_pct"],16)}{f(rm["top2_pct"],9)}{f(rm["top3_pct"],9)}{f(rm["mean_true_percentile"],9)}'
            f'{f(rb["exact_pct"],15)}{f(rb["top2_pct"],9)}{f(rb["top3_pct"],9)}{f(rb["mean_true_percentile"],9)}'
            f'{f(rm["chance_exact_pct"],17)}')
    results['quietest_hour'] = {
        'candidate_set': 'hours present in the venue-day gate slice (openness proxy; see docstring)',
        'tie_rule': 'expectation under uniform random tie-breaking among predicted minima',
        'model': q_model, 'baseline': q_base,
    }

    out = OUT_DIR / 'hour_ranking_results.json'
    out.write_text(json.dumps(results, indent=2), encoding='utf-8')
    log(f'\nWrote {out}')


if __name__ == '__main__':
    main()
