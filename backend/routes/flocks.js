const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { stripHtml } = require('../utils/sanitize');

const { pushIfOffline } = require('../services/pushHelper');

const router = express.Router();

// All flock routes require authentication
router.use(authenticate);

// GET /api/flocks - Get all flocks the user belongs to
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT f.*,
              u.name AS creator_name,
              fm.status AS member_status,
              (SELECT COUNT(*) FROM flock_members WHERE flock_id = f.id AND status = 'accepted') AS member_count
       FROM flocks f
       JOIN flock_members fm ON fm.flock_id = f.id AND fm.user_id = $1
       JOIN users u ON u.id = f.creator_id
       ORDER BY f.updated_at DESC`,
      [req.user.id]
    );

    res.json({ flocks: result.rows });
  } catch (err) {
    console.error('Get flocks error:', err);
    res.status(500).json({ error: 'Failed to get flocks' });
  }
});

// POST /api/flocks - Create a new flock
router.post('/',
  [
    body('name').trim().customSanitizer(stripHtml).isLength({ min: 1, max: 255 }).withMessage('Flock name is required'),
    body('venue_name').optional().trim().customSanitizer(stripHtml),
    body('venue_address').optional().trim().customSanitizer(stripHtml),
    body('venue_id').optional().trim(),
    body('venue_latitude').optional().isFloat(),
    body('venue_longitude').optional().isFloat(),
    body('venue_rating').optional().isFloat(),
    body('venue_photo_url').optional().trim(),
    body('event_time').optional().isISO8601().withMessage('Invalid event time'),
    body('invited_user_ids').optional().isArray().withMessage('invited_user_ids must be an array'),
    body('budget_enabled').optional().isBoolean(),
    body('budget_context').optional().trim().isLength({ max: 100 }),
    body('ghost_mode_enabled').optional().isBoolean(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.error('[Flock Create] Validation error:', errors.array());
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { name, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, venue_photo_url, event_time, invited_user_ids, budget_enabled, budget_context, ghost_mode_enabled } = req.body;
      console.log('[Flock Create] User:', req.user.id, '| Name:', name, '| Venue:', venue_name || '(none)');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Create the flock
        const flockResult = await client.query(
          `INSERT INTO flocks (name, creator_id, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, venue_photo_url, event_time, budget_enabled, budget_context, ghost_mode_enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING *`,
          [name, req.user.id, venue_name || null, venue_address || null, venue_id || null, venue_latitude || null, venue_longitude || null, venue_rating || null, venue_photo_url || null, event_time || null, !!budget_enabled, budget_context || null, budget_enabled ? !!ghost_mode_enabled : false]
        );

        const flock = flockResult.rows[0];
        console.log('[Flock Create] Flock created with id:', flock.id);

        // Add the creator as an accepted member
        await client.query(
          `INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted')`,
          [flock.id, req.user.id]
        );

        // Invite additional users if provided (parameterized, status = 'invited')
        if (invited_user_ids && invited_user_ids.length > 0) {
          for (const userId of invited_user_ids) {
            const uid = parseInt(userId);
            if (!Number.isFinite(uid) || uid === req.user.id) continue;
            await client.query(
              `INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'invited')
               ON CONFLICT (flock_id, user_id) DO NOTHING`,
              [flock.id, uid]
            );
          }
          console.log('[Flock Create] Invited', invited_user_ids.length, 'users');
        }

        await client.query('COMMIT');
        console.log('[Flock Create] Success - flock id:', flock.id);

        // Notify invited users via socket
        if (invited_user_ids && invited_user_ids.length > 0) {
          const io = req.app.get('io');
          if (io) {
            for (const userId of invited_user_ids) {
              const uid = parseInt(userId);
              if (!Number.isFinite(uid) || uid === req.user.id) continue;
              io.to(`user:${uid}`).emit('flock_invite_received', {
                flockId: flock.id,
                flockName: flock.name,
                invitedBy: { userId: req.user.id, name: req.user.name },
              });
            }
          }
        }

        res.status(201).json({ flock });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[Flock Create] Error:', err.message);
      console.error('[Flock Create] Detail:', err.detail || 'none');
      res.status(500).json({ error: 'Failed to create flock' });
    }
  }
);

// GET /api/flocks/activity - Recent activity from user's flocks
router.get('/activity', async (req, res) => {
  try {
    const result = await pool.query(
      `(
        SELECT 'created' AS action, f.creator_id AS user_id, u.name AS user_name,
               f.name AS flock_name, f.id AS flock_id, f.created_at AS happened_at
        FROM flocks f
        JOIN users u ON u.id = f.creator_id
        JOIN flock_members fm ON fm.flock_id = f.id AND fm.user_id = $1
        WHERE f.created_at > NOW() - INTERVAL '7 days'
      )
      UNION ALL
      (
        SELECT
          CASE WHEN fm2.status = 'accepted' THEN 'joined' ELSE 'declined' END AS action,
          fm2.user_id, u2.name AS user_name,
          f2.name AS flock_name, f2.id AS flock_id, fm2.joined_at AS happened_at
        FROM flock_members fm2
        JOIN users u2 ON u2.id = fm2.user_id
        JOIN flocks f2 ON f2.id = fm2.flock_id
        JOIN flock_members my ON my.flock_id = f2.id AND my.user_id = $1
        WHERE fm2.user_id != $1
          AND fm2.joined_at > NOW() - INTERVAL '7 days'
          AND fm2.status IN ('accepted', 'declined')
      )
      ORDER BY happened_at DESC
      LIMIT 20`,
      [req.user.id]
    );
    res.json({ activity: result.rows });
  } catch (err) {
    console.error('Get activity error:', err);
    res.status(500).json({ error: 'Failed to get activity' });
  }
});

// GET /api/flocks/:id - Get a specific flock with members
router.get('/:id', param('id').isInt(), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid flock ID' });
    }

    const flockId = req.params.id;

    // Verify user is a member
    const membership = await pool.query(
      'SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2',
      [flockId, req.user.id]
    );
    if (membership.rows.length === 0) {
      return res.status(404).json({ error: 'Flock not found' });
    }

    const flockResult = await pool.query(
      `SELECT f.*, u.name AS creator_name
       FROM flocks f
       JOIN users u ON u.id = f.creator_id
       WHERE f.id = $1`,
      [flockId]
    );

    if (flockResult.rows.length === 0) {
      return res.status(404).json({ error: 'Flock not found' });
    }

    const membersResult = await pool.query(
      `SELECT u.id, u.name, u.email, u.profile_image_url, u.reliability_score, fm.status, fm.attendance, fm.joined_at
       FROM flock_members fm
       JOIN users u ON u.id = fm.user_id
       WHERE fm.flock_id = $1
       ORDER BY fm.joined_at ASC`,
      [flockId]
    );

    // ── Momentum Meter calculation ──
    const flock = flockResult.rows[0];
    const members = membersResult.rows;
    const totalMembers = members.length;
    const accepted = members.filter(m => m.status === 'accepted').length;
    const declined = members.filter(m => m.status === 'declined').length;
    const responded = accepted + declined;

    let score = 0;

    // RSVP progress (0-30 pts) — based on response rate
    if (totalMembers > 0) {
      score += Math.round((responded / totalMembers) * 15); // responses
      score += Math.round((accepted / totalMembers) * 15);  // acceptances
    }

    // Venue set (20 pts)
    const hasVenue = flock.venue_name && flock.venue_name !== 'TBD';
    if (hasVenue) score += 20;

    // Venue votes cast (0-10 pts)
    const votesResult = await pool.query(
      'SELECT COUNT(DISTINCT user_id) AS voters FROM venue_votes WHERE flock_id = $1',
      [flockId]
    );
    const uniqueVoters = parseInt(votesResult.rows[0].voters || 0);
    if (accepted > 0) {
      score += Math.min(10, Math.round((uniqueVoters / accepted) * 10));
    }

    // Event time set (10 pts)
    if (flock.event_time) score += 10;

    // Budget progress (0-20 pts, only if budget enabled)
    if (flock.budget_enabled) {
      const budgetResult = await pool.query(
        'SELECT COUNT(*) AS submissions FROM budget_submissions WHERE flock_id = $1',
        [flockId]
      );
      const submissions = parseInt(budgetResult.rows[0].submissions || 0);
      if (accepted > 0) {
        score += Math.min(10, Math.round((submissions / accepted) * 10));
      }
      if (flock.budget_locked) score += 10;
    } else {
      // No budget = auto-fill those 20 pts based on other signals
      score += 20;
    }

    // Flock confirmed (10 pts)
    if (flock.status === 'confirmed' || flock.status === 'locked') score += 10;

    // Cap at 100
    score = Math.min(100, score);

    // Map score to stage
    let stage;
    if (flock.status === 'completed') stage = 'complete';
    else if (score >= 85) stage = 'lets_go';
    else if (score >= 65) stage = 'locked_in';
    else if (score >= 40) stage = 'almost_there';
    else if (score >= 15) stage = 'building';
    else stage = 'idea';

    const momentum = { score, stage, accepted, totalMembers, responded, hasVenue, hasTime: !!flock.event_time, uniqueVoters };

    res.json({
      flock,
      members,
      momentum,
    });
  } catch (err) {
    console.error('Get flock error:', err);
    res.status(500).json({ error: 'Failed to get flock' });
  }
});

// PUT /api/flocks/:id - Update a flock (creator only)
router.put('/:id',
  [
    param('id').isInt(),
    body('name').optional().trim().isLength({ min: 1, max: 255 }),
    body('venue_name').optional().trim(),
    body('venue_address').optional().trim(),
    body('venue_id').optional().trim(),
    body('venue_latitude').optional().isFloat(),
    body('venue_longitude').optional().isFloat(),
    body('venue_rating').optional().isFloat(),
    body('venue_photo_url').optional().trim(),
    body('event_time').optional().isISO8601(),
    body('status').optional().isIn(['planning', 'confirmed', 'completed', 'cancelled']),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = req.params.id;

      // Verify ownership
      const flock = await pool.query('SELECT creator_id FROM flocks WHERE id = $1', [flockId]);
      if (flock.rows.length === 0) {
        return res.status(404).json({ error: 'Flock not found' });
      }
      if (flock.rows[0].creator_id !== req.user.id) {
        return res.status(403).json({ error: 'Only the creator can update this flock' });
      }

      const { name, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, venue_photo_url, event_time, status } = req.body;

      const result = await pool.query(
        `UPDATE flocks
         SET name = COALESCE($1, name),
             venue_name = COALESCE($2, venue_name),
             venue_address = COALESCE($3, venue_address),
             venue_id = COALESCE($4, venue_id),
             venue_latitude = COALESCE($5, venue_latitude),
             venue_longitude = COALESCE($6, venue_longitude),
             venue_rating = COALESCE($7, venue_rating),
             venue_photo_url = COALESCE($8, venue_photo_url),
             event_time = COALESCE($9, event_time),
             status = COALESCE($10, status),
             updated_at = NOW()
         WHERE id = $11
         RETURNING *`,
        [name, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, venue_photo_url, event_time, status, flockId]
      );

      // Notify flock members of the update
      const io = req.app.get('io');
      const updated = result.rows[0];
      if (io) {
        io.to(`flock:${flockId}`).emit('flock_updated', {
          flockId: parseInt(flockId),
          name: updated.name,
          venue_name: updated.venue_name,
          venue_address: updated.venue_address,
          venue_id: updated.venue_id,
          venue_latitude: updated.venue_latitude,
          venue_longitude: updated.venue_longitude,
          venue_rating: updated.venue_rating,
          venue_photo_url: updated.venue_photo_url,
          event_time: updated.event_time,
          status: updated.status,
          updatedBy: req.user.name,
        });
      }

      // Push "It's happening!" when flock is confirmed
      if (status === 'confirmed') {
        const membersResult = await pool.query(
          "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2",
          [flockId, req.user.id]
        );
        const timeStr = updated.event_time ? new Date(updated.event_time).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
        const bodyText = [updated.name, updated.venue_name, timeStr].filter(Boolean).join(' — ');
        for (const m of membersResult.rows) {
          await pushIfOffline(io, m.user_id,
            "It's happening!",
            bodyText,
            { type: 'flock_confirmed', flockId: String(flockId) }
          );
        }
      }

      // Auto-populate research analytics on completion or cancellation
      if (status === 'completed' || status === 'cancelled') {
        try {
          const memberCount = await pool.query(
            "SELECT COUNT(*) AS cnt FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
            [flockId]
          );
          const budgetInfo = await pool.query(
            `SELECT COUNT(*) AS sub_count, COUNT(*) FILTER (WHERE skipped = true) AS skip_count
             FROM budget_submissions WHERE flock_id = $1`,
            [flockId]
          );
          const ff = updated;
          const minutesElapsed = Math.round((Date.now() - new Date(ff.created_at).getTime()) / 60000);

          let stallPoint = 'completed';
          if (status === 'cancelled') {
            const accepted = parseInt(memberCount.rows[0].cnt);
            if (accepted < 2) stallPoint = 'rsvp';
            else if (ff.budget_enabled && !ff.budget_locked) stallPoint = 'budget';
            else if (!ff.venue_name) stallPoint = 'venue';
            else stallPoint = 'confirmation';
          }

          await pool.query(
            `INSERT INTO research_analytics
              (flock_id, group_size, budget_enabled, budget_ceiling, submission_count, skip_count,
               flock_completed, venue_price_level_selected, time_to_confirmation, stall_point)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (flock_id) DO NOTHING`,
            [
              flockId,
              parseInt(memberCount.rows[0].cnt),
              ff.budget_enabled || false,
              ff.budget_ceiling ? parseFloat(ff.budget_ceiling) : null,
              parseInt(budgetInfo.rows[0].sub_count),
              parseInt(budgetInfo.rows[0].skip_count),
              status === 'completed',
              null,
              minutesElapsed,
              stallPoint,
            ]
          );
        } catch (analyticsErr) {
          console.error('Research analytics error (non-fatal):', analyticsErr.message);
        }
      }

      res.json({ flock: result.rows[0] });
    } catch (err) {
      console.error('Update flock error:', err);
      res.status(500).json({ error: 'Failed to update flock' });
    }
  }
);

// DELETE /api/flocks/:id - Delete a flock (creator only)
router.delete('/:id', param('id').isInt(), async (req, res) => {
  try {
    const flockId = req.params.id;

    const flock = await pool.query('SELECT creator_id FROM flocks WHERE id = $1', [flockId]);
    if (flock.rows.length === 0) {
      return res.status(404).json({ error: 'Flock not found' });
    }
    if (flock.rows[0].creator_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the creator can delete this flock' });
    }

    // Notify members before deleting
    const io = req.app.get('io');
    const nameResult = await pool.query('SELECT name FROM flocks WHERE id = $1', [flockId]);
    if (io) {
      io.to(`flock:${flockId}`).emit('flock_deleted', { flockId: parseInt(flockId), flockName: nameResult.rows[0]?.name, deletedBy: req.user.name });
    }

    await pool.query('DELETE FROM flocks WHERE id = $1', [flockId]);
    res.json({ message: 'Flock deleted' });
  } catch (err) {
    console.error('Delete flock error:', err);
    res.status(500).json({ error: 'Failed to delete flock' });
  }
});

// POST /api/flocks/:id/join - Join (accept invite) or request to join a flock
router.post('/:id/join', param('id').isInt(), async (req, res) => {
  try {
    const flockId = req.params.id;

    // Check flock exists
    const flock = await pool.query('SELECT id FROM flocks WHERE id = $1', [flockId]);
    if (flock.rows.length === 0) {
      return res.status(404).json({ error: 'Flock not found' });
    }

    // Upsert membership to 'accepted'
    const result = await pool.query(
      `INSERT INTO flock_members (flock_id, user_id, status)
       VALUES ($1, $2, 'accepted')
       ON CONFLICT (flock_id, user_id)
       DO UPDATE SET status = 'accepted', joined_at = NOW()
       RETURNING *`,
      [flockId, req.user.id]
    );

    // Notify flock members that someone joined
    const io = req.app.get('io');
    if (io) {
      io.to(`flock:${flockId}`).emit('flock_invite_responded', {
        flockId: parseInt(flockId),
        userId: req.user.id,
        userName: req.user.name,
        userImage: req.user.profile_image_url || null,
        action: 'accepted',
      });
    }

    // Push notification to flock creator
    const flockData = await pool.query('SELECT creator_id, name FROM flocks WHERE id = $1', [flockId]);
    if (flockData.rows.length > 0 && flockData.rows[0].creator_id !== req.user.id) {
      await pushIfOffline(io, flockData.rows[0].creator_id,
        `${req.user.name} is going!`,
        flockData.rows[0].name,
        { type: 'flock_rsvp', flockId: String(flockId) }
      );
    }

    res.json({ member: result.rows[0] });
  } catch (err) {
    console.error('Join flock error:', err);
    res.status(500).json({ error: 'Failed to join flock' });
  }
});

// POST /api/flocks/:id/invite - Invite users to an existing flock
router.post('/:id/invite',
  [
    param('id').isInt(),
    body('user_ids').isArray({ min: 1 }).withMessage('user_ids must be a non-empty array'),
  ],
  async (req, res) => {
    try {
      console.log('[Invite] Route hit — flock:', req.params.id, '| body:', JSON.stringify(req.body));
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.log('[Invite] Validation error:', errors.array());
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.id);
      const { user_ids } = req.body;

      // Verify the inviter is an accepted member
      const membership = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, req.user.id]
      );
      if (membership.rows.length === 0) {
        return res.status(403).json({ error: 'You must be a member of this flock to invite others' });
      }

      const flockResult = await pool.query('SELECT id, name FROM flocks WHERE id = $1', [flockId]);
      if (flockResult.rows.length === 0) {
        return res.status(404).json({ error: 'Flock not found' });
      }

      const invited = [];
      for (const userId of user_ids) {
        const uid = parseInt(userId);
        if (!Number.isFinite(uid) || uid === req.user.id) continue;

        const userCheck = await pool.query('SELECT id, name FROM users WHERE id = $1', [uid]);
        if (userCheck.rows.length === 0) continue;

        // Check if already a member
        const existing = await pool.query(
          'SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2',
          [flockId, uid]
        );

        if (existing.rows.length > 0 && existing.rows[0].status === 'accepted') {
          console.log('[Invite] User', uid, 'already accepted member, skipping');
          continue;
        }

        if (existing.rows.length > 0 && existing.rows[0].status === 'invited') {
          console.log('[Invite] User', uid, 'already invited, skipping');
          continue;
        }

        if (existing.rows.length > 0 && existing.rows[0].status === 'declined') {
          // Re-invite
          await pool.query(
            `UPDATE flock_members SET status = 'invited' WHERE flock_id = $1 AND user_id = $2`,
            [flockId, uid]
          );
          invited.push({ user_id: uid, user_name: userCheck.rows[0].name });
          console.log('[Invite] Re-invited declined user', uid);
        } else {
          // New invite
          await pool.query(
            `INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'invited')`,
            [flockId, uid]
          );
          invited.push({ user_id: uid, user_name: userCheck.rows[0].name });
          console.log('[Invite] Invited new user', uid);
        }
      }

      // Notify invited users via socket
      if (invited.length > 0) {
        const io = req.app.get('io');
        if (io) {
          const flockName = flockResult.rows[0].name;
          for (const inv of invited) {
            io.to(`user:${inv.user_id}`).emit('flock_invite_received', {
              flockId,
              flockName,
              invitedBy: { userId: req.user.id, name: req.user.name },
            });
          }
          io.to(`flock:${flockId}`).emit('flock_members_invited', {
            flockId,
            invitedBy: { userId: req.user.id, name: req.user.name },
            invitedUserIds: invited.map(i => i.user_id),
          });

          // Push notifications for offline invited users
          for (const inv of invited) {
            await pushIfOffline(io, inv.user_id,
              `${req.user.name} invited you to a flock`,
              flockName,
              { type: 'flock_invite', flockId: String(flockId) }
            );
          }
        }
      }

      res.json({ message: `Invited ${invited.length} user(s)`, invited, flock: flockResult.rows[0] });
    } catch (err) {
      console.error('[Invite] Error:', err.message, err.detail || '');
      res.status(500).json({ error: 'Failed to invite users' });
    }
  }
);

// POST /api/flocks/:id/decline - Decline a flock invite
router.post('/:id/decline', param('id').isInt(), async (req, res) => {
  try {
    console.log('[Decline] Route hit — flock:', req.params.id, '| user:', req.user.id);
    const flockId = parseInt(req.params.id);

    const result = await pool.query(
      `UPDATE flock_members SET status = 'declined'
       WHERE flock_id = $1 AND user_id = $2 AND status = 'invited'
       RETURNING *`,
      [flockId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No pending invite for this flock' });
    }

    // Notify flock members
    const io = req.app.get('io');
    if (io) {
      io.to(`flock:${flockId}`).emit('flock_invite_responded', {
        flockId,
        userId: req.user.id,
        userName: req.user.name,
        action: 'declined',
      });
    }

    res.json({ message: 'Invite declined' });
  } catch (err) {
    console.error('Decline flock error:', err);
    res.status(500).json({ error: 'Failed to decline invite' });
  }
});

// POST /api/flocks/:id/leave - Leave a flock
router.post('/:id/leave', param('id').isInt(), async (req, res) => {
  try {
    const flockId = req.params.id;

    const flock = await pool.query('SELECT id, name, creator_id FROM flocks WHERE id = $1', [flockId]);
    if (flock.rows.length === 0) {
      return res.status(404).json({ error: 'Flock not found' });
    }

    const isCreator = flock.rows[0].creator_id === req.user.id;
    const flockName = flock.rows[0].name;

    const io = req.app.get('io');

    if (isCreator) {
      // Notify all members before deleting
      if (io) {
        io.to(`flock:${flockId}`).emit('flock_deleted', { flockId: parseInt(flockId), flockName, deletedBy: req.user.name });
      }
      // Creator leaving deletes the entire flock (cascade removes members, messages, votes)
      await pool.query('DELETE FROM flocks WHERE id = $1', [flockId]);
      return res.json({ message: 'Left flock', flock_name: flockName, deleted: true });
    }

    // Notify flock that member left
    if (io) {
      io.to(`flock:${flockId}`).emit('flock_member_left', { flockId: parseInt(flockId), userId: req.user.id, userName: req.user.name });
    }

    // Remove member
    await pool.query(
      'DELETE FROM flock_members WHERE flock_id = $1 AND user_id = $2',
      [flockId, req.user.id]
    );

    // If no accepted members remain, delete the flock
    const remaining = await pool.query(
      "SELECT COUNT(*) AS cnt FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
      [flockId]
    );

    const deleted = parseInt(remaining.rows[0].cnt) === 0;
    if (deleted) {
      await pool.query('DELETE FROM flocks WHERE id = $1', [flockId]);
    }

    res.json({ message: 'Left flock', flock_name: flockName, deleted });
  } catch (err) {
    console.error('Leave flock error:', err);
    res.status(500).json({ error: 'Failed to leave flock' });
  }
});

// GET /api/flocks/:id/members - Get members of a flock
router.get('/:id/members', param('id').isInt(), async (req, res) => {
  try {
    const flockId = req.params.id;

    // Verify user is a member
    const membership = await pool.query(
      'SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2',
      [flockId, req.user.id]
    );
    if (membership.rows.length === 0) {
      return res.status(404).json({ error: 'Flock not found' });
    }

    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.profile_image_url, fm.status, fm.joined_at
       FROM flock_members fm
       JOIN users u ON u.id = fm.user_id
       WHERE fm.flock_id = $1
       ORDER BY fm.joined_at ASC`,
      [flockId]
    );

    res.json({ members: result.rows });
  } catch (err) {
    console.error('Get members error:', err);
    res.status(500).json({ error: 'Failed to get members' });
  }
});

// POST /api/flocks/:id/attendance - Mark who attended (creator only, completed flocks)
router.post('/:id/attendance',
  [
    param('id').isInt(),
    body('attendance').isArray({ min: 1 }).withMessage('Attendance array required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = req.params.id;
      const { attendance } = req.body;

      // Verify creator + completed status
      const flock = await pool.query('SELECT creator_id, status, name FROM flocks WHERE id = $1', [flockId]);
      if (flock.rows.length === 0) return res.status(404).json({ error: 'Flock not found' });
      if (flock.rows[0].creator_id !== req.user.id) return res.status(403).json({ error: 'Only the creator can mark attendance' });
      if (flock.rows[0].status !== 'completed') return res.status(400).json({ error: 'Flock must be completed to mark attendance' });

      const client = await pool.connect();
      const results = [];
      try {
        await client.query('BEGIN');

        for (const entry of attendance) {
          const { userId, attended } = entry;
          if (!userId) continue;
          const status = attended ? 'attended' : 'no_show';

          await client.query(
            `UPDATE flock_members SET attendance = $1 WHERE flock_id = $2 AND user_id = $3 AND status = 'accepted'`,
            [status, flockId, userId]
          );
        }

        // Recalculate reliability for each affected user
        const affectedUserIds = attendance.map(a => a.userId).filter(Boolean);
        for (const userId of affectedUserIds) {
          const joined = await client.query(
            `SELECT COUNT(*) AS cnt FROM flock_members fm
             JOIN flocks f ON f.id = fm.flock_id
             WHERE fm.user_id = $1 AND fm.status = 'accepted' AND f.status = 'completed' AND fm.attendance != 'unmarked'`,
            [userId]
          );
          const attended = await client.query(
            `SELECT COUNT(*) AS cnt FROM flock_members WHERE user_id = $1 AND attendance = 'attended'`,
            [userId]
          );
          const totalJoined = parseInt(joined.rows[0].cnt);
          const totalAttended = parseInt(attended.rows[0].cnt);
          const score = totalJoined > 0 ? Math.round((totalAttended / totalJoined) * 100 * 100) / 100 : null;

          await client.query(
            `UPDATE users SET reliability_score = $1, total_plans_joined = $2, total_plans_attended = $3 WHERE id = $4`,
            [score, totalJoined, totalAttended, userId]
          );
          results.push({ userId, reliabilityScore: score, totalPlansJoined: totalJoined, totalPlansAttended: totalAttended });
        }

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }

      // Socket notifications
      const io = req.app.get('io');
      if (io) {
        io.to(`flock:${flockId}`).emit('attendance_marked', { flockId: parseInt(flockId), attendance: results });
        for (const r of results) {
          io.to(`user:${r.userId}`).emit('reliability_updated', {
            reliabilityScore: r.reliabilityScore,
            totalPlansJoined: r.totalPlansJoined,
            totalPlansAttended: r.totalPlansAttended,
          });
        }
      }

      // Push to offline users
      for (const r of results) {
        if (r.userId !== req.user.id) {
          await pushIfOffline(io, r.userId,
            'Attendance recorded',
            `${flock.rows[0].name} — your reliability score updated`,
            { type: 'attendance_marked', flockId: String(flockId) }
          );
        }
      }

      res.json({ success: true, results });
    } catch (err) {
      console.error('Attendance error:', err);
      res.status(500).json({ error: 'Failed to record attendance' });
    }
  }
);

module.exports = router;
