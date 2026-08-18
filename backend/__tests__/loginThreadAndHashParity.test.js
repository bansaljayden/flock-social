// Run: node --test  (from backend/)
//
// SECURITY-AUDIT-auth.md round 4, R4-A2: POST /api/auth/login was
// unauthenticated CPU exhaustion, because the thing that makes it safe is also
// what makes it expensive.
//
// The route deliberately costs ONE bcrypt compare on every path, including for
// an address with no account — it compares against DUMMY_PASSWORD_HASH, a real
// hash at the same cost factor — because a route that skips the compare when
// the address is unknown answers "no such user" in a fraction of the time and
// is an account-enumeration oracle. That decision is correct and this file
// keeps it pinned.
//
// The problem was WHERE the cost was paid. `bcryptjs` is a pure-JavaScript
// implementation, so the work runs ON the single V8 thread. Round 4 measured
// 48.5 ms per compare with 40 ms of event-loop lag, on hardware faster than a
// Railway shared vCPU. The per-account throttle is keyed on the address the
// ATTACKER picks, so rotating addresses gives every attempt a fresh bucket; the
// only real bound is authLimiter at 10/min per IP, which is 0.8% of the thread
// per source address. ~60 rotating IPs — about ten dollars a month of proxies —
// hold the entire single-threaded API down, with no account and no knowledge.
// While it is held, every other route and every socket handshake is queued
// behind bcrypt.
//
// The fix is the native `bcrypt` package: same algorithm, same `$2a$`/`$2b$`
// stored format, work handed to libuv's threadpool instead of run on the event
// loop. The concurrency ceiling becomes UV_THREADPOOL_SIZE instead of one.
//
// That swap is only safe if two things are true, and BOTH are proved here
// rather than assumed:
//   1. every hash `bcryptjs` ever wrote to users.password still verifies, or
//      the deploy locks out every password account at once;
//   2. the constant-cost path for unknown addresses survives, or the fix for a
//      DoS reopens the enumeration oracle it was built on top of.

// Env must be set before ANY require.
process.env.JWT_SECRET = 'login-thread-parity-secret';
process.env.PUBLIC_WEB_URL = 'http://localhost:3000';
process.env.PUBLIC_API_URL = 'http://localhost:5000';
delete process.env.RESEND_API_KEY;
delete process.env.NODE_ENV;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

// The library that WAS in use, still a dependency (routes/users.js and several
// suites use it). It is what generated every password hash in the production
// database, so it is the right thing to generate the "old hash" fixtures with.
const bcryptjs = require('bcryptjs');

// ---------------------------------------------------------------------------
// The counting interposer, installed BEFORE routes/auth.js loads. It has to
// stub the module routes/auth.js actually requires — stubbing the other one
// would still load, still pass its own assertions, and count nothing.
// ---------------------------------------------------------------------------
const nativeBcryptPath = require.resolve('bcrypt');
const nativeBcrypt = require('bcrypt');
let compareLog = [];
require.cache[nativeBcryptPath].exports = {
  ...nativeBcrypt,
  compare: (data, hash) => {
    compareLog.push(String(hash));
    return nativeBcrypt.compare(data, hash);
  },
};

const jwksPath = require.resolve('jwks-rsa');
require.cache[jwksPath] = {
  id: jwksPath, filename: jwksPath, loaded: true,
  exports: () => ({ getSigningKey: (_kid, cb) => cb(new Error('no apple in this file')) }),
};

const pool = require('../config/database');
const authRouter = require('../routes/auth');
const { canonicalEmail, clearLoginFailures } = authRouter.__testing;

const authSource = () => fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');

// ---------------------------------------------------------------------------
// In-memory users table
// ---------------------------------------------------------------------------
let users = [];

const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (sql.startsWith('SELECT * FROM users WHERE LOWER(email) = LOWER(')) {
    const hit = users.find((u) => u.email.toLowerCase() === String(params[0]).toLowerCase()) || null;
    return { rows: hit ? [hit] : [] };
  }
  if (sql.startsWith('UPDATE users SET date_of_birth')) {
    const row = users.find((u) => u.id === params[1]);
    if (row) row.date_of_birth = params[0];
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  throw new Error(`unstubbed query: ${sql.slice(0, 140)}`);
};

const app = express();
app.use(express.json());
app.set('io', { in: () => ({ disconnectSockets: () => {} }) });
app.use('/api/auth', authRouter);

const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); pool.query = realQuery; });

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(`${base()}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, json: () => (data ? JSON.parse(data) : {}) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// The hash a real production row carries: written by bcryptjs, at the router's
// own cost factor, before the library ever changed.
const SALT_ROUNDS = Number(/const SALT_ROUNDS = (\d+)/.exec(authSource())[1]);
const LEGACY_BCRYPTJS_HASH = bcryptjs.hashSync('Password1', SALT_ROUNDS);

function seed() {
  users = [
    {
      id: 1, email: 'haspassword@example.com', name: 'Ivy',
      password: LEGACY_BCRYPTJS_HASH, oauth_provider: null, oauth_id: null,
      token_version: 0, is_banned: false, date_of_birth: '2000-01-01',
    },
    {
      id: 2, email: 'oauthonly@example.com', name: 'Otto',
      password: null, oauth_provider: 'google', oauth_id: 'g-1',
      token_version: 0, is_banned: false, date_of_birth: '2000-01-01',
    },
  ];
  for (const u of users) clearLoginFailures(canonicalEmail(u.email));
  clearLoginFailures(canonicalEmail('nobody-at-all@example.com'));
  compareLog = [];
}

// ===========================================================================
// 1. Which library, and is it deployable
// ===========================================================================

test('R4-A2: routes/auth.js uses the NATIVE bcrypt, not pure-JS bcryptjs', () => {
  const src = authSource();
  assert.ok(/^const bcrypt = require\('bcrypt'\);$/m.test(src),
    'the login compare must not run on the event loop — see the require comment in routes/auth.js');
  assert.ok(!/require\('bcryptjs'\)/.test(src),
    'bcryptjs is pure JavaScript; one compare is ~48 ms of the only thread there is');
});

test('R4-A2: the native package ships prebuilt binaries for the platforms we deploy on', () => {
  // bcrypt@6 bundles N-API prebuilds INSIDE the npm tarball (prebuildify +
  // node-gyp-build), so `npm ci` on Railway needs no compiler and no
  // install-time download, and the binary survives Node major upgrades. A
  // version bump that loses these turns a deploy into a build failure, which is
  // the only real risk this swap carries — so it is pinned.
  const prebuilds = path.join(__dirname, '..', 'node_modules', 'bcrypt', 'prebuilds');
  assert.ok(fs.existsSync(prebuilds), 'bcrypt must ship prebuilt binaries, not require a compiler');
  for (const target of ['linux-x64/bcrypt.glibc.node', 'linux-x64/bcrypt.musl.node', 'win32-x64/bcrypt.node']) {
    assert.ok(fs.existsSync(path.join(prebuilds, target)), `missing prebuild: ${target}`);
  }
  const pkg = require('bcrypt/package.json');
  assert.strictEqual(pkg.name, 'bcrypt');
  assert.strictEqual(pkg.scripts.install, 'node-gyp-build',
    'node-pre-gyp-style installs fetch a binary over the network at deploy time; node-gyp-build reads the bundled one');
});

// ===========================================================================
// 2. Existing hashes still verify — proved against a hash bcryptjs generated,
//    not assumed from "both implement the same algorithm"
// ===========================================================================

test('R4-A2: a bcryptjs-generated hash still verifies under the native library', async () => {
  assert.match(LEGACY_BCRYPTJS_HASH, /^\$2[aby]\$/, 'fixture must be a real bcrypt hash');
  assert.strictEqual(await nativeBcrypt.compare('Password1', LEGACY_BCRYPTJS_HASH), true,
    'every password account in the database is locked out if this is ever false');
  assert.strictEqual(await nativeBcrypt.compare('Password2', LEGACY_BCRYPTJS_HASH), false);

  // The other prefix bcryptjs has written over its life. Same 60-character
  // body, older version marker; the native library must read it too.
  const legacy2a = `$2a$${LEGACY_BCRYPTJS_HASH.slice(4)}`;
  assert.strictEqual(await nativeBcrypt.compare('Password1', legacy2a), true,
    'a $2a$ row from an older bcryptjs must still verify');

  // And the reverse, so a rollback to bcryptjs is not a second lockout.
  const nativeHash = await nativeBcrypt.hash('Password1', SALT_ROUNDS);
  assert.strictEqual(await bcryptjs.compare('Password1', nativeHash), true,
    'hashes written by the native library must stay readable by bcryptjs');

  // Same 72-byte truncation, so the MAX_PASSWORD note in routes/auth.js and the
  // bound it explains still describe reality.
  const prefix = 'p'.repeat(71);
  const truncating = bcryptjs.hashSync(`${prefix}-one`, 4);
  assert.strictEqual(await nativeBcrypt.compare(`${prefix}-two`, truncating), true,
    'the native library must truncate at 72 bytes exactly as bcryptjs does');
});

test('R4-A2: a user whose stored hash was written by bcryptjs still logs in through the route', async () => {
  seed();
  const res = await post('/api/auth/login', { email: 'haspassword@example.com', password: 'Password1' });
  assert.strictEqual(res.status, 200, `a legacy hash must still sign in: ${res.body}`);
  assert.ok(res.json().token, 'and it must mint a session');
  assert.strictEqual(compareLog.length, 1);
  assert.strictEqual(compareLog[0], LEGACY_BCRYPTJS_HASH,
    'the compare must have run against the stored legacy hash, not a re-hash');
});

// ===========================================================================
// 3. The timing property survives — an unknown address is indistinguishable
//    from a wrong password
// ===========================================================================

test('R4-A2: login does not distinguish an unknown address from a wrong password', async () => {
  seed();

  // Wall-clock assertions pass by accident on a fast machine and flake on a
  // slow one. What actually has to hold is that the three causes do the SAME
  // WORK and say the SAME THING: one compare each, against a real hash at the
  // same cost factor, and byte-identical responses.
  const attempts = [
    { label: 'no such address', email: 'nobody-at-all@example.com', password: 'WrongPass1' },
    { label: 'exists, signs in with Google', email: 'oauthonly@example.com', password: 'WrongPass1' },
    { label: 'exists, wrong password', email: 'haspassword@example.com', password: 'WrongPass1' },
  ];

  const bodies = [];
  const costs = [];
  const hashes = [];
  for (const attempt of attempts) {
    compareLog = [];
    const res = await post('/api/auth/login', { email: attempt.email, password: attempt.password });
    assert.strictEqual(res.status, 401, attempt.label);
    bodies.push(res.body);

    assert.strictEqual(compareLog.length, 1,
      `${attempt.label}: exactly one compare, or the COUNT is the oracle`);
    const cost = /^\$2[aby]\$(\d\d)\$/.exec(compareLog[0]);
    assert.ok(cost, `${attempt.label}: the compare must run against a real bcrypt hash, not '' or a sentinel`);
    costs.push(Number(cost[1]));
    hashes.push(compareLog[0]);
  }

  assert.strictEqual(new Set(costs).size, 1,
    'the dummy hash must carry the SAME cost factor as a real one, or the work differs even though the count matches');
  assert.strictEqual(costs[0], SALT_ROUNDS, 'and that cost factor is the router\'s own SALT_ROUNDS');
  assert.strictEqual(bodies[0], bodies[1]);
  assert.strictEqual(bodies[1], bodies[2], 'three causes, one sentence');

  // The two no-password branches spend their compare on the SAME dedicated
  // equaliser, and neither of them touches a real user's stored hash.
  assert.strictEqual(hashes[0], hashes[1],
    'an unknown address and an OAuth-only row must both compare against DUMMY_PASSWORD_HASH');
  assert.notStrictEqual(hashes[0], LEGACY_BCRYPTJS_HASH);
  assert.strictEqual(hashes[2], LEGACY_BCRYPTJS_HASH,
    'and the wrong-password branch compares against the row it found');
});

test('R4-A2: the equal-cost dummy compare is still the shape of the route', () => {
  const src = authSource();
  assert.ok(src.includes('bcrypt.compare(password, user?.password || DUMMY_PASSWORD_HASH)'),
    'every /login branch must pay the same toll — this line is the toll booth');
  assert.ok(/DUMMY_PASSWORD_HASH = bcrypt\.hashSync\([^,]+, SALT_ROUNDS\)/.test(src),
    'the equaliser must be hashed at SALT_ROUNDS, not at a cheaper cost');
  assert.ok(Number(/const SALT_ROUNDS = (\d+)/.exec(src)[1]) >= 10,
    'lowering the cost factor is the wrong lever for R4-A2 and is explicitly ruled out');
});

// ===========================================================================
// 4. The actual finding: the compare no longer holds the only thread
// ===========================================================================

test('R4-A2: concurrent compares do not starve the event loop', async () => {
  // Measured through the library routes/auth.js requires, not through HTTP: an
  // HTTP round trip generates its own loop activity and would mask the thing
  // under test. The route's use of this library is pinned by the source test
  // at the top of this file.
  //
  // Round 4's numbers on the audit machine, 16 concurrent compares: bcryptjs
  // 704 ms wall with TWO turns of unrelated event-loop work in that window (one
  // 703 ms head-of-line gap); native bcrypt 163 ms wall with 173,062 turns and
  // a 0.8 ms maximum gap. The threshold below is three orders of magnitude
  // below the native figure and two above the pure-JS one, so it separates the
  // two implementations without depending on how fast this machine is.
  const hash = LEGACY_BCRYPTJS_HASH;
  let ticks = 0;
  let stopped = false;
  (function tick() { if (stopped) return; ticks += 1; setImmediate(tick); })();

  const started = Date.now();
  await Promise.all(Array.from({ length: 8 }, () => nativeBcrypt.compare('Password1', hash)));
  const wall = Date.now() - started;
  stopped = true;

  assert.ok(wall > 0, 'the compares must actually have cost something');
  assert.ok(ticks > 200,
    `unrelated event-loop work got only ${ticks} turns during 8 concurrent compares (${wall} ms) — the compare is back on the event loop`);
});

test('R4-A2: eight concurrent logins all complete, and each still costs one compare', async () => {
  seed();
  // Fired without awaiting in between, the way an attacker sends them. Under
  // bcryptjs these serialise on the one thread; the assertion here is about
  // correctness under concurrency, not speed — the compare count per request
  // must not change just because requests overlap.
  const inFlight = [];
  for (let i = 0; i < 8; i += 1) {
    inFlight.push(post('/api/auth/login', { email: `ghost${i}@example.com`, password: 'WrongPass1' }));
  }
  const responses = await Promise.all(inFlight);

  assert.deepStrictEqual([...new Set(responses.map((r) => r.status))], [401]);
  assert.strictEqual(new Set(responses.map((r) => r.body)).size, 1, 'one sentence for all of them');
  assert.strictEqual(compareLog.length, 8,
    'eight unknown addresses must cost eight compares — dropping the compare under load would be the oracle again');
  assert.ok(compareLog.every((h) => /^\$2[aby]\$/.test(h)), 'all against a real hash');
});
