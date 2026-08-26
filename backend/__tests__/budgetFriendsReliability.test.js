// Run: node --test  (from backend/)
//
// Reliability pass over the two hot routes (2026-08-14): routes/budget.js
// (anonymous budget matching) and routes/friends.js (requests, accept,
// find-by-phone).
//
// What is pinned here, and why it needs a STATEFUL fixture rather than the
// scripted answer-sheets the other suites use: every defect in this file is a
// race, and a race only exists when two requests read and write the SAME
// state. So the fixture below is a tiny in-memory database — friendships with
// the real UNIQUE(requester_id, addressee_id) behaviour (23505 on a bare
// duplicate insert, rowCount 0 under ON CONFLICT DO NOTHING), budget
// submissions with the real upsert, and a FOR UPDATE row lock that actually
// serializes transactions the way Postgres does. Interleavings are made
// deterministic with barriers (both racers must arrive at the read before
// either may write) instead of sleeps and hope.
//
// The four races proven and pinned:
//   1. Double-submit: the same user's two concurrent budget submissions must
//      not double-count toward the 3-submission reveal, and the "Budget set!"
//      crossing must fire exactly once.
//   2. Crossed friend requests (A asks B while B asks A) must converge to ONE
//      row, accepted — not two pending rows and never a 23505-driven 500.
//   3. Both sides accepting a crossed pair at once must converge to ONE
//      accepted friendship — not two rows the friends list shows twice, and
//      not zero rows.
//   4. Request-then-block and accept-then-block interleavings must not leave a
//      relationship standing across the block.
//
// Plus the privacy re-pin: the budget wire format is { ceiling,
// submissionCount, totalMembers, isReady, skipCount } + the caller's own row,
// EXACTLY — the key lists below fail the moment a projection widens — the
// ceiling is withheld below 3 non-skips on every surface (response, socket
// payload, GET), and GET's count-before-ceiling statement order is asserted
// because the reveal decision must never be paired with an older ceiling.
//
// And, since the money security audit of 2026-08-16 (finding M1), the banding
// pins in section 1b: what the ceiling publishes above the threshold is a BAND,
// not the raw MIN, because three submissions are not three independent people.
// Those tests execute the actual exploit — two colluding accounts pinned high,
// a victim's real amount as the MIN — and assert the number that leaves is the
// band on every surface the ceiling can leave by.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-for-budget-friends-reliability';
delete process.env.FIREBASE_SERVICE_ACCOUNT; // push stays a no-op (no DB work)

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');
// The same digest the route computes, so the fixture directory is keyed the way
// production is instead of by a second, drifting definition of "same number".
const { phoneDiscoveryHash } = require('../utils/phone');

// ── Fixture state ───────────────────────────────────────────────────────────
const AUTHED = {
  1: { id: 1, email: 'alice@example.com', name: 'Alice', role: 'user', is_banned: false, token_version: 0 },
  2: { id: 2, email: 'bob@example.com', name: 'Bob', role: 'user', is_banned: false, token_version: 0 },
  3: { id: 3, email: 'cara@example.com', name: 'Cara', role: 'user', is_banned: false, token_version: 0 },
};
const FLOCK_ID = 10;
// A value no aggregate in these fixtures can coincidentally equal: finding it
// in a response or socket payload is proof of an individual-amount leak.
const VICTIM_AMOUNT = 47.13;

let friendships;    // [{ id, requester_id, addressee_id, status }]
let blocks;         // [[a, b]]
let bannedIds;      // Set of userIds whose users.is_banned is TRUE
let budgets;        // Map "userId" -> { amount, skipped }
let flock;          // the one flock row
let members;        // accepted member ids
let phones;         // Map userId -> phone digits (find-by-phone directory)
let discoverable;   // Set of userIds whose users.phone_discoverable is TRUE
let emitted;        // every io emit: { room, event, payload }
let queries;        // every non-auth statement: { sql, params }
let unknown;        // statements the fixture did not recognise
let nextId;
let onBlockCheck;   // hook: called with (nthCall) AFTER the answer is computed
let blockCheckCount;
let gates;          // name -> { remaining, waiters } rendezvous barriers

function reset() {
  friendships = [];
  blocks = [];
  bannedIds = new Set();
  budgets = new Map();
  flock = {
    id: FLOCK_ID, name: 'Rooftop Friday', creator_id: 1,
    budget_enabled: true, budget_context: 'dinner', budget_locked: false,
    budget_ceiling: null, ghost_mode_enabled: false,
  };
  members = [1, 2, 3, 4];
  phones = new Map();
  discoverable = new Set();
  emitted = [];
  queries = [];
  unknown = [];
  nextId = 500;
  onBlockCheck = null;
  blockCheckCount = 0;
  gates = {};
  friendsRouter.__resetBudgets();
  budgetRouter.__resetReminderCooldowns();
}

const pairMatch = (a, b) => (r) =>
  (r.requester_id === Number(a) && r.addressee_id === Number(b)) ||
  (r.requester_id === Number(b) && r.addressee_id === Number(a));

const STATUS_RANK = { accepted: 0, pending: 1 };
const byRankThenId = (x, y) =>
  ((STATUS_RANK[x.status] ?? 2) - (STATUS_RANK[y.status] ?? 2)) || (x.id - y.id);

function blockedBetween(a, b) {
  return blocks.some(([x, y]) =>
    (Number(x) === Number(a) && Number(y) === Number(b)) ||
    (Number(x) === Number(b) && Number(y) === Number(a)));
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Rendezvous barrier: gate('name', 2) makes the next two arrivals at that
// point wait for each other, so both racers have READ before either WRITES.
// Later arrivals (re-reads after the race window) pass through untouched.
function gate(name, n) { gates[name] = { remaining: n, waiters: [] }; }
function arrive(name) {
  const g = gates[name];
  if (!g || g.remaining <= 0) return Promise.resolve();
  g.remaining -= 1;
  if (g.remaining === 0) {
    for (const w of g.waiters.splice(0)) w();
    return Promise.resolve();
  }
  return new Promise((r) => g.waiters.push(r));
}

// FOR UPDATE row locks: a per-key mutex whose release is tied to the client's
// COMMIT/ROLLBACK/release — which is what the real lock does.
const keyLocks = new Map();
function acquireKeyLock(key) {
  const prev = keyLocks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  keyLocks.set(key, prev.then(() => mine));
  return prev.then(() => release);
}

function dup23505() {
  const e = new Error('duplicate key value violates unique constraint "friendships_requester_id_addressee_id_key"');
  e.code = '23505';
  return e;
}

// ── The dispatcher ──────────────────────────────────────────────────────────
async function dispatch(text, params = [], ctx = null) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  const has = (frag) => sql.includes(frag);

  // middleware/auth.js — not logged, it is the same for every request.
  if (has('is_banned, token_version FROM users WHERE id = $1')) {
    const u = AUTHED[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  queries.push({ sql, params });

  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) {
    if (ctx && /^(COMMIT|ROLLBACK)$/i.test(sql)) {
      for (const rel of ctx.releases.splice(0)) rel();
    }
    return { rows: [], rowCount: 0 };
  }

  // utils/blocks.js pair check — with the post-answer hook that lets a test
  // land a block exactly inside the check-then-write gap.
  if (has('FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2)')) {
    blockCheckCount += 1;
    const nth = blockCheckCount;
    const res = blockedBetween(params[0], params[1]);
    if (onBlockCheck) onBlockCheck(nth);
    await arrive('blockCheck');
    return res ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (has('SELECT blocked_id AS id FROM user_blocks')) {
    const me = Number(params[0]);
    const ids = blocks
      .filter(([a, b]) => Number(a) === me || Number(b) === me)
      .map(([a, b]) => (Number(a) === me ? Number(b) : Number(a)));
    return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
  }

  // users directory. `is_banned` joined this statement when the ban gap was
  // closed: POST /request and POST /add-by-code fold a banned row into the same
  // single miss a missing row gets, so the column has to come back from the one
  // query rather than a second one.
  if (has('SELECT id, name, is_banned FROM users WHERE id = $1')) {
    const u = AUTHED[params[0]] || (Number(params[0]) >= 1 && Number(params[0]) <= 100
      ? { id: Number(params[0]), name: `User${params[0]}` } : null);
    const banned = u ? bannedIds.has(Number(u.id)) : false;
    return { rows: u ? [{ id: u.id, name: u.name, is_banned: banned }] : [], rowCount: u ? 1 : 0 };
  }

  // find-by-phone: the digest lookup, then the ONE batched friendship read.
  //
  // Migration 051 turned this from a suffix scan over users.phone into an
  // equality lookup on users.phone_hash gated by users.phone_discoverable, so
  // the fixture hashes its own directory exactly the way the route hashes the
  // uploaded list. Numbers are therefore matched as WHOLE canonical numbers: a
  // fixture entry that does not canonicalise matches nothing now, which is the
  // behaviour under test rather than a fixture quirk.
  if (has('WHERE phone_hash = ANY($2::text[])')) {
    const me = Number(params[0]);
    const wanted = new Set(params[1]);
    const rows = [...phones.entries()]
      .filter(([id]) => id !== me && discoverable.has(id))
      .filter(([, digits]) => wanted.has(phoneDiscoveryHash(digits)))
      .map(([id]) => ({ id, name: `User${id}`, profile_image_url: null }))
      .sort((a, b) => a.id - b.id);
    return { rows, rowCount: rows.length };
  }
  if (has('= ANY($2::int[])') && has('FROM friendships')) {
    const me = Number(params[0]);
    const ids = (params[1] || []).map(Number);
    const rows = friendships
      .filter((f) => (f.requester_id === me && ids.includes(f.addressee_id))
        || (f.addressee_id === me && ids.includes(f.requester_id)))
      .map((f) => ({ friend_id: f.requester_id === me ? f.addressee_id : f.requester_id, status: f.status }));
    return { rows, rowCount: rows.length };
  }

  // The shared pair lookup (pre-insert read AND post-insert convergence
  // re-read). Gated so a test can hold both racers at the read.
  if (has('SELECT id, status, requester_id FROM friendships')) {
    await arrive('pairLookup');
    const rows = friendships.filter(pairMatch(params[0], params[1])).slice().sort(byRankThenId);
    return {
      rows: rows.slice(0, 1).map((r) => ({ id: r.id, status: r.status, requester_id: r.requester_id })),
      rowCount: Math.min(rows.length, 1),
    };
  }
  if (has('SELECT status FROM friendships')) {
    const rows = friendships.filter(pairMatch(params[0], params[1])).slice().sort(byRankThenId);
    return { rows: rows.slice(0, 1).map((r) => ({ status: r.status })), rowCount: Math.min(rows.length, 1) };
  }

  if (has('INSERT INTO friendships')) {
    const [a, b] = [Number(params[0]), Number(params[1])];
    const dupe = friendships.some((r) => r.requester_id === a && r.addressee_id === b);
    if (dupe) {
      if (has('ON CONFLICT')) return { rows: [], rowCount: 0 };
      throw dup23505();
    }
    const row = { id: nextId++, requester_id: a, addressee_id: b, status: 'pending' };
    friendships.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  if (has("UPDATE friendships SET status = 'accepted'")) {
    if (has('WHERE id = $1')) {
      const row = friendships.find((r) => r.id === Number(params[0]) && r.status === 'pending');
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'accepted';
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    // /accept: by (requester, addressee), pending only.
    const row = friendships.find((r) =>
      r.requester_id === Number(params[0]) && r.addressee_id === Number(params[1]) && r.status === 'pending');
    if (!row) return { rows: [], rowCount: 0 };
    row.status = 'accepted';
    return { rows: [{ ...row }], rowCount: 1 };
  }

  if (has("UPDATE friendships SET status = 'pending'")) {
    // reRequestDeclined: honours the UNIQUE ordered-pair constraint the way
    // Postgres does — flipping the direction onto an id pair that already
    // exists raises 23505.
    const row = friendships.find((r) => r.id === Number(params[2]) && r.status === 'declined');
    if (!row) return { rows: [], rowCount: 0 };
    const [a, b] = [Number(params[0]), Number(params[1])];
    if (friendships.some((r) => r.id !== row.id && r.requester_id === a && r.addressee_id === b)) {
      throw dup23505();
    }
    row.status = 'pending'; row.requester_id = a; row.addressee_id = b;
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  if (has('DELETE FROM friendships')) {
    const match = pairMatch(params[0], params[1]);
    if (has('MIN(f2.id)')) {
      // collapseToOneFriendship, faithfully: pending/declined pair rows go,
      // accepted duplicates beyond MIN(id) go, the canonical survivor stays.
      const accepted = friendships.filter((r) => match(r) && r.status === 'accepted');
      const minAcc = accepted.length ? Math.min(...accepted.map((r) => r.id)) : null;
      const before = friendships.length;
      friendships = friendships.filter((r) => {
        if (!match(r)) return true;
        if (r.status === 'pending' || r.status === 'declined') return false;
        if (r.status === 'accepted' && minAcc !== null && r.id !== minAcc) return false;
        return true;
      });
      return { rows: [], rowCount: before - friendships.length };
    }
    const pendingOnly = has("status = 'pending'");
    const removed = friendships.filter((r) => match(r) && (!pendingOnly || r.status === 'pending'));
    friendships = friendships.filter((r) => !removed.includes(r));
    return { rows: removed.map((r) => ({ id: r.id })), rowCount: removed.length };
  }

  // ── budget ──
  if (has("SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'")) {
    const ok = Number(params[0]) === FLOCK_ID && members.includes(Number(params[1]));
    return { rows: ok ? [{ id: 1 }] : [], rowCount: ok ? 1 : 0 };
  }
  if (has('FROM flocks WHERE id = $1 FOR UPDATE')) {
    if (Number(params[0]) !== FLOCK_ID) return { rows: [], rowCount: 0 };
    if (ctx) ctx.releases.push(await acquireKeyLock(`flock:${params[0]}`));
    return { rows: [{ ...flock }], rowCount: 1 };
  }
  if (has('SELECT budget_enabled, budget_context')) {
    return Number(params[0]) === FLOCK_ID ? { rows: [{ ...flock }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (has('SELECT skipped FROM budget_submissions')) {
    const row = budgets.get(Number(params[1]));
    return { rows: row ? [{ skipped: row.skipped }] : [], rowCount: row ? 1 : 0 };
  }
  if (has('INSERT INTO budget_submissions')) {
    budgets.set(Number(params[1]), { amount: params[2] === null ? null : Number(params[2]), skipped: !!params[3] });
    // Holding the flock row lock: widen the window so an unserialized double
    // submit would interleave its reads and writes.
    await delay(15);
    return { rows: [], rowCount: 1 };
  }
  if (has('SELECT MIN(amount) AS ceiling FROM budget_submissions')) {
    const amounts = [...budgets.values()].filter((s) => !s.skipped).map((s) => s.amount);
    const min = amounts.length ? Math.min(...amounts) : null;
    return { rows: [{ ceiling: min === null ? null : String(min) }], rowCount: 1 };
  }
  if (has('UPDATE flocks SET budget_ceiling')) {
    flock.budget_ceiling = params[0] === null ? null : String(params[0]);
    return { rows: [], rowCount: 1 };
  }
  if (has('UPDATE flocks SET budget_locked')) {
    flock.budget_locked = true;
    flock.budget_ceiling = params[1] === null ? null : String(params[1]);
    return { rows: [], rowCount: 1 };
  }
  if (has('COUNT(*)::int AS n FROM budget_submissions')) {
    const n = [...budgets.values()].filter((s) => !s.skipped).length;
    return { rows: [{ n }], rowCount: 1 };
  }
  if (has('COUNT(*) AS total_submissions')) {
    const all = [...budgets.values()];
    return {
      rows: [{
        total_submissions: String(all.length),
        non_skip_count: String(all.filter((s) => !s.skipped).length),
        skip_count: String(all.filter((s) => s.skipped).length),
      }],
      rowCount: 1,
    };
  }
  if (has('COUNT(*) AS total FROM flock_members')) {
    return { rows: [{ total: String(members.length) }], rowCount: 1 };
  }
  if (has("AND user_id != $2")) { // crossing-push recipient list
    const rows = members.filter((id) => id !== Number(params[1])).map((id) => ({ user_id: id }));
    return { rows, rowCount: rows.length };
  }
  if (has("SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted'")) {
    return { rows: members.map((id) => ({ user_id: id })), rowCount: members.length };
  }
  if (has('SELECT name FROM flocks WHERE id = $1')) {
    return { rows: [{ name: flock.name }], rowCount: 1 };
  }
  if (has('SELECT creator_id, name, budget_enabled FROM flocks') || has('SELECT creator_id, budget_enabled FROM flocks')) {
    return Number(params[0]) === FLOCK_ID ? { rows: [{ ...flock }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (has('SELECT amount, skipped FROM budget_submissions')) {
    const row = budgets.get(Number(params[1]));
    return {
      rows: row ? [{ amount: row.amount === null ? null : String(row.amount), skipped: row.skipped }] : [],
      rowCount: row ? 1 : 0,
    };
  }

  unknown.push(sql);
  return { rows: [], rowCount: 0 };
}

const realQuery = pool.query;
const realConnect = pool.connect;
pool.query = (text, params) => dispatch(text, params, null);
pool.connect = async () => {
  const ctx = { releases: [] };
  return {
    query: (text, params) => dispatch(text, params, ctx),
    release() { for (const rel of ctx.releases.splice(0)) rel(); },
  };
};

// ── App under test ──────────────────────────────────────────────────────────
const friendsRouter = require('../routes/friends');
const budgetRouter = require('../routes/budget');

const io = {
  sockets: { adapter: { rooms: new Map() } }, // everyone offline
  to(room) { return { emit: (event, payload) => emitted.push({ room, event, payload }) }; },
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/friends', friendsRouter);
app.use('/api/budget', budgetRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => { pool.query = realQuery; pool.connect = realConnect; return pool.end().catch(() => {}); });
test.beforeEach(reset);

async function call(method, path, who, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${signUserToken(AUTHED[who])}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

const assertQueriesUnderstood = () =>
  assert.deepStrictEqual(unknown, [], 'test fixture did not model one of the queries the route ran');

const pairRows = (a, b) => friendships.filter(pairMatch(a, b));

// ===========================================================================
// 1. Budget privacy re-pin: the wire format, exactly
// ===========================================================================

test('budget: submit response carries the aggregate keys and nothing else, ceiling withheld below 3', async () => {
  budgets.set(2, { amount: VICTIM_AMOUNT, skipped: false }); // the victim's MIN
  budgets.set(4, { amount: null, skipped: true });

  const res = await call('POST', `/api/budget/${FLOCK_ID}/submit`, 1, { amount: 90 });

  assert.strictEqual(res.status, 200, res.text);
  // A new key in this list is a privacy review, not a merge.
  assert.deepStrictEqual(Object.keys(res.body).sort(), [
    'ceiling', 'isReady', 'skipCount', 'submissionCount', 'submitted', 'totalMembers', 'userSubmitted',
  ]);
  assert.strictEqual(res.body.isReady, false, 'two non-skips must not be ready');
  assert.strictEqual(res.body.ceiling, null, 'ceiling revealed below the 3-submission threshold');
  assert.ok(!res.text.includes('47.13'), `individual amount leaked: ${res.text}`);
  assertQueriesUnderstood();
});

test('budget: the socket fan-out payload is aggregate-only and withheld below 3', async () => {
  budgets.set(2, { amount: VICTIM_AMOUNT, skipped: false });

  await call('POST', `/api/budget/${FLOCK_ID}/submit`, 1, { amount: 90 });

  const updates = emitted.filter((e) => e.event === 'budget_updated');
  assert.ok(updates.length > 0, 'no budget_updated fan-out');
  for (const u of updates) {
    assert.deepStrictEqual(Object.keys(u.payload).sort(),
      ['ceiling', 'flockId', 'isReady', 'skipCount', 'submissionCount', 'totalMembers']);
    assert.strictEqual(u.payload.ceiling, null);
    assert.ok(!JSON.stringify(u.payload).includes('47.13'), 'individual amount reached the socket wire');
  }
  assertQueriesUnderstood();
});

test('budget: GET exposes exactly the documented keys plus the caller own row, and reveals at 3', async () => {
  budgets.set(2, { amount: VICTIM_AMOUNT, skipped: false });
  budgets.set(3, { amount: 60, skipped: false });
  budgets.set(1, { amount: 90, skipped: false });
  flock.budget_ceiling = String(VICTIM_AMOUNT);

  const res = await call('GET', `/api/budget/${FLOCK_ID}`, 1);

  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(Object.keys(res.body).sort(), [
    'budgetContext', 'budgetEnabled', 'budgetLocked', 'ceiling', 'isReady',
    'skipCount', 'submissionCount', 'totalMembers', 'userAmount', 'userSkipped', 'userSubmitted',
  ]);
  // At 3 non-skips an aggregate is allowed out — the control that this suite
  // has not silently pushed the feature into never-reveal.
  //
  // This used to assert VICTIM_AMOUNT exactly, and that was the bug: the MIN a
  // three-person flock publishes IS one person's number, and two of those three
  // can be the attacker and a sockpuppet (audit finding M1). The reveal is now
  // banded, so 47.13 publishes as 45 and the value the wire carries is not
  // anybody's figure.
  assert.strictEqual(res.body.isReady, true);
  assert.strictEqual(res.body.ceiling, 45);
  assert.ok(!res.text.includes('47.13'), `banded GET still leaked the exact MIN: ${res.text}`);
  // Only the CALLER's own amount, never a neighbour's, in the user fields.
  assert.strictEqual(res.body.userAmount, 90);
  assertQueriesUnderstood();
});

test('budget: GET below the threshold reveals no number even though the cached ceiling holds one', async () => {
  budgets.set(2, { amount: VICTIM_AMOUNT, skipped: false });
  budgets.set(4, { amount: null, skipped: true });
  flock.budget_ceiling = String(VICTIM_AMOUNT); // cached from the 2-submission state

  const res = await call('GET', `/api/budget/${FLOCK_ID}`, 1);

  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.ceiling, null);
  assert.strictEqual(res.body.userAmount, null);
  assert.ok(!res.text.includes('47.13'), `individual amount leaked: ${res.text}`);
  assertQueriesUnderstood();
});

test('budget: GET counts BEFORE it reads the cached ceiling (statement order is the race fix)', async () => {
  // Two autocommit statements, two snapshots. If the ceiling were read first
  // and the count second, a third submission committing in between pairs a
  // ">= 3, reveal" verdict with a ceiling cached over TWO amounts — a MIN of
  // two people, which is one person's number to the other. Counting first
  // makes a crossing mid-GET err to "withhold".
  await call('GET', `/api/budget/${FLOCK_ID}`, 1);

  const countIdx = queries.findIndex((q) => q.sql.includes('total_submissions'));
  const ceilingIdx = queries.findIndex((q) => q.sql.includes('budget_enabled, budget_context'));
  assert.ok(countIdx >= 0 && ceilingIdx >= 0, 'expected both statements to run');
  assert.ok(countIdx < ceilingIdx,
    'the reveal decision must come from a count snapshot no NEWER than the ceiling it publishes');
  assertQueriesUnderstood();
});

test('budget: lock refuses below 3 non-skips and leaks no amount doing it', async () => {
  budgets.set(2, { amount: VICTIM_AMOUNT, skipped: false });
  budgets.set(3, { amount: null, skipped: true });

  const res = await call('POST', `/api/budget/${FLOCK_ID}/lock`, 1);

  assert.strictEqual(res.status, 400, res.text);
  assert.ok(!res.text.includes('47.13'), `lock refusal leaked an amount: ${res.text}`);
  assertQueriesUnderstood();
});

// ===========================================================================
// 1b. Banding: the published ceiling is never one person's exact number
// ===========================================================================
//
// Money security audit 2026-08-16, finding M1 (HIGH). The >= 3 threshold counts
// SUBMISSIONS, not independent people, and the flock creator chooses who is in
// the flock. Two accounts under one attacker submitting $9,999 each make the
// third person's amount the MIN, and the MIN used to be published verbatim: the
// victim's exact budget, handed to the person who arranged it.
//
// Collusion cannot be designed away, because colluders know their own numbers
// and can subtract them out. What CAN be removed is the exactness, so these
// pin that the number leaving the server is a band, that the band is never
// above the true MIN, and that every surface publishes the SAME band.

// raw MIN -> what the group is allowed to see.
const RAW_TO_BAND = [
  [0.01, 0.01], [0.75, 0.01], [0.99, 0.01],   // below the smallest band
  [1, 1], [1.01, 1], [4.99, 4],               // nearest $1 down
  [5, 5], [12.5, 10], [47.13, 45], [49.99, 45], // nearest $5 down
  [50, 50], [55, 50], [59.99, 50],            // nearest $10 down
  [100, 100], [9999, 9990], [10000, 10000],   // and up to the validator's max
];

test('budget: the banding rule rounds to the band, never upward, and is idempotent', () => {
  for (const [raw, want] of RAW_TO_BAND) {
    assert.strictEqual(budgetRouter.bandCeiling(raw), want, `bandCeiling(${raw})`);
  }

  // The correctness invariant, swept rather than sampled. A banded ceiling must
  // never exceed the true MIN: the group picks venues under this number, so
  // rounding UP would put a venue somebody cannot afford inside the cap. And it
  // must never be 0, which the app reads as "no ceiling yet".
  for (let cents = 1; cents <= 1000000; cents += 137) {
    const raw = cents / 100;
    const banded = budgetRouter.bandCeiling(raw);
    assert.ok(banded <= raw, `bandCeiling(${raw}) rounded UP to ${banded}`);
    assert.ok(banded > 0, `bandCeiling(${raw}) published 0, which reads as "no ceiling"`);
  }

  // Idempotent, which is what lets flocks.budget_ceiling cache the BANDED value
  // and still be re-banded on every read. Without this, a value would shrink a
  // band each time it round-tripped.
  for (const [raw] of RAW_TO_BAND) {
    const once = budgetRouter.bandCeiling(raw);
    assert.strictEqual(budgetRouter.bandCeiling(once), once,
      `bandCeiling is not idempotent at ${raw}`);
  }

  // No submissions, no ceiling. Not 0, which would read as a real cap of zero.
  assert.strictEqual(budgetRouter.bandCeiling(null), null);
  assert.strictEqual(budgetRouter.bandCeiling(undefined), null);
});

test('budget: two colluding submissions cannot read the third person exact amount', async () => {
  // The M1 exploit, executed. User 1 is the flock creator, user 3 is the
  // sockpuppet; both pin $9,999 so the MIN can only be user 2's real number.
  budgets.set(2, { amount: VICTIM_AMOUNT, skipped: false });
  budgets.set(3, { amount: 9999, skipped: false });

  const res = await call('POST', `/api/budget/${FLOCK_ID}/submit`, 1, { amount: 9999 });

  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.isReady, true, 'three non-skips must still reveal');
  assert.strictEqual(res.body.ceiling, 45, 'the reveal must be the band, not the MIN');
  assert.notStrictEqual(res.body.ceiling, VICTIM_AMOUNT);
  assert.ok(!res.text.includes('47.13'), `the victim's exact amount left the server: ${res.text}`);
  assertQueriesUnderstood();
});

test('budget: the socket fan-out publishes the same banded ceiling the response does', async () => {
  // A raw MIN slipping out through the socket while REST published a band would
  // hand the whole fix back, so the two are compared to each other, not just to
  // a literal.
  budgets.set(2, { amount: VICTIM_AMOUNT, skipped: false });
  budgets.set(3, { amount: 9999, skipped: false });

  const res = await call('POST', `/api/budget/${FLOCK_ID}/submit`, 1, { amount: 9999 });

  const updates = emitted.filter((e) => e.event === 'budget_updated');
  assert.ok(updates.length > 0, 'no budget_updated fan-out');
  for (const u of updates) {
    assert.strictEqual(u.payload.ceiling, res.body.ceiling,
      'the socket and the REST response disagree about the ceiling');
    assert.strictEqual(u.payload.ceiling, 45);
    assert.ok(!JSON.stringify(u.payload).includes('47.13'), 'the raw MIN reached the socket wire');
  }
  assertQueriesUnderstood();
});

test('budget: the lock response, its socket event and the cached column all carry the band', async () => {
  budgets.set(1, { amount: 9999, skipped: false });
  budgets.set(2, { amount: VICTIM_AMOUNT, skipped: false });
  budgets.set(3, { amount: 9999, skipped: false });

  const res = await call('POST', `/api/budget/${FLOCK_ID}/lock`, 1);

  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.ceiling, 45);
  assert.ok(!res.text.includes('47.13'), `the lock leaked the raw MIN: ${res.text}`);

  const locks = emitted.filter((e) => e.event === 'budget_locked');
  assert.ok(locks.length > 0, 'no budget_locked fan-out');
  for (const l of locks) {
    assert.strictEqual(l.payload.ceiling, res.body.ceiling,
      'the lock socket event and the lock response disagree');
    assert.ok(!JSON.stringify(l.payload).includes('47.13'), 'the raw MIN reached the socket wire');
  }

  // What gets CACHED is the band. This is the part that covers the two readers
  // outside this route — the flock list in routes/flocks.js and the ghost commit
  // in routes/billing.js both read flocks.budget_ceiling and never recompute it.
  assert.strictEqual(Number(flock.budget_ceiling), 45);
  assertQueriesUnderstood();
});

test('budget: a submit caches the band, not the MIN, so downstream readers cannot unbank it', async () => {
  budgets.set(2, { amount: VICTIM_AMOUNT, skipped: false });
  budgets.set(3, { amount: 9999, skipped: false });

  await call('POST', `/api/budget/${FLOCK_ID}/submit`, 1, { amount: 9999 });

  assert.strictEqual(Number(flock.budget_ceiling), 45,
    'flocks.budget_ceiling still holds the raw MIN');
  assertQueriesUnderstood();
});

test('budget: GET re-bands a ceiling that was cached raw before this fix', async () => {
  // Rows written by the pre-M1 code hold the exact MIN. Banding is idempotent,
  // so re-banding on read costs nothing and keeps those rows from publishing an
  // exact amount before someone happens to resubmit.
  budgets.set(1, { amount: 9999, skipped: false });
  budgets.set(2, { amount: VICTIM_AMOUNT, skipped: false });
  budgets.set(3, { amount: 9999, skipped: false });
  flock.budget_ceiling = String(VICTIM_AMOUNT);

  const res = await call('GET', `/api/budget/${FLOCK_ID}`, 1);

  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.isReady, true);
  assert.strictEqual(res.body.ceiling, 45);
  assert.ok(!res.text.includes('47.13'), `a legacy cached MIN reached the wire: ${res.text}`);
  assertQueriesUnderstood();
});

test('budget: banding did not move the threshold or change what a skip means', async () => {
  // Two people shared an amount, two skipped. Still withheld, on the response
  // and on the socket, and submissionCount still counts skips while the
  // threshold does not.
  budgets.set(2, { amount: VICTIM_AMOUNT, skipped: false });
  budgets.set(3, { amount: null, skipped: true });
  budgets.set(4, { amount: null, skipped: true });

  const res = await call('POST', `/api/budget/${FLOCK_ID}/submit`, 1, { amount: 9999 });

  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.isReady, false, 'skips must not count toward the three');
  assert.strictEqual(res.body.ceiling, null, 'a band is still a reveal, and it is still gated');
  assert.strictEqual(res.body.submissionCount, 4, 'submissionCount still counts skips');
  assert.strictEqual(res.body.skipCount, 2);
  for (const u of emitted.filter((e) => e.event === 'budget_updated')) {
    assert.strictEqual(u.payload.ceiling, null, 'the socket revealed below the threshold');
  }

  // And a skip still writes NULL rather than an amount, so it cannot drag the
  // MIN down or push the flock over the threshold.
  const skipRes = await call('POST', `/api/budget/${FLOCK_ID}/submit`, 1, { amount: 0, skipped: true });

  assert.strictEqual(skipRes.status, 200, skipRes.text);
  assert.strictEqual(budgets.get(1).amount, null);
  assert.strictEqual(budgets.get(1).skipped, true);
  assert.strictEqual(skipRes.body.isReady, false);
  assert.strictEqual(skipRes.body.ceiling, null);
  assertQueriesUnderstood();
});

// ===========================================================================
// 2. Budget races and query count
// ===========================================================================

test('budget: concurrent double-submit from one user counts once and crosses the threshold once', async () => {
  budgets.set(1, { amount: 40, skipped: false });
  budgets.set(2, { amount: VICTIM_AMOUNT, skipped: false });

  // User 3's client fires twice (retry over a flaky connection). The upsert
  // plus the FOR UPDATE flock lock must make this ONE submission: without the
  // serialization both transactions read "no prior row, 2 others" and BOTH
  // believe they crossed the threshold — the "Budget set!" push fires twice,
  // and the fixture's in-insert delay guarantees the overlap this needs.
  const [a, b] = await Promise.all([
    call('POST', `/api/budget/${FLOCK_ID}/submit`, 3, { amount: 50 }),
    call('POST', `/api/budget/${FLOCK_ID}/submit`, 3, { amount: 50 }),
  ]);

  assert.strictEqual(a.status, 200, a.text);
  assert.strictEqual(b.status, 200, b.text);
  for (const res of [a, b]) {
    assert.strictEqual(res.body.submissionCount, 3, 'a double-submit double-counted');
    assert.strictEqual(res.body.isReady, true);
    assert.strictEqual(res.body.ceiling, 40);
  }
  assert.strictEqual(budgets.size, 3, 'the upsert wrote a second row for one user');
  // The crossing is announced exactly once: the "Budget set!" path re-reads
  // the flock name, so one name read = one announcement.
  const crossings = queries.filter((q) => q.sql.includes('SELECT name FROM flocks'));
  assert.strictEqual(crossings.length, 1,
    `threshold crossing fired ${crossings.length} times — the race double-announced`);
  assertQueriesUnderstood();
});

test('budget: a plain submit runs 11 statements, with the redundant others-count gone', async () => {
  budgets.set(2, { amount: VICTIM_AMOUNT, skipped: false });

  const res = await call('POST', `/api/budget/${FLOCK_ID}/submit`, 1, { amount: 90 });

  assert.strictEqual(res.status, 200, res.text);
  // Before this pass the submit transaction issued a second COUNT restricted
  // to `user_id != $2` — information the main count already contains, since a
  // submit only ever changes the caller's own row. 12 statements then, 11 now:
  // member check, BEGIN, flock FOR UPDATE, prior row, upsert, MIN, cache
  // write, counts, COMMIT, total members, fan-out roster.
  assert.strictEqual(queries.length, 11,
    `submit issued ${queries.length} statements:\n${queries.map((q) => q.sql).join('\n')}`);
  assert.ok(!queries.some((q) => q.sql.includes('user_id != $2') && q.sql.includes('budget_submissions')),
    'the redundant per-submit others-count is back');
  assertQueriesUnderstood();
});

// ===========================================================================
// 3. Friend request races
// ===========================================================================

test('friends: crossed simultaneous requests converge to ONE accepted row, no 500', async () => {
  // Alice asks Bob while Bob asks Alice. Both pair lookups are held at the
  // barrier so both read "no relationship" — the worst-case interleaving that
  // used to leave two pending rows (and, after both accepted, two friendships
  // on every list).
  gate('pairLookup', 2);
  const [a, b] = await Promise.all([
    call('POST', '/api/friends/request', 1, { user_id: 2 }),
    call('POST', '/api/friends/request', 2, { user_id: 1 }),
  ]);

  assert.ok(a.status < 500 && b.status < 500, `${a.status}/${b.status}: a crossed request 500ed`);
  const rows = pairRows(1, 2);
  assert.strictEqual(rows.length, 1,
    `crossed requests left ${rows.length} rows: ${JSON.stringify(rows)}`);
  assert.strictEqual(rows[0].status, 'accepted',
    'two people who asked for each other at the same instant are two people who agree');
  // One side saw the plain "sent", the other converged the pair.
  assert.deepStrictEqual([a.body.status, b.body.status].sort(), ['accepted', 'pending']);
  assertQueriesUnderstood();
});

test('friends: both sides accepting a crossed pair at once converge to ONE friendship', async () => {
  // The legacy state the insert-time convergence now prevents, seeded
  // directly: two pending rows, one per direction.
  friendships.push({ id: 5, requester_id: 1, addressee_id: 2, status: 'pending' });
  friendships.push({ id: 6, requester_id: 2, addressee_id: 1, status: 'pending' });

  // Hold both accepts at their block pre-check so each UPDATE targets its own
  // row before either cleanup runs — the interleaving that used to mint TWO
  // accepted rows (duplicate friends-list entries), and that a naive "delete
  // the other row" fix turns into ZERO rows.
  gate('blockCheck', 2);
  const [a, b] = await Promise.all([
    call('POST', '/api/friends/accept', 1, { user_id: 2 }),
    call('POST', '/api/friends/accept', 2, { user_id: 1 }),
  ]);

  assert.strictEqual(a.status, 200, a.text);
  assert.strictEqual(b.status, 200, b.text);
  assert.match(a.body.message, /accepted/i);
  assert.match(b.body.message, /accepted/i);
  const rows = pairRows(1, 2);
  assert.strictEqual(rows.length, 1,
    `double accept left ${rows.length} rows: ${JSON.stringify(rows)}`);
  assert.strictEqual(rows[0].status, 'accepted');
  assertQueriesUnderstood();
});

test('friends: two identical requests racing produce one row, one notification, no 500', async () => {
  gate('pairLookup', 2);
  const [a, b] = await Promise.all([
    call('POST', '/api/friends/request', 1, { user_id: 2 }),
    call('POST', '/api/friends/request', 1, { user_id: 2 }),
  ]);

  assert.ok(a.status < 500 && b.status < 500, `${a.status}/${b.status}: the loser of the race 500ed`);
  const rows = pairRows(1, 2);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'pending');
  // Exactly one of the two rang Bob's phone.
  assert.strictEqual(emitted.filter((e) => e.event === 'friend_request_received').length, 1);
  // Both were told the truth in words a client can act on.
  for (const res of [a, b]) {
    assert.strictEqual(res.body.status, 'pending');
    assert.match(res.body.message, /friend request/i);
  }
  assertQueriesUnderstood();
});

// ===========================================================================
// 4. Block interleavings
// ===========================================================================

test('friends: a block landing between the request check and the insert leaves no row behind', async () => {
  // The pre-insert isBlockedBetween answers "not blocked"; the block commits
  // immediately after. The post-write verify must see it, undo the row, and
  // answer the same 403 the pre-check would have.
  onBlockCheck = (nth) => { if (nth === 1) blocks.push([2, 1]); };

  const res = await call('POST', '/api/friends/request', 1, { user_id: 2 });

  assert.strictEqual(res.status, 403, `${res.status} ${res.text}`);
  assert.strictEqual(pairRows(1, 2).length, 0,
    'a pending request survived across a block');
  assert.deepStrictEqual(emitted, [], 'the blocked party was notified anyway');
  assertQueriesUnderstood();
});

test('friends: a block landing between the accept check and the write leaves no friendship standing', async () => {
  friendships.push({ id: 5, requester_id: 2, addressee_id: 1, status: 'pending' });
  onBlockCheck = (nth) => { if (nth === 1) blocks.push([2, 1]); };

  const res = await call('POST', '/api/friends/accept', 1, { user_id: 2 });

  assert.strictEqual(res.status, 404, `${res.status} ${res.text}`);
  assert.strictEqual(pairRows(1, 2).filter((r) => r.status === 'accepted').length, 0,
    'an accepted friendship was minted across the block');
  assert.strictEqual(pairRows(1, 2).length, 0, 'the pair was not separated');
  assert.deepStrictEqual(emitted.filter((e) => e.event === 'friend_request_responded'), [],
    "the accepter's name was pushed into the blocked party's client");
  assertQueriesUnderstood();
});

// ===========================================================================
// 5. Error semantics: expected conflicts never 500
// ===========================================================================

test('friends: re-requesting over a legacy crossed-declined pair reports state instead of 500ing', async () => {
  // Two declined rows, one per direction — only legacy data can hold this
  // shape (decline deletes today), and the ordered lookup picks the lower id:
  // the OPPOSITE direction. Re-requesting flips that row's direction onto a
  // key the second row already occupies: 23505, which used to reach the outer
  // catch as a 500 for a tap on an ordinary button.
  friendships.push({ id: 5, requester_id: 2, addressee_id: 1, status: 'declined' });
  friendships.push({ id: 6, requester_id: 1, addressee_id: 2, status: 'declined' });

  const res = await call('POST', '/api/friends/request', 1, { user_id: 2 });

  assert.notStrictEqual(res.status, 500, `constraint violation surfaced as ${res.status}: ${res.text}`);
  assert.strictEqual(res.status, 200, res.text);
  assert.ok(res.body.message, 'no human-readable message on the conflict answer');
  assertQueriesUnderstood();
});

test('friends: duplicate and already-friends taps get clear answers, never constraint 500s', async () => {
  // Already friends.
  friendships.push({ id: 5, requester_id: 2, addressee_id: 1, status: 'accepted' });
  let res = await call('POST', '/api/friends/request', 1, { user_id: 2 });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.status, 'accepted');
  assert.match(res.body.message, /already friends/i);

  // Accepting a request that does not exist: a clean 404 in words.
  res = await call('POST', '/api/friends/accept', 1, { user_id: 3 });
  assert.strictEqual(res.status, 404, res.text);
  assert.match(res.body.error, /no pending request/i);

  // Accepting a second time after the friendship exists: the accept already
  // happened, and "no pending request from this user" about a current friend
  // is the race leaking into the UI — it reports the accepted state instead.
  res = await call('POST', '/api/friends/accept', 1, { user_id: 2 });
  assert.strictEqual(res.status, 200, res.text);
  assert.match(res.body.message, /accepted/i);
  assertQueriesUnderstood();
});

// ===========================================================================
// 6. find-by-phone: the batched friendship read stays batched
// ===========================================================================

test('friends: contact sync asks for N friendship statuses with ONE query, not N', async () => {
  phones.set(2, '2025550101');
  phones.set(3, '2025550102');
  phones.set(4, '2025550103');
  // All three opted in. Without that they are not in the index at all, which is
  // the point of migration 051 and is covered on its own in contactDiscovery.
  discoverable.add(2); discoverable.add(3); discoverable.add(4);
  friendships.push({ id: 5, requester_id: 1, addressee_id: 2, status: 'accepted' });
  friendships.push({ id: 6, requester_id: 3, addressee_id: 1, status: 'pending' });

  const res = await call('POST', '/api/friends/find-by-phone', 1, {
    phones: ['+1 (202) 555-0101', '+1 (202) 555-0102', '+1 (202) 555-0103'],
  });

  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.users.length, 3);
  const byId = Object.fromEntries(res.body.users.map((u) => [u.id, u.friendship_status]));
  assert.strictEqual(byId[2], 'accepted');
  assert.strictEqual(byId[3], 'pending');
  assert.strictEqual(byId[4], null);
  // Three matches, ONE friendships statement — the ANY($2::int[]) batch. A
  // per-match loop would be 3 here and 200 at the cap.
  const friendshipReads = queries.filter((q) => q.sql.includes('FROM friendships'));
  assert.strictEqual(friendshipReads.length, 1,
    `expected 1 batched friendship read, saw ${friendshipReads.length}`);
  assert.ok(friendshipReads[0].sql.includes('ANY($2::int[])'));
  // And no per-user phone probes either: one directory lookup.
  const directoryReads = queries.filter((q) => q.sql.includes('phone_hash = ANY'));
  assert.strictEqual(directoryReads.length, 1);
  assertQueriesUnderstood();
});
