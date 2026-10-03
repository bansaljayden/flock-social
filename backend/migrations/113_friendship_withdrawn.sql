-- 113: a declined friend request that its requester has cancelled.
--
-- ASCII only, like 094 and 100-102: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY. A declined request is kept, as 'declined', for two jobs: it is masked
-- as still pending to the person who was declined (a decline is never shown to
-- them), and its created_at carries the one-revive-a-day cooldown that stops a
-- declined stranger from re-sending on a loop (routes/friends.js
-- reRequestDeclined). But the requester could cancel it, and that answer
-- differed from cancelling a request still pending: a pending one left Sent
-- requests, a declined one stayed there, and that difference is exactly the
-- decline the masking hides (backend audit 2026-10-03).
--
-- 'withdrawn' is that row after the cancel. To its requester it reads as no
-- request at all, as a cancelled pending one does; to the person who declined
-- it reads as the decline it still is; and it keeps created_at, so the
-- cooldown survives the cancel. Every read and write is in routes/friends.js.
--
-- THE CHECK IS FOUND BY WHAT IT SAYS, NOT BY NAME. The baseline declared it
-- inline, so its name is whatever Postgres chose where the table was made.
-- Any CHECK on friendships that mentions status is dropped and the widened one
-- added, so a replay is a no-op in effect. ADD CONSTRAINT validates the rows
-- already there, all of which hold one of the three older values.
-- @requires table friendships
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.friendships'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.friendships DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE public.friendships ADD CONSTRAINT friendships_status_check
    CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn'));
END $$;
