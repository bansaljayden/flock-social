import { io } from 'socket.io-client';
import { getToken, BASE_URL } from './api';

let socket = null;
let socketToken = null;

/**
 * SUBSCRIPTION REGISTRY — read before changing anything in this file.
 *
 * Every onX(callback) helper below used to do `socket.on(event, callback)`
 * against whatever instance the module variable happened to hold at call
 * time. App.js subscribes once, in effects with empty dependency arrays that
 * never re-run, so those listeners were welded to one specific socket object.
 * The moment that object was replaced the app went silent: messages, votes,
 * invites and budget updates all arrived on a socket nobody was listening to.
 *
 * The registry breaks that coupling. Subscriptions live here, in the module,
 * not on the socket. Any socket instance we create gets the whole registry
 * applied to it, so a reconnect, a token swap or a full teardown/rebuild is
 * invisible to callers. The exported signatures are unchanged: onX(cb) still
 * returns an unsubscribe function.
 */
const listeners = new Map(); // event -> Set<callback>

function register(event, callback) {
  if (typeof callback !== 'function') return () => {};
  let bucket = listeners.get(event);
  if (!bucket) {
    bucket = new Set();
    listeners.set(event, bucket);
  }
  if (!bucket.has(callback)) {
    bucket.add(callback);
    // Attaching to the live socket is an optimisation, not the source of
    // truth. Subscribing before connectSocket() runs is fine now: the
    // callback is applied as soon as an instance exists.
    if (socket) socket.on(event, callback);
  }
  return () => {
    const set = listeners.get(event);
    if (set) {
      set.delete(callback);
      if (set.size === 0) listeners.delete(event);
    }
    if (socket) socket.off(event, callback);
  };
}

function applyRegistry(instance) {
  listeners.forEach((bucket, event) => {
    bucket.forEach((callback) => instance.on(event, callback));
  });
}

// Fully dispose an instance so it can never keep reconnecting in the
// background. Skipping this is how a mid-reconnect socket became an orphan
// that burned a server slot while delivering events to nobody.
function dispose(instance) {
  if (!instance) return;
  try { instance.removeAllListeners(); } catch { /* already torn down */ }
  try { instance.disconnect(); } catch { /* already torn down */ }
}

/**
 * A handshake rejected by the server's auth middleware will be rejected again,
 * identically, forever: the token is expired, revoked (password change, account
 * claim), the account is banned, or the account is gone. socket.io retries on
 * its own schedule and — since reconnectionAttempts is Infinity — would keep
 * re-presenting the same dead credential every 30 seconds for as long as the
 * app is open, costing a signature check and a database read per client per
 * attempt, and never telling anyone.
 *
 * These are the exact strings middleware/auth.js's authenticateSocket puts on
 * the error. 'Too many connections' and every transport failure are NOT here:
 * those are transient and must keep retrying.
 */
const FATAL_AUTH_ERRORS = [
  'no token provided',
  'user not found',
  'session expired',
  'account suspended',
  'authentication failed',
];

// 'Authentication failed' is also authenticateSocket's catch-all, which a
// database blip can reach — so a few in a row, not one, ends the retry loop,
// and an explicit reconnect (online / tab-visible / reconnectSocket) always
// gets another chance.
const FATAL_AUTH_STRIKES = 3;
let fatalAuthStrikes = 0;

function isFatalAuthError(message) {
  const m = String(message || '').toLowerCase();
  return FATAL_AUTH_ERRORS.some((known) => m.includes(known));
}

function createSocket(token) {
  // A fresh instance starts with a clean slate. Without this, strikes left
  // over from a previous credential could kill a brand-new sign-in's socket
  // after a single transient 'Authentication failed' (db blip). The cap still
  // holds per instance: a dead credential accrues its three strikes on this
  // socket's own retry loop and stops.
  fatalAuthStrikes = 0;
  const instance = io(BASE_URL, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    // Was 10. Ten attempts on a 1s-to-5s backoff gives up after well under a
    // minute, and once socket.io stops retrying it never starts again on its
    // own: a subway ride or a hotel captive portal silenced the app until the
    // user force-quit it. Retry forever instead, but cap the delay at 30s so a
    // backend outage does not turn every open client into a load generator.
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000,
    randomizationFactor: 0.5,
  });

  instance.on('connect', () => {
    fatalAuthStrikes = 0;
  });
  instance.on('connect_error', (err) => {
    console.warn('Socket connection error:', err?.message);
    if (!isFatalAuthError(err?.message)) {
      fatalAuthStrikes = 0;
      return;
    }
    fatalAuthStrikes += 1;
    if (fatalAuthStrikes < FATAL_AUTH_STRIKES) return;
    // Stop the loop. Clearing socketToken means the next connectSocket() —
    // after a fresh sign-in, say — rebuilds instead of reusing this instance.
    socketToken = null;
    try { instance.disconnect(); } catch { /* already torn down */ }
  });
  instance.on('error', (data) => {
    console.warn('Socket error:', data?.message);
  });

  applyRegistry(instance);
  return instance;
}

export function connectSocket() {
  const token = getToken();
  if (!token) return null;

  if (socket) {
    // Reuse the existing instance whatever its state. The old guard was
    // `if (socket?.connected)`, so a socket that was merely MID-RECONNECT
    // fell through and a second io() was constructed on top of it.
    if (socketToken === token) {
      // Only nudge a socket that has genuinely given up. `active` is true
      // while connected or while a reconnect is still pending, and calling
      // connect() on one of those is a no-op anyway.
      if (!socket.connected && !socket.active) socket.connect();
      return socket;
    }
    // Different token (account switch): the old connection is authenticated
    // as the previous user and must go, not linger.
    const stale = socket;
    socket = null;
    dispose(stale);
  }

  socketToken = token;
  socket = createSocket(token);
  return socket;
}

export function getSocket() {
  return socket;
}

/**
 * Force a fresh connection attempt. Safe to call from a 'online' handler, a
 * resume handler, or a retry button in App.js. The module already wires the
 * browser's own online/visibility signals to this (see below), so App.js does
 * not have to, but the export exists so it can.
 */
export function reconnectSocket() {
  if (!socket) return connectSocket();
  if (socket.connected) return socket;
  const token = getToken();
  if (!token) return null;
  if (token !== socketToken) return connectSocket(); // rebuilds with new auth
  // A pending retry can be up to reconnectionDelayMax (30s) out, and calling
  // connect() while the manager is still "active" is a no-op — so a phone
  // waking from sleep would sit out the rest of a backoff timer it started
  // before it slept. Tear the stalled attempt down first, then dial now.
  if (socket.active) {
    try { socket.disconnect(); } catch { /* mid-teardown */ }
  }
  socket.connect();
  return socket;
}

export function disconnectSocket() {
  const stale = socket;
  socket = null;
  socketToken = null;
  dispose(stale);
  // The registry deliberately survives. Subscriptions belong to the
  // components that made them and are removed by their own unsubscribe
  // functions; a socket teardown must not silently cancel them, or a
  // reconnect would come back with nobody listening. That is the bug this
  // whole file was rewritten to fix.
}

// Recovery nudges. The browser tells us when the network came back or the tab
// became visible again; both are far better signals than a fixed timer, and
// both are throttled so a flapping connection cannot turn into a retry storm.
const NUDGE_INTERVAL_MS = 2000;
let lastNudge = 0;

function nudge() {
  if (!socket || socket.connected) return;
  const now = Date.now();
  if (now - lastNudge < NUDGE_INTERVAL_MS) return;
  lastNudge = now;
  reconnectSocket();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', nudge);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') nudge();
  });
  // api.js fires this after a 401 proves the token dead and clears it. The
  // socket is authenticated with that same token and would keep re-presenting
  // it on its retry schedule until the strike counter gave up; cut it loose
  // now instead. The registry survives, so the next sign-in's connectSocket()
  // comes back with every subscription intact.
  window.addEventListener('flock-session-expired', () => {
    disconnectSocket();
  });
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

// --- Venue rooms (live sensor + check-in feed) ---

export function joinVenueRoom(placeId) {
  if (socket?.connected && placeId) {
    socket.emit('join_venue', { placeId });
  }
}

export function leaveVenueRoom(placeId) {
  if (socket?.connected && placeId) {
    socket.emit('leave_venue', { placeId });
  }
}

export function onVenueSensorUpdate(callback) {
  return register('venue_sensor_update', callback);
}

export function onVenueCheckin(callback) {
  return register('venue_checkin', callback);
}

// Message bodies, image payloads and GPS fixes used to be console.logged on
// every send. On a phone that console is captured by the OS and by any crash/
// analytics SDK linked into the shell, which turns private chat and a user's
// exact location into log data nobody consented to. Nothing here logs content.
export function sendMessage(flockId, messageText, opts = {}) {
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
  return register('new_message', callback);
}

export function onUserTyping(callback) {
  return register('user_typing', callback);
}

export function onUserStoppedTyping(callback) {
  return register('user_stopped_typing', callback);
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
  return register('new_dm', callback);
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
  return register('dm_user_typing', callback);
}

export function onDmUserStoppedTyping(callback) {
  return register('dm_user_stopped_typing', callback);
}

// DM reactions
export function dmReact(dmId, emoji, receiverId) {
  if (socket?.connected) socket.emit('dm_react', { dmId, emoji, receiverId });
}

export function dmRemoveReact(dmId, emoji, receiverId) {
  if (socket?.connected) socket.emit('dm_remove_react', { dmId, emoji, receiverId });
}

export function onDmReactionAdded(callback) {
  return register('dm_reaction_added', callback);
}

export function onDmReactionRemoved(callback) {
  return register('dm_reaction_removed', callback);
}

// DM venue voting
export function dmVoteVenue(receiverId, venueName, venueId) {
  if (socket?.connected) socket.emit('dm_vote_venue', { receiverId, venue_name: venueName, venue_id: venueId });
}

export function onDmNewVote(callback) {
  return register('dm_new_vote', callback);
}

// DM pinned venue
export function dmPinVenue(receiverId, venueData) {
  if (socket?.connected) socket.emit('dm_pin_venue', { receiverId, venue_name: venueData.name, venue_address: venueData.addr, venue_id: venueData.place_id, venue_rating: venueData.rating, venue_photo_url: venueData.photo_url });
}

export function onDmVenuePinned(callback) {
  return register('dm_venue_pinned', callback);
}

// DM location sharing
export function dmShareLocation(receiverId, lat, lng) {
  if (socket?.connected) socket.emit('dm_share_location', { receiverId, lat, lng });
}

export function dmStopSharingLocation(receiverId) {
  if (socket?.connected) socket.emit('dm_stop_sharing_location', { receiverId });
}

export function onDmLocationUpdate(callback) {
  return register('dm_location_update', callback);
}

export function onDmMemberStoppedSharing(callback) {
  return register('dm_member_stopped_sharing', callback);
}

// --- Live location sharing ---

export function emitLocation(flockId, lat, lng) {
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
  return register('location_update', callback);
}

export function onMemberStoppedSharing(callback) {
  return register('member_stopped_sharing', callback);
}

// --- Friend requests ---

export function emitFriendRequest(toUserId) {
  if (socket?.connected) socket.emit('friend_request_sent', { toUserId });
}

export function emitFriendResponse(toUserId, action) {
  if (socket?.connected) socket.emit('friend_request_response', { toUserId, action });
}

export function onFriendRequestReceived(callback) {
  return register('friend_request_received', callback);
}

export function onFriendRequestResponded(callback) {
  return register('friend_request_responded', callback);
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
  return register('flock_invite_received', callback);
}

export function onFlockInviteResponded(callback) {
  return register('flock_invite_responded', callback);
}

// --- Flock venue votes (real-time) ---

export function onNewVote(callback) {
  return register('new_vote', callback);
}

// --- Venue confirmed ---

export function onVenueSelected(callback) {
  return register('venue_selected', callback);
}

// --- Flock message reactions (real-time) ---

export function onFlockReactionAdded(callback) {
  return register('flock_reaction_added', callback);
}

export function onFlockReactionRemoved(callback) {
  return register('flock_reaction_removed', callback);
}

// --- Flock lifecycle events ---

export function onFlockDeleted(callback) {
  return register('flock_deleted', callback);
}

export function onFlockUpdated(callback) {
  return register('flock_updated', callback);
}

export function onFlockMemberLeft(callback) {
  return register('flock_member_left', callback);
}

// Guest RSVPs come in from the public share link, so they never originate in a
// member's client. The socket is the only way they reach the host live. The
// server fans this out to each accepted member's personal room rather than the
// flock room, which a client only joins while it is on the chat screen.
export function onGuestRsvp(callback) {
  return register('guest_rsvp', callback);
}

// The server cuts a live connection loose when the session behind it stops
// being valid mid-flight (password change, account claim, ban, deletion,
// expiry) and says why first. Subscribe to send the user back to sign-in
// instead of leaving them on a screen that has quietly gone read-only.
export function onSessionRevoked(callback) {
  return register('session_revoked', callback);
}

// --- Budget events ---

export function onBudgetUpdated(callback) {
  return register('budget_updated', callback);
}

export function onBudgetLocked(callback) {
  return register('budget_locked', callback);
}

export function onBudgetReminder(callback) {
  return register('budget_reminder', callback);
}

// --- Billing events ---

export function onBillCreated(callback) {
  return register('bill_created', callback);
}

export function onShareSettled(callback) {
  return register('share_settled', callback);
}

export function onBillFullySettled(callback) {
  return register('bill_fully_settled', callback);
}

export function onGhostCommitted(callback) {
  return register('ghost_committed', callback);
}
