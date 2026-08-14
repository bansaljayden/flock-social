-- 016: let guest RSVP reports actually reach the moderation queue (round 17)
--
-- routes/moderation.js added 'guest_rsvp' to VALID_CONTENT_TYPES in round 13
-- and routes/admin.js added the matching entry to its takedown table map, but
-- the CHECK constraint on content_reports.content_type was never widened. The
-- last word on it is 003:87-89, which lists six types and not this one.
--
-- The user-visible effect: POST /api/reports with content_type 'guest_rsvp'
-- passed express-validator, passed the flock-membership visibility check, then
-- died on the INSERT with a 23514 CHECK violation. The route's catch turned
-- that into `500 Failed to submit report`. So the ONLY takedown path for an
-- abusive guest name — unauthenticated UGC that is broadcast live to every
-- member of a flock, which migration 005 built an entire is_hidden pipeline
-- for — has never once been reachable. Every read path filters the column
-- nothing could ever set.
--
-- This is the SECOND time this exact drift has shipped; 003's own comment
-- records the first ("every new-type report 500'd at the database"). The
-- durable guard is now a test: __tests__/safetyFlow.test.js reads this file and
-- fails if VALID_CONTENT_TYPES and the constraint ever disagree again, so the
-- next added type cannot reach production as a 500 on the report button.
--
-- Same tolerant DO-block style as 003/005 for databases in a drifted state.

DO $$ BEGIN
  ALTER TABLE content_reports DROP CONSTRAINT IF EXISTS content_reports_content_type_check;
  ALTER TABLE content_reports ADD CONSTRAINT content_reports_content_type_check
    CHECK (content_type IN ('flock_message','dm','profile','story','venue_review','venue_promotion','guest_rsvp'));
EXCEPTION WHEN others THEN NULL; END $$;
