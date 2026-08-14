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

// True when push is actually configured. Callers use this to skip the work
// they would otherwise do to BUILD a notification (membership lookups, block
// checks) on a deployment where nothing can be delivered anyway.
function isEnabled() {
  return init();
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

// A notification whose body is empty renders as a bare title with a blank
// line under it. Image and venue-card messages carry no text, and that is
// exactly how they used to arrive.
const EMPTY_BODY_FALLBACK = {
  dm_message: 'Sent you something',
  flock_message: 'Shared something in the chat',
};

function normalizeBody(body, type) {
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (trimmed) return trimmed;
  return EMPTY_BODY_FALLBACK[type] || 'Open Flock to see it';
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

  // All data values must be strings
  const stringData = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    stringData[k] = String(v);
  }
  stringData.link = link;

  const tag = collapseId(data);
  const safeBody = normalizeBody(body, type);
  const url = absoluteLink(link);

  const message = {
    token,
    notification: { title, body: safeBody },
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

// Send push notification to a single device token
// Returns { success: true } or { success: false, stale: boolean }
async function sendPushNotification(token, title, body, data = {}) {
  if (!init()) return { success: false, stale: false };

  try {
    await admin.messaging().send(buildFcmMessage(token, title, body, data));
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
  if (!init()) return { sent: 0, failed: 0 };

  try {
    const result = await pool.query(
      'SELECT id, token FROM device_tokens WHERE user_id = $1',
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

    // Clean up stale tokens
    if (staleIds.length > 0) {
      await pool.query('DELETE FROM device_tokens WHERE id = ANY($1)', [staleIds]);
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
  // tap lands and whether a token gets deleted.
  deepLinkPath,
  buildFcmMessage,
  isStaleError,
  normalizeBody,
};
