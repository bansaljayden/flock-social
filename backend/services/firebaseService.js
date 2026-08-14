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
const FLOCK_SCOPED_TYPES = new Set([
  'flock_invite',
  'flock_message',
  'flock_rsvp',
  'flock_confirmed',
  'flock_updated',
  'budget_reminder',
  'budget_ready',
  'bill_created',
  'bill_settled',
  'crowd_alert',
  'guest_rsvp',
  'attendance_marked',
]);

function deepLinkPath(data = {}) {
  const type = data.type ? String(data.type) : '';
  const flockId = data.flockId != null ? String(data.flockId) : '';
  const senderId = data.senderId != null ? String(data.senderId) : '';

  if (type === 'dm_message' && /^\d+$/.test(senderId)) return `/?dm=${senderId}`;
  if (type === 'friend_request') return '/?tab=you';
  if (FLOCK_SCOPED_TYPES.has(type) && /^\d+$/.test(flockId)) return `/?flock=${flockId}`;
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
  const entries = Object.entries(data);
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

  const message = {
    token,
    notification: { title: safeTitle, body: safeBody },
    data: stringData,
    android: {
      priority: 'high',
      collapseKey: tag,
      notification: { sound: 'default', tag },
    },
    apns: {
      headers: {
        'apns-priority': '10',
        'apns-push-type': 'alert',
        'apns-collapse-id': tag,
      },
      // Without an explicit sound an APNs alert arrives silently, which on a
      // locked phone is indistinguishable from not arriving at all.
      payload: { aps: { sound: 'default', 'thread-id': tag } },
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
    if (staleIds.length > 0) {
      await pool.query(
        'DELETE FROM device_tokens WHERE id = ANY($1) AND user_id = $2',
        [staleIds, userId]
      );
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
