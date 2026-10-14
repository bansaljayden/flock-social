"""The final refit: only a PASSED run may be refitted on everything, and its verdict is carried
across only when the refit used the gated recipe.

Pins resolve_final_refit (prepare_features.py) and problems_with / carry (final_refit_gate.py)
on hand-built metadata. No data, no training.

Run: python test_final_refit.py     (no pytest needed)
"""
import hashlib
import json
import sys
import tempfile
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import prepare_features as pf  # noqa: E402
import final_refit_gate as frg  # noqa: E402

PARAMS = {'max_depth': 8, 'n_estimators': 800, 'learning_rate': 0.01}
POLICY = {k: f'{k}-v' for k in frg.POLICY_KEYS}


def gated_meta(**over):
    m = {'model_version': '2.8.0-starling', 'feature_names': ['a', 'b'], 'best_params': dict(PARAMS),
         'corpus_contract': dict(POLICY), 'training_rows': 1000,
         'ship_gate': {'overall_pass': True, 'verdict': 'SHIP', 'score_qmap_fitted_on': None}}
    m.update(over)
    return m


def write(tmp, meta):
    p = Path(tmp) / 'gated.json'
    p.write_bytes(json.dumps(meta).encode('utf-8'))
    return p


def refit_meta(gated_path, **over):
    blob = gated_path.read_bytes()
    m = {'feature_names': ['a', 'b'], 'best_params': dict(PARAMS), 'corpus_contract': dict(POLICY),
         'training_rows': 1400, 'training_metrics': {'within_15': 50.0},
         'final_refit': {'gated_metadata_path': str(gated_path),
                         'gated_metadata_sha256': hashlib.sha256(blob).hexdigest()}}
    m.update(over)
    return m


def expect_refused(fn, needle):
    try:
        fn()
    except pf.CorpusContractError as err:
        assert needle in str(err), str(err)
        return
    raise AssertionError(f'not refused ({needle})')


def test_unset_is_an_ordinary_run():
    assert pf.resolve_final_refit({}) is None
    assert pf.resolve_final_refit({pf.FINAL_REFIT_ENV: '  '}) is None


def test_resolve_accepts_a_passed_run():
    with tempfile.TemporaryDirectory() as tmp:
        p = write(tmp, gated_meta())
        rec = pf.resolve_final_refit({pf.FINAL_REFIT_ENV: str(p)})
        assert rec['gated_metadata_sha256'] == hashlib.sha256(p.read_bytes()).hexdigest()
        assert rec['gated_model_version'] == '2.8.0-starling'
        assert rec['gated_training_rows'] == 1000


def test_resolve_refuses_a_failed_or_ungated_run():
    with tempfile.TemporaryDirectory() as tmp:
        p = write(tmp, gated_meta(ship_gate={'overall_pass': False}))
        expect_refused(lambda: pf.resolve_final_refit({pf.FINAL_REFIT_ENV: str(p)}), 'did not pass')
        p = write(tmp, gated_meta(ship_gate=None))
        expect_refused(lambda: pf.resolve_final_refit({pf.FINAL_REFIT_ENV: str(p)}), 'did not pass')


def test_resolve_refuses_a_refit_of_a_refit_and_a_missing_file():
    with tempfile.TemporaryDirectory() as tmp:
        p = write(tmp, gated_meta(final_refit={'x': 1}))
        expect_refused(lambda: pf.resolve_final_refit({pf.FINAL_REFIT_ENV: str(p)}), 'itself a refit')
        expect_refused(lambda: pf.resolve_final_refit({pf.FINAL_REFIT_ENV: str(Path(tmp) / 'nope.json')}),
                       'no such file')


def test_resolve_refuses_a_time_holdout_beside_it():
    with tempfile.TemporaryDirectory() as tmp:
        p = write(tmp, gated_meta())
        expect_refused(lambda: pf.resolve_final_refit({pf.FINAL_REFIT_ENV: str(p), pf.TIME_HOLDOUT_DAYS_ENV: '14'}),
                       'do not also set')


def test_gate_carries_a_faithful_refit():
    with tempfile.TemporaryDirectory() as tmp:
        g = gated_meta()
        p = write(tmp, g)
        r = refit_meta(p)
        assert frg.problems_with(r, g, p.read_bytes()) == []
        out = frg.carry(r, g, p.read_bytes(), '2026-11-05T00:00:00+00:00')
        assert out['ship_gate']['overall_pass'] is True
        assert out['ship_gate']['final_refit']['verdict_by_reference'] is True
        assert out['final_refit']['gate_carried_on'] == '2026-11-05T00:00:00+00:00'
        assert 'ship_gate' not in r, 'carry must not mutate its input'


def test_gate_refuses_every_departure_from_the_recipe():
    with tempfile.TemporaryDirectory() as tmp:
        g = gated_meta()
        p = write(tmp, g)
        blob = p.read_bytes()
        cases = {
            'feature_names differ': refit_meta(p, feature_names=['a']),
            'best_params differ': refit_meta(p, best_params=dict(PARAMS, max_depth=6)),
            'corpus_contract.live_feature_policy differs': refit_meta(
                p, corpus_contract=dict(POLICY, live_feature_policy='off')),
            'quick_eval.py was run on it': refit_meta(p, ship_gate={'overall_pass': True}),
            'nothing was folded in': refit_meta(p, training_rows=1000),
            'train_model.py has not run': {k: v for k, v in refit_meta(p).items() if k != 'training_metrics'},
        }
        for needle, r in cases.items():
            found = frg.problems_with(r, g, blob)
            assert any(needle in x for x in found), (needle, found)
        assert any('sha256 differs' in x for x in frg.problems_with(refit_meta(p), g, blob + b' '))
        assert any('not a final refit' in x for x in frg.problems_with({}, g, blob))


def test_gate_refuses_a_verdict_scored_through_a_quantile_map():
    with tempfile.TemporaryDirectory() as tmp:
        g = gated_meta(ship_gate={'overall_pass': True, 'score_qmap_fitted_on': '2.6.0-starling'})
        p = write(tmp, g)
        found = frg.problems_with(refit_meta(p), g, p.read_bytes())
        assert any('quantile map' in x for x in found), found


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
