-- 074: the Stripe customer behind a venue's Roost subscription.
--
-- WHAT IT ADDS. venue_profiles.stripe_customer_id, written once by
-- services/venueBilling.js the first time a verified venue starts a Roost
-- checkout, and read by the billing portal and by account deletion, which
-- deletes the customer so a Roost subscription cannot outlive the account.
--
-- WHY NOT users.stripe_customer_id (migration 073). That customer belongs to
-- Flock Pro, and proBilling.js treats ANY live subscription on it as "already
-- has Pro on the web". Putting Roost on the same customer would tell a venue
-- owner who pays for Roost that they already own a consumer plan they never
-- bought. One customer per product keeps each side's "already subscribed"
-- check about its own product.
--
-- WHAT IT DOES NOT ADD. Subscription state. That lives in venue_subscriptions
-- (migration 040), which already carries every Stripe column the webhook
-- writes, and the entitlement resolver reads nothing else.
ALTER TABLE venue_profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_venue_profiles_stripe_customer_id
  ON venue_profiles (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
