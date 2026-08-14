// Run: node --test  (from backend/)
//
// ===========================================================================
// EVERY FIELD ON THE AUTH ROUTER HAS A MAXIMUM OF ITS OWN
// ===========================================================================
//
// __tests__/fieldBounds.test.js asked this question of routes/users.js,
// routes/venueProfile.js and routes/revenuecat.js. It did not ask it of
// routes/auth.js, which is the UNAUTHENTICATED router: not one field on it
// carried a width, so the JSON parser in server.js was the only ceiling on all
// of them, and that is a bound living in another file that moves whenever
// somebody tunes an unrelated number there.
//
// The live one it left open: `body('email').isEmail().normalizeEmail()` writing
// to users.email VARCHAR(255). "normalizeEmail can only shorten" is false —
// isEmail allows a UTF-8 local part and caps it at 64 BYTES, and lowercasing
// U+0130 yields two code points, so a 254-code-point address that passes every
// check becomes 286 on its way to the column. routes/users.js proved that on its
// own copy of the field; the reproduction is repeated here against signup.
//
// HOW IT ASSERTS
//
// Every ceiling is READ OUT OF routes/auth.js, never retyped. Each field is
// driven over real HTTP at its declared maximum (accepted) and one past it
// (refused, before any query). So this file does not encode "255"; it encodes
// "whatever routes/auth.js says MAX_EMAIL is, that is the largest address signup
// takes". Raise a constant and this file follows it. Delete one, or stop
// enforcing it, and this file fails.
//
// Three nets sit on top of the per-field cases:
//
//   * THE FIELD CENSUS. Every body() field routes/auth.js declares is extracted
//     from its source and must appear in the probe table. A field added without
//     a bound cannot pass unnoticed.
//   * THE 8000-CHARACTER PROBE. bodyLimitAudit.test.js fails any route declaring
//     an isLength max above 8000 (its CEILING, read out of that file rather than
//     copied), so a field that ACCEPTS a value that long has no maximum at all.
//   * THE AGREEMENT TEST. routes/users.js writes the same columns from the
//     authenticated side. Its numbers and this router's must be the same
//     numbers, and its interests rule and this one must be the same rule.
//
// No database: pool.query is a fixture, and every statement is logged, so
// "refused before any query" is a fact rather than a hope.

// Env must be set before ANY require.
process.env.JWT_SECRET = 'auth-field-bounds-test-secret';
process.env.GOOGLE_CLIENT_ID = 'flock-test.apps.googleusercontent.com';
process.env.PUBLIC_WEB_URL = 'http://localhost:3000';
process.env.PUBLIC_API_URL = 'http://localhost:5000';
process.env.REVENUECAT_WEBHOOK_SECRET = 'rc-webhook-test-secret';
delete process.env.RESEND_API_KEY;      // mail becomes a skip, never a network call
delete process.env.APPLE_REQUIRE_NONCE;
delete process.env.NODE_ENV;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const BACKEND = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(BACKEND, rel), 'utf8');

// ---------------------------------------------------------------------------
// 0. Module stubs, installed in the require cache BEFORE routes/auth.js loads
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

// Apple's server-to-server config stays UNconfigured, so authorizationCode is
// optional and no code exchange is attempted.
const appleAuthPath = require.resolve('../services/appleAuth');
require.cache[appleAuthPath] = {
  id: appleAuthPath, filename: appleAuthPath, loaded: true,
  exports: {
    isConfigured: () => false,
    exchangeAppleCode: async () => ({}),
    revokeAppleToken: async () => {},
  },
};

// Google's ID token verifier. The payload is whatever the test sets, which is
// how the provider-supplied display name (a value NO validator chain on this
// router ever sees) can be driven at a real width.
let googlePayload = null;
const googleLibPath = require.resolve('google-auth-library');
require.cache[googleLibPath] = {
  id: googleLibPath, filename: googleLibPath, loaded: true,
  exports: {
    OAuth2Client: class {
      async verifyIdToken() {
        if (!googlePayload) throw new Error('Invalid token');
        return { getPayload: () => googlePayload };
      }
    },
  },
};

const appleIdentityToken = (claims) => jwt.sign(
  { iss: 'https://appleid.apple.com', aud: 'com.flockcorp.flock', ...claims },
  APPLE_PRIV,
  { algorithm: 'RS256', expiresIn: '10m', keyid: 'test-kid' }
);

// ---------------------------------------------------------------------------
// 1. The ceilings, read out of the route that owns them
// ---------------------------------------------------------------------------
const pool = require('../config/database');
const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', role: 'user', email: 'ava@example.com', email_verified: true };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };
authMod.authenticateAllowBanned = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const authRouter = require('../routes/auth');
const revenuecatRouter = require('../routes/revenuecat');
const A = authRouter.__testing;

const REQUIRED_BOUNDS = [
  'MAX_EMAIL', 'MAX_OAUTH_ID', 'MAX_NAME', 'MAX_PASSWORD', 'MAX_INTERESTS',
  'MAX_INTEREST_LEN', 'MAX_DOB_LENGTH', 'MAX_LINK_TOKEN', 'MAX_OAUTH_TOKEN',
  'MAX_OAUTH_ACCESS_TOKEN',
];

test('routes/auth.js still declares every bound this file drives', () => {
  const src = read('routes/auth.js');
  for (const name of REQUIRED_BOUNDS) {
    const m = new RegExp(`const ${name} = (\\d+);`).exec(src);
    assert.ok(m, `routes/auth.js must still declare ${name} — this audit is driven from it`);
    assert.equal(A[name], Number(m[1]),
      `${name} is exported as ${A[name]} and declared as ${m[1]}`);
  }
});

// ---------------------------------------------------------------------------
// 2. The column widths those ceilings claim to come from
// ---------------------------------------------------------------------------
function usersColumnWidth(column) {
  const src = read('migrations/000_bootstrap.sql');
  const table = /CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\);/.exec(src);
  assert.ok(table, 'migrations/000_bootstrap.sql must still create the users table');
  const m = new RegExp(`\\n\\s*${column} VARCHAR\\((\\d+)\\)`).exec(table[1]);
  assert.ok(m, `users.${column} must still be a VARCHAR in migrations/000_bootstrap.sql`);
  return Number(m[1]);
}

test('the auth ceilings are the column widths they say they are', () => {
  assert.equal(A.MAX_EMAIL, usersColumnWidth('email'), 'MAX_EMAIL must be users.email\'s width');
  assert.equal(A.MAX_NAME, usersColumnWidth('name'), 'MAX_NAME must be users.name\'s width');
  // oauth_id arrives with migration 001 rather than the bootstrap.
  const m = /ALTER TABLE users ADD COLUMN IF NOT EXISTS oauth_id VARCHAR\((\d+)\)/
    .exec(read('migrations/001_baseline.sql'));
  assert.ok(m, 'users.oauth_id must still be a VARCHAR in migrations/001_baseline.sql');
  assert.equal(A.MAX_OAUTH_ID, Number(m[1]), 'MAX_OAUTH_ID must be users.oauth_id\'s width');
});

// ---------------------------------------------------------------------------
// 3. AGREEMENT WITH routes/users.js
// ---------------------------------------------------------------------------
// The two routers write the same columns from opposite sides of the auth
// boundary. A second set of numbers would be a second answer to one question,
// and the interests rule in particular was COPIED rather than imported (see the
// note above it in routes/auth.js), so nothing but this test keeps the copy
// honest.
test('the bounds this router shares with routes/users.js are the same numbers', () => {
  const usersSrc = read('routes/users.js');
  const usersConst = (name) => {
    const m = new RegExp(`const ${name} = (\\d+);`).exec(usersSrc);
    assert.ok(m, `routes/users.js must still declare ${name}`);
    return Number(m[1]);
  };
  for (const [here, there] of [
    ['MAX_EMAIL', 'MAX_EMAIL'],
    ['MAX_NAME', 'MAX_NAME'],
    ['MAX_PASSWORD', 'MAX_PASSWORD'],
    ['MAX_INTERESTS', 'MAX_INTERESTS'],
    ['MAX_INTEREST_LEN', 'MAX_INTEREST_LEN'],
  ]) {
    assert.equal(A[here], usersConst(there),
      `routes/auth.js ${here} is ${A[here]} and routes/users.js ${there} is ${usersConst(there)}. `
      + 'Both write the same column; they cannot disagree about how wide it is.');
  }
});

test('the interests rule is the same rule on both routers, clause for clause', () => {
  // Not a string comparison of the whole block (the comments above them differ
  // and should): the four decisions the rule makes, each read out of both files.
  const body = (rel) => {
    const src = read(rel);
    const at = src.indexOf("const interestsRule = body('interests')");
    assert.ok(at > 0, `${rel} must still declare interestsRule`);
    return src.slice(at, src.indexOf('});', at) + 3);
  };
  const here = body('routes/auth.js');
  const there = body('routes/users.js');
  for (const clause of [
    "optional({ nullable: true })",
    'if (!Array.isArray(v)) throw new Error',
    'if (v.length > MAX_INTERESTS) throw new Error',
    "if (typeof item !== 'string') throw new Error",
    'if (item.length > MAX_INTEREST_LEN) {',
  ]) {
    assert.ok(here.includes(clause), `routes/auth.js interestsRule lost: ${clause}`);
    assert.ok(there.includes(clause), `routes/users.js interestsRule lost: ${clause}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Fixtures: a pool that answers, and a log of every statement
// ---------------------------------------------------------------------------
let handlers = [];
let log = [];

function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params: params || [] });
  for (const [re, fn] of handlers) {
    if (re.test(flat)) {
      const out = fn(params || [], flat);
      return Promise.resolve(out === undefined ? { rows: [], rowCount: 0 } : out);
    }
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}
pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({
  query: (sql, params) => dispatch(sql, params),
  release: () => {},
});

// The upstream calls the Google access_token branch makes. Recorded rather than
// performed, so "refused before it left the process" is checkable. Only Google's
// hosts are intercepted — this file's own requests to its test server go through
// the real fetch, or `call()` below would be talking to the recorder.
let fetched = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (/googleapis\.com/.test(u)) {
    fetched.push(u);
    return { ok: false, status: 401, json: async () => ({}) };
  }
  return realFetch(url, init);
};

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api/revenuecat', revenuecatRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  handlers = [];
  log = [];
  fetched = [];
  googlePayload = null;
});

async function call(method, pathname, body, headers = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

const noQueries = () => log.map((q) => q.sql);
const writes = () => log.filter((q) => /^(INSERT|UPDATE|DELETE)/i.test(q.sql));
const paramsSeen = () => log.flatMap((q) => q.params || []);

// A signup that gets all the way to the INSERT unless a validator stops it.
const SIGNUP_INSERT = /^INSERT INTO users/;
function scriptSignup() {
  handlers = [
    [/FROM banned_identities/, () => ({ rows: [] })],
    [/^SELECT \* FROM users/, () => ({ rows: [] })],
    [SIGNUP_INSERT, (params) => ({
      rows: [{
        id: 77, email: params[0], name: params[2], phone: null, interests: params[3],
        role: 'user', profile_image_url: null, email_verified: false, created_at: new Date(),
      }],
    })],
    [/FROM email_verifications WHERE user_id/, () => ({
      rows: [{ account_hour: 0, account_day: 0, account_last: null, ip_hour: 0 }],
    })],
    [/^UPDATE email_verifications SET used_at/, () => ({ rows: [], rowCount: 0 })],
    [/^INSERT INTO email_verifications/, () => ({ rows: [], rowCount: 1 })],
  ];
}
const signupInsert = () => log.find((q) => SIGNUP_INSERT.test(q.sql));

// ---------------------------------------------------------------------------
// 5. Padding that is inert on every screen these routes run
// ---------------------------------------------------------------------------
// NOT 'x': "xxx" is on content-checker's wordlist, so a probe padded with it
// comes back 400 for PROFANITY and measures the wordlist instead of a length.
const { moderateText } = require('../utils/moderation');
const { stripHtml } = require('../utils/sanitize');
const PAD_CHAR = 'a';
const pad = (n, ch = PAD_CHAR) => ch.repeat(n);

test('the padding these probes are built from is not itself refused', () => {
  assert.equal(moderateText(pad(300)).allowed, true,
    `"${PAD_CHAR}" repeated is screened as profanity, so every probe below would be measuring the wordlist`);
  assert.equal(stripHtml(pad(300)), pad(300),
    'the padding must survive stripHtml, or an "at the ceiling" probe is shorter than it claims');
  assert.equal(moderateText('x'.repeat(300)).allowed, false,
    'if "xxx" stops being profanity this note can go, but do not reintroduce it as padding on a hunch');
});

// A syntactically valid address of EXACTLY n characters. Domain labels are
// capped at 63 by the spec and by validator.js, so the domain is several of them.
function emailOfLength(n) {
  const local = pad(20);
  let domain = '';
  let remaining = n - local.length - 1; // minus '@'
  const tld = '.com';
  remaining -= tld.length;
  assert.ok(remaining > 0, `cannot build an address of ${n} characters`);
  while (remaining > 0) {
    const chunk = Math.min(remaining, 63);
    domain += pad(chunk);
    remaining -= chunk;
    if (remaining > 0) { domain += '.'; remaining -= 1; }
  }
  const addr = `${local}@${domain}${tld}`;
  assert.equal(addr.length, n);
  return addr;
}

// ---------------------------------------------------------------------------
// 6. THE CENSUS: no field on this router escapes this file
// ---------------------------------------------------------------------------
const PROBED_FIELDS = new Set([
  'email', 'password', 'name', 'interests', 'date_of_birth',
  'token', 'credential', 'access_token', 'identityToken', 'fullName',
  'authorizationCode', 'nonce',
]);

test('every field routes/auth.js declares is one this file bounds', () => {
  const src = read('routes/auth.js');
  // The negative lookbehind is not decoration: without it `pool.query('DELETE
  // FROM …')` reads as a field called "DELETE FROM …". express-validator's
  // body()/query() are bare calls; every pool query is a method call.
  const declared = new Set(
    [...src.matchAll(/(?<![.\w])(?:body|query)\('([A-Za-z_][A-Za-z0-9_]*)'\)/g)].map((m) => m[1])
  );
  for (const field of declared) {
    assert.ok(PROBED_FIELDS.has(field),
      `routes/auth.js accepts "${field}" and this file does not bound it. `
      + 'Give it a maximum of its own, then probe it here.');
  }
  for (const field of PROBED_FIELDS) {
    assert.ok(declared.has(field),
      `routes/auth.js no longer declares "${field}"; remove its probe or restore the field`);
  }
});

// The census says a field is PROBED. These two say the RULE is the same rule
// everywhere the field appears — which is the part a probe cannot see, because a
// route whose bound is enforced somewhere downstream (parseVerificationToken
// refuses a wide token whether or not the chain does) answers identically with
// the rule and without it. Spelling drift is how one of four copies loses its
// bound and nothing goes red.
test('every address this router takes is measured on BOTH sides of normalizeEmail', () => {
  const src = read('routes/auth.js');
  // Each `body('email')` chain, from the call to the end of the statement.
  const chains = [...src.matchAll(/body\('email'\)([\s\S]*?),\r?\n/g)].map((m) => m[1]);
  assert.equal(chains.length, 3,
    `expected the three address-taking routes (signup, login, forgot-password), found ${chains.length}`);
  for (const chain of chains) {
    const before = chain.indexOf('normalizeEmail()');
    assert.ok(before > 0, `an email chain lost normalizeEmail(): ${chain.slice(0, 80)}`);
    assert.ok(/isLength\(\{ max: MAX_EMAIL \}\)/.test(chain.slice(0, before)),
      'an email chain does not measure the raw address, so a 64KB string reaches isEmail\'s regex');
    assert.ok(/isLength\(\{ max: MAX_EMAIL \}\)/.test(chain.slice(before)),
      'an email chain does not measure the NORMALIZED address, which is the one that reaches the column. '
      + 'normalizeEmail can LENGTHEN — see the U+0130 case below.');
  }
});

test('every link token this router takes carries the same width', () => {
  const src = read('routes/auth.js');
  const chains = [...src.matchAll(/body\('token'\)([\s\S]*?),\r?\n/g)].map((m) => m[1]);
  assert.equal(chains.length, 3,
    `expected the three token-taking routes (verify-email, reset-password, its check), found ${chains.length}`);
  for (const chain of chains) {
    assert.ok(/isLength\(\{ max: MAX_LINK_TOKEN \}\)/.test(chain),
      `a token chain has no width of its own: ${chain.slice(0, 80)}`);
  }
  // And the check route READS its chain. It made its own typeof test and never
  // called validationResult, so a rule declared there was decoration.
  const at = src.indexOf("router.post('/reset-password/check'");
  assert.ok(at > 0, 'the reset check route moved');
  assert.match(src.slice(at, at + 1400), /const errors = validationResult\(req\);/,
    'POST /reset-password/check declares a chain and must consult it');
});

test('the body fields this router reads by hand are bounded too', () => {
  const src = read('routes/auth.js');
  // date_of_birth reaches /login, /google and /apple with NO chain at all — it
  // is read straight off the body by suppliedDob, which is where its width has
  // to be settled.
  assert.match(src, /if \(trimmed\.length > MAX_DOB_LENGTH\) return null;/,
    'suppliedDob is the only gate on date_of_birth for /login, /google and /apple; it must measure it');
  // GET /verify-email takes its token from the query string.
  assert.match(src, /if \(t\.length < 40 \|\| t\.length > MAX_LINK_TOKEN\) return null;/,
    'parseVerificationToken is what bounds the token GET /verify-email reads from the query string');
});

// ---------------------------------------------------------------------------
// 7. THE 8000-CHARACTER PROBE
// ---------------------------------------------------------------------------
const UNBOUNDED_PROBE = (() => {
  const src = read('__tests__/bodyLimitAudit.test.js');
  const at = src.indexOf('no route has grown a free-text field');
  assert.ok(at > 0, 'bodyLimitAudit.test.js must still cap the widest declared field');
  const m = /const CEILING = (\d+);/.exec(src.slice(at));
  assert.ok(m, 'bodyLimitAudit.test.js must still declare its free-text CEILING');
  return Number(m[1]);
})();

// The two values this file writes to a bounded column WITHOUT a chain in front
// of them, because they arrive inside a signed provider token: the address and
// the provider's user id. Not attacker-reachable, and still the difference
// between a 400 and a 22001 on an unauthenticated route.
test('a provider identity wider than its column is refused, not inserted', async () => {
  handlers = [
    [/oauth_provider = 'apple' AND oauth_id/, () => ({ rows: [] })],
    [/FROM banned_identities/, () => ({ rows: [] })],
    [/^SELECT \* FROM users/, () => ({ rows: [] })],
    [/^INSERT INTO users/, () => ({ rows: [{ id: 93 }] })],
  ];
  const over = await call('POST', '/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: pad(A.MAX_OAUTH_ID + 1), email: 'x@example.com', email_verified: true }),
    date_of_birth: '2000-01-01',
  });
  assert.equal(over.status, 400, over.text);
  assert.deepEqual(writes().map((q) => q.sql), [],
    'a sub wider than users.oauth_id reached a write');

  log = [];
  const okSub = await call('POST', '/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: pad(A.MAX_OAUTH_ID), email: 'y@example.com', email_verified: true }),
    date_of_birth: '2000-01-01',
  });
  assert.equal(okSub.status, 200, `a sub AT the column width must still sign in: ${okSub.text}`);

  // The address half, on the same path. Apple's is stored verbatim when it
  // gives one and constructed from the sub when it does not, and users.email is
  // the column that decides who an account IS.
  log = [];
  const wideEmail = await call('POST', '/api/auth/apple', {
    identityToken: appleIdentityToken({
      sub: 'apple-sub-wide-email',
      email: emailOfLength(A.MAX_EMAIL + 1),
      email_verified: true,
    }),
    date_of_birth: '2000-01-01',
  });
  assert.equal(wideEmail.status, 400, wideEmail.text);
  assert.deepEqual(writes().map((q) => q.sql), [],
    'an address wider than users.email reached a write on the Apple path');
});

test('a Google identity wider than its column is refused, not inserted', async () => {
  const scriptGoogle = () => {
    handlers = [
      [/oauth_provider = 'google' AND oauth_id/, () => ({ rows: [] })],
      [/FROM banned_identities/, () => ({ rows: [] })],
      [/^SELECT \* FROM users/, () => ({ rows: [] })],
      [/^INSERT INTO users/, () => ({ rows: [{ id: 94 }] })],
    ];
  };

  scriptGoogle();
  googlePayload = {
    sub: 'google-sub-wide-email',
    email: emailOfLength(A.MAX_EMAIL + 1),
    email_verified: true,
    name: 'Gina',
  };
  const wideEmail = await call('POST', '/api/auth/google', { credential: 'a.b.c', date_of_birth: '2000-01-01' });
  assert.equal(wideEmail.status, 400, wideEmail.text);
  assert.deepEqual(writes().map((q) => q.sql), [],
    'an address wider than users.email reached a write on the Google path');

  scriptGoogle();
  log = [];
  googlePayload = {
    sub: pad(A.MAX_OAUTH_ID + 1),
    email: 'gina@example.com',
    email_verified: true,
    name: 'Gina',
  };
  const wideSub = await call('POST', '/api/auth/google', { credential: 'a.b.c', date_of_birth: '2000-01-01' });
  assert.equal(wideSub.status, 400, wideSub.text);
  assert.deepEqual(writes().map((q) => q.sql), [],
    'a sub wider than users.oauth_id reached a write on the Google path');
});

test('the probe is larger than every ceiling this route declares', () => {
  for (const name of REQUIRED_BOUNDS) {
    if (name === 'MAX_PASSWORD' || name === 'MAX_OAUTH_TOKEN') continue;
    assert.ok(A[name] < UNBOUNDED_PROBE,
      `${name} is ${A[name]}, at or past the ${UNBOUNDED_PROBE}-character probe`);
  }
  // These two are deliberately generous — the password so no existing one is
  // locked out, the OAuth token so a provider can grow its claim set — so they
  // get their own boundary cases below rather than the shared probe.
  assert.ok(A.MAX_PASSWORD < UNBOUNDED_PROBE * 2);
  assert.ok(A.MAX_OAUTH_TOKEN < UNBOUNDED_PROBE * 2);
});

const OVERSIZED = pad(UNBOUNDED_PROBE);

test('no field on the auth router accepts an 8000-character value', async () => {
  const DOB = '2000-01-01';
  const cases = [
    ['POST', '/api/auth/signup', { email: `${OVERSIZED}@example.com`, password: 'Password1', name: 'Sam', date_of_birth: DOB }],
    ['POST', '/api/auth/signup', { email: 'new@example.com', password: `Aa1${OVERSIZED}`, name: 'Sam', date_of_birth: DOB }],
    ['POST', '/api/auth/signup', { email: 'new@example.com', password: 'Password1', name: OVERSIZED, date_of_birth: DOB }],
    ['POST', '/api/auth/signup', { email: 'new@example.com', password: 'Password1', name: 'Sam', date_of_birth: DOB, interests: [OVERSIZED] }],
    ['POST', '/api/auth/signup', { email: 'new@example.com', password: 'Password1', name: 'Sam', date_of_birth: `2000-01-01T00:00:00.${pad(UNBOUNDED_PROBE, '0')}Z` }],
    ['POST', '/api/auth/login', { email: `${OVERSIZED}@example.com`, password: 'Password1' }],
    ['POST', '/api/auth/login', { email: 'ava@example.com', password: OVERSIZED }],
    ['POST', '/api/auth/forgot-password', { email: `${OVERSIZED}@example.com` }],
    ['POST', '/api/auth/reset-password', { token: OVERSIZED, password: 'Password1' }],
    // A WELL-FORMED token, deliberately: with a malformed one the route 400s on
    // the token whatever the password rule says, and the probe would be passing
    // for the wrong reason. With a real token the only thing that can stop this
    // before a query is the password's own width.
    ['POST', '/api/auth/reset-password', { token: A.mintVerificationToken().token, password: `Aa1${OVERSIZED}` }],
    ['POST', '/api/auth/verify-email', { token: OVERSIZED }],
    ['POST', '/api/auth/google', { credential: OVERSIZED }],
    ['POST', '/api/auth/google', { access_token: OVERSIZED }],
    ['POST', '/api/auth/apple', { identityToken: OVERSIZED }],
    ['POST', '/api/auth/apple', { identityToken: pad(60), nonce: OVERSIZED }],
    ['POST', '/api/auth/apple', { identityToken: pad(60), authorizationCode: OVERSIZED }],
    ['POST', '/api/auth/apple', { identityToken: pad(60), fullName: { givenName: OVERSIZED } }],
    ['POST', '/api/auth/apple', { identityToken: pad(60), fullName: { familyName: OVERSIZED } }],
  ];
  for (const [method, pathname, body] of cases) {
    scriptSignup();
    log = [];
    fetched = [];
    const res = await call(method, pathname, body);
    const label = `${method} ${pathname} ${JSON.stringify(body).slice(0, 60)}`;
    assert.equal(res.status, 400,
      `${label} -> ${res.status} ${res.text}. A field that takes ${UNBOUNDED_PROBE} characters has no `
      + 'maximum of its own; the JSON parser in server.js is its only bound.');
    assert.deepEqual(noQueries(), [], `${label}: reached the database anyway`);
    assert.deepEqual(fetched, [], `${label}: left the process anyway`);
  }
});

// /reset-password/check is the one route that answers a bad token with a 200 and
// a reason rather than a 400 — it reports three states and must not grow a
// fourth. The bound is still real: nothing runs.
test('an oversized token on the reset check is refused without a query', async () => {
  const res = await call('POST', '/api/auth/reset-password/check', { token: OVERSIZED });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.valid, false);
  assert.equal(res.body.reason, 'invalid');
  assert.deepEqual(noQueries(), [], 'an oversized token must not reach a query');
});

// ---------------------------------------------------------------------------
// 8. AT the ceiling, and one past it — driven from the route's own numbers
// ---------------------------------------------------------------------------

test('signup takes a password of exactly MAX_PASSWORD and refuses one more', async () => {
  const at = `Aa1${pad(A.MAX_PASSWORD - 3)}`;
  assert.equal(at.length, A.MAX_PASSWORD);
  scriptSignup();
  const ok = await call('POST', '/api/auth/signup',
    { email: 'new@example.com', password: at, name: 'Sam', date_of_birth: '2000-01-01' });
  assert.equal(ok.status, 201, ok.text);
  assert.ok(signupInsert(), 'the password at the ceiling must still create the account');

  scriptSignup();
  log = [];
  const over = await call('POST', '/api/auth/signup',
    { email: 'new@example.com', password: `${at}a`, name: 'Sam', date_of_birth: '2000-01-01' });
  assert.equal(over.status, 400, over.text);
  assert.deepEqual(noQueries(), [], 'one past the ceiling must be refused before any query');
});

test('the reset path carries the same password ceiling signup does', async () => {
  // A recovery flow that accepts a password signup would refuse is signup with
  // the rules switched off — in either direction. The token is well formed, so
  // "no query ran" can only be the password rule talking: a malformed token
  // stops the route before consumeReset either way, which is a test that passes
  // for the wrong reason.
  handlers = [[/FROM password_resets r/, () => ({ rows: [] })]];
  const over = await call('POST', '/api/auth/reset-password',
    { token: A.mintVerificationToken().token, password: `Aa1${pad(A.MAX_PASSWORD)}` });
  assert.equal(over.status, 400, over.text);
  assert.deepEqual(noQueries(), [], 'an oversized reset password must be refused before any query');

  // The control: the same token with a password INSIDE the ceiling does reach
  // the lookup, so the assertion above is about the width and nothing else.
  log = [];
  const inside = await call('POST', '/api/auth/reset-password',
    { token: A.mintVerificationToken().token, password: `Aa1${pad(A.MAX_PASSWORD - 3)}` });
  assert.equal(inside.status, 400, inside.text); // no such token in the fixture
  assert.ok(log.some((q) => /FROM password_resets r/.test(q.sql)),
    'a password inside the ceiling must get as far as the token lookup');
});

test('signup takes a date of birth of exactly MAX_DOB_LENGTH and refuses one more', async () => {
  // isISO8601 accepts unbounded fractional seconds, so this is a value that is a
  // perfectly good ISO 8601 instant AND wider than anything a DATE column wants.
  // Without the width rule the long one passes every content check on the chain.
  const frac = (n) => `2000-01-01T00:00:00.${pad(n, '0')}Z`;
  const atLength = A.MAX_DOB_LENGTH - '2000-01-01T00:00:00.Z'.length;
  const at = frac(atLength);
  assert.equal(at.length, A.MAX_DOB_LENGTH);

  scriptSignup();
  const ok = await call('POST', '/api/auth/signup',
    { email: 'new@example.com', password: 'Password1', name: 'Sam', date_of_birth: at });
  assert.equal(ok.status, 201, ok.text);

  scriptSignup();
  log = [];
  const over = await call('POST', '/api/auth/signup',
    { email: 'new@example.com', password: 'Password1', name: 'Sam', date_of_birth: frac(atLength + 1) });
  assert.equal(over.status, 400, over.text);
  assert.deepEqual(noQueries(), [], 'an oversized date of birth must be refused before any query');
});

// The one date_of_birth that has NO chain behind it: /login (and /google and
// /apple) read it straight off the body through suppliedDob. This spelling is
// both wider than MAX_DOB_LENGTH and parseable by `new Date()`, so the age gate
// is satisfied and the raw string is what reaches the DATE column — a 22007 and
// a 500, not a 400, unless suppliedDob measures it.
const LONG_PARSEABLE_DOB = '2000-01-01 00:00:00 GMT+0000 (Coordinated Universal Time)';

test('a wide but parseable date of birth never reaches the DATE column on login', () => {
  const { ageFromDob } = require('../utils/age');
  assert.ok(LONG_PARSEABLE_DOB.length > A.MAX_DOB_LENGTH, 'the probe must be past the bound');
  assert.ok(/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(LONG_PARSEABLE_DOB),
    'the probe must satisfy ISO_DATE_RE, or it proves nothing about the width check');
  assert.ok(Number.isInteger(ageFromDob(LONG_PARSEABLE_DOB)),
    'the probe must survive the age gate, or the 403 below could be the age gate talking');
  assert.equal(A.suppliedDob(LONG_PARSEABLE_DOB), null, 'suppliedDob must refuse it on width');
});

test('login refuses a wide date of birth instead of writing it', async () => {
  const hash = bcrypt.hashSync('Password1', 4);
  handlers = [
    [/^SELECT \* FROM users WHERE LOWER\(email\)/, () => ({
      rows: [{ id: 5, email: 'ava@example.com', password: hash, name: 'Ava', date_of_birth: null, token_version: 0 }],
    })],
    [/^UPDATE users SET date_of_birth/, () => ({ rows: [], rowCount: 1 })],
  ];
  const res = await call('POST', '/api/auth/login',
    { email: 'ava@example.com', password: 'Password1', date_of_birth: LONG_PARSEABLE_DOB });
  assert.equal(res.status, 403, res.text);
  assert.equal(res.body.needsDob, true, 'the account is asked for a date of birth it can store');
  assert.deepEqual(writes().map((q) => q.sql), [],
    'the oversized date of birth was written to the DATE column');
  for (const p of paramsSeen()) {
    assert.ok(!(typeof p === 'string' && p.length > A.MAX_DOB_LENGTH && /^\d{4}-/.test(p)),
      `a ${String(p).length}-character date reached pg as a parameter`);
  }

  // The control, and the boundary: a date of birth of EXACTLY MAX_DOB_LENGTH is
  // still stored. Without it the assertion above is satisfied by a rule that
  // refuses every timestamp spelling, which would 403 an honest client.
  const at = `2000-01-01T00:00:00.${pad(A.MAX_DOB_LENGTH - '2000-01-01T00:00:00.Z'.length, '0')}Z`;
  assert.equal(at.length, A.MAX_DOB_LENGTH);
  log = [];
  const ok = await call('POST', '/api/auth/login',
    { email: 'ava@example.com', password: 'Password1', date_of_birth: at });
  assert.equal(ok.status, 200, ok.text);
  const update = log.find((q) => /^UPDATE users SET date_of_birth/.test(q.sql));
  assert.ok(update, 'a date of birth at the ceiling must still be stored');
  assert.equal(update.params[0], at);
});

// ---------------------------------------------------------------------------
// 9. THE LIVE ONE: normalizeEmail LENGTHENS
// ---------------------------------------------------------------------------
// isEmail allows a UTF-8 local part by default and caps it at 64 BYTES.
// U+0130 (İ, dotted capital I) is two bytes, so 32 of them is a legal local
// part — 32 code points. Lowercasing İ yields TWO code points (i + U+0307), so
// the same local part is 64 code points once normalizeEmail has run. Put that in
// front of a long legal domain and a 254-code-point address that passes every
// check becomes 286 on its way to users.email VARCHAR(255).
test('an address that GROWS past the column when normalized is refused, not inserted', async () => {
  const local = 'İ'.repeat(32);
  assert.equal(Buffer.byteLength(local, 'utf8'), 64, 'the local part must be exactly isEmail\'s 64-byte cap');
  const domainLen = 254 - local.length - 1;
  let domain = '';
  let remaining = domainLen - '.com'.length;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 63);
    domain += pad(chunk);
    remaining -= chunk;
    if (remaining > 0) { domain += '.'; remaining -= 1; }
  }
  const addr = `${local}@${domain}.com`;
  assert.equal([...addr].length, 254, 'the probe must be inside every raw-length rule, or it proves nothing');
  assert.ok([...addr.toLowerCase()].length > A.MAX_EMAIL,
    'the probe must actually grow past the column, or this test cannot fail');

  scriptSignup();
  const res = await call('POST', '/api/auth/signup',
    { email: addr, password: 'Password1', name: 'Sam', date_of_birth: '2000-01-01' });
  assert.equal(res.status, 400,
    `an address that normalizes to ${[...addr.toLowerCase()].length} code points must be refused: ${res.text}`);
  assert.deepEqual(noQueries(), [],
    'it reached a query, which is the 22001 on the INSERT this bound exists to stop');
});

test('the widest address signup accepts still fits the column', async () => {
  // Measured, not assumed. isEmail caps the WHOLE address at 254, so the active
  // gate today is a number in node_modules and MAX_EMAIL is the backstop that
  // says what THIS route will accept. Either way the value that reaches the
  // column has to fit it.
  scriptSignup();
  const ok = await call('POST', '/api/auth/signup',
    { email: emailOfLength(254), password: 'Password1', name: 'Sam', date_of_birth: '2000-01-01' });
  assert.equal(ok.status, 201, ok.text);
  const insert = signupInsert();
  assert.ok(insert, 'the 254-character address never reached the INSERT');
  assert.ok(insert.params[0].length <= usersColumnWidth('email'),
    `the address reached pg at ${insert.params[0].length} characters, past users.email`);

  scriptSignup();
  log = [];
  const over = await call('POST', '/api/auth/signup',
    { email: emailOfLength(A.MAX_EMAIL + 1), password: 'Password1', name: 'Sam', date_of_birth: '2000-01-01' });
  assert.equal(over.status, 400, over.text);
  assert.deepEqual(noQueries(), [], 'an address past MAX_EMAIL must be refused before any query');
});

test('the name at the column width is stored, and one past it is refused', async () => {
  scriptSignup();
  const ok = await call('POST', '/api/auth/signup',
    { email: 'new@example.com', password: 'Password1', name: pad(A.MAX_NAME), date_of_birth: '2000-01-01' });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(signupInsert().params[2].length, A.MAX_NAME);

  scriptSignup();
  log = [];
  const over = await call('POST', '/api/auth/signup',
    { email: 'new@example.com', password: 'Password1', name: pad(A.MAX_NAME + 1), date_of_birth: '2000-01-01' });
  assert.equal(over.status, 400, over.text);
  assert.deepEqual(noQueries(), [], 'a name past the column width must be refused before any query');
});

test('the name rule and the column agree on what one character is', () => {
  // Postgres counts VARCHAR in characters, so MAX_NAME is only the column's
  // width if the rule enforcing it counts the same way. validator.js subtracts
  // surrogate pairs before measuring; if it ever stopped, a 128-emoji display
  // name would be refused as 256 characters and a byte-counting rule would
  // refuse a 64-emoji one. Checked against the library rather than assumed,
  // because clampName's code-point slice is built on the same premise.
  const validator = require('validator');
  const emoji = '🐦'.repeat(A.MAX_NAME);
  assert.equal(emoji.length, A.MAX_NAME * 2, 'the probe must be surrogate pairs, or it measures nothing');
  assert.equal(validator.isLength(emoji, { max: A.MAX_NAME }), true,
    'isLength stopped counting code points; MAX_NAME is no longer the column width');
  assert.equal(validator.isLength(`${emoji}🐦`, { max: A.MAX_NAME }), false);
});

test('a display name of MAX_NAME emoji is accepted and one more is not', async () => {
  scriptSignup();
  const ok = await call('POST', '/api/auth/signup',
    { email: 'new@example.com', password: 'Password1', name: '🐦'.repeat(A.MAX_NAME), date_of_birth: '2000-01-01' });
  assert.equal(ok.status, 201, ok.text);
  assert.equal([...signupInsert().params[2]].length, A.MAX_NAME);

  scriptSignup();
  log = [];
  const over = await call('POST', '/api/auth/signup',
    { email: 'new@example.com', password: 'Password1', name: '🐦'.repeat(A.MAX_NAME + 1), date_of_birth: '2000-01-01' });
  assert.equal(over.status, 400, over.text);
  assert.deepEqual(noQueries(), [], 'a name past the column width must be refused before any query');
});

// ---------------------------------------------------------------------------
// 10. interests: the array, its elements, and the screen they never had
// ---------------------------------------------------------------------------
const signupWith = (interests) => call('POST', '/api/auth/signup', {
  email: 'new@example.com', password: 'Password1', name: 'Sam',
  date_of_birth: '2000-01-01', interests,
});

test('signup takes MAX_INTERESTS interests and refuses one more', async () => {
  scriptSignup();
  const ok = await signupWith(Array.from({ length: A.MAX_INTERESTS }, (_, i) => `tag${i}`));
  assert.equal(ok.status, 201, ok.text);
  assert.equal(signupInsert().params[3].length, A.MAX_INTERESTS);

  scriptSignup();
  log = [];
  const over = await signupWith(Array.from({ length: A.MAX_INTERESTS + 1 }, (_, i) => `tag${i}`));
  assert.equal(over.status, 400, over.text);
  assert.deepEqual(noQueries(), [], 'an oversized interests array must be refused before any query');
});

test('signup takes an interest of MAX_INTEREST_LEN and refuses one more', async () => {
  scriptSignup();
  const ok = await signupWith([pad(A.MAX_INTEREST_LEN)]);
  assert.equal(ok.status, 201, ok.text);
  assert.deepEqual(signupInsert().params[3], [pad(A.MAX_INTEREST_LEN)]);

  scriptSignup();
  log = [];
  const over = await signupWith([pad(A.MAX_INTEREST_LEN + 1)]);
  assert.equal(over.status, 400, over.text);
  assert.deepEqual(noQueries(), [], 'an oversized interest must be refused before any query');
});

test('the interest ceilings are past what the product itself produces', () => {
  // The half a boundary test cannot check: these tests are driven from the
  // constants, so they follow them downwards. This reads what the product needs.
  const events = read('routes/events.js');
  const map = /const interestToTM = \{([\s\S]*?)\n\s*\};/.exec(events);
  assert.ok(map, 'routes/events.js must still declare interestToTM — the interest widths are derived from it');
  const longest = [...map[1].matchAll(/'([^']+)':/g)].map((m) => m[1])
    .reduce((a, b) => (b.length > a.length ? b : a), '');
  assert.ok(longest.length > 0, 'interestToTM has no keys to measure');
  assert.ok(A.MAX_INTEREST_LEN >= longest.length,
    `the longest interest the product defines is "${longest}" (${longest.length}); MAX_INTEREST_LEN is ${A.MAX_INTEREST_LEN}`);
  assert.ok(A.MAX_INTERESTS >= 15,
    'the picker offers 12 suggestions on top of 3 defaults, so 15 chips are reachable without typing');
});

test('a non-string interest never reaches the TEXT[] column', async () => {
  for (const v of [[5], [true], [null], [{ a: 1 }], [['nested']]]) {
    scriptSignup();
    log = [];
    const res = await signupWith(v);
    assert.equal(res.status, 400, `interests=${JSON.stringify(v)} -> ${res.text}`);
    assert.deepEqual(noQueries(), [], `interests=${JSON.stringify(v)}: reached the database`);
  }
});

test('an interest is profanity-screened AFTER its markup is stripped, not before', async () => {
  // The ordering is load-bearing rather than tidy, and only a tag INSIDE a word
  // can tell the two orderings apart: the wordlist tokenizes on angle brackets,
  // so "<b>slur</b>" is caught either way, while "sl<b>ur" is three harmless
  // tokens BEFORE stripHtml and one slur after it.
  const slur = 'shit';
  assert.equal(moderateText(slur).allowed, false, 'the probe word is no longer profanity; pick another');
  const split = `sh<b>it`;
  assert.equal(moderateText(split).allowed, true, 'the probe must be invisible to a PRE-strip screen');
  assert.equal(stripHtml(split), slur, 'the probe must strip to the slur, or it tests nothing');

  scriptSignup();
  const res = await signupWith([split]);
  assert.equal(res.status, 400,
    `an interest that becomes a slur once stripped was accepted: ${res.text}`);
  assert.deepEqual(noQueries(), [],
    'it reached the database, so the moderation queue would render it as evidence');
});

test('an interest that is only markup is refused rather than stored blank', async () => {
  scriptSignup();
  const res = await signupWith(['<b> </b>']);
  assert.equal(res.status, 400, res.text);
  assert.deepEqual(noQueries(), [], 'a blank-after-stripping interest must not be stored');
});

test('markup around a real interest is stripped and the interest still saves', async () => {
  // The control. Screening after stripping must not mean refusing every value
  // that ever contained a tag.
  scriptSignup();
  const ok = await signupWith(['<b>music</b>', '  live shows  ']);
  assert.equal(ok.status, 201, ok.text);
  assert.deepEqual(signupInsert().params[3], ['music', 'live shows']);
});

// ---------------------------------------------------------------------------
// 11. The Apple display name: an object with unbounded halves
// ---------------------------------------------------------------------------
// `body('fullName').isObject()` says the CONTAINER is an object and says nothing
// about what is in it, and the handler's `String(fullName.givenName)` is a type
// defence, not a width one. A 60,000-character givenName was composed into a
// display name and written to users.name VARCHAR(255).
function scriptAppleCreate() {
  handlers = [
    [/oauth_provider = 'apple' AND oauth_id/, () => ({ rows: [] })],
    [/FROM banned_identities/, () => ({ rows: [] })],
    [/^SELECT \* FROM users/, () => ({ rows: [] })],
    [/^INSERT INTO users/, (params) => ({
      rows: [{
        id: 91, email: params[0], name: params[1], oauth_provider: 'apple',
        date_of_birth: params[3], email_verified: true, token_version: 0,
      }],
    })],
  ];
}

test('an Apple name half at the column width signs in, and one past it does not', async () => {
  const token = appleIdentityToken({ sub: 'apple-sub-1', email: 'sam@example.com', email_verified: true });

  scriptAppleCreate();
  const ok = await call('POST', '/api/auth/apple', {
    identityToken: token, date_of_birth: '2000-01-01',
    fullName: { givenName: pad(A.MAX_NAME) },
  });
  assert.equal(ok.status, 200, ok.text);
  const insert = log.find((q) => /^INSERT INTO users/.test(q.sql));
  assert.ok(insert, 'the sign-in never reached the INSERT');
  assert.ok([...insert.params[1]].length <= usersColumnWidth('name'),
    `the display name reached pg at ${[...insert.params[1]].length} characters, past users.name`);

  // One past it, and the token is now REPLAYED — which is the sharper assertion:
  // the refusal has to happen in the chain, before the handler spends anything.
  scriptAppleCreate();
  log = [];
  const over = await call('POST', '/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'apple-sub-2', email: 'sam2@example.com', email_verified: true }),
    date_of_birth: '2000-01-01',
    fullName: { givenName: pad(A.MAX_NAME + 1) },
  });
  assert.equal(over.status, 400, over.text);
  assert.deepEqual(noQueries(), [], 'an oversized name half must be refused before any query');
});

test('a structured Apple name half is refused rather than stored as "[object Object]"', async () => {
  for (const v of [{ a: 1 }, ['Sam'], 5, true]) {
    scriptAppleCreate();
    log = [];
    const res = await call('POST', '/api/auth/apple', {
      identityToken: appleIdentityToken({ sub: 'apple-sub-3', email: 'sam3@example.com', email_verified: true }),
      date_of_birth: '2000-01-01',
      fullName: { givenName: v, familyName: 'Lee' },
    });
    assert.equal(res.status, 400, `givenName=${JSON.stringify(v)} -> ${res.status} ${res.text}`);
    for (const p of paramsSeen()) {
      assert.ok(typeof p !== 'string' || !p.includes('[object Object]'),
        `givenName=${JSON.stringify(v)} reached pg as ${JSON.stringify(p)}`);
    }
  }
});

// The provider-supplied name is the half NO chain on this router ever sees:
// Google's display name comes out of a token this handler verified, so it
// reaches users.name without passing a validator. That is what clampName is for.
test('clampName cuts to MAX_NAME by code point, never mid surrogate pair', () => {
  assert.equal(A.clampName(pad(A.MAX_NAME)).length, A.MAX_NAME, 'a name at the ceiling is untouched');
  assert.equal([...A.clampName(pad(A.MAX_NAME + 50))].length, A.MAX_NAME);
  // Emoji are surrogate pairs in UTF-16; a naive slice(0, MAX_NAME) can cut one
  // in half and leave a lone surrogate in the column.
  const emoji = '🐦'.repeat(A.MAX_NAME + 10);
  const cut = A.clampName(emoji);
  assert.equal([...cut].length, A.MAX_NAME);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), 'a lone high surrogate was left in the value');
});

test('a Google display name wider than the column is clamped, not 22001', async () => {
  googlePayload = {
    sub: 'google-sub-1',
    email: 'gina@example.com',
    email_verified: true,
    name: pad(A.MAX_NAME + 500),
    picture: null,
  };
  handlers = [
    [/oauth_provider = 'google' AND oauth_id/, () => ({ rows: [] })],
    [/FROM banned_identities/, () => ({ rows: [] })],
    [/^SELECT \* FROM users/, () => ({ rows: [] })],
    [/^INSERT INTO users/, (params) => ({
      rows: [{
        id: 92, email: params[0], name: params[1], oauth_provider: 'google',
        date_of_birth: params[5], email_verified: true, token_version: 0,
      }],
    })],
  ];
  const res = await call('POST', '/api/auth/google',
    { credential: 'a.b.c', date_of_birth: '2000-01-01' });
  assert.equal(res.status, 200, res.text);
  const insert = log.find((q) => /^INSERT INTO users/.test(q.sql));
  assert.ok(insert, 'the Google sign-in never reached the INSERT');
  assert.equal([...insert.params[1]].length, A.MAX_NAME,
    `the provider name reached pg at ${[...insert.params[1]].length} characters`);
});

// ---------------------------------------------------------------------------
// 12. bcrypt truncates at 72 bytes, and the bound does not change that
// ---------------------------------------------------------------------------
// Pinned because it is the reason MAX_PASSWORD is 1024 rather than 72 and the
// reason it is not 65536: everything past 72 bytes is inert, so the ceiling is
// about who decides the width, not about strength.
test('two passwords sharing a 72-byte prefix are the same password to bcrypt', () => {
  const prefix = pad(72);
  const hash = bcrypt.hashSync(`${prefix}-one`, 4);
  assert.equal(bcrypt.compareSync(`${prefix}-one`, hash), true);
  assert.equal(bcrypt.compareSync(`${prefix}-two`, hash), true,
    'bcryptjs stopped truncating at 72 bytes — the MAX_PASSWORD note needs rewriting');
  assert.equal(bcrypt.compareSync(`${pad(71)}b-two`, hash), false,
    'a difference INSIDE the first 72 bytes must still be a different password');
  assert.ok(A.MAX_PASSWORD > 72,
    'the ceiling is deliberately far above the part bcrypt reads, so no existing password is locked out');
});

// ---------------------------------------------------------------------------
// 13. routes/revenuecat.js — the anonymous subscriber
// ---------------------------------------------------------------------------
// RevenueCat gives every install an anonymous subscriber until the client calls
// Purchases.logIn(userId). A purchase made before that call is delivered under
// that id, there is no Flock account behind it, and the webhook answered 400 —
// which RevenueCat retries, on their backoff, for a payload that can never
// succeed. Harmless while the paywall is dormant; wrong the moment it is not.
const rcAuth = { Authorization: `Bearer ${process.env.REVENUECAT_WEBHOOK_SECRET}` };
const rcPost = (event) => call('POST', '/api/revenuecat/webhook', { event }, rcAuth);

test('an anonymous subscriber is answered 200 with a reason, not retried forever', async () => {
  const res = await rcPost({ type: 'INITIAL_PURCHASE', app_user_id: `$RCAnonymousID:${'a1b2c3d4'.repeat(4)}` });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.ignored, 'anonymous',
    'the reason has to be explicit, or "we did nothing" is indistinguishable from "we did something"');
  assert.deepEqual(noQueries(), [], 'there is no account to write to');
});

test('every event type carrying an anonymous id is ignored the same way', async () => {
  for (const type of ['INITIAL_PURCHASE', 'RENEWAL', 'EXPIRATION', 'SUBSCRIPTION_PAUSED', 'PRODUCT_CHANGE']) {
    log = [];
    const res = await rcPost({ type, app_user_id: '$RCAnonymousID:0123456789abcdef0123456789abcdef' });
    assert.equal(res.status, 200, `${type} -> ${res.status} ${res.text}`);
    assert.equal(res.body.ignored, 'anonymous', `${type} was not recognised as anonymous`);
    assert.deepEqual(noQueries(), [], `${type}: wrote to the database for an anonymous subscriber`);
  }
});

test('an id that is neither digits nor anonymous is still a 400', async () => {
  // The distinction is deliberate: a payload our client cannot produce belongs
  // in RevenueCat's dashboard, where somebody will see it.
  for (const id of ['4242junk', '99999999999', '', 'RCAnonymousID:abc', '$RCAnonymous:abc', null]) {
    log = [];
    const res = await rcPost({ type: 'INITIAL_PURCHASE', app_user_id: id });
    assert.equal(res.status, 400, `app_user_id=${JSON.stringify(id)} -> ${res.status} ${res.text}`);
    assert.deepEqual(noQueries(), [], `app_user_id=${JSON.stringify(id)}: reached a query`);
  }
});

test('a real numeric id still flips is_premium', async () => {
  // The control: the anonymous branch must not have swallowed the honest event.
  handlers = [[/^UPDATE users SET is_premium/, () => ({ rows: [], rowCount: 1 })]];
  const res = await rcPost({ type: 'INITIAL_PURCHASE', app_user_id: '4242' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.ignored, undefined, 'a real id is not an ignored event');
  const update = log.find((q) => /^UPDATE users SET is_premium/.test(q.sql));
  assert.ok(update, 'a real subscriber must still be written');
  assert.deepEqual(update.params, [true, 4242]);
});
