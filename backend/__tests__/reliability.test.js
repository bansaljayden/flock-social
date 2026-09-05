// Run: node --test  (from backend/)
//
// Reliability round — the things that do not break until there is traffic.
//
// Six independent failures are pinned here:
//
//   1. migrations/013 — five sequential scans on the tables that actually grow
//      (messages.sender_id on every profile open AND inside the account-deletion
//      transaction; flocks.venue_id on the unauthenticated NFC path;
//      flocks(status, event_time) every 15 minutes forever; venue_feedback per
//      user while an advisory lock is held; venue_votes.venue_id).
//   2. POST /api/dm/:userId/venue-votes — read, delete, insert as three
//      autocommit statements. The socket twin was fixed for exactly this; the
//      REST path raced itself AND the socket path.
//   3. server.js — no unhandledRejection handler (Node's default is to kill the
//      process), and an unconditional UPDATE that resurrected stock demo photos
//      as real friends' stories on every production boot.
//   4. venue-dashboard reviews — every review ever written loaded to average
//      five integers, and a public rating computed over a 50-row window.
//   5. POST /api/flocks — up to three queries PER INVITEE inside the create
//      transaction, ~75 at the documented cap.
//   6. POST /api/budget/:flockId/remind — an in-memory cooldown map that never
//      shed an entry, with a check-then-set race across the whole push fan-out.
//
// No database: pool.query is a fixture dispatcher. Unmodelled queries are
// recorded and reported rather than answered with an empty result, which would
// let a test pass for the wrong reason.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'reliability-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT; // keep push a no-op

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');
const { splitStatements } = require('../db/migrate');

const BACKEND = path.join(__dirname, '..');
const MIGRATIONS = path.join(BACKEND, 'migrations');

// ── Fixtures ────────────────────────────────────────────────────────────────

const AUTHED = {
  1: { id: 1, email: 'alice@example.com', name: 'Alice', role: 'user', is_banned: false, token_version: 0 },
  2: { id: 2, email: 'bob@example.com', name: 'Bob', role: 'user', is_banned: false, token_version: 0 },
};
const HIGHEST_REAL_USER = 100;

const FLOCK_ID = 10;
const PLACE_ID = 'ChIJreliability0000000000';

let dmVotes;      // dm_venue_votes rows
let reviews;      // venue_reviews rows
let blocks;       // [[a, b]]
let friendships;  // [[a, b]] accepted
let queries;      // { sql, params }
let unknown;      // unmodelled queries
let txQueries;    // queries issued on a pooled client (the transaction paths)
let locksHeld;    // advisory lock key -> promise chain tail
let nextRowId;
let failNextVoteInsert; // forces a mid-transaction failure

function reset() {
  failNextVoteInsert = false;
  dmVotes = [];
  reviews = [];
  blocks = [];
  friendships = [[1, 2]];
  queries = [];
  unknown = [];
  txQueries = [];
  locksHeld = new Map();
  nextRowId = 1;
  budgetRouter.__resetReminderCooldowns();
}

function blockedBetween(a, b) {
  return blocks.some(([x, y]) =>
    (Number(x) === Number(a) && Number(y) === Number(b)) ||
    (Number(x) === Number(b) && Number(y) === Number(a)));
}

// A real pg_advisory_xact_lock serializes holders of the same key until the
// transaction ends. The fixture does the same with a promise chain, so an
// interleaving test measures the LOCK, not the fixture's willingness to run two
// things at once.
function acquireFixtureLock(key) {
  const prev = locksHeld.get(key) || Promise.resolve();
  let release;
  const held = new Promise((r) => { release = r; });
  locksHeld.set(key, prev.then(() => held));
  return prev.then(() => release);
}

// ── Fixture-backed pool.query ───────────────────────────────────────────────

const realQuery = pool.query;
const realConnect = pool.connect;

async function dispatch(text, params = [], sink) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  const rec = { sql, params };
  queries.push(rec);
  if (sink) sink.push(rec);
  const has = (frag) => sql.includes(frag);

  // middleware/auth.js
  if (has('is_banned, token_version FROM users WHERE id = $1')) {
    const u = AUTHED[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }

  // utils/blocks.js — isBlockedBetween
  if (has('FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2)')) {
    return blockedBetween(params[0], params[1])
      ? { rows: [{ '?column?': 1 }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  // routes/flocks.js — batched block lookup
  if (has('SELECT blocker_id, blocked_id FROM user_blocks')) {
    const me = Number(params[0]);
    const ids = (params[1] || []).map(Number);
    const rows = blocks
      .filter(([a, b]) =>
        (Number(a) === me && ids.includes(Number(b))) || (Number(b) === me && ids.includes(Number(a))))
      .map(([a, b]) => ({ blocker_id: Number(a), blocked_id: Number(b) }));
    return { rows, rowCount: rows.length };
  }

  // utils/relationships.js — hasDmRelationship
  if (has("FROM friendships WHERE status = 'accepted'")) {
    const [a, b] = params.map(Number);
    const connected = friendships.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
    return connected ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // ── dm_venue_votes ────────────────────────────────────────────────────────
  if (has('pg_advisory_xact_lock')) {
    // The route builds the key from the SQL text plus its params; both are part
    // of the identity, so the fixture keys on both.
    return { rows: [{ pg_advisory_xact_lock: '' }], rowCount: 0, __lockKey: `${sql}|${params.join(':')}` };
  }
  if (has('SELECT id FROM dm_venue_votes WHERE user1_id')) {
    const [u1, u2, uid, name] = params;
    const rows = dmVotes.filter((v) =>
      v.user1_id === u1 && v.user2_id === u2 && v.user_id === uid && v.venue_name === name);
    return { rows, rowCount: rows.length };
  }
  if (has('DELETE FROM dm_venue_votes')) {
    const [u1, u2, uid] = params;
    const before = dmVotes.length;
    dmVotes = dmVotes.filter((v) =>
      !(v.user1_id === u1 && v.user2_id === u2 && v.user_id === uid));
    return { rows: [], rowCount: before - dmVotes.length };
  }
  if (has('INSERT INTO dm_venue_votes')) {
    const [u1, u2, uid, name, vid] = params;
    if (failNextVoteInsert) { failNextVoteInsert = false; throw new Error('simulated write failure'); }
    // The real table has UNIQUE(user1_id, user2_id, user_id, venue_name).
    if (dmVotes.some((v) => v.user1_id === u1 && v.user2_id === u2 && v.user_id === uid && v.venue_name === name)) {
      const e = new Error('duplicate key value violates unique constraint "dm_venue_votes_user1_id_user2_id_user_id_venue_name_key"');
      e.code = '23505';
      throw e;
    }
    dmVotes.push({ id: nextRowId++, user1_id: u1, user2_id: u2, user_id: uid, venue_name: name, venue_id: vid });
    return { rows: [], rowCount: 1 };
  }
  if (has('FROM dm_venue_votes vv JOIN users u')) {
    const [u1, u2] = params;
    const mine = dmVotes.filter((v) => v.user1_id === u1 && v.user2_id === u2);
    return { rows: mine.map((v) => ({ venue_name: v.venue_name, venue_id: v.venue_id, vote_count: '1', voters: ['Alice'] })) };
  }

  // ── venue dashboard ───────────────────────────────────────────────────────
  if (has('FROM venue_profiles WHERE user_id = $1')) {
    return { rows: [{ id: 1, google_place_id: PLACE_ID, verified: true }], rowCount: 1 };
  }
  if (has('AS r5')) {
    const all = reviews;
    const dist = [1, 2, 3, 4, 5].map((n) => all.filter((r) => r.rating === n).length);
    return {
      rows: [{
        total: all.length,
        average: all.length ? all.reduce((s, r) => s + r.rating, 0) / all.length : null,
        r1: dist[0], r2: dist[1], r3: dist[2], r4: dist[3], r5: dist[4],
      }],
    };
  }
  if (has('COUNT(*)::int AS total, AVG(vr.rating)::float AS average')) {
    const all = reviews;
    return {
      rows: [{
        total: all.length,
        average: all.length ? all.reduce((s, r) => s + r.rating, 0) / all.length : null,
      }],
    };
  }
  if (has('FROM venue_reviews vr JOIN users u')) {
    // LIMIT is always the LAST parameter on both review list queries.
    const limit = Number(params[params.length - 1]);
    assert.ok(Number.isInteger(limit) && limit > 0, 'review list must be bounded by a LIMIT parameter');
    // The keyset cursor, when the route sent one: the two parameters before
    // the LIMIT, compared the way (created_at, id) < ($a, $b) compares.
    let pool_ = reviews;
    if (has('(vr.created_at, vr.id) <')) {
      const at = params[params.length - 3];
      const id = Number(params[params.length - 2]);
      pool_ = reviews.filter((r) => r.created_at < at || (r.created_at === at && r.id < id));
    }
    return { rows: pool_.slice(0, limit) };
  }

  // ── flocks create ─────────────────────────────────────────────────────────
  if (has('INSERT INTO flocks')) {
    return { rows: [{ id: FLOCK_ID, name: params[0], creator_id: params[1] }], rowCount: 1 };
  }
  if (has('SELECT id FROM users WHERE id = ANY($1::int[])')) {
    const ids = (params[0] || []).map(Number).filter((n) => n >= 1 && n <= HIGHEST_REAL_USER);
    return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
  }
  if (has('INSERT INTO flock_members')) {
    return { rows: [], rowCount: 1 };
  }

  // ── budget remind ─────────────────────────────────────────────────────────
  // /remind now checks membership before it reads the flock, the way GET
  // /:flockId and /submit always did, so that a stranger cannot tell a real
  // flock id from a fake one by its refusal. Alice is the creator here, and a
  // creator is always an accepted member (routes/flocks.js inserts the row on
  // create, and a creator leaving deletes the flock), so this answers yes.
  if (has("FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'")) {
    return { rows: [{ id: 1 }], rowCount: 1 };
  }
  if (has('SELECT creator_id, name, budget_enabled, budget_locked FROM flocks')) {
    return { rows: [{ creator_id: 1, name: 'Dinner', budget_enabled: true, budget_locked: false }], rowCount: 1 };
  }
  if (has('FROM flock_members fm JOIN users u ON u.id = fm.user_id')) {
    return { rows: [{ id: 2, name: 'Bob' }], rowCount: 1 };
  }

  unknown.push(sql);
  return { rows: [], rowCount: 0 };
}

pool.query = (text, params) => dispatch(text, params, null);

// A pooled client. BEGIN/COMMIT/ROLLBACK are recorded, and an advisory lock
// really blocks other clients holding the same key until this client's
// transaction ends — which is what pg_advisory_XACT_lock means.
pool.connect = async () => {
  const own = [];
  let releaseLock = null;
  return {
    async query(text, params) {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
        const rec = { sql, params: null };
        queries.push(rec);
        own.push(rec);
        txQueries.push(rec);
        if (/^(COMMIT|ROLLBACK)/i.test(sql) && releaseLock) { releaseLock(); releaseLock = null; }
        return { rows: [] };
      }
      if (sql.includes('pg_advisory_xact_lock')) {
        const rec = { sql, params };
        queries.push(rec);
        own.push(rec);
        txQueries.push(rec);
        releaseLock = await acquireFixtureLock(`${sql}|${(params || []).join(':')}`);
        return { rows: [{}] };
      }
      const res = await dispatch(text, params, txQueries);
      own.push({ sql, params });
      return res;
    },
    release() {
      if (releaseLock) { releaseLock(); releaseLock = null; }
    },
    __own: own,
  };
};

// ── App under test ──────────────────────────────────────────────────────────

const messagesRouter = require('../routes/messages');
const flocksRouter = require('../routes/flocks');
const budgetRouter = require('../routes/budget');
const venueDashboardRouter = require('../routes/venueDashboard');

const io = {
  sockets: { adapter: { rooms: { get: () => undefined } } },
  to() { return { emit() {} }; },
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/flocks', flocksRouter);
app.use('/api/budget', budgetRouter);
app.use('/api/venue-dashboard', venueDashboardRouter);
app.use('/api', messagesRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => {
  pool.query = realQuery;
  pool.connect = realConnect;
  return pool.end().catch(() => {});
});
test.beforeEach(reset);

const TOKENS = {
  alice: () => signUserToken(AUTHED[1]),
  bob: () => signUserToken(AUTHED[2]),
};

function call(method, pathname, who, body) {
  return fetch(base + pathname, {
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

// ── 1. Migration 013: the missing indexes ───────────────────────────────────

const M013 = '013_reliability_indexes.sql';
const m013Sql = fs.readFileSync(path.join(MIGRATIONS, M013), 'utf8');

// The file's own prose mentions CREATE INDEX CONCURRENTLY, and splitStatements
// keeps leading comments attached to the statement they precede — so every
// classification below runs on the code with comments removed.
const stripSqlComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
const m013Statements = splitStatements(m013Sql).map((s) => stripSqlComments(s).replace(/\s+/g, ' ').trim());

test('013 declares @noTransaction — CREATE INDEX CONCURRENTLY cannot run in a transaction block', () => {
  assert.ok(
    m013Sql.trimStart().startsWith('-- @noTransaction'),
    'the directive must be on the FIRST line or db/migrate.js runs the file in one transaction and every CONCURRENTLY build fails'
  );
});

test('013 covers exactly the five scans, all CONCURRENTLY and all idempotent', () => {
  const normalized = m013Statements.filter((s) => /^CREATE\s+INDEX/i.test(s));
  assert.strictEqual(normalized.length, 5, 'expected five indexes');

  for (const s of normalized) {
    assert.match(s, /CREATE INDEX CONCURRENTLY/i, `not concurrent, will lock a hot table: ${s.slice(0, 60)}`);
    // @noTransaction has no rollback, so every statement must be replayable.
    assert.match(s, /IF NOT EXISTS/i, `not idempotent, a retry would fail the boot: ${s.slice(0, 60)}`);
  }

  const covers = (table, cols) =>
    normalized.some((s) => new RegExp(`ON ${table} \\(${cols}\\)`, 'i').test(s));

  assert.ok(covers('messages', 'sender_id'), 'messages(sender_id): profile stats + account-deletion DELETE');
  assert.ok(covers('flocks', 'venue_id'), 'flocks(venue_id): NFC check-in + join_venue');
  assert.ok(covers('flocks', 'status, event_time'), 'flocks(status, event_time): the 15-minute crowd sweep');
  assert.ok(covers('venue_feedback', 'user_id, created_at DESC'), 'venue_feedback(user_id, created_at DESC)');
  assert.ok(covers('venue_votes', 'venue_id'), 'venue_votes(venue_id)');

  // The two nullable-column indexes are partial: NULL rows can never match an
  // equality probe, so indexing them is pure write amplification.
  for (const s of normalized) {
    if (/ON flocks \(venue_id\)/i.test(s) || /ON venue_votes \(venue_id\)/i.test(s)) {
      assert.match(s, /WHERE venue_id IS NOT NULL/i, `should be partial: ${s.slice(0, 70)}`);
    }
  }
});

test('013 can drop an invalid leftover of every index it creates', () => {
  // A CONCURRENTLY build that dies leaves an INVALID index; IF NOT EXISTS would
  // then skip it forever and the planner would never use it. 008 established
  // the cleanup block — every new index name has to be listed in it or the
  // retry path silently does nothing.
  const cleanup = m013Statements.find((s) => /pg_index/i.test(s));
  assert.ok(cleanup, 'no invalid-index cleanup block (see 008_growth_indexes.sql)');
  for (const s of m013Statements.filter((x) => /^CREATE\s+INDEX/i.test(x))) {
    const name = /IF NOT EXISTS\s+(\w+)/i.exec(s)[1];
    assert.ok(cleanup.includes(`'${name}'`), `${name} is not in the invalid-index cleanup list`);
  }
});

test('the migration sequence has no duplicate or renumbered files', () => {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
  const numbers = files.map((f) => f.slice(0, 3));
  assert.strictEqual(new Set(numbers).size, numbers.length, `duplicate migration number: ${numbers.join(',')}`);
  // 011 and 012 belong to other work; 013 must not have displaced them.
  assert.ok(files.some((f) => f.startsWith('011_')), '011 is missing');
  assert.ok(files.some((f) => f.startsWith('012_')), '012 is missing');
  assert.ok(files.includes(M013), '013 is missing');
});

// ── 2. The REST DM venue-vote toggle ────────────────────────────────────────

const votePath = '/api/dm/2/venue-votes';

test('the REST vote toggle runs in a transaction under an advisory lock', async () => {
  const res = await call('POST', votePath, 'alice', { venue_name: 'The Bar' });
  assert.strictEqual(res.status, 200);
  assertQueriesUnderstood();

  const shape = txQueries.map((q) => q.sql);
  assert.ok(shape[0].startsWith('BEGIN'), 'the toggle must open a transaction first');
  assert.match(shape[1], /pg_advisory_xact_lock/, 'the lock must be taken BEFORE the read, or the read is unprotected');
  assert.ok(shape.some((s) => /COMMIT/.test(s)), 'the transaction must commit');
});

test('the REST lock key is byte-identical to the socket twin, so the two transports serialize', () => {
  // Different keys would mean each transport only serializes against itself,
  // and a tap in the app racing a tap on the web would be exactly the bug that
  // was just fixed on one side.
  const rest = fs.readFileSync(path.join(BACKEND, 'routes', 'messages.js'), 'utf8');
  const sock = fs.readFileSync(path.join(BACKEND, 'sockets', 'handlers.js'), 'utf8');
  const KEY = "pg_advisory_xact_lock(hashtext('dmvote:' || $1::text || ':' || $2::text || ':' || $3::text))";
  assert.ok(rest.includes(KEY), 'routes/messages.js does not use the shared dmvote lock key');
  assert.ok(sock.includes(KEY), 'sockets/handlers.js no longer uses the key this test pins');
});

test('two rapid taps on DIFFERENT venues leave the voter with exactly one vote', async () => {
  // Before: both requests read "no existing vote", both deleted, both inserted.
  // UNIQUE is (pair, user, venue_name), so two different names both survived
  // and one person held two live votes in a two-person conversation.
  const [a, b] = await Promise.all([
    call('POST', votePath, 'alice', { venue_name: 'The Bar' }),
    call('POST', votePath, 'alice', { venue_name: 'The Diner' }),
  ]);
  assert.strictEqual(a.status, 200);
  assert.strictEqual(b.status, 200);
  assertQueriesUnderstood();

  const mine = dmVotes.filter((v) => v.user_id === 1);
  assert.strictEqual(mine.length, 1, `expected one live vote, got ${JSON.stringify(mine)}`);
});

test('two rapid taps on the SAME venue toggle cleanly instead of racing into a 500', async () => {
  const [a, b] = await Promise.all([
    call('POST', votePath, 'alice', { venue_name: 'The Bar' }),
    call('POST', votePath, 'alice', { venue_name: 'The Bar' }),
  ]);
  // The unique constraint used to surface as a swallowed 500 on the second tap.
  assert.strictEqual(a.status, 200, 'first tap must succeed');
  assert.strictEqual(b.status, 200, 'second tap raced the unique constraint into a 500');
  assertQueriesUnderstood();
  // On + off.
  assert.strictEqual(dmVotes.filter((v) => v.user_id === 1).length, 0);
});

test('a single tap still votes, and tapping the same venue again unvotes', async () => {
  await call('POST', votePath, 'alice', { venue_name: 'The Bar' });
  assert.strictEqual(dmVotes.length, 1);
  assert.strictEqual(dmVotes[0].venue_name, 'The Bar');

  await call('POST', votePath, 'alice', { venue_name: 'The Bar' });
  assert.strictEqual(dmVotes.length, 0, 'a second tap on the same venue must unvote');
  assertQueriesUnderstood();
});

test('a vote that throws mid-transaction rolls back and does not leak the client', async () => {
  // Force a failure at the INSERT and check the handler still rolls back
  // rather than leaving the transaction (and its advisory lock) open on a
  // pooled connection.
  failNextVoteInsert = true;
  const res = await call('POST', votePath, 'alice', { venue_name: 'The Bar' });
  assert.strictEqual(res.status, 500);
  assert.ok(txQueries.some((q) => /^ROLLBACK/.test(q.sql)), 'no ROLLBACK issued');

  // And the lock is free again: the next vote must not hang behind it.
  const after = await call('POST', votePath, 'alice', { venue_name: 'The Bar' });
  assert.strictEqual(after.status, 200, 'the advisory lock was never released');
});

// ── 3. server.js: process safety net + demo-story truthfulness ──────────────

const serverSrc = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8');

test('server.js installs an unhandledRejection handler', () => {
  // Sentry only initialises when SENTRY_DSN is set and it is not set in
  // production, so without this Node's default behaviour — kill the process —
  // is what every connected user gets from one stray floating promise.
  assert.match(serverSrc, /process\.on\(\s*['"]unhandledRejection['"]/,
    'no unhandledRejection handler: one floating promise takes the whole service down');
  assert.doesNotMatch(serverSrc, /process\.on\(\s*['"]uncaughtException['"]/,
    'an uncaughtException handler would keep serving from unknown state — deliberately not paired');
});

test('the seeded demo stories are not resurrected on every production boot', () => {
  // Stock picsum images belonging to demo accounts, refreshed unconditionally
  // at boot, appeared as genuine friends' stories to anyone friended with those
  // accounts — App Review included.
  const idx = serverSrc.indexOf("picsum.photos/seed/flock");
  assert.ok(idx > 0, 'demo story block not found — if it was deleted outright, delete this test too');
  const preceding = serverSrc.slice(Math.max(0, idx - 900), idx);
  assert.match(preceding, /process\.env\.KEEP_DEMO_STORIES/,
    'the demo-story refresh must be behind an explicit opt-in env var');
});

// ── 4. Venue dashboard reviews ──────────────────────────────────────────────

function seedReviews(n, ratingFor) {
  reviews = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    rating: ratingFor(i),
    text: 'x',
    user_id: 50,
    created_at: new Date(Date.now() - i * 1000).toISOString(),
  }));
}

test('the public rating is the average of ALL reviews, not of the newest page', async () => {
  // Newest 50 are all 5s, the 70 older ones are all 1s. The old code averaged
  // the page: it would report 5.0 out of 50 for a venue whose real rating is
  // 2.7 out of 120 — wrong precisely for the venues with the most reviews.
  seedReviews(120, (i) => (i < 50 ? 5 : 1));

  const res = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE_ID}`, 'alice');
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assertQueriesUnderstood();

  assert.strictEqual(body.total, 120, 'total was capped at the page size');
  assert.strictEqual(body.average, 2.7, `average was computed over the page, got ${body.average}`);
  assert.ok(body.reviews.length <= 50, 'the row list must stay bounded');
  assert.strictEqual(body.hasMore, true);
});

test('the owner review tab aggregates in SQL and returns a bounded list', async () => {
  seedReviews(400, (i) => (i % 5) + 1);

  const res = await call('GET', '/api/venue-dashboard/reviews', 'alice');
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assertQueriesUnderstood();

  assert.strictEqual(body.stats.total, 400, 'stats must cover every review');
  assert.strictEqual(body.stats.distribution.reduce((s, n) => s + n, 0), 400);
  assert.strictEqual(body.stats.average, 3);
  assert.ok(body.reviews.length <= 100, `returned ${body.reviews.length} rows — the list is unbounded`);

  // The aggregate must come from Postgres, not from a full table load reduced
  // in JavaScript: no query in this request may return the whole set.
  const listQueries = queries.filter(
    (q) => /FROM venue_reviews vr JOIN users u/.test(q.sql) && !/AVG\(/.test(q.sql));
  assert.strictEqual(listQueries.length, 1);
  for (const q of listQueries) {
    assert.match(q.sql, /LIMIT \$\d/, 'the review list query has no LIMIT');
  }
});

test('an empty venue reports zero rather than dividing by zero', async () => {
  reviews = [];
  const res = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE_ID}`, 'alice');
  const body = await res.json();
  assert.strictEqual(body.total, 0);
  assert.strictEqual(body.average, 0);
  assert.strictEqual(body.hasMore, false);
});

// ── 5. Flock create: the invite loop ────────────────────────────────────────

test('inviting 25 people at create time costs a fixed number of queries, not 75', async () => {
  flocksRouter.__resetBudgets();
  const ids = Array.from({ length: 25 }, (_, i) => i + 3); // 3..27, all real
  const res = await call('POST', '/api/flocks', 'alice', { name: 'Dinner', invited_user_ids: ids });
  const body = await res.json();
  assert.strictEqual(res.status, 201);
  assertQueriesUnderstood();
  assert.strictEqual(body.invited_user_ids.length, 25);

  // Existence, block check and insert used to run per invitee inside the
  // transaction. Batched, the whole create is a handful of statements.
  const inTx = txQueries.filter((q) => !/^(BEGIN|COMMIT|ROLLBACK)/.test(q.sql));
  assert.ok(inTx.length <= 8, `create ran ${inTx.length} statements inside the transaction:\n${inTx.map((q) => q.sql.slice(0, 60)).join('\n')}`);

  // And the batched checks really are batched.
  assert.strictEqual(inTx.filter((q) => /FROM users WHERE id = ANY/.test(q.sql)).length, 1);
  assert.strictEqual(inTx.filter((q) => /FROM user_blocks/.test(q.sql)).length, 1);
});

test('batching did not weaken who actually gets invited', async () => {
  flocksRouter.__resetBudgets();
  blocks = [[1, 4]];
  const res = await call('POST', '/api/flocks', 'alice', {
    // 3 real, 4 blocked, 999999 nonexistent, 1 is self, 3 again is a duplicate.
    name: 'Dinner',
    invited_user_ids: [3, 4, 999999, 1, 3],
  });
  const body = await res.json();
  assert.strictEqual(res.status, 201);
  assertQueriesUnderstood();
  assert.deepStrictEqual(body.invited_user_ids, [3], 'blocked / nonexistent / self / duplicate must all be dropped');
});

test('both flock transactions guard their ROLLBACK', () => {
  // A throw from ROLLBACK on a dead connection replaces the real error, so the
  // logs report a connection failure instead of the constraint that broke.
  const src = fs.readFileSync(path.join(BACKEND, 'routes', 'flocks.js'), 'utf8');
  const bare = src.match(/await client\.query\('ROLLBACK'\)(?!\s*\.catch)/g) || [];
  assert.deepStrictEqual(bare, [], `${bare.length} unguarded ROLLBACK call(s) left`);
});

// ── 6. Budget reminder cooldown ─────────────────────────────────────────────

test('two concurrent reminders send one, not two', async () => {
  const [a, b] = await Promise.all([
    call('POST', `/api/budget/${FLOCK_ID}/remind`, 'alice'),
    call('POST', `/api/budget/${FLOCK_ID}/remind`, 'alice'),
  ]);
  assertQueriesUnderstood();
  const codes = [a.status, b.status].sort();
  assert.deepStrictEqual(codes, [200, 429],
    'the cooldown was read and written on either side of the whole push fan-out, so both requests passed it');
});

test('the cooldown map sheds expired entries instead of growing forever', async () => {
  const realNow = Date.now;
  try {
    for (const id of [11, 12, 13]) {
      await call('POST', `/api/budget/${id}/remind`, 'alice');
    }
    assert.strictEqual(budgetRouter.__reminderCooldownCount(), 3);

    // Past the 5-minute cooldown and the sweep interval.
    const jumped = realNow() + 10 * 60 * 1000;
    Date.now = () => jumped;
    await call('POST', '/api/budget/14/remind', 'alice');

    assert.strictEqual(budgetRouter.__reminderCooldownCount(), 1,
      'expired cooldowns were never swept — one entry per flock, forever');
  } finally {
    Date.now = realNow;
  }
});

test('a reminder is still allowed once the window has passed', async () => {
  const realNow = Date.now;
  try {
    const first = await call('POST', `/api/budget/${FLOCK_ID}/remind`, 'alice');
    assert.strictEqual(first.status, 200);
    const jumped = realNow() + 6 * 60 * 1000;
    Date.now = () => jumped;
    const second = await call('POST', `/api/budget/${FLOCK_ID}/remind`, 'alice');
    assert.strictEqual(second.status, 200, 'the cooldown must expire, not latch');
  } finally {
    Date.now = realNow;
  }
});

// ── 7. Pool timeouts ────────────────────────────────────────────────────────

test('the pool caps a single statement and rides out a burst', () => {
  const opts = pool.options || {};
  assert.strictEqual(opts.statement_timeout, 15000,
    'without a statement_timeout one stuck query parks a pool slot indefinitely; 20 of those and the API is down');
  assert.ok(opts.connectionTimeoutMillis >= 10000,
    'a 2s checkout timeout turns a brief saturation burst into opaque 500s');
});


test('the owner tab can page past the first fifty, and the pages tile', async () => {
  // From the fifty-first review on, the oldest were unreachable and could
  // never be replied to (venue-owner audit, 2026-09-05). `nextBefore` is the
  // last row of a page; sending it back as ?before= continues strictly below.
  seedReviews(120, (i) => (i % 5) + 1);
  const first = await call('GET', '/api/venue-dashboard/reviews', 'alice');
  const one = await first.json();
  assert.strictEqual(one.reviews.length, 50);
  assert.strictEqual(one.hasMore, true);
  assert.match(String(one.nextBefore), /^\d{4}-\d{2}-\d{2}T.*Z,50$/, `nextBefore was ${one.nextBefore}`);

  const second = await call('GET', `/api/venue-dashboard/reviews?before=${encodeURIComponent(one.nextBefore)}`, 'alice');
  const two = await second.json();
  assertQueriesUnderstood();
  assert.strictEqual(two.reviews.length, 50);
  assert.strictEqual(two.reviews[0].id, 51, 'the second page starts right after the first');
  assert.strictEqual(two.hasMore, true);
  const seen = new Set([...one.reviews, ...two.reviews].map((r) => r.id));
  assert.strictEqual(seen.size, 100, 'no row on two pages, none dropped between them');

  const third = await call('GET', `/api/venue-dashboard/reviews?before=${encodeURIComponent(two.nextBefore)}`, 'alice');
  const three = await third.json();
  assert.strictEqual(three.reviews.length, 20);
  assert.strictEqual(three.hasMore, false, 'the last page says so');
  assert.strictEqual(three.nextBefore, null);
  assert.strictEqual(three.stats.total, 120, 'the stats stay the whole set on every page');
});

test('a malformed cursor is read as the first page, and the public card pages the same way', async () => {
  seedReviews(60, () => 4);
  const junk = await call('GET', '/api/venue-dashboard/reviews?before=yesterday', 'alice');
  const j = await junk.json();
  assert.strictEqual(j.reviews[0].id, 1);
  assert.strictEqual(j.hasMore, true);

  const pub = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE_ID}`, 'alice');
  const p1 = await pub.json();
  assert.strictEqual(p1.reviews.length, 50);
  assert.strictEqual(p1.hasMore, true);
  const pub2 = await call('GET', `/api/venue-dashboard/public-reviews/${PLACE_ID}?before=${encodeURIComponent(p1.nextBefore)}`, 'alice');
  const p2 = await pub2.json();
  assertQueriesUnderstood();
  assert.strictEqual(p2.reviews.length, 10);
  assert.strictEqual(p2.reviews[0].id, 51);
  assert.strictEqual(p2.hasMore, false);
  assert.strictEqual(p2.total, 60);
});
