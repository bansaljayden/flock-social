const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Auto-create friendships table if it doesn't exist
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS friendships (
        id SERIAL PRIMARY KEY,
        requester_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        addressee_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(requester_id, addressee_id)
      )
    `);
  } catch (err) {
    console.error('Failed to ensure friendships table:', err.message);
  }
})();

// POST /api/friends/request - Send a friend request
router.post('/request',
  body('user_id').isInt().withMessage('user_id is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { user_id } = req.body;

      if (user_id === req.user.id) {
        return res.status(400).json({ error: 'Cannot send friend request to yourself' });
      }

      // Check if user exists
      const userCheck = await pool.query('SELECT id, name FROM users WHERE id = $1', [user_id]);
      if (userCheck.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Check if a friendship already exists in either direction
      const existing = await pool.query(
        `SELECT id, status, requester_id FROM friendships
         WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
        [req.user.id, user_id]
      );

      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.status === 'accepted') {
          return res.json({ message: 'Already friends', status: 'accepted' });
        }
        if (row.status === 'pending') {
          // If the OTHER person sent us a request, auto-accept
          if (row.requester_id === user_id) {
            await pool.query("UPDATE friendships SET status = 'accepted' WHERE id = $1", [row.id]);
            return res.json({ message: `You and ${userCheck.rows[0].name} are now friends!`, status: 'accepted' });
          }
          return res.json({ message: 'Friend request already sent', status: 'pending' });
        }
        // If declined, allow re-request
        await pool.query(
          "UPDATE friendships SET status = 'pending', requester_id = $1, addressee_id = $2 WHERE id = $3",
          [req.user.id, user_id, row.id]
        );
        return res.json({ message: `Friend request sent to ${userCheck.rows[0].name}`, status: 'pending' });
      }

      await pool.query(
        "INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'pending')",
        [req.user.id, user_id]
      );

      res.json({ message: `Friend request sent to ${userCheck.rows[0].name}`, status: 'pending' });
    } catch (err) {
      console.error('Friend request error:', err);
      res.status(500).json({ error: 'Failed to send friend request' });
    }
  }
);

// POST /api/friends/accept - Accept a friend request
router.post('/accept',
  body('user_id').isInt().withMessage('user_id is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { user_id } = req.body;

      const result = await pool.query(
        `UPDATE friendships SET status = 'accepted'
         WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'
         RETURNING *`,
        [user_id, req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'No pending request from this user' });
      }

      res.json({ message: 'Friend request accepted' });
    } catch (err) {
      console.error('Accept friend error:', err);
      res.status(500).json({ error: 'Failed to accept friend request' });
    }
  }
);

// GET /api/friends - List all accepted friends
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.profile_image_url, f.created_at AS friends_since
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
       WHERE (f.requester_id = $1 OR f.addressee_id = $1) AND f.status = 'accepted'
       ORDER BY u.name ASC`,
      [req.user.id]
    );
    res.json({ friends: result.rows });
  } catch (err) {
    console.error('Get friends error:', err);
    res.status(500).json({ error: 'Failed to get friends' });
  }
});

// GET /api/friends/pending - List pending friend requests received
router.get('/pending', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.profile_image_url, f.created_at
       FROM friendships f
       JOIN users u ON u.id = f.requester_id
       WHERE f.addressee_id = $1 AND f.status = 'pending'
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );
    res.json({ requests: result.rows });
  } catch (err) {
    console.error('Get pending requests error:', err);
    res.status(500).json({ error: 'Failed to get pending requests' });
  }
});

// POST /api/friends/decline - Decline a friend request
router.post('/decline',
  body('user_id').isInt().withMessage('user_id is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { user_id } = req.body;

      const result = await pool.query(
        `DELETE FROM friendships
         WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'
         RETURNING id`,
        [user_id, req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'No pending request from this user' });
      }

      res.json({ message: 'Friend request declined' });
    } catch (err) {
      console.error('Decline friend error:', err);
      res.status(500).json({ error: 'Failed to decline friend request' });
    }
  }
);

// DELETE /api/friends/:userId - Remove a friend or cancel outgoing request
router.delete('/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const result = await pool.query(
      `DELETE FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)
       RETURNING id`,
      [req.user.id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No friendship found' });
    }

    res.json({ message: 'Removed' });
  } catch (err) {
    console.error('Remove friend error:', err);
    res.status(500).json({ error: 'Failed to remove friend' });
  }
});

// GET /api/friends/outgoing - List pending friend requests sent by current user
router.get('/outgoing', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.profile_image_url, f.created_at
       FROM friendships f
       JOIN users u ON u.id = f.addressee_id
       WHERE f.requester_id = $1 AND f.status = 'pending'
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );
    res.json({ requests: result.rows });
  } catch (err) {
    console.error('Get outgoing requests error:', err);
    res.status(500).json({ error: 'Failed to get outgoing requests' });
  }
});

// GET /api/friends/suggestions - Mutual friend suggestions (friends of friends)
router.get('/suggestions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.profile_image_url, COUNT(*) AS mutual_count
       FROM friendships f1
       JOIN friendships f2 ON (
         (CASE WHEN f1.requester_id = $1 THEN f1.addressee_id ELSE f1.requester_id END) =
         (CASE WHEN f2.requester_id = $1 THEN f2.requester_id ELSE f2.addressee_id END)
       )
       JOIN users u ON u.id = CASE WHEN f2.requester_id = (CASE WHEN f1.requester_id = $1 THEN f1.addressee_id ELSE f1.requester_id END) THEN f2.addressee_id ELSE f2.requester_id END
       WHERE f1.status = 'accepted'
       AND f2.status = 'accepted'
       AND (f1.requester_id = $1 OR f1.addressee_id = $1)
       AND u.id != $1
       AND NOT EXISTS (
         SELECT 1 FROM friendships
         WHERE ((requester_id = $1 AND addressee_id = u.id) OR (requester_id = u.id AND addressee_id = $1))
       )
       GROUP BY u.id, u.name, u.profile_image_url
       ORDER BY mutual_count DESC
       LIMIT 20`,
      [req.user.id]
    );
    res.json({ suggestions: result.rows });
  } catch (err) {
    // Fallback: return suggested users from shared flocks if mutual friends query fails
    console.error('Suggestions error (trying fallback):', err.message);
    try {
      const fallback = await pool.query(
        `SELECT u.id, u.name, u.profile_image_url, COUNT(fm2.flock_id) AS mutual_count
         FROM flock_members fm1
         JOIN flock_members fm2 ON fm2.flock_id = fm1.flock_id AND fm2.user_id != fm1.user_id AND fm2.status = 'accepted'
         JOIN users u ON u.id = fm2.user_id
         WHERE fm1.user_id = $1 AND fm1.status = 'accepted'
         AND NOT EXISTS (
           SELECT 1 FROM friendships
           WHERE ((requester_id = $1 AND addressee_id = u.id) OR (requester_id = u.id AND addressee_id = $1))
         )
         GROUP BY u.id, u.name, u.profile_image_url
         ORDER BY mutual_count DESC
         LIMIT 20`,
        [req.user.id]
      );
      res.json({ suggestions: fallback.rows });
    } catch (err2) {
      console.error('Suggestions fallback error:', err2);
      res.status(500).json({ error: 'Failed to get suggestions' });
    }
  }
});

// GET /api/friends/my-code - Get current user's friend code
router.get('/my-code', async (req, res) => {
  try {
    // Generate a deterministic, short friend code from user ID
    const code = 'FLOCK-' + req.user.id.toString(36).toUpperCase().padStart(4, '0');
    res.json({ code, userId: req.user.id, name: req.user.name });
  } catch (err) {
    console.error('Friend code error:', err);
    res.status(500).json({ error: 'Failed to get friend code' });
  }
});

// POST /api/friends/add-by-code - Add friend by their friend code
router.post('/add-by-code',
  body('code').trim().isLength({ min: 1 }).withMessage('Friend code is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { code } = req.body;
      // Parse code: FLOCK-XXXX -> base36 user ID
      const match = code.toUpperCase().match(/^FLOCK-([A-Z0-9]+)$/);
      if (!match) {
        return res.status(400).json({ error: 'Invalid friend code format' });
      }

      const targetUserId = parseInt(match[1], 36);
      if (isNaN(targetUserId) || targetUserId === req.user.id) {
        return res.status(400).json({ error: targetUserId === req.user.id ? "That's your own code!" : 'Invalid friend code' });
      }

      // Check target user exists
      const userCheck = await pool.query('SELECT id, name FROM users WHERE id = $1', [targetUserId]);
      if (userCheck.rows.length === 0) {
        return res.status(404).json({ error: 'No user found with this code' });
      }

      // Reuse friend request logic
      const existing = await pool.query(
        `SELECT id, status, requester_id FROM friendships
         WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
        [req.user.id, targetUserId]
      );

      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.status === 'accepted') {
          return res.json({ message: `Already friends with ${userCheck.rows[0].name}`, status: 'accepted', user: userCheck.rows[0] });
        }
        if (row.status === 'pending' && row.requester_id === targetUserId) {
          await pool.query("UPDATE friendships SET status = 'accepted' WHERE id = $1", [row.id]);
          return res.json({ message: `You and ${userCheck.rows[0].name} are now friends!`, status: 'accepted', user: userCheck.rows[0] });
        }
        if (row.status === 'pending') {
          return res.json({ message: 'Friend request already sent', status: 'pending', user: userCheck.rows[0] });
        }
        await pool.query("UPDATE friendships SET status = 'pending', requester_id = $1, addressee_id = $2 WHERE id = $3", [req.user.id, targetUserId, row.id]);
        return res.json({ message: `Friend request sent to ${userCheck.rows[0].name}`, status: 'pending', user: userCheck.rows[0] });
      }

      await pool.query(
        "INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'pending')",
        [req.user.id, targetUserId]
      );
      res.json({ message: `Friend request sent to ${userCheck.rows[0].name}`, status: 'pending', user: userCheck.rows[0] });
    } catch (err) {
      console.error('Add by code error:', err);
      res.status(500).json({ error: 'Failed to add friend by code' });
    }
  }
);

// POST /api/friends/find-by-phone - Find users by phone numbers (for contacts sync)
router.post('/find-by-phone',
  body('phones').isArray({ min: 1 }).withMessage('Phone numbers array required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { phones } = req.body;
      // Normalize phones: strip non-digits
      const normalized = phones.map(p => p.replace(/\D/g, '').slice(-10)).filter(p => p.length >= 7);
      if (normalized.length === 0) return res.json({ users: [] });

      // Find users whose phone matches (last 10 digits comparison)
      const result = await pool.query(
        `SELECT id, name, profile_image_url, phone FROM users
         WHERE id != $1 AND phone IS NOT NULL
         AND REGEXP_REPLACE(phone, '\\D', '', 'g') SIMILAR TO '%(' || $2 || ')'`,
        [req.user.id, normalized.join('|')]
      );

      // Get friendship statuses
      const userIds = result.rows.map(u => u.id);
      let friendshipMap = {};
      if (userIds.length > 0) {
        const friendships = await pool.query(
          `SELECT
            CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS friend_id,
            status
           FROM friendships
           WHERE (requester_id = $1 OR addressee_id = $1)
           AND (requester_id = ANY($2::int[]) OR addressee_id = ANY($2::int[]))`,
          [req.user.id, userIds]
        );
        friendships.rows.forEach(f => { friendshipMap[f.friend_id] = f.status; });
      }

      const users = result.rows.map(u => ({
        id: u.id,
        name: u.name,
        profile_image_url: u.profile_image_url,
        friendship_status: friendshipMap[u.id] || null,
      }));

      res.json({ users });
    } catch (err) {
      console.error('Find by phone error:', err);
      res.status(500).json({ error: 'Failed to search contacts' });
    }
  }
);

// GET /api/friends/status/:userId - Check friendship status with a specific user
router.get('/status/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const result = await pool.query(
      `SELECT status, requester_id FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
      [req.user.id, userId]
    );
    if (result.rows.length === 0) {
      return res.json({ status: 'none' });
    }
    res.json({ status: result.rows[0].status, requester_id: result.rows[0].requester_id });
  } catch (err) {
    console.error('Friend status error:', err);
    res.status(500).json({ error: 'Failed to check friendship status' });
  }
});

module.exports = router;
