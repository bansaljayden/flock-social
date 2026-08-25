// Run: node --test  (from backend/)
//
// ─────────────────────────────────────────────────────────────────────────────
// GAME-RULE ABUSE — the reliability score (routes/flocks.js)
// ─────────────────────────────────────────────────────────────────────────────
//
// __tests__/reliabilitySelfCredit.test.js closed the SOLO case: a flock earns
// nothing unless it has two accepted members. This file attacks what the
// two-member bar does NOT price, using the same semantic in-memory world so
// every result below is behavior, not a string match.
//
// Three findings are pinned here, all of them currently REPRODUCIBLE:
//
//   A. PAIR FARMING. The bar is "two accepted members", and nothing else. Two
//      cooperating accounts can mint an unlimited number of qualifying flocks
//      with no venue, no event and no elapsed time: create, accept, flip to
//      completed, mark both attended. Four requests per point of reputation.
//
//   B. NO CLOCK. POST /:id/attendance requires status = 'completed' and
//      nothing more. PUT /:id lets the creator set that status at any moment,
//      and neither route ever compares event_time to NOW(). A flock whose
//      event is a week in the FUTURE can be completed and credited today.
//
//   C. FLAKE ERASURE. A no_show lives in flock_members, and POST /:id/leave
//      DELETEs that row with no status check on the flock. So a user marked
//      no_show on a real completed flock can leave it, and the next recompute
//      (which they can trigger themselves, via A) tallies over what is left.
//      The flake is gone from both the numerator and the denominator.
//
// And one rule that HOLDS, asserted so it stays that way:
//
//   D. A non-creator cannot mark attendance, so the pair still needs the other
//      account to accept. Reputation damage to a stranger is not reachable
//      from this route without their acceptance.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'abuse-reliability-farming-test-secret';

const pool = require('../config/database');

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };
// requireVerified is a separate export used by /invite and /rerun.
const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => ({ skipped: true, reason: 'test' });
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true, reason: 'test' });
pushMod.pushAlways = async () => ({ skipped: true, reason: 'test' });

// ── The semantic world ───────────────────────────────────────────────────────
let world;
function freshWorld() {
  return { users: new Map(), flocks: new Map(), members: [], nextFlockId: 500 };
}
function acceptedCount(flockId) {
  return world.members.filter((m) => m.flock_id === flockId && m.status === 'accepted').length;
}
function member(flockId, userId) {
  return world.members.find((m) => m.flock_id === flockId && m.user_id === userId);
}

let log = [];
// The `assertQueriesUnderstood` role in this file: every statement the routers
// send has to be modelled. An unmodelled one throws rather than being answered
// with an empty result, which is what lets a test pass for the wrong reason.
let unknown = [];
function assertQueriesUnderstood() {
  assert.deepStrictEqual(unknown, [], `unmodelled queries: ${JSON.stringify(unknown.slice(0, 3))}`);
}

async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  const p = params || [];

  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(flat)) return { rows: [], rowCount: 0 };

  // ── PUT /:id ──────────────────────────────────────────────────────────────
  if (/^SELECT creator_id FROM flocks WHERE id = \$1$/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    return f ? { rows: [{ creator_id: f.creator_id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^UPDATE flocks SET name = COALESCE/.test(flat)) {
    const f = world.flocks.get(Number(p[10]));
    if (!f) return { rows: [], rowCount: 0 };
    if (p[8] != null) f.event_time = p[8];
    if (p[9] != null) f.status = p[9];
    return { rows: [{ ...f, created_at: f.created_at, budget_ceiling: null, budget_enabled: false }], rowCount: 1 };
  }
  // Research-analytics side effects of a completion. Modelled, not swallowed.
  if (/^SELECT COUNT\(\*\) AS cnt FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'$/.test(flat)) {
    return { rows: [{ cnt: String(acceptedCount(Number(p[0]))) }], rowCount: 1 };
  }
  if (/FROM budget_submissions WHERE flock_id = \$1$/.test(flat) && /sub_count/.test(flat)) {
    return { rows: [{ sub_count: '0', skip_count: '0' }], rowCount: 1 };
  }
  if (/^INSERT INTO research_analytics/.test(flat)) return { rows: [], rowCount: 1 };

  // ── POST /:id/attendance ──────────────────────────────────────────────────
  if (/SELECT creator_id, status, name FROM flocks WHERE id = \$1/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    return f ? { rows: [{ creator_id: f.creator_id, status: f.status, name: f.name }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/UPDATE flock_members SET attendance = t\.mark/.test(flat)) {
    let n = 0;
    (p[0] || []).forEach((uid, i) => {
      const fm = member(Number(p[2]), uid);
      if (fm && fm.status === 'accepted') { fm.attendance = p[1][i]; n += 1; }
    });
    return { rows: [], rowCount: n };
  }
  if (/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'$/.test(flat)) {
    const rows = world.members
      .filter((m) => m.flock_id === Number(p[0]) && m.status === 'accepted')
      .map((m) => ({ user_id: m.user_id }));
    return { rows, rowCount: rows.length };
  }
  // THE TALLY — guards applied exactly where the arriving SQL carries them.
  if (/FROM UNNEST\(\$1::int\[\]\) AS t\(uid\)/.test(flat) && /joined/.test(flat)) {
    const joinedClause = flat.slice(0, flat.indexOf('AS joined'));
    const attendedClause = flat.slice(flat.indexOf('AS joined'), flat.indexOf('AS attended'));
    const joinedGuarded = /mc\.accepted_count >= 2/.test(joinedClause);
    const attendedGuarded = /mc\.accepted_count >= 2/.test(attendedClause);
    const rows = (p[0] || []).map((uid) => {
      let joined = 0;
      let attended = 0;
      for (const fm of world.members.filter((m) => m.user_id === uid)) {
        const f = world.flocks.get(fm.flock_id);
        if (!f) continue;
        const real = acceptedCount(fm.flock_id) >= 2;
        if (f.status === 'completed' && fm.status === 'accepted' && fm.attendance !== 'unmarked'
            && (!joinedGuarded || real)) joined += 1;
        if (f.status === 'completed' && fm.attendance === 'attended'
            && (!attendedGuarded || real)) attended += 1;
      }
      return { uid, joined, attended };
    });
    return { rows, rowCount: rows.length };
  }
  if (/UPDATE users SET reliability_score = t\.score/.test(flat)) {
    (p[0] || []).forEach((uid, i) => {
      world.users.set(uid, {
        reliability_score: p[1][i],
        total_plans_joined: p[2][i],
        total_plans_attended: p[3][i],
      });
    });
    return { rows: [], rowCount: (p[0] || []).length };
  }

  // ── POST /:id/leave ───────────────────────────────────────────────────────
  if (/^SELECT id, name, creator_id FROM flocks WHERE id = \$1$/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    return f ? { rows: [{ id: f.id, name: f.name, creator_id: f.creator_id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^SELECT status FROM flock_members WHERE flock_id = \$1 AND user_id = \$2$/.test(flat)) {
    const fm = member(Number(p[0]), Number(p[1]));
    return fm ? { rows: [{ status: fm.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^DELETE FROM flock_members WHERE flock_id = \$1 AND user_id = \$2$/.test(flat)) {
    const before = world.members.length;
    world.members = world.members.filter((m) => !(m.flock_id === Number(p[0]) && m.user_id === Number(p[1])));
    return { rows: [], rowCount: before - world.members.length };
  }
  if (/^SELECT COUNT\(\*\) AS cnt FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'/.test(flat)) {
    return { rows: [{ cnt: String(acceptedCount(Number(p[0]))) }], rowCount: 1 };
  }
  if (/^DELETE FROM flocks WHERE id = \$1$/.test(flat)) {
    world.flocks.delete(Number(p[0]));
    world.members = world.members.filter((m) => m.flock_id !== Number(p[0]));
    return { rows: [], rowCount: 1 };
  }

  // hasMembershipRow (the 404-vs-403 gate)
  if (/^SELECT 1 FROM flock_members WHERE flock_id = \$1 AND user_id = \$2/.test(flat)) {
    const fm = member(Number(p[0]), Number(p[1]));
    return fm ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  unknown.push(flat.slice(0, 160));
  throw new Error(`unscripted query: ${flat.slice(0, 160)}`);
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => dispatch(sql, params),
  release: () => {},
});

const flocksRouter = require('../routes/flocks');

const app = express();
app.use(express.json());
app.set('io', null);
app.use('/api/flocks', flocksRouter);

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
  world = freshWorld();
  log = [];
  unknown = [];
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

// The farm: a flock that exists only in the database, created by A, accepted
// by B. Seeded directly because POST / is not the finding; what it costs the
// attacker is one authenticated request per flock either way.
function seedPairFlock(id, a, b, { status = 'confirmed', eventTime = new Date().toISOString() } = {}) {
  world.flocks.set(id, {
    id, creator_id: a, status, name: 'Farm', venue_id: null,
    event_time: eventTime, created_at: new Date().toISOString(),
  });
  world.members.push(
    { flock_id: id, user_id: a, status: 'accepted', attendance: 'unmarked' },
    { flock_id: id, user_id: b, status: 'accepted', attendance: 'unmarked' },
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// A. PAIR FARMING — two accounts, unlimited perfect reputation
// ═════════════════════════════════════════════════════════════════════════════

test('ABUSE A: two accounts mint a perfect 100 with no venue, no event and no elapsed time', async () => {
  const A = 41;
  const B = 42;
  CURRENT_USER = { id: A, name: 'Mallory', email_verified: true, role: 'user' };

  // One cycle: the flock exists, B has accepted, A completes it and marks both
  // present. Two HTTP requests per cycle on top of create + accept.
  seedPairFlock(600, A, B);
  const put = await call('PUT', '/api/flocks/600', { status: 'completed' });
  assert.strictEqual(put.status, 200, put.text);

  const res = await call('POST', '/api/flocks/600/attendance', {
    attendance: [{ userId: A, attended: true }, { userId: B, attended: true }],
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.results, [
    { userId: A, reliabilityScore: 100, totalPlansJoined: 1, totalPlansAttended: 1 },
    { userId: B, reliabilityScore: 100, totalPlansJoined: 1, totalPlansAttended: 1 },
  ], 'the two-member bar is satisfied by a second account that only had to click accept');
  assertQueriesUnderstood();
});

test('ABUSE A2: the loop scales — total_plans_attended is the number of farm cycles run', async () => {
  const A = 51;
  const B = 52;
  CURRENT_USER = { id: A, name: 'Mallory', email_verified: true, role: 'user' };

  // Twelve cycles. Nothing in the tally caps how many flocks one pair may
  // count, distinguishes them by venue, or requires any gap between them.
  for (let i = 0; i < 12; i += 1) {
    const id = 700 + i;
    seedPairFlock(id, A, B);
    await call('PUT', `/api/flocks/${id}`, { status: 'completed' });
    await call('POST', `/api/flocks/${id}/attendance`, {
      attendance: [{ userId: A, attended: true }, { userId: B, attended: true }],
    });
  }

  assert.deepStrictEqual(world.users.get(A), {
    reliability_score: 100, total_plans_joined: 12, total_plans_attended: 12,
  }, 'twelve "plans attended" the app has no evidence for');
  assert.deepStrictEqual(world.users.get(B), {
    reliability_score: 100, total_plans_joined: 12, total_plans_attended: 12,
  });
  assertQueriesUnderstood();
});

test('ABUSE A3: farming DILUTES a real flake — 1 genuine no_show plus 9 farm cycles reads as 90', async () => {
  const A = 61;
  const B = 62;
  // A stood a real group up: a genuine 5-person flock marked no_show by its
  // real creator. Honest score: 0 out of 1.
  world.flocks.set(800, {
    id: 800, creator_id: 99, status: 'completed', name: 'Real plan', venue_id: 'ChIJreal0000000001',
    event_time: new Date(Date.now() - 86400e3).toISOString(), created_at: new Date().toISOString(),
  });
  world.members.push(
    { flock_id: 800, user_id: A, status: 'accepted', attendance: 'no_show' },
    { flock_id: 800, user_id: 99, status: 'accepted', attendance: 'attended' },
  );

  CURRENT_USER = { id: A, name: 'Mallory', email_verified: true, role: 'user' };
  for (let i = 0; i < 9; i += 1) {
    const id = 810 + i;
    seedPairFlock(id, A, B);
    await call('PUT', `/api/flocks/${id}`, { status: 'completed' });
    await call('POST', `/api/flocks/${id}/attendance`, {
      attendance: [{ userId: A, attended: true }, { userId: B, attended: true }],
    });
  }

  assert.deepStrictEqual(world.users.get(A), {
    reliability_score: 90, total_plans_joined: 10, total_plans_attended: 9,
  }, 'a flake that should read 0 now reads 90, for the price of 9 scripted cycles');
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// B. NO CLOCK — credit lands before the event it certifies
// ═════════════════════════════════════════════════════════════════════════════

test('ABUSE B: a flock whose event is a WEEK AWAY can be completed and credited today', async () => {
  const A = 71;
  const B = 72;
  CURRENT_USER = { id: A, name: 'Mallory', email_verified: true, role: 'user' };

  const nextWeek = new Date(Date.now() + 7 * 86400e3).toISOString();
  seedPairFlock(900, A, B, { eventTime: nextWeek });

  const put = await call('PUT', '/api/flocks/900', { status: 'completed' });
  assert.strictEqual(put.status, 200, put.text);
  assert.strictEqual(world.flocks.get(900).status, 'completed',
    'PUT /:id never compares event_time to NOW() before accepting status=completed');

  const res = await call('POST', '/api/flocks/900/attendance', {
    attendance: [{ userId: A, attended: true }, { userId: B, attended: true }],
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.results[0].reliabilityScore, 100,
    'attendance is certified for an evening that has not happened');
  assert.strictEqual(new Date(world.flocks.get(900).event_time).getTime() > Date.now(), true,
    'and the event_time is still in the future when the credit lands');
  assertQueriesUnderstood();
});

test('ABUSE B2: event_time can also be REWRITTEN on the same request that completes the flock', async () => {
  const A = 76;
  const B = 77;
  CURRENT_USER = { id: A, name: 'Mallory', email_verified: true, role: 'user' };
  seedPairFlock(910, A, B, { eventTime: new Date(Date.now() + 7 * 86400e3).toISOString() });

  // One PUT can backdate the plan AND close it, so a farm cycle can be made to
  // look like a plan from any date the attacker likes.
  const backdated = new Date(Date.now() - 45 * 86400e3).toISOString();
  const put = await call('PUT', '/api/flocks/910', { status: 'completed', event_time: backdated });
  assert.strictEqual(put.status, 200, put.text);
  assert.strictEqual(world.flocks.get(910).event_time, backdated);
  assert.strictEqual(world.flocks.get(910).status, 'completed');
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// C. FLAKE ERASURE — leaving a COMPLETED flock deletes the evidence
// ═════════════════════════════════════════════════════════════════════════════

test('ABUSE C: a user marked no_show leaves the completed flock and the flake vanishes on the next recompute', async () => {
  const M = 81;   // the flake
  const H = 82;   // the honest host who marked them
  const P = 83;   // the flake's puppet, for the recompute trigger

  // 1. A real completed flock. The host marks M as a no-show. This is the
  //    entire purpose of the anti-flake system.
  world.flocks.set(1000, {
    id: 1000, creator_id: H, status: 'completed', name: 'Dinner', venue_id: 'ChIJreal0000000002',
    event_time: new Date(Date.now() - 86400e3).toISOString(), created_at: new Date().toISOString(),
  });
  world.members.push(
    { flock_id: 1000, user_id: H, status: 'accepted', attendance: 'unmarked' },
    { flock_id: 1000, user_id: M, status: 'accepted', attendance: 'unmarked' },
  );
  CURRENT_USER = { id: H, name: 'Hana', email_verified: true, role: 'user' };
  const marked = await call('POST', '/api/flocks/1000/attendance', {
    attendance: [{ userId: H, attended: true }, { userId: M, attended: false }],
  });
  assert.strictEqual(marked.status, 200, marked.text);
  assert.deepStrictEqual(world.users.get(M), {
    reliability_score: 0, total_plans_joined: 1, total_plans_attended: 0,
  }, 'the flake is on the record');

  // 2. M leaves the flock. It is COMPLETED and MARKED, and POST /:id/leave
  //    checks neither: it deletes the flock_members row outright.
  CURRENT_USER = { id: M, name: 'Mallory', email_verified: true, role: 'user' };
  const left = await call('POST', '/api/flocks/1000/leave');
  assert.strictEqual(left.status, 200, left.text);
  assert.strictEqual(member(1000, M), undefined,
    'the no_show row is gone; nothing in the leave path refuses a finished flock');
  assert.strictEqual(world.flocks.has(1000), true,
    'the host still has their own row, so the flock survives and the erasure is silent');

  // 3. The score itself is stale until something recomputes it. M triggers the
  //    recompute themselves with one farm cycle (finding A).
  seedPairFlock(1010, M, P);
  await call('PUT', '/api/flocks/1010', { status: 'completed' });
  const res = await call('POST', '/api/flocks/1010/attendance', {
    attendance: [{ userId: M, attended: true }, { userId: P, attended: true }],
  });
  assert.strictEqual(res.status, 200, res.text);

  assert.deepStrictEqual(world.users.get(M), {
    reliability_score: 100, total_plans_joined: 1, total_plans_attended: 1,
  }, 'the recorded flake is not merely outweighed, it is ERASED: the denominator went back to 1');
  assertQueriesUnderstood();
});

test('ABUSE C2: leaving is refused nowhere on a completed flock, and the host is told nothing that says "score"', async () => {
  const M = 91;
  const H = 92;
  world.flocks.set(1100, {
    id: 1100, creator_id: H, status: 'completed', name: 'Brunch', venue_id: 'ChIJreal0000000003',
    event_time: new Date(Date.now() - 3600e3).toISOString(), created_at: new Date().toISOString(),
  });
  world.members.push(
    { flock_id: 1100, user_id: H, status: 'accepted', attendance: 'attended' },
    { flock_id: 1100, user_id: M, status: 'accepted', attendance: 'no_show' },
  );
  CURRENT_USER = { id: M, name: 'Mallory', email_verified: true, role: 'user' };

  const left = await call('POST', '/api/flocks/1100/leave');
  assert.strictEqual(left.status, 200, 'a completed, already-marked flock accepts a leave');
  assert.strictEqual(left.body.deleted, false);
  // Nothing in the leave path reads or writes users.reliability_score.
  assert.strictEqual(
    log.some((q) => /reliability_score/.test(q.sql)),
    false,
    'leave never touches the score, so the erasure is invisible until the next recompute',
  );
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// D. WHAT HELD — attacked, and it refused
// ═════════════════════════════════════════════════════════════════════════════

test('HELD: a non-creator member cannot mark attendance, so a stranger cannot be scored by force', async () => {
  const A = 101;
  const V = 102;
  world.flocks.set(1200, {
    id: 1200, creator_id: V, status: 'completed', name: 'Not yours', venue_id: null,
    event_time: new Date(Date.now() - 3600e3).toISOString(), created_at: new Date().toISOString(),
  });
  world.members.push(
    { flock_id: 1200, user_id: V, status: 'accepted', attendance: 'unmarked' },
    { flock_id: 1200, user_id: A, status: 'accepted', attendance: 'unmarked' },
  );
  CURRENT_USER = { id: A, name: 'Mallory', email_verified: true, role: 'user' };

  const res = await call('POST', '/api/flocks/1200/attendance', {
    attendance: [{ userId: V, attended: false }],
  });
  assert.strictEqual(res.status, 403, res.text);
  assert.strictEqual(world.users.has(V), false, 'no score was written');
  assertQueriesUnderstood();
});

test('HELD: an INVITED (never accepted) second account does not make a farm flock count', async () => {
  const A = 111;
  const B = 112;
  CURRENT_USER = { id: A, name: 'Mallory', email_verified: true, role: 'user' };
  world.flocks.set(1300, {
    id: 1300, creator_id: A, status: 'completed', name: 'Ghost', venue_id: null,
    event_time: new Date().toISOString(), created_at: new Date().toISOString(),
  });
  world.members.push(
    { flock_id: 1300, user_id: A, status: 'accepted', attendance: 'unmarked' },
    { flock_id: 1300, user_id: B, status: 'invited', attendance: 'unmarked' },
  );

  const res = await call('POST', '/api/flocks/1300/attendance', {
    attendance: [{ userId: A, attended: true }],
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.results, [
    { userId: A, reliabilityScore: null, totalPlansJoined: 0, totalPlansAttended: 0 },
  ], 'the puppet has to actually accept; a sprayed invite buys nothing');
  assertQueriesUnderstood();
});

test('HELD: attendance cannot be marked on a flock that is not completed', async () => {
  const A = 121;
  const B = 122;
  CURRENT_USER = { id: A, name: 'Mallory', email_verified: true, role: 'user' };
  seedPairFlock(1400, A, B, { status: 'confirmed' });

  const res = await call('POST', '/api/flocks/1400/attendance', {
    attendance: [{ userId: A, attended: true }, { userId: B, attended: true }],
  });
  assert.strictEqual(res.status, 400, res.text);
  assert.strictEqual(world.users.has(A), false);
  // The cost of getting past this is exactly one more request (finding B).
  assertQueriesUnderstood();
});
