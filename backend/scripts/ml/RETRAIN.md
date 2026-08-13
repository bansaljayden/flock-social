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

```bash
cd backend/scripts/ml/train
python prepare_features.py   # CSVs -> features_train.pkl / features_holdout.pkl
python train_model.py        # LOCO CV + RandomizedSearchCV -> best_model.pkl
python quick_eval.py         # SHIP GATE: realtime-only holdout metrics
python export_model.py       # -> ../models/crowd_model.onnx + metadata
cd ../../.. && node --test   # backend still green
# commit crowd_model.onnx + model_metadata.json -> push -> Railway serves it
```

> **Gitignore trap.** `.gitignore:37` lists
> `backend/scripts/ml/models/crowd_model.onnx`, but the file is already **tracked**,
> and gitignore does not apply to tracked files — so committing an updated model
> works today. If anyone ever runs `git rm --cached` on it, the ignore rule takes
> over and every future retrain will silently fail to ship while looking like it
> succeeded. After pushing, confirm with
> `git log --oneline -1 -- backend/scripts/ml/models/crowd_model.onnx`.

Ship gate (do not ship on overall metrics): realtime-only holdout MAE must beat
both the incumbent model and the popular-times baseline, and overall holdout
must not regress materially.

> **Do not hardcode the incumbent's numbers here.** The old "v2.2.1: 33.5 / 40.5"
> figures are stale and are NOT comparable to current runs — the baselines
> matured as more realtime rows accrued, so v2.5's honest realtime MAE (21.46 vs
> the incumbent's 22.77) sits on a completely different scale from the 33.5 that
> once counted as the bar. **Re-run the incumbent on the same holdout every
> time** and compare within that run. `quick_eval.py` does this and writes the
> verdict into `ship_gate`; trust it over any number typed in a doc.

If training dies, feature pickles persist — rerun train_model.py.

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
2. In-fold category_baseline recomputation (small leak, needs CV refactor).
3. Ensemble XGBoost + LightGBM (+0.02-0.05 R² typical).
4. Absolute prediction head (second model for no-baseline venues) so the
   rule-engine fallback dies entirely.
5. Populate/verify `ml_venue_baselines` coverage in prod; set
   TICKETMASTER_API_KEY on Railway (event features currently zero).
