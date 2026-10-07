-- 123: a refused Roost purchase stays owed its refund until it is paid back,
-- and a refusal and a first delivery can never both happen to one
-- subscription.
--
-- ASCII only, like 094 and 100-102: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY, THE REFUND. A checkout that completes against a claim no longer
-- verified for its listing, or after its account was deleted, is cancelled at
-- once and its payment refunded (services/venueBilling.js
-- fulfillVenueCheckout). The decision lived only in memory: when the cancel
-- went through and the refund then failed, the webhook answered 500, and
-- Stripe's retry found the subscription already cancelled, read that as a plan
-- nobody needed to refund, and acknowledged the event. The payment for a
-- purchase that was never delivered was kept for good (billing review
-- 2026-10-06). roost_refused_purchases records the refusal before anything is
-- cancelled, and every later handling of the same checkout finishes it: the
-- cancel, and a refund under the same Stripe idempotency key, whatever the
-- subscription's status, the claim or the account looks like by then.
-- finished_at is set once both are done.
--
-- NO ACCOUNT IN IT. Only Stripe's own ids and why the purchase was refused,
-- so a row outlives the account it was about the way 118's endings do: a
-- refusal whose refund failed must still be finished after the owner deletes
-- the account, and a purchase refused because the account was already gone
-- has no account to hang a row on.
--
-- WHY, refused_at. A subscription first served is never refused or refunded
-- afterwards (served_at, migration 121), and an admin's verification can start
-- serving a subscription with no Stripe event at all. The refusal is decided
-- by setting venue_stripe_subscriptions.refused_at only while served_at is
-- NULL, and delivery is recorded only while refused_at is NULL, both by
-- updating that one row, so whichever lands first decides and the other finds
-- the row already claimed.
--
-- Nothing to backfill: no Roost subscription has been sold through Stripe yet.
-- @requires table roost_refused_purchases
-- @requires column venue_stripe_subscriptions.refused_at
CREATE TABLE IF NOT EXISTS roost_refused_purchases (
  stripe_subscription_id TEXT PRIMARY KEY,
  stripe_checkout_session_id TEXT,
  stripe_invoice_id TEXT,
  reason VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

DO $$ BEGIN
  ALTER TABLE roost_refused_purchases ADD CONSTRAINT roost_refused_purchases_reason
    CHECK (reason IN ('claim_not_verified', 'account_deleted'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The refusals still owed something, for an operator's eye.
CREATE INDEX IF NOT EXISTS idx_roost_refused_purchases_open
  ON roost_refused_purchases (created_at)
  WHERE finished_at IS NULL;

ALTER TABLE venue_stripe_subscriptions ADD COLUMN IF NOT EXISTS refused_at TIMESTAMPTZ;
