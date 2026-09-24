-- 078: the acknowledgment email a web buyer of Flock Pro gets, once per checkout.
--
-- WHY. California's automatic renewal law (Bus. & Prof. Code 17602) asks that a
-- buyer of an auto-renewing subscription get an acknowledgment they can keep:
-- the renewal terms, the cancellation policy and how to cancel. Stripe's
-- receipt says what was paid, not how to stop paying, so Flock sends its own
-- (services/proAcknowledgment.js, templates/proPurchaseEmail.js).
--
-- WHAT A ROW MEANS. The email provider accepted the acknowledgment for this
-- Checkout Session at emailed_at. The signed Stripe webhook sends it, and the
-- buyer's return to the app (POST /api/pro/confirm) is a second chance if that
-- send failed; both check for a row first, so a buyer is not mailed twice for
-- one purchase. A send that failed writes nothing and the next chance tries
-- again.
--
-- DELETION. ON DELETE CASCADE: the row is one account's record and leaves with
-- it.

CREATE TABLE IF NOT EXISTS pro_purchase_acknowledgments (
  session_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emailed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE pro_purchase_acknowledgments ADD CONSTRAINT pro_purchase_acknowledgments_session_shape
    CHECK (session_id ~ '^cs_[A-Za-z0-9_]+$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_pro_purchase_acknowledgments_user ON pro_purchase_acknowledgments (user_id);
