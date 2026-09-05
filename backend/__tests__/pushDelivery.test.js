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
  // The chat is the default, because most of these ARE the conversation.
  assert.strictEqual(deepLinkPath({ type: 'flock_message', flockId: '12' }), '/?flock=12');
  assert.strictEqual(deepLinkPath({ type: 'flock_confirmed', flockId: '12' }), '/?flock=12');
  assert.strictEqual(deepLinkPath({ type: 'flock_rsvp', flockId: '12' }), '/?flock=12');
  assert.strictEqual(deepLinkPath({ type: 'guest_rsvp', flockId: '12' }), '/?flock=12');
  assert.strictEqual(deepLinkPath({ type: 'dm_message', senderId: '4' }), '/?dm=4');
  assert.strictEqual(deepLinkPath({ type: 'friend_request', fromUserId: '4' }), '/?tab=you');
});

// ---------------------------------------------------------------------------
// The five that used to land one screen away, and the three that landed nowhere
//
// Every flock-scoped type resolved to `/?flock=<id>`, which App.js turns into
// the flock's CHAT. So "you owe Ava $12" opened a conversation, "your
// reliability score updated" opened a conversation, and an INVITE opened a
// conversation for a flock that is not in the accepted list at all — which
// meant either somebody else's plan or a panel calling the live invite deleted.
// ---------------------------------------------------------------------------
test('money, budget and forecast open the surface they name, not the chat next to it', () => {
  const { deepLinkPath } = firebaseService;
  assert.strictEqual(deepLinkPath({ type: 'bill_created', flockId: '12' }), '/?flock=12&view=bill');
  assert.strictEqual(deepLinkPath({ type: 'bill_settled', flockId: '12' }), '/?flock=12&view=bill');
  assert.strictEqual(deepLinkPath({ type: 'budget_ready', flockId: '12' }), '/?flock=12&view=budget');
  assert.strictEqual(deepLinkPath({ type: 'budget_reminder', flockId: '12' }), '/?flock=12&view=budget');
  assert.strictEqual(deepLinkPath({ type: 'crowd_alert', flockId: '12' }), '/?flock=12&view=plan');
  assert.strictEqual(deepLinkPath({ type: 'flock_updated', flockId: '12' }), '/?flock=12&view=plan');
  assert.strictEqual(deepLinkPath({ type: 'flock_cancelled', flockId: '12' }), '/?flock=12&view=plan');
});

test('an invite lands on the invite, and a score lands on the score', () => {
  const { deepLinkPath } = firebaseService;
  // NOT /?flock=12. An invited flock is not in the list the chat resolves
  // against, so a chat link for one can only ever miss.
  assert.strictEqual(deepLinkPath({ type: 'flock_invite', flockId: 12 }), '/?invite=12');
  // The reliability score is printed on the profile. The flock is the occasion,
  // not the subject.
  assert.strictEqual(deepLinkPath({ type: 'attendance_marked', flockId: '12' }), '/?tab=you');
});

test('the types that used to resolve to nothing now have a destination', () => {
  const { deepLinkPath } = firebaseService;
  // This one did nothing at all when tapped: '/' on the link side and null out
  // of the client's intent parser.
  assert.strictEqual(deepLinkPath({ type: 'moderation_report', reportId: '3' }), '/admin/moderation');
  assert.strictEqual(deepLinkPath({ type: 'friend_accepted', fromUserId: '4' }), '/?tab=you');
  assert.strictEqual(deepLinkPath({ type: 'availability_pulse', fromUserId: '4' }), '/?tab=home');
  // A cancellation whose flock is already deleted carries no id on purpose:
  // there is no row for the visibility gate and no screen to open.
  assert.strictEqual(deepLinkPath({ type: 'flock_cancelled' }), '/?tab=chat');
});

test('a link is never built from an id the payload cannot vouch for', () => {
  const { deepLinkPath } = firebaseService;
  assert.strictEqual(deepLinkPath({ type: 'flock_message', flockId: '12 OR 1=1' }), '/');
  assert.strictEqual(deepLinkPath({ type: 'dm_message', senderId: '../../admin' }), '/');
  assert.strictEqual(deepLinkPath({ type: 'flock_invite', flockId: '../../admin' }), '/');
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

test('an online user whose every device is attended is not pushed', async () => {
  reset();
  // The one device this account has registered is the one holding the socket,
  // so the notification is already on the screen the person is looking at.
  const connected = {
    sockets: {
      adapter: { rooms: new Map([['user:1', new Set(['s1'])]]) },
      sockets: new Map([['s1', { handshake: { auth: { pushToken: 'phone-token-aaaa' } } }]]),
    },
  };
  on(/SELECT token FROM device_tokens/i, () => ({ rows: [{ token: 'phone-token-aaaa' }] }));
  on(/INSERT INTO push_sends/i, () => ({ rows: [], rowCount: 1 }));
  const res = await pushHelper.pushIfOffline(connected, 1, 'T', 'B', { type: 'flock_message', flockId: 7 });
  assert.strictEqual(res.reason, 'online');
  assert.strictEqual(sends.length, 0);
  // No visibility check and no provider call. The device lookup is the one
  // query this path now costs, and it is the entire fix: without it a socket
  // spoke for the whole account.
  assert.ok(!log.some((l) => /FROM users u/i.test(l.sql)), 'a suppressed push must not spend a visibility check');
});

// ---------------------------------------------------------------------------
// THE LAPTOP TAB. This is the bug the rule above replaces, stated as a test.
//
// Before 2026-08-25 any socket in `user:{id}` suppressed every push on the
// account. A tab left open on a laptop therefore killed notifications on the
// owner's phone for as long as the tab existed, with no symptom: the app is
// open, the messages are there when you look, the phone is simply silent.
// ---------------------------------------------------------------------------
test('a laptop tab left open does not silence the phone in your pocket', async () => {
  reset();
  const connected = {
    sockets: {
      adapter: { rooms: new Map([['user:1', new Set(['laptop'])]]) },
      sockets: new Map([['laptop', { handshake: { auth: { pushToken: 'laptop-token-bbbb' } } }]]),
    },
  };
  on(/SELECT token FROM device_tokens/i, () => ({
    rows: [{ token: 'laptop-token-bbbb' }, { token: 'phone-token-aaaa' }],
  }));
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, can_see: true }] }));
  on(/SELECT timezone FROM device_tokens/i, () => ({ rows: [] }));
  on(/INSERT INTO push_sends/i, () => ({ rows: [], rowCount: 1 }));
  on(/UPDATE device_tokens SET updated_at/i, () => ({ rows: [], rowCount: 2 }));

  const res = await pushHelper.pushIfOffline(connected, 1, 'Ava', 'see you at 9', {
    type: 'flock_message', flockId: 7,
  });
  assert.strictEqual(res.sent, 1, 'the unattended phone must still be told');
});

test('a socket that names no device silences nothing', async () => {
  reset();
  // An older client build, or a browser that refused notification permission.
  // It cannot be lined up with a device_tokens row, so it speaks for no device.
  const connected = {
    sockets: {
      adapter: { rooms: new Map([['user:1', new Set(['anon'])]]) },
      sockets: new Map([['anon', { handshake: { auth: {} } }]]),
    },
  };
  on(/SELECT token FROM device_tokens/i, () => ({ rows: [{ token: 'phone-token-aaaa' }] }));
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, can_see: true }] }));
  on(/SELECT timezone FROM device_tokens/i, () => ({ rows: [] }));
  on(/INSERT INTO push_sends/i, () => ({ rows: [], rowCount: 1 }));
  on(/UPDATE device_tokens SET updated_at/i, () => ({ rows: [], rowCount: 1 }));
  const res = await pushHelper.pushIfOffline(connected, 1, 'T', 'B', { type: 'flock_message', flockId: 7 });
  assert.strictEqual(res.sent, 1);
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
  // ONE question about the recipient: the account lookup, with no flock id and
  // no actor bound to it. Everything else on this path is bookkeeping, and none
  // of it can change the verdict: the badge count, the delivery ledger and the
  // token liveness stamp.
  const roster = log.filter((l) => /FROM users u/i.test(l.sql));
  assert.strictEqual(roster.length, 1);
  assert.deepStrictEqual(roster[0].params, [1, null]);
  assert.ok(!log.some((l) => /FROM flocks f/i.test(l.sql) && !/FROM users u/i.test(l.sql)));
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

// Reversed by the 2026-08-14 safety audit. This used to assert fail-OPEN, on
// the reasoning that a blip must not mute notifications. But canNotify is a
// block-enforcement point — the only one in the codebase that failed open —
// and failing open there means a database blip pushes a blocked user's name to
// the lock screen of the person who blocked them. Every sibling check (blocks
// helpers, the socket presence fan-out, moderation reads) already fails closed.
// A dropped notification is recoverable the moment the user opens the app; a
// delivered one is not.
test('a visibility lookup that fails suppresses the push instead of guessing', async () => {
  reset();
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => Promise.reject(new Error('connection terminated')));
  const res = await pushHelper.pushIfOffline(offline, 1, 'T', 'B', { type: 'flock_message', flockId: 7 });
  // STILL SUPPRESSED - that is the guarantee and it has not moved. What changed
  // is that the reason now says the check FAILED rather than that it answered
  // no. The outbox sweep deleted a row on 'not-visible', so a Postgres blip
  // during the 08:00 release of a quiet-hours DM destroyed the notification
  // outright while the ledger recorded a legitimate suppression.
  assert.strictEqual(sends.length, 0, 'fails closed: an unanswerable block check sends nothing');
  assert.strictEqual(res.reason, 'visibility-uncheckable');
  assert.notStrictEqual(res.reason, 'not-visible',
    'an outage and a recipient who may not see this must not share one reason');
});

// The block lookup itself throws BEFORE the visibility query — same rule.
test('a block lookup that throws suppresses the push', async () => {
  reset();
  on(/FROM user_blocks/i, () => Promise.reject(new Error('connection terminated')));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, can_see: true }] }));
  const res = await pushHelper.pushIfOffline(offline, 1, 'T', 'B', { type: 'dm_message', senderId: 2 });
  assert.strictEqual(res.reason, 'visibility-uncheckable');
  assert.strictEqual(sends.length, 0);
});

test('a recipient who genuinely may not see it still reads as not-visible', async () => {
  // The other side of the split, so the two cannot quietly collapse back into
  // one value: a healthy lookup that answers "no" is a permanent property of
  // the recipient and the sweep is right to drop that row.
  reset();
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, can_see: false }] }));
  const res = await pushHelper.pushIfOffline(offline, 1, 'T', 'B', { type: 'flock_message', flockId: 7 });
  assert.strictEqual(res.reason, 'not-visible');
  assert.strictEqual(sends.length, 0);
});

test('a failed check does not leave its mark on the next recipient', async () => {
  // The failure used to be recorded in a module-scope set keyed by recipient
  // that deliver() cleared; it now travels back as the check's own return
  // value. Kept as the guard it always was: if a failure ever outlived its
  // call again, the next push to that account would be filed as an outage and
  // retried forever.
  reset();
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => Promise.reject(new Error('connection terminated')));
  const first = await pushHelper.pushIfOffline(offline, 1, 'T', 'B', { type: 'flock_message', flockId: 7 });
  assert.strictEqual(first.reason, 'visibility-uncheckable');

  reset();
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, can_see: false }] }));
  const second = await pushHelper.pushIfOffline(offline, 1, 'T', 'B', { type: 'flock_message', flockId: 7 });
  assert.strictEqual(second.reason, 'not-visible', 'the previous failure was still marked');
});

// Two pushes to ONE recipient are routinely in flight together: a DM and a
// flock message landing in the same second, or a Promise.allSettled fan-out
// that names the same person twice. The failure marker used to live in a
// module-level set keyed by recipient, so a sibling delivery whose lookup
// settled in the same tick could clear it (filing the outage as 'not-visible',
// which the outbox sweep deletes for good) or claim it (filing a healthy "no"
// as an outage to be retried). The fixture parks both visibility lookups and
// settles them in one tick, the healthy one first, which is the order that
// lost the mark.
async function twoInFlight(dataA, dataB) {
  const parked = [];
  on(/FROM users u/i, () => new Promise((resolve, reject) => { parked.push({ resolve, reject }); }));
  const a = pushHelper.pushIfOffline(offline, 1, 'T', 'A', dataA);
  const b = pushHelper.pushIfOffline(offline, 1, 'T', 'B', dataB);
  while (parked.length < 2) await new Promise((r) => setImmediate(r));
  return { a, b, parked };
}

test('a sibling delivery that succeeds does not take the outage away from the one that failed', async () => {
  reset();
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  const { a, b, parked } = await twoInFlight(
    { type: 'flock_message', flockId: 7 }, { type: 'flock_message', flockId: 8 });
  parked[1].resolve({ rows: [{ is_banned: false, can_see: true }] });
  parked[0].reject(new Error('connection terminated'));
  const [ra, rb] = await Promise.all([a, b]);
  assert.strictEqual(ra.reason, 'visibility-uncheckable',
    'the outage was filed as a permanent suppression because a sibling cleared its mark');
  assert.strictEqual(rb.sent, 1, 'the healthy delivery still goes out');
  assert.strictEqual(sends.length, 1);
});

test('a sibling delivery that is refused does not swap answers with the one that failed', async () => {
  reset();
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  const { a, b, parked } = await twoInFlight(
    { type: 'flock_message', flockId: 7 }, { type: 'flock_message', flockId: 8 });
  parked[1].resolve({ rows: [{ is_banned: false, can_see: false }] });
  parked[0].reject(new Error('connection terminated'));
  const [ra, rb] = await Promise.all([a, b]);
  assert.strictEqual(ra.reason, 'visibility-uncheckable');
  assert.strictEqual(rb.reason, 'not-visible', 'a healthy "no" was filed as an outage and retried');
  assert.strictEqual(sends.length, 0);
});

test('two failed checks in one tick are both filed as outages', async () => {
  // A set cannot count. With both lookups failing in the same tick the first
  // reader took the one mark and the second found nothing, so one of two
  // identical outages was deleted by the sweep as a refusal.
  reset();
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  const { a, b, parked } = await twoInFlight(
    { type: 'flock_message', flockId: 7 }, { type: 'flock_message', flockId: 8 });
  parked[0].reject(new Error('connection terminated'));
  parked[1].reject(new Error('connection terminated'));
  const [ra, rb] = await Promise.all([a, b]);
  assert.strictEqual(ra.reason, 'visibility-uncheckable');
  assert.strictEqual(rb.reason, 'visibility-uncheckable');
  assert.strictEqual(sends.length, 0);
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
    assert.deepStrictEqual(upsert.params, [1, 'a'.repeat(160), 'ios', null]);
  });

  await t.test('a device registers the clock quiet hours are decided on', async () => {
    reset();
    let upsert = null;
    on(/INSERT INTO device_tokens/i, (params, sql) => { upsert = { params, sql }; return { rows: [] }; });
    const res = await call('/api/notifications/register', 'POST', {
      token: 'b'.repeat(160), deviceType: 'ios', timezone: 'America/New_York',
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(upsert.params[3], 'America/New_York');
    // Widened, never cleared. An older client build on the same device posts no
    // timezone, and wiping the stored one would switch quiet hours off for
    // anybody who signs in from two clients.
    assert.match(upsert.sql, /timezone = COALESCE\(EXCLUDED\.timezone, device_tokens\.timezone\)/);
  });

  await t.test('a nonsense timezone is refused rather than stored', async () => {
    reset();
    on(/INSERT INTO device_tokens/i, () => { throw new Error('should not reach the database'); });
    const res = await call('/api/notifications/register', 'POST', {
      token: 'c'.repeat(160), timezone: 'Nowhere; DROP TABLE device_tokens',
    });
    assert.strictEqual(res.status, 400);
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

// The expectations here were written when the worker's fallback was a shorter,
// worse copy of deepLinkPath, and they pinned that worse copy in place. Two of
// the five were the exact defects the other two tap paths had already fixed:
// `flock_invite` resolved to the flock CHAT, which reads against the ACCEPTED
// list an invited flock is by definition not in, and `moderation_report`
// resolved to "/", which is the "landed nowhere" case. The fallback now answers
// what the backend answers, so this pins agreement rather than a snapshot of
// one file.
test('the type map still routes a notification sent before data.link existed', async () => {
  for (const [data, expected] of [
    [{ type: 'flock_invite', flockId: '3' }, 'https://flockcorp.com/?invite=3'],
    [{ type: 'dm_message', senderId: '8' }, 'https://flockcorp.com/?dm=8'],
    [{ type: 'friend_request' }, 'https://flockcorp.com/?tab=you'],
    [{ type: 'friend_accepted' }, 'https://flockcorp.com/?tab=you'],
    [{ type: 'availability_pulse' }, 'https://flockcorp.com/?tab=home'],
    [{ type: 'attendance_marked', flockId: '3' }, 'https://flockcorp.com/?tab=you'],
    [{ type: 'crowd_alert', flockId: '3' }, 'https://flockcorp.com/?flock=3'],
    [{ type: 'flock_cancelled', flockId: '3' }, 'https://flockcorp.com/?flock=3'],
    [{ type: 'flock_cancelled' }, 'https://flockcorp.com/?tab=chat'],
    [{ type: 'moderation_report' }, 'https://flockcorp.com/admin/moderation'],
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
