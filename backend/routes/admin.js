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
    const result = await pool.query(
      `SELECT r.*, ru.name AS reporter_name,
              tu.name AS reported_user_name, tu.is_banned AS reported_user_banned
       FROM content_reports r
       LEFT JOIN users ru ON ru.id = r.reporter_id
       LEFT JOIN users tu ON tu.id = r.reported_user_id
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
    const reportId = parseInt(req.params.id);
    const { action, reason } = req.body;
    if (!['hide', 'ban', 'unban', 'dismiss'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    const rep = await pool.query('SELECT * FROM content_reports WHERE id = $1', [reportId]);
    if (rep.rows.length === 0) return res.status(404).json({ error: 'Report not found' });
    const report = rep.rows[0];

    let actionType;
    if (action === 'hide') {
      const table = { flock_message: 'messages', dm: 'direct_messages', story: 'stories' }[report.content_type];
      if (table && report.content_id) {
        await pool.query(`UPDATE ${table} SET is_hidden = true WHERE id = $1`, [report.content_id]);
      }
      actionType = 'content_hidden';
    } else if (action === 'ban') {
      if (report.reported_user_id) {
        await pool.query('UPDATE users SET is_banned = true, banned_at = NOW() WHERE id = $1', [report.reported_user_id]);
      }
      actionType = 'user_banned';
    } else if (action === 'unban') {
      if (report.reported_user_id) {
        await pool.query('UPDATE users SET is_banned = false, banned_at = NULL WHERE id = $1', [report.reported_user_id]);
      }
      actionType = 'user_unbanned';
    } else {
      actionType = 'dismissed';
    }

    const newStatus = action === 'dismiss' ? 'dismissed' : 'resolved';
    await pool.query(
      'UPDATE content_reports SET status = $1, handled_by = $2, resolved_at = NOW() WHERE id = $3',
      [newStatus, req.user.id, reportId]
    );
    await pool.query(
      `INSERT INTO moderation_actions (report_id, moderator_id, target_user_id, action, content_type, content_id, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [reportId, req.user.id, report.reported_user_id || null, actionType, report.content_type, report.content_id || null, reason || null]
    );

    res.json({ message: 'Action applied', status: newStatus, action: actionType });
  } catch (err) {
    console.error('Admin moderate error:', err);
    res.status(500).json({ error: 'Failed to apply action' });
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
