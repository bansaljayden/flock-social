import { io } from 'socket.io-client';
import { getToken, BASE_URL } from './api';

let socket = null;
let socketToken = null;

/**
 * THIS DEVICE'S PUSH TOKEN, AND WHY A SOCKET CARRIES ONE.
 *
 * The backend used to suppress a push whenever ANY socket sat in the
 * recipient's `user:{id}` room. That is a statement about a connection, not
 * about a person, and it was wrong in both directions that matter: a phone
 * that had just been backgrounded still looked online for up to 85 seconds
 * (server.js sets pingTimeout 60000, pingInterval 25000), and a laptop tab
 * left open on flockcorp.com occupied that room forever, so the phone in the
 * owner's pocket received nothing, indefinitely, with no symptom at all.
 *
 * The fix needs the server to be able to tell WHICH device a connection speaks
 * for. The handshake is the cheapest place to say it: the FCM registration
 * token this browser or app already registered goes up alongside the JWT, so
 * services/pushHelper.js can line a live socket up with a row in device_tokens
 * and suppress only that device. A socket that names no token speaks for no
 * device and now silences nothing.
 *
 * It is pushed in here by services/firebase.js rather than read out of
 * localStorage, for the reason that file's own header gives: the storage key
 * belongs to one module, and a second copy of it is how a rename silently
 * unregisters everybody.
 */
let devicePushToken = null;

export function setDevicePushToken(token) {
  const next = typeof token === 'string' && token ? token : null;
  if (next === devicePushToken) return;
  devicePushToken = next;
  // The handshake is fixed at connect time, so a token that arrives or rotates
  // mid-session only reaches the server on the next one. Rebuild rather than
  // leave the connection claiming a device it no longer is.
  if (socket && socketToken) {
    const stale = socket;
    socket = null;
    dispose(stale);
    connectSocket();
  }
}

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

/**
 * ROOM REGISTRY — the same idea as the subscription registry, for membership.
 *
 * Room membership lives on the SERVER's socket object, so a reconnect starts
 * with none of it: socket.io hands the client a new server-side socket and
 * every `socket.join()` the old one had performed is gone. App.js emits
 * join_flock once, from an effect keyed on the selected flock, and join_venue
 * once per open venue sheet — neither re-runs when the connection drops and
 * comes back. The result was a socket that looked healthy and delivered
 * nothing room-scoped: typing indicators, live votes, presence, budget and
 * bill events, live sensor pushes. Nothing failed; the events were simply
 * addressed to a room this connection was no longer in, and the only cure was
 * leaving the chat and coming back.
 *
 * So intent is recorded here rather than fired and forgotten, and replayed on
 * every 'connect'. Recording it also fixes the narrower race that existed
 * before a drop: joinFlock() used to no-op outright while the socket was still
 * handshaking, so opening a chat during connect never joined at all.
 *
 * All three server handlers are safe to replay — join_flock re-verifies
 * membership, join_venue and join_venue_content re-check the place id against
 * the venues we already know, and all of them are idempotent (socket.join on a
 * room you already hold does nothing). Their rate limits (20, 30 and 30 per
 * 10s) are far above the one or two rooms a real client holds.
 */
const joinedFlocks = new Map(); // String(flockId) -> the id as the caller gave it
// The two venue registries count HOLDERS rather than simply record that this
// client wants the room, because two screens can hold the same venue room at
// once. The note above joinVenueRoom says what that cost while they were Sets.
const joinedVenues = new Map(); // place id -> how many screens want the live sensor and check-in feed
const joinedVenueContent = new Map(); // place id -> how many open cards want its reviews and promotions

function replayRooms(instance) {
  joinedFlocks.forEach((flockId) => instance.emit('join_flock', flockId));
  // A Map hands its forEach the VALUE first, and the value in both of these is a
  // reference count, so the place id is the SECOND argument. Reading the first
  // one here would replay every venue room under the name "1".
  joinedVenues.forEach((_holders, placeId) => instance.emit('join_venue', { placeId }));
  joinedVenueContent.forEach((_holders, placeId) => instance.emit('join_venue_content', { placeId }));
}

// Rooms are per-identity, unlike subscriptions. A sign-out or an account switch
// must not leave the next connection auto-joining the previous user's flocks:
// the server would refuse them, but asking is still wrong.
function clearRooms() {
  joinedFlocks.clear();
  joinedVenues.clear();
  joinedVenueContent.clear();
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
    // pushToken names the device this connection speaks for. See the block at
    // the top of the file. Omitted rather than sent as null when we do not
    // have one, so the server's "a socket that names no device suppresses
    // nothing" branch is reached by absence rather than by a sentinel.
    auth: devicePushToken ? { token, pushToken: devicePushToken } : { token },
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
    // Re-enter every room this client believes it is in. Fires on the first
    // connect too, which is harmless (the registry is empty) and is what makes
    // a join issued mid-handshake land instead of being dropped.
    replayRooms(instance);
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
    clearRooms();
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
  // Rooms do NOT survive, for the opposite reason subscriptions do: a room is a
  // fact about one authenticated connection, not a standing request by a
  // component. Sign-out and session expiry both land here.
  clearRooms();
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

function isHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function nudge() {
  if (!socket || socket.connected) return;
  // A HIDDEN DOCUMENT DOES NOT GET DIALLED BACK.
  //
  // 'online' fires whenever the device regains a network, and it fires whether
  // or not anybody is looking at this app. Without this guard the first wifi
  // blip after a tab went hidden rebuilt the connection that releaseWhileHidden
  // had just given up, and nothing ever released it again, because the only
  // thing that schedules a release is a visibilitychange INTO hidden, which
  // will not fire again while the tab stays hidden. So "hidden means gone"
  // held exactly until the network flickered once, and after that a backgrounded
  // app sat connected, occupying a server slot and claiming its device is being
  // looked at, for the rest of the session.
  //
  // Coming back is unaffected: visibilitychange -> visible calls nudgeNow(),
  // which is the path a returning user actually takes.
  if (isHidden()) return;
  const now = Date.now();
  if (now - lastNudge < NUDGE_INTERVAL_MS) return;
  lastNudge = now;
  reconnectSocket();
}

/**
 * HIDDEN MEANS GONE.
 *
 * This listener used to do one thing: reconnect when the tab came back. The
 * other half was missing, and it was the expensive half. A connection that is
 * merely OPEN was being read by the backend as "this person is looking at
 * this", so a tab left open on a laptop suppressed push notifications on the
 * owner's phone for as long as the tab existed. Nobody would ever have
 * diagnosed that: the app is open, the messages are there when you look, and
 * the phone is simply silent forever.
 *
 * So a hidden document now gives its socket up. Two timings:
 *
 *   native (Capacitor): immediately. A WKWebView goes hidden when the app is
 *   backgrounded, which is unambiguous. There is no such thing as glancing at
 *   another app for two seconds and expecting the socket to have survived, and
 *   holding it open is precisely the 85 second window that swallowed
 *   notifications on a phone that had just gone into a pocket.
 *
 *   web: after a short grace, because a hidden tab on a desktop is often a
 *   two second alt-tab, and tearing a websocket down and rebuilding it for
 *   that is worse for everyone. Fifteen seconds is longer than any glance and
 *   far shorter than the indefinite silence it replaces.
 *
 * Coming back is the path that already existed: nudge() reconnects, and the
 * 'connect' handler replays every room, so a chat that was open before the tab
 * was hidden is still live after it comes back.
 */
const HIDDEN_GRACE_MS = 15000;
let hiddenTimer = null;

function isNativeShell() {
  return typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true;
}

function cancelHiddenTimer() {
  if (hiddenTimer) {
    clearTimeout(hiddenTimer);
    hiddenTimer = null;
  }
}

// Give the connection up without forgetting anything. The instance is kept, so
// the room registry, the subscription registry and socketToken all survive and
// a later connect() comes back whole; only the transport goes.
function releaseWhileHidden(force = false) {
  hiddenTimer = null;
  // Re-checked at fire time, not at schedule time: the grace timer must not
  // tear down a tab the user came back to nine seconds in. pagehide passes
  // force, because a page being unloaded is gone whatever it says it is.
  if (!force && typeof document !== 'undefined' && document.visibilityState !== 'hidden') return;
  if (!socket || !socket.active) return;
  try { socket.disconnect(); } catch { /* already torn down */ }
}

// The throttle on nudge() exists to stop a flapping connection from becoming a
// retry storm. Coming back to a tab is not flapping, and letting an 'online'
// event a second earlier eat the reconnect is how an app comes back to the
// foreground still disconnected.
function nudgeNow() {
  lastNudge = Date.now();
  if (!socket || socket.connected) return;
  reconnectSocket();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', nudge);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      cancelHiddenTimer();
      nudgeNow();
      return;
    }
    cancelHiddenTimer();
    if (isNativeShell()) {
      releaseWhileHidden();
      return;
    }
    hiddenTimer = setTimeout(releaseWhileHidden, HIDDEN_GRACE_MS);
  });
  // A closing tab does not always fire visibilitychange in time, and a socket
  // the server has not noticed is gone is a device that keeps suppressing its
  // own notifications. This is best effort by definition and costs nothing
  // when it does not run.
  window.addEventListener('pagehide', () => {
    cancelHiddenTimer();
    releaseWhileHidden(true);
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

// Join is an intent, not a one-shot emit: it is remembered so the reconnect
// handler above can re-enter the room. See the room registry note.
export function joinFlock(flockId) {
  if (flockId == null) return;
  joinedFlocks.set(String(flockId), flockId);
  if (socket?.connected) socket.emit('join_flock', flockId);
}

export function leaveFlock(flockId) {
  if (flockId == null) return;
  // Forget it even while offline. Otherwise a user who closed a chat during an
  // outage would be silently re-joined to it on reconnect, and would keep
  // receiving that flock's messages and presence for the rest of the session.
  joinedFlocks.delete(String(flockId));
  if (socket?.connected) socket.emit('leave_flock', flockId);
}

// --- Venue rooms (live sensor + check-in feed) ---

/**
 * TWO SCREENS CAN HOLD ONE VENUE ROOM, SO THE HOLDERS ARE COUNTED.
 *
 * Same intent-not-emit treatment as joinFlock underneath everything below: the
 * live sensor and check-in feed is a room, so it goes silent after a reconnect
 * exactly the way the room registry note describes, and recording the join is
 * what lets the reconnect handler put this client back in it.
 *
 * What a Set could not express is that `venue:{placeId}` is joined by two
 * independent effects in App.js. The map bottom sheet joins it for whatever
 * venue is active, keyed on that venue alone, so its claim outlives a change of
 * screen. The venue owner's dashboard joins the same room for the owner's own
 * place id while that screen is up. A verified owner who taps their own venue on
 * the map and then opens their dashboard is therefore holding one room twice,
 * which the server is perfectly happy about, since socket.join on a room you
 * already hold does nothing.
 *
 * Leaving was the half that did not survive being held twice. The registry
 * recorded that this client wanted the room and not how many screens wanted it,
 * so the first cleanup to run deleted the id and emitted leave_venue, and the
 * server took the connection out of a room the other screen was still listening
 * to. The symptom was nothing at all. The listeners were still registered and
 * the reducers were still correct, and live sensor pushes and check-ins simply
 * stopped arriving on a sheet that looked exactly as it had a moment earlier.
 * Deleting the id also took it out of the replay registry, so the reconnect that
 * cures every other room-scoped silence in this file did not cure this one, and
 * the only way back was closing the sheet and opening it again.
 *
 * So a join increments and a leave decrements, and only the leave that takes the
 * count to zero drops the entry and tells the server. Each caller pairs exactly
 * one leave with one join, which is what React effect cleanup guarantees, so the
 * count is the number of screens that still want the feed. A leave for a room
 * this client is not holding emits nothing now, for the same reason: what a
 * leave releases is a claim, and there is no claim to release.
 */
export function joinVenueRoom(placeId) {
  if (!placeId) return;
  joinedVenues.set(placeId, (joinedVenues.get(placeId) || 0) + 1);
  if (socket?.connected) socket.emit('join_venue', { placeId });
}

export function leaveVenueRoom(placeId) {
  if (!placeId) return;
  const held = joinedVenues.get(placeId) || 0;
  if (held > 1) {
    joinedVenues.set(placeId, held - 1);
    return;
  }
  // Forgotten even while offline, for the reason leaveFlock gives: a room let go
  // during an outage must not be re-entered by the next replay.
  joinedVenues.delete(placeId);
  if (held === 1 && socket?.connected) socket.emit('leave_venue', { placeId });
}

// --- Venue content rooms (the open card's reviews and promotions) ---
//
// A SECOND room on the same place id, deliberately not the one above.
// `venue:{placeId}` is the crowd feed: joined from the map bottom sheet and
// from the venue owner's own dashboard. `venue_content:{placeId}` is the set of
// screens holding the PUBLIC reviews and promotions a moderator takedown has to
// retract from, and the venue detail card that holds them also opens from a
// flock card, a search result and a chat share, with no map pin involved.
// backend/sockets/handlers.js explains at length why merging the two would both
// miss viewers and reach people who hold none of that state.
//
// Same intent-not-emit treatment as the rooms above, so the retraction survives
// a reconnect; without it a card left open across a tunnel goes back to keeping
// hidden content on screen, which is the exact bug the room was added to fix.
//
// Counted the same way as the crowd room above, and for a reason that is one
// effect away rather than already here. Only the venue detail card joins this
// room today, so it is held once. But that card opens from a map pin, a flock
// card, a search result and a chat share, and the moment anything else on screen
// wants the same retraction, an uncounted leave is the silent bug described
// above, in the registry whose whole job is taking hidden content off a screen.
// Twin registries where one counts its holders and the other does not is also
// how the wrong one gets copied.
export function joinVenueContentRoom(placeId) {
  if (!placeId) return;
  joinedVenueContent.set(placeId, (joinedVenueContent.get(placeId) || 0) + 1);
  if (socket?.connected) socket.emit('join_venue_content', { placeId });
}

export function leaveVenueContentRoom(placeId) {
  if (!placeId) return;
  const held = joinedVenueContent.get(placeId) || 0;
  if (held > 1) {
    joinedVenueContent.set(placeId, held - 1);
    return;
  }
  joinedVenueContent.delete(placeId);
  if (held === 1 && socket?.connected) socket.emit('leave_venue_content', { placeId });
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

// A message carries text, an image, or both. `image_url` was missing from this
// emitter entirely — the same omission just fixed in api.js, on the other
// transport — and the gap was papered over by sendImageMessage() below, which
// hardcoded `message_text: ''`. Between them, a CAPTIONED photo could not be
// sent over the socket at all: callers had to pick one emitter, so the caption
// was dropped on the primary transport and kept on the REST fallback, and the
// same photo arrived with different content depending on the network.
//
// The body is shaped to match api.js's sendMessage() field for field
// (`message_text` defaulted to '', `message_type` defaulted to 'text',
// venue_data and image_url nulled when absent) so the two transports cannot
// drift apart again.
//
// Returns whether the emit actually happened. Every helper in this file
// silently no-ops while the socket is down, which is correct for a typing
// indicator and not correct for a message: callers gate on getSocket()
// ?.connected today, and this closes the window between that check and the
// emit.
export function sendMessage(flockId, messageText, opts = {}) {
  if (!socket?.connected) return false;
  socket.emit('send_message', {
    flockId,
    message_text: messageText || '',
    message_type: opts.message_type || 'text',
    venue_data: opts.venue_data || null,
    image_url: opts.image_url || null,
    thumb_url: opts.thumb_url || null,
  });
  return true;
}

// Kept as a named export because callers import it, but it is now a thin
// spelling of sendMessage rather than a second, subtly different code path —
// which is what let the two drift in the first place. A caption passed here is
// carried instead of discarded.
export function sendImageMessage(flockId, imageUrl, opts = {}) {
  return sendMessage(flockId, opts.message_text || '', {
    ...opts,
    message_type: 'image',
    image_url: imageUrl,
  });
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

/**
 * The server's generic refusal channel: moderation rejections, rate limits,
 * "that photo is too large", "you can no longer message this user". Every one
 * of those is a sentence written for a person, and the REST twin of the same
 * refusal already becomes a toast — over the socket they only ever reached
 * console.warn, so a send the server threw out failed in silence.
 *
 * It goes through the registry rather than being bound to whatever instance
 * getSocket() happens to return, which is the whole point of the registry: a
 * listener attached directly to one socket object is lost the moment that
 * object is replaced (token swap, fatal-auth teardown, session expiry), and a
 * listener attached before connectSocket() has run is never attached at all.
 */
export function onSocketError(callback) {
  return register('error', callback);
}

// --- Direct messages ---

export function socketSendDm(receiverId, messageText, opts = {}) {
  if (!socket?.connected) return false;
  socket.emit('send_dm', {
    receiverId,
    // `|| ''` for the same reason as sendMessage above: message_text is NOT
    // NULL on both tables, and api.js's sendDM already normalises it this way.
    message_text: messageText || '',
    message_type: opts.message_type || 'text',
    venue_data: opts.venue_data || null,
    image_url: opts.image_url || null,
    thumb_url: opts.thumb_url || null,
    reply_to_id: opts.reply_to_id || null,
  });
  return true;
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
// Each answers whether the emit happened. A guarded emit over a dead socket
// used to return nothing, so the caller drew nothing, stored nothing and
// said nothing; the screen now falls back to REST when this answers false.
export function dmReact(dmId, emoji, receiverId) {
  if (!socket?.connected) return false;
  socket.emit('dm_react', { dmId, emoji, receiverId });
  return true;
}

export function dmRemoveReact(dmId, emoji, receiverId) {
  if (!socket?.connected) return false;
  socket.emit('dm_remove_react', { dmId, emoji, receiverId });
  return true;
}

export function onDmReactionAdded(callback) {
  return register('dm_reaction_added', callback);
}

export function onDmReactionRemoved(callback) {
  return register('dm_reaction_removed', callback);
}

// DM venue voting
//
// Answers whether the vote actually left the device, the same contract
// socketSendDm has carried since the failed-message row was added. A guarded
// emit that returns nothing is how the DM vote panel came to flip a tile, raise
// a count and write the voter's own name into the list over a socket that had
// sent nothing at all: there was no answer to reconcile against, so there was
// no rollback and no sentence. The caller needs the answer, so it gets one.
export function dmVoteVenue(receiverId, venueName, venueId) {
  if (!socket?.connected) return false;
  socket.emit('dm_vote_venue', { receiverId, venue_name: venueName, venue_id: venueId });
  return true;
}

export function onDmNewVote(callback) {
  return register('dm_new_vote', callback);
}

// DM pinned venue
// Same contract as dmReact: false means nothing left the device, and the
// caller persists over REST instead of letting the pin revert on the next load.
export function dmPinVenue(receiverId, venueData) {
  if (!socket?.connected) return false;
  socket.emit('dm_pin_venue', { receiverId, venue_name: venueData.name, venue_address: venueData.addr, venue_id: venueData.place_id, venue_rating: venueData.rating, venue_photo_url: venueData.photo_url });
  return true;
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

// The server fires this when the person you are sharing your live location
// with in a DM blocks you, so the client can stop the 10-second emit loop
// instead of pushing coordinates the server is already dropping. App.js bound
// it straight to getSocket(), which is the exact failure mode the registry
// exists to prevent — after a rebuild the loop kept running.
export function onBlockedBy(callback) {
  return register('blocked_by', callback);
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

// --- Availability pulses ---

// A friend setting or clearing their "down tonight" pulse. Was bound directly
// to getSocket() in App.js, in an effect with an empty dependency array, so it
// was welded to whichever instance existed at mount and never re-attached.
export function onAvailabilityUpdated(callback) {
  return register('availability_updated', callback);
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

// --- Safety ---
//
// Somebody on a plan you are confirmed for, happening around now, pressed SOS.
// routes/safety.js emits this to each qualifying member's own user room after
// it has already emailed their trusted contacts, so by the time this arrives
// the external half has been done and this is the people in the room.
//
// The payload carries fromUserId, fromUserName, an ISO `at`, and latitude and
// longitude ONLY when the sender chose to share them. Absent rather than null,
// so a consumer cannot mistake "did not share" for "shared nothing".
export function onSafetyAlertCancelled(callback) {
  return register('safety_alert_cancelled', callback);
}

export function onSafetyAlert(callback) {
  return register('safety_alert', callback);
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

// routes/flocks.js POST /:id/attendance emits this to each scored member's
// user room, carrying the fresh score. Until this listener existed the emit
// reached the client and fell on the floor: the profile's reliability number
// stayed whatever it was at boot until the next full relaunch.
export function onReliabilityUpdated(callback) {
  return register('reliability_updated', callback);
}

// Unsend fan-outs: the flock one respects block filtering server-side, the
// DM one goes to exactly the two participants.
export function onFlockMessageUnsent(callback) {
  return register('flock_message_unsent', callback);
}

export function onDmMessageUnsent(callback) {
  return register('dm_message_unsent', callback);
}

// Guest RSVPs come in from the public share link, so they never originate in a
// member's client. The socket is the only way they reach the host live. The
// server fans this out to each accepted member's personal room rather than the
// flock room, which a client only joins while it is on the chat screen.
export function onGuestRsvp(callback) {
  return register('guest_rsvp', callback);
}

// --- Moderation takedowns ---

/**
 * A moderator took a piece of content down, or put it back.
 *
 * backend/routes/admin.js emits these AFTER the takedown transaction commits,
 * carrying { contentType, contentId, flockId } and nothing else — no moderator,
 * no reason, no reporter. contentType is one of the keys of TAKEDOWN_TARGETS
 * there: flock_message, dm, story, venue_review, venue_promotion, venue_event,
 * guest_rsvp. How far each one reaches differs by type, and the venue types
 * were WIDENED (backend commit fcb3236) after this note first claimed the
 * author or the owner was the whole audience:
 *
 *   flock_message, guest_rsvp   the flock room.
 *   dm                          both parties.
 *   venue_review                the author AND every socket in
 *                               venue_content:{placeId}, which is every card
 *                               currently showing that venue's reviews.
 *   venue_promotion             the venue owner AND that same room.
 *   venue_event, story          the owner / the author alone, because nothing
 *                               public serves either one yet.
 *
 * So a handler must not assume the person receiving it wrote it, or even that
 * they have any relationship to it beyond having the card open. The room emit
 * is NOT de-duplicated against the personal ones, so an author looking at their
 * own review is told twice; every reducer on the App.js side is idempotent and
 * returns the same array when nothing matched, which is what makes that safe.
 *
 * Both go through the registry rather than getSocket().on(...), for the reason
 * the top of this file exists. A takedown is rare: a listener welded to one
 * instance would work in every test and then be silently dead in production the
 * first time a token swap, a fatal-auth teardown or a session expiry replaced
 * the socket underneath it — and nobody would notice, because the symptom is
 * content that quietly fails to disappear.
 */
export function onContentRemoved(callback) {
  return register('content_removed', callback);
}

// The console's live signal. Emitted per admin by services/moderationAlerts.js
// since the alerts shipped; nothing on the client had ever registered it, so
// an open queue learned of a new report from a sixty-second poll.
export function onModerationReport(callback) {
  return register('moderation_report', callback);
}

// The un-hide is a SEPARATE event on the server on purpose: a client that has
// already dropped the row needs a different instruction from one that still has
// it, and "removed" meaning "put it back" is the kind of name that gets handled
// wrong once and stays wrong. So it is a separate subscription here too.
export function onContentRestored(callback) {
  return register('content_restored', callback);
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

// The report taken back. Emitted by the unsettle route since it shipped;
// this registration is what was missing on the client.
export function onShareUnsettled(callback) {
  return register('share_unsettled', callback);
}

export function onBillFullySettled(callback) {
  return register('bill_fully_settled', callback);
}

// The tally over every row after a settlement moved. It names nobody, so it
// is the one settlement event a viewer who has blocked the actor still
// receives; ChatDetail's header reads it for the rows it cannot see.
export function onBillTally(callback) {
  return register('bill_tally', callback);
}

export function onGhostCommitted(callback) {
  return register('ghost_committed', callback);
}
