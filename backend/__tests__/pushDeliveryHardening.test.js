// Run: node --test  (from backend/)
//
// Push delivery — hardening round.
//
// `__tests__/pushDelivery.test.js` already pins deep links, the visibility gate,
// the debounce and the stale-token codes. This file covers the defects that
// survived it:
//
//   1. TEXT INTEGRITY. Every caller clips a preview with `substring(0, 100)`.
//      A JS string is UTF-16, so that cuts CODE UNITS: a message whose 100th
//      unit lands inside an emoji leaves a LONE SURROGATE. FCM's JSON parser
//      rejects unpaired surrogates (400 INVALID_ARGUMENT), and because the
//      complaint is about the PAYLOAD the token is correctly kept — so the same
//      message fails forever, silently. Titles were never normalised at all.
//   2. BLOCKING. routes/flocks.js awaited the whole push fan-out BEFORE it
//      responded. firebase-admin's own deadline is 15s per attempt with retries,
//      so an unreachable FCM held a flock-status response open for a minute.
//      Its four call sites now push after responding; the deadline below is
//      kept as the property that stops any FUTURE caller reintroducing it.
//   3. TOKEN PRUNING. Deleting by row id alone can delete a token that has
//      since been handed to a different account.
//   4. ACTOR STATE. The visibility gate checked whether the RECIPIENT was
//      banned or deleted, never whether the person the push NAMES was.
//   5. CROWD ALERTS. Unsolicited pushes: an em dash in user-visible copy, a
//      sentence that said "it's moderate now but expected to get moderate
//      soon", a peak "coming up" that was the hour already in progress, a
//      busyness claim about a venue with no data behind it, and a whole
//      weather-and-scoring sweep run on a deployment where push is off.
const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'push-hardening-test-secret';
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
const crowdAlerts = require('../services/crowdAlerts');
// The push deadline in firebaseService is an unref()'d timer, so a test that
// waits for it has to keep the loop referenced itself. See the helper.
const { withEventLoopHeldOpen } = require('./helpers/eventLoopAnchor');

function reset() {
  handlers = [];
  log = [];
  pushHelper._resetDebounce();
  firebaseService.__setSenderForTests(null);
}

function on(re, fn) { handlers.push([re, fn]); }

// An unpaired UTF-16 surrogate: a high surrogate with no low after it, or a low
// with no high before it. Either one makes the JSON body invalid UTF-8.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ---------------------------------------------------------------------------
// 1. Text integrity
// ---------------------------------------------------------------------------
test('a preview clipped mid-emoji is not handed to FCM as broken UTF-16', () => {
  // Exactly how routes/messages.js and sockets/handlers.js build the preview.
  const raw = 'a'.repeat(99) + '\u{1F600}' + ' more text';
  const preview = raw.substring(0, 100);
  assert.ok(LONE_SURROGATE.test(preview), 'the caller really does hand us a broken string');

  const msg = firebaseService.buildFcmMessage('tok', 'Title', preview, { type: 'dm_message', senderId: 4 });
  assert.ok(!LONE_SURROGATE.test(msg.notification.body), 'body still ends mid-character');
  assert.strictEqual(msg.notification.body, 'a'.repeat(99));
});

test('a non-Latin preview clipped mid-character survives as whole characters', () => {
  // Devanagari is BMP, so substring is safe there; the failure is astral —
  // emoji, musical symbols, some CJK extensions. Cut one in half either way.
  const raw = '\u{20BB7}'.repeat(80); // astral CJK ideograph, 2 code units each
  const preview = raw.substring(0, 51); // odd length => splits the last pair
  assert.ok(LONE_SURROGATE.test(preview));
  const msg = firebaseService.buildFcmMessage('tok', 'T', preview, {});
  assert.ok(!LONE_SURROGATE.test(msg.notification.body));
  assert.strictEqual(Array.from(msg.notification.body).length, 25);
});

test('a title is always a real, non-empty string', () => {
  const { buildFcmMessage } = firebaseService;
  // firebase-admin rejects the whole message when notification.title is not a
  // string, so a null display name used to lose the push outright.
  assert.strictEqual(buildFcmMessage('tok', undefined, 'B', {}).notification.title, 'Flock');
  assert.strictEqual(buildFcmMessage('tok', null, 'B', {}).notification.title, 'Flock');
  assert.strictEqual(buildFcmMessage('tok', '   ', 'B', {}).notification.title, 'Flock');
  // And never the string a JS template literal makes of an object.
  const objTitle = buildFcmMessage('tok', { name: 'x' }, 'B', {}).notification.title;
  assert.strictEqual(objTitle, 'Flock');
  assert.ok(!/\[object Object\]/.test(objTitle));
});

test('a title clipped mid-emoji is repaired too', () => {
  const title = ('\u{1F3E0}'.repeat(200)).substring(0, 121);
  const msg = firebaseService.buildFcmMessage('tok', title, 'B', {});
  assert.ok(!LONE_SURROGATE.test(msg.notification.title));
});

test('an unbounded title or body cannot blow the FCM payload limit', () => {
  // Nothing in the app caps a venue name or a flock name, and several bodies
  // are built by concatenating both. FCM drops the whole message over 4KB.
  const msg = firebaseService.buildFcmMessage('tok', 'V'.repeat(4000), 'B'.repeat(9000), {});
  assert.ok(msg.notification.title.length <= 120, `title ${msg.notification.title.length}`);
  assert.ok(msg.notification.body.length <= 300, `body ${msg.notification.body.length}`);
  assert.ok(msg.notification.body.endsWith('…'), 'a clipped body says it was clipped');
});

test('the worst message the app can build still fits in an APNs payload', () => {
  // Every field maxed out with four-byte characters, and more data keys than
  // any real caller sends. Over 4KB the provider drops the notification.
  const astral = '\u{1F600}'.repeat(4000);
  const msg = firebaseService.buildFcmMessage('tok', astral, astral, {
    type: 'flock_message', flockId: '481', senderId: '2201',
    score: astral, label: astral, extra: astral, more: astral, junk: astral,
    a1: astral, a2: astral, a3: astral, a4: astral, a5: astral, a6: astral,
  });
  const bytes = Buffer.byteLength(JSON.stringify(msg), 'utf8');
  assert.ok(bytes < 4096, `serialized to ${bytes} bytes`);
  // Whatever the budget drops, the keys that decide where the tap lands stay.
  assert.strictEqual(msg.data.type, 'flock_message');
  assert.strictEqual(msg.data.link, '/?flock=481');
  assert.strictEqual(msg.data.flockId, '481', 'the routing keys are spent before the padding');
  assert.strictEqual(msg.data.senderId, '2201');
});

test('a data value that is not a scalar never ships as [object Object]', () => {
  const msg = firebaseService.buildFcmMessage('tok', 'T', 'B', {
    type: 'flock_message', flockId: 3, junk: { a: 1 }, arr: [1, 2],
  });
  assert.strictEqual(msg.data.junk, undefined);
  assert.strictEqual(msg.data.arr, undefined);
  assert.strictEqual(msg.data.flockId, '3');
  for (const v of Object.values(msg.data)) {
    assert.ok(!/\[object Object\]/.test(v));
    assert.ok(!LONE_SURROGATE.test(v));
  }
});

test('control characters never reach a lock screen', () => {
  const msg = firebaseService.buildFcmMessage('tok', 'A\u0000B', 'line\u0007one\nline two', {});
  assert.strictEqual(msg.notification.title, 'A B');
  assert.strictEqual(msg.notification.body, 'line one line two');
});

// ---------------------------------------------------------------------------
// 2. A push must never hold a request open
// ---------------------------------------------------------------------------
test('a provider that never answers does not hold the caller forever', async () => {
  reset();
  // firebase-admin's own deadline is 15s per attempt and it retries, while
  // routes/flocks.js awaits this fan-out BEFORE res.json.
  firebaseService.__setSenderForTests(() => new Promise(() => {}));
  const started = Date.now();
  // The 40ms deadline is the only thing that can end this call, and its timer
  // is unref()'d on purpose, so the loop has to be anchored while we wait.
  const res = await withEventLoopHeldOpen(
    () => firebaseService.sendPushNotification('tok', 'T', 'B', {}, { timeoutMs: 40 })
  );
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.stale, false, 'a timeout is not evidence the token is dead');
  assert.ok(Date.now() - started < 2000);
});

test('a provider that throws never rejects into the route that triggered it', async () => {
  reset();
  on(/FROM device_tokens/i, () => ({ rows: [{ id: 1, token: 't1' }] }));
  firebaseService.__setSenderForTests(() => { throw new Error('boom'); });
  const res = await firebaseService.sendPushToUser(9, 'T', 'B', {});
  // An unknown error is a reason to try that device again, and the answer
  // names it so the retry goes to it alone.
  assert.deepStrictEqual(res, { sent: 0, failed: 1, retryIds: [1] });
  assert.ok(!log.some((q) => /DELETE FROM device_tokens/i.test(q.sql)), 'an unknown error is not a dead token');
});

// ---------------------------------------------------------------------------
// 3. Token pruning
// ---------------------------------------------------------------------------
test('the provider saying a token is gone deletes that token, scoped to the account', async () => {
  reset();
  on(/FROM device_tokens/i, () => ({ rows: [{ id: 11, token: 't1' }, { id: 12, token: 't2' }] }));
  let n = 0;
  firebaseService.__setSenderForTests(() => {
    n += 1;
    if (n === 1) { const e = new Error('gone'); e.code = 'messaging/registration-token-not-registered'; throw e; }
    return 'ok';
  });
  on(/DELETE FROM device_tokens/i, () => ({ rowCount: 1 }));
  const res = await firebaseService.sendPushToUser(9, 'T', 'B', {});
  assert.deepStrictEqual(res, { sent: 1, failed: 1 });

  const del = log.find((q) => /DELETE FROM device_tokens/i.test(q.sql));
  assert.ok(del, 'the dead token was pruned');
  assert.deepStrictEqual(del.params[0], [11]);
  // A device token is transferable: routes/notifications.js reassigns the SAME
  // ROW to a new account on ON CONFLICT (token) DO UPDATE. Deleting by id alone
  // can therefore delete a registration that now belongs to someone else and
  // was never the one that failed.
  assert.ok(/user_id\s*=\s*\$2/i.test(del.sql), 'the delete is scoped to the user we pushed to');
  assert.strictEqual(del.params[1], 9);
});

test('one account cannot turn its own notification into a thousand requests', async () => {
  reset();
  let selectSql = '';
  on(/SELECT id, token FROM device_tokens/i, (_p, sql) => { selectSql = sql; return { rows: [] }; });
  firebaseService.__setSenderForTests(() => 'ok');
  await firebaseService.sendPushToUser(9, 'T', 'B', {});
  // Every row here is sent to CONCURRENTLY, so an unbounded count is an
  // unbounded outbound burst for a single notification.
  assert.match(selectSql, /LIMIT 20/i, selectSql);
  assert.match(selectSql, /ORDER BY updated_at DESC/i, selectSql);
});

test('registering a device prunes the account back to its ceiling', async () => {
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

  try {
    reset();
    let prune = null;
    on(/INSERT INTO device_tokens/i, () => ({ rows: [] }));
    on(/DELETE FROM device_tokens/i, (params, sql) => { prune = { params, sql }; return { rows: [] }; });

    const res = await fetch(`${base}/api/notifications/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a'.repeat(160), deviceType: 'ios' }),
    });
    assert.strictEqual(res.status, 200);
    assert.ok(prune, 'nothing bounded how many tokens one account can hold');
    assert.deepStrictEqual(prune.params, [1, 20]);
    // The newest survive: pruning by insertion order would evict the phone
    // somebody just signed in on.
    assert.match(prune.sql, /ORDER BY updated_at DESC/i);
  } finally {
    server.close();
  }
});

test('a prune that fails does not fail the registration it followed', async () => {
  // The token is already stored by then, which is the part the caller asked for.
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

  try {
    reset();
    on(/INSERT INTO device_tokens/i, () => ({ rows: [] }));
    on(/DELETE FROM device_tokens/i, () => Promise.reject(new Error('deadlock detected')));
    const res = await fetch(`${base}/api/notifications/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a'.repeat(160) }),
    });
    assert.strictEqual(res.status, 200);
  } finally {
    server.close();
  }
});

test('a transient provider failure never deletes a token', async () => {
  reset();
  on(/FROM device_tokens/i, () => ({ rows: [{ id: 11, token: 't1' }] }));
  firebaseService.__setSenderForTests(() => {
    const e = new Error('backend'); e.code = 'messaging/server-unavailable'; throw e;
  });
  const res = await firebaseService.sendPushToUser(9, 'T', 'B', {});
  assert.deepStrictEqual(res, { sent: 0, failed: 1, retryIds: [11] });
  assert.ok(!log.some((q) => /DELETE FROM device_tokens/i.test(q.sql)));
});

// ---------------------------------------------------------------------------
// 4. Who the push NAMES
// ---------------------------------------------------------------------------
test('a banned account cannot reach anyone through a push that names them', async () => {
  reset();
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, actor_banned: true, can_see: true }] }));
  const ok = await pushHelper.canNotify(1, { type: 'dm_message', senderId: 2 });
  assert.strictEqual(ok, false);
});

test('a live account still gets pushes that name a live sender', async () => {
  reset();
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, actor_banned: false, can_see: true }] }));
  assert.strictEqual(await pushHelper.canNotify(1, { type: 'dm_message', senderId: 2 }), true);
});

test('the actor question is actually asked of the database', async () => {
  reset();
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, can_see: true }] }));
  await pushHelper.canNotify(1, { type: 'flock_invite', flockId: 7, fromUserId: 2 });
  const q = log.find((e) => /FROM users u/i.test(e.sql));
  assert.deepStrictEqual(q.params, [1, 7, 2]);
  // Pinned against the SQL, not just the JS branch that reads the column: with
  // a stubbed pool, a fix that reads `row.actor_banned` while the query stopped
  // computing it would look identical from here.
  assert.match(q.sql, /FROM users a WHERE a\.id = \$3/i);
});

test('a push that names nobody does not ask the database about nobody', async () => {
  reset();
  // Admin moderation alerts carry no actor. The clause is spliced out entirely
  // rather than binding a third parameter that means nothing.
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, can_see: true }] }));
  assert.strictEqual(await pushHelper.canNotify(1, { type: 'moderation_report', reportId: '5' }), true);
  const q = log.find((e) => /FROM users u/i.test(e.sql));
  assert.deepStrictEqual(q.params, [1, null]);
  assert.ok(!/\$3/.test(q.sql), q.sql);
});

// ---------------------------------------------------------------------------
// 5. Crowd alerts — unsolicited notifications
// ---------------------------------------------------------------------------
const { buildAlertMessage, pickPeak, hasEnoughData } = crowdAlerts.__testables;

function score(n, label) { return { score: n, label }; }

test('no crowd alert copy contains an em dash', () => {
  // DESIGN-STANDARD rule 1, and this string went to a lock screen.
  const cases = [
    buildAlertMessage({ venueName: 'The Pearl', currentScore: score(30, 'Not Busy'), eventScore: score(90, 'Very Busy'), peak: null }),
    buildAlertMessage({ venueName: 'The Pearl', currentScore: score(30, 'Not Busy'), eventScore: score(60, 'Moderate'), peak: null }),
    buildAlertMessage({ venueName: 'The Pearl', currentScore: score(70, 'Busy'), eventScore: score(72, 'Busy'), peak: { hour: '11 PM', score: 80 } }),
    buildAlertMessage({ venueName: 'The Pearl', currentScore: score(70, 'Busy'), eventScore: score(74, 'Busy'), peak: null }),
  ];
  for (const c of cases) {
    assert.ok(c, 'a decision was reached');
    assert.ok(!/[—–]/.test(c.title), `em/en dash in title: ${c.title}`);
    assert.ok(!/[—–]/.test(c.body), `em/en dash in body: ${c.body}`);
  }
});

test('an alert never says a venue is going from busy to busy', () => {
  // The rule engine's bands are 20/40/60/80, so a 41 -> 57 jump clears the
  // +15 "getting busier" trigger without changing the word. The old copy read
  // "It's moderate now but expected to get moderate soon."
  const msg = buildAlertMessage({
    venueName: 'The Pearl',
    currentScore: score(41, 'Moderate'),
    eventScore: score(57, 'Moderate'),
    peak: null,
  });
  assert.ok(msg);
  assert.ok(!/moderate now.*moderate/i.test(msg.body), msg.body);
  assert.ok(!/(quiet|not busy|moderate|busy|very busy) now.*get \1/i.test(msg.body), msg.body);
});

test('a peak that is "coming up" is never the hour already in progress', () => {
  const forecast = [
    { hour: '9 PM', score: 88 },   // right now
    { hour: '10 PM', score: 60 },
    { hour: '11 PM', score: 40 },
  ];
  // The peak of the whole window is the hour already in progress. Announcing
  // it as "coming up" told people to hurry toward a peak they were standing in.
  const picked = pickPeak(forecast);
  assert.notStrictEqual(picked.hour, '9 PM');
  assert.deepStrictEqual(picked, { hour: '10 PM', score: 60 });
  // ...and 60 is under the bar, so nothing about a peak is claimed at all.
  const msg = buildAlertMessage({
    venueName: 'The Pearl', currentScore: score(88, 'Very Busy'), eventScore: score(70, 'Busy'), peak: picked,
  });
  assert.ok(!/peak/i.test(msg.title + msg.body), `${msg.title} / ${msg.body}`);

  // A one-entry window has no future hour in it at all.
  assert.strictEqual(pickPeak([{ hour: '9 PM', score: 99 }]), null);
  assert.strictEqual(pickPeak([]), null);

  const later = [
    { hour: '9 PM', score: 50 },
    { hour: '10 PM', score: 88 },
    { hour: '11 PM', score: 70 },
  ];
  assert.deepStrictEqual(pickPeak(later), { hour: '10 PM', score: 88 });
});

test('a venue we hold no data on never gets a busyness claim attached to it', () => {
  // crowdAlerts builds a venue stub with types [], rating 0, reviews 0 when the
  // place is not in ml_venues. Scoring that stub is scoring the clock, not the
  // venue, and the app has a standing rule against showing fabricated numbers.
  assert.strictEqual(hasEnoughData({ known: false, reviews: 0 }), false);
  assert.strictEqual(hasEnoughData({ known: true, reviews: 0 }), false);
  assert.strictEqual(hasEnoughData({ known: true, reviews: 120 }), true);
});

test('a deployment with no push configured runs no crowd sweep at all', async () => {
  reset();
  // No handlers registered: the marker sweep, the flock scan, the ml_venues
  // read and the paid weather call would all reject as unscripted.
  const prev = firebaseService.isEnabled;
  firebaseService.isEnabled = () => false;
  try {
    await crowdAlerts.checkCrowdAlerts();
  } finally {
    firebaseService.isEnabled = prev;
  }
  assert.strictEqual(log.length, 0, `queried: ${log.map((q) => q.sql).join(' | ')}`);
});

// A confirmed flock at a well-reviewed bar, 90 minutes out, on a Friday night:
// the world the sweep needs in order to reach the point of pushing.
function scriptBusyFlock() {
  on(/DELETE FROM crowd_alert_sends WHERE sent_at/i, () => ({ rowCount: 0 }));
  on(/FROM flocks f\s+WHERE f\.status/i, () => ({
    rows: [{
      id: 7, name: 'Fri', venue_id: 'p1', venue_name: 'The Pearl',
      venue_latitude: 40, venue_longitude: -74,
      event_time: new Date(Date.now() + 90 * 60 * 1000),
    }],
  }));
  on(/SELECT 1 FROM crowd_alert_sends/i, () => ({ rows: [], rowCount: 0 }));
  on(/FROM ml_venues/i, () => ({
    rows: [{ google_types: ['bar', 'night_club'], review_count: 4000, rating: 4.5, price_level: 2, timezone: 'America/New_York' }],
  }));
  on(/FROM flock_members/i, () => ({ rows: [{ user_id: 1 }] }));
  on(/INSERT INTO crowd_alert_sends/i, () => ({ rowCount: 1 }));
  // The recipient is a live account that can still see the flock, so the
  // visibility gate lets the push through to the provider.
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, actor_banned: false, can_see: true }] }));
}

// Drives the whole sweep with a scripted provider and reports what came out.
// The clock is pinned: the sweep scores the venue on the hour it is actually
// run, so on a real clock this test would pass at 9pm and prove nothing at 4am.
async function runSweep(sendResult) {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-15T00:00:00Z') }); // Fri 8pm ET
  reset();
  const sent = [];
  let released = 0;
  scriptBusyFlock();
  on(/DELETE FROM crowd_alert_sends WHERE flock_id/i, () => { released += 1; return { rowCount: 1 }; });

  const prevIsEnabled = firebaseService.isEnabled;
  const prevSend = firebaseService.sendPushToUser;
  firebaseService.isEnabled = () => true;
  firebaseService.sendPushToUser = async (userId, title, body, data) => {
    sent.push({ userId, title, body, data });
    return sendResult;
  };
  try {
    await crowdAlerts.checkCrowdAlerts();
  } finally {
    firebaseService.isEnabled = prevIsEnabled;
    firebaseService.sendPushToUser = prevSend;
    mock.timers.reset();
  }
  return { sent, released };
}

test('the alert claim is not burned when nothing could be delivered', async () => {
  // Every recipient is registered but has no live device: sent 0. Counting the
  // call as delivery marked the flock alerted forever on the strength of a
  // notification that reached nobody.
  const { sent, released } = await runSweep({ sent: 0, failed: 0 });
  assert.strictEqual(sent.length, 1, 'the sweep really did reach the provider');
  assert.strictEqual(released, 1, 'a flock nobody could be told about stays retryable');
});

test('a delivered alert keeps its claim, so the next sweep does not repeat it', async () => {
  const { sent, released } = await runSweep({ sent: 1, failed: 0 });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(released, 0);
  // And the copy that actually went out is the repaired copy.
  assert.ok(!/[—–]/.test(sent[0].title + sent[0].body), `${sent[0].title} / ${sent[0].body}`);
  assert.strictEqual(sent[0].data.type, 'crowd_alert');
});
