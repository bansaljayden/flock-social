'use strict';
// ---------------------------------------------------------------------------
// POST /api/stripe-webhook: Stripe telling us a web checkout finished, or a
// web subscription changed.
//
// WHY IT EXISTS. RevenueCat is the one record of who has Flock Pro, and its
// Stripe integration finds web purchases on its own. The confirm route in
// routes/pro.js also hands the subscription over the moment the buyer lands
// back in the app. But that second path runs in the BUYER'S browser: somebody
// who pays and closes the tab never reaches it, and if RevenueCat's own
// tracking lagged or was misconfigured they would have paid for nothing. This
// is the same handover done from the server, on Stripe's signed word, so
// delivery never depends on a tab staying open.
//
// WHAT IT TRUSTS. Only a valid Stripe signature over the exact bytes received
// (req.rawBody, kept by the scoped parser in server.js). No signature, a bad
// one, or no STRIPE_WEBHOOK_SECRET is a refusal, and nothing is read from the
// body before the check. The account is taken from app_user_id in metadata
// this server wrote when it created the session; a customer cannot set it.
//
// WHAT IT WRITES. Nothing directly. It posts the receipt to RevenueCat and then
// re-reads the subscriber through syncPremiumFromRevenueCat, the one writer of
// users.is_premium. A failure answers 500 so Stripe retries; every step is
// idempotent, so a retry cannot grant anything twice.
// ---------------------------------------------------------------------------
const express = require('express');
const pool = require('../config/database');
const billing = require('../services/proBilling');
const venueBilling = require('../services/venueBilling');
const { syncPremiumFromRevenueCat } = require('./revenuecat');

const router = express.Router();

const MAX_INT4 = 2147483647;
function accountFrom(metadata) {
  const raw = metadata && typeof metadata.app_user_id === 'string' ? metadata.app_user_id.trim() : '';
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_INT4 ? n : null;
}

const HANDLED = new Set([
  'checkout.session.completed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

// Roost also needs `created`: a subscription can exist (a trial that starts
// with no charge) before anything else about it changes.
const VENUE_HANDLED = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

router.post('/', async (req, res) => {
  if (!billing.stripeWebhookConfigured() || !billing.stripeConfigured()) {
    return res.status(503).json({ error: 'Webhook not configured' });
  }
  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string' || !req.rawBody) {
    return res.status(400).json({ error: 'Missing signature' });
  }
  let event;
  try {
    event = billing.constructWebhookEvent(req.rawBody, signature);
  } catch (err) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // ROOST, NOT PRO. A session or subscription created by services/venueBilling.js
  // carries kind='venue' and no app_user_id, and goes to that file's writer
  // instead of RevenueCat. Everything below this block is the Pro path,
  // unchanged.
  const eventObject = event.data && event.data.object ? event.data.object : null;

  // A CHARGEBACK names a charge, not an account, so it is handled before the
  // metadata lookups below. services/proBilling.js cancelDisputedSubscriptions
  // says why the subscription ends now; the deleted event that follows
  // revokes it on whichever path (Pro or Roost) that subscription belongs to.
  if (event.type === 'charge.dispute.created') {
    try {
      const result = await billing.cancelDisputedSubscriptions(eventObject);
      return res.json({ received: true, ...(result && result.ignored ? { ignored: result.ignored } : {}) });
    } catch (err) {
      console.error('[stripe-webhook] charge.dispute.created failed:', err?.message || err);
      return res.status(500).json({ error: 'Webhook failed' });
    }
  }

  if (venueBilling.isVenueObject(eventObject)) {
    if (!VENUE_HANDLED.has(event.type)) return res.json({ received: true, ignored: event.type });
    try {
      const result = await venueBilling.handleVenueEvent(event);
      return res.json({ received: true, ...(result && result.ignored ? { ignored: result.ignored } : {}) });
    } catch (err) {
      console.error(`[stripe-webhook] venue ${event.type} failed:`, err?.message || err);
      return res.status(500).json({ error: 'Webhook failed' });
    }
  }

  if (!HANDLED.has(event.type)) return res.json({ received: true, ignored: event.type });

  try {
    const obj = event.data && event.data.object ? event.data.object : {};
    const userId = accountFrom(obj.metadata);
    // A session or subscription that did not come from our checkout (made by
    // hand in the dashboard, or another product) carries no app_user_id and
    // is not ours to act on.
    if (!userId) return res.json({ received: true, ignored: 'no_account' });
    // Deleting an account deletes its Stripe customer, which fires this with
    // the departed id. Asking RevenueCat about it would create a subscriber
    // record there for somebody who is gone, so a missing account stops here.
    const exists = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (!exists.rows || exists.rows.length === 0) return res.json({ received: true, ignored: 'no_such_account' });

    let refreshRefused = false;
    if (event.type === 'checkout.session.completed') {
      if (obj.mode !== 'subscription') return res.json({ received: true, ignored: 'not_subscription' });
      const subscriptionId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription && obj.subscription.id;
      if (!subscriptionId) return res.json({ received: true, ignored: 'no_subscription' });
      const posted = await billing.postStripeReceipt(userId, subscriptionId);
      if (!posted) throw new Error('RevenueCat did not accept the receipt');
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      // RevenueCat checks Stripe on its own schedule, so right after a renewal,
      // a cancellation or a refund its answer can still describe the last
      // period. Re-sending the subscription makes it read Stripe now (its docs:
      // re-post the same subscription and it is updated immediately), so the
      // re-read below is of today's state rather than of whenever it last looked.
      const subscriptionId = typeof obj.id === 'string' && obj.id.startsWith('sub_') ? obj.id : null;
      // Refused or unreachable, the re-read below still runs and writes what
      // RevenueCat has, and only then does this answer 500 so Stripe sends the
      // event again. Stopping before the re-read meant a refusal that never
      // cleared left is_premium where it was for good.
      if (subscriptionId) {
        const posted = await billing.postStripeReceipt(userId, subscriptionId).catch(() => false);
        refreshRefused = !posted;
      }
    }
    await syncPremiumFromRevenueCat(userId);
    if (refreshRefused) throw new Error('RevenueCat did not accept the refreshed receipt');
    res.json({ received: true });
  } catch (err) {
    console.error(`[stripe-webhook] ${event.type} failed:`, err?.message || err);
    res.status(500).json({ error: 'Webhook failed' });
  }
});

module.exports = router;
module.exports.__test = { accountFrom };
