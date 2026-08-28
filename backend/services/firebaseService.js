// ---------------------------------------------------------------------------
// Firebase Cloud Messaging — Push Notification Service
// Graceful no-op when FIREBASE_SERVICE_ACCOUNT is not configured.
// ---------------------------------------------------------------------------

const pool = require('../config/database');

let admin = null;
let warnedOnce = false;
// Sticky. isEnabled() is now consulted before every push, and a malformed
// service account would otherwise re-parse, re-call initializeApp (which
// throws "app already exists" on the second try) and re-log on every single
// notification the server tries to send.
let initFailed = false;

function init() {
  if (admin) return true;
  if (initFailed) return false;

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccount) {
    if (!warnedOnce) {
      console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT not set — push notifications disabled');
      warnedOnce = true;
    }
    return false;
  }

  try {
    const firebaseAdmin = require('firebase-admin');
    const parsed = JSON.parse(serviceAccount);
    firebaseAdmin.initializeApp({
      credential: firebaseAdmin.credential.cert(parsed),
    });
    admin = firebaseAdmin;
    console.log('[Firebase] Admin SDK initialized');
    return true;
  } catch (err) {
    console.error('[Firebase] Failed to initialize:', err.message);
    warnedOnce = true;
    initFailed = true;
    return false;
  }
}

// Test seam. The delivery tests need to drive the provider's failure modes —
// an unregistered token, a transient 5xx, a request that never answers —
// without real credentials and without reaching Google. Nothing outside
// __tests__ may set this.
let senderOverride = null;
function __setSenderForTests(fn) { senderOverride = fn; }

// True when push is actually configured. Callers use this to skip the work
// they would otherwise do to BUILD a notification (membership lookups, block
// checks, a paid weather call in the crowd-alert sweep) on a deployment where
// nothing can be delivered anyway.
function isEnabled() {
  return senderOverride ? true : init();
}

// ---------------------------------------------------------------------------
// Deep links
//
// Round 7: every notification used to carry `fcmOptions.link: '/'`, so the FCM
// service worker's own click handler opened the home screen no matter what the
// notification was about. A notification that cannot take you to the thing it
// is about is an interruption, not a feature. `link` is also copied into the
// data payload so the native (Capacitor) tap handler and our own service
// worker click handler resolve the same destination the web SDK would.
// ---------------------------------------------------------------------------
// Every type below is part of the transactional push inventory documented in
// services/pushHelper.js (the App Review 4.5.4 block). A new type must be
// classified there before it ships: promotional or marketing pushes need
// explicit opt-in consent UI and their own opt-out, which no type here has or
// needs.
//
// The five types added on 2026-08-25 are transactional on the same terms as
// their neighbours, and the classification is recorded here because this file
// owns the table a client routes on:
//
//   flock_updated      the time, venue or name of a plan the recipient
//                      accepted moved. Sent to accepted members only, by the
//                      creator's own edit, debounced per plan.
//   flock_cancelled    a plan the recipient accepted was cancelled or deleted.
//                      Same audience, one send, and the last thing that plan
//                      will ever say.
//   bill_settled       somebody paid the recipient back on a bill the
//                      recipient fronted. One send, to the payer only.
//   friend_accepted    a friend request the recipient SENT was accepted. One
//                      send, to the requester only.
//   availability_pulse a friend said they are free tonight. The only type here
//                      that is not about a row the recipient already owns, so
//                      it is the most heavily rationed: see routes/availability.js.
//
// None of the five names a price, a plan, a tier, or an offer, and none of them
// fires without a person doing something first.
const FLOCK_SCOPED_TYPES = new Set([
  'flock_invite',
  'flock_message',
  'flock_rsvp',
  'flock_confirmed',
  'flock_updated',
  'flock_cancelled',
  'budget_reminder',
  'budget_ready',
  'bill_created',
  'bill_settled',
  'crowd_alert',
  'guest_rsvp',
  'attendance_marked',
]);

// ---------------------------------------------------------------------------
// WHICH SURFACE, not just which flock (2026-08-25)
//
// Every flock-scoped type used to resolve to `/?flock=<id>`, which App.js turns
// into the flock's CHAT. For eight of them that is right, because the chat is
// where the thing happened. For five it was one screen away from the subject:
//
//   "You owe Ava $12"                  opened a conversation, not the bill
//   "Budget set"                       opened a conversation, not the budget
//   "Submit your budget"               opened a conversation, not the form
//   "Your reliability score updated"   opened a conversation, not the score
//   "Tonight looks busy at 9"          opened a conversation, not the plan
//
// So the link now carries the surface as well as the id. `view` is read by
// services/pushNavigation.js and maps onto state App.js already has: the cash
// pool sheet (bill and budget both live in it) and the plan detail screen.
// A type with no entry here keeps the plain `/?flock=<id>` it always had, so
// the chat stays the default rather than becoming a special case.
const FLOCK_VIEW = {
  bill_created: 'bill',
  bill_settled: 'bill',
  budget_ready: 'budget',
  budget_reminder: 'budget',
  flock_updated: 'plan',
  flock_cancelled: 'plan',
  crowd_alert: 'plan',
};

function deepLinkPath(data = {}) {
  const type = data.type ? String(data.type) : '';
  const flockId = data.flockId != null ? String(data.flockId) : '';
  const senderId = data.senderId != null ? String(data.senderId) : '';

  if (type === 'dm_message' && /^\d+$/.test(senderId)) return `/?dm=${senderId}`;
  // A friend request and its answer both land where friend requests are: the
  // You tab.
  if (type === 'friend_request' || type === 'friend_accepted') return '/?tab=you';
  // The score this names is the recipient's own, and it is printed on their
  // profile. The flock is only the occasion.
  if (type === 'attendance_marked') return '/?tab=you';
  // "Free tonight" is answered from the Nest, which is where the Tonight
  // control and the start-a-plan button are.
  if (type === 'availability_pulse') return '/?tab=home';
  // Admin only, and straight to the reports queue: /admin/moderation is a
  // top-level page the web client serves. This resolved to '/' once (tapping
  // did nothing at all) and then to '/?admin=true', which the app turned into
  // the analytics dashboard, one screen short of the queue the alert names.
  if (type === 'moderation_report') return '/admin/moderation';
  // The SOS tap is routed from the data payload, not a URL. Its live fields are
  // a person's name and their coordinates, which do not belong in a query
  // string, so this deliberately returns no deep link: a native tap and a web
  // tap with the app already open both carry the full payload to intentFromData
  // (the service worker relays data by postMessage, never by navigating), and
  // that is the path that opens the alert modal. A cold web tap with no client
  // to relay to lands on the app itself rather than smuggling a location
  // through the address bar. Do not "fix" this into '/?safety=...'.
  if (type === 'safety_alert') return '/';
  // An invited flock is NOT in the accepted list the chat screen reads, so a
  // chat link for one can only ever miss. Its own parameter, its own landing.
  if (type === 'flock_invite' && /^\d+$/.test(flockId)) return `/?invite=${flockId}`;
  if (FLOCK_SCOPED_TYPES.has(type) && /^\d+$/.test(flockId)) {
    const view = FLOCK_VIEW[type];
    return view ? `/?flock=${flockId}&view=${view}` : `/?flock=${flockId}`;
  }
  // A cancellation whose flock has already been DELETED carries no id, because
  // there is no row left for the visibility gate to check or for a screen to
  // open. The plans list is the honest destination.
  if (type === 'flock_cancelled') return '/?tab=chat';
  return '/';
}

function absoluteLink(path) {
  const base = String(process.env.FRONTEND_URL || '').replace(/\/+$/, '');
  // FCM rejects a webpush link that is not absolute HTTPS, so an unset or
  // http:// FRONTEND_URL means we simply omit it and let the service worker
  // route from `data.link` instead.
  if (!/^https:\/\//i.test(base)) return null;
  return `${base}${path}`;
}

// ---------------------------------------------------------------------------
// Text integrity
//
// Round 18: every caller clips its preview with `substring(0, 100)` — see
// routes/messages.js and sockets/handlers.js. A JS string is UTF-16, so that
// cuts CODE UNITS, not characters: a message whose 100th unit lands inside an
// emoji, or any other astral character (musical symbols, CJK extension B, most
// flags), leaves a LONE SURROGATE on the end. FCM's JSON parser rejects
// unpaired surrogates outright with 400 INVALID_ARGUMENT, so the whole
// notification is dropped — and, correctly, isStaleError does NOT read that as
// a dead token, so the same message fails forever with nothing in the logs but
// a generic send error. Repairing it here fixes every caller at once, which is
// the reason one place builds the FCM message.
//
// Also stripped: C0/C1 control characters, which a lock screen renders as
// nothing or as a box and which push the payload toward the 4KB ceiling.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// APNs and FCM both drop a notification whose payload exceeds 4KB, and nothing
// upstream bounds a venue name, a flock name or a display name — several bodies
// concatenate two of them. These caps are generous next to any real value (the
// longest data value the app sends is a two-word busyness label) and leave the
// whole serialized message under 4KB even when every field is astral text at
// four bytes a character.
const MAX_TITLE = 120;
const MAX_BODY = 300;
// Deliberately smaller than MAX_DATA_BYTES: no single value may consume the
// whole data budget and starve the routing keys behind it. The longest value
// the app actually sends is a busyness label ("Very Busy").
const MAX_DATA_VALUE = 64;
// Per-value caps do not bound a payload on their own: they multiply by the
// number of keys. This is the ceiling that actually holds, and it is eight
// times the largest payload any real caller builds.
const MAX_DATA_BYTES = 512;
// If the budget ever does run out, these are the keys the client needs in order
// to resolve where a tap goes, so they are spent first.
const DATA_PRIORITY = ['type', 'flockId', 'senderId', 'fromUserId'];

function isControl(cp) {
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
}

function sanitizeText(value) {
  if (typeof value !== 'string') return '';
  let out = '';
  // Iterating the string yields CODE POINTS, so a surviving pair is never
  // examined half at a time.
  for (const ch of value.replace(LONE_SURROGATE, '')) {
    out += isControl(ch.codePointAt(0)) ? ' ' : ch;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

// Clip on a CODE POINT boundary, never a code unit one, so the repair above
// cannot be undone by the cap that follows it.
function clip(value, max) {
  if (value.length <= max) return value;
  const points = Array.from(value);
  if (points.length <= max) return value;
  return `${points.slice(0, max - 1).join('').trimEnd()}…`;
}

// A notification whose body is empty renders as a bare title with a blank
// line under it. Image and venue-card messages carry no text, and that is
// exactly how they used to arrive.
const EMPTY_BODY_FALLBACK = {
  dm_message: 'Sent you something',
  flock_message: 'Shared something in the chat',
};

function normalizeBody(body, type) {
  const clean = sanitizeText(body);
  if (clean) return clip(clean, MAX_BODY);
  return EMPTY_BODY_FALLBACK[type] || 'Open Flock to see it';
}

// firebase-admin validates that notification.title is a string and rejects the
// WHOLE message when it is not, so a null display name — or one that arrived as
// an object, which a template literal would have rendered "[object Object]" —
// used to lose the push rather than degrade it. Nothing upstream guarantees a
// title; this is the only place that can.
function normalizeTitle(title) {
  const clean = sanitizeText(typeof title === 'string' ? title : '');
  return clean ? clip(clean, MAX_TITLE) : 'Flock';
}

// Collapse key: a second notification about the same conversation replaces the
// first on the device instead of stacking a wall of them on the lock screen.
function collapseId(data = {}) {
  const type = data.type ? String(data.type) : 'flock';
  const scope = data.flockId != null ? `f${data.flockId}` : (data.senderId != null ? `u${data.senderId}` : '');
  return `${type}${scope ? `-${scope}` : ''}`.slice(0, 64);
}

function buildFcmMessage(token, title, body, data = {}) {
  const type = data.type ? String(data.type) : '';
  const link = deepLinkPath(data);

  // All data values must be strings — and only SCALARS become sensible ones.
  // String({}) is "[object Object]", which is a value the client would then
  // route on; a non-scalar here is a caller bug, so drop it rather than ship a
  // placeholder that looks like data.
  const stringData = {};
  let dataBytes = Buffer.byteLength(`link${link}`, 'utf8');
  // `badge` is routing for the ICON, not for the app, so it is spent on the aps
  // payload below rather than on the 512 byte data budget the deep link shares.
  const entries = Object.entries(data).filter(([k]) => k !== 'badge');
  const ordered = [
    ...entries.filter(([k]) => DATA_PRIORITY.includes(k)),
    ...entries.filter(([k]) => !DATA_PRIORITY.includes(k)),
  ];
  for (const [k, v] of ordered) {
    if (v === undefined || v === null) continue;
    const t = typeof v;
    if (t !== 'string' && t !== 'number' && t !== 'boolean' && t !== 'bigint') continue;
    if (t === 'number' && !Number.isFinite(v)) continue;
    const clean = clip(sanitizeText(String(v)), MAX_DATA_VALUE);
    if (!clean) continue;
    const cost = Buffer.byteLength(k, 'utf8') + Buffer.byteLength(clean, 'utf8');
    if (dataBytes + cost > MAX_DATA_BYTES) continue;
    dataBytes += cost;
    stringData[k] = clean;
  }
  // Always present: it is the only thing that decides where a tap lands.
  stringData.link = link;

  const tag = collapseId(data);
  const safeTitle = normalizeTitle(title);
  const safeBody = normalizeBody(body, type);
  const url = absoluteLink(link);

  // ---------------------------------------------------------------------------
  // THE APP ICON BADGE
  //
  // Until 2026-08-25 the aps payload carried a sound and a thread id and no
  // badge at all, so the icon never showed an unread count for any notification
  // this app has ever sent.
  //
  // WHAT THE NUMBER MEANS, stated here because a badge that means something
  // vague is worse than no badge. It is the recipient's unread direct messages
  // plus, since migration 056, flock messages past each membership's read
  // cursor: the two read states the database holds, and both are cleared by
  // the app itself the moment the thread or the chat is opened.
  // services/pushHelper.js computes it and passes it on every push it sends.
  //
  // WHY IT IS SAFE TO SEND ON EVERY TYPE: aps.badge is ABSOLUTE, not an
  // increment. Sending the true count with a flock invite or a bill is what
  // makes the icon self-correcting, so reading your DMs on one device and then
  // receiving any notification at all clears the badge rather than leaving a
  // number nobody can get rid of.
  //
  // Absent rather than zero when we could not compute it: aps.badge of 0 CLEARS
  // the icon, so a failed count must not read as "you have nothing waiting".
  // ---------------------------------------------------------------------------
  const rawBadge = data.badge;
  const badge = Number.isFinite(Number(rawBadge)) && Number(rawBadge) >= 0
    ? Math.min(Math.floor(Number(rawBadge)), 9999)
    : null;
  const aps = { sound: 'default', 'thread-id': tag };
  if (badge !== null) aps.badge = badge;

  const message = {
    token,
    notification: { title: safeTitle, body: safeBody },
    data: stringData,
    android: {
      priority: 'high',
      collapseKey: tag,
      // notificationCount is Android's half of the same idea: it drives the
      // launcher's badge on the OEMs that support one. Same number, same
      // meaning, same absolute semantics as aps.badge above.
      notification: badge !== null
        ? { sound: 'default', tag, notificationCount: badge }
        : { sound: 'default', tag },
    },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-push-type': 'alert',
        'apns-collapse-id': tag,
      },
      // Without an explicit sound an APNs alert arrives silently, which on a
      // locked phone is indistinguishable from not arriving at all.
      payload: { aps },
    },
    webpush: {
      notification: {
        icon: '/logo192.png',
        badge: '/logo192.png',
        tag,
      },
      fcmOptions: url ? { link: url } : undefined,
    },
  };

  if (!message.webpush.fcmOptions) delete message.webpush.fcmOptions;
  return message;
}

// A token the provider has told us is gone. `invalid-argument` is only treated
// as fatal-to-the-token when the message says the token is the invalid part —
// the same code covers a malformed PAYLOAD, and deleting good tokens because
// we sent a bad body would be a self-inflicted outage.
const STALE_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'messaging/invalid-recipient',
]);

function isStaleError(err) {
  if (!err) return false;
  const code = err.code || (err.errorInfo && err.errorInfo.code) || '';
  if (STALE_CODES.has(code)) return true;
  if (code === 'messaging/invalid-argument') {
    return /registration token|not a valid fcm/i.test(err.message || '');
  }
  return false;
}

// ---------------------------------------------------------------------------
// Deadline
//
// firebase-admin's own timeout is 15s PER ATTEMPT and it retries connection
// resets and timeouts up to four times. routes/flocks.js USED TO await its
// entire push fan-out before res.json, so an unreachable FCM held a flock-status
// response open for the better part of a minute. All four of its call sites now
// push after responding, so that particular hang is gone — but the deadline
// stays, because it is what makes "a notification failing must never be
// something the user experiences as the app hanging" a property of this file
// rather than a habit every caller has to remember. Resolving as a plain
// failure is safe: the timeout carries no provider code, so isStaleError reads
// it as transient and the token survives.
// ---------------------------------------------------------------------------
const SEND_TIMEOUT_MS = 8000;

// Kept in step with routes/notifications.js MAX_TOKENS_PER_USER. Interpolated
// rather than bound because it is a module constant, never anything a caller
// supplies.
const MAX_TOKENS_PER_USER = 20;

function timeoutError() {
  const err = new Error(`push send exceeded ${SEND_TIMEOUT_MS}ms`);
  err.code = 'push/deadline-exceeded';
  return err;
}

async function rawSend(message) {
  if (senderOverride) return senderOverride(message);
  return admin.messaging().send(message);
}

async function sendWithDeadline(message, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      rawSend(message),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError()), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Send push notification to a single device token
// Returns { success: true } or { success: false, stale: boolean }
async function sendPushNotification(token, title, body, data = {}, opts = {}) {
  if (!senderOverride && !init()) return { success: false, stale: false };

  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : SEND_TIMEOUT_MS;
  try {
    await sendWithDeadline(buildFcmMessage(token, title, body, data), timeoutMs);
    return { success: true };
  } catch (err) {
    const stale = isStaleError(err);
    if (!stale) {
      console.error('[Firebase] Send error:', err.code || err.message);
    }
    return { success: false, stale };
  }
}

// Send push notification to all devices belonging to a user
// Cleans up stale tokens automatically
async function sendPushToUser(userId, title, body, data = {}) {
  if (!senderOverride && !init()) return { sent: 0, failed: 0 };

  try {
    // Bounded, and newest first. The rows below are sent to CONCURRENTLY, so an
    // unbounded row count here is an unbounded burst of outbound requests for
    // one notification. routes/notifications.js prunes to the same ceiling on
    // registration; this is the half that also bounds rows that predate it.
    const result = await pool.query(
      `SELECT id, token FROM device_tokens
        WHERE user_id = $1
        ORDER BY updated_at DESC NULLS LAST, id DESC
        LIMIT ${MAX_TOKENS_PER_USER}`,
      [userId]
    );

    if (result.rows.length === 0) return { sent: 0, failed: 0 };

    // Round 7: this was a sequential await per token, inside route handlers
    // that already await once per recipient. A confirmed flock of twenty
    // members held the HTTP response open for twenty round trips to Google.
    const outcomes = await Promise.all(
      result.rows.map((row) =>
        sendPushNotification(row.token, title, body, data)
          .then((res) => ({ id: row.id, ...res }))
          .catch(() => ({ id: row.id, success: false, stale: false }))
      )
    );

    let sent = 0;
    let failed = 0;
    const staleIds = [];
    for (const out of outcomes) {
      if (out.success) sent++;
      else {
        failed++;
        if (out.stale) staleIds.push(out.id);
      }
    }

    // Clean up stale tokens.
    //
    // Round 18: scoped to the account we were pushing to. A device token is
    // TRANSFERABLE — routes/notifications.js reassigns the same row to a new
    // account with ON CONFLICT (token) DO UPDATE SET user_id — so between the
    // SELECT above and this DELETE the row can have become someone else's
    // freshly registered device. Deleting by row id alone silently unsubscribes
    // that account instead, and the only symptom is a user who stops getting
    // notifications after a phone changes hands.
    //
    // BEST-EFFORT, never part of the delivery verdict. This DELETE used to sit
    // bare inside the function's try, so a transient DB failure during CLEANUP
    // fell through to the catch below and reported { sent: 0, failed: 0 } for
    // a batch that had already been delivered. services/crowdAlerts.js releases
    // its once-per-flock claim on that answer, which re-sent the same alert to
    // every member who already had it on their lock screen. A prune that fails
    // costs one wasted send attempt next time; a delivery report that lies
    // costs a duplicate push.
    if (staleIds.length > 0) {
      await pool
        .query(
          'DELETE FROM device_tokens WHERE id = ANY($1) AND user_id = $2',
          [staleIds, userId]
        )
        .catch((pruneErr) => {
          console.error('[Firebase] stale token prune failed (will retry on next send):', pruneErr.message);
        });
    }

    return { sent, failed };
  } catch (err) {
    console.error('[Firebase] sendPushToUser error:', err.message);
    return { sent: 0, failed: 0 };
  }
}

module.exports = {
  sendPushNotification,
  sendPushToUser,
  isEnabled,
  // Exported for the delivery tests — these are the parts that decide where a
  // tap lands, what text arrives, and whether a token gets deleted.
  deepLinkPath,
  buildFcmMessage,
  isStaleError,
  normalizeBody,
  normalizeTitle,
  __setSenderForTests,
};
