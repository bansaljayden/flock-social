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
// Three findings were pinned here. Each is now asserted in its FIXED form, and
// the honest behaviour each fix could have broken is asserted next to it:
//
//   A. PAIR FARMING IS BOUNDED BY THE CALENDAR. The bar used to be "two
//      accepted members" and nothing else, so two cooperating accounts minted
//      unlimited reputation: create, accept, flip to completed, mark both
//      attended, repeat, four requests per point. Credited plans are now
//      counted by DISTINCT time slot rather than by row, because a person
//      cannot be in two places at once. Twelve loops in one second are one
//      evening and earn one point. Earning a second one means waiting for a
//      second slot to actually arrive.
//
//      And the plan a real group made an hour ago still counts. That case is
//      asserted first, because it is the one every clock on this route would
//      have broken and the one the app exists for.
//
//   B. THE CLOCK. A flock whose event is a week away can still be marked
//      completed (nothing refuses the host), but it earns nothing until the
//      event has actually started. What is refused outright is INVENTING the
//      past: PUT /:id will not set event_time earlier than created_at, and will
//      not rewrite it at all once the flock is completed. Without that floor
//      every clock here would be decoration, because the attacker got to say
//      when the event was.
//
//   C. FLAKE ERASURE. A user marked no_show on a completed flock could leave
//      it and take the evidence with them, and the recompute (which they can
//      trigger themselves) tallied over what remained, removing the flake from
//      the DENOMINATOR too. Leaving a COMPLETED flock is now refused: it is a
//      record, not a plan, so there is no commitment to be released from.
//      Leaving anything that is still a plan is untouched.
//
//      The cheaper version (accept, do not turn up, leave before the host
//      marks) is NOT closed, and this file says so in behavior: it now asserts
//      that the host is at least TOLD, on the response, that the person they
//      named was not recorded. Closing it properly needs a membership row that
//      survives departure, which needs a migration and a product decision.
//
// And the rules that HOLD, asserted so they stay that way:
//
//   D. A non-creator cannot mark attendance, an invited-but-not-accepted second
//      account does not make a farm flock count, and attendance is refused on a
//      flock that is not completed.
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
let tallySql = null;
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
  // The event_time floor: PUT reads created_at + status only when the body
  // actually carries an event_time.
  if (/^SELECT created_at, status FROM flocks WHERE id = \$1$/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    return f ? { rows: [{ created_at: f.created_at, status: f.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
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
  // THE TALLY — every guard is applied exactly where the arriving SQL carries
  // it, so this fixture behaves like Postgres would on whatever routes/flocks.js
  // currently says, and a reverted guard re-opens the exploit here in behavior
  // rather than going green on a string that no longer means anything.
  if (/FROM UNNEST\(\$1::int\[\]\) AS t\(uid\)/.test(flat) && /joined/.test(flat)) {
    tallySql = flat;
    const joinedClause = flat.slice(0, flat.indexOf('AS joined'));
    const attendedClause = flat.slice(flat.indexOf('AS joined'), flat.indexOf('AS attended'));
    const pairBar = (clause) => /mc\.accepted_count >= 2/.test(clause);
    const clockBar = (clause) => /ev\.started/.test(clause);
    // COUNT(DISTINCT ...) over ev.slot is the one-plan-at-a-time rule; without
    // it the counts are per ROW, which is what pair farming lived on.
    const slotted = /COUNT\(DISTINCT/.test(flat);
    // The slot width is read out of the statement rather than restated here, so
    // retuning the constant in routes/flocks.js retunes this model with it.
    const slotSeconds = Number((flat.match(/\/ (\d+)\)/) || [])[1] || 0);
    // A slot that contains a no_show cannot count as attended.
    const flakeWins = /NOT ev\.slot_flaked/.test(attendedClause);

    const when = (f) => new Date(f.event_time || f.created_at).getTime();
    const started = (f) => when(f) <= Date.now();
    const slotOf = (f, fallback) =>
      (slotted && slotSeconds ? `s${Math.floor(when(f) / 1000 / slotSeconds)}` : `row${fallback}`);

    const rows = (p[0] || []).map((uid) => {
      const joinedKeys = new Set();
      const attendedKeys = new Set();
      const flakedSlots = new Set();
      let row = 0;
      for (const fm of world.members.filter((m) => m.user_id === uid)) {
        row += 1;
        const f = world.flocks.get(fm.flock_id);
        if (!f) continue;
        const real = acceptedCount(fm.flock_id) >= 2;
        const key = slotOf(f, row);
        if (f.status === 'completed' && fm.status === 'accepted' && fm.attendance !== 'unmarked'
            && (!pairBar(joinedClause) || real)
            && (!clockBar(joinedClause) || started(f))) joinedKeys.add(key);
        if (f.status === 'completed' && fm.attendance === 'attended'
            && (!pairBar(attendedClause) || real)
            && (!clockBar(attendedClause) || started(f))) attendedKeys.add(key);
        // The LATERAL's EXISTS: an accepted no_show on a completed, started,
        // two-or-more-member flock poisons its whole slot for `attended`.
        if (f.status === 'completed' && fm.status === 'accepted' && fm.attendance === 'no_show'
            && real && started(f)) flakedSlots.add(key);
      }
      const attended = [...attendedKeys].filter((k) => !flakeWins || !flakedSlots.has(k)).length;
      return { uid, joined: joinedKeys.size, attended };
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
  if (/^SELECT id, name, creator_id, status FROM flocks WHERE id = \$1$/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    return f
      ? { rows: [{ id: f.id, name: f.name, creator_id: f.creator_id, status: f.status }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
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
  // The non-creator leave is one statement now: drop the membership and, if
  // nobody accepted remains, the flock, together or not at all. Mirror the
  // route's own semantics: the leaver's row is excluded by id, and a request
  // from a non-member deletes nothing.
  // The flock row lock the leave path takes before its CTE (same lock billing holds).
  if (/^SELECT id FROM flocks WHERE id = \$1 FOR UPDATE$/.test(flat)) return { rows: [{ id: params[0] }], rowCount: 1 };
  if (/^WITH gone AS \(\s*DELETE FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 RETURNING 1\s*\)\s*DELETE FROM flocks f/.test(flat)) {
    const fid = Number(p[0]);
    const uid = Number(p[1]);
    const had = world.members.some((m) => m.flock_id === fid && m.user_id === uid);
    world.members = world.members.filter((m) => !(m.flock_id === fid && m.user_id === uid));
    const others = world.members.filter((m) => m.flock_id === fid && m.status === 'accepted').length;
    if (had && others === 0) {
      world.flocks.delete(fid);
      world.members = world.members.filter((m) => m.flock_id !== fid);
      return { rows: [{ id: fid }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
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
  tallySql = null;
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
// A. PAIR FARMING — bounded by the one thing nobody can script
// ═════════════════════════════════════════════════════════════════════════════

test('NOT BROKEN: the plan two friends made an hour ago and went to still counts', async () => {
  const A = 41;
  const B = 42;
  CURRENT_USER = { id: A, name: 'Ada', email_verified: true, role: 'user' };

  // This is the case every clock on this route threatens, so it is asserted
  // first: a flock created for RIGHT NOW, accepted by a real friend, closed and
  // marked when they got home. No lead time, no venue in the row, nothing but
  // two people and an evening. It earns exactly what it always did.
  seedPairFlock(600, A, B, { eventTime: new Date(Date.now() - 3600e3).toISOString() });
  const put = await call('PUT', '/api/flocks/600', { status: 'completed' });
  assert.strictEqual(put.status, 200, put.text);

  const res = await call('POST', '/api/flocks/600/attendance', {
    attendance: [{ userId: A, attended: true }, { userId: B, attended: true }],
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.results, [
    { userId: A, reliabilityScore: 100, totalPlansJoined: 1, totalPlansAttended: 1 },
    { userId: B, reliabilityScore: 100, totalPlansJoined: 1, totalPlansAttended: 1 },
  ], 'a spontaneous plan is still a plan');
  assertQueriesUnderstood();
});

test('FIXED A: twelve farm cycles in one second are one evening, and earn one point', async () => {
  const A = 51;
  const B = 52;
  CURRENT_USER = { id: A, name: 'Mallory', email_verified: true, role: 'user' };

  // The same loop that used to write 12. Every flock in it shares an event
  // time, because the attacker is running them back to back and cannot invent
  // an earlier one (see FIXED B2), so they all fall in one slot.
  for (let i = 0; i < 12; i += 1) {
    const id = 700 + i;
    seedPairFlock(id, A, B);
    await call('PUT', `/api/flocks/${id}`, { status: 'completed' });
    await call('POST', `/api/flocks/${id}/attendance`, {
      attendance: [{ userId: A, attended: true }, { userId: B, attended: true }],
    });
  }

  assert.deepStrictEqual(world.users.get(A), {
    reliability_score: 100, total_plans_joined: 1, total_plans_attended: 1,
  }, 'twelve rows, one evening, one point: the loop stopped being worth running');
  assert.deepStrictEqual(world.users.get(B), {
    reliability_score: 100, total_plans_joined: 1, total_plans_attended: 1,
  });
  assertQueriesUnderstood();
});

test('FIXED A2: nine farm cycles cannot dilute a real flake, because they are one slot between them', async () => {
  const A = 61;
  const B = 62;
  // A stood a real group up: a genuine flock marked no_show by its real
  // creator, yesterday. Honest score: 0 out of 1.
  world.flocks.set(800, {
    id: 800, creator_id: 99, status: 'completed', name: 'Real plan', venue_id: 'ChIJreal0000000001',
    event_time: new Date(Date.now() - 86400e3).toISOString(), created_at: new Date(Date.now() - 172800e3).toISOString(),
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

  // Nine scripted cycles buy one denominator point, not nine. The flake is
  // still half of this person's record instead of a tenth of it, and getting to
  // 90 now costs nine separate slots of real elapsed time, not nine seconds.
  assert.deepStrictEqual(world.users.get(A), {
    reliability_score: 50, total_plans_joined: 2, total_plans_attended: 1,
  }, 'the flake still weighs what a real evening weighs');
  assertQueriesUnderstood();
});

test('FIXED A3: a slot that contains a no_show can never be counted as attended', async () => {
  // The slot rule would have been a BETTER flake eraser than the bug it
  // replaces if it kept an arbitrary member of each slot: one farm flock timed
  // into the same afternoon as a real no-show would have covered it. It keeps
  // the flake instead.
  const M = 65;
  const P = 66;
  const H = 67;
  const afternoon = new Date(Date.now() - 3600e3).toISOString();

  world.flocks.set(830, {
    id: 830, creator_id: H, status: 'completed', name: 'The one they skipped', venue_id: 'ChIJreal0000000009',
    event_time: afternoon, created_at: new Date(Date.now() - 86400e3).toISOString(),
  });
  world.members.push(
    { flock_id: 830, user_id: M, status: 'accepted', attendance: 'no_show' },
    { flock_id: 830, user_id: H, status: 'accepted', attendance: 'attended' },
  );

  CURRENT_USER = { id: M, name: 'Mallory', email_verified: true, role: 'user' };
  seedPairFlock(831, M, P, { eventTime: afternoon });
  await call('PUT', '/api/flocks/831', { status: 'completed' });
  const res = await call('POST', '/api/flocks/831/attendance', {
    attendance: [{ userId: M, attended: true }, { userId: P, attended: true }],
  });
  assert.strictEqual(res.status, 200, res.text);

  assert.deepStrictEqual(world.users.get(M), {
    reliability_score: 0, total_plans_joined: 1, total_plans_attended: 0,
  }, 'one slot, and the evening it describes is the one where they did not turn up');
  assertQueriesUnderstood();
});

test('FIXED A4: two real plans in different slots on the same day both count', async () => {
  // The other side of the slot rule. Brunch and dinner are eight hours apart,
  // so they are two evenings by any honest reading and two points here.
  const A = 68;
  const B = 69;
  CURRENT_USER = { id: A, name: 'Ada', email_verified: true, role: 'user' };

  seedPairFlock(840, A, B, { eventTime: new Date(Date.now() - 9 * 3600e3).toISOString() });
  seedPairFlock(841, A, B, { eventTime: new Date(Date.now() - 3600e3).toISOString() });
  for (const id of [840, 841]) {
    await call('PUT', `/api/flocks/${id}`, { status: 'completed' });
    await call('POST', `/api/flocks/${id}/attendance`, {
      attendance: [{ userId: A, attended: true }, { userId: B, attended: true }],
    });
  }

  assert.deepStrictEqual(world.users.get(A), {
    reliability_score: 100, total_plans_joined: 2, total_plans_attended: 2,
  }, 'a real double-header is not collapsed');
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// B. NO CLOCK — credit lands before the event it certifies
// ═════════════════════════════════════════════════════════════════════════════

test('FIXED B: a flock whose event is a WEEK AWAY earns nothing, however early it is closed', async () => {
  const A = 71;
  const B = 72;
  CURRENT_USER = { id: A, name: 'Mallory', email_verified: true, role: 'user' };

  const nextWeek = new Date(Date.now() + 7 * 86400e3).toISOString();
  seedPairFlock(900, A, B, { eventTime: nextWeek });

  // Closing it early is still allowed. The host is not argued with about what
  // they want the state of their own plan to be; what is refused is the CREDIT,
  // in the tally, the same place the two-member bar lives.
  const put = await call('PUT', '/api/flocks/900', { status: 'completed' });
  assert.strictEqual(put.status, 200, put.text);

  const res = await call('POST', '/api/flocks/900/attendance', {
    attendance: [{ userId: A, attended: true }, { userId: B, attended: true }],
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.results, [
    { userId: A, reliabilityScore: null, totalPlansJoined: 0, totalPlansAttended: 0 },
    { userId: B, reliabilityScore: null, totalPlansJoined: 0, totalPlansAttended: 0 },
  ], 'an evening that has not started certifies nothing');
  assertQueriesUnderstood();
});

test('FIXED B2: event_time cannot be moved to before the flock existed, in the same request or any other', async () => {
  const A = 76;
  const B = 77;
  CURRENT_USER = { id: A, name: 'Mallory', email_verified: true, role: 'user' };
  seedPairFlock(910, A, B, { eventTime: new Date(Date.now() + 7 * 86400e3).toISOString() });

  // This is the request the whole clock rests on. Backdating 45 days would have
  // let a farm cycle claim any date the attacker liked, and would have made
  // "the event must have started" satisfiable instantly and forever.
  const backdated = new Date(Date.now() - 45 * 86400e3).toISOString();
  const put = await call('PUT', '/api/flocks/910', { status: 'completed', event_time: backdated });
  assert.strictEqual(put.status, 400, put.text);
  assert.match(put.body.error, /before it was created/);
  assert.notStrictEqual(world.flocks.get(910).event_time, backdated);
  assert.strictEqual(world.flocks.get(910).status, 'confirmed', 'the status did not sneak through either');

  // Two requests instead of one does not help.
  const split = await call('PUT', '/api/flocks/910', { event_time: backdated });
  assert.strictEqual(split.status, 400, split.text);
  assertQueriesUnderstood();
});

test('NOT BROKEN: rescheduling a live plan is untouched, including moving it earlier', async () => {
  const A = 78;
  const B = 79;
  CURRENT_USER = { id: A, name: 'Ada', email_verified: true, role: 'user' };
  const created = new Date(Date.now() - 2 * 86400e3).toISOString();
  seedPairFlock(920, A, B, { eventTime: new Date(Date.now() + 2 * 86400e3).toISOString() });
  world.flocks.get(920).created_at = created;

  // "We're going tomorrow instead" is a normal edit, and so is "actually let's
  // go this afternoon". Both are after created_at, so both are allowed.
  for (const when of [new Date(Date.now() + 86400e3), new Date(Date.now() - 3600e3)]) {
    const res = await call('PUT', '/api/flocks/920', { event_time: when.toISOString() });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(world.flocks.get(920).event_time, when.toISOString());
  }
  assertQueriesUnderstood();
});

test('FIXED B3: the time of a finished plan is not an editable field', async () => {
  const A = 80;
  const B = 84;
  CURRENT_USER = { id: A, name: 'Mallory', email_verified: true, role: 'user' };
  seedPairFlock(930, A, B, { status: 'completed', eventTime: new Date(Date.now() - 3600e3).toISOString() });

  const res = await call('PUT', '/api/flocks/930', { event_time: new Date().toISOString() });
  assert.strictEqual(res.status, 409, res.text);
  assert.match(res.body.error, /finished/);
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// C. FLAKE ERASURE — leaving a COMPLETED flock deletes the evidence
// ═════════════════════════════════════════════════════════════════════════════

test('FIXED C: a user marked no_show cannot leave the completed flock, so the flake survives the recompute', async () => {
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

  // 2. M tries to leave. The flock is COMPLETED, which is no longer a plan they
  //    are committed to, it is the group's record of an evening.
  CURRENT_USER = { id: M, name: 'Mallory', email_verified: true, role: 'user' };
  const left = await call('POST', '/api/flocks/1000/leave');
  assert.strictEqual(left.status, 409, left.text);
  assert.match(left.body.error, /already finished/);
  assert.strictEqual(member(1000, M).attendance, 'no_show', 'the record is still there');

  // 3. So the recompute M triggers themselves, with a real second plan a day
  //    later, tallies OVER the flake instead of over the hole where it was.
  seedPairFlock(1010, M, P, { eventTime: new Date(Date.now() + 0).toISOString() });
  await call('PUT', '/api/flocks/1010', { status: 'completed' });
  const res = await call('POST', '/api/flocks/1010/attendance', {
    attendance: [{ userId: M, attended: true }, { userId: P, attended: true }],
  });
  assert.strictEqual(res.status, 200, res.text);

  assert.deepStrictEqual(world.users.get(M), {
    reliability_score: 50, total_plans_joined: 2, total_plans_attended: 1,
  }, 'the flake is outweighed by exactly one real evening, which is what an honest record looks like');
  assertQueriesUnderstood();
});

test('NOT BROKEN: leaving anything that is still a plan is untouched', async () => {
  const M = 85;
  const H = 86;
  for (const status of ['planning', 'confirmed', 'cancelled']) {
    world = freshWorld();
    log = [];
    unknown = [];
    world.flocks.set(1050, {
      id: 1050, creator_id: H, status, name: 'Saturday', venue_id: null,
      event_time: new Date(Date.now() + 86400e3).toISOString(), created_at: new Date().toISOString(),
    });
    world.members.push(
      { flock_id: 1050, user_id: H, status: 'accepted', attendance: 'unmarked' },
      { flock_id: 1050, user_id: M, status: 'accepted', attendance: 'unmarked' },
    );
    CURRENT_USER = { id: M, name: 'Mallory', email_verified: true, role: 'user' };
    const res = await call('POST', '/api/flocks/1050/leave');
    assert.strictEqual(res.status, 200, `${status}: ${res.text}`);
    assert.strictEqual(member(1050, M), undefined, `${status} trapped a member in a live plan`);
  }
  assertQueriesUnderstood();
});

test('FIXED C2: the refusal costs no database write, and no membership row is touched', async () => {
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
  assert.strictEqual(left.status, 409, left.text);
  assert.strictEqual(left.body.flock_name, undefined, 'a refusal is not a place to hand out the name');
  assert.strictEqual(
    log.some((q) => /^DELETE FROM/.test(q.sql)),
    false,
    'the refusal happens before anything is deleted, so a retry cannot race it',
  );
  assert.strictEqual(member(1100, M).attendance, 'no_show');
  assertQueriesUnderstood();
});

test('STILL OPEN, but no longer silent: leave before the host marks, and the host is TOLD you were not recorded', async () => {
  // No exploit knowledge required, and it is what a flaky person does anyway:
  // accept the invite, do not turn up, leave the flock before the host gets
  // round to marking attendance. There is then no row to mark, so the flake
  // never enters the denominator in the first place. That is STILL TRUE.
  // Closing it needs a membership row that outlives a departure, and
  // flock_members.status is CHECK-constrained to invited/accepted/declined
  // (migration 000), so it needs a migration AND a decision about what leaving
  // after the event is supposed to mean. Guessing at that in a patch would be
  // worse than leaving it named.
  //
  // What has changed is that the host is no longer told a clean success. The
  // people they named who could not be recorded come back on the response, so
  // the surface that asked can say so.
  const M = 131;  // the flake
  const H = 132;  // the host
  const G = 133;  // someone who actually went

  world.flocks.set(1500, {
    id: 1500, creator_id: H, status: 'confirmed', name: 'Saturday', venue_id: 'ChIJreal0000000004',
    event_time: new Date(Date.now() - 7200e3).toISOString(), created_at: new Date().toISOString(),
  });
  world.members.push(
    { flock_id: 1500, user_id: H, status: 'accepted', attendance: 'unmarked' },
    { flock_id: 1500, user_id: G, status: 'accepted', attendance: 'unmarked' },
    { flock_id: 1500, user_id: M, status: 'accepted', attendance: 'unmarked' },
  );

  // The evening passes. M never showed. M leaves the next morning.
  CURRENT_USER = { id: M, name: 'Mallory', email_verified: true, role: 'user' };
  const left = await call('POST', '/api/flocks/1500/leave');
  assert.strictEqual(left.status, 200, left.text);

  // The host marks attendance honestly, naming everyone including M.
  CURRENT_USER = { id: H, name: 'Hana', email_verified: true, role: 'user' };
  world.flocks.get(1500).status = 'completed';
  const res = await call('POST', '/api/flocks/1500/attendance', {
    attendance: [
      { userId: H, attended: true },
      { userId: G, attended: true },
      { userId: M, attended: false },
    ],
  });
  assert.strictEqual(res.status, 200, res.text);

  assert.strictEqual(res.body.results.some((r) => r.userId === M), false,
    'still no score for them: the recompute is scoped to CURRENT accepted members, which is the rule that keeps a stranger out of it');
  assert.strictEqual(world.users.has(M), false);
  // The part that is fixed: the host is told, by user id, who did not land.
  assert.deepStrictEqual(res.body.unrecorded, [M],
    'the drop is reported instead of being swallowed');
  assertQueriesUnderstood();
});

test('NOT BROKEN: an honest attendance sheet carries no `unrecorded` key at all', async () => {
  const A = 141;
  const B = 142;
  CURRENT_USER = { id: A, name: 'Ada', email_verified: true, role: 'user' };
  seedPairFlock(1600, A, B, { status: 'completed', eventTime: new Date(Date.now() - 3600e3).toISOString() });

  const res = await call('POST', '/api/flocks/1600/attendance', {
    attendance: [{ userId: A, attended: true }, { userId: B, attended: true }],
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual('unrecorded' in res.body, false,
    'a key that is always present and almost always empty is noise on every honest call');
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
