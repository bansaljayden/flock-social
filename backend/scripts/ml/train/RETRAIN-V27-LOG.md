# Retrain v2.7.0-starling — checkpoint log

Mandate: (0) reproduce shipped gate numbers + the two disputed epoch figures on
real rows; (1) retrain with epoch features (month, month_sin, month_cos,
is_school_break) and the ten dead constant slots removed, measure the cost;
(2) find a dispersion calibration that clears both gate arms, or state the
frontier; (3) provenance filters on the three baseline-fitting functions;
(4) export + verify only if the re-derived gate passes.

## Environment
- Python 3.14.3, xgboost 3.2.0, numpy 2.4.3, pandas 3.0.1, sklearn 1.8.0
- CSVs: 44-column export of 2026-08-18 (training 638MB, holdout 75MB) — the
  corrected-clock corpus v2.6.0 trained on. Corpus is frozen; no re-export.
- train/best_model.pkl dated 2026-08-18 18:03 = the shipped v2.6.0 CPU model
  (to be confirmed by step 0 reproduction).
- models/incumbent/ currently holds v2.5.0 (the incumbent v2.6.0 was gated
  against). Will be replaced with v2.6.0 artifacts before the retrain, per
  RETRAIN.md step 0.

## Checkpoints
### CP1 — Step 0 reproduction (read-only, script in scratchpad)
- Gate slice reproduces EXACTLY from train/best_model.pkl + features_holdout.pkl:
  67,249 rows, model MAE 29.4191 / W10 20.7%, baseline MAE 31.4782 / W10 19.2%.
  Confirms train/best_model.pkl is the shipped v2.6.0 CPU artifact.
- Dispersion context confirmed: actual sd 36.65 (mean 45.83), model sd 21.56,
  actual <=5 23.6%, >=90 22.1%.
- DISPUTED FIGURE 1 (month sweep, 500 real gate rows, seed 42): mean per-row
  RAW DELTA range across months 1-12 = 27.31 pts (agent said 27.30 — CONFIRMED;
  that figure is the raw delta, the reconstructed-score range is 25.91 after
  clamp/clip). Mean delta by month: Jan -20.10, Mar -20.85, Apr -2.47,
  May-Jul +6.46, Aug-Sep +5.08, Oct-Dec +2.03. Months 5-12 are three plateaus
  on the pickle (the earlier "identical 5-12" was the ONNX synthetic vector);
  the epoch artifact is the ~27-pt Mar->May cliff either way.
- DISPUTED FIGURE 2 (all 67,249 gate rows at month=8): corr(served score, raw
  baseline) = 0.9638, R^2 0.9290, mean offset +5.45 (agent said 0.9638 /
  0.9289 / +5.41 — CONFIRMED). Served-score sd at month=8: 19.69.
- Verdict: both epoch figures hold on real rows. Proceeding to step 1.
### CP2 — Step 1/3 setup
- Incumbent v2.6.0-starling preserved to models/incumbent/ (best_model.pkl,
  features_holdout.pkl, crowd_model.onnx, model_metadata.json) BEFORE any
  artifact was touched, per RETRAIN.md step 0. Verified version string.
- prepare_features.py edited:
  (1) drop_features: month, month_sin, month_cos, is_school_break (epoch
      artifact) + the ten dead constants (is_holiday, season_* x4,
      user-feedback x4, etype_family). 106 -> expected 92 features.
  (2) provenance filters (step 3): vendor_provenance_mask() helper; applied to
      build_category_baseline_maps, build_category_cell_aggregates, and the
      venue-baseline map inside add_neighbor_features. Allowlist
      {weekly, live, forecast, unknown}; no-op on this all-vendor corpus,
      poisoning precondition for the day it is not.
- test_fold_category_baselines.py: 7/7 PASS after the edits.
- Holdout observed_date recovered from holdout_data.csv and verified aligned to
  the pickle rows (395,464 match, busyness_pct == y_actual exactly). All
  67,249 gate rows carry a date, 2026-03-11..2026-05-18. Cached to scratchpad
  for the prequential dispersion work.
- prepare_features.py v2.7 run launched (prep_v27.log).
### CP3 — prepare_features v2.7 complete, training launched
- prep_v27.log: 92 features (was 106), same populations as v2.6 (1,934,988
  train / 395,464 holdout; blend 369,076 realtime + 1,565,912 weekly @ 0.05).
  "No constant feature columns" — first run ever with zero dead slots.
  corpus_contract.dropped_features records all 14 removals with reasons.
- train_model.py running on CPU, 12 threads, fixed v2.3.0 params
  (train_v27_cpu.log). verify_reproduces_shipped: max |diff| = 0 with the
  provenance-filtered maps — the per-fold refit is still exact.
- Dispersion lab script staged in scratchpad (prequential fit-forward arm +
  train-fit ship arm; candidates: clamp widening, dispersion-matching affine
  on delta, quantile mapping, isotonic, and the score-affine frontier).
### CP3-DEATH — first training run killed by unclean shutdown (2026-08-19)
- train_v27_cpu.log froze at 22:56:21 on 2026-08-18, mid "Computing
  leave-one-city-out metrics..." (~35s into a phase that took v2.6 ~22 min).
- Cause verified from the System event log: Kernel-Power id 41 + EventLog 6008
  (unexpected shutdown) — the machine went down uncleanly after launch and did
  not boot until 2026-08-19 19:35. No python training process survived
  (checked Get-Process / Win32_Process; only jarvis_server.py's pythonw runs).
- No artifacts were written by the dead run (best_model.pkl absent from
  train/; model_metadata.json untouched since prepare_features). The v2.7
  feature pickles from CP3 persist (features_train.pkl / features_holdout.pkl,
  2026-08-18 22:55), so per RETRAIN.md the restart point is train_model.py
  alone — prepare_features is NOT re-run.
- Relaunching identically: FLOCK_TRAIN_DEVICE=cpu, FLOCK_TRAIN_THREADS=12,
  fixed v2.3.0 params, Python 3.14.3 / xgboost 3.2.0 / numpy 2.4.3 /
  pandas 3.0.1 / sklearn 1.8.0 (re-verified on the rebooted machine),
  appending to train_v27_cpu.log. This run is wrapped in
  SetThreadExecutionState(ES_SYSTEM_REQUIRED) so system sleep cannot kill it;
  another hard crash still could.
- Note (checked while relaunching, code read + metadata inspection, no run
  needed): the temp_norms table saved into model_metadata.json has 30 keys
  covering months 3-5 ONLY (lat_band x month; corpus window is 2026-03-10..
  05-18). When the month key is missing, both sides fall back to the SAME
  number by construction: prepare_features.add_climate_anomaly fills a failed
  (lat_band, month) merge with the mean of the whole norms table, and
  mlPredictor.climateNorm() returns globalTempNorm() (= that same mean,
  66.01F on the current table) for any unseen band_month key. So there is no
  train/serve mechanism mismatch and no crash — but from June onward every
  inference anomaly is measured against a SPRING climatology, so ordinary
  summer temperatures will read as large positive temp_anomaly values and can
  fire is_warm_anomaly_evening on unremarkable warm evenings. Same epoch-
  artifact family as the dropped month/season features; fixes itself only
  when the corpus spans more months. Nothing to change in this retrain.

## Dispersion lab (2026-08-19)

> **UPDATE 2026-08-20 — score-qmap is BUILT, RE-DERIVED AND UNARMED.** The one
> candidate with real magnitude below has been implemented behind
> `CROWD_QMAP_ENABLED` (default OFF) in `services/mlPredictor.js`, mirrored in
> `quick_eval.py`, and re-fitted from scratch rather than lifted from this
> section. The refit matters: this lab's reference arm was the LEGACY ±30
> unrounded reconstruction, and clamp ±50 + push has shipped since, so its
> **+8.65pp is not what the change is worth today**. Against the reconstruction
> production performs now, prequentially (fit ≤ 2026-03-28 on 21,148 rows,
> scored forward on 46,101):
>
> | | OFF | ON | Δ (CI95, 2000-resample date blocks) |
> |---|---|---|---|
> | within-10 | 20.84% | 29.22% | **+8.40pp** [+7.17, +9.69] |
> | within-15 | 30.12% | 36.42% | +6.30pp |
> | within-20 | 39.08% | 43.61% | +4.53pp [+3.57, +5.55] |
> | MAE | 29.976 | 33.126 | **+3.15** [+2.72, +3.57] |
> | sd / actual | 0.576 | 0.927 | |
>
> Downstream, measured rather than assumed: **0 order reversals** on 21,905
> within-venue-day hour pairs and 123,051 same-hour cross-venue pairs (monotone,
> as predicted, but it introduces ties on 6.4% / 10.3% of them). 54.7% of rows
> change band; band exactly-correct 23.03% → 31.66%, band within-one 60.52% →
> 58.71%. "Busy"/"Very Busy" is published on 32.4% → 49.2% of rows and its
> quiet-room rate goes 31.3% → 35.2% of those, so the raw count of "it said busy
> and it was dead" rises about 70%. Misses over 75 points go 2.4% → 10.2%.
> Owner-slider cards are untouched (the override replaces the score); the owner
> divergence strike compares against user reports, where the model term cancels;
> the user-report blend needs no change and takes the mapped number as its input.
>
> The MAE cost puts it 1.93 above the popular-times baseline on the same rows,
> which is why `RETRAIN.md` now carries **GATE-B**, a drafted two-metric gate
> with every threshold derived from this measurement. GATE-B is also unarmed.
> Plain-language decision page for Jayden: `QMAP-DECISION.md` (local,
> gitignored). Re-derivation script + frozen results live in the 2026-08-20
> session scratchpad (`qmap/derive_qmap.py`, `qmap/qmap_results.json`).
>
> One correction to the numbers quoted at the top of MODEL-EPOCH-FINDING.md: the
> "Busy delivered against a quiet room 39.4%" figure reproduces only under
> "published > 60, actual ≤ 50" on the legacy ±30 reconstruction (39.51%). Read
> against the published band boundary (actual band Quiet or Not Busy, i.e.
> ≤ 40) it is **33.01%** legacy and **32.55%** on today's shipped reconstruction.

Run on the shipped v2.6.0 artifacts. NOTE: train/features_holdout.pkl and
features_train.pkl were overwritten by the v2.7 prep at 22:55, so the lab used
the CP2-preserved copies in models/incumbent/ (best_model.pkl +
features_holdout.pkl). Reproduction on those: 67,249 gate rows, raw MAE
29.4191 / W10 20.67 / sd 21.56, baseline MAE 31.4782 / W10 19.16, actual sd
36.65 — byte-identical to CP1, so they ARE the shipped model. Row-to-date
alignment re-verified from holdout_data.csv (busyness_pct == y_actual exactly,
all 395,464 rows); gate dates 2026-03-11..2026-05-18.

Arms. (1) PREQ: calibrator fitted on the earliest 30% of gate dates
(<= 2026-03-28, 21,148 rows), scored on the forward 70% (46,101 rows) — the
honest deployable estimate. (2) FULL-GATE: same fit, scored on all 67,249 rows
= what quick_eval would print (30% of rows in-fit; labeled as such). The
originally planned train-fit arm (fit on v2.6 train-side residuals) was NOT
runnable: v2.6 features_train.pkl no longer exists and regenerating it would
clobber the live v2.7 training's inputs. PREQ is the honest arm regardless.

Gate per candidate, on identical rows: MAE <= raw v2.6 AND MAE <= baseline AND
W10 > raw v2.6 (floor doctrine: incumbent measured on the same rows).

### Results — prequential forward window (raw: MAE 29.976, W10 19.61)

| candidate | MAE (d) | W10 (d) | sd/actual | gate |
|---|---|---|---|---|
| clamp +-50 alone (saturates past 50) | 29.955 (-0.022) | 19.64 (+0.02) | 0.563 | CLEARS |
| **clamp50 + push <25/-1, >65/+1** | **29.976 (-0.000)** | **19.87 (+0.26)** | 0.576 | **CLEARS** |
| clamp50 + push amt=2 | 30.003 (+0.026) | 20.12 (+0.51) | 0.589 | fails MAE |
| delta-affine b=1.63 (dispersion-match, clamp 60) | 31.244 (+1.267) | 19.38 (-0.23) | 0.600 | fails |
| delta-qmap clamp 100 | 42.191 (+12.21) | 24.79 (+5.18) | 0.672 | fails |
| isotonic delta clamp 100 | 30.054 (+0.078) | 19.51 (-0.10) | 0.567 | fails |
| SCORE-affine k=1.2 | 30.392 (+0.415) | 21.26 (+1.65) | 0.656 | fails |
| SCORE-affine k=1.8 (the MODEL-EPOCH scalar) | 32.271 (+2.294) | 24.92 (+5.31) | 0.843 | fails |
| extremes push <25/-8, >65/+8 | 30.326 (+0.350) | 21.78 (+2.17) | 0.664 | fails |
| **score-qmap (41-pt monotone lookup)** | 33.081 (+3.105) | **28.27 (+8.65)** | 0.935 | fails MAE |
| isotonic score->y (mean-calibration reference) | 30.684 (+0.708) | 15.98 (-3.64) | 0.289 | fails |

Full-gate arm agrees everywhere (clamp50+push1: MAE 29.385 (-0.035), W10 20.99
(+0.32), CLEARS; score-qmap W10 28.79 at MAE 32.67). Temporal stability holds:
score-qmap fitted on March generalizes to April-May with no decay (28.27 fwd
vs 28.79 in-mix).

Date-block bootstrap (2000 resamples, forward window):
- clamp50+push1: dW10 +0.262pp CI95 [+0.171, +0.365]; dMAE -0.0002 CI95
  [-0.053, +0.031]. Real W10 gain, MAE-neutral.
- score-qmap: dW10 +8.684pp CI95 [+7.42, +10.04]; dMAE +3.09 CI95 [+2.66,
  +3.49]. The big lever is real, and so is its cost.

### What the lab measured

1. **No global post-hoc correction clears the gate with a meaningful W10 win.**
   Measured across clamp widening, delta-affine, delta-qmap, isotonic (delta
   and score), score-affine k=1.0..2.0, raw->qmap blends t=0.05..0.8, and
   banded extremes pushes — on both arms. Inside the MAE-no-regression budget
   the maximum W10 gain is ~+0.3pp (clamp50 + a 1-point extremes push). The
   MAE arm and the dispersion lever are in structural tension: MAE is
   minimized by the conditional median of a bimodal target, W10 by committing
   to a mode. That trade is a property of the target distribution, not of any
   calibrator family.
2. **The frontier price is ~0.16-0.25 MAE per +1pp W10** near the origin
   (banded extremes push is cheapest, then score-affine at ~0.25), rising to
   ~0.36 at the far end. score-qmap DOMINATES the affine family at scale
   (+8.65 W10 for +3.11 MAE vs affine k=2.0's +5.96 for +2.91) and restores
   sd/actual to 0.94.
3. **The model is confirmed too narrow, not mis-centred.** Pure mean
   calibration (isotonic score->y) collapses sd/actual to 0.29 and DESTROYS
   W10 (-3.6pp). Recentring alone (score-affine k=1.0) also loses W10.
   Everything that helps, helps by widening.

### Recommendation

- **Take the free micro-win now**: widen the serve clamp to +-50 and add the
  1-point extremes push (score<25 -> -1, score>65 -> +1) in mlPredictor's
  post-processing. +0.26pp W10, MAE-neutral, bootstrap-confirmed, two lines.
  Also apply the same reconstruction in quick_eval so the gate and the serve
  path stay identical.
- **Do not ship any dispersion-matching calibrator under the current gate** —
  every one fails the MAE arm, prequentially and in-sample. The gate is doing
  what it was built to do; the finding is that the 3x lever from
  MODEL-EPOCH-FINDING.md is priced at +1.3..+3.1 MAE and no free version of it
  exists at the post-hoc layer.
- **If within-10 is declared the product's primary metric** (Jayden's call,
  not the lab's), the measured pick is **score-qmap**: monotone, a 41-point
  lookup deployable in mlPredictor, temporally stable, W10 28.3 (+8.7pp,
  CI +7.4..+10.0) at MAE 33.1 (+3.1). That requires re-arming the gate as an
  explicit two-metric trade (e.g. "W10 +>=5pp, MAE regression <= +3.5") and
  writing the trade down in MODEL-METRICS.md, not waiving the arm quietly.
- **The durable fix is distributional, not post-hoc**: a point estimate cannot
  hit both modes of a bimodal world, whatever the objective. The path that
  actually closes the accuracy complaints is predicting band probabilities /
  quantiles (or empty-vs-packed classification) and surfacing that in the
  product — which circles back to the corpus finding: with corr 0.96 to the
  baseline, today's features cannot separate the modes anyway. Corpus first
  (slider), distribution second, calibration last.

Scripts + full result grid: lab_v26.py / lab_v26_blend.py / lab_v26_final.py /
lab_v26_sig.py + lab_v26_results.json in the 2026-08-19 session scratchpad
(2c937174-...). Repo untouched apart from this section.
### CP4 — v2.7 training complete (relaunched run, 2026-08-19)
- Relaunch was clean on the third start: attempt 1 (harness background task)
  was aborted over a 10-min harness timeout risk, attempt 2 was killed for
  redirecting output away from train_v27_cpu.log — and its orphaned
  train_model.py child (PID 2604) survived the parent kill and had to be
  stopped explicitly before it could race the real run for best_model.pkl.
  Final run: detached Start-Process wrapper, FLOCK_TRAIN_DEVICE=cpu,
  FLOCK_TRAIN_THREADS=12, appending to train_v27_cpu.log. Verified exactly
  one wrapper + one trainer alive before letting it proceed.
- TRAIN EXIT CODE: 0, WALL SECONDS: 1336 (v2.6 CPU run was 1340 — same cost
  with 92 features vs 106).
- verify_reproduces_shipped: max |diff| = 0 again (per-fold category refit
  exact on the provenance-filtered maps).
- LOCO CV (training corpus, 30 folds, absolute scale) vs the v2.6 run of the
  same numbers:
  - all_rows: MAE 7.224 / R2 0.638 / W10 84.7% (v2.6: 6.891 / 0.653 / 85.1%)
  - realtime_served: MAE 28.184 / R2 0.095 / W10 21.9% (v2.6: 27.543 / 0.127
    / 22.8%)
  - weekly_anchor: MAE 2.284 / R2 0.982 / W10 99.5% (v2.6: 2.024 / 0.986 /
    99.8%)
- Reading: dropping month/month_sin/month_cos/is_school_break costs ~0.6 MAE
  on the training-CV realtime slice — consistent with CP1's finding that the
  epoch features were carrying real (if artifactual) signal. This is the
  reported-CV cost of removing the artifact, NOT the gate; the gate is
  holdout-side in quick_eval.py and the incumbent will be scored on the same
  rows there. best_model.pkl + model_metadata.json written by train_model.py.
### CP5 — evaluate + ship gate: DO NOT SHIP, no export (2026-08-19)
- evaluate_model.py (eval_v27_cpu.log, exit 0): corpus mean busyness by hour
  peaks at 18-19h (57.3/57.7) with the trough at 04-05h — clock axis sane.
  Holdout blend: RMSE 15.4285 / MAE 6.5937 / R2 0.7656 / W10 85.6%;
  holdout/validation RMSE ratio 1.00. (Blend numbers, not accuracy claims.)
- quick_eval.py (gate_v27_cpu.log, exit 0), gate slice = the same 67,249
  realtime-with-baseline holdout rows as v2.6:
  - Challenger v2.7 (92 feat): MAE 29.8859 / R2 0.015 / W10 19.9%
  - Popular-times baseline:    MAE 31.4782 / R2 -0.0746 / W10 19.2%
  - Incumbent v2.6.0-starling (same_rows_preserved_features, 106 feat):
    MAE 29.4191 / R2 0.040 / W10 20.7%
  - Floor re-derived per RETRAIN.md: 20.7% = incumbent's measured within-10
    on the same rows (floor_basis incumbent_measured_within_10_same_rows;
    stale 29.2% constant not used).
  - Criterion 1 (vs baseline: MAE down >=5 OR R2 up >=0.10): MAE Δ +1.59,
    R2 Δ +0.0896 → FAIL (R2 arm misses by 0.0104)
  - Criterion 2 (MAE arm no regress): Δ +1.59 >= 0 → pass, subsumed by 1
  - Criterion 3 (floor): 19.9% < 20.7% → FAIL
  - Criterion 4 (incumbent no-regression): challenger is 0.4668 MAE WORSE
    than v2.6.0 → FAIL
  - VERDICT: DO NOT SHIP. quick_eval wrote overall_pass=false into
    models/model_metadata.json (local only, uncommitted; mlPredictor would
    fail closed on it, and the committed prod artifact is untouched).
- NO EXPORT: 2.7.0-starling artifacts were not exported, per the gate.
  models/crowd_model.onnx on disk remains the v2.6.0 export; incumbent copy
  of v2.6.0 in models/incumbent/ is intact.
- Reading: removing the four epoch features (month/month_sin/month_cos/
  is_school_break) + ten dead slots costs 0.47 MAE and 0.8 W10 pts against
  v2.6.0 on the served slice. The epoch features were carrying real
  holdout-side signal on THIS corpus — because the holdout window (Mar-May)
  shares the collection epoch with training, the artifact helps rather than
  hurts on every evaluation we can currently run. The honest-features model
  loses to the artifact model on the corpus that contains the artifact; only
  a corpus spanning more of the year can separate them. v2.6.0-starling
  stays the shipped model.
