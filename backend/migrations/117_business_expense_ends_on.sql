-- 117: a bill on the expense list (080) that ends rather than renews.
--
-- ASCII only, like 094 and 100-102: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY. A subscription with its renewal turned off (the App Store says it ends
-- on a date) had two ways onto the hub and both were wrong. Left as charged,
-- it showed as a renewal on a date nobody would charge it, counted in the
-- next 30 days of renewals, and stayed in the monthly burn forever. Marked
-- stopped early, it left the month it was still running in. ends_on is the
-- day it stops: nothing is charged on or after it, it counts until then, and
-- from that day it counts nowhere (services/moneyHub.js, THE END OF A BILL).
--
-- WHAT CHANGES.
--   * ends_on DATE, nullable, no default: a catalog change, no rewrite and no
--     scan. NULL is a bill that renews until it is stopped, which is every
--     row on the list today.
--   * a one-time charge cannot carry one: it was paid once and has nothing
--     to end. The add, edit and import routes answer the pair with a 400
--     before the table refuses it.
--
-- ADDITIVE AND IDEMPOTENT. ADD COLUMN IF NOT EXISTS, and the CHECK under a
-- fixed name, so a replay meets duplicate_object and moves nothing. The table
-- is a few hundred rows at most, so the CHECK validates in place inside this
-- file's one transaction.
-- @requires column business_expenses.ends_on

ALTER TABLE business_expenses ADD COLUMN IF NOT EXISTS ends_on DATE;

DO $$ BEGIN
  ALTER TABLE business_expenses ADD CONSTRAINT business_expenses_ends_on_check
    CHECK (ends_on IS NULL OR cadence <> 'one_time');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
