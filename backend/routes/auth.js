const express = require('express');
const crypto = require('crypto');
// ROUND 24 (R4-A2) — THE NATIVE `bcrypt`, NOT `bcryptjs`. Do not swap this back.
//
// `bcryptjs` is a pure-JavaScript implementation, so its work runs ON the single
// V8 thread. Round 4 measured one compare at 48.5 ms here (slower on a Railway
// shared vCPU), and POST /login below costs exactly one compare per attempt for
// EVERY address, existing or not, because a constant-cost compare is what closes
// the account-enumeration oracle. That made the enumeration defence into an
// unauthenticated CPU-exhaustion lever: the per-account throttle is keyed on an
// address the attacker chooses, so the only bound is authLimiter's 10/min per
// IP, and ~60 rotating source addresses saturate the only thread there is. While
// it is saturated every route in the app, socket handshakes included, is queued
// behind bcrypt.
//
// The native package is the same Blowfish/bcrypt algorithm and the same `$2a$` /
// `$2b$` stored format — every hash `bcryptjs` ever wrote to users.password
// still verifies, pinned by a test in __tests__/loginThreadAndHashParity.test.js
// rather than assumed — but it runs the work in libuv's threadpool. The
// concurrency ceiling becomes UV_THREADPOOL_SIZE instead of one, and the event
// loop stops blocking. Measured on this machine, 16 concurrent compares:
//
//   bcryptjs  704 ms wall, and unrelated event-loop work got 2 turns in that
//             window — a single 703 ms head-of-line gap
//   bcrypt    163 ms wall, unrelated work got 173,062 turns, max gap 0.8 ms
//
// bcrypt@6 ships prebuilt N-API binaries INSIDE the npm tarball (prebuildify +
// node-gyp-build), including linux-x64 glibc AND musl, so there is no compiler
// and no install-time download on Railway's builder, and N-API means the binary
// survives Node major upgrades. `bcrypt.js` resolves the binary through
// node-gyp-build at REQUIRE time, not only in the install script, so even an
// `npm ci --ignore-scripts` build boots. That is why this is safe to depend on
// where a node-pre-gyp-era native module (which downloads its binary during
// install) would not have been. Keep `bcryptjs` in package.json: the seed
// scripts and most of the test suites still write their fixtures with it, and
// it is the rollback path. Round 5 (A5-1) finished the swap — routes/users.js
// was the other half of this file's fix and still ran three compares and a
// hash on the event loop; it is native now too.
//
// What this does NOT change: the constant-cost path for unknown addresses below.
// Lowering SALT_ROUNDS would be the wrong lever and removing the dummy compare
// would reopen the oracle; neither is what fixed this.
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { body, validationResult } = require('express-validator');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../config/database');

// A new account claims its waitlist row, once. created_at on that row is the
// person's original place in line, so an account made after launch still
// carries the date they actually joined; announced_at holders stop being
// re-announced; and the admin announce route's `converted` count is how many
// waitlisted people actually arrived. Fire and forget: signing up must never
// wait on, or fail because of, a marketing table.
function linkWaitlistConversion(email, userId) {
  if (!email || !userId) return;
  pool.query(
    `UPDATE waitlist SET converted_user_id = $2, converted_at = NOW()
      WHERE LOWER(email) = LOWER($1) AND converted_user_id IS NULL`,
    [String(email), userId]
  ).catch((e) => console.error('[waitlist] conversion link failed:', e.message));
}
// signUserToken is the ONLY way tokens are minted (round 13): it stamps the
// user's token_version into the JWT so a bump revokes every outstanding token.
const { waitPhrase, refusalBody } = require('../utils/retryAfter');
const { authenticate, signUserToken, revokeUserSessions } = require('../middleware/auth');
const {
  sendVerificationEmail, verificationLink, baseWebUrl,
  sendPasswordResetEmail, sendPasswordResetOAuthEmail, passwordResetLink,
  // SECURITY ROUND 5, 2026-08-20. The six log lines in this file that name an
  // address used to print it in full, and three of them printed it NEXT TO the
  // account's integer id. That pair — id to real address — is the one mapping
  // the database deliberately never hands out, and it was being written to
  // Railway's log: retained, searchable, readable by anyone with dashboard
  // access, and (the moment SENTRY_DSN is set) attached to unrelated errors as
  // a console breadcrumb. The failed-login line is worse still, because it
  // fires on addresses that have NO account here: one mistyped login writes a
  // stranger's address into our logs, and they never touched this product.
  //
  // maskAddress exists for exactly this and services/venueDigest.js already
  // uses it. What these lines have to answer is "which account, and roughly
  // where did the address point". The account id answers the first and the
  // domain answers the second; the local part answers neither.
  maskAddress,
  isMailableAddress: emailServiceIsMailable,
} = require('../services/emailService');
const { stripHtml, sanitizeArray } = require('../utils/sanitize');
const { rejectIfProfane, moderateText } = require('../utils/moderation');
const { upstreamSignal } = require('../utils/upstream');
// Shape before content — see validators/shape.js. Used ONLY where a sanitizer
// runs ahead of rejectNonStringFields below; see the note there.
const { freeText } = require('../validators/shape');

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
// EVERY FIELD HAS A MAXIMUM OF ITS OWN (round 21)
// ---------------------------------------------------------------------------
// Not one field on this router carried a width. The JSON parser in server.js was
// the only ceiling on all of them, which is a bound living in another file that
// moves whenever somebody tunes an unrelated number there — and this is the
// UNAUTHENTICATED router, so every one of those fields is reachable by anyone.
// routes/users.js was audited for exactly this and its numbers are re-derived
// (not re-invented) below; __tests__/authFieldBounds.test.js fails if the two
// files ever disagree.
//
// Where each number comes from:
//
//   MAX_EMAIL      users.email VARCHAR(255), migrations/000_bootstrap.sql. It is
//                  a real gate here and not only a backstop — see the
//                  normalizeEmail note on signupValidation below, which is a
//                  live 22001 rather than a theoretical one.
//   MAX_NAME       users.name VARCHAR(255), same file. Enforced on the signup
//                  chain AND inside safeOAuthDisplayName, because the OAuth
//                  paths reach that column without passing a chain.
//   MAX_PASSWORD   the same 1024 routes/users.js chose, for the same reason:
//                  bcrypt ignores everything past 72 BYTES, so no character
//                  beyond that can change a hash or a compare, and 1024 is
//                  fourteen times the part that can matter. Deliberately
//                  generous because this router has never had a maximum, so a
//                  longer password may already exist and must still be typeable
//                  at /login. (Two long passwords sharing a 72-byte prefix are
//                  interchangeable and a bound cannot change that; see the note
//                  on the /login password rule.)
//   MAX_INTERESTS / MAX_INTEREST_LEN
//                  interests is TEXT[] and has no width to borrow, so both come
//                  from the product, exactly as in routes/users.js: the
//                  interests screen in frontend/src/App.js offers 12 suggestions
//                  on top of 3 defaults, so 15 chips are reachable without
//                  typing, and 30 is double that; the longest interest the
//                  product itself defines is "art & culture" (13 characters, the
//                  interestToTM map in routes/events.js) and 40 is three times
//                  that.
//   MAX_DOB_LENGTH the longest ISO 8601 instant is 29 characters
//                  (2000-01-01T00:00:00.000+05:30). 40 leaves room for a longer
//                  offset spelling and is still nowhere near a value pg would
//                  accept for a DATE. It matters because ISO_DATE_RE below ends
//                  in `.*`, which bounds nothing at all.
//   MAX_LINK_TOKEN the token grammar this file mints: a 32-character hex
//                  selector, a dot, and a base64url verifier that
//                  parseVerificationToken caps at 128 — 161 characters at the
//                  widest. 200 is the number parseVerificationToken has always
//                  refused past; it is named here so the validator chains and
//                  the parser cannot drift apart.
//   MAX_OAUTH_TOKEN
//                  an RS256 JWT from either provider: a fixed 344-character
//                  signature, a ~50-character header, and a claim set of a dozen
//                  short fields — a Google ID token carrying name and picture
//                  measures well under 1,500 characters. 4096 is comfortably
//                  past that and still an eighth of the parser's 64KB. Also used
//                  for Apple's authorizationCode, which is an opaque ~50
//                  characters and only ever needs a ceiling.
//   MAX_OAUTH_ACCESS_TOKEN
//                  the one field on this router that is interpolated into an
//                  outbound URL (`tokeninfo?access_token=…`). Google's opaque
//                  access tokens run 100-250 characters; the bound is set by
//                  what the request LINE can carry, since encodeURIComponent can
//                  triple a byte: 3 x 2048 + the 62-character prefix = 6,206,
//                  inside the 8,192-byte request line nginx and Apache both
//                  default to.
//   MAX_OAUTH_ID   users.oauth_id VARCHAR(255) (migration 001). Provider data
//                  rather than caller data — a Google `sub` is 21 digits and an
//                  Apple one about 44 — so this is a backstop on the one
//                  remaining value this file writes to a bounded column without
//                  measuring it, not a gate anybody can reach.
const MAX_EMAIL = 255;
const MAX_OAUTH_ID = 255;
const MAX_NAME = 255;
const MAX_PASSWORD = 1024;
const MAX_INTERESTS = 30;
const MAX_INTEREST_LEN = 40;
const MAX_DOB_LENGTH = 40;
const MAX_LINK_TOKEN = 200;
const MAX_OAUTH_TOKEN = 4096;
const MAX_OAUTH_ACCESS_TOKEN = 2048;

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
// Delegated to the mailer's own test, which is the one that decides. This file
// used to carry a weaker copy (an @ sign and a .invalid suffix), so an address
// the mailer would refuse still minted a live token row and spent a slot of the
// hourly budget on mail that was never attempted. emailService's own export
// block has asked for this move since it was written.
function isMailableAddress(addr) {
  return emailServiceIsMailable(addr);
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
  if (t.length < 40 || t.length > MAX_LINK_TOKEN) return null;
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

// ---------------------------------------------------------------------------
// WHEN A MAIL BUDGET FREES ITS NEXT SLOT.
//
// Both budgets in this file are counted in SQL over ROLLING windows, one an
// hour long and one a DAY long, plus a fixed minimum gap between sends. Their
// refusals both said "try again in a few minutes", which is true of the gap and
// of nothing else: somebody who asked for five verification links inside an
// hour waits an hour, and somebody who asked for ten inside a day waits until
// the oldest of those ten is a day old. The daily leg is the one that matters
// most, because the two things it locks a person out of are confirming their
// email and recovering their password.
//
// The exact instant is knowable from the same table the counts came from: the
// row that has to age out of the window is the (count - limit + 1)-th oldest
// one inside it. That is what the OFFSET below selects. Only the legs that are
// actually exhausted are consulted, and the answer is the LATEST of them,
// because a caller freed by the hour and still held by the day is not free.
//
// Run only on the refusal path. It is one extra indexed read on a request that
// is already being turned away, and it is never on the path of a send.
// ---------------------------------------------------------------------------
// EVERY BOUND PARAMETER MUST BE REFERENCED. Postgres infers a parameter's type
// from where it is used, so a statement that binds $1 and never mentions it
// fails outright with "could not determine data type of parameter $1". Only the
// EXHAUSTED legs appear in this query, so which parameters exist depends on the
// refusal, and a fixed [key, ip, ...] list would have been unreferenced roughly
// half the time. Binding on demand keeps the two in step by construction;
// __tests__/rateLimitHonesty.test.js pins it.
//
// The interval strings are literals from the caller's own array, never anything
// off a request, which is why they can be interpolated. Every value that came
// from outside is a parameter.
function buildMailBudgetQuery(table, keyColumn, key, ip, legs) {
  const params = [];
  const bind = (value) => { params.push(value); return `$${params.length}`; };
  const parts = [];
  for (const leg of legs) {
    if (!leg.exhausted) continue;
    const column = leg.scope === 'ip' ? 'request_ip' : keyColumn;
    const match = bind(leg.scope === 'ip' ? (ip || null) : key);
    // How many rows have to age out before a slot exists. Zero when the count
    // sits exactly on the limit, which is the ordinary case.
    const offset = bind(Math.max(0, leg.count - leg.limit));
    parts.push(
      `(SELECT created_at FROM ${table}
         WHERE ${column} = ${match} AND created_at > NOW() - INTERVAL '${leg.interval}'
         ORDER BY created_at ASC OFFSET ${offset}::int LIMIT 1) + INTERVAL '${leg.interval}'`
    );
  }
  if (parts.length === 0) return null;
  // GREATEST ignores NULLs and answers NULL only when every argument is NULL,
  // so a leg with no matching row simply does not vote.
  return { sql: `SELECT GREATEST(${parts.join(', ')}) AS frees_at`, params };
}

async function mailBudgetRetryMs(table, keyColumn, key, ip, legs) {
  const q = buildMailBudgetQuery(table, keyColumn, key, ip, legs);
  if (!q) return 0;
  try {
    const { rows } = await pool.query(q.sql, q.params);
    const freesAt = rows[0] && rows[0].frees_at ? new Date(rows[0].frees_at).getTime() : 0;
    return Math.max(0, freesAt - Date.now());
  } catch (err) {
    // A refusal must not become a 500 because the follow-up read failed. Say
    // nothing about the window rather than say something invented: waitPhrase(0)
    // is "in a moment", which over-promises by seconds where the alternative
    // over-promises by a day.
    console.warn('[auth] could not read the mail budget reset time:', err.message);
    return 0;
  }
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
// How long a DEAD password_resets row (used, or past its expiry) is kept before
// the sweep takes it. The same 7 days as the request ledger, for the same
// reason: nothing load-bearing reads a dead row — the only reader is the
// /reset-password/check screen saying "used" or "expired" honestly to someone
// clicking a stale mail, and a week of that is generous for a link that lived
// 60 minutes. Past the window the row is only a token hash and a request IP
// with nobody left to serve, i.e. dead PII.
const RESET_ROW_RETENTION_DAYS = 7;
let lastResetPurge = 0;
// In-flight sweep promises, tracked the same way pendingResetMail is and for
// the same reason: the request never awaits them, tests can.
const pendingResetSweeps = new Set();
function sweepInBackground(label, factory) {
  let p;
  p = Promise.resolve()
    .then(factory)
    .catch((err) => console.error(`[auth] ${label} purge failed:`, err.message))
    .finally(() => pendingResetSweeps.delete(p));
  pendingResetSweeps.add(p);
}
function maybePurgeResetRequests() {
  const now = Date.now();
  if (now - lastResetPurge < RESET_PURGE_INTERVAL_MS) return;
  lastResetPurge = now;
  sweepInBackground('reset request', () => pool.query(
    "DELETE FROM password_reset_requests WHERE created_at < NOW() - INTERVAL '7 days'"
  ));
  // The token rows themselves. Only rows that are ALREADY dead — spent, or past
  // their expiry — and old enough that the check screen is done with them. The
  // dead-state condition, not the age alone, is what makes this sweep unable to
  // touch a live link: a row a reset could still consume has expires_at in the
  // future by definition, so no retention boundary race exists — anything the
  // DELETE can take has been un-consumable for at least the whole window minus
  // the 60-minute TTL. Never touches used_at/expires_at semantics; it only
  // removes rows those semantics have already finished with.
  sweepInBackground('reset token', () => pool.query(
    `DELETE FROM password_resets
      WHERE (used_at IS NOT NULL OR expires_at <= NOW())
        AND created_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [RESET_ROW_RETENTION_DAYS]
  ));
}

// Issue a link, retiring any older unused one for the account in the same
// breath, so at most ONE live reset link exists per account at a time.
async function issueReset(user, ip) {
  const { selector, verifierHash, token } = mintVerificationToken();
  // DELETED, not stamped used. Retiring an older link and SPENDING one used to
  // write the same column, so /reset-password/check could not tell them apart
  // and answered 'used' for both. The copy behind 'used' says "if you did not
  // set a new password, ask for a new link now and change the password, because
  // someone else opened this one", which is a break-in warning. Ask for a reset,
  // see nothing arrive, wait out the sixty second gap, ask again, then open the
  // first mail because it is higher in the thread: the app accused an intruder
  // who did not exist. A missing row answers 'invalid', whose copy already says
  // the true thing, that a newer link replaced this one and only the newest one
  // works. consumeReset still STAMPS its siblings, because there the warning is
  // the right one: a link really was spent.
  await pool.query(
    'DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL',
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
  return { ok: true, userId: row.user_id, email: row.current_email };
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

// Evict down to 90%, not to the ceiling: stopping exactly at the ceiling makes
// a map held at the ceiling sort itself on every failed login, which is a CPU
// lever an unauthenticated caller controls. Same low-water rule and the same
// number as routes/publicCrowd.js and utils/probeBudget.js.
const LOGIN_FAIL_LOW_WATER = Math.floor(LOGIN_FAIL_MAX_KEYS * 0.9);

// SECURITY-AUDIT-auth.md R2-2 (MEDIUM). This used to end in
// `loginFailures.clear()`, which reset EVERY account's counter at once — and
// `key` is a canonical address off an UNAUTHENTICATED route, so the caller
// chose when that happened. Credential-stuff `victim@example.com` to the
// 10-failure lockout, then fire 20,001 failures at distinct random addresses;
// the 20,001st wiped the victim's counter and the run resumed from zero. The
// control got weaker the harder it was pushed, which is the exact anti-pattern
// routes/publicCrowd.js, routes/venueSearch.js, routes/safety.js,
// routes/checkin.js, routes/friends.js and utils/blocks.js each already carry a
// comment about. The two maps in this file were the ones that sweep missed.
//
// Expire first, then evict LEAST CONSUMED first — never clear(). Consumption
// order, not insertion age, for the reason publicCrowd.js spells out and which
// is sharpest here: the entry the attacker wants gone is the victim's, and the
// victim's entry is both the OLDEST and the FULLEST (count 10). An age-ordered
// drop would delete precisely that one. Lowest-count-first deletes the
// flooder's own single-failure entries instead, so displacing a locked entry
// costs ~20,000 addresses that have EACH already been failed 10 times — two
// hundred thousand attempts through a 10/min per-IP limiter, which is no longer
// a shortcut past the throttle, it is the throttle.
function evictLoginFailures(now) {
  for (const [k, v] of loginFailures) if (now >= v.expiresAt) loginFailures.delete(k);
  if (loginFailures.size <= LOGIN_FAIL_MAX_KEYS) return;
  const byConsumption = [...loginFailures.entries()].sort((a, b) => a[1].count - b[1].count);
  for (const [k] of byConsumption) {
    if (loginFailures.size <= LOGIN_FAIL_LOW_WATER) break;
    loginFailures.delete(k);
  }
}

function recordLoginFailure(key, now = Date.now()) {
  // Bounded: an attacker cycling addresses must not grow this without limit.
  if (loginFailures.size > LOGIN_FAIL_MAX_KEYS) evictLoginFailures(now);
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
// Provider ID token replay — Apple (round 16) AND Google (round 22)
// ---------------------------------------------------------------------------
// A provider identity token is a bearer credential and was accepted here as
// many times as anyone cared to present it. Anything that saw one once — a
// proxy log, a crash report, an analytics SDK that captured the request body, a
// shared device's URL history — could sign in as that user for the rest of the
// window. Nothing in the previous code made a token single-use.
//
// ONE cache for BOTH providers (SECURITY-AUDIT-auth.md R2-3). Round 16 built
// this for Apple only, and the Google handler sitting immediately below it in
// the same file got neither this nor the nonce check — so the provider with the
// LONGER window was the unprotected one: a Google ID token lives ~1 hour
// against Apple's ~10 minutes. That mattered more than "one extra session",
// because the Flock JWT a replay mints carries a fresh `iat`, and a fresh `iat`
// is the entire sudo-mode proof for an OAuth account (hasFreshSession in
// routes/users.js) — so one captured credential reached account deletion, the
// phone-number change and the full data export.
//
// It is one Map rather than two so the two paths cannot drift again. Collision
// is not a concern: the key is namespaced by provider and built out of values
// the provider's own signature fixes, so an Apple token and a Google token
// cannot share one.
//
// The entry outlives the token itself (see OAUTH_REPLAY_MAX_TTL_MS below), so
// the cache is bounded by the providers' own acceptance windows rather than
// growing. A token is recorded only when the sign-in SUCCEEDS: a client
// retrying after a transient 503 from Apple's code exchange must not be told
// its own token was replayed, which would turn one upstream blip into a hard
// sign-in failure.
//
// In-memory, therefore per process — a real ceiling on the single-instance
// Railway deployment and a partial one behind N instances, exactly like the
// login throttle above. The nonce check below is the part that does not depend
// on process affinity, once clients send one.
//
// KEYED ON THE VERIFIED IDENTITY, NOT ON THE WIRE STRING (round 23, R3-A2).
// This cache used to key on SHA-256 of the credential STRING, and a JWT's wire
// string is not a canonical encoding of the credential it carries. An RS256
// signature is 256 bytes; its base64url segment is 342 characters carrying
// 2,052 bits, of which 2,048 are used - so the FINAL character has 4 bits that
// decode to nothing, i.e. 16 characters that decode to the identical
// signature. Round 3 measured this against this repo's own installed copies:
// google-auth-library and jsonwebtoken accept all 16, all 16 satisfy the shape
// regex on the Google path, and all 16 hash differently. One captured
// credential therefore minted SIXTEEN accepted sign-ins on BOTH providers,
// each with a fresh `iat` - and a fresh `iat` is the whole sudo-mode proof for
// account deletion, the phone-number change and the data export.
//
// The key is now derived from the DECODED token: the claims the provider's
// signature fixes (iss/aud/azp/sub/iat/exp/nonce/jti/at_hash), plus the
// canonical spelling of the DECODED signature bytes. Both halves are identical
// across all 16 spellings of one credential - base64url decoding drops the
// unused trailing bits, which is precisely why both verifiers accept all 16 -
// and both differ for a genuinely new token. Nothing in the key can be varied
// without breaking verification, so this is not a "canonicalise the input"
// gamble: every part of it is read off the token the verifier just accepted.
//
// Why not `sub` alone, which is what the string key was originally chosen
// over: that refuses the user's NEXT legitimate sign-in rather than the replay
// of this one. Why the signature as well as the claims: two genuine tokens
// minted for one user in the same wall-clock second share `iat` and `exp`, and
// their bytes are the only thing that tells them apart.
//
// Because that identity only exists AFTER verification, the check moved to
// after it at both call sites. The cheap pre-verify guards stay: the shape
// regex on the Google path, jsonwebtoken's own parse on the Apple one, so a
// malformed token still costs nothing.
const OAUTH_REPLAY_MAX_KEYS = 20000;
// RETENTION COVERS THE REAL ACCEPTANCE WINDOW (round 23, R3-A1). An entry has
// to outlive the token it protects, and a token is accepted until `exp` PLUS
// the verifier's clock skew:
//   * Google - `exp` is `iat + 3600` (60 min) and google-auth-library adds
//     OAuth2Client.CLOCK_SKEW_SECS_ = 300 s, so ~65 minutes of acceptance.
//   * Apple  - `exp` is `iat + 600` (10 min) and jsonwebtoken's clockTolerance
//     defaults to 0, so ~10 minutes.
// The cap was 15 minutes, inherited from when this cache was Apple-only, where
// 15 > 10 made it true. Against Google it lapsed ~50 minutes before the
// credential did, so the same unmodified credential minted another session
// after a 15-minute wait, with no encoding trick at all. The TTL is now
// derived per token from that token's own `exp` + skew; the cap below is the
// backstop for a token with no usable `exp`, and it must be at least the
// longest acceptance window of the two providers: 70 >= 65.
const OAUTH_VERIFIER_SKEW_MS = 5 * 60 * 1000;
const OAUTH_REPLAY_MAX_TTL_MS = 70 * 60 * 1000;
const OAUTH_REPLAY_MIN_TTL_MS = 60 * 1000;
// Same low-water rule as the login throttle above and routes/publicCrowd.js.
// Worst case the map holds 20,000 entries of a 64-character hex key and a
// number, i.e. single-digit megabytes, for at most 70 minutes each.
const OAUTH_REPLAY_LOW_WATER = Math.floor(OAUTH_REPLAY_MAX_KEYS * 0.9);
const oauthTokensUsed = new Map();

// The claims that identify ONE issuance of one credential. Every one of them
// is covered by the provider's signature, so adding a claim can only make two
// genuinely different tokens easier to tell apart - it can never let a replay
// of the SAME token produce a different key.
const OAUTH_IDENTITY_CLAIMS = ['iss', 'aud', 'azp', 'sub', 'iat', 'exp', 'nonce', 'jti', 'at_hash'];

// Canonical spelling of the signature segment: decode, then re-encode. All 16
// spellings of one RS256 signature decode to the same 256 bytes, so they all
// re-encode to the same string. A segment too short to decode into even one
// byte cannot be an RS256 signature (a real one is 256 bytes, and nothing that
// short survives verifyIdToken or jwt.verify), so that degenerate case keeps
// the raw segment rather than collapsing every such value onto one key.
function canonicalJwtSignature(rawToken) {
  const segments = String(rawToken == null ? '' : rawToken).split('.');
  if (segments.length !== 3) return null;
  const bytes = Buffer.from(segments[2], 'base64url');
  return bytes.length > 0 ? bytes.toString('base64url') : segments[2];
}

// Returns null when the token cannot be identified at all - no `sub`, or not
// three segments. Callers FAIL CLOSED on null: a credential we cannot key is a
// credential we cannot make single-use.
function oauthIdentityKey(provider, payload, rawToken) {
  if (!payload || typeof payload !== 'object') return null;
  const sub = payload.sub == null ? '' : String(payload.sub);
  if (!sub) return null;
  const signature = canonicalJwtSignature(rawToken);
  if (signature === null) return null;
  const parts = [String(provider), signature];
  for (const claim of OAUTH_IDENTITY_CLAIMS) {
    const value = payload[claim];
    // `aud` is an array in some issuers' tokens; everything else is scalar.
    parts.push(Array.isArray(value) ? value.map(String).join(',') : (value == null ? '' : String(value)));
  }
  // Length-prefixed so no combination of claim values can spell another one.
  return crypto.createHash('sha256')
    .update(parts.map((part) => `${part.length}:${part}`).join('|'))
    .digest('hex');
}

// ROUND 25 (R5-H2) — THE ACCESS-TOKEN BRANCH'S REPLAY KEY. oauthIdentityKey
// above cannot key an access token: it is an opaque bearer string, not a JWT,
// so there is no payload to read and no signature segment to canonicalise. It
// needs neither. A JWT has sixteen wire spellings of one signature, which is
// the whole reason that function exists; an access token has exactly one
// spelling, because the string IS the credential — Google's tokeninfo accepts
// nothing else. A digest of it is therefore already canonical.
//
// Labelled, so an access-token entry and an ID-token entry can never collide in
// the one map they share.
function googleAccessTokenKey(accessToken) {
  if (typeof accessToken !== 'string' || accessToken === '') return null;
  return crypto.createHash('sha256').update(`google:access_token:${accessToken}`).digest('hex');
}

function oauthIdentityWasUsed(identityKey, now = Date.now()) {
  if (!identityKey) return false;
  const expiresAt = oauthTokensUsed.get(identityKey);
  if (!expiresAt) return false;
  // Strictly greater, so the entry is still remembered AT the last instant the
  // verifier still accepts the token: google-auth-library refuses on
  // `exp < now - skew`, so `exp + skew` itself is still an accepted instant.
  if (now > expiresAt) {
    oauthTokensUsed.delete(identityKey);
    return false;
  }
  return true;
}

function markOauthIdentityUsed(identityKey, expSeconds, now = Date.now()) {
  if (!identityKey) return;
  if (oauthTokensUsed.size > OAUTH_REPLAY_MAX_KEYS) {
    for (const [k, v] of oauthTokensUsed) if (now >= v) oauthTokensUsed.delete(k);
    // R2-2's anti-pattern, on the map whose whole job is refusing replays: this
    // was `oauthTokensUsed.clear()`, so flooding it made every token in it
    // replayable again — the cache got weaker exactly when it was pushed. Evict
    // SOONEST-TO-EXPIRE first instead, down to a low-water mark. A fresh junk
    // entry always carries a later expiry than a real one already sitting in
    // the map, so a flooder can only push out entries that were about to lapse
    // anyway, and never the whole cache.
    if (oauthTokensUsed.size > OAUTH_REPLAY_MAX_KEYS) {
      const bySoonest = [...oauthTokensUsed.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k] of bySoonest) {
        if (oauthTokensUsed.size <= OAUTH_REPLAY_LOW_WATER) break;
        oauthTokensUsed.delete(k);
      }
    }
  }
  // `exp + skew`, not `exp`: the last instant the verifier still accepts this
  // credential is the last instant the entry has to exist for.
  const exp = Number(expSeconds);
  const acceptedUntil = Number.isFinite(exp)
    ? exp * 1000 + OAUTH_VERIFIER_SKEW_MS
    : now + OAUTH_REPLAY_MAX_TTL_MS;
  const ttl = Math.min(Math.max(acceptedUntil - now, OAUTH_REPLAY_MIN_TTL_MS), OAUTH_REPLAY_MAX_TTL_MS);
  oauthTokensUsed.set(identityKey, now + ttl);
}

// R4-A1 — CLAIM-AND-RELEASE. DO NOT "simplify" this back into
// `if (oauthIdentityWasUsed(k)) return 401; … await …; markOauthIdentityUsed(k)`.
//
// That shape is what round 4 found. The CHECK and the RECORD were separated by
// four-plus `await pool.query` calls, and every `await` yields the event loop,
// so N SIMULTANEOUS presentations of one captured credential all read an empty
// cache before any of them wrote to it. All N minted a session with a fresh
// `iat`, and a fresh `iat` is the entire sudo-mode proof for an OAuth account
// (hasFreshSession in routes/users.js): account deletion, the phone-number
// change and the full data export are reachable from each one. Round 3's
// re-keying (R3-A2) fixed WHICH key is written and left WHEN it is written
// alone, so it closed sequential replay and did nothing to the parallel case.
//
// The contract, in two halves. Both halves are load-bearing:
//
//   CLAIM — check-and-record in ONE synchronous step, with no `await` between
//   the read and the write. A Map get/set pair runs to completion inside a
//   single event-loop turn, so the second concurrent presentation of the same
//   credential observes the first one's entry and loses. This is the whole fix;
//   it needs no lock because in-process JS has no preemption.
//
//   RELEASE — the pre-existing behaviour, which the round-22/23 comments on
//   both handlers spell out, is that a REFUSED or FAILED sign-in must leave the
//   credential USABLE: a `needsDob` 403 tells the client to collect a birthday
//   and come back with the SAME credential, and a transient upstream 503 (Apple
//   code exchange) must be retryable without pushing the user back through the
//   provider sheet. Claiming up front burns the credential before those paths
//   run, so every non-success exit has to hand it back. Both handlers do that
//   in a `finally` rather than at each `return`, because there are a dozen-plus
//   refusal branches between the claim and the success line and enumerating
//   them is how one gets missed — and a missed release is not a small bug, it
//   is a permanent lockout for a user whose first attempt hit a blip.
//
// The success line therefore does not re-record anything; it only sets the
// committed flag that tells `finally` to keep the claim.
function claimOauthIdentity(identityKey, expSeconds, now = Date.now()) {
  if (!identityKey) return false;
  // No `await` between these two calls. That is the invariant.
  if (oauthIdentityWasUsed(identityKey, now)) return false;
  markOauthIdentityUsed(identityKey, expSeconds, now);
  return true;
}

// Only ever called by the request that WON the claim (a loser never records
// `claimedIdentity`, so it can never delete the winner's entry), and only when
// that request did not reach its success line.
function releaseOauthIdentityClaim(identityKey) {
  if (!identityKey) return;
  oauthTokensUsed.delete(identityKey);
}

// Server-issued OAuth nonces, shared by Apple and Google for the same reason
// the replay cache above is shared: two stores drift, and the drift is exactly
// what R2-3 found. POST /api/auth/apple/nonce and POST /api/auth/google/nonce
// both hand one out of this store; the client passes it to the provider (Apple
// native SDKs want SHA-256 of it, Apple's JS SDK hashes it for you, Google
// Identity Services echoes the raw value) and sends the raw value back with the
// identity token. We accept either spelling in the token's `nonce` claim,
// compared in constant time, and the nonce is spent on first use.
//
// Not yet required on either provider, because no shipped client sends one and
// hard-requiring it would break every existing OAuth sign-in on deploy.
// APPLE_REQUIRE_NONCE=true / GOOGLE_REQUIRE_NONCE=true flip each to mandatory
// once that client is updated. Until then the replay cache above is what
// actually stops a replayed token.
const OAUTH_NONCE_TTL_MS = 10 * 60 * 1000;
const OAUTH_NONCE_MAX_KEYS = 20000;
const OAUTH_NONCE_LOW_WATER = Math.floor(OAUTH_NONCE_MAX_KEYS * 0.9);
const oauthNonces = new Map();

function issueOauthNonce(now = Date.now()) {
  if (oauthNonces.size > OAUTH_NONCE_MAX_KEYS) {
    for (const [k, v] of oauthNonces) if (now >= v) oauthNonces.delete(k);
    // R2-10: `oauthNonces.clear()` here was reachable from the unauthenticated
    // nonce endpoints, so anyone could invalidate every outstanding nonce and
    // make in-flight sign-ins fail. Bounded eviction, soonest-to-expire first,
    // for the same reason the replay cache above uses it.
    if (oauthNonces.size > OAUTH_NONCE_MAX_KEYS) {
      const bySoonest = [...oauthNonces.entries()].sort((a, b) => a[1] - b[1]);
      for (const [k] of bySoonest) {
        if (oauthNonces.size <= OAUTH_NONCE_LOW_WATER) break;
        oauthNonces.delete(k);
      }
    }
  }
  const nonce = crypto.randomBytes(24).toString('base64url');
  oauthNonces.set(nonce, now + OAUTH_NONCE_TTL_MS);
  return nonce;
}

// Checked and SPENT separately, for the same reason the identity token is only
// recorded on success: if a failed attempt burned the nonce, one transient 503
// from Apple's code exchange would force the user back through the whole Apple
// authorization sheet instead of letting the client retry. Validity is checked
// early, the nonce is spent next to markOauthIdentityUsed.
function oauthNonceValid(nonce, now = Date.now()) {
  const expiresAt = oauthNonces.get(nonce);
  if (!expiresAt) return false;
  if (now >= expiresAt) { oauthNonces.delete(nonce); return false; }
  return true;
}

function spendOauthNonce(nonce) {
  if (nonce) oauthNonces.delete(nonce);
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
// itself and echoes the hash; native SDKs echo whatever was set; Google echoes
// the raw value) or its SHA-256 hex digest. Accept both, in constant time.
function oauthNonceClaimMatches(tokenNonce, suppliedNonce) {
  const hashed = crypto.createHash('sha256').update(String(suppliedNonce)).digest('hex');
  const rawOk = constantTimeEquals(tokenNonce, suppliedNonce);
  const hashOk = constantTimeEquals(tokenNonce, hashed);
  return rawOk || hashOk;
}

// Age gate (C4) — SERVER-SIDE enforcement. The mobile neutral age screen collects
// a DOB and sends it at account creation; we compute age here so the under-13
// block survives local-storage clears / reinstalls and is recorded on the user row.
//
// THE LAW THIS IMPLEMENTS (minors-compliance audit 2026-08-14). Flock is a
// 13+ service, so under COPPA (16 CFR Part 312) it is not "directed to
// children" — the Rule attaches only if we have ACTUAL KNOWLEDGE that a
// particular user is under 13 (§312.2, "operator"; §312.3). The amended Rule
// (90 FR, compliance date 2026-04-22) codifies the mixed-audience age screen,
// and the FTC's COPPA FAQ sets three requirements this block answers for:
//   1. the screen must be NEUTRAL — ask for a birth date, and do not word the
//      refusal so it teaches the child which date passes. UNDERAGE_MSG below
//      therefore names no age; the "13+" fact lives in the Terms, not in the
//      refusal a 12-year-old is staring at with the form still filled in;
//   2. the operator must take steps against the refused child simply
//      re-entering an older date (the FAQ's example is a cookie against
//      back-buttoning) — that is the underageAttempts lockout below;
//   3. once we KNOW a user is under 13, the knowledge cannot be un-known:
//      enforceDobOnLogin persists an under-13 date before refusing, so the
//      account freezes on every later sign-in instead of accepting a
//      corrected date. Disposition of the frozen account (deletion, per
//      §312.10's retention limits) is a human/moderation step, not a login
//      handler's.
const { ageFromDob, MIN_AGE } = require('../utils/age');
const UNDERAGE_MSG = "We can't create a Flock account for you.";

// ---------------------------------------------------------------------------
// Under-13 retry lockout (the FAQ's "cookie", server-side)
// ---------------------------------------------------------------------------
// An under-13 refusal is remembered, and while it is remembered the SAME
// mailbox (24h) or SAME IP (15 min) cannot create an account even with a
// passing date — the same neutral sentence answers, so the refusal still
// teaches nothing. The IP window is deliberately short for the reason the mail
// budgets above are loose per-IP: signups come off shared school and campus
// NATs, and a long IP block would refuse real 13+ users because a younger
// sibling tried first from the same address. The mailbox key carries the
// strong signal — the same email retrying with a new birthday IS the
// back-button case the FTC FAQ describes.
//
// ROUND 25: "the SAME mailbox (24h)" is now two different memories depending on
// whether the address was PROVED or merely ASSERTED by the caller, because an
// address asserted by an unauthenticated caller is a write primitive against
// whoever really owns it. recordUnderageAttempt carries the full argument; do
// not collapse the two spellings back into one without reading it.
//
// Keys are keyed HMAC digests, never plaintext, for the same reason
// resetBucketKey digests its addresses — and more so here, because this map is
// by construction a list of addresses children typed. The FAQ's safe harbor
// for age-screen data is exactly "use it only to determine age, keep it no
// longer than necessary": a digest can answer "is this a retry?" and nothing
// else, and it expires. In-memory and bounded like the login throttle: per
// process, reset on deploy, a real ceiling on the single-instance deployment.
const UNDERAGE_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;
const UNDERAGE_IP_TTL_MS = 15 * 60 * 1000;
// The whole map's ceiling, and the only thing that triggers an eviction pass.
const UNDERAGE_MAX_KEYS = 20000;
// SECURITY-AUDIT-auth.md A5-2 (MEDIUM): the two kinds of entry get SEPARATE
// budgets, and the two shares add up to exactly UNDERAGE_MAX_KEYS. That
// equality is load-bearing — see evictUnderageAttempts for why an eviction pass
// can never run and find nothing to do.
//
// The split is 90/10 because the two classes hold wildly different populations:
// an email entry lives 24 hours and an IP entry 15 minutes, so at any real
// arrival rate there are one to two orders of magnitude more live email
// entries. 2,000 distinct source addresses inside a fifteen-minute window is
// already an extraordinary flood, and giving IP more would only shrink the
// email class it can no longer touch.
const UNDERAGE_EMAIL_MAX_KEYS = 18000;
const UNDERAGE_IP_MAX_KEYS = 2000;
// Evict down to a low water rather than to the ceiling, for the reason
// evictLoginFailures above spells out: a class held AT its ceiling sorts itself
// on every refused signup, which is a CPU lever an unauthenticated caller
// controls. The email class uses the house 90%. The IP class uses 50% instead,
// because it is a tenth the size and a proportional gap would leave only 200
// writes between full passes; at 50% there are at least a thousand.
const UNDERAGE_EMAIL_LOW_WATER = Math.floor(UNDERAGE_EMAIL_MAX_KEYS * 0.9);
const UNDERAGE_IP_LOW_WATER = Math.floor(UNDERAGE_IP_MAX_KEYS * 0.5);
// The floor no flood can push the map below. Exported under the old name
// because that is what it has always meant: the count the eviction may not go
// under. It is the email class's low water because the email class is the one
// with a caller-chosen key.
const UNDERAGE_LOW_WATER = UNDERAGE_EMAIL_LOW_WATER;
const underageAttempts = new Map();

// The key carries its CLASS in plaintext ahead of the digest. That is what lets
// the eviction below tell an email entry from an IP entry without a second map
// and without changing the value shape, and it leaks nothing: the kind is
// already implied by which argument the caller filled in, and the address
// itself stays inside the keyed digest.
function underageDigest(label, canonical) {
  const pepper = process.env.BAN_TOMBSTONE_SECRET || process.env.JWT_SECRET || '';
  return pepper
    ? crypto.createHmac('sha256', pepper).update(`underage:${label}:${canonical}`).digest('hex')
    : crypto.createHash('sha256').update(`underage:${label}:${canonical}`).digest('hex');
}

function underageKey(kind, value) {
  const canonical = kind === 'email' ? canonicalEmail(value) : String(value);
  return `${kind}:${underageDigest(kind, canonical)}`;
}

// ROUND 25 (R5-H1) — THE SECOND SPELLING OF AN EMAIL ENTRY, and the whole of
// the lockout-versus-write-primitive fix. See recordUnderageAttempt below for
// the reasoning; this is only the key.
//
// It lives in the SAME `email:` class as underageKey('email', …): identical
// TTL, identical budget, identical eviction ordering. Nothing about the A5-2
// segmentation argument changes, because from the eviction's point of view
// this is just another email entry. What changes is who it bites.
//
// The digest label is `email+ip`, not `email`, so the two spellings can never
// collide: a plaintext address is hashed under one label and an
// address-plus-source-address pair under the other, and no value of one can
// ever produce the digest of the other. The two halves of the pair are joined
// on a NUL, which cannot occur in either a canonical address or an IP string,
// so no pair can be spelled as a different pair.
function underagePairKey(email, ip) {
  return `email:${underageDigest('email+ip', `${canonicalEmail(email)}\u0000${String(ip)}`)}`;
}

// ROUND 23 (cache-key inventory sweep). This map's memory guard used to end in
// `underageAttempts.clear()` — the LAST wholesale clear() on a caller-keyed map
// in the backend, and the one with the worst thing behind it. Every sibling map
// in this file (loginFailures ~400 lines up, oauthNonces ~100 lines up) was
// converted to bounded eviction and this one was missed, ninety lines below the
// second of those fixes.
//
// THE EXPLOIT IT ALLOWED. The email half of the key is chosen by an
// UNAUTHENTICATED caller: POST /signup with any address and an under-13 date of
// birth writes one entry. 20,001 refused signups with distinct addresses tipped
// the map past the ceiling and wiped every remembered refusal at once — not
// just the flooder's own, but every OTHER refused mailbox AND every IP block,
// which are what the FTC FAQ's "steps against the child simply re-entering an
// older date" actually rest on. The age gate on a 13+ service was resettable on
// demand, by anyone, at a moment they chose. The control got weaker the harder
// it was pushed, which is the exact anti-pattern the two maps above already
// carry comments about.
//
// ROUND 5 (SECURITY-AUDIT-auth.md A5-2, MEDIUM) — THE ORDER, CORRECTED.
//
// Round 23 evicted longest-remaining-lifetime first over ONE undivided map and
// claimed two properties for it. The audit executed both. The second held
// absolutely (600,000 refusals never touched an IP block). The first was FALSE
// the moment the flood rotated its source address, and the auditor built the
// counter-example: **18,009 refused signups from rotating addresses evicted a
// pre-existing 24-hour email block.**
//
// WHY IT FAILED. One refusal writes TWO entries, not one: an email entry at
// now + 24h and an IP entry at now + 15 min. With a single source address the
// IP key is rewritten in place, the map is ~100% email entries, and the
// argument below works exactly as it was written. With rotating addresses half
// of every write is a 15-minute IP entry, and under longest-remaining-first
// those sort to the IMMUNE end of one shared ordering — they can never be
// reached while any email entry remains. So every eviction pass spent its whole
// 2,000-entry budget on email entries while only ~1,000 email entries had
// arrived since the last pass, and the email population was eaten backwards,
// newest to oldest, at a net 1,000 per pass, until it reached the oldest entry
// in the map: the victim's.
//
// THE FIX: TWO BUDGETS, NOT ONE ORDERING. Email entries and IP entries are now
// counted, capped and evicted SEPARATELY (UNDERAGE_EMAIL_MAX_KEYS /
// UNDERAGE_IP_MAX_KEYS). Neither class can spend a single deletion on the
// other, so the "immune end" that made the flood work does not exist. Two
// alternatives were weighed and rejected:
//   * sorting on remaining lifetime as a FRACTION of each entry's own TTL —
//     one line, but it makes the two classes compete on a scale that has no
//     operational meaning, and a later change to either TTL silently re-tunes
//     which class gets deleted;
//   * evicting by insertion age within one map — the ordering the round-23
//     comment argues AGAINST, correctly: the victim's entry is the oldest one
//     there, so age-first deletes precisely the entry the attacker wants gone.
// Segmenting is the one that makes the property structural rather than a
// consequence of arithmetic between two constants.
//
// WITHIN A CLASS, still longest-remaining-first — and now that is exactly
// newest-first, because every entry in a class carries the same TTL. That is
// what makes the round-23 claim TRUE for the first time: a flooder's writes are
// the newest entries in their class, so they are always ahead of anything that
// predates them, and a flood consumes itself before it can reach an older
// block. This is the property the test pins, at the auditor's own scale.
//
// WHAT THIS GUARANTEES, stated so the next round can check it rather than
// trust it:
//   1. NO FLOOD CAN EVICT AN ENTRY THAT PREDATES IT, in either class, at any
//      address-rotation rate. 18,009 rotating-address refusals — and 200,000 —
//      leave a victim's email block and a victim's IP block both intact.
//   2. THE TWO CLASSES CANNOT DISPLACE EACH OTHER. An email flood cannot reach
//      an IP block and an IP flood cannot reach an email block, by construction
//      rather than by which TTL happens to be longer.
//
// WHAT IT DOES NOT GUARANTEE, which is the honest residual and is NOT what the
// finding was about:
//   * A caller can still clear their OWN block by waiting out its TTL (24h /
//     15 min). That is what the TTLs are for.
//   * While a flood holds a class at its ceiling, refusals recorded DURING the
//     flood are themselves the newest entries and are the first thing the next
//     pass deletes. A flood cannot erase the past, but it can crowd out the
//     present for as long as it is paying for it. That is inherent to any
//     bounded in-heap map, and the fix for it is not an ordering — it is moving
//     this map out of the heap (Postgres or Redis), which is the same open item
//     the inventory records against every in-memory counter here.
//
// The eviction PASS is triggered by the whole map crossing UNDERAGE_MAX_KEYS,
// and the two class ceilings sum to exactly that number. That equality is what
// makes a pass always find work: if the total is over 20,000 then by pigeonhole
// at least one class is over its own ceiling. Without it, a map sitting at
// 18,000 email + 2,000 IP would sort 20,000 entries on every single refused
// signup and delete nothing — the exact CPU lever the low-water rule exists to
// prevent.
function evictUnderageClass(prefix, maxKeys, lowWater) {
  const mine = [];
  for (const entry of underageAttempts) if (entry[0].startsWith(prefix)) mine.push(entry);
  if (mine.length <= maxKeys) return;
  // Longest remaining first. Within one class every TTL is identical, so this
  // is newest-first: the flooder's own writes, never the older block they are
  // aimed at.
  mine.sort((a, b) => b[1] - a[1]);
  let size = mine.length;
  for (const [k] of mine) {
    if (size <= lowWater) break;
    underageAttempts.delete(k);
    size -= 1;
  }
}

function evictUnderageAttempts(now = Date.now()) {
  for (const [k, v] of underageAttempts) if (now >= v) underageAttempts.delete(k);
  if (underageAttempts.size <= UNDERAGE_MAX_KEYS) return;
  evictUnderageClass('email:', UNDERAGE_EMAIL_MAX_KEYS, UNDERAGE_EMAIL_LOW_WATER);
  evictUnderageClass('ip:', UNDERAGE_IP_MAX_KEYS, UNDERAGE_IP_LOW_WATER);
}

// ROUND 25 (R5-H1, HIGH) — WHO IS ALLOWED TO WRITE A MEMORY ABOUT WHOSE
// MAILBOX. Read this before changing either function below; both halves of the
// tension are real and the code has to hold both.
//
// THE CHILD-SAFETY HALF. The FTC's COPPA FAQ asks a neutral age screen to take
// "reasonable steps" against a child who is refused and simply presses back and
// changes the year. That is what this map is: the FAQ's session cookie, moved
// server-side where the browser cannot clear it. Removing the memory entirely
// would make the age gate a suggestion, which is the round-4/A5-2 finding and
// is not on the table.
//
// THE LOCKOUT HALF, which is what this round found. The EMAIL half of that
// memory used to be written from `POST /api/auth/signup` on an address that is
// nothing more than a string in an UNAUTHENTICATED request body. Nobody proved
// they could read that mailbox. So one request — victim's address, a birthday
// in 2020 — wrote a 24-hour block against a stranger's address, and
// underageBlocked is consulted by password signup AND the Google create branch
// AND the Apple create branch, so all three of the victim's doors answered the
// same neutral refusal. authLimiter allows on the order of 14,400 addresses a
// day from one IP and the block clears only on its TTL or a redeploy, so it was
// a renewable, self-service denial of any chosen person's account, with no way
// for the victim to tell it from a genuine age refusal and no way out.
//
// THE SPLIT. The two halves separate cleanly on one question: WAS THE ADDRESS
// PROVED, or merely ASSERTED?
//
//   PROVED — the caller demonstrated the address is theirs before we ever got
//   here. Either they completed a sign-in on the account that owns it
//   (enforceDobOnLogin, which runs after the password/OAuth check and is
//   recording actual knowledge about a row it just froze), or a provider signed
//   a token vouching for it (the Google and Apple creation branches, with
//   email_verified true). A stranger cannot seed either one, because a stranger
//   cannot produce the password or the provider's signature. These keep the
//   full-strength 24-hour block against the ADDRESS, reachable from any
//   network, which is what stops "back button, new year, different Wi-Fi".
//
//   ASSERTED — the address is a field in an unauthenticated body. The memory is
//   still written, and still for 24 hours, but it is keyed on the address AND
//   the source IP together (underagePairKey). It bites the caller who typed it
//   and nobody else. A child who presses back is on the same network seconds
//   later, so it lands on them; an attacker on a different network cannot reach
//   the victim's own signup at all.
//
// WHY THE IP HALF IS STILL HERE AND STILL 15 MINUTES. It is the half that
// actually models the back button — same device, same network, immediately —
// and it is deliberately short because signups come off shared school and
// campus NATs where a long block refuses real 13+ users. The pair key extends
// that same-network memory to 24 hours for the ONE mailbox that was refused,
// which is a far narrower blast radius than the IP key already has, so it adds
// no collateral the 15-minute key did not already impose.
//
// THE HONEST RESIDUAL. An attacker who shares a NAT with their victim can still
// pin that victim's address from that NAT for 24 hours. They could already deny
// every address on that NAT for 15 minutes, renewably, so this is not a new
// capability against a co-located target — and unlike before, the victim has a
// self-service escape: any other network works immediately.
function recordUnderageAttempt(email, ip, now = Date.now(), { addressProved = false } = {}) {
  // Bounded: a spray of refused signups must not grow this without limit — and
  // must never be able to EMPTY it. Never clear().
  if (underageAttempts.size > UNDERAGE_MAX_KEYS) evictUnderageAttempts(now);
  if (typeof email === 'string' && email.includes('@')) {
    // Exactly one email-class entry per refusal, either way, so the class
    // budget arithmetic above is unchanged. `addressProved` is the caller's
    // assertion that the address was proved BEFORE this call; the default is
    // false, so a call site added later fails toward the narrow key rather
    // than toward the write primitive.
    if (addressProved) {
      underageAttempts.set(underageKey('email', email), now + UNDERAGE_EMAIL_TTL_MS);
    } else if (ip) {
      underageAttempts.set(underagePairKey(email, ip), now + UNDERAGE_EMAIL_TTL_MS);
    }
  }
  if (ip) underageAttempts.set(underageKey('ip', ip), now + UNDERAGE_IP_TTL_MS);
}

function underageBlocked(email, ip, now = Date.now()) {
  const keys = [];
  if (typeof email === 'string' && email.includes('@')) {
    // Both spellings, because a mailbox can have been refused either way and
    // the reader does not know which. Checking the pair key costs one map
    // lookup and is what makes the asserted-address memory bite at all.
    keys.push(underageKey('email', email));
    if (ip) keys.push(underagePairKey(email, ip));
  }
  if (ip) keys.push(underageKey('ip', ip));
  for (const key of keys) {
    const expiresAt = underageAttempts.get(key);
    if (expiresAt === undefined) continue;
    if (now >= expiresAt) { underageAttempts.delete(key); continue; }
    return true;
  }
  return false;
}

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
//
// Round 21: the regex above ends in `.*`, so it bounds the SHAPE of the first
// ten characters and nothing else — `"2000-01-01T" + "x".repeat(60000)` matched
// it, and the only thing that then refused the value was `new Date()` failing to
// parse it. That is a content check standing in for a width check on the three
// paths (login, Google, Apple) where date_of_birth carries no validator chain at
// all. Measure the width here, where the value is turned into something safe to
// store, rather than relying on a Date parse to be the ceiling.
function suppliedDob(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length > MAX_DOB_LENGTH) return null;
  return ISO_DATE_RE.test(trimmed) ? trimmed : null;
}

async function enforceDobOnLogin(user, req, res) {
  // ACTUAL-KNOWLEDGE FREEZE. If the row's stored date of birth computes to
  // under 13, we KNOW this account belongs to a child (16 CFR 312.2), and a
  // sign-in must not proceed no matter what today's request says. Before this
  // check, an account with a recorded under-13 date sailed through — the gate
  // below only ran when date_of_birth was NULL, so the one state that is
  // certain knowledge was the one state never re-examined. The refusal is the
  // same neutral sentence as everywhere else and carries no needsDob, so it
  // cannot be told apart from the signup refusal or used to fish for the rule.
  const storedAge = ageFromDob(user.date_of_birth);
  if (storedAge !== null && storedAge < MIN_AGE) {
    res.status(403).json({ error: UNDERAGE_MSG });
    return false;
  }
  if (user.date_of_birth) return true;
  const supplied = suppliedDob(req.body.date_of_birth);
  const age = supplied ? ageFromDob(supplied) : null;
  if (age === null) {
    res.status(403).json({ error: 'Add your date of birth to continue.', needsDob: true });
    return false;
  }
  if (age < MIN_AGE) {
    // The account holder just told us they are under 13. That sentence is the
    // actual knowledge COPPA turns on, and it cannot be answered with a
    // refusal that leaves the row exactly as retryable as before — the old
    // code did, so the same login could be replayed seconds later with an
    // older date and walk in. Persist the date FIRST, so the freeze above
    // holds on every later sign-in; the write also records what we knew and
    // when we knew it for the human deletion step. Then remember the attempt,
    // so the same mailbox/IP cannot immediately open a fresh account either.
    //
    // Round 22: the same statement bumps token_version, and the live sockets
    // are dropped with it. "This account belongs to a child" applies to the
    // sessions the account ALREADY holds, not only to future sign-ins —
    // without the bump, a JWT minted that morning kept working for the rest
    // of its 24 hours after the freeze landed, and a live socket kept
    // receiving DMs and location the whole time. Same blast-radius rule as a
    // completed password reset, for the same reason: the refusal below is
    // only real if it applies everywhere at once. Deliberately UNguarded
    // (unlike the passing-date write below): if a racing sign-in persisted a
    // passing date a few milliseconds ago, the under-13 answer still wins,
    // because it is the answer the law attaches to.
    await pool.query(
      'UPDATE users SET date_of_birth = $1, token_version = token_version + 1 WHERE id = $2',
      [supplied, user.id]
    );
    revokeUserSessions(req.app.get('io'), user.id);
    // PROVED (R5-H1). This runs only after /login has checked the password, or
    // after a provider token verified for this row — so `user.email` is the
    // address of an account the caller just demonstrated they hold, not a
    // string they typed. A stranger cannot reach this line with somebody else's
    // address, which is exactly what makes the wide 24-hour block safe here.
    recordUnderageAttempt(user.email, req.ip, Date.now(), { addressProved: true });
    res.status(403).json({ error: UNDERAGE_MSG });
    return false;
  }
  // Round 22: guarded on date_of_birth IS NULL. Two concurrent sign-ins can
  // both read the row while its date is NULL; if the other one supplied an
  // under-13 date (persisting the actual knowledge above) and this one
  // supplies a passing date, an unguarded write here OVERWROTE the child date
  // — the knowledge the paragraph above promises cannot be un-known was
  // erased by a request racing it, and this request then signed in. The guard
  // makes the first write win. Losing it means somebody else's date landed
  // between our read and this write, so re-read what landed and hold this
  // sign-in to THAT date, exactly as the freeze at the top would have.
  const persisted = await pool.query(
    'UPDATE users SET date_of_birth = $1 WHERE id = $2 AND date_of_birth IS NULL RETURNING date_of_birth',
    [supplied, user.id]
  );
  if (persisted.rowCount === 0) {
    const reread = await pool.query('SELECT date_of_birth FROM users WHERE id = $1', [user.id]);
    const landed = reread.rows[0] ? reread.rows[0].date_of_birth : null;
    const landedAge = ageFromDob(landed);
    if (landedAge !== null && landedAge < MIN_AGE) {
      res.status(403).json({ error: UNDERAGE_MSG });
      return false;
    }
    user.date_of_birth = landed || supplied;
    return true;
  }
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
//
// ROUND 21 — THE WIDTH HALF. This is the ONLY thing standing between a
// caller-supplied display name and users.name VARCHAR(255) on the Apple path:
// `fullName.givenName` comes off the request body, is stripped, composed, and
// arrives here, and nothing measured it. A 60,000-character givenName was a
// Postgres 22001 on the INSERT — a 500, from a body shape the caller picks, on
// an UNAUTHENTICATED route. The Apple chain now refuses one outright, and this
// clamp is the backstop for the value that does NOT come through a chain: the
// Google branch takes `name` out of a provider token, which no validator here
// ever sees.
//
// CLAMPED, not refused, and by CODE POINT. Refusing would fail a sign-in over a
// name, which is the thing this whole function exists not to do — every other
// failure here falls back to a placeholder. Postgres counts VARCHAR in
// characters, and a naive slice can cut a surrogate pair in half and leave a
// lone surrogate in the column, so the slice runs over the code points.
function clampName(value) {
  return [...value].length > MAX_NAME ? [...value].slice(0, MAX_NAME).join('') : value;
}

function safeOAuthDisplayName(rawName, email, provider) {
  const candidate = typeof rawName === 'string' ? clampName(stripHtml(rawName.trim()).trim()) : '';
  if (candidate && moderateText(candidate).allowed) return candidate;

  const local = typeof email === 'string'
    ? email.split('@')[0].replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40)
    : '';
  const placeholder = local && moderateText(local).allowed ? local : 'Friend';
  console.warn(`[auth] ${provider} display name failed moderation or was empty — storing placeholder "${placeholder}"`);
  return placeholder;
}

// ARRAY-SHAPED FIELDS WALK PAST express-validator. Given
//
// ROUND 20 NOTE — WHY THIS STAYS, AND WHERE IT IS NOT ENOUGH ON ITS OWN.
//
// validators/shape.js is now the one spelling of this rule and every other
// router imports `scalarOnly` from it. This function is deliberately not
// replaced by it, because it is the strictly STRONGER rule on the fields it
// covers: `isScalar` admits any non-object, so it would let a NUMBER through,
// and a number is exactly the shape that still hurts here —
// `{"date_of_birth": 946684800000}` reaches ageFromDob (`new Date(x)` parses a
// millisecond count) and then a DATE column.
//
// But it runs INSIDE THE HANDLER, which is after the validator chain, and that
// position is load-bearing in a way nobody had tested. An ARRAY survives the
// chain intact and is caught here. An OBJECT does not: express-validator's
// `trim()` stringifies its input, so `{"name": {}}` had already become the
// STRING "[object Object]" by the time this saw it, sailed through as a
// perfectly good string, satisfied isLength, and was stored in users.name —
// the column rendered on every invite, roster, chat row and push in the app,
// written from an UNAUTHENTICATED route. The `$ne`-style object that is the
// reflex probe for this lands in exactly the same place.
//
// So any field whose chain carries a SANITIZER needs the shape settled inside
// the chain, ahead of it — which is what `freeText` on `name` below does (it is
// scalarOnly followed by the sanitizers), and the same on PUT
// /api/users/profile. Fields with no sanitizer (password,
// date_of_birth, the OAuth tokens) reach this function unmodified and are fully
// covered by it. The rule is the one validators/shape.js states: settle the
// shape before anything else looks at the value.
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

// interests is TEXT[] and node-pg serialises whatever it is handed into it, so
// the CONTENTS have to be checked and not merely the fact that an array arrived.
// `isArray()` and nothing else was the whole rule here, and sanitizeArray()
// bounds nothing either — it strips markup per element and drops non-scalars,
// which is a content rule, not a size one. So the array length AND each
// element's length were both decided by the JSON parser in server.js, on the
// UNAUTHENTICATED route, for a column routes/admin.js renders into the
// moderation queue as evidence about a profile
// (ARRAY_TO_STRING(u.interests, ', ')).
//
// This is routes/users.js's interestsRule, deliberately spelled the same way
// rather than re-derived: the two routes write the same column and a second set
// of numbers would be a second answer to one question. It cannot be IMPORTED —
// requiring routes/users.js at load time here would tie two large route modules
// together at boot (see banTombstones below for the same reasoning) — so
// __tests__/authFieldBounds.test.js asserts the two rules agree, number for
// number, and fails when either side moves.
//
// Strings only: sanitizeArray keeps numbers and booleans as they are, which
// would store `true` as the text "true" in a column whose whole content is
// human-typed tags.
//
// Measured BEFORE stripHtml runs, on purpose and in the direction that is safe:
// stripping can only shorten, so a value inside this bound is inside it in the
// column too, while a 300-character value made of tags is refused rather than
// quietly becoming a short one. The blank-after-stripping case is caught in the
// handler, where the stripped array exists.
const interestsRule = body('interests').optional({ nullable: true }).custom((v) => {
  if (!Array.isArray(v)) throw new Error('Interests must be a list');
  if (v.length > MAX_INTERESTS) throw new Error(`Too many interests (max ${MAX_INTERESTS})`);
  for (const item of v) {
    if (typeof item !== 'string') throw new Error('Each interest must be text');
    if (item.length > MAX_INTEREST_LEN) {
      throw new Error(`Each interest must be under ${MAX_INTEREST_LEN} characters`);
    }
  }
  return true;
});

// Validation rules
const signupValidation = [
  // MEASURED TWICE, AND THE SECOND ONE IS THE ONE THAT PROTECTS THE COLUMN.
  //
  // This rule had no width at all, and "normalizeEmail can only shorten — it
  // lowercases and strips Gmail dots and +subaddresses" is the reasoning that
  // left it that way. That reasoning is wrong, and routes/users.js proved it on
  // its own copy of this field: isEmail allows a UTF-8 local part by default and
  // caps it at 64 BYTES, and lowercasing U+0130 (İ, dotted capital I) yields TWO
  // code points. A local part of 32 İ is legal, 32 code points wide, and 64 code
  // points wide once normalized. Put that in front of a long legal domain and a
  // 254-code-point address that passes every check on this route becomes 286 on
  // its way to users.email VARCHAR(255): Postgres 22001, i.e. a 500 on the
  // INSERT, on an unauthenticated route, from an address anybody can type.
  //
  // So the width is checked again AFTER the sanitizer, against the value that is
  // actually written. The first check is kept as well, because it is what keeps a
  // 64KB string away from isEmail's regex work. (Measured, not reasoned:
  // __tests__/authFieldBounds.test.js sends that address.)
  body('email')
    .isLength({ max: MAX_EMAIL }).withMessage('Email address is too long')
    .isEmail().withMessage('Valid email required')
    .normalizeEmail()
    .isLength({ max: MAX_EMAIL }).withMessage('Email address is too long')
    .custom((v) => !isDisposableEmail(v)).withMessage('Temporary email addresses cannot be used. Use an address you keep.'),
  // BCRYPT TRUNCATES AT 72 BYTES, and a maximum does not change that: two
  // different passwords that share a 72-byte prefix are interchangeable here and
  // would be at any ceiling above 72. Making them distinct means pre-hashing
  // (SHA-256 then bcrypt), which changes the stored hash format for every
  // existing row and needs a dual-verify migration this router cannot write on
  // its own. It is also worth very little: the first 72 bytes are already far
  // more entropy than anything brute-forceable, so the property lost is "a
  // 200-character password is stronger than its first 72 bytes", which was never
  // true of bcrypt anywhere. What the bound fixes is the different problem:
  // "how long may a password be" was answered by the JSON parser in server.js.
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .isLength({ max: MAX_PASSWORD }).withMessage('Password is too long')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number'),
  // freeText = shape -> trim -> stripHtml -> trim, the whole rule in one link.
  // The TRAILING trim is the half this chain was missing: stripHtml('<b> </b>')
  // is a single space, which satisfies isLength({ min: 1 }) and sails past
  // rejectIfProfane, so "a name is required" accepted a BLANK name — on the
  // unauthenticated route, into the column rendered on every invite, roster,
  // chat row and push. Sanitize, then trim, then measure.
  freeText(body('name'), 'name').isLength({ min: 1, max: MAX_NAME }).withMessage('Name is required'),
  // ROUND 20. `interests` had NO validator on the one account-creation path
  // that accepts it, while PUT /api/users/profile has carried isArray() all
  // along. sanitizeArray() returns a non-array untouched by design (it is a
  // per-element sanitizer, not a shape check), so `{"interests": "x"}` or
  // `{"interests": {"a": 1}}` went straight to pg as a scalar parameter for the
  // TEXT[] column and came back a 500 — on an UNAUTHENTICATED route, from a
  // body shape the caller picks. `nullable` because `sanitizeArray(null || [])`
  // already reads a null as "none given".
  // ROUND 21: isArray() answered the shape question and left the SIZE one open.
  // See interestsRule above.
  interestsRule,
  // Phone is deliberately NOT accepted at signup. It has no UNIQUE constraint
  // and drives contact-sync friend discovery, so accepting it here let an
  // attacker claim a victim's number from a fresh account that only ever proved
  // a throwaway email — the same squat email verification closes, run through
  // phone instead. Phone is set only via PUT /users/profile, which requires
  // one-account-per-number and a fresh-auth proof.
  // Required: the age gate is meaningless if DOB is optional (audit 2026-08-12)
  // The width goes AHEAD of isISO8601 rather than instead of it. isISO8601 does
  // refuse a long string (nothing that wide matches the grammar), so the ceiling
  // was a content rule standing in for a size rule — and this is the one field on
  // this chain that reaches a DATE column as a parameter. See MAX_DOB_LENGTH.
  body('date_of_birth').exists().withMessage('Add your date of birth to create an account.')
    .isLength({ max: MAX_DOB_LENGTH }).withMessage('Invalid date of birth')
    .isISO8601().withMessage('Invalid date of birth'),
];

const loginValidation = [
  // Bounded the same way and in the same order as signup, so the two paths
  // cannot disagree about which addresses exist. The message stays the generic
  // one on this route: /login answers every bad input with one sentence.
  body('email')
    .isLength({ max: MAX_EMAIL }).withMessage('Valid email required')
    .isEmail().withMessage('Valid email required')
    .normalizeEmail()
    .isLength({ max: MAX_EMAIL }).withMessage('Valid email required'),
  // The address maximum on the CHECKING side cannot lock anyone out: users.email
  // is VARCHAR(255), so no stored address is wider than the bound, and
  // normalizing what the owner types produces the value that was stored. It also
  // bounds something that is not a column at all — canonicalEmail(email) is the
  // KEY of the in-memory login throttle, which holds up to LOGIN_FAIL_MAX_KEYS
  // (20,000) of them. Unbounded keys made that map's real ceiling "20,000 times
  // whatever the JSON parser allows" rather than 20,000 addresses.
  //
  // The password ceiling is a smaller claim, and worth stating exactly. It is a
  // credential this route only ever COMPARES, and the compare reads at most 72
  // bytes, so refusing at 1024 changes the outcome for nobody except an account
  // that SET a password wider than 1024 — which signup could accept until this
  // round, so such an account is possible in principle. It is the same trade
  // routes/users.js made on `current_password`, at a number chosen to be far past
  // anything a password manager generates, and against ~0 live accounts. What it
  // buys is that an unauthenticated caller cannot hand bcrypt a 64KB string.
  body('password').notEmpty().withMessage('Password is required')
    .isLength({ max: MAX_PASSWORD }).withMessage('Invalid email or password'),
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
    const safeInterests = sanitizeArray(interests || []).map((v) => String(v).trim());

    // Display names are UGC shown in invites, messages, and search — the same
    // screen profile edits already run (round 8: signup skipped it).
    if (rejectIfProfane(res, name)) return;

    // ROUND 21: interests is UGC that somebody other than its author reads.
    // routes/admin.js renders it into the moderation queue's profile evidence
    // (ARRAY_TO_STRING(u.interests, ', ')), which is the surface a moderator
    // decides a ban on, and PUT /api/users/profile has screened it since round
    // 20 — this route, the one that CREATES the row, did not. sanitizeArray
    // above stripped its markup; nothing screened it.
    //
    // The screen runs on what came OUT of sanitizeArray, not on what went in,
    // and the ordering is load-bearing rather than tidy. A tag WRAPPING a word
    // does not hide it (the wordlist tokenizes on the angle brackets, so
    // "<b>shit</b>" is caught either way) — a tag INSIDE one does: "sh<b>it" is
    // three harmless tokens before stripHtml and one slur after it. Screen first
    // and that value is stored, screened, as the slur it becomes. Same reason
    // freeText applies stripHtml before `name` is screened above.
    for (const interest of safeInterests) {
      // Blank only AFTER stripping, i.e. an interest made entirely of markup.
      // Storing it would put an empty chip in the array and an empty slot in the
      // moderator's evidence line.
      if (interest === '') {
        return res.status(400).json({ error: 'An interest cannot be blank' });
      }
      if (rejectIfProfane(res, interest)) return;
    }

    // Server-side age gate (C4): DOB is required, and under-13 is rejected
    // regardless of the client gate. The refusal is remembered (see the
    // under-13 retry lockout above) and the lockout is consulted even for a
    // passing date, so "back-button, type an older year" gets the same
    // neutral sentence the first refusal did.
    const age = ageFromDob(date_of_birth);
    if (age === null) {
      return res.status(400).json({ error: 'Add your date of birth to create an account.', needsDob: true });
    }
    if (age < MIN_AGE) {
      recordUnderageAttempt(email, req.ip);
      return res.status(403).json({ error: UNDERAGE_MSG });
    }
    if (underageBlocked(email, req.ip)) {
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
    linkWaitlistConversion(user.email, user.id);

    // The account exists and can sign in; it just cannot accumulate anything
    // until the link is clicked (see UNVERIFIED_DENY in middleware/auth.js).
    // A Resend outage must therefore NOT fail a signup that already committed —
    // the user can ask for a new link from inside the app.
    let verificationSent = false;
    let mailRefused = false;
    try {
      const budget = await verificationSendBudget(user.id, req.ip);
      if (budget.ipHour >= RESEND_MAX_PER_HOUR_IP) {
        console.warn(`[auth] verification mail budget exhausted for ip ${req.ip} — skipping send for user ${user.id}`);
      } else {
        const sendResult = await sendVerification(user, req.ip);
        verificationSent = sendResult.sent === true;
        mailRefused = sendResult.refused === true;
      }
    } catch (mailErr) {
      console.error('[auth] verification send failed at signup:', mailErr.message);
    }

    const token = signUserToken(user);

    // mailRefused: the address is on the do-not-mail list (a bounce or a spam
    // report on an earlier account). Asking again cannot help, and the screen
    // used to say the link was still worth asking for.
    res.status(201).json({ token, user, emailVerificationRequired: true, verificationSent, mailRefused });
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
// `isLength` (round 21): parseVerificationToken refuses anything past
// MAX_LINK_TOKEN, so the SHAPE was bounded — but it was bounded after the body
// had been read and handed to the handler, and "the parser downstream will
// refuse it" is the same argument that left every other field on this router
// sized by server.js. The token this route mints is 161 characters at the widest.
router.post('/verify-email', [
  body('token').isString().isLength({ max: MAX_LINK_TOKEN }),
], async (req, res) => {
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
    const legs = [
      { scope: 'account', interval: '1 hour', count: budget.accountHour, limit: RESEND_MAX_PER_HOUR_ACCOUNT,
        exhausted: budget.accountHour >= RESEND_MAX_PER_HOUR_ACCOUNT },
      { scope: 'account', interval: '1 day', count: budget.accountDay, limit: RESEND_MAX_PER_DAY_ACCOUNT,
        exhausted: budget.accountDay >= RESEND_MAX_PER_DAY_ACCOUNT },
      { scope: 'ip', interval: '1 hour', count: budget.ipHour, limit: RESEND_MAX_PER_HOUR_IP,
        exhausted: budget.ipHour >= RESEND_MAX_PER_HOUR_IP },
    ];
    const capped = legs.some((l) => l.exhausted);
    if (tooSoon || capped) {
      console.warn(`[auth] verification resend throttled for user ${user.id} from ${req.ip}`);
      // "We just sent one" is only true of the sixty-second gap. The other
      // three legs are hours and a whole day long, and the person reading this
      // cannot confirm their email until one of them clears, so the sentence
      // has to distinguish them.
      const gapMs = tooSoon ? Math.max(1, budget.accountLast + RESEND_MIN_GAP_MS - Date.now()) : 0;
      const cappedMs = capped
        ? await mailBudgetRetryMs('email_verifications', 'user_id', user.id, req.ip, legs)
        : 0;
      const ms = Math.max(gapMs, cappedMs);
      return res.status(429).json(refusalBody(res, ms, capped
        ? `That is several confirmation links already. You can ask for another ${waitPhrase(ms)}. The last link we sent still works.`
        : `We just sent one. Check your inbox, then try again ${waitPhrase(ms)}.`));
    }

    const sendResult = await sendVerification(user, req.ip);
    res.json({ message: 'Sent. Check your inbox.', verificationSent: sendResult.sent === true, mailRefused: sendResult.refused === true });
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
  // Bounded on both sides of the sanitizer, exactly as signup and login are:
  // the address is canonicalised, HMAC'd into a rate-limit bucket key and
  // matched against the column, and none of those wants a 64KB string. The
  // message never varies on this route.
  body('email')
    .isLength({ max: MAX_EMAIL }).withMessage('Enter the email you sign in with')
    .isEmail().withMessage('Enter the email you sign in with')
    .normalizeEmail()
    .isLength({ max: MAX_EMAIL }).withMessage('Enter the email you sign in with'),
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
      // Three per hour, six per DAY, twenty per hour per address. "A few
      // minutes" described none of those, and this is account recovery: a
      // person locked out of their password who is told to come back in a few
      // minutes comes back, is refused, and has no remaining way in.
      //
      // Every sentence here stays neutral about whether an account exists, for
      // the reason the route header gives. It can: the budget is keyed on the
      // address hash and counts identically for addresses with no account, so
      // the window is a fact about the requests, never about the mailbox.
      const legs = [
        { scope: 'email', interval: '1 hour', count: budget.emailHour, limit: RESET_MAX_PER_HOUR_EMAIL,
          exhausted: budget.emailHour >= RESET_MAX_PER_HOUR_EMAIL },
        { scope: 'email', interval: '1 day', count: budget.emailDay, limit: RESET_MAX_PER_DAY_EMAIL,
          exhausted: budget.emailDay >= RESET_MAX_PER_DAY_EMAIL },
        { scope: 'ip', interval: '1 hour', count: budget.ipHour, limit: RESET_MAX_PER_HOUR_IP,
          exhausted: budget.ipHour >= RESET_MAX_PER_HOUR_IP },
      ];
      const capped = legs.some((l) => l.exhausted);
      const gapMs = budget.emailLast && Date.now() - budget.emailLast < RESET_MIN_GAP_MS
        ? Math.max(1, budget.emailLast + RESET_MIN_GAP_MS - Date.now())
        : 0;
      const cappedMs = capped
        ? await mailBudgetRetryMs('password_reset_requests', 'email_key', emailKey, req.ip, legs)
        : 0;
      const ms = Math.max(gapMs, cappedMs);
      return res.status(429).json(refusalBody(res, ms, capped
        ? `That is several reset requests for this address already. You can ask for another ${waitPhrase(ms)}. Any link already sent still works.`
        : `A reset link was requested for this address a moment ago. Check your inbox and your spam folder, then try again ${waitPhrase(ms)}.`));
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
router.post('/reset-password/check', [
  body('token').isString().isLength({ max: MAX_LINK_TOKEN }),
], async (req, res) => {
  try {
    // The chain's verdict is READ (round 21). It was declared and then ignored:
    // the handler made its own typeof check and nothing consulted
    // validationResult, so the width added above would have been decoration. The
    // answer is deliberately the same one an unparseable token already got —
    // this endpoint reports three states and must not grow a fourth that says
    // "your token was the wrong size", and inspectReset never ran a query for a
    // token this wide anyway.
    const errors = validationResult(req);
    if (!errors.isEmpty() || typeof req.body.token !== 'string') {
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
  body('token').isString().withMessage('This link is not valid. Ask for a new one.')
    .isLength({ max: MAX_LINK_TOKEN }).withMessage('This link is not valid. Ask for a new one.'),
  // The same ceiling signup carries, for the same reason it carries a floor: a
  // recovery flow that accepts a password signup would refuse is signup with the
  // rules switched off, in either direction. See the bcrypt note on
  // signupValidation — the bound is about who decides the width, not about the
  // 72 bytes bcrypt reads.
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .isLength({ max: MAX_PASSWORD }).withMessage('Password is too long')
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

    // And lift the sign-in lockout on this address. It is keyed on
    // canonicalEmail and cleared in exactly one place, a successful login, so
    // the ordinary route into this flow ended in a wall: guess your password
    // ten times, hit the limit, tap "Forgot password?", prove you can read the
    // mailbox, choose a new password, then type the password you just chose and
    // be told "Too many failed sign-in attempts. You can try again in about 12
    // minutes." The lock protects a credential that no longer exists.
    // consumeReset only reports ok with the address it matched the row on, so
    // there is nothing to fall back to. An earlier draft wrote `result.email ||
    // email` and this handler has no `email` binding: harmless while the left
    // side is always set, and a ReferenceError 500 the day that stops being true.
    clearLoginFailures(canonicalEmail(result.email));

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
    const lockedMs = loginLockedFor(throttleKey);
    if (lockedMs > 0) {
      console.warn(`Login throttled for ${throttleKey} from ${req.ip} at ${new Date().toISOString()}`);
      // loginLockedFor has always RETURNED the milliseconds left and this line
      // threw them away for "a few minutes", against a LOGIN_FAIL_WINDOW_MS of
      // fifteen. Somebody locked out of their own account read that, came back
      // at three minutes, failed again, and the failure does not extend the
      // lock, so the only thing the wrong number bought was a second lockout
      // they could not explain.
      return res.status(429).json(refusalBody(res, lockedMs,
        `Too many failed sign-in attempts. You can try again ${waitPhrase(lockedMs)}.`));
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
    //
    // ROUND 24 (R4-A2) left this line character-for-character alone and changed
    // only which library `bcrypt` names — see the require at the top. The
    // constant cost is the enumeration defence and had to survive; what changed
    // is that the cost is now paid on a threadpool thread instead of on the one
    // thread every other request needs. The equal-work property is pinned by
    // __tests__/loginThreadAndHashParity.test.js, which counts the compares an
    // unknown address and a wrong password each provoke and asserts both spend
    // one against a real hash of the same cost factor.
    const validPassword = await bcrypt.compare(password, user?.password || DUMMY_PASSWORD_HASH);
    if (!user || !user.password || !validPassword) {
      recordLoginFailure(throttleKey);
      const why = !user ? 'unknown email' : !user.password ? 'oauth account' : 'bad password';
      console.warn(`Failed login attempt (${why}) for ${maskAddress(email)} from ${req.ip} at ${new Date().toISOString()}`);
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
      // bio is selected here because the app boots authUser from this route,
      // and profileBio seeds from authUser.bio. Left off, a saved bio comes
      // back to an empty Edit Profile box after a reload, which reads to the
      // person who wrote it exactly like a bio that never saved. It is content
      // the user typed about themselves, not a secret, so it belongs in the
      // response for the same reason /api/users/profile returns it.
      `SELECT id, email, name, phone, interests, role, profile_image_url, bio, venmo_username, cashapp_cashtag, zelle_identifier, email_verified, created_at, updated_at, oauth_provider
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // How this account signs in, so the export and delete sheets can stop
    // asking an Apple or Google account for a password it never had. The
    // provider name is not itself sent; only the method.
    const { oauth_provider: provider, ...user } = result.rows[0];
    user.sign_in_method = provider || 'password';
    res.json({ user });
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
    // An outstanding reset link survives this, and a reset link overwrites the
    // password and re-revokes every session. Somebody who thinks their password
    // is known asks for a link, then decides to sign out everywhere instead:
    // the mail sitting in their inbox stayed live for the rest of its hour and
    // could undo exactly what they had just done. Same reasoning the reset route
    // gives for revoking sessions, in the other direction.
    // Not awaited into the response. The sessions are already revoked and the
    // token version is already bumped; failing the call afterwards would tell
    // somebody their sign-out did not work when it did. Same shape as the
    // device-token revocation above it.
    pool.query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [req.user.id])
      .catch((e) => console.error(`[auth] reset link retirement failed for user ${req.user.id}:`, e.message));
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

// POST /api/auth/google/nonce — hand out a single-use nonce for the next Google
// sign-in. The Apple twin below is the same endpoint over the same store; see
// the oauthNonces block above for why this exists and why sending one is not
// mandatory yet.
router.post('/google/nonce', (req, res) => {
  res.json({ nonce: issueOauthNonce(), expiresInSeconds: OAUTH_NONCE_TTL_MS / 1000 });
});

router.post('/google', [
  // `optional({ nullable: true })` (round 20): `optional()` skips only
  // `undefined`, and the handler below already reads a missing credential as
  // absent — `if (!req.body.credential && !req.body.access_token)` is what
  // decides. A client that spells the unused half of this pair as an explicit
  // null was answered "Invalid value" by the chain instead.
  // Widths (round 21). `credential` is fed to a JWT parse and `access_token` is
  // INTERPOLATED INTO AN OUTBOUND URL — `tokeninfo?access_token=…` — so an
  // unbounded one meant an unauthenticated caller could make this server send
  // Google a request line of tens of kilobytes and wait on it. Neither field had
  // a ceiling of its own; see MAX_OAUTH_TOKEN and MAX_OAUTH_ACCESS_TOKEN for
  // where the two numbers come from.
  body('credential').optional({ nullable: true }).isString()
    .isLength({ max: MAX_OAUTH_TOKEN }).withMessage('Google sign-in failed'),
  body('access_token').optional({ nullable: true }).isString()
    .isLength({ max: MAX_OAUTH_ACCESS_TOKEN }).withMessage('Google sign-in failed'),
  // Round 22 (R2-3): the nonce the client asked us for at POST
  // /api/auth/google/nonce and then handed to Google. Same bound as the Apple
  // twin, and optional for the same reason — no shipped client sends one yet.
  body('nonce').optional({ nullable: true }).isString().isLength({ max: MAX_LINK_TOKEN }),
], async (req, res) => {
  // R4-A1. Declared out here so the `finally` at the bottom can see them: the
  // credential is CLAIMED at the check (atomically, see claimOauthIdentity) and
  // released again unless this request reaches its success line. Every refusal
  // between here and there — 401, 403 needsDob, 409, 400, an upstream throw —
  // exits through that `finally` and hands the credential back, which is the
  // behaviour the round-22 comments below describe and rely on.
  let claimedIdentity = null;
  let identityClaimCommitted = false;
  try {
    // TYPE before CONTENT — see rejectNonStringFields.
    if (rejectNonStringFields(req, res, ['credential', 'access_token', 'nonce', 'date_of_birth'],
      'Google sign-in failed')) return;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }
    if (!req.body.credential && !req.body.access_token) {
      return res.status(400).json({ error: 'Google credential is required' });
    }

    // Round 22 (R2-3). The nonce the client says it bound this sign-in to, and
    // the token's `exp`, both need to outlive the `if` below: the nonce is only
    // SPENT and the credential is only RECORDED once the sign-in succeeds, the
    // same success-only rule the Apple path uses so an upstream blip is not
    // mistaken for an attack.
    const suppliedNonce = typeof req.body.nonce === 'string' ? req.body.nonce.trim() : '';
    let credentialExp = null;
    let credentialIdentity = null;

    let googleId, email, name, picture, emailVerified;
    if (req.body.credential) {
      // FAIL CLOSED (round 4): an undefined audience makes verifyIdToken skip
      // the check, so an ID token minted for any Google app would pass. The
      // access_token branch below already fails closed via its aud comparison.
      if (!process.env.GOOGLE_CLIENT_ID) {
        console.error('GOOGLE_CLIENT_ID not set — refusing Google sign-in');
        return res.status(500).json({ error: 'Google sign-in is not configured' });
      }
      // SHAPE BEFORE CONTENT, one level up (round 20). A Google ID token is a
      // JWT: three base64url segments. Anything else is not a token that could
      // ever verify, and handing it to verifyIdToken threw
      // "Wrong number of segments in token: …" — a message the catch at the
      // bottom of this handler does not recognise, so it fell through to
      // `500 Google sign-in failed`. That is an UNAUTHENTICATED 500 anyone can
      // produce with `{"credential": "x"}`, which is log noise, Sentry noise,
      // and a difference an attacker can read. The Apple branch never had this
      // because jsonwebtoken raises a JsonWebTokenError the catch already maps
      // to 401. Checked here rather than by widening that catch, because
      // widening it would also swallow a real Google certificate-fetch outage
      // and report it to every user as "your sign-in expired".
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(req.body.credential)) {
        return res.status(401).json({ error: 'Google sign-in expired, please try again' });
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
      credentialExp = gp.exp;

      // REPLAY (round 22, R2-3), re-keyed round 23 (R3-A2). This check used to
      // run BEFORE verifyIdToken, on SHA-256 of the credential string, so that
      // a known-bad token cost no upstream work. The string is not a canonical
      // encoding of the credential - 16 spellings of one signature all verify
      // and all hash differently - so the check now runs on the identity of
      // the token the verifier just accepted, which is the same value for all
      // 16 and different for a real new token. What is lost is that a replay
      // now reaches verifyIdToken; what is gained is that it is actually
      // refused. The shape regex above is the pre-verify guard that still
      // keeps malformed input away from the library.
      //
      // ROUND 24 (R4-A1): this was a CHECK here and a RECORD ~240 lines below,
      // with four `await pool.query` calls in between, so ten simultaneous
      // presentations of one credential all passed. It is now a single atomic
      // CLAIM — check-and-record in one synchronous step — and the claim is
      // RELEASED in the `finally` at the bottom on every path that is not a
      // completed sign-in. The retry-after-a-blip property the previous comment
      // protected is unchanged; see claimOauthIdentity for the full contract.
      credentialIdentity = oauthIdentityKey('google', gp, req.body.credential);
      if (!credentialIdentity) {
        console.warn(`[auth] refused Google sign-in: credential cannot be made single-use (${req.ip})`);
        return res.status(401).json({ error: 'Google sign-in expired, please try again' });
      }
      if (!claimOauthIdentity(credentialIdentity, credentialExp)) {
        console.warn(`[auth] rejected replayed Google credential from ${req.ip}`);
        return res.status(401).json({ error: 'Google sign-in expired, please try again' });
      }
      claimedIdentity = credentialIdentity;

      // NONCE BINDING (round 22, R2-3) — the same three cases, in the same
      // order, as the Apple path. google-auth-library verifies signature,
      // issuer, expiry and audience; it has no nonce parameter at all, so the
      // caller has to compare the claim itself or the claim means nothing.
      //   * client sent one — it must be one WE issued, unspent, and the
      //     token's `nonce` claim must match it (raw or SHA-256, constant time);
      //   * client sent none but the token carries a nonce — the token is bound
      //     to a value we cannot check, so we refuse rather than pretend;
      //   * neither — allowed today, refused once GOOGLE_REQUIRE_NONCE is on.
      {
        const tokenNonce = typeof gp.nonce === 'string' ? gp.nonce : '';
        if (suppliedNonce) {
          if (!oauthNonceValid(suppliedNonce)) {
            console.warn(`[auth] Google sign-in with unknown or spent nonce from ${req.ip}`);
            return res.status(401).json({ error: 'Google sign-in expired, please try again' });
          }
          if (!oauthNonceClaimMatches(tokenNonce, suppliedNonce)) {
            console.warn(`[auth] Google ID token nonce did not match the issued nonce (${req.ip})`);
            return res.status(401).json({ error: 'Google sign-in expired, please try again' });
          }
        } else if (tokenNonce) {
          console.warn(`[auth] Google ID token carries a nonce the client did not send (${req.ip})`);
          return res.status(401).json({ error: 'Google sign-in expired, please try again' });
        } else if (process.env.GOOGLE_REQUIRE_NONCE === 'true') {
          return res.status(400).json({ error: 'Google sign-in failed' });
        }
      }
    } else {
      const at = req.body.access_token;
      // ROUND 25 (R5-H2), FIRST HALF — GOOGLE_REQUIRE_NONCE NOW MEANS WHAT ITS
      // NAME SAYS ON THE WHOLE ENDPOINT.
      //
      // The flag makes nonce binding mandatory. It used to be read in the
      // `credential` branch only, so turning it on refused half of POST
      // /api/auth/google and left the other half signing people in with no
      // nonce at all — an operator who set it believed the endpoint was bound
      // and it was not, which is worse than not having the flag.
      //
      // An access token cannot satisfy the requirement. There is no nonce claim
      // anywhere in the flow: tokeninfo does not return one, the token is not a
      // JWT, and nothing about it is bound to a value this server issued. So the
      // only honest reading of "nonce required" here is that this branch is
      // closed while the flag is on. Refused BEFORE the outbound fetch, so a
      // request that cannot succeed does not cost a call to Google.
      //
      // Same 400 and the same neutral sentence as the credential branch's
      // no-nonce refusal, so the two halves of the endpoint answer alike.
      if (process.env.GOOGLE_REQUIRE_NONCE === 'true') {
        console.warn(`[auth] refused Google access-token sign-in: GOOGLE_REQUIRE_NONCE is on and an access token carries no nonce (${req.ip})`);
        return res.status(400).json({ error: 'Google sign-in failed' });
      }
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
      // ROUND 25 (R5-H2), SECOND HALF — THIS BRANCH IS SINGLE-USE TOO.
      //
      // The old comment at the success line below argued that an access token is
      // "legitimately re-presentable" and that Google re-validates it live at
      // tokeninfo, so replay protection was unnecessary here. Both halves of
      // that are true and neither one addresses the consequence: every
      // presentation reaches signUserToken, and every token signUserToken mints
      // carries a FRESH `iat`. A fresh `iat` is the entire sudo-mode proof for
      // an OAuth account (hasFreshSession in routes/users.js), and it gates
      // DELETE /api/users/me, the phone-number change and the full data export.
      // So a captured access token was not one stolen sign-in, it was a renewable
      // supply of sudo-capable sessions for the hour Google keeps honouring it —
      // which is precisely what the ID-token comment 200 lines above calls the
      // reason replay matters. Both `claim` and `create` are reachable from here,
      // so it also mints those sessions on a row it can take over.
      //
      // "Legitimately re-presentable" is answered by the release half of the
      // R4-A1 contract rather than by leaving the door open: a refusal or an
      // upstream blip hands the credential back in the `finally` below, so the
      // client can retry with the SAME access token. What can no longer happen
      // is a second COMPLETED sign-in on one credential. The shipped clients do
      // not need one — the GIS browser flow (frontend useGoogleAuth.js) runs a
      // fresh consent exchange per sign-in and posts the resulting token once.
      //
      // Claimed here rather than before tokeninfo because `info.expires_in` is
      // what sizes the entry: the memory has to outlive Google's own acceptance
      // of the token and no longer, exactly as the ID-token path uses `exp`.
      const accessKey = googleAccessTokenKey(at);
      if (!accessKey) {
        return res.status(401).json({ error: 'Google sign-in expired, please try again' });
      }
      // `undefined`, not null, when tokeninfo does not tell us: markOauthIdentityUsed
      // falls back to OAUTH_REPLAY_MAX_TTL_MS on a non-finite value, and
      // Number(null) is 0, which is finite and would size the entry to the
      // 60-second floor instead — an entry that lapses long before the token it
      // is remembering does.
      const expiresIn = Number(info.expires_in);
      const accessAcceptedUntil = Number.isFinite(expiresIn)
        ? Math.floor(Date.now() / 1000) + expiresIn
        : undefined;
      if (!claimOauthIdentity(accessKey, accessAcceptedUntil)) {
        console.warn(`[auth] rejected replayed Google access token from ${req.ip}`);
        return res.status(401).json({ error: 'Google sign-in expired, please try again' });
      }
      claimedIdentity = accessKey;
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
    // Round 21. NOT attacker-reachable — the address came out of a token this
    // handler verified Google's signature on — but it is the value written to
    // users.email VARCHAR(255), and nothing between here and the INSERT measures
    // it. An address wider than the column is a Postgres 22001, i.e. a 500 on a
    // sign-in, rather than a refusal this route chose to make.
    if (email.length > MAX_EMAIL || String(googleId).length > MAX_OAUTH_ID) {
      console.warn(`[auth] refused Google sign-in: provider identity is wider than the column that holds it`);
      return res.status(400).json({ error: 'Google account email is not usable' });
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
          console.warn(`[auth] refused Google claim of BANNED account ${existing.id} (${maskAddress(email)})`);
          return res.status(403).json({
            error: 'An account with this email has been suspended. Contact support if you think that is a mistake.',
          });
        }
        const decision = claimDecision(existing, email);
        if (decision === 'refuse') {
          console.warn(`[auth] refused Google claim of account ${existing.id}: verified address does not match ${maskAddress(email)}`);
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
        // ROUND 25 (R5-H3) — THE PAYMENT HANDLES GO WITH THE PASSWORD.
        //
        // The round-16 squat is closed against an attacker who cannot read the
        // victim's mail. It is NOT closed against one who gets the victim to
        // read it for them, which costs nothing: the squatter registers the
        // victim's address, and the verification mail the signup sends lands in
        // the VICTIM's inbox. One click from a person who assumes a stray
        // confirmation email is theirs and the row is "proved", the
        // UNVERIFIED_DENY gate opens, and the squatter writes venmo_username,
        // cashapp_cashtag and zelle_identifier onto it. When the real owner
        // later signs in with Google, claimDecision says 'claim' — correctly,
        // the address IS theirs — and this statement handed them the row with
        // the attacker's payout handles still on it. Every bill split the victim
        // runs from then on pays the attacker, under the victim's own name.
        //
        // releaseSquattedAddress already clears these three columns for exactly
        // this reason and calls itself "the belt to that pair of braces". The
        // claim path is the other outcome of the same fork and was missing it.
        // Clearing `password` cuts the squatter's credential and bumping
        // token_version kills their session; neither one removes what they left
        // behind, and the handles are the part that keeps earning after they are
        // locked out.
        //
        // ACCEPTED COST: a genuine password-to-Google upgrader re-enters their
        // payment handles once. That is a settings screen; the alternative is a
        // silent payment redirect that neither party can see.
        const claimed = await pool.query(
          `UPDATE users SET oauth_provider = 'google', oauth_id = $1, password = NULL,
             profile_image_url = COALESCE(profile_image_url, $2),
             email_verified = TRUE, verified_email = email,
             venmo_username = NULL, cashapp_cashtag = NULL, zelle_identifier = NULL,
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
        console.warn(`[auth] Google verified-email claim of password account ${claimTarget.id} (${maskAddress(email)})`);
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
        // Same under-13 refusal + retry lockout as password signup: an age
        // screen that only guards one of the three account-creation doors is
        // not the neutral screen the COPPA FAQ describes, it is a suggestion.
        if (dobAge < MIN_AGE) {
          // PROVED when Google vouched for the address (R5-H1). `email` here
          // came out of a token this handler verified Google's signature on, so
          // an attacker cannot put a stranger's address in it — but only
          // `email_verified` makes it an address Google says the signer can
          // read, and that flag is checked further down rather than here. Pass
          // it through: an unvouched address falls back to the narrow
          // address-plus-IP key, and is refused a few lines later anyway.
          recordUnderageAttempt(email, req.ip, Date.now(), { addressProved: emailVerified === true });
          return res.status(403).json({ error: UNDERAGE_MSG });
        }
        if (underageBlocked(email, req.ip)) {
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
        linkWaitlistConversion(user.email, user.id);
      }
    }

        if (!(await enforceDobOnLogin(user, req, res))) return;

    // The sign-in is complete: KEEP the claim taken at the check above, and
    // spend the nonce. Every failure path above leaves both usable, so a client
    // retrying after an upstream blip is not locked out by its own replay
    // protection — the release half of the R4-A1 contract is what preserves
    // that now that the record happens up front.
    //
    // ROUND 25 (R5-H2): both branches commit. This used to be
    // `if (req.body.credential)`, back when the access-token branch took no
    // claim to commit; it now takes one, for the fresh-`iat` reason spelled out
    // at the claim itself. Keyed off `claimedIdentity` rather than off which
    // field the body carried, so a third credential shape added later cannot
    // take a claim and silently fail to keep it — which would release the
    // winner's entry and make the credential replayable again.
    if (claimedIdentity) identityClaimCommitted = true;
    // The nonce belongs to the ID-token path alone; an access token never
    // carries one, and spending an empty string is a no-op either way.
    if (req.body.credential) {
      spendOauthNonce(suppliedNonce);
    }

    const token = signUserToken(user);
    const { password: _, apple_refresh_token: _art, token_version: _tv, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Google OAuth error:', err);
    if (err.message?.includes('Token used too late') || err.message?.includes('Invalid token')) {
      return res.status(401).json({ error: 'Google sign-in expired, please try again' });
    }
    res.status(500).json({ error: 'Google sign-in failed' });
  } finally {
    // The release half of R4-A1. One line, and it covers every refusal branch
    // above plus anything that throws, which is exactly why it is here and not
    // duplicated at each `return`.
    if (claimedIdentity && !identityClaimCommitted) releaseOauthIdentityClaim(claimedIdentity);
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
// sign-in. See the oauthNonces block above for why this exists and why sending
// one is not mandatory yet.
router.post('/apple/nonce', (req, res) => {
  res.json({ nonce: issueOauthNonce(), expiresInSeconds: OAUTH_NONCE_TTL_MS / 1000 });
});

router.post('/apple', [
  body('identityToken').notEmpty().withMessage('Apple identityToken is required')
    .isLength({ max: MAX_OAUTH_TOKEN }).withMessage("Apple sign-in didn't complete. Try again in a moment."),
  // `fullName` is LEGITIMATELY structured — Apple's SDK hands over
  // `{ givenName, familyName }` — so it keeps isObject() rather than a scalar
  // guard, and the handler re-derives both halves through String() + stripHtml
  // before they can reach a column. `nullable` on all three for the same reason
  // as the Google branch: the handler already treats absent as absent
  // (`fullName?.givenName`, `typeof req.body.nonce === 'string' ? … : ''`).
  //
  // ROUND 21 — THE HALVES ARE BOUNDED TOO, and this was the sharpest gap on the
  // router. `isObject()` says the container is an object and says nothing about
  // what is in it, and the handler's `String(fullName.givenName)` is a
  // TYPE defence, not a WIDTH one: a 60,000-character givenName was composed
  // into a display name and written to users.name VARCHAR(255), which is a
  // Postgres 22001 — an unauthenticated 500 from a body the caller writes. The
  // String() coercion also has the "[object Object]" failure the round-20 note
  // describes for `name`: `{"givenName": {}}` is not a name, it is the shape
  // probe, and it would have been stored as one. Apple's SDK sends strings or
  // sends nothing.
  body('fullName').optional({ nullable: true }).isObject()
    .custom((v) => {
      for (const half of ['givenName', 'familyName']) {
        const part = v[half];
        if (part === undefined || part === null) continue;
        if (typeof part !== 'string') throw new Error("Apple sign-in didn't complete. Try again in a moment.");
        if (part.length > MAX_NAME) throw new Error("Apple sign-in didn't complete. Try again in a moment.");
      }
      return true;
    }),
  // `authorizationCode` carried no rule of ANY kind: rejectNonStringFields below
  // refused a non-string and nothing refused a wide one, and this is the value
  // posted to Apple's token endpoint. Apple's code is an opaque ~50 characters.
  body('authorizationCode').optional({ nullable: true }).isString()
    .isLength({ max: MAX_OAUTH_TOKEN }).withMessage("Apple sign-in didn't complete. Try again in a moment."),
  // The nonce ceiling was already here and is the one this file issues: 24 random
  // bytes as base64url (32 characters), or its SHA-256 hex digest (64). Named now
  // so it reads as the same kind of number as the ones above.
  body('nonce').optional({ nullable: true }).isString().isLength({ max: MAX_LINK_TOKEN }),
], async (req, res) => {
  // R4-A1, the Google twin. Declared out here so the `finally` at the bottom
  // can see them. The Apple path is the one whose retry case is not
  // hypothetical: the code exchange below answers 503 on an Apple outage, and
  // that 503 must leave the identity token usable for the client's retry.
  let claimedIdentity = null;
  let identityClaimCommitted = false;
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
    // Round 21, the Google twin: users.oauth_id is VARCHAR(255) and the `sub` is
    // written to it on BOTH the claim and the create path, so the check goes
    // ahead of both. Provider data on a signature-verified token, so this is a
    // backstop rather than a gate anybody can reach — an Apple sub is about 44
    // characters.
    if (String(appleId).length > MAX_OAUTH_ID) {
      console.warn('[auth] refused Apple sign-in: provider identity is wider than users.oauth_id');
      return res.status(400).json({ error: "Apple sign-in didn't complete. Try again in a moment." });
    }

    // Round 16: an identity token was accepted as many times as it was
    // presented, for the ~10 minutes it stays valid. Re-keyed round 23
    // (R3-A2), which is why this now sits AFTER jwt.verify rather than before
    // it: the old key was SHA-256 of the token string, and the last character
    // of an RS256 signature has 16 spellings that all verify, so one captured
    // token still bought 16 sign-ins here. The identity it keys on now only
    // exists once the token is decoded. jwt.verify is itself the cheap
    // pre-verify guard - a malformed token never gets past its parse.
    //
    // ROUND 24 (R4-A1): CHECK here and RECORD ~230 lines below was defeated by
    // firing the presentations in parallel — every `await` between the two
    // yields the event loop, so they all read an empty cache. Now an atomic
    // CLAIM, released in the `finally` at the bottom on every path that is not
    // a completed sign-in, which is what keeps "a retry after a transient
    // upstream failure is not mistaken for an attack" true. Full contract on
    // claimOauthIdentity.
    const identityKey = oauthIdentityKey('apple', payload, identityToken);
    if (!identityKey) {
      console.warn(`[auth] refused Apple sign-in: identity token cannot be made single-use (${req.ip})`);
      return res.status(401).json({ error: 'Apple sign-in expired, please try again' });
    }
    if (!claimOauthIdentity(identityKey, payload.exp)) {
      console.warn(`[auth] rejected replayed Apple identity token from ${req.ip}`);
      return res.status(401).json({ error: 'Apple sign-in expired, please try again' });
    }
    claimedIdentity = identityKey;

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
        if (!oauthNonceValid(suppliedNonce)) {
          console.warn(`[auth] Apple sign-in with unknown or spent nonce from ${req.ip}`);
          return res.status(401).json({ error: 'Apple sign-in expired, please try again' });
        }
        if (!oauthNonceClaimMatches(tokenNonce, suppliedNonce)) {
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
          console.warn(`[auth] refused Apple claim of BANNED account ${existingByEmail.id} (${maskAddress(email)})`);
          return res.status(403).json({
            error: 'An account with this email has been suspended. Contact support if you think that is a mistake.',
          });
        }
        // Round 16: same three-way decision as the Google branch.
        const decision = claimDecision(existingByEmail, email);
        if (decision === 'refuse') {
          console.warn(`[auth] refused Apple claim of account ${existingByEmail.id}: verified address does not match ${maskAddress(email)}`);
          return res.status(409).json({
            error: 'An account with this email already exists. Log in the way you originally signed up.',
          });
        }
        if (decision === 'claim') {
          // Round 13: same session handover as the Google claim — bump
          // token_version so any JWT the squatter still holds dies immediately.
          // ROUND 25 (R5-H3): and the same three payment-handle columns, for the
          // reason written out in full at the Google claim above. A squat whose
          // verification link the victim clicks arrives here loaded with the
          // attacker's payout handles, and clearing the password does not
          // remove them.
          const claimed = await pool.query(
            `UPDATE users SET oauth_provider = 'apple', oauth_id = $1, password = NULL,
               email_verified = TRUE, verified_email = email,
               venmo_username = NULL, cashapp_cashtag = NULL, zelle_identifier = NULL,
               token_version = token_version + 1, updated_at = NOW()
             WHERE id = $2 RETURNING *`,
            [appleId, existingByEmail.id]
          );
          user = claimed.rows[0];
          // Round 15: kill the squatter's live Socket.io connection too — the
          // token_version bump alone never reaches an already-open socket.
          revokeUserSessions(req.app.get('io'), existingByEmail.id);
          console.warn(`[auth] Apple verified-email claim of password account ${existingByEmail.id} (${maskAddress(email)})`);
        }
        // 'evict' falls through to creation below, which releases the address
        // only after every remaining gate has passed.
      }
    }

    // Set only on the creation path below. The Apple authorization code is
    // single-use, and creation now spends it BEFORE the row is written, so the
    // post-creation exchange further down must not spend it a second time.
    let createdNow = false;
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
      // Same under-13 refusal + retry lockout as the other two creation
      // paths. Apple may omit the email; recordUnderageAttempt then keys on
      // the IP alone, which still covers the immediate-retry case.
      if (appleDobAge < MIN_AGE) {
        // PROVED only when Apple actually gave us an address AND vouched for
        // it (R5-H1), the same rule as the Google twin. When Apple omits the
        // address there is nothing to key on but the IP, which still covers the
        // immediate-retry case.
        recordUnderageAttempt(email, req.ip, Date.now(), {
          addressProved: Boolean(email) && appleEmailVerified === true,
        });
        return res.status(403).json({ error: UNDERAGE_MSG });
      }
      if (underageBlocked(email, req.ip)) {
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
      // The code exchange is a gate, and it used to run AFTER the INSERT below.
      // Round 6 made it refuse a sign-in that yields no refresh token, because
      // without one account deletion can never revoke the Apple grant
      // (5.1.1(v)); but by then the users row already existed, bound to this
      // Apple sub, holding the person's real address, with apple_refresh_token
      // NULL: exactly the unrevokeable account the refusal exists to prevent,
      // plus an address now taken against password and Google signup, plus a
      // squatted address already released by the write two statements down.
      // So the exchange runs here, ahead of every write, and the token goes
      // into the INSERT itself. A refusal leaves nothing behind.
      let newAppleRefreshToken = null;
      if (authorizationCode) {
        const { exchangeAppleCode, isConfigured: appleConfigured } = require('../services/appleAuth');
        try {
          const tokens = await exchangeAppleCode(authorizationCode);
          if (tokens?.refresh_token) {
            newAppleRefreshToken = tokens.refresh_token;
          } else if (appleConfigured()) {
            return res.status(503).json({ error: "Apple sign-in didn't complete. Try again in a moment." });
          }
        } catch (e) {
          console.error('Apple code exchange error:', e.message);
          if (appleConfigured()) {
            return res.status(503).json({ error: "Apple sign-in didn't complete. Try again in a moment." });
          }
        }
      }
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
      // Round 21, the Google twin. Both halves of this value are provider-issued
      // and signature-verified, so neither is attacker-reachable — but both are
      // unbounded as far as this file knows, and users.email is VARCHAR(255).
      // Checked on the CONSTRUCTED value so the placeholder is covered too, and
      // refused rather than truncated: a truncated placeholder could collide with
      // another Apple user's, and this is the column that decides who an account
      // is.
      if (storedEmail.length > MAX_EMAIL) {
        console.warn(`[auth] refused Apple account creation: address is ${storedEmail.length} characters, wider than users.email`);
        return res.status(400).json({ error: "Apple sign-in didn't complete. Try again in a moment." });
      }
      // email_verified TRUE only when Apple actually gave us an address it
      // vouched for. The .invalid placeholder proves nothing about a mailbox,
      // but it also cannot be squatted or mailed, and the account has no way to
      // ever verify it — so it is recorded as verified for that placeholder and
      // never for a real address. verified_email holds what was proved.
      result = await pool.query(
        `INSERT INTO users (email, name, oauth_provider, oauth_id, terms_accepted_at, date_of_birth, email_verified, verified_email, apple_refresh_token)
         VALUES ($1, $2, 'apple', $3, NOW(), $4, TRUE, $5, $6)
         RETURNING *`,
        [storedEmail, fallbackName, appleId, appleDob, storedEmail, newAppleRefreshToken]
      );
      user = result.rows[0];
      createdNow = true;
      linkWaitlistConversion(user.email, user.id);
    }

    // Existing accounts only: a just-created row already carries its token, and
    // the single-use code it was bought with cannot be exchanged again.
    if (authorizationCode && !createdNow) {
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

    // The sign-in is complete: KEEP the claim taken at the check above, and
    // spend the nonce. Every failure path above leaves both usable — including
    // the 503s from the code exchange a few lines up, which are the reason the
    // release half of R4-A1 exists — so a client that retries after an upstream
    // blip is not locked out by its own replay protection.
    identityClaimCommitted = true;
    spendOauthNonce(suppliedNonce);

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
  } finally {
    // The release half of R4-A1. Covers every refusal branch above plus
    // anything that throws, which is why it is here rather than duplicated at
    // each `return`.
    if (claimedIdentity && !identityClaimCommitted) releaseOauthIdentityClaim(claimedIdentity);
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
  // The parameter-binding invariant above is the one thing in this file that a
  // real Postgres would catch and a stubbed pool would not, so it is pinned
  // directly rather than through a route.
  buildMailBudgetQuery,
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
  // Round 22: these are now one provider-agnostic mechanism shared by the
  // Apple and Google paths (R2-3). The apple* export names are kept so existing
  // tests keep naming what they already name.
  oauthNonceClaimMatches,
  issueOauthNonce,
  oauthNonceValid,
  spendOauthNonce,
  // Round 23 (R3-A2/R3-A1): the replay cache keys on the VERIFIED identity, so
  // these take the key oauthIdentityKey() derives rather than a token string.
  // The token-shaped names below are kept as aliases because other suites name
  // them; they are the same two functions.
  oauthIdentityKey,
  oauthIdentityWasUsed,
  markOauthIdentityUsed,
  // Round 24 (R4-A1): the atomic pair. Exported so
  // __tests__/oauthReplayAtomicity.test.js can drive the claim and the release
  // directly as well as through the two routes.
  claimOauthIdentity,
  releaseOauthIdentityClaim,
  // Round 25 (R5-H2): the access-token branch is single-use too, so a suite
  // that reuses one literal token string across independent tests now gets a
  // replay refusal on the second one. Test-only reset, the same shape as
  // clearUnderageAttempts: the production code never clears this map (see
  // markOauthIdentityUsed for why a wholesale clear() was the bug there).
  clearOauthIdentityClaims: () => oauthTokensUsed.clear(),
  googleAccessTokenKey,
  canonicalJwtSignature,
  OAUTH_REPLAY_MAX_TTL_MS,
  OAUTH_VERIFIER_SKEW_MS,
  oauthTokenWasUsed: oauthIdentityWasUsed,
  markOauthTokenUsed: markOauthIdentityUsed,
  appleNonceClaimMatches: oauthNonceClaimMatches,
  issueAppleNonce: issueOauthNonce,
  appleNonceValid: oauthNonceValid,
  spendAppleNonce: spendOauthNonce,
  appleTokenWasUsed: oauthIdentityWasUsed,
  markAppleTokenUsed: markOauthIdentityUsed,
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
  // Round 21 (field bounds). Exported so __tests__/authFieldBounds.test.js
  // drives each field from the route's own number instead of retyping it.
  MAX_EMAIL,
  MAX_OAUTH_ID,
  MAX_NAME,
  MAX_PASSWORD,
  MAX_INTERESTS,
  MAX_INTEREST_LEN,
  MAX_DOB_LENGTH,
  MAX_LINK_TOKEN,
  MAX_OAUTH_TOKEN,
  MAX_OAUTH_ACCESS_TOKEN,
  clampName,
  // Minors-compliance audit 2026-08-14 (COPPA neutral age screen). The message
  // is exported so the test can assert it TEACHES NOTHING (no age, no
  // threshold), and the lockout pieces so its TTLs and bounds are testable
  // with an injected clock.
  UNDERAGE_MSG,
  recordUnderageAttempt,
  underageBlocked,
  UNDERAGE_EMAIL_TTL_MS,
  UNDERAGE_IP_TTL_MS,
  UNDERAGE_MAX_KEYS,
  UNDERAGE_LOW_WATER,
  // Round 5 (A5-2): the two class budgets that replaced the single ordering.
  UNDERAGE_EMAIL_MAX_KEYS,
  UNDERAGE_EMAIL_LOW_WATER,
  UNDERAGE_IP_MAX_KEYS,
  UNDERAGE_IP_LOW_WATER,
  // Round 23: exported so __tests__/minorsCompliance.test.js can drive the
  // eviction path directly and pin that a flood cannot empty the map, and that
  // the entry a flooder is aiming at outlives their own writes.
  evictUnderageAttempts,
  underageKey,
  underagePairKey,
  seedUnderageAttempt: (key, expiresAt) => underageAttempts.set(key, expiresAt),
  underageAttemptHas: (key) => underageAttempts.has(key),
  clearUnderageAttempts: () => underageAttempts.clear(),
  underageAttemptCount: () => underageAttempts.size,
  // The reset mail is dispatched without being awaited, so the response cannot
  // carry Resend's latency (that latency only exists on the branch where the
  // account does, which makes it an enumeration oracle). Tests await this.
  flushResetMail: () => Promise.allSettled([...pendingResetMail]),
  // The stale-row sweeps (request ledger + dead token rows) are fire-and-forget
  // for the same reason the mail is; tests await them here, and rewind the
  // hourly debounce so a single process can exercise more than one sweep.
  RESET_ROW_RETENTION_DAYS,
  flushResetSweeps: () => Promise.allSettled([...pendingResetSweeps]),
  rewindResetPurgeClock: () => { lastResetPurge = 0; },
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
