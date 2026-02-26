const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { stripHtml } = require('../utils/sanitize');

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
    body('message_text').trim().customSanitizer(stripHtml).isLength({ min: 1, max: 5000 }).withMessage('Message is required'),
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
          venue_data || null,
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

// GET /api/dm - List all DM conversations (latest message per user)
router.get('/dm', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (other_id) *
       FROM (
         SELECT dm.id, dm.message_text, dm.created_at, dm.read_status, dm.sender_id, dm.receiver_id,
                CASE WHEN dm.sender_id = $1 THEN dm.receiver_id ELSE dm.sender_id END AS other_id,
                u.name AS other_name, u.profile_image_url AS other_image
         FROM direct_messages dm
         JOIN users u ON u.id = CASE WHEN dm.sender_id = $1 THEN dm.receiver_id ELSE dm.sender_id END
         WHERE dm.sender_id = $1 OR dm.receiver_id = $1
       ) sub
       ORDER BY other_id, created_at DESC`,
      [req.user.id]
    );

    // Get unread counts per conversation
    const unreadResult = await pool.query(
      `SELECT sender_id, COUNT(*) AS unread_count
       FROM direct_messages
       WHERE receiver_id = $1 AND read_status = FALSE
       GROUP BY sender_id`,
      [req.user.id]
    );
    const unreadMap = {};
    unreadResult.rows.forEach(r => { unreadMap[r.sender_id] = parseInt(r.unread_count); });

    const conversations = result.rows.map(r => ({
      userId: r.other_id,
      name: r.other_name,
      image: r.other_image,
      lastMessage: r.message_text,
      lastMessageTime: r.created_at,
      lastMessageIsYou: r.sender_id === req.user.id,
      unread: unreadMap[r.other_id] || 0,
    }));

    // Sort by most recent message
    conversations.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

    res.json({ conversations });
  } catch (err) {
    console.error('Get DM conversations error:', err);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

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
      const messages = result.rows;

      // Fetch reactions for all returned DMs
      if (messages.length > 0) {
        const dmIds = messages.map((m) => m.id);
        const reactionsResult = await pool.query(
          `SELECT dr.dm_id, dr.emoji, dr.user_id, u.name AS user_name
           FROM dm_emoji_reactions dr
           JOIN users u ON u.id = dr.user_id
           WHERE dr.dm_id = ANY($1)`,
          [dmIds]
        );
        const reactionsByDm = {};
        for (const r of reactionsResult.rows) {
          if (!reactionsByDm[r.dm_id]) reactionsByDm[r.dm_id] = [];
          reactionsByDm[r.dm_id].push(r);
        }
        for (const msg of messages) {
          msg.reactions = reactionsByDm[msg.id] || [];
        }
      }

      // Fetch reply-to message text for any replies
      const replyIds = messages.filter(m => m.reply_to_id).map(m => m.reply_to_id);
      if (replyIds.length > 0) {
        const replyResult = await pool.query(
          `SELECT dm.id, dm.message_text, u.name AS sender_name
           FROM direct_messages dm JOIN users u ON u.id = dm.sender_id
           WHERE dm.id = ANY($1)`,
          [replyIds]
        );
        const replyMap = {};
        replyResult.rows.forEach(r => { replyMap[r.id] = r; });
        for (const msg of messages) {
          if (msg.reply_to_id && replyMap[msg.reply_to_id]) {
            msg.reply_to = replyMap[msg.reply_to_id];
          }
        }
      }

      // Mark unread messages from the other user as read
      await pool.query(
        `UPDATE direct_messages SET read_status = TRUE
         WHERE sender_id = $1 AND receiver_id = $2 AND read_status = FALSE`,
        [otherUserId, req.user.id]
      );

      res.json({ messages: messages.reverse() });
    } catch (err) {
      console.error('Get DMs error:', err);
      res.status(500).json({ error: 'Failed to get messages' });
    }
  }
);

// POST /api/dm/:userId - Send a DM (supports text, venue_card, image)
router.post('/dm/:userId',
  [
    param('userId').isInt(),
    body('message_text').trim().customSanitizer(stripHtml).isLength({ min: 1, max: 5000 }).withMessage('Message is required'),
    body('message_type').optional().isIn(['text', 'venue_card', 'image']),
    body('venue_data').optional().isObject(),
    body('image_url').optional().isURL(),
    body('reply_to_id').optional().isInt(),
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

      const { message_text, message_type, venue_data, image_url, reply_to_id } = req.body;

      const result = await pool.query(
        `INSERT INTO direct_messages (sender_id, receiver_id, message_text, message_type, venue_data, image_url, reply_to_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [req.user.id, receiverId, message_text, message_type || 'text', venue_data || null, image_url || null, reply_to_id || null]
      );

      const message = result.rows[0];
      message.sender_name = req.user.name;
      message.reactions = [];

      res.status(201).json({ message });
    } catch (err) {
      console.error('Send DM error:', err);
      res.status(500).json({ error: 'Failed to send message' });
    }
  }
);

// Helper: canonical DM pair key (always smaller ID first)
function dmPairKey(a, b) {
  return a < b ? { user1: a, user2: b } : { user1: b, user2: a };
}

// POST /api/dm/messages/:id/react - Add reaction to a DM
router.post('/dm/messages/:id/react',
  [param('id').isInt(), body('emoji').trim().isLength({ min: 1, max: 10 })],
  async (req, res) => {
    try {
      const dmId = parseInt(req.params.id);
      const { emoji } = req.body;

      // Verify DM exists and user is sender or receiver
      const dm = await pool.query('SELECT sender_id, receiver_id FROM direct_messages WHERE id = $1', [dmId]);
      if (dm.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
      if (dm.rows[0].sender_id !== req.user.id && dm.rows[0].receiver_id !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const result = await pool.query(
        `INSERT INTO dm_emoji_reactions (dm_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING *`,
        [dmId, req.user.id, emoji]
      );
      if (result.rows.length === 0) return res.status(400).json({ error: 'Already reacted' });
      res.status(201).json({ reaction: result.rows[0] });
    } catch (err) {
      console.error('DM react error:', err);
      res.status(500).json({ error: 'Failed to add reaction' });
    }
  }
);

// DELETE /api/dm/messages/:id/react/:emoji - Remove DM reaction
router.delete('/dm/messages/:id/react/:emoji', [param('id').isInt()], async (req, res) => {
  try {
    const dmId = parseInt(req.params.id);
    const emoji = decodeURIComponent(req.params.emoji);
    const result = await pool.query(
      'DELETE FROM dm_emoji_reactions WHERE dm_id = $1 AND user_id = $2 AND emoji = $3 RETURNING *',
      [dmId, req.user.id, emoji]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Reaction not found' });
    res.json({ message: 'Reaction removed' });
  } catch (err) {
    console.error('DM remove react error:', err);
    res.status(500).json({ error: 'Failed to remove reaction' });
  }
});

// GET /api/dm/:userId/venue-votes - Get venue votes for a DM conversation
router.get('/dm/:userId/venue-votes', [param('userId').isInt()], async (req, res) => {
  try {
    const { user1, user2 } = dmPairKey(req.user.id, parseInt(req.params.userId));
    const result = await pool.query(
      `SELECT venue_name, venue_id, COUNT(*) AS vote_count, ARRAY_AGG(u.name) AS voters
       FROM dm_venue_votes vv JOIN users u ON u.id = vv.user_id
       WHERE vv.user1_id = $1 AND vv.user2_id = $2
       GROUP BY venue_name, venue_id ORDER BY vote_count DESC`,
      [user1, user2]
    );
    res.json({ votes: result.rows });
  } catch (err) {
    console.error('DM venue votes error:', err);
    res.status(500).json({ error: 'Failed to get votes' });
  }
});

// POST /api/dm/:userId/venue-votes - Vote for a venue in a DM conversation
router.post('/dm/:userId/venue-votes',
  [param('userId').isInt(), body('venue_name').trim().isLength({ min: 1, max: 255 }), body('venue_id').optional().isString()],
  async (req, res) => {
    try {
      const { user1, user2 } = dmPairKey(req.user.id, parseInt(req.params.userId));
      const venue_name = stripHtml(req.body.venue_name);
      // Toggle: if already voted for this venue, unvote; otherwise switch vote
      const existing = await pool.query(
        `SELECT id FROM dm_venue_votes WHERE user1_id = $1 AND user2_id = $2 AND user_id = $3 AND venue_name = $4`,
        [user1, user2, req.user.id, venue_name]
      );
      if (existing.rows.length > 0) {
        await pool.query(`DELETE FROM dm_venue_votes WHERE user1_id = $1 AND user2_id = $2 AND user_id = $3 AND venue_name = $4`, [user1, user2, req.user.id, venue_name]);
      } else {
        await pool.query(`DELETE FROM dm_venue_votes WHERE user1_id = $1 AND user2_id = $2 AND user_id = $3`, [user1, user2, req.user.id]);
        await pool.query(
          `INSERT INTO dm_venue_votes (user1_id, user2_id, user_id, venue_name, venue_id) VALUES ($1, $2, $3, $4, $5)`,
          [user1, user2, req.user.id, venue_name, req.body.venue_id || null]
        );
      }
      // Return updated tallies
      const result = await pool.query(
        `SELECT venue_name, venue_id, COUNT(*) AS vote_count, ARRAY_AGG(u.name) AS voters
         FROM dm_venue_votes vv JOIN users u ON u.id = vv.user_id
         WHERE vv.user1_id = $1 AND vv.user2_id = $2
         GROUP BY venue_name, venue_id ORDER BY vote_count DESC`,
        [user1, user2]
      );
      res.json({ votes: result.rows });
    } catch (err) {
      console.error('DM venue vote error:', err);
      res.status(500).json({ error: 'Failed to vote' });
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

// GET /api/dm/:userId/pinned-venue - Get pinned venue for a DM conversation
router.get('/dm/:userId/pinned-venue', [param('userId').isInt()], async (req, res) => {
  try {
    const { user1, user2 } = dmPairKey(req.user.id, parseInt(req.params.userId));
    const result = await pool.query(
      `SELECT venue_name, venue_address, venue_id, venue_rating, venue_photo_url, pinned_by, u.name AS pinned_by_name
       FROM dm_pinned_venues pv LEFT JOIN users u ON u.id = pv.pinned_by
       WHERE pv.user1_id = $1 AND pv.user2_id = $2`,
      [user1, user2]
    );
    res.json({ venue: result.rows[0] || null });
  } catch (err) {
    console.error('DM pinned venue error:', err);
    res.status(500).json({ error: 'Failed to get pinned venue' });
  }
});

// PUT /api/dm/:userId/pinned-venue - Pin or update a venue for a DM conversation
router.put('/dm/:userId/pinned-venue',
  [param('userId').isInt(), body('venue_name').trim().isLength({ min: 1, max: 255 })],
  async (req, res) => {
    try {
      const otherUserId = parseInt(req.params.userId);
      const { user1, user2 } = dmPairKey(req.user.id, otherUserId);
      const venue_name = stripHtml(req.body.venue_name);
      const venue_address = req.body.venue_address ? stripHtml(req.body.venue_address) : null;
      const venue_id = req.body.venue_id || null;
      const venue_rating = req.body.venue_rating || null;
      const venue_photo_url = req.body.venue_photo_url || null;

      await pool.query(
        `INSERT INTO dm_pinned_venues (user1_id, user2_id, venue_name, venue_address, venue_id, venue_rating, venue_photo_url, pinned_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (user1_id, user2_id) DO UPDATE SET
           venue_name = EXCLUDED.venue_name, venue_address = EXCLUDED.venue_address, venue_id = EXCLUDED.venue_id,
           venue_rating = EXCLUDED.venue_rating, venue_photo_url = EXCLUDED.venue_photo_url,
           pinned_by = EXCLUDED.pinned_by, updated_at = NOW()`,
        [user1, user2, venue_name, venue_address, venue_id, venue_rating, venue_photo_url, req.user.id]
      );

      const venue = { venue_name, venue_address, venue_id, venue_rating, venue_photo_url, pinned_by: req.user.id };
      res.json({ venue });
    } catch (err) {
      console.error('DM pin venue error:', err);
      res.status(500).json({ error: 'Failed to pin venue' });
    }
  }
);

module.exports = router;
