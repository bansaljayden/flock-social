const express = require('express');
const { query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');

const router = express.Router();

router.use(authenticate);

// GET /api/stories — Get active stories from friends and flock mates only
router.get('/',
  [
    query('limit').optional().isInt({ min: 1, max: 200 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const limit = parseInt(req.query.limit) || 100;
      const offset = parseInt(req.query.offset) || 0;

      // Only return stories from: the user themselves, accepted friends, or accepted flock mates
      const result = await pool.query(
        `SELECT s.id, s.user_id, s.image_url, s.caption, s.created_at, s.expires_at,
                u.name AS user_name, u.profile_image_url
         FROM stories s
         JOIN users u ON u.id = s.user_id
         WHERE s.expires_at > NOW()
           -- Admin takedowns (is_hidden) and blocks must hold here, not just
           -- in messaging: shared-flock membership survives a block, so the
           -- friendship/flock grants below would otherwise keep leaking
           -- stories across a block in both directions.
           AND s.is_hidden IS NOT TRUE
           AND NOT EXISTS (
             SELECT 1 FROM user_blocks b
             WHERE (b.blocker_id = $1 AND b.blocked_id = s.user_id)
                OR (b.blocker_id = s.user_id AND b.blocked_id = $1)
           )
           AND (
             s.user_id = $1
             OR s.user_id IN (
               SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END
               FROM friendships WHERE (requester_id = $1 OR addressee_id = $1) AND status = 'accepted'
             )
             OR s.user_id IN (
               SELECT fm2.user_id FROM flock_members fm1
               JOIN flock_members fm2 ON fm2.flock_id = fm1.flock_id AND fm2.user_id != $1 AND fm2.status = 'accepted'
               WHERE fm1.user_id = $1 AND fm1.status = 'accepted'
             )
           )
         ORDER BY s.created_at DESC
         LIMIT $2 OFFSET $3`,
        [req.user.id, limit, offset]
      );

      // Group stories by user
      const byUser = {};
      for (const row of result.rows) {
        if (!byUser[row.user_id]) {
          byUser[row.user_id] = {
            user_id: row.user_id,
            user_name: row.user_name,
            profile_image_url: row.profile_image_url,
            stories: [],
          };
        }
        byUser[row.user_id].stories.push({
          id: row.id,
          image_url: row.image_url,
          caption: row.caption,
          created_at: row.created_at,
          expires_at: row.expires_at,
        });
      }

      res.json({ story_groups: Object.values(byUser) });
    } catch (err) {
      console.error('Stories fetch error:', err);
      res.status(500).json({ error: 'Failed to fetch stories' });
    }
  }
);

module.exports = router;
