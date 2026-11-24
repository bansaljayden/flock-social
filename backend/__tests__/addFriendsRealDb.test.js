// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// ADD FRIENDS, THE SERVER HALF, ON A REAL DATABASE (rebuild of 2026-11-23).
// ---------------------------------------------------------------------------
// Walked through the real friends router on an embedded Postgres, so every
// statement, CHECK and join below is the one production runs:
//
//   1. GET /my-code hands out the code's link, minted on the host the plan
//      invite links use, and the QR's text, which stays the JSON every build
//      reads until FRIEND_QR_LINK is on. Every shape a code is handed over in
//      adds the person it belongs to.
//   2. GET /by-code/:code shows who a code belongs to and sends nothing. It
//      answers from the caller's side, hides a decline from the person
//      declined as every other read does, caps the photo, and gives one
//      identical 404 for a code nobody holds, a ban, a block and a spent
//      budget.
//   3. A look is charged like add-by-code and free beside an existing row, and
//      a charged look that showed somebody leaves one pass, so the request
//      that follows is not charged again. A miss leaves none.
//   4. DELETE /request/:userId takes back only the caller's own unanswered
//      request. A friendship accepted while the phone was asleep survives it
//      with a 409, and a declined request answers exactly like a pending one.
//   5. Asking someone whose request you declined accepts their request, and
//      /accept takes a request you declined (the Undo), but never your own
//      request, a withdrawn one, a banned account's or a blocked one's.
//   6. find-by-phone says when a spent allowance lifts and marks a request the
//      caller received as 'incoming'; it and Quick Add cap the photos.
//   7. friend_request_received carries the sender's capped photo.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');
const { removeTempDir } = require('./helpers/removeTempDir');

const PG_PORT = pickEmbeddedPgPort('addFriendsRealDb');
const DB_NAME = 'flock_add_friends_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-add-friends-real-db';
delete process.env.CONTACT_DISCOVERY_SECRET; // the JWT secret keys the digest
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.RESEND_API_KEY;
delete process.env.PUBLIC_WEB_URL;

// A photo under the list ceiling, and one over it (utils/ownAvatar.js and every
// list read cap at 12,000 characters).
const SMALL_PHOTO = `data:image/png;base64,${'Q'.repeat(200)}`;
const LARGE_PHOTO = `data:image/png;base64,${'Q'.repeat(13000)}`;

let pg;
let pool;
let dataDir;
let server;
let base;
let signUserToken;
let friendsRouter;
let phoneDiscoveryHash;

// What left over the socket, what was pushed, and (while a test counts them)
// every statement a route sent after the session lookup.
const emitted = [];
const pushes = [];
const recorder = { on: false, sql: [] };

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-add-friends-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'addFriendsRealDb', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  const realQuery = pool.query.bind(pool);
  pool.query = (text, params) => {
    if (recorder.on) {
      const sql = typeof text === 'string' ? text : (text && text.text) || '';
      if (!/token_version FROM users WHERE id = \$1/.test(sql)) recorder.sql.push(sql.replace(/\s+/g, ' ').trim());
    }
    return realQuery(text, params);
  };

  // routes/friends.js takes pushIfOffline when it loads, so it is replaced
  // first. Nothing here has a device; what matters is who would be told.
  const pushHelper = require('../services/pushHelper');
  pushHelper.pushIfOffline = async (_io, userId, title, body, data) => {
    pushes.push({ userId: Number(userId), title, body, data });
    return { skipped: true };
  };

  ({ signUserToken } = require('../middleware/auth'));
  ({ phoneDiscoveryHash } = require('../utils/phone'));
  friendsRouter = require('../routes/friends');
  const app = express();
  app.use(express.json());
  app.set('io', {
    sockets: { adapter: { rooms: new Map() } },
    to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }),
  });
  app.use('/api/friends', friendsRouter);
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  removeTempDir(dataDir, 'addFriendsRealDb');
});

test.beforeEach(() => {
  friendsRouter.__resetBudgets();
  emitted.length = 0;
  pushes.length = 0;
  recorder.on = false;
  recorder.sql = [];
});

// ── helpers ─────────────────────────────────────────────────────────────────
let seq = 0;
async function user(name, { photo = null, banned = false, verified = true } = {}) {
  seq += 1;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified, profile_image_url)
     VALUES ($1, 'x', $2, $4, $3) RETURNING *`,
    [`af${seq}.${Date.now()}@example.com`, name, photo, verified]
  );
  if (banned) await pool.query('UPDATE users SET is_banned = TRUE WHERE id = $1', [u.id]);
  return { ...u, token: signUserToken(u) };
}

// Issued the way the server issues one, and stored, without asking as the
// account (a banned one cannot ask).
async function codeOf(who) {
  const { newFriendCode } = friendsRouter.__test;
  const { rows: [r] } = await pool.query(
    'UPDATE users SET friend_code = COALESCE(friend_code, $2) WHERE id = $1 RETURNING friend_code',
    [who.id, newFriendCode()]
  );
  return r.friend_code;
}

async function row(requester, addressee, status, { daysAgo = 0 } = {}) {
  await pool.query(
    `INSERT INTO friendships (requester_id, addressee_id, status, created_at)
     VALUES ($1, $2, $3, NOW() - make_interval(days => $4::int))`,
    [requester.id, addressee.id, status, daysAgo]
  );
}

const pairRows = async (a, b) => (await pool.query(
  `SELECT requester_id, addressee_id, status FROM friendships
    WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)
    ORDER BY id`,
  [a.id, b.id]
)).rows;

async function call(method, p, who, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

const preview = (who, code) => call('GET', `/api/friends/by-code/${encodeURIComponent(code)}`, who);

// Spend `n` of the caller's friend probes on ids nobody holds, the way a
// directory walk would.
async function spendProbes(who, n) {
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call('POST', '/api/friends/request', who, { user_id: 2000000000 + i });
    assert.strictEqual(res.status, 404, `probe ${i}: ${res.text}`);
  }
}

// Statements one call sends, the session lookup aside.
async function counted(fn) {
  recorder.sql = [];
  recorder.on = true;
  try {
    const out = await fn();
    return { out, statements: recorder.sql.slice() };
  } finally {
    recorder.on = false;
  }
}

async function withClock(offsetMs, fn) {
  const realNow = Date.now;
  Date.now = () => realNow() + offsetMs;
  try { return await fn(); } finally { Date.now = realNow; }
}

// ===========================================================================
// 1. The code's link
// ===========================================================================

test('GET /my-code hands out the code with its link, on the host the plan invite links use', async () => {
  const ada = await user('Ada');
  const saved = process.env.PUBLIC_WEB_URL;
  try {
    process.env.PUBLIC_WEB_URL = 'http://127.0.0.1:3519';
    const local = await call('GET', '/api/friends/my-code', ada);
    assert.strictEqual(local.status, 200, local.text);
    assert.match(local.body.code, /^FLOCK-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    assert.strictEqual(local.body.url, `http://127.0.0.1:3519/add/${local.body.code}`,
      'outside production a local origin is honoured, as it is for the invite links');
    const { inviteBase } = require('../utils/inviteBase');
    assert.strictEqual(local.body.url, `${inviteBase()}/add/${local.body.code}`);

    delete process.env.PUBLIC_WEB_URL;
    const canonical = await call('GET', '/api/friends/my-code', ada);
    assert.strictEqual(canonical.body.code, local.body.code, 'the code changed between two asks');
    assert.strictEqual(canonical.body.url, `https://www.flockcorp.com/add/${local.body.code}`);
  } finally {
    if (saved === undefined) delete process.env.PUBLIC_WEB_URL; else process.env.PUBLIC_WEB_URL = saved;
  }

  // One helper for both links: the invite route no longer keeps its own.
  const flocks = fs.readFileSync(path.join(__dirname, '..', 'routes', 'flocks.js'), 'utf8');
  assert.match(flocks, /const \{ inviteBase \} = require\('\.\.\/utils\/inviteBase'\);/);
  assert.doesNotMatch(flocks, /function inviteBase\(/);
});

test('GET /my-code says what the QR carries: the JSON every build reads, and the link only once FRIEND_QR_LINK is on', async () => {
  // The scanner in the builds already on phones (1.0.3 and older) reads a
  // scan with JSON.parse and nothing else, so a link drawn into the QR cannot
  // be read by a friend who has not updated. The switch waits for the build
  // that reads links to be the one in the App Store.
  const ada = await user('Ada');
  const { readFriendCode } = friendsRouter.__test;
  const saved = process.env.FRIEND_QR_LINK;
  try {
    delete process.env.FRIEND_QR_LINK;
    const before = (await call('GET', '/api/friends/my-code', ada)).body;
    assert.deepStrictEqual(JSON.parse(before.qr), { type: 'flock_friend', code: before.code });
    assert.strictEqual(readFriendCode(before.qr), before.code);
    // The link still comes with it, for the share sheet.
    assert.strictEqual(before.url, `https://www.flockcorp.com/add/${before.code}`);
    // Only "true" turns it on, as with every other switch in .env.example.
    process.env.FRIEND_QR_LINK = '1';
    assert.strictEqual((await call('GET', '/api/friends/my-code', ada)).body.qr, before.qr);

    process.env.FRIEND_QR_LINK = 'true';
    const after = (await call('GET', '/api/friends/my-code', ada)).body;
    assert.strictEqual(after.code, before.code);
    assert.strictEqual(after.qr, after.url);
    assert.strictEqual(readFriendCode(after.qr), before.code);
  } finally {
    if (saved === undefined) delete process.env.FRIEND_QR_LINK; else process.env.FRIEND_QR_LINK = saved;
  }
});

test('the link GET /my-code hands out adds the person it belongs to, on this deployment too', async () => {
  const ada = await user('Ada');
  const saved = process.env.PUBLIC_WEB_URL;
  try {
    process.env.PUBLIC_WEB_URL = 'http://127.0.0.1:3519';
    const { url } = (await call('GET', '/api/friends/my-code', ada)).body;
    const bo = await user('Bo');
    const res = await call('POST', '/api/friends/add-by-code', bo, { code: url });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.user.id, ada.id);
    assert.strictEqual(res.body.status, 'pending');
  } finally {
    if (saved === undefined) delete process.env.PUBLIC_WEB_URL; else process.env.PUBLIC_WEB_URL = saved;
  }
});

test('a code reads in every shape it is handed over in, at both code doors', async () => {
  const ada = await user('Ada');
  const code = await codeOf(ada);
  const body = code.slice('FLOCK-'.length);
  const shapes = [
    body.toLowerCase(),
    `FLOCK- ${body}`,
    `${code}.`,
    `Add me on Flock, my code is ${code}. https://apps.apple.com/app/id6781442127`,
    `https://www.flockcorp.com/add/${code}`,
    JSON.stringify({ type: 'flock_friend', code }),
  ];
  for (const shape of shapes) {
    // eslint-disable-next-line no-await-in-loop
    const bo = await user('Bo');
    // eslint-disable-next-line no-await-in-loop
    const res = await call('POST', '/api/friends/add-by-code', bo, { code: shape });
    assert.strictEqual(res.status, 200, `${shape}: ${res.text}`);
    assert.strictEqual(res.body.user.id, ada.id, shape);
    assert.strictEqual(res.body.status, 'pending', shape);
  }

  const cy = await user('Cy');
  for (const shape of [body.toLowerCase(), `https://www.flockcorp.com/add/${code}`]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await preview(cy, shape);
    assert.strictEqual(res.status, 200, `${shape}: ${res.text}`);
    assert.strictEqual(res.body.user.id, ada.id, shape);
  }

  // Not a code, and somebody else's link with a real code in it: refused at
  // both doors, the same way, before any lookup.
  for (const junk of ['Add me on Flock', `https://evil.example/add/${code}`, body.slice(0, 7)]) {
    // eslint-disable-next-line no-await-in-loop
    const { out, statements } = await counted(async () => [
      await call('POST', '/api/friends/add-by-code', cy, { code: junk }),
      await preview(cy, junk),
    ]);
    for (const r of out) {
      assert.strictEqual(r.status, 400, `${junk}: ${r.text}`);
      assert.deepStrictEqual(r.body, { error: "That isn't a Flock code." });
    }
    assert.deepStrictEqual(statements.filter((s) => /friend_code/.test(s)), [], `${junk} reached the lookup`);
  }

  const own = await call('POST', '/api/friends/add-by-code', ada, { code: `https://www.flockcorp.com/add/${code}` });
  assert.deepStrictEqual([own.status, own.body], [400, { error: "That's your own code." }]);
});

// ===========================================================================
// 2. GET /by-code/:code
// ===========================================================================

test('a look at a code answers from the caller\'s side, and sends nothing', async () => {
  const me = await user('Me', { photo: SMALL_PHOTO });
  const people = {
    stranger: await user('Stranger', { photo: SMALL_PHOTO }),
    asked: await user('Asked'),
    declinedMine: await user('DeclinedMine'),
    askedMe: await user('AskedMe'),
    iDeclined: await user('IDeclined'),
    withdrewMine: await user('WithdrewMine'),
    theyWithdrew: await user('TheyWithdrew'),
    friend: await user('Friend'),
  };
  await row(me, people.asked, 'pending');
  await row(me, people.declinedMine, 'declined');     // they said no; to me it is still Sent
  await row(people.askedMe, me, 'pending');
  await row(people.iDeclined, me, 'declined');         // I said no; a yes still lands
  await row(me, people.withdrewMine, 'withdrawn');
  await row(people.theyWithdrew, me, 'withdrawn');
  await row(people.friend, me, 'accepted');

  const expected = {
    stranger: 'none',
    asked: 'outgoing',
    declinedMine: 'outgoing',
    askedMe: 'incoming',
    iDeclined: 'incoming',
    withdrewMine: 'none',
    theyWithdrew: 'none',
    friend: 'accepted',
  };

  const before = (await pool.query('SELECT id, requester_id, addressee_id, status FROM friendships ORDER BY id')).rows;
  for (const [key, status] of Object.entries(expected)) {
    const who = people[key];
    // eslint-disable-next-line no-await-in-loop
    const res = await preview(me, await codeOf(who));
    assert.strictEqual(res.status, 200, `${key}: ${res.text}`);
    assert.strictEqual(res.body.status, status, key);
    assert.deepStrictEqual(Object.keys(res.body.user).sort(), ['id', 'name', 'profile_image_url'], key);
    assert.strictEqual(res.body.user.id, who.id, key);
    assert.strictEqual(res.body.user.name, who.name, key);
  }
  assert.strictEqual((await preview(me, await codeOf(people.stranger))).body.user.profile_image_url, SMALL_PHOTO);

  const self = await preview(me, await codeOf(me));
  assert.strictEqual(self.status, 200, self.text);
  assert.deepStrictEqual(self.body, { user: { id: me.id, name: me.name, profile_image_url: SMALL_PHOTO }, status: 'self' });

  // Nothing was written, nobody was told.
  const after = (await pool.query('SELECT id, requester_id, addressee_id, status FROM friendships ORDER BY id')).rows;
  assert.deepStrictEqual(after, before, 'a look changed a relationship');
  assert.deepStrictEqual(emitted, [], 'a look rang somebody');
  assert.deepStrictEqual(pushes, [], 'a look pushed to somebody');
});

test('an unconfirmed account sees whose link it opened, and is asked to confirm at the add', async () => {
  // Read and be reached, but do not accumulate (middleware/auth.js): the look
  // is a read, so a brand-new account sees who sent the link, and the add is
  // where the confirmation is asked for, as it always was.
  const ada = await user('Ada');
  const fresh = await user('Fresh', { verified: false });
  const look = await preview(fresh, await codeOf(ada));
  assert.strictEqual(look.status, 200, look.text);
  assert.strictEqual(look.body.status, 'none');
  const add = await call('POST', '/api/friends/add-by-code', fresh, { code: await codeOf(ada) });
  assert.strictEqual(add.status, 403, add.text);
  assert.strictEqual(add.body.emailVerificationRequired, true);
  assert.deepStrictEqual(await pairRows(ada, fresh), []);
});

test('a look caps the photo the way every list does', async () => {
  const me = await user('Me');
  const big = await user('Big', { photo: LARGE_PHOTO });
  const res = await preview(me, await codeOf(big));
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.user.profile_image_url, null);
});

test('a code nobody holds, a ban, a block and a spent budget are one 404', async () => {
  const me = await user('Me');
  const banned = await user('Banned', { banned: true });
  const blocker = await user('Blocker');
  const blockedByMe = await user('BlockedByMe');
  const stranger = await user('Stranger');
  await pool.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2), ($3, $4)',
    [blocker.id, me.id, me.id, blockedByMe.id]);

  const answers = {};
  const work = {};
  answers.nobody = await counted(() => preview(me, 'FLOCK-ZZZZZZZZ'));
  friendsRouter.__resetBudgets();
  answers.banned = await counted(async () => preview(me, await codeOf(banned)));
  friendsRouter.__resetBudgets();
  answers.blockedMe = await counted(async () => preview(me, await codeOf(blocker)));
  friendsRouter.__resetBudgets();
  answers.iBlocked = await counted(async () => preview(me, await codeOf(blockedByMe)));
  friendsRouter.__resetBudgets();
  const strangerCode = await codeOf(stranger);
  await spendProbes(me, friendsRouter.__budgetLimits().friendProbe.hourly);
  answers.spent = await counted(() => preview(me, strangerCode));

  for (const [why, { out }] of Object.entries(answers)) {
    assert.strictEqual(out.status, 404, `${why}: ${out.text}`);
    assert.strictEqual(out.text, answers.nobody.out.text, `${why} answers differently from a code nobody holds`);
    work[why] = answers[why].statements.filter((s) => !/^UPDATE users SET friend_code/.test(s)).length;
  }
  assert.deepStrictEqual(JSON.parse(answers.nobody.out.text), { error: 'No user found with this code' });
  // The same 404 add-by-code gives, so the two doors cannot be compared either.
  friendsRouter.__resetBudgets();
  const byPost = await call('POST', '/api/friends/add-by-code', me, { code: 'FLOCK-ZZZZZZZZ' });
  assert.strictEqual(byPost.text, answers.nobody.out.text);

  // And the same work for the three that are not a block, which is asked
  // last and only of an account that is there.
  assert.strictEqual(work.banned, work.nobody, `a banned code ran ${work.banned} statements, nobody's ${work.nobody}`);
  assert.strictEqual(work.spent, work.nobody, `a spent budget ran ${work.spent} statements, nobody's ${work.nobody}`);
});

// ===========================================================================
// 3. What a look costs, and the pass it leaves
// ===========================================================================

test('a look is charged like add-by-code, and free beside a row the pair already has', async () => {
  const me = await user('Me');
  const friend = await user('Friend');
  const s1 = await user('S1');
  const s2 = await user('S2');
  await row(friend, me, 'accepted');
  const hourly = friendsRouter.__budgetLimits().friendProbe.hourly;

  await spendProbes(me, hourly - 1);
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    assert.strictEqual((await preview(me, await codeOf(friend))).status, 200, 'a look at a friend cost a probe');
  }
  assert.strictEqual((await preview(me, await codeOf(s1))).status, 200, 'the last probe of the hour was not there');
  assert.strictEqual((await preview(me, await codeOf(s2))).status, 404, 'a look past the budget was answered');
  // A free look leaves no pass; only the charged one did.
  assert.strictEqual(friendsRouter.__test.previewPassCount(), 1);
});

test('the request that follows a charged look rides on its pass, through either door, once', async () => {
  const hourly = friendsRouter.__budgetLimits().friendProbe.hourly;

  // add-by-code
  const me = await user('Me');
  const target = await user('Target');
  const other = await user('Other');
  await spendProbes(me, hourly - 1);
  assert.strictEqual((await preview(me, await codeOf(target))).status, 200);
  const added = await call('POST', '/api/friends/add-by-code', me, { code: await codeOf(target) });
  assert.strictEqual(added.status, 200, `the add after the look was charged again: ${added.text}`);
  assert.strictEqual(added.body.status, 'pending');
  // The budget really is spent: anybody else is a miss.
  const elsewhere = await call('POST', '/api/friends/add-by-code', me, { code: await codeOf(other) });
  assert.strictEqual(elsewhere.status, 404, elsewhere.text);

  // POST /request, by the id the look showed.
  friendsRouter.__resetBudgets();
  const me2 = await user('Me2');
  const target2 = await user('Target2');
  await spendProbes(me2, hourly - 1);
  const look = await preview(me2, await codeOf(target2));
  assert.strictEqual(look.status, 200);
  const asked = await call('POST', '/api/friends/request', me2, { user_id: look.body.user.id });
  assert.strictEqual(asked.status, 200, `the request after the look was charged again: ${asked.text}`);
  assert.strictEqual(asked.body.status, 'pending');

  // Once: taken back and asked again, the pass is gone and so is the budget.
  const cancelled = await call('DELETE', `/api/friends/request/${target2.id}`, me2);
  assert.strictEqual(cancelled.status, 200, cancelled.text);
  const again = await call('POST', '/api/friends/request', me2, { user_id: target2.id });
  assert.strictEqual(again.status, 404, `a pass was spent twice: ${again.text}`);
});

test('a pass runs out after ten minutes', async () => {
  const hourly = friendsRouter.__budgetLimits().friendProbe.hourly;
  const me = await user('Me');
  const target = await user('Target');
  await spendProbes(me, hourly - 1);
  assert.strictEqual((await preview(me, await codeOf(target))).status, 200);
  const late = await withClock(friendsRouter.__test.PREVIEW_PASS_MS + 60 * 1000,
    async () => call('POST', '/api/friends/add-by-code', me, { code: await codeOf(target) }));
  assert.strictEqual(late.status, 404, `a pass outlived its ten minutes: ${late.text}`);
});

test('a miss leaves no pass behind, so the four 404s cost the same afterwards too', async () => {
  const me = await user('Me');
  const banned = await user('Banned', { banned: true });
  const blocker = await user('Blocker');
  await pool.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)', [blocker.id, me.id]);

  assert.strictEqual((await preview(me, 'FLOCK-ZZZZZZZZ')).status, 404);
  assert.strictEqual((await preview(me, await codeOf(banned))).status, 404);
  assert.strictEqual((await preview(me, await codeOf(blocker))).status, 404);
  assert.strictEqual(friendsRouter.__test.previewPassCount(), 0, 'a miss wrote a pass');
});

// ===========================================================================
// 4. DELETE /request/:userId
// ===========================================================================

test('cancel takes back a pending request, and a declined one answers exactly the same', async () => {
  const me = await user('Me');
  const waiting = await user('Waiting');
  const saidNo = await user('SaidNo');
  await row(me, waiting, 'pending');
  await row(me, saidNo, 'declined');

  const first = {};
  first.pending = await counted(() => call('DELETE', `/api/friends/request/${waiting.id}`, me));
  first.declined = await counted(() => call('DELETE', `/api/friends/request/${saidNo.id}`, me));
  for (const [why, { out }] of Object.entries(first)) {
    assert.strictEqual(out.status, 200, `${why}: ${out.text}`);
    assert.deepStrictEqual(out.body, { status: 'none' }, why);
  }
  assert.strictEqual(first.declined.statements.length, first.pending.statements.length,
    'a declined request costs a different amount of work to cancel, which is the decline showing');

  assert.deepStrictEqual(await pairRows(me, waiting), []);
  assert.deepStrictEqual((await pairRows(me, saidNo)).map((r) => r.status), ['withdrawn'],
    'the decline record (and its cooldown) went with the cancel');
  const sent = await call('GET', '/api/friends/outgoing', me);
  assert.deepStrictEqual(sent.body.requests, [], 'a cancelled request is still on Sent requests');

  const second = [
    await call('DELETE', `/api/friends/request/${waiting.id}`, me),
    await call('DELETE', `/api/friends/request/${saidNo.id}`, me),
  ];
  assert.deepStrictEqual(second.map((r) => r.status), [404, 404]);
  assert.strictEqual(second[0].text, second[1].text);
  assert.deepStrictEqual(second[0].body, { error: 'There is no request to cancel.' });
});

test('cancel on a request accepted while the phone was asleep keeps the friendship', async () => {
  const me = await user('Me');
  const them = await user('Them');
  await row(me, them, 'pending');
  // They accept. This phone heard nothing and still shows Pending.
  const accepted = await call('POST', '/api/friends/accept', them, { user_id: me.id });
  assert.strictEqual(accepted.status, 200, accepted.text);

  const res = await call('DELETE', `/api/friends/request/${them.id}`, me);
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(res.body.status, 'accepted');
  assert.deepStrictEqual((await pairRows(me, them)).map((r) => r.status), ['accepted']);
  const friends = await call('GET', '/api/friends', me);
  assert.deepStrictEqual(friends.body.friends.map((f) => f.id), [them.id]);
});

test('cancel touches nothing that is not the caller\'s own request', async () => {
  const me = await user('Me');
  const askedMe = await user('AskedMe');
  const nobody = await user('Nobody');
  const bannedFriend = await user('BannedFriend');
  await row(askedMe, me, 'pending');
  await row(bannedFriend, me, 'accepted');
  await pool.query('UPDATE users SET is_banned = TRUE WHERE id = $1', [bannedFriend.id]);

  const theirs = await call('DELETE', `/api/friends/request/${askedMe.id}`, me);
  assert.strictEqual(theirs.status, 404, theirs.text);
  assert.deepStrictEqual((await pairRows(me, askedMe)).map((r) => r.status), ['pending'], 'their request to me was cancelled');

  assert.strictEqual((await call('DELETE', `/api/friends/request/${nobody.id}`, me)).status, 404);
  // A banned counterpart reads as no friendship, as on GET /status.
  const banned = await call('DELETE', `/api/friends/request/${bannedFriend.id}`, me);
  assert.strictEqual(banned.status, 404, banned.text);
  assert.deepStrictEqual((await pairRows(me, bannedFriend)).map((r) => r.status), ['accepted']);

  for (const bad of ['abc', '0', '-4', '2147483648']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await call('DELETE', `/api/friends/request/${bad}`, me);
    assert.deepStrictEqual([res.status, res.body], [400, { error: 'Invalid user ID' }], bad);
  }
});

test('DELETE /:userId still ends a friendship; only Sent requests moved to the cancel route', async () => {
  const me = await user('Me');
  const friend = await user('Friend');
  await row(friend, me, 'accepted');
  const res = await call('DELETE', `/api/friends/${friend.id}`, me);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(await pairRows(me, friend), []);
});

// ===========================================================================
// 5. A yes to a request you declined
// ===========================================================================

test('asking someone whose request you declined accepts their request, through both doors, free', async () => {
  for (const door of ['request', 'add-by-code']) {
    // eslint-disable-next-line no-await-in-loop
    const ada = await user('Ada');
    // eslint-disable-next-line no-await-in-loop
    const bo = await user('Bo');
    // eslint-disable-next-line no-await-in-loop
    await row(ada, bo, 'pending');
    // eslint-disable-next-line no-await-in-loop
    assert.strictEqual((await call('POST', '/api/friends/decline', bo, { user_id: ada.id })).status, 200);
    // eslint-disable-next-line no-await-in-loop
    await spendProbes(bo, friendsRouter.__budgetLimits().friendProbe.hourly);
    emitted.length = 0;
    pushes.length = 0;

    const res = door === 'request'
      // eslint-disable-next-line no-await-in-loop
      ? await call('POST', '/api/friends/request', bo, { user_id: ada.id })
      // eslint-disable-next-line no-await-in-loop
      : await call('POST', '/api/friends/add-by-code', bo, { code: await codeOf(ada) });
    assert.strictEqual(res.status, 200, `${door}: ${res.text}`);
    assert.strictEqual(res.body.status, 'accepted', door);
    assert.strictEqual(res.body.message, 'You and Ada are now friends.', door);
    // eslint-disable-next-line no-await-in-loop
    assert.deepStrictEqual((await pairRows(ada, bo)).map((r) => [r.requester_id, r.status]), [[ada.id, 'accepted']], door);
    // Ada hears a yes, the way an accept always told her.
    assert.ok(emitted.some((e) => e.room === `user:${ada.id}` && e.event === 'friend_request_responded' && e.payload.action === 'accepted'), door);
    assert.ok(pushes.some((p) => p.userId === ada.id && p.data.type === 'friend_accepted'), door);
    friendsRouter.__resetBudgets();
  }
});

test('/accept takes a request the caller declined (the Undo), and nothing else it should not', async () => {
  const ada = await user('Ada');
  const cy = await user('Cy');
  await row(ada, cy, 'pending');
  await call('POST', '/api/friends/decline', cy, { user_id: ada.id });
  const undo = await call('POST', '/api/friends/accept', cy, { user_id: ada.id });
  assert.strictEqual(undo.status, 200, undo.text);
  assert.deepStrictEqual(undo.body, { message: 'Friend request accepted' });
  assert.deepStrictEqual((await pairRows(ada, cy)).map((r) => r.status), ['accepted']);

  const miss = { error: 'No pending request from this user' };

  // Your own request, declined by them: not yours to accept.
  const dee = await user('Dee');
  await row(ada, dee, 'declined');
  const own = await call('POST', '/api/friends/accept', ada, { user_id: dee.id });
  assert.deepStrictEqual([own.status, own.body], [404, miss]);
  assert.deepStrictEqual((await pairRows(ada, dee)).map((r) => r.status), ['declined']);

  // Withdrawn: they took it back.
  const eve = await user('Eve');
  await row(eve, ada, 'withdrawn');
  const gone = await call('POST', '/api/friends/accept', ada, { user_id: eve.id });
  assert.deepStrictEqual([gone.status, gone.body], [404, miss]);
  assert.deepStrictEqual((await pairRows(ada, eve)).map((r) => r.status), ['withdrawn']);

  // Banned since they asked: neither door makes a friend of them.
  const fay = await user('Fay');
  await row(fay, ada, 'declined');
  await pool.query('UPDATE users SET is_banned = TRUE WHERE id = $1', [fay.id]);
  assert.deepStrictEqual((await call('POST', '/api/friends/accept', ada, { user_id: fay.id })).status, 404);
  assert.deepStrictEqual((await call('POST', '/api/friends/request', ada, { user_id: fay.id })).body, { error: 'User not found' });
  assert.deepStrictEqual((await pairRows(ada, fay)).map((r) => r.status), ['declined']);

  // Blocked either way: the same.
  const gus = await user('Gus');
  await row(gus, ada, 'declined');
  await pool.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)', [ada.id, gus.id]);
  assert.strictEqual((await call('POST', '/api/friends/accept', ada, { user_id: gus.id })).status, 404);
  assert.strictEqual((await call('POST', '/api/friends/request', ada, { user_id: gus.id })).status, 404);
  assert.ok(!(await pairRows(ada, gus)).some((r) => r.status === 'accepted'), 'a friendship was made across a block');
});

test('a decline still never shows to the person declined', async () => {
  const ada = await user('Ada');
  const bo = await user('Bo');
  await row(ada, bo, 'pending');
  await call('POST', '/api/friends/decline', bo, { user_id: ada.id });

  assert.deepStrictEqual((await call('GET', `/api/friends/status/${bo.id}`, ada)).body, { status: 'pending', requester_id: ada.id });
  assert.deepStrictEqual((await call('GET', '/api/friends/outgoing', ada)).body.requests.map((r) => r.id), [bo.id]);
  assert.strictEqual((await preview(ada, await codeOf(bo))).body.status, 'outgoing');
  // Asking again answers what a pending request answers, as before.
  const again = await call('POST', '/api/friends/request', ada, { user_id: bo.id });
  assert.deepStrictEqual([again.status, again.body.status], [200, 'pending']);
});

// ===========================================================================
// 6. find-by-phone and Quick Add
// ===========================================================================

async function findable(name, phone, opts) {
  const u = await user(name, opts);
  await pool.query('UPDATE users SET phone = $2, phone_hash = $3, phone_discoverable = TRUE WHERE id = $1',
    [u.id, phone, phoneDiscoveryHash(phone)]);
  return u;
}

test('a spent contact allowance says when it lifts, in the body and the header', async () => {
  const me = await user('Me');
  const limits = friendsRouter.__budgetLimits();
  const book = ['+12025550191', '+12025550192'];
  for (let i = 0; i < limits.contactSync.hourly; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    assert.strictEqual((await call('POST', '/api/friends/find-by-phone', me, { phones: book })).status, 200);
  }
  const bulk = await call('POST', '/api/friends/find-by-phone', me, { phones: book });
  for (let i = 0; i < limits.phoneLookup.hourly; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    assert.strictEqual((await call('POST', '/api/friends/find-by-phone', me, { phones: ['+12025550193'] })).status, 200);
  }
  const single = await call('POST', '/api/friends/find-by-phone', me, { phones: ['+12025550193'] });

  for (const [lane, res, words] of [['bulk', bulk, /synced your contacts/], ['single', single, /looked up several numbers/]]) {
    assert.strictEqual(res.status, 429, `${lane}: ${res.text}`);
    assert.match(res.body.error, words, lane);
    assert.match(res.body.error, /Try again in (about|under)/, `${lane}: the sentence names no window`);
    assert.ok(!/—/.test(res.body.error), 'no em dashes in user-visible copy');
    assert.ok(Number.isInteger(res.body.retryAfterSeconds), lane);
    // Spent inside the last minute, so the hour frees in just under an hour.
    assert.ok(res.body.retryAfterSeconds > 3000 && res.body.retryAfterSeconds <= 3600, `${lane}: ${res.body.retryAfterSeconds}`);
    assert.strictEqual(res.headers.get('retry-after'), String(res.body.retryAfterSeconds), lane);
    const at = Date.parse(res.body.resetsAt);
    assert.ok(at > Date.now() && at <= Date.now() + 3601 * 1000, `${lane}: ${res.body.resetsAt}`);
  }
});

test('find-by-phone marks a request the caller received as incoming, and caps the photos', async () => {
  const me = await findable('Me', '+12025550200');
  const askedMe = await findable('AskedMe', '+12025550201', { photo: SMALL_PHOTO });
  const iAsked = await findable('IAsked', '+12025550202');
  const iDeclined = await findable('IDeclined', '+12025550203');
  const friend = await findable('Friend', '+12025550204');
  const stranger = await findable('Stranger', '+12025550205', { photo: LARGE_PHOTO });
  await row(askedMe, me, 'pending');
  await row(me, iAsked, 'pending');
  await row(iDeclined, me, 'declined');
  await row(friend, me, 'accepted');

  const res = await call('POST', '/api/friends/find-by-phone', me, {
    phones: ['+12025550201', '+12025550202', '+12025550203', '+12025550204', '+12025550205'],
  });
  assert.strictEqual(res.status, 200, res.text);
  const byId = Object.fromEntries(res.body.users.map((u) => [u.id, u]));
  assert.strictEqual(byId[askedMe.id].friendship_status, 'incoming');
  assert.strictEqual(byId[iAsked.id].friendship_status, 'pending');
  assert.strictEqual(byId[iDeclined.id].friendship_status, 'incoming', 'a request the caller declined is still theirs to say yes to');
  assert.strictEqual(byId[friend.id].friendship_status, 'accepted');
  assert.strictEqual(byId[stranger.id].friendship_status, null);
  assert.strictEqual(byId[askedMe.id].profile_image_url, SMALL_PHOTO);
  assert.strictEqual(byId[stranger.id].profile_image_url, null, 'a full-size avatar went out on a contact match');
  for (const u of res.body.users) {
    assert.deepStrictEqual(Object.keys(u).sort(), ['friendship_status', 'id', 'name', 'profile_image_url']);
  }

  // Seen from the other end, the same request is Pending to the one who sent it.
  const theirSide = await call('POST', '/api/friends/find-by-phone', askedMe, { phones: ['+12025550200'] });
  assert.strictEqual(theirSide.status, 200, theirSide.text);
  assert.deepStrictEqual(theirSide.body.users.map((u) => [u.id, u.friendship_status]), [[me.id, 'pending']]);
});

test('Quick Add caps the photos it suggests', async () => {
  const me = await user('Me');
  const pal = await user('Pal');
  const big = await user('Big', { photo: LARGE_PHOTO });
  const small = await user('Small', { photo: SMALL_PHOTO });
  await row(me, pal, 'accepted');
  await row(pal, big, 'accepted');
  await row(small, pal, 'accepted');
  const res = await call('GET', '/api/friends/suggestions', me);
  assert.strictEqual(res.status, 200, res.text);
  const byId = Object.fromEntries(res.body.suggestions.map((s) => [s.id, s]));
  assert.ok(byId[big.id] && byId[small.id], `both friends of a friend are suggested: ${res.text}`);
  assert.strictEqual(byId[big.id].profile_image_url, null);
  assert.strictEqual(byId[small.id].profile_image_url, SMALL_PHOTO);
});

// ===========================================================================
// 7. The live request carries the sender's face
// ===========================================================================

test('friend_request_received carries the sender\'s capped photo, from every door', async () => {
  const shown = await user('Shown', { photo: SMALL_PHOTO });
  const tooBig = await user('TooBig', { photo: LARGE_PHOTO });
  const received = (to) => emitted.filter((e) => e.event === 'friend_request_received' && e.room === `user:${to.id}`);

  // A new request through each door.
  const a = await user('A');
  assert.strictEqual((await call('POST', '/api/friends/request', shown, { user_id: a.id })).status, 200);
  const b = await user('B');
  assert.strictEqual((await call('POST', '/api/friends/add-by-code', tooBig, { code: await codeOf(b) })).status, 200);
  assert.deepStrictEqual(received(a).map((e) => e.payload), [{ fromUserId: shown.id, fromUserName: 'Shown', fromUserImage: SMALL_PHOTO }]);
  assert.deepStrictEqual(received(b).map((e) => e.payload), [{ fromUserId: tooBig.id, fromUserName: 'TooBig', fromUserImage: null }]);

  // A revive after the day's cooldown, through each door.
  const c = await user('C');
  const d = await user('D');
  await row(shown, c, 'declined', { daysAgo: 3 });
  await row(shown, d, 'declined', { daysAgo: 3 });
  assert.strictEqual((await call('POST', '/api/friends/request', shown, { user_id: c.id })).body.status, 'pending');
  assert.strictEqual((await call('POST', '/api/friends/add-by-code', shown, { code: await codeOf(d) })).body.status, 'pending');
  for (const to of [c, d]) {
    assert.deepStrictEqual(received(to).map((e) => e.payload), [{ fromUserId: shown.id, fromUserName: 'Shown', fromUserImage: SMALL_PHOTO }]);
  }
});
