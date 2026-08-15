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
echo "[4/6] Evaluating model..."
python evaluate_model.py
echo ""

# Step 5: Ship gate
# Round 10: mlPredictor.init() refuses to promote an artifact whose ship_gate
# does not pass, so the gate has to be part of the pipeline — not an optional
# follow-up step in RETRAIN.md. quick_eval.py must run AFTER evaluate_model.py.
echo "[5/6] Ship gate (realtime-only holdout)..."
python quick_eval.py
echo ""

# Step 6: Export to ONNX
echo "[6/6] Exporting to ONNX..."
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
e = m.get('evaluation', {})
if e:
    # quick_eval.py runs LAST and rewrites metadata['evaluation'] with its own
    # shape, which has no 'validation' key — it has 'training_loco_cv'. This
    # summary used to read the key evaluate_model.py writes and had therefore
    # printed '?' for every number since the gate was introduced. Read whichever
    # survived, and say which one it is rather than labelling it wrongly.
    train_key = 'training_loco_cv' if 'training_loco_cv' in e else 'validation'
    v = e.get(train_key, {})
    h = e.get('holdout', {})
    if v:
        label = 'LOCO CV' if train_key == 'training_loco_cv' else 'Val'
        print(f'  {label} MAE: {v.get(\"mae\", \"?\")}')
        print(f'  {label} R²: {v.get(\"r2\", \"?\")}')
        print(f'  {label} within 10pts: {v.get(\"within_10\", \"?\")}%')
    if h:
        print(f'  Holdout MAE: {h.get(\"mae\", \"?\")}')
        print(f'  Holdout R²: {h.get(\"r2\", \"?\")}')
        print(f'  Holdout within 10pts: {h.get(\"within_10\", \"?\")}%')
inc = m.get('incumbent_comparison')
if inc:
    verdict = inc.get('verdict') or ('BEATS INCUMBENT' if inc.get('challenger_wins') else 'DOES NOT BEAT INCUMBENT')
    print(f'  vs INCUMBENT: {verdict}')
    print(f'    challenger MAE {inc.get(\"challenger_mae\", \"?\")} vs incumbent MAE {inc.get(\"incumbent_mae\", \"?\")} on {inc.get(\"comparable_rows\", \"?\")} shared rows')
else:
    print('  vs INCUMBENT: not computed')
g = m.get('ship_gate')
if g:
    print(f'  SHIP GATE: {\"PASS\" if g.get(\"overall_pass\") else \"FAIL\"} ({g.get(\"gate_basis\", \"?\")}) — the backend refuses to load a FAIL artifact')
else:
    print('  SHIP GATE: not computed — mlPredictor.init() FAILS CLOSED on a missing gate and will serve the rule engine')
print(f'  Version: {m.get(\"model_version\", \"?\")} (set MODEL_VERSION before export_model.py for a release tag)')
"
echo ""
