-- 019: venue_events gets the takedown affordance every sibling already has,
-- and 'venue_event' becomes a reportable content type (round 20)
--
-- THE DRIFT. venue_events is owner-authored UGC written through
-- POST /api/venue-dashboard/events. It is screened by rejectIfProfane on write,
-- exactly like venue_promotions, and it is the ONLY one of the venue tables
-- with no is_hidden column: 003 gave venue_reviews and venue_promotions theirs,
-- 005 gave guest_rsvps theirs, and venue_events was passed over three times. So
-- a moderator had no way to remove an event title short of deleting the row out
-- of production by hand, and routes/moderation.js had no type to accept a
-- report against one.
--
-- WHY NOW, GIVEN NOTHING SERVES IT. Today the gap is inert: no route renders a
-- venue event to anybody but its own owner, so there is no public surface to
-- abuse. That is precisely the moment this is cheap. The failure mode is not a
-- bug in the current release, it is the shape of the next one — somebody adds
-- `GET /api/venues/:placeId/events` to put events on the venue card, ships it
-- in an afternoon because the table and the write path already exist, and that
-- release puts user-generated content in front of teenagers with no report
-- button and no takedown path. Guideline 1.2 is not satisfied by "we will add
-- it when the feature lands"; it is satisfied by every UGC surface having both
-- on the day it ships.
--
-- migrations/017 exists because this exact class of drift has now been caught
-- FOUR times (003, 016, 017, and this file), always in the same direction:
-- route code widened, schema behind it not. Here the schema goes first.
--
-- Deliberately NOT wrapped in the tolerant `DO $$ ... EXCEPTION WHEN others
-- THEN NULL` block that 003/005/016 use, for the reason 017 spells out at
-- length: db/migrate.js records the filename in schema_migrations whether or
-- not the body worked and never retries, so a swallowed failure marks the fix
-- applied while leaving the old schema in place. That is the silent drift this
-- file exists to end, and it must not be the way this file fails.
--
-- Every statement below is safe to run against the production database:
--
--   * ADD COLUMN IF NOT EXISTS with a constant DEFAULT is a catalogue-only
--     change on PostgreSQL 11+, so it does not rewrite the table.
--   * DROP CONSTRAINT IF EXISTS cannot fail on a missing constraint, and the
--     name is Postgres's deterministic one for a column-level CHECK
--     (<table>_<column>_check) — the same name 016 and 017 rely on.
--   * The new content_type list is a strict SUPERSET of 016's, so no existing
--     row can violate it and ADD CONSTRAINT cannot fail validation.
--
-- The only way these fail is venue_events or content_reports not existing,
-- which would mean 001 never applied and the moderation queue is already broken
-- on every action. That earns the loud `FATAL: migration failed` boot refusal.
--
-- No index here. Reads of venue_events go by venue_user_id (indexed by 014) or
-- google_place_id (indexed by 001), and a takedown flag with a default of false
-- is not selective enough to earn one of its own; content_reports(content_type,
-- content_id) was covered by 018. Nothing in this file needs @noTransaction, so
-- the column and the constraint land together or not at all.

ALTER TABLE venue_events ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT false;

-- Reads and broadcasts of the other four tables filter
-- COALESCE(is_hidden, false) = false. Any future public events route must do
-- the same; the column is the affordance, not the enforcement.

ALTER TABLE content_reports DROP CONSTRAINT IF EXISTS content_reports_content_type_check;

ALTER TABLE content_reports ADD CONSTRAINT content_reports_content_type_check
  CHECK (content_type IN (
    'flock_message',
    'dm',
    'profile',
    'story',
    'venue_review',
    'venue_promotion',
    'guest_rsvp',
    'venue_event'
  ));
