-- 030: venue_profiles intake — the venue facts no dataset contains
--
-- WHY THIS TABLE GROWS BY EIGHTEEN COLUMNS.
--
-- The crowd model is deliberately blind to venue identity. google_place_id,
-- latitude and longitude are on the forbidden-features list in
-- scripts/ml/RETRAIN.md and they are on it for a good reason: a model allowed
-- to memorise which venue it is looking at stops learning what makes a Friday
-- different from a Tuesday and starts learning that THIS bar is busy. The
-- consequence, which is correct and is also a problem, is that two venues of
-- the same category, price band and rating band get an IDENTICAL prediction.
--
-- So anything an advisor says to a venue owner about their own room is, today,
-- a sentence about their CATEGORY. "Bars are busy on Friday" is not advice.
--
-- The columns below are the cheapest source of venue-specific truth that
-- exists, because the owner already knows all of it and nobody else does:
--
--   * kitchen_last_order — "your kitchen stops at 21:00 and your busiest hour
--     IS 21:00" is a sentence that can only be said once somebody tells us
--     when the kitchen stops. It is not in Google's opening hours, which
--     report the door, not the pass.
--   * capacity + typical_dwell_minutes — turn a 0-100 busyness index into
--     people and into a wait. "Full at 8, next table around 9:30."
--   * owner_busy_nights — the owner's BELIEF, stored next to the corpus's
--     measurement, so the two can disagree in public. A disagreement is the
--     only thing on this list that is worth money on its own.
--   * anchor_types — a stadium across the road is a demand event the model
--     cannot see, because the model cannot see where the venue is.
--   * age_policy / age_restricted_after — Flock plans GROUPS. A flock with a
--     19-year-old needs to be told to come before ten, not turned away at the
--     door at eleven.
--   * largest_walkin_group / reservation_policy — the single most common
--     question a group asks a venue, and the app that asks it is this one.
--   * typical_spend_per_person — joins straight into the flock budget ceiling
--     that already exists (migrations 027, routes/budget.js).
--
-- NONE of these become model FEATURES. They are venue context, read at answer
-- time, kept out of training deliberately: a per-venue field in the training
-- matrix is venue identity wearing a hat, which is the exact overfit the
-- forbidden-features list exists to prevent. See ml_overfitting_fixes doctrine.
--
-- --- AND THE CORPUS COLUMNS, WHICH ARE THE LOAD-BEARING ONES ----------------
--
-- corpus_status / corpus_baseline_rows / corpus_checked_at record whether the
-- claimed place_id is in ml_venues and whether it has rows in
-- ml_venue_baselines.
--
-- This matters more than any of the intake fields. services/mlPredictor.js
-- getBaseline looks up ml_venue_baselines BY google_place_id, and when there
-- is no row the model refuses to run (services/crowdEngine.js case 3). A venue
-- that is not in the corpus therefore has, and will always have, NO
-- model-backed intelligence — and the single real venue_profiles row in
-- production is not in ml_venues, so this is the MODAL case and not an edge
-- one.
--
-- Recording it at claim time is what makes it enforceable. Without it the only
-- way to know is to ask the predictor at request time, which means the
-- dashboard has to render a paid analytics tab before it can discover there is
-- nothing behind it, and the owner has already been sold. With it, the answer
-- is on the profile row from the moment the place is picked.
--
-- Values:
--   'baselines'  — has ml_venue_baselines rows. Model-backed answers are honest.
--   'venue_only' — in ml_venues, no baseline curve yet. Collected, not modelled.
--   'absent'     — in neither. Nothing model-backed may be shown or sold.
--   'unknown'    — never checked, or the check failed. Treat as 'absent'.
-- NULL is 'unknown' by another name: every pre-existing row starts here.
--
-- Deliberately NOT a foreign key to ml_venues(google_place_id). The ML tables
-- are rebuilt by batch jobs in scripts/ml/, and a venue that drops out of a
-- retrain must not take an owner's profile row with it.
--
-- Everything is ADD COLUMN IF NOT EXISTS and nullable with no backfill, so a
-- replay is a no-op and no existing row changes. A profile written before
-- today keeps every value it had; it simply answers "unknown" until the owner
-- opens settings or the next GET refreshes it.

-- -- The room ----------------------------------------------------------------
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS capacity INTEGER;
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS service_style VARCHAR(24);
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS reservation_policy VARCHAR(24);
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS largest_walkin_group SMALLINT;
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS typical_dwell_minutes SMALLINT;
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS typical_spend_per_person SMALLINT;
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS has_outdoor_seating BOOLEAN;

-- -- The clock the door does not show ----------------------------------------
-- VARCHAR(5) 'HH:MM' and not TIME, to match operating_hours, which is JSONB of
-- owner-typed strings. One representation of "a time this venue does something"
-- per table; a TIME column here would mean two.
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS kitchen_last_order VARCHAR(5);
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS last_call VARCHAR(5);
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS age_policy VARCHAR(24);
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS age_restricted_after VARCHAR(5);

-- -- The week ----------------------------------------------------------------
-- TEXT[] of lowercase weekday names, same storage idiom as goals.
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS event_nights TEXT[];
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS event_note VARCHAR(120);
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS owner_busy_nights TEXT[];
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS target_night VARCHAR(12);

-- -- The street --------------------------------------------------------------
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS anchor_types TEXT[];
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS anchor_note VARCHAR(200);

-- -- The thing a stranger would not guess ------------------------------------
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS quirks TEXT;

-- -- Corpus membership -------------------------------------------------------
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS corpus_status VARCHAR(16);
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS corpus_baseline_rows INTEGER;
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS corpus_checked_at TIMESTAMPTZ;
