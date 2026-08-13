const pool = require('../config/database');
const { stripHtml } = require('../utils/sanitize');
const { moderateText, TEXT_REJECTED_MESSAGE, moderateImage, IMAGE_REJECTED_MESSAGE } = require('../utils/moderation');
const { isBlockedBetween, isBlockedBetweenCached, getInvisibleUserIds } = require('../utils/blocks');
const { pushIfOfflineDebounced } = require('../services/pushHelper');

// Track which users are in which rooms for presence
const roomUsers = new Map(); // flockId -> Set of { socketId, userId, name }

// Per-socket token buckets for mutating events (audit 2026-08-12): Express
// rate limits stop at the handshake — after that a single connection could
// flood the database and push infrastructure without any ceiling.
const socketBuckets = new Map(); // socket.id -> Map(event -> {count, resetAt})
function allowEvent(socket, event, limit, windowMs) {
  let events = socketBuckets.get(socket.id);
  if (!events) { events = new Map(); socketBuckets.set(socket.id, events); }
  const now = Date.now();
  let b = events.get(event);
  if (!b || now >= b.resetAt) { b = { count: 0, resetAt: now + windowMs }; events.set(event, b); }
  b.count++;
  return b.count <= limit;
}
function clearBuckets(socketId) { socketBuckets.delete(socketId); }

// Reusable membership check for socket handlers
async function verifyMembership(flockId, userId) {
  const result = await pool.query(
    "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
    [flockId, userId]
  );
  return result.rows.length > 0;
}

// Block-aware alternative to a flock-room broadcast: emits to each accepted
// member individually, skipping anyone blocked either way with the actor.
// Room broadcasts leaked typing/vote identity across blocks (round 4).
async function emitToFlockExcludingBlocked(io, flockId, actorId, event, payload) {
  const members = await pool.query(
    "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2",
    [flockId, actorId]
  );
  const invisible = new Set(await getInvisibleUserIds(actorId));
  for (const m of members.rows) {
    if (invisible.has(m.user_id)) continue;
    io.to(`user:${m.user_id}`).emit(event, payload);
  }
}

function registerHandlers(io, socket) {
  const user = socket.user; // Set by authenticateSocket middleware

  // --- Flock room management ---

  socket.on('join_flock', async (flockId) => {
    if (!allowEvent(socket, 'join_flock', 20, 10_000)) return;
    try {
      // Verify membership before allowing room join
      const membership = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, user.id]
      );

      if (membership.rows.length === 0) {
        socket.emit('error', { message: 'Not a member of this flock' });
        return;
      }

      const room = `flock:${flockId}`;
      socket.join(room);

      // Track user presence in the room. Keyed by socket id — the old
      // Set-of-objects never deduplicated, so repeated join_flock emits grew
      // presence, memory, and room_members payloads without bound (round 5).
      if (!roomUsers.has(flockId)) {
        roomUsers.set(flockId, new Map());
      }
      roomUsers.get(flockId).set(socket.id, {
        socketId: socket.id,
        userId: user.id,
        name: user.name,
      });

      // Notify other members
      socket.to(room).emit('member_joined', {
        userId: user.id,
        name: user.name,
        flockId,
      });

      // Send current online members to the joining user
      const onlineMembers = Array.from((roomUsers.get(flockId) || new Map()).values()).map((u) => ({
        userId: u.userId,
        name: u.name,
      }));
      socket.emit('room_members', { flockId, members: onlineMembers });
    } catch (err) {
      console.error('join_flock error:', err);
      socket.emit('error', { message: 'Failed to join flock room' });
    }
  });

  socket.on('leave_flock', (flockId) => {
    const room = `flock:${flockId}`;
    socket.leave(room);

    // Remove from presence tracking
    if (roomUsers.has(flockId)) {
      const users = roomUsers.get(flockId);
      users.delete(socket.id);
      if (users.size === 0) roomUsers.delete(flockId);
    }

    socket.to(room).emit('member_offline', {
      userId: user.id,
      name: user.name,
      flockId,
    });
  });

  // --- Venue rooms (live sensor + checkin updates) ---
  // Public-by-design: any authenticated user can subscribe to a venue's live stream.
  // No presence tracking — these are read-only feeds, not group chats.
  // Bounded: unlimited unique ids grew Socket.io's room maps without limit
  // (round 6). 25 venue rooms per socket is far more than any real session.
  const venueRooms = new Set();
  socket.on('join_venue', (data) => {
    if (!allowEvent(socket, 'join_venue', 30, 10_000)) return;
    const placeId = typeof data === 'string' ? data : data?.placeId;
    if (!placeId || typeof placeId !== 'string' || placeId.length > 200) return;
    if (!venueRooms.has(placeId) && venueRooms.size >= 25) return;
    venueRooms.add(placeId);
    socket.join(`venue:${placeId}`);
  });

  socket.on('leave_venue', (data) => {
    const placeId = typeof data === 'string' ? data : data?.placeId;
    if (!placeId) return;
    venueRooms.delete(placeId);
    socket.leave(`venue:${placeId}`);
  });

  // --- Real-time messaging ---

  socket.on('send_message', async (data) => {
    try {
      if (!allowEvent(socket, 'send_message', 20, 10_000)) {
        socket.emit('error', { message: 'Slow down a moment.' });
        return;
      }
      const { flockId, message_type, venue_data, image_url } = data;
      const message_text = stripHtml(typeof data.message_text === 'string' ? data.message_text.trim() : '');

      // Validate inputs
      if (!flockId || (!message_text && message_type !== 'image')) {
        socket.emit('error', { message: 'Message text is required' });
        return;
      }
      if (message_text.length > 5000) {
        socket.emit('error', { message: 'Message too long (max 5000 characters)' });
        return;
      }
      // UGC text filter (Apple 1.2) — reject objectionable content before storing.
      if (!moderateText(message_text).allowed) {
        socket.emit('error', { message: TEXT_REJECTED_MESSAGE });
        return;
      }
      const allowedTypes = ['text', 'venue_card', 'image'];
      const safeType = allowedTypes.includes(message_type) ? message_type : 'text';

      // Image safety (round 3): socket sends bypassed the moderation endpoint
      // entirely. Only data-URL images are accepted (no arbitrary remote URLs
      // that could track recipients), and every image is screened fail-closed
      // before it is stored or delivered.
      if (image_url) {
        if (!/^data:image\/(png|jpe?g|gif|webp);base64,/.test(image_url)) {
          socket.emit('error', { message: 'Unsupported image format' });
          return;
        }
        const verdict = await moderateImage(image_url);
        if (!verdict.allowed) {
          socket.emit('error', { message: IMAGE_REJECTED_MESSAGE });
          return;
        }
      }

      // Verify membership
      const membership = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, user.id]
      );
      if (membership.rows.length === 0) {
        socket.emit('error', { message: 'Not a member of this flock' });
        return;
      }

      // Persist to database
      const result = await pool.query(
        `INSERT INTO messages (flock_id, sender_id, message_text, message_type, venue_data, image_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          flockId,
          user.id,
          message_text,
          safeType,
          venue_data ? JSON.stringify(venue_data) : null,
          image_url || null,
        ]
      );

      const message = result.rows[0];
      message.sender_name = user.name;
      // Oversized base64 avatars fan out to every member on every message —
      // drop them from the payload instead of amplifying them (REVIEW-ROUND5)
      message.sender_image =
        (user.profile_image_url && user.profile_image_url.length <= 12000)
          ? user.profile_image_url
          : null;
      message.reactions = [];

      // Fan out per-member instead of to the whole room, so mutual blocks are
      // honored live (the room broadcast let blocked users inject messages
      // into their blocker's open client — HTTP history filters them, sockets
      // didn't). Sender always gets their own echo.
      try {
        const flockInfo = await pool.query('SELECT name FROM flocks WHERE id = $1', [flockId]);
        const flockName = flockInfo.rows[0]?.name || 'Flock';
        const members = await pool.query(
          "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2",
          [flockId, user.id]
        );
        const invisible = new Set(await getInvisibleUserIds(user.id));
        const preview = (message_text || '').substring(0, 100);
        socket.emit('new_message', message);
        for (const m of members.rows) {
          if (invisible.has(m.user_id)) continue;
          io.to(`user:${m.user_id}`).emit('new_message', message);
          pushIfOfflineDebounced(io, m.user_id,
            `${user.name} in ${flockName}`,
            preview,
            { type: 'flock_message', flockId: String(flockId) }
          );
        }
      } catch (fanoutErr) {
        // FAIL CLOSED (round 3): broadcasting to the room here would deliver
        // to blocked users exactly when the block filter is unavailable. The
        // message is persisted; other members get it from history on refresh.
        console.error('Message fan-out error (flock msg):', fanoutErr.message);
        socket.emit('new_message', message);
        socket.emit('error', { message: 'Message saved, but live delivery is delayed.' });
      }
    } catch (err) {
      console.error('send_message error:', err);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // --- Typing indicators ---

  socket.on('typing', async (flockId) => {
    if (!allowEvent(socket, 'typing', 60, 10_000)) return;
    if (!(await verifyMembership(flockId, user.id))) return;
    await emitToFlockExcludingBlocked(io, flockId, user.id, 'user_typing', {
      userId: user.id,
      name: user.name,
      flockId,
    });
  });

  socket.on('stop_typing', async (flockId) => {
    if (!allowEvent(socket, 'typing', 60, 10_000)) return;
    if (!(await verifyMembership(flockId, user.id))) return;
    await emitToFlockExcludingBlocked(io, flockId, user.id, 'user_stopped_typing', {
      userId: user.id,
      flockId,
    });
  });

  // --- Venue voting ---

  socket.on('vote_venue', async (data) => {
    try {
      if (!allowEvent(socket, 'vote_venue', 30, 10_000)) return;
      const { flockId, venue_id } = data;
      const venue_name = stripHtml(typeof data.venue_name === 'string' ? data.venue_name.trim() : '');

      // Validate inputs
      if (!flockId || !venue_name) {
        socket.emit('error', { message: 'Venue name is required' });
        return;
      }
      if (venue_name.length > 255) {
        socket.emit('error', { message: 'Venue name too long' });
        return;
      }

      if (!(await verifyMembership(flockId, user.id))) {
        socket.emit('error', { message: 'Not a member of this flock' });
        return;
      }

      await pool.query(
        `INSERT INTO venue_votes (flock_id, user_id, venue_name, venue_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (flock_id, user_id, venue_name) DO NOTHING`,
        [flockId, user.id, venue_name, venue_id || null]
      );

      // Fetch updated vote tallies (ids kept internally so each recipient's
      // blocked users can be stripped from the names list — round 5)
      const votes = await pool.query(
        `SELECT venue_name, venue_id, COUNT(*) AS vote_count,
                ARRAY_AGG(json_build_object('id', u.id, 'name', u.name)) AS voter_rows
         FROM venue_votes vv
         JOIN users u ON u.id = vv.user_id
         WHERE vv.flock_id = $1
         GROUP BY venue_name, venue_id
         ORDER BY vote_count DESC`,
        [flockId]
      );

      const members = await pool.query(
        "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
        [flockId]
      );
      const memberIds = members.rows.map(r => r.user_id);
      const blockRows = memberIds.length
        ? await pool.query(
            'SELECT blocker_id, blocked_id FROM user_blocks WHERE blocker_id = ANY($1::int[]) OR blocked_id = ANY($1::int[])',
            [memberIds]
          )
        : { rows: [] };
      const invisibleOf = (uid) => {
        const s = new Set();
        for (const b of blockRows.rows) {
          if (b.blocker_id === uid) s.add(b.blocked_id);
          if (b.blocked_id === uid) s.add(b.blocker_id);
        }
        return s;
      };
      const tailor = (invisible) => votes.rows.map(v => ({
        venue_name: v.venue_name,
        venue_id: v.venue_id,
        vote_count: v.vote_count,
        voters: (v.voter_rows || []).filter(p => !invisible.has(p.id)).map(p => p.name),
      }));

      socket.emit('new_vote', { flockId, voter: { userId: user.id, name: user.name }, venue_name, votes: tailor(invisibleOf(user.id)) });
      for (const uid of memberIds) {
        if (uid === user.id) continue;
        const invisible = invisibleOf(uid);
        if (invisible.has(user.id)) continue;
        io.to(`user:${uid}`).emit('new_vote', { flockId, voter: { userId: user.id, name: user.name }, venue_name, votes: tailor(invisible) });
      }
    } catch (err) {
      console.error('vote_venue error:', err);
      socket.emit('error', { message: 'Failed to vote' });
    }
  });

  // --- Location sharing ---

  socket.on('update_location', async (data) => {
    try {
      if (!allowEvent(socket, 'update_location', 30, 10_000)) return;
      const { flockId, lat, lng } = data;

      if (!flockId || typeof lat !== 'number' || typeof lng !== 'number') return;
      if (!(await verifyMembership(flockId, user.id))) return;

      // Exact coordinates never reach blocked users (round 3). Per-member
      // fan-out instead of room broadcast; fails closed by construction.
      const members = await pool.query(
        "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2",
        [flockId, user.id]
      );
      const invisible = new Set(await getInvisibleUserIds(user.id));
      const payload = { userId: user.id, name: user.name, lat, lng, timestamp: Date.now() };
      for (const m of members.rows) {
        if (invisible.has(m.user_id)) continue;
        io.to(`user:${m.user_id}`).emit('location_update', payload);
      }
    } catch (err) {
      console.error('update_location error:', err.message);
    }
  });

  socket.on('stop_sharing_location', async ({ flockId }) => {
    if (!flockId) return;
    socket.to(`flock:${flockId}`).emit('member_stopped_sharing', {
      userId: user.id,
    });
  });

  // --- Friend request events ---

  // These events only RELAY state that the REST endpoints already persisted —
  // the DB row is verified first, so a bare socket emit can't fabricate a
  // friend request or response that never happened (round 4).
  socket.on('friend_request_sent', async (data) => {
    if (!allowEvent(socket, 'friend_event', 20, 10_000)) return;
    const { toUserId } = data;
    if (!toUserId) return;
    if (await isBlockedBetween(user.id, toUserId)) return;
    const row = await pool.query(
      `SELECT 1 FROM friendships WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'`,
      [user.id, toUserId]
    );
    if (row.rows.length === 0) return;
    io.to(`user:${toUserId}`).emit('friend_request_received', {
      fromUserId: user.id,
      fromUserName: user.name,
    });
  });

  socket.on('friend_request_response', async (data) => {
    if (!allowEvent(socket, 'friend_event', 20, 10_000)) return;
    const { toUserId, action } = data; // action: 'accepted' | 'declined'
    if (!toUserId || !['accepted', 'declined'].includes(action)) return;
    if (await isBlockedBetween(user.id, toUserId)) return;
    // The claimed outcome must match the persisted friendship state.
    const row = await pool.query(
      `SELECT 1 FROM friendships WHERE requester_id = $1 AND addressee_id = $2 AND status = $3`,
      [toUserId, user.id, action]
    );
    if (row.rows.length === 0) return;
    io.to(`user:${toUserId}`).emit('friend_request_responded', {
      fromUserId: user.id,
      fromUserName: user.name,
      action,
    });
  });

  // --- Flock invite events ---

  socket.on('flock_invite', async (data) => {
    try {
      if (!allowEvent(socket, 'flock_invite', 10, 10_000)) return;
      const { flockId, invitedUserIds } = data;
      if (!flockId || !Array.isArray(invitedUserIds) || invitedUserIds.length === 0 || invitedUserIds.length > 25) return;

      if (!(await verifyMembership(flockId, user.id))) {
        socket.emit('error', { message: 'Not a member of this flock' });
        return;
      }

      const flockResult = await pool.query('SELECT id, name FROM flocks WHERE id = $1', [flockId]);
      if (flockResult.rows.length === 0) return;
      const flockName = flockResult.rows[0].name;

      // Relay persisted state only (round 5): each target must actually hold
      // an 'invited' membership row — otherwise any member could spoof-flood
      // invite toasts to arbitrary user ids.
      const invitedRows = await pool.query(
        `SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'invited' AND user_id = ANY($2::int[])`,
        [flockId, invitedUserIds.map(Number).filter(Number.isFinite)]
      );
      for (const row of invitedRows.rows) {
        const uid = row.user_id;
        // Blocked users never see each other's invites
        if (await isBlockedBetween(user.id, uid)) continue;
        io.to(`user:${uid}`).emit('flock_invite_received', {
          flockId,
          flockName,
          invitedBy: { userId: user.id, name: user.name },
        });
      }

      socket.to(`flock:${flockId}`).emit('flock_members_invited', {
        flockId,
        invitedBy: { userId: user.id, name: user.name },
        invitedUserIds,
      });
    } catch (err) {
      console.error('flock_invite error:', err);
    }
  });

  socket.on('flock_invite_response', async (data) => {
    try {
      const { flockId, action } = data;
      if (!flockId || !['accepted', 'declined'].includes(action)) return;
      // Round 3: any socket could broadcast fake RSVP activity into a guessed
      // flock id. Round 4: holding a row isn't enough — the persisted status
      // must MATCH the claimed action, so the event only relays what the REST
      // endpoint already recorded.
      const mem = await pool.query(
        'SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2',
        [flockId, user.id]
      );
      if (mem.rows.length === 0 || mem.rows[0].status !== action) return;

      const flockResult = await pool.query('SELECT id, name FROM flocks WHERE id = $1', [flockId]);
      if (flockResult.rows.length === 0) return;

      io.to(`flock:${flockId}`).emit('flock_invite_responded', {
        flockId,
        userId: user.id,
        userName: user.name,
        action,
      });
    } catch (err) {
      console.error('flock_invite_response error:', err);
    }
  });

  // --- Direct Messages (real-time) ---

  // Join a personal DM room so we can receive DMs
  socket.join(`user:${user.id}`);

  socket.on('send_dm', async (data) => {
    try {
      if (!allowEvent(socket, 'send_dm', 20, 10_000)) {
        socket.emit('error', { message: 'Slow down a moment.' });
        return;
      }
      const { receiverId, message_type, venue_data, image_url, reply_to_id } = data;
      const text = stripHtml(typeof data.message_text === 'string' ? data.message_text.trim() : '');
      if (!receiverId || (!text && message_type !== 'image')) return;
      if (text.length > 5000) return;

      // Mutual block — no DMs in either direction.
      if (await isBlockedBetween(user.id, receiverId)) {
        socket.emit('error', { message: 'You can no longer message this user.' });
        return;
      }
      // UGC text filter (Apple 1.2).
      if (!moderateText(text).allowed) {
        socket.emit('error', { message: TEXT_REJECTED_MESSAGE });
        return;
      }

      const allowedTypes = ['text', 'venue_card', 'image'];
      const safeType = allowedTypes.includes(message_type) ? message_type : 'text';

      // Image safety (round 3): socket sends bypassed the moderation endpoint
      // entirely. Only data-URL images are accepted (no arbitrary remote URLs
      // that could track recipients), and every image is screened fail-closed
      // before it is stored or delivered.
      if (image_url) {
        if (!/^data:image\/(png|jpe?g|gif|webp);base64,/.test(image_url)) {
          socket.emit('error', { message: 'Unsupported image format' });
          return;
        }
        const verdict = await moderateImage(image_url);
        if (!verdict.allowed) {
          socket.emit('error', { message: IMAGE_REJECTED_MESSAGE });
          return;
        }
      }

      // Verify receiver exists
      const receiver = await pool.query('SELECT id, name FROM users WHERE id = $1', [receiverId]);
      if (receiver.rows.length === 0) return;

      // SECURITY: a reply may only reference a message from THIS conversation.
      // Without this check, any authenticated user could DM themselves an
      // arbitrary message ID and read someone else's private message text.
      let replyRow = null;
      if (reply_to_id) {
        const replyResult = await pool.query(
          `SELECT dm.id, dm.message_text, u.name AS sender_name
           FROM direct_messages dm JOIN users u ON u.id = dm.sender_id
           WHERE dm.id = $1
             AND COALESCE(dm.is_hidden, false) = false
             AND ((dm.sender_id = $2 AND dm.receiver_id = $3) OR (dm.sender_id = $3 AND dm.receiver_id = $2))`,
          [reply_to_id, user.id, receiverId]
        );
        replyRow = replyResult.rows[0] || null;
        if (!replyRow) return; // foreign, hidden, or nonexistent reply target — drop the message
      }

      // Persist to database
      const result = await pool.query(
        `INSERT INTO direct_messages (sender_id, receiver_id, message_text, message_type, venue_data, image_url, reply_to_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [user.id, receiverId, text, safeType, venue_data || null, image_url || null, replyRow ? reply_to_id : null]
      );

      const msg = result.rows[0];
      msg.sender_name = user.name;
      // Same oversized-avatar guard as the flock send path (REVIEW-ROUND5)
      msg.sender_image =
        (user.profile_image_url && user.profile_image_url.length <= 12000)
          ? user.profile_image_url
          : null;
      msg.reactions = [];
      if (replyRow) msg.reply_to = replyRow;

      // Send to receiver's personal room
      socket.to(`user:${receiverId}`).emit('new_dm', msg);
      // Also send back to sender for confirmation
      socket.emit('new_dm', msg);

      // Push notification for offline DM recipient
      const preview = (text || '').substring(0, 100);
      pushIfOfflineDebounced(io, receiverId,
        user.name,
        preview,
        { type: 'dm_message', senderId: String(user.id) }
      ).catch(() => {});
    } catch (err) {
      console.error('send_dm error:', err);
    }
  });

  // DM reactions (real-time)
  // DM reactions: the counterpart is DERIVED from the message row, never
  // trusted from the client, and mutual blocks apply (audit 2026-08-12).
  socket.on('dm_react', async (data) => {
    try {
      if (!allowEvent(socket, 'dm_react', 30, 10_000)) return;
      const { dmId, emoji } = data;
      if (!dmId || !emoji) return;

      const dm = await pool.query('SELECT sender_id, receiver_id FROM direct_messages WHERE id = $1', [dmId]);
      if (dm.rows.length === 0) return;
      if (dm.rows[0].sender_id !== user.id && dm.rows[0].receiver_id !== user.id) return;
      const counterpart = dm.rows[0].sender_id === user.id ? dm.rows[0].receiver_id : dm.rows[0].sender_id;
      if (await isBlockedBetween(user.id, counterpart)) return;

      await pool.query(
        `INSERT INTO dm_emoji_reactions (dm_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [dmId, user.id, emoji]
      );

      const payload = { dmId, emoji, userId: user.id, userName: user.name };
      socket.to(`user:${counterpart}`).emit('dm_reaction_added', payload);
      socket.emit('dm_reaction_added', payload);
    } catch (err) {
      console.error('dm_react error:', err);
    }
  });

  socket.on('dm_remove_react', async (data) => {
    try {
      if (!allowEvent(socket, 'dm_react', 30, 10_000)) return;
      const { dmId, emoji } = data;
      if (!dmId || !emoji) return;

      const dm = await pool.query('SELECT sender_id, receiver_id FROM direct_messages WHERE id = $1', [dmId]);
      if (dm.rows.length === 0) return;
      if (dm.rows[0].sender_id !== user.id && dm.rows[0].receiver_id !== user.id) return;
      const counterpart = dm.rows[0].sender_id === user.id ? dm.rows[0].receiver_id : dm.rows[0].sender_id;
      // Blocks end all interaction, removals included (same as dm_react).
      if (await isBlockedBetween(user.id, counterpart)) return;

      await pool.query(
        'DELETE FROM dm_emoji_reactions WHERE dm_id = $1 AND user_id = $2 AND emoji = $3',
        [dmId, user.id, emoji]
      );

      const payload = { dmId, emoji, userId: user.id };
      socket.to(`user:${counterpart}`).emit('dm_reaction_removed', payload);
      socket.emit('dm_reaction_removed', payload);
    } catch (err) {
      console.error('dm_remove_react error:', err);
    }
  });

  // DM venue voting (real-time)
  socket.on('dm_vote_venue', async (data) => {
    try {
      if (!allowEvent(socket, 'dm_vote_venue', 30, 10_000)) return;
      const { receiverId, venue_id } = data;
      const venue_name = stripHtml(typeof data.venue_name === 'string' ? data.venue_name.trim() : '');
      if (!receiverId || !venue_name) return;
      if (await isBlockedBetween(user.id, receiverId)) return;

      const u1 = Math.min(user.id, receiverId);
      const u2 = Math.max(user.id, receiverId);

      // Check if user already voted for this exact venue (toggle off)
      const existing = await pool.query(
        `SELECT id FROM dm_venue_votes WHERE user1_id = $1 AND user2_id = $2 AND user_id = $3 AND venue_name = $4`,
        [u1, u2, user.id, venue_name]
      );
      if (existing.rows.length > 0) {
        // Unvote — remove this vote
        await pool.query(`DELETE FROM dm_venue_votes WHERE user1_id = $1 AND user2_id = $2 AND user_id = $3 AND venue_name = $4`, [u1, u2, user.id, venue_name]);
      } else {
        // Switch vote — remove any existing vote by this user, then insert new one
        await pool.query(`DELETE FROM dm_venue_votes WHERE user1_id = $1 AND user2_id = $2 AND user_id = $3`, [u1, u2, user.id]);
        await pool.query(
          `INSERT INTO dm_venue_votes (user1_id, user2_id, user_id, venue_name, venue_id) VALUES ($1, $2, $3, $4, $5)`,
          [u1, u2, user.id, venue_name, venue_id || null]
        );
      }

      const votes = await pool.query(
        `SELECT venue_name, venue_id, COUNT(*) AS vote_count, ARRAY_AGG(u.name) AS voters
         FROM dm_venue_votes vv JOIN users u ON u.id = vv.user_id
         WHERE vv.user1_id = $1 AND vv.user2_id = $2
         GROUP BY venue_name, venue_id ORDER BY vote_count DESC`,
        [u1, u2]
      );

      const payload = { voter: { userId: user.id, name: user.name }, venue_name, votes: votes.rows };
      socket.to(`user:${receiverId}`).emit('dm_new_vote', payload);
      socket.emit('dm_new_vote', payload);
    } catch (err) {
      console.error('dm_vote_venue error:', err);
    }
  });

  // DM pin venue (real-time sync)
  socket.on('dm_pin_venue', async (data) => {
    try {
      if (!allowEvent(socket, 'dm_pin_venue', 20, 10_000)) return;
      const { receiverId, venue_name, venue_address, venue_id, venue_rating, venue_photo_url } = data;
      if (!receiverId || !venue_name) return;
      if (await isBlockedBetween(user.id, receiverId)) return;
      const u1 = Math.min(user.id, receiverId);
      const u2 = Math.max(user.id, receiverId);
      const safeName = stripHtml(typeof venue_name === 'string' ? venue_name.trim() : '');

      await pool.query(
        `INSERT INTO dm_pinned_venues (user1_id, user2_id, venue_name, venue_address, venue_id, venue_rating, venue_photo_url, pinned_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (user1_id, user2_id) DO UPDATE SET
           venue_name = EXCLUDED.venue_name, venue_address = EXCLUDED.venue_address, venue_id = EXCLUDED.venue_id,
           venue_rating = EXCLUDED.venue_rating, venue_photo_url = EXCLUDED.venue_photo_url,
           pinned_by = EXCLUDED.pinned_by, updated_at = NOW()`,
        [u1, u2, safeName, venue_address || null, venue_id || null, venue_rating || null, venue_photo_url || null, user.id]
      );

      const payload = { venue_name: safeName, venue_address, venue_id, venue_rating, venue_photo_url, pinned_by: user.id, pinned_by_name: user.name };
      socket.to(`user:${receiverId}`).emit('dm_venue_pinned', payload);
      socket.emit('dm_venue_pinned', payload);
    } catch (err) {
      console.error('dm_pin_venue error:', err);
    }
  });

  // DM location sharing
  // Mutual-block enforcement on ephemeral DM events (audit 2026-08-12): these
  // previously trusted any receiverId, letting a blocked user ping typing/
  // location events into their blocker's client. Cached check keeps the
  // per-keystroke cost off the database.
  socket.on('dm_share_location', async (data) => {
    if (!allowEvent(socket, 'dm_location', 30, 10_000)) return;
    const { receiverId, lat, lng } = data;
    if (!receiverId || typeof lat !== 'number' || typeof lng !== 'number') return;
    if (await isBlockedBetweenCached(user.id, receiverId)) return;
    socket.to(`user:${receiverId}`).emit('dm_location_update', {
      userId: user.id, name: user.name, lat, lng, timestamp: Date.now(),
    });
  });

  socket.on('dm_stop_sharing_location', async (data) => {
    if (!allowEvent(socket, 'dm_location', 30, 10_000)) return;
    const { receiverId } = data;
    if (!receiverId) return;
    if (await isBlockedBetweenCached(user.id, receiverId)) return;
    socket.to(`user:${receiverId}`).emit('dm_member_stopped_sharing', { userId: user.id });
  });

  // DM typing indicators
  socket.on('dm_typing', async (data) => {
    if (!allowEvent(socket, 'dm_typing', 60, 10_000)) return;
    const { receiverId } = data;
    if (!receiverId) return;
    if (await isBlockedBetweenCached(user.id, receiverId)) return;
    socket.to(`user:${receiverId}`).emit('dm_user_typing', {
      userId: user.id,
      name: user.name,
    });
  });

  socket.on('dm_stop_typing', async (data) => {
    if (!allowEvent(socket, 'dm_typing', 60, 10_000)) return;
    const { receiverId } = data;
    if (!receiverId) return;
    if (await isBlockedBetweenCached(user.id, receiverId)) return;
    socket.to(`user:${receiverId}`).emit('dm_user_stopped_typing', {
      userId: user.id,
    });
  });

  // --- Venue confirmed by creator ---

  socket.on('select_venue', async (data) => {
    try {
      const { flockId, venue_name, venue_address, venue_id } = data;

      // Only the flock creator can confirm a venue
      const flock = await pool.query('SELECT creator_id FROM flocks WHERE id = $1', [flockId]);
      if (flock.rows.length === 0 || flock.rows[0].creator_id !== user.id) {
        socket.emit('error', { message: 'Only the flock creator can select a venue' });
        return;
      }

      await pool.query(
        `UPDATE flocks
         SET venue_name = $1, venue_address = $2, venue_id = $3, status = 'confirmed', updated_at = NOW()
         WHERE id = $4`,
        [venue_name, venue_address || null, venue_id || null, flockId]
      );

      io.to(`flock:${flockId}`).emit('venue_selected', {
        flockId,
        venue_name,
        venue_address,
        venue_id,
        selected_by: { userId: user.id, name: user.name },
      });
    } catch (err) {
      console.error('select_venue error:', err);
      socket.emit('error', { message: 'Failed to select venue' });
    }
  });

  // --- Crowd level updates (for venue owners) ---

  socket.on('crowd_update', async (data) => {
    try {
      if (!allowEvent(socket, 'crowd_update', 6, 60_000)) return;
      const { venue_id, level } = data; // level: 'low' | 'moderate' | 'busy' | 'packed'

      const allowedLevels = ['low', 'moderate', 'busy', 'packed'];
      if (!venue_id || !allowedLevels.includes(level)) {
        socket.emit('error', { message: 'Invalid crowd update data' });
        return;
      }

      // Round 5: role alone is forgeable (venue onboarding self-assigns it).
      // The broadcaster must hold the VERIFIED claim on this exact venue.
      const claim = await pool.query(
        'SELECT 1 FROM venue_profiles WHERE user_id = $1 AND google_place_id = $2 AND verified = true',
        [user.id, venue_id]
      );
      if (claim.rows.length === 0 && user.role !== 'admin') {
        socket.emit('error', { message: 'Only the verified owner can update crowd levels' });
        return;
      }

      // Broadcast to clients watching this venue (its room, not the world)
      io.to(`venue:${venue_id}`).emit('crowd_update', {
        venue_id,
        level,
        updated_by: user.id,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error('crowd_update error:', err.message);
    }
  });

  // --- Cleanup on disconnect ---

  socket.on('disconnect', () => {
    clearBuckets(socket.id);
    // Remove user from all tracked rooms (Map keyed by socket id — no
    // duplicate entries to leak)
    for (const [flockId, users] of roomUsers.entries()) {
      if (users.delete(socket.id)) {
        io.to(`flock:${flockId}`).emit('member_offline', {
          userId: user.id,
          name: user.name,
          flockId,
        });
        // Also notify that location sharing stopped
        io.to(`flock:${flockId}`).emit('member_stopped_sharing', {
          userId: user.id,
        });
      }
      if (users.size === 0) roomUsers.delete(flockId);
    }
  });
}

module.exports = { registerHandlers, emitToFlockExcludingBlocked };
