// Run: node --test  (from backend/)
//
// A BAN THAT LANDS WHILE A FLOCK PHOTO IS BEING SCREENED STOPS THE PHOTO.
//
// Both flock send paths (send_message on the socket, POST
// /api/flocks/:id/messages over REST) check the sender once, at the top, and
// then wait on moderateImage, a Cloud Vision call that can take seconds. A ban
// written in that time changed nothing: the row was stored and fanned out to
// every member, from an account that no longer exists in the app. A ban
// disconnects the banned account's sockets and refuses its next request, but a
// handler already running carries on.
//
// The DM paths already ask again after the screen (isBlockedOrBannedBetween in
// send_dm and in POST /api/dm/:userId). These pin the flock twins: the sender's
// ban is read again after the screen, and a banned sender is answered the way
// a banned account is answered everywhere else, with nothing stored and nothing
// delivered. A text send waits on nothing, so it does not ask.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'flock-photo-ban-during-screen-secret';

const pool = require('../config/database');

let handlers = [];
let calls = [];
async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  calls.push({ sql: flat, params: params || [] });
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
authMod.authenticate = (req, _res, next) => { req.user = { id: 1, name: 'Ava', email_verified: true, role: 'user' }; next(); };

// Push and image moderation are destructured at module load by
// sockets/handlers.js and routes/messages.js, so both are replaced first.
const pushMod = require('../services/pushHelper');
let pushes = [];
pushMod.pushIfOffline = async () => ({ skipped: true });
pushMod.pushIfOfflineDebounced = async (_io, userId) => { pushes.push(userId); return { skipped: true }; };

// The screen is where the ban lands: while it runs, a moderator bans Ava.
let banDuringScreen = false;
let banned = false;
const moderationMod = require('../utils/moderation');
moderationMod.moderateImage = async () => {
  if (banDuringScreen) banned = true;
  return { allowed: true, reason: null };
};

const { registerHandlers, __resetRateLimiters } = require('../sockets/handlers');
const messagesRouter = require('../routes/messages');

let emits = [];
const io = {
  sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
  to: (room) => {
    const op = {
      except() { return op; },
      emit: (event, payload) => { emits.push({ room, event, payload }); },
    };
    return op;
  },
};

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

// The REST route answers before it delivers; one tick lets the delivery run.
const settle = () => new Promise((r) => setTimeout(r, 20));

const PHOTO = `data:image/jpeg;base64,${'A'.repeat(2000)}`;
// What the auth middleware answers a banned account's request with.
const SUSPENDED = 'This account has been suspended for violating our community guidelines.';

// Flock 7: Ava (1) and Bo (2).
function script({ duringScreen }) {
  handlers = [];
  calls = [];
  emits = [];
  pushes = [];
  banned = false;
  banDuringScreen = duringScreen;
  on(/^SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'/, () => ({ rows: [{ id: 10 }], rowCount: 1 }));
  on(/^SELECT 1 FROM users WHERE id = \$1 AND is_banned IS TRUE/, (p) => (
    banned && Number(p[0]) === 1 ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
  ));
  on(/^INSERT INTO messages/, (p) => ({
    rows: [{ id: 500, flock_id: Number(p[0]), sender_id: p[1], message_text: p[2], message_type: p[3], image_url: p[5], thumb_url: p[6] }],
    rowCount: 1,
  }));
  on(/^SELECT name FROM flocks WHERE id/, () => ({ rows: [{ name: 'Friday' }], rowCount: 1 }));
  on(/^SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'/, () => ({ rows: [{ user_id: 2 }], rowCount: 1 }));
  on(/FROM user_blocks/, () => ({ rows: [], rowCount: 0 }));
}

const inserted = () => calls.filter((c) => /^INSERT INTO messages/.test(c.sql));
const askedBan = () => calls.filter((c) => /^SELECT 1 FROM users WHERE id = \$1 AND is_banned IS TRUE/.test(c.sql));

function fakeSocket(user) {
  const socketHandlers = new Map();
  const emitted = [];
  const socket = {
    id: 's1',
    user,
    rooms: new Set(),
    handshake: null, // no handshake => the session watchdog timer stays off
    on(event, handler) { socketHandlers.set(event, handler); },
    join() {},
    leave() {},
    emit(event, payload) { emitted.push({ event, payload }); },
    to(room) {
      const op = {
        except() { return op; },
        emit(event, payload) { emits.push({ room, event, payload }); },
      };
      return op;
    },
    disconnect() { socket.disconnected = true; },
    handlers: socketHandlers,
    emitted,
  };
  return socket;
}

function connect() {
  __resetRateLimiters();
  const socket = fakeSocket({ id: 1, name: 'Ava' });
  registerHandlers(io, socket);
  socket.emitted.length = 0;
  emits = [];
  return socket;
}

test('REST: a ban during the photo screen stores nothing and delivers nothing', async () => {
  script({ duringScreen: true });
  const res = await call('POST', '/api/flocks/7/messages', { image_url: PHOTO });
  await settle();
  assert.strictEqual(res.status, 403, res.text.slice(0, 200));
  assert.strictEqual(res.body.error, SUSPENDED);
  assert.strictEqual(inserted().length, 0, 'the photo was stored');
  assert.deepStrictEqual(emits.filter((e) => e.event === 'new_message'), [], 'the photo went out live');
  assert.deepStrictEqual(pushes, [], 'the photo was pushed');
});

test('REST: with no ban, the photo is asked about once and goes out as before', async () => {
  script({ duringScreen: false });
  const res = await call('POST', '/api/flocks/7/messages', { image_url: PHOTO });
  await settle();
  assert.strictEqual(res.status, 201, res.text.slice(0, 200));
  assert.strictEqual(askedBan().length, 1);
  assert.strictEqual(inserted().length, 1);
  assert.ok(emits.some((e) => e.event === 'new_message' && e.room === 'user:2'));
});

test('REST: a text send waits on no screen and does not ask', async () => {
  script({ duringScreen: false });
  const res = await call('POST', '/api/flocks/7/messages', { message_text: 'running late' });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(askedBan().length, 0);
});

test('socket: a ban during the photo screen stores nothing, delivers nothing and ends the session', async () => {
  script({ duringScreen: true });
  const socket = connect();
  await socket.handlers.get('send_message')({ flockId: 7, image_url: PHOTO, message_type: 'image' });
  assert.strictEqual(inserted().length, 0, 'the photo was stored');
  assert.deepStrictEqual(emits.filter((e) => e.event === 'new_message'), [], 'the photo went out live');
  assert.ok(!socket.emitted.some((e) => e.event === 'new_message'), 'the sender was handed the row');
  assert.deepStrictEqual(pushes, []);
  // A banned account's socket is answered this way by the session check.
  assert.deepStrictEqual(socket.emitted.find((e) => e.event === 'session_revoked')?.payload, { reason: 'account_suspended' });
  assert.strictEqual(socket.disconnected, true);
});

test('socket: with no ban, the photo goes out as before', async () => {
  script({ duringScreen: false });
  const socket = connect();
  await socket.handlers.get('send_message')({ flockId: 7, image_url: PHOTO, message_type: 'image' });
  assert.strictEqual(askedBan().length, 1);
  assert.strictEqual(inserted().length, 1);
  assert.ok(emits.some((e) => e.event === 'new_message' && e.room === 'user:2'));
  assert.ok(!socket.disconnected);
});
