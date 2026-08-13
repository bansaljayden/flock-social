import { initializeApp } from 'firebase/app';
import { getMessaging, getToken, onMessage } from 'firebase/messaging';
import { registerDeviceToken } from './api';

const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID,
};

let messaging = null;
let swRegistration = null;

function getFirebaseMessaging() {
  if (messaging) return messaging;

  // Don't initialize if config is missing
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
    return null;
  }

  try {
    const app = initializeApp(firebaseConfig);
    messaging = getMessaging(app);
    return messaging;
  } catch (err) {
    console.warn('[Firebase] Failed to initialize:', err.message);
    return null;
  }
}

// Register service worker and inject Firebase config
async function registerServiceWorker() {
  if (swRegistration) return swRegistration;
  if (!('serviceWorker' in navigator)) return null;

  try {
    // Register the service worker
    swRegistration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');

    // Post Firebase config to the service worker
    if (swRegistration.active) {
      swRegistration.active.postMessage({ type: 'FIREBASE_CONFIG', config: firebaseConfig });
    }
    // Also listen for the SW to activate and send config
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'FIREBASE_CONFIG', config: firebaseConfig });
      }
    });

    return swRegistration;
  } catch (err) {
    console.warn('[Firebase] Service worker registration failed:', err.message);
    return null;
  }
}

const isNativeApp = () =>
  typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true;

// Native (Capacitor iOS/Android) path: @capacitor-firebase/messaging bridges
// APNs -> FCM, so the token it returns works with the existing firebase-admin
// send path on the backend. Web Notification/service-worker APIs don't exist
// in the WKWebView — this branch replaces them entirely on device.
// Requires (documented in PUSH-SETUP.md): GoogleService-Info.plist in the iOS
// app, Push Notifications capability on the App ID, APNs key uploaded to
// Firebase. Fails soft until those land.
async function requestNativePermission() {
  try {
    const { FirebaseMessaging } = await import('@capacitor-firebase/messaging');
    const perm = await FirebaseMessaging.requestPermissions();
    if (perm.receive !== 'granted') {
      localStorage.setItem('flock_notif_denied', 'true');
      return null;
    }
    const { token } = await FirebaseMessaging.getToken();
    if (!token) return null;
    const platform = window.Capacitor.getPlatform() === 'android' ? 'android' : 'ios';
    await registerDeviceToken(token, platform);
    // Firebase rotates tokens while the app stays installed; without this
    // subscription the backend keeps the stale token and push silently dies
    // until the next login (round 4).
    if (!tokenRotationSubscribed) {
      tokenRotationSubscribed = true;
      FirebaseMessaging.addListener('tokenReceived', (event) => {
        if (event?.token) registerDeviceToken(event.token, platform).catch(() => {});
      }).catch(() => { tokenRotationSubscribed = false; });
    }
    localStorage.removeItem('flock_notif_denied');
    return token;
  } catch (err) {
    console.warn('[Push] Native registration failed:', err.message);
    return null;
  }
}
let tokenRotationSubscribed = false;

// Request notification permission and register the FCM token
export async function requestNotificationPermission() {
  try {
    if (isNativeApp()) return await requestNativePermission();

    const m = getFirebaseMessaging();
    if (!m) return null;

    // Check if already denied — don't ask again
    if (Notification.permission === 'denied') {
      return null;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      localStorage.setItem('flock_notif_denied', 'true');
      return null;
    }

    const vapidKey = process.env.REACT_APP_FIREBASE_VAPID_KEY;
    if (!vapidKey) {
      console.warn('[Firebase] VAPID key not set');
      return null;
    }

    // Register service worker for background notifications
    const sw = await registerServiceWorker();

    const tokenOptions = { vapidKey };
    if (sw) tokenOptions.serviceWorkerRegistration = sw;

    const token = await getToken(m, tokenOptions);
    if (token) {
      await registerDeviceToken(token, 'web');
      localStorage.removeItem('flock_notif_denied');
      return token;
    }

    return null;
  } catch (err) {
    console.warn('[Firebase] Token registration failed:', err.message);
    return null;
  }
}

// Listen for foreground messages
export function onForegroundMessage(callback) {
  if (isNativeApp()) {
    // If cleanup runs while the dynamic import is still pending, the resolved
    // listener must be removed immediately — otherwise a quick unmount/remount
    // leaked the old listener and duplicated foreground notifications.
    let cancelled = false;
    let remove = () => {};
    import('@capacitor-firebase/messaging')
      .then(({ FirebaseMessaging }) =>
        FirebaseMessaging.addListener('notificationReceived', (event) => {
          const n = event?.notification || {};
          callback({ title: n.title || '', body: n.body || '', data: n.data || {} });
        })
      )
      .then((handle) => {
        if (cancelled) { handle.remove(); return; }
        remove = () => handle.remove();
      })
      .catch(() => {});
    return () => { cancelled = true; remove(); };
  }

  const m = getFirebaseMessaging();
  if (!m) return () => {};

  return onMessage(m, (payload) => {
    callback({
      title: payload.notification?.title || '',
      body: payload.notification?.body || '',
      data: payload.data || {},
    });
  });
}

// Check current notification permission status
export function getNotificationStatus() {
  if (isNativeApp()) {
    // The web Notification API doesn't exist in the WKWebView; report from
    // our own denial marker so the settings UI stays truthful.
    return localStorage.getItem('flock_notif_denied') === 'true' ? 'denied' : 'default';
  }
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission; // 'granted', 'denied', or 'default'
}
