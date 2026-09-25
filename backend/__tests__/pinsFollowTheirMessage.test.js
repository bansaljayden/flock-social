// Run: node --test  (from backend/)
//
// A PIN CANNOT OUTLIVE ITS MESSAGE, AND A SECOND DEVICE'S REACTION IS NOT A
// REFUSAL.
//
// Pins (migration 068). Every pin read drops a message that was unsent or
// taken down, which is right, but the pin ROW stayed behind. Three things
// followed: nobody could see the pin to unpin it, it still counted toward the
// flock's three seats (so the flock was refused "Only 3 messages can be
// pinned" with two on screen), and nobody's pinned bar was told it had
// changed. Unsend and the moderator hide now delete the row and send the list
// again, and the ceiling counts live pins only, which also covers any row a
// failed delete or an older build left behind.
//
// Reactions. The same account reacting from two devices: the second POST
// finds the row already there and answers 400. The app rolled that back as a
// refusal and took a reaction the server kept off the screen. The 400 now
// carries a code the app can tell apart from a real refusal.
//
// No database and no real Socket.io: a scripted dispatcher and a recorder.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'pins-follow-their-message-secret';
delete process.env.VENUE_BILLING_ENABLED;

const pool = require('../config/database');

let handlers = [];
let log = [];

async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(flat)) return { rows: [], rowCount: 0 };
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = await fn(params || [], flat);
      return out === undefined ? { rows: [], rowCount: 0 } : out;
    }
  }
  throw new Error(`unscripted query: ${flat.slice(0, 160)}`);
}
pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({ query: (sql, params) => dispatch(sql, params), release: () => {} });
function on(re, fn) { handlers.push([re, fn]); }

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => ({ skipped: true });
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });

const messagesRouter = require('../routes/messages');
const adminRouter = require('../routes/admin');

let emits = [];
const io = {
  to: (room) => ({ emit: (event, payload) => { emits.push({ room, event, payload }); } }),
  in: () => ({ disconnectSockets: () => {} }),
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api', messagesRouter);
app.use('/api/admin', adminRouter);

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
  CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
});

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}

// broadcastPins runs after the response, so one turn of the loop lets it land.
const settle = () => new Promise((r) => setTimeout(r, 30));
const ran = (re) => log.filter((q) => re.test(q.sql));

const REMAINING_PIN = {
  id: 12, message_id: 40, pinned_by: 2, created_at: '2026-09-25T20:00:00Z',
  message_text: 'Door code 4411', message_type: 'text', sender_id: 2, sender_name: 'Bo',
};

/** What broadcastPins reads: the roster, the pins, the block edges, the bans. */
function scriptPinBroadcast({ members = [1, 2, 3], pins = [REMAINING_PIN] } = {}) {
  on(/^SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'$/, () => ({
    rows: members.map((id) => ({ user_id: id })),
  }));
  on(/FROM pinned_messages p/, () => ({ rows: pins }));
  on(/SELECT blocker_id, blocked_id FROM user_blocks/, () => ({ rows: [] }));
  on(/SELECT id FROM users WHERE is_banned IS TRUE/, () => ({ rows: [] }));
}

// ---------------------------------------------------------------------------
// 1. Unsend
// ---------------------------------------------------------------------------

function scriptUnsend({ pinned = true, pinDeleteFails = false } = {}) {
  on(/^UPDATE messages SET sender_deleted_at/, () => ({ rows: [{ id: 34 }], rowCount: 1 }));
  on(/^DELETE FROM pinned_messages WHERE flock_id = \$1 AND message_id = \$2/, () => {
    if (pinDeleteFails) throw new Error('pinned_messages unreadable');
    return { rows: pinned ? [{ message_id: 34 }] : [], rowCount: pinned ? 1 : 0 };
  });
  // emitToFlockExcludingBlocked, for the unsend event itself.
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({
    rows: [{ user_id: 2 }, { user_id: 3 }],
  }));
  on(/blocked_id AS id FROM user_blocks/, () => ({ rows: [] }));
  scriptPinBroadcast();
}

test('unsending a pinned message deletes its pin and sends every member the new list', async () => {
  scriptUnsend();
  const res = await call('DELETE', '/api/flocks/12/messages/34');
  assert.strictEqual(res.status, 200, res.text);
  await settle();

  const del = ran(/DELETE FROM pinned_messages/);
  assert.strictEqual(del.length, 1);
  assert.deepStrictEqual(del[0].params, [12, 34], 'scoped to this flock and this message');

  const lists = emits.filter((e) => e.event === 'flock_pins_changed');
  assert.deepStrictEqual(lists.map((e) => e.room).sort(), ['user:1', 'user:2', 'user:3']);
  for (const e of lists) {
    assert.strictEqual(e.payload.flockId, 12);
    assert.deepStrictEqual(e.payload.pins.map((p) => p.messageId), [40], 'the list without the unsent message');
  }
  // The unsend itself still goes out as before.
  assert.ok(emits.some((e) => e.event === 'flock_message_unsent' && e.room === 'user:1'));
});

test('unsending a message nobody pinned asks nothing more and announces no list', async () => {
  scriptUnsend({ pinned: false });
  const res = await call('DELETE', '/api/flocks/12/messages/34');
  assert.strictEqual(res.status, 200);
  await settle();
  assert.strictEqual(emits.filter((e) => e.event === 'flock_pins_changed').length, 0);
});

test('a pin that fails to clear never costs the unsend, which is already written', async () => {
  scriptUnsend({ pinDeleteFails: true });
  const res = await call('DELETE', '/api/flocks/12/messages/34');
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { success: true });
});

// ---------------------------------------------------------------------------
// 2. The ceiling counts live pins only
// ---------------------------------------------------------------------------

test('the three-pin ceiling counts only pins whose message is still there', async () => {
  on(/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ id: 1 }] }));
  on(/^SELECT id FROM messages WHERE id = \$1 AND flock_id = \$2/, () => ({ rows: [{ id: 5 }] }));
  on(/SELECT id FROM flocks WHERE id = \$1 FOR UPDATE/, () => ({ rows: [{ id: 7 }] }));
  on(/COUNT\(\*\)::int AS n FROM pinned_messages/, () => ({ rows: [{ n: 2 }] }));
  on(/INSERT INTO pinned_messages/, () => ({ rows: [], rowCount: 1 }));
  on(/blocked_id AS id FROM user_blocks/, () => ({ rows: [] }));
  scriptPinBroadcast();

  const res = await call('POST', '/api/flocks/7/pins', { message_id: 5 });
  assert.strictEqual(res.status, 201, res.text);

  const count = ran(/COUNT\(\*\)::int AS n FROM pinned_messages/)[0].sql;
  // The same two filters every pin read applies. A dead pin that is counted
  // is a seat nobody can see to free.
  assert.match(count, /m\.id = pinned_messages\.message_id/);
  assert.match(count, /m\.is_hidden IS NOT TRUE/);
  assert.match(count, /m\.sender_deleted_at IS NULL/);
  assert.match(count, /flock_id = \$1/);
});

// ---------------------------------------------------------------------------
// 3. A moderator's takedown
// ---------------------------------------------------------------------------

function scriptTakedown({ contentType = 'flock_message', pinnedIn = [8] } = {}) {
  on(/SELECT \* FROM content_reports WHERE id/, () => ({
    rows: [{ id: 7, content_type: contentType, content_id: 55, reported_user_id: 3, reporter_id: 4, status: 'open' }],
  }));
  on(/UPDATE (messages|direct_messages) SET is_hidden/, () => ({
    rows: [{ flock_id: contentType === 'flock_message' ? 8 : null, notify_a: null, notify_b: null, place_id: null }],
    rowCount: 1,
  }));
  on(/UPDATE content_reports SET status/, () => ({ rows: [], rowCount: 1 }));
  on(/INSERT INTO moderation_actions/, () => ({ rows: [{ id: 1 }], rowCount: 1 }));
  on(/FROM content_reports r JOIN users u/, () => ({ rows: [] }));
  on(/^DELETE FROM pinned_messages WHERE message_id = \$1/, () => ({
    rows: pinnedIn.map((id) => ({ flock_id: id })), rowCount: pinnedIn.length,
  }));
  scriptPinBroadcast({ members: [11, 12] });
}

test("hiding a pinned flock message retires its pin and sends the members' lists again", async () => {
  CURRENT_USER = { id: 99, name: 'Mod', role: 'admin' };
  scriptTakedown();
  const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  assert.strictEqual(res.status, 200, res.text);
  await settle();

  const del = ran(/DELETE FROM pinned_messages/);
  assert.strictEqual(del.length, 1);
  assert.deepStrictEqual(del[0].params, [55]);
  // After the takedown committed, never inside it: a pin that cannot be
  // cleared must not be able to stop abusive content coming down.
  const order = log.map((q) => q.sql);
  assert.ok(order.indexOf('COMMIT') < order.findIndex((s) => /DELETE FROM pinned_messages/.test(s)));

  const lists = emits.filter((e) => e.event === 'flock_pins_changed');
  assert.deepStrictEqual(lists.map((e) => e.room).sort(), ['user:11', 'user:12']);
  assert.strictEqual(lists[0].payload.flockId, 8);
});

test('a takedown of anything but a flock message touches no pins', async () => {
  CURRENT_USER = { id: 99, name: 'Mod', role: 'admin' };
  scriptTakedown({ contentType: 'dm' });
  const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  assert.strictEqual(res.status, 200, res.text);
  await settle();
  assert.strictEqual(ran(/DELETE FROM pinned_messages/).length, 0);
});

test('a restore does not delete anything', async () => {
  CURRENT_USER = { id: 99, name: 'Mod', role: 'admin' };
  scriptTakedown();
  const res = await call('PUT', '/api/admin/reports/7', { action: 'unhide' });
  assert.strictEqual(res.status, 200, res.text);
  await settle();
  assert.strictEqual(ran(/DELETE FROM pinned_messages/).length, 0);
});

test('a pin that fails to clear never turns a takedown into a failure', async () => {
  CURRENT_USER = { id: 99, name: 'Mod', role: 'admin' };
  scriptTakedown();
  handlers = handlers.filter(([re]) => !re.test('DELETE FROM pinned_messages WHERE message_id = $1'));
  on(/^DELETE FROM pinned_messages WHERE message_id = \$1/, () => { throw new Error('pinned_messages unreadable'); });
  const res = await call('PUT', '/api/admin/reports/7', { action: 'hide' });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.action, 'content_hidden');
});

// ---------------------------------------------------------------------------
// 4. A reaction the account already has
// ---------------------------------------------------------------------------

test('reacting with an emoji this account already has says so with a code, not just a sentence', async () => {
  on(/^SELECT flock_id FROM messages WHERE id = \$1/, () => ({ rows: [{ flock_id: 7 }] }));
  on(/FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, () => ({ rows: [{ id: 1 }] }));
  on(/INSERT INTO emoji_reactions/, () => ({ rows: [], rowCount: 0 }));
  const res = await call('POST', '/api/messages/40/react', { emoji: '❤️' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.code, 'ALREADY_REACTED');
  // The sentence stays for any client that only reads the words.
  assert.match(res.body.error, /Already reacted/);
  assert.strictEqual(emits.length, 0, 'nothing new happened, so nobody is told anything');
});
