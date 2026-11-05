'use strict';
// Run: node --test  (from backend/)
//
// THE RULES OF AN ADMIN ACCESS KEY, WITHOUT A DATABASE.
//
// middleware/adminKeys.js decides three things before any row is read: what a
// key looks like, which routes it may reach, and which router answers it. They
// are pure, so they are pinned here one case at a time; everything that needs
// a key row (expiry, revocation, the use log, the real routers in server.js
// order) is in adminAccessKeys.test.js against an embedded Postgres.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-for-admin-key-rules';

const pool = require('../config/database');
const auth = require('../middleware/auth');
const keys = require('../middleware/adminKeys');

// No query may run in this file. A test that reaches the database has found a
// path that skipped the rules below.
const realQuery = pool.query;
let queries = [];
pool.query = async (sql, params) => {
  queries.push({ sql: String(sql), params });
  return { rows: [], rowCount: 0 };
};
test.after(() => {
  pool.query = realQuery;
  pool.end().catch(() => {});
});

// Built at run time, so no key-shaped literal sits in this file for a scanner
// to trip on.
const KEY = keys.generateAdminKey();
const own = { id: 7, scopes: ['admin'] };

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

test('a key is the prefix and 32 random bytes in base64url, and no two are alike', () => {
  assert.match(KEY, /^flk_admin_[A-Za-z0-9_-]{43}$/);
  assert.ok(keys.isAdminKeyShape(KEY));
  const raw = Buffer.from(KEY.slice('flk_admin_'.length), 'base64url');
  assert.strictEqual(raw.length, 32);
  const many = new Set(Array.from({ length: 200 }, () => keys.generateAdminKey()));
  assert.strictEqual(many.size, 200);
});

test('what is stored is the SHA-256 of the key, in hex, and nothing of the key itself', () => {
  const hash = keys.hashAdminKey(KEY);
  assert.strictEqual(hash, crypto.createHash('sha256').update(KEY).digest('hex'));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(!hash.includes(KEY.slice(10, 20)));
  // A known vector, so the hash cannot drift to another digest unnoticed.
  assert.strictEqual(keys.hashAdminKey('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('only the exact shape is a key: short, long, padded or foreign characters are not', () => {
  const body = KEY.slice('flk_admin_'.length);
  for (const bad of [
    'flk_admin_', `flk_admin_${body.slice(1)}`, `${KEY}A`, `${KEY}=`, `flk_admin_${body.slice(0, 42)}+`,
    `FLK_ADMIN_${body}`, ` ${KEY}`, `flk_admin-${body}`, null, undefined, 42,
  ]) {
    assert.strictEqual(keys.isAdminKeyShape(bad), false, String(bad));
  }
});

test('a bearer is a key attempt exactly when it starts with the prefix, read the way auth.js reads a bearer', () => {
  const req = (h) => ({ headers: h === undefined ? {} : { authorization: h } });
  assert.strictEqual(keys.adminKeyBearer(req(`Bearer ${KEY}`)), KEY);
  // Malformed keys are still key attempts: they are answered by the key path,
  // never handed to jwt.verify.
  assert.strictEqual(keys.adminKeyBearer(req('Bearer flk_admin_short')), 'flk_admin_short');
  // `header.split(' ')[1]`, the middleware's own split.
  assert.strictEqual(keys.adminKeyBearer(req(`Bearer ${KEY} trailing`)), KEY);
  for (const h of [undefined, '', KEY, `bearer ${KEY}`, `Basic ${KEY}`, 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x', `Bearer  ${KEY}`]) {
    assert.strictEqual(keys.adminKeyBearer(req(h)), null, String(h));
  }
});

// ---------------------------------------------------------------------------
// The route list
// ---------------------------------------------------------------------------

test('every route on the list is reachable with the admin scope, and only by its own method', () => {
  for (const r of keys.ADMIN_KEY_ROUTES) {
    const concrete = r.path.replace(/:[A-Za-z]+/g, String(own.id));
    assert.strictEqual(keys.keyRouteDecision(r.method, concrete, own).allowed, true, `${r.method} ${concrete}`);
    for (const other of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      if (keys.ADMIN_KEY_ROUTES.some((x) => x.method === other && x.path === r.path)) continue;
      assert.strictEqual(keys.keyRouteDecision(other, concrete, own).allowed, false, `${other} ${concrete}`);
    }
  }
});

test('every route a key must never reach is refused, whatever id it names', () => {
  for (const r of keys.ADMIN_KEY_REFUSED_ROUTES) {
    for (const id of ['1', '7', '999']) {
      const concrete = r.path.replace(/:[A-Za-z]+/g, id);
      assert.strictEqual(keys.keyRouteDecision(r.method, concrete, own).allowed, false, `${r.method} ${concrete}`);
    }
    assert.ok(typeof r.why === 'string' && r.why.length > 20, `${r.method} ${r.path} has no written reason`);
  }
});

test('the two lists never name the same route', () => {
  const allowed = new Set(keys.ADMIN_KEY_ROUTES.map((r) => `${r.method} ${r.path}`));
  for (const r of keys.ADMIN_KEY_REFUSED_ROUTES) assert.ok(!allowed.has(`${r.method} ${r.path}`), `${r.method} ${r.path} is on both lists`);
});

test('nothing outside /api/admin is on the list, and an unknown admin route is refused', () => {
  for (const r of keys.ADMIN_KEY_ROUTES) assert.ok(r.path.startsWith('/api/admin/'), r.path);
  for (const [method, p] of [
    ['GET', '/api/users/me'], ['PUT', '/api/users/password'], ['PUT', '/api/users/profile'],
    ['POST', '/api/auth/logout-all'], ['DELETE', '/api/users/me'], ['GET', '/api/flocks'],
    ['POST', '/api/flocks'], ['GET', '/api/dm/conversations'], ['GET', '/api/admin'],
    ['GET', '/api/admin/users'], ['POST', '/api/admin/users/1/role'], ['DELETE', '/api/admin/users/1'],
    ['GET', '/api/admin/money/extra'], ['GET', '/api/adminx/money'], ['GET', '/api/admin/keys/1'],
  ]) {
    assert.strictEqual(keys.keyRouteDecision(method, p, own).allowed, false, `${method} ${p}`);
  }
});

test('a key revokes itself and no other key', () => {
  assert.strictEqual(keys.keyRouteDecision('DELETE', '/api/admin/keys/7', own).allowed, true);
  const other = keys.keyRouteDecision('DELETE', '/api/admin/keys/8', own);
  assert.strictEqual(other.allowed, false);
  assert.strictEqual(other.notSelf, true);
  // The same number written with leading zeros is the same key, as serialId
  // reads it in the route.
  assert.strictEqual(keys.keyRouteDecision('DELETE', '/api/admin/keys/007', own).allowed, true);
  assert.strictEqual(keys.keyRouteDecision('DELETE', '/api/admin/keys/abc', own).allowed, false);
});

test('a key without the route\'s scope reaches nothing', () => {
  for (const scopes of [[], ['other'], undefined]) {
    assert.strictEqual(keys.keyRouteDecision('GET', '/api/admin/money', { id: 7, scopes }).allowed, false, String(scopes));
  }
});

test('a path that is not plain is refused rather than read', () => {
  for (const p of [
    '/api/admin//money', '/api/admin/money/../keys', '/api/admin/./money', '/api/admin/money%2f',
    '/api/admin/%6doney', '/api/admin/money\\', '/api/admin/money?x=1', '/api/admin/money#x', '', '/',
  ]) {
    assert.strictEqual(keys.keyRouteDecision('GET', p, own).allowed, false, p);
  }
});

test('the path is judged lower case with one trailing slash dropped, as Express routes it', () => {
  const at = (baseUrl, p) => keys.keyRequestPath({ baseUrl, path: p });
  assert.strictEqual(at('/api/admin', '/money'), '/api/admin/money');
  assert.strictEqual(at('/API/Admin', '/MONEY/'), '/api/admin/money');
  assert.strictEqual(keys.keyRouteDecision('GET', at('/API/Admin', '/MONEY/'), own).allowed, true);
});

// ---------------------------------------------------------------------------
// Minting input
// ---------------------------------------------------------------------------

test('a mint names the key and may say how many days it lives: 90 by default, 1 to 180', () => {
  assert.deepStrictEqual(keys.readMintBody({ name: 'PC tools' }), { name: 'PC tools', days: 90 });
  assert.deepStrictEqual(keys.readMintBody({ name: '  PC   tools ', days: 180 }), { name: 'PC tools', days: 180 });
  assert.deepStrictEqual(keys.readMintBody({ name: 'x', days: 1 }), { name: 'x', days: 1 });
  assert.deepStrictEqual(keys.readMintBody({ name: 'x', days: null }), { name: 'x', days: 90 });
  for (const days of [0, 181, -1, 1.5, '30', '90', true, [30], Number.NaN]) {
    assert.ok(keys.readMintBody({ name: 'x', days }).error, `days=${String(days)} was accepted`);
  }
  for (const name of [undefined, '', '   ', 7, ['x'], 'x'.repeat(61), '<b></b>']) {
    assert.ok(keys.readMintBody({ name }).error, `name=${String(name)} was accepted`);
  }
  for (const body of [undefined, null, [], 'name']) assert.ok(keys.readMintBody(body).error);
  // Markup is taken out the way every typed name in the app is stored.
  assert.strictEqual(keys.readMintBody({ name: '<b>PC</b> tools' }).name, 'PC tools');
});

test('how long ago the session signed in is read from auth_time, and an unknown one is not fresh', () => {
  const now = 1_800_000_000_000;
  const at = Math.floor(now / 1000);
  assert.strictEqual(keys.sessionAgeSeconds({ tokenIssuedAt: at - 60 }, now), 60);
  assert.strictEqual(keys.sessionAgeSeconds({ tokenIssuedAt: null }, now), null);
  assert.strictEqual(keys.sessionAgeSeconds({}, now), null);
  assert.strictEqual(keys.sessionAgeSeconds({ tokenIssuedAt: 'soon' }, now), null);
  assert.ok(keys.ADMIN_KEY_MINT_FRESH_SECONDS <= 30 * 60, 'the window to mint after a sign-in grew past half an hour');
});

test('a key row reads as active, pending, expired, revoked or ended, and its metadata never carries a hash', () => {
  const base = {
    id: 3, name: 'PC', scopes: ['admin'], key_hash: 'f'.repeat(64), approval_hash: 'e'.repeat(64),
    created_at: new Date('2026-11-01T00:00:00Z'), expires_at: new Date('2027-01-30T00:00:00Z'),
    approved_at: new Date('2026-11-01T00:05:00Z'), approved_via: 'email',
    session_version: 2, token_version: 2, role: 'admin', is_banned: false,
  };
  const now = Date.parse('2026-11-05T00:00:00Z');
  assert.strictEqual(keys.keyState(base, now), 'active');
  assert.strictEqual(keys.keyState({ ...base, revoked_at: new Date() }, now), 'revoked');
  assert.strictEqual(keys.keyState({ ...base, expires_at: new Date('2026-11-04T00:00:00Z') }, now), 'expired');
  assert.strictEqual(keys.keyState({ ...base, token_version: 3 }, now), 'ended');
  assert.strictEqual(keys.keyState({ ...base, role: 'user' }, now), 'ended');
  assert.strictEqual(keys.keyState({ ...base, is_banned: true }, now), 'ended');
  // Never approved: pending while its link lives, and dead once it does not.
  const waiting = { ...base, approved_at: null, approved_via: null, approval_expires_at: new Date(now + 10 * 60000) };
  assert.strictEqual(keys.keyState(waiting, now), 'pending');
  assert.strictEqual(keys.keyState({ ...waiting, approval_expires_at: new Date(now - 1000) }, now), 'expired');
  assert.strictEqual(keys.keyState({ ...waiting, revoked_at: new Date() }, now), 'revoked');
  assert.strictEqual(keys.keyMetadata(waiting, now).approvalExpiresAt, new Date(now + 10 * 60000).toISOString());
  assert.strictEqual(keys.keyMetadata(base, now).approvalExpiresAt, null, 'an approved key has no approval deadline to show');
  const meta = keys.keyMetadata(base, now);
  assert.ok(!('key_hash' in meta) && !('approval_hash' in meta));
  assert.ok(!JSON.stringify(meta).includes('f'.repeat(64)) && !JSON.stringify(meta).includes('e'.repeat(64)));
  assert.deepStrictEqual(Object.keys(meta).sort(), [
    'approvalExpiresAt', 'approvedAt', 'approvedVia', 'createdAt', 'createdIp', 'expiresAt', 'id', 'lastUsedAt',
    'lastUsedIp', 'name', 'revokedAt', 'revokedVia', 'scopes', 'state',
  ]);
});

test('a key that has not been approved is refused as pending while its link lives, and as never approved after', () => {
  const { deadReason } = keys.__testing;
  const row = { revoked_at: null, expired: false, session_version: 0, token_version: 0, role: 'admin', is_banned: false, approved_at: null };
  assert.strictEqual(deadReason({ ...row, approval_open: true }), 'pending');
  assert.strictEqual(deadReason({ ...row, approval_open: false }), 'unapproved');
  assert.strictEqual(deadReason({ ...row, approval_open: null }), 'unapproved');
  assert.strictEqual(deadReason({ ...row, approved_at: new Date() }), null);
  // What ends a key ends a pending one first: approval cannot revive it.
  assert.strictEqual(deadReason({ ...row, approval_open: true, token_version: 1 }), 'ended');
  assert.strictEqual(deadReason({ ...row, approval_open: true, revoked_at: new Date() }), 'revoked');
  assert.match(keys.KEY_WORDS.pending, /awaiting approval/);
});

test('an approval token is 32 random bytes in base64url, and nothing else is one', () => {
  for (let i = 0; i < 20; i += 1) {
    assert.ok(keys.isApprovalTokenShape(crypto.randomBytes(32).toString('base64url')));
  }
  for (const bad of ['', 'abc', KEY, 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}=`, null, 7]) {
    assert.strictEqual(keys.isApprovalTokenShape(bad), false, String(bad));
  }
});

test('a session is fresh for minting within the window after its sign-in, and an unknown sign-in is not', () => {
  const now = 1_800_000_000_000;
  const at = Math.floor(now / 1000);
  assert.strictEqual(keys.isFreshSession({ tokenIssuedAt: at - 60 }, now), true);
  assert.strictEqual(keys.isFreshSession({ tokenIssuedAt: at - keys.ADMIN_KEY_MINT_FRESH_SECONDS }, now), true);
  assert.strictEqual(keys.isFreshSession({ tokenIssuedAt: at - keys.ADMIN_KEY_MINT_FRESH_SECONDS - 1 }, now), false);
  assert.strictEqual(keys.isFreshSession({ tokenIssuedAt: at + 5 }, now), true, 'a sign-in a moment ahead is clock skew');
  assert.strictEqual(keys.isFreshSession({ tokenIssuedAt: null }, now), false);
});

// ---------------------------------------------------------------------------
// Which router answers, through the real middleware/auth.js
// ---------------------------------------------------------------------------

// The shape server.js mounts: a catch-all at /api that authenticates everything
// reaching it, the admin router after it, and a user router.
function buildApp(log) {
  const app = express();
  const catchAll = express.Router();
  catchAll.use(auth.authenticate);
  catchAll.get('/reports', (req, res) => res.json({ ran: 'catch-all reports' }));
  // A route under /admin on the catch-all. A key must never run it: the
  // catch-all is skipped whole for a request bound for /api/admin.
  catchAll.get('/admin/money', (req, res) => { log.push('catch-all ran'); res.json({ ran: 'catch-all admin' }); });
  const admin = express.Router();
  admin.use(auth.authenticate);
  admin.get('/money', (req, res) => res.json({ ran: 'admin money' }));
  const users = express.Router();
  users.use(auth.authenticate);
  users.get('/me', (req, res) => res.json({ ran: 'users me' }));
  const del = express.Router();
  del.delete('/me', auth.authenticateAllowBanned, (req, res) => res.json({ ran: 'deleted' }));
  const logout = express.Router();
  logout.post('/logout', auth.authenticateAllowExpired, (req, res) => res.json({ ran: 'logged out' }));
  app.use('/api/users', del);
  app.use('/api/users', users);
  app.use('/api/auth', logout);
  app.use('/api', catchAll);
  app.use('/api/admin', admin);
  return app;
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('a key bound for /api/admin skips the catch-all whole; every other router refuses it, in all three variants', async () => {
  const log = [];
  await withServer(buildApp(log), async (base) => {
    const go = (method, p) => fetch(base + p, { method, headers: { Authorization: `Bearer ${KEY}` } });
    queries = [];
    // Reaches the admin router, which looks the key up. No key row exists in
    // this file, so it is an unknown key: 401, and the catch-all never ran.
    const adminRes = await go('GET', '/api/admin/money');
    assert.strictEqual(adminRes.status, 401);
    assert.deepStrictEqual(await adminRes.json(), { error: keys.KEY_WORDS.invalid });
    assert.deepStrictEqual(log, [], 'the catch-all ran a route on a key');
    assert.strictEqual(queries.length, 1, 'one lookup, by the admin router');
    assert.match(queries[0].sql, /FROM admin_access_keys k/);
    assert.deepStrictEqual(queries[0].params, [keys.hashAdminKey(KEY)], 'the lookup carries the hash, never the key');

    // Everywhere else: the lookup, then a refusal. Unknown here, so 401.
    for (const [method, p] of [['GET', '/api/users/me'], ['DELETE', '/api/users/me'], ['POST', '/api/auth/logout'], ['GET', '/api/reports']]) {
      queries = [];
      const res = await go(method, p);
      assert.strictEqual(res.status, 401, `${method} ${p}`);
      assert.ok(queries.every((q) => !/FROM users WHERE id/.test(q.sql)), `${method} ${p} read a user row for a key`);
    }
  });
});

test('a malformed key is refused without a lookup, and never read as a JWT', async () => {
  await withServer(buildApp([]), async (base) => {
    queries = [];
    const res = await fetch(`${base}/api/users/me`, { headers: { Authorization: 'Bearer flk_admin_eyJhbGciOiJIUzI1NiJ9' } });
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(await res.json(), { error: keys.KEY_WORDS.invalid });
    assert.deepStrictEqual(queries, []);
  });
});

test('a session still authenticates as before, and says so on req.authVia', async () => {
  const app = express();
  const r = express.Router();
  r.use(auth.authenticate);
  r.get('/who', (req, res) => res.json({ id: req.user.id, via: req.authVia }));
  app.use('/api/admin', r);
  const user = { id: 5, email: 'a@example.com', name: 'Ava', role: 'admin', email_verified: true, is_banned: false, token_version: 0 };
  pool.query = async () => ({ rows: [user], rowCount: 1 });
  try {
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/admin/who`, { headers: { Authorization: `Bearer ${auth.signUserToken(user)}` } });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(await res.json(), { id: 5, via: 'session' });
    });
  } finally {
    pool.query = async (sql, params) => { queries.push({ sql: String(sql), params }); return { rows: [], rowCount: 0 }; };
  }
});

test('a key cannot open a socket: the handshake verifies a JWT, and a key is not one', async () => {
  const err = await new Promise((resolve) => {
    auth.authenticateSocket({ handshake: { auth: { token: KEY } } }, resolve);
  });
  assert.ok(err instanceof Error);
  assert.strictEqual(err.message, 'Authentication failed');
});

test('the mount tests read Express\'s own resolution of the path', () => {
  const { onAdminMount, boundForAdminMount } = keys.__testing;
  assert.strictEqual(onAdminMount({ baseUrl: '/api/admin' }), true);
  assert.strictEqual(onAdminMount({ baseUrl: '/API/ADMIN' }), true);
  assert.strictEqual(onAdminMount({ baseUrl: '/api' }), false);
  assert.strictEqual(onAdminMount({ baseUrl: '/api/admin/sub' }), false);
  assert.strictEqual(boundForAdminMount({ baseUrl: '/api', path: '/admin/money' }), true);
  assert.strictEqual(boundForAdminMount({ baseUrl: '/api', path: '/admin' }), true);
  assert.strictEqual(boundForAdminMount({ baseUrl: '/api', path: '/administrator' }), false);
  assert.strictEqual(boundForAdminMount({ baseUrl: '/api/users', path: '/me' }), false);
});
