import { initializeApp } from 'firebase/app';
import { getMessaging, getToken, onMessage, deleteToken } from 'firebase/messaging';
// getToken, not a localStorage read of our own: api.js owns where the auth
// token lives and what it is called. This file used to restate the key as
// `const AUTH_TOKEN_KEY = 'flockToken'`, a THIRD copy of that contract after
// userSettings.js was consolidated onto api.js — so renaming the key or moving
// it off localStorage would have left the push session watcher reading a slot
// nobody writes and silently registering nobody for notifications.
//
// getToken rather than isLoggedIn: the watcher below needs the token's VALUE,
// not a boolean. It compares the current token with the last one it handled to
// tell "already registered this session" from "a different account is signed in
// now", and an account switch that happens in another tab never passes through
// a logged-out state for a boolean to notice.
import { registerDeviceToken, unregisterDeviceToken, unregisterAllTokens, getToken as getAuthToken } from './api';
import { startPushNavigation, handleNotificationData } from './pushNavigation';
// The socket needs to know which device it is speaking for, so the backend can
// suppress a push on THIS device without silencing the account. The token is
// pushed to it from here rather than read from localStorage over there, for the
// same reason the auth token is read through api.js above: this module owns
// PUSH_TOKEN_KEY, and a second reader of a key nobody renames in step is how a
// rename silently unsubscribes everybody. services/socket.js carries the whole
// explanation of what the server does with it.
import { setDevicePushToken } from './socket';

const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID,
};

// Persisted so a logout in a page load that never re-registered still knows
// which token belongs to THIS device. Without it, logout has to fall back to
// deleting every token on the account.
const PUSH_TOKEN_KEY = 'flock_push_token';

let messaging = null;
let swRegistration = null;
// The FCM token this device is currently registered with, so logout can
// unregister exactly this device instead of every device on the account.
let currentPushToken = null;

function rememberPushToken(token) {
  currentPushToken = token;
  try {
    if (token) localStorage.setItem(PUSH_TOKEN_KEY, token);
    else localStorage.removeItem(PUSH_TOKEN_KEY);
  } catch (err) { /* private mode */ }
  // Every path that changes this device's identity goes through here:
  // first registration, a rotated token from the tokenReceived listener, and
  // logout clearing it. So this is the one place the socket has to be told.
  try { setDevicePushToken(token); } catch (err) { /* socket not up yet */ }
}

function knownPushToken() {
  if (currentPushToken) return currentPushToken;
  try { return localStorage.getItem(PUSH_TOKEN_KEY); } catch (err) { return null; }
}

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

// Register the service worker with the Firebase config in its URL.
//
// A service worker is restarted from scratch every time the browser wakes it
// for a push, so anything handed over by postMessage is gone by then — the
// worker came up unconfigured and the browser showed its own "site updated in
// the background" placeholder instead of the notification. The URL is part of
// the registration, so the worker can read its config on every startup.
// postMessage is kept purely to upgrade a worker registered by an older build.
function serviceWorkerUrl() {
  const params = new URLSearchParams();
  params.set('apiKey', firebaseConfig.apiKey || '');
  params.set('authDomain', firebaseConfig.authDomain || '');
  params.set('projectId', firebaseConfig.projectId || '');
  params.set('messagingSenderId', firebaseConfig.messagingSenderId || '');
  params.set('appId', firebaseConfig.appId || '');
  return `/firebase-messaging-sw.js?${params.toString()}`;
}

async function registerServiceWorker() {
  if (swRegistration) return swRegistration;
  if (!('serviceWorker' in navigator)) return null;
  if (!firebaseConfig.apiKey || !firebaseConfig.messagingSenderId) return null;

  try {
    swRegistration = await navigator.serviceWorker.register(serviceWorkerUrl());

    // Belt and braces for a worker installed by a build that predates the
    // query-string config.
    const post = (worker) => {
      if (worker) worker.postMessage({ type: 'FIREBASE_CONFIG', config: firebaseConfig });
    };
    post(swRegistration.active);
    navigator.serviceWorker.ready.then((reg) => post(reg.active)).catch(() => {});

    return swRegistration;
  } catch (err) {
    console.warn('[Firebase] Service worker registration failed:', err.message);
    return null;
  }
}

const isNativeApp = () =>
  typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true;

// ---------------------------------------------------------------------------
// This device's clock, as an IANA zone name.
//
// Quiet hours are decided on the RECIPIENT's local time, and the server has no
// other way to know it: Railway runs on UTC and there is no timezone column on
// users. Without this, "do not ring at 3am" would be evaluated against UTC,
// which for a US east coast user means muting 22:00 to 04:00 local. That is
// the entire night out. It would silence the exact hours this app exists for
// in order to protect the ones it does not.
//
// The device is the right place to ask, because the device is the thing with a
// clock and the thing the notification arrives on. Registration happens on
// every sign-in, so somebody who travels re-registers on arrival.
//
// Returns undefined rather than a guess when the runtime cannot answer, and
// services/pushHelper.js reads an unknown zone as "deliver now": holding
// somebody's messages for six hours on a wrong guess is worse than one badly
// timed notification.
// ---------------------------------------------------------------------------
function deviceTimezone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone.length > 0 && zone.length <= 64 ? zone : undefined;
  } catch (err) {
    return undefined;
  }
}

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
    await registerDeviceToken(token, platform, deviceTimezone());
    rememberPushToken(token);
    markSessionRegistered();
    // Firebase rotates tokens while the app stays installed; without this
    // subscription the backend keeps the stale token and push silently dies
    // until the next login (round 4).
    if (!tokenRotationSubscribed) {
      tokenRotationSubscribed = true;
      FirebaseMessaging.addListener('tokenReceived', (event) => {
        if (event?.token) {
          rememberPushToken(event.token);
          registerDeviceToken(event.token, platform, deviceTimezone()).catch(() => {});
        }
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
      await registerDeviceToken(token, 'web', deviceTimezone());
      rememberPushToken(token);
      markSessionRegistered();
      localStorage.removeItem('flock_notif_denied');
      return token;
    }

    return null;
  } catch (err) {
    console.warn('[Firebase] Token registration failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session watcher
//
// Round 7: the ONLY caller of requestNotificationPermission on startup sat
// behind `if (isLoggedIn())` in an effect with an empty dependency list. That
// effect runs once, on mount, before anybody has signed in — so a user who
// signed up or logged in during the session never registered a token and never
// received a single notification until the next cold start of the app. On a
// shared device it was worse: logout deleted the row, the next account logged
// in and registered nothing.
//
// Registration is a property of the SESSION, not of one mount. The watcher
// keys off the stored auth token: a new token means a new session (fresh
// login, signup, or account switch), and every new session registers this
// device exactly once.
// ---------------------------------------------------------------------------
let handledAuthToken = null;
let attempts = 0;
let syncInFlight = false;
const MAX_ATTEMPTS = 5;

// The try/catch stays: api.js reads localStorage directly and Safari's private
// mode can throw on the read, and this runs on a 2s interval where an
// exception would kill the watcher for the rest of the page load.
function readAuthToken() {
  try { return getAuthToken() || null; } catch (err) { return null; }
}

// Any successful registration settles this session, wherever it came from —
// the watcher, the mount effect, or the Enable button in settings.
function markSessionRegistered() {
  handledAuthToken = readAuthToken();
  attempts = 0;
}

async function syncPushForSession() {
  const authToken = readAuthToken();

  if (!authToken) {
    // Signed out. Arm for whoever signs in next.
    handledAuthToken = null;
    attempts = 0;
    return;
  }
  if (handledAuthToken === authToken || syncInFlight) return;

  syncInFlight = true;
  try {
    const token = await requestNotificationPermission();
    if (token) {
      handledAuthToken = authToken;
      attempts = 0;
      return;
    }
    // No token. If the answer is settled, stop asking; if it merely failed
    // (offline, backend hiccup), let the next tick try again.
    const status = getNotificationStatus();
    attempts += 1;
    if (status === 'denied' || status === 'unsupported' || attempts >= MAX_ATTEMPTS) {
      handledAuthToken = authToken;
    }
  } catch (err) {
    attempts += 1;
    if (attempts >= MAX_ATTEMPTS) handledAuthToken = authToken;
  } finally {
    syncInFlight = false;
  }
}

// A session that used up its attempts because the backend was briefly down
// would otherwise stay unregistered for the whole page load. Coming back to
// the tab or regaining connectivity re-arms it — but only when permission is
// already settled in our favour, so nobody is prompted twice.
function rearmIfUnresolved() {
  if (currentPushToken) return;
  const status = getNotificationStatus();
  if (status === 'denied' || status === 'unsupported') return;
  if (!isNativeApp() && status !== 'granted') return;
  handledAuthToken = null;
  attempts = 0;
}

let watcherStarted = false;

export function startPushSessionWatcher() {
  if (watcherStarted || typeof window === 'undefined') return;
  watcherStarted = true;

  const tick = () => { syncPushForSession(); };
  const retry = () => { rearmIfUnresolved(); syncPushForSession(); };

  tick();
  // Logging in does not fire an event this module can hear: it happens inside
  // React state in another file, in an already-focused tab. A cheap poll (one
  // localStorage read) is what makes "sign in and notifications work" true
  // without reaching into App.js.
  setInterval(tick, 2000);
  window.addEventListener('focus', retry);
  window.addEventListener('online', retry);
  window.addEventListener('storage', tick); // another tab signed in or out
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') retry();
  });
}

/**
 * Logout. Removes THIS device's token only, so signing out of a laptop does
 * not kill notifications on the phone.
 *
 * The account-wide fallback is for a device that registered before the token
 * was persisted locally: leaving a live token pointed at the account someone
 * just signed out of is worse than being over-broad, and it stops happening
 * after that device's first login on this build.
 *
 * Fires the unregister call synchronously so the request captures the auth
 * header before the caller clears the session.
 */
export function unregisterPushToken() {
  handledAuthToken = null;
  attempts = 0;
  const token = knownPushToken();
  rememberPushToken(null);

  const request = token
    ? unregisterDeviceToken(token).catch(() => {})
    : unregisterAllTokens().catch(() => {});

  // Drop the token on the device too, so the next account on this device gets
  // a fresh one rather than inheriting the previous user's subscription.
  Promise.resolve().then(async () => {
    try {
      if (isNativeApp()) {
        const { FirebaseMessaging } = await import('@capacitor-firebase/messaging');
        await FirebaseMessaging.deleteToken();
        return;
      }
      const m = getFirebaseMessaging();
      if (m) await deleteToken(m);
    } catch (err) { /* the server-side row is already gone */ }
  });

  return request;
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
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission; // 'granted', 'denied', or 'default'
}

// Re-exported so App.js has a single import for "take me to the thing the
// notification was about".
export { onPushNavigate, peekPendingNavigation } from './pushNavigation';

// Both are safe to run at import time and both are no-ops outside a browser.
startPushNavigation();
startPushSessionWatcher();
// Seed the socket from storage on a cold start. Registration only happens once
// per session, so without this a reload would leave the connection unable to
// name the device it belongs to until the next sign-in, and the backend would
// fall back to suppressing nothing for it.
try { setDevicePushToken(knownPushToken()); } catch (err) { /* private mode */ }

// Foreground pushes on native carry the same data payload; nothing consumes it
// until the user taps, but keeping the shape in one place means the tap
// handler and the toast handler cannot drift apart.
export function routeNotification(data) {
  handleNotificationData(data);
}
