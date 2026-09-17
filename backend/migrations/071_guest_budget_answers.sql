-- 071: a guest's budget answer, in the same pipe as a member's.
--
-- WHAT IT ADDS. budget_submissions gains guest_rsvp_id, so a row can be authored
-- by a guest RSVP instead of an account. Exactly one of user_id / guest_rsvp_id
-- is set, enforced by a CHECK; a guest has one row per plan, enforced by a
-- UNIQUE that the guest upsert conflicts on, the same way (flock_id, user_id)
-- is the member upsert's conflict target. user_id was already nullable (it is a
-- bare REFERENCES in 001), so no existing row moves and no column changes type.
--
-- WHY. The anonymous ceiling is the one interaction that is worse in a group
-- chat than in Flock, and it is also the one a person reaches from a share link
-- with no account. Until now the link could RSVP and vote and had to sit the
-- budget out, so a plan with three members and four guests computed its "group"
-- number over three people and showed it to seven. A guest's number now goes
-- into the same MIN, the same three-amount threshold and the same one-time
-- settle (routes/budget.js, MEMBER_SUBMISSIONS), and it is inert on the same
-- terms a departed member's row is: it counts only while the guest is a visible
-- 'in' answer on the plan.
--
-- SAME TABLE, NOT A SIBLING. Every reader of the ceiling goes through one
-- exported FROM fragment, and the privacy invariants are pinned on that
-- fragment (five readers, tested to answer alike). A second table would have
-- meant a UNION in every one of them, which is eight places to forget one.
--
-- Nothing here is CONCURRENTLY: the table is small (one row per person per
-- plan) and the index is partial over a column that is NULL on every row that
-- exists today.

ALTER TABLE budget_submissions
  ADD COLUMN IF NOT EXISTS guest_rsvp_id INTEGER REFERENCES guest_rsvps(id) ON DELETE CASCADE;

-- One author per row. A row with both would be counted once by the member arm
-- and once by the guest arm of the presence join; a row with neither would be
-- a number nobody said.
DO $$ BEGIN
  ALTER TABLE budget_submissions ADD CONSTRAINT budget_submissions_one_author
    CHECK (num_nonnulls(user_id, guest_rsvp_id) = 1);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- The guest upsert's conflict target. NULLs are distinct under UNIQUE, so the
-- member rows (guest_rsvp_id NULL) never collide with each other here, exactly
-- as guest rows (user_id NULL) never collide under the existing
-- (flock_id, user_id) key.
DO $$ BEGIN
  ALTER TABLE budget_submissions ADD CONSTRAINT budget_submissions_flock_guest_key
    UNIQUE (flock_id, guest_rsvp_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- The guest arm of MEMBER_SUBMISSIONS joins guest_rsvps through this column.
CREATE INDEX IF NOT EXISTS idx_budget_submissions_guest
  ON budget_submissions(guest_rsvp_id) WHERE guest_rsvp_id IS NOT NULL;
