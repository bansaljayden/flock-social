const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

// Helper: check if user is a member of the flock
async function verifyFlockMember(flockId, userId) {
  const result = await pool.query(
    "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
    [flockId, userId]
  );
  return result.rows.length > 0;
}

// GET /api/flocks/:id/messages - Get messages for a flock (paginated)
router.get('/flocks/:id/messages',
  [
    param('id').isInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('before').optional().isInt(), // message ID cursor for pagination
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = req.params.id;
      const limit = parseInt(req.query.limit) || 50;
      const before = req.query.before ? parseInt(req.query.before) : null;

      if (!(await verifyFlockMember(flockId, req.user.id))) {
        return res.status(403).json({ error: 'Not a member of this flock' });
      }

      let messagesQuery;
      let params;

      if (before) {
        messagesQuery = `
          SELECT m.*, u.name AS sender_name, u.profile_image_url AS sender_image
          FROM messages m
          LEFT JOIN users u ON u.id = m.sender_id
          WHERE m.flock_id = $1 AND m.id < $2
          ORDER BY m.created_at DESC
          LIMIT $3`;
        params = [flockId, before, limit];
      } else {
        messagesQuery = `
          SELECT m.*, u.name AS sender_name, u.profile_image_url AS sender_image
          FROM messages m
          LEFT JOIN users u ON u.id = m.sender_id
          WHERE m.flock_id = $1
          ORDER BY m.created_at DESC
          LIMIT $2`;
        params = [flockId, limit];
      }

      const messagesResult = await pool.query(messagesQuery, params);
      const messages = messagesResult.rows;

      // Fetch reactions for all returned messages in one query
      if (messages.length > 0) {
        const messageIds = messages.map((m) => m.id);
        const reactionsResult = await pool.query(
          `SELECT er.message_id, er.emoji, er.user_id, u.name AS user_name
           FROM emoji_reactions er
           JOIN users u ON u.id = er.user_id
           WHERE er.message_id = ANY($1)`,
          [messageIds]
        );

        // Group reactions by message ID
        const reactionsByMessage = {};
        for (const r of reactionsResult.rows) {
          if (!reactionsByMessage[r.message_id]) {
            reactionsByMessage[r.message_id] = [];
          }
          reactionsByMessage[r.message_id].push(r);
        }

        for (const msg of messages) {
          msg.reactions = reactionsByMessage[msg.id] || [];
        }
      }

      // Return in chronological order
      res.json({ messages: messages.reverse() });
    } catch (err) {
      console.error('Get messages error:', err);
      res.status(500).json({ error: 'Failed to get messages' });
    }
  }
);

// POST /api/flocks/:id/messages - Send a message to a flock
router.post('/flocks/:id/messages',
  [
    param('id').isInt(),
    body('message_text').trim().isLength({ min: 1, max: 5000 }).withMessage('Message is required'),
    body('message_type').optional().isIn(['text', 'venue_card', 'image']),
    body('venue_data').optional().isObject(),
    body('image_url').optional().isURL(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = req.params.id;

      if (!(await verifyFlockMember(flockId, req.user.id))) {
        return res.status(403).json({ error: 'Not a member of this flock' });
      }

      const { message_text, message_type, venue_data, image_url } = req.body;

      const result = await pool.query(
        `INSERT INTO messages (flock_id, sender_id, message_text, message_type, venue_data, image_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          flockId,
          req.user.id,
          message_text,
          message_type || 'text',
          venue_data ? JSON.stringify(venue_data) : null,
          image_url || null,
        ]
      );

      const message = result.rows[0];
      message.sender_name = req.user.name;
      message.reactions = [];

      res.status(201).json({ message });
    } catch (err) {
      console.error('Send message error:', err);
      res.status(500).json({ error: 'Failed to send message' });
    }
  }
);

// POST /api/messages/:id/react - Add emoji reaction to a message
router.post('/messages/:id/react',
  [
    param('id').isInt(),
    body('emoji').trim().isLength({ min: 1, max: 10 }).withMessage('Emoji is required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const messageId = req.params.id;
      const { emoji } = req.body;

      // Verify the message exists and user is in that flock
      const msgResult = await pool.query('SELECT flock_id FROM messages WHERE id = $1', [messageId]);
      if (msgResult.rows.length === 0) {
        return res.status(404).json({ error: 'Message not found' });
      }

      const flockId = msgResult.rows[0].flock_id;
      if (!(await verifyFlockMember(flockId, req.user.id))) {
        return res.status(403).json({ error: 'Not a member of this flock' });
      }

      const result = await pool.query(
        `INSERT INTO emoji_reactions (message_id, user_id, emoji)
         VALUES ($1, $2, $3)
         ON CONFLICT (message_id, user_id, emoji) DO NOTHING
         RETURNING *`,
        [messageId, req.user.id, emoji]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({ error: 'Already reacted with this emoji' });
      }

      res.status(201).json({ reaction: result.rows[0] });
    } catch (err) {
      console.error('Add reaction error:', err);
      res.status(500).json({ error: 'Failed to add reaction' });
    }
  }
);

// DELETE /api/messages/:id/react/:emoji - Remove emoji reaction
router.delete('/messages/:id/react/:emoji',
  [param('id').isInt()],
  async (req, res) => {
    try {
      const messageId = req.params.id;
      const emoji = decodeURIComponent(req.params.emoji);

      const result = await pool.query(
        'DELETE FROM emoji_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3 RETURNING *',
        [messageId, req.user.id, emoji]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Reaction not found' });
      }

      res.json({ message: 'Reaction removed' });
    } catch (err) {
      console.error('Remove reaction error:', err);
      res.status(500).json({ error: 'Failed to remove reaction' });
    }
  }
);

// --- Direct Messages ---

// GET /api/dm/:userId - Get DM conversation with a user (paginated)
router.get('/dm/:userId',
  [
    param('userId').isInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('before').optional().isInt(),
  ],
  async (req, res) => {
    try {
      const otherUserId = parseInt(req.params.userId);
      const limit = parseInt(req.query.limit) || 50;
      const before = req.query.before ? parseInt(req.query.before) : null;

      let dmQuery;
      let params;

      if (before) {
        dmQuery = `
          SELECT dm.*, u.name AS sender_name, u.profile_image_url AS sender_image
          FROM direct_messages dm
          JOIN users u ON u.id = dm.sender_id
          WHERE ((dm.sender_id = $1 AND dm.receiver_id = $2)
              OR (dm.sender_id = $2 AND dm.receiver_id = $1))
            AND dm.id < $3
          ORDER BY dm.created_at DESC
          LIMIT $4`;
        params = [req.user.id, otherUserId, before, limit];
      } else {
        dmQuery = `
          SELECT dm.*, u.name AS sender_name, u.profile_image_url AS sender_image
          FROM direct_messages dm
          JOIN users u ON u.id = dm.sender_id
          WHERE (dm.sender_id = $1 AND dm.receiver_id = $2)
             OR (dm.sender_id = $2 AND dm.receiver_id = $1)
          ORDER BY dm.created_at DESC
          LIMIT $3`;
        params = [req.user.id, otherUserId, limit];
      }

      const result = await pool.query(dmQuery, params);

      // Mark unread messages from the other user as read
      await pool.query(
        `UPDATE direct_messages SET read_status = TRUE
         WHERE sender_id = $1 AND receiver_id = $2 AND read_status = FALSE`,
        [otherUserId, req.user.id]
      );

      res.json({ messages: result.rows.reverse() });
    } catch (err) {
      console.error('Get DMs error:', err);
      res.status(500).json({ error: 'Failed to get messages' });
    }
  }
);

// POST /api/dm/:userId - Send a DM
router.post('/dm/:userId',
  [
    param('userId').isInt(),
    body('message_text').trim().isLength({ min: 1, max: 5000 }).withMessage('Message is required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const receiverId = parseInt(req.params.userId);
      if (receiverId === req.user.id) {
        return res.status(400).json({ error: 'Cannot send a DM to yourself' });
      }

      // Verify receiver exists
      const receiver = await pool.query('SELECT id FROM users WHERE id = $1', [receiverId]);
      if (receiver.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const result = await pool.query(
        `INSERT INTO direct_messages (sender_id, receiver_id, message_text)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [req.user.id, receiverId, req.body.message_text]
      );

      const message = result.rows[0];
      message.sender_name = req.user.name;

      res.status(201).json({ message });
    } catch (err) {
      console.error('Send DM error:', err);
      res.status(500).json({ error: 'Failed to send message' });
    }
  }
);

// PUT /api/dm/:messageId/read - Mark a DM as read
router.put('/dm/:messageId/read', param('messageId').isInt(), async (req, res) => {
  try {
    const messageId = parseInt(req.params.messageId);

    const result = await pool.query(
      `UPDATE direct_messages SET read_status = TRUE
       WHERE id = $1 AND receiver_id = $2
       RETURNING *`,
      [messageId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ message: result.rows[0] });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Failed to mark message as read' });
  }
});

module.exports = router;
