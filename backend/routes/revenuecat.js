const express = require('express');
const pool = require('../config/database');

const router = express.Router();

// RevenueCat webhook (D-lite scaffolding). Dormant in v1.0; wired so turning the
// paywall on in v1.1 is a config flip. Flips users.is_premium on entitlement
// events. The client must call Purchases.logIn(userId) so RevenueCat's
// app_user_id IS our numeric user id.
//
// Auth: shared secret via REVENUECAT_WEBHOOK_SECRET (Railway env) matched against
// the Authorization header configured in the RevenueCat dashboard. No secret in code.
router.post('/webhook', express.json(), async (req, res) => {
  try {
    const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
    // Fail closed: without a configured secret this endpoint must not accept
    // events — otherwise anyone could flip users.is_premium for any user id.
    if (!secret) {
      return res.status(503).json({ error: 'Webhook not configured' });
    }
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });

    const event = req.body?.event || {};
    const appUserId = parseInt(event.app_user_id);
    const type = event.type;
    if (!appUserId) return res.status(400).json({ error: 'Missing app_user_id' });

    const ACTIVE = ['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE'];
    // Round 4: CANCELLATION only means auto-renew was switched off — the
    // customer keeps their entitlement until the paid period ends, when
    // RevenueCat sends EXPIRATION. Same for BILLING_ISSUE (grace period).
    // Revoking on those events took away access people had paid for.
    const INACTIVE = ['EXPIRATION', 'SUBSCRIPTION_PAUSED'];
    let premium = null;
    if (ACTIVE.includes(type)) premium = true;
    else if (INACTIVE.includes(type)) premium = false;

    if (premium !== null) {
      // No swallowed errors here (round 3): returning 200 on a failed write
      // makes RevenueCat mark the event delivered and never retry, leaving
      // entitlements permanently stale. A 500 triggers their retry queue.
      await pool.query('UPDATE users SET is_premium = $1 WHERE id = $2', [premium, appUserId]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('RevenueCat webhook error:', err.message);
    res.status(500).json({ error: 'Webhook failed' });
  }
});

module.exports = router;
