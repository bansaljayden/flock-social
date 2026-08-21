-- 044: venue_owner_report_context learns whether the event lookup ACTUALLY
-- HAPPENED, so a provider outage stops being written down as a quiet night.
--
-- WHAT WENT WRONG. 036 built this table on one doctrine, stated in its own
-- header: "NULL means not observed, never 0." Every weather column honours it.
-- The event columns did not. services/ownerReportContext.js wrote
--
--     has_nearby_event   = events ? events.hasEvent === true : null
--     total_nearby_events = events ? events.totalEvents ?? null : null
--
-- and `events` came back truthy in four different situations that are not the
-- same fact. mlPredictor.getNearbyEvents used to answer one shared "no events"
-- object whether Ticketmaster listed nothing, the per-account event budget
-- refused the call, the provider returned an error, or the request timed out.
-- Three of those four are "we did not look", and all four landed in this table
-- as has_nearby_event = FALSE, total_nearby_events = 0. A fabricated negative
-- observation, persisted, and then read back by
-- scripts/ml/train/ownerLabelExport.js as training context for the only live
-- 0-100 labels Flock has.
--
-- getNearbyEvents now returns `observed: true|false` plus an
-- `unavailableReason` on every path. This migration gives the table somewhere
-- to keep that, because a bare NULL is not enough on its own: NULL already
-- meant "the venue is outside ml_venues so there were no coordinates to look
-- near", and "Ticketmaster errored" has to be distinguishable from that when
-- the corpus is audited later.
--
--   events_observed = TRUE   Ticketmaster answered. has_nearby_event and the
--                            count columns are a measurement, including the
--                            genuinely quiet night where they are false and 0.
--   events_observed = FALSE  the lookup failed or was refused. Every event
--                            column beside it is NULL, and
--                            events_unavailable_reason says which failure it
--                            was (budget_exhausted, provider_error, timeout,
--                            lookup_failed, no_api_key, no_coordinates).
--   events_observed = NULL   no lookup was attempted at all, and no lookup
--                            could have been: no coordinates for the venue, or
--                            the predictor module would not load. This is the
--                            value every pre-044 row carries, which is the
--                            honest reading of them: nothing in those rows
--                            records whether their FALSE was seen or invented,
--                            and nothing ever will.
--
-- The column is deliberately not NOT NULL and carries no default. A default of
-- FALSE would say "we know the lookup failed" about rows written before anyone
-- was recording that, which is the same class of mistake this migration exists
-- to end.
--
-- HANDLERS NARROW, POST-CONDITIONS DECLARED. Both are 01f7ed6's rule, and this
-- file is the first written under it. duplicate_column and duplicate_object are
-- the only two conditions that mean "already there"; a lock_timeout, which
-- db/migrate.js arms at 10 seconds, must propagate and fail the boot so the next
-- one retries, rather than be recorded as applied with the columns missing.
-- services/ownerReportContext.js binds both of these on every owner slider move
-- from the moment it deploys, so a silently absent column is a capture that
-- throws for good.
--
-- @requires column venue_owner_report_context.events_observed
-- @requires column venue_owner_report_context.events_unavailable_reason

DO $$ BEGIN
  ALTER TABLE venue_owner_report_context
    ADD COLUMN IF NOT EXISTS events_observed BOOLEAN;
EXCEPTION WHEN duplicate_column OR duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE venue_owner_report_context
    ADD COLUMN IF NOT EXISTS events_unavailable_reason TEXT;
EXCEPTION WHEN duplicate_column OR duplicate_object THEN NULL; END $$;

-- No index. Nothing serves from this table (036's SERVING note), the training
-- export reads it one report row at a time through the primary key, and an
-- audit of "how many negatives were real" is a full scan of a table that holds
-- one row per owner slider move. Written down so the absence reads as a
-- decision rather than an oversight.
