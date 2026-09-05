// Run: node --test  (from backend/)
//
// UNPINNING A DM'S VENUE, and the announcement bug found underneath it.
//
// dm_pinned_venues UPSERTS on the (user1, user2) pair, so a pin could be
// REPLACED forever and never cleared: once a DM had a pinned venue that 36pt
// strip was in the conversation for good. DmDetail recorded the consequence
// honestly rather than papering over it, withholding PinStrip's Unpin
// callback because "there is no unpin anywhere in this product" and "a menu
// item that cannot unpin is the dead control DESIGN-STANDARD rule 5 bans". The
// screen was right. The door was one-way.
//
// The second half of this file is the bug that only showed up while building
// the first: PUT and the socket handler announced the same event in two
// different SHAPES, and only one of them is the shape the client parses.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'dm-unpin-test-secret';

const pool = require('../config/database');

let handlers = [];
let log = [];

async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = await fn(params || [], flat);
      return out === undefined ? { rows: [], rowCount: 0 } : out;
    }
  }
  if (/blocked_id AS id FROM user_blocks/.test(flat)) return { rows: [], rowCount: 0 };
  throw new Error(`unscripted query: ${flat.slice(0, 160)}`);
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(String(sql))) return Promise.resolve({ rows: [], rowCount: 0 });
    return dispatch(sql, params);
  },
  release: () => {},
});

const on = (re, fn) => handlers.push([re, fn]);

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => ({ skipped: true });
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true });

const messagesRouter = require('../routes/messages');

// A fake io that records what was emitted to which room, which is the whole
// point: the bug was the SHAPE of the payload, not whether one was sent.
const emitted = [];
const io = {
  to(room) {
    return { emit: (event, payload) => emitted.push({ room, event, payload }) };
  },
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api', messagesRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((r) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise((r) => {
  server.close(() => r());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  emitted.length = 0;
  CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
});

async function call(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: parsed, text };
}

/** Blocks, relationship, and the write. */
function script({ blocked = false, connected = true } = {}) {
  on(/FROM user_blocks/, () => ({ rows: blocked ? [{ id: 7 }] : [] }));
  on(/SELECT 1 WHERE EXISTS/, () => ({ rows: connected ? [{ '?column?': 1 }] : [] }));
  on(/DELETE FROM dm_pinned_venues/, () => ({ rows: [], rowCount: 1 }));
  on(/INSERT INTO dm_pinned_venues/, () => ({ rows: [], rowCount: 1 }));
}

const pinnedEvents = () => emitted.filter((e) => e.event === 'dm_venue_pinned');

// ---------------------------------------------------------------------------
// 1. The unpin
// ---------------------------------------------------------------------------

test('unpinning clears the row for the PAIR, not for the pinner', async () => {
  script();
  const res = await call('DELETE', '/api/dm/7/pinned-venue');

  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body, { venue: null });
  const del = log.find((q) => /DELETE FROM dm_pinned_venues/.test(q.sql));
  assert.match(del.sql, /WHERE user1_id = \$1 AND user2_id = \$2/);
  assert.ok(!/pinned_by/.test(del.sql),
    'a shared strip only its author can clear is one somebody can fill and walk away from');
});

test('anyone in the pair may unpin, from either side of the ordered key', async () => {
  // dmPairKey orders the pair, so the same two rows are addressed whichever
  // person asks. The delete must not depend on who pinned it.
  CURRENT_USER = { id: 9, name: 'Someone else', email_verified: true, role: 'user' };
  script();
  const res = await call('DELETE', '/api/dm/1/pinned-venue');
  assert.strictEqual(res.status, 200, res.text);
});

test('a blocked pair cannot unpin, and neither can a stranger', async () => {
  script({ blocked: true });
  assert.strictEqual((await call('DELETE', '/api/dm/7/pinned-venue')).status, 403);
  assert.strictEqual(log.filter((q) => /DELETE FROM dm_pinned_venues/.test(q.sql)).length, 0);

  handlers = []; log = [];
  script({ connected: false });
  assert.strictEqual((await call('DELETE', '/api/dm/7/pinned-venue')).status, 403);
  assert.strictEqual(log.filter((q) => /DELETE FROM dm_pinned_venues/.test(q.sql)).length, 0);
});

test('unpinning nothing is a 200, not a 404', async () => {
  // Two people tapping Unpin at once is ordinary, and the second has not made
  // a mistake.
  handlers = [];
  on(/FROM user_blocks/, () => ({ rows: [] }));
  on(/SELECT 1 WHERE EXISTS/, () => ({ rows: [{ '?column?': 1 }] }));
  on(/DELETE FROM dm_pinned_venues/, () => ({ rows: [], rowCount: 0 }));
  const res = await call('DELETE', '/api/dm/7/pinned-venue');
  assert.strictEqual(res.status, 200, res.text);
});

// ---------------------------------------------------------------------------
// 2. THE SHAPE. Both sides told, in the shape App.js actually parses.
// ---------------------------------------------------------------------------

test('the clear reaches BOTH people, addressed from each one\'s point of view', async () => {
  script();
  await call('DELETE', '/api/dm/7/pinned-venue');

  const evs = pinnedEvents();
  assert.strictEqual(evs.length, 2, 'the pin is in both conversations, so both are told');
  const rooms = evs.map((e) => e.room).sort();
  assert.deepStrictEqual(rooms, ['user:1', 'user:7']);

  /* `withUserId` is the OTHER person from each recipient's point of view, and
     App.js gates on it (`if (!isOpenDm(data.withUserId)) return`). One shared
     payload would send each person their own id and both gates would miss. */
  const toAva = evs.find((e) => e.room === 'user:1');
  const toBo = evs.find((e) => e.room === 'user:7');
  assert.strictEqual(toAva.payload.withUserId, 7);
  assert.strictEqual(toBo.payload.withUserId, 1);
  assert.strictEqual(toAva.payload.venue_name, null, 'a null name is how the strip is cleared');
});

test('the PIN announces in the same shape, which it did NOT', async () => {
  /* THE BUG THIS TEST EXISTS FOR. PUT emitted `{ userId, venue }` while
     sockets/handlers.js emits the fields FLAT beside `withUserId`, and App.js
     reads `data.withUserId` then `data.venue_name`. Against the nested payload
     the gate saw undefined, returned early, and the update was dropped: the
     REST fallback's live announcement reached nobody, which is exactly the
     case it exists for, when the socket is down. */
  script();
  const res = await call('PUT', '/api/dm/7/pinned-venue', { venue_name: 'Kome' });
  assert.strictEqual(res.status, 200, res.text);

  const evs = pinnedEvents();
  assert.strictEqual(evs.length, 2);
  for (const e of evs) {
    assert.strictEqual(e.payload.venue_name, 'Kome', 'flat, not nested under `venue`');
    assert.ok(e.payload.venue === undefined, 'the nested shape is what nothing parsed');
    assert.ok(Number.isInteger(e.payload.withUserId), 'and it carries the gate the client reads');
  }
  assert.strictEqual(evs.find((e) => e.room === 'user:1').payload.withUserId, 7);
  assert.strictEqual(evs.find((e) => e.room === 'user:7').payload.withUserId, 1);
});
