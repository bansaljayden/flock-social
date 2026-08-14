// Run: node --test  (from backend/)
//
// Round 16. Email verification at signup, and the four auth findings fixed
// alongside it. Every test is a regression test for something that was
// exploitable, and the comment above each block is the exploit.
//
// No database is touched. pool.query is replaced with a dispatcher over
// in-memory `users` and `email_verifications` tables, the same technique
// authSurface.test.js uses. Resend is replaced with a recorder so the mail body
// and the link inside it can be asserted.

// Env must be set before ANY require.
//   PUBLIC_WEB_URL / PUBLIC_API_URL are deliberately LOCALHOST here: the point
//   of the link tests is that a localhost value in the environment can never
//   reach a real inbox.
process.env.JWT_SECRET = 'test-secret-for-email-verification-tests';
process.env.GOOGLE_CLIENT_ID = 'flock-test.apps.googleusercontent.com';
process.env.PUBLIC_WEB_URL = 'http://localhost:3000';
process.env.PUBLIC_API_URL = 'http://localhost:5000';
process.env.RESEND_API_KEY = 'test-resend-key';
delete process.env.APPLE_REQUIRE_NONCE;
delete process.env.NODE_ENV;

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

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

// Resend recorder.
let sentMail = [];
let resendBehaviour = 'ok'; // 'ok' | 'error' | 'throw'
const resendPath = require.resolve('resend');
require.cache[resendPath] = {
  id: resendPath, filename: resendPath, loaded: true,
  exports: {
    Resend: class {
      constructor() {
        this.emails = {
          send: async (msg) => {
            sentMail.push(msg);
            if (resendBehaviour === 'throw') throw new Error('resend exploded');
            if (resendBehaviour === 'error') return { data: null, error: { message: 'rejected' } };
            return { data: { id: `mail-${sentMail.length}` }, error: null };
          },
        };
      }
    },
  },
};

// Apple server-to-server config, toggled per test.
let appleConfigured = false;
let appleExchange = async () => ({ refresh_token: 'apple-refresh' });
const appleAuthPath = require.resolve('../services/appleAuth');
require.cache[appleAuthPath] = {
  id: appleAuthPath, filename: appleAuthPath, loaded: true,
  exports: {
    isConfigured: () => appleConfigured,
    exchangeAppleCode: (code) => appleExchange(code),
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
const authMod = require('../middleware/auth');
const emailService = require('../services/emailService');
const { authenticate, authenticateAllowBanned, signUserToken } = authMod;
const {
  parseVerificationToken, verifierMatches, claimDecision, isMailableAddress,
  constantTimeEquals, appleNonceClaimMatches, RESEND_MAX_PER_HOUR_ACCOUNT,
  RESEND_MAX_PER_DAY_ACCOUNT, RESEND_MAX_PER_HOUR_IP,
} = authRouter.__testing;
const { unverifiedBlocked, normalizeGatePath } = authMod.__testing;

// ---------------------------------------------------------------------------
// In-memory tables
// ---------------------------------------------------------------------------
let users = [];
let verifications = [];
let nextUserId = 1;
let nextVerificationId = 1;
// Ban-evasion tombstones (migration 012, routes/users.js). The digesting is
// covered in banEvasion.test.js; here we only need to prove auth.js CONSULTS it.
let identityTombstoned = false;

const canonical = authRouter.__testing.canonicalEmail;
const findByEmail = (email) => users.find((u) => String(u.email).toLowerCase() === String(email).toLowerCase())
  || users.find((u) => canonical(u.email) === canonical(email))
  || null;

// Round 19 (mutation audit). The UPDATE handlers below used to apply their row
// change unconditionally: they matched a PREFIX of the statement and then
// re-implemented the effect in JavaScript. A clause deleted from
// routes/auth.js was therefore still applied HERE, and every assertion about
// that clause passed against this file rather than against the route.
//
// `clause` is the fix. Each column, and each WHERE guard, is honoured only if
// the statement that arrived actually carries it — so deleting a clause from
// the source deletes its effect here too.
const clause = (sql, re) => re.test(sql);

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
  if (sql.startsWith('SELECT id, email, name, role') && sql.includes('FROM users WHERE id')) {
    return { rows: users.filter((u) => u.id === params[0]) };
  }
  if (sql.startsWith('SELECT id, email, name, email_verified FROM users WHERE id')) {
    return { rows: users.filter((u) => u.id === params[0]) };
  }
  if (sql.startsWith('SELECT id, email, name, phone, interests, role')) {
    return { rows: users.filter((u) => u.id === params[0]) };
  }
  if (sql.startsWith('INSERT INTO users')) {
    const row = {
      id: nextUserId++, token_version: 0, is_banned: false, password: null,
      oauth_provider: null, oauth_id: null, date_of_birth: null,
      venmo_username: null, cashapp_cashtag: null, zelle_identifier: null,
      verified_email: null, email_verified: false,
    };
    // NOW() is flattened first: its own ')' would otherwise terminate the
    // VALUES scan early, silently dropping every column after it.
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
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith("UPDATE users SET oauth_provider = 'google'")) {
    const row = users.find((u) => u.id === params[2]);
    if (!row) return { rows: [], rowCount: 0 };
    row.oauth_provider = 'google';
    row.oauth_id = params[0];
    if (clause(sql, /\bpassword = NULL\b/)) row.password = null;
    if (clause(sql, /profile_image_url = COALESCE\(profile_image_url, \$2\)/)) {
      row.profile_image_url = row.profile_image_url ?? params[1];
    }
    if (clause(sql, /\bemail_verified = TRUE\b/)) row.email_verified = true;
    if (clause(sql, /\bverified_email = email\b/)) row.verified_email = row.email;
    if (clause(sql, /token_version = token_version \+ 1/)) row.token_version += 1;
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith("UPDATE users SET oauth_provider = 'apple'")) {
    const row = users.find((u) => u.id === params[1]);
    if (!row) return { rows: [], rowCount: 0 };
    row.oauth_provider = 'apple';
    row.oauth_id = params[0];
    if (clause(sql, /\bpassword = NULL\b/)) row.password = null;
    if (clause(sql, /\bemail_verified = TRUE\b/)) row.email_verified = true;
    if (clause(sql, /\bverified_email = email\b/)) row.verified_email = row.email;
    if (clause(sql, /token_version = token_version \+ 1/)) row.token_version += 1;
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE users SET email = $1, email_verified = FALSE')) {
    // The WHERE guard is the only thing protecting a row that verified itself
    // between the read and this write, so it is read out of the statement too.
    const row = users.find((u) => u.id === params[1]
      && (!clause(sql, /WHERE id = \$2 AND email_verified = FALSE/) || u.email_verified === false));
    if (!row) return { rows: [], rowCount: 0 };
    row.email = params[0];
    if (clause(sql, /\bemail_verified = FALSE,/)) row.email_verified = false;
    if (clause(sql, /\bverified_email = NULL\b/)) row.verified_email = null;
    if (clause(sql, /\bvenmo_username = NULL\b/)) row.venmo_username = null;
    if (clause(sql, /\bcashapp_cashtag = NULL\b/)) row.cashapp_cashtag = null;
    if (clause(sql, /\bzelle_identifier = NULL\b/)) row.zelle_identifier = null;
    if (clause(sql, /token_version = token_version \+ 1/)) row.token_version += 1;
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE users SET email_verified = TRUE, verified_email = email')) {
    const row = users.find((u) => u.id === params[0]
      && (!clause(sql, /LOWER\(email\) = LOWER\(\$2\)/)
        || String(u.email).toLowerCase() === String(params[1]).toLowerCase()));
    if (!row) return { rows: [], rowCount: 0 };
    if (clause(sql, /\bemail_verified = TRUE\b/)) row.email_verified = true;
    if (clause(sql, /\bverified_email = email\b/)) row.verified_email = row.email;
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE users SET token_version = token_version + 1')) {
    const row = users.find((u) => u.id === params[0]);
    if (!row) return { rows: [], rowCount: 0 };
    row.token_version += 1;
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE users SET date_of_birth')) {
    const row = users.find((u) => u.id === params[1]);
    if (row) row.date_of_birth = params[0];
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (sql.startsWith('UPDATE users SET apple_refresh_token')) {
    const row = users.find((u) => u.id === params[1]);
    if (row) row.apple_refresh_token = params[0];
    return { rows: [], rowCount: row ? 1 : 0 };
  }

  // ---- email_verifications ------------------------------------------------
  if (sql.startsWith('INSERT INTO email_verifications')) {
    verifications.push({
      id: nextVerificationId++, user_id: params[0], selector: params[1],
      verifier_hash: params[2], email: params[3], request_ip: params[4],
      expires_at: new Date(now + params[5] * 3600 * 1000).toISOString(),
      used_at: null, created_at: new Date(now).toISOString(),
    });
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE email_verifications SET used_at')) {
    // Single-use and the TTL are the DATABASE's guarantees, so both are read
    // off the statement instead of being re-implemented beside it.
    const unused = (v) => !clause(sql, /AND used_at IS NULL/) || !v.used_at;
    const live = (v) => !clause(sql, /AND expires_at > NOW\(\)/) || Date.parse(v.expires_at) > now;
    if (sql.includes('WHERE id = $1')) {
      const v = verifications.find((x) => x.id === params[0]);
      const ok = Boolean(v) && unused(v) && live(v);
      if (ok) v.used_at = new Date(now).toISOString();
      return { rows: ok ? [{ id: v.id }] : [], rowCount: ok ? 1 : 0 };
    }
    let n = 0;
    for (const v of verifications) {
      if (v.user_id === params[0] && unused(v) && live(v)) { v.used_at = new Date(now).toISOString(); n += 1; }
    }
    return { rows: [], rowCount: n };
  }
  if (sql.startsWith('SELECT COUNT(*)') && sql.includes('FROM email_verifications')) {
    const mine = verifications.filter((v) => v.user_id === params[0]);
    const within = (v, ms) => now - Date.parse(v.created_at) < ms;
    return {
      rows: [{
        account_hour: mine.filter((v) => within(v, 3600e3)).length,
        account_day: mine.filter((v) => within(v, 86400e3)).length,
        account_last: mine.length ? mine[mine.length - 1].created_at : null,
        ip_hour: verifications.filter((v) => v.request_ip === params[1] && within(v, 3600e3)).length,
      }],
    };
  }
  if (sql.startsWith('SELECT v.id, v.user_id')) {
    const v = verifications.find((x) => x.selector === params[0]);
    if (!v) return { rows: [] };
    const u = users.find((x) => x.id === v.user_id);
    return { rows: [{ ...v, current_email: u?.email ?? null, email_verified: u?.email_verified ?? null }] };
  }

  // ---- banned_identities (migration 012) ---------------------------------
  if (sql.startsWith('SELECT 1 FROM banned_identities')) {
    return { rows: identityTombstoned ? [{ ok: 1 }] : [] };
  }
  if (sql.startsWith('DELETE FROM banned_identities')) return { rows: [], rowCount: 0 };

  throw new Error(`unstubbed query: ${sql.slice(0, 140)}`);
};

// ---------------------------------------------------------------------------
// App. The three gated routers are mounted exactly the way the real ones are
// (`router.use(authenticate)` under the same mount path), because the middleware
// backstop is matched against req.baseUrl + req.path.
// ---------------------------------------------------------------------------
let disconnectedRooms = [];
const fakeIo = { in: (room) => ({ disconnectSockets: (c) => disconnectedRooms.push(`${room}|${c}`) }) };

function stubRouter(paths) {
  const r = express.Router();
  r.use(authenticate);
  for (const [method, path] of paths) r[method](path, (req, res) => res.json({ ok: true }));
  return r;
}

const app = express();
app.use(express.json());
app.set('io', fakeIo);
app.use('/api/auth', authRouter);
// Mirrors routes/users.js: the deletion route opts in to the ban-tolerant auth
// BEFORE router.use(authenticate), and must stay reachable while unverified.
const usersRouter = express.Router();
usersRouter.delete('/me', authenticateAllowBanned, (req, res) => res.json({ ok: 'deleted' }));
usersRouter.use(authenticate);
usersRouter.put('/venmo-username', (req, res) => res.json({ ok: true }));
usersRouter.put('/payment-methods', (req, res) => res.json({ ok: true }));
usersRouter.put('/profile', (req, res) => res.json({ ok: true }));
usersRouter.get('/settings', (req, res) => res.json({ ok: true }));
app.use('/api/users', usersRouter);
app.use('/api/friends', stubRouter([
  ['post', '/request'], ['post', '/accept'], ['post', '/decline'],
  ['post', '/add-by-code'], ['get', '/'],
]));
app.use('/api/flocks', stubRouter([
  ['post', '/'], ['post', '/:id/join'], ['post', '/:id/invite'],
  ['post', '/:id/leave'], ['get', '/'], ['get', '/:id'],
]));

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => { pool.query = realQuery; pool.end().catch(() => {}); });

const call = (method, path, body, token) => fetch(base + path, {
  method,
  redirect: 'manual',
  headers: {
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const post = (p, b, t) => call('POST', p, b, t);

function reset() {
  users = []; verifications = []; nextUserId = 1; nextVerificationId = 1;
  sentMail = []; disconnectedRooms = []; resendBehaviour = 'ok';
  identityTombstoned = false;
  appleConfigured = false;
  appleExchange = async () => ({ refresh_token: 'apple-refresh' });
  emailService.resetClient();
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

const SIGNUP = { email: 'new@example.com', password: 'Password1', name: 'New User', date_of_birth: '2000-01-01' };

// The token is never returned by the API — it only exists inside the mailed
// link, which is exactly the property under test.
function tokenFromLastMail() {
  const html = sentMail[sentMail.length - 1].html;
  const m = html.match(/verify-email\?token=([A-Za-z0-9._%-]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function signupUnverified(overrides = {}) {
  const res = await post('/api/auth/signup', { ...SIGNUP, ...overrides });
  const body = await res.json();
  return { res, body, token: body.token, user: users.find((u) => u.id === body.user?.id) };
}

// ---------------------------------------------------------------------------
// FINDING 1 (CRITICAL): password signup never proved the person could read the
// mailbox. An attacker pre-registered a victim's address, set their own payment
// handles and seeded friendships on it, and waited. The victim's first Google
// sign-in welded their identity onto that row and cleared its password, so the
// victim inherited the attacker's Venmo/Cash App/Zelle handles and an already
// accepted friendship with them, and every bill split paid the attacker.
// ---------------------------------------------------------------------------
test('a password signup starts UNVERIFIED and is mailed a link', async () => {
  reset();
  const { res, body, user } = await signupUnverified();

  assert.strictEqual(res.status, 201);
  assert.strictEqual(user.email_verified, false, 'the row must be created unverified');
  assert.strictEqual(user.verified_email, null, 'nothing has been proved yet');
  assert.strictEqual(body.emailVerificationRequired, true);
  assert.strictEqual(body.verificationSent, true);
  assert.strictEqual(sentMail.length, 1);
  assert.strictEqual(sentMail[0].to, 'new@example.com');
  assert.strictEqual(verifications.length, 1);
  // The secret is never stored: only its SHA-256 is.
  const token = tokenFromLastMail();
  assert.ok(token, 'the link must carry a token');
  assert.ok(!verifications[0].verifier_hash.includes(token.split('.')[1]));
});

test('an unverified account cannot accumulate payment handles, friendships or flocks', async () => {
  reset();
  const { token } = await signupUnverified();

  const blocked = [
    ['PUT', '/api/users/venmo-username'],
    ['PUT', '/api/users/payment-methods'],
    ['POST', '/api/friends/request'],
    ['POST', '/api/friends/accept'],
    ['POST', '/api/friends/add-by-code'],
    ['POST', '/api/flocks'],
    ['POST', '/api/flocks/42/join'],
    ['POST', '/api/flocks/42/invite'],
  ];
  for (const [method, path] of blocked) {
    const res = await call(method, path, {}, token);
    assert.strictEqual(res.status, 403, `${method} ${path} must be refused while unverified`);
    assert.strictEqual((await res.json()).emailVerificationRequired, true);
  }
});

test('an unverified account is NOT locked out of the app', async () => {
  reset();
  const { token } = await signupUnverified();

  // Reading, leaving, declining, editing your own name, and erasing your own
  // account all stay available. A mistyped address must not be a dead end.
  const allowed = [
    ['GET', '/api/auth/me'],
    ['GET', '/api/friends'],
    ['GET', '/api/flocks'],
    ['GET', '/api/flocks/42'],
    ['POST', '/api/friends/decline'],
    ['POST', '/api/flocks/42/leave'],
    ['PUT', '/api/users/profile'],
    ['GET', '/api/users/settings'],
  ];
  for (const [method, path] of allowed) {
    const res = await call(method, path, method === 'GET' ? null : {}, token);
    assert.strictEqual(res.status, 200, `${method} ${path} must stay available while unverified`);
  }
  assert.strictEqual((await call('DELETE', '/api/users/me', null, token)).status, 200);
});

test('/api/auth/me reports the verification state so the client can prompt', async () => {
  reset();
  const { token } = await signupUnverified();
  const me = await (await call('GET', '/api/auth/me', null, token)).json();
  assert.strictEqual(me.user.email_verified, false);
});

test('clicking the link verifies the account and lifts the gate', async () => {
  reset();
  const { token } = await signupUnverified();
  const link = tokenFromLastMail();

  assert.strictEqual((await post('/api/friends/accept', {}, token)).status, 403);

  const res = await post('/api/auth/verify-email', { token: link });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(users[0].email_verified, true);
  assert.strictEqual(users[0].verified_email, 'new@example.com', 'WHICH address was proved must be recorded');

  assert.strictEqual((await post('/api/friends/accept', {}, token)).status, 200);
});

// ---------------------------------------------------------------------------
// Link properties: single use, expiring, constant-time compared, bound to the
// address it was mailed to.
// ---------------------------------------------------------------------------
test('a verification link works exactly once', async () => {
  reset();
  await signupUnverified();
  const link = tokenFromLastMail();

  assert.strictEqual((await post('/api/auth/verify-email', { token: link })).status, 200);

  // Second use by the same person is reported as done, because the account IS
  // verified and mailbox scanners spend links before humans click them.
  const second = await post('/api/auth/verify-email', { token: link });
  assert.strictEqual(second.status, 200);

  // But the row is spent, so it can never verify anything again: un-verify the
  // account by hand and the same link is refused.
  users[0].email_verified = false;
  const third = await post('/api/auth/verify-email', { token: link });
  assert.strictEqual(third.status, 400);
  assert.strictEqual((await third.json()).reason, 'used');
  assert.strictEqual(users[0].email_verified, false);
});

test('an expired link is refused', async () => {
  reset();
  await signupUnverified();
  const link = tokenFromLastMail();
  verifications[0].expires_at = new Date(Date.now() - 1000).toISOString();

  const res = await post('/api/auth/verify-email', { token: link });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).reason, 'expired');
  assert.strictEqual(users[0].email_verified, false);
});

test('a token with the right selector and a forged verifier is refused', async () => {
  reset();
  await signupUnverified();
  const link = tokenFromLastMail();
  const [selector] = link.split('.');

  // Knowing the public half is worth nothing without the secret half.
  const forged = `${selector}.${crypto.randomBytes(32).toString('base64url')}`;
  const res = await post('/api/auth/verify-email', { token: forged });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).reason, 'invalid');
  assert.strictEqual(users[0].email_verified, false);
  assert.strictEqual(verifications[0].used_at, null, 'a forged attempt must not spend the real link');
});

test('the verifier is compared in constant time and never stored in the clear', () => {
  const secret = 'abcdefghijklmnopqrstuvwxyz012345';
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  assert.strictEqual(verifierMatches(secret, hash), true);
  assert.strictEqual(verifierMatches('abcdefghijklmnopqrstuvwxyz012346', hash), false);
  // A corrupt / truncated stored hash must be a plain false, not a throw:
  // crypto.timingSafeEqual rejects mismatched lengths outright.
  assert.strictEqual(verifierMatches(secret, 'short'), false);
  assert.strictEqual(verifierMatches(secret, null), false);
  assert.strictEqual(constantTimeEquals('abc', 'abc'), true);
  assert.strictEqual(constantTimeEquals('abc', 'abd'), false);
  assert.strictEqual(constantTimeEquals('abc', 'abcd'), false);
  assert.strictEqual(constantTimeEquals(null, undefined), true);
});

test('junk tokens are rejected without touching the database', () => {
  for (const junk of [null, undefined, 42, '', 'x', 'x'.repeat(500),
    `${'z'.repeat(32)}.${'a'.repeat(43)}`,            // selector is not hex
    `${'a'.repeat(31)}.${'a'.repeat(43)}`,            // selector too short
    `${'a'.repeat(32)}.${'a'.repeat(4)}`,             // verifier too short
    `${'a'.repeat(32)}.${'a'.repeat(20)}!`]) {        // verifier not base64url
    assert.strictEqual(parseVerificationToken(junk), null, `should reject ${String(junk).slice(0, 20)}`);
  }
  const ok = parseVerificationToken(`${'a'.repeat(32)}.${'B'.repeat(43)}`);
  assert.deepStrictEqual(ok, { selector: 'a'.repeat(32), verifier: 'B'.repeat(43) });
});

test('a link issued for one address cannot verify a different one', async () => {
  reset();
  await signupUnverified();
  const link = tokenFromLastMail();

  // The account moves to another mailbox before the link is clicked. The link
  // proves ownership of the OLD address and must say nothing about the new one.
  users[0].email = 'somewhere-else@example.com';

  const res = await post('/api/auth/verify-email', { token: link });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).reason, 'stale');
  assert.strictEqual(users[0].email_verified, false);
});

test('asking for a new link retires the old one, so only the newest can work', async () => {
  reset();
  const { token } = await signupUnverified();
  const first = tokenFromLastMail();

  verifications[0].created_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  assert.strictEqual((await post('/api/auth/resend-verification', {}, token)).status, 200);
  const second = tokenFromLastMail();
  assert.notStrictEqual(first, second);

  const stale = await post('/api/auth/verify-email', { token: first });
  assert.strictEqual(stale.status, 400);
  assert.strictEqual(users[0].email_verified, false);

  assert.strictEqual((await post('/api/auth/verify-email', { token: second })).status, 200);
  assert.strictEqual(users[0].email_verified, true);
});

// ---------------------------------------------------------------------------
// Links must point at production. A localhost value in the environment is a
// link that can never work, mailed to a real person, for the one action that
// unlocks their account.
// ---------------------------------------------------------------------------
test('verification links point at the production API, never at localhost', async () => {
  reset();
  await signupUnverified();
  const html = sentMail[0].html;

  assert.ok(!/localhost/i.test(html), 'no localhost may reach an inbox');
  assert.ok(!/127\.0\.0\.1/.test(html));
  assert.ok(html.includes(`${emailService.PROD_API_URL}/api/auth/verify-email?token=`));
  assert.ok(html.includes(emailService.PROD_WEB_URL), 'the logo must come from the production web host too');
});

test('only a public https base URL is ever used in a link', () => {
  const rejected = [
    '', null, 'not a url', 'http://flockcorp.com', 'https://localhost:3000',
    'https://127.0.0.1', 'https://10.0.0.4', 'https://192.168.1.9',
    'https://172.16.0.1', 'https://api.local', 'https://box.internal', 'https://[::1]',
  ];
  for (const v of rejected) assert.strictEqual(emailService.isUnmailableBase(v), true, `${v} must be refused`);
  for (const v of ['https://flockcorp.com', 'https://flock-app-production.up.railway.app/']) {
    assert.strictEqual(emailService.isUnmailableBase(v), false);
  }
});

test('the GET link redirects to the production web app, and cannot be aimed elsewhere', async () => {
  reset();
  await signupUnverified();
  const link = tokenFromLastMail();

  const ok = await call('GET', `/api/auth/verify-email?token=${encodeURIComponent(link)}`);
  assert.strictEqual(ok.status, 302);
  assert.strictEqual(ok.headers.get('location'), `${emailService.PROD_WEB_URL}/?email_verified=1`);
  assert.strictEqual(users[0].email_verified, true);

  const bad = await call('GET', '/api/auth/verify-email?token=nonsense');
  assert.strictEqual(bad.status, 302);
  assert.strictEqual(bad.headers.get('location'), `${emailService.PROD_WEB_URL}/?email_verified=invalid`);
});

// ---------------------------------------------------------------------------
// Resend budget. Without one, /resend-verification is a Flock-branded mail
// cannon aimed at any address an attacker can put on an account, and it burns
// the same Resend quota the SOS alert path depends on.
// ---------------------------------------------------------------------------
test('resending is rate limited per account', async () => {
  reset();
  const { token } = await signupUnverified();

  // Signup already sent one, so an immediate resend is inside the minimum gap.
  const tooSoon = await post('/api/auth/resend-verification', {}, token);
  assert.strictEqual(tooSoon.status, 429);
  assert.strictEqual(sentMail.length, 1);

  // Past the gap but at the hourly cap.
  const age = (mins) => new Date(Date.now() - mins * 60 * 1000).toISOString();
  for (let i = 0; i < RESEND_MAX_PER_HOUR_ACCOUNT; i++) {
    verifications.push({
      id: nextVerificationId++, user_id: users[0].id, selector: `s${i}`, verifier_hash: 'h',
      email: users[0].email, request_ip: null, expires_at: age(-60), used_at: null, created_at: age(5),
    });
  }
  const capped = await post('/api/auth/resend-verification', {}, token);
  assert.strictEqual(capped.status, 429);
  assert.strictEqual(sentMail.length, 1, 'no mail may leave once the budget is spent');
});

test('resending is rate limited per IP, across accounts', async () => {
  reset();
  const { token } = await signupUnverified();
  const ip = verifications[0].request_ip;
  assert.ok(ip, 'the requesting IP must be recorded, or the per-IP budget is fiction');

  // Other accounts, same IP, all within the hour.
  for (let i = 0; i < RESEND_MAX_PER_HOUR_IP; i++) {
    verifications.push({
      id: nextVerificationId++, user_id: 9000 + i, selector: `ip${i}`, verifier_hash: 'h',
      email: `x${i}@example.com`, request_ip: ip, expires_at: new Date(Date.now() + 3600e3).toISOString(),
      used_at: null, created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
  }
  // Move this account's own send out of the minimum-gap window so the per-IP
  // cap is unambiguously what refuses it.
  verifications[0].created_at = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const res = await post('/api/auth/resend-verification', {}, token);
  assert.strictEqual(res.status, 429);
  assert.strictEqual(sentMail.length, 1);
});

test('the daily account cap holds even when every send is an hour apart', async () => {
  reset();
  const { token } = await signupUnverified();
  for (let i = 0; i < RESEND_MAX_PER_DAY_ACCOUNT; i++) {
    verifications.push({
      id: nextVerificationId++, user_id: users[0].id, selector: `d${i}`, verifier_hash: 'h',
      email: users[0].email, request_ip: null, expires_at: new Date(Date.now() + 3600e3).toISOString(),
      used_at: null, created_at: new Date(Date.now() - (i + 2) * 3600e3).toISOString(),
    });
  }
  verifications[0].created_at = new Date(Date.now() - 2 * 3600e3).toISOString();
  const res = await post('/api/auth/resend-verification', {}, token);
  assert.strictEqual(res.status, 429);
});

test('resending on an already verified account is a no-op, not another email', async () => {
  reset();
  const { token } = await signupUnverified();
  await post('/api/auth/verify-email', { token: tokenFromLastMail() });

  const res = await post('/api/auth/resend-verification', {}, token);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).email_verified, true);
  assert.strictEqual(sentMail.length, 1, 'no second email');
});

test('a resend goes to the address on the row NOW, not the one the token was issued for', async () => {
  reset();
  const { token } = await signupUnverified();
  // The account moves. The new link must be issued FOR, and mailed TO, the
  // address the account currently holds, or the token would prove the wrong
  // mailbox and consumeVerification would reject it as stale forever.
  users[0].email = 'moved@example.com';
  verifications[0].created_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  assert.strictEqual((await post('/api/auth/resend-verification', {}, token)).status, 200);
  assert.strictEqual(sentMail[1].to, 'moved@example.com');
  assert.strictEqual(verifications[1].email, 'moved@example.com');
  assert.strictEqual((await post('/api/auth/verify-email', { token: tokenFromLastMail() })).status, 200);
  assert.strictEqual(users[0].verified_email, 'moved@example.com');
});

test('a Resend outage does not fail the signup that triggered it', async () => {
  reset();
  resendBehaviour = 'throw';
  const { res, body, user } = await signupUnverified();

  assert.strictEqual(res.status, 201, 'the account is created either way');
  assert.strictEqual(body.verificationSent, false);
  assert.strictEqual(user.email_verified, false);
  assert.ok(body.token, 'and the user still gets a session so they can ask for a new link');
});

test('nothing is mailed to a non-routable placeholder address', () => {
  assert.strictEqual(isMailableAddress('a@b.com'), true);
  assert.strictEqual(isMailableAddress('apple_x@apple-signin.invalid'), false);
  assert.strictEqual(isMailableAddress('released+3@unclaimed.invalid'), false);
  assert.strictEqual(isMailableAddress(null), false);
  assert.strictEqual(isMailableAddress('nope'), false);
});

// ---------------------------------------------------------------------------
// Migration 011, checked structurally. Every other test here runs against an
// in-memory table, so nothing else in `node --test` would notice if the
// migration stopped grandfathering existing rows — and getting that backwards
// signs every current user out of friends, flocks and payments on deploy.
// (scripts/e2e-local.js applies this file to a real Postgres.)
// ---------------------------------------------------------------------------
test('migration 011 grandfathers existing rows and only then defaults to unverified', () => {
  const sql = require('node:fs')
    .readFileSync(require('node:path').join(__dirname, '..', 'migrations', '011_email_verification.sql'), 'utf8');

  const addAt = sql.indexOf('ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE');
  const defaultAt = sql.indexOf('ALTER COLUMN email_verified SET DEFAULT FALSE');
  assert.ok(addAt > -1, 'the column must be ADDED with DEFAULT TRUE, which backfills every existing row atomically');
  assert.ok(defaultAt > addAt, 'and the default must be flipped to FALSE afterwards, for new accounts');

  // No blanket "UPDATE users SET email_verified = TRUE": a replay against a
  // drifted database would mark genuinely unverified accounts as proven.
  assert.ok(!/UPDATE\s+users\s+SET\s+email_verified\s*=\s*TRUE/i.test(sql));

  assert.match(sql, /CREATE TABLE IF NOT EXISTS email_verifications/);
  assert.match(sql, /selector\s+VARCHAR\(64\)\s+NOT NULL UNIQUE/);
  assert.match(sql, /user_id\s+INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/,
    'deleting an account must take its outstanding links with it');
  for (const col of ['verifier_hash', 'email', 'request_ip', 'expires_at', 'used_at']) {
    assert.ok(sql.includes(col), `email_verifications.${col} is load-bearing`);
  }
  // Every statement is IF NOT EXISTS / conditional, so a replay is a no-op.
  assert.ok(!/CREATE INDEX (?!IF NOT EXISTS)/.test(sql));
});

// ---------------------------------------------------------------------------
// FINDING 1b: the account claim itself. Now that verification exists, the
// legitimate "I had a password, now I use Google" upgrade is distinguishable
// from a squat, and only the former gets the row.
// ---------------------------------------------------------------------------
test('claimDecision separates the upgrade, the squat and the address switch', () => {
  const grandfathered = { email_verified: true, verified_email: null };
  const proved = { email_verified: true, verified_email: 'me@gmail.com' };
  const squat = { email_verified: false, verified_email: null };
  const switched = { email_verified: true, verified_email: 'attacker@gmail.com' };
  const unverifiedAfterProof = { email_verified: false, verified_email: 'me@gmail.com' };

  assert.strictEqual(claimDecision(grandfathered, 'me@gmail.com'), 'claim');
  assert.strictEqual(claimDecision(proved, 'm.e+tag@gmail.com'), 'claim', 'gmail variants are the same mailbox');
  assert.strictEqual(claimDecision(squat, 'victim@gmail.com'), 'evict');
  assert.strictEqual(claimDecision(switched, 'victim@gmail.com'), 'refuse');
  assert.strictEqual(claimDecision(unverifiedAfterProof, 'victim@gmail.com'), 'refuse');
  // A row read by a harness that never selected the column reads as verified,
  // which is the pre-round-16 behaviour rather than a mass lockout.
  assert.strictEqual(claimDecision({}, 'anyone@gmail.com'), 'claim');
});

test('Google will not hand an unverified squatter\'s account to the address owner', async () => {
  reset();
  // The squat, fully loaded: payment handles set and a live session.
  users.push({
    id: 42, email: 'victim@gmail.com', name: 'Squatter', password: 'hash',
    oauth_provider: null, oauth_id: null, is_banned: false, token_version: 0,
    email_verified: false, verified_email: null, date_of_birth: '2000-01-01',
    venmo_username: 'attacker-venmo', cashapp_cashtag: 'attackercash',
    zelle_identifier: 'attacker@zelle.com', profile_image_url: null,
  });
  nextUserId = 43;

  const res = await withGoogle(
    { sub: 'g-1', email: 'victim@gmail.com', email_verified: true, name: 'Real Owner' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: '2000-01-01' })
  );
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  // The victim gets a NEW account, not the squatter's row.
  assert.notStrictEqual(body.user.id, 42);
  assert.strictEqual(body.user.email, 'victim@gmail.com');
  assert.strictEqual(body.user.email_verified, true, 'Google already proved the address');
  assert.strictEqual(body.user.venmo_username ?? null, null, 'no inherited payment handle');

  // The squatter keeps their data and loses the address.
  const squatter = users.find((u) => u.id === 42);
  assert.ok(/@unclaimed\.invalid$/.test(squatter.email), 'the address is released, the row survives');
  assert.strictEqual(squatter.venmo_username, null);
  assert.strictEqual(squatter.cashapp_cashtag, null);
  assert.strictEqual(squatter.zelle_identifier, null);
  assert.strictEqual(squatter.oauth_provider, null, 'no identity is welded onto the squat');
  assert.strictEqual(squatter.token_version, 1, 'the squatter\'s tokens die');
  assert.deepStrictEqual(disconnectedRooms, ['user:42|true'], 'and so does their live socket');
});

test('Apple will not hand an unverified squatter\'s account over either', async () => {
  reset();
  users.push({
    id: 77, email: 'victim@icloud.com', name: 'Squatter', password: 'hash',
    oauth_provider: null, oauth_id: null, is_banned: false, token_version: 0,
    email_verified: false, verified_email: null, date_of_birth: '2000-01-01',
    venmo_username: 'attacker-venmo',
  });
  nextUserId = 78;

  const res = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-1', email: 'victim@icloud.com', email_verified: true }),
    date_of_birth: '2000-01-01',
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  assert.notStrictEqual(body.user.id, 77);
  assert.strictEqual(body.user.email_verified, true);
  assert.ok(/@unclaimed\.invalid$/.test(users.find((u) => u.id === 77).email));
  assert.strictEqual(users.find((u) => u.id === 77).venmo_username, null);
});

test('the legitimate password-to-Google upgrade still works exactly as before', async () => {
  reset();
  users.push({
    id: 5, email: 'me@gmail.com', name: 'Me', password: 'hash',
    oauth_provider: null, oauth_id: null, is_banned: false, token_version: 3,
    email_verified: true, verified_email: 'me@gmail.com', date_of_birth: '2000-01-01',
    profile_image_url: null, venmo_username: 'my-venmo',
  });

  const res = await withGoogle(
    { sub: 'g-2', email: 'me@gmail.com', email_verified: true, name: 'Me' },
    () => post('/api/auth/google', { access_token: 'opaque' })
  );
  assert.strictEqual(res.status, 200);
  assert.strictEqual(users.length, 1, 'no second account');
  assert.strictEqual(users[0].oauth_id, 'g-2');
  assert.strictEqual(users[0].password, null);
  assert.strictEqual(users[0].venmo_username, 'my-venmo', 'their own data survives the upgrade');
  assert.strictEqual(users[0].token_version, 4);
});

test('a row that proved a DIFFERENT address is neither handed over nor destroyed', async () => {
  reset();
  // The bypass this guards: verify your own mailbox, then switch the account's
  // address to a victim's, and arrive wearing a verified flag you never earned
  // for THAT address.
  users.push({
    id: 8, email: 'victim@gmail.com', name: 'Attacker', password: 'hash',
    oauth_provider: null, oauth_id: null, is_banned: false, token_version: 0,
    email_verified: true, verified_email: 'attacker@gmail.com',
    venmo_username: 'attacker-venmo', date_of_birth: '2000-01-01', profile_image_url: null,
  });

  const res = await withGoogle(
    { sub: 'g-3', email: 'victim@gmail.com', email_verified: true, name: 'Victim' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: '2000-01-01' })
  );
  assert.strictEqual(res.status, 409);
  assert.strictEqual(users.length, 1, 'nothing created');
  assert.strictEqual(users[0].oauth_provider, null, 'nothing claimed');
  assert.strictEqual(users[0].email, 'victim@gmail.com', 'and nothing destroyed');
});

test('the released address cannot be PARKED in advance to break a future eviction', async () => {
  reset();
  // users.email is UNIQUE and PUT /api/users/profile accepts any well-formed
  // address, `released+42@unclaimed.invalid` included. A predictable tombstone
  // would let anyone reserve the exact string a later eviction of user 42
  // needs, turning the rightful owner's Google sign-in into a permanent 500.
  users.push({
    id: 42, email: 'released+42@unclaimed.invalid', name: 'Parker', password: 'hash',
    oauth_provider: null, oauth_id: null, is_banned: false, token_version: 0,
    email_verified: true, verified_email: 'released+42@unclaimed.invalid',
  });
  users.push({
    id: 43, email: 'victim@gmail.com', name: 'Squatter', password: 'hash',
    oauth_provider: null, oauth_id: null, is_banned: false, token_version: 0,
    email_verified: false, verified_email: null,
  });
  nextUserId = 44;

  const res = await withGoogle(
    { sub: 'g-11', email: 'victim@gmail.com', email_verified: true, name: 'Owner' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: '2000-01-01' })
  );
  assert.strictEqual(res.status, 200);
  const released = users.find((u) => u.id === 43).email;
  assert.ok(/^released\+43\.[0-9a-f]{12}@unclaimed\.invalid$/.test(released),
    `tombstone must be unguessable, got ${released}`);
  assert.notStrictEqual(released, users.find((u) => u.id === 42).email);
});

test('a BANNED unverified row is refused, never evicted — eviction would shed the ban', async () => {
  reset();
  users.push({
    id: 9, email: 'banned@gmail.com', name: 'Abuser', password: 'hash',
    oauth_provider: null, oauth_id: null, is_banned: true, token_version: 0,
    email_verified: false, verified_email: null,
  });

  const res = await withGoogle(
    { sub: 'g-4', email: 'banned@gmail.com', email_verified: true, name: 'Owner' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: '2000-01-01' })
  );
  assert.strictEqual(res.status, 403);
  assert.strictEqual(users.length, 1);
  assert.strictEqual(users[0].is_banned, true);
  assert.strictEqual(users[0].email, 'banned@gmail.com', 'the address is not released');
});

test('a request that is going to be refused never displaces anybody first', async () => {
  reset();
  users.push({
    id: 10, email: 'victim@gmail.com', name: 'Squatter', password: 'hash',
    oauth_provider: null, oauth_id: null, is_banned: false, token_version: 0,
    email_verified: false, verified_email: null,
  });

  // No date_of_birth: the age gate refuses this request. The eviction must not
  // already have happened by then.
  const res = await withGoogle(
    { sub: 'g-5', email: 'victim@gmail.com', email_verified: true, name: 'Owner' },
    () => post('/api/auth/google', { access_token: 'opaque' })
  );
  assert.strictEqual(res.status, 403);
  assert.strictEqual((await res.json()).needsDob, true);
  assert.strictEqual(users[0].email, 'victim@gmail.com', 'the squat is untouched by a refused request');
  assert.strictEqual(users.length, 1);
});

// ---------------------------------------------------------------------------
// FINDING 2: OAuth signups must never be asked to verify again.
// ---------------------------------------------------------------------------
test('a new Google account is created verified and is sent no email', async () => {
  reset();
  const res = await withGoogle(
    { sub: 'g-6', email: 'fresh@gmail.com', email_verified: true, name: 'Fresh' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: '2000-01-01' })
  );
  assert.strictEqual(res.status, 200);
  assert.strictEqual(users[0].email_verified, true);
  assert.strictEqual(users[0].verified_email, 'fresh@gmail.com');
  assert.strictEqual(sentMail.length, 0, 'the provider already did this');
  assert.strictEqual(verifications.length, 0);

  // And the gate does not apply to them.
  const { token } = await res.json();
  assert.strictEqual((await post('/api/friends/accept', {}, token)).status, 200);
});

test('a new Apple account is created verified, placeholder address included', async () => {
  reset();
  const res = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-2', email: 'fresh@icloud.com', email_verified: true }),
    date_of_birth: '2000-01-01',
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(users[0].email_verified, true);
  assert.strictEqual(sentMail.length, 0);

  // Apple omits the email after the first sign-in; the placeholder is stored
  // verified for ITSELF, so it can never be mailed and never be squatted.
  reset();
  const noEmail = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-3' }),
    date_of_birth: '2000-01-01',
  });
  assert.strictEqual(noEmail.status, 200);
  assert.ok(users[0].email.endsWith('@apple-signin.invalid'));
  assert.strictEqual(users[0].verified_email, users[0].email);
  assert.strictEqual(sentMail.length, 0);
});

// ---------------------------------------------------------------------------
// FINDING 3: the OAuth paths skipped isDisposableEmail, which password signup
// applies — so "block throwaway addresses" was one button away from optional.
// ---------------------------------------------------------------------------
test('disposable addresses are refused on the OAuth paths, not just at signup', async () => {
  reset();
  const google = await withGoogle(
    { sub: 'g-7', email: 'burner@mailinator.com', email_verified: true, name: 'Burner' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: '2000-01-01' })
  );
  assert.strictEqual(google.status, 400);
  assert.strictEqual(users.length, 0);

  const apple = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-4', email: 'burner@sub.mailinator.com', email_verified: true }),
    date_of_birth: '2000-01-01',
  });
  assert.strictEqual(apple.status, 400);
  assert.strictEqual(users.length, 0);

  // Password signup, unchanged.
  const signup = await post('/api/auth/signup', { ...SIGNUP, email: 'burner@guerrillamail.com' });
  assert.strictEqual(signup.status, 400);
});

test('an existing account on a domain added to the list later is not locked out', async () => {
  reset();
  users.push({
    id: 12, email: 'old@mailinator.com', name: 'Old', oauth_provider: 'google', oauth_id: 'g-8',
    password: null, is_banned: false, token_version: 0, email_verified: true,
    verified_email: 'old@mailinator.com', date_of_birth: '2000-01-01',
  });
  const res = await withGoogle(
    { sub: 'g-8', email: 'old@mailinator.com', email_verified: true, name: 'Old' },
    () => post('/api/auth/google', { access_token: 'opaque' })
  );
  assert.strictEqual(res.status, 200, 'the disposable check applies to CREATION only');
});

// ---------------------------------------------------------------------------
// Ban-evasion tombstones (migration 012 + routes/users.js) are consulted from
// HERE, because routes/auth.js owns every account creation path. Without these
// three calls the whole control is inert: the tombstones get written on
// deletion and nothing ever reads them.
// ---------------------------------------------------------------------------
test('a tombstoned identity is refused on every account creation path', async () => {
  reset();
  identityTombstoned = true;

  const signup = await post('/api/auth/signup', SIGNUP);
  assert.strictEqual(signup.status, 403);

  const google = await withGoogle(
    { sub: 'g-20', email: 'evader@gmail.com', email_verified: true, name: 'Evader' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: '2000-01-01' })
  );
  assert.strictEqual(google.status, 403);

  const apple = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-20', email: 'evader@icloud.com', email_verified: true }),
    date_of_birth: '2000-01-01',
  });
  assert.strictEqual(apple.status, 403);

  assert.strictEqual(users.length, 0, 'no row may be created for a tombstoned identity');
  assert.strictEqual(sentMail.length, 0, 'and no verification mail is sent to one either');
});

test('the tombstone check does not displace a squat before refusing', async () => {
  reset();
  users.push({
    id: 50, email: 'victim@gmail.com', name: 'Squatter', password: 'hash',
    oauth_provider: null, oauth_id: null, is_banned: false, token_version: 0,
    email_verified: false, verified_email: null,
  });
  identityTombstoned = true;

  const res = await withGoogle(
    { sub: 'g-21', email: 'victim@gmail.com', email_verified: true, name: 'Evader' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: '2000-01-01' })
  );
  assert.strictEqual(res.status, 403);
  assert.strictEqual(users[0].email, 'victim@gmail.com');
  assert.strictEqual(users.length, 1);
});

test('an ordinary identity is unaffected', async () => {
  reset();
  const { res } = await signupUnverified();
  assert.strictEqual(res.status, 201);
});

// ---------------------------------------------------------------------------
// FINDING 4: Apple identity tokens were replayable for their full ~10 minute
// life. Anything that saw one once — a proxy log, a crash report, an analytics
// SDK that captured the body — could sign in as that user.
// ---------------------------------------------------------------------------
test('an Apple identity token cannot be replayed', async () => {
  reset();
  const identityToken = appleIdentityToken({ sub: 'a-5', email: 'once@icloud.com', email_verified: true });

  const first = await post('/api/auth/apple', { identityToken, date_of_birth: '2000-01-01' });
  assert.strictEqual(first.status, 200);

  const replay = await post('/api/auth/apple', { identityToken, date_of_birth: '2000-01-01' });
  assert.strictEqual(replay.status, 401);
  assert.match((await replay.json()).error, /expired/i);
});

test('a token is only spent on SUCCESS, so a client can retry after an upstream blip', async () => {
  reset();
  appleConfigured = true;
  appleExchange = async () => { throw new Error('Apple is down'); };
  const identityToken = appleIdentityToken({ sub: 'a-6', email: 'retry@icloud.com', email_verified: true });

  const blip = await post('/api/auth/apple', {
    identityToken, authorizationCode: 'code-1', date_of_birth: '2000-01-01',
  });
  assert.strictEqual(blip.status, 503);

  // Same token, Apple is back. This must NOT be mistaken for a replay.
  appleExchange = async () => ({ refresh_token: 'apple-refresh' });
  const retry = await post('/api/auth/apple', {
    identityToken, authorizationCode: 'code-1', date_of_birth: '2000-01-01',
  });
  assert.strictEqual(retry.status, 200);
});

test('the nonce, when a client sends one, must be ours and must match the token', async () => {
  reset();
  const nonceOf = async () => (await (await post('/api/auth/apple/nonce', {})).json()).nonce;

  // Matching, raw spelling.
  let nonce = await nonceOf();
  let res = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-7', email: 'n1@icloud.com', email_verified: true, nonce }),
    nonce, date_of_birth: '2000-01-01',
  });
  assert.strictEqual(res.status, 200);

  // Matching, SHA-256 spelling (what native SDKs put in the request).
  reset();
  nonce = await nonceOf();
  const hashed = crypto.createHash('sha256').update(nonce).digest('hex');
  res = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-8', email: 'n2@icloud.com', email_verified: true, nonce: hashed }),
    nonce, date_of_birth: '2000-01-01',
  });
  assert.strictEqual(res.status, 200);

  // The token carries somebody else's nonce.
  reset();
  nonce = await nonceOf();
  res = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-9', email: 'n3@icloud.com', email_verified: true, nonce: 'not-ours' }),
    nonce, date_of_birth: '2000-01-01',
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(users.length, 0);

  // A nonce we never issued.
  reset();
  res = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-10', email: 'n4@icloud.com', email_verified: true, nonce: 'invented' }),
    nonce: 'invented', date_of_birth: '2000-01-01',
  });
  assert.strictEqual(res.status, 401);

  // A nonce is single use.
  reset();
  nonce = await nonceOf();
  const mk = (sub) => appleIdentityToken({ sub, email: `${sub}@icloud.com`, email_verified: true, nonce });
  assert.strictEqual((await post('/api/auth/apple', { identityToken: mk('a-11'), nonce, date_of_birth: '2000-01-01' })).status, 200);
  assert.strictEqual((await post('/api/auth/apple', { identityToken: mk('a-12'), nonce, date_of_birth: '2000-01-01' })).status, 401);
});

test('a nonce survives a FAILED attempt, so one upstream blip is not a dead end', async () => {
  reset();
  appleConfigured = true;
  appleExchange = async () => { throw new Error('Apple is down'); };
  const nonce = (await (await post('/api/auth/apple/nonce', {})).json()).nonce;
  const identityToken = appleIdentityToken({ sub: 'a-18', email: 'n7@icloud.com', email_verified: true, nonce });

  const blip = await post('/api/auth/apple', {
    identityToken, nonce, authorizationCode: 'code-3', date_of_birth: '2000-01-01',
  });
  assert.strictEqual(blip.status, 503);

  // Spending the nonce on failure would force the user back through Apple's
  // whole authorization sheet for something that was never their fault.
  appleExchange = async () => ({ refresh_token: 'apple-refresh' });
  const retry = await post('/api/auth/apple', {
    identityToken, nonce, authorizationCode: 'code-3', date_of_birth: '2000-01-01',
  });
  assert.strictEqual(retry.status, 200);
});

test('a token bound to a nonce the client did not disclose is refused', async () => {
  reset();
  const res = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-13', email: 'n5@icloud.com', email_verified: true, nonce: 'hidden' }),
    date_of_birth: '2000-01-01',
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(users.length, 0);
});

test('APPLE_REQUIRE_NONCE makes the nonce mandatory once clients send one', async () => {
  reset();
  process.env.APPLE_REQUIRE_NONCE = 'true';
  try {
    const res = await post('/api/auth/apple', {
      identityToken: appleIdentityToken({ sub: 'a-14', email: 'n6@icloud.com', email_verified: true }),
      date_of_birth: '2000-01-01',
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(users.length, 0);
  } finally {
    delete process.env.APPLE_REQUIRE_NONCE;
  }
});

test('the nonce claim comparison is constant time and accepts both spellings', () => {
  const nonce = 'abcdefgh';
  const hashed = crypto.createHash('sha256').update(nonce).digest('hex');
  assert.strictEqual(appleNonceClaimMatches(nonce, nonce), true);
  assert.strictEqual(appleNonceClaimMatches(hashed, nonce), true);
  assert.strictEqual(appleNonceClaimMatches('', nonce), false);
  assert.strictEqual(appleNonceClaimMatches('abcdefgi', nonce), false);
});

// ---------------------------------------------------------------------------
// FINDING 5: the authorizationCode requirement ran AFTER the row was created,
// so a new Apple user who arrived without one got a permanently unusable
// account: linked to their Apple sub, holding no refresh token, and rejected
// for the same missing code on every subsequent sign-in.
// ---------------------------------------------------------------------------
test('a new Apple user arriving without an authorizationCode leaves no orphan row', async () => {
  reset();
  appleConfigured = true;

  const res = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-15', email: 'orphan@icloud.com', email_verified: true }),
    date_of_birth: '2000-01-01',
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(users.length, 0, 'nothing may be written before the code requirement is decided');

  // And the retry, with a code, works — which it could not if a row existed.
  const ok = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-15', email: 'orphan@icloud.com', email_verified: true }),
    authorizationCode: 'code-2', date_of_birth: '2000-01-01',
  });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(users.length, 1);
  assert.strictEqual(users[0].apple_refresh_token, 'apple-refresh');
});

test('the code requirement does not evict a squat before refusing', async () => {
  reset();
  appleConfigured = true;
  users.push({
    id: 20, email: 'victim@icloud.com', name: 'Squatter', password: 'hash',
    oauth_provider: null, oauth_id: null, is_banned: false, token_version: 0,
    email_verified: false, verified_email: null,
  });

  const res = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-16', email: 'victim@icloud.com', email_verified: true }),
    date_of_birth: '2000-01-01',
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(users.length, 1);
  assert.strictEqual(users[0].email, 'victim@icloud.com');
});

test('an existing Apple user with a stored refresh token still signs in without a code', async () => {
  reset();
  appleConfigured = true;
  users.push({
    id: 21, email: 'known@icloud.com', name: 'Known', oauth_provider: 'apple', oauth_id: 'a-17',
    password: null, is_banned: false, token_version: 0, email_verified: true,
    verified_email: 'known@icloud.com', date_of_birth: '2000-01-01', apple_refresh_token: 'stored',
  });
  const res = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-17' }),
  });
  assert.strictEqual(res.status, 200);
});

// ---------------------------------------------------------------------------
// FINDING 6: /login answered "This account uses Google Sign-In" before doing
// any bcrypt work. That confirmed the address exists AND named its provider,
// and because it returned without hashing, the same three-way split was
// readable from the response time no matter how the message was worded.
// ---------------------------------------------------------------------------
test('login never reveals that an address is an OAuth account', async () => {
  reset();
  users.push({
    id: 30, email: 'oauth@gmail.com', name: 'OAuth', password: null,
    oauth_provider: 'google', oauth_id: 'g-9', is_banned: false, token_version: 0,
    email_verified: true, verified_email: 'oauth@gmail.com', date_of_birth: '2000-01-01',
  });

  const known = await post('/api/auth/login', { email: 'oauth@gmail.com', password: 'Password1' });
  const unknown = await post('/api/auth/login', { email: 'nobody@gmail.com', password: 'Password1' });

  assert.strictEqual(known.status, unknown.status);
  assert.deepStrictEqual(await known.json(), await unknown.json());
  assert.strictEqual((await (await post('/api/auth/login', { email: 'oauth@gmail.com', password: 'Password1' })).json()).error,
    'Invalid email or password');
});

test('login on an OAuth account still costs a bcrypt compare, so the clock says nothing', async () => {
  reset();
  const bcrypt = require('bcryptjs');
  users.push({
    id: 31, email: 'oauth2@gmail.com', name: 'OAuth', password: null,
    oauth_provider: 'google', oauth_id: 'g-10', is_banned: false, token_version: 0,
    email_verified: true, date_of_birth: '2000-01-01',
  });
  users.push({
    id: 32, email: 'pw@gmail.com', name: 'Pw', password: bcrypt.hashSync('Password1', 10),
    oauth_provider: null, oauth_id: null, is_banned: false, token_version: 0,
    email_verified: true, date_of_birth: '2000-01-01',
  });

  const time = async (email) => {
    const t = process.hrtime.bigint();
    await post('/api/auth/login', { email, password: 'WrongPass1' });
    return Number(process.hrtime.bigint() - t) / 1e6;
  };
  const oauthMs = await time('oauth2@gmail.com');
  const unknownMs = await time('nobody-here@gmail.com');
  const passwordMs = await time('pw@gmail.com');

  // The old code returned in microseconds for the OAuth row. The bar here is
  // deliberately loose (CI is noisy) but far above that: all three paths must
  // be in the same order of magnitude as a real bcrypt compare.
  assert.ok(oauthMs > passwordMs / 4, `oauth ${oauthMs}ms vs password ${passwordMs}ms`);
  assert.ok(unknownMs > passwordMs / 4, `unknown ${unknownMs}ms vs password ${passwordMs}ms`);
});

test('an unverified password account can still sign in', async () => {
  reset();
  await signupUnverified();
  const res = await post('/api/auth/login', { email: 'new@example.com', password: 'Password1' });
  assert.strictEqual(res.status, 200);
});

// ---------------------------------------------------------------------------
// The gate itself. It must not become the unanchored URL match the ban check
// used to be, which `DELETE /api/flocks/42?x=/users/me` walked straight past.
// ---------------------------------------------------------------------------
test('the gate matches the routed path, not the raw URL, and normalises the way Express does', () => {
  const req = (method, baseUrl, path) => ({ method, baseUrl, path });

  assert.strictEqual(unverifiedBlocked(req('POST', '/api/friends', '/accept')), true);
  assert.strictEqual(unverifiedBlocked(req('POST', '/api/friends', '/accept/')), true, 'trailing slash');
  assert.strictEqual(unverifiedBlocked(req('POST', '/api/FRIENDS', '/Accept')), true, 'Express routing is case insensitive');
  assert.strictEqual(unverifiedBlocked(req('POST', '/api', '/friends/accept')), true, 'reached via the /api catch-all');
  assert.strictEqual(unverifiedBlocked(req('POST', '/api/friends', '//accept')), true, 'doubled slash');
  assert.strictEqual(unverifiedBlocked(req('POST', '/api/friends', '/%61ccept')), true, 'percent-encoded');
  assert.strictEqual(unverifiedBlocked(req('POST', '/api/flocks', '/')), true, 'creating a flock makes you a member');
  assert.strictEqual(unverifiedBlocked(req('POST', '/api/flocks', '/9/join')), true);
  assert.strictEqual(unverifiedBlocked(req('POST', '/api/flocks', '/abc/join')), true, 'a non-numeric id is still gated');

  // Wrong verb, wrong route, and the query-string smuggle that defeated the old
  // ban carve-out. req.path never contains a query string.
  assert.strictEqual(unverifiedBlocked(req('GET', '/api/friends', '/accept')), false);
  assert.strictEqual(unverifiedBlocked(req('POST', '/api/friends', '/decline')), false);
  assert.strictEqual(unverifiedBlocked(req('POST', '/api/friends', '/accept-all')), false);
  assert.strictEqual(unverifiedBlocked(req('POST', '/api/flocks', '/9/leave')), false);
  assert.strictEqual(unverifiedBlocked(req('DELETE', '/api/users', '/me')), false, 'erasure is never gated');
  assert.strictEqual(unverifiedBlocked({ method: 'POST' }), false, 'a request with no path must not throw');

  assert.strictEqual(normalizeGatePath('/API/Users/'), '/api/users');
  assert.strictEqual(normalizeGatePath('///'), '/');
  assert.strictEqual(normalizeGatePath(undefined), '/');
});

test('a malformed percent-escape does not throw the request into a 500', async () => {
  reset();
  const { token } = await signupUnverified();
  const res = await fetch(`${base}/api/flocks/%E0%A4%A/join`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
});

test('requireVerified is exported for routes to mount explicitly', () => {
  assert.strictEqual(typeof authMod.requireVerified, 'function');
  const seen = [];
  const res = { status(c) { seen.push(c); return this; }, json(b) { seen.push(b); return this; } };
  authMod.requireVerified({ user: { email_verified: false } }, res, () => seen.push('next'));
  assert.deepStrictEqual(seen[0], 403);
  seen.length = 0;
  authMod.requireVerified({ user: { email_verified: true } }, res, () => seen.push('next'));
  assert.deepStrictEqual(seen, ['next']);
  seen.length = 0;
  // A row read without the column must not be treated as unverified.
  authMod.requireVerified({ user: {} }, res, () => seen.push('next'));
  assert.deepStrictEqual(seen, ['next']);
  seen.length = 0;
  // Mounted before authenticate is a wiring mistake, not permission to pass.
  authMod.requireVerified({}, res, () => seen.push('next'));
  assert.deepStrictEqual(seen[0], 403);
});

test('a banned unverified user is still refused with the ban message, not the verification one', async () => {
  reset();
  users.push({
    id: 40, email: 'b@example.com', name: 'B', role: 'user', is_banned: true,
    token_version: 0, email_verified: false,
  });
  const token = signUserToken(users[0]);
  const res = await post('/api/friends/accept', {}, token);
  assert.strictEqual(res.status, 403);
  assert.match((await res.json()).error, /suspended/i);
});
