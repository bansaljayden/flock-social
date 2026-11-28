"""The streamed preparation writes what main() writes, checked on a synthetic export.

WHY THIS FILE EXISTS. A training export of tens of millions of rows does not fit
this project's training PC as one frame, so above FLOCK_PREP_STREAM_MIN_ROWS
rows (or with FLOCK_PREP_STREAM=1) prepare_features.main() hands the run to
main_streamed(), which reads the CSV in slices of FLOCK_PREP_CHUNK_ROWS rows and
writes X to a memory-mapped .npy beside features_train.pkl. Nothing about that
may change a number. A slice can answer differently from the whole frame in
three quiet ways: pandas infers a column's type per parser chunk (review_count
int64 in one chunk and float64 in the next; a cell key '5' or '5.0'), a sum
taken in a different order, and a value_counts tie broken by a different first
appearance. The export built here holds each of those traps on purpose, across
three 16,384-row parser chunks, and both preparations run on it:
model_metadata.json and features_holdout.pkl must be byte-identical, and every
key of features_train.pkl equal (X compared bit for bit, read through
features_io.load_features). With X put back inline, features_train.pkl must be
the in-memory bytes too, which holds only while every string column shares its
str objects as the in-memory frame's do: pickle writes a string once per object,
and one object per row would add tens of GB to loading a 90-million-row pickle.

The traps: a weekly-only first parser chunk (observed_date, label_source and
temperature all empty there, so float64 in that chunk and str or float in the
whole read); review_count missing in the second chunk only and price_level in
the third; day_of_week written '3.0' in the second chunk; a column holding
numbers in one chunk and words in another (object in the whole read); 36
Google types with near-equal counts so the top 30 is decided by ties;
legacy event types and holdout cities with tied counts; venues whose rows
cross every slice boundary; realtime and weekly rows interleaved; live runs
across slice boundaries; live dates on both sides of the time-holdout cutoff;
an always-zero venue and one that is always zero only once its held-out row
is cut. Each runs with slices smaller and larger than a parser chunk, as a
final refit, and with cold_outdoor constant (dropped before X is written). A
fourth export moves the newest live reading into a holdout city, where only a
cutoff that reads the holdout too (main() reads both frames) keeps the training
rows of the days between the two dates.

Both preparations share their per-row functions, so a change to one of those
(a smoothing coefficient, say) would move both alike and pass every comparison
above. The in-memory outputs are therefore also pinned to GOLDENS: a SHA-256 of
every value, key by key (X's bytes, each array's dtype, shape and bytes, each
string, the metadata JSON), written by the code from before the streamed path
(prepare_features.py at 4b75d34d) on these same exports. A value that moves
fails the check, naming the key, while numpy and pandas are the versions the
goldens record. Under other versions a moved value is reported as SKIP, not
FAIL, since a library can change a number without this code changing; rewrite
the goldens from the pre-refactor code under the new versions to pin it again:

    git show 4b75d34d:backend/scripts/ml/train/prepare_features.py > <dir>/pf_ref.py
    python test_stream_prep.py --write-goldens <dir>/pf_ref.py

The streamed mode runs only under a pandas in PREP_STREAM_PROVEN_PANDAS
(requirements.txt pins it): this suite is the proof for a version, so it must
pass under it before the version is added. Under pandas 2.2.3 it does not
(TrainingCsv types a True/False column differently from read_csv). The order of
tied counts is the one part checked against both: pandas 3 sorts value_counts()
stably and pandas 2 does not, and ValueTally must give the running version's
order at the top-30 boundary of the Google types.

Run: python test_stream_prep.py     (no pytest needed; about a minute)
"""
import csv
import gc
import hashlib
import importlib.util
import json
import os
import pickle
import platform
import shutil
import sys
import tempfile
import traceback
from datetime import date, timedelta
from pathlib import Path

os.environ.setdefault('FLOCK_CALENDAR_POLICY', 'drop')
os.environ.setdefault('FLOCK_DEAD_SLOT_POLICY', 'warn')
os.environ.setdefault('FLOCK_MIN_REALTIME_ROWS', '1')

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

sys.path.insert(0, str(Path(__file__).parent))

import features_io  # noqa: E402
import prepare_features as pf  # noqa: E402

HERE = Path(__file__).parent
GOLDENS = HERE / 'test_stream_prep_goldens.json'
# Each module's DROPPED_FEATURES and DROP_REASONS as imported: main() adds to
# both, so every run starts from these.
INITIAL = {id(pf): (set(pf.DROPPED_FEATURES), dict(pf.DROP_REASONS))}
TYPES = [f't{k:02d}' for k in range(36)]
CITIES = {'philly': (39.95, -75.16), 'nyc': (40.73, -73.99), 'lehigh': (40.60, -75.47)}
DESCRIPTIONS = ['clear sky', 'few clouds', 'light rain', 'overcast clouds', 'snow', 'mist', 'thunderstorm']


def _dow(d: date) -> int:
    return (d.weekday() + 1) % 7  # Sun=0


def write_export(folder: Path, cold: bool = True, late_holdout_live: date = None) -> None:
    """training_data.csv (40,000 rows), holdout_data.csv, sports_events.csv and holidays.json.
    With late_holdout_live, the holdout's last live row is moved to that date."""
    rng = np.random.default_rng(20261125)
    venues = []
    for vid in range(1, 121):
        city = list(CITIES)[vid % 3]
        lat0, lng0 = CITIES[city]
        venues.append({'venue_id': vid, 'city': city, 'cat': ['bar', 'cafe', 'nightclub', 'restaurant'][vid % 4],
                       'lat': round(lat0 + (vid % 7) * 0.004, 6), 'lng': round(lng0 - (vid % 5) * 0.004, 6),
                       'price': [1, 2, 3, 2][vid % 4], 'rating': [3.9, 4.3, 4.6, ''][vid % 4],
                       'curve': rng.integers(0, 90, size=168)})
    venues[6]['curve'][:] = 0   # venue 7: always zero
    venues[7]['curve'][:] = 0   # venue 8: always zero once its held-out reading is cut
    weekly = [(v, s) for v in venues for s in range(168)]
    first = 16384
    order = rng.permutation(len(weekly))
    chunk0 = [weekly[i] for i in order[:first]]
    rest_weekly = [weekly[i] for i in order[first:]]

    start = date(2025, 11, 1)
    # Venue 8's one non-zero reading falls after the cutoff (2025-11-17).
    realtime = [(venues[7], date(2025, 11, 30), 5), (venues[7], date(2025, 11, 3), 9)]
    seen = {(8, date(2025, 11, 30), 5), (8, date(2025, 11, 3), 9)}
    while len(realtime) < 40_000 - len(weekly):
        v = venues[int(rng.integers(0, len(venues)))]
        d = start + timedelta(days=int(rng.integers(0, 30)))
        h = int(rng.integers(0, 24))
        if (v['venue_id'], d, h) in seen:
            continue
        seen.add((v['venue_id'], d, h))
        realtime.append((v, d, h))
    # Live runs: one venue-day of identical consecutive-hour readings, kept apart in the file.
    rows = [('w', v, s) for v, s in chunk0]
    tail = [('w', v, s) for v, s in rest_weekly] + [('r', v, (d, h)) for v, d, h in realtime]
    tail = [tail[i] for i in rng.permutation(len(tail))]
    rows += tail

    header = ','.join(pf.EXPORT_COLUMNS)
    lines = [header]
    for i, (kind, v, where) in enumerate(rows):
        chunk = 0 if i < 16384 else (1 if i < 32768 else 2)
        if kind == 'w':
            slot = where
            dow, hour = slot // 24, slot % 24
            base = int(v['curve'][slot])
            busy = base
            observed, source, prov, vendor = '', '', 'weekly', ''
            temp = hum = wind = rain = desc = ''
            is_rt = 0
        else:
            d, hour = where
            dow = _dow(d)
            base = int(v['curve'][dow * 24 + hour])
            k = (v['venue_id'] * 31 + d.day * 7 + hour) % 20
            busy = int(np.clip(base + (k - 10) * 2, 0, 100))
            if v['venue_id'] in (7, 8):
                busy = 0
            if v['venue_id'] == 8 and d.day == 30 and hour == 5:
                busy = 44   # held out: after it is cut, venue 8 is always zero
            if v['venue_id'] % 10 == 3 and d.day == 12:
                busy = 50   # a run of identical live readings across many hours
            observed = d.isoformat()
            source = (['live'] * 13 + ['forecast'] * 3 + [''] * 4)[k]
            prov = {'live': 'live', 'forecast': 'forecast', 'owner_report': 'owner_report', '': 'unknown'}[source]
            vendor = str(busy) if source == 'forecast' else (str((busy + 7) % 101) if source == 'live' and k % 2 else '')
            t = (30 + (k * 3) % 50) if cold else (45 + (k * 3) % 40)
            temp, hum, wind, rain = f'{t + 0.5}', f'{50 + k}', f'{k % 9}', str(k % 2)
            desc = DESCRIPTIONS[k % len(DESCRIPTIONS)]
            is_rt = 1
        t1 = TYPES[(i * 7) % 36]
        t2 = '' if chunk == 1 and i % 2 else TYPES[(i * 11) % 36]
        t3 = '' if chunk == 0 else TYPES[(i * 13) % 36]
        review = '' if (chunk == 1 and i % 9 == 0) else str(100 + v['venue_id'] * 3)
        price = '' if (chunk == 2 and i % 11 == 0) else str(v['price'])
        net = ['music', 'sports', 'arts', 'other', 'concert', 'film', 'family', ''][i % 8]
        dow_text = f'{dow}.0' if chunk == 1 else str(dow)
        event_type = str(i % 5) if chunk == 0 else ('' if chunk == 2 else ['gig', 'match'][i % 2])
        live_open = ('True' if i % 2 else 'False') if chunk == 1 else ''
        live_hour = str(hour) if chunk == 1 else ''
        has_event = i % 3 == 0
        values = {
            'venue_id': v['venue_id'], 'day_of_week': dow_text, 'hour': hour, 'month': 11, 'season': 'fall',
            'is_holiday': 0, 'is_school_break': 0, 'venue_category': v['cat'], 'price_level': price,
            'rating': v['rating'], 'review_count': review, 'temperature': temp, 'humidity': hum,
            'wind_speed': wind, 'weather_condition': desc, 'weather_condition_code': '', 'is_raining': rain,
            'event_nearby': int(has_event), 'event_distance_km': '0.5' if has_event else '', 'event_size': '',
            'event_type': event_type, 'event_hours_until': '', 'has_nearby_event': int(has_event),
            'nearest_event_distance_km': '0.5' if has_event else '',
            'nearest_event_attendance': str(1000 * (i % 9)) if has_event else '',
            'total_nearby_events': '2' if has_event else '', 'total_nearby_attendance': str(1500 * (i % 9)) if has_event else '',
            'nearest_event_type': net if has_event else '', 'baseline_busyness': base, 'is_realtime': is_rt,
            'busyness_pct': busy, 'city': v['city'], 'google_type_1': t1, 'google_type_2': t2, 'google_type_3': t3,
            'latitude': v['lat'], 'longitude': v['lng'], 'avg_user_crowd': '', 'user_feedback_count': '',
            'avg_prediction_error': '', 'observed_date': observed, 'label_provenance': prov,
            'label_source': source, 'vendor_forecast_pct': vendor, 'events_observed': ['1', '0', ''][i % 3],
            'live_hour_start': live_hour, 'live_venue_open': live_open, 'live_local_time': '',
        }
        lines.append(','.join(str(values[c]) for c in pf.EXPORT_COLUMNS))
    (folder / 'training_data.csv').write_text('\n'.join(lines) + '\n', encoding='utf-8')

    hold = [header]
    sources = ['live'] * 12 + ['forecast'] * 3 + [''] * 5
    last_live_j = max(j for j in range(2400) if j % 3 != 0 and sources[j % 20] == 'live')
    for j in range(2400):
        vid = 1001 + j % 12
        is_rt = j % 3 != 0
        d = start + timedelta(days=(j // 12) // 24)   # one row per (venue, date, hour)
        if late_holdout_live and j == last_live_j:
            d = late_holdout_live   # newer than any training reading: only the holdout has it
        hour = (j // 12) % 24
        dow = _dow(d) if is_rt else (j // 24) % 7
        base = (vid * 13 + hour * 5) % 80
        k = j % 20
        source = sources[k] if is_rt else ''
        values = dict(zip(pf.EXPORT_COLUMNS, [''] * len(pf.EXPORT_COLUMNS)))
        values.update({
            'venue_id': vid, 'day_of_week': dow, 'hour': hour, 'month': d.month,
            'season': 'winter' if d.month == 12 else 'fall', 'is_holiday': 0,
            'is_school_break': 0, 'venue_category': ['bar', 'cafe', 'karaoke'][vid % 3], 'price_level': 2,
            'rating': 4.1, 'review_count': '' if j % 5 == 0 else 300, 'temperature': '71.5' if is_rt else '',
            'humidity': '60' if is_rt else '', 'wind_speed': '3' if is_rt else '',
            'weather_condition': DESCRIPTIONS[j % 4] if is_rt else '', 'is_raining': '0' if is_rt else '',
            'event_nearby': 0, 'has_nearby_event': 0, 'baseline_busyness': base, 'is_realtime': int(is_rt),
            'busyness_pct': min(100, base + k) if is_rt else base, 'city': 'miami',
            'google_type_1': TYPES[j % 36], 'latitude': 25.77 + (vid % 4) * 0.003, 'longitude': -80.19,
            'observed_date': d.isoformat() if is_rt else '',
            'label_provenance': {'live': 'live', 'forecast': 'forecast', '': 'unknown'}[source] if is_rt else 'weekly',
            'label_source': source, 'vendor_forecast_pct': str(min(100, base + k)) if source == 'forecast' else '',
            'events_observed': '1',
        })
        hold.append(','.join(str(values[c]) for c in pf.EXPORT_COLUMNS))
    (folder / 'holdout_data.csv').write_text('\n'.join(hold) + '\n', encoding='utf-8')
    (folder / 'sports_events.csv').write_text(
        'sportsdb_event_id,league,team_key,is_home,event_local_date,event_local_time,venue_lat,venue_lon\n'
        '1:eagles,NFL,eagles,1,2025-11-09,13:00:00,39.9008,-75.1675\n'
        '2:sixers,NBA,sixers,1,2025-11-12,19:00:00,39.9012,-75.1720\n'
        '3:eagles,NFL,eagles,0,2025-11-23,20:15:00,,\n', encoding='utf-8')
    shutil.copyfile(HERE.parent / 'holidays.json', folder.parent / 'holidays.json')


def run(folder: Path, stream: bool, chunk_rows: int = 0, refit: Path = None, module=pf) -> Path:
    """One preparation of the export in `folder` by `module` (this prepare_features
    unless given); its outputs moved to a fresh folder."""
    models = folder.parent / 'models'
    models.mkdir(exist_ok=True)
    (models / 'model_metadata.json').unlink(missing_ok=True)
    for f in ('features_train.pkl', 'features_holdout.pkl', 'features_train.X.npy'):
        (folder / f).unlink(missing_ok=True)
    dropped0, reasons0 = INITIAL[id(module)]
    module.DROPPED_FEATURES.clear()
    module.DROPPED_FEATURES.update(dropped0)
    module.DROP_REASONS.clear()
    module.DROP_REASONS.update(reasons0)
    env = {'FLOCK_PREP_STREAM': '1' if stream else '0', 'FLOCK_PREP_CHUNK_ROWS': str(chunk_rows or 1),
           'FLOCK_WEEKLY_ANCHOR_WEIGHT': 'auto', 'FLOCK_FINAL_REFIT': str(refit) if refit else ''}
    saved = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    module.SCRIPT_DIR, module.MODELS_DIR = folder, models
    try:
        module.main()
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    out = Path(tempfile.mkdtemp(dir=folder.parent))
    for f in ('features_train.pkl', 'features_holdout.pkl', 'features_train.X.npy'):
        if (folder / f).exists():
            shutil.move(str(folder / f), str(out / f))
    shutil.move(str(models / 'model_metadata.json'), str(out / 'model_metadata.json'))
    return out


def same(a, b, path='') -> None:
    """Equal value, type and dtype, recursively; NaN equals NaN."""
    assert type(a) is type(b), f'{path}: {type(a).__name__} vs {type(b).__name__}'
    if isinstance(a, dict):
        assert list(a) == list(b), f'{path}: keys {list(a)} vs {list(b)}'
        for k in a:
            same(a[k], b[k], f'{path}.{k}')
    elif isinstance(a, np.ndarray):
        assert a.dtype == b.dtype and a.shape == b.shape, f'{path}: {a.dtype}{a.shape} vs {b.dtype}{b.shape}'
        if a.dtype.kind == 'O':
            same(list(a), list(b), path)
        else:
            assert np.array_equal(a, b, equal_nan=a.dtype.kind == 'f'), path
    elif isinstance(a, pd.api.extensions.ExtensionArray):
        assert a.dtype == b.dtype and len(a) == len(b), f'{path}: {a.dtype} vs {b.dtype}'
        same(list(np.asarray(a, dtype=object)), list(np.asarray(b, dtype=object)), path)
    elif isinstance(a, (list, tuple)):
        assert len(a) == len(b), f'{path}: length {len(a)} vs {len(b)}'
        for i, (x, y) in enumerate(zip(a, b)):
            same(x, y, f'{path}[{i}]')
    elif isinstance(a, float):
        assert a == b or (np.isnan(a) and np.isnan(b)), f'{path}: {a!r} vs {b!r}'
    else:
        assert a == b or (a != a and b != b), f'{path}: {a!r} vs {b!r}'


def compare(default: Path, streamed: Path) -> None:
    for f in ('model_metadata.json', 'features_holdout.pkl'):
        assert (default / f).read_bytes() == (streamed / f).read_bytes(), f'{f} differs'
    d = features_io.load_features(default / 'features_train.pkl')
    s = features_io.load_features(streamed / 'features_train.pkl', mmap=False, verify=True)
    assert not features_io.x_is_external(d) and features_io.x_is_external(s)
    with open(streamed / 'features_train.pkl', 'rb') as fh:
        raw = pickle.load(fh)
    assert set(raw) == (set(d) - {'X'}) | {features_io.X_FILE_KEY, features_io.X_SHAPE_KEY, features_io.X_SHA_KEY}, \
        sorted(set(raw) ^ set(d))
    X_d, X_s = d.pop('X'), s.pop('X')
    assert X_d.dtype == X_s.dtype == np.float32 and X_d.shape == X_s.shape, (X_d.shape, X_s.shape)
    assert X_d.flags.f_contiguous and X_s.flags.f_contiguous
    assert np.array_equal(X_d.view(np.uint32), X_s.view(np.uint32)), 'X differs'
    for k in (features_io.X_FILE_KEY, features_io.X_SHAPE_KEY, features_io.X_SHA_KEY):
        s.pop(k)
    same(d, s, 'features_train')
    # The string columns share str objects exactly as main()'s do (pickle writes
    # a str once per object), so with X put back inline the bytes are main()'s.
    # X takes y's dtype object: in one pickle every float32 array shares one.
    x_keys = (features_io.X_FILE_KEY, features_io.X_SHAPE_KEY, features_io.X_SHA_KEY)
    rebuilt = {'X': X_s.view(raw['y'].dtype), **{k: v for k, v in raw.items() if k not in x_keys}}
    assert pickle.dumps(rebuilt) == (default / 'features_train.pkl').read_bytes(), \
        'features_train.pkl with X inline is not the in-memory bytes: the string columns share differently'
    del X_d, X_s, d, s, raw, rebuilt
    gc.collect()


class Export:
    """One synthetic export in a temporary folder, removed when the run ends."""

    def __init__(self, **kwargs):
        self.root = Path(tempfile.mkdtemp(prefix='stream_prep_'))
        self.train = self.root / 'ml' / 'train'
        self.train.mkdir(parents=True)
        write_export(self.train, **kwargs)

    def close(self):
        gc.collect()
        shutil.rmtree(self.root, ignore_errors=True)


# The exports (write_export's arguments), and the in-memory runs GOLDENS pins:
# (export, a final refit?).
VARIANTS = {'cold': {}, 'warm': {'cold': False}, 'late': {'late_holdout_live': date(2025, 12, 5)}}
GOLDEN_RUNS = {'cold': ('cold', False), 'cold_refit': ('cold', True), 'warm': ('warm', False),
               'late': ('late', False)}
EXPORTS = {}
IN_MEMORY = {}


def export(variant='cold') -> Export:
    if variant not in EXPORTS:
        EXPORTS[variant] = Export(**VARIANTS[variant])
    return EXPORTS[variant]


def gated_metadata(e: Export) -> Path:
    """The passed gated run a final refit names."""
    gated = e.root / 'gated_metadata.json'
    if not gated.exists():
        gated.write_text(json.dumps({'ship_gate': {'overall_pass': True}, 'model_version': 'v-test'}))
    return gated


def in_memory(name: str, module=pf) -> Path:
    """The in-memory outputs of GOLDEN_RUNS[name] by `module`, prepared once."""
    key = (name, id(module))
    if key not in IN_MEMORY:
        variant, refit = GOLDEN_RUNS[name]
        e = export(variant)
        IN_MEMORY[key] = run(e.train, stream=False, refit=gated_metadata(e) if refit else None, module=module)
    return IN_MEMORY[key]


class Skip(Exception):
    """A check that cannot decide here; main() reports it apart from passes and failures."""


def test_both_paths_refuse_an_export_holding_a_quarantined_reading_before_writing_anything():
    # The label quarantine (check_label_trust, 2026-11-27) is called by main()
    # itself, before either path reads a row: one live row moved into the
    # window must stop the in-memory run and the streamed run alike, with no
    # pickle and no metadata left behind.
    e = Export(**VARIANTS['cold'])
    try:
        path = e.train / 'training_data.csv'
        with open(path, newline='', encoding='utf-8') as fh:
            rows = list(csv.reader(fh))
        header = rows[0]
        src, day = header.index('label_source'), header.index('observed_date')
        live = next(r for r in rows[1:] if r[src] == 'live')
        moved = list(live)
        moved[day] = '2026-11-06'
        with open(path, 'a', newline='', encoding='utf-8') as fh:
            csv.writer(fh, lineterminator='\n').writerow(moved)
        models = e.train.parent / 'models'
        for stream in (False, True):
            try:
                run(e.train, stream=stream)
            except pf.CorpusContractError as err:
                assert 'quarantined window' in str(err), str(err)
            else:
                raise AssertionError(f'stream={stream}: an export holding a quarantined reading was prepared')
            for f in ('features_train.pkl', 'features_holdout.pkl', 'features_train.X.npy'):
                assert not (e.train / f).exists(), f'stream={stream}: {f} was written'
            assert not (models / 'model_metadata.json').exists(), f'stream={stream}: metadata was written'
    finally:
        e.close()


def test_a_prepared_run_records_its_label_trust():
    meta = json.loads((in_memory('cold') / 'model_metadata.json').read_text(encoding='utf-8'))
    trust = meta['corpus_contract']['label_trust']
    assert trust['quarantine']['policy'] == 'refuse' and trust['quarantine']['windows'], trust['quarantine']
    assert trust['repetition']['rows_checked'] > 0 and trust['repetition']['flagged_weeks'] == {}, trust['repetition']


def _canon(v, h) -> None:
    """Feed `v` to the hash `h` as type, dtype, shape and exact value, recursively."""
    if isinstance(v, np.ndarray):
        h.update(f'ndarray {v.dtype.str} {v.shape}|'.encode())
        if v.dtype.kind == 'O':
            for x in v.ravel(order='C'):
                _canon(x, h)
        else:
            h.update(v.tobytes(order='C'))
    elif isinstance(v, pd.api.extensions.ExtensionArray):
        h.update(f'{type(v).__name__} {v.dtype!r} {len(v)}|'.encode())
        for x in np.asarray(v, dtype=object):
            _canon(x, h)
    elif isinstance(v, dict):
        h.update(f'dict {len(v)}|'.encode())
        for k, x in v.items():
            _canon(k, h)
            _canon(x, h)
    elif isinstance(v, (list, tuple)):
        h.update(f'{type(v).__name__} {len(v)}|'.encode())
        for x in v:
            _canon(x, h)
    elif isinstance(v, np.generic):
        h.update(f'{v.dtype.str} {v.item()!r}|'.encode())
    elif v is None or isinstance(v, (bool, int, float, str)):
        h.update(f'{type(v).__name__} {v!r}|'.encode())
    else:
        raise TypeError(f'no fingerprint for {type(v).__module__}.{type(v).__name__}')


def fingerprint(v) -> str:
    h = hashlib.sha256()
    _canon(v, h)
    return h.hexdigest()


def digest(out: Path) -> dict:
    """{name: SHA-256} for model_metadata.json and every key of both pickles."""
    meta = json.loads((out / 'model_metadata.json').read_text(encoding='utf-8'))
    if 'final_refit' in meta:
        meta['final_refit']['gated_metadata_path'] = '<gated_metadata.json>'   # a temporary folder
    # label_trust (2026-11-27) is written by check_label_trust, which the
    # pre-refactor code never ran; its values are pinned in
    # test_label_quarantine.py. With it set aside, every other byte still has
    # to match the goldens.
    meta.get('corpus_contract', {}).pop('label_trust', None)
    got = {'model_metadata.json': hashlib.sha256(json.dumps(meta, sort_keys=True).encode()).hexdigest()}
    for f in ('features_train.pkl', 'features_holdout.pkl'):
        data = features_io.load_features(out / f, mmap=False)
        got.update({f'{f}:{k}': fingerprint(v) for k, v in data.items()})
    return got


def library_versions() -> dict:
    return {'numpy': np.__version__, 'pandas': pd.__version__}


def write_goldens(reference: Path) -> None:
    """GOLDENS from the in-memory outputs of `reference`, the pre-refactor prepare_features.py."""
    spec = importlib.util.spec_from_file_location('prepare_features_reference', reference)
    ref = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ref)
    assert not hasattr(ref, 'main_streamed'), f'{reference} already has the streamed path'
    INITIAL[id(ref)] = (set(ref.DROPPED_FEATURES), dict(ref.DROP_REASONS))
    try:
        runs = {name: digest(in_memory(name, ref)) for name in GOLDEN_RUNS}
    finally:
        for e in EXPORTS.values():
            e.close()
    GOLDENS.write_text(json.dumps({
        'about': 'test_stream_prep.py: SHA-256 of every value the in-memory preparation writes '
                 'on each synthetic export, written by the code from before the streamed path.',
        'made_with': {'prepare_features.py': 'git 4b75d34d',
                      'prepare_features.py sha256': hashlib.sha256(reference.read_bytes()).hexdigest(),
                      'python': platform.python_version(), **library_versions()},
        'runs': runs,
    }, indent=1, sort_keys=True) + '\n', encoding='utf-8', newline='\n')
    print(f'wrote {GOLDENS.name}: {sum(len(v) for v in runs.values())} values over {len(runs)} runs')


def test_the_synthetic_export_holds_the_traps():
    e = export()
    csv = pf.TrainingCsv(e.train / 'training_data.csv')
    assert csv.parser_rows == 16384, csv.parser_rows
    for chunk in csv.parser_chunks():
        csv.note(chunk)
    csv.settle()
    assert csv.rows == 40000 and len(csv.seen['review_count']) == 2 and len(csv.seen['day_of_week']) == 2
    assert csv.final['review_count'] == np.float64 and csv.final['day_of_week'] == np.float64
    assert isinstance(csv.final['google_type_3'], pd.StringDtype) and len(csv.seen['google_type_3']) == 2
    assert isinstance(csv.final['observed_date'], pd.StringDtype)
    assert csv.final['event_type'] == object and csv.final['live_venue_open'] == object


def test_parser_chunks_cast_as_the_whole_read_hold_every_value_of_it():
    e = export()
    path = e.train / 'training_data.csv'
    csv = pf.TrainingCsv(path)
    for chunk in csv.parser_chunks():
        csv.note(chunk)
    csv.settle()
    for rows in (2999, 20000):
        got = pd.concat(list(csv.frames(rows)), ignore_index=True)
        want = pd.read_csv(path, low_memory=True)
        assert list(got.columns) == list(want.columns)
        for c in want.columns:
            assert got[c].dtype == want[c].dtype, (c, got[c].dtype, want[c].dtype)
            same(list(want[c].to_numpy(dtype=object)), list(got[c].to_numpy(dtype=object)), c)


def _tally_in_slices(values: pd.Series, rows: int) -> pd.Series:
    tally = pf.ValueTally()
    for a in range(0, len(values), rows):
        tally.add(values.iloc[a:a + rows])
    return tally.value_counts()


def test_value_tally_counts_and_breaks_ties_as_value_counts_does():
    rng = np.random.default_rng(3)
    values = pd.Series(rng.choice(['a', 'b', 'c', 'd', 'e', 'f'], size=600).tolist())
    want, got = values.value_counts(), _tally_in_slices(values, 97)
    assert list(want.index) == list(got.index) and list(want) == list(got)
    tie = pd.Series(['x', 'y', 'y', 'x', 'z'])
    t = pf.ValueTally()
    t.add(tie.iloc[:2])
    t.add(tie.iloc[2:])
    assert list(t.value_counts().index) == list(tie.value_counts().index) == ['x', 'y', 'z']


def test_value_tally_orders_ties_at_the_top_30_boundary_as_this_pandas_value_counts_does():
    # pandas 3 sorts value_counts() stably, pandas 2 with numpy's quicksort, and
    # the two disagree on which tied type makes the top 30. One case: 36 types
    # first seen t00..t35 with counts default_rng(0).integers(1, 5, 36), where
    # pandas 2.2.3 keeps t08 and a stable sort t05. The tally must give this
    # pandas' order, on the rows the in-memory path counts (a Series built from
    # a list, as fit_venue_features builds it, and a column as read), in slices.
    def rows_for(keys, counts, rng):
        first = list(keys)   # each value's first appearance, in this order
        rest = [k for k, c in zip(keys, counts) for _ in range(int(c) - 1)]
        return first + [rest[i] for i in rng.permutation(len(rest))]

    cases = [([f't{k:02d}' for k in range(36)], np.random.default_rng(0).integers(1, 5, 36))]
    rng = np.random.default_rng(11)
    for n in (17, 31, 36, 64, 300):
        cases.append(([f'g{k:03d}' for k in rng.permutation(n)], rng.integers(1, 4, n)))
    checked = 0
    for keys, counts in cases:
        rows = rows_for(keys, counts, rng)
        for values in (pd.Series(rows), pd.Series(np.array(rows, dtype=object), dtype=object)):
            want = values.value_counts()
            for slice_rows in (7, 100, len(rows)):
                got = _tally_in_slices(values, slice_rows)
                assert list(got.index) == list(want.index) and list(got) == list(want), \
                    (len(keys), slice_rows, list(got.index[:32]), list(want.index[:32]))
                assert got.head(30).index.tolist() == want.head(30).index.tolist()
                checked += 1
    keys, counts = cases[0]
    stable = pd.Series(counts, index=keys).sort_values(ascending=False, kind='stable').head(30).index
    real = pd.Series(rows_for(keys, counts, rng)).value_counts().head(30).index
    print(f'      {checked} tallies in the order pandas {pd.__version__} value_counts() gives; on the '
          f'36-type case its top 30 {"is" if list(real) == list(stable) else "is not"} a stable sort\'s')


def test_median_of_counts_is_series_median():
    rng = np.random.default_rng(5)
    for n in (1, 2, 3, 10, 11, 999, 1000):
        v = pd.Series(rng.choice([1.0, 2.0, 2.5, 3.0, 4.6, 4.7, 10.0], size=n))
        hist = {}
        pf._count_values(hist, v)
        got, want = pf.median_of_counts(hist), v.median()
        assert got == want, (n, got, want)
    assert np.isnan(pf.median_of_counts({}))


def test_string_columns_that_stopped_sharing_objects_are_made_to_share():
    words = ['philly', 'nyc', 'lehigh']
    # One str object per row (each join builds a new one), as a slice that built
    # its own strings would leave.
    rows = np.array([''.join(list(words[i % 3])) if i % 7 else np.nan for i in range(700)], dtype=object)
    per_row = pd.array(rows, dtype='str')
    assert len({id(v) for v in np.asarray(per_row, dtype=object) if isinstance(v, str)}) > 500
    got = pf.shared_strings(per_row, 'cities')
    assert type(got) is type(per_row) and got.dtype == per_row.dtype
    same(list(np.asarray(per_row, dtype=object)), list(np.asarray(got, dtype=object)), 'values')
    assert len({id(v) for v in np.asarray(got, dtype=object) if isinstance(v, str)}) == 3
    shared = pd.array([words[i % 3] for i in range(700)], dtype='str')
    assert pf.shared_strings(shared, 'cities') is shared
    obj = np.array([''.join(list(words[i % 3])) for i in range(700)], dtype=object)
    out = pf.shared_strings(obj, 'event_type')
    assert out.dtype == object and list(out) == list(obj) and len({id(v) for v in out}) == 3


def test_the_mode_is_chosen_by_row_count_unless_set():
    e = export()
    path = e.train / 'training_data.csv'
    assert pf.count_csv_rows(path) == 40000
    assert pf.prep_stream_mode(path, {})[0] is False
    assert pf.prep_stream_mode(path, {'FLOCK_PREP_STREAM_MIN_ROWS': '39999'})[0] is True
    assert pf.prep_stream_mode(path, {'FLOCK_PREP_STREAM': '1'})[0] is True
    assert pf.prep_stream_mode(path, {'FLOCK_PREP_STREAM': '0', 'FLOCK_PREP_STREAM_MIN_ROWS': '1'})[0] is False
    try:
        pf.prep_stream_mode(path, {'FLOCK_PREP_STREAM': 'yes'})
    except pf.CorpusContractError:
        return
    raise AssertionError('a stray FLOCK_PREP_STREAM value was accepted')


def test_the_streamed_mode_refuses_a_pandas_it_has_not_been_proven_under():
    # This suite is the proof, so it must itself run under a proven pandas.
    pf.require_proven_pandas(pd.__version__)
    for version in ('2.2.3', '3.1.0'):
        try:
            pf.require_proven_pandas(version)
        except pf.CorpusContractError:
            continue
        raise AssertionError(f'pandas {version} was accepted')
    e = export()
    proven = pf.PREP_STREAM_PROVEN_PANDAS
    pf.PREP_STREAM_PROVEN_PANDAS = ()
    try:
        run(e.train, stream=True, chunk_rows=5000)
    except pf.CorpusContractError as err:
        assert 'PREP_STREAM_PROVEN_PANDAS' in str(err), err
    else:
        raise AssertionError('main() streamed under a pandas it has not been proven under')
    finally:
        pf.PREP_STREAM_PROVEN_PANDAS = proven
    written = [f for f in ('features_train.pkl', 'features_train.X.npy', 'features_holdout.pkl')
               if (e.train / f).exists()]
    assert not written and not (e.root / 'ml' / 'models' / 'model_metadata.json').exists(), written


def test_streamed_equals_in_memory_in_slices_smaller_and_larger_than_a_parser_chunk():
    e = export()
    default = in_memory('cold')
    meta = json.loads((default / 'model_metadata.json').read_text())
    assert meta['time_holdout']['realtime_rows_held_out'] > 0, 'the fixture must hold rows out'
    assert 'cold_outdoor' in meta['feature_names'], 'cold_outdoor should vary in this export'
    assert len(meta['top_google_types']) == 30
    for rows in (2999, 20000):
        compare(default, run(e.train, stream=True, chunk_rows=rows))


def test_streamed_equals_in_memory_on_a_final_refit():
    e = export()
    default = in_memory('cold_refit')
    assert json.loads((default / 'model_metadata.json').read_text())['time_holdout']['policy'] == 'final_refit'
    compare(default, run(e.train, stream=True, chunk_rows=4096, refit=gated_metadata(e)))


def test_streamed_equals_in_memory_when_cold_outdoor_is_constant_and_dropped():
    e = export('warm')
    default = in_memory('warm')
    assert 'cold_outdoor' not in json.loads((default / 'model_metadata.json').read_text())['feature_names']
    compare(default, run(e.train, stream=True, chunk_rows=7001))


def test_the_cutoff_counts_a_live_reading_that_only_a_holdout_city_has():
    # main() takes the time holdout's cutoff from the newest live reading of the
    # training AND the holdout frame (resolve_time_holdout([train_df, holdout_df])),
    # and so must the stream. Here the holdout's newest live reading (5 December)
    # is five days past training's (30 November): the cutoff is 22 November, and
    # the training rows of 17-21 November, which a cutoff from training's dates
    # alone (17 November) would hold out, stay in training.
    e = export('late')
    cols = ['is_realtime', 'label_source', 'observed_date', 'city']
    train = pd.read_csv(e.train / 'training_data.csv', usecols=cols, dtype=str)
    hold = pd.read_csv(e.train / 'holdout_data.csv', usecols=cols, dtype=str)

    def live(df):
        return df.loc[(df['is_realtime'] == '1') & (df['label_source'] == 'live'), 'observed_date'].dropna()

    assert live(train).max() == '2025-11-30' and live(hold).max() == '2025-12-05'
    realtime = train[train['is_realtime'] == '1']
    held = realtime[realtime['observed_date'] >= '2025-11-22']
    want = {'policy': 'last_days', 'days': 14, 'from_date': '2025-11-22', 'last_live_date': '2025-12-05',
            'realtime_rows_held_out': len(held), 'live_rows_held_out': int((held['label_source'] == 'live').sum()),
            'held_out_by_city': {str(c): int(n) for c, n in held['city'].value_counts().items()},
            'training_live_through': live(train[train['observed_date'].fillna('') < '2025-11-22']).max()}
    assert want['training_live_through'] == '2025-11-21', want
    default = in_memory('late')
    streamed = run(e.train, stream=True, chunk_rows=5000)
    for out in (default, streamed):
        got = json.loads((out / 'model_metadata.json').read_text())['time_holdout']
        assert got == want, f'{out.name}: {got} != {want}'
    compare(default, streamed)
    # The training rows kept: realtime rows run to the day before the cutoff, and
    # each of 17-21 November is there.
    kept = features_io.load_features(streamed / 'features_train.pkl', mmap=False)
    dates = pd.Series(np.asarray(kept['observed_date'], dtype=object)).dropna()
    per_day = dates[dates >= '2025-11-17'].value_counts().sort_index()
    assert list(per_day.index) == [f'2025-11-{d}' for d in range(17, 22)] and per_day.min() > 100, per_day


def test_the_in_memory_path_writes_what_the_pre_refactor_code_wrote():
    goldens = json.loads(GOLDENS.read_text(encoding='utf-8'))
    moved = {}
    for name in GOLDEN_RUNS:
        got, want = digest(in_memory(name)), goldens['runs'][name]
        keys = sorted(k for k in set(got) | set(want) if got.get(k) != want.get(k))
        if keys:
            moved[name] = keys
    if not moved:
        return
    made = {k: goldens['made_with'].get(k) for k in library_versions()}
    if made != library_versions():
        raise Skip(f'values moved {moved} under numpy/pandas {library_versions()}, but the goldens were '
                   f'written under {made}: a library change cannot be told from a code change here. '
                   'Rewrite the goldens from the pre-refactor code (see the docstring) and rerun.')
    raise AssertionError(f'the in-memory outputs no longer match the pre-refactor code: {moved}')


def main():
    if sys.argv[1:2] == ['--write-goldens']:
        write_goldens(Path(sys.argv[2]))
        return 0
    tests = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith('test_') and callable(fn)]
    failed = skipped = 0
    try:
        for name, fn in tests:
            try:
                fn()
                print(f'PASS  {name}')
            except Skip as why:
                skipped += 1
                print(f'SKIP  {name}: {why}')
            except Exception:  # noqa: BLE001 - report every failure, then exit non-zero
                failed += 1
                print(f'FAIL  {name}')
                traceback.print_exc()
    finally:
        for e in EXPORTS.values():
            e.close()
    ran = len(tests) - skipped
    print(f'\n{ran - failed}/{ran} passed' + (f', {skipped} skipped' if skipped else ''))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
