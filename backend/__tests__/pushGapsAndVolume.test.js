// Run: node --test  (from backend/)
//
// THE EVENTS THAT SHOULD HAVE PUSHED AND DID NOT, AND THE ONE THAT PUSHED TOO
// MUCH.
//
// The audit that produced this file found push built well in the middle and
// broken at both ends. `__tests__/pushDelivery.test.js` covers the destination
// half (where a tap LANDS). This file covers the other half: which events are
// allowed to reach a phone at all, and how often.
//
// What it pins:
//
//   1. A PLAN THAT MOVES REACHES PEOPLE WHO ARE NOT LOOKING. PUT /api/flocks/:id
//      pushed on exactly one transition, status -> confirmed. A time, venue or
//      name change emitted a socket event and stopped, so a plan moving from 8pm
//      to 10pm reached only whoever had the app open. The people it missed are
//      the ones who turn up at 8.
//   2. A CANCELLED OR DELETED PLAN SAYS SO. Socket only, same consequence.
//      The deleted case carries NO flockId, because the row is gone: the
//      visibility gate in pushHelper would find no flock and suppress every
//      send, and there is no screen left to open either.
//   3. THE PAYER LEARNS THEY WERE PAID. bill_created told you that you OWE;
//      nothing told the person who fronted the money that the debt cleared.
//   4. THE YES TRAVELS AS WELL AS THE ASK. A friend request pushed; accepting
//      one did not.
//   5. "I AM FREE TONIGHT" LEAVES THE APP, under four rations, because it is
//      the only push here that is not about a row the recipient already owns.
//   6. THE RSVP FAN-OUT COLLAPSES. A ten-person flock was nine separate
//      "X is going" pushes to one host, each collapsing the last on the lock
//      screen. First one immediate, the rest batched.
//
// And the negative space, which matters as much: a confirm does not ALSO send
// "plan updated", a venue photo does not notify anybody, a maybe never buzzes a
// phone, and no individual departure interrupts a host.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'push-gaps-test-secret';

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

// Replace auth and push BEFORE the routers are required. Every router
// destructures these at module load, so a later replacement is never seen.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };
authMod.requireVerified = (req, _res, next) => next();

const pushMod = require('../services/pushHelper');
let pushCalls = [];
let pushBehaviour = async () => ({ sent: 1, failed: 0 });
const record = (kind) => (io, userId, title, body, data) => {
  pushCalls.push({ kind, userId, title, body, data });
  return pushBehaviour(io, userId, title, body, data);
};
pushMod.pushIfOffline = record('pushIfOffline');
pushMod.pushIfOfflineDebounced = record('pushIfOfflineDebounced');
// The routes ask this BEFORE doing the database work that builds a
// notification, so a deployment with no delivery pays for none of it. Every
// test here is about a deployment that DOES deliver.
pushMod.isPushConfigured = () => true;

const flocksRouter = require('../routes/flocks');
const billingRouter = require('../routes/billing');
const friendsRouter = require('../routes/friends');
const availabilityRouter = require('../routes/availability');

let emits = [];
const io = {
  sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
  to(room) { return { emit(event, payload) { emits.push({ room, event, payload }); } }; },
  in() { return { socketsLeave() {} }; },
  socketsLeave() {},
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/billing', billingRouter);
app.use('/api/friends', friendsRouter);
app.use('/api/availability', availabilityRouter);
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

test.beforeEach(() => {
  handlers = [];
  log = [];
  emits = [];
  pushCalls = [];
  pushBehaviour = async () => ({ sent: 1, failed: 0 });
  CURRENT_USER = { id: 1, name: 'Ava', role: 'user' };
  // The invite debounce and the RSVP digest windows are process-wide in-memory
  // state, so one test's suppression window would otherwise decide the next
  // test's expectations.
  flocksRouter.__resetBudgets();
  availabilityRouter.__resetPulseWindows();
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

// The push work is deliberately AFTER res.json, so the response arriving is not
// evidence that the fan-out has run.
const settle = () => new Promise((r) => setTimeout(r, 30));

// Everything PUT /api/flocks/:id touches on the happy path, with the flock
// owned by the caller.
function scriptFlockUpdate(overrides = {}) {
  const row = {
    id: 42,
    name: 'Dinner',
    venue_name: 'Kome',
    event_time: '2026-09-04T02:00:00.000Z',
    status: 'planning',
    created_at: '2026-08-01T00:00:00.000Z',
    budget_ceiling: null,
    budget_enabled: false,
    ...overrides,
  };
  on(/^SELECT creator_id FROM flocks WHERE id = \$1$/, () => ({ rows: [{ creator_id: 1 }] }));
  on(/SELECT created_at, status FROM flocks WHERE id = \$1/, () => ({ rows: [{ created_at: row.created_at, status: 'planning' }] }));
  on(/UPDATE flocks\s+SET name = COALESCE/, () => ({ rows: [row], rowCount: 1 }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({ rows: [{ user_id: 2 }, { user_id: 3 }] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
  on(/SELECT COUNT\(\*\) AS cnt FROM flock_members/, () => ({ rows: [{ cnt: '2' }] }));
  on(/FROM budget_submissions/, () => ({ rows: [{ sub_count: '0', skip_count: '0' }] }));
  on(/INSERT INTO research_analytics/, () => ({ rows: [], rowCount: 1 }));
  return row;
}

// ---------------------------------------------------------------------------
// 1. A plan that moves
// ---------------------------------------------------------------------------
test('moving the time notifies the members who are not looking at the app', async () => {
  scriptFlockUpdate({ event_time: '2026-09-04T02:00:00.000Z' });

  const res = await call('PUT', '/api/flocks/42', { event_time: '2026-09-04T02:00:00.000Z' });
  assert.strictEqual(res.status, 200);
  await settle();

  const moved = pushCalls.filter((p) => p.data.type === 'flock_updated');
  assert.strictEqual(moved.length, 2, 'every accepted member except the editor');
  assert.deepStrictEqual(moved.map((p) => p.userId).sort(), [2, 3]);
  for (const p of moved) {
    // Debounced, not immediate: rescheduling is a fiddly action and a minute of
    // dragging a time control must be one notification, not six.
    assert.strictEqual(p.kind, 'pushIfOfflineDebounced');
    assert.strictEqual(p.title, 'Plan updated');
    // The body deliberately does NOT carry the new time: event_time is a
    // naive TIMESTAMP and the server runs in UTC, so the old "moved to
    // Fri, 2:00 AM" string was the UTC wall clock, wrong hour and often
    // wrong weekday, on the one notification whose whole job is the time.
    // The app shows the correct client-local time on open.
    assert.strictEqual(p.body, 'Dinner has a new time. Open it to see when.');
    assert.doesNotMatch(p.body, /\d:\d\d/, 'no wall-clock time in a UTC process');
    assert.strictEqual(p.data.flockId, '42');
  }
});

test('a new venue and a rename each say which one changed', async () => {
  scriptFlockUpdate({ venue_name: 'Kome' });
  await call('PUT', '/api/flocks/42', { venue_name: 'Kome' });
  await settle();
  assert.strictEqual(pushCalls[0].body, 'Dinner is now at Kome.');

  pushCalls = [];
  handlers = [];
  scriptFlockUpdate({ name: 'Late dinner' });
  await call('PUT', '/api/flocks/42', { name: 'Late dinner' });
  await settle();
  assert.strictEqual(pushCalls[0].body, 'This plan is now called Late dinner.');
});

test('an edit that changes nothing anybody has to act on notifies nobody', async () => {
  scriptFlockUpdate();
  // A venue photo, a rating and a lat/lng do not change where or when a person
  // has to be. Pushing on them would make this the noisiest type in the app.
  const res = await call('PUT', '/api/flocks/42', { venue_rating: 4.5, venue_latitude: 40.6, venue_longitude: -75.4 });
  assert.strictEqual(res.status, 200);
  await settle();
  assert.strictEqual(pushCalls.length, 0);
});

test('confirming a plan is one announcement, not two', async () => {
  scriptFlockUpdate({ status: 'confirmed' });
  // The client sends the final time WITH the confirm. "It's happening!" already
  // carries the venue and the time, so a "Plan updated" behind it would be the
  // same news twice on one lock screen.
  const res = await call('PUT', '/api/flocks/42', { status: 'confirmed', event_time: '2026-09-04T02:00:00.000Z' });
  assert.strictEqual(res.status, 200);
  await settle();

  assert.strictEqual(pushCalls.filter((p) => p.data.type === 'flock_updated').length, 0);
  assert.strictEqual(pushCalls.filter((p) => p.data.type === 'flock_confirmed').length, 2);
});

// ---------------------------------------------------------------------------
// 2. A plan that is off
// ---------------------------------------------------------------------------
test('cancelling a plan tells the people who were going', async () => {
  scriptFlockUpdate({ status: 'cancelled' });
  const res = await call('PUT', '/api/flocks/42', { status: 'cancelled' });
  assert.strictEqual(res.status, 200);
  await settle();

  const off = pushCalls.filter((p) => p.data.type === 'flock_cancelled');
  assert.deepStrictEqual(off.map((p) => p.userId).sort(), [2, 3]);
  assert.strictEqual(off[0].title, 'Plan cancelled');
  assert.strictEqual(off[0].body, 'Dinner is off.');
  // The flock row still exists when it is merely cancelled, so the link can
  // still open it.
  assert.strictEqual(off[0].data.flockId, '42');
});

test('deleting a plan notifies its members, and carries no id because there is no row left', async () => {
  on(/^SELECT creator_id FROM flocks WHERE id = \$1$/, () => ({ rows: [{ creator_id: 1 }] }));
  on(/SELECT name FROM flocks WHERE id = \$1/, () => ({ rows: [{ name: 'Dinner' }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({ rows: [{ user_id: 2 }, { user_id: 3 }] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
  // Both delete paths refuse while anyone still owes money on the plan: the
  // bill and every share row are ON DELETE CASCADE, so a delete used to take
  // them with it and nothing could recreate any of it. Nothing is owed here.
  on(/FROM bill_split_shares bss/, () => ({ rows: [{ owed: false }] }));
  // Both delete paths run under the flock row lock now, in one transaction
  // with the outstanding-bill guard, so a /create cannot commit a bill into
  // the gap between the guard and the DELETE.
  on(/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] }));
  on(/DELETE FROM flocks WHERE id = \$1/, () => ({ rows: [], rowCount: 1 }));

  const res = await call('DELETE', '/api/flocks/42');
  assert.strictEqual(res.status, 200);
  await settle();

  const off = pushCalls.filter((p) => p.data.type === 'flock_cancelled');
  assert.deepStrictEqual(off.map((p) => p.userId).sort(), [2, 3]);
  assert.strictEqual(off[0].body, 'Dinner is off.');
  assert.ok(!('flockId' in off[0].data),
    'the flock is gone: an id here would make pushHelper suppress the send and would name a screen that cannot open');
});

test('deleting a plan takes the flock lock before it checks for money owed', async () => {
  // The outstanding-bill guard and the DELETE used to be two autocommit
  // statements with awaited work between them, so a /create could commit a
  // bill into the gap and the cascade would take it. Both now run in one
  // transaction under the same row lock /create holds, and the ORDER is the
  // property: lock, then guard, then delete, on one connection.
  const order = [];
  on(/^SELECT creator_id FROM flocks WHERE id = \$1$/, () => ({ rows: [{ creator_id: 1 }] }));
  on(/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => { order.push('lock'); return { rows: [{ id: 42 }] }; });
  on(/FROM bill_split_shares bss/, () => { order.push('guard'); return { rows: [{ owed: false }] }; });
  on(/SELECT name FROM flocks WHERE id = \$1/, () => ({ rows: [{ name: 'Dinner' }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({ rows: [{ user_id: 2 }] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
  on(/DELETE FROM flocks WHERE id = \$1/, () => { order.push('delete'); return { rows: [], rowCount: 1 }; });

  const res = await call('DELETE', '/api/flocks/42');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(order, ['lock', 'guard', 'delete'],
    'the guard must read under the lock, and the delete must follow it on the same transaction');
});

test('a plan with money still owed cannot be deleted, and the transaction is rolled back', async () => {
  const seen = [];
  on(/^SELECT creator_id FROM flocks WHERE id = \$1$/, () => ({ rows: [{ creator_id: 1 }] }));
  on(/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] }));
  on(/FROM bill_split_shares bss/, () => ({ rows: [{ owed: true }] }));
  on(/DELETE FROM flocks WHERE id = \$1/, () => { seen.push('delete'); return { rows: [], rowCount: 1 }; });

  const res = await call('DELETE', '/api/flocks/42');
  assert.strictEqual(res.status, 409, res.text);
  assert.deepStrictEqual(seen, [], 'the DELETE ran despite money being owed');
  assert.strictEqual(pushCalls.filter((p) => p.data.type === 'flock_cancelled').length, 0,
    'nobody was told a plan was cancelled when it was not');
});

test('the recipient list for a deleted plan is read before the cascade removes it', async () => {
  const order = [];
  on(/^SELECT creator_id FROM flocks WHERE id = \$1$/, () => ({ rows: [{ creator_id: 1 }] }));
  on(/SELECT name FROM flocks WHERE id = \$1/, () => ({ rows: [{ name: 'Dinner' }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => {
    order.push('read-members');
    return { rows: [{ user_id: 2 }] };
  });
  on(/FROM user_blocks/, () => ({ rows: [] }));
  // Both delete paths refuse while anyone still owes money on the plan: the
  // bill and every share row are ON DELETE CASCADE, so a delete used to take
  // them with it and nothing could recreate any of it. Nothing is owed here.
  on(/FROM bill_split_shares bss/, () => ({ rows: [{ owed: false }] }));
  // Both delete paths run under the flock row lock now, in one transaction
  // with the outstanding-bill guard, so a /create cannot commit a bill into
  // the gap between the guard and the DELETE.
  on(/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] }));
  on(/DELETE FROM flocks WHERE id = \$1/, () => { order.push('delete'); return { rows: [], rowCount: 1 }; });

  await call('DELETE', '/api/flocks/42');
  await settle();
  // The socket fan-out reads the same roster for the same reason, so there is
  // more than one read here. What must hold is that NONE of them is after the
  // DELETE: flock_members cascades away with the flock, so a read on the other
  // side of it finds nobody to notify.
  assert.ok(order.length >= 2);
  assert.strictEqual(order[order.length - 1], 'delete');
  assert.ok(order.slice(0, -1).every((step) => step === 'read-members'));
});

test('a member leaving takes the flock lock before the membership statement', async () => {
  // POST /api/billing/:flockId/create reads the accepted roster and the
  // payer's eligibility under `SELECT id FROM flocks WHERE id = $1 FOR UPDATE`.
  // The leave used to run its one atomic statement on the pool, outside any
  // lock, so it could commit between billing's read and billing's COMMIT: Bob
  // names himself payer, leaves in that window, and a bill is committed that
  // is payable to someone who can no longer open billing. The ORDER is the
  // property: lock first, then the statement, on one transaction.
  CURRENT_USER = { id: 2, name: 'Bo', role: 'user' };
  const order = [];
  on(/SELECT id, name, creator_id, status FROM flocks WHERE id = \$1/, () => ({ rows: [{ id: 42, name: 'Dinner', creator_id: 9, status: 'planning' }] }));
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ status: 'accepted' }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({ rows: [{ user_id: 3 }] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
  on(/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => { order.push('lock'); return { rows: [{ id: 42 }] }; });
  on(/WITH gone AS/, () => { order.push('leave'); return { rows: [], rowCount: 0 }; });

  const res = await call('POST', '/api/flocks/42/leave');
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(order, ['lock', 'leave'],
    'the membership must be removed under the lock billing holds, not beside it');
  const begin = log.findIndex((q) => /^BEGIN/.test(q.sql));
  const commit = log.findIndex((q) => /^COMMIT/.test(q.sql));
  const leaveAt = log.findIndex((q) => /WITH gone AS/.test(q.sql));
  assert.ok(begin > -1 && commit > -1 && begin < leaveAt && leaveAt < commit,
    'the leave statement must sit inside the transaction, not before or after it');
});

test('the host is told when the last member leaves, and never told about the ones before', async () => {
  CURRENT_USER = { id: 2, name: 'Bo', role: 'user' };
  on(/SELECT id, name, creator_id, status FROM flocks WHERE id = \$1/, () => ({ rows: [{ id: 42, name: 'Dinner', creator_id: 9, status: 'planning' }] }));
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ status: 'accepted' }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({ rows: [] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
  // The leave is one statement now: membership out and, with nobody accepted
  // left, the flock too. The RETURNING row is how the route learns the plan
  // is gone, which is what tells the host.
  // A non-creator leave runs under the flock row lock now, in one
  // transaction with the CTE, so it serialises against billing's roster read.
  on(/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] }));
  on(/WITH gone AS/, () => ({ rows: [{ id: 42 }], rowCount: 1 }));

  const res = await call('POST', '/api/flocks/42/leave');
  assert.strictEqual(res.status, 200);
  await settle();

  // ONE push, to the host, at the moment the plan actually ends. A push per
  // departure would be the noisiest and least actionable notification in the
  // app: the host cannot make anybody come back, and the roster already says
  // who is in.
  assert.strictEqual(pushCalls.length, 1);
  assert.strictEqual(pushCalls[0].userId, 9);
  assert.strictEqual(pushCalls[0].data.type, 'flock_cancelled');
  assert.match(pushCalls[0].body, /Everybody left Dinner/);

  // And the same news in-app, live. The push stays quiet for a host who is
  // online, and the plans list only refetches on mount, so without this event
  // an online host kept a dead plan on the list for the rest of the session.
  const gone = emits.filter((e) => e.event === 'flock_deleted');
  assert.strictEqual(gone.length, 1);
  assert.strictEqual(gone[0].room, 'user:9');
  assert.strictEqual(gone[0].payload.flockId, 42);
  assert.strictEqual(gone[0].payload.flockName, 'Dinner');
  assert.strictEqual(gone[0].payload.reason, 'emptied');
  assert.strictEqual('deletedBy' in gone[0].payload, false,
    'no name rides in this payload: nobody deleted the plan, it emptied');
});

test('a member leaving a plan that survives does not interrupt the host', async () => {
  CURRENT_USER = { id: 2, name: 'Bo', role: 'user' };
  on(/SELECT id, name, creator_id, status FROM flocks WHERE id = \$1/, () => ({ rows: [{ id: 42, name: 'Dinner', creator_id: 9, status: 'planning' }] }));
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ status: 'accepted' }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({ rows: [{ user_id: 3 }] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
  // Somebody accepted remains, so the statement removes the membership and
  // returns no flock row: the plan survives and the host hears nothing.
  // A non-creator leave runs under the flock row lock now, in one
  // transaction with the CTE, so it serialises against billing's roster read.
  on(/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] }));
  on(/WITH gone AS/, () => ({ rows: [], rowCount: 0 }));

  await call('POST', '/api/flocks/42/leave');
  await settle();
  assert.strictEqual(pushCalls.length, 0);
  assert.strictEqual(emits.filter((e) => e.event === 'flock_deleted').length, 0,
    'a plan that survives is not announced as gone');
});

// ---------------------------------------------------------------------------
// 3. Somebody paid you back
// ---------------------------------------------------------------------------
function scriptSettle(paidBy) {
  // /settle takes the same flock-row lock /create holds, so a settle cannot
  // land inside /create's read-then-rewrite and be erased by it.
  on(/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 42 }] }));
  on(/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'/, () => ({ rows: [{ id: 1 }] }));
  on(/SELECT id FROM bill_splits WHERE flock_id/, () => ({ rows: [{ id: 7 }] }));
  on(/UPDATE bill_split_shares SET settled/, () => ({ rows: [{ id: 1, amount: '12.50' }] }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status/, () => ({ rows: [{ user_id: 1 }, { user_id: 2 }] }));
  on(/SELECT COUNT\(\*\) AS count FROM bill_split_shares/, () => ({ rows: [{ count: '0' }] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
  on(/SELECT bs\.paid_by, f\.name AS flock_name/, () => ({ rows: [{ paid_by: paidBy, flock_name: 'Dinner' }] }));
}

test('settling a share tells the person who fronted the money', async () => {
  scriptSettle(2);
  const res = await call('POST', '/api/billing/42/settle');
  assert.strictEqual(res.status, 200);
  await settle();

  const paid = pushCalls.filter((p) => p.data.type === 'bill_settled');
  assert.strictEqual(paid.length, 1, 'one push, to one person, not a fan-out to the table');
  assert.strictEqual(paid[0].userId, 2);
  // FLOCK DID NOT SEE THIS MONEY (honesty pass 2026-08-26). This used to read
  // "You got paid back" / "Ava settled up $12.50 for Dinner." Both state a
  // transfer as fact. Nothing in this app processes, holds, guarantees or
  // observes a payment: the debtor is handed off to Venmo, Cash App or Zelle
  // and comes back and taps a button, so all the server knows is that somebody
  // SAID they paid. A payer who reads "You got paid back" and stops checking
  // their own payment app is out of pocket on Flock's word.
  assert.strictEqual(paid[0].title, 'Marked as paid back');
  assert.strictEqual(paid[0].body, 'Ava says they paid you $12.50 for Dinner. Check your payment app.');
  assert.ok(
    !/you got paid|we (received|processed)|payment (received|complete)/i.test(`${paid[0].title} ${paid[0].body}`),
    'settlement is self-reported; no notification may state the transfer as observed fact'
  );
  // The body names the settler, so the block gate has to be given the settler.
  assert.strictEqual(paid[0].data.fromUserId, '1');
  assert.strictEqual(paid[0].data.flockId, '42');
});

test('nobody is told they paid themselves back', async () => {
  scriptSettle(1); // the payer settling their own share
  await call('POST', '/api/billing/42/settle');
  await settle();
  assert.strictEqual(pushCalls.filter((p) => p.data.type === 'bill_settled').length, 0);
});

test('a push failure never turns a settled debt into a 500', async () => {
  scriptSettle(2);
  pushBehaviour = async () => { throw new Error('FCM unreachable'); };
  const res = await call('POST', '/api/billing/42/settle');
  assert.strictEqual(res.status, 200, 'the share IS settled; telling the user otherwise makes them pay twice');
});

// ---------------------------------------------------------------------------
// 4. Friend request accepted
// ---------------------------------------------------------------------------
test('accepting a friend request tells the person who sent it', async () => {
  on(/FROM user_blocks/, () => ({ rows: [] }));
  on(/UPDATE friendships SET status = 'accepted'/, () => ({ rows: [{ id: 3 }], rowCount: 1 }));
  on(/FROM friendships/, () => ({ rows: [{ id: 3, status: 'accepted', requester_id: 4, addressee_id: 1 }] }));
  on(/DELETE FROM friendships/, () => ({ rows: [], rowCount: 0 }));

  const res = await call('POST', '/api/friends/accept', { user_id: 4 });
  assert.strictEqual(res.status, 200);
  await settle();

  const yes = pushCalls.filter((p) => p.data.type === 'friend_accepted');
  assert.strictEqual(yes.length, 1);
  assert.strictEqual(yes[0].userId, 4, 'the requester, who had been told nothing at all');
  assert.strictEqual(yes[0].body, 'Ava accepted your friend request.');
  assert.strictEqual(yes[0].data.fromUserId, '1');
});

// ---------------------------------------------------------------------------
// 5. "I am free tonight"
// ---------------------------------------------------------------------------
function scriptPulse(priorStatus) {
  on(/SELECT status FROM availability_pulses WHERE user_id = \$1 AND expires_at > NOW\(\)/,
    () => ({ rows: priorStatus ? [{ status: priorStatus }] : [] }));
  on(/INSERT INTO availability_pulses/, (p) => ({ rows: [{ status: p[1], note: p[2], set_at: new Date(), expires_at: new Date(Date.now() + 3600000) }] }));
  on(/FROM friendships/, () => ({ rows: [{ friend_id: 2 }, { friend_id: 3 }] }));
}

test('saying you are free tonight reaches the friends who are not in the app', async () => {
  scriptPulse(null);
  const res = await call('POST', '/api/availability', { status: 'down', note: 'anyone want food' });
  assert.strictEqual(res.status, 200);
  await settle();

  const pulse = pushCalls.filter((p) => p.data.type === 'availability_pulse');
  assert.deepStrictEqual(pulse.map((p) => p.userId).sort(), [2, 3]);
  assert.strictEqual(pulse[0].title, 'Ava is free tonight');
  assert.strictEqual(pulse[0].body, '"anyone want food"');
  assert.strictEqual(pulse[0].data.fromUserId, '1');
});

test('a maybe is an answer, not an invitation, and nobody is woken up for one', async () => {
  scriptPulse(null);
  await call('POST', '/api/availability', { status: 'maybe' });
  await settle();
  assert.strictEqual(pushCalls.length, 0);
});

test('editing a pulse that is already down is not news', async () => {
  scriptPulse('down');
  await call('POST', '/api/availability', { status: 'down', note: 'new note' });
  await settle();
  assert.strictEqual(pushCalls.length, 0, 'the push is for BECOMING free, not for fixing a typo');
});

test('one sender buzzes a friends list once, however many times they toggle', async () => {
  scriptPulse(null);
  await call('POST', '/api/availability', { status: 'down' });
  await settle();
  assert.strictEqual(pushCalls.length, 2);

  // The prior read still answers empty, so rule 2 would let this through; rule
  // 3 is what stops it.
  pushCalls = [];
  await call('POST', '/api/availability', { status: 'down' });
  await settle();
  assert.strictEqual(pushCalls.length, 0, 'down, not, down, not is one notification, not four');
});

test('a recipient already told tonight is not told again by the next friend', async () => {
  scriptPulse(null);
  await call('POST', '/api/availability', { status: 'down' });
  await settle();
  assert.deepStrictEqual(pushCalls.map((p) => p.userId).sort(), [2, 3]);

  // A DIFFERENT friend going free. The sender window does not apply, so this is
  // the rule that actually bounds an evening: the first friend to say they are
  // free buzzes you and the next nine do not. They are all still on the friends
  // list when you look.
  pushCalls = [];
  CURRENT_USER = { id: 5, name: 'Cy', role: 'user' };
  handlers = [];
  scriptPulse(null);
  on(/FROM friendships/, () => ({ rows: [{ friend_id: 2 }, { friend_id: 3 }] }));
  await call('POST', '/api/availability', { status: 'down' });
  await settle();
  assert.strictEqual(pushCalls.length, 0);
});

// ---------------------------------------------------------------------------
// 6. The RSVP fan-out, collapsed
// ---------------------------------------------------------------------------
function scriptJoin(joiner) {
  CURRENT_USER = { id: joiner, name: `User${joiner}`, role: 'user' };
  handlers = [];
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ status: 'invited' }] }));
  on(/UPDATE flock_members SET status = 'accepted'/, () => ({ rows: [{ flock_id: 42, user_id: joiner, status: 'accepted' }], rowCount: 1 }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({ rows: [] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
  on(/SELECT creator_id, name FROM flocks WHERE id = \$1/, () => ({ rows: [{ creator_id: 99, name: 'Dinner' }] }));
}

test('the first RSVP is immediate and every one behind it is folded into a digest', async () => {
  const { flushRsvpWindow } = flocksRouter.__testables;

  scriptJoin(7);
  await call('POST', '/api/flocks/42/join');
  await settle();
  assert.strictEqual(pushCalls.length, 1, 'the host hears about the first person straight away');
  assert.strictEqual(pushCalls[0].title, 'User7 is going!');
  assert.strictEqual(pushCalls[0].data.type, 'flock_rsvp');

  // Eight more inside the window. This used to be eight more notifications, each
  // one destroying the last on the lock screen (they share an apns-collapse-id),
  // so the host was interrupted nine times to be told one thing.
  pushCalls = [];
  for (const uid of [8, 9, 10, 11, 12, 13, 14, 15]) {
    scriptJoin(uid);
    await call('POST', '/api/flocks/42/join'); // eslint-disable-line no-await-in-loop
    await settle(); // eslint-disable-line no-await-in-loop
  }
  assert.strictEqual(pushCalls.length, 0, 'nothing buzzes while the window is open');

  // The window closing is the second and last notification for those eight.
  await flushRsvpWindow('42');
  assert.strictEqual(pushCalls.length, 1);
  assert.strictEqual(pushCalls[0].userId, 99);
  assert.strictEqual(pushCalls[0].title, '8 more people are going');
  assert.strictEqual(pushCalls[0].body, 'Dinner');
  assert.strictEqual(pushCalls[0].data.type, 'flock_rsvp');
});

test('a window that nobody joined during sends nothing', async () => {
  const { flushRsvpWindow } = flocksRouter.__testables;
  scriptJoin(7);
  await call('POST', '/api/flocks/42/join');
  await settle();
  pushCalls = [];

  await flushRsvpWindow('42');
  assert.strictEqual(pushCalls.length, 0, 'a digest of nothing is not a notification');
});

test('a single late joiner is still named rather than counted', async () => {
  const { flushRsvpWindow } = flocksRouter.__testables;
  scriptJoin(7);
  await call('POST', '/api/flocks/42/join');
  await settle();

  pushCalls = [];
  scriptJoin(8);
  await call('POST', '/api/flocks/42/join');
  await settle();

  await flushRsvpWindow('42');
  assert.strictEqual(pushCalls.length, 1);
  assert.strictEqual(pushCalls[0].title, 'User8 is going!', 'one person is a person, not "1 more people"');
});

// ---------------------------------------------------------------------------
// 6b. The digest names a person, so the block gate has to be able to run
//
// services/pushHelper.js canNotify() only performs the block and ban lookup
// when the payload names somebody, through senderId / fromUserId / actorId. The
// immediate RSVP push has always carried fromUserId. The DIGEST printed the
// same sentence about the same person and carried nothing, so the one push in
// this app that a blocked joiner could still land on their blocker's lock
// screen was the batched one. Everything else in the RSVP path was already
// block-aware: the socket fan-out excludes blocks, and the immediate push is
// gated.
// ---------------------------------------------------------------------------
test('a one-person digest carries the joiner id, so a blocked or banned name cannot reach the host', async () => {
  const { flushRsvpWindow } = flocksRouter.__testables;
  scriptJoin(7);
  await call('POST', '/api/flocks/42/join');
  await settle();

  pushCalls = [];
  scriptJoin(8);
  await call('POST', '/api/flocks/42/join');
  await settle();

  await flushRsvpWindow('42');
  assert.strictEqual(pushCalls.length, 1);
  assert.strictEqual(pushCalls[0].title, 'User8 is going!');
  assert.strictEqual(pushCalls[0].data.fromUserId, '8',
    'the digest names User8, so pushHelper has to be told who User8 is or it cannot check the block');
});

test('a counted digest names nobody, so it carries no actor to gate on', async () => {
  const { flushRsvpWindow } = flocksRouter.__testables;
  scriptJoin(7);
  await call('POST', '/api/flocks/42/join');
  await settle();

  pushCalls = [];
  for (const uid of [8, 9, 10]) {
    scriptJoin(uid);
    await call('POST', '/api/flocks/42/join'); // eslint-disable-line no-await-in-loop
    await settle(); // eslint-disable-line no-await-in-loop
  }

  await flushRsvpWindow('42');
  assert.strictEqual(pushCalls.length, 1);
  assert.strictEqual(pushCalls[0].title, '3 more people are going');
  assert.strictEqual(pushCalls[0].data.fromUserId, undefined,
    'picking one of three members to gate on would be arbitrary; the flock gate is the honest one');
});

test('two flocks filling at once keep their own windows', async () => {
  scriptJoin(7);
  await call('POST', '/api/flocks/42/join');
  await settle();
  assert.strictEqual(pushCalls.length, 1);

  // A different flock is a different host and a different plan. Collapsing
  // across flocks would suppress a notification nobody has been sent.
  pushCalls = [];
  CURRENT_USER = { id: 8, name: 'User8', role: 'user' };
  handlers = [];
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ status: 'invited' }] }));
  on(/UPDATE flock_members SET status = 'accepted'/, () => ({ rows: [{ flock_id: 43, user_id: 8, status: 'accepted' }], rowCount: 1 }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({ rows: [] }));
  on(/FROM user_blocks/, () => ({ rows: [] }));
  on(/SELECT creator_id, name FROM flocks WHERE id = \$1/, () => ({ rows: [{ creator_id: 77, name: 'Drinks' }] }));

  await call('POST', '/api/flocks/43/join');
  await settle();
  assert.strictEqual(pushCalls.length, 1);
  assert.strictEqual(pushCalls[0].userId, 77);
});

test('a pending RSVP digest never holds the process open', () => {
  const { claimRsvpPush } = flocksRouter.__testables;
  const before = process._getActiveHandles?.().length ?? 0;
  claimRsvpPush({ io, flockId: 4242, hostId: 1, flockName: 'Dinner', joinerName: 'Bo' });
  const after = process._getActiveHandles?.().length ?? 0;
  assert.strictEqual(after, before, 'the digest timer is unrefed, or `node --test` hangs for a minute per window');
  flocksRouter.__resetBudgets();
});
