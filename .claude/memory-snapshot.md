# Flock Memory Snapshot — auto-generated 2026-08-10
# This file is committed by a weekly cloud agent. The user's local Claude Code
# syncs it into ~/.claude/projects/.../memory/MEMORY.md on session start.

## Project state
- Frontend App.js: 14401 lines / 960K
- Backend routes (27): admin, ai, auth, availability, billing, budget, calendar, checkin, crowd, events, feedback, flocks, friends, messages, moderation, notifications, revenuecat, safety, sensors, stories, users, venueDashboard, venueProfile, venueSearch, venues, waitlist, weather
- ML cities (34): nyc, la, chicago, london, tokyo, miami, lehigh, sydney, delhi, beijing, paris, madrid, philly, dallas, austin, seattle, denver, boston, nashville, nola, mexico, saopaulo, buenosaires, berlin, amsterdam, rome, barcelona, dubai, capetown, singapore, seoul, bangkok, mumbai, toronto
- ML scripts: backfillBaseline.js, bestTimeService.js, buildBaselines.js, checkData.js, cleanupFalse404.js, collectEvents.js, collectRealtime.js, collectWeekly.js, config.js, dataBreakdown.js, discoverBestTime.js, discoverVenues.js, enrichWithEvents.js, eventService.js, exportCsv.js, initTables.js, probeUntestedCities.js, runCollection.js, status.js, testTM.js, testTM2.js, validateBusinessStatus.js + train/ subdir (Python: train_model.py, evaluate_model.py, export_model.py, prepare_features.py, quick_eval.py, JS: export_training_data.js) + models/ (crowd_model.onnx, model_metadata.json)
- Mobile: React Native port at /mobile/ (App.js, android/, ios/, app.json)
- iOS (Capacitor): web app wrapped in Capacitor 8 for iOS; Codemagic CI signing pipeline active; TestFlight builds shipping
- Sensor hardware: /flock-sensor/ Pi daemon (main.py, flock_sensor.env.example, setup.sh)

## Built features (verified present in code)
- Birdie AI — backend/routes/ai.js (references Gemini)
- Push notifications — frontend/public/firebase-messaging-sw.js + backend/routes/notifications.js
- Anonymous budget matching — backend/routes/budget.js
- Post-hangout feedback — backend/routes/feedback.js + venue_feedback table
- Landing page — frontend/src/website/LandingPage.js
- Venue dashboard backend — backend/routes/venueDashboard.js
- Research analytics — backend/routes/admin.js (research_analytics table)
- Anti-flake reliability scoring — BUILT: backend/routes/users.js:268 reads reliability_score from users table; admin.js buckets users by score into reliable/moderate/flaky
- Crowd ML — backend/services/mlPredictor.js + backend/services/crowdEngine.js
- Settings sync — backend/routes/users.js GET /api/users/settings; user_settings JSONB table
- Sensors / Live Occupancy — backend/routes/sensors.js; sensor_devices + venue_sensor_data + venue_checkins tables
- NFC check-in pipeline — backend/routes/checkin.js; Pi daemon in /flock-sensor/
- Availability Pulse — backend/routes/availability.js
- Safety / Trusted Contacts — backend/routes/safety.js; trusted_contacts + emergency_alerts tables
- Billing / Bill Split — backend/routes/billing.js; bill_splits + bill_split_shares + budget_submissions tables
- Flock avatars (pet selfie group icons) — backend/routes/flocks.js
- Satellite map mode (MapTiler hybrid) — frontend/src/App.js
- Calendar — backend/routes/calendar.js + calendar_events table; frontend persistent events + time picker (96cf163, 1d5bc33)
- Moderation / Report+Block — backend/routes/moderation.js; content_reports + user_blocks + moderation_actions tables; mutual-block hides messages in shared flocks
- RevenueCat subscriptions webhook — backend/routes/revenuecat.js (POST /api/revenuecat/webhook)
- Compliance layer — in-app account deletion, signup age-gate, report/block UI (82cb1ef, 8a6596e)
- iOS Capacitor build — Codemagic CI signing, .ipa upload to TestFlight (86664ec + ci fixes)
- Design system overhaul — colors.teal → colors.steel/navy, refined glass tokens, flat cards, Satoshi font self-hosted (765307a–8275aff)

## Not yet built
- (No features currently identified as schema-only stubs without route logic)

## Recently shipped (since last snapshot 2026-05-25)
- 0aa81a0 — fix(map): compact attribution bottom-left
- 02314f6 — fix(device): TestFlight build-16 punch list
- ef837af — fix(ios): true full-bleed on device
- 8275aff — refactor(ui): rename colors.teal -> colors.steel
- 1d5bc33 — feat(calendar): frontend — persistent events, real time picker
- 96cf163 — feat(calendar): backend — calendar_events table + CRUD routes
- bd8f09e — redesign(nest): full recomposition
- 34c6562 — feat(chat): bigger, input-friendly composers
- c243f35 — fix(map): theme-aware basemap
- 765307a–2453c4a — redesign(1-5/5): CSS foundation, color sweep, component flattening, flock cards, verification
- 82cb1ef — feat(compliance+ci): in-app account deletion + robust build numbering
- 8a6596e — feat(compliance+ci): report/block UI, signup age-gate, unique build numbers
- 734f088 — merge(submission-readiness): compliance layer + Capacitor iOS + CI signing
- 86664ec — feat(ios): wrap web app in Capacitor 8 for iOS (Codemagic build)
- f6e3887 — fix(safety): filter blocked users' live socket messages in flock chat
- f2d116b — fix(safety): mutual block hides messages in shared flocks
- b4bdd8d — fix(safety): banned users can still delete their account

## Schema notes
- calendar_events — added for Calendar feature (backend/routes/calendar.js)
- content_reports — compliance reporting table (server.js)
- user_blocks — mutual block system (server.js)
- moderation_actions — admin moderation log (server.js)
- sensor_devices, venue_sensor_data, venue_checkins — Pi sensor / NFC pipeline
- user_settings (JSONB) — cross-device settings sync
- dm_pinned_venues — DM-scoped venue pinning
- budget_submissions, bill_splits, bill_split_shares — billing/budget features
- research_analytics — admin research tracking
- venue_profiles, venue_promotions, venue_events, venue_reviews — venue dashboard
- ml_training_data enriched with event proximity columns (enrichWithEvents.js)
- ml_venue_baselines — crowd baseline table (buildBaselines.js)

## DB-derived stats (need local refresh)
- Last cloud-surveyed: 2026-08-10
- Run `cd backend && node scripts/ml/status.js` locally to refresh venue/training numbers.
