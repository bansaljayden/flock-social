'use strict';
// ---------------------------------------------------------------------------
// /api/venue-billing: Roost bought on the web by a verified venue.
//
//   GET  /status    what this venue can buy right now, what it holds, and
//                   whether it has a subscription to manage. Always answers,
//                   even with checkout switched off, so the dashboard can say
//                   so instead of showing a button that fails.
//   POST /checkout  { plan: 'monthly' | 'yearly' } -> { url } of a Stripe
//                   Checkout Session tied to this venue.
//   POST /portal    -> { url } of the Stripe customer portal, where a venue
//                   cancels or changes its card.
//   POST /confirm   { sessionId } after the redirect back: checks the session
//                   is this venue's and writes the subscription at once.
//
// The one writer of a Stripe-sourced venue grant is
// services/venueBilling.syncVenueSubscription; see that file for the rules.
// These routes are web-only by design (VENUE-BILLING.md finding 4): the iOS
// dashboard never shows a way to reach them.
// ---------------------------------------------------------------------------
const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { getVenueEntitlement, venueBillingEnabled } = require('../services/venueEntitlements');
const billing = require('../services/proBilling');
const venueBilling = require('../services/venueBilling');

const router = express.Router();

const PLANS = ['monthly', 'yearly'];

async function describePlans() {
  const prices = venueBilling.roostPrices();
  const plans = [];
  for (const id of PLANS) {
    if (!prices[id]) continue;
    const p = await billing.describePrice(prices[id]);
    plans.push({ id, unitAmount: p.unitAmount, currency: p.currency, interval: p.interval, label: billing.formatAmount(p) });
  }
  return plans;
}

router.use(authenticate);

function sendError(res, err, fallback) {
  const status = err && Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) console.error(`[venue-billing] ${fallback}:`, err?.message || err);
  res.status(status).json({
    error: status >= 500 ? fallback : err.message,
    // Only our own codes reach the client, for the reason routes/pro.js gives.
    ...(status < 500 && err && err.code ? { code: err.code } : {}),
  });
}

router.get('/status', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const r = await pool.query(
      'SELECT verified, stripe_customer_id FROM venue_profiles WHERE user_id = $1',
      [req.user.id]
    );
    const profile = r.rows[0];
    if (!profile) return res.status(404).json({ error: 'There is no venue on this account.', code: 'NO_VENUE' });
    const ent = await getVenueEntitlement(req.user.id);
    const state = venueBilling.checkoutState();
    let canManage = false;
    if (profile.stripe_customer_id && billing.stripeConfigured()) {
      canManage = await billing.hasEverSubscribed(profile.stripe_customer_id).catch(() => false);
    }
    // A price lookup that fails hides the offer, not the page, so a
    // subscriber can still reach Manage while Stripe is slow.
    let plans = [];
    let sellable = state.ready;
    if (sellable) {
      try {
        plans = await describePlans();
      } catch (err) {
        console.warn('[venue-billing] status could not describe prices:', err?.message || err);
        sellable = false;
      }
    }
    res.json({
      billingEnabled: venueBillingEnabled(),
      checkoutAvailable: sellable,
      plans,
      // One trial per venue: an owner who has ever subscribed (which is also
      // exactly when there is a portal to manage) is offered none, matching
      // what createVenueCheckout will actually do.
      trialDays: sellable && !canManage ? venueBilling.TRIAL_DAYS : 0,
      taxAdded: sellable ? billing.taxEnabled() : false,
      verified: profile.verified === true,
      tier: ent.tier,
      source: ent.source,
      status: ent.status,
      expiresAt: ent.expiresAt,
      canManage,
    });
  } catch (err) {
    sendError(res, err, 'Could not load venue billing just now.');
  }
});

router.post('/checkout', [
  body('plan').isString().isIn(PLANS).withMessage('Choose monthly or yearly.'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    if (!venueBilling.checkoutState().ready) {
      return res.status(503).json({ error: 'Roost is not on sale on the web yet.', code: 'CHECKOUT_OFF' });
    }
    const u = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [req.user.id]);
    if (!u.rows[0]) return res.status(404).json({ error: 'Account not found.' });
    const url = await venueBilling.createVenueCheckout(u.rows[0], req.body.plan);
    res.json({ url });
  } catch (err) {
    sendError(res, err, 'Could not start checkout. Try again.');
  }
});

router.post('/portal', async (req, res) => {
  try {
    if (!billing.stripeConfigured()) {
      return res.status(503).json({ error: 'Web billing is not available right now.', code: 'BILLING_OFF' });
    }
    const url = await venueBilling.createVenuePortal(req.user.id);
    res.json({ url });
  } catch (err) {
    sendError(res, err, 'Could not open billing. Try again.');
  }
});

router.post('/confirm', [
  body('sessionId').isString().isLength({ min: 8, max: 200 }).matches(/^cs_[A-Za-z0-9_]+$/)
    .withMessage('That checkout reference is not valid.'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    if (!billing.stripeConfigured()) {
      return res.status(503).json({ error: 'Web billing is not available right now.', code: 'BILLING_OFF' });
    }
    const result = await venueBilling.confirmVenueCheckout(req.user.id, req.body.sessionId);
    res.json(result);
  } catch (err) {
    sendError(res, err, 'Could not confirm your purchase yet. It can take a minute.');
  }
});

module.exports = router;
module.exports.describePlans = describePlans;
