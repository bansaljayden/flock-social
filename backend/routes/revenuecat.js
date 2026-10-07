const express = require('express');
const crypto = require('crypto');
const pool = require('../config/database');
const proBilling = require('../services/proBilling');

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

// ---------------------------------------------------------------------------
// A REFUSAL IS COUNTED, AND SAID ALOUD AT MOST ONCE EVERY TEN MINUTES
// ---------------------------------------------------------------------------
// The 401 below, and the 503 for a secret that is simply unset, used to answer
// with no log line at all (a too-short secret was the one refusal anything
// announced), and utils/serverFault.js counts only 5xx answers. A rolled
// secret, an Authorization value in the RevenueCat dashboard that no longer
// matches, or a variable cleared in a redeploy therefore refused every purchase
// event in silence, and RevenueCat drops each event after five retries over
// about two and a half hours.
//
// Not one line per refusal, though. Anyone can reach this route, and a log line
// per request is a free write into the log for whoever wants to bury something
// in it. So each refusal is counted by its reason, the first one after a quiet
// spell is reported at once, and the rest are summed into at most one line
// every ten minutes, each line carrying the counts since the line before. The
// presented header is never logged, whole or in part: on this route it is
// either the credential itself or somebody's guess at it.
const REFUSAL_LOG_INTERVAL_MS = 10 * 60 * 1000;
const REFUSAL_REASONS = {
  unconfigured: 'arrived while REVENUECAT_WEBHOOK_SECRET is unset, blank or too short (503)',
  no_header: 'carried no Authorization header (401)',
  mismatch: 'carried an Authorization value that did not match (401)',
};
// Fixed keys, set by this file and never by a request.
const refusalCounts = { unconfigured: 0, no_header: 0, mismatch: 0 };
let refusalsSince = null;
let refusalTimer = null;

function reportRefusals() {
  refusalTimer = null;
  const reasons = Object.keys(refusalCounts).filter((r) => refusalCounts[r] > 0);
  // Nothing new since the last line: the window closes, and the next refusal
  // is reported the moment it happens.
  if (reasons.length === 0) return;
  const total = reasons.reduce((sum, r) => sum + refusalCounts[r], 0);
  console.error(
    `[RevenueCat] webhook refused ${total} ${total === 1 ? 'request' : 'requests'} since ${new Date(refusalsSince).toISOString()}: `
    + reasons.map((r) => `${refusalCounts[r]} ${REFUSAL_REASONS[r]}`).join('; ')
    + '. Nothing was written. If RevenueCat sent them, every purchase event is being refused and each is dropped '
    + 'after five retries: compare REVENUECAT_WEBHOOK_SECRET on this service with the Authorization value in the '
    + 'RevenueCat dashboard.'
  );
  for (const r of reasons) refusalCounts[r] = 0;
  refusalsSince = null;
  // Refusals inside the next ten minutes are only counted, and this timer
  // reports them. Unref'd, so it never holds a process open.
  refusalTimer = setTimeout(reportRefusals, REFUSAL_LOG_INTERVAL_MS);
  refusalTimer.unref?.();
}

function noteRefusal(reason) {
  refusalCounts[reason] += 1;
  if (refusalsSince === null) refusalsSince = Date.now();
  if (!refusalTimer) reportRefusals();
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
// Live, not latent. REVENUECAT_WEBHOOK_SECRET is set in production, so the 503
// above does not answer first: RevenueCat's deliveries reach this branch today,
// with PAYWALL_ENABLED still off, and the first anonymous purchase it delivers
// is answered here rather than on the day the paywall is switched on.
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

// How many Flock accounts one TRANSFER may re-read from RevenueCat, which is a
// different question from how many ids it may name.
//
// MAX_TRANSFER_IDS bounds the arrays, anonymous aliases and all, and on the
// fallback path that is the whole cost: one UPDATE over the set. Under the
// subscriber re-read every account is a RevenueCat round trip of up to ten
// seconds (fetchProActive's ceiling) on a pooled connection, one after another
// inside a single delivery, and RevenueCat hangs up on a delivery that has not
// answered within 60 seconds and sends it again. Fifty is far too many to
// re-read: one TRANSFER used to cost up to a hundred reads. A real transfer
// names the accounts on its two sides, rarely more than two, and five reads at
// that ceiling still answer inside the minute.
//
// Counted after the ids with no users row are dropped (flockAccounts, below),
// since those are never read, and refused rather than truncated for the reason
// MAX_TRANSFER_IDS gives.
const MAX_TRANSFER_REREADS = 5;

// The ids among `ids` that are Flock accounts, in the order given. RevenueCat's
// subscriber lookup is "get or create": asking about an id it has never seen
// creates a customer for it, so an id with no users row is never asked about.
// There is nothing here to write for one either.
async function flockAccounts(ids) {
  if (ids.length === 0) return [];
  const { rows } = await pool.query('SELECT id FROM users WHERE id = ANY($1::int[])', [ids]);
  const known = new Set(rows.map((r) => Number(r.id)));
  return ids.filter((id) => known.has(id));
}

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
// REPLAY AND ORDERING. With REVENUECAT_SECRET_API_KEY set, which production
// has, order does not matter. Every event, TRANSFER included, is only a prompt
// to read the subscriber's whole state from RevenueCat and write THAT
// (syncPremiumFromRevenueCat, at the foot of this file). An INITIAL_PURCHASE
// whose delivery was retried for eighty minutes and lands after the EXPIRATION
// that superseded it writes "not premium", because that is what RevenueCat
// says now; a late EXPIRATION after a real RENEWAL writes "premium". A
// watermark column would add nothing on that path. Two re-reads racing each
// other are handled where the read happens.
//
// WITHOUT the key the handler falls back to writing from the event's type, and
// the fallback is applied in ARRIVAL order: users.is_premium is a bare boolean
// with no watermark, so a stale INITIAL_PURCHASE replayed after an EXPIRATION
// leaves the account premium until the next real event, and a late EXPIRATION
// after a RENEWAL drops a paying subscriber until the following month's
// renewal. That path is for a deployment that never configured the API key,
// and it is never taken quietly (WRITING FROM THE EVENT BODY, below). If the
// fallback ever has to carry real traffic, the fix is a per-account watermark:
// `users.premium_event_at TIMESTAMPTZ` written with is_premium, the UPDATE
// conditioned on `premium_event_at IS NULL OR premium_event_at < $3` from the
// event's own `event_timestamp_ms`, which RevenueCat supplies on every event.
//
// Why a nonce cache is NOT the answer, and would be worse than nothing: dedupe
// by event id in memory dies at every deploy and is per-instance, so it would
// catch some duplicates on one Railway instance and none across two — while
// reading, in code, as though replay were handled. Duplicates are already safe.
// Ordering is the problem, and a nonce cache does not address ordering.
//
// __tests__/billingWebhookTrust.test.js reproduces the reordering above and
// asserts this paragraph still exists, so the limit stays a known one.

// ---------------------------------------------------------------------------
// WRITING FROM THE EVENT BODY IS SAID ALOUD
// ---------------------------------------------------------------------------
// Which path an event takes is decided on every request by whether
// REVENUECAT_SECRET_API_KEY is configured. Without it the route stops asking
// RevenueCat and writes users.is_premium from what the event itself says: its
// type, its app_user_id, its environment, its transfer lists. The webhook
// secret is then the only thing between a caller and the column that decides
// who has paid, and late or retried events apply in arrival order. That switch
// used to happen with no log line at all. services/entitlements.js warns about
// it only while the paywall is on, and the webhook is live with the paywall
// off, so a key lost in a rotation would have gone unnoticed for as long as
// nothing visibly broke.
//
// So it is said twice per process, and no more: at boot in production (at the
// foot of this file), where a live webhook without the key is a mistake and
// not the ordinary local state, and on the first event applied this way,
// wherever that happens.
function announceBodyTrust(type, ids) {
  announceOnce(
    'body-trust',
    `[RevenueCat] REVENUECAT_SECRET_API_KEY is not set, so this ${String(type || 'event').slice(0, 40)} for [${ids}] `
    + 'and every event after it is applied from what the event says, with no RevenueCat re-read. The webhook secret '
    + 'is then the only check on users.is_premium, and late or retried events apply in arrival order. Set the '
    + 'RevenueCat secret API key. Said once per process.'
  );
}

// RevenueCat webhook. Live in production: REVENUECAT_WEBHOOK_SECRET is set
// there, so this route accepts RevenueCat's events now, while the consumer
// paywall (PAYWALL_ENABLED) is still off. Flips users.is_premium on entitlement
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
      noteRefusal('unconfigured');
      return res.status(503).json({ error: 'Webhook not configured' });
    }
    if (!secretMatches(req.headers.authorization, expected)) {
      // Which kind of miss, and nothing about what was presented.
      noteRefusal(String(req.headers.authorization ?? '').trim() ? 'mismatch' : 'no_header');
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

      // Under the subscriber re-read, a transfer is a prompt to re-read every
      // Flock account on both sides. Writing from the event would switch off an
      // account whose App Store purchase moved away while its Stripe
      // subscription is still paid. Any read that fails answers 500 so
      // RevenueCat retries the whole event. Ids with no account are dropped
      // before RevenueCat is asked, and at most MAX_TRANSFER_REREADS accounts
      // are read.
      if (proBilling.revenueCatApiConfigured()) {
        const named = [...new Set([...from, ...to])];
        const accounts = await flockAccounts(named);
        if (accounts.length > MAX_TRANSFER_REREADS) {
          console.error(`[RevenueCat] TRANSFER naming ${accounts.length} Flock accounts, more than the ${MAX_TRANSFER_REREADS} one transfer may re-read, refused`);
          return res.status(400).json({ error: 'Too many accounts in transfer' });
        }
        if (accounts.length === 0) return res.json({ ok: true, ignored: 'no_such_account' });
        for (const id of accounts) {
          await syncPremiumFromRevenueCat(id);
        }
        const skipped = named.length - accounts.length;
        console.log(`[RevenueCat] TRANSFER re-read [${accounts}]${skipped ? `, skipped ${skipped} id(s) with no Flock account` : ''}`);
        return res.json({ ok: true, source: 'subscriber' });
      }

      // From here the transfer is taken at its word (WRITING FROM THE EVENT
      // BODY, above).
      announceBodyTrust(type, [...new Set([...from, ...to])]);

      // A SANDBOX TRANSFER MOVES NOTHING ANYBODY PAID FOR. TestFlight and App
      // Review restore purchases in Apple's sandbox, and RevenueCat reports that
      // as a TRANSFER like any other. This branch used to grant is_premium to
      // every transferred_to id before any sandbox rule was applied, so a free
      // sandbox purchase restored on a second login became production Pro on
      // that account. The rule INITIAL_PURCHASE gets below applies here too:
      // in the sandbox only the allowlisted accounts move, on either side. A
      // non-listed account cannot hold Pro from a sandbox purchase on this path,
      // so its Pro came from a real one and a sandbox transfer must not take it.
      const sandbox = event.environment === 'SANDBOX';
      const moves = (id) => !sandbox || proBilling.sandboxAllowed(id);
      const giving = from.filter(moves);
      const getting = to.filter(moves);
      if (sandbox && giving.length === 0 && getting.length === 0) {
        return res.json({ ok: true, ignored: 'sandbox' });
      }

      // An id on BOTH sides keeps its entitlement and is never revoked on the
      // way through. A subscriber's alias set is "every app_user_id this SDK has
      // been logged in as", so an overlap is ordinary rather than exotic. The
      // two statements below are separate and not in one transaction, so
      // revoking first and granting second left that account reading
      // is_premium = false in between — and every entitlement check in
      // services/entitlements.js is a fresh read with no cache, so a request
      // landing in that window showed a paying subscriber the upgrade sheet.
      // The net result was always right; the window was the bug.
      const receiving = new Set(getting);
      const revoking = giving.filter((id) => !receiving.has(id));

      // Revoke and grant in ONE statement when both sides exist. They used to
      // be two autocommits, and the comment above only closed the
      // interleaving window (an id on both sides was never revoked). The
      // failure window stayed open: a revoke that committed followed by a
      // grant that threw left every transferred_from id non-premium and no
      // transferred_to id premium until RevenueCat's retry converged, and
      // services/entitlements.js reads the column fresh on every check, so a
      // paying subscriber saw the upgrade sheet in between. The two sets are
      // disjoint by construction (revoking = giving minus getting), which is what
      // lets one statement touch both without updating any row twice. A
      // one-sided transfer still issues only the statement it needs, so a
      // from-only or to-only event reads exactly as it did.
      if (revoking.length && getting.length) {
        await pool.query(
          `WITH revoked AS (
             UPDATE users SET is_premium = false
              WHERE id = ANY($1::int[]) AND is_premium IS DISTINCT FROM false
              RETURNING id
           )
           UPDATE users SET is_premium = true
            WHERE id = ANY($2::int[]) AND is_premium IS DISTINCT FROM true`,
          [revoking, getting]
        );
      } else if (revoking.length) {
        await pool.query(
          'UPDATE users SET is_premium = false WHERE id = ANY($1::int[]) AND is_premium IS DISTINCT FROM false',
          [revoking]
        );
      } else if (getting.length) {
        await pool.query(
          'UPDATE users SET is_premium = true WHERE id = ANY($1::int[]) AND is_premium IS DISTINCT FROM true',
          [getting]
        );
      }
      console.log(`[RevenueCat] TRANSFER from [${revoking}] to [${getting}]${sandbox ? ' (sandbox, allowlisted accounts only)' : ''}`);
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

    // ASK, DO NOT INFER, once there are two stores. Pro can be bought from
    // Apple in the app or from Stripe on the web, and RevenueCat holds both.
    // Setting the column from this one event's type would let an Apple
    // EXPIRATION switch off somebody whose Stripe subscription is still paid,
    // and the reverse. So with the API key configured, every event is only a
    // prompt to read the subscriber's whole state and write that. A failed
    // read throws into the catch below, which answers 500, and RevenueCat
    // retries: nothing is written from a guess.
    if (proBilling.revenueCatApiConfigured()) {
      // Only an account that exists is re-read, for the reason flockAccounts
      // gives. An event can name one that is gone: an account deleted while its
      // App Store subscription ran on still gets that subscription's
      // EXPIRATION. routes/stripeWebhook.js stops the same way.
      const exists = await pool.query('SELECT 1 FROM users WHERE id = $1', [appUserId]);
      if (!exists.rows || exists.rows.length === 0) return res.json({ ok: true, ignored: 'no_such_account' });
      await syncPremiumFromRevenueCat(appUserId);
      return res.json({ ok: true, source: 'subscriber' });
    }

    // From here the event is taken at its word (WRITING FROM THE EVENT BODY,
    // above).
    announceBodyTrust(type, [appUserId]);

    // A sandbox event (TestFlight, App Review) cost nobody anything and
    // writes nothing, except for the allowlisted accounts; the same rule
    // fetchProActive applies on the path above.
    if (event.environment === 'SANDBOX' && !proBilling.sandboxAllowed(appUserId)) {
      return res.json({ ok: true, ignored: 'sandbox' });
    }

    // No default. A type this table has never heard of writes nothing.
    let premium = PREMIUM_BY_EVENT.has(type) ? PREMIUM_BY_EVENT.get(type) : null;
    // A REFUND arrives as CANCELLATION with cancel_reason CUSTOMER_SUPPORT,
    // and RevenueCat removes the entitlement at once; no EXPIRATION follows.
    // An ordinary CANCELLATION (auto-renew off) still keeps Pro to the end of
    // the paid period, which is why the table itself leaves CANCELLATION out.
    if (type === 'CANCELLATION' && event.cancel_reason === 'CUSTOMER_SUPPORT') premium = false;

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

// THE ONE WRITE THAT ASKS REVENUECAT. Used by the webhook above whenever the
// API key is configured, by routes/stripeWebhook.js, and by routes/pro.js
// right after a web checkout so the buyer lands in the app already Pro.
// Returns what it wrote. Throws when RevenueCat could not give a clear answer,
// and writes nothing in that case.
//
// ONE SYNC PER ACCOUNT AT A TIME, AND THE LAST ONE READS LAST. Every caller
// writes an absolute is_premium, and two of them can overlap: Stripe's
// checkout.session.completed beside RevenueCat's own webhook for the same
// purchase, or a refund's event beside a retried renewal. Unserialised, a
// slow read taken before the refund could commit after a fast read taken
// after it and leave a refunded account Pro, with no later event left to
// correct it. (An earlier version read a "no" twice and never re-read a
// "yes", which narrowed the window in one direction and left it open in the
// one that gives Pro away.) So the read happens INSIDE a transaction that
// holds a per-account advisory lock: a second sync for the same account waits
// for the first to commit, then reads RevenueCat itself and writes that, so
// the last write is always the freshest read.
//
// The cost is a pooled connection held for one RevenueCat read, which
// fetchProActive bounds at ten seconds. Syncs for different accounts do not
// wait on each other. The two-int lock form keys on the exact account id, the
// way routes/feedback.js does, so no two accounts can share a lock by hash.
const PREMIUM_SYNC_LOCK_NAMESPACE = 81431;

async function syncPremiumFromRevenueCat(userId) {
  const id = userIdFrom(userId);
  if (!id) throw new Error('syncPremiumFromRevenueCat needs a Flock user id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [PREMIUM_SYNC_LOCK_NAMESPACE, id]);
    const active = await proBilling.fetchProActive(id);
    await client.query(
      'UPDATE users SET is_premium = $1 WHERE id = $2 AND is_premium IS DISTINCT FROM $1',
      [active, id]
    );
    await client.query('COMMIT');
    return active;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
module.exports.syncPremiumFromRevenueCat = syncPremiumFromRevenueCat;
// One view of "configured", shared rather than duplicated. The cross-file gap
// described at the top of this file is closed by services/entitlements.js
// calling this instead of reading the raw variable: two copies of a security
// rule drift, and the drift is silent by construction here, since the whole
// point of the preflight is to speak up in a case the other check misreads.
// Exported off the router object because the router is this module's export;
// it carries no request state, so a service reading it is a pure call.
module.exports.configuredSecret = configuredSecret;

// For the tests: the TRANSFER re-read cap, so a suite can stand at it, and the
// refusal summary, which is timed and has to be started from a known state and
// driven without a real clock.
module.exports.__testing = {
  MAX_TRANSFER_REREADS,
  REFUSAL_LOG_INTERVAL_MS,
  noteRefusal,
  resetRefusals() {
    if (refusalTimer) clearTimeout(refusalTimer);
    refusalTimer = null;
    refusalsSince = null;
    for (const r of Object.keys(refusalCounts)) refusalCounts[r] = 0;
  },
};

// SAID AT BOOT, before any event can arrive (WRITING FROM THE EVENT BODY,
// above). Production only, where the webhook is live and running it without
// the API key is a mistake; a local run without either is the ordinary state.
// With no usable webhook secret the route refuses every event, nothing is
// taken at its word, and this stays quiet; configuredSecret announces a short
// one itself.
if (process.env.NODE_ENV === 'production' && configuredSecret() && !proBilling.revenueCatApiConfigured()) {
  console.error(
    '[RevenueCat] REVENUECAT_SECRET_API_KEY is not set, so POST /api/revenuecat/webhook writes users.is_premium '
    + 'from what each event says, with no RevenueCat re-read. Whoever holds REVENUECAT_WEBHOOK_SECRET can then grant '
    + 'or revoke Pro on any account, and late or retried events apply in arrival order. Set the RevenueCat secret '
    + 'API key on this service.'
  );
}
