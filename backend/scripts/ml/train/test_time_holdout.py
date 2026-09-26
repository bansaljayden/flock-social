"""The time holdout and the served-baseline smoothing, checked on small frames.

WHY THIS FILE EXISTS. Two changes to prepare_features.py (2026-09-25) decide
which live readings the band gate may score and which rows the model trains on:

  * resolve_time_holdout / split_time_holdout cut every realtime row observed
    on or after the cutoff out of the TRAINING frame before anything is fitted,
    so bandEval.js --gate can score the exported artifact on readings it
    provably never saw. Getting this wrong is silent: a held-out row left in
    training scores itself.
  * smooth_baseline_hours now blends a slot whose own baseline row holds 0 when
    a clock neighbour is positive, because mlPredictor.blendBaselineRows does
    and production serves the MODEL there. A slot with no baseline row at all
    still stays 0, because production answers those from the rule engine.

__tests__/mlSmoothingParity.test.js runs the second property against the real
JavaScript over a random grid; this file pins both on hand-built frames.

Run: python test_time_holdout.py     (no pytest needed)
"""
import sys
import traceback
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))

from prepare_features import (  # noqa: E402
    CorpusContractError, DEFAULT_TIME_HOLDOUT_DAYS, DEFAULT_WEEKLY_ANCHOR_WEIGHT,
    WEEKLY_ANCHOR_AUTO_SHARE, resolve_time_holdout, resolve_weekly_anchor_weight,
    smooth_baseline_hours, split_time_holdout,
)


def live_frame():
    rows = []
    for city, venue in (('philly', 1), ('lehigh', 2)):
        for day in range(1, 21):  # 2026-09-01 .. 09-20
            date = f'2026-09-{day:02d}'
            rows.append({'venue_id': venue, 'city': city, 'is_realtime': 1, 'label_source': 'live',
                         'observed_date': date, 'day_of_week': 0, 'hour': 20, 'busyness_pct': 50,
                         'baseline_busyness': 40})
        # a forecast-labelled reading late in the window, and weekly rows with no date
        rows.append({'venue_id': venue, 'city': city, 'is_realtime': 1, 'label_source': 'forecast',
                     'observed_date': '2026-09-19', 'day_of_week': 0, 'hour': 21, 'busyness_pct': 30,
                     'baseline_busyness': 40})
        for hour in range(24):
            rows.append({'venue_id': venue, 'city': city, 'is_realtime': 0, 'label_source': None,
                         'observed_date': None, 'day_of_week': 0, 'hour': hour, 'busyness_pct': 40,
                         'baseline_busyness': 40})
    return pd.DataFrame(rows)


def test_default_is_the_last_fourteen_days_of_live_readings():
    th = resolve_time_holdout([live_frame()], env={})
    assert DEFAULT_TIME_HOLDOUT_DAYS == 14
    assert th['policy'] == 'last_days'
    assert th['last_live_date'] == '2026-09-20'
    assert th['from_date'] == '2026-09-07', th


def test_an_explicit_date_wins_and_is_validated():
    th = resolve_time_holdout([live_frame()], env={'FLOCK_TIME_HOLDOUT_FROM': '2026-09-15',
                                                   'FLOCK_TIME_HOLDOUT_DAYS': '3'})
    assert (th['policy'], th['from_date']) == ('explicit_date', '2026-09-15')
    for bad in ('2026-9-15', 'tomorrow', '2026-02-30'):
        try:
            resolve_time_holdout([live_frame()], env={'FLOCK_TIME_HOLDOUT_FROM': bad})
        except CorpusContractError:
            continue
        raise AssertionError(f'{bad!r} was accepted as a date')


def test_zero_days_turns_it_off_and_negative_or_junk_refuses():
    th = resolve_time_holdout([live_frame()], env={'FLOCK_TIME_HOLDOUT_DAYS': '0'})
    assert (th['policy'], th['from_date']) == ('off', None)
    for bad in ('-1', 'two'):
        try:
            resolve_time_holdout([live_frame()], env={'FLOCK_TIME_HOLDOUT_DAYS': bad})
        except CorpusContractError:
            continue
        raise AssertionError(f'FLOCK_TIME_HOLDOUT_DAYS={bad!r} was accepted')


def test_a_corpus_with_no_live_readings_has_nothing_to_hold_out():
    df = live_frame()
    df = df[df.label_source != 'live']
    th = resolve_time_holdout([df], env={})
    assert (th['policy'], th['from_date'], th['last_live_date']) == ('no_live_rows', None, None)


def test_the_split_removes_every_realtime_row_in_the_window_and_nothing_else():
    df = live_frame()
    kept, rec = split_time_holdout(df, '2026-09-15')
    # 6 live days per venue (15..20) and the forecast row on the 19th
    assert rec['live_rows_held_out'] == 12, rec
    assert rec['realtime_rows_held_out'] == 14, rec
    assert rec['held_out_by_city'] == {'philly': 7, 'lehigh': 7}
    assert rec['training_live_through'] == '2026-09-14'
    assert len(kept) == len(df) - 14
    assert int((kept.is_realtime == 0).sum()) == 48, 'weekly rows are never held out'
    held = kept[(kept.is_realtime == 1) & (kept.observed_date >= '2026-09-15')]
    assert held.empty, 'a held-out row left in training scores itself'


def test_no_cutoff_keeps_everything_and_still_reports_the_horizon():
    df = live_frame()
    kept, rec = split_time_holdout(df, None)
    assert len(kept) == len(df)
    assert rec['realtime_rows_held_out'] == 0
    assert rec['training_live_through'] == '2026-09-20'


def blend_js(cur, prev, nxt):
    """mlPredictor.blendBaselineRows for one slot that HAS a row."""
    if prev > 0 or nxt > 0:
        return float(np.floor(cur * 0.6 + (prev or cur) * 0.2 + (nxt or cur) * 0.2 + 0.5))
    return float(cur)


def test_a_zero_slot_with_a_row_and_a_busy_neighbour_is_blended_like_production():
    rows = []
    # venue 7: 09:00 = 40, 10:00 = 0 (a weekly row holding 0), 11:00 = 40
    for hour, b in ((9, 40), (10, 0), (11, 40)):
        rows.append({'venue_id': 7, 'day_of_week': 2, 'hour': hour, 'baseline_busyness': b, 'is_realtime': 0})
    # a live reading at 10:00 exported with that slot's baseline, 0
    rows.append({'venue_id': 7, 'day_of_week': 2, 'hour': 10, 'baseline_busyness': 0, 'is_realtime': 1})
    # venue 8 has NO weekly row at 10:00: its live reading there exports 0 and
    # production answers it from the rule engine, however busy 09:00 and 11:00 are
    for hour, b in ((9, 40), (11, 40)):
        rows.append({'venue_id': 8, 'day_of_week': 2, 'hour': hour, 'baseline_busyness': b, 'is_realtime': 0})
    rows.append({'venue_id': 8, 'day_of_week': 2, 'hour': 10, 'baseline_busyness': 0, 'is_realtime': 1})
    out = smooth_baseline_hours(pd.DataFrame(rows))
    got = out['baseline_busyness'].tolist()
    expect_zero_slot = blend_js(0, 40, 40)
    assert expect_zero_slot == 16.0
    assert got[1] == expect_zero_slot, got
    assert got[3] == expect_zero_slot, 'the live row at the zero slot gets the served baseline too'
    assert got[6] == 0.0, 'no baseline row at the slot means no baseline, as in production'


def test_smoothing_refuses_a_frame_that_cannot_tell_a_zero_row_from_no_row():
    df = pd.DataFrame({'venue_id': [1], 'day_of_week': [0], 'hour': [0], 'baseline_busyness': [0.0]})
    try:
        smooth_baseline_hours(df)
    except CorpusContractError:
        return
    raise AssertionError('smooth_baseline_hours accepted a frame without is_realtime')


def test_the_weekly_anchor_weight_defaults_to_the_v231_blend():
    assert DEFAULT_WEEKLY_ANCHOR_WEIGHT == 0.05
    assert resolve_weekly_anchor_weight(60000.0, 1700000, env={}) == {'policy': 'default', 'weight': 0.05}


def test_auto_gives_live_rows_their_share_of_the_loss_and_never_exceeds_the_default():
    rec = resolve_weekly_anchor_weight(60000.0, 1700000, env={'FLOCK_WEEKLY_ANCHOR_WEIGHT': 'auto'})
    assert rec['policy'] == 'auto'
    share = 60000.0 / (60000.0 + rec['weight'] * 1700000)
    assert abs(share - WEEKLY_ANCHOR_AUTO_SHARE) < 1e-9, share
    # v2.6.0's corpus already had live rows at 82% of the loss: auto keeps 0.05
    big = resolve_weekly_anchor_weight(369076.0, 1565912, env={'FLOCK_WEEKLY_ANCHOR_WEIGHT': 'auto'})
    assert big['weight'] == 0.05


def test_an_explicit_anchor_weight_must_stay_below_a_forecast_label():
    assert resolve_weekly_anchor_weight(1.0, 1, env={'FLOCK_WEEKLY_ANCHOR_WEIGHT': '0.01'})['weight'] == 0.01
    assert resolve_weekly_anchor_weight(1.0, 1, env={'FLOCK_WEEKLY_ANCHOR_WEIGHT': '0'})['weight'] == 0.0
    for bad in ('0.3', '-0.1', 'lots'):
        try:
            resolve_weekly_anchor_weight(1.0, 1, env={'FLOCK_WEEKLY_ANCHOR_WEIGHT': bad})
        except CorpusContractError:
            continue
        raise AssertionError(f'FLOCK_WEEKLY_ANCHOR_WEIGHT={bad!r} was accepted')


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
