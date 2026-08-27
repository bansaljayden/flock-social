// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// GET /api/users/search, DOES IT FIND THE PERSON YOU WERE LOOKING FOR?
// ---------------------------------------------------------------------------
// __tests__/searchProbeBudget.test.js pins that this route cannot be used to
// harvest the directory. That is a security property and it says nothing about
// whether the route WORKS. This file is the other half: given a real Postgres
// and a real table of people, does typing a friend's name put that friend in
// the answer?
//
// Two defects it was written against, both server-side:
//
//   1. NO ORDER BY. `LIMIT 20` over an unindexed `name ILIKE '%…%'` returns
//      whatever the sequential scan reaches first, which is physical row order
//      and therefore roughly signup order. Typing a friend's EXACT name could
//      return twenty other people and not them. On a search box whose whole job
//      is "find the person I already know", that is the failure that matters,
//      and it is invisible in any test with fewer than twenty rows.
//   2. NO NORMALISATION. Whitespace runs and Unicode width variants each minted
//      a different search. "John  Smith" out of a paste, or the non-breaking
//      space an iOS keyboard inserts, matched nobody while looking identical on
//      screen.
//
// WHY A REAL DATABASE AND NOT A FIXTURE. Both defects live in SQL semantics ,
// ILIKE's case folding, the ORDER BY's bucket expression, LIKE's ESCAPE
// default. A JavaScript fixture that answers `name.toLowerCase().includes(q)`
// cannot be wrong about any of them, so it cannot catch any of them either. It
// would have passed against the broken route. The route's own `pool.query` is
// pointed at an embedded Postgres here, so the string under test is the string
// the route ships and nothing is retyped into the test.
//
// MUTATION-CHECKED, one guard at a time, all five confirmed red, 2026-08-26:
//   * ORDER BY deleted from the route  -> "the exact name is first" and "the
//                                         buckets are exact..." both FAIL
//   * ranking buckets flipped (2,1,0)  -> the same two FAIL
//   * the whitespace collapse removed  -> "a doubled space still finds them" FAILS
//   * .normalize('NFKC') removed       -> "a full-width name still finds them" FAILS
//   * the ILIKE escape removed         -> "a percent sign is a character somebody
//                                         typed" and the backslash case both FAIL
//
// One thing that measurement corrected, and it is worth writing down rather
// than quietly having right: the NON-BREAKING SPACE case is carried by NFKC and
// not by the whitespace collapse. NFKC maps U+00A0 to an ordinary space, so the
// nbsp test stayed green with the collapse removed. Both guards are still
// needed, the collapse is what handles a doubled ordinary space, which NFKC
// does nothing about, but neither one covers the other.
// ---------------------------------------------------------------------------
process.env.JWT_SECRET = 'user-search-ranking-test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { Client } = require('pg');
const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');

const PG_PORT = pickEmbeddedPgPort('userSearchRanking');

// Deliberately far above every seeded row. The route excludes the caller with
// `id != $2`, so a caller id of 1 silently swallows the first row any fixture
// inserts, which is exactly what happened on the first run of this file and
// looked like six route bugs.
const CALLER_ID = 9999;

// The route destructures `authenticate` at require time, so the stub has to be
// installed before routes/users.js is loaded. Everything else about the route
// is the real thing, including its budget.
const pool = require('../config/database');
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => {
  req.user = { id: CALLER_ID, name: 'Caller', role: 'user' };
  next();
};

let client;
let pg;
let dataDir;
let base;
let server;

// The route's own pool, redirected. Anything the route asks for is asked of the
// embedded server verbatim; nothing is interpreted on the way past.
const realQuery = pool.query;

const usersRouter = require('../routes/users');
const { resetSearchProbeBudget } = usersRouter.__testing;

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flock-usersearch-pg-'));
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'userSearchRanking', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  client = new Client({
    host: '127.0.0.1', port: PG_PORT, user: 'postgres', password: 'postgres', database: 'postgres',
  });
  await client.connect();

  // Only the columns this route reads. A wider table would not make the test
  // stronger and would make it a duplicate of the schema.
  await client.query(`CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    profile_image_url TEXT,
    is_banned BOOLEAN DEFAULT FALSE
  )`);
  await client.query(`CREATE TABLE user_blocks (
    blocker_id INTEGER NOT NULL,
    blocked_id INTEGER NOT NULL
  )`);

  pool.query = (text, params) => client.query(text, params);

  const app = express();
  app.use(express.json());
  app.use('/api/users', usersRouter);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  }));
});

test.after(async () => {
  pool.query = realQuery;
  if (server) await new Promise((resolve) => server.close(resolve));
  if (client) await client.end().catch(() => {});
  if (pg) await pg.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  await pool.end().catch(() => {});
});

test.beforeEach(async () => {
  resetSearchProbeBudget();
  await client.query('TRUNCATE users RESTART IDENTITY');
  await client.query('TRUNCATE user_blocks');
});

async function seed(names) {
  for (const n of names) {
    await client.query('INSERT INTO users (name) VALUES ($1)', [n]);
  }
}

async function search(q) {
  const res = await fetch(`${base}/api/users/search?q=${encodeURIComponent(q)}`);
  const body = await res.json();
  return { status: res.status, names: (body.users || []).map((u) => u.name), body };
}

// ---------------------------------------------------------------------------
// 1. The person you typed the name of is in the answer
// ---------------------------------------------------------------------------

test('the exact name is first, even when twenty other rows matched before it', async () => {
  // Ann is inserted LAST on purpose. With no ORDER BY the scan reaches the
  // twenty Joannas first, LIMIT 20 is satisfied, and Ann never appears, the
  // user types their friend's whole name and is told about twenty strangers.
  const crowd = [];
  for (let i = 0; i < 20; i++) crowd.push(`Joanna Number ${i}`);
  await seed([...crowd, 'Ann']);

  const { status, names } = await search('Ann');
  assert.equal(status, 200);
  assert.equal(names[0], 'Ann',
    'searching a friend\'s exact name did not put that friend first');
  assert.ok(names.includes('Ann'));
});

test('the buckets are exact, then starts-with, then contains', async () => {
  await seed(['Roseanne Carter', 'Annabel Yu', 'Ann', 'Deanna Ross']);
  const { names } = await search('ann');

  assert.equal(names[0], 'Ann', 'the whole-name match is not first');
  assert.equal(names[1], 'Annabel Yu', 'a name STARTING with the term is not second');
  // The remaining two only contain it, and inside that bucket the shorter name
  // is the closer match.
  assert.deepEqual(names.slice(2), ['Deanna Ross', 'Roseanne Carter']);
});

test('the ranking is case-insensitive on both sides, so SHOUTING still ranks first', async () => {
  await seed(['Joanna Reyes', 'jayden bansal']);
  const { names } = await search('JAYDEN BANSAL');
  assert.equal(names[0], 'jayden bansal');
});

test('the same search twice gives the same twenty rows, in the same order', async () => {
  // Without a total order, two identical requests can disagree about which
  // twenty of the matches they show, which reads to a user as the app losing
  // people between keystrokes. Rows sharing a bucket AND a length are broken by
  // name and then id.
  const names = [];
  for (let i = 0; i < 40; i++) names.push(`Sam Person ${String(i).padStart(2, '0')}`);
  await seed(names);

  const a = await search('sam');
  const b = await search('sam');
  assert.equal(a.names.length, 20);
  assert.deepEqual(a.names, b.names);
});

// ---------------------------------------------------------------------------
// 2. What a person actually types
// ---------------------------------------------------------------------------

test('a doubled space still finds them, because it is the same name on screen', async () => {
  await seed(['John Smith']);
  const { names } = await search('John  Smith');
  assert.deepEqual(names, ['John Smith']);
});

test('a non-breaking space still finds them, because a phone keyboard inserts one', async () => {
  await seed(['John Smith']);
  // Written as an escape on purpose: a literal U+00A0 is invisible in every
  // editor, and __tests__/sourceHealth.test.js refuses one in backend source.
  const { names } = await search('John\u00A0Smith');
  assert.deepEqual(names, ['John Smith']);
});

test('a full-width name still finds them, because a keyboard layout can type one', async () => {
  await seed(['Jayden']);
  const { names } = await search('Ｊａｙｄｅｎ');
  assert.deepEqual(names, ['Jayden'], 'NFKC folding is not being applied to the term');
});

test('leading and trailing space is not part of the name', async () => {
  await seed(['Maya Okafor']);
  const { names } = await search('   Maya   ');
  assert.deepEqual(names, ['Maya Okafor']);
});

// ---------------------------------------------------------------------------
// 3. The escaping still holds, now that there are two patterns
// ---------------------------------------------------------------------------

test('a percent sign is a character somebody typed, not a wildcard', async () => {
  // The regression this guards: `q=%` built '%%%' and returned twenty arbitrary
  // accounts. The route now builds a SECOND pattern for the prefix bucket, and
  // an unescaped one there would put every row in bucket 1 rather than
  // returning them, which is quieter and just as wrong.
  await seed(['Alice', 'Bob', 'Carol']);
  const { names } = await search('%');
  assert.deepEqual(names, [], 'a percent sign is still being read as a wildcard');
});

test('an underscore is a character somebody typed, not a single-character wildcard', async () => {
  await seed(['Alice', 'Bob', 'A_lice']);
  const { names } = await search('A_l');
  assert.deepEqual(names, ['A_lice']);
});

test('a backslash does not break the pattern or the ranking', async () => {
  await seed(['Back\\slash']);
  const { names } = await search('Back\\slash');
  assert.deepEqual(names, ['Back\\slash']);
});

// ---------------------------------------------------------------------------
// 4. The filters that were already right stay right once ORDER BY exists
// ---------------------------------------------------------------------------

test('the caller, banned accounts and blocked pairs are still absent, and still are not ranked in', async () => {
  await client.query(`INSERT INTO users (id, name) VALUES (${CALLER_ID}, 'Ann Caller')`);
  await client.query("INSERT INTO users (id, name, is_banned) VALUES (2, 'Ann Banned', TRUE)");
  await client.query("INSERT INTO users (id, name) VALUES (3, 'Ann Blocked')");
  await client.query("INSERT INTO users (id, name) VALUES (4, 'Ann Blocker')");
  await client.query("INSERT INTO users (id, name) VALUES (5, 'Ann Visible')");
  // One direction each: the caller blocked 3, and 4 blocked the caller.
  await client.query(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (${CALLER_ID}, 3), (4, ${CALLER_ID})`);

  const { names } = await search('Ann');
  assert.deepEqual(names, ['Ann Visible'],
    'a hidden account came back once the rows were sorted');
});

test('an exact-name match that is banned does not get promoted to the top of the list', async () => {
  // The specific way ranking could undo a filter: bucket 0 is the strongest
  // position in the answer, so a WHERE that stopped applying would show up here
  // first and most visibly.
  await client.query("INSERT INTO users (id, name, is_banned) VALUES (2, 'Ann', TRUE)");
  await client.query("INSERT INTO users (id, name) VALUES (5, 'Annabel')");
  const { names } = await search('Ann');
  assert.deepEqual(names, ['Annabel']);
});

// ---------------------------------------------------------------------------
// 5. Nothing matched is nothing matched
// ---------------------------------------------------------------------------

test('a term nobody matches is an empty list and not an error', async () => {
  await seed(['Alice', 'Bob']);
  const { status, body } = await search('zzzzzz-nobody');
  assert.equal(status, 200);
  assert.deepEqual(body, { users: [] });
});
