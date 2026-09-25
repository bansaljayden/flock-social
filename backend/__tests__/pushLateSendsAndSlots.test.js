// Run: node --test __tests__/pushLateSendsAndSlots.test.js  (from backend/)
//
// Five delivery defects, pinned.
//
//   1. A SEND THE DEADLINE GAVE UP ON IS NOT A FAILED SEND. firebase-admin has
//      no way to cancel a request, so a send still out at the 8 second
//      deadline carried on and very often landed. It came back as a plain
//      failure, so pushHelper queued a retry and a second copy followed a
//      minute later, and services/crowdAlerts.js released its once-per-flock
//      claim so the next sweep sent the whole alert again. The deadline now
//      answers `late`, and every decision waits for it.
//   2. A RETRY GOES TO THE DEVICES THAT FAILED. It used to be all or nothing: a
//      batch where the laptop accepted and the phone got a 5xx was never
//      retried, because a second send to every device would have told the
//      laptop twice. The retry row now names the phone (push_outbox.token_ids).
//   3. ONE LOCK-SCREEN SLOT PER PERSON, NOT PER TYPE. fromUserId was not a
//      conversation scope, so every friend request, "you are now friends" and
//      free-tonight pulse shared one slot, and two payers on one bill replaced
//      each other. The quiet-hours merge keys on the same scope.
//   4. THE SOS ALARM AND ITS ALL-CLEAR SHARE ONE SLOT PER SENDER, so the
//      all-clear replaces the "needs help" notification instead of leaving it
//      in the tray to redraw the alarm when tapped.
//   5. AN SOS WHOSE VISIBILITY CHECK CANNOT BE ANSWERED IS QUEUED, NOT DROPPED.
//      A message waits in the app; an alarm is never replayed.
const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = 'push-late-sends-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.WEATHER_API_KEY;
delete process.env.PAYWALL_ENABLED;
delete process.env.PUSH_QUIET_DEFAULT_TZ;

const pool = require('../config/database');

let handlers = [];
let log = [];

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params: params || [] });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.reject(new Error(`unscripted query: ${flat.slice(0, 140)}`));
}
pool.query = (sql, params) => dispatch(sql, params);

const firebaseService = require('../services/firebaseService');
const pushHelper = require('../services/pushHelper');
const crowdAlerts = require('../services/crowdAlerts');

const realSendPushToUser = firebaseService.sendPushToUser;
const realIsEnabled = firebaseService.isEnabled;

function on(re, fn) { handlers.push([re, fn]); }

function reset() {
  handlers = [];
  log = [];
  pushHelper._resetDebounce();
  firebaseService.__setSenderForTests(null);
  firebaseService.sendPushToUser = realSendPushToUser;
  firebaseService.isEnabled = realIsEnabled;
}

const offline = { sockets: { adapter: { rooms: new Map() }, sockets: new Map() } };
const flush = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

// The world a delivery needs: the recipient can see it, no device clock is
// known (so nothing is held for the night), and the bookkeeping writes land.
function deliverable() {
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, actor_banned: false, can_see: true }] }));
  on(/SELECT timezone FROM device_tokens/i, () => ({ rows: [] }));
  const ledger = [];
  on(/INSERT INTO push_sends/i, (params) => { ledger.push(params); return { rowCount: 1 }; });
  on(/UPDATE device_tokens SET updated_at/i, () => ({ rowCount: 1 }));
  const queued = [];
  on(/INSERT INTO push_outbox/i, (params) => { queued.push(params); return { rowCount: 1 }; });
  return { ledger, queued };
}

// A provider result whose send was still out at the deadline and later
// answered `final`.
function lateResult(atDeadline, final) {
  let answer;
  const settled = new Promise((resolve) => { answer = () => resolve(final); });
  return { result: { ...atDeadline, inFlight: 1, settled }, answer };
}

// ---------------------------------------------------------------------------
// 1. The deadline ends the wait, not the send
// ---------------------------------------------------------------------------
test('a send still out at the deadline answers late with what it really came to', async () => {
  reset();
  let land;
  firebaseService.__setSenderForTests(() => new Promise((resolve) => { land = resolve; }));
  const { withEventLoopHeldOpen } = require('./helpers/eventLoopAnchor');
  const res = await withEventLoopHeldOpen(
    () => firebaseService.sendPushNotification('tok', 'T', 'B', {}, { timeoutMs: 30 })
  );
  assert.strictEqual(res.success, false, 'the caller is still released at the deadline');
  assert.strictEqual(res.stale, false);
  assert.ok(res.late && typeof res.late.then === 'function', 'nothing says the send is still out');
  land('projects/x/messages/1');
  assert.deepStrictEqual(await res.late, { success: true });
});

test('the per-account answer carries the sends still out, and the tally they settle to', async () => {
  reset();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    on(/SELECT id, token FROM device_tokens/i, () => ({ rows: [{ id: 4, token: 'slow' }, { id: 5, token: 'fast' }] }));
    let land;
    firebaseService.__setSenderForTests((message) => (
      message.token === 'slow' ? new Promise((resolve) => { land = resolve; }) : 'ok'
    ));
    const pending = firebaseService.sendPushToUser(9, 'T', 'B', {});
    await flush();
    mock.timers.tick(8000);
    const res = await pending;
    assert.strictEqual(res.sent, 1);
    assert.strictEqual(res.failed, 1, 'at the deadline the slow one is not yet a delivery');
    assert.strictEqual(res.inFlight, 1);
    assert.strictEqual(res.retryIds, undefined, 'a device still in flight is not owed a retry yet');
    land('ok');
    assert.deepStrictEqual(await res.settled, { sent: 2, failed: 0 });
  } finally {
    mock.timers.reset();
  }
});

test('a late send that lands is not sent a second time', async () => {
  reset();
  const { ledger, queued } = deliverable();
  const late = lateResult({ sent: 0, failed: 1 }, { sent: 1, failed: 0 });
  firebaseService.isEnabled = () => true;
  firebaseService.sendPushToUser = async () => late.result;

  const res = await pushHelper.pushIfOffline(offline, 1, 'Ava', 'running late', { type: 'dm_message', senderId: '2' });
  assert.strictEqual(res.sent, 0, 'the caller still gets the deadline\'s answer, on time');
  assert.deepStrictEqual(queued, [], 'a retry was queued before the send had answered');
  assert.deepStrictEqual(ledger, [], 'the ledger row waits for the real outcome');

  late.answer();
  await flush();
  assert.deepStrictEqual(queued, [], 'the send landed; a retry would be the second copy');
  assert.deepStrictEqual(ledger.map((p) => p[2]), ['delivered']);
});

test('a late send that fails is retried, and only to the device that failed', async () => {
  reset();
  const { ledger, queued } = deliverable();
  const late = lateResult({ sent: 0, failed: 1 }, { sent: 0, failed: 1, retryIds: [5] });
  firebaseService.isEnabled = () => true;
  firebaseService.sendPushToUser = async () => late.result;

  await pushHelper.pushIfOffline(offline, 1, 'Ava', 'running late', { type: 'dm_message', senderId: '2' });
  late.answer();
  await flush();
  assert.strictEqual(queued.length, 1);
  assert.strictEqual(queued[0][1], 'retry');
  assert.deepStrictEqual(queued[0][7], [5], 'the retry row names the device it is owed to');
  assert.deepStrictEqual(ledger.map((p) => p[2]), ['failed']);
});

test('a slow crowd alert keeps its claim until the sends answer, and loses it only if none landed', async () => {
  for (const [final, expectRelease] of [[{ sent: 1, failed: 0 }, 0], [{ sent: 0, failed: 1 }, 1]]) {
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-15T00:00:00Z') }); // Fri 8pm ET
    reset();
    let released = 0;
    on(/DELETE FROM crowd_alert_sends WHERE sent_at/i, () => ({ rowCount: 0 }));
    on(/FROM flocks f\s+WHERE f\.status/i, () => ({
      rows: [{
        id: 7, name: 'Fri', venue_id: 'p1', venue_name: 'The Pearl', venue_latitude: null, venue_longitude: null,
        event_time: new Date(Date.now() + 90 * 60 * 1000),
      }],
    }));
    on(/SELECT 1 FROM crowd_alert_sends/i, () => ({ rows: [], rowCount: 0 }));
    on(/FROM ml_venues/i, () => ({
      rows: [{ google_types: ['bar', 'night_club'], review_count: 4000, rating: 4.5, price_level: 2, timezone: 'America/New_York' }],
    }));
    on(/FROM flock_members/i, () => ({ rows: [{ user_id: 1, user_settings: null }] }));
    on(/INSERT INTO crowd_alert_sends/i, () => ({ rowCount: 1 }));
    on(/DELETE FROM crowd_alert_sends WHERE flock_id/i, () => { released += 1; return { rowCount: 1 }; });
    on(/SELECT settings FROM user_settings/i, () => ({ rows: [] }));
    deliverable();
    const late = lateResult({ sent: 0, failed: 1 }, final);
    firebaseService.isEnabled = () => true;
    firebaseService.sendPushToUser = async () => late.result;
    try {
      await crowdAlerts.checkCrowdAlerts();
      assert.strictEqual(released, 0, 'the claim was released on the deadline\'s "failed"');
      late.answer();
      await flush();
      assert.strictEqual(released, expectRelease, JSON.stringify(final));
    } finally {
      mock.timers.reset();
    }
  }
});

// ---------------------------------------------------------------------------
// 2. A retry goes to the devices that failed
// ---------------------------------------------------------------------------
test('a batch the laptop took and the phone did not is retried to the phone', async () => {
  reset();
  const { queued } = deliverable();
  firebaseService.isEnabled = () => true;
  firebaseService.sendPushToUser = async () => ({ sent: 1, failed: 1, retryIds: [12] });
  await pushHelper.pushIfOffline(offline, 1, 'Ava', 'hi', { type: 'dm_message', senderId: '2' });
  assert.strictEqual(queued.length, 1, 'the phone that got the 5xx never heard');
  assert.strictEqual(queued[0][1], 'retry');
  assert.deepStrictEqual(queued[0][7], [12]);
});

test('a batch whose only failure was a dead token is not retried at all', async () => {
  reset();
  const { queued } = deliverable();
  firebaseService.isEnabled = () => true;
  firebaseService.sendPushToUser = async () => ({ sent: 1, failed: 1 }); // the dead one was pruned
  await pushHelper.pushIfOffline(offline, 1, 'Ava', 'hi', { type: 'dm_message', senderId: '2' });
  assert.deepStrictEqual(queued, []);
});

test('a queued row is sent to the devices it names and no others', async () => {
  reset();
  deliverable();
  const calls = [];
  firebaseService.isEnabled = () => true;
  firebaseService.sendPushToUser = async (userId, title, body, data, opts) => { calls.push(opts); return { sent: 1, failed: 0 }; };
  on(/UPDATE push_outbox o/i, () => ({
    rows: [{
      id: 30, user_id: 1, reason: 'retry', title: 'Ava', body: 'hi',
      data: { type: 'dm_message', senderId: '2' }, attempts: 1,
      expires_at: new Date(Date.now() + 60000), token_ids: [12],
    }],
  }));
  let deleted = null;
  on(/DELETE FROM push_outbox WHERE id = ANY/i, (params) => { deleted = params[0]; return { rowCount: 1 }; });
  await pushHelper.sweepPushOutbox();
  assert.deepStrictEqual(calls.map((o) => o.onlyIds), [[12]]);
  assert.deepStrictEqual(deleted, [30]);
});

test('a row whose send is still out at the deadline is parked, and forgotten once it lands', async () => {
  reset();
  deliverable();
  const late = lateResult({ sent: 0, failed: 1 }, { sent: 1, failed: 0 });
  firebaseService.isEnabled = () => true;
  firebaseService.sendPushToUser = async () => late.result;
  on(/UPDATE push_outbox o/i, () => ({
    rows: [{
      id: 31, user_id: 1, reason: 'retry', title: 'Ava', body: 'hi',
      data: { type: 'dm_message', senderId: '2' }, attempts: 1,
      expires_at: new Date(Date.now() + 60000), token_ids: null,
    }],
  }));
  const parked = [];
  on(/UPDATE push_outbox SET next_attempt_at = GREATEST/i, (params) => { parked.push(params[0]); return { rowCount: 1 }; });
  const forgotten = [];
  on(/DELETE FROM push_outbox WHERE id = \$1/i, (params) => { forgotten.push(params[0]); return { rowCount: 1 }; });
  on(/DELETE FROM push_outbox WHERE id = ANY/i, () => { throw new Error('a row still in flight must not be decided by the sweep'); });

  await pushHelper.sweepPushOutbox();
  assert.deepStrictEqual(parked, [31], 'the row must be moved past the provider\'s own retries');
  assert.deepStrictEqual(forgotten, []);
  late.answer();
  await flush();
  assert.deepStrictEqual(forgotten, [31]);
});

// ---------------------------------------------------------------------------
// 3 and 4. One slot per conversation, and per person where a person is it
// ---------------------------------------------------------------------------
test('every person\'s request, acceptance and free-tonight pulse keeps its own slot', () => {
  const { collapseId } = firebaseService;
  for (const type of ['friend_request', 'friend_accepted', 'availability_pulse']) {
    const ava = collapseId({ type, fromUserId: '4' });
    const ben = collapseId({ type, fromUserId: '5' });
    assert.notStrictEqual(ava, ben, `${type}: the second person replaced the first on the lock screen`);
    assert.strictEqual(ava, `${type}-u4`);
  }
  // The conversations that were already right stay exactly as they were.
  assert.strictEqual(collapseId({ type: 'flock_message', flockId: 3, senderId: 4 }), 'flock_message-f3');
  assert.strictEqual(collapseId({ type: 'dm_message', senderId: 4 }), 'dm_message-u4');
  assert.strictEqual(collapseId({ type: 'flock_rsvp', flockId: 3, fromUserId: 4 }), 'flock_rsvp-f3');
  assert.strictEqual(collapseId({ type: 'bill_created', flockId: 3, fromUserId: 4 }), 'bill_created-f3');
});

test('two people saying they paid on one bill are two notifications', () => {
  const { collapseId } = firebaseService;
  const ava = collapseId({ type: 'bill_settled', flockId: '7', fromUserId: '4' });
  const ben = collapseId({ type: 'bill_settled', flockId: '7', fromUserId: '5' });
  assert.notStrictEqual(ava, ben, '"Ava says they paid you $12" was replaced by Ben\'s');
  assert.strictEqual(ava, 'bill_settled-f7-u4');
});

test('an SOS and its all-clear are one slot per sender, on every platform', () => {
  const { buildFcmMessage } = firebaseService;
  const alarm = buildFcmMessage('tok', 'Ava needs help', 'b', { type: 'safety_alert', fromUserId: '4', toUserId: '9' });
  const clear = buildFcmMessage('tok', 'Ava says they are OK', 'b', { type: 'safety_alert_cancelled', fromUserId: '4', toUserId: '9' });
  for (const [label, get] of [
    ['apns-collapse-id', (m) => m.apns.headers['apns-collapse-id']],
    ['android collapseKey', (m) => m.android.collapseKey],
    ['android tag', (m) => m.android.notification.tag],
    ['webpush tag', (m) => m.webpush.notification.tag],
  ]) {
    assert.strictEqual(get(clear), get(alarm), `${label}: the all-clear lands beside the alarm instead of replacing it`);
  }
  assert.strictEqual(alarm.apns.headers['apns-collapse-id'], 'safety-u4');
  const other = buildFcmMessage('tok', 'Ben needs help', 'b', { type: 'safety_alert', fromUserId: '5', toUserId: '9' });
  assert.notStrictEqual(other.apns.headers['apns-collapse-id'], alarm.apns.headers['apns-collapse-id'],
    'a second person\'s alarm must not replace the first');
});

test('an overnight hold merges on the same conversation the lock screen collapses on', async () => {
  const cases = [
    [{ type: 'friend_request', fromUserId: '4' }, ['fromUserId', '4', null, null]],
    [{ type: 'bill_settled', flockId: '7', fromUserId: '4' }, ['flockId', '7', 'fromUserId', '4']],
    [{ type: 'flock_message', flockId: '7', senderId: '4', messageId: '90' }, ['flockId', '7', null, null]],
    [{ type: 'dm_message', senderId: '4', dmId: '91' }, ['senderId', '4', null, null]],
  ];
  const { localHourIn } = pushHelper;
  const utcHour = new Date().getUTCHours();
  let offset = (((3 - utcHour) % 24) + 24) % 24;
  if (offset > 12) offset -= 24;
  const zone = offset === 0 ? 'Etc/GMT' : (offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`);
  if (localHourIn(zone) === null) return;
  for (const [data, scope] of cases) {
    reset();
    deliverable();
    handlers = handlers.filter(([re]) => !/SELECT timezone/.test(re.source));
    on(/SELECT timezone FROM device_tokens/i, () => ({ rows: [{ timezone: zone }] }));
    on(/AS gone FROM/i, () => ({ rows: [{ gone: false }] }));
    let merge = null;
    on(/^UPDATE push_outbox SET title/i, (params, sql) => { merge = { params, sql }; return { rows: [{ id: 1 }], rowCount: 1 }; });
    firebaseService.isEnabled = () => true;
    firebaseService.sendPushToUser = async () => { throw new Error('nothing may be sent at 3am'); };
    const res = await pushHelper.pushIfOffline(offline, 1, 'T', 'B', data);
    assert.strictEqual(res.reason, 'quiet-held', JSON.stringify(data));
    assert.ok(merge, `${data.type}: the hold never looked for its conversation's row`);
    assert.deepStrictEqual(merge.params.slice(6, 10), scope, data.type);
    assert.match(merge.sql, /token_ids = NULL/, 'a hold is for every device');
  }
});

// ---------------------------------------------------------------------------
// 5. An alarm is not lost to a database blip
// ---------------------------------------------------------------------------
test('an SOS whose visibility check cannot be answered is queued for retry, not dropped', async () => {
  for (const type of ['safety_alert', 'safety_alert_cancelled']) {
    reset();
    const { queued } = deliverable();
    handlers = handlers.filter(([re]) => !/FROM users u/.test(re.source));
    on(/FROM users u/i, () => Promise.reject(new Error('connection terminated')));
    firebaseService.isEnabled = () => true;
    firebaseService.sendPushToUser = async () => { throw new Error('an unanswerable check still sends nothing'); };
    const res = await pushHelper.pushAlways(9, 'Ava needs help', 'Open the app', {
      type, fromUserId: '4', toUserId: '9',
    });
    assert.strictEqual(res.reason, 'visibility-uncheckable', 'it still fails closed');
    assert.strictEqual(res.queued, true);
    assert.strictEqual(queued.length, 1, `${type}: an offline flockmate was simply never told`);
    assert.strictEqual(queued[0][1], 'retry');
    assert.strictEqual(JSON.parse(queued[0][4]).type, type);
  }
});

test('a message whose visibility check cannot be answered is still not queued', async () => {
  reset();
  const { queued } = deliverable();
  handlers = handlers.filter(([re]) => !/FROM users u/.test(re.source));
  on(/FROM users u/i, () => Promise.reject(new Error('connection terminated')));
  firebaseService.isEnabled = () => true;
  const res = await pushHelper.pushIfOffline(offline, 1, 'Ava', 'hi', { type: 'dm_message', senderId: '2' });
  assert.strictEqual(res.reason, 'visibility-uncheckable');
  assert.strictEqual(res.queued, undefined);
  assert.deepStrictEqual(queued, [], 'a DM waits in the app; this rule is for what does not');
});

test('the released SOS asks again and is kept while the answer is still unavailable', async () => {
  reset();
  deliverable();
  handlers = handlers.filter(([re]) => !/FROM users u/.test(re.source));
  on(/FROM users u/i, () => Promise.reject(new Error('connection terminated')));
  firebaseService.isEnabled = () => true;
  on(/UPDATE push_outbox o/i, () => ({
    rows: [{
      id: 40, user_id: 9, reason: 'retry', title: 'Ava needs help', body: 'Open the app',
      data: { type: 'safety_alert', fromUserId: '4', toUserId: '9' }, attempts: 1,
      expires_at: new Date(Date.now() + 60000), token_ids: null,
    }],
  }));
  let dropped = 0;
  on(/DELETE FROM push_outbox/i, () => { dropped += 1; return { rowCount: 1 }; });
  handlers = handlers.filter(([re]) => !/INSERT INTO push_outbox/.test(re.source));
  let requeued = 0;
  on(/INSERT INTO push_outbox/i, () => { requeued += 1; return { rowCount: 1 }; });
  await pushHelper.sweepPushOutbox();
  assert.strictEqual(dropped, 0, 'an alarm we could not check was dropped');
  assert.strictEqual(requeued, 0, 'a released row queued a second copy of itself');
});

// ---------------------------------------------------------------------------
// The badge, pinned against the SQL (deviceTokenClaims.test.js runs it)
// ---------------------------------------------------------------------------
test('the icon badge leaves out a banned sender in both halves of the count', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'pushHelper.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function unreadBadge('), src.indexOf('async function deliver('));
  assert.match(fn, /su\.id = dm\.sender_id AND su\.is_banned IS TRUE/);
  assert.match(fn, /su\.id = m\.sender_id AND su\.is_banned IS TRUE/);
});
