// Run: node --test  (from backend/)
//
// Round 7 — the push delivery path.
//
// Notifications are how a planning app pulls people back to a plan, so a
// silent failure here is a product failure. What this file pins down:
//
//   1. A tap has somewhere to go. Every notification used to ship
//      `fcmOptions.link: '/'`, so the FCM service worker's own click handler
//      opened the home screen no matter what the notification was about.
//   2. A push is only sent to someone who can still SEE the thing. Membership
//      and blocks are re-checked at DELIVERY time, not just at write time: a
//      member who left at 6pm was still told "It's happening!" at 8pm, and a
//      queued crowd alert still fired for a deleted flock.
//   3. Blocked users cannot reach each other through a notification.
//   4. The debounce is per conversation. Keyed on the user id alone, a DM from
//      one friend swallowed a message in an unrelated flock for 30 seconds and
//      the swallowed notification was never sent by anything.
//   5. Dead tokens are deleted when the provider says the token is gone, and
//      NOT deleted when the provider is complaining about the payload.
//   6. An image or venue-card message has no text, and used to arrive as a
//      title over a blank line.
//   7. Nothing in here touches the database when push is not configured.
const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'push-delivery-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const pool = require('../config/database');

let handlers = [];
let log = [];

function dispatch(sql, params) {
  log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  for (const [re, fn] of handlers) {
    if (re.test(sql)) {
      const out = fn(params || [], String(sql));
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 120)}`));
}

pool.query = (sql, params) => dispatch(sql, params);

const firebaseService = require('../services/firebaseService');
const pushHelper = require('../services/pushHelper');

// Push is "on" for these tests without any Firebase credentials: the helper
// asks the service whether delivery is possible, and the service is the only
// thing that needs real config.
let pushEnabled = true;
let sends = [];
firebaseService.isEnabled = () => pushEnabled;
firebaseService.sendPushToUser = async (userId, title, body, data) => {
  sends.push({ userId, title, body, data });
  return { sent: 1, failed: 0 };
};

function reset() {
  handlers = [];
  log = [];
  sends = [];
  pushEnabled = true;
  pushHelper._resetDebounce();
}

function on(re, fn) { handlers.push([re, fn]); }

// Default world: nobody blocks anybody, everybody is still in flock 7.
function openWorld() {
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, can_see: true }] }));
}

const io = { sockets: { adapter: { rooms: new Map() } } };
const offline = io; // no rooms == nobody connected

// ---------------------------------------------------------------------------
// 1. Deep links
// ---------------------------------------------------------------------------
test('every notification type resolves to the screen it is about', () => {
  const { deepLinkPath } = firebaseService;
  assert.strictEqual(deepLinkPath({ type: 'flock_message', flockId: '12' }), '/?flock=12');
  assert.strictEqual(deepLinkPath({ type: 'flock_invite', flockId: 12 }), '/?flock=12');
  assert.strictEqual(deepLinkPath({ type: 'flock_confirmed', flockId: '12' }), '/?flock=12');
  assert.strictEqual(deepLinkPath({ type: 'bill_created', flockId: '12' }), '/?flock=12');
  assert.strictEqual(deepLinkPath({ type: 'crowd_alert', flockId: '12' }), '/?flock=12');
  assert.strictEqual(deepLinkPath({ type: 'guest_rsvp', flockId: '12' }), '/?flock=12');
  assert.strictEqual(deepLinkPath({ type: 'attendance_marked', flockId: '12' }), '/?flock=12');
  assert.strictEqual(deepLinkPath({ type: 'dm_message', senderId: '4' }), '/?dm=4');
  assert.strictEqual(deepLinkPath({ type: 'friend_request', fromUserId: '4' }), '/?tab=you');
});

test('a link is never built from an id the payload cannot vouch for', () => {
  const { deepLinkPath } = firebaseService;
  assert.strictEqual(deepLinkPath({ type: 'flock_message', flockId: '12 OR 1=1' }), '/');
  assert.strictEqual(deepLinkPath({ type: 'dm_message', senderId: '../../admin' }), '/');
  assert.strictEqual(deepLinkPath({ type: 'moderation_report', reportId: '3' }), '/');
  assert.strictEqual(deepLinkPath({}), '/');
});

test('the destination travels in the data payload, not just the web link', () => {
  const msg = firebaseService.buildFcmMessage('tok', 'Title', 'Body', {
    type: 'dm_message', senderId: 9,
  });
  // The native tap handler and our service worker both read data.link; the web
  // SDK reads webpush.fcmOptions.link. They must agree.
  assert.strictEqual(msg.data.link, '/?dm=9');
  assert.strictEqual(msg.data.senderId, '9');
});

test('webpush link is absolute https or absent — FCM rejects anything else', () => {
  const prev = process.env.FRONTEND_URL;

  process.env.FRONTEND_URL = 'https://flockcorp.com/';
  let msg = firebaseService.buildFcmMessage('tok', 'T', 'B', { type: 'flock_message', flockId: 3 });
  assert.strictEqual(msg.webpush.fcmOptions.link, 'https://flockcorp.com/?flock=3');

  process.env.FRONTEND_URL = 'http://localhost:3000';
  msg = firebaseService.buildFcmMessage('tok', 'T', 'B', { type: 'flock_message', flockId: 3 });
  assert.strictEqual(msg.webpush.fcmOptions, undefined);
  assert.strictEqual(msg.data.link, '/?flock=3', 'the SW still knows where to go');

  if (prev === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = prev;
});

test('an alert makes a sound on iOS and collapses per conversation', () => {
  const msg = firebaseService.buildFcmMessage('tok', 'T', 'B', { type: 'flock_message', flockId: 3 });
  assert.strictEqual(msg.apns.payload.aps.sound, 'default');
  assert.strictEqual(msg.apns.headers['apns-push-type'], 'alert');
  assert.strictEqual(msg.apns.headers['apns-collapse-id'], 'flock_message-f3');
  assert.ok(msg.apns.headers['apns-collapse-id'].length <= 64);
  assert.strictEqual(msg.android.collapseKey, 'flock_message-f3');
  assert.strictEqual(msg.webpush.notification.tag, 'flock_message-f3');
});

// ---------------------------------------------------------------------------
// 6. Empty bodies
// ---------------------------------------------------------------------------
test('a photo or venue card never arrives as a title over a blank line', () => {
  const { normalizeBody } = firebaseService;
  assert.strictEqual(normalizeBody('', 'dm_message'), 'Sent you something');
  assert.strictEqual(normalizeBody('   ', 'flock_message'), 'Shared something in the chat');
  assert.strictEqual(normalizeBody(undefined, 'flock_confirmed'), 'Open Flock to see it');
  assert.strictEqual(normalizeBody('Real text', 'dm_message'), 'Real text');
});

// ---------------------------------------------------------------------------
// 5. Dead tokens
// ---------------------------------------------------------------------------
test('a token is deleted when the provider says the token is gone', () => {
  const { isStaleError } = firebaseService;
  assert.strictEqual(isStaleError({ code: 'messaging/registration-token-not-registered' }), true);
  assert.strictEqual(isStaleError({ code: 'messaging/invalid-registration-token' }), true);
  assert.strictEqual(
    isStaleError({ code: 'messaging/invalid-argument', message: 'The registration token is not a valid FCM registration token' }),
    true
  );
});

test('a token survives a complaint about the payload', () => {
  const { isStaleError } = firebaseService;
  // Same error code, entirely different meaning. Deleting good tokens because
  // the body was malformed is a self-inflicted outage.
  assert.strictEqual(isStaleError({ code: 'messaging/invalid-argument', message: 'Invalid JSON payload received.' }), false);
  assert.strictEqual(isStaleError({ code: 'messaging/server-unavailable' }), false);
  assert.strictEqual(isStaleError({ code: 'messaging/internal-error' }), false);
  assert.strictEqual(isStaleError(null), false);
});

// ---------------------------------------------------------------------------
// 7. No config, no work
// ---------------------------------------------------------------------------
test('push that cannot be delivered does not query the database', async () => {
  reset();
  pushEnabled = false;
  // No handlers registered at all: any query would reject as unscripted.
  const a = await pushHelper.pushIfOffline(offline, 1, 'T', 'B', { type: 'flock_message', flockId: 7 });
  const b = await pushHelper.pushIfOfflineDebounced(offline, 1, 'T', 'B', { type: 'dm_message', senderId: 2 });
  const c = await pushHelper.pushAlways(1, 'T', 'B', { type: 'crowd_alert', flockId: 7 });
  assert.deepStrictEqual([a.reason, b.reason, c.reason], ['disabled', 'disabled', 'disabled']);
  assert.strictEqual(log.length, 0);
  assert.strictEqual(sends.length, 0);
});

test('an online user is not pushed, and is not looked up either', async () => {
  reset();
  const connected = { sockets: { adapter: { rooms: new Map([['user:1', new Set(['s1'])]]) } } };
  const res = await pushHelper.pushIfOffline(connected, 1, 'T', 'B', { type: 'flock_message', flockId: 7 });
  assert.strictEqual(res.reason, 'online');
  assert.strictEqual(log.length, 0);
});

// ---------------------------------------------------------------------------
// 2. Can the recipient still see it
// ---------------------------------------------------------------------------
test('a member who left the flock is not told what the flock is doing', async () => {
  reset();
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, can_see: false }] }));

  const res = await pushHelper.pushIfOffline(offline, 1, "It's happening!", 'Friday', {
    type: 'flock_confirmed', flockId: 7,
  });
  assert.strictEqual(res.skipped, true);
  assert.strictEqual(res.reason, 'not-visible');
  assert.strictEqual(sends.length, 0);
});

test('a deleted flock cannot fire a queued crowd alert', async () => {
  reset();
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, can_see: false }] })); // the flock row is gone

  const res = await pushHelper.pushAlways(1, 'Busy tonight', 'Get there early', {
    type: 'crowd_alert', flockId: 7,
  });
  assert.strictEqual(res.reason, 'not-visible');
  assert.strictEqual(sends.length, 0);
});

test('an invited user still gets the invite that created their row', async () => {
  reset();
  openWorld();
  const res = await pushHelper.pushIfOffline(offline, 1, 'Ava invited you', 'Friday', {
    type: 'flock_invite', flockId: 7,
  });
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(res.sent, 1);
  const membershipQuery = log.find((l) => /FROM users u/i.test(l.sql));
  assert.match(membershipQuery.sql, /'accepted', 'invited'/);
});

test('the flock check accepts the creator, who need not be in flock_members', async () => {
  reset();
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, (params, sql) => {
    assert.match(sql, /f\.creator_id = u\.id/);
    return { rows: [{ is_banned: false, can_see: true }] };
  });
  const res = await pushHelper.pushIfOffline(offline, 9, 'Sam is going!', 'Friday', {
    type: 'flock_rsvp', flockId: 7,
  });
  assert.strictEqual(res.sent, 1);
});

test('a push with no flock still confirms the recipient is a real, allowed account', async () => {
  reset();
  // Admin moderation alerts carry no flock and no actor. One lookup, no block
  // check, and no flock subquery result to satisfy.
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, can_see: true }] }));
  const res = await pushHelper.pushIfOffline(offline, 1, 'New report', 'Someone reported a message', {
    type: 'moderation_report', reportId: '5',
  });
  assert.strictEqual(res.sent, 1);
  assert.strictEqual(log.length, 1);
  assert.deepStrictEqual(log[0].params, [1, null]);
});

test('a banned account is not pulled back into an app that rejects it', async () => {
  reset();
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: true, can_see: true }] }));
  const res = await pushHelper.pushIfOffline(offline, 1, 'Ava invited you', 'Friday', {
    type: 'flock_invite', flockId: 7,
  });
  assert.strictEqual(res.reason, 'not-visible');
  assert.strictEqual(sends.length, 0);
});

test('a deleted account is not pushed to on the strength of a leftover token', async () => {
  reset();
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => ({ rows: [] }));
  const res = await pushHelper.pushIfOffline(offline, 1, 'T', 'B', { type: 'friend_request', fromUserId: 2 });
  assert.strictEqual(res.reason, 'not-visible');
});

test('a visibility lookup that fails does not silence the whole feature', async () => {
  reset();
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => Promise.reject(new Error('connection terminated')));
  const res = await pushHelper.pushIfOffline(offline, 1, 'T', 'B', { type: 'flock_message', flockId: 7 });
  assert.strictEqual(res.sent, 1, 'fails open: a database blip must not mute notifications');
});

// ---------------------------------------------------------------------------
// 3. Blocks
// ---------------------------------------------------------------------------
test('a blocked user cannot reach their blocker through a notification', async () => {
  reset();
  on(/FROM user_blocks/i, () => ({ rows: [{ '?column?': 1 }] }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, can_see: true }] }));

  const dm = await pushHelper.pushIfOfflineDebounced(offline, 1, 'Mallory', 'hey', {
    type: 'dm_message', senderId: 2,
  });
  assert.strictEqual(dm.reason, 'not-visible');

  const friend = await pushHelper.pushIfOffline(offline, 1, 'New friend request', 'Mallory wants to be friends', {
    type: 'friend_request', fromUserId: 2,
  });
  assert.strictEqual(friend.reason, 'not-visible');

  // Naming a blocked user in a flock notification leaks them just the same.
  const rsvp = await pushHelper.pushIfOffline(offline, 1, 'Mallory is going!', 'Friday', {
    type: 'flock_rsvp', flockId: 7, fromUserId: 2,
  });
  assert.strictEqual(rsvp.reason, 'not-visible');

  assert.strictEqual(sends.length, 0);
});

test('a blocked delivery does not burn the debounce window', async () => {
  reset();
  let blocked = true;
  on(/FROM user_blocks/i, () => ({ rows: blocked ? [{ x: 1 }] : [] }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, can_see: true }] }));

  const first = await pushHelper.pushIfOfflineDebounced(offline, 1, 'A', 'x', { type: 'dm_message', senderId: 2 });
  assert.strictEqual(first.reason, 'not-visible');

  blocked = false;
  const second = await pushHelper.pushIfOfflineDebounced(offline, 1, 'A', 'x', { type: 'dm_message', senderId: 2 });
  assert.strictEqual(second.sent, 1, 'the suppressed push must not have claimed the 30s window');
});

// ---------------------------------------------------------------------------
// 4. Debounce
// ---------------------------------------------------------------------------
test('debounce is per conversation, not per person', () => {
  const { debounceKey } = pushHelper;
  const dmFromAva = debounceKey(1, { type: 'dm_message', senderId: 2 });
  const dmFromSam = debounceKey(1, { type: 'dm_message', senderId: 3 });
  const flockA = debounceKey(1, { type: 'flock_message', flockId: 7 });
  const flockB = debounceKey(1, { type: 'flock_message', flockId: 8 });

  const keys = new Set([dmFromAva, dmFromSam, flockA, flockB]);
  assert.strictEqual(keys.size, 4, 'four unrelated conversations, four windows');
  // Same conversation, same window.
  assert.strictEqual(flockA, debounceKey(1, { type: 'flock_message', flockId: 7 }));
  // Different recipient, different window.
  assert.notStrictEqual(flockA, debounceKey(2, { type: 'flock_message', flockId: 7 }));
});

test('a second message in the same chat is held, an unrelated one is not', async () => {
  reset();
  openWorld();

  const a = await pushHelper.pushIfOfflineDebounced(offline, 1, 'Ava', 'one', { type: 'dm_message', senderId: 2 });
  assert.strictEqual(a.sent, 1);

  const b = await pushHelper.pushIfOfflineDebounced(offline, 1, 'Ava', 'two', { type: 'dm_message', senderId: 2 });
  assert.strictEqual(b.reason, 'debounced');

  // A different friend, and a flock message, must both still get through.
  const c = await pushHelper.pushIfOfflineDebounced(offline, 1, 'Sam', 'hi', { type: 'dm_message', senderId: 3 });
  assert.strictEqual(c.sent, 1);

  const d = await pushHelper.pushIfOfflineDebounced(offline, 1, 'Sam in Friday', 'hi all', { type: 'flock_message', flockId: 7 });
  assert.strictEqual(d.sent, 1);

  assert.deepStrictEqual(sends.map((s) => s.body), ['one', 'hi', 'hi all']);
});

test('a recipient with no device yet does not lose the next thirty seconds', async () => {
  reset();
  openWorld();

  let hasToken = false;
  firebaseService.sendPushToUser = async (userId, title, body, data) => {
    sends.push({ userId, title, body, data });
    return hasToken ? { sent: 1, failed: 0 } : { sent: 0, failed: 0 };
  };

  const first = await pushHelper.pushIfOfflineDebounced(offline, 1, 'Ava', 'one', { type: 'dm_message', senderId: 2 });
  assert.strictEqual(first.sent, 0);

  // They register a device a second later. The next message must reach them.
  hasToken = true;
  const second = await pushHelper.pushIfOfflineDebounced(offline, 1, 'Ava', 'two', { type: 'dm_message', senderId: 2 });
  assert.strictEqual(second.sent, 1);

  firebaseService.sendPushToUser = async (userId, title, body, data) => {
    sends.push({ userId, title, body, data });
    return { sent: 1, failed: 0 };
  };
});

// ---------------------------------------------------------------------------
// Token registration
// ---------------------------------------------------------------------------
test('device token registration', async (t) => {
  const express = require('express');
  const http = require('node:http');

  const authMod = require('../middleware/auth');
  authMod.authenticate = (req, _res, next) => { req.user = { id: 1, name: 'Ava' }; next(); };
  const notificationsRouter = require('../routes/notifications');

  const app = express();
  app.use(express.json());
  app.use('/api/notifications', notificationsRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const call = async (path, method, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  await t.test('a token belongs to exactly one account', async () => {
    reset();
    let upsert = null;
    on(/INSERT INTO device_tokens/i, (params, sql) => { upsert = { params, sql }; return { rows: [] }; });

    const res = await call('/api/notifications/register', 'POST', { token: 'a'.repeat(160), deviceType: 'ios' });
    assert.strictEqual(res.status, 200);
    assert.match(upsert.sql, /ON CONFLICT \(token\) DO UPDATE/i);
    assert.deepStrictEqual(upsert.params, [1, 'a'.repeat(160), 'ios']);
  });

  await t.test('an unbounded token is not stored', async () => {
    reset();
    on(/INSERT INTO device_tokens/i, () => { throw new Error('should not reach the database'); });
    const res = await call('/api/notifications/register', 'POST', { token: 'x'.repeat(5000) });
    assert.strictEqual(res.status, 400);
  });

  await t.test('an unknown device type is rejected, not silently rewritten', async () => {
    reset();
    on(/INSERT INTO device_tokens/i, () => { throw new Error('should not reach the database'); });
    const res = await call('/api/notifications/register', 'POST', { token: 'a'.repeat(160), deviceType: 'toaster' });
    assert.strictEqual(res.status, 400);
  });

  await t.test('logout removes this device only, never the whole account', async () => {
    reset();
    let del = null;
    on(/DELETE FROM device_tokens/i, (params, sql) => { del = { params, sql }; return { rows: [] }; });

    const res = await call('/api/notifications/unregister', 'DELETE', { token: 'a'.repeat(160) });
    assert.strictEqual(res.status, 200);
    assert.match(del.sql, /user_id = \$1 AND token = \$2/i);
    assert.deepStrictEqual(del.params, [1, 'a'.repeat(160)]);
  });
});

// ---------------------------------------------------------------------------
// The web service worker
//
// This file cannot be imported, only evaluated, so it is loaded into a vm with
// a fake `self`. It is worth the trouble: it is the half of the push path that
// runs when nobody is watching, and every one of the behaviours below was
// broken in a way that produced no error anywhere.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SW_PATH = path.join(__dirname, '..', '..', 'frontend', 'public', 'firebase-messaging-sw.js');

// Objects built inside the vm carry that realm's prototypes, which
// deepStrictEqual treats as a difference.
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadServiceWorker({ url = 'https://flockcorp.com/firebase-messaging-sw.js', clients = [] } = {}) {
  const src = fs.readFileSync(SW_PATH, 'utf8');
  const listeners = {};
  const state = {
    initializedWith: null,
    backgroundHandler: null,
    shown: [],
    opened: [],
    posted: [],
    focused: [],
    pending: [],
  };

  const sandbox = {
    console: { warn() {}, error() {} },
    // A fresh vm context gets ECMAScript built-ins only. URL is a host global,
    // and without it every `new URL(...)` in the worker throws into a catch and
    // the tests pass on the fallback path while proving nothing.
    URL,
    URLSearchParams,
    importScripts() {},
    firebase: {
      initializeApp(config) { state.initializedWith = config; },
      messaging() {
        return { onBackgroundMessage(fn) { state.backgroundHandler = fn; } };
      },
    },
    self: {
      location: new URL(url),
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      registration: {
        showNotification(title, options) { state.shown.push({ title, options }); },
      },
      clients: {
        async matchAll() {
          return clients.map((clientUrl) => ({
            url: clientUrl,
            focus() { state.focused.push(clientUrl); return this; },
            postMessage(msg) { state.posted.push(msg); },
          }));
        },
        async openWindow(target) { state.opened.push(target); },
        async claim() {},
      },
      skipWaiting() {},
    },
  };
  sandbox.self.self = sandbox.self;

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'firebase-messaging-sw.js' });

  async function click(notificationData) {
    const event = {
      notification: { data: notificationData, close() {} },
      close() {},
      stopImmediatePropagation() { state.stopped = true; },
      waitUntil(p) { state.pending.push(p); },
    };
    listeners.notificationclick.forEach((fn) => fn(event));
    await Promise.all(state.pending);
    state.pending.length = 0;
  }

  return { state, listeners, click };
}

test('the worker configures itself from its own URL, every restart', () => {
  const withConfig = loadServiceWorker({
    url: 'https://flockcorp.com/firebase-messaging-sw.js?apiKey=k&projectId=p&messagingSenderId=s&appId=a&authDomain=d',
  });
  // Nothing was posted to it and nothing had to activate first. A worker the
  // browser restarts for an incoming push comes up ready.
  // plain() strips the vm realm's prototypes, which deepStrictEqual counts.
  assert.deepStrictEqual(plain(withConfig.state.initializedWith), {
    apiKey: 'k', authDomain: 'd', projectId: 'p', messagingSenderId: 's', appId: 'a',
  });
  assert.strictEqual(typeof withConfig.state.backgroundHandler, 'function');
});

test('a worker with no config in its URL waits rather than half-initialising', () => {
  const bare = loadServiceWorker();
  assert.strictEqual(bare.state.initializedWith, null);
  // The postMessage path still exists for a registration from an older build.
  const message = bare.listeners.message[0];
  message({ data: { type: 'FIREBASE_CONFIG', config: { apiKey: 'k', projectId: 'p' } } });
  assert.strictEqual(bare.state.initializedWith.apiKey, 'k');
});

test('a push that the SDK already displayed is not displayed a second time', () => {
  const sw = loadServiceWorker({
    url: 'https://flockcorp.com/firebase-messaging-sw.js?apiKey=k&projectId=p&messagingSenderId=s',
  });
  sw.state.backgroundHandler({
    notification: { title: 'Ava in Friday', body: 'running late' },
    data: { type: 'flock_message', flockId: '7' },
  });
  assert.strictEqual(sw.state.shown.length, 0, 'the SDK shows notification payloads itself');

  sw.state.backgroundHandler({ data: { type: 'flock_message', flockId: '7', title: 'Ava', body: 'hi' } });
  assert.strictEqual(sw.state.shown.length, 1, 'a data-only push still needs showing');
});

test('a tap on an SDK-shown notification reaches the thing it is about', async () => {
  const sw = loadServiceWorker({ clients: [] });
  // This is the shape the SDK actually puts on the notification: the app's
  // data payload is nested, not copied to the top level.
  await sw.click({
    FCM_MSG: {
      notification: { title: 'Ava', body: 'hey' },
      data: { type: 'dm_message', senderId: '9', link: '/?dm=9' },
      fcmOptions: { link: 'https://flockcorp.com/?dm=9' },
    },
  });
  assert.deepStrictEqual(sw.state.opened, ['https://flockcorp.com/?dm=9']);
});

test('a tap falls back to the FCM link when the data payload predates deep links', async () => {
  const sw = loadServiceWorker({ clients: [] });
  await sw.click({ FCM_MSG: { data: {}, fcmOptions: { link: 'https://flockcorp.com/?flock=4' } } });
  assert.deepStrictEqual(sw.state.opened, ['https://flockcorp.com/?flock=4']);
});

test('a tap never navigates off our own origin, whatever the payload says', async () => {
  const sw = loadServiceWorker({ clients: [] });
  await sw.click({ type: 'flock_message', flockId: '7', link: 'https://evil.example/steal' });
  assert.deepStrictEqual(sw.state.opened, ['https://flockcorp.com/']);
});

test('an open app is handed the destination instead of being reloaded', async () => {
  const sw = loadServiceWorker({ clients: ['https://flockcorp.com/'] });
  await sw.click({ type: 'flock_message', flockId: '7', link: '/?flock=7' });

  assert.strictEqual(sw.state.opened.length, 0, 'a second window would lose the screen the user was on');
  assert.deepStrictEqual(sw.state.focused, ['https://flockcorp.com/']);
  assert.deepStrictEqual(plain(sw.state.posted), [{
    type: 'NOTIFICATION_CLICK',
    data: { type: 'flock_message', flockId: '7', link: '/?flock=7' },
    url: 'https://flockcorp.com/?flock=7',
  }]);
  assert.strictEqual(sw.state.stopped, true, 'the SDK must not also open its own window');
});

test('a foreign window is not treated as our app', async () => {
  const sw = loadServiceWorker({ clients: ['https://mail.example.com/inbox'] });
  await sw.click({ type: 'flock_message', flockId: '7' });
  assert.strictEqual(sw.state.posted.length, 0);
  assert.deepStrictEqual(sw.state.opened, ['https://flockcorp.com/?flock=7']);
});

test('the type map still routes a notification sent before data.link existed', async () => {
  for (const [data, expected] of [
    [{ type: 'flock_invite', flockId: '3' }, 'https://flockcorp.com/?flock=3'],
    [{ type: 'dm_message', senderId: '8' }, 'https://flockcorp.com/?dm=8'],
    [{ type: 'friend_request' }, 'https://flockcorp.com/?tab=you'],
    [{ type: 'crowd_alert', flockId: '3' }, 'https://flockcorp.com/?flock=3'],
    [{ type: 'moderation_report' }, 'https://flockcorp.com/'],
  ]) {
    const sw = loadServiceWorker({ clients: [] });
    await sw.click(data); // eslint-disable-line no-await-in-loop
    assert.deepStrictEqual(sw.state.opened, [expected], JSON.stringify(data));
  }
});

test('the debounce sweep timer never holds the process open', () => {
  // A cleanup timer that keeps the event loop alive turns `node --test` into a
  // hang. Requiring the module must not add a live handle.
  const handles = (process._getActiveHandles ? process._getActiveHandles() : [])
    .filter((h) => h && h.constructor && h.constructor.name === 'Timeout' && h.hasRef && h.hasRef());
  assert.strictEqual(handles.length, 0, 'a referenced timer is keeping the process alive');
});
