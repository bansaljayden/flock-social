const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const { pushIfOffline, pushAlways } = require('../services/pushHelper');

const router = express.Router();
router.use(authenticate);

// Rate limit reminders: 1 per flock per 5 minutes
const reminderCooldowns = new Map();

// POST /api/budget/:flockId/submit — Submit or update a budget amount
router.post('/:flockId/submit',
  [
    param('flockId').isInt().withMessage('Invalid flock ID'),
    body('amount').optional().isFloat({ min: 0.01, max: 10000 }).withMessage('Amount must be between $0.01 and $10,000'),
    body('skipped').optional().isBoolean(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;
      const { amount, skipped } = req.body;

      // Verify membership
      const memberCheck = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You are not a member of this flock' });
      }

      // Verify budget is enabled and not locked
      const flockCheck = await pool.query(
        'SELECT budget_enabled, budget_locked FROM flocks WHERE id = $1',
        [flockId]
      );
      if (flockCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Flock not found' });
      }
      if (!flockCheck.rows[0].budget_enabled) {
        return res.status(400).json({ error: 'Budget matching is not enabled for this flock' });
      }
      if (flockCheck.rows[0].budget_locked) {
        return res.status(400).json({ error: 'Budget has been locked' });
      }

      // Validate: if not skipped, amount is required
      if (!skipped && (!amount || amount <= 0)) {
        return res.status(400).json({ error: 'Amount is required when not skipping' });
      }

      // UPSERT budget submission
      await pool.query(
        `INSERT INTO budget_submissions (flock_id, user_id, amount, skipped, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (flock_id, user_id) DO UPDATE
         SET amount = $3, skipped = $4, updated_at = NOW()`,
        [flockId, userId, skipped ? null : amount, !!skipped]
      );

      // Recalculate ceiling: MIN of non-skipped amounts
      const ceilingResult = await pool.query(
        'SELECT MIN(amount) AS ceiling FROM budget_submissions WHERE flock_id = $1 AND skipped = false',
        [flockId]
      );
      const ceiling = ceilingResult.rows[0].ceiling ? parseFloat(ceilingResult.rows[0].ceiling) : null;

      // Update cached ceiling on flocks table
      await pool.query(
        'UPDATE flocks SET budget_ceiling = $1, updated_at = NOW() WHERE id = $2',
        [ceiling, flockId]
      );

      // Count submissions
      const countResult = await pool.query(
        `SELECT
           COUNT(*) AS total_submissions,
           COUNT(*) FILTER (WHERE skipped = false) AS non_skip_count,
           COUNT(*) FILTER (WHERE skipped = true) AS skip_count
         FROM budget_submissions WHERE flock_id = $1`,
        [flockId]
      );
      const { total_submissions, non_skip_count, skip_count } = countResult.rows[0];
      const submissionCount = parseInt(total_submissions);
      const skipCount = parseInt(skip_count);
      const nonSkipCount = parseInt(non_skip_count);

      // Total members
      const memberResult = await pool.query(
        "SELECT COUNT(*) AS total FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
        [flockId]
      );
      const totalMembers = parseInt(memberResult.rows[0].total);

      // Privacy: ceiling only visible when 3+ non-skip submissions
      const isReady = nonSkipCount >= 3;
      const visibleCeiling = isReady ? ceiling : null;

      // Emit socket event to flock room
      const io = req.app.get('io');
      if (io) {
        io.to(`flock:${flockId}`).emit('budget_updated', {
          flockId,
          ceiling: visibleCeiling,
          submissionCount,
          totalMembers,
          isReady,
          skipCount,
        });
      }

      // Push "Budget set!" when ceiling is first available
      if (isReady && visibleCeiling) {
        const flockNameResult = await pool.query('SELECT name FROM flocks WHERE id = $1', [flockId]);
        const flockName = flockNameResult.rows[0]?.name || 'Flock';
        const membersResult = await pool.query(
          "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2",
          [flockId, userId]
        );
        for (const m of membersResult.rows) {
          pushIfOffline(io, m.user_id,
            'Budget set!',
            `Group budget: up to $${Math.floor(visibleCeiling)} for ${flockName}`,
            { type: 'budget_ready', flockId: String(flockId) }
          );
        }
      }

      res.json({
        submitted: true,
        ceiling: visibleCeiling,
        submissionCount,
        totalMembers,
        isReady,
        skipCount,
        userSubmitted: true,
      });
    } catch (err) {
      console.error('Budget submit error:', err);
      res.status(500).json({ error: 'Failed to submit budget' });
    }
  }
);

// GET /api/budget/:flockId — Get budget status for a flock
router.get('/:flockId',
  [param('flockId').isInt().withMessage('Invalid flock ID')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;

      // Verify membership
      const memberCheck = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You are not a member of this flock' });
      }

      // Get flock budget config
      const flockResult = await pool.query(
        'SELECT budget_enabled, budget_context, budget_locked, budget_ceiling, ghost_mode_enabled FROM flocks WHERE id = $1',
        [flockId]
      );
      if (flockResult.rows.length === 0) {
        return res.status(404).json({ error: 'Flock not found' });
      }
      const flock = flockResult.rows[0];

      // Count submissions
      const countResult = await pool.query(
        `SELECT
           COUNT(*) AS total_submissions,
           COUNT(*) FILTER (WHERE skipped = false) AS non_skip_count,
           COUNT(*) FILTER (WHERE skipped = true) AS skip_count
         FROM budget_submissions WHERE flock_id = $1`,
        [flockId]
      );
      const submissionCount = parseInt(countResult.rows[0].total_submissions);
      const nonSkipCount = parseInt(countResult.rows[0].non_skip_count);
      const skipCount = parseInt(countResult.rows[0].skip_count);

      // Total members
      const memberResult = await pool.query(
        "SELECT COUNT(*) AS total FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
        [flockId]
      );
      const totalMembers = parseInt(memberResult.rows[0].total);

      // User's own submission (privacy: only their own)
      const userResult = await pool.query(
        'SELECT amount, skipped FROM budget_submissions WHERE flock_id = $1 AND user_id = $2',
        [flockId, userId]
      );
      const userSubmission = userResult.rows[0] || null;

      const isReady = nonSkipCount >= 3;
      const ceiling = flock.budget_ceiling ? parseFloat(flock.budget_ceiling) : null;
      const visibleCeiling = isReady ? ceiling : null;

      res.json({
        budgetEnabled: flock.budget_enabled,
        budgetContext: flock.budget_context,
        budgetLocked: flock.budget_locked,
        ceiling: visibleCeiling,
        submissionCount,
        totalMembers,
        isReady,
        skipCount,
        userSubmitted: !!userSubmission,
        userAmount: userSubmission && !userSubmission.skipped ? parseFloat(userSubmission.amount) : null,
        userSkipped: userSubmission ? userSubmission.skipped : false,
      });
    } catch (err) {
      console.error('Budget status error:', err);
      res.status(500).json({ error: 'Failed to get budget status' });
    }
  }
);

// POST /api/budget/:flockId/lock — Creator locks the budget
router.post('/:flockId/lock',
  [param('flockId').isInt().withMessage('Invalid flock ID')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;

      // Verify creator
      const flockResult = await pool.query(
        'SELECT creator_id, budget_enabled, budget_ceiling FROM flocks WHERE id = $1',
        [flockId]
      );
      if (flockResult.rows.length === 0) {
        return res.status(404).json({ error: 'Flock not found' });
      }
      if (flockResult.rows[0].creator_id !== userId) {
        return res.status(403).json({ error: 'Only the flock creator can lock the budget' });
      }
      if (!flockResult.rows[0].budget_enabled) {
        return res.status(400).json({ error: 'Budget matching is not enabled for this flock' });
      }

      await pool.query(
        'UPDATE flocks SET budget_locked = true, updated_at = NOW() WHERE id = $1',
        [flockId]
      );

      const ceiling = flockResult.rows[0].budget_ceiling ? parseFloat(flockResult.rows[0].budget_ceiling) : null;

      const io = req.app.get('io');
      if (io) {
        io.to(`flock:${flockId}`).emit('budget_locked', {
          flockId,
          ceiling,
          locked: true,
        });
      }

      res.json({ locked: true, ceiling });
    } catch (err) {
      console.error('Budget lock error:', err);
      res.status(500).json({ error: 'Failed to lock budget' });
    }
  }
);

// POST /api/budget/:flockId/remind — Send reminder to members who haven't submitted
router.post('/:flockId/remind',
  [param('flockId').isInt().withMessage('Invalid flock ID')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;

      // Verify creator
      const flockResult = await pool.query(
        'SELECT creator_id, name, budget_enabled FROM flocks WHERE id = $1',
        [flockId]
      );
      if (flockResult.rows.length === 0) {
        return res.status(404).json({ error: 'Flock not found' });
      }
      if (flockResult.rows[0].creator_id !== userId) {
        return res.status(403).json({ error: 'Only the flock creator can send reminders' });
      }
      if (!flockResult.rows[0].budget_enabled) {
        return res.status(400).json({ error: 'Budget matching is not enabled for this flock' });
      }

      // Rate limit: 1 reminder per flock per 5 minutes
      const cooldownKey = `remind:${flockId}`;
      const lastReminder = reminderCooldowns.get(cooldownKey);
      if (lastReminder && Date.now() - lastReminder < 5 * 60 * 1000) {
        return res.status(429).json({ error: 'Please wait before sending another reminder' });
      }

      // Find members who haven't submitted
      const missingResult = await pool.query(
        `SELECT u.id, u.name FROM flock_members fm
         JOIN users u ON u.id = fm.user_id
         WHERE fm.flock_id = $1 AND fm.status = 'accepted'
         AND fm.user_id NOT IN (SELECT user_id FROM budget_submissions WHERE flock_id = $1)`,
        [flockId]
      );

      const io = req.app.get('io');
      const flockName = flockResult.rows[0].name;
      if (io) {
        for (const member of missingResult.rows) {
          io.to(`user:${member.id}`).emit('budget_reminder', {
            flockId,
            flockName,
            message: "Don't forget to submit your budget!",
          });
        }
      }

      // Push regardless of online status — explicit creator action
      for (const member of missingResult.rows) {
        pushAlways(member.id,
          'Budget reminder',
          `Submit your budget for ${flockName}`,
          { type: 'budget_reminder', flockId: String(flockId) }
        );
      }

      reminderCooldowns.set(cooldownKey, Date.now());

      res.json({ reminded: missingResult.rows.length });
    } catch (err) {
      console.error('Budget remind error:', err);
      res.status(500).json({ error: 'Failed to send reminders' });
    }
  }
);

module.exports = router;
