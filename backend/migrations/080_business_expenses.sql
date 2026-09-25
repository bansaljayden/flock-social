-- 080: the business expense list, kept in the database instead of in code.
--
-- WHY. services/costModel.js holds the bills this product runs on as code
-- constants, dated and sourced, and that file is published. A bill that no
-- user causes (the tools the app is built with, the company's legal filings)
-- is the company's own business, so it does not belong in a public constant.
-- Those bills now arrive through the admin dashboard, one row each, and the
-- owner's money hub (GET /api/admin/money) adds them to the code lines, the
-- reconciled invoice in cost_reconciled (059) and the live meters.
--
-- WHAT A ROW IS. One recurring or one-off bill: who is paid (vendor), for what
-- (product), a free-text grouping for the hub's by-category table (category),
-- and which of four kinds it is:
--   infrastructure  running the app: a bill a user causes
--   tooling         building it: a bill no user causes
--   legal           the company: filings, registered agent, insurance
--   other           everything else
-- The amount is integer cents in one ISO currency. The hub adds only USD rows
-- into its totals and names the rest, because it holds no exchange rate.
-- cadence is how often it is charged: monthly, yearly, usage (a metered bill,
-- read as roughly this much a month) or one_time.
--
-- replaces_line names the costModel.js line (or cost_reconciled line) this
-- row stands in for, so one bill is never counted twice: a row with it set
-- takes that code figure out of every total. It is NULL for a bill the code
-- has never heard of, which is most of them.
--
-- verified means somebody saw this amount on an invoice or a statement, the
-- same meaning costModel.js gives the word. An unverified row still counts.
--
-- active = false keeps the row (and its history) and takes it out of every
-- total. Rows are written only by the admin routes behind requireAdmin.
--
-- updated_by points at the admin who last wrote the row. ON DELETE SET NULL:
-- deleting that account keeps the company's expense record and forgets who
-- typed it, which is the account-deletion rule everywhere else.
--
-- No vendor and no amount appear in this file on purpose. The list arrives
-- through POST /api/admin/expenses/import, pasted once from the owner's bills.
--
-- Pure CREATE ... IF NOT EXISTS and guarded constraints, no backfill, so the
-- replay in __tests__/migrationBootSafety.test.js can run it over a populated
-- database as often as it likes.
-- @requires table business_expenses
-- @requires column business_expenses.replaces_line

CREATE TABLE IF NOT EXISTS business_expenses (
  id               SERIAL PRIMARY KEY,
  vendor           VARCHAR(80)  NOT NULL,
  product          VARCHAR(120),
  category         VARCHAR(60),
  kind             VARCHAR(20)  NOT NULL DEFAULT 'other',
  amount_cents     INTEGER      NOT NULL,
  currency         VARCHAR(3)   NOT NULL DEFAULT 'USD',
  cadence          VARCHAR(10)  NOT NULL,
  last_charged_on  DATE,
  renews_on        DATE,
  active           BOOLEAN      NOT NULL DEFAULT true,
  verified         BOOLEAN      NOT NULL DEFAULT false,
  note             TEXT,
  replaces_line    VARCHAR(40),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_by       INTEGER REFERENCES users(id) ON DELETE SET NULL
);

DO $$ BEGIN
  ALTER TABLE business_expenses ADD CONSTRAINT business_expenses_kind_check
    CHECK (kind IN ('infrastructure', 'tooling', 'legal', 'other'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE business_expenses ADD CONSTRAINT business_expenses_cadence_check
    CHECK (cadence IN ('monthly', 'yearly', 'usage', 'one_time'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Ten million dollars in cents is far past any bill this company will see and
-- far inside INTEGER, so a mistyped extra digit or two is refused rather than
-- stored.
DO $$ BEGIN
  ALTER TABLE business_expenses ADD CONSTRAINT business_expenses_amount_check
    CHECK (amount_cents >= 0 AND amount_cents <= 1000000000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE business_expenses ADD CONSTRAINT business_expenses_currency_check
    CHECK (currency ~ '^[A-Z]{3}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE business_expenses ADD CONSTRAINT business_expenses_vendor_check
    CHECK (length(btrim(vendor)) > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The hub reads the active rows on every open.
CREATE INDEX IF NOT EXISTS idx_business_expenses_active ON business_expenses (active, kind);

-- ONE ROW PER BILL. The same vendor, product and cadence, ignoring case, is the
-- same bill: the import matches on exactly this to update a bill rather than
-- add it twice. Unique, because a lock can only hold a row that already
-- exists, so two imports of the same new bill would each find nothing and
-- each insert. With the key, the second insert waits for the first and then
-- finds the conflict (the import's ON CONFLICT names these three
-- expressions), and the add and edit forms answer a duplicate with 409.
CREATE UNIQUE INDEX IF NOT EXISTS business_expenses_bill_key
  ON business_expenses (lower(vendor), lower(COALESCE(product, '')), cadence);
