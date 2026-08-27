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
//
// WHAT IS ACTUALLY DELIVERED TODAY (re-checked 2026-08-26, and both halves of
// the previous answer had gone stale). The service worker and
// notificationActionPerformed paths are live.
//
// appUrlOpen is live too, and it used to say here that it was not. Info.plist
// declares CFBundleURLTypes now: Google's reversed iOS client id, which the
// GoogleSignIn SDK redirects to at the end of every native sign-in. iOS hands
// that URL to the app, Capacitor fires appUrlOpen, and the listener below runs
// on it. `intentFromUrl` answers null for it, correctly, because it carries no
// invite/flock/dm/admin/tab parameter and its pathname is /oauth2redirect. So
// this function is now reached by a real URL on every native login. Do not
// narrow it on the assumption that nothing calls it.
//
// Universal links are still not delivered, for a different reason than before.
// App.entitlements DOES declare associated domains for flockcorp.com and
// www.flockcorp.com as of 9fab8a9, but frontend/api/apple-app-site-association.js
// excludes every path, so iOS finds nothing claimed and keeps sending
// flockcorp.com links to Safari. The PATH forms below (/f/12, /dm/45) therefore
// remain unreachable on device, and the query form the backend emits
// (/?flock=12) is what exercises this function everywhere else.
//
// It does not parse /i/<token>, the invite link that is the actual growth path,
// and there is no screen in App.js that redeems an invite token either. Those
// two are what the association file is waiting for; claiming /i/* first would
// open the app on whatever screen it was already showing.
// ---------------------------------------------------------------------------

// api.js is the ONLY module that may capture (the analytics sweep enforces it),
// so a notification tap reports through this tracker rather than reaching
// posthog here. It is a static import because api.js is already in this chunk
// (firebase.js, which loads this module, imports it too), and api.js pulls in
// nothing at module scope, so there is no cycle and no new weight.
import { trackPushOpened } from './api';

const FLOCK_TYPES = new Set([
  'flock_invite', 'flock_message', 'flock_rsvp', 'flock_confirmed', 'flock_updated',
  'flock_cancelled',
  'budget_reminder', 'budget_ready', 'bill_created', 'bill_settled',
  'crowd_alert', 'guest_rsvp', 'attendance_marked',
]);

// Which surface inside the flock the notification is about. Kept in step with
// FLOCK_VIEW in backend/services/firebaseService.js, which puts the same word
// in the link's `view` parameter. The data payload is the authoritative path
// (it is what a native tap carries), so the map has to exist on both sides
// rather than the client trusting a query string it may never see.
const FLOCK_VIEWS = new Set(['bill', 'budget', 'plan']);
const VIEW_FOR_TYPE = {
  bill_created: 'bill',
  bill_settled: 'bill',
  budget_ready: 'budget',
  budget_reminder: 'budget',
  flock_updated: 'plan',
  flock_cancelled: 'plan',
  crowd_alert: 'plan',
};

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
  if (type === 'friend_request' || type === 'friend_accepted') {
    // 'profile' is the tab id behind the "You" label in App.js. Both halves of
    // a friend request are answered from the same list, so both land there.
    return { screen: 'friends', tab: 'profile', type };
  }
  if (type === 'attendance_marked') {
    // "Your reliability score updated" is about the recipient, not about the
    // conversation. The number is printed on the profile.
    return { screen: 'friends', tab: 'profile', type };
  }
  if (type === 'availability_pulse') {
    // A friend is free tonight. The Nest is where the answer is: the Tonight
    // control and the button that starts a plan.
    return { screen: 'home', type };
  }
  if (type === 'moderation_report') {
    // Admin only, and previously the one type that resolved to nothing at all.
    // App.js refuses this for any account without the role.
    return { screen: 'admin', type };
  }
  if (type === 'flock_invite') {
    // NOT { screen: 'flock' }. An invited flock is not in the accepted list the
    // chat screen resolves against, so a chat intent for one either opened an
    // unrelated plan or reported this live invite as deleted. The invite lives
    // on the plans list, next to the two buttons that answer it.
    const flockId = asId(data.flockId);
    return flockId ? { screen: 'flockInvite', flockId, type } : null;
  }
  if (FLOCK_TYPES.has(type)) {
    const flockId = asId(data.flockId);
    if (flockId) {
      const view = VIEW_FOR_TYPE[type];
      return view ? { screen: 'flock', flockId, view, type } : { screen: 'flock', flockId, type };
    }
    // A cancelled plan that has already been deleted carries no id on purpose:
    // there is nothing left to open. The plans list is where it belongs.
    if (type === 'flock_cancelled') return { screen: 'flocks', type };
    return null;
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
  const inviteQ = asId(q.get('invite'));
  if (inviteQ) return { screen: 'flockInvite', flockId: inviteQ, type: 'link' };
  const flockQ = asId(q.get('flock'));
  if (flockQ) {
    // `view` is only attached when the link actually carries one, so the plain
    // /?flock=12 form keeps the exact shape it has always had.
    const view = q.get('view');
    return FLOCK_VIEWS.has(view)
      ? { screen: 'flock', flockId: flockQ, view, type: 'link' }
      : { screen: 'flock', flockId: flockQ, type: 'link' };
  }
  const dmQ = asId(q.get('dm'));
  if (dmQ) return { screen: 'dm', userId: dmQ, type: 'link' };
  if (q.get('admin') === 'true') return { screen: 'admin', type: 'link' };
  const tab = q.get('tab');
  if (tab === 'you' || tab === 'profile') return { screen: 'friends', tab: 'profile', type: 'link' };
  if (tab === 'home') return { screen: 'home', type: 'link' };
  if (tab === 'chat') return { screen: 'flocks', type: 'link' };

  // asId, not Number(), for the same reason the query forms above use it: \d+
  // matches "0", and Number('0') is a perfectly well formed id that no row can
  // ever have. That produced { screen: 'dm', userId: 0 }, which App.js then
  // dropped on a falsy check while the query form of the same link answered
  // null. One of those two is a bug whichever way you read it, and an intent
  // that names a row that cannot exist is the one to stop making.
  const flockPath = url.pathname.match(/^\/(?:f|flock)\/(\d+)\/?$/);
  if (flockPath) {
    const flockId = asId(flockPath[1]);
    if (flockId) return { screen: 'flock', flockId, type: 'link' };
  }
  const dmPath = url.pathname.match(/^\/dm\/(\d+)\/?$/);
  if (dmPath) {
    const userId = asId(dmPath[1]);
    if (userId) return { screen: 'dm', userId, type: 'link' };
  }

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

// A notification the user TAPPED, which is the push-notification "open". Report
// it, then route it. Kept distinct from a deep link, the OAuth redirect, the
// launch URL and the invite handoff, none of which is a notification tap: only
// the three notification-click sources below call this. `intent.screen` is the
// resolved destination bucket and never the id the tap carried, and a tap that
// resolved to no intent is still an open, reported as destination 'none'.
function openFromNotification(intent) {
  trackPushOpened(intent && intent.screen);
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
        openFromNotification(intentFromData(msg.data) || intentFromUrl(msg.url));
        return;
      }
      // The FCM SDK's own click relay, in case a notification shown by an
      // older worker version is tapped.
      if (msg.isFirebaseMessaging && msg.messageType === 'notification-clicked') {
        openFromNotification(intentFromData(msg.data));
      }
    });
  }

  // 3. Native taps and universal links.
  if (isNativeApp()) {
    import('@capacitor-firebase/messaging')
      .then(({ FirebaseMessaging }) => {
        // addListener answers a promise. Left unhandled, a plugin that is not
        // registered rejects into an unhandled rejection instead of the quiet
        // no-op every other branch here degrades to.
        const p = FirebaseMessaging.addListener('notificationActionPerformed', (event) => {
          const data = event?.notification?.data || {};
          openFromNotification(intentFromData(data) || intentFromUrl(data.link));
        });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      })
      .catch(() => {});

    import('@capacitor/app')
      .then(({ App }) => {
        // Two halves, and only one of them used to be here.
        //
        // WARM: the app is already running, iOS hands the URL to
        // application(_:open:options:), the plugin fires appUrlOpen, this
        // listener has been attached for a long time. That is the easy case.
        //
        // COLD: the tap LAUNCHES the app. iOS delivers the URL before the web
        // view has loaded a single byte, so by the time this dynamic import
        // resolves and the listener attaches, the event is long gone and the
        // tap opens the app on whatever screen it last had. getLaunchUrl is the
        // plugin's answer for exactly that window, and nothing was asking it.
        //
        // Both orders are possible for the two calls below (the listener can
        // fire before the getLaunchUrl round trip returns, or after), so the
        // de-duplication has to work in both directions: the launch URL is
        // consumed at most once, and an appUrlOpen carrying that same URL
        // straight afterwards is the same tap, not a second one. Routing it
        // twice is a flash of the right screen mounting twice, not a
        // navigation, but it is still wrong.
        let sawUrlEvent = false;
        let launchUrlConsumed = null;

        const p = App.addListener('appUrlOpen', (event) => {
          const url = event?.url;
          if (!url) return;
          sawUrlEvent = true;
          if (url === launchUrlConsumed) { launchUrlConsumed = null; return; }
          handleDeepLinkUrl(url);
        });
        if (p && typeof p.catch === 'function') p.catch(() => {});

        if (typeof App.getLaunchUrl === 'function') {
          Promise.resolve(App.getLaunchUrl())
            .then((result) => {
              const url = result?.url;
              // A launch from the icon has no URL, and a warm tap that already
              // arrived means the live path is working.
              if (!url || sawUrlEvent) return;
              launchUrlConsumed = url;
              handleDeepLinkUrl(url);
            })
            .catch(() => {});
        }
      })
      .catch(() => {});
  }
}

const pushNavigation = { onPushNavigate, startPushNavigation, peekPendingNavigation };
export default pushNavigation;
