-- 096: quarterly bills and credits on the business expense list (080).
--
-- ASCII only, like 065 and 091-095: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY. 080's cadence CHECK admits monthly, yearly, usage and one_time, so a
-- bill charged every three months had to be typed as a yearly bill at four
-- times the amount, which put the wrong renewal dates on the hub. And every
-- row was a charge: a vendor refund or a promotional credit could only be
-- shown by lowering some other row's amount, which loses the bill's real
-- price. amount_cents stays >= 0 (080's amount check is untouched); a credit is
-- the same row shape with is_credit = true, and services/moneyHub.js subtracts
-- it from every total, run rate and category it lands in.
--
-- WHAT CHANGES.
--   * is_credit BOOLEAN NOT NULL DEFAULT false. A constant default is a
--     catalog change, not a rewrite, and every existing row is a charge, which
--     is the truth for all of them.
--   * the cadence CHECK admits 'quarterly' (a third of the amount a month in
--     the run rate). Same constraint name; it is dropped and added again only
--     where its definition does not already name quarterly, so a replay is a
--     no-op. The table is a few hundred rows at most, so the re-add validates
--     in place inside this file's one transaction.
--   * a credit cannot stand in for a code line: replaces_line takes a code
--     figure out of the totals, and a refund has no code figure to replace.
--   * business_expenses_bill_key also keys on is_credit, so a refund of a
--     one-time charge from the same vendor and product is its own row rather
--     than a duplicate of the charge. Same index NAME, which is what the add
--     and edit routes read off a 23505 and what 080's CREATE UNIQUE INDEX IF
--     NOT EXISTS finds on a replay, so 080 never tries to build the narrower
--     key over rows that only the wider one allows. Rebuilt only where the
--     definition does not already carry is_credit.
--
-- @requires column business_expenses.is_credit

ALTER TABLE business_expenses ADD COLUMN IF NOT EXISTS is_credit BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'business_expenses'::regclass
       AND conname = 'business_expenses_cadence_check'
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%''quarterly''%'
  ) THEN
    ALTER TABLE business_expenses DROP CONSTRAINT IF EXISTS business_expenses_cadence_check;
    ALTER TABLE business_expenses ADD CONSTRAINT business_expenses_cadence_check
      CHECK (cadence IN ('monthly', 'quarterly', 'yearly', 'usage', 'one_time'));
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE business_expenses ADD CONSTRAINT business_expenses_credit_line_check
    CHECK (NOT is_credit OR replaces_line IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'business_expenses'::regclass
       AND c.relname = 'business_expenses_bill_key'
       AND i.indisunique
       AND pg_get_indexdef(i.indexrelid) LIKE '%is_credit%'
  ) THEN
    DROP INDEX IF EXISTS business_expenses_bill_key;
    CREATE UNIQUE INDEX business_expenses_bill_key
      ON business_expenses (lower(vendor), lower(COALESCE(product, '')), cadence, is_credit);
  END IF;
END $$;
