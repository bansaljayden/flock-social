-- 124: a refused Roost purchase is finished only once the refunds of its
-- payment that succeeded add up to what it paid, it can open again when one
-- of them fails later, and every refund it asks for is reserved before Stripe
-- is asked.
--
-- ASCII only, like 094 and 100-102: the embedded server the boot-safety suite
-- runs is WIN1252.
--
-- WHY. 123 set roost_refused_purchases.finished_at as soon as Stripe accepted
-- the refund request, whatever the Refund it answered with said. A Refund can
-- be pending, requires_action, failed or canceled as well as succeeded, a
-- pending one can stay pending for days and then fail, and one that succeeded
-- can still fail when the bank sends the money back. Stripe also allows
-- several partial refunds of one payment, some made by hand in the dashboard.
-- Once finished_at was set nothing asked for the money again: a replayed
-- checkout skipped the refusal, refund.updated refunded nothing, and the
-- idempotency key would have handed back the same failed Refund for about a
-- day. The plan was cancelled and the charge kept (billing review 2026-10-06).
-- finished_at now waits until the refunds of the payment that succeeded add
-- up to what it paid, and a refund event that finds them short opens the
-- refusal again (services/venueBilling.js settleRefusalRefund).
--
-- stripe_payment_intent_id is the payment the refusal is waiting on: an event
-- about any refund of that payment, made by us or by hand, finds the refusal
-- by it, finished or not. stripe_refund_id is the refund the refusal last
-- made.
--
-- THE ATTEMPT IS WRITTEN DOWN BEFORE STRIPE IS ASKED. refund_attempt is the
-- number of the last refund asked for, and refund_attempt_amount and
-- refund_attempt_key the amount and idempotency key reserved for it, written
-- in one committed statement before the request goes out.
-- refund_attempt_outcome is NULL until what Stripe answered is recorded
-- ('refund' when it made one, 'nothing' when it did not). When that answer was
-- never recorded (a crash, or a write that failed after Stripe answered), the
-- next handling finds the refund by the attempt number in its metadata, or
-- asks again with exactly the reserved key and amount, and only then numbers
-- a new attempt. A key is never sent with any amount but its own: Stripe
-- refuses a key reused with other parameters. Three attempts at most; the
-- refusal stays open after that for a person to finish.
--
-- NO ACCOUNT IN IT, as in 123: Stripe ids, an amount, a count and a word.
--
-- Nothing to backfill: no Roost subscription has been sold through Stripe yet.
-- @requires column roost_refused_purchases.stripe_payment_intent_id
-- @requires column roost_refused_purchases.stripe_refund_id
-- @requires column roost_refused_purchases.refund_attempt
-- @requires column roost_refused_purchases.refund_attempt_amount
-- @requires column roost_refused_purchases.refund_attempt_key
-- @requires column roost_refused_purchases.refund_attempt_outcome
ALTER TABLE roost_refused_purchases ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT;
ALTER TABLE roost_refused_purchases ADD COLUMN IF NOT EXISTS stripe_refund_id TEXT;
ALTER TABLE roost_refused_purchases ADD COLUMN IF NOT EXISTS refund_attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE roost_refused_purchases ADD COLUMN IF NOT EXISTS refund_attempt_amount INTEGER;
ALTER TABLE roost_refused_purchases ADD COLUMN IF NOT EXISTS refund_attempt_key TEXT;
ALTER TABLE roost_refused_purchases ADD COLUMN IF NOT EXISTS refund_attempt_outcome VARCHAR(16);
