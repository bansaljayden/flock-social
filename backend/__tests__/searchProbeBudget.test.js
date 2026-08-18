// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// GET /api/users/search — THE SECOND DOOR INTO THE DIRECTORY, audit round 4 R4-I1
// ---------------------------------------------------------------------------
// 54100f4 metered `GET /api/users/:id/card` at 120/hour and 400/day, and the
// round-4 audit confirmed that fix held on every axis it attacked. It closed
// the ROUTE. It did not close the CLASS, because `/search` answers the same
// question — "who is behind this identity, and what are they called?" — and
// answers it BETTER, since it does not require guessing an id:
//
//     GET /api/users/search?q=aa      ->  up to 20 {id, name, profile_image_url}
//
// 676 two-character substrings is 676 requests, comfortably inside one
// 15-minute apiLimiter window at 3,000/IP. Three characters (17,576) fits
// inside a day at 288,000/IP. For any realistic user base that is the whole
// table, with no id guessing and no 404s to filter out. Everything else about
// the route was already right — LIKE metacharacters escaped, `q` capped,
// blocked pairs mutually invisible, caller excluded, no email in the
// projection — and none of it is a ceiling.
//
// It is also the only leading-wildcard `ILIKE '%…%'` in the backend, which no
// index can serve, so every request is a sequential scan of `users` on the
// 20-connection primary pool.
//
// WHAT THIS FILE PINS.
//
//   1. There IS a per-account ceiling, and it is the same shared
//      utils/probeBudget.js mechanism /card, /friends and /flocks use — not a
//      hand-rolled counter and not a borrowed one.
//   2. Past the ceiling the route refuses, AND THE REFUSAL IS NOT A NEW
//      ORACLE: it is byte-identical, status and body, to the ordinary
//      no-matches answer. That is the discipline /card established when it
//      folded its refusal into the existing 404.
//   3. The refusal costs NO sequential scan. This is where this route
//      deliberately diverges from /card, whose lookup is a primary-key seek
//      and runs unconditionally for timing parity. Here the expensive query IS
//      the metered resource, so a gate behind it would meter nothing.
//   4. The ceiling is sized for a TYPED gesture, and it is per ACCOUNT: one
//      account spending its allowance must not throttle anybody else.
//
// No database. pool.query is a fixture dispatcher keyed on the SQL CLAUSE
// UNDER TEST, and an unrecognised statement is RECORDED and asserted against.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-search-probe-budget';

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

// ── Cast ────────────────────────────────────────────────────────────────────
const USERS = {};
for (const [id, name] of [[1, 'Alice'], [2, 'Bob'], [3, 'Carol']]) {
  USERS[id] = {
    id, name, email: `${name.toLowerCase()}@example.com`, role: 'user',
    email_verified: true, is_banned: false, token_version: 0,
    profile_image_url: null, bio: null,
  };
}
// The directory the walk is trying to harvest. `Aaron` is there so the walk's
// very FIRST two-character combination ("aa") already returns rows: the point
// of the case is that the harvest is real from request one and still gets cut
// off, not that the walker has to be lucky about where the alphabet starts.
const DIRECTORY = [{ id: 9, name: 'Aaron Blake', profile_image_url: null }];
for (let id = 10; id < 60; id++) DIRECTORY.push({ id, name: `Person ${id}`, profile_image_url: null });

let searchScans = 0;   // one per leading-wildcard ILIKE — the cost under audit
let unknown = [];

const realQuery = pool.query;
pool.query = (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  const has = (frag) => sql.includes(frag);

  // The authenticate middleware's own re-read of the caller's row.
  if (has('is_banned, token_version FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    return Promise.resolve({ rows: u ? [{ ...u }] : [], rowCount: u ? 1 : 0 });
  }
  // The route under test: the only `name ILIKE $1` in the file.
  if (has('SELECT id, name, profile_image_url') && has('name ILIKE $1')) {
    searchScans++;
    // The fixture answers a literal substring match, unescaping the two
    // wrapping % the route added. The escaping itself is pinned elsewhere.
    const needle = String(params[0]).slice(1, -1).replace(/\\(.)/g, '$1').toLowerCase();
    const hits = DIRECTORY.filter((u) => u.name.toLowerCase().includes(needle)).slice(0, 20);
    return Promise.resolve({ rows: hits, rowCount: hits.length });
  }
  unknown.push(sql);
  return Promise.resolve({ rows: [], rowCount: 0 });
};

const usersRouter = require('../routes/users');
const { searchProbeBudget, resetSearchProbeBudget, cardProbeBudget } = usersRouter.__testing;

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
  resetSearchProbeBudget();
  searchScans = 0;
  unknown = [];
});

function search(q, asId) {
  return fetch(`${base}/api/users/search?q=${encodeURIComponent(q)}`, {
    headers: { Authorization: `Bearer ${signUserToken(USERS[asId])}` },
  });
}

const assertModelled = () =>
  assert.deepStrictEqual(unknown, [], 'fixture did not model a query the route ran');

// ── 1. The ceiling exists, and it is the shared mechanism ───────────────────

test('R4-I1: /search is metered by the shared per-user probe budget, not by nothing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'users.js'), 'utf8');
  assert.match(source, /createUserBudget\(\{\s*name: 'search-probe'/,
    'the search budget must be created through createUserBudget, not hand-rolled');
  assert.match(source, /searchProbeBudget\.allow\(req\.user\.id\)/,
    'the budget must be charged against the authenticated account id');

  // A SEPARATE budget from the card's. Sharing one counter would either starve
  // the card (whose gesture is ~7x more frequent) or hand an enumerator the
  // card's 400-wide lane into a route that needs no id at all.
  assert.notStrictEqual(searchProbeBudget, cardProbeBudget,
    'search and card must not share one counter — different gestures, different rates');

  // A search is TYPED and a card open is a TAP, so this ceiling is deliberately
  // tighter. The floor is what a person with a debounced search box can
  // actually produce; the roof is where it would stop being a control.
  assert.ok(searchProbeBudget.limits.hourly >= 40,
    `hourly ceiling ${searchProbeBudget.limits.hourly} is too tight for a debounced search box`);
  assert.ok(searchProbeBudget.limits.hourly < cardProbeBudget.limits.hourly,
    'a typed search should not be given a looser ceiling than a tapped card');
  assert.ok(searchProbeBudget.limits.daily <= 1000,
    'a daily ceiling this high stops being a control');
});

// ── 2. The walk is refused ──────────────────────────────────────────────────

test('R4-I1: the two-character substring walk is cut off at the ceiling', async () => {
  const { hourly } = searchProbeBudget.limits;
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let served = 0;
  let harvested = 0;

  // The audit's walk, verbatim in shape: iterate short substrings, keep the
  // rows. 676 combinations is one 15-minute apiLimiter window.
  outer:
  for (const a of letters) {
    for (const b of letters) {
      const res = await search(a + b, 1);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      if (body.users.length > 0) { served++; harvested += body.users.length; }
      if (served + 1 > hourly + 5) break outer;
    }
  }

  assert.strictEqual(searchScans, hourly,
    `the walk ran ${searchScans} sequential scans against a ceiling of ${hourly}`);
  assert.strictEqual(searchProbeBudget.remaining(1).hourly, 0);
  // The harvest is real — this is not a case that passes because the walk was
  // ineffective. `aa` is the first combination tried and Aaron Blake matches it.
  assert.ok(harvested > 0, 'fixture broken: the walk harvested nothing even before the ceiling');
  // ...and it is bounded by the budget rather than by the alphabet: 676
  // combinations were available and only `hourly` of them were answered.
  assert.ok(hourly < 676,
    'the ceiling is above the whole two-character key space, so it bounds nothing');
  assertModelled();
});

test('R4-I1: past the ceiling the refusal is indistinguishable from "nobody matched"', async () => {
  // Spend the allowance through the very object the route holds, so the case
  // cannot pass by throttling a copy.
  const { hourly } = searchProbeBudget.limits;
  for (let i = 0; i < hourly; i++) assert.ok(searchProbeBudget.allow(1), `unit ${i} refused early`);

  // Alice is exhausted, and asks for a term that WOULD have matched.
  const exhausted = await search('Person 1', 1);
  const exhaustedBody = await exhausted.json();

  // Carol has a full allowance and asks for a term that matches nobody.
  const genuinelyEmpty = await search('zzzzzz-nobody', 3);
  const genuinelyEmptyBody = await genuinelyEmpty.json();

  assert.strictEqual(exhausted.status, 200,
    'the refusal must be a 200 with an empty list, not a 429 — a 429 confirms the request reached the budget');
  assert.strictEqual(genuinelyEmpty.status, 200);
  assert.deepStrictEqual(exhaustedBody, genuinelyEmptyBody,
    'the exhausted refusal must be byte-identical to an ordinary no-matches answer');
  assert.deepStrictEqual(exhaustedBody, { users: [] });

  // Header parity: neither response may carry a hint the other does not.
  const strip = (h) => {
    const o = {};
    for (const [k, v] of h) if (!['date', 'content-length', 'etag'].includes(k)) o[k] = v;
    return o;
  };
  assert.deepStrictEqual(strip(exhausted.headers), strip(genuinelyEmpty.headers),
    'the refusal set a header the empty-result answer does not');
  assertModelled();
});

test('R4-I1: a refused search runs NO sequential scan', async () => {
  const { hourly } = searchProbeBudget.limits;
  for (let i = 0; i < hourly; i++) searchProbeBudget.allow(1);

  searchScans = 0;
  for (let i = 0; i < 25; i++) await search(`term${i}`, 1);

  // This is the deliberate divergence from /card, and it is the DoS half of the
  // finding. /card's lookup is a primary-key seek, so running it unconditionally
  // costs nothing and buys timing parity. This route's query is the backend's
  // only leading-wildcard ILIKE — an unindexable sequential scan of `users` on
  // the 20-connection primary pool. If it still ran, the budget would meter
  // nothing at all.
  assert.strictEqual(searchScans, 0,
    'a refused search still ran the sequential scan the budget exists to prevent');
  assertModelled();
});

// ── 3. Per account, and normal use is well inside it ────────────────────────

test('R4-I1: one account spending its allowance does not throttle another', async () => {
  const { hourly } = searchProbeBudget.limits;
  for (let i = 0; i < hourly; i++) searchProbeBudget.allow(1);

  const alice = await (await search('Person 1', 1)).json();
  assert.deepStrictEqual(alice, { users: [] }, 'Alice should be exhausted');

  searchScans = 0;
  const bob = await (await search('Person 1', 2)).json();
  assert.ok(bob.users.length > 0, "Bob inherited Alice's spend");
  assert.strictEqual(searchScans, 1);
  assertModelled();
});

test('R4-I1: a person typing a name character by character is nowhere near the ceiling', async () => {
  // A debounced search box sends one request per settled prefix, so a six-
  // character name is up to six requests. Ten full searches typed that way is
  // the heaviest realistic hour, and it must not come close to refusing.
  //
  // THIS CASE ALREADY EARNED ITS KEEP: the first version of the budget was
  // 60/hour, which is exactly the 60 requests below, so a heavy but entirely
  // legitimate hour landed on the ceiling. That is why the assertion is
  // "headroom remains" rather than a restatement of the constant — a ceiling
  // set to the worst legitimate case is a bug report waiting to happen.
  const typed = ['P', 'Pe', 'Per', 'Pers', 'Perso', 'Person'];
  for (let round = 0; round < 10; round++) {
    for (const prefix of typed) {
      const res = await search(prefix, 2);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.users), 'a real session was refused');
    }
  }
  assert.strictEqual(searchScans, 60, 'the session was throttled inside its own hour');
  assert.ok(searchProbeBudget.remaining(2).hourly > 0,
    'ten typed searches exhausted the hourly allowance — the ceiling is too tight for a real person');
  assertModelled();
});

// ── 4. The class, not the instance ──────────────────────────────────────────

test('R4-I1: every route in users.js that answers "who is this" carries a budget', () => {
  const source = fs
    .readFileSync(path.join(__dirname, '..', 'routes', 'users.js'), 'utf8')
    .replace(/\r\n/g, '\n');

  // This is the assertion that would have caught R4-I1 in round 3: it names
  // the QUESTION rather than the route, so a third door has to declare itself.
  // If a new route selects another account's name or avatar, add it here with
  // its budget — or state in one line why it is not a probe.
  const DIRECTORY_ROUTES = [
    { path: "'/search'", budget: 'searchProbeBudget' },
    { path: "'/:id/card'", budget: 'cardProbeBudget' },
  ];
  for (const { path: p, budget } of DIRECTORY_ROUTES) {
    const at = source.indexOf(`router.get(${p}`);
    assert.notStrictEqual(at, -1, `${p} is gone from routes/users.js; update this list`);
    const next = source.indexOf('\nrouter.', at + 1);
    const body = source.slice(at, next === -1 ? source.length : next);
    assert.ok(body.includes(`${budget}.allow(req.user.id)`),
      `${p} answers "who is behind this identity" and no longer charges ${budget}`);
  }

  // GET /suggested is the third route that emits names and avatars and it is
  // deliberately NOT on the list: its projection is derived from the caller's
  // OWN accepted flock memberships (`fm1.user_id = $1`), so it cannot be
  // steered at a stranger and the result set is a fixed function of the
  // caller's own graph. There is no caller-chosen parameter to iterate.
  const sug = source.indexOf("router.get('/suggested'");
  assert.notStrictEqual(sug, -1, '/suggested moved; re-check the reasoning above');
  const sugBody = source.slice(sug, source.indexOf('\nrouter.', sug + 1));
  assert.ok(/WHERE fm1\.user_id = \$1/.test(sugBody),
    '/suggested stopped being scoped to the caller\'s own memberships, so it is now a probe and needs a budget');
  assert.ok(!/req\.query|req\.params/.test(sugBody),
    '/suggested grew a caller-chosen parameter, so it can now be steered and needs a budget');
});
