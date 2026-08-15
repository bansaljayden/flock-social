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
> 42-column shape, so this cannot recur silently, but do not try.

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
node export_training_data.js                     # 42-column CSVs
head -1 training_data.csv | tr ',' '\n' | grep -c .   # must print 42
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
| the CSV is not the 42-column export | `venue_id` drives baseline smoothing, `label_provenance` drives the vendor-forecast weight; without them both were skipped in silence |
| a weather description is not in `WEATHER_DESCRIPTION_CODES` | guessing a group is inventing data — add the OpenWeatherMap id |
| no `weather_condition_code` survives recovery | all ten `weather_*` features would be constant again |
| any row lacks `month` / `season` | `month=0` with four zero season one-hots cannot occur at inference |
| every row's `label_provenance` is `unknown` | vendor forecasts would all be weighted 1.0 again |
| the holdout is missing a non-one-hot feature | the two frames went through different code paths |

Two escape hatches exist. Both are explicit, both log a warning, both are
recorded in `model_metadata.json.corpus_contract`, and **neither is acceptable
for a release**:

```bash
FLOCK_WEATHER_POLICY=drop    # remove the 10 weather features instead of faking them
FLOCK_CALENDAR_POLICY=drop   # remove the 12 calendar/month-derived features
```

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

## Pre-retrain audit status (`PRE-RETRAIN-AUDIT.md`, 8 BLOCKING items)

Do not start the retrain until every BLOCKING row below reads DONE or has an
owner. The audit file itself is the specification and is not edited; this is the
status board.

| # | Blocking finding | Status |
|---|---|---|
| 1 | Stale 40-column CSVs; runbook started after the export | **DONE (python side).** `prepare_features.py` raises `CorpusContractError` on any CSV that is not the 42-column export, naming the missing columns and telling you to re-run the exporter. Runbook above now starts at step 0 (preserve incumbent) then `node export_training_data.js`. Deleting the stale CSVs is step 1 of the runbook. |
| 2 | No unique constraint on `ml_training_data`, so `ON CONFLICT DO NOTHING` is a no-op | **DONE.** Migration `024_ml_training_data_unique_slot.sql` collapses the duplicates and adds the key; both collectors now name a real conflict target. The index shape deviates from the one specified here — see "The unique key on `ml_training_data`" below for what changed and why the `COALESCE(observed_date,'1970-01-01')` form would have destroyed data. |
| 3 | Positional `shift(1)` smoothed an hour against itself on duplicate rows | **DONE.** `smooth_baseline_hours()` collapses to one value per (venue_id, dow, hour), lays them on a complete 7×24 grid so a missing hour is a real gap, blends against the true clock neighbours with the day/week wraps `mlPredictor.getBaseline` uses, and merges back. Measured on a duplicate-heavy fixture: the old code left 9,714 of 14,112 cells holding more than one distinct smoothed baseline; the new code leaves 0. |
| 4 | `weather_condition_code` NULL on 100% of rows → ten constant features | **DONE (recovery + contract).** `WEATHER_DESCRIPTION_CODES` maps every OpenWeatherMap description to its condition id and `recover_weather_codes()` backfills the column; the 25 descriptions present in the 2026-08-12 corpus are all covered. Unmapped descriptions are reported by name and count and stop the run. **The collector half is now DONE too:** both `collectWeekly.js` and `collectRealtime.js` write `weather.conditionId` into `weather_condition_code`, so recovery is a transitional path for old rows rather than a permanent one. The historical rows are deliberately NOT backfilled in SQL — the exporter already derives them, and a second full-table rewrite would have doubled the deploy's downtime for nothing. |
| 5 | 62.9% of rows carry `month=0` with all four season one-hots at 0 | **DONE, with one stated limitation.** `collectWeekly.js` now stamps `month`/`season` from the venue's own clock at collection (falling back to UTC if `ml_venues.timezone` is unusable), and migration 024 backfills every existing row from its `collected_at`, which is a real `DEFAULT NOW()` insert timestamp and not an invented date. Rows whose `collected_at` is NULL are skipped, not guessed. The limitation, which the retrain must not forget: on a weekly row `month` means "the month this typical-week snapshot was taken in", not "the month this busyness happened in", and because collection ran in a narrow window it does **not** stop `month` from proxying row provenance. What it does fix is the impossible corner — every stamped row now has a month in 1..12 and exactly one season, a region the serving path actually reaches. `prepare_features.py`'s refusal and `FLOCK_CALENDAR_POLICY=drop` both stay as the guard. |
| 6 | Gate measured on holdout rows production refuses to serve | **DONE.** `quick_eval.py` imports `serving_population_mask` from `prepare_features` and applies it to the gate slice; the excluded count is logged and persisted, and the old unfiltered number is kept as a labelled diagnostic. |
| 7 | No incumbent comparison, and this document claimed there was one | **DONE.** See "The ship gate" above. Absent or dishonest comparison = gate failure. |
| 8 | Gate structurally blind to corpus-wide corruption; v2.5 passed by 0.0026 | **PARTLY DONE.** Added here: the MAE arm may not regress, an absolute realtime within-10 floor of 29.2%, and a per-hour corpus mean printed by `evaluate_model.py` so a bent axis is visible. Still open: the hard assertion that category peak hours land in the evening, which belongs with the clock fix — `__tests__/dinnerPeakAccuracy.test.js:332` currently *pins the bug* ("the shipped corpus is on a BestTime bucket axis") and must be inverted as part of that change, not worked around. |

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

Also still open, and deliberately **not** closed in that pass: the
`category_baseline` / `refined_category_baseline` leak that
`metadata.training_contracts.known_residual_leak` names. `prepare_features.py`
fits both on the whole training frame and applies them to it, so a city
`train_model.py` later holds out has already built the cells its own rows are
scored against. It makes `training_metrics` optimistic; it does **not** touch
the ship gate, whose holdout cities contribute to neither map. Round 14
attempted the fix, measured it, and rejected it — see next lever 2 for the
numbers. What round 14 *did* ship is the raw material: `features_train.pkl`
now carries `category_cell_stats` (per-city label sums and counts per category
cell, plus each row's cell index), so the correct per-fold refit is a
subtraction inside the fold loop rather than a second pass over the CSV, and
`metadata.corpus_contract.category_baseline_fit` records where each map was
fitted, where it was applied, and that the leak is still OPEN. Do not delete
`known_residual_leak` until `train_model.py` consumes those statistics.

## The continuous-learning loop ("constantly machine learning")

The model gets better as the app is used. Ground-truth sources that accrue in
prod, in order of value:

1. **`venue_feedback`** — users report actual crowd levels in-app. Already
   joined into training as per-venue aggregates. NEXT EXPORT UPGRADE: also emit
   each feedback row as a realtime training row (crowd_level -> busyness_pct
   at that venue/day/hour, with the REAL DATE — which unlocks holiday-eve
   learning, see below).
2. **`venue_sensor_data`** — Pi sensor headcounts where deployed: the highest
   quality ground truth (flock-sensor pipeline is proven).
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
7. TheSportsDB $9/mo Patreon tier (commercial OK, attribution): home-game
   nights x is_sports_bar x arena distance — documented +21-70% sports-bar lifts
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

   Measured on a synthetic fixture (10 training cities, 3 never-seen holdout
   cities, `GroupKFold` on city, identical hyperparameters, delta label whose
   only learnable signal is a per-city deviation). Optimism = pristine-holdout
   MAE minus the reported cross-validated MAE:

   | category-baseline regime | reported CV MAE | true holdout MAE | optimism |
   |---|---|---|---|
   | whole-frame fit (what ships today) | 8.87 | 9.20 | **+0.34** |
   | leave-one-city-out computed once | 6.20 | 9.02 | **+2.82** |
   | K-fold block encoding, K=2 / 3 / 5 | 9.30 / 8.49 / 8.89 | 9.09 / 9.11 / 8.96 | −0.21 / **+0.63** / +0.07 |
   | per-fold refit from the fold's own rows | 9.25 | 9.20 | **−0.04** |

   Block encoding is not even monotone in K: at K=3 it is worse than doing
   nothing. Only the per-fold refit is reliably honest, and it is honest for a
   structural reason — inside a fold the map is one value per cell, shared by
   that fold's training and validation rows alike, so there is no city-varying
   residual left to invert. That property is what makes it correct, and it is
   why the fix cannot live in `prepare_features.py`, which emits one feature
   matrix and has no folds.

   What is already done, so this lever is small: `features_train.pkl` carries
   `category_cell_stats` — per-city label sums and counts for every coarse and
   refined category cell, each row's cell index and group index, and the recipe
   string. A fold's map is
   `round(sums[fold_train_groups].sum(0) / counts[fold_train_groups].sum(0), 1)`,
   then the 0.6/0.2/0.2 adjacent-hour smoothing for the coarse map, then index
   with `row_cell`. Verified cell-by-cell against
   `build_category_baseline_maps` refitted on each fold's rows: 38,136 cells
   compared over 10 folds, zero mismatches. Remaining work is inside
   `train_model.py`'s fold loop, plus deleting
   `metadata.training_contracts.known_residual_leak` once it is consumed.
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
