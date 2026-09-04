// Run: node --test  (from backend/)
//
// Hardening sweep 2026-08-14 (round 22): adversarial re-audit of routes/auth.js
// and the password-reset flow. Most of what this sweep examined was already
// correct and already pinned elsewhere (passwordReset.test.js,
// emailVerification.test.js, minorsCompliance.test.js, authReaudit.test.js);
// this file pins the angles those suites measure with a wall clock or a single
// request, using counting mocks and orchestrated races instead:
//
//   1. ENUMERATION BY WORK DONE. /login must cost exactly one bcrypt compare on
//      every failure branch (unknown address, OAuth row, wrong password), and
//      the per-account throttle must answer identically for addresses that do
//      not exist. /forgot-password must run the same number of in-request
//      queries whether or not the account exists. Counted, not timed: a counter
//      cannot be flaky and cannot pass by accident on a fast machine.
//   2. RESET TOKEN RACE. Two concurrent submissions of the SAME token must
//      produce exactly one completed reset and exactly one token_version bump.
//      The sequential replay is pinned in passwordReset.test.js; the race is
//      what the guarded UPDATE actually exists for.
//   3. THE DOB RACE (the fix this round ships). Two concurrent sign-ins on a
//      NULL-DOB account, one supplying an under-13 date and one a passing date,
//      could end with the passing date OVERWRITING the just-persisted child
//      date — erasing the COPPA actual knowledge the persist exists to record,
//      and signing the account in. The write is now guarded.
//   4. FREEZE BLAST RADIUS (the other fix). Learning an account is under 13
//      now bumps token_version and drops live sockets, so the freeze applies
//      to the sessions the account already holds, not only to future sign-ins.
//   5. The OAuth linking rule, route-level: an unvouched provider email can
//      neither claim nor evict a password row, and a vouched one only claims
//      the row that PROVED this address.
//   6. No reset link is ever printed by a production process, and bcrypt use
//      is pinned at cost >= 10 with the equal-cost dummy compare in place.

// Env must be set before ANY require.
process.env.JWT_SECRET = 'test-secret-for-auth-flows-hardening';
process.env.GOOGLE_CLIENT_ID = 'flock-test.apps.googleusercontent.com';
process.env.PUBLIC_WEB_URL = 'http://localhost:3000';
process.env.PUBLIC_API_URL = 'http://localhost:5000';
process.env.RESEND_API_KEY = 'test-resend-key';
delete process.env.NODE_ENV;
delete process.env.APPLE_REQUIRE_NONCE;

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// ---------------------------------------------------------------------------
// Module stubs, installed in the require cache BEFORE routes/auth.js loads.
// ---------------------------------------------------------------------------
const { publicKey: APPLE_PUB } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const jwksPath = require.resolve('jwks-rsa');
require.cache[jwksPath] = {
  id: jwksPath, filename: jwksPath, loaded: true,
  exports: () => ({ getSigningKey: (_kid, cb) => cb(null, { getPublicKey: () => APPLE_PUB }) }),
};

let sentMail = [];
const resendPath = require.resolve('resend');
require.cache[resendPath] = {
  id: resendPath, filename: resendPath, loaded: true,
  exports: {
    Resend: class {
      constructor() {
        this.emails = {
          send: async (msg) => {
            sentMail.push(msg);
            return { data: { id: `mail-${sentMail.length}` }, error: null };
          },
        };
      }
    },
  },
};

const appleAuthPath = require.resolve('../services/appleAuth');
require.cache[appleAuthPath] = {
  id: appleAuthPath, filename: appleAuthPath, loaded: true,
  exports: {
    isConfigured: () => false,
    exchangeAppleCode: async () => ({}),
    revokeAppleToken: async () => {},
  },
};

// The counting mock for finding 1: every bcrypt.compare that routes/auth.js
// runs is recorded here. Wall-clock timing tests pass by accident on a fast
// machine and flake on a slow one; a call counter does neither.
//
// ROUND 24 (R4-A2): routes/auth.js now requires the NATIVE `bcrypt` rather than
// pure-JS `bcryptjs`, so this interposer follows it. Stubbing `bcryptjs` here
// would still load and still pass its own assertions while counting nothing the
// route does — the counter would silently stop being a counter.
const bcryptPath = require.resolve('bcrypt');
const realBcrypt = require('bcrypt');
let compareLog = [];
require.cache[bcryptPath].exports = {
  ...realBcrypt,
  compare: (a, b) => {
    compareLog.push(String(b));
    return realBcrypt.compare(a, b);
  },
};

const pool = require('../config/database');
const authRouter = require('../routes/auth');
const emailService = require('../services/emailService');
const {
  canonicalEmail, claimDecision, flushResetMail, clearUnderageAttempts,
  recordLoginFailure, clearLoginFailures, LOGIN_FAIL_LIMIT, UNDERAGE_MSG,
  RESET_NEUTRAL_MESSAGE,
} = authRouter.__testing;

// ---------------------------------------------------------------------------
// In-memory tables, with clause-honouring guards (the round-19 rule: a WHERE
// guard deleted from routes/auth.js must stop being enforced HERE too, or the
// assertion about it tests this file).
// ---------------------------------------------------------------------------
let users = [];
let resets = [];
let requests = [];
let nextRequestId = 1;

// Test-installed interposer: lets a test hold specific statements to force an
// interleaving. Races are orchestrated, never slept for.
let testHook = null;

const clause = (sql, re) => re.test(sql);
const findByEmail = (email) => users.find((u) => String(u.email).toLowerCase() === String(email).toLowerCase())
  || users.find((u) => canonicalEmail(u.email) === canonicalEmail(email))
  || null;

const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  const now = Date.now();
  if (testHook) await testHook(sql, params);

  // ---- users --------------------------------------------------------------
  if (sql.includes('split_part') && sql.startsWith('SELECT * FROM users')) {
    const hit = findByEmail(params[0]);
    // A COPY, deliberately: a real SELECT returns a snapshot, and the DOB race
    // below only exists because two requests each hold their own snapshot.
    return { rows: hit ? [{ ...hit }] : [] };
  }
  if (sql === 'SELECT * FROM users WHERE LOWER(email) = LOWER($1)') {
    const hit = users.find((u) => String(u.email).toLowerCase() === String(params[0]).toLowerCase());
    return { rows: hit ? [{ ...hit }] : [] };
  }
  if (sql.includes("oauth_provider = 'google' AND oauth_id")) {
    return { rows: users.filter((u) => u.oauth_provider === 'google' && u.oauth_id === params[0]).map((u) => ({ ...u })) };
  }
  if (sql.startsWith('SELECT date_of_birth FROM users WHERE id')) {
    const row = users.find((u) => u.id === params[0]);
    return { rows: row ? [{ date_of_birth: row.date_of_birth }] : [] };
  }
  if (sql.startsWith('UPDATE users SET date_of_birth')) {
    const row = users.find((u) => u.id === params[1]
      && (!clause(sql, /AND date_of_birth IS NULL/) || u.date_of_birth == null));
    if (!row) return { rows: [], rowCount: 0 };
    row.date_of_birth = params[0];
    if (clause(sql, /token_version = token_version \+ 1/)) row.token_version += 1;
    return { rows: [{ ...row }], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE users SET password = $1, token_version = token_version + 1')) {
    const row = users.find((u) => u.id === params[1]
      && (!clause(sql, /AND oauth_provider IS NULL/) || u.oauth_provider == null)
      && (!clause(sql, /AND is_banned IS NOT TRUE/) || u.is_banned !== true)
      && (!clause(sql, /AND LOWER\(email\) = LOWER\(\$3\)/)
        || String(u.email).toLowerCase() === String(params[2]).toLowerCase()));
    if (!row) return { rows: [], rowCount: 0 };
    row.password = params[0];
    row.token_version += 1;
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  // ---- password_resets ----------------------------------------------------
  if (sql.startsWith('INSERT INTO password_resets')) {
    resets.push({
      id: resets.length + 1, user_id: params[0], selector: params[1], verifier_hash: params[2],
      email: params[3], request_ip: params[4],
      expires_at: new Date(now + params[5] * 60 * 1000).toISOString(),
      used_at: null, created_at: new Date(now).toISOString(),
    });
    return { rows: [], rowCount: 1 };
  }
  // Superseded links are DELETED now (so 'a newer one replaced it' can be told
  // apart from 'this one was spent'), and both credential-change paths delete
  // them too.
  if (sql.startsWith('DELETE FROM password_resets WHERE user_id')) {
    const before = resets.length;
    for (let i = resets.length - 1; i >= 0; i -= 1) {
      if (resets[i].user_id === params[0] && !resets[i].used_at) resets.splice(i, 1);
    }
    return { rows: [], rowCount: before - resets.length };
  }
  if (sql.startsWith('UPDATE password_resets SET used_at')) {
    const unused = (r) => !clause(sql, /AND used_at IS NULL/) || !r.used_at;
    const live = (r) => !clause(sql, /AND expires_at > NOW\(\)/) || Date.parse(r.expires_at) > now;
    if (sql.includes('WHERE id = $1')) {
      const r = resets.find((x) => x.id === params[0]);
      const ok = Boolean(r) && unused(r) && live(r);
      if (ok) r.used_at = new Date(now).toISOString();
      return { rows: ok ? [{ id: r.id }] : [], rowCount: ok ? 1 : 0 };
    }
    let n = 0;
    for (const r of resets) {
      if (r.user_id === params[0] && unused(r) && live(r)) { r.used_at = new Date(now).toISOString(); n += 1; }
    }
    return { rows: [], rowCount: n };
  }
  if (sql.startsWith('SELECT r.id, r.user_id')) {
    const r = resets.find((x) => x.selector === params[0]);
    if (!r) return { rows: [] };
    const u = users.find((x) => x.id === r.user_id);
    return {
      rows: [{
        ...r,
        current_email: u?.email ?? null,
        oauth_provider: u?.oauth_provider ?? null,
        is_banned: u?.is_banned ?? false,
        has_password: u?.password != null,
      }],
    };
  }

  // ---- password_reset_requests -------------------------------------------
  if (sql.startsWith('SELECT COUNT(*)') && sql.includes('FROM password_reset_requests')) {
    const within = (r, ms) => now - Date.parse(r.created_at) < ms;
    const mine = requests.filter((r) => r.email_key === params[0]);
    return {
      rows: [{
        email_hour: mine.filter((r) => within(r, 3600e3)).length,
        email_day: mine.filter((r) => within(r, 86400e3)).length,
        email_last: mine.length ? mine[mine.length - 1].created_at : null,
        ip_hour: requests.filter((r) => r.request_ip === params[1] && within(r, 3600e3)).length,
      }],
    };
  }
  if (sql.startsWith('INSERT INTO password_reset_requests')) {
    requests.push({
      id: nextRequestId++, email_key: params[0], request_ip: params[1],
      created_at: new Date(now).toISOString(),
    });
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith('DELETE FROM password_reset_requests')) return { rows: [], rowCount: 0 };

  throw new Error(`unstubbed query: ${sql.slice(0, 140)}`);
};

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
let disconnectedRooms = [];
const fakeIo = { in: (room) => ({ disconnectSockets: (c) => disconnectedRooms.push(`${room}|${c}`) }) };

const app = express();
app.use(express.json());
app.set('io', fakeIo);
app.use('/api/auth', authRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => { pool.query = realQuery; pool.end().catch(() => {}); });

const post = (p, body) => fetch(base + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function reset() {
  users = []; resets = []; requests = []; nextRequestId = 1;
  sentMail = []; disconnectedRooms = []; compareLog = []; testHook = null;
  clearUnderageAttempts();
  emailService.resetClient();
  process.env.RESEND_API_KEY = 'test-resend-key';
  delete process.env.NODE_ENV;
}

// Cheap hashes (cost 4) for rows under test; the throttle and compare-count
// tests run many compares and the cost factor is not what they measure.
const HASH = realBcrypt.hashSync('Password1', 4);
let nextUserId = 1;
function addUser(overrides = {}) {
  const row = {
    id: nextUserId++, email: `user${nextUserId}@example.com`, name: 'Real User',
    password: HASH, oauth_provider: null, oauth_id: null, is_banned: false,
    token_version: 0, email_verified: true, verified_email: null,
    date_of_birth: '2000-01-01', role: 'user', phone: null, interests: [],
    profile_image_url: null,
    ...overrides,
  };
  row.verified_email = overrides.verified_email !== undefined ? overrides.verified_email : row.email;
  users.push(row);
  return row;
}

function mintResetRow(user) {
  const selector = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  resets.push({
    id: resets.length + 1, user_id: user.id, selector,
    verifier_hash: crypto.createHash('sha256').update(verifier).digest('hex'),
    email: user.email, request_ip: null, used_at: null,
    expires_at: new Date(Date.now() + 3600e3).toISOString(),
    created_at: new Date().toISOString(),
  });
  return `${selector}.${verifier}`;
}

const CHILD_DOB = (() => {
  const t = new Date();
  return `${t.getFullYear() - 10}-01-01`;
})();
const ADULT_DOB = '2000-01-01';

async function withGoogle(profile, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('googleapis.com')) {
      if (u.includes('tokeninfo')) return { ok: true, json: async () => ({ aud: process.env.GOOGLE_CLIENT_ID }) };
      return { ok: true, json: async () => profile };
    }
    return saved(url, init);
  };
  try { return await fn(); } finally { globalThis.fetch = saved; }
}

// ===========================================================================
// 1. ENUMERATION BY WORK DONE — counted, not timed.
// ===========================================================================
test('every /login failure branch costs exactly one bcrypt compare and says the same sentence', async () => {
  reset();
  addUser({ email: 'haspassword@example.com' });
  addUser({ email: 'oauthonly@example.com', password: null, oauth_provider: 'google', oauth_id: 'g-1' });

  const bodies = [];
  for (const attempt of [
    { email: 'nobody-at-all@example.com', password: 'WrongPass1' }, // no such account
    { email: 'oauthonly@example.com', password: 'WrongPass1' },     // OAuth row, no password
    { email: 'haspassword@example.com', password: 'WrongPass1' },   // real row, wrong password
  ]) {
    compareLog = [];
    const res = await post('/api/auth/login', attempt);
    assert.strictEqual(res.status, 401);
    bodies.push(await res.text());
    assert.strictEqual(compareLog.length, 1,
      `${attempt.email}: every branch must cost exactly one compare, or the count IS the oracle`);
    assert.match(compareLog[0], /^\$2/,
      'the compare must run against a real bcrypt hash (the dummy on the branches with none)');
  }
  assert.strictEqual(bodies[0], bodies[1]);
  assert.strictEqual(bodies[1], bodies[2], 'three causes, one sentence');
});

test('the login throttle answers identically for an address that has no account', async () => {
  reset();
  addUser({ email: 'throttled-real@example.com' });

  for (const email of ['throttled-real@example.com', 'throttled-ghost@example.com']) {
    for (let i = 0; i < LOGIN_FAIL_LIMIT; i++) recordLoginFailure(canonicalEmail(email));
  }
  const real = await post('/api/auth/login', { email: 'throttled-real@example.com', password: 'WrongPass1' });
  const ghost = await post('/api/auth/login', { email: 'throttled-ghost@example.com', password: 'WrongPass1' });
  assert.strictEqual(real.status, 429);
  assert.strictEqual(ghost.status, 429);
  // The refusal now says when the lock lifts, which LOGIN_FAIL_WINDOW_MS made
  // knowable all along and this route used to throw away for "a few minutes".
  // That window cannot be an oracle: the throttle is keyed on the canonical
  // ADDRESS and is filled by failed attempts, which both of these had, so the
  // number is a fact about the attempts and never about the mailbox. What it IS
  // is clock-sensitive to the millisecond, so the instant is normalised out and
  // everything a reader can see is compared exactly.
  const scrub = (t) => t.replace(/"resetsAt":"[^"]+"/, '"resetsAt":"<instant>"')
    .replace(/"retryAfterSeconds":\d+/, '"retryAfterSeconds":<n>');
  const realBody = JSON.parse(await real.text());
  const ghostBody = JSON.parse(await ghost.text());
  assert.strictEqual(realBody.error, ghostBody.error,
    'a 429 that only real accounts can earn is an existence oracle');
  assert.ok(Math.abs(realBody.retryAfterSeconds - ghostBody.retryAfterSeconds) <= 2,
    'the two locks must run out at the same time, or the countdown is the oracle');
  assert.strictEqual(scrub(JSON.stringify(realBody)), scrub(JSON.stringify(ghostBody)),
    'nothing else in the refusal may differ');
  assert.match(realBody.error, /15 minutes/,
    'the lock is fifteen minutes and the sentence used to say "a few"');
  clearLoginFailures(canonicalEmail('throttled-real@example.com'));
  clearLoginFailures(canonicalEmail('throttled-ghost@example.com'));
});

test('/forgot-password does the same number of in-request queries for hit and miss', async () => {
  reset();
  addUser({ email: 'counted-hit@example.com' });

  // Warm the hourly purge so its fire-and-forget DELETE cannot land inside the
  // counting window below.
  await post('/api/auth/forgot-password', { email: 'warmup@example.com' }).then((r) => r.text());
  await flushResetMail();
  await new Promise((r) => setImmediate(r));

  let counted = 0;
  let releaseBackground;
  const backgroundGate = new Promise((r) => { releaseBackground = r; });
  testHook = async (sql) => {
    // Background-only statements (token issue) are held; everything that the
    // RESPONSE waits on is counted. If the reply ever starts waiting on the
    // token write, this test hangs instead of passing.
    if (sql.includes('password_resets') && !sql.includes('password_reset_requests')) {
      await backgroundGate;
      return;
    }
    counted += 1;
  };

  const miss = await post('/api/auth/forgot-password', { email: 'counted-ghost@example.com' });
  const missBody = await miss.text();
  const missCount = counted;

  counted = 0;
  const hit = await post('/api/auth/forgot-password', { email: 'counted-hit@example.com' });
  const hitBody = await hit.text();
  const hitCount = counted;

  releaseBackground();
  testHook = null;
  await flushResetMail();

  assert.strictEqual(miss.status, 200);
  assert.strictEqual(hit.status, 200);
  assert.strictEqual(missBody, hitBody, 'same bytes either way');
  assert.strictEqual(JSON.parse(hitBody).message, RESET_NEUTRAL_MESSAGE);
  assert.strictEqual(hitCount, missCount,
    'the account-exists branch must not do extra awaited work the clock could read');
  assert.strictEqual(resets.length, 1, 'the token was still issued, in the background');
});

test('signup reveals existence on purpose, and only with the pinned sentence', async () => {
  reset();
  addUser({ email: 'taken@example.com' });
  // DELIBERATE REVEAL, pinned rather than "fixed": signup has to tell the
  // person the address is taken or they cannot act, and the product accepts
  // that. What is NOT accepted is the sentence drifting into something that
  // names the sign-in method, which is the oracle /login closed in round 16.
  const res = await post('/api/auth/signup', {
    email: 'taken@example.com', password: 'Password1', name: 'Someone',
    date_of_birth: ADULT_DOB,
  });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.error, 'Email already registered');
  assert.ok(!/google|apple|oauth/i.test(JSON.stringify(body)), 'never the provider');
});

// ===========================================================================
// 2. RESET TOKEN RACE — the guarded UPDATE under actual concurrency.
// ===========================================================================
test('two concurrent submissions of one reset token: one winner, one bump, replay reads used', async () => {
  reset();
  const user = addUser({ email: 'raced-reset@example.com', token_version: 4 });
  const token = mintResetRow(user);

  // Hold both token lookups until both requests are in flight, so both pass
  // inspection and the guarded UPDATE is the only thing splitting them.
  let arrived = 0;
  let open;
  const barrier = new Promise((r) => { open = r; });
  testHook = async (sql) => {
    if (sql.startsWith('SELECT r.id')) {
      arrived += 1;
      if (arrived === 2) open();
      await barrier;
    }
  };

  const [a, b] = await Promise.all([
    post('/api/auth/reset-password', { token, password: 'WinnerPass1' }),
    post('/api/auth/reset-password', { token, password: 'SecondPass1' }),
  ]);
  testHook = null;

  const statuses = [a.status, b.status].sort();
  assert.deepStrictEqual(statuses, [200, 400], 'exactly one submission may win');
  const loser = a.status === 400 ? a : b;
  assert.strictEqual((await loser.json()).reason, 'used');

  assert.strictEqual(users[0].token_version, 5,
    'exactly one bump: the winner revoked every session, the loser revoked nothing twice');
  const winnerPassword = a.status === 200 ? 'WinnerPass1' : 'SecondPass1';
  assert.ok(realBcrypt.compareSync(winnerPassword, users[0].password),
    'the stored password is the winner\'s and only the winner\'s');

  // And the spent token stays spent, on both endpoints.
  const check = await (await post('/api/auth/reset-password/check', { token })).json();
  assert.deepStrictEqual(check, { valid: false, reason: 'used' });
  const replay = await post('/api/auth/reset-password', { token, password: 'ThirdTry1' });
  assert.strictEqual(replay.status, 400);
  assert.strictEqual((await replay.json()).reason, 'used');
  assert.strictEqual(users[0].token_version, 5, 'a replay bumps nothing');
});

// ===========================================================================
// 3. THE DOB RACE (fixed this round). Reproduction: account with NULL DOB, two
//    concurrent sign-ins, the under-13 date persists FIRST and the passing
//    date lands second. Before the guard, the second write erased the child
//    date and walked in.
// ===========================================================================
test('a concurrent adult-DOB login cannot erase the under-13 date the other request just recorded', async () => {
  reset();
  const user = addUser({ email: 'raced-dob@example.com', date_of_birth: null });

  let selects = 0;
  let openSelects;
  const selectBarrier = new Promise((r) => { openSelects = r; });
  let openAdultWrite;
  const adultGate = new Promise((r) => { openAdultWrite = r; });
  testHook = async (sql, params) => {
    // Both sign-ins must read the row while its DOB is still NULL.
    if (sql === 'SELECT * FROM users WHERE LOWER(email) = LOWER($1)') {
      selects += 1;
      if (selects === 2) openSelects();
      await selectBarrier;
    }
    // And the passing date must be the SECOND write.
    if (sql.startsWith('UPDATE users SET date_of_birth') && params[0] === ADULT_DOB) {
      await adultGate;
    }
  };

  const childReq = post('/api/auth/login', {
    email: 'raced-dob@example.com', password: 'Password1', date_of_birth: CHILD_DOB,
  });
  const adultReq = post('/api/auth/login', {
    email: 'raced-dob@example.com', password: 'Password1', date_of_birth: ADULT_DOB,
  });

  const childRes = await childReq;
  assert.strictEqual(childRes.status, 403);
  assert.strictEqual((await childRes.json()).error, UNDERAGE_MSG);
  assert.strictEqual(users[0].date_of_birth, CHILD_DOB, 'the knowledge landed');

  openAdultWrite();
  const adultRes = await adultReq;
  testHook = null;

  assert.strictEqual(adultRes.status, 403,
    'the raced retry with a passing date must not sign in — this is the resubmit bypass, concurrent');
  const adultBody = await adultRes.json();
  assert.strictEqual(adultBody.error, UNDERAGE_MSG);
  assert.ok(!('token' in adultBody), 'no session for a known child');
  assert.strictEqual(users[0].date_of_birth, CHILD_DOB,
    'the under-13 date is what stays recorded; actual knowledge cannot be un-known by a race');
  assert.strictEqual(user.id, users[0].id);
});

test('the losing writer keeps the winning ADULT date too: the guard is first-write-wins, not child-always', async () => {
  // The mirror interleaving: the adult date lands first, the child request is
  // still the one that carries the knowledge, so its write must overwrite.
  reset();
  addUser({ email: 'raced-dob2@example.com', date_of_birth: null });

  let selects = 0;
  let openSelects;
  const selectBarrier = new Promise((r) => { openSelects = r; });
  let openChildWrite;
  const childGate = new Promise((r) => { openChildWrite = r; });
  testHook = async (sql, params) => {
    if (sql === 'SELECT * FROM users WHERE LOWER(email) = LOWER($1)') {
      selects += 1;
      if (selects === 2) openSelects();
      await selectBarrier;
    }
    if (sql.startsWith('UPDATE users SET date_of_birth') && params[0] === CHILD_DOB) {
      await childGate;
    }
  };

  const adultReq = post('/api/auth/login', {
    email: 'raced-dob2@example.com', password: 'Password1', date_of_birth: ADULT_DOB,
  });
  const childReq = post('/api/auth/login', {
    email: 'raced-dob2@example.com', password: 'Password1', date_of_birth: CHILD_DOB,
  });

  const adultRes = await adultReq;
  // This ordering means the adult request completed before we knew anything:
  // it signs in, and that is unavoidable without a table lock.
  assert.strictEqual(adultRes.status, 200);
  const minted = (await adultRes.json()).token;
  assert.ok(minted);

  openChildWrite();
  const childRes = await childReq;
  testHook = null;

  assert.strictEqual(childRes.status, 403);
  assert.strictEqual(users[0].date_of_birth, CHILD_DOB,
    'the child date overwrites: the account freezes from here on');
  // And the freeze revoked the session the adult interleaving minted seconds
  // earlier: the bump means that JWT no longer matches the row.
  assert.strictEqual(users[0].token_version, 1,
    'learning the account is under 13 must kill the sessions it already holds');
});

// ===========================================================================
// 4. FREEZE BLAST RADIUS — learning "under 13" revokes what is already live.
// ===========================================================================
test('an under-13 reveal at login bumps token_version and drops the live sockets', async () => {
  reset();
  addUser({ email: 'frozen-now@example.com', date_of_birth: null, token_version: 3 });

  const res = await post('/api/auth/login', {
    email: 'frozen-now@example.com', password: 'Password1', date_of_birth: CHILD_DOB,
  });
  assert.strictEqual(res.status, 403);
  assert.strictEqual((await res.json()).error, UNDERAGE_MSG);
  assert.strictEqual(users[0].token_version, 4,
    'every JWT the account holds must die the moment we know it belongs to a child');
  assert.deepStrictEqual(disconnectedRooms, [`user:${users[0].id}|true`],
    'and the live sockets with them');
  assert.strictEqual(users[0].date_of_birth, CHILD_DOB);
});

// ===========================================================================
// 5. OAUTH LINKING RULE, route-level. The rule (claimDecision): a provider
//    sign-in may take over an existing password row ONLY when the provider
//    vouched for the address AND the row previously PROVED that same address.
//    Unvouched: refused outright. Vouched but the row never proved anything:
//    the row is evicted (keeps its data, loses the address), never handed over.
// ===========================================================================
test('a Google token whose email is not vouched for can neither claim nor evict a password row', async () => {
  reset();
  const victim = addUser({
    email: 'victim@example.com', email_verified: false, verified_email: null,
  });

  // email_verified ABSENT — the fail-closed case. Google did not vouch.
  const res = await withGoogle(
    { sub: 'g-forged', email: 'victim@example.com', name: 'Attacker' },
    () => post('/api/auth/google', { access_token: 'atk-token', date_of_birth: ADULT_DOB })
  );
  assert.strictEqual(res.status, 409, 'refused before anything is written');

  assert.strictEqual(users.length, 1, 'no second row');
  assert.strictEqual(users[0].id, victim.id);
  assert.strictEqual(users[0].oauth_provider, null, 'the row was not linked');
  assert.ok(realBcrypt.compareSync('Password1', users[0].password), 'its password survives');
  assert.strictEqual(users[0].email, 'victim@example.com', 'and it was not evicted off its address');
  assert.strictEqual(users[0].token_version, 0, 'no sessions were touched');
});

test('a vouched Google email still cannot claim a row that proved a DIFFERENT address', async () => {
  reset();
  // The address-switch trap: the row verified attacker@, then moved its email
  // onto the victim's address. verified_email is what the claim compares.
  addUser({
    email: 'victim2@example.com', email_verified: true, verified_email: 'attacker@example.com',
  });

  const res = await withGoogle(
    { sub: 'g-real', email: 'victim2@example.com', email_verified: true, name: 'Owner' },
    () => post('/api/auth/google', { access_token: 'atk-token-2', date_of_birth: ADULT_DOB })
  );
  assert.strictEqual(res.status, 409);
  assert.strictEqual(users[0].oauth_provider, null);
  assert.ok(realBcrypt.compareSync('Password1', users[0].password));
});

test('claimDecision states the rule: claim only what proved THIS address', () => {
  const proved = { email_verified: true, verified_email: 'me@gmail.com' };
  const squat = { email_verified: false, verified_email: null };
  const switched = { email_verified: true, verified_email: 'other@example.com' };
  assert.strictEqual(claimDecision(proved, 'me@gmail.com'), 'claim');
  assert.strictEqual(claimDecision(proved, 'm.e@gmail.com'), 'claim', 'same mailbox, canonical alphabet');
  assert.strictEqual(claimDecision(squat, 'me@gmail.com'), 'evict', 'never handed over, only displaced');
  assert.strictEqual(claimDecision(switched, 'me@gmail.com'), 'refuse');
});

// ===========================================================================
// 6. SECRETS AND THE LOG. The dev-only escape hatch that prints a link when no
//    mail can be sent must be exactly that: dev-only.
// ===========================================================================
test('a production process never prints a reset link, a dev process does when mail is skipped', async () => {
  reset();
  // No Resend key -> the send is SKIPPED, which is the one condition under
  // which the link would be printed at all.
  delete process.env.RESEND_API_KEY;
  emailService.resetClient();

  const logged = [];
  const realLog = console.log;
  console.log = (...args) => { logged.push(args.join(' ')); };
  try {
    process.env.NODE_ENV = 'production';
    addUser({ email: 'prod-user@example.com' });
    const res = await post('/api/auth/forgot-password', { email: 'prod-user@example.com' });
    assert.strictEqual(res.status, 200);
    await res.text();
    await flushResetMail();
    assert.ok(!logged.some((l) => /reset link|#token=/.test(l)),
      'a live server must never print a working reset link into Railway logs');
    assert.strictEqual(resets.length, 1, 'the token was still issued; only the print was refused');

    // Control: the same skip in a dev process DOES print, proving the spy and
    // the gate are both live rather than the assertion above passing vacuously.
    delete process.env.NODE_ENV;
    addUser({ email: 'dev-user@example.com' });
    const dev = await post('/api/auth/forgot-password', { email: 'dev-user@example.com' });
    assert.strictEqual(dev.status, 200);
    await dev.text();
    await flushResetMail();
    assert.ok(logged.some((l) => /password reset link for dev-user@example\.com/.test(l)),
      'the dev escape hatch must still work or local signups cannot be finished');
  } finally {
    console.log = realLog;
    process.env.RESEND_API_KEY = 'test-resend-key';
    delete process.env.NODE_ENV;
    emailService.resetClient();
  }
});

test('source pins: bcrypt cost, the equal-cost dummy compare, and the dev gates', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');

  const cost = /const SALT_ROUNDS = (\d+)/.exec(src);
  assert.ok(cost, 'SALT_ROUNDS must be a named constant');
  assert.ok(Number(cost[1]) >= 10, 'bcrypt cost below 10 is below OWASP\'s floor');

  assert.ok(src.includes("bcrypt.compare(password, user?.password || DUMMY_PASSWORD_HASH)"),
    'every /login branch must pay the same bcrypt toll — this line is the toll booth');
  assert.ok(!/password\s*===|===\s*password\b/.test(src.replace(/current_password/g, '')),
    'no plaintext password comparison anywhere in the file');

  // Both link-printing sites (verification + reset) carry BOTH halves of the
  // gate: mail was skipped entirely, and the process is not production.
  const gates = src.match(/result\.skipped && process\.env\.NODE_ENV !== 'production'/g) || [];
  assert.strictEqual(gates.length, 2,
    'the two dev link-printing sites must each be double-gated, and there must be no third');
});
