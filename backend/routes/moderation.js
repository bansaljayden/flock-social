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
const { invalidateBlockCache } = require('../utils/blocks');

const router = express.Router();
router.use(authenticate);

// venue_review added round 6: public UGC with no report path is an
// App Review 1.2 blocker.
//
// guest_rsvp added round 13. Migration 005 gave guest_rsvps an is_hidden column
// and every read honours it, but NOTHING could ever set it: the type was
// missing here and from the admin table map, so an abusive unauthenticated
// guest name — broadcast live to every member of the flock — had no takedown
// path at all. Reporting it is gated below on the reporter being an accepted
// member of that RSVP's flock.
const VALID_CONTENT_TYPES = ['flock_message', 'dm', 'profile', 'story', 'venue_review', 'venue_promotion', 'guest_rsvp'];
const VALID_REASONS = ['spam', 'harassment', 'hate', 'sexual', 'violence', 'self_harm', 'other'];

// Round 9: every report inserted a row and paged a moderator with no ceiling,
// so one account could bury real reports below the dashboard's LIMIT 200 view
// and spam the alert channel. 10 reports/hour per user, in-memory (matches
// waitlist.js) — fine on the single-instance deployment.
const reportHourly = new Map(); // userId -> { count, resetAt }
const REPORTS_PER_HOUR = 10;

function allowReport(userId) {
  const now = Date.now();
  if (reportHourly.size > 5000) {
    for (const [k, v] of reportHourly) { if (now > v.resetAt) reportHourly.delete(k); }
  }
  let entry = reportHourly.get(userId);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60 * 60 * 1000 };
    reportHourly.set(userId, entry);
  }
  if (entry.count >= REPORTS_PER_HOUR) return false;
  entry.count += 1;
  return true;
}

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
      // Round 15: the quota was spent BEFORE validation, so every malformed
      // request burned one of the ten reports a user gets per hour. Reporting
      // abuse is an App Review 1.2 obligation and the budget must only be spent
      // on real reports — validate first, meter second.
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      if (!allowReport(req.user.id)) {
        return res.status(429).json({ error: 'You have filed a lot of reports recently. Try again in a little while.' });
      }

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
        } else if (content_type === 'venue_review') {
          // Public surface: anyone who can see the review can report it.
          const r = await pool.query(
            `SELECT user_id AS sender_id FROM venue_reviews
             WHERE id = $1 AND COALESCE(is_hidden, false) = false`,
            [content_id]
          );
          row = r.rows[0] || null;
        } else if (content_type === 'venue_promotion') {
          const r = await pool.query(
            `SELECT venue_user_id AS sender_id FROM venue_promotions
             WHERE id = $1 AND COALESCE(is_hidden, false) = false`,
            [content_id]
          );
          row = r.rows[0] || null;
        } else if (content_type === 'guest_rsvp') {
          // A guest RSVP is only visible to accepted members of its flock, so
          // only they may report it. sender_id stays NULL: there is no Flock
          // account behind a guest, which also means a reported_user_id sent
          // alongside this type correctly fails the author check below.
          const r = await pool.query(
            `SELECT NULL::int AS sender_id FROM guest_rsvps gr
             JOIN flock_members fm ON fm.flock_id = gr.flock_id AND fm.user_id = $2 AND fm.status = 'accepted'
             WHERE gr.id = $1 AND COALESCE(gr.is_hidden, false) = false`,
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

      // Round 9: one reporter re-filing the same target repeatedly inserted a
      // new row and re-paged moderators every time. While their earlier report
      // is still unhandled, answer the same success without a second row or a
      // second alert. The response is identical either way, so a reporter
      // learns nothing about what is already in the queue.
      const dupe = await pool.query(
        `SELECT id, status, created_at FROM content_reports
         WHERE reporter_id = $1
           AND content_type = $2
           AND content_id IS NOT DISTINCT FROM $3::int
           AND reported_user_id IS NOT DISTINCT FROM $4::int
           AND status IN ('open', 'under_review')
         LIMIT 1`,
        [req.user.id, content_type, content_id || null, reported_user_id || null]
      );
      if (dupe.rows.length > 0) {
        return res.status(201).json({
          message: 'Report received. Our team will review it promptly.',
          report: dupe.rows[0],
        });
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
// Round 15: `param('userId').isInt()` was declared on both block routes and its
// result was never read, so the validator did nothing. `POST /api/blocks/abc`
// reached Postgres as NaN and came back a 500 ("invalid input syntax for type
// integer"), and `POST /api/blocks/12abc` silently blocked user 12 — parseInt
// stops at the first non-digit. Blocking is the 1.2 safety control; it has to
// act on the id the caller actually named or say plainly that it did not.
function badId(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'Invalid user id' });
    return true;
  }
  return false;
}

router.post('/blocks/:userId', [param('userId').isInt()], async (req, res) => {
  try {
    if (badId(req, res)) return;
    const blockedId = parseInt(req.params.userId, 10);
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

    // The 30s block cache must not outlive the block itself — live location/
    // typing events check the cached variant (round 5).
    invalidateBlockCache(req.user.id, blockedId);

    // Tell the blocked user's client to stop any live DM location interval
    // aimed at the blocker; the server already refuses the events, this stops
    // the pointless emitting too.
    const io = req.app.get('io');
    if (io) io.to(`user:${blockedId}`).emit('blocked_by', { userId: req.user.id });

    res.status(201).json({ message: 'User blocked' });
  } catch (err) {
    console.error('Block user error:', err);
    res.status(500).json({ error: 'Failed to block user' });
  }
});

// DELETE /api/blocks/:userId — unblock.
router.delete('/blocks/:userId', [param('userId').isInt()], async (req, res) => {
  try {
    if (badId(req, res)) return;
    const blockedId = parseInt(req.params.userId, 10);
    const result = await pool.query(
      'DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2 RETURNING id',
      [req.user.id, blockedId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not blocked' });
    invalidateBlockCache(req.user.id, blockedId);
    res.json({ message: 'User unblocked' });
  } catch (err) {
    console.error('Unblock user error:', err);
    res.status(500).json({ error: 'Failed to unblock user' });
  }
});

module.exports = router;
