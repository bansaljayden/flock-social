-- 005: guest RSVP takedown (round 9)
--
-- guest_rsvps.name is UNAUTHENTICATED user-generated content: anyone holding a
-- flock invite link can write one, and the value is broadcast to every member
-- over the `guest_rsvp` socket event. It is now profanity-screened on write in
-- routes/guest.js, but a screened field still needs a removal path (App Review
-- 1.2 requires reporting AND takedown on every UGC surface), and the table had
-- no way to hide a row short of deleting it and freeing its slot in the
-- per-flock guest cap.
--
-- Reads and broadcasts filter COALESCE(is_hidden, false) = false; the cap count
-- deliberately does not, so a takedown never hands the abuser a fresh slot.
-- Same tolerant DO-block style as 003/004 for drifted databases.

DO $$ BEGIN
  ALTER TABLE guest_rsvps ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT false;
EXCEPTION WHEN others THEN NULL; END $$;
