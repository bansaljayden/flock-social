// THE FIREBASE JS SDK IS NOT IMPORTED HERE, AND MUST NOT BE.
//
// App.js imports this module at the top level, so a static
// `import ... from 'firebase/messaging'` put the whole SDK in the chunk group
// the app loads before it paints. Every user paid for it on every launch,
// including everyone who has never granted notification permission and
// everyone who never will, which on the audience this app is for (teenagers on
// mid-range Android phones) is most of them. Nothing the SDK does can happen
// before the OS has already said yes or the user has just tapped an Enable
// button, so none of it belongs in first paint.
//
// It is also dead weight on the platform Flock actually launches on. Native
// iOS and Android go through @capacitor-firebase/messaging, which bridges APNs
// to FCM in native code and is dynamically imported already. Every reference
// to the JS SDK below is on the web branch, guarded by isNativeApp().
//
// __tests__/pushSdkIsLazy.test.js fails if either specifier becomes a static
// import again. That regression is invisible: the app would behave identically
// and only the size report would move.
//
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

// Web foreground listeners that are waiting for this device to have push at
// all. See onForegroundMessage for why they wait.
const pendingForegroundAttaches = new Set();

function flushForegroundAttaches() {
  for (const attach of [...pendingForegroundAttaches]) {
    pendingForegroundAttaches.delete(attach);
    attach();
  }
}

function rememberPushToken(token) {
  currentPushToken = token;
  // A token exists, so this device has permission and a foreground listener
  // can finally do something. Anything that was holding off attaches now.
  if (token) flushForegroundAttaches();
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

// Whether there is a Firebase project to register a token with at all. This is
// the synchronous half of what getFirebaseMessaging used to answer, split out
// because two callers need the answer BEFORE they are willing to wait on a
// chunk download, and one of them cannot wait at all (see the prompt below).
function hasFirebaseConfig() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);
}

// One in-flight download, shared by every caller.
let sdkPromise = null;

function loadMessagingSdk() {
  if (!sdkPromise) {
    sdkPromise = Promise.all([
      import('firebase/app'),
      import('firebase/messaging'),
    ]).catch((err) => {
      // A failed chunk fetch must not poison the module for the rest of the
      // page load. The session watcher re-arms on focus and on 'online', and a
      // rejected promise cached here would hand every one of those retries the
      // same old failure instead of a fresh attempt.
      sdkPromise = null;
      throw err;
    });
  }
  return sdkPromise;
}

// Now async, where it used to be synchronous. Every caller was already inside
// an async function or a promise chain except onForegroundMessage, which keeps
// its synchronous signature; see the note there.
async function getFirebaseMessaging() {
  if (messaging) return messaging;

  // Don't initialize if config is missing
  if (!hasFirebaseConfig()) {
    return null;
  }

  try {
    const [{ initializeApp }, { getMessaging }] = await loadMessagingSdk();
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
//
// ASKING AND REGISTERING ARE TWO DIFFERENT THINGS, and this file used to treat
// them as one. Everything below the permission answer is the registering half:
// get the token, send it to the backend, keep it fresh when Firebase rotates
// it. It runs for a device that said yes just now and for a device that said
// yes weeks ago, and only the first of those involves a prompt.
async function completeNativeRegistration(FirebaseMessaging) {
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
}

// The asking half. Only ever reached from something the user just tapped.
async function requestNativePermission() {
  try {
    const { FirebaseMessaging } = await import('@capacitor-firebase/messaging');
    const perm = await FirebaseMessaging.requestPermissions();
    if (perm.receive !== 'granted') {
      localStorage.setItem('flock_notif_denied', 'true');
      return null;
    }
    return await completeNativeRegistration(FirebaseMessaging);
  } catch (err) {
    console.warn('[Push] Native registration failed:', err.message);
    return null;
  }
}

// checkPermissions, never requestPermissions: this reports what the OS already
// decided and draws nothing. A device that has not been asked answers 'prompt'
// and gets left alone.
async function syncNativeRegistration() {
  try {
    const { FirebaseMessaging } = await import('@capacitor-firebase/messaging');
    const perm = await FirebaseMessaging.checkPermissions();
    if (perm?.receive !== 'granted') return null;
    return await completeNativeRegistration(FirebaseMessaging);
  } catch (err) {
    console.warn('[Push] Native re-registration failed:', err.message);
    return null;
  }
}
let tokenRotationSubscribed = false;

// The registering half on web, for a browser that has already granted.
async function completeWebRegistration(m) {
  const vapidKey = process.env.REACT_APP_FIREBASE_VAPID_KEY;
  if (!vapidKey) {
    console.warn('[Firebase] VAPID key not set');
    return null;
  }

  // Register service worker for background notifications
  const sw = await registerServiceWorker();

  const tokenOptions = { vapidKey };
  if (sw) tokenOptions.serviceWorkerRegistration = sw;

  // Free: `m` only exists because getFirebaseMessaging awaited this same
  // promise, so it is already resolved by the time anything reaches here.
  const [, { getToken }] = await loadMessagingSdk();
  const token = await getToken(m, tokenOptions);
  if (token) {
    await registerDeviceToken(token, 'web', deviceTimezone());
    rememberPushToken(token);
    markSessionRegistered();
    localStorage.removeItem('flock_notif_denied');
    return token;
  }
  return null;
}

// THE ONLY FUNCTION IN THIS FILE THAT MAY DRAW A PERMISSION PROMPT.
//
// iOS gives an app one notification prompt per install and a denial is
// permanent, so every caller of this has to be something the user just tapped,
// with the reason for it on the screen they are looking at. There are exactly
// two: the Enable button in Settings, and the row in a flock chat that says
// what a notification from that flock would be. Nothing on a startup path may
// call it. Startup calls syncPushRegistration below.
export async function requestNotificationPermission() {
  try {
    if (isNativeApp()) return await requestNativePermission();

    // The synchronous half of the old `const m = getFirebaseMessaging()` that
    // stood here. With no Firebase project there is nothing to register a
    // token with, so asking would spend the one prompt for nothing.
    if (!hasFirebaseConfig()) return null;

    // Check if already denied. Don't ask again.
    if (Notification.permission === 'denied') {
      return null;
    }

    // START the SDK download and ask in the SAME synchronous turn. Do not
    // await it first.
    //
    // Notification.requestPermission() has to be called from the user gesture
    // that reached this function. Safari refuses outright once the call is
    // separated from the tap, and Chrome's transient activation runs out. So
    // awaiting a chunk fetch on the line above the prompt would, on a slow
    // phone on a bad connection, be the whole ask silently not happening. The
    // fetch is kicked off here, the answer is collected, and only then is the
    // download waited on, by which point it has been running the whole time
    // the OS dialog was on screen.
    //
    // One deliberate difference from the old order: a Firebase project that is
    // configured but fails to initialize now fails after the prompt rather
    // than before it. That trade is worth it. A broken initializeApp on a
    // present config is a build misconfiguration nobody has hit, and a prompt
    // that never draws is a permanent loss on iOS.
    const loading = getFirebaseMessaging();

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      localStorage.setItem('flock_notif_denied', 'true');
      return null;
    }

    const m = await loading;
    if (!m) return null;

    return await completeWebRegistration(m);
  } catch (err) {
    console.warn('[Firebase] Token registration failed:', err.message);
    return null;
  }
}

// Register this device IF the OS has already said yes, and never ask if it has
// not. This is what startup runs. It is the same treatment 70df506 gave the
// location prompt, for the same reason and with the same shape: the effect
// that needed the permission was spending the one ask the app will ever get at
// the moment it could explain itself least, so it now runs only where the
// answer is already in and the OS draws nothing.
export async function syncPushRegistration() {
  try {
    if (isNativeApp()) return await syncNativeRegistration();
    // Permission first, config second, SDK last. The order matters now that
    // the last of those is a download: this runs on a 2s tick for every signed
    // in web user, and the overwhelming majority of them have never granted
    // notification permission. Checking the cheap synchronous answers first
    // means those users never fetch a byte of the Firebase SDK. Both guards
    // returned null before and return null now, so nothing about the outcome
    // changed, only what it costs to reach it.
    if (getNotificationStatus() !== 'granted') return null;
    if (!hasFirebaseConfig()) return null;
    const m = await getFirebaseMessaging();
    if (!m) return null;
    return await completeWebRegistration(m);
  } catch (err) {
    console.warn('[Firebase] Token registration failed:', err.message);
    return null;
  }
}

// What the OS actually thinks, asked without asking the user. getNotification-
// Status below is synchronous and therefore cannot reach the native plugin, so
// on iOS it can only report our own denial marker, and that marker is only
// ever written by a refusal this build saw. A device that granted permission
// on an earlier run, or whose marker was swept by a sign-out, reads back as
// 'default' there. A screen deciding whether to OFFER the ask needs the truth,
// or it offers it to somebody who already said yes.
export async function readNotificationPermission() {
  if (!isNativeApp()) return getNotificationStatus();
  try {
    const { FirebaseMessaging } = await import('@capacitor-firebase/messaging');
    const perm = await FirebaseMessaging.checkPermissions();
    if (perm?.receive === 'granted') {
      // Keeps the synchronous reader honest for the rest of the page load.
      localStorage.removeItem('flock_notif_denied');
      return 'granted';
    }
    if (perm?.receive === 'denied') {
      localStorage.setItem('flock_notif_denied', 'true');
      return 'denied';
    }
    return 'default';
  } catch (err) {
    return getNotificationStatus();
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
//
// IT REGISTERS. IT DOES NOT ASK. Round 8: the tick below called
// requestNotificationPermission, so on the first session it ever saw it drew
// the OS notification prompt about two seconds after the account was created,
// over an empty home screen, before the user had seen a single thing that
// says what a Flock notification is. iOS gives an app one prompt per install
// and a denial is permanent, so that was the only ask this app will ever get,
// spent at the moment it could explain itself least and could not be spent
// again. It now registers a device whose OS has already granted permission,
// where nothing is drawn, and the ask itself lives where the reason for it is
// on the screen: the Enable button in Settings, and the row inside a flock
// chat that names what that flock would notify you about.
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
    // syncPushRegistration, NOT requestNotificationPermission. This line ran
    // about two seconds after signup, over an empty home screen, and drew the
    // OS notification prompt there. See the header above startPushSession-
    // Watcher for the whole argument.
    const token = await syncPushRegistration();
    if (token) {
      handledAuthToken = authToken;
      attempts = 0;
      return;
    }
    // No token, for one of two very different reasons. Either the device has
    // no permission to register with, in which case there is nothing here to
    // retry and the session is settled until somebody taps the ask; or the
    // permission is there and the registration itself failed (offline, backend
    // hiccup), which is worth another tick.
    const status = await readNotificationPermission();
    attempts += 1;
    if (status !== 'granted' || attempts >= MAX_ATTEMPTS) {
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
async function rearmIfUnresolved() {
  if (currentPushToken) return;
  let status = getNotificationStatus();
  if (status === 'denied' && isNativeApp()) {
    // The sticky marker says denied, but the person may have turned
    // notifications on in Settings since. Ask the OS; a grant clears the
    // marker (readNotificationPermission does that) and the re-arm proceeds.
    // Without this, a fix in Settings was not noticed until a cold start.
    try { status = await readNotificationPermission(); } catch (_) { /* keep the marker's answer */ }
  }
  if (status === 'denied' || status === 'unsupported') return;
  // The web-only "granted" condition that used to be here was guarding against
  // a re-arm turning into a second prompt. The path it re-arms cannot prompt
  // any more, so the worst a re-arm can now do is one no-op, and the case it
  // was blocking is the one that matters: permission granted from the ask in a
  // flock chat, on a session the watcher had already given up on.
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

  // THE ACCOUNT-WIDE PATH IS FOR A DEVICE THAT HAD A TOKEN AND LOST TRACK OF
  // IT, not for one that never had one. The overwhelmingly common null case is
  // a device that never registered at all: every browser, and every install
  // where the person never granted permission. Signing out there used to call
  // unregisterAllTokens, which dropped the token on their PHONE, silently, and
  // the phone's own watcher does not repair it (its auth token is already
  // settled and rearmIfUnresolved returns early while a token is held). So push
  // stopped everywhere until a force quit. Permission is the tell: a device
  // that was never granted cannot own a token.
  const everRegistered = !!token || getNotificationStatus() === 'granted';
  const request = token
    ? unregisterDeviceToken(token).catch(() => {})
    : everRegistered
      // Only rows of this device's kind: a browser cannot own the phone's
      // token, so it must not be the one to delete it (notifications audit,
      // 2026-09-05).
      ? unregisterAllTokens(isNativeApp() ? (window.Capacitor.getPlatform() === 'android' ? 'android' : 'ios') : 'web').catch(() => {})
      : Promise.resolve();

  // Drop the token on the device too, so the next account on this device gets
  // a fresh one rather than inheriting the previous user's subscription.
  Promise.resolve().then(async () => {
    try {
      if (isNativeApp()) {
        const { FirebaseMessaging } = await import('@capacitor-firebase/messaging');
        await FirebaseMessaging.deleteToken();
        return;
      }
      // Only if this page load actually reached for the SDK, which means this
      // device registered, or is registering, during this session and has a
      // token in the SDK's IndexedDB to drop. Without that condition a logout
      // would download the whole SDK to delete a token that cannot exist, on a
      // device whose user never turned notifications on. The server side row
      // is removed by the request above either way, and that is the half that
      // stops the pushes.
      //
      // sdkPromise rather than `messaging` alone, so a logout that lands while
      // the boot registration is still in flight still deletes the token it is
      // about to be handed.
      if (!sdkPromise) return;
      const m = await getFirebaseMessaging();
      if (!m) return;
      const [, { deleteToken }] = await loadMessagingSdk();
      await deleteToken(m);
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

  // The web branch now has the same shape as the native one above, and for the
  // same reason: React calls this from an effect and uses what it returns as
  // the cleanup, so the signature has to stay synchronous even though the SDK
  // behind it arrives later. Cleanup that runs before the import resolves has
  // to remove the listener the moment it exists, or a fast unmount and remount
  // leaves the old one attached and every foreground push draws two toasts.
  let cancelled = false;
  let remove = () => {};

  const attach = () => {
    (async () => {
      const m = await getFirebaseMessaging();
      if (!m || cancelled) return;
      const [, { onMessage }] = await loadMessagingSdk();
      const stop = onMessage(m, (payload) => {
        callback({
          title: payload.notification?.title || '',
          body: payload.notification?.body || '',
          data: payload.data || {},
        });
      });
      if (cancelled) { stop(); return; }
      remove = stop;
    })().catch(() => {});
  };

  // App.js calls this from a mount effect for EVERY signed in user, so an
  // unconditional attach here would fetch the SDK on every launch and undo the
  // whole point of loading it lazily. onMessage only ever fires for a device
  // that holds an FCM token, and holding one requires granted permission, so
  // waiting costs nothing: a browser that has not granted cannot receive a
  // foreground push to miss.
  //
  // The wait is not a refusal. The mount effect has an empty dependency list,
  // so it never runs again, and somebody who taps Turn on inside a flock chat
  // an hour into the session would otherwise get no foreground toast until the
  // next reload. rememberPushToken is the one place a token appears, whichever
  // path produced it, so it releases the listener the moment there is one.
  if (knownPushToken() || getNotificationStatus() === 'granted') attach();
  else pendingForegroundAttaches.add(attach);

  return () => {
    cancelled = true;
    pendingForegroundAttaches.delete(attach);
    remove();
  };
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
