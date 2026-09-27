-- @requires column guest_rsvps.retired_at
--
-- 098: when a guest answer left the plan because its person joined it as a
-- member, told apart from a moderator taking it down.
--
-- ASCII only, like 065 and 082: the embedded server the boot-safety suite runs
-- is WIN1252.
--
-- ---------------------------------------------------------------------------
-- WHAT WENT WRONG
--
-- Two doors retire a guest row when its person becomes a member: the share
-- link's join and the invite accepted in the app (utils/guestRsvp.js,
-- RETIRE_ON_LINK_JOIN_SQL and RETIRE_ON_INVITE_ACCEPT_SQL). They hide the row,
-- so it leaves every count, and hiding was all they wrote. A moderator's
-- takedown is also nothing but a hidden row, and the takedown's replay guard
-- (routes/guest.js nameIsTakenDown) refuses any name a hidden row on the plan
-- carries. So Sam answered the link as "Sam", made the account "Sam Rivera"
-- and joined, and from then on:
--
--   - a different Sam opening the same link was told "That name cannot be used
--     on this flock", the sentence a takedown gets;
--   - the first Sam's own browser was told their answer was gone and to answer
--     again, on a plan they had just joined, and answering as Sam was refused
--     the same way.
--
-- ---------------------------------------------------------------------------
-- THE COLUMN
--
-- retired_at is set by the two retire statements, in the same UPDATE that
-- hides the row, and by nothing else. A hidden row with it NULL is a takedown;
-- a hidden row with it set was retired on a join. The moderator's hide and
-- un-hide of a guest row clear it (routes/admin.js TAKEDOWN_TARGETS), so a
-- retired row a moderator then takes down is a takedown like any other, and a
-- row brought back is a live answer again. Nullable with no default. Only the
-- retire statements' readers look at it, and only as NULL or not: the time
-- itself is a record, not an input.
--
-- ---------------------------------------------------------------------------
-- THE ROWS RETIRED BEFORE THIS FILE
--
-- Without a backfill every join from before this file kept reading as a
-- takedown, and those names stayed refused with the moderation sentence. They
-- can be told apart after the fact, because only two things have ever hidden
-- a guest row: the retire statements (and their earlier spellings, all joins)
-- and the moderator's takedown, which is reached only from a guest_rsvp report
-- (routes/admin.js PUT /reports/:id) and writes a moderation_actions row
-- naming the row in the same transaction. So a hidden row that no report and
-- no moderation action has ever named was retired on a join, and is stamped.
--
-- Both tables are asked, because either can outlive the other: a report goes
-- with its reporter's account (content_reports.reporter_id is ON DELETE
-- CASCADE), and the audit row stays with its report_id set to NULL. Any report
-- at all keeps the row as it was, including one a moderator dismissed and a
-- row retired later: that is the side that keeps whatever a moderator decided.
-- The stamp is the time this ran, not the time of the join, which nothing
-- recorded.
--
-- A restore from a dump taken before this file lands its retired rows without
-- the stamp, after this has already run on the empty database: they read as
-- takedowns again, which is where they stood before this file, never the
-- other way round.
--
-- ---------------------------------------------------------------------------
-- WHAT THE STAMP OPENS, ON PURPOSE
--
-- The guard refused a retired row's name, which also stopped the person who
-- had just joined from answering the link again under that same first name
-- from another browser. It cannot tell that person from a different Sam: the
-- guest routes are anonymous, and a retired row does not say which account it
-- became. So a member can now be counted a second time by answering the link
-- as a guest, exactly as a member always could under any other name. Refusing
-- it would be refusing every other Sam, which is the defect this file fixes.
-- The browser that answered first is told it joined (routes/guest.js
-- JOINED_IN_APP) rather than asked to answer again.
--
-- ---------------------------------------------------------------------------
-- REPLAY
--
-- IF NOT EXISTS, and the backfill only ever stamps a hidden, unstamped row
-- that nothing in moderation names. After this file every takedown has both a
-- report and an audit row and every retirement is stamped, so a second pass
-- finds nothing to change.

ALTER TABLE guest_rsvps ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

UPDATE guest_rsvps g
   SET retired_at = NOW()
 WHERE g.is_hidden IS TRUE
   AND g.retired_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM content_reports r
                    WHERE r.content_type = 'guest_rsvp' AND r.content_id = g.id)
   AND NOT EXISTS (SELECT 1 FROM moderation_actions a
                    WHERE a.content_type = 'guest_rsvp' AND a.content_id = g.id);
