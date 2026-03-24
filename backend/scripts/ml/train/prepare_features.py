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
    # Baseline busyness — the venue's typical busyness at this day/hour
    df['baseline_busyness'] = df['baseline_busyness'].fillna(0)

    # Deviation potential — model learns how much actual differs from baseline
    # Don't compute actual deviation (that would leak the label), just give the baseline

    # Data freshness — realtime observations are more reliable
    df['is_realtime'] = df['is_realtime'].fillna(0).astype(int)

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
        'busyness_pct',  # label
        'city', 'season', 'venue_category',  # raw categorical (encoded versions used)
        'weather_condition', 'weather_condition_code', 'weather_group',  # raw (encoded)
        'google_type_1', 'google_type_2', 'google_type_3',  # raw (one-hot encoded)
        'event_type',  # raw string from old pipeline (one-hot encoded as etype_*)
        'event_nearby', 'event_distance_km', 'event_size', 'event_hours_until',  # old sparse event cols
        'nearest_event_type',  # raw string (one-hot encoded as etype_*)
        'latitude', 'longitude', 'lat_bin', 'lng_bin',  # dropped to prevent geographic overfitting
        'baseline_busyness',  # BestTime's own output — data leakage, always exclude
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
    train_df = add_event_features(train_df)

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
        holdout_df = add_event_features(holdout_df)

    # Get feature columns
    feature_cols = get_feature_columns(train_df)

    # Ensure holdout has same columns
    if holdout_df is not None:
        for col in feature_cols:
            if col not in holdout_df.columns:
                holdout_df[col] = 0
        holdout_df = holdout_df[feature_cols + ['busyness_pct', 'city']]

    logger.info(f'Feature count: {len(feature_cols)}')
    logger.info(f'Features: {feature_cols}')

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
    train_data = {
        'X': train_df[feature_cols].values.astype(np.float32),
        'y': train_df['busyness_pct'].values.astype(np.float32),
        'feature_cols': feature_cols,
        'cities': train_df['city'].values if 'city' in train_df.columns else None,
    }
    with open(SCRIPT_DIR / 'features_train.pkl', 'wb') as f:
        pickle.dump(train_data, f)

    if holdout_df is not None:
        holdout_data = {
            'X': holdout_df[feature_cols].values.astype(np.float32),
            'y': holdout_df['busyness_pct'].values.astype(np.float32),
            'feature_cols': feature_cols,
            'cities': holdout_df['city'].values,
        }
        with open(SCRIPT_DIR / 'features_holdout.pkl', 'wb') as f:
            pickle.dump(holdout_data, f)

    # Save metadata
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    metadata = {
        'feature_names': feature_cols,
        'feature_count': len(feature_cols),
        **venue_metadata,
        'weather_code_groups': {k: str(v) for k, v in WEATHER_GROUPS.items()},
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
