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

// ---------------------------------------------------------------------------
// THE DELIVERY LEDGER (migration 050, table push_sends)
//
// Until 2026-08-25 nobody could answer "has a single push ever been delivered
// in production". sendPushToUser answered { sent, failed } and every caller
// except services/crowdAlerts.js discarded it, so a notification that never
// left the building and one that landed on a lock screen left identical
// evidence behind: none.
//
// This is deliberately the SMALLEST thing that answers the question honestly,
// not an analytics pipeline. One row per push attempt, written here because
// here is the one place every push in the app passes through, plus one
// structured console line so the same answer is greppable in Railway logs
// without a database at all.
//
// WHAT IT DOES NOT STORE: the title, the body, or any token. A notification
// body is a private message and a lock-screen preview. It has no business
// outliving the notification inside a counts table.
//
// HOW TO READ IT (this is the query, there is no dashboard yet, because the
// admin cost panel is rendered from frontend/src/App.js which this change does
// not own):
//
//   SELECT date_trunc('day', created_at) AS day, push_type, outcome,
//          COUNT(*) AS pushes, SUM(devices_sent) AS devices
//     FROM push_sends
//    WHERE created_at >= NOW() - INTERVAL '7 days'
//    GROUP BY 1, 2, 3
//    ORDER BY 1 DESC, pushes DESC;
//
// pushDeliveryStats() below returns exactly that rollup, so a panel line is
// one call away whenever App.js is free to take it.
//
// Retention is 30 days (sweepPushMaintenance). "Did pushes go out this week"
// is the question; a year of rows answers it no better.
// ---------------------------------------------------------------------------
const OUTCOME = {
  DELIVERED: 'delivered',
  NO_DEVICE: 'no-device',
  FAILED: 'failed',
  ONLINE: 'online',
  DEBOUNCED: 'debounced',
  NOT_VISIBLE: 'not-visible',
  // "The visibility check itself failed", as opposed to NOT_VISIBLE's "we
  // checked and the answer was no". Both suppress the push - canNotify fails
  // closed on purpose and that does not change - but only one of them is a
  // permanent property of the recipient. The outbox sweep used to read them as
  // the same thing and DELETE the row, so a Postgres blip during the 08:00
  // release of a quiet-hours DM destroyed the notification outright: the retry
  // rows, the TTLs and the FOR UPDATE SKIP LOCKED this whole file exists for
  // never engaged, and the ledger recorded it as a legitimate suppression.
  UNCHECKABLE: 'visibility-uncheckable',
  OPTED_OUT: 'opted-out',
  QUIET_HELD: 'quiet-held',
  QUIET_DROPPED: 'quiet-dropped',
  EXPIRED: 'expired',
};
const LEDGER_RETENTION_DAYS = 30;

// ---------------------------------------------------------------------------
// QUIET HOURS
//
// WHAT "NIGHT" MEANS FOR THIS PRODUCT. The obvious quiet window for a consumer
// app is something like 21:00 to 08:00. Applied here it would delete the app.
// Flock exists so that people aged 15 to 22 can arrange to go out, and going
// out happens between roughly 20:00 and 01:00. Those are the hours the product
// is FOR. Muting them would mean the invite, the "we moved to the other bar"
// and the "where are you" all arrive silently at exactly the moment they are
// the only thing that matters.
//
// The window that is actually dead for this audience is the one AFTER the
// night ends and BEFORE the day starts: people get home somewhere between
// 01:00 and 02:00, and school or an early shift starts around 08:00. So:
//
//     quiet hours are 02:00 to 08:00, on the RECIPIENT's clock.
//
// 02:00 rather than 01:00 because a group still out at 01:30 is still
// coordinating, and a phone that is in someone's hand at 01:30 has a live
// socket anyway, so presence already suppresses it. 08:00 rather than 09:00
// because this audience is awake for school before 09:00, and a message held
// past the moment they wake up is a message they read in the app first, which
// makes the notification pointless.
//
// THEY DEFER, THEY DO NOT DROP. A quiet-hours push is written to push_outbox
// and released when the window closes. Dropping would mean the product
// silently decides which of your messages you are allowed to be told about.
// Deferring costs one notification at 08:00 that collapses, on the device,
// with every other message from the same conversation (services/firebaseService
// .js sets an apns-collapse-id and an Android collapseKey per conversation), so
// a forty-message group chat overnight is one line in the morning.
//
// WHY THIS IS THE HIGHEST-VALUE ITEM IN THE FILE. The failure it prevents is
// not "a user is mildly annoyed". It is a 15 year old whose phone rings at
// 03:00, who turns notifications off in iOS Settings, which iOS never asks
// about again. That is one user permanently unreachable per incident, and it
// is unrecoverable without them going and finding the switch themselves.
//
// WHAT BREAKS THROUGH. Two kinds, and the list is short on purpose:
//   * safety. An SOS is the one message whose entire value is that it wakes
//     somebody up. No producer sends these types today (routes/safety.js
//     alerts trusted contacts by email and socket), so the entries below are
//     the reservation: the day an SOS push is written it is already exempt,
//     rather than someone having to remember to exempt it.
//   * moderation_report, which is admin-only and includes child-safety
//     reports. There is one admin, and a child-safety report at 03:00 is
//     exactly the thing that should wake him.
// Nothing else. Not a DM, not a flock invite, not "your plan is confirmed".
//
// WHAT IS DROPPED RATHER THAN HELD. crowd_alert, and only crowd_alert. It
// fires inside the three hours before an event and says "head out now"; held
// until 08:00 it is a sentence about an evening that already happened. It is
// also the app's only unsolicited push, so the one hour it must not arrive at
// is the one nobody asked for it in. services/crowdAlerts.js releases its
// once-per-flock claim when nothing was delivered, so the flock is not
// permanently marked as alerted.
//
// WHOSE CLOCK. device_tokens.timezone, the IANA name the device itself reports
// (migration 050). NULL means unknown, and unknown means DO NOT DEFER: holding
// a message for six hours because we guessed the wrong continent is a worse
// failure than one badly timed notification. PUSH_QUIET_DEFAULT_TZ exists as an
// explicit opt-in for rows that predate the column, and is unset by default.
// ---------------------------------------------------------------------------
const QUIET_START_HOUR = 2;
const QUIET_END_HOUR = 8;
const RINGS_THROUGH_THE_NIGHT = new Set([
  'sos',
  'emergency_alert',
  'safety_alert',
  // The withdrawal of the above. Anyone it reaches was already woken by the
  // alarm and is worrying or moving; an all-clear held until morning is a
  // night spent acting on an emergency that ended.
  'safety_alert_cancelled',
  'moderation_report',
]);
const DROPPED_IN_QUIET_HOURS = new Set(['crowd_alert']);

// Types whose PRODUCER already owns a durable retry, so the outbox must keep
// its hands off them or the same notification goes out twice.
//
// crowd_alert is the one. services/crowdAlerts.js releases its
// crowd_alert_sends claim whenever nothing was delivered, which means the next
// 15 minute sweep rebuilds and re-sends the alert by itself. An outbox retry on
// top of that is two copies of the same push racing each other, and the alert
// is the app's only unsolicited notification, so a duplicate is the worst place
// to have one. The claim is also strictly better than a retry here: it re-scores
// the venue against a fresh forecast instead of replaying an old sentence.
const OWN_RETRY = new Set(['crowd_alert']);

// ---------------------------------------------------------------------------
// THE OUTBOX (migration 050, table push_outbox)
//
// Two reasons a push is written now and delivered later:
//
//   'retry'  the provider failed transiently. firebase-admin retries a send
//            four times by itself and services/firebaseService.js races that
//            with an 8 second deadline ON PURPOSE. Read the SEND_TIMEOUT_MS
//            comment there before touching it: the deadline is what makes "a
//            notification failing is never something a user experiences as the
//            app hanging" a property of the code rather than a habit of each
//            caller. So the retry cannot live inside the send, and it must not
//            extend the deadline. It lives out here, where a later sweep takes
//            another run at it with nothing waiting on the answer.
//
//   'quiet'  the quiet-hours hold described above.
//
// This is the crowd_alert_sends pattern (migration 007) generalised: durable
// state, claimed in SQL with FOR UPDATE SKIP LOCKED, so two Railway instances
// cannot both release the same row.
// ---------------------------------------------------------------------------
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_TTL_MS = 30 * 60 * 1000;
const QUIET_TTL_MS = 12 * 60 * 60 * 1000;
const OUTBOX_BATCH = 50;
const OUTBOX_SWEEP_MS = 60 * 1000;
// Five consecutive empty sweeps and the timer stands down. It is restarted by
// the next enqueue, and services/crowdAlerts.js sweeps every 15 minutes
// regardless, so a row can never be stranded by the timer having stopped.
const OUTBOX_IDLE_SWEEPS = 5;

// FCM expires a registration token after roughly 270 days of app inactivity.
// A row older than that is a guaranteed failed send forever, so it is deleted
// rather than retried until the end of time. 270 and not 90: updated_at is now
// a liveness timestamp (see touchDeviceTokens), but the only events that write
// it are a registration and a clean send, and a real person can go a long time
// between both without uninstalling anything.
const TOKEN_MAX_IDLE_DAYS = 270;

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

// Check if a user is currently connected via Socket.io.
//
// Still exported, still true when ANY socket sits in the room, because two
// other things read it for what it actually says. It is no longer, on its own,
// a reason to suppress a notification. See everyDeviceAttended below.
function isUserOnline(io, userId) {
  if (!io) return false;
  const room = io.sockets.adapter.rooms.get(`user:${userId}`);
  return room && room.size > 0;
}

// ---------------------------------------------------------------------------
// PRESENCE IS NOT ATTENTION
//
// THE BUG THIS REPLACES, which was the worst one in the push path. Push was
// suppressed whenever any socket sat in `user:{id}`. server.js sets
// pingTimeout 60000 and pingInterval 25000, so for up to about 85 seconds
// after a phone was backgrounded the server still believed the user was
// looking and dropped the notification with nothing queued behind it. Far
// worse and with no time limit at all: an open laptop tab occupies that room
// forever, so leaving flockcorp.com open on a laptop killed push on the
// owner's phone indefinitely, with no symptom and nothing in any log.
//
// The premise was wrong on both counts. A socket means a CONNECTION exists. It
// does not mean a person is looking, and it says nothing whatsoever about the
// other device in their pocket.
//
// THE RULE NOW: a push is suppressed only when EVERY device that could receive
// it is already attended. A device is attended when it has a live socket that
// names it. Anything else, including one unaccounted-for device, sends.
//
// HOW A SOCKET NAMES ITS DEVICE. frontend/src/services/socket.js puts this
// browser or app's FCM registration token in the handshake auth alongside the
// JWT, so the server can line a live connection up with a row in device_tokens
// without a new socket event and without trusting anything but a value that is
// already the user's own. A socket that names no token attends no device: an
// unidentifiable connection can no longer silence anything, which is exactly
// the property the old rule lacked.
//
// AND THE 85 SECONDS. The client half closes it from the other side:
// socket.js now tears the connection down when the tab or the app goes hidden,
// immediately on native and after a short grace on the web, so "has a live
// socket" means "is in the foreground" rather than "was in the foreground
// within the last minute and a half". What remains is a device that dies
// without warning (a tunnel, a dead battery), whose own token stays attended
// for up to pingTimeout plus pingInterval. That is one device, for 85 seconds,
// and it no longer takes the rest of the account down with it.
// ---------------------------------------------------------------------------
function attentiveTokens(io, userId) {
  const claimed = new Set();
  if (!io) return claimed;
  const room = io.sockets.adapter && io.sockets.adapter.rooms
    ? io.sockets.adapter.rooms.get(`user:${userId}`)
    : null;
  if (!room) return claimed;
  // A room with no socket registry behind it (which is what a partial stub in a
  // test is) names no device, so it speaks for none. Fail toward sending.
  const registry = io.sockets.sockets;
  if (!registry || typeof registry.get !== 'function') return claimed;
  for (const socketId of room) {
    const s = registry.get(socketId);
    const token = s && s.handshake && s.handshake.auth && s.handshake.auth.pushToken;
    // Bounded the same way routes/notifications.js bounds a registration, so a
    // client cannot park anything large in a Set the send path iterates.
    if (typeof token === 'string' && token.length >= 8 && token.length <= 1024) {
      claimed.add(token);
    }
  }
  return claimed;
}

async function everyDeviceAttended(io, userId) {
  const claimed = attentiveTokens(io, userId);
  try {
    const r = await pool.query(
      'SELECT token FROM device_tokens WHERE user_id = $1',
      [userId]
    );
    // No registered device: vacuously true, and there was nothing to deliver
    // to anyway. Answering false here would spend a visibility check and a
    // no-op provider call to learn the same thing.
    if (r.rows.length === 0) return true;
    return r.rows.every((row) => claimed.has(row.token));
  } catch (err) {
    // An unreadable device list is the ONE case that still falls back to the
    // old account-level rule. It is consistent with canNotify, which fails
    // closed a few lines later for the same reason: while the database is
    // unreachable the safe move is the quiet one, and it lasts only as long as
    // the outage.
    console.error('[Push] device list unreadable, falling back to presence:', err.message);
    return true;
  }
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

// The three answers a visibility check can give. Returned, never recorded
// anywhere shared. Two pushes to one recipient are routinely in flight at once
// (a DM and a flock message landing together, a Promise.allSettled fan-out
// that names the same person twice), and the previous design marked "the check
// itself failed" in a module-level set keyed by recipient which deliver() read
// and cleared. A sibling delivery for the same recipient whose lookup settled
// in the same tick cleared that mark or claimed it, so an outage was filed as
// a permanent suppression and the outbox sweep deleted the row instead of
// retrying it. A return value cannot be reached by another call.
const CAN_SEE = Object.freeze({ allowed: true, uncheckable: false });
const CANNOT_SEE = Object.freeze({ allowed: false, uncheckable: false });
const CANNOT_TELL = Object.freeze({ allowed: false, uncheckable: true });

async function checkVisibility(userId, data = {}) {
  try {
    const actorId = actorFrom(data);
    if (actorId && Number(actorId) !== Number(userId)) {
      if (await isBlockedBetween(userId, actorId)) return CANNOT_SEE;
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
    if (!row) return CANNOT_SEE;        // the account was deleted
    if (row.is_banned) return CANNOT_SEE; // no pulling a banned user back into an app that rejects them
    // A removed account does not get to keep announcing itself, with one
    // exception: an SOS or its stand-down. routes/safety.js deliberately
    // authenticates a banned user for those (a banned person in danger is
    // still a person in danger), and this clause was silently dropping the
    // flock leg it had just allowed. The block check above still applies.
    if (row.actor_banned && !RINGS_THROUGH_THE_NIGHT.has(data?.type)) return CANNOT_SEE;
    return row.can_see !== false ? CAN_SEE : CANNOT_SEE;
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
    // Still not allowed - the paragraph above is the reason and it stands. But
    // the answer says the check FAILED rather than that it answered no, so the
    // one caller that needs the difference can tell a suppression from an
    // outage without anything being left behind for another call to find.
    return CANNOT_TELL;
  }
}

// The boolean the rest of the codebase and the tests know. Everything that
// asks this wants the fail-closed answer and none of it wants a second
// vocabulary; deliver() is the one place that has to know WHY, and it asks
// checkVisibility directly.
async function canNotify(userId, data = {}) {
  return (await checkVisibility(userId, data)).allowed;
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

// ---------------------------------------------------------------------------
// The ledger write. Best-effort in every direction: it never throws, it never
// changes the verdict, and it is never awaited by a caller that has a user
// waiting. A metrics table that can break the thing it measures is worse than
// no metrics table.
// ---------------------------------------------------------------------------
// A write whose failure must never reach the caller, including a driver that
// throws before it ever returns a promise. Every one of these is bookkeeping
// (the ledger, the token liveness stamp, a debounce release) and every one of
// them sits on a path with a person waiting at the other end of it.
function fireAndForget(sql, params, label) {
  try {
    const p = pool.query(sql, params);
    if (p && typeof p.catch === 'function') {
      p.catch((err) => console.error(`[Push] ${label} failed:`, err.message));
    }
  } catch (err) {
    console.error(`[Push] ${label} failed:`, err.message);
  }
}

function typeOf(data) {
  const t = data && data.type ? String(data.type) : '';
  return t ? t.slice(0, 40) : 'unknown';
}

function record(userId, data, outcome, { sent = 0, failed = 0, quiet = false } = {}) {
  const type = typeOf(data);
  // The zero-dependency half of the answer. One line per push, in Railway's
  // log stream, greppable as `[Push] outcome=`, so "did anything go out
  // yesterday" survives even a database Jayden cannot reach.
  console.log(
    `[Push] type=${type} user=${userId} outcome=${outcome} sent=${sent} failed=${failed} quiet=${quiet}`
  );
  // Once per failure, not silently. A ledger that has quietly stopped writing
  // reads exactly like a product that has quietly stopped sending.
  fireAndForget(
    `INSERT INTO push_sends (user_id, push_type, outcome, devices_sent, devices_failed, quiet_hours)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, type, outcome, sent, failed, quiet],
    'ledger write'
  );
}

// The shape callers already expect, with the ledger row written on the way out
// so no return path can forget one.
function skip(userId, data, reason, extra) {
  record(userId, data, reason, extra);
  return { skipped: true, reason };
}

// ---------------------------------------------------------------------------
// Quiet hours. See the block at the top of the file for what "night" means for
// a nightlife app and which types break through.
// ---------------------------------------------------------------------------
function localClock(timeZone, at = new Date()) {
  if (!timeZone || typeof timeZone !== 'string') return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(at);
    const f = {};
    for (const p of parts) f[p.type] = p.value;
    const hour = Number(f.hour);
    const minute = Number(f.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    return { hour, minute };
  } catch {
    return null; // not an IANA name this runtime knows
  }
}

function localHourIn(timeZone, at = new Date()) {
  const clock = localClock(timeZone, at);
  return clock ? clock.hour : null;
}

// Pure, so the window can be tested without a clock or a database.
function isQuietHour(hour) {
  if (!Number.isInteger(hour)) return false;
  return hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR;
}

// When the current quiet window ends, as an instant. Used to schedule the
// release rather than polling every minute all night.
function quietWindowEnd(timeZone, at = new Date()) {
  const clock = localClock(timeZone, at);
  if (!clock || !isQuietHour(clock.hour)) return null;
  // Minutes as well as hours, and arithmetic on the instant rather than on a
  // server-local Date. Half-hour zones (Asia/Kolkata, Australia/Adelaide) do
  // not share the server's minute-of-hour, so flattening minutes here would
  // release the row half an hour early and bounce it straight back.
  const minutesLeft = (QUIET_END_HOUR - clock.hour) * 60 - clock.minute;
  // One minute inside the open window rather than exactly on the boundary.
  return new Date(at.getTime() + (minutesLeft + 1) * 60 * 1000);
}

// The device's own IANA zone, newest device first. Newest by updated_at, which
// is now a liveness timestamp rather than a registration one, so a phone that
// received a push this evening outranks a laptop registered last spring.
async function recipientZone(userId) {
  try {
    const r = await pool.query(
      `SELECT timezone FROM device_tokens
        WHERE user_id = $1 AND timezone IS NOT NULL AND timezone <> ''
        ORDER BY updated_at DESC NULLS LAST, id DESC
        LIMIT 1`,
      [userId]
    );
    if (r.rows.length && r.rows[0].timezone) return String(r.rows[0].timezone);
  } catch (err) {
    // Unknown, which below means deliver. A database blip must not hold
    // somebody's messages.
    return null;
  }
  const fallback = process.env.PUSH_QUIET_DEFAULT_TZ;
  return fallback ? String(fallback) : null;
}

// ---------------------------------------------------------------------------
// The outbox: enqueue, and the sweep that releases it.
// ---------------------------------------------------------------------------
let outboxTimer = null;
let idleSweeps = 0;

function startOutboxSweep() {
  if (outboxTimer) return;
  idleSweeps = 0;
  outboxTimer = setInterval(() => {
    sweepPushOutbox().catch((err) => console.error('[Push] outbox sweep failed:', err.message));
  }, OUTBOX_SWEEP_MS);
  // Same rule as the debounce sweep below it: a cleanup timer must never be
  // the reason a process stays up. `node --test` hangs forever otherwise.
  if (typeof outboxTimer.unref === 'function') outboxTimer.unref();
}

function stopOutboxSweep() {
  if (!outboxTimer) return;
  clearInterval(outboxTimer);
  outboxTimer = null;
}

async function enqueue(userId, title, body, data, reason, nextAttemptAt, expiresAt) {
  try {
    if (reason === 'quiet') {
      // ONE held row per conversation. Every debounce window through the
      // night used to add its own row, and the table has no dedupe, so a busy
      // overnight group chat released twenty to forty separate sends at
      // 08:00, each with a sound. apns-collapse-id merges the visible line,
      // not the alerts, which is the failure this file's header claims to
      // prevent. The key is the one buildFcmMessage collapses on: the type
      // and the conversation (flockId, else senderId). The newest words win
      // and the hold's expiry is extended, so the morning gets one line that
      // is current, not the first of forty.
      const d = data && typeof data === 'object' ? data : {};
      const scopeKey = d.flockId != null ? 'flockId' : (d.senderId != null ? 'senderId' : null);
      // Its own guard: a merge that cannot run must fall through to the
      // insert below, never cost the hold.
      let merged = null;
      try {
        merged = await pool.query(
          `UPDATE push_outbox
              SET title = $3, body = $4, data = $5::jsonb,
                  expires_at = GREATEST(expires_at, $6)
            WHERE user_id = $1 AND reason = 'quiet'
              AND COALESCE(data->>'type', '') = COALESCE($2, '')
              AND ($7::text IS NULL OR data->>$7::text = $8::text)
            RETURNING id`,
          [
            userId,
            d.type != null ? String(d.type) : '',
            String(title == null ? '' : title).slice(0, 500),
            String(body == null ? '' : body).slice(0, 1000),
            JSON.stringify(d),
            expiresAt,
            scopeKey,
            scopeKey ? String(d[scopeKey]) : null,
          ]
        );
      } catch (mergeErr) {
        console.error('[Push] outbox merge failed, inserting instead:', mergeErr.message);
      }
      if (merged && merged.rowCount > 0) return true;
    }
    await pool.query(
      `INSERT INTO push_outbox (user_id, reason, title, body, data, next_attempt_at, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        userId,
        reason,
        String(title == null ? '' : title).slice(0, 500),
        String(body == null ? '' : body).slice(0, 1000),
        JSON.stringify(data && typeof data === 'object' ? data : {}),
        nextAttemptAt,
        expiresAt,
      ]
    );
    startOutboxSweep();
    return true;
  } catch (err) {
    console.error('[Push] outbox enqueue failed:', err.message);
    return false;
  }
}

// A clean batch means every device we still hold a token for accepted the
// message, so every one of those tokens is demonstrably alive today.
//
// WHY ONLY ON A CLEAN BATCH. updated_at is the ordering key the send path uses
// for "newest first" and the input to the 270-day prune, so freshening it is a
// claim that the row is alive. On a mixed batch we do not know WHICH row
// failed (the provider answer is per token, but this file only sees the
// totals), and re-dating a corpse is how a dead row survives the prune forever.
// Under-claiming costs nothing: every sign-in re-registers the token and writes
// updated_at anyway.
function touchDeviceTokens(userId) {
  fireAndForget(
    'UPDATE device_tokens SET updated_at = NOW() WHERE user_id = $1',
    [userId],
    'token liveness touch'
  );
}

// ---------------------------------------------------------------------------
// The unread count behind the app icon badge.
//
// Two read states since migration 056: direct_messages.read_status for DMs,
// and flock_members.last_read_message_id for flock chat. Both are cleared by
// the app itself (opening a thread marks DMs read, opening a flock chat
// advances the cursor), which is the rule this number lives by: counting
// something the app cannot clear would leave a badge nobody can get rid of,
// which is the one badge failure worse than having none. Every predicate here
// mirrors the reads in routes/messages.js and routes/flocks.js, hidden and
// unsent rows excluded, so the badge counts exactly what the screens show.
//
// Blocked either way is excluded, matching the conversation list in
// routes/messages.js: a message that will never be shown must not sit in the
// count forever. Unsent rows (sender_deleted_at, migration 055) are excluded
// for the same reason with a sharper edge: every read filters them, so the
// recipient can never mark one read, and counting it would inflate the badge
// permanently. Returns null rather than 0 on any failure, because aps.badge
// of 0 CLEARS the icon and "we could not count" is not "you have nothing".
// ---------------------------------------------------------------------------
async function unreadBadge(userId) {
  try {
    const r = await pool.query(
      `SELECT (
          (SELECT COUNT(*)
             FROM direct_messages dm
            WHERE dm.receiver_id = $1
              AND dm.read_status = FALSE
              AND COALESCE(dm.is_hidden, false) = false
              AND dm.sender_deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM user_blocks b
                 WHERE (b.blocker_id = $1 AND b.blocked_id = dm.sender_id)
                    OR (b.blocker_id = dm.sender_id AND b.blocked_id = $1)
              ))
        + (SELECT COUNT(*)
             FROM messages m
             JOIN flock_members fm ON fm.flock_id = m.flock_id
                                  AND fm.user_id = $1
                                  AND fm.status = 'accepted'
                                  -- Only memberships whose cursor has MOVED.
                                  -- Migration 056 starts every cursor at 0 and
                                  -- the app builds already installed never call
                                  -- PUT /flocks/:id/read, so counting cursor-0
                                  -- rows put every historical flock message on
                                  -- the icon badge of exactly the clients that
                                  -- can never clear it (Codex review,
                                  -- 2026-09-01). One real read arms the count
                                  -- for good; until then the DM half still
                                  -- carries the badge, as it always did.
                                  AND fm.last_read_message_id > 0
            WHERE m.id > COALESCE(fm.last_read_message_id, 0)
              AND m.sender_id IS NOT NULL
              AND m.sender_id != $1
              AND m.is_hidden IS NOT TRUE
              AND m.sender_deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM user_blocks b
                 WHERE (b.blocker_id = $1 AND b.blocked_id = m.sender_id)
                    OR (b.blocker_id = m.sender_id AND b.blocked_id = $1)
              ))
       )::int AS n`,
      [userId]
    );
    const n = r.rows.length ? Number(r.rows[0].n) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch (err) {
    return null;
  }
}

async function deliver(userId, title, body, data, opts = {}) {
  // Enforced HERE, not only in the producer: services/crowdAlerts.js filters
  // its recipients before claiming the alert, but a chokepoint check is what
  // makes "the user's switch works" a property of the type rather than a habit
  // of the one caller that currently sends it.
  const type = data && data.type ? String(data.type) : '';
  if (type === 'crowd_alert' && (await crowdAlertOptedOut(userId))) {
    return skip(userId, data, OUTCOME.OPTED_OUT);
  }
  // Re-run for a released outbox row too, and that is the point of doing it
  // here rather than at enqueue time: a recipient who left the flock, blocked
  // the sender, or was banned while the row waited gets nothing.
  const visibility = await checkVisibility(userId, data);
  if (!visibility.allowed) {
    return skip(userId, data, visibility.uncheckable ? OUTCOME.UNCHECKABLE : OUTCOME.NOT_VISIBLE);
  }

  if (!RINGS_THROUGH_THE_NIGHT.has(type)) {
    const zone = await recipientZone(userId);
    const hour = localHourIn(zone);
    if (isQuietHour(hour)) {
      if (DROPPED_IN_QUIET_HOURS.has(type)) {
        return skip(userId, data, OUTCOME.QUIET_DROPPED, { quiet: true });
      }
      if (!opts.fromOutbox) {
        const releaseAt = quietWindowEnd(zone) || new Date(Date.now() + 60 * 60 * 1000);
        const held = await enqueue(
          userId, title, body, data, 'quiet',
          releaseAt, new Date(Date.now() + QUIET_TTL_MS)
        );
        // Could not persist the hold. Deliver it rather than lose it: a
        // notification at a bad hour is recoverable, a notification that never
        // existed is not.
        if (held) return skip(userId, data, OUTCOME.QUIET_HELD, { quiet: true });
      } else {
        // Released early, the window moved under it (a DST shift), or a
        // RETRY row crossed into the night. The sweep reschedules rather than
        // re-enqueueing a duplicate, and it is told WHEN: without the release
        // time, a retry row was bumped by its own backoff, kept meeting the
        // window, and expired inside it, so a transient failure just before
        // 02:00 was dropped rather than held.
        return { skipped: true, reason: OUTCOME.QUIET_HELD, requeue: true, releaseAt: quietWindowEnd(zone) || null };
      }
    }
  }

  // The app icon badge, computed here because here is where every push in the
  // app converges. See the block above buildFcmMessage in
  // services/firebaseService.js for what the number means and why it is safe to
  // send on every type. A shallow copy rather than a mutation: `data` belongs to
  // the caller, several of whom hand the same object to a whole flock.
  const badge = await unreadBadge(userId);
  const payload = badge === null ? data : { ...data, badge };

  const result = await firebaseService.sendPushToUser(userId, title, body, payload);
  const sent = Number(result && result.sent) || 0;
  const failed = Number(result && result.failed) || 0;

  if (sent > 0 && failed === 0) touchDeviceTokens(userId);

  if (sent === 0 && failed > 0 && !opts.fromOutbox && !OWN_RETRY.has(type)) {
    // Nothing reached a device and something answered with an error. Usually
    // that is an FCM 5xx, a network blip, or our own 8 second deadline, all of
    // which a second attempt fixes. It can also be a batch of tokens that were
    // all dead, in which case the send path has just deleted them and the first
    // sweep finds no device and drops the row, which costs one query and
    // cleans itself up. Retrying the transient case is worth that.
    //
    // First retry a minute out: longer than any blip, shorter than a person
    // noticing.
    await enqueue(
      userId, title, body, data, 'retry',
      new Date(Date.now() + 60 * 1000), new Date(Date.now() + RETRY_TTL_MS)
    );
  }

  record(userId, data, sent > 0 ? OUTCOME.DELIVERED : failed > 0 ? OUTCOME.FAILED : OUTCOME.NO_DEVICE, {
    sent,
    failed,
  });
  return result;
}

// ---------------------------------------------------------------------------
// The sweep. Claims due rows with FOR UPDATE SKIP LOCKED so a second Railway
// instance running the same sweep at the same second takes a different set,
// and advances next_attempt_at inside the claim so a crash between the claim
// and the send costs a delay rather than a duplicate.
// ---------------------------------------------------------------------------
async function sweepPushOutbox() {
  if (disabled()) return 0;

  let rows;
  try {
    const claimed = await pool.query(
      `WITH due AS (
         SELECT id FROM push_outbox
          WHERE next_attempt_at <= NOW()
          ORDER BY next_attempt_at
          LIMIT ${OUTBOX_BATCH}
          FOR UPDATE SKIP LOCKED
       )
       UPDATE push_outbox o
          SET attempts = o.attempts + 1,
              next_attempt_at = NOW() + CASE
                WHEN o.reason = 'quiet' THEN INTERVAL '30 minutes'
                ELSE INTERVAL '1 minute' * POWER(2, LEAST(o.attempts, 4))
              END
         FROM due
        WHERE o.id = due.id
    RETURNING o.id, o.user_id, o.reason, o.title, o.body, o.data, o.attempts, o.expires_at`
    );
    rows = claimed.rows || [];
  } catch (err) {
    console.error('[Push] outbox claim failed:', err.message);
    return 0;
  }

  if (rows.length === 0) {
    idleSweeps += 1;
    if (idleSweeps >= OUTBOX_IDLE_SWEEPS) stopOutboxSweep();
    return 0;
  }
  idleSweeps = 0;

  const drop = [];
  for (const row of rows) {
    const data = row.data && typeof row.data === 'object' ? row.data : {};
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      // A notification nobody can act on any more. Recorded rather than
      // deleted in silence, because "how often do we give up" is one of the
      // two numbers this whole ledger exists to make answerable.
      record(row.user_id, data, OUTCOME.EXPIRED, { quiet: row.reason === 'quiet' });
      drop.push(row.id);
      continue;
    }

    let result = null;
    try {
      result = await deliver(row.user_id, row.title, row.body, data, { fromOutbox: true });
    } catch (err) {
      console.error('[Push] outbox delivery threw:', err.message);
    }

    const sent = Number(result && result.sent) || 0;
    const stillQuiet = Boolean(result && result.requeue);
    if (stillQuiet) {
      // The claim moved next_attempt_at by the row's own backoff. For a row
      // that has to wait for morning, that is the wrong clock: move it to the
      // window's end and keep it alive until then, whatever its reason.
      const at = result.releaseAt instanceof Date && !Number.isNaN(result.releaseAt.getTime()) ? result.releaseAt : null;
      if (at) {
        await pool.query(
          `UPDATE push_outbox
              SET next_attempt_at = $2,
                  expires_at = GREATEST(expires_at, $2 + INTERVAL '1 hour')
            WHERE id = $1`,
          [row.id, at]
        ).catch((err) => console.error('[Push] outbox reschedule failed:', err.message));
      }
      continue;
    }
    if (sent > 0) { drop.push(row.id); continue; }
    // A row the recipient will never be allowed to see is finished. A row we
    // could not ASK about is not - it goes back for its own backoff, and the
    // attempts ceiling below still stops it eventually.
    if (result && result.skipped && result.reason === OUTCOME.UNCHECKABLE) {
      // The claim already moved next_attempt_at by this row's own backoff, so
      // continuing schedules the retry rather than spinning. The ceiling still
      // applies: an outage that outlasts RETRY_MAX_ATTEMPTS ends the row here
      // rather than leaving it to be re-attempted until its TTL.
      if (row.attempts >= RETRY_MAX_ATTEMPTS) drop.push(row.id);
      continue;
    }
    if (result && result.skipped) { drop.push(row.id); continue; } // never becomes visible
    // Nothing failed and nothing sent means the account has no registered
    // device any more. Retrying that produces the same nothing forever.
    const failed = Number(result && result.failed) || 0;
    if (result && failed === 0) { drop.push(row.id); continue; }
    if (row.attempts >= RETRY_MAX_ATTEMPTS) drop.push(row.id);
  }

  if (drop.length) {
    await pool
      .query('DELETE FROM push_outbox WHERE id = ANY($1)', [drop])
      .catch((err) => console.error('[Push] outbox cleanup failed:', err.message));
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Housekeeping, called from the crowd-alert sweep (every 15 minutes) rather
// than from a timer of its own. Rate-limited per process so two instances do
// not both run it every quarter hour.
// ---------------------------------------------------------------------------
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
let lastMaintenance = 0;

async function sweepPushMaintenance(force = false) {
  const now = Date.now();
  if (!force && now - lastMaintenance < MAINTENANCE_INTERVAL_MS) return false;
  lastMaintenance = now;

  const step = async (sql, params) => {
    try {
      return await pool.query(sql, params);
    } catch (err) {
      console.warn('[Push] maintenance step failed:', err.message);
      return null;
    }
  };

  await step(
    `DELETE FROM push_sends WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [LEDGER_RETENTION_DAYS]
  );
  await step("DELETE FROM push_outbox WHERE expires_at < NOW() - INTERVAL '1 day'");
  await step("DELETE FROM push_debounce WHERE sent_at < NOW() - INTERVAL '1 hour'");
  // The rot this exists to stop: FCM expires a token after roughly 270 days of
  // app inactivity, and a row past that point is a failed send on every
  // notification the account will ever receive, forever, with the only symptom
  // being a `failed` count nobody was reading until this week.
  await step(
    `DELETE FROM device_tokens
      WHERE COALESCE(updated_at, created_at) < NOW() - ($1::int * INTERVAL '1 day')`,
    [TOKEN_MAX_IDLE_DAYS]
  );
  return true;
}

// The rollup behind "did pushes go out this week, and did they land". Returned
// rather than printed so a panel, a script or a one-off can all use the same
// numbers.
async function pushDeliveryStats(days = 7) {
  const window = Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 90) : 7;
  const r = await pool.query(
    `SELECT push_type, outcome,
            COUNT(*)::int                        AS pushes,
            COALESCE(SUM(devices_sent), 0)::int  AS devices_sent,
            COALESCE(SUM(devices_failed), 0)::int AS devices_failed
       FROM push_sends
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
      GROUP BY push_type, outcome
      ORDER BY pushes DESC`,
    [window]
  );
  const rows = r.rows || [];
  const totals = { attempts: 0, delivered: 0, devicesReached: 0, failed: 0, held: 0, suppressed: 0 };
  for (const row of rows) {
    totals.attempts += row.pushes;
    totals.devicesReached += row.devices_sent;
    if (row.outcome === OUTCOME.DELIVERED) totals.delivered += row.pushes;
    else if (row.outcome === OUTCOME.FAILED || row.outcome === OUTCOME.EXPIRED) totals.failed += row.pushes;
    else if (row.outcome === OUTCOME.QUIET_HELD) totals.held += row.pushes;
    else totals.suppressed += row.pushes;
  }
  return { days: window, totals, byTypeAndOutcome: rows };
}

// Nothing below does any database work when push is not configured — several
// suites assert that a push-triggering route touches no unscripted query.
function disabled() {
  return !firebaseService.isEnabled();
}

// The cross-instance half of the chat debounce. One statement, so it needs no
// transaction: the upsert only writes when the stored timestamp is already
// older than the window, and exactly one caller can win that write.
async function claimDebounce(key) {
  try {
    const r = await pool.query(
      `INSERT INTO push_debounce (debounce_key, sent_at)
       VALUES ($1, NOW())
       ON CONFLICT (debounce_key) DO UPDATE
          SET sent_at = NOW()
        WHERE push_debounce.sent_at < NOW() - ($2::int * INTERVAL '1 millisecond')
       RETURNING debounce_key`,
      [key, DEBOUNCE_MS]
    );
    return r.rowCount === 1;
  } catch (err) {
    // Fail open. See the caller's comment: a duplicate notification is a small
    // cost, a lost one is the failure this whole change exists to remove.
    return true;
  }
}

function releaseDebounce(key) {
  fireAndForget('DELETE FROM push_debounce WHERE debounce_key = $1', [key], 'debounce release');
}

// "Is this notification already in front of them, on every device it would
// reach?" That is the question the old isUserOnline check was standing in for,
// and the long block above everyDeviceAttended is why the substitution failed.
// The database read only happens when there IS a live socket, so the common
// case (recipient offline, which is the whole reason a push exists) still costs
// nothing extra, and a deployment with push unconfigured still touches no
// database at all.
async function alreadyInFrontOfThem(io, userId) {
  if (!isUserOnline(io, userId)) return false;
  if (disabled()) return true; // nothing to send anyway; do not spend a query
  return everyDeviceAttended(io, userId);
}

// Send push only if the notification is not already in front of the user
async function pushIfOffline(io, userId, title, body, data = {}) {
  if (await alreadyInFrontOfThem(io, userId)) {
    if (disabled()) return { skipped: true, reason: 'online' };
    return skip(userId, data, OUTCOME.ONLINE);
  }
  if (disabled()) return { skipped: true, reason: 'disabled' };
  return deliver(userId, title, body, data);
}

// Send push only if user is offline AND not debounced
async function pushIfOfflineDebounced(io, userId, title, body, data = {}) {
  if (await alreadyInFrontOfThem(io, userId)) {
    if (disabled()) return { skipped: true, reason: 'online' };
    return skip(userId, data, OUTCOME.ONLINE);
  }
  if (disabled()) return { skipped: true, reason: 'disabled' };

  const key = debounceKey(userId, data);
  const now = Date.now();
  const lastSent = lastPushSent.get(key);
  if (lastSent && now - lastSent < DEBOUNCE_MS) {
    return skip(userId, data, OUTCOME.DEBOUNCED);
  }

  // Claimed before the send so two concurrent messages can't both pass, and
  // rolled back if the send never happened — otherwise a blocked or invisible
  // recipient burned the window for the next legitimate notification.
  lastPushSent.set(key, now);

  // THE SECOND LAYER, and the reason this one is durable.
  //
  // Three debounces guard the push path. crowd_alert_sends (migration 007) is
  // a real DB claim. This one and the invite debounce in routes/flocks.js were
  // in-heap Maps, which is a window that does not exist the moment Railway runs
  // two instances: each process holds its own copy, so a message debounced on
  // instance A goes out again from instance B, and a deploy clears every window
  // at once. The Map above is kept as a free local fast path; push_debounce
  // (migration 050) is what makes the window true across processes.
  //
  // Fails OPEN, unlike canNotify. Losing this claim means one duplicate
  // notification; refusing to send because the database blinked means a lost
  // message, and the whole point of this change is that a notification is
  // never silently dropped.
  const claimed = await claimDebounce(key);
  if (!claimed) {
    lastPushSent.delete(key);
    return skip(userId, data, OUTCOME.DEBOUNCED);
  }

  const result = await deliver(userId, title, body, data);
  // Release the window if nothing actually went out. A recipient who was
  // invisible, or who had no registered device at that instant, must not have
  // the next thirty seconds of their notifications suppressed on the strength
  // of a delivery that never happened. A quiet-hours hold DID happen (the
  // notification exists, in push_outbox, waiting for morning), so it keeps the
  // window: releasing it would let the next forty messages each queue their own
  // copy of the same conversation.
  const held = Boolean(result && result.reason === OUTCOME.QUIET_HELD);
  const nothingSent = !result || (result.skipped && !held) || (result.sent === 0);
  if (nothingSent) {
    lastPushSent.delete(key);
    releaseDebounce(key);
  }
  return result;
}

// Send push regardless of online status. Two callers, both time-sensitive
// enough that "already in the app" is not a reason to stay silent: the
// organizer-initiated budget reminder (routes/budget.js) and the pre-event
// crowd alert (services/crowdAlerts.js). Not a channel for anything
// promotional — see the 4.5.4 block at the top of this file.
// ---------------------------------------------------------------------------
// BADGE SYNC (2026-09-01). The icon badge is an ABSOLUTE number that only ever
// travelled on an alert push, so it moved when a notification arrived and at
// no other time. A user who opened the app and read everything kept whatever
// number the last push had set, until some later push happened to carry a
// lower one. Nothing on the client sets or clears a badge, and no badge plugin
// is installed, so the only writer is the server. This sends a badge-only push,
// no alert, no sound, carrying the same unreadBadge() count deliver() attaches
// to every alert, so a read that empties the count clears the icon. Called
// fire-and-forget from the read routes; a push failure must never fail a read.
// ---------------------------------------------------------------------------
async function pushBadgeSync(userId) {
  if (disabled()) return { skipped: true, reason: 'disabled' };
  const badge = await unreadBadge(userId);
  if (badge === null) return { skipped: true, reason: 'unreadable' };
  try {
    return await firebaseService.sendBadgeToUser(userId, badge);
  } catch (err) {
    console.error('[Push] badge sync failed:', err && err.message ? err.message : err);
    return { sent: 0, failed: 0 };
  }
}

async function pushAlways(userId, title, body, data = {}) {
  if (disabled()) return { skipped: true, reason: 'disabled' };
  return deliver(userId, title, body, data);
}

module.exports = {
  pushBadgeSync,
  unreadBadge,
  isUserOnline,
  pushIfOffline,
  pushIfOfflineDebounced,
  pushAlways,
  canNotify,
  debounceKey,
  // Delivery machinery. sweepPushOutbox releases retries and quiet-hours
  // holds; sweepPushMaintenance ages out dead device tokens and trims the
  // ledger. Both are driven from services/crowdAlerts.js, which server.js
  // already schedules, so neither needs a timer of its own in the boot path.
  sweepPushOutbox,
  sweepPushMaintenance,
  // "Did pushes go out this week, and did they land."
  pushDeliveryStats,
  // Quiet hours, exported as pure functions so the window and the release
  // arithmetic are testable without a clock, a zone or a database.
  isQuietHour,
  localHourIn,
  quietWindowEnd,
  QUIET_START_HOUR,
  QUIET_END_HOUR,
  RINGS_THROUGH_THE_NIGHT,
  DROPPED_IN_QUIET_HOURS,
  // The presence fix: which devices a live socket actually speaks for.
  attentiveTokens,
  everyDeviceAttended,
  OUTCOME,
  // ---------------------------------------------------------------------------
  // FOR THE THIRD DEBOUNCE, WHICH IS STILL IN A HEAP.
  //
  // routes/flocks.js holds `lastInvitePush`, an in-process Map keyed
  // `${user_id}|flock_invite` with the same 30 second window as this file's.
  // Like the chat one before today, it does not exist across two Railway
  // instances: each process has its own copy, so an invite debounced on
  // instance A is sent again by instance B, and a deploy clears every window.
  //
  // Adopting the durable half is one line at each of its two call sites, and
  // needs no new key format: `${user_id}|flock_invite` is already what this
  // file's debounceKey produces for a type with no scope.
  //
  //   if (!(await claimDebounce(key))) return { skipped: true, reason: 'debounced' };
  //   ... and releaseDebounce(key) wherever it deletes from the Map today.
  //
  // Both fail OPEN, so a database blip sends a duplicate rather than swallowing
  // an invite.
  claimDebounce,
  releaseDebounce,
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
  _resetDebounce: () => {
    lastPushSent.clear();
    lastMaintenance = 0;
    stopOutboxSweep();
  },
};
