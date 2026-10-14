"""
WITHIN-NIGHT HOUR RANKING ON THE SERVED ARITHMETIC (2026-10-14).

HOUR-RANKING-EVAL.md measured hour ordering on the v2.6.0 holdout (2-5 hours a
night) and, in section 9, the best-time rule as it shipped on 2026-08-20. Since
2026-09-26 production serves curve + 0.85 x trailing offset, and since
2026-10-14 a reading one hour old as it is (services/mlPredictor.js
NOWCAST_WEIGHTS). This re-runs the ordering question on the month of live
readings bandEval.js replays, which reach up to 21 hours of one venue's night.

Input: the rows CSV bandEval.js writes (`--rows-out`), the 2026-10-08 export
replayed from 2026-09-09, one row per live reading with these columns read:
venue_id, date, hour, y (the live reading), ml (1 = model-served row),
smoothed (the served curve, which crowdEngine.orderingAxis ranks on as
baselineScore), served_curve_offset (round(curve + 0.85 x offset), the number a
future hour is served), served_nowcast_reading and served_nowcast_lag_hours
(the newest earlier reading and its age).

What a decision at hour h1 can see, and so what each arm ranks on:
  curve           the curve at every hour (production's orderingAxis today)
  curve_offset    the curve plus the venue's trailing offset as known at the
                  night's first scored hour, one shift for the whole night: what
                  a strip fetched before the night shows for its future hours
  served_now      for the now-versus-later decision only: "now" is the number
                  the card's dial shows at h1 (the reading one hour old when
                  there is one, else curve + offset), and each later hour is
                  curve + the offset known at h1

Arms (each pair is two live readings of one venue on one date):
  A  every pair, both hours ranked from before the night (curve vs curve_offset)
  N  every pair taken as now (the earlier hour) against later (the later one):
     curve vs served_now. This is the pair the best-time line decides.
  R  the decision itself, HOUR-RANKING-EVAL.md 9.3 with candidates restricted to
     LATER hours: at each hour, the argmin over the night's later hours, spoken
     only when it is more than HOUR_ORDERING_MIN_GAP (10) below now.

Pairwise accuracy is concordance: 1 when the predictor orders the pair as the
readings do, 0 when backwards, 0.5 on a predictor tie; pairs whose readings are
equal are not scored. Intervals: venue-block and date-block bootstraps of the
paired difference, 1000 resamples, seed 42.

Read-only. Trains and fits nothing.

    python hour_ranking_served.py <rows.csv> [<out.json>]
"""

import json
import sys

import numpy as np
import pandas as pd

MIN_GAP = 10
RESAMPLES = 1000
SEED = 42
BUCKETS = [('1-5', 1, 5), ('6-10', 6, 10), ('11-20', 11, 20), ('21+', 21, 10 ** 9), ('ALL', 1, 10 ** 9)]


def load(path):
    d = pd.read_csv(path)
    d = d[d['ml'] == 1].copy()
    d['curve'] = d['smoothed'].round().clip(0, 100)
    d['co'] = d['served_curve_offset']
    fresh = d['served_nowcast_lag_hours'] == 1
    d['dial'] = np.where(fresh, d['served_nowcast_reading'], d['co'])
    # The integer shift curve + offset applies to this hour's curve, the offset
    # as known at this hour (exact wherever the clamp did not bite).
    d['shift'] = d['co'] - d['curve']
    d = d.sort_values(['venue_id', 'date', 'hour']).reset_index(drop=True)
    return d


def pairs(d):
    """Every pair (i earlier, j later) inside one venue-date."""
    a_idx, b_idx = [], []
    for _, idx in d.groupby(['venue_id', 'date'], sort=False).indices.items():
        n = len(idx)
        if n < 2:
            continue
        ii, jj = np.triu_indices(n, k=1)
        a_idx.append(idx[ii])
        b_idx.append(idx[jj])
    return np.concatenate(a_idx), np.concatenate(b_idx)


def concord(y_a, y_b, p_a, p_b):
    ts = np.sign(y_b - y_a)
    ps = np.sign(p_b - p_a)
    return np.where(ps == 0, 0.5, (ps == ts).astype(float))


def block_ci(keys, diff, resamples=RESAMPLES, seed=SEED):
    uk, inv = np.unique(keys, return_inverse=True)
    s = np.zeros(len(uk))
    c = np.zeros(len(uk))
    np.add.at(s, inv, diff)
    np.add.at(c, inv, 1.0)
    rng = np.random.default_rng(seed)
    draws = np.empty(resamples)
    for r in range(resamples):
        pick = rng.integers(0, len(uk), len(uk))
        draws[r] = s[pick].sum() / c[pick].sum() * 100
    lo, hi = np.percentile(draws, [2.5, 97.5])
    return [round(float(lo), 2), round(float(hi), 2)]


def pair_table(d, a, b, arms):
    """arms: name -> (pred_a, pred_b). Paired comparison of the second arm
    against the first, per true-gap bucket."""
    y_a = d['y'].to_numpy()[a]
    y_b = d['y'].to_numpy()[b]
    gap = np.abs(y_b - y_a)
    venue = d['venue_id'].to_numpy()[a]
    date = d['date'].to_numpy()[a]
    names = list(arms)
    out = {}
    for label, lo, hi in BUCKETS:
        m = (gap >= lo) & (gap <= hi)
        row = {'pairs': int(m.sum())}
        conc = {}
        for name in names:
            pa, pb = arms[name]
            k = concord(y_a[m], y_b[m], pa[m], pb[m])
            conc[name] = k
            row[name] = round(float(k.mean() * 100), 2)
            row[name + '_pred_ties_pct'] = round(float((np.sign(pb[m] - pa[m]) == 0).mean() * 100), 2)
        if len(names) == 2:
            diff = conc[names[1]] - conc[names[0]]
            row['diff'] = round(float(diff.mean() * 100), 2)
            row['ci95_venue'] = block_ci(venue[m], diff)
            row['ci95_date'] = block_ci(date[m], diff)
        out[label] = row
    return out


def recommendation(d, now_pred, later_pred_fn, gap=MIN_GAP):
    """At each hour with later hours that night: argmin of the later hours on
    later_pred_fn(now_index, later_indices); speak iff it is more than `gap`
    below now_pred[now]. Returns totals and per-row outcomes for the
    bootstrap."""
    y = d['y'].to_numpy()
    rows = []
    for _, idx in d.groupby(['venue_id', 'date'], sort=False).indices.items():
        for k in range(len(idx) - 1):
            i = idx[k]
            later = idx[k + 1:]
            p = later_pred_fn(i, later)
            mn = p.min()
            spoke = mn < now_pred[i] - gap
            if not spoke:
                rows.append((i, 0, 0.0, 0.0, 0.0))
                continue
            cand = later[p == mn]
            dy = y[i] - y[cand]
            rows.append((i, 1, float(np.mean(dy > 0)), float(np.mean(dy < 0)), float(np.mean(dy))))
    r = np.array(rows)
    return r


def summarize_rec(r):
    spoke = r[:, 1].sum()
    ok = r[:, 2].sum()
    bad = r[:, 3].sum()
    return {
        'decisions': int(len(r)),
        'spoke': int(spoke),
        'coverage_pct': round(float(spoke / len(r) * 100), 2),
        'correct_pct': round(float(ok / (ok + bad) * 100), 2) if ok + bad else None,
        'backwards_pct': round(float(bad / (ok + bad) * 100), 2) if ok + bad else None,
        'points_saved_when_spoken': round(float(r[:, 4].sum() / spoke), 2) if spoke else None,
    }


def rec_diff_ci(d, ra, rb, key, resamples=RESAMPLES, seed=SEED):
    """Block bootstrap of correct% (B minus A), each side over its own spoken
    decisions, blocks drawn once per resample for both."""
    keys = d[key].to_numpy()[ra[:, 0].astype(int)]
    uk, inv = np.unique(keys, return_inverse=True)

    def sums(r):
        ok = np.zeros(len(uk))
        bad = np.zeros(len(uk))
        np.add.at(ok, inv, r[:, 2])
        np.add.at(bad, inv, r[:, 3])
        return ok, bad
    a_ok, a_bad = sums(ra)
    b_ok, b_bad = sums(rb)
    rng = np.random.default_rng(seed)
    draws = np.empty(resamples)
    for t in range(resamples):
        p = rng.integers(0, len(uk), len(uk))
        draws[t] = (b_ok[p].sum() / (b_ok[p].sum() + b_bad[p].sum())
                    - a_ok[p].sum() / (a_ok[p].sum() + a_bad[p].sum())) * 100
    lo, hi = np.percentile(draws, [2.5, 97.5])
    return [round(float(lo), 2), round(float(hi), 2)]


def main():
    path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else None
    d = load(path)
    a, b = pairs(d)
    curve = d['curve'].to_numpy()
    shift = d['shift'].to_numpy()
    dial = d['dial'].to_numpy()
    co_row = d['co'].to_numpy()
    # The night's first scored hour's shift, for every hour of that night.
    first_shift = d.groupby(['venue_id', 'date'])['shift'].transform('first').to_numpy()
    night_co = np.clip(curve + first_shift, 0, 100)

    res = {
        'population': {
            'rows': int(len(d)), 'venue_nights': int(d.groupby(['venue_id', 'date']).ngroups),
            'pairs': int(len(a)), 'dates': [str(d['date'].min()), str(d['date'].max())],
            'hours_per_night': {k: round(float(v), 2) for k, v in d.groupby(['venue_id', 'date']).size().describe().items()},
        },
    }
    res['arm_a_both_from_before_the_night'] = pair_table(d, a, b, {
        'curve': (curve[a], curve[b]),
        'curve_offset': (night_co[a], night_co[b]),
    })
    res['arm_a_reference_each_hour_as_served_when_it_arrives'] = pair_table(d, a, b, {
        'curve': (curve[a], curve[b]),
        'served_per_row': (co_row[a], co_row[b]),
    })
    # Now (a) versus later (b): later hours carry the offset known at now.
    later_co = np.clip(curve[b] + shift[a], 0, 100)
    res['arm_n_now_versus_later'] = pair_table(d, a, b, {
        'curve': (curve[a], curve[b]),
        'served_now': (dial[a], later_co),
    })
    res['arm_n_reference_now_curve_offset_both_sides'] = pair_table(d, a, b, {
        'curve': (curve[a], curve[b]),
        'curve_offset_now': (co_row[a], later_co),
    })

    rec_curve = recommendation(d, curve, lambda i, later: curve[later])
    rec_served = recommendation(d, dial, lambda i, later: np.clip(curve[later] + shift[i], 0, 100))
    rec = {'shipped_curve': summarize_rec(rec_curve), 'served_now': summarize_rec(rec_served)}
    rec['served_minus_shipped_correct_pct'] = {
        'diff': round(rec['served_now']['correct_pct'] - rec['shipped_curve']['correct_pct'], 2),
        'ci95_venue': rec_diff_ci(d, rec_curve, rec_served, 'venue_id'),
        'ci95_date': rec_diff_ci(d, rec_curve, rec_served, 'date'),
    }
    res['arm_r_recommendation_later_hours_gap_10'] = rec

    text = json.dumps(res, indent=2)
    print(text)
    if out_path:
        with open(out_path, 'w', encoding='utf-8') as f:
            f.write(text)


if __name__ == '__main__':
    main()
