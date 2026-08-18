-- 028: flock_invite_links.expires_at — an invite link stops being a credential
--
-- SECURITY-AUDIT-auth.md R2-4 (MEDIUM). `flock_invite_links` carried token,
-- flock_id, created_by, revoked, created_at and NO expiry, and resolveLink's
-- only gates were `revoked = false` plus a terminal flock status. Nothing in
-- the codebase moves a flock to 'completed'/'cancelled' on its own — every one
-- of those writes is behind the creator-only PUT /api/flocks/:id — and
-- event_time was never consulted by the link path at all. So a link shared into
-- a group chat for a Friday plan was still a live bearer credential a year
-- later, and POST /api/guest/:token/join turns holding it into
-- flock_members.status = 'accepted': the flock chat, the live location
-- fan-out, the budget ceiling and the per-person bill shares.
--
-- WHY THIS LIFETIME. Two rules, whichever is later:
--
--   * event_time + 7 days. The link exists to get people to one plan, so the
--     plan is what should retire it. Seven days of grace covers the "we moved
--     it to next weekend" edit and the post-hangout tail (feedback, bill
--     splits) without leaving the door open for a season.
--   * created_at + 14 days. A floor, because event_time is NULLABLE and is
--     also allowed to be in the past — a link for a plan with no date set yet
--     must not be born expired. Fourteen days is the same order as the
--     planning horizon the product assumes and is long enough that nobody hits
--     it while a plan is still being arranged.
--
-- Not tied to `revoked`: revocation stays the instant kill switch a host can
-- pull, this is the deadline that applies when nobody pulls it.
--
-- EXISTING ROWS get the same formula computed from the data they already
-- carry, NOT a fresh window. Backfilling to NOW() + 14 days would hand every
-- already-leaked link two more weeks, which is the opposite of the finding. A
-- link minted last week for a plan next month stays live; a link minted six
-- months ago for a plan that has passed is retired the moment this runs. There
-- are ~0 real users, so nothing in flight is being broken.
--
-- ENFORCEMENT lives in routes/guest.js resolveLink, which now also requires
-- `expires_at > NOW()`. An expired link therefore resolves to NULL and answers
-- exactly the way an invented token does — the route cannot tell the caller
-- whether the link ever existed.
--
-- The column ends NOT NULL with a DEFAULT so the guarantee does not depend on
-- every future INSERT remembering to compute one; an INSERT that omits it still
-- gets a bounded link rather than a permanent one.
--
-- Same tolerant DO-block style as 003/004/005/026 for drifted databases.

DO $$ BEGIN
  ALTER TABLE flock_invite_links ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
EXCEPTION WHEN others THEN NULL; END $$;

UPDATE flock_invite_links il
SET expires_at = GREATEST(
      COALESCE(il.created_at, NOW()) + INTERVAL '14 days',
      COALESCE(f.event_time, COALESCE(il.created_at, NOW())) + INTERVAL '7 days'
    )
FROM flocks f
WHERE f.id = il.flock_id
  AND il.expires_at IS NULL;

-- Any row whose flock vanished from under it (should be impossible — the FK is
-- ON DELETE CASCADE — but the backfill above is a join and a join can miss).
UPDATE flock_invite_links
SET expires_at = COALESCE(created_at, NOW()) + INTERVAL '14 days'
WHERE expires_at IS NULL;

ALTER TABLE flock_invite_links ALTER COLUMN expires_at SET DEFAULT NOW() + INTERVAL '14 days';
ALTER TABLE flock_invite_links ALTER COLUMN expires_at SET NOT NULL;

-- resolveLink filters on token (the primary key) and then on expiry, so this is
-- not a lookup index. It is for the eventual sweep that deletes dead rows.
CREATE INDEX IF NOT EXISTS idx_invite_links_expires ON flock_invite_links(expires_at);
