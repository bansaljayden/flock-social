const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { stripHtml } = require('../utils/sanitize');
const { rejectIfProfane, moderateImage, imageRejectionMessage } = require('../utils/moderation');
const { sanitizeVenueData, safeVenuePhotoUrl } = require('../utils/venuePayload');
const VENUE_REJECTED_MESSAGE = "That venue card couldn't be shared.";
const { isBlockedBetween, getInvisibleUserIds } = require('../utils/blocks');
const { hasDmRelationship, NOT_CONNECTED_MESSAGE } = require('../utils/relationships');
const { emitToFlockExcludingBlocked } = require('../sockets/handlers');
const { pushIfOfflineDebounced } = require('../services/pushHelper');

const router = express.Router();

router.use(authenticate);

// SERIAL message/user ids are INT4; an id past this 500s on the query instead of
// 400ing (same class as routesReliability.test.js; friends.js bounds user ids the
// same way). Every :id/:userId/:messageId param and the int cursors below are
// bounded to it so a too-large id is rejected before any query runs.
const INT4_MAX = 2147483647;

// Several routes below declared param()/body() chains and then never read the
// result, which made those chains decorative: `/api/dm/messages/abc/react`
// reached Postgres as NaN and came back a 500, and an unvalidated `emoji`
// (VARCHAR(10) in the schema) turned any long string into a 500 as well. This
// is the single gate they all call now.
function rejectInvalid(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ error: errors.array()[0].msg || 'Invalid request' });
  return true;
}

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
    param('id').isInt({ min: 1, max: INT4_MAX }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('before').optional().isInt({ min: 1, max: INT4_MAX }), // message ID cursor for pagination
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

      // Moderator-hidden messages (A6 takedown) and messages from users blocked
      // in either direction are filtered IN SQL, before LIMIT — filtering after
      // pagination could return an empty page (with no cursor to page past)
      // while older visible messages still existed.
      const invisible = new Set(await getInvisibleUserIds(req.user.id));
      const invisibleArr = [...invisible];

      let messagesQuery;
      let params;

      if (before) {
        messagesQuery = `
          -- Giant legacy base64 avatars would be repeated on every one of up to 100 rows; drop oversized ones instead of amplifying them (REVIEW-ROUND5)
          SELECT m.*, u.name AS sender_name, CASE WHEN LENGTH(u.profile_image_url) > 12000 THEN NULL ELSE u.profile_image_url END AS sender_image
          FROM messages m
          LEFT JOIN users u ON u.id = m.sender_id
          WHERE m.flock_id = $1 AND m.id < $2
            AND m.is_hidden IS NOT TRUE
            AND NOT (m.sender_id = ANY($4::int[]))
          ORDER BY m.created_at DESC
          LIMIT $3`;
        params = [flockId, before, limit, invisibleArr];
      } else {
        messagesQuery = `
          -- Giant legacy base64 avatars would be repeated on every one of up to 100 rows; drop oversized ones instead of amplifying them (REVIEW-ROUND5)
          SELECT m.*, u.name AS sender_name, CASE WHEN LENGTH(u.profile_image_url) > 12000 THEN NULL ELSE u.profile_image_url END AS sender_image
          FROM messages m
          LEFT JOIN users u ON u.id = m.sender_id
          WHERE m.flock_id = $1
            AND m.is_hidden IS NOT TRUE
            AND NOT (m.sender_id = ANY($3::int[]))
          ORDER BY m.created_at DESC
          LIMIT $2`;
        params = [flockId, limit, invisibleArr];
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

        // Group reactions by message ID — a blocked user's reaction on a third
        // member's message would otherwise still expose their name/activity.
        const reactionsByMessage = {};
        for (const r of reactionsResult.rows) {
          if (invisible.has(r.user_id)) continue;
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
    param('id').isInt({ min: 1, max: INT4_MAX }),
    body('message_text').trim().customSanitizer(stripHtml).isLength({ min: 1, max: 5000 }).withMessage('Message is required'),
    body('message_type').optional().isIn(['text', 'venue_card', 'image']),
    body('venue_data').optional().isObject(),
    body('image_url').optional().matches(/^data:image\/(png|jpe?g|gif|webp);base64,/),
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

      // UGC text filter (Apple 1.2) — reject objectionable content before storing.
      if (rejectIfProfane(res, message_text)) return;

      // Round 8: venue_data was stored verbatim — nested name/photo_url dodged
      // the text screen and rendered sender-controlled <img> URLs (tracking).
      const venueCheck = sanitizeVenueData(venue_data);
      if (!venueCheck.ok) {
        return res.status(400).json({ error: VENUE_REJECTED_MESSAGE });
      }

      // Image moderation must hold on the REST transport too — the socket-only
      // check left this endpoint delivering unmoderated (and trackable) URLs.
      //
      // Round 18: the `(png|jpe?g|gif|webp)` allowlist above is NOT the
      // animation gate and must not be mistaken for one — an APNG arrives as
      // `image/png` and an animated WebP as `image/webp`, so tightening this
      // regex would close nothing. moderateImage inspects the actual bytes and
      // refuses multi-frame files there, for every upload path at once.
      if (image_url) {
        const verdict = await moderateImage(image_url);
        if (!verdict.allowed) {
          return res.status(400).json({ error: imageRejectionMessage(verdict), moderation: verdict.reason });
        }
      }

      const result = await pool.query(
        `INSERT INTO messages (flock_id, sender_id, message_text, message_type, venue_data, image_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          flockId,
          req.user.id,
          message_text,
          message_type || 'text',
          venueCheck.data,
          image_url || null,
        ]
      );

      const message = result.rows[0];
      message.sender_name = req.user.name;
      message.reactions = [];

      res.status(201).json({ message });

      // Offline push, mirroring the socket send_message path in
      // sockets/handlers.js. The socket client falls back to THIS endpoint when
      // its connection is down — which is exactly when the recipient is likely
      // offline and a push matters most — so a REST send has to notify offline
      // members just like the socket send does. Same debounce key shape
      // ({ type: 'flock_message', flockId }) so a message that happens to go out
      // on both transports collapses into one notification rather than two.
      // Runs AFTER the response and is fully self-contained, so a Firebase
      // hiccup can never turn a stored message into a 500.
      try {
        const io = req.app.get('io');
        if (io) {
          const flockInfo = await pool.query('SELECT name FROM flocks WHERE id = $1', [flockId]);
          const flockName = flockInfo.rows[0]?.name || 'Flock';
          const members = await pool.query(
            "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2",
            [flockId, req.user.id]
          );
          const invisible = new Set(await getInvisibleUserIds(req.user.id));
          const preview = (message_text || '').substring(0, 100);
          await Promise.allSettled(
            members.rows
              .filter((m) => !invisible.has(m.user_id))
              .map((m) => pushIfOfflineDebounced(io, m.user_id,
                `${req.user.name} in ${flockName}`,
                preview,
                { type: 'flock_message', flockId: String(flockId) }
              ))
          );
        }
      } catch (pushErr) {
        console.error('Flock message push error:', pushErr.message);
      }
    } catch (err) {
      console.error('Send message error:', err);
      res.status(500).json({ error: 'Failed to send message' });
    }
  }
);

// POST /api/messages/:id/react - Add emoji reaction to a message
router.post('/messages/:id/react',
  [
    param('id').isInt({ min: 1, max: INT4_MAX }),
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

      // Verify the message exists and user is in that flock.
      // A6 takedown: a hidden message is gone from every read path, so it must
      // not still be reactable — otherwise a taken-down message keeps
      // generating flock_reaction_added broadcasts naming the reactor against
      // content nobody is allowed to see. Removing a reaction stays possible
      // (see the DELETE twin): cleanup after a takedown is not interaction.
      const msgResult = await pool.query(
        'SELECT flock_id FROM messages WHERE id = $1 AND is_hidden IS NOT TRUE',
        [messageId]
      );
      if (msgResult.rows.length === 0) {
        return res.status(404).json({ error: 'Message not found' });
      }

      const flockId = msgResult.rows[0].flock_id;
      if (!(await verifyFlockMember(flockId, req.user.id))) {
        // 404, not 403: message ids are sequential, and a 403 here would
        // confirm "message 91824 exists, in a flock you cannot see" for every
        // id an outsider cared to try. A non-member gets the same answer as
        // for an id that was never issued.
        return res.status(404).json({ error: 'Message not found' });
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

      // Notify flock members in real-time — block-aware fan-out, a room
      // broadcast would hand the reactor's identity to blocked members.
      const io = req.app.get('io');
      if (io) {
        emitToFlockExcludingBlocked(io, flockId, req.user.id, 'flock_reaction_added', {
          messageId: parseInt(messageId),
          emoji,
          userId: req.user.id,
          userName: req.user.name,
        }).catch(() => {});
        io.to(`user:${req.user.id}`).emit('flock_reaction_added', {
          messageId: parseInt(messageId),
          emoji,
          userId: req.user.id,
          userName: req.user.name,
        });
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
  [param('id').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid message ID')],
  async (req, res) => {
    try {
      if (rejectInvalid(req, res)) return;
      const messageId = req.params.id;
      // Bounded before it reaches a VARCHAR(10) column (schema 000_bootstrap).
      const emoji = decodeURIComponent(req.params.emoji).slice(0, 10);

      // Get flock_id for socket notification
      const msgResult = await pool.query('SELECT flock_id FROM messages WHERE id = $1', [messageId]);
      const flockId = msgResult.rows[0]?.flock_id;

      const result = await pool.query(
        'DELETE FROM emoji_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3 RETURNING *',
        [messageId, req.user.id, emoji]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Reaction not found' });
      }

      // Notify flock members — block-aware fan-out (see the add path).
      if (flockId) {
        const io = req.app.get('io');
        if (io) {
          emitToFlockExcludingBlocked(io, flockId, req.user.id, 'flock_reaction_removed', {
            messageId: parseInt(messageId),
            emoji,
            userId: req.user.id,
          }).catch(() => {});
          io.to(`user:${req.user.id}`).emit('flock_reaction_removed', {
            messageId: parseInt(messageId),
            emoji,
            userId: req.user.id,
          });
        }
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
         WHERE (dm.sender_id = $1 OR dm.receiver_id = $1)
           AND COALESCE(dm.is_hidden, false) = false
       ) sub
       ORDER BY other_id, created_at DESC`,
      [req.user.id]
    );

    // Get unread counts per conversation. Moderator-hidden DMs are excluded —
    // no projection will ever display them, so counting them left a ghost
    // unread badge that could never be cleared.
    const unreadResult = await pool.query(
      `SELECT sender_id, COUNT(*) AS unread_count
       FROM direct_messages
       WHERE receiver_id = $1 AND read_status = FALSE
         AND COALESCE(is_hidden, false) = false
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

    // Hide conversations with users blocked in either direction (mutual invisibility).
    const invisible = new Set(await getInvisibleUserIds(req.user.id));
    const visible = conversations.filter((c) => !invisible.has(c.userId));

    // Sort by most recent message
    visible.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

    res.json({ conversations: visible });
  } catch (err) {
    console.error('Get DM conversations error:', err);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

// GET /api/dm/:userId - Get DM conversation with a user (paginated)
router.get('/dm/:userId',
  [
    param('userId').isInt({ min: 1, max: INT4_MAX }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('before').optional().isInt({ min: 1, max: INT4_MAX }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }
      const otherUserId = parseInt(req.params.userId);
      const limit = Math.min(parseInt(req.query.limit) || 50, 100);
      const before = req.query.before ? parseInt(req.query.before) : null;

      // Mutual block: hide the conversation entirely if either side blocked the other.
      if (await isBlockedBetween(req.user.id, otherUserId)) {
        return res.json({ messages: [], blocked: true });
      }

      let dmQuery;
      let params;

      if (before) {
        dmQuery = `
          -- Giant legacy base64 avatars would be repeated on every one of up to 100 rows; drop oversized ones instead of amplifying them (REVIEW-ROUND5)
          SELECT dm.*, u.name AS sender_name, CASE WHEN LENGTH(u.profile_image_url) > 12000 THEN NULL ELSE u.profile_image_url END AS sender_image
          FROM direct_messages dm
          JOIN users u ON u.id = dm.sender_id
          WHERE ((dm.sender_id = $1 AND dm.receiver_id = $2)
              OR (dm.sender_id = $2 AND dm.receiver_id = $1))
            AND COALESCE(dm.is_hidden, false) = false
            AND dm.id < $3
          ORDER BY dm.created_at DESC
          LIMIT $4`;
        params = [req.user.id, otherUserId, before, limit];
      } else {
        dmQuery = `
          -- Giant legacy base64 avatars would be repeated on every one of up to 100 rows; drop oversized ones instead of amplifying them (REVIEW-ROUND5)
          SELECT dm.*, u.name AS sender_name, CASE WHEN LENGTH(u.profile_image_url) > 12000 THEN NULL ELSE u.profile_image_url END AS sender_image
          FROM direct_messages dm
          JOIN users u ON u.id = dm.sender_id
          WHERE ((dm.sender_id = $1 AND dm.receiver_id = $2)
             OR (dm.sender_id = $2 AND dm.receiver_id = $1))
            AND COALESCE(dm.is_hidden, false) = false
          ORDER BY dm.created_at DESC
          LIMIT $3`;
        params = [req.user.id, otherUserId, limit];
      }

      const result = await pool.query(dmQuery, params);
      // Exclude moderator-hidden DMs (A6 takedown).
      const messages = result.rows.filter((m) => !m.is_hidden);

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

      // Fetch reply-to message text for any replies.
      // SECURITY: scoped to this conversation's pair — a stored reply_to_id
      // pointing at another conversation must never hydrate its text here.
      const replyIds = messages.filter(m => m.reply_to_id).map(m => m.reply_to_id);
      if (replyIds.length > 0) {
        const replyResult = await pool.query(
          `SELECT dm.id, dm.message_text, u.name AS sender_name
           FROM direct_messages dm JOIN users u ON u.id = dm.sender_id
           WHERE dm.id = ANY($1)
             AND COALESCE(dm.is_hidden, false) = false
             AND ((dm.sender_id = $2 AND dm.receiver_id = $3) OR (dm.sender_id = $3 AND dm.receiver_id = $2))`,
          [replyIds, req.user.id, otherUserId]
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
    param('userId').isInt({ min: 1, max: INT4_MAX }),
    body('message_text').trim().customSanitizer(stripHtml).isLength({ min: 1, max: 5000 }).withMessage('Message is required'),
    body('message_type').optional().isIn(['text', 'venue_card', 'image']),
    body('venue_data').optional().isObject(),
    // data: URLs only — a sender-controlled https image is a tracking pixel
    // aimed at every recipient (round 7); the socket path already refuses them.
    body('image_url').optional().matches(/^data:image\/(png|jpe?g|gif|webp);base64,/),
    body('reply_to_id').optional().isInt({ min: 1, max: INT4_MAX }),
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

      // Mutual block: if either user blocked the other, no DMs in either direction.
      if (await isBlockedBetween(req.user.id, receiverId)) {
        return res.status(403).json({ error: 'You can no longer message this user.' });
      }

      // Audit 2026-08-14: this route used to answer "404 User not found" for an
      // id nobody holds and "201 Created" for one somebody does, with no
      // relationship required either way — a directory walk that dropped a
      // message in a stranger's inbox on every hit. The socket transport has
      // required a real relationship for persisting DM writes since round 5;
      // the REST twin now does too, and the ONE refusal covers both "no such
      // user" and "not connected", so neither can be read off the other.
      if (!(await hasDmRelationship(req.user.id, receiverId))) {
        return res.status(403).json({ error: NOT_CONNECTED_MESSAGE });
      }

      const { message_text, message_type, venue_data, image_url, reply_to_id } = req.body;

      // UGC text filter (Apple 1.2) — reject objectionable content before storing.
      if (rejectIfProfane(res, message_text)) return;

      // Same venue-card sanitizing as flock messages (round 8).
      const venueCheck = sanitizeVenueData(venue_data);
      if (!venueCheck.ok) {
        return res.status(400).json({ error: VENUE_REJECTED_MESSAGE });
      }

      // Image moderation on the REST transport too (same as flock messages),
      // including the byte-level multi-frame gate — see the note there.
      if (image_url) {
        const verdict = await moderateImage(image_url);
        if (!verdict.allowed) {
          return res.status(400).json({ error: imageRejectionMessage(verdict), moderation: verdict.reason });
        }
      }

      // SECURITY: a reply may only reference a message from THIS conversation
      // (same invariant as the socket path — see sockets/handlers.js).
      //
      // The socket twin also refuses a HIDDEN target; this one did not, so a
      // moderator-hidden DM could be quoted back into the thread by replying to
      // it over REST — the takedown undone through the transport that forgot to
      // check. Kept identical to the socket predicate so the two transports
      // cannot drift again.
      let safeReplyId = null;
      if (reply_to_id) {
        const replyCheck = await pool.query(
          `SELECT id FROM direct_messages
           WHERE id = $1
             AND COALESCE(is_hidden, false) = false
             AND ((sender_id = $2 AND receiver_id = $3) OR (sender_id = $3 AND receiver_id = $2))`,
          [reply_to_id, req.user.id, receiverId]
        );
        if (replyCheck.rows.length === 0) {
          return res.status(400).json({ error: 'Invalid reply target' });
        }
        safeReplyId = reply_to_id;
      }

      const result = await pool.query(
        `INSERT INTO direct_messages (sender_id, receiver_id, message_text, message_type, venue_data, image_url, reply_to_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [req.user.id, receiverId, message_text, message_type || 'text', venueCheck.data, image_url || null, safeReplyId]
      );

      const message = result.rows[0];
      message.sender_name = req.user.name;
      message.reactions = [];

      res.status(201).json({ message });

      // Offline push, mirroring the socket send_dm path in sockets/handlers.js.
      // This route is the socket client's fallback when disconnected, so without
      // this an offline recipient of a fallback-delivered DM was never notified.
      // Same debounce key shape ({ type: 'dm_message', senderId }) as the socket
      // path so the two transports never double-notify. The block gate reads
      // senderId; a mutual block was already refused above. Post-response and
      // self-contained so Firebase cannot turn a stored DM into a 500.
      try {
        const io = req.app.get('io');
        if (io) {
          const preview = (message_text || '').substring(0, 100);
          await pushIfOfflineDebounced(io, receiverId,
            req.user.name,
            preview,
            { type: 'dm_message', senderId: String(req.user.id) }
          );
        }
      } catch (pushErr) {
        console.error('DM push error:', pushErr.message);
      }
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
  [
    param('id').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid message ID'),
    body('emoji').isString().withMessage('Emoji is required')
      .trim().isLength({ min: 1, max: 10 }).withMessage('Emoji is required'),
  ],
  async (req, res) => {
    try {
      if (rejectInvalid(req, res)) return;
      const dmId = parseInt(req.params.id);
      const { emoji } = req.body;

      // Verify DM exists and user is sender or receiver. Hidden DMs are not
      // reactable, for the same reason as flock messages above: a takedown ends
      // the message, and reacting is the one interaction left that could still
      // reach across it.
      const dm = await pool.query(
        `SELECT sender_id, receiver_id FROM direct_messages
         WHERE id = $1 AND COALESCE(is_hidden, false) = false`,
        [dmId]
      );
      if (dm.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
      if (dm.rows[0].sender_id !== req.user.id && dm.rows[0].receiver_id !== req.user.id) {
        return res.status(403).json({ error: 'Not authorized' });
      }
      const counterpart = dm.rows[0].sender_id === req.user.id ? dm.rows[0].receiver_id : dm.rows[0].sender_id;
      if (await isBlockedBetween(req.user.id, counterpart)) {
        return res.status(403).json({ error: 'You can no longer interact with this user.' });
      }

      const result = await pool.query(
        `INSERT INTO dm_emoji_reactions (dm_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT (dm_id, user_id, emoji) DO NOTHING RETURNING *`,
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
router.delete('/dm/messages/:id/react/:emoji', [param('id').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid message ID')], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const dmId = parseInt(req.params.id);
    const emoji = decodeURIComponent(req.params.emoji).slice(0, 10);
    // Blocks end ALL interaction with the shared conversation, removals included.
    const dm = await pool.query('SELECT sender_id, receiver_id FROM direct_messages WHERE id = $1', [dmId]);
    if (dm.rows.length > 0) {
      const counterpart = dm.rows[0].sender_id === req.user.id ? dm.rows[0].receiver_id : dm.rows[0].sender_id;
      if (await isBlockedBetween(req.user.id, counterpart)) {
        return res.status(403).json({ error: 'You can no longer interact with this user.' });
      }
    }
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
router.get('/dm/:userId/venue-votes', [param('userId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid user ID')], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    // Mutual invisibility covers shared DM metadata reads, not just messages.
    if (await isBlockedBetween(req.user.id, parseInt(req.params.userId))) {
      return res.status(403).json({ error: 'You can no longer interact with this user.' });
    }
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
  [param('userId').isInt({ min: 1, max: INT4_MAX }), body('venue_name').trim().isLength({ min: 1, max: 255 }), body('venue_id').optional().isString()],
  async (req, res) => {
    try {
      // The validator chain above was decorative: without validationResult the
      // length/type rules never rejected anything, so an unbounded venue_name
      // reached the INSERT (round 9 follow-up).
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const otherUserId = parseInt(req.params.userId);
      const { user1, user2 } = dmPairKey(req.user.id, otherUserId);
      if (await isBlockedBetween(req.user.id, otherUserId)) {
        return res.status(403).json({ error: 'You can no longer interact with this user.' });
      }
      // Round 9 checked the counterpart existed; that turned the route into an
      // existence oracle (404 vs 200) and still let anyone write DM metadata
      // into a conversation they are not part of. dm_venue_votes is keyed on
      // the ordered pair, which is why the socket transport requires a real
      // relationship here — this is the REST twin of that gate, with one
      // refusal covering both "no such user" and "not connected".
      if (!(await hasDmRelationship(req.user.id, otherUserId))) {
        return res.status(403).json({ error: NOT_CONNECTED_MESSAGE });
      }
      const venue_name = stripHtml(req.body.venue_name);
      // Venue names ride into the other person's UI (round 9 follow-up).
      if (rejectIfProfane(res, venue_name)) return;
      // dm_venue_votes.venue_id is VARCHAR(255) and the validator only checks
      // that it is a string, so an over-long id used to reach the INSERT and
      // come back as a swallowed 500 — and now would do it with a transaction
      // and an advisory lock held. Clamped, exactly as the socket twin does.
      const venue_id = typeof req.body.venue_id === 'string' ? req.body.venue_id.slice(0, 255) : null;
      // Toggle: if already voted for this venue, unvote; otherwise switch vote.
      //
      // This was read, DELETE, INSERT as three separate autocommit statements —
      // the exact race sockets/handlers.js fixed in dm_vote_venue. Two taps in
      // flight both saw "no existing vote", both deleted, and both inserted:
      // the UNIQUE key is (pair, user, venue_name), so two DIFFERENT venue names
      // both survive and one person holds two live votes in a two-person
      // conversation, while two taps on the SAME venue race the unique
      // constraint into a swallowed 500.
      //
      // Same implementation as the socket twin, and deliberately the SAME LOCK
      // KEY EXPRESSION ('dmvote:' || u1 || ':' || u2 || ':' || voter) so the REST
      // and socket transports serialize against EACH OTHER, not just against
      // themselves — a tap in the app and a tap on the web client are the same
      // toggle and must queue behind one another.
      const voteClient = await pool.connect();
      try {
        await voteClient.query('BEGIN');
        await voteClient.query(
          "SELECT pg_advisory_xact_lock(hashtext('dmvote:' || $1::text || ':' || $2::text || ':' || $3::text))",
          [String(user1), String(user2), String(req.user.id)]
        );
        const existing = await voteClient.query(
          `SELECT id FROM dm_venue_votes WHERE user1_id = $1 AND user2_id = $2 AND user_id = $3 AND venue_name = $4`,
          [user1, user2, req.user.id, venue_name]
        );
        // Either way the voter ends up with AT MOST one row in this pair: the
        // unconditional delete makes toggle-off and switch-vote the same
        // statement, so no path can leave two behind.
        await voteClient.query(
          `DELETE FROM dm_venue_votes WHERE user1_id = $1 AND user2_id = $2 AND user_id = $3`,
          [user1, user2, req.user.id]
        );
        if (existing.rows.length === 0) {
          await voteClient.query(
            `INSERT INTO dm_venue_votes (user1_id, user2_id, user_id, venue_name, venue_id) VALUES ($1, $2, $3, $4, $5)`,
            [user1, user2, req.user.id, venue_name, venue_id]
          );
        }
        await voteClient.query('COMMIT');
      } catch (txErr) {
        await voteClient.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        voteClient.release();
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
router.put('/dm/:messageId/read', param('messageId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid message ID'), async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const messageId = parseInt(req.params.messageId);

    // A6 takedown: every OTHER read path on this table filters
    // `COALESCE(is_hidden, false) = false` (the thread reads above, the socket
    // twin, the reply lookup). This one did not, and `RETURNING *` handed back
    // message_text, image_url and venue_data — so the recipient of a
    // moderator-hidden DM could re-read the taken-down content verbatim,
    // forever, using an id their client already held. A takedown that any
    // recipient can undo with a PUT is not a takedown.
    //
    // Both halves of the fix, because either alone leaves a gap: the predicate
    // stops hidden rows being touched at all, and the narrowed RETURNING means
    // a route whose entire job is "flip a boolean" can never be a content read
    // again. No caller reads anything but the ack (frontend has no caller at
    // all today), so nothing client-side depends on the wide row.
    const result = await pool.query(
      `UPDATE direct_messages SET read_status = TRUE
       WHERE id = $1 AND receiver_id = $2
         AND COALESCE(is_hidden, false) = false
       RETURNING id, read_status`,
      [messageId, req.user.id]
    );

    if (result.rows.length === 0) {
      // Same answer for "no such message", "not yours" and "taken down" — the
      // status code must not tell a holder of the id which one it was.
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ message: result.rows[0] });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Failed to mark message as read' });
  }
});

// GET /api/dm/:userId/pinned-venue - Get pinned venue for a DM conversation
router.get('/dm/:userId/pinned-venue', [param('userId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid user ID')], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    // Mutual invisibility covers shared DM metadata reads, not just messages.
    if (await isBlockedBetween(req.user.id, parseInt(req.params.userId))) {
      return res.status(403).json({ error: 'You can no longer interact with this user.' });
    }
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
  [
    param('userId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid user ID'),
    body('venue_name').isString().withMessage('Venue name is required')
      .trim().isLength({ min: 1, max: 255 }).withMessage('Venue name is required'),
  ],
  async (req, res) => {
    try {
      // Unenforced before: a body with no venue_name reached
      // `stripHtml(undefined).slice(...)` and threw a TypeError out of the
      // handler, and a non-string reached the same call.
      if (rejectInvalid(req, res)) return;
      const otherUserId = parseInt(req.params.userId);
      if (await isBlockedBetween(req.user.id, otherUserId)) {
        return res.status(403).json({ error: 'You can no longer interact with this user.' });
      }
      // Same gate as the venue-vote route. dm_pinned_venues is an UPSERT on the
      // ordered pair, so an outsider writing here overwrites what those two
      // people pinned — the exact case sockets/handlers.js closed on its side.
      if (!(await hasDmRelationship(req.user.id, otherUserId))) {
        return res.status(403).json({ error: NOT_CONNECTED_MESSAGE });
      }
      const { user1, user2 } = dmPairKey(req.user.id, otherUserId);
      const venue_name = stripHtml(req.body.venue_name).slice(0, 255);
      const venue_address = req.body.venue_address ? stripHtml(String(req.body.venue_address)).slice(0, 512) : null;
      // Same screen + photo-proxy-only rule as venue cards (round 8).
      if (rejectIfProfane(res, venue_name)) return;
      if (venue_address && rejectIfProfane(res, venue_address)) return;
      const venue_id = typeof req.body.venue_id === 'string' ? req.body.venue_id.slice(0, 256) : null;
      const venue_rating = Number.isFinite(req.body.venue_rating) ? req.body.venue_rating : null;
      const venue_photo_url = safeVenuePhotoUrl(req.body.venue_photo_url);

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
