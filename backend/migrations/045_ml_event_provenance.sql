-- 045: ml_training_data learns whether its event columns are a MEASUREMENT,
-- so a future enrichment run stops being indistinguishable from one that never
-- happened.
--
-- WHAT WENT WRONG, and it is the same defect 044 fixed one table over.
-- 006 created the column as
--
--     has_nearby_event BOOLEAN DEFAULT false
--
-- and scripts/ml/enrichWithEvents.js writes, on its no-event branch, exactly
-- the values that default already holds: has_nearby_event = false,
-- total_nearby_events = 0, total_nearby_attendance = 0,
-- nearest_event_distance_km = NULL, nearest_event_type = NULL. So "the
-- enrichment ran, looked, and there was nothing within 2 km in that hour" is
-- byte-identical to "the enrichment never touched this row", and both are
-- byte-identical to "ml_events holds no events for this city at all, so there
-- was nothing to match against".
--
-- That third case is the one that matters. The matcher indexes ml_events by
-- city and date; a city with zero collected events falls straight through the
-- `dowEvents.length === 0` branch and every row in it is stamped false. A
-- measurement of Ticketmaster coverage was written down as a fact about the
-- city.
--
-- THE MEASUREMENT, taken 2026-08-20 against production: ml_training_data holds
-- 3,912,357 rows, of which 3,688,137 carry has_nearby_event = false, 224,220
-- carry true, and NONE carry NULL. 22 of 34 cities hold ZERO true rows,
-- totalling 2,194,300 rows, 56.1% of the corpus. Philadelphia alone holds
-- 144,665 rows and not one nearby event across the entire collection window,
-- which is not a fact about Philadelphia.
--
--   events_observed = TRUE   the row was matched against a non-empty event
--                            index for its OWN city and its OWN observed date.
--                            The event columns beside it are a measurement,
--                            including the genuinely quiet night where they
--                            are false and 0.
--   events_observed = FALSE  no match could have happened. The event columns
--                            beside it are NULL, and events_unavailable_reason
--                            says which of the three it was:
--                            no_events_for_city (ml_events holds nothing for
--                            this city, so the negative is about our
--                            collection), no_events_on_date (the city has
--                            events but none on this row's date, and nothing
--                            records whether that date was inside the
--                            collection window), no_observation_date (a weekly
--                            "typical week" row, which has no date a one-off
--                            concert could be attributed to).
--   events_observed = NULL   nothing recorded whether the lookup happened.
--                            This is the value every one of the 3,912,357
--                            existing rows carries, and it is the honest
--                            reading of them.
--
-- THIS MIGRATION DOES NOT BACKFILL, AND NO LATER ONE MAY. The existing rows
-- are not retrospectively separable: an observed false and a fabricated false
-- left the same six values behind, and no column, timestamp or log distinguishes
-- them now. Stamping them events_observed = FALSE would assert we know they
-- were failures; stamping them TRUE would assert the opposite. Both would be
-- the invention this file exists to stop. They stay NULL, MODEL-METRICS.md
-- records the breakdown, and the next retrain treats the pre-045 corpus as
-- carrying an unquantified negative-event leak alongside the population
-- confound.
--
-- No default, deliberately, for the reason 044 states: a default of FALSE would
-- say "we know the lookup failed" about every row written before anyone was
-- recording that.
--
-- No index. Nothing serves from this table; the export reads it through a
-- per-city sequential scan either way, and the coverage census is a full scan
-- by construction.
--
-- HANDLERS NARROW, POST-CONDITIONS DECLARED (01f7ed6 / d8c8ef4). duplicate_column
-- and duplicate_object are the only two conditions that mean "already there"; a
-- lock_timeout, which db/migrate.js arms at 10 seconds, must propagate and fail
-- the boot so the next one retries, rather than be recorded as applied with the
-- columns missing.
--
-- @requires column ml_training_data.events_observed
-- @requires column ml_training_data.events_unavailable_reason

DO $$ BEGIN
  ALTER TABLE ml_training_data
    ADD COLUMN IF NOT EXISTS events_observed BOOLEAN;
EXCEPTION WHEN duplicate_column OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE ml_training_data
    ADD COLUMN IF NOT EXISTS events_unavailable_reason TEXT;
EXCEPTION WHEN duplicate_column OR duplicate_object THEN NULL; END $$;
