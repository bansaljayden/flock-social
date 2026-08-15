# Pre-retrain data-integrity audit

Read-only audit of the crowd-model pipeline, collection → serving, done before a
retrain so the retrain is not spent on a corpus that corrupts its own inputs.
Nothing here was fixed; this is a work order.

**Scope of evidence.** Everything below is derived from the code in this repo and
from the checked-in artifacts (`train/training_data.csv`, `train/holdout_data.csv`,
`train/*.log`, `models/model_metadata.json`). **No database was queried.**
`backend/.env` points at the live Railway database and the repo quarantines it, so
prod row counts, duplicate counts, and the current state of `ml_venue_baselines`
are inferred from the 2026-08-12 export snapshot, not observed. Claims are marked
**PROVEN** (code + artifact) or **SUSPECTED** (with the named way to confirm).

**Counts.** 21 findings. **8 BLOCKING** (fix before the retrain or the run is
wrong or wasted), 13 NON-BLOCKING.

---

## 0. The three known defects — confirmed, not re-litigated

Confirmed against current code, in one paragraph each, so a fixer can see they are
still live:

1. **`collectWeekly.js` writes the BestTime array index into `hour`.**
   `collectWeekly.js:141-151` — `for (let hour = 0; hour < day.hours.length …)` and
   `params.push(venue.id, jsDayOfWeek, hour, …)`, where `day.hours` is
   `day.day_raw` (`bestTimeService.js:102`). `buildBaselines.js:41-58` copies the
   column verbatim. Still live.
2. **`collectRealtime.js:215-225` refreshes `ml_venue_baselines` with
   `WHERE t.busyness_pct IS NOT NULL` and no `collection_mode` filter**, while
   `buildBaselines.js:52` filters to `'weekly'`. Two writers, two definitions,
   last-writer-wins. Still live.
3. **`collectRealtime.js:134-140` stamps `baseline_busyness` by reading weekly rows
   at `local.hour`**, i.e. against a slot six hours off. Still live.

Two consequences of #1 that are *not* in the existing write-up and that a fixer
needs to plan for:

- **The day is wrong too, for a quarter of the weekly rows.** BestTime day *D*
  covers local *D* 06:00 → *D+1* 05:59, so stored buckets 18–23 (local 00:00–05:59)
  belong to the following calendar day but are stored under `bestTimeDayToJsDay(D)`.
  Any fix must roll the day forward, not just add six.
- **The category baselines shipped in metadata are on the same bent axis, and they
  are a second serving surface.** `build_category_baseline_maps`
  (`prepare_features.py:323-358`) groups on `['venue_category','day_of_week','hour']`
  over a corpus that is 89% bucket-index rows and 11% true-local rows, and
  `mlPredictor.buildFeatureMap` reads that map with a true local hour
  (`mlPredictor.js:1005-1011`). Fixing `ml_venue_baselines` alone does not fix
  `category_baseline` / `refined_category_baseline`; only a retrain does.

Also checked and **clean** — say so, so nobody re-derives it:

- **Day-of-week numbering agrees everywhere.** `config.bestTimeDayToJsDay`
  (Mon=0→Sun=0 convention), `getLocalTime`'s `weekdayMap` (Sun:0), JS `getDay()`,
  Postgres `EXTRACT(DOW)` (0=Sunday, per `021_backfill_feedback_local_buckets.sql:60-63`),
  `prepare_features.add_temporal_features` (`is_weekend = dow in [0,6]`,
  `is_friday_saturday_night = dow in [5,6]`), and `mlPredictor` (same two) are all
  Sun=0. No day-numbering bug found.
- **The train/holdout split is city-level, not row-level.**
  `export_training_data.js:26` splits whole cities (miami, tokyo, barcelona) into a
  separate file; `train_model.py:178` uses `GroupKFold` grouped on city. There is no
  random row split across a venue's own hours anywhere. This is the correct shape.
- **DST is handled correctly where dates exist.** `config.getLocalTime` uses
  `Intl.DateTimeFormat` with the IANA zone; migration 021 uses `AT TIME ZONE`;
  `predictHourlyForecast` reads its label off the timestamp it actually scored
  (`mlPredictor.js:1328-1339`). Weekly rows are dateless so DST cannot apply to them.

---

## BLOCKING — fix before the retrain

### 1. The checked-in CSVs are a pre-round-10 export, and RETRAIN.md's runbook starts *after* the export step

**What is wrong.** `train/training_data.csv` and `train/holdout_data.csv` on disk
have **40 columns**. The current `export_training_data.js` `HEADER`
(lines 204-221) has **42**: the two missing ones are `venue_id` and
`label_provenance`. RETRAIN.md's runbook (lines 27-35) begins at
`python prepare_features.py` and never mentions `node export_training_data.js` —
which *is* step 1 of `run_training.sh` (line 19). Anyone following the documented
runbook retrains from these stale CSVs.

**Evidence (PROVEN).**
```
$ head -1 backend/scripts/ml/train/training_data.csv
day_of_week,hour,month,season,is_holiday,is_school_break,venue_category,price_level,
rating,review_count,temperature,humidity,wind_speed,weather_condition,
weather_condition_code,is_raining,event_nearby,event_distance_km,event_size,
event_type,event_hours_until,has_nearby_event,nearest_event_distance_km,
nearest_event_attendance,total_nearby_events,total_nearby_attendance,
nearest_event_type,baseline_busyness,is_realtime,busyness_pct,city,google_type_1,
google_type_2,google_type_3,latitude,longitude,avg_user_crowd,user_feedback_count,
avg_prediction_error,observed_date        ← 40 fields, no venue_id, no label_provenance
```
mtimes agree: CSVs 2026-08-12 16:35, `export_training_data.js` 2026-08-14 00:01,
model `trained_at` 2026-08-12T20:47Z.

**What it corrupts.** `prepare_features.py` degrades *silently* on this file — every
guard is a soft one:
- `if 'venue_id' in df.columns` (line 373) is false → **the baseline hour-smoothing
  block is skipped entirely**, so the model learns deltas against raw baselines while
  `mlPredictor.getBaseline` serves a 0.6/0.2/0.2 smoothed one. That is the exact
  defect round 10 claimed to fix; it landed in code but never in an artifact.
- `if 'label_provenance' not in train_df.columns: … 'unknown'` (line 594) → **every
  vendor-forecast label is weighted 1.0**, the thing round 10 introduced the column
  to stop. `prep_v25.log` confirms it: `sample_weight = np.where(is_realtime == 1,
  1.0, 0.05)` — no forecast tier at all in the version that produced the shipped model.
- Because `venue_id` was added in round 10 and the leave-one-out baseline SQL is
  round 13 (`export_training_data.js:66-83`), the CSV necessarily predates the LOO
  change too — so **each row's `baseline_busyness` contains its own label**, the
  self-inclusion leak. (PROVEN that the CSV predates round 10; the LOO conclusion
  follows from the file's own round ordering — call it strongly implied, confirmable
  by re-exporting and diffing the `baseline_busyness` column.)

**Fix.**
1. Rewrite the RETRAIN.md runbook to start with `node export_training_data.js` (or
   just to say "run `./run_training.sh`").
2. Make `prepare_features.py` **fail**, not warn, when `venue_id` or
   `label_provenance` is absent. A silent degrade on the input file is how three
   fixes shipped without ever reaching an artifact.
3. Delete the stale CSVs and pickles before the run so a partial failure cannot
   fall back to them.

**BLOCKING.**

---

### 2. `ml_training_data` has no unique constraint, so `ON CONFLICT DO NOTHING` is a no-op and every collection re-run stacks the corpus

**What is wrong.** `collectWeekly.js:157-163` inserts 168 rows per venue with
`ON CONFLICT DO NOTHING` and no conflict target. There is no unique index for it to
hit: `migrations/006_ml_tables.sql:39-72` and `database/ml-schema.sql` declare only
`id SERIAL PRIMARY KEY` plus four non-unique indexes. The clause is decorative.

**Evidence (PROVEN).** No `UNIQUE` on `ml_training_data` in either schema file
(`grep UNIQUE database/ml-schema.sql` returns only `ml_venues.google_place_id` and
`ml_events.ticketmaster_id`). And the corpus already carries the duplicates: a
streaming scan of `training_data.csv` over 300 sampled venues (keyed on lat|lng, so
this is a lower bound — distinct venues sharing coordinates merge):

```
venue-dow-hour-mode cells 29,490   cells with >1 row 4,743 (16.1%)   max 8
  WEEKLY cells    n=27,305  mean=1.16  p90=2  max=3
  REALTIME cells  n=2,185   mean=2.05  p90=4  max=8
```

**What it corrupts.** Every average keyed on (venue, dow, hour) — the stored
baseline, the LOO baseline, the category baselines — is an unweighted mean over an
uneven number of repeats, so re-collected venues silently count more. It is also
what makes finding #3 fire. And the next weekly collection run before the retrain
will add another full copy without a word in the logs.

**Fix.** Add a unique index and give the insert a real conflict target:
`CREATE UNIQUE INDEX CONCURRENTLY … ON ml_training_data (venue_id, collection_mode,
day_of_week, hour, COALESCE(observed_date, '1970-01-01'))` — weekly rows are a
single "typical week" per venue so they dedupe on the first four columns; realtime
rows are legitimately repeated across dates so they need `observed_date` in the key.
Then decide whether the existing duplicate weekly rows should be collapsed
(`DELETE … USING` keeping the newest per key) or averaged; collapsing is the honest
choice, since three snapshots of the same synthetic week are one observation.

**BLOCKING** — it changes what the retrain reads.

---

### 3. The baseline "hour smoothing" in `prepare_features.py` is a positional shift, so on duplicate rows it smooths an hour against *itself*

**What is wrong.** `prepare_features.py:373-381`:
```python
df = df.sort_values(['venue_id', 'day_of_week', 'hour'])
df['_bl_prev'] = df.groupby(['venue_id','day_of_week'])['baseline_busyness'].shift(1)
df['_bl_next'] = df.groupby(['venue_id','day_of_week'])['baseline_busyness'].shift(-1)
```
`shift(1)` is the previous **row**, not the previous **hour**. With *k* rows at the
same (venue, dow, hour), *k−1* of them get a neighbour from their own hour. The
comment above the block asserts this "mirrors `mlPredictor.getBaseline`'s runtime
blend (current×0.6 + prev×0.2 + next×0.2)". It does not.

**Evidence (PROVEN).** The code above, plus the duplicate statistics in finding #2
(16.1% of cells hold more than one row; realtime cells average 2.05 and reach 8).

**What it corrupts.** The delta label. Production reconstructs
`score = smoothed_baseline + clamp(delta)`; training would compute
`delta = busyness − near-raw_baseline`. Systematic offset on exactly the realtime
rows that carry weight 1.0. Note this defect is currently *masked* — the shipped
model skipped the block entirely (finding #1) — so it will appear for the first time
in this retrain, when `venue_id` finally arrives.

**Fix.** Compute the smoothing on a de-duplicated frame and merge it back:
aggregate to one row per (venue_id, dow, hour), reindex onto the full 0–23 hour grid
so a missing hour is a real gap rather than a silent skip, blend, then join. Or fix
finding #2 first, which makes the shift correct for weekly rows but still wrong for
repeated realtime dates.

**BLOCKING.**

---

### 4. `weather_condition_code` is NULL in 100% of the corpus — ten features are constant in training and live at inference

**What is wrong.** No collector ever writes the column. `collectWeekly.js:157-159`
and `collectRealtime.js:155-161` both insert `weather_condition` (the free-text
description) and omit `weather_condition_code`, even though
`services/weatherService.js:353` has exposed `conditionId` since the 2026-08-12
audit. `prepare_features.py:291` builds `weather_group` from that column and nothing
else.

**Evidence (PROVEN).** Column scan of all 3,574,442 rows of `training_data.csv`:
```
weather_condition            non_empty 3,287,799
weather_condition_code       non_empty         0        ← zero, of 3.57M
```
So `group_weather_code(NaN)` → `'unknown'` for every row: `weather_unknown` ≡ 1,
`weather_clear/few_clouds/cloudy/light_rain/heavy_rain/snow/thunderstorm/other` ≡ 0,
and `cold_outdoor` ≡ 0 (it requires `weather_clear == 1`).

**What it corrupts.** For a tree model a constant feature is never a split, so this
is not confidently-wrong numbers — it is worse in a quieter way: **the model has no
weather-condition signal at all**, ten of its 106 feature slots are dead, and the
careful `groupWeatherCode` parity work in `mlPredictor.js:536-547` and its unit test
are guarding a channel that carries nothing. At inference the vector sets
`weather_clear=1, weather_unknown=0`, a region with zero training support, which the
model simply ignores.

**Fix, before the retrain.**
1. Add `weather_condition_code` to both collectors' INSERTs, sourced from
   `weather.conditionId`.
2. Backfill history from the text that *is* there: `weather_condition` holds the OWM
   `description` on 3.29M rows ("light intensity shower rain", "few clouds", …).
   A description→group map recovers the feature for the whole corpus.
3. If neither is done, drop the ten columns from the feature set rather than
   shipping dead slots and a false parity guarantee.

**BLOCKING** — otherwise the retrain re-bakes the same ten dead features.

---

### 5. 62.9% of training rows carry `month = 0` and all four season one-hots at 0 — a combination that cannot occur at inference

**What is wrong.** `collectWeekly.js:157-159` omits `month` and `season` from its
INSERT, so weekly rows carry NULL for both. `prepare_features.py` computes
`month_sin/month_cos` from the NaN, then blanket-fills every feature column with 0
(lines 653-656). Result: `month = 0`, `month_sin = 0`, `month_cos = 0` (a
mathematical impossibility — cos of a real month is never 0 at these values), and
`season_spring = season_summer = season_fall = season_winter = 0`.

**Evidence (PROVEN).** `prep_v25.log`:
```
Missing values:
  month:     1302451 (62.9%)
  month_cos: 1302451 (62.9%)
  month_sin: 1302451 (62.9%)
```
and the raw CSV scan: `month` non-empty on 1,051,692 of 3,574,442 rows.
`mlPredictor.buildFeatureMap` always produces `month = ts.getMonth() + 1` ∈ 1..12 and
exactly one season at 1 (`mlPredictor.js:890-899, 989-992`).

**What it corrupts.** Two-thirds of the corpus sits in a corner of feature space the
serving path can never reach, and `month`/`season_*` are a perfect proxy for row
provenance (weekly vs realtime). **SUSPECTED consequence:** with `max_depth=8` the
model splits on `month == 0` and routes the 0.05-weight weekly "anchor" rows down a
branch that is never served — which would mean the v2.3.1 blend does not do the job
its comment claims ("enough anchor to calm typical nights"). *Named check:* dump the
booster and count splits on `month`, `month_sin`, `month_cos` and `is_realtime` near
the root; or retrain once with those columns excluded and compare the realtime
holdout slice.

**Fix.** Stamp `month`/`season` on weekly rows at collection time from the collection
date (they describe when the snapshot was taken, which is genuine information), or
backfill them from `collected_at` in the export, or drop the columns. Do not leave
them NaN→0.

**BLOCKING.**

---

### 6. The ship gate is measured on rows production refuses to serve

**What is wrong.** `prepare_features.py:584` filters **training** to
`baseline_busyness > 0` — explicitly, to match the serving population, because
`mlPredictor.js:1200-1205` routes any venue with no baseline to the rule engine. The
**holdout is not filtered** (the comment at line 576 says so deliberately). So the
gate slice — `hold_is_realtime == 1`, `quick_eval.py:102` — includes realtime rows
with `baseline == 0`, where the model's reconstruction is `0 + clamp(delta) ≤ 30`
against actuals up to 100.

**Evidence (PROVEN).** `prepare_features.py:584` (train filter) vs
`quick_eval.py:102-114` (unfiltered holdout mask). In the raw corpus 42% of rows have
`baseline_busyness <= 0` (CSV scan: 1,504,203 of 3,574,442), so a substantial share
of the 68,459 gate rows are of a kind production never scores with the model.

**What it corrupts.** The only gate that decides whether an artifact ships is
computed on a population that includes rows the product routes elsewhere. It drags
both the model and its comparator down, which is why the realtime slice shows
MAE 21.2 / within-10 29.2% — numbers that describe partly-unservable rows.

**Fix.** Apply `baseline > 0` to the gate slice in `quick_eval.py` and report the
excluded count. Keep the unfiltered number as a labelled diagnostic.

**BLOCKING** — the gate is the retrain's decision procedure.

---

### 7. There is no incumbent-model comparison anywhere, and RETRAIN.md says there is

**What is wrong.** RETRAIN.md lines 45-55 say the gate requires beating "both the
incumbent model and the popular-times baseline" and then: *"**Re-run the incumbent on
the same holdout every time** … `quick_eval.py` does this and writes the verdict into
`ship_gate`; trust it over any number typed in a doc."* `quick_eval.py` loads exactly
one model (`best_model.pkl`, line 60) and one comparator (`hold_baseline`, line 86).
It never loads a previous artifact.

**Evidence (PROVEN).** `quick_eval.py` in full — the only comparator is
`hold_baseline_pred = np.clip(hold_baseline, 0, 100)`. `eval_v25.log` records
`Model MAE 21.2073` vs `Baseline MAE 23.498` — the popular-times baseline, not a
prior model. The "21.46 vs 22.77" incumbent figures recorded elsewhere are **not
reproducible from these scripts** and appear in none of the checked-in logs.

**What it corrupts.** A retrain that is worse than v2.5 but still beats the raw
baseline passes the gate and ships. That is the single most likely failure mode of
the next run, since the corpus is about to change underneath it.

**Fix.** Before overwriting anything, copy the current `models/crowd_model.onnx` +
`model_metadata.json` and `train/best_model.pkl` to `models/incumbent/`. Add a step
to `quick_eval.py` that scores the incumbent on the *same* `features_holdout.pkl` and
requires `new_realtime_mae <= incumbent_realtime_mae`. **Caveat that must be handled,
not ignored:** if the feature set changes (it will — findings #4 and #5 both change
columns), the incumbent cannot consume the new `X`. The honest comparison is then to
re-run the incumbent through its own preserved `features_holdout.pkl`, on the same
holdout *rows*, and compare metrics — so preserve that pickle too, or accept and
label the comparison as approximate.

**BLOCKING.**

---

### 8. The gate is structurally blind to corpus-wide corruption, and v2.5 passed it by 0.0026

**What is wrong.** The gate (`quick_eval.py:169-193`) is
`model = baseline + clamp(delta)` versus `baseline`, on the same rows. Any error
shared by both sides cancels. A six-hour shift in `hour` moves the model's baseline
*and* its comparator's baseline identically, so the gate cannot see it — and did not.
The criterion is `MAE improvement ≥ 5 OR R² improvement ≥ 0.10`; v2.5 failed the MAE
arm by 2.7 points and passed the R² arm by 0.0026.

**Evidence (PROVEN).** `models/model_metadata.json`:
```json
"realtime_mae_improvement": 2.2907,
"realtime_r2_improvement": 0.1126,     ← threshold 0.10
"training_pass_diagnostic": false,
"holdout_pass_diagnostic": false
```

**What it corrupts.** The gate certifies *relative* improvement over a comparator
built from the same corrupt column. It cannot answer "are these numbers about the
real world."

**Fix.** Add absolute floors that a bent corpus fails:
- a hard assertion that the corpus's category peak hours land in the evening —
  the arithmetic already exists in `__tests__/dinnerPeakAccuracy.test.js` and
  currently *pins the wrong axis* (`test('the shipped corpus is on a BestTime bucket
  axis, not a venue-local one')`, line 332), so that test must be inverted as part of
  the clock fix rather than left asserting the bug;
- a floor on realtime within-10 (v2.5: 29.2%), so a model that is relatively better
  but absolutely useless does not ship;
- keep the OR, but require the MAE arm not to *regress*.

**BLOCKING.**

---

## NON-BLOCKING — fix with the retrain or immediately after

### 9. The confidence shown to users is measured on the tautological slice

`mlPredictor.js:1256` publishes `metadata.training_metrics.within_15` as the venue
card's `confidence`. That is 83.6 (metadata), the leave-one-city-out figure over a
training set that is 1,690,848 weekly rows to 379,391 realtime rows — rows where
label == baseline by construction. On the population actually served, `eval_v25.log`
records realtime within-10 = **29.2%**. The card claims ~84% accuracy for a model
that is within 10 points less than a third of the time on the rows it serves.
**PROVEN** (metadata + log + line 1256). Fix: have `quick_eval.py` write a
`serving_metrics.within_15` from the (baseline>0, realtime) holdout slice and serve
that; keep the existing `training_metrics` as a diagnostic.

### 10. `evaluate_model.py`'s per-hour diagnostic — the one plot that would have caught the clock bug — is computed on misaligned rows

`evaluate_model.py:300-306` plots `train_df['hour'].values[:len(y_train_all_eval)]`
against predictions, where `train_df` is the **raw** CSV (3,574,425 rows after
dropna) and `y_train_all_eval` is the **filtered** feature matrix (2,070,239). The
truncation aligns unrelated rows. Same for `plot_per_category`. Separately, line 234
refits every LOCO fold **without `sample_weight`**, so `evaluation.validation`
describes a model that was never trained or shipped. **PROVEN.** Fix: carry `hour`
and `venue_category` through the pickle alongside `cities`, and pass
`sample_weight[train_idx]` to the refit.

### 11. `prepare_features.py` rewrites `model_metadata.json` from scratch, which bricks the artifact if run out of order

`prepare_features.py:711-722` writes a fresh dict — no merge — dropping `ship_gate`,
`label_type`, `delta_clamp_range`, `onnx_input_name`, `model_version`,
`feedback_error_semantics`, `feature_types`. `mlPredictor.evaluateShipGate` fails
closed on a missing gate (`mlPredictor.js:117-119`), so re-running feature prep after
an export silently drops production onto the rule engine. Also `evaluate_model.py:383`
and `quick_eval.py:238` both write `metadata['evaluation']` in **different shapes**;
quick_eval runs last, so `run_training.sh`'s summary read of `evaluation.validation`
(line 64) always prints `?`. **PROVEN.** Fix: merge instead of overwrite, and make the
step order an assertion rather than a comment.

### 12. Weekly rows carry one weather snapshot stamped across all 168 hours

`collectWeekly.js:132` fetches weather once per venue and reuses it for every row of
that venue's week. `temperature`, `humidity`, `wind_speed`, `is_raining` on 89% of the
corpus therefore describe the collection moment, not the row's hour — and being
constant within a venue's block, they act as a partial collection-batch identifier,
which is memorisation fuel. **PROVEN** (code). Fix: write NULL weather on weekly rows
(`prepare_features.add_weather_features` already imputes) or zero their weather
contribution explicitly.

### 13. The `venue_feedback` join is a lookahead leak that has not fired yet, and RETRAIN.md's next lever would add a fourth clock

`export_training_data.js:118-126` aggregates `venue_feedback` **per venue over all
time**, with no cutoff and no `day_of_week`/`hour` key. A March training row would
carry August feedback, and `avg_prediction_error` is
`(20/50/80 mapped crowd_level) − predicted_score`, i.e. a label proxy minus a model
output. Today it is harmless: the CSV scan shows `avg_user_crowd`,
`user_feedback_count`, `avg_prediction_error` are **0 on all 3,574,442 rows** (no
verified feedback exists), so those five feature slots are dead like the weather
ones. **PROVEN.** The leak is armed for the first retrain after feedback accrues.
Separately, RETRAIN.md's "next lever 1" — emit each feedback row as a realtime
training row — would write `venue_feedback.day_of_week/hour`, which migration 021 just
fixed onto the **true venue-local clock**, into the same `hour` column that holds
BestTime bucket indices. That is a fourth clock; do not do it until finding #0.1 is
resolved. Fix: key the aggregate on (venue, dow, hour) and restrict it to feedback
older than the row's `observed_date`.

### 14. `ml_venue_baselines` has a third writer on a third clock, and its `source` column lies

`mlPredictor.storeGoogleBaselines` (lines 441-462) writes Google `popular_times` into
`ml_venue_baselines` at **true local hours** (index 0 = midnight), `source='google'`,
at request time — into the same table `getBaseline` reads and `getNeighborActivity`
averages. Meanwhile `buildBaselines.js:54-58` does `DO UPDATE SET baseline =
EXCLUDED.baseline, updated_at = NOW()` and **does not reset `source`**, so a row can
read `source='google'` while holding a collected value. **PROVEN** (code). Not a
training input — but it is a serving input and it feeds `neighbor_baseline_same_hour`.
Reconcile it in the same change as the clock fix.

### 15. Fifteen event features are alive in training and dead in production

The corpus has real event enrichment — `has_nearby_event` is 1 on 206,925 rows (5.8%)
via `enrichWithEvents.js`. But `TICKETMASTER_API_KEY` is unset on Railway (per
`CLAUDE.md`), so `getNearbyEvents` returns `noEvents` on every live prediction and all
fifteen `*_event*` / `etype_*` / `event_x_*` features are identically 0 at serving.
**PROVEN** (CSV scan + the documented env state). The asymmetry is in the safe
direction (serving is a subset of training), but the event work is currently
unrealised. RETRAIN.md line 205 says "event features currently zero" — that is true of
production, not of the corpus; worth correcting.

### 16. City imbalance makes two CV folds statistically empty, and the holdout blends three very different cities

`train_v25.err`: beijing contributes **48 rows** and sydney 5,714 to a
`GroupKFold(n_splits=31)` leave-one-city-out, i.e. two folds are noise; nyc/la/chicago/
london are 6–7% each. Per-holdout-city MAE is barcelona 3.61, miami 6.61, tokyo 7.00 —
tokyo is nearly twice as hard as barcelona, and the headline holdout number is a
row-count-weighted blend. **PROVEN** (logs). Also note the corpus is 34 seed cities of
BestTime venues, and `__tests__/dinnerPeakAccuracy.test.js:408` already pins that a real
user's venue usually has no baseline at all — so holdout ≠ serving population. Fix:
drop or floor tiny cities, and report the per-city table as part of the gate.

### 17. `collectRealtime.js` silently drops unknown cities and ignores `ml_venues.timezone`

`collectRealtime.js:84` — `if (!cityConfig) continue;` — skips every venue whose
`ml_venues.city` is not a key of `config.CITIES`, with no log line and no count in the
summary. Line 88 takes the timezone from the **city** config while `ml_venues.timezone`
is a populated column that migration 021 treats as authoritative for `venue_feedback`.
And `isHoliday`/`isSchoolBreak` (lines 170-171) apply the **US federal calendar** to
Tokyo, Delhi, Berlin and everywhere else. **PROVEN** (code). The holiday calendar is at
least applied consistently at inference (`mlPredictor.js:11, 965-966`), so it is a
correctness problem rather than a parity problem.

### 18. `is_realtime` is a provenance feature that was excluded by name for `sample_weight` and `label_provenance` but kept for itself

`get_feature_columns` (`prepare_features.py:454-473`) excludes `sample_weight` and
`label_provenance` with the reason "encodes row provenance = label regime".
`is_realtime` encodes exactly that and stays in the feature set; at inference it is
hardcoded to 1 (`mlPredictor.js:1013`). **SUSPECTED** consequence, same as finding #5:
the weekly anchor rows anchor a branch that is never served. *Named check:* count splits
on `is_realtime` in the booster, and retrain once with it excluded, comparing the
realtime holdout slice.

### 19. Repeatability gaps

- `train_model.py:119-132`: on the weighted path the `RandomizedSearchCV` object is
  built and **never fitted**; `best_params` is a hardcoded dict. `metadata['best_params']`
  presents it as search output. The `n_iter=24` in the comment above it is dead.
- `train_model.py:89-103`: `device='cuda'` is probed at runtime, so the same code on a
  CPU box yields a different model than on the RTX 5080, and GPU histogram training is
  not bit-reproducible. `RANDOM_STATE = 42` does not cover this.
- `export_model.py:84-93`: `MODEL_VERSION` is an env var with no default; unset, the
  artifact ships tagged `2.5-dev.YYYYMMDD`. Undocumented in RETRAIN.md's runbook.
- `run_training.sh` is `set -e` and step 4 imports matplotlib + seaborn
  unconditionally; a missing plotting dependency aborts the pipeline **before** the ship
  gate runs. (`shap` is guarded; matplotlib/seaborn are not.)
**PROVEN** (code). Fix: record the device and library versions in metadata, document
`MODEL_VERSION`, and either restore the search or delete it.

### 20. Coordinate-keyed identity collisions

`prepare_features.py:495-500` drops always-zero venues keyed on
`(city, venue_category, latitude, longitude)` and line 129 builds `_vkey` from rounded
lat/lng. Two venues at the same coordinates (a mall food court, a re-listed venue) merge
into one. The always-zero drop is nearly inert (17 rows in the v2.5 run, per
`prep_v25.log`); the `_vkey` collision silently merges neighbour statistics. **PROVEN**
(code + log). Low impact; use `venue_id` now that the export provides it.

### 21. The holiday features the v2.5 headline rests on are near-constant

CSV scan over all 3,574,442 rows: `is_holiday` is **1 on zero rows** — the collection
window is 2026-03-10 → 2026-05-18 (from `observed_date`), which contains no date in
`config.HOLIDAYS`; and weekly rows never get it stamped at all. `is_school_break` is
non-zero on 46,670 (1.3%). `prep_v25.log` reports 14,860 special-night rows and 5,467
holiday-eve rows in a 3.5M-row frame (0.4% / 0.15%). **PROVEN.** So the "4 holiday
features" of v2.5 could not have been learned in any meaningful way, and `is_holiday`
could not have been learned at all. Decide before the retrain whether to keep them,
and do not attribute a metric change to them.

---

## Runbook — retrain, once the blocking items are fixed

Preconditions: findings 1–8 addressed. Run from a machine that can reach the database.

```bash
# 0. PRESERVE THE INCUMBENT — do this first, it is unrecoverable afterwards.
cd backend/scripts/ml
mkdir -p models/incumbent
cp models/crowd_model.onnx models/model_metadata.json models/incumbent/
cp train/best_model.pkl train/features_holdout.pkl models/incumbent/

# 1. Schema + collection fixes land in the DB (migration, not a hand-run script):
#    - unique index on ml_training_data  (finding 2)
#    - weekly-row hour/day transform + backfill  (known defect 1)
#    - month/season stamped or backfilled on weekly rows  (finding 5)
#    - weather_condition_code backfilled from weather_condition  (finding 4)
#    - collectRealtime's baseline refresh gets the weekly filter  (known defect 2)
#    Then rebuild the baselines table from one writer only:
node buildBaselines.js

# 2. Clear stale artifacts so a partial failure cannot silently reuse them.
rm -f train/training_data.csv train/holdout_data.csv \
      train/features_train.pkl train/features_holdout.pkl train/best_model.pkl

# 3. Full pipeline. Do NOT start at prepare_features.py.
cd train
node export_training_data.js          # 42-column CSVs; verify the header before continuing
head -1 training_data.csv | tr ',' '\n' | grep -c .   # must print 42
python prepare_features.py            # must NOT log "venue_id missing"
python train_model.py                 # LOCO CV -> best_model.pkl
python evaluate_model.py              # diagnostics + plots (check MAE-by-hour: no 6h skew)
python quick_eval.py                  # SHIP GATE — must now include the incumbent comparison
MODEL_VERSION=2.6.0-<name> python export_model.py

# 4. Verify the artifact the way production will read it.
cd ../../..                           # backend/
node --test __tests__/mlPipeline.test.js __tests__/mlPredictorHarness.test.js \
            __tests__/dinnerPeakAccuracy.test.js
#    dinnerPeakAccuracy currently PINS the bent axis (its line-332 test asserts the
#    corpus is on a BestTime bucket axis). Inverting that test is part of the clock
#    fix, not a test failure to work around.
node --test                           # full suite

# 5. Read the gate before committing anything.
node -e "const m=require('./scripts/ml/models/model_metadata.json');
         console.log(m.model_version, JSON.stringify(m.ship_gate,null,1))"
#    overall_pass must be true, gate_basis 'holdout_realtime', and the new
#    incumbent comparison must show no regression.

# 6. Commit crowd_model.onnx + model_metadata.json, push, Railway serves it.
#    .gitignore lists crowd_model.onnx but the file is already tracked, so the commit
#    works; if anyone ever `git rm --cached`s it, every future retrain silently
#    fails to ship. (Verification of that is a git command; this audit does not run git.)
```

Hard ordering rules, none of them currently enforced by code:
- `export_training_data.js` → `prepare_features.py` → `train_model.py` →
  `evaluate_model.py` → `quick_eval.py` → `export_model.py`. **Never re-run
  `prepare_features.py` after `export_model.py`** — it rewrites the metadata from
  scratch and drops the ship gate, which puts production on the rule engine
  (finding 11).
- `quick_eval.py` must be the last writer of `ship_gate`.
- `MODEL_VERSION` must be set for a release export.

---

## What I could not verify, and why

- **Anything about the live database.** Row counts, the real duplicate distribution,
  the current mix of `source='collected'` vs `'google'` in `ml_venue_baselines`, and
  which of the two baseline writers ran last. `backend/.env` points at the production
  Railway database and the repo quarantines it; I did not connect. Every corpus claim
  above is measured on `train/training_data.csv`, a 2026-08-12 16:35 export snapshot,
  and is therefore a statement about what the last retrain saw — which is the relevant
  question, but it is not a live read.
- **Whether the round-13 leave-one-out baseline SQL behaves as intended.** No CSV
  produced by it exists on disk, so I could only read it. The self-inclusion claim in
  finding #1 rests on the file's own round numbering (venue_id = round 10, LOO = round
  13, CSV predates round 10), not on a diff of two exports. Confirm by re-exporting one
  city and comparing the `baseline_busyness` column against
  `ml_venue_baselines.baseline` for the same (place, dow, hour).
- **Whether the current `prepare_features.py` runs to completion on a 42-column CSV.**
  I did not execute the pipeline — it needs the database and a Python/XGBoost/ONNX
  environment I did not exercise.
- **The exact duplicate rate per venue.** The shipped CSV has no `venue_id` column, so
  the duplicate scan in finding #2 is keyed on `latitude|longitude`, which merges
  venues sharing coordinates. The reported 16.1% is a **lower bound**.
- **Which of these files are committed.** The audit brief forbids running git.
- **The provenance of the "21.46 vs 22.77" incumbent comparison** recorded outside this
  repo. It is in none of the checked-in logs and is not producible by any script here
  (`eval_v25.log` records 21.2073 vs a 23.498 popular-times baseline). Treat it as
  unverified until finding #7's incumbent step exists.
