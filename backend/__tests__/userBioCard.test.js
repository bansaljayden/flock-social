// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// GET /api/users/:id/card — the mini profile card (bio rotation)
// ---------------------------------------------------------------------------
// The card is the one route that serves a fact about ANOTHER user by bare id,
// so what this file pins is mostly refusals:
//
//   * exactly four fields come back — id, name, profile_image_url, bio — and
//     nothing that merely lives on the row (email, phone, is_banned, score);
//   * a block in EITHER direction is a 404, indistinguishable from a missing
//     id (sequential ids make any distinction an oracle);
//   * banned reads as deleted;
//   * a malformed or out-of-range id is a 400 before any query.
//
// No database. pool.query is a fixture dispatcher keyed on the SQL CLAUSE
// UNDER TEST (never a bare prefix — the mutation-testing lesson: a prefix
// match pins the mock, not the code), and an unrecognised statement is
// RECORDED and asserted against rather than silently answered with zero rows.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-user-bio-card';

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

// ── Cast ────────────────────────────────────────────────────────────────────
// 1 Alice   — ordinary user with a bio
// 2 Bob     — ordinary user, NO bio (column is null)
// 3 Mallory — banned
// 4 Carol   — ordinary user; block scenarios run between her and Alice
const SECRET_EMAIL = 'alice-secret@example.com';
const SECRET_PHONE = '+12025550199';

let USERS;
let blocks;   // [[blocker, blocked]]
let queries;
let unknown;

function reset() {
  USERS = {
    1: {
      id: 1, email: SECRET_EMAIL, name: 'Alice', role: 'user', email_verified: true,
      is_banned: false, token_version: 0, phone: SECRET_PHONE,
      profile_image_url: 'https://cdn.example/alice.png', bio: 'plans rooftop nights',
      interests: ['hiking'], venmo_username: null, cashapp_cashtag: null,
      zelle_identifier: null, is_premium: false,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    },
    2: {
      id: 2, email: 'bob@example.com', name: 'Bob', role: 'user', email_verified: true,
      is_banned: false, token_version: 0, phone: null,
      profile_image_url: null, bio: null,
    },
    3: {
      id: 3, email: 'mallory@example.com', name: 'Mallory', role: 'user', email_verified: true,
      is_banned: true, token_version: 0, phone: null,
      profile_image_url: null, bio: 'banned bio must never serve',
    },
    4: {
      id: 4, email: 'carol@example.com', name: 'Carol', role: 'user', email_verified: true,
      is_banned: false, token_version: 0, phone: null,
      profile_image_url: null, bio: null,
    },
  };
  blocks = [];
  queries = [];
  unknown = [];
}
reset();

const realQuery = pool.query;

async function dispatch(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  queries.push({ sql, params });
  const has = (frag) => sql.includes(frag);

  // middleware/auth.js
  if (has('is_banned, token_version FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    return { rows: u ? [{ ...u }] : [], rowCount: u ? 1 : 0 };
  }

  // The card's own SELECT — matched on its full projection, which IS the
  // clause under test: the four public fields plus the ban flag the route
  // gates on, and nothing else.
  if (has('SELECT id, name, profile_image_url, bio, is_banned FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    if (!u) return { rows: [], rowCount: 0 };
    return {
      rows: [{ id: u.id, name: u.name, profile_image_url: u.profile_image_url, bio: u.bio, is_banned: u.is_banned }],
      rowCount: 1,
    };
  }

  // utils/blocks.js isBlockedBetween — the bidirectional pair probe.
  if (has('SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2)')) {
    const [a, b] = [Number(params[0]), Number(params[1])];
    const hit = blocks.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 };
  }

  // GET /api/users/profile (the read-side check that bio joined the pick list)
  if (has('venmo_username, cashapp_cashtag, zelle_identifier, is_premium') && has('FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    if (!u) return { rows: [], rowCount: 0 };
    // Only the projected columns, the way real Postgres answers — a secret in
    // the response must have come through the route's own SELECT list.
    const cols = ['id', 'email', 'name', 'phone', 'interests', 'role', 'profile_image_url',
      'bio', 'venmo_username', 'cashapp_cashtag', 'zelle_identifier', 'is_premium',
      'created_at', 'updated_at'];
    return { rows: [Object.fromEntries(cols.map((c) => [c, u[c] === undefined ? null : u[c]]))], rowCount: 1 };
  }
  if (has("SELECT COUNT(*) FROM flock_members WHERE user_id = $1 AND status = 'accepted'")) {
    return { rows: [{ count: '2' }], rowCount: 1 };
  }

  unknown.push(sql);
  return { rows: [], rowCount: 0 };
}

pool.query = (text, params) => dispatch(text, params);

// ── App under test ──────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/users', require('../routes/users'));

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => {
  pool.query = realQuery;
  return pool.end().catch(() => {});
});
test.beforeEach(reset);

function call(path, asId) {
  return fetch(base + path, {
    headers: { Authorization: `Bearer ${signUserToken(USERS[asId])}` },
  });
}

const assertModelled = () =>
  assert.deepStrictEqual(unknown, [], 'fixture did not model a query the route ran');

// ── The card itself ─────────────────────────────────────────────────────────

test('the card is exactly id, name, profile_image_url, bio — nothing else on the row leaks', async () => {
  const res = await call('/api/users/1/card', 4);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body, {
    id: 1,
    name: 'Alice',
    profile_image_url: 'https://cdn.example/alice.png',
    bio: 'plans rooftop nights',
  });
  // Belt over the deepStrictEqual: the two secrets on the fixture row, by value.
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes(SECRET_EMAIL) && !raw.includes(SECRET_PHONE), 'a private field leaked onto the card');
  assertModelled();
});

test('a user with no bio serves null, and your own card is reachable', async () => {
  const other = await (await call('/api/users/2/card', 1)).json();
  assert.strictEqual(other.bio, null);

  const own = await call('/api/users/1/card', 1);
  assert.strictEqual(own.status, 200);
  assert.strictEqual((await own.json()).bio, 'plans rooftop nights');
  assertModelled();
});

// ── Refusals, all of them the same 404 ─────────────────────────────────────

test('a block in EITHER direction is a 404 identical to a missing user', async () => {
  const missing = await call('/api/users/999999/card', 1);
  assert.strictEqual(missing.status, 404);
  const missingBody = await missing.json();

  // Carol blocked Alice: Alice cannot pull Carol's card...
  blocks = [[4, 1]];
  const blockedByThem = await call('/api/users/4/card', 1);
  assert.strictEqual(blockedByThem.status, 404);
  assert.deepStrictEqual(await blockedByThem.json(), missingBody,
    'the blocked 404 must be indistinguishable from the missing-user 404');

  // ...and Carol cannot pull Alice's either (mutual invisibility).
  const blockedByMe = await call('/api/users/1/card', 4);
  assert.strictEqual(blockedByMe.status, 404);
  assert.deepStrictEqual(await blockedByMe.json(), missingBody);
  assertModelled();
});

test('a banned account reads as deleted', async () => {
  const res = await call('/api/users/3/card', 1);
  assert.strictEqual(res.status, 404);
  const raw = JSON.stringify(await res.json());
  assert.ok(!raw.includes('banned'), 'the refusal must not say WHY');
  assertModelled();
});

test('a malformed or out-of-range id is a 400 before any users query runs', async () => {
  for (const bad of ['abc', '0', '-5', '2147483648', '1e3']) {
    queries = [];
    const res = await call(`/api/users/${bad}/card`, 1);
    assert.strictEqual(res.status, 400, `/${bad}/card answered ${res.status}`);
    assert.ok(!queries.some((q) => q.sql.includes('bio, is_banned')),
      `id "${bad}" reached the card query`);
  }
  assertModelled();
});

// ── The read side of the bio on the caller's own profile ───────────────────

test('GET /api/users/profile now carries the bio', async () => {
  const res = await call('/api/users/profile', 1);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.user.bio, 'plans rooftop nights');
  assertModelled();
});
