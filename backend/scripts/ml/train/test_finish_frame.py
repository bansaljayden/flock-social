"""finish_frame and feature_matrix change memory, never a value, checked on small frames.

WHY THIS FILE EXISTS. Once a frame's last feature is built, prepare_features
drops the columns no later step reads and narrows whole-number feature columns
(finish_frame), and fills X a column at a time (feature_matrix) instead of
through one float64 matrix (2026-11-19). On the 2026-10-08 export that took the
script's peak from 8.1 GB to 5.1 GB with both pickles identical byte for byte.
What would go wrong silently is a later step reading a column that is gone (it
would stop with a KeyError, which is loud) or reading a narrowed one
differently (which is not), so both are pinned here: the steps after the
features give the same answers on the finished frame as on the full one, and
every column main() reads by name after finishing a frame is one it keeps.

Run: python test_finish_frame.py     (no pytest needed)
"""
import inspect
import pickle
import re
import sys
import traceback
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))

import prepare_features as pf  # noqa: E402
from prepare_features import (CARRIED_AFTER_FEATURES, feature_matrix, finish_frame,  # noqa: E402
                              get_feature_columns)


def built_frame() -> pd.DataFrame:
    """A small frame as main() holds it after the last feature: carried, feature and spent columns."""
    n = 24
    rng = np.random.default_rng(7)
    live = np.arange(n) % 3 != 0
    df = pd.DataFrame({
        'city': np.where(np.arange(n) < 12, 'philadelphia', 'nyc'),
        'venue_id': np.arange(n) // 6 + 1,
        'venue_category': np.where(np.arange(n) % 2 == 0, 'bar', 'cafe'),
        'day_of_week': np.arange(n) % 7,
        'hour': 18 + np.arange(n) % 6,
        'price_level': np.where(np.arange(n) % 5 == 0, np.nan, 2.0),
        'rating': 3.9 + (np.arange(n) % 4) / 5,
        'busyness_pct': np.array([40, 40, 40, 55, 60, 60] * 4),
        'baseline_busyness': np.where(np.arange(n) % 8 == 0, 0.0, 45.0),
        'is_realtime': live.astype(int),
        'label_provenance': np.where(live, np.where(np.arange(n) % 7 == 1, 'forecast', 'live'), 'weekly'),
        'label_source': np.where(live, 'live', ''),
        'vendor_forecast_pct': np.nan,
        'events_observed': 0,
        'observed_date': '2026-11-01',
        'weather_observed': (np.arange(n) % 2).astype(int),
        # features: a 0/1 one-hot, a wider whole number, one past float32's
        # exact range, and floats
        'gtype_bar': (np.arange(n) % 2 == 0).astype(int),
        'venue_category_encoded': np.arange(n) * 13,
        'big_whole_number_feature': np.full(n, 16_777_217),
        'hour_sin': np.sin(np.arange(n) * 0.1),
        'temp_anomaly': rng.normal(size=n),
        'cold_outdoor': 0,
        # spent: raw strings, coordinates, intermediates
        'google_type_1': 'bar',
        'weather_group': 'clear',
        'live_local_time': '2026-11-01 18:00',
        'latitude': 39.95,
        'lat_band': 40,
        'has_venue_baseline': 1,
    })
    return df


def test_finish_frame_keeps_every_feature_and_carried_column_and_drops_the_rest():
    df = built_frame()
    out = finish_frame(df)
    features = get_feature_columns(df)
    kept = set(out.columns)
    assert set(features) <= kept, set(features) - kept
    assert {c for c in df.columns if c in CARRIED_AFTER_FEATURES} <= kept
    assert kept - set(features) - CARRIED_AFTER_FEATURES == set(), kept
    for spent in ('google_type_1', 'weather_group', 'live_local_time', 'latitude', 'lat_band',
                  'has_venue_baseline'):
        assert spent not in kept, spent


def test_whole_number_features_narrow_and_nothing_else_changes_type_or_value():
    df = built_frame()
    out = finish_frame(df)
    assert out['gtype_bar'].dtype == np.int8
    assert out['cold_outdoor'].dtype == np.int8
    assert out['venue_category_encoded'].dtype == np.int16
    assert out['big_whole_number_feature'].dtype == np.int32
    # carried whole numbers keep their type: the cell keys and the weight steps read them
    for c in ('hour', 'day_of_week', 'is_realtime', 'weather_observed', 'venue_id'):
        assert out[c].dtype == df[c].dtype, c
    for c in out.columns:
        if out[c].dtype.kind in 'iu':
            assert (out[c].to_numpy(dtype=np.int64) == df[c].to_numpy(dtype=np.int64)).all(), c
        else:
            assert out[c].dtype == df[c].dtype, c
            assert out[c].equals(df[c]), c


def test_the_feature_columns_are_the_same_before_and_after():
    df = built_frame()
    assert get_feature_columns(finish_frame(df)) == get_feature_columns(df)


def test_feature_matrix_is_the_one_line_form_byte_for_byte():
    df = built_frame()
    cols = get_feature_columns(df)
    before = df[cols].values.astype(np.float32)
    after = feature_matrix(finish_frame(df), cols)
    assert after.dtype == np.float32 and after.shape == before.shape
    assert after.flags.f_contiguous == before.flags.f_contiguous
    assert pickle.dumps(after) == pickle.dumps(before)
    assert after[0, cols.index('big_whole_number_feature')] == np.float32(16_777_216)


def test_an_integer_only_selection_rounds_once_as_the_one_line_form_does():
    # With no float column the one-line form interleaves to int64 and rounds
    # each value to float32 once; through float64 this value would round twice.
    big = 2 ** 54 + 2 ** 30 + 1
    df = pd.DataFrame({'gtype_bar': [0, 1, 1], 'big_whole_number_feature': [big, 3, big + 7]})
    cols = ['big_whole_number_feature', 'gtype_bar']
    before = df[cols].values.astype(np.float32)
    after = feature_matrix(finish_frame(df), cols)
    assert pickle.dumps(after) == pickle.dumps(before)
    assert after[0, 0] == np.float32(np.int64(big)), after[0, 0]


def test_a_frame_with_any_other_dtype_is_left_unnarrowed_and_takes_the_one_line_form():
    for odd in (np.array([1.5, 2.5, 3.5], dtype=np.float32), np.array([True, False, True]),
                pd.array([1, 2, 3], dtype='Int64'), np.array([1, 2, 3], dtype=np.uint16)):
        df = pd.DataFrame({'gtype_bar': [0, 1, 1], 'big_whole_number_feature': [2 ** 40 + 1, 3, 9],
                           'odd_feature': odd})
        cols = get_feature_columns(df)
        out = finish_frame(df)
        assert out['gtype_bar'].dtype == np.int64, odd.dtype
        before = df[cols].values.astype(np.float32)
        after = feature_matrix(out, cols)
        assert after.dtype == np.float32 and np.array_equal(after, before), odd.dtype
        assert after.flags.f_contiguous == before.flags.f_contiguous, odd.dtype


def _same(a, b, path='') -> None:
    if isinstance(a, dict):
        assert isinstance(b, dict) and set(a) == set(b), path
        for k in a:
            _same(a[k], b[k], f'{path}.{k}')
    elif isinstance(a, np.ndarray):
        assert isinstance(b, np.ndarray) and a.dtype == b.dtype, path
        assert np.array_equal(a, b, equal_nan=a.dtype.kind == 'f'), path
    elif isinstance(a, (list, tuple)):
        assert len(a) == len(b), path
        for i, (x, y) in enumerate(zip(a, b)):
            _same(x, y, f'{path}[{i}]')
    else:
        assert a == b or (isinstance(a, float) and np.isnan(a) and np.isnan(b)), f'{path}: {a!r} vs {b!r}'


def _steps_after_the_features(df: pd.DataFrame) -> dict:
    """What main() does with a training frame after its last feature, in order."""
    agg = pf.build_category_cell_aggregates(df, pf.LEAVE_OUT_COL)
    df = df.copy()
    df['live_run_length'] = pf.live_run_lengths(df)
    run_lengths = df['live_run_length'].to_numpy()
    df = df[pf.serving_population_mask(df['baseline_busyness'])]
    df, excluded = pf.exclude_unknown_provenance(df, 'train')
    policy, divisor = pf.assign_sample_weights(df, 'on', env={pf.WEEKLY_ANCHOR_WEIGHT_ENV: 'auto'})
    cells = pf.index_category_cells(df, agg)
    return {'aggregates': agg, 'run_lengths': run_lengths, 'excluded': excluded, 'policy': policy,
            'divisor': divisor, 'cells': cells, 'weights': df['sample_weight'].to_numpy(),
            'rows': df.index.to_numpy()}


def test_the_steps_after_the_features_answer_the_same_on_the_finished_frame():
    df = built_frame()
    full = _steps_after_the_features(df)
    _same(full, _steps_after_the_features(finish_frame(df)))
    assert full['run_lengths'].max() > 1, 'the fixture should hold a run of identical live readings'


def test_every_column_main_reads_by_name_after_finishing_a_frame_is_kept():
    src = inspect.getsource(pf.main)
    made_later = {'delta_label', 'live_run_length', 'sample_weight'}

    def kept(name: str) -> bool:
        return (name in CARRIED_AFTER_FEATURES or name in made_later
                or get_feature_columns(pd.DataFrame(columns=[name])) == [name])

    for frame, marker in (('train_df', 'train_df = finish_frame(train_df)'),
                          ('holdout_df', 'holdout_df = finish_frame(holdout_df)')):
        assert src.count(marker) == 1, marker
        tail = src[src.index(marker) + len(marker):]
        names = set(re.findall(frame + r"\[\s*'(\w+)'\s*\]", tail))
        if frame == 'holdout_df':
            keep_extra = re.search(r'keep_extra = \[(.*?)\]', tail, re.S)
            assert keep_extra, 'keep_extra not found after the holdout is finished'
            names |= set(re.findall(r"'(\w+)'", keep_extra.group(1)))
        assert names, frame
        missing = sorted(n for n in names if not kept(n))
        assert not missing, f'{frame} reads {missing} after finish_frame dropped them'


def main():
    tests = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith('test_') and callable(fn)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f'PASS  {name}')
        except Exception:  # noqa: BLE001 - report every failure, then exit non-zero
            failed += 1
            print(f'FAIL  {name}')
            traceback.print_exc()
    print(f'\n{len(tests) - failed}/{len(tests)} passed')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
