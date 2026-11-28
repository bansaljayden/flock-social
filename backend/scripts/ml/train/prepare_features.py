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

ROUND 26 (2026-09-04): NO VALUE REACHES THE MATRIX THAT NOBODY MEASURED
------------------------------------------------------------------------
The weekly rows stopped carrying weather, the collectors stopped writing event
defaults, and this file had to stop turning the resulting NULLs back into
numbers. Four things changed, each argued at its own function:

  * a missing temperature takes the climate norm serving would impute, fitted
    from observed readings only, so its anomaly is 0 rather than a per-city
    constant (fit_temperature_norms, add_weather_features);
  * nearest_event_type is normalised onto the model's five-level vocabulary,
    the two legacy values eventService.js wrote are mapped by their exact
    reading, and any other value stops the run (normalise_event_types);
  * a realtime row whose label_provenance is 'unknown' is EXCLUDED from both
    frames unless ML_ALLOW_UNKNOWN_PROVENANCE=true admits it, because it can
    no longer sit at the live weight beside rows that proved they are live
    (main);
  * the blanket fillna(0) over the feature columns is gone. Every feature has
    its own named fill, and a NaN that survives them is a fill somebody forgot,
    which stops the run instead of becoming a measured zero
    (refuse_unfilled_features).
"""

import logging
import json
import math
import os
import pickle
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd

# features_io sits beside this file. A caller that loads this file by path
# (importlib, as __tests__/mlExportColumnGrowth.test.js's driver does) has not
# put this folder on sys.path, so it goes on here before the import.
import sys as _sys
if str(Path(__file__).resolve().parent) not in _sys.path:
    _sys.path.insert(0, str(Path(__file__).resolve().parent))
import features_io  # noqa: E402  the label-trust stamp every pickle carries (2026-11-27); X beside a pickle

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
#
# Round 20 grew it from 42 to 44: label_source and vendor_forecast_pct, both
# APPENDED so no existing column changed position. They are CARRIED COLUMNS —
# read, validated, written into the pickles, and deliberately kept out of the
# feature set (get_feature_columns excludes both; see the reasoning there and in
# export_training_data.js's header). A pre-round-20 CSV now fails
# require_export_columns by name, which is the point: silently training without
# them is exactly the class of failure this contract exists to stop.
#
# Round 25 grew it to 45 on the same terms: events_observed, appended, carried,
# never featurised. It says whether the fourteen event columns on a row are a
# MEASUREMENT or the column defaults of migration 006. It is not a feature
# because there is no in-distribution way to say "unknown" to the shipped model
# (add_event_features fills every missing event value with 0 and every tree
# splits has_nearby_event at 0.5), so the feature keeps its no-information value
# and the fact rides alongside, where a retrain can weight on it, evaluate the
# observed slice separately, or drop the affected cities. It is EMPTY on the
# whole pre-045 corpus and that is not a gap to be filled: an observed false and
# a defaulted false left identical bytes in ml_training_data and no backfill can
# separate them. See scripts/ml/MODEL-METRICS.md.
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
    'label_source', 'vendor_forecast_pct',
    'events_observed',
    # 2026-09-26, migration 094: the live answer about itself (see below).
    'live_hour_start', 'live_venue_open', 'live_local_time',
]

# The last three (2026-09-26, migration 094) are what BestTime's live answer
# says about itself: analysis.hour_start, the hour the live value is measured
# for; venue_info.venue_open, Open or Closed, stored as a boolean; and
# venue_info.venue_current_localtime, the vendor clock at the call. CARRIED,
# never featurised (get_feature_columns): empty on every row collected before
# the collector wrote them, and serving has no live answer for an hour it
# forecasts.

EXPORTER_PATH = SCRIPT_DIR / 'export_training_data.js'

# The domain migration 025's CHECK constraint pins, plus the empty string the
# exporter writes for NULL. 'unknown' is NOT here: it is what the EXPORTER says
# about a row that never declared itself, never a value any collector may write,
# so seeing it in the raw column means something wrote past the constraint.
# 'owner_report' admitted 2026-08-28, lifting the interlock ownerLabelExport.js
# holds its side of: the value enters the domain in the SAME change that gives
# the weight ladder its tier below, because the half-done version (domain
# widened, ladder ignorant) would put a single self-interested reporter's tap
# in the weight-1.0 pool above live BestTime observations. 'user_report' stays
# OUT on purpose: its export path still carries the lookahead leak audit
# finding 13 documents, and mlFeedbackLabels.test.js pins that pair.
LABEL_SOURCE_VALUES = {'', 'live', 'forecast', 'owner_report'}

# The argued tier (ownerLabelExport.js handoff): above a weekly snapshot
# (0.05, not about the moment at all), below the 0.15 argued for three
# verified strangers agreeing, because this is ONE reporter whose incentives
# point at the number, with only the owner-median anchor between them and the
# label.
OWNER_LABEL_WEIGHT = 0.10


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
        f'sample weight; without them this script used to skip both in silence.\n'
        f'  label_source and vendor_forecast_pct joined the contract in round 20 '
        f'(export columns 43 and 44) and events_observed in round 25 (column 45). '
        f'They are carried, not featurised, so a CSV '
        f'that lacks them would still TRAIN — which is precisely why their absence '
        f'has to be an error here: it means the CSV predates the exporter, and a '
        f'stale CSV is never only missing the columns you noticed.'
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
# 'require' = every constant feature column must be one this file has already
# explained. 'warn' downgrades an unexplained one to a log line, which is what
# this check used to be and what let a Celsius threshold sit on a Fahrenheit
# column through every round. See EXPECTED_SPARSE_FEATURES.
DEAD_SLOT_POLICY = _policy('FLOCK_DEAD_SLOT_POLICY', 'require', {'require', 'warn'})
# The live features (add_live_features) are on; 'off' drops all five, for the
# ablation that measures them.
LIVE_FEATURE_POLICY = _policy('FLOCK_LIVE_FEATURES', 'on', {'on', 'off'})
# Masked copies of the realtime training rows, off by default: 'on' appends,
# for each such row, a copy with its newest reading masked and a copy with
# every reading-based input at the value serving sends when it has no reading.
# See the block above append_live_mask_copies.
LIVE_MASK_COPIES_ENV = 'FLOCK_LIVE_MASK_COPIES'
LIVE_MASK_COPIES_POLICY = _policy(LIVE_MASK_COPIES_ENV, 'off', {'off', 'on'})

# Smoke-test escape hatch for the realtime-row floor. A real retrain must never
# set this; it exists so the pipeline can be exercised on a synthetic fixture.
MIN_REALTIME_ROWS = int(os.environ.get('FLOCK_MIN_REALTIME_ROWS', '50000'))

# ---------------------------------------------------------------------------
# UNKNOWN PROVENANCE IS NOT A LIVE LABEL (round 26).
#
# 457,402 realtime rows were collected before label_source existed and
# migration 025 proves they cannot be told apart: an unknown share of them are
# BestTime's own forecast, stored as if observed. While every realtime row was
# in that state the guard below raised only when ALL of them were unknown, and
# the file argued that "silently demoting the whole historical corpus would be
# a bigger change than the bug". That argument expired on 2026-09-01, when the
# hourly sweep began writing label_source: the corpus now holds 4,577 rows that
# PROVED they are live beside 457,402 that cannot, the all-unknown guard no
# longer fires, and the weight-1.0 pool would be 99% rows nobody can vouch for.
#
# So an unknown realtime row is excluded from BOTH frames by default. Not
# downweighted: train_model.assert_weighting_matches_provenance requires every
# non-forecast realtime row to carry ONE weight, so there is no tier between
# forecast and live for these rows to sit in without changing the trainer,
# which this file may not do. ML_ALLOW_UNKNOWN_PROVENANCE=true admits them, at
# the live weight, loudly, and model_metadata.json records that it did. That is
# the pre-existing meaning of the variable ("train on the pre-2026-05 corpus
# anyway, knowing what it contains"); what changed is that the default no
# longer needs the whole corpus to be unknown before it says no.
#
# WHAT THIS COSTS TODAY, said plainly. The proven-live rows are all in philly
# and lehigh, so under the default the holdout cities (miami, tokyo, barcelona)
# have no realtime rows at all and the training frame has 4,577, below
# MIN_REALTIME_ROWS. That is the true state of the corpus: there is no
# live-labelled holdout yet. Either the hatch is set for a run that knows what
# it is scoring, or collection reaches a holdout city. Nothing here can make a
# third option appear by relabelling.
# ---------------------------------------------------------------------------
UNKNOWN_PROVENANCE_ENV = 'ML_ALLOW_UNKNOWN_PROVENANCE'


def unknown_provenance_admitted(env=os.environ) -> bool:
    return str(env.get(UNKNOWN_PROVENANCE_ENV, '')).strip().lower() == 'true'


def exclude_unknown_provenance(df: pd.DataFrame, label: str) -> Tuple[pd.DataFrame, Dict]:
    """Drop realtime rows whose provenance is 'unknown', unless admitted."""
    unknown, n_rt = unknown_provenance_rows(df)
    record = unknown_provenance_report(n_rt, int(unknown.sum()), label)
    if record['rows_excluded'] == 0:
        return df, record
    return df[~unknown], record


def unknown_provenance_rows(df: pd.DataFrame) -> Tuple[np.ndarray, int]:
    """(the realtime rows whose provenance is 'unknown', how many realtime rows)."""
    prov = df['label_provenance'].fillna('unknown')
    unknown = ((pd.to_numeric(df['is_realtime'], errors='coerce') == 1)
               & (prov == 'unknown')).to_numpy()
    n_rt = int((pd.to_numeric(df['is_realtime'], errors='coerce') == 1).sum())
    return unknown, n_rt


def unknown_provenance_report(n_rt: int, n_unknown: int, label: str) -> Dict:
    """exclude_unknown_provenance's record (and its warning) from the two counts."""
    admitted = unknown_provenance_admitted()
    record = {
        'realtime_rows': n_rt,
        'unknown_provenance_rows': n_unknown,
        'policy': 'admit_at_live_weight' if admitted else 'exclude',
        'rows_excluded': 0 if admitted else n_unknown,
    }
    if n_unknown == 0:
        return record
    if admitted:
        logger.warning(
            'POLICY OVERRIDE %s=true: [%s] %d of %d realtime rows have '
            'label_provenance="unknown" and are ADMITTED at the live weight. Migration '
            '025 records that an unknown share of them are the vendor forecast. This is '
            'recorded in model_metadata.json.', UNKNOWN_PROVENANCE_ENV, label, n_unknown, n_rt)
        return record
    logger.warning(
        '[%s] EXCLUDING %d of %d realtime rows whose label_provenance is "unknown": they '
        'predate label_source and cannot be told from a vendor forecast, so they may not '
        'sit at the live weight beside the %d rows that proved they are live. Set '
        '%s=true to admit them anyway.', label, n_unknown, n_rt, n_rt - n_unknown,
        UNKNOWN_PROVENANCE_ENV)
    return record

# ---------------------------------------------------------------------------
# THE LABEL QUARANTINE AND THE REPETITION CHECK (2026-11-27).
#
# From 23 October 2026 the provider's live endpoint answered with values made
# from its own weekly forecast, still flagged live, and they sit in the corpus
# as label_source 'live'. They were found only by looking: a venue's reading
# equalled its reading at the same hour seven days earlier in 89% to 99% of
# pairs, week after week, where real readings do so in 13% to 18%. The November
# retrain passed its gate on them.
#
# Two refusals, both made before anything is read into memory, on both export
# files, by one pass over five columns (check_label_trust):
#
#   1. QUARANTINE. backend/services/labelQuarantine.json names the windows that
#      were found; serving, the export and the evaluation scripts read the same
#      file. A live row dated inside one stops the run: export_training_data.js
#      leaves those rows out, so a file that holds them is an old export, and
#      training on it again is how the November result happened.
#   2. REPETITION. Every live-weight realtime row this run would train on is
#      paired with the same venue and hour seven days earlier; a week in which
#      half or more of at least REPETITION_MIN_PAIRS pairs are equal stops the
#      run. That is how the next feed that answers with its own forecast gets
#      caught before a model learns it, whatever the date.
#
# FLOCK_ALLOW_QUARANTINED_LABELS=true and FLOCK_ALLOW_REPEATING_LABELS=true let
# an analysis run that knows what it is reading proceed; both are recorded in
# model_metadata.json (label_trust), and neither belongs in a run that ships.
# ---------------------------------------------------------------------------
QUARANTINE_FILE = SCRIPT_DIR.parent.parent.parent / 'services' / 'labelQuarantine.json'
QUARANTINE_ENV = 'FLOCK_ALLOW_QUARANTINED_LABELS'
REPETITION_ENV = 'FLOCK_ALLOW_REPEATING_LABELS'
REPETITION_LIMIT_PCT = 50.0
REPETITION_MIN_PAIRS = 500
LABEL_TRUST: Dict = {}


def _env_true(name: str, env=os.environ) -> bool:
    return str(env.get(name, '')).strip().lower() == 'true'


def load_label_quarantine(path: Path = QUARANTINE_FILE) -> List[Dict]:
    """The windows of labelQuarantine.json, validated as services/labelQuarantine.js validates them."""
    return load_label_quarantine_snapshot(path)[0]


def load_label_quarantine_snapshot(path: Path = QUARANTINE_FILE) -> Tuple[List[Dict], str]:
    """(the windows, the SHA-256 of the very bytes they were parsed from): the
    check and the stamps it leads to name one version of the file, even if the
    file is edited while a preparation runs."""
    import hashlib
    blob = Path(path).read_bytes()
    return _validate_label_quarantine(json.loads(blob.decode('utf-8'))), hashlib.sha256(blob).hexdigest()


def _validate_label_quarantine(raw) -> List[Dict]:
    # The same schema services/labelQuarantine.js enforces: an object holding a
    # windows array (an empty or missing one is not "no quarantine", it is a
    # broken file), string ids, and evidence that is a non-empty list.
    if not isinstance(raw, dict) or not isinstance(raw.get('windows'), list):
        raise CorpusContractError('labelQuarantine.json: no windows array')
    windows, ids = [], set()
    for i, w in enumerate(raw['windows']):
        where = f'labelQuarantine.json windows[{i}]'
        if not isinstance(w, dict) or not isinstance(w.get('id'), str) or not w['id']:
            raise CorpusContractError(f'{where}: no id')
        if w['id'] in ids:
            raise CorpusContractError(f'{where}: duplicate id {w["id"]}')
        ids.add(w['id'])
        if w.get('label_source') != 'live':
            raise CorpusContractError(f"{where}: label_source must be 'live'")
        try:
            lo = pd.Timestamp(w.get('from_date')).strftime('%Y-%m-%d')
            hi = pd.Timestamp(w.get('through_date')).strftime('%Y-%m-%d')
        except Exception as err:
            raise CorpusContractError(f'{where}: from_date and through_date must both be dates ({err})')
        if lo != w.get('from_date') or hi != w.get('through_date'):
            raise CorpusContractError(f'{where}: dates must be written YYYY-MM-DD')
        if hi < lo:
            raise CorpusContractError(f'{where}: through_date is before from_date')
        if not isinstance(w.get('evidence'), list) or not w['evidence']:
            raise CorpusContractError(f'{where}: no evidence')
        windows.append({'id': w['id'], 'from_date': lo, 'through_date': hi})
    return windows


def quarantined_live_mask(source: pd.Series, dates: pd.Series, windows: List[Dict]) -> np.ndarray:
    """Realtime rows labelled live and dated inside a window (callers pass realtime rows only)."""
    live = source.astype('string').fillna('').str.strip() == 'live'
    d = dates.astype('string').fillna('')
    inside = pd.Series(False, index=d.index)
    for w in windows:
        inside |= (d >= w['from_date']) & (d <= w['through_date'])
    return (live & inside).to_numpy()


def weekly_repetition(frame: pd.DataFrame) -> Dict:
    """Share of readings equal to the same venue and hour seven days earlier, by ISO week of the later one."""
    f = frame[['venue_id', 'observed_date', 'hour', 'busyness_pct']].dropna()
    if not len(f):
        return {}
    f = f.assign(d=pd.to_datetime(f['observed_date'], errors='coerce')).dropna(subset=['d'])
    prior = f[['venue_id', 'd', 'hour', 'busyness_pct']].rename(columns={'busyness_pct': 'prior'})
    prior = prior.assign(d=prior['d'] + pd.Timedelta(days=7)).drop_duplicates(['venue_id', 'd', 'hour'])
    pairs = f.drop_duplicates(['venue_id', 'd', 'hour']).merge(prior, on=['venue_id', 'd', 'hour'], how='inner')
    if not len(pairs):
        return {}
    iso = pairs['d'].dt.isocalendar()
    pairs = pairs.assign(week=iso['year'].astype(str) + '-W' + iso['week'].astype(int).map('{:02d}'.format),
                         equal=(pairs['busyness_pct'] == pairs['prior']))
    out = {}
    for week, g in pairs.groupby('week'):
        # The decision reads the two whole counts (repeating_week); the
        # percentage is for people, rounded, and never compared.
        equal = int(g['equal'].sum())
        out[str(week)] = {'pairs': int(len(g)), 'equal': equal, 'equal_pct': round(100.0 * equal / len(g), 2)}
    return out


def repeating_week(stats: Dict) -> bool:
    """A week whose pairs are enough to decide and whose equal share reaches the limit, in whole counts."""
    return stats['pairs'] >= REPETITION_MIN_PAIRS and stats['equal'] * 100 >= REPETITION_LIMIT_PCT * stats['pairs']


def check_label_trust(paths: List[Path], windows: List[Dict] = None, env=os.environ,
                      chunk_rows: int = 1_000_000) -> Dict:
    """Both refusals (see the block above). Returns the record model_metadata.json carries."""
    if windows is None:
        windows, checked_sha = load_label_quarantine_snapshot()
    else:
        checked_sha = features_io.quarantine_sha256()
    admit_quarantined = _env_true(QUARANTINE_ENV, env)
    admit_repeating = _env_true(REPETITION_ENV, env)
    admit_unknown = unknown_provenance_admitted(env)
    cols = ['venue_id', 'hour', 'is_realtime', 'busyness_pct', 'observed_date', 'label_source', 'baseline_busyness']
    quarantined_by_file: Dict[str, int] = {}
    trained_parts = []
    for path in paths:
        path = Path(path)
        if not path.exists():
            continue
        n_q = 0
        for chunk in pd.read_csv(path, usecols=cols, chunksize=chunk_rows, low_memory=False,
                                 dtype={'observed_date': 'string', 'label_source': 'string'}):
            rt = chunk[pd.to_numeric(chunk['is_realtime'], errors='coerce') == 1]
            if not len(rt):
                continue
            q = quarantined_live_mask(rt['label_source'], rt['observed_date'], windows)
            n_q += int(q.sum())
            src = rt['label_source'].astype('string').fillna('').str.strip()
            live_weight = (src == 'live') & ~q if not admit_quarantined else (src == 'live')
            if admit_unknown:
                live_weight = live_weight | (src == '')
            # The repetition check reads the rows training and the gate read: the
            # serving population, a stored curve above zero. A closed venue reading
            # 0 week after week at an hour its curve says is closed repeats itself
            # honestly and never trains. The quarantine above scans every row.
            live_weight = live_weight & (pd.to_numeric(rt['baseline_busyness'], errors='coerce') > 0)
            trained_parts.append(rt.loc[np.asarray(live_weight), ['venue_id', 'observed_date', 'hour', 'busyness_pct']])
        quarantined_by_file[path.name] = n_q
    n_quarantined = sum(quarantined_by_file.values())
    record = {
        'quarantine': {'windows': windows, 'live_rows_inside': quarantined_by_file,
                       'quarantine_sha256': checked_sha,
                       'policy': 'admitted_for_analysis' if (n_quarantined and admit_quarantined) else 'refuse',
                       'env': QUARANTINE_ENV, 'file': 'backend/services/labelQuarantine.json'},
    }
    if n_quarantined and not admit_quarantined:
        raise CorpusContractError(
            f'{n_quarantined} live-labelled realtime rows ({quarantined_by_file}) are dated inside a '
            f'quarantined window ({", ".join(w["id"] for w in windows)}): the provider made them from its '
            'own forecast. export_training_data.js leaves them out, so this is an old export; re-export, '
            f'or set {QUARANTINE_ENV}=true for an analysis run that knows it is reading them.')
    if n_quarantined:
        logger.warning('POLICY OVERRIDE %s=true: %d quarantined live rows are read as live (%s). '
                       'Recorded in model_metadata.json; never ship this run.', QUARANTINE_ENV,
                       n_quarantined, quarantined_by_file)
    trained = pd.concat(trained_parts, ignore_index=True) if trained_parts else pd.DataFrame(
        columns=['venue_id', 'observed_date', 'hour', 'busyness_pct'])
    by_week = weekly_repetition(trained)
    flagged = {w: s for w, s in by_week.items() if repeating_week(s)}
    record['repetition'] = {'limit_pct': REPETITION_LIMIT_PCT, 'min_pairs': REPETITION_MIN_PAIRS,
                            'rows_checked': int(len(trained)), 'by_week': by_week,
                            'flagged_weeks': flagged,
                            'policy': 'admitted_for_analysis' if (flagged and admit_repeating) else 'refuse',
                            'env': REPETITION_ENV}
    if flagged and not admit_repeating:
        raise CorpusContractError(
            f'{len(flagged)} week(s) of live-weight readings repeat the same venue and hour seven days '
            f'earlier in {REPETITION_LIMIT_PCT:.0f}% or more of pairs ({flagged}); real readings do so in '
            'about 13% to 18%. A feed doing this is answering with its forecast. Add the window to '
            f'backend/services/labelQuarantine.json with its evidence, or set {REPETITION_ENV}=true for an '
            'analysis run that knows it is reading them.')
    if flagged:
        logger.warning('POLICY OVERRIDE %s=true: %d week(s) of repeating labels are trained on: %s',
                       REPETITION_ENV, len(flagged), flagged)
    logger.info('Label trust: %d quarantined live rows, %d live-weight rows checked for weekly repetition, '
                'highest week %s%%.', n_quarantined, len(trained),
                max((s['equal_pct'] for s in by_week.values()), default=0))
    return record

# ---------------------------------------------------------------------------
# THE TIME HOLDOUT (2026-09-25): the live readings the band gate scores.
#
# The band gate (bandEval.js --gate) scores the exported candidate the way the
# admin Overview "Model" card scores the product: served forecasts against the
# live reading of the same venue and hour, FORWARD IN TIME, in the cities the
# product serves. The city holdout cannot do that job. Miami is collected at
# two named hours of the day (collectRealtime's --holdout-utc-hours), Tokyo and
# Barcelona not at all since May, and Philadelphia and the Lehigh Valley, where
# every user is, sit in training.
#
# So every realtime row observed on or after the cutoff leaves the TRAINING
# frame here, before anything is fitted on it: the category maps, the climate
# norms and the model itself (the neighbour table reads weekly rows only, as
# ml_venue_baselines does). Weekly rows stay, because
# production has them at serve time. Earlier live rows of the same venues stay
# too, because production has those as well, which is exactly what a forecast
# made today for tomorrow faces. The held-out rows need no pickle: the band gate
# replays them from the export through the exported artifact.
#
#   FLOCK_TIME_HOLDOUT_FROM=YYYY-MM-DD  the first held-out date, explicitly
#   FLOCK_TIME_HOLDOUT_DAYS=N           the last N days of live readings
#                                       (default 14); 0 turns the split off,
#                                       which leaves the band gate nothing to
#                                       score, so the artifact cannot ship
# ---------------------------------------------------------------------------
TIME_HOLDOUT_FROM_ENV = 'FLOCK_TIME_HOLDOUT_FROM'
TIME_HOLDOUT_DAYS_ENV = 'FLOCK_TIME_HOLDOUT_DAYS'
DEFAULT_TIME_HOLDOUT_DAYS = 14


def _live_dates(df: pd.DataFrame) -> pd.Series:
    is_rt = pd.to_numeric(df['is_realtime'], errors='coerce') == 1
    live = df['label_source'].astype('string').fillna('').str.strip() == 'live'
    dates = df['observed_date'].astype('string').fillna('').str.strip()
    return dates[(is_rt & live & (dates != '')).to_numpy()]


def resolve_time_holdout(frames: List[pd.DataFrame], env=os.environ) -> Dict:
    """Decide the first held-out date. An explicit date wins over a day count."""
    all_live = pd.concat([_live_dates(f) for f in frames], ignore_index=True)
    last_live = str(all_live.max()) if len(all_live) else None
    return time_holdout_from_last_live(last_live, env)


def time_holdout_from_last_live(last_live, env=os.environ) -> Dict:
    """resolve_time_holdout, given the newest live date of every frame (None if none)."""
    explicit = str(env.get(TIME_HOLDOUT_FROM_ENV, '')).strip()
    if explicit:
        try:
            parsed = pd.Timestamp(explicit)
        except ValueError as err:
            raise CorpusContractError(f'{TIME_HOLDOUT_FROM_ENV}={explicit!r} is not a date: {err}')
        if parsed.strftime('%Y-%m-%d') != explicit:
            raise CorpusContractError(f'{TIME_HOLDOUT_FROM_ENV} must be written YYYY-MM-DD, got {explicit!r}.')
        return {'policy': 'explicit_date', 'days': None, 'from_date': explicit, 'last_live_date': last_live}
    raw = str(env.get(TIME_HOLDOUT_DAYS_ENV, '')).strip()
    try:
        days = int(raw) if raw else DEFAULT_TIME_HOLDOUT_DAYS
    except ValueError:
        raise CorpusContractError(f'{TIME_HOLDOUT_DAYS_ENV}={raw!r} is not a whole number of days.')
    if days < 0:
        raise CorpusContractError(f'{TIME_HOLDOUT_DAYS_ENV} cannot be negative (got {days}).')
    if days == 0:
        logger.warning('POLICY OVERRIDE %s=0: no time holdout. The band gate will have no '
                       'held-out live readings to score and the artifact cannot ship.', TIME_HOLDOUT_DAYS_ENV)
        return {'policy': 'off', 'days': 0, 'from_date': None, 'last_live_date': last_live}
    if last_live is None:
        return {'policy': 'no_live_rows', 'days': days, 'from_date': None, 'last_live_date': None}
    start = (pd.Timestamp(last_live) - pd.Timedelta(days=days - 1)).strftime('%Y-%m-%d')
    return {'policy': 'last_days', 'days': days, 'from_date': start, 'last_live_date': last_live}


# ---------------------------------------------------------------------------
# THE FINAL REFIT (2026-10-14).
#
# A gated run never sees its holdouts: three whole cities (Miami among them,
# one of the three markets production serves) and the newest live days. Once
# that run has PASSED, the artifact worth serving is the same recipe fitted on
# everything, holdouts included. Nothing can gate that artifact, because it has
# nothing left to be scored on, so it may only exist as the refit of a run
# that already passed:
#
#   FLOCK_FINAL_REFIT=<path to the gated run's model_metadata.json>
#
# The file must carry ship_gate.overall_pass === true and must not itself be a
# refit. The city holdout is folded into training and the time holdout is off.
# final_refit_gate.py then checks the refit used the gated recipe (features,
# parameters, policies) and carries the gated verdict across BY REFERENCE, with
# both hashes. quick_eval.py must never run on a refit: its holdout cities are
# now training rows, so any score it printed would be in-sample.
# ---------------------------------------------------------------------------
FINAL_REFIT_ENV = 'FLOCK_FINAL_REFIT'


def resolve_final_refit(env=os.environ):
    """None for an ordinary run; else the record of the gated run this refit copies."""
    raw = str(env.get(FINAL_REFIT_ENV, '')).strip()
    if not raw:
        return None
    for other in (TIME_HOLDOUT_FROM_ENV, TIME_HOLDOUT_DAYS_ENV):
        if str(env.get(other, '')).strip():
            raise CorpusContractError(f'{FINAL_REFIT_ENV} turns every holdout off; do not also set {other}.')
    path = Path(raw)
    if not path.is_file():
        raise CorpusContractError(f'{FINAL_REFIT_ENV}={raw!r}: no such file (the gated run\'s model_metadata.json).')
    blob = path.read_bytes()
    try:
        gated = json.loads(blob.decode('utf-8'))
    except ValueError as err:
        raise CorpusContractError(f'{FINAL_REFIT_ENV}: {path} is not JSON: {err}')
    gate = gated.get('ship_gate')
    if not isinstance(gate, dict) or gate.get('overall_pass') is not True:
        raise CorpusContractError(
            f'{FINAL_REFIT_ENV}: {path} did not pass its ship gate (overall_pass is not true). '
            'Only a run that passed may be refitted on everything.')
    if gated.get('final_refit'):
        raise CorpusContractError(f'{FINAL_REFIT_ENV}: {path} is itself a refit; refit the gated run.')
    # The label quarantine (2026-11-27): a verdict measured before it, or with
    # quarantined or repeating labels admitted, is not one to refit on.
    trust_problems = features_io.gated_label_trust_problems(gated)
    if trust_problems:
        raise CorpusContractError(f'{FINAL_REFIT_ENV}: {path}: ' + '; '.join(trust_problems)
                                  + '. Gate a run prepared under the current quarantine, then refit that.')
    import hashlib
    return {
        'gated_metadata_path': str(path.resolve()),
        'gated_metadata_sha256': hashlib.sha256(blob).hexdigest(),
        'gated_model_version': gated.get('model_version'),
        'gated_time_holdout': gated.get('time_holdout'),
        'gated_training_rows': gated.get('training_rows'),
    }


def split_time_holdout(df: pd.DataFrame, from_date) -> Tuple[pd.DataFrame, Dict]:
    """Remove every realtime row observed on or after `from_date` (any provenance)."""
    record = {'realtime_rows_held_out': 0, 'live_rows_held_out': 0, 'held_out_by_city': {}}
    if not from_date:
        record['training_live_through'] = str(_live_dates(df).max()) if len(_live_dates(df)) else None
        return df, record
    held, live = time_holdout_masks(df, from_date)
    kept = df[~held]
    record['realtime_rows_held_out'] = int(held.sum())
    record['live_rows_held_out'] = int(live.sum())
    record['held_out_by_city'] = {str(k): int(v) for k, v in df.loc[held, 'city'].value_counts().items()}
    kept_live = _live_dates(kept)
    record['training_live_through'] = str(kept_live.max()) if len(kept_live) else None
    return kept, record


def time_holdout_masks(df: pd.DataFrame, from_date: str) -> Tuple[np.ndarray, np.ndarray]:
    """(held, held and live): the realtime rows observed on or after `from_date`."""
    is_rt = (pd.to_numeric(df['is_realtime'], errors='coerce') == 1).to_numpy()
    dates = df['observed_date'].astype('string').fillna('').str.strip()
    held = is_rt & (dates != '').to_numpy() & (dates >= from_date).fillna(False).to_numpy()
    live = held & (df['label_source'].astype('string').fillna('').str.strip() == 'live').to_numpy()
    return held, live


# ---------------------------------------------------------------------------
# THE WEEKLY ANCHOR WEIGHT (2026-09-25).
#
# The v2.3.1 blend gives every weekly row weight 0.05, a number sized for a
# corpus with 369,076 realtime rows: live rows were 82% of the loss. The corpus
# the next retrain trains on has about 60,000 live rows beside ~1.7M servable
# weekly rows, where 0.05 leaves live rows about 41% of the loss, and the
# anchors, whose correct delta is 0 by construction, pull every deviation back
# toward the curve. That is the v2.2.1 failure the blend was written to end.
#
#   FLOCK_WEEKLY_ANCHOR_WEIGHT=0.05  (default, unchanged) a fixed weight
#   FLOCK_WEEKLY_ANCHOR_WEIGHT=auto  the weight at which realtime rows carry
#                                    WEEKLY_ANCHOR_AUTO_SHARE of the loss,
#                                    never above 0.05
#
# Any value keeps train_model.assert_weighting_matches_provenance's ordering
# (weekly < forecast 0.3 < live 1.0), and the choice is recorded in
# model_metadata.json as sample_weight_policy.
# ---------------------------------------------------------------------------
WEEKLY_ANCHOR_WEIGHT_ENV = 'FLOCK_WEEKLY_ANCHOR_WEIGHT'
DEFAULT_WEEKLY_ANCHOR_WEIGHT = 0.05
WEEKLY_ANCHOR_AUTO_SHARE = 0.80


def resolve_weekly_anchor_weight(realtime_weight_sum: float, weekly_rows: int, env=os.environ) -> Dict:
    raw = str(env.get(WEEKLY_ANCHOR_WEIGHT_ENV, '')).strip().lower()
    if raw in ('', str(DEFAULT_WEEKLY_ANCHOR_WEIGHT)):
        return {'policy': 'default', 'weight': DEFAULT_WEEKLY_ANCHOR_WEIGHT}
    if raw == 'auto':
        if weekly_rows <= 0 or realtime_weight_sum <= 0:
            return {'policy': 'auto_degenerate', 'weight': DEFAULT_WEEKLY_ANCHOR_WEIGHT}
        share = WEEKLY_ANCHOR_AUTO_SHARE
        w = realtime_weight_sum * (1 - share) / share / weekly_rows
        return {'policy': 'auto', 'target_realtime_share': share,
                'weight': float(min(DEFAULT_WEEKLY_ANCHOR_WEIGHT, w))}
    try:
        w = float(raw)
    except ValueError:
        raise CorpusContractError(f'{WEEKLY_ANCHOR_WEIGHT_ENV}={raw!r} is neither a number nor auto.')
    if not (0 <= w < 0.3):
        raise CorpusContractError(
            f'{WEEKLY_ANCHOR_WEIGHT_ENV}={w} must be in [0, 0.3): weekly anchors must weigh less '
            'than a vendor-forecast label (0.3), which weighs less than a live one.')
    logger.warning('POLICY OVERRIDE %s=%s (default %s). Recorded in model_metadata.json.',
                   WEEKLY_ANCHOR_WEIGHT_ENV, w, DEFAULT_WEEKLY_ANCHOR_WEIGHT)
    return {'policy': 'explicit', 'weight': w}


# ---------------------------------------------------------------------------
# ONE WEIGHT PER VENDOR UPDATE, NOT PER HOUR (2026-09-25).
#
# 81% of consecutive-hour live readings of a venue are identical, 82% even
# where the venue's own weekly curve moves 10+ points between the two hours.
# The sweep reads BestTime every hour and BestTime's live value refreshes more
# slowly than that, so one vendor estimate is stored two, three, up to seven
# times, and at weight 1.0 a row a sticky venue counts once per hour its value
# sat unchanged.
#
# So a live row's tier weight is divided by the length of its RUN: the maximal
# stretch of consecutive hours of one venue on one local date (observed_date,
# hour) whose live readings are identical. A run of three weighs 1/3 a row, one
# update in all. A run never crosses midnight, a gap, a forecast-labelled hour
# or a changed value. Runs are counted before the serving-population filter, so
# a run that loses a row there keeps its other rows at 1/length rather than
# being promoted.
#
# It composes by multiplication. sample_weight = tier weight / run length, the
# tier ladder is unchanged (weekly < forecast 0.3 < live 1.0), and the pickle
# carries the divisor as `run_length_divisor` so train_model.assert_weighting_
# matches_provenance checks weight x divisor, one number per tier. The weekly anchor
# weight under FLOCK_WEEKLY_ANCHOR_WEIGHT=auto is solved against the realtime
# total AFTER the division, so live rows keep their share of the loss.
# Evaluation keeps every reading at full weight: the card is judged per
# venue-hour, and only the loss changes.
#
#   FLOCK_RUN_LENGTH_WEIGHTS=on    (default) live rows weigh 1 / run length
#   FLOCK_RUN_LENGTH_WEIGHTS=off   every live row at its tier weight (ablation)
# ---------------------------------------------------------------------------
RUN_LENGTH_ENV = 'FLOCK_RUN_LENGTH_WEIGHTS'
RUN_LENGTH_POLICY = _policy(RUN_LENGTH_ENV, 'on', {'on', 'off'})


def _is_live_row(df: pd.DataFrame) -> np.ndarray:
    realtime = (pd.to_numeric(df['is_realtime'], errors='coerce') == 1).to_numpy()
    prov = df['label_provenance'].astype('string').fillna('').str.strip().to_numpy()
    return realtime & (prov == 'live')


def live_run_lengths(df: pd.DataFrame) -> np.ndarray:
    """Per row, the length of its run of identical consecutive-hour live readings.

    1 for every row that is not a live reading, and for a live reading with no
    date, hour or label to place it in a run.
    """
    run_length = np.ones(len(df), dtype=np.int32)
    live = _is_live_row(df)
    idx = np.flatnonzero(live)
    if len(idx) == 0:
        return run_length
    sub = pd.DataFrame({
        'pos': idx,
        'venue': df['venue_id'].astype(str).to_numpy()[idx],
        'date': df['observed_date'].astype('string').fillna('').str.strip().to_numpy()[idx],
        'hour': pd.to_numeric(df['hour'], errors='coerce').to_numpy(dtype=float)[idx],
        'value': pd.to_numeric(df['busyness_pct'], errors='coerce').to_numpy(dtype=float)[idx],
    })
    sub = sub[(sub['date'] != '') & np.isfinite(sub['hour']) & np.isfinite(sub['value'])]
    dup = sub.duplicated(['venue', 'date', 'hour'], keep=False)
    if dup.any():
        raise CorpusContractError(
            f'{int(dup.sum())} live readings share a (venue, observed_date, hour) with another '
            f'live reading, e.g. {sub[dup].head(3)[["venue", "date", "hour"]].to_dict("records")}. '
            'Migration 024 keys realtime rows on (venue_id, day_of_week, hour, observed_date), so '
            'the export is not the corpus; a run length over duplicated hours would mean nothing.')
    sub = sub.sort_values(['venue', 'date', 'hour'], kind='stable')
    v = sub['venue'].to_numpy()
    d = sub['date'].to_numpy()
    h = sub['hour'].to_numpy()
    x = sub['value'].to_numpy()
    continues = np.zeros(len(sub), dtype=bool)
    continues[1:] = (v[1:] == v[:-1]) & (d[1:] == d[:-1]) & (h[1:] == h[:-1] + 1) & (x[1:] == x[:-1])
    run_id = np.cumsum(~continues)
    run_length[sub['pos'].to_numpy()] = np.bincount(run_id)[run_id]
    return run_length


def run_length_divisor(df: pd.DataFrame, run_length: np.ndarray, policy: str) -> np.ndarray:
    """What each row's tier weight is divided by: its run length under 'on', else 1."""
    if policy not in ('on', 'off'):
        raise CorpusContractError(f'{RUN_LENGTH_ENV}={policy!r} is not one of on, off.')
    divisor = np.ones(len(df), dtype=np.int32)
    if policy == 'on':
        live = _is_live_row(df)
        divisor[live] = np.asarray(run_length, dtype=np.int32)[live]
    return divisor


def run_length_record(df: pd.DataFrame, run_length: np.ndarray, divisor: np.ndarray,
                      policy: str) -> Dict:
    """What the run-length weighting did to this frame's live rows, for metadata."""
    live = _is_live_row(df)
    lengths = np.asarray(run_length)[live]
    by_length = pd.Series(np.minimum(lengths, 4)).value_counts().sort_index()
    return {
        'policy': policy,
        'env': RUN_LENGTH_ENV,
        'live_rows': int(live.sum()),
        'live_rows_by_run_length': {('4+' if k == 4 else str(int(k))): int(n) for k, n in by_length.items()},
        'live_rows_in_runs_over_one_pct': round(float((lengths > 1).mean()) * 100, 1) if len(lengths) else 0.0,
        'live_weight_before': int(live.sum()),
        'live_weight_after': round(float((1.0 / np.asarray(divisor)[live]).sum()), 3),
    }


def assign_sample_weights(train_df: pd.DataFrame, run_policy: str,
                          env=os.environ) -> Tuple[Dict, np.ndarray]:
    """Write train_df['sample_weight']: the tier ladder over the run-length divisor.

    Realtime rows first: live 1.0, forecast 0.3, owner OWNER_LABEL_WEIGHT, each
    divided by its run length (live rows under FLOCK_RUN_LENGTH_WEIGHTS=on, 1
    otherwise). Weekly rows take the anchor weight after, because
    FLOCK_WEEKLY_ANCHOR_WEIGHT=auto solves it against the realtime total. Needs
    live_run_length (live_run_lengths) and label_provenance on the frame.
    Returns the sample_weight_policy record and the divisor, row-aligned.
    """
    is_forecast_label = (train_df['is_realtime'] == 1) & (train_df['label_provenance'] == 'forecast')
    is_owner_label = (train_df['is_realtime'] == 1) & (train_df['label_provenance'] == 'owner_report')
    run_divisor = run_length_divisor(train_df, train_df['live_run_length'].to_numpy(), run_policy)
    train_df['sample_weight'] = np.where(
        train_df['is_realtime'] != 1, 0.0,
        np.where(is_owner_label, OWNER_LABEL_WEIGHT,
                 np.where(is_forecast_label, 0.3, 1.0)),
    ) / run_divisor
    is_rt_row = (train_df['is_realtime'] == 1).to_numpy()
    policy = resolve_weekly_anchor_weight(
        realtime_weight_sum=float(train_df['sample_weight'].to_numpy()[is_rt_row].sum()),
        weekly_rows=int((~is_rt_row).sum()), env=env)
    train_df.loc[~is_rt_row, 'sample_weight'] = policy['weight']
    policy['live_run_length'] = run_length_record(
        train_df, train_df['live_run_length'].to_numpy(), run_divisor, run_policy)
    total_w = float(train_df['sample_weight'].sum())
    rt_w = float(train_df['sample_weight'].to_numpy()[is_rt_row].sum())
    policy['realtime_loss_share'] = round(rt_w / total_w, 4) if total_w else None
    return policy, run_divisor


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


# ---------------------------------------------------------------------------
# is_realtime IS CARRIED, NOT A FEATURE (2026-09-25).
#
# PRE-RETRAIN-AUDIT finding 18, confirmed: mlPredictor.buildFeatureMap sets
# is_realtime to 1 on every prediction, so as a feature it could only ever
# tell the model which label regime a TRAINING row came from, weekly anchor or
# live reading: a provenance flag, the class sample_weight and
# label_provenance are excluded for. v2.6.0-starling spent
# 6.1% of its split gain on it (197 splits at depth 0-1). get_feature_columns
# now excludes it, and every reader takes the flag from the key both pickles
# carry, through this function. Until now six scripts read it out of X by
# position: quick_eval (the point gate's slice), eval_two_head (through
# quick_eval), train_model (the weight tiers and the served-slice metrics
# mlPredictor publishes), train_two_head, sports_ablation and hour_ranking_eval.
# ---------------------------------------------------------------------------
def realtime_flags(data: Dict) -> np.ndarray:
    """is_realtime per row of a features pickle (0/1 ints), from its carried key.

    A pickle written before the key existed (models/incumbent/'s, 2026-08-18)
    still had the flag as a feature, and is read by position; one with neither
    is refused rather than read as all weekly.
    """
    if 'is_realtime' in data:
        return np.asarray(data['is_realtime']).astype(int)
    cols = list(data.get('feature_cols') or [])
    if 'is_realtime' in cols:
        return np.asarray(data['X'][:, cols.index('is_realtime')]).astype(int)
    raise CorpusContractError(
        'This features pickle carries no is_realtime: not as the carried key '
        'prepare_features.py writes, and not as a feature. Without it the served slice '
        '(is_realtime AND baseline > 0) cannot be told from the weekly anchors. '
        'Re-run prepare_features.py.')


# ---------------------------------------------------------------------------
# Vendor provenance (2026-08-18, poisoning preconditions).
#
# Three fits in this file compute means that later become FEATURES for other
# rows: the category/refined baseline maps, the per-fold cell aggregates that
# rebuild them, and the neighbour table (build_neighbor_table). The neighbour
# table is stricter than this predicate since 2026-09-25: it reads weekly rows
# only, which is all ml_venue_baselines is built from, so no realtime label of
# any provenance reaches it. Today every row in the corpus is vendor-collected (BestTime via
# collectWeekly/collectRealtime), so filtering those fits to vendor provenance
# changes nothing — which is exactly when to install the filter. The moment a
# non-vendor label source lands in the corpus (the venue-owner slider,
# feedback-rows-as-labels, sensor rows), those rows are client- or
# owner-influenced numbers, and without this predicate a single venue's
# self-reports would flow into the CATEGORY mean and the NEIGHBOR mean — i.e.
# one submitter could shift the features of every venue in the cell. Reading
# the maps is fine for any row; FITTING them is vendor-only.
#
# 'unknown' is in the allowlist deliberately: every 'unknown' row in the
# frozen corpus is a pre-`label_source` vendor row (the column did not exist
# before migration 025). Any NEW provenance value (e.g. 'user', 'owner',
# 'sensor') is excluded by default — do NOT add one here without a poisoning
# review of what fitting on it would let a submitter move.
# ---------------------------------------------------------------------------
VENDOR_PROVENANCES = frozenset({'weekly', 'live', 'forecast', 'unknown'})


def vendor_provenance_mask(df: pd.DataFrame) -> np.ndarray:
    """True where a row's label came from the vendor pipeline (fit-eligible).

    Tolerates a frame without the column (synthetic test fixtures) — the real
    pipeline cannot reach here without it because require_export_columns
    refuses the CSV first.
    """
    if 'label_provenance' not in df.columns:
        return np.ones(len(df), dtype=bool)
    prov = df['label_provenance'].astype('string').fillna('unknown').str.strip().str.lower()
    return prov.isin(VENDOR_PROVENANCES).to_numpy()

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
    counts, unmapped = recover_weather_code_rows(df)
    return weather_code_stats(counts, unmapped.value_counts().to_dict(),
                              float(df['weather_condition_code'].notna().mean()), label)


def recover_weather_code_rows(df: pd.DataFrame) -> Tuple[Dict, pd.Series]:
    """The row half of recover_weather_codes: fills the column in place and returns
    the counts its report is made of, with the unmapped descriptions row by row."""
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
    no_reading = int((need & (desc.isna() | (desc == ''))).sum())
    return {'rows': int(len(df)), 'code_present_in_export': had_code,
            'recovered_from_description': int(recovered_mask.sum()),
            'no_weather_reading': no_reading, 'code_notna': int(code.notna().sum())}, unmapped


def weather_code_stats(counts: Dict, unmapped_counts: Dict, coverage_mean: float, label: str) -> Dict:
    """recover_weather_codes' report from its counts; coverage_mean is the share of
    rows that carry a code afterwards."""
    stats = {
        'rows': counts['rows'],
        'code_present_in_export': counts['code_present_in_export'],
        'recovered_from_description': counts['recovered_from_description'],
        'no_weather_reading': counts['no_weather_reading'],
        'unmapped_descriptions': {str(k): int(v) for k, v in unmapped_counts.items()},
        'final_coverage_pct': round(coverage_mean * 100, 2),
    }
    logger.info(
        '[%s] weather codes: %d in export, %d recovered from description text, '
        '%d rows with no weather reading at all -> %.2f%% coverage',
        label, stats['code_present_in_export'], stats['recovered_from_description'],
        stats['no_weather_reading'], stats['final_coverage_pct'],
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
    return calendar_coverage_stats(*calendar_counts(df), label)


def calendar_counts(df: pd.DataFrame) -> Tuple[int, int, int]:
    """(rows, rows without a usable month, rows without a season)."""
    month = pd.to_numeric(df['month'], errors='coerce')
    good_month = month.between(1, 12)
    season = df['season'].astype('string').str.strip().str.lower()
    good_season = season.isin(SEASON_NAMES).fillna(False)
    return int(len(df)), int((~good_month).sum()), int((~good_season).sum())


def calendar_coverage_stats(rows: int, without_month: int, without_season: int, label: str) -> Dict:
    stats = {
        'rows': rows,
        'rows_without_month': without_month,
        'rows_without_season': without_season,
    }
    stats['pct_without_month'] = round(stats['rows_without_month'] / max(rows, 1) * 100, 2)
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


# ---------------------------------------------------------------------------
# DEAD SLOTS (round 22) — which constant feature columns are allowed to be one.
#
# A constant column can never be split on by a tree, so it is not a wrong
# number; it is a feature slot that does nothing while metadata.feature_names
# advertises it and mlPredictor.js builds, ships and parity-checks it. That
# makes it the quietest failure this pipeline has: ten weather features and five
# feedback features rode along dead for four rounds, and the DEAD SLOTS line
# below them was a logger.warning nobody had to act on.
#
# Two causes, and only a value-level look at the column distinguishes them:
#
#   (a) GENUINELY SPARSE — the computation is right and the corpus simply has no
#       instance yet. is_holiday over a 10-week window that contains no federal
#       date is a true 0, not a bug.
#   (b) SILENTLY BROKEN — the computation can never fire. cold_outdoor tested a
#       Celsius threshold against a Fahrenheit column, so it was 0 on all
#       1,934,988 rows AND on every live prediction. mlPredictor.js carried the
#       identical expression, so feature parity was green the whole time: two
#       sides agreeing about a feature that cannot fire is still a dead slot.
#       That is the case this contract exists to catch, because parity checks
#       and missing-value reports both look straight past it.
#
# So the rule is: a constant column must be NAMED here with why it is constant
# and what would make it stop being one. Anything else stops the run. The list
# is an inventory that has to be maintained, not an excuse list — the enforcer
# also reports entries that are no longer constant (so a healed feature does not
# keep a stale justification) and entries that are no longer features at all (so
# a rename does not leave an excuse behind that silently covers nothing).
#
# FLOCK_DEAD_SLOT_POLICY=warn is the hatch, logged and recorded in
# model_metadata.json like the other two. It is not acceptable for a release.
# ---------------------------------------------------------------------------
EXPECTED_SPARSE_FEATURES: Dict[str, str] = {
    # ── The corpus covers one 10-week window: 2026-03-10 .. 2026-05-18. ───────
    'is_holiday': (
        'stamped by collectRealtime.js from config.js HOLIDAYS, a US federal '
        'calendar. The collection window contains no entry — Memorial Day '
        '2026-05-25 falls seven days after the last row. Weekly rows are a '
        'synthetic typical week and correctly carry 0. FILLS IN on the first '
        'collection run that crosses a federal date.'),
    'season_spring': (
        'every row in the corpus was collected in month 3, 4 or 5, so '
        'season_spring is 1 everywhere and the other three are 0 everywhere. '
        'The one-hot is computed correctly; the corpus has one season in it. '
        'FILLS IN when collection spans a second quarter. Note the asymmetry '
        'this leaves: in July mlPredictor emits season_summer=1, a corner of '
        'feature space with zero training support — the same unreachable-corner '
        'problem as audit finding 5, pointing the other way. '
        'FLOCK_CALENDAR_POLICY=drop is the lever if a retrain must ship before '
        'the corpus spans more than one season.'),
    'season_summer': 'see season_spring — single-season corpus.',
    'season_fall': 'see season_spring — single-season corpus.',
    'season_winter': 'see season_spring — single-season corpus.',
    # ── No verified user feedback exists yet. ────────────────────────────────
    'avg_user_crowd': (
        "export_training_data.js joins venue_feedback WHERE verified = true, and "
        'no presence-verified feedback row exists yet (~0 users). FILLS IN with '
        'real usage. AUDIT FINDING 13 is closed (2026-10-14): the join used to '
        'aggregate per venue up to the day of the export, so a row saw reports '
        'from after its own hour, and avg_prediction_error is a label proxy minus '
        'a model output. Each row now reads only the verified reports of the 28 '
        'days before its own hour, as serving reads the 28 days before the moment '
        'it scores.'),
    'log_user_feedback_count': 'see avg_user_crowd — no verified feedback rows exist.',
    'has_user_feedback': 'see avg_user_crowd — no verified feedback rows exist.',
    'avg_prediction_error': 'see avg_user_crowd — no verified feedback rows exist.',
    # ── A rare level of a one-hot that is otherwise alive. ───────────────────
    'etype_family': (
        "a level of the nearest_event_type one-hot whose other four levels "
        '(music, sports, arts, other) are all non-constant, so the channel '
        'works. collectEvents.mapEventType and mlPredictor.mapTmEventType both '
        "emit 'family' for the Ticketmaster Family segment — checked, they "
        'agree — and the 206,925 event-enriched rows simply contain none. Same '
        'shape as weather_snow, which is alive on 1,605 rows. FILLS IN with a '
        'family-segment event within 2km of a corpus venue.'),
    # ── Live-only slots the live window has not reached (decided 2026-10-15, before the November export). ──
    'weather_snow': (
        'no live reading in the training window (Pennsylvania, 2026-09-01 to the time-holdout cutoff) '
        'carries a snow code (OpenWeatherMap 6xx), and weekly rows carry no weather. The one-hot works: '
        'its other levels vary. FILLS IN with the first snow reading inside a training window.'),
    'weather_thunderstorm': "see weather_snow: no 2xx code among the training window's live readings. FILLS IN with the first.",
    'weather_other': 'see weather_snow: no code outside the named groups (7xx mist, fog, haze) among them. FILLS IN with the first.',
    'special_suppress': (
        'holidays.json has no suppress-effect US special night inside the training window (its US nights '
        'there are boosts). FILLS IN on Thanksgiving Day, 2026-11-26.'),
}


def enforce_dead_slot_contract(constant_cols: List[str],
                               feature_cols: List[str]) -> Dict:
    """Every constant feature column must be an explained one. Round 22.

    Returns the record written into model_metadata.json so an artifact can never
    hide that it shipped a dead slot, or which justification covered it.
    """
    explained = [c for c in constant_cols if c in EXPECTED_SPARSE_FEATURES]
    unexplained = [c for c in constant_cols if c not in EXPECTED_SPARSE_FEATURES]
    # An entry that is no longer constant has done its job; saying so is what
    # keeps the list from becoming a permanent excuse for a feature that has
    # since started working (or has since been renamed into a different bug).
    healed = sorted(n for n in EXPECTED_SPARSE_FEATURES
                    if n in feature_cols and n not in constant_cols)
    stale = sorted(n for n in EXPECTED_SPARSE_FEATURES if n not in feature_cols)

    record = {
        'policy': DEAD_SLOT_POLICY,
        'feature_count': len(feature_cols),
        'constant': sorted(constant_cols),
        'expected_sparse': sorted(explained),
        'unexplained': sorted(unexplained),
        'no_longer_constant': healed,
        'named_but_not_a_feature': stale,
        'reasons': {c: EXPECTED_SPARSE_FEATURES[c] for c in sorted(explained)},
    }

    if healed:
        logger.info(
            'DEAD SLOTS — %d previously-sparse feature(s) now carry more than one '
            'value: %s. Remove them from EXPECTED_SPARSE_FEATURES; a justification '
            'for a feature that works is a comment that will mislead the next '
            'reader.', len(healed), healed)
    if stale:
        logger.warning(
            'DEAD SLOTS — EXPECTED_SPARSE_FEATURES names %d column(s) that are not '
            'in the feature set at all: %s. Either they were renamed (in which '
            'case the new name is currently unexplained and this contract is '
            'covering nothing) or a policy dropped them.', len(stale), stale)

    if explained:
        logger.warning(
            'DEAD SLOTS — %d of %d features are CONSTANT across the training frame '
            'and can never be split on. All %d are named in '
            'EXPECTED_SPARSE_FEATURES: %s',
            len(explained), len(feature_cols), len(explained), sorted(explained))
    if not constant_cols:
        logger.info('No constant feature columns.')
        return record

    if not unexplained:
        return record

    if DEAD_SLOT_POLICY == 'warn':
        logger.warning(
            'POLICY OVERRIDE FLOCK_DEAD_SLOT_POLICY=warn: shipping %d UNEXPLAINED '
            'dead slot(s) %s. This is recorded in model_metadata.json and is not '
            'acceptable for a release.', len(unexplained), sorted(unexplained))
        return record

    raise CorpusContractError(
        f'{len(unexplained)} feature(s) are CONSTANT across the training frame and '
        f'nothing in this file explains why: {sorted(unexplained)}.\n'
        '  A constant column is never a split, so the model has no signal from it, '
        'yet metadata.feature_names advertises it and mlPredictor.js builds, ships '
        'and parity-checks it. That is how ten weather features and five feedback '
        'features rode along dead for four rounds.\n'
        '  Work out which kind it is before doing anything else:\n'
        '    BROKEN     — the computation can never fire. Check UNITS first: '
        'cold_outdoor tested a Celsius threshold against a Fahrenheit column and '
        'mlPredictor.js carried the same expression, so feature parity was green '
        'while the slot was dead on both sides. Fix the computation in BOTH files.\n'
        '    SPARSE     — the computation is right and the corpus has no instance '
        'yet. Add the name to EXPECTED_SPARSE_FEATURES with why it is constant AND '
        'what event makes it stop being constant.\n'
        '    UNFIXABLE  — nothing available can ever make it vary. Delete it from '
        'the feature set (drop_features) rather than shipping a dead column.\n'
        '  FLOCK_DEAD_SLOT_POLICY=warn ships it anyway, loudly, and records it in '
        'model_metadata.json. It is not acceptable for a release.'
    )


# ---------------------------------------------------------------------------
# Round 20: the two CARRIED columns, and why they are carried rather than fed
# to the model.
#
# label_source is the raw column collectRealtime.js writes; label_provenance is
# the exporter's derivation of it. vendor_forecast_pct is BestTime's own
# forecast for the row's moment, which the vendor hands over in the same
# response as the live reading at no extra API call.
#
# NEITHER IS A FEATURE. Two reasons, and only the first is about today:
#
#   1. Both are empty on 100% of the corpus (457,402 realtime rows collected
#      2026-03-10..2026-05-18, every one NULL, unrecoverably so — migration
#      025's header proves the two candidate discriminators are indistinguishable
#      from chance). A feature built from either would be a CONSTANT column: a
#      dead slot, of which the last run already carried 11 of 106, advertised in
#      metadata.feature_names as if it did something. And the fill that would
#      make it non-constant is the worse half — 0 does not mean "we have no
#      forecast", it means "the vendor predicted an empty venue".
#   2. vendor_forecast_pct EQUALS busyness_pct on every 'forecast'-sourced row,
#      by construction. On the day the corpus does carry it, handing it to the
#      model would hand the model the label on that whole slice — the same
#      leakage class as popular_times and the category baselines, and one that
#      would flatter every metric while teaching nothing. Its legitimate use is
#      as a RESIDUAL against a slice the model is not scored on, and that is a
#      decision to make with data in hand, not in advance.
#
# So they are read, validated, carried into both pickles beside label_provenance
# and dropped from the feature set by get_feature_columns. What this function
# adds that mere carrying does not: the two columns CHECK each other and check
# the exporter. label_provenance is a pure function of (is_realtime,
# label_source), so recomputing it here turns a redundant column into a
# checksum; and the forecast identity above turns a 'live' label from an
# assertion into something falsifiable, which is the entire reason
# vendor_forecast_pct is stored at all.
# ---------------------------------------------------------------------------
def derive_label_provenance(is_realtime: pd.Series, source: pd.Series) -> pd.Series:
    """The exact mapping export_training_data.labelProvenance() implements."""
    named = source.where(source.isin(['live', 'forecast', 'owner_report']), 'unknown')
    return named.where(pd.to_numeric(is_realtime, errors='coerce') == 1, 'weekly')


def audit_label_columns(df: pd.DataFrame, label: str) -> Dict:
    """Validate the carried provenance columns. Reports; never fills."""
    return label_audit_stats(label_audit_counts(df), label)


def label_audit_counts(df: pd.DataFrame) -> Dict:
    """audit_label_columns' counts for one frame. They add across frames; the
    out-of-domain values are a set, which unions."""
    raw_source = df['label_source']
    # NOT stripped, and not normalised in any other way. The exporter passes the
    # database column through verbatim, so ' live' reaching this frame means
    # something wrote past migration 025's CHECK — and the domain check below
    # will name the offending value exactly as stored. Stripping it here would
    # repair the evidence and re-surface the problem as the vaguer
    # "label_provenance does not match" a few lines down.
    source = raw_source.astype('string').fillna('')
    raw_vendor = df['vendor_forecast_pct']
    vendor = pd.to_numeric(raw_vendor, errors='coerce')
    busyness = pd.to_numeric(df['busyness_pct'], errors='coerce')
    realtime = pd.to_numeric(df['is_realtime'], errors='coerce') == 1

    # A value that is present in the CSV but not a number is NOT missing data —
    # to_numeric would have laundered it into NaN and it would have read as one.
    unparsable = raw_vendor.notna() & vendor.isna()
    out_of_range = vendor.notna() & ~vendor.between(0, 100)

    bad_source = set(source[~source.isin(LABEL_SOURCE_VALUES)].unique().tolist())

    stated = df['label_provenance'].astype('string').fillna('unknown')
    expected = derive_label_provenance(df['is_realtime'], source)
    mismatch = stated != expected

    # The invariant that makes a 'live' label falsifiable: on a forecast row the
    # two numbers came out of one variable in collectRealtime.classifyReading, so
    # a disagreement means that mapping drifted and no row's label means what it
    # says any more.
    is_fc = (source == 'forecast') & vendor.notna() & busyness.notna()
    fc_disagree = is_fc & (vendor != busyness)

    # Every count below is scoped to the population the column DESCRIBES.
    # Both columns are about realtime rows only; a weekly row leaving them empty
    # is the design, not a gap, and counting it would drag the coverage figure
    # toward zero forever on a corpus that is 88% weekly. The two off-population
    # counters exist because the exporter's derived column MASKS that case
    # (a weekly row reports 'weekly' whatever label_source says) — carrying the
    # raw column is what lets it be seen at all, and seeing it is the whole
    # argument for carrying it. They are reported, not raised on: nothing in
    # training reads them and the derived column is still correct.
    named = realtime & source.isin(['live', 'forecast'])
    has_vendor = realtime & vendor.notna()
    return {
        'rows': int(len(df)),
        'realtime_rows': int(realtime.sum()),
        'label_source_named': int(named.sum()),
        'label_source_empty_on_realtime': int((realtime & (source == '')).sum()),
        'label_source_on_non_realtime_rows': int((~realtime & (source != '')).sum()),
        'vendor_forecast_present': int(has_vendor.sum()),
        'vendor_forecast_on_non_realtime_rows': int((~realtime & vendor.notna()).sum()),
        'unexpected_label_source_values': bad_source,
        'unparsable_vendor_forecast': int(unparsable.sum()),
        'vendor_forecast_out_of_range': int(out_of_range.sum()),
        'label_provenance_mismatches': int(mismatch.sum()),
        'forecast_rows_disagreeing_with_vendor': int(fc_disagree.sum()),
    }


def label_audit_stats(counts: Dict, label: str) -> Dict:
    """audit_label_columns' report from label_audit_counts."""
    n_rt = counts['realtime_rows']
    stats = {
        'rows': counts['rows'],
        'realtime_rows': n_rt,
        'label_source_named': counts['label_source_named'],
        'label_source_empty_on_realtime': counts['label_source_empty_on_realtime'],
        'label_source_on_non_realtime_rows': counts['label_source_on_non_realtime_rows'],
        'vendor_forecast_present': counts['vendor_forecast_present'],
        'vendor_forecast_on_non_realtime_rows': counts['vendor_forecast_on_non_realtime_rows'],
        'vendor_forecast_present_pct_of_realtime': (
            round(float(counts['vendor_forecast_present']) / n_rt * 100, 2) if n_rt else 0.0),
        'unexpected_label_source_values': sorted(counts['unexpected_label_source_values']),
        'unparsable_vendor_forecast': counts['unparsable_vendor_forecast'],
        'vendor_forecast_out_of_range': counts['vendor_forecast_out_of_range'],
        'label_provenance_mismatches': counts['label_provenance_mismatches'],
        'forecast_rows_disagreeing_with_vendor': counts['forecast_rows_disagreeing_with_vendor'],
    }
    logger.info(
        '[%s] label provenance: %d of %d realtime rows carry a named label_source, '
        '%d rows carry a vendor forecast (%.2f%% of realtime).',
        label, stats['label_source_named'], n_rt, stats['vendor_forecast_present'],
        stats['vendor_forecast_present_pct_of_realtime'])
    off_population = (stats['label_source_on_non_realtime_rows']
                      + stats['vendor_forecast_on_non_realtime_rows'])
    if off_population:
        logger.warning(
            '[%s] %d non-realtime row(s) carry a label_source and %d carry a '
            'vendor_forecast_pct. Neither column describes a weekly row — it is a '
            'synthetic typical week, not a moment BestTime was asked about — and the '
            "exporter reports those rows as label_provenance='weekly' regardless, so "
            'training is unaffected. Reported because only the raw column can show it.',
            label, stats['label_source_on_non_realtime_rows'],
            stats['vendor_forecast_on_non_realtime_rows'])
    if n_rt and stats['label_source_named'] == 0:
        logger.warning(
            '[%s] NO realtime row names its label_source, so every one of them is '
            'label_provenance="unknown" and trains at sample weight 1.0. That is the '
            'recorded, unrecoverable state of the pre-2026-08-15 corpus, not a bug to '
            'fix here — but it means the vendor-forecast downweight still applies to '
            'zero rows. It changes the moment collectRealtime.js runs again.', label)
    return stats


def report_event_provenance(df: pd.DataFrame, label: str) -> None:
    """Say out loud how much of the event signal was ever measured.

    events_observed is a CARRIED column (migration 045). 1 means the event
    columns beside it are a measurement, including the genuinely quiet night;
    0 means no lookup could have answered and the columns are empty; NaN means
    nothing recorded which, which is every row exported before 045.

    This does not raise. The rows it describes are not repairable and refusing
    them would refuse the corpus. What a retrain does with the number is a
    decision that belongs to whoever is holding the gate, and it cannot be made
    from a number nobody printed.
    """
    if 'events_observed' not in df.columns:
        return
    log_event_provenance(*event_provenance_counts(df), label)


def event_provenance_counts(df: pd.DataFrame) -> Tuple[int, int, int, int]:
    """(rows, observed, unavailable, unrecorded) of events_observed."""
    col = df['events_observed']
    return int(len(df)), int((col == 1).sum()), int((col == 0).sum()), int(col.isna().sum())


def log_event_provenance(n: int, observed: int, unavailable: int, unrecorded: int, label: str) -> None:
    if n == 0:
        return
    logger.info(
        '[%s] event provenance: %d of %d rows record a measured event state, '
        '%d record that no lookup could answer, %d record nothing either way.',
        label, observed, n, unavailable, unrecorded)
    if unrecorded == n:
        logger.warning(
            '[%s] NO row carries event provenance. Every has_nearby_event=0 in this '
            'frame may be an observation or may be the column default migration 006 set, '
            'and the two are not separable: 22 of 34 cities in the corpus hold zero '
            'event-positive rows, 56.1%% of it, which is a statement about '
            'Ticketmaster collection coverage that the model reads as a statement '
            'about those cities. Not fixable here and not fixable by a backfill. '
            'See scripts/ml/MODEL-METRICS.md before trusting the importance of any '
            'event feature in this run.', label)


def enforce_label_contract(stats: Dict, label: str) -> None:
    """Round 20: a carried column that is wrong must stop the run, not ride along.

    Every condition below means the CSV disagrees with itself or with migration
    025's CHECK constraint. None of them can be repaired by guessing, and all of
    them are silent if ignored — an out-of-domain label_source simply reappears
    as 'unknown' and rejoins the weight-1.0 pool, which is the exact defect round
    19 was written about.
    """
    if stats['unexpected_label_source_values']:
        raise CorpusContractError(
            f'[{label}] label_source carries value(s) outside the domain '
            f'{sorted(LABEL_SOURCE_VALUES)}: '
            f'{stats["unexpected_label_source_values"]}.\n'
            "  Migration 025's CHECK forbids these, so a row carrying one proves the "
            'constraint is not on the database this corpus came from. The exporter '
            "maps anything it does not recognise to label_provenance='unknown', which "
            'is weighted 1.0 — a typo would silently promote a vendor forecast to '
            'ground truth. Fix the writer, or apply 025_ml_label_provenance.sql.'
        )
    if stats['unparsable_vendor_forecast']:
        raise CorpusContractError(
            f'[{label}] {stats["unparsable_vendor_forecast"]} row(s) carry a '
            'vendor_forecast_pct that is present but not a number.\n'
            '  Coercing it would turn a corrupt value into a missing one, which reads '
            'as "the collector never had the forecast" — a different and much more '
            'ordinary fact. The exporter writes an EMPTY field for absent, so anything '
            'non-numeric here came from a writer that is not collectRealtime.js.'
        )
    if stats['vendor_forecast_out_of_range']:
        raise CorpusContractError(
            f'[{label}] {stats["vendor_forecast_out_of_range"]} row(s) carry a '
            'vendor_forecast_pct outside 0-100, which migration 025 CHECKs against '
            'and collectRealtime.js clamps to.'
        )
    if stats['label_provenance_mismatches']:
        raise CorpusContractError(
            f'[{label}] {stats["label_provenance_mismatches"]} row(s) have a '
            'label_provenance that is not what (is_realtime, label_source) implies.\n'
            '  label_provenance is DERIVED from those two by '
            'export_training_data.labelProvenance(); carrying the raw column beside it '
            'exists so that derivation is checkable from the CSV alone. A mismatch '
            'means the exporter and this script disagree about what a row is, and the '
            'sample weights are assigned from the derived column.'
        )
    if stats['forecast_rows_disagreeing_with_vendor']:
        raise CorpusContractError(
            f'[{label}] {stats["forecast_rows_disagreeing_with_vendor"]} row(s) are '
            "label_source='forecast' yet their vendor_forecast_pct differs from their "
            'busyness_pct.\n'
            '  On a forecast row those two numbers come from ONE value in '
            'collectRealtime.classifyReading, so they cannot differ unless that mapping '
            'has drifted. This is the invariant that makes a "live" label falsifiable '
            'rather than an unbacked assertion — if it fails, no label in the corpus '
            'means what it says and the run must not continue.'
        )


# A 0/1 column made from a comparison is held a byte a row from the start
# (2026-11-21). A frame carries every one of them at once until finish_frame,
# and at eight bytes a row those sixty-odd columns were a quarter of the
# script's peak: on the 2026-10-08 export it fell from 5.1 GB to 3.75 GB, both
# pickles and model_metadata.json identical. The values are the same 0s and 1s;
# X reads them as float32 and every step in between only sums, multiplies or
# compares them. A column whose values come from the export (is_raining,
# has_nearby_event), or is a count or a code, keeps its type here, since a cast
# to a narrow type wraps a value it cannot hold; finish_frame narrows those once
# their range is known. test_finish_frame.py builds these columns both ways.
FLAG_DTYPE = np.int8


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
    df['is_weekend'] = df['day_of_week'].isin([0, 6]).astype(FLAG_DTYPE)  # Sun=0, Sat=6
    df['is_friday_saturday_night'] = (
        (df['day_of_week'].isin([5, 6])) & (df['hour'] >= 18)
    ).astype(FLAG_DTYPE)
    df['is_lunch_hour'] = df['hour'].between(11, 13).astype(FLAG_DTYPE)
    df['is_dinner_hour'] = df['hour'].between(17, 21).astype(FLAG_DTYPE)
    df['is_late_night'] = (df['hour'].between(22, 23) | df['hour'].between(0, 3)).astype(FLAG_DTYPE)
    df['is_morning'] = df['hour'].between(6, 10).astype(FLAG_DTYPE)

    # Season one-hot
    season = df['season'].astype('string').str.strip().str.lower()
    for s in SEASON_NAMES:
        # fillna(False): an absent season is "not this season" for every level,
        # which is only ever reached under FLOCK_CALENDAR_POLICY=drop — where
        # these columns are removed from the feature set anyway.
        df[f'season_{s}'] = (season == s).fillna(False).astype(FLAG_DTYPE)

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
    # No fill: require_coordinates has already refused a row without a finite
    # latitude, so the equator is not quietly substituted for one here.
    lat = pd.to_numeric(df['latitude'], errors='coerce').clip(-65, 65)
    x = (-np.tan(np.radians(lat)) * np.tan(np.radians(decl))).clip(-1, 1)
    daylight = 2 * np.degrees(np.arccos(x)) / 15.0
    df['daylight_hours'] = daylight
    sunset_hour = 12 + daylight / 2.0
    hh = np.where(df['hour'] < 5, df['hour'] + 24, df['hour'])  # 1 AM belongs to the evening
    df['hours_after_sunset'] = (hh - sunset_hour).clip(-8, 12)
    df['is_after_sunset'] = (df['hours_after_sunset'] > 0).astype(FLAG_DTYPE)
    return df


# ---------------------------------------------------------------------------
# WEATHER ON A ROW THAT HAS NONE (round 26, 2026-09-04).
#
# Weekly rows carry no weather, and never truthfully did: collectWeekly stamped
# each venue's 168 typical-week rows with the one reading taken at the moment of
# collection, a single number for a whole week, and repairWeeklyWeather.js
# cleared it because a Tuesday-3AM row wearing Thursday-noon's temperature is a
# batch signature, not a measurement. So the six weather columns are NULL on
# every weekly row, on the 99 realtime rows whose reading failed, and on nothing
# else.
#
# WHAT THIS FILE USED TO DO WITH THE GAP, and why it was wrong twice over.
# add_weather_features filled a missing temperature with the (city, month)
# MEDIAN of the frame, then the global median, then a literal 20.0, and
# add_climate_anomaly fitted the (latitude band, month) norms from the FILLED
# column. Measured on the 2026-08-30 export with the weekly weather blanked the
# way the corpus now is:
#
#   * every weekly venue-batch came out with exactly ONE temperature on all 168
#     of its rows, the city-month median (18,621 of 18,621 venues): a
#     per-(city, month) constant wearing the units of a reading;
#   * 88% of the rows feeding each norm were those medians, so the norms moved
#     by a mean of 1.04F and up to 3.56F (band 20, May) from what the observed
#     readings alone say;
#   * the weekly rows' temp_anomaly became median-minus-contaminated-norm, a
#     nonzero per-(city, month) constant (76 distinct values across the weekly
#     rows), while services/mlPredictor.js hands an imputed temperature to the
#     model with an anomaly of exactly 0.
#
# Serving's rule is the one to match, because serving is where the model is
# scored. tempForFeature() imputes a missing reading with climateNorm(): the
# metadata.temp_norms entry for this (5-degree latitude band, month), else the
# mean of that whole table. temp_anomaly then cancels to 0. So:
#
#   1. the norms are fitted from rows that CARRY a reading and from nothing
#      else (fit_temperature_norms), and the row counts behind each cell are
#      published beside the values;
#   2. a missing temperature is filled with the norm for its (band, month), or
#      the table mean when that cell has no observed row, which is the same
#      two-step lookup mlPredictor.climateNorm performs, keyed by the same
#      string;
#   3. humidity, wind_speed and is_raining are filled with 50, 0 and 0, the
#      values buildFeatureMap emits for a missing reading (`?? 50`, `?? 0`,
#      `? 1 : 0`). They are not measurements and nothing here says they are:
#      the honest marker is weather_unknown = 1, which a row with no condition
#      code carries and which serving emits on an outage. There is no
#      in-distribution "unknown" for a continuous slot, and a sentinel the
#      model has never seen is the `?? 20` mistake over again.
#
# A weekly row's weather slots are therefore, value for value, the vector
# serving builds when OpenWeatherMap is down, so the outage behaviour is
# trained rather than improvised and the anchor rows carry no fabricated
# climate. weather_observed rides both pickles as a CARRIED column so a retrain
# can weight or slice on the difference. __tests__/mlTrainingContracts.test.js
# pins the three fill constants against mlPredictor.js and runs the fill on a
# fixture when a Python with pandas is available.
# ---------------------------------------------------------------------------
WEATHER_NO_READING_FILLS: Dict[str, float] = {'humidity': 50, 'wind_speed': 0, 'is_raining': 0}
LAT_BAND_DEGREES = 5.0


def require_coordinates(df: pd.DataFrame, csv_path: Path, label: str) -> None:
    """Every row needs a finite latitude and longitude, or the run stops.

    Three feature families derive from the coordinates: the astronomy shape,
    the climate norm lookup and the neighbour box. The old `fillna(0)` in two
    of them put a coordinate-less row on the equator at the prime meridian and
    trained it there, silently. No row in the corpus lacks coordinates, which
    is exactly why a hard contract costs nothing now and catches the first one.
    """
    refuse_missing_coordinates(coordinate_failures(df), csv_path, label)


def coordinate_failures(df: pd.DataFrame) -> int:
    """How many rows lack a finite latitude or longitude (require_coordinates' test)."""
    lat = pd.to_numeric(df['latitude'], errors='coerce')
    lng = pd.to_numeric(df['longitude'], errors='coerce')
    bad = ~(np.isfinite(lat.to_numpy(dtype=float)) & np.isfinite(lng.to_numpy(dtype=float)))
    return int(bad.sum())


def refuse_missing_coordinates(bad: int, csv_path: Path, label: str) -> None:
    if bad:
        raise CorpusContractError(
            f'{label} ({csv_path}) has {bad} row(s) without a finite latitude/'
            'longitude. Astronomy, the climate norm and the neighbour box are all derived '
            'from the coordinates, and filling them with 0 would train those rows at 0N 0E. '
            'Fix the venue in ml_venues; do not fill.'
        )


def latitude_band(lat: pd.Series) -> pd.Series:
    """The 5-degree band mlPredictor.monthClimateNorm keys temp_norms on."""
    return (pd.to_numeric(lat, errors='coerce') / LAT_BAND_DEGREES).round() * LAT_BAND_DEGREES


def temp_norm_keys(band: pd.Series, month: pd.Series) -> pd.Series:
    """`${band}_${month}`, the metadata.temp_norms key mlPredictor.js builds.

    A month that is NaN (only reachable under FLOCK_CALENDAR_POLICY=drop) keys
    to a cell no table has, so it takes the table mean, which is what serving
    does for a month the artifact has never seen.
    """
    b = band.round().fillna(0).astype(int).astype(str)
    m = pd.to_numeric(month, errors='coerce')
    m = m.where(m.notna(), -1).astype(int).astype(str)
    return b + '_' + m


def fit_temperature_norms(df: pd.DataFrame, rows_without: int = None) -> pd.DataFrame:
    """(lat_band, month) mean temperature, over rows that CARRY a reading.

    Nothing imputed feeds this. When add_weather_features has already run on
    the frame it left `weather_observed` behind and that marker is used; before
    it, a reading is a non-null temperature. Either way the population is the
    same rows. rows_without, for the log line only: how many rows of the frame
    the norms serve carry no reading, when `df` holds just the ones that do.
    """
    if 'weather_observed' in df.columns:
        observed = df['weather_observed'].to_numpy() == 1
    else:
        observed = df['temperature'].notna().to_numpy()
    d = pd.DataFrame({
        'lat_band': latitude_band(df['latitude']).to_numpy()[observed],
        'month': pd.to_numeric(df['month'], errors='coerce').to_numpy()[observed],
        'temperature': pd.to_numeric(df['temperature'], errors='coerce').to_numpy()[observed],
    })
    d = d.dropna(subset=['lat_band', 'month', 'temperature'])
    if d.empty:
        raise CorpusContractError(
            'No row carries a temperature reading, so there is nothing to fit a climate '
            'norm from and nothing honest to fill a missing temperature with. The corpus '
            'has weather on every realtime row collectRealtime.js wrote; a frame with none '
            'is not the corpus.'
        )
    norms = (d.groupby(['lat_band', 'month'])['temperature']
              .agg(temp_norm='mean', n_obs='size').reset_index())
    # Rounded to the two decimals metadata.temp_norms ships with (main() writes
    # round(temp_norm, 2)), BEFORE any row is filled or differenced with them.
    # Training used the unrounded mean and serving the rounded one, so every
    # imputed temperature and every temp_anomaly differed by up to 0.005F
    # between the two (found by __tests__/mlContextFeatureParity.test.js).
    norms['temp_norm'] = [round(float(v), 2) for v in norms['temp_norm']]
    logger.info('Climate norms: %d (lat_band, month) cells fitted from %d rows that carry a '
                'temperature reading (%d rows carry none and will take the norm).',
                len(norms), int(observed.sum()),
                int((~observed).sum()) if rows_without is None else rows_without)
    return norms


def temperature_norm_lookup(df: pd.DataFrame, norms: pd.DataFrame) -> pd.Series:
    """The norm serving would look up for each row: its cell, else the table mean.

    Index-preserving on purpose (a map, not a merge): this runs before the
    baseline smoothing and the neighbour features, both of which key on the frame's
    own columns, and a merge that reset the index here would be an invitation
    to a positional mistake later.
    """
    table, global_mean = temperature_norm_table(norms)
    keys = temp_norm_keys(latitude_band(df['latitude']), df['month'])
    return keys.map(table).astype(float).fillna(global_mean)


def temperature_norm_table(norms: pd.DataFrame) -> Tuple[Dict[str, float], float]:
    """(each temp_norm_keys key's norm, the table mean every other key takes)."""
    table = {
        f'{int(b)}_{int(m)}': float(v)
        for b, m, v in zip(norms['lat_band'], norms['month'], norms['temp_norm'])
        if np.isfinite(v)
    }
    return table, float(norms['temp_norm'].mean())


def add_climate_anomaly(df: pd.DataFrame, norms: pd.DataFrame = None) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """Temperature vs latitude-band x month climatology (v2.4).

    Literature: anomaly vs seasonal norm predicts demand better than absolute
    temperature. The norms are fitted by fit_temperature_norms from rows that
    carry a reading (train split only; the holdout is handed the train table)
    on 5-degree latitude bands so inference needs only lat + month, and they
    ship in model metadata for Node.

    add_weather_features attached `temp_norm` and filled the missing
    temperatures from it, so on an imputed row the anomaly below is exactly 0,
    which is what mlPredictor.buildFeatureMap produces for the same row. The
    `norms` argument is returned so callers that fit on the frame (the
    within-city eval) still get the table back.
    """
    if 'temp_norm' not in df.columns:
        raise CorpusContractError(
            'add_climate_anomaly needs temp_norm on the frame; call add_weather_features '
            'first. It is the step that fits the norms from observed readings and fills '
            'the missing temperatures from them.')
    if norms is None:
        norms = fit_temperature_norms(df)
    df['temp_anomaly'] = (df['temperature'] - df['temp_norm']).clip(-25, 25)
    df['is_warm_anomaly_evening'] = ((df['temp_anomaly'] > 5) & (df['hour'] >= 17)).astype(FLAG_DTYPE)
    return df, norms


# ---------------------------------------------------------------------------
# NEIGHBOUR ACTIVITY IS SERVING'S ARITHMETIC (2026-09-25).
#
# log_neighbor_count and neighbor_baseline_same_hour are what
# mlPredictor.getNeighborActivity returns, and serving is the reference. Its
# arithmetic, restated over the export:
#
#   the box   the venue's coordinates rounded by JS toFixed(3), then plus and
#             minus NEIGHBOR_BOX_DEG in float64, both ends included: the range
#             scan's BETWEEN on DOUBLE PRECISION columns
#   members   every venue in the box with an ml_venue_baselines row for the
#             slot. buildBaselines writes one exactly when a weekly row exists,
#             so a row holding 0 counts, a slot with no weekly row does not,
#             and two venues at one address are two venues
#   values    that raw weekly baseline (a SMALLINT), never the smoothed number
#             the delta label is taken against
#   self      taken back out, count and value, when the venue itself has a row
#             for the slot
#   result    count = members - self; mean = (sum - own) / count, clamped to
#             0..100; (0, 0) when the count is 0 or the coordinates are unusable
#
# The version this replaces bucketed SMOOTHED baselines on a 0.005-degree grid
# (a 3x3 window whose edges fall anywhere relative to the venue), keyed venues
# on coordinates rounded to five places, and counted realtime rows at slots no
# weekly row holds. On the 8,006 live September readings bandEval.js replays,
# its count disagreed with serving's on 58.6% of rows (by 1.58 venues on
# average) and its mean by 3.3 points on average (p90 7.0); this version
# disagrees on none. __tests__/mlNeighborParity.test.js runs it and the real
# getNeighborActivity over one random grid and requires equality on every row.
#
# THE TABLE IS BUILT FROM THE RAW FRAMES, before any row is dropped. Serving's
# range scan sees every venue that has a weekly row: the always-zero venues
# main() drops from training, and the other frame's cities, are still somebody's
# neighbours. Only weekly rows build it, as only weekly rows build
# ml_venue_baselines, so no realtime, owner or feedback label can move another
# venue's feature (the poisoning rule vendor_provenance_mask states).
# ---------------------------------------------------------------------------
NEIGHBOR_BOX_DEG = 0.0075  # mlPredictor.NEIGHBOR_BOX_DEG (neighborCacheBucketing.test.js pins it there)
_MILLI = Decimal('0.001')


def js_to_fixed_3(x: float) -> float:
    """Number((+x).toFixed(3)), exactly.

    toFixed rounds the EXACT binary value of x to three decimals and sends a
    tie to the larger magnitude. Python's round() sends a tie to even and
    numpy's rounds a scaled copy, and on a coordinate like -75.0625 either
    would centre the box a metre from where serving centres it. Decimal(x) is
    the exact binary value.
    """
    return float(Decimal(float(x)).quantize(_MILLI, rounding=ROUND_HALF_UP))


def js_round(values) -> np.ndarray:
    """Math.round: the nearest integer, a tie going toward +infinity."""
    v = np.asarray(values, dtype=float)
    f = np.floor(v)
    return f + ((v - f) >= 0.5)


def _has_coordinates(lat: float, lng: float) -> bool:
    """mlPredictor.hasCoordinates."""
    return bool(np.isfinite(lat) and np.isfinite(lng)
                and -90 <= lat <= 90 and -180 <= lng <= 180)


def build_neighbor_table(frames: List[pd.DataFrame]) -> Dict:
    """ml_venues joined to ml_venue_baselines, as serving's range scan reads them.

    Venues and their coordinates come from the first row of each venue_id in
    frame order (the export writes ml_venues' coordinates on every row of a
    venue); a venue's curve is its weekly rows' baseline_busyness, which the
    exporter takes from the same aggregate buildBaselines writes. This is the
    table bandEval.js readCorpus builds from the same files.
    """
    raw = pd.concat([f[NEIGHBOR_TABLE_COLS] for f in frames], ignore_index=True)
    builder = NeighborTableBuilder()
    builder.add(raw)
    return builder.finish()


NEIGHBOR_TABLE_COLS = ['venue_id', 'latitude', 'longitude', 'day_of_week', 'hour',
                       'baseline_busyness', 'is_realtime']


class NeighborTableBuilder:
    """build_neighbor_table fed one slice of rows at a time, in frame order.

    The first row of a venue places it and a later weekly row for a slot replaces
    an earlier one, across slices as within one, so slices fed in frame order
    build the table one concatenated frame builds.
    """

    def __init__(self):
        self.index: Dict[str, int] = {}
        self.lat: List[np.ndarray] = []
        self.lng: List[np.ndarray] = []
        self.curve = np.full((0, 168), -1, dtype=np.int16)
        self.has_curve = np.zeros(0, dtype=bool)

    def add(self, raw: pd.DataFrame) -> None:
        vid = raw['venue_id'].astype(str).to_numpy()
        first = np.flatnonzero(~pd.Series(vid).duplicated(keep='first').to_numpy())
        new = first[np.fromiter((v not in self.index for v in vid[first]), dtype=bool, count=len(first))]
        for v in vid[new]:
            self.index[v] = len(self.index)
        self.lat.append(pd.to_numeric(raw['latitude'], errors='coerce').to_numpy(dtype=float)[new])
        self.lng.append(pd.to_numeric(raw['longitude'], errors='coerce').to_numpy(dtype=float)[new])
        if len(self.index) > len(self.curve):
            grown = np.full((max(len(self.index), 2 * len(self.curve)), 168), -1, dtype=np.int16)
            grown[:len(self.curve)] = self.curve
            self.curve = grown
            self.has_curve = np.concatenate([self.has_curve, np.zeros(len(grown) - len(self.has_curve), dtype=bool)])

        dow = pd.to_numeric(raw['day_of_week'], errors='coerce').to_numpy(dtype=float)
        hour = pd.to_numeric(raw['hour'], errors='coerce').to_numpy(dtype=float)
        base = pd.to_numeric(raw['baseline_busyness'], errors='coerce').to_numpy(dtype=float)
        weekly = pd.to_numeric(raw['is_realtime'], errors='coerce').fillna(0).to_numpy() != 1
        on_grid = ((dow >= 0) & (dow <= 6) & (hour >= 0) & (hour <= 23)
                   & (np.floor(dow) == dow) & (np.floor(hour) == hour))
        use = weekly & np.isfinite(base) & on_grid

        rows = np.fromiter((self.index[v] for v in vid[use]), dtype=np.int64, count=int(use.sum()))
        slots = (dow[use] * 24 + hour[use]).astype(np.int64)
        # Row order, so a later row for the same slot wins, as it does in the replay.
        self.curve[rows, slots] = js_round(base[use]).astype(np.int16)
        self.has_curve[rows] = True

    def finish(self) -> Dict:
        n = len(self.index)
        lat = np.concatenate(self.lat) if self.lat else np.zeros(0)
        lng = np.concatenate(self.lng) if self.lng else np.zeros(0)
        curve = self.curve[:n]
        has_curve = self.has_curve[:n]
        member = has_curve & np.isfinite(lat) & np.isfinite(lng)
        member_idx = np.flatnonzero(member)
        order = member_idx[np.argsort(lat[member_idx], kind='stable')]
        return {
            'index': self.index,
            'lat': lat,
            'lng': lng,
            'curve': curve,
            'has_curve': has_curve,
            'members_by_lat': order,
            'members_lat_sorted': lat[order],
            'box_deg': NEIGHBOR_BOX_DEG,
            'venues': int(n),
            'venues_with_curve': int(has_curve.sum()),
        }


def _box_totals(table: Dict, b_lat: float, b_lng: float) -> Tuple[np.ndarray, np.ndarray]:
    """COUNT(*) and SUM(baseline) per slot over the box centred on (b_lat, b_lng)."""
    d = table['box_deg']
    lat_lo, lat_hi = b_lat - d, b_lat + d
    lng_lo, lng_hi = b_lng - d, b_lng + d
    sorted_lat = table['members_lat_sorted']
    lo = np.searchsorted(sorted_lat, lat_lo, side='left')
    hi = np.searchsorted(sorted_lat, lat_hi, side='right')
    cand = table['members_by_lat'][lo:hi]
    lng = table['lng'][cand]
    inside = cand[(lng >= lng_lo) & (lng <= lng_hi)]
    curves = table['curve'][inside]
    present = curves >= 0
    return present.sum(axis=0), np.where(present, curves, 0).sum(axis=0).astype(float)


def neighbor_activity(table: Dict, df: pd.DataFrame) -> Tuple[np.ndarray, np.ndarray]:
    """(count, mean) for every row: getNeighborActivity at the row's venue and slot."""
    n = len(df)
    vid = df['venue_id'].astype(str).to_numpy()
    lat = pd.to_numeric(df['latitude'], errors='coerce').to_numpy(dtype=float)
    lng = pd.to_numeric(df['longitude'], errors='coerce').to_numpy(dtype=float)
    dow = pd.to_numeric(df['day_of_week'], errors='coerce').to_numpy(dtype=float)
    hour = pd.to_numeric(df['hour'], errors='coerce').to_numpy(dtype=float)

    # One box per distinct (venue, coordinates) the frame asks about.
    keys = pd.DataFrame({'v': vid, 'lat': lat, 'lng': lng})
    combo = keys.groupby(['v', 'lat', 'lng'], sort=False, dropna=False).ngroup().to_numpy()
    first = ~pd.Series(combo).duplicated(keep='first').to_numpy()
    n_combo = int(combo.max()) + 1 if n else 0
    c_venue = np.empty(n_combo, dtype=object)
    c_lat = np.empty(n_combo)
    c_lng = np.empty(n_combo)
    c_venue[combo[first]] = vid[first]
    c_lat[combo[first]] = lat[first]
    c_lng[combo[first]] = lng[first]

    d = table['box_deg']
    cnt = np.zeros((n_combo, 168), dtype=np.int64)
    tot = np.zeros((n_combo, 168), dtype=float)
    own = np.full((n_combo, 168), -1, dtype=np.int16)
    boxes: Dict[Tuple[float, float], Tuple[np.ndarray, np.ndarray]] = {}
    for c in range(n_combo):
        if not _has_coordinates(c_lat[c], c_lng[c]):
            continue  # serving answers {count: 0, mean: 0}
        b_lat, b_lng = js_to_fixed_3(c_lat[c]), js_to_fixed_3(c_lng[c])
        if (b_lat, b_lng) not in boxes:
            boxes[(b_lat, b_lng)] = _box_totals(table, b_lat, b_lng)
        cnt[c], tot[c] = boxes[(b_lat, b_lng)]
        # getSelfBaselines: the venue's own row for the slot, subtracted only
        # when its stored coordinates fall inside the box the totals covered.
        i = table['index'].get(c_venue[c])
        if (i is not None and table['has_curve'][i]
                and abs(table['lat'][i] - b_lat) <= d and abs(table['lng'][i] - b_lng) <= d):
            own[c] = table['curve'][i]

    on_grid = ((dow >= 0) & (dow <= 6) & (hour >= 0) & (hour <= 23)
               & (np.floor(dow) == dow) & (np.floor(hour) == hour))
    slot = np.where(on_grid, np.nan_to_num(dow) * 24 + np.nan_to_num(hour), 0).astype(np.int64)
    r_cnt = np.where(on_grid, cnt[combo, slot], 0)
    r_tot = tot[combo, slot]
    r_own = own[combo, slot].astype(float)
    has_own = r_own >= 0
    count = np.where(r_cnt > 0, r_cnt - has_own, 0)
    safe = np.where(count > 0, count, 1)
    mean = np.where(count > 0,
                    np.clip((r_tot - np.where(has_own, r_own, 0.0)) / safe, 0.0, 100.0), 0.0)
    return count.astype(float), mean


def add_neighbor_features(df: pd.DataFrame, table: Dict = None) -> pd.DataFrame:
    """Neighbour-venue same-hour baseline activity (v2.4, agglomeration signal).

    How much typical same-hour activity surrounds a venue within ~830 m, itself
    excluded, computed the way serving computes it (the block above). `table`
    is build_neighbor_table over the raw export; None builds it from `df`
    alone, which is only right when `df` has lost no rows.
    """
    if table is None:
        table = build_neighbor_table([df])
    count, mean = neighbor_activity(table, df)
    df['neighbor_count'] = count
    df['log_neighbor_count'] = np.log1p(count)
    df['neighbor_baseline_same_hour'] = mean
    # A fresh RangeIndex, as the merge this used to end with returned: the
    # feature steps after this one assign by index.
    return df.reset_index(drop=True)


# ---------------------------------------------------------------------------
# THE LIVE FEATURES (2026-09-26): the venue's own recent readings as inputs.
#
# Production serves curve + 0.85 x the strictly-past trailing offset, plus the
# newest earlier-hour live reading blended in by its lag (the two serving
# switches, services/mlPredictor.js). Those are fixed weights applied after
# any model. These five columns hand the same two quantities to the model, so
# a retrain learns how far to trust them per hour, category and lag instead of
# trailing a two-line heuristic. Each is mlPredictor.liveFeatureValues, and
# __tests__/mlLiveFeatureParity.test.js requires equality on a random grid:
#
#   last_live_dev    newest live reading of the venue from a slot STRICTLY
#                    before the row's, within NOWCAST_MAX_LAG_HOURS, minus the
#                    row's own served (smoothed) baseline; 0 when none
#   last_live_age_h  its lag in hours; LIVE_MISSING_AGE_H when none
#   recent_offset    median of (reading - curve at the reading's own slot) over
#                    the newest OFFSET_MAX_READINGS readings strictly before the
#                    slot and inside OFFSET_WINDOW_HOURS, at least
#                    DEVIATION_MIN_READINGS of them, clamped to
#                    +/-DEVIATION_CLAMP (trailingOffsetBefore); 0 when none
#   recent_offset_n  how many readings that median took; 0 when none
#   curve_prev_hour  the served curve one clock hour earlier
#                    (blendBaselineRows at the previous slot); 0 with no row
#
# NO LEAK, BY CONSTRUCTION AND BY TEST. Every reading a row sees has a slot
# strictly before the row's own; the row's label, and anything at or after its
# hour, cannot reach it (test_live_features.py perturbs exactly those and
# requires nothing to move). The readings are the population
# buildRecentDeviation.js stores: label_source 'live', a busyness, a dated
# venue-local slot, and a positive curve at the reading's own slot. They are
# read from BOTH raw frames before any row is dropped, because serving has
# every earlier reading, the time-held-out ones included once their hour has
# passed; strictly-before keeps a training row from seeing any of them.
#
# Weekly anchor rows carry no date, so they take the missing values: the same
# "no recent reading" a venue without live coverage is served.
# ---------------------------------------------------------------------------
LIVE_FEATURE_NAMES: List[str] = ['last_live_dev', 'last_live_age_h', 'recent_offset',
                                 'recent_offset_n', 'curve_prev_hour']
LIVE_MISSING_AGE_H = 99         # mlPredictor.LIVE_MISSING_AGE_H
NOWCAST_MAX_LAG_HOURS = 12      # mlPredictor.NOWCAST_MAX_LAG_HOURS
OFFSET_WINDOW_HOURS = 28 * 24   # mlPredictor.OFFSET_WINDOW_HOURS
OFFSET_MAX_READINGS = 20        # mlPredictor.OFFSET_MAX_READINGS
DEVIATION_MIN_READINGS = 2      # mlPredictor.DEVIATION_MIN_READINGS
DEVIATION_CLAMP = 50            # mlPredictor.DEVIATION_CLAMP
_EPOCH_ORDINAL = 719163         # date(1970, 1, 1).toordinal()


def slot_day_number(value) -> float:
    """mlPredictor.slotDayNumber: days since the epoch of a strict YYYY-MM-DD, else NaN."""
    from datetime import date as _date
    if not isinstance(value, str) or len(value) != 10 or value[4] != '-' or value[7] != '-':
        return np.nan
    y, m, d = value[:4], value[5:7], value[8:]
    if not (y.isdigit() and m.isdigit() and d.isdigit() and y.isascii() and m.isascii() and d.isascii()):
        return np.nan
    try:
        return float(_date(int(y), int(m), int(d)).toordinal() - _EPOCH_ORDINAL)
    except ValueError:
        return np.nan


def _row_slots(df: pd.DataFrame) -> np.ndarray:
    """The venue-local slot (days since the epoch x 24 + hour) of each row, NaN when undated."""
    day = df['observed_date'].map(slot_day_number).to_numpy(dtype=float) \
        if 'observed_date' in df.columns else np.full(len(df), np.nan)
    hour = pd.to_numeric(df['hour'], errors='coerce').to_numpy(dtype=float)
    ok = np.isfinite(day) & (hour >= 0) & (hour <= 23) & (np.floor(hour) == hour)
    return np.where(ok, day * 24 + np.nan_to_num(hour), np.nan)


def served_curve_at(table: Dict, venue_ids: np.ndarray, dow: np.ndarray, hour: np.ndarray) -> np.ndarray:
    """mlPredictor.getBaseline over the neighbour table's raw curves: blendBaselineRows
    at each (venue, dow, hour), 0 where the slot has no row or the venue no curve."""
    n = len(venue_ids)
    out = np.zeros(n, dtype=float)
    rows = np.fromiter((table['index'].get(v, -1) for v in venue_ids), dtype=np.int64, count=n)
    ok = ((rows >= 0) & np.isfinite(dow) & np.isfinite(hour) & (dow >= 0) & (dow <= 6)
          & (hour >= 0) & (hour <= 23))
    if not ok.any():
        return out
    idx = np.flatnonzero(ok)
    r = rows[idx]
    s = (dow[idx] * 24 + hour[idx]).astype(np.int64)
    curve = table['curve']
    cur = curve[r, s].astype(float)
    prev = curve[r, (s - 1) % 168].astype(float)
    nxt = curve[r, (s + 1) % 168].astype(float)
    prev = np.where(prev > 0, prev, 0.0)   # absent (-1) or 0: "unavailable"
    nxt = np.where(nxt > 0, nxt, 0.0)
    has_nb = (prev > 0) | (nxt > 0)
    blended = js_round(cur * 0.6 + np.where(prev > 0, prev, cur) * 0.2 + np.where(nxt > 0, nxt, cur) * 0.2)
    val = np.where(has_nb, blended, cur)
    out[idx] = np.where(cur >= 0, val, 0.0)
    return out


LIVE_TABLE_COLS = ['venue_id', 'day_of_week', 'hour', 'busyness_pct', 'observed_date',
                   'label_source', 'is_realtime']


def build_live_reading_table(frames: List[pd.DataFrame], neighbor_table: Dict) -> Dict:
    """Every live reading buildRecentDeviation.js would store, per venue, oldest first.

    Only the rows whose is_realtime is 1 and label_source is live are read, so
    frames holding just those rows (the streamed preparation's) build the same
    table as the whole frames."""
    raw = pd.concat([f[LIVE_TABLE_COLS] for f in frames], ignore_index=True)
    live = ((pd.to_numeric(raw['is_realtime'], errors='coerce') == 1).to_numpy()
            & (raw['label_source'].astype('string').fillna('').str.strip() == 'live').to_numpy())
    y = pd.to_numeric(raw['busyness_pct'], errors='coerce').to_numpy(dtype=float)
    dow = pd.to_numeric(raw['day_of_week'], errors='coerce').to_numpy(dtype=float)
    hour = pd.to_numeric(raw['hour'], errors='coerce').to_numpy(dtype=float)
    slot = _row_slots(raw)
    vid = raw['venue_id'].astype(str).to_numpy()
    rows = np.fromiter((neighbor_table['index'].get(v, -1) for v in vid), dtype=np.int64, count=len(vid))
    ok = (live & np.isfinite(y) & (y >= 0) & (y <= 100) & np.isfinite(slot) & (rows >= 0)
          & np.isfinite(dow) & (dow >= 0) & (dow <= 6) & (np.floor(dow) == dow))
    idx = np.flatnonzero(ok)
    own_curve = neighbor_table['curve'][rows[idx], (dow[idx] * 24 + hour[idx]).astype(np.int64)].astype(float)
    keep = own_curve > 0          # the builder's JOIN ... AND b.baseline > 0
    idx = idx[keep]
    dev = y[idx] - own_curve[keep]
    frame = pd.DataFrame({'v': vid[idx], 'slot': slot[idx], 'y': y[idx], 'dev': dev})
    frame = frame.sort_values(['v', 'slot'], kind='stable')
    by_venue = {}
    for v, g in frame.groupby('v', sort=False):
        by_venue[v] = (g['slot'].to_numpy(dtype=float), g['y'].to_numpy(dtype=float),
                       g['dev'].to_numpy(dtype=float))
    return {'by_venue': by_venue, 'readings': int(len(frame)), 'venues': len(by_venue)}


def live_feature_values(readings, target_slot: float, baseline: float) -> Tuple[float, float, float, float]:
    """(last_live_dev, last_live_age_h, recent_offset, recent_offset_n) for one slot."""
    last_dev, age, offset, n_off = 0.0, float(LIVE_MISSING_AGE_H), 0.0, 0.0
    if readings is None or not np.isfinite(target_slot):
        return last_dev, age, offset, n_off
    slots, values, devs = readings
    k = int(np.searchsorted(slots, target_slot, side='left'))   # readings[:k] are strictly earlier
    if k > 0:
        lag = target_slot - slots[k - 1]
        if 1 <= lag <= NOWCAST_MAX_LAG_HOURS:
            last_dev, age = float(values[k - 1] - baseline), float(lag)
    window = []
    j = k - 1
    while j >= 0 and len(window) < OFFSET_MAX_READINGS:
        if slots[j] < target_slot - OFFSET_WINDOW_HOURS:
            break
        window.append(devs[j])
        j -= 1
    if len(window) >= DEVIATION_MIN_READINGS:
        a = sorted(window)
        m = len(a)
        raw = a[(m - 1) // 2] if m % 2 else (a[m // 2 - 1] + a[m // 2]) / 2
        offset = float(max(-DEVIATION_CLAMP, min(DEVIATION_CLAMP, raw)))
        n_off = float(m)
    return last_dev, age, offset, n_off


def add_live_features(df: pd.DataFrame, reading_table: Dict, neighbor_table: Dict) -> pd.DataFrame:
    """The five live columns (the block above). Run after add_baseline_features:
    last_live_dev is measured against the row's served, smoothed baseline."""
    n = len(df)
    vid = df['venue_id'].astype(str).to_numpy()
    dow = pd.to_numeric(df['day_of_week'], errors='coerce').to_numpy(dtype=float)
    hour = pd.to_numeric(df['hour'], errors='coerce').to_numpy(dtype=float)
    prev_hour = (hour - 1) % 24
    prev_dow = np.where(hour == 0, (dow - 1) % 7, dow)
    df['curve_prev_hour'] = served_curve_at(neighbor_table, vid, prev_dow, prev_hour)

    slot = _row_slots(df)
    base = pd.to_numeric(df['baseline_busyness'], errors='coerce').fillna(0).to_numpy(dtype=float)
    out = np.zeros((n, 4), dtype=float)
    out[:, 1] = LIVE_MISSING_AGE_H
    by_venue = reading_table['by_venue']
    for i in np.flatnonzero(np.isfinite(slot)):
        readings = by_venue.get(vid[i])
        if readings is not None:
            out[i] = live_feature_values(readings, slot[i], base[i])
    df['last_live_dev'] = out[:, 0]
    df['last_live_age_h'] = out[:, 1]
    df['recent_offset'] = out[:, 2]
    df['recent_offset_n'] = out[:, 3]
    with_reading = int((out[:, 1] < LIVE_MISSING_AGE_H).sum())
    with_offset = int((out[:, 3] > 0).sum())
    logger.info('Live features: %d rows with an earlier reading within %dh, %d with a trailing '
                'offset (of %d dated rows, %d rows).', with_reading, NOWCAST_MAX_LAG_HOURS,
                with_offset, int(np.isfinite(slot).sum()), n)
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
    df['is_special_night'] = vals[:, 0].astype(FLAG_DTYPE)
    df['special_boost'] = vals[:, 1]
    df['special_suppress'] = vals[:, 2]
    df['is_holiday_eve'] = vals[:, 3].astype(FLAG_DTYPE)
    n = int(df['is_special_night'].sum())
    e = int(df['is_holiday_eve'].sum())
    logger.info(f'Holiday features: {n} special-night rows, {e} holiday-eve rows')
    return df


# Sports game-night features (2026-08-30, TheSportsDB). The scope doc in
# ../RETRAIN.md is the contract: the flag is "is a tracked team playing at
# all tonight", home or away, because sports bars fill for road games on TV;
# home-ness and arena distance are separate features layered on top, and the
# lift is expected to decay with distance rather than be a binary.
SPORTS_DIST_CAP_KM = 60.0       # mlPredictor.SPORTS_DIST_CAP_KM
SPORTS_LOCAL_KM = 60.0          # mlPredictor.SPORTS_LOCAL_KM
SPORTS_HOME_NEAR_KM = 10.0      # mlPredictor.SPORTS_HOME_NEAR_KM
SPORTS_FEATURE_NAMES: List[str] = ['sports_game_today', 'sports_games_count', 'sports_evening_game',
                                   'sports_home_game_today', 'sports_home_dist_km', 'sports_home_within_10km']


def sports_features_enabled(env=os.environ) -> bool:
    """FLOCK_SPORTS_FEATURES: '1' on, '0' off, unset: on exactly when
    sports_events.csv (exportSportsEvents.js) sits beside this file.

    Off without the file because six columns computed from no schedule are
    constant and the dead-slot contract would stop the run; a retrain that
    means to carry the family exports the schedule first (RETRAIN.md)."""
    v = str(env.get('FLOCK_SPORTS_FEATURES', '')).strip()
    if v == '1':
        return True
    if v == '0':
        return False
    return (SCRIPT_DIR / 'sports_events.csv').exists()


def add_sports_features(df: pd.DataFrame, path: Path = None) -> pd.DataFrame:
    """Game-night context from sports_events.csv (exportSportsEvents.js).

    Three zero cases, each the truth rather than a fallback:
      * the CSV is absent (the schedule pull has not run) - every column is
        zero and the distance sits at its cap, so an old export trains
        exactly as before;
      * weekly rows - no observed_date, and a synthetic "typical Tuesday"
        has no game night, same rule the holiday features follow;
      * rows farther than SPORTS_LOCAL_KM from every tracked arena - a
        Phillies game is not a feature of a Tokyo Tuesday. Without this
        gate the date-keyed flags would light up worldwide and hand the
        trees a calendar correlate, the same class of leak latitude and
        longitude are dropped for.

    Distances are derived from latitude/longitude, which stay available on
    the frame here and are excluded from the FEATURE list; derived-not-raw
    is the same pattern the astronomy features use.
    """
    cols_zero = ['sports_game_today', 'sports_games_count', 'sports_evening_game',
                 'sports_home_game_today', 'sports_home_within_10km']
    path = Path(path) if path is not None else SCRIPT_DIR / 'sports_events.csv'
    if not path.exists():
        for c in cols_zero:
            df[c] = np.zeros(len(df), dtype=FLAG_DTYPE)
        df['sports_home_dist_km'] = SPORTS_DIST_CAP_KM
        logger.info('Sports features: sports_events.csv absent, all-zero columns (run exportSportsEvents.js to arm)')
        return df

    ev = pd.read_csv(path, dtype={'event_local_date': str, 'event_local_time': str})

    # The tracked arenas are a handful of fixed points; every distance in
    # this family is a min over them, so one small matrix covers the frame.
    home = ev[(ev['is_home'] == 1) & ev['venue_lat'].notna() & ev['venue_lon'].notna()]
    arenas = home[['venue_lat', 'venue_lon']].drop_duplicates().to_numpy(dtype=float)

    lat = df['latitude'].to_numpy(dtype=float)
    lon = df['longitude'].to_numpy(dtype=float)
    if len(arenas):
        lat_r = np.radians(lat)[:, None]
        lon_r = np.radians(lon)[:, None]
        a_lat = np.radians(arenas[:, 0])[None, :]
        a_lon = np.radians(arenas[:, 1])[None, :]
        h = (np.sin((a_lat - lat_r) / 2) ** 2
             + np.cos(lat_r) * np.cos(a_lat) * np.sin((a_lon - lon_r) / 2) ** 2)
        dist_all = 2 * 6371.0 * np.arcsin(np.sqrt(h))  # rows x arenas, km
        with np.errstate(invalid='ignore'):
            nearest_any = np.nanmin(dist_all, axis=1)
    else:
        dist_all = np.zeros((len(df), 0))
        nearest_any = np.full(len(df), np.inf)
    local = np.nan_to_num(nearest_any, nan=np.inf) <= SPORTS_LOCAL_KM

    def hour_of(t):
        t = str(t or '')
        return int(t[:2]) if len(t) >= 2 and t[:2].isdigit() else -1

    by_date = {}
    arena_index = {(round(la, 6), round(lo, 6)): i for i, (la, lo) in enumerate(arenas)}
    for r in ev.itertuples():
        d = by_date.setdefault(r.event_local_date, {'count': 0, 'evening': 0, 'home_idx': set()})
        d['count'] += 1
        if 17 <= hour_of(r.event_local_time) <= 23:
            d['evening'] = 1
        if r.is_home == 1 and pd.notna(r.venue_lat) and pd.notna(r.venue_lon):
            idx = arena_index.get((round(float(r.venue_lat), 6), round(float(r.venue_lon), 6)))
            if idx is not None:
                d['home_idx'].add(idx)

    n = len(df)
    game_today = np.zeros(n, dtype=np.int8)
    games_count = np.zeros(n, dtype=np.int16)
    evening = np.zeros(n, dtype=np.int8)
    home_today = np.zeros(n, dtype=np.int8)
    home_dist = np.full(n, SPORTS_DIST_CAP_KM, dtype=float)

    dates = df['observed_date'].fillna('').astype(str).to_numpy()
    for date_str in pd.unique(dates):
        if not date_str or date_str not in by_date:
            continue
        info = by_date[date_str]
        rows = (dates == date_str) & local
        if not rows.any():
            continue
        game_today[rows] = 1
        games_count[rows] = info['count']
        evening[rows] = info['evening']
        if info['home_idx'] and dist_all.shape[1]:
            idx = sorted(info['home_idx'])
            d = np.nanmin(dist_all[np.ix_(rows.nonzero()[0], idx)], axis=1)
            home_today[rows] = 1
            home_dist[rows.nonzero()[0]] = np.minimum(
                np.nan_to_num(d, nan=SPORTS_DIST_CAP_KM), SPORTS_DIST_CAP_KM)

    df['sports_game_today'] = game_today
    df['sports_games_count'] = games_count
    df['sports_evening_game'] = evening
    df['sports_home_game_today'] = home_today
    df['sports_home_dist_km'] = home_dist
    df['sports_home_within_10km'] = ((home_dist <= SPORTS_HOME_NEAR_KM) & (home_today == 1)).astype(np.int8)

    lit = int(game_today.sum())
    logger.info(f'Sports features: {len(ev)} events, {len(arenas)} arenas, {lit} game-night rows '
                f'({int(home_today.sum())} with a home game in market)')
    return df


def add_venue_features(df: pd.DataFrame, metadata: Dict = None) -> Tuple[pd.DataFrame, Dict]:
    """Add venue-derived features and encode categories.

    `metadata` is the training frame's fit (fit_venue_features); None fits it
    from `df`. The fills below are the fitted numbers either way.
    """
    if metadata is None:
        metadata = fit_venue_features(df)
    # Category encoding
    cat_map = metadata['category_encoding']
    df['venue_category_encoded'] = df['venue_category'].map(cat_map).fillna(-1).astype(int)

    # Price level and rating — fill missing with the median
    df['price_level'] = df['price_level'].fillna(metadata['median_price_level'])
    df['rating'] = df['rating'].fillna(metadata['median_rating'])

    # Review count — the median too (fit_venue_features says why it is not 0)
    median_review_count = metadata['median_review_count']
    df['review_count'] = df['review_count'].fillna(median_review_count)
    df['log_review_count'] = np.log1p(df['review_count'])

    # Google types one-hot (top N most common in the training frame)
    type_cols = ['google_type_1', 'google_type_2', 'google_type_3']
    for t in metadata['top_google_types']:
        col_name = f'gtype_{t}'
        df[col_name] = np.zeros(len(df), dtype=FLAG_DTYPE)
        for tc in type_cols:
            df.loc[df[tc] == t, col_name] = 1

    return df, metadata


def fit_venue_features(df: pd.DataFrame) -> Dict:
    """The fills and encodings add_venue_features applies, fitted on `df`."""
    # Category encoding
    categories = sorted(df['venue_category'].dropna().unique().tolist())

    # Price level and rating — the median
    median_price = df['price_level'].median()
    median_rating = df['rating'].median()

    # Review count — filled with the MEDIAN, the same way rating is filled six
    # lines up, and stored so the holdout reuses the number rather than
    # recomputing one from its own rows.
    #
    # This was fillna(0), which is not a neutral fill. Zero reviews means
    # "nobody has ever been here" — the far end of the range, not the middle —
    # and it is not what a missing value means here. It means Google was never
    # asked. scripts/ml/discoverBestTime.js wrote a literal 0 for every venue it
    # found through BestTime (which reports no review counts at all) and
    # ml_venues.review_count carried DEFAULT 0 besides, so those venues reached
    # the model as: median rating, zero reviews. review_count and
    # log_review_count are both shipped features, so that pairing is a strong
    # learnable signature for "this row came from the discovery path" rather
    # than anything about the venue — the same leakage shape as the
    # single-instant weather that repairWeeklyWeather.js clears off the weekly
    # rows, and it sits on exactly the venues that were duplicated.
    #
    # Migration 060 drops the DEFAULT and clears the fabricated zeros, so an
    # unknown now arrives here as NULL -> NaN and is imputed like any other.
    #
    # THE SERVING SIDE MUST MATCH BEFORE THE NEXT MODEL SHIPS.
    # services/mlPredictor.js buildFeatureMap reads
    #   const reviewCount = venue.user_ratings_total || venue.review_count || 0;
    # while rating one line above it already falls back to
    # metadata.median_rating. A model trained with a median fill and served with
    # a zero fill has the skew the other way round, so that fallback has to
    # become metadata.median_review_count (published below) in the same change
    # that retrains.
    median_review_count = df['review_count'].median()

    # Google types one-hot (top N most common). The columns are part of the
    # export contract, so their absence is a contract error, not a skip.
    type_cols = ['google_type_1', 'google_type_2', 'google_type_3']
    all_types = []
    for col in type_cols:
        all_types.extend(df[col].dropna().tolist())

    type_counts = pd.Series(all_types).value_counts()
    top_types = type_counts.head(MAX_GOOGLE_TYPES).index.tolist()
    return venue_feature_metadata(categories, median_price, median_rating, median_review_count, top_types)


def venue_feature_metadata(categories: List, median_price, median_rating, median_review_count,
                           top_types: List) -> Dict:
    """fit_venue_features' record from its pieces; a median of no rows takes its default."""
    if pd.isna(median_price):
        median_price = 2
    if pd.isna(median_rating):
        median_rating = 4.0
    if pd.isna(median_review_count):
        median_review_count = 0.0
    cat_map = {cat: i for i, cat in enumerate(categories)}
    return {
        'category_encoding': cat_map,
        'median_price_level': float(median_price),
        'median_rating': float(median_rating),
        # Published for the same two readers median_rating has: the holdout
        # transform below, and services/mlPredictor.js at serving time.
        'median_review_count': float(median_review_count),
        'top_google_types': top_types,
    }


COLD_OUTDOOR_MAX_TEMP_F = 41.0  # 5C, in the imperial units the corpus is collected in (add_weather_features)


def add_weather_features(df: pd.DataFrame, norms: pd.DataFrame = None) -> pd.DataFrame:
    """Add weather-derived features.

    `norms` is the climate table fitted on the TRAINING frame; pass it for the
    holdout so no holdout reading shapes a holdout feature. None fits it from
    this frame's observed readings (training, and the within-city eval).
    """
    if norms is None:
        norms = fit_temperature_norms(df)

    # CARRIED, never a feature: whether this row's weather is a reading or the
    # outage vector below. Recorded before any fill so it cannot be laundered.
    df['weather_observed'] = df['temperature'].notna().astype(FLAG_DTYPE)

    # A missing temperature takes the climate norm for its (band, month), the
    # table mean when the cell has no observed row: mlPredictor.climateNorm,
    # in the same order, on the same key. See the block above
    # fit_temperature_norms for what the city-month median used to do here.
    df['lat_band'] = latitude_band(df['latitude'])
    df['temp_norm'] = temperature_norm_lookup(df, norms)
    df['temperature'] = pd.to_numeric(df['temperature'], errors='coerce').fillna(df['temp_norm'])

    # The outage vector, column by column, from WEATHER_NO_READING_FILLS. Each
    # constant is the one buildFeatureMap emits for a missing reading and is
    # pinned against it; weather_unknown = 1 (below) is what says "no reading".
    for col, value in WEATHER_NO_READING_FILLS.items():
        df[col] = pd.to_numeric(df[col], errors='coerce').fillna(value)
    df['is_raining'] = df['is_raining'].astype(int)

    # Weather code groups. recover_weather_codes() has already run, so a NaN
    # here means the row genuinely carries no weather reading — 'unknown' is
    # then the truthful level, not a silent stand-in for the whole corpus.
    df['weather_group'] = df['weather_condition_code'].apply(group_weather_code)
    for g in WEATHER_GROUP_NAMES:
        df[f'weather_{g}'] = (df['weather_group'] == g).astype(FLAG_DTYPE)

    # Interaction features
    df['rain_x_weekend'] = df['is_raining'] * df['is_weekend']
    df['rain_x_dinner'] = df['is_raining'] * df['is_dinner_hour']
    # cold_outdoor: THE THRESHOLD WAS IN CELSIUS AND THE COLUMN IS FAHRENHEIT.
    # services/weatherService.js fetches OpenWeatherMap with units=imperial (both
    # call sites, lines 303 and 400) and every row in the corpus was collected
    # through that same function, so `temperature < 5` asks for -15C. The corpus
    # minimum is 14.7F, p0.1 is 26.1F: the test was false on all 1,934,988
    # training rows and all 395,464 holdout rows, and cold_outdoor has been a
    # dead slot in every artifact ever exported.
    #
    # The failure mode this is worth naming: mlPredictor.buildFeatureMap carried
    # the IDENTICAL `temp < 5`, so the feature-parity gate was green the whole
    # time. Parity between two sides that are both wrong is not correctness, and
    # a parity check can never find a unit error by itself — only a value-level
    # look at the column can, which is what the dead-slot contract below now
    # forces on every run.
    #
    # 41F is 5C, i.e. the same line the author meant, in the units the data is
    # actually in. It is a unit conversion, not a new hyperparameter. Measured on
    # the shipped pickle: 4.00% of rows fall below 41F and 5,321 of them (0.28%)
    # are also clear, so the slot becomes a rare live level on the order of
    # weather_snow (1,605 rows) instead of a constant.
    #
    # CHANGE BOTH SIDES IN THE SAME COMMIT. mlPredictor.js's cold_outdoor must
    # use the same number or training and serving disagree about what cold means,
    # and that disagreement is invisible to every test in the repo.
    # (COLD_OUTDOOR_MAX_TEMP_F is defined above this function: the streamed
    # preparation reads it too.)
    df['cold_outdoor'] = (
        (df['temperature'] < COLD_OUTDOOR_MAX_TEMP_F) & (df['weather_clear'] == 1)
    ).astype(FLAG_DTYPE)

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


# THE COLUMNS THE CELL FITS READ (2026-11-19). The three functions below used
# to copy the whole frame (every export column and every feature built so far)
# to read these six: on the 2026-10-08 export that copy was most of this
# script's 14.9 GB peak (build_category_cell_aggregates alone rose 10.4 GB),
# about 4.2 GB per million rows, more than this PC holds for the
# harvest-inclusive export. They now copy the fitted rows of these columns
# only (and the group column), which are the only ones they read: same rows,
# same values, same groups. On that export the peak fell to 8.1 GB and both
# pickles and model_metadata.json compared equal key by key, column by column
# and value by value to the old code's (a comparison that catches a change to
# one feature value, one label or one cell sum).
_CELL_FIT_COLS = ['venue_category', 'day_of_week', 'hour', 'price_level', 'rating', 'busyness_pct']


def _cell_fit_frame(df: pd.DataFrame, rows=None, extra: Tuple[str, ...] = ()) -> pd.DataFrame:
    """A copy of `rows` (all when None) of the columns the cell fits read, keyed."""
    cols = _CELL_FIT_COLS + [c for c in extra if c not in _CELL_FIT_COLS]
    d = df.loc[:, cols] if rows is None else df.loc[rows, cols]
    return _slice_keys(d.copy())


def _smooth_category_hours(cat: pd.DataFrame, by: List[str]) -> pd.DataFrame:
    """Blend each category-hour cell with its adjacent hours within `by`.

    Shared by the full-frame map and the leave-one-city-out maps so the two can
    never drift into different smoothing. `by` is the grouping the shift runs
    inside — ['venue_category', 'day_of_week'] for the full map, with the group
    column prepended for the LOCO maps.
    """
    cat = cat.sort_values(by + ['hour'])
    cat['_prev'] = cat.groupby(by)['category_baseline'].shift(1)
    cat['_next'] = cat.groupby(by)['category_baseline'].shift(-1)
    cat['_prev'] = cat['_prev'].fillna(cat['category_baseline'])
    cat['_next'] = cat['_next'].fillna(cat['category_baseline'])
    # Smooth across adjacent hours so the model sees gradual transitions.
    cat['smooth'] = (cat['category_baseline'] * 0.6 + cat['_prev'] * 0.2
                     + cat['_next'] * 0.2).round(1)
    return cat


def build_category_baseline_maps(df: pd.DataFrame) -> Dict:
    """Category/refined baseline lookups fit on the WHOLE frame handed in.

    Round 10 (leakage): both lookups are averages of busyness_pct, i.e. the
    LABEL, and neither is in get_feature_columns' exclude set. The holdout
    split used to call add_baseline_features() on itself, so held-out labels
    built the held-out rows' own features — the model was handed the answer and
    every holdout number was inflated. Same class of bug as the popular_times
    leak in the retrain doctrine: a feature that quietly carries the label.

    WHERE THIS MAP MAY BE USED, and where it may NOT.

      * It is the map SHIPPED to Node (metadata.category_baselines /
        refined_baselines). Inference has no notion of a held-out group, so the
        best available estimate — every training row — is the right one to
        serve, and a venue in a city the corpus has never seen is exactly the
        case the shipped map has to cover.
      * It is the map APPLIED to the holdout cities. Their rows contributed
        nothing to it, so for them it is already out-of-sample.
      * It must NOT be applied to the rows it was fitted on. That is round 14's
        finding: train_model.py's GroupKFold holds out one CITY per fold, and a
        held-out city had already contributed to the very category cells its
        own rows were then scored against. That is still true and still open;
        the note above build_category_cell_aggregates says why the correction cannot
        be applied from this file and what this file ships instead.

    FIT ON VENDOR PROVENANCE ONLY (2026-08-18). These maps are means of the
    LABEL that become features for OTHER rows, so a non-vendor row (owner
    slider, user feedback, sensor) fitting into them would let one submitter
    move the category feature of every venue in the cell. No-op on the frozen
    all-vendor corpus; a hard precondition for the day it is not. The same
    predicate filters build_category_cell_aggregates so the per-fold refit
    rebuilds THIS map exactly (verify_reproduces_shipped depends on the two
    fits seeing identical rows).
    """
    df = _cell_fit_frame(df, vendor_provenance_mask(df))

    cat = (
        df.groupby(CAT_KEYS)['busyness_pct'].mean().round(1)
        .rename('category_baseline').reset_index()
    )
    cat = _smooth_category_hours(cat, ['venue_category', 'day_of_week'])

    refined = df.groupby(REFINED_KEYS)['busyness_pct'].mean().round(1)

    return {
        'category': cat.set_index(CAT_KEYS)['smooth'],
        'refined': refined,
        'global_mean': round(float(df['busyness_pct'].mean()), 1),
    }


# ---------------------------------------------------------------------------
# Per-fold category baselines (round 14) — the sufficient statistics, and why
# the fix itself is NOT applied here.
#
# THE LEAK. category_baseline and refined_category_baseline are means of
# busyness_pct — the label. build_category_baseline_maps fits them on the whole
# training frame and add_baseline_features applies them to that same frame.
# train_model.py splits with GroupKFold(n_splits=n_cities) grouped on city, so
# every fold holds out exactly one city, and that city's own labels are already
# baked into the category cells its rows are then scored against. It makes
# training_metrics optimistic. It does NOT touch the ship gate, which is
# measured on the separate holdout cities — their rows contribute nothing to
# these maps, which is why the holdout path passes cat_maps in rather than
# refitting.
#
# THE OBVIOUS CHEAP FIX IS WRONG, AND IT IS WRONG IN THE DANGEROUS DIRECTION.
# The tempting formulation is a leave-one-city-out map computed once — replace
# each cell mean with (cell_sum - own_city_sum) / (cell_n - own_city_n), the
# same subtraction trick round 13 used for the leave-one-out anchor in
# export_training_data.js. It looks equivalent to a per-fold refit and it is
# not. Under it the feature VARIES BY CITY inside a fold, and its deviation
# from the cell's typical value is a deterministic, invertible function of the
# held-out city's own labels: a tree that splits on (category, dow, hour) to
# identify the cell and then on category_baseline inside it is reading that
# city's mean level straight off the feature. The model has every incentive to
# learn exactly that, because the relationship is real in the fold's training
# rows too.
#
# Measured on a synthetic fixture over three independent draws (10 training
# cities, GroupKFold on city, identical hyperparameters; the delta label's only
# learnable signal is a per-city deviation, so an honest model cannot beat the
# predict-zero floor on a city it never saw). The per-fold refit is the honest
# reference — its final model is the same artifact the whole-frame fit produces,
# so any CV difference between them is reporting, not model quality. How far
# each regime's REPORTED leave-one-city-out number sits below that reference,
# across the three draws:
#
#     whole-frame fit (what this file does)    MAE 0.21..0.42 low,  w10 1.4..2.1pp high
#     leave-one-city-out computed once         MAE 1.52..3.05 low,  w10 10.4..20.5pp high
#     K-fold "block" encoding, K = 2 / 3 / 5   MAE -0.05..0.80 low, no ordering in K
#     per-fold refit (the reference)           0 by construction
#
# So the cheap formulation understates the reported error by FIVE TO SEVEN TIMES
# what the leak it claims to remove does, and inflates within-10 — the number
# mlPredictor.js publishes as the venue card's confidence — by 10 to 20 points.
# Block encoding is not even monotone in K; at K=3 on one draw it is worse than
# doing nothing. Only the per-fold refit is honest, and it is honest for a
# structural reason: inside a fold the map is one value per cell, shared by that
# fold's training and validation rows alike, so there is no city-varying
# residual left to invert.
#
# THEREFORE IT BELONGS IN train_model.py, NOT HERE. Being constant within a fold
# is the property that makes it correct, and this script has no folds — it emits
# one feature matrix. What legitimately belongs here is the label arithmetic,
# because this is the only step that still holds the labels in a frame: the
# per-(city, cell) sums and counts below let the trainer rebuild any fold's map
# with one subtraction and no second pass over the CSV. RETRAIN.md tracks the
# consuming half as next lever 2.
#
# ROUND 21: THE STATISTICS MUST BE FITTED ON THE SAME POPULATION AS THE FEATURE
# THEY REPLACE, AND FOR ONE ROUND THEY WERE NOT. These aggregates used to be
# built after the serving-population filter, because row_cell / row_group are
# positional indexes into X and X is the filtered matrix. But the map they stand
# in for is fitted by build_category_baseline_maps BEFORE that filter, on all
# 3,516,876 rows rather than the 1,934,988 with a real baseline. Measured on the shipped
# pickle, a fold map built the old way moved category_baseline on 99.9% of rows
# by a mean of 9.27 points, while removing the held-out city — the entire point —
# moved it on 75% of rows by a mean of 0.17. The confound was fifty-four times
# the effect. A cross-validation number computed that way is not a corrected
# number; it describes a model whose category feature is not the one shipped, and
# reporting it would repeat, in a new place, exactly the sin of publishing a
# figure that measures something other than what production serves.
#
# So the two halves are split at the two points in main() where they are each
# correct: build_category_cell_aggregates runs on the PRE-filter frame, beside
# the map it must reproduce, and index_category_cells attaches the positional
# indexes AFTER the filter, on the rows X actually contains. The property that
# makes this checkable is exact: hold out no city, and the rebuilt column must
# equal the shipped column to the bit. The trainer asserts it.
# ---------------------------------------------------------------------------

LEAVE_OUT_COL = 'city'


CELL_STATS_VERSION = 2


def _cell_key_column(d: pd.DataFrame, keys: List[str]) -> np.ndarray:
    """One \\x1f-joined string per row, for the cell `keys`.

    Vectorised string concat, not `.agg(join, axis=1)`: the latter is a per-row
    Python call and these frames are millions of rows.
    """
    key_frame = d[keys[0]].astype(str)
    for k in keys[1:]:
        key_frame = key_frame + '\x1f' + d[k].astype(str)
    return key_frame.to_numpy()


def build_category_cell_aggregates(fit_df: pd.DataFrame,
                                   group_col: str = LEAVE_OUT_COL) -> Dict:
    """Per-(group, cell) label sums and counts for a per-fold refit.

    MUST be called on the frame build_category_baseline_maps was fitted on —
    i.e. BEFORE the serving-population filter — because the whole purpose is to
    let the trainer rebuild THAT map minus one city. See the round 21 paragraph
    above: fitting these on the filtered frame instead moved the feature fifty
    times further than the leak did, in a direction that has nothing to do with
    the leak.

    Returns, for both the coarse and the refined key:
      cells       — the cell key tuples, in cell-index order (the coarse one
                    carries (venue_category, day_of_week, hour) so the caller
                    can redo the adjacent-hour smoothing);
      sums/counts — dense (n_groups x n_cells) label sums and counts.

    A fold's map is then:
        s = sums[train_groups].sum(0); n = counts[train_groups].sum(0)
        cell_mean = round(s / n, 1)          # n == 0 -> no support, fall back
    which is the identical arithmetic build_category_baseline_maps performs,
    restricted to that fold's training groups. Nothing here is a feature and
    nothing here is applied to a row by this script; it is raw material.
    """
    if group_col not in fit_df.columns:
        raise CorpusContractError(
            f'build_category_cell_aggregates needs the {group_col!r} column — it is '
            'the group train_model.py holds one out of per fold, and without it a '
            'per-fold refit of the category baselines is not expressible.'
        )
    # Vendor provenance only (2026-08-18) — the SAME predicate
    # build_category_baseline_maps fits under, and for the same reason: these
    # sums/counts rebuild that map per fold, so if a non-vendor row entered
    # here but not there, verify_reproduces_shipped would fail — and if it
    # entered both, a self-reported label would be shaping category features.
    d = _cell_fit_frame(fit_df, vendor_provenance_mask(fit_df), (group_col,))
    groups = d[group_col].fillna('__unknown__').astype(str)
    group_levels, group_idx = np.unique(groups.to_numpy(), return_inverse=True)

    out: Dict = cell_stats_header(group_col, group_levels, int(len(d)),
                                  float(d['busyness_pct'].sum()), int(d['busyness_pct'].count()))

    y = d['busyness_pct'].to_numpy(dtype=float)
    finite = np.isfinite(y)
    for name, keys in (('category', CAT_KEYS), ('refined', REFINED_KEYS)):
        cell_levels, cell_idx = np.unique(_cell_key_column(d, keys), return_inverse=True)
        sums = np.zeros((len(group_levels), len(cell_levels)), dtype=np.float64)
        counts = np.zeros((len(group_levels), len(cell_levels)), dtype=np.int64)
        flat = group_idx * len(cell_levels) + cell_idx
        np.add.at(sums.reshape(-1), flat[finite], y[finite])
        np.add.at(counts.reshape(-1), flat[finite], 1)
        out[name] = cell_block(keys, cell_levels, sums, counts)
        logger.info('Per-fold %s baseline aggregates: %d cells x %d %s groups, '
                    'fitted on %d pre-filter rows.',
                    name, len(cell_levels), len(group_levels), group_col, len(d))
    return out


def cell_stats_header(group_col: str, group_levels, fit_rows: int, global_sum: float,
                      global_count: int) -> Dict:
    """The part of build_category_cell_aggregates' record that is not per cell."""
    return {
        'version': CELL_STATS_VERSION,
        'group_col': group_col,
        'groups': [str(g) for g in group_levels],
        'fit_population': 'pre_serving_filter',
        'fit_population_note': (
            'fitted on the same frame build_category_baseline_maps is fitted on, so '
            'holding out no group reproduces the shipped category_baseline / '
            'refined_category_baseline columns exactly. The only difference a fold '
            'map carries is the held-out group.'),
        'fit_rows': fit_rows,
        'global_sum': global_sum,
        'global_count': global_count,
        'recipe': (
            'fold_map[cell] = round(sums[fold_train_groups].sum(0) / '
            'counts[fold_train_groups].sum(0), 1); smooth the coarse map across '
            'adjacent hours within (venue_category, day_of_week) with the '
            '0.6/0.2/0.2 blend prepare_features._smooth_category_hours uses, then '
            'index with row_cell. Cells with a zero fold count have no support '
            'outside the held-out group — fall back to the fold global mean.'),
    }


def cell_block(keys: List[str], cell_levels: np.ndarray, sums: np.ndarray, counts: np.ndarray) -> Dict:
    """One key's cells (sorted '\\x1f'-joined strings) with their per-group sums and counts."""
    return {
        'keys': list(keys),
        'cells': [tuple(c.split('\x1f')) for c in cell_levels],
        'cell_levels': cell_levels,
        'sums': sums,
        'counts': counts,
    }


def index_category_cells(rows_df: pd.DataFrame, agg: Dict) -> Dict:
    """Attach POSITIONAL row indexes, for the rows the feature matrix will hold.

    Called after every row filter, so `row_cell` / `row_group` line up with X.
    The cell and group levels come from `agg`, which was fitted on the wider
    pre-filter frame — the rows here are a subset of those rows, so every key
    resolves; a key that does not means the two frames are unrelated and this
    raises rather than inventing a cell.

    `rows_sums` / `rows_counts` are the same aggregates restricted to these rows.
    They are NOT used to build any map. They exist so the trainer can re-derive
    them from row_cell/row_group and prove the indexes describe the frame it is
    holding, which is the one failure mode that would be silent: a positional
    index from a different row order scores every row against the wrong cell and
    produces better-looking numbers that mean nothing.
    """
    d = _cell_fit_frame(rows_df, None, (agg['group_col'],))
    group_levels = np.asarray(agg['groups'], dtype=object).astype(str)
    groups = d[agg['group_col']].fillna('__unknown__').astype(str).to_numpy()
    order = np.argsort(group_levels)
    pos = np.searchsorted(group_levels[order], groups)
    if (pos >= len(group_levels)).any():
        pos = np.clip(pos, 0, len(group_levels) - 1)
    group_idx = order[pos]
    missing = group_levels[group_idx] != groups
    if missing.any():
        raise CorpusContractError(
            f'{int(missing.sum())} rows carry a {agg["group_col"]!r} the category '
            f'aggregates were never fitted on (e.g. {groups[missing][0]!r}). The '
            'aggregates are fitted on the pre-filter frame and these rows are a '
            'subset of it, so this cannot happen unless the two came from '
            'different runs.')

    out: Dict = indexed_cell_stats(agg, int(len(d)), group_idx)

    y = d['busyness_pct'].to_numpy(dtype=float)
    finite = np.isfinite(y)
    for name in ('category', 'refined'):
        block = agg[name]
        levels = block['cell_levels']
        keyed = _cell_key_column(d, block['keys'])
        cell_idx = np.searchsorted(levels, keyed)
        cell_idx = np.clip(cell_idx, 0, len(levels) - 1)
        missing = levels[cell_idx] != keyed
        if missing.any():
            raise CorpusContractError(
                f'{int(missing.sum())} rows fall in a {name!r} cell the aggregates '
                f'were never fitted on (e.g. {keyed[missing][0]!r}).')
        n_cells = len(levels)
        flat = group_idx * n_cells + cell_idx
        rows_sums = np.zeros(len(group_levels) * n_cells, dtype=np.float64)
        rows_counts = np.zeros(len(group_levels) * n_cells, dtype=np.int64)
        np.add.at(rows_sums, flat[finite], y[finite])
        np.add.at(rows_counts, flat[finite], 1)
        out[name] = indexed_cell_block(name, block, cell_idx, rows_sums.reshape(len(group_levels), n_cells),
                                       rows_counts.reshape(len(group_levels), n_cells))
    return out


def indexed_cell_stats(agg: Dict, rows: int, group_idx: np.ndarray) -> Dict:
    """index_category_cells' record before its two cell blocks."""
    out: Dict = {k: v for k, v in agg.items() if k not in ('category', 'refined')}
    out['rows'] = rows
    out['row_group'] = group_idx.astype(np.int32)
    return out


def indexed_cell_block(name: str, block: Dict, cell_idx: np.ndarray, rows_sums: np.ndarray,
                       rows_counts: np.ndarray) -> Dict:
    """One fitted cell block with the indexed rows' cells and their sums and counts."""
    if (rows_counts > block['counts']).any():
        raise CorpusContractError(
            f'the {name!r} cells of these rows are not a subset of the cells the '
            'aggregates were fitted on. The aggregates must come from the '
            'pre-filter frame these rows were filtered out of.')
    return {
        'keys': list(block['keys']),
        'cells': block['cells'],
        'sums': block['sums'],
        'counts': block['counts'],
        'row_cell': cell_idx.astype(np.int32),
        'rows_sums': rows_sums,
        'rows_counts': rows_counts,
    }


def smooth_baseline_hours(df: pd.DataFrame, grid: Dict = None) -> pd.DataFrame:
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

    The blend mirrors mlPredictor.getBaseline (blendBaselineRows):
      - neighbours are the adjacent CLOCK hours and wrap across the day
        boundary (23 -> next day 00, 00 -> previous day 23);
      - a neighbour that is absent or 0 is treated as unavailable and falls back
        to the centre value;
      - with neither neighbour available the centre value passes through;
      - the result is rounded the way JS Math.round rounds (half up).

    A SLOT WHOSE OWN BASELINE IS 0 IS STILL BLENDED WHEN IT HAS A ROW
    (2026-09-25). blendBaselineRows returns 0 only when ml_venue_baselines has
    NO row for the slot; a row holding 0 beside a positive neighbour blends to
    round(0.6*0 + 0.2*prev + 0.2*next), which is positive, so production serves
    the MODEL there (the hour before a venue opens, the hour after it closes).
    This used to keep the 0, which the serving-population filter then dropped,
    so training and the ship gate never saw a population the product serves:
    160 of the 7,920 live September readings the band replay scores
    (bandEval.js). A slot "has a row" when a weekly row exists for it, which is
    exactly when buildBaselines writes one; __tests__/mlSmoothingParity.test.js
    runs this function and blendBaselineRows over the same grid.

    `grid` is a baseline grid fitted on a wider frame (the streamed preparation
    fits it over the whole training frame and smooths each slice of rows
    against it); None fits it from `df`, which is every other caller.
    """
    if grid is None:
        grid = fit_baseline_grid(df)
        has_row = slot_has_baseline_row(df)
    else:
        has_row = grid_slot_has_row(df, grid)
    prev_row, next_row = grid_neighbours(df, grid)
    current = df['baseline_busyness'].to_numpy(dtype=float)
    df['baseline_busyness'] = blend_baseline(current, prev_row, next_row, has_row)
    return df


def blend_baseline(current: np.ndarray, prev_row: np.ndarray, next_row: np.ndarray,
                   has_row: np.ndarray) -> np.ndarray:
    """blendBaselineRows on each row, given its adjacent hours' cell means (0 = none)."""
    has_neighbour = (prev_row > 0) | (next_row > 0)
    prev_eff = np.where(prev_row > 0, prev_row, current)
    next_eff = np.where(next_row > 0, next_row, current)
    blended = np.floor(current * 0.6 + prev_eff * 0.2 + next_eff * 0.2 + 0.5)
    return np.where(has_row & has_neighbour, blended, current)


def fit_baseline_grid(df: pd.DataFrame) -> Dict:
    """The (venue, day_of_week, hour) cell means of `df`'s baselines, laid on 7x24."""
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
    return baseline_grid_from_means(venues, arr)


def baseline_grid_from_means(venues, arr: np.ndarray, weekly: np.ndarray = None) -> Dict:
    """A baseline grid from each venue's 168 cell means (NaN = no cell).

    weekly, when given, marks the slots that hold a weekly row (the streamed
    preparation's slot_has_baseline_row); prev/next are each slot's two clock
    neighbours, 0 where the neighbour has no cell.
    """
    # np.roll over the flattened 168-slot week gives the true clock neighbour,
    # including the day-boundary and week-boundary wraps production uses.
    prev = np.nan_to_num(np.roll(arr, 1, axis=1), nan=0.0)
    nxt = np.nan_to_num(np.roll(arr, -1, axis=1), nan=0.0)
    return {'venues': pd.Index(venues), 'prev': prev, 'next': nxt, 'weekly': weekly}


def _grid_rows(df: pd.DataFrame, grid: Dict) -> Tuple[np.ndarray, np.ndarray]:
    """(row positions, their grid venue and slot) for the rows whose venue has a
    grid and whose day_of_week and hour are a 7x24 slot."""
    vidx = grid['venues'].get_indexer(df['venue_id'].astype(str).to_numpy())
    dow = pd.to_numeric(df['day_of_week'], errors='coerce').to_numpy(dtype=float)
    hour = pd.to_numeric(df['hour'], errors='coerce').to_numpy(dtype=float)
    ok = ((vidx >= 0) & (dow >= 0) & (dow <= 6) & (hour >= 0) & (hour <= 23)
          & (np.floor(dow) == dow) & (np.floor(hour) == hour))
    i = np.flatnonzero(ok)
    return i, (vidx[i], (dow[i] * 24 + hour[i]).astype(np.int64))


def grid_neighbours(df: pd.DataFrame, grid: Dict) -> Tuple[np.ndarray, np.ndarray]:
    """Each row's two adjacent clock hours' cell means, 0 where there is none."""
    prev_row = np.zeros(len(df))
    next_row = np.zeros(len(df))
    i, cell = _grid_rows(df, grid)
    prev_row[i] = grid['prev'][cell]
    next_row[i] = grid['next'][cell]
    return prev_row, next_row


def grid_slot_has_row(df: pd.DataFrame, grid: Dict) -> np.ndarray:
    """slot_has_baseline_row from a grid's weekly-slot marks. A row off the grid
    reads False, which changes nothing: it has no neighbour to blend with."""
    has_row = np.zeros(len(df), dtype=bool)
    i, cell = _grid_rows(df, grid)
    has_row[i] = grid['weekly'][cell]
    return has_row | (df['baseline_busyness'].to_numpy(dtype=float) > 0)


def slot_has_baseline_row(df: pd.DataFrame) -> np.ndarray:
    """True where ml_venue_baselines holds a row for the row's own slot.

    buildBaselines.js writes a slot exactly when a weekly row exists for it, so
    a weekly row always has one, a realtime row has one when a weekly row of
    the same venue shares its (day_of_week, hour), and a positive baseline can
    only have come from one. A realtime row at a slot with no weekly row
    exports baseline 0 through the exporter's COALESCE, and blendBaselineRows
    answers 0 for it however busy its neighbours are.
    """
    if 'is_realtime' not in df.columns:
        raise CorpusContractError(
            'smooth_baseline_hours needs is_realtime to tell a slot whose baseline row '
            'holds 0 from a slot with no baseline row at all; production blends the '
            'first and refuses the second.')
    weekly = pd.to_numeric(df['is_realtime'], errors='coerce').fillna(0).to_numpy() != 1
    key = pd.DataFrame({
        'venue': df['venue_id'].astype(str).to_numpy(),
        'dow': pd.to_numeric(df['day_of_week'], errors='coerce').to_numpy(),
        'hour': pd.to_numeric(df['hour'], errors='coerce').to_numpy(),
    })
    weekly_slots = pd.MultiIndex.from_frame(key[weekly]).unique()
    has_row = pd.MultiIndex.from_frame(key).isin(weekly_slots)
    return has_row | (df['baseline_busyness'].to_numpy(dtype=float) > 0)


def add_baseline_features(df: pd.DataFrame, cat_maps: Dict = None,
                          baseline_grid: Dict = None) -> Tuple[pd.DataFrame, Dict]:
    """Add baseline busyness and data freshness features.

    cat_maps: category/refined baseline lookups. None means "fit them from this
    frame" (training); pass the training maps for holdout/eval so no held-out
    label ever reaches a feature. baseline_grid: the smoothing grid, None to fit
    it from this frame (see smooth_baseline_hours).

    Round 14, stated plainly rather than left for someone to rediscover: when
    cat_maps is None this fits the maps on `df` and applies them to `df`, so a
    city that train_model.py's GroupKFold later holds out has already
    contributed to the category cells its own rows are scored against. The
    correction is a per-fold refit and it belongs in the trainer, for the reason
    written above build_category_cell_aggregates — being constant within a fold is
    what makes it correct, and this script has no folds. The statistics that
    make that refit a one-pass subtraction travel in features_train.pkl.
    """
    # Baseline busyness — smoothed against the TRUE neighbouring hours.
    df['baseline_busyness'] = df['baseline_busyness'].fillna(0)
    if baseline_grid is None:
        df = smooth_baseline_hours(df)
    else:
        df = smooth_baseline_hours(df, baseline_grid)

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
    df['has_venue_baseline'] = (df['baseline_busyness'] > 0).astype(FLAG_DTYPE)

    # Data freshness — realtime observations are more reliable
    df['is_realtime'] = df['is_realtime'].fillna(0).astype(int)

    return df, cat_maps


def add_user_feedback_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add user feedback signals — crowd_level reports and prediction error."""
    df['avg_user_crowd'] = df['avg_user_crowd'].fillna(0)
    df['user_feedback_count'] = df['user_feedback_count'].fillna(0)
    df['log_user_feedback_count'] = np.log1p(df['user_feedback_count'])
    df['has_user_feedback'] = (df['user_feedback_count'] > 0).astype(FLAG_DTYPE)
    df['avg_prediction_error'] = df['avg_prediction_error'].fillna(0)
    return df


# ---------------------------------------------------------------------------
# THE EVENT-TYPE VOCABULARY, AND THE TWO WORDS THAT WERE WRITTEN OUTSIDE IT.
#
# The etype_* one-hots are built over exactly these five levels, and
# mlPredictor.buildFeatureMap emits exactly these five, so a nearest_event_type
# outside the list is a row the one-hot cannot describe: has_nearby_event = 1
# with all five etype slots at 0, a corner serving never produces.
#
# scripts/ml/eventService.js returned 'concert' for the Ticketmaster Music
# segment and 'film' for the Film segment from the day it was written until
# 2026-09-04 (commits d6c806e through 73c0374 carry the old function). That was
# harmless while it fed only `event_type`, which is not a feature. From
# 2026-09-01 collectRealtime.js wrote nearest_event_type from the same function,
# and 1,964 live-labelled realtime rows (philly 1,547, lehigh 417, observed
# 2026-09-01 to 09-04) carry 'concert' as a result. The 2026-09-04 fix stops
# new ones; nothing repairs the old.
#
# The aliases below are the OLD function's outputs mapped through the NEW one:
# Music -> 'concert' is Music -> 'music', and Film -> 'film' is Film -> 'other',
# because the fixed function has no film branch and the segment falls through.
# That is a reading of two versions of one function, not a guess about what a
# concert is. Anything else outside the vocabulary has no such reading and stops
# the run by name, so a new writer cannot land a sixth level as five zeros.
#
# The CSV carries the raw value. The exporter reports every value it sees and
# says which fall outside the vocabulary (eventTypeCensus), and this is where
# the two known ones are mapped; the raw corpus stays what was written.
# ---------------------------------------------------------------------------
EVENT_TYPE_VOCABULARY: List[str] = ['music', 'sports', 'arts', 'family', 'other']
LEGACY_EVENT_TYPE_ALIASES: Dict[str, str] = {'concert': 'music', 'film': 'other'}


def normalise_event_types(df: pd.DataFrame, label: str) -> Dict:
    """Map the two legacy values onto the vocabulary; refuse anything else.

    Idempotent, so add_event_features can call it on a frame main() already
    normalised without changing a row. Returns the counts for metadata.
    """
    raw, present, hit, out, unknown = normalise_event_type_rows(df)
    if len(unknown):
        refuse_event_types(label, {str(k): int(v) for k, v in unknown.value_counts().items()})
    return event_type_report(int(len(df)), int(present.sum()), int(hit.sum()),
                             {str(k): int(v) for k, v in raw[hit].value_counts().items()},
                             {str(k): int(v) for k, v in out[present].value_counts().items()}, label)


def normalise_event_type_rows(df: pd.DataFrame):
    """The row half of normalise_event_types: maps the column in place and returns
    (raw, present, hit, out, unknown), the values its report and refusal count."""
    raw = df['nearest_event_type'].astype('string').str.strip().str.lower()
    present = (raw.notna() & (raw != '')).fillna(False).to_numpy()
    aliased = raw.map(LEGACY_EVENT_TYPE_ALIASES)
    hit = (aliased.notna().to_numpy()) & present
    out = raw.where(~hit, aliased)
    in_vocab = out.isin(EVENT_TYPE_VOCABULARY).fillna(False).to_numpy()
    unknown = out[present & ~in_vocab]
    # Object dtype with NaN for the empty field, not the nullable string dtype:
    # the one-hot below compares with ==, and a <NA> there would poison the cast.
    df['nearest_event_type'] = np.where(present, out.astype(object), np.nan)
    return raw, present, hit, out, unknown


def refuse_event_types(label: str, counts: Dict) -> None:
    """counts: the out-of-vocabulary values and their row counts, largest first."""
    raise CorpusContractError(
        f'[{label}] nearest_event_type carries {len(counts)} value(s) outside the '
        f'vocabulary {EVENT_TYPE_VOCABULARY} that no alias covers: {counts}.\n'
        '  The etype_* one-hot cannot describe such a row: it would train as '
        'has_nearby_event = 1 with every etype slot at 0, a combination serving never '
        'produces. LEGACY_EVENT_TYPE_ALIASES maps the two values eventService.js used '
        'to write (concert, film) because both have an exact reading in the fixed '
        'function; a new value needs the writer fixed and its own reading added here, '
        'not a silent bucket.'
    )


def event_type_report(rows: int, rows_with_type: int, aliased_rows: int, aliased_counts: Dict,
                      levels_after: Dict, label: str) -> Dict:
    stats = {
        'rows': rows,
        'rows_with_type': rows_with_type,
        'legacy_values_aliased': aliased_counts,
        'levels_after': levels_after,
    }
    if aliased_counts:
        logger.warning('[%s] nearest_event_type: %d row(s) carried a legacy value and were '
                       'mapped onto the vocabulary %s: %s', label, aliased_rows,
                       LEGACY_EVENT_TYPE_ALIASES, aliased_counts)
    return stats


def add_event_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add Ticketmaster event proximity features."""
    normalise_event_types(df, 'features')
    # Core event features — fill missing with 0
    df['has_nearby_event'] = df['has_nearby_event'].fillna(0).astype(int)
    df['nearest_event_attendance'] = df['nearest_event_attendance'].fillna(0)
    df['log_nearest_event_attendance'] = np.log1p(df['nearest_event_attendance'])
    df['total_nearby_events'] = df['total_nearby_events'].fillna(0)
    df['total_nearby_attendance'] = df['total_nearby_attendance'].fillna(0)
    df['log_total_nearby_attendance'] = np.log1p(df['total_nearby_attendance'])
    df['nearest_event_distance_km'] = df['nearest_event_distance_km'].fillna(0)

    # Large event flag
    df['large_event_nearby'] = (df['nearest_event_attendance'] > 5000).astype(FLAG_DTYPE)

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

    # Event type one-hot encoding, over the vocabulary and nothing else:
    # normalise_event_types above has already refused any other value.
    types = df['nearest_event_type'].astype(object)
    for etype in EVENT_TYPE_VOCABULARY:
        df[f'etype_{etype}'] = (types == etype).astype(FLAG_DTYPE)

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
        # 2026-09-25: how many consecutive hours the row's live value sat
        # unchanged, counted over the row's own label and its neighbours'. A
        # function of the labels, and absent at serving: a weight, never a feature.
        'live_run_length',
        'lat_band', 'temp_norm', 'neighbor_count',  # v2.4 intermediates (log_neighbor_count is the feature)
        # Round 26 CARRIED COLUMN. Whether the row's weather is a reading or the
        # outage vector. As a feature it would be a perfect proxy for weekly
        # versus realtime, i.e. the label regime, which is why sample_weight
        # and label_provenance are excluded; the marker the model may see is
        # weather_unknown, which serving emits on an outage too.
        'weather_observed',
        'observed_date',  # raw date string — v2.5 holiday features are derived from it
        # Round 10 additions:
        'venue_id',  # identifier — a feature here is pure venue memorization
        'label_provenance',  # raw string; encodes label regime like sample_weight
        # Round 20 CARRIED COLUMNS — exported, validated, pickled, never fed to
        # the model. label_source is the raw form of label_provenance and is
        # excluded for the same reason (it encodes the label regime). And
        # vendor_forecast_pct must not become a feature by accident: it is NULL
        # on 100% of the corpus today (a dead slot, or a lie if filled with 0)
        # and it EQUALS busyness_pct on every forecast-sourced row, so on the day
        # it does carry data a raw feature would be handing the model the label.
        # See the block above derive_label_provenance.
        'label_source',
        'vendor_forecast_pct',
        # Round 25 CARRIED COLUMN. events_observed records whether the event
        # columns on a row are a measurement or migration 006's defaults. A
        # feature here would be strictly worse than useless: it is EMPTY on all
        # 3,912,357 pre-045 rows, so it is a dead slot today, and on the day it
        # carries data it would be a proxy for WHICH CITIES had Ticketmaster
        # coverage. 22 of 34 cities hold zero event-positive rows, which is
        # geography laundered through a data-collection artefact, the same
        # class of leak latitude and longitude are dropped for.
        'events_observed',
        # 2026-09-25 CARRIED COLUMN, no longer a feature (PRE-RETRAIN-AUDIT
        # finding 18). Serving sets it to 1 on every prediction, so all it can
        # tell the model is a training row's label regime. See realtime_flags.
        'is_realtime',
        # 2026-09-26 CARRIED COLUMNS (migration 094): what BestTime's live
        # answer said about itself. Stored for analysis, not features: serving
        # scores hours no live call has been made for, so it could never
        # reproduce them (RETRAIN.md, the mid-October plan, Labels 3).
        'live_hour_start', 'live_venue_open', 'live_local_time',
    }
    # The sports game-night family. It was ABLATION-ONLY until mlPredictor.js
    # computed it at serving time (code review, 2026-09-01). Since 2026-09-26
    # serving does (mlPredictor.sportsFeatureValues over ml_sports_events,
    # __tests__/mlSportsParity.test.js), so it is a feature whenever the
    # schedule export is present: sports_features_enabled() below.
    if not sports_features_enabled():
        exclude |= set(SPORTS_FEATURE_NAMES)
    exclude |= DROPPED_FEATURES
    feature_cols = [c for c in df.columns if c not in exclude]
    return sorted(feature_cols)


# WHAT A BUILT FRAME KEEPS (2026-11-19). Once a frame's last feature is built,
# what follows reads its feature columns (into X, the NaN refusal and the
# constant-slot check) and, by name, only the columns below: the cell fits, the
# label and weight steps, and the keys both pickles carry. Everything else is
# spent: the raw strings the one-hot families were built from (three Google
# types, weather, season, event types), coordinates and intermediates. A
# whole-number feature column is only ever read as a float32 in X, so it is held
# in the smallest integer type that holds its values: the 0/1 one-hot columns
# take a byte a row, not eight. On the 2026-10-08 export this, with
# feature_matrix, took the script's peak from 8.1 GB to 5.1 GB, and both pickles
# are byte-identical to the previous code's. The strings, most of what is
# dropped, each sit in their own block and are freed at once; a dropped or
# narrowed number that shares a block with a kept column can stay allocated
# until the frame is next copied (drop() itself copies a block whose kept
# columns are not one run; the training frame is copied at the serving-population
# filter, the holdout whenever a row is excluded). A step added later that reads
# a dropped column by name stops with a KeyError; name the column here.
CARRIED_AFTER_FEATURES = frozenset(_CELL_FIT_COLS + [
    LEAVE_OUT_COL, 'baseline_busyness', 'is_realtime', 'label_provenance', 'label_source',
    'vendor_forecast_pct', 'events_observed', 'observed_date', 'weather_observed', 'venue_id',
])


def _plain_numeric(dtypes) -> bool:
    """Every dtype a NumPy signed integer or float64: what this script's features are."""
    return all(isinstance(d, np.dtype) and (d.kind == 'i' or d == np.float64) for d in dtypes)


def finish_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Drop the columns no later step reads and narrow whole-number features."""
    features = get_feature_columns(df)
    spent = [c for c in df.columns if c not in set(features) and c not in CARRIED_AFTER_FEATURES]
    df = df.drop(columns=spent)
    if _plain_numeric([df[c].dtype for c in features]):
        for c in features:
            if c not in CARRIED_AFTER_FEATURES and df[c].dtype == np.int64:
                df[c] = pd.to_numeric(df[c], downcast='integer')
    return df


def feature_matrix(df: pd.DataFrame, feature_cols: List[str], out: np.ndarray = None) -> np.ndarray:
    """`df[feature_cols].values.astype(np.float32)`, filled one column at a time.

    The one-line form first interleaves every column into one matrix of their
    common type (float64 whenever a float column is present) twice the size of
    the result. Each column takes the same route here: through float64 when the
    selection holds a float column, else through int64 (narrowing never changes
    which), so the values and the column-major layout are the same. Any other
    mix (bool, nullable, unsigned or narrower float columns) takes the one-line
    form itself, and finish_frame leaves such a frame's integers unnarrowed.

    `out`, when given, is a float32 (len(df), len(feature_cols)) array to fill
    instead (the streamed preparation passes rows of the memory-mapped X).
    """
    dtypes = [df[c].dtype for c in feature_cols]
    if not dtypes or not _plain_numeric(dtypes):
        if out is None:
            return df[feature_cols].values.astype(np.float32)
        out[:] = df[feature_cols].values.astype(np.float32)
        return out
    via = np.float64 if any(d.kind == 'f' for d in dtypes) else np.int64
    X = np.empty((len(df), len(feature_cols)), dtype=np.float32, order='F') if out is None else out
    for j, c in enumerate(feature_cols):
        X[:, j] = df[c].to_numpy(dtype=via)
    return X


def refuse_unfilled_features(df: pd.DataFrame, feature_cols: List[str], label: str) -> None:
    """A NaN in a feature column at this point is a fill somebody forgot.

    This replaces the blanket zero fill over the feature columns, which ran
    last and caught whatever every other fill had missed. It caught nothing on the last run
    (prep3.log: "No missing values in features!"), and that is the only state
    in which it is safe, because 0 is not a neutral value for any column in this
    matrix: 0F, 0% humidity, a venue with no reviews, a category encoded as the
    first one in the map. Each feature now has its own named fill with its own
    argument, and the one that arrives here without one stops the run and is
    named, rather than being trained as a measurement of nothing.
    """
    refuse_missing_feature_values(df[feature_cols].isna().sum(), label)


def refuse_missing_feature_values(missing: pd.Series, label: str) -> None:
    """refuse_unfilled_features given the NaN count of each feature column."""
    missing = missing[missing > 0]
    if len(missing):
        detail = {str(k): int(v) for k, v in missing.items()}
        raise CorpusContractError(
            f'[{label}] {len(missing)} feature column(s) still carry NaN after every named '
            f'fill: {detail}.\n'
            '  There is no blanket fillna(0) any more. Find the feature\'s own fill (or '
            'write one, with the argument for its value) rather than restoring a zero '
            'that would train as a measurement.'
        )
    logger.info('[%s] every feature column is fully populated by its own named fill.', label)


# ---------------------------------------------------------------------------
# THE STEPS BOTH PREPARATIONS SHARE (2026-11-25). main() holds the training
# export in one frame; main_streamed() (below main) holds it a slice at a time.
# Everything that does not depend on which, from the holdout's whole treatment
# to the metadata record, is one function called from both.
# ---------------------------------------------------------------------------
def read_holdout_csv() -> Tuple[Path, pd.DataFrame]:
    """holdout_data.csv, read whole and contract-checked: the holdout is a few
    hundred thousand rows in either preparation."""
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
    require_coordinates(holdout_df, holdout_path, 'holdout_data.csv')
    return holdout_path, holdout_df


def log_raw_tables(neighbor_table: Dict, live_reading_table: Dict) -> None:
    logger.info('Neighbour table: %d venues, %d with a weekly curve (serving arithmetic, '
                'box +/-%s degrees around toFixed(3) coordinates).',
                neighbor_table['venues'], neighbor_table['venues_with_curve'], NEIGHBOR_BOX_DEG)
    logger.info('Live reading table: %d readings over %d venues (label_source live, a '
                'positive curve at the reading\'s own slot).',
                live_reading_table['readings'], live_reading_table['venues'])


def enforce_weather_contracts(weather_stats: Dict, holdout_weather_stats: Dict) -> None:
    """The weather contract on both frames' recovery stats, unmapped counts summed."""
    combined_unmapped = dict(weather_stats['unmapped_descriptions'])
    for k, v in holdout_weather_stats['unmapped_descriptions'].items():
        combined_unmapped[k] = combined_unmapped.get(k, 0) + v
    enforce_weather_contract({**weather_stats, 'unmapped_descriptions': combined_unmapped})


def enforce_calendar_contracts(calendar_stats: Dict, holdout_calendar_stats: Dict) -> None:
    enforce_calendar_contract({
        'rows': calendar_stats['rows'] + holdout_calendar_stats['rows'],
        'rows_without_month': (calendar_stats['rows_without_month']
                               + holdout_calendar_stats['rows_without_month']),
        'rows_without_season': (calendar_stats['rows_without_season']
                                + holdout_calendar_stats['rows_without_season']),
        'pct_without_month': calendar_stats['pct_without_month'],
    })


def enforce_label_contracts(label_stats: Dict, holdout_label_stats: Dict) -> None:
    enforce_label_contract(label_stats, 'train')
    enforce_label_contract(holdout_label_stats, 'holdout')


def event_type_record(train_stats: Dict, holdout_stats: Dict) -> Dict:
    return {
        'train': train_stats,
        'holdout': holdout_stats,
        'vocabulary': list(EVENT_TYPE_VOCABULARY),
        'legacy_aliases': dict(LEGACY_EVENT_TYPE_ALIASES),
    }


def fold_holdout_into_refit(final_refit: Dict, holdout_df: pd.DataFrame) -> None:
    """Record (and say) which holdout cities a final refit trains on."""
    # Everything trains: the holdout cities join the training frame and no
    # live day is held back (the block above resolve_final_refit).
    if holdout_df is None or len(holdout_df) == 0:
        raise CorpusContractError(f'{FINAL_REFIT_ENV}: the export has no holdout cities to fold in.')
    final_refit['holdout_city_rows_folded_in'] = int(len(holdout_df))
    final_refit['holdout_cities_folded_in'] = sorted(holdout_df['city'].astype(str).unique().tolist())
    logger.warning('FINAL REFIT of %s: %d holdout-city rows %s folded into training, time holdout off. '
                   'Do not run quick_eval.py on this artifact; run final_refit_gate.py.',
                   final_refit['gated_metadata_path'], final_refit['holdout_city_rows_folded_in'],
                   final_refit['holdout_cities_folded_in'])


def log_time_holdout(time_holdout: Dict) -> None:
    logger.info('Time holdout (%s): live readings from %s on are held out of training for the '
                'band gate: %d realtime rows (%d live) %s; training live data runs through %s.',
                time_holdout['policy'], time_holdout['from_date'], time_holdout['realtime_rows_held_out'],
                time_holdout['live_rows_held_out'], time_holdout['held_out_by_city'],
                time_holdout['training_live_through'])


ALWAYS_ZERO_KEYS = ['city', 'venue_category', 'latitude', 'longitude']


def drop_always_zero_venues(train_df: pd.DataFrame, always_zero) -> pd.DataFrame:
    """Drop the rows of the (city, venue_category, latitude, longitude) keys in
    `always_zero`; a key that is not in the frame is ignored."""
    train_df = train_df.set_index(ALWAYS_ZERO_KEYS)
    train_df = train_df.drop(always_zero, errors='ignore')
    return train_df.reset_index()


def add_training_features(train_df: pd.DataFrame, neighbor_table: Dict, live_reading_table: Dict,
                          fits: Dict) -> pd.DataFrame:
    """Every feature step of the training frame, in order.

    `fits` holds the tables fitted on the whole training frame: venue_metadata,
    temp_norms and cat_maps, and the streamed preparation's baseline_grid. A
    missing one is fitted here, from `train_df`, and stored back, which is what
    main() does with the whole frame; main_streamed() fits them all first and
    hands each slice of rows the same tables.
    """
    train_df = add_temporal_features(train_df)
    train_df, venue_metadata = add_venue_features(train_df, fits.get('venue_metadata'))
    # Round 26: the climate table is fitted ONCE, from the training rows that
    # carry a reading, and handed to every weather step on both frames. It is
    # the table serving imputes from, so it is fitted before anything is filled.
    temp_norms = fits.get('temp_norms')
    if temp_norms is None:
        temp_norms = fit_temperature_norms(train_df)
    train_df = add_weather_features(train_df, temp_norms)
    train_df, cat_maps = add_baseline_features(train_df, fits.get('cat_maps'), fits.get('baseline_grid'))
    fits.update(venue_metadata=venue_metadata, temp_norms=temp_norms, cat_maps=cat_maps)
    train_df = add_user_feedback_features(train_df)
    train_df = add_event_features(train_df)
    # v2.4 features (sunset/anomaly/neighbors) — see function docstrings
    train_df = add_astronomy_features(train_df)
    train_df, _ = add_climate_anomaly(train_df, temp_norms)
    train_df = add_neighbor_features(train_df, neighbor_table)
    # 2026-09-26: the venue's own earlier readings (the block above add_live_features)
    train_df = add_live_features(train_df, live_reading_table, neighbor_table)
    # v2.5: special-night calendar features from observed_date
    train_df = add_holiday_features(train_df)
    # 2026-08-30: game-night context, zeros unless sports_events.csv exists
    train_df = add_sports_features(train_df)
    return train_df


def add_temp_norm_metadata(venue_metadata: Dict, temp_norms: pd.DataFrame) -> None:
    venue_metadata['temp_norms'] = {
        f"{int(r.lat_band)}_{int(r.month)}": round(float(r.temp_norm), 2)
        for r in temp_norms.itertuples() if not pd.isna(r.month)
    }
    # The row count behind each cell, so serving can one day tell a norm built
    # from thousands of readings from one built from a handful (the question
    # mlPredictor.monthClimateNorm says it cannot ask of the shipped table).
    venue_metadata['temp_norm_counts'] = {
        f"{int(r.lat_band)}_{int(r.month)}": int(r.n_obs)
        for r in temp_norms.itertuples() if not pd.isna(r.month)
    }


def weather_imputation_record(temp_norms: pd.DataFrame, rows_with_reading: int, rows_imputed: int) -> Dict:
    return {
        'temperature': ('temp_norms[(lat_band, month)], else the mean of that table: the '
                        'lookup mlPredictor.climateNorm performs for a missing reading'),
        'no_reading_fills': dict(WEATHER_NO_READING_FILLS),
        'norms_fit_population': 'rows carrying a temperature reading (weather_observed = 1)',
        'norms_fit_rows': int(temp_norms['n_obs'].sum()),
        'norms_cells': int(len(temp_norms)),
        'train_rows_with_reading': rows_with_reading,
        'train_rows_imputed': rows_imputed,
    }


def featurise_holdout(holdout_df: pd.DataFrame, venue_metadata: Dict, temp_norms: pd.DataFrame,
                      cat_baseline_maps: Dict, neighbor_table: Dict, live_reading_table: Dict,
                      weather_imputation: Dict) -> pd.DataFrame:
    """The holdout's features, every one from the TRAINING frame's fits, finished
    and with its delta label. Adds the holdout's weather counts to weather_imputation."""
    holdout_df = holdout_df.dropna(subset=['busyness_pct'])
    holdout_df = add_temporal_features(holdout_df)

    # Apply same category encoding
    cat_map = venue_metadata['category_encoding']
    holdout_df['venue_category_encoded'] = holdout_df['venue_category'].map(cat_map).fillna(-1).astype(int)
    holdout_df['price_level'] = holdout_df['price_level'].fillna(venue_metadata['median_price_level'])
    holdout_df['rating'] = holdout_df['rating'].fillna(venue_metadata['median_rating'])
    # The STORED median, not one recomputed from the holdout's own rows —
    # recomputing is how a fill becomes a leak. Same rule the line above it
    # has always followed; review_count was filled with a literal 0 here.
    holdout_df['review_count'] = holdout_df['review_count'].fillna(venue_metadata['median_review_count'])
    holdout_df['log_review_count'] = np.log1p(holdout_df['review_count'])

    # Google types one-hot
    top_types = venue_metadata['top_google_types']
    for t in top_types:
        col_name = f'gtype_{t}'
        holdout_df[col_name] = np.zeros(len(holdout_df), dtype=FLAG_DTYPE)
        for tc in ['google_type_1', 'google_type_2', 'google_type_3']:
            holdout_df.loc[holdout_df[tc] == t, col_name] = 1

    # TRAIN norms: a holdout reading never shapes a holdout feature, and the
    # city-month median this used to fit on the holdout's own rows is gone.
    holdout_df = add_weather_features(holdout_df, temp_norms)
    weather_imputation['holdout_rows_with_reading'] = int((holdout_df['weather_observed'] == 1).sum())
    weather_imputation['holdout_rows_imputed'] = int((holdout_df['weather_observed'] == 0).sum())
    # TRAIN maps — holdout labels must never build holdout features (round 10)
    holdout_df, _ = add_baseline_features(holdout_df, cat_maps=cat_baseline_maps)
    holdout_df = add_user_feedback_features(holdout_df)
    holdout_df = add_event_features(holdout_df)
    holdout_df = add_astronomy_features(holdout_df)
    holdout_df, _ = add_climate_anomaly(holdout_df, norms=temp_norms)  # TRAIN norms — no holdout leakage
    holdout_df = add_neighbor_features(holdout_df, neighbor_table)
    holdout_df = add_live_features(holdout_df, live_reading_table, neighbor_table)
    holdout_df = add_holiday_features(holdout_df)
    holdout_df = add_sports_features(holdout_df)
    holdout_df = finish_frame(holdout_df)

    # The delta label, as the training frame's (main(), above the v2.3 fix).
    holdout_df['baseline_busyness'] = holdout_df['baseline_busyness'].fillna(0)
    holdout_df['delta_label'] = (holdout_df['busyness_pct'] - holdout_df['baseline_busyness']).astype(float)
    return holdout_df


def log_weight_blend(train_df: pd.DataFrame, before_filter: int, weekly_weight_policy: Dict) -> int:
    """The v2.3.1 blend line. `train_df` needs is_realtime, label_provenance and
    sample_weight. Returns the realtime row count."""
    is_forecast_label = (train_df['is_realtime'] == 1) & (train_df['label_provenance'] == 'forecast')
    is_owner_label = (train_df['is_realtime'] == 1) & (train_df['label_provenance'] == 'owner_report')
    n_rt = int((train_df['is_realtime'] == 1).sum())
    n_fc = int(is_forecast_label.sum())
    n_ow = int(is_owner_label.sum())
    weekly_weight = weekly_weight_policy['weight']
    total_w = float(train_df['sample_weight'].sum())
    rt_w = float(train_df.loc[train_df['is_realtime'] == 1, 'sample_weight'].sum())
    rl = weekly_weight_policy['live_run_length']
    logger.info(
        f'v2.3.1 blend: {before_filter} -> {len(train_df)} rows with baseline>0 '
        f'({n_rt} realtime of which {n_fc} vendor-forecast @ weight 0.3 and '
        f'{n_ow} owner-report @ weight {OWNER_LABEL_WEIGHT}, '
        f'{len(train_df) - n_rt} weekly @ weight {weekly_weight:.6g} ({weekly_weight_policy["policy"]}); '
        f'run-length weights {rl["policy"]}: {rl["live_rows"]} live rows weigh {rl["live_weight_after"]} '
        f'(runs {rl["live_rows_by_run_length"]}); '
        f'effective realtime share of loss: {rt_w / total_w * 100:.0f}%)'
    )
    return n_rt


def check_realtime_labels(train_df: pd.DataFrame, n_rt: int, unknown_train: Dict) -> None:
    """What may train at the live weight, checked on the weighted frame (which
    needs is_realtime and label_provenance)."""
    known_prov = sorted(train_df['label_provenance'].dropna().unique().tolist())
    logger.info(f'label_provenance levels present: {known_prov}')
    # ON THE REALTIME ROWS, because those are the only rows the weighting ladder
    # can act on and the only rows the check is about.
    #
    # This tested the WHOLE frame against exactly ['unknown'], and weekly rows
    # are stamped 'weekly' by derive_label_provenance, so the list is at minimum
    # ['unknown', 'weekly'] on any real corpus and the raise beneath it could
    # never execute. The last run proves it: prep3.log records
    # "369076 realtime of which 0 vendor-forecast @ weight 0.3" beside
    # "label_provenance levels present: ['unknown', 'weekly']". Zero of 369,076
    # weight-1.0 rows were downweighted, and an unknown share of them are
    # BestTime's own forecast rather than a live reading, because the collector
    # fell back to the forecast when live traffic was unavailable and migration
    # 025 records that the two are indistinguishable after the fact. The one
    # check written to make that impossible to overlook was looking at the wrong
    # population.
    rt_prov = sorted(
        train_df.loc[train_df['is_realtime'] == 1, 'label_provenance']
        .dropna().unique().tolist()
    )
    logger.info(f'label_provenance levels on realtime rows: {rt_prov}')
    # Round 26: the old check here raised only when EVERY realtime row was
    # 'unknown', which stopped being true on 2026-09-01 and left 457,402
    # unprovable rows at the live weight beside 4,577 proven ones with nothing
    # said. exclude_unknown_provenance above now decides row by row; what is
    # left to check is that a row with 'unknown' can only be here by admission.
    if 'unknown' in rt_prov and not unknown_provenance_admitted():
        raise CorpusContractError(
            'label_provenance="unknown" survived exclusion on a realtime row without '
            f'{UNKNOWN_PROVENANCE_ENV}=true. That cannot happen unless '
            'exclude_unknown_provenance was bypassed; do not weaken it.'
        )
    if n_rt < MIN_REALTIME_ROWS:
        raise ValueError(
            f'Only {n_rt} realtime rows — expected {MIN_REALTIME_ROWS}+. '
            f'{unknown_train["rows_excluded"]} realtime row(s) were excluded because their '
            'label_provenance is "unknown" (collected before label_source existed; not '
            'separable from a vendor forecast, migration 025). The floor is the corpus '
            'saying it does not yet hold enough PROVEN live labels to train on. Either '
            f'wait for collectRealtime.js to write more, or set {UNKNOWN_PROVENANCE_ENV}=true '
            'to admit the unprovable rows at the live weight, knowing what they contain.'
        )


def align_holdout(holdout_df: pd.DataFrame, feature_cols: List[str]) -> pd.DataFrame:
    """The holdout cut to the training feature columns and the carried ones."""
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
    # Round 20: label_source and vendor_forecast_pct ride along too, so the
    # vendor-distance question becomes answerable from the pickles the moment
    # there is data, without another two-hour export. They are NOT in
    # feature_cols, so the fillna(0) below cannot reach them and an absent
    # forecast stays NaN rather than becoming a vendor prediction of 0.
    # Round 25: events_observed rides along too, so the question "how much of
    # this holdout's event signal was ever measured" is answerable from the
    # pickles rather than from another two-hour export.
    # observed_date rides along for GATE-B's date-block bootstrap. The dump
    # below has read it since 2026-08-28, but this keep list never carried it,
    # so the first real run after the gate was armed crashed at the dump: the
    # arming edit was never executed until 2026-08-30. A carried column, not a
    # feature, same as the others here.
    # Round 26: weather_observed rides along too, on the same terms as
    # events_observed: which holdout rows carry a reading and which carry the
    # outage vector is a fact the pickle has to keep.
    keep_extra = ['busyness_pct', 'delta_label', 'baseline_busyness', 'city',
                  'label_provenance', 'venue_category',
                  'label_source', 'vendor_forecast_pct', 'events_observed',
                  'observed_date', 'weather_observed',
                  # no longer a feature (realtime_flags), so it must be kept by name
                  'is_realtime']
    return holdout_df[feature_cols + keep_extra]


def category_baseline_fit_record(cell_stats: Dict) -> Dict:
    """Where the two category label-means were fitted and applied, for metadata."""
    category_baseline_fit = {
        'training_rows_fit': 'whole training frame (build_category_baseline_maps)',
        'training_rows_applied': 'whole training frame',
        'holdout_rows': 'training-frame maps, applied only — no holdout label reaches '
                        'a holdout feature',
        'serving_map': 'training-frame maps, shipped as metadata.category_baselines / '
                       'refined_baselines',
        'residual_leak': (
            'OPEN IN THIS FILE, BY NECESSITY, AND CLOSED WHERE IT MATTERS. This script '
            'fits both maps on the frame it applies them to, and it cannot do '
            'otherwise: being constant within a fold is what makes the correction '
            'honest, and this script has no folds. What that leaks is the REPORTED '
            'cross-validation number in train_model.py, which holds out one city per '
            'GroupKFold fold — and train_model.py now rebuilds both maps from each '
            'fold\'s own training groups using the aggregates below, so that number is '
            'no longer optimistic. See model_metadata.training_contracts.'
            'category_baselines_refit_per_fold. The ship gate never had this leak: it '
            'is measured on the separate holdout cities, which contribute to nothing. '
            'Measured on a synthetic 10-city fixture over three draws, the uncorrected '
            'leak understates the reported MAE by 0.21-0.42 and overstates within-10 '
            'by 1.4-2.1 points. The leave-one-city-out-computed-once formulation that '
            'looks like the cheap fix understates by 1.52-3.05 MAE and 10.4-20.5 '
            'points of within-10 — five to seven times worse — and must not be used.'),
        'per_fold_inputs_shipped': True,
        'per_fold_inputs': ('features_train.pkl -> category_cell_stats; see '
                            'prepare_features.build_category_cell_aggregates'),
        'per_fold_inputs_version': cell_stats['version'],
        'per_fold_inputs_fit_population': cell_stats['fit_population'],
        'per_fold_inputs_fit_rows': cell_stats['fit_rows'],
        'per_fold_inputs_indexed_rows': cell_stats['rows'],
        'group_col': cell_stats['group_col'],
        'groups': len(cell_stats['groups']),
        'category_cells': len(cell_stats['category']['cells']),
        'refined_cells': len(cell_stats['refined']['cells']),
    }
    logger.info(
        'category_baseline / refined_category_baseline are fitted on the whole '
        'pre-filter training frame and applied to it; train_model.py rebuilds both '
        'per fold from features_train.pkl["category_cell_stats"] (v%d, fitted on %d '
        'pre-filter rows, indexed onto %d matrix rows): %d category cells and %d '
        'refined cells across %d %s groups. Holding out no group reproduces the '
        'shipped columns exactly, which is what the trainer asserts.',
        cell_stats['version'], cell_stats['fit_rows'], cell_stats['rows'],
        len(cell_stats['category']['cells']), len(cell_stats['refined']['cells']),
        len(cell_stats['groups']), cell_stats['group_col'])
    return category_baseline_fit


def train_pickle_columns(train_df: pd.DataFrame) -> Dict:
    """The per-row keys of features_train.pkl, from the finished, filtered,
    weighted training frame (or a slice of its rows)."""
    return {
        'y': train_df['delta_label'].values.astype(np.float32),
        'y_actual': train_df['busyness_pct'].values.astype(np.float32),
        'baseline': train_df['baseline_busyness'].values.astype(np.float32),
        'cities': train_df['city'].values,
        'hour': train_df['hour'].values.astype(np.int16),
        'venue_category': train_df['venue_category'].astype(str).values,
        'label_provenance': train_df['label_provenance'].astype(str).values,
        # Round 20 carried columns. float32 with NaN PRESERVED — a row with no
        # vendor forecast must stay unmeasurable rather than become a 0 that
        # would read as "the vendor predicted an empty venue".
        'label_source': train_df['label_source'].astype('string').fillna('').values.astype(str),
        'vendor_forecast_pct': pd.to_numeric(
            train_df['vendor_forecast_pct'], errors='coerce').values.astype(np.float32),
        # 2026-08-30: dates ride the TRAIN pickle too. The sports ablation
        # needs a forward-in-time split evaluated on PA rows, because the
        # geographic holdout (miami, tokyo, barcelona) is exactly where the
        # market-gated sports features are all zero by design; the holdout
        # has carried this key since GATE-B for the same class of reason.
        'observed_date': train_df['observed_date'].astype('string').fillna('').values.astype(str),
        # Round 26 carried columns. weather_observed: 1 where the six weather
        # slots are a reading, 0 where they are the outage vector. is_realtime
        # is the ONLY copy of that flag since 2026-09-25: PRE-RETRAIN-AUDIT finding 18
        # named it a provenance feature kept for itself, hardcoded to 1 at
        # serving, so it left feature_cols and every reader takes it from here
        # through realtime_flags.
        'weather_observed': train_df['weather_observed'].values.astype(np.int8),
        'is_realtime': train_df['is_realtime'].values.astype(np.int8),
    }


def train_pickle_dict(cols: Dict, x_entry: Dict, sample_weight: np.ndarray, run_divisor: np.ndarray,
                      feature_cols: List[str], cell_stats: Dict) -> Dict:
    """features_train.pkl: x_entry is {'X': matrix}, or the three keys that name
    the matrix's .npy file (features_io.finish_x)."""
    return {
        **x_entry,
        # y = delta label (training target). y_actual + baseline kept for evaluation/reconstruction.
        'y': cols['y'],
        'y_actual': cols['y_actual'],
        'baseline': cols['baseline'],
        'sample_weight': sample_weight.astype(np.float32),
        # What each row's tier weight was divided by: its live run length under
        # FLOCK_RUN_LENGTH_WEIGHTS=on, else 1. train_model checks weight x this.
        'run_length_divisor': run_divisor.astype(np.int16),
        'feature_cols': feature_cols,
        'cities': cols['cities'],
        'hour': cols['hour'],
        'venue_category': cols['venue_category'],
        'label_provenance': cols['label_provenance'],
        'label_source': cols['label_source'],
        'vendor_forecast_pct': cols['vendor_forecast_pct'],
        'label_type': 'delta',
        'observed_date': cols['observed_date'],
        # Round 14: raw material for a per-fold refit of the two category
        # label-means. Not features, not applied to any row here.
        'category_cell_stats': cell_stats,
        'weather_observed': cols['weather_observed'],
        'is_realtime': cols['is_realtime'],
        # 2026-11-27: what check_label_trust found, bound to this pickle so a
        # loader can refuse one that never met it (features_io.require_label_trust).
        features_io.LABEL_TRUST_KEY: features_io.label_trust_stamp(LABEL_TRUST),
    }


# ---------------------------------------------------------------------------
# MASKED COPIES OF THE REALTIME ROWS (2026-11-27): FLOCK_LIVE_MASK_COPIES=on.
#
# Four of the five live features are built from the venue's past live
# readings. With no reading, serving sends their missing values
# (mlPredictor.LIVE_FEATURE_DEFAULTS: last_live_dev 0, last_live_age_h
# LIVE_MISSING_AGE_H, recent_offset 0, recent_offset_n 0); with a newest
# reading older than NOWCAST_MAX_LAG_HOURS but still inside the offset window,
# it sends the first two missing and the offset. 2.8.0-starling trained on
# almost none of either state: 98.4% of its 1,481,472 realtime training rows
# had a reading or an offset. The live feed stopped on 2026-11-25, and those
# are the states production has served in since.
#
# With the switch on, the training matrix gains copies of its realtime rows
# (is_realtime == 1) in those two states:
#
#   copy B, "offset only" (code 1)  last_live_dev 0 and last_live_age_h
#       LIVE_MISSING_AGE_H, the offset kept. Made only for a row with BOTH a
#       reading (last_live_age_h != LIVE_MISSING_AGE_H) and an offset
#       (recent_offset_n > 0): with no offset it would be copy C, and with no
#       reading it would be the row itself.
#   copy C, "no reading" (code 2)   all four at their missing values. Made
#       only for a row with a reading OR an offset: a row with neither already
#       is this row.
#
# curve_prev_hour is the curve, not a reading, and is never touched. Every
# other per-row value is the source row's: label, baseline, y_actual, sample
# weight, run-length divisor, city, date. The order is every original row,
# then every copy B, then every copy C, each in source-row order, and
# `masked_copy` (int8, one per row) carries the code, 0 for an original row.
#
# THE WEIGHTS ARE THE SOURCE ROWS', so the realtime share of the loss rises
# above the share sample_weight_policy solved on the original rows. The record
# written to corpus_contract.live_mask_copies carries the share the matrix
# trains with (realtime_loss_share), beside the two copy counts.
#
# WHAT A READER MUST KNOW. A copy is one more row of its source's city and
# category cell. category_cell_stats grows with it (row_group, row_cell, and
# rows_sums / rows_counts recounted over the grown rows), while the fitted sums
# and counts stay the pre-filter frame's: a cell may now hold more matrix rows
# than the frame it was fitted on, and train_model.py holds only the ORIGINAL
# rows to that subset rule. It also checks every copy against its source row
# (assert_masked_copies there) and keeps every metric it has always reported
# on original rows, with the two copy populations reported beside them.
# training_rows in model_metadata.json stays the count of original rows.
#
# OFF WRITES NOTHING NEW: no masked_copy key, no record. A pickle or metadata
# without them was prepared with the switch off, which is every one written
# before the switch existed; masked_copy_flags reads such a pickle as all
# original rows, and final_refit_gate.py reads a missing record as 'off'.
#
# Two refusals (require_live_mask_copies_possible). FLOCK_LIVE_FEATURES=off
# removes the columns the copies mask. And the streamed preparation sizes and
# writes X to its .npy before the copies could be counted, so the switch is
# implemented for the in-memory preparation only. The holdout pickle never
# gets copies. test_live_mask_copies.py pins all of the above.
# ---------------------------------------------------------------------------
MASKED_COPY_KEY = 'masked_copy'
MASKED_COPY_CODES = {'original': 0, 'offset_only': 1, 'no_reading': 2}
# The live features built from readings; curve_prev_hour is the fifth and is
# the curve.
LIVE_READING_FEATURES = ('last_live_dev', 'last_live_age_h', 'recent_offset', 'recent_offset_n')
# train_pickle_dict's keys, by whether they hold one value per row. A key added
# there must be named in one of these, or append_live_mask_copies stops: a
# per-row key it did not grow would pair every copy with nothing.
TRAIN_PICKLE_ROW_KEYS = ('X', 'y', 'y_actual', 'baseline', 'sample_weight', 'run_length_divisor',
                         'cities', 'hour', 'venue_category', 'label_provenance', 'label_source',
                         'vendor_forecast_pct', 'observed_date', 'weather_observed', 'is_realtime')
TRAIN_PICKLE_FRAME_KEYS = ('feature_cols', 'label_type', 'category_cell_stats', features_io.LABEL_TRUST_KEY)


def require_live_mask_copies_possible(streamed: bool = False) -> None:
    """FLOCK_LIVE_MASK_COPIES=on needs the columns it masks and the in-memory preparation."""
    if LIVE_MASK_COPIES_POLICY != 'on':
        return
    if LIVE_FEATURE_POLICY == 'off':
        raise CorpusContractError(
            f'{LIVE_MASK_COPIES_ENV}=on with FLOCK_LIVE_FEATURES=off: the masked copies set '
            f'{", ".join(LIVE_READING_FEATURES)} to their missing values, and '
            'FLOCK_LIVE_FEATURES=off drops those columns. Unset one of the two.')
    if streamed:
        raise CorpusContractError(
            f'{LIVE_MASK_COPIES_ENV}=on is implemented for the in-memory preparation only, and '
            'this export is being prepared in the streamed mode (FLOCK_PREP_STREAM, or more than '
            'FLOCK_PREP_STREAM_MIN_ROWS training rows): the streamed mode sizes X and writes it '
            'to features_train.X.npy before the copies could be counted. Prepare in memory '
            f'(FLOCK_PREP_STREAM=0 where the frame fits), or leave {LIVE_MASK_COPIES_ENV} off.')


def _live_reading_state(X, feature_cols: List[str], is_realtime, rows: int = None) -> Dict:
    """Per row of X (its first `rows` rows when given): realtime, has a reading, has an offset."""
    cols = list(feature_cols)
    missing = [c for c in LIVE_READING_FEATURES if c not in cols]
    if missing:
        raise CorpusContractError(
            f'the feature matrix has no {missing}: masked copies are copies of the realtime rows '
            'with the reading-based live features at their missing values, and these columns '
            'are not in it (FLOCK_LIVE_FEATURES=off drops them).')
    n = X.shape[0] if rows is None else int(rows)
    realtime = np.asarray(is_realtime)[:n] == 1
    has_reading = np.asarray(X[:n, cols.index('last_live_age_h')]) != LIVE_MISSING_AGE_H
    has_offset = np.asarray(X[:n, cols.index('recent_offset_n')]) > 0
    return {'realtime': realtime, 'has_reading': has_reading, 'has_offset': has_offset}


def live_mask_copy_sources(X, feature_cols: List[str], is_realtime,
                           rows: int = None) -> Tuple[np.ndarray, np.ndarray]:
    """(rows copy B is made of, rows copy C is made of), each ascending.

    The one definition of which rows get which copy: append_live_mask_copies
    makes the copies from it and train_model.assert_masked_copies finds each
    copy's source row with it (`rows` = the count of original rows there)."""
    s = _live_reading_state(X, feature_cols, is_realtime, rows)
    return (np.flatnonzero(s['realtime'] & s['has_reading'] & s['has_offset']),
            np.flatnonzero(s['realtime'] & (s['has_reading'] | s['has_offset'])))


def _rows_then(values, src: np.ndarray, key: str):
    """A per-row array followed by its rows `src`, in the array's own type."""
    if isinstance(values, np.ndarray):
        return np.concatenate([values, values[src]])
    if isinstance(values, pd.api.extensions.ExtensionArray):
        return type(values)._concat_same_type([values, values.take(src)])
    raise CorpusContractError(
        f'features_train.pkl[{key!r}] is a {type(values).__name__}, neither a NumPy nor a pandas '
        'array: the masked copies cannot be appended to it.')


def cell_stats_with_copies(cell_stats: Dict, src: np.ndarray, y_actual, copies: Dict) -> Dict:
    """category_cell_stats for a matrix that gained the rows `src` after its own.

    row_group and each block's row_cell grow by those rows; rows_sums and
    rows_counts are recounted over every row of the grown matrix, from the
    grown y_actual train_model.FoldCategoryBaselines rebuilds them from; `rows`
    follows. sums and counts, fitted on the pre-filter frame, are untouched.
    """
    row_group = np.asarray(cell_stats['row_group'])
    n = len(row_group)
    y = np.asarray(y_actual, dtype=np.float64)
    if len(y) != n + len(src):
        raise CorpusContractError(
            f'category_cell_stats indexes {n} rows and {len(src)} copies were made, but y_actual '
            f'has {len(y)} rows.')
    finite = np.isfinite(y)
    grown_group = np.concatenate([row_group, row_group[src]])
    out: Dict = {k: v for k, v in cell_stats.items() if k not in ('category', 'refined')}
    out['rows'] = int(len(grown_group))
    out['row_group'] = grown_group
    out['masked_copies'] = {'offset_only': int(copies['offset_only']),
                            'no_reading': int(copies['no_reading'])}
    for name in ('category', 'refined'):
        block = cell_stats[name]
        row_cell = np.asarray(block['row_cell'])
        grown_cell = np.concatenate([row_cell, row_cell[src]])
        shape = np.asarray(block['rows_counts']).shape
        size = shape[0] * shape[1]
        flat = grown_group.astype(np.int64) * shape[1] + grown_cell
        own = np.bincount(flat[:n][finite[:n]], minlength=size).reshape(shape)
        if not np.array_equal(own, block['rows_counts']):
            raise CorpusContractError(
                f'category_cell_stats[{name!r}].rows_counts are not the counts of the rows it '
                'indexes: the statistics and the matrix are not row-aligned, and the copies '
                'would be counted in the wrong cells.')
        out[name] = dict(
            block, row_cell=grown_cell,
            rows_sums=np.bincount(flat[finite], weights=y[finite], minlength=size).reshape(shape),
            rows_counts=np.bincount(flat[finite], minlength=size).reshape(shape).astype(np.int64))
    return out


def append_live_mask_copies(train_data: Dict) -> Tuple[Dict, Dict]:
    """features_train.pkl's dict with the masked copies appended (the block above).

    Returns a new dict (the given one is not changed) and the record
    model_metadata.json carries as corpus_contract.live_mask_copies.
    """
    if 'X' not in train_data:
        raise CorpusContractError(
            'the masked copies need X in the pickle; this one names an X file beside it '
            f'(the streamed preparation). {LIVE_MASK_COPIES_ENV}=on is implemented for the '
            'in-memory preparation only.')
    unknown = [k for k in train_data if k not in TRAIN_PICKLE_ROW_KEYS + TRAIN_PICKLE_FRAME_KEYS]
    if unknown:
        raise CorpusContractError(
            f'features_train.pkl has key(s) {unknown} that append_live_mask_copies does not know '
            'to be per-row or not. Name each in TRAIN_PICKLE_ROW_KEYS or TRAIN_PICKLE_FRAME_KEYS.')
    X = train_data['X']
    n = int(X.shape[0])
    feature_cols = list(train_data['feature_cols'])
    short = {k: len(train_data[k]) for k in TRAIN_PICKLE_ROW_KEYS
             if k in train_data and len(train_data[k]) != n}
    if short:
        raise CorpusContractError(f'per-row key(s) of features_train.pkl are not {n} rows long: {short}.')

    state = _live_reading_state(X, feature_cols, train_data['is_realtime'])
    idx_b, idx_c = live_mask_copy_sources(X, feature_cols, train_data['is_realtime'])
    src = np.concatenate([idx_b, idx_c])
    n_b, n_c = int(len(idx_b)), int(len(idx_c))
    total = n + n_b + n_c

    # X, column at a time into the column-major layout it already has: the
    # original rows, then their copies, then the masked values over the copies.
    grown = np.empty((total, X.shape[1]), dtype=np.float32, order='F')
    for j in range(X.shape[1]):
        grown[:n, j] = X[:, j]
        grown[n:, j] = X[src, j]
    at = {c: feature_cols.index(c) for c in LIVE_READING_FEATURES}
    grown[n:, at['last_live_dev']] = 0
    grown[n:, at['last_live_age_h']] = LIVE_MISSING_AGE_H
    grown[n + n_b:, at['recent_offset']] = 0
    grown[n + n_b:, at['recent_offset_n']] = 0

    out: Dict = {}
    for k, v in train_data.items():
        if k == 'X':
            out[k] = grown
        elif k == 'category_cell_stats':
            out[k] = None   # keeps its place; filled once y_actual has grown
        elif k in TRAIN_PICKLE_ROW_KEYS:
            out[k] = _rows_then(v, src, k)
        else:
            out[k] = v
    copies = {'offset_only': n_b, 'no_reading': n_c}
    out['category_cell_stats'] = cell_stats_with_copies(
        train_data['category_cell_stats'], src, out['y_actual'], copies)
    flags = np.zeros(total, dtype=np.int8)
    flags[n:n + n_b] = MASKED_COPY_CODES['offset_only']
    flags[n + n_b:] = MASKED_COPY_CODES['no_reading']
    out[MASKED_COPY_KEY] = flags

    w = np.asarray(out['sample_weight'], dtype=np.float64)
    realtime = np.asarray(out['is_realtime']) == 1
    record = {
        'policy': 'on',
        'env': LIVE_MASK_COPIES_ENV,
        **copies,
        'source_rows': n,
        'matrix_rows': total,
        'realtime_rows': int(state['realtime'].sum()),
        'realtime_rows_with_reading': int((state['realtime'] & state['has_reading']).sum()),
        'realtime_rows_with_offset': int((state['realtime'] & state['has_offset']).sum()),
        'realtime_rows_at_missing_values': int(
            (state['realtime'] & ~state['has_reading'] & ~state['has_offset']).sum()),
        'realtime_loss_share': round(float(w[realtime].sum() / w.sum()), 4) if w.sum() else None,
        'masked_copy_codes': dict(MASKED_COPY_CODES),
        'what': ('copies of the realtime training rows, appended after them: offset_only has '
                 'last_live_dev and last_live_age_h at their missing values and the offset kept '
                 '(rows with both a reading and an offset); no_reading has all four '
                 'reading-based live features at their missing values (rows with a reading or '
                 'an offset). Every other value, the label and the sample weight included, is '
                 'the source row\'s. training_rows and sample_weight_policy describe the '
                 'source rows; realtime_loss_share here is the share the matrix trains with.'),
    }
    logger.warning(
        'MASKED COPIES (%s=on): %d realtime rows (%d with a reading, %d with an offset, %d already '
        'at the missing values) gained %d offset-only and %d no-reading copies; the matrix is %d '
        'rows over %d source rows, realtime rows at %s of the loss.',
        LIVE_MASK_COPIES_ENV, record['realtime_rows'], record['realtime_rows_with_reading'],
        record['realtime_rows_with_offset'], record['realtime_rows_at_missing_values'], n_b, n_c,
        total, n, record['realtime_loss_share'])
    return out, record


def with_live_mask_copies(train_data: Dict) -> Tuple[Dict, Dict]:
    """main()'s last step on features_train.pkl's dict, by FLOCK_LIVE_MASK_COPIES:
    'on' gives the dict with the copies appended and their record; 'off' gives
    back the very dict it was handed, and None."""
    if LIVE_MASK_COPIES_POLICY != 'on':
        return train_data, None
    return append_live_mask_copies(train_data)


def masked_copy_flags(data: Dict) -> np.ndarray:
    """masked_copy per row of a features pickle (int8): 0 an original row, 1 an
    offset-only copy, 2 a no-reading copy.

    A pickle without the key was prepared with FLOCK_LIVE_MASK_COPIES off (every
    training pickle written before 2026-11-27, and every holdout pickle) and
    reads as all original rows.
    """
    n = len(data['y'])
    if MASKED_COPY_KEY not in data:
        return np.zeros(n, dtype=np.int8)
    flags = np.asarray(data[MASKED_COPY_KEY])
    if (flags.shape != (n,) or flags.dtype.kind not in 'iu'
            or not np.isin(flags, list(MASKED_COPY_CODES.values())).all()):
        raise CorpusContractError(
            f'features pickle key {MASKED_COPY_KEY!r} must hold one of {sorted(MASKED_COPY_CODES.values())} '
            f'for each of its {n} rows (got {flags.dtype}{flags.shape}). Re-run prepare_features.py.')
    return flags.astype(np.int8, copy=False)


def masked_copy_blocks(flags) -> Dict:
    """{'original': n, 'offset_only': n, 'no_reading': n}, after requiring the
    order append_live_mask_copies writes: every original row, then every
    offset-only copy, then every no-reading copy. A reader may then take the
    original rows as the first `original` rows."""
    flags = np.asarray(flags).astype(np.int8, copy=False)
    if not flags.any():
        return {'original': int(len(flags)), 'offset_only': 0, 'no_reading': 0}
    if (flags[1:] < flags[:-1]).any():
        raise CorpusContractError(
            f'{MASKED_COPY_KEY} is not original rows, then offset-only copies, then no-reading '
            'copies. prepare_features.py writes them in that order; this pickle was not '
            'written by it.')
    counts = np.bincount(flags, minlength=3)
    return {name: int(counts[code]) for name, code in MASKED_COPY_CODES.items()}


def refuse_masked_copies(data: Dict, who: str) -> None:
    """For a script that reads every row of features_train.pkl as one source row."""
    if MASKED_COPY_KEY in data and np.asarray(data[MASKED_COPY_KEY]).any():
        raise SystemExit(
            f'features_train.pkl carries masked copies of its realtime rows '
            f'({LIVE_MASK_COPIES_ENV}=on): {who} reads every pickle row as one source row and '
            'does not support them. Run it on a frame prepared with the switch off.')


def holdout_pickle_dict(holdout_df: pd.DataFrame, feature_cols: List[str]) -> Dict:
    return {
        'X': feature_matrix(holdout_df, feature_cols),
        'y': holdout_df['delta_label'].values.astype(np.float32),
        'y_actual': holdout_df['busyness_pct'].values.astype(np.float32),
        'baseline': holdout_df['baseline_busyness'].values.astype(np.float32),
        'feature_cols': feature_cols,
        'cities': holdout_df['city'].values,
        'hour': holdout_df['hour'].values.astype(np.int16),
        'venue_category': holdout_df['venue_category'].astype(str).values,
        'label_type': 'delta',
        'label_provenance': holdout_df['label_provenance'].fillna('unknown').astype(str).values,
        'label_source': holdout_df['label_source'].astype('string').fillna('').values.astype(str),
        'vendor_forecast_pct': pd.to_numeric(
            holdout_df['vendor_forecast_pct'], errors='coerce').values.astype(np.float32),
        # GATE-B's date-block bootstrap resamples observation DATES so day
        # shocks stay intact inside each resample. quick_eval degrades to the
        # legacy path when an older pickle lacks this key, so re-running
        # prepare_features is required before a GATE-B admission but not
        # before a legacy one.
        'observed_date': holdout_df['observed_date'].astype('string').fillna('').values.astype(str),
        'weather_observed': holdout_df['weather_observed'].values.astype(np.int8),
        'is_realtime': holdout_df['is_realtime'].values.astype(np.int8),
        features_io.LABEL_TRUST_KEY: features_io.label_trust_stamp(LABEL_TRUST),
    }


def write_model_metadata(*, time_holdout: Dict, final_refit, weekly_weight_policy: Dict,
                         feature_cols: List[str], venue_metadata: Dict, cat_baseline_maps: Dict,
                         training_rows: int, holdout_rows: int, weather_stats: Dict,
                         holdout_weather_stats: Dict, calendar_stats: Dict, holdout_calendar_stats: Dict,
                         label_stats: Dict, holdout_label_stats: Dict, weather_imputation: Dict,
                         event_type_stats: Dict, unknown_provenance_record: Dict, constant_cols: List[str],
                         dead_slot_record: Dict, category_baseline_fit: Dict,
                         live_mask_copies: Dict = None) -> None:
    """Merge this feature build into models/model_metadata.json.

    `live_mask_copies` is append_live_mask_copies' record under
    FLOCK_LIVE_MASK_COPIES=on, else None, and then no key is written: metadata
    without corpus_contract.live_mask_copies is a build with the switch off.
    """
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
                          'training_metrics', 'incumbent_comparison', 'final_refit']
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
        # Which live readings this artifact never trained on, and the last date
        # of live data it did train on. bandEval.js --gate scores the first; a
        # later retrain's gate reads the second when this artifact becomes the
        # incumbent, to prove the incumbent has not seen that retrain's window.
        'time_holdout': time_holdout,
        **({'final_refit': final_refit} if final_refit else {}),
        'sample_weight_policy': weekly_weight_policy,
        'feature_names': feature_cols,
        'feature_count': len(feature_cols),
        **venue_metadata,
        'weather_code_groups': {k: str(v) for k, v in WEATHER_GROUPS.items()},
        'category_baselines': cat_baseline_dict,
        'refined_baselines': ref_baseline_dict,
        'training_rows': training_rows,
        'holdout_rows': holdout_rows,
        # Provenance of THIS feature build — an artifact can never hide which
        # policy produced it (audit findings 4 and 5).
        'corpus_contract': {
            'export_columns_required': len(EXPORT_COLUMNS),
            'weather_policy': WEATHER_POLICY,
            'calendar_policy': CALENDAR_POLICY,
            'dead_slot_policy': DEAD_SLOT_POLICY,
            'run_length_policy': RUN_LENGTH_POLICY,
            'live_feature_policy': LIVE_FEATURE_POLICY,
            **({'live_mask_copies': live_mask_copies} if live_mask_copies else {}),
            'sports_features': sports_features_enabled(),
            'weather_code_recovery': {
                'train': weather_stats,
                'holdout': holdout_weather_stats,
            },
            'calendar_coverage': {
                'train': calendar_stats,
                'holdout': holdout_calendar_stats,
            },
            # Round 20. Written into the artifact so a model can never claim a
            # vendor-forecast downweight that applied to zero rows, and so the
            # run where coverage first stops being zero is dated rather than
            # inferred. Both columns are CARRIED, not features — the names below
            # will never appear in feature_names, and that is deliberate.
            'label_provenance_coverage': {
                'train': label_stats,
                'holdout': holdout_label_stats,
                'carried_not_featurised': ['label_source', 'vendor_forecast_pct'],
                'why': (
                    'Both are NULL on 100% of the corpus collected before 2026-08-15 '
                    'and that is unrecoverable (migration 025). A feature built from '
                    'either would be a constant dead slot, and filling the NULL with 0 '
                    'would assert that BestTime predicted an empty venue. Beyond that, '
                    'vendor_forecast_pct EQUALS busyness_pct on every forecast-sourced '
                    'row by construction, so a raw feature would leak the label on that '
                    'slice the moment the data exists. They are exported, validated '
                    'against each other and shipped in both pickles so the '
                    'label-versus-vendor distance is answerable as soon as there is '
                    'data, without another export.'),
            },
            'dropped_features': sorted(DROPPED_FEATURES),
            'dropped_feature_reasons': DROP_REASONS,
            # Round 26. What was imputed, what was aliased, what was excluded
            # and what was refused, so the artifact says it rather than the
            # reader inferring it from a diff.
            'weather_imputation': weather_imputation,
            'event_type_normalisation': event_type_stats,
            'unknown_provenance': unknown_provenance_record,
            # 2026-11-27: the label quarantine and the weekly repetition check
            # (check_label_trust), as this run found them.
            'label_trust': dict(LABEL_TRUST),
            'feature_nan_policy': 'refuse (refuse_unfilled_features); no blanket fillna(0)',
            'constant_feature_slots': constant_cols,
            # Round 22. Not just WHICH slots are dead but why each one is
            # allowed to be, and what makes it stop. An artifact that ships a
            # dead column now has to carry its own justification for it.
            'dead_slots': dead_slot_record,
            'serving_population_filter': 'baseline_busyness > 0',
            'min_realtime_rows': MIN_REALTIME_ROWS,
            # Round 14. Where the two category label-means were fitted, where
            # they were applied, and what is still open. Written so nobody has
            # to infer the answer from the code, and so an artifact cannot claim
            # the leak is closed while it is not.
            'category_baseline_fit': category_baseline_fit,
        },
    })
    with open(meta_path, 'w') as f:
        json.dump(metadata, f, indent=2)


def main():
    # FLOCK_LIVE_MASK_COPIES=on beside FLOCK_LIVE_FEATURES=off stops here, before
    # anything is read (main_streamed makes the same call for its own refusal).
    require_live_mask_copies_possible()
    logger.info('Loading training data...')
    train_path = SCRIPT_DIR / 'training_data.csv'
    if not train_path.exists():
        raise CorpusContractError(
            f'{train_path} does not exist. Run `node export_training_data.js` first — '
            'the retrain starts at the export, not at this script.'
        )
    # The label quarantine and the repetition check, on both files, before
    # either path reads a row into memory (see the block above check_label_trust).
    LABEL_TRUST.clear()
    LABEL_TRUST.update(check_label_trust([train_path, SCRIPT_DIR / 'holdout_data.csv']))
    streamed, why = prep_stream_mode(train_path)
    if streamed:
        return main_streamed(train_path, why)
    logger.info('Feature preparation in memory (%s).', why)
    train_df = pd.read_csv(train_path)
    logger.info(f'Training data: {len(train_df)} rows')
    require_export_columns(train_df, train_path, 'training_data.csv')
    _, holdout_df = read_holdout_csv()
    require_coordinates(train_df, train_path, 'training_data.csv')

    # The neighbour table serving's range scan reads, from BOTH raw frames and
    # before any row is dropped (see the block above build_neighbor_table).
    neighbor_table = build_neighbor_table([train_df, holdout_df])
    # The live readings serving's offset row stores, from both raw frames and
    # before any row is dropped (see the block above add_live_features).
    live_reading_table = build_live_reading_table([train_df, holdout_df], neighbor_table)
    log_raw_tables(neighbor_table, live_reading_table)
    if LIVE_FEATURE_POLICY == 'off':
        drop_features(LIVE_FEATURE_NAMES, 'FLOCK_LIVE_FEATURES=off (ablation)')

    # ── CORPUS CONTRACT (audit findings 4 and 5) ────────────────────────────
    # Recover weather_condition_code from the description text, then decide the
    # weather and calendar policies ONCE, before any feature is built, so the
    # feature set that comes out of this run cannot contain a dead slot without
    # model_metadata.json saying so.
    weather_stats = recover_weather_codes(train_df, 'train')
    holdout_weather_stats = recover_weather_codes(holdout_df, 'holdout')
    enforce_weather_contracts(weather_stats, holdout_weather_stats)

    calendar_stats = audit_calendar_coverage(train_df, 'train')
    holdout_calendar_stats = audit_calendar_coverage(holdout_df, 'holdout')
    enforce_calendar_contracts(calendar_stats, holdout_calendar_stats)

    # Round 20: the carried provenance columns check each other and the
    # exporter, on BOTH frames, before a single feature is built. Nothing here
    # fills, coerces or repairs — see enforce_label_contract.
    label_stats = audit_label_columns(train_df, 'train')
    holdout_label_stats = audit_label_columns(holdout_df, 'holdout')
    enforce_label_contracts(label_stats, holdout_label_stats)

    # Round 25: the same treatment for event provenance, as a REPORT and never a
    # gate. It is empty on the entire pre-045 corpus, so a refusal would block
    # every retrain on a fact about the past that no run can change; what it can
    # do is make the size of the unverifiable slice impossible to overlook.
    report_event_provenance(train_df, 'train')
    report_event_provenance(holdout_df, 'holdout')

    # Round 26: the event-type vocabulary. The two legacy values are mapped by
    # their exact reading and anything else stops the run here, before a
    # two-hour feature build, on BOTH frames.
    event_type_stats = event_type_record(normalise_event_types(train_df, 'train'),
                                         normalise_event_types(holdout_df, 'holdout'))

    # The time holdout, cut BEFORE anything is fitted (see the block above
    # resolve_time_holdout). Only the training frame loses rows; the city
    # holdout was never trained on.
    final_refit = resolve_final_refit()
    if final_refit:
        fold_holdout_into_refit(final_refit, holdout_df)
        train_df = pd.concat([train_df, holdout_df], ignore_index=True)
        live = _live_dates(train_df)
        time_holdout = {'policy': 'final_refit', 'days': 0, 'from_date': None,
                        'last_live_date': str(live.max()) if len(live) else None}
    else:
        time_holdout = resolve_time_holdout([train_df, holdout_df])
    train_df, time_split = split_time_holdout(train_df, time_holdout['from_date'])
    time_holdout.update(time_split)
    log_time_holdout(time_holdout)

    # Drop rows with null label
    train_df = train_df.dropna(subset=['busyness_pct'])
    logger.info(f'After dropping null labels: {len(train_df)} rows')

    # Drop rows where busyness_pct is 0 for suspiciously many hours (likely closed)
    # We keep individual 0s but flag venues that are always 0
    venue_means = train_df.groupby(ALWAYS_ZERO_KEYS)['busyness_pct'].mean()
    always_zero = venue_means[venue_means == 0].index
    if len(always_zero) > 0:
        before = len(train_df)
        train_df = drop_always_zero_venues(train_df, always_zero)
        logger.info(f'Dropped {before - len(train_df)} rows from always-zero venues')

    # Feature engineering — training data
    logger.info('Engineering features...')
    fits: Dict = {}
    train_df = add_training_features(train_df, neighbor_table, live_reading_table, fits)
    venue_metadata, temp_norms, cat_baseline_maps = fits['venue_metadata'], fits['temp_norms'], fits['cat_maps']
    add_temp_norm_metadata(venue_metadata, temp_norms)
    weather_imputation = weather_imputation_record(
        temp_norms, int((train_df['weather_observed'] == 1).sum()),
        int((train_df['weather_observed'] == 0).sum()))
    train_df = finish_frame(train_df)

    # Feature engineering — holdout data (same transforms, the training fits)
    holdout_df = featurise_holdout(holdout_df, venue_metadata, temp_norms, cat_baseline_maps,
                                   neighbor_table, live_reading_table, weather_imputation)

    # Compute delta label: y_delta = busyness_pct - baseline_busyness
    # Model predicts the delta; production reconstructs absolute as baseline + clamp(delta, -30, 30).
    # This removes the popular_times leakage (model can't trivially copy baseline as a feature).
    train_df['baseline_busyness'] = train_df['baseline_busyness'].fillna(0)
    train_df['delta_label'] = (train_df['busyness_pct'] - train_df['baseline_busyness']).astype(float)

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
    # Round 21. The per-fold category aggregates are fitted HERE, on the frame
    # build_category_baseline_maps was fitted on, because the trainer's job is to
    # rebuild THAT map minus one city. Doing it after the filter below made the
    # confound fifty-four times the leak — see the round 21 paragraph above
    # build_category_cell_aggregates. The positional row indexes are attached
    # further down, once the frame is the one X will be built from.
    cell_aggregates = build_category_cell_aggregates(train_df, LEAVE_OUT_COL)

    # Runs of identical live readings are counted on every live reading of the
    # training window, before the filter below removes any of them (see the
    # block above live_run_lengths).
    train_df['live_run_length'] = live_run_lengths(train_df)

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
    # and live. Rows collected before label_provenance existed USED to stay at
    # 1.0 on the argument that "silently demoting the whole historical corpus
    # would be a bigger change than the bug"; that held while every realtime
    # row was in that state and expired on 2026-09-01, when proven-live rows
    # began landing beside them. Round 26 excludes them instead; see
    # exclude_unknown_provenance.
    # label_provenance is part of the export contract (require_export_columns
    # already refused the file if it were absent). It used to be defaulted to
    # 'unknown' here when missing, which silently weighted EVERY vendor-forecast
    # label at 1.0 — the exact thing round 10 added the column to stop, and the
    # regime the shipped v2.5 model was trained under without anyone noticing.
    train_df['label_provenance'] = train_df['label_provenance'].fillna('unknown')
    # Round 26: an unknown-provenance realtime row is not a live label. Excluded
    # from both frames unless ML_ALLOW_UNKNOWN_PROVENANCE=true admits it; see
    # the block above exclude_unknown_provenance for why there is no tier for it.
    # The holdout keeps its rows only under the same hatch: a gate scored on
    # rows that may be the vendor's own forecast is not a gate on reality.
    train_df, unknown_train = exclude_unknown_provenance(train_df, 'train')
    holdout_df['label_provenance'] = holdout_df['label_provenance'].fillna('unknown')
    holdout_df, unknown_holdout = exclude_unknown_provenance(holdout_df, 'holdout')
    unknown_provenance_record = {'train': unknown_train, 'holdout': unknown_holdout,
                                 'env': UNKNOWN_PROVENANCE_ENV}
    weekly_weight_policy, run_divisor = assign_sample_weights(train_df, RUN_LENGTH_POLICY)
    n_rt = log_weight_blend(train_df, before_filter, weekly_weight_policy)
    check_realtime_labels(train_df, n_rt, unknown_train)

    # Get feature columns (excludes baseline_busyness — now in label)
    feature_cols = get_feature_columns(train_df)
    holdout_df = align_holdout(holdout_df, feature_cols)

    logger.info(f'Feature count: {len(feature_cols)}')
    logger.info(f'Features: {feature_cols}')
    logger.info(f'Delta label distribution: mean={train_df["delta_label"].mean():.2f}, std={train_df["delta_label"].std():.2f}, min={train_df["delta_label"].min():.0f}, max={train_df["delta_label"].max():.0f}')

    # Label distribution
    logger.info(f'\nLabel (busyness_pct) distribution:')
    logger.info(f'  Mean: {train_df["busyness_pct"].mean():.1f}')
    logger.info(f'  Median: {train_df["busyness_pct"].median():.1f}')
    logger.info(f'  Std: {train_df["busyness_pct"].std():.1f}')
    logger.info(f'  Min: {train_df["busyness_pct"].min()}, Max: {train_df["busyness_pct"].max()}')

    # Round 26: no blanket fill. Every feature column arrives here populated by
    # its own named fill, or the run stops and names the column. The
    # `fillna(0)` that stood here caught nothing on the last run and would have
    # turned the first forgotten fill into a measured zero.
    refuse_unfilled_features(train_df, feature_cols, 'train')
    refuse_unfilled_features(holdout_df, feature_cols, 'holdout')

    # Dead-slot contract (round 22). This used to be a bare logger.warning that
    # ended "some of these are legitimately sparse" without saying WHICH, so the
    # eleven dead slots of the last run were indistinguishable from each other:
    # ten were true statements about a young corpus and one (cold_outdoor) was a
    # Celsius threshold on a Fahrenheit column that could never fire on either
    # side of the parity gate. A warning that mixes those two is a warning nobody
    # can act on. Now each constant column must be named and justified in
    # EXPECTED_SPARSE_FEATURES or the run stops.
    # cold_outdoor (decided 2026-10-15, before the November export). It may not be
    # excused as sparse (mlPipelineContracts.test.js: it once hid a Celsius threshold
    # on a Fahrenheit column), so a training window with no live reading under 41 F
    # drops it and a window with one keeps it. The rule reads only whether the column
    # varies, never a score, so it is fixed before the data exist.
    if 'cold_outdoor' in feature_cols and train_df['cold_outdoor'].nunique(dropna=False) <= 1:
        drop_features(['cold_outdoor'], 'constant in a training window with no live reading under 41 F')
        feature_cols = [c for c in feature_cols if c != 'cold_outdoor']
    constant_cols = [c for c in feature_cols if train_df[c].nunique(dropna=False) <= 1]
    dead_slot_record = enforce_dead_slot_contract(constant_cols, feature_cols)

    # Save
    logger.info('\nSaving artifacts...')

    # Save feature matrix as pickle
    # 'hour' and 'venue_category' are carried EXPLICITLY (audit finding 10):
    # evaluate_model.py used to re-read the 3.57M-row raw CSV and truncate it to
    # the length of the 2.07M-row filtered matrix, aligning unrelated rows — the
    # MAE-by-hour plot, the one diagnostic that would have caught a six-hour
    # clock skew, was drawn on scrambled pairs.
    # Round 14. Indexed HERE, after every row filter, so row_cell / row_group
    # are positionally aligned with X — the same alignment mistake audit finding
    # 10 found in evaluate_model.py is the one thing that would make these
    # statistics silently wrong. The SUMS were fitted earlier, before the
    # serving-population filter, for the reason round 21 records; only the
    # indexes belong here.
    cell_stats = index_category_cells(train_df, cell_aggregates)
    if (len(cell_stats['row_group']) != len(train_df)
            or len(cell_stats['category']['row_cell']) != len(train_df)):
        raise CorpusContractError(
            'category_cell_stats row indexes do not match the training frame '
            f'({len(cell_stats["row_group"])} / '
            f'{len(cell_stats["category"]["row_cell"])} vs {len(train_df)}). They are '
            'POSITIONAL indexes into X; a per-fold refit built from misaligned '
            'indexes would score every row against the wrong category cell, silently.'
        )
    category_baseline_fit = category_baseline_fit_record(cell_stats)

    train_data = train_pickle_dict(
        train_pickle_columns(train_df), {'X': feature_matrix(train_df, feature_cols)},
        train_df['sample_weight'].values, run_divisor, feature_cols, cell_stats)
    # FLOCK_LIVE_MASK_COPIES=on: the masked copies of the realtime rows, appended
    # to every per-row key now that the frame's features, labels and weights are
    # final (the block above append_live_mask_copies). Off, this is the dict
    # just built and no record. The holdout pickle below never gets copies.
    train_data, live_mask_copies = with_live_mask_copies(train_data)
    if live_mask_copies:
        category_baseline_fit['per_fold_inputs_indexed_rows'] = train_data['category_cell_stats']['rows']
    with open(SCRIPT_DIR / 'features_train.pkl', 'wb') as f:
        pickle.dump(train_data, f)

    holdout_data = holdout_pickle_dict(holdout_df, feature_cols)
    with open(SCRIPT_DIR / 'features_holdout.pkl', 'wb') as f:
        pickle.dump(holdout_data, f)

    write_model_metadata(
        time_holdout=time_holdout, final_refit=final_refit, weekly_weight_policy=weekly_weight_policy,
        feature_cols=feature_cols, venue_metadata=venue_metadata, cat_baseline_maps=cat_baseline_maps,
        training_rows=len(train_df), holdout_rows=len(holdout_df), weather_stats=weather_stats,
        holdout_weather_stats=holdout_weather_stats, calendar_stats=calendar_stats,
        holdout_calendar_stats=holdout_calendar_stats, label_stats=label_stats,
        holdout_label_stats=holdout_label_stats, weather_imputation=weather_imputation,
        event_type_stats=event_type_stats, unknown_provenance_record=unknown_provenance_record,
        constant_cols=constant_cols, dead_slot_record=dead_slot_record,
        category_baseline_fit=category_baseline_fit, live_mask_copies=live_mask_copies)

    if live_mask_copies:
        logger.info(f'features_train.pkl holds {live_mask_copies["matrix_rows"]} rows: the '
                    f'{len(train_df)} below and {live_mask_copies["offset_only"]} offset-only and '
                    f'{live_mask_copies["no_reading"]} no-reading masked copies of its realtime rows.')
    logger.info(f'Saved features_train.pkl ({len(train_df)} rows, {len(feature_cols)} features)')
    logger.info(f'Saved features_holdout.pkl ({len(holdout_df)} rows)')
    logger.info(f'Saved model_metadata.json')
    logger.info('Done!')


# ---------------------------------------------------------------------------
# STREAMED PREPARATION (2026-11-25): a training export too large for one frame.
#
# The November third candidate is about 94 million rows. Read whole, this
# script needs about 0.97 GB per million weekly rows and 0.62 GB per million
# realtime rows (about 91 GB for that export) on a PC with 61.6 GB. So above
# FLOCK_PREP_STREAM_MIN_ROWS training rows (default 15,000,000), or whenever
# FLOCK_PREP_STREAM=1, main() hands the run to main_streamed(), which reads
# training_data.csv three times and never holds more than a slice of it:
#
#   pass 1  the type each column takes in the whole read, the time holdout's
#           cutoff and the always-zero venues;
#   pass 2  every table main() fits on the whole training frame: the
#           neighbour and live-reading tables, the audits, the venue fills
#           and Google types, the climate norms, the smoothing grid, the
#           category maps and the live run lengths, and which rows will
#           reach X (so X can be sized before a row is written);
#   pass 3  the features of FLOCK_PREP_CHUNK_ROWS rows at a time (default
#           2,000,000), through the same functions main() runs on the whole
#           frame with those tables handed in, each slice's rows written into
#           X at their final positions.
#
# X is a float32 Fortran-order .npy beside features_train.pkl, which names it
# (features_io); every other key of the pickle is what main() writes. The
# holdout is read and featurised whole, by the functions main() uses, and
# model_metadata.json is written by the same function.
#
# WHY THE NUMBERS ARE THE SAME. A slice can answer differently from the whole
# frame in three ways, and each is closed here:
#   * types: pd.read_csv infers a type per parser chunk (16,384 rows for this
#     export's 48 columns) and then joins the chunks, so review_count is int64
#     in one chunk and float64 in another, and a cell key reads '5' in one and
#     '5.0' in another. TrainingCsv reads exactly those parser chunks and gives
#     each column the type and the values the whole read gives it.
#   * order: a fit that sums floats in row order (the climate norms, the
#     sample-weight totals) runs the same function on the same rows in the
#     same order; a fit that only adds whole numbers (cell sums, the smoothing
#     grid, the always-zero test) is kept as integers, and pass 2 refuses a
#     label or baseline that is not a whole number instead of summing it in a
#     different order.
#   * ties: the order value_counts gives equal counts depends on the pandas
#     installed (pandas 3 sorts stably, so ties keep first appearance; pandas 2
#     uses numpy's quicksort, whose order among ties depends on the counts
#     around them). The tallies behind the Google types and the metadata counts
#     (ValueTally) keep first appearance across slices and leave the final
#     order to the installed value_counts itself (see ValueTally.value_counts).
# Pass 3 also checks every slice against what pass 2 predicted (which rows
# reach X, and cold_outdoor on each) and stops at the first difference.
# test_stream_prep.py runs both preparations on one synthetic export holding
# each of those traps and requires equal outputs.
# ---------------------------------------------------------------------------
PREP_STREAM_ENV = 'FLOCK_PREP_STREAM'
PREP_STREAM_MIN_ROWS_ENV = 'FLOCK_PREP_STREAM_MIN_ROWS'
PREP_CHUNK_ROWS_ENV = 'FLOCK_PREP_CHUNK_ROWS'
DEFAULT_PREP_STREAM_MIN_ROWS = 15_000_000
DEFAULT_PREP_CHUNK_ROWS = 2_000_000
# The pandas versions under which test_stream_prep.py and the registered
# export's runs have shown the streamed outputs equal to main()'s. How
# pd.read_csv types a column from its parser chunks, which TrainingCsv
# reproduces, is the version's own: under pandas 2.2.3 a True/False column that
# is empty in the other chunks reads whole as object holding bools, where
# TrainingCsv gives floats. Another version is refused until it passes there
# (requirements.txt pins this one).
PREP_STREAM_PROVEN_PANDAS = ('3.0.1',)


def require_proven_pandas(version: str) -> None:
    if version not in PREP_STREAM_PROVEN_PANDAS:
        raise CorpusContractError(
            f'the streamed preparation is shown to write what main() writes under pandas '
            f'{", ".join(PREP_STREAM_PROVEN_PANDAS)} only, and this is pandas {version}: how a '
            'column is typed from its parser chunks differs between versions. Install the pinned '
            'pandas (requirements.txt), or run test_stream_prep.py and the registered export\'s '
            'comparison under this one and add it to PREP_STREAM_PROVEN_PANDAS once both pass, or '
            f'set {PREP_STREAM_ENV}=0 on a machine that can hold the frame.')


def _env_count(name: str, default: int, env=os.environ) -> int:
    raw = str(env.get(name, '')).strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise CorpusContractError(f'{name}={raw!r} is not a whole number.')
    if value < 1:
        raise CorpusContractError(f'{name} must be at least 1 (got {value}).')
    return value


def count_csv_rows(path) -> int:
    """Data rows in a CSV, counted as line breaks. It only chooses the
    preparation, so a quoted line break (the export writes none) cannot hurt."""
    n, last = 0, b'\n'
    with open(path, 'rb') as f:
        while True:
            block = f.read(1 << 24)
            if not block:
                break
            n += block.count(b'\n')
            last = block[-1:]
    if last != b'\n':
        n += 1
    return max(n - 1, 0)


def prep_stream_mode(train_path, env=os.environ) -> Tuple[bool, str]:
    """(stream?, why). FLOCK_PREP_STREAM=1 or 0 decides; unset, the training
    export streams when it has more than FLOCK_PREP_STREAM_MIN_ROWS rows."""
    raw = str(env.get(PREP_STREAM_ENV, '')).strip()
    if raw not in ('', '0', '1'):
        raise CorpusContractError(f'{PREP_STREAM_ENV}={raw!r} must be 1, 0 or unset.')
    if raw:
        return raw == '1', f'{PREP_STREAM_ENV}={raw}'
    threshold = _env_count(PREP_STREAM_MIN_ROWS_ENV, DEFAULT_PREP_STREAM_MIN_ROWS, env)
    rows = count_csv_rows(train_path)
    return rows > threshold, (f'{rows} training rows, {"over" if rows > threshold else "not over"} '
                              f'{PREP_STREAM_MIN_ROWS_ENV}={threshold}')


def parser_chunk_rows(path) -> int:
    """The rows pandas' C parser converts at a time (TextReader.buffer_lines):
    the largest power of two whose double is under 2**20 / the table's width."""
    try:
        with pd.read_csv(path, chunksize=1) as reader:
            width = int(reader._engine._reader.table_width)
    except AttributeError as err:
        raise CorpusContractError(
            f'the streamed preparation reads pandas\' C parser chunk by chunk and could not '
            f'find its table width ({err}); this pandas ({pd.__version__}) is not the one it was '
            f'written against. Set {PREP_STREAM_ENV}=0 on a machine that can hold the frame.')
    heuristic = 2 ** 20 // max(width, 1)
    rows = 1
    while rows * 2 < heuristic:
        rows *= 2
    return rows


def _same_dtype(a, b) -> bool:
    return type(a) is type(b) and a == b


def _empty_of(dtype):
    return np.empty(0, dtype=dtype) if isinstance(dtype, np.dtype) else pd.array([], dtype=dtype)


class TrainingCsv:
    """training_data.csv as pd.read_csv reads it whole, a parser chunk at a time.

    The whole read converts each parser chunk with its own inferred types, joins
    the chunks with concat_compat, and builds the frame, where an object column
    holding only strings and gaps becomes the str dtype. note() sees every chunk
    once (pass 1); settle() works out each column's final type; frames() then
    gives every chunk's column that type and the values the whole read holds.
    """

    def __init__(self, path: Path):
        self.path = Path(path)
        self.header = pd.read_csv(self.path, nrows=0)
        self.parser_rows = parser_chunk_rows(self.path)
        self.seen: Dict[str, List] = {c: [] for c in self.header.columns}
        self.text_only: Dict[str, bool] = {c: True for c in self.header.columns}
        self.final: Dict[str, object] = {}
        self.rows = 0
        self.first_row = None

    def parser_chunks(self):
        with pd.read_csv(self.path, chunksize=self.parser_rows) as reader:
            yield from reader

    def note(self, chunk: pd.DataFrame) -> None:
        self.rows += len(chunk)
        for c in chunk.columns:
            d = chunk[c].dtype
            if not any(_same_dtype(d, s) for s in self.seen[c]):
                self.seen[c].append(d)
            text = isinstance(d, pd.StringDtype) or (d == np.float64 and bool(chunk[c].isna().all()))
            self.text_only[c] = self.text_only[c] and text

    def settle(self) -> None:
        from pandas.core.dtypes.concat import concat_compat
        if not self.rows:
            raise CorpusContractError(f'{self.path} has no rows.')
        for c, seen in self.seen.items():
            final = seen[0] if len(seen) == 1 else concat_compat([_empty_of(d) for d in seen]).dtype
            if isinstance(final, np.dtype) and final == object and self.text_only[c]:
                final = next(d for d in seen if isinstance(d, pd.StringDtype))
            self.final[c] = final

    def cast(self, chunk: pd.DataFrame) -> pd.DataFrame:
        from pandas.core.dtypes.concat import concat_compat
        cols = {}
        for c in chunk.columns:
            s, final = chunk[c], self.final[c]
            if _same_dtype(s.dtype, final):
                cols[c] = s
            elif isinstance(final, pd.StringDtype):
                cols[c] = s.astype(final)
            else:
                arr = s.to_numpy() if isinstance(s.dtype, np.dtype) else s.array
                others = [_empty_of(d) for d in self.seen[c] if not _same_dtype(d, s.dtype)]
                cols[c] = pd.Series(concat_compat([arr] + others), index=s.index, dtype=final)
        return pd.DataFrame(cols)

    def frames(self, chunk_rows: int, union_head: pd.DataFrame = None):
        """The file in slices of chunk_rows rows (the last shorter), each as the whole
        read holds it; with union_head (a final refit), as pd.concat with the holdout
        holds it."""
        pending, n = [], 0
        for chunk in self.parser_chunks():
            chunk = self.cast(chunk)
            if union_head is not None:
                chunk = pd.concat([chunk, union_head], ignore_index=True).iloc[:len(chunk)]
            if self.first_row is None:
                self.first_row = chunk.iloc[:1].reset_index(drop=True)
            pending.append(chunk)
            n += len(chunk)
            while n >= chunk_rows:
                frame = pd.concat(pending, ignore_index=True)
                yield frame.iloc[:chunk_rows].reset_index(drop=True)
                rest = frame.iloc[chunk_rows:]
                pending, n = ([rest] if len(rest) else []), len(rest)
        if n:
            yield pd.concat(pending, ignore_index=True)


def _unify_with(frame: pd.DataFrame, other_head: pd.DataFrame) -> pd.DataFrame:
    """`frame` as pd.concat([frame, other]) holds it: each column in the common type."""
    return pd.concat([frame, other_head], ignore_index=True).iloc[:len(frame)]


# The most rows ValueTally.value_counts() hands value_counts() as a stand-in:
# K values with K different counts need K(K+1)/2 (36 Google types: 666).
VALUE_COUNTS_STANDIN_MAX_ROWS = 50_000_000


class ValueTally:
    """Row counts per value in order of first appearance across everything added,
    which is what value_counts() of the concatenation counts, in the order the
    hashtable behind it first meets each value."""

    def __init__(self):
        self.counts: Dict = {}

    def add(self, values: pd.Series) -> None:
        for k, v in values.value_counts(sort=False, dropna=True).items():
            self.counts[k] = self.counts.get(k, 0) + int(v)

    def extend(self, other: 'ValueTally') -> None:
        for k, v in other.counts.items():
            self.counts[k] = self.counts.get(k, 0) + v

    def value_counts(self) -> pd.Series:
        """value_counts() of everything added, in the order the installed pandas gives.

        The counts are exact; the order of equal counts is the installed
        value_counts' own (pandas 3 sorts stably, pandas 2 with numpy's
        quicksort), so this does not sort them itself. value_counts() is handed
        a stand-in column in which each value, in order of first appearance,
        occurs as often as its count's rank among the distinct counts (1 for
        the smallest). Its hashtable meets the values in the same order, and a
        comparison sort orders the ranks exactly as it orders the counts, since
        it only ever compares them, so the stand-in comes back in the order the
        real column's value_counts() would give, whatever the version sorts with."""
        keys = np.empty(len(self.counts), dtype=object)
        keys[:] = list(self.counts)
        counts = np.fromiter(self.counts.values(), dtype=np.int64, count=len(keys))
        order = np.arange(len(keys))
        if len(keys) > 1:
            rank = np.unique(counts, return_inverse=True)[1].reshape(-1) + 1
            if int(rank.sum()) > VALUE_COUNTS_STANDIN_MAX_ROWS:
                raise CorpusContractError(
                    f'{len(keys)} distinct values with {int(rank.max())} different counts: ordering them '
                    f'as value_counts() does would take a stand-in of {int(rank.sum())} rows (the cap is '
                    f'{VALUE_COUNTS_STANDIN_MAX_ROWS}). Set {PREP_STREAM_ENV}=0 on a machine that can '
                    'hold the frame.')
            standin = pd.Series(np.repeat(keys, rank)).value_counts()
            at = {k: i for i, k in enumerate(keys.tolist())}
            order = np.fromiter((at[k] for k in standin.index), dtype=np.int64, count=len(standin))
            if len(order) != len(keys) or not np.array_equal(rank[order], standin.to_numpy()):
                raise CorpusContractError('value_counts() returned the stand-in column with other counts '
                                          'or values than it holds; this pandas is not the one the '
                                          'streamed preparation was written against.')
        return pd.Series(counts[order], index=pd.Index(keys[order], dtype=object), dtype=np.int64)

    def as_dict(self) -> Dict:
        return {str(k): int(v) for k, v in self.value_counts().items()}


def _count_values(hist: Dict, values: pd.Series) -> None:
    if len(values):
        u, c = np.unique(values.to_numpy(dtype=float), return_counts=True)
        for k, v in zip(u.tolist(), c.tolist()):
            hist[k] = hist.get(k, 0) + v


def median_of_counts(hist: Dict) -> float:
    """Series.median() of the values `hist` counts: np.nanmedian of the one or
    two middle values, as nanmedian takes them from the whole column."""
    n = sum(hist.values())
    if n == 0:
        return np.nan
    keys = sorted(hist)
    cum = np.cumsum([hist[k] for k in keys])
    at = lambda i: keys[int(np.searchsorted(cum, i, side='right'))]  # noqa: E731
    middle = [at(n // 2)] if n % 2 else [at(n // 2 - 1), at(n // 2)]
    return np.nanmedian(np.array(middle, dtype=np.float64))


def _later(a, dates: pd.Series):
    """The later of a date string and the newest of `dates` (string order, as max())."""
    if not len(dates):
        return a
    b = str(dates.max())
    return b if a is None or b > a else a


def _whole_numbers(values: pd.Series, name: str) -> np.ndarray:
    v = pd.to_numeric(values, errors='coerce').to_numpy(dtype=float)
    bad = ~np.isfinite(v) | (np.floor(v) != v) | (np.abs(v) >= 2 ** 31)
    if bad.any():
        raise CorpusContractError(
            f'{int(bad.sum())} training row(s) carry a {name} that is not a whole number '
            f'(e.g. {v[bad][0]!r}). The streamed preparation sums labels and baselines as '
            'integers so that a slice-by-slice sum equals the whole-frame one; it will not '
            f'sum fractions in a different order. Set {PREP_STREAM_ENV}=0 on a machine that '
            'can hold the frame, or find out why the export stopped writing whole numbers.')
    return v


class AlwaysZeroTally:
    """main()'s always-zero venues, groupby(ALWAYS_ZERO_KEYS).busyness_pct.mean()
    == 0 over the rows the time split keeps, from per-key counts and extremes.

    The cutoff is not known while pass 1 runs, so the rows the split could hold
    (realtime rows with a date) wait aside with their dates. A label below 0
    stops the run: with none, a mean of 0 is exactly a minimum and maximum of 0.
    """

    def __init__(self):
        self.keys: Dict[tuple, list] = {}
        self.aside: List[pd.DataFrame] = []

    def add(self, df: pd.DataFrame, aside_dated: bool) -> None:
        d = df[ALWAYS_ZERO_KEYS + ['busyness_pct']]
        if aside_dated:
            is_rt = (pd.to_numeric(df['is_realtime'], errors='coerce') == 1).to_numpy()
            dates = df['observed_date'].astype('string').fillna('').str.strip()
            dated = is_rt & (dates != '').to_numpy()
            if dated.any():
                self.aside.append(d[dated].assign(_date=dates.to_numpy()[dated]))
            d = d[~dated]
        self._merge(d)

    def _merge(self, d: pd.DataFrame) -> None:
        d = d.dropna(subset=ALWAYS_ZERO_KEYS + ['busyness_pct'])
        if not len(d):
            return
        y = pd.to_numeric(d['busyness_pct'], errors='coerce')
        if (y < 0).any():
            raise CorpusContractError(
                f'{int((y < 0).sum())} training row(s) carry a negative busyness_pct. The '
                'streamed preparation finds always-zero venues from each venue\'s lowest and '
                f'highest label, which is exact only for labels of 0 and up. Set {PREP_STREAM_ENV}=0 '
                'on a machine that can hold the frame, or fix the export.')
        g = d.assign(busyness_pct=y).groupby(ALWAYS_ZERO_KEYS, sort=False)['busyness_pct'].agg(
            ['count', 'min', 'max'])
        for key, c, lo, hi in zip(g.index, g['count'].tolist(), g['min'].tolist(), g['max'].tolist()):
            cur = self.keys.get(key)
            if cur is None:
                self.keys[key] = [c, lo, hi]
            else:
                cur[0] += c
                cur[1] = min(cur[1], lo)
                cur[2] = max(cur[2], hi)

    def finish(self, from_date):
        if self.aside:
            a = pd.concat(self.aside, ignore_index=True)
            self.aside = []
            if from_date:
                a = a[a['_date'].to_numpy() < from_date]
            self._merge(a.drop(columns='_date'))
        zero = [k for k, (c, lo, hi) in self.keys.items() if c > 0 and lo == 0 and hi == 0]
        return pd.MultiIndex.from_tuples(zero, names=ALWAYS_ZERO_KEYS) if zero else []


def _filter_training_rows(frame: pd.DataFrame, from_date, always_zero, split: Dict = None,
                          shared: Dict = None) -> pd.DataFrame:
    """main()'s row filters on one slice: the time split, null labels, always-zero
    venues. `split`, when given, collects the split's record and the row counts.

    `shared` (pass 3): main() drops the always-zero venues through set_index and
    reset_index, which leaves every row of a city or venue_category on one str
    object for the whole frame (shared_strings). Dropping them slice by slice
    would leave one per slice, so the two columns are put back on one object
    per value across all slices, the first one seen, as the whole frame's index
    keeps the first one it meets.
    """
    if from_date:
        held, live = time_holdout_masks(frame, from_date)
        if split is not None:
            split['held'] += int(held.sum())
            split['held_live'] += int(live.sum())
            split['held_city'].add(frame.loc[held, 'city'])
        frame = frame[~held]
    if split is not None:
        split['kept_live'] = _later(split['kept_live'], _live_dates(frame))
    frame = frame.dropna(subset=['busyness_pct'])
    if split is not None:
        split['after_null'] += len(frame)
    if len(always_zero) > 0:
        if shared is not None:
            for c in ('city', 'venue_category'):
                table = shared.setdefault(c, {})
                for u in pd.factorize(frame[c].to_numpy(dtype=object))[1]:
                    table.setdefault(u, u)
        frame = drop_always_zero_venues(frame, always_zero)
        if shared is not None:
            for c in ('city', 'venue_category'):
                values = frame[c].to_numpy(dtype=object)
                codes, uniques = pd.factorize(values)
                one = np.array([shared[c][u] for u in uniques], dtype=object)
                values = np.where(codes >= 0, one[np.maximum(codes, 0)] if len(one) else values, values)
                frame[c] = pd.Series(values, index=frame.index, dtype=frame[c].dtype)
    return frame



class StreamFits:
    """Pass 2: the tables main() fits on the whole training frame, from its
    filtered rows a slice at a time, and what pass 3 needs to size X.

    Row positions count the training frame's rows after main()'s filters (time
    split, null labels, always-zero venues), in frame order.
    """

    def __init__(self, capacity: int):
        self.n = 0
        self.categories = set()
        self.hist: Dict[str, Dict] = {c: {} for c in ('price_level', 'rating', 'review_count')}
        self.types = [ValueTally() for _ in range(3)]
        self.observed: List[pd.DataFrame] = []
        self.grid_ids: Dict[str, int] = {}
        self.grid_sum = np.zeros((0, 168), dtype=np.int64)
        self.grid_count = np.zeros((0, 168), dtype=np.int32)
        self.grid_weekly = np.zeros((0, 168), dtype=bool)
        self.cat_parts: List[pd.DataFrame] = []
        self.cat_total = 0
        self.cat_rows = 0
        self.live: List[pd.DataFrame] = []
        self.norm_keys: Dict[str, int] = {}
        # Per row, what decides whether it reaches X and its cold_outdoor
        # (predict): its baseline, grid cell, provenance and weather.
        self.base = np.zeros(capacity, dtype=np.int32)
        self.gv = np.full(capacity, -1, dtype=np.int32)
        self.slot = np.full(capacity, -1, dtype=np.int16)
        self.flags = np.zeros(capacity, dtype=np.uint8)
        self.nkey = np.full(capacity, -1, dtype=np.int16)

    def _grow(self, n_venues: int) -> None:
        if n_venues <= len(self.grid_sum):
            return
        size = max(n_venues, 2 * len(self.grid_sum))
        for name in ('grid_sum', 'grid_count', 'grid_weekly'):
            old = getattr(self, name)
            new = np.zeros((size, 168), dtype=old.dtype)
            new[:len(old)] = old
            setattr(self, name, new)

    def add(self, df: pd.DataFrame) -> None:
        n, p0 = len(df), self.n
        self.n += n
        if n == 0:
            return
        y = _whole_numbers(df['busyness_pct'], 'busyness_pct')
        base = _whole_numbers(df['baseline_busyness'].fillna(0), 'baseline_busyness')

        # Venue fills and encodings (fit_venue_features).
        self.categories.update(df['venue_category'].dropna().unique().tolist())
        for c, hist in self.hist.items():
            _count_values(hist, df[c].dropna())
        for k, tally in enumerate(self.types):
            tally.add(df[f'google_type_{k + 1}'].dropna())

        # Climate norms: the rows that carry a reading, in frame order (fit_temperature_norms).
        self.observed.append(df.loc[df['temperature'].notna().to_numpy(), ['latitude', 'month', 'temperature']])

        # The smoothing grid (fit_baseline_grid, slot_has_baseline_row): each
        # (venue, slot) cell's baseline sum and row count, and the weekly slots.
        dow = pd.to_numeric(df['day_of_week'], errors='coerce').to_numpy(dtype=float)
        hour = pd.to_numeric(df['hour'], errors='coerce').to_numpy(dtype=float)
        cell = df['venue_id'].notna().to_numpy() & ~np.isnan(dow) & ~np.isnan(hour)
        on_grid = (dow >= 0) & (dow <= 6) & (hour >= 0) & (hour <= 23)
        if (cell & ~on_grid).any():
            raise CorpusContractError(
                f'{int((cell & ~on_grid).sum())} rows fall outside the 7x24 week grid — '
                'day_of_week must be 0-6 and hour 0-23.')
        if (cell & ((np.floor(dow) != dow) | (np.floor(hour) != hour))).any():
            raise CorpusContractError(
                'a training row has a fractional day_of_week or hour; the streamed preparation '
                f'smooths baselines on whole 7x24 slots only. Set {PREP_STREAM_ENV}=0 or fix the export.')
        i = np.flatnonzero(cell)
        codes, uniques = pd.factorize(df['venue_id'].astype(str).to_numpy()[i])
        ids = np.fromiter((self.grid_ids.setdefault(u, len(self.grid_ids)) for u in uniques),
                          dtype=np.int64, count=len(uniques))
        g = ids[codes]
        s = (dow[i] * 24 + hour[i]).astype(np.int64)
        self._grow(len(self.grid_ids))
        np.add.at(self.grid_sum, (g, s), base[i].astype(np.int64))
        np.add.at(self.grid_count, (g, s), 1)
        weekly = (pd.to_numeric(df['is_realtime'], errors='coerce').fillna(0).to_numpy() != 1)[i]
        self.grid_weekly[g[weekly], s[weekly]] = True
        self.gv[p0 + i] = g
        self.slot[p0 + i] = s

        # Category maps (build_category_baseline_maps): label sums per cell, with a
        # missing price or rating in its own tier until the training median settles it.
        vendor = vendor_provenance_mask(df)
        d = df.loc[vendor, ['venue_category', 'day_of_week', 'hour']].copy()
        price, rating = df.loc[vendor, 'price_level'], df.loc[vendor, 'rating']
        d['_tier'] = np.where(price.isna().to_numpy(), 2, (price >= 2).to_numpy().astype(np.int64))
        d['_pop'] = np.where(rating.isna().to_numpy(), 2, (rating >= 4.3).to_numpy().astype(np.int64))
        d['busyness_pct'] = y[vendor].astype(np.int64)
        self.cat_total += int(d['busyness_pct'].sum())
        self.cat_rows += len(d)
        self.cat_parts.append(d.groupby(['venue_category', 'day_of_week', 'hour', '_tier', '_pop'],
                                        sort=False)['busyness_pct'].agg(['sum', 'count']).reset_index())

        # Live run lengths (live_run_lengths): every live reading, with its position.
        is_rt = (df['is_realtime'].fillna(0).astype(int) == 1).to_numpy()
        live = is_rt & (df['label_provenance'].astype('string').fillna('').str.strip() == 'live').to_numpy()
        if live.any():
            rows = df.loc[live, ['venue_id', 'observed_date', 'hour', 'busyness_pct', 'label_provenance']].copy()
            rows['is_realtime'] = 1
            rows['_pos'] = p0 + np.flatnonzero(live)
            self.live.append(rows)

        # What predict() needs: the row's own baseline, whether exclude_unknown_provenance
        # takes it, and add_weather_features' cold_outdoor inputs.
        self.base[p0:p0 + n] = base.astype(np.int32)
        excluded = is_rt & (df['label_provenance'].fillna('unknown') == 'unknown').to_numpy()
        code = pd.to_numeric(df['weather_condition_code'], errors='coerce').to_numpy(dtype=float)
        clear = (code >= 800) & (code < 801)  # group_weather_code: int(code) == 800
        temp = pd.to_numeric(df['temperature'], errors='coerce').to_numpy(dtype=float)
        observed = ~np.isnan(temp)
        self.flags[p0:p0 + n] = (excluded.astype(np.uint8) | (clear.astype(np.uint8) << 1)
                                 | (observed.astype(np.uint8) << 2)
                                 | ((temp < COLD_OUTDOOR_MAX_TEMP_F).astype(np.uint8) << 3))
        miss = np.flatnonzero(~observed)
        if len(miss):
            keys = temp_norm_keys(latitude_band(df['latitude']), df['month']).to_numpy()[miss]
            codes, uniques = pd.factorize(keys)
            ids = np.fromiter((self.norm_keys.setdefault(u, len(self.norm_keys)) for u in uniques),
                              dtype=np.int64, count=len(uniques))
            self.nkey[p0 + miss] = ids[codes]

    def venue_metadata(self) -> Dict:
        types = ValueTally()
        for tally in self.types:
            types.extend(tally)
        top_types = types.value_counts().head(MAX_GOOGLE_TYPES).index.tolist()
        return venue_feature_metadata(sorted(self.categories), median_of_counts(self.hist['price_level']),
                                      median_of_counts(self.hist['rating']),
                                      median_of_counts(self.hist['review_count']), top_types)

    def temperature_norms(self) -> pd.DataFrame:
        observed = pd.concat(self.observed, ignore_index=True)
        self.observed = []
        return fit_temperature_norms(observed, rows_without=self.n - len(observed))

    def baseline_grid(self) -> Dict:
        nv = len(self.grid_ids)
        total, count = self.grid_sum[:nv], self.grid_count[:nv]
        with np.errstate(invalid='ignore', divide='ignore'):
            means = np.where(count > 0, total / count, np.nan)
        grid = baseline_grid_from_means(list(self.grid_ids), means, self.grid_weekly[:nv].copy())
        self.grid_sum = self.grid_count = self.grid_weekly = None
        return grid

    def category_maps(self, venue_metadata: Dict) -> Dict:
        """build_category_baseline_maps from the per-slice sums."""
        d = pd.concat(self.cat_parts, ignore_index=True)
        self.cat_parts = []
        price_tier = int(venue_metadata['median_price_level'] >= 2)
        popularity = int(venue_metadata['median_rating'] >= 4.3)
        d['_price_tier'] = np.where(d['_tier'] == 2, price_tier, d['_tier']).astype(np.int64)
        d['_popularity'] = np.where(d['_pop'] == 2, popularity, d['_pop']).astype(np.int64)
        coarse = d.groupby(CAT_KEYS)[['sum', 'count']].sum()
        cat = (coarse['sum'] / coarse['count']).round(1).rename('category_baseline').reset_index()
        cat = _smooth_category_hours(cat, ['venue_category', 'day_of_week'])
        fine = d.groupby(REFINED_KEYS)[['sum', 'count']].sum()
        refined = (fine['sum'] / fine['count']).round(1).rename('busyness_pct')
        return {
            'category': cat.set_index(CAT_KEYS)['smooth'],
            'refined': refined,
            'global_mean': round(self.cat_total / self.cat_rows, 1) if self.cat_rows else float('nan'),
        }

    def run_lengths(self, template: pd.DataFrame) -> Tuple[np.ndarray, np.ndarray]:
        """(positions, run lengths) of the live readings (live_run_lengths)."""
        live = pd.concat(self.live, ignore_index=True) if self.live else template
        self.live = []
        if not len(live):
            return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.int32)
        return live['_pos'].to_numpy(dtype=np.int64), live_run_lengths(live)

    def predict(self, grid: Dict, temp_norms: pd.DataFrame) -> Tuple[np.ndarray, np.ndarray]:
        """(which rows reach X, cold_outdoor on each): smooth_baseline_hours, the
        serving filter and exclude_unknown_provenance, and add_weather_features'
        cold_outdoor, row by row from what add() kept."""
        n = self.n
        table, global_mean = temperature_norm_table(temp_norms)
        norm = np.full(len(self.norm_keys), global_mean)
        for key, i in self.norm_keys.items():
            norm[i] = table.get(key, global_mean)
        admitted = unknown_provenance_admitted()
        final = np.zeros(n, dtype=bool)
        cold = np.zeros(n, dtype=bool)
        step = 4_000_000
        for a in range(0, n, step):
            b = min(n, a + step)
            base = self.base[a:b].astype(float)
            gv, slot = self.gv[a:b], self.slot[a:b].astype(np.int64)
            ok = (gv >= 0) & (slot >= 0)
            prev_row, next_row = np.zeros(b - a), np.zeros(b - a)
            has_row = np.zeros(b - a, dtype=bool)
            prev_row[ok] = grid['prev'][gv[ok], slot[ok]]
            next_row[ok] = grid['next'][gv[ok], slot[ok]]
            has_row[ok] = grid['weekly'][gv[ok], slot[ok]]
            keep = serving_population_mask(blend_baseline(base, prev_row, next_row, has_row | (base > 0)))
            flags = self.flags[a:b]
            if not admitted:
                keep &= (flags & 1) == 0
            final[a:b] = keep
            observed = (flags & 4) != 0
            below = (flags & 8) != 0
            imputed = np.flatnonzero(~observed)
            below[imputed] = norm[self.nkey[a:b][imputed]] < COLD_OUTDOOR_MAX_TEMP_F
            cold[a:b] = ((flags & 2) != 0) & below
        self.base = self.gv = self.slot = self.flags = self.nkey = None
        return final, cold


class CellStatsStream:
    """build_category_cell_aggregates over the pre-filter rows and
    index_category_cells over X's rows, a slice of each at a time.

    A key's id is its order of first appearance until finish(), which sorts the
    fitted keys as np.unique sorts them and maps every id onto that order.
    """

    NAMES = (('category', CAT_KEYS), ('refined', REFINED_KEYS))

    def __init__(self, group_col: str = LEAVE_OUT_COL):
        self.group_col = group_col
        self.ids: Dict[str, Dict[str, int]] = {'group': {}, 'category': {}, 'refined': {}}
        self.fitted: Dict[str, set] = {'group': set(), 'category': set(), 'refined': set()}
        self.fit_sums: Dict[str, Dict] = {'category': {}, 'refined': {}}
        self.row_sums: Dict[str, Dict] = {'category': {}, 'refined': {}}
        self.row_group: List[np.ndarray] = []
        self.row_cell: Dict[str, List[np.ndarray]] = {'category': [], 'refined': []}
        self.fit_rows = self.global_sum = self.global_count = self.rows = 0

    @staticmethod
    def _ids(table: Dict, values: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        codes, uniques = pd.factorize(values)
        if (codes < 0).any():
            raise CorpusContractError('a category cell key is missing (NaN) on a training row.')
        ids = np.fromiter((table.setdefault(u, len(table)) for u in uniques), dtype=np.int64,
                          count=len(uniques))
        return ids[codes], ids

    @staticmethod
    def _add(acc: Dict, group: np.ndarray, cell: np.ndarray, y: np.ndarray) -> None:
        finite = np.isfinite(y)
        combo = (group[finite] << 32) | cell[finite]
        if not len(combo):
            return
        keys, inv = np.unique(combo, return_inverse=True)
        sums = np.bincount(inv, weights=y[finite])
        counts = np.bincount(inv)
        for k, s, c in zip(keys.tolist(), sums.tolist(), counts.tolist()):
            cur = acc.get(k)
            if cur is None:
                acc[k] = [int(s), c]
            else:
                cur[0] += int(s)
                cur[1] += c

    def fit(self, frame: pd.DataFrame) -> None:
        d = _cell_fit_frame(frame, vendor_provenance_mask(frame), (self.group_col,))
        group, present = self._ids(self.ids['group'], d[self.group_col].fillna('__unknown__').astype(str).to_numpy())
        self.fitted['group'].update(present.tolist())
        y = d['busyness_pct'].to_numpy(dtype=float)
        self.fit_rows += len(d)
        self.global_sum += int(y[np.isfinite(y)].sum())
        self.global_count += int(d['busyness_pct'].count())
        for name, keys in self.NAMES:
            cell, present = self._ids(self.ids[name], _cell_key_column(d, keys))
            self.fitted[name].update(present.tolist())
            self._add(self.fit_sums[name], group, cell, y)

    def index(self, frame: pd.DataFrame) -> None:
        d = _cell_fit_frame(frame, None, (self.group_col,))
        group, _ = self._ids(self.ids['group'], d[self.group_col].fillna('__unknown__').astype(str).to_numpy())
        self.row_group.append(group.astype(np.int32))
        self.rows += len(d)
        y = d['busyness_pct'].to_numpy(dtype=float)
        for name, keys in self.NAMES:
            cell, _ = self._ids(self.ids[name], _cell_key_column(d, keys))
            self.row_cell[name].append(cell.astype(np.int32))
            self._add(self.row_sums[name], group, cell, y)

    @staticmethod
    def _order(table: Dict[str, int], fitted: set) -> Tuple[np.ndarray, np.ndarray]:
        """(the fitted keys sorted, each id's position among them or -1)."""
        levels = np.array(sorted(k for k, i in table.items() if i in fitted), dtype=object)
        position = np.full(len(table), -1, dtype=np.int64)
        for p, k in enumerate(levels):
            position[table[k]] = p
        return levels, position

    @staticmethod
    def _dense(acc: Dict, gpos: np.ndarray, cpos: np.ndarray, shape) -> Tuple[np.ndarray, np.ndarray]:
        sums = np.zeros(shape, dtype=np.float64)
        counts = np.zeros(shape, dtype=np.int64)
        for k, (s, c) in acc.items():
            sums[gpos[k >> 32], cpos[k & 0xFFFFFFFF]] = s
            counts[gpos[k >> 32], cpos[k & 0xFFFFFFFF]] = c
        return sums, counts

    def finish(self) -> Dict:
        group_levels, gpos = self._order(self.ids['group'], self.fitted['group'])
        row_group = gpos[np.concatenate(self.row_group)] if self.row_group else np.zeros(0, dtype=np.int64)
        self.row_group = []
        if (row_group < 0).any():
            raise CorpusContractError(
                f'{int((row_group < 0).sum())} rows carry a {self.group_col!r} the category '
                'aggregates were never fitted on. The aggregates are fitted on the pre-filter '
                'frame and these rows are a subset of it, so this cannot happen unless the two '
                'came from different runs.')
        agg = cell_stats_header(self.group_col, group_levels, self.fit_rows, float(self.global_sum),
                                self.global_count)
        out = indexed_cell_stats(agg, self.rows, row_group)
        for name, keys in self.NAMES:
            levels, cpos = self._order(self.ids[name], self.fitted[name])
            shape = (len(group_levels), len(levels))
            if any(gpos[k >> 32] < 0 or cpos[k & 0xFFFFFFFF] < 0 for k in self.row_sums[name]):
                raise CorpusContractError(f'rows fall in a {name!r} cell the aggregates were never fitted on.')
            sums, counts = self._dense(self.fit_sums[name], gpos, cpos, shape)
            row_cell = cpos[np.concatenate(self.row_cell[name])] if self.row_cell[name] else np.zeros(0, np.int64)
            self.row_cell[name] = []
            rows_sums, rows_counts = self._dense(self.row_sums[name], gpos, cpos, shape)
            out[name] = indexed_cell_block(name, cell_block(keys, levels, sums, counts), row_cell,
                                           rows_sums, rows_counts)
            logger.info('Per-fold %s baseline aggregates: %d cells x %d %s groups, '
                        'fitted on %d pre-filter rows.',
                        name, len(levels), len(group_levels), self.group_col, self.fit_rows)
        return out


def _concat_parts(parts: List):
    """One array from per-slice pieces of a numpy array or a pandas extension array."""
    if isinstance(parts[0], np.ndarray):
        return np.concatenate(parts)
    return type(parts[0])._concat_same_type(parts)


# STRINGS SHARE OBJECTS IN THE PICKLE (2026-11-25). pickle writes a str once per
# object and refers back to it after, so a carried string column costs about 8 B
# a row to load only while its rows share a handful of str objects. The whole
# read gives them that: pandas' parser makes one object per distinct string per
# parser chunk, every step after keeps those objects, and the streamed slices are
# cut from the same parser chunks, so each carried column holds the same objects
# as main()'s (on the registered export: 437, 1178, 797, 391 and 7811). The one
# object main() picks differently is the str category_cell_stats['groups'] names
# a city by: np.unique takes one of that city's equal objects, the stream the
# first it sees, which moves a pickle memo reference and no value (3 bytes on
# the registered export once X is put back inline; on the 2026-10-08 export the
# bytes are main()'s). shared_strings() checks every carried string column and, should
# a column average fewer than SHARED_STRING_MIN_REUSE rows per object, maps
# equal strings onto one object (values and dtype unchanged), because one object
# per row would add some 25 GB to loading a 90-million-row pickle.
SHARED_STRING_MIN_REUSE = 50


def shared_strings(values, name: str):
    """`values` (an object array or StringArray) with its str objects counted and,
    if they are not shared, made shared."""
    arr = np.asarray(values, dtype=object)
    n_objects = len({id(v) for v in arr if isinstance(v, str)})
    if n_objects * SHARED_STRING_MIN_REUSE <= len(arr):
        logger.info('[stream] %s: %d rows share %d str objects.', name, len(arr), n_objects)
        return values
    one = {}
    shared = np.array([one.setdefault(v, v) if isinstance(v, str) else v for v in arr], dtype=object)
    logger.warning('[stream] %s: %d rows held %d str objects; equal strings now share one of %d.',
                   name, len(arr), n_objects, len(one))
    if isinstance(values, np.ndarray):
        return shared
    return type(values)._from_sequence(shared, dtype=values.dtype)


def main_streamed(train_path: Path, why: str) -> None:
    """main() for a training export too large for one frame (the block above)."""
    import time
    import features_io

    # The masked copies are made by the in-memory preparation only: refused
    # here, before the first of the three passes over the export.
    require_live_mask_copies_possible(streamed=True)
    require_proven_pandas(pd.__version__)
    chunk_rows = _env_count(PREP_CHUNK_ROWS_ENV, DEFAULT_PREP_CHUNK_ROWS)
    pkl_path = SCRIPT_DIR / 'features_train.pkl'
    logger.info('Feature preparation STREAMED (%s): training_data.csv in three passes of %d-row '
                'slices; X is written to %s.', why, chunk_rows, features_io.x_file_for(pkl_path).name)
    started = time.time()
    csv = TrainingCsv(train_path)
    require_export_columns(csv.header, train_path, 'training_data.csv')
    _, holdout_df = read_holdout_csv()

    # The holdout's own audits run first: a final refit trains on its rows as
    # these leave them, exactly as main() concatenates them.
    holdout_weather_stats = recover_weather_codes(holdout_df, 'holdout')
    holdout_calendar_stats = audit_calendar_coverage(holdout_df, 'holdout')
    holdout_label_stats = audit_label_columns(holdout_df, 'holdout')
    holdout_event_types = normalise_event_types(holdout_df, 'holdout')
    final_refit = resolve_final_refit()
    if final_refit:
        fold_holdout_into_refit(final_refit, holdout_df)

    # ── PASS 1: types, the time holdout's cutoff, always-zero venues ─────────
    zero = AlwaysZeroTally()
    bad_coordinates, last_live = 0, None
    for chunk in csv.parser_chunks():
        csv.note(chunk)
        bad_coordinates += coordinate_failures(chunk)
        last_live = _later(last_live, _live_dates(chunk))
        zero.add(chunk, aside_dated=not final_refit)
    csv.settle()
    logger.info(f'Training data: {csv.rows} rows')
    refuse_missing_coordinates(bad_coordinates, train_path, 'training_data.csv')
    last_live = _later(last_live, _live_dates(holdout_df))
    if final_refit:
        zero.add(holdout_df, aside_dated=False)
        time_holdout = {'policy': 'final_refit', 'days': 0, 'from_date': None, 'last_live_date': last_live}
    else:
        time_holdout = time_holdout_from_last_live(last_live)
    from_date = time_holdout['from_date']
    always_zero = zero.finish(from_date)
    logger.info('[stream] pass 1 done in %.0f s: %d parser chunks of %d rows, %d always-zero venues.',
                time.time() - started, -(-csv.rows // csv.parser_rows), csv.parser_rows, len(always_zero))

    holdout_head = holdout_df.iloc[:1]
    capacity = csv.rows + (len(holdout_df) if final_refit else 0)

    def training_frames():
        """(slice, 'train' | 'holdout'): the training frame's rows in order."""
        for frame in csv.frames(chunk_rows, holdout_head if final_refit else None):
            yield frame, 'train'
        if final_refit:
            rows = pd.concat([csv.first_row, holdout_df], ignore_index=True).iloc[len(csv.first_row):]
            rows = rows.reset_index(drop=True)
            for a in range(0, len(rows), chunk_rows):
                yield rows.iloc[a:a + chunk_rows].reset_index(drop=True), 'holdout'

    # ── PASS 2: every whole-frame fit ─────────────────────────────────────────
    neighbors = NeighborTableBuilder()
    live_rows: List[pd.DataFrame] = []
    weather = {'rows': 0, 'code_present_in_export': 0, 'recovered_from_description': 0,
               'no_weather_reading': 0, 'code_notna': 0}
    unmapped = ValueTally()
    calendar = [0, 0, 0]
    labels: Dict = {}
    events = [0, 0, 0, 0]
    event_rows = [0, 0, 0]
    aliased, levels, unknown_types = ValueTally(), ValueTally(), ValueTally()
    split = {'held': 0, 'held_live': 0, 'held_city': ValueTally(), 'kept_live': None, 'after_null': 0}
    fits = StreamFits(capacity)
    live_template = None
    for frame, source in training_frames():
        if source == 'train':
            # The raw tables read every training row before any is dropped, as
            # main() builds them from the raw frames.
            neighbors.add(_unify_with(frame[NEIGHBOR_TABLE_COLS], holdout_head[NEIGHBOR_TABLE_COLS]))
            live = ((pd.to_numeric(frame['is_realtime'], errors='coerce') == 1).to_numpy()
                    & (frame['label_source'].astype('string').fillna('').str.strip() == 'live').to_numpy())
            live_rows.append(frame.loc[live, LIVE_TABLE_COLS])
            counts, rows_unmapped = recover_weather_code_rows(frame)
            for k in weather:
                weather[k] += counts[k]
            unmapped.add(rows_unmapped)
            calendar = [a + b for a, b in zip(calendar, calendar_counts(frame))]
            for k, v in label_audit_counts(frame).items():
                labels[k] = (labels.get(k, set()) | v) if isinstance(v, set) else labels.get(k, 0) + v
            events = [a + b for a, b in zip(events, event_provenance_counts(frame))]
            raw, present, hit, out, unknown = normalise_event_type_rows(frame)
            event_rows = [event_rows[0] + len(frame), event_rows[1] + int(present.sum()),
                          event_rows[2] + int(hit.sum())]
            aliased.add(raw[hit])
            levels.add(out[present])
            unknown_types.add(unknown)
        filtered = _filter_training_rows(frame, from_date, always_zero, split)
        if live_template is None:
            live_template = filtered.iloc[:0][['venue_id', 'observed_date', 'hour', 'busyness_pct',
                                               'label_provenance']]
        fits.add(filtered)
    logger.info('[stream] pass 2 read %d training rows (%d after the filters) in %.0f s.',
                capacity, fits.n, time.time() - started)

    neighbors.add(_unify_with(holdout_df[NEIGHBOR_TABLE_COLS], csv.first_row[NEIGHBOR_TABLE_COLS]))
    neighbor_table = neighbors.finish()
    live_reading_table = build_live_reading_table([pd.concat(live_rows, ignore_index=True), holdout_df],
                                                  neighbor_table)
    live_rows = []
    log_raw_tables(neighbor_table, live_reading_table)
    if LIVE_FEATURE_POLICY == 'off':
        drop_features(LIVE_FEATURE_NAMES, 'FLOCK_LIVE_FEATURES=off (ablation)')

    weather_stats = weather_code_stats(weather, unmapped.value_counts().to_dict(),
                                       weather['code_notna'] / weather['rows'], 'train')
    enforce_weather_contracts(weather_stats, holdout_weather_stats)
    calendar_stats = calendar_coverage_stats(*calendar, 'train')
    enforce_calendar_contracts(calendar_stats, holdout_calendar_stats)
    label_stats = label_audit_stats(labels, 'train')
    enforce_label_contracts(label_stats, holdout_label_stats)
    log_event_provenance(*events, 'train')
    report_event_provenance(holdout_df, 'holdout')
    if unknown_types.counts:
        refuse_event_types('train', unknown_types.as_dict())
    event_type_stats = event_type_record(
        event_type_report(*event_rows, aliased.as_dict(), levels.as_dict(), 'train'),
        holdout_event_types)

    time_holdout.update({
        'realtime_rows_held_out': split['held'], 'live_rows_held_out': split['held_live'],
        'held_out_by_city': split['held_city'].as_dict(), 'training_live_through': split['kept_live'],
    })
    log_time_holdout(time_holdout)
    logger.info(f'After dropping null labels: {split["after_null"]} rows')
    if len(always_zero) > 0:
        logger.info(f'Dropped {split["after_null"] - fits.n} rows from always-zero venues')

    venue_metadata = fits.venue_metadata()
    temp_norms = fits.temperature_norms()
    baseline_grid = fits.baseline_grid()
    cat_baseline_maps = fits.category_maps(venue_metadata)
    run_pos, run_len = fits.run_lengths(live_template.assign(is_realtime=1, _pos=0).iloc[:0])
    reaches_x, cold_pred = fits.predict(baseline_grid, temp_norms)
    n_rows = int(reaches_x.sum())
    cold_constant = n_rows == 0 or bool(cold_pred[reaches_x].min() == cold_pred[reaches_x].max())
    logger.info('[stream] fits done in %.0f s: %d of %d filtered rows reach X.',
                time.time() - started, n_rows, fits.n)
    fit_tables = {'venue_metadata': venue_metadata, 'temp_norms': temp_norms,
                  'cat_maps': cat_baseline_maps, 'baseline_grid': baseline_grid}

    # ── PASS 3: features, a slice at a time, into X ───────────────────────────
    admitted = unknown_provenance_admitted()
    cells = CellStatsStream(LEAVE_OUT_COL)
    carried: Dict[str, List] = {}
    light: Dict[str, List] = {'is_realtime': [], 'label_provenance': [], 'live_run_length': []}
    x_path = None
    feature_cols_all: List[str] = []
    feature_cols: List[str] = []
    missing: pd.Series = None
    lo: Dict[str, object] = {}
    hi: Dict[str, object] = {}
    with_reading = imputed = served_rt = served_unknown = 0
    position = written = 0
    one_object: Dict[str, Dict] = {}
    for frame, source in training_frames():
        if source == 'train':
            recover_weather_code_rows(frame)
            normalise_event_type_rows(frame)
        frame = _filter_training_rows(frame, from_date, always_zero, shared=one_object)
        p0, n = position, len(frame)
        position += n
        if n == 0:
            continue
        frame = add_training_features(frame, neighbor_table, live_reading_table, fit_tables)
        with_reading += int((frame['weather_observed'] == 1).sum())
        imputed += int((frame['weather_observed'] == 0).sum())
        frame = finish_frame(frame)
        frame['baseline_busyness'] = frame['baseline_busyness'].fillna(0)
        frame['delta_label'] = (frame['busyness_pct'] - frame['baseline_busyness']).astype(float)
        cells.fit(frame)
        run_length = np.ones(n, dtype=np.int32)
        a, b = np.searchsorted(run_pos, [p0, p0 + n])
        run_length[run_pos[a:b] - p0] = run_len[a:b]
        frame['live_run_length'] = run_length

        served = serving_population_mask(frame['baseline_busyness'])
        frame = frame[served]
        frame['label_provenance'] = frame['label_provenance'].fillna('unknown')
        unknown, n_rt = unknown_provenance_rows(frame)
        served_rt += n_rt
        served_unknown += int(unknown.sum())
        reached = served.copy()
        if not admitted:
            frame = frame[~unknown]
            reached[np.flatnonzero(served)[unknown]] = False
        if not np.array_equal(reached, reaches_x[p0:p0 + n]):
            raise CorpusContractError(
                f'the streamed preparation built rows {p0}..{p0 + n} of the filtered training frame '
                f'and {int(reached.sum())} reached X where pass 2 predicted '
                f'{int(reaches_x[p0:p0 + n].sum())}. Pass 2 repeats smooth_baseline_hours and '
                'the serving filter row by row; a difference is a bug in that repetition, and '
                f'nothing has been written. {PREP_STREAM_ENV}=0 is the in-memory path.')
        if not len(frame):
            continue
        if x_path is None:
            feature_cols_all = get_feature_columns(frame)
            feature_cols = [c for c in feature_cols_all if not (c == 'cold_outdoor' and cold_constant)]
            x_path, X = features_io.open_x_memmap(pkl_path, n_rows, len(feature_cols))
            del X
            missing = pd.Series(0, index=feature_cols_all, dtype=np.int64)
        if 'cold_outdoor' in feature_cols_all and not np.array_equal(
                frame['cold_outdoor'].to_numpy() == 1, cold_pred[p0:p0 + n][reached]):
            raise CorpusContractError(
                f'cold_outdoor on rows {p0}..{p0 + n} is not what pass 2 predicted from the '
                'temperatures, climate norms and weather codes; a bug in that repetition.')
        # X is mapped for one slice at a time and flushed: a page written through a
        # map stays in this process's working set while the map is open, so a map
        # held across slices would hold all of X in RAM.
        X = np.load(x_path, mmap_mode='r+')
        feature_matrix(frame, feature_cols, out=X[written:written + len(frame)])
        X.flush()
        del X
        written += len(frame)
        for c in feature_cols_all:
            column = frame[c]
            missing[c] += int(column.isna().sum())
            least, most = column.min(), column.max()
            lo[c] = least if c not in lo else min(lo[c], least)
            hi[c] = most if c not in hi else max(hi[c], most)
        for k, v in train_pickle_columns(frame).items():
            carried.setdefault(k, []).append(v)
        light['is_realtime'].append(frame['is_realtime'].to_numpy().astype(np.int8))
        light['label_provenance'].append(frame['label_provenance'].array)
        light['live_run_length'].append(frame['live_run_length'].to_numpy())
        cells.index(frame)
    logger.info('[stream] pass 3 wrote %d rows of X in %.0f s.', written, time.time() - started)
    if written != n_rows or position != fits.n:
        raise CorpusContractError(
            f'the streamed preparation wrote {written} rows of X over {position} filtered rows; pass 2 '
            f'sized X at {n_rows} rows over {fits.n}. Nothing it wrote can be used.')
    if x_path is None:
        raise CorpusContractError('no training row survives the filters; there is nothing to train on.')

    # The grid smoothed the training rows only; the holdout fits its own.
    fit_tables['baseline_grid'] = baseline_grid = None
    train = pd.DataFrame({k: _concat_parts(light.pop(k)) for k in list(light)}, copy=False)
    unknown_train = unknown_provenance_report(served_rt, served_unknown, 'train')
    weekly_weight_policy, run_divisor = assign_sample_weights(train, RUN_LENGTH_POLICY)
    n_rt = log_weight_blend(train, fits.n, weekly_weight_policy)
    check_realtime_labels(train, n_rt, unknown_train)

    add_temp_norm_metadata(venue_metadata, temp_norms)
    weather_imputation = weather_imputation_record(temp_norms, with_reading, imputed)
    holdout_df = featurise_holdout(holdout_df, venue_metadata, temp_norms, cat_baseline_maps,
                                   neighbor_table, live_reading_table, weather_imputation)
    holdout_df['label_provenance'] = holdout_df['label_provenance'].fillna('unknown')
    holdout_df, unknown_holdout = exclude_unknown_provenance(holdout_df, 'holdout')
    unknown_provenance_record = {'train': unknown_train, 'holdout': unknown_holdout,
                                  'env': UNKNOWN_PROVENANCE_ENV}
    holdout_df = align_holdout(holdout_df, feature_cols_all)

    # One key at a time, each key's slices freed as it is joined; the string
    # columns checked for shared objects (shared_strings).
    columns = {}
    for k in list(carried):
        columns[k] = _concat_parts(carried.pop(k))
        if columns[k].dtype == object or isinstance(columns[k], pd.api.extensions.ExtensionArray):
            columns[k] = shared_strings(columns[k], k)
    logger.info(f'Feature count: {len(feature_cols_all)}')
    logger.info(f'Features: {feature_cols_all}')
    delta = pd.Series(columns['y'], dtype=float)
    label = pd.Series(columns['y_actual'], dtype=float)
    logger.info(f'Delta label distribution: mean={delta.mean():.2f}, std={delta.std():.2f}, '
                f'min={delta.min():.0f}, max={delta.max():.0f}')
    logger.info(f'Label (busyness_pct) distribution: mean {label.mean():.1f}, median {label.median():.1f}, '
                f'std {label.std():.1f}, min {label.min()}, max {label.max()}')
    del delta, label

    refuse_missing_feature_values(missing, 'train')
    refuse_unfilled_features(holdout_df, feature_cols_all, 'holdout')

    # The cold_outdoor rule and the dead-slot contract of main(), on each
    # column's least and greatest value over X's rows (no NaN is left by now).
    constant = {c: bool(lo[c] == hi[c]) for c in feature_cols_all}
    final_cols = list(feature_cols_all)
    if 'cold_outdoor' in final_cols and constant['cold_outdoor']:
        drop_features(['cold_outdoor'], 'constant in a training window with no live reading under 41 F')
        final_cols = [c for c in final_cols if c != 'cold_outdoor']
    if final_cols != feature_cols:
        raise CorpusContractError(
            f'X was written with {len(feature_cols)} columns but the cold_outdoor rule leaves '
            f'{len(final_cols)}; pass 2 predicted cold_outdoor wrongly.')
    constant_cols = [c for c in feature_cols if constant[c]]
    dead_slot_record = enforce_dead_slot_contract(constant_cols, feature_cols)

    logger.info('\nSaving artifacts...')
    cell_stats = cells.finish()
    if len(cell_stats['row_group']) != n_rows or len(cell_stats['category']['row_cell']) != n_rows:
        raise CorpusContractError(
            'category_cell_stats row indexes do not match X '
            f'({len(cell_stats["row_group"])} / {len(cell_stats["category"]["row_cell"])} vs {n_rows}).')
    category_baseline_fit = category_baseline_fit_record(cell_stats)

    X = np.load(x_path, mmap_mode='r+')
    x_keys = features_io.finish_x(pkl_path, X)
    del X
    train_data = train_pickle_dict(columns, x_keys, train['sample_weight'].values, run_divisor,
                                   feature_cols, cell_stats)
    with open(pkl_path, 'wb') as f:
        pickle.dump(train_data, f)
    del train_data, columns

    holdout_data = holdout_pickle_dict(holdout_df, feature_cols)
    with open(SCRIPT_DIR / 'features_holdout.pkl', 'wb') as f:
        pickle.dump(holdout_data, f)

    write_model_metadata(
        time_holdout=time_holdout, final_refit=final_refit, weekly_weight_policy=weekly_weight_policy,
        feature_cols=feature_cols, venue_metadata=venue_metadata, cat_baseline_maps=cat_baseline_maps,
        training_rows=n_rows, holdout_rows=len(holdout_df), weather_stats=weather_stats,
        holdout_weather_stats=holdout_weather_stats, calendar_stats=calendar_stats,
        holdout_calendar_stats=holdout_calendar_stats, label_stats=label_stats,
        holdout_label_stats=holdout_label_stats, weather_imputation=weather_imputation,
        event_type_stats=event_type_stats, unknown_provenance_record=unknown_provenance_record,
        constant_cols=constant_cols, dead_slot_record=dead_slot_record,
        category_baseline_fit=category_baseline_fit)

    logger.info(f'Saved features_train.pkl ({n_rows} rows, {len(feature_cols)} features; X in '
                f'{x_keys["X_file"]}, SHA-256 {x_keys["X_sha256"]})')
    logger.info(f'Saved features_holdout.pkl ({len(holdout_df)} rows)')
    logger.info('Saved model_metadata.json')
    logger.info('Done! (streamed, %.0f s)', time.time() - started)


if __name__ == '__main__':
    main()
