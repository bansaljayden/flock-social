# Flock Memory Snapshot — auto-generated 2026-05-25
# This file is committed by a weekly cloud agent. The user's local Claude Code
# syncs it into ~/.claude/projects/.../memory/MEMORY.md on session start.

## Project state
- Frontend App.js: 14341 lines / 956K
- Backend routes (24): admin, ai, auth, availability, billing, budget, checkin, crowd, events, feedback, flocks, friends, messages, notifications, safety, sensors, stories, users, venueDashboard, venueProfile, venueSearch, venues, waitlist, weather
- ML cities (34): nyc, la, chicago, london, tokyo, miami, lehigh, sydney, delhi, beijing, paris, madrid, philly, dallas, austin, seattle, denver, boston, nashville, nola, mexico, saopaulo, buenosaires, berlin, amsterdam, rome, barcelona, dubai, capetown, singapore, seoul, bangkok, mumbai, toronto
- ML scripts: backfillBaseline.js, bestTimeService.js, buildBaselines.js, checkData.js, cleanupFalse404.js, collectEvents.js, collectRealtime.js, collectWeekly.js, config.js, dataBreakdown.js, discoverBestTime.js, discoverVenues.js, enrichWithEvents.js, eventService.js, exportCsv.js, initTables.js, probeUntestedCities.js, runCollection.js, status.js, testTM.js, testTM2.js, validateBusinessStatus.js + train/ subdir (Python: train_model.py, evaluate_model.py, export_model.py, prepare_features.py, quick_eval.py) + models/ (crowd_model.onnx, model_metadata.json)
- Mobile: React Native port exists at /mobile/ (App.js, android/, ios/, app.json)
- Sensor hardware: /flock-sensor/ Pi daemon (main.py, flock_sensor.env.example, setup.sh)

## Built features (verified present in code)
- Birdie AI — backend/routes/ai.js (references Gemini)
- Push notifications — frontend/public/firebase-messaging-sw.js + backend/routes/notifications.js
- Anonymous budget matching — backend/routes/budget.js
- Post-hangout feedback — backend/routes/feedback.js + venue_feedback table in server.js
- Landing page — frontend/src/website/LandingPage.js
- Venue dashboard backend — backend/routes/venueDashboard.js
- Research analytics — backend/routes/admin.js (research_analytics table in server.js)
- Anti-flake reliability scoring — BUILT: backend/routes/users.js:262 reads reliability_score from users table; admin.js:72-74 buckets users by score into reliable/moderate/flaky
- Crowd ML — backend/services/mlPredictor.js + backend/services/crowdEngine.js
- Settings sync — backend/routes/users.js:510 GET /api/users/settings; user_settings JSONB table auto-created on startup
- Sensors / Live Occupancy — backend/routes/sensors.js; sensor_devices + venue_sensor_data + venue_checkins tables in server.js
- NFC check-in pipeline — backend/routes/checkin.js; Pi daemon in /flock-sensor/
- Availability Pulse — backend/routes/availability.js
- Safety / Trusted Contacts — backend/routes/safety.js; trusted_contacts + emergency_alerts tables
- Billing / Bill Split — backend/routes/billing.js; bill_splits + bill_split_shares + budget_submissions tables
- Flock avatars (pet selfie group icons) — backend/routes/flocks.js (shipped 0716b8f)
- Satellite map mode (MapTiler hybrid) — frontend/src/App.js (shipped 9ffc2b2)

## Not yet built
- (No features currently identified as schema-only stubs without route logic)

## Recently shipped (last 30 days from git log, since ~2026-04-25)
- 2a48128 — feat(mobile): commit RN port + fix Google Sign-In + deep-link nesting
- bf94518 — ML retrain v2.2.1-delta-fixed + app-store readiness
- bc5bc19 — revert(sensors): restore simpler Live Occupancy card design
- bc8e996 — fix(collect): retry transient pg pool errors instead of fatal-crashing
- 3731b22 — fix(sensors): bucket history hourly server-side so chart labels match reality
- 1f5173c — fix(sensors,checkin): mount before /api catch-all so anon NFC works
- ba98fa5 — feat(sensors): Live Occupancy card, Check-In button, NFC landing, owner dashboard sensor section
- 62a68d7 — feat(sensors): add Pi sensor + NFC check-in pipeline
- 12c74c7 — Availability Pulse + home screen redesign
- e87921d — BestTime probe + 404 tracking on collection runs
- f434eb6 — Fix hourly crowd graph rendering for closed/loading venues

## Schema notes
- sensor_devices, venue_sensor_data, venue_checkins — added for Pi sensor / NFC pipeline
- user_settings (JSONB) — cross-device settings sync
- dm_pinned_venues — DM-scoped venue pinning
- budget_submissions, bill_splits, bill_split_shares — billing/budget features
- research_analytics — admin research tracking
- venue_profiles, venue_promotions, venue_events, venue_reviews — venue dashboard
- ml_training_data enriched with: has_nearby_event, nearest_event_distance_km, nearest_event_attendance, total_nearby_events, total_nearby_attendance, nearest_event_type
- ml_venue_baselines — crowd baseline table (buildBaselines.js)

## DB-derived stats (need local refresh)
- Last cloud-surveyed: 2026-05-25
- Run `cd backend && node scripts/ml/status.js` locally to refresh venue/training numbers.
