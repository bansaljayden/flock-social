# Within-venue hour-ranking evaluation

**Question.** Publishing "this place is at 68 right now" is an ABSOLUTE claim,
and absolute is where the measured error lives (MAE 29.42, within-10 20.7%).
But "go at 9 PM instead of 8 PM" is a RANKING claim inside one venue, carried by
the shape of that venue's curve rather than by its level. Nobody had ever
measured it. If within-venue hour ordering is good, it is the strongest honest
crowd claim Flock has.

**Answer. It is not good, and it is not ours.**

Inside one venue on one night, the model orders two hours correctly **62.7% of
the time** (pairs where the truth is not a tie, predictor ties excluded). That
headline is carried entirely by pairs that are far apart: **at a true gap under
10 points it is 53.2%, which is a coin flip**, and pairs 20+ points apart are
65% of the sample and score 67.1%.

**And the finding that matters more.** Serving Google's popular_times baseline
alone and predicting no deviation at all gets **63.1%** on the identical pairs.
A venue-block bootstrap of model-minus-baseline over all non-tied pairs is
**-0.49pp, CI95 [-0.88, -0.12]** — the trained layer is not merely worthless for
ordering hours within a night, it is *significantly slightly negative*. No gap
bucket shows a positive advantage. This is the same shape as the WITHIN-CITY-EVAL
finding on level (delta layer worth +0.3 within-10), except that on ordering the
delta layer does not even buy the +0.3.

**Recommending the quietest hour** is 59.2% exact against a 48.5% chance floor
(+10.8pp), top-2 80.1% against 67.0% chance. Real lift. Baseline alone: 59.4%
and 80.9%. Again the trained layer contributes nothing. And the candidate set is
at most five hours, mean 2.5, so this is mostly "pick the quieter of two hours",
not what the shipped feature does. See section 5 before quoting it anywhere.

**This is NOT the 43.1% figure.** See section 6. Different question, different
unit.

Everything under **Measured** is a number this run produced. Everything under
**Inferred** is a judgement built on those numbers and labelled as such.

---

## 1. What was run

`scripts/ml/train/hour_ranking_eval.py`. Read-only; all output goes to
`train/hour_ranking_out/`. Reproduce:

```
cd backend/scripts/ml/train
FLOCK_TRAIN_THREADS=4 python hour_ranking_eval.py
```

xgboost/numpy/pandas as installed, Python 3.14.3, `random_state=42`, 1000
bootstrap resamples.

**Artifacts.** The SHIPPED v2.6.0-STARLING pair in `models/incumbent/`
(`best_model.pkl`, `features_holdout.pkl`). `train/best_model.pkl` and
`train/features_holdout.pkl` were overwritten by the v2.7 prep on 2026-08-18
22:55 (RETRAIN-V27-LOG.md, "Dispersion lab") and are NOT the shipped model.

### Reproduction of the gate slice, verified before anything else ran

| check | expected | got |
|---|---|---|
| gate rows | 67,249 | **67,249** |
| model MAE (legacy +/-30 gate arithmetic) | 29.4191 | **29.4191** |
| model within-10 | 20.67% | **20.67%** |
| popular-times baseline MAE | 31.4782 | **31.4782** |
| baseline within-10 | 19.16% | **19.16%** |

`EXACT REPRODUCTION: True`. The gate slice is `is_realtime & (baseline > 0)`,
holdout dates 2026-03-11 to 2026-05-18.

### Row alignment, proven rather than assumed

`features_holdout.pkl` carries no `venue_id` and no `observed_date`; pairing
hours requires both, so the pickle is positionally joined to
`train/holdout_data.csv` and the join is *verified* on five columns before use:
row count, `busyness_pct`, `hour`, `is_realtime`, `city` — all identical. The
script exits rather than continue if any check fails.

Deliberately **not** checked for identity: `baseline`. The pickle's is the
neighbour-smoothed anchor (`prepare_features.smooth_baseline_hours`); the CSV's
is the raw popular-times column. They differ on 182,327 of 395,464 rows by up to
17 points. The smoothed one is what the delta is added to and what every
published "baseline alone" number is, so it is the baseline arm here.

### Two predictors, one population

* **model** — `round(clip(baseline + clip(delta, -50, 50)))` plus the 1-point
  extremes push: the integer a user is actually shown
  (`mlPredictor.reconstructScore`).
* **baseline** — `clip(baseline, 0, 100)`, same rows, same index array.

A third arm, the model without the final rounding, is carried in the JSON so a
reader can see how much of any tie rate is rounding. It moves nothing
(62.5% vs 62.7% excl. ties).

---

## 2. Measured — Arm A: same venue, same calendar night, different hours

**This is the product's question.** 42,158 venue-nights in the gate slice;
**17,101** have 2 or more scored hours; 35,052 hour pairs.

Group sizes: 2 hours x10,878 · 3 x4,660 · 4 x1,359 · 5 x204. Never more than
five hours in a night. This bounds everything below (section 5).

| true gap | n pairs | model correct | model backwards | baseline correct | baseline backwards |
|---|---:|---:|---:|---:|---:|
| tie (gap 0) | 3,554 | not scored | not scored | not scored | not scored |
| 1-5 | 3,827 | 51.69% | 45.41% | 52.18% | 45.70% |
| 5-10 | 2,710 | 51.96% | 45.57% | 52.66% | 45.17% |
| 10-20 | 4,522 | 55.15% | 42.61% | 55.82% | 42.22% |
| 20+ | 20,439 | 66.00% | 32.43% | 66.41% | 32.09% |
| **ALL non-tied** | **31,498** | **61.49%** | **36.60%** | **61.98%** | **36.32%** |

Predictor ties are the remainder (1.5-2.9%). Excluding them, so the number is
"when it commits, how often is it right":

| true gap | model | baseline |
|---|---:|---:|
| 1-5 | 53.23% | 53.31% |
| 5-10 | 53.27% | 53.83% |
| 10-20 | 56.41% | 56.94% |
| 20+ | **67.05%** | **67.42%** |
| ALL non-tied | 62.69% | 63.05% |

True ties are 10.1% of all pairs and are reported, never scored.

### Does the trained layer add anything to ordering? No.

Venue-block bootstrap (venues are the blocks, because a venue's hours are not
independent draws), model correct% minus baseline correct%, 1000 resamples:

| bucket | difference | CI95 | n pairs | venues |
|---|---:|---|---:|---:|
| 1-5 | -0.50pp | [-1.72, +0.71] | 3,827 | 670 |
| 5-10 | -0.70pp | [-1.95, +0.63] | 2,710 | 623 |
| 10-20 | -0.66pp | [-1.61, +0.36] | 4,522 | 704 |
| 20+ | -0.42pp | [-0.88, +0.05] | 20,439 | 932 |
| **ALL non-tied** | **-0.49pp** | **[-0.88, -0.12]** | 31,498 | 980 |

Every point estimate is negative. The overall interval excludes zero.

---

## 3. Measured — Arm B and the null control that reads it

Arm B pools across dates (same venue, same weekday, different hours): 350,110
pairs, model **64.06%** excl. ties against baseline **60.19%**. On its own this
looks like the trained layer finally earning its place.

It is not. **Arm C** is the null control: same venue, same weekday, **same
hour**, different nights. Hour-of-day shape cannot contribute anything here by
construction, and the baseline — a fixed function of venue x weekday x hour — is
**100% tied on every one of those 43,016 pairs**. The model is not:

| true gap | n pairs | model correct excl. ties |
|---|---:|---:|
| 1-5 | 4,759 | 51.19% |
| 5-10 | 3,636 | 55.60% |
| 10-20 | 6,409 | 56.76% |
| 20+ | 28,212 | 63.38% |
| ALL non-tied | 43,016 | **60.43%** |

**Inferred.** Arm B (64.06%) barely exceeds Arm C (60.43%), and Arm C contains
no hour-shape information at all. So Arm B's advantage over the baseline is the
model varying a venue's *level* from night to night — which the static baseline
structurally cannot do — and not the model knowing the *shape* of a night. Arm A
is the arm that isolates shape, and in Arm A the model does not beat the
baseline. Quoting Arm B as an hour-ranking result would be reporting a level
skill under a ranking headline.

**Not audited here:** Arm C's 60.43% is above chance and its source is unproven.
Date-varying features (weather, events, holidays, school breaks) are the benign
explanation; a lagged or recent-observation feature carrying the label would be
leakage. This run does not distinguish them, and no conclusion above depends on
Arm C being clean — it is used only to *deflate* Arm B.

---

## 4. Measured — "the quietest open hour"

What `crowdEngine.recommendBestTime` (crowdEngine.js:1248) claims: it names one
hour and the card prints it as **"Least crowded: 9 PM"** / **"Best time to
visit: 9 PM"**. It picks the argmin over open, non-peak hours ahead of now.

Measured: for each venue-night, take each predictor's argmin hour and ask where
it lands in the true ordering. Predictor ties are resolved by expectation under
uniform random tie-breaking, which is what picking the first minimum does on
average and flatters neither side. "Chance" is picking an hour from the same
group uniformly at random.

| hours in group | groups | model exact | baseline exact | chance | model top-2 | chance top-2 |
|---|---:|---:|---:|---:|---:|---:|
| 2 | 10,878 | 63.67% | 63.66% | 54.98% | — | — |
| 3 | 4,660 | 51.95% | 51.96% | 39.18% | 82.29% | 71.86% |
| 4 | 1,359 | 50.91% | 51.61% | 31.35% | 74.32% | 53.84% |
| 5 | 204 | 42.73% | **52.78%** | 26.76% | 68.71% | 43.63% |
| **ALL (2+)** | **17,101** | **59.21%** | **59.38%** | **48.46%** | **80.10%** | **67.00%** |

Top-3 (groups of 4+): model 89.58%, baseline 90.91%, chance 76.72%.
Mean true percentile of the recommended hour (0 = quietest, 0.5 = chance):
model **0.397**, baseline **0.395**.

The lift over chance is real (+10.8pp exact, +13.1pp top-2). The lift over
Google's baseline is zero, and at the largest groups the model is 10pp *worse*
(n=204, so weak, but it is not a lift).

---

## 5. The limit that bounds every number above

**The candidate set is at most five hours and averages 2.5.** It is "the hours
this venue-night has a live reading and a baseline for", because the corpus
carries no opening-hours column and that is the only defensible shortlist. It is
a *generous* proxy: the predictor is handed 2-5 hours, and 64% of the groups are
straight two-hour coin-flips.

The shipped feature does not do that. It picks from a **12-hour forecast strip**
over the venue's whole open window. Ordering 12 hours is a harder problem than
ordering 2.5, and nothing here measures it.

**Inferred:** 59.2% must NOT be quoted as "the Least crowded line is right 59%
of the time". The honest statement is that on a 2-to-5-hour shortlist the pick
beats chance by about 11 points, and that the true accuracy of the shipped
12-hour version is unmeasured and can only be lower.

---

## 6. This is not the 43.1%-backwards figure. Do not conflate them.

`ADVISOR-GROUNDING.md` records that the venue strip was measured **43.1%
backwards**. That is a different measurement of a different thing:

| | ADVISOR-GROUNDING 43.1% | this document |
|---|---|---|
| unit | one pair of **different venues** | one pair of **different hours** |
| held fixed | the hour | the venue and the night |
| question | "is bar A busier than bar B right now?" | "is this venue busier at 9 than at 8?" |
| what carries it | between-venue level, where MAE 29 lives | the shape of one venue's curve |

A venue-versus-venue ordering and an hour-versus-hour ordering can be good and
bad independently. Neither number bounds the other, neither replaces the other,
and averaging them means nothing. The strip's minimum-gap hedge was ordered off
the 43.1% finding and is unaffected by anything here.

---

## 7. Verdict: can Flock honestly say "it tells you when to go"?

**No, not as written, and above all not as a claim about Flock's model.**

Three things are true at once:

1. **There is a real signal.** Within a venue-night, ordering two hours is
   62.7% right and the quietest-hour pick beats chance by 11 points. That is not
   nothing, and it is better than the absolute claim (within-10 20.7%) that the
   product currently leads with.

2. **The signal is Google's, not Flock's.** Popular_times alone matches or beats
   the trained model on every ordering measurement here, and the bootstrap of
   the difference over all pairs excludes zero on the *negative* side. Flock's
   contribution to knowing when to go is, measured, slightly less than zero. Any
   pitch line implying the model figured out the venue's rhythm is false; the
   rhythm is a redistribution of Google's curve.

3. **It fails exactly where a recommendation would be made.** Recommending 9 PM
   over 8 PM only means anything when the two hours differ enough to matter. At
   true gaps below 10 points the ordering is 53% — a coin flip — and gaps below
   10 points are 21% of pairs. The headline is carried by 20+ point gaps, which
   are the pairs a user could often guess unaided (an empty afternoon versus a
   Saturday night).

**What can be said honestly, today:** that Flock shows a venue's hour-by-hour
pattern, sourced from Google popular times, and that on a short list of hours it
picks a quieter one more often than chance. That is a *display* claim and a
*sourcing* claim, and both are true.

**What cannot:** "our model tells you when to go", "we predict the best time",
or any framing where the trained layer is the thing doing the telling.

**Inferred, for the pitch decision:** the third proposition does not survive in
its strong form. It survives in a weaker one that is mostly a claim about
presenting Google's data well. Whether that is worth a pitch slot is Jayden's
call, not an agent's, but it should not be pitched as model capability, and if
it ships as a user-facing claim it needs the same minimum-gap hedge the strip
already carries: below roughly 10 points of predicted separation, the honest
answer is "too close to call".

---

## 8. Files

* `scripts/ml/train/hour_ranking_eval.py` — the measurement, read-only.
* `scripts/ml/train/hour_ranking_out/hour_ranking_results.json` — every number
  above plus per-bucket predictor-tie rates and the unrounded-model arm.
