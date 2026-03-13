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

// Request notification permission and register the FCM token
export async function requestNotificationPermission() {
  try {
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
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission; // 'granted', 'denied', or 'default'
}
