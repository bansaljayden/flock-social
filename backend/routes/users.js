const express = require('express');
const bcrypt = require('bcryptjs');
const { body, query, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');
const pool = require('../config/database');
const { authenticate, authenticateAllowBanned, signUserToken } = require('../middleware/auth');
const { stripHtml, sanitizeArray } = require('../utils/sanitize');
const { rejectIfProfane, moderateImage, IMAGE_REJECTED_MESSAGE } = require('../utils/moderation');
const { revokeAppleToken, isConfigured: appleAuthConfigured } = require('../services/appleAuth');

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

// Magic bytes for image validation
const IMAGE_SIGNATURES = {
  jpeg: [Buffer.from([0xFF, 0xD8, 0xFF])],
  png:  [Buffer.from([0x89, 0x50, 0x4E, 0x47])],
  gif:  [Buffer.from([0x47, 0x49, 0x46, 0x38])],
  webp: [Buffer.from([0x52, 0x49, 0x46, 0x46])], // RIFF header
};

function isValidImage(buf) {
  try {
    for (const sigs of Object.values(IMAGE_SIGNATURES)) {
      for (const sig of sigs) {
        if (buf.subarray(0, sig.length).equals(sig)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

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

// PUT /api/users/profile - Update current user's profile (requires current password)
router.put('/profile',
  [
    body('name').optional().trim().customSanitizer(stripHtml).isLength({ min: 1, max: 255 }).withMessage('Name must be 1-255 characters'),
    // normalizeEmail() matches signup and login (routes/auth.js), so
    // `v.ictim@gmail.com` cannot be stored as a distinct row that shadows
    // `victim@gmail.com` in the LOWER(email) lookups those paths use.
    body('email').optional().isEmail().normalizeEmail().withMessage('Valid email required'),
    body('phone').optional(),
    body('interests').optional().isArray(),
    // Optional at the validator layer: OAuth accounts have no password, and a
    // notEmpty() here 400'd their profile edits before the OAuth-aware handler
    // below could run. Password accounts still fail closed — the bcrypt
    // compare against a missing value returns 401.
    body('current_password').optional().isString(),
    body('new_password').optional()
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
        const validPassword = await bcrypt.compare(current_password || '', user.password);
        if (!validPassword) {
          return res.status(401).json({ error: 'Current password is incorrect' });
        }
      } else if (new_password) {
        return res.status(400).json({ error: 'This account signs in with Google or Apple and has no password.' });
      }

      // Check email uniqueness if changing email
      const changingEmail = Boolean(email) && email.toLowerCase() !== user.email.toLowerCase();
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
        const emailCheck = await pool.query(
          'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id != $2',
          [email, req.user.id]
        );
        if (emailCheck.rows.length > 0) {
          return res.status(400).json({ error: 'Email is already in use' });
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
      const result = await pool.query(
        `UPDATE users
         SET name = COALESCE($1, name),
             email = COALESCE($2, email),
             phone = COALESCE($3, phone),
             interests = COALESCE($4, interests),
             password = COALESCE($5, password),
             token_version = token_version + CASE WHEN $5::text IS NULL THEN 0 ELSE 1 END,
             updated_at = NOW()
         WHERE id = $6
         RETURNING id, email, name, phone, interests, role, profile_image_url, token_version, created_at, updated_at`,
        [name || null, email || null, phone || null, safeInterests, hashedPassword, req.user.id]
      );

      const { token_version: _tv, ...safeUser } = result.rows[0];
      res.json({
        user: safeUser,
        ...(hashedPassword ? { token: signUserToken(result.rows[0]) } : {}),
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
  query('q').trim().isLength({ min: 1 }).withMessage('Search query is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const searchTerm = `%${req.query.q}%`;

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
    if (!isValidImage(req.file.buffer)) {
      return res.status(400).json({ error: 'File is not a valid image' });
    }

    try {
      // Convert to base64 data URL and store in DB (survives Railway redeploys)
      const mimeType = req.file.mimetype || 'image/jpeg';
      const dataUrl = `data:${mimeType};base64,${req.file.buffer.toString('base64')}`;

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
      const verdict = await moderateImage(dataUrl);
      if (!verdict.allowed) {
        return res.status(400).json({ error: IMAGE_REJECTED_MESSAGE, moderation: verdict.reason });
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
    body('url').trim().isURL({ protocols: ['https'], require_protocol: true }).withMessage('Valid HTTPS URL required'),
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
    body('venmo_username').optional({ nullable: true }).trim().isLength({ max: 50 }).withMessage('Venmo username too long')
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
    body('venmo_username').optional({ nullable: true }).trim().isLength({ max: 50 })
      .withMessage('Venmo username too long')
      .matches(/^[a-zA-Z0-9_-]*$/).withMessage('Venmo username can only contain letters, numbers, hyphens, and underscores'),
    body('cashapp_cashtag').optional({ nullable: true }).trim().isLength({ max: 50 })
      .withMessage('Cash App cashtag too long')
      .matches(/^[a-zA-Z0-9_]*$/).withMessage('Cashtag can only contain letters, numbers, and underscores'),
    body('zelle_identifier').optional({ nullable: true }).trim().isLength({ max: 255 })
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
    // Apple 5.1.1(v): revoke Sign in with Apple tokens before deleting the row.
    // Round 5: when revocation is CONFIGURED and fails, abort — deleting the
    // row destroys the only stored refresh token, so a swallowed failure would
    // make revocation permanently impossible. Unconfigured env stays a no-op.
    const u = await pool.query('SELECT oauth_provider, apple_refresh_token FROM users WHERE id = $1', [req.user.id]);
    if (u.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
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
    try {
      await client.query('BEGIN');

      await client.query('UPDATE content_reports SET reporter_id = NULL WHERE reporter_id = $1', [req.user.id]);
      await client.query('UPDATE content_reports SET reported_user_id = NULL WHERE reported_user_id = $1', [req.user.id]);
      await client.query('UPDATE moderation_actions SET target_user_id = NULL WHERE target_user_id = $1', [req.user.id]);

      // messages.sender_id is ON DELETE SET NULL (anonymize). Explicitly remove the
      // user's flock messages so no authored content is retained after deletion.
      await client.query('DELETE FROM messages WHERE sender_id = $1', [req.user.id]);

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

    console.log(`Account deleted: user ${req.user.id} at ${new Date().toISOString()}`);
    res.json({ message: 'Account deleted' });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
}

module.exports = router;
