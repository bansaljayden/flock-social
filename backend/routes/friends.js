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
