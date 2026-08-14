// ---------------------------------------------------------------------------
// Push Notification Helper
//
// Every push in the app goes through here. Three things happen before a
// notification is allowed out:
//   1. online check  — the user is already looking at the thing
//   2. visibility    — the user can still SEE the thing the push is about
//   3. debounce      — per conversation, not per person
//
// ---------------------------------------------------------------------------
// App Review 4.5.4 — the classification every push in this app lives under
//
// The guideline (current text, developer.apple.com/app-store/review/guidelines):
//   "Push Notifications must not be required for the app to function, and
//    should not be used to send sensitive personal or confidential
//    information. Push Notifications should not be used for promotions or
//    direct marketing purposes unless customers have explicitly opted in to
//    receive them via consent language displayed in your app's UI, and you
//    provide a method in your app for a user to opt out from receiving such
//    messages."
//
// Every push this backend sends today is TRANSACTIONAL: it reports a concrete
// thing that happened to a plan, conversation, or account the recipient is
// already part of. The full inventory, by data.type:
//
//   flock_invite       someone invited the recipient          (routes/flocks.js)
//   flock_rsvp         someone joined the recipient's flock   (routes/flocks.js)
//   flock_confirmed    a plan the recipient accepted is on    (routes/flocks.js)
//   attendance_marked  the recipient's own score changed      (routes/flocks.js)
//   flock_message      chat in a flock they belong to         (routes/messages.js, sockets/handlers.js)
//   dm_message         a DM addressed to them                 (routes/messages.js, sockets/handlers.js)
//   friend_request     someone asked to be their friend       (routes/friends.js)
//   guest_rsvp         a guest joined the host's flock        (routes/guest.js)
//   budget_ready       their group's budget resolved          (routes/budget.js)
//   budget_reminder    the organizer asked them to submit     (routes/budget.js, user-initiated)
//   bill_created       they owe a share of a real bill        (routes/billing.js)
//   moderation_report  admin-only: a report needs review      (services/moderationAlerts.js)
//   crowd_alert        forecast for an event they committed to (services/crowdAlerts.js)
//
// crowd_alert is the only push not directly triggered by a person's action, so
// it sits closest to the 4.5.4 line and carries its own user switch
// (user_settings.settings.crowdAlerts). That switch is enforced twice: at the
// producer (services/crowdAlerts.js filters recipients before claiming the
// alert) and again below in deliver(), so no future caller can reuse the type
// and skip the check.
//
// THE RULE FOR ADDING A PUSH. If the notification promotes anything — Flock
// Pro, an upgrade, a venue's offer or slow night, a discount, a "we miss you"
// re-engagement nudge — it is a promotion or direct marketing under 4.5.4 and
// it MUST NOT ship on the transactional inventory above. It needs its own
// explicit opt-IN collected through consent language in the app UI (not a
// pre-checked default, not this file's default-on switch), its own opt-out,
// and its own data.type so both are enforceable here. No such push exists
// today; do not be the first without all three pieces.
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

    // One lookup answers all four questions: does the recipient still exist,
    // are they allowed to be here at all, can they still see the thing, and is
    // the person this push NAMES still an account in good standing.
    // Creator OR a member who has not walked away; 'invited' counts, since an
    // invite notification is the whole reason that row exists.
    //
    // Round 18: the actor half was missing. Every push that names somebody
    // ("{name} invited you to a flock", "You owe {name} $12", "{name} in
    // {flock}") was gated on the RECIPIENT's ban state and never the sender's,
    // so a banned or deleted account's display name still landed on a lock
    // screen, where it stays until it is dismissed — the same reach the block
    // gate two lines up exists to deny. A missing actor row is treated as
    // banned: an id that no longer resolves to a user is not somebody we can
    // vouch for naming.
    // The actor branch is spliced in only when there IS an actor, so a push
    // that names nobody (an admin moderation alert) still asks the database
    // exactly the questions it has rather than binding a third parameter that
    // means nothing. Nothing user-supplied reaches the SQL text: the only two
    // possible values below are a literal `false` and the bind marker itself.
    const flockId = flockFrom(data);
    const actorClause = actorId
      ? 'COALESCE((SELECT COALESCE(a.is_banned, false) FROM users a WHERE a.id = $3), true)'
      : 'false';
    const r = await pool.query(
      `SELECT
         COALESCE(u.is_banned, false) AS is_banned,
         ${actorClause} AS actor_banned,
         CASE WHEN $2::int IS NULL THEN true ELSE EXISTS (
           SELECT 1 FROM flocks f
           LEFT JOIN flock_members m ON m.flock_id = f.id AND m.user_id = u.id
           WHERE f.id = $2
             AND (f.creator_id = u.id OR m.status IN ('accepted', 'invited'))
         ) END AS can_see
       FROM users u
       WHERE u.id = $1`,
      actorId ? [userId, flockId, actorId] : [userId, flockId]
    );

    const row = r.rows[0];
    if (!row) return false;        // the account was deleted
    if (row.is_banned) return false; // no pulling a banned user back into an app that rejects them
    if (row.actor_banned) return false; // a removed account does not get to keep announcing itself
    return row.can_see !== false;
  } catch (err) {
    // FAIL CLOSED. This was the one block-enforcement point in the codebase
    // that failed open, and it was the loudest one: a push is delivered to a
    // phone's lock screen, so a database blip here pushed a blocked user's NAME
    // ("{name} invited you to a flock", "You owe {name} $12") to the person who
    // blocked them, where it stays until it is dismissed. Every sibling check
    // already fails closed for exactly this reason — utils/blocks.js throws out
    // to the caller's guard, announceToRoomExcludingBlocked stays silent,
    // routes/moderation.js refuses — and a rule that holds only while the
    // database is healthy is not the guarantee Apple 1.2 asks for.
    //
    // The cost of being wrong in this direction is a notification that arrives
    // late or not at all, which the app recovers from the moment the user opens
    // it; the cost in the other direction cannot be taken back.
    console.error('[Push] visibility check failed, suppressing push:', err.message);
    return false;
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

// ---------------------------------------------------------------------------
// The crowd-alert switch (see the 4.5.4 block above)
//
// Stored in user_settings.settings (JSONB), key `crowdAlerts`, default ON.
// The default is defensible only because the alert is transactional: it fires
// for a flock the recipient ACCEPTED, inside the 3 hours before an event they
// committed to, at most once per flock. A promotional push could not inherit
// this default; 4.5.4 requires explicit opt-in for those.
//
// WHY IT TOLERATES A STRING. frontend/src/services/userSettings.js pullSettings
// writes every synced value into localStorage with String(value), and
// readLocalSettings pushes those raw strings back up on a first sync — so a
// boolean false round-trips into this column as the JSON string "false". A
// reader that only understood booleans would read a switched-off account as
// switched on, which is exactly the failure this code exists to prevent.
//
// Anything we cannot read means UNSET, not off: junk in the blob must not
// silently stop a notification the user never asked to stop.
const CROWD_ALERT_KEY = 'crowdAlerts';
const OFF_VALUES = new Set(['false', '0', 'off', 'no']);

function wantsCrowdAlerts(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return true;
  const v = settings[CROWD_ALERT_KEY];
  if (v === undefined || v === null) return true;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return !OFF_VALUES.has(v.trim().toLowerCase());
  return true;
}

// Fail OPEN, and the asymmetry with canNotify's fail-closed is deliberate. The
// preference's own doctrine is "unreadable means unset, unset means on": a
// database blip here must not silently stop an alert the user never switched
// off. The stakes are also different in kind — canNotify fails closed because
// delivering to the wrong person cannot be taken back, while this check only
// decides whether a person who never opted out hears about their own evening.
// A user who DID opt out and hits this window gets one alert at most (the
// crowd_alert_sends claim), not a stream. The safety gate below still runs
// either way.
async function crowdAlertOptedOut(userId) {
  try {
    const r = await pool.query(
      'SELECT settings FROM user_settings WHERE user_id = $1',
      [userId]
    );
    return !wantsCrowdAlerts(r.rows.length ? r.rows[0].settings : null);
  } catch (err) {
    return false;
  }
}

async function deliver(userId, title, body, data) {
  // Enforced HERE, not only in the producer: services/crowdAlerts.js filters
  // its recipients before claiming the alert, but a chokepoint check is what
  // makes "the user's switch works" a property of the type rather than a habit
  // of the one caller that currently sends it.
  if (data && String(data.type || '') === 'crowd_alert' && (await crowdAlertOptedOut(userId))) {
    return { skipped: true, reason: 'opted-out' };
  }
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

// Send push regardless of online status. Two callers, both time-sensitive
// enough that "already in the app" is not a reason to stay silent: the
// organizer-initiated budget reminder (routes/budget.js) and the pre-event
// crowd alert (services/crowdAlerts.js). Not a channel for anything
// promotional — see the 4.5.4 block at the top of this file.
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
  // The crowd-alert preference reader. services/crowdAlerts.js uses it to
  // filter recipients before burning the once-per-flock claim; deliver() above
  // re-checks it at send time.
  wantsCrowdAlerts,
  // Background producers (services/crowdAlerts.js) ask this BEFORE they do the
  // scoring and the paid weather call that build a notification nothing can
  // deliver — and, just as importantly, before they write a marker row saying
  // the notification was already sent.
  isPushConfigured: () => !disabled(),
  // Test seam: the debounce window is process-global state.
  _resetDebounce: () => lastPushSent.clear(),
};
