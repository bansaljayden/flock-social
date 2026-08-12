"""
Feature engineering for Flock AI Crowd Forecasting Model.
Reads raw CSV exports and creates a clean feature matrix.
"""

import logging
import json
import math
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
    for s in ['spring', 'summer', 'fall', 'winter']:
        df[f'season_{s}'] = (df['season'] == s).astype(int)

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

    if 'observed_date' not in df.columns:
        df['observed_date'] = ''
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

    # Google types one-hot (top N most common)
    type_cols = ['google_type_1', 'google_type_2', 'google_type_3']
    all_types = []
    for col in type_cols:
        if col in df.columns:
            all_types.extend(df[col].dropna().tolist())

    type_counts = pd.Series(all_types).value_counts()
    top_types = type_counts.head(MAX_GOOGLE_TYPES).index.tolist()

    for t in top_types:
        col_name = f'gtype_{t}'
        df[col_name] = 0
        for tc in type_cols:
            if tc in df.columns:
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

    # Weather code groups
    df['weather_group'] = df['weather_condition_code'].apply(group_weather_code)
    weather_groups = ['clear', 'few_clouds', 'cloudy', 'light_rain', 'heavy_rain',
                      'snow', 'thunderstorm', 'other', 'unknown']
    for g in weather_groups:
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


def add_baseline_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add baseline busyness and data freshness features."""
    # Baseline busyness — smooth with adjacent hours so model learns gradual transitions
    df['baseline_busyness'] = df['baseline_busyness'].fillna(0)
    if 'venue_id' in df.columns:
        df = df.sort_values(['venue_id', 'day_of_week', 'hour'])
        df['_bl_prev'] = df.groupby(['venue_id', 'day_of_week'])['baseline_busyness'].shift(1)
        df['_bl_next'] = df.groupby(['venue_id', 'day_of_week'])['baseline_busyness'].shift(-1)
        df['_bl_prev'] = df['_bl_prev'].fillna(df['baseline_busyness'])
        df['_bl_next'] = df['_bl_next'].fillna(df['baseline_busyness'])
        mask = df['baseline_busyness'] > 0
        df.loc[mask, 'baseline_busyness'] = (df.loc[mask, 'baseline_busyness'] * 0.6 + df.loc[mask, '_bl_prev'] * 0.2 + df.loc[mask, '_bl_next'] * 0.2).round(1)
        df.drop(columns=['_bl_prev', '_bl_next'], inplace=True)

    # Category-level baseline — average busyness for this venue type at this day/hour
    cat_baseline = df.groupby(['venue_category', 'day_of_week', 'hour'])['busyness_pct'].transform('mean')
    df['category_baseline'] = cat_baseline.round(1)
    # Smooth category baselines: blend with adjacent hours via shift
    cat_lookup = df.groupby(['venue_category', 'day_of_week', 'hour'])['category_baseline'].first().reset_index()
    cat_lookup = cat_lookup.sort_values(['venue_category', 'day_of_week', 'hour'])
    cat_lookup['_prev'] = cat_lookup.groupby(['venue_category', 'day_of_week'])['category_baseline'].shift(1)
    cat_lookup['_next'] = cat_lookup.groupby(['venue_category', 'day_of_week'])['category_baseline'].shift(-1)
    cat_lookup['_prev'] = cat_lookup['_prev'].fillna(cat_lookup['category_baseline'])
    cat_lookup['_next'] = cat_lookup['_next'].fillna(cat_lookup['category_baseline'])
    cat_lookup['category_baseline_smooth'] = (cat_lookup['category_baseline'] * 0.6 + cat_lookup['_prev'] * 0.2 + cat_lookup['_next'] * 0.2).round(1)
    smooth_map = cat_lookup.set_index(['venue_category', 'day_of_week', 'hour'])['category_baseline_smooth']
    df['category_baseline'] = df.set_index(['venue_category', 'day_of_week', 'hour']).index.map(smooth_map).values
    df['category_baseline'] = df['category_baseline'].fillna(cat_baseline.round(1))

    # Refined category baseline — sliced by price tier and popularity
    # Splits venues into budget ($0-1) vs premium ($2+) and popular (rating>=4.3) vs average
    df['_price_tier'] = (df['price_level'].fillna(2) >= 2).astype(str)
    df['_popularity'] = (df['rating'].fillna(4.0) >= 4.3).astype(str)
    refined_baseline = df.groupby(['venue_category', '_price_tier', '_popularity', 'day_of_week', 'hour'])['busyness_pct'].transform('mean')
    df['refined_category_baseline'] = refined_baseline.round(1)
    # Fill gaps where a specific slice has too few samples — fall back to broad category
    df['refined_category_baseline'] = df['refined_category_baseline'].fillna(df['category_baseline'])
    df.drop(columns=['_price_tier', '_popularity'], inplace=True)

    # Flag whether we have a venue-specific baseline or are using category fallback
    df['has_venue_baseline'] = (df['baseline_busyness'] > 0).astype(int)

    # Data freshness — realtime observations are more reliable
    df['is_realtime'] = df['is_realtime'].fillna(0).astype(int)

    return df


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

    # Interaction features
    df['event_x_weekend'] = (df['has_nearby_event'] * df.get('is_weekend', 0)).astype(int)
    df['event_x_dinner'] = (df['has_nearby_event'] * df.get('is_dinner_hour', 0)).astype(int)
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
    }
    feature_cols = [c for c in df.columns if c not in exclude]
    return sorted(feature_cols)


def main():
    logger.info('Loading training data...')
    train_df = pd.read_csv(SCRIPT_DIR / 'training_data.csv')
    logger.info(f'Training data: {len(train_df)} rows')

    holdout_path = SCRIPT_DIR / 'holdout_data.csv'
    holdout_df = None
    if holdout_path.exists():
        holdout_df = pd.read_csv(holdout_path)
        logger.info(f'Holdout data: {len(holdout_df)} rows')

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
    train_df = add_baseline_features(train_df)
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
                if tc in holdout_df.columns:
                    holdout_df.loc[holdout_df[tc] == t, col_name] = 1

        holdout_df = add_weather_features(holdout_df)
        holdout_df = add_baseline_features(holdout_df)
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
        if 'baseline_busyness' not in holdout_df.columns:
            holdout_df['baseline_busyness'] = 0
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
    # baseline. Holdout is NOT filtered — quick_eval.py already reports the
    # realtime-only slice as the ship gate.
    before_filter = len(train_df)
    # v2.3.1 BLEND: pure realtime-only training (v2.3.0) overpredicted
    # deviations on ordinary nights (weekly holdout MAE 0.2 -> 11.7) because
    # nothing taught it "most moments are typical". Keep the weekly rows but
    # at 5% sample weight: enough anchor to calm typical nights, not enough
    # to drown the real deviations like v2.2.1 (where they were 91% of the
    # loss and taught delta=0 everywhere).
    train_df = train_df[train_df['baseline_busyness'] > 0]
    train_df['sample_weight'] = np.where(train_df['is_realtime'] == 1, 1.0, 0.05)
    n_rt = int((train_df['is_realtime'] == 1).sum())
    logger.info(
        f'v2.3.1 blend: {before_filter} -> {len(train_df)} rows with baseline>0 '
        f'({n_rt} realtime @ weight 1.0, {len(train_df) - n_rt} weekly @ weight 0.05; '
        f'effective realtime share of loss: {n_rt / (n_rt + 0.05 * (len(train_df) - n_rt)) * 100:.0f}%)'
    )
    if n_rt < 50000:
        raise ValueError(f'Only {n_rt} realtime rows — expected 100K+. Check is_realtime/baseline columns.')

    # Get feature columns (excludes baseline_busyness — now in label)
    feature_cols = get_feature_columns(train_df)

    # Ensure holdout has same columns
    if holdout_df is not None:
        for col in feature_cols:
            if col not in holdout_df.columns:
                holdout_df[col] = 0
        holdout_df = holdout_df[feature_cols + ['busyness_pct', 'delta_label', 'baseline_busyness', 'city']]

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
    if holdout_df is not None:
        holdout_df[feature_cols] = holdout_df[feature_cols].fillna(0)

    # Save
    logger.info('\nSaving artifacts...')

    # Save feature matrix as pickle
    # y = delta label (training target). y_actual + baseline kept for evaluation/reconstruction.
    train_data = {
        'X': train_df[feature_cols].values.astype(np.float32),
        'y': train_df['delta_label'].values.astype(np.float32),
        'y_actual': train_df['busyness_pct'].values.astype(np.float32),
        'baseline': train_df['baseline_busyness'].values.astype(np.float32),
        'sample_weight': train_df['sample_weight'].values.astype(np.float32) if 'sample_weight' in train_df.columns else None,
        'feature_cols': feature_cols,
        'cities': train_df['city'].values if 'city' in train_df.columns else None,
        'label_type': 'delta',
    }
    with open(SCRIPT_DIR / 'features_train.pkl', 'wb') as f:
        pickle.dump(train_data, f)

    if holdout_df is not None:
        holdout_data = {
            'X': holdout_df[feature_cols].values.astype(np.float32),
            'y': holdout_df['delta_label'].values.astype(np.float32),
            'y_actual': holdout_df['busyness_pct'].values.astype(np.float32),
            'baseline': holdout_df['baseline_busyness'].values.astype(np.float32),
            'feature_cols': feature_cols,
            'cities': holdout_df['city'].values,
            'label_type': 'delta',
        }
        with open(SCRIPT_DIR / 'features_holdout.pkl', 'wb') as f:
            pickle.dump(holdout_data, f)

    # Compute category baseline lookup table (category × day × hour → avg busyness)
    cat_baselines = train_df.groupby(['venue_category', 'day_of_week', 'hour'])['busyness_pct'].mean()
    cat_baseline_dict = {}
    for (cat, dow, hour), val in cat_baselines.items():
        key = f'{cat}_{int(dow)}_{int(hour)}'
        cat_baseline_dict[key] = round(float(val), 1)
    logger.info(f'Category baseline lookup: {len(cat_baseline_dict)} entries')

    # Refined baseline lookup (category × price_tier × popularity × day × hour)
    train_df['_pt'] = (train_df['price_level'].fillna(2) >= 2).astype(int)
    train_df['_pop'] = (train_df['rating'].fillna(4.0) >= 4.3).astype(int)
    ref_baselines = train_df.groupby(['venue_category', '_pt', '_pop', 'day_of_week', 'hour'])['busyness_pct'].mean()
    ref_baseline_dict = {}
    for (cat, pt, pop, dow, hour), val in ref_baselines.items():
        key = f'{cat}_{int(pt)}_{int(pop)}_{int(dow)}_{int(hour)}'
        ref_baseline_dict[key] = round(float(val), 1)
    train_df.drop(columns=['_pt', '_pop'], inplace=True)
    logger.info(f'Refined baseline lookup: {len(ref_baseline_dict)} entries')

    # Save metadata
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    metadata = {
        'feature_names': feature_cols,
        'feature_count': len(feature_cols),
        **venue_metadata,
        'weather_code_groups': {k: str(v) for k, v in WEATHER_GROUPS.items()},
        'category_baselines': cat_baseline_dict,
        'refined_baselines': ref_baseline_dict,
        'training_rows': len(train_df),
        'holdout_rows': len(holdout_df) if holdout_df is not None else 0,
    }
    with open(MODELS_DIR / 'model_metadata.json', 'w') as f:
        json.dump(metadata, f, indent=2)

    logger.info(f'Saved features_train.pkl ({len(train_df)} rows, {len(feature_cols)} features)')
    if holdout_df is not None:
        logger.info(f'Saved features_holdout.pkl ({len(holdout_df)} rows)')
    logger.info(f'Saved model_metadata.json')
    logger.info('Done!')


if __name__ == '__main__':
    main()
