# Trained model artifacts

This directory is where `crowd_model.onnx` and `model_metadata.json` live at
runtime. Both are tracked in the private repository, because that is the one
Railway builds from and there is no other route by which a deploy could receive
them. Neither is distributed with the public source.

They are Flock's own artifacts, built from data Flock collected. The pipeline
that produces them is published in full:
data collection in `../` (`runCollection.js`, `collectWeekly.js`,
`collectRealtime.js`, `collectEvents.js`), feature engineering and training in
`../train/`, and the runbook in `../RETRAIN.md`.

## Running without a model

`backend/services/mlPredictor.js` checks for both files at boot. If either is
missing it logs `Model files not found — using rule engine` and every prediction
is served by `crowdEngine.js`, tagged `predictionMethod: 'rule_engine'`. Nothing
crashes, and no prediction is presented as a model output when it isn't one.

The ML test suites in `backend/__tests__/` read these files directly, so they
fail on a clone that has no artifact. That is expected.

## Training your own

You need a PostgreSQL database with the `ml_*` tables populated (migration 006
creates them; `../runCollection.js` fills them) and Python with
`../train/requirements.txt` installed.

```bash
cd backend/scripts/ml/train
node export_training_data.js     # writes training_data.csv + holdout_data.csv
python prepare_features.py
python train_model.py            # leave-one-city-out CV -> best_model.pkl
python evaluate_model.py
python quick_eval.py             # ship gate; must run before the export
MODEL_VERSION=1.0.0-yourname python export_model.py
```

`export_model.py` writes `crowd_model.onnx` and `model_metadata.json` into this
directory. `../RETRAIN.md` covers the whole thing properly, including preserving
an incumbent for comparison and what the ship gate refuses. Read it before you
start; the order of those steps matters and the runbook says why.

`mlPredictor.js` will refuse to promote an artifact whose metadata fails the ship
gate, whose feature list has no inference-side implementation, or whose ONNX input
shape disagrees with its metadata. In each case it says so and serves the rule
engine.
