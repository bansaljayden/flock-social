'use strict';
// Run: node --test __tests__/oauthAccountConflictsRealDb.test.js  (from backend/)
//
// ---------------------------------------------------------------------------
// WHEN A GOOGLE OR APPLE SIGN-IN MEETS AN ACCOUNT IT DID NOT EXPECT
// ---------------------------------------------------------------------------
//
// Reproduced on an iPhone emulation of App Store build 53 against the real
// backend, and pinned here on POST /api/auth/google and POST /api/auth/apple:
//
//   - an address held by the OTHER provider is answered with which button opens
//     it, when the provider vouched for the address, and with the old sentence
//     when it did not;
//   - an unconfirmed email-and-password account with friends, plans, messages
//     or Flock Pro in it is not evicted on the first tap: the first tap is told
//     what is there, and only the same Google or Apple identity tapping again
//     within ten minutes starts the new account. An empty one is evicted as
//     before;
//   - `created: true` on the response of a sign-in that made the account, and
//     on no other;
//   - `intent: 'signin'` refuses to create an account, before anything is
//     asked, written or spent, so the same credential can come back as 'create';
//   - build 53's "Confirm it's you" with Google, which re-sends the token its
//     sign-in spent, is accepted with that account's own session and refused
//     with anything less;
//   - a "Confirm it's you" with a Google account or Apple ID that no Flock
//     account signs in with is answered noAccount, whatever holds its address,
//     and writes and spends nothing.
//
// Everything is real except where the providers' public keys come from (and,
// for Apple, its token endpoint): every Google token is an RS256 JWT verified
// by google-auth-library's own verifyIdToken, every Apple token by
// jsonwebtoken, and every row is read back from a migrated Postgres.
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
const PG_PORT = pickEmbeddedPgPort('oauthAccountConflictsRealDb');
const DB_NAME = 'flock_oauth_conflicts';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-oauth-conflicts';
process.env.GOOGLE_CLIENT_ID = 'flock-server-test.apps.googleusercontent.com';
delete process.env.GOOGLE_REQUIRE_NONCE;
delete process.env.APPLE_REQUIRE_NONCE;
delete process.env.APPLE_BUNDLE_ID;
delete process.env.APPLE_WEB_CLIENT_ID;
delete process.env.RESEND_API_KEY;
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const IOS_CLIENT_ID = 'flock-ios-test.apps.googleusercontent.com';
const IOS_ORIGIN = 'capacitor://localhost';
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FlockiOS';
const APPLE_APP_CLIENT = 'com.flockcorp.flock';

const GENERIC_409 = 'An account with this email already exists. Sign in the way you originally signed up.';

// ── The provider stubs, installed before routes/auth.js loads ───────────────

// Google: the library asks for Google's certificates and is handed this key's
// public half. Everything after that call is the library's own code.
const KID = `test-kid-${crypto.randomBytes(4).toString('hex')}`;
const GOOGLE_KEY = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { OAuth2Client } = require('google-auth-library');
OAuth2Client.prototype.getFederatedSignonCertsAsync = async function testCerts() {
  return { certs: { [KID]: GOOGLE_KEY.publicKey.export({ type: 'spki', format: 'pem' }) }, format: 'PEM' };
};

// Apple: its signing key, and its token endpoint, which records every code it
// is asked to exchange so a test can say the exchange never ran.
const APPLE_KEY = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const jwksPath = require.resolve('jwks-rsa');
require.cache[jwksPath] = {
  id: jwksPath, filename: jwksPath, loaded: true,
  exports: () => ({ getSigningKey: (_kid, cb) => cb(null, { getPublicKey: () => APPLE_KEY.publicKey }) }),
};
const apple = { exchanges: [] };
const appleAuthPath = require.resolve('../services/appleAuth');
require.cache[appleAuthPath] = {
  id: appleAuthPath, filename: appleAuthPath, loaded: true,
  exports: {
    isConfigured: () => true,
    exchangeAppleCode: async (code, clientId) => {
      apple.exchanges.push({ code, clientId });
      return { refresh_token: `rt-${code}` };
    },
    revokeAppleToken: async () => true,
  },
};

let pg;
let pool;
let dataDir;
let server;
let base;
let seq = 0;
let authTesting;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-oauth-conflicts-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'oauthAccountConflictsRealDb', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);

  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  const authRouter = require('../routes/auth');
  authTesting = authRouter.__testing;
  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/auth', authRouter);
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  removeTempDir(dataDir, 'oauthAccountConflictsRealDb');
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

// `app: true` sends the iPhone app's Origin and User-Agent
// (utils/clientShell.js), which is what lets a new account be made with no
// date of birth.
async function call(url, { app = true, session, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (app) {
    headers.Origin = IOS_ORIGIN;
    headers['User-Agent'] = IOS_UA;
  }
  if (session) headers.Authorization = `Bearer ${session}`;
  const res = await fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

function person() {
  seq += 1;
  return { sub: `20${Date.now()}${seq}`, email: `conflict${seq}.${Date.now()}@gmail.com` };
}

// A Google ID token as GoogleSignIn on iOS gets it. The random at_hash makes
// every call a different token, as every real sign-in is.
function googleToken(who, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: 'https://accounts.google.com',
    azp: IOS_CLIENT_ID,
    aud: process.env.GOOGLE_CLIENT_ID,
    sub: who.sub,
    email: who.email,
    email_verified: true,
    at_hash: crypto.randomBytes(16).toString('base64url'),
    nonce: crypto.randomBytes(32).toString('base64url'),
    name: 'Ava Test',
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
  return jwt.sign(claims, GOOGLE_KEY.privateKey, { algorithm: 'RS256', keyid: KID });
}

// An Apple identity token as the iPhone app gets it; the jti makes each one a
// different token.
function appleToken(who, overrides = {}) {
  return jwt.sign(
    {
      iss: 'https://appleid.apple.com', aud: APPLE_APP_CLIENT, sub: who.sub,
      email: who.email, email_verified: true, jti: crypto.randomUUID(), ...overrides,
    },
    APPLE_KEY.privateKey,
    { algorithm: 'RS256', expiresIn: '10m', keyid: 'apple-test-kid' }
  );
}

const appleCode = () => `code-${crypto.randomBytes(6).toString('hex')}`;

async function rowsFor(sub) {
  const { rows } = await pool.query('SELECT * FROM users WHERE oauth_id = $1', [sub]);
  return rows;
}

async function rowById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0];
}

// An email-and-password account. `confirmed: false` is one whose owner never
// tapped the confirmation link, which claimDecision reads as 'evict'.
async function passwordAccount(email, { confirmed }) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified, verified_email, terms_accepted_at)
     VALUES ($1, 'not-a-real-hash', 'Old Account', $2, $3, NOW()) RETURNING *`,
    [email, confirmed, confirmed ? email : null]
  );
  return rows[0];
}

// Somebody else, to be friends with.
async function bystander() {
  seq += 1;
  return passwordAccount(`bystander${seq}.${Date.now()}@example.com`, { confirmed: true });
}

async function befriend(a, b, status = 'accepted') {
  await pool.query('INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, $3)', [a.id, b.id, status]);
}

const UNCONFIRMED_GOOGLE = 'This email already has a Flock account that was never confirmed. To keep its friends and plans, sign in with its email and password. To start a new account with Google instead, tap Continue with Google again.';
const UNCONFIRMED_APPLE = 'This email already has a Flock account that was never confirmed. To keep its friends and plans, sign in with its email and password. To start a new account with Apple instead, tap Continue with Apple again.';

// ── A. Which way in ──────────────────────────────────────────────────────────

test('A: Google on an address an Apple account holds names Apple; unvouched keeps the old sentence', async () => {
  const who = person();
  const made = await call('/api/auth/apple', { body: { identityToken: appleToken(who), authorizationCode: appleCode() } });
  assert.equal(made.status, 200, made.text);

  const google = { sub: `g${who.sub}`, email: who.email };
  const named = await call('/api/auth/google', { body: { credential: googleToken(google) } });
  assert.equal(named.status, 409, named.text);
  assert.deepEqual(named.body, {
    error: 'This email already has a Flock account that signs in with Apple. Tap Continue with Apple.',
    signInWith: 'apple',
  });

  const unvouched = await call('/api/auth/google', { body: { credential: googleToken(google, { email_verified: false }) } });
  assert.equal(unvouched.status, 409, unvouched.text);
  assert.deepEqual(unvouched.body, { error: GENERIC_409 });
  assert.equal((await rowsFor(google.sub)).length, 0, 'no Google row written');
});

test('A: Apple on an address a Google account holds names Google; unvouched keeps the old sentence', async () => {
  const who = person();
  const made = await call('/api/auth/google', { body: { credential: googleToken(who) } });
  assert.equal(made.status, 200, made.text);

  const appleWho = { sub: `a${who.sub}`, email: who.email };
  const before = apple.exchanges.length;
  const named = await call('/api/auth/apple', { body: { identityToken: appleToken(appleWho), authorizationCode: appleCode() } });
  assert.equal(named.status, 409, named.text);
  assert.deepEqual(named.body, {
    error: 'This email already has a Flock account that signs in with Google. Tap Continue with Google.',
    signInWith: 'google',
  });

  const unvouched = await call('/api/auth/apple', {
    body: { identityToken: appleToken(appleWho, { email_verified: false }), authorizationCode: appleCode() },
  });
  assert.equal(unvouched.status, 409, unvouched.text);
  assert.deepEqual(unvouched.body, { error: GENERIC_409 });
  assert.equal(apple.exchanges.length, before, 'no code exchanged');
  assert.equal((await rowsFor(appleWho.sub)).length, 0, 'no Apple row written');
});

test('A: a password account the provider cannot claim still gets the old sentence', async () => {
  // 'refuse': confirmed for a different address than it now holds.
  const who = person();
  const { rows } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified, verified_email, terms_accepted_at)
     VALUES ($1, 'not-a-real-hash', 'Moved', TRUE, 'someone.else@example.com', NOW()) RETURNING id`,
    [who.email]
  );
  const r = await call('/api/auth/google', { body: { credential: googleToken(who) } });
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(r.body, { error: GENERIC_409 });
  assert.equal((await rowById(rows[0].id)).email, who.email);
});

// ── B. An unconfirmed account with something in it ──────────────────────────

test('B: an empty unconfirmed account is evicted on the first tap, as before', async () => {
  const who = person();
  const old = await passwordAccount(who.email, { confirmed: false });
  const r = await call('/api/auth/google', { body: { credential: googleToken(who) } });
  assert.equal(r.status, 200, r.text);
  assert.notEqual(r.body.user.id, old.id);
  assert.equal(r.body.created, true);
  assert.match((await rowById(old.id)).email, /@unclaimed\.invalid$/);
});

test('B: Google on an unconfirmed account with a friend: warned once, nothing written, then the same credential evicts', async () => {
  const who = person();
  const old = await passwordAccount(who.email, { confirmed: false });
  await befriend(old, await bystander());

  const credential = googleToken(who);
  const first = await call('/api/auth/google', { body: { credential } });
  assert.equal(first.status, 409, first.text);
  assert.deepEqual(first.body, { error: UNCONFIRMED_GOOGLE, unconfirmedAccount: true });
  const kept = await rowById(old.id);
  assert.equal(kept.email, who.email, 'the old account keeps its address');
  assert.equal(kept.token_version, old.token_version, 'and its sessions');
  assert.equal(kept.password, old.password);
  assert.equal((await rowsFor(who.sub)).length, 0, 'no new account');

  // The release half of R4-A1: the very same credential can come back.
  const second = await call('/api/auth/google', { body: { credential } });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.body.created, true);
  assert.notEqual(second.body.user.id, old.id);
  assert.match((await rowById(old.id)).email, /@unclaimed\.invalid$/);
});

test('B: each kind of activity counts, money included; a declined friendship and a NULL is_premium do not', async () => {
  const cases = [
    // Money is the one thing most unconfirmed rows can hold: UNVERIFIED_DENY
    // keeps them out of friends and flocks, and web checkout is not gated.
    // Evicted, the row kept its subscription and nobody could reach it.
    ['Flock Pro', async (u) => {
      await pool.query('UPDATE users SET is_premium = TRUE WHERE id = $1', [u.id]);
    }],
    ['a Stripe customer (a web checkout started)', async (u) => {
      await pool.query('UPDATE users SET stripe_customer_id = $2 WHERE id = $1', [u.id, `cus_test${u.id}`]);
    }],
    ['a pending friend request', async (u) => befriend(await bystander(), u, 'pending')],
    ['a flock membership', async (u) => {
      const f = await pool.query("INSERT INTO flocks (name, creator_id) VALUES ('Plan', $1) RETURNING id", [(await bystander()).id]);
      await pool.query("INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted')", [f.rows[0].id, u.id]);
    }],
    ['a DM received', async (u) => {
      await pool.query("INSERT INTO direct_messages (sender_id, receiver_id, message_text) VALUES ($1, $2, 'hi')", [(await bystander()).id, u.id]);
    }],
    ['a flock message sent', async (u) => {
      const f = await pool.query("INSERT INTO flocks (name, creator_id) VALUES ('Plan', $1) RETURNING id", [(await bystander()).id]);
      await pool.query("INSERT INTO messages (flock_id, sender_id, message_text) VALUES ($1, $2, 'on my way')", [f.rows[0].id, u.id]);
    }],
  ];
  for (const [label, give] of cases) {
    const who = person();
    const old = await passwordAccount(who.email, { confirmed: false });
    await give(old);
    const r = await call('/api/auth/google', { body: { credential: googleToken(who) } });
    assert.equal(r.status, 409, `${label}: ${r.text}`);
    assert.equal(r.body.unconfirmedAccount, true, label);
    assert.equal((await rowById(old.id)).email, who.email, `${label}: the account keeps its address`);
    assert.equal((await rowsFor(who.sub)).length, 0, `${label}: no new account`);
  }
  const nothingToKeep = [
    ['a declined request', async (u) => befriend(await bystander(), u, 'declined')],
    // Migration 001 added is_premium nullable; a NULL is not Pro.
    ['is_premium NULL and no Stripe customer', async (u) => {
      await pool.query('UPDATE users SET is_premium = NULL, stripe_customer_id = NULL WHERE id = $1', [u.id]);
    }],
  ];
  for (const [label, give] of nothingToKeep) {
    const who = person();
    const old = await passwordAccount(who.email, { confirmed: false });
    await give(old);
    const r = await call('/api/auth/google', { body: { credential: googleToken(who) } });
    assert.equal(r.status, 200, `${label} is nothing to keep: ${r.text}`);
    assert.match((await rowById(old.id)).email, /@unclaimed\.invalid$/, label);
  }
});

test('B: a different Google identity is warned again, and so is the same one after ten minutes', async () => {
  const who = person();
  const old = await passwordAccount(who.email, { confirmed: false });
  await befriend(old, await bystander());

  const first = await call('/api/auth/google', { body: { credential: googleToken(who) } });
  assert.equal(first.status, 409, first.text);

  const other = { sub: `other${who.sub}`, email: who.email };
  const otherTap = await call('/api/auth/google', { body: { credential: googleToken(other) } });
  assert.equal(otherTap.status, 409, otherTap.text);
  assert.equal(otherTap.body.unconfirmedAccount, true, 'another identity has not been warned');
  assert.equal((await rowById(old.id)).email, who.email);

  // Ten minutes and a second on the clock the warning reads. google-auth-library
  // reads `new Date()`, not Date.now, so the token's own times are still
  // checked against the real clock.
  // Minted before the clock moves, so its own iat is a real one.
  const lateCredential = googleToken(who);
  const realNow = Date.now;
  Date.now = () => realNow() + authTesting.WARNED_EVICTION_TTL_MS + 1000;
  let late;
  try {
    late = await call('/api/auth/google', { body: { credential: lateCredential } });
  } finally {
    Date.now = realNow;
  }
  assert.equal(late.status, 409, late.text);
  assert.equal(late.body.unconfirmedAccount, true, 'the warning has lapsed');
  assert.equal((await rowById(old.id)).email, who.email);

  // And that late warning is a warning: the next tap evicts.
  const evicts = await call('/api/auth/google', { body: { credential: googleToken(who) } });
  assert.equal(evicts.status, 200, evicts.text);
});

test('B: Apple on an unconfirmed account with a friend: warned once with no code spent, then evicts', async () => {
  const who = person();
  const old = await passwordAccount(who.email, { confirmed: false });
  await befriend(old, await bystander());

  const identityToken = appleToken(who);
  const authorizationCode = appleCode();
  const before = apple.exchanges.length;
  const first = await call('/api/auth/apple', { body: { identityToken, authorizationCode } });
  assert.equal(first.status, 409, first.text);
  assert.deepEqual(first.body, { error: UNCONFIRMED_APPLE, unconfirmedAccount: true });
  assert.equal(apple.exchanges.length, before, 'the single-use code was not spent');
  assert.equal((await rowById(old.id)).email, who.email);
  assert.equal((await rowsFor(who.sub)).length, 0);

  const second = await call('/api/auth/apple', { body: { identityToken, authorizationCode } });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.body.created, true);
  assert.deepEqual(apple.exchanges.slice(before).map((e) => e.code), [authorizationCode]);
  assert.match((await rowById(old.id)).email, /@unclaimed\.invalid$/);
});

// ── C. created: true ─────────────────────────────────────────────────────────

test('C: created is on the sign-in that made the account and on no other', async () => {
  const g = person();
  const gNew = await call('/api/auth/google', { body: { credential: googleToken(g) } });
  assert.equal(gNew.status, 200, gNew.text);
  assert.equal(gNew.body.created, true);
  const gAgain = await call('/api/auth/google', { body: { credential: googleToken(g) } });
  assert.equal(gAgain.status, 200, gAgain.text);
  assert.equal('created' in gAgain.body, false);

  const a = person();
  const aNew = await call('/api/auth/apple', { body: { identityToken: appleToken(a), authorizationCode: appleCode() } });
  assert.equal(aNew.status, 200, aNew.text);
  assert.equal(aNew.body.created, true);
  const aAgain = await call('/api/auth/apple', { body: { identityToken: appleToken(a, { email: undefined }), authorizationCode: appleCode() } });
  assert.equal(aAgain.status, 200, aAgain.text);
  assert.equal(aAgain.body.user.id, aNew.body.user.id);
  assert.equal('created' in aAgain.body, false);

  // A claim hands over a row that was already there.
  const gc = person();
  const gRow = await passwordAccount(gc.email, { confirmed: true });
  const gClaim = await call('/api/auth/google', { body: { credential: googleToken(gc) } });
  assert.equal(gClaim.status, 200, gClaim.text);
  assert.equal(gClaim.body.user.id, gRow.id);
  assert.equal('created' in gClaim.body, false);

  const ac = person();
  const aRow = await passwordAccount(ac.email, { confirmed: true });
  const aClaim = await call('/api/auth/apple', { body: { identityToken: appleToken(ac), authorizationCode: appleCode() } });
  assert.equal(aClaim.status, 200, aClaim.text);
  assert.equal(aClaim.body.user.id, aRow.id);
  assert.equal('created' in aClaim.body, false);
});

// ── D. intent ────────────────────────────────────────────────────────────────

const NO_GOOGLE_ACCOUNT = { error: 'No Flock account uses this Google account yet.', noAccount: true, canCreate: true };
const NO_APPLE_ACCOUNT = { error: 'No Flock account uses this Apple ID yet.', noAccount: true, canCreate: true };

test("D: Google intent 'signin' with no account writes nothing, and the same credential then creates with 'create'", async () => {
  const who = person();
  const credential = googleToken(who);
  const refused = await call('/api/auth/google', { body: { credential, intent: 'signin' } });
  assert.equal(refused.status, 409, refused.text);
  assert.deepEqual(refused.body, NO_GOOGLE_ACCOUNT);
  assert.equal((await rowsFor(who.sub)).length, 0, 'nothing written');

  const made = await call('/api/auth/google', { body: { credential, intent: 'create' } });
  assert.equal(made.status, 200, made.text);
  assert.equal(made.body.created, true);
});

test("D: Google intent 'signin' on an existing account is the plain sign-in", async () => {
  const who = person();
  const made = await call('/api/auth/google', { body: { credential: googleToken(who) } });
  assert.equal(made.status, 200, made.text);
  const r = await call('/api/auth/google', { body: { credential: googleToken(who), intent: 'signin' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.user.id, made.body.user.id);
  assert.equal('created' in r.body, false);
});

test("D: on the website, 'signin' answers before the year question and the under-13 check, and spends no nonce", async () => {
  const who = person();
  const web = { app: false };
  const issued = await call('/api/auth/google/nonce', web);
  const { nonce } = issued.body;
  const credential = googleToken(who, { azp: process.env.GOOGLE_CLIENT_ID, nonce });

  const noDob = await call('/api/auth/google', { ...web, body: { credential, nonce, intent: 'signin' } });
  assert.equal(noDob.status, 409, noDob.text);
  assert.deepEqual(noDob.body, NO_GOOGLE_ACCOUNT);

  const young = `${new Date().getUTCFullYear() - 8}-12-31`;
  const underage = await call('/api/auth/google', { ...web, body: { credential, nonce, intent: 'signin', date_of_birth: young } });
  assert.equal(underage.status, 409, underage.text);
  assert.deepEqual(underage.body, NO_GOOGLE_ACCOUNT);

  const made = await call('/api/auth/google', { ...web, body: { credential, nonce, intent: 'create', date_of_birth: '1999-12-31' } });
  assert.equal(made.status, 200, made.text);
  assert.equal(made.body.created, true);
});

test("D: 'signin' answers before the unconfirmed-account warning, and leaves no warning behind", async () => {
  const who = person();
  const old = await passwordAccount(who.email, { confirmed: false });
  await befriend(old, await bystander());

  const refused = await call('/api/auth/google', { body: { credential: googleToken(who), intent: 'signin' } });
  assert.equal(refused.status, 409, refused.text);
  assert.deepEqual(refused.body, NO_GOOGLE_ACCOUNT);
  // Had the refusal recorded a warning, this tap would evict.
  const next = await call('/api/auth/google', { body: { credential: googleToken(who), intent: 'create' } });
  assert.equal(next.status, 409, next.text);
  assert.equal(next.body.unconfirmedAccount, true);
  assert.equal((await rowById(old.id)).email, who.email);
});

test('D: any other intent, of any type, is read as absent', async () => {
  for (const intent of ['SIGNIN', 'login', '', 1, true, ['signin'], { v: 'signin' }, null]) {
    const who = person();
    const r = await call('/api/auth/google', { body: { credential: googleToken(who), intent } });
    assert.equal(r.status, 200, `${JSON.stringify(intent)}: ${r.text}`);
    assert.equal(r.body.created, true);
  }
});

test("D: Apple intent 'signin' with no account writes nothing and spends no code; the same credential then creates", async () => {
  const who = person();
  const identityToken = appleToken(who);
  const authorizationCode = appleCode();
  const before = apple.exchanges.length;
  const refused = await call('/api/auth/apple', { body: { identityToken, authorizationCode, intent: 'signin' } });
  assert.equal(refused.status, 409, refused.text);
  assert.deepEqual(refused.body, NO_APPLE_ACCOUNT);
  assert.equal(apple.exchanges.length, before, 'the code exchange did not run');
  assert.equal((await rowsFor(who.sub)).length, 0, 'nothing written');

  const made = await call('/api/auth/apple', { body: { identityToken, authorizationCode, intent: 'create' } });
  assert.equal(made.status, 200, made.text);
  assert.equal(made.body.created, true);
  assert.deepEqual(apple.exchanges.slice(before).map((e) => e.code), [authorizationCode]);

  const again = await call('/api/auth/apple', { body: { identityToken: appleToken(who), authorizationCode: appleCode(), intent: 'signin' } });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.user.id, made.body.user.id);
  assert.equal('created' in again.body, false);
});

// ── E. Build 53's Confirm-it's-you ───────────────────────────────────────────

test("E: the token a Google sign-in spent is accepted again as a reconfirm with that account's own session", async () => {
  const who = person();
  const credential = googleToken(who);
  const signIn = await call('/api/auth/google', { body: { credential } });
  assert.equal(signIn.status, 200, signIn.text);
  const session = signIn.body.token;

  // Build 53 sends the stored session on every call, this one included.
  const confirmed = await call('/api/auth/google', { session, body: { credential, reconfirm: true } });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.equal(confirmed.body.user.id, signIn.body.user.id);
  assert.ok(confirmed.body.token);
  assert.equal('created' in confirmed.body, false);

  // And the credential is still spent for everything else.
  const plainReplay = await call('/api/auth/google', { session, body: { credential } });
  assert.equal(plainReplay.status, 401, plainReplay.text);
  const noSession = await call('/api/auth/google', { body: { credential, reconfirm: true } });
  assert.equal(noSession.status, 401, noSession.text);
});

test('E: a re-sent token is refused with no session, a stranger\'s session, a revoked one, or outside a reconfirm', async () => {
  const who = person();
  const credential = googleToken(who);
  const signIn = await call('/api/auth/google', { body: { credential } });
  assert.equal(signIn.status, 200, signIn.text);

  const stranger = person();
  const strangerIn = await call('/api/auth/google', { body: { credential: googleToken(stranger) } });
  assert.equal(strangerIn.status, 200, strangerIn.text);

  const cases = [
    ['no session', { body: { credential, reconfirm: true } }],
    ["another account's session", { session: strangerIn.body.token, body: { credential, reconfirm: true } }],
    ['not a reconfirm', { session: signIn.body.token, body: { credential } }],
    ['reconfirm as a string', { session: signIn.body.token, body: { credential, reconfirm: 'true' } }],
    ['a forged session', {
      session: jwt.sign({ userId: signIn.body.user.id, tv: 0 }, 'not-the-secret'),
      body: { credential, reconfirm: true },
    }],
    ['an expired session', {
      session: jwt.sign({ userId: signIn.body.user.id, tv: 0, iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 }, process.env.JWT_SECRET),
      body: { credential, reconfirm: true },
    }],
  ];
  for (const [label, opts] of cases) {
    const r = await call('/api/auth/google', opts);
    assert.equal(r.status, 401, `${label}: ${r.text}`);
  }

  // A session revoked by a token_version bump.
  await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [signIn.body.user.id]);
  const revoked = await call('/api/auth/google', { session: signIn.body.token, body: { credential, reconfirm: true } });
  assert.equal(revoked.status, 401, revoked.text);
});

test('E: an Apple account whose Apple subject spells the Google one does not unlock it', async () => {
  // Two providers' subjects live in one oauth_id column, so the provider is
  // compared as well as the subject.
  const shared = person();
  const appleIn = await call('/api/auth/apple', {
    body: { identityToken: appleToken({ sub: shared.sub, email: `apple.${shared.email}` }), authorizationCode: appleCode() },
  });
  assert.equal(appleIn.status, 200, appleIn.text);
  const credential = googleToken(shared);
  const googleIn = await call('/api/auth/google', { body: { credential } });
  assert.equal(googleIn.status, 200, googleIn.text);
  assert.notEqual(googleIn.body.user.id, appleIn.body.user.id);

  const r = await call('/api/auth/google', { session: appleIn.body.token, body: { credential, reconfirm: true } });
  assert.equal(r.status, 401, r.text);
});

test("E: an account's own session does not unlock another Google identity's spent token", async () => {
  const who = person();
  const signIn = await call('/api/auth/google', { body: { credential: googleToken(who) } });
  assert.equal(signIn.status, 200, signIn.text);

  const other = person();
  const otherCredential = googleToken(other);
  const otherIn = await call('/api/auth/google', { body: { credential: otherCredential } });
  assert.equal(otherIn.status, 200, otherIn.text);

  const r = await call('/api/auth/google', { session: signIn.body.token, body: { credential: otherCredential, reconfirm: true } });
  assert.equal(r.status, 401, r.text);
});

// ── F. "Confirm it's you" with a provider account no Flock account uses ──────
//
// The delete and export dialogs (frontend OAuthReconfirm.js) send reconfirm:
// true and hold one provider's button. Picking a Google account or Apple ID
// there that no Flock account signs in with is answered noAccount, which the
// dialog turns into "That Google account is not the one this Flock account
// uses". It used to go on to the address lookup first, so an address another
// provider's account holds was answered with which button opens THAT account
// (a button the dialog does not have, for an account nobody is confirming),
// and an address a confirmed password account holds was CLAIMED: converted to
// the picked provider, its password cleared, inside a confirmation.

const RECONFIRM_NO_GOOGLE = { error: 'No Flock account uses this Google account.', noAccount: true };
const RECONFIRM_NO_APPLE = { error: 'No Flock account uses this Apple ID.', noAccount: true };

// The account being deleted or exported, signed in with `provider`; its
// session is on the phone and goes with the reconfirm, as build 53 sends it.
async function signedInWith(provider) {
  const who = person();
  const r = provider === 'apple'
    ? await call('/api/auth/apple', { body: { identityToken: appleToken(who), authorizationCode: appleCode() } })
    : await call('/api/auth/google', { body: { credential: googleToken(who) } });
  assert.equal(r.status, 200, r.text);
  return r.body.token;
}

// A confirmed password account, which a sign-in on its address would claim,
// read back after the reconfirm: exactly as it was.
async function assertUntouched(row) {
  const after = await rowById(row.id);
  assert.equal(after.oauth_provider, null, 'not converted');
  assert.equal(after.password, row.password, 'its password kept');
  assert.equal(after.token_version, row.token_version, 'its sessions kept');
}

test('F: Google reconfirm on an address an Apple account holds is noAccount, not "Tap Continue with Apple"', async () => {
  const session = await signedInWith('google');
  // The same person's other account, made with Apple on address B, and
  // Google's chooser hands back the Google account on B.
  const b = person();
  const other = await call('/api/auth/apple', { body: { identityToken: appleToken(b), authorizationCode: appleCode() } });
  assert.equal(other.status, 200, other.text);
  const picked = { sub: `g${b.sub}`, email: b.email };
  const r = await call('/api/auth/google', { session, body: { credential: googleToken(picked), reconfirm: true } });
  assert.equal(r.status, 403, r.text);
  assert.deepEqual(r.body, RECONFIRM_NO_GOOGLE);
  assert.equal((await rowsFor(picked.sub)).length, 0, 'no Google row written');
});

test('F: Google reconfirm on an address a confirmed password account holds is noAccount, and claims nothing', async () => {
  const session = await signedInWith('google');
  const z = person();
  const zRow = await passwordAccount(z.email, { confirmed: true });
  const r = await call('/api/auth/google', { session, body: { credential: googleToken(z), reconfirm: true } });
  assert.equal(r.status, 403, r.text);
  assert.deepEqual(r.body, RECONFIRM_NO_GOOGLE);
  await assertUntouched(zRow);
  assert.equal((await rowsFor(z.sub)).length, 0);
});

test('F: Apple reconfirm on an address a Google account holds is noAccount, not "Tap Continue with Google", and spends no code', async () => {
  const session = await signedInWith('apple');
  const b = person();
  const other = await call('/api/auth/google', { body: { credential: googleToken(b) } });
  assert.equal(other.status, 200, other.text);
  const picked = { sub: `a${b.sub}`, email: b.email };
  const before = apple.exchanges.length;
  const r = await call('/api/auth/apple', {
    session, body: { identityToken: appleToken(picked), authorizationCode: appleCode(), reconfirm: true },
  });
  assert.equal(r.status, 403, r.text);
  assert.deepEqual(r.body, RECONFIRM_NO_APPLE);
  assert.equal((await rowsFor(picked.sub)).length, 0, 'no Apple row written');
  assert.equal(apple.exchanges.length, before, 'no code exchanged');
});

test('F: Apple reconfirm on an address a confirmed password account holds is noAccount, claims nothing and spends no code', async () => {
  const session = await signedInWith('apple');
  const z = person();
  const zRow = await passwordAccount(z.email, { confirmed: true });
  const before = apple.exchanges.length;
  const r = await call('/api/auth/apple', {
    session, body: { identityToken: appleToken(z), authorizationCode: appleCode(), reconfirm: true },
  });
  assert.equal(r.status, 403, r.text);
  assert.deepEqual(r.body, RECONFIRM_NO_APPLE);
  await assertUntouched(zRow);
  assert.equal(apple.exchanges.length, before, 'no code exchanged');
});
