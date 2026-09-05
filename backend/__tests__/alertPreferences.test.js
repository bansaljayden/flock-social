// Run: node --test  (from backend/)
//
// Notifications the user cannot turn off, and the switch that turns nothing off.
//
// Three findings are closed here, and one is pinned open on purpose:
//
//   1. CROWD ALERTS HAD NO OPT-OUT. services/crowdAlerts.js sends an
//      UNSOLICITED push ("The Pearl is filling up") to every accepted member of
//      a confirmed flock. `user_settings` carried no notification preference of
//      any kind and the sweep asked for none, so the only way to stop the
//      notification was to revoke push permission for the whole app at the OS
//      level. A notification a user cannot stop is a problem regardless of how
//      good it is, and it is the kind of thing App Review asks about.
//   2. PUSH BEFORE RESPONSE. routes/flocks.js awaited its whole Firebase
//      fan-out before answering the request, in four handlers. routes/billing.js
//      and routes/messages.js already answer first and notify after.
//   3. EM DASHES IN PUSH COPY. Two user-visible strings in routes/flocks.js
//      joined on ' — '. SLOP-AUDIT rule 1 forbids it in anything a user reads,
//      and a lock screen is about as user-visible as text gets.
//   4. THE VENUE SWITCH THAT READS NOTHING (pinned, not fixed). The venue
//      dashboard writes venue_profiles.notification_prefs and nothing anywhere
//      reads it, because none of the three notifications those switches name
//      exists as a send. See the last section: the guard here fires the moment
//      somebody adds an owner-directed notification without wiring the column.
const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'alert-preferences-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.PAYWALL_ENABLED;

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
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 140)}`));
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      log.push({ sql: String(sql).trim(), params: null });
      return Promise.resolve({ rows: [] });
    }
    return dispatch(sql, params);
  },
  release: () => {},
});

function on(re, fn) { handlers.push([re, fn]); }

// Auth and the push helper are replaced BEFORE the router is required: the
// router destructures pushIfOffline at module load, so a later swap is invisible
// to it.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };
authMod.requireVerified = (req, _res, next) => { next(); };

const pushHelper = require('../services/pushHelper');
let pushCalls = [];
// Default behaviour resolves immediately; the ordering tests swap in a promise
// that never settles, which is the only way to prove the response does not wait.
let pushBehaviour = async () => ({ skipped: true, reason: 'disabled' });
pushHelper.pushIfOffline = (io, userId, title, body, data) => {
  pushCalls.push({ userId, title, body, data });
  return pushBehaviour(io, userId, title, body, data);
};

const flocksRouter = require('../routes/flocks');
const firebaseService = require('../services/firebaseService');
const crowdAlerts = require('../services/crowdAlerts');

const io = {
  sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
  to() { return { emit() {} }; },
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/flocks', flocksRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

function reset() {
  handlers = [];
  log = [];
  pushCalls = [];
  pushBehaviour = async () => ({ skipped: true, reason: 'disabled' });
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  pushHelper._resetDebounce();
  flocksRouter.__resetBudgets?.();
}

async function call(method, pathname, body) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text };
}

// A request that must come back even though the push fan-out never settles.
// Without the race a regression HANGS the suite instead of failing it.
async function callWithin(ms, method, pathname, body) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('TIMED_OUT'), ms); });
  try {
    return await Promise.race([call(method, pathname, body), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// A promise the test controls, so "the route awaited the push" and "the route
// answered first" are distinguishable rather than a matter of timing luck.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// 1. The crowd-alert opt-out: storage shape
//
// The preference lives in user_settings.settings, the JSONB blob that
// GET/PATCH /api/users/settings already reads and merges and that
// frontend/src/services/userSettings.js already syncs. It needs no migration
// and no new route.
//
// It has to tolerate a STRING, and that is not defensive padding. pullSettings
// writes every synced value to localStorage with String(value), and
// readLocalSettings pushes those raw strings back up on a first sync, so a
// boolean `false` round-trips into the column as the JSON string "false". A
// reader that only understood booleans would treat a switched-off account as
// switched on, which is the exact failure this whole change exists to prevent.
// ---------------------------------------------------------------------------
const { wantsCrowdAlerts } = require('../services/crowdAlerts').__testables;

test('an account that never touched the setting still gets crowd alerts', () => {
  // DEFAULT ON, deliberately. The alert is about a flock this user accepted, at
  // a venue their group chose, inside a three-hour window before an event they
  // committed to, at most once per flock. Defaulting it off would mean nobody
  // who never opens settings ever receives it, which is indistinguishable from
  // deleting the feature.
  assert.strictEqual(wantsCrowdAlerts(null), true, 'no user_settings row at all');
  assert.strictEqual(wantsCrowdAlerts({}), true, 'a settings blob with other keys only');
  assert.strictEqual(wantsCrowdAlerts({ theme: 'dark' }), true);
  assert.strictEqual(wantsCrowdAlerts({ crowdAlerts: null }), true, 'explicit null is "unset"');
  assert.strictEqual(wantsCrowdAlerts({ crowdAlerts: undefined }), true);
});

test('switching the setting off is honoured whether it arrives as a boolean or a string', () => {
  assert.strictEqual(wantsCrowdAlerts({ crowdAlerts: false }), false);
  // The shape the client's own localStorage round-trip produces.
  assert.strictEqual(wantsCrowdAlerts({ crowdAlerts: 'false' }), false);
  assert.strictEqual(wantsCrowdAlerts({ crowdAlerts: 'False' }), false);
  assert.strictEqual(wantsCrowdAlerts({ crowdAlerts: ' false ' }), false);
  assert.strictEqual(wantsCrowdAlerts({ crowdAlerts: 'off' }), false);
  assert.strictEqual(wantsCrowdAlerts({ crowdAlerts: '0' }), false);
  assert.strictEqual(wantsCrowdAlerts({ crowdAlerts: 0 }), false);
});

test('switching the setting on is honoured in the same shapes', () => {
  assert.strictEqual(wantsCrowdAlerts({ crowdAlerts: true }), true);
  assert.strictEqual(wantsCrowdAlerts({ crowdAlerts: 'true' }), true);
  assert.strictEqual(wantsCrowdAlerts({ crowdAlerts: 1 }), true);
});

test('a settings value we cannot read is not treated as consent to stop', () => {
  // Junk in the blob must not silently disable a notification the user never
  // asked to disable, and must not silently enable one they did. Unreadable
  // means "unset", which is the documented default.
  assert.strictEqual(wantsCrowdAlerts({ crowdAlerts: { nested: true } }), true);
  assert.strictEqual(wantsCrowdAlerts({ crowdAlerts: ['false'] }), true);
  assert.strictEqual(wantsCrowdAlerts('not an object'), true);
  assert.strictEqual(wantsCrowdAlerts([]), true);
});

// ---------------------------------------------------------------------------
// 2. The crowd-alert opt-out: enforcement in the sweep
//
// Harness copied in shape from __tests__/pushDeliveryHardening.test.js: a
// confirmed flock at a well-reviewed bar 90 minutes out on a Friday night, with
// the clock pinned so the rule engine scores the same hour every run.
// ---------------------------------------------------------------------------
function scriptBusyFlock(memberRows) {
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
  on(/FROM flock_members/i, () => ({ rows: memberRows }));
  on(/FROM users u/i, () => ({ rows: [{ is_banned: false, actor_banned: false, can_see: true }] }));
}

async function runSweep(memberRows) {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-08-15T00:00:00Z') }); // Fri 8pm ET
  reset();
  const sent = [];
  let claimed = 0;
  let released = 0;
  scriptBusyFlock(memberRows);
  on(/INSERT INTO crowd_alert_sends/i, () => { claimed += 1; return { rowCount: 1 }; });
  on(/DELETE FROM crowd_alert_sends WHERE flock_id/i, () => { released += 1; return { rowCount: 1 }; });

  const prevIsEnabled = firebaseService.isEnabled;
  const prevSend = firebaseService.sendPushToUser;
  firebaseService.isEnabled = () => true;
  firebaseService.sendPushToUser = async (userId, title, body, data) => {
    sent.push({ userId, title, body, data });
    return { sent: 1, failed: 0 };
  };
  try {
    await crowdAlerts.checkCrowdAlerts();
  } finally {
    firebaseService.isEnabled = prevIsEnabled;
    firebaseService.sendPushToUser = prevSend;
    mock.timers.reset();
  }
  const memberQuery = log.find((q) => /flock_members/i.test(q.sql) && !/INSERT|UPDATE/i.test(q.sql));
  return { sent, claimed, released, memberQuery };
}

test('the sweep asks the database what each recipient wants before it pushes', async () => {
  const { memberQuery } = await runSweep([{ user_id: 1, user_settings: null }]);
  assert.ok(memberQuery, 'the sweep read flock_members at all');
  // Both halves, because either one alone is satisfiable by a query that does
  // not work: selecting us.settings without the join is a Postgres error the
  // scripted pool here would never raise, and joining without selecting it
  // leaves the filter reading undefined for everybody. (The join CONDITION
  // itself was checked against a real Postgres 18.4 rather than a mock.)
  assert.match(
    memberQuery.sql, /LEFT JOIN\s+user_settings\s+us\s+ON\s+us\.user_id\s*=\s*fm\.user_id/i,
    'the sweep must join the table the preference lives in'
  );
  assert.match(
    memberQuery.sql, /us\.settings\s+AS\s+user_settings/i,
    'a preference the sweep never reads is a preference that does not exist'
  );
});

test('a member who switched crowd alerts off is not pushed', async () => {
  const { sent, claimed } = await runSweep([{ user_id: 1, user_settings: { crowdAlerts: false } }]);
  assert.strictEqual(sent.length, 0, 'an opted-out member must receive nothing');
  // And the flock is never claimed, so the marker table does not fill up with
  // rows for alerts that were never sent and the flock stays alertable for the
  // members who did not opt out.
  assert.strictEqual(claimed, 0, 'no recipients means no claim to burn');
});

test('the string form the client round-trip produces switches it off too', async () => {
  const { sent } = await runSweep([{ user_id: 1, user_settings: { crowdAlerts: 'false' } }]);
  assert.strictEqual(sent.length, 0, 'localStorage stringifies booleans; the switch must still work');
});

test('one member opting out does not silence the alert for everybody else', async () => {
  const { sent } = await runSweep([
    { user_id: 1, user_settings: { crowdAlerts: false } },
    { user_id: 2, user_settings: null },
    { user_id: 3, user_settings: { crowdAlerts: true } },
  ]);
  assert.deepStrictEqual(sent.map((s) => s.userId).sort(), [2, 3]);
});

test('a member with no settings row still receives the alert', async () => {
  // Pins the default-on decision end to end, not just in the pure function.
  const { sent, claimed } = await runSweep([{ user_id: 9, user_settings: null }]);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].userId, 9);
  assert.strictEqual(claimed, 1);
  assert.strictEqual(sent[0].data.type, 'crowd_alert');
});

// ---------------------------------------------------------------------------
// 3. Answer first, notify after
//
// pushBehaviour is a promise that never settles. If the handler awaits the
// fan-out before res.json, the request never comes back and callWithin reports
// TIMED_OUT.
// ---------------------------------------------------------------------------
function scriptConfirmUpdate() {
  on(/SELECT creator_id FROM flocks WHERE id/i, () => ({ rows: [{ creator_id: 1 }] }));
  on(/UPDATE flocks\s+SET name/i, () => ({
    rows: [{ id: 42, name: 'Taco Night', venue_name: 'Blue Bottle', status: 'confirmed', budget_ceiling: null, event_time: '2026-08-15T23:00:00Z' }],
  }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/i, () => ({ rows: [{ user_id: 2 }] }));
  on(/FROM user_blocks/i, () => ({ rows: [] }));
}

test('confirming a flock answers the client before the push fan-out settles', async () => {
  reset();
  scriptConfirmUpdate();
  const held = deferred();
  pushBehaviour = () => held.promise;

  const res = await callWithin(2000, 'PUT', '/api/flocks/42', { status: 'confirmed' });
  held.resolve({ skipped: true });
  assert.notStrictEqual(res, 'TIMED_OUT', 'an unreachable Firebase held the response open');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.flock.status, 'confirmed');
});

test('the confirmation push still goes out after the response', async () => {
  reset();
  scriptConfirmUpdate();
  const res = await call('PUT', '/api/flocks/42', { status: 'confirmed' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(pushCalls.length, 1, 'moving the push after the response must not delete it');
  assert.strictEqual(pushCalls[0].userId, 2);
  assert.strictEqual(pushCalls[0].title, "It's happening!");
  assert.deepStrictEqual(pushCalls[0].data, { type: 'flock_confirmed', flockId: '42' });
});

test('a push failure never turns a committed flock update into a 500', async () => {
  reset();
  scriptConfirmUpdate();
  pushBehaviour = async () => { throw new Error('FCM unreachable'); };
  const res = await call('PUT', '/api/flocks/42', { status: 'confirmed' });
  assert.strictEqual(res.status, 200, 'the update committed; the client must not be told otherwise');
});

test('a push that throws SYNCHRONOUSLY after the response never tries to answer twice', async () => {
  // Promise.allSettled absorbs a REJECTED promise, so an `async` throw proves
  // nothing about the guards around this block. A synchronous throw from inside
  // .map() escapes allSettled entirely — the case routes/billing.js documents
  // ("pushIfOffline is not guaranteed to hand back a promise") — and lands in
  // the handler's catch, which at that point has already sent a 200. Without
  // both the local try/catch and the headersSent check, res.status(500) then
  // raises ERR_HTTP_HEADERS_SENT out of an async handler: an unhandled
  // rejection, on a request the client was told succeeded.
  reset();
  scriptConfirmUpdate();
  const rejections = [];
  const onRejection = (e) => rejections.push(e);
  process.on('unhandledRejection', onRejection);
  pushBehaviour = () => { throw new Error('FCM client blew up'); };
  try {
    const res = await call('PUT', '/api/flocks/42', { status: 'confirmed' });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(rejections.map(String), [], 'a post-response throw must be handled where it happens');
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

function scriptAttendance() {
  on(/SELECT creator_id, status, name FROM flocks WHERE id/i, () => ({ rows: [{ creator_id: 1, status: 'completed', name: 'Taco Night' }] }));
  on(/UPDATE flock_members SET attendance/i, () => ({ rowCount: 1 }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'$/i, () => ({ rows: [{ user_id: 2 }] }));
  on(/FROM flock_members fm\s+JOIN flocks f/i, () => ({ rows: [{ cnt: '2' }] }));
  // The reliability tally used to run three queries PER MEMBER inside the open
  // transaction; it is now one batched read over an id array. Same counts as
  // the per-member branch above returned, so every score these tests assert is
  // unchanged: this models the new statement, it does not relax anything.
  on(/FROM UNNEST\(\$1::int\[\]\) AS t\(uid\)/i, (p) => ({
    rows: (p[0] || []).map((uid) => ({ uid, joined: 2, attended: 2 })),
  }));
  on(/UPDATE users SET reliability_score/i, () => ({ rowCount: 1 }));
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/i, () => ({ rows: [{ user_id: 2 }] }));
}

test('marking attendance answers the client before the push fan-out settles', async () => {
  reset();
  scriptAttendance();
  const held = deferred();
  pushBehaviour = () => held.promise;

  const res = await callWithin(2000, 'POST', '/api/flocks/42/attendance', { attendance: [{ userId: 2, attended: true }] });
  held.resolve({ skipped: true });
  assert.notStrictEqual(res, 'TIMED_OUT', 'an unreachable Firebase held the response open');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
});

test('the attendance push still goes out after the response', async () => {
  reset();
  scriptAttendance();
  const res = await call('POST', '/api/flocks/42/attendance', { attendance: [{ userId: 2, attended: true }] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(pushCalls.length, 1);
  assert.strictEqual(pushCalls[0].userId, 2);
  assert.strictEqual(pushCalls[0].title, 'Attendance recorded');
});

function scriptJoin() {
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/i, () => ({ rows: [{ status: 'invited' }] }));
  // The flock row lock the join takes before its UPDATE, the same one billing
  // reads the roster under. BEGIN and COMMIT pass through the client fake above.
  on(/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/i, () => ({ rows: [{ id: 42 }] }));
  on(/UPDATE flock_members SET status = 'accepted'/i, () => ({ rows: [{ flock_id: 42, user_id: 1, status: 'accepted' }], rowCount: 1 }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/i, () => ({ rows: [] }));
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/SELECT creator_id, name FROM flocks WHERE id/i, () => ({ rows: [{ creator_id: 99, name: 'Taco Night' }] }));
}

test('joining a flock answers the client before the creator push settles', async () => {
  reset();
  scriptJoin();
  const held = deferred();
  pushBehaviour = () => held.promise;

  const res = await callWithin(2000, 'POST', '/api/flocks/42/join');
  held.resolve({ skipped: true });
  assert.notStrictEqual(res, 'TIMED_OUT', 'an unreachable Firebase held the response open');
  assert.strictEqual(res.status, 200);
});

test('the join push still names the joiner and still goes out', async () => {
  reset();
  scriptJoin();
  const res = await call('POST', '/api/flocks/42/join');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(pushCalls.length, 1);
  assert.strictEqual(pushCalls[0].userId, 99);
  assert.strictEqual(pushCalls[0].data.fromUserId, '1', 'the block gate needs the actor');
});

function scriptInvite() {
  on(/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'/i, () => ({ rows: [{ id: 1 }] }));
  on(/SELECT id, name FROM flocks WHERE id/i, () => ({ rows: [{ id: 42, name: 'Taco Night' }] }));
  on(/COUNT\(\*\)::int AS n FROM flock_members/i, () => ({ rows: [{ n: 2 }] }));
  // The invite path reads the roster, the directory and the block set one SET at
  // a time (2026-08-14), not one row at a time. These two branches answer what
  // the per-row branches they replace answered — nobody has a row yet, and every
  // id asked for is a real user called Bo — so the push ordering this section
  // tests sees exactly the same invite it always did.
  on(/SELECT user_id, status FROM flock_members WHERE flock_id = \$1 AND user_id = ANY\(\$2::int\[\]\)/i, () => ({ rows: [] }));
  on(/SELECT id, name FROM users WHERE id = ANY\(\$1::int\[\]\)/i, (p) => ({
    rows: (p[0] || []).map((id) => ({ id: Number(id), name: 'Bo' })),
  }));
  on(/FROM user_blocks/i, () => ({ rows: [] }));
  on(/INSERT INTO flock_members/i, () => ({ rows: [{ flock_id: 42, user_id: 5, status: 'invited' }], rowCount: 1 }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/i, () => ({ rows: [] }));
}

test('inviting answers the client before the invite pushes settle', async () => {
  reset();
  scriptInvite();
  const held = deferred();
  pushBehaviour = () => held.promise;

  const res = await callWithin(2000, 'POST', '/api/flocks/42/invite', { user_ids: [5] });
  held.resolve({ skipped: true });
  assert.notStrictEqual(res, 'TIMED_OUT', 'a 25-person invite held the response open on Firebase');
  assert.strictEqual(res.status, 200);
});

// ---------------------------------------------------------------------------
// 4. Em dashes in copy a user actually reads
//
// The two known offenders were the flock-confirmed body and the attendance
// body. The scan below covers every string literal in the three files this
// change owns so the next one is caught by the suite rather than by review.
// ---------------------------------------------------------------------------
test('the confirmation push body contains no em dash and still says what it needs to', async () => {
  reset();
  scriptConfirmUpdate();
  await call('PUT', '/api/flocks/42', { status: 'confirmed' });
  const body = pushCalls[0].body;
  assert.ok(!/[—–]/.test(body), `em dash in push body: ${body}`);
  assert.match(body, /Taco Night/);
  assert.match(body, /Blue Bottle/);
});

test('the attendance push body contains no em dash', async () => {
  reset();
  scriptAttendance();
  await call('POST', '/api/flocks/42/attendance', { attendance: [{ userId: 2, attended: true }] });
  const body = pushCalls[0].body;
  assert.ok(!/[—–]/.test(body), `em dash in push body: ${body}`);
  assert.match(body, /Taco Night/);
});

// Strip the parts of a source line that no user will ever read: a `//` comment,
// a SQL `--` comment inside a template literal, and anything a console.* call
// prints to a server log. What is left is code, and an em dash in a string
// literal there is copy.
function codeOnly(line) {
  let s = line;
  const slash = s.indexOf('//');
  if (slash !== -1) s = s.slice(0, slash);
  const dash = s.indexOf('--');
  if (dash !== -1) s = s.slice(0, dash);
  if (/console\.(log|warn|error|info)/.test(s)) return '';
  return s;
}

for (const rel of ['routes/flocks.js', 'routes/venueProfile.js', 'services/crowdAlerts.js']) {
  test(`no em dash reaches a user from ${rel}`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const offenders = src.split('\n')
      .map((line, i) => ({ n: i + 1, code: codeOnly(line) }))
      .filter(({ code }) => /[—–]/.test(code));
    assert.deepStrictEqual(
      offenders.map((o) => `${rel}:${o.n}:${o.code.trim()}`), [],
      'SLOP-AUDIT rule 1: no em dash in user-visible text. Use a period, a comma, or restructure.'
    );
  });
}

// ---------------------------------------------------------------------------
// 5. The venue switch that reads nothing (PINNED OPEN, deliberately)
//
// routes/venueProfile.js writes venue_profiles.notification_prefs from three
// dashboard switches: "New bookings / Get notified when a flock books", "New
// reviews / Alerts for customer reviews", "Weekly reports / Performance summary
// emails". Nothing in this backend reads the column, and the reason is worse
// than an oversight: NONE OF THE THREE SENDS EXISTS. No push in the codebase is
// ever addressed to a venue owner (every pushIfOffline/pushAlways/pushHelper
// call targets a flock member, a DM recipient, a flock creator or an admin),
// and services/emailService.js sends exactly two kinds of mail, verification and
// password reset. There is no booking notification, no review notification and
// no weekly report to switch off.
//
// So the column is not a control that was forgotten; it is a control for a
// feature that was never built, which SLOP-AUDIT rule 5 forbids. Wiring it here
// would mean INVENTING three notifications days before submission, which is not
// a fix. The fix is to remove the panel from the venue dashboard (it lives in
// frontend/src/App.js, which this change does not own) or to build the sends.
//
// The guard below is conditional rather than an assertion that the bug exists:
// it passes today, and it fails the moment a file grows both a venue-owner
// lookup and a send without also reading the preference column. That is the
// exact drift migrations/017 was written about, in the direction it always goes.
// ---------------------------------------------------------------------------
// ONE NARROW EXCEPTION, and it is checked rather than trusted.
//
// The heuristic above is file-level: it reads "mentions venue_profiles" plus
// "sends something" as "notifies a venue owner". routes/admin.js is the first
// file to be both without being that. It touches venue_profiles for the verify
// and tier routes, and its one send is the moderation WARNING, addressed to a
// reported user and to nobody else. That send must not be behind a preference
// switch: a warning a user can mute is not a warning, and the switches this
// column stores are about bookings, reviews and weekly reports.
//
// The exception is conditional on admin.js's sends being EXACTLY the two named
// below, so a third one, or a different second one, puts the file straight back
// in the offenders list.
//
// The second send arrived on 2026-08-26 and it broke this guard, which is what
// the guard is for. It is the venue verification decision: the owner asked to
// be verified and is told what was decided, because a silent decline is
// indistinguishable from a queue nobody has read and the owner simply asks
// again.
//
// It is exempt for the same reason the warning is, not for convenience. The
// three switches this column stores are "New bookings", "New reviews" and
// "Weekly reports". A verification decision is none of those. It is the answer
// to a request the owner themselves made, in the same class as a password
// reset, and putting the answer to your own request behind a preference switch
// is how somebody waits forever for a reply that was muted. Wiring
// notification_prefs here would also be wiring a column whose three real
// features still do not exist, which is the thing the note above refuses to do.
//
// The third and fourth sends arrived on 2026-09-04, from the trace that found
// the moderation loop never closed for two of its three parties. The BAN
// notice is addressed to the banned account, the answer to a report about
// them, in the same class as the warning: a ban a user can mute is not a
// ban. The reporter FOLLOW-UP is addressed to whoever filed the report, the
// answer to a request they themselves made, in the same class as the
// verification decision. Neither is a booking, a review or a weekly report,
// and neither recipient is being reached as a venue owner. Same conditional
// shape: exactly these four subjects, or the file is an offender again.
function exemptSend(file, code) {
  if (file !== 'admin.js') return false;
  const sends = code.match(/sendEmail\s*\(/g) || [];
  if (sends.length !== 4) return false;
  return /subject: WARN_SUBJECT/.test(code)
    && /subject: VERIFY_DECIDED_SUBJECT\(/.test(code)
    && /subject: BAN_SUBJECT/.test(code)
    && /subject: REPORT_FOLLOWUP_SUBJECT/.test(code);
}

test('any file that notifies a venue owner must read notification_prefs', () => {
  const roots = [path.join(__dirname, '..', 'routes'), path.join(__dirname, '..', 'services')];
  const offenders = [];
  for (const dir of roots) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.js')) continue;
      const full = path.join(dir, file);
      const src = fs.readFileSync(full, 'utf8');
      // Comment prose in venueProfile.js names all of these; strip line comments
      // so the guard reads code, not the note explaining the guard.
      const code = src.split('\n').map((l) => codeOnly(l)).join('\n');
      const looksUpOwner = /venue_profiles/.test(code);
      const sends = /push(Always|IfOffline|IfOfflineDebounced)\s*\(|sendPushToUser\s*\(|sendEmail\s*\(/.test(code);
      if (looksUpOwner && sends && !/notification_prefs/.test(code) && !exemptSend(file, code)) {
        offenders.push(`${path.basename(dir)}/${file}`);
      }
    }
  }
  assert.deepStrictEqual(
    offenders, [],
    'A send to a venue owner must honour venue_profiles.notification_prefs, or the dashboard switch is a lie. '
    + 'If you just built the first one: read the note above this test, wire the column, and delete this guard.'
  );
});
