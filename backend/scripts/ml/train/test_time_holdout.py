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

THE FEED SCENARIOS (added 2026-10-14). The provider's live feed went silent at
about 16:00 EDT on 2026-10-12 and the pre-registered retrain moved to early
November. The registered rule anchors the 14 days on the last date with a live
reading in either export file, not on the export date, so which window the run
holds out depends only on when the feed comes back. The scenario tests below
build the two export files the way the November export will hold them (the
Pennsylvania venues in training_data.csv, Miami in holdout_data.csv, weekly rows
with no date) and pin the window for each case: the feed dead through the
export, the feed back by 10-20 and running to 10-31, a feed back for only four
days, vendor-forecast rows after the last live reading, and a holdout city whose
readings run later than the training cities'. None of them changes the rule;
they record what it does.

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


# ── The feed scenarios for the November run (see the module docstring) ───────

def days(first, last):
    return [d.strftime('%Y-%m-%d') for d in pd.date_range(first, last, freq='D')]


# The research paper's 30-day test, 2026-09-09..10-08 (MODEL-METRICS.md, "The
# served number over the month since it shipped"). A window that shares dates
# with it scores production on readings whose accuracy is already published.
PAPER_TEST_DATES = frozenset(days('2026-09-09', '2026-10-08'))
# bandEval.js BAND_GATE.minDates: the sample criterion counts dates that hold readings.
BAND_GATE_MIN_DATES = 5


def export_frames(pa_live_dates, miami_live_dates, pa_forecast_dates=()):
    """training_data.csv and holdout_data.csv as the November export holds them.

    Two readings a day per venue (the hourly sweep's rows reduced to two), and
    each venue's weekly rows, which carry no observed_date and so never anchor
    the window. Forecast-labelled realtime rows can be added to the training
    file to check that only a LIVE reading anchors it.
    """
    def frame(city_venues, live_dates, forecast_dates):
        rows = []
        for city, venue in city_venues:
            for date in live_dates:
                for hour in (12, 20):
                    rows.append({'venue_id': venue, 'city': city, 'is_realtime': 1,
                                 'label_source': 'live', 'observed_date': date, 'day_of_week': 0,
                                 'hour': hour, 'busyness_pct': 50, 'baseline_busyness': 40})
            for date in forecast_dates:
                rows.append({'venue_id': venue, 'city': city, 'is_realtime': 1,
                             'label_source': 'forecast', 'observed_date': date, 'day_of_week': 0,
                             'hour': 21, 'busyness_pct': 30, 'baseline_busyness': 40})
            for hour in range(24):
                rows.append({'venue_id': venue, 'city': city, 'is_realtime': 0, 'label_source': None,
                             'observed_date': None, 'day_of_week': 0, 'hour': hour,
                             'busyness_pct': 40, 'baseline_busyness': 40})
        return pd.DataFrame(rows)

    train = frame((('philly', 1), ('lehigh', 2)), pa_live_dates, pa_forecast_dates)
    holdout = frame((('miami', 3),), miami_live_dates, ())
    return train, holdout


def held_out_live_dates(frames, from_date):
    """The dates of the live readings the band gate scores: every one on or after
    the cutoff, in both files (bandEval.js reads both)."""
    out = set()
    for f in frames:
        live = (f['is_realtime'] == 1) & (f['label_source'] == 'live') & f['observed_date'].notna()
        out |= set(d for d in f.loc[live, 'observed_date'] if d >= from_date)
    return sorted(out)


def test_feed_dead_through_the_export_holds_out_09_29_to_10_12():
    # Live readings stop on 2026-10-12 and nothing arrives before the export.
    train, holdout = export_frames(days('2026-09-01', '2026-10-12'), days('2026-09-05', '2026-10-12'))
    th = resolve_time_holdout([train, holdout], env={})
    assert th['policy'] == 'last_days', th
    assert th['last_live_date'] == '2026-10-12', th
    assert th['from_date'] == '2026-09-29', th
    held = held_out_live_dates([train, holdout], th['from_date'])
    assert held == days('2026-09-29', '2026-10-12') and len(held) == 14, held
    # Ten of the fourteen fall inside the paper's 30-day test (09-29..10-08).
    assert sorted(set(held) & PAPER_TEST_DATES) == days('2026-09-29', '2026-10-08')
    kept, rec = split_time_holdout(train, th['from_date'])
    assert rec['training_live_through'] == '2026-09-28', rec
    assert rec['live_rows_held_out'] == 14 * 2 * 2, rec   # 14 dates x 2 venues x 2 readings


def test_feed_back_by_10_20_and_running_to_10_31_holds_out_10_18_to_10_31():
    live = days('2026-09-01', '2026-10-12') + days('2026-10-20', '2026-10-31')
    train, holdout = export_frames(live, live)
    th = resolve_time_holdout([train, holdout], env={})
    assert (th['last_live_date'], th['from_date']) == ('2026-10-31', '2026-10-18'), th
    held = held_out_live_dates([train, holdout], th['from_date'])
    # 10-18 and 10-19 sit in the gap: the window spans 14 days and holds 12 dates.
    assert held == days('2026-10-20', '2026-10-31'), held
    assert not set(held) & PAPER_TEST_DATES, 'the window falls entirely after 10-08'
    kept, rec = split_time_holdout(train, th['from_date'])
    assert rec['training_live_through'] == '2026-10-12', 'training ends where the feed died'
    assert not ((kept['is_realtime'] == 1) & (kept['observed_date'] >= '2026-10-18')).any()


def test_a_feed_back_for_only_four_days_leaves_too_few_dates_and_the_rule_does_not_stretch():
    # Back on 10-29, export taken on 11-02 with readings through 11-01.
    live = days('2026-09-01', '2026-10-12') + days('2026-10-29', '2026-11-01')
    train, holdout = export_frames(live, live)
    th = resolve_time_holdout([train, holdout], env={})
    assert (th['last_live_date'], th['from_date']) == ('2026-11-01', '2026-10-19'), th
    held = held_out_live_dates([train, holdout], th['from_date'])
    assert len(held) == 4 < BAND_GATE_MIN_DATES, held
    # One more day of readings, and the sample criterion's date count is met.
    live5 = live + ['2026-11-02']
    t5, h5 = export_frames(live5, live5)
    th5 = resolve_time_holdout([t5, h5], env={})
    assert th5['from_date'] == '2026-10-20'
    assert len(held_out_live_dates([t5, h5], th5['from_date'])) == BAND_GATE_MIN_DATES


def test_forecast_rows_after_the_feed_died_neither_anchor_the_window_nor_stay_in_training():
    train, holdout = export_frames(days('2026-09-01', '2026-10-12'), days('2026-09-05', '2026-10-12'),
                                   pa_forecast_dates=days('2026-10-13', '2026-10-20'))
    th = resolve_time_holdout([train, holdout], env={})
    assert (th['last_live_date'], th['from_date']) == ('2026-10-12', '2026-09-29'), th
    kept, rec = split_time_holdout(train, th['from_date'])
    assert rec['realtime_rows_held_out'] - rec['live_rows_held_out'] == 8 * 2, rec
    assert not ((kept['is_realtime'] == 1) & (kept['observed_date'] >= '2026-09-29')).any(), \
        'a vendor-forecast row inside the window must leave training as well'


def test_the_newest_live_date_in_either_file_anchors_the_window():
    # Miami (holdout_data.csv) read two days after Pennsylvania stopped.
    train, holdout = export_frames(days('2026-09-01', '2026-10-12'), days('2026-09-05', '2026-10-14'))
    th = resolve_time_holdout([train, holdout], env={})
    assert (th['last_live_date'], th['from_date']) == ('2026-10-14', '2026-10-01'), th
    kept, rec = split_time_holdout(train, th['from_date'])
    assert rec['training_live_through'] == '2026-09-30', rec


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
