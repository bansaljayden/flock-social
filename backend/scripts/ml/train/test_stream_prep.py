"""The streamed preparation writes what main() writes, checked on a synthetic export.

WHY THIS FILE EXISTS. A training export of tens of millions of rows does not fit
this project's training PC as one frame, so above FLOCK_PREP_STREAM_MIN_ROWS
rows (or with FLOCK_PREP_STREAM=1) prepare_features.main() hands the run to
main_streamed(), which reads the CSV in slices and writes X to a memory-mapped
.npy beside features_train.pkl. Nothing about that may change a number. A slice
can answer differently from the whole frame in three quiet ways: pandas infers
a column's type per parser chunk (review_count int64 in one chunk and float64 in
the next; a cell key '5' or '5.0'), a sum taken in a different order, and a
value_counts tie broken by a different first appearance. The export built here
holds each of those traps on purpose, across three 16,384-row parser chunks,
and both preparations run on it: model_metadata.json and features_holdout.pkl
must be byte-identical, and every key of features_train.pkl equal (X compared
bit for bit, read through features_io.load_features).

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
final refit, and with cold_outdoor constant (dropped before X is written).

Run: python test_stream_prep.py     (no pytest needed; under a minute)
"""
import gc
import json
import os
import pickle
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
DROPPED0, REASONS0 = set(pf.DROPPED_FEATURES), dict(pf.DROP_REASONS)
TYPES = [f't{k:02d}' for k in range(36)]
CITIES = {'philly': (39.95, -75.16), 'nyc': (40.73, -73.99), 'lehigh': (40.60, -75.47)}
DESCRIPTIONS = ['clear sky', 'few clouds', 'light rain', 'overcast clouds', 'snow', 'mist', 'thunderstorm']


def _dow(d: date) -> int:
    return (d.weekday() + 1) % 7  # Sun=0


def write_export(folder: Path, cold: bool = True) -> None:
    """training_data.csv (40,000 rows), holdout_data.csv, sports_events.csv and holidays.json."""
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
    for j in range(2400):
        vid = 1001 + j % 12
        is_rt = j % 3 != 0
        d = start + timedelta(days=(j // 12) // 24)   # one row per (venue, date, hour)
        hour = (j // 12) % 24
        dow = _dow(d) if is_rt else (j // 24) % 7
        base = (vid * 13 + hour * 5) % 80
        k = j % 20
        source = (['live'] * 12 + ['forecast'] * 3 + [''] * 5)[k] if is_rt else ''
        values = dict(zip(pf.EXPORT_COLUMNS, [''] * len(pf.EXPORT_COLUMNS)))
        values.update({
            'venue_id': vid, 'day_of_week': dow, 'hour': hour, 'month': 11, 'season': 'fall', 'is_holiday': 0,
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


def run(folder: Path, stream: bool, chunk_rows: int = 0, refit: Path = None) -> Path:
    """One preparation of the export in `folder`; its outputs moved to a fresh folder."""
    models = folder.parent / 'models'
    models.mkdir(exist_ok=True)
    (models / 'model_metadata.json').unlink(missing_ok=True)
    for f in ('features_train.pkl', 'features_holdout.pkl', 'features_train.X.npy'):
        (folder / f).unlink(missing_ok=True)
    pf.DROPPED_FEATURES.clear()
    pf.DROPPED_FEATURES.update(DROPPED0)
    pf.DROP_REASONS.clear()
    pf.DROP_REASONS.update(REASONS0)
    env = {'FLOCK_PREP_STREAM': '1' if stream else '0', 'FLOCK_PREP_CHUNK_ROWS': str(chunk_rows or 1),
           'FLOCK_WEEKLY_ANCHOR_WEIGHT': 'auto', 'FLOCK_FINAL_REFIT': str(refit) if refit else ''}
    saved = {k: os.environ.get(k) for k in env}
    os.environ.update(env)
    pf.SCRIPT_DIR, pf.MODELS_DIR = folder, models
    try:
        pf.main()
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
    del X_d, X_s, d, s, raw
    gc.collect()


class Export:
    """One synthetic export in a temporary folder, removed when the run ends."""

    def __init__(self, cold=True):
        self.root = Path(tempfile.mkdtemp(prefix='stream_prep_'))
        self.train = self.root / 'ml' / 'train'
        self.train.mkdir(parents=True)
        write_export(self.train, cold=cold)

    def close(self):
        gc.collect()
        shutil.rmtree(self.root, ignore_errors=True)


EXPORTS = {}


def export(cold=True) -> Export:
    if cold not in EXPORTS:
        EXPORTS[cold] = Export(cold)
    return EXPORTS[cold]


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


def test_value_tally_counts_and_breaks_ties_as_value_counts_does():
    rng = np.random.default_rng(3)
    values = pd.Series(rng.choice(['a', 'b', 'c', 'd', 'e', 'f'], size=600).tolist())
    tally = pf.ValueTally()
    for a in range(0, 600, 97):
        tally.add(values.iloc[a:a + 97])
    want = values.value_counts()
    got = tally.value_counts()
    assert list(want.index) == list(got.index) and list(want) == list(got)
    tie = pd.Series(['x', 'y', 'y', 'x', 'z'])
    t = pf.ValueTally()
    t.add(tie.iloc[:2])
    t.add(tie.iloc[2:])
    assert list(t.value_counts().index) == list(tie.value_counts().index) == ['x', 'y', 'z']


def test_median_of_counts_is_series_median():
    rng = np.random.default_rng(5)
    for n in (1, 2, 3, 10, 11, 999, 1000):
        v = pd.Series(rng.choice([1.0, 2.0, 2.5, 3.0, 4.6, 4.7, 10.0], size=n))
        hist = {}
        pf._count_values(hist, v)
        got, want = pf.median_of_counts(hist), v.median()
        assert got == want, (n, got, want)
    assert np.isnan(pf.median_of_counts({}))


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


def test_streamed_equals_in_memory_in_slices_smaller_and_larger_than_a_parser_chunk():
    e = export()
    default = run(e.train, stream=False)
    meta = json.loads((default / 'model_metadata.json').read_text())
    assert meta['time_holdout']['realtime_rows_held_out'] > 0, 'the fixture must hold rows out'
    assert 'cold_outdoor' in meta['feature_names'], 'cold_outdoor should vary in this export'
    assert len(meta['top_google_types']) == 30
    for rows in (2999, 20000):
        compare(default, run(e.train, stream=True, chunk_rows=rows))


def test_streamed_equals_in_memory_on_a_final_refit():
    e = export()
    gated = e.root / 'gated_metadata.json'
    gated.write_text(json.dumps({'ship_gate': {'overall_pass': True}, 'model_version': 'v-test'}))
    default = run(e.train, stream=False, refit=gated)
    assert json.loads((default / 'model_metadata.json').read_text())['time_holdout']['policy'] == 'final_refit'
    compare(default, run(e.train, stream=True, chunk_rows=4096, refit=gated))


def test_streamed_equals_in_memory_when_cold_outdoor_is_constant_and_dropped():
    e = export(cold=False)
    default = run(e.train, stream=False)
    assert 'cold_outdoor' not in json.loads((default / 'model_metadata.json').read_text())['feature_names']
    compare(default, run(e.train, stream=True, chunk_rows=7001))


def main():
    tests = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith('test_') and callable(fn)]
    failed = 0
    try:
        for name, fn in tests:
            try:
                fn()
                print(f'PASS  {name}')
            except Exception:  # noqa: BLE001 - report every failure, then exit non-zero
                failed += 1
                print(f'FAIL  {name}')
                traceback.print_exc()
    finally:
        for e in EXPORTS.values():
            e.close()
    print(f'\n{len(tests) - failed}/{len(tests)} passed')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
