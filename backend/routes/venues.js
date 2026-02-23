const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

// Helper: check flock membership
async function verifyFlockMember(flockId, userId) {
  const result = await pool.query(
    "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
    [flockId, userId]
  );
  return result.rows.length > 0;
}

// POST /api/flocks/:id/vote - Vote for a venue
router.post('/:id/vote',
  [
    param('id').isInt(),
    body('venue_name').trim().isLength({ min: 1 }).withMessage('Venue name is required'),
    body('venue_id').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = req.params.id;

      if (!(await verifyFlockMember(flockId, req.user.id))) {
        return res.status(403).json({ error: 'Not a member of this flock' });
      }

      const { venue_name, venue_id } = req.body;

      const result = await pool.query(
        `INSERT INTO venue_votes (flock_id, user_id, venue_name, venue_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (flock_id, user_id, venue_name) DO NOTHING
         RETURNING *`,
        [flockId, req.user.id, venue_name, venue_id || null]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({ error: 'Already voted for this venue' });
      }

      // Return updated vote counts
      const votes = await pool.query(
        `SELECT venue_name, venue_id, COUNT(*) AS vote_count,
                ARRAY_AGG(u.name) AS voters
         FROM venue_votes vv
         JOIN users u ON u.id = vv.user_id
         WHERE vv.flock_id = $1
         GROUP BY venue_name, venue_id
         ORDER BY vote_count DESC`,
        [flockId]
      );

      res.status(201).json({ vote: result.rows[0], votes: votes.rows });
    } catch (err) {
      console.error('Vote error:', err);
      res.status(500).json({ error: 'Failed to vote' });
    }
  }
);

// GET /api/flocks/:id/votes - Get vote counts for a flock
router.get('/:id/votes', param('id').isInt(), async (req, res) => {
  try {
    const flockId = req.params.id;

    if (!(await verifyFlockMember(flockId, req.user.id))) {
      return res.status(403).json({ error: 'Not a member of this flock' });
    }

    const result = await pool.query(
      `SELECT venue_name, venue_id, COUNT(*) AS vote_count,
              ARRAY_AGG(json_build_object('id', u.id, 'name', u.name)) AS voters
       FROM venue_votes vv
       JOIN users u ON u.id = vv.user_id
       WHERE vv.flock_id = $1
       GROUP BY venue_name, venue_id
       ORDER BY vote_count DESC`,
      [flockId]
    );

    res.json({ votes: result.rows });
  } catch (err) {
    console.error('Get votes error:', err);
    res.status(500).json({ error: 'Failed to get votes' });
  }
});

module.exports = router;
