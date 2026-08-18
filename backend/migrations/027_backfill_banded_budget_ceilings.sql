-- 027: backfill flocks.budget_ceiling onto the published band.
--
-- WHAT WENT WRONG. The budget ceiling is MIN(budget_submissions.amount), which
-- for three submissions is one member's exact figure, and two colluding
-- accounts pinned high can force the MIN to be the third person's real number.
-- The fix (1fdea72, routes/budget.js) publishes a BAND instead: the value is
-- rounded DOWN to $10 steps at $50+, $5 steps at $5-49.99, $1 steps at
-- $1-4.99, and a flat $0.01 below a dollar, so what the group learns is an
-- interval, never anyone's amount. See the long comment above bandCeiling() in
-- routes/budget.js for why down, and why not zero.
--
-- That fix banded the value on the way IN, on the theory that a cached column
-- written by banded code holds a banded number. True for every row written
-- since it deployed. NOT true for a row written before it: `flocks` still held
-- the raw MIN for every flock whose last budget write predated the deploy, and
-- three of the five readers of that column served it verbatim (the two flock
-- reads and the flock update in routes/flocks.js, and the ghost commit in
-- routes/billing.js). Only GET /api/budget/:flockId re-banded on read. So an
-- accepted member of a pre-fix flock could still read the exact number the fix
-- exists to withhold, from GET /api/flocks/:id.
--
-- THE TRANSFORM is bandCeiling() written as SQL, thresholds in the same order:
--
--     >= 50   ->  FLOOR(c / 10) * 10
--     >=  5   ->  FLOOR(c /  5) *  5
--     >=  1   ->  FLOOR(c)
--     >  0    ->  0.01
--     <= 0    ->  NULL
--
-- The last line is not a special case invented here: bandCeiling returns null
-- for anything not strictly positive, because the app reads this field for
-- truthiness and a $0 cap would render as "no ceiling yet" anyway. A
-- non-positive ceiling is not reachable through the submit route (amount must
-- be > 0) and none is expected to exist; the branch is here so the migration
-- and the function cannot disagree about a row that does.
--
-- IT NEVER ROUNDS UP. Every branch is a FLOOR to a multiple of its own step,
-- and the sub-dollar branch answers a cent for values that are all above a
-- cent. That direction is the load-bearing half: the ceiling's promise is that
-- any venue under it works for everybody, so publishing a number ABOVE the
-- lowest submitted budget would put a venue somebody cannot afford inside the
-- cap. A value already sitting on a band edge stays put ($50 -> $50).
--
-- IDEMPOTENT BY CONSTRUCTION, and it has to be, because routes/flocks.js and
-- routes/billing.js now re-band on read as well (the same value is banded
-- twice on every request that passes through both). Floor-to-a-multiple is a
-- fixed point: FLOOR(FLOOR(c/10)*10 / 10) * 10 = FLOOR(c/10)*10, and the same
-- for the $5 and $1 steps. A banded value also cannot fall into a LOWER band
-- than the one it came from, since each step divides its own band's floor.
-- $0.01 maps to $0.01. So the second run's UPDATE has nothing to match: the
-- `IS DISTINCT FROM` predicate is what turns "writes the same value again"
-- into "writes nothing at all", which keeps the run free of dead tuples and
-- lets __tests__/budgetCeilingBackfill.test.js prove the fixed point by xmin
-- rather than by value.
--
-- Numeric equality in Postgres ignores scale, so 45.00 IS NOT DISTINCT FROM 45
-- and a DECIMAL(8,2) column full of trailing zeros does not fool the predicate
-- into rewriting every row.
--
-- WHAT STAYS UNTOUCHED: rows whose ceiling is already its own band (the whole
-- table, for anything written since 1fdea72), and NULL ceilings — a flock with
-- no ceiling has nothing to leak, and NULL is how "not yet" is spelled here.
--
-- Default (transactional) mode, no directive line: `flocks` is a small table
-- and this is one statement, so there is no reason to give up the rollback.
--
-- This migration is the durable half of the fix. The other half is the read
-- sites, which now band on the way out, so the property holds for any row this
-- statement never saw — a restore from an old dump, or a row written by code
-- that predates all of this.

UPDATE flocks
   SET budget_ceiling = CASE
         WHEN budget_ceiling >= 50 THEN FLOOR(budget_ceiling / 10) * 10
         WHEN budget_ceiling >=  5 THEN FLOOR(budget_ceiling /  5) *  5
         WHEN budget_ceiling >=  1 THEN FLOOR(budget_ceiling)
         WHEN budget_ceiling >   0 THEN 0.01
         ELSE NULL
       END
       -- updated_at is deliberately not bumped. It is the list route's ORDER BY
       -- (routes/flocks.js GET /), so touching it here would reshuffle every
       -- user's home screen to announce a privacy repair nobody asked about.
 WHERE budget_ceiling IS NOT NULL
   AND budget_ceiling IS DISTINCT FROM CASE
         WHEN budget_ceiling >= 50 THEN FLOOR(budget_ceiling / 10) * 10
         WHEN budget_ceiling >=  5 THEN FLOOR(budget_ceiling /  5) *  5
         WHEN budget_ceiling >=  1 THEN FLOOR(budget_ceiling)
         WHEN budget_ceiling >   0 THEN 0.01
         ELSE NULL
       END;
