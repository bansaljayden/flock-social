"""Masked copies of the realtime training rows: FLOCK_LIVE_MASK_COPIES.

WHY THIS FILE EXISTS. Four of the model's live features are built from a venue's
past live readings, and when serving has no reading it sends their missing
values (last_live_dev 0, last_live_age_h 99, recent_offset 0, recent_offset_n 0).
The live feed stopped on 2026-11-25, and 98.4% of 2.8.0-starling's realtime
training rows had a reading or an offset, so production now serves a state the
model almost never trained on. prepare_features.py can append, behind a switch
that is off by default, copies of the realtime rows in that state (copy C, "no
reading") and with only the newest reading masked (copy B, "offset only"), and
train_model.py, evaluate_model.py, quick_eval.py and final_refit_gate.py each
know a copy from an original row.

What is pinned here:

  * off (the default) hands the pickle dict back untouched, writes no key and
    no record, and the whole preparation still writes what the goldens of
    test_stream_prep.py pin;
  * on appends exactly the copies the rule calls for, in order, with the masked
    values, and every other per-row value (label, baseline, weight, divisor,
    city, date, curve_prev_hour and every other feature) the source row's;
    weekly rows and rows already at the missing values get none;
  * category_cell_stats grows with the copies, its row statistics recounted and
    its fitted sums and counts untouched, and the trainer accepts it;
  * the trainer still refuses a cell with more ORIGINAL rows than the pre-filter
    frame, a pickle with extra rows and no mark, and any row marked a copy that
    is not one;
  * every number the trainer reported before is still measured on original
    rows, the two copy populations are reported beside them, and the leak scan,
    the weight tiers, the early-stopping split and the search handle the copies;
  * the two refusals in prepare_features.py (live features off, the streamed
    preparation), and the final refit's policy check;
  * an end-to-end miniature (prepare, train 20 small trees, evaluate, point
    gate) on the synthetic export of test_stream_prep.py, off and on.

Run: python test_live_mask_copies.py     (no pytest needed; about a minute)
"""
import copy
import functools
import json
import os
import pickle
import shutil
import sys
import tempfile
import traceback
from pathlib import Path

# The module is imported with both switches at their defaults; each check sets
# the policy it needs on the module (policy()).
for _name in ('FLOCK_LIVE_MASK_COPIES', 'FLOCK_LIVE_FEATURES'):
    os.environ.pop(_name, None)
os.environ.setdefault('FLOCK_CALENDAR_POLICY', 'drop')
os.environ.setdefault('FLOCK_DEAD_SLOT_POLICY', 'warn')
os.environ.setdefault('FLOCK_MIN_REALTIME_ROWS', '1')

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from sklearn.model_selection import GroupKFold  # noqa: E402

sys.path.insert(0, str(Path(__file__).parent))

import features_io  # noqa: E402
import final_refit_gate as frg  # noqa: E402
import prepare_features as pf  # noqa: E402
import test_final_refit as tfr  # noqa: E402
import test_stream_prep as tsp  # noqa: E402
import train_model as tm  # noqa: E402

CITIES = ['alpha', 'bravo', 'charlie']
CATEGORIES = ['bar', 'cafe']
FEATURES = ['category_baseline', 'curve_prev_hour', 'day_of_week', 'hour', 'last_live_age_h',
            'last_live_dev', 'noise', 'recent_offset', 'recent_offset_n', 'refined_category_baseline']
MISSING = {'last_live_dev': 0.0, 'last_live_age_h': 99.0, 'recent_offset': 0.0, 'recent_offset_n': 0.0}
# What a fixture row is, by (hour + 2 x day + venue + city) % 6.
STATES = {0: 'weekly', 1: 'both', 2: 'reading_only', 3: 'offset_only', 4: 'neither', 5: 'forecast_both'}
SWITCHES = ('FLOCK_MAX_DEPTH', 'FLOCK_N_ESTIMATORS', 'FLOCK_HYPERPARAM_SEARCH',
            'FLOCK_EARLY_STOPPING_ROUNDS', 'FLOCK_TRAIN_DEVICE', 'FLOCK_TRAIN_THREADS')
THREADS = 2
SMALL = {'FLOCK_MAX_DEPTH': '3', 'FLOCK_N_ESTIMATORS': '12'}
METRIC_KEYS = ('rmse', 'mae', 'r2', 'median_ae', 'within_5', 'within_10', 'within_15')


class switches:
    """Set the given trainer switches for one block, and put every one back after."""

    def __init__(self, **values):
        self.values = values

    def __enter__(self):
        self.saved = {k: os.environ.get(k) for k in SWITCHES}
        for k in SWITCHES:
            os.environ.pop(k, None)
        os.environ.update(self.values)

    def __exit__(self, *exc):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class policy:
    """prepare_features' two policies for one block (read by main() from the module)."""

    def __init__(self, mask='off', live='on'):
        self.values = {'LIVE_MASK_COPIES_POLICY': mask, 'LIVE_FEATURE_POLICY': live}

    def __enter__(self):
        self.saved = {k: getattr(pf, k) for k in self.values}
        for k, v in self.values.items():
            setattr(pf, k, v)

    def __exit__(self, *exc):
        for k, v in self.saved.items():
            setattr(pf, k, v)


def expect(error, needle, fn):
    try:
        fn()
    except error as err:
        assert needle in str(err), f'{needle!r} not in: {err}'
        return
    raise AssertionError(f'not refused ({needle})')


# ---------------------------------------------------------------------------
# A small frame through the real functions: the category features, the cell
# statistics and the pickle dict are made by prepare_features, the live
# features are set by hand so every state is present.
# ---------------------------------------------------------------------------
def make_frame(seed=27):
    rng = np.random.default_rng(seed)
    rows = []
    for ci, city in enumerate(CITIES):
        for cat in CATEGORIES:
            for venue in range(3):
                served = venue > 0   # venue 0 has no baseline: filtered out, but in the cell fit
                for dow in range(7):
                    for hour in range(14, 24):
                        state = STATES[(hour + 2 * dow + venue + ci) % 6]
                        realtime = state != 'weekly'
                        level = 28 + 6 * ci + 7 * CATEGORIES.index(cat) + hour + 2 * (dow >= 5)
                        busy = level + (rng.normal(0, 7) if realtime else 0)
                        live = dict(MISSING)
                        if state in ('both', 'reading_only', 'forecast_both'):
                            live['last_live_dev'] = float((hour * 3 + dow) % 21 - 10)
                            live['last_live_age_h'] = float(1 + (hour + dow) % 12)
                        if state in ('both', 'offset_only', 'forecast_both'):
                            live['recent_offset'] = float((hour + venue + dow) % 15 - 7)
                            live['recent_offset_n'] = float(2 + hour % 19)
                        forecast = state == 'forecast_both'
                        busy = float(np.clip(round(busy), 0, 100))
                        rows.append({
                            'city': city, 'venue_id': f'{city}-{cat}-{venue}', 'venue_category': cat,
                            'day_of_week': dow, 'hour': hour, 'state': state,
                            'busyness_pct': busy,
                            'baseline_busyness': float(level) if served else 0.0,
                            'price_level': float(venue % 3), 'rating': 4.0 + 0.2 * (venue % 2),
                            'is_realtime': int(realtime),
                            'label_provenance': 'weekly' if not realtime else ('forecast' if forecast else 'live'),
                            'label_source': '' if not realtime else ('forecast' if forecast else 'live'),
                            'vendor_forecast_pct': busy if forecast else np.nan,
                            'observed_date': f'2026-11-{dow + 1:02d}' if realtime else None,
                            'weather_observed': int(realtime),
                            'curve_prev_hour': float(level - 2),
                            'noise': float(rng.normal()),
                            **live,
                        })
    return pd.DataFrame(rows)


@functools.lru_cache(maxsize=None)
def fixture():
    """(features_train.pkl's dict as main() builds it, the frame of its rows). Shared: no check
    may change either."""
    df, _maps = pf.add_baseline_features(make_frame())
    agg = pf.build_category_cell_aggregates(df, 'city')
    rows = df[pf.serving_population_mask(df['baseline_busyness'])].reset_index(drop=True)
    # Two rows set by hand. A weekly row that carries a reading (the real
    # pipeline never makes one: weekly rows have no date) shows the rule reads
    # is_realtime; a realtime row whose reading and offset are both worth 0
    # shows it reads last_live_age_h and recent_offset_n, not the two values.
    weekly = int(np.flatnonzero(rows['state'].to_numpy() == 'weekly')[0])
    rows.loc[weekly, ['last_live_dev', 'last_live_age_h', 'recent_offset', 'recent_offset_n']] = [4.0, 3.0, 2.0, 5.0]
    rows.loc[weekly, 'state'] = 'weekly_with_reading'
    both = int(np.flatnonzero(rows['state'].to_numpy() == 'both')[0])
    rows.loc[both, ['last_live_dev', 'recent_offset']] = [0.0, 0.0]
    rows.loc[both, 'state'] = 'both_worth_zero'

    rows['delta_label'] = rows['busyness_pct'] - rows['baseline_busyness']
    live = (rows['label_provenance'] == 'live').to_numpy()
    divisor = np.where(live, 1 + rows['hour'].to_numpy() % 2, 1).astype(np.int32)
    rows['sample_weight'] = np.where(rows['is_realtime'] != 1, 0.05,
                                     np.where(rows['label_provenance'] == 'forecast', 0.3, 1.0)) / divisor
    stats = pf.index_category_cells(rows, agg)
    data = pf.train_pickle_dict(pf.train_pickle_columns(rows), {'X': pf.feature_matrix(rows, FEATURES)},
                                rows['sample_weight'].values, divisor, FEATURES, stats)
    return data, rows


@functools.lru_cache(maxsize=None)
def grown():
    """(the dict with the copies, its record), made once. Shared: no check may change either."""
    data, _rows = fixture()
    return pf.append_live_mask_copies(data)


def sources(data):
    """Which rows get copy B and copy C, read off the dict one row at a time."""
    cols = data['feature_cols']
    X = data['X']
    age, count = cols.index('last_live_age_h'), cols.index('recent_offset_n')
    b_rows, c_rows = [], []
    for i in range(X.shape[0]):
        if int(data['is_realtime'][i]) != 1:
            continue
        reading, offset = float(X[i, age]) != 99.0, float(X[i, count]) > 0
        if reading and offset:
            b_rows.append(i)
        if reading or offset:
            c_rows.append(i)
    return b_rows, c_rows


def plain(v):
    """A per-row key as a list of plain values; NaN reads as the string 'nan'."""
    return ['nan' if isinstance(x, float) and x != x else x for x in np.asarray(v, dtype=object).tolist()]


def trainer_args(data):
    return {'y': data['y'], 'y_actual': data['y_actual'], 'baseline': data['baseline'],
            'sample_weight': data['sample_weight'], 'run_length_divisor': data['run_length_divisor'],
            'cities': data['cities'], 'label_provenance': data['label_provenance'],
            'is_realtime': data['is_realtime']}


def check_copies(data):
    return tm.assert_masked_copies(data[pf.MASKED_COPY_KEY], data['X'], data['feature_cols'],
                                   data['is_realtime'], trainer_args(data))


def train(data, with_mask=True, **switch_values):
    """train_model.train_xgboost on a pickle dict, the way main() calls it."""
    flags = data.get(pf.MASKED_COPY_KEY) if with_mask else None
    original = (flags == 0) if flags is not None and flags.any() else None
    fold_cats = tm.FoldCategoryBaselines(data['category_cell_stats'], data['cities'], FEATURES,
                                         data['y_actual'], masked_copy=flags)
    assert fold_cats.active and fold_cats.verify_reproduces_shipped(data['X']) == 0.0
    cv = GroupKFold(n_splits=len(CITIES))
    folds = tm.assert_group_disjoint(cv, data['X'], data['y'], data['cities'])
    with switches(**switch_values):
        return tm.train_xgboost(data['X'], data['y'], cv, folds, data['cities'], data['baseline'],
                                data['y_actual'], data['sample_weight'], tm.DEFAULT_DELTA_CLAMP,
                                'cpu', THREADS, fold_cats=fold_cats, report_rows=original)


# ---------------------------------------------------------------------------
# prepare_features.py: off, on, and what a copy is
# ---------------------------------------------------------------------------
def test_the_fixture_holds_every_state():
    data, rows = fixture()
    states = rows['state'].value_counts().to_dict()
    for name in list(STATES.values()) + ['weekly_with_reading', 'both_worth_zero']:
        assert states.get(name, 0) >= 1, (name, states)
    assert min(states[s] for s in STATES.values()) >= 100, states
    assert data['X'].dtype == np.float32 and data['X'].flags.f_contiguous
    assert pf.LIVE_MASK_COPIES_POLICY == 'off', 'the switch must be off unless it is set'


def test_off_hands_back_the_dict_main_built_and_writes_nothing_new():
    data, _rows = fixture()
    before = pickle.dumps(data)
    with policy(mask='off'):
        out, record = pf.with_live_mask_copies(data)
    assert out is data and record is None
    assert pf.MASKED_COPY_KEY not in out and pickle.dumps(out) == before
    # The switch is a _policy: off by default, on when set, anything else refused.
    saved = os.environ.pop(pf.LIVE_MASK_COPIES_ENV, None)
    try:
        assert pf._policy(pf.LIVE_MASK_COPIES_ENV, 'off', {'off', 'on'}) == 'off'
        os.environ[pf.LIVE_MASK_COPIES_ENV] = 'ON'
        assert pf._policy(pf.LIVE_MASK_COPIES_ENV, 'off', {'off', 'on'}) == 'on'
        os.environ[pf.LIVE_MASK_COPIES_ENV] = 'yes'
        expect(pf.CorpusContractError, 'FLOCK_LIVE_MASK_COPIES',
               lambda: pf._policy(pf.LIVE_MASK_COPIES_ENV, 'off', {'off', 'on'}))
    finally:
        os.environ.pop(pf.LIVE_MASK_COPIES_ENV, None)
        if saved is not None:
            os.environ[pf.LIVE_MASK_COPIES_ENV] = saved


def test_on_appends_the_copies_in_order_with_the_masked_values():
    data, _rows = fixture()
    with policy(mask='on'):
        out, record = pf.with_live_mask_copies(data)
    n = data['X'].shape[0]
    b_rows, c_rows = sources(data)
    assert len(b_rows) > 100 and len(c_rows) > len(b_rows)
    total = n + len(b_rows) + len(c_rows)

    assert list(out) == list(data) + [pf.MASKED_COPY_KEY], 'only one key is new, and it comes last'
    flags = out[pf.MASKED_COPY_KEY]
    assert flags.dtype == np.int8 and flags.shape == (total,)
    assert flags.tolist() == [0] * n + [1] * len(b_rows) + [2] * len(c_rows)
    assert (record['policy'], record['offset_only'], record['no_reading']) == ('on', len(b_rows), len(c_rows))
    assert (record['source_rows'], record['matrix_rows']) == (n, total)
    for key in pf.TRAIN_PICKLE_ROW_KEYS:
        assert len(out[key]) == total, key
        assert type(out[key]) is type(data[key]) and out[key].dtype == data[key].dtype, key

    X, cols = out['X'], out['feature_cols']
    assert X.dtype == np.float32 and X.flags.f_contiguous and X.shape == (total, len(FEATURES))
    assert np.array_equal(np.ascontiguousarray(X[:n]).view(np.uint32),
                          np.ascontiguousarray(data['X']).view(np.uint32)), 'the original rows changed'
    at = {c: cols.index(c) for c in MISSING}
    for k, src in enumerate(b_rows + c_rows):
        row, want = X[n + k], data['X'][src].copy()
        want[at['last_live_dev']], want[at['last_live_age_h']] = 0.0, 99.0
        if k >= len(b_rows):
            want[at['recent_offset']], want[at['recent_offset_n']] = 0.0, 0.0
        assert np.array_equal(row, want), (k, src, row, want)
    # Said once more as the two states serving sends.
    b, c = X[n:n + len(b_rows)], X[n + len(b_rows):]
    assert (b[:, at['last_live_dev']] == 0).all() and (b[:, at['last_live_age_h']] == 99).all()
    assert (b[:, at['recent_offset_n']] > 0).all(), 'an offset-only copy keeps its offset'
    for name, missing in MISSING.items():
        assert (c[:, at[name]] == missing).all(), name


def test_everything_but_the_masked_features_is_the_source_rows():
    data, _rows = fixture()
    out, _record = grown()
    n = data['X'].shape[0]
    b_rows, c_rows = sources(data)
    cols = out['feature_cols']
    j = cols.index('curve_prev_hour')
    untouched = [i for i, c in enumerate(cols) if c not in MISSING]
    keys = [key for key in pf.TRAIN_PICKLE_ROW_KEYS if key != 'X']
    got, want = {key: plain(out[key]) for key in keys}, {key: plain(data[key]) for key in keys}
    for k, src in enumerate(b_rows + c_rows):
        assert out['X'][n + k, j] == data['X'][src, j], 'curve_prev_hour is the curve and is never masked'
        assert np.array_equal(out['X'][n + k, untouched], data['X'][src, untouched])
        for key in keys:
            assert got[key][n + k] == want[key][src], (key, k, src)
    for key in keys:
        assert got[key][:n] == want[key], f'the original rows of {key} changed'
    # The values that matter most, by name: label, target, baseline, weight,
    # divisor, city and date vary across the copies, so equality is not vacuous.
    copies = slice(n, None)
    for key in ('y', 'y_actual', 'baseline', 'sample_weight', 'run_length_divisor', 'cities',
                'observed_date', 'label_provenance'):
        assert len(set(np.asarray(out[key], dtype=object)[copies].tolist())) > 1, key
    for key in pf.TRAIN_PICKLE_FRAME_KEYS:
        if key != 'category_cell_stats':
            assert out[key] == data[key], key


def test_which_rows_get_which_copy():
    data, rows = fixture()
    b_rows, c_rows = sources(data)
    got_b, got_c = pf.live_mask_copy_sources(data['X'], data['feature_cols'], data['is_realtime'])
    assert got_b.tolist() == b_rows and got_c.tolist() == c_rows
    assert sorted(b_rows) == b_rows and sorted(c_rows) == c_rows, 'copies follow source-row order'
    state = rows['state'].to_numpy()
    in_b, in_c = np.isin(np.arange(len(rows)), b_rows), np.isin(np.arange(len(rows)), c_rows)
    want = {'weekly': (False, False), 'weekly_with_reading': (False, False), 'neither': (False, False),
            'reading_only': (False, True), 'offset_only': (False, True), 'both': (True, True),
            'both_worth_zero': (True, True), 'forecast_both': (True, True)}
    for name, (b, c) in want.items():
        rows_of = state == name
        assert rows_of.any() and (in_b[rows_of] == b).all() and (in_c[rows_of] == c).all(), name
    out, record = grown()
    assert record['realtime_rows_at_missing_values'] == int((state == 'neither').sum())
    assert record['realtime_rows'] == int(data['is_realtime'].sum())
    # The weights are the source rows', so realtime rows carry more of the loss.
    w, rt = np.asarray(data['sample_weight'], dtype=float), data['is_realtime'] == 1
    assert record['realtime_loss_share'] > round(float(w[rt].sum() / w.sum()), 4)


def test_the_given_dict_is_not_changed_and_what_cannot_be_grown_stops_it():
    data, _rows = fixture()
    before = pickle.dumps(data)
    pf.append_live_mask_copies(data)
    assert pickle.dumps(data) == before, 'append_live_mask_copies changed its input'
    expect(pf.CorpusContractError, 'does not know', lambda: pf.append_live_mask_copies({**data, 'new_key': 1}))
    streamed = {k: v for k, v in data.items() if k != 'X'}
    streamed.update({features_io.X_FILE_KEY: 'features_train.X.npy'})
    expect(pf.CorpusContractError, 'in-memory preparation only', lambda: pf.append_live_mask_copies(streamed))
    keep = [i for i, c in enumerate(FEATURES) if c not in MISSING]
    no_live = {**data, 'X': np.asfortranarray(data['X'][:, keep]), 'feature_cols': [FEATURES[i] for i in keep]}
    expect(pf.CorpusContractError, 'last_live_dev', lambda: pf.append_live_mask_copies(no_live))
    short = {**data, 'hour': data['hour'][:-1]}
    expect(pf.CorpusContractError, 'rows long', lambda: pf.append_live_mask_copies(short))


def test_cell_stats_grow_with_the_copies_and_keep_the_fitted_aggregates():
    data, _rows = fixture()
    out, record = grown()
    n = data['X'].shape[0]
    b_rows, c_rows = sources(data)
    src = np.array(b_rows + c_rows)
    old, new = data['category_cell_stats'], out['category_cell_stats']
    assert new['rows'] == n + len(src) == len(out['y']) and old['rows'] == n
    assert new['masked_copies'] == {'offset_only': len(b_rows), 'no_reading': len(c_rows)}
    assert new['row_group'].dtype == old['row_group'].dtype
    assert np.array_equal(new['row_group'], np.r_[old['row_group'], old['row_group'][src]])
    for key in old:
        if key not in ('rows', 'row_group', 'category', 'refined'):
            assert new[key] == old[key], key
    y = np.asarray(out['y_actual'], dtype=np.float64)
    over = False
    for name in ('category', 'refined'):
        a, b = old[name], new[name]
        assert b['sums'] is a['sums'] and b['counts'] is a['counts'], 'the fitted aggregates must be untouched'
        assert b['keys'] == a['keys'] and b['cells'] == a['cells']
        assert b['row_cell'].dtype == a['row_cell'].dtype
        assert np.array_equal(b['row_cell'], np.r_[a['row_cell'], a['row_cell'][src]])
        counts = np.zeros(a['rows_counts'].shape, dtype=np.int64)
        sums = np.zeros(a['rows_sums'].shape, dtype=np.float64)
        for i in range(len(y)):
            counts[new['row_group'][i], b['row_cell'][i]] += 1
            sums[new['row_group'][i], b['row_cell'][i]] += y[i]
        assert b['rows_counts'].dtype == np.int64 and np.array_equal(b['rows_counts'], counts)
        assert np.allclose(b['rows_sums'], sums, rtol=0, atol=1e-9)
        assert int(b['rows_counts'].sum()) == n + len(src) and int(a['rows_counts'].sum()) == n
        over = over or bool((b['rows_counts'] > a['counts']).any())
    assert over, 'no cell holds more rows than the pre-filter frame: the trainer checks below have no teeth'
    assert record['matrix_rows'] == new['rows']


def test_the_flags_are_read_validated_and_refused_by_scripts_that_cannot_use_them():
    data, _rows = fixture()
    out, _record = grown()
    n = data['X'].shape[0]
    flags = pf.masked_copy_flags(data)
    assert flags.dtype == np.int8 and flags.shape == (n,) and not flags.any(), \
        'a pickle without the key is all original rows'
    assert pf.masked_copy_blocks(flags) == {'original': n, 'offset_only': 0, 'no_reading': 0}
    blocks = pf.masked_copy_blocks(pf.masked_copy_flags(out))
    assert blocks == {'original': n, 'offset_only': int((out[pf.MASKED_COPY_KEY] == 1).sum()),
                      'no_reading': int((out[pf.MASKED_COPY_KEY] == 2).sum())}
    bad = out[pf.MASKED_COPY_KEY].copy()
    bad[0] = 3
    expect(pf.CorpusContractError, 'must hold one of', lambda: pf.masked_copy_flags({**out, pf.MASKED_COPY_KEY: bad}))
    expect(pf.CorpusContractError, 'must hold one of',
           lambda: pf.masked_copy_flags({**out, pf.MASKED_COPY_KEY: out[pf.MASKED_COPY_KEY][:-1]}))
    expect(pf.CorpusContractError, 'not original rows, then',
           lambda: pf.masked_copy_blocks(out[pf.MASKED_COPY_KEY][::-1]))
    pf.refuse_masked_copies(data, 'a_script.py')
    pf.refuse_masked_copies({**data, pf.MASKED_COPY_KEY: np.zeros(n, dtype=np.int8)}, 'a_script.py')
    expect(SystemExit, 'a_script.py', lambda: pf.refuse_masked_copies(out, 'a_script.py'))
    # The three experiments that read every pickle row as a source row call it.
    here = Path(__file__).parent
    for name, call in (('train_two_head.py', "refuse_masked_copies(data, 'train_two_head.py')"),
                       ('sports_ablation.py', "refuse_masked_copies(tr, 'sports_ablation.py')"),
                       ('within_city_eval.py', "pf.refuse_masked_copies(ref, 'within_city_eval.py')")):
        assert call in (here / name).read_text(encoding='utf-8'), name


# ---------------------------------------------------------------------------
# train_model.py: a copy is checked, trained, and reported apart
# ---------------------------------------------------------------------------
def test_the_trainer_accepts_the_copies_and_still_refuses_unmarked_extra_rows():
    data, _rows = fixture()
    out, record = grown()
    n = data['X'].shape[0]
    counts = check_copies(out)
    assert counts == {'original_rows': n, 'offset_only': record['offset_only'],
                      'no_reading': record['no_reading'], 'matrix_rows': record['matrix_rows']}
    assert tm.assert_masked_copies(np.zeros(n, dtype=np.int8), data['X'], FEATURES, data['is_realtime'],
                                   trainer_args(data)) is None, 'no copies, nothing to check'
    stats, flags = out['category_cell_stats'], out[pf.MASKED_COPY_KEY]
    fold_cats = tm.FoldCategoryBaselines(stats, out['cities'], FEATURES, out['y_actual'], masked_copy=flags)
    assert fold_cats.active and fold_cats.verify_reproduces_shipped(out['X']) == 0.0
    # The same rows without the mark are extra rows of their cells, refused as
    # they always were: the mark is the only thing that admits a copy.
    for unmarked in (None, np.zeros(len(flags), dtype=np.int8)):
        expect(tm.LeakageError, 'more rows in a cell',
               lambda: tm.FoldCategoryBaselines(stats, out['cities'], FEATURES, out['y_actual'],
                                                masked_copy=unmarked))
    # No environment variable waives it (the exploratory run's patch had one).
    source = (Path(__file__).parent / 'train_model.py').read_text(encoding='utf-8')
    assert 'FLOCK_AUGMENTED_COPIES' not in source
    os.environ['FLOCK_AUGMENTED_COPIES'] = '1'
    try:
        expect(tm.LeakageError, 'more rows in a cell',
               lambda: tm.FoldCategoryBaselines(stats, out['cities'], FEATURES, out['y_actual']))
    finally:
        del os.environ['FLOCK_AUGMENTED_COPIES']


def test_an_original_row_count_over_the_pre_filter_count_is_still_refused():
    out, _record = grown()
    stats, flags = out['category_cell_stats'], out[pf.MASKED_COPY_KEY]
    original = flags == 0
    block = stats['category']
    n_cells = block['counts'].shape[1]
    flat = stats['row_group'].astype(np.int64) * n_cells + block['row_cell']
    own = np.bincount(flat[original], minlength=block['counts'].size).reshape(block['counts'].shape)
    # A cell whose copies took it past the pre-filter count, where its original rows are under it.
    g, c = np.argwhere((block['rows_counts'] > block['counts']) & (own >= 1) & (own < block['counts']))[0]

    def with_count(k):
        counts = block['counts'].copy()
        counts[g, c] = k
        return {**stats, 'category': {**block, 'counts': counts}}

    def build(k):
        return tm.FoldCategoryBaselines(with_count(k), out['cities'], FEATURES, out['y_actual'],
                                        masked_copy=flags)

    assert block['rows_counts'][g, c] > own[g, c]
    # Exactly as many pre-filter rows as original rows: allowed, however many copies the cell holds.
    assert build(int(own[g, c])).active
    # One original row more than the pre-filter frame holds: refused, with copies present and marked.
    expect(tm.LeakageError, 'more rows in a cell', lambda: build(int(own[g, c]) - 1))
    # The rebuild of the pickle's own row statistics still covers every row.
    wrong = {**stats, 'category': {**block, 'rows_counts': block['rows_counts'] - (block['rows_counts'] > 0)}}
    expect(tm.LeakageError, 'rows_counts do not match',
           lambda: tm.FoldCategoryBaselines(wrong, out['cities'], FEATURES, out['y_actual'], masked_copy=flags))
    own_only = {**stats, 'category': {**block, 'rows_counts': own.astype(np.int64)}}
    expect(tm.LeakageError, 'rows_counts do not match',
           lambda: tm.FoldCategoryBaselines(own_only, out['cities'], FEATURES, out['y_actual'], masked_copy=flags))


def test_a_row_marked_a_copy_that_is_not_one_is_refused():
    data, _rows = fixture()
    out, record = grown()
    n, n_b = data['X'].shape[0], record['offset_only']
    cols = out['feature_cols']

    def changed(key, row, new):
        arr = np.array(out[key], copy=True) if isinstance(out[key], np.ndarray) else \
            np.asarray(out[key], dtype=object).copy()
        arr[row] = new
        return {**out, key: arr}

    def changed_x(row, col, new):
        X = out['X'].copy()
        X[row, cols.index(col)] = new
        return {**out, 'X': X}

    first_b, first_c = n, n + n_b
    cases = {
        'another label': (changed('y_actual', first_c, float(out['y_actual'][first_c]) + 1), "source row's y_actual"),
        'another target': (changed('y', first_b, float(out['y'][first_b]) + 1), "source row's y"),
        'another weight': (changed('sample_weight', first_b, 0.123), "source row's sample_weight"),
        'another divisor': (changed('run_length_divisor', first_c, 7), "source row's run_length_divisor"),
        'another city': (changed('cities', first_c, next(c for c in CITIES if c != out['cities'][first_c])),
                         "source row's cities"),
        'another provenance': (changed('label_provenance', first_b, 'weekly'), "source row's label_provenance"),
        'another feature': (changed_x(first_b, 'noise', 9.0), 'Feature noise'),
        'the curve changed': (changed_x(first_c, 'curve_prev_hour', -1.0), 'Feature curve_prev_hour'),
        'a reading left in': (changed_x(first_b, 'last_live_age_h', 3.0), 'Feature last_live_age_h'),
        'a deviation left in': (changed_x(first_c, 'last_live_dev', 2.0), 'Feature last_live_dev'),
        'an offset left in a no-reading copy': (changed_x(first_c, 'recent_offset_n', 4.0),
                                                'Feature recent_offset_n'),
        'an offset masked in an offset-only copy': (changed_x(first_b, 'recent_offset_n', 0.0),
                                                    'Feature recent_offset_n'),
    }
    for name, (broken, needle) in cases.items():
        expect(tm.LabelContractError, needle, lambda: check_copies(broken))
    # A copy too few, a row marked a copy that the rule does not call for, and the wrong order.
    fewer = {k: (v[:-1] if k in pf.TRAIN_PICKLE_ROW_KEYS + (pf.MASKED_COPY_KEY,) else v) for k, v in out.items()}
    expect(tm.LabelContractError, 'original rows call for', lambda: check_copies(fewer))
    flags = out[pf.MASKED_COPY_KEY].copy()
    flags[first_b] = 2   # a no-reading copy ahead of the offset-only ones
    expect(tm.LabelContractError, 'not original rows, then', lambda: check_copies({**out, pf.MASKED_COPY_KEY: flags}))
    flags = out[pf.MASKED_COPY_KEY].copy()
    flags[first_c - 1] = 2   # the last offset-only copy marked a no-reading one
    expect(tm.LabelContractError, 'original rows call for', lambda: check_copies({**out, pf.MASKED_COPY_KEY: flags}))
    marked_original = out[pf.MASKED_COPY_KEY].copy()
    marked_original[n - 1] = 1   # an original row passed off as a copy
    expect(tm.LabelContractError, 'original rows call for',
           lambda: check_copies({**out, pf.MASKED_COPY_KEY: marked_original}))
    # The pickle and the metadata must be one prepare run's.
    held = check_copies(out)
    tm.assert_copies_match_metadata(held, {'corpus_contract': {'live_mask_copies': record}})
    tm.assert_copies_match_metadata(None, {})
    tm.assert_copies_match_metadata(None, {'corpus_contract': {'live_feature_policy': 'on'}})
    tm.assert_copies_match_metadata(None, {'corpus_contract': {'live_mask_copies': {
        'policy': 'on', 'offset_only': 0, 'no_reading': 0, 'source_rows': n}}})
    expect(tm.LabelContractError, 'disagree about the masked copies',
           lambda: tm.assert_copies_match_metadata(held, {'corpus_contract': {}}))
    expect(tm.LabelContractError, 'disagree about the masked copies',
           lambda: tm.assert_copies_match_metadata(None, {'corpus_contract': {'live_mask_copies': record}}))
    expect(tm.LabelContractError, 'disagree about the masked copies',
           lambda: tm.assert_copies_match_metadata(
               held, {'corpus_contract': {'live_mask_copies': {**record, 'no_reading': record['no_reading'] + 1}}}))
    expect(tm.LabelContractError, 'not the record',
           lambda: tm.assert_copies_match_metadata(held, {'corpus_contract': {'live_mask_copies': 'on'}}))


def test_reported_metrics_are_the_original_rows_and_the_copies_are_reported_apart():
    data, _rows = fixture()
    out, record = grown()
    n, n_b, n_c = data['X'].shape[0], record['offset_only'], record['no_reading']
    flags = out[pf.MASKED_COPY_KEY]
    original = flags == 0
    y_actual, baseline, rt = out['y_actual'], out['baseline'], out['is_realtime'] == 1

    model, metrics, absolute, per_city, _params, _hp, _es, _elapsed, shifts = train(out, **SMALL)
    assert absolute.shape == (len(flags),) and np.isfinite(absolute).all(), 'every row is predicted out of fold'
    assert metrics == tm._metrics(y_actual[original], absolute[original])
    assert metrics != tm._metrics(y_actual, absolute), 'counting the copies would not move the number: no teeth'
    cities = np.asarray(out['cities'], dtype=object)
    for city in CITIES:
        rows = original & (cities == city)
        assert per_city[city] == {'rows': int(rows.sum()), **tm._metrics(y_actual[rows], absolute[rows])}, city
    assert sum(block['rows'] for block in per_city.values()) == n

    slices = tm.slice_report(y_actual, absolute, rt, baseline, masked_copy=flags)
    assert list(slices) == ['all_rows', 'realtime_served', 'weekly_anchor', 'realtime_offset_only',
                            'realtime_no_reading']
    want = {'all_rows': original, 'realtime_served': original & rt, 'weekly_anchor': original & ~rt,
            'realtime_offset_only': flags == 1, 'realtime_no_reading': flags == 2}
    for name, rows in want.items():
        block = slices[name]
        assert block['rows'] == int(rows.sum()) and isinstance(block['population'], str), name
        assert {k: block[k] for k in METRIC_KEYS} == tm._metrics(y_actual[rows], absolute[rows]), name
    assert (slices['realtime_offset_only']['rows'], slices['realtime_no_reading']['rows']) == (n_b, n_c)
    assert {k: slices['all_rows'][k] for k in METRIC_KEYS} == metrics, 'training_metrics is all_rows'
    assert 'original' in slices['all_rows']['population']
    for name in ('realtime_offset_only', 'realtime_no_reading'):
        assert 'masked copies' in slices[name]['population'], name

    # The three populations are the ones the same predictions give with the
    # copies cut away, and a pickle without copies reports those three alone.
    plain = tm.slice_report(y_actual[:n], absolute[:n], rt[:n], baseline[:n])
    assert list(plain) == ['all_rows', 'realtime_served', 'weekly_anchor']
    assert plain['all_rows']['population'] == 'every training row (weekly anchor + realtime)'
    for name in plain:
        for k in ('rows',) + METRIC_KEYS:
            assert plain[name][k] == slices[name][k], (name, k)
    assert tm.slice_report(y_actual[:n], absolute[:n], rt[:n], baseline[:n],
                           masked_copy=np.zeros(n, dtype=np.int8)) == plain

    # A copy that is predicted badly moves its own population and nothing else.
    worse = absolute.copy()
    worse[~original] = np.clip(worse[~original] + 40, 0, 140)
    moved = tm.slice_report(y_actual, worse, rt, baseline, masked_copy=flags)
    for name in ('all_rows', 'realtime_served', 'weekly_anchor'):
        assert moved[name] == slices[name], name
    assert moved['realtime_no_reading']['mae'] > slices['realtime_no_reading']['mae'] + 10

    # The copies train: the shipped fit is not the one the original rows alone give.
    alone = train(data, **SMALL)
    assert bytes(model.get_booster().save_raw('ubj')) != bytes(alone[0].get_booster().save_raw('ubj'))
    # The per-fold feature shifts are measured on original rows, where the two
    # category columns are the ones the matrix without copies holds.
    assert shifts == alone[8]


def test_the_leak_scan_the_weight_tiers_and_early_stopping_count_original_rows():
    data, _rows = fixture()
    out, record = grown()
    n = data['X'].shape[0]
    flags = out[pf.MASKED_COPY_KEY]
    original = flags == 0

    def probes(d):
        return {'baseline_busyness': d['baseline'], 'busyness_pct (the label)': d['y_actual'],
                'delta_label (the target)': d['y']}

    # The scan of the original rows is the scan of the matrix without its copies.
    assert tm.assert_no_label_shaped_feature(out['X'], FEATURES, probes(out), rows=n) == \
        tm.assert_no_label_shaped_feature(data['X'], FEATURES, probes(data))
    # A reading-based column that IS the target on every original row is a leak.
    # Its masked copies hold 0 there, so over every row the match falls under
    # the threshold and the scan would pass it; on original rows it is caught.
    leaky = out['X'].copy()
    leaky[:n, FEATURES.index('last_live_dev')] = out['y'][:n]
    assert tm.assert_no_label_shaped_feature(leaky, FEATURES, probes(out))['features_checked'] == len(FEATURES)
    expect(tm.LeakageError, 'last_live_dev matches delta_label',
           lambda: tm.assert_no_label_shaped_feature(leaky, FEATURES, probes(out), rows=n))

    rt = out['is_realtime'] == 1
    tiers = tm.assert_weighting_matches_provenance(out['sample_weight'], rt, out['label_provenance'],
                                                   out['run_length_divisor'], masked_copy=flags)
    assert tiers['weekly_anchor']['masked_copy_rows'] == 0
    assert sum(t['masked_copy_rows'] for t in tiers.values()) == record['offset_only'] + record['no_reading']
    assert sum(t['rows'] for t in tiers.values()) == len(flags), 'the tiers describe the loss: every trained row'
    plain = tm.assert_weighting_matches_provenance(data['sample_weight'], data['is_realtime'] == 1,
                                                   data['label_provenance'], data['run_length_divisor'])
    assert all('masked_copy_rows' not in t for t in plain.values()), 'no copies, no new key'
    assert {k: t['weight'] for k, t in tiers.items()} == {k: t['weight'] for k, t in plain.items()}

    # The early-stopping split holds out the cities the original rows choose.
    # Here 200 original rows hold out a, b and c (15% is 30 rows, passed at c);
    # counting 220 copies in f as well would hold out d too.
    groups = np.array(['a'] * 10 + ['b'] * 10 + ['c'] * 40 + ['d'] * 40 + ['e'] * 50 + ['f'] * 50
                      + ['f'] * 220, dtype=object)
    counted = np.r_[np.ones(200, dtype=bool), np.zeros(220, dtype=bool)]
    assert tm.early_stopping_split(groups[:200])[2] == ['a', 'b', 'c']
    assert tm.early_stopping_split(groups)[2] == ['a', 'b', 'c', 'd'], 'the fixture must tell the two apart'
    tr, va, held = tm.early_stopping_split(groups, counted=counted)
    assert held == ['a', 'b', 'c'] and len(tr) == len(va) == 420 and int(va.sum()) == 60
    assert int(tr.sum()) == 360, 'every row of the other cities trains, the copies included'
    es = train(out, FLOCK_MAX_DEPTH='3', FLOCK_N_ESTIMATORS='25', FLOCK_EARLY_STOPPING_ROUNDS='3')[6]
    cities = np.asarray(out['cities'], dtype=object)
    assert es['enabled'] and es['held_out_cities'] == tm.early_stopping_split(data['cities'])[2]
    assert es['held_out_rows'] == int((original & np.isin(cities, es['held_out_cities'])).sum())
    assert es['held_out_rows'] < int(np.isin(cities, es['held_out_cities']).sum())


def test_the_search_is_refused_on_a_matrix_with_copies():
    out, _record = grown()
    expect(ValueError, 'masked copies', lambda: train(out, FLOCK_HYPERPARAM_SEARCH='true'))


# ---------------------------------------------------------------------------
# final_refit_gate.py: the refit must be prepared the way the gated run was
# ---------------------------------------------------------------------------
def test_the_final_refit_must_match_the_gated_runs_policy():
    on = {'policy': 'on', 'env': 'FLOCK_LIVE_MASK_COPIES', 'offset_only': 10, 'no_reading': 12}
    more = dict(on, offset_only=14, no_reading=17)   # the refit's frame is larger: counts differ

    def problems(gated_copies, refit_copies):
        with tempfile.TemporaryDirectory() as tmp:
            contracts = []
            for rec in (gated_copies, refit_copies):
                contract = dict(tfr.POLICY)
                if rec is not None:
                    contract['live_mask_copies'] = rec
                contracts.append(contract)
            g = tfr.gated_meta(corpus_contract=contracts[0])
            p = tfr.write(tmp, g)
            return frg.problems_with(tfr.refit_meta(p, corpus_contract=contracts[1]), g, p.read_bytes())

    assert problems(None, None) == [], 'two runs from before the switch, or with it off, match'
    assert problems(on, more) == [], 'both on: the counts are each frame\'s and are not compared'
    for gated, refit in ((on, None), (None, on)):
        found = problems(gated, refit)
        assert any('corpus_contract.live_mask_copies.policy differs' in x for x in found), found
    for broken in ('on', {'offset_only': 3}, {'policy': 'maybe'}):
        found = problems(on, broken)
        assert any('live_mask_copies.policy is not recorded as on or off' in x for x in found), found


# ---------------------------------------------------------------------------
# The whole preparation, and the pipeline after it, on a synthetic export
# ---------------------------------------------------------------------------
def outputs(folder):
    return [f for f in ('features_train.pkl', 'features_train.X.npy', 'features_holdout.pkl')
            if (folder / f).exists()]


def test_prepare_refuses_the_switch_without_the_live_features_and_in_the_streamed_mode():
    e = tsp.export()
    models = e.root / 'ml' / 'models'
    # The two switches contradict each other, and main() says so before it reads
    # anything: in a folder with no export at all it is still this refusal, not
    # the missing file, that stops it.
    with policy(mask='on', live='off'):
        expect(pf.CorpusContractError, 'FLOCK_LIVE_FEATURES=off: the masked copies set',
               lambda: tsp.run(e.train, stream=False))
        expect(pf.CorpusContractError, 'FLOCK_LIVE_FEATURES=off: the masked copies set',
               lambda: tsp.run(e.train, stream=True, chunk_rows=5000))
        empty = e.root / 'no_export'
        empty.mkdir(exist_ok=True)
        saved = pf.SCRIPT_DIR
        pf.SCRIPT_DIR = empty
        try:
            expect(pf.CorpusContractError, 'Unset one of the two', pf.main)
        finally:
            pf.SCRIPT_DIR = saved
    assert not outputs(e.train) and not (models / 'model_metadata.json').exists()
    with policy(mask='on'):
        expect(pf.CorpusContractError, 'in-memory preparation only',
               lambda: tsp.run(e.train, stream=True, chunk_rows=5000))
    assert not outputs(e.train) and not (models / 'model_metadata.json').exists()
    # Off refuses nothing: the ablation and the streamed mode run as they did.
    with policy(mask='off', live='off'):
        pf.require_live_mask_copies_possible()
        pf.require_live_mask_copies_possible(streamed=True)
    with policy(mask='on'):
        pf.require_live_mask_copies_possible()


def test_off_still_writes_what_the_goldens_of_the_stream_suite_pin():
    out = tsp.in_memory('cold')
    got = tsp.digest(out)
    assert not any(pf.MASKED_COPY_KEY in k for k in got), 'off wrote a masked_copy key'
    meta = json.loads((out / 'model_metadata.json').read_text(encoding='utf-8'))
    assert 'live_mask_copies' not in meta['corpus_contract'], 'off wrote a record'
    goldens = json.loads(tsp.GOLDENS.read_text(encoding='utf-8'))
    want = goldens['runs']['cold']
    moved = sorted(k for k in set(got) | set(want) if got.get(k) != want.get(k))
    if not moved:
        return
    made = {k: goldens['made_with'].get(k) for k in tsp.library_versions()}
    if made != tsp.library_versions():
        raise tsp.Skip(f'values moved {moved} under {tsp.library_versions()}, and the goldens were written '
                       f'under {made}: a library change cannot be told from a code change here.')
    raise AssertionError(f'with the switch off the preparation no longer writes the pinned outputs: {moved}')


@functools.lru_cache(maxsize=None)
def prepared_on():
    e = tsp.export()
    with policy(mask='on'):
        return tsp.run(e.train, stream=False)


def test_on_grows_the_training_pickle_only_and_records_itself():
    off, on = tsp.in_memory('cold'), prepared_on()
    a = features_io.load_features(off / 'features_train.pkl')
    b = features_io.load_features(on / 'features_train.pkl')
    n = len(a['y'])
    assert pf.MASKED_COPY_KEY not in a and list(b) == list(a) + [pf.MASKED_COPY_KEY]
    blocks = pf.masked_copy_blocks(pf.masked_copy_flags(b))
    assert blocks['original'] == n and blocks['offset_only'] > 1000 and blocks['no_reading'] > blocks['offset_only']
    for key in pf.TRAIN_PICKLE_ROW_KEYS:
        tsp.same(a[key], b[key][:n], key)
    assert a['feature_cols'] == b['feature_cols'] and a['label_type'] == b['label_type']
    for name in ('category', 'refined'):
        tsp.same(a['category_cell_stats'][name]['sums'], b['category_cell_stats'][name]['sums'], name)
        tsp.same(a['category_cell_stats'][name]['counts'], b['category_cell_stats'][name]['counts'], name)
    assert check_copies(b)['matrix_rows'] == len(b['y']) == b['category_cell_stats']['rows']
    # The copies are of realtime rows only, and of every realtime row with a reading or an offset.
    cols = b['feature_cols']
    rt = a['is_realtime'] == 1
    reading = a['X'][:, cols.index('last_live_age_h')] != pf.LIVE_MISSING_AGE_H
    offset = a['X'][:, cols.index('recent_offset_n')] > 0
    assert (reading[~rt] == 0).all() and (offset[~rt] == 0).all(), 'a weekly row carries a reading'
    assert blocks['offset_only'] == int((rt & reading & offset).sum())
    assert blocks['no_reading'] == int((rt & (reading | offset)).sum()) < int(rt.sum())

    assert (off / 'features_holdout.pkl').read_bytes() == (on / 'features_holdout.pkl').read_bytes(), \
        'the holdout pickle must not change'
    assert pf.MASKED_COPY_KEY not in features_io.load_features(on / 'features_holdout.pkl')

    ma = json.loads((off / 'model_metadata.json').read_text(encoding='utf-8'))
    mb = json.loads((on / 'model_metadata.json').read_text(encoding='utf-8'))
    record = mb['corpus_contract']['live_mask_copies']
    assert (record['policy'], record['env']) == ('on', 'FLOCK_LIVE_MASK_COPIES')
    assert (record['offset_only'], record['no_reading']) == (blocks['offset_only'], blocks['no_reading'])
    assert record['source_rows'] == n == ma['training_rows'] == mb['training_rows'], \
        'training_rows counts source rows'
    assert record['matrix_rows'] == len(b['y'])
    assert record['realtime_loss_share'] > ma['sample_weight_policy']['realtime_loss_share']
    assert mb['sample_weight_policy'] == ma['sample_weight_policy']
    assert b['category_cell_stats']['masked_copies'] == {'offset_only': record['offset_only'],
                                                         'no_reading': record['no_reading']}
    # Nothing else in the metadata moves.
    same = copy.deepcopy(mb)
    del same['corpus_contract']['live_mask_copies']
    fit = same['corpus_contract']['category_baseline_fit']
    assert fit['per_fold_inputs_indexed_rows'] == record['matrix_rows']
    fit['per_fold_inputs_indexed_rows'] = n
    assert same == ma
    keys = list(mb['corpus_contract'])
    assert keys.index('live_mask_copies') == keys.index('live_feature_policy') + 1, \
        'recorded beside the live-feature policy'


def test_a_final_refit_prepared_with_the_switch_on_carries_the_copies():
    e = tsp.export()
    with policy(mask='on'):
        out = tsp.run(e.train, stream=False, refit=tsp.gated_metadata(e))
    data = features_io.load_features(out / 'features_train.pkl')
    meta = json.loads((out / 'model_metadata.json').read_text(encoding='utf-8'))
    record = meta['corpus_contract']['live_mask_copies']
    gated_rows = len(features_io.load_features(tsp.in_memory('cold') / 'features_train.pkl')['y'])
    assert meta['time_holdout']['policy'] == 'final_refit'
    assert meta['training_rows'] == record['source_rows'] > gated_rows
    assert check_copies(data)['offset_only'] == record['offset_only'] > 0
    assert pf.MASKED_COPY_KEY not in features_io.load_features(out / 'features_holdout.pkl')


def run_pipeline(prepared: Path, label: str) -> dict:
    """train_model, evaluate_model and quick_eval on a copy of a prepared folder: the metadata
    as each left it."""
    import evaluate_model as em
    import quick_eval as qe
    work = prepared.parent / f'pipeline_{label}'
    shutil.rmtree(work, ignore_errors=True)
    shutil.copytree(prepared, work)
    saved = [(m, k, getattr(m, k)) for m in (tm, em, qe) for k in ('SCRIPT_DIR', 'MODELS_DIR')]
    saved += [(em, 'PLOTS_DIR', em.PLOTS_DIR), (qe, 'INCUMBENT_DIR', qe.INCUMBENT_DIR),
              (qe, 'ALLOW_NO_INCUMBENT', qe.ALLOW_NO_INCUMBENT), (qe, 'QMAP_ENABLED', qe.QMAP_ENABLED)]
    out = {}

    def metadata():
        return json.loads((work / 'model_metadata.json').read_text(encoding='utf-8'))

    try:
        for m in (tm, em, qe):
            m.SCRIPT_DIR = m.MODELS_DIR = work
        em.PLOTS_DIR = work / 'plots'
        qe.INCUMBENT_DIR, qe.ALLOW_NO_INCUMBENT, qe.QMAP_ENABLED = work / 'incumbent', True, False
        with switches(FLOCK_TRAIN_DEVICE='cpu', FLOCK_TRAIN_THREADS=str(THREADS), FLOCK_MAX_DEPTH='4',
                      FLOCK_N_ESTIMATORS='20'):
            tm.main()
            out['trained'] = metadata()
            em.main()
            out['evaluated'] = metadata()
            qe.main()
            out['gated'] = metadata()
    finally:
        for m, k, v in saved:
            setattr(m, k, v)
    return out


def test_end_to_end_the_pipeline_reports_original_rows_with_the_switch_on():
    off_dir, on_dir = tsp.in_memory('cold'), prepared_on()
    record = json.loads((on_dir / 'model_metadata.json').read_text(encoding='utf-8'))['corpus_contract'][
        'live_mask_copies']
    n, n_b, n_c = record['source_rows'], record['offset_only'], record['no_reading']
    off, on = run_pipeline(off_dir, 'off'), run_pipeline(on_dir, 'on')

    # train_model.py
    a, b = off['trained'], on['trained']
    assert a['training_rows'] == b['training_rows'] == n
    assert a['training_city_rows'] == b['training_city_rows'] and sum(b['training_city_rows'].values()) == n
    pa, pb = a['training_metrics_by_population'], b['training_metrics_by_population']
    assert list(pa) == ['all_rows', 'realtime_served', 'weekly_anchor']
    assert list(pb) == list(pa) + ['realtime_offset_only', 'realtime_no_reading']
    for name in pa:
        assert pa[name]['rows'] == pb[name]['rows'], name
        assert all(k in pb[name] for k in METRIC_KEYS), name
    assert pb['all_rows']['rows'] == n
    assert (pb['realtime_offset_only']['rows'], pb['realtime_no_reading']['rows']) == (n_b, n_c)
    assert all(k in pb['realtime_no_reading'] and k in pb['realtime_offset_only'] for k in METRIC_KEYS)
    assert {k: b['training_metrics'][k] for k in METRIC_KEYS} == {k: pb['all_rows'][k] for k in METRIC_KEYS}
    assert 'ORIGINAL' in b['training_metrics']['population'] and 'ORIGINAL' not in a['training_metrics']['population']
    assert {c: v['rows'] for c, v in a['training_loco_per_city'].items()} == \
        {c: v['rows'] for c, v in b['training_loco_per_city'].items()}
    ca, cb = a['training_contracts'], b['training_contracts']
    assert 'masked_copies' not in ca
    assert (cb['masked_copies']['original_rows'], cb['masked_copies']['offset_only'],
            cb['masked_copies']['no_reading'], cb['masked_copies']['matrix_rows']) == (n, n_b, n_c, n + n_b + n_c)
    assert ca['leak_scan'] == cb['leak_scan'] and cb['leak_scan']['sampled_rows'] == n
    assert all('masked_copy_rows' not in t for t in ca['sample_weight_tiers'].values())
    assert sum(t['masked_copy_rows'] for t in cb['sample_weight_tiers'].values()) == n_b + n_c
    assert sum(t['rows'] for t in cb['sample_weight_tiers'].values()) == n + n_b + n_c
    assert ca['category_baselines_refit_per_fold']['per_fold'] == cb['category_baselines_refit_per_fold']['per_fold']
    assert a['best_params'] == b['best_params'] and a['cv_method'] == b['cv_method']
    assert b['training_metrics'] != a['training_metrics'], 'the copies trained nothing'

    # evaluate_model.py: the same original rows, so the same baseline on them.
    ea, eb = off['evaluated']['evaluation'], on['evaluated']['evaluation']
    assert ea['validation_baseline'] == eb['validation_baseline']
    assert ea['holdout_baseline'] == eb['holdout_baseline']
    assert 'validation_masked_copies' not in ea
    assert {k: v['rows'] for k, v in eb['validation_masked_copies'].items()} == \
        {'realtime_offset_only': n_b, 'realtime_no_reading': n_c}
    assert all('mae' in v for v in eb['validation_masked_copies'].values())
    assert off['evaluated']['validation_baseline_delta'].keys() == on['evaluated']['validation_baseline_delta'].keys()

    # quick_eval.py: the popular_times baseline beside training_metrics is on those rows too.
    ga, gb = off['gated'], on['gated']
    assert ga['evaluation']['training_baseline'] == gb['evaluation']['training_baseline']
    assert gb['evaluation']['training_loco_cv'] == b['training_metrics']
    for run, trained in ((ga, a), (gb, b)):
        want = round(run['evaluation']['training_baseline']['mae'] - trained['training_metrics']['mae'], 4)
        assert run['ship_gate']['training_mae_improvement'] == want
    assert ga['ship_gate']['realtime_rows'] == gb['ship_gate']['realtime_rows'], 'the gate slice is the holdout'


def main():
    tests = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith('test_') and callable(fn)]
    failed = skipped = 0
    try:
        for name, fn in tests:
            try:
                fn()
                print(f'PASS  {name}')
            except tsp.Skip as why:
                skipped += 1
                print(f'SKIP  {name}: {why}')
            except Exception:  # noqa: BLE001 - report every failure, then exit non-zero
                failed += 1
                print(f'FAIL  {name}')
                traceback.print_exc()
    finally:
        for e in tsp.EXPORTS.values():
            e.close()
    ran = len(tests) - skipped
    print(f'\n{ran - failed}/{ran} passed' + (f', {skipped} skipped' if skipped else ''))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
