// Run: node --test  (from backend/)
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CEILING WAS A LIVE NUMBER, AND A LIVE MINIMUM NAMES A PERSON (round 22)
// ─────────────────────────────────────────────────────────────────────────────
//
// Reported by review, confirmed against the code before this file was written.
// It needs no collusion, no second account and no arithmetic beyond one
// subtraction. You watch the screen.
//
//   Four people. Three submit. The count reads "3 of 4" and a banded ceiling
//   appears, which is what the three-amount support gate is for and that part
//   worked. THE FOURTH PERSON SUBMITS AND THE NUMBER DROPS. Every member sees
//   the count go 3 to 4 and the ceiling move in the same instant, so the new
//   band belongs to exactly one person, and the two members who had not even
//   answered yet learn it too.
//
// The person exposed is always the one with the least money, because a MIN only
// moves when a new minimum arrives. The feature exists so that nobody has to
// say "that is too expensive" in front of six people, and it was saying it for
// them, by name. Banding limits the precision of each number; it does nothing
// about the difference between two of them.
//
// WHAT IS PINNED HERE: a ceiling is published once, at the moment the budget
// settles, and never moves after that, so there is no before-and-after pair
// left to subtract. Both doors are covered, because closing one moves the leak
// rather than removing it:
//
//   - the socket fan-out, budget_updated, which every member receives; and
//   - GET /api/budget/:flockId, which a client can poll on a timer and
//     reconstruct exactly the same sequence from.
//
// Every case therefore records EVERY ceiling every member could have observed,
// on both doors, and asserts on the set of distinct values rather than on a
// single response. One distinct number is the property. Two is the bug.
//
// No database. pool.query is a stateful semantic fixture; an unmodelled
// statement throws rather than answering with an empty result.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'budget-ceiling-differencing-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT; // push stays a no-op

const pool = require('../config/database');

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const pushMod = require('../services/pushHelper');
const pushes = [];
pushMod.pushIfOffline = async (_io, userId, title, body) => { pushes.push({ userId, title, body }); return { skipped: true }; };
pushMod.pushAlways = async () => ({ skipped: true });

const FLOCK = 7700;
let world;       // { flock, members: [ids], submissions: [{user_id, amount, skipped}] }
let emitted;     // every io emit: { room, event, payload }
let unknown;

function reset() {
  world = {
    flock: {
      id: FLOCK, creator_id: 1, name: 'Rooftop Friday', budget_enabled: true,
      budget_locked: false, budget_ceiling: null, budget_context: 'dinner',
      ghost_mode_enabled: false,
    },
    members: [1, 2, 3, 4],
    submissions: [],
  };
  emitted = [];
  unknown = [];
  pushes.length = 0;
}

const present = () => world.submissions.filter((s) => world.members.includes(s.user_id));
const minNonSkipped = () => {
  const amounts = present().filter((s) => s.skipped === false && s.amount != null).map((s) => Number(s.amount));
  return amounts.length ? Math.min(...amounts) : null;
};

// The fixture answers only statements that carry the membership JOIN, so an
// aggregate that stops reading through flock_members becomes unscripted and
// fails loudly instead of quietly counting a departed account again.
const MEMBER_JOIN = "JOIN flock_members bm ON bm.flock_id = bs.flock_id AND bm.user_id = bs.user_id AND bm.status = 'accepted'";

async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];
  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(flat)) return { rows: [], rowCount: 0 };

  if (/^SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'$/.test(flat)) {
    return world.members.includes(Number(p[1])) ? { rows: [{ id: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^SELECT budget_enabled, budget_locked FROM flocks WHERE id = \$1 FOR UPDATE$/.test(flat)) {
    return { rows: [{ budget_enabled: world.flock.budget_enabled, budget_locked: world.flock.budget_locked }], rowCount: 1 };
  }
  if (/^SELECT creator_id, budget_enabled, budget_locked FROM flocks WHERE id = \$1 FOR UPDATE$/.test(flat)) {
    const { creator_id, budget_enabled, budget_locked } = world.flock;
    return { rows: [{ creator_id, budget_enabled, budget_locked }], rowCount: 1 };
  }
  if (/^SELECT budget_enabled, budget_context, budget_locked, budget_ceiling, ghost_mode_enabled FROM flocks WHERE id = \$1$/.test(flat)) {
    return { rows: [{ ...world.flock }], rowCount: 1 };
  }
  if (/^INSERT INTO budget_submissions/.test(flat)) {
    const [, uid, amount, skipped] = [Number(p[0]), Number(p[1]), p[2], p[3]];
    const existing = world.submissions.find((s) => s.user_id === uid);
    if (existing) { existing.amount = amount; existing.skipped = !!skipped; }
    else world.submissions.push({ user_id: uid, amount, skipped: !!skipped });
    return { rows: [], rowCount: 1 };
  }
  if (/^SELECT MIN\(amount\) AS ceiling FROM budget_submissions bs /.test(flat) && flat.includes(MEMBER_JOIN)) {
    return { rows: [{ ceiling: minNonSkipped() }], rowCount: 1 };
  }
  if (/COUNT\(\*\) AS total_submissions/.test(flat) && flat.includes(MEMBER_JOIN)) {
    const rows = present();
    return {
      rows: [{
        total_submissions: String(rows.length),
        non_skip_count: String(rows.filter((s) => !s.skipped).length),
        skip_count: String(rows.filter((s) => s.skipped).length),
      }],
      rowCount: 1,
    };
  }
  if (/^SELECT COUNT\(\*\)::int AS n FROM budget_submissions bs /.test(flat) && flat.includes(MEMBER_JOIN)) {
    return { rows: [{ n: present().filter((s) => !s.skipped).length }], rowCount: 1 };
  }
  if (/^UPDATE flocks SET budget_locked = true/.test(flat)) {
    world.flock.budget_locked = true;
    world.flock.budget_ceiling = p[1];
    return { rows: [], rowCount: 1 };
  }
  if (/^SELECT COUNT\(\*\) AS total FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'$/.test(flat)) {
    return { rows: [{ total: String(world.members.length) }], rowCount: 1 };
  }
  if (/^SELECT amount, skipped FROM budget_submissions WHERE flock_id = \$1 AND user_id = \$2$/.test(flat)) {
    const s = world.submissions.find((x) => x.user_id === Number(p[1]));
    return s ? { rows: [{ amount: s.amount, skipped: s.skipped }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^SELECT name FROM flocks WHERE id = \$1$/.test(flat)) {
    return { rows: [{ name: world.flock.name }], rowCount: 1 };
  }
  if (/^SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'( AND user_id != \$2)?$/.test(flat)) {
    const exclude = p.length > 1 ? Number(p[1]) : null;
    const rows = world.members.filter((id) => id !== exclude).map((user_id) => ({ user_id }));
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
app.set('io', { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) });
app.use('/api/budget', budgetRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => { server.close(() => resolve()); pool.end?.().catch(() => {}); }));
test.beforeEach(() => { reset(); budgetRouter.__resetReminderCooldowns(); });

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

const as = (id) => { CURRENT_USER = { id, name: `U${id}`, email_verified: true, role: 'user' }; };
const submit = (amount) => call('POST', `/api/budget/${FLOCK}/submit`, { amount });
const status = () => call('GET', `/api/budget/${FLOCK}`);
const assertQueriesUnderstood = () => assert.deepStrictEqual(unknown, [], 'fixture did not model a query the route ran');

// Every ceiling that reached a member on the socket, in order.
const broadcastCeilings = () => emitted
  .filter((e) => e.event === 'budget_updated' || e.event === 'budget_locked')
  .map((e) => e.payload.ceiling);

// What EVERY member reads back, right now, from the polling door.
async function ceilingEachMemberReads() {
  const was = CURRENT_USER;
  const out = [];
  for (const id of world.members) { as(id); out.push((await status()).body.ceiling); }
  CURRENT_USER = was;
  return out;
}

const distinctNumbers = (values) => [...new Set(values.filter((v) => v !== null && v !== undefined))];

// ═════════════════════════════════════════════════════════════════════════════
// The report, executed
// ═════════════════════════════════════════════════════════════════════════════

test('the fourth submission is below the minimum and NO member receives a changed ceiling', async () => {
  // Three answers first. Under the old code this published band($60) = $60 to
  // everyone, and it is the existence of that first number, not its value,
  // that made the next one attributable.
  const seenOnSocket = [];
  const seenOnRead = [];

  for (const [user, amount] of [[1, 60], [2, 75], [3, 80]]) {
    as(user);
    const res = await submit(amount);
    assert.strictEqual(res.status, 200, res.text);
    seenOnSocket.push(...broadcastCeilings());
    seenOnRead.push(...(await ceilingEachMemberReads()));
    emitted.length = 0;
  }

  assert.deepStrictEqual(distinctNumbers(seenOnSocket), [],
    'a ceiling was broadcast while the flock was still answering');
  assert.deepStrictEqual(distinctNumbers(seenOnRead), [],
    'a ceiling was readable while the flock was still answering');

  // The exposed member: the one with the least money, who is why the ceiling
  // moves at all. $20 is below every amount already in.
  as(4);
  const settling = await submit(20);
  assert.strictEqual(settling.status, 200, settling.text);
  seenOnSocket.push(...broadcastCeilings());
  seenOnRead.push(...(await ceilingEachMemberReads()));

  // ONE number, on both doors, for every member. There is nothing to subtract
  // it from, so it says only "the group's cap is $20", never "the fourth
  // person is the reason".
  assert.deepStrictEqual(distinctNumbers(seenOnSocket), [bandCeiling(20)],
    'more than one ceiling reached the socket');
  assert.deepStrictEqual(distinctNumbers(seenOnRead), [bandCeiling(20)],
    'more than one ceiling was readable');
  assert.strictEqual(settling.body.ceiling, 20);
  assert.strictEqual(settling.body.budgetLocked, true);
  assertQueriesUnderstood();
});

test('the same run, read only by polling: the socket can go quiet and nothing changes', async () => {
  // The read path carries the whole attack on its own. A client that never
  // opens a socket and calls GET /api/budget on a timer sees exactly one
  // transition, from "no number" to "the number", and never two numbers.
  const timeline = [];
  for (const [user, amount] of [[1, 60], [2, 75], [3, 80], [4, 20]]) {
    as(user);
    await submit(amount);
    as(2); // one member, polling throughout
    timeline.push((await status()).body.ceiling);
  }

  assert.deepStrictEqual(timeline, [null, null, null, 20],
    `the polling door published a sequence: ${JSON.stringify(timeline)}`);
  const transitions = timeline.filter((v, i) => i > 0 && v !== timeline[i - 1]).length;
  assert.strictEqual(transitions, 1, 'a poller saw the number change more than once');
  assertQueriesUnderstood();
});

test('the group number does not move when the LAST answer is a high one either', async () => {
  // The mirror case, so the fix is not read as "we hid the drop". Whatever the
  // last answer is, exactly one number is published, and it is the MIN over
  // everybody, banded.
  for (const [user, amount] of [[1, 40], [2, 75], [3, 80], [4, 9000]]) {
    as(user);
    assert.strictEqual((await submit(amount)).status, 200);
  }
  assert.deepStrictEqual(distinctNumbers(broadcastCeilings()), [bandCeiling(40)]);
  assert.deepStrictEqual(distinctNumbers(await ceilingEachMemberReads()), [bandCeiling(40)]);
  assertQueriesUnderstood();
});

test('a late submission BELOW the published cap is refused, and the number does not move', async () => {
  // The other half of publishing once. A late low amount has to be refused or
  // silently dropped, and it is refused: silently dropping it would leave the
  // group holding a cap that a member present in the flock cannot afford,
  // which is the one guarantee the ceiling exists to keep. The refusal is
  // something the person can act on out loud, which is the fallback the
  // feature always had.
  for (const [user, amount] of [[1, 60], [2, 75], [3, 80], [4, 90]]) {
    as(user);
    await submit(amount);
  }
  const published = distinctNumbers(broadcastCeilings());
  assert.deepStrictEqual(published, [bandCeiling(60)]);

  // A fifth member arrives after the fact and tries to pull the cap down.
  world.members.push(5);
  as(5);
  const late = await submit(5);
  assert.strictEqual(late.status, 400, late.text);
  assert.match(late.body.error, /locked/i);
  assert.strictEqual(world.submissions.find((s) => s.user_id === 5), undefined,
    'a refused submission still wrote a row');

  // And an existing member cannot walk it down by editing their own answer.
  as(1);
  const edit = await submit(1);
  assert.strictEqual(edit.status, 400, edit.text);

  assert.deepStrictEqual(distinctNumbers(broadcastCeilings()), published,
    'a refused submission still moved the published number');
  assert.deepStrictEqual(distinctNumbers(await ceilingEachMemberReads()), published);
  assertQueriesUnderstood();
});

test('the creator locking early publishes once too, and cannot publish a second, different number', async () => {
  // The other route to a settled budget: three amounts exist, a fourth member
  // is never going to answer, and the creator sets it. Same rule, because a
  // second lock recomputing over whoever is left is the same subtraction with
  // a departure in place of a submission.
  for (const [user, amount] of [[1, 60], [2, 75], [3, 80]]) { as(user); await submit(amount); }
  assert.deepStrictEqual(distinctNumbers(broadcastCeilings()), [], 'a number went out before the lock');

  as(1);
  const locked = await call('POST', `/api/budget/${FLOCK}/lock`);
  assert.strictEqual(locked.status, 200, locked.text);
  assert.strictEqual(locked.body.ceiling, bandCeiling(60));

  // The member holding the minimum leaves. A recompute would now say $75, and
  // the group would learn that the person who just left was the cheap one.
  world.members = world.members.filter((id) => id !== 1);
  world.flock.creator_id = 2;
  as(2);
  const relock = await call('POST', `/api/budget/${FLOCK}/lock`);
  assert.strictEqual(relock.status, 400, relock.text);
  assert.match(relock.body.error, /locked/i);

  assert.deepStrictEqual(distinctNumbers(broadcastCeilings()), [bandCeiling(60)],
    'a second lock published a second number');
  assert.strictEqual(Number(world.flock.budget_ceiling), bandCeiling(60),
    'a second lock rewrote the cached column');
  assertQueriesUnderstood();
});

test('the announcement is sent once, and only when there is a number to announce', async () => {
  // The push carries the ceiling in its body text, so it is a publication like
  // any other. It used to fire on the three-submission crossing, which is the
  // exact moment this bug says a number must NOT go out.
  for (const [user, amount] of [[1, 60], [2, 75], [3, 80]]) { as(user); await submit(amount); }
  assert.deepStrictEqual(pushes, [], 'the group was notified of a number that had not been published');

  as(4);
  await submit(20);
  assert.strictEqual(pushes.length, world.members.length - 1,
    'every member except the one who settled it hears once');
  for (const p of pushes) {
    assert.match(p.body, /\$20\b/, `push said: ${p.body}`);
  }
  assertQueriesUnderstood();
});

test('the support gate still comes first: everyone answering is not enough on its own', async () => {
  // Everybody has answered and only two of them shared an amount, so nothing
  // is published and nothing is frozen. The flock can still reach three by
  // somebody turning a skip into an amount, and locking it here would take
  // that away in exchange for a number nobody is allowed to see.
  as(1); await submit(60);
  as(2); await submit(75);
  as(3); await call('POST', `/api/budget/${FLOCK}/submit`, { amount: 0, skipped: true });
  as(4); const last = await call('POST', `/api/budget/${FLOCK}/submit`, { amount: 0, skipped: true });

  assert.strictEqual(last.body.submissionCount, 4, 'the screen still says everyone answered');
  assert.strictEqual(last.body.isReady, false);
  assert.strictEqual(last.body.ceiling, null);
  assert.strictEqual(last.body.budgetLocked, false, 'a budget with no publishable number was frozen anyway');
  assert.deepStrictEqual(distinctNumbers(broadcastCeilings()), []);

  // The skipper changes their mind, which is the reason the budget was left
  // open, and THAT is the publication.
  as(3);
  const settling = await submit(90);
  assert.strictEqual(settling.body.ceiling, bandCeiling(60));
  assert.strictEqual(settling.body.budgetLocked, true);
  assert.deepStrictEqual(distinctNumbers(broadcastCeilings()), [bandCeiling(60)]);
  assertQueriesUnderstood();
});

test('the aggregate a member DOES get is unchanged, because coordination is not the private part', async () => {
  // The fix withholds a number, not the progress. "2 of 4 answered" is what
  // makes chasing the last person possible, and it says nothing about what
  // anybody answered.
  as(1); await submit(60);
  emitted.length = 0;
  as(2); const res = await submit(75);

  assert.strictEqual(res.body.submissionCount, 2);
  assert.strictEqual(res.body.totalMembers, 4);
  assert.strictEqual(res.body.isReady, false);
  assert.strictEqual(res.body.ceiling, null);
  const updates = emitted.filter((e) => e.event === 'budget_updated');
  assert.ok(updates.length > 0, 'no budget_updated fan-out');
  for (const u of updates) {
    assert.strictEqual(u.payload.submissionCount, 2);
    assert.strictEqual(u.payload.totalMembers, 4);
    assert.strictEqual(u.payload.ceiling, null);
  }

  // And the caller's own amount is still their own to see.
  const own = await status();
  assert.strictEqual(own.body.userAmount, 75);
  assertQueriesUnderstood();
});

test('nothing writes flocks.budget_ceiling until the budget settles', async () => {
  // The structural half of the fix. The cached column means THE PUBLISHED
  // NUMBER, so an open flock has nothing in it, and a reader that forgets the
  // gate has nothing to leak. This route has twice been the subject of a
  // finding whose shape was "one of the five readers forgot".
  for (const [user, amount] of [[1, 60], [2, 75], [3, 80]]) {
    as(user);
    await submit(amount);
    assert.strictEqual(world.flock.budget_ceiling, null,
      'the running minimum was cached where four other routes can read it');
  }
  as(4); await submit(20);
  assert.strictEqual(Number(world.flock.budget_ceiling), bandCeiling(20));
  assert.strictEqual(world.flock.budget_locked, true);
  assertQueriesUnderstood();
});
