"""
Export the best trained model to ONNX format for Node.js inference.
"""

import json
import logging
import pickle
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

SCRIPT_DIR = Path(__file__).parent
MODELS_DIR = SCRIPT_DIR.parent / 'models'


def main():
    logger.info('Loading best model...')
    with open(SCRIPT_DIR / 'best_model.pkl', 'rb') as f:
        model_data = pickle.load(f)

    model = model_data['model']
    model_name = model_data['name']
    feature_cols = model_data['feature_cols']
    n_features = len(feature_cols)

    logger.info(f'Model: {model_name}, Features: {n_features}')

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    onnx_path = MODELS_DIR / 'crowd_model.onnx'

    if model_name == 'xgboost':
        from onnxmltools import convert_xgboost
        from onnxmltools.convert.common.data_types import FloatTensorType
        initial_type = [('input', FloatTensorType([None, n_features]))]
        onnx_model = convert_xgboost(model, initial_types=initial_type)

    elif model_name == 'lightgbm':
        from onnxmltools import convert_lightgbm
        from onnxmltools.convert.common.data_types import FloatTensorType
        initial_type = [('input', FloatTensorType([None, n_features]))]
        onnx_model = convert_lightgbm(model, initial_types=initial_type)

    elif model_name == 'random_forest':
        from skl2onnx import convert_sklearn
        from skl2onnx.common.data_types import FloatTensorType
        initial_type = [('input', FloatTensorType([None, n_features]))]
        onnx_model = convert_sklearn(model, initial_types=initial_type)

    else:
        raise ValueError(f'Unknown model type: {model_name}')

    # Save ONNX
    with open(onnx_path, 'wb') as f:
        f.write(onnx_model.SerializeToString())
    logger.info(f'Saved ONNX model to {onnx_path}')

    # Verify ONNX model
    logger.info('Verifying ONNX model...')
    import onnxruntime as ort
    session = ort.InferenceSession(str(onnx_path))

    # Test with a dummy input
    dummy = np.zeros((1, n_features), dtype=np.float32)
    input_name = session.get_inputs()[0].name
    result = session.run(None, {input_name: dummy})
    pred = float(result[0][0])
    logger.info(f'ONNX test prediction (zeros input): {pred:.2f}')

    # Update metadata with final info
    meta_path = MODELS_DIR / 'model_metadata.json'
    with open(meta_path, 'r') as f:
        metadata = json.load(f)

    metadata['model_version'] = '1.0.0'
    metadata['model_type'] = model_name
    metadata['onnx_input_name'] = input_name
    metadata['trained_at'] = datetime.now(timezone.utc).isoformat()

    # Compute feature types for Node.js
    feature_types = []
    for col in feature_cols:
        if col in ('day_of_week', 'hour', 'month', 'price_level', 'review_count', 'venue_category_encoded'):
            feature_types.append('int')
        elif col.startswith(('is_', 'season_', 'weather_', 'gtype_', 'rain_x_', 'cold_', 'event_nearby')):
            feature_types.append('bool')
        else:
            feature_types.append('float')
    metadata['feature_types'] = feature_types

    with open(meta_path, 'w') as f:
        json.dump(metadata, f, indent=2)

    logger.info('Updated model_metadata.json with final info')

    # Print file sizes
    onnx_size = onnx_path.stat().st_size / (1024 * 1024)
    meta_size = meta_path.stat().st_size / 1024
    logger.info(f'ONNX model size: {onnx_size:.1f} MB')
    logger.info(f'Metadata size: {meta_size:.1f} KB')
    logger.info('Export complete!')


if __name__ == '__main__':
    main()
