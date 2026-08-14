const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { body, query, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');
const pool = require('../config/database');
const {
  authenticate,
  authenticateAllowBanned,
  signUserToken,
  revokeUserSessions,
  TOKEN_ALGORITHMS,
  UNVERIFIED_MESSAGE,
} = require('../middleware/auth');
// stripHtml is no longer imported here: the one chain that called it is now
// freeText(), which applies it (and the trailing trim it was missing).
const { sanitizeArray } = require('../utils/sanitize');
const { rejectIfProfane, moderateImage, imageRejectionMessage } = require('../utils/moderation');
const { revokeAppleToken, isConfigured: appleAuthConfigured } = require('../services/appleAuth');
// Shape before content — see validators/shape.js. PUT /profile settles its own
// shape in the handler with a STRICTER rule (string-or-absent, which also
// refuses a number reaching a text column), so it keeps that check; every other
// write in this file uses the shared predicate.
const { scalarOnly, freeText } = require('../validators/shape');

const router = express.Router();
const SALT_ROUNDS = 10;

// DELETE /api/users/me is defined FIRST, with its own ban-tolerant auth, and is
// the only route in the app that runs without the ban check. See deleteAccount
// at the bottom of this file and the comment on makeAuthenticate in
// middleware/auth.js — this replaces a URL-regex carve-out that any DELETE
// request could satisfy with a crafted query string.
router.delete('/me', authenticateAllowBanned, deleteAccount);

router.use(authenticate);

// user_settings table lives in migrations/003 — route-owned DDL raced the
// migration runner on fresh deployments (see REVIEW-ROUND5).

// Magic bytes for image validation.
//
// Round 19: these were TRUNCATED signatures — four bytes of PNG's eight, and a
// bare `GIF8` rather than the two GIF versions that exist. That let this
// function and utils/moderation.js's inspectImageFrames disagree about what a
// file IS: bytes beginning `47 49 46 38 58 61` typed as a GIF here, were
// stamped `data:image/gif` and stored, and were an unrecognised container over
// there — which is the branch that does NOT look for extra frames. Two
// byte-typers in one repo that can reach different conclusions about the same
// bytes is a moderation bypass waiting for someone to find the seam. Full
// signatures, so both answer the same question the same way.
//
// This is format TYPING, not frame counting: how many frames a file holds is
// decided in exactly one place, inside moderateImage. Real uploads are
// unaffected — the only two GIF versions ever published are 87a and 89a.
const IMAGE_SIGNATURES = {
  jpeg: [Buffer.from([0xFF, 0xD8, 0xFF])],
  png:  [Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
  gif:  [
    Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]),  // GIF, version 87a
    Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),  // GIF, version 89a
  ],
  // 'RIFF' alone is a container header, not an image one: WAV and AVI open the
  // same four bytes. The 'WEBP' form type at offset 8 is what makes it an image.
  webp: [Buffer.from([0x52, 0x49, 0x46, 0x46])], // RIFF header
};

// Returns the format the BYTES say this is, or null. The name is the answer:
// callers must not re-derive a type from the filename or the upload's declared
// MIME, both of which the client writes.
function detectImageFormat(buf) {
  try {
    for (const [format, sigs] of Object.entries(IMAGE_SIGNATURES)) {
      for (const sig of sigs) {
        if (!buf.subarray(0, sig.length).equals(sig)) continue;
        if (format === 'webp' && buf.toString('latin1', 8, 12) !== 'WEBP') continue;
        return format;
      }
    }
    return null;
  } catch {
    return null;
  }
}

const DETECTED_MIME = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

// Configure multer for profile image uploads.
//
// Round 12: this used multer.diskStorage into backend/uploads, and server.js
// served that directory statically. Railway's filesystem is EPHEMERAL and no
// volume is mounted, so every redeploy wiped the directory. The upload handler
// already converts to a base64 data URL and stores it in
// users.profile_image_url (the same way message images work), so the disk was
// only ever a temp staging area whose files could — and on a crash between
// write and unlink, did — survive as orphans until the next deploy erased
// them. Buffering in memory removes the ephemeral-filesystem dependency
// entirely: no volume to configure, nothing to leak, nothing to lose on
// redeploy. The 5 MB limit below bounds the buffer, and the stored data URL is
// separately capped at 600 KB further down.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowed.test(file.mimetype);
    if (extOk && mimeOk) {
      cb(null, true);
    } else {
      cb(new Error('Only image files (JPEG, PNG, GIF, WebP) are allowed'));
    }
  },
});

// GET /api/users/profile - Get current user's full profile
router.get('/profile', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, name, phone, interests, role, profile_image_url, venmo_username, cashapp_cashtag, zelle_identifier, is_premium, created_at, updated_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Include flock count
    const flockCount = await pool.query(
      "SELECT COUNT(*) FROM flock_members WHERE user_id = $1 AND status = 'accepted'",
      [req.user.id]
    );

    const profile = result.rows[0];
    profile.flock_count = parseInt(flockCount.rows[0].count);

    res.json({ user: profile });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// Mirrors express-validator's normalizeEmail() defaults, for COMPARISON only.
// The submitted address is normalized by the validator; stored addresses are
// not always (OAuth rows keep the provider's address verbatim, and rows predate
// the sanitizer), so comparing raw against normalized would read an UNCHANGED
// profile form as an email change and reject it.
function normalizedAddress(addr) {
  if (typeof addr !== 'string') return '';
  const at = addr.lastIndexOf('@');
  if (at < 1) return addr.toLowerCase();
  let local = addr.slice(0, at).toLowerCase();
  let domain = addr.slice(at + 1).toLowerCase();
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replace(/\./g, '');
  return `${local}@${domain}`;
}

// ---------------------------------------------------------------------------
// Recent-possession proof ("sudo mode") — round 16
// ---------------------------------------------------------------------------
// A Flock JWT lives 24h and nothing about holding one proves the holder is the
// account owner right now. Two actions in this file are irreversible or
// identity-defining enough that a bearer token alone must not be sufficient:
// deleting the account (which also revokes the Apple grant and cannot be
// undone) and changing the phone number (which is the key friend discovery
// resolves against, so claiming someone else's number redirects their
// contact-sync lookups at you).
//
// Password accounts prove possession the obvious way: retype the password.
// That locks nobody out, because typing the password is the ONLY way a
// password account can sign in at all — anyone legitimately holding a live
// session for one knows it.
//
// OAuth accounts have no password to retype, so the equivalent is a session
// that was minted by an actual provider sign-in moments ago. `iat` is stamped
// by jsonwebtoken on every token signUserToken issues, so a token that is more
// than REAUTH_WINDOW_MS old fails the check and the client has to re-run Sign
// in with Apple / Google to get a fresh one. A token lifted hours earlier (the
// realistic theft) is stale by definition.
//
// Deletion stays genuinely reachable either way, which is the Apple 5.1.1(v)
// requirement: banned accounts can still sign in (the ban is enforced by
// middleware/auth.js on API calls, not by the sign-in routes), so a banned user
// can always obtain the proof and finish deleting.
const REAUTH_WINDOW_MS = 5 * 60 * 1000;

function tokenIssuedAtMs(req) {
  const header = req?.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  // Split exactly the way middleware/auth.js does. Taking the rest of the
  // header instead would read a DIFFERENT string out of `Bearer <token> junk`
  // than the one that was just verified, and the only possible outcome of that
  // divergence is refusing a request the middleware accepted.
  const token = header.split(' ')[1];
  if (!token) return null;
  try {
    // Re-verified, not just decoded: this must never accept an unsigned or
    // tampered `iat`. The request already passed the same verification in
    // middleware/auth.js, so this can only agree with it or fail closed.
    // The `||` is not decoration: an undefined `algorithms` makes jsonwebtoken
    // infer the accepted set from the key instead of pinning it, so if that
    // export is ever renamed in middleware/auth.js this must not quietly widen.
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: TOKEN_ALGORITHMS || ['HS256'],
    });
    return Number.isFinite(decoded?.iat) ? decoded.iat * 1000 : null;
  } catch {
    return null;
  }
}

function hasFreshSession(req, now = Date.now()) {
  const issuedAt = tokenIssuedAtMs(req);
  if (issuedAt === null) return false;
  // A token minted "in the future" is clock skew between the signer and this
  // process, not an attack (the signer is this same app), so it counts as fresh.
  return now - issuedAt <= REAUTH_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Per-account attempt ceilings
// ---------------------------------------------------------------------------
// Asking for a password creates a place to GUESS a password. Nothing else in
// this file counted attempts, and the API limiter is 300 requests / 15 min PER
// IP, which is not a limit at all for someone with a stolen token and a handful
// of cloud addresses: they could sit on DELETE /api/users/me and brute force
// the account password (8 characters, one uppercase, one digit), which is worth
// far more than the account itself because people reuse it. Each guess also
// costs the server a full bcrypt round, so an unbounded guesser is a CPU drain
// on top. routes/auth.js does exactly this for /login (round 15); this is the
// same primitive for the two proofs in this file.
//
// In memory and therefore per process: a real ceiling on the single-instance
// Railway deployment, a partial one behind N instances. Same trade documented
// on the login throttle, and the same bounded map so an attacker cycling ids
// cannot grow it without limit.
const ATTEMPT_MAX_KEYS = 20000;

function attemptLimiter({ limit, windowMs }) {
  const hits = new Map();
  return {
    lockedFor(key, now = Date.now()) {
      const entry = hits.get(key);
      if (!entry) return 0;
      if (now >= entry.expiresAt) { hits.delete(key); return 0; }
      return entry.count >= limit ? entry.expiresAt - now : 0;
    },
    record(key, now = Date.now()) {
      if (hits.size > ATTEMPT_MAX_KEYS) {
        for (const [k, v] of hits) if (now >= v.expiresAt) hits.delete(k);
        if (hits.size > ATTEMPT_MAX_KEYS) hits.clear();
      }
      const entry = hits.get(key);
      if (!entry || now >= entry.expiresAt) {
        hits.set(key, { count: 1, expiresAt: now + windowMs });
        return;
      }
      entry.count += 1;
    },
    clear(key) { hits.delete(key); },
    clearAll() { hits.clear(); },
  };
}

// Wrong current-password / deletion-password proofs. Cleared on success, so a
// user who mistypes and then gets it right is never held back. Five attempts
// then a cooling-off period still leaves deletion genuinely reachable, which is
// the Apple 5.1.1(v) line this must not cross.
const proofFailures = attemptLimiter({ limit: 5, windowMs: 15 * 60 * 1000 });
const TOO_MANY_PROOFS_MESSAGE = 'Too many incorrect passwords. Try again in a few minutes.';

// Phone-number CHANGE attempts, successful ones included. The uniqueness check
// added below answers "is this number registered here?", which is an
// enumeration oracle that would otherwise run at the API limiter's 300 per 15
// minutes and bypass the contact-sync budget POST /api/friends/find-by-phone is
// metered by. Nobody changes their number five times an hour.
const phoneChangeAttempts = attemptLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });

// Email-address CHANGE attempts, successful ones included — round 19.
//
// The phone branch got this treatment and the email branch beside it did not,
// even though the email uniqueness check answers the strictly more valuable
// question: "does an account exist at this address?" That is the same oracle
// POST /api/auth/signup answers, and signup is behind the 10/min auth limiter
// precisely because of it — while PUT /api/users/profile sits behind the general
// API limiter at 3000/15min, roughly 200/min. So the profile form was a ~20x
// cheaper way to enumerate Flock's user base by address than the endpoint that
// was rate limited for exactly that reason, and the "already in use" 400 and the
// 200 are both answers.
//
// Ten an hour rather than the phone branch's five: an address is the field
// people actually mistype, and this must not turn a user who fat-fingers their
// new address a few times into a support ticket. Ten still takes the oracle from
// two hundred a minute to ten an hour, and costs an attacker a whole fresh
// account (which needs an address and a DOB, through the throttled auth
// limiter) for every ten probes.
const emailChangeAttempts = attemptLimiter({ limit: 10, windowMs: 60 * 60 * 1000 });
const TOO_MANY_EMAIL_CHANGES_MESSAGE =
  'You have changed your email address several times already. Try again later.';

// ---------------------------------------------------------------------------
// Ban-evasion tombstones (round 16) — see migrations/012_banned_identities.sql
// ---------------------------------------------------------------------------
// A banned user is allowed to delete their own account (Apple 5.1.1(v)), and
// before this nothing survived that deletion, so the ban was reversible by the
// banned person: delete, sign up again on the same email, get a clean row.
// Deleting a BANNED account now leaves keyed one-way digests of the identifiers
// a returning user would reuse. The full privacy and retention rationale is in
// the migration; the short version is that these users are frequently minors,
// so we store no plaintext, nothing that is not needed to recognise a return,
// and nothing that outlives the retention window.
const BAN_TOMBSTONE_RETENTION_DAYS = 365;

// The pepper is what makes these digests safe to hold: a 10-digit phone number
// has almost no entropy, so an unkeyed SHA-256 of one is reversible by anyone
// who reads the table. Dedicated env var if set, JWT_SECRET otherwise (always
// present — the server cannot mint a token without it).
function identityPepper() {
  return process.env.BAN_TOMBSTONE_SECRET || process.env.JWT_SECRET || '';
}

// `kind` is inside the HMAC input so an email digest can never be compared
// against, or collide with, a phone digest.
function identityDigest(kind, value) {
  const key = identityPepper();
  if (!key || !value) return null;
  return crypto.createHmac('sha256', key).update(`${kind}:${value}`).digest('hex');
}

// Match the comparison friend discovery actually uses: POST
// /api/friends/find-by-phone strips non-digits and compares the last 10, so a
// tombstone keyed on anything else would be defeated by retyping the number
// with different punctuation or a country code.
function canonicalPhone(phone) {
  if (typeof phone !== 'string' && typeof phone !== 'number') return '';
  const digits = String(phone).replace(/\D/g, '').slice(-10);
  return digits.length >= 7 ? digits : '';
}

function identityDigests({ email, phone, oauthProvider, oauthId } = {}) {
  const canonicalMail = typeof email === 'string' ? normalizedAddress(email.trim()) : '';
  const canonicalNumber = canonicalPhone(phone);
  const oauthKey = oauthProvider && oauthId
    ? `${String(oauthProvider).toLowerCase()}:${String(oauthId)}`
    : '';
  return {
    emailHash: canonicalMail ? identityDigest('email', canonicalMail) : null,
    phoneHash: canonicalNumber ? identityDigest('phone', canonicalNumber) : null,
    oauthHash: oauthKey ? identityDigest('oauth', oauthKey) : null,
  };
}

// The signup-side lookup. Exported for routes/auth.js, which owns every account
// creation path (password signup, Google, Apple).
//
// FAILS OPEN on a database error, deliberately. This sits in front of every
// signup in the product: failing closed would turn one bad query into "nobody
// can create an account", which is a far worse outcome than a banned user
// getting back in during an outage. The failure is logged loudly instead.
async function isIdentityBanned(identity) {
  try {
    const { emailHash, phoneHash, oauthHash } = identityDigests(identity || {});
    if (!emailHash && !phoneHash && !oauthHash) return false;
    const result = await pool.query(
      `SELECT 1 FROM banned_identities
        WHERE expires_at > NOW()
          AND (($1::text IS NOT NULL AND email_hash = $1)
            OR ($2::text IS NOT NULL AND phone_hash = $2)
            OR ($3::text IS NOT NULL AND oauth_hash = $3))
        LIMIT 1`,
      [emailHash, phoneHash, oauthHash]
    );
    maybePurgeExpired();
    return result.rows.length > 0;
  } catch (err) {
    console.error('[ban-tombstone] lookup failed, allowing signup:', err.message);
    return false;
  }
}

// Deliberately vague, and identical whatever matched: a precise message would
// tell an attacker which of a victim's identifiers is on the list, turning this
// into an oracle ("is this phone number banned?").
// hello@flockcorp.com is the address the app actually sends from
// (services/emailService.js). Inventing a support@ that nobody reads would be
// worse than saying nothing, and this is the only route a false positive (a
// recycled phone number) has back to a human.
const BANNED_IDENTITY_MESSAGE =
  'This account cannot be created. If you believe this is a mistake, contact hello@flockcorp.com.';

// Mirrors rejectIfProfane(res, name) in utils/moderation.js: returns true when
// it has already sent the response, so the caller writes one line.
async function rejectIfBannedIdentity(res, identity) {
  if (!(await isIdentityBanned(identity))) return false;
  console.warn(`[ban-tombstone] blocked signup for a tombstoned identity at ${new Date().toISOString()}`);
  res.status(403).json({ error: BANNED_IDENTITY_MESSAGE });
  return true;
}

// Written inside the account-deletion transaction (see deleteAccount) so the
// tombstone and the row's disappearance are the same atomic event. If this
// throws, the whole deletion rolls back and the caller is told to retry, which
// is the same trade the round-12 moderation-evidence de-attribution already
// makes: never let the account vanish while the record of it fails to land.
async function recordBannedIdentity(client, user) {
  // HIGH 1 (re-audit): a password account's email is UNVERIFIED — proving
  // ownership is the entire reason email verification exists. Hashing
  // user.email unconditionally turned this into a poison pill: register a
  // password squat on a victim's address (unverified squats are allowed), get
  // it banned (unverified accounts can still send DMs, so an abuse-report ban
  // is reachable), then delete the squat, and this wrote HMAC(victim's address)
  // with a 365-day expiry. The real owner could then never sign up on any path
  // (password, Google, Apple all 403 on the tombstone), and the reclaim-via-
  // verified-OAuth-claim path never runs because the squat row is gone. So only
  // tombstone an address this account actually PROVED. The oauth digest stays
  // unconditional — a provider-verified identity genuinely belongs to the
  // banned person. An unverified banned account then leaves only an oauth
  // tombstone or none, never a block on a stranger's mailbox.
  // A grandfathered row (verified before migration 011) carries email_verified
  // TRUE with a NULL verified_email; claimDecision() in routes/auth.js trusts
  // exactly that state, so this mirrors it — a null recorded address on a
  // verified row means "trust the address it holds". The attack this closes is
  // an UNVERIFIED squat, which has email_verified === false and never reaches
  // here.
  //
  // ROUND 19 (re-audit): the first cut of this fix required verified_email to
  // MATCH the current email and tombstoned user.email. That branded the address
  // the row HOLDS, and it only did so when the row also still held the address
  // it had PROVED — so an account that moved off its proven address before the
  // ban landed shed the tombstone entirely. Deleting it recorded nothing about
  // an email, and the banned person signed up again on the original address with
  // a clean row. (The ban blocks PUT /profile, so the move has to happen before
  // the ban; that narrows the window, it does not close it.)
  //
  // Brand the PROVED address instead. verified_email is only ever written as
  // `verified_email = email` at the moment a link was clicked (consumeVerification
  // in routes/auth.js), at an OAuth INSERT where the provider vouched for the
  // address, or by migration 011's grandfathering — it is never attacker-chosen
  // free text. So it carries the same poison-pill safety the round-16 fix was
  // reaching for: an address a squatter merely TYPED into its profile never
  // appears here, and a stranger's mailbox can still never be branded by
  // someone who cannot read it. What it adds is that the brand follows the
  // proof rather than the current holder of the row.
  //
  // Order matters: verified_email FIRST, current email only as the grandfathered
  // fallback. Reading them the other way round would go back to branding the
  // address the row holds whenever it happens to be flagged verified, which is
  // the state a pre-round-18 profile edit leaves behind (email_verified TRUE for
  // an address the row never proved) — the poison pill, exactly.
  //
  // Residual, accepted: if the banned row vacated its proved address long enough
  // ago that somebody else has since registered it, that person's address is now
  // branded too — they keep their account, but a delete-and-re-signup would be
  // refused for the rest of the retention window. It is the same recycled-
  // identifier exposure the phone digest already carries, it needs the address to
  // have been vacated AND re-registered AND then re-registered again, and the
  // alternative is branding nothing at all, which is a guaranteed evasion. A
  // "skip if another row holds it now" check would be worse: it hands the
  // attacker a suppression switch (park a second account on the address before
  // the ban lands).
  //
  // NOT used: email_verifications rows with used_at set. That looks like a proof
  // history, but releaseSquattedAddress() in routes/auth.js bulk-stamps used_at
  // on an evicted squat's PENDING links purely to invalidate them, so a row
  // there can record an address that was never read by anybody. Tombstoning off
  // that table would re-arm the exact poison pill this guard exists to prevent.
  const provenAddress = user.verified_email
    || (user.email_verified === true ? user.email : null);
  const { emailHash, phoneHash, oauthHash } = identityDigests({
    email: provenAddress || undefined,
    phone: user.phone,
    oauthProvider: user.oauth_provider,
    oauthId: user.oauth_id,
  });
  if (!emailHash && !phoneHash && !oauthHash) {
    // No usable identifier (no pepper configured, or an Apple relay row with
    // nothing but a placeholder address). Writing an empty row would violate
    // the table's CHECK and would hold data about a minor for no purpose.
    console.warn('[ban-tombstone] no usable identifier for the deleted banned account, nothing recorded');
    return false;
  }
  await client.query(
    `INSERT INTO banned_identities (email_hash, phone_hash, oauth_hash, banned_at, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5::int * INTERVAL '1 day'))`,
    [emailHash, phoneHash, oauthHash, user.banned_at || null, BAN_TOMBSTONE_RETENTION_DAYS]
  );
  return true;
}

// Retention is enforced by the read path (every lookup filters expires_at), so
// an expired tombstone stops having any effect the moment it expires whether or
// not this has run. But "it expires" has to mean the row is actually gone, not
// just ignored, or the retention promise in the migration is a lie the first
// time anyone reads the table. Best-effort and outside any transaction: it must
// never be able to fail an account deletion.
async function purgeExpiredBannedIdentities() {
  try {
    const result = await pool.query('DELETE FROM banned_identities WHERE expires_at <= NOW()');
    return result.rowCount || 0;
  } catch (err) {
    console.error('[ban-tombstone] purge failed:', err.message);
    return 0;
  }
}

// There is no scheduler in this app, and hanging retention off "a banned
// account happened to be deleted" would mean a quiet year leaves expired rows
// on disk indefinitely. Signups are the one thing that reliably happens, so the
// lookup triggers the purge — at most once an hour per process, fire and
// forget, so it can never add latency to a signup or fail one.
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
let lastPurgeAt = 0;

function maybePurgeExpired(now = Date.now()) {
  if (now - lastPurgeAt < PURGE_INTERVAL_MS) return false;
  lastPurgeAt = now;
  purgeExpiredBannedIdentities().catch(() => {});
  return true;
}

// PUT /api/users/profile - Update current user's profile (requires current password)
router.put('/profile',
  [
    // `optional({ nullable: true })` throughout (round 20): the handler below
    // already reads a falsy value as "leave this column alone" — `name || null`,
    // `Boolean(email)`, `if (new_password)`, and a bcrypt compare against '' —
    // while express-validator's `optional()` skips only `undefined`. A client
    // that spells an untouched field as an explicit null (which the phone field
    // beside them has accepted since round 16) was answered 400 by the chain for
    // a submission the handler knows how to serve.
    // `scalarOnly` at the HEAD of this chain, not in the handler loop below
    // (round 20). That loop catches an array, because an array survives the
    // chain intact — but `trim()` stringifies an OBJECT, so `{"name": {}}` had
    // already become the string "[object Object]" by the time the loop saw it,
    // passed as a perfectly good string, and was stored in users.name. Shape has
    // to be settled before the first sanitizer, not after the last one.
    // freeText = shape -> trim -> stripHtml -> trim, and the trailing trim is
    // the half this chain was missing: stripHtml('<b> </b>') is a single space,
    // which satisfies isLength({ min: 1 }) and sails past rejectIfProfane, so
    // the rename accepted a BLANK name into the column every roster, invite,
    // chat row and push renders. Sanitize, then trim, then measure.
    freeText(body('name').optional({ nullable: true }), 'name')
      .isLength({ min: 1, max: 255 }).withMessage('Name must be 1-255 characters'),
    // normalizeEmail() matches signup and login (routes/auth.js), so
    // `v.ictim@gmail.com` cannot be stored as a distinct row that shadows
    // `victim@gmail.com` in the LOWER(email) lookups those paths use.
    body('email').optional({ nullable: true }).isEmail().normalizeEmail().withMessage('Valid email required'),
    // Round 16: this was `body('phone').optional()` with NO validation at all,
    // while signup runs isMobilePhone(). Two separate problems came out of that:
    // anything at all could be written into the column (a name, a URL, an
    // address — the field is shown to friends), and a string longer than the
    // VARCHAR(20) column 500'd at the database instead of returning a 400.
    // checkFalsy keeps the existing behaviour for clients that submit the whole
    // profile form with an empty phone field: '' becomes NULL in the parameter
    // list and COALESCE leaves the stored value alone, exactly as before. It
    // must not start 400ing them.
    body('phone').optional({ nullable: true, checkFalsy: true }).trim()
      .isMobilePhone().withMessage('Invalid phone number')
      .isLength({ max: 20 }).withMessage('Phone number is too long'),
    body('interests').optional({ nullable: true }).isArray(),
    // Optional at the validator layer: OAuth accounts have no password, and a
    // notEmpty() here 400'd their profile edits before the OAuth-aware handler
    // below could run. Password accounts still fail closed — the bcrypt
    // compare against a missing value returns 401.
    body('current_password').optional({ nullable: true }).isString(),
    body('new_password').optional({ nullable: true })
      .isLength({ min: 8 }).withMessage('New password must be at least 8 characters')
      .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
      .matches(/[0-9]/).withMessage('Password must contain at least one number'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { name, email, phone, interests, current_password, new_password } = req.body;

      // ARRAY-SHAPED FIELDS WALK PAST express-validator (round 16). Given
      // `{"phone": ["+12025550122"]}` the chain runs per ELEMENT, every element
      // passes isMobilePhone, and req.body.phone is STILL AN ARRAY afterwards —
      // sanitizers write back element by element and never collapse it. It then
      // goes to pg as an array parameter for a text column, which stores the
      // literal `{"+12025550122"}`: a value that is not a phone number, is
      // still matched digit-for-digit by find-by-phone, and can overflow
      // VARCHAR(20) into a 500. The same shape hits name, email and the two
      // password fields (bcrypt throws on a non-string, which is another 500).
      // Validators check CONTENT; this checks TYPE, which is the half they
      // structurally cannot do.
      for (const [field, value] of Object.entries({ name, email, phone, current_password, new_password })) {
        if (value !== undefined && value !== null && typeof value !== 'string') {
          return res.status(400).json({ error: `Invalid ${field.replace('_', ' ')}` });
        }
      }

      // UGC text filter on display name (Apple 1.2).
      if (name && rejectIfProfane(res, name)) return;

      const safeInterests = interests ? sanitizeArray(interests) : null;

      // Fetch current user with password
      const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = userResult.rows[0];

      // Verify current password. OAuth accounts have no password (round 3:
      // bcrypt.compare against null threw and locked Google/Apple users out
      // of every profile edit); their bearer token is their auth. They can't
      // SET a password here either — that would bolt a second credential
      // onto an OAuth account without any email-ownership verification.
      if (user.password) {
        // Round 16: bounded. See proofFailures above — this is a password
        // guessing surface for anyone holding a token, and it counted nothing.
        if (proofFailures.lockedFor(user.id) > 0) {
          return res.status(429).json({ error: TOO_MANY_PROOFS_MESSAGE });
        }
        const validPassword = await bcrypt.compare(
          typeof current_password === 'string' ? current_password : '',
          user.password
        );
        if (!validPassword) {
          proofFailures.record(user.id);
          return res.status(401).json({ error: 'Current password is incorrect' });
        }
        proofFailures.clear(user.id);
      } else if (new_password) {
        return res.status(400).json({ error: 'This account signs in with Google or Apple and has no password.' });
      }

      // Check email uniqueness if changing email
      const changingEmail = Boolean(email) && normalizedAddress(email) !== normalizedAddress(user.email);
      if (changingEmail) {
        // PERMANENT EMAIL SQUAT (round 13). Nothing here ever verified that the
        // caller owns the address they are moving to, and an OAuth row needs no
        // password to reach this handler at all. So: sign in with your own
        // Google account, set email = victim@gmail.com, and the victim can
        // never join Flock — Google 409s, Apple 409s, password signup says
        // "already registered". The round-8 claim logic in routes/auth.js
        // deliberately refuses to claim a row that already carries an
        // oauth_provider, so that squat is the exact case it cannot break, and
        // no admin route exists to undo it.
        //
        // On an OAuth row the PROVIDER owns the address: the row's email is the
        // one Google/Apple verified, and it is the linkage users see. Refuse to
        // change it. (Password rows keep the edit — it is gated on the current
        // password above, and a password row CAN still be claimed back by the
        // address's verified owner through the OAuth claim path.)
        if (user.oauth_provider) {
          return res.status(400).json({
            error: 'This account signs in with Google or Apple, so its email is managed by that provider and cannot be changed here.',
          });
        }
        // Belt (round 19): every branch below assumes this request proved
        // possession, and for a password row it did — the bcrypt compare above
        // refuses the whole handler otherwise. An OAuth row is refused outright
        // just above. That leaves a row with NEITHER, which no path in the app
        // is supposed to produce; if one ever appears (a drifted row, a future
        // provider unlink), changing the account's identifying address would be
        // the one identity-defining edit in this file reachable on a bearer
        // token alone. Require the same recent sign-in the phone branch does.
        if (!user.password && !hasFreshSession(req)) {
          return res.status(401).json({
            error: 'For your security, sign in again before changing your email address.',
            reauthRequired: 'reauth',
          });
        }

        // Metered BEFORE the uniqueness probe, the same way the phone branch
        // meters before its own — the refusal below IS the oracle's answer, so
        // counting only the attempts that get past it would meter everything
        // except the thing worth metering. See emailChangeAttempts above.
        if (emailChangeAttempts.lockedFor(req.user.id) > 0) {
          return res.status(429).json({ error: TOO_MANY_EMAIL_CHANGES_MESSAGE });
        }
        emailChangeAttempts.record(req.user.id);

        // SHADOW ACCOUNT (round 18 re-audit). This was a plain LOWER() match
        // while every lookup in routes/auth.js compares in the CANONICAL
        // alphabet, and the two sides of that comparison are written in
        // different ones: the submitted address has been through
        // normalizeEmail() (Gmail dots and +subaddresses stripped) while an
        // OAuth row stores the provider's address verbatim, dots and all. So a
        // victim signed in with Google as `john.doe@gmail.com`, an attacker
        // moved their own row onto `johndoe@gmail.com`, LOWER() saw no clash,
        // the users.email UNIQUE index saw a different string, and two rows
        // owned one mailbox. That is precisely the hole canonicalEmail() was
        // written for; this route was the one door still open to it.
        //
        // The expression comes from routes/auth.js so the two cannot drift.
        // Required lazily for the same reason that file requires this one
        // lazily: neither module should be pulled in at the other's load time.
        // AND binds tighter than OR, so this reads `(exact AND other) OR
        // (canonical AND other)` — both halves exclude the caller's own row.
        const { canonicalEmail, EMAIL_CANONICAL_SQL } = require('./auth');
        const emailCheck = await pool.query(
          `SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id != $2
              OR ${EMAIL_CANONICAL_SQL} = $3 AND id != $2`,
          [email, req.user.id, canonicalEmail(email)]
        );
        if (emailCheck.rows.length > 0) {
          return res.status(400).json({ error: 'Email is already in use' });
        }

        // ROUND 19 (re-audit): the same gap MEDIUM 3 closed for phone, left open
        // for email. banned_identities.email_hash is consulted on the three
        // ACCOUNT CREATION paths in routes/auth.js and nowhere else, so a banned
        // user who deleted their account could sign up on a throwaway address
        // (allowed — nothing about it is tombstoned) and then MOVE that fresh row
        // onto their tombstoned address here, which is the address their friends,
        // their invites and their reputation are attached to. Every other gate on
        // this branch waves it through: the address is free (the banned row was
        // deleted), the row has no oauth_provider, and the current-password proof
        // is their own. Consult the tombstone where the address is actually
        // claimed, not only where a row is created.
        //
        // Placed AFTER the uniqueness check on purpose. It adds no oracle that
        // does not already exist — POST /api/auth/signup answers "is this address
        // tombstoned?" with a 403 for free — and putting it last keeps the
        // cheapest answer on this route the one it already gave.
        //
        // No poison-pill risk in the other direction: a tombstoned address is
        // already refused to everyone at signup, so refusing it here denies
        // nothing that was still available.
        if (await rejectIfBannedIdentity(res, { email })) return;
      }

      // PHONE NUMBER CLAIMS (round 16). phone is not a cosmetic profile field:
      // POST /api/friends/find-by-phone resolves contact-sync lookups against
      // it, so whoever holds a number receives the friend requests meant for
      // it. Nothing here verified ownership (no SMS verification exists yet)
      // and nothing even checked the number was free, so an attacker could type
      // a victim's number into their own profile and start collecting the
      // victim's contact-sync hits. Two guards, in the order they matter:
      //
      //   1. Same proof as changing a password. Password accounts already
      //      cleared that bar above (this handler refuses every edit without
      //      the current password). OAuth accounts have no password, so a
      //      stolen token could rewrite the number silently — they must show a
      //      session minted by a provider sign-in in the last few minutes.
      //   2. One account per number. Not ownership proof, but it stops the
      //      claim from ever pointing two rows at one number, which is the
      //      state the lookup cannot disambiguate.
      //
      // Comparison is on the last 10 digits, matching find-by-phone, so
      // reformatting the same number is not treated as a change and costs the
      // user nothing.
      const changingPhone = Boolean(phone) && canonicalPhone(phone) !== canonicalPhone(user.phone);
      if (changingPhone) {
        // HIGH 2 (re-audit): "unverified accounts cannot accumulate" is the
        // whole point of email verification, but the UNVERIFIED_DENY backstop in
        // middleware/auth.js lists the payment, friends and flock routes and NOT
        // PUT /api/users/profile, and nothing mounts requireVerified here (the
        // deny list fails open for unlisted routes). Signup deliberately no
        // longer accepts a phone precisely to stop a squatter claiming a
        // victim's number, but this route reopened that hole: an unverified
        // account could PUT { phone: "<victim's number>" }, the uniqueness check
        // only blocks already-registered numbers, so an unregistered victim
        // number succeeds and contact-sync discovery then resolves it to the
        // attacker. Gate the phone change (only) on verification; the name edits
        // on this route stay open to unverified accounts, which is why this is a
        // branch-level check and not a coarse requireVerified on the route.
        // (current_password is NOT proof of phone ownership; a real fix needs
        // SMS possession, which is out of scope here.)
        //
        // Round 19: read BOTH copies of the flag, not just req.user's. req.user
        // is middleware/auth.js's projection of the row and this handler has
        // already re-read the whole row into `user`; a gate that consults only
        // the projection fails OPEN the day that SELECT stops carrying the
        // column, and it would fail open silently. `=== false` on each is the
        // convention claimDecision() uses for a NOT NULL column that was
        // grandfathered TRUE. `user` is also the fresher of the two reads, so a
        // row that lost its verification between the middleware's SELECT and
        // this one is caught in the right direction.
        if (user.email_verified === false || req.user.email_verified === false) {
          return res.status(403).json({ error: UNVERIFIED_MESSAGE, emailVerificationRequired: true });
        }

        // Proof first, THEN metering. Counting unproven attempts would let
        // anyone holding a stale token burn the real owner's quota and lock
        // them out of their own profile for an hour without ever getting past
        // this line.
        if (!user.password && !hasFreshSession(req)) {
          return res.status(401).json({
            error: 'For your security, sign in again before changing your phone number.',
            reauthRequired: 'reauth',
          });
        }

        // The 409 below is an existence oracle for "is this number registered
        // with Flock", and it must not be a cheaper one than contact sync,
        // which POST /api/friends/find-by-phone meters for exactly that reason.
        // Attempts count whether they end in a 409 or a successful change.
        if (phoneChangeAttempts.lockedFor(req.user.id) > 0) {
          return res.status(429).json({ error: 'You have changed your phone number several times already. Try again later.' });
        }
        phoneChangeAttempts.record(req.user.id);

        // MEDIUM 3 (re-audit): banned_identities.phone_hash is WRITTEN on the
        // deletion of a banned account but was never READ anywhere — every
        // rejectIfBannedIdentity call in routes/auth.js passes only email and
        // oauth identifiers, and the phone-set path never consulted the
        // tombstone. So a banned user could re-attach the same number under a
        // fresh email and regain contact-sync discovery. Consult it here, where
        // a phone is actually set, after the verification and re-auth gates so
        // the check runs against a number this account can genuinely hold, and
        // after metering so it is not a cheaper "is this number banned?" oracle.
        // The refusal message is the generic banned-identity one, which leaks
        // nothing about which identifier matched.
        if (await rejectIfBannedIdentity(res, { phone })) return;

        const digits = canonicalPhone(phone);
        if (digits) {
          const phoneCheck = await pool.query(
            `SELECT id FROM users
              WHERE id != $1 AND phone IS NOT NULL
                AND RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $2
              LIMIT 1`,
            [req.user.id, digits]
          );
          if (phoneCheck.rows.length > 0) {
            return res.status(409).json({ error: 'That phone number is already linked to another Flock account.' });
          }
        }
      }

      // Hash new password if provided
      let hashedPassword = null;
      if (new_password) {
        hashedPassword = await bcrypt.hash(new_password, SALT_ROUNDS);
      }

      // A password change bumps token_version, which invalidates every JWT
      // already outstanding for this account (round 13 — that is the whole
      // point of changing a password you think someone else has). The caller's
      // own token dies with the rest, so we mint and return a replacement.
      //
      // AN EMAIL CHANGE UN-VERIFIES THE ROW (round 18 re-audit). Verification is
      // per-ADDRESS: email_verified means "this account proved it can read the
      // address it currently holds", and moving the address makes that claim
      // false. Leaving the flag set was a PERMANENT SQUAT on any address:
      // sign up, verify your own mailbox, then move the row onto victim@gmail
      // and stop. claimDecision() in routes/auth.js compares verified_email
      // against the provider's address, sees a row that proved a DIFFERENT
      // mailbox, and returns 'refuse' — so the victim's Google sign-in 409s,
      // their Apple sign-in 409s and password signup says "already registered",
      // for ever, with no admin route to undo it. Refusing to hand the row over
      // was the right call; leaving it holding the address was not.
      //
      // Un-verified, the same row decides as 'evict': the address's real owner
      // signs in with a provider-verified token, takes the address back, and the
      // squatter keeps their own data under a tombstone. It also stops a
      // moved-onto address being tombstoned on deletion (recordBannedIdentity
      // reads exactly these two columns) and puts the row back inside the
      // round-16 accumulation gate until it proves the NEW address.
      //
      // Written as CASE over $2 rather than a new parameter on purpose: $2 is
      // already `changingEmail ? email : null`, so the two columns move with the
      // address and only with the address, and the statement keeps its shape.
      const result = await pool.query(
        `UPDATE users
         SET name = COALESCE($1, name),
             email = COALESCE($2, email),
             email_verified = CASE WHEN $2::text IS NULL THEN email_verified ELSE FALSE END,
             verified_email = CASE WHEN $2::text IS NULL THEN verified_email ELSE NULL END,
             phone = COALESCE($3, phone),
             interests = COALESCE($4, interests),
             password = COALESCE($5, password),
             token_version = token_version + CASE WHEN $5::text IS NULL THEN 0 ELSE 1 END,
             updated_at = NOW()
         WHERE id = $6
         RETURNING id, email, name, phone, interests, role, profile_image_url, email_verified, token_version, created_at, updated_at`,
        // Only write the email column on a real change, so an unchanged form
        // never silently rewrites a stored address into its normalized form.
        [name || null, changingEmail ? email : null, phone || null, safeInterests, hashedPassword, req.user.id]
      );

      // A password change bumps token_version, which stops the thief's REST
      // calls, but a WebSocket authenticates once at the handshake and then
      // lives indefinitely in user:{id}, where every DM, flock message and
      // location update is delivered. Without this the person you changed your
      // password to evict keeps reading your traffic in real time.
      if (hashedPassword) revokeUserSessions(req.app.get('io'), req.user.id);

      const { token_version: _tv, ...safeUser } = result.rows[0];
      res.json({
        user: safeUser,
        ...(hashedPassword ? { token: signUserToken(result.rows[0]) } : {}),
        // The address moved, so the row is unverified again and the round-16
        // gate is back on. Say so, or the next payment/friend/flock call is an
        // unexplained 403. POST /api/auth/resend-verification mails the link for
        // the new address.
        ...(changingEmail ? { emailVerificationRequired: true } : {}),
      });
    } catch (err) {
      console.error('Update profile error:', err);
      res.status(500).json({ error: 'Failed to update profile' });
    }
  }
);

// GET /api/users/stats - Get user's real stats (friends, XP, streak)
router.get('/stats', async (req, res) => {
  try {
    const userId = req.user.id;

    // Friend count
    const friendResult = await pool.query(
      `SELECT COUNT(*) FROM friendships WHERE (requester_id = $1 OR addressee_id = $1) AND status = 'accepted'`,
      [userId]
    );
    const friendCount = parseInt(friendResult.rows[0].count);

    // Flock count
    const flockResult = await pool.query(
      `SELECT COUNT(*) FROM flock_members WHERE user_id = $1 AND status = 'accepted'`,
      [userId]
    );
    const flockCount = parseInt(flockResult.rows[0].count);

    // Messages sent (flock + DM)
    const flockMsgResult = await pool.query(
      `SELECT COUNT(*) FROM messages WHERE sender_id = $1`,
      [userId]
    );
    const dmMsgResult = await pool.query(
      `SELECT COUNT(*) FROM direct_messages WHERE sender_id = $1`,
      [userId]
    );
    const messageCount = parseInt(flockMsgResult.rows[0].count) + parseInt(dmMsgResult.rows[0].count);

    // Flocks created
    const createdResult = await pool.query(
      `SELECT COUNT(*) FROM flocks WHERE creator_id = $1`,
      [userId]
    );
    const flocksCreated = parseInt(createdResult.rows[0].count);

    // Calculate XP: 50 per flock created, 20 per flock joined, 5 per message, 10 per friend
    const xp = (flocksCreated * 50) + (Math.max(0, flockCount - flocksCreated) * 20) + (messageCount * 5) + (friendCount * 10);
    const level = Math.floor(xp / 100) + 1;

    // Streak: count consecutive days with activity (messages or flock joins) going back from today
    const activityResult = await pool.query(
      `SELECT DISTINCT DATE(created_at AT TIME ZONE 'UTC') AS d FROM (
        SELECT created_at FROM messages WHERE sender_id = $1
        UNION ALL
        SELECT created_at FROM direct_messages WHERE sender_id = $1
        UNION ALL
        SELECT joined_at AS created_at FROM flock_members WHERE user_id = $1
      ) AS activity ORDER BY d DESC LIMIT 60`,
      [userId]
    );
    let streak = 0;
    if (activityResult.rows.length > 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const dates = activityResult.rows.map(r => {
        const d = new Date(r.d);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
      });
      // Check if today or yesterday has activity, then count back
      const dayMs = 86400000;
      let checkDate = today.getTime();
      if (!dates.includes(checkDate)) {
        checkDate -= dayMs; // allow yesterday as start
      }
      while (dates.includes(checkDate)) {
        streak++;
        checkDate -= dayMs;
      }
    }

    // Reliability score
    const reliabilityResult = await pool.query(
      'SELECT reliability_score, total_plans_joined, total_plans_attended FROM users WHERE id = $1',
      [userId]
    );
    const rel = reliabilityResult.rows[0] || {};

    res.json({
      friendCount, flockCount, flocksCreated, messageCount, xp, level, streak,
      reliabilityScore: rel.reliability_score ? parseFloat(rel.reliability_score) : null,
      totalPlansJoined: rel.total_plans_joined || 0,
      totalPlansAttended: rel.total_plans_attended || 0,
    });
  } catch (err) {
    console.error('Get user stats error:', err);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// GET /api/users/search?q= - Search users by name only (no email exposure)
router.get('/search',
  // `?q[]=a&q[]=b` is an array to express and satisfies isLength by coercion.
  // `String(req.query.q)` below already flattened it to "a,b" so it never
  // reached pg structured — but a search term that silently means something
  // other than what was typed is worth refusing rather than guessing at.
  scalarOnly(query('q'), 'search query').trim().isLength({ min: 1 }).withMessage('Search query is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      // ILIKE wildcards have to be escaped, not interpolated. `q=%` built the
      // pattern '%%%', which matches every row: 20 arbitrary accounts (id,
      // name, avatar) per request, and patterns like `a%` / `_` let a caller
      // walk the whole user directory a slice at a time. Escaping turns the
      // query back into a literal substring search.
      const searchTerm = `%${String(req.query.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

      // Mutual invisibility: blocked pairs never rediscover each other here.
      const result = await pool.query(
        `SELECT id, name, profile_image_url
         FROM users
         WHERE name ILIKE $1 AND id != $2
           AND NOT EXISTS (
             SELECT 1 FROM user_blocks b
             WHERE (b.blocker_id = $2 AND b.blocked_id = users.id)
                OR (b.blocker_id = users.id AND b.blocked_id = $2)
           )
         LIMIT 20`,
        [searchTerm, req.user.id]
      );

      res.json({ users: result.rows });
    } catch (err) {
      console.error('Search users error:', err);
      res.status(500).json({ error: 'Failed to search users' });
    }
  }
);

// GET /api/users/suggested - Get suggested users (flock mates, ordered by shared flock count)
router.get('/suggested', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.profile_image_url, COUNT(fm2.flock_id) AS shared_flocks
       FROM flock_members fm1
       JOIN flock_members fm2 ON fm2.flock_id = fm1.flock_id AND fm2.user_id != fm1.user_id AND fm2.status = 'accepted'
       JOIN users u ON u.id = fm2.user_id
       WHERE fm1.user_id = $1 AND fm1.status = 'accepted'
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $1 AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = $1)
         )
       GROUP BY u.id, u.name, u.profile_image_url
       ORDER BY shared_flocks DESC, u.name ASC
       LIMIT 10`,
      [req.user.id]
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('Suggested users error:', err);
    res.status(500).json({ error: 'Failed to get suggested users' });
  }
});

// POST /api/users/upload-image - Upload profile image
router.post('/upload-image', (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'File too large. Maximum size is 5 MB.' });
      }
      console.error('[Upload] Error:', err.message);
      return res.status(400).json({ error: 'Upload failed. Please try a different image.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    // Verify file content matches an actual image (magic bytes)
    const format = detectImageFormat(req.file.buffer);
    if (!format) {
      return res.status(400).json({ error: 'File is not a valid image' });
    }

    try {
      // Convert to base64 data URL and store in DB (survives Railway redeploys).
      //
      // Re-audit: the MIME in this data URL used to be `req.file.mimetype`,
      // which is a header the CLIENT writes, copied verbatim into a string that
      // is then stored forever and rendered as an <img src> on every message
      // row, roster and profile in the app. Two problems, one fix: the declared
      // type could disagree with the bytes we just verified (a GIF announced as
      // image/png), and the fileFilter above tests it with a SUBSTRING regex, so
      // values like `image/svg+xml;png` passed it and produced a malformed data
      // URL. The magic bytes already told us what this file is; use that answer
      // and nothing else.
      //
      // Belt: a format added to IMAGE_SIGNATURES without a matching entry here
      // would otherwise ship `data:undefined;base64,...` into every avatar slot
      // in the app, which renders as a broken image and is unfixable for the
      // user. The two tables must not be able to drift apart silently.
      const detectedMime = DETECTED_MIME[format];
      if (!detectedMime) {
        console.error(`[Upload] no MIME mapped for detected format "${format}"`);
        return res.status(400).json({ error: 'That image format is not supported.' });
      }
      const dataUrl = `data:${detectedMime};base64,${req.file.buffer.toString('base64')}`;

      // Cap the STORED data URL, not just the raw upload. Avatars are stored
      // inline in users.profile_image_url and repeated on every message-history
      // row and socket send, so a multi-MB base64 avatar amplifies into
      // hundreds of MB of transfer (REVIEW-ROUND5). 600KB keeps that bounded.
      const MAX_AVATAR_DATA_URL_BYTES = 600 * 1024;
      if (Buffer.byteLength(dataUrl) > MAX_AVATAR_DATA_URL_BYTES) {
        return res.status(400).json({
          error: 'That photo is too large to use as a profile picture. Please pick a smaller photo (under about 400 KB).',
        });
      }

      // Image moderation (A2b) — synchronous + FAIL-CLOSED. This is the only
      // upload endpoint, so screening here gates every user image before its
      // URL is returned or stored. Dev (no provider) allows with a warning;
      // prod requires a provider via IMAGE_MODERATION_REQUIRED=true.
      //
      // Round 18: this also covers ANIMATED avatars. Cloud Vision screens only
      // frame 1, so an animated GIF/APNG/WebP avatar could carry anything past
      // it — and an avatar is the one image that follows a user onto every
      // message row, every roster and every push. The fileFilter above still
      // accepts image/gif on purpose: a STILL GIF is fine, and a filter on
      // extension or MIME could not tell the two apart anyway (an APNG is
      // `image/png`). The frame count is decided from the bytes inside
      // moderateImage.
      const verdict = await moderateImage(dataUrl);
      if (!verdict.allowed) {
        return res.status(400).json({ error: imageRejectionMessage(verdict), moderation: verdict.reason });
      }

      await pool.query(
        'UPDATE users SET profile_image_url = $1, updated_at = NOW() WHERE id = $2',
        [dataUrl, req.user.id]
      );

      res.json({ profile_image_url: dataUrl });
    } catch (dbErr) {
      console.error('Upload image error:', dbErr);
      res.status(500).json({ error: 'Failed to save image' });
    }
  });
});

// PUT /api/users/profile-image - Save an external avatar URL (e.g. DiceBear)
router.put('/profile-image',
  [
    // Shape first (round 20). `{"url": ["https://api.dicebear.com/x"]}`
    // satisfied isURL by coercion and stayed an array, and `new URL(value)`
    // stringifies its argument — so the host allowlist below passed too, and the
    // array went to pg as a parameter for users.profile_image_url (TEXT). A 500
    // on the one route in this file that writes the avatar every roster, message
    // row and push renders.
    scalarOnly(body('url'), 'URL').trim().isURL({ protocols: ['https'], require_protocol: true }).withMessage('Valid HTTPS URL required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { url } = req.body;

      // Only allow URLs from trusted avatar services
      const allowedHosts = ['api.dicebear.com'];
      let hostname;
      try { hostname = new URL(url).hostname; } catch { return res.status(400).json({ error: 'Invalid URL' }); }
      if (!allowedHosts.includes(hostname)) {
        return res.status(400).json({ error: 'Avatar URL must be from a trusted provider' });
      }

      await pool.query(
        'UPDATE users SET profile_image_url = $1, updated_at = NOW() WHERE id = $2',
        [url, req.user.id]
      );

      res.json({ profile_image_url: url });
    } catch (err) {
      console.error('Save avatar URL error:', err);
      res.status(500).json({ error: 'Failed to save avatar' });
    }
  }
);

// PUT /api/users/venmo-username — Update Venmo username
router.put('/venmo-username',
  [
    // SHAPE BEFORE CONTENT (round 20). A payment handle is the field that
    // decides who gets paid when a bill is split, and `{"venmo_username":
    // ["evil"]}` satisfied both isLength and matches() — express-validator
    // stringifies a one-element array before testing it — then stayed an array,
    // so `venmo_username.replace(/^@/, '')` below threw a TypeError and the
    // route answered 500. An empty array was worse in kind: `[]` is TRUTHY in
    // JavaScript, so it took the "clean it" branch instead of the "clear it"
    // branch and threw there too.
    scalarOnly(body('venmo_username').optional({ nullable: true }), 'Venmo username')
      .trim().isLength({ max: 50 }).withMessage('Venmo username too long')
      .matches(/^[a-zA-Z0-9_-]*$/).withMessage('Venmo username can only contain letters, numbers, hyphens, and underscores'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { venmo_username } = req.body;
      // Strip leading @ if provided
      const clean = venmo_username ? venmo_username.replace(/^@/, '') : null;

      await pool.query(
        'UPDATE users SET venmo_username = $1, updated_at = NOW() WHERE id = $2',
        [clean, req.user.id]
      );

      res.json({ venmo_username: clean });
    } catch (err) {
      console.error('Update venmo username error:', err);
      res.status(500).json({ error: 'Failed to update Venmo username' });
    }
  }
);

// PUT /api/users/payment-methods — Update all payment method handles
router.put('/payment-methods',
  [
    // Same guard as PUT /venmo-username above, on all three handles. The Zelle
    // field fails differently and no more happily: nothing calls .replace() on
    // it, so a one-element array sailed through the whole handler and reached
    // pg as a text[] parameter for zelle_identifier VARCHAR(255).
    scalarOnly(body('venmo_username').optional({ nullable: true }), 'Venmo username')
      .trim().isLength({ max: 50 })
      .withMessage('Venmo username too long')
      .matches(/^[a-zA-Z0-9_-]*$/).withMessage('Venmo username can only contain letters, numbers, hyphens, and underscores'),
    scalarOnly(body('cashapp_cashtag').optional({ nullable: true }), 'Cash App cashtag')
      .trim().isLength({ max: 50 })
      .withMessage('Cash App cashtag too long')
      .matches(/^[a-zA-Z0-9_]*$/).withMessage('Cashtag can only contain letters, numbers, and underscores'),
    scalarOnly(body('zelle_identifier').optional({ nullable: true }), 'Zelle identifier')
      .trim().isLength({ max: 255 })
      .withMessage('Zelle identifier too long'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { venmo_username, cashapp_cashtag, zelle_identifier } = req.body;

      // Clean inputs — strip leading @ for venmo, $ for cashapp
      const cleanVenmo = venmo_username !== undefined
        ? (venmo_username ? venmo_username.replace(/^@/, '') : null)
        : undefined;
      const cleanCashapp = cashapp_cashtag !== undefined
        ? (cashapp_cashtag ? cashapp_cashtag.replace(/^\$/, '') : null)
        : undefined;
      const cleanZelle = zelle_identifier !== undefined
        ? (zelle_identifier || null)
        : undefined;

      // Build dynamic SET clause — only update fields that were sent
      const sets = [];
      const values = [];
      let paramIdx = 1;

      if (cleanVenmo !== undefined) {
        sets.push(`venmo_username = $${paramIdx++}`);
        values.push(cleanVenmo);
      }
      if (cleanCashapp !== undefined) {
        sets.push(`cashapp_cashtag = $${paramIdx++}`);
        values.push(cleanCashapp);
      }
      if (cleanZelle !== undefined) {
        sets.push(`zelle_identifier = $${paramIdx++}`);
        values.push(cleanZelle);
      }

      if (sets.length === 0) {
        return res.status(400).json({ error: 'No payment methods provided' });
      }

      sets.push('updated_at = NOW()');
      values.push(req.user.id);

      await pool.query(
        `UPDATE users SET ${sets.join(', ')} WHERE id = $${paramIdx}`,
        values
      );

      res.json({
        venmo_username: cleanVenmo !== undefined ? cleanVenmo : undefined,
        cashapp_cashtag: cleanCashapp !== undefined ? cleanCashapp : undefined,
        zelle_identifier: cleanZelle !== undefined ? cleanZelle : undefined,
      });
    } catch (err) {
      console.error('Update payment methods error:', err);
      res.status(500).json({ error: 'Failed to update payment methods' });
    }
  }
);

// GET /api/users/settings - Fetch user's synced app settings
router.get('/settings', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT settings FROM user_settings WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ settings: result.rows[0]?.settings || {} });
  } catch (err) {
    console.error('Get user settings error:', err);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// PATCH /api/users/settings - Merge partial settings into stored JSONB
router.patch('/settings', async (req, res) => {
  try {
    // Bounded (round 7): a plain object only (arrays CONCATENATE under
    // jsonb ||), payload capped, and the MERGED result capped — otherwise one
    // account can grow a single row without limit.
    const partial = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    if (JSON.stringify(partial).length > 8192) {
      return res.status(400).json({ error: 'Settings payload too large' });
    }
    const current = await pool.query('SELECT settings FROM user_settings WHERE user_id = $1', [req.user.id]);
    const merged = { ...(current.rows[0]?.settings || {}), ...partial };
    const serialized = JSON.stringify(merged);
    if (serialized.length > 16384) {
      return res.status(400).json({ error: 'Settings storage limit reached' });
    }
    const result = await pool.query(
      `INSERT INTO user_settings (user_id, settings, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET settings = EXCLUDED.settings,
           updated_at = NOW()
       RETURNING settings`,
      [req.user.id, serialized]
    );
    res.json({ settings: result.rows[0].settings });
  } catch (err) {
    console.error('Update user settings error:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// DELETE /api/users/me - Permanently delete the authenticated user's account.
// Hard-deletes the user row; ON DELETE CASCADE removes their flocks, memberships,
// messages, DMs, friendships, budgets, trusted contacts, device tokens, settings,
// etc. (a few FKs are ON DELETE SET NULL, which de-attribute content rather than
// delete it). Required for Apple Guideline 5.1.1(v) and Google Play's account-
// deletion policy. Irreversible.
//
// Registered at the TOP of this file against authenticateAllowBanned (function
// declaration, hoisted) so the banned-user exemption is a property of this one
// route rather than a string match every DELETE in the API could trip.
async function deleteAccount(req, res) {
  try {
    const u = await pool.query(
      // email_verified + verified_email are selected so recordBannedIdentity can
      // tell a PROVEN address from an unverified squat (HIGH 1 re-audit). They
      // trail the columns the test harness matches this SELECT on, so the
      // `apple_refresh_token, is_banned, banned_at` substring stays intact.
      `SELECT id, email, phone, password, oauth_provider, oauth_id, apple_refresh_token, is_banned, banned_at, email_verified, verified_email
         FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (u.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    const account = u.rows[0];

    // RE-AUTHENTICATION (round 16). Before this, a bearer token was the whole
    // requirement, so a token lifted off a shared laptop or an unlocked phone —
    // good for up to 24h, with no way for the owner to revoke it before
    // /logout-all existed — could irreversibly destroy the account, cascade
    // away every flock the user created, and permanently revoke their Apple
    // grant. That is the most destructive call in the API and it was the
    // cheapest one to make.
    //
    // This runs BEFORE the Apple revocation below on purpose: an unproven
    // request must not be able to disconnect someone's Apple sign-in as a side
    // effect of being rejected.
    //
    // Deletion stays reachable, which Apple 5.1.1(v) requires. Password
    // accounts retype the password they already use to sign in; OAuth accounts
    // re-run Sign in with Apple / Google and call this again with the fresh
    // token. `reauthRequired` tells the client which prompt to show.
    if (account.password) {
      // Bounded (see proofFailures): without a ceiling this endpoint is an
      // offline-grade password guessing oracle for anyone holding a token, and
      // every guess costs a bcrypt round of server CPU.
      if (proofFailures.lockedFor(account.id) > 0) {
        return res.status(429).json({ error: TOO_MANY_PROOFS_MESSAGE, reauthRequired: 'password' });
      }
      const supplied = typeof req.body?.password === 'string' ? req.body.password : '';
      const proven = supplied ? await bcrypt.compare(supplied, account.password) : false;
      if (!proven) {
        // An absent password is the shipped client's current behaviour, not a
        // guess, so it must not burn an attempt and lock a user out of the
        // deletion flow before their client has even prompted them.
        if (supplied) proofFailures.record(account.id);
        return res.status(401).json({
          error: 'Enter your password to delete your account.',
          reauthRequired: 'password',
        });
      }
      proofFailures.clear(account.id);
    } else if (!hasFreshSession(req)) {
      return res.status(401).json({
        error: 'For your security, sign in again and then delete your account.',
        reauthRequired: 'reauth',
      });
    }

    // Apple 5.1.1(v): revoke Sign in with Apple tokens before deleting the row.
    // Round 5: when revocation is CONFIGURED and fails, abort — deleting the
    // row destroys the only stored refresh token, so a swallowed failure would
    // make revocation permanently impossible. Unconfigured env stays a no-op.
    if (u.rows[0].oauth_provider === 'apple' && u.rows[0].apple_refresh_token && appleAuthConfigured()) {
      let revoked = false;
      try { revoked = await revokeAppleToken(u.rows[0].apple_refresh_token); } catch (_) { revoked = false; }
      if (!revoked) {
        return res.status(503).json({ error: "We couldn't disconnect your Apple sign-in just now. Try again in a minute." });
      }
    }

    // Moderation evidence survives the account (round 5): cascade deletes let
    // an abuser (or a reporter) erase open reports and completed action
    // history by deleting their account. De-attribute instead.
    //
    // Round 12: these were four separate autocommit statements, three of them
    // with `.catch(() => {})`. If a de-attribution UPDATE failed — lock
    // timeout, a drifted database where the column is still NOT NULL, anything
    // — the failure was swallowed and the hard DELETE ran anyway, so the
    // CASCADE erased exactly the evidence this code exists to preserve. The
    // live scenario is a banned abuser deleting their account. All four
    // statements plus the DELETE now share ONE transaction with no swallowed
    // errors: either the evidence is safely de-attributed and the account is
    // gone, or nothing happened and the caller gets a 503 to retry.
    const client = await pool.connect();
    let deleted;
    let tombstoned = false;
    // What the LOCKED read said, not the stale fetch at the top — the audit line
    // and the retention purge below both key off "was this account banned", and
    // after the re-read that answer is only correct inside the transaction.
    let wasBanned = account.is_banned;
    try {
      await client.query('BEGIN');

      await client.query('UPDATE content_reports SET reporter_id = NULL WHERE reporter_id = $1', [req.user.id]);
      await client.query('UPDATE content_reports SET reported_user_id = NULL WHERE reported_user_id = $1', [req.user.id]);
      await client.query('UPDATE moderation_actions SET target_user_id = NULL WHERE target_user_id = $1', [req.user.id]);

      // messages.sender_id is ON DELETE SET NULL (anonymize). Explicitly remove the
      // user's flock messages so no authored content is retained after deletion.
      await client.query('DELETE FROM messages WHERE sender_id = $1', [req.user.id]);

      // Round 16: a BAN has to outlive the account it was imposed on, or
      // deleting the account is a one-tap ban reset. Same transaction as the
      // evidence de-attribution above and for the same reason — the account
      // must never vanish while the record of why it was banned fails to land.
      // Nothing is written for accounts that were not banned.
      //
      // Round 19 (re-audit): decided on a row re-read INSIDE the transaction and
      // locked, not on the copy fetched at the top of this handler. Between the
      // two reads sit a bcrypt compare and, for an Apple account, a network call
      // to Apple's revocation endpoint — hundreds of milliseconds to seconds in
      // which a moderator's ban can commit. On the stale copy that ban is
      // invisible, so the account deletes clean and the tombstone is never
      // written: the ban is lost by losing a race, which is the same one-tap ban
      // reset this block exists to prevent, just harder to hit on purpose. FOR
      // UPDATE makes the ban and this decision serialize instead of interleave.
      // Deliberately the same statement text as the fetch above so it stays one
      // query to keep in step, and so the existing harnesses keep matching it.
      const locked = await client.query(
        `SELECT id, email, phone, password, oauth_provider, oauth_id, apple_refresh_token, is_banned, banned_at, email_verified, verified_email
           FROM users WHERE id = $1 FOR UPDATE`,
        [req.user.id]
      );
      // A missing row means it went away underneath us; the guarded DELETE below
      // is what turns that into a 404, so nothing is decided here.
      const banState = locked.rows[0] || account;
      wasBanned = Boolean(banState.is_banned);
      if (wasBanned) {
        tombstoned = await recordBannedIdentity(client, banState);
      }

      const result = await client.query('DELETE FROM users WHERE id = $1 RETURNING id', [req.user.id]);
      deleted = result.rows.length > 0;

      if (!deleted) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Account not found' });
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Delete account: de-attribution failed, account NOT deleted:', txErr.message);
      return res.status(503).json({
        error: "We couldn't finish deleting your account just now. Nothing was changed. Please try again in a minute.",
      });
    } finally {
      client.release();
    }

    // Round 19 (re-audit): the row is gone, so every REST call 401s on the next
    // request — but a Socket.io connection authenticates ONCE at the handshake
    // and then lives on the TCP connection. Without this, a deleted account's
    // live socket stays subscribed to `user:{id}` and keeps emitting on the
    // rooms it already joined until the SESSION_RECHECK_MS sweep in
    // sockets/handlers.js gets to it, which is up to a minute of a deleted
    // account still being present in the product. Every other path in the app
    // that ends a session calls this (the OAuth claims, the squat eviction, the
    // password reset, /logout-all, the password change above); the one that ends
    // the ACCOUNT did not. A missing io is a documented no-op, so this can never
    // turn a completed deletion into an error — and it deliberately runs AFTER
    // the COMMIT, so a rolled-back deletion never disconnects anyone.
    revokeUserSessions(req.app.get('io'), req.user.id);

    // Says what actually happened: recordBannedIdentity can decline to write
    // (no usable identifier), and an audit line that claims a tombstone exists
    // when none does is worse than no line at all.
    console.log(`Account deleted: user ${req.user.id}${wasBanned ? (tombstoned ? ' (banned, tombstoned)' : ' (banned, NOT tombstoned)') : ''} at ${new Date().toISOString()}`);

    // Housekeeping. Outside the transaction, rate limited to once an hour per
    // process, and fully swallowed: a failed purge is a tidiness problem and
    // must never turn into a failed account deletion.
    if (wasBanned) maybePurgeExpired();

    res.json({ message: 'Account deleted' });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
}

module.exports = router;

// ---------------------------------------------------------------------------
// Exports for other routers and for backend/__tests__/banEvasion.test.js.
//
// HANDOFF (routes/auth.js owner): every account-creation path needs the
// tombstone lookup. One line per path, after validation and after the existing
// duplicate-email check:
//
//   if (await rejectIfBannedIdentity(res, { email, phone })) return;                     // /signup
//   if (await rejectIfBannedIdentity(res, { email, oauthProvider: 'google', oauthId: googleId })) return;  // /google, new-user branch
//   if (await rejectIfBannedIdentity(res, { email, oauthProvider: 'apple', oauthId: appleId })) return;    // /apple, new-user branch
//
// with `const { rejectIfBannedIdentity } = require('./users');` at the top.
// There is no require cycle: routes/users.js does not require routes/auth.js.
// ---------------------------------------------------------------------------
module.exports.isIdentityBanned = isIdentityBanned;
module.exports.rejectIfBannedIdentity = rejectIfBannedIdentity;
module.exports.purgeExpiredBannedIdentities = purgeExpiredBannedIdentities;
module.exports.__testing = {
  detectImageFormat,
  DETECTED_MIME,
  identityDigests,
  canonicalPhone,
  normalizedAddress,
  hasFreshSession,
  recordBannedIdentity,
  maybePurgeExpired,
  resetPurgeClock: () => { lastPurgeAt = 0; },
  proofFailures,
  phoneChangeAttempts,
  emailChangeAttempts,
  REAUTH_WINDOW_MS,
  BAN_TOMBSTONE_RETENTION_DAYS,
  BANNED_IDENTITY_MESSAGE,
};
