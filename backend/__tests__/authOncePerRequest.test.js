// Run: node --test  (from backend/)
//
// authenticate runs once per router a request crosses (server.js mounts
// /api/flocks twice and two bare /api catch-alls). Since 2026-10-05 a later
// pass reuses the first pass's verified token and user row:
//
//   * one token check and one user lookup per request, however many passes;
//   * every pass still applies its own ban rule, so a ban-tolerant pass
//     followed by a strict one still refuses;
//   * a pass that waived the clock (logout) leaves nothing for a later pass,
//     which checks an expired token itself and refuses it;
//   * the secret is handed to jsonwebtoken as a key, and a changed JWT_SECRET
//     takes effect on the next request.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-for-auth-once-per-request';

const pool = require('../config/database');
const {
  authenticate, authenticateAllowBanned, authenticateAllowExpired, signUserToken,
} = require('../middleware/auth');

let userRow = null;
let lookups = 0;
const realQuery = pool.query;
pool.query = async () => { lookups += 1; return { rows: userRow ? [userRow] : [] }; };
test.after(() => {
  pool.query = realQuery;
  pool.end().catch(() => {});
});

const ok = (req, res) => res.json({ ok: true, id: req.user.id });
const app = express();
app.get('/three', authenticate, authenticate, authenticate, ok);
app.get('/tolerant-then-strict', authenticateAllowBanned, authenticate, ok);
app.get('/expired-then-strict', authenticateAllowExpired, authenticate, ok);
app.get('/expired-only', authenticateAllowExpired, ok);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));

const call = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });

const ACTIVE = { id: 7, email: 'a@example.com', name: 'Ava', role: 'user', email_verified: true, is_banned: false, token_version: 0 };
const BANNED = { ...ACTIVE, is_banned: true };

test('three passes, one token check and one user lookup', async () => {
  userRow = ACTIVE;
  lookups = 0;
  const res = await call('/three', signUserToken(ACTIVE));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(lookups, 1);
});

test('a ban-tolerant pass followed by a strict one still refuses a banned account', async () => {
  userRow = BANNED;
  lookups = 0;
  const res = await call('/tolerant-then-strict', signUserToken(BANNED));
  assert.strictEqual(res.status, 403);
  assert.strictEqual(lookups, 1);
});

test('a pass that waived the clock leaves nothing behind for a strict pass', async () => {
  userRow = ACTIVE;
  const expired = jwt.sign({ userId: 7, tv: 0, iat: 1, exp: 2 }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  assert.strictEqual((await call('/expired-only', expired)).status, 200, 'logout still accepts an expired token');
  lookups = 0;
  const res = await call('/expired-then-strict', expired);
  assert.strictEqual(res.status, 401);
  assert.deepStrictEqual(await res.json(), { error: 'Token expired' });
  assert.strictEqual(lookups, 1, 'only the clock-waiving pass reached the database');
});

test('the key follows JWT_SECRET, and a token signed with anything else is refused', async () => {
  userRow = ACTIVE;
  const forged = jwt.sign({ userId: 7, tv: 0 }, 'some-other-secret', { algorithm: 'HS256', expiresIn: '1h' });
  assert.strictEqual((await call('/three', forged)).status, 401);

  const before = signUserToken(ACTIVE);
  const original = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'a-rotated-secret-for-the-test';
  try {
    assert.strictEqual((await call('/three', before)).status, 401, 'a token from the old secret is refused at once');
    assert.strictEqual((await call('/three', signUserToken(ACTIVE))).status, 200);
  } finally {
    process.env.JWT_SECRET = original;
  }
  assert.strictEqual((await call('/three', before)).status, 200);
});
