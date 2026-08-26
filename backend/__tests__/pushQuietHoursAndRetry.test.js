// Run: node --test  (from backend/)
//
// The four delivery defects fixed on 2026-08-25, pinned.
//
//   1. PRESENCE IS NOT ATTENTION. A socket in `user:{id}` used to suppress a
//      push for the whole ACCOUNT, so a laptop tab left open on flockcorp.com
//      silenced the owner's phone indefinitely. Covered in
//      __tests__/pushDelivery.test.js, next to the rest of the visibility gate.
//
//   2. QUIET HOURS, which did not exist. A 3am DM rang a phone at 3am, and for
//      an audience of 15 to 22 year olds that is the single most likely reason
//      somebody turns notifications off in iOS Settings, which iOS never asks
//      about again. This file pins the window, what breaks through it, and that
//      a held notification is HELD rather than dropped.
//
//   3. OBSERVABILITY. Every outcome writes one row to push_sends, and the row
//      carries the type and the counts and no message text.
//
//   4. RETRY, without touching the deadline. services/firebaseService.js races
//      firebase-admin's own four attempts with an 8 second timeout on purpose;
//      the retry therefore lives OUTSIDE the send, in push_outbox, released by
//      a later sweep. This file pins both halves: the retry happens, and the
//      deadline is still 8 seconds.
//
//   5. THE DURABLE DEBOUNCE. Two of the three debounces in the push path were
//      in-heap Maps, which do not exist across two Railway instances. The chat
//      one now claims a row in push_debounce as well.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = 'push-quiet-hours-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.PUSH_QUIET_DEFAULT_TZ;

const pool = require('../config/database');

let handlers = [];
let log = [];

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
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

let sends = [];
let sendResult = { sent: 1, failed: 0 };
firebaseService.isEnabled = () => true;
firebaseService.sendPushToUser = async (userId, title, body, data) => {
  sends.push({ userId, title, body, data });
  return typeof sendResult === 'function' ? sendResult() : sendResult;
};

function on(re, fn) { handlers.push([re, fn]); }

function reset() {
  handlers = [];
  log = [];
  sends = [];
  sendResult = { sent: 1, failed: 0 };
  pushHelper._resetDebounce();
}

const offline = { sockets: { adapter: { rooms: new Map() }, sockets: new Map() } };

// A fixed-offset IANA zone in which the wall clock is currently `target` hours.
// Etc/GMT+N is UTC minus N and Etc/GMT-N is UTC plus N, which is the sign
// convention everybody gets wrong once. Using a real zone rather than faking
// the clock keeps the Intl path under test instead of stubbed out.
function zoneWhereLocalHourIs(target) {
  const utcHour = new Date().getUTCHours();
  let offset = (((target - utcHour) % 24) + 24) % 24; // 0..23
  if (offset > 12) offset -= 24;                      // -11..12, inside Etc's range
  if (offset === 0) return 'Etc/GMT';
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

// The stored device zone every quiet-hours case below reads.
function zoneIs(zone) {
  on(/SELECT timezone FROM device_tokens/i, () => ({ rows: zone ? [{ timezone: zone }] : [] }));
}

// The two writes that follow every real delivery.
function ledgerAndLiveness() {
  const rows = [];
  on(/INSERT INTO push_sends/i, (params) => { rows.push(params); return { rows: [], rowCount: 1 }; });
  on(/UPDATE device_tokens SET updated_at/i, () => ({ rows: [], rowCount: 1 }));
  return rows;
}

function visible() {
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, actor_banned: false, can_see: true }] }));
}

// ---------------------------------------------------------------------------
// 1. THE WINDOW ITSELF
//
// The single most important assertion in this file is the second test. Flock
// exists so that people go OUT, between roughly 8pm and 1am. A quiet window
// copied from a productivity app (21:00 to 08:00) would mute every hour the
// product is for, and it would look completely reasonable in a code review.
// ---------------------------------------------------------------------------
test('quiet hours are 02:00 to 08:00 and nothing else', () => {
  const { isQuietHour, QUIET_START_HOUR, QUIET_END_HOUR } = pushHelper;
  assert.strictEqual(QUIET_START_HOUR, 2);
  assert.strictEqual(QUIET_END_HOUR, 8);
  for (const h of [2, 3, 4, 5, 6, 7]) assert.strictEqual(isQuietHour(h), true, `${h} must be quiet`);
  assert.strictEqual(isQuietHour(1), false);
  assert.strictEqual(isQuietHour(8), false);
});

test('the hours this app exists for are never quiet', () => {
  const { isQuietHour } = pushHelper;
  // Going out, arriving, the whole evening, and getting home. If any of these
  // is ever true, the app has muted its own core hours.
  for (const h of [18, 19, 20, 21, 22, 23, 0, 1]) {
    assert.strictEqual(isQuietHour(h), false, `${h}:00 is a going-out hour and must ring`);
  }
  // And the morning, which is when a held notification is released.
  for (const h of [8, 9, 12, 15]) assert.strictEqual(isQuietHour(h), false);
});

test('an unreadable hour is never quiet', () => {
  const { isQuietHour, localHourIn } = pushHelper;
  assert.strictEqual(isQuietHour(null), false);
  assert.strictEqual(isQuietHour(undefined), false);
  assert.strictEqual(isQuietHour(NaN), false);
  assert.strictEqual(localHourIn('Mars/Olympus_Mons'), null);
  assert.strictEqual(localHourIn(''), null);
  assert.strictEqual(localHourIn(null), null);
});

test('the release lands after the window closes, not on its edge', () => {
  const { quietWindowEnd, localHourIn, isQuietHour } = pushHelper;
  const zone = zoneWhereLocalHourIs(3);
  if (localHourIn(zone) === null) return; // runtime without the zone database
  const end = quietWindowEnd(zone);
  assert.ok(end instanceof Date, 'a quiet hour must produce a release time');
  assert.strictEqual(isQuietHour(localHourIn(zone, end)), false,
    'a release scheduled back inside the window would bounce the row forever');
  // Daytime is not a window at all.
  assert.strictEqual(quietWindowEnd(zoneWhereLocalHourIs(20)), null);
});

// ---------------------------------------------------------------------------
// 2. HELD, NOT DROPPED
// ---------------------------------------------------------------------------
test('a 3am group chat message is held until morning rather than ringing', async () => {
  reset();
  const zone = zoneWhereLocalHourIs(3);
  if (pushHelper.localHourIn(zone) === null) return;
  visible();
  zoneIs(zone);
  const ledger = ledgerAndLiveness();
  let queued = null;
  on(/INSERT INTO push_outbox/i, (params) => { queued = params; return { rows: [], rowCount: 1 }; });

  const res = await pushHelper.pushIfOffline(offline, 1, 'Ava', 'you up', {
    type: 'flock_message', flockId: 7,
  });

  assert.strictEqual(res.reason, 'quiet-held');
  assert.strictEqual(sends.length, 0, 'nothing may reach the provider at 3am');
  assert.ok(queued, 'the notification must be queued, never discarded');
  assert.strictEqual(queued[1], 'quiet');
  assert.strictEqual(queued[2], 'Ava');
  assert.strictEqual(queued[3], 'you up');
  // And it is recorded as held rather than as delivered.
  const row = ledger.find((p) => p[2] === 'quiet-held');
  assert.ok(row, 'a held push must still be countable');
  assert.strictEqual(row[5], true, 'the quiet_hours flag is what separates a hold from a suppression');
});

test('an SOS rings at 3am, because that is the whole point of an SOS', async () => {
  reset();
  const zone = zoneWhereLocalHourIs(3);
  if (pushHelper.localHourIn(zone) === null) return;
  visible();
  zoneIs(zone);
  ledgerAndLiveness();
  on(/INSERT INTO push_outbox/i, () => { throw new Error('an SOS must never be queued'); });

  const res = await pushHelper.pushAlways(1, 'Ava needs help', 'Shared her location', { type: 'sos' });
  assert.strictEqual(res.sent, 1);
  assert.strictEqual(sends.length, 1);
  // The zone is not even looked up: a type that always rings never asks what
  // time it is.
  assert.ok(!log.some((l) => /SELECT timezone/i.test(l.sql)));
});

test('a child safety report reaches the one admin at 3am', async () => {
  reset();
  const zone = zoneWhereLocalHourIs(4);
  if (pushHelper.localHourIn(zone) === null) return;
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, actor_banned: false, can_see: true }] }));
  zoneIs(zone);
  ledgerAndLiveness();
  const res = await pushHelper.pushIfOffline(offline, 1, 'Child safety report', 'Needs review', {
    type: 'moderation_report', reportId: '5',
  });
  assert.strictEqual(res.sent, 1);
});

test('a crowd alert is dropped in the small hours rather than held', async () => {
  reset();
  const zone = zoneWhereLocalHourIs(3);
  if (pushHelper.localHourIn(zone) === null) return;
  visible();
  zoneIs(zone);
  on(/FROM user_settings/i, () => ({ rows: [] }));
  const ledger = ledgerAndLiveness();
  on(/INSERT INTO push_outbox/i, () => { throw new Error('a forecast held until 8am is a sentence about last night'); });

  const res = await pushHelper.pushAlways(1, 'The Pearl is filling up', 'Head out early', {
    type: 'crowd_alert', flockId: 7,
  });
  assert.strictEqual(res.reason, 'quiet-dropped');
  assert.strictEqual(sends.length, 0);
  assert.ok(ledger.some((p) => p[2] === 'quiet-dropped'));
});

test('an unknown device clock delivers now rather than guessing a continent', async () => {
  reset();
  visible();
  zoneIs(null); // no device has ever reported one
  ledgerAndLiveness();
  on(/INSERT INTO push_outbox/i, () => { throw new Error('a guess must never hold somebody\'s messages'); });
  const res = await pushHelper.pushIfOffline(offline, 1, 'Ava', 'see you at 9', {
    type: 'dm_message', senderId: 2,
  });
  assert.strictEqual(res.sent, 1);
});

test('a message at 9pm is delivered at 9pm', async () => {
  reset();
  const zone = zoneWhereLocalHourIs(21);
  if (pushHelper.localHourIn(zone) === null) return;
  visible();
  zoneIs(zone);
  ledgerAndLiveness();
  on(/INSERT INTO push_outbox/i, () => { throw new Error('21:00 is the busiest hour this app has'); });
  const res = await pushHelper.pushIfOffline(offline, 1, 'Ava', 'we moved to The Pearl', {
    type: 'flock_message', flockId: 7,
  });
  assert.strictEqual(res.sent, 1);
});

// ---------------------------------------------------------------------------
// 3. THE LEDGER
// ---------------------------------------------------------------------------
test('every outcome writes exactly one ledger row, and it carries no message text', async () => {
  reset();
  visible();
  zoneIs(null);
  const ledger = ledgerAndLiveness();
  await pushHelper.pushIfOffline(offline, 1, 'Ava', 'a private message body', {
    type: 'dm_message', senderId: 2,
  });
  assert.strictEqual(ledger.length, 1);
  const [userId, type, outcome, sent, failed, quiet] = ledger[0];
  assert.strictEqual(userId, 1);
  assert.strictEqual(type, 'dm_message');
  assert.strictEqual(outcome, 'delivered');
  assert.strictEqual(sent, 1);
  assert.strictEqual(failed, 0);
  assert.strictEqual(quiet, false);
  const insert = log.find((l) => /INSERT INTO push_sends/i.test(l.sql));
  assert.ok(!insert.sql.includes('title') && !insert.sql.includes('body'),
    'a counts table must not outlive the notification it counts by storing its text');
  for (const p of ledger[0]) {
    assert.notStrictEqual(p, 'a private message body');
  }
});

test('a suppressed push is counted too, which is how the laptop bug would have shown', async () => {
  reset();
  const ledger = ledgerAndLiveness();
  const connected = {
    sockets: {
      adapter: { rooms: new Map([['user:1', new Set(['s1'])]]) },
      sockets: new Map([['s1', { handshake: { auth: { pushToken: 'device-token-1' } } }]]),
    },
  };
  on(/SELECT token FROM device_tokens/i, () => ({ rows: [{ token: 'device-token-1' }] }));
  const res = await pushHelper.pushIfOffline(connected, 1, 'T', 'B', { type: 'flock_message', flockId: 7 });
  assert.strictEqual(res.reason, 'online');
  assert.deepStrictEqual(ledger.map((p) => p[2]), ['online']);
});

test('a ledger write that fails never changes the verdict', async () => {
  reset();
  visible();
  zoneIs(null);
  on(/UPDATE device_tokens SET updated_at/i, () => ({ rows: [], rowCount: 1 }));
  on(/INSERT INTO push_sends/i, () => { throw new Error('ledger table is gone'); });
  const res = await pushHelper.pushIfOffline(offline, 1, 'Ava', 'hi', { type: 'dm_message', senderId: 2 });
  assert.strictEqual(res.sent, 1, 'a metrics table must never be able to break the thing it measures');
});

test('the rollup answers did pushes go out this week and did they land', async () => {
  reset();
  on(/FROM push_sends/i, () => ({
    rows: [
      { push_type: 'dm_message', outcome: 'delivered', pushes: 12, devices_sent: 14, devices_failed: 0 },
      { push_type: 'dm_message', outcome: 'failed', pushes: 2, devices_sent: 0, devices_failed: 3 },
      { push_type: 'flock_message', outcome: 'quiet-held', pushes: 4, devices_sent: 0, devices_failed: 0 },
      { push_type: 'flock_message', outcome: 'online', pushes: 9, devices_sent: 0, devices_failed: 0 },
    ],
  }));
  const stats = await pushHelper.pushDeliveryStats(7);
  assert.strictEqual(stats.days, 7);
  assert.strictEqual(stats.totals.attempts, 27);
  assert.strictEqual(stats.totals.delivered, 12);
  assert.strictEqual(stats.totals.devicesReached, 14);
  assert.strictEqual(stats.totals.failed, 2);
  assert.strictEqual(stats.totals.held, 4);
  assert.strictEqual(stats.totals.suppressed, 9);
});

// ---------------------------------------------------------------------------
// 4. RETRY, OUTSIDE THE DEADLINE
// ---------------------------------------------------------------------------
test('the send deadline is untouched, and the retry is not inside it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'firebaseService.js'), 'utf8');
  assert.match(src, /const SEND_TIMEOUT_MS = 8000;/,
    'the deadline is what makes a failing notification never feel like the app hanging');
  const helper = fs.readFileSync(path.join(__dirname, '..', 'services', 'pushHelper.js'), 'utf8');
  assert.ok(!/timeoutMs/.test(helper),
    'pushHelper must not reach past the deadline; the retry belongs in push_outbox');
  assert.match(helper, /INSERT INTO push_outbox/,
    'a transient provider failure has to leave something behind or the notification is simply lost');
});

test('a transient failure queues a retry instead of losing the notification', async () => {
  reset();
  visible();
  zoneIs(null);
  ledgerAndLiveness();
  let queued = null;
  on(/INSERT INTO push_outbox/i, (params) => { queued = params; return { rows: [], rowCount: 1 }; });
  sendResult = { sent: 0, failed: 1 };

  const res = await pushHelper.pushIfOffline(offline, 1, 'Ava', 'you left your jacket', {
    type: 'dm_message', senderId: 2,
  });
  assert.strictEqual(res.sent, 0);
  assert.ok(queued, 'an FCM 5xx used to end here with the notification gone forever');
  assert.strictEqual(queued[1], 'retry');
  assert.strictEqual(JSON.parse(queued[4]).type, 'dm_message');
});

test('a crowd alert is never queued for retry, because its producer already retries', async () => {
  reset();
  visible();
  zoneIs(null);
  ledgerAndLiveness();
  on(/FROM user_settings/i, () => ({ rows: [] }));
  on(/INSERT INTO push_outbox/i, () => {
    throw new Error('crowdAlerts releases its claim and rebuilds the alert; a second copy would race it');
  });
  sendResult = { sent: 0, failed: 1 };
  const res = await pushHelper.pushAlways(1, 'The Pearl is filling up', 'Head out early', {
    type: 'crowd_alert', flockId: 7,
  });
  assert.strictEqual(res.sent, 0);
});

test('a batch with a dead token and a live one is not retried', async () => {
  reset();
  visible();
  zoneIs(null);
  ledgerAndLiveness();
  on(/INSERT INTO push_outbox/i, () => { throw new Error('a delivered notification must not be sent twice'); });
  sendResult = { sent: 1, failed: 1 };
  const res = await pushHelper.pushIfOffline(offline, 1, 'Ava', 'hi', { type: 'dm_message', senderId: 2 });
  assert.strictEqual(res.sent, 1);
});

test('the sweep releases a queued notification and then forgets it', async () => {
  reset();
  visible();
  zoneIs(null);
  ledgerAndLiveness();
  let deleted = null;
  on(/UPDATE push_outbox o/i, () => ({
    rows: [{
      id: 11,
      user_id: 1,
      reason: 'retry',
      title: 'Ava',
      body: 'you left your jacket',
      data: { type: 'dm_message', senderId: 2 },
      attempts: 1,
      expires_at: new Date(Date.now() + 60000),
    }],
  }));
  on(/DELETE FROM push_outbox WHERE id = ANY/i, (params) => { deleted = params[0]; return { rowCount: 1 }; });

  const n = await pushHelper.sweepPushOutbox();
  assert.strictEqual(n, 1);
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].body, 'you left your jacket');
  assert.deepStrictEqual(deleted, [11], 'a released notification must not be released twice');
});

test('the sweep claims with SKIP LOCKED so two instances take different rows', async () => {
  reset();
  let claim = null;
  on(/UPDATE push_outbox o/i, (params, sql) => { claim = sql; return { rows: [] }; });
  await pushHelper.sweepPushOutbox();
  assert.match(claim, /FOR UPDATE SKIP LOCKED/,
    'this is the crowd_alert_sends lesson: a per-process queue is not a queue on two instances');
  assert.match(claim, /attempts = o\.attempts \+ 1/,
    'the attempt is counted inside the claim, so a crash costs a delay and never a duplicate');
});

test('an expired notification is dropped and counted, not delivered late forever', async () => {
  reset();
  const ledger = ledgerAndLiveness();
  let deleted = null;
  on(/UPDATE push_outbox o/i, () => ({
    rows: [{
      id: 12, user_id: 1, reason: 'retry', title: 'T', body: 'B',
      data: { type: 'dm_message', senderId: 2 }, attempts: 3,
      expires_at: new Date(Date.now() - 1000),
    }],
  }));
  on(/DELETE FROM push_outbox WHERE id = ANY/i, (params) => { deleted = params[0]; return { rowCount: 1 }; });
  await pushHelper.sweepPushOutbox();
  assert.strictEqual(sends.length, 0);
  assert.deepStrictEqual(deleted, [12]);
  assert.ok(ledger.some((p) => p[2] === 'expired'), 'how often we give up is one of the two numbers worth having');
});

test('a released notification re-checks visibility, so a blocked one still goes nowhere', async () => {
  reset();
  ledgerAndLiveness();
  on(/FROM user_blocks/i, () => ({ rows: [{ ok: 1 }] })); // blocked while it waited
  on(/DELETE FROM push_outbox WHERE id = ANY/i, () => ({ rowCount: 1 }));
  on(/UPDATE push_outbox o/i, () => ({
    rows: [{
      id: 13, user_id: 1, reason: 'quiet', title: 'Sam', body: 'hey',
      data: { type: 'dm_message', senderId: 2 }, attempts: 1,
      expires_at: new Date(Date.now() + 60000),
    }],
  }));
  await pushHelper.sweepPushOutbox();
  assert.strictEqual(sends.length, 0, 'the gate that runs at send time has to run at RELEASE time too');
});

// ---------------------------------------------------------------------------
// 5. THE DEBOUNCE, ACROSS INSTANCES
// ---------------------------------------------------------------------------
test('the chat debounce claims a durable row, not just a heap entry', async () => {
  reset();
  visible();
  zoneIs(null);
  ledgerAndLiveness();
  let claim = null;
  on(/INSERT INTO push_debounce/i, (params, sql) => { claim = { params, sql }; return { rows: [{}], rowCount: 1 }; });
  await pushHelper.pushIfOfflineDebounced(offline, 1, 'Ava', 'hi', { type: 'dm_message', senderId: 2 });
  assert.ok(claim, 'an in-heap Map is not a window when Railway runs two instances');
  assert.strictEqual(claim.params[0], '1|dm_message|u2');
  assert.match(claim.sql, /ON CONFLICT \(debounce_key\) DO UPDATE/i);
  assert.match(claim.sql, /WHERE push_debounce\.sent_at </i,
    'the claim only wins when the stored window has already expired');
});

test('losing the claim to another instance suppresses the duplicate', async () => {
  reset();
  visible();
  zoneIs(null);
  ledgerAndLiveness();
  on(/INSERT INTO push_debounce/i, () => ({ rows: [], rowCount: 0 })); // the other instance won
  const res = await pushHelper.pushIfOfflineDebounced(offline, 1, 'Ava', 'hi', {
    type: 'dm_message', senderId: 2,
  });
  assert.strictEqual(res.reason, 'debounced');
  assert.strictEqual(sends.length, 0);
});

test('a debounce claim the database cannot answer sends rather than swallows', async () => {
  reset();
  visible();
  zoneIs(null);
  ledgerAndLiveness();
  on(/INSERT INTO push_debounce/i, () => { throw new Error('database blip'); });
  const res = await pushHelper.pushIfOfflineDebounced(offline, 1, 'Ava', 'hi', {
    type: 'dm_message', senderId: 2,
  });
  assert.strictEqual(res.sent, 1,
    'a duplicate notification is a small cost; a lost one is the defect this whole change removes');
});

// ---------------------------------------------------------------------------
// 6. TOKENS THAT ROT
// ---------------------------------------------------------------------------
test('a clean batch marks its tokens alive, a mixed one does not', async () => {
  reset();
  visible();
  zoneIs(null);
  let touched = 0;
  on(/INSERT INTO push_sends/i, () => ({ rowCount: 1 }));
  on(/UPDATE device_tokens SET updated_at/i, () => { touched += 1; return { rowCount: 1 }; });

  await pushHelper.pushIfOffline(offline, 1, 'T', 'B', { type: 'dm_message', senderId: 2 });
  assert.strictEqual(touched, 1, 'updated_at has to mean liveness, or newest-first orders by signup date');

  sendResult = { sent: 1, failed: 1 };
  await pushHelper.pushIfOffline(offline, 3, 'T', 'B', { type: 'dm_message', senderId: 2 });
  assert.strictEqual(touched, 1,
    'on a mixed batch we do not know which row failed, and re-dating a corpse is how it survives the prune forever');
});

test('maintenance ages out tokens FCM has already expired and trims the ledger', async () => {
  reset();
  const ran = [];
  on(/DELETE FROM push_sends/i, (params, sql) => { ran.push(sql); return { rowCount: 0 }; });
  on(/DELETE FROM push_outbox WHERE expires_at/i, (params, sql) => { ran.push(sql); return { rowCount: 0 }; });
  on(/DELETE FROM push_debounce WHERE sent_at/i, (params, sql) => { ran.push(sql); return { rowCount: 0 }; });
  on(/DELETE FROM device_tokens/i, (params, sql) => { ran.push({ sql, params }); return { rowCount: 0 }; });

  assert.strictEqual(await pushHelper.sweepPushMaintenance(true), true);
  const prune = ran.find((r) => r && r.sql && /device_tokens/.test(r.sql));
  assert.ok(prune, 'a token nobody has used in a year is a guaranteed failed send, forever');
  assert.strictEqual(prune.params[0], 270, 'FCM expires a registration token after roughly 270 days');
  assert.match(prune.sql, /COALESCE\(updated_at, created_at\)/);

  // Rate limited, so two instances do not both run it every quarter hour.
  assert.strictEqual(await pushHelper.sweepPushMaintenance(), false);
});

// ---------------------------------------------------------------------------
// 7. THE APP ICON BADGE
// ---------------------------------------------------------------------------
test('the badge is the unread DM count, and it reaches the aps payload', async () => {
  reset();
  // Registered first: canNotify's own block lookup and the badge count both
  // name user_blocks, and this fake matches in registration order.
  on(/FROM direct_messages dm/i, (params, sql) => {
    assert.strictEqual(params[0], 1);
    assert.match(sql, /read_status = FALSE/, 'read_status is the only read state this database holds');
    assert.match(sql, /user_blocks/, 'a message that will never be shown must not sit in the count forever');
    return { rows: [{ n: 4 }] };
  });
  visible();
  zoneIs(null);
  ledgerAndLiveness();
  await pushHelper.pushIfOffline(offline, 1, 'Ava', 'hi', { type: 'dm_message', senderId: 2 });
  assert.strictEqual(sends[0].data.badge, 4);

  const msg = firebaseService.buildFcmMessage('tok', 'Ava', 'hi', sends[0].data);
  assert.strictEqual(msg.apns.payload.aps.badge, 4);
  assert.strictEqual(msg.android.notification.notificationCount, 4);
  // The count is routing for the icon, not for the app, so it does not eat into
  // the 512 byte data budget the deep link shares.
  assert.strictEqual(msg.data.badge, undefined);
});

test('a badge we could not count is absent, never zero', async () => {
  reset();
  on(/FROM direct_messages dm/i, () => { throw new Error('database blip'); });
  visible();
  zoneIs(null);
  ledgerAndLiveness();
  await pushHelper.pushIfOffline(offline, 1, 'Ava', 'hi', { type: 'dm_message', senderId: 2 });
  assert.strictEqual(sends[0].data.badge, undefined);
  const msg = firebaseService.buildFcmMessage('tok', 'Ava', 'hi', sends[0].data);
  assert.strictEqual('badge' in msg.apns.payload.aps, false,
    'aps.badge of 0 clears the icon, so a failed count must not read as "nothing is waiting"');
});

test('the badge does not mutate the object the caller handed over', async () => {
  reset();
  on(/FROM direct_messages dm/i, () => ({ rows: [{ n: 2 }] }));
  visible();
  zoneIs(null);
  ledgerAndLiveness();
  // routes/flocks.js hands the SAME data object to every member of a flock.
  const shared = { type: 'flock_message', flockId: 7 };
  await pushHelper.pushIfOffline(offline, 1, 'T', 'B', shared);
  assert.deepStrictEqual(shared, { type: 'flock_message', flockId: 7 });
});

test('a cleared inbox clears the icon on the next notification of any kind', async () => {
  reset();
  on(/FROM direct_messages dm/i, () => ({ rows: [{ n: 0 }] }));
  visible();
  zoneIs(null);
  ledgerAndLiveness();
  await pushHelper.pushIfOffline(offline, 1, 'Ava invited you', 'Friday', {
    type: 'flock_invite', flockId: 7,
  });
  const msg = firebaseService.buildFcmMessage('tok', 'T', 'B', sends[0].data);
  assert.strictEqual(msg.apns.payload.aps.badge, 0,
    'aps.badge is absolute, which is the whole reason it can be sent on every type');
});

// ---------------------------------------------------------------------------
// 8. NOTHING NEW RUNS WHEN PUSH IS NOT CONFIGURED
// ---------------------------------------------------------------------------
test('a deployment with no Firebase still touches no database', async () => {
  reset();
  const wasEnabled = firebaseService.isEnabled;
  firebaseService.isEnabled = () => false;
  try {
    const a = await pushHelper.pushIfOffline(offline, 1, 'T', 'B', { type: 'dm_message', senderId: 2 });
    const b = await pushHelper.pushIfOfflineDebounced(offline, 1, 'T', 'B', { type: 'dm_message', senderId: 2 });
    const swept = await pushHelper.sweepPushOutbox();
    assert.deepStrictEqual([a.reason, b.reason], ['disabled', 'disabled']);
    assert.strictEqual(swept, 0);
    assert.strictEqual(log.length, 0);
  } finally {
    firebaseService.isEnabled = wasEnabled;
  }
});
