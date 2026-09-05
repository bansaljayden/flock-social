#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One command from the production export to the two-head go/no-go.
#
#   bash run_two_head.sh                       export, prepare, train, eval
#   SKIP_EXPORT=1 bash run_two_head.sh         reuse the CSVs already in train/
#   SKIP_PREPARE=1 bash run_two_head.sh        reuse the pickles already there
#
# What each step touches, because two of them would otherwise step on the
# shipped artifact:
#
#   1. node export_training_data.js   READ-ONLY against production (it opens
#      a read-only transaction and refuses to write). Writes training_data.csv
#      and holdout_data.csv here.
#   2. python prepare_features.py     writes features_train.pkl and
#      features_holdout.pkl, and MERGES into models/model_metadata.json,
#      evicting the shipped ship_gate on the way (that is its documented
#      behaviour, RETRAIN.md "Re-running prepare_features.py now merges").
#      That file is the shipped artifact's, so it is backed up first, the
#      freshly written maps are staged as models/candidate/prepared_metadata.json
#      for the trainer, and the shipped file is put back, on exit, whatever
#      happened in between.
#   3. python train_two_head.py       writes models/candidate/ only.
#   4. python eval_two_head.py        reads models/crowd_model.onnx and the
#      candidate, writes the verdict into the candidate's metadata only.
#
# Nothing here runs a collector, a repair, or anything that writes to the
# database.
#
# prepare_features.py refuses a corpus whose realtime rows all carry
# label_provenance "unknown" (the pre-2026-05 corpus) unless
# ML_ALLOW_UNKNOWN_PROVENANCE=true is set. A corpus with live rows from the
# nightly cron needs no flag. The refusal names the variable if it fires.
#
# CPU with pinned threads by default, so two runs produce the same artifact
# (MODEL-METRICS.md, "CPU with pinned threads is deliberate").
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"

export FLOCK_TRAIN_DEVICE="${FLOCK_TRAIN_DEVICE:-cpu}"
export FLOCK_TRAIN_THREADS="${FLOCK_TRAIN_THREADS:-12}"
export FLOCK_CORPUS_LABEL="${FLOCK_CORPUS_LABEL:-POST-MERGE}"
export FLOCK_TWO_HEAD_CV="${FLOCK_TWO_HEAD_CV:-loco}"
export MODEL_VERSION="${MODEL_VERSION:-2.7.0-two-head-candidate}"

MODELS=../models
CANDIDATE=$MODELS/candidate
SHIPPED_META=$MODELS/model_metadata.json
BACKUP=$CANDIDATE/shipped_metadata.backup.json
STAGED=$CANDIDATE/prepared_metadata.json
mkdir -p "$CANDIDATE"

restore_shipped() {
  if [ -f "$BACKUP" ]; then
    cp "$BACKUP" "$SHIPPED_META"
    echo "[run_two_head] restored the shipped model_metadata.json"
  fi
}

if [ "${SKIP_EXPORT:-0}" != "1" ]; then
  echo "[run_two_head] 1/4 export (read-only) -> training_data.csv, holdout_data.csv"
  node export_training_data.js
else
  echo "[run_two_head] 1/4 export skipped (SKIP_EXPORT=1)"
fi

if [ "${SKIP_PREPARE:-0}" != "1" ]; then
  echo "[run_two_head] 2/4 prepare_features (the shipped metadata is backed up and restored)"
  cp "$SHIPPED_META" "$BACKUP"
  trap restore_shipped EXIT
  python prepare_features.py
  cp "$SHIPPED_META" "$STAGED"
  restore_shipped
  trap - EXIT
  echo "[run_two_head] prepared maps staged at $STAGED"
else
  echo "[run_two_head] 2/4 prepare skipped (SKIP_PREPARE=1)"
fi

echo "[run_two_head] 3/4 train_two_head -> $CANDIDATE (cv=$FLOCK_TWO_HEAD_CV, $FLOCK_TRAIN_DEVICE x$FLOCK_TRAIN_THREADS)"
python train_two_head.py

echo "[run_two_head] 4/4 eval_two_head, corpus $FLOCK_CORPUS_LABEL"
python eval_two_head.py
