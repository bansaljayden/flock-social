// Run: node --test __tests__/appleRevocationClient.test.js  (from backend/)
//
// APPLE TOKENS ARE EXCHANGED AND REVOKED AS THE CLIENT THAT ISSUED THEM.
//
// Sign in with Apple runs under two clients: the iPhone app's bundle id
// (com.flockcorp.flock) and the website's Services ID (com.flockcorp.flock.web).
// Apple ties every authorization code and refresh token to the client that
// asked for it, and refuses an exchange or a revocation sent as the other one.
// Account deletion revokes the stored refresh token (App Store Guideline
// 5.1.1(v)) and refuses to delete while that fails, so a website token revoked
// as the app would hold an account deletion for ever.
//
// This file runs the REAL services/appleAuth.js with a generated signing key
// and stands in only for Apple's two endpoints, so what is pinned is the form
// body Apple would receive: client_id, and a client secret whose `sub` names
// the same client and whose signature verifies against the one key.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-apple-revocation';
delete process.env.APPLE_CLIENT_ID;
delete process.env.APPLE_WEB_CLIENT_ID;

const crypto = require('node:crypto');
const { publicKey: KEY_PUB, privateKey: KEY_PRIV } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
process.env.APPLE_TEAM_ID = 'TEAM123456';
process.env.APPLE_KEY_ID = 'KEY1234567';
// Stored the way Railway holds it: one line, with literal "\n" for newlines.
process.env.APPLE_PRIVATE_KEY = KEY_PRIV.replace(/\n/g, '\\n');

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const APP_CLIENT = 'com.flockcorp.flock';
const WEB_CLIENT = 'com.flockcorp.flock.web';

// ---------------------------------------------------------------------------
// Apple's endpoints. Everything else (this file's own requests to the test
// server) goes to the real fetch.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
const appleCalls = [];
let appleAnswersOk = true;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://appleid.apple.com/')) {
    const form = Object.fromEntries(new URLSearchParams(String(init.body)));
    appleCalls.push({ url: u, form });
    if (!appleAnswersOk) return { ok: false, status: 400, json: async () => ({ error: 'invalid_client' }) };
    return { ok: true, status: 200, json: async () => ({ refresh_token: `rt-${form.code || 'x'}` }) };
  }
  return realFetch(url, init);
};
test.after(() => { globalThis.fetch = realFetch; });

const appleAuth = require('../services/appleAuth');

// What Apple would read off the client secret: verified against the key's
// public half, so a secret signed with anything else fails here.
function secretClaims(call) {
  const { header, payload } = jwt.verify(call.form.client_secret, KEY_PUB, { algorithms: ['ES256'], complete: true });
  return { kid: header.kid, ...payload };
}

// ===========================================================================
// services/appleAuth.js on its own
// ===========================================================================
test('the module is configured from the three signing variables and knows both clients', () => {
  assert.strictEqual(appleAuth.isConfigured(), true);
  assert.strictEqual(appleAuth.CLIENT_ID, APP_CLIENT);
  assert.strictEqual(appleAuth.WEB_CLIENT_ID, WEB_CLIENT);
  assert.strictEqual(appleAuth.knownClientId(WEB_CLIENT), WEB_CLIENT);
  // NULL (every token stored before the website had Apple), nothing, and any
  // id this server does not know all mean the app. The key's secret is never
  // sent out under a client id nobody registered.
  for (const other of [null, undefined, '', APP_CLIENT, 'com.example.other', 'com.flockcorp.flock.web.evil']) {
    assert.strictEqual(appleAuth.knownClientId(other), APP_CLIENT, String(other));
  }
});

test('a code is exchanged as the client it was issued to, with a secret for that client', async () => {
  appleCalls.length = 0;
  await appleAuth.exchangeAppleCode('code-web', WEB_CLIENT);
  await appleAuth.exchangeAppleCode('code-app');
  assert.deepStrictEqual(appleCalls.map((c) => [c.url, c.form.client_id, c.form.code, c.form.grant_type]), [
    ['https://appleid.apple.com/auth/token', WEB_CLIENT, 'code-web', 'authorization_code'],
    ['https://appleid.apple.com/auth/token', APP_CLIENT, 'code-app', 'authorization_code'],
  ]);
  const [web, app] = appleCalls.map(secretClaims);
  assert.strictEqual(web.sub, WEB_CLIENT);
  assert.strictEqual(app.sub, APP_CLIENT);
  for (const claims of [web, app]) {
    assert.strictEqual(claims.iss, 'TEAM123456');
    assert.strictEqual(claims.aud, 'https://appleid.apple.com');
    assert.strictEqual(claims.kid, 'KEY1234567', 'one key signs for both clients');
    assert.ok(claims.exp - claims.iat <= 300);
  }
});

test('a refresh token is revoked as the client that issued it, and never as an unknown one', async () => {
  appleCalls.length = 0;
  assert.strictEqual(await appleAuth.revokeAppleToken('tok-web', WEB_CLIENT), true);
  assert.strictEqual(await appleAuth.revokeAppleToken('tok-app', null), true);
  assert.strictEqual(await appleAuth.revokeAppleToken('tok-odd', 'com.example.other'), true);
  assert.deepStrictEqual(appleCalls.map((c) => [c.url, c.form.client_id, c.form.token, c.form.token_type_hint]), [
    ['https://appleid.apple.com/auth/revoke', WEB_CLIENT, 'tok-web', 'refresh_token'],
    ['https://appleid.apple.com/auth/revoke', APP_CLIENT, 'tok-app', 'refresh_token'],
    ['https://appleid.apple.com/auth/revoke', APP_CLIENT, 'tok-odd', 'refresh_token'],
  ]);
  assert.deepStrictEqual(appleCalls.map((c) => secretClaims(c).sub), [WEB_CLIENT, APP_CLIENT, APP_CLIENT]);
});

// ===========================================================================
// DELETE /api/users/me, through the real revocation
// ===========================================================================
const pool = require('../config/database');
const realQuery = pool.query;
const realConnect = pool.connect;
const usersRouter = require('../routes/users');
const { proofFailures } = usersRouter.__testing;

let USERS;
let deletedUserIds;
function resetUsers() {
  const base = {
    role: 'user', email_verified: true, is_banned: false, banned_at: null, token_version: 0,
    password: null, phone: null, oauth_provider: 'apple', interests: [],
  };
  USERS = {
    // Signed up on flockcorp.com: its token belongs to the website.
    1: { ...base, id: 1, email: 'web@icloud.com', name: 'Web', oauth_id: 'apple-web', verified_email: 'web@icloud.com',
      apple_refresh_token: 'tok-web', apple_refresh_client_id: WEB_CLIENT },
    // Signed up in the iPhone app before the website had Apple: NULL is the app.
    2: { ...base, id: 2, email: 'app@icloud.com', name: 'App', oauth_id: 'apple-app', verified_email: 'app@icloud.com',
      apple_refresh_token: 'tok-app', apple_refresh_client_id: null },
  };
  deletedUserIds = [];
  appleCalls.length = 0;
  appleAnswersOk = true;
  proofFailures.clearAll();
}
resetUsers();

// The statements deleteAccount runs, modelled the way banEvasion.test.js
// models them; anything else is answered empty, which every one of its other
// writers tolerates.
function handle(text, params = []) {
  const has = (s) => text.includes(s);
  if (has('is_banned, token_version FROM users WHERE id = $1')) {
    const u = USERS[params[0]];
    return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
  }
  if (has('apple_refresh_token, is_banned, banned_at')) {
    const u = USERS[params[0]];
    return { rows: u ? [{ ...u }] : [], rowCount: u ? 1 : 0 };
  }
  if (has('SELECT stripe_customer_id FROM users WHERE id = $1')) return { rows: [{ stripe_customer_id: null }], rowCount: 1 };
  if (has('DELETE FROM users WHERE id = $1')) {
    const existed = Boolean(USERS[params[0]]);
    if (existed) { deletedUserIds.push(params[0]); delete USERS[params[0]]; }
    return { rows: existed ? [{ id: params[0] }] : [], rowCount: existed ? 1 : 0 };
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

// A session minted a moment ago: an Apple account has no password, so the
// route accepts a fresh session as its proof (hasFreshSession).
const freshToken = (id) => jwt.sign({ userId: id, tv: 0, iat: Math.floor(Date.now() / 1000) }, process.env.JWT_SECRET);

async function deleteAs(id) {
  const res = await realFetch(`${base}/api/users/me`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${freshToken(id)}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body, text };
}

test('deleting a website Apple account revokes its token as the website', async () => {
  resetUsers();
  const res = await deleteAs(1);
  assert.strictEqual(res.status, 200, res.text);
  const revokes = appleCalls.filter((c) => c.url.endsWith('/auth/revoke'));
  assert.strictEqual(revokes.length, 1);
  assert.strictEqual(revokes[0].form.client_id, WEB_CLIENT);
  assert.strictEqual(revokes[0].form.token, 'tok-web');
  assert.strictEqual(secretClaims(revokes[0]).sub, WEB_CLIENT);
  assert.deepStrictEqual(deletedUserIds, [1]);
});

test('deleting an iPhone Apple account revokes its token as the app, exactly as before', async () => {
  resetUsers();
  const res = await deleteAs(2);
  assert.strictEqual(res.status, 200, res.text);
  const revokes = appleCalls.filter((c) => c.url.endsWith('/auth/revoke'));
  assert.deepStrictEqual(revokes.map((c) => [c.form.client_id, c.form.token]), [[APP_CLIENT, 'tok-app']]);
  assert.deepStrictEqual(deletedUserIds, [2]);
});

test('when Apple refuses the revocation the account is kept and the person is told to try again', async () => {
  resetUsers();
  appleAnswersOk = false;
  const res = await deleteAs(1);
  assert.strictEqual(res.status, 503, res.text);
  assert.match(res.body.error, /Try again/);
  assert.deepStrictEqual(deletedUserIds, []);
  assert.ok(USERS[1], 'the only copy of the token survives for the retry');
});

test('both deletion reads select the client id beside the token, behind the substring the harnesses match', () => {
  const src = require('node:fs').readFileSync(require.resolve('../routes/users'), 'utf8');
  const reads = src.match(/SELECT id, email, phone, password, oauth_provider, oauth_id, apple_refresh_token, is_banned, banned_at, email_verified, verified_email, apple_refresh_client_id\s+FROM users WHERE id = \$1/g) || [];
  assert.strictEqual(reads.length, 2, 'the fetch and the FOR UPDATE re-read stay one statement');
  assert.match(src, /revokeAppleToken\(u\.rows\[0\]\.apple_refresh_token, u\.rows\[0\]\.apple_refresh_client_id \|\| null\)/);
});
