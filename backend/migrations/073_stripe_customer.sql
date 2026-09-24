-- 073: the Stripe customer behind a Flock account, for Flock Pro bought on the web.
--
-- WHAT IT ADDS. users.stripe_customer_id, written once by
-- services/proBilling.js the first time an account starts a web checkout, and
-- read in two places: the customer portal (where a web subscriber cancels or
-- changes their card) and account deletion, which deletes the Stripe customer
-- so its subscriptions stop billing.
--
-- WHAT IT DOES NOT ADD. Any subscription state. Who is Pro is RevenueCat's
-- answer, written to users.is_premium by routes/revenuecat.js alone; a second
-- copy of subscription status here would be a second answer that can disagree.
--
-- The unique index keeps one Stripe customer from ever being attached to two
-- accounts, which would let one person's portal show another's billing.
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stripe_customer_id
  ON users (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
