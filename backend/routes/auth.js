const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { body, validationResult } = require('express-validator');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../config/database');
// signUserToken is the ONLY way tokens are minted (round 13): it stamps the
// user's token_version into the JWT so a bump revokes every outstanding token.
const { authenticate, signUserToken, revokeUserSessions } = require('../middleware/auth');
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
const EMAIL_MATCH_SQL = `
      LOWER(email) = LOWER($1)
      OR (CASE
            WHEN split_part(LOWER(email), '@', 2) IN ('gmail.com', 'googlemail.com')
              THEN regexp_replace(split_part(split_part(LOWER(email), '@', 1), '+', 1), '\\.', '', 'g') || '@gmail.com'
            ELSE LOWER(email)
          END) = $2`;

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

async function enforceDobOnLogin(user, req, res) {
  if (user.date_of_birth) return true;
  const supplied = req.body.date_of_birth;
  const age = typeof supplied === 'string' && ISO_DATE_RE.test(supplied.trim())
    ? ageFromDob(supplied.trim())
    : null;
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

// Validation rules
const signupValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required')
    .custom((v) => !isDisposableEmail(v)).withMessage('Temporary email addresses cannot be used. Use an address you keep.'),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number'),
  body('name').trim().customSanitizer(stripHtml).isLength({ min: 1, max: 255 }).withMessage('Name is required'),
  body('phone').optional().isMobilePhone().withMessage('Invalid phone number'),
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
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { email, password, name, phone, interests, date_of_birth } = req.body;
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

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await pool.query(
      `INSERT INTO users (email, password, name, phone, interests, terms_accepted_at, date_of_birth)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6)
       RETURNING id, email, name, phone, interests, role, profile_image_url, created_at`,
      [email, hashedPassword, name, phone || null, safeInterests, date_of_birth || null]
    );

    const user = result.rows[0];
    const token = signUserToken(user);

    res.status(201).json({ token, user });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// POST /api/auth/login
router.post('/login', loginValidation, async (req, res) => {
  try {
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
    if (result.rows.length === 0) {
      recordLoginFailure(throttleKey);
      console.warn(`Failed login attempt (unknown email) for ${email} from ${req.ip} at ${new Date().toISOString()}`);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    // OAuth users have null password — they must use Google login
    if (!user.password) {
      return res.status(401).json({ error: 'This account uses Google Sign-In' });
    }
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      recordLoginFailure(throttleKey);
      console.warn(`Failed login attempt for ${email} from ${req.ip} at ${new Date().toISOString()}`);
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
      `SELECT id, email, name, phone, interests, role, profile_image_url, venmo_username, cashapp_cashtag, zelle_identifier, created_at, updated_at
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
        if (existing.is_banned) {
          console.warn(`[auth] refused Google claim of BANNED account ${existing.id} (${email})`);
          return res.status(403).json({
            error: 'An account with this email has been suspended. Contact support if you think that is a mistake.',
          });
        }
        // Round 13: the claim transferred the ROW but not the SESSION. The
        // squatter who pre-registered this address may be holding a JWT minted
        // minutes ago and good for another 24h, which would keep reading the
        // real owner's DMs, flocks and live location right through the
        // handover. Bumping token_version invalidates every token already
        // issued for this user id (middleware/auth.js compares the `tv` claim).
        const claimed = await pool.query(
          `UPDATE users SET oauth_provider = 'google', oauth_id = $1, password = NULL,
             profile_image_url = COALESCE(profile_image_url, $2),
             token_version = token_version + 1, updated_at = NOW()
           WHERE id = $3 RETURNING *`,
          [googleId, picture || null, existing.id]
        );
        user = claimed.rows[0];
        // Round 15: the bump kills REST sessions on the next request, but a
        // Socket.io connection authenticates ONCE at the handshake. Without
        // this the squatter's live socket stays in `user:{id}` and keeps
        // receiving the real owner's DMs, flock messages and location the
        // whole time. See revokeUserSessions in middleware/auth.js.
        revokeUserSessions(req.app.get('io'), existing.id);
        console.warn(`[auth] Google verified-email claim of password account ${existing.id} (${email})`);
      } else {
        // New user — create account (server-side age gate, C4).
        // DOB is REQUIRED for account creation on every path; a Google
        // sign-in without one means "sign up first" (needsDob tells the
        // client to route the user to the signup screen's DOB field).
        const dobAge = ageFromDob(req.body.date_of_birth);
        if (dobAge === null) {
          return res.status(403).json({ error: 'No Flock account yet. Sign up with your date of birth first.', needsDob: true });
        }
        if (dobAge < MIN_AGE) {
          return res.status(403).json({ error: UNDERAGE_MSG });
        }
        // Round 9: the provider name is UGC and was stored unscreened here.
        const googleName = safeOAuthDisplayName(name, email, 'Google');
        result = await pool.query(
          `INSERT INTO users (email, name, oauth_provider, oauth_id, profile_image_url, terms_accepted_at, date_of_birth)
           VALUES ($1, $2, 'google', $3, $4, NOW(), $5)
           RETURNING *`,
          [email, googleName, googleId, picture, req.body.date_of_birth || null]
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
router.post('/apple', [
  body('identityToken').notEmpty().withMessage('Apple identityToken is required'),
  body('fullName').optional().isObject(),
  body('authorizationCode').optional(),
], async (req, res) => {
  try {
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

    if (!appleId) {
      return res.status(400).json({ error: 'Apple token missing user id' });
    }

    // Find by oauth_id first (linkage by Apple sub never changes)
    let result = await pool.query(
      `SELECT * FROM users WHERE oauth_provider = 'apple' AND oauth_id = $1`,
      [appleId]
    );

    let user;
    if (result.rows.length > 0) {
      user = result.rows[0];
    } else if (email) {
      // SECURITY (audit 2026-08-12, revised round 8): same verified-email
      // claim rule as Google — Apple has verified this address, so a
      // password-only row for it belongs to this person; claiming it (and
      // clearing the password) unseats an address squatter instead of letting
      // the squat permanently block the real owner. Rows linked to another
      // provider are never absorbed.
      const appleEmailVerified = payload.email_verified === true || payload.email_verified === 'true';
      // Canonical lookup (round 15) — same reason as the Google branch.
      const existing = await findUserByEmail(email);
      if (existing) {
        if (existing.oauth_provider || !appleEmailVerified) {
          return res.status(409).json({
            error: 'An account with this email already exists. Log in the way you originally signed up.',
          });
        }
        // Round 15: same refusal as the Google branch — never hand a banned
        // row to the address's verified owner, and never lift the ban here.
        if (existing.is_banned) {
          console.warn(`[auth] refused Apple claim of BANNED account ${existing.id} (${email})`);
          return res.status(403).json({
            error: 'An account with this email has been suspended. Contact support if you think that is a mistake.',
          });
        }
        // Round 13: same session handover as the Google claim — bump
        // token_version so any JWT the squatter still holds dies immediately.
        const claimed = await pool.query(
          `UPDATE users SET oauth_provider = 'apple', oauth_id = $1, password = NULL,
             token_version = token_version + 1, updated_at = NOW()
           WHERE id = $2 RETURNING *`,
          [appleId, existing.id]
        );
        user = claimed.rows[0];
        // Round 15: kill the squatter's live Socket.io connection too — the
        // token_version bump alone never reaches an already-open socket.
        revokeUserSessions(req.app.get('io'), existing.id);
        console.warn(`[auth] Apple verified-email claim of password account ${existing.id} (${email})`);
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
      const appleDobAge = ageFromDob(req.body.date_of_birth);
      if (appleDobAge === null) {
        return res.status(403).json({ error: 'No Flock account yet. Sign up with your date of birth first.', needsDob: true });
      }
      if (appleDobAge < MIN_AGE) {
        return res.status(403).json({ error: UNDERAGE_MSG });
      }
      // users.email is NOT NULL UNIQUE — a NULL here 500'd account creation
      // (round 8). When Apple omits the email, store a deterministic
      // non-routable placeholder (.invalid TLD can never receive mail);
      // linkage stays on oauth_id, and outbound mail paths skip .invalid.
      const storedEmail = email
        || `apple_${String(appleId).replace(/[^a-zA-Z0-9]/g, '')}@apple-signin.invalid`;
      result = await pool.query(
        `INSERT INTO users (email, name, oauth_provider, oauth_id, terms_accepted_at, date_of_birth)
         VALUES ($1, $2, 'apple', $3, NOW(), $4)
         RETURNING *`,
        [storedEmail, fallbackName, appleId, req.body.date_of_birth || null]
      );
      user = result.rows[0];
    }

    // Capture an Apple refresh token so deletion can revoke it (Apple 5.1.1(v)).
    // No-op unless APPLE_* signing env is configured.
    // Round 7: skipping the code entirely was a bypass of the fail-closed
    // exchange. When revocation is configured and we hold no refresh token
    // for this user yet, the code is REQUIRED.
    {
      const { isConfigured: appleCfg } = require('../services/appleAuth');
      if (!authorizationCode && appleCfg() && !user.apple_refresh_token) {
        return res.status(400).json({ error: "Apple sign-in didn't complete. Try again in a moment." });
      }
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
};
