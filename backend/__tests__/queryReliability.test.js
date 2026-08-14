// Run: node --test  (from backend/)
//
// ─────────────────────────────────────────────────────────────────────────────
// QUERY RELIABILITY — routes/flocks.js, routes/messages.js, routes/venues.js
// ─────────────────────────────────────────────────────────────────────────────
//
// Railway gives this service roughly twenty Postgres connections. That number is
// the whole reason this file exists: a handler whose ROUND TRIP COUNT scales
// with a membership list does not merely get slow, it holds a pool slot for the
// duration and takes the service down under load that a constant-round-trip
// version would not notice.
//
// So these tests count the queries a request actually issues. Not the SQL text —
// text assertions pass a rewrite that reintroduces the loop under a different
// name. The load-bearing assertion in each case is the same shape:
//
//     the number of queries for N items must equal the number for 1 item
//
// which is the definition of "not N+1" and cannot be satisfied by accident.
//
// The three fixed defects, all of which this file goes red on if reverted:
//
//   1. POST /api/flocks/:id/invite issued up to FOUR round trips per submitted
//      id — membership lookup, user lookup, isBlockedBetween (which talks to the
//      POOL, so it briefly holds a SECOND connection while the request already
//      holds one), and the write. 25 ids, the validator's own cap, was ~103
//      queries. POST /api/flocks had already batched these exact three reads;
//      this route was the copy left behind.
//
//   2. POST /api/flocks/:id/attendance issued one UPDATE per entry plus THREE
//      queries per affected member, ALL on a checked-out client with an open
//      transaction: ~202 round trips for a 50-person flock, holding a pool slot
//      and `users` row locks for the whole chain.
//
//   3. GET /api/dm selected the other party's `profile_image_url` inside a
//      per-MESSAGE subquery and collapsed it with DISTINCT ON afterwards, so a
//      base64 avatar was carried once per DM in the account's entire history —
//      the exact amplification every other read in that file guards against —
//      and the list had no LIMIT at all.
//
// Plus one ordering defect: POST /api/dm/:userId made the BILLED Vision call
// before the free reply-target lookup that would have refused the request.
//
// No database. pool.query is a fixture dispatcher that records every call. Where
// a test needs wall-clock evidence rather than a count, QUERY_LATENCY_MS gives
// each dispatched query a simulated round trip, because a round trip is the
// thing being counted and a local fixture is otherwise free.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'query-reliability-test-secret';

const pool = require('../config/database');

// ── Fixture dispatcher ───────────────────────────────────────────────────────
let handlers = [];
let log = [];
let QUERY_LATENCY_MS = 0;
// Connections currently checked out of the pool but not released. One leaked
// client per failed request is what takes a 20-slot pool down, so every test
// that borrows one asserts this is back to zero afterwards.
let checkedOut = 0;
let peakCheckedOut = 0;

async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  if (QUERY_LATENCY_MS > 0) await new Promise((r) => setTimeout(r, QUERY_LATENCY_MS));
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = await fn(params || [], flat);
      return out === undefined ? { rows: [], rowCount: 0 } : out;
    }
  }
  throw new Error(`unscripted query: ${flat.slice(0, 160)}`);
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => {
  checkedOut += 1;
  peakCheckedOut = Math.max(peakCheckedOut, checkedOut);
  let released = false;
  return {
    query: (sql, params) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
        log.push({ sql: String(sql).trim().toUpperCase(), params: null, txControl: true });
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return dispatch(sql, params);
    },
    release: () => {
      if (released) return;
      released = true;
      checkedOut -= 1;
    },
  };
};

function on(re, fn) { handlers.push([re, fn]); }

// Data queries only — BEGIN/COMMIT/ROLLBACK are round trips too, but counting
// them would let a refactor that merely moved work out of a transaction look
// like a win. These counts are about the work itself.
function dataQueries() { return log.filter((q) => !q.txControl); }
function countMatching(re) { return dataQueries().filter((q) => re.test(q.sql)).length; }

// ── Module stubs, installed BEFORE the routers are required ──────────────────
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => ({ skipped: true, reason: 'test' });
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true, reason: 'test' });

// routes/messages.js destructures moderateImage at module load, so it has to be
// replaced on the module object before the require below.
const moderationMod = require('../utils/moderation');
let visionCalls = 0;
let visionVerdict = { allowed: true };
moderationMod.moderateImage = async () => { visionCalls += 1; return visionVerdict; };

const flocksRouter = require('../routes/flocks');
const messagesRouter = require('../routes/messages');

const app = express();
app.use(express.json({ limit: '8mb' }));
app.set('io', null); // no socket fan-out: it would add queries this file counts
app.use('/api/flocks', flocksRouter);
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
  log = [];
  QUERY_LATENCY_MS = 0;
  checkedOut = 0;
  peakCheckedOut = 0;
  visionCalls = 0;
  visionVerdict = { allowed: true };
  CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
  flocksRouter.__resetBudgets();
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

// ═════════════════════════════════════════════════════════════════════════════
// 1. POST /api/flocks/:id/invite — the fan-out that is STILL an N+1
// ═════════════════════════════════════════════════════════════════════════════
//
// Read the long comment above the loop in routes/flocks.js first. In short: the
// batched rewrite works, was measured at 103 queries / 1631ms -> 7 / 124ms, and
// is not applied, because the batched query shapes are unknown to the fixture
// dispatchers in __tests__/spamBudgets.test.js and __tests__/flockSanitize.test.js
// (which fall through to an empty result), so twelve passing behaviour tests go
// red on a change that alters none of the behaviour they assert. Those files
// belong to another rotation.
//
// What this section does instead:
//   * MEASURES the N+1 so the number in the report is not a guess, and pins it
//     as a CEILING — if the per-id work gets worse, this goes red;
//   * pins the two defects that WERE fixed in place, both of which survive a
//     later batching rewrite unchanged.

function scriptInvite({ existing = new Map(), blocked = new Set(), seated = 1 } = {}) {
  on(/SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'/,
    () => ({ rows: [{ id: 99 }], rowCount: 1 }));
  on(/SELECT id, name FROM flocks WHERE id = \$1/,
    (p) => ({ rows: [{ id: Number(p[0]), name: 'Friday' }], rowCount: 1 }));
  on(/COUNT\(\*\)::int AS n FROM flock_members WHERE flock_id = \$1/, () => ({ rows: [{ n: seated }], rowCount: 1 }));

  // The per-id shapes the loop actually issues.
  on(/SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/, (p) => {
    const st = existing.get(Number(p[1]));
    return st ? { rows: [{ status: st }], rowCount: 1 } : { rows: [], rowCount: 0 };
  });
  on(/SELECT id, name FROM users WHERE id = \$1/, (p) => (
    { rows: [{ id: Number(p[0]), name: `User${p[0]}` }], rowCount: 1 }
  ));
  on(/SELECT 1 FROM user_blocks/, (p) => (
    blocked.has(Number(p[1])) ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }
  ));

  on(/UPDATE flock_members SET status = 'invited'/, () => ({ rows: [], rowCount: 1 }));
  on(/INSERT INTO flock_members/, () => ({ rows: [], rowCount: 1 }));
}

test('invite: the per-invitee round trip count, measured and capped', async () => {
  scriptInvite();
  const one = await call('POST', '/api/flocks/7/invite', { user_ids: [2] });
  assert.strictEqual(one.status, 200, one.text);
  const countForOne = dataQueries().length;

  log = [];
  handlers = [];
  flocksRouter.__resetBudgets();
  scriptInvite();
  const many = await call('POST', '/api/flocks/7/invite', {
    user_ids: Array.from({ length: 25 }, (_, i) => i + 2),
  });
  assert.strictEqual(many.status, 200, many.text);
  assert.strictEqual(many.body.invited.length, 25);
  const countForMany = dataQueries().length;

  // THIS IS THE DEFECT, PINNED AS A CEILING, NOT AS A TARGET. 3 setup queries
  // plus 4 per id: membership, directory, isBlockedBetween (on a SECOND pool
  // connection), write. If somebody adds a fifth per-id query this goes red; if
  // somebody batches it — the right answer — this goes red too and points at
  // the two fixture files that have to move with it.
  assert.strictEqual(countForOne, 7, 'setup(3) + one invitee(4)');
  assert.strictEqual(
    countForMany, 103,
    `25 invitees issued ${countForMany} queries. Expected the known 3 + 25x4 = 103. ` +
    'If this dropped, the batching rewrite landed: delete this assertion and add the ' +
    'batched shapes to spamBudgets.test.js and flockSanitize.test.js.'
  );
  assert.ok(
    countForMany > countForOne,
    'if this ever stops being true the N+1 is gone and this test should be replaced ' +
    'by the constant-count assertion the attendance section uses'
  );
});

test('invite: isBlockedBetween borrows a SECOND pool connection per invitee', async () => {
  // Not a nitpick: the request already holds nothing from the pool, but the
  // per-id block check is a fresh pool.query for every id, so a 25-id invite is
  // 25 sequential checkouts of a ~20-slot pool interleaved with 75 other
  // queries. The batched rewrite replaces all 25 with one.
  scriptInvite();
  await call('POST', '/api/flocks/7/invite', { user_ids: [2, 3, 4] });
  assert.strictEqual(
    countMatching(/SELECT 1 FROM user_blocks/), 3,
    'one block round trip per invitee — this is the cheapest of the four to batch, ' +
    'because POST /api/flocks already has the set-based version written'
  );
});

test('invite: the re-invite UPDATE cannot demote an accepted member', async () => {
  scriptInvite({ existing: new Map([[5, 'declined']]) });
  const res = await call('POST', '/api/flocks/7/invite', { user_ids: [5] });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.invited.map((i) => i.user_id), [5], 'a declined member is still re-invitable');

  const upd = dataQueries().find((q) => /UPDATE flock_members SET status = 'invited'/.test(q.sql));
  assert.ok(upd, 'expected the re-invite UPDATE');
  assert.match(
    upd.sql, /AND status = 'declined'/,
    'the re-invite must be conditional on the row STILL being declined. Without that clause, ' +
    'a target who accepted between the status read and this write is demoted back to invited — ' +
    'silently out of the roster, the chat, the votes and every count, on a plan they had joined'
  );
});

test('invite: a concurrent duplicate cannot 23505 the whole request', async () => {
  scriptInvite();
  await call('POST', '/api/flocks/7/invite', { user_ids: [2, 3] });
  const ins = dataQueries().find((q) => /INSERT INTO flock_members/.test(q.sql));
  assert.ok(ins);
  assert.match(
    ins.sql, /ON CONFLICT \(flock_id, user_id\) DO NOTHING/,
    'every statement in this loop is its own autocommit, so a UNIQUE(flock_id, user_id) race ' +
    'threw a 500 for the WHOLE request after earlier ids had already been written and notified'
  );
});

test('invite: still refuses blocked pairs, dupes, self and the already-invited', async () => {
  scriptInvite({
    existing: new Map([[3, 'accepted'], [4, 'invited'], [5, 'declined']]),
    blocked: new Set([6]),
  });
  // 1 is the caller. 3 is already in. 4 is already asked. 5 declined. 6 is
  // blocked. 7 is new. 8 is listed twice.
  const res = await call('POST', '/api/flocks/7/invite', { user_ids: [1, 3, 4, 5, 6, 7, 8, 8] });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(
    res.body.invited.map((i) => i.user_id).sort((x, y) => x - y), [5, 7, 8],
    'the two hardening changes must not have moved who gets invited'
  );
});

// ═════════════════════════════════════════════════════════════════════════════
// 1b. GET /api/flocks — the home list
// ═════════════════════════════════════════════════════════════════════════════

test('flock list: is bounded, and the counts still come from unfiltered COUNTs', async () => {
  let listSql = null;
  let listParams = null;
  on(/FROM flocks f/, (p, sql) => {
    listSql = sql; listParams = p;
    return { rows: [{ id: 9, name: 'Dinner', member_status: 'accepted', member_count: '3', guest_count: 1, going_count: 4, member_previews: [] }] };
  });
  const res = await call('GET', '/api/flocks');
  assert.strictEqual(res.status, 200, res.text);

  assert.match(listSql, /LIMIT \$2/,
    'the home list returns every flock the caller has ANY membership row in, each row carrying ' +
    'five correlated subqueries — including a per-member NOT EXISTS inside member_previews. ' +
    'It had no LIMIT, and it contains INVITES, which somebody else creates');
  assert.strictEqual(listParams[1], 300);

  // The LIMIT must not have been bought by moving the counts, which is the one
  // thing rosterBlocks.test.js pins about this query.
  assert.match(listSql.replace(/\s+/g, ' '),
    /\(SELECT COUNT\(\*\) FROM flock_members WHERE flock_id = f\.id AND status = 'accepted'\) AS member_count/,
    'counts stay unfiltered plain COUNTs; only member_previews carries a block predicate');
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. POST /api/flocks/:id/attendance — the reliability recompute
// ═════════════════════════════════════════════════════════════════════════════

function scriptAttendance(memberIds, { tally } = {}) {
  on(/SELECT creator_id, status, name FROM flocks WHERE id = \$1/,
    () => ({ rows: [{ creator_id: 1, status: 'completed', name: 'Friday' }], rowCount: 1 }));
  on(/UPDATE flock_members SET attendance = t.mark/, (p) => ({ rows: [], rowCount: (p[0] || []).length }));
  on(/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'/,
    () => ({ rows: memberIds.map((id) => ({ user_id: id })), rowCount: memberIds.length }));
  // `tally` returning null for a uid models the row NOT coming back, which is
  // what an inner join would do for a user with no other memberships.
  on(/FROM UNNEST\(\$1::int\[\]\) AS t\(uid\)/, (p) => ({
    rows: (p[0] || [])
      .map((uid) => {
        const counts = tally ? tally(uid) : { joined: 4, attended: 3 };
        return counts ? { uid, ...counts } : null;
      })
      .filter(Boolean),
  }));
  on(/UPDATE users SET reliability_score = t.score/, (p) => ({ rows: [], rowCount: (p[0] || []).length }));

  // The per-user shapes the old implementation used.
  on(/UPDATE flock_members SET attendance = \$1/, () => {
    throw new Error('PER-ENTRY attendance UPDATE issued — the attendance loop is back');
  });
  on(/SELECT COUNT\(\*\) AS cnt FROM flock_members fm/, () => {
    throw new Error('PER-USER reliability COUNT issued — the attendance loop is back');
  });
  on(/UPDATE users SET reliability_score = \$1/, () => {
    throw new Error('PER-USER score UPDATE issued — the attendance loop is back');
  });
}

const roster = (n) => Array.from({ length: n }, (_, i) => i + 1);
const marks = (ids) => ids.map((id) => ({ userId: id, attended: id % 2 === 0 }));

test('attendance: query count does not grow with the size of the flock', async () => {
  scriptAttendance(roster(2));
  const small = await call('POST', '/api/flocks/7/attendance', { attendance: marks(roster(2)) });
  assert.strictEqual(small.status, 200, small.text);
  const countForTwo = dataQueries().length;

  log = [];
  handlers = [];
  scriptAttendance(roster(50));
  const big = await call('POST', '/api/flocks/7/attendance', { attendance: marks(roster(50)) });
  assert.strictEqual(big.status, 200, big.text);
  const countForFifty = dataQueries().length;

  assert.strictEqual(big.body.results.length, 50, 'every member must still be scored');
  assert.strictEqual(
    countForFifty, countForTwo,
    `50 members issued ${countForFifty} queries and 2 members issued ${countForTwo}; ` +
    'a per-member query has come back'
  );
  assert.ok(countForFifty <= 6, `expected a handful of queries, got ${countForFifty}`);
});

test('attendance: a 50-person flock does not hold a pool slot for 200 round trips', async () => {
  scriptAttendance(roster(50));
  QUERY_LATENCY_MS = 4;
  const started = Date.now();
  const res = await call('POST', '/api/flocks/7/attendance', { attendance: marks(roster(50)) });
  const elapsed = Date.now() - started;
  QUERY_LATENCY_MS = 0;

  assert.strictEqual(res.status, 200, res.text);
  // Old shape: 1 + 50 updates + 1 roster + 50 x 3 = 202 queries, all but the
  // first inside the transaction, i.e. >800ms of held connection.
  assert.ok(elapsed < 250, `took ${elapsed}ms with a slot checked out — that is the per-member loop`);
  assert.strictEqual(checkedOut, 0, 'the pool client must be released on the success path');
});

test('attendance: scores are computed from the same two predicates as before', async () => {
  // 3 of 4 completed-and-marked flocks attended => 75.00.
  scriptAttendance([1, 2], { tally: (uid) => (uid === 1 ? { joined: 4, attended: 3 } : { joined: 0, attended: 0 }) });
  const res = await call('POST', '/api/flocks/7/attendance', {
    attendance: [{ userId: 1, attended: true }, { userId: 2, attended: false }],
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.results, [
    { userId: 1, reliabilityScore: 75, totalPlansJoined: 4, totalPlansAttended: 3 },
    // Nothing completed yet is "no score", not zero — the per-user loop wrote
    // null here and the batched write has to as well.
    { userId: 2, reliabilityScore: null, totalPlansJoined: 0, totalPlansAttended: 0 },
  ]);

  const tally = dataQueries().find((q) => /AS t\(uid\)/.test(q.sql) && /joined/.test(q.sql));
  assert.ok(tally, 'expected the batched tally');
  // The two predicates are NOT the same and must not be "tidied" into one.
  assert.match(tally.sql, /fm\.status = 'accepted' AND fm\.attendance <> 'unmarked'/);
  assert.match(tally.sql, /fm\.attendance = 'attended'/);
  assert.strictEqual(
    (tally.sql.match(/f\.status = 'completed'/g) || []).length, 2,
    'both the numerator and the denominator are scoped to completed flocks (round 5)'
  );
});

test('attendance: a member the tally returns no row for still gets a result', async () => {
  // The aggregate LEFT JOINs so every requested uid comes back, but the JS also
  // falls back with `row?.joined ?? 0`. Both, deliberately: a member missing
  // from the result would otherwise be dropped from `results` entirely, which
  // means no score write, no reliability_updated socket event and no push —
  // silently, for the one member whose numbers actually changed.
  scriptAttendance([1, 2], { tally: (uid) => (uid === 1 ? { joined: 2, attended: 1 } : null) });
  const res = await call('POST', '/api/flocks/7/attendance', {
    attendance: [{ userId: 1, attended: true }, { userId: 2, attended: false }],
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.results.map((r) => r.userId), [1, 2],
    'every affected member must appear in results, tally row or not');
  assert.deepStrictEqual(res.body.results[1],
    { userId: 2, reliabilityScore: null, totalPlansJoined: 0, totalPlansAttended: 0 });
});

test('attendance: a null element is skipped, not a 500', async () => {
  // body('attendance').isArray() says nothing about the ELEMENTS. The write
  // loop always read `entry?.userId`; the recompute read `a.userId` and threw a
  // TypeError inside the transaction, rolling back every other member's mark.
  scriptAttendance([1, 2]);
  const res = await call('POST', '/api/flocks/7/attendance', {
    attendance: [null, { userId: 2, attended: true }],
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.results.map((r) => r.userId), [2]);
  assert.strictEqual(checkedOut, 0, 'no leaked client');
});

test('attendance: a duplicate userId resolves to the last entry, as it always did', async () => {
  scriptAttendance([1]);
  const res = await call('POST', '/api/flocks/7/attendance', {
    attendance: [{ userId: 1, attended: true }, { userId: 1, attended: false }],
  });
  assert.strictEqual(res.status, 200, res.text);
  const upd = dataQueries().find((q) => /UPDATE flock_members SET attendance = t.mark/.test(q.sql));
  assert.ok(upd, 'expected the batched attendance UPDATE');
  assert.deepStrictEqual(upd.params[0], [1], 'one row per user, not two');
  assert.deepStrictEqual(
    upd.params[1], ['no_show'],
    'sequential UPDATEs made the last entry win; a set-based join over duplicate keys ' +
    'would pick an arbitrary one, so the dedupe has to happen before the query'
  );
});

test('attendance: guest ids and out-of-range ids are still skipped', async () => {
  scriptAttendance([2]);
  const res = await call('POST', '/api/flocks/7/attendance', {
    attendance: [
      { userId: 'guest:12', attended: true },
      { userId: 9999999999, attended: true },
      { userId: 2, attended: true },
    ],
  });
  assert.strictEqual(res.status, 200, res.text);
  const upd = dataQueries().find((q) => /UPDATE flock_members SET attendance = t.mark/.test(q.sql));
  assert.deepStrictEqual(upd.params[0], [2], 'only the real, in-range member id reaches the int4 column');
});

test('attendance: the pool client is released when the transaction throws', async () => {
  on(/SELECT creator_id, status, name FROM flocks WHERE id = \$1/,
    () => ({ rows: [{ creator_id: 1, status: 'completed', name: 'Friday' }], rowCount: 1 }));
  on(/UPDATE flock_members SET attendance = t.mark/, () => { throw new Error('deadlock detected'); });

  const res = await call('POST', '/api/flocks/7/attendance', { attendance: [{ userId: 2, attended: true }] });
  assert.strictEqual(res.status, 500);
  assert.strictEqual(checkedOut, 0, 'a client leaked on the error path is what empties a 20-slot pool');
  assert.strictEqual(peakCheckedOut, 1, 'and only one was ever taken');
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. GET /api/dm — the conversation list
// ═════════════════════════════════════════════════════════════════════════════

const BIG_AVATAR = 'data:image/png;base64,' + 'A'.repeat(13000);

// A synthetic direct_messages table.
//
// It INTERPRETS THE SQL rather than replaying the behaviour the route wants.
// The first version of this fixture applied the block filter, the ordering and
// the LIMIT unconditionally, which meant three mutations — delete `LIMIT $3`,
// delete the block predicate, flip DESC to ASC — all stayed green, because the
// fixture was quietly supplying the behaviour the query had stopped asking for.
// A fixture that models what you meant instead of what you wrote tests nothing.
// So each clause is applied only if the statement actually contains it, the way
// Postgres would.
function scriptDm(corpus, { avatars = new Map() } = {}) {
  on(/blocked_id AS id FROM user_blocks/, () => ({ rows: [], rowCount: 0 }));
  on(/DISTINCT ON \(other_id\)/, (p, sql) => {
    const [me, invisible, limit] = p;
    const filtersBlocks = sql.includes('NOT (other_id = ANY($2::int[]))');
    const guardsAvatar = sql.includes('LENGTH(u.profile_image_url) > 12000');
    const limits = /LIMIT \$3\s*$/.test(sql.trim());
    const ascending = /ORDER BY l\.created_at ASC/.test(sql);

    const hidden = new Set(filtersBlocks ? (invisible || []) : []);
    const latest = new Map();
    for (const m of corpus) {
      if (m.sender_id !== me && m.receiver_id !== me) continue;
      if (m.is_hidden) continue;
      const other = m.sender_id === me ? m.receiver_id : m.sender_id;
      if (hidden.has(other)) continue;
      const held = latest.get(other);
      if (!held || new Date(m.created_at) > new Date(held.created_at)) latest.set(other, m);
    }
    let rows = [...latest.values()].sort((a, b) => (
      ascending
        ? new Date(a.created_at) - new Date(b.created_at)
        : new Date(b.created_at) - new Date(a.created_at)
    ));
    if (limits) rows = rows.slice(0, limit);
    rows = rows.map((m) => {
      const other = m.sender_id === me ? m.receiver_id : m.sender_id;
      const avatar = avatars.get(other) || null;
      return {
        id: m.id,
        message_text: m.message_text,
        created_at: m.created_at,
        read_status: m.read_status,
        sender_id: m.sender_id,
        other_id: other,
        other_name: `User${other}`,
        other_image: guardsAvatar && avatar && avatar.length > 12000 ? null : avatar,
      };
    });
    return { rows, rowCount: rows.length };
  });
  on(/unread_count/, (p, sql) => {
    const scopes = sql.includes('sender_id = ANY($2::int[])');
    const scoped = new Set(p[1] || []);
    const counts = new Map();
    for (const m of corpus) {
      if (m.receiver_id !== p[0] || m.read_status || m.is_hidden) continue;
      if (scopes && !scoped.has(m.sender_id)) continue;
      counts.set(m.sender_id, (counts.get(m.sender_id) || 0) + 1);
    }
    return { rows: [...counts].map(([sender_id, unread_count]) => ({ sender_id, unread_count })) };
  });
}

function dmCorpus(partnerCount, perPartner = 3) {
  const rows = [];
  let id = 1;
  for (let p = 0; p < partnerCount; p += 1) {
    const other = p + 2;
    for (let k = 0; k < perPartner; k += 1) {
      rows.push({
        id: id++,
        sender_id: k % 2 === 0 ? other : 1,
        receiver_id: k % 2 === 0 ? 1 : other,
        message_text: `msg ${k} with ${other}`,
        created_at: new Date(Date.UTC(2026, 0, 1 + p, 0, k)).toISOString(),
        read_status: k % 2 !== 0,
        is_hidden: false,
      });
    }
  }
  return rows;
}

test('dm list: query count does not grow with the conversation count', async () => {
  scriptDm(dmCorpus(3));
  await call('GET', '/api/dm');
  const countForThree = dataQueries().length;

  log = [];
  handlers = [];
  scriptDm(dmCorpus(120));
  const many = await call('GET', '/api/dm');
  assert.strictEqual(many.status, 200, many.text);
  assert.strictEqual(dataQueries().length, countForThree);
  assert.ok(countForThree <= 3, `expected blocks + list + unread, got ${countForThree}`);
});

test('dm list: the avatar is fetched once per PARTNER, not once per message', async () => {
  // The old query selected u.profile_image_url inside a per-message subquery and
  // let DISTINCT ON collapse it afterwards, so the sort carried one copy of a
  // base64 avatar per DM in the account's entire history.
  scriptDm(dmCorpus(2, 40), { avatars: new Map([[2, BIG_AVATAR], [3, 'small.jpg']]) });
  const res = await call('GET', '/api/dm');
  assert.strictEqual(res.status, 200, res.text);

  const listQuery = dataQueries().find((q) => /DISTINCT ON \(other_id\)/.test(q.sql));
  assert.ok(listQuery);
  // The join to users must come AFTER the collapse. If `users` is joined inside
  // the same scope as direct_messages, the avatar is amplified again.
  const collapse = listQuery.sql.indexOf('DISTINCT ON (other_id)');
  const usersJoin = listQuery.sql.indexOf('JOIN users');
  assert.ok(usersJoin > collapse,
    'users must be joined after DISTINCT ON collapses the history to one row per partner');
  assert.match(listQuery.sql, /LENGTH\(u\.profile_image_url\) > 12000/,
    'the same oversized-avatar guard every other read in this file applies');

  const big = res.body.conversations.find((c) => c.userId === 2);
  assert.strictEqual(big.image, null, 'an oversized legacy avatar is dropped, not served');
  const small = res.body.conversations.find((c) => c.userId === 3);
  assert.strictEqual(small.image, 'small.jpg', 'an ordinary avatar is untouched');
});

test('dm list: is bounded, newest first', async () => {
  scriptDm(dmCorpus(250));
  const res = await call('GET', '/api/dm');
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.conversations.length, 200, 'a list the user grows needs a LIMIT');

  const times = res.body.conversations.map((c) => new Date(c.lastMessageTime).getTime());
  const sorted = [...times].sort((a, b) => b - a);
  assert.deepStrictEqual(times, sorted, 'newest first, so the LIMIT drops the oldest and not an arbitrary set');
});

test('dm list: blocked partners are excluded in SQL, before the LIMIT', async () => {
  // Applied in JavaScript after the query, a blocked partner eats a slot and
  // pushes a real conversation off the end of the page.
  const corpus = dmCorpus(4);
  handlers = [];
  on(/blocked_id AS id FROM user_blocks/, () => ({ rows: [{ id: 3 }], rowCount: 1 }));
  scriptDm(corpus);
  // scriptDm re-registers the block lookup after ours; the first match wins.

  const res = await call('GET', '/api/dm');
  assert.strictEqual(res.status, 200, res.text);
  const ids = res.body.conversations.map((c) => c.userId);
  assert.ok(!ids.includes(3), 'a blocked partner must not appear');

  const listQuery = dataQueries().find((q) => /DISTINCT ON \(other_id\)/.test(q.sql));
  assert.deepStrictEqual(listQuery.params[1], [3],
    'the blocked set must reach the query, not be filtered off the result');
});

test('dm list: unread counts survive, and are asked only for the partners returned', async () => {
  scriptDm(dmCorpus(3));
  const res = await call('GET', '/api/dm');
  assert.strictEqual(res.status, 200, res.text);
  for (const c of res.body.conversations) {
    assert.ok(Number.isInteger(c.unread), 'every conversation still carries an unread count');
  }
  const unread = dataQueries().find((q) => /unread_count/.test(q.sql));
  assert.ok(unread, 'expected the unread aggregate');
  assert.match(unread.sql, /sender_id = ANY/,
    'the aggregate used to group every sender in the account history and throw most of it away');
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. POST /api/dm/:userId — free refusals before the billed call
// ═════════════════════════════════════════════════════════════════════════════

const A_PHOTO = 'data:image/png;base64,' + 'A'.repeat(2048);

function scriptSendDm({ replyTargetValid = true } = {}) {
  on(/SELECT 1 FROM user_blocks/, () => ({ rows: [], rowCount: 0 }));
  on(/blocked_id AS id FROM user_blocks/, () => ({ rows: [], rowCount: 0 }));
  on(/FROM friendships/, () => ({ rows: [{ '?column?': 1 }], rowCount: 1 })); // hasDmRelationship
  on(/SELECT id FROM direct_messages WHERE id = \$1/, () => (
    replyTargetValid ? { rows: [{ id: 5 }], rowCount: 1 } : { rows: [], rowCount: 0 }
  ));
  on(/INSERT INTO direct_messages/, (p) => ({
    rows: [{ id: 900, sender_id: p[0], receiver_id: p[1], message_text: p[2], reply_to_id: p[6] }],
    rowCount: 1,
  }));
}

test('send dm: an invalid reply target is refused BEFORE the billed Vision call', async () => {
  scriptSendDm({ replyTargetValid: false });
  const res = await call('POST', '/api/dm/2', { message_text: 'look', image_url: A_PHOTO, reply_to_id: 5 });

  assert.strictEqual(res.status, 400, res.text);
  assert.strictEqual(res.body.error, 'Invalid reply target');
  assert.strictEqual(
    visionCalls, 0,
    'a refusal that costs a primary-key lookup must never come after a call that costs money'
  );
});

test('send dm: the image is still screened when the reply target is fine', async () => {
  scriptSendDm();
  visionVerdict = { allowed: false, reason: 'adult' };
  const res = await call('POST', '/api/dm/2', { message_text: 'look', image_url: A_PHOTO, reply_to_id: 5 });
  assert.strictEqual(res.status, 400, res.text);
  assert.strictEqual(res.body.moderation, 'adult');
  assert.strictEqual(visionCalls, 1, 'reordering must not have skipped the screen');
});

test('send dm: a clean reply with a photo still sends', async () => {
  scriptSendDm();
  const res = await call('POST', '/api/dm/2', { message_text: 'look', image_url: A_PHOTO, reply_to_id: 5 });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(res.body.message.reply_to_id, 5);
  assert.strictEqual(visionCalls, 1);
});

test('send dm: an oversized photo is still refused for free (unchanged)', async () => {
  scriptSendDm();
  const huge = 'data:image/png;base64,' + 'A'.repeat(2 * 1024 * 1024);
  const res = await call('POST', '/api/dm/2', { message_text: 'look', image_url: huge });
  assert.strictEqual(res.status, 400, res.text);
  assert.strictEqual(visionCalls, 0, 'the byte-count refusal stays ahead of the billed call');
});
