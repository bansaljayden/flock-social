# One switch, one trade: should the number on the card be right more often, or wrong by less?

**Private, gitignored. Built 2026-08-20. The switch is OFF. Nothing has changed
in the app.** Flipping `CROWD_QMAP_ENABLED=true` is the whole change. This page
is what you get and what you pay, in cards out of a hundred.

## The problem, in one line

Real venue-hours are mostly either empty or packed. Almost a quarter of them are
at 5 or below, and another quarter are at 90 or above. Flock publishes numbers
bunched in the middle, at a bit over half the spread of reality. So the card is
usually pointed at a room that does not exist: not empty, not packed, sort of
medium. That is the single biggest reason the numbers feel wrong.

The fix is not a better model. It is a translation table applied to the number
right before it is shown. It reads the published score and replaces it with the
real busyness that historically sat at that same rank. It is 40 lines of lookup
and it cannot reorder anything.

## What you get

Out of every hundred venue cards, measured on 46,101 real venue-hours the model
had never seen:

| | today | with the switch on |
|---|---|---|
| cards within 10 of the truth | **21** | **29** |
| cards within 20 of the truth | 39 | 44 |
| cards where the word ("Busy", "Quiet") is exactly right | 23 | 32 |

**Eight more cards in every hundred show a number that is actually close.** That
is the largest single accuracy gain available anywhere in the model right now,
and it is about thirty times bigger than everything else that has been tried.

## What you pay

Same hundred cards:

| | today | with the switch on |
|---|---|---|
| average miss, in points | **30** | **33** |
| cards missed by more than 50 points | 18 | 25 |
| cards missed by more than 75 points | **2** | **10** |
| cards showing a number further from the truth than today | — | 56 |
| cards showing a number closer | — | 40 |

Read the third row twice. The switch makes the app right much more often and
spectacularly wrong five times as often. It gets there by committing: instead of
saying 45 and being safely mediocre, it says 100 or 0 and is either dead right or
dead wrong.

Concretely, cards reading exactly 100 go from 1 in a hundred to **25 in a
hundred**. Reality says 100 on about 21 in a hundred, so it is not inventing
that. But when it puts 100 on a quiet Tuesday, the user sees a number that is
not merely off, it is the opposite of the truth.

## The one that will generate complaints

"Busy" or "Very Busy" would appear on **49** cards in a hundred instead of 32.
The share of those that turn out to be a quiet room goes from 31 in a hundred to
35. Combined, "it said busy and it was dead" happens about **70% more often** in
raw count, because the app says busy half again as often.

Against that: "Very Busy" currently appears on 10 cards in a hundred when reality
says 28. The app is systematically failing to tell people when a place is packed,
which is the other half of the same complaint and the half nobody reports.

## What does not change at all

- **Best time to go, and the hour ordering on the strip.** The table only
  stretches numbers, it never swaps two of them. Checked by enumeration on 21,905
  hour pairs and 123,051 venue pairs: zero reorderings. The best-time line also
  ranks on the Google anchor rather than the model, so it is untouched twice
  over.
- **Owner slider readings.** When a venue posts a live reading it replaces the
  number outright. The table never runs on those cards.
- **The strike rule that catches an owner overstating their room.** It compares
  the owner against the people in the room, not against the model. The model
  cancels out of that comparison entirely.
- **User crowd reports.** They still blend in at three or more verified
  reporters, exactly as today, and they now pull a wider number toward what
  people actually saw, which is the direction that layer exists for.
- **The confidence percentage stays honest.** When the switch is on, the card
  quotes a figure measured on the new number (36%, up from 30% measured on the
  same rows), not the old one. It cannot end up describing a number nobody sees.

## The uncomfortable fact

With the switch on, the model's average error is **worse than publishing
Google's popular-times curve untouched** (33.1 against 31.2 on the same rows).
Its hit rate is ten points better than that curve, but its average miss is two
points worse. Both are true. That is what happens when a target is bimodal and
you are forced to print one number.

This is also why the ship gate refuses it: the gate was written to protect
average error, and it is doing exactly its job. `RETRAIN.md` now carries a
drafted two-metric alternative (GATE-B) that this change would clear, with every
threshold derived from measurement. **GATE-B is also unarmed.** Neither switch
flips without you.

## My recommendation

**Leave it off for now, and turn it on the day there are enough users for the
complaint to be measurable either way.**

The reason is not that the trade is bad. It is that both sides of it are real,
and today there is no way to tell which one users feel more. Eight more correct
cards in a hundred is a big number. Ten cards in a hundred wrong by more than 75
points is a big number too, and it is the kind of wrong that gets screenshotted.

Two things would change the answer:

1. **If you want the app to feel decisive rather than safe, turn it on.** The
   current model's real failure mode is that it never says anything. It reads
   "Moderate" into a world that is mostly empty or mostly packed, and a number
   that is never confident is a number nobody checks twice.
2. **The durable fix is not this.** A single number cannot hit both modes of a
   bimodal world, whichever way you tune it. The real answer is showing a range
   or a likelihood ("probably packed") instead of a false-precision integer, and
   that needs a corpus spanning more than ten weeks of one spring. The slider is
   the only live label source that gets you there. This switch is the best thing
   available before that, and it is available today.

If it goes on: `CROWD_QMAP_ENABLED=true` on Railway, no deploy needed beyond the
restart, and it is reversible by unsetting the same variable. The table is tied
to the current model artifact and refuses to apply itself to any other one, so a
future retrain cannot silently inherit a calibration that was fitted to a
different model.

---

### For the next person who reads this

- Table, code, and flag: `backend/services/mlPredictor.js`
  (`applyScoreQuantileMap`, `QMAP_X` / `QMAP_Y`), mirrored in
  `backend/scripts/ml/train/quick_eval.py` so the ship gate and the serve path
  score the same arithmetic. Pinned by
  `backend/__tests__/dispersionReconstruction.test.js` and
  `backend/__tests__/mlTrainingContracts.test.js`.
- Derivation: fitted on the earliest 30% of gate dates (up to 2026-03-28, 21,148
  rows) from the shipped 2.6.0-starling artifacts, scored forward on the
  remaining 46,101. Nothing in the table was carried over from the 2026-08-19
  dispersion lab; that lab measured against the old ±30 reconstruction, and its
  +8.65pp is not this change's number. The re-derived figure is **+8.40pp**
  (CI95 +7.17 to +9.69) at **+3.15 MAE** (CI95 +2.72 to +3.57), 2000-resample
  date-block bootstrap.
- Reproduction is exact: the artifacts reproduce the published gate numbers
  (67,249 rows, MAE 29.4191, within-10 20.67) to the last digit before anything
  is fitted.

---

# ADDENDUM 2026-09-04: four things this page did not know

Written 2026-08-20 with the switch OFF. It was armed on 2026-08-28. A research
pass on the outside literature plus the numbers already in this repo turned up
four facts that change the trade as stated above. None of them was available
when the table above was written, and all four point the same way.

**1. The band number above is the flattering half of a pair.** This page reports
"cards where the word is exactly right: 23 to 32". The same lab also measured
band WITHIN-ONE, and it goes the other way: **60.52% to 58.71%**
(`RETRAIN-V27-LOG.md:124`). Band-exact is 0-1 loss, which charges the same for
"said Quiet, was Not Busy" as for "said Quiet, was Packed". Every ordinal score
that weights by distance, the Ranked Probability Score included, sees the map as
a wash or a small loss at the band level. Publishing only band-exact makes a
regression look like a gain.

**2. There is no dispersion deficit to restore.** For an approximately unbiased
forecast, R2 = 2*rho*r - r^2 where r is the ratio of predicted to actual spread.
The gate slice gives sd_actual 36.65, sd_pred 21.56 so r = 0.588, and R2 =
+0.040, which solves to a correlation of about 0.33. The squared-error-optimal
spread for a forecast with that much skill is r = rho = 0.33. So the UNMAPPED
number is already about 1.8x more dispersed than its skill justifies, and the
map takes it to 0.927, roughly 2.8x optimal. Shrinkage toward the middle is the
correct signature of a weak forecast, not a defect. The estimated mapped R2 is
about -0.25, against -0.075 for publishing the vendor's curve untouched, which
would make the mapped number worse than a constant. That estimate costs one eval
pass to confirm: `quick_eval.py` already emits r2 and already applies the map,
so run it once each way and read `ship_gate.r2`.

**3. The switch closed the ship gate.** With the map on, the model measures MAE
33.13 against the comparator's 31.20 on the same rows, so `no_mae_regression` is
false, so `rt_pass` is false, so the legacy admission path is shut. The only
remaining door wants +5.0pp of within-10 against the incumbent and the last real
retrain moved +1.4pp. The next honest retrain is refused by arithmetic rather
than by quality, and `mlPredictor.init()` fails closed, so a refused retrain
drops production to the rule engine. This page could not have known it: the
thresholds were calibrated against the unmapped reconstruction before the switch
was armed.

**4. The word ladder and the map disagree about which engine they serve.** The
map touches only the model's exit. The category-curve exit serves about 69.6% of
requests, and the ladder (Packed reserved for 85+) was re-cut on 2026-08-28 for
the MAPPED distribution and applied to all five exits. So a corpus venue and its
equally full neighbour outside the corpus can print different words for the same
room.

## What the literature says, briefly

Inflating a deterministic forecast so its variance matches the observed variance
is a named and rejected technique. von Storch (1999) called it inappropriate
whenever local variability is not fully traceable to the predictors, which is
always. Maraun (2013) is the direct treatment of quantile mapping used to change
the scale of variability rather than to correct a like-for-like bias, and finds
it "introduces similar problems as inflation": misrepresented structure,
overestimated extremes. Quantile mapping is legitimate when both sides estimate
the same quantity at comparable resolution and only the marginal is misaligned;
it is not a way to manufacture variance a predictor never had. The nearest exact
precedent outside climate is Lister and Lister (2006) on histogram-matching
regression-tree maps: same technique, same motive, and it "performed worse
overall with respect to absolute error of prediction".

The MAE-versus-within-10 fight is not a tradeoff. Gneiting (2011): a point
forecast is meaningless until you name the functional it targets, and absolute
error is consistent for the median while a within-N hit rate is the 0-1 loss on
an interval. They are answers to different questions. If the product wants the
interval answer, target and score the interval directly rather than obtaining it
by stretching a median-shaped estimator.

## The recommendation, and what it costs

**Off**, and the durable fix is not a different transform but a different output:
an ordinal head that predicts the band directly, scored by a proper ordinal
score, which gives calibrated per-band probabilities and an abstention rule for
free. Features are already prepared, so it is one training-shaped run of about
twenty minutes plus a day of eval scripting. No money and no new data.

Before touching anything, two free measurements that settle it either way:
run the gate once with the map on and once off and compare `ship_gate.r2`, and
score the bands under RPS and a distance-weighted confusion matrix on the same
46,101 forward rows.

**Not changed by me.** Arming the switch was a decision, and reversing it is
yours. The code still defaults it on, both sides read the same variable, and a
test pins that they agree.
