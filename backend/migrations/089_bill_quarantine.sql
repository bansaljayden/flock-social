-- @requires column bill_splits.quarantined
--
-- 089: every bill that could still hold a budget answer the early ghost commit
-- copied into it, taken out of reach whole.
--
-- ASCII only, like 065 and 082: the embedded server the boot-safety suite runs
-- is WIN1252.
--
-- ---------------------------------------------------------------------------
-- WHY WHOLE BILLS, AND NOT ROWS
--
-- Until 2026-08-26 the ghost commit wrote the group budget number into bills
-- as it then stood: the live minimum of the answers, unbanded, with no
-- threshold before 2026-08-12, so one answer in it was that person's exact
-- amount. It went into whatever bill the flock had, a posted one included,
-- until 2026-08-13 (088's header has the history). A figure written that way
-- did not stay in its row. It could be the amount on another member's share
-- (one member's only answer, as somebody else's share), a credit carried onto
-- a later row, or a payment banked against a later split, and so the
-- difference between the bill's total and the rows anybody can see. 088
-- marked rows, and that left three more ways back to the number: the settled
-- flag of a row whose figures were hidden, which a payer could probe with
-- custom splits; the subtraction across rows 088 had to call posted; and the
-- share's own member, who may be holding somebody else's answer. Every one of
-- them lives on a bill that existed while the early ghost commit ran. So those
-- bills are quarantined whole: routes/billing.js sends no figure, flag or
-- count from one, to anybody, the share's own member included, and refuses
-- every write that would carry one forward. routes/flocks.js stops holding
-- anybody to one, since it can no longer be settled, and the data export lists
-- it without its figures.
--
-- ---------------------------------------------------------------------------
-- WHICH BILLS
--
-- Created before 2026-08-27 00:00 US Eastern (04:00 UTC). The commit that made
-- the ghost commit write only the settled, banded number (06c85c5b) is dated
-- 2026-08-26 01:09 Eastern, the first push that carried it went out at 01:20,
-- and about twenty more went out that day, each of them a deploy. The cut-off
-- sits most of a day after that on purpose: a bill wrongly left out can leak,
-- and a bill wrongly taken in only stops showing figures from a plan that is
-- a month old.
--
-- In a flock that could ever have had a budget. A ghost commit needed a cached
-- budget number, only a budget answer produces one, and every version of the
-- answer route refused a flock whose budget_enabled was false. budget_enabled
-- is set when the flock is made and nothing changes it afterwards, which is
-- why it is the test rather than the answers themselves: answers are deleted
-- by a reset and by an account deletion, and until 2026-08-26 a sweep in 001
-- deleted every answer of a flock finished more than a day. A flag that is
-- NULL counts as a budget flock, and any answer still present counts too.
--
-- created_at is set once when the bill row is inserted and nothing rewrites it
-- (the ON CONFLICT branch of POST /create does not touch it). A missing one
-- counts as old.
--
-- ---------------------------------------------------------------------------
-- REPLAY
--
-- The match set is fixed: a constant cut-off, a flag that never changes, and
-- only bills that already exist can be older than the cut-off. The update only
-- ever sets true, on rows still false, so a second pass changes nothing, and a
-- bill made after this file is never matched. NOT NULL DEFAULT false, so every
-- new bill starts outside the quarantine.
--
-- The UPDATE also runs after the files on every boot (db/migrate.js, with the
-- same WHERE in db/billQuarantine.js), because a restore from a dump taken
-- before this file loads these bills with the flag false and nothing would run
-- this file again. 090 indexes exactly the bills that boot would change.

ALTER TABLE bill_splits ADD COLUMN IF NOT EXISTS quarantined BOOLEAN NOT NULL DEFAULT false;

UPDATE bill_splits b SET quarantined = true
 WHERE b.quarantined = false
   AND (b.created_at IS NULL OR b.created_at < TIMESTAMPTZ '2026-08-27 04:00:00+00')
   AND EXISTS (SELECT 1 FROM flocks f
                WHERE f.id = b.flock_id
                  AND (f.budget_enabled IS NOT FALSE
                       OR EXISTS (SELECT 1 FROM budget_submissions s WHERE s.flock_id = f.id)));
