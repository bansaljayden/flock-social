"""is_realtime is a carried column, not a feature, checked on small inputs.

WHY THIS FILE EXISTS. mlPredictor.buildFeatureMap sets is_realtime to 1 on
every prediction, so as a feature it only told the model which label regime a
training row came from (PRE-RETRAIN-AUDIT finding 18; 6.1% of v2.6.0-starling's
split gain). Since 2026-09-25 get_feature_columns excludes it and every reader
takes it from the key both pickles carry, through
prepare_features.realtime_flags. The failure this guards against is silent: a
reader that still looks for the flag in X would find nothing, and the old
fallback in quick_eval and train_model read that as "every row is weekly",
which empties the gate slice and the served-slice metrics mlPredictor publishes.

Run: python test_realtime_flag.py     (no pytest needed)
"""
import sys
import traceback
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))

import prepare_features as pf  # noqa: E402
from prepare_features import CorpusContractError, get_feature_columns, realtime_flags  # noqa: E402


def test_the_carried_key_is_read_and_x_is_not():
    data = {'X': np.zeros((4, 2), dtype=np.float32), 'feature_cols': ['hour', 'day_of_week'],
            'is_realtime': np.array([1, 0, 1, 1], dtype=np.int8)}
    assert realtime_flags(data).tolist() == [1, 0, 1, 1]


def test_the_key_wins_over_a_stale_column_of_the_same_name():
    data = {'X': np.array([[0.0], [0.0]], dtype=np.float32), 'feature_cols': ['is_realtime'],
            'is_realtime': np.array([1, 1], dtype=np.int8)}
    assert realtime_flags(data).tolist() == [1, 1]


def test_a_pickle_from_before_the_key_is_read_by_position():
    # models/incumbent/features_holdout.pkl (2026-08-18) has the flag as a feature only.
    data = {'X': np.array([[3.0, 1.0], [4.0, 0.0], [5.0, 1.0]], dtype=np.float32),
            'feature_cols': ['hour', 'is_realtime']}
    assert realtime_flags(data).tolist() == [1, 0, 1]


def test_a_pickle_with_neither_is_refused_not_read_as_all_weekly():
    data = {'X': np.zeros((3, 1), dtype=np.float32), 'feature_cols': ['hour']}
    try:
        realtime_flags(data)
    except CorpusContractError:
        return
    raise AssertionError('a pickle with no is_realtime was read as something')


def test_is_realtime_is_never_a_feature_column():
    df = pd.DataFrame({'hour': [1], 'day_of_week': [2], 'is_realtime': [1], 'log_neighbor_count': [0.5],
                       'sample_weight': [1.0], 'live_run_length': [2]})
    cols = get_feature_columns(df)
    assert 'is_realtime' not in cols, cols
    assert 'live_run_length' not in cols and 'sample_weight' not in cols, cols
    assert cols == ['day_of_week', 'hour', 'log_neighbor_count'], cols


def test_the_trainer_refuses_it_by_name():
    import train_model as tm
    assert 'is_realtime' in tm.FORBIDDEN_FEATURES
    try:
        tm.assert_no_forbidden_features(['hour', 'is_realtime'])
    except tm.LeakageError:
        return
    raise AssertionError('train_model accepted is_realtime as a feature')


def test_quick_eval_and_the_trainer_read_it_through_the_same_function():
    import quick_eval as qe
    import train_model as tm
    assert qe.realtime_flags is pf.realtime_flags
    assert tm.realtime_flags is pf.realtime_flags


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
