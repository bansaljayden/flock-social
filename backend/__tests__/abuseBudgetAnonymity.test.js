// Run: node --test  (from backend/)
//
// ─────────────────────────────────────────────────────────────────────────────
// GAME-RULE ABUSE — anonymous budget matching (routes/budget.js)
// ─────────────────────────────────────────────────────────────────────────────
//
// The design is explicit about what it will and will not publish: the ceiling
// is MIN(non-skipped amounts), it is published as a BAND rather than the raw
// minimum, and it is withheld entirely until THREE non-skipped submissions
// exist. The documented residual is that colluders learn a band.
//
// This file attacks past that line. What it establishes:
//
//   E. POISON AND RUN (defect). budget_submissions has no relationship to
//      flock_members. A member can submit $0.01, leave the flock, and the row
//      stays: it keeps setting the group MIN forever, and the departing
//      account can no longer edit or withdraw it because /submit requires an
//      accepted membership row. The creator cannot clear it either — there is
//      no delete path on this router at all. routes/venues.js closed exactly
//      this shape for venue_votes in round 17 (the tally now JOINs
//      flock_members); budget_submissions never got the same treatment.
//
//   F. BORROWED ANONYMITY (defect). The >= 3 non-skip threshold exists to give
//      an amount a crowd to hide in. It counts ROWS, not present members, so
//      rows left behind by departed accounts carry a live flock over the line.
//      Two people in a room can be shown a ceiling whose anonymity set is two.
//
//   G. DIFFERENCING (attacked, held at the band). A member who resubmits and
//      re-reads can binary-search the others' minimum, but bandCeiling floors
//      the answer, so the search converges on the BAND EDGE and stops there.
//      Pinned here so a future change to the band steps is measured against
//      what an attacker actually recovers.
//
//   H. SKIP COUNT (defect, small). skipCount is returned raw to every member.
//      In a two-person flock it is a direct read of whether the other person
//      skipped, which is per-member information the rest of the route is
//      careful never to publish.
//
// No database: pool.query is a semantic fixture. Unmodelled statements throw
// rather than answering with an empty result.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'abuse-budget-anonymity-test-secret';

const pool = require('../config/database');

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
pushMod.pushIfOffline = async () => ({ skipped: true, reason: 'test' });
pushMod.pushAlways = async () => ({ skipped: true, reason: 'test' });

// ── The semantic world ───────────────────────────────────────────────────────
// flocks:      id -> { id, creator_id, budget_enabled, budget_locked,
//                      budget_ceiling, ghost_mode_enabled, name }
// members:     [{ flock_id, user_id, status }]
// submissions: [{ flock_id, user_id, amount, skipped }]  (UNIQUE flock_id,user_id)
let world;
function freshWorld() {
  return { flocks: new Map(), members: [], submissions: [] };
}
const FLOCK = 4200;

function submission(flockId, userId) {
  return world.submissions.find((s) => s.flock_id === flockId && s.user_id === userId);
}
function minNonSkipped(flockId) {
  const amts = world.submissions
    .filter((s) => s.flock_id === flockId && s.skipped === false && s.amount != null)
    .map((s) => Number(s.amount));
  return amts.length ? Math.min(...amts) : null;
}

let log = [];
let unknown = [];
function assertQueriesUnderstood() {
  assert.deepStrictEqual(unknown, [], `unmodelled queries: ${JSON.stringify(unknown.slice(0, 3))}`);
}

async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  const p = params || [];
  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(flat)) return { rows: [], rowCount: 0 };

  // membership gate, shared by every route on this router
  if (/^SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'$/.test(flat)) {
    const m = world.members.find((x) => x.flock_id === Number(p[0]) && x.user_id === Number(p[1]) && x.status === 'accepted');
    return m ? { rows: [{ id: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }

  if (/^SELECT budget_enabled, budget_locked FROM flocks WHERE id = \$1 FOR UPDATE$/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    return f ? { rows: [{ budget_enabled: f.budget_enabled, budget_locked: f.budget_locked }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^SELECT creator_id, budget_enabled FROM flocks WHERE id = \$1 FOR UPDATE$/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    return f ? { rows: [{ creator_id: f.creator_id, budget_enabled: f.budget_enabled }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^SELECT budget_enabled, budget_context, budget_locked, budget_ceiling, ghost_mode_enabled FROM flocks WHERE id = \$1$/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    return f ? { rows: [{ ...f }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^SELECT skipped FROM budget_submissions WHERE flock_id = \$1 AND user_id = \$2$/.test(flat)) {
    const s = submission(Number(p[0]), Number(p[1]));
    return s ? { rows: [{ skipped: s.skipped }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^SELECT amount, skipped FROM budget_submissions WHERE flock_id = \$1 AND user_id = \$2$/.test(flat)) {
    const s = submission(Number(p[0]), Number(p[1]));
    return s ? { rows: [{ amount: s.amount, skipped: s.skipped }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^INSERT INTO budget_submissions/.test(flat)) {
    const [fid, uid, amount, skipped] = [Number(p[0]), Number(p[1]), p[2], p[3]];
    const existing = submission(fid, uid);
    if (existing) { existing.amount = amount; existing.skipped = !!skipped; }
    else world.submissions.push({ flock_id: fid, user_id: uid, amount, skipped: !!skipped });
    return { rows: [], rowCount: 1 };
  }
  if (/^SELECT MIN\(amount\) AS ceiling FROM budget_submissions WHERE flock_id = \$1 AND skipped = false$/.test(flat)) {
    return { rows: [{ ceiling: minNonSkipped(Number(p[0])) }], rowCount: 1 };
  }
  if (/^UPDATE flocks SET budget_ceiling = \$1/.test(flat)) {
    const f = world.flocks.get(Number(p[1]));
    if (f) f.budget_ceiling = p[0];
    return { rows: [], rowCount: f ? 1 : 0 };
  }
  if (/^UPDATE flocks SET budget_locked = true/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    if (f) { f.budget_locked = true; f.budget_ceiling = p[1]; }
    return { rows: [], rowCount: f ? 1 : 0 };
  }
  if (/COUNT\(\*\) AS total_submissions/.test(flat)) {
    const rows = world.submissions.filter((s) => s.flock_id === Number(p[0]));
    return {
      rows: [{
        total_submissions: String(rows.length),
        non_skip_count: String(rows.filter((s) => !s.skipped).length),
        skip_count: String(rows.filter((s) => s.skipped).length),
      }],
      rowCount: 1,
    };
  }
  if (/^SELECT COUNT\(\*\)::int AS n FROM budget_submissions WHERE flock_id = \$1 AND skipped = false$/.test(flat)) {
    const n = world.submissions.filter((s) => s.flock_id === Number(p[0]) && !s.skipped).length;
    return { rows: [{ n }], rowCount: 1 };
  }
  if (/^SELECT COUNT\(\*\) AS total FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'$/.test(flat)) {
    const n = world.members.filter((m) => m.flock_id === Number(p[0]) && m.status === 'accepted').length;
    return { rows: [{ total: String(n) }], rowCount: 1 };
  }
  if (/^SELECT name FROM flocks WHERE id = \$1$/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    return f ? { rows: [{ name: f.name }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted' AND user_id != \$2$/.test(flat)) {
    const rows = world.members
      .filter((m) => m.flock_id === Number(p[0]) && m.status === 'accepted' && m.user_id !== Number(p[1]))
      .map((m) => ({ user_id: m.user_id }));
    return { rows, rowCount: rows.length };
  }

  unknown.push(flat.slice(0, 160));
  throw new Error(`unscripted query: ${flat.slice(0, 160)}`);
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({ query: (sql, params) => dispatch(sql, params), release: () => {} });

const budgetRouter = require('../routes/budget');
const { bandCeiling } = budgetRouter;

const app = express();
app.use(express.json());
app.set('io', null);
app.use('/api/budget', budgetRouter);

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
  budgetRouter.__resetReminderCooldowns();
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

function seedFlock({ creator, members, locked = false }) {
  world.flocks.set(FLOCK, {
    id: FLOCK, creator_id: creator, name: 'Dinner', budget_enabled: true,
    budget_locked: locked, budget_ceiling: null, budget_context: null,
    ghost_mode_enabled: false,
  });
  for (const uid of members) world.members.push({ flock_id: FLOCK, user_id: uid, status: 'accepted' });
}
const as = (id) => { CURRENT_USER = { id, name: `U${id}`, email_verified: true, role: 'user' }; };
const submit = (amount) => call('POST', `/api/budget/${FLOCK}/submit`, { amount });
const skip = () => call('POST', `/api/budget/${FLOCK}/submit`, { amount: 0, skipped: true });
const status = () => call('GET', `/api/budget/${FLOCK}`);

// ═════════════════════════════════════════════════════════════════════════════
// E. POISON AND RUN
// ═════════════════════════════════════════════════════════════════════════════

test('ABUSE E: a member submits $0.01, leaves, and the group budget is stuck at a cent forever', async () => {
  seedFlock({ creator: 1, members: [1, 2, 3, 4] });

  // The three real participants say what they can spend.
  as(2); await submit(60);
  as(3); await submit(75);
  as(4); await submit(80);

  as(1);
  let s = await status();
  assert.strictEqual(s.body.isReady, true);
  assert.strictEqual(s.body.ceiling, 60, 'a healthy $60 band');

  // The griefer joins the conversation with a cent and then walks out.
  const G = 9;
  world.members.push({ flock_id: FLOCK, user_id: G, status: 'accepted' });
  as(G);
  const poisoned = await submit(0.01);
  assert.strictEqual(poisoned.status, 200, poisoned.text);
  assert.strictEqual(poisoned.body.ceiling, 0.01, 'the sub-dollar band');

  // POST /api/flocks/:id/leave deletes the flock_members row and nothing else.
  world.members = world.members.filter((m) => m.user_id !== G);

  // The row survives, and it is still the MIN.
  assert.ok(submission(FLOCK, G), 'budget_submissions has no membership relationship at all');
  as(1);
  s = await status();
  assert.strictEqual(s.body.ceiling, 0.01,
    'every member is now told the group can spend one cent');

  // Nobody can undo it. The author is refused for lack of membership...
  as(G);
  const retry = await submit(60);
  assert.strictEqual(retry.status, 403, 'the poisoner cannot withdraw or raise their own number');

  // ...and there is no delete/clear path on this router for anyone else.
  const paths = [];
  budgetRouter.stack.forEach((layer) => {
    if (layer.route) paths.push(`${Object.keys(layer.route.methods).join(',')} ${layer.route.path}`);
  });
  assert.deepStrictEqual(
    paths.filter((r) => r.startsWith('delete')), [],
    'routes/budget.js exposes no way to remove a submission, so the poison is permanent',
  );
  assertQueriesUnderstood();
});

test('ABUSE E2: the poisoned ceiling survives the LOCK, which is the number the group commits to', async () => {
  seedFlock({ creator: 1, members: [1, 2, 3] });
  as(1); await submit(70);
  as(2); await submit(65);
  as(3); await submit(65);

  const G = 9;
  world.members.push({ flock_id: FLOCK, user_id: G, status: 'accepted' });
  as(G); await submit(0.01);
  world.members = world.members.filter((m) => m.user_id !== G);

  as(1);
  const locked = await call('POST', `/api/budget/${FLOCK}/lock`);
  assert.strictEqual(locked.status, 200, locked.text);
  assert.strictEqual(locked.body.ceiling, 0.01,
    'the lock recomputes MIN over submissions, including the departed one');
  assert.strictEqual(world.flocks.get(FLOCK).budget_locked, true);

  // And once locked, no member can move it back.
  as(1);
  const after = await submit(70);
  assert.strictEqual(after.status, 400, after.text);
  assert.match(after.body.error, /locked/i);
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// F. BORROWED ANONYMITY — the >=3 threshold counts rows, not people
// ═════════════════════════════════════════════════════════════════════════════

test('ABUSE F: two present members are shown a ceiling whose anonymity set is two', async () => {
  // A and B are the flock. A wants B's number and cannot have it: two
  // non-skips is below the threshold, so the ceiling is withheld.
  seedFlock({ creator: 1, members: [1, 2] });
  as(1); await submit(10000);
  as(2); await submit(43.20);

  as(1);
  let s = await status();
  assert.strictEqual(s.body.isReady, false);
  assert.strictEqual(s.body.ceiling, null, 'correctly withheld at two submissions');

  // A brings in one puppet, who submits anything at all and then LEAVES. The
  // puppet is not in the room, cannot see the flock, and is not part of the
  // plan — but their row counts.
  const P = 8;
  world.members.push({ flock_id: FLOCK, user_id: P, status: 'accepted' });
  as(P); await submit(10000);
  world.members = world.members.filter((m) => m.user_id !== P);

  as(1);
  s = await status();
  assert.strictEqual(s.body.totalMembers, 2, 'the flock really is two people');
  assert.strictEqual(s.body.submissionCount, 3, 'but three rows exist');
  assert.strictEqual(s.body.isReady, true, 'so the privacy threshold is satisfied');
  assert.strictEqual(s.body.ceiling, 40,
    "and A now reads B's amount to within a $5 band with nobody else in the room");

  // The bound on what A learned, stated exactly: B is in [40, 45).
  assert.ok(bandCeiling(43.20) === 40 && bandCeiling(44.99) === 40 && bandCeiling(45) === 45);
  assertQueriesUnderstood();
});

test('ABUSE F2: the same borrowed row survives even when the puppet SKIPS afterwards is impossible, so it cannot be taken back', async () => {
  seedFlock({ creator: 1, members: [1, 2] });
  as(1); await submit(10000);
  as(2); await submit(43.20);

  const P = 8;
  world.members.push({ flock_id: FLOCK, user_id: P, status: 'accepted' });
  as(P); await submit(10000);
  world.members = world.members.filter((m) => m.user_id !== P);

  // Even a puppet who regrets it cannot convert their row to a skip and pull
  // the flock back under the threshold: /submit needs membership.
  as(P);
  const regret = await skip();
  assert.strictEqual(regret.status, 403, 'a departed account cannot change its own row in either direction');

  as(1);
  const s = await status();
  assert.strictEqual(s.body.isReady, true, 'so the reveal is irreversible');
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// G. DIFFERENCING — attacked, and it stops at the band
// ═════════════════════════════════════════════════════════════════════════════

test('HELD: resubmit-and-difference recovers the BAND of the others\' minimum and no more', async () => {
  seedFlock({ creator: 1, members: [1, 2, 3] });
  const SECRET = 37.42;      // what user 2 can spend
  as(2); await submit(SECRET);
  as(3); await submit(88);

  // A (user 1) drives their own amount up and down and reads the published
  // ceiling each time. This is the whole attack: one member, no collusion,
  // an oracle they can query as often as they like while the budget is open.
  const observed = [];
  as(1);
  for (const probe of [5, 20, 30, 35, 36, 37, 37.41, 37.42, 37.43, 38, 40, 45, 100, 10000]) {
    const r = await submit(probe);
    assert.strictEqual(r.status, 200, r.text);
    observed.push([probe, r.body.ceiling]);
  }

  // For probes at or above the secret the answer is constant: band(37.42) = 35.
  const aboveSecret = observed.filter(([probe]) => probe >= SECRET).map(([, c]) => c);
  assert.deepStrictEqual([...new Set(aboveSecret)], [35],
    'every probe above the secret returns the same banded answer');

  // The finest distinction the oracle can draw is the band edge, so the
  // attacker ends knowing 35 <= min(others) < 40 and nothing sharper. Probes
  // one cent either side of the secret are indistinguishable.
  const at3741 = observed.find(([probe]) => probe === 37.41)[1];
  const at3743 = observed.find(([probe]) => probe === 37.43)[1];
  assert.strictEqual(at3741, at3743, 'a one-cent step across the secret is invisible');

  // And the search cannot be sharpened by moving to a band with a finer step:
  // probing inside [1,5) only ever reports the attacker's own number back.
  const at5 = observed.find(([probe]) => probe === 5)[1];
  assert.strictEqual(at5, 5, 'below the secret the oracle just echoes the probe');
  assertQueriesUnderstood();
});

test('NOTED: one member alone, with no collusion, always learns the band of everyone else\'s minimum', async () => {
  // The documented tradeoff says COLLUDERS learn a band. The floor is lower
  // than that: in any flock that reaches the threshold, submitting the maximum
  // makes the published ceiling a pure function of the other members' minimum.
  seedFlock({ creator: 1, members: [1, 2, 3] });
  as(2); await submit(52.75);
  as(3); await submit(140);

  as(1);
  const r = await submit(10000);
  assert.strictEqual(r.body.ceiling, 50,
    'the attacker contributed nothing to the MIN, so the answer is purely about the others');
  assert.strictEqual(r.body.isReady, true);
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// H. SKIP COUNT
// ═════════════════════════════════════════════════════════════════════════════

test('ABUSE H: skipCount is a direct per-person read in a two-member flock', async () => {
  seedFlock({ creator: 1, members: [1, 2] });
  as(1); await submit(50);

  as(1);
  let s = await status();
  assert.strictEqual(s.body.skipCount, 0, 'user 2 has not answered yet');

  as(2); await skip();

  as(1);
  s = await status();
  assert.strictEqual(s.body.skipCount, 1,
    'and now user 1 knows, precisely and by name, that user 2 declined to share a number');
  assert.strictEqual(s.body.isReady, false, 'while the amount itself stays withheld');
  assertQueriesUnderstood();
});

test('ABUSE H2: skipCount deanonymises in a three-member flock too, once the caller subtracts themselves', async () => {
  seedFlock({ creator: 1, members: [1, 2, 3] });
  as(1); await skip();
  as(2); await submit(40);
  as(3); await skip();

  as(1);
  const s = await status();
  // The caller knows their own answer, so skipCount - 1 is the others' skips,
  // and with two others and one skip among them the set is not anonymous once
  // user 2's own "userSkipped: false" is compared by user 2 in the same way.
  assert.strictEqual(s.body.skipCount, 2);
  assert.strictEqual(s.body.userSkipped, true);
  assert.strictEqual(s.body.submissionCount, 3);
  // From user 2's seat the arithmetic names user 1 and user 3 exactly.
  as(2);
  const s2 = await status();
  assert.strictEqual(s2.body.skipCount, 2);
  assert.strictEqual(s2.body.userSkipped, false,
    'user 2 did not skip, so both skips belong to the other two members, individually identified',
  );
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// WHAT HELD
// ═════════════════════════════════════════════════════════════════════════════

test('HELD: the raw MIN never reaches the wire on any of the three read paths', async () => {
  seedFlock({ creator: 1, members: [1, 2, 3] });
  as(1); await submit(37.42);
  as(2); await submit(41);
  as(3); await submit(63.99);

  as(1);
  const s = await status();
  assert.strictEqual(s.body.ceiling, 35);
  const sub = await submit(37.42);
  assert.strictEqual(sub.body.ceiling, 35);
  const locked = await call('POST', `/api/budget/${FLOCK}/lock`);
  assert.strictEqual(locked.body.ceiling, 35);
  assert.strictEqual(world.flocks.get(FLOCK).budget_ceiling, 35,
    'the cached column holds the band, not the minimum');
  assertQueriesUnderstood();
});

test('HELD: a non-member gets 403 on every route here and learns nothing about the flock', async () => {
  seedFlock({ creator: 1, members: [1, 2, 3] });
  as(77);
  for (const [method, path] of [
    ['GET', `/api/budget/${FLOCK}`],
    ['POST', `/api/budget/${FLOCK}/lock`],
    ['POST', `/api/budget/${FLOCK}/remind`],
  ]) {
    const r = await call(method, path);
    assert.strictEqual(r.status, 403, `${method} ${path} -> ${r.text}`);
  }
  const r = await submit(10);
  assert.strictEqual(r.status, 403);
  // Same answer for a flock that does not exist: no existence oracle.
  const ghost = await call('GET', '/api/budget/999999');
  assert.strictEqual(ghost.status, 403);
  assertQueriesUnderstood();
});

test('HELD: an amount can never be read back for another member on any response field', async () => {
  seedFlock({ creator: 1, members: [1, 2, 3] });
  as(2); await submit(12.34);
  as(3); await submit(99);
  as(1); await submit(77);

  const s = await status();
  const body = JSON.stringify(s.body);
  assert.strictEqual(body.includes('12.34'), false, 'no other member\'s amount appears anywhere');
  assert.strictEqual(body.includes('99'), false);
  assert.strictEqual(s.body.userAmount, 77, 'only the caller\'s own figure comes back');
  assertQueriesUnderstood();
});
