-- @requires column bill_splits.had_payer
--
-- 086: whether a bill has ever had a payer, so that a bill whose payer deleted
-- their account is no longer taken for a ghost-commit estimate.
--
-- ASCII only, like 065 and 082: the embedded server the boot-safety suite runs
-- is WIN1252.
--
-- ---------------------------------------------------------------------------
-- WHAT WENT WRONG
--
-- bill_splits.paid_by is ON DELETE SET NULL, and a ghost-commit shell has
-- paid_by NULL too. Once a payer deleted their account, the bill they rang up
-- could not be told apart from an estimate, and three readers took it for one:
--
--   - POST /api/budget/:flockId/reset deleted it. Posting a bill over a shell
--     copies `committed` onto the real rows, and the payer's own settled row
--     goes with their account, so what is left can be nothing but unpaid
--     commitments, which is the shape the reset clears as an estimate.
--   - GET /api/billing/:flockId withheld its total and every share whenever
--     the budget's number was not being shown, as though the amounts were the
--     budget ceiling rather than what the dinner cost.
--   - The app drew it as "~$40 each" off the group budget, with "Nobody has
--     paid yet" over rows somebody had paid.
--
-- ---------------------------------------------------------------------------
-- THE COLUMN
--
-- had_payer is set in the statement that stores a payer, the UPSERT in
-- POST /api/billing/:flockId/create, which is the only writer that stores one.
-- Nothing clears it: the foreign key's SET NULL touches paid_by alone. So:
--
--   paid_by set                     a bill with a payer
--   paid_by NULL, had_payer true    a real bill whose payer deleted their account
--   paid_by NULL, had_payer false   a ghost-commit shell, whose every figure is
--                                   the budget ceiling
--
-- NOT NULL DEFAULT false, so a row written by anything that does not name the
-- column (the ghost-commit INSERT does not) is an estimate. That is the side
-- that keeps the budget rule: an estimate's figures stay withheld while the
-- budget's number is not shown.
--
-- ---------------------------------------------------------------------------
-- THE BACKFILL
--
-- Every bill with a payer today has had one. A payerless bill had one if its
-- own columns show that POST /create wrote it. That route never writes a NULL
-- payer, and ghost commit, in every version since the money layer shipped,
-- inserts split_type 'equal', tip_percent 0 and paid_by NULL, writes shares
-- with committed = true and nothing else, and never sets updated_at. So any
-- one of these is proof:
--
--   - a tip_percent other than 0, or a split_type other than 'equal';
--   - updated_at different from created_at: both default to the same NOW() on
--     insert, and only /create's ON CONFLICT branch sets updated_at;
--   - a share whose committed is not true, which only /create writes, or one
--     carrying a credit, which only /create writes (paid_amount, 061).
--
-- A payerless bill showing none of them stays an estimate, and the reset
-- still spares one that holds a settled row or a credit, as it did before
-- this file.
--
-- ---------------------------------------------------------------------------
-- REPLAY
--
-- The backfill only ever sets true, and only on a row still false. A second
-- pass finds nothing to change: a shell written after this file matches none
-- of the conditions above, and every bill /create writes is already true.

ALTER TABLE bill_splits ADD COLUMN IF NOT EXISTS had_payer BOOLEAN NOT NULL DEFAULT false;

UPDATE bill_splits b SET had_payer = true
 WHERE b.had_payer = false
   AND (b.paid_by IS NOT NULL
        OR b.tip_percent IS DISTINCT FROM 0
        OR b.split_type IS DISTINCT FROM 'equal'
        OR b.updated_at IS DISTINCT FROM b.created_at
        OR EXISTS (SELECT 1 FROM bill_split_shares s
                    WHERE s.bill_id = b.id
                      AND (s.committed IS NOT TRUE OR COALESCE(s.paid_amount, 0) <> 0)));
