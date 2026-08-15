"""
Train the XGBoost crowd model.

Leave-one-city-out (GroupKFold on `city`) cross-validation, because a venue's
rows all carry one city, so holding out a city holds out every one of its
venues. That is the only split shape in this pipeline that does not let a venue
appear on both sides.

WHAT THIS FILE REFUSES TO DO
----------------------------
The 2026-08-15 pre-retrain audit found the rest of the pipeline degrading in
silence, and `prepare_features.py` was hardened to fail loud. This script was
the last hop with no checks at all: it accepted whatever the pickle held, fit a
model, and wrote numbers into `model_metadata.json` that nothing verified. Every
guard below was written against a defect reproduced on a synthetic fixture:

  * a feature matrix that carries `baseline_busyness` (or the label, or the
    target) back in under any name — the popular_times leak the retrain doctrine
    calls THE BIG ONE. It trained happily and reported an excellent number.
  * a pickle whose `y` is not `y_actual - baseline`, while this script
    reconstructs `baseline + clamp(y_hat)` anyway. Invisible in training,
    catastrophic in serving: the server adds the model's output to a baseline.
  * `delta_clamp_range` in the metadata saying [-45, 45] while this file
    hardcoded ±30, so the reported metrics described a reconstruction
    `services/mlPredictor.js` would never perform.
  * a CV fold that leaves a row unpredicted -> NaN metrics -> `NaN` written into
    model_metadata.json, which is not valid JSON and takes the backend's model
    loader down at boot.
  * training on CUDA and reporting as if the run were reproducible. Same seed,
    same data, CPU vs GPU: predictions differ by up to 2.0 busyness points.
    `n_jobs=-1` vs `n_jobs=1` differs by 2.1. RANDOM_STATE=42 covers neither.
  * `training_metrics` published as the user-facing confidence
    (`mlPredictor.js` reads `training_metrics.within_15`) while being a blend
    dominated by weekly rows where the label EQUALS the baseline by
    construction. The slice production actually serves is reported separately
    now, next to it, with row counts.

Environment knobs (all recorded in metadata.training_environment):
  FLOCK_TRAIN_DEVICE=auto|cpu|cuda     default auto
  FLOCK_TRAIN_THREADS=<int>            default os.cpu_count()
  FLOCK_EARLY_STOPPING_ROUNDS=<int>    default 0 (off)
  FLOCK_HYPERPARAM_SEARCH=true         default off; runs the grouped search
"""

import json
import logging
import os
import pickle
import platform
import time
from pathlib import Path

import numpy as np
import sklearn
import xgboost
from sklearn.base import clone
from sklearn.model_selection import GroupKFold, RandomizedSearchCV
from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
from xgboost import XGBRegressor

# The single definition of "rows production scores with this model". Imported,
# never re-implemented: prepare_features.py filters TRAINING with it and
# quick_eval.py gates with it. A third copy here would be a third thing to drift.
from prepare_features import serving_population_mask

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

SCRIPT_DIR = Path(__file__).parent
MODELS_DIR = SCRIPT_DIR.parent / 'models'
RANDOM_STATE = 42

# Fallback only. The live value comes from model_metadata.json, which is what
# services/mlPredictor.js reads at inference (`metadata.delta_clamp_range`).
DEFAULT_DELTA_CLAMP = (-30.0, 30.0)


class LeakageError(RuntimeError):
    """A feature carries information the model must not have. Stop."""


class LabelContractError(RuntimeError):
    """The label is not the quantity the server reconstructs from. Stop."""


# ---------------------------------------------------------------------------
# Leakage guards
# ---------------------------------------------------------------------------
# get_feature_columns() in prepare_features.py excludes each of these by name and
# says why. This is the second lock: if a column ever comes back — renamed,
# re-derived, or because someone relaxed the exclude set — training refuses
# rather than producing a model with a wonderful number and no value.
FORBIDDEN_FEATURES = {
    # the label, and the target derived from it
    'busyness_pct': 'the absolute label',
    'delta_label': 'the training target',
    'y_actual': 'the absolute label',
    # the popular_times baseline. Doctrine (ml_overfitting_fixes): including it
    # lets the model score high by copying it. It is the LABEL SIDE of a delta
    # model — score = baseline + clamp(delta) — so as a feature it is the answer.
    'baseline_busyness': 'the popular_times baseline — it is the answer, not an input',
    'has_venue_baseline': 'a one-bit copy of baseline_busyness > 0',
    # provenance: encodes which label regime a row belongs to
    'sample_weight': 'the training weight — encodes the label regime',
    'label_provenance': 'encodes the label regime',
    'venue_id': 'an identifier — as a feature it is pure venue memorization',
    # geographic overfitting: lat/lng act as a city lookup table
    'latitude': 'geographic overfitting — lat/lng are a city lookup table',
    'longitude': 'geographic overfitting — lat/lng are a city lookup table',
    'lat_bin': 'geographic overfitting',
    'lng_bin': 'geographic overfitting',
}

# A column may match one of these on this fraction of rows before it is treated
# as a copy of it. Weekly rows carry delta == 0 by construction on most of the
# corpus, so a legitimately all-zero feature sits well under this.
COPY_DETECTION_THRESHOLD = 0.99
COPY_DETECTION_SAMPLE = 200_000

# quick_eval.py uses the same floor for its per-holdout-city table.
PER_CITY_MIN_ROWS = 50


def assert_no_forbidden_features(feature_cols) -> None:
    """Name-level leak guard. Cheap, exact, and it cannot be argued with."""
    hits = [(c, FORBIDDEN_FEATURES[c]) for c in feature_cols if c in FORBIDDEN_FEATURES]
    if hits:
        raise LeakageError(
            'The feature matrix carries column(s) that must never be features:\n'
            + '\n'.join(f'    {c}: {why}' for c, why in hits)
            + '\n  These are excluded by name in prepare_features.get_feature_columns(). '
              'If one is back, the exclude set was relaxed — restore it there. '
              'Do NOT relax this check to make a retrain run.'
        )


def assert_no_label_shaped_feature(X, feature_cols, probes) -> dict:
    """Value-level leak guard: catch a forbidden quantity that arrived renamed.

    The name guard above only knows the names round 10 knew. This one compares
    every feature column against the baseline, the label and the target and
    refuses any column that reproduces one of them on essentially every row —
    which is what a re-derived `baseline_busyness` looks like no matter what it
    is called. Deterministic subsample so two runs of the same data agree.
    """
    n = X.shape[0]
    if n > COPY_DETECTION_SAMPLE:
        idx = np.random.default_rng(RANDOM_STATE).choice(n, COPY_DETECTION_SAMPLE, replace=False)
        idx.sort()
    else:
        idx = np.arange(n)

    worst = {}
    offences = []
    for j, name in enumerate(feature_cols):
        col = np.asarray(X[idx, j], dtype=np.float64)
        if len(np.unique(col)) <= 1:
            # A constant column carries nothing and can leak nothing. Skipping it
            # also removes the only false-positive class here: an all-zero dead
            # slot "matches" delta_label on the ~84% of rows that are weekly
            # snapshots, where the delta is 0 by construction. prepare_features
            # already reports constant columns as DEAD SLOTS.
            continue
        for probe_name, probe in probes.items():
            share = float(np.mean(np.isclose(col, np.asarray(probe, dtype=np.float64)[idx],
                                             rtol=1e-3, atol=1e-2)))
            if share > worst.get(name, (0.0, ''))[0]:
                worst[name] = (share, probe_name)
            if share > COPY_DETECTION_THRESHOLD:
                offences.append((name, probe_name, share))
    if offences:
        raise LeakageError(
            'Feature column(s) reproduce a quantity the model must not see:\n'
            + '\n'.join(f'    {c} matches {p} on {s * 100:.2f}% of sampled rows'
                        for c, p, s in offences)
            + '\n  This is the popular_times leak from the retrain doctrine, arriving '
              'under a different column name. A delta model whose features contain the '
              'baseline is scoring itself against its own answer.'
        )
    top = sorted(((s, n_, p) for n_, (s, p) in worst.items()), reverse=True)[:3]
    logger.info('Leak scan: %d features checked against %d reference quantities; '
                'closest matches %s',
                len(feature_cols), len(probes),
                ', '.join(f'{n_}~{p} {s * 100:.1f}%' for s, n_, p in top))
    return {'features_checked': len(feature_cols),
            'sampled_rows': int(len(idx)),
            'threshold_pct': COPY_DETECTION_THRESHOLD * 100,
            'closest_match': ({'feature': top[0][1], 'reference': top[0][2],
                               'match_pct': round(top[0][0] * 100, 2)} if top else None)}


# ---------------------------------------------------------------------------
# The delta contract (must agree with services/mlPredictor.js)
# ---------------------------------------------------------------------------
def resolve_clamp(metadata: dict) -> tuple:
    """The clamp the SERVER will apply, read from the metadata the server reads.

    mlPredictor.js: `const [lo, hi] = metadata.delta_clamp_range || [-30, 30];`
    then `score = baseline + clamp(rawOutput, lo, hi)`. Hardcoding ±30 here made
    the reported metrics describe a reconstruction production would not perform
    the moment anyone edited that key.
    """
    raw = metadata.get('delta_clamp_range')
    if raw is None:
        logger.warning('model_metadata.json has no delta_clamp_range yet — using the '
                       'default %s, the same fallback mlPredictor.js uses. '
                       'export_model.py writes the key.', list(DEFAULT_DELTA_CLAMP))
        return DEFAULT_DELTA_CLAMP
    if (not isinstance(raw, (list, tuple)) or len(raw) != 2
            or not all(isinstance(v, (int, float)) and np.isfinite(v) for v in raw)
            or raw[0] >= raw[1]):
        raise LabelContractError(
            f'metadata.delta_clamp_range={raw!r} is not a finite [lo, hi] pair with lo < hi. '
            'mlPredictor.js destructures it straight into Math.max/Math.min.')
    return (float(raw[0]), float(raw[1]))


def assert_delta_label(y, y_actual, baseline, label_type: str) -> None:
    """The target must be exactly what the server adds to the baseline.

    Production: score = clip(baseline + clamp(delta, lo, hi), 0, 100).
    Training therefore has to learn `busyness_pct - baseline_busyness`, in the
    same units (busyness percentage points) and the same sign (positive = busier
    than a typical week). If `y` is anything else, every metric in this file is
    computed against a reconstruction the server performs on a different number,
    and nothing downstream can see it.
    """
    if label_type != 'delta':
        raise LabelContractError(
            f"features_train.pkl declares label_type={label_type!r}. "
            'services/mlPredictor.js only reconstructs `baseline + clamp(delta)` when '
            "metadata.label_type == 'delta'; anything else ships the raw model output "
            'as the score. This script evaluates on the delta contract, so it refuses '
            'to train a label it would then measure wrongly.')
    for name, arr in (('y_actual', y_actual), ('baseline', baseline)):
        if arr is None:
            raise LabelContractError(
                f'label_type is "delta" but features_train.pkl carries no {name}. '
                'Without it the absolute-scale reconstruction cannot be checked or '
                'measured. Re-run prepare_features.py.')
    implied = np.asarray(y_actual, dtype=np.float64) - np.asarray(baseline, dtype=np.float64)
    diff = np.abs(np.asarray(y, dtype=np.float64) - implied)
    worst = float(diff.max()) if len(diff) else 0.0
    if worst > 0.01:
        bad = int((diff > 0.01).sum())
        k = int(np.argmax(diff))
        raise LabelContractError(
            f'The training target is NOT the delta the server reconstructs from: '
            f'{bad} of {len(diff)} rows have y != y_actual - baseline (worst {worst:.4f} '
            f'at row {k}: y={float(y[k]):.4f}, y_actual={float(y_actual[k]):.4f}, '
            f'baseline={float(baseline[k]):.4f}).\n'
            '  services/mlPredictor.js computes score = baseline + clamp(model_output). '
            'A target that is not that difference is added to the baseline anyway at '
            'serving time — silently, and in the wrong units.')
    logger.info('Delta contract OK: y == y_actual - baseline on all %d rows '
                '(max deviation %.2e). Sign convention: positive delta = busier than '
                'the popular_times baseline, in busyness percentage points.',
                len(diff), worst)


def assert_weighting_matches_provenance(sample_weight, is_realtime, provenance) -> dict:
    """Sample weights must follow the pipeline's tiering, not the other way round.

    prepare_features.py sets weekly < vendor-forecast < live-observed, with the
    reason written out there. The numbers live in that file; what is checked here
    is that each tier is internally consistent and correctly ordered, so a
    reordering or a collapsed tier cannot slip through unnoticed.
    """
    if sample_weight is None:
        raise LabelContractError(
            'features_train.pkl carries no sample_weight. The v2.3.1 blend weights '
            'weekly anchor rows at 0.05 and vendor-forecast labels at 0.3; training '
            'unweighted would put 84% of the loss on rows where the label equals the '
            'baseline by construction — the v2.2.1 failure.')
    w = np.asarray(sample_weight, dtype=np.float64)
    if not np.all(np.isfinite(w)) or np.any(w < 0) or w.sum() <= 0:
        raise LabelContractError('sample_weight must be finite, non-negative and not all zero.')

    rt = np.asarray(is_realtime).astype(bool)
    prov = np.asarray(provenance).astype(str) if provenance is not None else None
    tiers = {'weekly_anchor': ~rt}
    if prov is not None:
        tiers['realtime_vendor_forecast'] = rt & (prov == 'forecast')
        tiers['realtime_observed'] = rt & (prov != 'forecast')
    else:
        tiers['realtime'] = rt

    summary = {}
    for name, mask in tiers.items():
        if not mask.any():
            continue
        vals = np.unique(np.round(w[mask], 6))
        if len(vals) > 1:
            raise LabelContractError(
                f'Tier {name} carries {len(vals)} different sample weights {vals.tolist()}. '
                'Each provenance tier must have one weight, or the loss no longer means '
                'what prepare_features.py says it means.')
        summary[name] = {'rows': int(mask.sum()), 'weight': float(vals[0]),
                         'weight_share_pct': round(float(w[mask].sum() / w.sum()) * 100, 2)}

    order = [k for k in ('weekly_anchor', 'realtime_vendor_forecast', 'realtime_observed',
                         'realtime') if k in summary]
    weights = [summary[k]['weight'] for k in order]
    if weights != sorted(weights):
        raise LabelContractError(
            f'Sample weights are not ordered weekly <= vendor-forecast <= observed: '
            f'{ {k: summary[k]["weight"] for k in order} }. A vendor forecast outranking a '
            'live observation teaches the model to reproduce BestTime, not reality.')
    logger.info('Sample-weight tiers: %s', json.dumps(summary))
    return summary


# ---------------------------------------------------------------------------
# The split
# ---------------------------------------------------------------------------
def assert_group_disjoint(cv, X, y, groups) -> list:
    """Every fold's train and validation sides must share no city.

    A venue belongs to exactly one city, so a city-disjoint fold is a
    venue-disjoint fold; that is the whole reason the split is grouped on city.
    Also checks LOCO shape (one city held out per fold) and that every row is
    predicted exactly once — an unpredicted row leaves NaN in the out-of-fold
    vector, which turns every metric NaN and writes the literal `NaN` into
    model_metadata.json, where it is not valid JSON and takes mlPredictor down.
    """
    seen = np.zeros(len(y), dtype=np.int32)
    groups_arr = np.asarray(groups)
    folds = []
    for i, (tr, va) in enumerate(cv.split(X, y, groups=groups)):
        g_tr, g_va = set(groups_arr[tr]), set(groups_arr[va])
        overlap = g_tr & g_va
        if overlap:
            raise LeakageError(
                f'CV fold {i} trains and validates on the same city/cities '
                f'{sorted(overlap)}. Cities are the grouping key precisely because a '
                'venue never spans two of them; an overlapping fold puts a venue on '
                'both sides and every metric below becomes memorization.')
        if len(g_va) != 1:
            raise LeakageError(
                f'CV fold {i} holds out {len(g_va)} cities {sorted(g_va)}, not 1. '
                'This is meant to be leave-one-city-out; n_splits must equal the '
                'number of cities.')
        seen[va] += 1
        folds.append((tr, va, sorted(g_va)[0]))
    if not np.all(seen == 1):
        raise LeakageError(
            f'{int((seen == 0).sum())} rows were never in a validation fold and '
            f'{int((seen > 1).sum())} were in more than one. Out-of-fold predictions '
            'would be NaN or overwritten.')
    logger.info('Split check OK: %d leave-one-city-out folds, no city on both sides, '
                'every row predicted exactly once.', len(folds))
    return folds


# ---------------------------------------------------------------------------
# Metrics — measured the way they are labelled
# ---------------------------------------------------------------------------
def _metrics(target, preds) -> dict:
    errors = np.abs(target - preds)
    out = {
        'rmse': round(float(np.sqrt(mean_squared_error(target, preds))), 4),
        'mae': round(float(mean_absolute_error(target, preds)), 4),
        'r2': round(float(r2_score(target, preds)), 4),
        'median_ae': round(float(np.median(errors)), 4),
        'within_5': round(float(np.mean(errors <= 5) * 100), 1),
        'within_10': round(float(np.mean(errors <= 10) * 100), 1),
        'within_15': round(float(np.mean(errors <= 15) * 100), 1),
    }
    if not all(np.isfinite(v) for v in out.values()):
        raise ValueError(
            f'A metric is not finite: {out}. Writing this into model_metadata.json '
            'produces a bare NaN literal, which is not valid JSON, and '
            'mlPredictor.init() cannot parse the file at all.')
    return out


def reconstruct(raw_delta, baseline, clamp) -> np.ndarray:
    """Production's reconstruction, from services/mlPredictor.js:

        const clampedDelta = Math.max(lo, Math.min(hi, rawOutput));
        score = (baseline || 0) + clampedDelta;
        score = Math.max(0, Math.min(100, Math.round(score)));

    The rounding is left off deliberately: quick_eval.py's `reconstruct` does the
    same, so the gate and these numbers stay comparable to each other.
    """
    lo, hi = clamp
    return np.clip(baseline + np.clip(raw_delta, lo, hi), 0, 100)


def evaluate_city_cv(model, X, y, folds, baseline, y_actual, sample_weight, clamp) -> tuple:
    """Leave-one-city-out out-of-fold predictions, on the ABSOLUTE scale.

    Each fold refits from scratch (clone drops the fitted state) WITH the sample
    weights of its own training rows, so the numbers describe the model that is
    actually shipped rather than an unweighted stand-in.
    """
    oof = np.full(len(y), np.nan)
    per_city = {}
    for tr, va, city in folds:
        m = clone(model)
        m.fit(X[tr], y[tr], sample_weight=sample_weight[tr])
        oof[va] = m.predict(X[va])
        per_city[str(city)] = va

    if np.isnan(oof).any():
        raise ValueError(f'{int(np.isnan(oof).sum())} out-of-fold predictions are NaN.')

    absolute = reconstruct(oof, baseline, clamp)
    overall = _metrics(y_actual, absolute)
    # Per-fold numbers, so a fold that is a whole city of 48 rows is visible as
    # noise instead of being blended into the headline (audit finding 16). Below
    # the floor the row count is still reported; the metrics are not, because a
    # 48-row R2 is not a measurement.
    city_metrics = {}
    for c, idx in per_city.items():
        if len(idx) < PER_CITY_MIN_ROWS:
            city_metrics[c] = {'rows': int(len(idx)),
                               'note': f'fewer than {PER_CITY_MIN_ROWS} rows — not measured'}
            continue
        city_metrics[c] = {'rows': int(len(idx)), **_metrics(y_actual[idx], absolute[idx])}
    return overall, absolute, city_metrics


def slice_report(y_actual, absolute, is_realtime, baseline) -> dict:
    """The same numbers, split by the population they describe.

    `training_metrics` is a blend that is ~84% weekly popular_times snapshots
    where busyness_pct EQUALS baseline_busyness by construction, so its
    within-15 is close to a tautology — and services/mlPredictor.js publishes
    exactly that figure to users as the venue card's `confidence`. The rows
    production actually scores with this model are the realtime ones with a
    baseline. Both are reported, each labelled with its own row count, so
    nobody has to guess which population a number came from.
    """
    served = serving_population_mask(baseline)
    rt = np.asarray(is_realtime).astype(bool)
    out = {'all_rows': {'rows': int(len(y_actual)),
                        'population': 'every training row (weekly anchor + realtime)',
                        **_metrics(y_actual, absolute)}}
    masks = {
        'realtime_served': (rt & served,
                            'is_realtime == 1 AND baseline > 0 — the serving_population_mask '
                            'quick_eval.py gates on. This is the honest accuracy.'),
        'weekly_anchor': (~rt & served,
                          'weekly popular_times snapshots: busyness_pct == baseline_busyness '
                          'by construction, so the delta label is 0 and these are close to '
                          'tautological. Diagnostic only.'),
    }
    for name, (mask, note) in masks.items():
        if int(mask.sum()) < 100:
            out[name] = {'rows': int(mask.sum()), 'population': note,
                         'note': 'fewer than 100 rows — not measured'}
            continue
        out[name] = {'rows': int(mask.sum()), 'population': note,
                     **_metrics(y_actual[mask], absolute[mask])}
    return out


# ---------------------------------------------------------------------------
# Reproducibility
# ---------------------------------------------------------------------------
def resolve_device() -> tuple:
    """Pick the training device, explicitly, and say so.

    Audit finding 19: device was probed at runtime with no record, so the same
    code and the same seed produced a different model on a CPU box than on the
    RTX 5080. Measured on a synthetic fixture: max |cpu - cuda| prediction gap
    2.02 busyness points, which is a whole label band on some venues.
    """
    choice = os.environ.get('FLOCK_TRAIN_DEVICE', 'auto').strip().lower()
    if choice not in {'auto', 'cpu', 'cuda'}:
        raise ValueError(f'FLOCK_TRAIN_DEVICE={choice!r} must be auto, cpu or cuda.')
    if choice == 'cpu':
        return 'cpu', 'pinned by FLOCK_TRAIN_DEVICE=cpu'
    probe_error = None
    try:
        p = XGBRegressor(device='cuda', tree_method='hist', n_estimators=2, verbosity=0)
        p.fit(np.zeros((8, 2), dtype=np.float32), np.zeros(8, dtype=np.float32))
        usable = True
    except Exception as e:  # noqa: BLE001 — any CUDA failure means "no GPU here"
        usable, probe_error = False, f'{type(e).__name__}: {e}'
    if choice == 'cuda':
        if not usable:
            raise RuntimeError(
                f'FLOCK_TRAIN_DEVICE=cuda but CUDA is not usable ({probe_error}). '
                'Refusing to silently train on CPU: it would produce a different model '
                'from the one that was asked for.')
        return 'cuda', 'pinned by FLOCK_TRAIN_DEVICE=cuda'
    if usable:
        logger.warning(
            'Training on CUDA (probed at runtime). GPU histogram training is NOT '
            'bit-reproducible and a CPU box will produce a DIFFERENT model from the '
            'same seed and the same data. Set FLOCK_TRAIN_DEVICE=cpu for a run anyone '
            'can reproduce. The device is recorded in metadata.training_environment.')
        return 'cuda', 'probed (FLOCK_TRAIN_DEVICE=auto)'
    logger.info('CUDA not usable (%s) — training on CPU.', probe_error)
    return 'cpu', 'probed (FLOCK_TRAIN_DEVICE=auto), CUDA unavailable'


def resolve_threads() -> int:
    """Thread count changes the model, so it is pinned and recorded.

    Measured on the same fixture: n_jobs=-1 vs n_jobs=1 moved predictions by up
    to 2.06 busyness points. `-1` means "however many cores this box has", which
    is not a reproducible setting.
    """
    raw = os.environ.get('FLOCK_TRAIN_THREADS', '').strip()
    if raw:
        n = int(raw)
        if n < 1:
            raise ValueError('FLOCK_TRAIN_THREADS must be >= 1.')
        return n
    return os.cpu_count() or 1


def environment_fingerprint(device: str, device_reason: str, threads: int) -> dict:
    reproducible = device == 'cpu'
    return {
        'device': device,
        'device_selection': device_reason,
        'n_jobs': threads,
        'random_state': RANDOM_STATE,
        'bit_reproducible': reproducible,
        'reproducibility_note': (
            'Same data + same seed + same library versions + '
            f'FLOCK_TRAIN_DEVICE={device} + FLOCK_TRAIN_THREADS={threads} reproduces this '
            'model exactly.' if reproducible else
            'CUDA histogram training is not bit-reproducible; this artifact cannot be '
            'reproduced exactly, not even on this machine. Re-run with '
            'FLOCK_TRAIN_DEVICE=cpu for a reproducible artifact.'),
        'python': platform.python_version(),
        'platform': platform.platform(),
        'xgboost': xgboost.__version__,
        'sklearn': sklearn.__version__,
        'numpy': np.__version__,
    }


# ---------------------------------------------------------------------------
# Hyperparameters
# ---------------------------------------------------------------------------
# Found by the v2.3.0 realtime-only RandomizedSearchCV (grouped on city). Depth 8
# won the v2.3.1 blend bake-off against v2.3.2's depth 4 on every slice
# (realtime 34.46 vs 34.87, weekly 1.06 vs 1.61). They are FIXED values, not a
# search result from this run — metadata.hyperparameters says which.
FIXED_PARAMS = {
    'subsample': 0.9, 'reg_lambda': 1.0, 'reg_alpha': 0.5,
    'n_estimators': 800, 'min_child_weight': 7, 'max_depth': 8,
    'learning_rate': 0.01, 'colsample_bytree': 0.8,
}

PARAM_DIST = {
    'n_estimators': [200, 500, 800, 1200, 1500],
    'max_depth': [4, 6, 8, 10, 12],
    'learning_rate': [0.01, 0.03, 0.05, 0.1],
    'min_child_weight': [1, 3, 5, 7],
    'subsample': [0.7, 0.8, 0.9],
    'colsample_bytree': [0.7, 0.8, 0.9],
    'reg_alpha': [0, 0.1, 0.5, 1.0],
    'reg_lambda': [1.0, 1.5, 2.0, 3.0],
}
SEARCH_ITERATIONS = 24


def run_hyperparameter_search(base_model, X, y, cv, groups, sample_weight) -> tuple:
    """Grouped randomized search, with the weights routed into each fold.

    Audit finding 19: this object used to be CONSTRUCTED and never fitted on the
    weighted path, while `metadata['best_params']` presented a hardcoded dict as
    its output. The reason it was never fitted is real — without metadata routing
    sklearn hands the FULL sample_weight to a fold fitting on a subset — so the
    routing is switched on here rather than the search being faked.

    scoring is MAE, not RMSE. On a delta model the two error scales are the same
    quantity: y_actual - (baseline + delta_hat) == (y_actual - baseline) - delta_hat,
    so MAE on the delta label IS the gate's MAE up to the clamp. Tuning on RMSE
    while gating on MAE optimised a different loss than the one that decides
    whether the artifact ships.

    The weights are routed to `fit` only. The SCORER stays unweighted on purpose:
    the ship gate counts every held-out row once, so a weighted score would rank
    candidates by a number no gate ever computes.
    """
    sklearn.set_config(enable_metadata_routing=True)
    try:
        routed = clone(base_model).set_fit_request(sample_weight=True)
        search = RandomizedSearchCV(
            routed, PARAM_DIST,
            n_iter=SEARCH_ITERATIONS,
            cv=cv,
            scoring='neg_mean_absolute_error',
            random_state=RANDOM_STATE,
            n_jobs=1,
            verbose=0,
        )
        search.fit(X, y, groups=groups, sample_weight=sample_weight)
        best = dict(search.best_params_)
    finally:
        sklearn.set_config(enable_metadata_routing=False)
    return best, {
        'source': 'randomized_search_this_run',
        'n_iter': SEARCH_ITERATIONS,
        'scoring': 'neg_mean_absolute_error',
        'cv': 'GroupKFold on city (leave-one-city-out)',
        'sample_weight_routed_per_fold': True,
        'best_score_mae': round(float(-search.best_score_), 4),
    }


# ---------------------------------------------------------------------------
# Early stopping
# ---------------------------------------------------------------------------
def early_stopping_split(groups, rows_fraction=0.15) -> tuple:
    """Whole cities, never a random row split.

    A random split would put the same venue's Tuesday 9 PM on both sides and the
    stopping round would be chosen against rows the model had already seen.
    Deterministic: cities in name order, accumulated until the fraction is met.
    """
    g = np.asarray(groups)
    names = sorted(set(g.tolist()))
    if len(names) < 3:
        raise ValueError('Early stopping needs at least 3 cities so the held-out set '
                         'can be whole cities and still leave a training set.')
    target = rows_fraction * len(g)
    held, total = [], 0
    for name in names:
        if total >= target or len(held) >= len(names) - 2:
            break
        held.append(name)
        total += int((g == name).sum())
    val = np.isin(g, held)
    return ~val, val, held


def fit_with_early_stopping(base_model, params, X, y, groups, sample_weight,
                            baseline, y_actual, clamp, rounds) -> tuple:
    """Choose n_estimators on held-out CITIES, scored with the gate's own metric.

    The eval metric is MAE on the reconstructed absolute scale — the same
    quantity quick_eval.py's gate compares against the popular_times baseline
    and against the incumbent. Stopping on RMSE, or on the raw delta, would tune
    the model on one number and judge it on another.
    """
    tr, va, held = early_stopping_split(groups)
    va_baseline = np.asarray(baseline, dtype=np.float64)[va]
    va_actual = np.asarray(y_actual, dtype=np.float64)[va]

    def gate_mae(y_true, y_pred):
        return float(np.mean(np.abs(va_actual - reconstruct(np.asarray(y_pred, dtype=np.float64),
                                                            va_baseline, clamp))))

    probe = clone(base_model).set_params(**params, early_stopping_rounds=rounds,
                                         eval_metric=gate_mae)
    probe.fit(X[tr], y[tr], sample_weight=sample_weight[tr],
              eval_set=[(X[va], y[va])], verbose=False)

    # XGBoost keeps its default `rmse` alongside a custom metric and stops on the
    # LAST one in the list. Verify that the round it chose is the minimum of OUR
    # gate-aligned series, not of the RMSE it also happens to record — otherwise
    # the model is stopped on one metric and gated on another.
    history = probe.evals_result()['validation_0']
    if 'gate_mae' not in history or list(history)[-1] != 'gate_mae':
        raise LeakageError(
            f'Early stopping is not driven by the gate metric: XGBoost recorded '
            f'{list(history)} and stops on the last of them.')
    if int(np.argmin(history['gate_mae'])) != int(probe.best_iteration):
        raise LeakageError(
            f'best_iteration {probe.best_iteration} is not the minimum of the '
            f'gate-aligned MAE series (argmin {int(np.argmin(history["gate_mae"]))}).')
    best_iter = int(probe.best_iteration) + 1
    logger.info('Early stopping: held out %s (%d rows, %.1f%%), stopped at %d of %d '
                'rounds on gate-aligned MAE %.4f',
                held, int(va.sum()), va.sum() / len(y) * 100, best_iter,
                params['n_estimators'], float(probe.best_score))
    info = {
        'enabled': True,
        'rounds': rounds,
        'held_out_cities': held,
        'held_out_rows': int(va.sum()),
        'held_out_is_group_disjoint': True,
        'metric': 'MAE on the reconstructed absolute scale (baseline + clamp(delta)) — '
                  'the same quantity the ship gate measures',
        'best_iteration': best_iter,
        'best_score_gate_mae': round(float(probe.best_score), 4),
        'n_estimators_requested': params['n_estimators'],
        'note': ('n_estimators was chosen on these cities and the final model is then '
                 'refit on ALL cities, so the LOCO folds covering them are mildly '
                 'optimistic by one integer of hyperparameter choice. The ship gate is '
                 'measured on the separate holdout cities and is unaffected.'),
    }
    return best_iter, info


def train_xgboost(X, y, cv, folds, groups, baseline, y_actual, sample_weight, clamp,
                  device, threads) -> tuple:
    logger.info('\n=== Training XGBoost ===')
    start = time.time()

    base_model = XGBRegressor(
        random_state=RANDOM_STATE,
        tree_method='hist',
        device=device,
        n_jobs=threads,
        verbosity=0,
    )

    if os.environ.get('FLOCK_HYPERPARAM_SEARCH', '').strip().lower() == 'true':
        logger.info('Running the grouped randomized search (%d candidates x %d folds)...',
                    SEARCH_ITERATIONS, cv.get_n_splits())
        params, hp_info = run_hyperparameter_search(base_model, X, y, cv, groups, sample_weight)
    else:
        params = dict(FIXED_PARAMS)
        hp_info = {
            'source': 'fixed_from_v2.3.0_search',
            'searched_this_run': False,
            'note': ('These are FIXED values carried over from the v2.3.0 realtime-only '
                     'grouped search; no search ran in this run. Set '
                     'FLOCK_HYPERPARAM_SEARCH=true to search (scoring is MAE, weights are '
                     'routed per fold). Earlier versions of this file built a '
                     'RandomizedSearchCV object, never fitted it, and wrote this same '
                     'dict into metadata.best_params as if it were the search result.'),
        }

    es_info = {'enabled': False,
               'note': 'n_estimators is fixed; no early stopping. If it is turned on '
                       '(FLOCK_EARLY_STOPPING_ROUNDS), the eval set is whole held-out '
                       'cities and the metric is the gate\'s MAE.'}
    es_rounds = int(os.environ.get('FLOCK_EARLY_STOPPING_ROUNDS', '0') or 0)
    if es_rounds > 0:
        best_iter, es_info = fit_with_early_stopping(
            base_model, params, X, y, groups, sample_weight, baseline, y_actual,
            clamp, es_rounds)
        params = {**params, 'n_estimators': best_iter}

    # Nothing may reach .fit() with early stopping configured but no eval set:
    # XGBoost would either raise, or (with an eval_set that came from somewhere
    # else) choose the stopping round against rows it trained on.
    if 'early_stopping_rounds' in params or 'eval_metric' in params:
        raise LeakageError(
            'early_stopping_rounds / eval_metric must not be baked into the parameter '
            'dict — the final fit has no eval_set, so the stopping round would be '
            'chosen on training rows. Use FLOCK_EARLY_STOPPING_ROUNDS, which holds out '
            'whole cities.')

    logger.info('Params (%s): %s', hp_info['source'], params)
    model = clone(base_model).set_params(**params)
    model.fit(X, y, sample_weight=sample_weight)

    logger.info('Computing leave-one-city-out metrics...')
    metrics, absolute, per_city = evaluate_city_cv(
        model, X, y, folds, baseline, y_actual, sample_weight, clamp)
    elapsed = time.time() - start

    logger.info('City CV RMSE: %.4f, MAE: %.4f, R2: %.4f',
                metrics['rmse'], metrics['mae'], metrics['r2'])
    logger.info('Within 10 pts: %s%%', metrics['within_10'])
    logger.info('Training time: %.1fs', elapsed)

    return model, metrics, absolute, per_city, params, hp_info, es_info, elapsed


def main():
    logger.info('Loading prepared features...')
    features_path = SCRIPT_DIR / 'features_train.pkl'
    if not features_path.exists():
        raise FileNotFoundError(
            f'{features_path} does not exist. Run `node export_training_data.js` then '
            '`python prepare_features.py` first — a retrain starts at the export.')
    with open(features_path, 'rb') as f:
        data = pickle.load(f)

    X, y = data['X'], data['y']
    feature_cols = list(data['feature_cols'])
    cities = data.get('cities')
    baseline = data.get('baseline')
    y_actual = data.get('y_actual')
    sample_weight = data.get('sample_weight')
    provenance = data.get('label_provenance')
    label_type = data.get('label_type', 'absolute')

    if cities is None:
        raise ValueError('City information not found in features. Re-run prepare_features.py.')

    n = len(y)
    for name, arr in (('X', X), ('cities', cities), ('baseline', baseline),
                      ('y_actual', y_actual), ('sample_weight', sample_weight)):
        if arr is not None and len(arr) != n:
            raise ValueError(f'{name} has {len(arr)} rows but y has {n}. The pickle is '
                             'internally inconsistent; re-run prepare_features.py.')
    if X.shape[1] != len(feature_cols):
        raise ValueError(f'X has {X.shape[1]} columns but feature_cols names '
                         f'{len(feature_cols)}.')
    if not np.all(np.isfinite(y)):
        raise ValueError(f'{int((~np.isfinite(y)).sum())} target values are not finite.')
    # Column at a time: `np.isfinite(X)` on the whole matrix allocates a bool
    # array the size of the corpus, and this way the message names the column.
    non_finite = {feature_cols[j]: int((~np.isfinite(X[:, j])).sum())
                  for j in range(X.shape[1])
                  if not np.isfinite(X[:, j]).all()}
    if non_finite:
        raise ValueError(
            f'Feature values are NaN or infinite in {non_finite}. '
            'prepare_features.py fills features with 0 before saving, so this means the '
            'pickle was not written by it. XGBoost would route the NaNs down a "missing" '
            'branch that inference, which always sends a dense finite vector, can never '
            'reach.')
    if any(c is None or (isinstance(c, float) and c != c)
           or (isinstance(c, str) and not c.strip())
           for c in np.asarray(cities).tolist()):
        raise ValueError(
            'Some rows have no city. City is the grouping key for the whole split; a '
            'row without one cannot be assigned to a fold. Fix the export.')

    # ── metadata first: the clamp the SERVER applies is an input to every metric
    meta_path = MODELS_DIR / 'model_metadata.json'
    if not meta_path.exists():
        raise FileNotFoundError(
            f'{meta_path} does not exist. prepare_features.py writes it; run the '
            'pipeline in order (export -> prepare_features -> train_model).')
    with open(meta_path, 'r', encoding='utf-8') as f:
        metadata = json.load(f)
    clamp = resolve_clamp(metadata)
    meta_label_type = metadata.get('label_type')
    if meta_label_type is not None and meta_label_type != label_type:
        raise LabelContractError(
            f'features_train.pkl says label_type={label_type!r} but model_metadata.json '
            f'says {meta_label_type!r}. mlPredictor.js branches on the metadata value.')
    # The pickle and the metadata must come from the SAME prepare_features run.
    # export_model.py ships metadata.feature_names as the input contract and
    # mlPredictor builds its vector in that order; if the pickle's columns differ,
    # the served vector is a permutation of what the model was fitted on.
    meta_features = metadata.get('feature_names')
    if meta_features is not None and list(meta_features) != feature_cols:
        raise LabelContractError(
            f'features_train.pkl carries {len(feature_cols)} feature columns but '
            f'model_metadata.json.feature_names lists {len(meta_features)}, or they are in '
            'a different order. They are from different prepare_features.py runs. '
            'mlPredictor.js builds its input vector from feature_names, so a mismatch '
            'feeds the model a permuted vector at serving time. Re-run prepare_features.py.')

    # ── contracts ────────────────────────────────────────────────────────────
    assert_no_forbidden_features(feature_cols)
    assert_delta_label(y, y_actual, baseline, label_type)
    leak_scan = assert_no_label_shaped_feature(X, feature_cols, {
        'baseline_busyness': baseline,
        'busyness_pct (the label)': y_actual,
        'delta_label (the target)': y,
    })

    if 'is_realtime' in feature_cols:
        is_realtime = X[:, feature_cols.index('is_realtime')].astype(int) == 1
    else:
        logger.warning('is_realtime is not in the feature set — the per-population '
                       'breakdown will treat every row as weekly.')
        is_realtime = np.zeros(n, dtype=bool)
    weight_tiers = assert_weighting_matches_provenance(sample_weight, is_realtime, provenance)

    logger.info('Data shape: %s, Label type: %s, Label range: [%.1f, %.1f]',
                X.shape, label_type, y.min(), y.max())
    logger.info('DELTA label (busyness_pct - baseline_busyness). Server reconstructs '
                'score = clip(baseline + clamp(delta, %g, %g), 0, 100); every metric '
                'below is on that absolute scale.', clamp[0], clamp[1])

    unique_cities = np.unique(cities)
    n_cities = len(unique_cities)
    city_rows = {str(c): int(np.sum(cities == c)) for c in unique_cities}
    logger.info('Cities (%d): %s', n_cities, ', '.join(str(c) for c in unique_cities))
    for c, count in city_rows.items():
        logger.info('  %s: %d rows (%.1f%%)', c, count, count / n * 100)
    if n_cities < 3:
        raise ValueError(f'Only {n_cities} cities — leave-one-city-out needs at least 3.')
    thin = {c: r for c, r in city_rows.items() if r < 1000}
    if thin:
        logger.warning('Thin LOCO folds (each is a whole fold of the CV, so its metrics '
                       'are noise, and its per-city row count is why): %s', thin)

    device, device_reason = resolve_device()
    threads = resolve_threads()
    env = environment_fingerprint(device, device_reason, threads)
    logger.info('Training device: %s (%s), threads: %d, reproducible: %s',
                device, device_reason, threads, env['bit_reproducible'])

    cv = GroupKFold(n_splits=n_cities)
    logger.info('Using GroupKFold with %d splits (leave-one-city-out)', n_cities)
    folds = assert_group_disjoint(cv, X, y, cities)

    model, metrics, absolute, per_city, params, hp_info, es_info, elapsed = train_xgboost(
        X, y, cv, folds, cities, baseline, y_actual, sample_weight, clamp, device, threads)

    slices = slice_report(y_actual, absolute, is_realtime, baseline)

    logger.info('\n*** XGBoost Results (leave-one-city-out, absolute scale) ***')
    for name, block in slices.items():
        if 'mae' not in block:
            logger.info('    %-16s %d rows — not measured', name, block['rows'])
            continue
        logger.info('    %-16s %7d rows  MAE %6.3f  R2 %6.3f  within_10 %5.1f%%  '
                    'within_15 %5.1f%%',
                    name, block['rows'], block['mae'], block['r2'],
                    block['within_10'], block['within_15'])
    logger.info('    training_metrics (the blend above under "all_rows") is what '
                'mlPredictor.js publishes as the venue card confidence; '
                'realtime_served is the population it actually scores.')

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    model_path = SCRIPT_DIR / 'best_model.pkl'
    with open(model_path, 'wb') as f:
        pickle.dump({
            'model': model,
            'name': 'xgboost',
            'feature_cols': feature_cols,
        }, f)
    logger.info('Saved model to %s', model_path)

    metadata['best_model'] = 'xgboost'
    metadata['best_params'] = params
    metadata['hyperparameters'] = {**hp_info, 'params': params}
    metadata['early_stopping'] = es_info
    metadata['training_metrics'] = {
        **metrics,
        'population': ('leave-one-city-out out-of-fold predictions over EVERY training '
                       'row, on the absolute scale. ~84% of those rows are weekly '
                       'popular_times snapshots where busyness_pct equals '
                       'baseline_busyness by construction, so this figure is close to a '
                       'tautology on that majority. See training_metrics_by_population '
                       '.realtime_served for the rows production scores.'),
    }
    metadata['training_metrics_by_population'] = slices
    metadata['training_loco_per_city'] = per_city
    metadata['cv_method'] = f'GroupKFold(n_splits={n_cities}) - leave-one-city-out'
    metadata['training_cities'] = [str(c) for c in unique_cities]
    metadata['training_city_rows'] = city_rows
    metadata['training_environment'] = {**env, 'training_seconds': round(elapsed, 1)}
    metadata['training_contracts'] = {
        'delta_clamp_range_used': list(clamp),
        'delta_clamp_source': 'model_metadata.json' if metadata.get('delta_clamp_range')
                              else 'default (metadata key absent)',
        'label_contract': 'y == y_actual - baseline, verified on every row',
        'forbidden_features_checked': sorted(FORBIDDEN_FEATURES),
        'leak_scan': leak_scan,
        'split': 'GroupKFold on city; every fold verified train/validation city-disjoint '
                 'and every row predicted exactly once',
        'sample_weight_tiers': weight_tiers,
        # Named rather than left for someone to rediscover. This is the one leak
        # the trainer can see and cannot fix from here.
        'known_residual_leak': (
            'category_baseline and refined_category_baseline are averages of '
            'busyness_pct that prepare_features.py fits on the WHOLE training frame, '
            'before this split exists, so a held-out city contributes to the category '
            'cells its own rows are then scored against. RETRAIN.md tracks the in-fold '
            'recomputation as next lever 2. It makes training_metrics optimistic; it '
            'does NOT touch the ship gate, which is measured on the separate holdout '
            'cities whose category features were built from training rows only.'),
    }

    # allow_nan=False: Python happily writes (and reads) a bare NaN / Infinity
    # token, JSON.parse does not. A single non-finite number anywhere in this file
    # makes mlPredictor.init() fail to parse it at all, and the backend serves the
    # rule engine from then on with no obvious cause.
    try:
        rendered = json.dumps(metadata, indent=2, allow_nan=False)
    except ValueError as err:
        raise ValueError(
            f'model_metadata.json would contain a non-finite number ({err}), which is '
            'not valid JSON and cannot be read by services/mlPredictor.js. Find the key '
            'and fix the step that wrote it; do not relax allow_nan.') from err
    with open(meta_path, 'w', encoding='utf-8') as f:
        f.write(rendered)

    logger.info('Updated model_metadata.json')
    logger.info('Training complete!')


if __name__ == '__main__':
    main()
