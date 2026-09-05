// Run: node --test __tests__/signInMethodAndSignupRace.test.js  (from backend/)
//
// ---------------------------------------------------------------------------
// Two first-session defects in routes/auth.js, traced 2026-09-04.
// ---------------------------------------------------------------------------
// 1. THE SIGN-IN RESPONSES DID NOT SAY HOW THE ACCOUNT SIGNS IN.
//    GET /me derives `sign_in_method` from oauth_provider, and the edit-profile
//    form and the export and delete sheets read that field to decide whether
//    to demand a password. The three sign-in responses (/login, /google,
//    /apple) never carried it, so an account that had just signed in was read
//    as a password account until the next cold start refetched /me. For an
//    Apple or Google account that meant a whole first session in which no
//    profile edit could be saved, because the form demanded a password the
//    account has never had. A reviewer's first session is exactly that one.
//
// 2. TWO SIGNUPS FOR ONE ADDRESS AT THE SAME MOMENT ANSWERED 500.
//    /signup checks for an existing row and then inserts. Both requests pass
//    the check, one INSERT wins, and users.email is UNIQUE, so the loser gets
//    Postgres 23505 in the catch, which reported it as "Failed to create
//    account". The answer the check itself gives is "Email already
//    registered", and that is what the loser should hear.
//
// Both are driven through the real router. The provider verifiers are the
// same stand-ins __tests__/oauthReplayCanonical.test.js installs: Apple's
// JWKS answers with a test key and the route runs the real jsonwebtoken
// verification against it; Google's verifier checks the signature and the
// audience the way google-auth-library does.
// ---------------------------------------------------------------------------

process.env.JWT_SECRET = 'sign-in-method-secret';
process.env.GOOGLE_CLIENT_ID = 'flock-sign-in-method.apps.googleusercontent.com';
process.env.APPLE_BUNDLE_ID = 'com.flockcorp.flock';
process.env.PUBLIC_WEB_URL = 'http://localhost:3000';
process.env.PUBLIC_API_URL = 'http://localhost:5000';
delete process.env.RESEND_API_KEY;
delete process.env.APPLE_REQUIRE_NONCE;
delete process.env.GOOGLE_REQUIRE_NONCE;
delete process.env.NODE_ENV;

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const { publicKey: PROVIDER_PUB, privateKey: PROVIDER_PRIV } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const jwksPath = require.resolve('jwks-rsa');
require.cache[jwksPath] = {
  id: jwksPath, filename: jwksPath, loaded: true,
  exports: () => ({ getSigningKey: (_kid, cb) => cb(null, { getPublicKey: () => PROVIDER_PUB }) }),
};

const appleAuthPath = require.resolve('../services/appleAuth');
require.cache[appleAuthPath] = {
  id: appleAuthPath, filename: appleAuthPath, loaded: true,
  exports: {
    isConfigured: () => false,
    exchangeAppleCode: async () => ({}),
    revokeAppleToken: async () => true,
  },
};

const googleLibPath = require.resolve('google-auth-library');
require.cache[googleLibPath] = {
  id: googleLibPath, filename: googleLibPath, loaded: true,
  exports: {
    OAuth2Client: class {
      async verifyIdToken({ idToken, audience }) {
        const payload = jwt.verify(idToken, PROVIDER_PUB, {
          algorithms: ['RS256'],
          audience,
          issuer: 'https://accounts.google.com',
        });
        return { getPayload: () => payload };
      }
    },
  },
};

const pool = require('../config/database');
const authRouter = require('../routes/auth');
const { canonicalEmail } = authRouter.__testing;

let subSeq = 0;
function googleToken(claims = {}) {
  subSeq += 1;
  return jwt.sign({
    iss: 'https://accounts.google.com',
    aud: process.env.GOOGLE_CLIENT_ID,
    azp: process.env.GOOGLE_CLIENT_ID,
    sub: `g-${subSeq}`,
    email: `g${subSeq}@gmail.com`,
    email_verified: true,
    name: 'Ava',
    ...claims,
  }, PROVIDER_PRIV, { algorithm: 'RS256', expiresIn: '1h', keyid: 'g-kid' });
}

function appleToken(claims = {}) {
  subSeq += 1;
  return jwt.sign({
    iss: 'https://appleid.apple.com',
    aud: process.env.APPLE_BUNDLE_ID,
    sub: `a-${subSeq}`,
    email: `a${subSeq}@icloud.com`,
    email_verified: true,
    ...claims,
  }, PROVIDER_PRIV, { algorithm: 'RS256', expiresIn: '10m', keyid: 'a-kid' });
}

// ---------------------------------------------------------------------------
// In-memory users table. Strict: a statement nothing below expects throws, so
// a route that starts issuing new SQL fails here instead of passing on an
// empty answer.
// ---------------------------------------------------------------------------
const PASSWORD = 'CorrectHorse1!';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

let users = [];
let nextUserId = 1;
// When set, the next INSERT INTO users raises it instead of writing a row.
let insertRaises = null;

const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();

  if (/oauth_provider = 'google' AND oauth_id/.test(sql)) {
    return { rows: users.filter((u) => u.oauth_provider === 'google' && u.oauth_id === params[0]) };
  }
  if (/oauth_provider = 'apple' AND oauth_id/.test(sql)) {
    return { rows: users.filter((u) => u.oauth_provider === 'apple' && u.oauth_id === params[0]) };
  }
  if (sql.startsWith('SELECT * FROM users') && /split_part/.test(sql)) {
    const hit = users.find((u) => canonicalEmail(u.email) === canonicalEmail(params[0])) || null;
    return { rows: hit ? [hit] : [] };
  }
  if (sql.startsWith('SELECT * FROM users WHERE LOWER(email) = LOWER($1)')) {
    const hit = users.find((u) => u.email.toLowerCase() === String(params[0]).toLowerCase()) || null;
    return { rows: hit ? [hit] : [] };
  }
  if (sql.startsWith('INSERT INTO users')) {
    if (insertRaises) {
      const err = insertRaises;
      insertRaises = null;
      throw err;
    }
    let row;
    if (/'google'/.test(sql)) {
      row = {
        id: nextUserId++, token_version: 0, is_banned: false, password: null,
        email: params[0], name: params[1], oauth_provider: 'google', oauth_id: params[2],
        profile_image_url: params[3], date_of_birth: params[4],
        email_verified: true, verified_email: params[5],
      };
    } else if (/'apple'/.test(sql)) {
      row = {
        id: nextUserId++, token_version: 0, is_banned: false, password: null,
        email: params[0], name: params[1], oauth_provider: 'apple', oauth_id: params[2],
        apple_refresh_token: null, date_of_birth: params[3],
        email_verified: true, verified_email: params[4],
      };
    } else {
      row = {
        id: nextUserId++, token_version: 0, is_banned: false,
        email: params[0], password: params[1], name: params[2], interests: params[3],
        oauth_provider: null, oauth_id: null, date_of_birth: params[4], email_verified: false,
      };
    }
    users.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith('SELECT 1 FROM banned_identities')) return { rows: [] };
  if (sql.startsWith('DELETE FROM banned_identities')) return { rows: [], rowCount: 0 };
  if (/waitlist/i.test(sql)) return { rows: [], rowCount: 0 };
  if (/email_verifications/i.test(sql)) return { rows: [], rowCount: 0 };

  throw new Error(`unstubbed query: ${sql.slice(0, 140)}`);
};

const app = express();
app.use(express.json());
app.set('io', { in: () => ({ disconnectSockets: () => {} }) });
app.use('/api/auth', authRouter);

const server = app.listen(0);
const base = () => `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); pool.query = realQuery; });

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(`${base()}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({
        status: res.statusCode,
        json: () => (data ? JSON.parse(data) : {}),
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function reset() {
  users = [];
  nextUserId = 1;
  insertRaises = null;
}

const DOB = { date_of_birth: '2000-01-01' };

// ===========================================================================
// 1. sign_in_method on every sign-in response
// ===========================================================================

test('POST /login answers sign_in_method "password" for a password account', async () => {
  reset();
  users.push({
    id: nextUserId++, token_version: 0, is_banned: false,
    email: 'sam@example.com', password: PASSWORD_HASH, name: 'Sam',
    oauth_provider: null, oauth_id: null, date_of_birth: '2000-01-01', email_verified: true,
  });
  const res = await post('/api/auth/login', { email: 'sam@example.com', password: PASSWORD });
  assert.strictEqual(res.status, 200);
  const body = res.json();
  assert.strictEqual(body.user.sign_in_method, 'password',
    'the /login response must say how the account signs in, the way GET /me does');
  assert.strictEqual('password' in body.user, false, 'the hash must still be stripped');
});

test('POST /google answers sign_in_method "google" on the session that created the account', async () => {
  reset();
  const res = await post('/api/auth/google', { credential: googleToken(), ...DOB });
  assert.strictEqual(res.status, 200, JSON.stringify(res.json()));
  assert.strictEqual(res.json().user.sign_in_method, 'google',
    'without this the edit-profile form demands a password from a Google account for its whole first session');
});

test('POST /apple answers sign_in_method "apple" on the session that created the account', async () => {
  reset();
  const res = await post('/api/auth/apple', {
    identityToken: appleToken(), fullName: { givenName: 'Ava', familyName: 'Lee' }, ...DOB,
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.json()));
  assert.strictEqual(res.json().user.sign_in_method, 'apple',
    'without this the edit-profile form demands a password from an Apple account for its whole first session');
});

test('the three responses derive the field the way GET /me does, from the same source line', () => {
  // The derivation is pinned as text so the four sites cannot drift apart:
  // /me is the one the sheets were written against, and the three sign-in
  // responses now say the same thing the same way.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  const me = src.match(/user\.sign_in_method = provider \|\| 'password';/g) || [];
  const signIns = src.match(/safeUser\.sign_in_method = user\.oauth_provider \|\| 'password';/g) || [];
  assert.strictEqual(me.length, 1, 'GET /me derives sign_in_method once');
  assert.strictEqual(signIns.length, 3, '/login, /google and /apple each set sign_in_method on their response');
});

// ===========================================================================
// 2. the signup race
// ===========================================================================

test('a signup that loses the race to an identical address is told the address is taken, not that the server failed', async () => {
  reset();
  // The existence check sees nothing (the winner has not committed yet), and
  // the INSERT then hits the UNIQUE constraint the winner just satisfied.
  insertRaises = Object.assign(
    new Error('duplicate key value violates unique constraint "users_email_key"'),
    { code: '23505', constraint: 'users_email_key' }
  );
  const res = await post('/api/auth/signup', {
    name: 'Sam', email: 'race@example.com', password: PASSWORD, ...DOB,
  });
  assert.strictEqual(res.status, 400, JSON.stringify(res.json()));
  assert.strictEqual(res.json().error, 'Email already registered',
    'the loser must hear exactly what the pre-check would have said');
});

test('every other failure inside the signup transaction is still a 500', async () => {
  reset();
  insertRaises = Object.assign(new Error('connection terminated'), { code: '57P01' });
  const res = await post('/api/auth/signup', {
    name: 'Sam', email: 'other@example.com', password: PASSWORD, ...DOB,
  });
  assert.strictEqual(res.status, 500);
  assert.strictEqual(res.json().error, 'Failed to create account');
});
