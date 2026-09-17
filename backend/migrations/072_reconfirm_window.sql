-- 072: the night-of "still in?" window.
--
-- WHAT IT ADDS. flocks.reconfirm_opened_at is the instant the window opened,
-- written once by services/reconfirmSweep.js, and set back to NULL by
-- routes/flocks.js when the plan's time moves (an answer to "still in for 9?"
-- is not an answer to "still in for 11?"). flock_members.reconfirmed_at and
-- guest_rsvps.reconfirmed_at are each person's answer inside that window, one
-- tap, from the app or from the invite link.
--
-- WHY. "Lock it in" is one person's tap, usually days out. The question the
-- night actually turns on is asked a few hours before, by whoever is willing to
-- type "we still doing this?" into the group chat, and it is answered by
-- whoever happens to look. Everyone else decides whether to get dressed on a
-- guess. The window makes that a structured question with a count: it opens a
-- fixed lead before the plan's time, every yes flips to unanswered, each person
-- re-taps, and the plan shows "4 of 7 still in" with the deadline. The link
-- matters as much as the app: a guest answers it with no account, which is the
-- one thing a non-user wanted to know before leaving the house.
--
-- The index is what the sweep walks: confirmed plans with no window yet, in
-- time order. Partial, so a plan that is over, or already asked, is not in it.

ALTER TABLE flocks ADD COLUMN IF NOT EXISTS reconfirm_opened_at TIMESTAMPTZ;
ALTER TABLE flock_members ADD COLUMN IF NOT EXISTS reconfirmed_at TIMESTAMPTZ;
ALTER TABLE guest_rsvps ADD COLUMN IF NOT EXISTS reconfirmed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_flocks_reconfirm_due
  ON flocks (event_time) WHERE status = 'confirmed' AND reconfirm_opened_at IS NULL;
