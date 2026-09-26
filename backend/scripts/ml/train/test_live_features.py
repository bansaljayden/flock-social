"""The live features, checked on small frames: what each one reads, and that
nothing at or after a row's own hour can reach it.

WHY THIS FILE EXISTS. prepare_features.add_live_features hands the model the
venue's newest earlier live reading, its trailing offset and the curve an hour
earlier (2026-09-26). The label of a live row IS a live reading, and the next
row's feature is built from the same readings, so the one mistake that would
flatter every metric while teaching nothing is a feature that sees its own
row's reading, or a later one. That is pinned here by perturbation: every
reading at or after a row's slot is changed, the row's own label among them,
and not one of the row's five values may move. Serving parity is pinned
separately (__tests__/mlLiveFeatureParity.test.js runs mlPredictor against
this code).

Run: python test_live_features.py     (no pytest needed)
"""
import sys
import traceback
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))

import prepare_features as pf  # noqa: E402

LIVE = pf.LIVE_FEATURE_NAMES


def weekly(venue, curve):
    out = []
    for s, v in enumerate(curve):
        if v is None:
            continue
        out.append({'venue_id': venue, 'day_of_week': s // 24, 'hour': s % 24, 'busyness_pct': v,
                    'baseline_busyness': v, 'is_realtime': 0, 'label_source': '',
                    'observed_date': None, 'latitude': 40.6, 'longitude': -75.4})
    return out


def dow_of(date):
    return (pd.Timestamp(date).dayofweek + 1) % 7   # Sun=0


def live(venue, date, hour, y, curve, source='live'):
    dow = dow_of(date)
    c = curve[dow * 24 + hour]
    return {'venue_id': venue, 'day_of_week': dow, 'hour': hour, 'busyness_pct': y,
            'baseline_busyness': 0 if c is None else c, 'is_realtime': 1, 'label_source': source,
            'observed_date': date, 'latitude': 40.6, 'longitude': -75.4}


def build(rows):
    df = pd.DataFrame(rows)
    nt = pf.build_neighbor_table([df])
    table = pf.build_live_reading_table([df], nt)
    out = pf.smooth_baseline_hours(df.copy())
    return pf.add_live_features(out, table, nt)


CURVE = [30 + (s * 7) % 50 for s in range(168)]
CURVE[5] = None          # a slot with no row
CURVE[6] = 0             # a row holding 0


def corpus(seed=7):
    rng = np.random.default_rng(seed)
    rows = weekly(1, CURVE) + weekly(2, CURVE)
    dates = pd.date_range('2026-08-20', '2026-09-24').strftime('%Y-%m-%d')
    for v in (1, 2):
        for d in dates:
            for h in sorted(rng.choice(24, size=6, replace=False)):
                rows.append(live(v, d, int(h), int(rng.integers(0, 101)), CURVE,
                                 source='forecast' if rng.random() < 0.1 else 'live'))
    return rows


def test_nothing_at_or_after_the_slot_moves_a_feature():
    rows = corpus()
    base = build(rows)
    realtime = [i for i, r in enumerate(rows) if r['is_realtime'] == 1]
    rng = np.random.default_rng(11)
    checked = moved_by_past = 0
    for i in rng.choice(realtime, size=60, replace=False):
        target = rows[i]
        slot = pf.slot_day_number(target['observed_date']) * 24 + target['hour']
        perturbed = []
        for r in rows:
            r2 = dict(r)
            if r['is_realtime'] == 1 and r['venue_id'] == target['venue_id']:
                s = pf.slot_day_number(r['observed_date']) * 24 + r['hour']
                if s >= slot:   # the row's own reading and every later one
                    r2['busyness_pct'] = 100 - r['busyness_pct']
                    r2['label_source'] = 'live'
            perturbed.append(r2)
        after = build(perturbed)
        for col in LIVE:
            assert base.loc[i, col] == after.loc[i, col], (
                f'{col} of row {i} moved when only readings at or after its slot changed: '
                f'{base.loc[i, col]} -> {after.loc[i, col]}')
        checked += 1
        # And the features DO read the past: changing the readings before the
        # slot moves them wherever there was an earlier reading.
        past = []
        for r in rows:
            r2 = dict(r)
            if r['is_realtime'] == 1 and r['venue_id'] == target['venue_id']:
                s = pf.slot_day_number(r['observed_date']) * 24 + r['hour']
                if s < slot:
                    r2['busyness_pct'] = 100 - r['busyness_pct']
            past.append(r2)
        p = build(past)
        if base.loc[i, 'last_live_age_h'] < pf.LIVE_MISSING_AGE_H or base.loc[i, 'recent_offset_n'] > 0:
            if any(base.loc[i, c] != p.loc[i, c] for c in ('last_live_dev', 'recent_offset')):
                moved_by_past += 1
    assert checked == 60
    assert moved_by_past > 30, f'only {moved_by_past} rows reacted to their past; the features read nothing'


def test_what_each_feature_reads():
    c = [40] * 168
    rows = weekly(1, c)
    d = '2026-09-06'   # a Sunday: dow 0
    rows += [live(1, d, 10, 70, c), live(1, d, 12, 90, c), live(1, d, 14, 20, c, source='forecast')]
    df = build(rows + [live(1, d, 15, 55, c)])
    last = df.iloc[-1]
    # Newest LIVE reading strictly earlier: 12:00 (the 14:00 one is a forecast).
    assert last['last_live_age_h'] == 3 and last['last_live_dev'] == 90 - 40, last[LIVE].to_dict()
    # Median of (70-40, 90-40) = 40.
    assert last['recent_offset'] == 40 and last['recent_offset_n'] == 2, last[LIVE].to_dict()
    assert last['curve_prev_hour'] == 40
    # The 10:00 reading's own row: nothing earlier.
    first = df[(df['observed_date'] == d) & (df['hour'] == 10)].iloc[0]
    assert first['last_live_age_h'] == pf.LIVE_MISSING_AGE_H and first['last_live_dev'] == 0
    assert first['recent_offset'] == 0 and first['recent_offset_n'] == 0
    # 12:00: one earlier reading, below the offset's floor of two.
    second = df[(df['observed_date'] == d) & (df['hour'] == 12)].iloc[0]
    assert second['last_live_age_h'] == 2 and second['recent_offset_n'] == 0


def test_lag_cap_window_and_weekly_rows():
    c = [40] * 168
    rows = weekly(1, c) + [live(1, '2026-08-01', 10, 90, c), live(1, '2026-08-01', 11, 90, c)]
    rows += [live(1, '2026-08-02', 0, 50, c), live(1, '2026-09-10', 12, 10, c)]
    df = build(rows)
    aug2 = df[df['observed_date'] == '2026-08-02'].iloc[0]
    assert aug2['last_live_age_h'] == pf.LIVE_MISSING_AGE_H, 'a reading 13 hours old is past the lag cap'
    assert aug2['recent_offset'] == 50 and aug2['recent_offset_n'] == 2
    sep = df[df['observed_date'] == '2026-09-10'].iloc[0]
    assert sep['recent_offset_n'] == 0, 'readings older than 28 days fall out of the window'
    wk = df[df['is_realtime'] == 0]
    assert (wk['last_live_age_h'] == pf.LIVE_MISSING_AGE_H).all() and (wk['recent_offset_n'] == 0).all()
    assert (wk['curve_prev_hour'] == 40).all()


def test_curve_prev_hour_is_the_served_blend_an_hour_earlier():
    c = [None] * 168
    c[0 * 24 + 18] = 30; c[0 * 24 + 19] = 60; c[0 * 24 + 20] = 90
    c[6 * 24 + 23] = 50                        # Saturday 23:00, the hour before Sunday 00:00
    rows = weekly(1, c)
    df = build(rows + [live(1, '2026-09-06', 20, 50, c), live(1, '2026-09-06', 0, 50, c),
                       live(1, '2026-09-06', 18, 50, c)])
    at = lambda h: df[(df['is_realtime'] == 1) & (df['hour'] == h)].iloc[0]['curve_prev_hour']
    assert at(20) == round(60 * 0.6 + 30 * 0.2 + 90 * 0.2), at(20)
    assert at(0) == 50, 'midnight reads Saturday 23:00, across the day boundary'
    assert at(18) == 0, 'no row at 17:00: 0'


def main():
    failures = 0
    for name, fn in list(globals().items()):
        if name.startswith('test_') and callable(fn):
            try:
                fn()
                print(f'ok   {name}')
            except Exception:
                failures += 1
                print(f'FAIL {name}')
                traceback.print_exc()
    print(f'{failures} failure(s)')
    sys.exit(1 if failures else 0)


if __name__ == '__main__':
    main()
