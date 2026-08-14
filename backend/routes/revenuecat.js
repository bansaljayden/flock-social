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

// ---------------------------------------------------------------------------
// The ids this webhook is allowed to act on
// ---------------------------------------------------------------------------
// users.id is SERIAL, i.e. int4. `parseInt` on its own says nothing about that
// range, so `{"app_user_id": "99999999999"}` reached `WHERE id = $2` as
// 99999999999 and came back a Postgres 22003 — a 500. RevenueCat treats a 5xx as
// a delivery failure and retries it, so a payload that can NEVER succeed is
// retried on their schedule until they give up, and the 500 sits in our logs
// looking like an outage. A caller-supplied id outside the column's range is a
// client error and has to be answered as one, the first time.
//
// Strict digits, too. `parseInt('4242junk')` is 4242, which means a mangled id
// silently resolved to a REAL user's row and flipped their is_premium. The one
// producer of this field is our own client calling Purchases.logIn(userId) with
// the numeric Flock user id, so a value that is not exactly digits is not an id
// we should be guessing at.
const MAX_INT4 = 2147483647;
function userIdFrom(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  if (!/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_INT4 ? n : null;
}

// The one app_user_id that is NOT a client error.
//
// RevenueCat gives every install an anonymous subscriber the moment the SDK
// starts, under an id of the form `$RCAnonymousID:<opaque>`. It stays anonymous
// until the client calls Purchases.logIn(userId), and a purchase made before
// that call — the app is open, the user is signed out, they buy, and logIn
// happens on the next sign-in, or never — is delivered here under that id.
//
// userIdFrom() answers null for it, correctly: there is no Flock account behind
// an anonymous id and there is nothing this webhook could write. But the answer
// was `400 Missing app_user_id`, and RevenueCat's webhook documentation is
// explicit that it retries on ANY status other than 200 — five times, at 5, 10,
// 20, 40 and 80 minutes. The comment above about 5xx is half the story. So a
// payload RevenueCat is RIGHT to send, and that cannot succeed on any of those
// five attempts, is redelivered for two and a half hours, and every attempt
// lands in our logs as a client error we did not make.
//
// The shape below is matched strictly, and it fails in the safe direction: an id
// RevenueCat spells differently one day stops matching and gets the old 400 back,
// which is noisy rather than wrong.
//
// Harmless today because the paywall is dormant (PAYWALL_ENABLED is unset and
// REVENUECAT_WEBHOOK_SECRET with it, so the 503 above answers first). It has to
// be right BEFORE the paywall is switched on, because that is the moment these
// events start arriving.
//
// Answered 200 with a reason, the same shape isForeignEntitlement uses: this is
// an event we understood and deliberately did nothing with, not one we failed.
// The distinction from the other refusals is kept deliberately: an id that is
// neither digits nor an anonymous id is a payload our client cannot produce, and
// a 400 is what puts that in RevenueCat's dashboard where somebody will see it.
const ANONYMOUS_ID_RE = /^\$RCAnonymousID:[A-Za-z0-9-]{1,64}$/;
function isAnonymousSubscriber(value) {
  return typeof value === 'string' && ANONYMOUS_ID_RE.test(value.trim());
}

// How many app_user_ids one TRANSFER may move.
//
// This is the only field on this route that reaches a query as a SET rather than
// as a single value, and it had no maximum of its own: the webhook parser in
// server.js is 256KB, so `transferred_to` could carry tens of thousands of ids
// and one request would rewrite is_premium on tens of thousands of rows. That
// ceiling is not this route's to own, and it moves whenever somebody tunes the
// parser for an unrelated reason.
//
// 50 is where the product puts it. A subscriber's alias set is the set of
// app_user_ids the SDK has ever been logged in as on that subscriber, and our
// client calls Purchases.logIn(userId) with the numeric Flock user id, so this
// is "how many distinct Flock accounts has one person signed into on one
// device". Fifty is already far past any real person.
//
// Refused rather than truncated. Acting on the first fifty of a much larger set
// would move some entitlements and silently drop the rest, which is the worst of
// the three options. A 400 makes RevenueCat mark the delivery failed, retry, and
// eventually surface it in their dashboard, which is where a payload our client
// cannot produce should show up.
const MAX_TRANSFER_IDS = 50;

// True when the event carries entitlement identifiers and none of them is the
// Pro entitlement. Events that carry no identifiers at all fall through to the
// old behavior — RevenueCat omits them on some legacy payloads and dropping
// those would be worse than acting on them.
//
// `entitlement_ids` is DELIBERATELY unbounded, and that is a different answer to
// the same question rather than an oversight. Nothing here is stored and nothing
// here reaches a query: the array is already in memory (the parser built it) and
// all we do is scan it once, which is strictly cheaper than the parse that
// produced it. Adding a ceiling would only add a way to refuse a real
// entitlement event, and a refused event is a paying subscriber who silently
// does not get Pro.
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
//
// NO PARSER HERE. This handler used to be mounted behind a bare `express.json()`
// of its own, which read as though this route controlled its own body handling
// and controlled nothing at all: body-parser sets `req._body` once the body has
// been read, and the parser block in server.js runs first, so the second one saw
// a body already consumed and returned immediately. Harmless while it was bare
// and a live trap the moment somebody added a `limit` to it, because that number
// would never apply and the next reader would believe it. This route's ceiling
// is WEBHOOK_JSON_BODY_BYTES in server.js, scoped there precisely because the
// sender is not us. __tests__/bodyLimitAudit.test.js fails if a limit reappears
// in any router.
router.post('/webhook', async (req, res) => {
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
      // Counted on the RAW arrays, before the map: measuring what survived
      // parsing would let a caller send a hundred thousand junk entries and pay
      // for the whole walk to arrive at a set of two.
      const oversized = (arr) => Array.isArray(arr) && arr.length > MAX_TRANSFER_IDS;
      if (oversized(event.transferred_from) || oversized(event.transferred_to)) {
        console.error(`[RevenueCat] TRANSFER naming more than ${MAX_TRANSFER_IDS} app_user_ids, refused`);
        return res.status(400).json({ error: 'Too many app_user_ids in transfer' });
      }
      const ids = (arr) => (Array.isArray(arr) ? arr : [])
        .map(userIdFrom)
        .filter((n) => n !== null);
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

    // Checked before userIdFrom, because an anonymous id is a shape we RECOGNISE
    // rather than one we failed to parse. See isAnonymousSubscriber.
    if (isAnonymousSubscriber(event.app_user_id)) {
      // The type is sliced before it is logged: it is a caller-supplied string on
      // a route with no per-field bounds (the webhook body is not ours to shape),
      // and a log line is not the place to find that out.
      console.warn(`[RevenueCat] ${String(type || 'event').slice(0, 40)} for an anonymous subscriber — no Flock account to apply it to, ignoring`);
      return res.json({ ok: true, ignored: 'anonymous' });
    }

    const appUserId = userIdFrom(event.app_user_id);
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
