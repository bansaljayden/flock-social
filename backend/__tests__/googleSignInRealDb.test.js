'use strict';
// Run: node --test __tests__/googleSignInRealDb.test.js  (from backend/)
//
// ---------------------------------------------------------------------------
// GOOGLE SIGN-IN FROM THE IPHONE APP, END TO END ON A REAL POSTGRES
// ---------------------------------------------------------------------------
//
// googleReplayAndThrottle.test.js pins the route's nonce and replay rules with
// google-auth-library stubbed out, so the token it hands the route was never
// checked by anything. This suite stubs one thing only: where Google's public
// keys come from. Every token below is a real RS256 JWT signed with a key made
// for the run, and the library's own verifyIdToken checks its signature, its
// issuer, its times and its audience before routes/auth.js reads a claim. The
// tokens are shaped the way GoogleSignIn on iOS shapes them (the server's
// client id as the audience, the iOS client as azp, and a nonce AppAuth made
// up, which the app never sees), and the requests carry the iPhone app's
// Origin (utils/clientShell.js). So what runs is what an iPhone sign-in runs,
// from the signature check to the INSERT and back out through GET /me.
//
// Before 2026-11-22 every one of those sign-ins was answered 401 ("carries a
// nonce the client did not send"; THE iOS SDK'S OWN NONCE in routes/auth.js).
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');
const { removeTempDir } = require('./helpers/removeTempDir');

// Synchronous and before config/database is required anywhere: that module
// builds its Pool from DATABASE_URL at require time, and backend/.env points at
// the live database.
const PG_PORT = pickEmbeddedPgPort('googleSignInRealDb');
const DB_NAME = 'flock_google_signin';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-google-signin';
process.env.GOOGLE_CLIENT_ID = 'flock-server-test.apps.googleusercontent.com';
delete process.env.GOOGLE_REQUIRE_NONCE;
delete process.env.RESEND_API_KEY;
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const IOS_CLIENT_ID = 'flock-ios-test.apps.googleusercontent.com';
const IOS_ORIGIN = 'capacitor://localhost';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlockiOS';

// The key Google would sign with, made for this run, and the one stub: the
// library asks for Google's certificates and is handed this key's public half
// under its kid. Everything after that call is the library's own code.
const KID = `test-kid-${crypto.randomBytes(4).toString('hex')}`;
const GOOGLE_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const OTHER_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { OAuth2Client } = require('google-auth-library');
OAuth2Client.prototype.getFederatedSignonCertsAsync = async function testCerts() {
  return { certs: { [KID]: GOOGLE_KEY.publicKey.export({ type: 'spki', format: 'pem' }) }, format: 'PEM' };
};

let pg;
let pool;
let dataDir;
let server;
let base;
let seq = 0;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-google-signin-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'googleSignInRealDb', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);

  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/auth', require('../routes/auth'));
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  removeTempDir(dataDir, 'googleSignInRealDb');
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function call(method, url, { origin, session, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) {
    headers.Origin = origin;
    headers['User-Agent'] = IOS_UA;
  }
  if (session) headers.Authorization = `Bearer ${session}`;
  const res = await fetch(base + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

const appAuthNonce = () => crypto.randomBytes(32).toString('base64url');

function person() {
  seq += 1;
  return { sub: `10${Date.now()}${seq}`, email: `iphone${seq}.${Date.now()}@gmail.com` };
}

// An ID token as GoogleSignIn on iOS gets it when the app names a server
// client: the audience is the server's client id and azp the iOS client's.
function claimsFor(who, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://accounts.google.com',
    azp: IOS_CLIENT_ID,
    aud: process.env.GOOGLE_CLIENT_ID,
    sub: who.sub,
    email: who.email,
    email_verified: true,
    at_hash: crypto.randomBytes(16).toString('base64url'),
    nonce: appAuthNonce(),
    name: 'Ava Test',
    given_name: 'Ava',
    family_name: 'Test',
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
  for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
  return claims;
}

function idToken(who, overrides = {}, { key = GOOGLE_KEY.privateKey, kid = KID, noIat = false } = {}) {
  const claims = claimsFor(who, overrides);
  // jsonwebtoken keeps an iat the payload already has, and adds one when it has
  // none unless told not to, which also drops one that is there.
  if (noIat) delete claims.iat;
  return jwt.sign(claims, key, { algorithm: 'RS256', keyid: kid, noTimestamp: noIat });
}

// A token with a header no signing library would write: three base64url
// segments, so it passes the route's shape guard and reaches the library.
const seg = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const handMade = (header, claims, signature) => `${seg(header)}.${seg(claims)}.${signature}`;

// ── The iPhone app ───────────────────────────────────────────────────────────

test('an iPhone Google sign-in, with the nonce AppAuth made up, creates the account and signs in', async () => {
  const who = person();
  const first = await call('POST', '/api/auth/google', { origin: IOS_ORIGIN, body: { credential: idToken(who) } });
  assert.equal(first.status, 200, first.text);
  assert.ok(first.body.token, 'an access token');
  assert.ok(first.body.refreshToken, 'a refresh credential');
  assert.equal(first.body.user.email, who.email);
  assert.equal(first.body.user.sign_in_method, 'google');

  const { rows } = await pool.query(
    'SELECT oauth_provider, oauth_id, password, date_of_birth, email_verified, verified_email FROM users WHERE id = $1',
    [first.body.user.id]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].oauth_provider, 'google');
  assert.equal(rows[0].oauth_id, who.sub);
  assert.equal(rows[0].password, null);
  assert.equal(rows[0].date_of_birth, null, 'the iPhone app asks for no date (utils/clientShell.js)');
  assert.equal(rows[0].email_verified, true);
  assert.equal(rows[0].verified_email, who.email);

  // The session it handed back is a working one.
  const me = await call('GET', '/api/auth/me', { session: first.body.token });
  assert.equal(me.status, 200, me.text);
  assert.equal(me.body.user.id, first.body.user.id);
  assert.equal(me.body.user.sign_in_method, 'google');

  // Opening the app again later is a fresh token with a fresh nonce: the same
  // account, not a second one.
  const later = await call('POST', '/api/auth/google', { origin: IOS_ORIGIN, body: { credential: idToken(who) } });
  assert.equal(later.status, 200, later.text);
  assert.equal(later.body.user.id, first.body.user.id);
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE oauth_id = $1', [who.sub]);
  assert.equal(count.rows[0].n, 1);
});

test('the same iPhone token presented twice is a replay', async () => {
  const who = person();
  const credential = idToken(who);
  const first = await call('POST', '/api/auth/google', { origin: IOS_ORIGIN, body: { credential } });
  assert.equal(first.status, 200, first.text);
  const again = await call('POST', '/api/auth/google', { origin: IOS_ORIGIN, body: { credential } });
  assert.equal(again.status, 401, again.text);
});

test('a token bound to a nonce this server issued still has to come back with it', async () => {
  const who = person();
  const issued = await call('POST', '/api/auth/google/nonce', { origin: IOS_ORIGIN });
  assert.equal(issued.status, 200, issued.text);
  const { nonce } = issued.body;
  assert.ok(nonce);

  const withoutIt = await call('POST', '/api/auth/google', { origin: IOS_ORIGIN, body: { credential: idToken(who, { nonce }) } });
  assert.equal(withoutIt.status, 401, withoutIt.text);

  const withIt = await call('POST', '/api/auth/google', { origin: IOS_ORIGIN, body: { credential: idToken(who, { nonce }), nonce } });
  assert.equal(withIt.status, 200, withIt.text);

  // Spent by that sign-in.
  const spent = await call('POST', '/api/auth/google', { origin: IOS_ORIGIN, body: { credential: idToken(who, { nonce }), nonce } });
  assert.equal(spent.status, 401, spent.text);
});

test('the website still asks a new Google account for a year of birth', async () => {
  const who = person();
  const r = await call('POST', '/api/auth/google', { body: { credential: idToken(who, { azp: process.env.GOOGLE_CLIENT_ID }) } });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.body.needsDob, true);
  const n = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE oauth_id = $1', [who.sub]);
  assert.equal(n.rows[0].n, 0, 'nothing written');
});

// ── What the library refuses, and how the route answers ─────────────────────

// Every line the server logs while fn runs.
async function capturingLogs(fn) {
  const lines = [];
  const saved = { warn: console.warn, error: console.error, log: console.log };
  for (const k of Object.keys(saved)) {
    console[k] = (...args) => lines.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '));
  }
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines.join('\n');
}

test('a token the library refuses is a 401, whatever it got wrong; nothing is written and nothing of it is logged', async () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    ['signed with another key', (who) => idToken(who, {}, { key: OTHER_KEY.privateKey })],
    ['signed under a key id Google does not publish', (who) => idToken(who, {}, { kid: 'not-a-google-kid' })],
    ['made for another app', (who) => idToken(who, { aud: 'some-other-app.apps.googleusercontent.com' })],
    ['from another issuer', (who) => idToken(who, { iss: 'https://accounts.example.com' })],
    ['expired an hour ago', (who) => idToken(who, { iat: now - 7200, exp: now - 3600 })],
    ['issued in the future', (who) => idToken(who, { iat: now + 3600, exp: now + 7200 })],
    ['carrying no issue time', (who) => idToken(who, {}, { noIat: true })],
    // Found in review: refusals the library words in no message the route
    // could list. ES256 fails in its joseToDer on a short signature, and a key
    // id that is an object with no usable toString fails as a property key.
    ['an ES256 header with a short signature', (who) => handMade({ alg: 'ES256', typ: 'JWT', kid: KID }, claimsFor(who), 'AA')],
    ['a key id that is an object', (who) => handMade({ alg: 'RS256', typ: 'JWT', kid: { toString: null, valueOf: null } },
      claimsFor(who), crypto.randomBytes(256).toString('base64url'))],
  ];
  for (const [label, make] of cases) {
    const who = person();
    const credential = make(who);
    let r;
    const logged = await capturingLogs(async () => {
      r = await call('POST', '/api/auth/google', { origin: IOS_ORIGIN, body: { credential } });
    });
    assert.equal(r.status, 401, `${label}: ${r.text}`);
    const n = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE oauth_id = $1', [who.sub]);
    assert.equal(n.rows[0].n, 0, `${label}: nothing written`);
    assert.match(logged, /refused Google ID token/, `${label}: the refusal is logged`);
    for (const secret of [who.email, who.sub, credential.split('.')[1], credential.split('.')[2]]) {
      assert.ok(!logged.includes(secret), `${label}: the log must not quote the token or its claims`);
    }
  }
});

test("Google's keys being out of reach is not an expired sign-in", async () => {
  const saved = OAuth2Client.prototype.getFederatedSignonCertsAsync;
  OAuth2Client.prototype.getFederatedSignonCertsAsync = async function outage() {
    throw new Error('Failed to retrieve verification certificates: getaddrinfo ENOTFOUND www.googleapis.com');
  };
  try {
    const who = person();
    let r;
    await capturingLogs(async () => {
      r = await call('POST', '/api/auth/google', { origin: IOS_ORIGIN, body: { credential: idToken(who) } });
    });
    assert.equal(r.status, 500, r.text);
    assert.equal(r.body.error, 'Google sign-in failed');
  } finally {
    OAuth2Client.prototype.getFederatedSignonCertsAsync = saved;
  }
  // And once they are back, the same person signs in.
  const who = person();
  const ok = await call('POST', '/api/auth/google', { origin: IOS_ORIGIN, body: { credential: idToken(who) } });
  assert.equal(ok.status, 200, ok.text);
});
