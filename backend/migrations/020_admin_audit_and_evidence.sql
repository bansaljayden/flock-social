-- 020: the audit trail catches up with the last two unaudited admin powers,
-- evidence access gets a record, and an owner's delete stops being able to
-- destroy evidence a moderator was asked to look at (round 23)
--
-- FOUR new values in the moderation_actions.action CHECK, one column pair.
--
-- THE UNAUDITED ROUTES. Two of the three state-changing admin routes wrote no
-- audit row at all:
--
--   PUT /venues/:profileId/verify   flips the gate on who may speak as a
--                                   business (public badge, promotions, review
--                                   replies) and recorded nothing in either
--                                   direction.
--   POST /venues/:userId/tier       is the ONLY server-side writer of
--                                   venue_profiles.tier — the whole manual
--                                   billing control — and it accepted a
--                                   `reason` and threw it into console.log,
--                                   which Railway rotates away.
--
-- Both write moderation_actions rows now ('venue_verified', 'venue_unverified',
-- 'tier_changed'), inside the same statement as the mutation, so the row and
-- the record land together or not at all — the same doctrine as the takedown
-- transaction in routes/admin.js.
--
-- THE UNRECORDED READS. GET /reports/:id/image and /reports/:id/content serve
-- reported UGC in full — deliberately unfiltered on is_hidden, and, in the
-- image case, sometimes from a minor's camera roll. Nothing recorded that the
-- access happened, so nothing distinguished a moderator who opened one report
-- from one who enumerated the queue. 'evidence_viewed' is that record: one row
-- per successful serve, written BEFORE the response, so a failed write is a
-- failed read. The default audit-log list excludes these rows (access records
-- would drown the decisions a moderator reads the log for); they stay in the
-- table and GET /moderation-actions?include_evidence=true serves them.
--
-- THE OWNER DELETE. DELETE /venue-dashboard/promotions/:id and /events/:id had
-- no report predicate, so an owner could permanently destroy the row a
-- moderator had been asked to judge — hide preserved the evidence and delete
-- erased it. routes/stories.js already solved this for story deletion: while a
-- report is open or under review, the DELETE's own predicate refuses (no
-- check-then-act window), and the author instead gets a retirement that looks
-- exactly like a delete, because naming the open report would tip off the one
-- person with a motive to sanitize the evidence. `owner_deleted_at` is the
-- venue analogue of the story retirement: the row survives for the moderation
-- queue, and every owner-facing and public read path treats it as gone. The
-- next DELETE the owner issues sweeps any retired rows whose reports have since
-- closed, so the retention window ends with the review, exactly like the story
-- purge. Deleting hidden-but-unreported content still works: after a resolved
-- takedown, cleanup is the owner's to do, and the 409 CONTENT_HIDDEN copy in
-- routes/venueDashboard.js promises exactly that.
--
-- Deliberately NOT wrapped in the tolerant `DO $$ ... EXCEPTION WHEN others
-- THEN NULL` block that 003/005/016 use, for the reason 017 spells out at
-- length: db/migrate.js records the filename in schema_migrations whether or
-- not the body worked and never retries, so a swallowed failure marks the fix
-- applied while leaving the old constraint in place — the silent drift 017
-- exists to end. Plain ALTERs are safe here:
--
--   * DROP CONSTRAINT IF EXISTS cannot fail on a missing constraint, and the
--     name is Postgres's deterministic one for a column-level CHECK
--     (<table>_<column>_check), the same name 016/017/019 rely on.
--   * The new action list is a strict SUPERSET of 017's, so no existing row
--     can violate it and ADD CONSTRAINT cannot fail validation.
--   * ADD COLUMN IF NOT EXISTS with no default (NULL) is a catalogue-only
--     change, so it does not rewrite either table.
--
-- The only way these statements fail is moderation_actions, venue_promotions
-- or venue_events not existing, which would mean 001 never applied and the
-- moderation queue is already broken on every action. That earns the loud
-- `FATAL: migration failed` boot refusal.
--
-- This is the same commit as the route changes that write the new values —
-- 017's rule, learned the hard way three times (003, 016, 017): widen the
-- constraint in the SAME change as the code that needs it.
--
-- No index on owner_deleted_at: every read that filters it already goes
-- through the venue_user_id index (014) or the google_place_id index (001),
-- and a mostly-NULL timestamp is not selective enough to earn one.

ALTER TABLE moderation_actions DROP CONSTRAINT IF EXISTS moderation_actions_action_check;

ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_action_check
  CHECK (action IN (
    'content_hidden',
    'content_restored',
    'content_removed',
    'user_warned',
    'user_banned',
    'user_unbanned',
    'dismissed',
    'venue_verified',
    'venue_unverified',
    'tier_changed',
    'evidence_viewed'
  ));

ALTER TABLE venue_promotions ADD COLUMN IF NOT EXISTS owner_deleted_at TIMESTAMPTZ;

ALTER TABLE venue_events ADD COLUMN IF NOT EXISTS owner_deleted_at TIMESTAMPTZ;
