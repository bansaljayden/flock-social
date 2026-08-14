-- 017: give the audit log a word for "we put it back" (round 18)
--
-- Until now there was no un-hide anywhere in the backend. routes/admin.js could
-- set is_hidden = true on six content tables and nothing anywhere could set it
-- back to false, so a mistaken takedown was reversible only by someone with a
-- psql prompt against production. Every read path in the app filters
-- COALESCE(is_hidden, false) = false, so a wrong takedown was permanent.
--
-- The route change is worthless without this file. moderation_actions.action
-- carries a CHECK constraint written inline in 001_baseline.sql:356 listing
-- exactly six values —
--
--   content_hidden, content_removed, user_warned, user_banned, user_unbanned,
--   dismissed
--
-- — and not one of them means "restored". admin.js writes its audit row INSIDE
-- the same transaction as the mutation, so an un-hide would have raised 23514
-- on the INSERT, rolled the whole transaction back, and come back to the
-- moderator as `500 Failed to apply action`. The un-hide would not have
-- happened, and the moderator would have been told the system broke rather than
-- that it refused.
--
-- This is the THIRD time this exact constraint drift has been about to ship:
-- 003 records the first ("every new-type report 500'd at the database") and 016
-- the second (guest_rsvp reports 500'd for the entire life of the feature).
-- Both times route code was widened and the CHECK constraint behind it was not.
-- The durable guard is a test, not a comment: __tests__/unhidePath.test.js
-- reads THIS file and every action string routes/admin.js can assign, and fails
-- if the two ever disagree again.
--
-- Deliberately NOT wrapped in the tolerant `DO $$ ... EXCEPTION WHEN others
-- THEN NULL` block 003 and 016 use. That block swallows the failure, and
-- db/migrate.js records 017 in schema_migrations regardless, so a swallowed
-- failure would mark the fix applied while leaving the old constraint in place
-- — which is precisely the silent drift this migration exists to end. Plain
-- ALTERs are safe here for two reasons:
--
--   * DROP CONSTRAINT IF EXISTS cannot fail on a missing constraint, and the
--     name is Postgres's deterministic one for a column-level CHECK
--     (<table>_<column>_check), the same name 016 relies on.
--   * The new list is a strict SUPERSET of the old one, so no existing row can
--     violate it and ADD CONSTRAINT cannot fail validation.
--
-- The only way these statements fail is moderation_actions not existing, which
-- would mean 001 never applied and admin.js's audit INSERT is already broken on
-- every action. That deserves the loud `FATAL: migration failed` boot refusal,
-- not a shrug.
--
-- content_removed is left in the list untouched. Nothing writes it today (the
-- takedown is reversible-hide, never a delete), but it is a distinct meaning
-- from content_restored and dropping a value that historic rows may hold would
-- fail this very migration.

ALTER TABLE moderation_actions DROP CONSTRAINT IF EXISTS moderation_actions_action_check;

ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    'content_hidden',
    'content_restored',
    'content_removed',
    'user_warned',
    'user_banned',
    'user_unbanned',
    'dismissed'
  ));
