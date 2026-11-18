// Run: node --test  (from backend/)
//
// A REACTION IS ONE EMOJI.
//
// The three ways to add one (POST /api/messages/:id/react, POST
// /api/dm/messages/:id/react and the dm_react socket event) took any string of
// 1-10 characters. Two things followed:
//
//   1. A word was a reaction. A blocked word sent as a message body is refused
//      by the chat screen, and the same word sent as a reaction was stored and
//      drawn as a pill under the message for every member.
//   2. Ten characters were counted the wrong way. isLength counts six ❤️ as 6
//      (it skips variation selectors and counts a surrogate pair once) and the
//      VARCHAR(10) column counts 12 code points, so the insert failed with
//      22001 and the route answered 500.
//
// And the two DELETE routes decoded a param Express had already decoded, so a
// reaction named `%` (sent as %25) threw a URIError there: another 500.
//
// No database and no real Socket.io. pool.query is a fixture dispatcher whose
// two reaction inserts measure the value the way the column does.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'reaction-emoji-only-test-secret';

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

// Push is destructured at module load by sockets/handlers.js, so it has to be
// replaced BEFORE the handlers (and the router that imports them) are required.
const pushMod = require('../services/pushHelper');
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });
pushMod.pushIfOffline = async () => ({ skipped: true });

const { registerHandlers, __resetRateLimiters } = require('../sockets/handlers');
const messagesRouter = require('../routes/messages');

let emits = [];
const io = { to: (room) => ({ emit: (event, payload) => { emits.push({ room, event, payload }); } }) };

const app = express();
app.use(express.json());
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

// emoji_reactions.emoji and dm_emoji_reactions.emoji are VARCHAR(10), which
// Postgres measures in characters: code points, not UTF-16 units.
function intoVarchar10(value) {
  if ([...value].length > 10) {
    const err = new Error('value too long for type character varying(10)');
    err.code = '22001';
    throw err;
  }
}

function script() {
  handlers = [];
  calls = [];
  emits = [];
  // Flock message 5, in flock 10, which Ava is in with Bo (2).
  on(/^SELECT flock_id FROM messages WHERE id = \$1/, () => ({ rows: [{ flock_id: 10 }], rowCount: 1 }));
  on(/^SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'/, () => ({ rows: [{ id: 1 }], rowCount: 1 }));
  on(/^INSERT INTO emoji_reactions/, (p) => {
    intoVarchar10(p[2]);
    return { rows: [{ id: 1, message_id: Number(p[0]), user_id: p[1], emoji: p[2] }], rowCount: 1 };
  });
  on(/^SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2/, () => ({ rows: [{ user_id: 2 }], rowCount: 1 }));
  on(/FROM user_blocks/, () => ({ rows: [], rowCount: 0 }));
  on(/^DELETE FROM emoji_reactions/, () => ({ rows: [], rowCount: 0 }));
  // DM 5, from Ava to Cy (7).
  on(/^SELECT sender_id, receiver_id FROM direct_messages/, () => ({ rows: [{ sender_id: 1, receiver_id: 7 }], rowCount: 1 }));
  on(/^SELECT 1 FROM users WHERE id = \$1 AND is_banned IS TRUE/, () => ({ rows: [], rowCount: 0 }));
  on(/SELECT 1 WHERE EXISTS/, () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }));
  on(/^INSERT INTO dm_emoji_reactions/, (p) => {
    intoVarchar10(p[2]);
    return { rows: [{ id: 1, dm_id: p[0], user_id: p[1], emoji: p[2] }], rowCount: 1 };
  });
  on(/^DELETE FROM dm_emoji_reactions/, () => ({ rows: [], rowCount: 0 }));
}

function fakeSocket(user) {
  const socketHandlers = new Map();
  const emitted = [];
  return {
    id: 's1',
    user,
    rooms: new Set(),
    handshake: null, // no handshake => the session watchdog timer stays off
    on(event, handler) { socketHandlers.set(event, handler); },
    join() {},
    leave() {},
    emit(event, payload) { emitted.push({ target: 'self', event, payload }); },
    to(room) {
      const op = {
        except() { return op; },
        emit(event, payload) { emitted.push({ target: room, event, payload }); },
      };
      return op;
    },
    disconnect() {},
    handlers: socketHandlers,
    emitted,
  };
}

function connect() {
  __resetRateLimiters();
  const socketIo = {
    emitted: [],
    sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
    to(room) {
      const op = {
        except() { return op; },
        emit(event, payload) { socketIo.emitted.push({ room, event, payload }); },
      };
      return op;
    },
  };
  const socket = fakeSocket({ id: 1, name: 'Ava' });
  registerHandlers(socketIo, socket);
  socket.emitted.length = 0;
  return { socketIo, socket };
}

const fire = (socket, event, ...args) => socket.handlers.get(event)(...args);
const inserts = (table) => calls.filter((c) => new RegExp(`^INSERT INTO ${table}`).test(c.sql));

// One of the five words the chat screen refuses, and a word it does not.
const SLUR = 'faggot';
const WORDS = [SLUR, 'lol', 'x'];

test('a word is not a reaction, on any of the three ways to add one', async () => {
  for (const word of WORDS) {
    script();
    const flock = await call('POST', '/api/messages/5/react', { emoji: word });
    assert.strictEqual(flock.status, 400, `flock reaction ${JSON.stringify(word)}: ${flock.text}`);
    const dm = await call('POST', '/api/dm/messages/5/react', { emoji: word });
    assert.strictEqual(dm.status, 400, `DM reaction ${JSON.stringify(word)}: ${dm.text}`);
    const { socketIo, socket } = connect();
    await fire(socket, 'dm_react', { dmId: 5, emoji: word });

    assert.strictEqual(inserts('emoji_reactions').length, 0, 'the flock reaction was stored');
    assert.strictEqual(inserts('dm_emoji_reactions').length, 0, 'the DM reaction was stored');
    assert.deepStrictEqual(emits, [], 'a REST reaction was announced');
    assert.deepStrictEqual(socket.emitted, [], 'the socket reaction reached the counterpart');
    assert.deepStrictEqual(socketIo.emitted, [], "the socket reaction reached the reactor's devices");
  }
});

test('six hearts are a 400 before the insert, not a 500 from the column', async () => {
  const hearts = '❤️'.repeat(6); // 12 code points
  script();
  const flock = await call('POST', '/api/messages/5/react', { emoji: hearts });
  assert.strictEqual(flock.status, 400, flock.text);
  const dm = await call('POST', '/api/dm/messages/5/react', { emoji: hearts });
  assert.strictEqual(dm.status, 400, dm.text);
  const { socket } = connect();
  await fire(socket, 'dm_react', { dmId: 5, emoji: hearts });
  assert.strictEqual(inserts('emoji_reactions').length + inserts('dm_emoji_reactions').length, 0);
});

test('every emoji the app offers still lands, and so do skin tones, joined emoji and flags', async () => {
  // ChatDetail.js and App.js offer the first four; the rest are what a
  // reaction already stored on another client can be tapped to repeat.
  const offered = ['❤️', '👍', '😂', '🔥'];
  const others = ['👍🏽', '👨‍👩‍👧‍👦', '🏳️‍🌈', '🇺🇸', '1️⃣', '👩🏽‍❤️‍💋‍👨🏻'];
  for (const emoji of [...offered, ...others]) {
    script();
    const flock = await call('POST', '/api/messages/5/react', { emoji });
    assert.strictEqual(flock.status, 201, `flock reaction ${emoji}: ${flock.text}`);
    assert.strictEqual(inserts('emoji_reactions')[0].params[2], emoji);
    const dm = await call('POST', '/api/dm/messages/5/react', { emoji });
    assert.strictEqual(dm.status, 201, `DM reaction ${emoji}: ${dm.text}`);
    assert.strictEqual(inserts('dm_emoji_reactions')[0].params[2], emoji);
    const { socket } = connect();
    await fire(socket, 'dm_react', { dmId: 5, emoji });
    assert.strictEqual(inserts('dm_emoji_reactions').length, 2, `socket reaction ${emoji} was not stored`);
    assert.ok(socket.emitted.some((e) => e.target === 'user:7' && e.event === 'dm_reaction_added' && e.payload.emoji === emoji));
  }
});

test('removing a reaction named % is a 404, not a URIError', async () => {
  script();
  const flock = await call('DELETE', '/api/messages/5/react/%25');
  assert.strictEqual(flock.status, 404, flock.text);
  const dm = await call('DELETE', '/api/dm/messages/5/react/%25');
  assert.strictEqual(dm.status, 404, dm.text);
  const asked = calls.filter((c) => /^DELETE FROM (dm_)?emoji_reactions/.test(c.sql));
  assert.deepStrictEqual(asked.map((c) => c.params[2]), ['%', '%'], 'the param is decoded once, by Express');
});

test('removing a joined emoji asks for all of it, as the add stored it', async () => {
  // 7 code points, 11 UTF-16 units: a UTF-16 slice to 10 cut its last person
  // in half, so the DELETE matched nothing and the reaction stayed.
  const family = '👨‍👩‍👧‍👦';
  script();
  await call('DELETE', `/api/messages/5/react/${encodeURIComponent(family)}`);
  await call('DELETE', `/api/dm/messages/5/react/${encodeURIComponent(family)}`);
  const asked = calls.filter((c) => /^DELETE FROM (dm_)?emoji_reactions/.test(c.sql));
  assert.deepStrictEqual(asked.map((c) => c.params[2]), [family, family]);
});
