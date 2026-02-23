const express = require('express');
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');

const router = express.Router();

router.use(authenticate);

// GET /api/stories — Get all active (non-expired) stories
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.user_id, s.image_url, s.caption, s.created_at, s.expires_at,
              u.name AS user_name, u.profile_image_url
       FROM stories s
       JOIN users u ON u.id = s.user_id
       WHERE s.expires_at > NOW()
       ORDER BY s.created_at DESC`
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
});

module.exports = router;
