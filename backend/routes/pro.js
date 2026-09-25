'use strict';
// ---------------------------------------------------------------------------
// /api/pro: Flock Pro bought on the web.
//
//   GET  /status    what the web can sell this account right now, and whether
//                   it has a web subscription to manage. Always answers, even
//                   with checkout switched off, so the page can say so.
//   POST /checkout  { plan: 'monthly' | 'yearly', from?, place?, code? }
//                   -> { url } of a Stripe Checkout Session tied to this
//                   account. `from` (a fixed list) and `place` send the buyer
//                   back to what they were blocked from; `code` applies an
//                   active promotion code from a shared link.
//   POST /cancel    ends this account's web subscription at the end of the paid
//                   period. POST /resume takes that back before it arrives.
//                   Flock's own buttons, because Stripe's portal is for people
//                   18 and over and much of the audience is younger.
//   POST /portal    -> { url } of the Stripe customer portal, for the card and
//                   the invoices.
//   POST /confirm   { sessionId } after the redirect back: checks the session
//                   is this account's, tells RevenueCat, re-reads Pro.
//
// Nothing here writes users.is_premium. See services/proBilling.js for why the
// one record of who is Pro lives in RevenueCat, and routes/revenuecat.js for
// the one writer.
// ---------------------------------------------------------------------------
const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { getPremiumState } = require('../services/entitlements');
const billing = require('../services/proBilling');
const { syncPremiumFromRevenueCat } = require('./revenuecat');
const { acknowledgePurchase } = require('../services/proAcknowledgment');
const { PLACE_ID_RE } = require('../utils/places');

const router = express.Router();

const PLANS = ['monthly', 'yearly'];
// Where a checkout was started from (services/proBilling.js successUrl).
const RETURN_FROM = ['forecast', 'birdie', 'settings', 'pro_page'];

async function describePlans() {
  const prices = billing.planPrices();
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
  if (status >= 500) console.error(`[pro] ${fallback}:`, err?.message || err);
  res.status(status).json({
    error: status >= 500 ? fallback : err.message,
    // Only our own codes reach the client. A 500 carries whatever threw it,
    // which can be a Stripe or a Node error code, and neither is the
    // caller's business.
    ...(status < 500 && err && err.code ? { code: err.code } : {}),
  });
}

router.get('/status', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const state = await getPremiumState(req.user.id);
    if (!state.known) {
      res.set('Retry-After', '5');
      return res.status(503).json({ error: 'Could not check your plan just now. Try again.', retryable: true });
    }
    const checkout = billing.webCheckout(req.user.id);
    const customerId = await billing.customerIdFor(req.user.id);
    let canManageWeb = false;
    if (customerId && billing.stripeConfigured()) {
      canManageWeb = await billing.hasEverSubscribed(customerId).catch(() => false);
    }
    // Whether the live web subscription is already set to end, and when, so
    // the page offers Keep Pro instead of Cancel. A failed read shows neither
    // state as certain: the fields stay null and the page falls back to the
    // plain row.
    let subscription = null;
    if (canManageWeb) {
      subscription = await billing.webSubscriptionState(req.user.id).catch((err) => {
        console.warn('[pro] status could not read the web subscription:', err?.message || err);
        return null;
      });
    }
    // A price lookup that fails hides the offer rather than the page: this
    // route is also how a subscriber finds Manage and how the checkout return
    // learns the purchase landed, and neither should fail because Stripe could
    // not describe a price for a minute.
    let plans = [];
    let sellable = checkout.ready;
    if (sellable) {
      try {
        plans = await describePlans();
      } catch (err) {
        console.warn('[pro] status could not describe prices:', err?.message || err);
        sellable = false;
      }
    }
    res.json({
      isPremium: state.premium,
      checkoutAvailable: sellable,
      plans,
      // A trial is for somebody who has never subscribed, which is also the
      // rule checkout enforces; a returning customer is not offered one.
      trialDays: sellable && !canManageWeb ? billing.trialDays() : 0,
      taxAdded: sellable ? billing.taxEnabled() : false,
      // True once this account has ever been a Stripe customer, which is when
      // the portal has something to show.
      canManageWeb,
      // A live web subscription: true when it is set to end at periodEnd.
      hasWebSubscription: !!subscription,
      cancelAtPeriodEnd: subscription ? subscription.cancelAtPeriodEnd : false,
      periodEnd: subscription ? subscription.periodEnd : null,
    });
  } catch (err) {
    sendError(res, err, 'Could not load Flock Pro just now.');
  }
});

router.post('/checkout', [
  body('plan').isString().isIn(PLANS).withMessage('Choose monthly or yearly.'),
  body('from').optional({ values: 'null' }).isString().isIn(RETURN_FROM).withMessage('That return place is not valid.'),
  body('place').optional({ values: 'null' }).isString().matches(PLACE_ID_RE).withMessage('That venue is not valid.'),
  body('code').optional({ values: 'null' }).isString().matches(/^[A-Za-z0-9]{3,32}$/).withMessage('That code is not valid.'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const checkout = billing.webCheckout(req.user.id);
    if (!checkout.ready) {
      return res.status(503).json({ error: 'Flock Pro is not on sale on the web yet.', code: 'CHECKOUT_OFF' });
    }
    const state = await getPremiumState(req.user.id);
    if (!state.known) {
      res.set('Retry-After', '5');
      return res.status(503).json({ error: 'Could not check your plan just now. Try again.', retryable: true });
    }
    if (state.premium) {
      return res.status(409).json({ error: 'You already have Flock Pro.', code: 'ALREADY_PRO' });
    }
    const u = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [req.user.id]);
    if (!u.rows[0]) return res.status(404).json({ error: 'Account not found.' });
    const url = await billing.createCheckout(u.rows[0], req.body.plan, {
      from: req.body.from || undefined,
      place: req.body.from === 'forecast' ? req.body.place || undefined : undefined,
      code: req.body.code || undefined,
    });
    res.json({ url });
  } catch (err) {
    sendError(res, err, 'Could not start checkout. Try again.');
  }
});

async function changeRenewal(req, res, cancel) {
  try {
    if (!billing.stripeConfigured()) {
      return res.status(503).json({ error: 'Web billing is not available right now.', code: 'BILLING_OFF' });
    }
    const result = cancel
      ? await billing.cancelAtPeriodEnd(req.user.id)
      : await billing.resumeSubscription(req.user.id);
    res.json(result);
  } catch (err) {
    sendError(res, err, cancel ? 'Could not cancel just now. Try again.' : 'Could not keep Pro just now. Try again.');
  }
}

router.post('/cancel', (req, res) => changeRenewal(req, res, true));
router.post('/resume', (req, res) => changeRenewal(req, res, false));

router.post('/portal', async (req, res) => {
  try {
    if (!billing.stripeConfigured()) {
      return res.status(503).json({ error: 'Web billing is not available right now.', code: 'BILLING_OFF' });
    }
    const url = await billing.createPortal(req.user.id);
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
    const result = await billing.confirmCheckout(req.user.id, req.body.sessionId);
    if (!result.complete) return res.json({ complete: false, isPremium: false });
    // Ask RevenueCat now rather than waiting for its webhook, so the buyer
    // lands in the app already Pro. A failure here is not a failed purchase:
    // the webhook still arrives, and the client keeps polling /status.
    let isPremium = false;
    try {
      isPremium = await syncPremiumFromRevenueCat(req.user.id);
    } catch (err) {
      console.warn('[pro] confirm could not reach RevenueCat yet:', err?.message || err);
    }
    // The second chance for the purchase acknowledgment, if the webhook's send
    // did not go through. Not awaited: the buyer is waiting on this answer.
    if (result.session) {
      acknowledgePurchase(req.user.id, result.session).catch((err) => {
        console.warn('[pro] purchase acknowledgment failed:', err?.message || err);
      });
    }
    res.json({ complete: true, isPremium });
  } catch (err) {
    sendError(res, err, 'Could not confirm your purchase yet. It can take a minute.');
  }
});

module.exports = router;
module.exports.describePlans = describePlans;
