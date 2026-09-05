"""
Scores the SHIPPED artifact and the two-head CANDIDATE on the identical served
holdout, prints one table, and decides go or no-go against Jayden's conditions.

WHAT IS COMPARED, AND HOW. Both sides are read from their ONNX files with
onnxruntime, the way the backend reads them. Not from best_model.pkl, not from
a freshly trained stand-in: a research pass on 2026-09-04 trained a fresh delta
regressor on features_holdout.pkl, called it "CURRENT", and concluded the
shipped model lost to the untouched curve. MODEL-METRICS.md records the
correction. The shipped side here is models/crowd_model.onnx, and this script
proves it is scoring the right thing by reproducing the artifact's own gate
number (ship_gate.incumbent.new_realtime_mae, 29.4191 on the 2026-08-18 rows)
to four decimals before any candidate number is printed.

THE ROWS. features_holdout.pkl rows with is_realtime == 1 AND baseline > 0,
which is quick_eval.py's gate slice and the population production scores with
the model (serving_population_mask, imported from prepare_features, never
re-implemented). 67,249 rows on the 2026-08-30 pickles.

THE RECONSTRUCTIONS. Shipped: quick_eval.reconstruct, which is
mlPredictor.reconstructScore in Python (clamp +-50, one-point extremes push,
0..100, rounded) with the score quantile map OFF. It is off on purpose and
for both sides: the map is a table fitted to v2.6.0's output distribution,
mlPredictor refuses to apply it to any other model_version, so a candidate
could never be served through it, and comparing a mapped incumbent to an
unmapped challenger would be comparing two products. The mapped number is
printed as a third row, labelled, because it is what production publishes
today. Candidate: train_two_head.reconstruct_two_head, rounded, which is
mlPredictor.reconstructTwoHeadScore.

THE METRICS. The MODEL-METRICS.md band table: band exact, band off-by-one and
band MAE on the ladder crowdEngine cuts at (Quiet <= 20, Not Busy <= 39,
Steady <= 69, Busy <= 84, Packed), plus point MAE, within-10 and within-15.
R2, within-20 and the prediction spread ride along as context. Deltas are
candidate minus shipped, with a 2000-resample date-block bootstrap for the
three that decide the verdict, the same block structure GATE-B uses.

THE VERDICT. The candidate ships only if within-15 AND point MAE both beat the
shipped model on this population, and band exact does not get worse. Anything
else is NO-GO, and the script says so with the numbers. The result is written
into models/candidate/model_metadata.json as ship_gate (overall_pass is the
verdict), which is the key mlPredictor.init() reads, and the whole table goes
to models/candidate/eval_two_head.json.

FLOCK_CORPUS_LABEL names the corpus the numbers describe (PRE-MERGE for the
2026-08-30 pickles, before the 933 duplicate venue groups are merged) and is
printed on every line of the verdict so a number cannot be quoted without it.
"""

import json
import logging
import os
import pickle
from datetime import datetime, timezone
from pathlib import Path

# quick_eval reads CROWD_QMAP_ENABLED at import time. It is forced off here,
# before that import, for the reason the header gives: the map belongs to one
# artifact and neither side of this comparison is served through it.
os.environ['CROWD_QMAP_ENABLED'] = 'false'

import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402

from prepare_features import serving_population_mask  # noqa: E402
from quick_eval import metrics as gate_metrics, reconstruct as gate_reconstruct  # noqa: E402
from quick_eval import apply_score_qmap, realtime_flags  # noqa: E402
from train_two_head import (BASELINE_FEATURE, PROFILE_FEATURE, build_matrix,  # noqa: E402
                            reconstruct_two_head)
from export_model import write_atomic  # noqa: E402

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

SCRIPT_DIR = Path(__file__).parent
MODELS_DIR = SCRIPT_DIR.parent / 'models'
CANDIDATE_DIR = Path(os.environ.get('FLOCK_TWO_HEAD_DIR', '').strip() or (MODELS_DIR / 'candidate'))
CORPUS_LABEL = os.environ.get('FLOCK_CORPUS_LABEL', '').strip() or 'UNLABELLED (set FLOCK_CORPUS_LABEL)'
LIVE_HOLDOUT_FILE = 'live_holdout.pkl'

# crowdEngine.getLabel's ladder, re-cut 2026-08-28: a score lands in band k
# when it exceeds k of these. Integer scores, so <= 20 is band 0 and 21 is
# band 1, exactly as the JS reads it.
BAND_CUTS = (20, 39, 69, 84)
BAND_NAMES = ('Quiet', 'Not Busy', 'Steady', 'Busy', 'Packed')
BOOTSTRAP_RESAMPLES = 2000
BOOTSTRAP_SEED = 26
CHUNK = 50000


def band_of(score) -> np.ndarray:
    s = np.asarray(score, dtype=np.float64)
    out = np.zeros(len(s), dtype=np.int64)
    for cut in BAND_CUTS:
        out += (s > cut)
    return out


def row_metrics(y_true, pred) -> dict:
    """quick_eval.metrics plus the band ladder plus the spread."""
    p = np.clip(np.asarray(pred, dtype=np.float64), 0, 100)
    y = np.asarray(y_true, dtype=np.float64)
    bt, bp = band_of(y), band_of(p)
    bd = np.abs(bt - bp)
    out = gate_metrics(y, p)
    out.update({
        'band_exact': round(float(np.mean(bd == 0) * 100), 2),
        'band_off_by_one': round(float(np.mean(bd <= 1) * 100), 2),
        'band_mae': round(float(bd.mean()), 4),
        'pred_sd': round(float(p.std()), 2),
        'rows': int(len(y)),
    })
    return out


def bootstrap_deltas(dates, y_true, cand, ship, n_resamples=BOOTSTRAP_RESAMPLES,
                     seed=BOOTSTRAP_SEED) -> dict:
    """CI for candidate minus shipped on the three verdict metrics, resampling
    observation DATES with replacement so a day's weather and event shocks
    stay together inside each resample (quick_eval.date_block_bootstrap)."""
    dates = np.asarray(dates)
    uniq = np.unique(dates[dates != ''])
    if len(uniq) < 5:
        return None
    idx_by_date = {d: np.where(dates == d)[0] for d in uniq}
    rng = np.random.default_rng(seed)
    y = np.asarray(y_true, dtype=np.float64)
    bc, bs = band_of(cand), band_of(ship)
    mae = np.empty(n_resamples)
    w15 = np.empty(n_resamples)
    w10 = np.empty(n_resamples)
    bex = np.empty(n_resamples)
    for i in range(n_resamples):
        take = rng.choice(uniq, size=len(uniq), replace=True)
        rows = np.concatenate([idx_by_date[d] for d in take])
        ec = np.abs(y[rows] - cand[rows])
        es = np.abs(y[rows] - ship[rows])
        mae[i] = ec.mean() - es.mean()
        w15[i] = (np.mean(ec <= 15) - np.mean(es <= 15)) * 100
        w10[i] = (np.mean(ec <= 10) - np.mean(es <= 10)) * 100
        bex[i] = (np.mean(bc[rows] == band_of(y[rows])) - np.mean(bs[rows] == band_of(y[rows]))) * 100

    def ci(a, nd):
        return [round(float(np.percentile(a, 2.5)), nd), round(float(np.percentile(a, 97.5)), nd)]
    return {'mae_delta_ci': ci(mae, 3), 'within_15_delta_ci': ci(w15, 2),
            'within_10_delta_ci': ci(w10, 2), 'band_exact_delta_ci': ci(bex, 2),
            'resamples': n_resamples, 'date_blocks': int(len(uniq)),
            'rows_with_date': int((dates != '').sum())}


def run_session(path: Path, M: np.ndarray, expect_width: int) -> tuple:
    session = ort.InferenceSession(str(path))
    inputs = session.get_inputs()
    if len(inputs) != 1:
        raise SystemExit(f'{path.name} takes {len(inputs)} inputs; the serving path feeds one')
    shape = list(inputs[0].shape or [])
    width = shape[-1] if shape else None
    if isinstance(width, int) and width != expect_width:
        raise SystemExit(f'{path.name} takes {width} features but its metadata lists '
                         f'{expect_width}; the .onnx and the .json are from different runs')
    if M.shape[1] != expect_width:
        raise SystemExit(f'built a {M.shape[1]}-wide matrix for a {expect_width}-wide graph')
    name = inputs[0].name
    out = np.concatenate([
        np.asarray(session.run(None, {name: M[i:i + CHUNK]})[0], dtype=np.float64).reshape(-1)
        for i in range(0, len(M), CHUNK)])
    if not np.isfinite(out).all():
        raise SystemExit(f'{path.name} emitted {int((~np.isfinite(out)).sum())} non-finite outputs')
    return out, name


ONE_HOT_PREFIXES = ('gtype_', 'etype_', 'weather_', 'season_')
GOOGLE_TYPE_COLS = ('google_type_1', 'google_type_2', 'google_type_3')


def rebuild_gtype_levels(absent, csv_path: Path, y_actual, baseline) -> dict:
    """A gtype_* level the shipped model consumes that the current top-30 list
    dropped (the post-merge corpus swapped bakery for night_club). The one-hot
    is a fact about the venue's raw Google types, which the export CSV still
    carries, so it is rebuilt from there rather than zero-filled against the
    incumbent. Row alignment is proved, not assumed: the CSV rows with a label
    must match the pickle one for one on busyness_pct and on baseline > 0."""
    wanted = [c for c in absent if c.startswith('gtype_')]
    if not wanted or not csv_path.exists():
        return {}
    import pandas as pd
    csv = pd.read_csv(csv_path, usecols=['busyness_pct', 'baseline_busyness', *GOOGLE_TYPE_COLS],
                      dtype={c: 'string' for c in GOOGLE_TYPE_COLS})
    csv = csv[csv['busyness_pct'].notna()].reset_index(drop=True)
    if len(csv) != len(y_actual):
        logger.warning('%s holds %d labelled rows, the pickle %d; cannot rebuild %s from it',
                       csv_path.name, len(csv), len(y_actual), wanted)
        return {}
    if not np.array_equal(csv['busyness_pct'].to_numpy(dtype=np.float64), np.asarray(y_actual, dtype=np.float64)):
        logger.warning('%s rows are not in the pickle\'s order (busyness_pct differs); cannot '
                       'rebuild %s from it', csv_path.name, wanted)
        return {}
    raw_pos = csv['baseline_busyness'].fillna(0).to_numpy(dtype=np.float64) > 0
    if not np.array_equal(raw_pos, np.asarray(baseline, dtype=np.float64) > 0):
        logger.warning('%s baseline > 0 pattern differs from the pickle; cannot rebuild %s',
                       csv_path.name, wanted)
        return {}
    out = {}
    for name in wanted:
        level = name[len('gtype_'):]
        hit = np.zeros(len(csv), dtype=bool)
        for col in GOOGLE_TYPE_COLS:
            hit |= (csv[col].fillna('') == level).to_numpy()
        out[name] = hit.astype(np.float32)
        logger.info('rebuilt %s from %s raw google types: set on %d of %d rows (%.2f%%)',
                    name, csv_path.name, int(hit.sum()), len(hit), hit.mean() * 100)
    return out


def select_by_name(names, X, feature_cols, baseline=None, profile_pred=None,
                   rebuilt=None, zero_filled=None) -> np.ndarray:
    """One model's matrix by NAME. A name the pickle lacks is taken from
    `rebuilt` when it was recovered from the raw export, zero-filled when it
    is a one-hot level (and recorded in `zero_filled`), and refused otherwise."""
    rebuilt = rebuilt or {}
    overrides = dict(rebuilt)
    absent = [c for c in names if c not in feature_cols and c not in (BASELINE_FEATURE, PROFILE_FEATURE)
              and c not in rebuilt]
    hard = [c for c in absent if not c.startswith(ONE_HOT_PREFIXES)]
    if hard:
        raise SystemExit(
            f'features_holdout.pkl does not carry {hard}. The holdout was prepared by a '
            'different prepare_features.py run than the model expects and these are not '
            'one-hot levels that can be absent; re-run the pipeline from the export.')
    for c in absent:
        overrides[c] = np.zeros(len(X), dtype=np.float32)
        if zero_filled is not None:
            zero_filled.append(c)
    rows = np.arange(len(X))
    return build_matrix(names, rows, X, feature_cols, baseline, profile_pred_rows=profile_pred,
                        overrides=overrides)


def score_before_qmap(raw_delta, baseline) -> np.ndarray:
    """mlPredictor.reconstructScore up to (not including) the rounding, so the
    quantile map can be applied where production applies it. Cross-checked
    below against quick_eval.reconstruct so the two copies cannot drift."""
    score = np.clip(baseline + np.clip(raw_delta, -50, 50), 0, 100)
    score = np.where(score < 25, score - 1, np.where(score > 65, score + 1, score))
    return np.clip(score, 0, 100)


def fmt_row(label, m) -> str:
    return (f'{label:52s} {m["band_exact"]:7.2f}% {m["band_off_by_one"]:8.2f}% '
            f'{m["band_mae"]:8.4f} {m["mae"]:8.4f} {m["within_10"]:7.1f}% '
            f'{m["within_15"]:7.1f}% {m["within_20"]:7.1f}% {m["r2"]:7.4f} {m["pred_sd"]:6.2f}')


def score_both(Xrows, feature_cols, baseline, ship_meta, cand_meta, rebuilt=None,
               zero_filled=None) -> tuple:
    """Shipped raw delta and candidate (profile, deviation) on one row set."""
    ship_names = list(ship_meta['feature_names'])
    Ms = select_by_name(ship_names, Xrows, feature_cols, rebuilt=rebuilt, zero_filled=zero_filled)
    ship_raw, _ = run_session(MODELS_DIR / 'crowd_model.onnx', Ms, len(ship_names))
    del Ms
    th = cand_meta['two_head']
    p_names = list(th['profile']['feature_names'])
    d_names = list(th['deviation']['feature_names'])
    Mp = select_by_name(p_names, Xrows, feature_cols, baseline=baseline.astype(np.float32))
    profile, _ = run_session(CANDIDATE_DIR / th['profile']['file'], Mp, len(p_names))
    del Mp
    Md = select_by_name(d_names, Xrows, feature_cols, baseline=baseline.astype(np.float32),
                        profile_pred=profile.astype(np.float32))
    deviation, _ = run_session(CANDIDATE_DIR / th['deviation']['file'], Md, len(d_names))
    del Md
    return ship_raw, profile, deviation


def live_forward_slice(ship_meta, cand_meta, clamp) -> dict:
    """Both artifacts on the proven-live rows train_two_head held out of every
    training set: the only rows in the corpus whose label is known to be a
    room. A diagnostic beside the gate, never the gate: small, PA only, and
    the shipped model was not trained on them either."""
    p = CANDIDATE_DIR / LIVE_HOLDOUT_FILE
    if not p.exists():
        return None
    with open(p, 'rb') as f:
        lh = pickle.load(f)
    y = np.asarray(lh['y_actual'], dtype=np.float64)
    b = np.asarray(lh['baseline'], dtype=np.float64)
    X = lh['X']
    fc = list(lh['feature_cols'])
    n = len(y)
    if n < 50:
        return {'rows': n, 'note': 'fewer than 50 proven-live rows held out; not measured'}
    # These rows are a subset of the training pickle, whose raw google types
    # are not recoverable by position, so a shipped one-hot level the current
    # top-30 dropped is zero-filled here and said so. A diagnostic slice, and
    # the zero fill can only cost the shipped model, never the candidate.
    zero_filled = []
    ship_raw, profile, deviation = score_both(X, fc, b, ship_meta, cand_meta, zero_filled=zero_filled)
    if zero_filled:
        logger.warning('live forward slice: shipped features %s are not in the training pickle '
                       'and were zero-filled for the shipped model on these rows', zero_filled)
    ship = gate_reconstruct(ship_raw, b)
    cand = reconstruct_two_head(profile, deviation, clamp, rounded=True)
    rows = {
        'curve': ('publish the venue\'s curve untouched', row_metrics(y, np.clip(b, 0, 100))),
        'shipped': (f'shipped v{ship_meta.get("model_version")} (clamp +-50, push, unmapped)',
                    row_metrics(y, ship)),
        'candidate': (f'candidate v{cand_meta.get("model_version")} (profile + clamp(deviation))',
                      row_metrics(y, cand)),
    }
    s, c = rows['shipped'][1], rows['candidate'][1]
    deltas = {k: round(c[k] - s[k], 4) for k in ('band_exact', 'band_off_by_one', 'band_mae',
                                                  'mae', 'within_10', 'within_15', 'within_20', 'r2')}
    ci = bootstrap_deltas(np.asarray(lh['observed_date']).astype(str), y, cand, ship)
    cities = np.asarray(lh['cities']).astype(str)
    print()
    print(f'=== PROVEN-LIVE FORWARD SLICE (diagnostic, not the gate): {n:,} rows with '
          f'label_provenance live on {lh.get("dates_held")}, cities '
          f'{dict(zip(*np.unique(cities, return_counts=True)))}, held out of all training ===')
    print(HEADER)
    for key in ('curve', 'shipped', 'candidate'):
        print(fmt_row(*rows[key]))
    print(f'  candidate minus shipped: band exact {deltas["band_exact"]:+.2f}pp   point MAE '
          f'{deltas["mae"]:+.4f}   within-10 {deltas["within_10"]:+.2f}pp   within-15 '
          f'{deltas["within_15"]:+.2f}pp')
    if ci:
        print(f'  95% CI over {ci["date_blocks"]} date blocks: MAE {ci["mae_delta_ci"]}  '
              f'within-15 {ci["within_15_delta_ci"]}pp  band exact {ci["band_exact_delta_ci"]}pp')
    else:
        print('  no bootstrap: fewer than 5 observation dates in the slice')
    return {'rows': n, 'dates': lh.get('dates_held'),
            'cities': {str(k): int(v) for k, v in zip(*np.unique(cities, return_counts=True))},
            'curve_untouched': rows['curve'][1], 'shipped': s, 'candidate': c,
            'deltas_candidate_minus_shipped': deltas, 'bootstrap': ci}


HEADER = (f'{"candidate":52s} {"band ex":>8s} {"off-by-1":>9s} {"band MAE":>8s} '
          f'{"pt MAE":>8s} {"w10":>8s} {"w15":>8s} {"w20":>8s} {"R2":>7s} {"sd":>6s}')


def main():
    logger.info('corpus: %s', CORPUS_LABEL)
    with open(SCRIPT_DIR / 'features_holdout.pkl', 'rb') as f:
        hold = pickle.load(f)
    X = hold['X']
    feature_cols = list(hold['feature_cols'])
    y_actual = np.asarray(hold['y_actual'], dtype=np.float64)
    baseline = np.asarray(hold['baseline'], dtype=np.float64)
    cities = np.asarray(hold['cities']).astype(str)
    dates = np.asarray(hold.get('observed_date', np.array([''] * len(y_actual)))).astype(str)
    is_rt = realtime_flags(X, feature_cols, len(y_actual)) == 1
    gate = is_rt & serving_population_mask(baseline)
    n_gate = int(gate.sum())
    hold_prov = np.asarray(hold.get('label_provenance', np.array(['unknown'] * len(y_actual)))).astype(str)
    gate_prov = {str(k): int(v) for k, v in zip(*np.unique(hold_prov[gate], return_counts=True))}
    logger.info('holdout %d rows, %d realtime, %d on the gate slice (realtime AND '
                'baseline > 0), %d realtime rows excluded for baseline == 0; gate slice '
                'label provenance: %s', len(y_actual), int(is_rt.sum()), n_gate,
                int((is_rt & ~gate).sum()), gate_prov)
    if gate_prov.get('live', 0) == 0:
        logger.warning('the gate slice holds NO row whose label is a proven live reading: '
                       'every realtime holdout row is from the window migration 025 calls '
                       'unrecoverable. Both models are scored on those rows because they '
                       'are the served population the shipped gate was measured on; the '
                       'proven-live forward slice below is the only clean-label comparison.')
    if n_gate < 100:
        raise SystemExit('fewer than 100 servable realtime holdout rows; nothing honest to measure')
    y = y_actual[gate]
    b = baseline[gate]
    Xg = X[gate]
    dates_g = dates[gate]
    cities_g = cities[gate]

    # ---- the shipped artifact, read from disk exactly as the backend reads it
    with open(MODELS_DIR / 'model_metadata.json', 'r', encoding='utf-8') as f:
        ship_meta = json.load(f)
    ship_names = list(ship_meta['feature_names'])
    if ship_meta.get('label_type') != 'delta':
        raise SystemExit(f'models/model_metadata.json is label_type {ship_meta.get("label_type")!r}; '
                         'this script scores the shipped DELTA artifact as the incumbent')
    absent = [c for c in ship_names if c not in feature_cols]
    rebuilt_all = rebuild_gtype_levels(absent, SCRIPT_DIR / 'holdout_data.csv', y_actual, baseline)
    rebuilt = {k: v[gate] for k, v in rebuilt_all.items()}
    zero_filled = []
    Ms = select_by_name(ship_names, Xg, feature_cols, rebuilt=rebuilt, zero_filled=zero_filled)
    if zero_filled:
        logger.warning('shipped features %s are absent from the holdout pickle and could not be '
                       'rebuilt; zero-filled for the shipped model', zero_filled)
    ship_raw, _ = run_session(MODELS_DIR / 'crowd_model.onnx', Ms, len(ship_names))
    del Ms
    ship_scores = gate_reconstruct(ship_raw, b)
    if ship_scores.dtype != np.float64:
        ship_scores = ship_scores.astype(np.float64)
    feature_vocab = {'shipped_absent_from_pickle': absent, 'rebuilt_from_csv': sorted(rebuilt),
                     'zero_filled': zero_filled}
    pre = score_before_qmap(ship_raw, b)
    if not np.array_equal(np.round(pre), ship_scores):
        raise SystemExit('score_before_qmap and quick_eval.reconstruct disagree; the two '
                         'copies of the serve arithmetic have drifted')
    ship_mapped = np.round(apply_score_qmap(pre))
    curve = np.clip(b, 0, 100)

    # Reproduction check: the artifact's own gate figure, the metadata clamp
    # (+-30), unrounded, which is how ship_gate.incumbent.new_realtime_mae
    # was measured on 2026-08-18.
    mae30 = float(np.mean(np.abs(y - np.clip(b + np.clip(ship_raw, -30, 30), 0, 100))))
    recorded = ((ship_meta.get('ship_gate') or {}).get('incumbent') or {}).get('new_realtime_mae')
    recorded_rows = (ship_meta.get('ship_gate') or {}).get('realtime_rows')
    same_rows = recorded_rows == n_gate
    logger.info('reproduction: shipped v%s scores MAE %.4f at the metadata clamp on %d rows; '
                'its ship_gate recorded %s on %s rows (%s)', ship_meta.get('model_version'),
                mae30, n_gate, recorded, recorded_rows,
                'IDENTICAL ROWS, matches to 4 decimals' if same_rows and recorded is not None
                and abs(mae30 - float(recorded)) < 5e-4
                else ('same row count but the figure moved: the holdout features are not '
                      'the ones the gate was measured on' if same_rows
                      else 'different rows (a re-exported holdout), so no reproduction is expected'))
    reproduction = {'shipped_mae_metadata_clamp_unrounded': round(mae30, 4),
                    'recorded_new_realtime_mae': recorded, 'recorded_rows': recorded_rows,
                    'gate_rows': n_gate, 'identical_rows': bool(same_rows)}

    # ---- the candidate
    cand_meta_path = CANDIDATE_DIR / 'model_metadata.json'
    with open(cand_meta_path, 'r', encoding='utf-8') as f:
        cand_meta = json.load(f)
    if cand_meta.get('label_type') != 'two_head' or not isinstance(cand_meta.get('two_head'), dict):
        raise SystemExit(f'{cand_meta_path} is not a two_head candidate')
    th = cand_meta['two_head']
    clamp = tuple(float(v) for v in th['deviation_clamp'])
    p_names = list(th['profile']['feature_names'])
    d_names = list(th['deviation']['feature_names'])
    Mp = select_by_name(p_names, Xg, feature_cols, baseline=b)
    profile, _ = run_session(CANDIDATE_DIR / th['profile']['file'], Mp, len(p_names))
    del Mp
    Md = select_by_name(d_names, Xg, feature_cols, baseline=b, profile_pred=profile.astype(np.float32))
    deviation, _ = run_session(CANDIDATE_DIR / th['deviation']['file'], Md, len(d_names))
    del Md
    cand_scores = reconstruct_two_head(profile, deviation, clamp, rounded=True)
    cand_profile_only = np.round(np.clip(profile, 0, 100))
    cand_dev_on_curve = np.round(np.clip(b + np.clip(deviation, clamp[0], clamp[1]), 0, 100))
    cand_version = cand_meta.get('model_version', '?')

    rows = {
        'curve': ('publish the venue\'s curve untouched', row_metrics(y, curve)),
        'shipped': (f'shipped v{ship_meta.get("model_version")} (clamp +-50, push, unmapped)',
                    row_metrics(y, ship_scores)),
        'shipped_qmap': (f'shipped v{ship_meta.get("model_version")} + score qmap (published today)',
                         row_metrics(y, ship_mapped)),
        'candidate': (f'candidate v{cand_version} (profile + clamp(deviation))',
                      row_metrics(y, cand_scores)),
        'candidate_profile_only': ('  candidate profile head alone (deviation = 0)',
                                   row_metrics(y, cand_profile_only)),
        'candidate_dev_on_curve': ('  candidate deviation on the stored curve instead',
                                   row_metrics(y, cand_dev_on_curve)),
    }
    ship = rows['shipped'][1]
    cand = rows['candidate'][1]
    keys = ['band_exact', 'band_off_by_one', 'band_mae', 'mae', 'within_10', 'within_15',
            'within_20', 'r2', 'pred_sd']
    deltas = {k: round(cand[k] - ship[k], 4) for k in keys}
    ci = bootstrap_deltas(dates_g, y, cand_scores, ship_scores)

    print()
    print(f'=== SERVED HOLDOUT, {n_gate:,} rows (realtime AND baseline > 0), corpus {CORPUS_LABEL} ===')
    print(HEADER)
    for key in ('curve', 'shipped', 'shipped_qmap', 'candidate', 'candidate_profile_only',
                'candidate_dev_on_curve'):
        print(fmt_row(*rows[key]))
    print()
    print('candidate minus shipped (unmapped):')
    print(f'  band exact {deltas["band_exact"]:+.2f}pp   off-by-one {deltas["band_off_by_one"]:+.2f}pp   '
          f'band MAE {deltas["band_mae"]:+.4f}   point MAE {deltas["mae"]:+.4f}   '
          f'within-10 {deltas["within_10"]:+.2f}pp   within-15 {deltas["within_15"]:+.2f}pp   '
          f'within-20 {deltas["within_20"]:+.2f}pp   R2 {deltas["r2"]:+.4f}')
    if ci:
        print(f'  95% CI, {ci["resamples"]} date-block resamples over {ci["date_blocks"]} dates: '
              f'MAE {ci["mae_delta_ci"]}  within-15 {ci["within_15_delta_ci"]}pp  '
              f'within-10 {ci["within_10_delta_ci"]}pp  band exact {ci["band_exact_delta_ci"]}pp')
    else:
        print('  no bootstrap: the holdout carries fewer than 5 observation dates')

    per_city = {}
    print()
    print(f'{"city":10s} {"rows":>7s} | {"shipped MAE":>11s} {"w15":>6s} {"band":>6s} | '
          f'{"cand MAE":>9s} {"w15":>6s} {"band":>6s} | {"d MAE":>7s} {"d w15":>7s}')
    for city in np.unique(cities_g):
        m = cities_g == city
        if int(m.sum()) < 50:
            continue
        sm = row_metrics(y[m], ship_scores[m])
        cm = row_metrics(y[m], cand_scores[m])
        per_city[str(city)] = {'rows': int(m.sum()), 'shipped': sm, 'candidate': cm}
        print(f'{city:10s} {int(m.sum()):7d} | {sm["mae"]:11.3f} {sm["within_15"]:5.1f}% '
              f'{sm["band_exact"]:5.1f}% | {cm["mae"]:9.3f} {cm["within_15"]:5.1f}% '
              f'{cm["band_exact"]:5.1f}% | {cm["mae"] - sm["mae"]:+7.3f} '
              f'{cm["within_15"] - sm["within_15"]:+6.1f}pp')

    live_slice = live_forward_slice(ship_meta, cand_meta, clamp)

    # ---- the verdict
    policy = ((th.get('deviation') or {}).get('provenance_policy')) or 'unrecorded'
    w15_better = cand['within_15'] > ship['within_15']
    mae_better = cand['mae'] < ship['mae']
    band_not_worse = cand['band_exact'] >= ship['band_exact']
    go = bool(w15_better and mae_better and band_not_worse)
    clearly = bool(go and ci and ci['mae_delta_ci'][1] < 0 and ci['within_15_delta_ci'][0] > 0)
    print()
    print(f'=== GO / NO-GO, corpus {CORPUS_LABEL}, deviation labels: {policy} ===')
    print(f'  within-15 beats shipped:  {cand["within_15"]:.1f}% vs {ship["within_15"]:.1f}%  '
          f'-> {"PASS" if w15_better else "FAIL"}')
    print(f'  point MAE beats shipped:  {cand["mae"]:.4f} vs {ship["mae"]:.4f}  '
          f'-> {"PASS" if mae_better else "FAIL"}')
    print(f'  band exact not worse:     {cand["band_exact"]:.2f}% vs {ship["band_exact"]:.2f}%  '
          f'-> {"PASS" if band_not_worse else "FAIL"}')
    if go:
        print(f'  VERDICT: GO. {"Both CI bounds exclude zero, so the margin is real at this "
                                "holdout size." if clearly else "The point estimates pass but "
                                "at least one 95% CI includes zero: not clearly worth it at "
                                "this holdout size."}')
    else:
        print('  VERDICT: NO-GO. The candidate does not beat the shipped artifact on the '
              'served population under Jayden\'s conditions. Do not ship it.')

    verdict = {
        'overall_pass': go,
        'gate_basis': 'holdout_realtime_served_vs_shipped_onnx',
        'verdict': 'ship' if go else 'do_not_ship',
        'clearly_worth_it': clearly,
        'corpus': CORPUS_LABEL,
        'deviation_label_policy': policy,
        'clean_labels': bool((th.get('deviation') or {}).get('clean_labels', False)),
        'gate_slice_label_provenance': gate_prov,
        'shipped_feature_vocabulary': feature_vocab,
        'live_forward_slice': live_slice,
        'evaluated_at': datetime.now(timezone.utc).isoformat(),
        'realtime_rows': n_gate,
        'excluded_no_baseline_rows': int((is_rt & ~gate).sum()),
        'criteria': 'ships only if within-15 AND point MAE both beat the shipped artifact on '
                    'the served holdout (realtime AND baseline > 0), and band exact on the '
                    'crowdEngine ladder (20/39/69/84) does not get worse; both sides read '
                    'from ONNX with onnxruntime, shipped reconstructed as mlPredictor.'
                    'reconstructScore with the score qmap off, candidate as '
                    'reconstructTwoHeadScore',
        'shipped_version': ship_meta.get('model_version'),
        'shipped': ship,
        'shipped_with_qmap': rows['shipped_qmap'][1],
        'curve_untouched': rows['curve'][1],
        'candidate': cand,
        'candidate_profile_only': rows['candidate_profile_only'][1],
        'candidate_deviation_on_stored_curve': rows['candidate_dev_on_curve'][1],
        'deltas_candidate_minus_shipped': deltas,
        'bootstrap': ci,
        'per_city': per_city,
        'reproduction': reproduction,
        'score_qmap_enabled': False,
        'band_cuts': list(BAND_CUTS),
        'band_names': list(BAND_NAMES),
        'conditions': {'within_15_better': w15_better, 'mae_better': mae_better,
                       'band_exact_not_worse': band_not_worse},
    }
    cand_meta['ship_gate'] = verdict
    cand_meta['evaluation'] = {
        'holdout_cities': sorted(np.unique(cities_g).tolist()),
        'holdout_rows_total': int(len(y_actual)),
        'gate_rows': n_gate,
    }
    rendered = json.dumps(cand_meta, indent=2, allow_nan=False)
    write_atomic(cand_meta_path, lambda f: f.write(rendered.encode('utf-8')))
    report = json.dumps(verdict, indent=2, allow_nan=False)
    write_atomic(CANDIDATE_DIR / 'eval_two_head.json', lambda f: f.write(report.encode('utf-8')))
    logger.info('wrote ship_gate (overall_pass=%s) into %s and the table to %s', go,
                cand_meta_path, CANDIDATE_DIR / 'eval_two_head.json')


if __name__ == '__main__':
    main()
