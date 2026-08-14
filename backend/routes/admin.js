const express = require('express');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Admin middleware
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
router.use(requireAdmin);

// GET /api/admin/analytics - Research analytics dashboard data
router.get('/analytics', async (req, res) => {
  try {
    const totalFlocks = await pool.query('SELECT COUNT(*) AS count FROM flocks');

    const completionRate = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE status IN ('completed', 'cancelled')) AS terminal
       FROM flocks`
    );

    const avgGroupSize = await pool.query(
      `SELECT AVG(group_size)::NUMERIC(4,1) AS avg_size FROM research_analytics`
    );

    const budgetAdoption = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE budget_enabled = true) AS with_budget,
        COUNT(*) AS total
       FROM research_analytics`
    );

    const avgTimeToConfirm = await pool.query(
      `SELECT AVG(time_to_confirmation)::INTEGER AS avg_minutes
       FROM research_analytics WHERE flock_completed = true`
    );

    const stallPoints = await pool.query(
      `SELECT stall_point, COUNT(*) AS count
       FROM research_analytics
       GROUP BY stall_point
       ORDER BY count DESC`
    );

    const weeklyTrends = await pool.query(
      `SELECT
        DATE_TRUNC('week', created_at) AS week,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE flock_completed = true) AS completed,
        AVG(group_size)::NUMERIC(4,1) AS avg_group_size
       FROM research_analytics
       WHERE created_at > NOW() - INTERVAL '8 weeks'
       GROUP BY week
       ORDER BY week DESC`
    );

    const userStats = await pool.query(
      `SELECT COUNT(*) AS total_users,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS new_this_week
       FROM users`
    );

    const reliabilityDistribution = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE reliability_score >= 80) AS reliable,
        COUNT(*) FILTER (WHERE reliability_score >= 50 AND reliability_score < 80) AS moderate,
        COUNT(*) FILTER (WHERE reliability_score > 0 AND reliability_score < 50) AS flaky,
        COUNT(*) FILTER (WHERE reliability_score IS NULL) AS unscored
       FROM users`
    );

    const cr = completionRate.rows[0];
    const terminal = parseInt(cr.terminal) || 0;
    const ba = budgetAdoption.rows[0];
    const baTotal = parseInt(ba.total) || 0;

    res.json({
      totalFlocks: parseInt(totalFlocks.rows[0].count),
      completionRate: terminal > 0 ? Math.round((parseInt(cr.completed) / terminal) * 100) : 0,
      avgGroupSize: avgGroupSize.rows[0].avg_size ? parseFloat(avgGroupSize.rows[0].avg_size) : 0,
      budgetAdoptionRate: baTotal > 0 ? Math.round((parseInt(ba.with_budget) / baTotal) * 100) : 0,
      avgTimeToConfirmation: avgTimeToConfirm.rows[0].avg_minutes || 0,
      stallPointDistribution: stallPoints.rows,
      weeklyTrends: weeklyTrends.rows,
      totalUsers: parseInt(userStats.rows[0].total_users),
      newUsersThisWeek: parseInt(userStats.rows[0].new_this_week),
      reliabilityDistribution: reliabilityDistribution.rows[0],
    });
  } catch (err) {
    console.error('Admin analytics error:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// ---------------------------------------------------------------------------
// Moderation queue (A6) — Apple 1.2 / Google UGC. Admin-only (requireAdmin above).
// ---------------------------------------------------------------------------

// GET /api/admin/reports?status=open — moderation queue
router.get('/reports', async (req, res) => {
  try {
    const { status } = req.query;
    const params = [];
    let where = '';
    if (status && ['open', 'under_review', 'resolved', 'dismissed'].includes(status)) {
      params.push(status);
      where = 'WHERE r.status = $1';
    }
    // Round 11: the queue returned the report row and two names, never the
    // content being reported, so moderators were asked to hide or ban with no
    // evidence in front of them. The lateral pulls the ONE reported item per
    // report (nothing else from the thread) and the excerpt is capped so a
    // 200-row queue stays a small response. Additive columns only — the
    // existing dashboard keeps rendering unchanged.
    // NB: config/database.js rejects any query whose TEXT matches the word
    // starting "TRUNC...", alias names and comments included, which is why the
    // clipped flag is named content_excerpt_clipped.
    const result = await pool.query(
      `SELECT r.*, ru.name AS reporter_name,
              tu.name AS reported_user_name, tu.is_banned AS reported_user_banned,
              LEFT(c.body, 280) AS content_excerpt,
              (COALESCE(LENGTH(c.body), 0) > 280) AS content_excerpt_clipped,
              (c.image_url IS NOT NULL) AS content_has_image,
              -- Hosted URLs only: message/story images can be base64 data URLs
              -- megabytes long, and 200 of those is not a queue response.
              CASE WHEN c.image_url LIKE 'data:%' OR LENGTH(c.image_url) > 500
                   THEN NULL ELSE c.image_url END AS content_image_url,
              c.author_id AS content_author_id,
              c.created_at AS content_created_at,
              c.is_hidden AS content_is_hidden,
              (r.content_id IS NOT NULL AND r.content_type <> 'profile' AND c.author_id IS NULL
                 AND c.body IS NULL AND c.created_at IS NULL) AS content_missing
       FROM content_reports r
       LEFT JOIN users ru ON ru.id = r.reporter_id
       LEFT JOIN users tu ON tu.id = r.reported_user_id
       LEFT JOIN LATERAL (
         SELECT m.message_text AS body, m.image_url, m.sender_id AS author_id,
                m.created_at, COALESCE(m.is_hidden, false) AS is_hidden
         FROM messages m WHERE r.content_type = 'flock_message' AND m.id = r.content_id
         UNION ALL
         SELECT d.message_text, d.image_url, d.sender_id, d.created_at, COALESCE(d.is_hidden, false)
         FROM direct_messages d WHERE r.content_type = 'dm' AND d.id = r.content_id
         UNION ALL
         SELECT s.caption, s.image_url, s.user_id, s.created_at, COALESCE(s.is_hidden, false)
         FROM stories s WHERE r.content_type = 'story' AND s.id = r.content_id
         UNION ALL
         SELECT vr.text, NULL, vr.user_id, vr.created_at, COALESCE(vr.is_hidden, false)
         FROM venue_reviews vr WHERE r.content_type = 'venue_review' AND vr.id = r.content_id
         UNION ALL
         -- Guest RSVPs have no Flock account behind them, so author_id is NULL;
         -- the reported content IS the guest's self-chosen display name.
         SELECT gr.name, NULL, NULL, gr.created_at, COALESCE(gr.is_hidden, false)
         FROM guest_rsvps gr WHERE r.content_type = 'guest_rsvp' AND gr.id = r.content_id
         UNION ALL
         SELECT NULLIF(CONCAT_WS(': ', vp.title, vp.description), ''), NULL, vp.venue_user_id,
                vp.created_at, COALESCE(vp.is_hidden, false)
         FROM venue_promotions vp WHERE r.content_type = 'venue_promotion' AND vp.id = r.content_id
         LIMIT 1
       ) c ON true
       ${where}
       ORDER BY (r.status = 'open') DESC, r.created_at DESC
       LIMIT 200`,
      params
    );
    // Counts for the queue header
    const counts = await pool.query(
      `SELECT status, COUNT(*)::int AS count FROM content_reports GROUP BY status`
    );
    res.json({ reports: result.rows, counts: counts.rows });
  } catch (err) {
    console.error('Admin list reports error:', err);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// PUT /api/admin/reports/:id — take a moderation action:
//   action ∈ 'hide' (take content down) | 'ban' | 'unban' | 'dismiss'
router.put('/reports/:id', async (req, res) => {
  try {
    // A non-numeric :id used to reach Postgres as NaN and surface as a 500,
    // which in the moderation queue is indistinguishable from "the takedown
    // failed" — the one thing a moderator must never be unsure about.
    const reportId = /^\d+$/.test(String(req.params.id)) ? parseInt(req.params.id, 10) : null;
    if (reportId === null) return res.status(404).json({ error: 'Report not found' });

    const { action, reason } = req.body;
    if (!['hide', 'ban', 'unban', 'dismiss'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const rep = await pool.query('SELECT * FROM content_reports WHERE id = $1', [reportId]);
    if (rep.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
    const report = rep.rows[0];

    const newStatus = action === 'dismiss' ? 'dismissed' : 'resolved';

    // Round 11: the mutation, the report resolution and the audit row were
    // three independent pool.query calls. A failure between them could ban a
    // user or hide content with NO audit record, or resolve a report that was
    // never acted on. All three commit together or none of them do.
    // Round 13: a moderator action that performs NOTHING must not report
    // success. `refusal` short-circuits the transaction and is answered after
    // the client is released, so the route never rolls back and releases twice.
    const client = await pool.connect();
    let actionType;
    let banTargetId = null;
    let refusal = null;
    try {
      await client.query('BEGIN');

      if (action === 'hide') {
        // Table name comes from this fixed map, never from the request body.
        // guest_rsvps added round 13 — migration 005 built the takedown and
        // nothing was ever wired to it, so an abusive guest RSVP name could not
        // be removed by anyone.
        const table = {
          flock_message: 'messages',
          dm: 'direct_messages',
          story: 'stories',
          venue_review: 'venue_reviews',
          venue_promotion: 'venue_promotions',
          guest_rsvp: 'guest_rsvps',
        }[report.content_type];

        // FAIL LOUDLY (round 13). A 'profile' report has no row in this map, so
        // the UPDATE never ran — and the route still answered "Action applied",
        // resolved the report, and wrote an audit row claiming content_hidden.
        // A moderator was told abusive content was down while it was still
        // live, and the audit log recorded work nobody did.
        if (!table || !report.content_id) {
          refusal = {
            status: 400,
            error: report.content_type === 'profile'
              ? 'A profile report has no content to hide. Ban the user or dismiss the report.'
              : 'There is nothing to hide on this report.',
          };
        } else {
          // The audit action is derived from what the database actually did,
          // never assumed.
          const hidden = await client.query(`UPDATE ${table} SET is_hidden = true WHERE id = $1`, [report.content_id]);
          if (hidden.rowCount === 0) {
            refusal = { status: 404, error: 'That content no longer exists. Dismiss the report instead.' };
          } else {
            actionType = 'content_hidden';
          }
        }
      } else if (action === 'ban' || action === 'unban') {
        // Same lie, same fix: without a reported user there is nobody to ban.
        if (!report.reported_user_id) {
          refusal = { status: 400, error: 'This report names no user, so there is nobody to ban or unban.' };
        } else {
          const banned = action === 'ban';
          const changed = await client.query(
            banned
              ? 'UPDATE users SET is_banned = true, banned_at = NOW() WHERE id = $1'
              : 'UPDATE users SET is_banned = false, banned_at = NULL WHERE id = $1',
            [report.reported_user_id]
          );
          if (changed.rowCount === 0) {
            refusal = { status: 404, error: 'That user no longer exists. Dismiss the report instead.' };
          } else {
            actionType = banned ? 'user_banned' : 'user_unbanned';
            if (banned) banTargetId = report.reported_user_id;
          }
        }
      } else {
        actionType = 'dismissed';
      }

      if (refusal) {
        await client.query('ROLLBACK');
      } else {
        await client.query(
          'UPDATE content_reports SET status = $1, handled_by = $2, resolved_at = NOW() WHERE id = $3',
          [newStatus, req.user.id, reportId]
        );
        await client.query(
          `INSERT INTO moderation_actions (report_id, moderator_id, target_user_id, action, content_type, content_id, reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [reportId, req.user.id, report.reported_user_id || null, actionType, report.content_type, report.content_id || null, reason || null]
        );

        await client.query('COMMIT');
      }
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    if (refusal) {
      return res.status(refusal.status).json({ error: refusal.error });
    }

    // Ban must bite NOW: the socket handshake checks is_banned once, so an
    // established connection would otherwise keep working indefinitely. Runs
    // after COMMIT so a rolled-back ban never kicks anyone off.
    if (banTargetId) {
      const io = req.app.get('io');
      if (io) io.in(`user:${banTargetId}`).disconnectSockets(true);
    }

    res.json({ message: 'Action applied', status: newStatus, action: actionType });
  } catch (err) {
    console.error('Admin moderate error:', err);
    res.status(500).json({ error: 'Failed to apply action' });
  }
});

// ---------------------------------------------------------------------------
// Venue verification: admin flips verified after checking real ownership
// (public badge/promotions/review-replies are gated on it).
// ---------------------------------------------------------------------------
router.get('/venues/unverified', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT vp.id, vp.user_id, vp.business_name, vp.location, vp.google_place_id, vp.created_at, u.email
       FROM venue_profiles vp JOIN users u ON u.id = vp.user_id
       WHERE vp.verified = false ORDER BY vp.created_at DESC`
    );
    res.json({ venues: result.rows });
  } catch (err) {
    console.error('Admin unverified venues error:', err);
    res.status(500).json({ error: 'Failed to load venues' });
  }
});

router.put('/venues/:profileId/verify', async (req, res) => {
  try {
    // A non-numeric :profileId used to reach Postgres as NaN and surface as a
    // 500 ("invalid input syntax for type integer"); it is a 404. venue_profiles.id
    // is a SERIAL integer, so anything that is not all digits names no row.
    const profileId = /^\d+$/.test(String(req.params.profileId)) ? parseInt(req.params.profileId, 10) : null;
    if (profileId === null) return res.status(404).json({ error: 'Venue profile not found' });
    // `verified` defaults to true (the button that just says "Verify" sends no
    // body), but anything that is not a real boolean is refused rather than
    // coerced: `{"verified":"false"}` used to VERIFY a claim, which is the
    // dangerous direction to get wrong on the route that decides who is allowed
    // to speak as a business.
    const payload = req.body || {};
    if ('verified' in payload && typeof payload.verified !== 'boolean') {
      return res.status(400).json({ error: 'verified must be true or false' });
    }
    const verified = payload.verified !== false;
    // Migration 002 puts a unique partial index on venue_profiles
    // (google_place_id) WHERE verified = true, so verifying a SECOND claimant on
    // a place someone else already holds raised 23505 and came back a 500 — the
    // admin was told the system broke when in fact it correctly refused, and the
    // real reason (another account already owns this place) was never named.
    //
    // The conflict is detected inside the same statement rather than by a
    // separate SELECT, so there is no window between the check and the write:
    // `target` names the row being verified, `blocked` is the OTHER verified
    // claim on its place id, and the UPDATE simply does not fire when one
    // exists. The outer SELECT still returns a row whenever the profile exists,
    // so "no such profile" (0 rows) stays distinguishable from "refused" (a row
    // whose UPDATE half is missing) without a second query.
    //
    // Un-verifying is never blocked, and a NULL google_place_id cannot conflict
    // (the partial index treats NULLs as distinct), so both skip the check.
    const result = await pool.query(
      `WITH target AS (
         SELECT id, google_place_id FROM venue_profiles WHERE id = $2
       ),
       blocked AS (
         SELECT other.user_id
         FROM venue_profiles other
         JOIN target t ON other.google_place_id = t.google_place_id
         WHERE $1::boolean = true
           AND t.google_place_id IS NOT NULL
           AND other.verified = true
           AND other.id <> t.id
         LIMIT 1
       ),
       upd AS (
         UPDATE venue_profiles SET verified = $1, updated_at = NOW()
         WHERE id = $2 AND NOT EXISTS (SELECT 1 FROM blocked)
         RETURNING id, business_name, verified
       )
       SELECT u.id, u.business_name, u.verified,
              t.google_place_id,
              (SELECT user_id FROM blocked) AS conflict_user_id
       FROM target t LEFT JOIN upd u ON true`,
      [verified, profileId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Venue profile not found' });
    const row = result.rows[0];
    // The refusal is read off the UPDATE, not off the conflicting owner's id:
    // venue_profiles.user_id is nullable, so a conflicting row with a NULL
    // user_id would otherwise have looked like success and answered 200 with a
    // row of nulls. `blocked` is the only thing that can stop the UPDATE, so a
    // target that exists with no updated row IS the conflict.
    if (row.id == null) {
      const who = row.conflict_user_id != null ? `Another account (user ${row.conflict_user_id})` : 'Another account';
      return res.status(409).json({
        error: `${who} is already the verified owner of Google place ${row.google_place_id}. Un-verify that claim first.`,
        code: 'PLACE_ALREADY_VERIFIED',
        conflictUserId: row.conflict_user_id ?? null,
        googlePlaceId: row.google_place_id,
      });
    }
    res.json({ id: row.id, business_name: row.business_name, verified: row.verified });
  } catch (err) {
    // Two admins verifying rival claims on the same place at the same instant
    // both see an empty `blocked`, and the unique index decides. That is the
    // same refusal, so it gets the same answer instead of a 500.
    if (err && err.code === '23505') {
      return res.status(409).json({
        error: 'Another account is already the verified owner of that Google place. Un-verify that claim first.',
        code: 'PLACE_ALREADY_VERIFIED',
      });
    }
    console.error('Admin verify venue error:', err);
    res.status(500).json({ error: 'Failed to update verification' });
  }
});

// POST /api/admin/venues/:userId/tier — comp or change a venue's tier
// (VENUE-BILLING.md Phase 0: tier is server-written only; this is the manual
// path for demos and hand-sold venues until Stripe self-serve exists).
router.post('/venues/:userId/tier', async (req, res) => {
  try {
    const { tier, reason } = req.body;
    if (!['free', 'premium', 'pro'].includes(tier)) {
      return res.status(400).json({ error: 'tier must be free, premium, or pro' });
    }
    // A non-numeric :userId reached Postgres as NaN and came back a 500; users.id
    // is an integer key, so a non-digit id names no venue owner — 404, not 500.
    const targetUserId = /^\d+$/.test(String(req.params.userId)) ? parseInt(req.params.userId, 10) : null;
    if (targetUserId === null) return res.status(404).json({ error: 'Venue profile not found' });
    const result = await pool.query(
      'UPDATE venue_profiles SET tier = $1, updated_at = NOW() WHERE user_id = $2 RETURNING id, business_name, tier',
      [tier, targetUserId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Venue profile not found' });
    console.log(`[Admin] venue tier: user ${req.params.userId} -> ${tier} by admin ${req.user.id} (${reason || 'no reason given'})`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Admin venue tier error:', err);
    res.status(500).json({ error: 'Failed to update tier' });
  }
});

// GET /api/admin/moderation-actions — audit log
router.get('/moderation-actions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ma.*, mod.name AS moderator_name, tu.name AS target_user_name
       FROM moderation_actions ma
       LEFT JOIN users mod ON mod.id = ma.moderator_id
       LEFT JOIN users tu ON tu.id = ma.target_user_id
       ORDER BY ma.created_at DESC LIMIT 200`
    );
    res.json({ actions: result.rows });
  } catch (err) {
    console.error('Admin audit log error:', err);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

module.exports = router;
