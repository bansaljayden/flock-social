// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// A FRIEND CODE HAS ONE ISSUER, AND IT IS THE SERVER.
// ---------------------------------------------------------------------------
// This file used to hold two derivations to one answer. A code was 'FLOCK-'
// plus the user id in base36, worked out by routes/friends.js for GET /my-code
// and again by App.js on the client, and the test failed if the two spellings
// drifted apart. The derivation was the defect it was protecting. A code that
// anyone can compute from an id is the user directory with a different
// spelling: FLOCK-0016 was user 42, so POST /add-by-code could walk every
// account in id order, and the probe budget was the only thing standing
// between a stranger and a friend request at any of them.
//
// Since migration 079 there is nothing left to agree on. The server draws a
// code at random, stores it in users.friend_code the first time its owner
// asks, and add-by-code finds a person through that column and nothing else.
// The agreement pinned here is the one that is left: the code the server hands
// out is the code the server resolves, and no other spelling resolves at all.
//
//   1. Nothing works a code out for itself. A client that derives one again
//      shows people a code no lookup can find, and a server that derives one
//      again reopens the walk.
//   2. A draw is the shape add-by-code accepts and fits the column it is kept
//      in: eight characters from the stated alphabet, one uniform draw each.
//   3. add-by-code resolves through users.friend_code. An old id-shaped code
//      is a miss, byte for byte the miss a code nobody holds gets.
//   4. GET /my-code issues once and then returns what is stored. Two requests
//      racing to issue agree on one code, and a draw that collides with
//      somebody else's code is drawn again, a bounded number of times.
//
// The fixture below models the three users statements the way Postgres
// answers them (COALESCE keeps a stored code, the partial unique index raises
// 23505 on a collision, a lookup longer than the column is simply a miss).
// sqlParameterTypes.test.js PREPAREs the same statements against the migrated
// schema, and migrationBootSafety.test.js applies 079 to a real database.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'friend-code-issuer-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT; // push stays a no-op

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

const REPO = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const ROUTE = read('routes', 'friends.js');
const MIGRATION = read('migrations', '079_friend_codes.sql');

// The alphabet routes/friends.js states: no 0 or O, no 1, I or L, so a code
// read off a screen or said out loud cannot be mistyped into somebody else's.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const LENGTH = 8;
const ISSUED_SHAPE = new RegExp(`^FLOCK-[${ALPHABET}]{${LENGTH}}$`);

// ── Fixture ─────────────────────────────────────────────────────────────────
// A users table with the one column this file is about. Ava has never opened
// Add Friends, so she holds no code yet. Bo and Cy hold issued ones. Cy is
// user 42, whose code under the old scheme was FLOCK-0016.
const AVA = 1;
const BO = 2;
const CY = 42;
const BO_CODE = 'FLOCK-BQ7KX9MZ';
const CY_CODE = 'FLOCK-7HNPQ3RW';
const UNHELD_CODE = 'FLOCK-ZZZZZZZZ'; // code-shaped, held by nobody

let users;        // id -> row, friend_code included
let friendships;  // [{ id, requester_id, addressee_id, status }]
let statements;   // every statement after the auth lookup, { sql, params }
let unknown;      // statements the fixture does not model
let nextRowId;
let afterRead;    // optional hook, awaited after the my-code read takes its snapshot
let failIssue;    // optional error the issuing UPDATE throws instead of writing

function freshUsers() {
  const row = (id, name, friend_code) => ({
    id, email: `${name.toLowerCase()}@example.com`, name, role: 'user',
    email_verified: true, is_banned: false, token_version: 0, friend_code,
  });
  return { [AVA]: row(AVA, 'Ava', null), [BO]: row(BO, 'Bo', BO_CODE), [CY]: row(CY, 'Cy', CY_CODE) };
}

const AUTH_SQL = /^SELECT id, email, name, role,.*FROM users WHERE id = \$1$/i;
const READ_RE = /^SELECT friend_code FROM users WHERE id = \$1$/i;
const ISSUE_RE = /^UPDATE users SET friend_code = COALESCE\(friend_code, \$2[^)]*\) WHERE id = \$1 RETURNING friend_code$/i;
const LOOKUP_RE = /^SELECT id, name, is_banned FROM users WHERE friend_code = \$1[^ ]*$/i;

const uniqueViolation = () => Object.assign(
  new Error('duplicate key value violates unique constraint "users_friend_code_key"'),
  { code: '23505', constraint: 'users_friend_code_key' }
);

async function dispatch(text, params = []) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (AUTH_SQL.test(sql)) {
    const u = users[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  statements.push({ sql, params });

  if (READ_RE.test(sql)) {
    // The snapshot is taken BEFORE the hook runs, so a test can hold two
    // reads open and have both see the column as it was.
    const u = users[params[0]];
    const rows = u ? [{ friend_code: u.friend_code }] : [];
    if (afterRead) await afterRead();
    return { rows, rowCount: rows.length };
  }

  if (ISSUE_RE.test(sql)) {
    if (failIssue) throw failIssue;
    const u = users[params[0]];
    if (!u) return { rows: [], rowCount: 0 };
    // COALESCE: a stored code stands. Only a NULL is filled, and filling it is
    // what the partial unique index checks.
    if (u.friend_code === null) {
      if (Object.values(users).some((o) => o.friend_code === params[1])) throw uniqueViolation();
      u.friend_code = params[1];
    }
    return { rows: [{ friend_code: u.friend_code }], rowCount: 1 };
  }

  if (LOOKUP_RE.test(sql)) {
    const u = Object.values(users).find((o) => o.friend_code !== null && o.friend_code === params[0]);
    return u
      ? { rows: [{ id: u.id, name: u.name, is_banned: u.is_banned }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }

  if (/^SELECT id, status, requester_id FROM friendships/i.test(sql)) {
    const [a, b] = [Number(params[0]), Number(params[1])];
    const rows = friendships
      .filter((r) => (r.requester_id === a && r.addressee_id === b)
        || (r.requester_id === b && r.addressee_id === a))
      .sort((x, y) => (x.status === 'accepted' ? 0 : 1) - (y.status === 'accepted' ? 0 : 1) || x.id - y.id)
      .slice(0, 1)
      .map(({ id, status, requester_id }) => ({ id, status, requester_id }));
    return { rows, rowCount: rows.length };
  }
  if (/^SELECT 1 FROM user_blocks/i.test(sql)) return { rows: [], rowCount: 0 };
  if (/^INSERT INTO friendships/i.test(sql)) {
    const [a, b] = [Number(params[0]), Number(params[1])];
    if (friendships.some((r) => r.requester_id === a && r.addressee_id === b)) return { rows: [], rowCount: 0 };
    const row = { id: nextRowId++, requester_id: a, addressee_id: b, status: 'pending' };
    friendships.push(row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  unknown.push(sql);
  return { rows: [], rowCount: 0 };
}
pool.query = (text, params) => dispatch(text, params);
pool.connect = async () => ({ query: (t, p) => dispatch(t, p), release: () => {} });

const friendsRouter = require('../routes/friends');
const { newFriendCode } = friendsRouter.__test;

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
  users = freshUsers();
  friendships = [];
  statements = [];
  unknown = [];
  nextRowId = 500;
  afterRead = null;
  failIssue = null;
  friendsRouter.__resetBudgets();
});

async function call(method, pathname, asUser, payload) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signUserToken(users[asUser])}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, body };
}

const assertModelled = () =>
  assert.deepStrictEqual(unknown, [], 'the fixture did not model a statement the route ran');

const issues = () => statements.filter((s) => ISSUE_RE.test(s.sql));

// crypto.randomInt(max) and crypto.randomInt(min, max) are the same draw.
const rangeOf = (args) => (typeof args[1] === 'number' ? [args[0], args[1]] : [0, args[0]]);

// newFriendCode calls crypto.randomInt through the module object, so replacing
// the property is seen by the route. Returns the function that puts it back.
function replaceRandomInt(fake) {
  const real = crypto.randomInt;
  crypto.randomInt = (...args) => fake(args, real);
  return () => { crypto.randomInt = real; };
}

// Make the next newFriendCode() calls spell exactly these codes, by answering
// each draw over the alphabet with the index of the next character. A draw
// past the end of the script, or over any other range, is a real one.
function scriptDraws(codes) {
  const queue = codes.flatMap((c) => [...c.slice('FLOCK-'.length)].map((ch) => ALPHABET.indexOf(ch)));
  return replaceRandomInt((args, real) => {
    const [lo, hi] = rangeOf(args);
    if (queue.length && lo === 0 && hi === ALPHABET.length) return queue.shift();
    return real(...args);
  });
}

// Holds every caller until n have arrived. Opens anyway after two seconds, so
// a route that never makes the second call fails on an assertion, not a hang.
function barrier(n) {
  let arrived = 0;
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  const fallback = setTimeout(() => open(), 2000);
  return () => {
    arrived += 1;
    if (arrived >= n) { clearTimeout(fallback); open(); }
    return opened;
  };
}

// ---------------------------------------------------------------------------
// 1. Nothing works a code out for itself
// ---------------------------------------------------------------------------

// Every shipping source file under frontend/src, not App.js alone. Screens
// keep leaving App.js, and a sweep of one file is how a check goes green on
// nothing.
function frontendSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
      } else if (/\.jsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(path.join(REPO, 'frontend', 'src'));
  return out;
}

const DERIVATIONS = [
  [/['"`]FLOCK-['"`]\s*\+/, "'FLOCK-' + something"],
  [/`FLOCK-\$\{/, 'a `FLOCK-${...}` template'],
  [/\.toString\(36\)\.toUpperCase\(\)/, 'an id spelled in upper-case base36'],
];

test('no frontend file builds a friend code; the app asks the server for it', () => {
  const files = frontendSources();
  assert.ok(files.some((f) => f.endsWith(path.join('src', 'App.js'))), 'the sweep lost App.js; fix frontendSources');
  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [re, what] of DERIVATIONS) {
      if (re.test(src)) offenders.push(`${path.relative(REPO, file)}: ${what}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    'a friend code is being built on the client again. The server is the only issuer (migration 079): a code '
    + 'worked out here is one no lookup can find, and if it matched the old scheme it would be the user id.');

  const app = fs.readFileSync(path.join(REPO, 'frontend', 'src', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
  const at = app.indexOf('const loadAddFriendsData = useCallback(');
  assert.notStrictEqual(at, -1, 'loadAddFriendsData moved; find where the Add Friends screen loads and repoint this');
  const load = app.slice(at, app.indexOf('\n  }, [', at));
  assert.match(load, /getMyFriendCode\(\)/, 'Add Friends no longer asks GET /api/friends/my-code for the code');
  assert.match(load, /setMyFriendCode\(d\.code\)/, 'the code shown is not the one the server answered with');

  const api = fs.readFileSync(path.join(REPO, 'frontend', 'src', 'services', 'api.js'), 'utf8');
  assert.match(api, /export async function getMyFriendCode\(\) \{\s*return request\('\/api\/friends\/my-code'\);/,
    'getMyFriendCode no longer calls the issuing route');
});

test('the server builds a code in one place, and never out of an id', () => {
  assert.doesNotMatch(ROUTE, /toString\(36\)|parseInt\([^)]*,\s*36\)/,
    'routes/friends.js turns ids and base36 into each other again. That is the old code, and the directory walk with it.');
  const concatenations = ROUTE.match(/'FLOCK-'\s*\+/g) || [];
  assert.strictEqual(concatenations.length, 1, 'a second place builds a FLOCK- code');
  // No parameter, so there is nothing about the account for it to read.
  const at = ROUTE.indexOf('function newFriendCode() {');
  assert.notStrictEqual(at, -1, 'newFriendCode takes an argument now, or moved; nothing about the account belongs in a draw');
  const fn = ROUTE.slice(at, ROUTE.indexOf("router.get('/my-code'", at));
  assert.match(fn, /return 'FLOCK-' \+ body;/, 'the one FLOCK- concatenation is not the random draw');
});

// ---------------------------------------------------------------------------
// 2. The draw
// ---------------------------------------------------------------------------

function acceptedShape() {
  // Read from the route rather than restated, so a validator narrowed below
  // what the issuer draws goes red here instead of refusing real codes.
  const m = ROUTE.match(/if \(!\/(\^FLOCK-[^/]+\$)\/\.test\(code\)\)/);
  assert.ok(m, 'the add-by-code format check moved; find it and repoint acceptedShape');
  return new RegExp(m[1]);
}

test('the alphabet leaves out every character that reads as another', () => {
  const m = ROUTE.match(/const FRIEND_CODE_ALPHABET = '([^']+)';/);
  assert.ok(m, 'FRIEND_CODE_ALPHABET moved');
  assert.strictEqual(m[1], ALPHABET, 'the alphabet changed; ISSUED_SHAPE in this file states the old one');
  for (const ch of '0O1IL') assert.ok(!m[1].includes(ch), `${ch} is in the alphabet, and it reads as another character`);
  assert.strictEqual(new Set(m[1]).size, m[1].length, 'a character appears twice, so it is drawn twice as often');
  assert.match(ROUTE, new RegExp(`const FRIEND_CODE_LENGTH = ${LENGTH};`));
});

test('a drawn code is the shape add-by-code accepts, and fits the column it is kept in', () => {
  const accepted = acceptedShape();
  const width = Number((MIGRATION.match(/ADD COLUMN IF NOT EXISTS friend_code VARCHAR\((\d+)\)/) || [])[1]);
  assert.ok(width > 0, 'could not read the width of users.friend_code from migration 079');
  const bound = ROUTE.slice(ROUTE.indexOf("router.post('/add-by-code'")).match(/isLength\(\{ min: 1, max: (\d+) \}\)/);
  assert.ok(bound, 'the add-by-code length bound moved');

  for (let i = 0; i < 200; i++) {
    const code = newFriendCode();
    assert.match(code, ISSUED_SHAPE, `${code} is not FLOCK- plus ${LENGTH} characters of the alphabet`);
    assert.match(code, accepted, `${code} would be refused by add-by-code as a bad format`);
    assert.ok(code.length <= width, `${code} does not fit VARCHAR(${width})`);
    assert.ok(code.length <= Number(bound[1]), `${code} is longer than add-by-code accepts`);
  }
});

test('each character is one uniform draw over the whole alphabet', () => {
  // crypto.randomInt is uniform over its range. A random byte taken modulo 31
  // is not: 256 leaves a remainder of 8, so the first eight characters would
  // come up a ninth more often. One draw per character, over exactly the
  // alphabet, is the property that matters, so it is asserted as a property.
  const calls = [];
  const script = [0, 30, 15, 1, 29, 2, 28, 3];
  const restore = replaceRandomInt((args) => { calls.push(args); return script[calls.length - 1]; });
  let code;
  try { code = newFriendCode(); } finally { restore(); }

  assert.strictEqual(calls.length, LENGTH, 'not one draw per character');
  for (const args of calls) {
    assert.deepStrictEqual(rangeOf(args), [0, ALPHABET.length], 'a draw over any range but the alphabet is biased or out of it');
  }
  assert.strictEqual(code, 'FLOCK-' + script.map((i) => ALPHABET[i]).join(''),
    'a draw did not map to the alphabet character at that index');
});

test('two draws differ, and a run of them reaches every character', () => {
  // 2,000 draws from 31^8 codes: the chance of any two matching is about two
  // in a million, and the chance of a character never showing up is nil.
  const draws = Array.from({ length: 2000 }, () => newFriendCode());
  assert.notStrictEqual(draws[0], draws[1]);
  assert.strictEqual(new Set(draws).size, draws.length, 'two draws matched; the draw is not random');
  const seen = new Set(draws.map((c) => c.slice('FLOCK-'.length)).join(''));
  assert.strictEqual([...seen].sort().join(''), [...ALPHABET].sort().join(''),
    'some characters of the alphabet are never drawn');
});

// ---------------------------------------------------------------------------
// 3. add-by-code resolves through users.friend_code, and nothing else
// ---------------------------------------------------------------------------

test('the code GET /my-code hands out is the code add-by-code resolves', async () => {
  const issued = await call('GET', '/api/friends/my-code', AVA);
  assert.strictEqual(issued.status, 200, issued.text);
  assert.match(issued.body.code, ISSUED_SHAPE);

  statements = [];
  const added = await call('POST', '/api/friends/add-by-code', BO, { code: issued.body.code });
  assert.strictEqual(added.status, 200, added.text);
  assert.strictEqual(added.body.status, 'pending');
  assert.strictEqual(added.body.user.id, AVA, 'the code resolved to somebody other than the person it was issued to');
  assert.deepStrictEqual(
    friendships.map(({ requester_id, addressee_id, status }) => ({ requester_id, addressee_id, status })),
    [{ requester_id: BO, addressee_id: AVA, status: 'pending' }]
  );

  // One read of the users table, keyed on the code. The id of the person it
  // found exists only as that read's answer.
  const directory = statements.filter((s) => /\bFROM users\b/i.test(s.sql));
  assert.strictEqual(directory.length, 1, directory.map((s) => s.sql).join('\n'));
  assert.match(directory[0].sql, LOOKUP_RE);
  assert.deepStrictEqual(directory[0].params, [issued.body.code]);
  assertModelled();
});

test('every add-by-code success describes the other account as an id and a name, and nothing else', async () => {
  // The directory read also carries is_banned, for the single miss. It went
  // out verbatim on every success as `user`, a moderation field about another
  // person that the app never reads (it reads user.id). Walked through the
  // doors that answer with a `user`: a new request, a request already pending,
  // a pending request from them (the accept races and answers with the row's
  // current state here, which is still a success that names them), and an
  // existing friendship.
  const bodies = [];

  const fresh = await call('POST', '/api/friends/add-by-code', AVA, { code: BO_CODE });
  assert.strictEqual(fresh.status, 200, fresh.text);
  bodies.push(['a new request', fresh.body]);

  const again = await call('POST', '/api/friends/add-by-code', AVA, { code: BO_CODE });
  assert.strictEqual(again.status, 200, again.text);
  bodies.push(['a request already pending', again.body]);

  friendships.push({ id: nextRowId++, requester_id: CY, addressee_id: AVA, status: 'pending' });
  const fromThem = await call('POST', '/api/friends/add-by-code', AVA, { code: CY_CODE });
  assert.strictEqual(fromThem.status, 200, fromThem.text);
  bodies.push(['a pending request from them', fromThem.body]);

  friendships.push({ id: nextRowId++, requester_id: BO, addressee_id: CY, status: 'accepted' });
  const friends = await call('POST', '/api/friends/add-by-code', CY, { code: BO_CODE });
  assert.strictEqual(friends.status, 200, friends.text);
  assert.strictEqual(friends.body.status, 'accepted', 'fixture precondition: already friends');
  bodies.push(['an existing friendship', friends.body]);

  for (const [door, body] of bodies) {
    assert.deepStrictEqual(Object.keys(body.user).sort(), ['id', 'name'],
      `${door}: the response described the other account with more than an id and a name`);
    assert.ok(!('is_banned' in body.user), `${door}: a moderation field about another person was sent`);
  }
});

test('a code typed in lower case, with spaces around it, still finds its owner', async () => {
  const res = await call('POST', '/api/friends/add-by-code', AVA, { code: `  ${CY_CODE.toLowerCase()} ` });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.user.id, CY);
  assertModelled();
});

test('a code worked out from an id the old way is a miss, exactly like a code nobody holds', async () => {
  // The old derivation, kept here and nowhere else: what an old QR code, an
  // old screenshot, or a script walking ids would send.
  const oldSchemeCode = (id) => 'FLOCK-' + id.toString(36).toUpperCase().padStart(4, '0');
  assert.strictEqual(oldSchemeCode(CY), 'FLOCK-0016');

  const nobody = await call('POST', '/api/friends/add-by-code', AVA, { code: UNHELD_CODE });
  assert.strictEqual(nobody.status, 404, nobody.text);
  assert.deepStrictEqual(nobody.body, { error: 'No user found with this code' });

  // Every account in the fixture, Ava's own included: her old code used to be
  // answered "That's your own code!", which needed the id inside it.
  for (const id of Object.keys(users).map(Number)) {
    friendsRouter.__resetBudgets(); // the answer is under test here, not the budget
    const res = await call('POST', '/api/friends/add-by-code', AVA, { code: oldSchemeCode(id) });
    assert.strictEqual(res.status, nobody.status, `${oldSchemeCode(id)} (user ${id}): ${res.text}`);
    assert.strictEqual(res.text, nobody.text, `${oldSchemeCode(id)} answers differently from a code nobody holds`);
  }
  assert.strictEqual(friendships.length, 0);

  // No id was read back out of any of them: every read of users was the
  // lookup by code, with the code as sent.
  const directory = statements.filter((s) => /\bFROM users\b/i.test(s.sql));
  assert.strictEqual(directory.length, 1 + Object.keys(users).length);
  for (const s of directory) {
    assert.match(s.sql, LOOKUP_RE);
    assert.match(String(s.params[0]), /^FLOCK-/);
  }
  assertModelled();
});

test('your own code is recognised as yours, and adds nobody', async () => {
  // The self-check used to compare the id parsed out of the code. There is no
  // id in a code any more, so it is the person the lookup found.
  const res = await call('POST', '/api/friends/add-by-code', BO, { code: BO_CODE });
  assert.strictEqual(res.status, 400, res.text);
  assert.deepStrictEqual(res.body, { error: "That's your own code!" });
  assert.strictEqual(friendships.length, 0);
  assertModelled();
});

// ---------------------------------------------------------------------------
// 4. GET /my-code: issued once, stored, and agreed on
// ---------------------------------------------------------------------------

test('GET /my-code issues a code once, then hands back the stored one', async () => {
  const first = await call('GET', '/api/friends/my-code', AVA);
  assert.strictEqual(first.status, 200, first.text);
  assert.match(first.body.code, ISSUED_SHAPE);
  assert.strictEqual(users[AVA].friend_code, first.body.code, 'the code handed out was not the one stored');
  assert.strictEqual(issues().length, 1);

  const second = await call('GET', '/api/friends/my-code', AVA);
  assert.strictEqual(second.status, 200, second.text);
  assert.strictEqual(second.body.code, first.body.code, 'the code changed between two visits');
  assert.strictEqual(issues().length, 1, 'a stored code was drawn again');

  // Somebody who already holds one is never written to.
  const bo = await call('GET', '/api/friends/my-code', BO);
  assert.strictEqual(bo.body.code, BO_CODE);
  assert.strictEqual(issues().length, 1);
  assertModelled();
});

test('two requests racing to issue a code both answer with the one that was stored', async () => {
  // Two tabs open Add Friends at the same moment. Both read the column while
  // it is still NULL, both draw, both write. COALESCE lets the first write
  // stand, and each answer is what the UPDATE RETURNED rather than what that
  // request drew, so both tabs show the same code and it is the stored one.
  afterRead = barrier(2);
  const [a, b] = await Promise.all([
    call('GET', '/api/friends/my-code', AVA),
    call('GET', '/api/friends/my-code', AVA),
  ]);
  assert.strictEqual(a.status, 200, a.text);
  assert.strictEqual(b.status, 200, b.text);
  assert.strictEqual(issues().length, 2, 'the race did not happen: both reads should have seen NULL');
  assert.notStrictEqual(issues()[0].params[1], issues()[1].params[1]);
  assert.strictEqual(a.body.code, b.body.code, 'two tabs were shown two codes, and only one of them resolves');
  assert.strictEqual(users[AVA].friend_code, a.body.code);
  assertModelled();
});

test("a draw that collides with somebody else's code is drawn again", async () => {
  const FRESH = 'FLOCK-2M9WTKQE';
  const restore = scriptDraws([BO_CODE, FRESH]);
  let res;
  try { res = await call('GET', '/api/friends/my-code', AVA); } finally { restore(); }

  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.code, FRESH);
  assert.deepStrictEqual(issues().map((s) => s.params[1]), [BO_CODE, FRESH],
    'the retry has to be a NEW draw; the same code collides again');
  assert.strictEqual(users[BO].friend_code, BO_CODE, "the collision touched the holder's code");
  assert.strictEqual(users[AVA].friend_code, FRESH);
  assertModelled();
});

test('five collisions in a row are a 500, not a loop, and the next ask starts over', async () => {
  const restore = scriptDraws(Array(5).fill(BO_CODE));
  let res;
  try { res = await call('GET', '/api/friends/my-code', AVA); } finally { restore(); }

  assert.strictEqual(res.status, 500, res.text);
  assert.deepStrictEqual(res.body, { error: 'Failed to get friend code' });
  assert.strictEqual(issues().length, 5, 'the retry is bounded at five draws');
  assert.strictEqual(users[AVA].friend_code, null, 'a failed issue left something written');

  const again = await call('GET', '/api/friends/my-code', AVA);
  assert.strictEqual(again.status, 200, again.text);
  assert.match(again.body.code, ISSUED_SHAPE);
  assert.strictEqual(users[AVA].friend_code, again.body.code);
  assertModelled();
});

test('an error that is not a collision is not retried', async () => {
  failIssue = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
  const res = await call('GET', '/api/friends/my-code', AVA);
  assert.strictEqual(res.status, 500, res.text);
  assert.deepStrictEqual(res.body, { error: 'Failed to get friend code' });
  assert.strictEqual(issues().length, 1,
    'only a collision is worth drawing again; retrying an outage is five times the load on a database that is down');
  assertModelled();
});
