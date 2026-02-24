const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

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
    body('name').trim().isLength({ min: 1, max: 255 }).withMessage('Flock name is required'),
    body('venue_name').optional().trim(),
    body('venue_address').optional().trim(),
    body('venue_id').optional().trim(),
    body('event_time').optional().isISO8601().withMessage('Invalid event time'),
    body('invited_user_ids').optional().isArray().withMessage('invited_user_ids must be an array'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { name, venue_name, venue_address, venue_id, event_time, invited_user_ids } = req.body;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Create the flock
        const flockResult = await client.query(
          `INSERT INTO flocks (name, creator_id, venue_name, venue_address, venue_id, event_time)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [name, req.user.id, venue_name || null, venue_address || null, venue_id || null, event_time || null]
        );

        const flock = flockResult.rows[0];

        // Add the creator as an accepted member
        await client.query(
          `INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted')`,
          [flock.id, req.user.id]
        );

        // Invite additional users if provided
        if (invited_user_ids && invited_user_ids.length > 0) {
          const values = invited_user_ids
            .filter((id) => id !== req.user.id)
            .map((userId) => `(${flock.id}, ${parseInt(userId)}, 'accepted')`);

          if (values.length > 0) {
            await client.query(
              `INSERT INTO flock_members (flock_id, user_id, status) VALUES ${values.join(', ')}
               ON CONFLICT (flock_id, user_id) DO NOTHING`
            );
          }
        }

        await client.query('COMMIT');
        res.status(201).json({ flock });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('Create flock error:', err);
      res.status(500).json({ error: 'Failed to create flock' });
    }
  }
);

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
      `SELECT u.id, u.name, u.email, u.profile_image_url, fm.status, fm.joined_at
       FROM flock_members fm
       JOIN users u ON u.id = fm.user_id
       WHERE fm.flock_id = $1
       ORDER BY fm.joined_at ASC`,
      [flockId]
    );

    res.json({
      flock: flockResult.rows[0],
      members: membersResult.rows,
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

      const { name, venue_name, venue_address, venue_id, event_time, status } = req.body;

      const result = await pool.query(
        `UPDATE flocks
         SET name = COALESCE($1, name),
             venue_name = COALESCE($2, venue_name),
             venue_address = COALESCE($3, venue_address),
             venue_id = COALESCE($4, venue_id),
             event_time = COALESCE($5, event_time),
             status = COALESCE($6, status),
             updated_at = NOW()
         WHERE id = $7
         RETURNING *`,
        [name, venue_name, venue_address, venue_id, event_time, status, flockId]
      );

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

    res.json({ member: result.rows[0] });
  } catch (err) {
    console.error('Join flock error:', err);
    res.status(500).json({ error: 'Failed to join flock' });
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

    if (isCreator) {
      // Creator leaving deletes the entire flock (cascade removes members, messages, votes)
      await pool.query('DELETE FROM flocks WHERE id = $1', [flockId]);
      return res.json({ message: 'Left flock', flock_name: flockName, deleted: true });
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

module.exports = router;
