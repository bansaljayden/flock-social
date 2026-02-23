const pool = require('../config/database');

// Track which users are in which rooms for presence
const roomUsers = new Map(); // flockId -> Set of { socketId, userId, name }

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

    socket.to(room).emit('member_left', {
      userId: user.id,
      name: user.name,
      flockId,
    });
  });

  // --- Real-time messaging ---

  socket.on('send_message', async (data) => {
    try {
      const { flockId, message_text, message_type, venue_data, image_url } = data;

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
          message_type || 'text',
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

  socket.on('typing', (flockId) => {
    socket.to(`flock:${flockId}`).emit('user_typing', {
      userId: user.id,
      name: user.name,
      flockId,
    });
  });

  socket.on('stop_typing', (flockId) => {
    socket.to(`flock:${flockId}`).emit('user_stopped_typing', {
      userId: user.id,
      flockId,
    });
  });

  // --- Venue voting ---

  socket.on('vote_venue', async (data) => {
    try {
      const { flockId, venue_name, venue_id } = data;

      const membership = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, user.id]
      );
      if (membership.rows.length === 0) {
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

  socket.on('update_location', (data) => {
    const { flockId, lat, lng } = data;
    socket.to(`flock:${flockId}`).emit('location_update', {
      userId: user.id,
      name: user.name,
      lat,
      lng,
      timestamp: Date.now(),
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
    // Broadcast to all connected clients watching this venue
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
          io.to(`flock:${flockId}`).emit('member_left', {
            userId: user.id,
            name: user.name,
            flockId,
          });
          break;
        }
      }
      if (users.size === 0) roomUsers.delete(flockId);
    }
  });
}

module.exports = { registerHandlers };
