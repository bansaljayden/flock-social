// ---------------------------------------------------------------------------
// UGC moderation routes (Apple 1.2 / Google UGC policy):
//   POST   /api/reports            — report content or a user
//   GET    /api/blocks             — list users I've blocked
//   POST   /api/blocks/:userId     — block a user (mutual invisibility)
//   DELETE /api/blocks/:userId     — unblock
// ---------------------------------------------------------------------------
const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { stripHtml } = require('../utils/sanitize');

const router = express.Router();
router.use(authenticate);

const VALID_CONTENT_TYPES = ['flock_message', 'dm', 'profile', 'story'];
const VALID_REASONS = ['spam', 'harassment', 'hate', 'sexual', 'violence', 'self_harm', 'other'];

// POST /api/reports — file a report against content or a user.
router.post('/reports',
  [
    body('content_type').isIn(VALID_CONTENT_TYPES).withMessage('Invalid content type'),
    body('reason').isIn(VALID_REASONS).withMessage('Invalid reason'),
    body('content_id').optional().isInt(),
    body('reported_user_id').optional().isInt(),
    body('details').optional().trim().customSanitizer(stripHtml).isLength({ max: 1000 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const { content_type, content_id, reported_user_id, reason, details } = req.body;

      // Round 3: a report must reference REAL content the reporter can see,
      // authored by the person being reported — otherwise users can frame
      // accounts or probe private message ids via the report pipeline.
      if (content_id) {
        let row = null;
        // 'flock_message' is the validated type name — checking 'message' here
        // made every legitimate group-chat report 400 as "not found"
        if (content_type === 'flock_message') {
          const r = await pool.query(
            `SELECT m.sender_id FROM messages m
             JOIN flock_members fm ON fm.flock_id = m.flock_id AND fm.user_id = $2 AND fm.status = 'accepted'
             WHERE m.id = $1`,
            [content_id, req.user.id]
          );
          row = r.rows[0] || null;
        } else if (content_type === 'dm') {
          const r = await pool.query(
            `SELECT sender_id FROM direct_messages
             WHERE id = $1 AND (sender_id = $2 OR receiver_id = $2)`,
            [content_id, req.user.id]
          );
          row = r.rows[0] || null;
        } else if (content_type === 'story') {
          // Same visibility predicates as the story feed — a bare id lookup
          // let any user probe/report stories they could never see.
          const r = await pool.query(
            `SELECT s.user_id AS sender_id FROM stories s
             WHERE s.id = $1
               AND s.expires_at > NOW()
               AND s.is_hidden IS NOT TRUE
               AND NOT EXISTS (
                 SELECT 1 FROM user_blocks b
                 WHERE (b.blocker_id = $2 AND b.blocked_id = s.user_id)
                    OR (b.blocker_id = s.user_id AND b.blocked_id = $2)
               )
               AND (
                 s.user_id IN (
                   SELECT CASE WHEN requester_id = $2 THEN addressee_id ELSE requester_id END
                   FROM friendships WHERE (requester_id = $2 OR addressee_id = $2) AND status = 'accepted'
                 )
                 OR s.user_id IN (
                   SELECT fm2.user_id FROM flock_members fm1
                   JOIN flock_members fm2 ON fm2.flock_id = fm1.flock_id AND fm2.user_id != $2 AND fm2.status = 'accepted'
                   WHERE fm1.user_id = $2 AND fm1.status = 'accepted'
                 )
               )`,
            [content_id, req.user.id]
          );
          row = r.rows[0] || null;
        }
        if (!row) {
          return res.status(400).json({ error: 'That content could not be found' });
        }
        if (reported_user_id && row.sender_id !== reported_user_id) {
          return res.status(400).json({ error: 'Reported user does not match the content author' });
        }
      }

      const result = await pool.query(
        `INSERT INTO content_reports (reporter_id, reported_user_id, content_type, content_id, reason, details)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, status, created_at`,
        [req.user.id, reported_user_id || null, content_type, content_id || null, reason, details || null]
      );

      // Alert moderators (A6 — push/email). Fire-and-forget; never block the reporter.
      try {
        const { alertModerators } = require('../services/moderationAlerts');
        alertModerators(req.app.get('io'), {
          reportId: result.rows[0].id, content_type, reason, reporter: req.user.name,
        }).catch(() => {});
      } catch (_) { /* alerts service optional until A6 lands */ }

      res.status(201).json({
        message: 'Report received. Our team will review it promptly.',
        report: result.rows[0],
      });
    } catch (err) {
      console.error('Create report error:', err);
      res.status(500).json({ error: 'Failed to submit report' });
    }
  }
);

// GET /api/blocks — users the current user has blocked.
router.get('/blocks', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.blocked_id AS user_id, u.name, u.profile_image_url, b.created_at
       FROM user_blocks b JOIN users u ON u.id = b.blocked_id
       WHERE b.blocker_id = $1
       ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json({ blocked: result.rows });
  } catch (err) {
    console.error('List blocks error:', err);
    res.status(500).json({ error: 'Failed to list blocked users' });
  }
});

// POST /api/blocks/:userId — block a user. Mutual invisibility is enforced by
// isBlockedBetween() across DMs, friend requests, invites, and visibility.
router.post('/blocks/:userId', [param('userId').isInt()], async (req, res) => {
  try {
    const blockedId = parseInt(req.params.userId);
    if (blockedId === req.user.id) return res.status(400).json({ error: 'You cannot block yourself' });

    const exists = await pool.query('SELECT id FROM users WHERE id = $1', [blockedId]);
    if (exists.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    await pool.query(
      `INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)
       ON CONFLICT (blocker_id, blocked_id) DO NOTHING`,
      [req.user.id, blockedId]
    );

    // Separate them: drop any friendship in either direction.
    await pool.query(
      `DELETE FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
      [req.user.id, blockedId]
    ).catch(() => {});

    res.status(201).json({ message: 'User blocked' });
  } catch (err) {
    console.error('Block user error:', err);
    res.status(500).json({ error: 'Failed to block user' });
  }
});

// DELETE /api/blocks/:userId — unblock.
router.delete('/blocks/:userId', [param('userId').isInt()], async (req, res) => {
  try {
    const blockedId = parseInt(req.params.userId);
    const result = await pool.query(
      'DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2 RETURNING id',
      [req.user.id, blockedId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not blocked' });
    res.json({ message: 'User unblocked' });
  } catch (err) {
    console.error('Unblock user error:', err);
    res.status(500).json({ error: 'Failed to unblock user' });
  }
});

module.exports = router;
