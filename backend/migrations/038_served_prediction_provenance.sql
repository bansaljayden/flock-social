-- 038: served_predictions learns WHICH DOOR a score came out of, and WHAT
-- CLOCK it was scored on.
--
-- WHY THIS MIGRATION EXISTS.
--
-- 032 built served_predictions to close a forgery: venue_feedback.predicted_
-- score used to be whatever the CLIENT said we predicted, and it is the
-- denominator of every calibration feature. The server now writes down every
-- score it publishes and routes/feedback.js prefers that record over the
-- client's claim, stamping predicted_score_source = 'server'.
--
-- That fix has a hole, and it is the same hole one level up. Two of the three
-- write paths are the detail card, where the venue, its rating, its review
-- count and its clock all come from Google and from the venue's own UTC
-- offset. The third is POST /api/crowd/batch, whose venues arrive IN THE
-- REQUEST BODY — name, types, rating, userRatingCount, location and
-- utcOffsetMinutes, all client-assembled, deliberately so (that route makes no
-- paid Google call and its header says the ids are not even shape-checked for
-- scoring). The model scores what it is handed. So:
--
--   POST /api/crowd/batch  { place_id: <a real bar>, rating: 1.0,
--                            userRatingCount: 3, utcOffsetMinutes: <4am> }
--     -> the server publishes ~5 for that bar and RECORDS it as a serve
--   POST /api/feedback     { venue_place_id: <the same bar>, crowd_level: 3 }
--     -> the served row wins, source = 'server', denominator = 5, reality = 90
--
-- The attacker never touched predicted_score. They chose the inputs, and the
-- server laundered their choice into its own trusted record. One free POST per
-- forged pair, and the pairs land in the live calibration blend
-- (crowdEngine.buildCalibrationAdjustment), in mlPredictor's per-venue error
-- correction, and in avg_prediction_error in the training export.
--
-- The follow-up 032 named in routes/feedback.js's header — tighten the
-- calibration readers to source='server' only — would have made this WORSE,
-- not better: it would have thrown away the honest 'client' rows and kept the
-- forged 'server' ones. So the columns land first.
--
-- THREE COLUMNS, ONE QUESTION EACH.
--
--   source     — which route minted the row, and therefore how much of the
--                scoring input the caller chose. An ALLOWLIST vocabulary, the
--                same shape utils/places and VERIFIED_PRESENCE_SQL use, so a
--                reader asks "is it in the trusted set" rather than "is it one
--                of the bad ones I remembered to list":
--                  'detail'              GET /api/crowd/:placeId, scored on the
--                                        venue's OWN clock (Google gave us a
--                                        utcOffsetMinutes). The only trusted
--                                        value today.
--                  'detail_client_clock' the same route, but Google returned no
--                                        offset and the card fell back to the
--                                        CALLER's localHour/localDay. The venue
--                                        facts are Google's; the hour is the
--                                        caller's. Not trusted.
--                  'batch'               POST /api/crowd/batch. Venue facts AND
--                                        clock are the caller's. Never trusted.
--                NULL means "written before this migration", and NULL is
--                untrusted for provenance by construction: every reader
--                spells its rule as `source = 'detail'`, and NULL = 'detail'
--                is NULL, not true. No backfill is possible or wanted — the
--                pre-038 rows genuinely do not record which door they came
--                out of, and guessing would be inventing the fact this
--                column exists to stop inventing.
--
--   local_day  — the venue-local weekday (0-6) and hour (0-23) the score was
--   local_hour   COMPUTED FOR. Recorded because a serve is only a valid
--                denominator for a report about THE SAME HOUR. A card read at
--                8pm and a report filed at 2am are two different questions
--                about the room, and pairing them teaches the calibration
--                layer that the model was wrong by the width of a night.
--                routes/feedback.js now requires the match. NULL, again, on
--                pre-038 rows, and again unmatchable rather than assumed.
--
-- WHY NOT A `trusted BOOLEAN`. Because the interesting reads are forensic as
-- well as gating — "how much of our serve volume is batch", "did this venue's
-- forged pairs all arrive through one door" — and a boolean computed at write
-- time freezes today's trust policy into old rows. The route name is a fact;
-- whether that route is trusted is a policy, and policy belongs in the reader.

DO $$ BEGIN
  ALTER TABLE served_predictions ADD COLUMN IF NOT EXISTS source VARCHAR(24)
    CHECK (source IN ('detail', 'detail_client_clock', 'batch'));
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE served_predictions ADD COLUMN IF NOT EXISTS local_day SMALLINT
    CHECK (local_day BETWEEN 0 AND 6);
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE served_predictions ADD COLUMN IF NOT EXISTS local_hour SMALLINT
    CHECK (local_hour BETWEEN 0 AND 23);
EXCEPTION WHEN others THEN NULL; END $$;

-- The feedback join is now (user, venue, source, clock) inside a 12-hour
-- window, newest first. 032's idx_served_predictions_user_venue_at still leads
-- it; the clock and source columns are low-cardinality filters on the handful
-- of rows that index returns for one user at one venue in half a day, so this
-- deliberately does NOT add a wider index. Written down so the absence reads
-- as a decision rather than an oversight.
