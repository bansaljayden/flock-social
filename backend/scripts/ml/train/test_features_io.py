"""features_io: X inline loads as before; X beside the pickle loads the same values.

Run: python test_features_io.py     (no pytest needed)
"""
import gc
import pickle
import sys
import tempfile
import traceback
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))

import features_io as fio  # noqa: E402


def sample():
    rng = np.random.default_rng(3)
    X = np.asfortranarray(rng.normal(size=(50, 4)).astype(np.float32))
    return X, {'y': np.arange(50, dtype=np.float32), 'feature_cols': ['a', 'b', 'c', 'd']}


def test_an_inline_pickle_loads_exactly_as_pickle_load():
    X, rest = sample()
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / 'features_train.pkl'
        with open(p, 'wb') as f:
            pickle.dump({'X': X, **rest}, f)
        with open(p, 'rb') as f:
            plain = pickle.load(f)
        got = fio.load_features(p)
        assert set(got) == set(plain)
        assert got['X'].tobytes(order='A') == plain['X'].tobytes(order='A')
        assert got['X'].flags.f_contiguous == plain['X'].flags.f_contiguous
        assert not fio.x_is_external(got)


def test_an_external_x_round_trips_every_value_and_the_layout():
    X, rest = sample()
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / 'features_train.pkl'
        path, arr = fio.open_x_memmap(p, *X.shape)
        assert path.name == 'features_train.X.npy'
        for start in range(0, len(X), 7):          # written in chunks, as step 8 does
            arr[start:start + 7] = X[start:start + 7]
        keys = fio.finish_x(p, arr)
        del arr
        with open(p, 'wb') as f:
            pickle.dump({**rest, **keys}, f)
        for mmap in (True, False):
            got = fio.load_features(p, mmap=mmap, verify=True)
            assert np.array_equal(got['X'], X)
            assert got['X'].dtype == np.float32 and got['X'].flags.f_contiguous
            assert got['feature_cols'] == rest['feature_cols']
            del got
        got = fio.load_features(p)
        assert fio.x_is_external(got) and isinstance(got['X'], np.memmap)
        del got
        gc.collect()  # Windows keeps a mapped file locked until the map is gone


def test_a_changed_file_or_a_wrong_shape_is_refused():
    X, rest = sample()
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / 'features_train.pkl'
        path, arr = fio.open_x_memmap(p, *X.shape)
        arr[:] = X
        keys = fio.finish_x(p, arr)
        del arr
        with open(p, 'wb') as f:
            pickle.dump({**rest, **keys, fio.X_SHAPE_KEY: [49, 4]}, f)
        for verify in (False, True):
            try:
                fio.load_features(p, verify=verify)
            except ValueError:
                pass
            else:
                raise AssertionError('a shape that disagrees with the file was accepted')
        with open(p, 'wb') as f:
            pickle.dump({**rest, **keys}, f)
        m = np.load(path, mmap_mode='r+')
        m[0, 0] += 1
        m.flush()
        del m
        gc.collect()
        try:
            fio.load_features(p, verify=True)
        except ValueError:
            return
        raise AssertionError('a changed X file passed verify')


def test_x_both_inline_and_external_is_refused():
    X, rest = sample()
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / 'features_train.pkl'
        with open(p, 'wb') as f:
            pickle.dump({'X': X, **rest, fio.X_FILE_KEY: 'features_train.X.npy'}, f)
        try:
            fio.load_features(p)
        except ValueError:
            return
        raise AssertionError('a pickle with X twice was accepted')


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
