'use strict';
// ---------------------------------------------------------------------------
// GET /api/pro-offer: whether Flock Pro is on sale on the web, and at what
// price. PUBLIC, and its own router so the route inventory can see that it is.
//
// The marketing page's pricing section shows a Flock Pro card only while this
// answers available, with the prices Stripe will actually charge, so the
// homepage can never advertise something nobody can buy. It says nothing about
// any account, reads no body, and answers from the environment and a
// ten-minute price cache, so every caller gets the same answer. Cached at the
// edge for five minutes. A failure hides the card, which is the safe way to be
// wrong.
// ---------------------------------------------------------------------------
const express = require('express');
const billing = require('../services/proBilling');
const { describePlans } = require('./pro');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=300');
    const checkout = billing.webCheckout();
    if (!checkout.ready) return res.json({ available: false, plans: [] });
    res.json({
      available: true,
      plans: await describePlans(),
      trialDays: billing.trialDays(),
      taxAdded: billing.taxEnabled(),
    });
  } catch (err) {
    console.error('[pro-offer]', err?.message || err);
    res.json({ available: false, plans: [] });
  }
});

module.exports = router;
