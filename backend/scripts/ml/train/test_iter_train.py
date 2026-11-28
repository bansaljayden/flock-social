"""Fitting from row chunks gives the model that fitting the whole matrix gives.

WHY THIS FILE EXISTS. The November third candidate (about 54 to 90 million
training rows) does not fit the training PC as one in-memory X plus the copies a
fit makes of it, so prepare_features.py may write X beside the pickle
(features_io.py) and train_model.py then reads it memory-mapped, a row chunk at a
time (train_model.RowChunks, predict_rows). That is only acceptable if it changes
nothing. These checks fit train_model.train_xgboost on one fixture with X in
memory and with X memory-mapped from beside a pickle, at chunk sizes that split
cities (the rows are shuffled, so every chunk holds several), and require the
same booster bytes, parameters, metrics, out-of-fold predictions and per-fold
category shifts, with and without early stopping.

Run: python test_iter_train.py     (no pytest needed)
"""
import gc
import math
import os
import pickle
import sys
import tempfile
import traceback
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold

sys.path.insert(0, str(Path(__file__).parent))

import features_io as fio  # noqa: E402
import train_model as tm  # noqa: E402
from prepare_features import (  # noqa: E402
    add_baseline_features, build_category_cell_aggregates, index_category_cells,
    serving_population_mask,
)

CITIES = ['ashford', 'bo', 'carrow', 'dunmore', 'eastleigh']
CATEGORIES = ['bar', 'cafe', 'club']
FEATURES = ['category_baseline', 'refined_category_baseline', 'hour', 'day_of_week',
            'price_level', 'rating', 'noise']
# 7 and 61 cut every city into many chunks; 500 holds several cities a chunk; the
# last is larger than the fixture, one chunk.
CHUNK_SIZES = (7, 61, 500, 100_000)
SWITCHES = ('FLOCK_MAX_DEPTH', 'FLOCK_N_ESTIMATORS', 'FLOCK_HYPERPARAM_SEARCH',
            'FLOCK_EARLY_STOPPING_ROUNDS')
THREADS = 2


class switches:
    """Set the given switches for one block, and put every one back after."""

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


def make_frame(seed=11):
    rng = np.random.default_rng(seed)
    rows = []
    for ci, city in enumerate(CITIES):
        for cat in CATEGORIES:
            for venue in range(3):
                served = venue > 0  # venue 0 has no baseline and is filtered out
                for dow in range(7):
                    for hour in range(8, 24):
                        level = 35 + 7 * ci + 6 * CATEGORIES.index(cat) + 0.5 * hour + 3 * (dow >= 5)
                        if not served:
                            level -= 25
                        rt = int((hour + dow + venue) % 3 == 0)
                        # A delta the clock features can learn in every city, so the
                        # early-stopping probe keeps improving on held-out cities for
                        # many rounds instead of stopping at its first tree.
                        signal = 9 * np.sin(hour / 2.5) + 6 * (dow >= 5) - 4 * (dow == 0)
                        busy = level + signal + rng.normal(0, 8 if rt else 2)
                        rows.append({
                            'city': city,
                            'venue_id': f'{city}-{cat}-{venue}',
                            'venue_category': cat,
                            'day_of_week': dow,
                            'hour': hour,
                            'busyness_pct': float(np.clip(round(busy), 0, 100)),
                            'baseline_busyness': float(round(level)) if served else 0.0,
                            'price_level': float(venue % 3),
                            'rating': 4.0 + 0.2 * (venue % 2),
                            'noise': float(rng.normal()),
                            'is_realtime': rt,
                        })
    return pd.DataFrame(rows)


def fixture():
    """The real category pipeline on a small frame, rows shuffled across cities."""
    df, _maps = add_baseline_features(make_frame())
    agg = build_category_cell_aggregates(df, 'city')
    rows = df[serving_population_mask(df['baseline_busyness'])].reset_index(drop=True)
    rows = rows.iloc[np.random.default_rng(5).permutation(len(rows))].reset_index(drop=True)
    stats = index_category_cells(rows, agg)
    X = np.asfortranarray(rows[FEATURES].to_numpy(dtype=np.float32))
    y_actual = rows['busyness_pct'].to_numpy(dtype=np.float32)
    baseline = rows['baseline_busyness'].to_numpy(dtype=np.float32)
    y = (y_actual - baseline).astype(np.float32)
    sw = np.where(rows['is_realtime'].to_numpy() == 1, 1.0, 0.2).astype(np.float32)
    cities = rows['city'].array  # a pandas string array, as the pickle carries it
    return {'X': X, 'y': y, 'y_actual': y_actual, 'baseline': baseline, 'sample_weight': sw,
            'cities': cities, 'stats': stats}


class external_x:
    """X written beside a pickle with features_io and read back memory-mapped."""

    def __init__(self, X):
        self.X = X

    def __enter__(self):
        self.dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        p = Path(self.dir.name) / 'features_train.pkl'
        path, arr = fio.open_x_memmap(p, *self.X.shape)
        for start in range(0, len(self.X), 1000):
            arr[start:start + 1000] = self.X[start:start + 1000]
        keys = fio.finish_x(p, arr)
        del arr
        with open(p, 'wb') as f:
            pickle.dump({'feature_cols': FEATURES, **keys}, f)
        self.data = fio.load_features(p, verify=True, require_trust=False)
        assert isinstance(self.data['X'], np.memmap) and tm.reads_in_chunks(self.data['X'])
        return self.data['X']

    def __exit__(self, *exc):
        self.data = None
        gc.collect()  # Windows keeps a mapped file locked until the map is gone
        self.dir.cleanup()


class recording_fits:
    """Every XGBRegressor fit made inside the block, in order: its booster bytes and
    its evaluation history. train_xgboost makes the early-stopping probe's fit (when
    on), the shipped fit and one fit per fold, so a fold or probe booster that
    differs is caught even where its predictions happen to agree."""

    def __enter__(self):
        self.owner = next(k for k in tm.XGBRegressor.__mro__ if 'fit' in vars(k))
        self.original = vars(self.owner)['fit']
        fits, original = [], self.original

        def fit(est, *args, **kwargs):
            out = original(est, *args, **kwargs)
            history = getattr(est, 'evals_result_', None)
            fits.append({'booster': bytes(est.get_booster().save_raw('ubj')),
                         'evals': {k: {m: list(v) for m, v in d.items()} for k, d in history.items()}
                         if history else None})
            return out

        setattr(self.owner, 'fit', fit)
        return fits

    def __exit__(self, *exc):
        setattr(self.owner, 'fit', self.original)


def train(f, X, chunk_rows=None, **switch_values):
    fold_cats = tm.FoldCategoryBaselines(f['stats'], f['cities'], FEATURES, f['y_actual'])
    assert fold_cats.active and fold_cats.verify_reproduces_shipped(X) == 0.0
    cv = GroupKFold(n_splits=len(CITIES))
    folds = tm.assert_group_disjoint(cv, X, f['y'], f['cities'])
    with switches(**switch_values), recording_fits() as fits:
        out = tm.train_xgboost(X, f['y'], cv, folds, f['cities'], f['baseline'], f['y_actual'],
                               f['sample_weight'], tm.DEFAULT_DELTA_CLAMP, 'cpu', THREADS,
                               fold_cats=fold_cats, chunk_rows=chunk_rows)
    model, metrics, absolute, per_city, params, hp_info, es_info, _elapsed, shifts = out
    early = es_info.get('enabled', False)
    assert len(fits) == len(folds) + 1 + early, f'{len(fits)} fits for {len(folds)} folds'
    return {'booster': bytes(model.get_booster().save_raw('ubj')),
            'model_params': model.get_params(), 'metrics': metrics, 'absolute': absolute,
            'per_city': per_city, 'params': params, 'hp_info': hp_info, 'es_info': es_info,
            'shifts': shifts, 'model': model, 'fold_cats': fold_cats, 'folds': folds,
            'fits': fits}


def raw_oof(f, X, model, fold_cats, folds, chunk_rows=None):
    """evaluate_city_cv's out-of-fold predictions before the reconstruction."""
    saved = tm.reconstruct
    tm.reconstruct = lambda raw_delta, baseline, clamp: np.asarray(raw_delta, dtype=np.float64)
    try:
        _, oof, _, _ = tm.evaluate_city_cv(model, X, f['y'], folds, f['baseline'], f['y_actual'],
                                           f['sample_weight'], tm.DEFAULT_DELTA_CLAMP,
                                           fold_cats=fold_cats, chunk_rows=chunk_rows)
    finally:
        tm.reconstruct = saved
    return oof


def same_params(a, b):
    def same(x, z):
        return (isinstance(x, float) and isinstance(z, float) and math.isnan(x) and math.isnan(z)) or x == z
    return set(a) == set(b) and all(same(a[k], b[k]) for k in a)


def assert_same_run(want, got, label):
    assert got['booster'] == want['booster'], f'{label}: booster bytes differ'
    assert len(got['fits']) == len(want['fits']), f'{label}: {len(got["fits"])} fits vs {len(want["fits"])}'
    for i, (g, w) in enumerate(zip(got['fits'], want['fits'])):
        assert g['booster'] == w['booster'], f'{label}: fit {i} (probe, shipped fit, then folds) booster differs'
        assert g['evals'] == w['evals'], f'{label}: fit {i} evaluation history differs'
    assert same_params(got['model_params'], want['model_params']), f'{label}: model params differ'
    for key in ('metrics', 'per_city', 'params', 'hp_info', 'es_info', 'shifts'):
        if key == 'per_city':
            assert list(got[key]) == list(want[key]), f'{label}: fold order differs'
            assert all(np.array_equal(got[key][c], want[key][c]) for c in want[key]), \
                f'{label}: a fold holds other rows'
        else:
            assert got[key] == want[key], f'{label}: {key} differs: {got[key]} vs {want[key]}'
    assert np.array_equal(got['absolute'], want['absolute']), f'{label}: out-of-fold predictions differ'


SMALL = {'FLOCK_MAX_DEPTH': '4', 'FLOCK_N_ESTIMATORS': '15'}


def test_chunked_fit_equals_the_in_memory_fit_at_every_chunk_size():
    f = fixture()
    want = train(f, f['X'], **SMALL)
    with external_x(f['X']) as Xm:
        for k in CHUNK_SIZES:
            got = train(f, Xm, chunk_rows=k, **SMALL)
            assert_same_run(want, got, f'chunk_rows={k}')
            oof_want = raw_oof(f, f['X'], want['model'], want['fold_cats'], want['folds'])
            oof_got = raw_oof(f, Xm, got['model'], got['fold_cats'], got['folds'], chunk_rows=k)
            assert np.array_equal(oof_got, oof_want), f'chunk_rows={k}: raw out-of-fold predictions differ'
            del got


def test_early_stopping_from_chunks_stops_at_the_same_round():
    f = fixture()
    es = {'FLOCK_MAX_DEPTH': '6', 'FLOCK_N_ESTIMATORS': '400', 'FLOCK_EARLY_STOPPING_ROUNDS': '5'}
    want = train(f, f['X'], **es)
    info = want['es_info']
    # The stop must be a real one: many trees kept, and fewer than the cap.
    assert info['enabled'] and 1 < info['best_iteration'] < info['n_estimators_requested'], info
    history = want['fits'][0]['evals']['validation_0']['gate_mae']
    assert len(history) == info['best_iteration'] + 5, (len(history), info)
    oof_want = raw_oof(f, f['X'], want['model'], want['fold_cats'], want['folds'])
    with external_x(f['X']) as Xm:
        for k in (7, 500):
            got = train(f, Xm, chunk_rows=k, **es)
            assert_same_run(want, got, f'early stopping, chunk_rows={k}')
            oof_got = raw_oof(f, Xm, got['model'], got['fold_cats'], got['folds'], chunk_rows=k)
            assert np.array_equal(oof_got, oof_want), \
                f'early stopping, chunk_rows={k}: raw out-of-fold predictions differ'
            del got


def test_the_default_chunk_size_is_the_same_fit():
    f = fixture()
    want = train(f, f['X'], **SMALL)
    with external_x(f['X']) as Xm:
        got = train(f, Xm, **SMALL)
        assert_same_run(want, got, 'default chunk size')
        del got


def test_the_approximate_quantile_sketch_is_the_same_from_chunks():
    """The fixture above is small enough for XGBoost's quantile sketch to be exact,
    so it cannot see a chunking effect on the cut points. Here the sketch is in its
    approximate regime, shown by the cuts moving when the same rows come in reverse
    order, and chunks in row order still give the same cuts and the same booster."""
    import xgboost as xgb
    rng = np.random.default_rng(1)
    n = 400_000
    X = np.asfortranarray(np.c_[rng.normal(size=n), rng.lognormal(size=n),
                                np.round(rng.uniform(0, 1000, n), 1)].astype(np.float32))
    y = (X[:, 0] * 3 + np.log1p(X[:, 1])).astype(np.float32)
    w = rng.uniform(0.1, 1, n).astype(np.float32)
    whole = xgb.QuantileDMatrix(X, label=y, weight=w, max_bin=256, nthread=THREADS).get_quantile_cut()
    reverse = xgb.QuantileDMatrix(np.ascontiguousarray(X[::-1]), label=y[::-1], weight=w[::-1],
                                  max_bin=256, nthread=THREADS).get_quantile_cut()
    assert not np.array_equal(whole[1], reverse[1]), 'the sketch is exact here; this check has no teeth'
    params = dict(n_estimators=5, max_depth=3, learning_rate=0.1, subsample=0.9, colsample_bytree=0.8,
                  random_state=tm.RANDOM_STATE, tree_method='hist', device='cpu', n_jobs=THREADS)
    want = bytes(tm.XGBRegressor(**params).fit(X, y, sample_weight=w).get_booster().save_raw('ubj'))
    for k in (7919, 65536):
        cuts = xgb.QuantileDMatrix(tm.RowChunks(X, None, y, w, chunk_rows=k), max_bin=256,
                                   nthread=THREADS).get_quantile_cut()
        assert np.array_equal(cuts[0], whole[0]) and np.array_equal(cuts[1], whole[1]), \
            f'chunks of {k} rows moved the cut points'
        got = tm.XGBRegressor(**params).fit(tm.RowChunks(X, None, y, w, chunk_rows=k), None)
        assert bytes(got.get_booster().save_raw('ubj')) == want, f'chunks of {k} rows changed the booster'


def test_predict_rows_equals_predict_on_the_rows():
    f = fixture()
    model = train(f, f['X'], **SMALL)['model']
    X = f['X']
    rng = np.random.default_rng(3)
    mask = rng.random(len(X)) < 0.4
    picks = np.flatnonzero(mask)
    with external_x(X) as Xm:
        for k in CHUNK_SIZES:
            assert np.array_equal(tm.predict_rows(model, Xm, chunk_rows=k), model.predict(X))
            assert np.array_equal(tm.predict_rows(model, Xm, picks, chunk_rows=k), model.predict(X[picks]))
            assert np.array_equal(tm.predict_rows(model, Xm, mask, chunk_rows=k), model.predict(X[mask]))
            assert np.array_equal(tm.predict_rows(model, Xm, picks, chunk_rows=k, iteration_range=(0, 5)),
                                  model.predict(X[picks], iteration_range=(0, 5)))
        for bad in (picks[::-1], np.r_[picks[:3], picks[:3]], np.array([len(X)])):
            try:
                tm.predict_rows(model, Xm, bad)
            except ValueError:
                continue
            raise AssertionError(f'row indices {bad[:6]} were accepted out of order or range')


def test_a_chunk_never_writes_x():
    f = fixture()
    X = np.ascontiguousarray(f['X'])  # C order, where a full row slice is a view
    before = X.copy()
    fold_cats = tm.FoldCategoryBaselines(f['stats'], f['cities'], FEATURES, f['y_actual'])
    cols = fold_cats.columns_for_fold(CITIES[1])
    it = tm.RowChunks(X, None, f['y'], f['sample_weight'], fold_cats=fold_cats, fold_cols=cols,
                      chunk_rows=500)
    seen = []
    it.reset()
    while it.next(lambda **batch: seen.append(batch)):
        pass
    assert np.array_equal(X, before), 'a chunk carrying a fold map wrote into X'
    rebuilt = np.vstack([b['data'] for b in seen])
    want = X.copy()
    fold_cats.apply_to(want, np.arange(len(X)), cols)
    assert np.array_equal(rebuilt, want), 'the chunks are not X with the fold map'
    assert np.array_equal(np.concatenate([b['label'] for b in seen]), f['y'])
    assert np.array_equal(np.concatenate([b['weight'] for b in seen]), f['sample_weight'])


def test_the_folds_are_the_ones_the_city_names_give():
    f = fixture()
    X, y = f['X'], f['y']
    cv = GroupKFold(n_splits=len(CITIES))
    folds = tm.assert_group_disjoint(cv, X, y, f['cities'])
    by_name = list(cv.split(X, y, groups=np.asarray(f['cities'], dtype=object)))
    assert len(folds) == len(by_name)
    names = np.asarray(f['cities'], dtype=object)
    for (tr, va, city), (tr_want, va_want) in zip(folds, by_name):
        assert np.array_equal(tr, tr_want) and tr.dtype == tr_want.dtype
        assert np.array_equal(va, va_want)
        assert {city} == set(names[va_want].tolist())
    names_sorted, codes = tm.city_codes(f['cities'])
    assert names_sorted == sorted(CITIES) and codes.dtype == np.int16
    assert [names_sorted[c] for c in codes[:50]] == list(names[:50])


def test_a_row_group_from_another_row_order_is_still_refused():
    f = fixture()
    stats = dict(f['stats'])
    rg = np.array(stats['row_group'], copy=True)
    rg[:40] = rg[40:80]  # a plausible shuffle, not a length change
    stats['row_group'] = rg
    if np.array_equal(rg, f['stats']['row_group']):
        raise AssertionError('the fixture shuffle changed nothing')
    try:
        tm.FoldCategoryBaselines(stats, f['cities'], FEATURES, f['y_actual'])
    except tm.LeakageError as err:
        assert 'row_group disagrees' in str(err)
        return
    raise AssertionError('a row_group misaligned with the cities was accepted')


def test_the_search_refuses_an_x_beside_the_pickle():
    f = fixture()
    with external_x(f['X']) as Xm:
        try:
            train(f, Xm, FLOCK_HYPERPARAM_SEARCH='true')
        except ValueError as err:
            assert 'beside the pickle' in str(err), err
            return
    raise AssertionError('the hyperparameter search ran on a memory-mapped X')


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
