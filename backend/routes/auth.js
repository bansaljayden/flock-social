const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { body, validationResult } = require('express-validator');
const { OAuth2Client } = require('google-auth-library');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { stripHtml, sanitizeArray } = require('../utils/sanitize');

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
const TOKEN_EXPIRY = '24h';

// Age gate (C4) — SERVER-SIDE enforcement. The mobile neutral age screen collects
// a DOB and sends it at account creation; we compute age here so the under-13
// block survives local-storage clears / reinstalls and is recorded on the user row.
const { ageFromDob, MIN_AGE } = require('../utils/age');
const UNDERAGE_MSG = 'You must be at least 13 to use Flock.';

// Validation rules
const signupValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password')
    .isLength({ min: 8 }).withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain at least one number'),
  body('name').trim().customSanitizer(stripHtml).isLength({ min: 1, max: 255 }).withMessage('Name is required'),
  body('phone').optional().isMobilePhone().withMessage('Invalid phone number'),
  body('date_of_birth').optional().isISO8601().withMessage('Invalid date of birth'),
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

    // Server-side age gate (C4): reject under-13 regardless of the client gate.
    const age = ageFromDob(date_of_birth);
    if (age !== null && age < MIN_AGE) {
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
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: TOKEN_EXPIRY });

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

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: TOKEN_EXPIRY });

    // Strip password from response
    const { password: _, ...safeUser } = user;
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

// POST /api/auth/google — Google OAuth sign-in
router.post('/google', [
  body('credential').notEmpty().withMessage('Google credential is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    // Verify the Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: req.body.credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;

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
      // Check if email already exists (password user wanting to link Google)
      result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      if (result.rows.length > 0) {
        // Link Google to existing account
        user = result.rows[0];
        await pool.query(
          'UPDATE users SET oauth_provider = $1, oauth_id = $2, profile_image_url = COALESCE(profile_image_url, $3) WHERE id = $4',
          ['google', googleId, picture, user.id]
        );
      } else {
        // New user — create account (server-side age gate, C4)
        const dobAge = ageFromDob(req.body.date_of_birth);
        if (dobAge !== null && dobAge < MIN_AGE) {
          return res.status(403).json({ error: UNDERAGE_MSG });
        }
        result = await pool.query(
          `INSERT INTO users (email, name, oauth_provider, oauth_id, profile_image_url, terms_accepted_at, date_of_birth)
           VALUES ($1, $2, 'google', $3, $4, NOW(), $5)
           RETURNING *`,
          [email, name, googleId, picture, req.body.date_of_birth || null]
        );
        user = result.rows[0];
      }
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
    const { password: _, ...safeUser } = user;
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
          // audience: must be the iOS bundle identifier (and Android service ID
          // when we add it). Set APPLE_BUNDLE_ID in Railway after Xcode setup.
          audience: process.env.APPLE_BUNDLE_ID || undefined,
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
      // First sign-in for this Apple ID — try to link by email if a
      // password account already exists with this address.
      result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      if (result.rows.length > 0) {
        user = result.rows[0];
        await pool.query(
          'UPDATE users SET oauth_provider = $1, oauth_id = $2 WHERE id = $3',
          ['apple', appleId, user.id]
        );
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
      const fallbackName = composedName
        || (email ? email.split('@')[0] : 'Friend');

      const appleDobAge = ageFromDob(req.body.date_of_birth);
      if (appleDobAge !== null && appleDobAge < MIN_AGE) {
        return res.status(403).json({ error: UNDERAGE_MSG });
      }
      result = await pool.query(
        `INSERT INTO users (email, name, oauth_provider, oauth_id, terms_accepted_at, date_of_birth)
         VALUES ($1, $2, 'apple', $3, NOW(), $4)
         RETURNING *`,
        [email, fallbackName, appleId, req.body.date_of_birth || null]
      );
      user = result.rows[0];
    }

    // Capture an Apple refresh token so deletion can revoke it (Apple 5.1.1(v)).
    // No-op unless APPLE_* signing env is configured.
    if (authorizationCode) {
      try {
        const { exchangeAppleCode } = require('../services/appleAuth');
        const tokens = await exchangeAppleCode(authorizationCode);
        if (tokens?.refresh_token) {
          await pool.query('UPDATE users SET apple_refresh_token = $1 WHERE id = $2', [tokens.refresh_token, user.id]);
        }
      } catch (e) { console.error('Apple code exchange error:', e.message); }
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
    const { password: _, ...safeUser } = user;
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
