"""The model's size moves only through FLOCK_MAX_DEPTH and FLOCK_N_ESTIMATORS.

WHY THIS FILE EXISTS. The November runbook (2026-11-25) lets the capacity
probe choose a deeper or longer model on training cities, and that choice has
to reach both candidates and the final refit the same way, recorded where
final_refit_gate.py compares the recipe (best_params). These checks pin what
the switches do: unset, the registered FIXED_PARAMS size is fitted; set, only
depth and tree count change, the fitted booster has that size, and the
metadata names the switch; a malformed value, or a switch beside the search,
stops the run instead of training a size nobody chose.

Run: python test_size_switches.py     (no pytest needed)
"""
import os
import sys
import traceback
from pathlib import Path

import numpy as np
from sklearn.model_selection import GroupKFold

sys.path.insert(0, str(Path(__file__).parent))

import train_model as tm  # noqa: E402

SWITCHES = ('FLOCK_MAX_DEPTH', 'FLOCK_N_ESTIMATORS', 'FLOCK_HYPERPARAM_SEARCH',
            'FLOCK_EARLY_STOPPING_ROUNDS')


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


def fixture():
    rng = np.random.default_rng(7)
    n = 90
    X = rng.normal(size=(n, 3)).astype(np.float32)
    cities = np.array(['a', 'b', 'c'] * (n // 3), dtype=object)
    baseline = rng.uniform(10, 80, size=n)
    y = (X[:, 0] * 5).astype(np.float64)
    y_actual = np.clip(baseline + y, 0, 100)
    return X, y, cities, baseline, y_actual, np.ones(n)


def fit(**values):
    X, y, cities, baseline, y_actual, sw = fixture()
    cv = GroupKFold(n_splits=3)
    folds = tm.assert_group_disjoint(cv, X, y, cities)
    with switches(**values):
        out = tm.train_xgboost(X, y, cv, folds, cities, baseline, y_actual, sw,
                               tm.DEFAULT_DELTA_CLAMP, 'cpu', 1)
    model, params, hp_info = out[0], out[4], out[5]
    return model, params, hp_info


def refused(**values):
    with switches(**values):
        try:
            tm.size_overrides()
        except ValueError:
            return True
    return False


def test_unset_is_the_registered_size():
    with switches():
        assert tm.size_overrides() == {}
    model, params, hp_info = fit()
    assert params == tm.FIXED_PARAMS, params
    assert hp_info['size_switches'] == {}, hp_info
    assert model.get_booster().num_boosted_rounds() == tm.FIXED_PARAMS['n_estimators']


def test_the_registered_size_is_depth_8_and_800_trees():
    # The runbook's "registered setting" is this pair; a silent edit here would
    # move the comparator of the capacity probe's 2% rule.
    assert tm.FIXED_PARAMS['max_depth'] == 8 and tm.FIXED_PARAMS['n_estimators'] == 800
    assert tm.FIXED_PARAMS['learning_rate'] == 0.01


def test_switches_change_only_depth_and_tree_count():
    model, params, hp_info = fit(FLOCK_MAX_DEPTH='3', FLOCK_N_ESTIMATORS='7')
    assert params == {**tm.FIXED_PARAMS, 'max_depth': 3, 'n_estimators': 7}, params
    assert hp_info['size_switches'] == {'FLOCK_MAX_DEPTH': 3, 'FLOCK_N_ESTIMATORS': 7}, hp_info
    assert model.get_params()['max_depth'] == 3
    assert model.get_booster().num_boosted_rounds() == 7


def test_one_switch_alone_moves_one_setting():
    model, params, hp_info = fit(FLOCK_N_ESTIMATORS='5')
    assert params['max_depth'] == tm.FIXED_PARAMS['max_depth']
    assert params['n_estimators'] == 5
    assert hp_info['size_switches'] == {'FLOCK_N_ESTIMATORS': 5}, hp_info


def test_a_bad_value_is_refused_not_rounded():
    for bad in ('8.5', '-1', '0', '17', ' 1e3', 'ten', '８'):
        assert refused(FLOCK_MAX_DEPTH=bad), f'FLOCK_MAX_DEPTH={bad!r} was accepted'
    for bad in ('0', '20001', '800.0', '', '   '):
        assert refused(FLOCK_N_ESTIMATORS=bad), f'FLOCK_N_ESTIMATORS={bad!r} was accepted'
    assert refused(FLOCK_MAX_DEPTH=''), 'a blank FLOCK_MAX_DEPTH was read as unset'
    assert not refused(FLOCK_MAX_DEPTH='16', FLOCK_N_ESTIMATORS='20000')
    assert not refused(FLOCK_MAX_DEPTH=' 12 ')


def test_a_switch_beside_the_search_is_refused():
    try:
        fit(FLOCK_HYPERPARAM_SEARCH='true', FLOCK_MAX_DEPTH='10')
    except ValueError as e:
        assert 'FLOCK_HYPERPARAM_SEARCH' in str(e)
        return
    raise AssertionError('a size switch beside the search was accepted')


def test_early_stopping_through_the_trainer_caps_at_the_switched_size():
    X, y, cities, baseline, y_actual, sw = fixture()
    cv = GroupKFold(n_splits=3)
    folds = tm.assert_group_disjoint(cv, X, y, cities)
    with switches(FLOCK_N_ESTIMATORS='6', FLOCK_MAX_DEPTH='2', FLOCK_EARLY_STOPPING_ROUNDS='50'):
        out = tm.train_xgboost(X, y, cv, folds, cities, baseline, y_actual, sw,
                               tm.DEFAULT_DELTA_CLAMP, 'cpu', 1)
    model, params, hp_info, es_info = out[0], out[4], out[5], out[6]
    # The probe was handed the switched size, and the shipped fit is the round it chose.
    assert es_info['enabled'] and es_info['n_estimators_requested'] == 6, es_info
    assert params['n_estimators'] == es_info['best_iteration'] <= 6, (params, es_info)
    assert params['max_depth'] == 2 and model.get_params()['max_depth'] == 2
    assert model.get_booster().num_boosted_rounds() == params['n_estimators']
    assert hp_info['size_switches'] == {'FLOCK_MAX_DEPTH': 2, 'FLOCK_N_ESTIMATORS': 6}, hp_info


def test_the_experiments_that_keep_the_registered_size_refuse_a_switch():
    import subprocess
    env = {k: v for k, v in os.environ.items() if k not in SWITCHES}
    env['FLOCK_MAX_DEPTH'] = '10'
    for script in ('train_two_head.py', 'within_city_eval.py', 'sports_ablation.py'):
        r = subprocess.run([sys.executable, script], cwd=Path(__file__).parent, env=env,
                           capture_output=True, text=True, timeout=300)
        said = r.stdout + r.stderr
        assert r.returncode != 0 and 'FLOCK_MAX_DEPTH is set' in said, f'{script}: {said[-800:]}'


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
