// ---------------------------------------------------------------------------
// Push / deep-link navigation bus
//
// A notification tap used to focus the app and stop there. Every source of
// "open this specific thing" now funnels into one intent stream:
//
//   - service worker NOTIFICATION_CLICK  (web, app already open or reopened)
//   - Capacitor notificationActionPerformed  (iOS/Android tap, warm or cold)
//   - Capacitor appUrlOpen  (universal link / custom scheme)
//   - the URL the app was opened with  (?flock=, ?dm=, /f/123, /dm/45)
//
// Intents that arrive before the UI has subscribed are queued, because a cold
// start from a notification tap always arrives first.
// ---------------------------------------------------------------------------

const FLOCK_TYPES = new Set([
  'flock_invite', 'flock_message', 'flock_rsvp', 'flock_confirmed', 'flock_updated',
  'budget_reminder', 'budget_ready', 'bill_created', 'bill_settled',
  'crowd_alert', 'guest_rsvp', 'attendance_marked',
]);

const listeners = new Set();
const queue = [];
let started = false;

function asId(value) {
  if (value === undefined || value === null) return null;
  const n = Number(String(value).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

// A notification data payload -> what the app should open.
export function intentFromData(data) {
  if (!data || typeof data !== 'object') return null;
  const type = data.type ? String(data.type) : '';

  if (type === 'dm_message') {
    const userId = asId(data.senderId);
    return userId ? { screen: 'dm', userId, type } : null;
  }
  if (type === 'friend_request') {
    // 'profile' is the tab id behind the "You" label in App.js.
    return { screen: 'friends', tab: 'profile', type };
  }
  if (FLOCK_TYPES.has(type)) {
    const flockId = asId(data.flockId);
    return flockId ? { screen: 'flock', flockId, type } : null;
  }

  // Unknown type but a usable id: still better than dropping the tap.
  const flockId = asId(data.flockId);
  if (flockId) return { screen: 'flock', flockId, type };
  return null;
}

// A URL -> what the app should open. Handles both the query form the backend
// emits and the path form a universal link would use.
export function intentFromUrl(rawUrl) {
  if (!rawUrl) return null;
  let url;
  try {
    url = new URL(String(rawUrl), typeof window !== 'undefined' ? window.location.origin : 'https://flockcorp.com');
  } catch (err) {
    return null;
  }

  // A custom scheme (flock://flock/123) parses with the first segment as the
  // host, so fold it back into the path before matching.
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.host) {
    try {
      url = new URL(`/${url.host}${url.pathname}${url.search}`, typeof window !== 'undefined' ? window.location.origin : 'https://flockcorp.com');
    } catch (err) { /* keep the original parse */ }
  }

  const q = url.searchParams;
  const flockQ = asId(q.get('flock'));
  if (flockQ) return { screen: 'flock', flockId: flockQ, type: 'link' };
  const dmQ = asId(q.get('dm'));
  if (dmQ) return { screen: 'dm', userId: dmQ, type: 'link' };
  const tab = q.get('tab');
  if (tab === 'you' || tab === 'profile') return { screen: 'friends', tab: 'profile', type: 'link' };

  const flockPath = url.pathname.match(/^\/(?:f|flock)\/(\d+)\/?$/);
  if (flockPath) return { screen: 'flock', flockId: Number(flockPath[1]), type: 'link' };
  const dmPath = url.pathname.match(/^\/dm\/(\d+)\/?$/);
  if (dmPath) return { screen: 'dm', userId: Number(dmPath[1]), type: 'link' };

  return null;
}

function emit(intent) {
  if (!intent) return;
  if (listeners.size === 0) {
    // Only the most recent one matters — a queue of five taps would replay as
    // four flashes of the wrong screen.
    queue.length = 0;
    queue.push(intent);
    return;
  }
  listeners.forEach((fn) => {
    try { fn(intent); } catch (err) { /* a bad subscriber must not break the others */ }
  });
}

export function emitPushNavigation(intent) {
  emit(intent);
}

export function handleNotificationData(data) {
  emit(intentFromData(data));
}

export function handleDeepLinkUrl(url) {
  emit(intentFromUrl(url));
}

/**
 * Subscribe to "open this thing" intents. Returns an unsubscribe function.
 * Any intent that arrived before the first subscriber is delivered immediately.
 */
export function onPushNavigate(handler) {
  if (typeof handler !== 'function') return () => {};
  listeners.add(handler);

  if (queue.length) {
    const pending = queue.splice(0, queue.length);
    // Deliver after the current render pass so the subscriber's own state is
    // mounted before it is asked to navigate.
    Promise.resolve().then(() => pending.forEach((intent) => {
      try { handler(intent); } catch (err) { /* noop */ }
    }));
  }

  return () => listeners.delete(handler);
}

/** The intent the app was opened with, if any, without subscribing. */
export function peekPendingNavigation() {
  return queue.length ? queue[queue.length - 1] : null;
}

const isNativeApp = () =>
  typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() === true;

/**
 * Wire up every source. Safe to call more than once.
 */
export function startPushNavigation() {
  if (started || typeof window === 'undefined') return;
  started = true;

  // 1. The URL the app was opened with. A tap that had to open a new window
  //    lands here, not on the service worker message.
  handleDeepLinkUrl(window.location.href);

  // 2. Service worker click messages (app already open, or reopened by the SW).
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const msg = event?.data;
      if (!msg) return;
      if (msg.type === 'NOTIFICATION_CLICK') {
        // One intent per tap: the payload is authoritative, the URL is the
        // fallback for a notification sent before deep links existed.
        emit(intentFromData(msg.data) || intentFromUrl(msg.url));
        return;
      }
      // The FCM SDK's own click relay, in case a notification shown by an
      // older worker version is tapped.
      if (msg.isFirebaseMessaging && msg.messageType === 'notification-clicked') {
        handleNotificationData(msg.data);
      }
    });
  }

  // 3. Native taps and universal links.
  if (isNativeApp()) {
    import('@capacitor-firebase/messaging')
      .then(({ FirebaseMessaging }) => {
        FirebaseMessaging.addListener('notificationActionPerformed', (event) => {
          const data = event?.notification?.data || {};
          emit(intentFromData(data) || intentFromUrl(data.link));
        });
      })
      .catch(() => {});

    import('@capacitor/app')
      .then(({ App }) => {
        App.addListener('appUrlOpen', (event) => {
          if (event?.url) handleDeepLinkUrl(event.url);
        });
      })
      .catch(() => {});
  }
}

const pushNavigation = { onPushNavigate, startPushNavigation, peekPendingNavigation };
export default pushNavigation;
