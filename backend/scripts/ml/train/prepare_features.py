"""
Feature engineering for Flock AI Crowd Forecasting Model.
Reads raw CSV exports and creates a clean feature matrix.

FAIL LOUD, NEVER SILENT
-----------------------
Every soft `if column in df.columns` guard that used to live in this file has
been removed. The 2026-08-15 pre-retrain audit found three shipped fixes that
never reached an artifact because this script degraded quietly when the CSV was
not what it assumed: baseline smoothing was skipped, vendor-forecast labels were
all weighted 1.0, and the leave-one-out baseline never arrived. The corpus
contract is now checked up front and violations raise CorpusContractError.

Two deliberate escape hatches exist, both explicit, both logged, both recorded in
model_metadata.json so an artifact can never hide which one was used:

  FLOCK_WEATHER_POLICY=require|drop    (default require)
  FLOCK_CALENDAR_POLICY=require|drop   (default require)

`require` means "the corpus must carry this signal"; `drop` means "we know it is
absent, so remove the dead feature slots instead of shipping constants".
"""

import logging
import json
import math
import os
import pickle
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

SCRIPT_DIR = Path(__file__).parent
MODELS_DIR = SCRIPT_DIR.parent / 'models'

# Top 30 Google Places types (will be computed from data)
MAX_GOOGLE_TYPES = 30


class CorpusContractError(RuntimeError):
    """The CSV does not carry what this pipeline needs. Never degrade — stop."""


# ---------------------------------------------------------------------------
# Corpus contract — the exact column list export_training_data.js writes.
# Audit finding 1: the checked-in CSVs were a 40-column pre-round-10 export
# (no venue_id, no label_provenance) and this script silently accepted them.
# ---------------------------------------------------------------------------
EXPORT_COLUMNS: List[str] = [
    'venue_id',
    'day_of_week', 'hour', 'month', 'season',
    'is_holiday', 'is_school_break',
    'venue_category', 'price_level', 'rating', 'review_count',
    'temperature', 'humidity', 'wind_speed',
    'weather_condition', 'weather_condition_code', 'is_raining',
    'event_nearby', 'event_distance_km', 'event_size', 'event_type', 'event_hours_until',
    'has_nearby_event', 'nearest_event_distance_km', 'nearest_event_attendance',
    'total_nearby_events', 'total_nearby_attendance', 'nearest_event_type',
    'baseline_busyness', 'is_realtime',
    'busyness_pct',
    'city',
    'google_type_1', 'google_type_2', 'google_type_3',
    'latitude', 'longitude',
    'avg_user_crowd', 'user_feedback_count', 'avg_prediction_error',
    'observed_date', 'label_provenance',
]

EXPORTER_PATH = SCRIPT_DIR / 'export_training_data.js'


def require_export_columns(df: pd.DataFrame, csv_path: Path, label: str) -> None:
    """Hard contract check. Raises rather than degrading (audit finding 1)."""
    missing = [c for c in EXPORT_COLUMNS if c not in df.columns]
    if not missing:
        return
    hint = ''
    try:
        if csv_path.stat().st_mtime < EXPORTER_PATH.stat().st_mtime:
            hint = (f'\n  {csv_path.name} is OLDER than export_training_data.js '
                    f'— it is a stale export from a previous round.')
    except OSError:
        pass
    raise CorpusContractError(
        f'{label} ({csv_path}) is missing {len(missing)} required column(s): '
        f'{missing}.\n'
        f'  It has {len(df.columns)} columns; the current exporter writes '
        f'{len(EXPORT_COLUMNS)}.{hint}\n'
        f'  Fix: delete the stale CSVs and pickles, then re-run\n'
        f'    node export_training_data.js\n'
        f'  Do NOT start a retrain at prepare_features.py. venue_id drives the '
        f'baseline smoothing and label_provenance drives the vendor-forecast '
        f'sample weight; without them this script used to skip both in silence.'
    )


def _policy(env_name: str, default: str, allowed: set) -> str:
    value = os.environ.get(env_name, default).strip().lower()
    if value not in allowed:
        raise CorpusContractError(
            f'{env_name}={value!r} is not one of {sorted(allowed)}.'
        )
    if value != default:
        logger.warning(
            'POLICY OVERRIDE: %s=%s (default %s). This is recorded in '
            'model_metadata.json.', env_name, value, default
        )
    return value


WEATHER_POLICY = _policy('FLOCK_WEATHER_POLICY', 'require', {'require', 'drop'})
CALENDAR_POLICY = _policy('FLOCK_CALENDAR_POLICY', 'require', {'require', 'drop'})

# Smoke-test escape hatch for the realtime-row floor. A real retrain must never
# set this; it exists so the pipeline can be exercised on a synthetic fixture.
MIN_REALTIME_ROWS = int(os.environ.get('FLOCK_MIN_REALTIME_ROWS', '50000'))

# Features that a policy switched off for this run. get_feature_columns()
# excludes them, so metadata.feature_names never advertises a dead slot.
DROPPED_FEATURES: set = set()
DROP_REASONS: Dict[str, str] = {}


def drop_features(names: List[str], reason: str) -> None:
    DROPPED_FEATURES.update(names)
    for n in names:
        DROP_REASONS[n] = reason
    logger.warning('DROPPING %d feature(s) — %s: %s', len(names), reason, sorted(names))


# ---------------------------------------------------------------------------
# The population production actually scores with the model.
#
# mlPredictor routes any venue whose baseline is 0 to the rule engine, so a row
# with baseline == 0 is a row the model never serves. Audit finding 6: training
# filtered on this and the SHIP GATE did not, so the gate was decided on rows
# production refuses to serve. This predicate is the single definition of that
# population — prepare_features filters the training frame with it and
# quick_eval.py imports it for the gate slice. They cannot drift apart.
# ---------------------------------------------------------------------------
def serving_population_mask(baseline) -> np.ndarray:
    """True where production would serve the ML model rather than the rule engine."""
    return np.asarray(baseline, dtype=float) > 0

# Weather condition code groupings
WEATHER_GROUPS: Dict[str, List[range]] = {
    'thunderstorm': [range(200, 233)],
    'light_rain': [range(300, 322), range(500, 502)],
    'heavy_rain': [range(502, 532)],
    'snow': [range(600, 623)],
    'clear': [range(800, 801)],
    'few_clouds': [range(801, 803)],
    'cloudy': [range(803, 805)],
}

# The nine one-hot levels built from WEATHER_GROUPS (+ the two catch-alls).
# mlPredictor.groupWeatherCode produces exactly these names.
WEATHER_GROUP_NAMES: List[str] = ['clear', 'few_clouds', 'cloudy', 'light_rain',
                                  'heavy_rain', 'snow', 'thunderstorm', 'other',
                                  'unknown']

SEASON_NAMES: List[str] = ['spring', 'summer', 'fall', 'winter']


def group_weather_code(code: float) -> str:
    """Map OpenWeatherMap condition code to a group."""
    if pd.isna(code):
        return 'unknown'
    code_int = int(code)
    for group_name, ranges in WEATHER_GROUPS.items():
        for r in ranges:
            if code_int in r:
                return group_name
    return 'other'


# ---------------------------------------------------------------------------
# weather_condition_code recovery (audit finding 4)
#
# No collector has ever written weather_condition_code — it is NULL on 100% of
# the corpus, which made all ten weather_* one-hots constant (weather_unknown
# identically 1) and left the careful groupWeatherCode parity work in
# mlPredictor.js guarding a channel that carried nothing.
#
# The signal is recoverable: weather_condition holds the OpenWeatherMap
# `description` string on 3.29M of 3.57M rows. This is the canonical
# description -> condition-id table. It is a lookup of vendor constants, not an
# estimate: every description below is the documented text OWM returns for that
# id, so the recovered code produces exactly the group the live conditionId
# would have produced at inference. Descriptions NOT in this table are reported
# by name and count and, under the default policy, stop the run — a new
# description must be mapped deliberately, never bucketed to 'other' in silence.
# ---------------------------------------------------------------------------
WEATHER_DESCRIPTION_CODES: Dict[str, int] = {
    # Thunderstorm 2xx
    'thunderstorm with light rain': 200,
    'thunderstorm with rain': 201,
    'thunderstorm with heavy rain': 202,
    'light thunderstorm': 210,
    'thunderstorm': 211,
    'heavy thunderstorm': 212,
    'ragged thunderstorm': 221,
    'thunderstorm with light drizzle': 230,
    'thunderstorm with drizzle': 231,
    'thunderstorm with heavy drizzle': 232,
    # Drizzle 3xx
    'light intensity drizzle': 300,
    'drizzle': 301,
    'heavy intensity drizzle': 302,
    'light intensity drizzle rain': 310,
    'drizzle rain': 311,
    'heavy intensity drizzle rain': 312,
    'shower rain and drizzle': 313,
    'heavy shower rain and drizzle': 314,
    'shower drizzle': 321,
    # Rain 5xx
    'light rain': 500,
    'moderate rain': 501,
    'heavy intensity rain': 502,
    'very heavy rain': 503,
    'extreme rain': 504,
    'freezing rain': 511,
    'light intensity shower rain': 520,
    'shower rain': 521,
    'heavy intensity shower rain': 522,
    'ragged shower rain': 531,
    # Snow 6xx
    'light snow': 600,
    'snow': 601,
    'heavy snow': 602,
    'sleet': 611,
    'light shower sleet': 612,
    'shower sleet': 613,
    'light rain and snow': 615,
    'rain and snow': 616,
    'light shower snow': 620,
    'shower snow': 621,
    'heavy shower snow': 622,
    # Atmosphere 7xx — these all group to 'other', which is a real level
    'mist': 701,
    'smoke': 711,
    'haze': 721,
    'sand/dust whirls': 731,
    'fog': 741,
    'sand': 751,
    'dust': 761,
    'volcanic ash': 762,
    'squalls': 771,
    'tornado': 781,
    # Clear / clouds 800-804
    'clear sky': 800,
    'few clouds': 801,
    'scattered clouds': 802,
    'broken clouds': 803,
    'overcast clouds': 804,
}


def recover_weather_codes(df: pd.DataFrame, label: str) -> Dict:
    """Fill weather_condition_code from weather_condition text. Reports honestly.

    Returns a stats dict. Rows with neither a code nor a description keep NaN —
    "we have no weather reading" is a true statement about those rows and
    weather_unknown is the honest one-hot for them.
    """
    code = pd.to_numeric(df['weather_condition_code'], errors='coerce')
    had_code = int(code.notna().sum())

    desc = df['weather_condition'].astype('string').str.strip().str.lower()
    need = code.isna()
    mapped = desc.map(WEATHER_DESCRIPTION_CODES)

    recovered_mask = need & mapped.notna()
    # to_numeric again: .map against a nullable-string Series can hand back an
    # object column, and group_weather_code would then be int()-ing whatever the
    # CSV happened to contain.
    code = pd.to_numeric(code.where(~recovered_mask, mapped), errors='coerce')
    df['weather_condition_code'] = code

    unmapped = desc[need & mapped.isna() & desc.notna() & (desc != '')]
    unmapped_counts = unmapped.value_counts().to_dict()
    no_reading = int((need & (desc.isna() | (desc == ''))).sum())

    stats = {
        'rows': int(len(df)),
        'code_present_in_export': had_code,
        'recovered_from_description': int(recovered_mask.sum()),
        'no_weather_reading': no_reading,
        'unmapped_descriptions': {str(k): int(v) for k, v in unmapped_counts.items()},
        'final_coverage_pct': round(float(code.notna().mean()) * 100, 2),
    }
    logger.info(
        '[%s] weather codes: %d in export, %d recovered from description text, '
        '%d rows with no weather reading at all -> %.2f%% coverage',
        label, had_code, stats['recovered_from_description'], no_reading,
        stats['final_coverage_pct'],
    )
    if unmapped_counts:
        logger.error('[%s] %d UNMAPPED weather description(s): %s', label,
                     len(unmapped_counts), unmapped_counts)
    return stats


def enforce_weather_contract(stats: Dict) -> None:
    """Audit finding 4: never re-bake ten constant weather features in silence."""
    if WEATHER_POLICY == 'drop':
        drop_features(
            [f'weather_{g}' for g in WEATHER_GROUP_NAMES] + ['cold_outdoor'],
            'FLOCK_WEATHER_POLICY=drop — no usable weather_condition_code in the corpus',
        )
        return
    if stats['unmapped_descriptions']:
        raise CorpusContractError(
            'Unmapped weather descriptions: '
            f'{stats["unmapped_descriptions"]}.\n'
            '  Add each one to WEATHER_DESCRIPTION_CODES with its OpenWeatherMap '
            'condition id (do not guess a group), or set '
            'FLOCK_WEATHER_POLICY=drop to remove the weather one-hots entirely.'
        )
    if stats['final_coverage_pct'] <= 0:
        raise CorpusContractError(
            'weather_condition_code is empty on every row and nothing was '
            'recoverable from weather_condition.\n'
            '  All ten weather_* features would be constant (weather_unknown ≡ 1) '
            'and the model would have no weather-condition signal at all — the '
            'exact defect audit finding 4 describes.\n'
            '  Fix the collectors to write weather.conditionId, or set '
            'FLOCK_WEATHER_POLICY=drop to ship without the dead slots.'
        )


CALENDAR_FEATURES: List[str] = (
    ['month', 'month_sin', 'month_cos']
    + [f'season_{s}' for s in SEASON_NAMES]
    # month-derived: with no month these are computed off a fabricated mid-year
    # day-of-year / a global climatology fallback, so they go with it.
    + ['daylight_hours', 'hours_after_sunset', 'is_after_sunset',
       'temp_anomaly', 'is_warm_anomaly_evening']
)


def audit_calendar_coverage(df: pd.DataFrame, label: str) -> Dict:
    """Report how many rows carry a real month/season (audit finding 5)."""
    month = pd.to_numeric(df['month'], errors='coerce')
    good_month = month.between(1, 12)
    season = df['season'].astype('string').str.strip().str.lower()
    good_season = season.isin(SEASON_NAMES).fillna(False)
    stats = {
        'rows': int(len(df)),
        'rows_without_month': int((~good_month).sum()),
        'rows_without_season': int((~good_season).sum()),
    }
    stats['pct_without_month'] = round(stats['rows_without_month'] / max(len(df), 1) * 100, 2)
    logger.info('[%s] calendar coverage: %d rows without a usable month (%.2f%%), '
                '%d without a season',
                label, stats['rows_without_month'], stats['pct_without_month'],
                stats['rows_without_season'])
    return stats


def enforce_calendar_contract(stats: Dict) -> None:
    """Audit finding 5: month=0 with all four season one-hots at 0 cannot occur
    at inference — mlPredictor always emits month in 1..12 and exactly one
    season. Two-thirds of the corpus used to sit in that unreachable corner
    because add_temporal_features computed sin/cos of NaN and the final
    fillna(0) turned the NaN into a mathematically impossible point.
    """
    if CALENDAR_POLICY == 'drop':
        drop_features(
            CALENDAR_FEATURES,
            'FLOCK_CALENDAR_POLICY=drop — undated rows carry no real month/season',
        )
        return
    if stats['rows_without_month'] or stats['rows_without_season']:
        raise CorpusContractError(
            f'{stats["rows_without_month"]} rows ({stats["pct_without_month"]}%) have no '
            f'usable month and {stats["rows_without_season"]} have no season.\n'
            '  Filling them with 0 puts month=0, month_sin=0, month_cos=0 and all '
            'four season one-hots at 0 — a combination inference can NEVER produce, '
            'and a perfect proxy for row provenance (weekly vs realtime).\n'
            '  Fix one of:\n'
            '    - stamp month/season on weekly rows at collection time from the '
            'collection date (collectWeekly.js omits both today), or\n'
            '    - backfill them from collected_at in export_training_data.js, or\n'
            '    - set FLOCK_CALENDAR_POLICY=drop to remove every calendar-derived '
            f'feature ({len(CALENDAR_FEATURES)} of them) instead of faking it.'
        )


def add_temporal_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add cyclical and boolean temporal features."""
    # Cyclical encodings
    df['hour_sin'] = np.sin(2 * math.pi * df['hour'] / 24)
    df['hour_cos'] = np.cos(2 * math.pi * df['hour'] / 24)
    df['month_sin'] = np.sin(2 * math.pi * df['month'] / 12)
    df['month_cos'] = np.cos(2 * math.pi * df['month'] / 12)
    df['dow_sin'] = np.sin(2 * math.pi * df['day_of_week'] / 7)
    df['dow_cos'] = np.cos(2 * math.pi * df['day_of_week'] / 7)

    # Boolean flags
    df['is_weekend'] = df['day_of_week'].isin([0, 6]).astype(int)  # Sun=0, Sat=6
    df['is_friday_saturday_night'] = (
        (df['day_of_week'].isin([5, 6])) & (df['hour'] >= 18)
    ).astype(int)
    df['is_lunch_hour'] = df['hour'].between(11, 13).astype(int)
    df['is_dinner_hour'] = df['hour'].between(17, 21).astype(int)
    df['is_late_night'] = (df['hour'].between(22, 23) | df['hour'].between(0, 3)).astype(int)
    df['is_morning'] = df['hour'].between(6, 10).astype(int)

    # Season one-hot
    season = df['season'].astype('string').str.strip().str.lower()
    for s in SEASON_NAMES:
        # fillna(False): an absent season is "not this season" for every level,
        # which is only ever reached under FLOCK_CALENDAR_POLICY=drop — where
        # these columns are removed from the feature set anyway.
        df[f'season_{s}'] = (season == s).fillna(False).astype(int)

    return df


def add_astronomy_features(df: pd.DataFrame) -> pd.DataFrame:
    """Sunset/daylight from latitude + month + hour (v2.4).

    Dependency-free solar approximation using mid-month day-of-year. The SAME
    closed-form formula is implemented in mlPredictor.js so training and
    inference agree by construction. Rows have no dates, so mid-month is the
    honest resolution available; the signal is the seasonal daylight shape
    (patio dusk, early winter darkness), not exact sunset minutes.
    """
    doy = df['month'].fillna(6) * 30.4 - 15.2
    decl = -23.44 * np.cos(np.radians((360.0 / 365.0) * (doy + 10)))
    lat = df['latitude'].fillna(0).clip(-65, 65)
    x = (-np.tan(np.radians(lat)) * np.tan(np.radians(decl))).clip(-1, 1)
    daylight = 2 * np.degrees(np.arccos(x)) / 15.0
    df['daylight_hours'] = daylight
    sunset_hour = 12 + daylight / 2.0
    hh = np.where(df['hour'] < 5, df['hour'] + 24, df['hour'])  # 1 AM belongs to the evening
    df['hours_after_sunset'] = (hh - sunset_hour).clip(-8, 12)
    df['is_after_sunset'] = (df['hours_after_sunset'] > 0).astype(int)
    return df


def add_climate_anomaly(df: pd.DataFrame, norms: pd.DataFrame = None) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """Temperature vs latitude-band x month climatology (v2.4).

    Literature: anomaly vs seasonal norm predicts demand better than absolute
    temperature. Norms are computed FROM THE TRAINING SET (train split only,
    passed in for holdout/inference parity) on 5-degree latitude bands so
    inference needs only lat + month. Saved into model metadata for Node.
    """
    df['lat_band'] = (df['latitude'].fillna(0) / 5.0).round() * 5
    if norms is None:
        norms = (
            df.groupby(['lat_band', 'month'])['temperature']
            .mean().rename('temp_norm').reset_index()
        )
    df = df.merge(norms, on=['lat_band', 'month'], how='left')
    global_mean = float(norms['temp_norm'].mean())
    df['temp_norm'] = df['temp_norm'].fillna(global_mean)
    df['temp_anomaly'] = (df['temperature'].fillna(df['temp_norm']) - df['temp_norm']).clip(-25, 25)
    df['is_warm_anomaly_evening'] = ((df['temp_anomaly'] > 5) & (df['hour'] >= 17)).astype(int)
    return df, norms


def add_neighbor_features(df: pd.DataFrame) -> pd.DataFrame:
    """Neighbor-venue same-hour baseline activity (v2.4, agglomeration signal).

    For each venue: how much typical same-hour activity surrounds it within
    ~1km (3x3 grid of ~500m buckets), excluding itself. The academic result
    this encodes: nearby venues' demand predicts a venue's own demand.
    Inference computes the identical quantity via SQL over ml_venues +
    ml_venue_baselines (same source data).
    """
    df['_vkey'] = df['latitude'].round(5).astype(str) + '_' + df['longitude'].round(5).astype(str)
    vb = (
        df.groupby(['_vkey', 'day_of_week', 'hour'])
        .agg(bl=('baseline_busyness', 'mean'), lat=('latitude', 'first'), lng=('longitude', 'first'))
        .reset_index()
    )
    vb['bx'] = (vb['lat'] / 0.005).round().astype(np.int32)
    vb['by'] = (vb['lng'] / 0.005).round().astype(np.int32)

    bucket = (
        vb.groupby(['bx', 'by', 'day_of_week', 'hour'])
        .agg(b_sum=('bl', 'sum'), b_cnt=('bl', 'size'))
        .reset_index()
    )
    # 3x3 window sums via shifted copies
    shifted = []
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            s = bucket.copy()
            s['bx'] = s['bx'] + dx
            s['by'] = s['by'] + dy
            shifted.append(s)
    window = (
        pd.concat(shifted, ignore_index=True)
        .groupby(['bx', 'by', 'day_of_week', 'hour'])
        .agg(w_sum=('b_sum', 'sum'), w_cnt=('b_cnt', 'sum'))
        .reset_index()
    )
    vb = vb.merge(window, on=['bx', 'by', 'day_of_week', 'hour'], how='left')
    vb['neighbor_count'] = (vb['w_cnt'].fillna(1) - 1).clip(lower=0)
    vb['neighbor_baseline_same_hour'] = np.where(
        vb['neighbor_count'] > 0,
        (vb['w_sum'].fillna(vb['bl']) - vb['bl']) / vb['neighbor_count'].replace(0, 1),
        0.0,
    )
    nb = vb[['_vkey', 'day_of_week', 'hour', 'neighbor_count', 'neighbor_baseline_same_hour']]
    df = df.merge(nb, on=['_vkey', 'day_of_week', 'hour'], how='left')
    df['neighbor_count'] = df['neighbor_count'].fillna(0)
    df['log_neighbor_count'] = np.log1p(df['neighbor_count'])
    df['neighbor_baseline_same_hour'] = df['neighbor_baseline_same_hour'].fillna(0).clip(0, 100)
    return df


def add_holiday_features(df: pd.DataFrame) -> pd.DataFrame:
    """Special-night context from holidays.json (v2.5).

    Only realtime rows carry observed_date (weekly rows are a synthetic
    "typical week" — they get zeros, which is the truth: a typical Tuesday is
    not a special night). Lookup mirrors backend/scripts/ml/specialNights.js:
    country layer keyed by the city's calendar, city layer wins collisions.
    Effects are confidence-weighted signed evidence, not magnitudes — the
    trees learn the magnitude per effect from the data.
    """
    from datetime import date as _date, timedelta as _timedelta

    hol = json.loads((SCRIPT_DIR.parent / 'holidays.json').read_text(encoding='utf-8'))
    cities_map = hol.get('cities', {})
    special = hol.get('special_nights', {})
    hol_sets = {k: set(v) for k, v in hol.get('holidays', {}).items()}
    conf_w = {'high': 1.0, 'med': 0.6, 'low': 0.3}

    def ctx(key):
        city, date_str = key.split('|', 1)
        cal = cities_map.get(city)
        if not date_str or not cal:
            return (0, 0.0, 0.0, 0)
        country = cal.split('_')[0]
        hit = (special.get(city, {}).get(date_str)
               or special.get(country, {}).get(date_str))
        is_sp, boost, suppress = 0, 0.0, 0.0
        if hit:
            is_sp = 1
            w = conf_w.get(hit.get('conf'), 0.3)
            if hit['effect'] == 'boost':
                boost = w
            elif hit['effect'] == 'suppress':
                suppress = w
        y, m, d = (int(x) for x in date_str.split('-'))
        eve = 1 if str(_date(y, m, d) + _timedelta(days=1)) in hol_sets.get(cal, ()) else 0
        return (is_sp, boost, suppress, eve)

    keys = df['city'].fillna('').astype(str) + '|' + df['observed_date'].fillna('').astype(str)
    lut = {k: ctx(k) for k in keys.unique()}
    vals = np.array([lut[k] for k in keys], dtype=float)
    df['is_special_night'] = vals[:, 0].astype(int)
    df['special_boost'] = vals[:, 1]
    df['special_suppress'] = vals[:, 2]
    df['is_holiday_eve'] = vals[:, 3].astype(int)
    n = int(df['is_special_night'].sum())
    e = int(df['is_holiday_eve'].sum())
    logger.info(f'Holiday features: {n} special-night rows, {e} holiday-eve rows')
    return df


def add_venue_features(df: pd.DataFrame) -> Tuple[pd.DataFrame, Dict]:
    """Add venue-derived features and encode categories."""
    # Category encoding
    categories = sorted(df['venue_category'].dropna().unique().tolist())
    cat_map = {cat: i for i, cat in enumerate(categories)}
    df['venue_category_encoded'] = df['venue_category'].map(cat_map).fillna(-1).astype(int)

    # Price level — fill missing with median
    median_price = df['price_level'].median()
    if pd.isna(median_price):
        median_price = 2
    df['price_level'] = df['price_level'].fillna(median_price)

    # Rating — fill missing with median
    median_rating = df['rating'].median()
    if pd.isna(median_rating):
        median_rating = 4.0
    df['rating'] = df['rating'].fillna(median_rating)

    # Review count + log transform
    df['review_count'] = df['review_count'].fillna(0)
    df['log_review_count'] = np.log1p(df['review_count'])

    # Google types one-hot (top N most common). The columns are part of the
    # export contract, so their absence is a contract error, not a skip.
    type_cols = ['google_type_1', 'google_type_2', 'google_type_3']
    all_types = []
    for col in type_cols:
        all_types.extend(df[col].dropna().tolist())

    type_counts = pd.Series(all_types).value_counts()
    top_types = type_counts.head(MAX_GOOGLE_TYPES).index.tolist()

    for t in top_types:
        col_name = f'gtype_{t}'
        df[col_name] = 0
        for tc in type_cols:
            df.loc[df[tc] == t, col_name] = 1

    metadata = {
        'category_encoding': cat_map,
        'median_price_level': float(median_price),
        'median_rating': float(median_rating),
        'top_google_types': top_types,
    }

    return df, metadata


def add_weather_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add weather-derived features."""
    # Fill missing weather data
    # Temperature: fill with city-month median, then global median
    city_month_temp = df.groupby(['city', 'month'])['temperature'].transform('median')
    df['temperature'] = df['temperature'].fillna(city_month_temp)
    global_temp_median = df['temperature'].median()
    if pd.isna(global_temp_median):
        global_temp_median = 20.0
    df['temperature'] = df['temperature'].fillna(global_temp_median)

    df['humidity'] = df['humidity'].fillna(50)
    df['wind_speed'] = df['wind_speed'].fillna(0)
    df['is_raining'] = df['is_raining'].fillna(0).astype(int)

    # Weather code groups. recover_weather_codes() has already run, so a NaN
    # here means the row genuinely carries no weather reading — 'unknown' is
    # then the truthful level, not a silent stand-in for the whole corpus.
    df['weather_group'] = df['weather_condition_code'].apply(group_weather_code)
    for g in WEATHER_GROUP_NAMES:
        df[f'weather_{g}'] = (df['weather_group'] == g).astype(int)

    # Interaction features
    df['rain_x_weekend'] = df['is_raining'] * df['is_weekend']
    df['rain_x_dinner'] = df['is_raining'] * df['is_dinner_hour']
    df['cold_outdoor'] = ((df['temperature'] < 5) & (df['weather_clear'] == 1)).astype(int)

    return df


def add_geographic_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add geographic binning features."""
    df['lat_bin'] = (df['latitude'] * 10).round() / 10
    df['lng_bin'] = (df['longitude'] * 10).round() / 10
    return df


CAT_KEYS = ['venue_category', 'day_of_week', 'hour']
REFINED_KEYS = ['venue_category', '_price_tier', '_popularity', 'day_of_week', 'hour']


def _slice_keys(df: pd.DataFrame) -> pd.DataFrame:
    """Price/popularity tier columns used to slice the refined baseline."""
    df['_price_tier'] = (df['price_level'].fillna(2) >= 2).astype(int)
    df['_popularity'] = (df['rating'].fillna(4.0) >= 4.3).astype(int)
    return df


def build_category_baseline_maps(df: pd.DataFrame) -> Dict:
    """Category/refined baseline lookups — TRAINING DATA ONLY.

    Round 10 (leakage): both lookups are averages of busyness_pct, i.e. the
    LABEL, and neither is in get_feature_columns' exclude set. The holdout
    split used to call add_baseline_features() on itself, so held-out labels
    built the held-out rows' own features — the model was handed the answer and
    every holdout number was inflated. Same class of bug as the popular_times
    leak in the retrain doctrine: a feature that quietly carries the label.

    They stay in the feature set (a category's typical shape is genuinely
    useful and inference can compute it from metadata alone), but the lookup is
    now fit on training rows and merely APPLIED to holdout, exactly like the
    climate norms in add_climate_anomaly.
    """
    df = _slice_keys(df.copy())

    cat = (
        df.groupby(CAT_KEYS)['busyness_pct'].mean().round(1)
        .rename('category_baseline').reset_index()
        .sort_values(CAT_KEYS)
    )
    cat['_prev'] = cat.groupby(['venue_category', 'day_of_week'])['category_baseline'].shift(1)
    cat['_next'] = cat.groupby(['venue_category', 'day_of_week'])['category_baseline'].shift(-1)
    cat['_prev'] = cat['_prev'].fillna(cat['category_baseline'])
    cat['_next'] = cat['_next'].fillna(cat['category_baseline'])
    # Smooth across adjacent hours so the model sees gradual transitions.
    cat['smooth'] = (cat['category_baseline'] * 0.6 + cat['_prev'] * 0.2 + cat['_next'] * 0.2).round(1)

    refined = df.groupby(REFINED_KEYS)['busyness_pct'].mean().round(1)

    return {
        'category': cat.set_index(CAT_KEYS)['smooth'],
        'refined': refined,
        'global_mean': round(float(df['busyness_pct'].mean()), 1),
    }


def smooth_baseline_hours(df: pd.DataFrame) -> pd.DataFrame:
    """Blend each venue-hour's baseline with its true adjacent hours.

    Audit finding 3: this used to be `groupby(venue_id, dow).shift(1)`, i.e. the
    previous ROW, not the previous HOUR. ml_training_data has no unique
    constraint, so 16% of (venue, dow, hour) cells hold more than one row
    (realtime cells average 2.05 and reach 8) — for k rows in a cell, k-1 of
    them were smoothed against their own hour, biasing the delta label on
    exactly the realtime rows that carry sample weight 1.0.

    The fix collapses each cell to ONE value, lays those onto a complete 7x24
    grid so a MISSING hour is a real gap instead of a silent positional
    neighbour, and merges the two NEIGHBOUR hours back onto every row.

    THE CENTRE TERM STAYS ROW-SPECIFIC, and that is not a detail. Round 13 made
    export_training_data.js compute baseline_busyness leave-one-out:
    b_i = (sum - y_i) / (n - 1), so a row's baseline never contains its own
    label. Averaging the duplicates in a cell would undo it exactly —
    mean_i(b_i) = sum/n, the plain average INCLUDING every row's own label. So
    the blend uses the row's own leave-one-out value at the centre and cell
    means only for the neighbours, which belong to a different hour and
    therefore cannot contain this row's label.

    The blend mirrors mlPredictor.getBaseline:
      - neighbours are the adjacent CLOCK hours and wrap across the day
        boundary (23 -> next day 00, 00 -> previous day 23);
      - a neighbour that is absent or 0 is treated as unavailable and falls back
        to the centre value;
      - with neither neighbour available the centre value passes through;
      - the result is rounded the way JS Math.round rounds (half up).
    """
    cell = (df.groupby(['venue_id', 'day_of_week', 'hour'], as_index=False)
              ['baseline_busyness'].mean())
    cell['venue_id'] = cell['venue_id'].astype(str)
    cell['day_of_week'] = pd.to_numeric(cell['day_of_week'], errors='coerce')
    cell['hour'] = pd.to_numeric(cell['hour'], errors='coerce')
    cell = cell.dropna(subset=['day_of_week', 'hour'])
    cell['day_of_week'] = cell['day_of_week'].astype('int64')
    cell['hour'] = cell['hour'].astype('int64')
    out_of_grid = cell[~cell['day_of_week'].between(0, 6) | ~cell['hour'].between(0, 23)]
    if len(out_of_grid):
        raise CorpusContractError(
            f'{len(out_of_grid)} (venue, day_of_week, hour) cells fall outside the '
            '7x24 week grid — day_of_week must be 0-6 and hour 0-23. '
            f'Sample: {out_of_grid.head(3).to_dict("records")}'
        )

    venues = cell['venue_id'].unique()
    grid_index = pd.MultiIndex.from_product(
        [venues, range(7), range(24)], names=['venue_id', 'day_of_week', 'hour'])
    series = (cell.set_index(['venue_id', 'day_of_week', 'hour'])['baseline_busyness']
                  .reindex(grid_index))
    arr = series.to_numpy(dtype=float).reshape(len(venues), 7 * 24)

    # np.roll over the flattened 168-slot week gives the true clock neighbour,
    # including the day-boundary and week-boundary wraps production uses.
    prev = np.nan_to_num(np.roll(arr, 1, axis=1), nan=0.0)
    nxt = np.nan_to_num(np.roll(arr, -1, axis=1), nan=0.0)

    out = pd.DataFrame({
        'venue_id': np.repeat(venues, 7 * 24),
        'day_of_week': np.tile(np.repeat(np.arange(7), 24), len(venues)).astype('float64'),
        'hour': np.tile(np.arange(24), 7 * len(venues)).astype('float64'),
        '_bl_prev': prev.reshape(-1),
        '_bl_next': nxt.reshape(-1),
    })

    keys = pd.DataFrame({
        'venue_id': df['venue_id'].astype(str).values,
        'day_of_week': pd.to_numeric(df['day_of_week'], errors='coerce').astype('float64').values,
        'hour': pd.to_numeric(df['hour'], errors='coerce').astype('float64').values,
    })
    merged = keys.merge(out, on=['venue_id', 'day_of_week', 'hour'], how='left')
    if len(merged) != len(df):
        raise CorpusContractError(
            'Baseline smoothing merge changed the row count '
            f'({len(df)} -> {len(merged)}). The (venue_id, day_of_week, hour) '
            'grid is not unique; refusing to continue with duplicated rows.'
        )

    current = df['baseline_busyness'].to_numpy(dtype=float)
    prev_row = np.nan_to_num(merged['_bl_prev'].to_numpy(dtype=float), nan=0.0)
    next_row = np.nan_to_num(merged['_bl_next'].to_numpy(dtype=float), nan=0.0)

    has_neighbour = (prev_row > 0) | (next_row > 0)
    prev_eff = np.where(prev_row > 0, prev_row, current)
    next_eff = np.where(next_row > 0, next_row, current)
    blended = np.floor(current * 0.6 + prev_eff * 0.2 + next_eff * 0.2 + 0.5)
    df['baseline_busyness'] = np.where((current > 0) & has_neighbour, blended, current)
    return df


def add_baseline_features(df: pd.DataFrame, cat_maps: Dict = None) -> Tuple[pd.DataFrame, Dict]:
    """Add baseline busyness and data freshness features.

    cat_maps: category/refined baseline lookups. None means "fit them from this
    frame" (training); pass the training maps for holdout/eval so no held-out
    label ever reaches a feature.
    """
    # Baseline busyness — smoothed against the TRUE neighbouring hours.
    df['baseline_busyness'] = df['baseline_busyness'].fillna(0)
    df = smooth_baseline_hours(df)

    if cat_maps is None:
        cat_maps = build_category_baseline_maps(df)

    df = _slice_keys(df)

    # Category-level baseline — typical busyness for this venue type at this day/hour
    df['category_baseline'] = df.set_index(CAT_KEYS).index.map(cat_maps['category']).values
    df['category_baseline'] = df['category_baseline'].fillna(cat_maps['global_mean'])

    # Refined category baseline — sliced by price tier and popularity
    # Splits venues into budget ($0-1) vs premium ($2+) and popular (rating>=4.3) vs average
    df['refined_category_baseline'] = df.set_index(REFINED_KEYS).index.map(cat_maps['refined']).values
    # Fill gaps where a specific slice has too few samples — fall back to broad category
    df['refined_category_baseline'] = df['refined_category_baseline'].fillna(df['category_baseline'])
    df.drop(columns=['_price_tier', '_popularity'], inplace=True)

    # Flag whether we have a venue-specific baseline or are using category fallback
    df['has_venue_baseline'] = (df['baseline_busyness'] > 0).astype(int)

    # Data freshness — realtime observations are more reliable
    df['is_realtime'] = df['is_realtime'].fillna(0).astype(int)

    return df, cat_maps


def add_user_feedback_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add user feedback signals — crowd_level reports and prediction error."""
    df['avg_user_crowd'] = df['avg_user_crowd'].fillna(0)
    df['user_feedback_count'] = df['user_feedback_count'].fillna(0)
    df['log_user_feedback_count'] = np.log1p(df['user_feedback_count'])
    df['has_user_feedback'] = (df['user_feedback_count'] > 0).astype(int)
    df['avg_prediction_error'] = df['avg_prediction_error'].fillna(0)
    return df


def add_event_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add Ticketmaster event proximity features."""
    # Core event features — fill missing with 0
    df['has_nearby_event'] = df['has_nearby_event'].fillna(0).astype(int)
    df['nearest_event_attendance'] = df['nearest_event_attendance'].fillna(0)
    df['log_nearest_event_attendance'] = np.log1p(df['nearest_event_attendance'])
    df['total_nearby_events'] = df['total_nearby_events'].fillna(0)
    df['total_nearby_attendance'] = df['total_nearby_attendance'].fillna(0)
    df['log_total_nearby_attendance'] = np.log1p(df['total_nearby_attendance'])
    df['nearest_event_distance_km'] = df['nearest_event_distance_km'].fillna(0)

    # Large event flag
    df['large_event_nearby'] = (df['nearest_event_attendance'] > 5000).astype(int)

    # Interaction features. add_temporal_features runs first and is the only
    # producer of is_weekend / is_dinner_hour — a soft df.get(..., 0) here used
    # to turn a call-order mistake into two silently-zero interaction features.
    for needed in ('is_weekend', 'is_dinner_hour'):
        if needed not in df.columns:
            raise CorpusContractError(
                f'add_event_features needs {needed}; call add_temporal_features first.')
    df['event_x_weekend'] = (df['has_nearby_event'] * df['is_weekend']).astype(int)
    df['event_x_dinner'] = (df['has_nearby_event'] * df['is_dinner_hour']).astype(int)
    df['event_x_bar'] = (
        df['has_nearby_event'] *
        df['venue_category'].isin(['bar', 'nightclub']).astype(int)
    ).astype(int)

    # Event type one-hot encoding
    event_types = ['music', 'sports', 'arts', 'family', 'other']
    for etype in event_types:
        df[f'etype_{etype}'] = (df['nearest_event_type'] == etype).astype(int)

    return df


def get_feature_columns(df: pd.DataFrame) -> List[str]:
    """Return the list of feature columns (excluding label, identifiers)."""
    exclude = {
        'busyness_pct',  # absolute label
        'delta_label',   # delta label (training target)
        'city', 'season', 'venue_category',  # raw categorical (encoded versions used)
        'weather_condition', 'weather_condition_code', 'weather_group',  # raw (encoded)
        'google_type_1', 'google_type_2', 'google_type_3',  # raw (one-hot encoded)
        'event_type',  # raw string from old pipeline (one-hot encoded as etype_*)
        'event_nearby', 'event_distance_km', 'event_size', 'event_hours_until',  # old sparse event cols
        'nearest_event_type',  # raw string (one-hot encoded as etype_*)
        'latitude', 'longitude', 'lat_bin', 'lng_bin',  # dropped to prevent geographic overfitting
        'baseline_busyness',  # Google popular_times — moved into label as delta to prevent leakage
        'has_venue_baseline',  # leaks the same signal as baseline_busyness
        'user_feedback_count',  # raw count — use log_user_feedback_count instead
        'sample_weight',  # training weight — NEVER a feature (encodes row provenance = label regime)
        '_vkey', 'lat_band', 'temp_norm', 'neighbor_count',  # v2.4 intermediates (log_neighbor_count is the feature)
        'observed_date',  # raw date string — v2.5 holiday features are derived from it
        # Round 10 additions:
        'venue_id',  # identifier — a feature here is pure venue memorization
        'label_provenance',  # raw string; encodes label regime like sample_weight
    }
    exclude |= DROPPED_FEATURES
    feature_cols = [c for c in df.columns if c not in exclude]
    return sorted(feature_cols)


def main():
    logger.info('Loading training data...')
    train_path = SCRIPT_DIR / 'training_data.csv'
    if not train_path.exists():
        raise CorpusContractError(
            f'{train_path} does not exist. Run `node export_training_data.js` first — '
            'the retrain starts at the export, not at this script.'
        )
    train_df = pd.read_csv(train_path)
    logger.info(f'Training data: {len(train_df)} rows')
    require_export_columns(train_df, train_path, 'training_data.csv')

    holdout_path = SCRIPT_DIR / 'holdout_data.csv'
    if not holdout_path.exists():
        raise CorpusContractError(
            f'{holdout_path} does not exist. The ship gate is measured on the '
            'held-out cities; a run without them cannot be evaluated. Re-run '
            '`node export_training_data.js`.'
        )
    holdout_df = pd.read_csv(holdout_path)
    logger.info(f'Holdout data: {len(holdout_df)} rows')
    require_export_columns(holdout_df, holdout_path, 'holdout_data.csv')

    # ── CORPUS CONTRACT (audit findings 4 and 5) ────────────────────────────
    # Recover weather_condition_code from the description text, then decide the
    # weather and calendar policies ONCE, before any feature is built, so the
    # feature set that comes out of this run cannot contain a dead slot without
    # model_metadata.json saying so.
    weather_stats = recover_weather_codes(train_df, 'train')
    holdout_weather_stats = recover_weather_codes(holdout_df, 'holdout')
    combined_unmapped = dict(weather_stats['unmapped_descriptions'])
    for k, v in holdout_weather_stats['unmapped_descriptions'].items():
        combined_unmapped[k] = combined_unmapped.get(k, 0) + v
    enforce_weather_contract({**weather_stats, 'unmapped_descriptions': combined_unmapped})

    calendar_stats = audit_calendar_coverage(train_df, 'train')
    holdout_calendar_stats = audit_calendar_coverage(holdout_df, 'holdout')
    enforce_calendar_contract({
        'rows': calendar_stats['rows'] + holdout_calendar_stats['rows'],
        'rows_without_month': (calendar_stats['rows_without_month']
                               + holdout_calendar_stats['rows_without_month']),
        'rows_without_season': (calendar_stats['rows_without_season']
                                + holdout_calendar_stats['rows_without_season']),
        'pct_without_month': calendar_stats['pct_without_month'],
    })

    # Drop rows with null label
    train_df = train_df.dropna(subset=['busyness_pct'])
    logger.info(f'After dropping null labels: {len(train_df)} rows')

    # Drop rows where busyness_pct is 0 for suspiciously many hours (likely closed)
    # We keep individual 0s but flag venues that are always 0
    venue_means = train_df.groupby(['city', 'venue_category', 'latitude', 'longitude'])['busyness_pct'].mean()
    always_zero = venue_means[venue_means == 0].index
    if len(always_zero) > 0:
        before = len(train_df)
        train_df = train_df.set_index(['city', 'venue_category', 'latitude', 'longitude'])
        train_df = train_df.drop(always_zero, errors='ignore')
        train_df = train_df.reset_index()
        logger.info(f'Dropped {before - len(train_df)} rows from always-zero venues')

    # Feature engineering — training data
    logger.info('Engineering features...')
    train_df = add_temporal_features(train_df)
    train_df, venue_metadata = add_venue_features(train_df)
    train_df = add_weather_features(train_df)
    train_df, cat_baseline_maps = add_baseline_features(train_df)
    train_df = add_user_feedback_features(train_df)
    train_df = add_event_features(train_df)
    # v2.4 features (sunset/anomaly/neighbors) — see function docstrings
    train_df = add_astronomy_features(train_df)
    train_df, temp_norms = add_climate_anomaly(train_df)
    train_df = add_neighbor_features(train_df)
    # v2.5: special-night calendar features from observed_date
    train_df = add_holiday_features(train_df)
    venue_metadata['temp_norms'] = {
        f"{int(r.lat_band)}_{int(r.month)}": round(float(r.temp_norm), 2)
        for r in temp_norms.itertuples() if not pd.isna(r.month)
    }

    # Feature engineering — holdout data (same transforms)
    if holdout_df is not None:
        holdout_df = holdout_df.dropna(subset=['busyness_pct'])
        holdout_df = add_temporal_features(holdout_df)

        # Apply same category encoding
        cat_map = venue_metadata['category_encoding']
        holdout_df['venue_category_encoded'] = holdout_df['venue_category'].map(cat_map).fillna(-1).astype(int)
        holdout_df['price_level'] = holdout_df['price_level'].fillna(venue_metadata['median_price_level'])
        holdout_df['rating'] = holdout_df['rating'].fillna(venue_metadata['median_rating'])
        holdout_df['review_count'] = holdout_df['review_count'].fillna(0)
        holdout_df['log_review_count'] = np.log1p(holdout_df['review_count'])

        # Google types one-hot
        top_types = venue_metadata['top_google_types']
        for t in top_types:
            col_name = f'gtype_{t}'
            holdout_df[col_name] = 0
            for tc in ['google_type_1', 'google_type_2', 'google_type_3']:
                holdout_df.loc[holdout_df[tc] == t, col_name] = 1

        holdout_df = add_weather_features(holdout_df)
        # TRAIN maps — holdout labels must never build holdout features (round 10)
        holdout_df, _ = add_baseline_features(holdout_df, cat_maps=cat_baseline_maps)
        holdout_df = add_user_feedback_features(holdout_df)
        holdout_df = add_event_features(holdout_df)
        holdout_df = add_astronomy_features(holdout_df)
        holdout_df, _ = add_climate_anomaly(holdout_df, norms=temp_norms)  # TRAIN norms — no holdout leakage
        holdout_df = add_neighbor_features(holdout_df)
        holdout_df = add_holiday_features(holdout_df)

    # Compute delta label: y_delta = busyness_pct - baseline_busyness
    # Model predicts the delta; production reconstructs absolute as baseline + clamp(delta, -30, 30).
    # This removes the popular_times leakage (model can't trivially copy baseline as a feature).
    train_df['baseline_busyness'] = train_df['baseline_busyness'].fillna(0)
    train_df['delta_label'] = (train_df['busyness_pct'] - train_df['baseline_busyness']).astype(float)
    if holdout_df is not None:
        holdout_df['baseline_busyness'] = holdout_df['baseline_busyness'].fillna(0)
        holdout_df['delta_label'] = (holdout_df['busyness_pct'] - holdout_df['baseline_busyness']).astype(float)

    # ── v2.3 TRAINING-POPULATION FIX (the realtime discrepancy) ──────────────
    # 91% of rows are weekly popular_times snapshots where busyness_pct equals
    # baseline_busyness BY CONSTRUCTION, so their delta label is exactly 0.
    # Training on them teaches "predict 0" and drags every real deviation
    # toward zero — this is why v2.2.1's realtime-only within-10 was 18%.
    # Also: production only serves the delta model when baseline > 0 (the
    # no-baseline guard falls back to the rule engine), so rows with
    # baseline == 0 are a population we never serve.
    # v2.3 trains on the exact serving population: realtime rows with a real
    # baseline. The holdout FRAME is deliberately left unfiltered so overall
    # diagnostics still see every row — but the SHIP GATE slice is filtered with
    # the same serving_population_mask this filter uses (quick_eval.py imports
    # it). Audit finding 6: it was not, so the gate was decided partly on rows
    # production routes to the rule engine.
    before_filter = len(train_df)
    # v2.3.1 BLEND: pure realtime-only training (v2.3.0) overpredicted
    # deviations on ordinary nights (weekly holdout MAE 0.2 -> 11.7) because
    # nothing taught it "most moments are typical". Keep the weekly rows but
    # at 5% sample weight: enough anchor to calm typical nights, not enough
    # to drown the real deviations like v2.2.1 (where they were 91% of the
    # loss and taught delta=0 everywhere).
    train_df = train_df[serving_population_mask(train_df['baseline_busyness'])]
    # Round 10 (provenance): collection_mode='realtime' says WHEN a row was
    # taken, not that the number was observed. collectRealtime.js falls back to
    # BestTime's own forecast when live traffic is unavailable, and those rows
    # were carrying weight 1.0 — a vendor's prediction outranking every other
    # label in the corpus, and teaching the model to reproduce a competitor's
    # model rather than reality. Forecast-derived labels now sit between weekly
    # and live. Rows collected before label_provenance existed stay at 1.0:
    # their provenance is genuinely unknown and silently demoting the whole
    # historical corpus would be a bigger change than the bug.
    # label_provenance is part of the export contract (require_export_columns
    # already refused the file if it were absent). It used to be defaulted to
    # 'unknown' here when missing, which silently weighted EVERY vendor-forecast
    # label at 1.0 — the exact thing round 10 added the column to stop, and the
    # regime the shipped v2.5 model was trained under without anyone noticing.
    train_df['label_provenance'] = train_df['label_provenance'].fillna('unknown')
    is_forecast_label = (train_df['is_realtime'] == 1) & (train_df['label_provenance'] == 'forecast')
    train_df['sample_weight'] = np.where(
        train_df['is_realtime'] != 1, 0.05,
        np.where(is_forecast_label, 0.3, 1.0),
    )
    n_rt = int((train_df['is_realtime'] == 1).sum())
    n_fc = int(is_forecast_label.sum())
    total_w = float(train_df['sample_weight'].sum())
    rt_w = float(train_df.loc[train_df['is_realtime'] == 1, 'sample_weight'].sum())
    logger.info(
        f'v2.3.1 blend: {before_filter} -> {len(train_df)} rows with baseline>0 '
        f'({n_rt} realtime of which {n_fc} vendor-forecast @ weight 0.3, '
        f'{len(train_df) - n_rt} weekly @ weight 0.05; '
        f'effective realtime share of loss: {rt_w / total_w * 100:.0f}%)'
    )
    known_prov = sorted(train_df['label_provenance'].dropna().unique().tolist())
    logger.info(f'label_provenance levels present: {known_prov}')
    if known_prov == ['unknown']:
        raise CorpusContractError(
            'Every training row has label_provenance="unknown" — the column is '
            'present but carries no signal, so vendor-forecast labels would all '
            'be weighted 1.0 again. Re-export after collectRealtime.js has '
            'written label_source, or fix the export join.'
        )
    if n_rt < MIN_REALTIME_ROWS:
        raise ValueError(f'Only {n_rt} realtime rows — expected {MIN_REALTIME_ROWS}+. '
                         'Check is_realtime/baseline columns.')

    # Get feature columns (excludes baseline_busyness — now in label)
    feature_cols = get_feature_columns(train_df)

    # Ensure holdout has same columns. Zero-filling a MISSING feature is only
    # defensible for a one-hot level that genuinely never occurs in the holdout
    # cities (no venue of that Google type, no snow in Miami). Anything else
    # missing means the two frames went through different transforms, which is
    # a bug — so it stops the run instead of quietly becoming a column of zeros.
    ONE_HOT_PREFIXES = ('gtype_', 'etype_', 'weather_', 'season_')
    absent = [c for c in feature_cols if c not in holdout_df.columns]
    unexpected = [c for c in absent if not c.startswith(ONE_HOT_PREFIXES)]
    if unexpected:
        raise CorpusContractError(
            f'Holdout is missing {len(unexpected)} non-one-hot feature(s): {unexpected}.\n'
            '  These are not levels that can legitimately be absent from a city; '
            'the train and holdout frames were built by different code paths.'
        )
    if absent:
        logger.warning('Zero-filling %d one-hot level(s) absent from the holdout '
                       'cities (deliberate, level genuinely does not occur): %s',
                       len(absent), absent)
    for col in absent:
        holdout_df[col] = 0
    # label_provenance rides along (NOT a feature — see get_feature_columns)
    # so quick_eval can report the live-observed-only slice: vendor-forecast
    # labels in the realtime gate slice measure agreement with BestTime's
    # model, not with reality. hour/venue_category ride along so
    # evaluate_model.py's per-hour and per-category diagnostics are aligned to
    # the SAME rows as the predictions (audit finding 10) instead of being
    # positionally truncated against the raw CSV.
    keep_extra = ['busyness_pct', 'delta_label', 'baseline_busyness', 'city',
                  'label_provenance', 'venue_category']
    holdout_df = holdout_df[feature_cols + keep_extra]

    logger.info(f'Feature count: {len(feature_cols)}')
    logger.info(f'Features: {feature_cols}')
    logger.info(f'Delta label distribution: mean={train_df["delta_label"].mean():.2f}, std={train_df["delta_label"].std():.2f}, min={train_df["delta_label"].min():.0f}, max={train_df["delta_label"].max():.0f}')

    # Label distribution
    logger.info(f'\nLabel (busyness_pct) distribution:')
    logger.info(f'  Mean: {train_df["busyness_pct"].mean():.1f}')
    logger.info(f'  Median: {train_df["busyness_pct"].median():.1f}')
    logger.info(f'  Std: {train_df["busyness_pct"].std():.1f}')
    logger.info(f'  Min: {train_df["busyness_pct"].min()}, Max: {train_df["busyness_pct"].max()}')

    # Missing value report
    missing = train_df[feature_cols].isnull().sum()
    missing = missing[missing > 0]
    if len(missing) > 0:
        logger.info(f'\nMissing values:')
        for col, count in missing.items():
            logger.info(f'  {col}: {count} ({count/len(train_df)*100:.1f}%)')
    else:
        logger.info('\nNo missing values in features!')

    # Fill any remaining NaN in features with 0
    train_df[feature_cols] = train_df[feature_cols].fillna(0)
    holdout_df[feature_cols] = holdout_df[feature_cols].fillna(0)

    # Dead-slot report. A constant column is never a split in a tree model, so a
    # feature that carries one value is not a wrong number — it is a feature
    # slot that does nothing while metadata advertises it, and mlPredictor's
    # parity guards defend a channel with no content. That is exactly how ten
    # weather features and five feedback features went unnoticed for four
    # rounds. Reported, not fatal: some of these (event features) are legitimately
    # sparse and expected to fill in as data accrues.
    constant_cols = [c for c in feature_cols if train_df[c].nunique(dropna=False) <= 1]
    if constant_cols:
        logger.warning(
            'DEAD SLOTS — %d of %d features are CONSTANT across the training frame '
            'and can never be split on: %s',
            len(constant_cols), len(feature_cols), constant_cols)
    else:
        logger.info('No constant feature columns.')

    # Save
    logger.info('\nSaving artifacts...')

    # Save feature matrix as pickle
    # y = delta label (training target). y_actual + baseline kept for evaluation/reconstruction.
    # 'hour' and 'venue_category' are carried EXPLICITLY (audit finding 10):
    # evaluate_model.py used to re-read the 3.57M-row raw CSV and truncate it to
    # the length of the 2.07M-row filtered matrix, aligning unrelated rows — the
    # MAE-by-hour plot, the one diagnostic that would have caught a six-hour
    # clock skew, was drawn on scrambled pairs.
    train_data = {
        'X': train_df[feature_cols].values.astype(np.float32),
        'y': train_df['delta_label'].values.astype(np.float32),
        'y_actual': train_df['busyness_pct'].values.astype(np.float32),
        'baseline': train_df['baseline_busyness'].values.astype(np.float32),
        'sample_weight': train_df['sample_weight'].values.astype(np.float32),
        'feature_cols': feature_cols,
        'cities': train_df['city'].values,
        'hour': train_df['hour'].values.astype(np.int16),
        'venue_category': train_df['venue_category'].astype(str).values,
        'label_provenance': train_df['label_provenance'].astype(str).values,
        'label_type': 'delta',
    }
    with open(SCRIPT_DIR / 'features_train.pkl', 'wb') as f:
        pickle.dump(train_data, f)

    holdout_data = {
        'X': holdout_df[feature_cols].values.astype(np.float32),
        'y': holdout_df['delta_label'].values.astype(np.float32),
        'y_actual': holdout_df['busyness_pct'].values.astype(np.float32),
        'baseline': holdout_df['baseline_busyness'].values.astype(np.float32),
        'feature_cols': feature_cols,
        'cities': holdout_df['city'].values,
        'hour': holdout_df['hour'].values.astype(np.int16),
        'venue_category': holdout_df['venue_category'].astype(str).values,
        'label_type': 'delta',
        'label_provenance': holdout_df['label_provenance'].fillna('unknown').astype(str).values,
    }
    with open(SCRIPT_DIR / 'features_holdout.pkl', 'wb') as f:
        pickle.dump(holdout_data, f)

    # Category/refined baseline lookups shipped to Node for inference.
    # Round 10: these are now the EXACT maps used to build the training
    # features (see build_category_baseline_maps) instead of a second,
    # independently-computed set. The old code recomputed raw group means here
    # while training used a smoothed lookup, so mlPredictor served
    # category_baseline values the model had never been trained against.
    cat_baseline_dict = {
        f'{cat}_{int(dow)}_{int(hour)}': round(float(val), 1)
        for (cat, dow, hour), val in cat_baseline_maps['category'].items()
    }
    logger.info(f'Category baseline lookup: {len(cat_baseline_dict)} entries')

    ref_baseline_dict = {
        f'{cat}_{int(pt)}_{int(pop)}_{int(dow)}_{int(hour)}': round(float(val), 1)
        for (cat, pt, pop, dow, hour), val in cat_baseline_maps['refined'].items()
    }
    logger.info(f'Refined baseline lookup: {len(ref_baseline_dict)} entries')

    # Save metadata. This used to write a FRESH dict, silently dropping
    # ship_gate, label_type, delta_clamp_range, onnx_input_name, model_version
    # and feature_types — so re-running feature prep after an export put
    # production on the rule engine (mlPredictor.evaluateShipGate fails closed on
    # a missing gate). Now: merge, and explicitly evict the keys that DESCRIBE A
    # MODEL, because a new feature set invalidates them. Which keys were evicted
    # is logged rather than implied.
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    meta_path = MODELS_DIR / 'model_metadata.json'
    metadata = {}
    if meta_path.exists():
        try:
            metadata = json.loads(meta_path.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError) as err:
            logger.warning('Existing model_metadata.json unreadable (%s) — starting fresh.', err)
            metadata = {}
    STALE_AFTER_REPREP = ['ship_gate', 'evaluation', 'validation_baseline_delta',
                          'training_metrics', 'incumbent_comparison']
    evicted = [k for k in STALE_AFTER_REPREP if k in metadata]
    for k in evicted:
        metadata.pop(k)
    if evicted:
        logger.warning(
            'Evicted %s from model_metadata.json — they describe the PREVIOUS '
            'feature set. Run train_model.py -> evaluate_model.py -> quick_eval.py '
            'before shipping; until quick_eval writes ship_gate, mlPredictor.init() '
            'fails closed and the backend serves the rule engine.', evicted)

    metadata.update({
        'feature_names': feature_cols,
        'feature_count': len(feature_cols),
        **venue_metadata,
        'weather_code_groups': {k: str(v) for k, v in WEATHER_GROUPS.items()},
        'category_baselines': cat_baseline_dict,
        'refined_baselines': ref_baseline_dict,
        'training_rows': len(train_df),
        'holdout_rows': len(holdout_df),
        # Provenance of THIS feature build — an artifact can never hide which
        # policy produced it (audit findings 4 and 5).
        'corpus_contract': {
            'export_columns_required': len(EXPORT_COLUMNS),
            'weather_policy': WEATHER_POLICY,
            'calendar_policy': CALENDAR_POLICY,
            'weather_code_recovery': {
                'train': weather_stats,
                'holdout': holdout_weather_stats,
            },
            'calendar_coverage': {
                'train': calendar_stats,
                'holdout': holdout_calendar_stats,
            },
            'dropped_features': sorted(DROPPED_FEATURES),
            'dropped_feature_reasons': DROP_REASONS,
            'constant_feature_slots': constant_cols,
            'serving_population_filter': 'baseline_busyness > 0',
            'min_realtime_rows': MIN_REALTIME_ROWS,
        },
    })
    with open(meta_path, 'w') as f:
        json.dump(metadata, f, indent=2)

    logger.info(f'Saved features_train.pkl ({len(train_df)} rows, {len(feature_cols)} features)')
    if holdout_df is not None:
        logger.info(f'Saved features_holdout.pkl ({len(holdout_df)} rows)')
    logger.info(f'Saved model_metadata.json')
    logger.info('Done!')


if __name__ == '__main__':
    main()
