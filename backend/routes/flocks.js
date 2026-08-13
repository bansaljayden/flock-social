const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { stripHtml } = require('../utils/sanitize');
const { rejectIfProfane } = require('../utils/moderation');
const { safeVenuePhotoUrl } = require('../utils/venuePayload');
const { isBlockedBetween } = require('../utils/blocks');
const { GUEST_RSVP_SELECT, toGuestEntry, combineRsvpCounts } = require('../utils/guestRsvp');

const { pushIfOffline } = require('../services/pushHelper');

const router = express.Router();

// All flock routes require authentication
router.use(authenticate);

// GET /api/flocks - Get all flocks the user belongs to
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT f.*,
              -- PRIVACY: budget_ceiling is MIN(submissions); below the 3-non-skip
              -- threshold it IS someone's exact budget. This aliased CASE
              -- overrides the f.* column in the result row (node-postgres keeps
              -- the last duplicate field), mirroring the budget-status gate.
              CASE WHEN (SELECT COUNT(*) FROM budget_submissions bs
                         WHERE bs.flock_id = f.id AND bs.skipped = false) >= 3
                   THEN f.budget_ceiling ELSE NULL END AS budget_ceiling,
              u.name AS creator_name,
              fm.status AS member_status,
              (SELECT COUNT(*) FROM flock_members WHERE flock_id = f.id AND status = 'accepted') AS member_count,
              -- Guests RSVP from the share link and have no membership row, so
              -- they were invisible in every count the host saw. member_count
              -- keeps its old meaning (accounts); going_count is the number to
              -- put next to "going".
              (SELECT COUNT(*) FROM guest_rsvps gr
                WHERE gr.flock_id = f.id AND gr.status = 'in'
                  AND COALESCE(gr.is_hidden, false) = false)::int AS guest_count,
              ((SELECT COUNT(*) FROM flock_members WHERE flock_id = f.id AND status = 'accepted')
               + (SELECT COUNT(*) FROM guest_rsvps gr
                   WHERE gr.flock_id = f.id AND gr.status = 'in'
                     AND COALESCE(gr.is_hidden, false) = false))::int AS going_count,
              (SELECT json_agg(row_to_json(m) ORDER BY m.is_creator DESC, m.id)
                 FROM (
                   SELECT mu.id, mu.name, mu.profile_image_url, (mu.id = f.creator_id) AS is_creator
                   FROM flock_members mfm
                   JOIN users mu ON mu.id = mfm.user_id
                   WHERE mfm.flock_id = f.id AND mfm.status = 'accepted'
                   ORDER BY (mu.id = f.creator_id) DESC, mfm.id
                   LIMIT 4
                 ) m
              ) AS member_previews
       FROM flocks f
       JOIN flock_members fm ON fm.flock_id = f.id AND fm.user_id = $1
       JOIN users u ON u.id = f.creator_id
       ORDER BY f.updated_at DESC`,
      [req.user.id]
    );

    // Non-accepted rows collapse to an invite card (round 3: the list was
    // still handing invitees f.*, coordinates, and member previews even
    // after the detail route got its minimal DTO)
    const flocks = result.rows.map((f) => {
      if (f.member_status === 'accepted') return f;
      return {
        id: f.id,
        name: f.name,
        venue_name: f.venue_name,
        event_time: f.event_time,
        creator_name: f.creator_name,
        member_count: f.member_count,
        guest_count: f.guest_count,
        going_count: f.going_count,
        member_status: f.member_status,
        invitePreview: true,
      };
    });
    res.json({ flocks });
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
    body('invited_user_ids').optional().isArray({ max: 25 }).withMessage('invited_user_ids must be an array'),
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

      // UGC text filter on user-writable flock fields (Apple 1.2).
      if (rejectIfProfane(res, name)) return;
      if (budget_context && rejectIfProfane(res, budget_context)) return;
      if (venue_name && rejectIfProfane(res, venue_name)) return;
      if (venue_address && rejectIfProfane(res, venue_address)) return;
      // Photo URLs render as <img> for every member — proxy path only (round 8).
      const safePhotoUrl = safeVenuePhotoUrl(venue_photo_url);

      console.log('[Flock Create] User:', req.user.id, '| Name:', name, '| Venue:', venue_name || '(none)');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Create the flock
        const flockResult = await client.query(
          `INSERT INTO flocks (name, creator_id, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, venue_photo_url, event_time, budget_enabled, budget_context, ghost_mode_enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING *`,
          [name, req.user.id, venue_name || null, venue_address || null, venue_id || null, venue_latitude || null, venue_longitude || null, venue_rating || null, safePhotoUrl, event_time || null, !!budget_enabled, budget_context || null, budget_enabled ? !!ghost_mode_enabled : false]
        );

        const flock = flockResult.rows[0];
        console.log('[Flock Create] Flock created with id:', flock.id);

        // Add the creator as an accepted member
        await client.query(
          `INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted')`,
          [flock.id, req.user.id]
        );

        // Invite additional users if provided (parameterized, status = 'invited').
        // Mutual blocks hold here too — the standalone invite endpoint skips
        // blocked pairs, and creating a fresh flock must not be a way around it.
        const invitedUids = [];
        if (invited_user_ids && invited_user_ids.length > 0) {
          for (const userId of invited_user_ids) {
            const uid = parseInt(userId);
            if (!Number.isFinite(uid) || uid === req.user.id) continue;
            if (await isBlockedBetween(req.user.id, uid)) continue;
            await client.query(
              `INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'invited')
               ON CONFLICT (flock_id, user_id) DO NOTHING`,
              [flock.id, uid]
            );
            invitedUids.push(uid);
          }
          console.log('[Flock Create] Invited', invitedUids.length, 'users');
        }

        await client.query('COMMIT');
        console.log('[Flock Create] Success - flock id:', flock.id);

        // Notify invited users via socket (only the ones actually inserted —
        // blocked pairs were skipped above)
        if (invitedUids.length > 0) {
          const io = req.app.get('io');
          if (io) {
            for (const uid of invitedUids) {
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
        JOIN flock_members fm ON fm.flock_id = f.id AND fm.user_id = $1 AND fm.status = 'accepted'
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
        JOIN flock_members my ON my.flock_id = f2.id AND my.user_id = $1 AND my.status = 'accepted'
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
      `SELECT f.*,
              CASE WHEN (SELECT COUNT(*) FROM budget_submissions bs
                         WHERE bs.flock_id = f.id AND bs.skipped = false) >= 3
                   THEN f.budget_ceiling ELSE NULL END AS budget_ceiling,
              u.name AS creator_name
       FROM flocks f
       JOIN users u ON u.id = f.creator_id
       WHERE f.id = $1`,
      [flockId]
    );

    if (flockResult.rows.length === 0) {
      return res.status(404).json({ error: 'Flock not found' });
    }

    // Invited/declined users get a minimal invite card, not the full flock:
    // no member emails, reliability scores, attendance, budgets, or messages
    // (audit 2026-08-12 — membership-row existence is not acceptance).
    if (membership.rows[0].status !== 'accepted') {
      const inv = flockResult.rows[0];
      const cnt = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM flock_members WHERE flock_id = $1 AND status = 'accepted')::int AS n,
           (SELECT COUNT(*) FROM guest_rsvps WHERE flock_id = $1 AND status = 'in'
              AND COALESCE(is_hidden, false) = false)::int AS guests`,
        [flockId]
      );
      return res.json({
        flock: {
          id: inv.id,
          name: inv.name,
          venue_name: inv.venue_name,
          event_time: inv.event_time,
          creator_name: inv.creator_name,
          member_count: cnt.rows[0].n,
          // Counts only — an invitee still gets no names, guests included.
          guest_count: cnt.rows[0].guests,
          going_count: cnt.rows[0].n + cnt.rows[0].guests,
          member_status: membership.rows[0].status,
        },
        members: [],
        guests: [],
        invitePreview: true,
      });
    }

    const membersResult = await pool.query(
      `SELECT u.id, u.name, u.profile_image_url, u.reliability_score, fm.status, fm.attendance, fm.joined_at
       FROM flock_members fm
       JOIN users u ON u.id = fm.user_id
       WHERE fm.flock_id = $1
       ORDER BY fm.joined_at ASC`,
      [flockId]
    );

    // Guest-link RSVPs. Nothing in this file read this table before, so a guest
    // who answered the share link appeared NOWHERE for the host: not in the
    // roster, not in the counts, not in momentum. They come back as their own
    // array (tagged is_guest, string ids) rather than mixed into `members`,
    // where a guest id would leak into member-only, integer-keyed paths.
    const guestsResult = await pool.query(GUEST_RSVP_SELECT, [flockId]);
    const guests = guestsResult.rows.map(toGuestEntry);

    // ── Momentum Meter calculation ──
    const flock = flockResult.rows[0];
    const members = membersResult.rows;
    const counts = combineRsvpCounts(members, guests);
    const totalMembers = counts.total;
    const accepted = counts.accepted;   // members + guests who said yes
    const declined = counts.declined;
    const responded = counts.responded;

    let score = 0;

    // RSVP progress (0-30 pts) — based on response rate
    if (totalMembers > 0) {
      score += Math.round((responded / totalMembers) * 15); // responses
      score += Math.round((accepted / totalMembers) * 15);  // acceptances
    }

    // Venue set (20 pts)
    const hasVenue = flock.venue_name && flock.venue_name !== 'TBD';
    if (hasVenue) score += 20;

    // Venue votes cast (0-10 pts). Guests vote too (routes/guest.js), and the
    // denominator below now includes them, so counting only member voters would
    // have made every guest RSVP push this score DOWN. Hidden guests are
    // excluded here exactly as they are in routes/venues.js and routes/guest.js.
    const votesResult = await pool.query(
      'SELECT COUNT(DISTINCT user_id) AS voters FROM venue_votes WHERE flock_id = $1',
      [flockId]
    );
    const guestVotesResult = await pool.query(
      `SELECT COUNT(DISTINCT gv.guest_rsvp_id) AS voters
       FROM guest_votes gv
       JOIN guest_rsvps gr ON gr.id = gv.guest_rsvp_id
       WHERE gv.flock_id = $1 AND COALESCE(gr.is_hidden, false) = false`,
      [flockId]
    );
    const uniqueVoters =
      parseInt(votesResult.rows[0].voters || 0) + parseInt(guestVotesResult.rows[0].voters || 0);
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
      // Budget submissions are account-only — a guest has no way to submit one,
      // so the denominator stays members. Using the guest-inclusive `accepted`
      // here would make inviting guests look like budget regress.
      if (counts.memberAccepted > 0) {
        score += Math.min(10, Math.round((submissions / counts.memberAccepted) * 10));
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

    const momentum = {
      score, stage, accepted, totalMembers, responded, hasVenue,
      hasTime: !!flock.event_time, uniqueVoters,
      // Broken out so the UI can say "4 going (2 guests)" without re-deriving it.
      memberAccepted: counts.memberAccepted,
      guestsGoing: counts.guestsGoing,
      guestCount: counts.guestCount,
    };

    // Counts on the flock object itself, for the header/list surfaces that read
    // the flock row rather than the roster.
    flock.member_count = counts.memberAccepted;
    flock.guest_count = counts.guestsGoing;
    flock.going_count = counts.accepted;

    res.json({
      flock,
      members,
      guests,
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

      // Same UGC screen as creation — editing must not be a bypass (round 7).
      if (name && rejectIfProfane(res, name)) return;
      if (venue_name && rejectIfProfane(res, venue_name)) return;
      if (venue_address && rejectIfProfane(res, venue_address)) return;
      // Photo-proxy-only, same as creation (round 8).
      const safePhotoUrl = safeVenuePhotoUrl(venue_photo_url);

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
        [name, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, safePhotoUrl, event_time, status, flockId]
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

      // PRIVACY: RETURNING * carries the raw budget_ceiling — apply the same
      // 3-submission threshold as every other surface before responding
      // (review round 3: an innocuous update was a fourth door to the value).
      const flockResponse = { ...result.rows[0] };
      if (flockResponse.budget_ceiling != null) {
        const thr = await pool.query(
          `SELECT COUNT(*)::int AS n FROM budget_submissions WHERE flock_id = $1 AND skipped = false`,
          [flockId]
        );
        if ((thr.rows[0]?.n || 0) < 3) flockResponse.budget_ceiling = null;
      }
      res.json({ flock: flockResponse });
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

// POST /api/flocks/:id/invite-link — create (or return) the flock's shareable
// guest link. Any accepted member can share it; guests RSVP + vote from the
// link with no account (routes/guest.js). One active link per flock; calling
// with { regenerate: true } revokes the old one (kills a leaked link).
router.post('/:id/invite-link', param('id').isInt(), async (req, res) => {
  try {
    const flockId = req.params.id;
    const member = await pool.query(
      "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
      [flockId, req.user.id]
    );
    if (member.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this flock' });
    }

    if (req.body?.regenerate) {
      await pool.query('UPDATE flock_invite_links SET revoked = true WHERE flock_id = $1', [flockId]);
    }

    const existing = await pool.query(
      'SELECT token FROM flock_invite_links WHERE flock_id = $1 AND revoked = false LIMIT 1',
      [flockId]
    );
    let token = existing.rows[0]?.token;
    if (!token) {
      const { newLinkToken } = require('./guest');
      token = newLinkToken();
      await pool.query(
        'INSERT INTO flock_invite_links (token, flock_id, created_by) VALUES ($1, $2, $3)',
        [token, flockId, req.user.id]
      );
    }

    const base = process.env.PUBLIC_WEB_URL || 'https://flock-app-w65m.vercel.app';
    res.json({ token, url: `${base}/i/${token}` });
  } catch (err) {
    console.error('Invite link error:', err);
    res.status(500).json({ error: 'Could not create invite link' });
  }
});

// POST /api/flocks/:id/join - Accept a flock invite
router.post('/:id/join', param('id').isInt(), async (req, res) => {
  try {
    const flockId = req.params.id;

    // Check flock exists
    const flock = await pool.query('SELECT id FROM flocks WHERE id = $1', [flockId]);
    if (flock.rows.length === 0) {
      return res.status(404).json({ error: 'Flock not found' });
    }

    // Access control: only users with an existing membership row (invited,
    // previously declined, or already accepted) may join. Without this check,
    // any authenticated user could add themselves to any flock by ID and read
    // its messages (IDOR).
    const membership = await pool.query(
      'SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2',
      [flockId, req.user.id]
    );
    if (membership.rows.length === 0) {
      return res.status(403).json({ error: 'You must be invited to join this flock' });
    }

    // Flip membership to 'accepted'. Round 9: the UPDATE matched unconditionally,
    // so an already-accepted member could re-POST this route as often as they
    // liked and every call re-broadcast the join and re-pushed a notification to
    // the creator. `AND status <> 'accepted'` makes rowCount the record of a REAL
    // transition; a repeat is still a 200, it just stays silent.
    const result = await pool.query(
      `UPDATE flock_members SET status = 'accepted', joined_at = NOW()
       WHERE flock_id = $1 AND user_id = $2 AND status <> 'accepted'
       RETURNING *`,
      [flockId, req.user.id]
    );
    const transitioned = result.rowCount > 0;

    let member = result.rows[0];
    if (!transitioned) {
      const current = await pool.query(
        'SELECT * FROM flock_members WHERE flock_id = $1 AND user_id = $2',
        [flockId, req.user.id]
      );
      member = current.rows[0];
    }

    if (transitioned) {
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
    }

    res.json({ member });
  } catch (err) {
    console.error('Join flock error:', err);
    res.status(500).json({ error: 'Failed to join flock' });
  }
});

// POST /api/flocks/:id/invite - Invite users to an existing flock
router.post('/:id/invite',
  [
    param('id').isInt(),
    body('user_ids').isArray({ min: 1, max: 25 }).withMessage('user_ids must be a non-empty array'),
  ],
  async (req, res) => {
    try {
      console.log('[Invite] Route hit — flock:', req.params.id, '| user_ids count:', Array.isArray(req.body?.user_ids) ? req.body.user_ids.length : 0);
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

        // Blocked pairs never invite each other (round 3: filtering only the
        // socket notification still created the membership row)
        if (await isBlockedBetween(req.user.id, uid)) continue;

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

    // Round 5: without this, any authenticated user who guessed a flock id
    // could learn its name and broadcast fake departures that decrement every
    // member's displayed count. Non-members get the same 404 as a bad id.
    if (!isCreator) {
      const mem = await pool.query(
        'SELECT 1 FROM flock_members WHERE flock_id = $1 AND user_id = $2',
        [flockId, req.user.id]
      );
      if (mem.rows.length === 0) {
        return res.status(404).json({ error: 'Flock not found' });
      }
    }

    const io = req.app.get('io');

    if (isCreator) {
      // Notify all members before deleting
      if (io) {
        io.to(`flock:${flockId}`).emit('flock_deleted', { flockId: parseInt(flockId), flockName, deletedBy: req.user.name });
      }
      // Creator leaving deletes the entire flock (cascade removes members, messages, votes)
      await pool.query('DELETE FROM flocks WHERE id = $1', [flockId]);
      if (io) io.socketsLeave(`flock:${flockId}`); // no ghost listeners on a dead room
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

    // Revoke live room access (audit 2026-08-12): room auth is checked only at
    // join time, so without this a departed member's open sockets kept
    // receiving messages, locations, and votes until they disconnected.
    if (io) io.in(`user:${req.user.id}`).socketsLeave(`flock:${flockId}`);

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

    // ACCEPTED members only see the roster (round 3: invitees got every
    // member's email from here). Email dropped from the payload entirely —
    // flockmates don't need each other's addresses.
    const membership = await pool.query(
      "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
      [flockId, req.user.id]
    );
    if (membership.rows.length === 0) {
      return res.status(404).json({ error: 'Flock not found' });
    }

    const result = await pool.query(
      `SELECT u.id, u.name, u.profile_image_url, fm.status, fm.joined_at
       FROM flock_members fm
       JOIN users u ON u.id = fm.user_id
       WHERE fm.flock_id = $1
       ORDER BY fm.joined_at ASC`,
      [flockId]
    );

    // Same roster, same omission: guests were missing here too. Separate array,
    // so a caller that only wants accounts is unaffected.
    const guestsResult = await pool.query(GUEST_RSVP_SELECT, [flockId]);
    const guests = guestsResult.rows.map(toGuestEntry);

    res.json({
      members: result.rows,
      guests,
      going_count: result.rows.filter(m => m.status === 'accepted').length
        + guests.filter(g => g.status === 'accepted').length,
    });
  } catch (err) {
    console.error('Get members error:', err);
    res.status(500).json({ error: 'Failed to get members' });
  }
});

// POST /api/flocks/:id/attendance - Mark who attended (creator only, completed flocks)
router.post('/:id/attendance',
  [
    param('id').isInt(),
    body('attendance').isArray({ min: 1, max: 50 }).withMessage('Attendance array required'),
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

        // Recalculate reliability for each affected user. Scoped to ACCEPTED
        // members of THIS flock and deduped — unbounded arbitrary ids meant
        // query amplification + push spam to strangers (round 7).
        const memberRows = await client.query(
          "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
          [flockId]
        );
        const memberSet = new Set(memberRows.rows.map(r => r.user_id));
        const affectedUserIds = [...new Set(attendance.map(a => parseInt(a.userId)).filter(id => Number.isFinite(id) && memberSet.has(id)))];
        for (const userId of affectedUserIds) {
          const joined = await client.query(
            `SELECT COUNT(*) AS cnt FROM flock_members fm
             JOIN flocks f ON f.id = fm.flock_id
             WHERE fm.user_id = $1 AND fm.status = 'accepted' AND f.status = 'completed' AND fm.attendance != 'unmarked'`,
            [userId]
          );
          // Numerator scoped to COMPLETED flocks like the denominator —
          // counting a live check-in on an active flock produced 200% scores
          // (round 5).
          const attended = await client.query(
            `SELECT COUNT(*) AS cnt FROM flock_members fm
             JOIN flocks f ON f.id = fm.flock_id
             WHERE fm.user_id = $1 AND fm.attendance = 'attended' AND f.status = 'completed'`,
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
