// Run: node --test  (from backend/)
//
// Round 18 re-audit of routes/auth.js, middleware/auth.js and routes/users.js.
//
// WHY THIS FILE EXISTS AT ALL, given emailVerification.test.js and
// passwordReset.test.js already cover this area. A mutation run over those
// suites found clauses that could be deleted from the production SQL without a
// single test going red — the two that matter most being the `token_version`
// bump in the OAuth account claim (the entire mechanism that evicts a
// squatter's live session) and the payment-handle clearing in squat eviction
// (the entire reason a squat is not worth running). Both are covered "by
// assertion" in those files, and both assertions pass against a database fake
// that matches a PREFIX of the statement and then re-implements the row change
// in JavaScript. The fake, not the code, is what those assertions test.
//
// So the fake here executes the statement instead of recognising it. `UPDATE
// users` and `INSERT INTO users` are parsed — SET list, WHERE clause, VALUES
// list — and evaluated against in-memory rows. Nothing dispatches on the shape
// of a statement to decide what it does; the only thing that decides what a
// statement does is the statement. Delete a clause from routes/auth.js and the
// clause stops happening here, exactly as it would in Postgres.
//
// Two tests below go further and prove that directly: they take the SQL the
// route actually ran, delete the clause under test from it, replay it through
// the same engine, and assert the effect disappears. That is the check that the
// assertion is load-bearing on the production clause rather than on this file.

// Env must be set before ANY require.
process.env.JWT_SECRET = 'test-secret-for-auth-reaudit-tests';
process.env.GOOGLE_CLIENT_ID = 'flock-reaudit.apps.googleusercontent.com';
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
// Module stubs, installed in the require cache BEFORE the routers load.
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
const usersRouter = require('../routes/users');
const authMod = require('../middleware/auth');
const { signUserToken } = authMod;
const { canonicalEmail, suppliedDob } = authRouter.__testing;
const { proofFailures, phoneChangeAttempts } = usersRouter.__testing;

const appleIdentityToken = (claims) => jwt.sign(
  { iss: 'https://appleid.apple.com', aud: 'com.flockcorp.flock', ...claims },
  APPLE_PRIV,
  { algorithm: 'RS256', expiresIn: '10m', keyid: 'test-kid' }
);

// ===========================================================================
// A SQL-EXECUTING FAKE
// ===========================================================================
// Everything below is deliberately generic. It knows about expressions, not
// about statements: it has never heard of token_version, of payment handles or
// of email_verified, so it cannot accidentally supply a clause the route
// stopped emitting.

// Split on a separator that appears at parenthesis depth 0 and outside quotes.
function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '(') { depth += 1; continue; }
    if (c === ')') { depth -= 1; continue; }
    if (depth === 0 && text.startsWith(sep, i)) {
      out.push(text.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

// The balanced group starting at the first '(' at or after `from`.
function readParen(text, from) {
  const start = text.indexOf('(', from);
  if (start === -1) throw new Error('SQL fake: expected a parenthesised group');
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(start + 1, i), end: i };
    }
  }
  throw new Error('SQL fake: unbalanced parentheses');
}

function evalExpr(expr, row, params) {
  const e = String(expr).trim();

  // Arithmetic first: `token_version + 1`, `token_version + CASE ... END`.
  const summands = splitTop(e, '+');
  if (summands.length > 1) {
    return summands.reduce((acc, part) => acc + Number(evalExpr(part, row, params)), 0);
  }

  let m;
  if ((m = /^\$(\d+)(?:::\w+)?$/.exec(e))) {
    const v = params[Number(m[1]) - 1];
    return v === undefined ? null : v;
  }
  if (/^NOW\(\)$/i.test(e)) return new Date().toISOString();
  if (/^NULL$/i.test(e)) return null;
  if (/^TRUE$/i.test(e)) return true;
  if (/^FALSE$/i.test(e)) return false;
  if (/^-?\d+$/.test(e)) return Number(e);
  if (/^'[\s\S]*'$/.test(e)) return e.slice(1, -1);
  if ((m = /^CASE\s+WHEN\s+([\s\S]+?)\s+THEN\s+([\s\S]+?)\s+ELSE\s+([\s\S]+?)\s+END$/i.exec(e))) {
    return evalCondition(m[1], row, params)
      ? evalExpr(m[2], row, params)
      : evalExpr(m[3], row, params);
  }
  if ((m = /^COALESCE\(([\s\S]+)\)$/i.exec(e))) {
    for (const arg of splitTop(m[1], ',')) {
      const v = evalExpr(arg, row, params);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(e)) {
    if (!(e in row)) throw new Error(`SQL fake: statement referenced unknown column "${e}"`);
    return row[e];
  }
  throw new Error(`SQL fake: unsupported expression "${e}"`);
}

function evalCondition(cond, row, params) {
  return splitTop(cond, ' AND ').every((atom) => evalAtom(atom, row, params));
}

function evalAtom(atom, row, params) {
  const c = atom.trim().replace(/^\(([\s\S]*)\)$/, '$1').trim();
  let m;
  if ((m = /^([\s\S]+?)\s+IS\s+NOT\s+TRUE$/i.exec(c))) return evalExpr(m[1], row, params) !== true;
  if ((m = /^([\s\S]+?)\s+IS\s+NOT\s+NULL$/i.exec(c))) {
    const v = evalExpr(m[1], row, params);
    return v !== null && v !== undefined;
  }
  if ((m = /^([\s\S]+?)\s+IS\s+NULL$/i.exec(c))) {
    const v = evalExpr(m[1], row, params);
    return v === null || v === undefined;
  }
  if ((m = /^LOWER\(([\s\S]+?)\)\s*=\s*LOWER\(([\s\S]+?)\)$/i.exec(c))) {
    const l = evalExpr(m[1], row, params);
    const r = evalExpr(m[2], row, params);
    if (l === null || r === null) return false;
    return String(l).toLowerCase() === String(r).toLowerCase();
  }
  if ((m = /^([\s\S]+?)\s*!=\s*([\s\S]+)$/.exec(c))) {
    return evalExpr(m[1], row, params) !== evalExpr(m[2], row, params);
  }
  if ((m = /^([\s\S]+?)\s*=\s*([\s\S]+)$/.exec(c))) {
    const l = evalExpr(m[1], row, params);
    const r = evalExpr(m[2], row, params);
    if (l === null || r === null) return false; // SQL three-valued logic
    return l === r;
  }
  throw new Error(`SQL fake: unsupported condition "${c}"`);
}

// A users row with every column any of the three files reads, so a statement
// that mentions a column this fixture forgot fails loudly instead of silently.
function blankUser(overrides = {}) {
  return {
    id: null, email: null, name: null, phone: null, password: null,
    interests: [], role: 'user', profile_image_url: null,
    oauth_provider: null, oauth_id: null, apple_refresh_token: null,
    is_banned: false, banned_at: null, token_version: 0,
    email_verified: false, verified_email: null, date_of_birth: null,
    terms_accepted_at: null, is_premium: false,
    venmo_username: null, cashapp_cashtag: null, zelle_identifier: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

let db;
function freshDb() {
  db = {
    users: [],
    verifications: [],
    resets: [],
    resetRequests: [],
    nextUserId: 1,
    nextVerificationId: 1,
    nextResetId: 1,
    identityTombstoned: false,
  };
}
freshDb();

// UPDATE users SET <assignments> WHERE <condition> [RETURNING ...]
function runUsersUpdate(sql, params) {
  const retAt = sql.search(/\sRETURNING\s/i);
  const body = retAt > -1 ? sql.slice(0, retAt) : sql;
  const m = /^UPDATE\s+users\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)$/i.exec(body);
  if (!m) throw new Error(`SQL fake: cannot parse UPDATE "${sql}"`);
  const assignments = splitTop(m[1], ',');
  const matched = db.users.filter((u) => evalCondition(m[2], u, params));
  for (const row of matched) {
    // Every right-hand side is evaluated against the PRE-update row, the way
    // one SQL statement sees a single snapshot. `verified_email = email` in the
    // claim depends on exactly this.
    const next = {};
    for (const a of assignments) {
      const eq = a.indexOf('=');
      if (eq < 1) throw new Error(`SQL fake: cannot parse assignment "${a}"`);
      next[a.slice(0, eq).trim()] = evalExpr(a.slice(eq + 1), row, params);
    }
    Object.assign(row, next);
  }
  return { rows: matched.map((r) => ({ ...r })), rowCount: matched.length };
}

// INSERT INTO users (cols) VALUES (exprs) [RETURNING ...]
function runUsersInsert(sql, params) {
  const cols = readParen(sql, 0);
  const valuesAt = sql.toUpperCase().indexOf('VALUES', cols.end);
  if (valuesAt === -1) throw new Error(`SQL fake: cannot parse INSERT "${sql}"`);
  const vals = readParen(sql, valuesAt);
  const names = splitTop(cols.inner, ',');
  const exprs = splitTop(vals.inner, ',');
  if (names.length !== exprs.length) {
    throw new Error(`SQL fake: INSERT column/value count mismatch (${names.length} vs ${exprs.length})`);
  }
  const row = blankUser({ id: db.nextUserId++ });
  names.forEach((name, i) => { row[name] = evalExpr(exprs[i], {}, params); });
  db.users.push(row);
  return { rows: [{ ...row }], rowCount: 1 };
}

const findUserByEmail = (addr) => db.users.find((u) => String(u.email).toLowerCase() === String(addr).toLowerCase())
  || db.users.find((u) => canonicalEmail(u.email) === canonicalEmail(addr))
  || null;

let executed = [];
const realQuery = pool.query;
const realConnect = pool.connect;

async function handle(text, params = []) {
  const sql = String(typeof text === 'string' ? text : text.text).replace(/\s+/g, ' ').trim();
  executed.push(sql);
  const now = Date.now();

  // ---- writes to users: EXECUTED, never recognised --------------------------
  if (/^UPDATE\s+users\s+SET/i.test(sql)) return runUsersUpdate(sql, params);
  if (/^INSERT\s+INTO\s+users\s*\(/i.test(sql)) return runUsersInsert(sql, params);

  // ---- reads. Shape is not what this file pins, so these stay hand written --
  if (sql.includes('is_banned, token_version FROM users WHERE id = $1')) {
    const u = db.users.find((x) => x.id === params[0]);
    return {
      rows: u ? [{
        id: u.id, email: u.email, name: u.name, role: u.role,
        email_verified: u.email_verified, is_banned: u.is_banned, token_version: u.token_version,
      }] : [],
    };
  }
  if (sql.includes('split_part') && sql.startsWith('SELECT * FROM users')) {
    const hit = findUserByEmail(params[0]);
    return { rows: hit ? [hit] : [] };
  }
  if (sql.includes("oauth_provider = 'google' AND oauth_id")) {
    return { rows: db.users.filter((u) => u.oauth_provider === 'google' && u.oauth_id === params[0]) };
  }
  if (sql.includes("oauth_provider = 'apple' AND oauth_id")) {
    return { rows: db.users.filter((u) => u.oauth_provider === 'apple' && u.oauth_id === params[0]) };
  }
  if (sql === 'SELECT * FROM users WHERE LOWER(email) = LOWER($1)') {
    return { rows: db.users.filter((u) => String(u.email).toLowerCase() === String(params[0]).toLowerCase()) };
  }
  if (sql === 'SELECT * FROM users WHERE id = $1') {
    return { rows: db.users.filter((u) => u.id === params[0]) };
  }
  if (sql.startsWith('SELECT id FROM users WHERE LOWER(email)')) {
    // The canonical half is applied only when the STATEMENT carries it, so
    // deleting that branch from routes/users.js deletes it here too.
    const canonicalAware = sql.includes('split_part');
    const hit = db.users.find((u) => u.id !== params[1] && (
      String(u.email).toLowerCase() === String(params[0]).toLowerCase()
      || (canonicalAware && canonicalEmail(u.email) === params[2])
    ));
    return { rows: hit ? [{ id: hit.id }] : [] };
  }
  if (sql.includes('RIGHT(REGEXP_REPLACE(phone')) {
    const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);
    const hit = db.users.find((u) => u.id !== params[0] && u.phone && digits(u.phone) === params[1]);
    return { rows: hit ? [{ id: hit.id }] : [] };
  }
  if (/^SELECT [\s\S]*FROM users WHERE id = \$1$/i.test(sql)) {
    return { rows: db.users.filter((u) => u.id === params[0]) };
  }
  if (sql.startsWith("SELECT COUNT(*) FROM flock_members")) return { rows: [{ count: '0' }] };

  // ---- email_verifications -------------------------------------------------
  if (sql.startsWith('INSERT INTO email_verifications')) {
    db.verifications.push({
      id: db.nextVerificationId++, user_id: params[0], selector: params[1],
      verifier_hash: params[2], email: params[3], request_ip: params[4],
      expires_at: new Date(now + params[5] * 3600 * 1000).toISOString(),
      used_at: null, created_at: new Date(now).toISOString(),
    });
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE email_verifications SET used_at')) {
    if (sql.includes('WHERE id = $1')) {
      const v = db.verifications.find((x) => x.id === params[0]);
      const ok = Boolean(v && !v.used_at && Date.parse(v.expires_at) > now);
      if (ok) v.used_at = new Date(now).toISOString();
      return { rows: ok ? [{ id: v.id }] : [], rowCount: ok ? 1 : 0 };
    }
    let n = 0;
    for (const v of db.verifications) {
      if (v.user_id === params[0] && !v.used_at) { v.used_at = new Date(now).toISOString(); n += 1; }
    }
    return { rows: [], rowCount: n };
  }
  if (sql.startsWith('SELECT COUNT(*)') && sql.includes('FROM email_verifications')) {
    const mine = db.verifications.filter((v) => v.user_id === params[0]);
    const within = (v, ms) => now - Date.parse(v.created_at) < ms;
    return {
      rows: [{
        account_hour: mine.filter((v) => within(v, 3600e3)).length,
        account_day: mine.filter((v) => within(v, 86400e3)).length,
        account_last: mine.length ? mine[mine.length - 1].created_at : null,
        ip_hour: db.verifications.filter((v) => v.request_ip === params[1] && within(v, 3600e3)).length,
      }],
    };
  }
  if (sql.startsWith('SELECT v.id, v.user_id')) {
    const v = db.verifications.find((x) => x.selector === params[0]);
    if (!v) return { rows: [] };
    const u = db.users.find((x) => x.id === v.user_id);
    return { rows: [{ ...v, current_email: u?.email ?? null, email_verified: u?.email_verified ?? null }] };
  }

  // ---- password_resets / password_reset_requests ---------------------------
  if (sql.startsWith('INSERT INTO password_resets')) {
    db.resets.push({
      id: db.nextResetId++, user_id: params[0], selector: params[1], verifier_hash: params[2],
      email: params[3], request_ip: params[4],
      expires_at: new Date(now + params[5] * 60 * 1000).toISOString(),
      used_at: null, created_at: new Date(now).toISOString(),
    });
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE password_resets SET used_at')) {
    if (sql.includes('WHERE id = $1')) {
      const r = db.resets.find((x) => x.id === params[0]);
      const ok = Boolean(r && !r.used_at && Date.parse(r.expires_at) > now);
      if (ok) r.used_at = new Date(now).toISOString();
      return { rows: ok ? [{ id: r.id }] : [], rowCount: ok ? 1 : 0 };
    }
    let n = 0;
    for (const r of db.resets) {
      if (r.user_id === params[0] && !r.used_at) { r.used_at = new Date(now).toISOString(); n += 1; }
    }
    return { rows: [], rowCount: n };
  }
  if (sql.startsWith('SELECT r.id, r.user_id')) {
    const r = db.resets.find((x) => x.selector === params[0]);
    if (!r) return { rows: [] };
    const u = db.users.find((x) => x.id === r.user_id);
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
  if (sql.startsWith('SELECT COUNT(*)') && sql.includes('FROM password_reset_requests')) {
    const within = (r, ms) => now - Date.parse(r.created_at) < ms;
    const mine = db.resetRequests.filter((r) => r.email_key === params[0]);
    return {
      rows: [{
        email_hour: mine.filter((r) => within(r, 3600e3)).length,
        email_day: mine.filter((r) => within(r, 86400e3)).length,
        email_last: mine.length ? mine[mine.length - 1].created_at : null,
        ip_hour: db.resetRequests.filter((r) => r.request_ip === params[1] && within(r, 3600e3)).length,
      }],
    };
  }
  if (sql.startsWith('INSERT INTO password_reset_requests')) {
    db.resetRequests.push({ email_key: params[0], request_ip: params[1], created_at: new Date(now).toISOString() });
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith('DELETE FROM password_reset_requests')) return { rows: [], rowCount: 0 };

  // ---- banned_identities ---------------------------------------------------
  if (sql.startsWith('SELECT 1 FROM banned_identities')) {
    return { rows: db.identityTombstoned ? [{ ok: 1 }] : [] };
  }
  if (sql.startsWith('DELETE FROM banned_identities')) return { rows: [], rowCount: 0 };

  // ---- deletion transaction (not exercised here, kept so nothing 500s) -----
  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [], rowCount: 0 };
  if (sql.startsWith('UPDATE content_reports') || sql.startsWith('UPDATE moderation_actions')) {
    return { rows: [], rowCount: 0 };
  }
  if (sql.startsWith('DELETE FROM messages')) return { rows: [], rowCount: 0 };
  if (sql.startsWith('DELETE FROM users WHERE id = $1')) {
    const i = db.users.findIndex((u) => u.id === params[0]);
    if (i === -1) return { rows: [], rowCount: 0 };
    db.users.splice(i, 1);
    return { rows: [{ id: params[0] }], rowCount: 1 };
  }

  throw new Error(`unstubbed query: ${sql.slice(0, 160)}`);
}

pool.query = (text, params) => handle(text, params);
pool.connect = async () => ({ query: (text, params) => handle(text, params), release() {} });

// ---------------------------------------------------------------------------
// App — the REAL auth and users routers, mounted the way server.js mounts them.
// ---------------------------------------------------------------------------
let disconnectedRooms = [];
const fakeIo = { in: (room) => ({ disconnectSockets: (c) => disconnectedRooms.push(`${room}|${c}`) }) };

const app = express();
app.use(express.json());
app.set('io', fakeIo);
app.use('/api/auth', authRouter);
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
  pool.end().catch(() => {});
});

const call = (method, path, body, token) => fetch(base + path, {
  method,
  headers: {
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const post = (p, b, t) => call('POST', p, b, t);

function reset() {
  freshDb();
  executed = [];
  sentMail = [];
  disconnectedRooms = [];
  proofFailures.clearAll();
  phoneChangeAttempts.clearAll();
  // The under-13 retry lockout (minors-compliance audit 2026-08-14) keys on
  // the client IP, and every test here shares 127.0.0.1 — one under-13 test
  // would otherwise block every later account creation in the file.
  authRouter.__testing.clearUnderageAttempts();
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

const PASSWORD = 'Password1';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 10);
const addUser = (overrides) => {
  const row = blankUser({ id: db.nextUserId++, ...overrides });
  db.users.push(row);
  return row;
};
const userById = (id) => db.users.find((u) => u.id === id);
const lastSql = (prefix) => [...executed].reverse().find((s) => s.startsWith(prefix));

// ===========================================================================
// Sanity: the engine really is generic
// ===========================================================================
test('the fake executes statements rather than recognising them', async () => {
  reset();
  addUser({ id: 1, email: 'a@example.com', token_version: 4, venmo_username: 'v' });

  // A statement no route in this app has ever run. A dispatcher keyed on
  // statement prefixes could not answer it; an evaluator can.
  const out = await pool.query(
    `UPDATE users SET token_version = token_version + 3, venmo_username = NULL,
       verified_email = email, is_premium = TRUE
     WHERE id = $1 AND is_banned IS NOT TRUE RETURNING id`,
    [1]
  );
  assert.strictEqual(out.rowCount, 1);
  assert.strictEqual(userById(1).token_version, 7);
  assert.strictEqual(userById(1).venmo_username, null);
  assert.strictEqual(userById(1).verified_email, 'a@example.com');
  assert.strictEqual(userById(1).is_premium, true);

  // And a WHERE that does not hold changes nothing.
  const miss = await pool.query('UPDATE users SET name = $1 WHERE id = $2 AND email_verified = TRUE', ['x', 1]);
  assert.strictEqual(miss.rowCount, 0);
  assert.strictEqual(userById(1).name, null);
});

// ===========================================================================
// PIN 1 — the token_version bump in the OAuth account claim
// ===========================================================================
// This bump is the whole mechanism that evicts a squatter's live session. The
// row is handed to the address's verified owner; without the bump the squatter
// keeps a JWT that is good for the rest of its 24 hours ON THE VICTIM'S
// ACCOUNT, reading their DMs, flocks and location. Deleting the clause from
// routes/auth.js broke no test in the suite before this one.
// ===========================================================================

test('the Google claim bumps token_version, and the squatter\'s live JWT dies with it', async () => {
  reset();
  const row = addUser({
    id: 5, email: 'me@gmail.com', name: 'Me', password: PASSWORD_HASH,
    email_verified: true, verified_email: 'me@gmail.com', token_version: 3,
    date_of_birth: '2000-01-01', venmo_username: 'my-venmo',
  });
  const staleToken = signUserToken(row);
  assert.strictEqual((await call('GET', '/api/auth/me', null, staleToken)).status, 200,
    'the token is good before the claim, or the test after it proves nothing');

  const res = await withGoogle(
    { sub: 'g-1', email: 'me@gmail.com', email_verified: true, name: 'Me' },
    () => post('/api/auth/google', { access_token: 'opaque' })
  );
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  // Executed by the SQL engine off the route's own SET clause.
  assert.strictEqual(userById(5).token_version, 4, 'the claim must bump token_version');
  assert.strictEqual(userById(5).oauth_id, 'g-1');
  assert.strictEqual(userById(5).password, null, 'the squatter\'s password is cut off');
  assert.strictEqual(userById(5).verified_email, 'me@gmail.com',
    'verified_email records the address on the row at claim time');
  assert.strictEqual(userById(5).venmo_username, 'my-venmo', 'a real upgrade keeps its own data');

  // The consequence the bump exists for.
  const after = await call('GET', '/api/auth/me', null, staleToken);
  assert.strictEqual(after.status, 401, 'every JWT minted before the claim must be dead');
  assert.match((await after.json()).error, /Session expired/i);

  // And the person who just signed in is handed a working one.
  assert.strictEqual((await call('GET', '/api/auth/me', null, body.token)).status, 200);
  assert.deepStrictEqual(disconnectedRooms, ['user:5|true'], 'the live socket goes too');
});

test('the Apple claim bumps token_version the same way', async () => {
  reset();
  const row = addUser({
    id: 6, email: 'me@icloud.com', name: 'Me', password: PASSWORD_HASH,
    email_verified: true, verified_email: 'me@icloud.com', token_version: 0,
    date_of_birth: '2000-01-01',
  });
  const staleToken = signUserToken(row);

  const res = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-1', email: 'me@icloud.com', email_verified: true }),
  });
  assert.strictEqual(res.status, 200);

  assert.strictEqual(userById(6).token_version, 1);
  assert.strictEqual(userById(6).oauth_id, 'a-1');
  assert.strictEqual(userById(6).password, null);
  assert.strictEqual((await call('GET', '/api/auth/me', null, staleToken)).status, 401);
  assert.deepStrictEqual(disconnectedRooms, ['user:6|true']);
});

test('the bump assertion is load-bearing on the clause, not on the fake', async () => {
  // The mutation the last audit ran by hand: delete `token_version =
  // token_version + 1` from the claim and see whether anything notices. Here
  // the route's OWN statement is replayed with that clause removed, through the
  // same engine, against an identical row. If the assertions above could pass
  // without the clause, this would too — and it must not.
  reset();
  addUser({
    id: 5, email: 'me@gmail.com', password: PASSWORD_HASH,
    email_verified: true, verified_email: 'me@gmail.com', token_version: 3,
    date_of_birth: '2000-01-01',
  });
  await withGoogle(
    { sub: 'g-2', email: 'me@gmail.com', email_verified: true, name: 'Me' },
    () => post('/api/auth/google', { access_token: 'opaque' })
  );
  const claimSql = lastSql("UPDATE users SET oauth_provider = 'google'");
  assert.ok(claimSql, 'the Google claim statement must have run');
  assert.match(claimSql, /token_version = token_version \+ 1/,
    'the claim must still carry the bump — if this fails, the control is gone');

  const mutated = claimSql.replace(/token_version = token_version \+ 1,\s*/, '');
  assert.notStrictEqual(mutated, claimSql, 'the mutation must actually change the statement');

  db.users = [];
  addUser({
    id: 9, email: 'me@gmail.com', password: PASSWORD_HASH,
    email_verified: true, verified_email: 'me@gmail.com', token_version: 3,
  });
  await pool.query(mutated, ['g-mutant', null, 9]);
  assert.strictEqual(userById(9).token_version, 3,
    'without the clause the version does NOT move — so the tests above are testing the clause');
  assert.strictEqual(userById(9).oauth_id, 'g-mutant', 'and the rest of the statement still ran');

  // The unmutated statement, on the same fixture, does move it.
  db.users = [];
  addUser({
    id: 10, email: 'me@gmail.com', password: PASSWORD_HASH,
    email_verified: true, verified_email: 'me@gmail.com', token_version: 3,
  });
  await pool.query(claimSql, ['g-real', null, 10]);
  assert.strictEqual(userById(10).token_version, 4);
});

test('the Apple claim statement carries the bump too', async () => {
  reset();
  addUser({
    id: 6, email: 'me@icloud.com', password: PASSWORD_HASH,
    email_verified: true, verified_email: 'me@icloud.com', token_version: 0,
    date_of_birth: '2000-01-01',
  });
  await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-2', email: 'me@icloud.com', email_verified: true }),
  });
  const claimSql = lastSql("UPDATE users SET oauth_provider = 'apple'");
  assert.ok(claimSql);
  assert.match(claimSql, /token_version = token_version \+ 1/);

  const mutated = claimSql.replace(/token_version = token_version \+ 1,\s*/, '');
  db.users = [];
  addUser({ id: 11, email: 'me@icloud.com', password: PASSWORD_HASH, email_verified: true, token_version: 2 });
  await pool.query(mutated, ['a-mutant', 11]);
  assert.strictEqual(userById(11).token_version, 2, 'the clause is what does the work');
});

// ===========================================================================
// PIN 2 — payment handles are cleared when a squat is evicted
// ===========================================================================
// The squat exists to be inherited: the attacker's Venmo / Cash App / Zelle
// handles sitting on a row the victim is about to be given, so every bill split
// pays the attacker. Eviction hands the ADDRESS back and must strip those
// handles from the row it leaves behind. Deleting that clause also broke no
// test before this one.
// ===========================================================================

test('evicting a squat clears its Venmo, Cash App and Zelle handles', async () => {
  reset();
  addUser({
    id: 42, email: 'victim@gmail.com', name: 'Squatter', password: PASSWORD_HASH,
    email_verified: false, verified_email: null, token_version: 0,
    venmo_username: 'attacker-venmo', cashapp_cashtag: 'attackercash',
    zelle_identifier: 'attacker@zelle.example',
  });
  // An outstanding verification link the squatter could still click.
  db.verifications.push({
    id: db.nextVerificationId++, user_id: 42, selector: 'f'.repeat(32), verifier_hash: 'h',
    email: 'victim@gmail.com', request_ip: null, used_at: null,
    expires_at: new Date(Date.now() + 3600e3).toISOString(), created_at: new Date().toISOString(),
  });

  const res = await withGoogle(
    { sub: 'g-3', email: 'victim@gmail.com', email_verified: true, name: 'Real Owner' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: '2000-01-01' })
  );
  assert.strictEqual(res.status, 200);
  const body = await res.json();

  const squat = userById(42);
  assert.strictEqual(squat.venmo_username, null, 'a bill split must never be able to pay the evicted squatter');
  assert.strictEqual(squat.cashapp_cashtag, null);
  assert.strictEqual(squat.zelle_identifier, null);
  assert.match(squat.email, /^released\+42\.[0-9a-f]{12}@unclaimed\.invalid$/);
  assert.strictEqual(squat.email_verified, false);
  assert.strictEqual(squat.verified_email, null);
  assert.strictEqual(squat.token_version, 1, 'the squatter\'s sessions die with the address');
  assert.strictEqual(squat.oauth_provider, null, 'no identity is welded onto the squat');
  assert.strictEqual(db.verifications[0].used_at !== null, true, 'its outstanding link is retired');
  assert.deepStrictEqual(disconnectedRooms, ['user:42|true']);

  // The victim gets a clean row.
  assert.notStrictEqual(body.user.id, 42);
  assert.strictEqual(body.user.venmo_username ?? null, null);
  assert.strictEqual(userById(body.user.id).email_verified, true);
});

test('the Apple eviction clears them too', async () => {
  reset();
  addUser({
    id: 43, email: 'victim@icloud.com', name: 'Squatter', password: PASSWORD_HASH,
    email_verified: false, verified_email: null,
    venmo_username: 'attacker-venmo', cashapp_cashtag: 'attackercash', zelle_identifier: 'z@x.example',
  });

  const res = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-3', email: 'victim@icloud.com', email_verified: true }),
    date_of_birth: '2000-01-01',
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(userById(43).venmo_username, null);
  assert.strictEqual(userById(43).cashapp_cashtag, null);
  assert.strictEqual(userById(43).zelle_identifier, null);
});

test('the handle-clearing assertion is load-bearing on the clause too', async () => {
  reset();
  addUser({
    id: 42, email: 'victim@gmail.com', password: PASSWORD_HASH,
    email_verified: false, verified_email: null,
    venmo_username: 'attacker-venmo', cashapp_cashtag: 'attackercash', zelle_identifier: 'z@x.example',
  });
  await withGoogle(
    { sub: 'g-4', email: 'victim@gmail.com', email_verified: true, name: 'Owner' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: '2000-01-01' })
  );
  const evictSql = lastSql('UPDATE users SET email = $1, email_verified = FALSE');
  assert.ok(evictSql, 'the eviction statement must have run');
  assert.match(evictSql, /venmo_username = NULL, cashapp_cashtag = NULL, zelle_identifier = NULL/);

  const mutated = evictSql.replace(/venmo_username = NULL, cashapp_cashtag = NULL, zelle_identifier = NULL,\s*/, '');
  assert.notStrictEqual(mutated, evictSql);

  db.users = [];
  addUser({
    id: 44, email: 'victim2@gmail.com', password: PASSWORD_HASH,
    email_verified: false, verified_email: null,
    venmo_username: 'attacker-venmo', cashapp_cashtag: 'attackercash', zelle_identifier: 'z@x.example',
  });
  await pool.query(mutated, ['released+44.deadbeefcafe@unclaimed.invalid', 44]);
  assert.strictEqual(userById(44).venmo_username, 'attacker-venmo',
    'without the clause the handles survive — which is exactly the bug this pins');
  assert.strictEqual(userById(44).email, 'released+44.deadbeefcafe@unclaimed.invalid',
    'and the rest of the statement still ran, so the mutation is minimal');
});

// ===========================================================================
// RE-AUDIT 1 (HIGH) — an email change left a verified badge behind, which was a
// permanent squat on any address.
// ===========================================================================
// Verify your own mailbox, then move the row onto victim@gmail and stop.
// claimDecision() compares verified_email against the provider's address, sees
// a row that proved a DIFFERENT mailbox, and refuses — so the victim's Google
// sign-in 409s, their Apple sign-in 409s and password signup says "already
// registered", for ever. The refusal is right; the row keeping the address was
// not. PUT /profile now clears both columns when the address moves.
// ===========================================================================

test('changing the email un-verifies the row and forgets what it had proved', async () => {
  reset();
  const row = addUser({
    id: 7, email: 'attacker@example.com', name: 'A', password: PASSWORD_HASH,
    email_verified: true, verified_email: 'attacker@example.com', date_of_birth: '2000-01-01',
  });
  const token = signUserToken(row);

  const res = await call('PUT', '/api/users/profile', {
    email: 'victim@gmail.com', current_password: PASSWORD,
  }, token);
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));

  assert.strictEqual(userById(7).email, 'victim@gmail.com');
  assert.strictEqual(userById(7).email_verified, false, 'the row proved the OLD address, not this one');
  assert.strictEqual(userById(7).verified_email, null);
  assert.strictEqual(body.emailVerificationRequired, true, 'the client has to be told, or the next 403 is a mystery');
  assert.strictEqual(body.user.email_verified, false);
});

test('an edit that does not move the address leaves the verification alone', async () => {
  reset();
  const row = addUser({
    id: 8, email: 'me@example.com', name: 'Me', password: PASSWORD_HASH,
    email_verified: true, verified_email: 'me@example.com', date_of_birth: '2000-01-01',
  });
  const token = signUserToken(row);

  const renamed = await call('PUT', '/api/users/profile', { name: 'Me Again', current_password: PASSWORD }, token);
  const renamedBody = await renamed.json();
  assert.strictEqual(renamed.status, 200, JSON.stringify(renamedBody));
  assert.strictEqual(userById(8).email_verified, true, 'a rename must not sign anybody out of their own verification');
  assert.strictEqual(userById(8).verified_email, 'me@example.com');
  assert.strictEqual(renamedBody.emailVerificationRequired, undefined);

  // Resubmitting the same address in a whole-form PUT is not a change either.
  const resubmitted = await call('PUT', '/api/users/profile', {
    name: 'Me Again', email: 'me@example.com', current_password: PASSWORD,
  }, token);
  const resubmittedBody = await resubmitted.json();
  assert.strictEqual(resubmitted.status, 200, JSON.stringify(resubmittedBody));
  assert.strictEqual(userById(8).email_verified, true);
});

test('the address\'s real owner can now take it back instead of being 409ed for ever', async () => {
  reset();
  const row = addUser({
    id: 7, email: 'attacker@example.com', name: 'A', password: PASSWORD_HASH,
    email_verified: true, verified_email: 'attacker@example.com', date_of_birth: '2000-01-01',
    venmo_username: 'attacker-venmo',
  });
  const token = signUserToken(row);
  assert.strictEqual((await call('PUT', '/api/users/profile', {
    email: 'victim@gmail.com', current_password: PASSWORD,
  }, token)).status, 200);

  const res = await withGoogle(
    { sub: 'g-5', email: 'victim@gmail.com', email_verified: true, name: 'Real Owner' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: '2000-01-01' })
  );
  assert.strictEqual(res.status, 200, 'before the fix this was a permanent 409');
  const body = await res.json();
  assert.notStrictEqual(body.user.id, 7, 'and the attacker\'s row is still not handed over');
  assert.strictEqual(body.user.email, 'victim@gmail.com');
  assert.match(userById(7).email, /@unclaimed\.invalid$/, 'the squat loses the address it never proved');
  assert.strictEqual(userById(7).venmo_username, null);
});

test('an un-verified row is back inside the accumulation gate', async () => {
  reset();
  const row = addUser({
    id: 7, email: 'attacker@example.com', name: 'A', password: PASSWORD_HASH,
    email_verified: true, verified_email: 'attacker@example.com', date_of_birth: '2000-01-01',
  });
  const token = signUserToken(row);
  // Verified: payment handles are allowed.
  assert.strictEqual((await call('PUT', '/api/users/venmo-username', { venmo_username: 'ok' }, token)).status, 200);

  assert.strictEqual((await call('PUT', '/api/users/profile', {
    email: 'victim@gmail.com', current_password: PASSWORD,
  }, token)).status, 200);

  // Moved, therefore unproven, therefore gated again — with the same token.
  const blocked = await call('PUT', '/api/users/venmo-username', { venmo_username: 'attacker-venmo' }, token);
  assert.strictEqual(blocked.status, 403);
  assert.strictEqual((await blocked.json()).emailVerificationRequired, true);
});

test('the un-verify assertion is load-bearing on the CASE clause', async () => {
  reset();
  const row = addUser({
    id: 7, email: 'attacker@example.com', password: PASSWORD_HASH,
    email_verified: true, verified_email: 'attacker@example.com', date_of_birth: '2000-01-01',
  });
  await call('PUT', '/api/users/profile', { email: 'victim@gmail.com', current_password: PASSWORD }, signUserToken(row));
  const updateSql = lastSql('UPDATE users SET name = COALESCE($1, name)');
  assert.ok(updateSql, 'the profile update must have run');
  assert.match(updateSql, /email_verified = CASE WHEN \$2::text IS NULL THEN email_verified ELSE FALSE END/);

  const mutated = updateSql
    .replace(/email_verified = CASE WHEN \$2::text IS NULL THEN email_verified ELSE FALSE END,\s*/, '')
    .replace(/verified_email = CASE WHEN \$2::text IS NULL THEN verified_email ELSE NULL END,\s*/, '');

  db.users = [];
  addUser({
    id: 12, email: 'attacker@example.com', password: PASSWORD_HASH,
    email_verified: true, verified_email: 'attacker@example.com',
  });
  await pool.query(mutated, [null, 'victim2@gmail.com', null, null, null, 12]);
  assert.strictEqual(userById(12).email, 'victim2@gmail.com');
  assert.strictEqual(userById(12).email_verified, true,
    'without the clause the badge survives the move — the bug this pins');
});

// ===========================================================================
// RE-AUDIT 1b — the email uniqueness check on PUT /profile compared in the
// wrong alphabet, which is the shadow-account hole canonicalEmail() exists for.
// ===========================================================================
// The submitted address has been through normalizeEmail() (Gmail dots and
// +subaddresses gone); an OAuth row stores the provider's address verbatim,
// dots and all. A plain LOWER() match cannot see across that gap, and neither
// can the users.email UNIQUE index, so two rows ended up owning one mailbox.
// ===========================================================================

test('a Gmail variant of an address another account already owns is refused', async () => {
  reset();
  // What Google stored, verbatim.
  addUser({
    id: 20, email: 'john.doe@gmail.com', name: 'Real Owner', oauth_provider: 'google',
    oauth_id: 'g-20', email_verified: true, verified_email: 'john.doe@gmail.com',
  });
  const attacker = addUser({
    id: 21, email: 'attacker@example.com', name: 'A', password: PASSWORD_HASH,
    email_verified: true, verified_email: 'attacker@example.com',
  });
  const token = signUserToken(attacker);

  // normalizeEmail() leaves this alone — it is already dotless — so before the
  // fix LOWER() found nothing and a second row took the victim's mailbox.
  const res = await call('PUT', '/api/users/profile', {
    email: 'johndoe@gmail.com', current_password: PASSWORD,
  }, token);
  const body = await res.json();
  assert.strictEqual(res.status, 400, JSON.stringify(body));
  assert.match(body.error, /already in use/i);
  assert.strictEqual(userById(21).email, 'attacker@example.com', 'nothing moved');

  // The control: an address nobody holds still goes through.
  const ok = await call('PUT', '/api/users/profile', {
    email: 'free@example.com', current_password: PASSWORD,
  }, token);
  assert.strictEqual(ok.status, 200, await ok.text());
  assert.strictEqual(userById(21).email, 'free@example.com');
});

test('the shadow-account refusal is load-bearing on the canonical branch', async () => {
  reset();
  addUser({ id: 20, email: 'john.doe@gmail.com', oauth_provider: 'google', oauth_id: 'g-21', email_verified: true });
  const attacker = addUser({
    id: 21, email: 'attacker@example.com', password: PASSWORD_HASH, email_verified: true,
  });
  await call('PUT', '/api/users/profile', {
    email: 'johndoe@gmail.com', current_password: PASSWORD,
  }, signUserToken(attacker));

  const checkSql = lastSql('SELECT id FROM users WHERE LOWER(email)');
  assert.ok(checkSql, 'the uniqueness check must have run');
  assert.match(checkSql, /split_part/, 'and must compare in the canonical alphabet');

  // Without the canonical branch the collision is invisible, which is the bug.
  const mutated = 'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND id != $2';
  const missed = await pool.query(mutated, ['johndoe@gmail.com', 21, canonicalEmail('johndoe@gmail.com')]);
  assert.strictEqual(missed.rows.length, 0);
  const caught = await pool.query(checkSql, ['johndoe@gmail.com', 21, canonicalEmail('johndoe@gmail.com')]);
  assert.strictEqual(caught.rows.length, 1);
  assert.strictEqual(caught.rows[0].id, 20);
});

test('routes/users.js and routes/auth.js compare in the SAME canonical alphabet', () => {
  // Two copies of this expression would drift, and the drift is the hole.
  // routes/users.js builds its clause from this exact export.
  const { EMAIL_CANONICAL_SQL } = authRouter;
  assert.ok(typeof EMAIL_CANONICAL_SQL === 'string' && EMAIL_CANONICAL_SQL.length > 0);
  assert.ok(authRouter.__testing.EMAIL_MATCH_SQL.includes(EMAIL_CANONICAL_SQL),
    'the lookup used by signup, forgot-password and both OAuth claims must use it too');
  assert.strictEqual(typeof authRouter.canonicalEmail, 'function');
});

// ===========================================================================
// A password change must not leave a live socket behind
// ===========================================================================
// The token_version bump stops the thief's REST calls on the next request, but
// a Socket.io connection authenticates once at the handshake and then lives in
// user:{id}, where every DM, flock message and location update is delivered.
// middleware/auth.js used to record this as an open gap in routes/users.js.
// ===========================================================================

test('a password change bumps the version, drops the sockets and hands back a usable token', async () => {
  reset();
  const row = addUser({
    id: 30, email: 'pw@example.com', name: 'P', password: PASSWORD_HASH,
    email_verified: true, verified_email: 'pw@example.com', token_version: 1,
  });
  const staleToken = signUserToken(row);
  assert.strictEqual((await call('GET', '/api/auth/me', null, staleToken)).status, 200);

  const res = await call('PUT', '/api/users/profile', {
    current_password: PASSWORD, new_password: 'BrandNew1',
  }, staleToken);
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));

  assert.strictEqual(userById(30).token_version, 2);
  assert.deepStrictEqual(disconnectedRooms, ['user:30|true'], 'the live socket must go');
  assert.strictEqual((await call('GET', '/api/auth/me', null, staleToken)).status, 401,
    'the caller\'s own old token dies with the rest');
  assert.ok(body.token, 'so a replacement has to come back');
  assert.strictEqual((await call('GET', '/api/auth/me', null, body.token)).status, 200);
  assert.strictEqual(userById(30).email_verified, true, 'a password change is not an address change');
});

test('an edit with no password change rotates nothing', async () => {
  reset();
  const row = addUser({
    id: 31, email: 'pw2@example.com', name: 'P', password: PASSWORD_HASH,
    email_verified: true, verified_email: 'pw2@example.com', token_version: 1,
  });
  const token = signUserToken(row);
  const res = await call('PUT', '/api/users/profile', { name: 'Pat', current_password: PASSWORD }, token);
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  assert.strictEqual(userById(31).token_version, 1, 'a rename must not sign you out of your other devices');
  assert.deepStrictEqual(disconnectedRooms, []);
  assert.strictEqual(body.token, undefined);
});

// ===========================================================================
// RE-AUDIT 2 (HIGH) — the OAuth CREATE paths never read the provider's
// email_verified claim, and wrote `email_verified TRUE, verified_email = email`
// regardless.
// ===========================================================================
// The flag was checked only when an existing row was found. On creation the row
// was stamped verified for an address the provider never vouched for: it walks
// past the round-16 accumulation gate, and because it carries an oauth_provider
// the address's real owner can neither claim nor evict it (the existing-row
// branch 409s on oauth_provider before claimDecision runs). A permanent squat
// with a verified badge.
// ===========================================================================

test('Google will not create an account for an address it did not vouch for', async () => {
  reset();
  // email_verified absent. The round-13 comment on both token branches says
  // absent is not verified; the create path was not reading the answer.
  const res = await withGoogle(
    { sub: 'g-6', email: 'unvouched@gmail.com', name: 'Unvouched' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: '2000-01-01' })
  );
  assert.strictEqual(res.status, 401);
  assert.deepStrictEqual(db.users, [], 'no row may be created, verified or otherwise');

  // Explicitly false is refused earlier, and must stay refused.
  const explicit = await withGoogle(
    { sub: 'g-7', email: 'unvouched@gmail.com', email_verified: false, name: 'Unvouched' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: '2000-01-01' })
  );
  assert.strictEqual(explicit.status, 401);
  assert.deepStrictEqual(db.users, []);

  // The positive control: a vouched address still creates, still verified.
  const ok = await withGoogle(
    { sub: 'g-8', email: 'vouched@gmail.com', email_verified: true, name: 'Vouched' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: '2000-01-01' })
  );
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(db.users.length, 1);
  assert.strictEqual(db.users[0].email_verified, true);
  assert.strictEqual(db.users[0].verified_email, 'vouched@gmail.com');
});

test('an unvouched Google sign-in does not evict a squat on its way to being refused', async () => {
  reset();
  addUser({ id: 50, email: 'victim@gmail.com', password: PASSWORD_HASH, email_verified: false });
  const res = await withGoogle(
    { sub: 'g-9', email: 'victim@gmail.com', name: 'Nope' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: '2000-01-01' })
  );
  // The existing-row branch refuses an unvouched token before the create path
  // is reached at all (409, "log in the way you originally signed up"). Either
  // refusal is fine; what must never happen is the squat being released for
  // a caller the server is about to turn away.
  assert.strictEqual(res.status, 409);
  assert.strictEqual(userById(50).email, 'victim@gmail.com', 'a refused request displaces nobody');
  assert.strictEqual(db.users.length, 1);
});

test('Apple will not create an account for an address it did not vouch for', async () => {
  reset();
  const res = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-6', email: 'unvouched@icloud.com' }),
    date_of_birth: '2000-01-01',
  });
  assert.strictEqual(res.status, 401);
  assert.deepStrictEqual(db.users, []);

  // Apple omits the email on every sign-in after the first. That path stores a
  // .invalid placeholder which cannot be mailed or squatted, so it is still
  // created, and still recorded as verified for ITSELF and nothing else.
  const placeholder = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'a-7' }),
    date_of_birth: '2000-01-01',
  });
  assert.strictEqual(placeholder.status, 200);
  assert.strictEqual(db.users.length, 1);
  assert.ok(db.users[0].email.endsWith('@apple-signin.invalid'));
  assert.strictEqual(db.users[0].verified_email, db.users[0].email);
});

// ===========================================================================
// RE-AUDIT 3 (MEDIUM) — the round-15 date-of-birth shape check never reached
// the OAuth creation paths.
// ===========================================================================
// ageFromDob is `new Date(x)`, so a number of milliseconds and a one-element
// array both parse. The same raw value then went to pg as a parameter for a
// DATE column: a 500 on the sign-in path, from a body shape the caller picks.
// ===========================================================================

test('suppliedDob accepts only a date-shaped string', () => {
  assert.strictEqual(suppliedDob('2000-01-01'), '2000-01-01');
  assert.strictEqual(suppliedDob('  2000-01-01  '), '2000-01-01');
  assert.strictEqual(suppliedDob('2000-01-01T00:00:00.000Z'), '2000-01-01T00:00:00.000Z');
  for (const junk of [946684800000, ['2000-01-01'], { y: 2000 }, null, undefined, true, '01/01/2000', 'yesterday']) {
    assert.strictEqual(suppliedDob(junk), null, `${JSON.stringify(junk)} must not reach a DATE column`);
  }
});

test('a mis-shaped date of birth never reaches a DATE column', async () => {
  // Non-string shapes are turned away by the type guard (400); a string that is
  // not date-shaped is turned away by suppliedDob (403 needsDob). Both used to
  // sail through ageFromDob — `new Date(946684800000)` and
  // `new Date(['2000-01-01'])` both parse — and land in pg as a 500.
  for (const dob of [946684800000, ['2000-01-01'], { year: 2000 }, '01/01/2000', 'yesterday']) {
    reset();
    const google = await withGoogle(
      { sub: 'g-10', email: 'shape@gmail.com', email_verified: true, name: 'Shape' },
      () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: dob })
    );
    assert.ok([400, 403].includes(google.status), `google accepted ${JSON.stringify(dob)} (${google.status})`);
    await google.text();
    assert.deepStrictEqual(db.users, [], 'and nothing was written');

    reset();
    const apple = await post('/api/auth/apple', {
      identityToken: appleIdentityToken({ sub: 'a-8', email: 'shape@icloud.com', email_verified: true }),
      date_of_birth: dob,
    });
    assert.ok([400, 403].includes(apple.status), `apple accepted ${JSON.stringify(dob)} (${apple.status})`);
    await apple.text();
    assert.deepStrictEqual(db.users, []);
  }

  // And the same on password signup, where isISO8601 passes per element.
  reset();
  const signup = await post('/api/auth/signup', {
    email: 'shape@example.com', password: 'Password1', name: 'Shape', date_of_birth: ['2000-01-01'],
  });
  assert.strictEqual(signup.status, 400);
  assert.deepStrictEqual(db.users, []);
});

test('a date-shaped string is stored verbatim, trimmed', async () => {
  reset();
  const res = await withGoogle(
    { sub: 'g-11', email: 'dob@gmail.com', email_verified: true, name: 'Dob' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: ' 2001-02-03 ' })
  );
  assert.strictEqual(res.status, 200);
  assert.strictEqual(db.users[0].date_of_birth, '2001-02-03');
});

test('an under-13 date of birth is still refused after the shape check', async () => {
  reset();
  const tooYoung = new Date();
  tooYoung.setFullYear(tooYoung.getFullYear() - 10);
  const res = await withGoogle(
    { sub: 'g-12', email: 'kid@gmail.com', email_verified: true, name: 'Kid' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: tooYoung.toISOString().slice(0, 10) })
  );
  assert.strictEqual(res.status, 403);
  // The refusal is the NEUTRAL sentence (minors-compliance audit 2026-08-14):
  // it must not name the threshold, or the age screen teaches the child what
  // to type. minorsCompliance.test.js owns the full neutrality assertions.
  assert.strictEqual((await res.json()).error, authRouter.__testing.UNDERAGE_MSG);
  assert.deepStrictEqual(db.users, []);
});

// ===========================================================================
// RE-AUDIT 4 (MEDIUM) — the array-shaped-body trap, still open on /signup,
// /login, /google and /apple.
// ===========================================================================
// express-validator runs every chain PER ELEMENT of an array and writes the
// array back, so `{"email": ["a@b.com"]}` passes isEmail and is still an array
// in the handler. routes/users.js PUT /profile, /forgot-password and
// /reset-password all carry a type guard for exactly this; the four routes that
// hand those values to bcrypt and to pg did not. Every one of these was a 500
// (or worse) from a body shape the caller picks.
// ===========================================================================

test('array-shaped bodies are refused on every credential route', async () => {
  reset();
  addUser({
    id: 70, email: 'real@example.com', name: 'R', password: PASSWORD_HASH,
    email_verified: true, verified_email: 'real@example.com', date_of_birth: '2000-01-01',
  });

  const cases = [
    ['/api/auth/signup', { email: ['new@example.com'], password: 'Password1', name: 'N', date_of_birth: '2000-01-01' }],
    ['/api/auth/signup', { email: 'new@example.com', password: ['Password1'], name: 'N', date_of_birth: '2000-01-01' }],
    ['/api/auth/signup', { email: 'new@example.com', password: 'Password1', name: ['N'], date_of_birth: '2000-01-01' }],
    ['/api/auth/signup', { email: 'new@example.com', password: 'Password1', name: 'N', date_of_birth: ['2000-01-01'] }],
    ['/api/auth/login', { email: ['real@example.com'], password: 'Password1' }],
    ['/api/auth/login', { email: 'real@example.com', password: ['Password1'] }],
    ['/api/auth/apple', { identityToken: ['x'], date_of_birth: '2000-01-01' }],
    ['/api/auth/apple', { identityToken: 'x', nonce: ['n'], date_of_birth: '2000-01-01' }],
  ];
  for (const [path, body] of cases) {
    const res = await post(path, body);
    assert.strictEqual(res.status, 400, `${path} ${JSON.stringify(body)} was not refused`);
    await res.text();
  }

  const google = await withGoogle(
    { sub: 'g-70', email: 'g@gmail.com', email_verified: true, name: 'G' },
    () => post('/api/auth/google', { access_token: ['opaque'], date_of_birth: '2000-01-01' })
  );
  assert.strictEqual(google.status, 400);

  assert.strictEqual(db.users.length, 1, 'no malformed request may create a row');
});

test('the ordinary shapes still work after the type guard', async () => {
  reset();
  const signup = await post('/api/auth/signup', {
    email: 'fresh@example.com', password: 'Password1', name: 'Fresh', date_of_birth: '2000-01-01',
  });
  assert.strictEqual(signup.status, 201, await signup.text());
  assert.strictEqual(db.users[0].email_verified, false);

  const login = await post('/api/auth/login', { email: 'fresh@example.com', password: 'Password1' });
  assert.strictEqual(login.status, 200, await login.text());
});

// ===========================================================================
// RE-AUDIT 5 (LOW) — the reset's write-time guard did not re-check the ban.
// ===========================================================================

test('a ban landing between reading and spending a reset link stops the reset', async () => {
  reset();
  const user = addUser({
    id: 60, email: 'user@example.com', name: 'U', password: PASSWORD_HASH,
    email_verified: true, verified_email: 'user@example.com', token_version: 2,
  });
  const verifier = 'secret-verifier-value';
  db.resets.push({
    id: db.nextResetId++, user_id: 60, selector: 'c'.repeat(32),
    verifier_hash: crypto.createHash('sha256').update(verifier).digest('hex'),
    email: user.email, request_ip: null, used_at: null,
    expires_at: new Date(Date.now() + 3600e3).toISOString(), created_at: new Date().toISOString(),
  });

  // The ban commits after inspectReset has read the row and while the link is
  // being spent — the window the read-time check structurally cannot cover.
  const inner = pool.query;
  pool.query = async (text, params) => {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    const out = await inner(text, params);
    if (sql.startsWith('UPDATE password_resets SET used_at') && sql.includes('WHERE id = $1')) {
      userById(60).is_banned = true;
    }
    return out;
  };
  try {
    const res = await post('/api/auth/reset-password', {
      token: `${'c'.repeat(32)}.${verifier}`, password: 'BrandNew1',
    });
    assert.strictEqual(res.status, 400);
    assert.ok(bcrypt.compareSync(PASSWORD, userById(60).password), 'the password must not have changed');
    assert.strictEqual(userById(60).token_version, 2, 'and no session was rotated for a banned row');
  } finally {
    pool.query = inner;
  }
});

test('the ordinary reset still works, and still does not verify the address', async () => {
  reset();
  const user = addUser({
    id: 61, email: 'unverified@example.com', name: 'U', password: PASSWORD_HASH,
    email_verified: false, verified_email: null, token_version: 4,
  });
  const verifier = 'another-verifier-value';
  db.resets.push({
    id: db.nextResetId++, user_id: 61, selector: 'd'.repeat(32),
    verifier_hash: crypto.createHash('sha256').update(verifier).digest('hex'),
    email: user.email, request_ip: null, used_at: null,
    expires_at: new Date(Date.now() + 3600e3).toISOString(), created_at: new Date().toISOString(),
  });

  const res = await post('/api/auth/reset-password', {
    token: `${'d'.repeat(32)}.${verifier}`, password: 'BrandNew1',
  });
  assert.strictEqual(res.status, 200, await res.text());
  assert.ok(bcrypt.compareSync('BrandNew1', userById(61).password));
  assert.strictEqual(userById(61).token_version, 5, 'every outstanding JWT dies');
  assert.deepStrictEqual(disconnectedRooms, ['user:61|true']);
  // A reset proves mailbox control, but treating it as verification would let
  // the recovery flow hand an unverified squat row to the address's real owner.
  assert.strictEqual(userById(61).email_verified, false);
  assert.strictEqual(userById(61).verified_email, null);

  const guardSql = lastSql('UPDATE users SET password = $1');
  assert.match(guardSql, /is_banned IS NOT TRUE/,
    'the write guard must re-check the ban the read checked');
  assert.ok(!/email_verified/.test(guardSql), 'and must never touch the verification columns');
});
