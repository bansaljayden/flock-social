-- 114: a venue owner's reply to a review becomes reportable on its own.
--
-- ASCII only, like 094 and 100-102: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY. A review's venue_reply is the owner's public answer, owner-typed and
-- shown under the review to everybody. There was no way to report it except
-- by reporting the REVIEW, and that report named the reviewer: the reviewer
-- tapping Report on an abusive reply was told they could not report their own
-- content, a third party's report landed on the reviewer, and the console's
-- Warn, Ban and Hide all hit the reviewer and their review. Nothing reached
-- the owner (backend audit 2026-10-03).
--
-- 'venue_reply' is that report: content_id is the review's id, the reported
-- user is the reply's author (venue_reply_user_id), and a takedown hides the
-- reply and nothing else, through venue_reply_hidden, which an un-hide can
-- reverse. Every public read already gates the reply on its author still
-- holding the place; it now also gates on this column (routes/venueDashboard.js).
--
-- ADDITIVE. ADD COLUMN with a constant default is a catalog change, no rewrite
-- and no scan; every existing reply reads as not hidden. The CHECK is widened
-- the way 003, 016 and 019 widened it, by name, since those three named it.
-- @requires column venue_reviews.venue_reply_hidden
ALTER TABLE venue_reviews ADD COLUMN IF NOT EXISTS venue_reply_hidden BOOLEAN NOT NULL DEFAULT false;

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
    'venue_event',
    'venue_reply'
  ));
