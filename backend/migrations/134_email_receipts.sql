-- 134: receipts the owner's Gmail forwards, and what each one did to the
-- money hub (services/receiptInbox.js).
--
-- ASCII only, like 094 and 100-102: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY. The hub learned about a bill only when somebody typed it in, so a new
-- Railway or Google Cloud figure waited for a person and a renewal that went
-- up was invisible until then. A Gmail filter now forwards the receipts of the
-- companies Flock pays to a receiving address at Resend, and the webhook reads
-- each one and records the bill. This table is the record of what came in and
-- what it changed, so the dashboard can say so and a receipt is never read
-- twice.
--
-- WHAT A ROW IS. One bill on one received email. Most receipts are one bill;
-- an App Store receipt can carry several, numbered by line_no. A row holds
-- what the hub needs and nothing else: the sender's address and the subject,
-- the vendor, product, amount, dates and the receipt's own number, and never
-- the body. Mail that is not a receipt, or not forwarded by the owner, stores
-- nothing at all.
--
-- status says what the bill did:
--   applied    updated a reconciled line or a bill on the expense list
--   added      added a one-time bill from a vendor already on the list
--   already    the hub already held this charge
--   older      the hub holds a newer figure, so nothing moved
--   new        a bill nothing on the list matches, waiting for the owner and
--              counted in no total until he adds it
--   confirmed  a new bill the owner added to the list
--   dismissed  a new bill the owner said is not the company's
--   to_check   a receipt that could not be read, or could be more than one
--              bill: listed for the owner with its sender and subject
--   checked    a to_check row the owner has looked at
--
-- expense_id points at the bill it changed or added. ON DELETE SET NULL: a
-- bill deleted from the list keeps the record of the receipt and forgets the
-- link. No column points at a user: there is one admin, and who answered a
-- receipt is not worth keeping a person's id for.
--
-- Pure CREATE ... IF NOT EXISTS and guarded constraints, no backfill, so the
-- replay in __tests__/migrationBootSafety.test.js can run it over a populated
-- database as often as it likes.
-- @requires table email_receipts
-- @requires column email_receipts.message_id

CREATE TABLE IF NOT EXISTS email_receipts (
  id               SERIAL PRIMARY KEY,
  message_id       VARCHAR(300) NOT NULL,
  line_no          SMALLINT     NOT NULL DEFAULT 0,
  resend_email_id  VARCHAR(80)  NOT NULL,
  sender           VARCHAR(200) NOT NULL,
  subject          VARCHAR(200),
  vendor           VARCHAR(80),
  product          VARCHAR(120),
  amount_cents     INTEGER,
  currency         VARCHAR(3),
  paid_on          DATE,
  period_start     DATE,
  period_end       DATE,
  cadence          VARCHAR(10),
  reference        VARCHAR(80),
  status           VARCHAR(12)  NOT NULL,
  reconciled_line  VARCHAR(40),
  expense_id       INTEGER REFERENCES business_expenses(id) ON DELETE SET NULL,
  previous_cents   INTEGER,
  previous_on      DATE,
  reason           VARCHAR(300),
  received_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ
);

DO $$ BEGIN
  ALTER TABLE email_receipts ADD CONSTRAINT email_receipts_status_check
    CHECK (status IN ('applied', 'added', 'already', 'older', 'new', 'confirmed', 'dismissed', 'to_check', 'checked'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE email_receipts ADD CONSTRAINT email_receipts_cadence_check
    CHECK (cadence IS NULL OR cadence IN ('monthly', 'quarterly', 'yearly', 'usage', 'one_time'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The same ten million dollar ceiling the expense list has (080).
DO $$ BEGIN
  ALTER TABLE email_receipts ADD CONSTRAINT email_receipts_amount_check
    CHECK (amount_cents IS NULL OR (amount_cents >= 0 AND amount_cents <= 1000000000));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE email_receipts ADD CONSTRAINT email_receipts_currency_check
    CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ONE EMAIL IS READ ONCE. A receipt forwarded twice keeps its Message-ID, and
-- a webhook Resend delivers again keeps its email id; both are looked up
-- before anything is written, and this key settles two deliveries at once.
CREATE UNIQUE INDEX IF NOT EXISTS email_receipts_message_line_key ON email_receipts (message_id, line_no);
CREATE INDEX IF NOT EXISTS idx_email_receipts_resend_id ON email_receipts (resend_email_id);
CREATE INDEX IF NOT EXISTS idx_email_receipts_received ON email_receipts (received_at DESC);
