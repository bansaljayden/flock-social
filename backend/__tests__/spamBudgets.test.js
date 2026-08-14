// Run: node --test  (from backend/)
//
// Per-user budgets on the endpoints that answer questions about OTHER PEOPLE,
// plus the reaction fan-out regression.
//
// Three separate abuse channels are pinned here:
//   1. POST /api/friends/request and POST /api/friends/add-by-code — both take
//      an id (a friend code IS a base36 id), confirm whether a user is behind
//      it, hand back their display name, and ring their phone.
//   2. POST /api/flocks/:id/invite — same directory read, 25 ids at a time,
//      plus a membership row and a push notification per id.
//   3. flock_reaction_added / flock_reaction_removed — a shipped feature that
//      must reach the OTHER members, not just the person who reacted.
//
// The budget assertions are written from the attacker's side: it is not enough
// that the limit exists, the refusal must be unreadable. If "you hit your
// limit" can be told apart from "no such user" by status, body, or amount of
// work done, the enumeration channel has been renamed, not closed.
//
// No database is involved: pool.query is replaced by a fixture dispatcher, and
// any query the fixture does not model is recorded and reported rather than
// answered with an empty result (which would let a test pass for the wrong
// reason).
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-for-spam-budget-tests';
delete process.env.FIREBASE_SERVICE_ACCOUNT; // keep push a no-op

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');
const { createUserBudget } = require('../utils/probeBudget');
const places = require('../utils/places');

// ── Fixtures ────────────────────────────────────────────────────────────────
// Real users are ids 1..100. Anything above that does not exist, which is what
// a directory walk is trying to find out.
const HIGHEST_REAL_USER = 100;
const AUTHED = {
  1: { id: 1, email: 'alice@example.com', name: 'Alice', role: 'user', is_banned: false, token_version: 0 },
  2: { id: 2, email: 'bob@example.com', name: 'Bob', role: 'user', is_banned: false, token_version: 0 },
  3: { id: 3, email: 'mallory@example.com', name: 'Mallory', role: 'user', is_banned: false, token_version: 0 },
};
const userRow = (id) => (Number(id) >= 1 && Number(id) <= HIGHEST_REAL_USER
  ? { id: Number(id), name: `User${id}` }
  : null);

const FLOCK_ID = 10;

let members;      // [{ user_id, status }]
let friendships;  // [{ id, requester_id, addressee_id, status }]
let dmThreads;    // [[a, b]] — pairs that have already exchanged a DM
let blocks;       // [[a, b]]
let writes;       // every mutating statement
let unknown;      // unmodelled queries
let queries;      // { sql, params }
let emitted;      // { room, event, payload }
let nextId;

function reset() {
  members = [
    { user_id: 1, status: 'accepted' },
    { user_id: 2, status: 'accepted' },
    { user_id: 3, status: 'accepted' },
  ];
  friendships = [];
  dmThreads = [];
  blocks = [];
  writes = [];
  unknown = [];
  queries = [];
  emitted = [];
  nextId = 500;
  friendsRouter.__resetBudgets();
  flocksRouter.__resetBudgets();
}

function blockedBetween(a, b) {
  return blocks.some(([x, y]) =>
    (Number(x) === Number(a) && Number(y) === Number(b)) ||
    (Number(x) === Number(b) && Number(y) === Number(a)));
}

function memberOf(userId) {
  return members.find((m) => m.user_id === Number(userId));
}

function friendshipBetween(a, b) {
  return friendships.find((f) =>
    (f.requester_id === Number(a) && f.addressee_id === Number(b)) ||
    (f.requester_id === Number(b) && f.addressee_id === Number(a)));
}

// ── Fixture-backed pool.query ───────────────────────────────────────────────
const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  queries.push({ sql, params });
  const has = (frag) => sql.includes(frag);
  if (/^(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push({ sql, params });

  // middleware/auth.js
  if (has('is_banned, token_version FROM users WHERE id = $1')) {
    const u = AUTHED[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }

  // utils/blocks.js
  if (has('FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2)')) {
    return blockedBetween(params[0], params[1])
      ? { rows: [{ '?column?': 1 }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  if (has('SELECT blocked_id AS id FROM user_blocks')) {
    const me = Number(params[0]);
    const ids = blocks
      .filter(([a, b]) => Number(a) === me || Number(b) === me)
      .map(([a, b]) => (Number(a) === me ? Number(b) : Number(a)));
    return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
  }

  // users directory
  if (has('SELECT id, name FROM users WHERE id = $1')) {
    const u = userRow(params[0]);
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }

  // friendships
  if (has('SELECT id, status, requester_id FROM friendships')) {
    const f = friendshipBetween(params[0], params[1]);
    return f
      ? { rows: [{ id: f.id, status: f.status, requester_id: f.requester_id }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  if (has('INSERT INTO friendships')) {
    friendships.push({ id: nextId++, requester_id: Number(params[0]), addressee_id: Number(params[1]), status: 'pending' });
    return { rows: [], rowCount: 1 };
  }
  if (has("UPDATE friendships SET status = 'accepted'")) {
    const f = friendships.find((x) => x.id === Number(params[0]));
    if (f) f.status = 'accepted';
    return { rows: [], rowCount: f ? 1 : 0 };
  }
  if (has("UPDATE friendships SET status = 'pending'")) {
    const f = friendships.find((x) => x.id === Number(params[2]));
    if (f) { f.status = 'pending'; f.requester_id = Number(params[0]); f.addressee_id = Number(params[1]); }
    return { rows: [], rowCount: f ? 1 : 0 };
  }

  // flocks
  if (has('SELECT id, name FROM flocks WHERE id = $1')) {
    return Number(params[0]) === FLOCK_ID
      ? { rows: [{ id: FLOCK_ID, name: 'Rooftop Friday' }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  if (has('COUNT(*)::int AS n FROM flock_members WHERE flock_id = $1')) {
    const n = members.filter((m) => m.status === 'invited' || m.status === 'accepted').length;
    return { rows: [{ n }], rowCount: 1 };
  }

  // flock creation (runs on a pooled client, same dispatcher)
  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [], rowCount: 0 };
  // Serialization taken inside those transactions. Round 16 added one to the
  // DM venue-vote toggle ('dmvote:...'), which read-then-wrote across three
  // separate pool checkouts and could leave one voter holding two votes; the
  // flock vote ('flockvote:...') has had one since round 11. Neither returns
  // anything the routes read.
  if (has('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
  if (has('INSERT INTO flocks')) {
    return { rows: [{ id: FLOCK_ID, name: params[0], creator_id: Number(params[1]) }], rowCount: 1 };
  }
  if (has('SELECT 1 FROM users WHERE id = $1')) {
    const u = userRow(params[0]);
    return { rows: u ? [{ '?column?': 1 }] : [], rowCount: u ? 1 : 0 };
  }
  // Reliability round: the create path's existence and block checks used to run
  // once PER INVITEE inside the create transaction (~75 queries at the 25-id
  // cap, with the block check borrowing a second pool connection). They are one
  // set-based query each now. The assertions in this file are unchanged — only
  // the query shape the fixture has to recognise moved.
  if (has('SELECT id FROM users WHERE id = ANY($1::int[])')) {
    const rows = (params[0] || []).map((id) => userRow(id)).filter(Boolean).map((u) => ({ id: u.id }));
    return { rows, rowCount: rows.length };
  }
  if (has('SELECT blocker_id, blocked_id FROM user_blocks')) {
    const me = Number(params[0]);
    const ids = (params[1] || []).map(Number);
    const rows = blocks
      .filter(([a, b]) =>
        (Number(a) === me && ids.includes(Number(b))) || (Number(b) === me && ids.includes(Number(a))))
      .map(([a, b]) => ({ blocker_id: Number(a), blocked_id: Number(b) }));
    return { rows, rowCount: rows.length };
  }
  if (has("SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'")) {
    const m = Number(params[0]) === FLOCK_ID ? memberOf(params[1]) : null;
    const ok = m && m.status === 'accepted';
    return { rows: ok ? [{ id: 1 }] : [], rowCount: ok ? 1 : 0 };
  }
  if (has("SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2")) {
    const rows = members
      .filter((m) => m.status === 'accepted' && m.user_id !== Number(params[1]))
      .map((m) => ({ user_id: m.user_id }));
    return { rows, rowCount: rows.length };
  }
  if (has('SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2')) {
    const m = Number(params[0]) === FLOCK_ID ? memberOf(params[1]) : null;
    return { rows: m ? [{ status: m.status }] : [], rowCount: m ? 1 : 0 };
  }
  if (has('INSERT INTO flock_members')) {
    // Two shapes now: one row per call (POST /:id/invite) and the batched
    // UNNEST insert the create path uses.
    const ids = Array.isArray(params[1]) ? params[1].map(Number) : [Number(params[1])];
    for (const id of ids) members.push({ user_id: id, status: 'invited' });
    return { rows: [], rowCount: ids.length };
  }
  if (has("UPDATE flock_members SET status = 'accepted', joined_at = NOW()")) {
    const m = memberOf(params[1]);
    if (!m || m.status === 'accepted') return { rows: [], rowCount: 0 };
    m.status = 'accepted';
    return { rows: [{ flock_id: FLOCK_ID, user_id: m.user_id, status: 'accepted' }], rowCount: 1 };
  }
  if (has("UPDATE flock_members SET status = 'declined'")) {
    const m = memberOf(params[1]);
    if (!m || m.status !== 'invited') return { rows: [], rowCount: 0 };
    m.status = 'declined';
    return { rows: [{ flock_id: FLOCK_ID, user_id: m.user_id, status: 'declined' }], rowCount: 1 };
  }
  if (has('SELECT creator_id, name FROM flocks WHERE id = $1')) {
    return { rows: [{ creator_id: 1, name: 'Rooftop Friday' }], rowCount: 1 };
  }
  if (has("UPDATE flock_members SET status = 'invited'")) {
    const m = memberOf(params[1]);
    if (m) m.status = 'invited';
    return { rows: [], rowCount: m ? 1 : 0 };
  }

  // utils/relationships.js
  if (has("SELECT 1 WHERE EXISTS ( SELECT 1 FROM friendships")) {
    const f = friendshipBetween(params[0], params[1]);
    const related = (f && f.status === 'accepted') || dmThreads.some(([a, b]) =>
      (Number(a) === Number(params[0]) && Number(b) === Number(params[1])) ||
      (Number(a) === Number(params[1]) && Number(b) === Number(params[0])));
    return related ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (has('INSERT INTO direct_messages')) {
    return { rows: [{ id: 900, sender_id: Number(params[0]), receiver_id: Number(params[1]), message_text: params[2] }], rowCount: 1 };
  }
  if (has('INSERT INTO dm_pinned_venues')) return { rows: [], rowCount: 1 };
  if (has('FROM dm_venue_votes vv JOIN users u')) return { rows: [], rowCount: 0 };
  if (has('SELECT id FROM dm_venue_votes')) return { rows: [], rowCount: 0 };
  if (has('DELETE FROM dm_venue_votes')) return { rows: [], rowCount: 0 };
  if (has('INSERT INTO dm_venue_votes')) return { rows: [], rowCount: 1 };

  // messages / reactions
  if (has('SELECT flock_id FROM messages WHERE id = $1')) {
    return Number(params[0]) === 100 ? { rows: [{ flock_id: FLOCK_ID }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (has('INSERT INTO emoji_reactions')) {
    return { rows: [{ id: 1, message_id: Number(params[0]), user_id: Number(params[1]), emoji: params[2] }], rowCount: 1 };
  }
  if (has('DELETE FROM emoji_reactions')) {
    return { rows: [{ id: 1, message_id: Number(params[0]), user_id: Number(params[1]), emoji: params[2] }], rowCount: 1 };
  }

  // utils/places.js known-venue lookup
  if (has('EXISTS (SELECT 1 FROM venue_profiles WHERE google_place_id = $1)')) {
    return { rows: [{ known: false }], rowCount: 1 };
  }

  unknown.push(sql);
  return { rows: [], rowCount: 0 };
};

// ── App under test ──────────────────────────────────────────────────────────
const friendsRouter = require('../routes/friends');
const flocksRouter = require('../routes/flocks');
const messagesRouter = require('../routes/messages');

const io = {
  // Everyone reads as OFFLINE, so the push path is exercised; with no
  // FIREBASE_SERVICE_ACCOUNT sendPushToUser is a no-op that touches nothing.
  sockets: { adapter: { rooms: { get: () => undefined } } },
  to(room) {
    return { emit: (event, payload) => { emitted.push({ room, event, payload }); } };
  },
};

// POST /api/flocks runs in a transaction on a pooled client. Same dispatcher,
// so the create path is exercised for real rather than stubbed out.
pool.connect = async () => ({ query: pool.query, release() {} });

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/friends', friendsRouter);
app.use('/api/flocks', flocksRouter);
app.use('/api', messagesRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => { pool.query = realQuery; return pool.end().catch(() => {}); });
test.beforeEach(reset);

const TOKENS = {
  alice: () => signUserToken(AUTHED[1]),
  bob: () => signUserToken(AUTHED[2]),
  mallory: () => signUserToken(AUTHED[3]),
};

function call(method, path, who, body) {
  return fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKENS[who]()}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const assertQueriesUnderstood = () =>
  assert.deepStrictEqual(unknown, [], 'test fixture did not model one of the queries the route ran');

async function waitFor(predicate, ms = 1000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return predicate();
}

// Probe a stranger. Returns { status, body, queryCount }.
async function probe(who, targetId) {
  const before = queries.length;
  const res = await call('POST', '/api/friends/request', who, { user_id: targetId });
  return { status: res.status, body: await res.json(), queryCount: queries.length - before };
}

// ── 1. Friend-request / friend-code directory budget ────────────────────────

test('a friend request to a real stranger works, inside the budget', async () => {
  const res = await probe('alice', 42);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'pending');
  assertQueriesUnderstood();
  assert.strictEqual(friendships.length, 1);
});

test('the friend-request budget cuts a directory walk off at 20 an hour', async () => {
  // 20 probes at ids that do not exist still spend the allowance: if misses
  // were free, "the answers that keep coming are the misses" would be the
  // enumeration signal all by itself.
  for (let i = 0; i < 20; i++) {
    const res = await probe('alice', 900000 + i);
    assert.strictEqual(res.status, 404, `probe ${i} should be a miss`);
  }
  assertQueriesUnderstood();

  // The 21st probe is at a user who really does exist. It must not say so.
  const real = await probe('alice', 42);
  assert.strictEqual(real.status, 404);
  assert.deepStrictEqual(real.body, { error: 'User not found' });
  assert.strictEqual(friendships.length, 0, 'no friendship row may be written past the budget');
  assert.deepStrictEqual(emitted, [], 'no notification may be sent past the budget');
});

test('exhausted and never-existed are the same answer, down to the work done', async () => {
  for (let i = 0; i < 20; i++) await probe('alice', 900000 + i);

  const exhaustedReal = await probe('alice', 42);        // exists, budget spent
  const exhaustedFake = await probe('alice', 987654);    // does not exist, budget spent

  assert.strictEqual(exhaustedReal.status, exhaustedFake.status);
  assert.deepStrictEqual(exhaustedReal.body, exhaustedFake.body);
  // Same number of statements either way: a shorter path for one of them is a
  // timing oracle, which is the same oracle measured with a stopwatch.
  assert.strictEqual(exhaustedReal.queryCount, exhaustedFake.queryCount);

  // And it matches the shape of an honest miss made with budget in hand.
  friendsRouter.__resetBudgets();
  const honestMiss = await probe('alice', 987654);
  assert.strictEqual(honestMiss.status, exhaustedReal.status);
  assert.deepStrictEqual(honestMiss.body, exhaustedReal.body);
  assert.strictEqual(honestMiss.queryCount, exhaustedReal.queryCount);
  assertQueriesUnderstood();
});

test('the budget is per account and does not follow the target', async () => {
  for (let i = 0; i < 20; i++) await probe('alice', 900000 + i);
  assert.strictEqual((await probe('alice', 42)).status, 404);

  // Bob's allowance is his own — a spent budget must not lock the app for
  // everybody, and one account's spending must not be borrowable by another.
  const bob = await probe('bob', 42);
  assert.strictEqual(bob.status, 200);
  assertQueriesUnderstood();
});

test('acting on someone you already have a friendship with never costs budget', async () => {
  friendships.push({ id: 1, requester_id: 1, addressee_id: 42, status: 'pending' });
  for (let i = 0; i < 40; i++) {
    const res = await probe('alice', 42);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'pending');
  }
  // Full allowance still available for a genuinely new person.
  const fresh = await probe('alice', 43);
  assert.strictEqual(fresh.status, 200);
  assertQueriesUnderstood();
});

test('the friend-code path shares the budget instead of doubling it', async () => {
  for (let i = 0; i < 20; i++) await probe('alice', 900000 + i);

  // FLOCK-16 is base36 for user 42, who exists.
  const code = 'FLOCK-' + (42).toString(36).toUpperCase().padStart(4, '0');
  const res = await call('POST', '/api/friends/add-by-code', 'alice', { code });
  assert.strictEqual(res.status, 404);
  assert.deepStrictEqual(await res.json(), { error: 'No user found with this code' });
  assert.strictEqual(friendships.length, 0);
  assertQueriesUnderstood();
});

test('an exhausted friend code reads exactly like a code nobody holds', async () => {
  const realCode = 'FLOCK-' + (42).toString(36).toUpperCase().padStart(4, '0');
  const deadCode = 'FLOCK-' + (99999).toString(36).toUpperCase().padStart(4, '0');

  const honestMiss = await call('POST', '/api/friends/add-by-code', 'alice', { code: deadCode });
  const honestBody = await honestMiss.json();

  for (let i = 0; i < 20; i++) await probe('alice', 900000 + i);
  const exhausted = await call('POST', '/api/friends/add-by-code', 'alice', { code: realCode });

  assert.strictEqual(exhausted.status, honestMiss.status);
  assert.deepStrictEqual(await exhausted.json(), honestBody);
  assertQueriesUnderstood();
});

test('a friend code that overflows the id column is a miss, not a 500', async () => {
  const res = await call('POST', '/api/friends/add-by-code', 'alice', { code: 'FLOCK-ZZZZZZZZZZ' });
  assert.strictEqual(res.status, 404);
  assert.deepStrictEqual(await res.json(), { error: 'No user found with this code' });
  // Nothing may have reached Postgres with an out-of-range integer.
  assert.ok(!queries.some((q) => q.params.some((p) => typeof p === 'number' && p > 2147483647)));
  assertQueriesUnderstood();
});

test('user_id as a string cannot smuggle a self-friendship past the self check', async () => {
  const res = await call('POST', '/api/friends/request', 'alice', { user_id: '1' });
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(await res.json(), { error: 'Cannot send friend request to yourself' });
  assert.strictEqual(friendships.length, 0);
});

test('an out-of-range user_id is rejected before it reaches the database', async () => {
  const res = await call('POST', '/api/friends/request', 'alice', { user_id: 9999999999 });
  assert.strictEqual(res.status, 400);
  assert.ok(!writes.length);
});

// ── 2. Flock invite spam ────────────────────────────────────────────────────

async function invite(who, ids) {
  const res = await call('POST', `/api/flocks/${FLOCK_ID}/invite`, who, { user_ids: ids });
  return { status: res.status, body: await res.json() };
}

test('inviting a handful of people still works', async () => {
  const res = await invite('alice', [40, 41, 42]);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.invited.length, 3);
  assert.strictEqual(res.body.throttled, undefined);
  assertQueriesUnderstood();
});

test('the invite budget stops a broadcast at 25 an hour', async () => {
  // 25 across two calls, then nothing.
  const first = await invite('alice', Array.from({ length: 20 }, (_, i) => 20 + i));
  assert.strictEqual(first.body.invited.length, 20);

  const second = await invite('alice', Array.from({ length: 20 }, (_, i) => 40 + i));
  assert.strictEqual(second.status, 200);
  assert.strictEqual(second.body.invited.length, 5, 'budget must cut the second call short');
  assert.strictEqual(second.body.throttled, true);

  const third = await invite('alice', [70, 71]);
  assert.strictEqual(third.status, 429);
  assert.strictEqual(members.filter((m) => m.status === 'invited').length, 25);

  // Exactly one invite notification per row actually written, no more.
  const notifications = emitted.filter((e) => e.event === 'flock_invite_received');
  assert.strictEqual(notifications.length, 25);
  assertQueriesUnderstood();
});

test('an exhausted invite call reveals nothing about the ids it refused', async () => {
  await invite('alice', Array.from({ length: 25 }, (_, i) => 20 + i));
  const realIds = await invite('alice', [50, 51]);           // both exist
  const fakeIds = await invite('alice', [900001, 900002]);   // neither exists
  assert.strictEqual(realIds.status, fakeIds.status);
  assert.deepStrictEqual(realIds.body, fakeIds.body);
  assertQueriesUnderstood();
});

test('re-inviting the same people costs nothing', async () => {
  await invite('alice', [40, 41, 42]);
  for (let i = 0; i < 15; i++) {
    const again = await invite('alice', [40, 41, 42]);
    assert.strictEqual(again.body.invited.length, 0);
  }
  // The allowance was never touched by those repeats.
  const fresh = await invite('alice', Array.from({ length: 22 }, (_, i) => 50 + i));
  assert.strictEqual(fresh.body.invited.length, 22);
  assertQueriesUnderstood();
});

test('duplicate ids in one call buy one invite, not many', async () => {
  const res = await invite('alice', [42, 42, 42, 42, 42]);
  assert.strictEqual(res.body.invited.length, 1);
  assert.strictEqual(members.filter((m) => m.user_id === 42).length, 1);
  assertQueriesUnderstood();
});

test('a flock cannot be turned into a mailing list', async () => {
  // Fill the roster to the cap, then try again.
  for (let i = 0; i < 47; i++) members.push({ user_id: 200 + i, status: 'invited' });
  assert.strictEqual(members.length, 50);

  const res = await invite('alice', [42]);
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /as many people as it can hold/);
  assertQueriesUnderstood();
});

test('the invite budget belongs to the inviter, not to the flock', async () => {
  await invite('alice', Array.from({ length: 25 }, (_, i) => 20 + i));
  assert.strictEqual((await invite('alice', [60])).status, 429);
  const bob = await invite('bob', [61]);
  assert.strictEqual(bob.status, 200);
  assert.strictEqual(bob.body.invited.length, 1);
  assertQueriesUnderstood();
});

test('a blocked user is never invited and never notified', async () => {
  blocks.push([1, 42]);
  const res = await invite('alice', [42]);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.invited.length, 0);
  assert.ok(!members.some((m) => m.user_id === 42));
  assert.deepStrictEqual(emitted.filter((e) => e.event === 'flock_invite_received'), []);
  assertQueriesUnderstood();
});

// ── 2b. The same spam through the back door: flock CREATION invites ─────────

async function createFlock(who, invitedIds) {
  const res = await call('POST', '/api/flocks', who, {
    name: 'Plans',
    ...(invitedIds ? { invited_user_ids: invitedIds } : {}),
  });
  return { status: res.status, body: await res.json() };
}

test('creating a flock with invites is not a way around the invite budget', async () => {
  // Burn the allowance through the standalone endpoint...
  await invite('alice', Array.from({ length: 25 }, (_, i) => 20 + i));
  emitted.length = 0;

  // ...then try the create path, which used to be completely unbudgeted.
  const res = await createFlock('alice', [60, 61, 62]);
  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(
    emitted.filter((e) => e.event === 'flock_invite_received'),
    [],
    'flock creation must draw on the same budget as POST /:id/invite'
  );
  assertQueriesUnderstood();
});

test('creating a flock with a fabricated invitee is not an existence oracle', async () => {
  const real = await createFlock('alice', [42]);
  const fake = await createFlock('alice', [900001]);
  assert.strictEqual(real.status, 201);
  assert.strictEqual(fake.status, 201, 'a made-up id must be skipped, not blow up the transaction');
  assert.deepStrictEqual(
    emitted.filter((e) => e.event === 'flock_invite_received').map((e) => e.room),
    ['user:42']
  );
  assertQueriesUnderstood();
});

test('an out-of-range invitee id never reaches the database', async () => {
  const res = await createFlock('alice', [9999999999]);
  assert.strictEqual(res.status, 201);
  assert.ok(!queries.some((q) => q.params.some((p) => typeof p === 'number' && p > 2147483647)));
  assertQueriesUnderstood();
});

test('duplicate invitees at creation notify once', async () => {
  await createFlock('alice', [42, 42, 42]);
  assert.strictEqual(emitted.filter((e) => e.event === 'flock_invite_received').length, 1);
  assertQueriesUnderstood();
});

// ── 3. Reaction fan-out (the shipped feature that reached nobody) ────────────

test('a reaction reaches every other member of the flock, not just the reactor', async () => {
  const res = await call('POST', '/api/messages/100/react', 'alice', { emoji: '🔥' });
  assert.strictEqual(res.status, 201);

  await waitFor(() => emitted.filter((e) => e.event === 'flock_reaction_added').length >= 3);
  const rooms = emitted.filter((e) => e.event === 'flock_reaction_added').map((e) => e.room).sort();
  assert.deepStrictEqual(rooms, ['user:1', 'user:2', 'user:3'],
    'reactions must fan out to the other members; emitting only to user:<reactor> is the bug this pins');
  assertQueriesUnderstood();
});

test('removing a reaction reaches the other members too', async () => {
  const res = await call('DELETE', '/api/messages/100/react/%F0%9F%94%A5', 'alice');
  assert.strictEqual(res.status, 200);

  await waitFor(() => emitted.filter((e) => e.event === 'flock_reaction_removed').length >= 3);
  const rooms = emitted.filter((e) => e.event === 'flock_reaction_removed').map((e) => e.room).sort();
  assert.deepStrictEqual(rooms, ['user:1', 'user:2', 'user:3']);
  assertQueriesUnderstood();
});

test('a member who blocked the reactor is left out of the fan-out', async () => {
  blocks.push([3, 1]); // Mallory blocked Alice
  const res = await call('POST', '/api/messages/100/react', 'alice', { emoji: '🔥' });
  assert.strictEqual(res.status, 201);

  await waitFor(() => emitted.filter((e) => e.event === 'flock_reaction_added').length >= 2);
  await new Promise((r) => setTimeout(r, 25));
  const rooms = emitted.filter((e) => e.event === 'flock_reaction_added').map((e) => e.room).sort();
  assert.deepStrictEqual(rooms, ['user:1', 'user:2']);
  assertQueriesUnderstood();
});

test('an RSVP reaches the host wherever they are, not just the flock screen', async () => {
  // `flock:{id}` only contains sockets sitting on that flock's screen, which is
  // exactly where the host is not when an invite comes back. Same failure the
  // guest RSVP broadcast was fixed for.
  members = [
    { user_id: 1, status: 'accepted' },
    { user_id: 3, status: 'accepted' },
    { user_id: 2, status: 'invited' },
  ];
  const res = await call('POST', `/api/flocks/${FLOCK_ID}/join`, 'bob');
  assert.strictEqual(res.status, 200);

  await waitFor(() => emitted.filter((e) => e.event === 'flock_invite_responded').length >= 2);
  const rsvps = emitted.filter((e) => e.event === 'flock_invite_responded');
  assert.deepStrictEqual(rsvps.map((e) => e.room).sort(), ['user:1', 'user:3']);
  assert.ok(!rsvps.some((e) => e.room.startsWith('flock:')), 'the flock room is not where the host is');
  assertQueriesUnderstood();
});

test('a declined invite also reaches the other members individually', async () => {
  members = [
    { user_id: 1, status: 'accepted' },
    { user_id: 2, status: 'invited' },
  ];
  const res = await call('POST', `/api/flocks/${FLOCK_ID}/decline`, 'bob');
  assert.strictEqual(res.status, 200);
  await waitFor(() => emitted.some((e) => e.event === 'flock_invite_responded'));
  assert.deepStrictEqual(
    emitted.filter((e) => e.event === 'flock_invite_responded').map((e) => e.room),
    ['user:1']
  );
  assertQueriesUnderstood();
});

test('a non-member cannot react, and learns nothing about the message', async () => {
  members = [{ user_id: 1, status: 'accepted' }];
  const res = await call('POST', '/api/messages/100/react', 'mallory', { emoji: '🔥' });
  const missing = await call('POST', '/api/messages/999/react', 'mallory', { emoji: '🔥' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(missing.status, 404);
  assert.deepStrictEqual(await res.json(), await missing.json());
  assertQueriesUnderstood();
});

// ── 3b. DM writes: the REST twins of gates the socket path already had ──────

test('a DM to a stranger is refused, and reads the same as a DM to nobody', async () => {
  const real = await call('POST', '/api/dm/42', 'alice', { message_text: 'hi' });
  const fake = await call('POST', '/api/dm/900001', 'alice', { message_text: 'hi' });
  assert.strictEqual(real.status, 403);
  assert.strictEqual(fake.status, 403);
  assert.deepStrictEqual(await real.json(), await fake.json());
  assert.ok(!writes.some((w) => w.sql.includes('INSERT INTO direct_messages')),
    'an unsolicited DM must not be stored');
  assertQueriesUnderstood();
});

test('a DM to a friend still goes through', async () => {
  friendships.push({ id: 1, requester_id: 1, addressee_id: 42, status: 'accepted' });
  const res = await call('POST', '/api/dm/42', 'alice', { message_text: 'hi' });
  assert.strictEqual(res.status, 201);
  assertQueriesUnderstood();
});

test('an existing thread keeps working even without a friendship', async () => {
  dmThreads.push([1, 42]);
  const res = await call('POST', '/api/dm/42', 'alice', { message_text: 'hi again' });
  assert.strictEqual(res.status, 201);
  assertQueriesUnderstood();
});

test('an outsider cannot overwrite what two people pinned, or learn they exist', async () => {
  const real = await call('PUT', '/api/dm/42/pinned-venue', 'alice', { venue_name: 'Pwned' });
  const fake = await call('PUT', '/api/dm/900001/pinned-venue', 'alice', { venue_name: 'Pwned' });
  assert.strictEqual(real.status, 403);
  assert.strictEqual(fake.status, 403);
  assert.deepStrictEqual(await real.json(), await fake.json());
  assert.ok(!writes.some((w) => w.sql.includes('dm_pinned_venues')));
  assertQueriesUnderstood();
});

test('an outsider cannot write DM venue votes either', async () => {
  const real = await call('POST', '/api/dm/42/venue-votes', 'alice', { venue_name: 'The Fig' });
  const fake = await call('POST', '/api/dm/900001/venue-votes', 'alice', { venue_name: 'The Fig' });
  assert.strictEqual(real.status, 403);
  assert.strictEqual(fake.status, 403);
  assert.deepStrictEqual(await real.json(), await fake.json());
  assert.ok(!writes.some((w) => w.sql.includes('dm_venue_votes')));
  assertQueriesUnderstood();
});

test('a real conversation can still pin and vote', async () => {
  friendships.push({ id: 1, requester_id: 1, addressee_id: 42, status: 'accepted' });
  const pin = await call('PUT', '/api/dm/42/pinned-venue', 'alice', { venue_name: 'The Fig' });
  const vote = await call('POST', '/api/dm/42/venue-votes', 'alice', { venue_name: 'The Fig' });
  assert.strictEqual(pin.status, 200);
  assert.strictEqual(vote.status, 200);
  assertQueriesUnderstood();
});

// ── 4. The budget primitive itself ──────────────────────────────────────────

test('a budget counts the user id, not its spelling', () => {
  const b = createUserBudget({ name: 't', hourly: 2, daily: 10 });
  assert.strictEqual(b.allow(7), true);
  assert.strictEqual(b.allow('7'), true, 'string and number ids must share one bucket');
  assert.strictEqual(b.allow(7), false);
  assert.strictEqual(b.allow('7'), false);
});

test('a budget denies an identity it cannot pin down', () => {
  const b = createUserBudget({ name: 't', hourly: 5, daily: 5 });
  for (const bad of [undefined, null, 'abc', {}, NaN]) {
    assert.strictEqual(b.allow(bad), false, `unknown identity ${String(bad)} must not get a free lane`);
  }
});

test('the daily ceiling holds even when the hourly one has room', () => {
  const b = createUserBudget({ name: 't', hourly: 100, daily: 5 });
  for (let i = 0; i < 5; i++) assert.strictEqual(b.allow(1), true);
  assert.strictEqual(b.allow(1), false);
  assert.deepStrictEqual(b.remaining(1), { hourly: 95, daily: 0 });
});

test('churning the map does not hand an attacker a fresh allowance', () => {
  // The old hand-rolled counter called clear() when it got too big, so anyone
  // able to push it over the threshold got their own counter wiped.
  const b = createUserBudget({ name: 't', hourly: 3, daily: 3, maxEntries: 50 });
  const attacker = 1;
  for (let i = 0; i < 3; i++) assert.strictEqual(b.allow(attacker), true);
  assert.strictEqual(b.allow(attacker), false);

  for (let i = 0; i < 500; i++) b.allow(1000 + i); // flood with other identities
  assert.strictEqual(b.allow(attacker), false, "the attacker's own counter must survive eviction");
});

// ── 5. The shared place-id helper ───────────────────────────────────────────

test('place id shape check accepts real ids and refuses everything else', () => {
  assert.strictEqual(places.isPlaceIdShaped('ChIJN1t_tDeuEmsRUsoyG83frY4'), true);
  assert.strictEqual(places.isPlaceIdShaped('abc-_1'), true);
  for (const bad of ['short', 'has space', 'x'.repeat(129), '', null, undefined, 42, {}, 'semi;colon']) {
    assert.strictEqual(places.isPlaceIdShaped(bad), false, `${String(bad)} must not pass`);
  }
  assert.strictEqual(places.validPlaceId, places.isPlaceIdShaped, 'checkin.js name must stay an alias');
});

test('a malformed place id never reaches SQL', async () => {
  places.clearKnownVenueCache();
  const before = queries.length;
  assert.strictEqual(await places.isKnownVenue('nope!'), false);
  assert.strictEqual(await places.isKnownVenue(null), false);
  assert.strictEqual(queries.length, before);
});

test('known-venue lookups are cached, and an unknown venue stays unknown', async () => {
  places.clearKnownVenueCache();
  queries.length = 0;
  const id = 'ChIJcachecheck0001';
  assert.strictEqual(await places.isKnownVenue(id), false); // fixture answers no rows
  const afterFirst = queries.length;
  assert.strictEqual(await places.isKnownVenue(id), false);
  assert.strictEqual(queries.length, afterFirst, 'second lookup must come from cache');
  places.clearKnownVenueCache();
});

test('a database failure means "not known", not an exception', async () => {
  places.clearKnownVenueCache();
  const saved = pool.query;
  pool.query = async () => { throw new Error('connection reset'); };
  try {
    assert.strictEqual(await places.isKnownVenue('ChIJfailclosed01'), false);
  } finally {
    pool.query = saved;
  }
  // The failure must not have been cached as a fact.
  places.clearKnownVenueCache();
});
