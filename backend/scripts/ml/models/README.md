# Trained model artifacts

This directory is where the model graph and `model_metadata.json` live at
runtime. The graph is `crowd_model.onnx`, or `crowd_model.onnx.gz` for a model
too big to commit plain (next section). The shipped model is 2.8.0-starling,
tracked as `crowd_model.onnx.gz` since 2026-11-26. Both files are tracked in
the deployment source, because that is the one Railway builds from and there
is no other route by which a deploy could receive them. Neither is distributed
with the source distribution.

They are Flock's own artifacts, built from data Flock collected. The pipeline
that produces them is published in full:
data collection in `../` (`runCollection.js`, `collectWeekly.js`,
`collectRealtime.js`, `collectEvents.js`), feature engineering and training in
`../train/`, and the runbook in `../RETRAIN.md`.

## A model over 50 MB: commit `crowd_model.onnx.gz` instead

GitHub refuses any file over 100 MB, and this file's estimate for a 2,000-tree
depth-10 model was about 120-135 MB as a plain `.onnx`. So `export_model.py`
writes `crowd_model.onnx.gz` beside it on every export: the same graph,
gzipped at level 9 with mtime 0 and no file name in the header, so the same
graph always gives the same bytes (it decompresses in tens of milliseconds).
2.8.0-starling, the shipped model, came out at 71.0 MB plain (70,995,619
bytes) and 11.3 MB gzipped (11,261,627 bytes), about 16% of the plain size.
`model_metadata.json` records both files' fingerprints as `onnx_sha256`,
`onnx_bytes`, `onnx_gz_sha256` and `onnx_gz_bytes`. 2.8.0-starling's metadata
does not carry these four keys, because it was exported from the commit before
that code landed.

The rule every reader follows (`services/mlPredictor.js`, `../train/bandEval.js`,
and the Python readers through `../train/model_files.py`): **read
`crowd_model.onnx` when it exists, otherwise decompress `crowd_model.onnx.gz` in
memory.** A corrupt or truncated `.gz` is refused at load with the reason in the
log, and the rule engine serves.

When `crowd_model.onnx` is over about 50 MB, ship the `.gz` and not the plain
file. From the repository root:

```bash
git rm backend/scripts/ml/models/crowd_model.onnx     # untracks it and deletes the local copy
git add backend/scripts/ml/models/crowd_model.onnx.gz backend/scripts/ml/models/model_metadata.json
git commit -m "Ship <version> as crowd_model.onnx.gz"
git ls-files backend/scripts/ml/models/                # the .gz and the .json, no .onnx
```

Never commit both: with both tracked, the plain file wins and the `.gz` is dead
weight. The `.gz` is not ignored by `.gitignore`. To check a `.gz` against the
export that wrote it, `sha256sum crowd_model.onnx.gz` must print
`onnx_gz_sha256`, and `gunzip -c crowd_model.onnx.gz | sha256sum` must print
`onnx_sha256`. Under the limit, ship the plain `crowd_model.onnx` as before and
leave the `.gz` uncommitted.

## Running without a model

`backend/services/mlPredictor.js` checks for both files at boot (the graph as
`crowd_model.onnx` or `crowd_model.onnx.gz`). If either is missing it logs `Model files not found — using rule engine` and every prediction
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

`export_model.py` writes `crowd_model.onnx`, `crowd_model.onnx.gz` and
`model_metadata.json` into this directory. `../RETRAIN.md` covers the whole thing properly, including preserving
an incumbent for comparison and what the ship gate refuses. Read it before you
start; the order of those steps matters and the runbook says why.

`mlPredictor.js` will refuse to promote an artifact whose metadata fails the ship
gate, whose feature list has no inference-side implementation, or whose ONNX input
shape disagrees with its metadata. In each case it says so and serves the rule
engine.
