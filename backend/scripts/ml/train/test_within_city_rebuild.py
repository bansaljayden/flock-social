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


# --- The rest of main()'s train branch: the sports columns, the live-feature
# policy and the time holdout. The rebuild once skipped all three, so a
# sports-on or live-off features_train.pkl, or any run with the default
# 14-day time holdout, was refused by verify_rebuild.

def _body(src, start, end_marker):
    body = src[src.index(start):]
    return body[:body.index(end_marker)]


def _train_feature_steps(body):
    """The ordered add_* steps a body applies to train_df, pf. prefix dropped."""
    import re
    return re.findall(r'train_df(?:, \w+)? = (?:pf\.)?(add_\w+)\(train_df\b', body)


def test_the_rebuild_builds_every_feature_step_main_builds_in_the_same_order():
    here = Path(__file__).parent
    main_src = _body((here / 'prepare_features.py').read_text(encoding='utf-8'),
                     'def main():', "venue_metadata['temp_norms']")
    rebuild_src = _body((here / 'within_city_eval.py').read_text(encoding='utf-8'),
                        'def rebuild_training_frame(', 'def verify_rebuild(')
    want = _train_feature_steps(main_src)
    got = _train_feature_steps(rebuild_src)
    assert 'add_sports_features' in want and 'add_live_features' in want, want
    assert got == want, (got, want)


def test_the_rebuild_applies_the_live_policy_and_the_time_holdout_before_any_row_drops():
    src = (Path(__file__).parent / 'within_city_eval.py').read_text(encoding='utf-8')
    body = _body(src, 'def rebuild_training_frame(', 'def verify_rebuild(')
    policy = body.index('apply_live_feature_policy()')
    cut = body.index('time_holdout_like_prepare_features(train_df, holdout_dates)')
    dropna = body.index("train_df.dropna(subset=['busyness_pct'])")
    first_feature = body.index('pf.add_temporal_features(train_df)')
    assert policy < cut < dropna < first_feature


def _with_policy(value, fn):
    saved = (pf.LIVE_FEATURE_POLICY, set(pf.DROPPED_FEATURES), dict(pf.DROP_REASONS))
    pf.LIVE_FEATURE_POLICY = value
    try:
        return fn()
    finally:
        pf.LIVE_FEATURE_POLICY = saved[0]
        pf.DROPPED_FEATURES.clear()
        pf.DROPPED_FEATURES.update(saved[1])
        pf.DROP_REASONS.clear()
        pf.DROP_REASONS.update(saved[2])


def test_live_features_off_drops_the_five_exactly_as_main_does():
    cols = {n: [1.0] for n in pf.LIVE_FEATURE_NAMES}
    cols.update({'hour': [20], 'busyness_pct': [40.0]})
    df = pd.DataFrame(cols)

    def off():
        wce.apply_live_feature_policy()
        return pf.get_feature_columns(df), dict(pf.DROP_REASONS)

    def on():
        wce.apply_live_feature_policy()
        return pf.get_feature_columns(df)

    feats_off, reasons = _with_policy('off', off)
    assert not set(pf.LIVE_FEATURE_NAMES) & set(feats_off), feats_off
    assert 'hour' in feats_off
    # The reason main() records, word for word.
    assert all(reasons[n] == 'FLOCK_LIVE_FEATURES=off (ablation)' for n in pf.LIVE_FEATURE_NAMES)
    feats_on = _with_policy('on', on)
    assert set(pf.LIVE_FEATURE_NAMES) <= set(feats_on), feats_on


def test_the_policy_is_part_of_the_cache_key():
    assert _with_policy('off', wce.rebuild_cache_key) != _with_policy('on', wce.rebuild_cache_key)


def _dated(date, city, source='live', realtime=1):
    return {'is_realtime': realtime, 'label_source': source, 'observed_date': date, 'city': city,
            'busyness_pct': 40.0}


def test_the_time_holdout_is_cut_as_main_cuts_it_over_both_frames():
    saved = {k: os.environ.pop(k, None) for k in (pf.TIME_HOLDOUT_FROM_ENV, pf.TIME_HOLDOUT_DAYS_ENV)}
    try:
        days = pd.date_range('2026-09-01', '2026-09-30').strftime('%Y-%m-%d')
        train = pd.DataFrame(
            [_dated(d, 'philly') for d in days[:25]]
            + [_dated(d, 'philly', source='forecast') for d in days[:25]]
            + [_dated(None, 'philly', source='', realtime=0)] * 3)
        # The holdout city's newest live reading is later than training's, so
        # the cut is five days deeper than training's own dates would put it.
        holdout = pd.DataFrame([_dated(d, 'miami') for d in days])
        got = wce.time_holdout_like_prepare_features(
            train.copy(), holdout[['is_realtime', 'label_source', 'observed_date']])
        th = pf.resolve_time_holdout([train, holdout])
        want, _ = pf.split_time_holdout(train.copy(), th['from_date'])
        assert th['from_date'] == '2026-09-17', th
        assert list(got.index) == list(want.index)
        assert got['observed_date'].dropna().max() == '2026-09-16'
        # Weekly rows stay; every realtime row on or after the cut leaves.
        assert int((got['is_realtime'] == 0).sum()) == 3
        assert len(got) == len(train) - 2 * (25 - 16)
    finally:
        for k, v in saved.items():
            if v is not None:
                os.environ[k] = v


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
