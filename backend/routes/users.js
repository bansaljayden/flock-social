const express = require('express');
const bcrypt = require('bcryptjs');
const { body, query, validationResult } = require('express-validator');
const multer = require('multer');
const path = require('path');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const SALT_ROUNDS = 10;

router.use(authenticate);

// Configure multer for profile image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, '..', 'uploads'));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `profile-${req.user.id}-${Date.now()}${ext}`);
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
      cb(new Error('Only image files are allowed'));
    }
  },
});

// GET /api/users/profile - Get current user's full profile
router.get('/profile', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, name, phone, interests, role, profile_image_url, created_at, updated_at
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
    body('name').optional().trim().isLength({ min: 1, max: 255 }).withMessage('Name must be 1-255 characters'),
    body('email').optional().isEmail().withMessage('Valid email required'),
    body('phone').optional(),
    body('interests').optional().isArray(),
    body('current_password').notEmpty().withMessage('Current password is required'),
    body('new_password').optional().isLength({ min: 8 }).withMessage('New password must be at least 8 characters'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { name, email, phone, interests, current_password, new_password } = req.body;

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
        [name || null, email || null, phone || null, interests || null, hashedPassword, req.user.id]
      );

      res.json({ user: result.rows[0] });
    } catch (err) {
      console.error('Update profile error:', err);
      res.status(500).json({ error: 'Failed to update profile' });
    }
  }
);

// GET /api/users/search?q= - Search users by name or email
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
        `SELECT id, name, email, profile_image_url
         FROM users
         WHERE (name ILIKE $1 OR email ILIKE $1) AND id != $2
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
      `SELECT u.id, u.name, u.email, u.profile_image_url, COUNT(fm2.flock_id) AS shared_flocks
       FROM flock_members fm1
       JOIN flock_members fm2 ON fm2.flock_id = fm1.flock_id AND fm2.user_id != fm1.user_id AND fm2.status = 'accepted'
       JOIN users u ON u.id = fm2.user_id
       WHERE fm1.user_id = $1 AND fm1.status = 'accepted'
       GROUP BY u.id, u.name, u.email, u.profile_image_url
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
      return res.status(400).json({ error: err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    try {
      const imageUrl = `/uploads/${req.file.filename}`;

      await pool.query(
        'UPDATE users SET profile_image_url = $1, updated_at = NOW() WHERE id = $2',
        [imageUrl, req.user.id]
      );

      res.json({ profile_image_url: imageUrl });
    } catch (dbErr) {
      console.error('Upload image error:', dbErr);
      res.status(500).json({ error: 'Failed to save image' });
    }
  });
});

module.exports = router;
