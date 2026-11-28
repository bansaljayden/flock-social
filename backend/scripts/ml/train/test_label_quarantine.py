"""The label quarantine and the weekly repetition check (prepare_features.check_label_trust), on small files.

WHY THIS FILE EXISTS. From 23 October 2026 the provider's live endpoint answered with values made from its own
forecast, flagged live; the November retrain passed its gate on them. check_label_trust refuses an export that
still holds a quarantined window's rows (backend/services/labelQuarantine.json) and any week of live-weight
readings that repeat the same venue and hour seven days earlier in half or more of the pairs. On the real
November export (2026-11-27) it refused 2,593,093 quarantined rows, and with the quarantine overridden it
flagged weeks 44 to 48 at 98.9 / 97.1 / 93.1 / 89.2 / 92.3%; the real readings' highest week was 17.6%.

Run: python test_label_quarantine.py     (no pytest needed)
"""
import json
import sys
import tempfile
import traceback
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import prepare_features as pf  # noqa: E402

COLS = ['venue_id', 'hour', 'is_realtime', 'busyness_pct', 'observed_date', 'label_source']
WINDOWS = [{'id': 'w', 'from_date': '2026-10-23', 'through_date': '2026-11-25'}]


def rows(dates, values, source='live', venue=1, hour=20):
    return [{'venue_id': venue, 'hour': hour, 'is_realtime': 1, 'busyness_pct': v, 'observed_date': d,
             'label_source': source} for d, v in zip(dates, values)]


def weekly(n=3):
    return [{'venue_id': 1, 'hour': h, 'is_realtime': 0, 'busyness_pct': 30, 'observed_date': '',
             'label_source': ''} for h in range(n)]


def write(tmp, name, records):
    path = Path(tmp) / name
    pd.DataFrame(records, columns=COLS).to_csv(path, index=False)
    return path


def fridays(start, n):
    return [(pd.Timestamp(start) + pd.Timedelta(days=7 * i)).strftime('%Y-%m-%d') for i in range(n)]


def test_the_real_file_loads_one_closed_window():
    w = pf.load_label_quarantine()
    assert w == [{'id': 'besttime-live-generated-2026-10-23', 'from_date': '2026-10-23', 'through_date': '2026-11-25'}], w


def test_the_file_refuses_what_the_js_refuses():
    ok = {'id': 'w', 'label_source': 'live', 'from_date': '2026-10-23', 'through_date': '2026-11-25', 'evidence': ['x']}
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / 'q.json'
        for bad, why in ((dict(ok, through_date=None), 'both be dates'), (dict(ok, through_date='2026-10-01'), 'before'),
                         (dict(ok, evidence=[]), 'no evidence'), (dict(ok, label_source='forecast'), "must be 'live'")):
            p.write_text(json.dumps({'windows': [bad]}), encoding='utf-8')
            try:
                pf.load_label_quarantine(p)
            except pf.CorpusContractError as err:
                assert why in str(err), (why, str(err))
            else:
                raise AssertionError(f'accepted {bad}')
        p.write_text(json.dumps({'windows': [ok, ok]}), encoding='utf-8')
        try:
            pf.load_label_quarantine(p)
        except pf.CorpusContractError as err:
            assert 'duplicate' in str(err)
        else:
            raise AssertionError('accepted a duplicate id')


def test_the_file_refuses_a_broken_shape_as_the_js_does():
    # The same fixtures as __tests__/labelQuarantine.test.js's shape test.
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / 'q.json'
        ok = {'id': 'w', 'label_source': 'live', 'from_date': '2026-10-23', 'through_date': '2026-11-25', 'evidence': ['x']}
        for bad in ({}, {'windows': None}, {'windows': {}}, [],
                    {'windows': [dict(ok, id=7)]}, {'windows': [dict(ok, id='')]},
                    {'windows': [dict(ok, evidence='a sentence')]}, {'windows': [dict(ok, from_date='2026-10-3')]}):
            p.write_text(json.dumps(bad), encoding='utf-8')
            try:
                pf.load_label_quarantine(p)
            except pf.CorpusContractError:
                continue
            raise AssertionError(f'accepted {bad}')


def test_the_limit_is_decided_on_whole_counts_not_a_rounded_percentage():
    # 5,000 of 10,001 is 49.995%, which rounds to 50.00 but is under half.
    assert not pf.repeating_week({'pairs': 10001, 'equal': 5000, 'equal_pct': 50.0})
    assert pf.repeating_week({'pairs': 10001, 'equal': 5001, 'equal_pct': 50.0})
    assert pf.repeating_week({'pairs': 10000, 'equal': 5000, 'equal_pct': 50.0})
    assert not pf.repeating_week({'pairs': pf.REPETITION_MIN_PAIRS - 1, 'equal': pf.REPETITION_MIN_PAIRS - 1, 'equal_pct': 100.0})


def test_the_loader_refuses_a_pickle_that_never_met_the_current_quarantine():
    import pickle
    import features_io as fio
    good = fio.label_trust_stamp({'quarantine': {'policy': 'refuse'}, 'repetition': {'policy': 'refuse'}})
    cases = {
        'unstamped': ({'y': [1]}, {}, 'no label-trust stamp'),
        'stale file': ({'y': [1], fio.LABEL_TRUST_KEY: dict(good, quarantine_sha256='0' * 64)}, {}, 'another version'),
        'quarantine admitted': ({'y': [1], fio.LABEL_TRUST_KEY: dict(good, quarantine_policy='admitted_for_analysis')}, {},
                                'quarantined readings admitted'),
        'repetition admitted': ({'y': [1], fio.LABEL_TRUST_KEY: dict(good, repetition_policy='admitted_for_analysis')}, {},
                                'repeating labels admitted'),
    }
    with tempfile.TemporaryDirectory() as tmp:
        for name, (data, env, why) in cases.items():
            try:
                fio.require_label_trust(data, name, env=env)
            except ValueError as err:
                assert why in str(err), (name, str(err))
            else:
                raise AssertionError(f'{name}: loaded')
        fio.require_label_trust({'y': [1], fio.LABEL_TRUST_KEY: good}, 'current', env={})
        fio.require_label_trust({'y': [1]}, 'unstamped, analysis', env={fio.QUARANTINE_ENV: 'true'})
        fio.require_label_trust({'y': [1], fio.LABEL_TRUST_KEY: dict(good, repetition_policy='admitted_for_analysis')},
                                'repetition, analysis', env={fio.REPETITION_ENV: 'true'})
        # Through load_features itself, which every training and evaluation script calls.
        p = Path(tmp) / 'features_train.pkl'
        with open(p, 'wb') as f:
            pickle.dump({'X': np.zeros((2, 1), np.float32), 'y': np.zeros(2, np.float32)}, f)
        try:
            fio.load_features(p)
        except ValueError as err:
            assert 'no label-trust stamp' in str(err)
        else:
            raise AssertionError('load_features loaded an unstamped pickle')
        with open(p, 'wb') as f:
            pickle.dump({'X': np.zeros((2, 1), np.float32), 'y': np.zeros(2, np.float32), fio.LABEL_TRUST_KEY: good}, f)
        assert fio.load_features(p)['X'].shape == (2, 1)


def test_an_export_holding_a_quarantined_row_is_refused_and_the_override_is_recorded():
    with tempfile.TemporaryDirectory() as tmp:
        t = write(tmp, 'training_data.csv', weekly() + rows(['2026-10-09', '2026-10-12', '2026-10-23'], [40, 35, 30]))
        try:
            pf.check_label_trust([t], windows=WINDOWS, env={})
        except pf.CorpusContractError as err:
            assert '1 live-labelled realtime rows' in str(err), str(err)
        else:
            raise AssertionError('a quarantined row passed')
        rec = pf.check_label_trust([t], windows=WINDOWS, env={pf.QUARANTINE_ENV: 'true'})
        assert rec['quarantine']['policy'] == 'admitted_for_analysis'
        assert rec['quarantine']['live_rows_inside'] == {'training_data.csv': 1}


def test_forecast_rows_and_weekly_rows_in_the_window_are_not_quarantined():
    with tempfile.TemporaryDirectory() as tmp:
        t = write(tmp, 'training_data.csv', weekly() + rows(['2026-11-01'], [30], source='forecast'))
        rec = pf.check_label_trust([t], windows=WINDOWS, env={})
        assert rec['quarantine']['live_rows_inside'] == {'training_data.csv': 0}


def test_a_feed_repeating_its_own_week_is_refused_whatever_the_date():
    # 600 venues read at the same hour on two Fridays in December, every value repeated: a forecast feed.
    recs = []
    for v in range(600):
        recs += rows(fridays('2027-01-01', 2), [40 + v % 5, 40 + v % 5], venue=v)
    with tempfile.TemporaryDirectory() as tmp:
        t = write(tmp, 'training_data.csv', weekly() + recs)
        try:
            pf.check_label_trust([t], windows=WINDOWS, env={})
        except pf.CorpusContractError as err:
            assert 'repeat the same venue and hour seven days' in str(err), str(err)
        else:
            raise AssertionError('a repeating feed passed')
        rec = pf.check_label_trust([t], windows=WINDOWS, env={pf.REPETITION_ENV: 'true'})
        assert rec['repetition']['policy'] == 'admitted_for_analysis'
        assert list(rec['repetition']['flagged_weeks']) == ['2027-W01'], rec['repetition']


def test_real_looking_readings_pass_and_too_few_pairs_never_flag():
    # 600 venues, two Fridays, one in six repeated (about real readings' 13% to 18%).
    recs = []
    for v in range(600):
        recs += rows(fridays('2027-01-01', 2), [40, 40 if v % 6 == 0 else 55], venue=v)
    # 20 venues repeating every value: a week this small never decides.
    for v in range(1000, 1020):
        recs += rows(fridays('2027-03-05', 2), [30, 30], venue=v)
    with tempfile.TemporaryDirectory() as tmp:
        t = write(tmp, 'training_data.csv', weekly() + recs)
        rec = pf.check_label_trust([t], windows=WINDOWS, env={})
        weeks = rec['repetition']['by_week']
        assert weeks['2027-W01']['pairs'] == 600 and 16.0 <= weeks['2027-W01']['equal_pct'] <= 17.0, weeks
        assert weeks['2027-W10'] == {'pairs': 20, 'equal': 20, 'equal_pct': 100.0}, weeks
        assert rec['repetition']['flagged_weeks'] == {}


def test_spring_rows_count_only_when_they_will_be_trained():
    recs = []
    for v in range(600):
        recs += rows(fridays('2026-04-03', 2), [50, 50], source='', venue=v)
    with tempfile.TemporaryDirectory() as tmp:
        t = write(tmp, 'training_data.csv', weekly() + recs)
        rec = pf.check_label_trust([t], windows=WINDOWS, env={})
        assert rec['repetition']['rows_checked'] == 0
        try:
            pf.check_label_trust([t], windows=WINDOWS, env={pf.UNKNOWN_PROVENANCE_ENV: 'true'})
        except pf.CorpusContractError as err:
            assert 'repeat the same venue' in str(err)
        else:
            raise AssertionError('admitted spring rows were not checked')


if __name__ == '__main__':
    failed = 0
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith('test_') and callable(f)]
    for name, fn in tests:
        try:
            fn()
            print(f'ok   {name}')
        except Exception:
            failed += 1
            print(f'FAIL {name}')
            traceback.print_exc()
    print(f'{len(tests) - failed}/{len(tests)} passed')
    sys.exit(1 if failed else 0)
