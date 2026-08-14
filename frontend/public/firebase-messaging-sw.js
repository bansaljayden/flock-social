/* eslint-disable no-restricted-globals */
/* eslint-disable no-undef */

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// ---------------------------------------------------------------------------
// Config
//
// A service worker is not a page. The browser kills it after ~30 seconds idle
// and starts a fresh one when a push arrives, which means anything the page
// handed over by postMessage is gone by the time it matters. Round 7: the
// config arrived once, over postMessage, into a module-level flag — so the
// FIRST background push after every restart found an uninitialised worker with
// no push listener, and Chrome showed its own "This site has been updated in
// the background" placeholder instead of the notification. On a brand new
// registration it was worse: `registration.active` is null while the worker is
// installing and a first-time registration never fires `controllerchange`, so
// the config was never delivered at all.
//
// The config now travels in the worker's OWN URL (see registerServiceWorker in
// src/services/firebase.js). The URL is part of the registration, so every
// restart re-reads it. Nothing to race, nothing to lose.
// ---------------------------------------------------------------------------
function configFromUrl() {
  try {
    const p = new URL(self.location.href).searchParams;
    const config = {
      apiKey: p.get('apiKey') || '',
      authDomain: p.get('authDomain') || '',
      projectId: p.get('projectId') || '',
      messagingSenderId: p.get('messagingSenderId') || '',
      appId: p.get('appId') || '',
    };
    if (!config.apiKey || !config.projectId || !config.messagingSenderId) return null;
    return config;
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Where a tap goes
//
// The backend puts the destination in `data.link` (see services/firebaseService
// .js). The type map is the fallback for anything sent before that shipped.
// ---------------------------------------------------------------------------
var FLOCK_TYPES = [
  'flock_invite', 'flock_message', 'flock_rsvp', 'flock_confirmed', 'flock_updated',
  'budget_reminder', 'budget_ready', 'bill_created', 'bill_settled',
  'crowd_alert', 'guest_rsvp', 'attendance_marked',
];

function targetUrl(data) {
  var d = data || {};
  var raw = null;

  if (typeof d.link === 'string' && d.link) {
    raw = d.link;
  } else if (d.type === 'dm_message' && d.senderId) {
    raw = '/?dm=' + encodeURIComponent(d.senderId);
  } else if (d.type === 'friend_request') {
    raw = '/?tab=you';
  } else if (FLOCK_TYPES.indexOf(d.type) !== -1 && d.flockId) {
    raw = '/?flock=' + encodeURIComponent(d.flockId);
  } else {
    raw = '/';
  }

  // Never navigate anywhere but our own origin, whatever the payload says.
  try {
    var url = new URL(raw, self.location.origin);
    if (url.origin !== self.location.origin) return self.location.origin + '/';
    return url.href;
  } catch (err) {
    return self.location.origin + '/';
  }
}

// When the FCM SDK displays a notification itself, it does NOT copy the data
// payload onto the notification. It replaces it wholesale with its own
// internal payload under this one key:
//
//   notification.data === { FCM_MSG: { notification, data, fcmOptions } }
//
// So reading notification.data.type off an SDK-shown notification finds
// nothing, and every tap resolves to "/". The app's data lives one level in.
var FCM_MSG = 'FCM_MSG';

function cleanData(data) {
  var out = {};
  if (!data) return out;
  Object.keys(data).forEach(function (k) {
    if (k === FCM_MSG) return;
    var v = data[k];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  });
  return out;
}

function dataFromNotification(notification) {
  var raw = (notification && notification.data) || {};
  var internal = raw[FCM_MSG];
  if (!internal) return cleanData(raw);

  var data = cleanData(internal.data || {});
  if (!data.link) {
    var link = (internal.fcmOptions && internal.fcmOptions.link)
      || (internal.notification && internal.notification.click_action);
    if (link) data.link = link;
  }
  return data;
}

async function openTarget(url, data) {
  var list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

  for (var i = 0; i < list.length; i++) {
    var client = list[i];
    var sameOrigin = false;
    try { sameOrigin = new URL(client.url).origin === self.location.origin; } catch (err) { sameOrigin = false; }
    if (!sameOrigin) continue;

    // The app is already open. Hand it the destination and let it route in
    // place — a reload here would throw away the screen the user was on.
    client.postMessage({ type: 'NOTIFICATION_CLICK', data: data, url: url });
    if ('focus' in client) {
      try { await client.focus(); } catch (err) { /* focus can be refused */ }
    }
    return;
  }

  await self.clients.openWindow(url);
}

// Registered BEFORE firebase.messaging() on purpose. The FCM SDK installs its
// own notificationclick listener that opens `fcmOptions.link` in a NEW window
// even when the app is already open in one. stopImmediatePropagation keeps a
// single tap to a single outcome.
self.addEventListener('notificationclick', function (event) {
  if (event.action) return; // action buttons are not "open the thing"
  event.stopImmediatePropagation();
  event.notification.close();

  var data = dataFromNotification(event.notification);
  event.waitUntil(openTarget(targetUrl(data), data));
});

var firebaseInitialized = false;

function initFirebase(config) {
  if (firebaseInitialized || !config || !config.apiKey) return;

  try {
    firebase.initializeApp(config);
    var messaging = firebase.messaging();

    messaging.onBackgroundMessage(function (payload) {
      // When the push carries a `notification` block the SDK has ALREADY shown
      // it by the time this runs. Round 7 showed a second one here, so every
      // background push arrived twice. Only data-only pushes need us.
      if (payload && payload.notification) return;

      var data = payload && payload.data ? payload.data : {};
      self.registration.showNotification(data.title || 'Flock', {
        body: data.body || '',
        icon: '/logo192.png',
        badge: '/logo192.png',
        tag: data.type || 'flock-notification',
        data: data,
      });
    });

    firebaseInitialized = true;
  } catch (err) {
    // A service worker has no reliable console. Failing here means no
    // background notifications, which the app surfaces through the settings
    // row rather than a log nobody reads.
  }
}

// Primary path: config from the worker's own URL, at startup, every startup.
initFirebase(configFromUrl());

// Fallback for a worker registered by an older build whose URL carries no
// config. Harmless once the URL path works.
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'FIREBASE_CONFIG' && !firebaseInitialized) {
    initFirebase(event.data.config);
  }
});

// Take over open tabs as soon as this version activates, so a user who granted
// permission does not have to reload before background push works.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });
