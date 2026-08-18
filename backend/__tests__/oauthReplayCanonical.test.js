// Run: node --test  (from backend/)
//
// SECURITY-AUDIT-auth.md round 3, R3-A2 and R3-A1: the OAuth replay cache did
// not actually stop a replay.
//
//   R3-A2 — the cache keyed on SHA-256 of the token STRING, and a JWT's wire
//   string is not a canonical encoding of the credential. An RS256 signature is
//   256 bytes; its base64url segment is 342 characters carrying 2,052 bits, of
//   which 2,048 are used, so the FINAL character has 4 bits nothing decodes:
//   SIXTEEN characters produce the identical signature. google-auth-library and
//   jsonwebtoken accept all 16, all 16 satisfy the Google path's shape regex,
//   and all 16 hash differently — so one captured credential minted 16 accepted
//   sign-ins on BOTH providers. Each one is a fresh Flock JWT with a fresh
//   `iat`, and a fresh `iat` is the entire sudo-mode proof for an OAuth account
//   (hasFreshSession in routes/users.js): account deletion, the phone-number
//   change and the full data export are all reachable from every one of them.
//
//   R3-A1 — the retention was capped at 15 minutes, carried over from when this
//   cache was Apple-only. A Google ID token is accepted for ~65 minutes (`exp`
//   at iat+3600, plus google-auth-library's 300 s clock skew), so the same
//   UNMODIFIED credential became replayable again after a 15-minute wait and
//   stayed replayable for the remaining ~50.
//
// Round 2's replay test passed the whole time the bug was live, because it
// replayed the byte-identical string. This file mints REAL RS256 tokens with a
// keypair generated here and drives the actual encoding attack: the signature
// is re-spelled, and the variant is verified to still pass signature
// verification before it is posted, so a green result means the route refused a
// credential that would otherwise have authenticated.
//
// No database. pool.query is a dispatcher over in-memory rows.

// Env must be set before ANY require.
process.env.JWT_SECRET = 'oauth-replay-canonical-secret';
process.env.GOOGLE_CLIENT_ID = 'flock-canonical.apps.googleusercontent.com';
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

// ---------------------------------------------------------------------------
// One RSA keypair, standing in for both providers' signing keys.
// ---------------------------------------------------------------------------
const { publicKey: PROVIDER_PUB, privateKey: PROVIDER_PRIV } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Apple's JWKS — routes/auth.js runs the REAL jsonwebtoken verification against
// whatever this returns, so the Apple path here is the production code path.
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

// Google's verifier. NOT a lookup table keyed on the token string — that is
// exactly the assumption the finding breaks. It does what google-auth-library
// does: verify the signature and the audience, and hand back the claims. Round
// 3 measured that library's `verify` and jsonwebtoken's accepting the same 15
// alternate encodings, so this stand-in accepts a re-spelled token for the same
// reason the real one does, rather than because a fake was told to.
let verifyCalls = 0;
const googleLibPath = require.resolve('google-auth-library');
require.cache[googleLibPath] = {
  id: googleLibPath, filename: googleLibPath, loaded: true,
  exports: {
    OAuth2Client: class {
      async verifyIdToken({ idToken, audience }) {
        verifyCalls += 1;
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
const {
  oauthIdentityKey, oauthIdentityWasUsed, markOauthIdentityUsed,
  canonicalJwtSignature, OAUTH_REPLAY_MAX_TTL_MS, OAUTH_VERIFIER_SKEW_MS,
  appleTokenWasUsed, markAppleTokenUsed, oauthTokenWasUsed, markOauthTokenUsed,
  canonicalEmail,
} = authRouter.__testing;

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// The other 15 spellings of one RS256 signature. The last character of the
// 342-character segment carries 2 used bits and 4 unused ones, so its 4-bit
// equivalence class is the 16 alphabet positions that share its top 2 bits.
function reencodeSignature(token) {
  const [header, payload, signature] = token.split('.');
  const index = BASE64URL.indexOf(signature[signature.length - 1]);
  assert.notStrictEqual(index, -1, 'signature segment is not base64url');
  const base = index & ~0x0f;
  const out = [];
  for (let i = base; i < base + 16; i += 1) {
    if (i === index) continue;
    out.push(`${header}.${payload}.${signature.slice(0, -1)}${BASE64URL[i]}`);
  }
  return out;
}

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
// In-memory users table
// ---------------------------------------------------------------------------
let users = [];
let nextUserId = 1;
let statements = [];

const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  statements.push(sql);

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
  if (sql.startsWith('INSERT INTO users')) {
    const google = /'google'/.test(sql);
    const row = google
      ? {
        id: nextUserId++, token_version: 0, is_banned: false, password: null,
        email: params[0], name: params[1], oauth_provider: 'google', oauth_id: params[2],
        profile_image_url: params[3], date_of_birth: params[4],
        email_verified: true, verified_email: params[5],
      }
      : {
        id: nextUserId++, token_version: 0, is_banned: false, password: null,
        email: params[0], name: params[1], oauth_provider: 'apple', oauth_id: params[2],
        apple_refresh_token: null, date_of_birth: params[3],
        email_verified: true, verified_email: params[4],
      };
    users.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith('SELECT 1 FROM banned_identities')) return { rows: [] };
  if (sql.startsWith('DELETE FROM banned_identities')) return { rows: [], rowCount: 0 };
  if (sql.startsWith('UPDATE users SET date_of_birth')) {
    const row = users.find((u) => u.id === params[1]);
    if (row) row.date_of_birth = params[0];
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }

  throw new Error(`unstubbed query: ${sql.slice(0, 140)}`);
};

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
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
  statements = [];
  verifyCalls = 0;
}

const DOB = { date_of_birth: '2000-01-01' };

// ===========================================================================
// The attack itself
// ===========================================================================

test('R3-A2: the 16 spellings are real — every variant still verifies', () => {
  const token = googleToken();
  const variants = reencodeSignature(token);
  assert.strictEqual(variants.length, 15, 'an RS256 signature has 16 equivalent spellings');
  const shape = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  const original = Buffer.from(token.split('.')[2], 'base64url');
  const hashes = new Set([crypto.createHash('sha256').update(token).digest('hex')]);

  for (const variant of variants) {
    assert.notStrictEqual(variant, token);
    assert.ok(shape.test(variant), 'the shape regex does not stop a re-spelled signature');
    assert.ok(Buffer.from(variant.split('.')[2], 'base64url').equals(original),
      'the re-spelled segment must decode to the identical signature');
    // The whole point: the provider libraries accept it.
    jwt.verify(variant, PROVIDER_PUB, { algorithms: ['RS256'] });
    hashes.add(crypto.createHash('sha256').update(variant).digest('hex'));
  }
  assert.strictEqual(hashes.size, 16,
    'all 16 hash differently — which is why a string-keyed cache missed every replay');

  // And the key the route uses collapses all 16 onto one value.
  assert.strictEqual(new Set([token, ...variants].map(canonicalJwtSignature)).size, 1,
    'the canonical signature must be identical for all 16 spellings');
});

test('R3-A2: a re-spelled Google credential is refused', async () => {
  reset();
  const credential = googleToken({ sub: 'g-victim', email: 'victim@gmail.com' });

  const first = await post('/api/auth/google', { credential, ...DOB });
  assert.strictEqual(first.status, 200, JSON.stringify(first.json()));
  const victimId = first.json().user.id;

  // Every one of the other 15 spellings is the SAME credential. Against the
  // string-keyed cache each of these returned 200 with a fresh `iat`.
  for (const variant of reencodeSignature(credential)) {
    const replay = await post('/api/auth/google', { credential: variant, ...DOB });
    assert.strictEqual(replay.status, 401, 're-spelled credential was accepted');
    assert.strictEqual(replay.json().token, undefined, 'a replay must not mint a session');
  }
  assert.strictEqual(users.length, 1, 'no extra account was created');
  assert.strictEqual(users[0].id, victimId);
});

test('R3-A2: a re-spelled Apple identity token is refused', async () => {
  reset();
  const identityToken = appleToken({ sub: 'a-victim', email: 'victim@icloud.com' });

  const first = await post('/api/auth/apple', { identityToken, ...DOB });
  assert.strictEqual(first.status, 200, JSON.stringify(first.json()));

  for (const variant of reencodeSignature(identityToken)) {
    const replay = await post('/api/auth/apple', { identityToken: variant, ...DOB });
    assert.strictEqual(replay.status, 401, 're-spelled identity token was accepted');
    assert.strictEqual(replay.json().token, undefined, 'a replay must not mint a session');
  }
  assert.strictEqual(users.length, 1);
});

test('R3-A2: both providers are covered by the same mechanism, keyed apart', async () => {
  reset();
  // Same `sub`, same `iat`, same signature bytes are impossible across
  // providers, but the key is namespaced anyway so the two paths can never
  // collide as they share one map.
  const claims = { sub: 'shared-sub', iat: 1700000000, exp: 1700003600, aud: 'x' };
  const raw = `${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(342)}`;
  assert.notStrictEqual(
    oauthIdentityKey('google', claims, raw),
    oauthIdentityKey('apple', claims, raw),
    'the shared map must not let one provider spend the other provider\'s token'
  );

  // The exported aliases other suites name are the same two functions, so a
  // token recorded through the Apple names is refused through the Google ones.
  const key = oauthIdentityKey('apple', claims, raw);
  assert.strictEqual(appleTokenWasUsed, oauthIdentityWasUsed);
  assert.strictEqual(markAppleTokenUsed, markOauthIdentityUsed);
  assert.strictEqual(oauthTokenWasUsed, oauthIdentityWasUsed);
  assert.strictEqual(markOauthTokenUsed, markOauthIdentityUsed);
  markAppleTokenUsed(key, Math.floor(Date.now() / 1000) + 600);
  assert.ok(oauthTokenWasUsed(key), 'one cache, both providers');
});

// ===========================================================================
// R3-A1 — the entry has to outlive the credential
// ===========================================================================

test('R3-A1: an entry outlives the token\'s FULL acceptance window', () => {
  // Google's window: exp = iat + 3600, and google-auth-library accepts until
  // exp + CLOCK_SKEW_SECS_ (300). ~65 minutes, against a 15-minute cache.
  const now = Date.now();
  const exp = Math.floor(now / 1000) + 3600;
  const raw = `${'a'.repeat(20)}.${'b'.repeat(20)}.${'d'.repeat(342)}`;
  const key = oauthIdentityKey('google', { sub: 'g-ttl', iat: exp - 3600, exp }, raw);

  markOauthIdentityUsed(key, exp, now);

  const OLD_CAP = 15 * 60 * 1000;
  assert.ok(oauthIdentityWasUsed(key, now + OLD_CAP + 1000),
    'the entry lapsed at the old 15-minute cap, which is R3-A1 exactly');

  const lastAccepted = exp * 1000 + OAUTH_VERIFIER_SKEW_MS;
  assert.ok(oauthIdentityWasUsed(key, lastAccepted),
    'the entry must still exist at the last instant the verifier accepts the token');
  assert.ok(!oauthIdentityWasUsed(key, lastAccepted + 1),
    'past its acceptance window the token is refused by the verifier, so the entry may go');

  // Apple's ~10 minutes are covered by the same derivation, and short tokens
  // are not held for 70 minutes just because the cap allows it.
  const appleExp = Math.floor(now / 1000) + 600;
  const appleKey = oauthIdentityKey('apple', { sub: 'a-ttl', exp: appleExp }, raw);
  markOauthIdentityUsed(appleKey, appleExp, now);
  assert.ok(oauthIdentityWasUsed(appleKey, appleExp * 1000 + OAUTH_VERIFIER_SKEW_MS));
  assert.ok(!oauthIdentityWasUsed(appleKey, appleExp * 1000 + OAUTH_VERIFIER_SKEW_MS + 1));

  // The backstop for a token with no usable `exp` must cover the longest
  // window either provider has: Google's 60 minutes + 5 minutes of skew.
  assert.ok(OAUTH_REPLAY_MAX_TTL_MS >= 65 * 60 * 1000,
    `the cap is ${OAUTH_REPLAY_MAX_TTL_MS} ms, shorter than Google's ~65-minute acceptance window`);
  const noExpKey = oauthIdentityKey('google', { sub: 'g-noexp' }, raw);
  markOauthIdentityUsed(noExpKey, undefined, now);
  assert.ok(oauthIdentityWasUsed(noExpKey, now + 65 * 60 * 1000));
});

test('R3-A1: a Google credential is still refused an hour into its life', async () => {
  reset();
  // Driven over HTTP with a token whose `exp` is an hour out, then checked
  // through the cache at the moment the old cap would have dropped it.
  const credential = googleToken({ sub: 'g-hour', email: 'hour@gmail.com' });
  assert.strictEqual((await post('/api/auth/google', { credential, ...DOB })).status, 200);

  const claims = jwt.decode(credential);
  const key = oauthIdentityKey('google', claims, credential);
  assert.ok(oauthIdentityWasUsed(key, Date.now() + 50 * 60 * 1000),
    'the credential was replayable again 15 minutes in, for its remaining ~50');
  assert.ok(oauthIdentityWasUsed(key, claims.exp * 1000 + OAUTH_VERIFIER_SKEW_MS));
});

// ===========================================================================
// The property the string key was chosen for, which must survive the re-key
// ===========================================================================

test('a genuinely new token for the same user still signs in — both providers', async () => {
  reset();

  const first = await post('/api/auth/google', {
    credential: googleToken({ sub: 'g-again', email: 'again@gmail.com' }), ...DOB,
  });
  assert.strictEqual(first.status, 200);
  const googleId = first.json().user.id;

  // The user comes back and signs in for real. A later issuance carries a
  // later `iat`, which is the ordinary case, and it must not be mistaken for a
  // replay — refusing it is what keying on `sub` alone would have done.
  const later = Math.floor(Date.now() / 1000) + 30;
  const again = await post('/api/auth/google', {
    credential: googleToken({ sub: 'g-again', email: 'again@gmail.com', iat: later }), ...DOB,
  });
  assert.strictEqual(again.status, 200, 'the user\'s NEXT real sign-in must not be refused');
  assert.strictEqual(again.json().user.id, googleId);

  // And an issuance inside the SAME second as the first: Google's tokens carry
  // an `at_hash` tied to the access token issued with them, so two issuances
  // sharing `iat` still differ. (Two tokens with byte-identical claims are the
  // same credential — RS256 is deterministic — and refusing the second is
  // correct, not a false positive.)
  const sameSecond = await post('/api/auth/google', {
    credential: googleToken({ sub: 'g-again', email: 'again@gmail.com', at_hash: 'second-issuance' }),
    ...DOB,
  });
  assert.strictEqual(sameSecond.status, 200,
    'a second issuance in the same second must still sign in');
  assert.strictEqual(sameSecond.json().user.id, googleId);

  const appleFirst = await post('/api/auth/apple', {
    identityToken: appleToken({ sub: 'a-again', email: 'again@icloud.com' }), ...DOB,
  });
  assert.strictEqual(appleFirst.status, 200);
  const appleId = appleFirst.json().user.id;

  const appleAgain = await post('/api/auth/apple', {
    identityToken: appleToken({ sub: 'a-again', email: 'again@icloud.com', iat: later }), ...DOB,
  });
  assert.strictEqual(appleAgain.status, 200);
  assert.strictEqual(appleAgain.json().user.id, appleId);
});

test('a refusal still leaves the credential usable, on both providers', async () => {
  reset();
  // A sign-in with no account and no DOB is refused with needsDob. That is not
  // the holder's fault and must not burn the credential — the success-only
  // rule the re-key had to preserve.
  const credential = googleToken({ sub: 'g-nodob', email: 'nodob@gmail.com' });
  const refused = await post('/api/auth/google', { credential });
  assert.strictEqual(refused.status, 403);
  assert.strictEqual(refused.json().needsDob, true);
  assert.strictEqual((await post('/api/auth/google', { credential, ...DOB })).status, 200,
    'the refused attempt burned the credential');

  const identityToken = appleToken({ sub: 'a-nodob', email: 'nodob@icloud.com' });
  const appleRefused = await post('/api/auth/apple', { identityToken });
  assert.strictEqual(appleRefused.status, 403);
  assert.strictEqual(appleRefused.json().needsDob, true);
  assert.strictEqual((await post('/api/auth/apple', { identityToken, ...DOB })).status, 200,
    'the refused attempt burned the identity token');
});
