// ---------------------------------------------------------------------------
// Push Notification Helper
//
// Every push in the app goes through here. Three things happen before a
// notification is allowed out:
//   1. online check  — the user is already looking at the thing
//   2. visibility    — the user can still SEE the thing the push is about
//   3. debounce      — per conversation, not per person
// ---------------------------------------------------------------------------

const pool = require('../config/database');
const { isBlockedBetween } = require('../utils/blocks');
// Held as a module object, not destructured: routes and tests replace the
// exported function, and a destructured copy would keep calling the original.
const firebaseService = require('./firebaseService');

// Debounce map: key -> timestamp of last push sent
const lastPushSent = new Map();
const DEBOUNCE_MS = 30 * 1000;

// Clean up old entries every 5 minutes
const debounceSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of lastPushSent) {
    if (now - ts > DEBOUNCE_MS * 2) lastPushSent.delete(key);
  }
}, 5 * 60 * 1000);
// A cleanup timer must never be the reason the process stays up. Unreffed, the
// server (whose listening socket holds the loop open) is unaffected, but a
// short-lived process that merely REQUIRES this module can exit: `node --test`
// hung forever the moment a test touched anything that pulls in pushHelper.
if (typeof debounceSweep.unref === 'function') debounceSweep.unref();

// Check if a user is currently connected via Socket.io
function isUserOnline(io, userId) {
  if (!io) return false;
  const room = io.sockets.adapter.rooms.get(`user:${userId}`);
  return room && room.size > 0;
}

// ---------------------------------------------------------------------------
// Visibility gate
//
// A push is written at one moment and delivered at another. In between, the
// recipient can leave the flock, the flock can be deleted, or either side can
// block the other. Round 7: nothing re-checked any of that, so a member who
// left a flock at 6pm still got "It's happening!" at 8pm, a queued crowd alert
// still fired for a deleted flock, and the RSVP/friend-request pushes named a
// user the recipient had blocked. Every caller is gated here rather than in
// nine call sites that each have to remember.
// ---------------------------------------------------------------------------
function actorFrom(data = {}) {
  const raw = data.senderId != null ? data.senderId
    : data.fromUserId != null ? data.fromUserId
      : data.actorId != null ? data.actorId : null;
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function flockFrom(data = {}) {
  if (data.flockId === undefined || data.flockId === null) return null;
  const n = Number(data.flockId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function canNotify(userId, data = {}) {
  try {
    const actorId = actorFrom(data);
    if (actorId && Number(actorId) !== Number(userId)) {
      if (await isBlockedBetween(userId, actorId)) return false;
    }

    // One lookup answers all three questions: does the recipient still exist,
    // are they allowed to be here at all, and can they still see the thing.
    // Creator OR a member who has not walked away; 'invited' counts, since an
    // invite notification is the whole reason that row exists.
    const flockId = flockFrom(data);
    const r = await pool.query(
      `SELECT
         COALESCE(u.is_banned, false) AS is_banned,
         CASE WHEN $2::int IS NULL THEN true ELSE EXISTS (
           SELECT 1 FROM flocks f
           LEFT JOIN flock_members m ON m.flock_id = f.id AND m.user_id = u.id
           WHERE f.id = $2
             AND (f.creator_id = u.id OR m.status IN ('accepted', 'invited'))
         ) END AS can_see
       FROM users u
       WHERE u.id = $1`,
      [userId, flockId]
    );

    const row = r.rows[0];
    if (!row) return false;        // the account was deleted
    if (row.is_banned) return false; // no pulling a banned user back into an app that rejects them
    return row.can_see !== false;
  } catch (err) {
    // Fail open. A blip on the visibility query must not silence the entire
    // notification feature; the call sites already filtered membership once.
    console.error('[Push] visibility check failed:', err.message);
    return true;
  }
}

// Debounce is per CONVERSATION, not per person. Round 7: the key was the user
// id alone, so a DM from one friend swallowed a flock invite and a message in
// a different flock for the next 30 seconds, and the swallowed notification
// was never sent — the timer suppressed it, nothing batched it.
function debounceKey(userId, data = {}) {
  const type = data.type ? String(data.type) : 'generic';
  const scope = data.flockId != null ? `f${data.flockId}`
    : data.senderId != null ? `u${data.senderId}` : '';
  return `${userId}|${type}|${scope}`;
}

async function deliver(userId, title, body, data) {
  if (!(await canNotify(userId, data))) {
    return { skipped: true, reason: 'not-visible' };
  }
  return firebaseService.sendPushToUser(userId, title, body, data);
}

// Nothing below does any database work when push is not configured — several
// suites assert that a push-triggering route touches no unscripted query.
function disabled() {
  return !firebaseService.isEnabled();
}

// Send push only if user is offline
async function pushIfOffline(io, userId, title, body, data = {}) {
  if (isUserOnline(io, userId)) return { skipped: true, reason: 'online' };
  if (disabled()) return { skipped: true, reason: 'disabled' };
  return deliver(userId, title, body, data);
}

// Send push only if user is offline AND not debounced
async function pushIfOfflineDebounced(io, userId, title, body, data = {}) {
  if (isUserOnline(io, userId)) return { skipped: true, reason: 'online' };
  if (disabled()) return { skipped: true, reason: 'disabled' };

  const key = debounceKey(userId, data);
  const now = Date.now();
  const lastSent = lastPushSent.get(key);
  if (lastSent && now - lastSent < DEBOUNCE_MS) {
    return { skipped: true, reason: 'debounced' };
  }

  // Claimed before the send so two concurrent messages can't both pass, and
  // rolled back if the send never happened — otherwise a blocked or invisible
  // recipient burned the window for the next legitimate notification.
  lastPushSent.set(key, now);
  const result = await deliver(userId, title, body, data);
  // Release the window if nothing actually went out. A recipient who was
  // invisible, or who had no registered device at that instant, must not have
  // the next thirty seconds of their notifications suppressed on the strength
  // of a delivery that never happened.
  const nothingSent = !result || result.skipped || (result.sent === 0);
  if (nothingSent) lastPushSent.delete(key);
  return result;
}

// Send push regardless of online status (for explicit user actions like reminders)
async function pushAlways(userId, title, body, data = {}) {
  if (disabled()) return { skipped: true, reason: 'disabled' };
  return deliver(userId, title, body, data);
}

module.exports = {
  isUserOnline,
  pushIfOffline,
  pushIfOfflineDebounced,
  pushAlways,
  canNotify,
  debounceKey,
  // Test seam: the debounce window is process-global state.
  _resetDebounce: () => lastPushSent.clear(),
};
