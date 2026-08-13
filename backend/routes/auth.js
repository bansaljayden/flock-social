const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { body, validationResult } = require('express-validator');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../config/database');
// signUserToken is the ONLY way tokens are minted (round 13): it stamps the
// user's token_version into the JWT so a bump revokes every outstanding token.
const { authenticate, signUserToken } = require('../middleware/auth');
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

// Age gate (C4) — SERVER-SIDE enforcement. The mobile neutral age screen collects
// a DOB and sends it at account creation; we compute age here so the under-13
// block survives local-storage clears / reinstalls and is recorded on the user row.
const { ageFromDob, MIN_AGE } = require('../utils/age');
const UNDERAGE_MSG = 'You must be at least 13 to use Flock.';

// Legacy accounts predate the DOB requirement (round 3): they must not stay
// permanently outside the age gate. On sign-in, a null-DOB account either
// supplies a DOB now (persisted, under-13 rejected) or gets needsDob back.
async function enforceDobOnLogin(user, req, res) {
  if (user.date_of_birth) return true;
  const supplied = req.body.date_of_birth;
  const age = ageFromDob(supplied);
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

    // Check if email already exists
    const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (existing.rows.length > 0) {
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

    const result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (result.rows.length === 0) {
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
      console.warn(`Failed login attempt for ${email} from ${req.ip} at ${new Date().toISOString()}`);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

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
router.post('/logout', authenticate, (req, res) => {
  // JWT is stateless - client should discard the token.
  // If you need server-side invalidation, implement a token blacklist with Redis.
  res.json({ message: 'Logged out successfully' });
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
      result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      if (result.rows.length > 0) {
        const existing = result.rows[0];
        if (existing.oauth_provider || !emailVerified) {
          return res.status(409).json({
            error: 'An account with this email already exists. Log in the way you originally signed up.',
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
      result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      if (result.rows.length > 0) {
        const existing = result.rows[0];
        if (existing.oauth_provider || !appleEmailVerified) {
          return res.status(409).json({
            error: 'An account with this email already exists. Log in the way you originally signed up.',
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
