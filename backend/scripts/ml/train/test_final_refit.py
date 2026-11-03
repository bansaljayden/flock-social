"""The final refit: only a PASSED run may be refitted on everything, and its verdict is carried
across only when the refit used the gated recipe.

Pins resolve_final_refit (prepare_features.py) and problems_with / carry (final_refit_gate.py)
on hand-built metadata, and the anchor-weight check on the sample_weight_policy records
prepare_features.assign_sample_weights writes for small hand-built frames. No data, no training.

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


def weights(policy='auto', **over):
    """sample_weight_policy in the shape prepare_features.assign_sample_weights records. The
    default is the registered run's: FLOCK_WEEKLY_ANCHOR_WEIGHT=auto, run-length weights on."""
    w = {'policy': policy, 'weight': 0.0076 if policy == 'auto' else 0.05,
         'live_run_length': {'policy': 'on', 'env': 'FLOCK_RUN_LENGTH_WEIGHTS'},
         'realtime_loss_share': 0.8}
    if policy == 'auto':
        w['target_realtime_share'] = 0.8
    w.update(over)
    return w


# The refit solves auto on a larger frame: the weight reaches its 0.05 cap and live rows carry
# more of the loss. Same recipe.
REFIT_WEIGHTS = {'weight': 0.05, 'realtime_loss_share': 0.9086}


def gated_meta(**over):
    m = {'model_version': '2.8.0-starling', 'feature_names': ['a', 'b'], 'best_params': dict(PARAMS),
         'corpus_contract': dict(POLICY), 'training_rows': 1000, 'sample_weight_policy': weights(),
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
         'sample_weight_policy': weights(**REFIT_WEIGHTS),
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


def weight_problems(gated_weights, refit_weights):
    """problems_with on a gated run and its refit that differ only in sample_weight_policy."""
    with tempfile.TemporaryDirectory() as tmp:
        g = gated_meta(sample_weight_policy=gated_weights)
        p = write(tmp, g)
        return frg.problems_with(refit_meta(p, sample_weight_policy=refit_weights), g, p.read_bytes())


def assert_refused(found, needle):
    assert any(needle in x for x in found), (needle, found)


def test_gate_refuses_another_anchor_weight_policy():
    assert_refused(weight_problems(weights(), weights('default')), 'sample_weight_policy.policy differs')
    # default and explicit at the same weight are still two recipes
    assert_refused(weight_problems(weights('default'), weights('explicit')),
                   'sample_weight_policy.policy differs')
    assert_refused(weight_problems(weights(), weights(**REFIT_WEIGHTS, live_run_length={'policy': 'off'})),
                   'sample_weight_policy.live_run_length.policy differs')


def test_gate_refuses_another_fixed_anchor_weight():
    assert_refused(weight_problems(weights('default'), weights('default', weight=0.04)),
                   'sample_weight_policy.weight differs')
    assert_refused(weight_problems(weights('explicit', weight=0.01), weights('explicit', weight=0.02)),
                   'sample_weight_policy.weight differs')
    # the loss share each frame came out at is not part of the recipe
    assert weight_problems(weights('explicit', weight=0.01),
                           weights('explicit', weight=0.01, realtime_loss_share=0.93)) == []


def test_gate_carries_an_auto_weight_solved_on_the_larger_frame():
    gated, refit = weights(), weights(**REFIT_WEIGHTS)
    assert gated['weight'] != refit['weight'] and gated['realtime_loss_share'] != refit['realtime_loss_share']
    assert weight_problems(gated, refit) == []
    assert_refused(weight_problems(gated, weights(**REFIT_WEIGHTS, target_realtime_share=0.9)),
                   'sample_weight_policy.target_realtime_share differs')


def test_gate_refuses_a_missing_weight_record():
    with tempfile.TemporaryDirectory() as tmp:
        for gated_has, refit_has, where in ((True, False, 'the refit:'),
                                            (False, True, 'the gated metadata:'),
                                            (False, False, 'the refit and the gated metadata:')):
            g = gated_meta()
            if not gated_has:
                del g['sample_weight_policy']
            p = write(tmp, g)
            r = refit_meta(p)
            if not refit_has:
                del r['sample_weight_policy']
            assert_refused(frg.problems_with(r, g, p.read_bytes()), f'sample_weight_policy is missing from {where}')
    assert_refused(weight_problems(weights(), 'auto'), 'sample_weight_policy is missing from the refit:')
    no_policy = weights(**REFIT_WEIGHTS)
    del no_policy['policy']
    assert_refused(weight_problems(weights(), no_policy), 'sample_weight_policy.policy is not recorded')
    no_share = weights(**REFIT_WEIGHTS)
    del no_share['target_realtime_share']
    assert_refused(weight_problems(weights(), no_share),
                   'sample_weight_policy.target_realtime_share is not recorded')
    no_runs = weights(**REFIT_WEIGHTS)
    del no_runs['live_run_length']
    assert_refused(weight_problems(weights(), no_runs),
                   'sample_weight_policy.live_run_length.policy is not recorded')


def written_weight_record(live, weekly, env, run_policy='on'):
    """The sample_weight_policy prepare_features.assign_sample_weights records for a frame of
    `live` live readings (each a run of one) and `weekly` weekly anchors, as JSON stores it."""
    import pandas as pd
    df = pd.DataFrame({'is_realtime': [1] * live + [0] * weekly,
                       'label_provenance': ['live'] * live + ['weekly'] * weekly,
                       'live_run_length': [1] * (live + weekly)})
    policy, _ = pf.assign_sample_weights(df, run_policy, env=env)
    return json.loads(json.dumps(policy))


def test_gate_compares_the_records_prepare_features_writes():
    # The check used to compare sample_weight_policy['mode'], a key the writer never sets, so
    # every pair below passed it as None == None.
    auto = {pf.WEEKLY_ANCHOR_WEIGHT_ENV: 'auto'}
    gated = written_weight_record(60, 1700, auto)             # solved under the cap
    refit = written_weight_record(400, 1900, auto)            # capped at 0.05
    fixed = written_weight_record(400, 1900, {})              # the default weight
    no_runs = written_weight_record(400, 1900, auto, 'off')   # run-length weights off
    for rec in (gated, refit, fixed, no_runs):
        assert 'mode' not in rec, rec
    assert gated['policy'] == refit['policy'] == 'auto' and gated['weight'] < refit['weight'] == 0.05
    assert weight_problems(gated, refit) == []
    assert_refused(weight_problems(gated, fixed), 'sample_weight_policy.policy differs')
    assert_refused(weight_problems(gated, no_runs), 'sample_weight_policy.live_run_length.policy differs')


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
