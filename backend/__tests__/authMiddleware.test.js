// Run: node --test  (from backend/)
//
// Covers two round-13 auth fixes that are otherwise only exercised in
// production the first time they matter:
//
//   1. The banned-user DELETE carve-out. It used to live inside the middleware
//      as `/\/users\/me\/?(\?|$)/.test(req.originalUrl)` — unanchored, run
//      against a URL that INCLUDES the query string. So
//      `DELETE /api/flocks/42?x=/users/me` matched, skipped the ban check, and
//      let a banned harasser delete a flock (CASCADE takes every message in it
//      with it — the exact evidence a moderator was reviewing), plus deletes on
//      blocks, safety contacts, friends, calendar, promotions and reactions.
//      There is no URL matching any more: routes opt in explicitly.
//
//   2. token_version / the `tv` JWT claim. The OAuth account-claim transfers
//      the row but used to leave the squatter's existing 24h token live.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-for-auth-middleware-tests';

const pool = require('../config/database');
const { authenticate, authenticateAllowBanned, signUserToken } = require('../middleware/auth');

// Stub the single user lookup both middlewares make. No database is touched.
let userRow = null;
const realQuery = pool.query;
pool.query = async () => ({ rows: userRow ? [userRow] : [] });
test.after(() => {
  pool.query = realQuery;
  pool.end().catch(() => {});
});

const app = express();
// Mirrors routes/users.js: the deletion route opts in to the ban-tolerant
// variant, everything else runs the strict one.
app.delete('/api/users/me', authenticateAllowBanned, (req, res) => res.json({ ok: 'deleted' }));
app.use(authenticate);
app.all(/.*/, (req, res) => res.json({ ok: 'strict' }));

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));

const call = (method, path, token) =>
  fetch(base + path, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });

const BANNED = { id: 7, email: 'c@example.com', name: 'Carol', role: 'user', is_banned: true, token_version: 0 };
const ACTIVE = { ...BANNED, is_banned: false };

test('banned user cannot smuggle a DELETE past the ban check with a crafted query string', async () => {
  userRow = BANNED;
  const token = signUserToken(BANNED);

  // The exact string the old unanchored regex accepted.
  const smuggled = await call('DELETE', '/api/flocks/42?x=/users/me', token);
  assert.strictEqual(smuggled.status, 403);

  // And the other shapes that regex would also have matched.
  for (const path of ['/api/flocks/42?redirect=/users/me', '/api/blocks/9?next=/users/me/']) {
    const res = await call('DELETE', path, token);
    assert.strictEqual(res.status, 403, `expected 403 for ${path}`);
  }
});

test('banned user is blocked on ordinary requests but can still delete their own account', async () => {
  userRow = BANNED;
  const token = signUserToken(BANNED);

  assert.strictEqual((await call('GET', '/api/flocks', token)).status, 403);
  assert.strictEqual((await call('DELETE', '/api/flocks/42', token)).status, 403);

  // Apple 5.1.1(v) / GDPR: erasure must survive a ban.
  const del = await call('DELETE', '/api/users/me', token);
  assert.strictEqual(del.status, 200);
  assert.deepStrictEqual(await del.json(), { ok: 'deleted' });
});

test('an active user is unaffected', async () => {
  userRow = ACTIVE;
  const res = await call('GET', '/api/flocks', signUserToken(ACTIVE));
  assert.strictEqual(res.status, 200);
});

test('token_version: a bump invalidates tokens minted before it', async () => {
  userRow = ACTIVE;
  const stale = signUserToken(ACTIVE); // tv: 0

  // The OAuth claim (or a password change) bumps the row.
  userRow = { ...ACTIVE, token_version: 1 };
  assert.strictEqual((await call('GET', '/api/flocks', stale)).status, 401);

  // A token minted after the bump works.
  assert.strictEqual((await call('GET', '/api/flocks', signUserToken(userRow))).status, 200);

  // The exemption is not a bypass: a revoked token cannot delete the account either.
  assert.strictEqual((await call('DELETE', '/api/users/me', stale)).status, 401);
});

test('token_version: legacy tokens with no tv claim are read as version 0', async () => {
  const legacy = jwt.sign({ userId: ACTIVE.id }, process.env.JWT_SECRET, { expiresIn: '24h' });

  // Still valid against a never-bumped row (the column DEFAULT is 0), so the
  // deploy does not sign the whole user base out.
  userRow = ACTIVE;
  assert.strictEqual((await call('GET', '/api/flocks', legacy)).status, 200);

  // And cleanly rejected once anything bumps the row.
  userRow = { ...ACTIVE, token_version: 1 };
  assert.strictEqual((await call('GET', '/api/flocks', legacy)).status, 401);
});
