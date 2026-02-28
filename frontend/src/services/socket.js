import { io } from 'socket.io-client';
import { getToken, BASE_URL } from './api';

let socket = null;

export function connectSocket() {
  if (socket?.connected) return socket;

  const token = getToken();
  if (!token) return null;

  socket = io(BASE_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
  });

  socket.on('connect', () => {
    console.log('Socket connected:', socket?.id);
  });

  socket.on('connect_error', (err) => {
    console.warn('Socket connection error:', err.message);
  });

  socket.on('error', (data) => {
    console.warn('Socket error:', data?.message);
  });

  return socket;
}

export function getSocket() {
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}

export function joinFlock(flockId) {
  console.log('Joining flock:', flockId);
  if (socket?.connected) {
    socket.emit('join_flock', flockId);
  }
}

export function leaveFlock(flockId) {
  if (socket?.connected) {
    socket.emit('leave_flock', flockId);
  }
}

export function sendMessage(flockId, messageText, opts = {}) {
  console.log('Emitting send_message:', { flockId, message: messageText, opts });
  if (socket?.connected) {
    socket.emit('send_message', {
      flockId,
      message_text: messageText,
      message_type: opts.message_type || 'text',
      venue_data: opts.venue_data || null,
    });
  }
}

export function sendImageMessage(flockId, imageUrl) {
  console.log('Emitting send_message (image):', { flockId, imageUrl });
  if (socket?.connected) {
    socket.emit('send_message', {
      flockId,
      message_text: '',
      message_type: 'image',
      image_url: imageUrl,
    });
  }
}

export function startTyping(flockId) {
  console.log('Emitting typing:', { flockId });
  if (socket?.connected) {
    socket.emit('typing', flockId);
  }
}

export function stopTyping(flockId) {
  if (socket?.connected) {
    socket.emit('stop_typing', flockId);
  }
}

export function onNewMessage(callback) {
  if (socket) socket.on('new_message', (msg) => {
    console.log('Received new_message:', msg);
    callback(msg);
  });
  return () => { if (socket) socket.off('new_message'); };
}

export function onUserTyping(callback) {
  if (socket) socket.on('user_typing', (data) => {
    console.log('Received user_typing:', data);
    callback(data);
  });
  return () => { if (socket) socket.off('user_typing'); };
}

export function onUserStoppedTyping(callback) {
  if (socket) socket.on('user_stopped_typing', callback);
  return () => { if (socket) socket.off('user_stopped_typing', callback); };
}

// --- Direct messages ---

export function socketSendDm(receiverId, messageText, opts = {}) {
  if (socket?.connected) {
    socket.emit('send_dm', {
      receiverId,
      message_text: messageText,
      message_type: opts.message_type || 'text',
      venue_data: opts.venue_data || null,
      image_url: opts.image_url || null,
      reply_to_id: opts.reply_to_id || null,
    });
  }
}

export function onNewDm(callback) {
  if (socket) socket.on('new_dm', callback);
  return () => { if (socket) socket.off('new_dm', callback); };
}

export function dmStartTyping(receiverId) {
  if (socket?.connected) {
    socket.emit('dm_typing', { receiverId });
  }
}

export function dmStopTyping(receiverId) {
  if (socket?.connected) {
    socket.emit('dm_stop_typing', { receiverId });
  }
}

export function onDmUserTyping(callback) {
  if (socket) socket.on('dm_user_typing', callback);
  return () => { if (socket) socket.off('dm_user_typing', callback); };
}

export function onDmUserStoppedTyping(callback) {
  if (socket) socket.on('dm_user_stopped_typing', callback);
  return () => { if (socket) socket.off('dm_user_stopped_typing', callback); };
}

// DM reactions
export function dmReact(dmId, emoji, receiverId) {
  if (socket?.connected) socket.emit('dm_react', { dmId, emoji, receiverId });
}

export function dmRemoveReact(dmId, emoji, receiverId) {
  if (socket?.connected) socket.emit('dm_remove_react', { dmId, emoji, receiverId });
}

export function onDmReactionAdded(callback) {
  if (socket) socket.on('dm_reaction_added', callback);
  return () => { if (socket) socket.off('dm_reaction_added', callback); };
}

export function onDmReactionRemoved(callback) {
  if (socket) socket.on('dm_reaction_removed', callback);
  return () => { if (socket) socket.off('dm_reaction_removed', callback); };
}

// DM venue voting
export function dmVoteVenue(receiverId, venueName, venueId) {
  if (socket?.connected) socket.emit('dm_vote_venue', { receiverId, venue_name: venueName, venue_id: venueId });
}

export function onDmNewVote(callback) {
  if (socket) socket.on('dm_new_vote', callback);
  return () => { if (socket) socket.off('dm_new_vote', callback); };
}

// DM pinned venue
export function dmPinVenue(receiverId, venueData) {
  if (socket?.connected) socket.emit('dm_pin_venue', { receiverId, venue_name: venueData.name, venue_address: venueData.addr, venue_id: venueData.place_id, venue_rating: venueData.rating, venue_photo_url: venueData.photo_url });
}

export function onDmVenuePinned(callback) {
  if (socket) socket.on('dm_venue_pinned', callback);
  return () => { if (socket) socket.off('dm_venue_pinned', callback); };
}

// DM location sharing
export function dmShareLocation(receiverId, lat, lng) {
  if (socket?.connected) socket.emit('dm_share_location', { receiverId, lat, lng });
}

export function dmStopSharingLocation(receiverId) {
  if (socket?.connected) socket.emit('dm_stop_sharing_location', { receiverId });
}

export function onDmLocationUpdate(callback) {
  if (socket) socket.on('dm_location_update', callback);
  return () => { if (socket) socket.off('dm_location_update', callback); };
}

export function onDmMemberStoppedSharing(callback) {
  if (socket) socket.on('dm_member_stopped_sharing', callback);
  return () => { if (socket) socket.off('dm_member_stopped_sharing', callback); };
}

// --- Live location sharing ---

export function emitLocation(flockId, lat, lng) {
  console.log('[Location] Emitting:', { flockId, lat, lng });
  if (socket?.connected) {
    socket.emit('update_location', { flockId, lat, lng });
  }
}

export function stopSharingLocation(flockId) {
  if (socket?.connected) {
    socket.emit('stop_sharing_location', { flockId });
  }
}

export function onLocationUpdate(callback) {
  if (socket) socket.on('location_update', callback);
  return () => { if (socket) socket.off('location_update', callback); };
}

export function onMemberStoppedSharing(callback) {
  if (socket) socket.on('member_stopped_sharing', callback);
  return () => { if (socket) socket.off('member_stopped_sharing', callback); };
}

// --- Friend requests ---

export function emitFriendRequest(toUserId) {
  if (socket?.connected) socket.emit('friend_request_sent', { toUserId });
}

export function emitFriendResponse(toUserId, action) {
  if (socket?.connected) socket.emit('friend_request_response', { toUserId, action });
}

export function onFriendRequestReceived(callback) {
  if (socket) socket.on('friend_request_received', callback);
  return () => { if (socket) socket.off('friend_request_received', callback); };
}

export function onFriendRequestResponded(callback) {
  if (socket) socket.on('friend_request_responded', callback);
  return () => { if (socket) socket.off('friend_request_responded', callback); };
}

// --- Flock invites ---

export function emitFlockInvite(flockId, invitedUserIds) {
  if (socket?.connected) {
    socket.emit('flock_invite', { flockId, invitedUserIds });
  }
}

export function emitFlockInviteResponse(flockId, action) {
  if (socket?.connected) {
    socket.emit('flock_invite_response', { flockId, action });
  }
}

export function onFlockInviteReceived(callback) {
  if (socket) socket.on('flock_invite_received', callback);
  return () => { if (socket) socket.off('flock_invite_received', callback); };
}

export function onFlockInviteResponded(callback) {
  if (socket) socket.on('flock_invite_responded', callback);
  return () => { if (socket) socket.off('flock_invite_responded', callback); };
}
