# Flock crowd model: research record

Written 2026-09-05. This is the consolidated record of the research done on
the crowd model between 2026-08-13 and 2026-09-05: what the model is, what it
was trained on, what was believed about it, what was measured instead, and
what changed as a result. It is a lab notebook written for a reader. Every
number in it is copied from a document or a commit message in this repository,
and section 7 indexes those documents by path so any figure can be checked at
its source. Where two sources disagree, the number of record is
`backend/scripts/ml/MODEL-METRICS.md`.

Two rules from that file apply to everything below. Do not quote the blended
training figure (85.1% within 10 points) as the model's accuracy; it is an
artifact of the row mixture, explained in section 4.5. And do not compare a
new number to an old one across a corpus change without re-scoring the old
model on the same rows.

---

## 1. What the model is and what it predicts

**The task.** Given a venue and an hour, say how busy the venue is on a 0 to
100 scale, where 100 is the busiest that venue gets. The published output is
one integer, cut into a word: Quiet at 20 and below, Not Busy to 39, Steady to
69, Busy to 84, Packed above (`services/mlPredictor.js` `getLabel`, re-cut
2026-08-28). A single number is the product, by decision: the reasoning is
recorded beside the quantile map in `mlPredictor.js` ("the one number on the
card is the product"). Both the dispersion lab and the quantile-map addendum
argue that the durable fix for a bimodal target is a distributional output;
the decision keeps the single number, so every calibration question in this
record is a question about one number.

**Architecture.** XGBoost gradient-boosted trees (800 trees at depth 8),
exported to ONNX and served in-process by `backend/services/mlPredictor.js`,
with `services/crowdEngine.js` as the rule-based fallback. The shipped
artifact is **v2.6.0-starling**, trained 2026-08-18 on CPU with pinned threads
so that two runs produce bit-identical predictions, 106 features. The trained
artifact is not distributed with the source; everything that produced it is.

**The delta target.** The graph predicts `busyness - baseline`, not busyness.
The baseline is the venue's typical value for that day-of-week and hour, read
from `ml_venue_baselines`, which is written by exactly one statement: the
rounded average of the venue's weekly rows on the venue-local clock
(`buildBaselines.js`; `export_training_data.js` reproduces the statement
verbatim and a contract test proves the equality row by row). Serving blends
the hour with its two neighbours at 0.6/0.2/0.2, and training smooths the
same way on a complete 7x24 grid. The served score is

    score = round(clip(baseline + clamp(delta, -50, +50), 0, 100))
    then one point toward the nearer rail when score < 25 or score > 65

The training-time clamp recorded in the metadata is plus or minus 30. The
serve clamp was widened to 50 and the one-point push added on 2026-08-20
after the dispersion lab measured them (+0.26pp within-10, MAE-neutral,
section 3.10), and `quick_eval.py` scores the identical arithmetic so the
ship gate and the serve path cannot drift.

**Why a delta model, and what it cannot serve.** A weekly "typical week" row
has a label equal to its own baseline by construction, so its correct delta is
zero and it costs the model nothing. The model is trained and gated on the
population production actually serves: live rows with a usable baseline
(`is_realtime = 1 AND baseline_busyness > 0`), one predicate imported into
both `prepare_features.py` and `quick_eval.py`. A venue with no baseline row
cannot be scored by a delta model at all and is answered by the rule engine's
category curve, tagged `predictionMethod: 'rule_engine'`. A venue acquires a
baseline in exactly one way today: the BestTime collector reaches it. The
Google popular-times path exists in code and is unreachable, because the
Places API does not sell that field. A coverage counter was added on
2026-08-26 because nothing had ever counted the split; measured off served
predictions on 2026-08-28, 69.6% of serves fell back to category curves and
56.5% of serves were venues the corpus lacked (`RETRAIN.md`, refresh runbook).

**Post-processing.** A score quantile map (`CROWD_QMAP_ENABLED`) sits after
the reconstruction and before the word is chosen. It is a 41-knot monotone
lookup fitted to v2.6.0-starling's own output distribution, refuses to apply
itself to any other artifact, cannot reorder anything (zero reversals on
21,905 within-venue hour pairs and 123,051 cross-venue pairs) and creates ties
on 6.4% and 10.3% of those pairs. It has been armed by default since
2026-08-28 and its on/off is an open decision (section 6.1).

**What is published beside the number.** The confidence figure on the card is
`training_metrics_by_population.realtime_served.within_15`, which is 33.3% for
the shipped artifact. The serving path refuses to publish any confidence at
all for an artifact whose metadata has no by-population block; it reports
`confidenceMeasurement.status = 'unmeasured'` rather than inventing one. The
hour the card recommends ("least crowded") is chosen on the smoothed
popular-times curve, not on the model, and is withheld when the predicted gap
between two hours is under 10 points (section 3.11).

**The ship gate.** `quick_eval.py` writes `ship_gate` into the artifact's
metadata and `mlPredictor.init()` refuses to load an artifact whose gate
fails; the backend then serves the rule engine and logs why. The gate is
scored on the served holdout population only. Four criteria: beat the
popular-times baseline (MAE down by 5 or R2 up by 0.10), no MAE regression
against the baseline, a within-10 floor equal to the incumbent's own within-10
measured on the same rows in the same run, and no MAE regression against the
incumbent artifact. GATE-B, an either-path alternative for a candidate that
deliberately spends MAE to buy hit rate, was armed on 2026-08-28 (section
3.10). Every escape hatch is explicit, logs a warning and is recorded in the
artifact's metadata; the two that matter for reading this record are
`ML_ALLOW_NO_INCUMBENT` for a first-ever model and
`ML_ALLOW_UNKNOWN_PROVENANCE` for training on the pre-provenance corpus
knowingly.

---

## 2. The corpus

### 2.1 Sources

| source | what it contributes |
|---|---|
| BestTime, weekly | one "typical week" per venue, 168 rows, busyness on a 21-point grid of multiples of 5. These rows are the baseline. |
| BestTime, realtime | one live reading per venue-hour on a real date. Since 2026-08-15 each row records `label_source` (`live` or `forecast`) and the vendor's own forecast for the same moment (`vendor_forecast_pct`). |
| OpenWeatherMap | temperature, humidity, wind, condition code, rain flag. Since 2026-09-04 written on realtime rows only (section 3.14). |
| Ticketmaster (`ml_events`, `enrichWithEvents.js`) | nearest event distance, type, attendance estimate, counts within 2 km. Coverage is uneven and the record of where it was collected is itself a finding (section 3.11). |
| Google Places (`ml_venues`) | category, rating, review count, price level, up to three place types, coordinates. |
| Calendars (`scripts/ml/config.js`, `holidays.json`, `specialNights.js`) | holiday, school break, holiday eve, special nights across 29 scopes. |
| `venue_feedback` | in-app "how busy was it" reports. Holds 2 rows. |
| Owner slider readings | a venue's own live 0 to 100 reading, exported as `label_source = owner_report` at weight 0.10. |
| TheSportsDB (`ml_sports_events`) | 540 games for seven tracked Pennsylvania teams, ablation-only behind `FLOCK_SPORTS_FEATURES=1` (section 3.13). |

### 2.2 Size and shape

At the 2026-08-15 and 2026-08-18 runs the corpus held **3,912,357 rows:
3,454,955 weekly and 457,402 realtime, across 34,784 venues in 34 cities**,
collected between 2026-03-10 and 2026-05-18. After the whole-city holdout
split and the servable-row filter: 1,934,988 training rows (1,565,912 weekly
and 369,076 realtime served), 395,464 holdout rows in Miami, Tokyo and
Barcelona, of which 67,249 are the gate slice (live, usable baseline). On the
2026-09-03 dump the table holds 3,915,235 rows, 3,456,635 of them weekly
(88.3%), and `ml_venues` holds 34,785 rows, 22,151 with a BestTime mapping.

The two halves do different jobs. The weekly rows teach the typical pattern
and enter training at weight 0.05 as an anchor toward "most moments are
typical". The realtime rows are the only rows whose label can differ from the
baseline, the only rows the model is gated on, and by far the scarcer half:
457,402 live observations over 18,442 venues is 25 observations per venue
across 168 hourly slots, so most venue-hours have zero or one live reading.

### 2.3 Provenance, and what the corpus can and cannot say about itself

Every row carries, or was retrofitted with, a statement of what kind of row it
is. These columns are carried into the export and deliberately kept out of the
feature set:

- `hour_axis` (migration 023): whether `hour` is a venue-local hour. Every
  weekly row is on `venue_local`; a weekly insert without a declared axis is
  refused by a CHECK constraint.
- `label_source` and `vendor_forecast_pct` (migration 025): live reading or
  vendor forecast, and the vendor's forecast for the same moment. `label_provenance`
  is derived from them, and `prepare_features.py` recomputes it and refuses
  if the two disagree. **The 457,402 realtime rows collected before
  2026-08-15 are `unknown` and will stay so**: no backfill can tell a live
  reading from a forecast on them (section 3.6). Since 2026-09-04 unknown rows
  are excluded from training by default.
- `events_observed` and `events_unavailable_reason` (migration 045): whether
  the event columns are a measurement or a schema default. NULL on the whole
  pre-045 corpus, which is the honest reading of it (section 3.11).
- Unique keys (migration 024): one weekly row per (venue, day, hour) on the
  corrected axis; one realtime row per (venue, day, hour, date).
- `besttime_venue_id` unique (migration 060): one `ml_venues` row per BestTime
  venue (section 3.14).

The train/holdout split is by whole city and cross-validation is
leave-one-city-out on city; there is no row-level split anywhere. The
collection window is one spring, which is why four season flags, `is_holiday`
and the four user-feedback features are constant in the training frame and
why the climate-norm table covers March, April and May only.

Live collection restarted on 2026-09-01, scoped to Philadelphia and the
Lehigh Valley, pacing at one call a second after BestTime's abuse guard
answered the documented rate with 503s and a key-level 403. It has run on an
hourly Railway cron since early September and wrote 245 rows with clean
provenance on 2026-09-03. As of the 2026-09-04 census the corpus holds 4,223
proven-live rows, all from September 1 to 4, all Pennsylvania.

---

## 3. Chronology of findings

Each entry gives what was believed, what was measured, and what changed. Dates
are the commit dates.

### 3.1 2026-08-14: the serving path was not feeding the model what training fed it

Believed: `mlPredictor.js` built the same feature vector `prepare_features.py`
built.

Measured, in a five-round sweep (`1facbf0`, `5fdce43`, `4fff0d4`, `a64e649`):

- The exported training baseline averaged every collected row including the
  row's own label, so every delta label was computed against an anchor that
  already contained its answer.
- The feature builder read latitude and longitude off two property names no
  caller sets, so **every live prediction was computed at coordinates 0, 0**:
  astronomy wrong, latitude band wrong, every special-night feature zero.
- Training saw a venue's first three Google types; inference read the whole
  list. Google returns its generic tail types on almost every place and both
  are in the model's vocabulary, so two of thirty type features were almost
  always on at prediction time and almost always off in training.
- The event attendance estimator had drifted four branches from the function
  that labelled the corpus, all downward: a concert at an arena estimated 500
  instead of 20,000.
- The Ticketmaster window called `toISOString` on a wall-clock timestamp, so
  8 PM in Tokyo queried events at 5 AM Tokyo.
- A truthy non-numeric string in a venue field reached the input tensor as
  NaN, and a non-finite model output could ship as `score: null` labelled
  "Very Busy" with `ml` provenance.

Changed: a leave-one-out training baseline (later replaced by the weekly-only
anchor of section 1, which contains no live reading at all), coordinates read
from where callers put them, three-type
vocabulary at inference, estimator pinned byte-for-byte to the collector's,
the true instant recovered from the venue's offset, and a seven-rung fallback
ladder that lands on the rule engine with a truthful method tag. Model init
now fails closed on a feature-parity break rather than zero-filling.

### 3.2 2026-08-15: the corpus was on the wrong clock

Believed: `ml_training_data.hour` was a venue-local hour, and a dinner
restaurant reading about 20% at 6 PM was a model error.

Measured (`4d4b6c1`, `PRE-RETRAIN-AUDIT.md` section 0): `collectWeekly.js`
wrote BestTime's `day_raw` array index into `hour`. BestTime's day runs 06:00
to 05:59, so stored slot 18 was the venue's midnight, and slots 18 to 23
belonged to the following calendar day. `collectRealtime.js` wrote true local
hours into the same column, its baseline refresh averaged both clocks into one
slot, and the realtime rows' baselines were stamped six hours off. The proof
came from the shipped artifact rather than vendor documentation: its category
baselines, read literally, said restaurants peak at midday and nightclubs are
emptiest at midnight; adding six hours put **84 of the 91 (category, day)
peaks between local noon and 9 PM**.

Changed (`3b3a8a7`, migration 023): the collector writes `(slot + 6) mod 24`
and rolls the day forward for slots 18 to 23; the migration applied the same
transform to every existing weekly row in resumable batches (3,536,360 rows
corrected, per `MODEL-METRICS.md` section 7) and rebuilt `ml_venue_baselines`
from the corrected rows; production ran it in 540 seconds. A per-row
`hour_axis` records the clock and a CHECK constraint refuses an undeclared
weekly insert. `collectRealtime.js`'s drifted copy of the baseline statement
was removed, leaving one writer. No score was shifted by hand: with two clocks
in the corpus no single shift was right for both halves, so the fix went to
the data and the weights waited for the retrain (section 3.8).

### 3.3 2026-08-15: the pre-retrain audit, 21 findings, 8 blocking

Before spending a retrain, the whole pipeline was audited read-only against
the code and the checked-in artifacts (`PRE-RETRAIN-AUDIT.md`, `c1559b0`).
The blocking findings and what each corrupted:

| # | finding | evidence |
|---|---|---|
| 1 | the checked-in CSVs were a 40-column export and the runbook started after the export step, so three shipped fixes (baseline smoothing, forecast weighting, leave-one-out baseline) never reached an artifact | column count, file mtimes, `prep_v25.log` |
| 2 | `ml_training_data` had no unique constraint, so `ON CONFLICT DO NOTHING` was decorative and every re-collection stacked another copy | 16.1% of sampled venue-hour cells held more than one row, up to 8 deep |
| 3 | baseline hour smoothing was a positional `shift(1)`, so on duplicate rows an hour was smoothed against itself | code |
| 4 | `weather_condition_code` was NULL on 100% of 3,574,442 rows, so ten weather features were constant in training and dead at inference | column scan |
| 5 | 62.9% of rows carried `month = 0` with all four season flags at 0, a corner inference can never produce and a perfect proxy for row provenance | `prep_v25.log` |
| 6 | the gate scored realtime rows with no baseline, which production routes to the rule engine | code |
| 7 | no incumbent comparison existed, although the runbook said one did; the quoted "21.46 vs 22.77" win is reproducible from no script | `quick_eval.py` loaded one model |
| 8 | the gate compares `baseline + delta` to `baseline`, so an error shared by both sides cancels; v2.5 passed its R2 arm by 0.0026 and failed the MAE arm by 2.7 | `model_metadata.json` |

Changed the same day and the next (`05492dc`, `60ffb93`, `9d2c42b`,
`a8de98d`, `4a3875d`): `prepare_features.py` refuses any CSV that is not the
current export shape and fails loud on every guard that used to skip silently;
migration 024 collapsed 491,100 duplicate rows, added the two partial unique
indexes and stamped month and season from `collected_at`; smoothing runs on a
de-duplicated 7x24 grid; the weather code is recovered from the description on
the whole corpus and both collectors now write it; the gate applies the
serving mask and reports the excluded count; the incumbent is preserved and
scored on the same rows every run; the exporter, which had been running
schema-altering DDL against production, is read-only under
`default_transaction_read_only`; the ONNX export verifies feature order; and
the trainer, which would fit a leaked feature silently (a renamed baseline
column trained cleanly and reported MAE 1.97 with 95.7% within 10), now traps
it.

### 3.4 2026-08-15: the first retrain in which every stage had been verified

Believed: the previous model's reported figures described its accuracy.

Measured (`MODEL-METRICS.md`, 2026-08-15 section, `50c3e50`): the retrained
challenger, the serving model and the do-nothing floor scored on the same
67,249 served holdout rows:

| | MAE | R2 | within 10 |
|---|---|---|---|
| baseline alone (serve the venue's typical value) | 31.48 | -0.075 | 19.2% |
| incumbent v2.5.0-starling | 30.77 | -0.043 | 19.3% |
| challenger | 29.42 | +0.040 | 20.7% |

The margins are real and small. The ship gate said DO NOT SHIP on one
criterion: an absolute within-10 floor of 29.2%, a constant derived before the
clock was corrected. Measured honestly on the corrected axis the incumbent
itself scored 19.3%, so the floor had stopped meaning "do not ship something
users would be worse off with". The response was to re-derive the floor from
the incumbent's measured within-10 on the same rows rather than lower it
(section 3.8).

The same run measured the number the app was publishing. The venue card's
confidence was the training run's blended within-15 figure, computed over a
population where four of every five rows are weekly snapshots the model gets
free; the v2.5.0 metadata carried it at about 84%. On the rows production
scores, within-15 is 33.3% (`f5ef329`). The serving path now publishes the
by-population figure and refuses to publish anything for an artifact that
never measured one.

### 3.5 2026-08-15 and 08-16: within-city accuracy, and the delta layer's real worth

Believed: leave-one-city-out is the pessimistic case, so the model does better
in cities it has trained on; and buying more observations of venues already
in the corpus would improve it.

Measured (`WITHIN-CITY-EVAL.md`, `c5e9163`), on live rows in known cities
scored fifteen days forward, 103,254 rows across 30 cities, with the training
frame rebuilt and proven bit-identical over 1,934,988 rows x 106 features:

| | MAE | R2 | within 10 | within 15 |
|---|---|---|---|---|
| model (baseline + delta) | 29.02 | 0.078 | 20.7% | 30.7% |
| baseline alone | 30.23 | 0.016 | 20.4% | 29.9% |

- Within-city forward is **worse** than the LOCO 22.8%, not better.
- The delta layer is worth +0.3 points of within-10 and 1.21 MAE within-city,
  and +0.4 points on the 369,076-row LOCO population. Nobody had compared the
  model to doing nothing before; every tracked number compared it to the
  previous model.
- In Philadelphia and the Lehigh Valley, two of the three home cities, the
  layer lowered within-10 below baseline-alone (-0.2 and -1.2).
- Accuracy does not rise with a venue's live-observation depth: flat from 0
  to 199 training observations, and an unconfounded paired test on 17,322 rows
  held out by both venue and date found the model that had a venue's live
  history was 0.49 MAE **worse** on that venue than the model that had never
  seen it, at every depth band.
- Fully in-sample, the shipped model reaches only 22.2% within-10 on these
  rows: not overfitting, almost nothing to fit.

The 2026-08-16 follow-up found two causes for the negative home-city numbers.
One is a scoring artifact: 100% of served baselines are integers and 100% of
labels are multiples of 5, so an unrounded model can never land exactly on
the inclusive 10-point boundary while the baseline does on 2.3 to 3.8% of
rows. Scoring the way production serves (rounded) is worth about +1.0pp of
within-10 to any model in every city and flips Philadelphia's sign; MAE does
not move. The other is real: in Philadelphia the share of delta variance that
`(category, day, hour)` can address is 9.7% (Lehigh 15.7%, Seoul 19.9%), the
cross-fitted ceiling for that whole class of correction is +0.69pp, and the
one feature family that varies inside a cell, events, is empty there. Verdict
recorded: keep serving the model in Pennsylvania, because baseline-alone is
measurably worse on MAE and the remaining upside is under one point.

Changed: evaluation rounds to the integers production publishes (2026-08-27,
`d8cee6c`); the spending advice in section 7 of that document ("would not buy
more observations on venues already in the corpus") stands.

### 3.6 2026-08-15: nobody can say whether the live labels are live

Believed: the collector had failed to write `label_source`, and fixing it
would let the vendor-forecast downweight apply.

Measured read-only against production (`WITHIN-CITY-EVAL.md` section 9,
`5597234`): all 457,402 realtime rows carry NULL `label_source`,
`observed_date`, `hour_axis` and `besttime_epoch`, because collection ran from
March to May and stopped three months before the column existed. Two ways to
recover the distinction after the fact were tried and both are dead: the value
grid is the same 21-point grid for live and weekly values alike, and a live
row echoes the venue's weekly forecast on 5.64% of rows while deliberately
wrong slots score 5.02%, 5.07%, 6.31% and 6.89%, so the equality is chance.
**The forecast-versus-observed split is permanently unmeasurable on the
existing corpus**, and an unknown share of the residual on those rows may be
disagreement with a vendor's forecast rather than with reality.

Changed: no backfill; the rows stay `unknown`. Migration 025 puts
`label_source` and `vendor_forecast_pct` in the migration chain (they had
existed only as a side effect of the collector's own ALTER, so a database it
had not run against exported every row as `unknown` silently). The collector
reads back what it committed and exits 1 if any row is unlabelled. The
vendor's forecast rides into the export as a carried column, never a feature,
because on a forecast-sourced row it equals the label by construction
(`e61e0a0`). The export contract became 44 columns and a shorter CSV is
refused by name.

### 3.7 2026-08-16: the category-baseline leak, and the fix that nearly replaced it

Believed: the leave-one-city-out CV numbers were honest.

Measured (`6b7e823`, `RETRAIN.md` lever 2): `category_baseline` and
`refined_category_baseline` were fitted on the whole training frame, so a
held-out city had built the cells its own rows were scored against. The cheap
fix, one leave-one-city-out map computed once, was measured on a synthetic
fixture to be eight times worse than the leak it removed: 10.4 to 20.5pp of
within-10 above the honest reference against 1.4 to 2.1pp for the leak. Only a
per-fold refit is honest, and it has to aggregate on the pre-filter frame
(3,516,876 rows, not 1,934,988): aggregating after the serving filter moved the
feature on 99.9% of rows by a mean of 9.27 points, while removing the held-out
city moved it on 74.9% by 0.17. The confound was fifty-four times the effect.

Changed: `train_model.FoldCategoryBaselines` rebuilds both maps inside every
fold, and `verify_reproduces_shipped` asserts a zero-city holdout reproduces
the shipped columns bit for bit before any fold is fitted. Closing the leak
moved the reported realtime-served MAE from 27.54 to 27.542. The same day
`cold_outdoor` was found to be a Celsius threshold on a Fahrenheit column
(`f040da8`): the corpus minimum is 14.7F, so it could never fire, on either
side of the parity check. Now 41F, firing on 5,321 rows.

### 3.8 2026-08-18: v2.6.0-starling, the clock fix reaches the weights

Believed: the corrected baselines were enough. They were not: the served
weights had been trained on the bent axis and were being added to a corrected
anchor.

Measured (`MODEL-METRICS.md`, 2026-08-18 section; `503e3a9`), run twice on
purpose, once on GPU and once on CPU:

| | MAE | R2 | within 10 |
|---|---|---|---|
| baseline alone | 31.48 | -0.075 | 19.2% |
| incumbent v2.5.0-starling | 30.77 | -0.043 | 19.3% |
| **v2.6.0-starling (CPU, shipped)** | **29.42** | **+0.040** | **20.7%** |
| v2.6.0-starling (GPU, not shipped) | 29.40 | +0.040 | 20.7% |

Per holdout city, model against baseline-alone: Miami 27.54 vs 29.80, Barcelona
29.25 vs 31.46, Tokyo 31.89 vs 33.61.

The gate passed on all four criteria, with the within-10 floor now derived
from the incumbent's own measured 19.3% on the same rows
(`floor_basis = incumbent_measured_within_10_same_rows`). The old 29.2%
survives only as a fallback for a first-ever model.

Two things the artifact proves on its own. Category peaks in local 17:00 to
23:00 went from 2 of 91 curves to 53 of 91, lunchtime peaks from 35 to 9;
Friday bar 15:00 to 21:00, restaurant 14:00 to 19:00, nightclub 17:00 to
23:00, each moved by about six hours, which is the offset itself. And the CPU
and CUDA artifacts, same seed and data, differ by up to 6.80 busyness points
on the real holdout (mean 0.43, p99 2.40, every row differs), 3.4 times the
synthetic fixture's estimate; the reproducible one shipped, at a 4.7x cost in
training time (1,340s against 284s).

The same day `guessCategory` was found routing `night_club` to `bar`
(`cf820a9`). From the artifact's own Friday curves, a bar peaks at 20:00 at
52.6 and a nightclub at 23:00 at 34.9, so a nightclub was told 52.6 at 8 PM
where its cohort says 25.1, a 27-point error from the category label alone
against a model whose whole realtime MAE is 29.4.

### 3.9 2026-08-19: the model knows what month the data was collected in

Believed: `month` and the season flags carried seasonality.

Measured on real gate rows (`RETRAIN-V27-LOG.md`, CP1): the corpus is one
spring. Sweeping `month` across 1 to 12 on 500 real gate rows moves the raw
delta by 27.31 points on average (January -20.10, March -20.85, April -2.47,
May to July +6.46), against 5.92 for sweeping the hour. At month 8 the served
score correlates with the raw baseline at 0.9638 (R2 0.9290) with a
near-constant +5.45 offset. The model learned a 20-point drift across ten weeks
of collection and stored it in the calendar; `is_school_break` is a second
copy of the same artifact.

Changed: a v2.7 retrain dropped `month`, `month_sin`, `month_cos`,
`is_school_break` and the ten dead constant slots (106 to 92 features, the
first run with zero constant columns) and **failed its gate** (CP5): MAE
29.8859, R2 0.015, within-10 19.9% against the incumbent's 29.4191, 0.040,
20.7% on the same 67,249 rows. The holdout shares the collection epoch with
training, so the artifact helps on every evaluation that can currently be run.
v2.6.0-starling stayed shipped; the epoch features are re-admitted for removal
only when the corpus spans a second collection window ten or more weeks from
the first. The provenance filters from that work shipped on their own
(`4e0eb4f`).

### 3.10 2026-08-19 and 08-20: dispersion, the one free widener, and the quantile map

Believed: the model was mis-centred.

Measured (`RETRAIN-V27-LOG.md`, dispersion lab; `bb8ade3`; `857b4d1`): the
served population is bimodal. Actual sd 36.65, with 23.6% of venue-hours at 5
or below and 22.1% at 90 or above; the model's predictions have sd 21.56,
0.58 of the truth's spread. Across roughly forty post-hoc corrections (clamp
widths, affine and quantile maps in delta and score space, isotonic, banded
pushes, blends), fitted prequentially on the earliest 30% of gate dates and
scored forward on 46,101 rows, **exactly one cleared the gate**: clamp 50 plus
a one-point extremes push, +0.262pp within-10 (CI95 +0.171 to +0.365), MAE
-0.0002. Pure mean calibration collapses sd/actual to 0.29 and loses 3.6pp,
so the model is too narrow rather than mis-centred; everything that helps,
helps by widening, and everything with real magnitude costs MAE. The frontier
charges 0.16 to 0.36 MAE per point of within-10. MAE is minimised by the
conditional median of a bimodal target and within-10 by committing to a mode,
so the two metrics are opposite instructions.

The score quantile map was then built, re-derived against the reconstruction
production actually performs (clamp 50 plus push, rounded), on the same
prequential split, 2000-resample date-block bootstrap:

| | off | on | delta (CI95) |
|---|---|---|---|
| within-10 | 20.84% | 29.22% | +8.40pp [+7.17, +9.69] |
| within-15 | 30.12% | 36.42% | +6.30pp |
| within-20 | 39.08% | 43.61% | +4.53pp [+3.57, +5.55] |
| MAE | 29.976 | 33.126 | +3.15 [+2.72, +3.57] |
| sd / actual | 0.576 | 0.927 | |

Downstream, measured rather than argued from monotonicity: zero order
reversals on 21,905 hour pairs and 123,051 cross-venue pairs; ties introduced
on 6.4% and 10.3%; 54.7% of rows change band; band exactly-correct 23.03% to
31.66% while band within-one goes 60.52% to 58.71%; "Busy" or above published
on 32.4% to 49.2% of rows with a quiet-room rate of 31.3% to 35.2%; misses over
75 points 2.4% to 10.2%. With the map on, MAE is 33.13 against the
popular-times curve's 31.20 on the same rows: the model's average error is
worse than publishing the curve untouched while its hit rate is ten points
better, both true at once. It shipped behind a flag, off, and GATE-B was
drafted with each threshold derived from this measurement (+5.0pp within-10
with CI lower bound above +2.5, MAE regression at most +3.5, within-20 not
worse, monotone by enumeration, band and confidence from the mapped number).

### 3.11 2026-08-20: hour ranking, and where the event features came from

**Ranking.** Believed: even if the level is noisy, the model knows the shape of
a venue's night. Measured (`HOUR-RANKING-EVAL.md`, `5dbeb18`): inside one
venue on one night, over 31,498 non-tied hour pairs in the gate slice, the
model orders two hours correctly 62.7% of the time and the popular-times
curve alone 63.1%; a venue-block bootstrap of the difference is -0.49pp, CI95
[-0.88, -0.12], negative in every gap bucket. At a true gap under 10 points
both are a coin flip (53.2%). Picking the quietest hour from a 2-to-5-hour
shortlist is 59.2% exact against a 48.5% chance floor, and the curve alone is
59.4%. The signal is the curve's, not the model's.

Changed (`1d1b92b`): `crowdEngine.orderingAxis` ranks hours on the smoothed
popular-times curve when every candidate has one, and the recommendation is
silent below a 10-point predicted gap (it had spoken above 5). Re-measured as
a product (section 9 of that document): the shipped path speaks on 43.3% of
"go later instead of now" decisions instead of 49.9%, is right 66.98% of the
time when it speaks instead of 65.14% (+1.85pp, CI95 [+1.34, +2.35]), and
names an hour that is 16.86 points quieter instead of 14.90. Splitting the
change in half: the minimum gap is worth +2.00pp on its own; swapping the
predictor at a fixed gap is -0.15pp with an interval spanning zero. The credit
belongs to the hedge, not to the curve, and the switch shipped anyway because
it retires a claim four measurements decline to find.

**Events.** Believed: `has_nearby_event = false` meant nothing was nearby.
Measured against production (`MODEL-METRICS.md`, corpus validity finding;
migration 045): 3,688,137 rows false, 224,220 true, none NULL, and **22 of 34
cities hold zero rows with a nearby event, 2,194,300 rows, 56.1% of the
corpus**. Philadelphia alone holds 144,665 rows and not one nearby event
across the whole window, because its events were never collected into
`ml_events`. The column had been created `DEFAULT false`, so a measured
absence, an uncollected city and an untouched row all left identical bytes,
and the column carried a geographic collection artifact into a model that
already had a population confound.

Changed: migration 045 adds `events_observed` and a reason column with no
default; they stay NULL on every existing row and **no later migration may
backfill them**, because the cases are not separable. The enrichment writes
`events_observed = true` only when it searched a non-empty index for the
row's own city and date, and NULL, not 0, in every event column when it could
not. `events_observed` is carried in the export as a 45th column and never
featurised, since the shipped model has no in-distribution way to be told
"unknown". Any event feature importance quoted from the pre-045 corpus must
say that 56.1% of its negatives are unverifiable. A Ticketmaster backfill was
later measured impossible (2026-09-01): the Discovery API returned zero events
for every past window and 77 for an identical future-window control, so it
drops events once they occur.

### 3.12 2026-08-26: the climatology was one spring, and served all year

Believed: `temp_anomaly` measured a venue's temperature against its seasonal
norm.

Measured (`f0584b7`): the norms table in the metadata holds March, April and
May keys and nothing else. For any other month `climateNorm` fell through to
the mean of the whole table, 66.01F, so at band 40 (the Lehigh Valley) an 82F
August evening read as anomaly +16.0 and a 34F December evening as -25.0, the
clip floor, pinning `is_warm_anomaly_evening` at 1 on every summer evening.
Against the shipped graph the feature is worth 0.035 points on average inside
the corpus months, 0.260 in August and 2.049 in December, 7.069 at worst.

Changed: a month with no norm now yields an anomaly of 0 at serve time, which
is the centre of the trained distribution and already what an imputed
temperature produces. A retrain spanning the year fills the table in with no
code change. The coverage counter of section 1 was added in the same commit.

### 3.13 2026-08-27 to 08-31: calibration decisions and the game-night ablation

**Calibration.** The score quantile map was armed by default on 2026-08-28
(`d8cee6c`) with within-10 declared the primary metric, GATE-B armed the same
day as an either-path gate, and the word ladder re-cut for the mapped
distribution (`27781fc`). The evidence, re-measured 2026-09-01 against the
shipped artifact on the gate slice: 51.6% of served scores sat in the 41 to 80
middle against a reality that puts 24.2% there, and a score of 5 or less was
served on 2.5% of rows while 23.6% of real venue-hours are exactly that. The
first figures written for this were wrong on all four counts and were
corrected in place. Whether the map should stay on is the open decision of
section 6.1.

**Game nights.** Believed: Philadelphia game nights would be a within-cell
feature the model could use. Measured (`de1cc10`): 540 games pulled for seven
teams; six sports features market-gated at 60 km; two fits with the shipped
hyperparameters scored on the Pennsylvania forward slice past the prequential
cutoff (22,533 rows, 7,544 on game nights), GATE-B's date-block bootstrap as
judge: within-10 flat (CI -0.25 to +0.19pp), MAE 0.250 worse (CI +0.152 to
+0.357), a full point worse on game nights specifically, the six columns
ranked 85th to 95th of 101. The no-harm check on the geographic holdout passed
(32.000 to 31.960). The first ablation design was wrong and is recorded as
wrong: a geographically disjoint holdout cannot measure a market-gated feature.

Then the verdict was challenged and the challenge was right about the world
(`b8309ae`): a direct label-level probe with no model in the way, weekday and
hour matched, shows Pennsylvania game nights run 7.1 points busier than the
same slot without a game, 8.9 in the evenings. Both results hold: the effect
is real and the fit window held about nineteen days of games before the
cutoff, so the trees mislearned it. The feature family stays in the tree
behind a flag, the badge on the card states the schedule fact and is pinned
never to say "busier", and the re-test waits for a fall corpus. The
near-arena band is unmeasurable today (213 of 30,420 Pennsylvania rows within
3 km of the stadium complex), so the +7.1 is the diffuse market-wide effect.

### 3.14 2026-09-04: the corpus audit

A read-only census of the 2026-09-03 production dump, verified claim by
claim, found that the corpus asserted several things nobody had measured.

**Weekly rows carried one instant's weather across 168 hours** (`411f9d7`).
`collectWeekly.js` fetched current conditions once per venue and wrote
temperature, humidity, wind, condition, code and rain flag from that reading
onto every row of the venue's typical week. All six are shipped features, and
weekly rows are 88.3% of the corpus (3,456,635 of 3,915,235), so most of what
the model had ever seen under "temperature" was the temperature when a batch
happened to run. Within a venue the value is constant across all 168 hours, so
it cannot encode the hour or the season; it encodes which batch wrote the
venue, a line from venue identity to collection time, which is the leakage
shape the overfitting doctrine exists to keep out. The trainer made it worse:
its fill gave a missing reading the city-month median, so one temperature per
venue-batch on 18,621 of 18,621 venues, and it fitted the climate norms from
the filled column, moving them by up to 3.56F (`60131b1`). Changed: weekly
rows carry NULL weather; the collector makes one fewer API call per venue;
norms are fitted from observed readings only and a missing reading takes the
band-month norm serving would impute, with `weather_unknown` set;
`repairWeeklyWeather.js` clears the rows already written, batched by primary
key so it never holds a long lock under the hourly cron, and was run on
2026-09-05. The suite that had pinned the collector stamping a weather code
was pinning the defect and was inverted.

**933 duplicate venues from a pseudo place id** (`ceb48bd`, `018efc4`,
`7e3763a`, migration 060). `discoverBestTime.js` received a BestTime venue id
and no Google place id, minted `bt_<id>`, and upserted on `google_place_id`,
the only unique key `ml_venues` had. A venue already stored under its real
place id got a second row carrying the same `besttime_venue_id`. On the dump:
933 BestTime ids held by 1,871 rows; 909 groups contain a `bt_` row; 111
groups are active Philadelphia and Lehigh venues, so the hourly cron paid two
credits and wrote two rows per building; one shopping park existed as a
`park` with no rating and a `mall` with 4.4 stars and 9,880 reviews, both
given 168 identical weekly rows by the same run. The exporter joins
`ml_venues`, so every per-venue mean and category baseline counted such
buildings twice. The remaining groups are two different real Google places
that BestTime's matcher resolved to one venue; the repair unmaps those rather
than deleting a real venue (25 groups by the repair's final report, `018efc4`;
the migration's header counted 24). The keeper rule was corrected before the
commit: review count outranks recency, because which listing people use is
evidence and which row a sweep touched last is not; under the first rule a
16-review stub was keeping the mapping over a 144,231-review landmark. Changed:
`besttime_venue_id` is the arbiter with a partial unique index, built by the
migration where no duplicates exist and by the repair on production; one
advisory lock is shared by the repair and both collectors so a live insert can
never land between a move and a delete; rival rows lose the weekly and
realtime rows bought under the shared id. The two-head run of section 3.15
trained on the post-merge corpus.

**`review_count` was zero-filled while `rating` was median-filled** (`ceb48bd`,
migration 060). Zero is the minimum of the range and means "nobody has ever
been here", so a venue with no Google data was described to the model as
average-rated with no reviews, a learnable signature for the collection path
rather than the venue. `ml_venues.review_count` also carried `DEFAULT 0`; the
migration drops it and NULLs the 1,741 fabricated zeros on `bt_` rows with no
rating, keeping the 186 rows where Google measured zero. The trainer now
imputes the median and publishes `median_review_count`. Serving follows the
artifact rather than the trainer: v2.6.0-starling was trained on the zero fill
and keeps it, and the first artifact carrying the key flips the branch, with
`??` rather than `||` so a measured zero survives.

**Event attendance was written as a measured zero when unpublished**
(`b76d803`, `0df339c`, `73c0374`). `nearest_event_attendance` was
`event_size || 0`, and Ticketmaster publishes capacity for almost nothing, so
every live event detection wrote "an event within 2 km with nobody at it":
all 1,052 such rows in the corpus. The weekly INSERT named four of the seven
enrichment columns, so 201,796 of the 202,440 weekly rows stamped
`no_observation_date` carried a measured attendance of zero beside three NULLs
and an honest `events_observed = false`, the exact pairing migration 045 was
written to end, recreated on every insert. The collector's event lookup had no
date window and a 5 km radius where the corpus and serving use 2 km, so a
concert next Saturday stamped a Tuesday afternoon; and every row in a sweep
carried the clock read when its city block began, on sweeps that ran up to
fifty-eight minutes, so the tail of a run was filed under the previous hour
and differenced against the wrong baseline cell. Changed: three states for
attendance (measured zero, NULL unpublished, NULL not looked up); all seven
columns written explicitly, pinned by name; 2 km and a window opening three
hours before the observed hour; each row reads its own clock; `enrichWithEvents.js`,
which rebuilds from a table ending in May, is scoped away from realtime rows.

**Event types outside the model's vocabulary** (`60131b1`, `73c0374`).
`eventService.js` returned `concert` and `film` while the model's one-hots are
`music`, `sports`, `arts`, `family`, `other`. Harmless while it fed a column the
feature list excludes; from 2026-09-01 the collector copied it into
`nearest_event_type` on 1,964 live rows, which trained as `has_nearby_event = 1`
with all five type slots zero, a row that exists nowhere else in the corpus.
Changed: one vocabulary in three files pinned equal, `concert` aliased to
`music` and `film` to `other`, any other value refused by name, and the
exporter censuses the column before every run.

**Unknown provenance is not a live label** (`60131b1`). The guard meant to stop
a corpus training with every label marked `unknown` tested the whole frame
against exactly `['unknown']`; weekly rows are stamped `weekly`, so the raise
was unreachable, and once live collection restarted the weight-1.0 pool would
have been 99% rows that cannot be told from a vendor forecast. Changed: the
457,402 unknown rows are excluded from both frames by default;
`ML_ALLOW_UNKNOWN_PROVENANCE=true` admits them and the artifact records it.
The honest consequence: 4,223 proven-live rows today, below the trainer's
50,000-row floor, and a holdout with no live rows at all, because live
collection is Pennsylvania-only. The blanket `fillna(0)` over the feature
matrix is gone in the same commit; every feature has a named fill and an
unfilled column stops the run. `is_realtime` is recorded as the one remaining
perfect batch signature in the matrix.

**The gate had two holes and the artifacts disagreed** (`872683e`, `00a0445`).
GATE-B tested the incumbent comparison's status rather than its pass flag, so
it could admit a run on a comparison the comparator had rejected; the
challenger's feature order was read out of the pickle and thrown away, so a
permuted vector could decide a model's fate; and the three artifacts on disk
carry 92, 112 and 106 feature columns respectively, so scoring
`train/best_model.pkl` against `train/features_holdout.pkl` is meaningless.
`quick_eval.py` reads the flag, refuses a permutation naming the first
divergence, and refuses the mismatched pair.

**The shipped model does beat the curve** (`00a0445`, `MODEL-METRICS.md` band
comparison). A research pass had concluded the opposite and recommended
routing the served population back to the venue's curve. It had trained a
fresh delta regressor on the holdout pickle and labelled the stand-in
"current". Scoring the shipped ONNX file directly against the prepared
holdout, on the ladder `crowdEngine` cuts at, reproduces the recorded 29.42
MAE to two decimals first and then finds the model ahead on every column
(table in section 4.2). Recorded so the conclusion is not reached a second
time from the same starting point.

**Three baseline zeros, one tag** (`66a6e91`). `getBaseline` returned 0 for no
row, a refused lookup and a thrown query, and all three were counted as
`rule_engine_no_baseline`, the claim about the corpus that the coverage panel
exists to make. A database wobble read as "the collector has not reached
these venues". Split. `ml_venue_baselines.updated_at` had also only moved when
the average changed, so a stable venue confirmed weekly was marked stale for
being stable; it now carries the newest evidence under the average.

### 3.15 2026-09-05: the two-head candidate

Believed, and worth testing: a profile head trained on weekly rows plus a
deviation head trained on live rows would let every row do the job it can do,
with no weekly row shrinking the deviation head.

Built (`82fe433`): `train_two_head.py`, `eval_two_head.py`,
`run_two_head.sh`, and a dormant two-head serving path behind
`metadata.label_type`. Both sides read from ONNX; the shipped side reproduces
its recorded gate (29.4191 MAE) to four decimals before anything is claimed;
quantile map off on both sides. An ablation showed a squared-error deviation
head compresses (sd 16.3 against 22.2) and trades hit rate for MAE, so the
candidate uses `reg:absoluteerror`. The owner's three conditions: ship only if
within-15 and point MAE beat the shipped model on the served population and
band exact does not fall.

Measured (`MODEL-METRICS.md`, two-head section), deviation head trained on
the 4,223 proven-live rows only, served holdout 67,190 rows on the post-merge
corpus:

| model | band exact | off-by-1 | band MAE | point MAE | w10 | w15 |
|---|---|---|---|---|---|---|
| curve untouched | 22.29 | 55.78 | 1.3465 | 31.478 | 19.2 | 28.4 |
| shipped v2.6.0-starling | 25.41 | 60.34 | 1.2560 | 29.369 | 21.9 | 31.4 |
| shipped + score qmap (as published) | 33.00 | 57.40 | 1.3678 | 32.580 | 29.3 | 36.6 |
| candidate, clean labels | 19.72 | 56.87 | 1.3354 | 30.962 | 17.9 | 26.7 |

Deltas against the shipped model: MAE +1.59 [+0.86, +2.45], within-15 -4.7pp
[-6.3, -3.3], band exact -5.7pp [-7.2, -4.4]. All three conditions fail. A
deviation head that has seen 1,544 to 4,223 rows cannot beat one that saw
388,617, and that is the whole result: the clean label supply is the limit,
not the design.

The same design with the unknown-provenance pool admitted, on the same 67,190
rows, recorded so the ceiling is visible and explicitly not the verdict: band
exact 27.93, off-by-1 61.97, band MAE 1.2195, point MAE 28.493, within-10
23.8, within-15 34.1; against the shipped model MAE -0.88 [-1.27, -0.51],
within-15 +2.7pp [+1.4, +4.1], band exact +2.5pp [+1.1, +4.1], all intervals
excluding zero. The pre-merge corpus gives the same picture (MAE 28.470 vs
29.385, within-15 34.2 vs 31.4, band 28.21 vs 25.33).

**A diagnostic that is not the gate.** On the one forward slice of proven-live
labels (2,679 rows, 2026-09-04, Pennsylvania, held out of all training, one
date so no bootstrap): curve untouched MAE 25.918 and within-15 40.0; shipped
model 28.241 and 32.0; candidate 24.689 and 40.9. On the only labels known to
be a room, the shipped model scores worse than publishing the curve. One date,
one state; it is re-measured in October before anything is concluded from it.

Decision: keep v2.6.0-starling serving; re-run `bash train/run_two_head.sh`
at the mid-October retrain, when roughly 100,000 proven-live rows should
exist. Today the strict prepare refuses at its 50,000-row floor, and that
refusal is the correct answer.

---

## 4. The current state of accuracy on the served population

All figures are for v2.6.0-starling on the geographic holdout (Miami, Tokyo,
Barcelona), live rows with a usable baseline, unless stated.

### 4.1 Point accuracy (67,249 rows, `MODEL-METRICS.md` 2026-08-18)

| | MAE | R2 | within 10 |
|---|---|---|---|
| baseline alone | 31.48 | -0.075 | 19.2% |
| incumbent v2.5.0-starling | 30.77 | -0.043 | 19.3% |
| **v2.6.0-starling** | **29.42** | **+0.040** | **20.7%** |

| city | model MAE | baseline MAE | gain | within 10 |
|---|---|---|---|---|
| miami | 27.54 | 29.80 | +2.26 | 23.6% |
| barcelona | 29.25 | 31.46 | +2.21 | 20.9% |
| tokyo | 31.89 | 33.61 | +1.72 | 16.9% |

Crossing zero on R2 is the part that matters: v2.6.0 is the first version
whose predictions carry more information than the mean of the data. Both
margins are real and both are small.

### 4.2 Band accuracy, the ladder the card actually publishes (2026-09-04)

Scored by running `models/crowd_model.onnx` directly against the served rows
with the production clamp, on the 20/40/70/85 ladder; point MAE at the
metadata's clamp reproduces 29.42 to two decimals.

| candidate | band exact | band off-by-1 | band MAE | point MAE | within 10 |
|---|---|---|---|---|---|
| publish the venue's curve untouched | 22.9% | 57.7% | 1.315 | 31.48 | 19.2% |
| **shipped v2.6.0, production clamp 50** | **25.5%** | **62.0%** | **1.230** | **29.35** | **20.7%** |

The 2026-09-05 two-head table (section 3.15) re-scores the same population
after the duplicate-venue merge, rounded to the integers production publishes,
with the quantile map both off and, in the "as published" row, on. Read the
two tables as the same measurement under slightly different conditions, not as
a change in the model.

### 4.3 Within-city, forward in time, the cities the product serves

Within-10 20.7% and MAE 29.02 on 103,254 live rows across 30 known cities
scored fifteen days forward (unrounded; about a point higher rounded), against
20.4% and 30.23 for the baseline alone. The dinner (17 to 20) and evening (21
to 23) bands are the worst measured, at 20.0% and 18.0% within-10, and the
bands the model improves least (+0.96 and +0.87 MAE).

### 4.4 Ordering, and what the card is allowed to say

When the card names a quieter hour, that hour is genuinely quieter 66.98% of
the time, it speaks on 43.3% of decisions, and the hour named is 16.86 points
quieter on average. The ordering comes from the popular-times curve; the
0 to 100 number beside it is the model's, and the model is the half that wins
on level. What Flock cannot say is that the model figured out the venue's
rhythm. It did not; the rhythm is the vendor's curve, and the product stopped
overwriting it on 2026-08-20.

### 4.5 The number that is not an accuracy claim

| population | rows | MAE | within 10 |
|---|---|---|---|
| all rows (the blend) | 1,934,988 | 6.89 | 85.1% |
| weekly anchor rows | 1,565,912 | 2.02 | 99.8% |
| **realtime served** | **369,076** | **27.54** | **22.8%** |

Four of five training rows are weekly rows whose correct delta is zero by
construction. The blend measures how many easy questions were on the test.
The confidence figure the serving path publishes is the realtime-served
within-15, 33.3%, and nothing else.

### 4.6 What the shipped model has never been scored on

Every accuracy number above is measured on rows of unknown provenance from
March to May 2026, which cannot be separated into live readings and vendor
forecasts. The only proven-live labels are the 4,223 Pennsylvania rows
collected since 2026-09-01, and on the one forward day of them the shipped
model scored worse than the untouched curve (section 3.15). That is one date
in one state and is not a verdict, but it is the reason the October retrain
matters more than any change made so far.

---

## 5. What the research established about the problem itself

These are the conclusions that survived every re-measurement, stated once.

1. **Generalisation across cities is fine; local prediction is the weak part.**
   Leave-one-city-out R2 0.653 against a geographic holdout of 0.772 on the
   blend, and the model transfers to cities it has never seen. What it cannot
   do well is say how a specific venue deviates from its own pattern on a
   given night, because that is learned only from repeated observation of
   that place and the corpus holds 25 live readings per venue across 168
   slots.
2. **The delta layer earns a real but small margin.** About 2 MAE and 1.4pp
   of within-10 over the untouched curve on the holdout; +0.3pp within-city
   forward. It should not be described as the reason the product's numbers
   are good.
3. **The target is bimodal and one number cannot sit near both modes.** A
   quarter of served venue-hours are at 5 or below and a quarter at 90 or
   above. MAE and within-10 give opposite instructions, the frontier between
   them is measured (0.16 to 0.36 MAE per point), and no post-hoc calibrator
   escapes it. The single number stays by decision, so the trade is chosen,
   not solved.
4. **More of the same data does not help.** Depth of live observations on a
   venue already in the corpus is measured to make the model slightly worse on
   that venue. Breadth of signal that varies within a (category, day, hour)
   cell is what is missing, and the corpus has one such family, events, whose
   coverage is itself a collection artifact.
5. **The label supply, not the model shape, is the limit.** The two-head
   design wins with intervals clear of zero when it is allowed the unknown
   pool and loses when held to proven-live labels, because the proven pool is
   4,223 rows against 388,617.
6. **Most of the work was making the numbers trustworthy.** The clock axis,
   the duplicate rows, the leaked baseline, the category leak, the stale
   floor, the missing incumbent comparison, the fabricated weather and event
   values: any one of them invalidated a measurement, and the accuracy
   figures before 2026-08-15 are reproducible from no script.

---

## 6. Open questions and the decisions behind them

### 6.1 The quantile map: on or off

Armed by default on 2026-08-28 with within-10 declared the primary metric.
The 2026-09-04 addendum to `QMAP-DECISION.md` records four things the
original page did not know: band within-one regresses (60.52% to 58.71%)
while band exact improves, so a distance-weighted ordinal score sees the map
as a wash or a small loss; for an unbiased forecast with the gate slice's
R2 of +0.040 the implied correlation is about 0.33, the squared-error-optimal
spread ratio is that same 0.33, the unmapped forecast already sits at 0.588
and the map takes it to 0.927, roughly 2.8 times optimal, with an estimated
mapped R2 of about -0.25 against -0.075 for the curve untouched; with the map
on, MAE is 33.13 against the comparator's 31.20, which closes the legacy
admission path and leaves a gate arm the last real retrain missed by 3.5
points, so the next honest retrain is refused by arithmetic; and the word
ladder was re-cut for the mapped distribution but is applied to all five
exits, of which the unmapped category curve serves about 70%, so a corpus
venue and its equally full neighbour outside the corpus can print different
words. The literature on inflating a deterministic forecast to match observed
variance is cited there. The recommendation recorded is off. The decision is
the owner's, was not reversed by the research, and two free measurements
settle the R2 question: run the gate once each way and compare `ship_gate.r2`,
and score the bands under a distance-weighted metric on the same 46,101
forward rows. The "as published" row of the section 3.15 table (within-10
29.3, band exact 33.00, MAE 32.580) is the current measurement of the map on.

### 6.2 Which cities to hold out

Miami, Tokyo and Barcelona have no proven-live rows and live collection is
Pennsylvania-only, so under the default provenance rule the gate has nothing
live to measure. Two honest options: wait for October as planned, with roughly
100,000 more proven rows by then, still Pennsylvania; or re-choose the holdout
to include a Pennsylvania slice so the gate can measure live accuracy at all.
Nothing needs to happen before October; the decision is recorded here so it is
made deliberately rather than by whoever next runs `prepare_features.py` with
the override flag.

### 6.3 The mid-October retrain

Decided 2026-09-05. Volume is not the lever: 88% of the corpus is typical-week
curves. What makes October the first retrain that can move the product is
that every live row written after the 2026-09-04 fixes carries honest event
and weather features, that the climate-norm table will finally hold an autumn
month, and that the two-head candidate is re-run in the same pass (one
command, `bash train/run_two_head.sh`, under the same three conditions).
Preconditions: the weekly-weather repair has run, and the duplicate-venue
merge has run. Also due in the same pass: the game-night feature re-test
against a fall corpus with a full football season, and the epoch-feature
question of section 3.9, which needs a second collection window ten or more
weeks from the first before `month` can be dropped honestly.

### 6.4 Still open, with the reason

- **Event features.** The pre-045 corpus carries an unquantified negative-event
  leak in 56.1% of its rows and it cannot be repaired. Real general event
  features come only from forward accumulation; `collectEvents.js` is wired
  into nothing today and putting it on a cadence is a decision for when
  collection economics are settled.
- **User crowd reports.** `venue_feedback` holds 2 rows, and `user_report`
  labels stay interlocked out of training until the crowd-level to
  percentage mapping has been measured against same-venue same-hour live
  observations, which needs weeks of the live pilot first. A wrong mapping
  trains worse than no rows.
- **Climate norms.** Dead outside March to May until the corpus holds more
  months; serve-side anomaly is 0 in those months rather than fabricated.
- **`is_realtime` in the feature set.** The one remaining perfect batch
  signature in the matrix, enumerated and carried as a key so its readers can
  migrate off it.
- **The delta layer's place.** Within-city it is worth a third of a point of
  within-10 over the curve. Whether the two-head design replaces it is the
  October question.

---

## 7. Index of the detailed documents

| path | what it holds |
|---|---|
| `backend/scripts/ml/MODEL-METRICS.md` | The numbers of record: the 2026-08-15 and 2026-08-18 retrains, the ship gate derivation, the CPU/CUDA gap, the clock-axis proof in the artifact, the event-provenance finding, the 2026-09-04 band comparison, the 2026-09-05 two-head verdict |
| `backend/scripts/ml/RETRAIN.md` | The retrain runbook, what `prepare_features.py` refuses, the ship gate and GATE-B, the audit status board, the hour-axis and unique-key changes, the collection runbooks, the game-night scope and ablation |
| `backend/scripts/ml/PRE-RETRAIN-AUDIT.md` | The 2026-08-15 read-only audit: 21 findings, 8 blocking, with evidence per finding. Not edited after the fact; `RETRAIN.md` carries the status |
| `backend/scripts/ml/WITHIN-CITY-EVAL.md` | Within-city forward accuracy, the depth hypothesis and its refutation, the paired familiarity test, label provenance, and why Philadelphia and Lehigh measure the way they do |
| `backend/scripts/ml/HOUR-RANKING-EVAL.md` | Within-venue hour ordering, the quietest-hour pick, the null control, and the re-measurement of the path that shipped on 2026-08-20 |
| `backend/scripts/ml/train/RETRAIN-V27-LOG.md` | The v2.7 attempt checkpoint by checkpoint: the epoch figures reproduced on real rows, the feature drops, the dispersion lab grid, and the gate that refused it |
| `backend/scripts/ml/train/QMAP-DECISION.md` | The quantile map in cards out of a hundred, what it buys and what it costs, and the 2026-09-04 addendum with the four facts and the literature |
| `backend/scripts/ml/train/prepare_features.py` | The corpus contract, the fills and their arguments, provenance exclusion, feature selection |
| `backend/scripts/ml/train/export_training_data.js` | The read-only export, the baseline definition that is the number production serves, the carried columns |
| `backend/services/mlPredictor.js` | The serving path: reconstruction and clamp, the quantile map, the baseline lookup and its history, the coverage counter, the confidence figure |
| `backend/migrations/023_backfill_ml_weekly_local_hours.sql` | The clock rotation |
| `backend/migrations/024_ml_training_data_unique_slot.sql` | The unique keys and the duplicate collapse |
| `backend/migrations/025_ml_label_provenance.sql` | `label_source` and `vendor_forecast_pct` |
| `backend/migrations/045_ml_event_provenance.sql` | `events_observed`, and why no migration may backfill it |
| `backend/migrations/060_ml_venues_besttime_identity.sql` | One venue per BestTime id, and `review_count` without a default |
| `backend/scripts/ml/models/README.md` | How to train an artifact from your own data |

The commit messages on the files above, from 2026-08-13 onward, are written as
findings and are the primary record for anything dated in section 3 that a
document above does not carry.
