const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// POST /api/billing/:flockId/create — Create a bill split
router.post('/:flockId/create',
  [
    param('flockId').isInt().withMessage('Invalid flock ID'),
    body('totalAmount').isFloat({ min: 0.01, max: 100000 }).withMessage('Total must be between $0.01 and $100,000'),
    body('tipPercent').optional().isFloat({ min: 0, max: 100 }).withMessage('Tip must be 0-100%'),
    body('splitType').optional().isIn(['equal', 'custom']).withMessage('Split type must be equal or custom'),
    body('paidBy').optional().isInt().withMessage('Invalid payer ID'),
    body('customShares').optional().isArray(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;
      const { totalAmount, tipPercent = 0, splitType = 'equal', paidBy, customShares } = req.body;
      const payerId = paidBy ? parseInt(paidBy) : userId;

      // Verify membership
      const memberCheck = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, userId]
      );
      if (memberCheck.rows.length === 0) {
        return res.status(403).json({ error: 'You are not a member of this flock' });
      }

      // Verify payer is a member
      const payerCheck = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, payerId]
      );
      if (payerCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Payer must be a member of the flock' });
      }

      // Get accepted members
      const membersResult = await pool.query(
        `SELECT u.id, u.name FROM flock_members fm
         JOIN users u ON u.id = fm.user_id
         WHERE fm.flock_id = $1 AND fm.status = 'accepted'`,
        [flockId]
      );
      const members = membersResult.rows;
      if (members.length === 0) {
        return res.status(400).json({ error: 'No accepted members in this flock' });
      }

      // Get flock name
      const flockResult = await pool.query('SELECT name FROM flocks WHERE id = $1', [flockId]);
      const flockName = flockResult.rows[0]?.name || 'Flock';

      // Calculate total with tip
      const totalWithTip = Math.round(totalAmount * (1 + tipPercent / 100) * 100) / 100;

      // Check for existing ghost-mode commitments
      const existingBill = await pool.query(
        'SELECT id FROM bill_splits WHERE flock_id = $1',
        [flockId]
      );
      const existingCommitments = new Map();
      if (existingBill.rows.length > 0) {
        const commitResult = await pool.query(
          'SELECT user_id, committed FROM bill_split_shares WHERE bill_id = $1 AND committed = true',
          [existingBill.rows[0].id]
        );
        for (const row of commitResult.rows) {
          existingCommitments.set(row.user_id, true);
        }
      }

      // Calculate shares
      let shares;
      if (splitType === 'custom' && customShares && customShares.length > 0) {
        // Validate custom shares add up
        const customTotal = customShares.reduce((sum, s) => sum + parseFloat(s.amount || 0), 0);
        const diff = Math.abs(customTotal - totalWithTip);
        if (diff > 0.02) {
          return res.status(400).json({ error: `Custom shares must add up to $${totalWithTip.toFixed(2)}` });
        }
        shares = customShares.map(s => ({
          userId: parseInt(s.userId),
          amount: Math.round(parseFloat(s.amount) * 100) / 100,
        }));
      } else {
        // Equal split with penny rounding
        const memberCount = members.length;
        const baseShare = Math.floor(totalWithTip * 100 / memberCount) / 100;
        const remainderCents = Math.round((totalWithTip - baseShare * memberCount) * 100);

        shares = members.map((m, i) => ({
          userId: m.id,
          amount: i < remainderCents ? baseShare + 0.01 : baseShare,
        }));
      }

      // Use transaction
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // UPSERT bill_splits
        const billResult = await client.query(
          `INSERT INTO bill_splits (flock_id, total_amount, split_type, paid_by, tip_percent)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (flock_id) DO UPDATE
           SET total_amount = $2, split_type = $3, paid_by = $4, tip_percent = $5, updated_at = NOW()
           RETURNING id`,
          [flockId, totalAmount, splitType, payerId, tipPercent]
        );
        const billId = billResult.rows[0].id;

        // Delete existing shares (for re-creation)
        await client.query('DELETE FROM bill_split_shares WHERE bill_id = $1', [billId]);

        // Insert shares
        for (const share of shares) {
          const isPayer = share.userId === payerId;
          const wasCommitted = existingCommitments.has(share.userId);
          await client.query(
            `INSERT INTO bill_split_shares (bill_id, user_id, amount, committed, settled, settled_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [billId, share.userId, share.amount, wasCommitted, isPayer, isPayer ? new Date() : null]
          );
        }

        await client.query('COMMIT');

        // Build response with names
        const shareDetails = shares.map(s => {
          const member = members.find(m => m.id === s.userId);
          return {
            userId: s.userId,
            name: member?.name || 'Unknown',
            amount: s.amount,
            settled: s.userId === payerId,
            committed: existingCommitments.has(s.userId),
          };
        });

        const payer = members.find(m => m.id === payerId);
        const bill = {
          id: billId,
          flockId,
          totalAmount,
          tipPercent,
          totalWithTip,
          splitType,
          paidBy: { id: payerId, name: payer?.name || 'Unknown' },
          shares: shareDetails,
          createdAt: new Date().toISOString(),
        };

        // Emit socket event
        const io = req.app.get('io');
        if (io) {
          io.to(`flock:${flockId}`).emit('bill_created', { flockId, bill });
        }

        res.status(201).json({ bill });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('Bill create error:', err);
      res.status(500).json({ error: 'Failed to create bill split' });
    }
  }
);

// GET /api/billing/:flockId — Get bill split for a flock
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

      const billResult = await pool.query(
        `SELECT bs.*, u.name AS payer_name
         FROM bill_splits bs
         LEFT JOIN users u ON u.id = bs.paid_by
         WHERE bs.flock_id = $1`,
        [flockId]
      );
      if (billResult.rows.length === 0) {
        return res.status(404).json({ error: 'No bill found for this flock' });
      }

      const bill = billResult.rows[0];
      const totalWithTip = Math.round(parseFloat(bill.total_amount) * (1 + parseFloat(bill.tip_percent) / 100) * 100) / 100;

      const sharesResult = await pool.query(
        `SELECT bss.*, u.name FROM bill_split_shares bss
         JOIN users u ON u.id = bss.user_id
         WHERE bss.bill_id = $1
         ORDER BY bss.id`,
        [bill.id]
      );

      res.json({
        bill: {
          id: bill.id,
          flockId: bill.flock_id,
          totalAmount: parseFloat(bill.total_amount),
          tipPercent: parseFloat(bill.tip_percent),
          totalWithTip,
          splitType: bill.split_type,
          paidBy: { id: bill.paid_by, name: bill.payer_name },
          shares: sharesResult.rows.map(s => ({
            userId: s.user_id,
            name: s.name,
            amount: parseFloat(s.amount),
            committed: s.committed,
            settled: s.settled,
            settledAt: s.settled_at,
          })),
          createdAt: bill.created_at,
        },
      });
    } catch (err) {
      console.error('Get bill error:', err);
      res.status(500).json({ error: 'Failed to get bill split' });
    }
  }
);

// POST /api/billing/:flockId/settle — Mark current user's share as settled
router.post('/:flockId/settle',
  [param('flockId').isInt().withMessage('Invalid flock ID')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;

      // Find the bill
      const billResult = await pool.query(
        'SELECT id FROM bill_splits WHERE flock_id = $1',
        [flockId]
      );
      if (billResult.rows.length === 0) {
        return res.status(404).json({ error: 'No bill found for this flock' });
      }
      const billId = billResult.rows[0].id;

      // Mark as settled
      const updateResult = await pool.query(
        `UPDATE bill_split_shares SET settled = true, settled_at = NOW()
         WHERE bill_id = $1 AND user_id = $2
         RETURNING *`,
        [billId, userId]
      );
      if (updateResult.rows.length === 0) {
        return res.status(404).json({ error: 'No share found for you on this bill' });
      }

      // Emit settled event
      const io = req.app.get('io');
      if (io) {
        io.to(`flock:${flockId}`).emit('share_settled', {
          flockId,
          userId,
          userName: req.user.name,
        });

        // Check if all settled
        const unsettled = await pool.query(
          'SELECT COUNT(*) AS count FROM bill_split_shares WHERE bill_id = $1 AND settled = false',
          [billId]
        );
        if (parseInt(unsettled.rows[0].count) === 0) {
          io.to(`flock:${flockId}`).emit('bill_fully_settled', { flockId });
        }
      }

      res.json({ settled: true });
    } catch (err) {
      console.error('Settle error:', err);
      res.status(500).json({ error: 'Failed to settle share' });
    }
  }
);

// POST /api/billing/:flockId/ghost-commit — Pre-commit estimated share (ghost mode)
router.post('/:flockId/ghost-commit',
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

      // Get budget ceiling and member count
      const flockResult = await pool.query(
        'SELECT budget_ceiling, status FROM flocks WHERE id = $1',
        [flockId]
      );
      if (flockResult.rows.length === 0) {
        return res.status(404).json({ error: 'Flock not found' });
      }

      const ceiling = flockResult.rows[0].budget_ceiling ? parseFloat(flockResult.rows[0].budget_ceiling) : null;
      if (!ceiling) {
        return res.status(400).json({ error: 'No budget ceiling set — cannot estimate share' });
      }

      // Get member count for estimated share
      const memberCountResult = await pool.query(
        "SELECT COUNT(*) AS count FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
        [flockId]
      );
      const memberCount = parseInt(memberCountResult.rows[0].count);
      const estimatedTotal = ceiling * memberCount;
      const estimatedShare = ceiling;

      // Create or find placeholder bill
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        let billId;
        const existingBill = await client.query(
          'SELECT id FROM bill_splits WHERE flock_id = $1',
          [flockId]
        );

        if (existingBill.rows.length > 0) {
          billId = existingBill.rows[0].id;
        } else {
          // Create placeholder bill
          const newBill = await client.query(
            `INSERT INTO bill_splits (flock_id, total_amount, split_type, paid_by, tip_percent)
             VALUES ($1, $2, 'equal', NULL, 0)
             RETURNING id`,
            [flockId, estimatedTotal]
          );
          billId = newBill.rows[0].id;
        }

        // Upsert the user's share with committed=true
        await client.query(
          `INSERT INTO bill_split_shares (bill_id, user_id, amount, committed, settled)
           VALUES ($1, $2, $3, true, false)
           ON CONFLICT (bill_id, user_id) DO UPDATE
           SET committed = true`,
          [billId, userId, estimatedShare]
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Emit socket event
      const io = req.app.get('io');
      if (io) {
        io.to(`flock:${flockId}`).emit('ghost_committed', {
          flockId,
          userId,
          userName: req.user.name,
          estimatedShare,
        });
      }

      res.json({ committed: true, estimatedShare });
    } catch (err) {
      console.error('Ghost commit error:', err);
      res.status(500).json({ error: 'Failed to commit' });
    }
  }
);

// GET /api/billing/:flockId/venmo-link — Generate Venmo deep-link
router.get('/:flockId/venmo-link',
  [param('flockId').isInt().withMessage('Invalid flock ID')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;

      // Get the bill
      const billResult = await pool.query(
        `SELECT bs.id, bs.paid_by, bs.flock_id, f.name AS flock_name
         FROM bill_splits bs
         JOIN flocks f ON f.id = bs.flock_id
         WHERE bs.flock_id = $1`,
        [flockId]
      );
      if (billResult.rows.length === 0) {
        return res.status(404).json({ error: 'No bill found for this flock' });
      }
      const bill = billResult.rows[0];

      // Get the user's share
      const shareResult = await pool.query(
        'SELECT amount FROM bill_split_shares WHERE bill_id = $1 AND user_id = $2',
        [bill.id, userId]
      );
      if (shareResult.rows.length === 0) {
        return res.status(404).json({ error: 'No share found for you' });
      }
      const amount = parseFloat(shareResult.rows[0].amount);

      // Get payer's venmo username
      const payerResult = await pool.query(
        'SELECT name, venmo_username FROM users WHERE id = $1',
        [bill.paid_by]
      );
      if (payerResult.rows.length === 0) {
        return res.status(404).json({ error: 'Payer not found' });
      }

      const payer = payerResult.rows[0];
      if (!payer.venmo_username) {
        return res.json({
          deepLink: null,
          webLink: null,
          amount,
          payTo: payer.name,
          note: `Flock - ${bill.flock_name}`,
          reason: 'no_venmo',
        });
      }

      const note = encodeURIComponent(`Flock - ${bill.flock_name}`);
      const venmoUser = payer.venmo_username;

      res.json({
        deepLink: `venmo://paycharge?txn=pay&recipients=${venmoUser}&amount=${amount}&note=${note}`,
        webLink: `https://venmo.com/${venmoUser}?txn=pay&amount=${amount}&note=${note}`,
        amount,
        payTo: payer.name,
        note: `Flock - ${bill.flock_name}`,
      });
    } catch (err) {
      console.error('Venmo link error:', err);
      res.status(500).json({ error: 'Failed to generate Venmo link' });
    }
  }
);

// GET /api/billing/:flockId/payment-links — Generate all payment options for settle-up
router.get('/:flockId/payment-links',
  [param('flockId').isInt().withMessage('Invalid flock ID')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.flockId);
      const userId = req.user.id;

      // Get the bill
      const billResult = await pool.query(
        `SELECT bs.id, bs.paid_by, bs.flock_id, f.name AS flock_name
         FROM bill_splits bs
         JOIN flocks f ON f.id = bs.flock_id
         WHERE bs.flock_id = $1`,
        [flockId]
      );
      if (billResult.rows.length === 0) {
        return res.status(404).json({ error: 'No bill found for this flock' });
      }
      const bill = billResult.rows[0];

      // Get the user's share amount
      const shareResult = await pool.query(
        'SELECT amount FROM bill_split_shares WHERE bill_id = $1 AND user_id = $2',
        [bill.id, userId]
      );
      if (shareResult.rows.length === 0) {
        return res.status(404).json({ error: 'No share found for you' });
      }
      const amount = parseFloat(shareResult.rows[0].amount);

      // Get payer's payment details
      const payerResult = await pool.query(
        'SELECT name, venmo_username, cashapp_cashtag, zelle_identifier FROM users WHERE id = $1',
        [bill.paid_by]
      );
      if (payerResult.rows.length === 0) {
        return res.status(404).json({ error: 'Payer not found' });
      }

      const payer = payerResult.rows[0];
      const note = `Flock - ${bill.flock_name}`;
      const encodedNote = encodeURIComponent(note);
      const methods = [];

      if (payer.venmo_username) {
        const u = payer.venmo_username;
        methods.push({
          method: 'venmo',
          label: 'Venmo',
          handle: `@${u}`,
          deepLink: `venmo://paycharge?txn=pay&recipients=${u}&amount=${amount}&note=${encodedNote}`,
          webLink: `https://venmo.com/${u}?txn=pay&amount=${amount}&note=${encodedNote}`,
        });
      }

      if (payer.cashapp_cashtag) {
        const tag = payer.cashapp_cashtag;
        methods.push({
          method: 'cashapp',
          label: 'Cash App',
          handle: `$${tag}`,
          deepLink: `cashapp://cash.app/pay/$${tag}?amount=${amount}&note=${encodedNote}`,
          webLink: `https://cash.app/$${tag}/${amount}`,
        });
      }

      if (payer.zelle_identifier) {
        methods.push({
          method: 'zelle',
          label: 'Zelle',
          handle: payer.zelle_identifier,
          deepLink: null,
          webLink: null,
          instructions: `Open your banking app and send $${amount.toFixed(2)} to ${payer.zelle_identifier} via Zelle`,
        });
      }

      res.json({ amount, payTo: payer.name, note, methods });
    } catch (err) {
      console.error('Payment links error:', err);
      res.status(500).json({ error: 'Failed to generate payment links' });
    }
  }
);

module.exports = router;
