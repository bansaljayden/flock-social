'use strict';
// ---------------------------------------------------------------------------
// /api/pro: Flock Pro bought on the web.
//
//   GET  /status    what the web can sell this account right now, and whether
//                   it has a web subscription to manage. Always answers, even
//                   with checkout switched off, so the page can say so.
//   POST /checkout  { plan: 'monthly' | 'yearly' } -> { url } of a Stripe
//                   Checkout Session tied to this account.
//   POST /portal    -> { url } of the Stripe customer portal, where a web
//                   subscriber cancels or changes their card.
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

const router = express.Router();

const PLANS = ['monthly', 'yearly'];

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
    const checkout = billing.webCheckout();
    const customerId = await billing.customerIdFor(req.user.id);
    let canManageWeb = false;
    if (customerId && billing.stripeConfigured()) {
      canManageWeb = await billing.hasEverSubscribed(customerId).catch(() => false);
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
      trialDays: sellable ? billing.trialDays() : 0,
      taxAdded: sellable ? billing.taxEnabled() : false,
      // True once this account has ever been a Stripe customer, which is when
      // the portal has something to show.
      canManageWeb,
    });
  } catch (err) {
    sendError(res, err, 'Could not load Flock Pro just now.');
  }
});

router.post('/checkout', [
  body('plan').isString().isIn(PLANS).withMessage('Choose monthly or yearly.'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    const checkout = billing.webCheckout();
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
    const url = await billing.createCheckout(u.rows[0], req.body.plan);
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
    res.json({ complete: true, isPremium });
  } catch (err) {
    sendError(res, err, 'Could not confirm your purchase yet. It can take a minute.');
  }
});

module.exports = router;
module.exports.describePlans = describePlans;
