// Run: node --test  (from backend/)
//
// SECURITY-AUDIT-auth.md round 4, R4-A1: the OAuth single-use guarantee was
// defeated by concurrency.
//
// Round 3 (R3-A2) fixed WHICH key the replay cache writes — sixteen spellings
// of one RS256 signature collapse onto one entry, and oauthReplayCanonical.test.js
// pins that. Round 4 found that WHEN it is written was still wrong. Both
// handlers had this shape:
//
//     if (oauthIdentityWasUsed(key)) return 401;   <- CHECK
//     ... four-plus `await pool.query` calls ...
//     markOauthIdentityUsed(key);                  <- RECORD
//
// Node runs one turn at a time, but every `await` yields the event loop. Ten
// SIMULTANEOUS presentations of one captured credential therefore all reached
// the CHECK before any of them reached the RECORD, all missed an empty cache,
// and all ten completed. Each one is a Flock JWT with a fresh `iat`, and a
// fresh `iat` is the entire sudo-mode proof for an OAuth account
// (hasFreshSession in routes/users.js): account deletion, the phone-number
// change and the full data export are reachable from every one of them. The
// multiplier is no longer 16, it is however many requests fit in flight.
//
// The fix is a single atomic CLAIM (check-and-record with no `await` between
// the read and the write) plus a RELEASE on every path that is not a completed
// sign-in — because the pre-existing and still-required behaviour is that a
// `needsDob` refusal or a transient upstream failure leaves the credential
// USABLE. Claim without release is not a fix, it is a lockout: a user whose
// first attempt hit an Apple outage could never sign in with that credential.
// This file pins both halves.
//
// THE HARNESS HAS TO ACTUALLY INTERLEAVE. A `pool.query` stub that resolves on
// the microtask queue would let each handler run start to finish before the
// next request's socket data is even read, and every test below would pass
// against the broken code. So the stub yields through setImmediate — a real
// macrotask, which is what a real database round trip is — and the first test
// in the file asserts, using the route's own exported primitives, that the old
// check-then-record shape DOES admit both presentations under that harness. If
// that first test ever goes green-by-accident the rest of the file is void.
//
// No database. pool.query is a dispatcher over in-memory rows.

// Env must be set before ANY require.
process.env.JWT_SECRET = 'oauth-replay-atomicity-secret';
process.env.GOOGLE_CLIENT_ID = 'flock-atomicity.apps.googleusercontent.com';
process.env.APPLE_BUNDLE_ID = 'com.flockcorp.flock';
process.env.PUBLIC_WEB_URL = 'http://localhost:3000';
process.env.PUBLIC_API_URL = 'http://localhost:5000';
delete process.env.RESEND_API_KEY;
delete process.env.APPLE_REQUIRE_NONCE;
delete process.env.GOOGLE_REQUIRE_NONCE;
delete process.env.NODE_ENV;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

// ---------------------------------------------------------------------------
// One RSA keypair, standing in for both providers' signing keys. Same approach
// as oauthReplayCanonical.test.js: the route runs REAL signature verification.
// ---------------------------------------------------------------------------
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

// Apple's code exchange, with a fault injector. This is the transient upstream
// failure the release half of the contract exists for: routes/auth.js answers
// 503 when the exchange throws and Apple is configured, and that 503 must not
// burn the identity token.
let appleIsConfigured = false;
let appleExchangeFailures = 0;
let appleExchangeCalls = 0;
const appleAuthPath = require.resolve('../services/appleAuth');
require.cache[appleAuthPath] = {
  id: appleAuthPath, filename: appleAuthPath, loaded: true,
  exports: {
    isConfigured: () => appleIsConfigured,
    exchangeAppleCode: async () => {
      appleExchangeCalls += 1;
      await new Promise((r) => setImmediate(r));
      if (appleExchangeFailures > 0) {
        appleExchangeFailures -= 1;
        throw new Error('simulated Apple token endpoint outage');
      }
      return { refresh_token: `refresh-${appleExchangeCalls}` };
    },
    revokeAppleToken: async () => true,
  },
};

// Google's verifier: the real signature + audience check, over the same key.
let verifyCalls = 0;
const googleLibPath = require.resolve('google-auth-library');
require.cache[googleLibPath] = {
  id: googleLibPath, filename: googleLibPath, loaded: true,
  exports: {
    OAuth2Client: class {
      async verifyIdToken({ idToken, audience }) {
        verifyCalls += 1;
        // A real verifier does network-cached certificate work; yield like one,
        // so the window between verification and the claim is a real window.
        await new Promise((r) => setImmediate(r));
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
  claimOauthIdentity, releaseOauthIdentityClaim,
  canonicalEmail,
} = authRouter.__testing;

function authSource() {
  return fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
}
// routes/auth.js with comments stripped: the comments NAME the calls some of
// these assertions forbid, which is what makes them good comments.
function authCode() {
  return authSource()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
// In-memory users table. EVERY handler yields through setImmediate first — a
// macrotask, the way a real pg round trip is — so concurrent requests genuinely
// interleave inside the handler rather than each running to completion.
// ---------------------------------------------------------------------------
let users = [];
let nextUserId = 1;
let statements = [];
let queryFailures = 0;   // fault injector: N next queries throw

const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  statements.push(sql);
  await new Promise((r) => setImmediate(r));

  if (queryFailures > 0) {
    queryFailures -= 1;
    throw new Error('simulated database blip');
  }

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
  if (sql.startsWith('UPDATE users SET apple_refresh_token')) {
    const row = users.find((u) => u.id === params[1]);
    if (row) row.apple_refresh_token = params[0];
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
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
// Tokens
// ---------------------------------------------------------------------------
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
      agent: new http.Agent({ keepAlive: false, maxSockets: 64 }),
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
  queryFailures = 0;
  appleIsConfigured = false;
  appleExchangeFailures = 0;
  appleExchangeCalls = 0;
}

const DOB = { date_of_birth: '2000-01-01' };

// Two issuances of one provider token that share every claim ARE the same
// credential — that is the point of keying on the identity rather than the
// string — so a test that wants a genuinely NEW token has to move `iat`, the
// way a real later issuance does. Same device oauthReplayCanonical.test.js uses.
let issuedAt = Math.floor(Date.now() / 1000);
const nextIat = () => (issuedAt += 30);

// The point of the exercise: fire them all WITHOUT awaiting in between, so the
// requests are genuinely in flight together rather than serialised by the test.
function fireTogether(n, makeRequest) {
  const inFlight = [];
  for (let i = 0; i < n; i += 1) inFlight.push(makeRequest(i));
  return Promise.all(inFlight);
}

const tally = (responses) => responses.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] || 0) + 1;
  return acc;
}, {});

// ===========================================================================
// 1. The window, and that this harness can see it
// ===========================================================================

test('R4-A1: the window is real — check-then-record admits BOTH presentations', async () => {
  const key = `r4a1-window-${crypto.randomBytes(8).toString('hex')}`;
  const exp = Math.floor(Date.now() / 1000) + 600;

  // The old shape, spelled out with the route's own exported primitives: check
  // at the top, record at the bottom, one `await` in between standing in for
  // the four `await pool.query` calls that were there.
  const oldShape = async () => {
    if (oauthIdentityWasUsed(key)) return 'refused';
    await new Promise((r) => setImmediate(r));
    markOauthIdentityUsed(key, exp);
    return 'signed in';
  };

  const results = await Promise.all([oldShape(), oldShape()]);
  assert.deepStrictEqual(results, ['signed in', 'signed in'],
    'the exploit no longer reproduces under this harness, so every route test below proves nothing — fix the harness, do not delete this test');
  releaseOauthIdentityClaim(key);
  assert.strictEqual(oauthIdentityWasUsed(key), false);
});

test('R4-A1: claimOauthIdentity is ONE synchronous step — the second caller loses', async () => {
  const key = `r4a1-claim-${crypto.randomBytes(8).toString('hex')}`;
  const exp = Math.floor(Date.now() / 1000) + 600;

  const newShape = async () => {
    if (!claimOauthIdentity(key, exp)) return 'refused';
    await new Promise((r) => setImmediate(r));
    return 'signed in';
  };

  const results = await Promise.all([newShape(), newShape(), newShape(), newShape()]);
  assert.strictEqual(results.filter((r) => r === 'signed in').length, 1,
    'exactly one of four simultaneous claims may win');
  assert.strictEqual(results.filter((r) => r === 'refused').length, 3);
  releaseOauthIdentityClaim(key);
});

test('R4-A1: a released claim is usable again, and only the winner can release it', () => {
  const key = `r4a1-release-${crypto.randomBytes(8).toString('hex')}`;
  const exp = Math.floor(Date.now() / 1000) + 600;

  assert.strictEqual(claimOauthIdentity(key, exp), true, 'first claim wins');
  assert.strictEqual(claimOauthIdentity(key, exp), false, 'second claim loses');
  releaseOauthIdentityClaim(key);
  assert.strictEqual(oauthIdentityWasUsed(key), false, 'release hands the credential back');
  assert.strictEqual(claimOauthIdentity(key, exp), true, 'and it can be claimed again');
  releaseOauthIdentityClaim(key);

  // A null key is not claimable at all — an unkeyable credential fails closed
  // in the handlers before this is ever reached, and release must no-op on it
  // rather than throw inside a `finally`.
  assert.strictEqual(claimOauthIdentity(null, exp), false);
  assert.doesNotThrow(() => releaseOauthIdentityClaim(null));
});

// ===========================================================================
// 2. The routes, under genuine concurrency
// ===========================================================================

test('R4-A1: two simultaneous Google presentations yield exactly one session and one 401', async () => {
  reset();
  const credential = googleToken({ sub: 'g-race2', email: 'race2@gmail.com' });

  const responses = await fireTogether(2, () => post('/api/auth/google', { credential, ...DOB }));

  assert.deepStrictEqual(tally(responses), { 200: 1, 401: 1 },
    `two in-flight presentations of one credential must not both mint a session (got ${JSON.stringify(responses.map((r) => r.status))})`);
  assert.strictEqual(responses.filter((r) => r.json().token).length, 1, 'exactly one session token');
  assert.strictEqual(users.length, 1, 'and exactly one account');
});

test('R4-A1: two simultaneous Apple presentations yield exactly one session and one 401', async () => {
  reset();
  const identityToken = appleToken({ sub: 'a-race2', email: 'race2@icloud.com' });

  const responses = await fireTogether(2, () => post('/api/auth/apple', { identityToken, ...DOB }));

  assert.deepStrictEqual(tally(responses), { 200: 1, 401: 1 },
    `two in-flight presentations of one identity token must not both mint a session (got ${JSON.stringify(responses.map((r) => r.status))})`);
  assert.strictEqual(responses.filter((r) => r.json().token).length, 1, 'exactly one session token');
  assert.strictEqual(users.length, 1, 'and exactly one account');
});

test('R4-A1: ten simultaneous presentations mint exactly one session — both providers', async () => {
  for (const provider of ['google', 'apple']) {
    reset();
    const body = provider === 'google'
      ? { credential: googleToken({ sub: 'g-race10', email: 'race10@gmail.com' }), ...DOB }
      : { identityToken: appleToken({ sub: 'a-race10', email: 'race10@icloud.com' }), ...DOB };

    const responses = await fireTogether(10, () => post(`/api/auth/${provider}`, body));

    assert.deepStrictEqual(tally(responses), { 200: 1, 401: 9 },
      `${provider}: ten in-flight presentations of one credential (got ${JSON.stringify(responses.map((r) => r.status))})`);
    assert.strictEqual(users.length, 1, `${provider}: no duplicate account`);

    // The whole point of the finding: a fresh `iat` is sudo-mode proof, so the
    // count of sessions minted IS the count of account deletions reachable.
    const tokens = responses.map((r) => r.json().token).filter(Boolean);
    assert.strictEqual(tokens.length, 1, `${provider}: one credential, one session`);
  }
});

test('R4-A1: an existing account is just as protected as a new one — both providers', async () => {
  for (const provider of ['google', 'apple']) {
    reset();
    // The victim signs in normally first, so the concurrent burst below takes
    // the short "found by oauth_id" path rather than the account-creation one.
    const sub = provider === 'google' ? 'g-existing' : 'a-existing';
    const email = provider === 'google' ? 'existing@gmail.com' : 'existing@icloud.com';
    const first = provider === 'google'
      ? { credential: googleToken({ sub, email, iat: nextIat() }), ...DOB }
      : { identityToken: appleToken({ sub, email, iat: nextIat() }), ...DOB };
    assert.strictEqual((await post(`/api/auth/${provider}`, first)).status, 200);

    const captured = provider === 'google'
      ? { credential: googleToken({ sub, email, iat: nextIat() }), ...DOB }
      : { identityToken: appleToken({ sub, email, iat: nextIat() }), ...DOB };
    const responses = await fireTogether(8, () => post(`/api/auth/${provider}`, captured));

    assert.deepStrictEqual(tally(responses), { 200: 1, 401: 7 },
      `${provider}: got ${JSON.stringify(responses.map((r) => r.status))}`);
    assert.strictEqual(users.length, 1);
  }
});

// ===========================================================================
// 3. The release half — every non-success path hands the credential back
// ===========================================================================

test('R4-A1: a needsDob refusal releases the claim — Google', async () => {
  reset();
  const credential = googleToken({ sub: 'g-nodob', email: 'nodob@gmail.com' });

  const refused = await post('/api/auth/google', { credential });
  assert.strictEqual(refused.status, 403);
  assert.strictEqual(refused.json().needsDob, true);
  assert.strictEqual(users.length, 0);

  const retry = await post('/api/auth/google', { credential, ...DOB });
  assert.strictEqual(retry.status, 200,
    'claiming up front without releasing turns a needsDob refusal into a permanent lockout');
  assert.ok(retry.json().token);
});

test('R4-A1: a needsDob refusal releases the claim — Apple', async () => {
  reset();
  const identityToken = appleToken({ sub: 'a-nodob', email: 'nodob@icloud.com' });

  const refused = await post('/api/auth/apple', { identityToken });
  assert.strictEqual(refused.status, 403);
  assert.strictEqual(refused.json().needsDob, true);
  assert.strictEqual(users.length, 0);

  const retry = await post('/api/auth/apple', { identityToken, ...DOB });
  assert.strictEqual(retry.status, 200,
    'claiming up front without releasing turns a needsDob refusal into a permanent lockout');
  assert.ok(retry.json().token);
});

test('R4-A1: a simulated upstream/database blip releases the claim — both providers', async () => {
  for (const provider of ['google', 'apple']) {
    reset();
    const body = provider === 'google'
      ? { credential: googleToken({ sub: 'g-blip', email: 'blip@gmail.com' }), ...DOB }
      : { identityToken: appleToken({ sub: 'a-blip', email: 'blip@icloud.com' }), ...DOB };

    // The very next query throws, which is a 500 out of the handler's catch —
    // the class of failure the release half exists for. It happens AFTER the
    // claim, so without a release the credential is gone.
    queryFailures = 1;
    const blip = await post(`/api/auth/${provider}`, body);
    assert.strictEqual(blip.status, 500, `${provider}: the injected fault must reach the catch`);
    assert.strictEqual(users.length, 0);

    const retry = await post(`/api/auth/${provider}`, body);
    assert.strictEqual(retry.status, 200,
      `${provider}: a transient failure must leave the credential usable`);
    assert.ok(retry.json().token);
  }
});

test("R4-A1: Apple's code-exchange 503 releases the claim", async () => {
  reset();
  appleIsConfigured = true;
  appleExchangeFailures = 1;
  const identityToken = appleToken({ sub: 'a-503', email: 'outage@icloud.com' });

  // This is the exact case the round-16/22 comments named when they argued for
  // recording only on success: Apple's token endpoint is down, the handler
  // answers 503, and the client retries with the same identity token.
  const outage = await post('/api/auth/apple', { identityToken, authorizationCode: 'apple-code-1', ...DOB });
  assert.strictEqual(outage.status, 503);
  assert.strictEqual(outage.json().token, undefined);

  const retry = await post('/api/auth/apple', { identityToken, authorizationCode: 'apple-code-1', ...DOB });
  assert.strictEqual(retry.status, 200,
    'an Apple outage must not cost the user their identity token');
  assert.ok(retry.json().token);
  assert.strictEqual(appleExchangeCalls, 2);
});

test('R4-A1: releasing on failure does not reopen the replay — the successful use still sticks', async () => {
  reset();
  const credential = googleToken({ sub: 'g-sticky', email: 'sticky@gmail.com' });

  // needsDob refusal (released), then a real sign-in (claim kept), then the
  // replay the whole mechanism exists to refuse.
  assert.strictEqual((await post('/api/auth/google', { credential })).status, 403);
  assert.strictEqual((await post('/api/auth/google', { credential, ...DOB })).status, 200);
  const replay = await post('/api/auth/google', { credential, ...DOB });
  assert.strictEqual(replay.status, 401, 'the release half must not make a spent credential replayable');
  assert.strictEqual(replay.json().token, undefined);
});

test('R4-A1: a genuinely new token for the same user still signs in — both providers', async () => {
  reset();
  for (const provider of ['google', 'apple']) {
    const sub = provider === 'google' ? 'g-next' : 'a-next';
    const email = provider === 'google' ? 'next@gmail.com' : 'next@icloud.com';
    const mint = () => (provider === 'google'
      ? { credential: googleToken({ sub, email, iat: nextIat() }), ...DOB }
      : { identityToken: appleToken({ sub, email, iat: nextIat() }), ...DOB });

    const first = await post(`/api/auth/${provider}`, mint());
    assert.strictEqual(first.status, 200);
    const second = await post(`/api/auth/${provider}`, mint());
    assert.strictEqual(second.status, 200, `${provider}: the next real sign-in must still work`);
    assert.strictEqual(second.json().user.id, first.json().user.id);
  }
});

// ===========================================================================
// 4. Source pins — the shape, not just the behaviour
// ===========================================================================

test('R4-A1: claimOauthIdentity contains no await between the read and the write', () => {
  // Comment-stripped: the comment inside the function says the word "await",
  // which is exactly what makes it a useful comment.
  const src = authCode();
  const body = /function claimOauthIdentity\([\s\S]*?\)\s*\{([\s\S]*?)\n\}/.exec(src);
  assert.ok(body, 'claimOauthIdentity must exist as a named function');
  assert.ok(!/\bawait\b/.test(body[1]),
    'an await inside the claim reopens the window it exists to close');
  assert.ok(/oauthIdentityWasUsed\(/.test(body[1]) && /markOauthIdentityUsed\(/.test(body[1]),
    'the claim must be the check AND the record, not one of them');
});

test('R4-A1: neither handler still checks at the top and records at the bottom', () => {
  const code = authCode();

  // The check-then-record shape is gone: nothing outside claimOauthIdentity
  // calls the bare predicate, and nothing calls the bare recorder either.
  const bareChecks = (code.match(/if \(oauthIdentityWasUsed\(/g) || []).length;
  assert.strictEqual(bareChecks, 1,
    'oauthIdentityWasUsed is a predicate for claimOauthIdentity to use, not a gate for a handler to use');

  const bareRecords = (code.match(/^\s*markOauthIdentityUsed\(/gm) || []).length;
  assert.strictEqual(bareRecords, 1,
    'markOauthIdentityUsed must be called only from claimOauthIdentity — a second call site is a record separated from its check');

  // And every credential branch claims, then releases in a finally. Three, not
  // two, as of round 25 (R5-H2): the Google handler claims on BOTH of its
  // branches now. The access-token branch used to take no claim at all, so one
  // captured access token minted an unbounded supply of sessions carrying a
  // fresh `iat`, which is the whole sudo-mode proof for an OAuth account.
  assert.strictEqual((code.match(/if \(!claimOauthIdentity\(/g) || []).length, 3,
    'the Google credential branch, the Google access-token branch and the Apple handler must all claim');
  assert.strictEqual(
    (code.match(/if \(claimedIdentity && !identityClaimCommitted\) releaseOauthIdentityClaim\(claimedIdentity\);/g) || []).length, 2,
    'both handlers must release the claim on every path that is not a completed sign-in');
  // Tied to the release, not counted across the file. `} finally {` appears
  // twice in routes/auth.js today and this used to assert that number, which
  // measured neither half of what its message claims. It did not catch the
  // defect: moving both releases out of their finally blocks onto the error
  // path, where every early-returning refusal branch skips them, leaves the
  // count at 2 and this assertion green, and the four behavioural tests above
  // are what go red. And it broke on correct code: routes/auth.js is 3,682
  // lines, so one unrelated try/finally anywhere in it, a timing guard or a
  // cleanup, is the ONLY thing that fires this, and it fires with a message
  // saying the release is not in a finally when the release never moved.
  //
  // What matters is that each release sits INSIDE its own finally, so match
  // the two together. A `}` between them means the span left the block.
  const releaseInFinally = /\} finally \{[^}]*?if \(claimedIdentity && !identityClaimCommitted\) releaseOauthIdentityClaim\(claimedIdentity\);/g;
  assert.strictEqual((code.match(releaseInFinally) || []).length, 2,
    'each release must be the body of a finally: enumerating a dozen refusal branches is how one gets missed');
});
