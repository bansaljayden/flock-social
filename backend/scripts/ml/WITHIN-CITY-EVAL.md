# Within-city evaluation of the crowd model

**Question.** How accurate is the crowd model on the population it actually
serves, in cities it has already seen?

**Answer.** Worse than the leave-one-city-out number, not better. On live rows
in cities and venues the model knows, scored fifteen days forward in time, it
gets **within-10 20.7%** (MAE 29.02). The reported LOCO figure of 22.8% was not
a pessimistic worst case. It was, if anything, the optimistic end.

**And the finding that matters more.** Serving the venue's popular_times
baseline alone and predicting no deviation at all gets **within-10 20.4%** (MAE
30.23) on those same rows. The entire delta layer is worth **+0.3 points of
within-10 and 1.2 MAE**. On the same 369,076-row population the LOCO model is
scored on, baseline-alone gets MAE 29.23 / within-10 22.4% against the model's
27.54 / 22.8%, so the delta layer buys +0.4 points there too. That comparison
had never been computed. Every number the retrain doctrine tracks compares the
model to the *previous model*; nothing compared it to doing nothing.

Method, evidence and the spending consequences follow. Everything under
"Measured" is a number this run produced. Everything under "Inferred" is a
judgement built on those numbers and labelled as such.

---

## 1. What was run

`scripts/ml/train/within_city_eval.py`. Read-only against `train/` and
`models/`; all output, including four refitted models, goes to a scratch
directory. CPU pinned (`FLOCK_TRAIN_DEVICE=cpu`), `FLOCK_TRAIN_THREADS=12`,
`random_state=42`, the same twelve threads and seed
`metadata.training_environment` records for the shipped artifact. xgboost 3.2.0,
Python 3.14.3. Six measure-then-re-audit rounds; the three that changed a
conclusion are in section 7.

**The evaluated population** is `serving_population_mask(baseline) &
is_realtime`, imported from `prepare_features.py`. It is the predicate
prepare_features filters *training* with and `quick_eval.py` gates on. It is not
re-implemented anywhere in the new script, and `__tests__/withinCityEval.test.js`
fails if a second definition ever appears.

**Predictions** are `clip(baseline + clip(delta, -30, 30), 0, 100)`, the
reconstruction `services/mlPredictor.js` performs, unrounded so the numbers stay
comparable to `quick_eval.py`. Baseline-alone is `clip(baseline, 0, 100)` on the
identical rows, produced inside the same function from the same index array, so
the two predictors can never be scored on different populations.

### The refit, and why there had to be one

`best_model.pkl` is a full-frame fit. Every training row is in-sample for it, so
it cannot be scored within-city at all. Each split below refits from scratch
with the shipped recipe (`FIXED_PARAMS`, verified against `train_model.py` by a
unit test) on its own training side.

### Row alignment, proven rather than assumed

`features_train.pkl` carries no `venue_id` and no `observed_date`, and they
cannot be recovered by reading `training_data.csv` alongside it: `main()` drops
rows for null labels, always-zero venues and zero baselines, so a positional zip
of the two files is precisely the misalignment audit finding 10 caught in
`evaluate_model.py`. The frame is therefore rebuilt by replaying
`prepare_features`' own transforms in `main()`'s order, and the rebuild is
proven correct rather than trusted:

```
rebuild verified: X bit-identical over 1,934,988 rows x 106 features
  row_count_matches   true      y_actual_identical   true
  feature_cols_match  true      baseline_identical   true
  X_bit_identical     true      sample_weight_identical true
                                cities_identical     true
```

`np.array_equal` on the float32 matrices, not a tolerance. Because X is
identical row for row, the `venue_id` and `observed_date` columns riding
alongside are aligned to it by construction.

### The one label-derived feature, refitted per split

`category_baseline` and `refined_category_baseline` are means of `busyness_pct`.
`prepare_features` fits them on the whole training frame; this is the open leak
`metadata.training_contracts.known_residual_leak` documents. Left alone, every
held-out row's own label would sit inside its own feature. Both are refitted per
split on the training side only, through `build_category_baseline_maps` (same
function, same 0.6/0.2/0.2 hour smoothing, same fillna chain), and both train
and test rows are rewritten with the refitted values.

No other feature touches a label. Neighbour features and `smooth_baseline_hours`
are built from `baseline_busyness`; climate norms and venue medians use no
label; the four user-feedback features are constant across this corpus. And
`baseline_busyness` itself is built by `buildBaselines.js` from **weekly rows
only**, so it contains no live observation, not the row's own and not another
date's.

---

## 2. The splits

| split | train side | test side | disjoint on |
|---|---|---|---|
| **date** (headline) | realtime ≤ 2026-05-03 + all weekly | realtime 2026-05-04 .. 05-18 | `observed_date`, 53 vs 15 keys, 0 shared |
| **scattered_date** (control) | all but 15 seeded dates | those 15 dates, spread over the full window | `observed_date`, 53 vs 15 keys, 0 shared |
| **venue** (control) | all rows of 14,892 venues | live rows of 3,121 held-out venues | `venue_id`, 0 shared, **0 shared venue-hour cells** |
| **venue_with_anchor** (mechanism probe) | as above + held-out venues' weekly rows | same 3,121 venues | `venue_id` over live train rows, 0 shared; 0 live rows of held venues in train |

Every split asserts three things before it is scored: no row on both sides, no
key on both sides, and (for the venue splits) no `(venue, dow, hour)` cell on
both sides. A random row split was never on the table: a venue-hour cell holds
up to eight rows, so it would score a venue against its own neighbours.

**The date split shares 100,846 venue-hour cells between sides, deliberately.**
The same venue observed live on two different dates is exactly what production
faces. With `venue_id`, `latitude` and `longitude` all excluded from the feature
set, no feature carries a per-venue history of live readings, so this is not
label leakage; it is the model being allowed to recognise a venue from features
production also has. The venue split, which shares zero cells, is the control
that prices that advantage, and section 5 shows the advantage is negative.

---

## 3. Measured: the headline

**Within-city, fifteen days forward, live rows the product would serve.**
103,254 rows across 30 cities.

| | MAE | RMSE | R² | median AE | within-5 | within-10 | within-15 |
|---|---|---|---|---|---|---|---|
| **model** (baseline + delta) | **29.02** | 35.50 | 0.078 | 25.69 | 10.8% | **20.7%** | 30.7% |
| **baseline alone** (delta = 0) | 30.23 | 36.69 | 0.016 | 27.00 | 10.8% | **20.4%** | 29.9% |
| improvement | +1.21 | +1.19 | +0.063 | +1.31 | 0.0 | **+0.3 pp** | +0.8 pp |

The model is closer than the baseline on 60,289 rows and further on 42,932: it
wins 58% of coin flips, and the win is small enough that within-5 does not move
at all.

**All four splits, against the same floor:**

| split | rows | model MAE | base MAE | ΔMAE | model W10 | base W10 | ΔW10 |
|---|---|---|---|---|---|---|---|
| date (forward, production-shaped) | 103,254 | 29.02 | 30.23 | +1.21 | 20.7% | 20.4% | **+0.3** |
| scattered_date (interpolated) | 103,254 | 27.84 | 28.67 | +0.83 | 22.2% | 22.6% | **−0.4** |
| venue (unseen venue) | 75,711 | 26.78 | 29.03 | +2.25 | 24.0% | 22.7% | +1.3 |
| venue_with_anchor | 75,711 | 26.79 | 29.03 | +2.24 | 24.0% | 22.7% | +1.3 |

**Reference, computed on the same 369,076 rows LOCO reports on:**

| | MAE | R² | within-10 |
|---|---|---|---|
| LOCO model (`metadata.training_metrics_by_population.realtime_served`) | 27.54 | 0.127 | 22.8% |
| baseline alone, same rows | 29.23 | 0.031 | 22.4% |
| improvement | +1.69 | +0.096 | **+0.4 pp** |

So the delta layer is worth roughly a third of a point of within-10 in every
regime measured: +0.4 when the city is unseen, +0.3 when the city and venue are
seen and the date is future, and **−0.4** when the city and venue are seen and
the date is interpolated.

### The number that rules out "it just needs more capacity"

The **shipped** `best_model.pkl`, scored on the forward test rows it was
literally fitted on, reaches MAE 27.71 / within-10 **22.2%**. Fully in-sample,
allowed to memorise, on 800 trees at depth 8, it cannot get past 22.2%. The
honest refit gets 20.7%. A 1.5-point in-sample-to-honest gap on a 1.9M-row fit
is a model that is not overfitting. It is a model with almost nothing to fit.

---

## 4. Measured: breakdowns

### By city (forward split; all 30 measured, focus cities in bold)

| city | rows | model MAE | base MAE | ΔMAE | model W10 | base W10 | ΔW10 |
|---|---|---|---|---|---|---|---|
| nyc | 6,894 | 30.16 | 31.45 | +1.29 | 18.9% | 18.5% | +0.4 |
| london | 5,404 | 31.51 | 32.37 | +0.86 | 17.8% | 18.3% | −0.5 |
| **la** | 5,175 | 27.87 | 29.00 | +1.12 | 21.6% | 21.5% | **+0.1** |
| mexico | 4,922 | 23.95 | 25.74 | +1.80 | 27.8% | 25.5% | +2.3 |
| seattle | 4,798 | 29.03 | 30.32 | +1.29 | 20.6% | 19.3% | +1.3 |
| chicago | 4,568 | 29.47 | 30.65 | +1.19 | 18.3% | 18.6% | −0.3 |
| **philly** | 3,675 | 32.04 | 33.14 | +1.09 | 17.2% | 17.4% | **−0.2** |
| seoul | 3,304 | 23.28 | 25.86 | +2.58 | 30.2% | 25.2% | +5.0 |
| **lehigh** | 3,183 | 28.96 | 29.89 | +0.93 | 20.3% | 21.5% | **−1.2** |
| paris | 2,178 | 31.57 | 31.82 | +0.25 | 16.6% | 18.2% | −1.6 |

In **philly and lehigh, two of the three home cities, the delta layer lowers
within-10 below baseline-alone.** In la it moves it by +0.1. The cities where
the model helps most are seoul, mexico, delhi, mumbai and buenosaires, i.e.
cities the product does not serve.

### By hour band (forward split)

| band | rows | model MAE | base MAE | ΔMAE | model W10 | ΔW10 |
|---|---|---|---|---|---|---|
| overnight 0-5 | 4,344 | 26.59 | 27.92 | +1.33 | 24.7% | **−4.6** |
| morning 6-10 | 12,490 | 25.54 | 26.63 | +1.09 | 25.1% | −1.2 |
| midday 11-14 | 30,472 | 28.82 | 30.43 | +1.61 | 20.2% | +1.2 |
| afternoon 15-16 | 10,674 | 28.85 | 30.24 | +1.39 | 21.0% | +1.2 |
| **dinner 17-20** | 33,052 | 30.08 | 31.03 | +0.96 | **20.0%** | +0.8 |
| **evening 21-23** | 12,222 | 31.18 | 32.05 | +0.87 | **18.0%** | −0.2 |

The two bands the product exists for are the two worst bands, both absolutely
(within-10 20.0% and 18.0%) and in what the model adds (+0.96 and +0.87 MAE, the
smallest gains of any band). Accuracy decays monotonically through the evening.

### By how many live observations the venue already has

Live rows for that venue on the **training** side, so the bucket is the depth a
purchase would have added to. Forward split:

| training live rows | test rows | venues | model MAE | base MAE | **ΔMAE** | model W10 | ΔW10 |
|---|---|---|---|---|---|---|---|
| 0 | 52,881 | 8,802 | 29.29 | 30.52 | **+1.23** | 20.6% | +0.6 |
| 1-9 | 18,612 | 2,188 | 28.92 | 29.96 | **+1.03** | 20.7% | −0.3 |
| 10-24 | 1,906 | 422 | 30.64 | 31.98 | **+1.33** | 18.9% | +0.1 |
| 25-49 | 7,063 | 1,098 | 28.79 | 30.08 | **+1.29** | 21.6% | +1.6 |
| 50-99 | 14,969 | 1,656 | 28.76 | 30.02 | **+1.26** | 20.6% | +0.2 |
| 100-199 | 7,648 | 537 | 27.58 | 28.96 | **+1.38** | 21.5% | −0.4 |
| 200+ | 175 | 9 | 31.77 | 33.01 | +1.23 | 16.6% | −2.3 |

Flat. From zero live observations to a hundred and ninety-nine, what the delta
layer adds over baseline moves between +1.03 and +1.38 with no ordering.
Venue-level Spearman between observation count and error, over 108 venues with
at least 20 test rows: **−0.057**.

Scattered-date split, same table, and here it is worse than flat:

| training live rows | test rows | **ΔMAE** | **ΔW10** |
|---|---|---|---|
| 1-9 | 16,819 | +1.88 | +1.6 |
| 10-24 | 8,088 | +1.48 | +0.9 |
| 25-49 | 16,992 | +0.39 | −1.0 |
| 50-99 | 29,536 | +0.45 | −1.2 |
| 100-199 | 12,686 | +0.52 | −1.3 |

The model's contribution *shrinks* as venue depth grows, and on the three
deepest bands it makes within-10 worse than serving the baseline.

---

## 5. Measured: does having a venue's live history help at all?

The bucket tables above are confounded. Deep venues also have better baselines
(baseline within-10 of 22.5-26.9% against 19.6% for shallow venues), so a
shrinking improvement could just be shrinking headroom. This test is not
confounded.

Take the rows held out by **both** the venue split and the scattered-date split:
a held-out venue **and** a held-out date. All 17,322 of them are out-of-sample
for both models. Same rows, same labels, same baselines. The only difference is
that one model had those venues' live history in training (median 52 live rows
each) and the other had never seen them live.

| model | MAE | within-10 | ΔMAE vs baseline | ΔW10 vs baseline |
|---|---|---|---|---|
| had **never** seen these venues live | **27.14** | 23.1% | +1.38 | +0.2 |
| **had** their live history (median 52 rows) | 27.63 | 22.7% | +0.90 | −0.2 |
| baseline alone | 28.52 | 22.9% | — | — |

**The model that had the venue's live history is 0.49 MAE worse on identical
rows,** despite training on 304,000 *more* rows overall. Broken down by how much
history it had, the penalty holds at every depth:

| live rows the familiar model had | rows | unfamiliar MAE | familiar MAE | penalty |
|---|---|---|---|---|
| 1-9 | 3,364 | 28.12 | 28.40 | +0.29 |
| 10-24 | 1,497 | 26.38 | 26.71 | +0.32 |
| 25-49 | 3,488 | 27.86 | 28.58 | **+0.72** |
| 50-99 | 6,168 | 27.36 | 27.90 | +0.53 |
| 100-199 | 2,770 | 25.01 | 25.43 | +0.42 |

Never negative. Largest in the 25-99 band, which is where most purchased depth
would land (corpus median is 9 live rows per venue, p90 is 72).

---

## 6. What this means

### Measured

1. Within-city serving accuracy is **within-10 20.7%, MAE 29.02**, forward in
   time. The LOCO 22.8% overstates it.
2. Against baseline-alone the delta layer is worth **+0.3 points of within-10**
   within-city and **+0.4 points** on the LOCO population. In philly and lehigh
   it is negative.
3. Dinner and evening, the product's own hours, are the worst bands measured
   (20.0% and 18.0% within-10) and the ones the model improves least.
4. Accuracy does not rise with a venue's live-observation depth. The unconfounded
   paired test says depth makes the model **worse** by 0.29-0.72 MAE at every
   band.
5. Fully in-sample, the shipped model reaches only 22.2% within-10 on these rows.

### Inferred

**The delta layer does not currently earn its place.** It survives the ship gate
because the gate asks "better than the previous model, and better than baseline
on the holdout cities" and it clears both by a small margin. It does not clear
the question a user would ask. A product that showed the raw popular_times
baseline and no ML at all would be within a third of a point of within-10 of
what ships today, in the cities that ship today. I would not rip it out on this
evidence alone: it is a genuine +1.2 MAE and it wins 58% of rows, so it is not
noise. But it is nowhere near the value its 106 features, ONNX export path and
21-minute retrain imply, and it should not be described to anyone as the reason
the product's numbers are good.

**The ceiling is in the labels, not the model.** A depth-8, 800-tree fit that
cannot exceed 22.2% within-10 on rows it memorised is not capacity-limited. Two
concrete suspects, in order:

- **Every one of the 369,076 realtime rows has `label_provenance = 'unknown'`.
  Zero rows are labelled `live` and zero are labelled `forecast`.** The 0.3
  weight round 10 added for vendor-forecast labels has never applied to a single
  row, and `metadata.training_contracts.sample_weight_tiers` confirms only two
  tiers exist. `prepare_features`' guard (`known_prov == ['unknown']`) passes
  only because weekly rows contribute the value `'weekly'`, so the check does
  not do what its error message claims. We therefore cannot tell how much of the
  "honest accuracy" population is observed foot traffic and how much is
  BestTime's own forecast, and an unknown share of the residual may be
  disagreement with a vendor's model rather than with reality. **This is the
  single cheapest thing to fix and it should be fixed before any data purchase.**
- The baseline itself is weak on this population: R² 0.031, within-10 22.4%. If
  a venue's typical hour explains that little of its live traffic, the deviation
  the model is asked to predict may be largely unforecastable from weather,
  events and calendar alone.

**Why familiarity hurts (inference, not measurement).** The most likely
mechanism is that the model partially identifies a venue through its
quasi-identifying features (rating, review count, google types,
`neighbor_baseline_same_hour`, `category_baseline`) and fits that venue's
period-specific deviations, which do not hold on other dates. That is
overfitting to venue identity through the back door, with `venue_id` excluded
exactly as the contract requires. It is consistent with all three observations
(flat buckets, negative paired result, penalty peaking in the 25-99 band) but
this run did not test it directly; a per-venue random-effect probe would.

---

## 7. What I would and would not buy

**Would not buy: more observations on venues already in the corpus.** This is
the working hypothesis the exercise was meant to test, and it is refuted twice
over. The bucket table is flat from 0 to 199 observations, and the paired test
says a venue's live history makes the model measurably worse on that venue at
every depth. Deepening from the current median of 9 observations per venue to
50-100 lands in the band where the measured penalty is *largest* (+0.53 to
+0.72 MAE). Buying depth would spend money to move a number in the wrong
direction.

**Would not buy: more cities.** Nothing here argues for it either way, but note
that the model's advantage over baseline is *larger* in cities the product does
not serve (seoul +2.58 MAE, delhi +2.21, mexico +1.80) than in the ones it does
(philly +1.09, la +1.12, lehigh +0.93). Breadth is not the constraint.

**Would spend engineering time, not data budget, on label provenance.** Fixing
`collectRealtime.js` so `label_source` is actually written, and tightening
`prepare_features`' provenance guard so an all-unknown *realtime* population
fails the run, costs nothing and would tell us whether we have been scoring
against reality or against a vendor's forecast. Until that is known, no accuracy
number on this population can be interpreted, and no purchase decision based on
one is safe.

**Would consider, if data must be bought: breadth of signal, not depth of the
same signal.** The features that would plausibly move a live-deviation model
(real-time transit, parking, competitor occupancy, ticketed-event attendance
rather than proximity) are absent. What is not absent is more rows of the same
BestTime series, and more of those is measured here to be worth nothing.

---

## 8. Rounds

Six measure-then-re-audit rounds. Three changed a conclusion:

1. **Rebuild + first split.** Two defects in my own measurement, both caught by
   the split audit rather than by reading. The `observed_date` key census
   reported 1,565,964 distinct training keys because `read_csv` hands back a
   distinct NaN *object* per row in an object column; the disjointness answer
   was right but the census was noise. And the venue split shared 3,121
   `venue_id` values across sides, because that version deliberately kept the
   held-out venues' weekly rows in training.
2. **Strict venue split.** The weekly-anchor exemption was dropped so the
   disjointness claim became an assertion instead of an argument. This surfaced
   the real surprise: the *unseen-venue* split beat the seen-venue date split,
   which is backwards.
3. **scattered_date control.** Separated "held-out date" from "later than every
   training date". Forward extrapolation costs ~1.2 MAE. It also produced the
   first negative result: within-10 **below** baseline-alone.
4. **venue_with_anchor.** Tested and **refuted** my first explanation, that the
   weight-0.05 weekly anchor was suppressing the delta on served venue-hours.
   26.788 against 26.780. The anchor does nothing; the hypothesis was wrong and
   is recorded here as wrong.
5. **Paired familiarity test.** Same rows, two models, one difference. Produced
   the causal answer that the bucket tables could not.
6. **Paired test by depth.** Closed the last confound, that deep venues have
   better baselines and therefore less headroom. Penalty holds at every depth.

Protected artifacts (`best_model.pkl`, `features_train.pkl`,
`features_holdout.pkl`, `model_metadata.json`) were never written; mtimes
verified unchanged across the run. No git, no production database, no paid API
calls. `__tests__/withinCityEval.test.js` pins the hyperparameter copy against
`train_model.py`, the clamp against `model_metadata.json`, the imported serving
mask, the scratch-only writes and the device pin.

**Reproduce:**

```
cd backend/scripts/ml/train
FLOCK_TRAIN_DEVICE=cpu FLOCK_TRAIN_THREADS=12 python within_city_eval.py
```

First run rebuilds the frame from `training_data.csv` (~33s) and performs four
XGBoost fits (~40s each). Subsequent runs reuse the cached frame and
predictions. Full numbers land in `<scratch>/results.json`.

---

## 9. Follow-up (2026-08-15): label provenance, answered

Section 6 named the all-`unknown` provenance as "the single cheapest thing to
fix" and section 7 as the one thing to spend engineering time on before any data
purchase. It was chased. **The answer is not the one section 7 assumed, and the
number it wanted cannot be produced from the corpus we have.**

### The forecast-versus-observed split is NOT measurable on the existing corpus

Measured read-only against production, 2026-08-15:

| | |
|---|---|
| realtime rows | 457,402, **`label_source` NULL on every one** |
| the same rows' `observed_date` | NULL on every one |
| the same rows' `hour_axis` | NULL on every one |
| the same rows' `besttime_epoch` | NULL on every one |
| collection window | 2026-03-10 to **2026-05-18, then it stopped** |

Nothing in the 41 columns records `venue_live_busyness_available`, which is the
only thing that separates the two. Two candidate discriminators were tested and
both are dead:

1. **Value grid.** If live readings and forecasts were quantised differently, a
   value off one grid would name itself. They are not. All 457,402 realtime
   values *and* all 3,454,955 weekly values are multiples of 5, on the same
   21-point grid, in every month of collection.
2. **Echo of the weekly forecast.** A forecast-sourced realtime row should equal
   the venue's weekly forecast for the same venue-local slot. It does on
   25,158 / 446,039 rows = **5.64%**. The identical test aimed at a deliberately
   **wrong** slot — the null control — scores 5.02% (dow+3), 5.07% (dow+4),
   6.31% (hour+1), 6.89% (hour+2). Two of the four wrong answers score *higher*
   than the right one. The equality is chance on a 21-point grid.

So no backfill was written and none should be. The rows stay `unknown`, and
`unknown` keeps meaning what it says. **Section 6's second suspect — that an
unknown share of the residual is disagreement with a vendor's model rather than
with reality — is therefore permanently untestable on this corpus.** It can only
be answered by collecting again, and the collector now records what is needed.

### Section 7's prescription was aimed at the wrong defect

It says to fix `collectRealtime.js` "so `label_source` is actually written".
The collector has written it since round 10; the corpus predates the column by
three months. The real defects were two, and both are fixed:

* `label_source` existed **only** because the collector ran
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` on first use. On any database it
  had not run against, `export_training_data.js`'s optional-column probe selects
  `NULL AS label_source` and exports every realtime row as `unknown` with no
  error and no log line. Migration **025** puts the column in the chain.
* Nothing **verified** the write. The run now reads back the rows it committed
  and refuses — loudly, exit 1 — if any carries a NULL `label_source`. A
  collection that cannot say what its labels are is worse than no collection,
  because it looks like evidence.

`vendor_forecast_pct` is also added: BestTime hands us its forecast in the same
response as the live reading and the collector was discarding it. Stored, a
`live` label becomes falsifiable rather than an unbacked assertion, and the
distance between the label and the vendor's own prediction — the quantity this
document wanted and could not get — becomes measurable on every future row at no
extra API call.

**Wired in on 2026-08-15 (round 20).** The export contract is now **44 columns**:
`label_source` and `vendor_forecast_pct` are appended to `HEADER` and to
`prepare_features.EXPORT_COLUMNS`, so a pre-round-20 CSV is refused by name. Both
are **carried columns, not features** — exported, validated and shipped in
`features_train.pkl` / `features_holdout.pkl`, and excluded from
`get_feature_columns`. Two reasons, and the second is the one that matters after
the corpus fills up:

1. Both are empty on 100% of the corpus today, so a feature built from either
   would be a constant dead slot (the last run already carried 11 of 106), and
   filling the NULL with 0 would assert that BestTime predicted an empty venue on
   3,912,357 rows.
2. `vendor_forecast_pct` **equals** `busyness_pct` on every forecast-sourced row
   by construction. A raw feature would hand the model the label on that whole
   slice the moment the data exists — the same leakage class as `popular_times`
   and the category baselines. Its legitimate use is as a *residual*, on a slice
   the model is not scored against, and that is a decision to make with data in
   hand.

Carrying them buys two things immediately. The derived `label_provenance` is a
pure function of `(is_realtime, label_source)`, so `prepare_features.py`
recomputes it and refuses when the two disagree — a masked or out-of-domain
source can no longer arrive as a silent `unknown` at weight 1.0. And a
`forecast` row whose `vendor_forecast_pct` differs from its own `busyness_pct`
stops the run, which is what makes a `live` label falsifiable rather than an
assertion. Pinned by `__tests__/mlExportColumnGrowth.test.js`.

### Consequence for section 7's spending advice

Unchanged, and slightly firmer. "Would not buy: more observations on venues
already in the corpus" was already refuted twice on measurement. It is now also
true that **no purchase of BestTime rows can be evaluated against the existing
corpus**, because we cannot say what fraction of that corpus is the vendor's own
forecast. Any new collection should run for a period long enough to measure the
live share directly before a purchase is priced.

Migration 025 is **written and tested, not deployed.** It is catalog-only DDL:
two nullable `ADD COLUMN`s and one `CHECK ... NOT VALID`, no backfill, no table
scan. Measured on the embedded-Postgres harness at two corpus sizes — **3 ms on
5 rows, 17 ms on 1,000,005 rows** — so it is O(1) in the row count, unlike 023
(9 minutes of closed port) and 024 (~2). `__tests__/mlLabelProvenance.test.js`
fails if that ever stops being true.

---

## 10. Follow-up (2026-08-16): why philly and lehigh measure negative

Section 4 recorded the delta layer lowering within-10 below baseline-alone in
two of the three cities the product serves. This section is the mechanism.
Everything below is arithmetic on `train/features_train.pkl` (1,934,988 rows,
369,076 of them realtime-served) plus `train/best_model.pkl` predictions on the
rows it was fitted on. **No refit was performed, so every model number in this
section is IN-SAMPLE and is marked as such.** Nothing in `models/` was touched.

There are two causes. One is a scoring mismatch worth about a point of
within-10 in every city. The other is real and specific to philly.

### 10.1 Within-10 was measured with an unrounded model against an integer baseline

The corpus sits on a grid. **100.00% of realtime-served baselines are integers**
(`buildBaselines.js` and `mlPredictor.js` both store `Math.round`) and
**100.00% of labels are multiples of 5**. So `|actual − baseline|` is an
integer, and a measurable share of rows lands *exactly* on 10, inside the
inclusive `<= 10` test:

| city | rows | \|err\| == 10 | \|err\| in (10, 11] | baseline W10 | baseline W10 without the ==10 mass |
|---|---|---|---|---|---|
| philly | 8,088 | 2.73% | 2.27% | 22.8% | 20.0% |
| lehigh | 22,332 | 3.17% | 2.63% | 23.5% | 20.3% |
| la | 53,791 | 2.80% | 2.33% | 23.7% | 20.9% |
| nyc | 45,740 | 2.45% | 2.16% | 20.4% | 18.0% |
| seoul | 8,235 | 3.75% | 3.05% | 32.6% | 28.8% |

`within_city_eval.reconstruct()` returns an unrounded float on purpose, so the
numbers stay comparable to `quick_eval.py`. **`mlPredictor.js` rounds:**
`score = Math.round(baseline + clamp(delta, ±30))`. The evaluation therefore
scored a predictor that can never land exactly on 10 against a baseline that
lands there on 2.3–3.8% of rows. Production does not do that.

Size of the effect, measured two ways on the realtime-served rows:

| predictor | philly | lehigh | la | nyc | seoul |
|---|---|---|---|---|---|
| shipped model, ΔW10 unrounded (in-sample) | −0.17 | +1.93 | +1.88 | +1.85 | +4.00 |
| shipped model, ΔW10 rounded (in-sample) | **+0.94** | +2.99 | +3.03 | +2.85 | +5.46 |
| cross-fitted cell means, ΔW10 unrounded | +0.69 | +0.25 | −0.59 | +0.28 | +2.84 |
| cross-fitted cell means, ΔW10 rounded | +1.64 | +1.25 | +0.38 | +1.19 | +4.32 |
| **rounding bonus** (model / cell means) | +1.11 / +0.95 | +1.07 / +1.01 | +1.15 / +0.97 | +1.00 / +0.91 | +1.47 / +1.48 |

Corpus-wide over all 369,076 realtime-served rows: baseline W10 22.37, model
unrounded 24.15, model rounded 25.25, **bonus +1.10 pp**. MAE is 26.36 either
way — identical to two decimals. The bonus lands between +0.82 and +1.48 in all
seven cities measured, for both a memorising predictor and a deliberately weak
cross-fitted one, because it is a property of the error density at the boundary
and not of fit quality.

**Consequence for section 4's table, as an estimate rather than a re-run:**
philly −0.2 → ≈ **+0.8**, lehigh −1.2 → ≈ **−0.2**, la +0.1 → ≈ **+1.1**,
headline +0.3 → ≈ **+1.3**. The MAE column does not move. Treat these as
lower-ish bounds with about ±0.2 of slack: the bonus is roughly half the mass
sitting exactly on the boundary, and the forward test window's baseline is
weaker than the full corpus's (philly 17.4% W10 there against 22.8% here), so
its boundary mass is slightly thinner.

The fix is one line, and it must be applied to the model and the baseline
together: score them the way production serves them. Re-running
`within_city_eval.py` with `np.round` in `reconstruct()` replaces the estimate
above with a measurement. The same boundary exists at within-15, and at the
ship gate's realtime within-10 floor — `MODEL-METRICS.md`'s challenger 20.6%
and incumbent 19.3% are both unrounded delta models and both gain about a
point, while baseline-alone's 19.2% does not move. Gate criteria 1 (beat the
baseline) and 3 (the absolute realtime within-10 floor) both move; criterion 2
(MAE) does not move at all, and criterion 4 (incumbent comparison) does not
move because both sides gain the same point.

### 10.2 The real part: in philly there is almost nothing left to learn

Four cheap hypotheses, all refuted by arithmetic before any speculation.

**Not sample weight.** Share of a city's training weight carried by weight-0.05
weekly anchors, whose delta label is 0 by construction: philly 28.8%, seoul
27.3%, buenosaires 37.7%. Seoul and buenosaires are the two cities the delta
layer helps *most* (+2.58 and +5.20 MAE, section 4).

**Not live-row volume.** philly holds 8,088 live rows, 2.19% of the corpus's
live rows. Seoul holds 8,235 (2.23%) and buenosaires 3,865 (1.05%).

**Not "the baseline is already good, so there is no headroom."** philly's
baseline is the worst of the three home cities: MAE 29.32, W10 22.8%, against
seoul's 22.53 / 32.6%.

**Not a sign error inherited from the corpus mean.** Mean predicted delta
tracks the true city mean in all 30 cities (philly +4.87 predicted vs +5.82
actual; la −6.46 vs −6.65). The model finds the level everywhere.

What is actually different is **discrimination**, and the spread it has to
discriminate against:

| city | corr(pred, delta) in-sample | SD of predicted delta | SD of delta label | median within-cell SD | SD of cell means | share of delta variance addressable by (category, dow, hour) |
|---|---|---|---|---|---|---|
| **philly** | **0.260** | 5.83 | 35.49 | 33.63 | 11.01 | **9.7%** |
| **lehigh** | 0.423 | 10.79 | 34.46 | 31.33 | 13.54 | 15.7% |
| la | 0.450 | 12.84 | 35.06 | 31.36 | 14.07 | 16.8% |
| seoul | 0.362 | 6.43 | 28.16 | 24.27 | 12.11 | 19.9% |
| mexico | 0.538 | 14.94 | 32.70 | 27.63 | 14.05 | 20.6% |

philly's 0.260 is the second-lowest correlation of the 30 cities, and it is
in-sample: the model was fitted on those exact rows and still cannot order
them. Cells are `(category, day_of_week, hour)` with at least 8 rows.

**The ceiling that implies, measured rather than argued.** Fit
`(category, dow, hour)` mean deltas on a random half of a city's live rows,
score the other half, both directions — an oracle for the entire class of
time-and-category-conditional corrections, and still optimistic, because random
halves share venues and dates:

| city | cell-model MAE | baseline MAE | ΔMAE | cell-model W10 | baseline W10 | ΔW10 |
|---|---|---|---|---|---|---|
| philly | 28.71 | 29.32 | +0.60 | 23.47 | 22.77 | **+0.69** |
| lehigh | 26.86 | 27.93 | +1.07 | 23.74 | 23.49 | **+0.25** |
| la | 27.44 | 28.78 | +1.33 | 23.10 | 23.69 | −0.59 |
| seoul | 20.72 | 22.53 | +1.82 | 35.41 | 32.57 | +2.84 |
| nyc | 28.95 | 30.53 | +1.59 | 20.72 | 20.44 | +0.28 |

Unrounded, to match section 4. **In philly the best available answer from the
whole class is +0.69 pp of within-10.** The shipped model gets −0.17 in-sample.
The gap between what ships and what philly's own data can support is under one
point.

**And the one channel that might carry more is empty in philly.** All 14 event
features are constant across philly's live rows, and `has_nearby_event` is 0 on
all 73,640 philly rows, live and weekly alike. Ticketmaster
enrichment reached 10 of 30 cities: london 25.9% of rows, nyc 22.0%, sydney
13.9%, chicago 7.5%, la 4.2%, mexico 2.6%, boston 2.3%, lehigh 0.36%, dallas
0.23%, dubai 0.08%. **philly 0.00%.** `is_holiday` is zero corpus-wide and all
four season flags are constant, so in philly the model's whole reachable
hypothesis space is the class the table above prices.

**Where philly loses even in-sample** (rounded, so the 10.1 artifact is
removed): gym, 1,424 rows and 17.6% of philly's live rows, baseline W10 24.2 →
model 22.1; bar, 793 rows, 21.9 → 20.6. philly's gym mean delta is **+8.1**
while la's is −4.4, and la + london + nyc + chicago supply **51.7%** of the
corpus's live rows with mean deltas of −6.65, −5.02, −5.26 and −3.07.

### 10.3 What would change the number, and what would not

1. **Score the way production serves.** Free, and the largest single move:
   about +1.0 pp of within-10 in every city, enough to flip philly's sign. It
   is a measurement correction, not a model improvement — MAE does not move.
   Apply it in `within_city_eval.py`, `quick_eval.py` and `evaluate_model.py`
   in one change, to the model and the baseline alike, and re-derive the gate's
   floor from rounded numbers.
2. **Do not route PA to baseline-alone.** Measured cost: +1.09 MAE in philly
   and +0.93 in lehigh (section 4), to buy +0.2 and +1.2 pp of *unrounded*
   within-10 — and those two gains are inside the +1.0 pp the rounding
   correction hands back. Serving the bare baseline in PA is worse on both
   metrics the product could quote.
3. **Do not add a per-city or per-region shift term.** The best per-city
   constant that exists was swept over s ∈ [−10, +12]: philly's within-10 peaks
   at s = +6..+10 (+0.9 pp) while its MAE is minimised at s = +8; lehigh's
   within-10 peaks at s = −10 while its MAE is minimised at s = −4; la is −4 vs
   −6; nyc is −10 vs −6. The two metrics disagree on direction in lehigh and
   nyc, and the whole effect is under a point on an 8,088-row city.
4. **Upweighting philly, or fitting philly alone, cannot pass +0.69 pp.** That
   is the measured ceiling for the class of predictors philly's rows support,
   and weight does not add features.
5. **Collecting Ticketmaster events for philly is cheap, and the corpus gives
   no evidence it pays.** The four cities with the most event coverage (london
   25.9%, nyc 22.0%, chicago 7.5%, la 4.2%) are not the cities the delta layer
   helps: london is −0.5 pp of within-10 and nyc +0.4. The five it helps most —
   seoul, buenosaires, delhi, mumbai, saopaulo — have **0.00%** coverage. Fill
   the gap because a zero-coverage major event market is a collection defect,
   not because a within-10 gain is expected.

### 10.4 Verdict

**philly.** The delta layer is not negative once it is scored the way
production serves it: estimated +0.8 pp of within-10 and a measured +1.09 MAE.
It is also not worth much, and it cannot be made worth much with the data that
exists — the ceiling for any correction philly's own rows can support is +0.69
pp over the baseline, and the model already reaches within a point of it while
fitted on those rows.

**lehigh.** Approximately zero. In-sample the model is +2.99 pp rounded;
honestly, forward in time, it is about −0.2 after the same correction. That gap
is generalisation, not a ceiling: lehigh's addressable variance share is 15.7%
against philly's 9.7%, and its cross-fitted ceiling is +0.25 pp.

**Fixability with data already collected: no.** The limit in philly is the
spread of the delta label inside a `(category, dow, hour)` cell — 33.63 points
against 24.27 in seoul — and no reweighting, per-city term or extra capacity
touches it. What would touch it is a feature that varies *within* a cell and
correlates with the deviation. The corpus has one such family, events, and
philly has none of it; the cities that do have it are not the cities the model
helps. That is the honest state: **the routing decision should be "keep serving
the model in PA", not because it is good there, but because baseline-alone is
measurably worse and the delta layer's remaining upside in PA is under one
point of within-10.**
