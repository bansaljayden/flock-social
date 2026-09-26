# Crowd model: retrain runbook + the continuous-learning loop

**Currently shipped: v2.6.0-starling** (`models/model_metadata.json`, trained
2026-08-18 on the clock-corrected corpus, 106 features, ship gate
`verdict: ship` on the realtime holdout slice, CPU-trained and bit-reproducible).
The artifact's own metadata is the authority on every live figure; this file is
the procedure that produces one.

The narrative in the v2.3 section below is kept because its *reasoning* still
holds, and its version numbers do not.

One rule governs every number this runbook reports: **score the realtime served
slice.** A high R² on the blended population means nothing here, because the
weekly rows carry a delta label of zero by construction. Since 2026-09-25 there
are two gates on that slice and an artifact must pass both: the point gate
(`quick_eval.py`, city holdout) and the band gate (`bandEval.js --gate`, live
readings held out in time, scored the way the admin Overview "Model" card
scores the product). See "The mid-October retrain" directly below.

## The mid-October 2026 retrain: the plan (written 2026-09-25)

Everything in this section was measured on the local export of 2026-09-08
(`train/*.csv.partial`, interrupted after the `nyc` city block, so it holds
Lehigh's 7,276 live readings of 09-01..09-08 and Miami's 730 of 09-05..09-08,
and **no Philadelphia rows**). It replays the shipped v2.6.0-starling through
the serving code (`train/bandEval.js`, described under "The band evaluation"
below). 7,920 of those 8,006 readings reach the model; the rest have no served
baseline and get the rule engine. Every figure is within one crowd band unless
it says otherwise. Eight days of mostly one city: treat each number as a
direction, and re-measure on the October export with the same command.

### What the card is scored on, and what it gets

The admin card's figure is served `ml` forecasts within one band of the live
reading for the same venue and local hour: **52.6%** over the last 30 days
(n = 192 venue-hours over 9 days, only venues somebody opened). The replay over
every live reading gives the same order of number:

| on the 7,920 model-served September readings | within 1 band | band exact | band MAE | MAE | bias |
|---|---|---|---|---|---|
| **as served today** (quantile map on, + half the trailing offset) | **57.4%** | 32.0% | 1.340 | 31.00 | +15.2 |
| the same model, quantile map off, + offset | 67.9% | 28.5% | 1.123 | 25.90 | +8.0 |
| the same model, no map, no offset | 64.0% | 25.7% | 1.206 | 27.52 | +11.2 |
| the venue's weekly curve at that hour (naive) | 64.5% | 31.2% | 1.163 | 26.42 | +6.5 |
| curve + the full trailing offset | 67.6% | 34.9% | 1.093 | 25.24 | +0.3 |
| rule engine (crowdEngine) | 60.3% | 22.0% | 1.295 | 29.48 | +4.6 |
| served, but the venue's last live reading carried forward when it is at most 2 h old (reference, not served) | 71.8% | 44.9% | 0.986 | 23.05 | +9.0 |
| **a constant "Not Busy"** | **75.8%** | 14.4% | 1.262 | 28.12 | −11.5 |

Read the last row before quoting any within-one-band number. Real venue-hours
are bimodal (37.7% Quiet, 16.5% Packed here), and the second band covers three
of the five, so a forecast that always says "Not Busy" beats everything the
product has ever served on this metric while being right about the band 14% of
the time. Within one band is only meaningful next to band exact and band MAE,
which is why the band gate below never reads it alone.

The spring reference (the unknown-provenance March-May rows of Miami and
Barcelona that every gate before September was scored on, 43,858 rows): served
59.2%, no map 62.9%, curve 57.4%, rule engine 52.5%, constant "Not Busy" 69.3%.
The replay reproduces the pickle-based gate there: its point MAE on these rows
is 28.03 and MODEL-METRICS.md's per-city figures (Miami 27.54, Barcelona 29.25)
weighted by the same row counts give 28.04.

### Where the misses come from, ranked by the points they could recover

Misses (two or more bands off) are 42.6% of served September readings, and they
are mostly OVER-prediction: 32.9% of rows are shown two or more bands busier
than they were (Steady rooms shown Packed 10.0%, Quiet shown Steady 7.3%,
Quiet shown Packed 5.4%), against 9.7% shown quieter. Dinner, 17:00-20:00, holds
38% of all misses. Prequential means fitted on 09-01..05 and scored on
09-06..08 (4,183 readings); the rest is measured on all 7,920.

| # | cause | evidence | points of within-one-band | fix |
|---|---|---|---|---|
| 1 | **the score quantile map** | 57.4% on vs 67.9% off (prequential 58.5 vs 69.2); band MAE 1.340 on vs 1.123 off, worse than the constant; it moves Steady rooms to Packed | **+10.5** | `CROWD_QMAP_ENABLED=false` on the main service, no retrain. The map is fitted to 2.6.0-starling and never applies to a new artifact anyway (mlPredictor's version check) |
| 2 | **no use of the venue's latest live reading** | a reading one hour old predicts the next hour within one band 92.0% (band exact 86.5%, 3,169 rows); deviations from the curve correlate 0.815 at 1 h, 0.487 at 2 h, 0.203 at 3 h | **+7.7** at September's coverage (41% of readings had one an hour earlier); **+20** on the rows that have one (70.1 → 90.2) | serve-time nowcast plus training features, see "Features" below |
| 3 | systematic over-prediction, most of it the month epoch artifact | bias +8 after the offset; v2.6.0's mean delta is −22.8 at month 3, +5.8 at month 5, +4.5 at month 9 (September's, what it serves); `month` carries 20.1% of the booster's split gain (274 of 800 root splits), `month_cos`/`month_sin` another 4.8%; the smoothed curve alone (65.9%) beats the model's own reconstruction (64.0%) | +1.6 to +2.2 (prequential de-bias) | drop the month family; `is_realtime` too (below) |
| 4 | live readings lag the curve by about an hour | the curve one hour EARLIER matches the reading better: MAE 25.76 at −1 h vs 26.42 at 0 h; within one band 71.5% vs 65.1% on the 1,720 held-out readings that have a reading an hour earlier | +2.5 (curve only); overlaps with #2 | `curve_prev_hour` feature; store BestTime's `hour_analysis` |
| 5 | venues with little live history | 0-1 prior readings (17% of rows): 55-58%; 10+ readings: 73-78% | ~+1.5, from collection | none in the model; it closes as readings accrue |
| 6 | Miami | 51.9% vs Lehigh 65.3% (no map, no offset); Miami's curve alone is +13 biased there; collected at two hours a day | ~+1 | more Miami hours, or accept; it is a holdout city |
| 7 | neighbour features computed differently in training | the count differs on 58.6% of rows (mean 1.58 venues), the mean by 3.2 points (p90 6.8): a 0.005° grid over smoothed curves in training, a ±0.0075° box over raw curves in serving | < 0.5 (both carry ~6% of gain) | **done 2026-09-26**: training computes serving's box arithmetic, 0 disagreements on the 8,006 readings |
| 8 | category from `guessCategory(types)` rather than the corpus category | 64.0% vs 64.3% | +0.3 | none |
| 9 | late night | the BEST hours: 20-25% miss rate at 00:00-05:00 against 51% at dinner | 0 | none |
| 10 | the Steady/Busy boundary | adjacent bands are hits for this metric; Busy readings are within one band 82-84% | 0 (band exact only) | none |
| 11 | the six-hour baseline stamp | fixed (status board below). The curve against the same readings shifted by k hours: MAE 26.42 at 0 h, 34.62 at −6 h, 41.06 at +6 h | 0 | none |

The rows do not add. Cumulatively, prequential on 09-06..08: 58.5% as served →
69.2% map off → 71.4% with a fitted per-hour-group de-bias → **79.1%** with the
last-hour nowcast where one exists.

One property of the labels matters for all of it. **81% of consecutive-hour
live readings of a venue are identical**, 82% even where the venue's own
weekly curve moves 10+ points between the two hours, and identical runs rarely
exceed three hours (531 runs of three, 57 longer). Our fetch has no cache; the
live value BestTime returns updates on a slower cadence than hourly. So a live
reading is a slowly refreshed vendor estimate, consecutive readings are not
independent observations, and that stickiness is part of why the last reading
predicts the next one so well.

### Is 85% reachable?

**Not by retraining this model on more rows.** On live September readings the
delta layer adds nothing over the venue's own curve (the model's reconstruction
64.0% against the smoothed curve's 65.9%; on spring rows WITHIN-CITY-EVAL.md
found it worth +0.3 points of within-10), and a venue's live depth does not
change that (WITHIN-CITY-EVAL.md section 5). A retrain that fixes causes 3, 4
and 7 is worth a few points, which puts the model near 70% (the rehearsal
below: 70.0%).

**Yes, on the venue-hours that have a fresh live reading, if the product uses
it.** Carrying the last reading forward is 90-92% within one band and 65-86%
band exact on those rows, which is real accuracy rather than hedging. The card's
figure only counts venue-hours that have a live reading, and BestTime's live
coverage is persistent from hour to hour, so most of those venue-hours had a
reading the hour before. Estimated card figure with the map off and the nowcast
served: about 80% at September's coverage, crossing 85% when three quarters of
scored venue-hours have a reading at most an hour old, which the full hourly
sweeps since 2026-09-25 should reach. Venues with no live coverage stay near
70%, and a product-wide 85% for them is not reachable from these inputs.

Two things 85% must never mean: a within-one-band figure bought by hedging (the
constant scores 75.8%), or a figure measured on rows the card never serves. The
band gate below enforces both.

### What will exist by mid-October

Live readings arrived at about 2,000 a day before the sweeps were fixed (15,835
live- or forecast-labelled realtime rows by 2026-09-08, `train/export_v28.log`)
and about 2,100 a day now. At that rate the corpus holds **roughly 50,000 live
readings on 2026-09-25 and 90,000 to 95,000 on 2026-10-15**, over about 45
observation dates. The 2026-09-08 split was about half Philadelphia (≈7,800),
46% Lehigh (7,276) and 5% Miami (730, two named hours a day). A 14-day time
holdout keeps about 29,000 of them out of training and leaves about 60,000 for
it, above the 50,000 proven-live floor (`FLOCK_MIN_REALTIME_ROWS`). If the
export lands short of that, hold out 10 days rather than lower the floor.

**Re-weight the weekly anchors for that corpus.** The v2.3.1 blend gives every
weekly row weight 0.05. With v2.6.0's 369,076 realtime rows that left live rows
82% of the loss; with 60,000 live rows against ~1.7M servable weekly rows it
leaves them about 41%, and the anchors (whose correct delta is 0) pull every
deviation back toward the curve, which is the v2.2.1 failure. The local dry run
(3,579 live training rows) put live rows at 5% of the loss.
`FLOCK_WEEKLY_ANCHOR_WEIGHT=auto` (prepare_features.py) sets the weekly weight
so live rows carry 80% of the loss again (≈0.01 at 60,000; never above 0.05)
and records it as `sample_weight_policy`; `=0` trains on live rows alone. Run
both and let the band gate choose.

To measure the coverage that decides the nowcast's value (the share of live
readings whose venue was also read the hour before), the owner can run, read
only, against production:

```sql
BEGIN READ ONLY;
WITH live AS (
  SELECT venue_id, observed_date + make_interval(hours => hour::int) AS slot
    FROM ml_training_data
   WHERE collection_mode = 'realtime' AND label_source = 'live'
     AND observed_date >= CURRENT_DATE - 7
)
-- (venue_id, day_of_week, hour, observed_date) is unique for realtime rows
-- (migration 024), so the join matches at most one earlier reading.
SELECT COUNT(*) AS readings, COUNT(p.venue_id) AS read_the_hour_before
  FROM live l
  LEFT JOIN live p ON p.venue_id = l.venue_id AND p.slot = l.slot - interval '1 hour';
ROLLBACK;
```

The 457,402 realtime rows of March-May stay excluded (unknown provenance,
migration 025). Weekly rows: 3.4M, the Pennsylvania ones re-collected in
September (their `month` is 9, everyone else's is 3, 4 or 5).

### Labels

1. **Live only.** The default already excludes unknown-provenance rows. Keep
   forecast-labelled rows at weight 0.3, and run one ablation without them; the
   band gate decides.
2. **One weight per vendor update, not per hour.** Weight each maximal run of
   identical consecutive-hour readings of a venue by 1/run length in training,
   so a sticky venue does not count three times. Evaluation keeps every reading,
   because the card is judged per venue-hour. **Done 2026-09-26**, default on,
   `FLOCK_RUN_LENGTH_WEIGHTS=off` to ablate; the weekly anchor weight under
   `auto` is solved against the divided total (rehearsed below).
3. **Record what BestTime says the reading is about.** `collectRealtime.js`
   discards `hour_analysis` and `venue_open` from the live response. Storing
   them (a migration and a collector change) is what separates the one-hour lag
   in cause 4 from a labelling problem, and explains the 246 readings (81% of
   them non-zero) at slots whose curve says the venue is shut.
4. Drop Beijing (2,057 rows, a statistically empty cross-validation fold).

### Features

Drop, all measured above or in `train/RETRAIN-V27-LOG.md`:

- `month`, `month_sin`, `month_cos`, the four `season_*` and the month-derived
  astronomy/anomaly slots: `FLOCK_CALENDAR_POLICY=drop`. The epoch artifact
  carries a quarter of the booster's gain and, in September, adds +4.5 to every
  prediction. Re-admit when the live corpus spans seasons.
- `is_realtime`: a provenance flag that is always 1 at serving and carries 6.1%
  of the gain (197 of its splits at depth 0-1). **Dropped 2026-09-26.** Six
  scripts read it out of X by position, not four (quick_eval, eval_two_head
  through quick_eval, train_model, train_two_head, sports_ablation,
  hour_ranking_eval); all read the carried key through
  `prepare_features.realtime_flags` now. Serving needs no change: the vector is
  built from the artifact's own `feature_names`.
- `is_school_break` (dropped in the v2.7 experiment for the same epoch reason),
  the four user-feedback features (constant; audit finding 13's leak arms the
  day they stop being constant) and `etype_family` (constant).

Add, each computable at serve time from tables production already has, and
each needing a twin in `mlPredictor.buildFeatureMap` in the same change (the
load-time coverage check refuses an artifact whose features serving cannot
build) and a parity test like `__tests__/mlSmoothingParity.test.js`:

- `last_live_dev`, `last_live_age_h`: the venue's most recent live reading
  strictly before the slot, as a deviation from its own slot's curve, and its
  age in hours (missing: age 99, deviation 0). Past-only by construction. This
  is cause 2, learned instead of hard-coded.
- `recent_offset`, `recent_offset_n`: the trailing 28-day median deviation that
  serving currently adds at a fixed weight of 0.5 after the model; as a
  feature, the model learns how far to trust it. Remove the post-hoc add for
  the artifact that learns it.
- `curve_prev_hour`: the weekly curve one hour earlier (cause 4).

Fixed before the run (2026-09-26): the neighbour features' training arithmetic
(cause 7) is serving's; `__tests__/mlNeighborParity.test.js` pins it.

### Target and calibration

- Keep the delta label and the point head: the card shows a number, and
  `label_type: 'delta'` is what serving reconstructs.
- Train it with `reg:absoluteerror`. The target is bimodal; squared error pulls
  every prediction toward the middle, which is where the Quiet-shown-Steady
  misses come from (the two-head ablation found absolute error "wins every
  column at once").
- No quantile map for the new artifact. Run the point gate with
  `CROWD_QMAP_ENABLED=false`: gated with the 2.6.0 map on, a new artifact is
  refused at load (`mlPredictor.evaluateShipGate`) because the map it was scored
  through is not its own. Any refit map has to pass the band gate like a model.
- A band (ordinal) head is a diagnostic only in October. A decision rule that
  maximises within one band hedges toward "Not Busy"; it becomes useful with
  band exact and band MAE in the objective, and with a product decision about
  showing a likelihood instead of a number.
- The published confidence is still the spring gate slice's within-15
  (QMAP_MEASURED, 36.4%). The served number's within-15 on the September
  readings is 37.1% with the map on and 36.6% off. After the retrain, publish
  the band gate's measured figure for the served number instead (a follow-up in
  `mlPredictor.readServedAccuracy`).

### Validation

- **Time**: the last 14 days of live readings are held out of training in every
  city (`prepare_features.py`, `FLOCK_TIME_HOLDOUT_DAYS`, recorded as
  `metadata.time_holdout`). The band gate scores them.
- **City**: the existing leave-one-city-out CV in `train_model.py` and the
  Miami live readings in the point gate. Only Philadelphia and Lehigh carry live
  training rows, so leave-one-city-out is a transfer check here, not a gate.
- Every interval is a date-block bootstrap: readings repeat hour to hour and a
  night's weather moves a whole city, so row-level intervals would be too narrow.

### The ship gate

`quick_eval.py` writes the point verdict as `ship_gate.point_gate_pass` and
leaves `overall_pass` false with verdict `pending_band_gate`. After
`export_model.py`, `node bandEval.js --gate` replays the exported candidate and
`models/incumbent/` through the serving code on the time holdout and sets
`overall_pass` = point AND band. mlPredictor refuses an artifact whose
`overall_pass` is false, so an artifact that skipped the band gate cannot load.
When the point gate cannot line the incumbent up by its preserved pickle (it
cannot, for October; see the rehearsal below), its incumbent arms are recorded
as deferred and the band gate's head-to-head on identical live readings decides
them.
The band gate requires, on the model-served live readings of the window
(`BAND_GATE` in `bandEval.js`):

| criterion | requirement |
|---|---|
| sample | at least 1,000 readings over at least 5 dates |
| the incumbent never saw the window | its `time_holdout.training_live_through` (else `trained_at`) is before the window |
| beats the incumbent | within one band up, and the date-block CI95 lower bound above −1.0 point |
| beats the weekly curve | within one band up with a CI95 lower bound above 0, AND band MAE no worse than the curve's (this is what stops a hedge) |
| not worse than the rule engine | within one band not below it |
| no city regresses | every city with 300+ readings within 2 points of the incumbent |
| point error | MAE at most 1 point above the incumbent's |

Every verdict also records the constant-answer reference, so no within-one-band
figure is read without what it costs to fake.

### The commands, in order

Pre-work in code before the export: the three nowcast features with their
serving twins (not done). Done on 2026-09-26 and rehearsed below: the neighbour
arithmetic (cause 7), `is_realtime` out of X, and the run-length weights
(default on). Done in this change: the time holdout, the band
gate, the served-baseline smoothing parity and the anchor weight switch.

```bash
# Serving, now, no retrain (cause 1): on the main Railway service
#   CROWD_QMAP_ENABLED=false        then restart. Reversible by unsetting it.

# ── On the training machine, from backend/scripts/ml ─────────────────────────
# 0. Preserve the incumbent. models/incumbent/ already holds v2.6.0-starling's
#    best_model.pkl and features_holdout.pkl from 2026-08-18; add the pair the
#    band gate replays (identical to the tracked files):
mkdir -p models/incumbent
cp models/crowd_model.onnx models/model_metadata.json models/incumbent/

# 1. Clear stale artifacts, the interrupted 2026-09-08 export included.
cd train
rm -f training_data.csv holdout_data.csv training_data.csv.partial holdout_data.csv.partial \
      features_train.pkl features_holdout.pkl best_model.pkl band_gate_report.json

# 2. THE PRODUCTION EXPORT. Run by the owner, with backend/.env pointing at
#    production. Read-only: the exporter opens every statement inside
#    BEGIN READ ONLY with default_transaction_read_only=on.
node export_training_data.js
head -1 training_data.csv | tr ',' '\n' | grep -c .     # must print 45
#    From here on nothing touches the database.

# 3. Features: 14-day time holdout (the default), no month epoch, live rows at
#    80% of the loss. (Ablation: FLOCK_WEEKLY_ANCHOR_WEIGHT=0, same steps 3-7,
#    into a copy of models/; ship whichever passes the band gate higher.)
FLOCK_CALENDAR_POLICY=drop FLOCK_WEEKLY_ANCHOR_WEIGHT=auto python prepare_features.py
python test_fold_category_baselines.py && python test_time_holdout.py
#    If it stops on DEAD SLOTS (the local dry run named cold_outdoor,
#    is_holiday_eve, is_special_night, rain_x_weekend, special_boost,
#    special_suppress, weather_other, weather_snow, weather_thunderstorm: only
#    live rows carry weather now), decide each one in EXPECTED_SPARSE_FEATURES
#    or drop it. Do not set FLOCK_DEAD_SLOT_POLICY=warn for a release.

# 4. Train, CPU-pinned so the artifact reproduces, then the diagnostics.
FLOCK_TRAIN_DEVICE=cpu FLOCK_TRAIN_THREADS=12 python train_model.py
python evaluate_model.py

# 5. Point gate, without the 2.6.0 quantile map.
CROWD_QMAP_ENABLED=false python quick_eval.py

# 6. Export.
MODEL_VERSION=2.8.0-starling python export_model.py

# 7. Band gate: writes ship_gate.band_gate, sets overall_pass = point AND band.
node bandEval.js --gate --out=band_gate_report.json

# 8. Verify the artifact the way production reads it, then read the verdict.
cd ../../..
node --test
node -e "const g=require('./scripts/ml/models/model_metadata.json').ship_gate;
         console.log(g.overall_pass, g.point_gate_pass, g.band_gate_status,
                     JSON.stringify(g.band_gate && g.band_gate.candidate))"
```

`run_training.sh` runs steps 2 to 7 in the same order. Run step 7 with
`CROWD_QMAP_ENABLED` set exactly as the main service has it, because the band
gate compares the candidate against the incumbent AS SERVED, and the map
changes what the incumbent serves.

### A rehearsal on the local export (2026-09-25)

The whole sequence, prepare → train → point gate → export → band gate, run on
the 2026-09-08 partial export in a scratch copy of this directory, with the
last three days of live readings held out (`FLOCK_TIME_HOLDOUT_DAYS=3`) and the
proven-live floor lowered by its smoke-test hatch (`FLOCK_MIN_REALTIME_ROWS=1000`;
the partial export holds only Lehigh's live rows for training). It trained on
3,579 live readings and 1,315,242 weekly anchors, and it found three things the
October run would otherwise have found the hard way:

1. **The dead-slot contract stops the run.** With weather only on live rows,
   `cold_outdoor`, `is_holiday_eve`, `is_special_night`, `rain_x_weekend`,
   `special_boost`, `special_suppress`, `weather_other`, `weather_snow` and
   `weather_thunderstorm` were constant. October will name some of the same.
   Decide each (the rehearsal used `FLOCK_DEAD_SLOT_POLICY=warn` to go on).
2. **The point gate's incumbent arm could not pass for any candidate.** It
   scores the incumbent through its preserved `features_holdout.pkl`, whose
   395,464 spring rows no longer match any holdout built since the
   unknown-provenance exclusion (240,657 rows here): "incomparable", gate FAIL,
   by construction. Fixed in this change: when the band gate is required and
   `models/incumbent/` holds the ONNX artifact, arms 3 and 4 are recorded as
   `deferred_to_band_gate`, and the band gate compares the two artifacts on
   identical live readings through the serving code.
3. **Live rows were 5% of the loss** (the weekly anchor weight, above).

The verdicts, on the 4,183 held-out readings (Lehigh 09-06..08 and Miami):

| on the held-out readings | within 1 band | band exact | band MAE | MAE |
|---|---|---|---|---|
| rehearsal candidate as served (no map, + offset) | 70.0% | 35.0% | 1.047 | 24.67 |
| v2.6.0-starling as served today (map on) | 58.5% | 32.2% | 1.321 | 30.61 |
| v2.6.0-starling, map off (prequential table above) | 69.2% | | | 25.41 |
| weekly curve | 65.9% | 31.5% | 1.128 | 25.66 |
| rule engine | 61.7% | 22.8% | 1.269 | 29.03 |
| last reading carried forward, else served (reference) | 78.2% | 46.7% | 0.822 | 19.43 |
| constant "Not Busy" (reference) | 78.8% | 14.2% | 1.212 | 26.82 |

Band gate: beats the incumbent by +11.6 points (CI95 11.2 to 13.4), the curve
by +4.2 (CI95 2.9 to 6.1) with a lower band MAE, the rule engine by +8.3, no
city regression, MAE guard passed; FAIL on sample only (3 dates, 5 required),
which is the right answer for a three-day window. Point gate: FAIL on criterion
1 alone, R² +0.077 against the curve on Miami's 726 live readings where +0.10
is required.

### The training fixes, rehearsed (2026-09-26)

The same partial export and window (Lehigh 09-06..08 and Miami, 4,183
model-served readings over 3 dates), `FLOCK_TIME_HOLDOUT_DAYS=3`,
`FLOCK_MIN_REALTIME_ROWS=1000`, `FLOCK_DEAD_SLOT_POLICY=warn`, CPU training at 12
threads. Each row adds one change to the one above; each is scored by
`node bandEval.js --gate` against v2.6.0-starling as served today (quantile map
on). Within-10 (w10) is the primary metric, within one band (w1b) is the card's.

| candidate, as served (no map, + offset) | w10 | w1b | band exact | band MAE | MAE | bias |
|---|---|---|---|---|---|---|
| the 2026-09-25 rehearsal, reproduced (anchor 0.05, calendar kept) | 29.9% | 70.0% | 35.0% | 1.047 | 24.67 | −4.37 |
| A baseline: calendar dropped, `FLOCK_WEEKLY_ANCHOR_WEIGHT=auto` | 31.7% | 70.1% | 35.8% | 1.044 | 24.42 | −5.07 |
| B + serving's neighbour arithmetic | 31.6% | 70.1% | 35.9% | 1.044 | 24.51 | −5.38 |
| C + run-length weights | 31.7% | 70.8% | 35.3% | 1.041 | 24.24 | −4.91 |
| **D + `is_realtime` dropped** (all three) | **31.9%** | **70.7%** | 35.7% | **1.037** | **24.23** | −5.25 |
| D with `FLOCK_RUN_LENGTH_WEIGHTS=off` | 31.6% | 70.2% | 35.8% | 1.044 | 24.46 | −5.58 |
| v2.6.0-starling as served today (map on) | 28.6% | 58.5% | 32.2% | 1.321 | 30.61 | +13.00 |
| weekly curve | 32.3% | 65.9% | 31.5% | 1.128 | 25.66 | +4.39 |
| curve + full trailing offset | 34.1% | 68.7% | 35.0% | 1.078 | 24.86 | −2.61 |

Date-block bootstrap (bandEval's, 2,000 resamples over only 3 dates, so the
intervals are coarse), change in points [CI95]:

| comparison | w1b | w10 |
|---|---|---|
| D vs the incumbent | +12.26 [11.63, 12.90] | +3.28 [−0.17, 4.92] |
| D vs the weekly curve | +4.85 [4.01, 6.47] | −0.48 [−4.46, 2.11] |
| D vs curve + full offset | +2.08 [1.07, 5.32] | −2.22 [−4.37, −1.24] |
| A vs the reproduced rehearsal | +0.02 [−0.65, 0.44] | +1.79 [1.12, 2.90] |
| B vs A (neighbours) | +0.07 [−0.35, 0.33] | −0.07 [−0.97, 0.58] |
| C vs B (run-length) | +0.62 [−0.32, 0.99] | +0.05 [−0.08, 0.35] |
| D vs C (`is_realtime`) | −0.02 [−0.17, 0.65] | +0.22 [0.00, 0.97] |
| D vs D without run-length | +0.53 [0.50, 0.65] | +0.26 [−0.16, 0.44] |

By city, D: Lehigh (3,615) w10 33.6%, w1b 71.8%, exact 37.5%, band MAE 1.007,
MAE 23.55, bias −6.63 (A: 33.3 / 71.4 / 37.5 / 1.014 / 23.77); Miami (568) w10
21.0%, w1b 63.9%, exact 24.3%, band MAE 1.229, MAE 28.61, bias +3.53 (A: 21.7 /
61.8 / 25.2 / 1.232 / 28.54). Miami loses 0.7 of w10 and 0.9 of band exact
from A to D while gaining 2.1 of w1b, on 568 readings.

What it says, without rounding it up:

- **The three fixes together are worth a fraction of a point.** D beats A by
  +0.2 w10, +0.6 w1b, −0.1 band exact, −0.19 MAE. That is what cause 7's row
  predicted (< 0.5) and the size of the other two; none of it is outside the
  noise of three dates. They are correctness fixes first: the model now trains
  on the neighbour values it is served, no longer spends splits on a flag that
  is constant at serving, and no longer counts a stale vendor value once per
  hour.
- **Run-length weights trade band exact for within one band** in C (+0.6 w1b,
  −0.6 exact, w10 flat), and much less so on top of D (+0.5 w1b, −0.1 exact,
  +0.3 w10). Kept on by default because every other column moves the right way
  in D; re-run the D pair on the October export and switch it off if band
  exact pays for it there.
- **The neighbour fix is neutral on these readings** (+0.1 w1b, −0.1 w10). It
  was expected to be small: the feature carries little gain.
- **Most of the within-10 gain over the 2026-09-25 rehearsal is the anchor
  weight** (`auto`, +1.8 w10 with a CI above zero), not these changes.
- **Every candidate is still below the curve plus its full offset on within-10**
  (−2.2 points, CI entirely below zero) while beating it on within one band.
  The model wins the card's metric and loses the owner's primary one to a
  two-line heuristic; the nowcast features are what the plan expects to change
  that.
- The previous rehearsal's within-10, not recorded then: **29.9%**
  (reproduced exactly: 70.0% / 35.0% / 1.047 / 24.67, with the default anchor
  weight and the calendar family kept).
- The rehearsal found one defect before October did: with `is_realtime` out of
  the feature list, the holdout frame was cut to `feature_cols` before the flag
  was pickled, and `prepare_features.py` stopped with a KeyError. Fixed in the
  same change (`keep_extra`), pinned by `mlTrainingContracts.test.js`.
- Training with `FLOCK_RUN_LENGTH_WEIGHTS=off` reproduced the run without the
  change bit for bit (C with the switch off equals B on every reading), so the
  switch is a clean ablation.

**A decision to take before October.** Criterion 1 (MAE down 5 OR R² up 0.10
against the curve on the city holdout) was calibrated on spring rows. Its gate
slice is now Miami's live readings at two hours of the day, where v2.6.0 itself
is worse than the curve (MAE 32.2 against 30.3). A candidate can beat the
incumbent and the curve by clear margins on the band gate and still be refused
there. Keep it, or make it advisory whenever the band gate is required (the
band gate's "beats the weekly curve" asks the same question on the population
the card is scored on). This change keeps it binding.

## The band evaluation (`train/bandEval.js`, 2026-09-25)

The replay behind the numbers above and the band gate. For every live-labelled
realtime reading in an export it rebuilds what production would have served:
the baseline through `mlPredictor.blendBaselineRows` over the venue's weekly
curve, the neighbours with `getNeighborActivity`'s box arithmetic, the vector
with `buildFeatureVector` under the scored artifact's own metadata, then
`reconstructScore`, the quantile map under the same flag and version check, half
the venue's trailing live offset computed past-only with
`buildRecentDeviation.js`'s window, and the band; the rule engine wherever there
is no served baseline. It scores any artifact directory (a fresh `mlPredictor`
is loaded per artifact with its two file paths pointed at that directory), and
it never opens a database connection: `DATABASE_URL` is pointed at an address
nothing listens on before any service module loads.

`__tests__/mlBandEval.test.js` runs the real `predictBusyness` against a pool
stubbed from the same synthetic corpus and requires the replay's published
score to match it on every row, rule-engine rows, the zero-slot edge, offsets
and the quantile map included.

```bash
# from backend/: a report on the current model (any export, .partial included)
node scripts/ml/train/bandEval.js --train=scripts/ml/train/training_data.csv \
     --holdout=scripts/ml/train/holdout_data.csv --model=scripts/ml/models \
     --legacy --out=band_report.json --rows-out=band_rows.csv
```

What it cannot replay: the venue record of the moment (production scores the
Google Places payload and guesses the category from its types; the replay uses
the corpus copy of those fields and the same guess), the weather and event
lookups of the moment (it uses what the collector recorded at the reading), and
which venues users open (the card counts only served venue-hours).

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
> 45-column shape (44 until round 25 appended `events_observed`), so this
> cannot recur silently, but do not try.

For the October 2026 run use the command block in "The mid-October 2026
retrain" above; it is this procedure with that run's settings filled in.

```bash
# ── 0. PRESERVE THE INCUMBENT. Do this FIRST; it is unrecoverable afterwards.
cd backend/scripts/ml
mkdir -p models/incumbent
cp models/crowd_model.onnx models/model_metadata.json models/incumbent/
cp train/best_model.pkl train/features_holdout.pkl models/incumbent/
#    quick_eval.py FAILS THE GATE without models/incumbent/best_model.pkl.
#    features_holdout.pkl matters too: when the feature set changes (it will),
#    it is the only way to score the incumbent on the same holdout ROWS.
#    ONLY when train/ holds the pickles of the model being replaced. After a
#    run that did not ship (v2.7, the two-head and sports experiments), train/
#    holds that run's pickles or none, and this line would overwrite the true
#    incumbent. models/incumbent/ has held v2.6.0-starling's pair since
#    2026-08-18; check its model_metadata.json version before copying.

# ── 1. Clear stale artifacts so a partial failure cannot silently reuse them.
cd train
rm -f training_data.csv holdout_data.csv training_data.csv.partial holdout_data.csv.partial \
      features_train.pkl features_holdout.pkl best_model.pkl band_gate_report.json

# ── 2. Full pipeline, in this order. Never start in the middle.
node export_training_data.js                     # 45-column CSVs
head -1 training_data.csv | tr ',' '\n' | grep -c .   # must print 45
python prepare_features.py                       # contract-checked; see below
python train_model.py                            # LOCO CV -> best_model.pkl
python evaluate_model.py                         # diagnostics + plots
CROWD_QMAP_ENABLED=false python quick_eval.py    # POINT GATE; overall_pass stays
                                                 #  false, pending the band gate.
                                                 #  The map is 2.6.0-starling's own:
                                                 #  a new artifact gated through it
                                                 #  is refused at load.
MODEL_VERSION=2.6.0-<name> python export_model.py
node bandEval.js --gate --out=band_gate_report.json   # BAND GATE: overall_pass =
                                                       #  point AND band

# ── 3. Verify the artifact the way production reads it.
cd ../../..                                      # backend/
node --test

# ── 4. Read the gate before committing anything.
node -e "const m=require('./scripts/ml/models/model_metadata.json');
         console.log(m.model_version, JSON.stringify(m.ship_gate,null,1))"
#    overall_pass must be true, gate_basis 'holdout_realtime_served',
#    ship_gate.incumbent.no_regression must be true, point_gate_pass true and
#    band_gate_status 'pass'.

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
| the CSV is not the 45-column export | `venue_id` drives baseline smoothing, `label_provenance` drives the vendor-forecast weight; without them both were skipped in silence. Round 20 appended `label_source` and `vendor_forecast_pct` as CARRIED columns (validated and pickled, never features) — a CSV without them would still train, which is why their absence has to be an error: it means the file predates the exporter |
| `label_source` carries a value outside `{live, forecast}`, or `label_provenance` is not what `(is_realtime, label_source)` implies, or a `forecast` row disagrees with its own `vendor_forecast_pct` | the derived column is a pure function of the raw one, so the two check each other; a mismatch means a row rejoins the weight-1.0 pool as `unknown` with nothing said |
| a weather description is not in `WEATHER_DESCRIPTION_CODES` | guessing a group is inventing data — add the OpenWeatherMap id |
| no `weather_condition_code` survives recovery | all ten `weather_*` features would be constant again |
| any row lacks `month` / `season` | `month=0` with four zero season one-hots cannot occur at inference |
| a realtime row's `label_provenance` is `unknown` (round 26: EXCLUDED from both frames, not refused; `ML_ALLOW_UNKNOWN_PROVENANCE=true` admits them at the live weight and the artifact records it) | 457,402 rows predate `label_source` and cannot be told from a vendor forecast (migration 025). Since 2026-09-01 they sit beside rows that PROVED they are live, and the old all-unknown guard could no longer fire. There is no downweight tier for them because `train_model.assert_weighting_matches_provenance` allows one weight per non-forecast realtime row. Today this leaves 4,577 training rows (below the 50,000 floor) and a holdout with no realtime rows: the corpus has no live-labelled holdout yet, and the hatch is the only honest way to run until collection reaches a holdout city |
| `nearest_event_type` carries a value outside `music / sports / arts / family / other` that no alias covers | the `etype_*` one-hot cannot describe it, so the row trains as `has_nearby_event = 1` with five zero slots. `concert` and `film` (what `eventService.js` wrote until 2026-09-04, 1,964 live rows) are mapped by the fixed function's own reading (`concert -> music`, `film -> other`); anything else needs the writer fixed and its reading added to `LEGACY_EVENT_TYPE_ALIASES`. The exporter's preflight census names every value outside the vocabulary before the run |
| any row lacks a finite `latitude` / `longitude` | astronomy, the climate norm and the neighbour grid derive from them; the old `fillna(0)` trained such a row at 0N 0E |
| a feature column still carries NaN after every named fill | the blanket `fillna(0)` is gone (round 26). Each feature has its own fill with its own argument; a NaN here is a fill somebody forgot, and 0 is not neutral for any column in the matrix. The weather fills are now the ones serving performs on an outage: temperature takes the `(lat_band, month)` climate norm fitted from OBSERVED readings only (else the table mean), humidity 50, wind 0, is_raining 0, `weather_unknown = 1`; the city-month median that gave every weekly venue-batch one fabricated temperature is gone |
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

## Before you score anything ad hoc: the pickle does not match the shipped model

If you are about to write a throwaway script that loads
`train/features_holdout.pkl` and feeds it to `models/crowd_model.onnx` to test an
idea, read this first. Measured 2026-09-06:

```
metadata features: 106 | pickle features: 106
positions that differ: 19
in metadata not pickle: gtype_bakery
in pickle not metadata: gtype_night_club
```

The two are the same LENGTH and different ORDER, which is the worst combination:
onnxruntime consumes positions, so nothing throws, nothing warns, and every
number you get is confidently wrong. The pickles on disk are from a later
`prepare_features.py` run than the shipped v2.6.0 artifact, which is normal and
not a defect in either.

**Remap by NAME before scoring**, using `model_metadata.json`'s `feature_names`
as the order and zero-filling any column the pickle lacks. A correct remap
reproduces the shipped MAE of 29.34 on the served gate slice; if your number is
not close to that, your matrix is scrambled and nothing downstream of it means
anything.

THE SHIP GATE ITSELF IS NOT EXPOSED TO THIS, and the distinction matters. It
scores a model it has just trained against a matrix it has just prepared, and
`quick_eval.py` additionally refuses to run if `features_train.pkl` and
`features_holdout.pkl` disagree on their columns (it reads `is_realtime` out of
X by position, so a mismatch would silently select the wrong gate rows). The
exposure is ad-hoc measurement only. It is written here because ad-hoc
measurement is how every idea in this directory starts.

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
points and clearing the R² arm by 0.0126, and the gate slice included realtime
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

**The decision this section was written to wait for was taken on 2026-08-28:
within-10 is the primary metric, because it is the one number a user feels.**
The qmap serves by default from the same day. The arming interpretation, since the
draft predated the decision: the legacy arms and B1-B3 are ALTERNATIVE
admission paths (a routine retrain that spends no MAE ships the old way; a
deliberate dispersion-spending candidate ships the B way), the floor binds on
both, an honest incumbent comparison is required on both, and B4 re-verifies
the fixed table by enumeration per run. `quick_eval.py` gate_b() implements
it and `ship_gate.admission_path` records which path admitted every artifact.
The draft below is kept as written.

**The draft (2026-08-20), as it stood before arming.** `quick_eval.py` implements the four criteria
above and only those. GATE-B is written down so the trade it describes can be
taken deliberately, in one recorded decision, instead of being smuggled in as
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

**Re-verified against the code on 2026-09-25**, finding by finding, with the
three defects the audit's section 0 confirmed listed first (K1-K3). Every
blocking finding is closed in code. Two gaps turned up while checking: the
runbook still said 44 columns (fixed here), and the served baseline and the
trained one disagreed on one shape of slot (fixed here, row 3).

| # | Finding | Status 2026-09-25 | Evidence in the current code |
|---|---|---|---|
| K1 | `collectWeekly.js` wrote BestTime's array index into `hour` | **FIXED** | `bestTimeSlotToLocal` writes `(slot + 6) % 24` and rolls the day forward for slots 18-23, for every row (collectWeekly.js, the per-day loop), stamping `hour_axis = 'venue_local'`; migration 023 rotated the history; `buildBaselines.js` and the exporter refuse an undeclared weekly row; `discoverBestTime.js` routes through the same function. Data: on the September live readings the weekly curve matches best at 0 and −1 h and is 8-15 MAE worse at ±6 h |
| K2 | Two writers of `ml_venue_baselines` with different definitions | **FIXED** | `collectRealtime.run()` calls `buildBaselines.refreshCollectedBaselines` (weekly, venue-local only); the exporter's `BASELINE_AGGREGATE_SQL` is the same statement, proved row by row in `mlExportContracts.test.js`. The third writer (`storeGoogleBaselines`) is unreachable from every request path; see #14 below |
| K3 | Realtime rows stamped with the baseline of a slot six hours off | **FIXED, and inert** | `storeReading` reads weekly rows at the reading's own `obs.dayOfWeek`/`obs.hour` with `hour_axis = 'venue_local'`; and nothing reads the stamped column: the exporter recomputes `baseline_busyness` from the weekly aggregate, `buildRecentDeviation.js` joins `ml_venue_baselines` |
| 1 | Stale 40-column CSVs; runbook started after the export | **FIXED in code; the runbook said "must print 44" until today** | `prepare_features.py` raises `CorpusContractError` on any CSV that is not the 45-column export (44 until round 25 appended `events_observed`), naming the missing columns and telling you to re-run the exporter. Runbook starts at step 0 (preserve incumbent) then `node export_training_data.js`; the header check now expects 45, step 1 also removes the interrupted `.partial` export, and step 0 warns that copying `train/` pickles into `models/incumbent/` would overwrite the true incumbent after a run that did not ship. |
| 2 | No unique constraint on `ml_training_data`, so `ON CONFLICT DO NOTHING` is a no-op | **FIXED** | Migration `024_ml_training_data_unique_slot.sql` collapses the duplicates and adds the key; `collectWeekly.js` upserts `ON CONFLICT (venue_id, day_of_week, hour) WHERE collection_mode = 'weekly' AND hour_axis = 'venue_local'`, `collectRealtime.js` inserts `ON CONFLICT (venue_id, day_of_week, hour, observed_date) WHERE ... DO NOTHING`, and both refuse to run without the index (`requireSlotIndex`). The index shape deviates from the one specified here; see "The unique key on `ml_training_data`" below for why the `COALESCE(observed_date,'1970-01-01')` form would have destroyed data. `mlCorpusDedupe.test.js`. |
| 3 | Positional `shift(1)` smoothed an hour against itself on duplicate rows | **FIXED; a parity gap FIXED 2026-09-25** | `smooth_baseline_hours()` blends on a complete 7×24 grid against the true clock neighbours. It still differed from `mlPredictor.blendBaselineRows` on one shape: a slot whose own baseline row holds 0 beside a positive neighbour, which production blends to a positive baseline and serves with the MODEL, and training kept at 0 and then dropped. That was 202,030 rows of the local corpus (195,619 weekly edge-of-opening slots, 160 live September readings). `slot_has_baseline_row` now mirrors production; `__tests__/mlSmoothingParity.test.js` runs both implementations over one random grid (the pre-fix code disagrees on 377 of its 1,488 rows). |
| 4 | `weather_condition_code` NULL on 100% of rows → ten constant features | **FIXED** | `collectRealtime.js` writes `weather.conditionId` (every live reading in the local export carries one); `collectWeekly.js` writes NULL weather on purpose (a typical week has no moment), and `repairWeeklyWeather.js` cleared the old weekly weather on 2026-09-05; `recover_weather_codes()` still maps legacy descriptions and stops on an unmapped one. |
| 5 | 62.9% of rows carry `month=0` with all four season one-hots at 0 | **FIXED as written; the epoch it warned about is MEASURED and belongs to the retrain** | `collectWeekly.venueCalendar` stamps `month`/`season`, migration 024 backfilled from `collected_at`, and `prepare_features.py` refuses a row without a month. The limitation this row always named is now a number: in the shipped booster `month` carries 20.1% of all split gain (274 of 800 root splits), and in September it adds about +4.5 points to every served prediction. The plan above drops the month family (`FLOCK_CALENDAR_POLICY=drop`). |
| 6 | Gate measured on holdout rows production refuses to serve | **FIXED** | `quick_eval.py` imports `serving_population_mask` from `prepare_features`, applies it to the gate slice, persists `excluded_no_baseline_rows` and keeps the unfiltered figure as a labelled diagnostic. `mlPipelineContracts.test.js`. |
| 7 | No incumbent comparison, and this document claimed there was one | **FIXED** | `quick_eval.compare_incumbent` scores `models/incumbent/` on the same rows and fails the gate without it; since 2026-09-25 the band gate also replays `models/incumbent/` through the serving code on the time holdout. |
| 8 | Gate structurally blind to corpus-wide corruption; v2.5 passed by 0.0126 | **FIXED** | The MAE arm may not regress; the within-10 floor is the incumbent's measured figure on the same rows; `evaluate_model.py` prints the corpus mean by hour; and `dinnerPeakAccuracy.test.js` PART 3 (the audit's `dinnerPeakAccuracy.test.js:332`, now at line 350) was inverted on 2026-08-18 to assert that the exported artifact's category peaks sit in the evening and that the old +6 h shift makes them worse, which the runbook's `node --test` step runs on the new artifact. Strengthened 2026-09-25: the band gate scores the artifact against live readings taken on the venue's own clock, which share nothing with the baseline comparator, so a corpus-wide error can no longer cancel. |

The non-blocking findings that touch label or feature quality, re-verified the
same day:

| # | Finding | Status 2026-09-25 |
|---|---|---|
| 9 | confidence published from the blend | **FIXED.** `readServedAccuracy` publishes `training_metrics_by_population.realtime_served.within_15`, or `QMAP_MEASURED` with the map on. Both are spring-slice measurements; the plan publishes the band gate's live figure after the retrain |
| 10 | per-hour diagnostic on misaligned rows; unweighted LOCO refit | **FIXED.** `hour` and `venue_category` travel in the pickle; the refit passes `sample_weight` |
| 11 | metadata rewritten from scratch | **FIXED.** Merge plus a named eviction list; `run_training.sh`'s summary reads `training_loco_cv`; `evaluate_model.py`'s plotting imports are guarded |
| 12 | weekly rows carry one weather snapshot | **FIXED.** NULL weather on weekly rows; 0% of weekly rows in the local export carry a temperature |
| 13 | `venue_feedback` join is a lookahead | **OPEN, dormant.** The aggregate is 28 days back from NOW(), not from each row's date (`export_training_data.js`, the `fb` subquery); 0 verified feedback rows exist, so all four features are constant. The plan drops them |
| 14 | third baseline writer; `source` not reset | **OPEN, dormant.** `storeGoogleBaselines` is unreachable from every request path; `buildBaselines`' upsert still does not reset `source` |
| 15 | event features alive in training, dead in production | **CHANGED.** `TICKETMASTER_API_KEY` is set in production, so serving computes them; live readings record `events_observed` (99.9% of the local live rows, 1,467 with an event). The spring corpus's defaulted negatives remain (54% of rows sit in cities with zero events, `export_v28.log`) |
| 16 | city imbalance | **OPEN.** Beijing holds 2,057 rows; the plan drops it |
| 17 | unknown cities skipped silently; city clock; US holidays | **PARTLY FIXED.** Each reading uses the venue's own zone (`getLocalTime(venue.timezone \|\| cityConfig.tz, startedAt)`); an unknown city is still skipped without a log line (`sweepVenues`); the US calendar still applies everywhere, inert while collection is Pennsylvania and Miami |
| 18 | `is_realtime` a provenance feature kept for itself | **CONFIRMED** (was SUSPECTED). 6.1% of the shipped booster's gain, 197 splits at depth 0-1, constant 1 at serving. **Closed 2026-09-26**: out of the feature set, refused by `train_model`, all six positional readers take the carried key (`prepare_features.realtime_flags`) |
| 19 | repeatability gaps | **FIXED.** Device and library versions recorded, `MODEL_VERSION` warned, CPU path bit-reproducible |
| 20 | coordinate-keyed identity | **FIXED 2026-09-26.** `add_neighbor_features` keyed venues on rounded coordinates and used a 0.005° grid over smoothed baselines where serving uses a ±0.0075° box over raw ones (the count differed on 58.6% of live September readings). It now rebuilds serving's table per venue_id from the raw export and computes `getNeighborActivity`'s arithmetic; `mlNeighborParity.test.js` requires equality with the real function on a random grid |
| 21 | holiday features near-constant | **CHANGED.** Labor Day 2026-09-07 gives `is_holiday` its first 1,174 live readings |

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

## Holiday / holiday-eve features (plumbing spec)

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

**~~Still broken, deliberately out of scope of that change:~~ FIXED 2026-09-04.**
`scripts/ml/discoverBestTime.js` `insertForecastData()` wrote the raw `day_raw`
index and never set `hour_axis`, so since 023 every row it wrote was rejected by
the axis CHECK — logged per row, "Training rows inserted: 0", exit 0. It now
routes the slots through `collectWeekly.bestTimeSlotToLocal` (imported, not
copied, because migration 023's SQL is pinned against that same function), sets
`hour_axis`, and names migration 024's weekly arbiter in its ON CONFLICT.
`database/ml-schema.sql` and `initTables.js` still predate the column;
migrations are the source of truth, and both collectors self-create it anyway.

The same pass fixed the more expensive half of that script: it minted a pseudo
`bt_<besttime_venue_id>` google_place_id and upserted on it, so a venue already
stored under its real Google place id got a SECOND ml_venues row. 933 BestTime
venue ids are held by two or more rows in the 2026-09-03 dump, 111 of those
groups are active philly/lehigh venues, and the hourly realtime cron pays two
credits and writes two rows for each of them. The arbiter is now
`besttime_venue_id`; migration `060_ml_venues_besttime_identity.sql` gives that
column its unique index and drops `ml_venues.review_count`'s `DEFAULT 0`; and
`scripts/ml/repairBestTimeDiscoveredVenues.js` merges the groups already stored
(report only by default, `--commit` to write). **Run it before the next export**
— `train/export_training_data.js` joins `ml_venues`, so until it runs both
copies are exported and every per-venue average and category baseline counts
the same building twice.

`train/prepare_features.py` also stopped filling a missing `review_count` with
0 and now fills it with the corpus median, published as
`median_review_count` in `venue_metadata` for the holdout. **Before the next
model ships, `services/mlPredictor.js` `buildFeatureMap` must read that same
median instead of `|| 0`**, or the model is trained with one fill and served
with another.

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

Two fresh collection windows were approved for purchase. The order below is load
bearing; the traps it guards against are pinned in
`__tests__/besttimeRefreshPrep.test.js`.

1. **SUPERSEDED 2026-09-01, kept for the record.** Collection restarted that
   day on a Pro Package 100 plan ($119/month, a FIXED allowance, not metered),
   the key lives on the Railway BESTTIME service by design, and that service
   ran `collectRealtime.js` once a night at 02:00 UTC rather than sweeping
   every three hours. The paragraph that follows described the state before
   that decision and the $4,500/day figure only ever applied to a metered key
   on the old three-hour schedule, neither of which exists now. (**Cadence
   corrected 2026-09-06:** it is hourly, cron `7 * * * *`. The nightly slot in
   this paragraph is the 2026-09-01 state. Under Package 100 the schedule costs
   nothing either way, because the plan meters new venue admissions and not
   calls.)
   *Original text:* Revive the existing BestTime account, from the vendor
   dashboard. The 403 is account level, and the stored `besttime_venue_id`s
   belong to that account: a fresh account re-forecasts all 1,915 PA venues by
   name at 2 credits instead of 1, $153 per window instead of $77. Basic
   metered plan, $0.04 per credit, $29/mo minimum. The key goes in
   `backend/.env` locally and never onto Railway: the dead BESTTIME cron
   service there sweeps every 3 hours and would spend roughly $4,500/day on a
   metered key.
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

The standing instruction: spend on model quality, and treat the budget as a
guideline rather than a wall. Tier prices VERIFIED off the live
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
the instruction this round was value over the ceiling. Confirm with BestTime
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
their contact address, both free and worth doing before September's
invoice.

## Prep status (2026-08-29 evening): everything staged, NOTHING spends without an explicit go

The standing order: get everything ready for SportsDB and BestTime, but do not
use BestTime yet. The rule in force: NO BestTime API call of any kind without a
fresh, unambiguous go. State:

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
  when the philly refresh was stopped seconds after usage was paused).
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

The armed sequence, in order, once BestTime is cleared to spend:
1. finish addDemandVenues dry run, review, `--commit`
2. `node scripts/ml/collectWeekly.js --city=philly --only-found` (843)
3. `node scripts/ml/collectWeekly.js --city=lehigh --only-found`
4. `--skip-attempted` runs to admit the committed want-list by name
5. arm the nightly live pilot (infrastructure decision rides with him:
   this machine sleeps, so nightly means either his PC on a schedule or a
   deliberately created Railway cron, which is his call, not an autonomous
   one)

## The BESTTIME cron service: what it is and how it breaks (audited 2026-09-01)

> **The cadence in this section is historical. Corrected 2026-09-06.** It runs
> HOURLY now, cron `7 * * * *`, verified against the Railway service config on
> that date, with the start command carrying
> `--holdout-city=miami --holdout-utc-hours=15,23`. Everything below was
> written for the nightly slot and is kept as the record of it, so read
> "nightly" as "at the time of the audit" wherever it appears. The change had a
> cost nobody noticed for days: `services/collectionHeartbeat.js` kept a
> healthy-row floor of 200 that had been sized for one nightly run, against a
> measured 3,779 rows per window under the hourly one, so a collector down to
> 6% of its yield still reported healthy. Fixed the same day, along with a
> second floor on how many distinct hours the rows landed across, because a
> cron that stops firing keeps a passing row count for most of a day.

The nightly pull runs on Railway service BESTTIME (project trustworthy-spirit,
`node scripts/ml/collectRealtime.js`, cron `0 2 * * *`, restart NEVER). An
audit hours before its first real run found two faults that would have wasted
the whole five months quietly, both fixed the same evening:

1. **It was pinned five commits behind main.** Its last deploy carried the
   240-calls-a-minute pacing that had already earned two key blocks that day,
   without the 60-second 503 cooldown or the event-provenance columns. A
   nightly run on that build aborts in about twenty seconds against a throttle
   wall and writes nothing.
2. **It never auto-deployed, which is why.** Its root directory was
   `/backend` with a leading slash where the main service uses `backend`, and
   the path never matched, so it sat on an August build through two weeks of
   backend pushes. Corrected to `backend`. If a future collector fix does not
   appear in the service's deploy list, check this first.

What the audit cleared, so nobody re-investigates it: the 2,500 credit
ceiling does not bind (the PA selection is 1,408 venues, and the corpus
ceiling is about 2,010 even fully admitted), so the start command needs no
arguments; a full run takes 47 to 60 minutes at one call a second, and
Railway imposes no execution timeout, only skipping an occurrence while one
is still running; `PGSSLMODE` is correctly absent because the internal
DATABASE_URL carries no sslmode and pg keeps its permissive default; and
production really does have the migration 045 provenance columns, so the
insert cannot throw on them.

### The open-hours filter (2026-09-03), and what it does and does not buy

`collectRealtime.js` no longer calls a venue that its own weekly forecast curve
says is shut at that venue's local hour. "Open" means the venue's weekly curve
(the `venue_local` rows, migration 023) rises above zero somewhere in H-2..H+2
on any day of the week, and only a venue whose weekly rows cover all 24 hours
may be judged at all. A venue with no weekly rows, a venue with a partial curve,
and a run whose lookup fails are all called anyway. Nothing about a written row
changes — `hour`, `hour_axis`, `label_source`, provenance and the ON CONFLICT
key are untouched — and `--no-open-hours` stands the filter down for a run.

The window is `+/-2` because it was measured, not chosen: over all 1,198 live
readings in the corpus, a same-day-of-week rule would have dropped 29 of them,
week-wide with no padding 18, `+/-1` seven, and `+/-2` none.

What it buys, measured against production on 2026-09-03 for the 1,414-venue PA
selection: at the then-current `0 2 * * *` slot (22:00 local) only about 15% of
the calls go away, because at 10 PM almost everything is open. The saving is in
the hours that slot never reached: 50% of the sweep goes away at 04:00 UTC, 78%
at 08:00 UTC, 69% at 10:00 UTC and 49% at 12:00 UTC. Adding a morning occurrence
in that window costs roughly a quarter of a sweep rather than a whole one, which
is the point of it. Over a full 24 hours the average sweep is 993 calls instead
of 1,414, so 70% of the old cost.

That last figure stopped being a projection on 2026-09-06. The cron is hourly
now, so every one of those cheap hours is being used, and the measured result is
the one this paragraph predicted: 3,779 rows landed in the trailing 26 hours
spread across all 26 of them, per-hour mean 140, against roughly 1,400 rows a
day under the nightly slot. The open-hours filter is what makes that affordable,
and the corpus rate it produced is what exposed the stale heartbeat floor.

Two residuals worth knowing rather than fixing tonight. A refusal (over the
ceiling, or zero venues selected) exits 0, so Railway reports SUCCESS and
only the collection heartbeat would notice. And the clock and weather are
read once per city before the loop, so every row in a run carries the same
hour and temperature, which is consistent and legal but means five months of
observations all sit at one hour of the night.

## The five-month commitment and the capture-everything rule (2026-09-01)

The commitment made the day collection restarted: keep BestTime about five months
(September through January, roughly $595 at Package-100, plus $45 SportsDB)
and make sure every row lands with every feature it can carry, because the
Ticketmaster autopsy proved uncaptured context is unrecoverable. The audit
that followed found rows already carry venue-local time (hour, axis, day,
month, season, observed date, collection timestamp), full weather including
condition codes, holiday and school-break and special-night calendars, venue
attributes, label provenance with a refusal guard, and vendor forecasts.
The one hole was events: the realtime collector measured nearby events but
never stamped migration 045's provenance, and the event service returned
the same empty answer for an outage as for a genuinely quiet night. Both
fixed at the source: fetchers return null when they cannot answer (missing
key included, and SEATGEEK_CLIENT_ID is unset everywhere today, which had
been silently voting "answered empty"), getNearestEvent carries observed
and reason, the realtime collector stamps both columns, and weekly rows
stamp false with no_observation_date, the migration's own vocabulary for a
typical week. Standing chore for the five months: re-run
collectSportsSchedules.js monthly, because the NBA and NHL 2026-27
schedules were only partially published at first pull and reschedules
drift.

## Ticketmaster backfill: CLOSED, impossible (measured 2026-09-01)

The backlog carried "Philly Ticketmaster event backfill + ablation" since
2026-08-28. A research pass killed it with a clean experiment: Discovery v2
returns ZERO events for any past window (June mid-corpus window: 0; a window
that ended ten days ago: 0) while an identical future-window control returned
77 events across 16 pages, so the key and query shape are proven good and
the API simply drops events once they occur, on every tier. No call budget
fixes unfetchable data. The intended experiment, real historical event
signal on PA rows then ablate, is exactly what the sports pipeline already
delivers (62 distinct game-days, 119 games, inside the corpus window of
2026-03-10 to 2026-05-18, counted from sports_events.csv on 2026-09-01; an
earlier version of this line said 146, which no count of the file supports,
real schedules,
no attendance guessing) via FLOCK_SPORTS_FEATURES=1 plus sports_ablation.py.
The only path to real GENERAL event features is forward accumulation:
collectEvents.js is currently wired into nothing; putting it on a cadence
would let post-045 provenance stamp future rows honestly. That is a decision
for when collection economics are settled, not a backfill.

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

The options are to be exhausted before any of this gets built. The sequencing
decision: **BestTime first.** Nothing below starts until that is sorted, so this
section is a plan awaiting approval, not a queue.

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

**Two product uses, approved 2026-08-29, sequenced after the
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

**The verdict was challenged, and the challenge was RIGHT about the
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
