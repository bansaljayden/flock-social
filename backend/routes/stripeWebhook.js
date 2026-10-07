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
// NO REFUSAL IS SILENT, AND NONE IS A FREE LOG LINE. Each kind is counted and
// said at most once every ten minutes (REFUSALS below). A JSON body that
// arrives without its raw bytes is a 500 rather than a refusal, because only a
// broken parser row in server.js produces one.
//
// WHAT IT WRITES. Nothing directly. It posts the receipt to RevenueCat and then
// re-reads the subscriber through syncPremiumFromRevenueCat, the one writer of
// users.is_premium. A failure answers 500 so Stripe retries; every step is
// idempotent, so a retry cannot grant anything twice.
// ---------------------------------------------------------------------------
const express = require('express');
const pool = require('../config/database');
const billing = require('../services/proBilling');
const { acknowledgePurchase } = require('../services/proAcknowledgment');
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

// The refund events: charge.refunded carries the Charge, the others a Refund
// (refund.updated is the one that says a pending refund landed, and
// charge.refund.updated is its older name; refund.failed says a refund failed,
// including one Stripe had reported succeeded, which reopens a refused Roost
// purchase it finished). The endpoint has to be subscribed to them in the
// Stripe dashboard (VENUE-BILLING.md).
const REFUND_EVENTS = new Set([
  'charge.refunded',
  'charge.refund.updated',
  'refund.created',
  'refund.updated',
  'refund.failed',
]);

// Roost also needs `created`: a subscription can exist (a trial that starts
// with no charge) before anything else about it changes.
const VENUE_HANDLED = new Set([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

// ---------------------------------------------------------------------------
// REFUSALS: COUNTED, AND SAID OUT LOUD AT A BOUNDED RATE
// ---------------------------------------------------------------------------
// Every refusal here used to be silent. A signing secret rolled in Stripe and
// not copied to the server, or pasted into STRIPE_WEBHOOK_SECRET wrong, turned
// every delivery into a 400 that left no line anywhere, and Stripe's own
// failure email can take days. Roost renewals, cancellations and chargebacks
// have no other way in, and Stripe stops retrying an event after three days.
//
// The route has no rate limiter of its own (Stripe's retries must never be
// throttled), and the global backstop lets one address send about ten
// requests a second, so a line per refusal would be a free write to the log
// for anyone. Each kind is counted in memory instead and said at most once
// every ten minutes, with the count since its last line; the first of a kind
// is said at once. No line carries anything from the request: not the header,
// not the body, not the address.
//
// The line that matters is bad_signature: a refusal whose Stripe-Signature is
// shaped like a live delivery's. Anyone can write that shape, so the line is a
// lead rather than proof, and it says what else is known: when a delivery
// last verified, and whether any verified among the refusals.
const REFUSAL_LINE_EVERY_MS = 10 * 60 * 1000;
// constructEvent's own tolerance (stripe-node's DEFAULT_TOLERANCE). Stripe
// signs each delivery as it sends it, so a live one is never older than this.
const SIGNED_WITHIN_SECONDS = 300;
const V1_SIGNATURE = /^[0-9a-f]{64}$/; // a hex HMAC-SHA256
const UNIX_SECONDS = /^[0-9]{1,12}$/;

// Each kind of refusal, and whether its line is an error (somebody has to act)
// or a warning (traffic that is not Stripe's).
const REFUSAL_LEVELS = {
  not_configured: 'error', // 503: a Stripe variable is missing
  no_raw_body: 'error', // 500: server.js lost this route's raw-bytes parser
  bad_signature: 'error', // 400: shaped like a live delivery, did not verify
  no_signature: 'warn', // 400: no header, or no JSON body to check one against
  junk_signature: 'warn', // 400: did not verify, not shaped like a delivery
};

let startedAt = Date.now();
let lastVerifiedAt = null;
// Deliveries that verified while bad_signature refusals were waiting for their
// next line. Any at all means the secret is right, and the refusals came from
// some other sender.
let verifiedAmidRefusals = 0;
let tallies = {};

function resetRefusals(now = Date.now()) {
  startedAt = now;
  lastVerifiedAt = null;
  verifiedAmidRefusals = 0;
  tallies = {};
  for (const reason of Object.keys(REFUSAL_LEVELS)) {
    tallies[reason] = { total: 0, pending: 0, lastAt: null, lastLineAt: null };
  }
}
resetRefusals();

// Whether a Stripe-Signature header is shaped like a live delivery's: a t=
// timestamp within five minutes of now and at least one v1= signature, split
// the way stripe-node splits it. It tells "could be Stripe" from a scanner's
// junk, and proves nothing.
function looksLikeStripe(header, now = Date.now()) {
  let t = null;
  let signed = false;
  for (const item of String(header).split(',')) {
    const [key, value = ''] = item.split('=');
    if (key === 't') t = UNIX_SECONDS.test(value) ? Number(value) : null;
    if (key === 'v1' && V1_SIGNATURE.test(value)) signed = true;
  }
  return signed && t !== null && Math.abs(now / 1000 - t) <= SIGNED_WITHIN_SECONDS;
}

const iso = (ms) => new Date(ms).toISOString();
const howMany = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function refusalLine(reason, n, since) {
  const counted = `(counted since ${iso(since)})`;
  const requests = howMany(n, 'request', 'requests');
  if (reason === 'not_configured') {
    const missing = [];
    if (!billing.stripeWebhookConfigured()) missing.push('STRIPE_WEBHOOK_SECRET');
    if (!billing.stripeConfigured()) missing.push('STRIPE_SECRET_KEY');
    return `answered 503 to ${requests} ${counted}: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set to a usable value (16 characters or more), so no Stripe event, Pro or Roost, is applied. Stripe retries each one for up to three days.`;
  }
  if (reason === 'no_raw_body') {
    return `answered 500 to ${requests} ${counted}: a JSON body arrived without its raw bytes, so no signature could be checked. Only a change to server.js causes that: this route has lost its raw-bytes parser (the STRIPE_WEBHOOK_BODY_ROUTE row of SCOPED_JSON_PARSERS), and every Stripe delivery fails until it is back.`;
  }
  if (reason === 'no_signature') {
    return `refused ${requests} ${counted} with no Stripe-Signature header, or no JSON body to check one against. Stripe always sends both; if its dashboard shows failed deliveries too, something between Stripe and this server is dropping the header.`;
  }
  if (reason === 'junk_signature') {
    return `refused ${requests} ${counted} whose Stripe-Signature did not verify and is not shaped like a live delivery (no v1 signature, or not signed within five minutes of this server's clock). Counted and dropped.`;
  }
  const head = `${howMany(n, 'delivery', 'deliveries')} shaped like Stripe's (a v1 signature, signed within five minutes) failed the signature check ${counted}.`;
  if (verifiedAmidRefusals > 0) {
    return `${head} ${howMany(verifiedAmidRefusals, 'delivery', 'deliveries')} did verify among them, so STRIPE_WEBHOOK_SECRET matches the endpoint and these came from another sender: a second endpoint pointed at this URL, or a forgery.`;
  }
  const history = lastVerifiedAt !== null
    ? `The last delivery that verified arrived at ${iso(lastVerifiedAt)}. Deliveries that verified and then stopped are what a signing secret rolled in Stripe, or a changed STRIPE_WEBHOOK_SECRET, look like.`
    : `None has verified since this process started at ${iso(startedAt)}. If STRIPE_WEBHOOK_SECRET was set or changed with this deploy, it is not the endpoint's signing secret (a test-mode secret on the live endpoint looks the same).`;
  const problem = billing.stripeWebhookSecretProblem();
  return `${head} ${history}${problem ? ` STRIPE_WEBHOOK_SECRET ${problem}.` : ''} Compare STRIPE_WEBHOOK_SECRET with the signing secret of the endpoint for /api/stripe-webhook (Webhooks in the Stripe dashboard), and read that endpoint's failed deliveries: Stripe retries each refused event for up to three days. Anyone can send this shape, so this is a lead, not proof.`;
}

// Counts one refusal, and says so when this kind has been quiet for ten
// minutes. Returns whether a line was written.
function noteRefusal(reason, now = Date.now()) {
  const tally = tallies[reason];
  tally.total += 1;
  tally.pending += 1;
  tally.lastAt = now;
  if (tally.lastLineAt !== null && now - tally.lastLineAt < REFUSAL_LINE_EVERY_MS) return false;
  const line = `[stripe-webhook] ${refusalLine(reason, tally.pending, tally.lastLineAt === null ? startedAt : tally.lastLineAt)}`;
  tally.pending = 0;
  tally.lastLineAt = now;
  if (reason === 'bad_signature') verifiedAmidRefusals = 0;
  if (REFUSAL_LEVELS[reason] === 'error') console.error(line);
  else console.warn(line);
  return true;
}

function noteVerified(now = Date.now()) {
  lastVerifiedAt = now;
  if (tallies.bad_signature.pending > 0) verifiedAmidRefusals += 1;
}

// The counts as they stand, for tests.
function refusalStatus() {
  const refusals = {};
  for (const [reason, tally] of Object.entries(tallies)) {
    refusals[reason] = { total: tally.total, sinceLastLine: tally.pending, lastAt: tally.lastAt === null ? null : iso(tally.lastAt) };
  }
  return { startedAt: iso(startedAt), lastVerifiedAt: lastVerifiedAt === null ? null : iso(lastVerifiedAt), refusals };
}

router.post('/', async (req, res) => {
  if (!billing.stripeWebhookConfigured() || !billing.stripeConfigured()) {
    noteRefusal('not_configured');
    return res.status(503).json({ error: 'Webhook not configured' });
  }
  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string') {
    noteRefusal('no_signature');
    return res.status(400).json({ error: 'Missing signature' });
  }
  // server.js gives this path a parser that keeps the bytes Stripe signed. A
  // body that is not JSON never reaches that parser, and is a plain refusal:
  // Stripe only ever sends JSON. A JSON body WITHOUT its bytes means the parser
  // row is gone, which fails every real delivery, so it is a 500 that the
  // fault counter and the server-error alert both see, and Stripe retries. No
  // outsider can cause one while server.js is right.
  if (!Buffer.isBuffer(req.rawBody)) {
    if (req.is('application/json')) {
      noteRefusal('no_raw_body');
      return res.status(500).json({ error: 'Webhook failed' });
    }
    noteRefusal('no_signature');
    return res.status(400).json({ error: 'Missing signature' });
  }
  let event;
  try {
    event = billing.constructWebhookEvent(req.rawBody, signature);
  } catch (err) {
    noteRefusal(looksLikeStripe(signature) ? 'bad_signature' : 'junk_signature');
    return res.status(400).json({ error: 'Invalid signature' });
  }
  noteVerified();

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

  // A REFUND names a charge too, and carries no venue metadata, so it never
  // reached the venue branch below and was acknowledged as ignored: a Roost
  // subscription refunded in full kept its year. services/venueBilling.js
  // revokeRefundedSubscription decides from Stripe's own record whether the
  // refund was full, which subscription it paid for and whether that is the
  // period being paid for now. A Pro refund comes back ignored from there,
  // because RevenueCat reads Stripe's refunds itself.
  if (REFUND_EVENTS.has(event.type)) {
    try {
      const result = await venueBilling.revokeRefundedSubscription(eventObject);
      return res.json({ received: true, ...(result && result.ignored ? { ignored: result.ignored } : {}) });
    } catch (err) {
      console.error(`[stripe-webhook] ${event.type} failed:`, err?.message || err);
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
    // The buyer's record of what they agreed to (services/proAcknowledgment.js).
    // After the Pro write and never able to undo it: a mail failure is logged,
    // and the buyer's return to the app tries again.
    if (event.type === 'checkout.session.completed') {
      await acknowledgePurchase(userId, obj).catch((err) => {
        console.warn('[stripe-webhook] purchase acknowledgment failed:', err?.message || err);
      });
    }
    if (refreshRefused) throw new Error('RevenueCat did not accept the refreshed receipt');
    res.json({ received: true });
  } catch (err) {
    console.error(`[stripe-webhook] ${event.type} failed:`, err?.message || err);
    res.status(500).json({ error: 'Webhook failed' });
  }
});

// ---------------------------------------------------------------------------
// SAID AT BOOT TOO
// ---------------------------------------------------------------------------
// A refusal line needs a delivery to refuse. A production process whose Stripe
// variables can only ever refuse says so once when it starts, the way
// routes/emailWebhook.js names a missing Resend secret. A process with neither
// variable is the dormant state and says nothing.
// The words live in services/proBilling.js, which the money hub's setup step
// reads too.
function setupProblems() {
  return billing.stripeWebhookSetupProblems();
}

if (process.env.NODE_ENV === 'production') {
  for (const problem of setupProblems()) console.error(`[stripe-webhook] ${problem}`);
}

module.exports = router;
module.exports.__test = {
  accountFrom,
  looksLikeStripe,
  noteRefusal,
  noteVerified,
  refusalStatus,
  resetRefusals,
  setupProblems,
  REFUSAL_LINE_EVERY_MS,
};
