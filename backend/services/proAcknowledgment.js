'use strict';
// ---------------------------------------------------------------------------
// THE PURCHASE ACKNOWLEDGMENT: one email per completed web checkout of Flock
// Pro, the record California's automatic renewal law asks a buyer to be given
// (what renews, at what price, how to cancel, the refund window). Stripe's
// receipt covers what was paid and nothing about stopping, so this is Flock's.
//
// Two chances, one email. The signed Stripe webhook sends it
// (routes/stripeWebhook.js), and the buyer's return to the app
// (POST /api/pro/confirm) tries again if that send did not go through.
//
// THE ROW IS CLAIMED BEFORE THE SEND (backend audit 2026-10-03). It used to be
// written only after the provider accepted the message, and both paths checked
// for it first, so the two running together (the buyer lands back in the app a
// second or two after Stripe calls the webhook, which is the ordinary case)
// both found nothing and both sent. Now a path claims the session's row in
// pro_purchase_acknowledgments (migration 078) with emailed_at = -infinity,
// sends only if the claim was its own, stamps emailed_at on success, and
// deletes the claim on any failure so the other path can still try. A claim
// whose sender died between the two (the process restarted mid-send) is taken
// over once it is CLAIM_STALE_MINUTES old, so it cannot hold the email back
// for good. No lock is held across the send: the provider call has no timeout
// of its own, and a stuck one must not hold a pool connection with it.
//
// NEVER IN THE WAY OF THE PURCHASE. Both callers catch everything this throws:
// a mail outage must not turn a paid checkout into a failed webhook or a
// failed confirm, because either would read to the buyer as not getting Pro.
//
// TRANSACTIONAL. It is about the buyer's own purchase, so an unsubscribe from
// marketing mail does not stop it; a bounce or a spam complaint does, inside
// sendEmail, like every other message (services/emailSuppression.js).
// ---------------------------------------------------------------------------

const pool = require('../config/database');
// Held as the module, not destructured, so a test can stand in for the send.
const emailService = require('./emailService');
const billing = require('./proBilling');
const { proPurchaseSubject, renderProPurchaseText, renderProPurchaseHtml } = require('../templates/proPurchaseEmail');

const SESSION_RE = /^cs_[A-Za-z0-9_]+$/;

const CLAIM_STALE_MINUTES = 5;

// Sent, or being sent right now by the other path. A stale claim is neither.
async function alreadyAcknowledged(sessionId) {
  const r = await pool.query(
    `SELECT 1 FROM pro_purchase_acknowledgments
      WHERE session_id = $1::text
        AND (emailed_at > '-infinity'::timestamptz
             OR created_at >= NOW() - make_interval(mins => $2::int))`,
    [sessionId, CLAIM_STALE_MINUTES]
  );
  return !!(r && Array.isArray(r.rows) && r.rows.length);
}

// True when this call now holds the session's claim: a fresh row, or a stale
// claim taken over. False when the email went out already or the other path
// is sending it.
async function claim(sessionId, userId) {
  const r = await pool.query(
    `INSERT INTO pro_purchase_acknowledgments (session_id, user_id, emailed_at)
     VALUES ($1::text, $2::int, '-infinity'::timestamptz)
     ON CONFLICT (session_id) DO UPDATE SET created_at = NOW()
       WHERE pro_purchase_acknowledgments.emailed_at = '-infinity'::timestamptz
         AND pro_purchase_acknowledgments.created_at < NOW() - make_interval(mins => $3::int)`,
    [sessionId, userId, CLAIM_STALE_MINUTES]
  );
  return !!(r && r.rowCount === 1);
}

function release(sessionId) {
  return pool.query(
    `DELETE FROM pro_purchase_acknowledgments
      WHERE session_id = $1::text AND emailed_at = '-infinity'::timestamptz`,
    [sessionId]
  ).catch((err) => console.warn('[pro] could not release the acknowledgment claim:', err.message));
}

// -> { sent: true } | { sent: false } | { skipped: reason }
async function acknowledgePurchase(userId, session) {
  const sessionId = session && typeof session.id === 'string' ? session.id : '';
  if (!SESSION_RE.test(sessionId)) return { skipped: 'no_session' };
  if (session.status && session.status !== 'complete') return { skipped: 'not_complete' };
  if (session.mode && session.mode !== 'subscription') return { skipped: 'not_subscription' };
  if (await alreadyAcknowledged(sessionId)) return { skipped: 'already' };
  if (!(await claim(sessionId, userId))) return { skipped: 'already' };

  let sent = false;
  try {
    const out = await sendAcknowledgment(userId, session);
    sent = !!(out && out.sent);
    return out;
  } finally {
    if (!sent) await release(sessionId);
  }
}

async function sendAcknowledgment(userId, session) {
  const sessionId = session.id;
  const u = await pool.query('SELECT name, email FROM users WHERE id = $1::int', [userId]);
  const user = u && Array.isArray(u.rows) ? u.rows[0] : null;
  if (!user) return { skipped: 'no_account' };
  // The address Stripe collected is the payer's, which is a parent when a
  // parent paid; the account's own address is the fallback.
  const payer = session.customer_details && session.customer_details.email;
  const to = emailService.isMailableAddress(payer) ? payer : user.email;
  if (!emailService.isMailableAddress(to)) return { skipped: 'unmailable' };

  const plan = session.metadata && session.metadata.plan === 'yearly' ? 'yearly' : 'monthly';
  const priceId = billing.planPrices()[plan];
  if (!priceId) return { skipped: 'no_price' };
  const price = await billing.describePrice(priceId);
  const paidToday = Number.isFinite(session.amount_total)
    ? billing.formatAmount({ unitAmount: session.amount_total, currency: String(session.currency || price.currency).toUpperCase() })
    : null;
  const input = {
    name: user.name,
    plan,
    amount: billing.formatAmount(price),
    every: price.interval === 'year' ? 'year' : 'month',
    tax: billing.taxEnabled(),
    paidToday,
  };

  const result = await emailService.sendEmail({
    to,
    subject: proPurchaseSubject(input),
    html: renderProPurchaseHtml(input),
    text: renderProPurchaseText(input),
    category: 'transactional',
  });
  if (!result || !result.sent) {
    console.warn('[pro] purchase acknowledgment not sent to', emailService.maskAddress(to), result && (result.reason || result.error || (result.skipped ? 'skipped' : '')));
    return { sent: false };
  }
  await pool.query(
    'UPDATE pro_purchase_acknowledgments SET emailed_at = NOW() WHERE session_id = $1::text',
    [sessionId]
  );
  return { sent: true };
}

module.exports = { acknowledgePurchase };
