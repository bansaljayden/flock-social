# Crowd model: retrain runbook + the continuous-learning loop

**Currently shipped: v2.5.0 "Starling"** (`models/model_metadata.json`,
trained 2026-08-12, 106 features, ship gate `verdict: ship` on the realtime
holdout slice). The narrative below was written during the v2.3 work and is
kept because the *reasoning* still holds; the version numbers in it are not
current. Always read `model_metadata.json` for live figures.

Read `ml_overfitting_fixes` doctrine first
(memory) — high R² alone means NOTHING on this problem; the weekly rows are a
tautology and the realtime slice is the only honest gate.

## The v2.3 change (why this retrain exists)

v2.2.1's real weakness: within-10pts on volatile realtime holdout rows was
18%. Root cause: 91% of training rows were weekly popular_times snapshots
where `busyness_pct == baseline` by construction → delta label exactly 0 →
the model learned to shrink every prediction toward "no deviation."

v2.3 trains on the exact population production serves: `is_realtime = 1 AND
baseline_busyness > 0` (~realtime 9% of rows). Production's no-baseline guard
(mlPredictor.js) already routes everything else to the rule engine, so the
model no longer trains on rows it will never serve.

## How to run a retrain

> **The runbook used to start at `prepare_features.py`.** That was the single
> most expensive line in this document: the checked-in CSVs were a 40-column
> pre-round-10 export, `prepare_features.py` degraded silently on them, and
> three shipped fixes (baseline smoothing, vendor-forecast weighting, the
> leave-one-out baseline) never reached an artifact. **A retrain starts at the
> export.** `prepare_features.py` now refuses a CSV that is not the current
> 44-column shape, so this cannot recur silently, but do not try.

```bash
# ── 0. PRESERVE THE INCUMBENT. Do this FIRST; it is unrecoverable afterwards.
cd backend/scripts/ml
mkdir -p models/incumbent
cp models/crowd_model.onnx models/model_metadata.json models/incumbent/
cp train/best_model.pkl train/features_holdout.pkl models/incumbent/
#    quick_eval.py FAILS THE GATE without models/incumbent/best_model.pkl.
#    features_holdout.pkl matters too: when the feature set changes (it will),
#    it is the only way to score the incumbent on the same holdout ROWS.

# ── 1. Clear stale artifacts so a partial failure cannot silently reuse them.
cd train
rm -f training_data.csv holdout_data.csv \
      features_train.pkl features_holdout.pkl best_model.pkl

# ── 2. Full pipeline, in this order. Never start in the middle.
node export_training_data.js                     # 44-column CSVs
head -1 training_data.csv | tr ',' '\n' | grep -c .   # must print 44
python prepare_features.py                       # contract-checked; see below
python train_model.py                            # LOCO CV -> best_model.pkl
python evaluate_model.py                         # diagnostics + plots
python quick_eval.py                             # SHIP GATE (must run last)
MODEL_VERSION=2.6.0-<name> python export_model.py

# ── 3. Verify the artifact the way production reads it.
cd ../../..                                      # backend/
node --test

# ── 4. Read the gate before committing anything.
node -e "const m=require('./scripts/ml/models/model_metadata.json');
         console.log(m.model_version, JSON.stringify(m.ship_gate,null,1))"
#    overall_pass must be true, gate_basis 'holdout_realtime_served', and
#    ship_gate.incumbent.no_regression must be true.

# ── 5. Commit crowd_model.onnx + model_metadata.json, push, Railway serves it.
```

`evaluate_model.py` prints **corpus mean busyness by hour** before the
MAE-by-hour plot. Read it. A peak anywhere but the evening means the clock axis
is bent and the gate cannot see it — the gate compares `baseline + clamp(delta)`
against `baseline`, so any error shared by both sides cancels.

### What `prepare_features.py` will now refuse to do

It fails loud instead of degrading. Each of these used to be a silent skip:

| It stops when | Because |
|---|---|
| the CSV is not the 44-column export | `venue_id` drives baseline smoothing, `label_provenance` drives the vendor-forecast weight; without them both were skipped in silence. Round 20 appended `label_source` and `vendor_forecast_pct` as CARRIED columns (validated and pickled, never features) — a CSV without them would still train, which is why their absence has to be an error: it means the file predates the exporter |
| `label_source` carries a value outside `{live, forecast}`, or `label_provenance` is not what `(is_realtime, label_source)` implies, or a `forecast` row disagrees with its own `vendor_forecast_pct` | the derived column is a pure function of the raw one, so the two check each other; a mismatch means a row rejoins the weight-1.0 pool as `unknown` with nothing said |
| a weather description is not in `WEATHER_DESCRIPTION_CODES` | guessing a group is inventing data — add the OpenWeatherMap id |
| no `weather_condition_code` survives recovery | all ten `weather_*` features would be constant again |
| any row lacks `month` / `season` | `month=0` with four zero season one-hots cannot occur at inference |
| every row's `label_provenance` is `unknown` | vendor forecasts would all be weighted 1.0 again |
| the holdout is missing a non-one-hot feature | the two frames went through different code paths |
| a feature column is CONSTANT and is not named in `EXPECTED_SPARSE_FEATURES` | a constant column is never a split, so it produces no wrong number to notice — it just sits there while metadata advertises it and `mlPredictor.js` builds and parity-checks it. See "Dead feature slots" below |

Three escape hatches exist. All are explicit, all log a warning, all are
recorded in `model_metadata.json.corpus_contract`, and **none is acceptable
for a release**:

```bash
FLOCK_WEATHER_POLICY=drop    # remove the 10 weather features instead of faking them
FLOCK_CALENDAR_POLICY=drop   # remove the 12 calendar/month-derived features
FLOCK_DEAD_SLOT_POLICY=warn  # ship an unexplained constant column anyway
```

### Dead feature slots (2026-08-16)

The last run logged `DEAD SLOTS — 11 of 106 features are CONSTANT`. Ten were
true statements about a corpus collected inside one ten-week window
(2026-03-10..2026-05-18); one was a bug. Audited row by row against
`train/features_train.pkl`:

| slot | value | share | verdict |
|---|---|---|---|
| `cold_outdoor` | 0 | 100% | **BROKEN, FIXED.** `temperature < 5` was a Celsius threshold on a Fahrenheit column — `weatherService.js` fetches `units=imperial` and the corpus minimum is 14.7°F, so it could never fire. `mlPredictor.js` carried the identical expression, so the feature-parity gate was green while the slot was dead on **both** sides. Now 41°F (= 5°C) in both files; fires on 5,321 rows (0.28%) |
| `is_holiday` | 0 | 100% | EXPECTED-SPARSE. `config.js HOLIDAYS` is a US federal calendar and the window contains no entry (Memorial Day 2026-05-25 is 7 days past the last row). Fills in on the first run crossing a federal date |
| `season_spring` | 1 | 100% | EXPECTED-SPARSE. Every row is month 3-5, so this is 1 everywhere |
| `season_summer` / `season_fall` / `season_winter` | 0 | 100% | EXPECTED-SPARSE. Same cause. Fills in when collection spans a second quarter. Note the asymmetry: in July `mlPredictor` emits `season_summer=1`, a corner with zero training support — audit finding 5 pointing the other way |
| `avg_user_crowd`, `log_user_feedback_count`, `has_user_feedback`, `avg_prediction_error` | 0 | 100% | EXPECTED-SPARSE. The exporter joins `venue_feedback WHERE verified = true` and no presence-verified row exists yet. **Fix audit finding 13 before they fill in** — that join is per-venue over all time with no cutoff, so the day they stop being constant is the day a lookahead leak arms |
| `etype_family` | 0 | 100% | EXPECTED-SPARSE. A level of a one-hot whose other four are alive. `collectEvents.mapEventType` and `mlPredictor.mapTmEventType` both emit `family` (checked, they agree); the 206,925 enriched rows contain none. Same shape as `weather_snow`, alive on 1,605 rows |

Also checked and clean, so nobody re-derives it: `eventService.js`'s
`mapEventType` uses a *different* vocabulary (`concert`, `film`) from
`collectEvents.js` (`music`, `family`), but it only feeds `event_type`, which
`get_feature_columns` excludes. `nearest_event_type` — the column the `etype_*`
one-hots come from — is written solely by `enrichWithEvents.js` from
`ml_events`, on the `collectEvents` vocabulary. No divergence reaches a feature.

Not a dead slot but worth recording next to `season_*`: `getSeason()` in
`scripts/ml/config.js` is northern-hemisphere only, so Sydney rows collected in
March-May are stamped `spring` when it is autumn there. It does not cause the
dead slot (the ten-week window does) and it cannot be seen while the corpus has
one season in it.

Re-running `prepare_features.py` now **merges** into `model_metadata.json`
instead of rewriting it from scratch, but it deliberately evicts `ship_gate`,
`evaluation` and `training_metrics` and says so — those describe the previous
feature set. Until `quick_eval.py` writes a fresh gate, `mlPredictor.init()`
fails closed and the backend serves the rule engine. That is correct; it is no
longer silent.

If training dies, the feature pickles persist — rerun `train_model.py`.

> **Gitignore trap.** `.gitignore:37` lists
> `backend/scripts/ml/models/crowd_model.onnx`, but the file is already **tracked**,
> and gitignore does not apply to tracked files — so committing an updated model
> works today. If anyone ever runs `git rm --cached` on it, the ignore rule takes
> over and every future retrain will silently fail to ship while looking like it
> succeeded. After pushing, confirm with
> `git log --oneline -1 -- backend/scripts/ml/models/crowd_model.onnx`.

## The ship gate

`quick_eval.py` writes `ship_gate` and `mlPredictor.init()` refuses to load an
artifact whose gate fails. The gate is measured on **the holdout rows production
actually serves** — `is_realtime == 1 AND baseline_busyness > 0` — using the same
`serving_population_mask` predicate `prepare_features.py` filters training with.
It is imported, not re-implemented, so the two cannot drift. All four of these
must hold:

1. vs the popular-times baseline on the gate slice: **MAE down ≥5 OR R² up ≥0.10**
2. the MAE arm must **not regress** (Δ MAE ≥ 0) even when the R² arm carries it
3. absolute floor: realtime **within-10 ≥ 29.2%**
4. **no MAE regression against the incumbent artifact**

Criteria 2–4 are new. Before them, v2.5 passed by failing the MAE arm by 2.7
points and clearing the R² arm by 0.0026, and the gate slice included realtime
rows with no baseline — rows where the model's reconstruction is capped at
`0 + clamp(delta) ≤ 30` against actuals up to 100. The excluded count is written
to `ship_gate.excluded_no_baseline_rows`, and the old unfiltered figure survives
as `ship_gate.realtime_unfiltered_diagnostic`.

> **The incumbent comparison now exists.** This document previously claimed
> "`quick_eval.py` does this" — it did not. It loaded exactly one model and one
> comparator (the popular-times baseline), so a retrain worse than v2.5 that
> still beat the raw baseline would have shipped. The "21.46 vs 22.77" figures
> quoted here were **not reproducible from any script in this repo** and appear
> in none of the checked-in logs; `eval_v25.log` records 21.2073 vs a 23.498
> popular-times baseline. Treat them as unverified.
>
> `quick_eval.py` now loads `models/incumbent/best_model.pkl` and scores it on
> the same holdout rows. If the feature set is unchanged it runs on the same
> matrix (`basis: same_rows_same_features`); if the feature set changed it runs
> the incumbent through `models/incumbent/features_holdout.pkl` and verifies the
> `y_actual` vectors are identical before comparing (`same_rows_preserved_features`).
> A missing incumbent, a missing preserved pickle, or a row mismatch **fails the
> gate**. `ML_ALLOW_NO_INCUMBENT=true` is the first-model-ever hatch;
> `ML_ALLOW_APPROXIMATE_INCUMBENT=true` accepts a labelled row mismatch. Both are
> recorded in `ship_gate.incumbent`.
>
> Do not hardcode any incumbent number in this document. Re-run the incumbent on
> the same holdout every time and compare within that run.

**Round 10:** `quick_eval.py` is no longer advisory. It writes
`ship_gate.overall_pass` from the realtime-only holdout slice, and
`mlPredictor.init()` refuses to load an artifact whose gate fails — the backend
serves the rule engine instead and logs why at startup. So:

- `quick_eval.py` must run after `evaluate_model.py` and before you commit the
  artifact (`run_training.sh` now does this as step 5 of 6).
- Only `quick_eval.py` may write `ship_gate`. `evaluate_model.py` writes its
  validation-split comparison under `validation_baseline_delta`.
- Comparing model MAE to the popular_times baseline on the AGGREGATE holdout is
  meaningless: ~84% of those rows are weekly snapshots where the label equals
  the baseline by construction, and against a baseline MAE of ~6 the doctrinal
  "MAE down ≥5" threshold cannot be met by any model. Use the realtime slice.
- `ML_SHIP_GATE_OVERRIDE=true` promotes a failing artifact anyway (loudly).
  Local debugging only.

## GATE-B: the two-metric alternative — **ARMED 2026-08-28**, as the either-path gate

**Jayden made the decision this section was written to wait for** (2026-08-28:
within-10 is the primary metric, "I'm really big on the one number"), and the
qmap serves by default the same day. The arming interpretation, since the
draft predated the decision: the legacy arms and B1-B3 are ALTERNATIVE
admission paths (a routine retrain that spends no MAE ships the old way; a
deliberate dispersion-spending candidate ships the B way), the floor binds on
both, an honest incumbent comparison is required on both, and B4 re-verifies
the fixed table by enumeration per run. `quick_eval.py` gate_b() implements
it and `ship_gate.admission_path` records which path admitted every artifact.
The draft below is kept as written.

**The draft (2026-08-20), as it stood before arming.** `quick_eval.py` implements the four criteria
above and only those. GATE-B is written down so the trade it describes can be
taken deliberately, by Jayden, in one decision, instead of being smuggled in as
a waiver of an arm that is doing its job. Arming it is a code change in
`quick_eval.py` plus that decision. The gate above is not modified.

### Why an alternative exists at all

The gate above is **MAE-protective by construction**: criteria 1 and 2 both
require no MAE regression against the popular-times baseline. That was the right
guard while the question was "is this model better than Google's curve".

The dispersion work changed the question. Reality on the gate slice is bimodal
(actual sd 36.65, 23.6% of served venue-hours at or below 5, 22.1% at or above
90), and the shipped number is compressed to 0.58 of that spread. A point
estimate cannot sit near both modes: **MAE is minimised by the conditional
median of a bimodal target, within-10 by committing to a mode.** So the two
metrics are not two views of one quality. They are opposite instructions, and
the MAE arm is a standing vote for one of them that nobody has ever cast on
purpose.

Measured, not asserted: across ~40 post-hoc corrections (clamp widths, affine
and quantile maps in delta and score space, isotonic, banded pushes, blends),
the largest within-10 gain available *inside* the MAE budget is **+0.26pp** —
the clamp-±50-plus-push that already shipped. Everything with real magnitude
costs MAE. Full grid: `train/RETRAIN-V27-LOG.md`, "Dispersion lab".

### GATE-B

Replaces criteria **1 and 2** (the MAE arms). Criteria **3 and 4** are unchanged
and still binding. All of B1–B5 must hold, on the gate slice, against the
incumbent measured on the same rows, with 95% CIs from a 2000-resample
date-block bootstrap.

| arm | requirement | where the number comes from |
|---|---|---|
| **B1** | within-10 improves by **≥ +5.0pp**, and the bootstrap CI lower bound is **> +2.5pp** | The MAE-protective gate's entire admissible set tops out at +0.26pp. A threshold anywhere in 0.3–3pp would admit noise-scale gains that still spend MAE. +5.0pp is one more correct card in every twenty, the smallest change a user could notice across a browsing session, and it is deliberately **below** the only measured candidate (+8.40pp) so it is not that candidate's own number rounded down. |
| **B2** | MAE regresses by **no more than +3.5**, and the bootstrap CI upper bound is **< +4.0** | The measured frontier charges **0.16–0.36 MAE per +1pp** of within-10 (lab, section 2). Rounding the far-end price up to 0.40 and applying it to the largest gain anyone has produced (+8.4pp) gives **3.4**. So +3.5 is "the worst price the frontier charges, at the biggest gain on record". It is not a budget sized to fit a candidate, though it does fit the current one with 0.35 to spare. |
| **B3** | within-20 must **not regress** | This is the arm that distinguishes the trade from a plain loss. MAE rising while both within-10 and within-20 improve means the cost is concentrated in the tail, which is exactly what committing to a mode buys. MAE rising while within-20 *also* falls means the whole error distribution moved outward, which is not a trade, it is a worse model. |
| **B4** | the calibrator must be **monotone non-decreasing** on the published 0..100 domain, proved by enumeration, and its effect on within-venue-day hour pairs and same-hour cross-venue pairs must be **measured**, not argued from monotonicity | Ordering is a separate claim from level (`HOUR-RANKING-EVAL.md`). A recalibration measured only on point accuracy could silently reorder the best-time line. Monotonicity makes reversals impossible but it does **not** make ties impossible, and ties are what a rail-saturating map actually produces. |
| **B5** | the band must be assigned from the **mapped** number, and the published confidence figure must be the mapped number's **own** measurement | Otherwise the card shows one number, labels it from another, and quotes an accuracy measured on a third. |

**GATE-B does not waive the awkward fact, it records it.** A run under GATE-B
must write `ship_gate.mae_vs_baseline_broken: true` when MAE exceeds the
popular-times baseline on the same rows, along with both figures. That is not a
formality: it is the single strongest argument against this trade, and it must
appear in the verdict rather than in a doc nobody re-reads.

### What GATE-B says about score-qmap (measured 2026-08-20, prequential)

Fitted on the earliest 30% of gate dates (≤ 2026-03-28, 21,148 rows) from the
shipped 2.6.0-starling artifacts, scored forward on 46,101. Against the
reconstruction production performs today (clamp ±50 + push, rounded), **not**
the legacy ±30 arithmetic the 2026-08-19 lab used as its reference.

| arm | requirement | measured | |
|---|---|---|---|
| B1 | ≥ +5.0pp, CI lo > +2.5 | **+8.40pp**, CI95 [+7.17, +9.69] | PASS |
| B2 | ≤ +3.5, CI hi < +4.0 | **+3.15**, CI95 [+2.72, +3.57] | PASS |
| B3 | within-20 not worse | **+4.54pp**, CI95 [+3.57, +5.55] | PASS |
| B4 | monotone, ordering measured | **0 reversals** on 21,905 hour pairs and 123,051 cross-venue pairs; 6.4% / 10.3% new ties | PASS |
| B5 | band + confidence from the mapped number | implemented (`mlPredictor.js`, `applyScoreQuantileMap` before `getLabel`; confidence switches to `QMAP_MEASURED`) | PASS |
| — | `mae_vs_baseline_broken` | **true**: MAE 33.13 vs the popular-times baseline's 31.20 on the same rows | recorded |

So score-qmap **clears GATE-B and fails the gate in force**, which is the whole
point of writing both down. The number in the last row is the one to argue
about: with the map on, the model's average error is worse than publishing
Google's curve untouched, while its hit rate is ten points better than it. Both
of those are true at once, and that is what a bimodal target does.

Decision write-up, in plain terms: `train/QMAP-DECISION.md` (gitignored, local).
Implementation: `CROWD_QMAP_ENABLED`, default off, in `backend/.env.example`,
`services/mlPredictor.js` and `train/quick_eval.py`.

## Pre-retrain audit status (`PRE-RETRAIN-AUDIT.md`, 8 BLOCKING items)

Do not start the retrain until every BLOCKING row below reads DONE or has an
owner. The audit file itself is the specification and is not edited; this is the
status board.

| # | Blocking finding | Status |
|---|---|---|
| 1 | Stale 40-column CSVs; runbook started after the export | **DONE (python side).** `prepare_features.py` raises `CorpusContractError` on any CSV that is not the 44-column export, naming the missing columns and telling you to re-run the exporter. Runbook above now starts at step 0 (preserve incumbent) then `node export_training_data.js`. Deleting the stale CSVs is step 1 of the runbook. |
| 2 | No unique constraint on `ml_training_data`, so `ON CONFLICT DO NOTHING` is a no-op | **DONE.** Migration `024_ml_training_data_unique_slot.sql` collapses the duplicates and adds the key; both collectors now name a real conflict target. The index shape deviates from the one specified here — see "The unique key on `ml_training_data`" below for what changed and why the `COALESCE(observed_date,'1970-01-01')` form would have destroyed data. |
| 3 | Positional `shift(1)` smoothed an hour against itself on duplicate rows | **DONE.** `smooth_baseline_hours()` collapses to one value per (venue_id, dow, hour), lays them on a complete 7×24 grid so a missing hour is a real gap, blends against the true clock neighbours with the day/week wraps `mlPredictor.getBaseline` uses, and merges back. Measured on a duplicate-heavy fixture: the old code left 9,714 of 14,112 cells holding more than one distinct smoothed baseline; the new code leaves 0. |
| 4 | `weather_condition_code` NULL on 100% of rows → ten constant features | **DONE (recovery + contract).** `WEATHER_DESCRIPTION_CODES` maps every OpenWeatherMap description to its condition id and `recover_weather_codes()` backfills the column; the 25 descriptions present in the 2026-08-12 corpus are all covered. Unmapped descriptions are reported by name and count and stop the run. **The collector half is now DONE too:** both `collectWeekly.js` and `collectRealtime.js` write `weather.conditionId` into `weather_condition_code`, so recovery is a transitional path for old rows rather than a permanent one. The historical rows are deliberately NOT backfilled in SQL — the exporter already derives them, and a second full-table rewrite would have doubled the deploy's downtime for nothing. |
| 5 | 62.9% of rows carry `month=0` with all four season one-hots at 0 | **DONE, with one stated limitation.** `collectWeekly.js` now stamps `month`/`season` from the venue's own clock at collection (falling back to UTC if `ml_venues.timezone` is unusable), and migration 024 backfills every existing row from its `collected_at`, which is a real `DEFAULT NOW()` insert timestamp and not an invented date. Rows whose `collected_at` is NULL are skipped, not guessed. The limitation, which the retrain must not forget: on a weekly row `month` means "the month this typical-week snapshot was taken in", not "the month this busyness happened in", and because collection ran in a narrow window it does **not** stop `month` from proxying row provenance. What it does fix is the impossible corner — every stamped row now has a month in 1..12 and exactly one season, a region the serving path actually reaches. `prepare_features.py`'s refusal and `FLOCK_CALENDAR_POLICY=drop` both stay as the guard. |
| 6 | Gate measured on holdout rows production refuses to serve | **DONE.** `quick_eval.py` imports `serving_population_mask` from `prepare_features` and applies it to the gate slice; the excluded count is logged and persisted, and the old unfiltered number is kept as a labelled diagnostic. |
| 7 | No incumbent comparison, and this document claimed there was one | **DONE.** See "The ship gate" above. Absent or dishonest comparison = gate failure. |
| 8 | Gate structurally blind to corpus-wide corruption; v2.5 passed by 0.0026 | **PARTLY DONE.** Added here: the MAE arm may not regress, an absolute realtime within-10 floor of 29.2%, and a per-hour corpus mean printed by `evaluate_model.py` so a bent axis is visible. Still open: the hard assertion that category peak hours land in the evening, which now belongs with the retrain — the corpus-side clock fix shipped 2026-08-15 (migration 023 + both collectors), so `__tests__/dinnerPeakAccuracy.test.js:332` (PART 3) now *pins the shipped artifact's pre-fix vintage* (model_metadata.json's category_baselines are still on the bucket axis) and must be fully inverted when a model is exported from the corrected corpus, not worked around. |

Non-blocking items also closed in the same pass: **#10** (`evaluate_model.py` no
longer re-reads the raw CSV and positionally truncates it — `hour` and
`venue_category` travel inside the pickle, and the LOCO folds refit **with**
`sample_weight`, so `evaluation.validation` finally describes the model that was
actually trained) and the first half of **#11** (`prepare_features.py` merges
metadata instead of rewriting it, and names the keys it evicts).

Still open in `run_training.sh`, which is not owned here: its summary reads
`evaluation.validation`, a key `quick_eval.py` has never written (it writes
`training_loco_cv`), so the summary prints `?`; and step 4 imports matplotlib +
seaborn unguarded under `set -e`, so a missing plotting dependency aborts the
pipeline **before** the ship gate runs.

Left open in that pass and **closed on 2026-08-16**: the `category_baseline` /
`refined_category_baseline` leak that
`metadata.training_contracts.known_residual_leak` names. `prepare_features.py`
fits both on the whole training frame and applies them to it, so a city
`train_model.py` later holds out had already built the cells its own rows are
scored against. It made `training_metrics` optimistic; it never touched the
ship gate, whose holdout cities contribute to neither map. Round 14 attempted
the fix, measured it, and rejected the cheap formulation — see lever 2 for the
numbers — and shipped the raw material instead: `features_train.pkl` carries
`category_cell_stats`, so the correct per-fold refit is a subtraction inside
the fold loop rather than a second pass over the CSV. Round 21 consumed it, and
found on the way that the statistics had to be fitted on the pre-filter frame
or the correction would be swamped by a population confound fifty-four times
its size. `known_residual_leak` stays as a key and now reads CLOSED FOR THE
REPORTED METRICS, naming what remains by design; `corpus_contract
.category_baseline_fit` reads OPEN IN THIS FILE, which is true of
`prepare_features.py` and cannot be otherwise — it has no folds.

## The continuous-learning loop ("constantly machine learning")

The model gets better as the app is used. Ground-truth sources that accrue in
prod, in order of value:

1. **`venue_feedback`** — users report actual crowd levels in-app. Already
   joined into training as per-venue aggregates. NEXT EXPORT UPGRADE: also emit
   each feedback row as a realtime training row (crowd_level -> busyness_pct
   at that venue/day/hour, with the REAL DATE — which unlocks holiday-eve
   learning, see below).
2. **`venue_sensor_data`**: Pi sensor headcounts where deployed. Would be the
   highest quality ground truth, but nothing exports this table into training
   yet and no sensor has ever run on real hardware. The pipeline is written and
   software-tested (flock-sensor/test_main.py, in CI), which is not the same
   claim as proven; the 2026-05-02 "proven" referred to a curl test of the
   ingest route. Building this exporter requires the provenance review
   prepare_features.py demands for a new source.
3. **`venue_checkins`** — check-in counts as a weak busyness proxy.
4. **BestTime realtime re-pulls** — paid; see ml_besttime_limits memory before
   ANY run (quota rules).

Cadence: retrain when meaningful new realtime rows accumulate (rule of thumb:
+20% over the last training set, or quarterly, whichever first). Each retrain
re-runs the same gate. With ~0 users the loop idles; the pipeline being ready
is the point.

## Holiday / holiday-eve features (Jayden's directive, plumbing spec)

The data has `is_holiday` (stamped at collection) but NO date column, and
weekly rows are dateless by nature ("typical Tuesday"), so holiday-EVE
effects (Thanksgiving Eve, NYE, day-before-federal-holiday — the actual bar
nights) cannot be learned from the current dataset retroactively.

Go-forward plumbing:
1. DONE (2026-08-12) — `holidays.json` now has THREE layers, generated by
   `generate_holidays.py`:
   - `holidays`: official public holidays, 31 calendars, 2025-2028.
   - `party_nights`: the original small hand-curated layer (kept for compat).
   - `special_nights`: the full per-country nightlife research encoded as
     ~1,350 dated nights across 29 scopes. Schema:
     `{scope: {"YYYY-MM-DD": {name, effect: boost|suppress|mixed, conf: high|med|low}}}`
     where scope is an ISO country code (all cities in that country) or a
     city key (layered on top, city wins). Covers legal alcohol bans (India
     dry days, Thai Buddhist ban days, NSW restricted trading, Berlin
     Tanzverbot), exodus windows (CNY Beijing, Ferragosto, Obon, August
     Paris), and party spikes (Mardi Gras NOLA, Caribana, ADE, Carnival SP,
     Día del Amigo, Korea couples-Christmas — direction is per-country, do
     not assume the Western prior). 2028 lunar dates are estimates — re-run
     the generator when verified dates publish.
2. DONE (2026-08-12) — parity bug fixed: mlPredictor.buildFeatureVector was
   sending `is_holiday: 0` always while training rows stamped it from
   `config.js`. Inference now uses the same `isHoliday`/`isSchoolBreak`
   calendar (extended through 2028).
3. PARTLY DONE (2026-08-12) — `collectRealtime.js` now stamps every new
   realtime row with `observed_date`, `is_holiday_eve`, `special_night`,
   `special_night_effect`, `special_night_conf` (lookup module:
   `scripts/ml/specialNights.js`; columns self-migrate, mirrored in
   ml-schema.sql). STILL TO DO: venue_feedback export as dated realtime
   rows (needs prod DB session).
4. NEXT — add special-night features to prepare_features.py + matching
   mlPredictor computation, gated on metadata.feature_names (backward
   compatible). First retrain after a season of stamped data can actually
   learn the effects. Until then, eves ride on is_holiday + day-of-week.

## Research findings (2026-08-12, commissioned)

**Public data verdict:** NO free, commercially-licensed venue-hour busyness
dataset exists anywhere — the BestTime rows ARE the moat. Explicitly OFF
LIMITS (non-commercial licenses): Yelp Open Dataset, Dewey/Advan academic
seats. USABLE free adds: MTA subway hourly ridership + NYC TLC taxi
(commercial-OK area-hour demand proxies, NYC), Foursquare OS Places
(Apache-2.0, static venue features for all 31 cities), OSM (density features,
mind ODbL share-alike). Bikeshare GBFS per-city (read Lyft's Citi Bike terms
first).

**Holiday evidence (all magnitudes = industry estimates, validate against our
own BestTime history via event-study before trusting):** the EVE beats the day
for bars — Thanksgiving Eve beer +85%, 2018's top bar days were NYE / July 3
/ Thanksgiving Eve (July 3rd, not 4th); UK "Mad Friday" +142%. Named events
have distinct shapes, so one is_holiday flag averages them away. Feature spec
(supersedes the sketch above): is_public_holiday + is_public_holiday_tomorrow
+ days_to_next_holiday (clipped) + days_since_last_holiday + named one-hots
(~10: nye, halloween_weekend, st_patricks, cinco_de_mayo, thanksgiving_eve,
july_3, mad_friday-UK, san_juan-ES, bonenkai_friday-JP Dec 1-22, golden_week-
JP) + is_bridge_day + payday flags (low confidence, let importance decide) +
college-calendar flags interacted with market_type. Spain: city fiestas (La
Mercè, San Isidro) matter beyond national calendars; peak club entry 1-3 AM
shifts eve effects past midnight. Japan: NYE is family/shrine — do NOT copy
the Western prior; Shibuya Halloween street ban (2025) displaced demand INTO
clubs. Base calendar: Python `holidays` pkg (MIT, subdivision support) + a
hand-curated party-nights YAML (~30 rows/yr).

## Feature roadmap (commissioned research 2026-08-12, ranked evidence x feasibility)

**Zero-cost, ship first (derive from data we already fetch):**
1. Evening-rain timing (rain 18-23h vs daytime rain, "dry evening after wet day")
2. Sunset/daylight via `suncalc` npm (BSD-2): minutes-after-sunset, daylight
   duration, patio-dusk hour — JPMC found DST spend effects; sunset encoding
   subsumes a DST flag
3. Temperature ANOMALY vs city-month normal (literature: beats absolute temp;
   "first warm Friday of spring" flag) — needs a one-time 31x12 normals JSON
4. Big-TV-event calendar (~20 dates/yr/region, hand-curated JSON: Super Bowl,
   World Cup/UCL finals, El Clasico, Eurovision) — documented +36% traffic days

**From our own DB (strongest academic support — spatial):**
5. Neighbor-venue same-hour baseline within 300-800m + same-category counts
   (agglomeration lit: neighbor demand predicts a venue's demand)
6. Nightlife-cluster features (DBSCAN per city: cluster id, dist-to-centroid,
   rank-in-cluster)

**Cheap paid / enrichment:**
7. TheSportsDB $9/mo Single Developer tier (dedicated key, commercial OK,
   attribution): game nights x venue proximity x category — documented
   +21-70% sports-bar lifts. Scope expanded 2026-08-29 below; read that
   section before building this, the original one-liner here undersold it.
8. Anchor proximity (stadium/theater/campus <=1km) via Overture Maps Places
   (CDLA-P 2.0, clean commercial license) — also late-close/hours-shape flags
   and chain-vs-independent from FSQ OS Places/Overture
9. NYC permitted-events open data (street festivals Ticketmaster misses)
10. Tourism seasonality index (Eurostat etc., static 31x12 table)

**DO NOT BOTHER (verified):** moon phase (junk), Google Trends (no commercial
API), ESPN hidden API (ToS), Eventbrite search (dead since 2019), Songkick
(dormant), OpenTable/Resy availability (partner-gated), happy-hour datasets
(don't exist), warehoused Google photo/review metadata (Places ToS: no caching
>30 days, no ML training on Maps content — keep ALL stored venue metadata on
FSQ/Overture instead; see vault note on the baseline provenance question).

## Next levers after v2.3 (in order)

1. Feedback-rows-as-labels export (closes the loop for real).
2. **In-fold `category_baseline` recomputation. It must be PER-FOLD. The cheap
   substitute is disproven — do not reach for it.**

   The leak: `prepare_features.build_category_baseline_maps` fits two means of
   `busyness_pct` on the whole training frame, `add_baseline_features` applies
   them to that same frame, and `train_model.py` then holds out one city per
   `GroupKFold` fold — so a held-out city built the cells its own rows are
   scored against. Optimistic `training_metrics`; the ship gate is untouched,
   because the holdout cities contribute to neither map.

   The obvious cheap fix — one leave-one-city-out map computed once, each row
   reading `(cell_sum - own_city_sum) / (cell_n - own_city_n)`, the subtraction
   `export_training_data.js` used for its round-13 anchor — **is eight times
   worse than the leak it removes.** Under it the feature varies by city inside
   a fold, and its deviation from the cell's typical value is an invertible
   function of the held-out city's own labels: a tree splits on
   (category, dow, hour) to find the cell, then on `category_baseline` inside
   it, and reads that city's mean level straight off the feature.

   Measured on a synthetic fixture over three independent draws (10 training
   cities, `GroupKFold` on city, identical hyperparameters, delta label whose
   only learnable signal is a per-city deviation, so an honest model cannot
   beat the predict-zero floor on a city it never saw). The per-fold refit is
   the reference: its final model is the same artifact the whole-frame fit
   produces, and on a pristine 3-city holdout the two score identically, so any
   difference in the *reported* CV number is reporting, not model quality.

   | category-baseline regime | reported MAE below the honest reference | reported within-10 above it |
   |---|---|---|
   | whole-frame fit (what ships today) | 0.21 – 0.42 | 1.4 – 2.1 pp |
   | leave-one-city-out computed once | **1.52 – 3.05** | **10.4 – 20.5 pp** |
   | K-fold block encoding, K = 2 / 3 / 5 | −0.05 – 0.80, no ordering in K | 0.9 – 5.0 pp |
   | per-fold refit from the fold's own rows | 0 by construction | 0 by construction |

   Within-10 matters here beyond the table: `mlPredictor.js` publishes a
   within-N figure as the venue card's confidence, so the compute-once
   formulation would move the number shown to users by 10 to 20 points on the
   strength of a leak. Block encoding is not even monotone in K — at K=3 on one
   draw it is worse than doing nothing. Only the per-fold refit is honest, and
   it is honest for a structural reason: inside a fold the map is one value per
   cell, shared by that fold's training and validation rows alike, so there is
   no city-varying residual left to invert. That property is what makes it
   correct, and it is why the fix cannot live in `prepare_features.py`, which
   emits one feature matrix and has no folds.

   **DONE (2026-08-16), and it took a second correction to get right.**
   `train_model.FoldCategoryBaselines` rebuilds both maps from each fold's own
   training cities, inside the LOCO loop and inside the early-stopping split,
   before that fold is fitted or scored. The shipped artifact is still fitted on
   the whole-frame matrix on purpose — that map is what `mlPredictor.js` is
   handed and serves, and inference has no held-out group — so what moved is the
   reported number, not the model.

   **The trap on the way there, because it is the same shape as the leak.** The
   statistics were first aggregated AFTER the serving-population filter, since
   `row_cell` / `row_group` are positional indexes into `X` and `X` is the
   filtered matrix. But the map they replace is fitted BEFORE that filter, on
   3,516,876 rows rather than 1,934,988. Measured on the shipped pickle:

   | difference the fold map carried | rows moved | mean abs shift |
   |---|---|---|
   | population (aggregated post-filter vs the shipped pre-filter map) | 99.9% | **9.27 pts** |
   | the leak itself (held-out city removed) | 74.9% | 0.17 pts |

   The confound was **fifty-four times** the effect. Publishing that as "the
   leak-corrected CV" would have described a model whose category feature is not
   the shipped one — the same sin as the 84% confidence figure, in a new place.
   `build_category_cell_aggregates` now runs on the pre-filter frame and
   `index_category_cells` attaches the indexes afterwards.

   **What makes it checkable rather than argued.** Hold out no city and the
   rebuilt columns must equal the shipped columns bit for bit.
   `FoldCategoryBaselines.verify_reproduces_shipped` asserts exactly that on the
   real matrix before a single fold is fitted, and writes the max abs diff into
   `metadata.training_contracts.category_baselines_refit_per_fold`.
   `train/test_fold_category_baselines.py` (7 tests, `python
   test_fold_category_baselines.py`, no pytest needed) runs the same property on
   a synthetic corpus through the real pipeline functions, and its negative
   control rebuilds the statistics the old way and requires the suite to catch
   it. Invariance checks are not used and must not be: the compute-once
   formulation in the table above passes one.

   **This means an old `features_train.pkl` is refused.** `category_cell_stats`
   is versioned; v1 stops the run with instructions. Re-run
   `prepare_features.py` — which the 42-vs-44-column export contract already
   forces anyway.
3. Ensemble XGBoost + LightGBM (+0.02-0.05 R² typical).
4. Absolute prediction head (second model for no-baseline venues) so the
   rule-engine fallback dies entirely.
5. Populate/verify `ml_venue_baselines` coverage in prod; set
   TICKETMASTER_API_KEY on Railway (event features currently zero).

## THE HOUR AXIS IS FIXED (2026-08-15) — what the next retrain must assume

The corpus the shipped model was trained on had **two clocks in one column**,
and the next retrain is the first one that does not. Read this before running
`export_training_data.js`.

**What was wrong.** `collectWeekly.js` wrote BestTime's `day_raw` ARRAY INDEX
into `ml_training_data.hour`. BestTime's day runs 06:00-05:59, so stored slot 18
was the venue's midnight (`stored = (local_hour - 6) mod 24`). `collectRealtime.js`
wrote the TRUE venue-local hour into the same column. `buildBaselines.js` copied
the weekly axis into `ml_venue_baselines`, which `mlPredictor.getBaseline` reads
as a wall clock — and this is a delta model, so the baseline is the answer. A
6 PM request was answered with the venue's overnight number.

**What changed, all of it free — no BestTime call was made.**

1. `collectWeekly.js` now writes `(slot + 6) % 24` as the hour and rolls
   `day_of_week` forward for slots 18-23 (BestTime day D covers local D 06:00
   through D+1 05:59, so Saturday slot 20 is *Sunday* 02:00). Exported as
   `bestTimeSlotToLocal()`.
2. New column `ml_training_data.hour_axis` (`'venue_local'` | `'besttime_index'`
   | NULL = written before the column existed). Both collectors declare
   `'venue_local'` on every row they write.
3. Migration `023_backfill_ml_weekly_local_hours.sql` applies the same transform
   to every existing weekly row, in batches, resumably, and rebuilds
   `ml_venue_baselines` from the corrected rows. It is idempotent and re-runnable
   forever: its predicate is `collection_mode = 'weekly' AND hour_axis IS NULL
   OR 'besttime_index'`, which is the disease itself. **Realtime rows are not
   touched at all** — their hour was always correct, and the test proves
   untouched by xmin, not by values.
4. A CHECK constraint now REJECTS a weekly insert that does not declare its axis.
5. `collectRealtime.js`'s baseline refresh was a second, drifted copy of
   `buildBaselines.js`'s statement with no `collection_mode` filter — it averaged
   live readings and weekly forecasts, on two clocks, into one slot. It now calls
   `buildBaselines.refreshCollectedBaselines()`. One writer, one definition.

**What the retrain must assume.**

- **The delta labels are different now.** `export_training_data.js` computes its
  leave-one-out baseline by grouping on `(google_place_id, day_of_week, hour)`
  across BOTH modes. Before, each group mixed weekly rows at index *h* with
  realtime rows at local hour *h* — two unrelated times of day — so every
  realtime row's `busyness - baseline` label was computed against the wrong
  anchor. That is fixed by the backfill alone; the export SQL needed no change.
- **Do not compare to the old metrics.** v2.5.0's realtime MAE of 21.46 was
  measured on the mixed axis. Re-run the incumbent on the same holdout, as the
  doc says above — but understand that this time the incumbent is being scored on
  data whose hour column means something different from what it was trained on.
  The honest comparison is new-vs-new plus the ship gate.
- `prepare_features.py`'s neighbouring-hour baseline smoothing (`shift(±1)`
  within `venue_id, day_of_week`) now smooths across real adjacent hours, and the
  00:00-05:00 block now sits in the correct weekday group.
- The category peaks inside the CURRENT `model_metadata.json` are still on the
  old axis. `__tests__/dinnerPeakAccuracy.test.js` PART 3 asserts that, and it
  will go red the first time a model is exported from corrected data. That is the
  signal to delete PART 3 and the long note above `getBaseline` in
  `services/mlPredictor.js`, and to flip `crowdEngine.ML_BASELINE_AXIS_VERIFIED`.
  Flip it only after the retrain ships — the baselines are correct now, but the
  weights are not yet.

**Order of operations for the retrain:**

```bash
# 1. migration 023 must have applied (it runs on server boot; check
#    schema_migrations). Then, and only then:
node scripts/ml/buildBaselines.js      # refuses if any weekly row is undeclared
node scripts/ml/train/export_training_data.js
# 2. usual pipeline from the top of this file
```

**Still broken, deliberately out of scope of that change:**
`scripts/ml/discoverBestTime.js` `insertForecastData()` still writes the raw
`day_raw` index and does not set `hour_axis`. Since 023 it fails LOUDLY on the
CHECK constraint (logged per row, 0 rows inserted) instead of silently seeding a
second clock. The fix is the same two lines `collectWeekly.js` got. Note the
script also spends BestTime credits, so nothing runs it right now.
`database/ml-schema.sql` and `initTables.js` also predate the column; migrations
are the source of truth, and both collectors self-create the column anyway.

## THE UNIQUE KEY ON `ml_training_data` (2026-08-15) — audit findings 2, 4 and 5

`collectWeekly.js` inserted 168 rows per venue with `ON CONFLICT DO NOTHING` and
**no conflict target**, and no unique index existed for it to hit. Postgres
accepts a bare `DO NOTHING` without an arbiter, so the clause was decorative:
every re-collection stacked another full copy of the venue's week, and the log
line still read "168 rows inserted". 16.1% of (venue, dow, hour, mode) cells in
the last export held more than one row, up to 8 deep. Every average keyed on
(venue, dow, hour) — `ml_venue_baselines`, the leave-one-out baseline in
`export_training_data.js`, the category baselines — was an unweighted mean over
an uneven number of repeats.

Migration `024_ml_training_data_unique_slot.sql` fixes it. Read its header
before touching any of this; the short version:

**The survivor rule.** Duplicates differ in `busyness_pct`, `collected_at`,
`baseline_busyness`, `hour_axis` and `observed_date`, so the choice is written
down rather than left to the planner:

```
ORDER BY (hour_axis = 'venue_local') DESC NULLS LAST,   -- corrected beats legacy
         collected_at              DESC NULLS LAST,     -- newest snapshot
         besttime_epoch            DESC NULLS LAST,     -- newest vendor analysis
         id                        DESC                 -- total order
```

Collapsed, not averaged: a weekly row is BestTime's *estimate* of a typical
week, and three re-reads are one estimand sampled three times. Averaging would
invent a busyness the vendor never reported and would leave a row whose label
came from one fetch and whose weather came from another. The axis clause is
first so recency can never promote a `besttime_index` row — whose `hour` is an
array index six hours from what the column means — over a corrected one.

**The index is not the one this document specified.** The audit asked for
`(venue_id, collection_mode, day_of_week, hour, COALESCE(observed_date,
'1970-01-01'))`. That key maps every *undated* legacy realtime row of a venue-hour
onto one key, and undated realtime rows are exactly the rows the audit itself
calls "legitimately repeated across dates". Enforcing it would have deleted real
observations that carry sample weight 1.0 and whose dates cannot be
reconstructed. Two partial indexes instead:

```
ml_training_data_weekly_slot_uniq    (venue_id, day_of_week, hour)
    WHERE collection_mode = 'weekly' AND hour_axis = 'venue_local'
ml_training_data_realtime_slot_uniq  (venue_id, day_of_week, hour, observed_date)
    WHERE collection_mode = 'realtime' AND observed_date IS NOT NULL
```

The weekly one is scoped to the corrected axis for two reasons: an hour means
nothing without its clock, and **migration 023's transform is a rotation of the
168-cell week** — rows chase each other through it, so an axis-blind unique index
would reject the intermediate state and 023 would stop being re-runnable. 023
writes the shift and the axis stamp in the same UPDATE, which is what lets the
rotation pass through this index. `__tests__/mlCorpusDedupe.test.js` pins that.

**What the collectors do now.**

- `collectWeekly.js` — `ON CONFLICT … DO UPDATE`: a re-collection **refreshes**
  the venue's week in place rather than stacking. Same rule as the migration
  applied to history. Its log now distinguishes new rows from refreshed ones
  (`xmax = 0`), because "168 rows inserted" for a run that inserted nothing is
  how the missing index stayed hidden. It also de-duplicates cells within a
  single vendor response, since `DO UPDATE` raises 21000 if one statement hits
  the same key twice.
- `collectRealtime.js` — `ON CONFLICT … DO NOTHING`, and it counts and prints
  what it turned away. The asymmetry is deliberate: a weekly row is an estimate
  worth refreshing, a realtime row is an observation of one venue-hour on one
  date and overwriting it is a different act.
- **Both now write `weather_condition_code` from `weather.conditionId`**
  (finding 4) and **`month` / `season`** (finding 5). `collectWeekly` takes the
  calendar from the venue's own clock, falling back to UTC when
  `ml_venues.timezone` is unusable, because a typo'd zone must not cost a venue
  its whole week.
- Both **refuse to run** against a database where the index is missing or
  INVALID, naming migration 024. Without that, Postgres raises 42P10 once per
  venue and thousands of venues report zero rows with no stated cause.

**month / season on old rows: yes, honestly — with one thing the retrain must
not forget.** They are derived from `collected_at`, which is `DEFAULT NOW()`,
written by Postgres at insert time and never set by a caller. That is reading a
date the row already carries, not inventing one; rows whose `collected_at` is
NULL are skipped rather than guessed. Limits, stated: it is extracted in **UTC**,
so a row collected near a month boundary can land in the adjacent month
(consulting `ml_venues.timezone` would raise on the unusable zone strings 023
already refused to depend on); on a weekly row `month` means "the month the
snapshot was taken in", not "the month the busyness happened in"; and because
collection ran in a narrow window it does **not** stop `month` from proxying row
provenance. What it does fix is the impossible corner — `month = 0` with four
zero season one-hots, which `mlPredictor` can never produce.

`weather_condition_code` is deliberately **not** backfilled in SQL:
`prepare_features.py`'s `recover_weather_codes()` already derives it from
`weather_condition` for the whole corpus, and a second full-table rewrite would
have doubled the deploy's downtime to store what the exporter computes anyway.

**Deploy cost, measured.** Migrations run before `server.listen()`, so this is
closed-port time. On an embedded Postgres holding a corpus of the export's shape
(3,705,600 rows / 708 MB, 489,600 surplus weekly rows, 64.1% without a month):
024 totals **31.7s** — 26.4s for the batched dedupe and calendar stamp, 4.6s and
0.7s for the two concurrent index builds — against **38.0s** for 023's rotation
UPDATE measured the same way. Production ran all of 023 (rotation *plus* an
`ml_venue_baselines` rebuild) in 540s, which bounds the local-to-Railway factor
at 14.2x and 024 at **451s, under eight minutes**. That bound credits the whole
outage to the rotation and the rebuild was certainly most of it, so **two to
four minutes is the realistic figure**; 024 has no baseline rebuild at all. It
deletes 491,100 rows and leaves zero rows without a month.

**Not covered, on purpose:** undated legacy realtime rows (no key can prove they
are duplicates), and weekly rows still on `hour_axis = 'besttime_index'` (nothing
writes them; 023's CHECK constraint makes an undeclared weekly row impossible,
and `buildBaselines.js` refuses on a mixed-axis corpus). `database/ml-schema.sql`
and `initTables.js` do not declare either index — same standing caveat as
`hour_axis`: migrations are the source of truth.

---

## Measured results, 2026-08-15 retrain

Full numbers, method and caveats: **`MODEL-METRICS.md`** in this directory.
Read it before quoting any accuracy figure. Short version:

- Challenger beats the incumbent (MAE 29.42 vs 30.77) and beats baseline-alone
  (31.48) on the served population: live rows, usable baseline, holdout cities.
- Ship gate says DO NOT SHIP on one criterion only: an absolute floor of 29.2%
  realtime within-10, which the challenger misses at 20.6%.
- **That floor's constant is stale.** It was derived before the clock axis was
  corrected. The incumbent, measured honestly on the same rows, scores 19.3%.
  Re-derive the floor from measurement; do not lower it to admit a model.
- The 85% within-10 figure reported by training is a blend dominated by rows
  whose label equals the baseline by construction. It is not an accuracy claim,
  and `mlPredictor.js` currently publishes that family of number to users as
  venue-card confidence.

## The paid refresh runbook (2026-08-28; superseded numbers below, see the $500 plan v2 that follows)

Jayden approved buying two fresh collection windows. The order below is load
bearing; the traps it guards against are pinned in
`__tests__/besttimeRefreshPrep.test.js`.

1. **Revive the existing BestTime account** (Jayden, in the dashboard). The
   403 is account level, and the stored `besttime_venue_id`s belong to that
   account: a fresh account re-forecasts all 1,915 PA venues by name at 2
   credits instead of 1, $153 per window instead of $77. Basic metered plan,
   $0.04 per credit, $29/mo minimum. The key goes in `backend/.env` LOCALLY
   and never onto Railway: the dead BESTTIME cron service there sweeps every
   3 hours and would spend roughly $4,500/day on a metered key.
2. **Archive window 1 BEFORE the first refresh call**:
   `node scripts/ml/archiveWeeklyWindow.js` (refuses to overwrite an existing
   archive; verifies its own row count). The weekly upsert is newest-wins, so
   skipping this destroys the very drift signal the second window is bought
   to create.
3. **Window 2, now (ideally before Sept 1, so the corpus gains real summer
   rows)**:
   `node scripts/ml/collectWeekly.js --city=philly --only-found`
   `node scripts/ml/collectWeekly.js --city=lehigh --only-found`
   `--only-found` is the 1-credit by-id path and skips historical 404s that
   would re-bill at a credit per failure. About 1,915 credits, ~$77.
4. **The demand want-list, ~$7.60**: 95 distinct venues that real users were
   served, voted on, or checked into and the corpus lacks (measured off
   served_predictions/venue_votes 2026-08-28; 56.5% of all serves were such
   venues, and 69.6% of serves fell back to category curves). Add them by
   name via the normal collect path before breadth-by-category spends
   anything: they are the venues users already proved they meet.
5. **Window 3, around Nov 15**: archive again
   (`--suffix=w2`), then the same two `--only-found` runs. Ten-plus weeks of
   separation makes the windows statistically independent; that second
   interval is the precondition for dropping the `month` epoch artifact
   (see the re-admission condition above).
6. **Optional live stream**: only on the Pro Package (fixed fee, unlimited
   by-id and live), and only after `collectRealtime.js`'s PA-only default has
   shipped (it has: philly+lehigh unless `--all-cities` is passed on
   purpose).

## The $500 plan, v3 (2026-08-29, Package beats metered — see below)

Jayden's word: spend on model accuracy, budget is a guideline not a wall
("I'm ok with any... use it to the max"). Tier prices VERIFIED off the live
pricing page. Basic metered has NO live data. Pro metered is $99/mo minimum
credited to usage at $0.009/credit ($0.006 after 10K) — our month-one load
(1,915 by-id refreshes + 95 by-name adds) is ~2,105 credits, ~$19, so month
one bills the $99 floor flat and the rest buys a live pilot capped by that
floor to roughly 300 venues/night. Two negotiate-by-contact discounts exist
regardless of tier: a student/nonprofit discount and free credits for a
backlink to BestTime.app on our site.

**v2 (below, superseded) planned metered-first with a mid-October maybe-switch
to Package. That was caution earned by not knowing what a Package tier's
monthly cap actually counts. Research on 2026-08-29 resolved it: BestTime's
own API documentation states plainly that Package plans have "unlimited
forecast, live, query and venue API calls" and the monthly "unique venues"
cap governs only NEW venue admissions — a venue already on the account can be
polled by id, live-observed, and historical-queried without limit, forever,
regardless of tier size. The pricing page's own line items agree: "by ID" and
"live data" show Unlimited\* on every tier, unscaled, while only "by name"
(first-time admission) and "search by query" scale with the tier's price.
Metered has no such ceiling-free tier — its $99 floor caps usable volume at
roughly 11,500 credits/month before real marginal cost starts, and polling
the FULL 2,010-venue corpus nightly instead of a 300-venue sample would cost
metered ~$375/mo forever. The same full-corpus nightly coverage is INCLUDED
in a $119/mo Package tier at no extra charge, once a venue is admitted.**

Pro Package tiers, monthly, no lock-in (cancel or downgrade any time,
effective at the next cycle boundary, confirmed in their ToS — no annual
commitment anywhere): 1/$66, 50/$96, **100/$119**, 500/$149, 1K/$249,
5K/$399, 20K/$999.

**The one real unknown, worth a $119 test rather than a guess:** whether a
venue admitted under the EXISTING metered account carries its "already known"
status across a switch to Package, or whether Package treats every venue as
new on first touch under the new plan — undocumented publicly either way.

The allocation:

1. **September, Pro Package 100, $119.** Switch from metered (or subscribe
   fresh if metered was never completed) to the 100-tier. Immediately call
   "by id" on one already-admitted venue and check the account's usage
   dashboard for whether the new-venues-this-month counter moved:
   - **Did not move (the documented, expected reading):** admit the 95-venue
     demand want-list by name (well inside the 100/mo cap), then switch the
     nightly pilot from ~300 sampled venues to the FULL corpus, all 2,010
     venues, live-observed and historical-refreshed every night, at no
     marginal cost. This is the single biggest upgrade available in the
     whole $500 program — it removes the sampling bias that has left ~85% of
     the corpus with zero nightly observation since the pilot was scoped.
   - **Did move (the undocumented, unfavorable case):** admit only the
     highest-priority slice of the want-list this month within the 100-venue
     room, then October becomes a one-month bulk-readmit on Package 5K
     ($399) to re-admit the full 2,010-venue corpus in one cycle (well under
     its 5,000 cap), then downgrade back to Package 100 for every month
     after.
2. **October, Pro Package 100, $119** (favorable branch) **or Package 5K,
   $399, one month only** (unfavorable branch, then downgrade). Full-corpus
   nightly live pilot continues either way; the first provenance-labeled
   retrain measures whether the wider live coverage moves the gate.
3. **November, Pro Package 100, $119.** Steady state. Reassess the tier size
   once real new-venue admission volume is observed post-backlog — ongoing
   organic demand (users searching for venues not yet in the corpus) is
   likely well under 100/mo, so Package 50 ($96, cheaper than metered's own
   floor) may cover steady state just as well; downgrading costs nothing.
4. **TheSportsDB Single Developer, $9/mo for three months, $27.** Key
   acquired 2026-08-29 (`SPORTSDB_API_KEY` in `backend/.env`, confirmed a
   dedicated production key, not the shared test key). Game nights for
   Philadelphia pro and college teams, the rare signal that varies inside a
   category-day-hour cell. Scope expanded 2026-08-29 below; measured against
   the EXISTING frozen corpus first, for free, before spending a second month
   on it — cancelled if the feature earns nothing.
5. **Human ground-truth audit, ~$120.** Paid head-counts at 8-10 PA venues at
   known hours across two weekends, the only fully independent yardstick for
   the whole program.
6. **Buffer, ~$56** for a fourth Package month or an unplanned upgrade.

Total: $119 x 3 + $27 + $120 + $56 = **$560** favorable branch, **$840** if
the unfavorable case hits and a Package 5K bulk-readmit month is needed
($119+$399+$119 across September-November instead of $119 x 3). Both exceed
the original $500 line by design — the corpus-wide nightly coverage this
buys was not available on the metered plan at any price point near $500, and
Jayden's word this round was value over the ceiling. Confirm with BestTime
support before relying on it long-term: (a) whether admitted-venue status
survives a metered-to-package switch (self-answering via the September test
above, cheaper than asking and waiting), and (b) the literal fair-use limit
behind the "Unlimited\*" asterisk (their documented rate limits, 300
req/min or 200 req/10s depending which doc page, clear our whole corpus in
well under 10 minutes of wall-clock time either way — not a practical
constraint at our scale, but worth having in writing before treating it as a
permanent ceiling).

Free levers riding along: a backlink to BestTime.app in the flockcorp.com
footer (their standing free-credits offer) and one student-discount email to
their contact address, both Jayden-cheap and worth doing before September's
invoice.

## Prep status (2026-08-29 evening): everything staged, NOTHING spends until Jayden says go

Jayden's standing order, verbatim intent: get everything ready for SportsDB
and BestTime, but do not use BestTime yet. The rule in force: NO BestTime
API call of any kind without a fresh, unambiguous yes from him. State:

- **Account**: Package-100 is LIVE ($119/mo). The original "FLock" key
  (Mar 9) is dead; resubscribing did not revive it. The working key is the
  Aug 29 "MCP" key set, now in `backend/.env`. Observed and important:
  despite the dashboard's warning that venue data is tied to key sets, the
  new key resolved an old-corpus venue BY ID and refreshed it (168 rows),
  so the corpus is reachable. The usage panel then showed "Unique venues: 1"
  for that call; per the Package docs (unlimited by-id on admitted venues)
  that panel reads as an activity log, not a cap meter, and on a fixed-price
  plan a wrong reading costs nothing. Unresolved on purpose; the month-one
  test in the v3 plan settles it empirically.
- **BestTime usage so far, total**: 10 venues touched (1 test + 9 of 843
  when the philly refresh was stopped seconds after Jayden paused usage).
  All by-id refreshes of already-owned venues. Partial refresh is harmless:
  the collector upserts, and the full run redoes it.
- **Archive: DONE.** 3,454,955 weekly rows copied to
  `ml_training_data_weekly_w1` BEFORE any refresh touched the live table.
- **Want-list: validated, staged, not yet committed.** addDemandVenues.js
  (new) derives demand from served_predictions + venue_votes +
  venue_checkins, PA-only by geometry, dry-run by default. First validation
  pass: 96 candidates, 47 confirmed real and in-area, 8 out of area (demo
  serves), rest unresolved because the backend Places key rate-limited
  (429), which the script now treats as stop-and-resume, never as
  venue-dead. Finish the dry run when the Places quota window resets, then
  `--commit`, then admission waits for the BestTime go.
- **SportsDB: READY and verified live.** Migration 057 (`ml_sports_events`,
  pure CREATE) + collectSportsSchedules.js (new): resolves the five teams
  by name at runtime, pulls league season schedules, keeps games home AND
  away, arena coordinates resolved via lookupvenue.php strMap (probed live:
  Sixers arena 39.901111,-75.171944). `--verify` proved the key with one
  call and zero writes. Full pull + the free corpus ablation are the next
  moves and cost nothing but the flat $9/mo already paid.

The armed sequence, in order, once Jayden says go on BestTime:
1. finish addDemandVenues dry run, review, `--commit`
2. `node scripts/ml/collectWeekly.js --city=philly --only-found` (843)
3. `node scripts/ml/collectWeekly.js --city=lehigh --only-found`
4. `--skip-attempted` runs to admit the committed want-list by name
5. arm the nightly live pilot (infrastructure decision rides with him:
   this machine sleeps, so nightly means either his PC on a schedule or a
   deliberately created Railway cron, which is his call, not an autonomous
   one)

## user_report interlock: what actually lifts it (scoped 2026-09-01)

The queue has carried "fix the user_report lookahead leak" since 2026-08-28.
Scoped against the code, the real shape is mlFeedbackLabels.test.js's three
interlocks: (1) the crowd_level to busyness_pct MAPPING must be measured,
not defaulted, and nothing in the repo could justify one; (2) the WEIGHT
TIER must land in the same change that widens the domain; (3) the CLOCK
check (finding 13's fourth clock) on pre-021 bucket keys. The unlock for
(1) is data that starts existing the day the live pilot runs: a feedback
row paired with a same-venue same-hour live observation is a direct
measurement of what a 1, 2, or 3 means in vendor percentage terms. So this
work is sequenced AFTER two to four weeks of live pilot accumulation, as a
measurement first and an export change second. Do not lift it by guess; the
locks exist because a wrong mapping trains worse than no rows.

## SportsDB feature scope, expanded (2026-08-29)

Jayden asked to exhaust the options before any of this gets built. The
sequencing decision he made: **BestTime first.** Nothing below starts until
that's sorted; this section is the plan waiting for him, not a queue.

The one-liner above (item 7, item 4) undersold what this actually is. Full
breakdown:

**The features, strongest to weakest:**
1. Game-night flag, broadened past the original scope. "Home game nights"
   was too narrow: sports bars pack for road games on TV too, sometimes
   harder than for a mediocre home matchup. The real feature is "is this
   team playing at all tonight," home or away. Philadelphia carries five
   major pro teams (Eagles, Sixers, Phillies, Flyers, Union), so on most
   nights across a full year something is live — more signal than the
   home-only version this section used to describe.
2. Distance decay, not a binary. The lift is sharpest next to the arena and
   fades with distance, so this is a continuous feature, not on/off.
3. Beyond `is_sports_bar`. Restaurants near the stadium see pre-game and
   post-game traffic too; the original scope limited the proximity effect
   to bars alone.
4. Lehigh corridor. Our other real sub-corpus is college-town PA. Campus
   bars spike on football/basketball game days the same mechanism as pro
   teams. NCAA depth on the Single Developer tier is unverified until we're
   actually pulling data.
5. Free stadium coordinates. SportsDB's own venue records carry arena
   lat/lng, so the proximity feature does not need a hand-curated stadium
   list separately from item 8 in the enrichment list above.

**The sequencing that matters most:** SportsDB carries historical schedules,
not just future ones, so the game-night flag can be backfilled onto the
EXISTING frozen corpus's rows and ablated against the same harness GATE-B
already uses — zero new BestTime credits, no waiting for a season, a real
MAE number in days. If it's zero lift, cancel the $9/mo immediately, per
item 4 above. Only if it's real does the live daily-refresh collector and
the serving-path wiring get built. Building the live pipeline before running
this free test would be spending engineering time to find out something a
one-off backfill script answers for nothing.

**Two product uses, approved by Jayden 2026-08-29, sequenced after the
ablation proves the feature real, not before:**
- An explainability badge: "Busier than usual, Eagles play tonight" next to
  the crowd score. Near-free once the schedule pull exists, and it directly
  serves the whole point of the calibration workstream: making the one
  number legible, not just accurate.
- Birdie or Roost mentioning game nights conversationally while planning. A
  nice-to-have, not urgent — last in line.

**MEASURED 2026-08-30, the free ablation ran and the answer is NO on this
corpus.** Full pipeline: 540 games pulled (five pro teams plus Lehigh and
Lafayette football, verified live), six-column feature family in
prepare_features (market-gated at 60km), one feature build, two fits with
the shipped hyperparameters, evaluated on the PA forward slice past the
house prequential cutoff (22,533 rows, 7,544 on game nights), GATE-B's own
date-block bootstrap as judge, qmap disarmed for both sides. Result:
within-10 dead flat (CI -0.25 to +0.19pp), MAE +0.250 WORSE with sports and
the CI (+0.152 to +0.357) says the worsening is real; on game nights
specifically MAE is a full point worse; the trees ranked the six columns
85th to 95th of 101 used features with one never used; the no-harm check on
the geo holdout passed (32.000 to 31.960). Verdict line, verbatim: "no lift
distinguishable from day noise."

**Jayden challenged the verdict and the challenge was RIGHT about the
world (measured 2026-08-30, an hour after the ablation).** A direct
label-level probe, no model in the way, weekday-hour matched: PA game
nights run +7.1 points busier than the same weekday and hour without a
game, +8.9 in the evenings. The effect is real and sits in our own labels.
The reconciliation: the ablation measured whether a model trained on the
~19 days of games before the cutoff could USE the flag, and it could not,
it mislearned it. A real effect tested negative because the fit window was
data-starved, which upgrades the October retest from courtesy to expected
win and adds one more reason the BestTime resume matters (a fall corpus is
a full Eagles and college season). Probe honesty notes: the near-arena
band is unmeasurable today (213 of 30,420 PA rows sit within 3km of the
stadium complex), and sports_home_dist_km is cap-valued on non-game days
by construction, so the +7.1 is the DIFFUSE market-wide effect, TV bars
included, not the stadium-proximity effect, which remains unmeasured.

**The honest caveat, recorded so October can re-decide:** the fit side held
only ~19 days of in-market game signal (the cutoff is 2026-03-28 and the
Phillies season began 03-26), so the trees learned game nights from a thin
late-winter slice and were scored on a Phillies-dominated spring window.
The corpus that could measure this feature properly, a fall window with
Eagles and college football plus fresh live labels, does not exist yet and
only starts existing once BestTime collection resumes. Per the
pre-registered rule (item 4 of the plan: cancelled if it earns nothing):
recommend CANCELLING the $9/mo at renewal. The 540 games through Apr 2027
are already pulled and stay in ml_sports_events either way; the collector
and features stay in the tree, market-gated to zeros unless the CSV is
present; re-subscribing for a October re-test against fall live data is one
click and the same key. The explainability badge and the Birdie mention do
NOT ship, per their own gate.

**Also fixed by running this pipeline, worth more than the ablation cost:**
the first real prepare_features run since GATE-B was armed crashed at the
holdout dump because observed_date was never added to the projection's keep
list on 2026-08-28, meaning GATE-B's CI arms sat on a line that could never
execute; and the train pickle now carries observed_date too, which any
future within-market forward eval needs.

**Explicitly ruled out:** player-level signals (injuries, star-power buzz)
are too granular for this tier and this product; not worth chasing. This is
one orthogonal feature, not a substitute for BestTime's actual crowd
observations. Schedules shift (rain delays, TV-driven time changes), so past
the free historical test, a live feature needs a daily refresh, not a
one-time pull.
