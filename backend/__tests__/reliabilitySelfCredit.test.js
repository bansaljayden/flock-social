// Run: node --test  (from backend/)
//
// ─────────────────────────────────────────────────────────────────────────────
// RELIABILITY SELF-CREDIT — routes/flocks.js (the tally), routes/checkin.js
// ─────────────────────────────────────────────────────────────────────────────
//
// The anti-flake reliability score used to be self-serviceable at zero social
// cost: create a flock at any venue with event_time = now, check in
// (routes/checkin.js markFlockAttendance pre-sets attendance = 'attended'),
// flip the flock to completed, and mark attendance — or skip the check-in
// entirely, since the creator of a completed solo flock could POST
// /api/flocks/:id/attendance naming themselves. Either way the tally counted
// the solo flock and the score climbed with nobody else involved.
//
// The rule that closes it, enforced in the tally inside POST /:id/attendance
// (the ONLY writer of users.reliability_score / total_plans_*): a flock counts
// toward reliability — in BOTH the numerator and the denominator — only when
// it has at least TWO accepted members. That is the app's existing "real
// flock" evidence bar (routes/feedback.js VERIFIED_PRESENCE_SQL, the venue
// review gate, and the reasoning around UNVERIFIED_DENY in
// middleware/auth.js): a solo flock is one free POST and certifies nothing,
// while a second ACCEPTED member costs a second real, email-verified account.
//
// These tests drive the real routers against a SEMANTIC in-memory world: the
// pg fixture executes the meaning of each statement the routes actually send
// (including the member-count guard, applied only when the SQL carries it), so
// reverting the guard in routes/flocks.js makes the exploit tests go red on
// behavior, not just on a string match.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'reliability-self-credit-test-secret';

const pool = require('../config/database');

// ── Module stubs, installed BEFORE the routers are required ──────────────────
// Both routers destructure these at load time.
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => ({ skipped: true, reason: 'test' });
pushMod.pushIfOfflineDebounced = async () => ({ skipped: true, reason: 'test' });

// ── The semantic world ───────────────────────────────────────────────────────
// users:   id -> the last { reliability_score, total_plans_joined,
//          total_plans_attended } the route WROTE (null until it writes).
// flocks:  id -> { id, creator_id, status, name, venue_id, event_time }
// members: [{ flock_id, user_id, status, attendance }]
let world;
function freshWorld() {
  return { users: new Map(), flocks: new Map(), members: [] };
}
function acceptedCount(flockId) {
  return world.members.filter((m) => m.flock_id === flockId && m.status === 'accepted').length;
}
function member(flockId, userId) {
  return world.members.find((m) => m.flock_id === flockId && m.user_id === userId);
}

let log = [];
let tallySql = null;

async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  const p = params || [];

  // routes/flocks.js POST /:id/attendance — the creator/status gate.
  if (/SELECT creator_id, status, name FROM flocks WHERE id = \$1/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    return f ? { rows: [{ creator_id: f.creator_id, status: f.status, name: f.name }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  // The batched attendance write (creator marking).
  if (/UPDATE flock_members SET attendance = t\.mark/.test(flat)) {
    let n = 0;
    (p[0] || []).forEach((uid, i) => {
      const fm = member(Number(p[2]), uid);
      if (fm && fm.status === 'accepted') { fm.attendance = p[1][i]; n += 1; }
    });
    return { rows: [], rowCount: n };
  }

  // routes/checkin.js markFlockAttendance — the check-in pre-set. Executes the
  // statement's real meaning: accepted membership, flock at this venue, not
  // completed/cancelled, NOW() inside [event_time - 3h, event_time + 12h].
  if (/UPDATE flock_members SET attendance = 'attended'/.test(flat)) {
    const now = Date.now();
    let n = 0;
    for (const fm of world.members) {
      if (fm.user_id !== Number(p[0]) || fm.status !== 'accepted') continue;
      const f = world.flocks.get(fm.flock_id);
      if (!f || f.venue_id !== p[1]) continue;
      if (f.status === 'completed' || f.status === 'cancelled') continue;
      if (!f.event_time) continue;
      const t = new Date(f.event_time).getTime();
      if (now >= t - 3 * 3600e3 && now <= t + 12 * 3600e3) { fm.attendance = 'attended'; n += 1; }
    }
    return { rows: [], rowCount: n };
  }

  // The accepted-member roster the recompute scopes itself to.
  if (/SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'$/.test(flat)) {
    const rows = world.members
      .filter((m) => m.flock_id === Number(p[0]) && m.status === 'accepted')
      .map((m) => ({ user_id: m.user_id }));
    return { rows, rowCount: rows.length };
  }

  // THE TALLY. The guard is applied exactly where the arriving SQL carries it,
  // clause by clause — so this fixture behaves like Postgres would on whatever
  // routes/flocks.js currently says, and a reverted guard re-opens the exploit
  // here, in behavior.
  if (/FROM UNNEST\(\$1::int\[\]\) AS t\(uid\)/.test(flat) && /joined/.test(flat)) {
    tallySql = flat;
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

  // The one write path for the score.
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

  // routes/checkin.js recordTap's conditional INSERT.
  if (/INSERT INTO venue_checkins/.test(flat)) {
    return { rows: [{ created_at: new Date().toISOString() }], rowCount: 1 };
  }

  throw new Error(`unscripted query: ${flat.slice(0, 160)}`);
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
    return dispatch(sql, params);
  },
  release: () => {},
});

const flocksRouter = require('../routes/flocks');
const checkinRouter = require('../routes/checkin');

const app = express();
app.use(express.json());
app.set('io', null);
app.use('/api/flocks', flocksRouter);
app.use('/api/checkin', checkinRouter);

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
  // Per-process check-in state: the 30-min dedupe map and the 15/hour budget.
  checkinRouter.__test.tapCache.clear();
  checkinRouter.__test.tapBudget.reset();
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

const settle = () => new Promise((r) => setImmediate(r));

// ═════════════════════════════════════════════════════════════════════════════
// 1. The exploit, reproduced end to end
// ═════════════════════════════════════════════════════════════════════════════

test('exploit: solo instant flock + check-in moves the score by nothing', async () => {
  // Attacker 7 has one REAL prior plan (a completed 2-person flock) where they
  // no-showed: score 0. If the solo flock counted, this run would lift them to
  // 50 — so "the score must not move" is asserted against a live number, not
  // against an empty account.
  CURRENT_USER = { id: 7, name: 'Mallory', email_verified: true, role: 'user' };
  world.flocks.set(1, { id: 1, creator_id: 9, status: 'completed', name: 'Real plan', venue_id: 'ChIJrealvenue001', event_time: new Date(Date.now() - 86400e3).toISOString() });
  world.members.push(
    { flock_id: 1, user_id: 7, status: 'accepted', attendance: 'no_show' },
    { flock_id: 1, user_id: 9, status: 'accepted', attendance: 'attended' },
  );

  // Step 1: the solo flock, event_time = now, at a venue of the attacker's choosing.
  world.flocks.set(100, { id: 100, creator_id: 7, status: 'confirmed', name: 'Me myself and I', venue_id: 'ChIJsoloexploit001', event_time: new Date().toISOString() });
  world.members.push({ flock_id: 100, user_id: 7, status: 'accepted', attendance: 'unmarked' });

  // Step 2: manual check-in. Presence recording is unchanged on purpose — the
  // attendance PRE-SET still happens; it just earns nothing downstream.
  const tap = await call('POST', '/api/checkin/ChIJsoloexploit001');
  assert.strictEqual(tap.status, 200, tap.text);
  await settle(); // markFlockAttendance is fire-and-forget
  assert.strictEqual(member(100, 7).attendance, 'attended',
    'the check-in still records presence on the flock row');

  // Step 3: complete the flock (the creator can do this via PUT /:id) and mark
  // attendance — the recompute trigger.
  world.flocks.get(100).status = 'completed';
  const res = await call('POST', '/api/flocks/100/attendance', {
    attendance: [{ userId: 7, attended: true }],
  });
  assert.strictEqual(res.status, 200, res.text);

  // The solo flock contributed to NEITHER count: only the real prior plan is
  // visible, so the score stays exactly where it was.
  assert.deepStrictEqual(res.body.results, [
    { userId: 7, reliabilityScore: 0, totalPlansJoined: 1, totalPlansAttended: 0 },
  ], 'the solo flock must not appear in either the numerator or the denominator');
  assert.deepStrictEqual(world.users.get(7), {
    reliability_score: 0, total_plans_joined: 1, total_plans_attended: 0,
  }, 'and the written row must match');
});

test('exploit variant: self-marking a completed solo flock with no check-in earns nothing', async () => {
  // The check-in is optional sugar for the attacker: the creator of a completed
  // flock can POST attendance naming themselves directly. Same rule kills it.
  CURRENT_USER = { id: 8, name: 'Trudy', email_verified: true, role: 'user' };
  world.flocks.set(101, { id: 101, creator_id: 8, status: 'completed', name: 'Solo', venue_id: 'ChIJsoloexploit002', event_time: new Date(Date.now() - 3600e3).toISOString() });
  world.members.push({ flock_id: 101, user_id: 8, status: 'accepted', attendance: 'unmarked' });

  const res = await call('POST', '/api/flocks/101/attendance', {
    attendance: [{ userId: 8, attended: true }],
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.results, [
    { userId: 8, reliabilityScore: null, totalPlansJoined: 0, totalPlansAttended: 0 },
  ], 'an account with nothing but solo flocks has NO score, not a perfect one');
});

test('exploit variant: event_time in the past changes nothing', async () => {
  // Backdating the flock skips the check-in window but the recompute path is
  // identical — the member-count bar does not care when the "plan" happened.
  CURRENT_USER = { id: 12, name: 'Eve', email_verified: true, role: 'user' };
  world.flocks.set(102, { id: 102, creator_id: 12, status: 'completed', name: 'Backdated', venue_id: 'ChIJsoloexploit003', event_time: new Date(Date.now() - 30 * 86400e3).toISOString() });
  world.members.push({ flock_id: 102, user_id: 12, status: 'accepted', attendance: 'attended' });

  const res = await call('POST', '/api/flocks/102/attendance', {
    attendance: [{ userId: 12, attended: true }],
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.results, [
    { userId: 12, reliabilityScore: null, totalPlansJoined: 0, totalPlansAttended: 0 },
  ]);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The honest path, pinned — and the rule's exact boundary
// ═════════════════════════════════════════════════════════════════════════════

test('honest path: a two-person flock (the boundary: exactly 2 accepted) still credits in full', async () => {
  // TWO accepted members is the smallest real flock and sits exactly ON the
  // >= 2 boundary — the rule must not rob it. Normal timeline: created
  // earlier, event happens, one member checks in, creator completes and marks.
  CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
  world.flocks.set(200, { id: 200, creator_id: 1, status: 'confirmed', name: 'Tacos', venue_id: 'ChIJhonestvenue01', event_time: new Date(Date.now() - 3600e3).toISOString() });
  world.members.push(
    { flock_id: 200, user_id: 1, status: 'accepted', attendance: 'unmarked' },
    { flock_id: 200, user_id: 2, status: 'accepted', attendance: 'unmarked' },
  );

  // The creator checks in at the venue during the event window.
  const tap = await call('POST', '/api/checkin/ChIJhonestvenue01');
  assert.strictEqual(tap.status, 200, tap.text);
  await settle();
  assert.strictEqual(member(200, 1).attendance, 'attended');

  world.flocks.get(200).status = 'completed';
  const res = await call('POST', '/api/flocks/200/attendance', {
    attendance: [{ userId: 1, attended: true }, { userId: 2, attended: false }],
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.results, [
    { userId: 1, reliabilityScore: 100, totalPlansJoined: 1, totalPlansAttended: 1 },
    { userId: 2, reliabilityScore: 0, totalPlansJoined: 1, totalPlansAttended: 0 },
  ], 'a real 2-person flock earns full credit for the attendee and a real flake for the no-show');
  assert.deepStrictEqual(world.users.get(1), {
    reliability_score: 100, total_plans_joined: 1, total_plans_attended: 1,
  });
});

test('boundary, other side: an invited-but-never-accepted second member does not make a flock real', async () => {
  // The bar counts ACCEPTED members. Spraying invites at strangers (or at a
  // puppet that never answers) is still one account acting alone — 'invited'
  // is somebody else's assertion, not participation.
  CURRENT_USER = { id: 10, name: 'Oscar', email_verified: true, role: 'user' };
  world.flocks.set(300, { id: 300, creator_id: 10, status: 'completed', name: 'Ghost invite', venue_id: 'ChIJinvitedonly01', event_time: new Date(Date.now() - 3600e3).toISOString() });
  world.members.push(
    { flock_id: 300, user_id: 10, status: 'accepted', attendance: 'unmarked' },
    { flock_id: 300, user_id: 11, status: 'invited', attendance: 'unmarked' },
  );

  const res = await call('POST', '/api/flocks/300/attendance', {
    attendance: [{ userId: 10, attended: true }],
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.results, [
    { userId: 10, reliabilityScore: null, totalPlansJoined: 0, totalPlansAttended: 0 },
  ], 'accepted_count is 1, so this is still a solo flock');
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. The statement itself
// ═════════════════════════════════════════════════════════════════════════════

test('the tally guards BOTH counts, symmetrically, without touching the round-5 scoping', async () => {
  CURRENT_USER = { id: 8, name: 'Trudy', email_verified: true, role: 'user' };
  world.flocks.set(101, { id: 101, creator_id: 8, status: 'completed', name: 'Solo', venue_id: 'ChIJsoloexploit002', event_time: new Date().toISOString() });
  world.members.push({ flock_id: 101, user_id: 8, status: 'accepted', attendance: 'unmarked' });
  await call('POST', '/api/flocks/101/attendance', { attendance: [{ userId: 8, attended: true }] });

  assert.ok(tallySql, 'the batched tally ran');
  // Guarding only the numerator would turn every solo plan into a recorded
  // flake; guarding only the denominator would divide by too little. Both, or
  // the rule is wrong.
  assert.strictEqual((tallySql.match(/mc\.accepted_count >= 2/g) || []).length, 2,
    'the two-accepted-members bar must appear in the joined AND the attended FILTER');
  const joinedClause = tallySql.slice(0, tallySql.indexOf('AS joined'));
  const attendedClause = tallySql.slice(tallySql.indexOf('AS joined'), tallySql.indexOf('AS attended'));
  assert.match(joinedClause, /mc\.accepted_count >= 2/);
  assert.match(attendedClause, /mc\.accepted_count >= 2/);
  // The pre-existing predicates survive untouched (queryReliability.test.js
  // pins these too; repeated here so this file fails self-contained).
  assert.strictEqual((tallySql.match(/f\.status = 'completed'/g) || []).length, 2);
  assert.match(tallySql, /fm\.status = 'accepted' AND fm\.attendance <> 'unmarked'/);
  assert.match(tallySql, /m2\.status = 'accepted'/,
    'the member count itself must count accepted members only');
});
