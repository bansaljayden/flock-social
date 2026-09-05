// Run: node --test __tests__/profileEmailAndProofWindow.test.js  (from backend/)
//
// ---------------------------------------------------------------------------
// Two account-lifecycle defects in routes/users.js, traced 2026-09-04.
// ---------------------------------------------------------------------------
// 1. THE DISPOSABLE-DOMAIN BLOCK WAS SKIPPED ON EMAIL CHANGE.
//    All three account-creation paths in routes/auth.js refuse a throwaway
//    address. PUT /api/users/profile did not, so the block was one profile
//    save away: create the account on an address you keep, then move it to
//    the disposable one. Pinned here as a validation refusal, before any SQL.
//
// 2. THE PASSWORD-PROOF LOCKOUT NAMED THE WRONG WINDOW.
//    proofFailures is five attempts in fifteen minutes, and lockedFor() has
//    always returned the milliseconds left. The three routes behind it
//    answered "Try again in a few minutes", which utils/retryAfter.js exists
//    to stop: the person came back at three minutes, was refused again, and
//    read the feature as broken. /login already says the real window. Each
//    429 must now carry the sentence built from the real window, the
//    retryAfterSeconds and resetsAt fields, and the Retry-After header.
//
// Same harness shape as __tests__/usersBcryptAndProofEviction.test.js: the
// routes are driven only as far as the point under test, so the fake answers
// the account row and nothing else.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-unit-tests';

const pool = require('../config/database');
const realQuery = pool.query;
const realConnect = pool.connect;

const usersRouter = require('../routes/users');
const { proofFailures } = usersRouter.__testing;
const { isDisposableEmail } = require('../utils/disposableEmail');

const PASSWORD_HASH = bcrypt.hashSync('CorrectHorse1', 4);

let USER;
function reset() {
  USER = {
    id: 1, email: 'alice@example.com', name: 'Alice', role: 'user', email_verified: true,
    is_banned: false, banned_at: null, token_version: 0, password: PASSWORD_HASH,
    phone: null, interests: [], bio: null, profile_image_url: null,
    venmo_username: null, cashapp_cashtag: null, zelle_identifier: null,
    is_premium: false, oauth_provider: null, oauth_id: null, apple_refresh_token: null,
    terms_accepted_at: '2026-01-01T00:00:00Z', date_of_birth: '2008-05-01',
    reliability_score: '92.50', total_plans_joined: 0, total_plans_attended: 0,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };
  proofFailures.clearAll();
}
reset();

function handle(text, params) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (/^SELECT[\s\S]*FROM users WHERE id = \$1/i.test(flat)) {
    return { rows: Number(params?.[0]) === USER.id ? [USER] : [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

pool.query = async (text, params) => handle(typeof text === 'string' ? text : text.text, params);
pool.connect = async () => ({
  query: async (text, params) => handle(typeof text === 'string' ? text : text.text, params),
  release() {},
});

const app = express();
app.use(express.json());
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
  return pool.end().catch(() => {});
});

function token() {
  return jwt.sign({ userId: USER.id, tv: USER.token_version }, process.env.JWT_SECRET);
}

async function req(method, url, { body, headers = {} } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, headers: res.headers };
}

// ===========================================================================
// 1. disposable domains on email change
// ===========================================================================

const DISPOSABLE = 'throwaway@mailinator.com';

test('the fixture domain really is on the list, so the refusal below is the list speaking', () => {
  assert.strictEqual(isDisposableEmail(DISPOSABLE), true);
  assert.strictEqual(isDisposableEmail('alice@example.com'), false);
});

test('PUT /profile refuses a move to a disposable address with the same sentence signup uses', async () => {
  reset();
  const res = await req('PUT', '/api/users/profile', {
    body: { email: DISPOSABLE, current_password: 'CorrectHorse1' },
  });
  assert.strictEqual(res.status, 400, JSON.stringify(res.body));
  assert.strictEqual(res.body.error, 'Temporary email addresses cannot be used. Use an address you keep.');
});

test('an address that is not disposable is not caught by the new rule', async () => {
  reset();
  const res = await req('PUT', '/api/users/profile', {
    body: { email: 'alice.new@example.com', current_password: 'CorrectHorse1' },
  });
  assert.notStrictEqual(res.status, 400, JSON.stringify(res.body));
});

// ===========================================================================
// 2. the proof lockout names its real window
// ===========================================================================

const LOCKED = [
  {
    name: 'PUT /api/users/profile',
    call: () => req('PUT', '/api/users/profile', { body: { current_password: 'WrongHorse1' } }),
    reauth: undefined,
  },
  {
    name: 'GET /api/users/export',
    call: () => req('GET', '/api/users/export', { headers: { 'X-Export-Password': 'WrongHorse1' } }),
    reauth: 'password',
  },
  {
    name: 'DELETE /api/users/me',
    call: () => req('DELETE', '/api/users/me', { body: { password: 'WrongHorse1' } }),
    reauth: 'password',
  },
];

for (const route of LOCKED) {
  test(`${route.name}: a locked proof says when the lock lifts, in words and in fields`, async () => {
    reset();
    for (let i = 0; i < 5; i += 1) proofFailures.record(USER.id);
    const lockedMs = proofFailures.lockedFor(USER.id);
    assert.ok(lockedMs > 0, 'five recorded failures lock the key');

    const res = await route.call();
    assert.strictEqual(res.status, 429, JSON.stringify(res.body));
    // The window is fifteen minutes and the lock was taken a moment ago, so
    // the only honest phrase is about fifteen minutes. "a few minutes" was the
    // advice that could not work.
    assert.match(res.body.error, /^Too many incorrect passwords\. You can try again in about 1[45] minutes\.$/,
      `got: ${res.body.error}`);
    assert.ok(Number.isInteger(res.body.retryAfterSeconds) && res.body.retryAfterSeconds > 0,
      'retryAfterSeconds must be present so a client can count down');
    assert.ok(!Number.isNaN(Date.parse(res.body.resetsAt)), 'resetsAt must be an ISO timestamp');
    assert.ok(res.body.retryAfterSeconds <= Math.ceil(lockedMs / 1000) + 1,
      'the seconds reported must not overstate the lock');
    assert.strictEqual(res.headers.get('retry-after'), String(res.body.retryAfterSeconds),
      'the Retry-After header must carry the same number');
    assert.strictEqual(res.body.reauthRequired, route.reauth);
  });
}

test('the old fixed sentence is gone from routes/users.js', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'users.js'), 'utf8');
  assert.doesNotMatch(src, /Try again in a few minutes/,
    'a lockout on a fifteen-minute window must not promise a few minutes');
});
