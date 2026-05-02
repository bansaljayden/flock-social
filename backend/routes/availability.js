const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Auto-create table on boot
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS availability_pulses (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(10) NOT NULL CHECK (status IN ('down', 'maybe', 'not')),
        note TEXT,
        set_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_availability_expires ON availability_pulses(expires_at)`);
  } catch (err) {
    console.error('Failed to ensure availability_pulses table:', err.message);
  }
})();

// Default expiry: end of "tonight" — 4am next-day in user's local TZ.
// Frontend sends `expires_at` so the server doesn't need to know the user's TZ.
// Cap at 36h from now to prevent abuse.
function clampExpiry(clientExpiry) {
  const now = Date.now();
  const cap = now + 36 * 60 * 60 * 1000;
  if (!clientExpiry) return new Date(now + 12 * 60 * 60 * 1000); // default 12h
  const t = new Date(clientExpiry).getTime();
  if (isNaN(t)) return new Date(now + 12 * 60 * 60 * 1000);
  if (t <= now) return new Date(now + 60 * 60 * 1000); // min 1h forward
  if (t > cap) return new Date(cap);
  return new Date(t);
}

// POST /api/availability — set my pulse
router.post('/',
  body('status').isIn(['down', 'maybe', 'not']).withMessage('status must be down, maybe, or not'),
  body('note').optional().isString().isLength({ max: 80 }),
  body('expires_at').optional().isISO8601(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { status, note, expires_at } = req.body;
      const expiry = clampExpiry(expires_at);

      const result = await pool.query(
        `INSERT INTO availability_pulses (user_id, status, note, set_at, expires_at)
         VALUES ($1, $2, $3, NOW(), $4)
         ON CONFLICT (user_id) DO UPDATE
           SET status = EXCLUDED.status,
               note = EXCLUDED.note,
               set_at = NOW(),
               expires_at = EXCLUDED.expires_at
         RETURNING status, note, set_at, expires_at`,
        [req.user.id, status, note || null, expiry]
      );

      const pulse = result.rows[0];

      // Broadcast to all friends so their UI updates live
      const io = req.app.get('io');
      if (io) {
        const friends = await pool.query(
          `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS friend_id
           FROM friendships
           WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)`,
          [req.user.id]
        );
        const payload = {
          userId: req.user.id,
          name: req.user.name,
          status: pulse.status,
          note: pulse.note,
          setAt: pulse.set_at,
          expiresAt: pulse.expires_at,
        };
        for (const r of friends.rows) {
          io.to(`user:${r.friend_id}`).emit('availability_updated', payload);
        }
      }

      res.json({ pulse });
    } catch (err) {
      console.error('Set availability error:', err);
      res.status(500).json({ error: 'Failed to set availability' });
    }
  }
);

// DELETE /api/availability — clear my pulse
router.delete('/', async (req, res) => {
  try {
    await pool.query('DELETE FROM availability_pulses WHERE user_id = $1', [req.user.id]);

    const io = req.app.get('io');
    if (io) {
      const friends = await pool.query(
        `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS friend_id
         FROM friendships
         WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)`,
        [req.user.id]
      );
      for (const r of friends.rows) {
        io.to(`user:${r.friend_id}`).emit('availability_updated', { userId: req.user.id, status: null });
      }
    }

    res.json({ message: 'Cleared' });
  } catch (err) {
    console.error('Clear availability error:', err);
    res.status(500).json({ error: 'Failed to clear availability' });
  }
});

// GET /api/availability/me — my current pulse (or null if none/expired)
router.get('/me', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT status, note, set_at, expires_at
       FROM availability_pulses
       WHERE user_id = $1 AND expires_at > NOW()`,
      [req.user.id]
    );
    res.json({ pulse: result.rows[0] || null });
  } catch (err) {
    console.error('Get my availability error:', err);
    res.status(500).json({ error: 'Failed to get availability' });
  }
});

// GET /api/availability/friends — active pulses for my friends
router.get('/friends', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.profile_image_url,
              ap.status, ap.note, ap.set_at, ap.expires_at
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
       JOIN availability_pulses ap ON ap.user_id = u.id
       WHERE f.status = 'accepted'
         AND (f.requester_id = $1 OR f.addressee_id = $1)
         AND ap.expires_at > NOW()
       ORDER BY
         CASE ap.status WHEN 'down' THEN 1 WHEN 'maybe' THEN 2 ELSE 3 END,
         ap.set_at DESC`,
      [req.user.id]
    );
    res.json({ friends: result.rows });
  } catch (err) {
    console.error('Get friends availability error:', err);
    res.status(500).json({ error: 'Failed to get friend availability' });
  }
});

module.exports = router;
