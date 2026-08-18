// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// GET /api/users/:id/card AS A DIRECTORY WALK — security audit round 3, I3-1
// ---------------------------------------------------------------------------
// The card returns {id, name, profile_image_url, bio} for any id, ids are
// sequential integers, and it shipped with NO probe budget. The only ceiling in
// front of it was the router-wide apiLimiter — 3,000 requests / 15 min PER IP,
// i.e. ~288,000 ids a day, and rotating IPs multiplies that while the account
// stays the same. routes/friends.js exists to meter exactly this question
// (friendProbeBudget, 20/hour and 60/day) and this route routed around it.
//
// WHAT THIS FILE PINS.
//
//   1. There IS a per-account ceiling, and it is the shared
//      utils/probeBudget.js mechanism the friend probe and the invite budget
//      use — not a hand-rolled counter.
//   2. Past the ceiling the route refuses, and THE REFUSAL IS NOT A NEW ORACLE:
//      the exhausted response is byte-identical to the 404 a nonexistent id
//      gets, at the same query cost, so a walker who runs out of budget cannot
//      read existence out of the shape of the refusal.
//   3. Normal person-card use is well inside the ceiling. A tap on a face is a
//      frequent gesture; a budget that a real session can exhaust is a bug
//      report waiting to happen, so the headroom is asserted rather than
//      assumed.
//   4. The budget is per ACCOUNT. One account burning its allowance must not
//      throttle anybody else, and a second account must not inherit the first
//      one's spend.
//
// No database. pool.query is a fixture dispatcher keyed on the SQL CLAUSE UNDER
// TEST (never a bare prefix), and an unrecognised statement is RECORDED and
// asserted against rather than silently answered with zero rows — the same
// house rule as __tests__/userBioCard.test.js.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-card-probe-budget';

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

// ── Cast ────────────────────────────────────────────────────────────────────
// 1 Alice, 2 Bob, 3 Carol — three ordinary accounts. Everything above id 900 is
// absent, which is what the walker is trying to find out.
const USERS = {};
for (const [id, name] of [[1, 'Alice'], [2, 'Bob'], [3, 'Carol']]) {
  USERS[id] = {
    id, name, email: `${name.toLowerCase()}@example.com`, role: 'user',
    email_verified: true, is_banned: false, token_version: 0,
    profile_image_url: null, bio: `${name} plans things`,
  };
}
// A populated stretch of the id space for the "normal use" case.
for (let id = 10; id < 200; id++) {
  USERS[id] = {
    id, name: `Person ${id}`, email: `p${id}@example.com`, role: 'user',
    email_verified: true, is_banned: false, token_version: 0,
    profile_image_url: null, bio: null,
  };
}

let cardQueries = 0;
let blockQueries = 0;
let unknown = [];

const realQuery = pool.query;
pool.query = (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  const has = (frag) => sql.includes(frag);

  if (has('is_banned, token_version FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    return Promise.resolve({ rows: u ? [{ ...u }] : [], rowCount: u ? 1 : 0 });
  }
  if (has('SELECT id, name, profile_image_url, bio, is_banned FROM users WHERE id = $1')) {
    cardQueries++;
    const u = USERS[params[0]];
    if (!u) return Promise.resolve({ rows: [], rowCount: 0 });
    return Promise.resolve({
      rows: [{
        id: u.id, name: u.name, profile_image_url: u.profile_image_url,
        bio: u.bio, is_banned: u.is_banned,
      }],
      rowCount: 1,
    });
  }
  if (has('SELECT 1 FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2)')) {
    blockQueries++;
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  unknown.push(sql);
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const usersRouter = require('../routes/users');
const { cardProbeBudget, resetCardProbeBudget } = usersRouter.__testing;

const app = express();
app.use(express.json());
app.use('/api/users', usersRouter);

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
test.beforeEach(() => {
  resetCardProbeBudget();
  cardQueries = 0;
  blockQueries = 0;
  unknown = [];
});

function card(targetId, asId) {
  return fetch(`${base}/api/users/${targetId}/card`, {
    headers: { Authorization: `Bearer ${signUserToken(USERS[asId]) }` },
  });
}

const assertModelled = () =>
  assert.deepStrictEqual(unknown, [], 'fixture did not model a query the route ran');

// ── 1. The ceiling exists, and it is the shared mechanism ───────────────────

test('the card is metered by the shared per-user probe budget, not by nothing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'users.js'), 'utf8');
  assert.match(source, /require\('\.\.\/utils\/probeBudget'\)/,
    'the card route must reuse utils/probeBudget.js, the mechanism friends.js and flocks.js already use');
  assert.match(source, /createUserBudget\(\{\s*name: 'card-probe'/,
    'the budget must be created through createUserBudget, not hand-rolled');
  assert.match(source, /cardProbeBudget\.allow\(req\.user\.id\)/,
    'the budget must be charged against the authenticated account id');

  // The numbers live in one place; this pins the shape rather than restating
  // them, except for the floor the comment promises a real session never hits.
  assert.ok(cardProbeBudget.limits.hourly >= 100,
    `hourly ceiling ${cardProbeBudget.limits.hourly} is too tight for a gesture as common as tapping a face`);
  assert.ok(cardProbeBudget.limits.daily >= 300,
    `daily ceiling ${cardProbeBudget.limits.daily} is too tight for several sessions in a day`);
  // ...and generous is not the same as useless: the whole point is that it is
  // orders of magnitude below what apiLimiter alone permits (~288,000/day).
  assert.ok(cardProbeBudget.limits.daily <= 2000,
    'a daily ceiling this high stops being a control');
});

// ── 2. Past the ceiling, and the refusal is not an oracle ───────────────────

test('past the ceiling the card refuses, indistinguishably from a nonexistent id', async () => {
  // Spend the hourly allowance through the very object the route holds, so the
  // case cannot pass by throttling a copy.
  const { hourly } = cardProbeBudget.limits;
  for (let i = 0; i < hourly; i++) assert.ok(cardProbeBudget.allow(1), `unit ${i} refused early`);

  // A live user Alice may not read any more.
  cardQueries = 0; blockQueries = 0;
  const exhausted = await card(2, 1);
  const exhaustedBody = await exhausted.json();
  const exhaustedQueries = cardQueries;
  const exhaustedBlockQueries = blockQueries;

  // An id that does not exist, from an account with a FULL allowance, so the
  // two responses differ only in whether the target is real.
  cardQueries = 0; blockQueries = 0;
  const missing = await card(999999, 3);
  const missingBody = await missing.json();

  assert.strictEqual(exhausted.status, 404, 'the exhausted refusal must be a 404, not a 429');
  assert.strictEqual(missing.status, 404);
  assert.deepStrictEqual(exhaustedBody, missingBody,
    'the exhausted refusal must be byte-identical to the missing-user 404');
  assert.deepStrictEqual(exhaustedBody, { error: 'User not found' });

  // Same work, so the two cannot be separated by response time either: one
  // users lookup, no block probe.
  assert.strictEqual(exhaustedQueries, 1,
    'the exhausted path must run the same single users lookup a genuine miss runs');
  assert.strictEqual(cardQueries, 1);
  assert.strictEqual(exhaustedBlockQueries, 0, 'the exhausted path must not reach the block probe');
  assert.strictEqual(blockQueries, 0);

  // And it must not have leaked the row it read.
  const raw = JSON.stringify(exhaustedBody);
  assert.ok(!raw.includes('Bob') && !raw.includes('plans things'), 'the refused card served data anyway');
  assertModelled();
});

test('an exhausted walker cannot tell a live id from an absent one', async () => {
  const { hourly } = cardProbeBudget.limits;
  for (let i = 0; i < hourly; i++) cardProbeBudget.allow(1);

  const live = await card(2, 1);        // exists
  const absent = await card(999998, 1); // does not
  assert.strictEqual(live.status, absent.status);
  assert.deepStrictEqual(await live.json(), await absent.json());
  assertModelled();
});

// ── 3. Normal use is nowhere near the ceiling ───────────────────────────────

test('a heavy but ordinary session — 100 person cards — stays inside the budget', async () => {
  for (let i = 0; i < 100; i++) {
    const res = await card(10 + i, 1);
    assert.strictEqual(res.status, 200, `card ${i + 1} of an ordinary session was refused`);
  }
  const left = cardProbeBudget.remaining(1);
  assert.ok(left.hourly > 0 && left.daily > 0,
    `a 100-card session left ${JSON.stringify(left)} — no headroom for the next screen`);
  assertModelled();
});

test('your own card is free — the profile screen cannot burn the allowance', async () => {
  for (let i = 0; i < 50; i++) {
    const res = await card(1, 1);
    assert.strictEqual(res.status, 200);
  }
  assert.deepStrictEqual(cardProbeBudget.remaining(1), {
    hourly: cardProbeBudget.limits.hourly,
    daily: cardProbeBudget.limits.daily,
  }, 'reading your own card charged a probe');
  assertModelled();
});

// ── 4. The budget is per account ────────────────────────────────────────────

test('one account exhausting its budget does not throttle another', async () => {
  const { hourly } = cardProbeBudget.limits;
  for (let i = 0; i < hourly; i++) cardProbeBudget.allow(1);

  assert.strictEqual((await card(2, 1)).status, 404, 'the spent account still read a card');

  const other = await card(2, 3);
  assert.strictEqual(other.status, 200, 'a second account inherited the first one\'s spend');
  assert.strictEqual((await other.json()).name, 'Bob');
  assertModelled();
});

test('a 400 for a malformed id is decided before the budget is charged', async () => {
  for (const bad of ['abc', '0', '-5', '2147483648']) {
    const res = await card(bad, 1);
    assert.strictEqual(res.status, 400, `/${bad}/card answered ${res.status}`);
  }
  assert.deepStrictEqual(cardProbeBudget.remaining(1), {
    hourly: cardProbeBudget.limits.hourly,
    daily: cardProbeBudget.limits.daily,
  }, 'a request rejected by the validator still spent budget — free denial-of-budget');
  assertModelled();
});
