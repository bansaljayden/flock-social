// Run: node --test  (from backend/)
//
// Object-level authorization for flocks, memberships, invites, flock chat, DMs,
// friendships, user search and stories.
//
// This app has already shipped one IDOR of the "any authenticated user can join
// any flock by id and read its messages" kind, so these tests pin the gates
// from the attacker's side: every case is a request made by a user who has NO
// relationship to the object, asserting both the status code AND that no row
// was written / no field of someone else's data came back.
//
// No database is involved. pool.query is replaced with a fixture-backed
// dispatcher; an unrecognised query is recorded (and reported by
// assertQueriesUnderstood) rather than silently answered with zero rows, which
// would let an authorization test pass for entirely the wrong reason.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-for-object-authz-tests';

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

// ── Fixtures ────────────────────────────────────────────────────────────────
// 1 Alice   — creator + accepted member of flock 10
// 2 Bob     — invited to flock 10, has not accepted
// 3 Mallory — no relationship to flock 10 whatsoever
const USERS = {
  1: { id: 1, email: 'alice@example.com', name: 'Alice', role: 'user', is_banned: false, token_version: 0 },
  2: { id: 2, email: 'bob@example.com', name: 'Bob', role: 'user', is_banned: false, token_version: 0 },
  3: { id: 3, email: 'mallory@example.com', name: 'Mallory', role: 'user', is_banned: false, token_version: 0 },
};

const FLOCK = {
  id: 10,
  name: 'Rooftop Friday',
  creator_id: 1,
  venue_name: 'The Fig',
  venue_address: '12 Private Street',
  venue_latitude: 40.7,
  venue_longitude: -73.9,
  venue_id: 'place_secret',
  event_time: '2026-08-20T23:00:00.000Z',
  status: 'planning',
  budget_enabled: false,
  budget_ceiling: '85.00',
  budget_locked: false,
  created_at: '2026-08-13T00:00:00.000Z',
  updated_at: '2026-08-13T00:00:00.000Z',
};

let members;   // [{ user_id, status }]
let blocks;    // [[a, b]] — a blocked b
let writes;    // every mutating statement the routes issued
let unknown;   // queries the fixture did not recognise

function reset() {
  members = [
    { user_id: 1, status: 'accepted' },
    { user_id: 2, status: 'invited' },
  ];
  blocks = [];
  writes = [];
  unknown = [];
  queries.length = 0;
}

const queries = []; // { sql, params } for every statement, for shape assertions

function memberOf(userId) {
  return members.find((m) => m.user_id === Number(userId));
}

function blockedBetween(a, b) {
  return blocks.some(([x, y]) =>
    (Number(x) === Number(a) && Number(y) === Number(b)) ||
    (Number(x) === Number(b) && Number(y) === Number(a)));
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
    const u = USERS[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }

  // utils/blocks.js
  if (has('FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2)')) {
    return blockedBetween(params[0], params[1]) ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (has('SELECT blocked_id AS id FROM user_blocks')) {
    const me = Number(params[0]);
    const ids = blocks.filter(([a, b]) => Number(a) === me || Number(b) === me)
      .map(([a, b]) => (Number(a) === me ? Number(b) : Number(a)));
    return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
  }

  // ── flock membership lookups ──
  if (has('SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2')) {
    const m = Number(params[0]) === FLOCK.id ? memberOf(params[1]) : null;
    return { rows: m ? [{ status: m.status }] : [], rowCount: m ? 1 : 0 };
  }
  if (has('SELECT 1 FROM flock_members WHERE flock_id = $1 AND user_id = $2')) {
    const m = Number(params[0]) === FLOCK.id ? memberOf(params[1]) : null;
    return { rows: m ? [{ '?column?': 1 }] : [], rowCount: m ? 1 : 0 };
  }
  if (has("SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'")) {
    const m = Number(params[0]) === FLOCK.id ? memberOf(params[1]) : null;
    const ok = m && m.status === 'accepted';
    return { rows: ok ? [{ id: 1 }] : [], rowCount: ok ? 1 : 0 };
  }

  // ── the join transaction ──
  // POST /:id/join runs on a pooled client now: BEGIN, the flock row lock
  // billing reads the roster under, the UPDATE, COMMIT. The client fake below
  // routes through this dispatcher, so the bookends are answered here and the
  // lock returns the row it locked, for the flock the fixture knows.
  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [], rowCount: 0 };
  if (has('SELECT id FROM flocks WHERE id = $1 FOR UPDATE')) {
    return Number(params[0]) === FLOCK.id ? { rows: [{ id: FLOCK.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // ── flock row lookups ──
  if (/^SELECT (creator_id|id, name, creator_id|id, name|creator_id, name|creator_id, status, name|id) FROM flocks WHERE id = \$1/.test(sql)) {
    return Number(params[0]) === FLOCK.id ? { rows: [{ ...FLOCK }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (has('FROM flocks f JOIN users u ON u.id = f.creator_id')) {
    return Number(params[0]) === FLOCK.id
      ? { rows: [{ ...FLOCK, creator_name: 'Alice' }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  if (has('AS n, (SELECT COUNT(*) FROM guest_rsvps')) {
    return { rows: [{ n: 1, guests: 0 }], rowCount: 1 };
  }
  if (has('FROM flock_members fm JOIN users u ON u.id = fm.user_id')) {
    const rows = members.map((m) => ({
      id: m.user_id,
      name: USERS[m.user_id].name,
      profile_image_url: null,
      reliability_score: null,
      status: m.status,
      attendance: 'unmarked',
      joined_at: '2026-08-13T00:00:00.000Z',
    }));
    return { rows, rowCount: rows.length };
  }
  if (has('FROM guest_rsvps')) return { rows: [], rowCount: 0 };
  if (has('FROM venue_votes WHERE flock_id = $1')) return { rows: [{ voters: 0 }], rowCount: 1 };
  if (has('FROM guest_votes gv')) return { rows: [{ voters: 0 }], rowCount: 1 };
  if (has('FROM budget_submissions')) return { rows: [{ submissions: 0, n: 0 }], rowCount: 1 };

  // ── flock membership writes ──
  if (has("UPDATE flock_members SET status = 'accepted'")) {
    const m = Number(params[0]) === FLOCK.id ? memberOf(params[1]) : null;
    if (!m || m.status === 'accepted') return { rows: [], rowCount: 0 };
    m.status = 'accepted';
    return { rows: [{ flock_id: FLOCK.id, user_id: m.user_id, status: 'accepted' }], rowCount: 1 };
  }
  if (has('INSERT INTO flock_members')) return { rows: [], rowCount: 1 };
  if (has('SELECT id, name FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    return { rows: u ? [{ id: u.id, name: u.name }] : [], rowCount: u ? 1 : 0 };
  }

  // ── messages ──
  if (has('SELECT flock_id FROM messages WHERE id = $1')) {
    return Number(params[0]) === 100 ? { rows: [{ flock_id: FLOCK.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (has('FROM messages m LEFT JOIN users u')) {
    return { rows: [{ id: 100, flock_id: FLOCK.id, sender_id: 1, message_text: 'the address is 12 Private Street' }], rowCount: 1 };
  }

  // ── direct messages ──
  if (has('SELECT sender_id, receiver_id FROM direct_messages WHERE id = $1')) {
    return Number(params[0]) === 200
      ? { rows: [{ sender_id: 1, receiver_id: 2 }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  if (has('FROM direct_messages dm JOIN users u ON u.id = dm.sender_id')) {
    return { rows: [], rowCount: 0 };
  }
  if (has('UPDATE direct_messages SET read_status = TRUE')) return { rows: [], rowCount: 0 };
  if (has('INSERT INTO dm_emoji_reactions')) {
    return { rows: [{ id: 1, dm_id: params[0], user_id: params[1], emoji: params[2] }], rowCount: 1 };
  }

  // ── friendships ──
  if (has("UPDATE friendships SET status = 'accepted'")) return { rows: [], rowCount: 0 };
  if (has('DELETE FROM friendships')) return { rows: [], rowCount: 0 };

  // ── stories / user search ──
  if (has('FROM stories s')) return { rows: [], rowCount: 0 };
  if (has('FROM users WHERE name ILIKE $1')) return { rows: [], rowCount: 0 };

  unknown.push(sql);
  return { rows: [], rowCount: 0 };
};

// POST /:id/join and POST /:id/leave run on a pooled client: BEGIN, the flock
// row lock, the statement, COMMIT. Same dispatcher, so the fixture sees the
// write exactly as it sees everything else.
const realConnect = pool.connect;
pool.connect = async () => ({ query: pool.query, release() {} });

// ── App under test: the real routers, mounted the way server.js mounts them ──
const app = express();
app.use(express.json());
app.use('/api/flocks', require('../routes/flocks'));
app.use('/api', require('../routes/messages'));
app.use('/api/friends', require('../routes/friends'));
app.use('/api/users', require('../routes/users'));
app.use('/api/stories', require('../routes/stories'));

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => { pool.query = realQuery; pool.connect = realConnect; return pool.end().catch(() => {}); });

test.beforeEach(reset);

const TOKENS = {
  alice: () => signUserToken(USERS[1]),
  bob: () => signUserToken(USERS[2]),
  mallory: () => signUserToken(USERS[3]),
};

function call(method, path, who, body) {
  return fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKENS[who]()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function assertQueriesUnderstood() {
  assert.deepStrictEqual(unknown, [], 'test fixture did not model one of the queries the route ran');
}

const noWritesTo = (table) =>
  assert.ok(!writes.some((w) => w.sql.includes(table)), `unexpected write to ${table}: ${JSON.stringify(writes)}`);

// ── Flocks: reading ─────────────────────────────────────────────────────────

test('an outsider cannot read a flock by guessing its id', async () => {
  const res = await call('GET', '/api/flocks/10', 'mallory');
  assert.strictEqual(res.status, 404);
  assertQueriesUnderstood();

  // And the 404 must be indistinguishable from an id that was never issued.
  const missing = await call('GET', '/api/flocks/999999', 'mallory');
  assert.strictEqual(missing.status, 404);
  assert.deepStrictEqual(await res.json(), await missing.json());
});

test('an invitee gets the invite card only, never the flock body or the roster', async () => {
  const res = await call('GET', '/api/flocks/10', 'bob');
  assert.strictEqual(res.status, 200);
  assertQueriesUnderstood();

  const body = await res.json();
  assert.strictEqual(body.invitePreview, true);
  assert.deepStrictEqual(body.members, []);
  assert.deepStrictEqual(body.guests, []);

  // A membership row is not acceptance: none of the flock's private detail may
  // ride along on the invite card.
  for (const leaked of ['venue_address', 'venue_latitude', 'venue_longitude', 'budget_ceiling', 'creator_id']) {
    assert.strictEqual(body.flock[leaked], undefined, `invite card leaked ${leaked}`);
  }
});

test('an accepted member still gets the full flock (the gate did not overshoot)', async () => {
  const res = await call('GET', '/api/flocks/10', 'alice');
  assert.strictEqual(res.status, 200);
  assertQueriesUnderstood();

  const body = await res.json();
  assert.strictEqual(body.invitePreview, undefined);
  assert.strictEqual(body.flock.venue_address, '12 Private Street');
  assert.strictEqual(body.members.length, 2);
});

test('the roster is closed to outsiders and to invitees who have not accepted', async () => {
  for (const who of ['mallory', 'bob']) {
    const res = await call('GET', '/api/flocks/10/members', who);
    assert.strictEqual(res.status, 404, `${who} reached the roster`);
  }
  assertQueriesUnderstood();
});

// ── Flocks: the shipped IDOR ────────────────────────────────────────────────

test('an uninvited user cannot join a flock by id, and learns nothing by trying', async () => {
  const res = await call('POST', '/api/flocks/10/join', 'mallory');
  assert.strictEqual(res.status, 404);
  assertQueriesUnderstood();
  noWritesTo('flock_members');
  assert.strictEqual(memberOf(3), undefined);

  // Same answer for a flock that does not exist. When these differed (403 vs
  // 404) the pair was an oracle for enumerating every flock id in the table.
  const missing = await call('POST', '/api/flocks/999999/join', 'mallory');
  assert.strictEqual(missing.status, 404);
  assert.deepStrictEqual(await res.json(), await missing.json());
});

test('a real invitee can still accept', async () => {
  const res = await call('POST', '/api/flocks/10/join', 'bob');
  assert.strictEqual(res.status, 200);
  assertQueriesUnderstood();
  assert.strictEqual(memberOf(2).status, 'accepted');
});

test('update and delete are closed to outsiders without confirming the flock exists', async () => {
  for (const method of ['PUT', 'DELETE']) {
    const real = await call(method, '/api/flocks/10', 'mallory', method === 'PUT' ? { name: 'pwned' } : undefined);
    const fake = await call(method, '/api/flocks/999999', 'mallory', method === 'PUT' ? { name: 'pwned' } : undefined);
    assert.strictEqual(real.status, 404, `${method} leaked existence`);
    assert.strictEqual(fake.status, 404);
    assert.deepStrictEqual(await real.json(), await fake.json());
  }
  assertQueriesUnderstood();
  noWritesTo('flocks');
});

test('a member who is not the creator gets 403, not silent success', async () => {
  members[1].status = 'accepted'; // Bob accepted; still not the creator
  const res = await call('DELETE', '/api/flocks/10', 'bob');
  assert.strictEqual(res.status, 403);
  assertQueriesUnderstood();
  noWritesTo('flocks');
});

test('an outsider cannot invite anyone into a flock', async () => {
  const res = await call('POST', '/api/flocks/10/invite', 'mallory', { user_ids: [3] });
  assert.strictEqual(res.status, 403);
  assertQueriesUnderstood();
  noWritesTo('flock_members');
});

test('a non-numeric flock id is a 400, not a database error', async () => {
  for (const path of ['/api/flocks/abc/join', '/api/flocks/abc/members', '/api/flocks/abc/leave', '/api/flocks/abc/invite-link']) {
    const res = await call('POST', path, 'mallory');
    // GET-only route reached with POST would 404 at the router, so check both.
    const method = path.endsWith('/members') ? 'GET' : 'POST';
    const r = method === 'GET' ? await call('GET', path, 'mallory') : res;
    assert.strictEqual(r.status, 400, `${path} did not reject a non-numeric id`);
  }
  assertQueriesUnderstood();
});

// ── Flock chat ──────────────────────────────────────────────────────────────

test('an outsider cannot read or write a flock chat', async () => {
  const read = await call('GET', '/api/flocks/10/messages', 'mallory');
  assert.strictEqual(read.status, 403);
  assert.strictEqual((await read.json()).messages, undefined);

  const write = await call('POST', '/api/flocks/10/messages', 'mallory', { message_text: 'hi' });
  assert.strictEqual(write.status, 403);
  assertQueriesUnderstood();
  noWritesTo('INSERT INTO messages');
});

test('an invitee who has not accepted cannot read the chat either', async () => {
  const res = await call('GET', '/api/flocks/10/messages', 'bob');
  assert.strictEqual(res.status, 403);
  assertQueriesUnderstood();
});

test('reacting to a message in a flock you are not in reveals nothing about that message', async () => {
  const real = await call('POST', '/api/messages/100/react', 'mallory', { emoji: '🔥' });
  const fake = await call('POST', '/api/messages/424242/react', 'mallory', { emoji: '🔥' });
  assert.strictEqual(real.status, 404);
  assert.strictEqual(fake.status, 404);
  assert.deepStrictEqual(await real.json(), await fake.json());
  assertQueriesUnderstood();
  noWritesTo('emoji_reactions');
});

// ── Direct messages ─────────────────────────────────────────────────────────

test('a third party cannot react to somebody else\'s DM', async () => {
  const res = await call('POST', '/api/dm/messages/200/react', 'mallory', { emoji: '🔥' });
  assert.strictEqual(res.status, 403);
  assertQueriesUnderstood();
  noWritesTo('dm_emoji_reactions');
});

test('a participant can react, and the emoji is validated before it reaches the column', async () => {
  const ok = await call('POST', '/api/dm/messages/200/react', 'bob', { emoji: '🔥' });
  assert.strictEqual(ok.status, 201);

  // emoji is VARCHAR(10): the validator chain existed but nothing read its
  // result, so oversized and non-string values reached Postgres as a 500.
  const long = await call('POST', '/api/dm/messages/200/react', 'bob', { emoji: 'x'.repeat(500) });
  assert.strictEqual(long.status, 400);
  const notAString = await call('POST', '/api/dm/messages/200/react', 'bob', { emoji: { $ne: null } });
  assert.strictEqual(notAString.status, 400);

  const badId = await call('POST', '/api/dm/messages/abc/react', 'bob', { emoji: '🔥' });
  assert.strictEqual(badId.status, 400);
  assertQueriesUnderstood();
});

test('pinning a venue into a conversation requires a real venue name', async () => {
  const res = await call('PUT', '/api/dm/1/pinned-venue', 'mallory', {});
  assert.strictEqual(res.status, 400);
  const badId = await call('PUT', '/api/dm/abc/pinned-venue', 'mallory', { venue_name: 'X' });
  assert.strictEqual(badId.status, 400);
  assertQueriesUnderstood();
  noWritesTo('dm_pinned_venues');
});

test('a DM thread is always bound to the caller, never to two ids from the URL', async () => {
  const res = await call('GET', '/api/dm/1', 'mallory');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((await res.json()).messages, []);
  assertQueriesUnderstood();

  const history = queries.find((q) => q.sql.includes('FROM direct_messages dm JOIN users u ON u.id = dm.sender_id'));
  assert.ok(history, 'no DM history query ran');
  // $1 is the authenticated caller and both halves of the OR pin it, so there
  // is no shape of the request that returns a conversation the caller is not in.
  assert.strictEqual(history.params[0], 3);
  assert.match(history.sql, /\(dm\.sender_id = \$1 AND dm\.receiver_id = \$2\)/);
  assert.match(history.sql, /\(dm\.sender_id = \$2 AND dm\.receiver_id = \$1\)/);
});

// ── Friendships ─────────────────────────────────────────────────────────────

test('a pending request cannot be accepted across a block', async () => {
  blocks = [[1, 3]]; // Alice blocked Mallory after sending the request
  const res = await call('POST', '/api/friends/accept', 'mallory', { user_id: 1 });
  assert.strictEqual(res.status, 404);
  assertQueriesUnderstood();
  assert.ok(!writes.some((w) => w.sql.includes("UPDATE friendships SET status = 'accepted'")),
    'a friendship was minted across a block');
  // The stale request is cleared, so it cannot be accepted later either.
  assert.ok(writes.some((w) => w.sql.includes('DELETE FROM friendships')));
});

test('friendship status takes an integer or nothing', async () => {
  const res = await call('GET', '/api/friends/status/abc', 'mallory');
  assert.strictEqual(res.status, 400);
  assertQueriesUnderstood();
});

// ── User search ─────────────────────────────────────────────────────────────

test('search cannot be turned into a directory dump with ILIKE wildcards', async () => {
  const res = await call('GET', '/api/users/search?q=%25', 'mallory'); // q = "%"
  assert.strictEqual(res.status, 200);
  assertQueriesUnderstood();

  const q = queries.find((x) => x.sql.includes('FROM users WHERE name ILIKE $1'));
  assert.ok(q, 'no search query ran');
  // Unescaped this was '%%%', which matches every account in the table.
  assert.strictEqual(q.params[0], '%\\%%');
});

// ── Stories ─────────────────────────────────────────────────────────────────

test('the story feed is gated on friendship or shared flock, and honours blocks', async () => {
  const res = await call('GET', '/api/stories', 'mallory');
  assert.strictEqual(res.status, 200);
  assertQueriesUnderstood();

  const q = queries.find((x) => x.sql.includes('FROM stories s'));
  assert.ok(q, 'no stories query ran');
  assert.strictEqual(q.params[0], 3, 'the feed must be scoped to the caller');

  // Every grant in the WHERE clause is relationship-based, and both takedowns
  // and blocks are applied in SQL rather than after pagination.
  assert.match(q.sql, /s\.is_hidden IS NOT TRUE/);
  assert.match(q.sql, /NOT EXISTS \( SELECT 1 FROM user_blocks/);
  assert.match(q.sql, /friendships WHERE \(requester_id = \$1 OR addressee_id = \$1\) AND status = 'accepted'/);
  assert.match(q.sql, /fm2\.status = 'accepted'/);
  assert.match(q.sql, /fm1\.user_id = \$1 AND fm1\.status = 'accepted'/);
});
