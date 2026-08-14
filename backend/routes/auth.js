const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { body, validationResult } = require('express-validator');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../config/database');
// signUserToken is the ONLY way tokens are minted (round 13): it stamps the
// user's token_version into the JWT so a bump revokes every outstanding token.
const { authenticate, signUserToken, revokeUserSessions } = require('../middleware/auth');
const {
  sendVerificationEmail, verificationLink, baseWebUrl,
  sendPasswordResetEmail, sendPasswordResetOAuthEmail, passwordResetLink,
} = require('../services/emailService');
const { stripHtml, sanitizeArray } = require('../utils/sanitize');
const { rejectIfProfane, moderateText } = require('../utils/moderation');
const { upstreamSignal } = require('../utils/upstream');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Apple Sign In — pull rotating public keys from Apple's JWKS endpoint
// to verify identity tokens. Cached for 24h per RFC.
const appleJwksClient = jwksClient({
  jwksUri: 'https://appleid.apple.com/auth/keys',
  cache: true,
  cacheMaxAge: 24 * 60 * 60 * 1000,
  rateLimit: true,
});

function appleGetSigningKey(header, callback) {
  appleJwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

const router = express.Router();

const SALT_ROUNDS = 10;

// Timing equaliser for /login. A real bcrypt hash at the same cost factor, so
// comparing against it costs exactly what comparing against a user's hash does.
// Computed once at load (~100ms of boot), never at request time.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('flock-login-timing-equalizer', SALT_ROUNDS);

// ---------------------------------------------------------------------------
// Email identity (round 15)
// ---------------------------------------------------------------------------
// Signup and login run express-validator's normalizeEmail(), which for Gmail
// strips dots and +subaddresses. OAuth addresses are NOT normalized — we store
// the provider's address verbatim, because that is the mailbox we actually
// send to. So the two sides of every "does this email already exist?" check
// were written in different alphabets, and `LOWER(email) = LOWER($1)` could
// not see across the gap:
//
//   * SHADOW ACCOUNT. Victim signs in with Google as `john.doe@gmail.com`
//     (stored with dots). Attacker then signs up with a password as
//     `johndoe@gmail.com`; normalizeEmail leaves it alone, LOWER() finds no
//     match, the users.email UNIQUE index sees a different string, and a
//     SECOND row now owns the victim's real mailbox. Friend discovery and
//     invites by email resolve to the attacker's row, and every Flock mail for
//     that account lands in the victim's inbox for an account they don't
//     control.
//   * SQUAT CLAIM MISS. The round-8 anti-squat claim only fires when the
//     OAuth address matches a password row. Attacker squats
//     `john.doe@gmail.com`, which normalizeEmail STORES as `johndoe@gmail.com`;
//     the victim's Google sign-in then looks up `john.doe@gmail.com`, misses,
//     and silently creates a second account instead of reclaiming the squat.
//
// canonicalEmail() is the one alphabet both sides are compared in. It mirrors
// normalizeEmail()'s Gmail defaults and normalizedAddress() in routes/users.js.
// Addresses are still STORED verbatim; only comparison is canonical.
function canonicalEmail(addr) {
  if (typeof addr !== 'string') return '';
  const trimmed = addr.trim();
  const at = trimmed.lastIndexOf('@');
  if (at < 1) return trimmed.toLowerCase();
  let local = trimmed.slice(0, at).toLowerCase();
  let domain = trimmed.slice(at + 1).toLowerCase();
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replace(/\./g, '');
  return `${local}@${domain}`;
}

// The SQL half of canonicalEmail(), applied to the STORED column so a raw
// OAuth address is compared in the same alphabet as the submitted one. $1 is
// the address as given, $2 is canonicalEmail($1). The exact match is kept as
// the first branch (and ordered first) so an address that exists verbatim
// always wins over a canonical twin.
// The canonical form of the STORED column, as one SQL expression. Factored out
// (round 18) because routes/users.js needs the same expression for the email
// uniqueness check on PUT /profile and was using a plain LOWER() match, which is
// the exact gap this alphabet exists to close — two copies of it would drift,
// and the drift would silently reopen the shadow-account hole above.
const EMAIL_CANONICAL_SQL = `(CASE
            WHEN split_part(LOWER(email), '@', 2) IN ('gmail.com', 'googlemail.com')
              THEN regexp_replace(split_part(split_part(LOWER(email), '@', 1), '+', 1), '\\.', '', 'g') || '@gmail.com'
            ELSE LOWER(email)
          END)`;

const EMAIL_MATCH_SQL = `
      LOWER(email) = LOWER($1)
      OR ${EMAIL_CANONICAL_SQL} = $2`;

// Find the account that owns a mailbox, dot/subaddress variants included.
async function findUserByEmail(email) {
  const result = await pool.query(
    `SELECT * FROM users
      WHERE ${EMAIL_MATCH_SQL}
      ORDER BY (LOWER(email) = LOWER($1)) DESC, id ASC
      LIMIT 1`,
    [email, canonicalEmail(email)]
  );
  return result.rows[0] || null;
}

// ---------------------------------------------------------------------------
// Email verification (round 16)
// ---------------------------------------------------------------------------
// THE ATTACK. Password signup never proved the person could read the mailbox
// they typed. So an attacker pre-registered a victim's address, set their own
// Venmo / Cash App / Zelle handles on it and seeded friendships from it. When
// the victim later signed in with Google or Apple, the round-8 anti-squat claim
// welded the victim's identity onto that row and cleared its password. The
// victim woke up inside the attacker's account: the attacker's payment handles
// were now theirs, the attacker was already an accepted friend, and every bill
// split from that point on paid the attacker.
//
// This is not fixable in the claim. "A squatter pre-registered your address"
// and "I had a password, now I use Google" are byte-for-byte the same request.
// The only bit that separates them is whether the password row ever proved it
// owns the mailbox, and nothing recorded that. Now something does.
//
// TOKEN SHAPE. `selector.verifier`. The selector is a 128-bit public lookup
// key; the verifier is a 256-bit secret whose SHA-256 is what we store. Two
// reasons for the split rather than one opaque token:
//   * nothing that can log in is ever written to the database, so a leaked
//     backup (or scripts/dump-db.js) does not contain usable links;
//   * lookup is by selector, so the secret half can be compared with
//     crypto.timingSafeEqual instead of by a database string match. That is
//     what "constant-time compared" means here, and it is why the token is not
//     simply looked up by its own hash.
//
// Links are single-use (`used_at`, set by a guarded UPDATE so two clicks race
// safely), expiring (24h), and pointed at the pinned production API URL by
// services/emailService.js — never at localhost and never at anything derived
// from the request's Host header.
const VERIFICATION_TTL_HOURS = 24;

// Resend budget. Per ACCOUNT so one account cannot be used to bomb one mailbox,
// and per IP so one attacker cannot bomb many mailboxes (or simply burn the
// day's Resend quota, which would take the SOS alert mail down with it). Both
// counted in the database rather than in memory: an in-memory counter resets on
// every Railway redeploy, and outbound mail budget is exactly the thing worth
// re-triggering a deploy to reset.
const RESEND_MIN_GAP_MS = 60 * 1000;
const RESEND_MAX_PER_HOUR_ACCOUNT = 5;
const RESEND_MAX_PER_DAY_ACCOUNT = 10;
// The per-IP number is deliberately loose. Flock's users are 15-22 and sign up
// on school and campus wifi, where a whole friend group shares one public
// address; a tight cap there would silently stop sending verification mail to
// real people and leave them stuck on an unverified account with no way out.
// 30/hour still bounds a mail-bombing run hard, and the per-ACCOUNT caps above
// are what stop one mailbox being buried.
const RESEND_MAX_PER_HOUR_IP = 30;

// A `.invalid` address is the deterministic placeholder the Apple path stores
// when Apple omits the email (see /apple below). It can never receive mail, so
// nothing may try to send to it.
function isMailableAddress(addr) {
  return typeof addr === 'string' && /@/.test(addr) && !/\.invalid$/i.test(addr.trim());
}

function mintVerificationToken() {
  const selector = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  return {
    selector,
    verifier,
    verifierHash: crypto.createHash('sha256').update(verifier).digest('hex'),
    token: `${selector}.${verifier}`,
  };
}

// Strict shape check before the token touches the database. The selector is a
// fixed-width hex string, so anything else is rejected without a query.
function parseVerificationToken(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t.length < 40 || t.length > 200) return null;
  if (t[32] !== '.') return null;
  const selector = t.slice(0, 32);
  const verifier = t.slice(33);
  if (!/^[0-9a-f]{32}$/.test(selector)) return null;
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(verifier)) return null;
  return { selector, verifier };
}

// Constant-time comparison of the secret half. Both sides are fixed-width hex
// digests, so a length mismatch means the stored value is corrupt rather than
// attacker-influenced; it still burns an equal-cost comparison so the failure
// is not measurably faster than a real mismatch.
function verifierMatches(verifier, storedHash) {
  const actual = Buffer.from(crypto.createHash('sha256').update(String(verifier)).digest('hex'), 'utf8');
  const expected = Buffer.from(String(storedHash || ''), 'utf8');
  if (actual.length !== expected.length) {
    crypto.timingSafeEqual(actual, actual);
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

// Issue a link. Any older unused link for the account is retired in the same
// breath, so at most ONE live link exists per account: a token sitting in an
// old email (or in a mailbox the account has since moved away from) stops
// working the moment a new one is requested.
async function issueVerification(user, ip) {
  const { selector, verifierHash, token } = mintVerificationToken();
  await pool.query(
    'UPDATE email_verifications SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
    [user.id]
  );
  await pool.query(
    // `$6::int * INTERVAL '1 hour'` rather than make_interval(hours => $6):
    // the explicit cast leaves Postgres nothing to infer, and the TTL still
    // comes off the DATABASE clock, which is the clock the expiry guard in
    // consumeVerification compares against.
    `INSERT INTO email_verifications (user_id, selector, verifier_hash, email, request_ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6::int * INTERVAL '1 hour'))`,
    [user.id, selector, verifierHash, user.email, ip || null, VERIFICATION_TTL_HOURS]
  );
  return token;
}

async function sendVerification(user, ip) {
  if (!isMailableAddress(user.email)) {
    return { sent: false, skipped: true, reason: 'unreachable-address' };
  }
  const token = await issueVerification(user, ip);
  const link = verificationLink(token);
  const result = await sendVerificationEmail({
    to: user.email,
    name: user.name,
    link,
    hours: VERIFICATION_TTL_HOURS,
  });
  // Local development has no Resend key, so without this there is no way to
  // finish a signup on a laptop. Deliberately gated on BOTH "mail could not be
  // sent at all" and "not production" so a live server can never print a
  // working link into its logs.
  if (result.skipped && process.env.NODE_ENV !== 'production') {
    console.log(`[auth] verification link for ${user.email}: ${link}`);
  }
  return result;
}

async function verificationSendBudget(userId, ip) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour')::int AS account_hour,
       COUNT(*) FILTER (WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 day')::int  AS account_day,
       MAX(created_at) FILTER (WHERE user_id = $1) AS account_last,
       COUNT(*) FILTER (WHERE request_ip = $2 AND created_at > NOW() - INTERVAL '1 hour')::int AS ip_hour
     FROM email_verifications
     WHERE user_id = $1 OR (request_ip = $2 AND created_at > NOW() - INTERVAL '1 hour')`,
    [userId, ip || null]
  );
  const row = rows[0] || {};
  return {
    accountHour: Number(row.account_hour) || 0,
    accountDay: Number(row.account_day) || 0,
    accountLast: row.account_last ? new Date(row.account_last).getTime() : 0,
    ipHour: Number(row.ip_hour) || 0,
  };
}

// Consume a link. Every failure returns the same shape and the caller maps all
// of them onto one generic answer, so the endpoint cannot be used to probe
// which selectors exist.
async function consumeVerification(rawToken) {
  const parsed = parseVerificationToken(rawToken);
  if (!parsed) return { ok: false, reason: 'invalid' };

  const { rows } = await pool.query(
    `SELECT v.id, v.user_id, v.verifier_hash, v.email, v.used_at, v.expires_at,
            u.email AS current_email, u.email_verified
       FROM email_verifications v
       JOIN users u ON u.id = v.user_id
      WHERE v.selector = $1`,
    [parsed.selector]
  );
  const row = rows[0];
  if (!row) {
    // Equal-cost comparison against a throwaway digest: an unknown selector
    // must not answer faster than a known one.
    verifierMatches(parsed.verifier, crypto.createHash('sha256').update('absent').digest('hex'));
    return { ok: false, reason: 'invalid' };
  }
  if (!verifierMatches(parsed.verifier, row.verifier_hash)) return { ok: false, reason: 'invalid' };

  if (row.used_at) {
    // Mailbox providers prefetch links (Outlook Safe Links and friends), so the
    // scanner can spend the token seconds before the human clicks it. If the
    // account is already verified, report the state rather than an error: the
    // outcome the user wanted has happened, and nothing is re-verified here.
    return row.email_verified === true
      ? { ok: true, alreadyVerified: true, userId: row.user_id }
      : { ok: false, reason: 'used' };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  // A link proves ownership of the address it was MAILED to. If the account has
  // since changed its address, this token says nothing about the new one.
  if (canonicalEmail(row.email) !== canonicalEmail(row.current_email)) {
    return { ok: false, reason: 'stale' };
  }

  // Single-use, enforced by the database rather than by the read above: two
  // simultaneous clicks both pass the checks, and exactly one wins here.
  const claimed = await pool.query(
    'UPDATE email_verifications SET used_at = NOW() WHERE id = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING id',
    [row.id]
  );
  if (claimed.rowCount === 0) return { ok: false, reason: 'used' };

  // verified_email records WHICH address was proven. The guard re-checks the
  // address at write time so an edit that lands between the read and this
  // write cannot get itself stamped as verified.
  const updated = await pool.query(
    `UPDATE users SET email_verified = TRUE, verified_email = email, updated_at = NOW()
      WHERE id = $1 AND LOWER(email) = LOWER($2) RETURNING id`,
    [row.user_id, row.current_email]
  );
  if (updated.rowCount === 0) return { ok: false, reason: 'stale' };

  console.log(`[auth] email verified for user ${row.user_id}`);
  return { ok: true, userId: row.user_id };
}

// ---------------------------------------------------------------------------
// Password reset (round 17)
// ---------------------------------------------------------------------------
// THE HOLE. There was no way back into a password account. Forget the password
// and the account was gone: nothing in the product could set a password without
// the old one (PUT /api/users/profile requires current_password), so the only
// route back was to sign up again on a different address. For an audience that
// reinstalls phones and loses password managers, that is not an edge case.
//
// It is also the most attacked endpoint a consumer app has, because it converts
// "can read this mailbox" into "owns this account". Everything below is one of
// the four ways that conversion goes wrong:
//
//   1. ENUMERATION. The answer to "does victim@x have an account?" must be the
//      same sentence, the same status code and roughly the same wall-clock time
//      whether or not it does. Same body and status is easy and is done in the
//      route. Same TIME is the part people get wrong: awaiting Resend on the
//      "account exists" branch makes that branch measurably slower, which is a
//      working oracle no wording can fix. So the mail is dispatched WITHOUT
//      being awaited (see sendResetMailInBackground) and the response does not
//      depend on it.
//   2. TOKEN SHAPE. Same split token as email verification, on purpose: a
//      selector to look up by and a verifier whose SHA-256 is all we store, so
//      a database leak yields no usable links and the secret half is compared
//      with crypto.timingSafeEqual rather than by a SQL string match. Single
//      use via a guarded UPDATE, one hour of life (shorter than verification's
//      24, because this one hands over the account), and the link is built from
//      the pinned production URL in services/emailService.js.
//   3. BUDGET. Counted in the DATABASE and keyed on the ADDRESS, not on a user
//      id. A budget that could only count issued tokens would not count the
//      addresses with no account, which reintroduces finding 1 through the back
//      door: spray an address, see whether you get throttled, learn whether it
//      exists. password_reset_requests records every accepted request the same
//      way regardless.
//   4. BLAST RADIUS. Consuming a token bumps token_version (so every JWT the
//      account has outstanding dies), drops its live sockets, and retires every
//      other reset link it holds. A reset is what someone does when they think
//      an attacker has their password; leaving the attacker's session alive
//      through it would defeat the whole exercise.
const RESET_TTL_MINUTES = 60;
// Per ADDRESS, so one mailbox cannot be buried, and per IP, so one attacker
// cannot spray many mailboxes or burn the day's Resend quota (which the SOS
// alert path shares). The per-IP number is loose for the same reason the
// verification one is: Flock's users are on shared school and campus wifi, and
// a tight cap there locks a whole friend group out of account recovery.
const RESET_MIN_GAP_MS = 60 * 1000;
const RESET_MAX_PER_HOUR_EMAIL = 3;
const RESET_MAX_PER_DAY_EMAIL = 6;
const RESET_MAX_PER_HOUR_IP = 20;

// The one sentence this endpoint is allowed to say. It is deliberately not
// "we sent you an email", because for an address with no account we did not.
const RESET_NEUTRAL_MESSAGE = "If there's an account for that address, we sent a link. Check your inbox, and your spam folder.";

// The rate-limit bucket key. HMAC rather than the address itself: this table
// otherwise becomes a plaintext list of every address anyone typed into the
// forgot-password box, most of which belong to people who are not our users.
// Same pepper as the ban-evasion digests in routes/users.js, for the same
// reason — an unkeyed SHA-256 of an email address is reversible with a wordlist.
// Falls back to an unkeyed digest if no secret is configured at all, because a
// rate limit that silently stops bucketing is worse than one that is merely
// obfuscated; in practice JWT_SECRET is always present or nothing can mint a
// token.
function resetBucketKey(email) {
  const pepper = process.env.BAN_TOMBSTONE_SECRET || process.env.JWT_SECRET || '';
  const canonical = canonicalEmail(email);
  return pepper
    ? crypto.createHmac('sha256', pepper).update(`reset:${canonical}`).digest('hex')
    : crypto.createHash('sha256').update(`reset:${canonical}`).digest('hex');
}

async function resetRequestBudget(emailKey, ip) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE email_key = $1 AND created_at > NOW() - INTERVAL '1 hour')::int AS email_hour,
       COUNT(*) FILTER (WHERE email_key = $1 AND created_at > NOW() - INTERVAL '1 day')::int  AS email_day,
       MAX(created_at) FILTER (WHERE email_key = $1) AS email_last,
       COUNT(*) FILTER (WHERE request_ip = $2 AND created_at > NOW() - INTERVAL '1 hour')::int AS ip_hour
     FROM password_reset_requests
     WHERE (email_key = $1 AND created_at > NOW() - INTERVAL '1 day')
        OR (request_ip = $2 AND created_at > NOW() - INTERVAL '1 hour')`,
    [emailKey, ip || null]
  );
  const row = rows[0] || {};
  return {
    emailHour: Number(row.email_hour) || 0,
    emailDay: Number(row.email_day) || 0,
    emailLast: row.email_last ? new Date(row.email_last).getTime() : 0,
    ipHour: Number(row.ip_hour) || 0,
  };
}

function resetBudgetExhausted(budget) {
  return (budget.emailLast && Date.now() - budget.emailLast < RESET_MIN_GAP_MS)
    || budget.emailHour >= RESET_MAX_PER_HOUR_EMAIL
    || budget.emailDay >= RESET_MAX_PER_DAY_EMAIL
    || budget.ipHour >= RESET_MAX_PER_HOUR_IP;
}

// Recorded for every request that gets past the budget, whether or not an
// account was found. That is what makes the budget say nothing about existence.
async function recordResetRequest(emailKey, ip) {
  await pool.query(
    'INSERT INTO password_reset_requests (email_key, request_ip) VALUES ($1, $2)',
    [emailKey, ip || null]
  );
}

// The janitor. Unlike email_verifications, this table takes a row for every
// address ANYONE types into the forgot-password box, so a spray run writes rows
// for addresses that have no account and will never have one. Nothing reads
// past 24 hours, so a week is already generous. Hourly at most, per process,
// fire and forget: a failed sweep must never fail the request that triggered it.
const RESET_PURGE_INTERVAL_MS = 60 * 60 * 1000;
let lastResetPurge = 0;
function maybePurgeResetRequests() {
  const now = Date.now();
  if (now - lastResetPurge < RESET_PURGE_INTERVAL_MS) return;
  lastResetPurge = now;
  pool.query("DELETE FROM password_reset_requests WHERE created_at < NOW() - INTERVAL '7 days'")
    .catch((err) => console.error('[auth] reset request purge failed:', err.message));
}

// Issue a link, retiring any older unused one for the account in the same
// breath, so at most ONE live reset link exists per account at a time.
async function issueReset(user, ip) {
  const { selector, verifierHash, token } = mintVerificationToken();
  await pool.query(
    'UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
    [user.id]
  );
  await pool.query(
    `INSERT INTO password_resets (user_id, selector, verifier_hash, email, request_ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6::int * INTERVAL '1 minute'))`,
    [user.id, selector, verifierHash, user.email, ip || null, RESET_TTL_MINUTES]
  );
  return token;
}

// Fire-and-forget mail, with the in-flight promises tracked so tests can wait
// for them (see __testing.flushResetMail). This is finding 1's timing half: the
// response must not carry Resend's latency, because that latency only exists on
// the branch where the account does. Never throws into the request.
const pendingResetMail = new Set();
function sendResetMailInBackground(label, factory) {
  let p;
  p = Promise.resolve()
    .then(factory)
    .catch((err) => console.error(`[auth] ${label} failed:`, err.message))
    .finally(() => pendingResetMail.delete(p));
  pendingResetMail.add(p);
}

// Decide what a found account gets, and mail it. Deliberately NOT async and
// deliberately returning nothing: every branch is dispatched into the
// background, so the request that called it does no more work for an address
// that has an account than for one that does not. That is the difference
// between "the body is the same" and "the response is the same".
//
// Issuing the token is inside the background work for the same reason. It is
// two fast indexed writes, but it is also two writes that can FAIL, and a 500
// that only ever happens for real accounts is an enumeration oracle wearing a
// stack trace.
function dispatchResetMail(user, ip) {
  // A banned account gets nothing. A reset would not lift the ban (every
  // request still 403s in middleware/auth.js) so the mail would be a lie, and
  // "banned accounts can still generate Flock-branded mail on demand" is a
  // budget an abuser would happily spend.
  if (user.is_banned) {
    console.warn(`[auth] password reset requested for banned account ${user.id} — mailing nothing`);
    return;
  }
  if (!isMailableAddress(user.email)) {
    // The Apple placeholder (@apple-signin.invalid) and evicted-squat
    // tombstones (@unclaimed.invalid) can never receive mail.
    return;
  }
  // OAuth accounts have no password. Never invent one: that would bolt a
  // second, weaker credential onto an account whose owner never asked for one.
  // The mailbox owner is told which button to press instead.
  //
  // Keyed on oauth_provider ALONE, not on "provider and no password". The two
  // are equivalent today (both claim paths NULL the password when they link a
  // provider), but if they ever drift, issuing a link here would mint a token
  // that inspectReset then refuses for having a provider: a link mailed to a
  // real person that can never work. One condition, checked the same way in
  // both places.
  if (user.oauth_provider) {
    sendResetMailInBackground('password reset (oauth notice)', () => sendPasswordResetOAuthEmail({
      to: user.email,
      name: user.name,
      provider: user.oauth_provider,
    }));
    return;
  }
  if (!user.password) {
    // No password and no provider should not exist. Refuse rather than guess.
    console.warn(`[auth] password reset requested for account ${user.id} with no credential of any kind`);
    return;
  }

  sendResetMailInBackground('password reset', async () => {
    const token = await issueReset(user, ip);
    const link = passwordResetLink(token);
    const result = await sendPasswordResetEmail({
      to: user.email,
      name: user.name,
      link,
      minutes: RESET_TTL_MINUTES,
    });
    // Same local-development escape hatch as the verification path, gated on
    // both "no mail could be sent" and "not production", so a live server can
    // never print a working reset link into its logs.
    if (result.skipped && process.env.NODE_ENV !== 'production') {
      console.log(`[auth] password reset link for ${user.email}: ${link}`);
    }
    return result;
  });
}

// Read a reset token without spending it. Every failure returns the same shape;
// the route maps them onto three honest states (invalid, expired, used) and
// nothing else, so this cannot be used to probe which selectors exist.
async function inspectReset(rawToken) {
  const parsed = parseVerificationToken(rawToken);
  if (!parsed) return { ok: false, reason: 'invalid' };

  const { rows } = await pool.query(
    `SELECT r.id, r.user_id, r.verifier_hash, r.email, r.used_at, r.expires_at,
            u.email AS current_email, u.oauth_provider, u.is_banned,
            (u.password IS NOT NULL) AS has_password
       FROM password_resets r
       JOIN users u ON u.id = r.user_id
      WHERE r.selector = $1`,
    [parsed.selector]
  );
  const row = rows[0];
  if (!row) {
    // Equal-cost comparison against a throwaway digest: an unknown selector
    // must not answer faster than a known one.
    verifierMatches(parsed.verifier, crypto.createHash('sha256').update('absent').digest('hex'));
    return { ok: false, reason: 'invalid' };
  }
  if (!verifierMatches(parsed.verifier, row.verifier_hash)) return { ok: false, reason: 'invalid' };
  if (row.used_at) return { ok: false, reason: 'used' };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  // A link proves control of the address it was MAILED to. If the account has
  // moved to another address since, this token says nothing about the account.
  if (canonicalEmail(row.email) !== canonicalEmail(row.current_email)) return { ok: false, reason: 'invalid' };
  // The account became an OAuth account (or was banned) between issue and use.
  // Setting a password on an OAuth row here would be exactly the silent
  // credential injection the OAuth branch above refuses to do.
  if (row.oauth_provider || !row.has_password) return { ok: false, reason: 'invalid' };
  if (row.is_banned) return { ok: false, reason: 'invalid' };
  return { ok: true, row };
}

// Spend a reset token and set the new password.
async function consumeReset(rawToken, newPassword) {
  const found = await inspectReset(rawToken);
  if (!found.ok) return found;
  const row = found.row;

  // Single-use, enforced by the database rather than by the read above: two
  // simultaneous submissions both pass the checks, and exactly one wins here.
  const claimed = await pool.query(
    'UPDATE password_resets SET used_at = NOW() WHERE id = $1 AND used_at IS NULL AND expires_at > NOW() RETURNING id',
    [row.id]
  );
  if (claimed.rowCount === 0) return { ok: false, reason: 'used' };

  const hashed = await bcrypt.hash(newPassword, SALT_ROUNDS);

  // The guard re-checks at WRITE time what inspectReset checked at read time:
  // an account that turned into an OAuth account in the last few milliseconds
  // must not have a password welded onto it, and the address must still be the
  // one the link was mailed to. token_version + 1 kills every JWT the account
  // has outstanding, the attacker's included, which is the entire point of
  // resetting a password you think someone else knows.
  //
  // email_verified is deliberately NOT touched. A reset proves control of the
  // mailbox exactly as well as a verification link does, but treating it as
  // verification would let a reset walk around migration 011's gate: an
  // unverified squat row would become a fully verified account the moment its
  // address's real owner used the recovery flow, and inherit whatever the squat
  // had accumulated. The row stays unverified and stays unable to accumulate
  // until a genuine verification link is clicked.
  //
  // `is_banned IS NOT TRUE` closes the last gap between the read and the write:
  // inspectReset refuses a banned row, this did not, so a ban landing in the
  // milliseconds between them still completed the reset. `IS NOT TRUE` rather
  // than `= FALSE` because migration 001 added the column nullable, and a NULL
  // compared with `=` is NULL, which would refuse every legitimate reset on a
  // row that predates a backfill.
  const updated = await pool.query(
    `UPDATE users SET password = $1, token_version = token_version + 1, updated_at = NOW()
      WHERE id = $2 AND oauth_provider IS NULL AND is_banned IS NOT TRUE AND LOWER(email) = LOWER($3)
      RETURNING id`,
    [hashed, row.user_id, row.current_email]
  );
  if (updated.rowCount === 0) return { ok: false, reason: 'invalid' };

  // Any other link this account is holding dies with the one just spent. Two
  // links in two inboxes (or two copies of the same mail) must not mean two
  // shots at the account.
  await pool.query(
    'UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
    [row.user_id]
  );

  console.warn(`[auth] password reset completed for user ${row.user_id}`);
  return { ok: true, userId: row.user_id };
}

// ---------------------------------------------------------------------------
// Who may claim a squatted address (round 16)
// ---------------------------------------------------------------------------
// Three states, and only the first is the legitimate upgrade the round-8 claim
// was written for.
//
//   'claim'  the row PROVED it owns this address. This is a real person who had
//            a password and is now signing in with Google or Apple. Hand the
//            row over exactly as before.
//   'evict'  the row never proved anything. It is an address squat, so it loses
//            the ADDRESS (see releaseSquattedAddress) and keeps its own data.
//            Nothing of the squatter's is handed to the verified owner, and the
//            owner is not permanently locked out either — which is the trap
//            round 8 was avoiding when it introduced the claim.
//   'refuse' the row proved a DIFFERENT address, or proved one and has since
//            been un-verified. Neither safe to hand over nor safe to displace.
//            Refuse, log, leave both accounts intact.
//
// The mismatch case exists because users.email is editable
// (PUT /api/users/profile) while email_verified is not reset there. Without
// comparing verified_email, an attacker could verify their own mailbox, switch
// the address to a victim's, and arrive here wearing a verified badge for an
// address they never proved. See the cross-area note at the bottom of this file.
function claimDecision(existing, providerEmail) {
  // A NOT NULL column, so anything other than a literal false is verified. Rows
  // that predate migration 011 were grandfathered to TRUE.
  if (existing.email_verified === false) {
    return existing.verified_email ? 'refuse' : 'evict';
  }
  // Grandfathered row with no recorded address: trust the address it holds,
  // which is exactly the pre-round-16 behaviour.
  if (!existing.verified_email) return 'claim';
  return canonicalEmail(existing.verified_email) === canonicalEmail(providerEmail) ? 'claim' : 'refuse';
}

// Take the ADDRESS away from a never-verified row without taking its data.
// The row survives under a non-routable tombstone; it just stops owning a
// mailbox it never proved it could read. Payment handles are cleared as well:
// the middleware gate should already have made it impossible to set them, and
// this is the belt to that pair of braces.
async function releaseSquattedAddress(existing, req) {
  // The tombstone carries random bytes, not just the row id. users.email is
  // UNIQUE, and `PUT /api/users/profile` accepts any well-formed address —
  // including `released+42@unclaimed.invalid`. A predictable tombstone would
  // therefore let anyone PARK the exact address a future eviction of user 42
  // needs, turning that user's rightful owner's Google sign-in into a UNIQUE
  // violation and a permanent 500. Unguessable removes the pre-image entirely.
  const tombstone = `released+${existing.id}.${crypto.randomBytes(6).toString('hex')}@unclaimed.invalid`;
  const result = await pool.query(
    `UPDATE users
        SET email = $1, email_verified = FALSE, verified_email = NULL,
            venmo_username = NULL, cashapp_cashtag = NULL, zelle_identifier = NULL,
            token_version = token_version + 1, updated_at = NOW()
      WHERE id = $2 AND email_verified = FALSE
      RETURNING id`,
    [tombstone, existing.id]
  );
  // Zero rows means the row verified itself between our read and this write.
  // Losing that race must not displace a now-legitimate account.
  if (result.rowCount === 0) return false;
  await pool.query(
    'UPDATE email_verifications SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
    [existing.id]
  );
  revokeUserSessions(req.app.get('io'), existing.id);
  console.warn(`[auth] released squatted address from unverified account ${existing.id}`);
  return true;
}

// ---------------------------------------------------------------------------
// Per-account login throttle (round 15)
// ---------------------------------------------------------------------------
// server.js rate limits /api/auth at 10/min PER IP. That is a speed limit on
// one attacker's connection, not on attempts against one account: a credential
// stuffing run spread over a botnet (or a few hundred cloud IPs) gets an
// unbounded number of guesses at a single password, and nothing anywhere
// counts failures per account. Passwords here are 8 chars with one uppercase
// and one digit, which is well inside range for that.
//
// Keyed on the canonical address so `v.ictim+a@gmail.com` cannot be used to
// mint a fresh bucket for the same mailbox. In-memory and therefore per
// process: it is a real ceiling on a single-instance deployment (Railway
// today) and a partial one behind N instances. Counting is deliberately
// identical for known and unknown addresses so it reveals nothing new.
const LOGIN_FAIL_LIMIT = 10;
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAIL_MAX_KEYS = 20000;
const loginFailures = new Map();

function loginLockedFor(key, now = Date.now()) {
  const entry = loginFailures.get(key);
  if (!entry) return 0;
  if (now >= entry.expiresAt) { loginFailures.delete(key); return 0; }
  return entry.count >= LOGIN_FAIL_LIMIT ? entry.expiresAt - now : 0;
}

function recordLoginFailure(key, now = Date.now()) {
  // Bounded: an attacker cycling addresses must not grow this without limit.
  if (loginFailures.size > LOGIN_FAIL_MAX_KEYS) {
    for (const [k, v] of loginFailures) if (now >= v.expiresAt) loginFailures.delete(k);
    if (loginFailures.size > LOGIN_FAIL_MAX_KEYS) loginFailures.clear();
  }
  const entry = loginFailures.get(key);
  if (!entry || now >= entry.expiresAt) {
    loginFailures.set(key, { count: 1, expiresAt: now + LOGIN_FAIL_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function clearLoginFailures(key) {
  loginFailures.delete(key);
}

// ---------------------------------------------------------------------------
// Apple identity token replay (round 16)
// ---------------------------------------------------------------------------
// An Apple identity token is a bearer credential that is valid for about ten
// minutes and was accepted here as many times as anyone cared to present it.
// Anything that saw one once — a proxy log, a crash report, an analytics SDK
// that captured the request body, a shared device's URL history — could sign in
// as that user for the rest of the window. Nothing in the previous code made a
// token single-use.
//
// The cache is keyed on SHA-256 of the token and expires with the token itself,
// so it is bounded by Apple's own ten-minute window rather than growing. A
// token is recorded only when the sign-in SUCCEEDS: a client retrying after a
// transient 503 from Apple's code exchange must not be told its own token was
// replayed, which would turn one upstream blip into a hard sign-in failure.
//
// In-memory, therefore per process — a real ceiling on the single-instance
// Railway deployment and a partial one behind N instances, exactly like the
// login throttle above. The nonce check below is the part that does not depend
// on process affinity, once clients send one.
const APPLE_REPLAY_MAX_KEYS = 20000;
const APPLE_REPLAY_MAX_TTL_MS = 15 * 60 * 1000;
const appleTokensUsed = new Map();

function appleTokenKey(identityToken) {
  return crypto.createHash('sha256').update(String(identityToken)).digest('hex');
}

function appleTokenWasUsed(identityToken, now = Date.now()) {
  const expiresAt = appleTokensUsed.get(appleTokenKey(identityToken));
  if (!expiresAt) return false;
  if (now >= expiresAt) {
    appleTokensUsed.delete(appleTokenKey(identityToken));
    return false;
  }
  return true;
}

function markAppleTokenUsed(identityToken, expSeconds, now = Date.now()) {
  if (appleTokensUsed.size > APPLE_REPLAY_MAX_KEYS) {
    for (const [k, v] of appleTokensUsed) if (now >= v) appleTokensUsed.delete(k);
    if (appleTokensUsed.size > APPLE_REPLAY_MAX_KEYS) appleTokensUsed.clear();
  }
  const remaining = Number.isFinite(expSeconds) ? expSeconds * 1000 - now : APPLE_REPLAY_MAX_TTL_MS;
  const ttl = Math.min(Math.max(remaining, 60 * 1000), APPLE_REPLAY_MAX_TTL_MS);
  appleTokensUsed.set(appleTokenKey(identityToken), now + ttl);
}

// Server-issued Apple nonces. POST /api/auth/apple/nonce hands one out; the
// client passes it to Apple (native SDKs want SHA-256 of it, Apple's JS SDK
// hashes it for you) and sends the raw value back with the identity token. We
// accept either spelling in the token's `nonce` claim, compared in constant
// time, and the nonce is spent on first use.
//
// Not yet required, because no shipped client sends one and hard-requiring it
// would break every existing Apple sign-in on deploy. APPLE_REQUIRE_NONCE=true
// flips it to mandatory once the iOS client is updated. Until then the replay
// cache above is what actually stops a replayed token.
const APPLE_NONCE_TTL_MS = 10 * 60 * 1000;
const APPLE_NONCE_MAX_KEYS = 20000;
const appleNonces = new Map();

function issueAppleNonce(now = Date.now()) {
  if (appleNonces.size > APPLE_NONCE_MAX_KEYS) {
    for (const [k, v] of appleNonces) if (now >= v) appleNonces.delete(k);
    if (appleNonces.size > APPLE_NONCE_MAX_KEYS) appleNonces.clear();
  }
  const nonce = crypto.randomBytes(24).toString('base64url');
  appleNonces.set(nonce, now + APPLE_NONCE_TTL_MS);
  return nonce;
}

// Checked and SPENT separately, for the same reason the identity token is only
// recorded on success: if a failed attempt burned the nonce, one transient 503
// from Apple's code exchange would force the user back through the whole Apple
// authorization sheet instead of letting the client retry. Validity is checked
// early, the nonce is spent next to markAppleTokenUsed.
function appleNonceValid(nonce, now = Date.now()) {
  const expiresAt = appleNonces.get(nonce);
  if (!expiresAt) return false;
  if (now >= expiresAt) { appleNonces.delete(nonce); return false; }
  return true;
}

function spendAppleNonce(nonce) {
  if (nonce) appleNonces.delete(nonce);
}

// Constant-time string equality that tolerates different lengths.
function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a == null ? '' : a), 'utf8');
  const right = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

// The token's `nonce` claim is either the raw nonce (Apple's JS SDK hashes it
// itself and echoes the hash; native SDKs echo whatever was set) or its SHA-256
// hex digest. Accept both, in constant time.
function appleNonceClaimMatches(tokenNonce, suppliedNonce) {
  const hashed = crypto.createHash('sha256').update(String(suppliedNonce)).digest('hex');
  const rawOk = constantTimeEquals(tokenNonce, suppliedNonce);
  const hashOk = constantTimeEquals(tokenNonce, hashed);
  return rawOk || hashOk;
}

// Age gate (C4) — SERVER-SIDE enforcement. The mobile neutral age screen collects
// a DOB and sends it at account creation; we compute age here so the under-13
// block survives local-storage clears / reinstalls and is recorded on the user row.
const { ageFromDob, MIN_AGE } = require('../utils/age');
const UNDERAGE_MSG = 'You must be at least 13 to use Flock.';

// Legacy accounts predate the DOB requirement (round 3): they must not stay
// permanently outside the age gate. On sign-in, a null-DOB account either
// supplies a DOB now (persisted, under-13 rejected) or gets needsDob back.
// Round 15: `date_of_birth` reaches here straight off the body. Only /signup
// validates it (isISO8601); the login and OAuth paths do not, so anything
// Date() can parse — a number of milliseconds, an array — passed ageFromDob
// and then went into a DATE column, where pg rejected it and the sign-in 500'd.
// Shape-check before persisting: YYYY-MM-DD, or a full ISO timestamp.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;

// The ONE place a client-supplied date of birth is turned into something safe
// to store. Round 18 re-audit: the shape check above lived only inside
// enforceDobOnLogin, so the Google and Apple ACCOUNT-CREATION branches took
// `req.body.date_of_birth` straight off the body, ran it through ageFromDob —
// which is `new Date(x)`, and `new Date(946684800000)` and
// `new Date(['2000-01-01'])` both parse — and then handed the SAME raw value to
// pg as a parameter for a DATE column. That is the exact round-15 bug, still
// live on the two paths that were not audited with it: a 500 on sign-in from a
// body shape an attacker picks. Returns the trimmed string, or null meaning
// "no usable date of birth was supplied".
function suppliedDob(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return ISO_DATE_RE.test(trimmed) ? trimmed : null;
}

async function enforceDobOnLogin(user, req, res) {
  if (user.date_of_birth) return true;
  const supplied = suppliedDob(req.body.date_of_birth);
  const age = supplied ? ageFromDob(supplied) : null;
  if (age === null) {
    res.status(403).json({ error: 'Add your date of birth to continue.', needsDob: true });
    return false;
  }
  if (age < MIN_AGE) {
    res.status(403).json({ error: UNDERAGE_MSG });
    return false;
  }
  await pool.query('UPDATE users SET date_of_birth = $1 WHERE id = $2', [supplied, user.id]);
  user.date_of_birth = supplied;
  return true;
}
const { isDisposableEmail } = require('../utils/disposableEmail');

// Ban-evasion tombstones (migration 012, routes/users.js). Deleting a BANNED
// account leaves keyed one-way digests of the email, phone and OAuth identity
// it used; this file owns every account CREATION path, so this file is where
// they have to be consulted or the whole control is inert.
//
// Required lazily, inside the handlers, for the same reason services/appleAuth
// is: routes/users.js is a large module that pulls in multer and the moderation
// stack, and requiring it at load time here would tie two route modules
// together at boot for one function. It FAILS OPEN on a database error by
// design (see isIdentityBanned) — one bad query must not mean nobody can sign
// up.
function banTombstones() {
  return require('./users');
}

// Round 9: display names created through OAuth skipped the profanity screen the
// password signup path runs, and the provider name is user-controlled (a Google
// or Apple profile name is whatever the user typed). Screen it here too, but a
// failed screen must NOT 400 the sign-in and lock someone out of their account:
// fall back to a generated placeholder derived from the email local part, then
// "Friend". The user can rename in onboarding.
function safeOAuthDisplayName(rawName, email, provider) {
  const candidate = typeof rawName === 'string' ? stripHtml(rawName.trim()).trim() : '';
  if (candidate && moderateText(candidate).allowed) return candidate;

  const local = typeof email === 'string'
    ? email.split('@')[0].replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40)
    : '';
  const placeholder = local && moderateText(local).allowed ? local : 'Friend';
  console.warn(`[auth] ${provider} display name failed moderation or was empty — storing placeholder "${placeholder}"`);
  return placeholder;
}

// ARRAY-SHAPED FIELDS WALK PAST express-validator. Given
// `{"email": ["a@b.com"], "password": ["Password1"]}` every chain below runs
// PER ELEMENT, every element passes, sanitizers write back element by element
// and never collapse the array — so `req.body.email` is STILL an array when the
// handler reads it. routes/users.js PUT /profile, /forgot-password and
// /reset-password all carry this guard; /signup, /login, /google and /apple did
// not, and they are the routes that hand those values to bcrypt (which throws on
// a non-string) and to pg as parameters for text and DATE columns (which is a
// 500, not a 400, from a body shape the caller picks). Validators check
// CONTENT; this checks TYPE, which is the half they structurally cannot do.
function rejectNonStringFields(req, res, fields, message) {
  for (const field of fields) {
    const value = req.body?.[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      res.status(400).json({ error: message });
      return true;
    }
  }
  return false;
}

// Validation rules
const signupValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required')
    .custom((v) => !isDisposableEmail(v)).withMessage('Temporary email addresses cannot be used. Use an address you keep.'),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number'),
  body('name').trim().customSanitizer(stripHtml).isLength({ min: 1, max: 255 }).withMessage('Name is required'),
  // Phone is deliberately NOT accepted at signup. It has no UNIQUE constraint
  // and drives contact-sync friend discovery, so accepting it here let an
  // attacker claim a victim's number from a fresh account that only ever proved
  // a throwaway email — the same squat email verification closes, run through
  // phone instead. Phone is set only via PUT /users/profile, which requires
  // one-account-per-number and a fresh-auth proof.
  // Required: the age gate is meaningless if DOB is optional (audit 2026-08-12)
  body('date_of_birth').exists().withMessage('Add your date of birth to create an account.')
    .isISO8601().withMessage('Invalid date of birth'),
];

const loginValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password is required'),
];

// POST /api/auth/signup
router.post('/signup', signupValidation, async (req, res) => {
  try {
    // TYPE before CONTENT — see rejectNonStringFields. date_of_birth is on the
    // list because it is the one that reaches a DATE column: isISO8601 passes
    // per element for `["2000-01-01"]` and the array itself is what gets
    // inserted.
    if (rejectNonStringFields(req, res, ['email', 'password', 'name', 'date_of_birth'],
      'Check the details you entered and try again.')) return;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { email, password, name, interests, date_of_birth } = req.body;
    const safeInterests = sanitizeArray(interests || []);

    // Display names are UGC shown in invites, messages, and search — the same
    // screen profile edits already run (round 8: signup skipped it).
    if (rejectIfProfane(res, name)) return;

    // Server-side age gate (C4): DOB is required, and under-13 is rejected
    // regardless of the client gate.
    const age = ageFromDob(date_of_birth);
    if (age === null) {
      return res.status(400).json({ error: 'Add your date of birth to create an account.', needsDob: true });
    }
    if (age < MIN_AGE) {
      return res.status(403).json({ error: UNDERAGE_MSG });
    }

    // Check if email already exists. Canonical match (round 15) so a Gmail
    // dot/subaddress variant cannot open a SECOND account on a mailbox that
    // already has one — see canonicalEmail above.
    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Ban-evasion tombstone (migration 012). Checked before the bcrypt hash so
    // a blocked signup costs nothing, and before the INSERT so no row is
    // created for an identity that is not allowed to have one.
    if (await banTombstones().rejectIfBannedIdentity(res, { email })) return;

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // email_verified FALSE explicitly (round 16). The column DEFAULT is already
    // FALSE after migration 011, but an INSERT that says so cannot be silently
    // changed by a future default.
    const result = await pool.query(
      `INSERT INTO users (email, password, name, interests, terms_accepted_at, date_of_birth, email_verified)
       VALUES ($1, $2, $3, $4, NOW(), $5, FALSE)
       RETURNING id, email, name, phone, interests, role, profile_image_url, email_verified, created_at`,
      [email, hashedPassword, name, safeInterests, date_of_birth || null]
    );

    const user = result.rows[0];

    // The account exists and can sign in; it just cannot accumulate anything
    // until the link is clicked (see UNVERIFIED_DENY in middleware/auth.js).
    // A Resend outage must therefore NOT fail a signup that already committed —
    // the user can ask for a new link from inside the app.
    let verificationSent = false;
    try {
      const budget = await verificationSendBudget(user.id, req.ip);
      if (budget.ipHour >= RESEND_MAX_PER_HOUR_IP) {
        console.warn(`[auth] verification mail budget exhausted for ip ${req.ip} — skipping send for user ${user.id}`);
      } else {
        const sendResult = await sendVerification(user, req.ip);
        verificationSent = sendResult.sent === true;
      }
    } catch (mailErr) {
      console.error('[auth] verification send failed at signup:', mailErr.message);
    }

    const token = signUserToken(user);

    res.status(201).json({ token, user, emailVerificationRequired: true, verificationSent });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// POST /api/auth/verify-email  — { token }
// GET  /api/auth/verify-email?token=...  — the link in the email
//
// Both consume the same single-use token. The GET exists because that is what a
// link in an email can do; it answers with a redirect back to the web app so
// the user lands somewhere real instead of on a JSON blob. The POST exists for
// the app, which can hold the token and show its own confirmation.
//
// Every failure is reported as one generic outcome. There is no "no such token"
// vs "wrong token" distinction to read off the response.
router.post('/verify-email', [body('token').isString()], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'This link is not valid. Ask for a new one.' });
    }
    const result = await consumeVerification(req.body.token);
    if (!result.ok) {
      const expired = result.reason === 'expired';
      return res.status(400).json({
        error: expired
          ? 'That link has expired. Ask for a new one.'
          : 'This link is not valid. Ask for a new one.',
        reason: result.reason,
      });
    }
    res.json({ message: 'Email confirmed.', email_verified: true });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ error: 'Could not confirm your email' });
  }
});

router.get('/verify-email', async (req, res) => {
  // The redirect target is built from the PINNED production web URL, never from
  // anything on the request, so this cannot be turned into an open redirect.
  const land = (status) => res.redirect(302, `${baseWebUrl()}/?email_verified=${status}`);
  try {
    const raw = typeof req.query.token === 'string' ? req.query.token : '';
    const result = await consumeVerification(raw);
    if (!result.ok) return land(result.reason === 'expired' ? 'expired' : 'invalid');
    return land('1');
  } catch (err) {
    console.error('Verify email (GET) error:', err);
    return land('error');
  }
});

// POST /api/auth/resend-verification — authenticated, because the account that
// wants a new link is the one holding the token signup handed it. Rate limited
// per account (a minimum gap, plus hourly and daily caps) and per IP, both
// counted in the database so a redeploy does not reset them.
router.post('/resend-verification', authenticate, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT id, email, name, email_verified FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = userResult.rows[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (user.email_verified !== false) {
      return res.json({ message: 'Your email is already confirmed.', email_verified: true });
    }
    if (!isMailableAddress(user.email)) {
      return res.status(400).json({ error: 'This account has no email address we can send to.' });
    }

    const budget = await verificationSendBudget(user.id, req.ip);
    const tooSoon = budget.accountLast && Date.now() - budget.accountLast < RESEND_MIN_GAP_MS;
    if (
      tooSoon
      || budget.accountHour >= RESEND_MAX_PER_HOUR_ACCOUNT
      || budget.accountDay >= RESEND_MAX_PER_DAY_ACCOUNT
      || budget.ipHour >= RESEND_MAX_PER_HOUR_IP
    ) {
      console.warn(`[auth] verification resend throttled for user ${user.id} from ${req.ip}`);
      return res.status(429).json({ error: 'We just sent one. Check your inbox, then try again in a few minutes.' });
    }

    const sendResult = await sendVerification(user, req.ip);
    res.json({ message: 'Sent. Check your inbox.', verificationSent: sendResult.sent === true });
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ error: 'Could not send a new link' });
  }
});

// POST /api/auth/forgot-password — { email }
//
// Answers with ONE sentence and ONE status code, always. Not "no account with
// that address", not a 404, not a faster reply: this endpoint is the classic
// way an attacker turns a leaked address list into a list of real users, and
// every one of those is a way to read the answer off it. The only observable
// difference between "there is an account" and "there is not" is what arrives
// in a mailbox the requester may not be able to open.
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail().withMessage('Enter the email you sign in with'),
], async (req, res) => {
  try {
    // TYPE check before the validators' CONTENT check. Given
    // `{"email": ["a@b.com"]}` express-validator runs per element, every
    // element passes isEmail, and req.body.email is STILL an array afterwards
    // (see the same trap in routes/users.js PUT /profile). An array reaching
    // canonicalEmail would silently bucket every such request together, and
    // reaching pg as a parameter for a text column is a 500.
    if (typeof req.body.email !== 'string') {
      return res.status(400).json({ error: 'Enter the email you sign in with' });
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { email } = req.body;
    const emailKey = resetBucketKey(email);

    // Budget first, and it is keyed on the ADDRESS, so it counts identically
    // for addresses that have no account. A 429 here therefore says "you have
    // asked a lot", never "this address exists".
    //
    // The accepted cost: three requests an hour for one address is also three
    // requests an attacker can burn to keep its owner from asking for a link
    // for the rest of the hour. That is inherent to per-address limiting, the
    // window is short, and the alternative (no per-address cap) is a mail
    // cannon pointed at any address an attacker chooses.
    const budget = await resetRequestBudget(emailKey, req.ip);
    if (resetBudgetExhausted(budget)) {
      console.warn(`[auth] password reset throttled from ${req.ip}`);
      return res.status(429).json({ error: 'That is a few reset emails already. Try again in a few minutes.' });
    }
    await recordResetRequest(emailKey, req.ip);
    maybePurgeResetRequests();

    // Canonical lookup (round 15), the same one signup and the OAuth claims
    // use, so a Gmail dot or +subaddress variant finds the account it belongs
    // to instead of silently mailing nobody.
    const user = await findUserByEmail(email);
    if (user) {
      dispatchResetMail(user, req.ip);
    } else {
      console.warn(`[auth] password reset requested for an address with no account from ${req.ip}`);
    }

    res.json({ message: RESET_NEUTRAL_MESSAGE });
  } catch (err) {
    console.error('Forgot password error:', err);
    // Even the failure is shaped the same way. A 500 on one branch and a 200 on
    // the other would be the oracle this endpoint exists to close.
    res.status(500).json({ error: 'Could not start a password reset. Try again in a moment.' });
  }
});

// POST /api/auth/reset-password/check — { token }
//
// Reads a link's state WITHOUT spending it, so the screen can say "this link
// expired, ask for a new one" before the user picks and types a new password
// rather than after. It is not a new attack surface: the caller already has to
// hold a token, guessing the 256-bit verifier is not a thing that happens, and
// the per-IP limiter on /api/auth applies here like everywhere else.
router.post('/reset-password/check', [body('token').isString()], async (req, res) => {
  try {
    if (typeof req.body.token !== 'string') {
      return res.json({ valid: false, reason: 'invalid' });
    }
    const result = await inspectReset(req.body.token);
    res.json({ valid: result.ok === true, reason: result.ok ? null : result.reason });
  } catch (err) {
    console.error('Reset password check error:', err);
    res.status(500).json({ error: 'Could not check that link' });
  }
});

// POST /api/auth/reset-password — { token, password }
//
// The password policy is the one signup enforces, character for character. A
// recovery flow that accepts a weaker password than signup does is just signup
// with the rules switched off.
router.post('/reset-password', [
  body('token').isString().withMessage('This link is not valid. Ask for a new one.'),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number'),
], async (req, res) => {
  try {
    // Same array-shaped-body trap as above; bcrypt.hash on a non-string is a
    // 500 rather than a 400.
    for (const field of ['token', 'password']) {
      if (typeof req.body[field] !== 'string') {
        return res.status(400).json({ error: 'This link is not valid. Ask for a new one.' });
      }
    }
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const result = await consumeReset(req.body.token, req.body.password);
    if (!result.ok) {
      const copy = {
        expired: 'That link has expired. Ask for a new one.',
        used: 'That link has already been used. Ask for a new one.',
      };
      return res.status(400).json({
        error: copy[result.reason] || 'This link is not valid. Ask for a new one.',
        reason: result.reason,
      });
    }

    // The token_version bump already killed every REST session; this drops the
    // live Socket.io connections those tokens are holding, which authenticate
    // once at the handshake and would otherwise keep receiving the account's
    // DMs, flock messages and location until the recheck timer noticed.
    revokeUserSessions(req.app.get('io'), result.userId);

    // No session is issued here on purpose. Somebody who just proved they can
    // read the mailbox should sign in with the password they chose, which is
    // also the moment they find out whether it saved.
    res.json({ message: 'Password updated. Sign in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Could not set a new password. Try again in a moment.' });
  }
});

// POST /api/auth/login
router.post('/login', loginValidation, async (req, res) => {
  try {
    // TYPE before CONTENT — see rejectNonStringFields. An array email would
    // reach canonicalEmail (which answers '' for a non-string, bucketing every
    // such request into ONE throttle key) and then pg as a parameter for a text
    // column; an array password reaches bcrypt.compare. Both are 500s.
    if (rejectNonStringFields(req, res, ['email', 'password'], 'Invalid email or password')) return;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { email, password } = req.body;

    // Per-account throttle (round 15) — checked BEFORE the lookup so a locked
    // account costs an attacker a database round trip of nothing.
    const throttleKey = canonicalEmail(email);
    if (loginLockedFor(throttleKey) > 0) {
      console.warn(`Login throttled for ${throttleKey} from ${req.ip} at ${new Date().toISOString()}`);
      return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again in a few minutes.' });
    }

    const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    const user = result.rows[0] || null;

    // Round 16: this used to answer `401 "This account uses Google Sign-In"`
    // for any OAuth row, BEFORE any bcrypt work. That was two oracles in one
    // line. It confirmed the address has an account AND named the provider, so
    // anyone could sort a leaked address list into "has a Flock account",
    // "signs in with Google" and "unknown" by reading the response body. And
    // because it returned without hashing anything, the same three-way split
    // was readable from the RESPONSE TIME alone, which no amount of rewording
    // the message would have fixed.
    //
    // Every path below now costs one bcrypt compare and answers with the same
    // sentence. DUMMY_PASSWORD_HASH is a real hash at the same cost factor, so
    // "no such address" and "address exists but signs in with Google" take the
    // same work as a genuine wrong password.
    const validPassword = await bcrypt.compare(password, user?.password || DUMMY_PASSWORD_HASH);
    if (!user || !user.password || !validPassword) {
      recordLoginFailure(throttleKey);
      const why = !user ? 'unknown email' : !user.password ? 'oauth account' : 'bad password';
      console.warn(`Failed login attempt (${why}) for ${email} from ${req.ip} at ${new Date().toISOString()}`);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    clearLoginFailures(throttleKey);

    if (!(await enforceDobOnLogin(user, req, res))) return;

    const token = signUserToken(user);

    // Strip password from response
    const { password: _, apple_refresh_token: _art, token_version: _tv, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, name, phone, interests, role, profile_image_url, venmo_username, cashapp_cashtag, zelle_identifier, email_verified, created_at, updated_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Get current user error:', err);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// POST /api/auth/logout
// Single-device sign-out. Tokens carry no per-session id, so the only thing
// that can be revoked is EVERY session at once (token_version) — doing that
// here would sign a user out of their laptop every time they signed out of
// their phone. So this stays advisory: the client discards the token.
// POST /api/auth/logout-all below is the one that actually revokes.
router.post('/logout', authenticate, (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

// POST /api/auth/logout-all — sign out on every device, for real.
//
// Round 15: nothing a user could reach revoked a token. /logout was purely
// advisory, so a token lifted from a shared or lost phone stayed valid for the
// rest of its 24h no matter what its owner did, and the only two things in the
// app that bump token_version are the OAuth claim and a password change —
// neither available to an OAuth account whose device was stolen. This is that
// control: bump the version (killing every outstanding JWT for the account,
// this caller's included) and drop the live sockets those tokens are holding.
router.post('/logout-all', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE users SET token_version = token_version + 1, updated_at = NOW() WHERE id = $1 RETURNING id',
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    revokeUserSessions(req.app.get('io'), req.user.id);
    console.warn(`[auth] all sessions revoked for user ${req.user.id} at ${new Date().toISOString()}`);
    res.json({ message: 'Signed out on all devices' });
  } catch (err) {
    console.error('Logout-all error:', err);
    res.status(500).json({ error: 'Failed to sign out other devices' });
  }
});

// POST /api/auth/google — Google OAuth sign-in.
// Two accepted proofs:
//   credential    — ID token from Google's rendered button (legacy path)
//   access_token  — OAuth token from the custom-styled button (useGoogleLogin).
//     SECURITY: an access token alone proves nothing about WHICH app it was
//     issued to, so we check tokeninfo.aud against our client id before
//     trusting userinfo — otherwise any third-party app's token could log
//     its users into Flock accounts.
router.post('/google', [
  body('credential').optional().isString(),
  body('access_token').optional().isString(),
], async (req, res) => {
  try {
    // TYPE before CONTENT — see rejectNonStringFields.
    if (rejectNonStringFields(req, res, ['credential', 'access_token', 'date_of_birth'],
      'Google sign-in failed')) return;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }
    if (!req.body.credential && !req.body.access_token) {
      return res.status(400).json({ error: 'Google credential is required' });
    }

    let googleId, email, name, picture, emailVerified;
    if (req.body.credential) {
      // FAIL CLOSED (round 4): an undefined audience makes verifyIdToken skip
      // the check, so an ID token minted for any Google app would pass. The
      // access_token branch below already fails closed via its aud comparison.
      if (!process.env.GOOGLE_CLIENT_ID) {
        console.error('GOOGLE_CLIENT_ID not set — refusing Google sign-in');
        return res.status(500).json({ error: 'Google sign-in is not configured' });
      }
      // Verify the Google ID token
      const ticket = await googleClient.verifyIdToken({
        idToken: req.body.credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      // FAIL CLOSED (round 13): an ABSENT email_verified must not count as
      // verified — the whole account-claim below hangs on this flag meaning
      // "Google vouches for this address". Mirrors the Apple branch.
      const gp = ticket.getPayload();
      ({ sub: googleId, email, name, picture } = gp);
      emailVerified = gp.email_verified === true || gp.email_verified === 'true';
    } else {
      const at = req.body.access_token;
      // Round 12: sign-in blocked on Google with no deadline — a Google
      // brownout parked login requests (and pg pool slots) for ~5 minutes.
      const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(at)}`, { signal: upstreamSignal('oauth') });
      if (!infoRes.ok) {
        return res.status(401).json({ error: 'Google sign-in expired, please try again' });
      }
      const info = await infoRes.json();
      if (info.aud !== process.env.GOOGLE_CLIENT_ID) {
        return res.status(401).json({ error: 'Google sign-in failed' });
      }
      const profileRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${at}` },
        signal: upstreamSignal('oauth'), // round 12
      });
      if (!profileRes.ok) {
        return res.status(401).json({ error: 'Google sign-in failed' });
      }
      const profile = await profileRes.json();
      if (profile.email_verified === false) {
        return res.status(401).json({ error: 'Google account email is not verified' });
      }
      ({ sub: googleId, email, name, picture } = profile);
      // FAIL CLOSED (round 13): `!== false` treated an absent field as verified.
      emailVerified = profile.email_verified === true || profile.email_verified === 'true';
    }

    if (!email) {
      return res.status(400).json({ error: 'Google account has no email' });
    }

    // Check if user exists by oauth_id or email
    let result = await pool.query(
      `SELECT * FROM users WHERE oauth_provider = 'google' AND oauth_id = $1`,
      [googleId]
    );

    let user;
    if (result.rows.length > 0) {
      // Existing Google user — log in
      user = result.rows[0];
    } else {
      // SECURITY (audit 2026-08-12, revised round 8): signup never verifies
      // email ownership, so blanket-blocking same-email sign-ins let an
      // attacker permanently SQUAT a victim's address (pre-register it with a
      // password and lock the real owner out of OAuth forever). Google HAS
      // verified this email, so the Google user is the address's real owner:
      // claim a password-only row for them and clear its password, which cuts
      // off the squatter. Rows already linked to another provider stay
      // untouchable (no cross-provider takeover).
      // Canonical lookup (round 15): the provider's address is stored
      // verbatim while signup normalizes Gmail dots away, so an exact
      // LOWER() match could not see the squatted row it exists to reclaim.
      const existing = await findUserByEmail(email);

      // Round 16: an existing row only gets HANDED OVER if it proved it owns
      // this mailbox. See claimDecision above for the three outcomes.
      let claimTarget = null;
      if (existing) {
        if (existing.oauth_provider || !emailVerified) {
          return res.status(409).json({
            error: 'An account with this email already exists. Log in the way you originally signed up.',
          });
        }
        // Round 15: a claim of a BANNED row silently handed the ban to the
        // address's real owner. Squat `victim@gmail.com`, earn a ban on it,
        // and the victim's first Google sign-in welded their Google identity
        // onto a suspended account: every request 403s, with no explanation
        // and nothing they can do. Refuse the claim instead — and never lift
        // the ban here, because "sign in with Google on the same address"
        // would then be a one-click ban evasion for any password account.
        // A banned row is also never EVICTED: releasing its address would make
        // "sign in with Google" a way to shed a ban and start clean.
        if (existing.is_banned) {
          console.warn(`[auth] refused Google claim of BANNED account ${existing.id} (${email})`);
          return res.status(403).json({
            error: 'An account with this email has been suspended. Contact support if you think that is a mistake.',
          });
        }
        const decision = claimDecision(existing, email);
        if (decision === 'refuse') {
          console.warn(`[auth] refused Google claim of account ${existing.id}: verified address does not match ${email}`);
          return res.status(409).json({
            error: 'An account with this email already exists. Log in the way you originally signed up.',
          });
        }
        if (decision === 'claim') claimTarget = existing;
      }

      if (claimTarget) {
        // Round 13: the claim transferred the ROW but not the SESSION. The
        // squatter who pre-registered this address may be holding a JWT minted
        // minutes ago and good for another 24h, which would keep reading the
        // real owner's DMs, flocks and live location right through the
        // handover. Bumping token_version invalidates every token already
        // issued for this user id (middleware/auth.js compares the `tv` claim).
        const claimed = await pool.query(
          `UPDATE users SET oauth_provider = 'google', oauth_id = $1, password = NULL,
             profile_image_url = COALESCE(profile_image_url, $2),
             email_verified = TRUE, verified_email = email,
             token_version = token_version + 1, updated_at = NOW()
           WHERE id = $3 RETURNING *`,
          [googleId, picture || null, claimTarget.id]
        );
        user = claimed.rows[0];
        // Round 15: the bump kills REST sessions on the next request, but a
        // Socket.io connection authenticates ONCE at the handshake. Without
        // this the squatter's live socket stays in `user:{id}` and keeps
        // receiving the real owner's DMs, flock messages and location the
        // whole time. See revokeUserSessions in middleware/auth.js.
        revokeUserSessions(req.app.get('io'), claimTarget.id);
        console.warn(`[auth] Google verified-email claim of password account ${claimTarget.id} (${email})`);
      } else {
        // New account. Reached either because nothing held this address, or
        // because an unverified squat held it and is about to lose it.
        //
        // Every gate that can refuse this request runs BEFORE the eviction, so
        // a request that ends in an error never displaces anybody.
        //
        // DOB is REQUIRED for account creation on every path; a Google
        // sign-in without one means "sign up first" (needsDob tells the
        // client to route the user to the signup screen's DOB field).
        const googleDob = suppliedDob(req.body.date_of_birth);
        const dobAge = googleDob ? ageFromDob(googleDob) : null;
        if (dobAge === null) {
          return res.status(403).json({ error: 'No Flock account yet. Sign up with your date of birth first.', needsDob: true });
        }
        if (dobAge < MIN_AGE) {
          return res.status(403).json({ error: UNDERAGE_MSG });
        }
        // Round 16: password signup rejects disposable domains and the OAuth
        // paths did not, so "block throwaway addresses" was one click away from
        // being optional. Only applied when CREATING — an existing account on
        // a domain that was added to the list later must not be locked out.
        if (isDisposableEmail(email)) {
          return res.status(400).json({ error: 'Temporary email addresses cannot be used. Use an address you keep.' });
        }
        // Round 18 re-audit: `emailVerified` was consulted ONLY when an existing
        // row was found. Nothing checked it here, and the INSERT below writes
        // `email_verified TRUE, verified_email = email` unconditionally — so an
        // address Google did NOT vouch for got a row wearing a verified badge it
        // never earned. That row walks straight past the round-16 gate, and
        // because it carries an oauth_provider the address's real owner can
        // never claim OR evict it (the check above 409s on oauth_provider before
        // claimDecision ever runs), so the squat is permanent. Same fail-closed
        // rule the two token branches already apply: absent is not verified.
        if (!emailVerified) {
          console.warn(`[auth] refused Google account creation for an address Google did not vouch for (${req.ip})`);
          return res.status(401).json({ error: 'Google account email is not verified' });
        }
        // Ban-evasion tombstone (migration 012), on the OAuth identity as well
        // as the address: a banned user who deletes their account must not be
        // able to walk back in through the Google button.
        if (await banTombstones().rejectIfBannedIdentity(res, {
          email, oauthProvider: 'google', oauthId: googleId,
        })) return;
        if (existing && !(await releaseSquattedAddress(existing, req))) {
          // It verified itself in the last few milliseconds. Nothing has been
          // changed; ask for a retry, which will now take the claim path.
          return res.status(409).json({ error: 'Something changed on this account. Try signing in again.' });
        }
        // Round 9: the provider name is UGC and was stored unscreened here.
        const googleName = safeOAuthDisplayName(name, email, 'Google');
        // email_verified TRUE: Google already proved this address and must not
        // be asked again. verified_email records WHICH address was proved.
        result = await pool.query(
          `INSERT INTO users (email, name, oauth_provider, oauth_id, profile_image_url, terms_accepted_at, date_of_birth, email_verified, verified_email)
           VALUES ($1, $2, 'google', $3, $4, NOW(), $5, TRUE, $6)
           RETURNING *`,
          [email, googleName, googleId, picture, googleDob, email]
        );
        user = result.rows[0];
      }
    }

        if (!(await enforceDobOnLogin(user, req, res))) return;

    const token = signUserToken(user);
    const { password: _, apple_refresh_token: _art, token_version: _tv, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Google OAuth error:', err);
    if (err.message?.includes('Token used too late') || err.message?.includes('Invalid token')) {
      return res.status(401).json({ error: 'Google sign-in expired, please try again' });
    }
    res.status(500).json({ error: 'Google sign-in failed' });
  }
});

// POST /api/auth/apple — Sign in with Apple (REQUIRED for App Store
// submission whenever Google login is offered). Mirrors the /google
// flow: verify the token, find-or-create the user, issue a Flock JWT.
//
// Apple-specific quirks:
//   - `email` only arrives on the FIRST sign-in. After that, Apple omits
//     it. Mobile client must persist the linkage by `sub` (Apple user ID).
//   - `email` may be a private relay address (xyz@privaterelay.appleid.com).
//     We accept these as-is; Apple forwards mail through their relay.
//   - Apple does NOT send the user's name in the identity token. The
//     mobile SDK gives the name on first sign-in only; client passes it
//     in the `fullName` field of the body, which we use to seed `name`
//     for new accounts.
// POST /api/auth/apple/nonce — hand out a single-use nonce for the next Apple
// sign-in. See the appleNonces block above for why this exists and why sending
// one is not mandatory yet.
router.post('/apple/nonce', (req, res) => {
  res.json({ nonce: issueAppleNonce(), expiresInSeconds: APPLE_NONCE_TTL_MS / 1000 });
});

router.post('/apple', [
  body('identityToken').notEmpty().withMessage('Apple identityToken is required'),
  body('fullName').optional().isObject(),
  body('authorizationCode').optional(),
  body('nonce').optional().isString().isLength({ max: 200 }),
], async (req, res) => {
  try {
    // TYPE before CONTENT — see rejectNonStringFields. `fullName` is checked by
    // isObject() and is read defensively below; the three string fields are the
    // ones that reach jwt.verify, the replay cache and a DATE column.
    if (rejectNonStringFields(req, res, ['identityToken', 'nonce', 'authorizationCode', 'date_of_birth'],
      "Apple sign-in didn't complete. Try again in a moment.")) return;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { identityToken, fullName, authorizationCode } = req.body;

    // Round 16: an identity token was accepted as many times as it was
    // presented, for the ~10 minutes it stays valid. Checked BEFORE the
    // signature verification's side effects and before any row is touched.
    // The token is only RECORDED as used once the sign-in succeeds (see the
    // markAppleTokenUsed call at the end), so a retry after a transient
    // upstream failure is not mistaken for an attack.
    if (appleTokenWasUsed(identityToken)) {
      console.warn(`[auth] rejected replayed Apple identity token from ${req.ip}`);
      return res.status(401).json({ error: 'Apple sign-in expired, please try again' });
    }

    // Verify Apple's signed identity token using their rotating JWKS
    const payload = await new Promise((resolve, reject) => {
      jwt.verify(
        identityToken,
        appleGetSigningKey,
        {
          algorithms: ['RS256'],
          issuer: 'https://appleid.apple.com',
          // FAIL CLOSED (round 3): an undefined audience makes jsonwebtoken
          // skip the check entirely, so a valid Apple token minted for ANY
          // app would authenticate here. Hardcoded fallback = our bundle id.
          audience: process.env.APPLE_BUNDLE_ID || 'com.flockcorp.flock',
        },
        (err, decoded) => {
          if (err) reject(err); else resolve(decoded);
        }
      );
    });

    const appleId = payload.sub;
    const email = payload.email || null;
    // Hoisted out of the claim branch (round 18 re-audit): the CREATE path
    // below needs it too, and read it nowhere. FAIL CLOSED — an absent claim is
    // not a vouched address, exactly as on the Google side.
    const appleEmailVerified = payload.email_verified === true || payload.email_verified === 'true';

    if (!appleId) {
      return res.status(400).json({ error: 'Apple token missing user id' });
    }

    // Nonce binding (round 16). Three cases, in order of how much we know:
    //   * client sent one — it must be one WE issued, unspent, and the token's
    //     `nonce` claim must match it (raw or SHA-256, constant-time);
    //   * client sent none but the token carries a nonce — the token is bound
    //     to a value we cannot check, so we refuse rather than pretend;
    //   * neither — allowed today, refused once APPLE_REQUIRE_NONCE is on.
    const suppliedNonce = typeof req.body.nonce === 'string' ? req.body.nonce.trim() : '';
    {
      const tokenNonce = typeof payload.nonce === 'string' ? payload.nonce : '';
      if (suppliedNonce) {
        if (!appleNonceValid(suppliedNonce)) {
          console.warn(`[auth] Apple sign-in with unknown or spent nonce from ${req.ip}`);
          return res.status(401).json({ error: 'Apple sign-in expired, please try again' });
        }
        if (!appleNonceClaimMatches(tokenNonce, suppliedNonce)) {
          console.warn(`[auth] Apple identity token nonce did not match the issued nonce (${req.ip})`);
          return res.status(401).json({ error: 'Apple sign-in expired, please try again' });
        }
      } else if (tokenNonce) {
        console.warn(`[auth] Apple identity token carries a nonce the client did not send (${req.ip})`);
        return res.status(401).json({ error: 'Apple sign-in expired, please try again' });
      } else if (process.env.APPLE_REQUIRE_NONCE === 'true') {
        return res.status(400).json({ error: "Apple sign-in didn't complete. Try again in a moment." });
      }
    }

    // Find by oauth_id first (linkage by Apple sub never changes)
    let result = await pool.query(
      `SELECT * FROM users WHERE oauth_provider = 'apple' AND oauth_id = $1`,
      [appleId]
    );

    let user = result.rows[0] || null;

    // Round 16: the authorizationCode requirement used to be enforced AFTER
    // the row was created or claimed. A brand-new Apple user who arrived
    // without a code therefore had their account INSERTed and then got a 400,
    // leaving a permanent orphan: a row linked to their Apple sub with no
    // refresh token, which every subsequent sign-in found by oauth_id and then
    // rejected for the same missing code. The account could never be used and
    // could never be recreated. Decide it here, before anything is written.
    {
      const { isConfigured: appleCfg } = require('../services/appleAuth');
      if (!authorizationCode && appleCfg() && !user?.apple_refresh_token) {
        return res.status(400).json({ error: "Apple sign-in didn't complete. Try again in a moment." });
      }
    }

    // Set when an address-holding row is found that is NOT claimable, so the
    // creation path below knows it has to release the address first.
    let existingByEmail = null;

    if (!user && email) {
      // SECURITY (audit 2026-08-12, revised round 8): same verified-email
      // claim rule as Google — Apple has verified this address, so a
      // password-only row for it belongs to this person; claiming it (and
      // clearing the password) unseats an address squatter instead of letting
      // the squat permanently block the real owner. Rows linked to another
      // provider are never absorbed.
      // Canonical lookup (round 15) — same reason as the Google branch.
      existingByEmail = await findUserByEmail(email);
      if (existingByEmail) {
        if (existingByEmail.oauth_provider || !appleEmailVerified) {
          return res.status(409).json({
            error: 'An account with this email already exists. Log in the way you originally signed up.',
          });
        }
        // Round 15: same refusal as the Google branch — never hand a banned
        // row to the address's verified owner, and never lift the ban here.
        // Never evicted either: eviction would be a way to shed a ban.
        if (existingByEmail.is_banned) {
          console.warn(`[auth] refused Apple claim of BANNED account ${existingByEmail.id} (${email})`);
          return res.status(403).json({
            error: 'An account with this email has been suspended. Contact support if you think that is a mistake.',
          });
        }
        // Round 16: same three-way decision as the Google branch.
        const decision = claimDecision(existingByEmail, email);
        if (decision === 'refuse') {
          console.warn(`[auth] refused Apple claim of account ${existingByEmail.id}: verified address does not match ${email}`);
          return res.status(409).json({
            error: 'An account with this email already exists. Log in the way you originally signed up.',
          });
        }
        if (decision === 'claim') {
          // Round 13: same session handover as the Google claim — bump
          // token_version so any JWT the squatter still holds dies immediately.
          const claimed = await pool.query(
            `UPDATE users SET oauth_provider = 'apple', oauth_id = $1, password = NULL,
               email_verified = TRUE, verified_email = email,
               token_version = token_version + 1, updated_at = NOW()
             WHERE id = $2 RETURNING *`,
            [appleId, existingByEmail.id]
          );
          user = claimed.rows[0];
          // Round 15: kill the squatter's live Socket.io connection too — the
          // token_version bump alone never reaches an already-open socket.
          revokeUserSessions(req.app.get('io'), existingByEmail.id);
          console.warn(`[auth] Apple verified-email claim of password account ${existingByEmail.id} (${email})`);
        }
        // 'evict' falls through to creation below, which releases the address
        // only after every remaining gate has passed.
      }
    }

    if (!user) {
      // New user — Apple may not give us name/email after the first sign-in.
      // Fall back to email-derived name or "Friend" for the placeholder; the
      // user can edit in onboarding. Allow email = null (Apple private relay
      // sometimes omits it on subsequent sign-ins).
      const givenName = fullName?.givenName ? stripHtml(String(fullName.givenName).trim()) : '';
      const familyName = fullName?.familyName ? stripHtml(String(fullName.familyName).trim()) : '';
      const composedName = [givenName, familyName].filter(Boolean).join(' ').trim();
      // Round 9: fullName comes from the client and was stored unscreened.
      const fallbackName = safeOAuthDisplayName(
        composedName || (email ? email.split('@')[0] : ''),
        email,
        'Apple'
      );

      // DOB required for creation, same as email + Google paths. Apple never
      // supplies it, so the client must send it (signup screen's DOB field).
      const appleDob = suppliedDob(req.body.date_of_birth);
      const appleDobAge = appleDob ? ageFromDob(appleDob) : null;
      if (appleDobAge === null) {
        return res.status(403).json({ error: 'No Flock account yet. Sign up with your date of birth first.', needsDob: true });
      }
      if (appleDobAge < MIN_AGE) {
        return res.status(403).json({ error: UNDERAGE_MSG });
      }
      // Round 16: parity with password signup and the Google path. Only on
      // creation, so an existing account is never locked out by a later
      // addition to the list. Apple's private relay domain is not on it.
      if (email && isDisposableEmail(email)) {
        return res.status(400).json({ error: 'Temporary email addresses cannot be used. Use an address you keep.' });
      }
      // Round 18 re-audit: same hole as the Google branch. The INSERT below
      // stores `email_verified TRUE, verified_email = storedEmail`
      // unconditionally, so an address Apple did not vouch for got a permanent,
      // un-evictable, ungated row. Only checked when Apple actually gave us an
      // address: when it omits one (every sign-in after the first) the stored
      // value is the .invalid placeholder, which cannot be mailed or squatted
      // and is verified for itself by construction.
      if (email && !appleEmailVerified) {
        console.warn(`[auth] refused Apple account creation for an address Apple did not vouch for (${req.ip})`);
        return res.status(401).json({ error: 'Apple account email is not verified' });
      }
      // Ban-evasion tombstone (migration 012). The Apple sub is the durable
      // half here: Apple's private relay means the address may be absent or
      // rotated, but the sub is the same identity forever.
      if (await banTombstones().rejectIfBannedIdentity(res, {
        email, oauthProvider: 'apple', oauthId: appleId,
      })) return;
      // Round 16: the last gate has now passed, so it is safe to take the
      // address off an unverified squat. Nothing above this line writes.
      if (existingByEmail && !(await releaseSquattedAddress(existingByEmail, req))) {
        return res.status(409).json({ error: 'Something changed on this account. Try signing in again.' });
      }
      // users.email is NOT NULL UNIQUE — a NULL here 500'd account creation
      // (round 8). When Apple omits the email, store a deterministic
      // non-routable placeholder (.invalid TLD can never receive mail);
      // linkage stays on oauth_id, and outbound mail paths skip .invalid.
      const storedEmail = email
        || `apple_${String(appleId).replace(/[^a-zA-Z0-9]/g, '')}@apple-signin.invalid`;
      // email_verified TRUE only when Apple actually gave us an address it
      // vouched for. The .invalid placeholder proves nothing about a mailbox,
      // but it also cannot be squatted or mailed, and the account has no way to
      // ever verify it — so it is recorded as verified for that placeholder and
      // never for a real address. verified_email holds what was proved.
      result = await pool.query(
        `INSERT INTO users (email, name, oauth_provider, oauth_id, terms_accepted_at, date_of_birth, email_verified, verified_email)
         VALUES ($1, $2, 'apple', $3, NOW(), $4, TRUE, $5)
         RETURNING *`,
        [storedEmail, fallbackName, appleId, appleDob, storedEmail]
      );
      user = result.rows[0];
    }

    if (authorizationCode) {
      const { exchangeAppleCode, isConfigured: appleConfigured } = require('../services/appleAuth');
      try {
        const tokens = await exchangeAppleCode(authorizationCode);
        if (tokens?.refresh_token) {
          await pool.query('UPDATE users SET apple_refresh_token = $1 WHERE id = $2', [tokens.refresh_token, user.id]);
        } else if (appleConfigured()) {
          // Round 6: no refresh token means account deletion could never revoke
          // the Apple grant (5.1.1(v)). Fail the sign-in instead of creating an
          // unrevokeable account. Unconfigured env stays a no-op as before.
          return res.status(503).json({ error: "Apple sign-in didn't complete. Try again in a moment." });
        }
      } catch (e) {
        console.error('Apple code exchange error:', e.message);
        if (appleConfigured()) {
          return res.status(503).json({ error: "Apple sign-in didn't complete. Try again in a moment." });
        }
      }
    }

        if (!(await enforceDobOnLogin(user, req, res))) return;

    // Only now are the token and the nonce spent. Every failure path above
    // leaves both usable, so a client that retries after an upstream blip is
    // not locked out by its own replay protection.
    markAppleTokenUsed(identityToken, payload.exp);
    spendAppleNonce(suppliedNonce);

    const token = signUserToken(user);
    const { password: _, apple_refresh_token: _art, token_version: _tv, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Apple Sign In error:', err);
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Apple sign-in expired, please try again' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid Apple identity token' });
    }
    res.status(500).json({ error: 'Apple sign-in failed' });
  }
});

module.exports = router;

// The one canonical-email alphabet, shared with routes/users.js so its email
// uniqueness check compares in the same one this file's lookups do. Named
// exports rather than __testing: routes/users.js is a caller, not a test.
module.exports.canonicalEmail = canonicalEmail;
module.exports.EMAIL_CANONICAL_SQL = EMAIL_CANONICAL_SQL;

// Exported for backend/__tests__/authSurface.test.js. The SQL half of the
// canonical match (EMAIL_MATCH_SQL) is verified by inspection against
// canonicalEmail's unit tests, the same way routes' SQL is covered elsewhere
// in this suite — no test here touches a real database.
module.exports.__testing = {
  canonicalEmail,
  EMAIL_MATCH_SQL,
  loginLockedFor,
  recordLoginFailure,
  clearLoginFailures,
  LOGIN_FAIL_LIMIT,
  // Round 16
  mintVerificationToken,
  parseVerificationToken,
  verifierMatches,
  claimDecision,
  isMailableAddress,
  suppliedDob,
  constantTimeEquals,
  appleNonceClaimMatches,
  issueAppleNonce,
  appleNonceValid,
  spendAppleNonce,
  appleTokenWasUsed,
  markAppleTokenUsed,
  VERIFICATION_TTL_HOURS,
  RESEND_MIN_GAP_MS,
  RESEND_MAX_PER_HOUR_ACCOUNT,
  RESEND_MAX_PER_DAY_ACCOUNT,
  RESEND_MAX_PER_HOUR_IP,
  // Round 17 (password reset)
  resetBucketKey,
  RESET_TTL_MINUTES,
  RESET_MIN_GAP_MS,
  RESET_MAX_PER_HOUR_EMAIL,
  RESET_MAX_PER_DAY_EMAIL,
  RESET_MAX_PER_HOUR_IP,
  RESET_NEUTRAL_MESSAGE,
  // The reset mail is dispatched without being awaited, so the response cannot
  // carry Resend's latency (that latency only exists on the branch where the
  // account does, which makes it an enumeration oracle). Tests await this.
  flushResetMail: () => Promise.allSettled([...pendingResetMail]),
};

// ---------------------------------------------------------------------------
// CROSS-AREA NOTES (round 16) — things this file cannot fix on its own
// ---------------------------------------------------------------------------
// 1. FIXED in round 18. routes/users.js, PUT /profile used to change `email`
//    without resetting email_verified / verified_email. "Contained" was too
//    generous a word for it: claimDecision() refused to hand the row over, and
//    that refusal is a 409 the address's real owner can never get past, so
//    verifying your own mailbox and then moving onto victim@gmail was a
//    PERMANENT squat on that address across all three sign-in paths. PUT
//    /profile now clears both columns whenever the address changes, which turns
//    that state back into 'evict'. The route does not mail the new link itself
//    (it would tie this router into the mail stack for one call); it returns
//    emailVerificationRequired so the client calls /resend-verification.
// 2. routes/users.js, routes/friends.js and routes/flocks.js should each mount
//    `requireVerified` from middleware/auth.js on the routes listed in
//    UNVERIFIED_DENY there. The middleware backstop covers them today; the
//    explicit mount is what keeps them covered after a refactor.
// 3. The login screen no longer gets told that an address is a Google or Apple
//    account (that was an enumeration and timing oracle). The sign-in UI should
//    carry a standing "signed up with Google or Apple? use that button"
//    line rather than relying on the server to say so.
// 4. PUBLIC_API_URL should be set on Railway to the public API origin.
//    Unset falls back to the pinned production URL in services/emailService.js.
//
// ---------------------------------------------------------------------------
// CROSS-AREA NOTES (round 17, password reset)
// ---------------------------------------------------------------------------
// 5. frontend/src/index.js scrubs guest invite tokens out of every PostHog and
//    Sentry payload (`/i/<token>` -> `/i/:token`) and nothing else. The reset
//    link keeps its token in the URL FRAGMENT for exactly that reason: a
//    fragment never reaches the server, never goes out in a Referer, and cannot
//    be spent by a mailbox scanner prefetching the link. It IS still part of
//    `window.location.href`, which is what posthog-js reports as $current_url,
//    so the scrub in index.js should be widened to strip `#token=` and
//    `?token=` as well. The reset screen replaces the URL on mount, which wins
//    the race in practice but is not a guarantee.
// 6. RESOLVED. routes/users.js PUT /profile does call revokeUserSessions after
//    a password change, so no live socket survives one. Every bump of
//    token_version in the app now drops the sockets with it; pinned by
//    backend/__tests__/authReaudit.test.js.
// 7. A completed reset does NOT set email_verified. An account that signed up,
//    never confirmed its address and then reset its password stays unverified
//    and stays inside the round-16 gate, which is deliberate: treating a reset
//    as verification would let the recovery flow hand an unverified squat row,
//    and whatever it holds, to the address's real owner.
