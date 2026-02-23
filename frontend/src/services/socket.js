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
    console.log('Socket connected:', socket.id);
  });

  socket.on('connect_error', (err) => {
    console.warn('Socket connection error:', err.message);
  });

  socket.on('error', (data) => {
    console.warn('Socket error:', data.message);
  });

  return socket;
}

export function getSocket() {
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export function joinFlock(flockId) {
  if (socket?.connected) {
    socket.emit('join_flock', flockId);
  }
}

export function leaveFlock(flockId) {
  if (socket?.connected) {
    socket.emit('leave_flock', flockId);
  }
}

export function sendMessage(flockId, messageText) {
  if (socket?.connected) {
    socket.emit('send_message', {
      flockId,
      message_text: messageText,
      message_type: 'text',
    });
  }
}

export function startTyping(flockId) {
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
  if (!socket) return () => {};
  socket.on('new_message', callback);
  return () => socket.off('new_message', callback);
}

export function onUserTyping(callback) {
  if (!socket) return () => {};
  socket.on('user_typing', callback);
  return () => socket.off('user_typing', callback);
}

export function onUserStoppedTyping(callback) {
  if (!socket) return () => {};
  socket.on('user_stopped_typing', callback);
  return () => socket.off('user_stopped_typing', callback);
}
