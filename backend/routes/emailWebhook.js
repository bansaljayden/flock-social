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
// they name, including a password reset. So a missing or malformed
// RESEND_WEBHOOK_SECRET answers 503 and refuses loudly, the same posture
// routes/revenuecat.js takes with its own shared secret.
// ---------------------------------------------------------------------------
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { suppress } = require('../services/emailSuppression');
const { maskAddress } = require('../services/emailService');

// A Resend signing secret is `whsec_` followed by the standard base64 of 24
// random bytes, and Svix issues none shorter. The HMAC key is those bytes, so
// the value is judged by what it decodes to, not by how many characters it
// has. Counting characters let junk through, because Buffer.from(_, 'base64')
// never throws: it skips any character outside the alphabet, reads the
// base64url one as well, and stops at the first '='. A quoted paste, an
// upper-case or doubled prefix, or a pasted NAME=value line decoded to some
// other key with no warning, so every genuine event then failed its signature,
// and 24 characters of typed junk could decode to a key of a byte or two that
// anybody could forge against. Resend's own SDK reads the secret with a strict
// decoder that throws on all of those, and this refuses them.
const MIN_SECRET_BYTES = 24;
// Standard base64, padded or not, which is what that decoder takes: its
// alphabet, then at most two '=' and only at the end.
const STANDARD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// A generated 24-byte key has about 23 different byte values, and the chance
// it has fewer than 12 is about 1 in 400 trillion. A placeholder that happens
// to be valid base64 ('A' or 'x' typed 32 times, 'changeme' four times) has a
// handful. A guessable value that does not repeat itself still gets past this:
// nothing about its format tells it apart from a real one.
const MIN_DISTINCT_SECRET_BYTES = 12;
const SECRET_NOT_SET = 'is not set';
// Svix's own recommendation. Five minutes bounds a replay without breaking a
// webhook that queued behind a slow deploy.
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

// What RESEND_WEBHOOK_SECRET holds: { key } when it is a usable signing secret,
// otherwise { key: null, problem } saying what is wrong with it. A value that
// is set but unusable gets its own words, because "is not set" sent the reader
// looking for a variable that was sitting right there.
function webhookSecret() {
  const raw = process.env.RESEND_WEBHOOK_SECRET;
  // Whitespace is never key material, and Node's decoder always skipped it, so
  // removing it cannot change a key that works today. A trailing newline from
  // a paste is the usual one.
  const compact = typeof raw === 'string' ? raw.replace(/\s+/g, '') : '';
  if (!compact) return { key: null, problem: SECRET_NOT_SET };
  // Quotes around the value and a full stop after it, the two marks a value
  // pasted out of a message or a .env file most often carries. Neither is ever
  // key material, the old reader decoded both to the right key (Node's decoder
  // skips them), and production may hold either, so they are taken off rather
  // than refused. The URL-safe alphabet is not: converting it would also turn
  // a doubled or upper-case prefix into a wrong key that decodes.
  const unwrapped = compact.replace(/^(['"])(.+)\1$/, '$2').replace(/\.+$/, '');
  const value = unwrapped.startsWith('whsec_') ? unwrapped.slice('whsec_'.length) : unwrapped;
  // Padding only ever completes a group of four characters, and one character
  // left over after the last full group encodes nothing, so a value showing
  // either has been damaged on its way here.
  const fitsGroups = value.endsWith('=') ? value.length % 4 === 0 : value.length % 4 !== 1;
  if (!STANDARD_BASE64.test(value) || !fitsGroups) {
    return {
      key: null,
      problem: 'is set but is not whsec_ followed by standard base64 (an upper-case or doubled prefix, the '
        + 'URL-safe alphabet, or a pasted NAME=value line all look like this)',
    };
  }
  const key = Buffer.from(value, 'base64');
  if (key.length < MIN_SECRET_BYTES) {
    return {
      key: null,
      problem: `is set but decodes to ${key.length} byte${key.length === 1 ? '' : 's'}, `
        + `and a Resend signing secret is at least ${MIN_SECRET_BYTES}`,
    };
  }
  if (new Set(key).size < MIN_DISTINCT_SECRET_BYTES) {
    return {
      key: null,
      problem: 'is set but repeats a short pattern, which is a typed placeholder and not a generated secret',
    };
  }
  return { key, problem: null };
}

// An unusable value is named once per process: at boot in production (the end
// of this file), otherwise on the first event it refuses. Each refused event
// still logs its own line in the route.
let warnedAboutSecret = false;
function warnAboutUnusableSecret(problem) {
  if (warnedAboutSecret) return;
  warnedAboutSecret = true;
  console.error(
    `🛡️ EMAIL: RESEND_WEBHOOK_SECRET ${problem}, so POST /api/email-events refuses every delivery event and no `
    + 'hard bounce or spam complaint will ever be recorded. Copy the value out of the Resend dashboard webhook '
    + 'page exactly as shown, whsec_ included, with no quotes around it.'
  );
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
  const { key, problem } = webhookSecret();
  if (!key) {
    if (problem !== SECRET_NOT_SET) warnAboutUnusableSecret(problem);
    console.error(
      `[emailWebhook] RESEND_WEBHOOK_SECRET ${problem === SECRET_NOT_SET ? problem : 'is set but is not a usable signing secret'}, `
      + 'so this delivery event was refused and no bounce was recorded.'
    );
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

  // Resend only ever posts application/json, and that is the only type the
  // raw-body parser in server.js reads. A request of any other type, or with no
  // body at all, never reached that parser, so its missing raw bytes are the
  // caller's doing and not a mount bug. It is refused as a client error, which
  // utils/serverFault.js does not count. It used to fall through to the 500
  // below, so ten unsigned text/plain requests carrying made-up svix headers
  // were ten counted server faults: enough to send the day's one server_errors
  // alert, blaming a mount bug that did not exist. req.is() reads the
  // Content-Type with the same check body-parser uses to decide whether to
  // parse, and answers null when there is no body, so this holds even with no
  // parser in front of the route at all.
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Expected an application/json body' });
  }

  // A JSON body with no raw bytes beside it is the mount bug: server.js has put
  // this route behind a parser that does not keep them, or behind none. Every
  // genuine event fails the same way, so it is a 500 and a log line, and
  // verifying against a re-serialised object instead would be verifying
  // something Resend never signed.
  const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : null;
  if (rawBody === null) {
    console.error('[emailWebhook] a JSON request arrived with no raw body. The route is mounted without its raw-body parser in server.js.');
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

    // 200 IS THE ANSWER THAT STOPS RESEND RETRYING, so it may only be given
    // once the row is actually written. `ok === false` took no branch: a hard
    // bounce arriving during a database blip was acknowledged as handled, never
    // redelivered, and the dead address stayed mailable for good. That is the
    // one failure this endpoint exists to prevent. A 500 asks for the event
    // again, which is exactly what we want, and a duplicate suppression is a
    // no-op. routes/unsubscribe.js already refuses to answer success on a
    // failed write for the same reason.
    let allWritten = true;
    for (const address of recipientsOf(data)) {
      const ok = await suppress(address, reason, detail);
      if (ok) {
        console.warn(`[emailWebhook] ${reason} recorded for ${maskAddress(address)}; Flock will not mail it again.`);
      } else {
        allWritten = false;
        console.error(`[emailWebhook] could not record ${reason} for ${maskAddress(address)}; asking for redelivery.`);
      }
    }
    if (!allWritten) return res.status(500).json({ error: 'Could not record the suppression' });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[emailWebhook] event handling failed:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// SAY IT AT BOOT, NOT ON AN EVENT THAT WILL NEVER ARRIVE.
// ---------------------------------------------------------------------------
// Every warning in this file is written on the request path, which assumes a
// request. The state worth hearing about is the opposite one: the webhook was
// never created in the Resend dashboard, or the secret was never copied into
// the deployment. In that state nothing ever POSTs here, no line is ever
// logged, and the entire bounce and complaint half of the email system is
// inert. email_suppressions stays empty, dead mailboxes are re-mailed forever,
// and the only visible consequence arrives months later as everybody else's
// password reset landing in spam.
//
// So the absence is named once, at require time, in production only, where it
// is a gap rather than the ordinary local state. A value that is set but
// unusable is named here too, with what is wrong with it, and not as missing.
if (process.env.NODE_ENV === 'production') {
  const { key, problem } = webhookSecret();
  if (!key && problem === SECRET_NOT_SET) {
    console.error(
      '🛡️ EMAIL: RESEND_WEBHOOK_SECRET is not set, so POST /api/email-events refuses every delivery event. '
      + 'No hard bounce and no spam complaint will ever be recorded, email_suppressions stays empty, and Flock keeps '
      + 'mailing addresses that no longer exist. Create the webhook in the Resend dashboard, point it at '
      + '/api/email-events, subscribe it to email.bounced and email.complained, and copy its whsec_ secret here.'
    );
  } else if (!key) {
    warnAboutUnusableSecret(problem);
  }
}

module.exports = router;
module.exports.__testing = { signatureMatches, isPermanentBounce, recipientsOf, timestampFresh, webhookSecret };
