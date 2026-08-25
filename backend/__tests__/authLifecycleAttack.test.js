// Run: node --test  (from backend/)
//
// ADVERSARIAL ROUND — AUTHENTICATION AND SESSION LIFECYCLE.
//
// Previous rounds attacked sockets, uploads, XSS, migrations, email, the AI
// valve, cohort privacy and object-level authorization. This file attacks the
// thing that decides WHO a request is and for HOW LONG: the JWT and its `tv`
// claim, password reset, email verification, the two OAuth sign-ins, and the
// ban-evasion tombstones.
//
// Every test here is an ATTACK, not a unit test. Each one names the exploit it
// is trying to run and asserts the observable refusal. A test that passes
// because a fixture returned zero rows is worthless, so the pool dispatcher
// below records every statement it did not recognise and every test calls
// assertQueriesUnderstood(): an unrecognised statement fails the test that
// provoked it, and a test that provoked NO database work at all fails too.
//
// Nothing here touches a real database or a real network.

// Env must be set before ANY require: routes/auth.js reads GOOGLE_CLIENT_ID at
// module load, services/emailService.js reads the two public URLs, and
// routes/users.js reads BAN_TOMBSTONE_SECRET when it digests an identity.
process.env.JWT_SECRET = 'test-secret-for-auth-lifecycle-attack';
process.env.GOOGLE_CLIENT_ID = 'flock-attack.apps.googleusercontent.com';
process.env.PUBLIC_WEB_URL = 'https://web.flock.test';
process.env.PUBLIC_API_URL = 'https://api.flock.test';
process.env.BAN_TOMBSTONE_SECRET = 'tombstone-pepper-for-attack-tests';
process.env.RESEND_API_KEY = 'test-resend-key';
delete process.env.APPLE_TEAM_ID;
delete process.env.APPLE_KEY_ID;
delete process.env.APPLE_PRIVATE_KEY;
delete process.env.APPLE_REQUIRE_NONCE;
delete process.env.GOOGLE_REQUIRE_NONCE;
delete process.env.NODE_ENV;

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

// ---------------------------------------------------------------------------
// Module stubs, installed in the require cache BEFORE the routers load.
// ---------------------------------------------------------------------------
const { publicKey: APPLE_PUB, privateKey: APPLE_PRIV } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
// An attacker key pair: same shape, not Apple's.
const { privateKey: EVIL_PRIV } = crypto.generateKeyPairSync('rsa', {
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
        this.emails = { send: async (msg) => { sentMail.push(msg); return { data: { id: 'm' }, error: null }; } };
      }
    },
  },
};

const appleAuthPath = require.resolve('../services/appleAuth');
require.cache[appleAuthPath] = {
  id: appleAuthPath, filename: appleAuthPath, loaded: true,
  exports: {
    isConfigured: () => false,
    exchangeAppleCode: async () => ({ refresh_token: 'apple-refresh' }),
    revokeAppleToken: async () => true,
  },
};

const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const authRouter = require('../routes/auth');
const authMod = require('../middleware/auth');
const { signUserToken, authenticate, authenticateSocket, requireVerified } = authMod;
const { canonicalEmail } = authRouter.__testing;
const checkinRouter = require('../routes/checkin');
const { tryAuth } = checkinRouter.__test;
const { revalidateSession, evaluateSession } = require('../sockets/handlers');

const SECRET = process.env.JWT_SECRET;

const appleIdentityToken = (claims, key = APPLE_PRIV) => jwt.sign(
  { iss: 'https://appleid.apple.com', aud: 'com.flockcorp.flock', ...claims },
  key,
  { algorithm: 'RS256', expiresIn: '10m', keyid: 'test-kid' }
);

// ===========================================================================
// FIXTURE-BACKED POOL DISPATCHER
// ===========================================================================
let users = [];
let verifications = [];
let resets = [];
let resetRequests = [];
let bannedIdentities = [];
let nextId = 1;
let unknownQueries = [];
let understoodQueries = 0;
// Set to force isIdentityBanned's catch (it fails open by design — we attack
// that decision rather than assume it).
let banLookupThrows = false;
// How many times the statement that actually FLIPS email_verified committed.
// The race test below counts writes, not 200s: consumeVerification deliberately
// answers a spent token with "already confirmed" when the account is verified
// (mailbox scanners prefetch links), so the status code cannot tell a winner
// from a loser. The write can.
let verifyWrites = 0;

const byCanonical = (email) => {
  const exact = users.find((u) => String(u.email).toLowerCase() === String(email).toLowerCase());
  if (exact) return exact;
  return users.find((u) => canonicalEmail(u.email) === canonicalEmail(email)) || null;
};

// A clause is applied only if the statement that arrived actually says to apply
// it. Delete the clause from routes/auth.js and the effect disappears here too,
// which is what keeps the assertions load-bearing on the route.
const clause = (sql, re) => re.test(sql);

const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  const ok = (v) => { understoodQueries += 1; return v; };

  // ---- users: reads ------------------------------------------------------
  if (sql.includes('split_part') && sql.startsWith('SELECT * FROM users')) {
    const hit = byCanonical(params[0]);
    return ok({ rows: hit ? [hit] : [] });
  }
  if (sql.includes("oauth_provider = 'google' AND oauth_id")) {
    return ok({ rows: users.filter((u) => u.oauth_provider === 'google' && u.oauth_id === params[0]) });
  }
  if (sql.includes("oauth_provider = 'apple' AND oauth_id")) {
    return ok({ rows: users.filter((u) => u.oauth_provider === 'apple' && u.oauth_id === params[0]) });
  }
  if (sql === 'SELECT * FROM users WHERE LOWER(email) = LOWER($1)') {
    return ok({ rows: users.filter((u) => String(u.email).toLowerCase() === String(params[0]).toLowerCase()) });
  }
  // Every id-keyed projection any verifier in the app uses. Each is matched on
  // its OWN column list so a verifier that stops selecting token_version stops
  // receiving it here — that is exactly the drift this file is hunting.
  if (/^SELECT [\w, ()."']+ FROM users WHERE id = \$1$/.test(sql)) {
    const cols = sql.slice('SELECT '.length, sql.indexOf(' FROM')).split(',').map((c) => c.trim());
    const rows = users.filter((u) => u.id === params[0]).map((u) => {
      const out = {};
      for (const col of cols) {
        const name = col.includes(' AS ') ? col.split(' AS ')[1].trim() : col;
        out[name] = u[name];
      }
      return out;
    });
    return ok({ rows });
  }
  if (sql.startsWith('SELECT date_of_birth FROM users WHERE id')) {
    return ok({ rows: users.filter((u) => u.id === params[0]).map((u) => ({ date_of_birth: u.date_of_birth })) });
  }

  // ---- users: writes -----------------------------------------------------
  if (sql.startsWith('INSERT INTO users')) {
    const row = {
      id: nextId++, token_version: 0, is_banned: false, password: null,
      oauth_provider: null, oauth_id: null, date_of_birth: null,
      verified_email: null, email_verified: false, role: 'user',
      venmo_username: null, cashapp_cashtag: null, zelle_identifier: null,
      apple_refresh_token: null, phone: null, profile_image_url: null,
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
    return ok({ rows: [row], rowCount: 1 });
  }
  if (sql.startsWith("UPDATE users SET oauth_provider = 'google'")) {
    const row = users.find((u) => u.id === params[2]);
    if (!row) return ok({ rows: [], rowCount: 0 });
    row.oauth_provider = 'google';
    row.oauth_id = params[0];
    if (clause(sql, /\bpassword = NULL\b/)) row.password = null;
    if (clause(sql, /\bemail_verified = TRUE\b/)) row.email_verified = true;
    if (clause(sql, /\bverified_email = email\b/)) row.verified_email = row.email;
    if (clause(sql, /\bvenmo_username = NULL\b/)) row.venmo_username = null;
    if (clause(sql, /\bcashapp_cashtag = NULL\b/)) row.cashapp_cashtag = null;
    if (clause(sql, /\bzelle_identifier = NULL\b/)) row.zelle_identifier = null;
    if (clause(sql, /token_version = token_version \+ 1/)) row.token_version += 1;
    return ok({ rows: [row], rowCount: 1 });
  }
  if (sql.startsWith("UPDATE users SET oauth_provider = 'apple'")) {
    const row = users.find((u) => u.id === params[1]);
    if (!row) return ok({ rows: [], rowCount: 0 });
    row.oauth_provider = 'apple';
    row.oauth_id = params[0];
    if (clause(sql, /\bpassword = NULL\b/)) row.password = null;
    if (clause(sql, /\bemail_verified = TRUE\b/)) row.email_verified = true;
    if (clause(sql, /\bverified_email = email\b/)) row.verified_email = row.email;
    if (clause(sql, /\bvenmo_username = NULL\b/)) row.venmo_username = null;
    if (clause(sql, /\bcashapp_cashtag = NULL\b/)) row.cashapp_cashtag = null;
    if (clause(sql, /\bzelle_identifier = NULL\b/)) row.zelle_identifier = null;
    if (clause(sql, /token_version = token_version \+ 1/)) row.token_version += 1;
    return ok({ rows: [row], rowCount: 1 });
  }
  if (sql.startsWith('UPDATE users SET email = $1, email_verified = FALSE')) {
    const row = users.find((u) => u.id === params[1]
      && (!clause(sql, /WHERE id = \$2 AND email_verified = FALSE/) || u.email_verified === false));
    if (!row) return ok({ rows: [], rowCount: 0 });
    row.email = params[0];
    if (clause(sql, /\bemail_verified = FALSE,/)) row.email_verified = false;
    if (clause(sql, /\bverified_email = NULL\b/)) row.verified_email = null;
    if (clause(sql, /\bvenmo_username = NULL\b/)) row.venmo_username = null;
    if (clause(sql, /\bcashapp_cashtag = NULL\b/)) row.cashapp_cashtag = null;
    if (clause(sql, /\bzelle_identifier = NULL\b/)) row.zelle_identifier = null;
    if (clause(sql, /token_version = token_version \+ 1/)) row.token_version += 1;
    return ok({ rows: [row], rowCount: 1 });
  }
  if (sql.startsWith('UPDATE users SET email_verified = TRUE, verified_email = email')) {
    const row = users.find((u) => u.id === params[0]
      && (!clause(sql, /LOWER\(email\) = LOWER\(\$2\)/)
        || String(u.email).toLowerCase() === String(params[1]).toLowerCase()));
    if (!row) return ok({ rows: [], rowCount: 0 });
    if (clause(sql, /\bemail_verified = TRUE\b/)) row.email_verified = true;
    if (clause(sql, /\bverified_email = email\b/)) row.verified_email = row.email;
    verifyWrites += 1;
    return ok({ rows: [row], rowCount: 1 });
  }
  if (sql.startsWith('UPDATE users SET password = $1')) {
    // consumeReset. Every guard on the WHERE is read off the statement.
    const row = users.find((u) => u.id === params[1]
      && (!clause(sql, /oauth_provider IS NULL/) || !u.oauth_provider)
      && (!clause(sql, /is_banned IS NOT TRUE/) || u.is_banned !== true)
      && (!clause(sql, /LOWER\(email\) = LOWER\(\$3\)/)
        || String(u.email).toLowerCase() === String(params[2]).toLowerCase()));
    if (!row) return ok({ rows: [], rowCount: 0 });
    row.password = params[0];
    if (clause(sql, /token_version = token_version \+ 1/)) row.token_version += 1;
    return ok({ rows: [row], rowCount: 1 });
  }
  if (sql.startsWith('UPDATE users SET token_version = token_version + 1')) {
    const row = users.find((u) => u.id === params[0]);
    if (!row) return ok({ rows: [], rowCount: 0 });
    row.token_version += 1;
    return ok({ rows: [row], rowCount: 1 });
  }
  if (sql.startsWith('UPDATE users SET date_of_birth')) {
    const row = users.find((u) => u.id === params[1]
      && (!clause(sql, /AND date_of_birth IS NULL/) || u.date_of_birth == null));
    if (!row) return ok({ rows: [], rowCount: 0 });
    row.date_of_birth = params[0];
    if (clause(sql, /token_version = token_version \+ 1/)) row.token_version += 1;
    return ok({ rows: [row], rowCount: 1 });
  }
  if (sql.startsWith('UPDATE users SET apple_refresh_token')) return ok({ rows: [], rowCount: 0 });

  // ---- email_verifications ----------------------------------------------
  if (sql.startsWith('INSERT INTO email_verifications')) {
    verifications.push({
      id: verifications.length + 1, user_id: params[0], selector: params[1],
      verifier_hash: params[2], email: params[3], request_ip: params[4],
      expires_at: new Date(Date.now() + params[5] * 3600 * 1000).toISOString(),
      used_at: null, created_at: new Date().toISOString(),
    });
    return ok({ rows: [], rowCount: 1 });
  }
  if (sql.startsWith('UPDATE email_verifications SET used_at')) {
    let n = 0;
    for (const v of verifications) {
      const hit = sql.includes('WHERE id = $1') ? v.id === params[0] : v.user_id === params[0];
      const unused = !clause(sql, /AND used_at IS NULL/) || !v.used_at;
      const live = !clause(sql, /AND expires_at > NOW\(\)/) || Date.parse(v.expires_at) > Date.now();
      if (hit && unused && live) { v.used_at = new Date().toISOString(); n += 1; }
    }
    return ok({ rows: n ? [{ id: params[0] }] : [], rowCount: n });
  }
  if (sql.startsWith('SELECT COUNT(*)') && sql.includes('FROM email_verifications')) {
    const mine = verifications.filter((v) => v.user_id === params[0]);
    return ok({
      rows: [{
        account_hour: mine.length, account_day: mine.length,
        account_last: mine.length ? mine[mine.length - 1].created_at : null,
        ip_hour: verifications.filter((v) => v.request_ip === params[1]).length,
      }],
    });
  }
  if (sql.startsWith('SELECT v.id, v.user_id')) {
    const v = verifications.find((x) => x.selector === params[0]);
    if (!v) return ok({ rows: [] });
    const u = users.find((x) => x.id === v.user_id);
    return ok({ rows: [{ ...v, current_email: u?.email, email_verified: u?.email_verified }] });
  }

  // ---- password_resets / password_reset_requests -------------------------
  if (sql.startsWith('INSERT INTO password_resets')) {
    resets.push({
      id: resets.length + 1, user_id: params[0], selector: params[1],
      verifier_hash: params[2], email: params[3], request_ip: params[4],
      expires_at: new Date(Date.now() + params[5] * 60 * 1000).toISOString(),
      used_at: null, created_at: new Date().toISOString(),
    });
    return ok({ rows: [], rowCount: 1 });
  }
  if (sql.startsWith('UPDATE password_resets SET used_at')) {
    let n = 0;
    for (const r of resets) {
      const hit = sql.includes('WHERE id = $1') ? r.id === params[0] : r.user_id === params[0];
      const unused = !clause(sql, /AND used_at IS NULL/) || !r.used_at;
      const live = !clause(sql, /AND expires_at > NOW\(\)/) || Date.parse(r.expires_at) > Date.now();
      if (hit && unused && live) { r.used_at = new Date().toISOString(); n += 1; }
    }
    return ok({ rows: n ? [{ id: params[0] }] : [], rowCount: n });
  }
  if (sql.startsWith('SELECT r.id, r.user_id')) {
    const r = resets.find((x) => x.selector === params[0]);
    if (!r) return ok({ rows: [] });
    const u = users.find((x) => x.id === r.user_id);
    if (!u) return ok({ rows: [] });
    return ok({
      rows: [{
        ...r, current_email: u.email, oauth_provider: u.oauth_provider,
        is_banned: u.is_banned, has_password: u.password != null,
      }],
    });
  }
  if (sql.startsWith('INSERT INTO password_reset_requests')) {
    resetRequests.push({ email_key: params[0], request_ip: params[1], created_at: new Date().toISOString() });
    return ok({ rows: [], rowCount: 1 });
  }
  if (sql.startsWith('SELECT COUNT(*)') && sql.includes('FROM password_reset_requests')) {
    const mine = resetRequests.filter((r) => r.email_key === params[0]);
    return ok({
      rows: [{
        email_hour: mine.length, email_day: mine.length,
        email_last: mine.length ? mine[mine.length - 1].created_at : null,
        ip_hour: resetRequests.filter((r) => r.request_ip === params[1]).length,
      }],
    });
  }
  if (sql.startsWith('DELETE FROM password_reset_requests')) return ok({ rows: [], rowCount: 0 });
  if (sql.startsWith('DELETE FROM password_resets')) return ok({ rows: [], rowCount: 0 });

  // ---- email suppression (services/emailSuppression.js) ------------------
  if (sql.includes('email_suppressions')) return ok({ rows: [], rowCount: 0 });

  // ---- banned_identities (migration 012) ---------------------------------
  if (sql.includes('banned_identities')) {
    if (banLookupThrows) { understoodQueries += 1; throw new Error('simulated database failure'); }
    const [emailHash, phoneHash, oauthHash] = params;
    const hit = bannedIdentities.find((b) => Date.parse(b.expires_at) > Date.now()
      && ((emailHash && b.email_hash === emailHash)
        || (phoneHash && b.phone_hash === phoneHash)
        || (oauthHash && b.oauth_hash === oauthHash)));
    return ok({ rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 });
  }

  unknownQueries.push(sql);
  return { rows: [], rowCount: 0 };
};

// The guard that makes a green test mean something. A statement the dispatcher
// did not recognise silently returned zero rows, which is how a fixture makes a
// route look safe when it is not — so it fails the test that provoked it. And a
// test that provoked no database work at all is asserting on nothing.
function assertQueriesUnderstood(minQueries = 1) {
  assert.deepStrictEqual(unknownQueries, [], `unrecognised SQL reached the fixture: ${unknownQueries[0]}`);
  assert.ok(understoodQueries >= minQueries,
    `expected at least ${minQueries} recognised queries, saw ${understoodQueries}`);
}

// ---------------------------------------------------------------------------
// App under test
// ---------------------------------------------------------------------------
let disconnectedRooms = [];
const fakeIo = { in: (room) => ({ disconnectSockets: (close) => disconnectedRooms.push(`${room}|${close}`) }) };

const app = express();
app.use(express.json());
// server.js runs behind Railway's edge with `app.set('trust proxy', 1)`, so
// req.ip is the forwarded client address rather than the socket peer. The H1
// tests need two different callers, and the source address is half of what the
// under-13 lockout keys on, so the harness has to be able to spell one. Set to
// `true` rather than 1 because there is no real proxy in front of this server
// to contribute the second hop. A request that sends no X-Forwarded-For still
// gets 127.0.0.1, which is what every other test in this file relies on.
app.set('trust proxy', true);
app.set('io', fakeIo);
app.use('/api/auth', authRouter);
app.get('/api/protected', authenticate, (req, res) => res.json({ id: req.user.id }));

// The gated surfaces are mounted the way server.js mounts them — a Router under
// a prefix, `authenticate` inside it — because the deny list in
// middleware/auth.js matches `req.baseUrl + req.path`, and those two values only
// take their production shapes under a real mount. A route registered as one
// flat `app.post('/api/friends/request')` would give req.baseUrl = '' and hide
// exactly the half of the expression the gate depends on.
const friendsRouter = express.Router();
friendsRouter.use(authenticate);
friendsRouter.post('/request', (req, res) => res.json({ ok: true }));
friendsRouter.post('/accept', (req, res) => res.json({ ok: true }));
app.use('/api/friends', friendsRouter);

const flocksRouter = express.Router();
flocksRouter.use(authenticate);
flocksRouter.post('/', (req, res) => res.json({ ok: true }));
flocksRouter.post('/:id/join', (req, res) => res.json({ ok: true }));
// rerun carries requireVerified explicitly, exactly as routes/flocks.js does.
flocksRouter.post('/:id/rerun', requireVerified, (req, res) => res.json({ ok: true }));
app.use('/api/flocks', flocksRouter);

const usersRouterStub = express.Router();
usersRouterStub.use(authenticate);
usersRouterStub.put('/venmo-username', (req, res) => res.json({ ok: true }));
app.use('/api/users', usersRouterStub);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => { pool.query = realQuery; pool.end().catch(() => {}); });

const call = (method, path, body, token) => fetch(base + path, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const post = (path, body, token) => call('POST', path, body || {}, token);
// The same POST, from a chosen client address. `trust proxy` is on above, so
// Express reads req.ip out of this header the way it reads it out of Railway's.
const postFrom = (ip, path, body, token) => fetch(base + path, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Forwarded-For': ip,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body || {}),
});
const put = (path, body, token) => call('PUT', path, body || {}, token);
const get = (path, token) => call('GET', path, undefined, token);

function reset() {
  users = []; verifications = []; resets = []; resetRequests = []; bannedIdentities = [];
  nextId = 1; disconnectedRooms = []; sentMail = []; unknownQueries = []; understoodQueries = 0;
  banLookupThrows = false; verifyWrites = 0;
  authRouter.__testing.clearUnderageAttempts();
  // The access-token branch is single-use as of R5-H2, and several tests below
  // present the same short literal ('tok'). Independent tests must not inherit
  // each other's spent credentials; H2 does its replay work inside one test.
  authRouter.__testing.clearOauthIdentityClaims();
}

function seedUser(over = {}) {
  const row = {
    id: nextId++, email: `u${nextId}@example.com`, name: 'User', role: 'user',
    password: bcrypt.hashSync('Password1', 4), oauth_provider: null, oauth_id: null,
    token_version: 0, is_banned: false, email_verified: true, verified_email: null,
    date_of_birth: '2000-01-01', phone: null, profile_image_url: null,
    venmo_username: null, cashapp_cashtag: null, zelle_identifier: null,
    apple_refresh_token: null, created_at: new Date().toISOString(),
  };
  if (row.email_verified && over.verified_email === undefined) row.verified_email = row.email;
  Object.assign(row, over);
  users.push(row);
  return row;
}

// The three non-Express verifiers, driven directly.
const socketHandshake = (token) => new Promise((resolve) => {
  const socket = { handshake: { auth: { token } }, user: null };
  authenticateSocket(socket, (err) => resolve({ err: err ? err.message : null, socket }));
});
const restAuth = async (token, path = '/api/protected') => {
  const res = await get(path, token);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// Google's tokeninfo + userinfo, stubbed for one call.
async function withGoogle(profile, fn, aud = process.env.GOOGLE_CLIENT_ID) {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('googleapis.com')) {
      if (u.includes('tokeninfo')) return { ok: true, json: async () => ({ aud }) };
      return { ok: true, json: async () => profile };
    }
    return saved(url, init);
  };
  try { return await fn(); } finally { globalThis.fetch = saved; }
}

// A stand-in for a Google ID token. verifyIdToken is stubbed per call so the
// handler's own ordering (shape regex, verify, replay claim, nonce) still runs.
async function withGoogleIdToken(payload, fn, { fail = null } = {}) {
  const client = require('google-auth-library').OAuth2Client;
  const saved = client.prototype.verifyIdToken;
  client.prototype.verifyIdToken = async ({ idToken, audience }) => {
    if (fail) throw new Error(fail);
    if (!audience) throw new Error('audience must be checked');
    const aud = payload.aud || audience;
    if (aud !== audience) throw new Error('Wrong recipient');
    if (payload.iss && payload.iss !== 'https://accounts.google.com') throw new Error('Invalid token issuer');
    if (payload.exp && payload.exp * 1000 < Date.now() - 300000) throw new Error('Token used too late');
    // Bind the returned payload to the wire string the caller presented, the
    // way a real verifier does: the replay key is derived from BOTH.
    void idToken;
    return { getPayload: () => payload };
  };
  try { return await fn(); } finally { client.prototype.verifyIdToken = saved; }
}

const googleWire = (payload) => {
  const seg = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'RS256', kid: 'g' })}.${seg(payload)}.${crypto.randomBytes(256).toString('base64url')}`;
};

// ===========================================================================
// A. THE JWT ITSELF — forgery, algorithm confusion, secret guessing
// ===========================================================================
// Attack: mint a token this server never signed and reach an authenticated
// route with it. Five spellings, run against EVERY verifier in the app, because
// a pin that exists in middleware/auth.js and not in the socket revalidator or
// in routes/checkin.js tryAuth is not a pin.
test('A1 — forged tokens are refused by every verifier in the app', async () => {
  reset();
  const victim = seedUser({ email: 'victim@example.com' });

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claims = { userId: victim.id, tv: 0, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 };

  const forged = {
    // 1. alg:none, no signature at all.
    none: `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`,
    // 2. alg:none with a junk signature (some libraries only check emptiness).
    noneWithSig: `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.AAAA`,
    // 3. RS256 signed with an attacker key — the classic asymmetric swap.
    rs256: jwt.sign(claims, EVIL_PRIV, { algorithm: 'RS256' }),
    // 4. HS256 signed with the EMPTY secret.
    emptySecret: jwt.sign(claims, ' ', { algorithm: 'HS256' }).replace(/\.[^.]+$/, `.${crypto
      .createHmac('sha256', '')
      .update(`${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`)
      .digest('base64url')}`),
    // 5. HS512 — a DIFFERENT HMAC algorithm signed with the REAL secret. This
    //    is the one an unpinned verifier accepts, and it is what round 23 found
    //    live in routes/checkin.js.
    hs512: jwt.sign(claims, SECRET, { algorithm: 'HS512' }),
    // 6. HS256 signed with a guessed secret.
    wrongSecret: jwt.sign(claims, 'hunter2', { algorithm: 'HS256' }),
  };

  for (const [name, token] of Object.entries(forged)) {
    const rest = await restAuth(token);
    assert.strictEqual(rest.status, 401, `REST accepted a ${name} token`);

    const hs = await socketHandshake(token);
    assert.ok(hs.err, `socket handshake accepted a ${name} token`);
    assert.strictEqual(hs.socket.user, null);

    const checkin = await tryAuth({ headers: { authorization: `Bearer ${token}` } });
    assert.strictEqual(checkin, null, `routes/checkin.js tryAuth accepted a ${name} token`);

    const sock = { id: 's', user: { id: victim.id }, rooms: new Set(), handshake: { auth: { token } }, disconnect() {}, emit() {} };
    const verdict = await revalidateSession(sock);
    assert.strictEqual(verdict, 'session_expired', `socket revalidation kept a ${name} token alive`);
  }

  // The control: the genuine token this server minted is accepted everywhere.
  const real = signUserToken(victim);
  assert.strictEqual((await restAuth(real)).status, 200);
  assert.strictEqual((await socketHandshake(real)).err, null);
  assert.strictEqual(await tryAuth({ headers: { authorization: `Bearer ${real}` } }), victim.id);
  assertQueriesUnderstood(3);
});

// Attack: the token is genuine but the header is dressed up, so two readers of
// the same header disagree about which string was verified.
test('A2 — header-splitting variants cannot make two readers disagree', async () => {
  reset();
  const u = seedUser({ email: 'hdr@example.com' });
  const real = signUserToken(u);

  // `Bearer <token> junk` — middleware/auth.js and routes/users.js both take
  // split(' ')[1], so both read the same string. Documented in server.js.
  const res = await fetch(`${base}/api/protected`, { headers: { Authorization: `Bearer ${real} junk` } });
  assert.strictEqual(res.status, 200);

  for (const header of ['bearer ' + real, 'Bearer  ' + real, 'Token ' + real, 'Bearer', 'Bearer ']) {
    const r = await fetch(`${base}/api/protected`, { headers: { Authorization: header } });
    assert.strictEqual(r.status, 401, `header "${header.slice(0, 20)}" was accepted`);
  }
  assertQueriesUnderstood(1);
});

// Attack: `authenticateAllowBanned` is the one middleware that waives a check.
// Confirm it waives EXACTLY one, that it is mounted on exactly one route, and
// that the waiver cannot be reached from any other URL — the shape of the hole
// this variant replaced (an unanchored regex over req.originalUrl, which
// `DELETE /api/flocks/42?x=/users/me` satisfied).
test('A3 — the banned-user exemption waives the ban check and nothing else', async () => {
  reset();
  const { authenticateAllowBanned } = authMod;
  const app2 = express();
  app2.use(express.json());
  app2.set('io', fakeIo);
  app2.delete('/api/users/me', authenticateAllowBanned, (req, res) => res.json({ id: req.user.id }));
  // A second route mounted on the STRICT middleware, to prove the exemption is a
  // property of the mount and not of the URL.
  const flocks2 = express.Router();
  flocks2.use(authenticate);
  flocks2.delete('/:id', (req, res) => res.json({ ok: true }));
  app2.use('/api/flocks', flocks2);

  const srv = http.createServer(app2);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${srv.address().port}`;
  const del = (path, token) => fetch(b2 + path, {
    method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  try {
    const banned = seedUser({ email: 'exempt@example.com', is_banned: true });
    const token = signUserToken(banned);

    // The exemption works where it is mounted.
    assert.strictEqual((await del('/api/users/me', token)).status, 200);

    // It does not travel by URL. The query-string trick that defeated the old
    // carve-out is refused, because nothing matches a URL any more.
    // (`..` segments are collapsed by the HTTP client before the request is
    // sent, so they test nothing here; the query string is the spelling that
    // actually defeated the old carve-out.)
    for (const path of ['/api/flocks/42?x=/users/me', '/api/flocks/42?x=%2Fusers%2Fme',
      '/api/flocks/%2Fusers%2Fme']) {
      const r = await del(path, token);
      assert.notStrictEqual(r.status, 200, `${path} reached a handler as a banned user`);
    }

    // And the exemption is ONLY about the ban. A stale version, a deleted row
    // and a forged token are all still refused on the exempt route.
    banned.token_version = 5;
    assert.strictEqual((await del('/api/users/me', token)).status, 401);
    banned.token_version = 0;
    assert.strictEqual((await del('/api/users/me', token)).status, 200);
    users = [];
    assert.strictEqual((await del('/api/users/me', token)).status, 401);

    // Exactly one route in the app mounts it.
    const fs = require('node:fs');
    const path2 = require('node:path');
    const mounts = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path2.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.js')) continue;
        const text = fs.readFileSync(full, 'utf8');
        for (const line of text.split('\n')) {
          if (/router\.[a-z]+\([^)]*authenticateAllowBanned/.test(line)) {
            mounts.push(`${entry.name}: ${line.trim()}`);
          }
        }
      }
    };
    walk(path2.join(__dirname, '..', 'routes'));
    assert.deepStrictEqual(mounts, ["users.js: router.delete('/me', authenticateAllowBanned, deleteAccount);"],
      `the banned-user exemption is mounted somewhere new: ${mounts.join(' | ')}`);
  } finally {
    await new Promise((r) => srv.close(r));
  }
  assertQueriesUnderstood(4);
});

// ===========================================================================
// B. THE `tv` CLAIM — is revocation actually enforced, everywhere?
// ===========================================================================
test('B1 — a stale tv is refused by all four verifiers', async () => {
  reset();
  const u = seedUser({ email: 'tv@example.com', token_version: 0 });
  const stale = signUserToken(u);         // tv = 0
  u.token_version = 1;                    // something bumped it

  assert.strictEqual((await restAuth(stale)).status, 401);
  assert.ok((await socketHandshake(stale)).err);
  assert.strictEqual(await tryAuth({ headers: { authorization: `Bearer ${stale}` } }), null);
  const sock = { id: 's', user: { id: u.id }, rooms: new Set(), handshake: { auth: { token: stale } }, disconnect() {}, emit() {} };
  assert.strictEqual(await revalidateSession(sock), 'session_revoked');
  assertQueriesUnderstood(4);
});

// Attack: exploit the "a missing or non-integer tv reads as 0" backward
// compatibility rule. If a NON-integer current version also read as 0, a bumped
// row would silently stop revoking anything. Pin both halves.
test('B2 — the tv normalisation rule cannot be turned into a bypass', async () => {
  reset();
  const { tokenVersionOf } = authMod;
  // Everything that is not an integer is version 0 — on BOTH sides.
  for (const v of [undefined, null, '0', '3', 3.5, NaN, Infinity, {}, [], true, -0.5]) {
    assert.strictEqual(tokenVersionOf(v), Number.isInteger(v) ? v : 0, `tokenVersionOf(${String(v)})`);
  }
  // A hand-rolled token claiming a STRING tv reads as 0, so it can only match a
  // row at version 0 — it cannot satisfy a bumped row.
  const u = seedUser({ email: 'norm@example.com', token_version: 4 });
  const lying = jwt.sign({ userId: u.id, tv: '4' }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  assert.strictEqual((await restAuth(lying)).status, 401);
  const lyingFloat = jwt.sign({ userId: u.id, tv: 4.0000001 }, SECRET, { algorithm: 'HS256', expiresIn: '1h' });
  assert.strictEqual((await restAuth(lyingFloat)).status, 401);
  // token_version is INTEGER NOT NULL DEFAULT 0 (migration 009), so pg hands
  // this back as a JS number. If it were ever widened to BIGINT, node-pg would
  // return a STRING, currentTokenVersion would read 0 for every row, and every
  // bump in the app would become inert. Pin the column type.
  const fs = require('node:fs');
  const mig = fs.readFileSync(require('node:path').join(__dirname, '..', 'migrations', '009_token_version.sql'), 'utf8');
  assert.match(mig, /token_version INTEGER NOT NULL DEFAULT 0/,
    'token_version must stay INTEGER: a BIGINT is returned as a string and reads as version 0');
  assertQueriesUnderstood(2);
});

// Attack: the whole revocation lifecycle. Each of these is a moment where a
// session must die, and each is a separate code path that could have forgotten.
test('B3 — logout-all, password reset, ban, deletion and squat eviction all kill the token', async () => {
  reset();

  // (a) /logout-all
  {
    const u = seedUser({ email: 'la@example.com' });
    const token = signUserToken(u);
    const r = await post('/api/auth/logout-all', {}, token);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(u.token_version, 1, 'logout-all did not bump token_version');
    assert.ok(disconnectedRooms.includes(`user:${u.id}|true`), 'logout-all did not drop live sockets');
    assert.strictEqual((await restAuth(token)).status, 401, 'the caller\'s own token survived logout-all');
  }

  // (b) a completed password reset
  {
    disconnectedRooms = [];
    const u = seedUser({ email: 'pr@example.com' });
    const token = signUserToken(u);
    const raw = await issueResetFor(u);
    const r = await post('/api/auth/reset-password', { token: raw, password: 'NewPassword1' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(u.token_version, 1, 'a completed reset did not bump token_version');
    assert.ok(disconnectedRooms.includes(`user:${u.id}|true`), 'a completed reset left live sockets connected');
    assert.strictEqual((await restAuth(token)).status, 401, 'a token minted before the reset still works');
  }

  // (c) a ban — REST 403, socket refused, live socket cut by the revalidator
  {
    const u = seedUser({ email: 'ban@example.com' });
    const token = signUserToken(u);
    assert.strictEqual((await restAuth(token)).status, 200);
    u.is_banned = true;
    const after = await restAuth(token);
    assert.strictEqual(after.status, 403);
    assert.ok((await socketHandshake(token)).err);
    const sock = { id: 's', user: { id: u.id }, rooms: new Set(), handshake: { auth: { token } }, disconnect() {}, emit() {} };
    assert.strictEqual(await revalidateSession(sock), 'account_suspended');
    // A ban does NOT bump token_version, so the ONLY things standing between a
    // banned account and its own live session are these three checks. Pin that.
    assert.strictEqual(u.token_version, 0);
    assert.strictEqual(evaluateSession({ tv: 0 }, { is_banned: true, token_version: 0 }), 'account_suspended');
  }

  // (d) account deletion — the row is gone, so the token names nobody
  {
    const u = seedUser({ email: 'del@example.com' });
    const token = signUserToken(u);
    users = users.filter((x) => x.id !== u.id);
    const r = await restAuth(token);
    assert.strictEqual(r.status, 401);
    assert.match(r.body.error, /no longer exists/);
    assert.strictEqual(evaluateSession({ tv: 0 }, undefined), 'account_deleted');
  }

  // (e) squat eviction — releaseSquattedAddress bumps the version itself
  {
    disconnectedRooms = [];
    const squat = seedUser({
      email: 'squat@example.com', email_verified: false, verified_email: null,
      venmo_username: '@attacker', cashapp_cashtag: '$attacker', zelle_identifier: 'attacker@x',
    });
    const squatToken = signUserToken(squat);
    await withGoogle({ sub: 'g-owner-1', email: 'squat@example.com', email_verified: true, name: 'Owner' },
      () => post('/api/auth/google', { access_token: 'at-1', date_of_birth: '2000-01-01' }));
    assert.notStrictEqual(squat.email, 'squat@example.com', 'the squat kept the address');
    assert.strictEqual(squat.venmo_username, null, 'the squat kept its payment handle');
    assert.strictEqual(squat.token_version, 1, 'eviction did not bump token_version');
    assert.ok(disconnectedRooms.includes(`user:${squat.id}|true`), 'the squatter\'s socket survived eviction');
    assert.strictEqual((await restAuth(squatToken)).status, 401);
  }

  assertQueriesUnderstood(10);
});

// Attack: user ids are `SERIAL`. If an id were ever REUSED, a token minted for
// the deleted account would authenticate as its replacement — the middleware
// only checks that SOME row has that id and that the versions agree, and a
// fresh row starts at token_version 0, which is exactly what an old token
// carries. Demonstrate the consequence, then pin the two things that stop it.
test('B4 — id reuse would be a full account takeover, and nothing in the tree reuses an id', async () => {
  reset();
  const first = seedUser({ email: 'first@example.com', token_version: 0 });
  const stolen = signUserToken(first);
  const stolenId = first.id;
  users = users.filter((u) => u.id !== stolenId);

  // The hypothetical: a NEW account lands on the recycled id.
  const replacement = seedUser({ email: 'replacement@example.com', token_version: 0 });
  replacement.id = stolenId;
  const r = await restAuth(stolen);
  assert.strictEqual(r.status, 200, 'sanity: the middleware keys on the id alone');
  assert.strictEqual(r.body.id, stolenId);

  // So the property that has to hold is that the id is never recycled.
  const fs = require('node:fs');
  const path = require('node:path');
  const bootstrap = fs.readFileSync(path.join(__dirname, '..', 'migrations', '000_bootstrap.sql'), 'utf8');
  assert.match(bootstrap, /CREATE TABLE IF NOT EXISTS users \(\s*id SERIAL PRIMARY KEY/,
    'users.id must be a sequence-backed SERIAL — a sequence never hands out a value twice');
  // And nothing may rewind that sequence.
  const roots = ['routes', 'middleware', 'services', 'sockets', 'utils', 'db', 'migrations'];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|sql)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (/setval\s*\(\s*['"]?[^)]*users/i.test(text) || /ALTER SEQUENCE\s+users_id_seq\s+RESTART/i.test(text)) {
        offenders.push(full);
      }
    }
  };
  for (const root of roots) walk(path.join(__dirname, '..', root));
  assert.deepStrictEqual(offenders, [], `something rewinds the users id sequence: ${offenders.join(', ')}`);
  assertQueriesUnderstood(1);
});

// ===========================================================================
// C. PASSWORD RESET
// ===========================================================================
// Mint a real reset token for a user by driving /forgot-password, which is the
// only way one is issued. Returns the raw token off the mail the route sent.
async function issueResetFor(user) {
  sentMail = [];
  const r = await post('/api/auth/forgot-password', { email: user.email });
  assert.strictEqual(r.status, 200, 'forgot-password refused');
  await authRouter.__testing.flushResetMail();
  const row = resets.filter((x) => x.user_id === user.id && !x.used_at).pop();
  assert.ok(row, 'no reset row was written');
  // The mail carries the only copy of the verifier; recover it from the link.
  const link = sentMail.map((m) => `${m.html || ''}${m.text || ''}`).join(' ');
  const m = link.match(/reset-password#token=([A-Za-z0-9_.%-]+)/);
  assert.ok(m, 'the reset mail carried no link');
  return decodeURIComponent(m[1]);
}

test('C1 — reset token entropy, shape and storage', async () => {
  reset();
  const { mintVerificationToken, parseVerificationToken } = authRouter.__testing;
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const t = mintVerificationToken();
    assert.match(t.selector, /^[0-9a-f]{32}$/);            // 128-bit lookup key
    assert.strictEqual(Buffer.from(t.verifier, 'base64url').length, 32); // 256-bit secret
    assert.strictEqual(t.verifierHash, crypto.createHash('sha256').update(t.verifier).digest('hex'));
    assert.ok(!seen.has(t.token), 'mintVerificationToken repeated itself');
    seen.add(t.token);
    assert.ok(parseVerificationToken(t.token), 'a freshly minted token failed its own parser');
  }
  // Shape attacks on the parser: nothing that is not selector.verifier survives.
  for (const bad of ['', 'x', '.'.repeat(40),
    '0'.repeat(32) + '.' + 'b'.repeat(129),      // verifier too wide
    '0'.repeat(32) + '.' + 'b/b+b'.repeat(8),    // base64, not base64url
    '0'.repeat(31) + 'G.' + 'b'.repeat(30),      // selector is not hex
    '0'.repeat(32) + '.' + 'b'.repeat(19),       // verifier too short
    '0'.repeat(32) + '-' + 'b'.repeat(30),       // no separator at index 32
    '0'.repeat(33) + '.' + 'b'.repeat(30),       // separator in the wrong place
    'a'.repeat(400)]) {
    assert.strictEqual(parseVerificationToken(bad), null, `parser accepted ${JSON.stringify(bad.slice(0, 40))}`);
  }
  // The database never holds anything that can log in.
  const u = seedUser({ email: 'entropy@example.com' });
  const raw = await issueResetFor(u);
  const row = resets.pop();
  assert.ok(!row.verifier_hash.includes(raw.split('.')[1]), 'the verifier itself was stored');
  assert.strictEqual(row.verifier_hash,
    crypto.createHash('sha256').update(raw.split('.')[1]).digest('hex'));
  assertQueriesUnderstood(3);
});

test('C2 — a reset link is single-use, expiring, and bound to the address it was mailed to', async () => {
  reset();

  // Single use.
  {
    const u = seedUser({ email: 'single@example.com' });
    const raw = await issueResetFor(u);
    assert.strictEqual((await post('/api/auth/reset-password', { token: raw, password: 'FirstPass1' })).status, 200);
    const second = await post('/api/auth/reset-password', { token: raw, password: 'SecondPass1' });
    assert.strictEqual(second.status, 400);
    assert.strictEqual((await second.json()).reason, 'used');
    assert.ok(await bcrypt.compare('FirstPass1', u.password), 'the second submission overwrote the password');
  }

  // Expiry, enforced against the row rather than against the response copy.
  {
    const u = seedUser({ email: 'expiry@example.com' });
    const raw = await issueResetFor(u);
    const row = resets.find((r) => r.user_id === u.id);
    assert.ok(Date.parse(row.expires_at) - Date.now() <= 60 * 60 * 1000 + 5000, 'reset TTL is longer than an hour');
    row.expires_at = new Date(Date.now() - 1000).toISOString();
    const r = await post('/api/auth/reset-password', { token: raw, password: 'Expired111' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await r.json()).reason, 'expired');
    assert.ok(!await bcrypt.compare('Expired111', u.password));
  }

  // Issuing a new link retires the old one, so two mails are not two shots.
  {
    const u = seedUser({ email: 'retire@example.com' });
    const first = await issueResetFor(u);
    authRouter.__testing.clearLoginFailures?.(u.email);
    resetRequests.length = 0;                 // clear the per-address budget only
    const second = await issueResetFor(u);
    assert.notStrictEqual(first, second);
    const r = await post('/api/auth/reset-password', { token: first, password: 'Retired111' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await r.json()).reason, 'used');
    assert.strictEqual((await post('/api/auth/reset-password', { token: second, password: 'Retired111' })).status, 200);
  }

  // The link proves control of the address it was MAILED to. Move the account
  // and the link says nothing about the new one.
  {
    const u = seedUser({ email: 'moved@example.com' });
    const raw = await issueResetFor(u);
    u.email = 'elsewhere@example.com';
    const r = await post('/api/auth/reset-password', { token: raw, password: 'Moved11111' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await r.json()).reason, 'invalid');
  }

  // Consuming one link retires every OTHER live link the account holds.
  {
    const u = seedUser({ email: 'siblings@example.com' });
    const a = await issueResetFor(u);
    resetRequests.length = 0;
    const b = await issueResetFor(u);
    void a;
    assert.strictEqual((await post('/api/auth/reset-password', { token: b, password: 'Sibling111' })).status, 200);
    assert.strictEqual(resets.filter((r) => r.user_id === u.id && !r.used_at).length, 0);
  }
  assertQueriesUnderstood(15);
});

test('C3 — reset refuses OAuth rows, banned rows and rows with no credential', async () => {
  reset();

  // An OAuth row never gets a link at all, so a password cannot be welded on.
  {
    const u = seedUser({ email: 'oauth@example.com', password: null, oauth_provider: 'google', oauth_id: 'g1' });
    sentMail = [];
    const r = await post('/api/auth/forgot-password', { email: u.email });
    assert.strictEqual(r.status, 200);
    await authRouter.__testing.flushResetMail();
    assert.strictEqual(resets.filter((x) => x.user_id === u.id).length, 0, 'a reset token was minted for an OAuth row');
    assert.ok(sentMail.length > 0, 'the OAuth notice mail was not sent');
    assert.ok(!/reset-password#token=/.test(sentMail.map((m) => `${m.html || ''}${m.text || ''}`).join(' ')),
      'the OAuth notice carried a working reset link');
  }

  // A row that becomes OAuth between issue and use cannot be reset either.
  {
    const u = seedUser({ email: 'becomes@example.com' });
    const raw = await issueResetFor(u);
    u.oauth_provider = 'google'; u.password = null;
    const r = await post('/api/auth/reset-password', { token: raw, password: 'Welded1111' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(u.password, null, 'a password was welded onto an OAuth row');
  }

  // A banned account gets no mail, and a link issued before the ban stops working.
  {
    const u = seedUser({ email: 'bannedreset@example.com' });
    const raw = await issueResetFor(u);
    u.is_banned = true;
    const r = await post('/api/auth/reset-password', { token: raw, password: 'Unbanned11' });
    assert.strictEqual(r.status, 400);
    resetRequests.length = 0; sentMail = [];
    await post('/api/auth/forgot-password', { email: u.email });
    await authRouter.__testing.flushResetMail();
    assert.strictEqual(sentMail.length, 0, 'a banned account was mailed a reset link');
  }
  assertQueriesUnderstood(8);
});

test('C4 — /forgot-password is not an account-existence oracle', async () => {
  reset();
  const real = seedUser({ email: 'exists@example.com' });

  const shape = async (email) => {
    resetRequests.length = 0;
    sentMail = [];
    const r = await post('/api/auth/forgot-password', { email });
    const body = await r.json();
    await authRouter.__testing.flushResetMail();
    return { status: r.status, body, headers: [...r.headers.keys()].sort() };
  };

  const hit = await shape(real.email);
  const miss = await shape('nobody-at-all@example.com');
  const oauthRow = seedUser({ email: 'oauthprobe@example.com', password: null, oauth_provider: 'apple', oauth_id: 'a1' });
  const oauth = await shape(oauthRow.email);
  const bannedRow = seedUser({ email: 'bannedprobe@example.com', is_banned: true });
  const banned = await shape(bannedRow.email);

  for (const [name, got] of Object.entries({ miss, oauth, banned })) {
    assert.strictEqual(got.status, hit.status, `${name} answered a different status`);
    assert.deepStrictEqual(got.body, hit.body, `${name} answered a different body`);
    assert.deepStrictEqual(got.headers, hit.headers, `${name} answered different headers`);
  }
  assert.strictEqual(hit.body.message, authRouter.__testing.RESET_NEUTRAL_MESSAGE);

  // The ledger row is written for an address with NO account too, so a 429 can
  // never mean "this address exists".
  resetRequests.length = 0;
  await post('/api/auth/forgot-password', { email: 'ghost@example.com' });
  assert.strictEqual(resetRequests.length, 1, 'a miss was not recorded, so the budget is an oracle');
  // And the bucket key is a keyed digest, never the address.
  const key = authRouter.__testing.resetBucketKey('Ghost@Example.com');
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(key, crypto.createHash('sha256').update('reset:ghost@example.com').digest('hex'),
    'the reset bucket key is an unkeyed hash of the address');
  assert.strictEqual(key, authRouter.__testing.resetBucketKey('ghost@example.com'),
    'the bucket key is not canonical, so case alone mints a fresh budget');
  assertQueriesUnderstood(8);
});

test('C5 — the reset link cannot be pointed at a host the attacker chooses', async () => {
  reset();
  const svc = require('../services/emailService');
  const saved = { web: process.env.PUBLIC_WEB_URL, api: process.env.PUBLIC_API_URL };
  try {
    // Host-header injection: the builders take no request and read no header.
    assert.strictEqual(svc.passwordResetLink.length, 1);
    assert.strictEqual(svc.verificationLink.length, 1);
    // A hostile or non-public env value is refused in favour of the pinned URL.
    for (const bad of ['http://evil.test', 'https://localhost:3000', 'http://127.0.0.1:3000',
      'javascript:alert(1)', '', '   ', 'ftp://evil.test']) {
      process.env.PUBLIC_WEB_URL = bad;
      const link = svc.passwordResetLink('sel.ver');
      assert.ok(/^https:\/\//.test(link), `PUBLIC_WEB_URL=${bad} produced ${link}`);
      assert.ok(!link.includes('evil.test'), `PUBLIC_WEB_URL=${bad} produced ${link}`);
      assert.ok(!link.includes('localhost') && !link.includes('127.0.0.1'), `PUBLIC_WEB_URL=${bad} produced ${link}`);
    }
    process.env.PUBLIC_WEB_URL = saved.web;
    // The token rides in the fragment, so it never reaches a server log or a Referer.
    assert.match(svc.passwordResetLink('sel.ver'), /#token=sel\.ver$/);
    assert.ok(!svc.passwordResetLink('sel.ver').includes('?token='));
  } finally {
    process.env.PUBLIC_WEB_URL = saved.web;
    process.env.PUBLIC_API_URL = saved.api;
  }
});

// ===========================================================================
// D. EMAIL VERIFICATION AND THE UNVERIFIED GATE
// ===========================================================================
async function issueVerificationFor(user) {
  sentMail = [];
  const token = signUserToken(user);
  const r = await post('/api/auth/resend-verification', {}, token);
  assert.strictEqual(r.status, 200, `resend-verification refused: ${JSON.stringify(await r.json())}`);
  const link = sentMail.map((m) => `${m.html || ''}${m.text || ''}`).join(' ');
  const m = link.match(/verify-email\?token=([A-Za-z0-9_.%-]+)/);
  assert.ok(m, 'the verification mail carried no link');
  return decodeURIComponent(m[1]);
}

test('D1 — a verification link is single-use, expiring and address-bound', async () => {
  reset();

  {
    const u = seedUser({ email: 'v1@example.com', email_verified: false, verified_email: null });
    const raw = await issueVerificationFor(u);
    assert.strictEqual((await post('/api/auth/verify-email', { token: raw })).status, 200);
    assert.strictEqual(u.email_verified, true);
    assert.strictEqual(u.verified_email, u.email);
    // Replay against an account that has since been un-verified (a profile email
    // change does exactly that) must NOT re-verify it.
    u.email_verified = false; u.verified_email = null; u.email = 'victim@example.com';
    const again = await post('/api/auth/verify-email', { token: raw });
    assert.strictEqual(again.status, 400);
    assert.strictEqual(u.email_verified, false, 'a spent link re-verified a moved account');
  }

  {
    const u = seedUser({ email: 'v2@example.com', email_verified: false, verified_email: null });
    const raw = await issueVerificationFor(u);
    const row = verifications.find((v) => v.user_id === u.id);
    assert.ok(Date.parse(row.expires_at) - Date.now() <= 24 * 3600 * 1000 + 5000);
    row.expires_at = new Date(Date.now() - 1000).toISOString();
    const r = await post('/api/auth/verify-email', { token: raw });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await r.json()).reason, 'expired');
    assert.strictEqual(u.email_verified, false);
  }

  // The link proves the address it was MAILED to, not whatever the row holds now.
  {
    const u = seedUser({ email: 'v3@example.com', email_verified: false, verified_email: null });
    const raw = await issueVerificationFor(u);
    u.email = 'victim2@example.com';
    const r = await post('/api/auth/verify-email', { token: raw });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await r.json()).reason, 'stale');
    assert.strictEqual(u.email_verified, false, 'a link mailed to one address verified another');
  }

  // A token minted for account A cannot verify account B: the selector names
  // the row, and the row names its own user.
  {
    const a = seedUser({ email: 'a@example.com', email_verified: false, verified_email: null });
    const b = seedUser({ email: 'b@example.com', email_verified: false, verified_email: null });
    const raw = await issueVerificationFor(a);
    await post('/api/auth/verify-email', { token: raw });
    assert.strictEqual(a.email_verified, true);
    assert.strictEqual(b.email_verified, false);
  }
  assertQueriesUnderstood(12);
});

test('D2 — the unverified gate cannot be walked around with URL spellings', async () => {
  reset();
  const u = seedUser({ email: 'gate@example.com', email_verified: false, verified_email: null });
  const token = signUserToken(u);

  // Spellings Express routes to the handler. Every one of these must be gated.
  const routed = [
    ['POST', '/api/friends/request'],
    ['POST', '/api/friends/accept'],
    ['POST', '/api/flocks'],
    ['POST', '/api/flocks/42/join'],
    ['PUT', '/api/users/venmo-username'],
    // Express matches case-insensitively and with an optional trailing slash by
    // default, and it decodes percent-escapes before routing — so all four of
    // these reach the same handler and all four have to hit the same rule.
    ['POST', '/API/FRIENDS/REQUEST'],
    ['POST', '/api/friends/request/'],
    ['POST', '/api/friends/%72equest'],
    // The query string is the shape that defeated the OLD ban carve-out, which
    // matched against req.originalUrl. The gate reads req.baseUrl + req.path.
    ['POST', '/api/friends/request?next=/users/me'],
    ['POST', '/api/flocks?x=1'],
  ];
  for (const [method, path] of routed) {
    const r = await call(method, path, {}, token);
    assert.strictEqual(r.status, 403, `${method} ${path} was NOT gated`);
    assert.strictEqual((await r.json()).emailVerificationRequired, true);
  }

  // Spellings Express does NOT route to the handler. They must not succeed
  // either — a 404 is a refusal, a 200 would be the bypass.
  for (const [method, path] of [
    ['POST', '//api//friends//request'],
    ['POST', '/api//friends/request'],
    ['POST', '/api/friends//request'],
    ['POST', '/api/friends/./request'],
    ['POST', '/api/friends/x/../request'],
  ]) {
    const r = await call(method, path, {}, token);
    assert.notStrictEqual(r.status, 200, `${method} ${path} reached the handler ungated`);
  }

  // requireVerified, mounted explicitly, refuses the same account.
  assert.strictEqual((await post('/api/flocks/7/rerun', {}, token)).status, 403);

  // And a verified account is not gated, so the rule is not simply "deny".
  u.email_verified = true;
  assert.strictEqual((await post('/api/friends/request', {}, token)).status, 200);
  assert.strictEqual((await post('/api/flocks/7/rerun', {}, token)).status, 200);
  assertQueriesUnderstood(10);
});

// The backstop table in middleware/auth.js is a DENY list of URL patterns, and
// its own comment calls it "belt and braces" against a route dropping
// requireVerified. Every door into accepted flock membership therefore has to be
// on it. Enumerate the doors from the source rather than trusting the list.
test('D3 — every accepted-membership route is covered by BOTH gates', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { UNVERIFIED_DENY } = authMod.__testing;
  const flocks = fs.readFileSync(path.join(__dirname, '..', 'routes', 'flocks.js'), 'utf8');

  // Routes in routes/flocks.js that INSERT a flock_members row with status
  // 'accepted' for the CALLER. Found by reading the source, listed here so the
  // assertion below is about the deny list and not about a grep.
  const doorways = ['/', '/:id/join', '/:id/rerun'];
  for (const d of doorways) {
    assert.ok(flocks.includes(`router.post('${d}'`), `routes/flocks.js no longer has POST ${d}`);
  }
  // All three mount requireVerified explicitly.
  const mountsVerified = (route) => {
    const at = flocks.indexOf(`router.post('${route}'`);
    assert.notStrictEqual(at, -1, `POST ${route} is gone from routes/flocks.js`);
    // requireVerified has to appear in the ARGUMENT LIST, i.e. ahead of the
    // handler body. The chains in this file are comment-heavy, so the window is
    // wide; it stops at the handler so a mention further down cannot count.
    const head = flocks.slice(at, at + 4000);
    const bodyStart = head.indexOf('async (req, res)');
    const args = head.slice(0, bodyStart === -1 ? head.length : bodyStart);
    assert.ok(args.includes('requireVerified'), `POST ${route} no longer mounts requireVerified`);
  };
  mountsVerified('/');
  mountsVerified('/:id/join');
  mountsVerified('/:id/rerun');

  const covered = (method, url) => UNVERIFIED_DENY.some((r) => r.method === method && r.pattern.test(url));
  assert.ok(covered('POST', '/api/flocks'), 'POST /api/flocks fell off the deny list');
  assert.ok(covered('POST', '/api/flocks/42/join'), 'join fell off the deny list');
  assert.ok(covered('POST', '/api/flocks/42/invite'), 'invite fell off the deny list');
  assert.ok(covered('POST', '/api/guest/abc/join'), 'the invite-link join fell off the deny list');
  // FIXED (D3). rerun was the one accepted-membership door the backstop did not
  // match: it mounts requireVerified, so it was gated, but by a single gate
  // where the other four had two. It is on the list now, so a refactor that
  // drops its requireVerified fails closed like everywhere else.
  assert.strictEqual(covered('POST', '/api/flocks/42/rerun'), true,
    'rerun fell off the deny list — it is back to one gate where the others have two');

  // And the backstop actually bites on the wire, not just in the table. The
  // stub route above mounts requireVerified the way routes/flocks.js does, so
  // this passing proves the DENY LIST refused first: strip requireVerified from
  // the stub and the gate below is the only thing left standing.
  reset();
  const unverified = seedUser({ email_verified: false, verified_email: null });
  const token = jwt.sign({ userId: unverified.id, tv: 0 }, process.env.JWT_SECRET);
  const gated = await post('/api/flocks/42/rerun', {}, token);
  assert.strictEqual(gated.status, 403, 'an unverified account reached rerun');
  assert.strictEqual((await gated.json()).emailVerificationRequired, true);
});

// ===========================================================================
// E. GOOGLE AND APPLE — account takeover by linking, in both directions
// ===========================================================================
test('E1 — an OAuth identity cannot absorb a password account that never proved the address', async () => {
  reset();
  // The squat: an attacker pre-registered the victim's address and loaded the
  // row with the assets a claim would hand over.
  const squat = seedUser({
    email: 'target@example.com', email_verified: false, verified_email: null,
    venmo_username: '@attacker', name: 'Squatter',
  });
  const before = { id: squat.id, venmo: squat.venmo_username };

  await withGoogle({ sub: 'g-victim', email: 'target@example.com', email_verified: true, name: 'Victim' },
    () => post('/api/auth/google', { access_token: 'tok', date_of_birth: '2000-01-01' }));

  const fresh = users.find((u) => u.email === 'target@example.com');
  assert.ok(fresh, 'the verified owner got no account');
  assert.notStrictEqual(fresh.id, before.id, 'the squat row was handed to the verified owner');
  assert.strictEqual(fresh.venmo_username, null, 'the owner inherited the squatter\'s payment handle');
  assert.strictEqual(fresh.oauth_provider, 'google');
  assert.match(squat.email, /@unclaimed\.invalid$/, 'the squat kept the address');
  assertQueriesUnderstood(4);
});

test('E2 — an OAuth account cannot be taken over by a password signup, or by the other provider', async () => {
  reset();
  const oauth = seedUser({
    email: 'owned@example.com', password: null, oauth_provider: 'google', oauth_id: 'g-owned',
    email_verified: true, verified_email: 'owned@example.com',
  });

  // (a) password signup on the same address
  const signup = await post('/api/auth/signup', {
    email: 'owned@example.com', password: 'Password1', name: 'Impostor', date_of_birth: '2000-01-01',
  });
  assert.strictEqual(signup.status, 400);
  assert.match((await signup.json()).error, /already registered/);

  // (b) the SAME address through the OTHER provider
  const appleRes = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'apple-impostor', email: 'owned@example.com', email_verified: true }),
    date_of_birth: '2000-01-01',
  });
  assert.strictEqual(appleRes.status, 409, 'Apple absorbed a Google account');
  assert.strictEqual(oauth.oauth_provider, 'google');
  assert.strictEqual(oauth.oauth_id, 'g-owned');

  // (c) a Gmail dot/subaddress variant, which is the spelling LOWER() misses
  const dotted = await post('/api/auth/signup', {
    email: 'ow.ned+tag@example.com', password: 'Password1', name: 'X', date_of_birth: '2000-01-01',
  });
  // Not a gmail domain, so the canonical alphabet does not fold it — it is a
  // genuinely different address and gets its own row. Prove the gmail case does fold.
  assert.strictEqual(dotted.status, 201);
  const g = seedUser({
    email: 'johndoe@gmail.com', password: null, oauth_provider: 'google', oauth_id: 'g-john',
    email_verified: true, verified_email: 'johndoe@gmail.com',
  });
  const shadow = await post('/api/auth/signup', {
    email: 'john.doe+spam@gmail.com', password: 'Password1', name: 'Shadow', date_of_birth: '2000-01-01',
  });
  assert.strictEqual(shadow.status, 400, 'a Gmail dot variant opened a shadow account on an OAuth mailbox');
  assert.strictEqual(users.filter((u) => canonicalEmail(u.email) === 'johndoe@gmail.com').length, 1);
  void g;
  assertQueriesUnderstood(8);
});

test('E3 — a provider that does not vouch for the address gets nothing', async () => {
  reset();

  // Creation with email_verified absent or false.
  for (const flag of [undefined, false, 'false', null, 0, 'TRUE ']) {
    const profile = { sub: `g-unv-${String(flag)}`, email: `unv-${String(flag)}@example.com`, name: 'U' };
    if (flag !== undefined) profile.email_verified = flag;
    const r = await withGoogle(profile,
      () => post('/api/auth/google', { access_token: 'tok', date_of_birth: '2000-01-01' }));
    assert.strictEqual(r.status, 401, `Google created an account for email_verified=${String(flag)}`);
  }
  assert.strictEqual(users.length, 0);

  // A claim of an existing verified password row also needs the vouch.
  const owner = seedUser({ email: 'vouch@example.com', email_verified: true, verified_email: 'vouch@example.com' });
  const claim = await withGoogle({ sub: 'g-novouch', email: 'vouch@example.com', name: 'V' },
    () => post('/api/auth/google', { access_token: 'tok', date_of_birth: '2000-01-01' }));
  assert.strictEqual(claim.status, 409);
  assert.strictEqual(owner.oauth_provider, null);

  // Apple, same rule.
  const appleUnv = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-unv', email: 'aunv@example.com' }),
    date_of_birth: '2000-01-01',
  });
  assert.strictEqual(appleUnv.status, 401);
  assertQueriesUnderstood(8);
});

test('E4 — the Apple identity token must be signed by Apple, for us, and still live', async () => {
  reset();
  const cases = {
    'attacker key': appleIdentityToken({ sub: 'a1', email: 'x@example.com', email_verified: true }, EVIL_PRIV),
    'wrong issuer': jwt.sign({ iss: 'https://evil.test', aud: 'com.flockcorp.flock', sub: 'a2' },
      APPLE_PRIV, { algorithm: 'RS256', expiresIn: '10m', keyid: 'test-kid' }),
    'wrong audience': jwt.sign({ iss: 'https://appleid.apple.com', aud: 'com.someoneelse.app', sub: 'a3' },
      APPLE_PRIV, { algorithm: 'RS256', expiresIn: '10m', keyid: 'test-kid' }),
    'no audience': jwt.sign({ iss: 'https://appleid.apple.com', sub: 'a4' },
      APPLE_PRIV, { algorithm: 'RS256', expiresIn: '10m', keyid: 'test-kid' }),
    expired: jwt.sign({ iss: 'https://appleid.apple.com', aud: 'com.flockcorp.flock', sub: 'a5' },
      APPLE_PRIV, { algorithm: 'RS256', expiresIn: '-1m', keyid: 'test-kid' }),
    // HS256 signed with Apple's PUBLIC key, the textbook asymmetric-to-HMAC swap.
    'hs256 with the public key': jwt.sign(
      { iss: 'https://appleid.apple.com', aud: 'com.flockcorp.flock', sub: 'a6', exp: Math.floor(Date.now() / 1000) + 600 },
      APPLE_PUB, { algorithm: 'HS256' }),
    'alg none': (() => {
      const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return `${b({ alg: 'none' })}.${b({ iss: 'https://appleid.apple.com', aud: 'com.flockcorp.flock', sub: 'a7', exp: Math.floor(Date.now() / 1000) + 600 })}.`;
    })(),
  };
  for (const [name, identityToken] of Object.entries(cases)) {
    const r = await post('/api/auth/apple', { identityToken, date_of_birth: '2000-01-01' });
    assert.ok(r.status === 401 || r.status === 400, `Apple accepted a token with ${name} (status ${r.status})`);
  }
  assert.strictEqual(users.length, 0, 'a rejected Apple token still created a row');

  // The control: a genuine token works.
  const good = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-good', email: 'good@example.com', email_verified: true }),
    date_of_birth: '2000-01-01',
  });
  assert.strictEqual(good.status, 200);
  assertQueriesUnderstood(3);
});

test('E5 — a provider token cannot be replayed, in sequence or in parallel', async () => {
  reset();
  const claims = { sub: 'a-replay', email: 'replay@example.com', email_verified: true };
  const identityToken = appleIdentityToken(claims);

  const first = await post('/api/auth/apple', { identityToken, date_of_birth: '2000-01-01' });
  assert.strictEqual(first.status, 200);
  const second = await post('/api/auth/apple', { identityToken, date_of_birth: '2000-01-01' });
  assert.strictEqual(second.status, 401, 'an Apple identity token was accepted twice');

  // Parallel: ten simultaneous presentations of one credential.
  const t2 = appleIdentityToken({ sub: 'a-par', email: 'par@example.com', email_verified: true });
  const results = await Promise.all(Array.from({ length: 10 },
    () => post('/api/auth/apple', { identityToken: t2, date_of_birth: '2000-01-01' })));
  const accepted = results.filter((r) => r.status === 200).length;
  assert.strictEqual(accepted, 1, `${accepted} of 10 parallel replays were accepted`);

  // A refusal must hand the credential BACK, or one blip is a permanent lockout.
  const t3 = appleIdentityToken({ sub: 'a-dob', email: 'dob@example.com', email_verified: true });
  const needsDob = await post('/api/auth/apple', { identityToken: t3 });
  assert.strictEqual(needsDob.status, 403);
  assert.strictEqual((await needsDob.json()).needsDob, true);
  const retry = await post('/api/auth/apple', { identityToken: t3, date_of_birth: '2000-01-01' });
  assert.strictEqual(retry.status, 200, 'a refused sign-in burned the credential');

  // The replay key is derived from the DECODED token, so the 16 wire spellings
  // of one RS256 signature all collapse onto one key.
  const { canonicalJwtSignature, oauthIdentityKey } = authRouter.__testing;
  const [h, p, s] = identityToken.split('.');
  const last = s[s.length - 1];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const twin = alphabet.split('').find((c) => c !== last
    && Buffer.from(s.slice(0, -1) + c, 'base64url').equals(Buffer.from(s, 'base64url')));
  assert.ok(twin, 'no alternate spelling of this signature exists');
  const other = `${h}.${p}.${s.slice(0, -1)}${twin}`;
  assert.strictEqual(canonicalJwtSignature(identityToken), canonicalJwtSignature(other));
  assert.strictEqual(oauthIdentityKey('apple', claims, identityToken), oauthIdentityKey('apple', claims, other));
  assertQueriesUnderstood(8);
});

test('E6 — the Google credential path checks audience, nonce and replay', async () => {
  reset();
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID,
    sub: 'g-cred-1', email: 'cred@example.com', email_verified: true, name: 'Cred',
    iat: now, exp: now + 3600,
  };
  const wire = googleWire(payload);

  // Replay, on the ID-token path.
  const ok1 = await withGoogleIdToken(payload,
    () => post('/api/auth/google', { credential: wire, date_of_birth: '2000-01-01' }));
  assert.strictEqual(ok1.status, 200);
  const ok2 = await withGoogleIdToken(payload,
    () => post('/api/auth/google', { credential: wire, date_of_birth: '2000-01-01' }));
  assert.strictEqual(ok2.status, 401, 'a Google ID token was accepted twice');

  // A token carrying a nonce the client did not send is refused: we cannot check it.
  const nonced = { ...payload, sub: 'g-cred-2', email: 'cred2@example.com', nonce: 'not-ours' };
  const r = await withGoogleIdToken(nonced,
    () => post('/api/auth/google', { credential: googleWire(nonced), date_of_birth: '2000-01-01' }));
  assert.strictEqual(r.status, 401);

  // A nonce we never issued is refused even when the token echoes it.
  const forgedNonce = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const n2 = { ...payload, sub: 'g-cred-3', email: 'cred3@example.com', nonce: forgedNonce };
  const r2 = await withGoogleIdToken(n2,
    () => post('/api/auth/google', { credential: googleWire(n2), nonce: forgedNonce, date_of_birth: '2000-01-01' }));
  assert.strictEqual(r2.status, 401);

  // An issued nonce is single-use.
  const issued = (await (await post('/api/auth/google/nonce', {})).json()).nonce;
  const n3 = { ...payload, sub: 'g-cred-4', email: 'cred4@example.com', nonce: issued };
  const good = await withGoogleIdToken(n3,
    () => post('/api/auth/google', { credential: googleWire(n3), nonce: issued, date_of_birth: '2000-01-01' }));
  assert.strictEqual(good.status, 200);
  assert.strictEqual(authRouter.__testing.oauthNonceValid(issued), false, 'the nonce was not spent');

  // The access_token path refuses a token minted for another app.
  const wrongAud = await withGoogle({ sub: 'g-other', email: 'other@example.com', email_verified: true },
    () => post('/api/auth/google', { access_token: 'tok', date_of_birth: '2000-01-01' }),
    'someone-elses-client-id');
  assert.strictEqual(wrongAud.status, 401, 'an access token minted for another app was accepted');

  // Malformed credentials never reach the verifier as a 500.
  for (const bad of ['x', 'a.b', 'a.b.c.d', '....', 'not a jwt']) {
    const rb = await post('/api/auth/google', { credential: bad, date_of_birth: '2000-01-01' });
    assert.ok(rb.status === 400 || rb.status === 401, `credential ${JSON.stringify(bad)} produced ${rb.status}`);
  }
  assertQueriesUnderstood(6);
});

// ===========================================================================
// F. BAN EVASION
// ===========================================================================
test('F1 — a tombstoned identity cannot re-register on any of the three doors', async () => {
  reset();
  const usersRouter = require('../routes/users');
  const { identityDigests } = usersRouter.__testing;

  const banned = { email: 'evader@example.com', oauthProvider: 'google', oauthId: 'g-evader' };
  const d = identityDigests(banned);
  bannedIdentities.push({
    email_hash: d.emailHash, phone_hash: null, oauth_hash: d.oauthHash,
    expires_at: new Date(Date.now() + 365 * 86400000).toISOString(),
  });

  // (a) password signup on the tombstoned address
  const s = await post('/api/auth/signup', {
    email: 'evader@example.com', password: 'Password1', name: 'Back', date_of_birth: '2000-01-01',
  });
  assert.strictEqual(s.status, 403);
  assert.strictEqual(users.length, 0, 'a row was created for a tombstoned identity');

  // (b) a Gmail dot variant of it, if it were gmail — the digest is canonical
  const gd = identityDigests({ email: 'john.doe+x@gmail.com' });
  assert.strictEqual(gd.emailHash, identityDigests({ email: 'JohnDoe@googlemail.com' }).emailHash,
    'the tombstone digest is not canonical, so a dot variant walks straight back in');

  // (c) the Google button with the same provider identity but a NEW address
  const g = await withGoogle({ sub: 'g-evader', email: 'brandnew@example.com', email_verified: true, name: 'Back' },
    () => post('/api/auth/google', { access_token: 'tok', date_of_birth: '2000-01-01' }));
  assert.strictEqual(g.status, 403, 'the Google button let a tombstoned oauth identity back in');

  // (d) Apple, same shape
  const ad = identityDigests({ oauthProvider: 'apple', oauthId: 'a-evader' });
  bannedIdentities.push({
    email_hash: null, phone_hash: null, oauth_hash: ad.oauthHash,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  const a = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-evader', email: 'newapple@example.com', email_verified: true }),
    date_of_birth: '2000-01-01',
  });
  assert.strictEqual(a.status, 403);
  assert.strictEqual(users.length, 0);
  assertQueriesUnderstood(6);
});

test('F2 — tombstone digests are keyed, expiring, and fail open only on a database error', async () => {
  reset();
  const usersRouter = require('../routes/users');
  const { identityDigests } = usersRouter.__testing;
  const { isIdentityBanned } = usersRouter;

  // Keyed: not a plain SHA-256 of a low-entropy input, and it moves with the pepper.
  const d = identityDigests({ email: 'probe@example.com', phone: '+1 (555) 010-1234' });
  assert.match(d.emailHash, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(d.emailHash, crypto.createHash('sha256').update('email:probe@example.com').digest('hex'));
  assert.notStrictEqual(d.phoneHash, crypto.createHash('sha256').update('phone:5550101234').digest('hex'));
  const saved = process.env.BAN_TOMBSTONE_SECRET;
  process.env.BAN_TOMBSTONE_SECRET = 'a-different-pepper';
  assert.notStrictEqual(identityDigests({ email: 'probe@example.com' }).emailHash, d.emailHash,
    'the digest does not depend on the pepper, so it is brute-forceable from a dump');
  process.env.BAN_TOMBSTONE_SECRET = saved;
  // The kind is inside the HMAC, so an email digest can never match a phone one.
  assert.notStrictEqual(identityDigests({ email: '5550101234' }).emailHash, d.phoneHash);

  // Expired tombstones are inert at READ time, not merely at purge time.
  bannedIdentities.push({
    email_hash: d.emailHash, phone_hash: null, oauth_hash: null,
    expires_at: new Date(Date.now() - 1000).toISOString(),
  });
  assert.strictEqual(await isIdentityBanned({ email: 'probe@example.com' }), false);

  // A database failure fails OPEN by design. Prove it, so the trade is on the record.
  bannedIdentities.push({
    email_hash: d.emailHash, phone_hash: null, oauth_hash: null,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.strictEqual(await isIdentityBanned({ email: 'probe@example.com' }), true);
  banLookupThrows = true;
  assert.strictEqual(await isIdentityBanned({ email: 'probe@example.com' }), false,
    'the lookup no longer fails open — if that is deliberate, update this test');
  banLookupThrows = false;

  // With no pepper at all there is no digest, so nothing is compared — which is
  // fail-open, not a plain hash of a teenager\'s email address.
  const savedJwt = process.env.JWT_SECRET;
  delete process.env.BAN_TOMBSTONE_SECRET; delete process.env.JWT_SECRET;
  assert.strictEqual(identityDigests({ email: 'probe@example.com' }).emailHash, null);
  process.env.BAN_TOMBSTONE_SECRET = saved; process.env.JWT_SECRET = savedJwt;
  assertQueriesUnderstood(3);
});

test('F3 — the ban tombstone cannot be used to poison a stranger\'s mailbox', async () => {
  reset();
  const usersRouter = require('../routes/users');
  const { recordBannedIdentity } = usersRouter.__testing;

  const writes = [];
  const client = { query: async (sql, params) => { writes.push({ sql: String(sql).replace(/\s+/g, ' '), params }); return { rows: [], rowCount: 1 }; } };

  // An UNVERIFIED squat on a victim's address must leave NO email digest, or a
  // banned squatter permanently locks the real owner out of signing up.
  await recordBannedIdentity(client, {
    id: 1, email: 'victim@example.com', verified_email: null, email_verified: false,
    phone: null, oauth_provider: null, oauth_id: null, banned_at: new Date().toISOString(),
  });
  const inserted = writes.filter((w) => w.sql.includes('INSERT INTO banned_identities'));
  const emailHashes = inserted.map((w) => w.params[0]).filter(Boolean);
  assert.deepStrictEqual(emailHashes, [],
    'an unverified squat tombstoned an address it never proved — that is a poison pill on a stranger');

  // A PROVED address is tombstoned, and it is the proved one rather than
  // whatever the row happens to hold now.
  writes.length = 0;
  await recordBannedIdentity(client, {
    id: 2, email: 'moved-to@example.com', verified_email: 'proved@example.com', email_verified: true,
    phone: null, oauth_provider: null, oauth_id: null, banned_at: new Date().toISOString(),
  });
  const ins = writes.find((w) => w.sql.includes('INSERT INTO banned_identities'));
  const { identityDigests } = usersRouter.__testing;
  assert.strictEqual(ins.params[0], identityDigests({ email: 'proved@example.com' }).emailHash,
    'the tombstone branded the address the row HOLDS instead of the one it PROVED');
});

// ===========================================================================
// G. TOKEN MINTING — is there a path that issues one without the usual checks?
// ===========================================================================
test('G1 — the session key is not shared with any other token family', async () => {
  reset();
  // middleware/auth.js is the only thing that mints a SESSION, and it must be
  // the only thing that signs with the RAW JWT_SECRET. Two other modules sign
  // JWTs: services/appleAuth.js (Apple's client secret, signed with Apple's own
  // .p8) and services/venueDigest.js (a 180-day venue opt-out link). The second
  // is the dangerous shape, because a token minted against JWT_SECRET that
  // happened to carry a userId would be a full 24-hour session immune to
  // token_version. Attack it in BOTH directions rather than reading the comment
  // that says it is safe.
  const venueDigest = require('../services/venueDigest');
  const u = seedUser({ email: 'sep@example.com' });
  const session = signUserToken(u);

  // (a) an opt-out token must not authenticate as a session
  const optOut = venueDigest.optOutToken(4242);
  const asSession = await restAuth(optOut);
  assert.notStrictEqual(asSession.status, 200, 'a venue opt-out token authenticated as a user session');
  // Control: the session token this account really holds IS accepted, so the
  // refusal above is about the key and not about a broken harness.
  assert.strictEqual((await restAuth(session)).status, 200);

  // (b) a session token must not verify as an opt-out link
  const asOptOut = await venueDigest.readOptOutState(session);
  assert.strictEqual(asOptOut.ok, false, 'a session token verified as a venue opt-out token');

  // (c) the forward-compatibility case the key separation exists for: a token
  //     signed with the RAW secret that carries BOTH a userId and the opt-out
  //     purpose still cannot cross over.
  const hybrid = jwt.sign(
    { userId: u.id, tv: 0, purpose: venueDigest.OPT_OUT_PURPOSE, vp: 4242 },
    SECRET, { algorithm: 'HS256', expiresIn: '1h' }
  );
  const crossed = await venueDigest.readOptOutState(hybrid);
  assert.strictEqual(crossed.ok, false,
    'a token signed with the raw JWT_SECRET verified against the opt-out family');

  // Structural half: nothing outside middleware/auth.js may hand the RAW
  // JWT_SECRET to jwt.sign. A DERIVED key (an HMAC of the secret under a purpose
  // label, which is what venueDigest does) is fine; passing the secret itself is
  // not, because the two families would then share one verifier.
  const fs = require('node:fs');
  const path = require('node:path');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const rel = full.split(path.sep).join('/');
      if (rel.endsWith('middleware/auth.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(/jwt\.sign\(/g)) {
        // The key is the second argument, so read the CALL rather than the file.
        const call = text.slice(m.index, m.index + 600).replace(/\s+/g, ' ');
        if (/,\s*process\.env\.JWT_SECRET\s*[,)]/.test(call)) offenders.push(rel);
      }
    }
  };
  for (const root of ['routes', 'services', 'sockets', 'utils', 'middleware']) {
    walk(path.join(__dirname, '..', root));
  }
  assert.deepStrictEqual([...new Set(offenders)], [],
    `these sign a JWT with the RAW session secret: ${[...new Set(offenders)].join(', ')}`);
  assertQueriesUnderstood(1);
});

test('G2 — a mint on a row that is missing token_version fails CLOSED', async () => {
  reset();
  const u = seedUser({ email: 'mint@example.com', token_version: 3 });
  // A route that forgot token_version in its RETURNING list.
  const projection = { id: u.id, email: u.email };
  const token = signUserToken(projection);
  assert.strictEqual(jwt.decode(token).tv, 0);
  assert.strictEqual((await restAuth(token)).status, 401,
    'a token minted from a row without token_version was accepted against a bumped row');
  // The one live caller of that shape is POST /signup, whose RETURNING list
  // omits token_version — safe only because a new row is at version 0.
  const fs = require('node:fs');
  const path = require('node:path');
  const auth = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  assert.match(auth, /INSERT INTO users \(email, password, name, interests, terms_accepted_at, date_of_birth, email_verified\)/);
  assertQueriesUnderstood(1);
});

test('G3 — /login and the OAuth handlers never leak the password hash or the refresh token', async () => {
  reset();
  const u = seedUser({ email: 'leak@example.com', apple_refresh_token: 'apple-secret' });
  const r = await post('/api/auth/login', { email: 'leak@example.com', password: 'Password1' });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.ok(!('password' in body.user));
  assert.ok(!('apple_refresh_token' in body.user));
  assert.ok(!('token_version' in body.user));
  assert.ok(!JSON.stringify(body).includes('apple-secret'));
  assert.ok(!JSON.stringify(body).includes(u.password));
  assertQueriesUnderstood(1);
});

// ===========================================================================
// H. THE REMAINING LEVERS
// ===========================================================================
// FIXED (H1). The under-13 retry lockout is the COPPA FAQ's "cookie",
// implemented server-side. Its EMAIL half used to be keyed on an address an
// UNAUTHENTICATED caller typed, with nothing verifying they owned it, which made
// the memory of a refusal a write primitive: one signup with a victim's address
// and a child's birthday denied that address an account on ALL THREE doors for
// 24 hours, from anywhere, renewably.
//
// The memory still exists, because deleting it would make the age screen a
// suggestion. What changed is the key. An address the caller merely ASSERTED is
// remembered against the address AND the source IP together, so it bites the
// caller who typed it and nobody else; an address that was PROVED — a completed
// sign-in, or a provider-signed token — keeps the wide 24-hour block, because a
// stranger cannot seed one.
//
// This test attacks from a different source address than the victim uses, which
// is the whole point: the attacker is not on the victim's network.
test('H1 — a refusal on a chosen address does not deny that address an account', async () => {
  const { underageKey, underagePairKey, underageAttemptHas, underageBlocked } = authRouter.__testing;
  const ATTACKER_IP = '198.51.100.66';
  const VICTIM_IP = '203.0.113.12';

  // FIRST, THE HALF THAT MUST NOT HAVE BEEN TRADED AWAY: a CHILD who presses
  // back and changes the year is still refused. They are on the same network
  // seconds later, so both the 15-minute IP key and the 24-hour
  // address-plus-IP key land on them.
  reset();
  const KID_IP = '192.0.2.77';
  const kid = 'kid-back-button@example.com';
  const refused = await postFrom(KID_IP, '/api/auth/signup', {
    email: kid, password: 'Password1', name: 'Kid', date_of_birth: '2020-01-01',
  });
  assert.strictEqual(refused.status, 403);
  const retry = await postFrom(KID_IP, '/api/auth/signup', {
    email: kid, password: 'Password1', name: 'Kid', date_of_birth: '1995-06-01',
  });
  assert.strictEqual(retry.status, 403, 'back button plus an older year now works');
  // Indistinguishable from the first refusal, so it teaches the child nothing.
  assert.deepStrictEqual(await retry.json(), await refused.json());
  assert.strictEqual(users.length, 0);

  // The memory that refusal wrote is the NARROW one, and it is the narrow one
  // doing the blocking: same mailbox, same address, blocked; same mailbox from
  // anywhere else, not blocked.
  assert.strictEqual(underageAttemptHas(underageKey('email', kid)), false,
    'an unauthenticated caller wrote a wide, address-only block — the write primitive is back');
  assert.ok(underageAttemptHas(underagePairKey(kid, KID_IP)), 'no address-plus-IP entry was written');
  assert.strictEqual(underageBlocked(kid, KID_IP), true);
  assert.strictEqual(underageBlocked(kid, '198.51.100.9'), false,
    'the refusal followed the mailbox off the network that produced it');
  // Still canonical within its own scope, so respelling the address does not
  // mint a fresh identity for the child either.
  assert.strictEqual(underagePairKey(kid, KID_IP), underagePairKey('KID-BACK-BUTTON@example.com', KID_IP));

  // Door 1 — the victim's own password signup, with a perfectly valid birthday,
  // after a stranger on another network refused a child's date on their address.
  reset();
  const victim = 'blocked-victim@example.com';
  const poison = await postFrom(ATTACKER_IP, '/api/auth/signup', {
    email: victim, password: 'Password1', name: 'Kid', date_of_birth: '2020-01-01',
  });
  assert.strictEqual(poison.status, 403);
  assert.strictEqual(users.length, 0, 'the refused signup still created a row');
  const pw = await postFrom(VICTIM_IP, '/api/auth/signup', {
    email: victim, password: 'Password1', name: 'Victim', date_of_birth: '1995-06-01',
  });
  assert.strictEqual(pw.status, 201, 'a stranger still denied the victim an account');
  assert.strictEqual(users.length, 1);
  assert.strictEqual(users[0].email, victim);

  // Door 2 — Google. The OAuth create branches consult the same lockout, so
  // they have to be checked rather than assumed from door 1.
  reset();
  const victim2 = 'blocked-oauth@example.com';
  await postFrom(ATTACKER_IP, '/api/auth/signup', {
    email: victim2, password: 'Password1', name: 'Kid', date_of_birth: '2020-01-01',
  });
  const g = await withGoogle({ sub: 'g-victim', email: victim2, email_verified: true, name: 'Victim' },
    () => postFrom(VICTIM_IP, '/api/auth/google', { access_token: 'tok', date_of_birth: '1995-06-01' }));
  assert.strictEqual(g.status, 200, 'the Google door was still shut by a stranger');
  assert.strictEqual(users.length, 1);

  // Door 3 — Apple.
  reset();
  const victim3 = 'blocked-apple@example.com';
  await postFrom(ATTACKER_IP, '/api/auth/signup', {
    email: victim3, password: 'Password1', name: 'Kid', date_of_birth: '2020-01-01',
  });
  const a = await postFrom(VICTIM_IP, '/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-victim', email: victim3, email_verified: true }),
    date_of_birth: '1995-06-01', authorizationCode: 'code',
  });
  assert.strictEqual(a.status, 200, 'the Apple door was still shut by a stranger');
  assert.strictEqual(users.length, 1);
  assertQueriesUnderstood(2);
});

// The PROVED half of the same control, which is what keeps the FTC FAQ's
// anti-back-button step at full strength where it can be: an address nobody but
// its owner could have put in front of us stays blocked wherever they go.
test('H1b — a refusal on a PROVED address is still remembered against the address itself', async () => {
  reset();
  const { underageKey, underagePairKey, underageAttemptHas, underageBlocked, UNDERAGE_MSG } = authRouter.__testing;

  // Route A: a legacy account signs in and answers the DOB prompt with an
  // under-13 date. The password check already ran, so this address is theirs.
  const row = seedUser({ email: 'legacy-kid@example.com', date_of_birth: null });
  const login = await postFrom('203.0.113.40', '/api/auth/login', {
    email: 'legacy-kid@example.com', password: 'Password1', date_of_birth: '2020-01-01',
  });
  assert.strictEqual(login.status, 403);
  assert.strictEqual((await login.json()).error, UNDERAGE_MSG);
  assert.strictEqual(row.date_of_birth, '2020-01-01', 'the actual knowledge was not persisted');
  assert.ok(underageAttemptHas(underageKey('email', 'legacy-kid@example.com')),
    'a proved refusal did not write the wide block');
  assert.strictEqual(underageBlocked('legacy-kid@example.com', '198.51.100.200'), true,
    'the child escaped the block by changing networks');

  // Route B: a Google account creation Google DID vouch for. Same rule, and the
  // child cannot come back through the password door from a café either.
  reset();
  const kidGoogle = await withGoogle(
    { sub: 'g-kid', email: 'g-kid@example.com', email_verified: true, name: 'Kid' },
    () => postFrom('203.0.113.41', '/api/auth/google', { access_token: 'kid-tok', date_of_birth: '2020-01-01' }));
  assert.strictEqual(kidGoogle.status, 403);
  assert.ok(underageAttemptHas(underageKey('email', 'g-kid@example.com')));
  const elsewhere = await postFrom('198.51.100.201', '/api/auth/signup', {
    email: 'g-kid@example.com', password: 'Password1', name: 'Kid', date_of_birth: '1995-06-01',
  });
  assert.strictEqual(elsewhere.status, 403, 'a provider-proved under-13 refusal did not follow the mailbox');
  assert.strictEqual(users.length, 0);
  // And it is the address-keyed entry doing it, not a leftover pair entry from
  // some other network.
  assert.strictEqual(underageAttemptHas(underagePairKey('g-kid@example.com', '198.51.100.201')), false);
  assertQueriesUnderstood(1);
});

// FIXED (H2). The Google ACCESS-TOKEN branch used to take none of the
// protections the ID-token branch takes: presenting one credential twice
// returned two 200s, each carrying a fresh `iat`, and a fresh `iat` is the
// ENTIRE sudo-mode proof for an OAuth account (hasFreshSession in
// routes/users.js gates DELETE /api/users/me, the phone-number change and the
// full data export). GOOGLE_REQUIRE_NONCE did not reach the branch either, so
// the flag refused half the endpoint and left the other half unbound.
test('H2 — a Google access token is single-use, and the nonce flag covers both branches', async () => {
  // GOOGLE_REQUIRE_NONCE is the switch that makes nonce binding mandatory. It
  // now means that on BOTH branches. An access token carries no nonce and
  // cannot be bound to one, so with the flag on the branch is closed rather
  // than waved through.
  reset();
  process.env.GOOGLE_REQUIRE_NONCE = 'true';
  try {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID,
      sub: 'g-nonce-req', email: 'noncereq@example.com', email_verified: true,
      iat: now, exp: now + 3600,
    };
    const gated = await withGoogleIdToken(payload,
      () => post('/api/auth/google', { credential: googleWire(payload), date_of_birth: '2000-01-01' }));
    assert.strictEqual(gated.status, 400, 'GOOGLE_REQUIRE_NONCE did not gate the credential path');

    const alsoGated = await withGoogle({ sub: 'g-at2', email: 'at2@example.com', email_verified: true, name: 'AT2' },
      () => post('/api/auth/google', { access_token: 'another-token', date_of_birth: '2000-01-01' }));
    assert.strictEqual(alsoGated.status, 400,
      'GOOGLE_REQUIRE_NONCE still leaves the access-token half of the endpoint unbound');
    // Same neutral sentence on both halves, so the flag cannot be probed by
    // comparing the two refusals.
    assert.deepStrictEqual(await alsoGated.json(), await gated.json());
    assert.strictEqual(users.length, 0);
  } finally {
    delete process.env.GOOGLE_REQUIRE_NONCE;
  }

  reset();
  const profile = { sub: 'g-at', email: 'at@example.com', email_verified: true, name: 'AT' };

  const first = await withGoogle(profile,
    () => post('/api/auth/google', { access_token: 'the-same-token', date_of_birth: '2000-01-01' }));
  assert.strictEqual(first.status, 200);
  const second = await withGoogle(profile,
    () => post('/api/auth/google', { access_token: 'the-same-token', date_of_birth: '2000-01-01' }));
  assert.strictEqual(second.status, 401,
    'the same access token minted a second session, and with it a second fresh iat');
  assert.strictEqual(users.length, 1, 'the replay created a second row');

  // Parallel, not just sequential — the R4-A1 shape. Ten simultaneous
  // presentations of one captured token must yield exactly one session.
  reset();
  const par = { sub: 'g-par', email: 'par@example.com', email_verified: true, name: 'Par' };
  const races = await withGoogle(par, () => Promise.all(Array.from({ length: 10 }, () =>
    post('/api/auth/google', { access_token: 'raced-token', date_of_birth: '2000-01-01' }))));
  const won = races.filter((r) => r.status === 200);
  assert.strictEqual(won.length, 1, `${won.length} of 10 parallel replays minted a session`);

  // The one session that IS minted is sudo-capable, which is what makes the
  // refusal above matter rather than being pedantry.
  const body = await won[0].json();
  assert.strictEqual(require('../routes/users').__testing.hasFreshSession(
    { headers: { authorization: `Bearer ${body.token}` } }
  ), true, 'sanity: a real Google sign-in is sudo-capable, so a replay of one would be too');
  assert.strictEqual(jwt.decode(body.token).userId, users[0].id);

  // A refusal must still hand the credential back. `needsDob` tells the client
  // to collect a birthday and come back with the SAME access token, and an
  // upstream blip must be retryable without another trip through Google.
  reset();
  const dobless = { sub: 'g-dob', email: 'dob@example.com', email_verified: true, name: 'Dob' };
  const nodob = await withGoogle(dobless,
    () => post('/api/auth/google', { access_token: 'retry-token' }));
  assert.strictEqual(nodob.status, 403);
  assert.strictEqual((await nodob.json()).needsDob, true);
  const retried = await withGoogle(dobless,
    () => post('/api/auth/google', { access_token: 'retry-token', date_of_birth: '2000-01-01' }));
  assert.strictEqual(retried.status, 200,
    'the claim was not released on a refusal — a user who hit needsDob is now locked out');
  assert.strictEqual(users.length, 1);
  assertQueriesUnderstood(2);
});

// FIXED (H3). The round-16 squat, run the way it still worked. The gate says an
// unverified row cannot accumulate; it does not say a squatter cannot get the
// address's real owner to CLICK the confirmation link that landed in their
// inbox. Once they do, the row has "proved" the mailbox, the gate opens, and the
// squatter writes payment handles onto it. The claim then hands the row to the
// owner with those handles still attached, so every bill split the victim runs
// pays the attacker under the victim's own name. The claim now clears the three
// handle columns, the way releaseSquattedAddress already did on the other
// outcome of the same fork.
test('H3 — a squat whose verification link gets clicked is handed over stripped', async () => {
  reset();
  // 1. The attacker registers the victim's address. Unverified, so gated.
  const created = await post('/api/auth/signup', {
    email: 'chain-victim@example.com', password: 'Password1', name: 'Attacker', date_of_birth: '2000-01-01',
  });
  assert.strictEqual(created.status, 201);
  const squat = users[0];
  assert.strictEqual(squat.email_verified, false);
  const attackerToken = (await created.json()).token;
  assert.strictEqual((await put('/api/users/venmo-username', { venmo_username: '@attacker' }, attackerToken)).status, 403,
    'an unverified row could set a payment handle');

  // 2. The mail signup already sent went to the VICTIM's mailbox. They click it.
  const mailed = sentMail.map((m) => `${m.html || ''}${m.text || ''}`).join(' ');
  const found = mailed.match(/verify-email\?token=([A-Za-z0-9_.%-]+)/);
  assert.ok(found, 'signup sent no verification link');
  const raw = decodeURIComponent(found[1]);
  assert.strictEqual((await post('/api/auth/verify-email', { token: raw })).status, 200);
  assert.strictEqual(squat.email_verified, true);
  assert.strictEqual(squat.verified_email, 'chain-victim@example.com');

  // 3. The gate is open, so the attacker loads the row with the assets.
  assert.strictEqual((await put('/api/users/venmo-username', { venmo_username: '@attacker' }, attackerToken)).status, 200);
  squat.venmo_username = '@attacker';   // the stub route above does not write

  // 4. The victim signs in with Google on their own address.
  const claimed = await withGoogle(
    { sub: 'g-chain', email: 'chain-victim@example.com', email_verified: true, name: 'Victim' },
    () => post('/api/auth/google', { access_token: 'tok', date_of_birth: '2000-01-01' }));
  assert.strictEqual(claimed.status, 200);

  // The victim did NOT get a fresh account. They got the attacker's row.
  assert.strictEqual(users.length, 1, 'a second row was created — the claim did not fire');
  assert.strictEqual(squat.oauth_provider, 'google');
  assert.strictEqual(squat.password, null);
  assert.strictEqual(squat.venmo_username, null,
    'the attacker\'s payout handle survived the claim and now belongs to the victim');
  assert.strictEqual(squat.cashapp_cashtag, null);
  assert.strictEqual(squat.zelle_identifier, null);
  // The attacker's own session is evicted by the version bump.
  assert.strictEqual(squat.token_version, 1);
  assert.strictEqual((await restAuth(attackerToken)).status, 401);
  assertQueriesUnderstood(8);
});

// Attack: the per-account login throttle is keyed on canonicalEmail(). Try to
// mint a fresh bucket for one mailbox by respelling the address.
test('H4 — the login throttle cannot be reset by respelling the address', async () => {
  reset();
  const { LOGIN_FAIL_LIMIT } = authRouter.__testing;
  seedUser({ email: 'johndoe@gmail.com', password: bcrypt.hashSync('RealPassword1', 4) });

  for (let i = 0; i < LOGIN_FAIL_LIMIT; i++) {
    const r = await post('/api/auth/login', { email: 'johndoe@gmail.com', password: `wrong${i}A1` });
    assert.strictEqual(r.status, 401);
  }
  assert.strictEqual((await post('/api/auth/login', { email: 'johndoe@gmail.com', password: 'RealPassword1' })).status, 429);

  for (const spelling of ['JohnDoe@Gmail.com', 'john.doe@gmail.com', 'j.o.h.n.d.o.e+tag@gmail.com',
    'johndoe@googlemail.com', 'JOHNDOE@GOOGLEMAIL.COM']) {
    const r = await post('/api/auth/login', { email: spelling, password: 'RealPassword1' });
    assert.strictEqual(r.status, 429, `spelling ${spelling} minted a fresh throttle bucket`);
  }
  assertQueriesUnderstood(1);
});

// Attack: an attacker holding a STALE token for an OAuth account wants a FRESH
// one, because a fresh `iat` is the whole sudo-mode proof for account deletion,
// the phone change and the data export. Enumerate every response in the app that
// carries a token and check that none is reachable on a bearer token alone.
test('H5 — nothing lets a stale token be exchanged for a fresh one', async () => {
  reset();
  const fs = require('node:fs');
  const path = require('node:path');

  const auth = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  const usersSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'users.js'), 'utf8');
  // Four mints in routes/auth.js (signup, login, google, apple) plus the import
  // line, and one mint in routes/users.js plus its import line.
  const mintCalls = (auth.match(/= signUserToken\(/g) || []).length
    + (usersSrc.match(/signUserToken\(result\.rows\[0\]\)/g) || []).length;
  assert.strictEqual(mintCalls, 5,
    'a signUserToken call site appeared or vanished — re-audit which ones a bearer token alone can reach');

  // The only authenticated one is PUT /api/users/profile, and it mints ONLY when
  // a password actually changed — which requires the current password, and is
  // refused outright on an OAuth row, i.e. exactly the accounts for which `iat`
  // is the proof.
  assert.ok(usersSrc.includes('...(hashedPassword ? { token: signUserToken(result.rows[0]) } : {})'));
  assert.match(usersSrc, /\} else if \(new_password\) \{[\s\S]{0,200}signs in with Google or Apple and has no password/);

  // And an OAuth row cannot reach /login to mint one either: no password means
  // the compare runs against the dummy hash and the answer is 401.
  const oauthUser = seedUser({
    email: 'stale@example.com', password: null, oauth_provider: 'google', oauth_id: 'g-stale',
  });
  const r = await post('/api/auth/login', { email: oauthUser.email, password: 'anythingAtAll1' });
  assert.strictEqual(r.status, 401);
  assert.strictEqual((await r.json()).error, 'Invalid email or password');
  assertQueriesUnderstood(1);
});

// Attack: race the single-use guard. Two clicks, or two submissions, arrive at
// once; both pass the read; only the guarded UPDATE decides. If single use were
// enforced by the SELECT above it, both would win.
test('H6 — single use survives a race, on both link families', async () => {
  reset();

  // Password reset: ten simultaneous submissions of one link, each with its own
  // new password. Exactly one may win, and the winner's password is the one that
  // is stored.
  const u = seedUser({ email: 'race@example.com' });
  const raw = await issueResetFor(u);
  const submissions = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    post('/api/auth/reset-password', { token: raw, password: `RacePass${i}1` })));
  const won = submissions.filter((r) => r.status === 200);
  assert.strictEqual(won.length, 1, `${won.length} of 10 concurrent resets were accepted`);
  const winners = [];
  for (let i = 0; i < 10; i++) {
    if (await bcrypt.compare(`RacePass${i}1`, u.password)) winners.push(i);
  }
  assert.strictEqual(winners.length, 1, 'more than one concurrent reset wrote a password');
  assert.strictEqual(u.token_version, 1, 'the version was bumped more than once, or not at all');

  // Email verification: the same race, plus the real-world version of it — a
  // mailbox scanner spends the token and then the human clicks. The second read
  // reports the state honestly rather than erroring, but nothing is re-verified.
  const v = seedUser({ email: 'racev@example.com', email_verified: false, verified_email: null });
  const rawV = await issueVerificationFor(v);
  verifyWrites = 0;
  const clicks = await Promise.all(Array.from({ length: 10 },
    () => post('/api/auth/verify-email', { token: rawV })));
  // Every click answers 200, and that is deliberate: once the account IS
  // verified, a spent token reports the state rather than an error, because
  // Outlook Safe Links and friends prefetch the link before the human clicks it.
  // So count the WRITE, which is the thing single use has to bound.
  assert.ok(clicks.every((r) => r.status === 200));
  assert.strictEqual(verifyWrites, 1, `${verifyWrites} of 10 concurrent clicks wrote a verification`);
  assert.strictEqual(v.email_verified, true);
  assert.strictEqual(verifications.filter((x) => x.user_id === v.id && !x.used_at).length, 0);
  assertQueriesUnderstood(10);
});

// Attack: the GET half of verification is a link in an email, so it answers with
// a redirect. Try to steer that redirect.
test('H7 — the verification redirect cannot be steered anywhere', async () => {
  reset();
  const u = seedUser({ email: 'redir@example.com', email_verified: false, verified_email: null });
  const raw = await issueVerificationFor(u);

  const probes = [
    `/api/auth/verify-email?token=${encodeURIComponent(raw)}`,
    `/api/auth/verify-email?token=${encodeURIComponent(raw)}&next=https://evil.test`,
    '/api/auth/verify-email?token=nonsense',
    '/api/auth/verify-email',
    '/api/auth/verify-email?token[]=a&token[]=b',
  ];
  for (const path of probes) {
    const r = await fetch(base + path, {
      redirect: 'manual',
      headers: { Host: 'evil.test', 'X-Forwarded-Host': 'evil.test', 'X-Forwarded-Proto': 'http' },
    });
    assert.strictEqual(r.status, 302, `${path} did not redirect`);
    const loc = r.headers.get('location');
    assert.ok(loc.startsWith('https://web.flock.test/'), `${path} redirected to ${loc}`);
    assert.ok(!loc.includes('evil.test'), `${path} redirected to ${loc}`);
  }
  assertQueriesUnderstood(2);
});

// Attack: every socket that authenticates has to be reachable by
// revokeUserSessions, or a revocation is advisory. The room it must be in is
// joined by registerHandlers, not by an event the client chooses to send.
test('H8 — an authenticated socket is always in the room revocation targets', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const handlers = fs.readFileSync(path.join(__dirname, '..', 'sockets', 'handlers.js'), 'utf8');
  const at = handlers.indexOf('socket.join(`user:${user.id}`)');
  assert.notStrictEqual(at, -1, 'nothing joins the per-user room any more');
  // It must not sit inside a socket.on(...) callback, which would make room
  // membership depend on a client sending something first.
  const before = handlers.slice(0, at);
  const lastOn = before.lastIndexOf('socket.on(');
  const lastClose = before.lastIndexOf('\n  });');
  assert.ok(lastClose > lastOn,
    'the per-user room join happens inside a socket.on handler — a socket that never sends that event escapes revocation');
  // And revokeUserSessions targets exactly that room name.
  const mw = fs.readFileSync(path.join(__dirname, '..', 'middleware', 'auth.js'), 'utf8');
  assert.ok(mw.includes('io.in(`user:${userId}`).disconnectSockets(true)'));
  // As does the moderator ban path.
  const admin = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
  assert.ok(admin.includes('io.in(`user:${banTargetId}`).disconnectSockets(true)'));
});
