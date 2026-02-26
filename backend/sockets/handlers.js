const pool = require('../config/database');
const { stripHtml } = require('../utils/sanitize');

// Track which users are in which rooms for presence
const roomUsers = new Map(); // flockId -> Set of { socketId, userId, name }

// Reusable membership check for socket handlers
async function verifyMembership(flockId, userId) {
  const result = await pool.query(
    "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
    [flockId, userId]
  );
  return result.rows.length > 0;
}

function registerHandlers(io, socket) {
  const user = socket.user; // Set by authenticateSocket middleware

  // --- Flock room management ---

  socket.on('join_flock', async (flockId) => {
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

      // Track user presence in the room
      if (!roomUsers.has(flockId)) {
        roomUsers.set(flockId, new Set());
      }
      roomUsers.get(flockId).add({
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
      const onlineMembers = Array.from(roomUsers.get(flockId) || []).map((u) => ({
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
      for (const u of users) {
        if (u.socketId === socket.id) {
          users.delete(u);
          break;
        }
      }
      if (users.size === 0) roomUsers.delete(flockId);
    }

    socket.to(room).emit('member_offline', {
      userId: user.id,
      name: user.name,
      flockId,
    });
  });

  // --- Real-time messaging ---

  socket.on('send_message', async (data) => {
    try {
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
      const allowedTypes = ['text', 'venue_card', 'image'];
      const safeType = allowedTypes.includes(message_type) ? message_type : 'text';

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
      message.reactions = [];

      // Broadcast to all members in the room (including sender)
      io.to(`flock:${flockId}`).emit('new_message', message);
    } catch (err) {
      console.error('send_message error:', err);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // --- Typing indicators ---

  socket.on('typing', async (flockId) => {
    if (!(await verifyMembership(flockId, user.id))) return;
    socket.to(`flock:${flockId}`).emit('user_typing', {
      userId: user.id,
      name: user.name,
      flockId,
    });
  });

  socket.on('stop_typing', async (flockId) => {
    if (!(await verifyMembership(flockId, user.id))) return;
    socket.to(`flock:${flockId}`).emit('user_stopped_typing', {
      userId: user.id,
      flockId,
    });
  });

  // --- Venue voting ---

  socket.on('vote_venue', async (data) => {
    try {
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

      // Fetch updated vote tallies
      const votes = await pool.query(
        `SELECT venue_name, venue_id, COUNT(*) AS vote_count,
                ARRAY_AGG(u.name) AS voters
         FROM venue_votes vv
         JOIN users u ON u.id = vv.user_id
         WHERE vv.flock_id = $1
         GROUP BY venue_name, venue_id
         ORDER BY vote_count DESC`,
        [flockId]
      );

      io.to(`flock:${flockId}`).emit('new_vote', {
        flockId,
        voter: { userId: user.id, name: user.name },
        venue_name,
        votes: votes.rows,
      });
    } catch (err) {
      console.error('vote_venue error:', err);
      socket.emit('error', { message: 'Failed to vote' });
    }
  });

  // --- Location sharing ---

  socket.on('update_location', async (data) => {
    const { flockId, lat, lng } = data;

    if (!flockId || typeof lat !== 'number' || typeof lng !== 'number') return;
    if (!(await verifyMembership(flockId, user.id))) return;

    socket.to(`flock:${flockId}`).emit('location_update', {
      userId: user.id,
      name: user.name,
      lat,
      lng,
      timestamp: Date.now(),
    });
  });

  socket.on('stop_sharing_location', async ({ flockId }) => {
    if (!flockId) return;
    socket.to(`flock:${flockId}`).emit('member_stopped_sharing', {
      userId: user.id,
    });
  });

  // --- Direct Messages (real-time) ---

  // Join a personal DM room so we can receive DMs
  socket.join(`user:${user.id}`);

  socket.on('send_dm', async (data) => {
    try {
      const { receiverId, message_type, venue_data, image_url, reply_to_id } = data;
      const text = stripHtml(typeof data.message_text === 'string' ? data.message_text.trim() : '');
      if (!receiverId || (!text && message_type !== 'image')) return;
      if (text.length > 5000) return;

      const allowedTypes = ['text', 'venue_card', 'image'];
      const safeType = allowedTypes.includes(message_type) ? message_type : 'text';

      // Verify receiver exists
      const receiver = await pool.query('SELECT id, name FROM users WHERE id = $1', [receiverId]);
      if (receiver.rows.length === 0) return;

      // Persist to database
      const result = await pool.query(
        `INSERT INTO direct_messages (sender_id, receiver_id, message_text, message_type, venue_data, image_url, reply_to_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [user.id, receiverId, text, safeType, venue_data || null, image_url || null, reply_to_id || null]
      );

      const msg = result.rows[0];
      msg.sender_name = user.name;
      msg.reactions = [];

      // If replying, attach the reply-to info
      if (reply_to_id) {
        const replyResult = await pool.query(
          `SELECT dm.id, dm.message_text, u.name AS sender_name FROM direct_messages dm JOIN users u ON u.id = dm.sender_id WHERE dm.id = $1`,
          [reply_to_id]
        );
        if (replyResult.rows.length > 0) msg.reply_to = replyResult.rows[0];
      }

      // Send to receiver's personal room
      socket.to(`user:${receiverId}`).emit('new_dm', msg);
      // Also send back to sender for confirmation
      socket.emit('new_dm', msg);
    } catch (err) {
      console.error('send_dm error:', err);
    }
  });

  // DM reactions (real-time)
  socket.on('dm_react', async (data) => {
    try {
      const { dmId, emoji, receiverId } = data;
      if (!dmId || !emoji || !receiverId) return;

      const dm = await pool.query('SELECT sender_id, receiver_id FROM direct_messages WHERE id = $1', [dmId]);
      if (dm.rows.length === 0) return;
      if (dm.rows[0].sender_id !== user.id && dm.rows[0].receiver_id !== user.id) return;

      await pool.query(
        `INSERT INTO dm_emoji_reactions (dm_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [dmId, user.id, emoji]
      );

      const payload = { dmId, emoji, userId: user.id, userName: user.name };
      socket.to(`user:${receiverId}`).emit('dm_reaction_added', payload);
      socket.emit('dm_reaction_added', payload);
    } catch (err) {
      console.error('dm_react error:', err);
    }
  });

  socket.on('dm_remove_react', async (data) => {
    try {
      const { dmId, emoji, receiverId } = data;
      if (!dmId || !emoji || !receiverId) return;

      await pool.query(
        'DELETE FROM dm_emoji_reactions WHERE dm_id = $1 AND user_id = $2 AND emoji = $3',
        [dmId, user.id, emoji]
      );

      const payload = { dmId, emoji, userId: user.id };
      socket.to(`user:${receiverId}`).emit('dm_reaction_removed', payload);
      socket.emit('dm_reaction_removed', payload);
    } catch (err) {
      console.error('dm_remove_react error:', err);
    }
  });

  // DM venue voting (real-time)
  socket.on('dm_vote_venue', async (data) => {
    try {
      const { receiverId, venue_id } = data;
      const venue_name = stripHtml(typeof data.venue_name === 'string' ? data.venue_name.trim() : '');
      if (!receiverId || !venue_name) return;

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
      const { receiverId, venue_name, venue_address, venue_id, venue_rating, venue_photo_url } = data;
      if (!receiverId || !venue_name) return;
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
  socket.on('dm_share_location', (data) => {
    const { receiverId, lat, lng } = data;
    if (!receiverId || typeof lat !== 'number' || typeof lng !== 'number') return;
    socket.to(`user:${receiverId}`).emit('dm_location_update', {
      userId: user.id, name: user.name, lat, lng, timestamp: Date.now(),
    });
  });

  socket.on('dm_stop_sharing_location', (data) => {
    const { receiverId } = data;
    if (!receiverId) return;
    socket.to(`user:${receiverId}`).emit('dm_member_stopped_sharing', { userId: user.id });
  });

  // DM typing indicators
  socket.on('dm_typing', (data) => {
    const { receiverId } = data;
    if (!receiverId) return;
    socket.to(`user:${receiverId}`).emit('dm_user_typing', {
      userId: user.id,
      name: user.name,
    });
  });

  socket.on('dm_stop_typing', (data) => {
    const { receiverId } = data;
    if (!receiverId) return;
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

  socket.on('crowd_update', (data) => {
    const { venue_id, level } = data; // level: 'low' | 'moderate' | 'busy' | 'packed'

    // Only venue owners or admins can broadcast crowd updates
    if (user.role !== 'venue_owner' && user.role !== 'admin') {
      socket.emit('error', { message: 'Only venue owners can update crowd levels' });
      return;
    }

    const allowedLevels = ['low', 'moderate', 'busy', 'packed'];
    if (!venue_id || !allowedLevels.includes(level)) {
      socket.emit('error', { message: 'Invalid crowd update data' });
      return;
    }

    // Broadcast to clients watching this venue
    io.emit('crowd_update', {
      venue_id,
      level,
      updated_by: user.id,
      timestamp: Date.now(),
    });
  });

  // --- Cleanup on disconnect ---

  socket.on('disconnect', () => {
    // Remove user from all tracked rooms
    for (const [flockId, users] of roomUsers.entries()) {
      for (const u of users) {
        if (u.socketId === socket.id) {
          users.delete(u);
          io.to(`flock:${flockId}`).emit('member_offline', {
            userId: user.id,
            name: user.name,
            flockId,
          });
          // Also notify that location sharing stopped
          io.to(`flock:${flockId}`).emit('member_stopped_sharing', {
            userId: user.id,
          });
          break;
        }
      }
      if (users.size === 0) roomUsers.delete(flockId);
    }
  });
}

module.exports = { registerHandlers };
