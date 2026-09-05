// Run: node --test  (from backend/)
//
// ─────────────────────────────────────────────────────────────────────────────
// THE REST SEND ROUTES ARE A TRANSPORT, NOT AN ARCHIVE
// ─────────────────────────────────────────────────────────────────────────────
//
// POST /api/flocks/:id/messages and POST /api/dm/:userId are what the socket
// client falls back to when ITS connection is down. Both persisted the row and
// then called pushIfOfflineDebounced, and that was the whole of their delivery.
//
// pushIfOfflineDebounced, by its name and by its job, notifies people who are
// OFFLINE. The sender being on a bad network says nothing about the recipient's
// connection: somebody sitting in the thread with a healthy socket is not
// offline, so they got no push, and no `new_dm` or `new_message` was ever
// emitted either. The message did not arrive. Not late, not out of order:
// not at all, until that person left the screen and came back, or their
// reconnect catch-up happened to fire.
//
// One person on a weak signal and the room went quiet for everyone else, which
// is the failure mode a fallback transport exists to prevent.
//
// These tests pin the delivery, the room it goes to, and the block filter that
// rides with it. They also pin the two smaller parity gaps found alongside it:
// the DM route did not invalidate the relationship cache the way its socket
// twin does (so typing dots on a brand new conversation sat out the 30s TTL),
// and it shipped no `reply_to` on the row it emits (so a reply delivered this
// way quoted a blank line under a blank name).
//
// No database and no real Socket.io. pool.query is a fixture dispatcher and
// `io` is a recorder.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'rest-live-delivery-test-secret';

const pool = require('../config/database');

let handlers = [];
async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = await fn(params || [], flat);
      return out === undefined ? { rows: [], rowCount: 0 } : out;
    }
  }
  throw new Error(`unscripted query: ${flat.slice(0, 160)}`);
}
pool.query = (sql, params) => dispatch(sql, params);
function on(re, fn) { handlers.push([re, fn]); }

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
let pushes = [];
pushMod.pushIfOffline = async () => ({ skipped: true, reason: 'test' });
pushMod.pushIfOfflineDebounced = async (_io, userId) => { pushes.push(userId); return { skipped: true }; };

const moderationMod = require('../utils/moderation');
moderationMod.moderateImage = async () => ({ allowed: true });

const relationships = require('../utils/relationships');

const messagesRouter = require('../routes/messages');

// A recorder in the shape Socket.io presents to a route: io.to(room).emit(...).
let emits = [];
const io = { to: (room) => ({ emit: (event, payload) => { emits.push({ room, event, payload }); } }) };

const app = express();
app.use(express.json({ limit: '8mb' }));
app.set('io', io);
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
  emits = [];
  pushes = [];
  CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
  relationships.__test.relationshipCache.clear();
});

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

// The response is sent before the delivery block runs, so a test that asserts
// on `emits` immediately after the fetch resolves is racing it. One tick of the
// event loop is enough for work that awaits only fixtures.
const settle = () => new Promise((r) => setTimeout(r, 20));

// ═════════════════════════════════════════════════════════════════════════════
// Flock chat
// ═════════════════════════════════════════════════════════════════════════════

function scriptFlockSend({ members = [2, 3], blocked = [] } = {}) {
  on(/SELECT id FROM flock_members WHERE flock_id/, () => ({ rows: [{ id: 10 }], rowCount: 1 }));
  on(/INSERT INTO messages/, (p) => ({
    rows: [{ id: 500, flock_id: p[0], sender_id: p[1], message_text: p[2], message_type: p[3] }],
    rowCount: 1,
  }));
  on(/SELECT name FROM flocks WHERE id/, () => ({ rows: [{ name: 'Friday' }], rowCount: 1 }));
  on(/SELECT user_id FROM flock_members WHERE flock_id/, () => ({
    rows: members.map((id) => ({ user_id: id })), rowCount: members.length,
  }));
  on(/blocked_id AS id FROM user_blocks|SELECT .* FROM user_blocks/, () => ({
    rows: blocked.map((id) => ({ id })), rowCount: blocked.length,
  }));
}

test('a flock message sent over REST is delivered live, not only pushed', async () => {
  scriptFlockSend();
  const res = await call('POST', '/api/flocks/7/messages', { message_text: 'running late' });
  assert.strictEqual(res.status, 201, res.text);
  await settle();

  const delivered = emits.filter((e) => e.event === 'new_message');
  assert.deepStrictEqual(
    delivered.map((e) => e.room).sort(),
    ['user:2', 'user:3'],
    'every other member gets the message on their personal room'
  );
  assert.strictEqual(delivered[0].payload.id, 500);
  assert.strictEqual(delivered[0].payload.sender_name, 'Ava');
});

test('live delivery goes to the personal room, never the flock room', async () => {
  // sockets/handlers.js fans out per member rather than broadcasting to
  // `flock:{id}`, for two reasons: a room broadcast cannot honour a mutual
  // block, and a member who has not OPENED this chat has never joined that
  // room and would receive nothing. Both reasons apply here identically.
  scriptFlockSend();
  await call('POST', '/api/flocks/7/messages', { message_text: 'hi' });
  await settle();
  assert.ok(emits.every((e) => !e.room.startsWith('flock:')), 'no room broadcast');
});

test('a blocked member is not delivered to, and is not pushed either', async () => {
  scriptFlockSend({ members: [2, 3], blocked: [3] });
  await call('POST', '/api/flocks/7/messages', { message_text: 'hi' });
  await settle();
  assert.deepStrictEqual(emits.filter((e) => e.event === 'new_message').map((e) => e.room), ['user:2']);
  assert.deepStrictEqual(pushes, [2]);
});

test('the sender is never delivered their own REST send', async () => {
  // The HTTP response IS the sender's acknowledgement, and their client
  // reconciles the optimistic bubble from it. An echo here would be a second
  // copy for a client that already has one.
  scriptFlockSend({ members: [2] });
  await call('POST', '/api/flocks/7/messages', { message_text: 'hi' });
  await settle();
  assert.ok(!emits.some((e) => e.room === 'user:1'));
});

// ═════════════════════════════════════════════════════════════════════════════
// DMs
// ═════════════════════════════════════════════════════════════════════════════

function scriptDmSend({ replyRow = null } = {}) {
  on(/SELECT 1 FROM user_blocks/, () => ({ rows: [], rowCount: 0 }));
  on(/blocked_id AS id FROM user_blocks/, () => ({ rows: [], rowCount: 0 }));
  on(/FROM friendships/, () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }));
  on(/SELECT id FROM direct_messages WHERE id = \$1/, () => ({ rows: [{ id: 5 }], rowCount: 1 }));
  on(/SELECT dm\.id, dm\.message_text, u\.name AS sender_name/, () => (
    replyRow ? { rows: [replyRow], rowCount: 1 } : { rows: [], rowCount: 0 }
  ));
  on(/INSERT INTO direct_messages/, (p) => ({
    rows: [{ id: 900, sender_id: p[0], receiver_id: p[1], message_text: p[2], reply_to_id: p[6] }],
    rowCount: 1,
  }));
}

test('a DM sent over REST reaches the recipient live', async () => {
  scriptDmSend();
  const res = await call('POST', '/api/dm/2', { message_text: 'outside' });
  assert.strictEqual(res.status, 201, res.text);
  await settle();

  const delivered = emits.filter((e) => e.event === 'new_dm');
  // Two rooms: the recipient's, and the sender's own account, whose OTHER
  // devices are the ones that need telling when one of them posted over REST
  // because its socket was down (guest and DM audit, 2026-09-05).
  assert.strictEqual(delivered.length, 2);
  const toRecipient = delivered.find((e) => e.room === 'user:2');
  assert.ok(toRecipient, 'the recipient no longer hears the message');
  const toSender = delivered.find((e) => e.room !== 'user:2');
  assert.ok(toSender && /^user:\d+$/.test(toSender.room) && toSender.room !== 'user:2',
    "the sender's account must hear its own message");
  assert.strictEqual(toRecipient.payload.id, 900);
  assert.strictEqual(toRecipient.payload.sender_name, 'Ava');
  assert.deepStrictEqual(toRecipient.payload.reactions, []);
  assert.strictEqual(toSender.payload.id, 900, 'the same row, so the client can dedupe on id');
});

test('a reply delivered over REST carries the row it quotes', async () => {
  scriptDmSend({ replyRow: { id: 5, message_text: 'where are you', sender_name: 'Ben' } });
  await call('POST', '/api/dm/2', { message_text: 'outside', reply_to_id: 5 });
  await settle();
  const delivered = emits.find((e) => e.event === 'new_dm');
  assert.deepStrictEqual(delivered.payload.reply_to, { id: 5, message_text: 'where are you', sender_name: 'Ben' });
});

test('a failed quote lookup drops the quote, never the message', async () => {
  // Decoration on the payload. The row is stored and reply_to_id is on it
  // either way, so this must not be able to turn a saved DM into a 500.
  handlers = [];
  on(/SELECT 1 FROM user_blocks/, () => ({ rows: [], rowCount: 0 }));
  on(/blocked_id AS id FROM user_blocks/, () => ({ rows: [], rowCount: 0 }));
  on(/FROM friendships/, () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }));
  on(/SELECT id FROM direct_messages WHERE id = \$1/, () => ({ rows: [{ id: 5 }], rowCount: 1 }));
  on(/SELECT dm\.id, dm\.message_text, u\.name AS sender_name/, () => { throw new Error('boom'); });
  on(/INSERT INTO direct_messages/, (p) => ({
    rows: [{ id: 900, sender_id: p[0], receiver_id: p[1], reply_to_id: p[6] }], rowCount: 1,
  }));

  const res = await call('POST', '/api/dm/2', { message_text: 'outside', reply_to_id: 5 });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(res.body.message.reply_to_id, 5);
  assert.strictEqual(res.body.message.reply_to, undefined);
});

test('the stored DM invalidates the relationship cache, as the socket twin does', async () => {
  // That row IS the relationship. Without this a first DM sent over the
  // fallback left a cached "not connected" standing for the rest of the 30s
  // TTL, so typing dots and live location stayed refused on a conversation
  // that had just started.
  const { relationshipCache } = relationships.__test;
  relationshipCache.set('1_2', { ts: Date.now(), connected: false });
  scriptDmSend();
  await call('POST', '/api/dm/2', { message_text: 'outside' });
  assert.ok(!relationshipCache.has('1_2'), 'the stale "no" is gone');
});
