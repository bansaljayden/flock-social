/* eslint-disable no-restricted-globals */
/* eslint-disable no-undef */

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

let firebaseInitialized = false;

// Receive Firebase config from the main app
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'FIREBASE_CONFIG' && !firebaseInitialized) {
    initFirebase(event.data.config);
  }
});

function initFirebase(config) {
  if (firebaseInitialized || !config || !config.apiKey) return;

  try {
    firebase.initializeApp(config);
    const messaging = firebase.messaging();

    messaging.onBackgroundMessage((payload) => {
      const title = payload.notification?.title || 'Flock';
      const body = payload.notification?.body || '';
      const data = payload.data || {};

      const options = {
        body,
        icon: '/logo192.png',
        badge: '/logo192.png',
        tag: data.type || 'flock-notification',
        data,
      };

      self.registration.showNotification(title, options);
    });

    firebaseInitialized = true;
  } catch (err) {
    // Service worker can't use console.warn reliably, just silently fail
  }
}

// Handle notification click — open the app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  let url = '/';

  if (data.type === 'flock_invite' || data.type === 'flock_message' || data.type === 'flock_rsvp' ||
      data.type === 'flock_confirmed' || data.type === 'budget_reminder' || data.type === 'budget_ready' ||
      data.type === 'bill_created') {
    url = `/?flock=${data.flockId}`;
  } else if (data.type === 'dm_message') {
    url = `/?dm=${data.senderId}`;
  } else if (data.type === 'friend_request') {
    url = `/?tab=you`;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          client.postMessage({ type: 'NOTIFICATION_CLICK', data });
          return;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
