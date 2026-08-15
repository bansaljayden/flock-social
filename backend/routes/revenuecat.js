const express = require('express');
const crypto = require('crypto');
const pool = require('../config/database');

const router = express.Router();

// ---------------------------------------------------------------------------
// WHAT AUTHENTICATES A CALLER HERE
// ---------------------------------------------------------------------------
// RevenueCat authenticates with a static shared secret in an Authorization
// header. It is NOT a signature over the body, and nothing about the payload is
// verified: whoever holds the header value can send any event they like about
// any account they like. That single fact sets the shape of everything below.
//
//   * The secret is the whole boundary, so a secret that is absent, blank or
//     short is not a weaker boundary, it is no boundary. All three answer 503.
//   * Body integrity is not a thing that exists to be checked. A "mutated body
//     with a valid signature" is not a distinct attack here, and neither is a
//     replayed request: an attacker who can replay one captured request already
//     holds the header it carried, and with the header they can forge a fresh
//     request instead. A nonce cache or a timestamp window would bound nothing
//     the secret does not already bound. See REPLAY AND ORDERING below for the
//     part that IS a real limit.
//
// Constant time, because /api/revenuecat is deliberately mounted with no rate
// limiter (webhook retries must never be throttled) and there is therefore
// nothing at all slowing down somebody timing this compare byte by byte.
// __tests__/fieldBounds.test.js pins the shape of the compare against the
// source, since no black-box test can observe it.
function constantTimeEquals(presented, expected) {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// A secret shorter than this is treated as unconfigured.
//
// The route it guards has no rate limiter and one job: flipping the column that
// decides who has paid. A short value is guessable at whatever rate the network
// allows, so "configured badly" and "not configured" have the same security
// answer and should get the same behaviour. PAYWALL.md step 3 tells the operator
// to generate a long random secret; `openssl rand -hex 32` clears this by 48
// characters, so the floor only ever bites a value that was never going to hold.
//
// It refuses LOUDLY. A silent 503 on a secret that is visibly present in the
// Railway dashboard is indistinguishable from "the webhook is broken", and the
// person debugging it would be looking at the one variable that appears fine.
//
// CROSS-FILE, and it needs someone to close it: services/entitlements.js
// paywallEnabled() warns when PAYWALL_ENABLED=true and the webhook secret is
// missing — the "wall with no door in it" preflight — but it tests
// `!process.env.REVENUECAT_WEBHOOK_SECRET`, raw. A blank or too-short value
// looks SET to that check and unconfigured to this one, so the preflight would
// stay quiet in exactly the case it exists to catch: metering every account
// while no purchase can lift any of them. That file is not this audit's to edit;
// the fix there is one line, calling this module's view of "configured" instead
// of its own.
const MIN_SECRET_LENGTH = 16;

// `Bearer` plus at least one space. Case-insensitive because the scheme name is
// not the secret and an operator typing `bearer` has not failed to authenticate.
const BEARER_PREFIX = /^Bearer[ \t]+/i;

const announced = new Set();
function announceOnce(key, message) {
  if (announced.has(key)) return;
  announced.add(key);
  console.error(message);
}

// The one place that decides what "configured" means, so two answers to that
// question cannot drift apart.
//
// Whitespace is stripped, and that closes a real hole rather than being tidy:
// the old guard was `if (!secret)`, and `' '` is truthy. A Railway variable
// someone cleared by typing a space read as CONFIGURED, and the credential it
// then accepted was `Bearer ` followed by that space — an effectively public
// webhook that looked locked. A trailing newline from a paste had the milder
// version of the same problem: it never matched anything and the webhook 401'd
// every real event for ever.
//
// A `Bearer ` prefix is stripped from the CONFIGURED value too. RevenueCat's
// dashboard field is free text and PAYWALL.md has the operator paste
// `Bearer <secret>` into it and the bare secret into Railway, minutes apart, by
// hand. Getting that pairing backwards or doubling it is the likeliest single
// mistake in the whole paywall flip, and its symptom is silent: purchases
// succeed in the App Store, every webhook 401s, and nobody who paid gets Pro.
function configuredSecret() {
  const raw = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(BEARER_PREFIX, '').trim();
  if (!value) return null;
  if (value.length < MIN_SECRET_LENGTH) {
    announceOnce(
      `weak-secret:${value.length}`,
      `[RevenueCat] REVENUECAT_WEBHOOK_SECRET is ${value.length} characters. `
      + `This route has no rate limiter and is the only writer of users.is_premium, so a secret under `
      + `${MIN_SECRET_LENGTH} characters is treated as UNCONFIGURED and every webhook is refused with 503. `
      + `Set a long random value (openssl rand -hex 32).`
    );
    return null;
  }
  return value;
}

// Accepts the header with or without the scheme, both compared constant time.
// This widens the accepted SPELLING, never the accepted SECRET: every branch
// still ends at a full-length constant-time compare against the configured
// value, and __tests__/billingWebhookTrust.test.js asserts that the wrong secret
// is still refused in each spelling.
function secretMatches(header, expected) {
  const presented = String(header == null ? '' : header).trim();
  if (constantTimeEquals(presented, expected)) return true;
  return constantTimeEquals(presented.replace(BEARER_PREFIX, ''), expected);
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
//
// KNOWN GAP, and it is TRANSFER's. RevenueCat's TRANSFER payload carries no
// entitlement identifiers at all — only transferred_from / transferred_to — so
// this function cannot scope it and the handler below moves Flock Pro on every
// transfer regardless of which entitlement actually moved. Harmless while `pro`
// is the only entitlement in the project, which it is. The day a second one is
// added (a venue add-on, a cheaper tier), a transfer of THAT entitlement will
// move Flock Pro with it, and RevenueCat does not send us enough to tell the
// difference. The fix at that point is a subscriber lookup against their REST
// API, not a guess here.
function isForeignEntitlement(event) {
  const ids = Array.isArray(event.entitlement_ids)
    ? event.entitlement_ids
    : (event.entitlement_id ? [event.entitlement_id] : []);
  if (ids.length === 0) return false;
  return !ids.includes(PRO_ENTITLEMENT);
}

// ---------------------------------------------------------------------------
// THE EVENT MAPPING TABLE
// ---------------------------------------------------------------------------
// Every event type RevenueCat sends is either in this table or it does nothing.
// There is no default and no fallthrough: an unrecognised type is answered 200
// and ignored, because "we have never heard of this" must never be spelled the
// same way as "revoke" or as "grant".
//
// A Map and not an object literal. `EFFECT[type]` on a plain object answers
// Object.prototype for `constructor`, `toString`, `__proto__` and friends, and
// `type` is a caller-supplied string on a route with no field validation — so
// `{"type":"constructor"}` would have found a truthy function and granted Pro.
// A Map has no prototype chain to walk into.
//
//   INITIAL_PURCHASE   grant    the purchase, including the start of a free trial
//   RENEWAL            grant    also fires when a lapsed subscription is resubscribed
//   UNCANCELLATION     grant    auto-renew switched back on before the period ended
//   PRODUCT_CHANGE     grant    the subscription continues, on a different product
//   EXPIRATION         revoke    THE loss-of-access event, and the only one. It also
//                                carries refunds (expiration_reason CUSTOMER_SUPPORT)
//   SUBSCRIPTION_PAUSED revoke   Android pause; access genuinely stops
//
// Deliberately absent, each for a reason worth more than the line it saves:
//   CANCELLATION        auto-renew was switched OFF. The customer keeps what they
//                       paid for until the period ends, when EXPIRATION arrives.
//                       Revoking here takes access from someone who is paid up, on
//                       the day they were most annoyed at the product. This is the
//                       single most tempting row to "fix" — the word says
//                       cancelled — and it has been wrong once already (round 4).
//   BILLING_ISSUE       grace period. Revoking mid-grace punishes an expired card.
//                       EXPIRATION follows if it is never fixed.
//   SUBSCRIPTION_EXTENDED / TEMPORARY_ENTITLEMENT_GRANT
//                       still entitled, just for longer. Nothing to change.
//   NON_RENEWING_PURCHASE
//                       there is no non-renewing Pro product. If one is ever added
//                       (a lifetime unlock), it belongs in this table as a grant
//                       AND needs a decision about what could ever revoke it.
//   SUBSCRIBER_ALIAS / INVOICE_ISSUANCE / VIRTUAL_CURRENCY_TRANSACTION / REFUND_REVERSED
//                       carry no entitlement change we act on.
//   TRANSFER            handled separately below; its payload has no app_user_id.
//   TEST                handled separately below; its app_user_id is not ours.
const PREMIUM_BY_EVENT = new Map([
  ['INITIAL_PURCHASE', true],
  ['RENEWAL', true],
  ['UNCANCELLATION', true],
  ['PRODUCT_CHANGE', true],
  ['EXPIRATION', false],
  ['SUBSCRIPTION_PAUSED', false],
]);

// ---------------------------------------------------------------------------
// IDEMPOTENCE, REPLAY AND ORDERING
// ---------------------------------------------------------------------------
// IDEMPOTENCE holds structurally, not defensively. RevenueCat redelivers on any
// non-200 (five times, at 5/10/20/40/80 minutes) and may redeliver anyway, so
// duplicates are normal traffic. Every write on this route is an ABSOLUTE
// assignment of a boolean — never a toggle, never a delta, never a read-modify-
// write — so applying the same event twice lands on exactly the state applying
// it once does. There is nothing to double. The `IS DISTINCT FROM` guard on the
// UPDATE makes that observable (a redelivery reports rowCount 0) and keeps a
// monthly RENEWAL storm from rewriting every subscriber's row to the value it
// already holds. It is `IS DISTINCT FROM` and not `<>` because is_premium is
// nullable — `<> true` skips a NULL row and would leave it unset for ever.
//
// REPLAY AND ORDERING is the real limit, and it is accepted rather than fixed.
// Deliveries are applied in ARRIVAL order, and nothing here can tell a fresh
// event from an old one: users.is_premium is a bare boolean, there is no
// subscription table, no event log and no watermark column. So an
// INITIAL_PURCHASE whose delivery failed and was retried for eighty minutes can
// land AFTER the EXPIRATION that superseded it, and the account is left premium
// until the next real event moves it. The same is true in the other direction,
// which is the harmful one only in the reverse case: a late EXPIRATION landing
// after a legitimate RENEWAL drops a paying subscriber, and nothing will restore
// them until the following month's renewal.
//
// Why it is not fixed here: the fix is a per-account watermark — a
// `users.premium_event_at TIMESTAMPTZ` written alongside is_premium, with the
// UPDATE conditioned on `premium_event_at IS NULL OR premium_event_at < $3`
// using the event's own `event_timestamp_ms`. That is a migration plus a column,
// which is a schema change and not this route's to make unilaterally; RevenueCat
// does supply `event_timestamp_ms` on every event, so the input is already
// there. Do it in the same change that adds any durable subscription state, and
// do it BEFORE the volume of renewals makes a reordered delivery likely rather
// than merely possible.
//
// Why a nonce cache is NOT the answer, and would be worse than nothing: dedupe
// by event id in memory dies at every deploy and is per-instance, so it would
// catch some duplicates on one Railway instance and none across two — while
// reading, in code, as though replay were handled. Duplicates are already safe.
// Ordering is the problem, and a nonce cache does not address ordering.
//
// __tests__/billingWebhookTrust.test.js reproduces the reordering above and
// asserts this paragraph still exists, so the limit stays a known one.

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
    // Fail closed: absent, blank or too short are all "no boundary exists", and
    // this endpoint must accept nothing until one does — otherwise anyone who
    // found the URL could flip users.is_premium for any user id.
    const expected = configuredSecret();
    if (!expected) {
      return res.status(503).json({ error: 'Webhook not configured' });
    }
    if (!secretMatches(req.headers.authorization, expected)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const event = req.body?.event || {};
    // Narrowed to a string before anything compares or looks it up, so an array
    // or an object cannot reach a match by coercion.
    const type = typeof event.type === 'string' ? event.type : null;

    // Only the Pro entitlement moves users.is_premium (audit 2026-08-13). The
    // old handler flipped premium on ANY INITIAL_PURCHASE / RENEWAL and
    // revoked it on ANY EXPIRATION, so the first non-Pro product ever added to
    // the RevenueCat project (a consumable, a venue add-on, a cheaper tier)
    // would have granted Flock Pro for its price — and its expiration would
    // have revoked Pro from a paying subscriber.
    if (isForeignEntitlement(event)) {
      return res.json({ ok: true, ignored: 'entitlement' });
    }

    // The "Send test webhook" button in the RevenueCat dashboard, which is the
    // last step of PAYWALL.md's setup and the first thing anyone clicks to find
    // out whether this endpoint works. Its app_user_id is a placeholder, not a
    // Flock id, so it fell through to the generic 400 below and the dashboard
    // reported the brand new webhook as FAILING — at the exact moment somebody
    // is deciding whether the integration is wired correctly. It writes nothing
    // either way; the only question was whether the operator is told the truth.
    if (type === 'TEST') {
      return res.json({ ok: true, ignored: 'test' });
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

      // An id on BOTH sides keeps its entitlement and is never revoked on the
      // way through. A subscriber's alias set is "every app_user_id this SDK has
      // been logged in as", so an overlap is ordinary rather than exotic. The
      // two statements below are separate and not in one transaction, so
      // revoking first and granting second left that account reading
      // is_premium = false in between — and every entitlement check in
      // services/entitlements.js is a fresh read with no cache, so a request
      // landing in that window showed a paying subscriber the upgrade sheet.
      // The net result was always right; the window was the bug.
      const receiving = new Set(to);
      const revoking = from.filter((id) => !receiving.has(id));

      if (revoking.length) {
        await pool.query(
          'UPDATE users SET is_premium = false WHERE id = ANY($1::int[]) AND is_premium IS DISTINCT FROM false',
          [revoking]
        );
      }
      if (to.length) {
        await pool.query(
          'UPDATE users SET is_premium = true WHERE id = ANY($1::int[]) AND is_premium IS DISTINCT FROM true',
          [to]
        );
      }
      console.log(`[RevenueCat] TRANSFER from [${revoking}] to [${to}]`);
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

    // No default. A type this table has never heard of writes nothing.
    const premium = PREMIUM_BY_EVENT.has(type) ? PREMIUM_BY_EVENT.get(type) : null;

    if (premium !== null) {
      // No swallowed errors here (round 3): returning 200 on a failed write
      // makes RevenueCat mark the event delivered and never retry, leaving
      // entitlements permanently stale. A 500 triggers their retry queue.
      await pool.query(
        'UPDATE users SET is_premium = $1 WHERE id = $2 AND is_premium IS DISTINCT FROM $1',
        [premium, appUserId]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    // `err?.message || err`, not `err.message`: a throw of null or of a bare
    // string made the catch itself throw, which loses the original failure and
    // hands Express its default error page instead of the 500 that RevenueCat
    // needs to see in order to retry.
    console.error('RevenueCat webhook error:', err?.message || err);
    res.status(500).json({ error: 'Webhook failed' });
  }
});

module.exports = router;
