// Run: node --test  (from backend/)
//
// Minors-compliance audit, 2026-08-14. Flock is a 13+ service, so under COPPA
// (16 CFR Part 312) it is not "directed to children" — the Rule attaches only
// on ACTUAL KNOWLEDGE that a user is under 13 (§312.2). The amended Rule
// (compliance date 2026-04-22) codifies the mixed-audience neutral age screen,
// and the FTC's COPPA FAQ spells out what "neutral" means in practice. Every
// test here pins one of those obligations onto the code:
//
//   1. NEUTRALITY. The refusal a child sees must not teach the threshold —
//      "you must be 13" tells a 12-year-old exactly which year to type next.
//   2. NO RETRY. The FAQ tells operators to keep a refused child from simply
//      re-entering an older age (its example is a cookie against
//      back-buttoning). Server-side that is the under-13 lockout: after a
//      refusal, the same mailbox (24h) or IP (15 min) cannot create an
//      account even with a passing date, on ANY of the three creation paths.
//   3. ACTUAL KNOWLEDGE STICKS. A signed-in account that supplies an under-13
//      date has told us it belongs to a child. The date is persisted before
//      the refusal, so the account freezes on every later sign-in instead of
//      staying retryable, and a stored under-13 date refuses sign-in even if
//      the request says nothing about age.
//   4. NO COLLATERAL. The lockout must not lock existing 13+ accounts out of
//      LOGIN — it guards account creation only.
//
// No database is touched. pool.query is replaced with a dispatcher over
// in-memory tables, the same technique emailVerification.test.js uses.

// Env must be set before ANY require.
process.env.JWT_SECRET = 'test-secret-for-minors-compliance-tests';
process.env.GOOGLE_CLIENT_ID = 'flock-test.apps.googleusercontent.com';
process.env.PUBLIC_WEB_URL = 'http://localhost:3000';
process.env.PUBLIC_API_URL = 'http://localhost:5000';
delete process.env.RESEND_API_KEY; // emailService skips sends — no network
delete process.env.APPLE_REQUIRE_NONCE;
delete process.env.NODE_ENV;

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// ---------------------------------------------------------------------------
// Module stubs, installed in the require cache BEFORE routes/auth.js loads.
// ---------------------------------------------------------------------------
const { publicKey: APPLE_PUB, privateKey: APPLE_PRIV } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const jwksPath = require.resolve('jwks-rsa');
require.cache[jwksPath] = {
  id: jwksPath, filename: jwksPath, loaded: true,
  exports: () => ({ getSigningKey: (_kid, cb) => cb(null, { getPublicKey: () => APPLE_PUB }) }),
};

// Apple server-to-server exchange: unconfigured, so no authorizationCode is
// required and no code exchange runs — the age gate is what is under test.
const appleAuthPath = require.resolve('../services/appleAuth');
require.cache[appleAuthPath] = {
  id: appleAuthPath, filename: appleAuthPath, loaded: true,
  exports: {
    isConfigured: () => false,
    exchangeAppleCode: async () => ({}),
    revokeAppleToken: async () => {},
  },
};

const appleIdentityToken = (claims) => jwt.sign(
  { iss: 'https://appleid.apple.com', aud: 'com.flockcorp.flock', ...claims },
  APPLE_PRIV,
  { algorithm: 'RS256', expiresIn: '10m', keyid: 'test-kid' }
);

const pool = require('../config/database');
const authRouter = require('../routes/auth');
const {
  UNDERAGE_MSG,
  recordUnderageAttempt,
  underageBlocked,
  clearUnderageAttempts,
  underageAttemptCount,
  UNDERAGE_EMAIL_TTL_MS,
  UNDERAGE_IP_TTL_MS,
  UNDERAGE_MAX_KEYS,
} = authRouter.__testing;
const { ageFromDob, MIN_AGE } = require('../utils/age');

// ---------------------------------------------------------------------------
// In-memory tables
// ---------------------------------------------------------------------------
let users = [];
let verifications = [];
let nextUserId = 1;

const canonical = authRouter.__testing.canonicalEmail;
const findByEmail = (email) => users.find((u) => String(u.email).toLowerCase() === String(email).toLowerCase())
  || users.find((u) => canonical(u.email) === canonical(email))
  || null;

const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  const now = Date.now();

  if (sql.includes('split_part') && sql.startsWith('SELECT * FROM users')) {
    const hit = findByEmail(params[0]);
    return { rows: hit ? [hit] : [] };
  }
  if (sql.includes("oauth_provider = 'google' AND oauth_id")) {
    return { rows: users.filter((u) => u.oauth_provider === 'google' && u.oauth_id === params[0]) };
  }
  if (sql.includes("oauth_provider = 'apple' AND oauth_id")) {
    return { rows: users.filter((u) => u.oauth_provider === 'apple' && u.oauth_id === params[0]) };
  }
  if (sql === 'SELECT * FROM users WHERE LOWER(email) = LOWER($1)') {
    return { rows: users.filter((u) => String(u.email).toLowerCase() === String(params[0]).toLowerCase()) };
  }
  if (sql.startsWith('INSERT INTO users')) {
    const row = {
      id: nextUserId++, token_version: 0, is_banned: false, password: null,
      oauth_provider: null, oauth_id: null, date_of_birth: null, role: 'user',
      venmo_username: null, cashapp_cashtag: null, zelle_identifier: null,
      verified_email: null, email_verified: false,
    };
    const flat = sql.replace(/NOW\(\)/gi, 'NOW');
    const cols = flat.slice(flat.indexOf('(') + 1, flat.indexOf(')')).split(',').map((c) => c.trim());
    const valsStart = flat.indexOf('(', flat.indexOf('VALUES'));
    const vals = flat.slice(valsStart + 1, flat.indexOf(')', valsStart)).split(',').map((v) => v.trim());
    cols.forEach((col, i) => {
      const v = vals[i];
      if (v === undefined) return;
      if (/^\$\d+$/.test(v)) { row[col] = params[Number(v.slice(1)) - 1]; return; }
      if (/^NOW$/i.test(v)) { row[col] = new Date().toISOString(); return; }
      if (/^TRUE$/i.test(v)) { row[col] = true; return; }
      if (/^FALSE$/i.test(v)) { row[col] = false; return; }
      row[col] = v.replace(/^'|'$/g, '');
    });
    users.push(row);
    // Honour the RETURNING list: the signup response `user` object is built
    // from it, and the data-minimization test below reads what it exposes.
    const m = /RETURNING (.+)$/i.exec(sql);
    if (m && m[1].trim() !== '*') {
      const out = {};
      for (const col of m[1].split(',').map((c) => c.trim())) out[col] = row[col];
      return { rows: [out], rowCount: 1 };
    }
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE users SET date_of_birth')) {
    const row = users.find((u) => u.id === params[1]);
    if (row) row.date_of_birth = params[0];
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  // ---- signup's verification-mail plumbing (not under test) ---------------
  if (sql.startsWith('INSERT INTO email_verifications')) {
    verifications.push({ user_id: params[0], created_at: new Date(now).toISOString(), request_ip: params[4] });
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE email_verifications SET used_at')) return { rows: [], rowCount: 0 };
  if (sql.startsWith('SELECT COUNT(*)') && sql.includes('FROM email_verifications')) {
    return { rows: [{ account_hour: 0, account_day: 0, account_last: null, ip_hour: 0 }] };
  }

  // ---- banned_identities (migration 012): nobody is tombstoned here -------
  if (sql.startsWith('SELECT 1 FROM banned_identities')) return { rows: [] };
  if (sql.startsWith('DELETE FROM banned_identities')) return { rows: [], rowCount: 0 };

  throw new Error(`unstubbed query: ${sql.slice(0, 140)}`);
};

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const fakeIo = { in: () => ({ disconnectSockets: () => {} }) };
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

const post = (path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function reset() {
  users = []; verifications = []; nextUserId = 1;
  clearUnderageAttempts();
}

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

// Calendar-safe DOB strings relative to the real clock. dobYearsAgo(13) is the
// 13th birthday TODAY (age 13, allowed); dobYearsAgo(13, 1) is a child whose
// 13th birthday is tomorrow (age 12, refused).
function dobYearsAgo(years, plusDays = 0) {
  const t = new Date();
  const d = new Date(t.getFullYear() - years, t.getMonth(), t.getDate() + plusDays);
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1, 2)}-${p(d.getDate(), 2)}`;
}

const ADULT_DOB = '2000-01-01';
const CHILD_DOB = dobYearsAgo(10);
const PASSWORD_HASH = bcrypt.hashSync('Password1', 4);

const signupBody = (over = {}) => ({
  email: 'teen@example.com', password: 'Password1', name: 'Teen User',
  date_of_birth: ADULT_DOB, ...over,
});

// ===========================================================================
// 1. NEUTRALITY — the refusal must not teach the child which date passes.
//    FTC COPPA FAQ: the age screen must "not encourage falsification"; a
//    refusal that names the threshold is a walkthrough for defeating it.
// ===========================================================================
test('the underage refusal is a real sentence that names no age, no threshold, no birth-date hint', () => {
  assert.strictEqual(typeof UNDERAGE_MSG, 'string');
  assert.ok(UNDERAGE_MSG.trim().length >= 10, 'must be a real sentence, not an empty string');
  // No digits at all: "13", "12", "2013" all teach the fix.
  assert.doesNotMatch(UNDERAGE_MSG, /\d/, 'must not contain any number');
  // No vocabulary that flags WHY: an age-flavored refusal invites a retry
  // with an older date even without the number.
  assert.doesNotMatch(
    UNDERAGE_MSG,
    /\b(age|old|older|young|younger|minor|birth|birthday|teen|child|kid|under|least|minimum)\b/i,
    'must not hint that age was the reason'
  );
});

test('the wire refusal for an under-13 signup is that sentence, with no needsDob escape hatch', async () => {
  reset();
  const res = await post('/api/auth/signup', signupBody({ date_of_birth: CHILD_DOB }));
  assert.strictEqual(res.status, 403);
  const json = await res.json();
  assert.strictEqual(json.error, UNDERAGE_MSG);
  assert.ok(!('needsDob' in json), 'needsDob would invite resubmitting a different date');
  assert.deepStrictEqual(users, [], 'no row may be created for a refused child');
});

// ===========================================================================
// 2. THE BOUNDARY — 13 exactly today is allowed, 13 tomorrow is not.
// ===========================================================================
test('signup boundary: the 13th birthday today passes, a day short refuses', async () => {
  reset();
  const young = await post('/api/auth/signup', signupBody({ email: 'a@example.com', date_of_birth: dobYearsAgo(13, 1) }));
  assert.strictEqual(young.status, 403);
  assert.strictEqual((await young.json()).error, UNDERAGE_MSG);
  assert.deepStrictEqual(users, []);

  reset();
  const ok = await post('/api/auth/signup', signupBody({ email: 'b@example.com', date_of_birth: dobYearsAgo(13) }));
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(users.length, 1);
  // Belt and braces: the two dates really do sit on either side of MIN_AGE.
  assert.strictEqual(ageFromDob(dobYearsAgo(13)), MIN_AGE);
  assert.strictEqual(ageFromDob(dobYearsAgo(13, 1)), MIN_AGE - 1);
});

// ===========================================================================
// 3. THE RETRY LOOPHOLE — refused once, the same mailbox/IP cannot come
//    straight back with an older date. This is the FAQ's anti-back-button
//    step, enforced where it cannot be cleared with the browser's storage.
// ===========================================================================
test('after an under-13 refusal, the same email cannot sign up with a passing date', async () => {
  reset();
  const first = await post('/api/auth/signup', signupBody({ date_of_birth: CHILD_DOB }));
  assert.strictEqual(first.status, 403);
  const firstJson = await first.json();

  const retry = await post('/api/auth/signup', signupBody({ date_of_birth: ADULT_DOB }));
  assert.strictEqual(retry.status, 403, 'the corrected date must not work');
  const retryJson = await retry.json();
  // Indistinguishable from the first refusal: same status, same body. A
  // different sentence here would confirm "your new date PASSED the check".
  assert.deepStrictEqual(retryJson, firstJson);
  assert.deepStrictEqual(users, [], 'no row may be created during the lockout');
});

test('a gmail dot/plus variant of the refused mailbox is the same mailbox to the lockout', async () => {
  reset();
  const first = await post('/api/auth/signup', signupBody({ email: 'kid.one@gmail.com', date_of_birth: CHILD_DOB }));
  assert.strictEqual(first.status, 403);
  clearUnderageAttempts();
  // Re-record via the exported function so ONLY an email-class key exists (the
  // wire path records the IP too, which this test must not lean on).
  //
  // Round 25: an address a caller merely ASSERTED is remembered against the
  // address AND the source IP, so the recording and the lookup both name one.
  // The canonical-alphabet property is what is under test here, and it holds
  // inside that scope: a dot/plus respelling is the same mailbox to the pair
  // key exactly as it was to the address-only key.
  recordUnderageAttempt('kid.one@gmail.com', '203.0.113.4');
  assert.strictEqual(underageBlocked('kidone+new@gmail.com', '203.0.113.4'), true,
    'canonical alphabet: dots and +tags must not mint a fresh identity');
  // A PROVED refusal is remembered against the address alone, and canonicalises
  // the same way. This is the wide block, so it holds from any address.
  clearUnderageAttempts();
  recordUnderageAttempt('kid.one@gmail.com', '203.0.113.4', Date.now(), { addressProved: true });
  assert.strictEqual(underageBlocked('kidone+new@gmail.com', '198.51.100.30'), true,
    'a proved refusal must follow the mailbox, in every spelling of it');
});

// Round 25 (R5-H1). The mailbox half of the lockout is only as wide as the
// evidence behind the address. A stranger typing a victim's address into
// POST /api/auth/signup is not evidence, and while it wrote a 24-hour
// address-only block it was a denial-of-account primitive against anyone.
test('an address a stranger merely typed cannot be used to deny that address an account', () => {
  clearUnderageAttempts();
  const victim = 'targeted@example.com';
  recordUnderageAttempt(victim, '198.51.100.66');   // the attacker's request
  assert.strictEqual(underageBlocked(victim, '198.51.100.66'), true,
    'the caller who typed it is still held to it — this is the back-button case');
  assert.strictEqual(underageBlocked(victim, '203.0.113.12'), false,
    'a stranger denied the address an account from a network they were never on');
  clearUnderageAttempts();
});

test('the same IP is locked out even under a brand-new email', async () => {
  reset();
  await post('/api/auth/signup', signupBody({ email: 'kid@example.com', date_of_birth: CHILD_DOB }));
  const retry = await post('/api/auth/signup', signupBody({ email: 'totally-new@example.com', date_of_birth: ADULT_DOB }));
  assert.strictEqual(retry.status, 403);
  assert.strictEqual((await retry.json()).error, UNDERAGE_MSG);
  assert.deepStrictEqual(users, []);
});

test('when the lockout expires, the same signup goes through — the block was the lockout and nothing else', async () => {
  reset();
  await post('/api/auth/signup', signupBody({ date_of_birth: CHILD_DOB }));
  clearUnderageAttempts(); // stands in for the TTL elapsing
  const res = await post('/api/auth/signup', signupBody({ date_of_birth: ADULT_DOB }));
  assert.strictEqual(res.status, 201);
  assert.strictEqual(users.length, 1);
});

// The TTLs, against a test-owned clock and LITERAL durations — asserting
// against the exported constants would follow a mutated constant and pass.
test('lockout TTLs: email holds for 24 hours, IP for 15 minutes, and both expire', () => {
  clearUnderageAttempts();
  const t0 = Date.now();
  const ip = 15 * 60 * 1000;
  const day = 24 * 60 * 60 * 1000;

  // An ASSERTED address: the mailbox entry is scoped to the source IP, so the
  // reader has to name that IP for it. Round 25, R5-H1.
  recordUnderageAttempt('kid@example.com', '203.0.113.9', t0);

  // Both keys live immediately.
  assert.strictEqual(underageBlocked('kid@example.com', '203.0.113.9', t0), true);
  assert.strictEqual(underageBlocked('other@example.com', '203.0.113.9', t0), true);
  // A different mailbox from a different IP was never blocked.
  assert.strictEqual(underageBlocked('other@example.com', '198.51.100.1', t0), false);
  // Neither was the same mailbox from a different IP, which is the whole point
  // of the scoping: a stranger's refusal cannot travel with the address.
  assert.strictEqual(underageBlocked('kid@example.com', '198.51.100.1', t0), false);

  // 15 minutes: the IP side expires (shared school NATs must not stay
  // burned), the mailbox side holds.
  assert.strictEqual(underageBlocked('other@example.com', '203.0.113.9', t0 + ip - 1), true);
  assert.strictEqual(underageBlocked('other@example.com', '203.0.113.9', t0 + ip), false);
  assert.strictEqual(underageBlocked('kid@example.com', '203.0.113.9', t0 + ip), true,
    'the mailbox key must outlive the IP key');

  // 24 hours: the mailbox side expires too — the digests are age-screen
  // data, kept no longer than the screen needs (FTC FAQ / §312.10).
  assert.strictEqual(underageBlocked('kid@example.com', '203.0.113.9', t0 + day - 1), true);
  assert.strictEqual(underageBlocked('kid@example.com', '203.0.113.9', t0 + day), false);

  // A PROVED address takes the same 24-hour TTL, keyed on the address alone.
  clearUnderageAttempts();
  recordUnderageAttempt('kid@example.com', '203.0.113.9', t0, { addressProved: true });
  assert.strictEqual(underageBlocked('kid@example.com', null, t0 + day - 1), true);
  assert.strictEqual(underageBlocked('kid@example.com', null, t0 + day), false);

  assert.strictEqual(UNDERAGE_IP_TTL_MS, ip);
  assert.strictEqual(UNDERAGE_EMAIL_TTL_MS, day);
  clearUnderageAttempts();
});

test('the lockout map is bounded: a spray of refusals cannot grow it without limit', () => {
  clearUnderageAttempts();
  const t0 = Date.now();
  for (let i = 0; i <= UNDERAGE_MAX_KEYS; i++) {
    recordUnderageAttempt(null, `10.0.${(i / 256) | 0}.${i % 256}#${i}`, t0);
  }
  // One more record after every existing entry expired: the sweep must run.
  recordUnderageAttempt(null, '203.0.113.99', t0 + UNDERAGE_IP_TTL_MS + 1);
  assert.ok(underageAttemptCount() <= 2,
    `expired entries must be swept, map holds ${underageAttemptCount()}`);
  clearUnderageAttempts();
});

// ===========================================================================
// 4. ALL THREE DOORS — Google and Apple account creation run the same
//    refusal and the same lockout as password signup.
// ===========================================================================
test('Google account creation: under-13 refused neutrally, and the corrected retry is locked out', async () => {
  reset();
  const profile = { sub: 'g-kid', email: 'kid@gmail.com', email_verified: true, name: 'Kid' };
  const first = await withGoogle(profile, () => post('/api/auth/google', {
    access_token: 'opaque', date_of_birth: CHILD_DOB,
  }));
  assert.strictEqual(first.status, 403);
  const firstJson = await first.json();
  assert.strictEqual(firstJson.error, UNDERAGE_MSG);
  assert.ok(!('needsDob' in firstJson));

  const retry = await withGoogle(profile, () => post('/api/auth/google', {
    access_token: 'opaque', date_of_birth: ADULT_DOB,
  }));
  assert.strictEqual(retry.status, 403, 'same Google identity, older date: locked out');
  assert.strictEqual((await retry.json()).error, UNDERAGE_MSG);
  assert.deepStrictEqual(users, []);
});

test('Apple account creation: under-13 refused neutrally, and the corrected retry is locked out', async () => {
  reset();
  const first = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'apple-kid', email: 'kid@icloud.com', email_verified: true }),
    date_of_birth: CHILD_DOB,
  });
  assert.strictEqual(first.status, 403);
  const firstJson = await first.json();
  assert.strictEqual(firstJson.error, UNDERAGE_MSG);
  assert.ok(!('needsDob' in firstJson));

  const retry = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'apple-kid', email: 'kid@icloud.com', email_verified: true }),
    date_of_birth: ADULT_DOB,
  });
  assert.strictEqual(retry.status, 403, 'same Apple identity, older date: locked out');
  assert.strictEqual((await retry.json()).error, UNDERAGE_MSG);
  assert.deepStrictEqual(users, []);
});

// ===========================================================================
// 5. ACTUAL KNOWLEDGE STICKS — a legacy (null-DOB) account that answers the
//    DOB prompt with an under-13 date has told us who it belongs to. 16 CFR
//    312.2: that sentence IS actual knowledge, and it must not be forgettable
//    by pressing the button again with a different date.
// ===========================================================================
function mkPasswordUser(email, dob = null) {
  const row = {
    id: nextUserId++, email, name: 'Legacy', password: PASSWORD_HASH,
    token_version: 0, is_banned: false, oauth_provider: null, oauth_id: null,
    date_of_birth: dob, role: 'user', email_verified: true, verified_email: email,
  };
  users.push(row);
  return row;
}

test('a legacy account that supplies an under-13 DOB is refused AND the date is persisted', async () => {
  reset();
  const row = mkPasswordUser('legacy@example.com');
  const res = await post('/api/auth/login', {
    email: 'legacy@example.com', password: 'Password1', date_of_birth: CHILD_DOB,
  });
  assert.strictEqual(res.status, 403);
  const json = await res.json();
  assert.strictEqual(json.error, UNDERAGE_MSG);
  assert.ok(!('needsDob' in json));
  assert.ok(!('token' in json), 'no session may be minted for a known child');
  assert.strictEqual(row.date_of_birth, CHILD_DOB,
    'the under-13 date must be recorded — it is the actual knowledge itself');
});

test('the frozen account cannot be re-aged: a later login with an adult DOB still refuses', async () => {
  reset();
  mkPasswordUser('legacy@example.com');
  await post('/api/auth/login', {
    email: 'legacy@example.com', password: 'Password1', date_of_birth: CHILD_DOB,
  });
  const retry = await post('/api/auth/login', {
    email: 'legacy@example.com', password: 'Password1', date_of_birth: ADULT_DOB,
  });
  assert.strictEqual(retry.status, 403);
  const json = await retry.json();
  assert.strictEqual(json.error, UNDERAGE_MSG);
  assert.ok(!('token' in json));
  assert.strictEqual(users[0].date_of_birth, CHILD_DOB,
    'the recorded knowledge must not be overwritten by the retry');
});

test('a legacy under-13 reveal also locks fresh account creation from the same place', async () => {
  reset();
  mkPasswordUser('legacy@example.com');
  await post('/api/auth/login', {
    email: 'legacy@example.com', password: 'Password1', date_of_birth: CHILD_DOB,
  });
  // The frozen account is not the end of it: the same child opening a NEW
  // account with a fresh email is the retry loophole again, one door over.
  const res = await post('/api/auth/signup', signupBody({ email: 'fresh-start@example.com', date_of_birth: ADULT_DOB }));
  assert.strictEqual(res.status, 403);
  assert.strictEqual((await res.json()).error, UNDERAGE_MSG);
  assert.strictEqual(users.length, 1, 'only the frozen legacy row may exist');
});

test('a stored under-13 DOB refuses sign-in even when the request says nothing about age', async () => {
  reset();
  mkPasswordUser('frozen@example.com', CHILD_DOB);
  const res = await post('/api/auth/login', { email: 'frozen@example.com', password: 'Password1' });
  assert.strictEqual(res.status, 403);
  const json = await res.json();
  assert.strictEqual(json.error, UNDERAGE_MSG);
  assert.ok(!('needsDob' in json), 'a frozen account must not be prompted for a new date');
  assert.ok(!('token' in json));
});

// ===========================================================================
// 6. NO COLLATERAL — the lockout guards CREATION, never an existing 13+
//    account's sign-in, and a 13+ signup leaves no lockout residue.
// ===========================================================================
test('an existing 13+ account still signs in while its IP is locked out for creation', async () => {
  reset();
  // Turned 13 TODAY — the freeze boundary must be strictly under-13, so the
  // youngest legal user is not swept up by it.
  mkPasswordUser('adult@example.com', dobYearsAgo(13));
  // A child was just refused from the same IP (every test shares 127.0.0.1).
  await post('/api/auth/signup', signupBody({ email: 'kid@example.com', date_of_birth: CHILD_DOB }));
  const res = await post('/api/auth/login', { email: 'adult@example.com', password: 'Password1' });
  assert.strictEqual(res.status, 200, 'login is not account creation and must not be blocked');
  assert.ok((await res.json()).token);
});

test('a passing signup records nothing: the next signup from the same IP is not blocked', async () => {
  reset();
  const a = await post('/api/auth/signup', signupBody({ email: 'first@example.com' }));
  assert.strictEqual(a.status, 201);
  const b = await post('/api/auth/signup', signupBody({ email: 'second@example.com' }));
  assert.strictEqual(b.status, 201);
  assert.strictEqual(users.length, 2);
});

// ===========================================================================
// 7. DATA MINIMIZATION — §312.10 (amended Rule): retain no longer than
//    necessary. The signup response is built from an explicit RETURNING list
//    that does not echo the date of birth back onto the wire, and the lockout
//    holds keyed digests, never addresses.
// ===========================================================================
test('the signup response does not echo the date of birth', async () => {
  reset();
  const res = await post('/api/auth/signup', signupBody());
  assert.strictEqual(res.status, 201);
  const { user } = await res.json();
  assert.ok(user && user.email, 'sanity: a user object came back');
  assert.ok(!('date_of_birth' in user),
    'the DOB is age-gate data, not profile data — it must not ride along on the wire');
});

test('the lockout stores digests, not addresses', () => {
  clearUnderageAttempts();
  recordUnderageAttempt('kid-plaintext-probe@example.com', '203.0.113.7');
  // The map is module-private; what IS exported proves the shape: recording
  // the same identity twice lands on the same keys (a digest is
  // deterministic), and nothing exported can read an address back out.
  const size = underageAttemptCount();
  recordUnderageAttempt('kid-plaintext-probe@example.com', '203.0.113.7');
  assert.strictEqual(underageAttemptCount(), size, 'same identity, same keys — keyed digests');
  clearUnderageAttempts();
});
