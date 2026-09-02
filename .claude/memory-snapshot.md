# Flock Memory Snapshot — auto-generated 2026-09-02
# This file is committed by a weekly cloud agent. The user's local Claude Code
# syncs it into ~/.claude/projects/.../memory/MEMORY.md on session start.

## Project state
- Frontend App.js: 14401 lines / 960K
- Backend routes (27): admin, ai, auth, availability, billing, budget, calendar, checkin, crowd, events, feedback, flocks, friends, messages, moderation, notifications, revenuecat, safety, sensors, stories, users, venueDashboard, venueProfile, venueSearch, venues, waitlist, weather
- ML cities (34): nyc, la, chicago, london, tokyo, miami, lehigh, sydney, delhi, beijing, paris, madrid, philly, dallas, austin, seattle, denver, boston, nashville, nola, mexico, saopaulo, buenosaires, berlin, amsterdam, rome, barcelona, dubai, capetown, singapore, seoul, bangkok, mumbai, toronto
- ML scripts: backfillBaseline.js, bestTimeService.js, buildBaselines.js, checkData.js, cleanupFalse404.js, collectEvents.js, collectRealtime.js, collectWeekly.js, config.js, dataBreakdown.js, discoverBestTime.js, discoverVenues.js, enrichWithEvents.js, eventService.js, exportCsv.js, initTables.js, probeUntestedCities.js, runCollection.js, status.js, testTM.js, testTM2.js, validateBusinessStatus.js + train/ subdir (Python: train_model.py, evaluate_model.py, export_model.py, prepare_features.py, quick_eval.py) + models/ (crowd_model.onnx, model_metadata.json)
- Mobile: React Native port at /mobile/ (App.js, android/, ios/, app.json)
- iOS: Capacitor 8 wrapper built via Codemagic CI; TestFlight builds active
- Sensor hardware: /flock-sensor/ Pi daemon (main.py, flock_sensor.env.example, setup.sh)
- Design system: DESIGN.md committed — refined glass + flat card specs, steel-navy accent (colors.teal renamed colors.steel)

## Built features (verified present in code)
- Birdie AI — backend/routes/ai.js (10 Gemini references)
- Push notifications — frontend/public/firebase-messaging-sw.js + backend/routes/notifications.js
- Anonymous budget matching — backend/routes/budget.js
- Post-hangout feedback — backend/routes/feedback.js + venue_feedback table
- Landing page — frontend/src/website/LandingPage.js
- Venue dashboard backend — backend/routes/venueDashboard.js
- Research analytics — backend/routes/admin.js (research_analytics table)
- Anti-flake reliability scoring — BUILT: users.js:268 reads reliability_score; admin.js buckets users reliable/moderate/flaky
- Crowd ML — backend/services/mlPredictor.js + backend/services/crowdEngine.js
- Settings sync — backend/routes/users.js:526 GET /api/users/settings + PATCH
- Sensors / Live Occupancy — backend/routes/sensors.js; sensor_devices + venue_sensor_data + venue_checkins tables
- NFC check-in pipeline — backend/routes/checkin.js; Pi daemon in /flock-sensor/
- Availability Pulse — backend/routes/availability.js
- Safety / Trusted Contacts — backend/routes/safety.js; trusted_contacts + emergency_alerts tables
- Billing / Bill Split — backend/routes/billing.js; bill_splits + bill_split_shares + budget_submissions tables
- Flock avatars (pet selfie group icons) — backend/routes/flocks.js
- Satellite map mode (MapTiler hybrid) — frontend/src/App.js
- Calendar — backend/routes/calendar.js (CRUD) + calendar_events table; frontend persistent events + real-time picker (96cf163, 1d5bc33)
- Content moderation / Report+Block — backend/routes/moderation.js; content_reports + user_blocks + moderation_actions tables; mutual-block hides messages in flocks and sockets (f2d116b, f6e3887)
- In-app account deletion — compliance requirement (82cb1ef); banned users retain delete right (b4bdd8d)
- Signup age-gate — frontend (8a6596e)
- RevenueCat webhook scaffold — backend/routes/revenuecat.js; flips users.is_premium on entitlement events; DORMANT in v1.0, paywall flip is config-only for v1.1
- A11y pass — reduced-motion + WCAG contrast (17a1d25)
- Self-hosted Satoshi font — frontend (0e73fc3)

## Not yet built
- RevenueCat paywall (client-side) — webhook wired, but paywall UI not enabled; v1.1 target

## Recently shipped (last 30 days from git log, since ~2026-08-03)
- 0aa81a0 — fix(map): compact attribution bottom-left — stops colliding with View-All pill
- 02314f6 — fix(device): TestFlight build-16 punch list — links, video, band, cream
- ef837af — fix(ios): kill the desktop phone-bezel on device — true full-bleed
- 8275aff — refactor(ui): rename colors.teal -> colors.steel + TestFlight test-info prep
- 9c7cf30 — polish(critique-synthesis): impeccable Assessment A + web-guidelines fixes
- fb10213 — polish(impeccable): detector findings + PRODUCT.md
- 66ebc89 — polish(nest+discover): user feedback round
- 1d5bc33 — feat(calendar): frontend — persistent events, real time picker
- 96cf163 — feat(calendar): backend — calendar_events table + CRUD routes
- bd8f09e — redesign(nest): full recomposition — every block a different form
- 34c6562 — feat(chat): bigger, input-friendly composers
- c243f35 — fix(map): theme-aware basemap — kills the 'weird overlay' look

## Schema notes
- calendar_events — added for user calendar feature (96cf163)
- content_reports, user_blocks, moderation_actions — added for compliance/UGC moderation layer
- sensor_devices, venue_sensor_data, venue_checkins — Pi sensor / NFC pipeline
- user_settings (JSONB) — cross-device settings sync
- dm_pinned_venues — DM-scoped venue pinning
- budget_submissions, bill_splits, bill_split_shares — billing/budget features
- research_analytics — admin research tracking
- venue_profiles, venue_promotions, venue_events, venue_reviews — venue dashboard
- ml_training_data enriched with: has_nearby_event, nearest_event_distance_km, nearest_event_attendance, total_nearby_events, total_nearby_attendance, nearest_event_type
- ml_venue_baselines — crowd baseline table

## DB-derived stats (need local refresh)
- Last cloud-surveyed: 2026-09-02
- Run `cd backend && node scripts/ml/status.js` locally to refresh venue/training numbers.
