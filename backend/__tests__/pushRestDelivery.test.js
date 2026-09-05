// Run: node --test  (from backend/)
//
// The REST side of the push-notification path, and the block-gate actor id.
//
// The socket client falls back to these REST endpoints precisely when its
// socket is down — which is exactly when the recipient is offline and a push
// matters most. What this file pins down:
//
//   1. POST /api/flocks/:id/messages and POST /api/dm/:userId now fire the same
//      offline push the socket handlers do, with the SAME debounce key shape so
//      a message that goes out on both transports collapses to one notification.
//   2. The REST message push honours mutual blocks (invisible members skipped).
//   3. A push failure cannot turn a stored message/bill into a 500.
//   4. Every push that NAMES a user carries a `fromUserId` so the block-gate in
//      services/pushHelper.js can suppress a notification naming a blocked user:
//      flock_rsvp, attendance_marked, bill_created (the PAYER, who is the one
//      named), and guest_rsvp (the namespaced guest id).
//   5. The per-member push loops fan out with Promise.allSettled — one failed
//      delivery neither aborts the rest nor rejects the response.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'push-rest-delivery-test-secret';

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
  // The join route reads the plan's status first (lifecycle audit, 2026-09-05).
  if (/^SELECT status FROM flocks WHERE id = \$1$/.test(String(sql).trim())) return Promise.resolve({ rows: [{ status: 'planning' }], rowCount: 1 });
  return Promise.reject(new Error(`unscripted query: ${String(sql).replace(/\s+/g, ' ').slice(0, 120)}`));
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

// Replace auth + push BEFORE the routers are required — the routers destructure
// these at module load, so a later replacement would never be seen.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
let pushCalls = [];
let pushBehaviour = async () => ({ skipped: true, reason: 'disabled' });
const record = (kind) => (io, userId, title, body, data) => {
  pushCalls.push({ kind, userId, title, body, data });
  return pushBehaviour(io, userId, title, body, data);
};
pushMod.pushIfOffline = record('pushIfOffline');
pushMod.pushIfOfflineDebounced = record('pushIfOfflineDebounced');

const messagesRouter = require('../routes/messages');
const flocksRouter = require('../routes/flocks');
const billingRouter = require('../routes/billing');
const { router: guestRouter, newGuestLog } = require('../routes/guest');

let emits = [];
const io = {
  sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
  to(room) { return { emit(event, payload) { emits.push({ room, event, payload }); } }; },
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/billing', billingRouter);
app.use('/api/guest', guestRouter);
app.use('/api/flocks', flocksRouter);
app.use('/api', messagesRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  emits = [];
  pushCalls = [];
  pushBehaviour = async () => ({ skipped: true, reason: 'disabled' });
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  newGuestLog.clear();
  // The RSVP digest window in routes/flocks.js is process-wide in-memory state
  // keyed on the flock id, and every case in this file uses flock 42. Without
  // this, the join case above leaves a window open and the guest RSVP case
  // below is folded into it, so a test asserting an immediate push fails on
  // leaked state rather than on the behaviour it names. It only became
  // observable when the guest RSVP started sharing that window with the two
  // member doors, which is the whole point of the window; the leak was always
  // here.
  flocksRouter.__resetBudgets();
});

function on(re, fn) { handlers.push([re, fn]); }

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text };
}

// ---------------------------------------------------------------------------
// 1. REST flock message → offline push, mirroring the socket send path
// ---------------------------------------------------------------------------
test('a REST flock message pushes each offline member with the socket debounce key', async () => {
  on(/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'/, () => ({ rows: [{ id: 1 }] }));
  on(/INSERT INTO messages/, () => ({ rows: [{ id: 5, flock_id: 42, sender_id: 1, message_text: 'hello' }] }));
  on(/SELECT name FROM flocks WHERE id = \$1/, () => ({ rows: [{ name: 'Dinner' }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({ rows: [{ user_id: 2 }, { user_id: 3 }] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));

  const res = await call('POST', '/api/flocks/42/messages', { message_text: 'hello' });
  assert.strictEqual(res.status, 201);

  assert.strictEqual(pushCalls.length, 2, 'one push per offline member, sender excluded');
  assert.deepStrictEqual(pushCalls.map((p) => p.userId).sort(), [2, 3]);
  for (const p of pushCalls) {
    assert.strictEqual(p.kind, 'pushIfOfflineDebounced', 'must use the debounced helper so it dedupes with the socket path');
    assert.strictEqual(p.title, 'Ava in Dinner');
    assert.strictEqual(p.body, 'hello');
    // Same key shape as sockets/handlers.js send_message: type + flockId string.
    // senderId and messageId let a held push be re-checked at release
    // (UGC-loop audit 2026-09-05); the id is whatever the INSERT returned.
    assert.strictEqual(p.data.type, 'flock_message');
    assert.strictEqual(p.data.flockId, '42');
    assert.strictEqual(p.data.senderId, '1');
    assert.match(String(p.data.messageId), /^\d+$/);
    assert.deepStrictEqual(Object.keys(p.data).sort(), ['flockId', 'messageId', 'senderId', 'type']);
  }
});

test('a REST flock message push skips a member blocked by the sender', async () => {
  on(/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'/, () => ({ rows: [{ id: 1 }] }));
  on(/INSERT INTO messages/, () => ({ rows: [{ id: 5, flock_id: 42, sender_id: 1, message_text: 'hi' }] }));
  on(/SELECT name FROM flocks WHERE id = \$1/, () => ({ rows: [{ name: 'Dinner' }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({ rows: [{ user_id: 2 }, { user_id: 3 }] }));
  on(/FROM user_blocks/, () => ({ rows: [{ id: 3 }] })); // member 3 is invisible to the sender

  const res = await call('POST', '/api/flocks/42/messages', { message_text: 'hi' });
  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(pushCalls.map((p) => p.userId), [2], 'the blocked member is not notified');
});

test('a push failure never turns a stored flock message into a 500', async () => {
  on(/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'/, () => ({ rows: [{ id: 1 }] }));
  on(/INSERT INTO messages/, () => ({ rows: [{ id: 5, flock_id: 42, sender_id: 1, message_text: 'hi' }] }));
  on(/SELECT name FROM flocks WHERE id = \$1/, () => ({ rows: [{ name: 'Dinner' }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({ rows: [{ user_id: 2 }] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
  pushBehaviour = async () => { throw new Error('FCM unreachable'); };

  const res = await call('POST', '/api/flocks/42/messages', { message_text: 'hi' });
  assert.strictEqual(res.status, 201, 'the message was stored — the client must not be told otherwise');
});

// ---------------------------------------------------------------------------
// 2. REST DM → offline push, mirroring socket send_dm
// ---------------------------------------------------------------------------
test('a REST DM pushes the receiver with the socket dm debounce key', async () => {
  on(/FROM user_blocks/, () => ({ rows: [] })); // not blocked
  on(/SELECT 1 WHERE EXISTS/, () => ({ rows: [{ '?column?': 1 }] })); // hasDmRelationship
  on(/INSERT INTO direct_messages/, () => ({ rows: [{ id: 9, sender_id: 1, receiver_id: 2, message_text: 'hey' }] }));

  const res = await call('POST', '/api/dm/2', { message_text: 'hey' });
  assert.strictEqual(res.status, 201);

  assert.strictEqual(pushCalls.length, 1);
  const p = pushCalls[0];
  assert.strictEqual(p.kind, 'pushIfOfflineDebounced');
  assert.strictEqual(p.userId, 2);
  assert.strictEqual(p.title, 'Ava');
  assert.strictEqual(p.body, 'hey');
  assert.strictEqual(p.data.type, 'dm_message');
  assert.strictEqual(p.data.senderId, '1');
  assert.match(String(p.data.dmId), /^\d+$/);
  assert.deepStrictEqual(Object.keys(p.data).sort(), ['dmId', 'senderId', 'type']);
});

// ---------------------------------------------------------------------------
// 3. Actor id on user-naming pushes
// ---------------------------------------------------------------------------
test('flock_rsvp carries the joiner as fromUserId', async () => {
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ status: 'invited' }] }));
  // The flock row lock the join takes before its UPDATE, the same one billing
  // reads the roster under. BEGIN and COMMIT pass through the client fake above.
  on(/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] }));
  on(/UPDATE flock_members SET status = 'accepted'/, () => ({ rows: [{ flock_id: 42, user_id: 1, status: 'accepted' }], rowCount: 1 }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({ rows: [] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
  on(/SELECT creator_id, name FROM flocks WHERE id = \$1/, () => ({ rows: [{ creator_id: 99, name: 'Dinner' }] }));

  const res = await call('POST', '/api/flocks/42/join');
  assert.strictEqual(res.status, 200);

  const rsvp = pushCalls.find((p) => p.data.type === 'flock_rsvp');
  assert.ok(rsvp, 'the creator gets an RSVP push');
  assert.strictEqual(rsvp.userId, 99);
  assert.strictEqual(rsvp.data.fromUserId, '1', 'the joiner is the named actor');
});

test('attendance_marked carries the marker as fromUserId, and fans out with allSettled', async () => {
  on(/SELECT creator_id, status, name FROM flocks WHERE id = \$1/, () => ({ rows: [{ creator_id: 1, status: 'completed', name: 'Dinner' }] }));
  on(/UPDATE flock_members SET attendance/, () => ({ rows: [], rowCount: 1 }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'/, () => ({ rows: [{ user_id: 2 }, { user_id: 3 }] }));
  on(/SELECT COUNT\(\*\) AS cnt FROM flock_members fm/, () => ({ rows: [{ cnt: '1' }] }));
  // Batched reliability tally, replacing three queries per member. Returns the
  // same counts the per-member branch above did, so the scores asserted here
  // are unchanged.
  on(/FROM UNNEST\(\$1::int\[\]\) AS t\(uid\)/, (p) => ({
    rows: (p[0] || []).map((uid) => ({ uid, joined: 1, attended: 1 })),
  }));
  on(/UPDATE users SET reliability_score/, () => ({ rows: [] }));

  // One recipient's delivery fails; the other must still be attempted and the
  // response must still be 200 (the attendance transaction already committed).
  pushBehaviour = async (_io, userId) => {
    if (userId === 2) throw new Error('FCM down for this token');
    return { sent: 1 };
  };

  const res = await call('POST', '/api/flocks/42/attendance', {
    attendance: [{ userId: 2, attended: true }, { userId: 3, attended: false }],
  });
  assert.strictEqual(res.status, 200, 'a failed push must not undo committed attendance');

  const marks = pushCalls.filter((p) => p.data.type === 'attendance_marked');
  assert.deepStrictEqual(marks.map((p) => p.userId).sort(), [2, 3], 'one failure does not abort the rest');
  for (const m of marks) assert.strictEqual(m.data.fromUserId, '1');
});

test('bill_created names the PAYER as fromUserId and fans out with allSettled', async () => {
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  const members = [{ id: 1, name: 'Ava' }, { id: 2, name: 'Ben' }, { id: 3, name: 'Cy' }];
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status/, () => ({ rows: members.map((m) => ({ user_id: m.id })) }));
  on(/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ id: 1 }] }));
  on(/SELECT u\.id, u\.name FROM flock_members/, () => ({ rows: members }));
  // The bill is block-filtered per reader now (2026-08-14); nobody blocks
  // anybody here.
  on(/FROM user_blocks/, () => ({ rows: [] }));
  on(/SELECT name, creator_id FROM flocks/, () => ({ rows: [{ name: 'Dinner', creator_id: 1 }] }));
  on(/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] }));
  on(/SELECT id, paid_by FROM bill_splits/, () => ({ rows: [] }));
  on(/SELECT user_id, .*FROM bill_split_shares/, () => ({ rows: [] }));
  on(/INSERT INTO bill_splits/, () => ({ rows: [{ id: 7 }] }));
  on(/DELETE FROM bill_split_shares/, () => ({ rows: [], rowCount: 0 }));
  on(/INSERT INTO bill_split_shares/, () => ({ rows: [] }));

  // Ava (creator, id 1) opens the bill but names Ben (id 2) as the payer.
  pushBehaviour = async (_io, userId) => {
    if (userId === 3) throw new Error('one token down');
    return { sent: 1 };
  };

  const res = await call('POST', '/api/billing/42/create', { totalAmount: 90, paidBy: 2 });
  assert.strictEqual(res.status, 201);

  const bills = pushCalls.filter((p) => p.data.type === 'bill_created');
  // Payer (2) is not notified; 1 and 3 are — and 3's failure does not stop 1.
  assert.deepStrictEqual(bills.map((p) => p.userId).sort(), [1, 3]);
  for (const b of bills) {
    assert.strictEqual(b.data.fromUserId, '2', 'the named party is the payer, not the request author');
  }
});

test('guest_rsvp carries the namespaced guest id as fromUserId', async () => {
  on(/FROM flock_invite_links il/, () => ({ rows: [{ flock_id: 42, name: 'Dinner', event_time: null, venue_name: null, status: 'active', host_name: 'Bob' }] }));
  on(/pg_advisory_xact_lock/, () => ({ rows: [] }));
  on(/SELECT COUNT\(\*\)::int AS n FROM guest_rsvps/, () => ({ rows: [{ n: 0 }] }));
  on(/SELECT 1 FROM guest_rsvps\s+WHERE flock_id = \$1\s+AND COALESCE\(is_hidden/, () => ({ rows: [] })); // takedown check
  on(/INSERT INTO guest_rsvps/, () => ({ rows: [{ id: 5, guest_token: '11111111-1111-4111-8111-111111111111', is_hidden: false }] }));
  on(/AS members/, () => ({ rows: [{ members: 2, guests: 1 }] })); // announce counts
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'/, () => ({ rows: [{ user_id: 2 }] })); // broadcastGuestRsvp fan-out
  on(/SELECT creator_id, name FROM flocks WHERE id = \$1/, () => ({ rows: [{ creator_id: 9, name: 'Dinner' }] }));

  const res = await call('POST', '/api/guest/ABCDEFGHJK/rsvp', { name: 'Alice', status: 'in' });
  assert.strictEqual(res.status, 201);

  const g = pushCalls.find((p) => p.data.type === 'guest_rsvp');
  assert.ok(g, 'the offline host is pushed on a new yes');
  assert.strictEqual(g.userId, 9);
  assert.strictEqual(g.title, 'Alice is in!');
  assert.strictEqual(g.data.fromUserId, 'guest:5', 'a guest has no user account — a namespaced id the block-gate reads as no actor');
});
