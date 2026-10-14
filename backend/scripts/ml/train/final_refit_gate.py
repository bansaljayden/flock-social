"""Carry a PASSED ship gate onto that run's final refit.

The gated run never trains on its holdouts (three whole cities and the newest
live days). Once it passes, the artifact worth serving is the same recipe fitted
on everything; prepare_features.py builds that frame under FLOCK_FINAL_REFIT
(see the block above resolve_final_refit there). Such an artifact has nothing
left to be scored on, so its gate is not re-measured: it is the gated run's
verdict, carried across BY REFERENCE, and only after this script has proved the
refit used the gated recipe.

Order: prepare_features.py (FLOCK_FINAL_REFIT=<gated model_metadata.json>) ->
train_model.py -> evaluate_model.py -> final_refit_gate.py -> export_model.py
(MODEL_VERSION set to the refit's own version). Never quick_eval.py: its holdout
cities are training rows in a refit, so every score it printed would be
in-sample.

After shipping, the refit is scored forward with bandEval.js on the next 14 days
of live readings against the served rule; RETRAIN-NOVEMBER-RUNBOOK.md section F
holds the rollback rule.

Usage: python final_refit_gate.py
"""
import copy
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

MODELS_DIR = Path(__file__).parent.parent / 'models'
META = MODELS_DIR / 'model_metadata.json'

# The recipe: what must be identical between the gated run and its refit.
POLICY_KEYS = ('weather_policy', 'calendar_policy', 'dead_slot_policy', 'run_length_policy',
               'live_feature_policy', 'sports_features', 'dropped_features')


def problems_with(refit: dict, gated: dict, gated_blob: bytes) -> list:
    """Every reason the gated verdict may not be carried onto this refit. Empty means it may."""
    out = []
    rec = refit.get('final_refit')
    if not isinstance(rec, dict):
        return ['model_metadata.json is not a final refit (no final_refit record): '
                'prepare_features.py was not run with FLOCK_FINAL_REFIT']
    if hashlib.sha256(gated_blob).hexdigest() != rec.get('gated_metadata_sha256'):
        out.append('the gated metadata changed since the refit was prepared (sha256 differs)')
    if 'ship_gate' in refit:
        out.append('the refit already carries a ship_gate: quick_eval.py was run on it, and its '
                   'holdout cities are training rows here, so that verdict is in-sample')
    gate = gated.get('ship_gate')
    if not isinstance(gate, dict) or gate.get('overall_pass') is not True:
        out.append('the gated run did not pass its ship gate')
    elif gate.get('score_qmap_fitted_on'):
        out.append('the gated verdict was scored through a quantile map fitted on '
                   f'{gate["score_qmap_fitted_on"]}; the refit has its own version, so the server '
                   'would refuse it (mlPredictor.evaluateShipGate). Gate with CROWD_QMAP_ENABLED=false.')
    if gated.get('final_refit'):
        out.append('the gated metadata is itself a refit')
    if refit.get('feature_names') != gated.get('feature_names'):
        out.append('feature_names differ from the gated run')
    if refit.get('best_params') != gated.get('best_params'):
        out.append(f'best_params differ: refit {refit.get("best_params")} vs gated {gated.get("best_params")}')
    rc, gc = refit.get('corpus_contract') or {}, gated.get('corpus_contract') or {}
    for k in POLICY_KEYS:
        if rc.get(k) != gc.get(k):
            out.append(f'corpus_contract.{k} differs: refit {rc.get(k)!r} vs gated {gc.get(k)!r}')
    rw, gw = refit.get('sample_weight_policy'), gated.get('sample_weight_policy')
    if isinstance(rw, dict) and isinstance(gw, dict) and rw.get('mode') != gw.get('mode'):
        out.append(f'sample_weight_policy.mode differs: refit {rw.get("mode")!r} vs gated {gw.get("mode")!r}')
    if 'training_metrics' not in refit:
        out.append('train_model.py has not run on the refit (no training_metrics)')
    gr, rr = gated.get('training_rows'), refit.get('training_rows')
    if isinstance(gr, int) and isinstance(rr, int) and rr <= gr:
        out.append(f'the refit trained on {rr} rows, not more than the gated run\'s {gr}: nothing was folded in')
    return out


def carry(refit: dict, gated: dict, gated_blob: bytes, now: str) -> dict:
    out = copy.deepcopy(refit)
    gate = copy.deepcopy(gated['ship_gate'])
    gate['final_refit'] = {
        'verdict_by_reference': True,
        'gated_metadata_sha256': hashlib.sha256(gated_blob).hexdigest(),
        'gated_model_version': gated.get('model_version'),
        'carried_on': now,
        'why': ('This artifact is the gated run refitted on everything, its holdout cities and '
                'newest live days included, with the gated features, parameters and policies '
                '(final_refit_gate.py checked each). Nothing is left to score it on, so the verdict '
                'is the gated run\'s; it is scored forward on the next 14 days after shipping.'),
    }
    out['ship_gate'] = gate
    out['final_refit'] = dict(out['final_refit'], gate_carried_on=now)
    return out


def main() -> int:
    refit = json.loads(META.read_text(encoding='utf-8'))
    rec = refit.get('final_refit') or {}
    gated_path = Path(rec.get('gated_metadata_path') or '')
    if not gated_path.is_file():
        print(f'REFUSED: the gated metadata {gated_path} is not on disk.')
        return 1
    blob = gated_path.read_bytes()
    gated = json.loads(blob.decode('utf-8'))
    found = problems_with(refit, gated, blob)
    if found:
        print('REFUSED: the gated verdict cannot be carried onto this refit:')
        for p in found:
            print('  -', p)
        return 1
    META.write_text(json.dumps(carry(refit, gated, blob, datetime.now(timezone.utc).isoformat()), indent=2),
                    encoding='utf-8')
    print(f'CARRIED: the ship gate of {gated.get("model_version") or gated_path} now stands on the refit '
          f'({refit.get("training_rows")} training rows against {gated.get("training_rows")}). '
          'Export with MODEL_VERSION set to the refit\'s own version.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
