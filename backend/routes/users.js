const express = require('express');
const bcrypt = require('bcryptjs');
const { body, query, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { stripHtml, sanitizeArray } = require('../utils/sanitize');

const router = express.Router();
const SALT_ROUNDS = 10;

router.use(authenticate);

// Magic bytes for image validation
const IMAGE_SIGNATURES = {
  jpeg: [Buffer.from([0xFF, 0xD8, 0xFF])],
  png:  [Buffer.from([0x89, 0x50, 0x4E, 0x47])],
  gif:  [Buffer.from([0x47, 0x49, 0x46, 0x38])],
  webp: [Buffer.from([0x52, 0x49, 0x46, 0x46])], // RIFF header
};

function isValidImage(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
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

// Configure multer for profile image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', 'uploads'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z.]/g, '');
    const safeExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext) ? ext : '.jpg';
    cb(null, `profile-${req.user.id}-${Date.now()}${safeExt}`);
  },
});

const upload = multer({
  storage,
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
      `SELECT id, email, name, phone, interests, role, profile_image_url, venmo_username, cashapp_cashtag, zelle_identifier, created_at, updated_at
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
    body('email').optional().isEmail().withMessage('Valid email required'),
    body('phone').optional(),
    body('interests').optional().isArray(),
    body('current_password').notEmpty().withMessage('Current password is required'),
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
      const safeInterests = interests ? sanitizeArray(interests) : null;

      // Fetch current user with password
      const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = userResult.rows[0];

      // Verify current password
      const validPassword = await bcrypt.compare(current_password, user.password);
      if (!validPassword) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      // Check email uniqueness if changing email
      if (email && email.toLowerCase() !== user.email.toLowerCase()) {
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

      const result = await pool.query(
        `UPDATE users
         SET name = COALESCE($1, name),
             email = COALESCE($2, email),
             phone = COALESCE($3, phone),
             interests = COALESCE($4, interests),
             password = COALESCE($5, password),
             updated_at = NOW()
         WHERE id = $6
         RETURNING id, email, name, phone, interests, role, profile_image_url, created_at, updated_at`,
        [name || null, email || null, phone || null, safeInterests, hashedPassword, req.user.id]
      );

      res.json({ user: result.rows[0] });
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

      const result = await pool.query(
        `SELECT id, name, profile_image_url
         FROM users
         WHERE name ILIKE $1 AND id != $2
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
    if (!isValidImage(req.file.path)) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'File is not a valid image' });
    }

    try {
      // Convert to base64 data URL and store in DB (survives Railway redeploys)
      const fileBuffer = fs.readFileSync(req.file.path);
      const mimeType = req.file.mimetype || 'image/jpeg';
      const dataUrl = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;

      // Clean up temp file
      fs.unlink(req.file.path, () => {});

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

module.exports = router;
