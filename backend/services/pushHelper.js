// ---------------------------------------------------------------------------
// Push Notification Helper
// Checks if user is online via Socket.io before sending push.
// Debounces message notifications (30s per recipient).
// ---------------------------------------------------------------------------

const { sendPushToUser } = require('./firebaseService');

// Debounce map: userId -> timestamp of last push sent
const lastPushSent = new Map();
const DEBOUNCE_MS = 30 * 1000;

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of lastPushSent) {
    if (now - ts > DEBOUNCE_MS * 2) lastPushSent.delete(key);
  }
}, 5 * 60 * 1000);

// Check if a user is currently connected via Socket.io
function isUserOnline(io, userId) {
  if (!io) return false;
  const room = io.sockets.adapter.rooms.get(`user:${userId}`);
  return room && room.size > 0;
}

// Send push only if user is offline
async function pushIfOffline(io, userId, title, body, data = {}) {
  if (isUserOnline(io, userId)) return { skipped: true, reason: 'online' };
  return sendPushToUser(userId, title, body, data);
}

// Send push only if user is offline AND not debounced
async function pushIfOfflineDebounced(io, userId, title, body, data = {}) {
  if (isUserOnline(io, userId)) return { skipped: true, reason: 'online' };

  const now = Date.now();
  const lastSent = lastPushSent.get(userId);
  if (lastSent && now - lastSent < DEBOUNCE_MS) {
    return { skipped: true, reason: 'debounced' };
  }

  lastPushSent.set(userId, now);
  return sendPushToUser(userId, title, body, data);
}

// Send push regardless of online status (for explicit user actions like reminders)
async function pushAlways(userId, title, body, data = {}) {
  return sendPushToUser(userId, title, body, data);
}

module.exports = { isUserOnline, pushIfOffline, pushIfOfflineDebounced, pushAlways };
