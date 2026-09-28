-- @requires table content_report_evidence
-- @requires column content_report_evidence.venue_data
--
-- 110: a saved copy of reported plan content, kept when the plan is deleted.
--
-- ASCII only, like 065 and 091-098: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY. messages.flock_id and guest_rsvps.flock_id are ON DELETE CASCADE, so
-- deleting a plan took every message and every guest answer in it along with
-- it, reported or not. The report row survived and the thing it reported did
-- not, so the moderator opened it to "That content no longer exists" with
-- nothing to judge, nothing to take down and nothing to export for
-- MODERATION-LEGAL.md step 2. The person with the most reason to make that
-- happen is the one who can: a plan's host deletes it, or leaves it, which
-- deletes it too, and the last member out empties it the same way. Every
-- other owner delete in the app already keeps reported content (the story
-- purge's open-report guard, the venue promotion and event retire, the message
-- unsend tombstone); a plan delete was the one that did not.
--
-- WHAT IS KEPT. Before a plan's delete runs, and in the same transaction
-- (utils/reportEvidence.js), each of its messages and guest answers that an
-- open or under-review report names is copied here. The columns are the ones
-- the moderation console reads from the live row (routes/admin.js
-- CONTENT_TEXT_SQL), under the same names, so the console renders a saved
-- copy through the same expression as the original and the two can never
-- read differently. Nothing here is served to anyone but the admin console,
-- and a message's own author, whose data export (GET /api/users/export) lists
-- the copies with author_id = them, because a held copy of their words is
-- still their data.
--
-- WHAT IS NOT. Reports already resolved or dismissed: a moderator has judged
-- them, which is the same line the story purge draws. And the author's own
-- account deletion is unchanged. author_id is ON DELETE CASCADE, so a saved
-- copy goes when its author's account does, exactly as the message itself
-- always has (routes/users.js deleteAccount, MODERATION-LEGAL.md step 2).
-- A plan delete is what no longer erases evidence; an account deletion still
-- does, for the reason written there.
--
-- HOW LONG. A copy exists only so its report can be judged, and a guest's copy
-- has no author whose account deletion would take it. So a timer
-- (purgeClosedReportEvidence in utils/reportEvidence.js, hourly, started by
-- server.js) deletes each copy once no report naming it is open or under
-- review and the last of them closed more than 7 days ago, the period the
-- privacy policy states. content_reports.resolved_at, written by every close,
-- is the clock.
--
-- flock_id carries no foreign key on purpose: the row exists because the plan
-- is gone. One row per piece of content, keyed like the report that names it,
-- so a second report on the same message does not store the image twice.
--
-- REPLAY. IF NOT EXISTS throughout, no backfill: content a plan delete took
-- before this file is not coming back. A second pass changes nothing.

CREATE TABLE IF NOT EXISTS content_report_evidence (
  id SERIAL PRIMARY KEY,
  content_type VARCHAR(20) NOT NULL,
  content_id INTEGER NOT NULL,
  flock_id INTEGER,
  message_text TEXT,
  venue_data JSONB,
  image_url TEXT,
  name VARCHAR(60),
  author_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ,
  is_hidden BOOLEAN NOT NULL DEFAULT false,
  preserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (content_type, content_id)
);

CREATE INDEX IF NOT EXISTS idx_content_report_evidence_author
  ON content_report_evidence (author_id);
