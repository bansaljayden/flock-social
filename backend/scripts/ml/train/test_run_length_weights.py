"""Run-length weights for sticky live readings, checked on small frames.

WHY THIS FILE EXISTS. 81% of consecutive-hour live readings of a venue are
identical, because BestTime's live value refreshes more slowly than the hourly
sweep reads it. prepare_features.py (2026-09-25) divides a live row's tier
weight by the length of its run of identical consecutive-hour readings, so one
vendor update counts once however many hours it was stored. Getting the run
wrong is silent: every row still has a weight, just not the one argued for.

What is pinned here:
  * what a run is: one venue, one local date, consecutive hours, one value;
    broken by midnight, a gap, a forecast-labelled hour or another venue;
  * who is divided: live readings only, and only under FLOCK_RUN_LENGTH_WEIGHTS=on;
  * the composition: tier weight / run length, the weekly anchor solved against
    the divided realtime total under FLOCK_WEEKLY_ANCHOR_WEIGHT=auto, and
    train_model.assert_weighting_matches_provenance accepting exactly that.

Run: python test_run_length_weights.py     (no pytest needed)
"""
import os
import sys
import traceback
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))

import prepare_features as pf  # noqa: E402
from prepare_features import (  # noqa: E402
    CorpusContractError, RUN_LENGTH_ENV, WEEKLY_ANCHOR_AUTO_SHARE, assign_sample_weights,
    live_run_lengths, run_length_divisor,
)


def row(venue, date, hour, value, prov='live', realtime=1):
    return {'venue_id': venue, 'observed_date': date, 'hour': hour, 'busyness_pct': value,
            'is_realtime': realtime, 'label_provenance': prov}


# (row, expected run length). Venue 1 on 09-02 reads 40 at 17, 18 and 19 (one
# run of three), 55 at 20 and 21 (two), 70 at 22 (one) and 70 again at 23,
# which extends it. On 09-03 it reads 70 at 00: a new date, a new run. 09-04:
# 30 at 10 and 30 at 12, a gap between, so two runs of one. 09-05: 25 at 14,
# a FORECAST-labelled 25 at 15 and 25 at 16: the forecast hour breaks the run
# and is not divided itself. Venue 2 reads 40 at the same 17-19 as venue 1: its
# own run. Weekly rows are never divided.
CASES = [
    (row(1, '2026-09-02', 17, 40), 3), (row(1, '2026-09-02', 18, 40), 3), (row(1, '2026-09-02', 19, 40), 3),
    (row(1, '2026-09-02', 20, 55), 2), (row(1, '2026-09-02', 21, 55), 2),
    (row(1, '2026-09-02', 22, 70), 2), (row(1, '2026-09-02', 23, 70), 2),
    (row(1, '2026-09-03', 0, 70), 1),
    (row(1, '2026-09-04', 10, 30), 1), (row(1, '2026-09-04', 12, 30), 1),
    (row(1, '2026-09-05', 14, 25), 1), (row(1, '2026-09-05', 15, 25, prov='forecast'), 1),
    (row(1, '2026-09-05', 16, 25), 1),
    (row(2, '2026-09-02', 17, 40), 3), (row(2, '2026-09-02', 18, 40), 3), (row(2, '2026-09-02', 19, 40), 3),
    (row(1, None, 17, 40, prov='weekly', realtime=0), 1), (row(1, None, 18, 40, prov='weekly', realtime=0), 1),
]


def frame():
    return pd.DataFrame([r for r, _ in CASES])


def test_a_run_is_consecutive_identical_hours_of_one_venue_on_one_date():
    got = live_run_lengths(frame()).tolist()
    assert got == [n for _, n in CASES], got


def test_frame_order_does_not_change_any_row_s_run():
    df = frame()
    shuffled = df.sample(frac=1.0, random_state=7)
    got = pd.Series(live_run_lengths(shuffled), index=shuffled.index).sort_index().tolist()
    assert got == [n for _, n in CASES], got


def test_two_live_readings_of_one_venue_hour_refuse():
    df = pd.concat([frame(), pd.DataFrame([row(1, '2026-09-02', 18, 41)])], ignore_index=True)
    try:
        live_run_lengths(df)
    except CorpusContractError:
        return
    raise AssertionError('a duplicated live venue-hour was given a run length')


def test_the_divisor_is_the_run_length_on_live_rows_under_on_only():
    df = frame()
    lengths = live_run_lengths(df)
    on = run_length_divisor(df, lengths, 'on').tolist()
    assert on == [n for _, n in CASES], on
    off = run_length_divisor(df, lengths, 'off').tolist()
    assert off == [1] * len(CASES), off
    try:
        run_length_divisor(df, lengths, 'yes')
    except CorpusContractError:
        pass
    else:
        raise AssertionError('a policy outside on/off was accepted')


def weight_frame():
    df = frame()
    df['live_run_length'] = live_run_lengths(df)
    # 200 more weekly anchors, enough that the auto weight lands under its 0.05 cap
    extra = pd.DataFrame([row(3, None, h % 24, 20, prov='weekly', realtime=0) for h in range(200)])
    extra['live_run_length'] = 1
    return pd.concat([df, extra], ignore_index=True)


def test_live_rows_weigh_one_over_their_run_and_the_anchor_is_solved_against_that():
    df = weight_frame()
    policy, divisor = assign_sample_weights(df, 'on', env={'FLOCK_WEEKLY_ANCHOR_WEIGHT': 'auto'})
    w = df['sample_weight'].to_numpy()
    live = (df['label_provenance'] == 'live').to_numpy()
    forecast = (df['label_provenance'] == 'forecast').to_numpy()
    weekly = (df['is_realtime'] != 1).to_numpy()
    assert np.allclose(w[live], 1.0 / df['live_run_length'].to_numpy()[live]), w[live]
    assert np.allclose(w[forecast], 0.3)
    # 15 live readings in 9 runs weigh 9.0, one forecast 0.3: the realtime total
    assert abs(w[live].sum() - 9.0) < 1e-12, w[live].sum()
    realtime_total = 9.0 + 0.3
    assert np.allclose(w[weekly], policy['weight'])
    share = realtime_total / (realtime_total + policy['weight'] * weekly.sum())
    assert abs(share - WEEKLY_ANCHOR_AUTO_SHARE) < 1e-9, share
    assert policy['realtime_loss_share'] == round(share, 4)
    rec = policy['live_run_length']
    assert rec['policy'] == 'on' and rec['env'] == RUN_LENGTH_ENV
    assert rec['live_rows'] == 15 and rec['live_weight_before'] == 15 and rec['live_weight_after'] == 9.0
    assert rec['live_rows_by_run_length'] == {'1': 5, '2': 4, '3': 6}, rec
    assert divisor.tolist()[:len(CASES)] == [n for _, n in CASES]


def test_off_leaves_every_live_row_at_its_tier_weight():
    df = weight_frame()
    policy, divisor = assign_sample_weights(df, 'off', env={'FLOCK_WEEKLY_ANCHOR_WEIGHT': 'auto'})
    w = df['sample_weight'].to_numpy()
    live = (df['label_provenance'] == 'live').to_numpy()
    assert np.all(w[live] == 1.0)
    assert np.all(divisor == 1)
    weekly = (df['is_realtime'] != 1).to_numpy()
    share = (15 + 0.3) / (15 + 0.3 + policy['weight'] * weekly.sum())
    assert abs(share - WEEKLY_ANCHOR_AUTO_SHARE) < 1e-9, share
    assert policy['live_run_length']['live_weight_after'] == 15.0


def test_the_default_anchor_weight_is_untouched_by_the_division():
    df = weight_frame()
    policy, _ = assign_sample_weights(df, 'on', env={})
    assert policy['policy'] == 'default' and policy['weight'] == 0.05
    assert np.allclose(df.loc[df['is_realtime'] != 1, 'sample_weight'], 0.05)


def test_the_trainer_accepts_the_composition_and_refuses_anything_else():
    import train_model as tm
    df = weight_frame()
    _, divisor = assign_sample_weights(df, 'on', env={'FLOCK_WEEKLY_ANCHOR_WEIGHT': 'auto'})
    w = df['sample_weight'].to_numpy().astype(np.float32)   # as the pickle stores it
    rt = df['is_realtime'].to_numpy() == 1
    prov = df['label_provenance'].to_numpy()
    tiers = tm.assert_weighting_matches_provenance(w, rt, prov, divisor)
    assert tiers['realtime_observed']['weight'] == 1.0, tiers
    assert tiers['realtime_observed']['rows_divided_by_run_length'] == 10, tiers
    # Without the divisor the live tier holds three weights and is refused.
    try:
        tm.assert_weighting_matches_provenance(w, rt, prov)
    except tm.LabelContractError:
        pass
    else:
        raise AssertionError('divided live weights passed as one tier without their divisor')
    # A forecast row may not carry a divisor, however its weight was written.
    bad = divisor.copy()
    bad[(prov == 'forecast')] = 2
    try:
        tm.assert_weighting_matches_provenance(w, rt, prov, bad)
    except tm.LabelContractError:
        pass
    else:
        raise AssertionError('a divisor on a forecast row was accepted')
    # A live row weighed at something other than 1 / run length.
    skew = w.copy()
    skew[np.flatnonzero(prov == 'live')[0]] = 0.5
    try:
        tm.assert_weighting_matches_provenance(skew, rt, prov, divisor)
    except tm.LabelContractError:
        pass
    else:
        raise AssertionError('a live weight that is not tier / run length was accepted')


def test_the_flag_takes_on_or_off_and_nothing_else():
    saved = os.environ.get(RUN_LENGTH_ENV)
    try:
        os.environ[RUN_LENGTH_ENV] = 'OFF'
        assert pf._policy(RUN_LENGTH_ENV, 'on', {'on', 'off'}) == 'off'
        os.environ[RUN_LENGTH_ENV] = 'sometimes'
        try:
            pf._policy(RUN_LENGTH_ENV, 'on', {'on', 'off'})
        except CorpusContractError:
            pass
        else:
            raise AssertionError(f'{RUN_LENGTH_ENV}=sometimes was accepted')
    finally:
        if saved is None:
            os.environ.pop(RUN_LENGTH_ENV, None)
        else:
            os.environ[RUN_LENGTH_ENV] = saved
    assert pf.RUN_LENGTH_POLICY in ('on', 'off')


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
