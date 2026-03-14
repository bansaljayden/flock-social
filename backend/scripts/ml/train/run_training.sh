#!/bin/bash
# =================================================================
# Flock AI Crowd Forecasting — Full Training Pipeline
# Run from: backend/scripts/ml/train/
# =================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "================================================"
echo "  Flock AI Crowd Forecasting — Training Pipeline"
echo "================================================"
echo ""

# Step 1: Export data from PostgreSQL
echo "[1/5] Exporting training data from database..."
node export_training_data.js
echo ""

# Step 2: Feature engineering
echo "[2/5] Preparing features..."
python prepare_features.py
echo ""

# Step 3: Train models
echo "[3/5] Training models (XGBoost, LightGBM, Random Forest)..."
python train_model.py
echo ""

# Step 4: Evaluate
echo "[4/5] Evaluating model..."
python evaluate_model.py
echo ""

# Step 5: Export to ONNX
echo "[5/5] Exporting to ONNX..."
python export_model.py
echo ""

echo "================================================"
echo "  Training Pipeline Complete!"
echo "================================================"

# Print summary from metadata
python -c "
import json
with open('../models/model_metadata.json') as f:
    m = json.load(f)
print(f'  Model: {m.get(\"best_model\", \"?\")}')
print(f'  Features: {m.get(\"feature_count\", \"?\")}')
print(f'  Training rows: {m.get(\"training_rows\", \"?\")}')
if 'evaluation' in m:
    v = m['evaluation'].get('validation', {})
    h = m['evaluation'].get('holdout', {})
    print(f'  Val RMSE: {v.get(\"rmse\", \"?\")}')
    print(f'  Val R²: {v.get(\"r2\", \"?\")}')
    print(f'  Val within 10pts: {v.get(\"within_10\", \"?\")}%')
    if h:
        print(f'  Holdout RMSE: {h.get(\"rmse\", \"?\")}')
        print(f'  Holdout R²: {h.get(\"r2\", \"?\")}')
"
echo ""
