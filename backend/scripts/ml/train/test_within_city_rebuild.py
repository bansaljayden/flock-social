"""within_city_eval.py's rebuild weighs rows exactly as prepare_features.main() does.

WHY THIS FILE EXISTS. within_city_eval.py rebuilds the training frame and
refuses to measure anything unless the rebuild equals features_train.pkl,
sample_weight included. prepare_features divides each live reading's weight by
the length of its run of identical consecutive-hour readings, counted before
the serving filter, and solves the weekly anchor against the realtime total.
The rebuild wrote a fixed ladder of its own (live 1.0, forecast 0.3, weekly
0.05), so its equality check refused every rebuild. It now calls
filter_and_weight_like_prepare_features, and this pins that function to
main()'s arithmetic on a small frame.

Run: python test_within_city_rebuild.py     (no pytest needed)
"""
import os
import sys
import traceback
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))

ENV_KEYS = ('FLOCK_RUN_LENGTH_WEIGHTS', 'FLOCK_WEEKLY_ANCHOR_WEIGHT', 'ML_ALLOW_UNKNOWN_PROVENANCE')
for _k in ENV_KEYS:
    os.environ.pop(_k, None)

import prepare_features as pf  # noqa: E402
import within_city_eval as wce  # noqa: E402


def row(venue, date, hour, value, baseline=30.0, prov='live', realtime=1):
    return {'venue_id': venue, 'observed_date': date, 'hour': hour, 'busyness_pct': value,
            'baseline_busyness': baseline, 'is_realtime': realtime, 'label_provenance': prov}


# Venue 1 reads 40 at 17, 18 and 19: one run of three, whose middle hour has no
# curve (baseline 0) and is filtered out as a row the model never serves. The
# run is still three: it is counted before the filter, as main() counts it, so
# the two surviving hours weigh a third each, not one each. Venue 2 has a run
# of two (55 at 20 and 21), a forecast-labelled hour and an unknown-provenance
# realtime row, which main() excludes. Two weekly anchors, one without a curve.
ROWS = [
    row(1, '2026-09-02', 17, 40), row(1, '2026-09-02', 18, 40, baseline=0.0), row(1, '2026-09-02', 19, 40),
    row(2, '2026-09-02', 20, 55), row(2, '2026-09-02', 21, 55),
    row(2, '2026-09-03', 12, 25, prov='forecast'),
    row(2, '2026-09-03', 13, 60, prov='unknown'),
    row(1, None, 17, 30, prov='weekly', realtime=0),
    row(2, None, 20, 30, prov='weekly', realtime=0),
    row(2, None, 3, 0, baseline=0.0, prov='weekly', realtime=0),
]


def frame():
    return pd.DataFrame(ROWS)


def main_order(df):
    """prepare_features.main()'s steps from the run lengths to the weights, restated."""
    df['live_run_length'] = pf.live_run_lengths(df)
    df = df[pf.serving_population_mask(df['baseline_busyness'])]
    df['label_provenance'] = df['label_provenance'].fillna('unknown')
    df, _ = pf.exclude_unknown_provenance(df, 'train')
    df = df.copy()
    pf.assign_sample_weights(df, pf.RUN_LENGTH_POLICY)
    return df


def test_the_rebuild_weighs_every_row_as_prepare_features_does():
    got = wce.filter_and_weight_like_prepare_features(frame())
    want = main_order(frame())
    assert list(got.index) == list(want.index), (list(got.index), list(want.index))
    assert np.array_equal(got['sample_weight'].to_numpy(), want['sample_weight'].to_numpy()), (
        got['sample_weight'].tolist(), want['sample_weight'].tolist())
    # The comparison verify_rebuild makes, in the dtype it makes it.
    assert np.array_equal(got['sample_weight'].to_numpy().astype(np.float32),
                          want['sample_weight'].to_numpy().astype(np.float32))


def test_runs_are_counted_before_the_serving_filter():
    got = wce.filter_and_weight_like_prepare_features(frame())
    v1 = got[(got['venue_id'] == 1) & (got['is_realtime'] == 1)].sort_values('hour')
    assert v1['hour'].tolist() == [17, 19], v1['hour'].tolist()
    assert v1['live_run_length'].tolist() == [3, 3], v1['live_run_length'].tolist()
    if pf.RUN_LENGTH_POLICY == 'on':
        assert np.allclose(v1['sample_weight'].to_numpy(), [1 / 3, 1 / 3]), v1['sample_weight'].tolist()


def test_tiers_exclusions_and_the_weekly_anchor():
    got = wce.filter_and_weight_like_prepare_features(frame())
    # Unknown provenance is excluded; the curve-less weekly anchor is filtered.
    assert not (got['label_provenance'] == 'unknown').any()
    assert len(got) == 7, len(got)
    fc = got[got['label_provenance'] == 'forecast']['sample_weight'].tolist()
    assert fc == [0.3], fc
    v2 = got[(got['venue_id'] == 2) & (got['label_provenance'] == 'live')]['sample_weight'].tolist()
    assert np.allclose(v2, [0.5, 0.5] if pf.RUN_LENGTH_POLICY == 'on' else [1.0, 1.0]), v2
    weekly = got[got['is_realtime'] != 1]['sample_weight'].to_numpy()
    rt_sum = float(got[got['is_realtime'] == 1]['sample_weight'].sum())
    policy = pf.resolve_weekly_anchor_weight(rt_sum, len(weekly))
    assert np.allclose(weekly, policy['weight']), (weekly.tolist(), policy)


def test_the_old_fixed_ladder_is_gone():
    src = (Path(__file__).parent / 'within_city_eval.py').read_text(encoding='utf-8')
    assert "train_df['is_realtime'] != 1, 0.05" not in src
    body = src[src.index('def rebuild_training_frame('):]
    assert 'filter_and_weight_like_prepare_features(train_df)' in body


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
