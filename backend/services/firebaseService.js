// ---------------------------------------------------------------------------
// Firebase Cloud Messaging — Push Notification Service
// Graceful no-op when FIREBASE_SERVICE_ACCOUNT is not configured.
// ---------------------------------------------------------------------------

const pool = require('../config/database');

let admin = null;
let warnedOnce = false;

function init() {
  if (admin) return true;

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
    return false;
  }
}

// Send push notification to a single device token
// Returns { success: true } or { success: false, stale: boolean }
async function sendPushNotification(token, title, body, data = {}) {
  if (!init()) return { success: false, stale: false };

  try {
    // All data values must be strings
    const stringData = {};
    for (const [k, v] of Object.entries(data)) {
      stringData[k] = String(v);
    }

    await admin.messaging().send({
      token,
      notification: { title, body },
      data: stringData,
      webpush: {
        notification: {
          icon: '/logo192.png',
          badge: '/logo192.png',
        },
        fcmOptions: {
          link: '/',
        },
      },
    });
    return { success: true };
  } catch (err) {
    // Token is invalid or expired
    const staleErrors = [
      'messaging/invalid-registration-token',
      'messaging/registration-token-not-registered',
    ];
    const isStale = staleErrors.includes(err.code);
    if (!isStale) {
      console.error('[Firebase] Send error:', err.code || err.message);
    }
    return { success: false, stale: isStale };
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

    let sent = 0;
    let failed = 0;
    const staleIds = [];

    for (const row of result.rows) {
      const res = await sendPushNotification(row.token, title, body, data);
      if (res.success) {
        sent++;
      } else {
        failed++;
        if (res.stale) staleIds.push(row.id);
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

module.exports = { sendPushNotification, sendPushToUser };
