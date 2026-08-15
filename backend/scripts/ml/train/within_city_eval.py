"""
WITHIN-CITY EVALUATION — how accurate is the delta model on the population it
actually serves, in cities it has already seen?

WHY THIS SCRIPT EXISTS
----------------------
model_metadata.json reports leave-one-city-out (LOCO) numbers: every fold hands
the model a city it has never seen. Production does the opposite — it serves
philly, lehigh and la, which are 73,640 / 67,860 / 127,345 rows of the training
frame. Nobody had ever measured the model on a held-out slice INSIDE a city it
knows, so the honest serving number (realtime_served MAE 27.54, within_10 22.8%)
might have been a worst case that badly understates production, or it might have
been the truth. This script decides that.

WHAT IT MEASURES, AND ON WHICH ROWS
-----------------------------------
The evaluated population is `serving_population_mask(baseline) & is_realtime`,
imported from prepare_features.py — the same predicate prepare_features filters
TRAINING with and quick_eval.py gates on. It is not re-implemented here.

Every reported number is `baseline + clamp(delta, -30, 30)` versus the SAME
rows' `baseline` alone. Baseline-alone is the honest floor: if the delta layer
does not beat it on the served population, the delta layer does not earn its
place, and no breakdown rescues that.

THE SPLITS, AND WHY THERE ARE TWO
---------------------------------
A model cannot be evaluated on rows it was fitted on. `best_model.pkl` is a
full-frame fit — every training row is in-sample for it — so a within-city
measurement REQUIRES a refit. Both splits below refit from scratch with the
shipped recipe (FIXED_PARAMS, RANDOM_STATE, cpu, pinned threads) into this
script's scratch directory. Nothing in train/ or models/ is written.

  date  (HEADLINE — production's actual situation)
        Train on every realtime row observed on or before a cutoff date, plus
        every weekly anchor row. Test on realtime rows observed AFTER it. The
        venue is known, the city is known, only the moment is new. That is
        exactly what production does: it scores a venue it has collected for,
        at a future hour.

  venue (CONTROL — a venue the corpus has never contained at all)
        Hold out a seeded 20% of venue_ids inside EVERY city and remove EVERY
        row of those venues — weekly as well as realtime — from the fit. Test
        rows come only from held-out venues, so venue_id is strictly disjoint
        and no venue-hour cell can appear on both sides.

        Round 2 of this script kept the held-out venues' WEEKLY rows in
        training, on the argument that a weekly label IS the baseline
        production already holds for any servable venue, so it transmits
        nothing new. That argument is probably right and the bias it could
        introduce runs AGAINST the model (a weekly row teaches delta = 0 on
        that venue's feature vector). It was dropped anyway, because it makes
        the disjointness claim an argument instead of an assertion, and an
        argument is not a proof. The cost is that the venue split fits on ~20%
        fewer rows than the date split, so a slice of its gap to the date split
        is training-set size, not venue familiarity. Held-out venues still have
        a baseline to reconstruct against: baselines come from the export's SQL
        over the database, not from rows in this frame.

Why not a random row split: a venue-hour cell holds up to 8 rows, so a random
split puts the same (venue, dow, hour) on both sides and the model scores its
own neighbours. Both splits above are disjoint on their grouping key and
prove it (assert_split_disjoint).

Why the date split is not itself a leak: with venue_id, latitude and longitude
all excluded from the feature set, no feature carries a per-venue history of
live readings, and baseline_busyness is built by buildBaselines.js from WEEKLY
rows only (see export_training_data.js) so it contains no realtime label at
all — not the row's own, not another date's. What the date split does allow is
the model recognising a venue from its quasi-identifying features (rating,
review_count, gtypes, neighbor_baseline). That is not leakage: production has
those same features for those same venues. It is the advantage of having seen
the venue, which is precisely what this script set out to measure, and the
venue split is the control that isolates it.

THE ONE LABEL-DERIVED FEATURE, REFITTED PER SPLIT
-------------------------------------------------
category_baseline and refined_category_baseline are means of busyness_pct.
prepare_features fits them on the whole training frame (this is the documented
open leak in metadata.training_contracts.known_residual_leak). Leaving them
alone would let every held-out row's own label sit inside its own feature. Both
splits therefore REFIT both maps on the training side only, with
build_category_baseline_maps — the same function, the same smoothing — and
overwrite those two columns for train and test alike. No other feature touches
a label: neighbour features and smooth_baseline_hours are built from
baseline_busyness, the climate norms and venue medians use no label, and the
four user-feedback features are constant across this corpus.

RUN
---
    FLOCK_TRAIN_DEVICE=cpu FLOCK_TRAIN_THREADS=12 python within_city_eval.py

Writes: <scratch>/within_city_eval/*.pkl (cache + refitted models)
        ../WITHIN-CITY-EVAL.md is written by hand from results.json.
Reads:  training_data.csv, features_train.pkl, best_model.pkl (all read-only).
"""

import json
import logging
import os
import pickle
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

SCRIPT_DIR = Path(__file__).parent
sys.path.insert(0, str(SCRIPT_DIR))

import prepare_features as pf  # noqa: E402
from prepare_features import serving_population_mask  # noqa: E402

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Reproducibility, pinned the same way train_model.py pins it. CPU because
# CUDA histogram training is not bit-reproducible (train_model.resolve_device).
# ---------------------------------------------------------------------------
os.environ.setdefault('FLOCK_TRAIN_DEVICE', 'cpu')
os.environ.setdefault('FLOCK_TRAIN_THREADS', '12')
DEVICE = os.environ['FLOCK_TRAIN_DEVICE']
THREADS = int(os.environ['FLOCK_TRAIN_THREADS'])
RANDOM_STATE = 42
if DEVICE != 'cpu':
    raise SystemExit('within_city_eval.py refuses to run on anything but cpu: the '
                     'refits must be reproducible. Unset FLOCK_TRAIN_DEVICE.')

# Shipped recipe, copied from train_model.FIXED_PARAMS. Copied rather than
# imported because importing train_model runs its module-level device probe.
FIXED_PARAMS = {
    'subsample': 0.9, 'reg_lambda': 1.0, 'reg_alpha': 0.5,
    'n_estimators': 800, 'min_child_weight': 7, 'max_depth': 8,
    'learning_rate': 0.01, 'colsample_bytree': 0.8,
}
CLAMP = (-30.0, 30.0)

# The last 15 days of the realtime corpus (2026-05-04 .. 2026-05-18) — ~30% of
# realtime rows, enough for per-city numbers in the three cities that matter.
DATE_CUTOFF = '2026-05-03'
VENUE_HOLDOUT_FRACTION = 0.20

SCRATCH = Path(os.environ.get(
    'FLOCK_EVAL_SCRATCH',
    Path(os.environ.get('TEMP', '/tmp')) / 'flock_within_city_eval'))
SCRATCH.mkdir(parents=True, exist_ok=True)
FRAME_CACHE = SCRATCH / 'rebuilt_frame.pkl'
RESULTS_PATH = SCRATCH / 'results.json'

FOCUS_CITIES = ['philly', 'lehigh', 'la']

# Hour bands. dinner and evening are the two the product is actually used in.
HOUR_BANDS = [
    ('overnight_0_5', range(0, 6)),
    ('morning_6_10', range(6, 11)),
    ('midday_11_14', range(11, 15)),
    ('afternoon_15_16', range(15, 17)),
    ('dinner_17_20', range(17, 21)),
    ('evening_21_23', range(21, 24)),
]

# Training-side live observations per venue. The spending question is whether
# the top buckets are meaningfully better than the bottom ones.
OBS_BUCKETS = [
    ('0', 0, 0),
    ('1-9', 1, 9),
    ('10-24', 10, 24),
    ('25-49', 25, 49),
    ('50-99', 50, 99),
    ('100-199', 100, 199),
    ('200+', 200, 10 ** 9),
]


# ---------------------------------------------------------------------------
# Metrics — byte-identical arithmetic to train_model._metrics / quick_eval.
# ---------------------------------------------------------------------------
def metrics(target, preds) -> dict:
    target = np.asarray(target, dtype=float)
    preds = np.asarray(preds, dtype=float)
    errors = np.abs(target - preds)
    ss_res = float(np.sum((target - preds) ** 2))
    ss_tot = float(np.sum((target - target.mean()) ** 2))
    return {
        'rows': int(len(target)),
        'rmse': round(float(np.sqrt(np.mean((target - preds) ** 2))), 4),
        'mae': round(float(np.mean(errors)), 4),
        'r2': round(float(1 - ss_res / ss_tot) if ss_tot > 0 else float('nan'), 4),
        'median_ae': round(float(np.median(errors)), 4),
        'within_5': round(float(np.mean(errors <= 5) * 100), 1),
        'within_10': round(float(np.mean(errors <= 10) * 100), 1),
        'within_15': round(float(np.mean(errors <= 15) * 100), 1),
    }


def reconstruct(raw_delta, baseline) -> np.ndarray:
    """Production's reconstruction (services/mlPredictor.js), unrounded."""
    lo, hi = CLAMP
    return np.clip(np.asarray(baseline, dtype=float)
                   + np.clip(np.asarray(raw_delta, dtype=float), lo, hi), 0, 100)


def head_to_head(y_actual, model_pred, baseline_pred, min_rows=100) -> dict:
    """Model vs baseline-alone on IDENTICAL rows. One population, two predictors."""
    n = len(y_actual)
    if n < min_rows:
        return {'rows': int(n), 'note': f'fewer than {min_rows} rows — not measured'}
    m = metrics(y_actual, model_pred)
    b = metrics(y_actual, baseline_pred)
    return {
        'rows': int(n),
        'model': m,
        'baseline_alone': b,
        'mae_improvement': round(b['mae'] - m['mae'], 4),
        'mae_improvement_pct': round((b['mae'] - m['mae']) / b['mae'] * 100, 2) if b['mae'] else 0.0,
        'within_10_improvement': round(m['within_10'] - b['within_10'], 2),
        'r2_improvement': round(m['r2'] - b['r2'], 4),
        'model_beats_baseline': bool(m['mae'] < b['mae']),
        'rows_model_closer': int(np.sum(np.abs(y_actual - model_pred)
                                        < np.abs(y_actual - baseline_pred))),
        'rows_baseline_closer': int(np.sum(np.abs(y_actual - baseline_pred)
                                           < np.abs(y_actual - model_pred))),
    }


# ---------------------------------------------------------------------------
# STAGE 1 — rebuild the training frame WITH venue_id and observed_date.
#
# features_train.pkl carries X, y, baseline, cities, hour and venue_category —
# but not venue_id and not observed_date, and neither can be recovered by
# reading training_data.csv alongside it, because main() drops rows (null
# labels, always-zero venues, baseline == 0) and a positional zip of the two is
# exactly the misalignment audit finding 10 found in evaluate_model.py.
#
# So the frame is REBUILT by calling prepare_features' own transforms in
# main()'s order, and the rebuild is then PROVEN correct by asserting the
# resulting X is bit-identical to features_train.pkl['X']. If it is, the
# venue_id and observed_date columns riding along are aligned to X by
# construction.
# ---------------------------------------------------------------------------
def rebuild_training_frame() -> pd.DataFrame:
    if FRAME_CACHE.exists():
        logger.info('Loading cached rebuilt frame from %s', FRAME_CACHE)
        with open(FRAME_CACHE, 'rb') as f:
            cached = pickle.load(f)
        if not cached.attrs.get('feature_cols'):
            # DataFrame.attrs does not survive every pandas pickle round-trip.
            with open(SCRIPT_DIR / 'features_train.pkl', 'rb') as f:
                cached.attrs['feature_cols'] = list(pickle.load(f)['feature_cols'])
        return cached

    logger.info('Rebuilding the training frame from training_data.csv '
                '(this replays prepare_features.main()\'s train branch)...')
    t0 = time.time()
    train_df = pd.read_csv(SCRIPT_DIR / 'training_data.csv')
    logger.info('  raw rows: %d', len(train_df))
    pf.require_export_columns(train_df, SCRIPT_DIR / 'training_data.csv', 'training_data.csv')

    # Corpus contract, same order as main(). The holdout CSV takes no part in
    # the training frame, so only the train half is replayed; the weather
    # policy is per-frame and the recovery is idempotent.
    pf.recover_weather_codes(train_df, 'train')
    pf.audit_calendar_coverage(train_df, 'train')

    train_df = train_df.dropna(subset=['busyness_pct'])
    venue_means = train_df.groupby(
        ['city', 'venue_category', 'latitude', 'longitude'])['busyness_pct'].mean()
    always_zero = venue_means[venue_means == 0].index
    if len(always_zero) > 0:
        train_df = train_df.set_index(['city', 'venue_category', 'latitude', 'longitude'])
        train_df = train_df.drop(always_zero, errors='ignore')
        train_df = train_df.reset_index()

    train_df = pf.add_temporal_features(train_df)
    train_df, _venue_metadata = pf.add_venue_features(train_df)
    train_df = pf.add_weather_features(train_df)
    train_df, _cat_maps = pf.add_baseline_features(train_df)
    train_df = pf.add_user_feedback_features(train_df)
    train_df = pf.add_event_features(train_df)
    train_df = pf.add_astronomy_features(train_df)
    train_df, _temp_norms = pf.add_climate_anomaly(train_df)
    train_df = pf.add_neighbor_features(train_df)
    train_df = pf.add_holiday_features(train_df)

    train_df['baseline_busyness'] = train_df['baseline_busyness'].fillna(0)
    train_df['delta_label'] = (train_df['busyness_pct']
                               - train_df['baseline_busyness']).astype(float)
    train_df = train_df[serving_population_mask(train_df['baseline_busyness'])]
    train_df['label_provenance'] = train_df['label_provenance'].fillna('unknown')
    is_forecast_label = ((train_df['is_realtime'] == 1)
                         & (train_df['label_provenance'] == 'forecast'))
    train_df['sample_weight'] = np.where(
        train_df['is_realtime'] != 1, 0.05,
        np.where(is_forecast_label, 0.3, 1.0),
    )

    feature_cols = pf.get_feature_columns(train_df)
    train_df[feature_cols] = train_df[feature_cols].fillna(0)
    keep = feature_cols + ['busyness_pct', 'delta_label', 'baseline_busyness', 'city',
                           'label_provenance', 'venue_category', 'sample_weight',
                           'venue_id', 'observed_date', 'day_of_week', 'price_level',
                           'rating']
    keep = list(dict.fromkeys(keep))
    train_df = train_df[keep].reset_index(drop=True)
    train_df.attrs['feature_cols'] = feature_cols
    logger.info('  rebuilt %d rows x %d features in %.1fs',
                len(train_df), len(feature_cols), time.time() - t0)

    with open(FRAME_CACHE, 'wb') as f:
        pickle.dump(train_df, f)
    return train_df


def verify_rebuild(frame: pd.DataFrame) -> dict:
    """Prove the rebuilt frame is the SAME frame features_train.pkl was cut from.

    Without this the whole script is a different measurement of a different
    matrix. Bit-identical X is the only claim worth making: it means the
    venue_id / observed_date columns are aligned to X row for row.
    """
    logger.info('Verifying the rebuild against features_train.pkl...')
    with open(SCRIPT_DIR / 'features_train.pkl', 'rb') as f:
        ref = pickle.load(f)
    feature_cols = frame.attrs['feature_cols']
    checks = {}
    checks['row_count_matches'] = (len(frame) == len(ref['y_actual']))
    if not checks['row_count_matches']:
        raise SystemExit(f'Rebuild has {len(frame)} rows, features_train.pkl has '
                         f'{len(ref["y_actual"])}. The rebuild is not the same frame.')
    checks['feature_cols_match'] = (list(feature_cols) == list(ref['feature_cols']))
    if not checks['feature_cols_match']:
        raise SystemExit('Rebuilt feature columns differ from features_train.pkl.')

    X_new = frame[feature_cols].values.astype(np.float32)
    X_ref = ref['X']
    exact = bool(np.array_equal(X_new, X_ref))
    checks['X_bit_identical'] = exact
    if not exact:
        diff = ~np.isclose(X_new, X_ref, rtol=0, atol=0, equal_nan=True)
        bad_cols = [feature_cols[i] for i in np.unique(np.where(diff)[1])]
        max_abs = float(np.nanmax(np.abs(X_new.astype(np.float64)
                                         - X_ref.astype(np.float64))))
        checks['X_mismatch_columns'] = bad_cols[:20]
        checks['X_max_abs_diff'] = max_abs
        raise SystemExit(
            f'Rebuilt X is NOT identical to features_train.pkl (max |diff| {max_abs}, '
            f'columns {bad_cols[:20]}). Every number this script would print would '
            'describe a matrix the shipped model was not trained on.')

    for name, col in (('y_actual', 'busyness_pct'), ('baseline', 'baseline_busyness'),
                      ('sample_weight', 'sample_weight')):
        checks[f'{name}_identical'] = bool(np.array_equal(
            frame[col].values.astype(np.float32), ref[name]))
    checks['cities_identical'] = bool(np.array_equal(
        frame['city'].values.astype(str), np.asarray(ref['cities'], dtype=str)))
    for k, v in checks.items():
        if v is False:
            raise SystemExit(f'Rebuild verification failed on {k}.')
    logger.info('  rebuild verified: X bit-identical over %d rows x %d features',
                len(frame), len(feature_cols))
    checks['venue_id_nulls'] = int(frame['venue_id'].isna().sum())
    checks['distinct_venues'] = int(frame['venue_id'].nunique())
    return checks


# ---------------------------------------------------------------------------
# Splits
# ---------------------------------------------------------------------------
def assert_split_disjoint(frame, train_idx, test_idx, key_col, label,
                          key_scope='all') -> dict:
    """A split that is not disjoint on its grouping key is not a measurement.

    key_scope='realtime' restricts the key census to the train side's LIVE rows.
    That is only correct for the venue_with_anchor split, where a held-out
    venue's weekly rows are deliberately kept — a weekly label IS the baseline
    and carries no live observation. Anywhere else it would hide a leak, so the
    scope is passed in explicitly per split rather than inferred.
    """
    tr, te = np.asarray(train_idx), np.asarray(test_idx)
    if key_scope == 'realtime':
        tr_keys_from = tr[frame['is_realtime'].values[tr] == 1]
    else:
        tr_keys_from = tr
    if np.intersect1d(tr, te).size:
        raise SystemExit(f'{label}: {np.intersect1d(tr, te).size} rows are in both sides.')
    # Normalised to str: read_csv hands back a distinct NaN OBJECT per row in an
    # object column, so a raw set() of observed_date counted 1,565,912 "keys"
    # that were all the same missing value. The disjointness answer was right;
    # the key census it printed was noise.
    keys = frame[key_col].fillna('__missing__').astype(str).values
    keys_tr = set(keys[tr_keys_from].tolist())
    keys_te = set(keys[te].tolist())
    shared = keys_tr & keys_te
    report = {
        'grouping_key': key_col,
        'key_scope': key_scope,
        'train_rows': int(len(tr)),
        'test_rows': int(len(te)),
        'train_keys': len(keys_tr),
        'test_keys': len(keys_te),
        'shared_keys': len(shared),
        'row_overlap': 0,
    }
    if shared:
        raise SystemExit(
            f'{label}: {len(shared)} values of {key_col} appear on BOTH sides '
            f'(e.g. {sorted(map(str, shared))[:5]}). The split leaks.')
    # And the venue-hour cell check the brief calls out by name: for the venue
    # split no (venue, dow, hour) may be shared. For the date split it may be —
    # deliberately, and the control split is what isolates that.
    cell = (frame['venue_id'].astype(str) + '|' + frame['day_of_week'].astype(str)
            + '|' + frame['hour'].astype(str))
    shared_cells = set(cell.values[tr_keys_from]) & set(cell.values[te])
    report['shared_venue_hour_cells'] = len(shared_cells)
    if key_col == 'venue_id' and key_scope == 'all' and shared_cells:
        raise SystemExit(f'{label}: {len(shared_cells)} venue-hour cells on both sides.')
    if key_scope == 'realtime':
        # The claim being asserted: every row of a held-out venue that survived
        # into training is WEEKLY. If one live row slipped through, the split is
        # the leaky one it was designed not to be.
        held = set(frame['venue_id'].astype(str).values[te].tolist())
        tr_live = frame['is_realtime'].values[tr] == 1
        leaked = np.isin(frame['venue_id'].astype(str).values[tr][tr_live], list(held)).sum()
        report['held_venue_live_rows_in_train'] = int(leaked)
        if leaked:
            raise SystemExit(f'{label}: {leaked} LIVE rows of held-out venues are in '
                             'training. The anchor-only exemption is not holding.')
    # For the date split shared cells are EXPECTED and reported, not fatal: the
    # same venue observed live on two different dates is the situation
    # production is in, and the venue split is the control that prices it.
    report['shared_venue_hour_cells_expected'] = (key_col != 'venue_id')
    logger.info('  %s split disjoint on %s: %d train keys, %d test keys, 0 shared',
                label, key_col, len(keys_tr), len(keys_te))
    return report


def date_split(frame) -> tuple:
    """Train = realtime on/before cutoff + ALL weekly anchor rows. Test = after."""
    rt = frame['is_realtime'].values == 1
    date = frame['observed_date'].fillna('').astype(str).values
    after = rt & (date > DATE_CUTOFF)
    test_idx = np.where(after & serving_population_mask(frame['baseline_busyness'].values))[0]
    train_idx = np.where(~after)[0]
    return train_idx, test_idx


def scattered_date_split(frame) -> tuple:
    """CONTROL for the date split: 15 dates drawn from ACROSS the whole window.

    The forward date split holds out the LAST 15 days, so it tests two things at
    once — a date the model has not seen, and a date LATER than every date it
    has seen. This split holds out the same NUMBER of dates, seeded, spread over
    the full 2026-03-10 .. 2026-05-18 range, so the model interpolates instead of
    extrapolating. The difference between the two is the price of forward
    extrapolation, which is the only one of the two production actually pays.
    """
    rt = frame['is_realtime'].values == 1
    date = frame['observed_date'].fillna('').astype(str).values
    all_dates = np.sort(np.unique(date[rt]))
    n_forward = int((all_dates > DATE_CUTOFF).sum())
    rng = np.random.default_rng(RANDOM_STATE)
    held = set(rng.choice(all_dates, size=n_forward, replace=False).tolist())
    is_held = rt & np.isin(date, list(held))
    return np.where(~is_held)[0], np.where(is_held)[0]


def venue_split(frame) -> tuple:
    """Hold out a seeded 20% of venues in EVERY city; ALL their rows leave the fit."""
    rng = np.random.default_rng(RANDOM_STATE)
    venues = frame[['city', 'venue_id']].drop_duplicates()
    held = set()
    for city, grp in venues.groupby('city'):
        ids = np.sort(grp['venue_id'].unique())
        k = max(1, int(round(len(ids) * VENUE_HOLDOUT_FRACTION)))
        held.update(rng.choice(ids, size=k, replace=False).tolist())
    is_held = frame['venue_id'].isin(held).values
    rt = frame['is_realtime'].values == 1
    served = serving_population_mask(frame['baseline_busyness'].values)
    test_idx = np.where(is_held & rt & served)[0]
    train_idx = np.where(~is_held)[0]
    return train_idx, test_idx


def venue_with_anchor_split(frame) -> tuple:
    """The venue split, but the held-out venues' WEEKLY rows stay in training.

    Exists to price one mechanism. The strict venue split beats baseline-alone
    by twice as much as either date split does, which is backwards — an unseen
    venue should be the harder case, not the easier one. The suspect is the
    weight-0.05 weekly anchor: a weekly row's delta label is 0 BY CONSTRUCTION,
    and the date splits leave one in training for the exact (venue, dow, hour)
    cell being scored, which pulls the predicted delta toward zero on precisely
    the rows the product serves. The strict venue split removes that pull; this
    split puts it back and changes nothing else, so the difference between the
    two IS the anchor's cost.

    Identical venue holdout (same seed, same 3,121 venues) as venue_split.
    """
    tr_strict, test_idx = venue_split(frame)
    held = np.ones(len(frame), dtype=bool)
    held[tr_strict] = False
    rt = frame['is_realtime'].values == 1
    train_idx = np.where(~(held & rt))[0]
    return train_idx, test_idx


# ---------------------------------------------------------------------------
# The one label-derived feature pair, refitted on the training side only.
# ---------------------------------------------------------------------------
def refit_category_features(frame, train_idx, X):
    """Rebuild category_baseline / refined_category_baseline from train rows only.

    Same function, same smoothing, same fillna chain as
    prepare_features.add_baseline_features — only the fitting population
    changes. Returns a COPY of X; the caller's matrix is untouched.
    """
    feature_cols = frame.attrs['feature_cols']
    maps = pf.build_category_baseline_maps(frame.iloc[train_idx])
    keys = frame[['venue_category', 'day_of_week', 'hour', 'price_level', 'rating',
                  'busyness_pct']].copy()
    keys = pf._slice_keys(keys)
    cat = pd.Series(keys.set_index(pf.CAT_KEYS).index.map(maps['category']).values,
                    index=keys.index).fillna(maps['global_mean'])
    ref = pd.Series(keys.set_index(pf.REFINED_KEYS).index.map(maps['refined']).values,
                    index=keys.index).fillna(cat)
    X = X.copy()
    X[:, feature_cols.index('category_baseline')] = cat.values.astype(np.float32)
    X[:, feature_cols.index('refined_category_baseline')] = ref.values.astype(np.float32)
    return X, {
        'cells_category': int(len(maps['category'])),
        'cells_refined': int(len(maps['refined'])),
        'global_mean': maps['global_mean'],
        'fitted_on_rows': int(len(train_idx)),
    }


# ---------------------------------------------------------------------------
# Refit + score
# ---------------------------------------------------------------------------
def fit_and_predict(X, y, sample_weight, train_idx, test_idx, tag):
    from xgboost import XGBRegressor
    cache = SCRATCH / f'model_{tag}.pkl'
    if cache.exists():
        logger.info('  reusing refit %s', cache)
        with open(cache, 'rb') as f:
            return pickle.load(f)['pred']
    logger.info('  fitting %s on %d rows (%d threads, %s)...',
                tag, len(train_idx), THREADS, DEVICE)
    t0 = time.time()
    model = XGBRegressor(random_state=RANDOM_STATE, tree_method='hist', device=DEVICE,
                         n_jobs=THREADS, verbosity=0, **FIXED_PARAMS)
    model.fit(X[train_idx], y[train_idx], sample_weight=sample_weight[train_idx])
    pred = model.predict(X[test_idx])
    logger.info('  %s fitted in %.1fs', tag, time.time() - t0)
    with open(cache, 'wb') as f:
        pickle.dump({'pred': pred, 'params': FIXED_PARAMS, 'tag': tag}, f)
    return pred


def breakdowns(frame, test_idx, y_actual, model_pred, baseline_pred, train_obs_by_venue):
    """Per city, per hour band, per training-side live-observation count."""
    out = {'by_city': {}, 'by_hour_band': {}, 'by_venue_obs_count': {}}
    city = frame['city'].values[test_idx]
    hour = frame['hour'].values[test_idx]
    venue = frame['venue_id'].values[test_idx]

    for c in sorted(set(city.tolist())):
        m = city == c
        out['by_city'][str(c)] = head_to_head(y_actual[m], model_pred[m], baseline_pred[m])
    for name, hrs in HOUR_BANDS:
        m = np.isin(hour, list(hrs))
        out['by_hour_band'][name] = head_to_head(y_actual[m], model_pred[m], baseline_pred[m])

    obs = np.array([train_obs_by_venue.get(v, 0) for v in venue])
    out['venue_obs_stats'] = {
        'min': int(obs.min()) if len(obs) else 0,
        'median': float(np.median(obs)) if len(obs) else 0,
        'mean': round(float(obs.mean()), 1) if len(obs) else 0,
        'max': int(obs.max()) if len(obs) else 0,
    }
    for name, lo, hi in OBS_BUCKETS:
        m = (obs >= lo) & (obs <= hi)
        r = head_to_head(y_actual[m], model_pred[m], baseline_pred[m])
        r['distinct_test_venues'] = int(len(set(venue[m].tolist())))
        out['by_venue_obs_count'][name] = r

    # Correlation between a venue's training-side live depth and its test error,
    # at VENUE level so 400-row venues do not dominate. This is the number the
    # spending decision hangs on; a bucket table can hide a flat trend.
    err = np.abs(y_actual - model_pred)
    berr = np.abs(y_actual - baseline_pred)
    dfv = pd.DataFrame({'venue': venue, 'obs': obs, 'err': err, 'berr': berr})
    agg = dfv.groupby('venue').agg(obs=('obs', 'first'), mae=('err', 'mean'),
                                   bmae=('berr', 'mean'), n=('err', 'size'))
    agg = agg[agg['n'] >= 20]
    if len(agg) >= 30 and agg['obs'].nunique() > 1:
        def rho(a, b):
            v = float(a.rank().corr(b.rank()))
            return round(v, 4) if np.isfinite(v) else None
        out['venue_level_trend'] = {
            'venues': int(len(agg)),
            'min_test_rows_per_venue': 20,
            'spearman_obs_vs_mae': rho(agg['obs'], agg['mae']),
            'spearman_obs_vs_model_minus_baseline': rho(agg['obs'], agg['mae'] - agg['bmae']),
            'note': ('negative spearman on obs_vs_mae = more live observations of a '
                     'venue means lower error on it'),
        }
    else:
        out['venue_level_trend'] = {
            'note': 'not measurable on this split — every test venue has the same '
                    'training-side observation count (the venue split holds ALL of '
                    'them out, so the count is 0 for every one).'}
    return out


def run_split(name, frame, X_base, y, y_actual, baseline, sample_weight,
              train_idx, test_idx, key_col, shipped_model, key_scope='all'):
    logger.info('=== %s split ===', name)
    disjoint = assert_split_disjoint(frame, train_idx, test_idx, key_col, name, key_scope)

    X, cat_info = refit_category_features(frame, train_idx, X_base)
    pred_delta = fit_and_predict(X, y, sample_weight, train_idx, test_idx, name)

    yt = y_actual[test_idx]
    bl = np.clip(baseline[test_idx], 0, 100)
    model_pred = reconstruct(pred_delta, baseline[test_idx])

    result = {
        'split': name,
        'disjointness': disjoint,
        'category_refit': cat_info,
        'headline': head_to_head(yt, model_pred, bl),
    }

    # Contamination reference: the SHIPPED artifact scored on the same rows. It
    # was fitted on them, so this is in-sample and must never be read as
    # accuracy — it is here to size how much of any good number is memory.
    ship_pred = reconstruct(shipped_model.predict(X_base[test_idx]), baseline[test_idx])
    result['shipped_model_in_sample'] = {
        **head_to_head(yt, ship_pred, bl),
        'WARNING': ('best_model.pkl was FITTED on these rows. This is in-sample and '
                    'is NOT an accuracy claim; it bounds how much of the honest '
                    'number could be memorisation.'),
    }

    train_rt = train_idx[frame['is_realtime'].values[train_idx] == 1]
    obs_by_venue = pd.Series(frame['venue_id'].values[train_rt]).value_counts().to_dict()
    result.update(breakdowns(frame, test_idx, yt, model_pred, bl, obs_by_venue))
    result['focus_cities'] = {c: result['by_city'].get(c) for c in FOCUS_CITIES}
    return result, test_idx, model_pred


def paired_familiarity_test(frame, y_actual, baseline, preds, tests):
    """Does having a venue's own live history in training actually help?

    The strict venue split beats baseline-alone by +2.25 MAE while the two date
    splits manage +1.21 and +0.83. The obvious reading — that an UNSEEN venue is
    easier than a seen one — is absurd on its face, so it is either a population
    difference or a real effect, and the bucket tables cannot separate the two
    because the three splits score different rows.

    This can. Take the rows that are held out by BOTH the venue split and the
    scattered-date split: held-out venue AND held-out date. Every one of them is
    out-of-sample for both models. The venue model has never seen that venue
    live; the scattered-date model has seen it live on other dates. Same rows,
    same labels, same baselines, one difference.
    """
    common = np.intersect1d(tests['venue'], tests['scattered_date'])
    if len(common) < 500:
        return {'note': f'only {len(common)} shared rows — not measured'}
    pos_v = {r: i for i, r in enumerate(tests['venue'])}
    pos_s = {r: i for i, r in enumerate(tests['scattered_date'])}
    pv = np.array([preds['venue'][pos_v[r]] for r in common])
    ps = np.array([preds['scattered_date'][pos_s[r]] for r in common])
    yt = y_actual[common]
    bl = np.clip(baseline[common], 0, 100)
    rt_train = ((frame['is_realtime'].values == 1)
                & ~np.isin(np.arange(len(frame)), tests['scattered_date']))
    obs = pd.Series(frame['venue_id'].values[rt_train]).value_counts().to_dict()
    seen = np.array([obs.get(v, 0) for v in frame['venue_id'].values[common]])
    out = {
        'rows': int(len(common)),
        'venue_unfamiliar_model': head_to_head(yt, pv, bl),
        'venue_familiar_model': head_to_head(yt, ps, bl),
        'familiar_minus_unfamiliar_mae': round(
            float(np.mean(np.abs(yt - ps)) - np.mean(np.abs(yt - pv))), 4),
        'median_live_rows_the_familiar_model_had_for_these_venues': float(np.median(seen)),
        'reading': ('positive familiar_minus_unfamiliar_mae means the model that HAD '
                    'the venue live history was WORSE on the identical rows.'),
    }
    # By depth. The bucket tables in by_venue_obs_count are confounded — venues
    # with more live rows also have BETTER baselines (their baseline within-10
    # runs 22-27% against 19-20% for shallow venues), so a shrinking improvement
    # there could just be shrinking headroom. This breakdown is not confounded:
    # within a depth band, both models are scored on the same rows against the
    # same baseline, and the only difference is the live history one of them had.
    out['by_depth'] = {}
    for name, lo, hi in OBS_BUCKETS:
        m = (seen >= lo) & (seen <= hi)
        if int(m.sum()) < 300:
            out['by_depth'][name] = {'rows': int(m.sum()), 'note': 'too few rows'}
            continue
        out['by_depth'][name] = {
            'rows': int(m.sum()),
            'unfamiliar_mae': round(float(np.mean(np.abs(yt[m] - pv[m]))), 4),
            'familiar_mae': round(float(np.mean(np.abs(yt[m] - ps[m]))), 4),
            'baseline_mae': round(float(np.mean(np.abs(yt[m] - bl[m]))), 4),
            'familiar_minus_unfamiliar': round(
                float(np.mean(np.abs(yt[m] - ps[m])) - np.mean(np.abs(yt[m] - pv[m]))), 4),
        }
    return out


def main():
    t0 = time.time()
    frame = rebuild_training_frame()
    feature_cols = frame.attrs['feature_cols']
    verification = verify_rebuild(frame)

    X_base = frame[feature_cols].values.astype(np.float32)
    y = frame['delta_label'].values.astype(np.float32)
    y_actual = frame['busyness_pct'].values.astype(np.float32)
    baseline = frame['baseline_busyness'].values.astype(np.float32)
    sample_weight = frame['sample_weight'].values.astype(np.float32)

    with open(SCRIPT_DIR / 'best_model.pkl', 'rb') as f:
        shipped_model = pickle.load(f)['model']

    results = {
        'generated_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'environment': {'device': DEVICE, 'n_jobs': THREADS,
                        'random_state': RANDOM_STATE, 'params': FIXED_PARAMS,
                        'clamp': list(CLAMP)},
        'rebuild_verification': verification,
        'corpus': {
            'rows': int(len(frame)),
            'realtime_served_rows': int(((frame['is_realtime'].values == 1)
                                         & serving_population_mask(baseline)).sum()),
            'date_range': [str(frame.loc[frame['is_realtime'] == 1, 'observed_date'].min()),
                           str(frame.loc[frame['is_realtime'] == 1, 'observed_date'].max())],
            'date_cutoff': DATE_CUTOFF,
            'venue_holdout_fraction': VENUE_HOLDOUT_FRACTION,
        },
        'splits': {},
    }

    # Reference points that need no fit, so the split numbers can be read
    # against something. (a) baseline-alone over the WHOLE realtime-served
    # population — the same 369,076 rows metadata.training_metrics_by_population
    # .realtime_served reports the LOCO model on, so LOCO's improvement over
    # baseline is directly comparable to this script's. (b) how deep the live
    # data actually is per venue, which is the thing a purchase would add to.
    rt_all = (frame['is_realtime'].values == 1) & serving_population_mask(baseline)
    results['reference'] = {
        'baseline_alone_on_all_realtime_served':
            metrics(y_actual[rt_all], np.clip(baseline[rt_all], 0, 100)),
        'loco_model_from_metadata': {
            'mae': 27.5426, 'r2': 0.1272, 'within_10': 22.8, 'rows': 369076,
            'source': 'models/model_metadata.json training_metrics_by_population'
                      '.realtime_served (leave-one-city-out)'},
    }
    depth = pd.Series(frame['venue_id'].values[rt_all]).value_counts()
    results['reference']['live_observation_depth_per_venue'] = {
        'venues_with_any_live_row': int(len(depth)),
        'venues_in_corpus': int(frame['venue_id'].nunique()),
        'median': float(depth.median()), 'mean': round(float(depth.mean()), 1),
        'p90': float(depth.quantile(0.9)), 'max': int(depth.max()),
        'total_live_rows': int(depth.sum()),
    }

    tests, preds = {}, {}
    for name, splitter, key, scope in (
            ('date', date_split, 'observed_date', 'all'),
            ('scattered_date', scattered_date_split, 'observed_date', 'all'),
            ('venue', venue_split, 'venue_id', 'all'),
            ('venue_with_anchor', venue_with_anchor_split, 'venue_id', 'realtime')):
        tr, te = splitter(frame)
        results['splits'][name], tests[name], preds[name] = run_split(
            name, frame, X_base, y, y_actual, baseline, sample_weight,
            tr, te, key, shipped_model, scope)

    results['paired_familiarity_test'] = paired_familiarity_test(
        frame, y_actual, baseline, preds, tests)

    results['elapsed_seconds'] = round(time.time() - t0, 1)
    with open(RESULTS_PATH, 'w') as f:
        json.dump(results, f, indent=2)
    logger.info('Wrote %s (%.1fs)', RESULTS_PATH, results['elapsed_seconds'])

    for name, r in results['splits'].items():
        h = r['headline']
        logger.info('%s: model MAE %s / W10 %s%%  |  baseline-alone MAE %s / W10 %s%%  '
                    '| improvement %+.2f MAE, %+.1f pp W10',
                    name, h['model']['mae'], h['model']['within_10'],
                    h['baseline_alone']['mae'], h['baseline_alone']['within_10'],
                    h['mae_improvement'], h['within_10_improvement'])


if __name__ == '__main__':
    main()
