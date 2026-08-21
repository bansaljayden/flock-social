// ---------------------------------------------------------------------------
// Resend's delivery webhook. The only thing that can tell Flock an address is
// dead.
// ---------------------------------------------------------------------------
// Before this route existed, `sent: true` was the end of the story. Resend
// accepts a message, answers 200, and then discovers minutes later that the
// mailbox does not exist. Nothing in this codebase ever heard about that, so
// the Monday digest kept mailing the same dead address every week forever, each
// send charged and each hard bounce spent against flockcorp.com's reputation
// with the receiving providers. Reputation is shared across the domain, so the
// cost of ignoring bounces on a weekly marketing digest is eventually paid by
// the password-reset mail landing in everybody else's spam folder.
//
// WHAT IT DOES: turns `email.bounced` and `email.complained` into rows in
// email_suppressions, which services/emailService.js consults before every
// send. Nothing else. It does not write to users, it does not delete anything,
// and it cannot be used to change any state a person can see in the app.
//
// SOFT BOUNCES ARE NOT SUPPRESSED. A full mailbox or a greylisting server is a
// temporary condition, and suppressing on one would permanently stop mail to a
// real person over one bad afternoon. Only a hard bounce (Resend's
// `bounce.type: 'Permanent'`) and an explicit spam complaint suppress.
//
// AUTH: Svix signatures, which is what Resend signs webhooks with. The scheme
// is an HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${raw body}`, keyed on
// the base64 half of a `whsec_...` secret, compared in constant time, with the
// timestamp bounded so a captured request cannot be replayed a week later.
// Verified against the RAW BYTES, which is why server.js gives this path its
// own parser: a signature checked against a re-serialised object is a signature
// checked against something the sender never signed.
//
// NO SECRET, NO ROUTE. An unauthenticated version of this endpoint is a way for
// anyone on the internet to permanently stop Flock from mailing any address
// they name, including a password reset. So a missing or short
// RESEND_WEBHOOK_SECRET answers 503 and refuses loudly, the same posture
// routes/revenuecat.js takes with its own shared secret.
// ---------------------------------------------------------------------------
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { suppress } = require('../services/emailSuppression');
const { maskAddress } = require('../services/emailService');

// A Svix secret is `whsec_` + base64 of 24 random bytes. Anything materially
// shorter is a placeholder somebody typed, not a secret.
const MIN_SECRET_LENGTH = 24;
// Svix's own recommendation. Five minutes bounds a replay without breaking a
// webhook that queued behind a slow deploy.
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

let warnedAboutSecret = false;
function webhookSecret() {
  const raw = process.env.RESEND_WEBHOOK_SECRET;
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/^whsec_/, '');
  if (value.length < MIN_SECRET_LENGTH) {
    if (value.length && !warnedAboutSecret) {
      warnedAboutSecret = true;
      console.error(
        `[emailWebhook] RESEND_WEBHOOK_SECRET is only ${value.length} characters after the whsec_ prefix. ` +
        'That is not a Svix signing secret, so every delivery event will be refused and no bounce will ever be recorded. ' +
        'Copy the value out of the Resend dashboard webhook page.'
      );
    }
    return null;
  }
  try {
    const key = Buffer.from(value, 'base64');
    return key.length ? key : null;
  } catch {
    return null;
  }
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Returns true when at least one signature in the header matches. The header
// carries a space-separated list of `v1,<base64>` so a secret rotation can
// double-sign; the whole list is walked rather than only the first.
function signatureMatches(header, key, id, timestamp, rawBody) {
  if (typeof header !== 'string' || !header.trim()) return false;
  const expected = crypto
    .createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');
  for (const part of header.trim().split(/\s+/)) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    if (timingSafeEqualStr(value, expected)) return true;
  }
  return false;
}

function timestampFresh(timestamp, nowSeconds) {
  const t = Number(timestamp);
  if (!Number.isFinite(t)) return false;
  return Math.abs(nowSeconds - t) <= TIMESTAMP_TOLERANCE_SECONDS;
}

// A permanent failure is the only bounce worth remembering. Resend reports the
// class on `data.bounce.type`; older payloads have carried it as a bare string,
// so both shapes are read and anything unrecognised is treated as SOFT. The
// safe default here is "keep mailing", because the cost of a wrong permanent
// suppression is a person who can never receive a password reset again.
function isPermanentBounce(data) {
  const bounce = data && data.bounce;
  const type = typeof bounce === 'string' ? bounce : (bounce && bounce.type);
  return typeof type === 'string' && type.toLowerCase() === 'permanent';
}

// `to` is an array on Resend's payloads. Every address on a bounced message
// bounced, so every one of them is suppressed.
function recipientsOf(data) {
  if (!data) return [];
  const raw = Array.isArray(data.to) ? data.to : [data.to];
  return raw.filter((a) => typeof a === 'string' && a.includes('@'));
}

router.post('/', async (req, res) => {
  const key = webhookSecret();
  if (!key) {
    console.error('[emailWebhook] RESEND_WEBHOOK_SECRET is not set, so this delivery event was refused and no bounce was recorded.');
    return res.status(503).json({ error: 'Webhook not configured' });
  }

  const id = req.get('svix-id');
  const timestamp = req.get('svix-timestamp');
  const signature = req.get('svix-signature');
  if (!id || !timestamp || !signature) {
    return res.status(400).json({ error: 'Missing signature headers' });
  }
  if (!timestampFresh(timestamp, Math.floor(Date.now() / 1000))) {
    return res.status(400).json({ error: 'Stale signature' });
  }

  // server.js hands this route a parser that keeps the bytes. No raw body means
  // the mount is wrong, and verifying against a re-serialised object would be
  // verifying against something Resend never signed, so this refuses instead.
  const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : null;
  if (rawBody === null) {
    console.error('[emailWebhook] no raw body on the request. The route is mounted without its raw-body parser in server.js.');
    return res.status(500).json({ error: 'Server error' });
  }
  if (!signatureMatches(signature, key, id, timestamp, rawBody)) {
    console.warn('[emailWebhook] signature did not verify; event ignored.');
    return res.status(401).json({ error: 'Bad signature' });
  }

  try {
    const event = req.body && typeof req.body === 'object' ? req.body : {};
    const type = typeof event.type === 'string' ? event.type : '';
    const data = event.data && typeof event.data === 'object' ? event.data : {};

    let reason = null;
    let detail = null;
    if (type === 'email.complained') {
      reason = 'complaint';
      detail = 'spam complaint';
    } else if (type === 'email.bounced' && isPermanentBounce(data)) {
      reason = 'bounce';
      const bounce = data.bounce;
      detail = bounce && typeof bounce.subType === 'string' ? `permanent bounce: ${bounce.subType}` : 'permanent bounce';
    }

    // Everything else (delivered, opened, soft bounce, delivery_delayed) is
    // acknowledged and dropped. Answering 200 is what stops Resend retrying an
    // event this route has no opinion about.
    if (!reason) return res.status(200).json({ ok: true });

    for (const address of recipientsOf(data)) {
      const ok = await suppress(address, reason, detail);
      if (ok) console.warn(`[emailWebhook] ${reason} recorded for ${maskAddress(address)}; Flock will not mail it again.`);
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[emailWebhook] event handling failed:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.__testing = { signatureMatches, isPermanentBounce, recipientsOf, timestampFresh, webhookSecret };
