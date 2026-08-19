// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// SECURITY-AUDIT-auth.md A5-1 (MEDIUM) and A5-3 (LOW) — routes/users.js
// ---------------------------------------------------------------------------
// A5-1. `f9699d1` swapped routes/auth.js from `bcryptjs` to the native `bcrypt`
// so a password compare stops running the pure-JS Blowfish key schedule on the
// only thread. It did not swap routes/users.js, which runs THREE compares and
// one hash on the same thread — and one of them is repeatable at will, which
// the login compare is not:
//
//   PUT    /api/users/profile   compare, then proofFailures.clear() on SUCCESS
//   PUT    /api/users/profile   hash, on a password change
//   GET    /api/users/export    compare
//   DELETE /api/users/me        compare
//
// A correct password is not a failure, so the proof throttle never engages for
// a caller who owns the account, and the only remaining bound is apiLimiter at
// 3000/15 min per IP — about 200/min. The audit measured one `bcryptjs` compare
// at 43 ms and eight concurrent at 341 ms of wall time with exactly ONE
// event-loop turn inside it: ~8.6 s of head-of-line blocking per minute per
// address, so seven addresses and one free account stall the process. Same
// mechanism as R4-A2 at an eighth of the address cost.
//
// The fix is one require, and the thing that has to be PROVEN rather than
// assumed is that it changes nothing about which stored hashes verify. The auth
// suite proved parity for the login path; this proves it for THIS path, through
// these four call sites, because "it carried over" is exactly the assumption
// that turns a library swap into a silent lockout.
//
// A5-3. The memory guard under this file's four attempt counters still ended in
// `hits.clear()` — the last wholesale clear on a live path in the backend. It
// now evicts least-consumed-first to a low water, the shape routes/auth.js's
// evictLoginFailures uses.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests';

// The two libraries, by name, so the parity matrix below is unambiguous about
// which one wrote a hash and which one read it.
const bcryptjs = require('bcryptjs');
const bcryptNative = require('bcrypt');

const BACKEND = path.join(__dirname, '..');
const usersSrc = fs.readFileSync(path.join(BACKEND, 'routes', 'users.js'), 'utf8')
  .replace(/\r\n/g, '\n');

const pool = require('../config/database');
const realQuery = pool.query;
const realConnect = pool.connect;

const usersRouter = require('../routes/users');
const {
  proofFailures, attemptLimiter, ATTEMPT_MAX_KEYS, ATTEMPT_LOW_WATER, SALT_ROUNDS,
} = usersRouter.__testing;

// ── Fixture ────────────────────────────────────────────────────────────────
// Cheap rounds: this is a test, and the cost factor is not what parity is about
// (the prefix and the digest are). Every hash below is written by `bcryptjs`,
// which is the situation on the production database: every password in it was
// hashed by the library this file no longer uses.
const PASSWORD = 'CorrectHorse1';
const WRONG = 'WrongHorse1';

function reHash(prefix) {
  // The version byte is a LABEL, not a different algorithm: $2a, $2b and $2y
  // are byte-identical for every input a password field can hold, and $2y
  // exists only because PHP wanted a marker after the 2011 crypt_blowfish fix.
  // So relabelling a real hash produces a real hash of that revision, which is
  // what a row imported from another stack would look like.
  const written = bcryptjs.hashSync(PASSWORD, 4);
  return prefix + written.slice(4);
}

// The two revisions this application can actually hold. Both writers in the
// tree — `bcryptjs` (the seeds, the fixtures, every existing production row)
// and native `bcrypt` (this file and routes/auth.js from here on) — emit $2b,
// and bcryptjs 2.x emitted $2a. Nothing here has ever written $2y or $2x.
const HASHES = {
  '$2a$': reHash('$2a$'),
  '$2b$': reHash('$2b$'),
};

let USER;
let served;

function reset(hash = HASHES['$2b$']) {
  USER = {
    id: 1, email: 'alice@example.com', name: 'Alice', role: 'user', email_verified: true,
    is_banned: false, banned_at: null, token_version: 0, password: hash,
    phone: null, interests: [], bio: null, profile_image_url: null,
    venmo_username: null, cashapp_cashtag: null, zelle_identifier: null,
    is_premium: false, oauth_provider: null, oauth_id: null, apple_refresh_token: null,
    terms_accepted_at: '2026-01-01T00:00:00Z', date_of_birth: '2008-05-01',
    reliability_score: '92.50', total_plans_joined: 0, total_plans_attended: 0,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };
  served = [];
  proofFailures.clearAll();
}
reset();

// Every SELECT against `users` keyed on the id answers with the fixture row;
// everything else answers empty. The routes under test are only driven as far
// as their password proof, so nothing past it has to be modelled — a 401 means
// the compare said no, and any other status means it said yes.
function handle(text, params) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  served.push(flat);
  if (/^SELECT[\s\S]*FROM users WHERE id = \$1/i.test(flat)) {
    return { rows: Number(params?.[0]) === USER.id ? [USER] : [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

pool.query = async (text, params) => handle(typeof text === 'string' ? text : text.text, params);
pool.connect = async () => ({
  query: async (text, params) => handle(typeof text === 'string' ? text : text.text, params),
  release() {},
});

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
  pool.connect = realConnect;
  return pool.end().catch(() => {});
});

function token() {
  return jwt.sign({ userId: USER.id, tv: USER.token_version }, process.env.JWT_SECRET);
}

async function req(method, url, { body, headers = {} } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}

// The three proofs, each reduced to the one bit this file is about: did the
// compare accept the password? A 401 is a refusal. Anything else got past it.
const PROOFS = [
  {
    name: 'PUT /api/users/profile',
    ok: (password) => req('PUT', '/api/users/profile', { body: { current_password: password } }),
  },
  {
    name: 'GET /api/users/export',
    ok: (password) => req('GET', '/api/users/export', { headers: { 'X-Export-Password': password } }),
  },
  {
    name: 'DELETE /api/users/me',
    ok: (password) => req('DELETE', '/api/users/me', { body: { password } }),
  },
];

// ===========================================================================
// 1. THE SWAP ITSELF
// ===========================================================================

test('routes/users.js runs its password work on the native library, not the pure-JS one', () => {
  const requires = [...usersSrc.matchAll(/require\('(bcrypt(?:js)?)'\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(requires, ['bcrypt'],
    'routes/users.js must require the native `bcrypt`. It runs three compares and a hash, '
    + 'one of them repeatable at apiLimiter\'s ~200/min by anyone with an account, and '
    + '`bcryptjs` runs every round of that on the event loop.');
});

test('no request path is left on bcryptjs', () => {
  // Seed scripts and test fixtures may keep it — they are not on a request
  // path, and it is the rollback path for the hashes in production.
  const OFF_PATH = /^(scripts|seeds|__tests__)\b/;
  const dirs = ['routes', 'services', 'middleware', 'utils', 'sockets'];
  const offenders = [];
  for (const dir of dirs) {
    const abs = path.join(BACKEND, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).filter((n) => n.endsWith('.js'))) {
      const rel = `${dir}/${f}`;
      if (OFF_PATH.test(rel)) continue;
      const src = fs.readFileSync(path.join(abs, f), 'utf8');
      // Comments strip first: this file's own header quotes the library it left.
      if (/require\('bcryptjs'\)/.test(src.replace(/^\s*\/\/.*$/gm, ''))) offenders.push(rel);
    }
  }
  assert.deepStrictEqual(offenders, [],
    `these request-path files still block the event loop on bcryptjs: ${offenders.join(', ')}`);
});

// ===========================================================================
// 2. HASH PARITY, THROUGH THIS FILE'S OWN ROUTES
// ===========================================================================
// The auth suite proved the matrix for the login compare. It is proved again
// here rather than inherited, because what makes a library swap dangerous is
// precisely the assumption that a property demonstrated on one call site holds
// on the others.

for (const prefix of Object.keys(HASHES)) {
  test(`a ${prefix} hash written by bcryptjs still verifies on all three proofs`, async () => {
    for (const proof of PROOFS) {
      reset(HASHES[prefix]);
      const good = await proof.ok(PASSWORD);
      assert.notStrictEqual(good.status, 401,
        `${proof.name} rejected a correct password against a ${prefix} hash written by `
        + `bcryptjs — the swap is a lockout for every row carrying that prefix (${good.text})`);

      reset(HASHES[prefix]);
      const bad = await proof.ok(WRONG);
      assert.strictEqual(bad.status, 401,
        `${proof.name} accepted a WRONG password against a ${prefix} hash (${bad.text})`);
    }
  });
}

test('the hash this file WRITES is readable by the rollback library', async () => {
  // PUT /profile is the only place in the file that creates a hash. If the
  // native library wrote something bcryptjs could not read, rolling the swap
  // back would lock out everyone who changed their password in between — which
  // is the failure mode that makes a rollback path worth having at all.
  const written = await bcryptNative.hash(PASSWORD, SALT_ROUNDS);
  assert.strictEqual(await bcryptjs.compare(PASSWORD, written), true,
    'a hash written by the native library must verify under bcryptjs, or the rollback is a lockout');
  assert.strictEqual(await bcryptjs.compare(WRONG, written), false);
  assert.strictEqual(written.startsWith('$2b$'), true, 'unexpected prefix from the native library');
});

test('the native library does NOT read $2y or $2x, and nothing here can write one', () => {
  // RECORDED, because SECURITY-AUDIT-auth.md's round-5 parity table lists all
  // four prefixes as verifying under both libraries and that is not what this
  // machine does. Measured here, on the repo's own installed versions:
  //
  //   $2a  bcryptjs true   native true
  //   $2b  bcryptjs true   native true
  //   $2y  bcryptjs true   native FALSE      (silently, not a throw)
  //   $2x  bcryptjs THROWS native FALSE
  //
  // That is safe TODAY and it is only safe for a reason that has to be written
  // down rather than assumed: no writer in this repo emits either revision, so
  // no row can carry one. It stops being safe the moment password rows are
  // imported from a PHP, crypt_blowfish or Spring Security stack, all of which
  // emit $2y — those hashes would fail closed and every one of those users
  // would be locked out with a "password is incorrect" that is a lie. Convert
  // the prefix to $2b on import; the digest does not change.
  const relabel = (prefix, hash) => prefix + hash.slice(4);
  const base = bcryptjs.hashSync(PASSWORD, 4);

  assert.strictEqual(bcryptNative.compareSync(PASSWORD, relabel('$2a$', base)), true);
  assert.strictEqual(bcryptNative.compareSync(PASSWORD, relabel('$2b$', base)), true);
  assert.strictEqual(bcryptNative.compareSync(PASSWORD, relabel('$2y$', base)), false,
    'the native library learned to read $2y — update this test and the audit table together');

  // And the reason that is tolerable: every hash this codebase writes is $2b.
  assert.strictEqual(bcryptjs.hashSync(PASSWORD, 4).slice(0, 4), '$2b$');
  assert.strictEqual(bcryptNative.hashSync(PASSWORD, 4).slice(0, 4), '$2b$');
});

test('the edge cases that would have made the swap a silent lockout', async () => {
  // A NUL byte is the one that mattered: older node.bcrypt builds truncated the
  // password at the first NUL where bcryptjs does not, so every password
  // containing one would have kept verifying against a PREFIX of itself.
  const nul = 'abc def';
  const nulHash = bcryptjs.hashSync(nul, 4);
  assert.strictEqual(await bcryptNative.compare(nul, nulHash), true);
  assert.strictEqual(await bcryptNative.compare('abc', nulHash), false,
    'the native library truncated at the NUL byte — every password containing one is now guessable at its prefix');

  // bcrypt ignores everything past 72 bytes. Both libraries must ignore the
  // SAME 72, or a long password stops verifying.
  const long = 'L0ngPassword!'.repeat(8);
  const longHash = bcryptjs.hashSync(long, 4);
  assert.strictEqual(await bcryptNative.compare(long, longHash), true);
  assert.strictEqual(await bcryptNative.compare(long.slice(0, 72), longHash), true,
    'the two libraries disagree about where the 72-byte truncation falls');

  // Non-ASCII, because the byte length and the character length differ.
  const emoji = 'påsswörd🔥1A';
  assert.strictEqual(await bcryptNative.compare(emoji, bcryptjs.hashSync(emoji, 4)), true);

  // And a value that is not a hash at all is false, not a throw: the routes
  // hand user.password straight in.
  assert.strictEqual(await bcryptNative.compare(PASSWORD, 'notahash'), false);
});

// ===========================================================================
// 3. THE EXPLOIT, PINNED AS REFUSED
// ===========================================================================

// Count event-loop turns while N compares are in flight, the way the audit did.
async function turnsDuring(work) {
  let turns = 0;
  let running = true;
  const tick = () => { if (running) { turns += 1; setImmediate(tick); } };
  setImmediate(tick);
  const started = Date.now();
  const out = await work();
  running = false;
  return { turns, ms: Date.now() - started, out };
}

test('eight concurrent password proofs no longer take the only thread with them', async () => {
  // A5-1's exact request: an account the attacker owns, the password they know,
  // PUT /profile with nothing else in the body, repeated. The proof throttle
  // deliberately does not fire (a correct password is not a failure), so the
  // mechanism can only be closed by where the work RUNS.
  //
  // Measured at the real cost factor against BOTH libraries, so the assertion
  // is a comparison rather than a machine-speed constant. The audit's numbers
  // for eight concurrent compares were 1 turn on bcryptjs and 83,917 on the
  // native library.
  const hash = bcryptjs.hashSync(PASSWORD, SALT_ROUNDS);
  const CONCURRENT = 8;
  const fanOut = (lib) => () => Promise.all(
    Array.from({ length: CONCURRENT }, () => lib.compare(PASSWORD, hash))
  );

  const pure = await turnsDuring(fanOut(bcryptjs));
  const native = await turnsDuring(fanOut(bcryptNative));

  for (const r of [...pure.out, ...native.out]) assert.strictEqual(r, true, 'sanity: both libraries agree');

  assert.ok(native.turns > pure.turns * 100,
    `${CONCURRENT} concurrent compares left the event loop ${native.turns} turns on the native `
    + `library against ${pure.turns} on bcryptjs (${native.ms} ms vs ${pure.ms} ms). Under 100x `
    + 'this file is back on the pure-JS key schedule and every route in the app queues '
    + 'behind a caller who knows their own password.');
  assert.ok(native.turns > 1000,
    `the loop only turned ${native.turns} times: the compares are running ON it`);
});

test('the repeat itself is answered, over and over, without the throttle firing', async () => {
  // The half of A5-1 that is NOT fixed and must not be misread as fixed: the
  // route still accepts an unlimited number of correct-password proofs, because
  // proofFailures.clear() on success is what keeps a user who mistypes and then
  // gets it right out of a lockout. What changed is the cost of each one to the
  // process, not the count. Pinned so a later reader does not "discover" the
  // repeat and assume the finding reopened.
  reset(HASHES['$2b$']);
  for (let i = 0; i < 12; i++) {
    const r = await PROOFS[0].ok(PASSWORD);
    assert.notStrictEqual(r.status, 429, 'the proof throttle fired on a CORRECT password');
    assert.notStrictEqual(r.status, 401, `the account's own password was refused: ${r.text}`);
  }
});

// ===========================================================================
// 4. A5-3 — THE LAST WHOLESALE clear() ON A LIVE PATH
// ===========================================================================

test('the attempt counters evict instead of clearing, and a flood cannot empty them', () => {
  const limiter = attemptLimiter({ limit: 5, windowMs: 15 * 60 * 1000 });
  const t0 = 1700000000000;

  // The victim: an account already throttled. This is the entry an attacker
  // wants gone, and it is both the OLDEST and the FULLEST, which is why the
  // order has to be consumption and not age.
  for (let i = 0; i < 5; i++) limiter.record('victim', t0);
  assert.ok(limiter.lockedFor('victim', t0 + 1) > 0, 'sanity: the victim is throttled');

  // The flood: distinct keys, one failure each, well past the ceiling.
  for (let i = 0; i < ATTEMPT_MAX_KEYS + 5000; i++) limiter.record(`flood-${i}`, t0 + 10 + i);

  assert.ok(limiter.size() <= ATTEMPT_MAX_KEYS + 1,
    `the map is unbounded: it holds ${limiter.size()} against a ceiling of ${ATTEMPT_MAX_KEYS}`);
  assert.ok(limiter.size() >= ATTEMPT_LOW_WATER,
    `the flood emptied the throttle (${limiter.size()} entries left). A control that gets `
    + 'WEAKER the harder it is pushed is the anti-pattern this whole class of fix is about.');
  assert.ok(limiter.lockedFor('victim', t0 + 20 + ATTEMPT_MAX_KEYS) > 0,
    'the flood displaced the throttled entry — least-consumed-first must delete the '
    + "flooder's own one-hit entries before any spent counter");
});

test('no wholesale clear() survives on a live path in routes/users.js', () => {
  // Comments strip first: the block that documents the bug names the call it
  // removed, and prose is not a call site.
  const src = usersSrc.replace(/^\s*\/\/.*$/gm, '');
  const clears = src.split('\n').filter((l) => /hits\.clear\(\)/.test(l));
  assert.strictEqual(clears.length, 1,
    `hits.clear() appears ${clears.length} times in routes/users.js; it may exist only on the `
    + `test-only clearAll() export:\n${clears.map((l) => l.trim()).join('\n')}`);
  assert.ok(/clearAll\(\)\s*\{\s*hits\.clear\(\);\s*\}/.test(clears[0]),
    `the surviving clear() is not the test-only export: ${clears[0].trim()}`);
});

test('eviction leaves headroom instead of sorting the whole map on every record', () => {
  // Evicting to exactly the ceiling makes a full map sort itself on every
  // single failed proof, which is a CPU lever rather than a memory bound.
  assert.ok(ATTEMPT_LOW_WATER < ATTEMPT_MAX_KEYS,
    'the low water must sit below the ceiling');
  assert.ok(ATTEMPT_MAX_KEYS - ATTEMPT_LOW_WATER >= 1000,
    `only ${ATTEMPT_MAX_KEYS - ATTEMPT_LOW_WATER} entries of headroom: a map held at the `
    + 'ceiling would re-sort every few requests');
});
