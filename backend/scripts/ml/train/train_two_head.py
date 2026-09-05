"""
Two-head crowd model, the v2.7 candidate: a PROFILE head plus a DEVIATION head.

WHY TWO HEADS. The shipped v2.6.0-starling is one delta regressor fitted on a
corpus that is 81% weekly rows at sample weight 0.05 and 19% live readings at
weight 1.0. On a weekly row the label equals the smoothed baseline by
construction, so the correct delta is about zero, and those rows exist to
anchor ordinary nights. They do that job by shrinking every deviation the
model learns toward zero, on the only rows that carry a real deviation. This
script gives the two jobs to two models. A PROFILE head learns a venue's
typical curve from the weekly rows alone (label: busyness_pct). A DEVIATION
head learns how a live reading departs from that curve from the realtime rows
alone (label: busyness_pct minus the profile head's own prediction for the
row). Serving adds them: score = profile + clamp(deviation). That is roughly
how Popular Times is structured: a typical curve, then a live correction.

WHAT THE PROFILE HEAD SEES, AND WHY THAT INCLUDES THE STORED BASELINE.
train_model.py forbids baseline_busyness as a feature and is right to: for a
delta model the baseline is the label side of the target. The profile head has
a different target. On a venue with a stored curve its job is to reproduce and
smooth that curve, and on one without it is to fall back to what the category
and the neighbours say, so the stored baseline is its most important input
rather than its answer. It is the same number services/mlPredictor.js already
builds as `baseline_busyness` in buildFeatureMap (the smoothed value
getBaseline returns), so serving needs no new feature for it. What the profile
head does NOT see: weather, events, special nights, the calendar epoch (month,
season, school break, holiday), astronomy and user feedback. A typical week has
no weather. On weekly rows those columns describe the moment a collection
batch happened to run, which is the fabrication repairWeeklyWeather.js clears,
and a curve that depends on them is a curve that moves with the collector's
clock.

WHAT THE DEVIATION HEAD SEES. Every servable feature the shipped model sees,
minus is_realtime (constant 1 on its rows, constant 1 at serving), plus
baseline_busyness and the profile head's prediction (profile_pred). Those two
are what let it learn mean reversion in the coordinates it is scored in: a
venue whose curve says 90 at 10 PM tends to read lower live, and a delta model
that cannot see the level cannot learn that.

WHICH LOSS, AND WHY IT IS THE POINT. The deviation head is fitted with
reg:absoluteerror, the conditional MEDIAN, and the profile head with the
default squared error. The served number is scored on MAE and on within-N hit
rates, and the median is the functional MAE is consistent for (Gneiting 2011,
cited in QMAP-DECISION.md). A squared-error head learns the conditional mean
of a deviation whose distribution is bimodal (a quarter of served venue-hours
at or below 5, a quarter at or above 90), and the mean of two modes is a
number in the middle that neither mode contains. Measured on the pre-merge
served holdout (67,249 rows, 2026-09-04) before the loss was fixed here: the
squared-error head won point MAE by 0.62 against the shipped model and lost
within-15 by 2.7pp and band exact by 3.5pp, with its prediction spread
compressed from 22.2 to 16.3. The same head under absolute error won MAE by
0.92, within-15 by 2.8pp and band exact by 2.9pp at spread 22.8. That grid is
in the report; the objective was fixed here before the post-merge corpus was
scored, so the post-merge number is a confirmation and not a second search.

WHICH ROWS. Profile: is_realtime == 0, label_provenance 'weekly'. Deviation:
is_realtime == 1 with label_provenance 'live', and nothing else by default.
'forecast' and 'owner_report' are known NOT to be observations of a room.
'unknown' is the 457,402-row March to May window where migration 025 proved a
live reading and a vendor forecast cannot be told apart; a deviation head fed
those may be learning labels that equal the baseline by construction, which is
the shrinkage this design exists to escape. FLOCK_TWO_HEAD_ADMIT_UNKNOWN=true
admits them at the live weight, the policy is written into the metadata as
two_head.deviation.provenance_policy, and a run that used it is not a clean
run. The run reports how many rows of each provenance it used and refused.
Both populations come from features_train.pkl, which prepare_features.py
already filtered to baseline > 0, the population production serves.

THE PROVEN-LIVE FORWARD SLICE. The geographic holdout cities carry no 'live'
row at all (every realtime row there is from the March to May window), so the
served holdout cannot say how either model does on a label that is known to be
a room. The latest FLOCK_TWO_HEAD_LIVE_HOLDOUT_DAYS observation dates among the
'live' rows (default 1) are therefore held out of ALL training here, written
to <out dir>/live_holdout.pkl, and eval_two_head.py scores both artifacts on
them as a labelled diagnostic beside the gate table. Small, by construction:
it is as many proven rows as the nightly cron has written for those dates.

WHAT IT REUSES, AND WHAT IT DOES NOT TOUCH. The feature matrix from
prepare_features.py (never edited here: the two heads select columns by
name), FIXED_PARAMS, the device and thread pinning, the metric helpers and the
per-fold category refit from train_model.py, and the ONNX conversion plus
graph verification from export_model.py. Which pickle columns a head may use
is asked of services/mlPredictor.js itself: a node probe hands the pickle's
column names to missingFeatureNames and whatever buildFeatureMap cannot
produce is dropped and named in the metadata, so the candidate can never
carry a feature the server would zero-fill. The sports_* ablation columns go
that way, and so does any column prepare_features grows before its inference
twin lands. If node is unavailable the shipped artifact's feature_names stand
in as the servable vocabulary. The serving maps (category_baselines,
refined_baselines, category_encoding, top_google_types, the medians,
temp_norms) are copied from the metadata of the prepare_features run the
pickles came from, and the copy is checked against the pickle's own
category_baseline column before anything is trained.

WHAT IT WRITES, AND WHERE. models/candidate/ only: profile.onnx,
deviation.onnx and model_metadata.json with label_type 'two_head'. The shipped
artifact in models/ is never written. The candidate carries NO ship_gate until
eval_two_head.py has scored it against the shipped ONNX on the served holdout
and written one, so mlPredictor.init() refuses it until then. That is the
fail-closed behaviour the single-head path has, kept on purpose.

Environment knobs, all recorded in the metadata:
  FLOCK_TRAIN_DEVICE=auto|cpu|cuda    train_model.resolve_device, default auto
  FLOCK_TRAIN_THREADS=<int>           train_model.resolve_threads
  FLOCK_TWO_HEAD_CV=loco|none|<k>     default loco (one city held out per fold)
  FLOCK_TWO_HEAD_METADATA=<path>      where the serving maps come from; default
                                      models/candidate/prepared_metadata.json
                                      when run_two_head.sh has staged it, else
                                      models/model_metadata.json
  FLOCK_TWO_HEAD_DIR=<path>           output directory, default models/candidate
  FLOCK_TWO_HEAD_ADMIT_UNKNOWN=true   admit 'unknown' provenance rows to the
                                      deviation head (NOT a clean run; recorded)
  FLOCK_TWO_HEAD_LIVE_HOLDOUT_DAYS=n  proven-live dates held out for the
                                      forward slice, default 1, 0 to disable
  MODEL_VERSION=<string>              default 2.7.0-two-head-candidate
"""

import json
import logging
import os
import pickle
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.base import clone
from sklearn.model_selection import GroupKFold
from xgboost import XGBRegressor

from prepare_features import MIN_REALTIME_ROWS, serving_population_mask
from train_model import (FIXED_PARAMS, PER_CITY_MIN_ROWS, RANDOM_STATE,
                         FoldCategoryBaselines, LabelContractError, LeakageError,
                         _metrics, assert_delta_label, assert_group_disjoint,
                         environment_fingerprint, resolve_device, resolve_threads)
from export_model import compute_feature_types, convert, verify_graph, write_atomic

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

SCRIPT_DIR = Path(__file__).parent
MODELS_DIR = SCRIPT_DIR.parent / 'models'
CANDIDATE_DIR = MODELS_DIR / 'candidate'
OUT_DIR = Path(os.environ.get('FLOCK_TWO_HEAD_DIR', '').strip() or CANDIDATE_DIR)
BACKEND_DIR = SCRIPT_DIR.parent.parent.parent
DEFAULT_VERSION = '2.7.0-two-head-candidate'
LIVE_HOLDOUT_FILE = 'live_holdout.pkl'

# The loss per head. See the header: the deviation head is scored on MAE and
# hit rates, both of which the median serves and the mean does not.
PROFILE_OBJECTIVE = 'reg:squarederror'
DEVIATION_OBJECTIVE = 'reg:absoluteerror'

# The serve clamp production applies to the delta model (mlPredictor.js
# DELTA_CLAMP_LO/HI). The deviation head is clamped the same width so the two
# candidates are compared under one rule; recorded in the metadata as
# two_head.deviation_clamp, which is the value mlPredictor.js reads.
DEVIATION_CLAMP = (-50.0, 50.0)

# The two features this script adds on top of prepare_features' matrix.
# baseline_busyness is a column the pickle carries separately (as `baseline`),
# never inside X; profile_pred is the profile head's own output.
BASELINE_FEATURE = 'baseline_busyness'
PROFILE_FEATURE = 'profile_pred'

ADMIT_UNKNOWN = os.environ.get('FLOCK_TWO_HEAD_ADMIT_UNKNOWN', '').strip().lower() == 'true'
LIVE_PROVENANCES = frozenset({'live', 'unknown'}) if ADMIT_UNKNOWN else frozenset({'live'})
PROVENANCE_POLICY = ('live + unknown ADMITTED at the live weight (FLOCK_TWO_HEAD_ADMIT_UNKNOWN); '
                     'not a clean run' if ADMIT_UNKNOWN else 'live only (clean)')
MIN_PROFILE_ROWS = 100_000
# The deviation head's own floor. prepare_features refuses a corpus with
# fewer than MIN_REALTIME_ROWS proven rows; that guard has already run by the
# time a pickle exists, and a head fitted on fewer rows than this is noise
# whatever the verdict says.
MIN_DEVIATION_ROWS = 1_000
LIVE_HOLDOUT_DAYS = int(os.environ.get('FLOCK_TWO_HEAD_LIVE_HOLDOUT_DAYS', '1') or 0)
SERVABLE_PROBE_TIMEOUT_S = 180

# What a typical-week curve is NOT a function of. Prefix families first, then
# the named columns. Everything not listed here that the shipped model sees is
# a profile feature: the clock, the calendar-free time flags, venue attributes,
# the Google-type one-hots, the category curves, the neighbour curve.
PROFILE_EXCLUDED_PREFIXES = ('weather_', 'season_', 'etype_', 'event_x_')
PROFILE_EXCLUDED = frozenset({
    'is_realtime',
    'temperature', 'humidity', 'wind_speed', 'is_raining', 'rain_x_dinner',
    'rain_x_weekend', 'cold_outdoor', 'temp_anomaly', 'is_warm_anomaly_evening',
    'daylight_hours', 'hours_after_sunset', 'is_after_sunset',
    'month', 'month_sin', 'month_cos', 'is_holiday', 'is_school_break',
    'is_holiday_eve', 'is_special_night', 'special_boost', 'special_suppress',
    'has_nearby_event', 'nearest_event_attendance', 'log_nearest_event_attendance',
    'nearest_event_distance_km', 'total_nearby_events', 'total_nearby_attendance',
    'log_total_nearby_attendance', 'large_event_nearby',
    'avg_prediction_error', 'avg_user_crowd', 'log_user_feedback_count',
    'has_user_feedback',
})

# Refused in BOTH heads, by name. The list is train_model.FORBIDDEN_FEATURES
# minus baseline_busyness (allowed here, see the header) plus the carried
# columns prepare_features never featurises. is_realtime is refused because it
# is constant within each head's population and constant at serving.
FORBIDDEN_IN_BOTH = {
    'busyness_pct': 'the absolute label',
    'delta_label': 'the delta target',
    'y_actual': 'the absolute label',
    'sample_weight': 'the training weight, encodes the label regime',
    'label_provenance': 'encodes the label regime',
    'label_source': 'encodes the label regime',
    'vendor_forecast_pct': 'equals the label on forecast rows',
    'events_observed': 'a proxy for which cities had event coverage',
    'venue_id': 'an identifier, pure venue memorisation',
    'latitude': 'geographic overfitting',
    'longitude': 'geographic overfitting',
    'lat_bin': 'geographic overfitting',
    'lng_bin': 'geographic overfitting',
    'has_venue_baseline': 'constant 1 on every servable row',
    'is_realtime': 'constant within each head and constant at serving',
}

# Keys mlPredictor.buildFeatureMap reads from the metadata. They are copied
# from the prepare_features run the pickles came from, never recomputed here.
SERVING_MAP_KEYS = [
    'category_encoding', 'median_price_level', 'median_rating', 'median_review_count',
    'top_google_types', 'temp_norms', 'weather_code_groups', 'category_baselines',
    'refined_baselines', 'corpus_contract', 'feedback_error_semantics',
]

COPY_DETECTION_THRESHOLD = 0.99
COPY_DETECTION_SAMPLE = 200_000


# ---------------------------------------------------------------------------
# Which pickle columns the server can build. Asked of mlPredictor.js directly:
# the probe loads the shipped artifact (buildFeatureMap reads its maps), hands
# it every candidate name, and reads back the ones it cannot produce. That is
# the check mlPredictor.init() performs at load, run before training instead
# of after, so a feature with no inference twin is dropped here rather than
# refused there.
# ---------------------------------------------------------------------------
PROBE_SCRIPT = (
    "console.log = console.warn = console.error = () => {};"
    "const m = require('./services/mlPredictor');"
    "m.init().then((ok) => {"
    "  if (!ok) { process.stdout.write(JSON.stringify({ ok: false })); process.exit(0); }"
    "  const names = JSON.parse(process.argv[1]);"
    "  const missing = m._internals.missingFeatureNames({ feature_names: names });"
    "  process.stdout.write(JSON.stringify({ ok: true, missing }));"
    "  process.exit(0);"
    "}).catch((e) => { process.stderr.write(String(e)); process.exit(2); });"
)


def servable_feature_names(candidates) -> tuple:
    """(servable names, unservable names, how it was decided)."""
    try:
        run = subprocess.run(['node', '-e', PROBE_SCRIPT, json.dumps(list(candidates))],
                             cwd=str(BACKEND_DIR), capture_output=True, text=True,
                             timeout=SERVABLE_PROBE_TIMEOUT_S)
        answer = json.loads(run.stdout.strip() or '{}') if run.returncode == 0 else {}
    except (OSError, subprocess.SubprocessError, ValueError) as err:
        logger.warning('servable-feature probe could not run (%s)', err)
        answer = {}
    if answer.get('ok') is True and isinstance(answer.get('missing'), list):
        missing = set(answer['missing'])
        return ([c for c in candidates if c not in missing], sorted(missing),
                'mlPredictor.missingFeatureNames probe against the shipped artifact')
    shipped = MODELS_DIR / 'model_metadata.json'
    with open(shipped, 'r', encoding='utf-8') as f:
        vocabulary = set(json.load(f).get('feature_names') or [])
    if not vocabulary:
        raise LabelContractError('neither the serving probe nor models/model_metadata.json '
                                 'can say which features are servable')
    logger.warning('servable-feature probe unavailable; falling back to the shipped '
                   'artifact\'s feature_names as the vocabulary')
    return ([c for c in candidates if c in vocabulary],
            sorted(c for c in candidates if c not in vocabulary),
            'fallback: models/model_metadata.json feature_names')


# ---------------------------------------------------------------------------
# Feature lists, one per head. Sorted, because mlPredictor.js orders each
# head's vector by that head's feature_names and export_model's contract is
# that a sorted list is the only checkable half of a positional contract.
# ---------------------------------------------------------------------------
def head_feature_lists(feature_cols, servable) -> tuple:
    base = [c for c in feature_cols if c in servable and c not in FORBIDDEN_IN_BOTH]
    profile = sorted(
        [c for c in base
         if c not in PROFILE_EXCLUDED and not c.startswith(PROFILE_EXCLUDED_PREFIXES)]
        + [BASELINE_FEATURE])
    deviation = sorted(base + [BASELINE_FEATURE, PROFILE_FEATURE])
    for names in (profile, deviation):
        dupes = sorted({c for c in names if names.count(c) > 1})
        if dupes:
            raise LabelContractError(f'a head lists {dupes} more than once')
        hits = [c for c in names if c in FORBIDDEN_IN_BOTH]
        if hits:
            raise LeakageError(f'forbidden feature(s) reached a head: {hits}')
    return profile, deviation


def build_matrix(names, rows, X, feature_cols, baseline, profile_pred_rows=None,
                 overrides=None) -> np.ndarray:
    """One head's matrix for `rows`, column by column, by NAME.

    `profile_pred_rows` is already aligned to `rows`. `overrides` maps a feature
    name to a FULL-length column that replaces X's, which is how a fold's
    rebuilt category maps get in without copying the whole matrix.
    """
    col_index = {c: j for j, c in enumerate(feature_cols)}
    out = np.empty((len(rows), len(names)), dtype=np.float32)
    for j, name in enumerate(names):
        if name == BASELINE_FEATURE:
            col = baseline[rows]
        elif name == PROFILE_FEATURE:
            if profile_pred_rows is None:
                raise LabelContractError('the deviation matrix needs profile_pred')
            col = profile_pred_rows
        elif overrides and name in overrides:
            col = overrides[name][rows]
        else:
            col = X[rows, col_index[name]]
        out[:, j] = col
    return out


def reconstruct_two_head(profile, deviation, clamp, rounded=False) -> np.ndarray:
    """The serving arithmetic, one formula in two languages.

    mlPredictor.js reconstructTwoHeadScore:
        curve = clamp(profile, 0, 100)
        correction = clamp(deviation, lo, hi)
        score = round(clamp(curve + correction, 0, 100))

    Training-side metrics leave the rounding off, the way train_model.reconstruct
    does; eval_two_head.py rounds, the way quick_eval.reconstruct does since
    2026-08-28. __tests__/mlTwoHeadReconstruction.test.js pins the JS side.
    """
    lo, hi = clamp
    score = np.clip(np.clip(profile, 0, 100) + np.clip(deviation, lo, hi), 0, 100)
    return np.round(score) if rounded else score


# ---------------------------------------------------------------------------
# Contracts. Each one stops the run rather than producing a number.
# ---------------------------------------------------------------------------
def assert_no_copy(names, M, targets, exempt) -> dict:
    """No head feature may be a near-copy of a label it is scored against.

    `exempt` names the columns that are allowed to track a target and says why
    (the profile head's baseline input on weekly rows IS the typical value it
    is asked to reproduce). Everything else is held to the same 99% rule
    train_model.assert_no_label_shaped_feature uses.
    """
    n = M.shape[0]
    rng = np.random.default_rng(RANDOM_STATE)
    sample = rng.choice(n, size=min(n, COPY_DETECTION_SAMPLE), replace=False)
    worst = {'feature': None, 'reference': None, 'match_pct': 0.0}
    for j, name in enumerate(names):
        if name in exempt:
            continue
        col = M[sample, j].astype(np.float64)
        for ref_name, ref in targets.items():
            r = np.asarray(ref, dtype=np.float64)[sample]
            match = float(np.mean(np.abs(col - r) <= 0.5))
            if match > worst['match_pct']:
                worst = {'feature': name, 'reference': ref_name,
                         'match_pct': round(match * 100, 2)}
            if match >= COPY_DETECTION_THRESHOLD:
                raise LeakageError(
                    f'{name} matches {ref_name} on {match * 100:.1f}% of sampled rows. '
                    'A head feature that copies its own label trains a model with a '
                    'wonderful number and no value.')
    return {'features_checked': len(names) - len([c for c in names if c in exempt]),
            'exempt': {k: v for k, v in exempt.items()},
            'sampled_rows': int(len(sample)), 'threshold_pct': COPY_DETECTION_THRESHOLD * 100,
            'closest_match': worst}


def verify_serving_maps(meta, X, feature_cols, hour, venue_category) -> dict:
    """The metadata's category curve must be the one the pickle's column holds.

    The candidate ships metadata.category_baselines so buildFeatureMap can
    build category_baseline at serving time. If that map came from a different
    prepare_features run than the pickles, the model is trained against one
    curve and served another. Checked on a sample, exactly, before training.
    """
    for key in ('category_baselines', 'refined_baselines', 'category_encoding',
                'top_google_types'):
        if key not in meta:
            raise LabelContractError(
                f'the serving-map metadata carries no {key}; it is not the output of a '
                'prepare_features.py run')
    n = len(hour)
    rng = np.random.default_rng(RANDOM_STATE)
    sample = rng.choice(n, size=min(n, 300_000), replace=False)
    dow = X[sample, feature_cols.index('day_of_week')].astype(int)
    hrs = np.asarray(hour)[sample].astype(int)
    cats = np.asarray(venue_category)[sample]
    table = meta['category_baselines']
    col = X[sample, feature_cols.index('category_baseline')].astype(np.float64)
    looked = np.array([table.get(f'{c}_{d}_{h}', np.nan) for c, d, h in zip(cats, dow, hrs)])
    missing = int(np.isnan(looked).sum())
    diff = np.abs(looked[~np.isnan(looked)] - col[~np.isnan(looked)])
    worst = float(diff.max()) if len(diff) else 0.0
    if missing > 0 or worst > 0.051:
        raise LabelContractError(
            f'metadata.category_baselines does not reproduce the pickle\'s category_baseline '
            f'column: {missing} sampled rows have no map entry and the largest difference '
            f'is {worst:.3f}. The maps and the pickles are from different '
            'prepare_features.py runs. Point FLOCK_TWO_HEAD_METADATA at the metadata that '
            'run wrote (run_two_head.sh stages it as models/candidate/prepared_metadata.json).')
    logger.info('Serving maps verified against the pickle: %d sampled rows, 0 misses, '
                'max |category_baseline diff| = %.2e', len(sample), worst)
    return {'sampled_rows': int(len(sample)), 'map_misses': missing,
            'max_abs_diff': round(worst, 6)}


# ---------------------------------------------------------------------------
# Fitting
# ---------------------------------------------------------------------------
def make_model(device, threads, objective):
    return XGBRegressor(random_state=RANDOM_STATE, tree_method='hist', device=device,
                        n_jobs=threads, verbosity=0, objective=objective, **FIXED_PARAMS)


def fit_heads(base_models, names, rows_profile, rows_deviation, X, feature_cols, baseline,
              y_actual, overrides=None) -> tuple:
    """Fit the profile head, then the deviation head against its output.

    The deviation label is computed from the profile head fitted in THIS call,
    on the profile head's own feature list, so a fold's deviation head never
    sees a profile prediction that a held-out city helped build.
    """
    profile_base, deviation_base = base_models
    profile_names, deviation_names = names
    Xp = build_matrix(profile_names, rows_profile, X, feature_cols, baseline,
                      overrides=overrides)
    profile = clone(profile_base)
    profile.fit(Xp, y_actual[rows_profile])
    del Xp

    Xp_dev = build_matrix(profile_names, rows_deviation, X, feature_cols, baseline,
                          overrides=overrides)
    profile_on_dev = profile.predict(Xp_dev).astype(np.float32)
    del Xp_dev
    dev_label = (y_actual[rows_deviation].astype(np.float64)
                 - profile_on_dev.astype(np.float64)).astype(np.float32)
    Xd = build_matrix(deviation_names, rows_deviation, X, feature_cols, baseline,
                      profile_pred_rows=profile_on_dev, overrides=overrides)
    deviation = clone(deviation_base)
    deviation.fit(Xd, dev_label)
    del Xd
    label_stats = {
        'rows': int(len(rows_deviation)),
        'mean': round(float(dev_label.mean()), 4),
        'sd': round(float(dev_label.std()), 4),
        'min': round(float(dev_label.min()), 2),
        'max': round(float(dev_label.max()), 2),
        'share_outside_clamp_pct': round(float(np.mean(
            (dev_label < DEVIATION_CLAMP[0]) | (dev_label > DEVIATION_CLAMP[1])) * 100), 2),
    }
    return profile, deviation, label_stats


def predict_heads(profile, deviation, names, rows, X, feature_cols, baseline,
                  overrides=None) -> tuple:
    profile_names, deviation_names = names
    Xp = build_matrix(profile_names, rows, X, feature_cols, baseline, overrides=overrides)
    p = profile.predict(Xp).astype(np.float32)
    del Xp
    Xd = build_matrix(deviation_names, rows, X, feature_cols, baseline,
                      profile_pred_rows=p, overrides=overrides)
    d = deviation.predict(Xd).astype(np.float32)
    del Xd
    return p, d


def resolve_folds(mode, X, y_actual, cities) -> tuple:
    """'loco' (one city per fold, train_model's own check), an integer k
    (GroupKFold(k) on city, city-disjoint, several cities per fold), or 'none'."""
    unique = np.unique(cities)
    if mode == 'none':
        return [], 'none'
    if mode == 'loco':
        cv = GroupKFold(n_splits=len(unique))
        return assert_group_disjoint(cv, X, y_actual, cities), f'leave-one-city-out ({len(unique)} folds)'
    k = int(mode)
    if k < 2 or k > len(unique):
        raise ValueError(f'FLOCK_TWO_HEAD_CV={mode!r}: k must be between 2 and {len(unique)}')
    cv = GroupKFold(n_splits=k)
    seen = np.zeros(len(y_actual), dtype=np.int32)
    folds = []
    groups = np.asarray(cities)
    for tr, va in cv.split(X, y_actual, groups=groups):
        overlap = set(groups[tr]) & set(groups[va])
        if overlap:
            raise LeakageError(f'a fold trains and validates on {sorted(overlap)}')
        seen[va] += 1
        folds.append((tr, va, sorted(set(groups[va]))))
    if not np.all(seen == 1):
        raise LeakageError('every row must be validated exactly once')
    return folds, f'GroupKFold({k}) on city'


def cross_validate(folds, fold_cats, base_models, names, X, feature_cols, baseline,
                   y_actual, rows_profile_mask, rows_deviation_mask, is_realtime,
                   cities) -> tuple:
    n = len(y_actual)
    oof_profile = np.full(n, np.nan, dtype=np.float64)
    oof_deviation = np.full(n, np.nan, dtype=np.float64)
    per_city = {}
    for k, (tr, va, held) in enumerate(folds, 1):
        t0 = time.time()
        overrides = None
        if fold_cats is not None and fold_cats.active:
            fold_cols = fold_cats.columns_for_fold(held)
            overrides = {name: fold_cols[j] for name, j in fold_cats.col_index.items()}
        rows_profile = tr[rows_profile_mask[tr]]
        rows_deviation = tr[rows_deviation_mask[tr]]
        if len(rows_profile) == 0 or len(rows_deviation) == 0:
            raise LabelContractError(f'fold {k} has no rows for one of the heads')
        profile, deviation, _ = fit_heads(
            base_models, names, rows_profile, rows_deviation, X, feature_cols, baseline,
            y_actual, overrides=overrides)
        p, d = predict_heads(profile, deviation, names, va, X, feature_cols, baseline,
                             overrides=overrides)
        oof_profile[va] = p
        oof_deviation[va] = d
        va_rt = va[is_realtime[va]]
        absolute = reconstruct_two_head(p[is_realtime[va]], d[is_realtime[va]], DEVIATION_CLAMP)
        label = held if isinstance(held, str) else ','.join(held)
        if len(va_rt) < PER_CITY_MIN_ROWS:
            per_city[label] = {'rows': int(len(va_rt)),
                               'note': f'fewer than {PER_CITY_MIN_ROWS} realtime rows'}
        else:
            per_city[label] = {'rows': int(len(va_rt)),
                               **_metrics(y_actual[va_rt].astype(np.float64), absolute)}
        logger.info('fold %d/%d held out %s: %d profile rows, %d deviation rows, '
                    'realtime MAE %s, %.0fs', k, len(folds), label, len(rows_profile),
                    len(rows_deviation), per_city[label].get('mae', 'n/a'), time.time() - t0)
    if np.isnan(oof_profile).any() or np.isnan(oof_deviation).any():
        raise ValueError('some out-of-fold predictions are NaN')
    return oof_profile, oof_deviation, per_city


def population_report(y_actual, oof_profile, oof_deviation, is_realtime, baseline) -> dict:
    """train_model.slice_report's three populations, plus the profile alone."""
    absolute = reconstruct_two_head(oof_profile, oof_deviation, DEVIATION_CLAMP)
    served = serving_population_mask(baseline)
    y = y_actual.astype(np.float64)
    out = {'all_rows': {'rows': int(len(y)),
                        'population': 'every training row (weekly anchor + realtime), scored '
                                      'as profile + clamp(deviation) out of fold',
                        **_metrics(y, absolute)}}
    masks = {
        'realtime_served': (is_realtime & served,
                            'is_realtime == 1 AND baseline > 0, the serving_population_mask '
                            'quick_eval.py gates on. This is the honest accuracy.'),
        'weekly_anchor': (~is_realtime & served,
                          'weekly popular_times snapshots scored as profile + clamp(deviation). '
                          'The deviation head never trained on them. Diagnostic only.'),
    }
    for name, (mask, note) in masks.items():
        if int(mask.sum()) < 100:
            out[name] = {'rows': int(mask.sum()), 'population': note,
                         'note': 'fewer than 100 rows, not measured'}
            continue
        out[name] = {'rows': int(mask.sum()), 'population': note,
                     **_metrics(y[mask], absolute[mask])}
    wk = ~is_realtime & served
    if int(wk.sum()) >= 100:
        out['profile_head_on_weekly'] = {
            'rows': int(wk.sum()),
            'population': 'weekly rows scored by the PROFILE head alone (its own label), '
                          'out of fold. How well the curve is reproduced.',
            **_metrics(y[wk], np.clip(oof_profile[wk], 0, 100))}
    rt = is_realtime & served
    if int(rt.sum()) >= 100:
        out['profile_head_on_realtime'] = {
            'rows': int(rt.sum()),
            'population': 'realtime rows scored by the PROFILE head alone (deviation = 0), '
                          'out of fold. What the curve alone would publish.',
            **_metrics(y[rt], np.clip(oof_profile[rt], 0, 100))}
        out['stored_baseline_on_realtime'] = {
            'rows': int(rt.sum()),
            'population': 'realtime rows scored by the stored baseline alone, the number '
                          'production publishes for a venue with no model.',
            **_metrics(y[rt], np.clip(baseline[rt].astype(np.float64), 0, 100))}
    return out


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------
def export_head(model, names, filename) -> str:
    """Convert one head, verify the graph the way export_model does, install it."""
    onnx_model = convert(model, 'xgboost', len(names))
    final = OUT_DIR / filename
    staging = OUT_DIR / f'.{filename}.{os.getpid()}.staging'
    try:
        staging.write_bytes(onnx_model.SerializeToString())
        input_name = verify_graph(staging, model, names)
        write_atomic(final, lambda f: f.write(staging.read_bytes()))
    finally:
        staging.unlink(missing_ok=True)
    logger.info('wrote %s (%.1f MB, input %r, %d features)', final,
                final.stat().st_size / (1024 * 1024), input_name, len(names))
    return input_name


def serving_maps_path() -> Path:
    explicit = os.environ.get('FLOCK_TWO_HEAD_METADATA', '').strip()
    if explicit:
        return Path(explicit)
    for staged in (OUT_DIR / 'prepared_metadata.json', CANDIDATE_DIR / 'prepared_metadata.json'):
        if staged.exists():
            return staged
    return MODELS_DIR / 'model_metadata.json'


def hold_out_live_dates(rows_deviation_mask, provenance, dates, days) -> tuple:
    """Take the latest `days` observation dates among the PROVEN live rows out
    of every training set. Returns (training mask, held-out mask, dates held)."""
    held = np.zeros(len(provenance), dtype=bool)
    if days <= 0:
        return rows_deviation_mask, held, []
    live = rows_deviation_mask & (provenance == 'live') & (dates != '')
    uniq = sorted(set(dates[live].tolist()))
    if len(uniq) < days + 2:
        logger.warning('live forward slice skipped: only %d proven-live observation dates, '
                       'need at least %d to hold %d out and keep two', len(uniq), days + 2, days)
        return rows_deviation_mask, held, []
    latest = uniq[-days:]
    held = live & np.isin(dates, latest)
    return rows_deviation_mask & ~held, held, latest


def main():
    t_start = time.time()
    features_path = SCRIPT_DIR / 'features_train.pkl'
    if not features_path.exists():
        raise FileNotFoundError(
            f'{features_path} does not exist. Run `node export_training_data.js` then '
            '`python prepare_features.py` first; a retrain starts at the export.')
    with open(features_path, 'rb') as f:
        data = pickle.load(f)

    X = data['X']
    feature_cols = list(data['feature_cols'])
    y = np.asarray(data['y'])
    y_actual = np.asarray(data['y_actual'], dtype=np.float32)
    baseline = np.asarray(data['baseline'], dtype=np.float32)
    cities = np.asarray(data['cities']).astype(str)
    provenance = np.asarray(data.get('label_provenance')).astype(str)
    n = len(y_actual)
    if X.shape != (n, len(feature_cols)) or len(baseline) != n or len(cities) != n:
        raise ValueError('features_train.pkl is internally inconsistent; re-run prepare_features.py')
    if not np.isfinite(X).all():
        raise ValueError('the feature matrix carries NaN or inf; prepare_features.py fills '
                         'features with 0 before saving, so this pickle was not written by it')
    assert_delta_label(y, y_actual, baseline, data.get('label_type', 'absolute'))

    if 'is_realtime' not in feature_cols:
        raise LabelContractError('is_realtime is not in the feature matrix; the two heads '
                                 'are split on it')
    is_realtime = X[:, feature_cols.index('is_realtime')].astype(int) == 1
    served = serving_population_mask(baseline)
    if not served.all():
        raise LabelContractError(
            f'{int((~served).sum())} training rows have baseline <= 0. prepare_features.py '
            'filters the training frame to the served population; this pickle was not '
            'written by the current pipeline.')

    rows_profile_mask = ~is_realtime & (provenance == 'weekly')
    stray_weekly = int((~is_realtime & (provenance != 'weekly')).sum())
    if stray_weekly:
        raise LabelContractError(
            f'{stray_weekly} non-realtime rows carry a provenance other than "weekly"; '
            'the profile head trains on typical-week rows only')
    is_live = np.isin(provenance, list(LIVE_PROVENANCES))
    rows_deviation_mask = is_realtime & is_live
    refused = {}
    for p in np.unique(provenance[is_realtime & ~is_live]):
        refused[str(p)] = int((is_realtime & (provenance == p)).sum())
    dates = np.asarray(data.get('observed_date', np.array([''] * n))).astype(str)
    rows_deviation_mask, live_held_mask, live_held_dates = hold_out_live_dates(
        rows_deviation_mask, provenance, dates, LIVE_HOLDOUT_DAYS)
    used = {str(p): int((rows_deviation_mask & (provenance == p)).sum())
            for p in np.unique(provenance[rows_deviation_mask])}
    logger.info('provenance policy: %s', PROVENANCE_POLICY)
    logger.info('profile head: %d weekly rows. deviation head: %d realtime rows by '
                'provenance %s; refused: %s; held out for the live forward slice: %d rows '
                'on %s', int(rows_profile_mask.sum()), int(rows_deviation_mask.sum()), used,
                refused or 'none', int(live_held_mask.sum()), live_held_dates or 'nothing')
    if int(rows_profile_mask.sum()) < MIN_PROFILE_ROWS:
        raise ValueError(f'only {int(rows_profile_mask.sum())} weekly rows for the profile head')
    if int(rows_deviation_mask.sum()) < MIN_DEVIATION_ROWS:
        raise ValueError(f'only {int(rows_deviation_mask.sum())} rows for the deviation head '
                         f'under policy "{PROVENANCE_POLICY}"; below {MIN_DEVIATION_ROWS} a '
                         'deviation head is noise. Wait for collectRealtime.js to write more.')
    if int(rows_deviation_mask.sum()) < MIN_REALTIME_ROWS:
        logger.warning('the deviation head has %d rows, under the %d prepare_features asks '
                       'of a retrain. The verdict is measured on the holdout regardless; '
                       'read it knowing the head is small.', int(rows_deviation_mask.sum()),
                       MIN_REALTIME_ROWS)
    if ADMIT_UNKNOWN:
        logger.warning('unknown-provenance rows ADMITTED to the deviation head. Nothing can '
                       'tell a live reading from a vendor forecast on those rows (migration '
                       '025). This is not a clean run and the metadata says so.')

    # The serving maps, from the prepare_features run the pickles came from.
    maps_path = serving_maps_path()
    with open(maps_path, 'r', encoding='utf-8') as f:
        maps_meta = json.load(f)
    logger.info('serving maps from %s', maps_path)
    maps_check = verify_serving_maps(maps_meta, X, feature_cols, data['hour'],
                                     data['venue_category'])

    servable, dropped, servable_source = servable_feature_names(
        [c for c in feature_cols if c not in FORBIDDEN_IN_BOTH])
    logger.info('servable vocabulary: %d of %d pickle columns (%s)', len(servable),
                len(feature_cols), servable_source)
    names = head_feature_lists(feature_cols, set(servable))
    profile_names, deviation_names = names
    logger.info('profile head: %d features %s', len(profile_names), profile_names)
    logger.info('deviation head: %d features', len(deviation_names))
    if dropped:
        logger.info('dropped from both heads (no inference twin): %s', dropped)

    # Copy detection, per head, on the rows that head trains on.
    rows_p = np.where(rows_profile_mask)[0]
    rows_d = np.where(rows_deviation_mask)[0]
    Xp_check = build_matrix(profile_names, rows_p, X, feature_cols, baseline)
    leak_profile = assert_no_copy(
        profile_names, Xp_check, {'busyness_pct (the profile label)': y_actual[rows_p]},
        exempt={BASELINE_FEATURE: 'on a weekly row the smoothed stored baseline IS the '
                                  'typical value the profile head is asked to reproduce; '
                                  'that is the design, not a leak'})
    del Xp_check
    Xd_check = build_matrix(deviation_names, rows_d, X, feature_cols, baseline,
                            profile_pred_rows=np.zeros(len(rows_d), dtype=np.float32))
    leak_deviation = assert_no_copy(
        deviation_names, Xd_check,
        {'busyness_pct (the label)': y_actual[rows_d],
         'delta_label (busyness minus baseline)': y[rows_d]},
        exempt={PROFILE_FEATURE: 'zero-filled for this check; it is the profile head\'s '
                                 'output and is measured against the label out of fold'})
    del Xd_check

    device, device_reason = resolve_device()
    threads = resolve_threads()
    env = environment_fingerprint(device, device_reason, threads)
    logger.info('device %s (%s), threads %d, reproducible %s', device, device_reason,
                threads, env['bit_reproducible'])
    base_models = (make_model(device, threads, PROFILE_OBJECTIVE),
                   make_model(device, threads, DEVIATION_OBJECTIVE))

    # Cross-validation, city-disjoint, with the category maps refit per fold
    # exactly as train_model.py does, so the reported number is not inflated
    # by a held-out city having built its own category cells.
    cv_mode = os.environ.get('FLOCK_TWO_HEAD_CV', 'loco').strip().lower() or 'loco'
    folds, cv_label = resolve_folds(cv_mode, X, y_actual, cities)
    fold_cats = None
    slices = None
    per_city = {}
    shipped_repro = None
    if folds:
        fold_cats = FoldCategoryBaselines(data.get('category_cell_stats'), cities,
                                          feature_cols, y_actual)
        shipped_repro = fold_cats.verify_reproduces_shipped(X)
        logger.info('cross-validation: %s', cv_label)
        t_cv = time.time()
        oof_profile, oof_deviation, per_city = cross_validate(
            folds, fold_cats, base_models, names, X, feature_cols, baseline, y_actual,
            rows_profile_mask, rows_deviation_mask, is_realtime, cities)
        slices = population_report(y_actual, oof_profile, oof_deviation, is_realtime, baseline)
        logger.info('cross-validation done in %.0fs', time.time() - t_cv)
        for name, block in slices.items():
            if 'mae' in block:
                logger.info('    %-28s %8d rows  MAE %7.3f  R2 %6.3f  within_10 %5.1f%%  '
                            'within_15 %5.1f%%', name, block['rows'], block['mae'],
                            block['r2'], block['within_10'], block['within_15'])
    else:
        logger.warning('FLOCK_TWO_HEAD_CV=none: no cross-validation. The candidate will '
                       'carry no training_metrics and mlPredictor.js will refuse to load it '
                       '(verifyModelShape wants training_metrics.within_15). Use this only '
                       'to iterate on the holdout with eval_two_head.py.')

    # The final fit, on the whole-frame category maps, which are the maps the
    # candidate ships and serves.
    logger.info('final fit: profile on %d weekly rows, deviation on %d realtime rows',
                len(rows_p), len(rows_d))
    t_fit = time.time()
    profile, deviation, dev_label_stats = fit_heads(
        base_models, names, rows_p, rows_d, X, feature_cols, baseline, y_actual)
    fit_seconds = time.time() - t_fit
    logger.info('final fit done in %.0fs; deviation label mean %.2f sd %.2f, %.1f%% outside '
                'the %s clamp', fit_seconds, dev_label_stats['mean'], dev_label_stats['sd'],
                dev_label_stats['share_outside_clamp_pct'], list(DEVIATION_CLAMP))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with open(SCRIPT_DIR / 'two_head_models.pkl', 'wb') as f:
        pickle.dump({'profile': profile, 'deviation': deviation,
                     'profile_feature_cols': profile_names,
                     'deviation_feature_cols': deviation_names,
                     'deviation_clamp': list(DEVIATION_CLAMP)}, f)
    live_holdout_path = OUT_DIR / LIVE_HOLDOUT_FILE
    if int(live_held_mask.sum()) > 0:
        held = np.where(live_held_mask)[0]
        with open(live_holdout_path, 'wb') as f:
            pickle.dump({
                'X': X[held], 'feature_cols': feature_cols, 'y_actual': y_actual[held],
                'baseline': baseline[held], 'cities': cities[held], 'observed_date': dates[held],
                'label_provenance': provenance[held], 'dates_held': live_held_dates,
                'note': 'proven-live rows (label_provenance live) on the latest observation '
                        'dates, held out of every training set of this run',
            }, f)
        logger.info('wrote %s (%d proven-live rows on %s)', live_holdout_path, len(held),
                    live_held_dates)
    elif live_holdout_path.exists():
        live_holdout_path.unlink()

    profile_input = export_head(profile, profile_names, 'profile.onnx')
    deviation_input = export_head(deviation, deviation_names, 'deviation.onnx')

    version = (os.environ.get('MODEL_VERSION') or '').strip() or DEFAULT_VERSION
    union = sorted(set(profile_names) | set(deviation_names))
    metadata = {k: maps_meta[k] for k in SERVING_MAP_KEYS if k in maps_meta}
    metadata.update({
        'model_name': 'Starling',
        'model_version': version,
        'label_type': 'two_head',
        'model_type': 'xgboost',
        'best_model': 'xgboost',
        # The union, so anything that asks "does this model use temperature"
        # gets the right answer. The positional contracts are per head, below.
        'feature_names': union,
        'feature_count': len(union),
        'feature_types': compute_feature_types(union),
        'onnx_input_name': profile_input,
        'two_head': {
            'reconstruction': 'score = round(clip(clip(profile, 0, 100) + '
                              'clip(deviation, lo, hi), 0, 100)); mlPredictor.js '
                              'reconstructTwoHeadScore, train_two_head.reconstruct_two_head',
            'deviation_clamp': list(DEVIATION_CLAMP),
            'profile': {
                'file': 'profile.onnx',
                'onnx_input_name': profile_input,
                'feature_names': profile_names,
                'feature_count': len(profile_names),
                'feature_types': compute_feature_types(profile_names),
                'label': 'busyness_pct',
                'objective': PROFILE_OBJECTIVE,
                'trained_on': 'weekly rows (is_realtime == 0, label_provenance weekly), '
                              'baseline > 0',
                'rows': int(len(rows_p)),
                'excluded_feature_families': list(PROFILE_EXCLUDED_PREFIXES),
                'excluded_features': sorted(PROFILE_EXCLUDED),
            },
            'deviation': {
                'file': 'deviation.onnx',
                'onnx_input_name': deviation_input,
                'feature_names': deviation_names,
                'feature_count': len(deviation_names),
                'feature_types': compute_feature_types(deviation_names),
                'label': 'busyness_pct - profile_pred (the profile head\'s prediction for '
                         'the same row)',
                'objective': DEVIATION_OBJECTIVE,
                'objective_why': 'the conditional median; MAE and within-N score the '
                                 'median, and the squared-error mean of a bimodal '
                                 'deviation compresses toward the middle (see the header)',
                'trained_on': f'realtime rows with label_provenance in '
                              f'{sorted(LIVE_PROVENANCES)}, baseline > 0',
                'provenance_policy': PROVENANCE_POLICY,
                'clean_labels': not ADMIT_UNKNOWN,
                'rows': int(len(rows_d)),
                'provenance_used': used,
                'provenance_refused': refused,
                'live_forward_slice': {
                    'rows_held_out': int(live_held_mask.sum()),
                    'dates_held_out': live_held_dates,
                    'file': LIVE_HOLDOUT_FILE if int(live_held_mask.sum()) else None,
                },
                'label_stats': dev_label_stats,
                'sample_weight': 'uniform 1.0; the weekly anchor is the profile head, not '
                                 'a 0.05-weighted row',
            },
            'dropped_pickle_columns': dropped,
            'servable_vocabulary_source': servable_source,
            'serving_maps_source': str(maps_path),
            'serving_maps_check': maps_check,
        },
        'training_rows': int(n),
        'training_cities': sorted(np.unique(cities).tolist()),
        'training_city_rows': {c: int((cities == c).sum()) for c in np.unique(cities)},
        'hyperparameters': {
            'source': 'fixed_from_v2.3.0_search, the same FIXED_PARAMS train_model.py fits '
                      'the shipped model with, applied to both heads; the objective is '
                      'per head and is the one deliberate departure',
            'searched_this_run': False,
            'params': dict(FIXED_PARAMS),
            'objectives': {'profile': PROFILE_OBJECTIVE, 'deviation': DEVIATION_OBJECTIVE},
        },
        'best_params': dict(FIXED_PARAMS),
        'early_stopping': {'enabled': False},
        'cv_method': cv_label,
        'training_environment': {**env, 'training_seconds': round(fit_seconds, 1),
                                 'wall_seconds': round(time.time() - t_start, 1)},
        'training_contracts': {
            'label_contract': 'profile: y == busyness_pct on weekly rows; deviation: '
                              'y == busyness_pct - profile_pred on realtime rows',
            'forbidden_features_checked': sorted(FORBIDDEN_IN_BOTH),
            'baseline_as_feature': 'baseline_busyness is an INPUT to both heads by design; '
                                   'see the header of train_two_head.py. It is the value '
                                   'mlPredictor.getBaseline returns, which buildFeatureMap '
                                   'already exposes under this name.',
            'leak_scan': {'profile': leak_profile, 'deviation': leak_deviation},
            'split': cv_label,
            'category_baselines_refit_per_fold': (
                {'applies_to': 'every cross-validation fold, both heads',
                 'shipped_column_reproduced_max_abs_diff': shipped_repro}
                if fold_cats is not None and fold_cats.active
                else {'applies_to': 'nothing', 'reason': 'no cross-validation ran'}),
        },
        'feedback_error_semantics': maps_meta.get('feedback_error_semantics', 'mapped'),
        'trained_at': datetime.now(timezone.utc).isoformat(),
        'candidate_note': 'CANDIDATE. Not the shipped artifact. eval_two_head.py writes '
                          'ship_gate; until it does, mlPredictor.init() refuses this file.',
    })
    if slices is not None:
        metadata['training_metrics'] = {
            **{k: v for k, v in slices['all_rows'].items() if k != 'population'},
            'population': slices['all_rows']['population'] + '. A blend dominated by weekly '
                          'rows; see training_metrics_by_population.realtime_served for the '
                          'rows production scores.',
        }
        metadata['training_metrics_by_population'] = slices
        metadata['training_loco_per_city'] = per_city

    try:
        rendered = json.dumps(metadata, indent=2, allow_nan=False)
    except ValueError as err:
        raise ValueError(f'the candidate metadata would carry a non-finite number ({err})') from err
    write_atomic(OUT_DIR / 'model_metadata.json',
                 lambda f: f.write(rendered.encode('utf-8')))
    logger.info('wrote %s (label_type two_head, version %s, no ship_gate yet). Next: '
                'python eval_two_head.py', OUT_DIR / 'model_metadata.json', version)


if __name__ == '__main__':
    main()
