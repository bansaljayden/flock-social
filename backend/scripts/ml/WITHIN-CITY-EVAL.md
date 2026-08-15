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
