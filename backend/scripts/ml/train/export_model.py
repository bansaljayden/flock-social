"""
Export the best trained model to ONNX format for Node.js inference.

THE ARTIFACT AND THE FILE THAT DESCRIBES IT MUST AGREE, AND THIS IS WHERE THEY
ARE MADE TO.

The ONNX graph consumes POSITIONS: column i of the input tensor is whatever
column i of `X` was during training, and the graph carries no record of what
that column meant. `model_metadata.json.feature_names` is the ONLY record, and
services/mlPredictor.js builds every inference vector by walking that list in
order. So the two lists have to be the same list.

Until this round nothing checked that. `feature_names` was written by
prepare_features.py; the ONNX column order came from `best_model.pkl`'s
`feature_cols`, written later by train_model.py; and this script wrote neither.
They agree only if nothing ran out of order — and RETRAIN.md's ordering rules
are prose, not code. Re-running prepare_features.py after training (a different
top-30 Google-type list, one more `gtype_*` level, a policy flag flipped) leaves
a metadata file whose names are a DIFFERENT ORDER from the graph's columns, and
mlPredictor's verifyModelShape cannot see it: the widths still match, nothing
throws, and every prediction is a confidently wrong number built from a shuffled
vector.

The fix is one assertion and one rule:
  * `best_model.pkl['feature_cols']` must equal `metadata['feature_names']`
    element for element, or the export STOPS;
  * the metadata this script writes takes `feature_names`, `feature_count` and
    `feature_types` from the PICKLE — the same object that defined the graph's
    column order — so the names shipped and the columns trained can only ever
    come from one place.

Everything the server refuses to load is also checked here, before the artifact
is written, so a failure is a message in this terminal rather than a silent
demotion to the rule engine in production: the ship gate must exist,
training_metrics.within_15 must be a usable number (it is served to users as
`confidence`), the graph must have the input name and width the metadata
claims, and its head must be a single value.

WRITES ARE ATOMIC. Both files are written to a temporary path in the same
directory and os.replace()d into place only after the freshly-written graph has
loaded, matched the metadata and reproduced the trained model's own
predictions. A killed or failed export therefore leaves the PREVIOUS artifact
pair intact and coherent, instead of a new .onnx beside old .json (widths that
happen to match, a model that is not the one described) or a truncated
metadata file.
"""

import json
import logging
import os
import pickle
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

SCRIPT_DIR = Path(__file__).parent
MODELS_DIR = SCRIPT_DIR.parent / 'models'


class ExportContractError(RuntimeError):
    """The artifact and its metadata do not agree. Never ship — stop."""


# Keys services/mlPredictor.js reads on the load path. A missing one is either a
# refusal to promote (ship_gate, feature_names, training_metrics) or a silently
# wrong vector (category_baselines, top_google_types, category_encoding), so the
# export refuses rather than producing an artifact the server will reject.
REQUIRED_METADATA_KEYS = [
    'feature_names',       # positional contract
    'ship_gate',           # written by quick_eval.py; mlPredictor fails closed without it
    'training_metrics',    # within_15 is published to users as `confidence`
    'category_encoding',   # buildFeatureMap -> venue_category_encoded
    'top_google_types',    # buildFeatureMap -> gtype_* one-hots
    'category_baselines',  # buildFeatureMap -> category_baseline
    'refined_baselines',   # buildFeatureMap -> refined_category_baseline
]


def load_metadata(meta_path: Path) -> dict:
    if not meta_path.exists():
        raise ExportContractError(
            f'{meta_path} does not exist. The metadata is written by '
            'prepare_features.py and completed by train_model.py / evaluate_model.py / '
            'quick_eval.py — run the pipeline from the top, not from here.'
        )
    with open(meta_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def check_pipeline_ran(metadata: dict) -> None:
    """Everything that must already be in the file before an artifact is built."""
    missing = [k for k in REQUIRED_METADATA_KEYS if k not in metadata]
    if missing:
        raise ExportContractError(
            f'model_metadata.json is missing {missing}.\n'
            '  ship_gate is written by quick_eval.py and mlPredictor.init() FAILS CLOSED '
            'without it — the backend would serve the rule engine.\n'
            '  Run the pipeline in order: prepare_features.py -> train_model.py -> '
            'evaluate_model.py -> quick_eval.py -> export_model.py, and never re-run '
            'prepare_features.py after this script.'
        )

    gate = metadata['ship_gate']
    if not isinstance(gate, dict):
        raise ExportContractError('model_metadata.json.ship_gate is not an object.')
    if gate.get('overall_pass') is not True:
        # Not fatal: an honest failing artifact is worth exporting to inspect.
        # It simply will not be promoted — mlPredictor.evaluateShipGate refuses
        # anything whose overall_pass is not exactly true.
        logger.error(
            'SHIP GATE FAILED (verdict=%s, basis=%s). Exporting anyway, but '
            'mlPredictor.init() WILL REFUSE this artifact and the backend will serve '
            'the rule engine. Do not commit it.',
            gate.get('verdict'), gate.get('gate_basis'),
        )

    within15 = (metadata.get('training_metrics') or {}).get('within_15')
    if not (isinstance(within15, (int, float)) and 0 < float(within15) <= 100):
        raise ExportContractError(
            f'training_metrics.within_15 is {within15!r}. mlPredictor publishes this '
            'number to users as the venue card\'s `confidence` percentage and refuses '
            'to promote a model that cannot state it. Re-run train_model.py.'
        )


def check_feature_order(feature_cols, metadata: dict) -> None:
    """The one check that makes a shuffled inference vector impossible."""
    names = metadata.get('feature_names')
    if not isinstance(names, list) or not names:
        raise ExportContractError(
            'model_metadata.json carries no feature_names. It is the only record of '
            'what each ONNX input column means; without it mlPredictor cannot build a '
            'vector at all.'
        )
    dupes = sorted({c for c in feature_cols if list(feature_cols).count(c) > 1})
    if dupes:
        raise ExportContractError(
            f'best_model.pkl lists {dupes} more than once. Two ONNX columns would carry '
            'the same name and mlPredictor would write the same value into both.'
        )
    if list(feature_cols) != sorted(feature_cols):
        raise ExportContractError(
            'best_model.pkl feature_cols is not in sorted order. '
            'prepare_features.get_feature_columns() returns sorted(feature_cols), and '
            '__tests__/mlPipeline.test.js pins metadata.feature_names against that sort '
            'as the only checkable half of the positional contract. An unsorted list '
            'means something reordered the columns between feature prep and training.'
        )

    if list(names) == list(feature_cols):
        return

    # Name the failure precisely — same set in a different order is the
    # dangerous one, because every width check in the stack still passes.
    if sorted(names) == sorted(feature_cols):
        pairs = [(i, a, b) for i, (a, b) in enumerate(zip(names, feature_cols)) if a != b]
        first = pairs[0] if pairs else None
        raise ExportContractError(
            'FEATURE ORDER DRIFT. best_model.pkl and model_metadata.json list the same '
            f'{len(names)} features in a DIFFERENT ORDER (first difference at position '
            f'{first[0]}: metadata says {first[1]!r}, the trained model was column '
            f'{first[2]!r}; {len(pairs)} positions differ).\n'
            '  Nothing downstream can catch this: the widths match, onnxruntime does not '
            'throw, and every served prediction is built from a shuffled vector.\n'
            '  Cause: model_metadata.json was rewritten after training — almost always a '
            're-run of prepare_features.py after train_model.py. Re-run train_model.py '
            'against the CURRENT features_train.pkl, then evaluate_model.py, quick_eval.py, '
            'and export again.'
        )

    only_meta = [c for c in names if c not in set(feature_cols)]
    only_pkl = [c for c in feature_cols if c not in set(names)]
    raise ExportContractError(
        f'FEATURE SET MISMATCH. best_model.pkl was trained on {len(feature_cols)} columns '
        f'and model_metadata.json describes {len(names)}.\n'
        f'  In metadata but not in the trained model: {only_meta}\n'
        f'  In the trained model but not in metadata: {only_pkl}\n'
        '  The .onnx and the .json would come from different runs. Re-run the pipeline '
        'from prepare_features.py.'
    )


def convert(model, model_name: str, n_features: int):
    if model_name == 'xgboost':
        from onnxmltools import convert_xgboost
        from onnxmltools.convert.common.data_types import FloatTensorType
        initial_type = [('input', FloatTensorType([None, n_features]))]
        return convert_xgboost(model, initial_types=initial_type)

    if model_name == 'lightgbm':
        from onnxmltools import convert_lightgbm
        from onnxmltools.convert.common.data_types import FloatTensorType
        initial_type = [('input', FloatTensorType([None, n_features]))]
        return convert_lightgbm(model, initial_types=initial_type)

    if model_name == 'random_forest':
        from skl2onnx import convert_sklearn
        from skl2onnx.common.data_types import FloatTensorType
        initial_type = [('input', FloatTensorType([None, n_features]))]
        return convert_sklearn(model, initial_types=initial_type)

    raise ExportContractError(f'Unknown model type: {model_name}')


def verify_graph(onnx_path: Path, model, feature_cols) -> str:
    """Run the server's own load-time checks against the freshly written graph.

    Returns the graph's input name. Raises if anything mlPredictor.verifyModelShape
    would refuse is true, and additionally proves the converted graph reproduces
    the trained model's predictions — a converter that drops or reorders columns
    shows up here and nowhere else.
    """
    import onnxruntime as ort

    session = ort.InferenceSession(str(onnx_path))
    n_features = len(feature_cols)

    inputs = session.get_inputs()
    if len(inputs) != 1:
        raise ExportContractError(
            f'the graph takes {len(inputs)} inputs ({[i.name for i in inputs]}); '
            'mlPredictor feeds exactly one tensor.'
        )
    input_name = inputs[0].name
    shape = list(inputs[0].shape or [])
    width = shape[-1] if shape else None
    if isinstance(width, int) and width != n_features:
        raise ExportContractError(
            f'the graph takes {width} features but the model was trained on {n_features}.'
        )

    outputs = session.get_outputs()
    if len(outputs) != 1:
        raise ExportContractError(
            f'the graph has {len(outputs)} outputs ({[o.name for o in outputs]}). '
            'mlPredictor reads outputNames[0].data[0] and only a single-value '
            'regression head is safe to read that way — a classifier head would hand '
            'back a class index that gets clamped into 0..100 and shipped as a score.'
        )
    out_shape = list(outputs[0].shape or [])
    out_width = out_shape[-1] if len(out_shape) > 1 else None
    if isinstance(out_width, int) and out_width != 1:
        raise ExportContractError(
            f"the graph's output is {out_width} wide, not a single value."
        )

    # Zeros: the smoke test this file always did.
    dummy = np.zeros((1, n_features), dtype=np.float32)
    zero_pred = float(np.asarray(session.run(None, {input_name: dummy})[0]).flat[0])
    if not np.isfinite(zero_pred):
        raise ExportContractError(f'the graph returns {zero_pred} on an all-zero input.')
    logger.info(f'ONNX test prediction (zeros input): {zero_pred:.2f}')

    # Parity with the trained model on random vectors. This is what catches a
    # converter that silently reorders or drops a column: the widths agree, the
    # graph runs, and only the NUMBERS disagree.
    rng = np.random.default_rng(42)
    probe = rng.normal(size=(16, n_features)).astype(np.float32)
    onnx_pred = np.asarray(session.run(None, {input_name: probe})[0]).reshape(-1)
    native_pred = np.asarray(model.predict(probe)).reshape(-1)
    if onnx_pred.shape != native_pred.shape:
        raise ExportContractError(
            f'the graph returned {onnx_pred.shape} predictions for a 16-row probe, '
            f'the trained model returned {native_pred.shape}.'
        )
    worst = float(np.max(np.abs(onnx_pred - native_pred)))
    if not np.isfinite(worst) or worst > 1e-2:
        raise ExportContractError(
            f'the ONNX graph does not reproduce the trained model: worst absolute '
            f'difference {worst} over 16 random vectors (tolerance 1e-2). The '
            'conversion changed the model.'
        )
    logger.info(f'ONNX/native parity over 16 random vectors: max |Δ| = {worst:.2e}')

    return input_name


def compute_feature_types(feature_cols):
    feature_types = []
    for col in feature_cols:
        if col in ('day_of_week', 'hour', 'month', 'price_level', 'review_count', 'venue_category_encoded'):
            feature_types.append('int')
        elif col.startswith(('is_', 'season_', 'weather_', 'gtype_', 'rain_x_', 'cold_', 'event_nearby')):
            feature_types.append('bool')
        else:
            feature_types.append('float')
    return feature_types


def write_atomic(path: Path, write_body) -> None:
    """Write through a temp file in the same directory, then os.replace().

    os.replace is atomic on both POSIX and Windows, so a reader (the running
    backend, a concurrent test) sees either the old file or the new one — never
    a half-written one, and never a new .onnx paired with an old .json because
    the process died between the two writes.
    """
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f'.{path.name}.', suffix='.tmp')
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, 'wb') as f:
            write_body(f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def main():
    logger.info('Loading best model...')
    model_path = SCRIPT_DIR / 'best_model.pkl'
    if not model_path.exists():
        raise ExportContractError(
            f'{model_path} does not exist. Run train_model.py first.'
        )
    with open(model_path, 'rb') as f:
        model_data = pickle.load(f)

    missing_keys = [k for k in ('model', 'name', 'feature_cols') if k not in model_data]
    if missing_keys:
        raise ExportContractError(
            f'best_model.pkl is missing {missing_keys}. train_model.py writes '
            "{'model', 'name', 'feature_cols'}; a pickle without feature_cols has no "
            'record of its own column order and nothing can be exported from it safely.'
        )

    model = model_data['model']
    model_name = model_data['name']
    feature_cols = list(model_data['feature_cols'])
    n_features = len(feature_cols)
    if n_features == 0:
        raise ExportContractError('best_model.pkl lists zero feature columns.')

    logger.info(f'Model: {model_name}, Features: {n_features}')

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    meta_path = MODELS_DIR / 'model_metadata.json'
    onnx_path = MODELS_DIR / 'crowd_model.onnx'

    # ── Everything that can refuse, refuses BEFORE anything is written ───────
    metadata = load_metadata(meta_path)
    check_pipeline_ran(metadata)
    check_feature_order(feature_cols, metadata)

    onnx_model = convert(model, model_name, n_features)

    # Write the graph to a temp path, verify THAT file, and only then let it
    # become crowd_model.onnx.
    staging = MODELS_DIR / f'.crowd_model.onnx.{os.getpid()}.staging'
    try:
        staging.write_bytes(onnx_model.SerializeToString())
        logger.info('Verifying ONNX model...')
        input_name = verify_graph(staging, model, feature_cols)

        # ── Metadata, from the pickle where it can be ────────────────────────
        # The crowd model's name is Starling (Flock / Birdie / Flux / Starling).
        metadata['model_name'] = 'Starling'
        # Version: MODEL_VERSION env var, else a dated dev tag. This used to be a
        # hardcoded '2.5.0-starling', which meant every future retrain silently
        # shipped under the OLD version string — logs, ship-gate messages, and the
        # API's modelVersion field could no longer tell two models apart.
        env_version = (os.environ.get('MODEL_VERSION') or '').strip()
        if env_version:
            metadata['model_version'] = env_version
        else:
            metadata['model_version'] = f'2.5-dev.{datetime.now(timezone.utc):%Y%m%d}'
            logger.warning(
                f'MODEL_VERSION not set — tagging artifact as {metadata["model_version"]}. '
                'Set MODEL_VERSION (e.g. 2.6.0-<name>) for a release export.'
            )
        metadata['label_type'] = metadata.get('label_type', 'delta')
        metadata['delta_clamp_range'] = metadata.get('delta_clamp_range', [-30, 30])
        metadata['model_type'] = model_name
        metadata['onnx_input_name'] = input_name
        # THE POSITIONAL CONTRACT, restated from the object that defined it.
        # check_feature_order already proved these equal what was in the file;
        # writing them from the pickle means the names shipped and the graph's
        # columns have exactly one source.
        metadata['feature_names'] = feature_cols
        metadata['feature_count'] = n_features
        metadata['feature_types'] = compute_feature_types(feature_cols)
        # Feedback-error feature semantics. The training export now computes
        # avg_prediction_error as mapped 20/50/80 minus score; models exported from
        # here on declare that, and mlPredictor.js serves the matching variant.
        # (Models without this key — v2.5-starling and earlier — trained on the
        # legacy raw-ordinal difference and are served that at inference.)
        metadata['feedback_error_semantics'] = 'mapped'
        metadata['trained_at'] = datetime.now(timezone.utc).isoformat()

        payload = json.dumps(metadata, indent=2).encode('utf-8')

        # Graph first, then metadata. Both are atomic replaces and the pair is
        # already proven coherent, so the only window is between the two
        # replaces — and in that window the metadata still describes the same
        # feature set, because check_feature_order refused otherwise.
        write_atomic(onnx_path, lambda f: f.write(staging.read_bytes()))
        write_atomic(meta_path, lambda f: f.write(payload))
    finally:
        staging.unlink(missing_ok=True)

    logger.info(f'Saved ONNX model to {onnx_path}')
    logger.info('Updated model_metadata.json with final info')

    onnx_size = onnx_path.stat().st_size / (1024 * 1024)
    meta_size = meta_path.stat().st_size / 1024
    logger.info(f'ONNX model size: {onnx_size:.1f} MB')
    logger.info(f'Metadata size: {meta_size:.1f} KB')
    logger.info(f'Exported v{metadata["model_version"]} — {n_features} features, '
                f'input "{input_name}", ship gate '
                f'{"PASS" if metadata["ship_gate"].get("overall_pass") else "FAIL"}')
    logger.info('Export complete!')


if __name__ == '__main__':
    main()
