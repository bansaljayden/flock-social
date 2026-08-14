const express = require('express');
const crypto = require('crypto');
const pool = require('../config/database');

const router = express.Router();

// Constant-time compare so the shared secret can't be recovered byte by byte.
// /api/revenuecat is deliberately mounted without a rate limiter (webhook
// retries must never be throttled), which is exactly the shape that makes a
// timing oracle worth worrying about.
function secretMatches(header, secret) {
  const a = Buffer.from(String(header || ''));
  const b = Buffer.from(`Bearer ${secret}`);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Which RevenueCat entitlement means "Flock Pro". Must match the identifier the
// client reads (frontend/src/services/purchases.js -> entitlements.active['pro']).
const PRO_ENTITLEMENT = process.env.REVENUECAT_ENTITLEMENT_ID || 'pro';

// True when the event carries entitlement identifiers and none of them is the
// Pro entitlement. Events that carry no identifiers at all fall through to the
// old behavior — RevenueCat omits them on some legacy payloads and dropping
// those would be worse than acting on them.
function isForeignEntitlement(event) {
  const ids = Array.isArray(event.entitlement_ids)
    ? event.entitlement_ids
    : (event.entitlement_id ? [event.entitlement_id] : []);
  if (ids.length === 0) return false;
  return !ids.includes(PRO_ENTITLEMENT);
}

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
    if (!secretMatches(req.headers.authorization, secret)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const event = req.body?.event || {};
    const type = event.type;

    // Only the Pro entitlement moves users.is_premium (audit 2026-08-13). The
    // old handler flipped premium on ANY INITIAL_PURCHASE / RENEWAL and
    // revoked it on ANY EXPIRATION, so the first non-Pro product ever added to
    // the RevenueCat project (a consumable, a venue add-on, a cheaper tier)
    // would have granted Flock Pro for its price — and its expiration would
    // have revoked Pro from a paying subscriber.
    if (isForeignEntitlement(event)) {
      return res.json({ ok: true, ignored: 'entitlement' });
    }

    // TRANSFER moves an entitlement between accounts (a restore on a new
    // login, or a family/device handover). Its payload carries no
    // app_user_id at all, just transferred_from / transferred_to arrays, so
    // the generic handler below 400'd it and neither account was updated:
    // the receiving user stayed locked out of something they own, and the
    // old one kept access they no longer have (round 10).
    if (type === 'TRANSFER') {
      const ids = (arr) => (Array.isArray(arr) ? arr : [])
        .map((v) => parseInt(v))
        .filter((n) => Number.isInteger(n));
      const from = ids(event.transferred_from);
      const to = ids(event.transferred_to);
      if (from.length) {
        await pool.query('UPDATE users SET is_premium = false WHERE id = ANY($1::int[])', [from]);
      }
      if (to.length) {
        await pool.query('UPDATE users SET is_premium = true WHERE id = ANY($1::int[])', [to]);
      }
      console.log(`[RevenueCat] TRANSFER from [${from}] to [${to}]`);
      return res.json({ ok: true });
    }

    const appUserId = parseInt(event.app_user_id);
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
