// Run: node --test  (from backend/)
//
// ─────────────────────────────────────────────────────────────────────────────
// GAME-RULE ABUSE — anonymous budget matching (routes/budget.js)
// ─────────────────────────────────────────────────────────────────────────────
//
// The design is explicit about what it will and will not publish: the ceiling
// is MIN(non-skipped amounts), it is published as a BAND rather than the raw
// minimum, and it is withheld entirely until THREE non-skipped submissions
// exist.
//
// This file attacked past that line and found three defects. All three are now
// fixed in routes/budget.js and every case below asserts the FIXED behaviour;
// the attacks are kept in the words of the attack so a regression reads as the
// abuse it would restore.
//
//   E. POISON AND RUN (was a defect, closed). budget_submissions had no
//      relationship to flock_members, so a member could submit $0.01, leave,
//      and the row went on setting the group MIN forever: the author was then
//      403'd off their own row, this router has no delete path, and /lock
//      recomputed the same MIN and committed the group to a cent.
//      routes/venues.js closed exactly this shape for venue_votes in round 17.
//      Every aggregate here now reads submissions through flock_members, so a
//      departed account's row is inert until they rejoin.
//
//   F. BORROWED ANONYMITY (was a defect, closed by the same join). The >= 3
//      non-skip threshold exists to give an amount a crowd to hide in, and it
//      counted ROWS, not present members: one throwaway that submitted and
//      left carried a two-person flock over the line, and the two people in
//      the room were shown a band around one of their own amounts. Counting
//      present members only, the reveal now needs three people who are
//      actually there, and it reverses if one of them leaves.
//
//   G. DIFFERENCING (was held at the band, CLOSED in round 22). A member who
//      resubmitted and re-read could binary-search the others' minimum, and
//      bandCeiling floored the answer so the search converged on the BAND EDGE
//      rather than the figure. The oracle itself is gone now: a ceiling is
//      published once, when the budget settles, and submissions are refused
//      after that, so one sample is all there is and a probe cannot be
//      repeated. The wider form of the same bug, which needed no probing at
//      all because the number simply MOVED when the last person answered, has
//      its own file: __tests__/budgetCeilingDifferencing.
//
//   H. SKIP COUNT (was a defect, closed). skipCount was returned raw to every
//      member. The caller knows their own answer, so in a two-person flock it
//      was a direct read of whether the other person declined to share a
//      number, and in a three-person flock 0 or 2 named both of the others. It
//      is now withheld (null) unless it ranges over at least three co-members.
//
//   NOTED, and not fixable: one member alone, with no collusion, always learns
//      the BAND of everyone else's minimum by submitting the maximum. See the
//      case at the end of section G. The residual the privacy policy and the
//      terms have to describe is the band, not collusion.
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

// Every aggregate on this router must read submissions THROUGH flock_members.
// The fixture answers only queries that carry that join, so dropping it does
// not quietly return to counting departed accounts: the statement becomes
// unscripted, dispatch throws, and assertQueriesUnderstood names it.
const MEMBER_JOIN = "JOIN flock_members bm ON bm.flock_id = bs.flock_id AND bm.user_id = bs.user_id AND bm.status = 'accepted'";
const overMembers = (flat) => flat.includes(MEMBER_JOIN);
function memberSubmissions(flockId) {
  const accepted = new Set(
    world.members.filter((m) => m.flock_id === flockId && m.status === 'accepted').map((m) => m.user_id),
  );
  return world.submissions.filter((s) => s.flock_id === flockId && accepted.has(s.user_id));
}
function minNonSkipped(flockId) {
  const amts = memberSubmissions(flockId)
    .filter((s) => s.skipped === false && s.amount != null)
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
  if (/^SELECT creator_id, budget_enabled, budget_locked FROM flocks WHERE id = \$1 FOR UPDATE$/.test(flat)) {
    const f = world.flocks.get(Number(p[0]));
    return f
      ? { rows: [{ creator_id: f.creator_id, budget_enabled: f.budget_enabled, budget_locked: f.budget_locked }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
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
  if (/^SELECT MIN\(amount\) AS ceiling FROM budget_submissions bs /.test(flat)
      && overMembers(flat) && /WHERE bs\.flock_id = \$1 AND skipped = false$/.test(flat)) {
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
  if (/COUNT\(\*\) AS total_submissions/.test(flat) && overMembers(flat)) {
    const rows = memberSubmissions(Number(p[0]));
    return {
      rows: [{
        total_submissions: String(rows.length),
        non_skip_count: String(rows.filter((s) => !s.skipped).length),
        skip_count: String(rows.filter((s) => s.skipped).length),
      }],
      rowCount: 1,
    };
  }
  if (/^SELECT COUNT\(\*\)::int AS n FROM budget_submissions bs /.test(flat)
      && overMembers(flat) && /WHERE bs\.flock_id = \$1 AND skipped = false$/.test(flat)) {
    const n = memberSubmissions(Number(p[0])).filter((s) => !s.skipped).length;
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
  // The socket fan-out roster (sockets/handlers.js emitToFlockMembers).
  if (/^SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'$/.test(flat)) {
    const rows = world.members
      .filter((m) => m.flock_id === Number(p[0]) && m.status === 'accepted')
      .map((m) => ({ user_id: m.user_id }));
    return { rows, rowCount: rows.length };
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

test('ABUSE E: a member submits $0.01 and leaves, and the cent leaves with them', async () => {
  seedFlock({ creator: 1, members: [1, 2, 3, 4] });

  // Three of the four real participants say what they can spend. Nothing is
  // published yet. One member has not answered, so a number now would be a
  // number that MOVES when they do. See settledCeiling in routes/budget.js.
  as(2); await submit(60);
  as(3); await submit(75);
  as(4); await submit(80);

  as(1);
  let s = await status();
  assert.strictEqual(s.body.isReady, true, 'three amounts are enough for a number to be publishable');
  assert.strictEqual(s.body.ceiling, null, 'and it is still not published, because user 1 has not answered');

  // The griefer joins the conversation with a cent and then walks out. While
  // they are IN the flock the cent counts, and it should: a present member who
  // can only spend a cent is exactly what the ceiling is for.
  const G = 9;
  world.members.push({ flock_id: FLOCK, user_id: G, status: 'accepted' });
  as(G);
  const poisoned = await submit(0.01);
  assert.strictEqual(poisoned.status, 200, poisoned.text);
  assert.strictEqual(poisoned.body.ceiling, null, 'four of five answered, so still nothing published');

  // POST /api/flocks/:id/leave deletes the flock_members row and nothing else,
  // so the submission row still exists...
  world.members = world.members.filter((m) => m.user_id !== G);
  assert.ok(submission(FLOCK, G), 'the row is still in the table');

  // ...and it no longer counts, because every aggregate reads through
  // flock_members now. The proof is the number the flock finally settles on
  // when its last member answers.
  as(1);
  s = await status();
  assert.strictEqual(s.body.submissionCount, 3, 'the departed row stopped being counted');
  assert.strictEqual(s.body.totalMembers, 4,
    'and "3 of 4 answered" is arithmetic again: a departed submitter used to push the left number past the right one',
  );

  const settling = await submit(90);
  assert.strictEqual(settling.status, 200, settling.text);
  assert.strictEqual(settling.body.ceiling, 60,
    'the group settles on what its MEMBERS can spend, not on a departed account\'s cent');
  assert.strictEqual(settling.body.budgetLocked, true);
  s = await status();
  assert.strictEqual(s.body.ceiling, 60, 'and reads the same number back');

  // The author still cannot edit the row from outside the flock, which is the
  // correct answer and is no longer a trap: leaving IS the withdrawal.
  as(G);
  const retry = await submit(60);
  assert.strictEqual(retry.status, 403, 'a non-member writes nothing here');

  // No delete path is needed, and there still is none: membership is the
  // relationship, so an orphaned row is inert rather than permanent.
  const paths = [];
  budgetRouter.stack.forEach((layer) => {
    if (layer.route) paths.push(`${Object.keys(layer.route.methods).join(',')} ${layer.route.path}`);
  });
  assert.deepStrictEqual(paths.filter((r) => r.startsWith('delete')), []);
  assertQueriesUnderstood();
});

test('ABUSE E2: the LOCK commits the group to the members\' MIN, not a departed account\'s', async () => {
  // Four members, one of whom never answers, so the budget never settles by
  // itself and the creator's lock is the publication. That is the path this
  // case is about.
  seedFlock({ creator: 1, members: [1, 2, 3, 4] });
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
  assert.strictEqual(locked.body.ceiling, 60,
    'MIN over the three present sharers is $65, banded down to $60',
  );
  assert.strictEqual(world.flocks.get(FLOCK).budget_locked, true);
  assert.strictEqual(world.flocks.get(FLOCK).budget_ceiling, 60,
    'and the cached column holds that, so no later reader republishes the cent',
  );

  // Locking is still one-way: nobody can move the number afterwards.
  as(1);
  const after = await submit(70);
  assert.strictEqual(after.status, 400, after.text);
  assert.match(after.body.error, /locked/i);
  assertQueriesUnderstood();
});

test('HELD: a LOCKED ceiling does not move when someone leaves afterwards', async () => {
  // The deliberate exception to recomputing on read. Locking is the group
  // committing to a number; if a member walks out after that, the figure
  // everyone agreed to has to stay the figure everyone agreed to, and must not
  // quietly climb to the MIN of whoever is left.
  seedFlock({ creator: 1, members: [1, 2, 3, 4] });
  as(1); await submit(70);
  as(2); await submit(65);
  as(3); await submit(200);
  // The last answer settles the budget in the same transaction that records
  // it, so this response is the one and only publication.
  as(4);
  const settling = await submit(90);
  assert.strictEqual(settling.body.ceiling, 60, 'MIN $65, banded to $60');
  assert.strictEqual(settling.body.budgetLocked, true);

  // User 2, whose $65 was the binding constraint, leaves. Three sharers are
  // still present, so the number is still publishable, and a recompute would
  // now say $70.
  world.members = world.members.filter((m) => m.user_id !== 2);

  as(1);
  const s = await status();
  assert.strictEqual(s.body.budgetLocked, true);
  assert.strictEqual(s.body.isReady, true);
  assert.strictEqual(s.body.ceiling, 60,
    'the committed number is still the committed number, not the MIN of who is left');
  assertQueriesUnderstood();
});

test('ABUSE E3: a departed submitter cannot hold the lock threshold open either', async () => {
  // The mirror of E2. Three shared amounts, one of them from an account that
  // has left: the flock is back to two, and the creator is told so in the
  // words of the rule rather than handed a two-person reveal.
  seedFlock({ creator: 1, members: [1, 2] });
  as(1); await submit(70);

  const G = 9;
  world.members.push({ flock_id: FLOCK, user_id: G, status: 'accepted' });
  as(G); await submit(10000);
  world.members = world.members.filter((m) => m.user_id !== G);

  // User 2 answers last, so this is the flock's "everyone has answered"
  // moment. Two present sharers is below the floor, so nothing settles and
  // nothing is published, and the budget stays open rather than freezing on a
  // number it is not allowed to show.
  as(2);
  const lastAnswer = await submit(43.20);
  assert.strictEqual(lastAnswer.body.ceiling, null);
  assert.strictEqual(lastAnswer.body.budgetLocked, false);

  as(1);
  const locked = await call('POST', `/api/budget/${FLOCK}/lock`);
  assert.strictEqual(locked.status, 400, locked.text);
  assert.match(locked.body.error, /3 people have shared an amount/);
  assert.strictEqual(world.flocks.get(FLOCK).budget_locked, false);
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// F. BORROWED ANONYMITY — the >=3 threshold counts rows, not people
// ═════════════════════════════════════════════════════════════════════════════

test('ABUSE F: a puppet who submits and leaves cannot lend a two-person flock a third person', async () => {
  // A and B are the flock. A wants B's number and cannot have it: two
  // non-skips is below the threshold, so the ceiling is withheld.
  seedFlock({ creator: 1, members: [1, 2] });
  as(1); await submit(10000);
  as(2); await submit(43.20);

  as(1);
  let s = await status();
  assert.strictEqual(s.body.isReady, false);
  assert.strictEqual(s.body.ceiling, null, 'correctly withheld at two submissions');

  // A brings in one puppet, who submits anything at all and then LEAVES.
  const P = 8;
  world.members.push({ flock_id: FLOCK, user_id: P, status: 'accepted' });
  as(P); await submit(10000);
  world.members = world.members.filter((m) => m.user_id !== P);

  as(1);
  s = await status();
  assert.strictEqual(s.body.totalMembers, 2, 'the flock really is two people');
  assert.strictEqual(s.body.submissionCount, 2, 'and only two submissions count');
  assert.strictEqual(s.body.isReady, false, 'so the privacy threshold is not satisfied');
  assert.strictEqual(s.body.ceiling, null,
    "B's amount stays withheld, which is the whole point of the threshold");

  // What A would have learned had the row counted, stated exactly, so the
  // stakes of a regression are on the page: B in [40, 45).
  assert.ok(bandCeiling(43.20) === 40 && bandCeiling(44.99) === 40 && bandCeiling(45) === 45);
  assertQueriesUnderstood();
});

test('ABUSE F2: a third account that STAYS is the honest residual, and its departure reverses the reveal', async () => {
  // The join does not pretend to stop collusion, and it should not: a third
  // person who is really in the flock is a third person, and A and the puppet
  // comparing notes is the documented tradeoff. What changed is that the
  // puppet has to remain in the roster everyone can see, and the moment they
  // leave the flock stops being three people and stops being told a number.
  seedFlock({ creator: 1, members: [1, 2] });
  as(1); await submit(10000);
  as(2); await submit(43.20);

  const P = 8;
  world.members.push({ flock_id: FLOCK, user_id: P, status: 'accepted' });
  as(P); await submit(10000);

  as(1);
  let s = await status();
  assert.strictEqual(s.body.totalMembers, 3, 'the puppet is visibly in the flock');
  assert.strictEqual(s.body.isReady, true);
  assert.strictEqual(s.body.ceiling, 40, 'three present people, so a band is published');

  // The puppet leaves. A departed account still cannot rewrite its own row,
  // which is unchanged and correct, but it no longer needs to, because
  // leaving withdraws the row's effect.
  world.members = world.members.filter((m) => m.user_id !== P);
  as(P);
  const regret = await skip();
  assert.strictEqual(regret.status, 403, 'a non-member writes nothing here');

  as(1);
  s = await status();
  assert.strictEqual(s.body.isReady, false, 'the reveal is not permanent');
  assert.strictEqual(s.body.ceiling, null);
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// G. DIFFERENCING — attacked, and it stops at the band
// ═════════════════════════════════════════════════════════════════════════════

test('CLOSED: resubmit-and-difference gets ONE sample, because the first answer that completes the flock settles it', async () => {
  // This case used to end "held at the band": the attacker could resubmit as
  // often as they liked and binary-search the others' minimum, and banding
  // meant the search converged on a band edge rather than the exact figure.
  //
  // Round 22 closed the oracle itself. The attacker's first submission is the
  // flock's last answer, so it settles the budget and every probe after it is
  // refused. One sample is not a search.
  seedFlock({ creator: 1, members: [1, 2, 3] });
  const SECRET = 37.42;      // what user 2 can spend
  as(2); await submit(SECRET);
  as(3); await submit(88);

  const observed = [];
  as(1);
  for (const probe of [5, 20, 30, 35, 36, 37, 37.41, 37.42, 37.43, 38, 40, 45, 100, 10000]) {
    const r = await submit(probe);
    observed.push([probe, r.status, r.body.ceiling]);
  }

  const [firstProbe, firstStatus, firstCeiling] = observed[0];
  assert.strictEqual(firstProbe, 5);
  assert.strictEqual(firstStatus, 200);
  assert.strictEqual(firstCeiling, 5,
    'the settling answer publishes band(MIN), which here is the attacker\'s own $5');

  for (const [probe, statusCode, ceiling] of observed.slice(1)) {
    assert.strictEqual(statusCode, 400, `probe ${probe} was accepted after the budget settled`);
    assert.strictEqual(ceiling, undefined, `probe ${probe} answered with a ceiling`);
  }

  // One published number, and it is the one the attacker's own amount set, so
  // it says nothing about user 2 at all.
  const published = observed.filter(([, statusCode]) => statusCode === 200).map(([, , c]) => c);
  assert.deepStrictEqual(published, [5], 'more than one ceiling reached the attacker');
  assert.ok(bandCeiling(SECRET) === 35, 'and the band that used to be recoverable was 35');
  assertQueriesUnderstood();
});

test('NOTED, NOT FIXABLE: one member alone, with no collusion, always learns the band of everyone else\'s minimum', async () => {
  // The documented tradeoff says COLLUDERS learn a band. The floor is lower
  // than that: in any flock that reaches the threshold, submitting the maximum
  // makes the published ceiling a pure function of the other members' minimum.
  //
  // VERDICT: not fixable while the feature keeps its point, and left as is on
  // purpose. The published cap has to be a number every member can afford, and
  // the only such number is the minimum, so whoever is not the binding
  // constraint learns a fact purely about the others by arithmetic. Noise
  // upward would publish a cap somebody cannot pay, which is the one thing the
  // ceiling exists to prevent; noise downward is what banding already is; a
  // per-member number would stop being a group cap. What is left is the BAND,
  // and the honest statement of the residual is "every member learns an
  // interval containing the lowest amount among the others, never an exact
  // figure and never a name", which is what the privacy policy and the terms
  // now have to say, in place of the collusion-only version.
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

test('ABUSE H: skipCount is withheld in a two-member flock, where it named the other person', async () => {
  seedFlock({ creator: 1, members: [1, 2] });
  as(1); await submit(50);

  as(1);
  let s = await status();
  assert.ok('skipCount' in s.body, 'the field stays on the wire; a withheld number is null, not a missing key');
  assert.strictEqual(s.body.skipCount, null);

  as(2); await skip();

  as(1);
  s = await status();
  assert.strictEqual(s.body.skipCount, null,
    'user 1 is not told whether user 2 declined to share a number');
  // What A is still told, and should be: somebody answered. Waiting on a
  // person is coordination; what they answered is the private part.
  assert.strictEqual(s.body.submissionCount, 2, 'both people have answered');
  assert.strictEqual(s.body.totalMembers, 2);
  assert.strictEqual(s.body.isReady, false, 'and the amount itself stays withheld');
  assertQueriesUnderstood();
});

test('ABUSE H2: withheld in a three-member flock too, where 0 or 2 named both of the others', async () => {
  seedFlock({ creator: 1, members: [1, 2, 3] });
  as(1); await skip();
  as(2); await submit(40);
  as(3); await skip();

  as(1);
  const s = await status();
  // The caller knows their own answer, so a published count of 2 here would
  // have told user 1 that user 3 skipped, and told user 2 that both of the
  // others did. Two co-members is not a crowd.
  assert.strictEqual(s.body.skipCount, null);
  assert.strictEqual(s.body.userSkipped, true, 'the caller still sees their own answer');
  assert.strictEqual(s.body.submissionCount, 3);
  as(2);
  const s2 = await status();
  assert.strictEqual(s2.body.skipCount, null);
  assert.strictEqual(s2.body.userSkipped, false);
  assertQueriesUnderstood();
});

test('ABUSE H3: the split does not move while the flock is answering, whatever its size', async () => {
  // ROUND 23 SUPERSEDES THE OLD "HELD" CASE HERE, which read the count back
  // mid-flock in a four-member flock and asserted it was published.
  //
  // The floor above is a bound on ONE READ: over three co-members, "one of
  // them skipped" names nobody. It is not a bound on a SEQUENCE, and the
  // sequence was published live on both doors. The delta between two
  // consecutive reads is a fact about the single row written between them, at
  // any flock size, so a member who reads this route twice around somebody
  // else's answer learns what that person chose. That is the same shape as the
  // live ceiling and it is closed the same way: published once, by the answer
  // that settles the budget, and never on a read.
  seedFlock({ creator: 1, members: [1, 2, 3, 4] });
  as(2); await skip();
  as(3); await submit(60);

  as(1);
  const s = await status();
  assert.strictEqual(s.body.totalMembers, 4, 'three co-members besides the caller');
  assert.ok('skipCount' in s.body, 'the field stays on the wire; a withheld number is null');
  assert.strictEqual(s.body.skipCount, null,
    'a poller can reconstruct who answered what from two of these');
  assert.strictEqual(s.body.submissionCount, 2, 'and coordination is untouched');

  // The submit door answers alike, so nothing can be read from one that the
  // other withholds. This one does not settle: user 4 has not answered.
  const sub = await submit(80);
  assert.strictEqual(sub.body.skipCount, null);
  assert.strictEqual(sub.body.budgetLocked, false);
  assertQueriesUnderstood();
});

test('HELD: the split is still published once, by the answer that settles the budget', async () => {
  // The fix is a floor, not a deletion, and round 23 is a schedule, not a
  // deletion either. A flock big enough for the count to be a count still gets
  // it, exactly once, at the moment there is no earlier number to compare it
  // against.
  seedFlock({ creator: 1, members: [1, 2, 3, 4] });
  as(1); await submit(50);
  as(2); await skip();
  as(3); await submit(60);
  as(4);
  const settling = await submit(80);

  assert.strictEqual(settling.body.budgetLocked, true, 'the last answer settles it');
  assert.strictEqual(settling.body.totalMembers, 4, 'three co-members besides the caller');
  assert.strictEqual(settling.body.skipCount, 1);
  assertQueriesUnderstood();
});

test('HELD: the socket fan-out withholds the skip count exactly as the response does', async () => {
  const emitted = [];
  app.set('io', { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) });
  try {
    seedFlock({ creator: 1, members: [1, 2] });
    as(1);
    await submit(50);
  } finally {
    app.set('io', null);
  }

  const updates = emitted.filter((e) => e.event === 'budget_updated');
  assert.ok(updates.length > 0, 'no budget_updated fan-out');
  for (const u of updates) {
    assert.strictEqual(u.payload.skipCount, null,
      'the socket payload is the same aggregate the response is');
    assert.strictEqual(u.payload.ceiling, null);
  }
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// WHAT HELD
// ═════════════════════════════════════════════════════════════════════════════

test('HELD: the raw MIN never reaches the wire on any of the three read paths', async () => {
  seedFlock({ creator: 1, members: [1, 2, 3] });
  as(1); await submit(37.42);
  as(2); await submit(41);
  as(3);
  const settling = await submit(63.99);
  assert.strictEqual(settling.body.ceiling, 35, 'the settle response carries the band');

  as(1);
  const s = await status();
  assert.strictEqual(s.body.ceiling, 35, 'and so does the read path');
  // The budget is settled, so neither door is open any more: a resubmission and
  // a second lock are both refused rather than answering with a number that
  // could differ from the first one.
  const sub = await submit(37.42);
  assert.strictEqual(sub.status, 400, sub.text);
  const locked = await call('POST', `/api/budget/${FLOCK}/lock`);
  assert.strictEqual(locked.status, 400, locked.text);
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
