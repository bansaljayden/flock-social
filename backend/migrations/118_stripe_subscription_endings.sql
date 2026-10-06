-- 118: what ended a Stripe subscription early, so it stays ended.
--
-- ASCII only, like 094 and 100-102: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY. A chargeback names a CHARGE, and services/proBilling.js
-- cancelDisputedSubscriptions used to answer it by listing the charge's
-- customer and cancelling every live subscription that customer held at that
-- moment. A customer outlives a subscription: a venue whose plan was ended by
-- a dispute could buy again on the same customer, and a replay of the old
-- dispute event (Stripe resends, or somebody resends from the dashboard) then
-- cancelled the NEW subscription for a charge it never made (billing review
-- 2026-10-06). The disputed charge now resolves through its invoice to the one
-- subscription it paid for, and that decision is recorded here, once per
-- dispute, so a replay acts on the recorded subscription and nothing else.
--
-- A full refund of the payment behind a Roost subscription's current period
-- lands here too (services/venueBilling.js). Roost's grant is written from
-- the subscription's state at Stripe, and a refunded subscription can read
-- 'active' there until it is cancelled, so the writer reads this table on
-- every sync and keeps a subscription with a row here revoked whatever a
-- later event says.
--
-- WHAT A ROW MEANS. cause is what ended it ('dispute' or 'refund'), source_id
-- is what Stripe named (the dispute's id, or the refunded charge's id), and
-- stripe_subscription_id is the subscription that money paid for, found
-- through the invoice. One row per cause, source and subscription: a charge
-- can pay more than one invoice.
--
-- NO ACCOUNT IN IT. Only Stripe's own ids, which name no person in Flock, so
-- nothing here has to follow an account deletion, and a row outlives the
-- account the way Stripe's own dispute record does.
-- @requires table stripe_subscription_endings
CREATE TABLE IF NOT EXISTS stripe_subscription_endings (
  id BIGSERIAL PRIMARY KEY,
  cause VARCHAR(16) NOT NULL,
  source_id TEXT NOT NULL,
  stripe_subscription_id TEXT NOT NULL,
  stripe_invoice_id TEXT,
  stripe_charge_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE stripe_subscription_endings ADD CONSTRAINT stripe_subscription_endings_cause
    CHECK (cause IN ('dispute', 'refund'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_stripe_subscription_endings_source
  ON stripe_subscription_endings (cause, source_id, stripe_subscription_id);

-- The question the Roost writer asks on every sync: has this subscription
-- been ended by us.
CREATE INDEX IF NOT EXISTS idx_stripe_subscription_endings_subscription
  ON stripe_subscription_endings (stripe_subscription_id);
