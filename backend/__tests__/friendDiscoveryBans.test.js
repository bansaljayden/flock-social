// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// A BAN HAS TO REACH FRIEND DISCOVERY.
// ---------------------------------------------------------------------------
// routes/friends.js consulted utils/blocks.js on every path and `users.is_banned`
// on exactly one: POST /find-by-phone, which was written last and whose own
// header says "a banned account is not somebody to hand anyone". That sentence
// was true of the whole file and enforced on one route of it.
//
// What that left on a product whose floor is 13, and what these tests execute:
//
//   * Quick Add suggested a banned account, with a face and a mutual-friend
//     count, to the next person in its network.
//   * A friend request aimed at a banned account was accepted and answered
//     "Friend request sent", so the sender watched Pending forever against an
//     account that can never sign in to accept it.
//   * A friend code is a base36 user id, so POST /add-by-code was the same door
//     with a different spelling and had the same hole.
//   * A request the account had sent BEFORE the ban stayed at the top of the
//     victim's requests screen, actionable, and accepting it minted a live
//     friendship.
//   * GET /api/users/:id/card has refused banned rows since it was written, so
//     the friends list was already offering a row whose profile card 404s.
//
// TWO SHAPES ARE ASSERTED, and they are different on purpose.
//
//   PROBES fold the banned row into the single miss they already have, so a
//   banned target is BYTE-IDENTICAL to an id nobody holds. A distinguishable
//   answer would be a new oracle: it confirms the id exists AND reports a
//   moderation decision about a named person to a stranger. Same rule as
//   routes/users.js's card probe and routes/moderation.js's block probe. The
//   budget is charged first, so a banned target is not a free lane either.
//
//   LISTS filter in SQL, the way they already filter blocked accounts. Those
//   four statements are asserted against the SOURCE rather than through a
//   fixture, deliberately: a stub that hands back rows regardless of the WHERE
//   clause cannot prove a WHERE clause exists, and a test that cannot fail when
//   the predicate is deleted is not pinning anything. Delete a predicate and
//   the matching assertion below goes red.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'friend-discovery-bans-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT; // push stays a no-op

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

// ── Fixture ─────────────────────────────────────────────────────────────────
const ME = {
  id: 1, email: 'ava@example.com', name: 'Ava', role: 'user',
  profile_image_url: null, email_verified: true, is_banned: false, token_version: 0,
};

// id 2 is ordinary, id 3 is banned, id 4 does not exist at all. 3 and 4 are the
// pair the probe tests compare: their answers must be indistinguishable.
const OK_ID = 2;
const BANNED_ID = 3;
const MISSING_ID = 4;

let friendships;   // [{ id, requester_id, addressee_id, status }]
let nextRowId;
let statements;    // every non-auth statement text

const AUTH_SQL = /^SELECT id, email, name, role,.*FROM users WHERE id = \$1$/i;

function directoryRow(id) {
  if (Number(id) === ME.id) return { id: ME.id, name: ME.name, is_banned: false };
  if (Number(id) === OK_ID) return { id: OK_ID, name: 'Bo', is_banned: false };
  if (Number(id) === BANNED_ID) return { id: BANNED_ID, name: 'Cal', is_banned: true };
  return null;
}

function dispatch(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (AUTH_SQL.test(sql)) return Promise.resolve({ rows: [ME], rowCount: 1 });
  statements.push(sql);

  if (/^SELECT id, name, is_banned FROM users WHERE id = \$1$/i.test(sql)) {
    const row = directoryRow(params[0]);
    return Promise.resolve({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
  }
  if (/FROM user_blocks/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });

  if (/SELECT id, status, requester_id FROM friendships/i.test(sql)
    || /SELECT status FROM friendships/i.test(sql)) {
    const [a, b] = [Number(params[0]), Number(params[1])];
    const rows = friendships
      .filter((r) => (r.requester_id === a && r.addressee_id === b)
        || (r.requester_id === b && r.addressee_id === a))
      .sort((x, y) => (x.status === 'accepted' ? 0 : 1) - (y.status === 'accepted' ? 0 : 1) || x.id - y.id);
    return Promise.resolve({ rows: rows.slice(0, 1), rowCount: Math.min(rows.length, 1) });
  }

  // POST /accept. The ban gate is the EXISTS in the statement itself, so the
  // fixture has to honour it or the test proves nothing.
  if (/^UPDATE friendships SET status = 'accepted' WHERE requester_id/i.test(sql)) {
    const requester = Number(params[0]);
    const addressee = Number(params[1]);
    const gated = /EXISTS \(SELECT 1 FROM users u WHERE u\.id = \$1/i.test(sql);
    const requesterRow = directoryRow(requester);
    const banned = !requesterRow || requesterRow.is_banned;
    const row = friendships.find((r) =>
      r.requester_id === requester && r.addressee_id === addressee && r.status === 'pending');
    if (!row || (gated && banned)) return Promise.resolve({ rows: [], rowCount: 0 });
    row.status = 'accepted';
    return Promise.resolve({ rows: [row], rowCount: 1 });
  }

  if (/^INSERT INTO friendships/i.test(sql)) {
    const [a, b] = [Number(params[0]), Number(params[1])];
    if (friendships.some((r) => r.requester_id === a && r.addressee_id === b)) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    const row = { id: nextRowId++, requester_id: a, addressee_id: b, status: 'pending' };
    friendships.push(row);
    return Promise.resolve({ rows: [{ id: row.id }], rowCount: 1 });
  }

  if (/^DELETE FROM friendships/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });

  return Promise.resolve({ rows: [], rowCount: 0 });
}
pool.query = (text, params) => dispatch(text, params);
pool.connect = async () => ({ query: (t, p) => dispatch(t, p), release: () => {} });

const friendsRouter = require('../routes/friends');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/friends', friendsRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((r) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise((r) => server.close(() => r())));

test.beforeEach(() => {
  friendships = [];
  statements = [];
  nextRowId = 500;
  friendsRouter.__resetBudgets();
});

async function call(method, pathname, payload) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signUserToken(ME)}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, body };
}

const codeFor = (id) => 'FLOCK-' + id.toString(36).toUpperCase().padStart(4, '0');

// ---------------------------------------------------------------------------
// 1. The probes: a banned account answers exactly like one that never existed
// ---------------------------------------------------------------------------

test('a friend request at a banned account is refused, and no row is written', async () => {
  const res = await call('POST', '/api/friends/request', { user_id: BANNED_ID });
  assert.strictEqual(res.status, 404, res.text);
  assert.strictEqual(friendships.length, 0,
    'a pending row was minted against an account that can never sign in to accept it');
});

test('the banned answer is byte-identical to the answer for an id nobody holds', async () => {
  // The whole point of folding it into the existing miss. Anything that
  // separates these two turns the ban into an oracle: it says "this id is a
  // real person" and reports a moderation decision about them to a stranger.
  const banned = await call('POST', '/api/friends/request', { user_id: BANNED_ID });
  const missing = await call('POST', '/api/friends/request', { user_id: MISSING_ID });
  assert.strictEqual(banned.status, missing.status);
  assert.strictEqual(banned.text, missing.text);
});

test('a banned target costs a probe, so it is not a free lane through the budget', async () => {
  // friendProbeBudget is 20/hour. If a banned target were refused BEFORE the
  // charge, an enumerator would get unlimited attempts at every banned id, and
  // "the free answers are the banned ones" is an enumeration signal of its own.
  const limits = friendsRouter.__budgetLimits().friendProbe;
  for (let i = 0; i < limits.hourly; i++) {
    await call('POST', '/api/friends/request', { user_id: BANNED_ID });
  }
  // The budget is now spent, so a request at a REAL stranger misses too.
  const spent = await call('POST', '/api/friends/request', { user_id: OK_ID });
  assert.strictEqual(spent.status, 404, spent.text);
  assert.strictEqual(friendships.length, 0);
});

test('a friend code pointing at a banned account is "no user found with this code"', async () => {
  const banned = await call('POST', '/api/friends/add-by-code', { code: codeFor(BANNED_ID) });
  const missing = await call('POST', '/api/friends/add-by-code', { code: codeFor(MISSING_ID) });
  assert.strictEqual(banned.status, 404, banned.text);
  assert.strictEqual(banned.text, missing.text,
    'a friend code separates a banned account from an unused one');
  assert.strictEqual(friendships.length, 0);
});

test('an ordinary account is still reachable through both doors', async () => {
  // The control. A ban filter that also refuses everybody is not a fix.
  const req = await call('POST', '/api/friends/request', { user_id: OK_ID });
  assert.strictEqual(req.status, 200, req.text);
  assert.strictEqual(req.body.status, 'pending');
  assert.strictEqual(friendships.length, 1);

  friendships = [];
  const byCode = await call('POST', '/api/friends/add-by-code', { code: codeFor(OK_ID) });
  assert.strictEqual(byCode.status, 200, byCode.text);
  assert.strictEqual(friendships.length, 1);
});

// ---------------------------------------------------------------------------
// 2. Accept: a request that predates the ban must not become a friendship
// ---------------------------------------------------------------------------

test('accepting a request from an account banned since it was sent is refused', async () => {
  friendships.push({ id: 500, requester_id: BANNED_ID, addressee_id: ME.id, status: 'pending' });

  const res = await call('POST', '/api/friends/accept', { user_id: BANNED_ID });
  assert.strictEqual(res.status, 404, res.text);
  assert.strictEqual(res.body.error, 'No pending request from this user',
    'the refusal is not the same sentence a missing request already gets');
  assert.strictEqual(friendships[0].status, 'pending',
    'the friendship was accepted across a ban');
});

test('the pending row is left alone, because a ban can be lifted', async () => {
  // Unlike the BLOCK path one branch above, which deletes: a block is the
  // user's own permanent decision, a ban is moderation's and it expires. GET
  // /pending already stops listing this row, so it is invisible rather than
  // lingering, and it comes back intact if the account is restored. Deleting
  // would destroy a real request over a reversible decision.
  friendships.push({ id: 500, requester_id: BANNED_ID, addressee_id: ME.id, status: 'pending' });
  await call('POST', '/api/friends/accept', { user_id: BANNED_ID });
  assert.strictEqual(friendships.length, 1, 'the request was deleted rather than withheld');
});

test('an ordinary pending request still accepts', async () => {
  friendships.push({ id: 501, requester_id: OK_ID, addressee_id: ME.id, status: 'pending' });
  const res = await call('POST', '/api/friends/accept', { user_id: OK_ID });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(friendships[0].status, 'accepted');
});

// ---------------------------------------------------------------------------
// 3. The lists: the predicate is in the statement, or it is nowhere
// ---------------------------------------------------------------------------

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'friends.js'), 'utf8');

// Every list statement in friends.js that JOINs a counterparty, and the anchor
// that identifies it. Each must carry the ban predicate NOT_BANNED_SQL builds.
const LISTS = [
  ["GET /api/friends, the friends list", "AND f.status = 'accepted'"],
  ['GET /api/friends/pending, incoming requests', 'WHERE f.addressee_id = $1'],
  ['GET /api/friends/outgoing, sent requests', 'WHERE f.requester_id = $1'],
  ['GET /api/friends/suggestions, mutual friends', 'AND u.id != $1'],
  ['GET /api/friends/suggestions, the shared-flock fallback', 'WHERE fm1.user_id = $1'],
];

test('every list that hands over a counterparty filters banned accounts', () => {
  for (const [what, anchor] of LISTS) {
    const at = SOURCE.indexOf(anchor);
    assert.notStrictEqual(at, -1, `${what}: the anchor "${anchor}" is gone. Retarget this test`);
    // The predicate sits on the line after the anchor in every one of these
    // statements, so a small window is enough and keeps the assertion specific.
    const window = SOURCE.slice(at, at + 260);
    assert.ok(window.includes('${NOT_BANNED_SQL}'),
      `${what} does not filter banned accounts. A ban has to reach every surface that hands one person to another.`);
  }
});

test('NOT_BANNED_SQL is the one definition, and it reads the column it claims to', () => {
  assert.match(SOURCE, /const NOT_BANNED_SQL = 'COALESCE\(u\.is_banned, FALSE\) = FALSE'/,
    'the ban predicate was rewritten or copied; there must be exactly one of it');
});

// ---------------------------------------------------------------------------
// 4. routes/users.js is the same door, and it was the one actually wired up
// ---------------------------------------------------------------------------
// The search audit closed friends.js and left this open, which is the half that
// matters more: GET /api/users/search is the endpoint the Add Friends screen,
// the Connect panel, the new-DM sheet and the Create Flock invite picker all
// call. friends.js filtering banned rows while the route every people-search
// box in the product uses did not is the ban reaching the quieter surface and
// missing the loud one.
//
// Asserted against the source for the reason stated above: a fixture that
// returns rows regardless of the WHERE clause cannot prove the WHERE clause is
// there, and a test that survives deleting the predicate pins nothing.
const USERS_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'users.js'), 'utf8');

const USER_LISTS = [
  ['GET /api/users/search, every people-search box in the app', 'WHERE name ILIKE $1 AND id != $2', 'COALESCE(is_banned, FALSE) = FALSE'],
  ['GET /api/users/suggested, the people-you-may-know row', "WHERE fm1.user_id = $1 AND fm1.status = 'accepted'", 'COALESCE(u.is_banned, FALSE) = FALSE'],
];

test('the user search routes filter banned accounts too', () => {
  for (const [what, anchor, predicate] of USER_LISTS) {
    const at = USERS_SOURCE.indexOf(anchor);
    assert.notStrictEqual(at, -1, `${what}: the anchor "${anchor}" is gone. Retarget this test`);
    const window = USERS_SOURCE.slice(at, at + 260);
    assert.ok(window.includes(predicate),
      `${what} does not filter banned accounts. A removed account was still being offered by name, with a face, to anyone searching.`);
  }
});
