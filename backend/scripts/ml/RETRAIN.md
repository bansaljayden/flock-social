# Crowd model: retrain runbook + the continuous-learning loop

Updated 2026-08-12 (v2.3 work). Read `ml_overfitting_fixes` doctrine first
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

Ship gate (do not ship on overall metrics): realtime-only holdout MAE must
beat both the previous model (v2.2.1: 33.5) and the popular-times baseline
(40.5), and overall holdout must not regress materially (v2.2.1: MAE 5.16,
R² 0.75). If training dies, feature pickles persist — rerun train_model.py.

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

Go-forward plumbing (do when the prod DB is reachable / next collection):
1. Generate `backend/scripts/ml/holidays.json` from the Python `holidays`
   package: every training-city country + US, years 2025-2028, plus a
   hand-curated `party_nights` list (Thanksgiving Eve, NYE, NYD-eve, Halloween,
   St. Patrick's, Cinco de Mayo, July 3rd, and per-country equivalents).
   ONE file consumed by BOTH Python training and Node inference = parity.
2. Collection scripts + venue_feedback export: stamp `observed_date`,
   `is_holiday_eve`, `is_party_night` on every new realtime row.
3. mlPredictor.buildFeatureVector: compute the same fields from `new Date()`
   + holidays.json, but ONLY when the loaded model's metadata.feature_names
   includes them (backward compatible with older models).
4. First retrain after a season of eve-labeled data can actually learn the
   effects. Until then, eves ride on is_holiday + day-of-week signal.

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

## Next levers after v2.3 (in order)

1. Feedback-rows-as-labels export (closes the loop for real).
2. In-fold category_baseline recomputation (small leak, needs CV refactor).
3. Ensemble XGBoost + LightGBM (+0.02-0.05 R² typical).
4. Absolute prediction head (second model for no-baseline venues) so the
   rule-engine fallback dies entirely.
5. Populate/verify `ml_venue_baselines` coverage in prod; set
   TICKETMASTER_API_KEY on Railway (event features currently zero).
