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
Model size (recorded in metadata.hyperparameters.size_switches, not above):
  FLOCK_MAX_DEPTH=<int 1..16>          default FIXED_PARAMS max_depth (8)
  FLOCK_N_ESTIMATORS=<int 1..20000>    default FIXED_PARAMS n_estimators (800)

X beside the pickle: a features_train.pkl whose X lives in features_train.X.npy
(features_io.py) is memory-mapped, and every fit and predict then reads it a row
chunk at a time (RowChunks, predict_rows), with the same booster and the same
model_metadata.json as an X held in the pickle. See the block above RowChunks.
"""

import json
import logging
import os
import pickle
import platform
import time
from pathlib import Path

import numpy as np
import pandas as pd
import sklearn
import xgboost
from sklearn.base import clone
from sklearn.model_selection import GroupKFold, RandomizedSearchCV
from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
from xgboost import XGBRegressor

# The single definition of "rows production scores with this model". Imported,
# never re-implemented: prepare_features.py filters TRAINING with it and
# quick_eval.py gates with it. A third copy here would be a third thing to drift.
# CAT_KEYS / REFINED_KEYS come from the same place for the same reason: the
# per-fold refit below has to key its cells exactly the way the map it replaces
# was keyed, and a second copy of those key lists is a second thing to drift.
from prepare_features import serving_population_mask, realtime_flags, CAT_KEYS, REFINED_KEYS
from features_io import load_features

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
    'is_realtime': ('1 on every prediction serving makes, so as a feature it encodes only the '
                    'label regime of a training row (PRE-RETRAIN-AUDIT finding 18); carried in '
                    'the pickle, read through prepare_features.realtime_flags'),
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
    # The sampled rows are read once, and each reference quantity is cut to the
    # sample once: X may be memory-mapped from beside the pickle, and converting a
    # whole reference column to float64 for every feature was 3 x 104 full-length
    # copies. The values compared are the same.
    sampled = np.asarray(X[idx])
    refs = {probe_name: np.asarray(probe)[idx].astype(np.float64)
            for probe_name, probe in probes.items()}
    for j, name in enumerate(feature_cols):
        col = np.asarray(sampled[:, j], dtype=np.float64)
        if len(np.unique(col)) <= 1:
            # A constant column carries nothing and can leak nothing. Skipping it
            # also removes the only false-positive class here: an all-zero dead
            # slot "matches" delta_label on the ~84% of rows that are weekly
            # snapshots, where the delta is 0 by construction. prepare_features
            # already reports constant columns as DEAD SLOTS.
            continue
        for probe_name, ref in refs.items():
            share = float(np.mean(np.isclose(col, ref, rtol=1e-3, atol=1e-2)))
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


def assert_weighting_matches_provenance(sample_weight, is_realtime, provenance,
                                        run_length_divisor=None) -> dict:
    """Sample weights must follow the pipeline's tiering, not the other way round.

    prepare_features.py sets weekly < vendor-forecast < live-observed, with the
    reason written out there. The numbers live in that file; what is checked here
    is that each tier is internally consistent and correctly ordered, so a
    reordering or a collapsed tier cannot slip through unnoticed.

    `run_length_divisor` (2026-09-25) is what prepare_features divided each
    row's tier weight by: a live row's run of identical consecutive-hour
    readings under FLOCK_RUN_LENGTH_WEIGHTS=on, 1 everywhere else. The tier is
    then weight x divisor, still one number per tier, and only a live row may
    carry a divisor above 1.
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
    if run_length_divisor is None:
        tier_w = w
    else:
        div = np.asarray(run_length_divisor, dtype=np.float64)
        if (len(div) != len(w) or not np.all(np.isfinite(div)) or np.any(div < 1)
                or np.any(div != np.floor(div))):
            raise LabelContractError(
                'run_length_divisor must be a whole number >= 1 on every row, aligned with '
                'sample_weight.')
        live = rt & (prov == 'live') if prov is not None else rt
        if np.any(div[~live] != 1):
            raise LabelContractError(
                f'{int((div[~live] != 1).sum())} row(s) that are not live readings carry a '
                'run-length divisor above 1. Only a live reading can repeat a vendor update.')
        tier_w = w * div
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
        vals = np.unique(np.round(tier_w[mask], 6))
        if len(vals) > 1:
            raise LabelContractError(
                f'Tier {name} carries {len(vals)} different sample weights {vals.tolist()}'
                f'{" (weight x run-length divisor)" if run_length_divisor is not None else ""}. '
                'Each provenance tier must have one weight, or the loss no longer means '
                'what prepare_features.py says it means.')
        summary[name] = {'rows': int(mask.sum()), 'weight': float(vals[0]),
                         'weight_share_pct': round(float(w[mask].sum() / w.sum()) * 100, 2)}
        if run_length_divisor is not None and name != 'weekly_anchor':
            summary[name]['rows_divided_by_run_length'] = int((div[mask] > 1).sum())
            summary[name]['weight_sum'] = round(float(w[mask].sum()), 3)

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
# Per-fold category baselines — the consuming half of RETRAIN.md's lever 2
# ---------------------------------------------------------------------------
# THE LEAK THIS CLOSES, and the exact sense in which it closes it.
#
# `category_baseline` and `refined_category_baseline` are means of `busyness_pct`
# — the label. prepare_features.py fits both on the whole training frame and
# applies them to that same frame, and it has no folds to fit inside of. The CV
# below holds out one CITY per fold, so a held-out city had already contributed
# to the category cells its own rows are then scored against, and the REPORTED
# cross-validation numbers came out optimistic.
#
# What changes here is the reporting and nothing else. The final model is still
# fitted on the matrix prepare_features wrote, because the map that matrix
# carries is the map `services/mlPredictor.js` is shipped and serves — for
# inference there is no held-out group, so every training row is the right
# estimate. The ship gate is untouched: it runs on the separate holdout cities,
# whose category features were built from training rows only.
#
# THE FORMULATION, AND WHY THIS ONE AND NOT THE CHEAP ONE. Inside a fold the map
# must be ONE value per cell, shared by that fold's training and validation rows
# alike. The tempting substitute — one leave-one-city-out map computed once,
# each row reading (cell_sum - own_city_sum) / (cell_n - own_city_n) — is not
# equivalent and was measured to be roughly six times worse than the leak it
# claims to remove: the feature then varies BY CITY inside a fold, and its
# deviation from the cell's typical value is an invertible function of the
# held-out city's own labels, so a tree splits to identify the cell and reads
# that city's level straight off the feature. It also PASSES a label-perturbation
# invariance check, which is why invariance is necessary and not sufficient and
# why the fix below is validated against a held-out population instead. See
# prepare_features.build_category_cell_aggregates and RETRAIN.md lever 2.
#
# THE POPULATION TRAP THIS ALREADY FELL INTO ONCE, AND THE ASSERTION THAT MAKES
# IT UNREPEATABLE. The first version of these statistics was aggregated after the
# serving-population filter, because row_cell/row_group are positional indexes
# into X and X is the filtered matrix. But the map being replaced is fitted
# BEFORE that filter, on 3,516,876 rows rather than 1,934,988. Measured on the shipped
# pickle: a fold map built that way moved category_baseline on 99.9% of rows by a
# mean of 9.27 points, while removing the held-out city — the entire point — moved
# it on 75% of rows by a mean of 0.17. Reporting the resulting cross-validation
# figure as "the leak-corrected number" would have published a number describing a
# model whose category feature is not the one shipped: the same sin as the 84%
# confidence, in a new place.
#
# prepare_features.build_category_cell_aggregates now fits on the pre-filter frame
# and index_category_cells attaches the indexes afterwards, so the ONLY difference
# a fold map carries is the held-out city. That is checkable exactly, and it is
# checked: verify_reproduces_shipped() holds out nothing and requires the rebuilt
# columns to equal X's own columns bit for bit before any fold is fitted. A v1
# pickle is refused rather than silently producing the confounded number.
CATEGORY_FEATURES = ('category_baseline', 'refined_category_baseline')
CELL_STATS_MIN_VERSION = 2


class FoldCategoryBaselines:
    """Rebuild both category label-means from a fold's TRAINING rows only.

    Consumes `features_train.pkl['category_cell_stats']`: per-(city, cell) label
    sums and counts, each row's cell index and group index, and the cell key
    tuples so the coarse map's 0.6/0.2/0.2 adjacent-hour smoothing can be redone
    on the cells a fold actually supports. One fold costs two dense sums over a
    (30 x 2184) and a (30 x 7316) matrix — no second pass over the CSV, and no
    refit of anything expensive.

    Every check in __init__ is about one failure mode: `row_cell` and `row_group`
    are POSITIONAL indexes into X, so a pickle whose statistics were computed
    against a different row order would score every row against the wrong
    category cell, silently, and produce better-looking numbers that mean
    nothing. The aggregate rebuild (`sums` re-derived from the rows themselves)
    is what makes that structural rather than trusted.
    """

    def __init__(self, cell_stats, cities, feature_cols, y_actual):
        self.active = False
        self.reason = None
        self.version = None
        self.col_index = {}
        present = [c for c in CATEGORY_FEATURES if c in feature_cols]
        if not present:
            self.reason = ('the feature matrix carries neither category_baseline nor '
                           'refined_category_baseline, so there is no label-mean feature '
                           'to refit')
            logger.info('Per-fold category baselines: not applicable — %s.', self.reason)
            return
        if len(present) != len(CATEGORY_FEATURES):
            raise LabelContractError(
                f'The feature matrix carries {present} but not all of {list(CATEGORY_FEATURES)}. '
                'Both are means of busyness_pct and both must be refitted per fold, or the '
                'one left behind keeps the leak open while the metadata claims it is closed.')
        if not cell_stats:
            raise LabelContractError(
                'features_train.pkl carries category_baseline / refined_category_baseline '
                'but no category_cell_stats. Those two features are label means fitted on '
                'the whole training frame; without the per-(city, cell) statistics this '
                'script cannot refit them inside a fold, and every cross-validation number '
                'below would be optimistic by an unmeasured amount. Re-run '
                'prepare_features.py, which writes them.')

        version = cell_stats.get('version', 1)
        if version < CELL_STATS_MIN_VERSION:
            raise LabelContractError(
                f'features_train.pkl carries category_cell_stats v{version}, but this '
                f'script requires v{CELL_STATS_MIN_VERSION}. v1 aggregated the label '
                'sums AFTER the serving-population filter while the feature they '
                'replace is fitted BEFORE it, so a "leak-corrected" fold map built '
                'from them moves category_baseline by ~9.3 points for reasons that '
                'have nothing to do with the leak (which moves it ~0.17). The '
                'resulting cross-validation number would not describe the shipped '
                'model. Re-run prepare_features.py, which now fits the aggregates on '
                'the pre-filter frame.')
        if cell_stats.get('fit_population') != 'pre_serving_filter':
            raise LabelContractError(
                'category_cell_stats.fit_population is '
                f'{cell_stats.get("fit_population")!r}; a per-fold refit is only a '
                'correction if its aggregates were fitted on the same population as '
                'the map it replaces (pre_serving_filter).')
        self.version = version
        n = len(y_actual)
        self.n_rows = n
        if cell_stats.get('group_col') != 'city':
            raise LabelContractError(
                f'category_cell_stats groups on {cell_stats.get("group_col")!r}, but this '
                'CV holds out a CITY per fold. A per-fold refit needs the statistics '
                'grouped on the same key the folds are.')
        self.groups = [str(g) for g in cell_stats['groups']]
        self.group_index = {g: i for i, g in enumerate(self.groups)}
        row_group = _row_index(cell_stats['row_group'])
        if len(row_group) != n:
            raise LabelContractError(
                f'category_cell_stats.row_group has {len(row_group)} entries for {n} rows. '
                'It is a positional index into X; a length mismatch means the statistics '
                'and the matrix came from different prepare_features.py runs.')
        # Compared as integer city codes (city_codes), the same equality as comparing
        # each row's group name with its city name: two <U copies of the city column
        # were ~4 GB each at the third candidate's ~90 million rows.
        names, codes = city_codes(cities)
        code_of = {name: k for k, name in enumerate(names)}
        group_code = np.array([code_of.get(g, -1) for g in self.groups], dtype=np.int32)
        mismatch = group_code[row_group] != codes
        del codes
        if mismatch.any():
            bad = int(mismatch.sum())
            raise LeakageError(
                f'category_cell_stats.row_group disagrees with the city of {bad} rows. '
                'The statistics are positionally aligned to X by construction, so a '
                'disagreement means they describe a different row order — a per-fold map '
                'built from them would exclude the wrong city and the "honest" number '
                'would be fiction.')
        del mismatch
        self.row_group = row_group

        y64 = np.asarray(y_actual, dtype=np.float64)
        finite = np.isfinite(y64)
        self.blocks = {}
        for name, keys in (('category', CAT_KEYS), ('refined', REFINED_KEYS)):
            block = cell_stats.get(name)
            if block is None:
                raise LabelContractError(f'category_cell_stats has no {name!r} block.')
            if list(block['keys']) != list(keys):
                raise LabelContractError(
                    f'category_cell_stats[{name!r}] is keyed on {list(block["keys"])} but '
                    f'prepare_features keys that map on {list(keys)}. The refit would '
                    'aggregate over a different cell than the feature it replaces.')
            row_cell = _row_index(block['row_cell'])
            sums = np.asarray(block['sums'], dtype=np.float64)
            counts = np.asarray(block['counts'], dtype=np.int64)
            n_cells = len(block['cells'])
            if len(row_cell) != n:
                raise LabelContractError(
                    f'category_cell_stats[{name!r}].row_cell has {len(row_cell)} entries '
                    f'for {n} rows.')
            if sums.shape != (len(self.groups), n_cells) or counts.shape != sums.shape:
                raise LabelContractError(
                    f'category_cell_stats[{name!r}] sums/counts are {sums.shape}/'
                    f'{counts.shape}, expected {(len(self.groups), n_cells)}.')
            # Rebuild the ROW-restricted statistics from the rows they claim to
            # describe. This is the check that cannot be satisfied by a coincidence:
            # if row_cell or row_group belonged to a different frame, the totals
            # would not land back on the shipped matrices. It compares against
            # rows_sums/rows_counts, NOT sums/counts — the latter are fitted on the
            # wider pre-filter frame on purpose, and comparing to them would fail
            # for the very reason the design is correct.
            rows_counts = np.asarray(block['rows_counts'], dtype=np.int64)
            rows_sums = np.asarray(block['rows_sums'], dtype=np.float64)
            flat = row_group.astype(np.int64) * n_cells + row_cell
            rebuilt_sum = np.bincount(flat[finite], weights=y64[finite],
                                      minlength=len(self.groups) * n_cells)
            rebuilt_cnt = np.bincount(flat[finite],
                                      minlength=len(self.groups) * n_cells)
            if not np.array_equal(rebuilt_cnt.reshape(rows_counts.shape), rows_counts):
                raise LeakageError(
                    f'category_cell_stats[{name!r}].rows_counts do not match the counts '
                    'implied by row_cell/row_group on this pickle\'s own rows. The '
                    'statistics describe a different frame.')
            if not np.allclose(rebuilt_sum.reshape(rows_sums.shape), rows_sums,
                               rtol=0, atol=1e-6):
                raise LeakageError(
                    f'category_cell_stats[{name!r}].rows_sums do not match the label sums '
                    'implied by row_cell/row_group on this pickle\'s own rows.')
            if (rows_counts > counts).any():
                raise LeakageError(
                    f'category_cell_stats[{name!r}] has more rows in a cell than the '
                    'pre-filter aggregates do. The matrix rows must be a subset of the '
                    'rows the aggregates were fitted on; they are not, so the two came '
                    'from different runs.')
            self.blocks[name] = {'row_cell': row_cell, 'sums': sums, 'counts': counts,
                                 'n_cells': n_cells}

        # Smoothing order for the coarse map. _smooth_category_hours sorts by
        # (venue_category, day_of_week, hour) and shifts WITHIN
        # (venue_category, day_of_week), so a cell's neighbour is the adjacent
        # hour PRESENT in the map — which is why the order is rebuilt per fold
        # over the cells that fold supports, not once over all of them.
        cells = list(cell_stats['category']['cells'])
        cat_key = np.array([c[0] for c in cells], dtype=object)
        try:
            dow = np.array([float(c[1]) for c in cells])
            hour = np.array([float(c[2]) for c in cells])
        except (TypeError, ValueError) as err:
            raise LabelContractError(
                'category_cell_stats.category cell keys carry a non-numeric day_of_week or '
                f'hour ({err}). prepare_features sorts those columns numerically before '
                'smoothing; without the same order the rebuilt map blends the wrong '
                'neighbours.') from err
        self._cell_order = np.lexsort((hour, dow, cat_key.astype(str)))
        pair = np.array([f'{c}\x1f{d}' for c, d in zip(cat_key.astype(str), dow)], dtype=object)
        _, self._pair_id = np.unique(pair.astype(str), return_inverse=True)

        self.active = True
        self.col_index = {c: feature_cols.index(c) for c in CATEGORY_FEATURES}
        logger.info(
            'Per-fold category baselines ARMED: %d coarse cells, %d refined cells over %d '
            'cities; both label-mean features are rebuilt from each fold\'s training rows '
            'before that fold is fitted or scored.',
            self.blocks['category']['n_cells'], self.blocks['refined']['n_cells'],
            len(self.groups))

    # -- the arithmetic, one fold at a time ---------------------------------
    def _cell_means(self, name, keep):
        block = self.blocks[name]
        s = block['sums'][keep].sum(0)
        c = block['counts'][keep].sum(0)
        supported = c > 0
        means = np.full(block['n_cells'], np.nan)
        means[supported] = np.round(s[supported] / c[supported], 1)
        return means, supported, float(s.sum()), int(c.sum())

    def _smooth_coarse(self, means, supported):
        """prepare_features._smooth_category_hours, restricted to supported cells."""
        order = self._cell_order[supported[self._cell_order]]
        out = np.full(len(means), np.nan)
        if len(order) == 0:
            return out
        m = means[order]
        pair = self._pair_id[order]
        prev = m.copy()
        nxt = m.copy()
        if len(order) > 1:
            same_as_prev = pair[1:] == pair[:-1]
            prev[1:] = np.where(same_as_prev, m[:-1], m[1:])
            nxt[:-1] = np.where(same_as_prev, m[1:], m[:-1])
        out[order] = np.round(m * 0.6 + prev * 0.2 + nxt * 0.2, 1)
        return out

    def columns_for_fold(self, held_out_city):
        """The two feature columns as a map fitted WITHOUT `held_out_city`.

        `held_out_city` is one city name or an iterable of them (the early-stopping
        split holds out several). Returned for EVERY row, training and validation
        alike: one value per cell, shared by both sides of the fold. That sharing
        is the property that makes this honest — it leaves no city-varying residual
        for a tree to invert back into the held-out city's own label level.
        """
        if not self.active:
            raise RuntimeError('columns_for_fold called on an inactive refitter.')
        held = ([held_out_city] if isinstance(held_out_city, str)
                else list(held_out_city))
        keep = np.ones(len(self.groups), dtype=bool)
        for name in held:
            g = self.group_index.get(str(name))
            if g is None:
                raise LabelContractError(
                    f'Fold holds out city {name!r}, which is not one of the '
                    f'{len(self.groups)} cities in category_cell_stats.')
            keep[g] = False

        cat_means, cat_supported, s_total, n_total = self._cell_means('category', keep)
        if n_total == 0:
            raise LabelContractError(
                f'Removing {held_out_city!r} leaves no labelled rows to fit the category '
                'baselines on.')
        # prepare_features: round(float(df['busyness_pct'].mean()), 1)
        global_mean = round(s_total / n_total, 1)
        cat_map = self._smooth_coarse(cat_means, cat_supported)
        cat_col = cat_map[self.blocks['category']['row_cell']]
        cat_col = np.where(np.isnan(cat_col), global_mean, cat_col)

        ref_means, _, _, _ = self._cell_means('refined', keep)
        ref_col = ref_means[self.blocks['refined']['row_cell']]
        # add_baseline_features fills a missing refined cell with the row's
        # (already filled) coarse value, not with the global mean.
        ref_col = np.where(np.isnan(ref_col), cat_col, ref_col)
        return {self.col_index['category_baseline']: cat_col.astype(np.float32),
                self.col_index['refined_category_baseline']: ref_col.astype(np.float32)}

    def apply_to(self, X_block, rows, fold_cols):
        """Write a fold's map into a COPY of the matrix. X itself is never touched."""
        for j, col in fold_cols.items():
            X_block[:, j] = col[rows]
        return X_block

    def verify_reproduces_shipped(self, X):
        """Hold out NOTHING and require the rebuilt columns to equal X's own.

        This is the whole design compressed into one assertion. If the aggregates
        were fitted on the same population as the shipped map, and the smoothing,
        the rounding and the two fallbacks were all reproduced faithfully, then a
        map built from every group is the shipped map and the columns must match
        exactly. Anything else — a population difference, a rounding difference, a
        misremembered fallback — shows up here as a nonzero diff, BEFORE thirty
        folds are fitted and a number is written into the artifact.

        Returns the largest absolute difference (0.0 on success) so the metadata
        can carry the evidence rather than the claim.
        """
        if not self.active:
            return None
        cols = self.columns_for_fold([])
        worst = 0.0
        for name, j in self.col_index.items():
            shipped = np.asarray(X[:, j], dtype=np.float64)
            rebuilt = np.asarray(cols[j], dtype=np.float64)
            diff = np.abs(rebuilt - shipped)
            worst = max(worst, float(diff.max()))
            if diff.max() > 0:
                bad = int((diff > 0).sum())
                raise LeakageError(
                    f'Rebuilding {name} from category_cell_stats with NO city held out '
                    f'does not reproduce the shipped column: {bad} of {len(diff)} rows '
                    f'differ, by up to {diff.max():.4f}. The per-fold map is therefore '
                    'not "the shipped map minus one city", and any cross-validation '
                    'number computed from it would describe a model that is not the one '
                    'this script saves. Most likely the aggregates were fitted on a '
                    'different population than build_category_baseline_maps was.')
        logger.info('Per-fold category baselines reproduce the shipped columns exactly '
                    'with no city held out (max |diff| = %g). The only thing a fold map '
                    'changes is the held-out city.', worst)
        return worst

    def fold_shift(self, X, fold_cols):
        """How far this fold's map moved the two features, for the metadata."""
        out = {}
        for name, j in self.col_index.items():
            before = np.asarray(X[:, j], dtype=np.float64)
            after = np.asarray(fold_cols[j], dtype=np.float64)
            diff = np.abs(after - before)
            out[name] = {'rows_changed_pct': round(float(np.mean(diff > 1e-6) * 100), 2),
                         'mean_abs_shift': round(float(diff.mean()), 4),
                         'max_abs_shift': round(float(diff.max()), 4)}
        return out


# ---------------------------------------------------------------------------
# The split
# ---------------------------------------------------------------------------
def city_codes(cities) -> tuple:
    """(names, codes): the distinct cities as sorted strings, and each row's city
    as its index into them (int16 below 32,768 cities).

    The fold machinery compares these integers where it compared city strings: at
    the third candidate's ~90 million rows a <U copy of the city column is ~4 GB,
    and a set or np.unique over the object column walks every row through
    Python's string comparison. Each value is read as str(value), as
    .astype(str) read it, and the names sort as np.unique sorts them, so code
    order is name order.
    """
    local, uniques = pd.factorize(np.asarray(cities, dtype=object), use_na_sentinel=False)
    labels = [str(u) for u in uniques]
    names = sorted(set(labels))
    position = {name: k for k, name in enumerate(names)}
    dtype = np.int16 if len(names) <= np.iinfo(np.int16).max else np.int32
    remap = np.array([position[label] for label in labels], dtype=dtype)
    return names, remap[local]


def _row_index(values) -> np.ndarray:
    """A per-row integer index, kept at its stored width when that is int32 or
    narrower (prepare_features writes int32), else int64 as it always was. The
    int64 copies of the group and cell indexes held 24 bytes a row."""
    a = np.asarray(values)
    if (a.dtype.kind == 'i' and a.dtype.itemsize <= 4) or (a.dtype.kind == 'u' and a.dtype.itemsize <= 2):
        return a.astype(np.int32, copy=False)
    return np.asarray(a, dtype=np.int64)


def _cities_in(codes, rows, names) -> set:
    """The names of the cities among `rows`, counted on the integer codes."""
    present = np.bincount(codes[rows], minlength=len(names))
    return {names[k] for k in np.flatnonzero(present)}


class LocoFolds:
    """The leave-one-city-out folds as (train rows, validation rows, city).

    Only each fold's validation rows are kept; its training rows are rebuilt
    when the fold is reached, as the complement in row order, which is what
    GroupKFold itself yields (np.arange(n)[~test_mask]): the same values in the
    same order and dtype. A list of all thirty training index arrays held about
    29 x 8 = 232 bytes a row for the whole run, several gigabytes at the
    harvest-inclusive candidate's size. The validation rows are kept as int32
    while the row count allows (to 2^31 rows); together they cover every row
    once, 4 bytes a row instead of 8.
    """

    def __init__(self, n_rows):
        self._n = int(n_rows)
        self._held = []

    def append(self, va, city):
        if self._n <= np.iinfo(np.int32).max:
            va = np.asarray(va).astype(np.int32, copy=False)
        self._held.append((va, city))

    def __len__(self):
        return len(self._held)

    def held_out(self, i):
        """Fold i's validation rows and city, without building its training rows."""
        return self._held[i]

    def training_mask(self, i):
        """Fold i's training rows as a boolean mask over every row: 1 byte a row
        where the index array np.flatnonzero makes of it is 8."""
        va, _ = self._held[i]
        keep = np.ones(self._n, dtype=bool)
        keep[va] = False
        return keep

    def __getitem__(self, i):
        va, city = self._held[i]
        return np.flatnonzero(self.training_mask(i)), va, city

    def __iter__(self):
        for i in range(len(self._held)):
            yield self[i]


def assert_group_disjoint(cv, X, y, groups) -> LocoFolds:
    """Every fold's train and validation sides must share no city.

    A venue belongs to exactly one city, so a city-disjoint fold is a
    venue-disjoint fold; that is the whole reason the split is grouped on city.
    Also checks LOCO shape (one city held out per fold) and that every row is
    predicted exactly once — an unpredicted row leaves NaN in the out-of-fold
    vector, which turns every metric NaN and writes the literal `NaN` into
    model_metadata.json, where it is not valid JSON and takes mlPredictor down.

    The split is made on the integer city codes, and the city sets compared are
    counted on them. GroupKFold groups through np.unique and the codes sort as the
    names do, so it makes the same folds, in the same order, as from the names.
    """
    names, codes = city_codes(groups)
    seen = np.zeros(len(y), dtype=np.int32)
    folds = LocoFolds(len(y))
    for i, (tr, va) in enumerate(cv.split(X, y, groups=codes)):
        g_tr, g_va = _cities_in(codes, tr, names), _cities_in(codes, va, names)
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
        folds.append(va, sorted(g_va)[0])
    if not np.all(seen == 1):
        raise LeakageError(
            f'{int((seen == 0).sum())} rows were never in a validation fold and '
            f'{int((seen > 1).sum())} were in more than one. Out-of-fold predictions '
            'would be NaN or overwritten.')
    logger.info('Split check OK: %d leave-one-city-out folds, no city on both sides, '
                'every row predicted exactly once.', len(folds))
    return folds


# ---------------------------------------------------------------------------
# Row chunks: an X kept beside its pickle is never copied whole
# ---------------------------------------------------------------------------
# The November third candidate (~54 to 90 million training rows) does not fit
# the training PC as one in-memory X plus the copies a fit makes of it: X[tr]
# was a near-whole second copy in every fold. prepare_features.py may therefore
# write X to a float32 .npy beside the pickle (features_io.py), main() memory-maps
# it, and every fit and predict reads it a row chunk at a time: the fit is
# XGBRegressor.fit(RowChunks(...), None), which builds XGBoost's quantile matrix
# from the chunks, and predict_rows predicts chunk by chunk.
#
# Exact, not an approximation, and measured before it was used (2026-11-25,
# XGBoost 3.2, the November registered features, 3,533,480 rows x 104): the same
# cut points, booster bytes and predictions as fitting the whole in-memory
# matrix, for 1, 4, 16 and 5 uneven chunks, for a leave-one-city-out fold with
# its category refit, and for the early-stopping fit; and a 20-tree run of this
# file wrote the same best_model.pkl booster and model_metadata.json with X in
# the pickle and beside it. test_iter_train.py pins it on a fixture, at chunk
# sizes that split cities. An X held in the pickle is fitted exactly as before.
ITER_CHUNK_ROWS = 262_144


def reads_in_chunks(X) -> bool:
    """True for an X memory-mapped from beside its pickle (features_io)."""
    return isinstance(X, np.memmap)


def _check_rows(n_rows, rows):
    """None (every row), a boolean mask over the rows, or sorted distinct indices."""
    if rows is None:
        return None
    rows = np.asarray(rows)
    if rows.dtype == bool:
        if len(rows) != n_rows:
            raise ValueError(f'a row mask of {len(rows)} entries for {n_rows} rows')
        return rows
    if rows.dtype.kind not in 'iu':
        raise ValueError(f'row indices must be integers, not {rows.dtype}')
    if len(rows) and (rows[0] < 0 or rows[-1] >= n_rows or np.any(rows[1:] <= rows[:-1])):
        raise ValueError('row indices must be sorted, distinct and within the matrix: a chunk '
                         'is handed to XGBoost in row order, and the labels must follow it')
    return rows


def _row_chunks(n_rows, rows, chunk_rows):
    """(start, stop, picked) per chunk, in row order.

    Chunks are cut on row POSITION, so each reads one contiguous slice of X.
    `picked` is None when every row in [start, stop) is taken, else the indices
    of the taken rows; a chunk that takes no row is skipped.
    """
    if rows is not None and rows.dtype != bool:
        bounds = np.searchsorted(rows, np.arange(0, n_rows + chunk_rows, chunk_rows))
    for k, start in enumerate(range(0, n_rows, chunk_rows)):
        stop = min(start + chunk_rows, n_rows)
        if rows is None:
            yield start, stop, None
            continue
        if rows.dtype == bool:
            mask = rows[start:stop]
            if mask.all():
                yield start, stop, None
                continue
            picked = start + np.flatnonzero(mask)
        else:
            picked = rows[bounds[k]:bounds[k + 1]]
        if len(picked) == stop - start:
            yield start, stop, None
        elif len(picked):
            yield int(picked[0]), int(picked[-1]) + 1, picked


def _chunk_matrix(X, start, stop, picked, fold_cats=None, fold_cols=None):
    """A C-ordered COPY of X's rows [start, stop), or of `picked` among them, with
    the fold's category map written in as apply_to writes it into X[tr]. Always a
    copy: X itself is never written."""
    block = np.array(X[start:stop], order='C')
    if picked is not None:
        block = block[picked - start]
    if fold_cols is not None:
        fold_cats.apply_to(block, slice(start, stop) if picked is None else picked, fold_cols)
    return block


class RowChunks(xgboost.DataIter):
    """Rows of X, in row order, handed to XGBoost a chunk at a time.

    `rows`: None (every row), a boolean mask, or sorted row indices. `label` and
    `weight` are full-length and cut to the same rows; `fold_cols` (from
    FoldCategoryBaselines.columns_for_fold) is written into each chunk's copy.
    XGBRegressor.fit(RowChunks(...), None) then fits what fit(X[rows],
    label[rows], sample_weight=weight[rows]) fits, without that copy.
    """

    def __init__(self, X, rows, label, weight=None, fold_cats=None, fold_cols=None,
                 chunk_rows=None):
        self._X = X
        self._rows = _check_rows(X.shape[0], rows)
        self._label = np.asarray(label)
        self._weight = None if weight is None else np.asarray(weight)
        self._fold_cats, self._fold_cols = fold_cats, fold_cols
        self._chunk_rows = int(chunk_rows or ITER_CHUNK_ROWS)
        self._chunks = None
        self.reset()
        super().__init__(cache_prefix=None, release_data=True)

    def reset(self):
        self._chunks = _row_chunks(self._X.shape[0], self._rows, self._chunk_rows)

    def next(self, input_data):
        chunk = next(self._chunks, None)
        if chunk is None:
            return False
        start, stop, picked = chunk
        take = slice(start, stop) if picked is None else picked
        batch = {'data': _chunk_matrix(self._X, start, stop, picked, self._fold_cats, self._fold_cols),
                 'label': self._label[take]}
        if self._weight is not None:
            batch['weight'] = self._weight[take]
        input_data(**batch)
        return True


def predict_rows(model, X, rows=None, fold_cats=None, fold_cols=None, chunk_rows=None,
                 **predict_kwargs):
    """model.predict over `rows` of X (every row when None), a chunk at a time,
    in row order. A prediction depends on its own row only, so these are the
    values of one call on the whole matrix (measured equal, not assumed)."""
    rows = _check_rows(X.shape[0], rows)
    parts = [model.predict(_chunk_matrix(X, start, stop, picked, fold_cats, fold_cols),
                           **predict_kwargs)
             for start, stop, picked in _row_chunks(X.shape[0], rows,
                                                    int(chunk_rows or ITER_CHUNK_ROWS))]
    return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


def _fold_parts(folds):
    """(training rows, validation rows, city) per fold. A LocoFolds hands its
    training rows as a boolean mask rather than an index array."""
    if isinstance(folds, LocoFolds):
        for i in range(len(folds)):
            va, city = folds.held_out(i)
            yield folds.training_mask(i), va, city
    else:
        yield from folds


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


def evaluate_city_cv(model, X, y, folds, baseline, y_actual, sample_weight, clamp,
                     fold_cats=None, chunk_rows=None) -> tuple:
    """Leave-one-city-out out-of-fold predictions, on the ABSOLUTE scale.

    Each fold refits from scratch (clone drops the fitted state) WITH the sample
    weights of its own training rows, so the numbers describe the model that is
    actually shipped rather than an unweighted stand-in.

    `fold_cats` rebuilds the two category label-mean features from the fold's own
    training rows before that fold is fitted or scored, so the held-out city no
    longer contributes to the cells its rows are measured against. Both sides of
    the fold get the SAME map (see FoldCategoryBaselines). The write goes into
    the per-fold COPIES `X[tr]` / `X[va]` already produce; `X` is never mutated,
    and the assertion at the end proves it, because the final model — the shipped
    artifact — is fitted on the whole-frame matrix on purpose.

    An X memory-mapped from beside the pickle takes the first branch: each fold
    is fitted from RowChunks and predicted by predict_rows, the map written into
    each chunk's copy, so neither X[tr] nor X[va] is ever made whole. Same
    boosters and out-of-fold predictions as the second branch.
    """
    oof = np.full(len(y), np.nan)
    per_city = {}
    shifts = {}
    guard = None
    if fold_cats is not None and fold_cats.active:
        guard = {j: X[:, j].copy() for j in fold_cats.col_index.values()}
    if reads_in_chunks(X):
        for i, (train_rows, va, city) in enumerate(_fold_parts(folds)):
            fold_cols = None
            if fold_cats is not None and fold_cats.active:
                fold_cols = fold_cats.columns_for_fold(city)
                shifts[str(city)] = fold_cats.fold_shift(X, fold_cols)
            t0 = time.time()
            m = clone(model)
            m.fit(RowChunks(X, train_rows, y, sample_weight, fold_cats=fold_cats,
                            fold_cols=fold_cols, chunk_rows=chunk_rows), None)
            del train_rows
            oof[va] = predict_rows(m, X, va, fold_cats=fold_cats, fold_cols=fold_cols,
                                   chunk_rows=chunk_rows)
            per_city[str(city)] = va
            logger.info('  fold %d/%d: %s held out (%d rows), %.0fs',
                        i + 1, len(folds), city, len(va), time.time() - t0)
            del m, fold_cols
    else:
        # One fold's copies at a time: the validation copy is made after the fit,
        # and both are released before the next fold's are made, so the loop holds
        # X and one training copy rather than X and two whole-matrix pairs.
        for tr, va, city in folds:
            fold_cols = None
            if fold_cats is not None and fold_cats.active:
                fold_cols = fold_cats.columns_for_fold(city)
                shifts[str(city)] = fold_cats.fold_shift(X, fold_cols)
            Xtr = X[tr]
            if fold_cols is not None:
                fold_cats.apply_to(Xtr, tr, fold_cols)
            m = clone(model)
            m.fit(Xtr, y[tr], sample_weight=sample_weight[tr])
            del Xtr, tr
            Xva = X[va]
            if fold_cols is not None:
                fold_cats.apply_to(Xva, va, fold_cols)
            oof[va] = m.predict(Xva)
            per_city[str(city)] = va
            del Xva, m, fold_cols

    if guard is not None:
        for j, col in guard.items():
            if not np.array_equal(X[:, j], col):
                raise LeakageError(
                    f'The per-fold category refit mutated feature column {j} of the shared '
                    'matrix. The final model is fitted on X after this function returns, so '
                    'a leftover fold map would ship a model whose features do not match the '
                    'category_baselines metadata mlPredictor.js serves.')

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
    return overall, absolute, city_metrics, shifts


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

# The model's size, changed only by an explicit switch. The November runbook
# (2026-11-25) chooses depth and tree count with the capacity probe on training
# cities, and the choice reaches every candidate and the final refit through
# these two variables. Unset, FIXED_PARAMS stands. Only the size moves: the
# learning rate and every other setting stay as registered.
SIZE_SWITCHES = {
    'FLOCK_MAX_DEPTH': ('max_depth', 1, 16),
    'FLOCK_N_ESTIMATORS': ('n_estimators', 1, 20000),
}


def size_overrides() -> dict:
    """{param: value} for each size switch that is set; {} when none is.

    A value that is not a whole number in range is refused, never rounded or
    clipped, so a typo cannot train a model of a size nobody chose. A switch
    that is present but blank (a failed shell substitution) is refused too,
    rather than read as unset.
    """
    out = {}
    for var, (param, lo, hi) in SIZE_SWITCHES.items():
        if var not in os.environ:
            continue
        raw = os.environ[var].strip()
        if not raw.isdigit() or not raw.isascii():
            raise ValueError(f'{var}={raw!r} must be a whole number from {lo} to {hi}.')
        value = int(raw)
        if not lo <= value <= hi:
            raise ValueError(f'{var}={value} must be from {lo} to {hi}.')
        out[param] = value
    return out


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
                            baseline, y_actual, clamp, rounds, fold_cats=None,
                            chunk_rows=None) -> tuple:
    """Choose n_estimators on held-out CITIES, scored with the gate's own metric.

    The eval metric is MAE on the reconstructed absolute scale — the same
    quantity quick_eval.py's gate compares against the popular_times baseline
    and against the incumbent. Stopping on RMSE, or on the raw delta, would tune
    the model on one number and judge it on another.

    The category label-means are refitted on this split's training side too, for
    the same reason they are refitted per CV fold: otherwise the stopping round
    is chosen against held-out cities that helped build their own features.
    """
    tr, va, held = early_stopping_split(groups)
    va_baseline = np.asarray(baseline, dtype=np.float64)[va]
    va_actual = np.asarray(y_actual, dtype=np.float64)[va]

    def gate_mae(y_true, y_pred):
        return float(np.mean(np.abs(va_actual - reconstruct(np.asarray(y_pred, dtype=np.float64),
                                                            va_baseline, clamp))))

    probe = clone(base_model).set_params(**params, early_stopping_rounds=rounds,
                                         eval_metric=gate_mae)
    if reads_in_chunks(X):
        # X beside the pickle: both sides are fed a row chunk at a time, the map
        # written into each chunk's copy. Same stopping round and booster as below.
        fold_cols = None
        if fold_cats is not None and fold_cats.active:
            fold_cols = fold_cats.columns_for_fold(held)
        probe.fit(RowChunks(X, tr, y, sample_weight, fold_cats=fold_cats, fold_cols=fold_cols,
                            chunk_rows=chunk_rows), None,
                  eval_set=[(RowChunks(X, va, y, fold_cats=fold_cats, fold_cols=fold_cols,
                                       chunk_rows=chunk_rows), None)], verbose=False)
    else:
        Xtr, Xva = X[tr], X[va]
        if fold_cats is not None and fold_cats.active:
            fold_cols = fold_cats.columns_for_fold(held)
            fold_cats.apply_to(Xtr, tr, fold_cols)
            fold_cats.apply_to(Xva, va, fold_cols)
        probe.fit(Xtr, y[tr], sample_weight=sample_weight[tr],
                  eval_set=[(Xva, y[va])], verbose=False)

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
        'category_baselines_refit_on_train_side': bool(fold_cats is not None
                                                       and fold_cats.active),
        'note': ('n_estimators was chosen on these cities and the final model is then '
                 'refit on ALL cities, so the LOCO folds covering them are mildly '
                 'optimistic by one integer of hyperparameter choice. The ship gate is '
                 'measured on the separate holdout cities and is unaffected.'),
    }
    return best_iter, info


def train_xgboost(X, y, cv, folds, groups, baseline, y_actual, sample_weight, clamp,
                  device, threads, fold_cats=None, chunk_rows=None) -> tuple:
    logger.info('\n=== Training XGBoost ===')
    start = time.time()

    base_model = XGBRegressor(
        random_state=RANDOM_STATE,
        tree_method='hist',
        device=device,
        n_jobs=threads,
        verbosity=0,
    )

    sizes = size_overrides()
    if os.environ.get('FLOCK_HYPERPARAM_SEARCH', '').strip().lower() == 'true':
        if sizes:
            raise ValueError(
                f'FLOCK_HYPERPARAM_SEARCH=true and a size switch ({sorted(sizes)}) are both '
                'set: the search would choose the size the switch names. Unset one.')
        if reads_in_chunks(X):
            raise ValueError(
                'FLOCK_HYPERPARAM_SEARCH=true, but X lives beside the pickle (features_io): '
                'RandomizedSearchCV fits every candidate on whole in-memory copies of the '
                'matrix, which is what keeping X outside the pickle avoids. Search on a frame '
                'that keeps X in the pickle, or leave the search off.')
        logger.info('Running the grouped randomized search (%d candidates x %d folds)...',
                    SEARCH_ITERATIONS, cv.get_n_splits())
        params, hp_info = run_hyperparameter_search(base_model, X, y, cv, groups, sample_weight)
    else:
        params = {**FIXED_PARAMS, **sizes}
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
    # Which switch set the size, by variable name; {} means FIXED_PARAMS' size.
    hp_info['size_switches'] = {var: sizes[param] for var, (param, _, _) in SIZE_SWITCHES.items()
                                if param in sizes}

    es_info = {'enabled': False,
               'note': 'n_estimators is fixed; no early stopping. If it is turned on '
                       '(FLOCK_EARLY_STOPPING_ROUNDS), the eval set is whole held-out '
                       'cities and the metric is the gate\'s MAE.'}
    es_rounds = int(os.environ.get('FLOCK_EARLY_STOPPING_ROUNDS', '0') or 0)
    if es_rounds > 0:
        best_iter, es_info = fit_with_early_stopping(
            base_model, params, X, y, groups, sample_weight, baseline, y_actual,
            clamp, es_rounds, fold_cats=fold_cats, chunk_rows=chunk_rows)
        params = {**params, 'n_estimators': best_iter}
    if hp_info.get('searched_this_run') is False:
        # The fixed path's note names every value that is not the v2.3.0 search's;
        # with no switch and no early stopping it stays as it was.
        moved = []
        if sizes:
            moved.append('the size switches set ' + ' and '.join(sorted(sizes)) + ' (size_switches)')
        if es_rounds > 0:
            moved.append('early stopping chose n_estimators (early_stopping)')
        if moved:
            said = '; '.join(moved)
            hp_info['note'] += f" {said[0].upper()}{said[1:]}; every other value is the v2.3.0 search's."

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
    # The SHIPPED fit, on the matrix prepare_features wrote — whole-frame category
    # maps included, because those are the maps mlPredictor.js is handed and
    # serves. Only the fold fits below swap in a fold-local map.
    if reads_in_chunks(X):
        model.fit(RowChunks(X, None, y, sample_weight, chunk_rows=chunk_rows), None)
    else:
        model.fit(X, y, sample_weight=sample_weight)

    logger.info('Computing leave-one-city-out metrics...')
    metrics, absolute, per_city, cat_shifts = evaluate_city_cv(
        model, X, y, folds, baseline, y_actual, sample_weight, clamp,
        fold_cats=fold_cats, chunk_rows=chunk_rows)
    elapsed = time.time() - start

    logger.info('City CV RMSE: %.4f, MAE: %.4f, R2: %.4f',
                metrics['rmse'], metrics['mae'], metrics['r2'])
    logger.info('Within 10 pts: %s%%', metrics['within_10'])
    logger.info('Training time: %.1fs', elapsed)

    return (model, metrics, absolute, per_city, params, hp_info, es_info, elapsed,
            cat_shifts)


# What main() reads from features_train.pkl; realtime_flags falls back to X and
# feature_cols for a pickle written before is_realtime was carried.
TRAINER_KEYS = ('X', 'y', 'feature_cols', 'cities', 'baseline', 'y_actual', 'sample_weight',
                'label_provenance', 'label_type', 'is_realtime', 'run_length_divisor',
                'category_cell_stats')


def main():
    logger.info('Loading prepared features...')
    features_path = SCRIPT_DIR / 'features_train.pkl'
    if not features_path.exists():
        raise FileNotFoundError(
            f'{features_path} does not exist. Run `node export_training_data.js` then '
            '`python prepare_features.py` first — a retrain starts at the export.')
    # X in the pickle loads as pickle.load gave it; X beside it (features_io) is
    # memory-mapped read-only after its SHA-256 is checked against the pickle, and
    # is then fitted and predicted a row chunk at a time (RowChunks).
    data = load_features(features_path, verify=True)
    if reads_in_chunks(data['X']):
        logger.info('X is memory-mapped from %s (%d x %d); it is read a row chunk at a time.',
                    data.get('X_file'), *data['X'].shape)
    # Only the keys this script reads stay in memory for the run. The others
    # (hour, venue_category, label_source, observed_date, ...) are for
    # evaluate_model.py and the diagnostics, and at the third candidate's size
    # they are several GB the whole run would otherwise hold.
    data = {k: v for k, v in data.items() if k in TRAINER_KEYS}

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

    # The carried key (prepare_features.realtime_flags), never a zero fill: the
    # weight tiers and the realtime_served slice mlPredictor publishes as the
    # card's confidence are both cut on it.
    is_realtime = realtime_flags(data) == 1
    if len(is_realtime) != n:
        raise ValueError(f'is_realtime has {len(is_realtime)} rows but y has {n}. Re-run '
                         'prepare_features.py.')
    weight_tiers = assert_weighting_matches_provenance(sample_weight, is_realtime, provenance,
                                                       data.get('run_length_divisor'))

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
    size_overrides()  # a malformed size switch stops the run here, before any fit
    env = environment_fingerprint(device, device_reason, threads)
    logger.info('Training device: %s (%s), threads: %d, reproducible: %s',
                device, device_reason, threads, env['bit_reproducible'])

    cv = GroupKFold(n_splits=n_cities)
    logger.info('Using GroupKFold with %d splits (leave-one-city-out)', n_cities)
    folds = assert_group_disjoint(cv, X, y, cities)

    fold_cats = FoldCategoryBaselines(data.get('category_cell_stats'), cities,
                                      feature_cols, y_actual)
    # Before any fold is fitted: prove the refit is the shipped map minus a city,
    # and nothing else. Raises rather than reporting a confounded number.
    shipped_repro = fold_cats.verify_reproduces_shipped(X)

    (model, metrics, absolute, per_city, params, hp_info, es_info, elapsed,
     cat_shifts) = train_xgboost(
        X, y, cv, folds, cities, baseline, y_actual, sample_weight, clamp, device,
        threads, fold_cats=fold_cats)

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
                       '.realtime_served for the rows production scores. Each fold\'s '
                       'category_baseline / refined_category_baseline were rebuilt from '
                       'that fold\'s own training rows — see training_contracts.'
                       'category_baselines_refit_per_fold.'),
    }
    metadata['training_metrics_by_population'] = slices
    metadata['training_loco_per_city'] = per_city
    metadata['cv_method'] = f'GroupKFold(n_splits={n_cities}) - leave-one-city-out'
    metadata['training_cities'] = [str(c) for c in unique_cities]
    metadata['training_city_rows'] = city_rows
    metadata['training_environment'] = {**env, 'training_seconds': round(elapsed, 1)}

    if fold_cats.active:
        moved = [s['category_baseline']['rows_changed_pct'] for s in cat_shifts.values()]
        shift = [s['category_baseline']['mean_abs_shift'] for s in cat_shifts.values()]
        cat_refit_contract = {
            'applies_to': 'every leave-one-city-out fold, and the early-stopping split '
                          'when it is enabled',
            'features': list(CATEGORY_FEATURES),
            'method': ('both maps are rebuilt from the fold\'s TRAINING rows only, using '
                       'the per-(city, cell) label sums and counts in '
                       'features_train.pkl["category_cell_stats"], with the coarse map\'s '
                       '0.6/0.2/0.2 adjacent-hour smoothing redone over the cells that '
                       'fold supports. One value per cell, shared by the fold\'s training '
                       'and validation rows alike.'),
            'why_one_value_per_cell': (
                'a per-city ("leave-one-city-out computed once") map is NOT equivalent and '
                'was measured roughly six times worse than the leak it removes: the feature '
                'then varies by city inside a fold and its deviation from the cell\'s '
                'typical value is an invertible function of the held-out city\'s own '
                'labels. It also passes a label-perturbation invariance check, so this fix '
                'is validated against a held-out population instead.'),
            'final_model_unchanged': (
                'the shipped artifact is still fitted on the whole-frame matrix, which '
                'carries the same maps served as metadata.category_baselines'),
            'isolates_the_leak': (
                'the aggregates are fitted on the pre-filter frame, the same population '
                'build_category_baseline_maps fits the shipped map on, so the ONLY '
                'difference a fold map carries is the held-out city. Verified before '
                'training rather than asserted: holding out no city reproduces the '
                'shipped columns with max |diff| = '
                f'{shipped_repro!r}. An earlier version of these statistics was '
                'aggregated after the serving-population filter, which moved the '
                'feature ~9.3 points on 99.9% of rows against ~0.17 for the leak '
                'itself; that pickle is now refused by version.'),
            'shipped_column_reproduced_max_abs_diff': shipped_repro,
            'cell_stats_version': fold_cats.version,
            'cells': {'category': fold_cats.blocks['category']['n_cells'],
                      'refined': fold_cats.blocks['refined']['n_cells'],
                      'groups': len(fold_cats.groups)},
            'alignment_checked': ('row_cell/row_group are positional indexes into X; the '
                                  'shipped sums and counts were re-derived from this '
                                  'pickle\'s own rows and matched exactly'),
            'fold_feature_shift': {
                'rows_changed_pct_min': round(float(min(moved)), 2),
                'rows_changed_pct_max': round(float(max(moved)), 2),
                'mean_abs_shift_min': round(float(min(shift)), 4),
                'mean_abs_shift_max': round(float(max(shift)), 4),
            },
            'per_fold': cat_shifts,
        }
    else:
        cat_refit_contract = {'applies_to': 'nothing', 'reason': fold_cats.reason}

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
        'category_baselines_refit_per_fold': cat_refit_contract,
        # Kept as a key, and kept honest. The leak that made the REPORTED
        # cross-validation optimistic is closed above; what remains is named here
        # so nobody reads a missing key as "there was never anything here".
        'known_residual_leak': (
            'CLOSED FOR THE REPORTED METRICS, still present in the shipped feature '
            'matrix by design. category_baseline and refined_category_baseline are '
            'averages of busyness_pct that prepare_features.py fits on the WHOLE '
            'training frame; every fold above now rebuilds both from that fold\'s own '
            'training rows (see category_baselines_refit_per_fold), so a held-out city '
            'no longer contributes to the cells its rows are scored against and '
            'training_metrics / training_metrics_by_population / training_loco_per_city '
            'are no longer inflated by it. The final artifact is deliberately still '
            'fitted on the whole-frame matrix, because that map is the one shipped as '
            'metadata.category_baselines and served by mlPredictor.js — inference has '
            'no held-out group. The ship gate never had this leak: it is measured on '
            'the separate holdout cities, whose category features were built from '
            'training rows only. NOTE: corpus_contract.category_baseline_fit says OPEN '
            'IN THIS FILE — correctly, about prepare_features.py itself: that file does '
            'fit on the frame it applies to, and it cannot do otherwise, because being '
            'constant within a fold is what makes the correction honest and '
            'prepare_features has no folds. What it leaks is the reported CV number, '
            'and this is where that is closed.'),
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
