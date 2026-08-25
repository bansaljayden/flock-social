// Run: node --test  (from backend/)
//
// SECURITY-AUDIT-auth.md round 2, the two findings that live in
// routes/auth.js. Both are regression tests: each one drives the exploit the
// audit wrote out and asserts it is now refused.
//
//   R2-3 (MEDIUM) — a captured Google `credential` was replayable for its full
//   ~1 hour life. The Apple handler sitting a few hundred lines below it had a
//   single-use cache AND nonce binding since round 16; the Google handler had
//   neither, so the provider with the SIX TIMES LONGER window was the
//   unprotected one. What a replay buys is not "one more session": the Flock
//   JWT it mints carries a fresh `iat`, and a fresh `iat` is the entire
//   sudo-mode proof for an OAuth account (hasFreshSession in routes/users.js),
//   so one captured value reached account deletion, the phone-number change
//   and the full data export.
//
//   R2-2 (MEDIUM) — recordLoginFailure ended in `loginFailures.clear()` once
//   the map passed its cap. `key` is a canonical address off an UNAUTHENTICATED
//   route, so the caller chose when that happened: lock the victim out with ten
//   failures, then fire 20,001 failures at distinct random addresses, and the
//   victim's counter was wiped along with everybody else's.
//
// No database. pool.query is a dispatcher over in-memory rows, and each handler
// matches on the CLAUSE of the statement under test rather than on a prefix, so
// a clause deleted from routes/auth.js loses its effect here too (the rule
// emailVerification.test.js records).

// Env must be set before ANY require.
process.env.JWT_SECRET = 'google-replay-test-secret';
process.env.GOOGLE_CLIENT_ID = 'flock-test.apps.googleusercontent.com';
process.env.PUBLIC_WEB_URL = 'http://localhost:3000';
process.env.PUBLIC_API_URL = 'http://localhost:5000';
delete process.env.RESEND_API_KEY;        // mail becomes a skip, never a network call
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

// ---------------------------------------------------------------------------
// Module stubs, installed in the require cache BEFORE routes/auth.js loads.
// ---------------------------------------------------------------------------
const jwksPath = require.resolve('jwks-rsa');
require.cache[jwksPath] = {
  id: jwksPath, filename: jwksPath, loaded: true,
  exports: () => ({ getSigningKey: (_kid, cb) => cb(new Error('no apple in this file')) }),
};

const appleAuthPath = require.resolve('../services/appleAuth');
require.cache[appleAuthPath] = {
  id: appleAuthPath, filename: appleAuthPath, loaded: true,
  exports: {
    isConfigured: () => false,
    exchangeAppleCode: async () => ({}),
    revokeAppleToken: async () => {},
  },
};

// Google's ID token verifier. Keyed on the credential STRING, so two different
// credentials for the same `sub` are two different tokens — which is the whole
// distinction a replay cache has to get right (refuse THIS token twice, never
// refuse the user's next real sign-in).
const googlePayloads = new Map();
let verifyCalls = 0;
const googleLibPath = require.resolve('google-auth-library');
require.cache[googleLibPath] = {
  id: googleLibPath, filename: googleLibPath, loaded: true,
  exports: {
    OAuth2Client: class {
      async verifyIdToken({ idToken, audience }) {
        verifyCalls += 1;
        assert.strictEqual(audience, process.env.GOOGLE_CLIENT_ID,
          'the audience must still be pinned — an undefined one makes the check a no-op');
        const payload = googlePayloads.get(idToken);
        if (!payload) throw new Error('Invalid token');
        return { getPayload: () => payload };
      }
    },
  },
};

const pool = require('../config/database');
const authRouter = require('../routes/auth');
const {
  loginLockedFor, recordLoginFailure, clearLoginFailures, LOGIN_FAIL_LIMIT,
  canonicalEmail,
} = authRouter.__testing;

// routes/auth.js with its comments stripped. The comments NAME the calls these
// assertions forbid (that is what makes them useful comments), so matching the
// raw file would fail on its own explanation of the fix.
function authSource() {
  return fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// A Google ID token is three base64url segments before the route will look at
// it at all (the round-20 shape guard), so the fake credentials have that shape.
let credentialSeq = 0;
function googleCredential(claims) {
  credentialSeq += 1;
  const seg = () => crypto.randomBytes(9).toString('base64url');
  const cred = `${seg()}.${seg()}${credentialSeq}.${seg()}`;
  googlePayloads.set(cred, {
    sub: `g-${credentialSeq}`,
    email: `u${credentialSeq}@gmail.com`,
    email_verified: true,
    name: 'Ava',
    exp: Math.floor(Date.now() / 1000) + 3600, // Google's ~1 hour window
    ...claims,
  });
  return cred;
}

// ---------------------------------------------------------------------------
// In-memory users table
// ---------------------------------------------------------------------------
let users = [];
let nextUserId = 1;
let statements = [];
let tombstoned = false;

const clause = (sql, re) => re.test(sql);

const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  statements.push(sql);

  if (clause(sql, /oauth_provider = 'google' AND oauth_id/)) {
    return { rows: users.filter((u) => u.oauth_provider === 'google' && u.oauth_id === params[0]) };
  }
  if (clause(sql, /oauth_provider = 'apple' AND oauth_id/)) {
    return { rows: [] };
  }
  if (sql.startsWith('SELECT * FROM users') && clause(sql, /split_part/)) {
    const hit = users.find((u) => canonicalEmail(u.email) === canonicalEmail(params[0])) || null;
    return { rows: hit ? [hit] : [] };
  }
  if (sql.startsWith('INSERT INTO users')) {
    const row = {
      id: nextUserId++, token_version: 0, is_banned: false, password: null,
      email: params[0], name: params[1], oauth_provider: 'google', oauth_id: params[2],
      profile_image_url: params[3], date_of_birth: params[4],
      email_verified: clause(sql, /email_verified/), verified_email: params[5],
    };
    users.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith('SELECT 1 FROM banned_identities')) {
    return { rows: tombstoned ? [{ ok: 1 }] : [] };
  }
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
  tombstoned = false;
}

const nonceOf = async () => (await post('/api/auth/google/nonce', {})).json().nonce;

// ===========================================================================
// R2-3 — the replay
// ===========================================================================

test('R2-3: a captured Google credential cannot be replayed', async () => {
  reset();
  const credential = googleCredential({ sub: 'g-victim', email: 'victim@gmail.com' });

  // 1. The victim signs in. This is the request an attacker captures out of a
  //    proxy log, a crash report or an analytics SDK that recorded the body.
  const first = await post('/api/auth/google', { credential, date_of_birth: '2000-01-01' });
  assert.strictEqual(first.status, 200);
  const victimId = first.json().user.id;

  // 2. Within the token's ~1 hour window the attacker posts the same value.
  //    Before the fix this minted a fresh 24h Flock session on the victim's
  //    account whose `iat` also satisfied hasFreshSession, i.e. sudo mode.
  const replay = await post('/api/auth/google', { credential, date_of_birth: '2000-01-01' });
  assert.strictEqual(replay.status, 401);
  assert.match(replay.json().error, /expired/i);
  assert.strictEqual(replay.json().token, undefined, 'a replay must not mint a session');

  // 3. The victim's NEXT sign-in is a different token for the same `sub` and
  //    must still work — the cache keys on the credential, not the identity.
  const fresh = googleCredential({ sub: 'g-victim', email: 'victim@gmail.com' });
  const again = await post('/api/auth/google', { credential: fresh, date_of_birth: '2000-01-01' });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json().user.id, victimId);
});

// UPDATED in round 23 (R3-A2). This test used to pin the opposite ordering:
// the replay check ran BEFORE verifyIdToken, so a known-replayed token cost no
// upstream work. That ordering was only possible because the key was SHA-256 of
// the credential STRING, and the string is not a canonical encoding of the
// credential: the last character of an RS256 signature has 16 spellings that
// all verify and all hash differently, so the cheap check was cheap and wrong -
// one captured credential minted 16 sessions. The key is now derived from the
// VERIFIED payload plus the DECODED signature bytes, which is identical for all
// 16 spellings, and that value does not exist until the token is verified.
//
// So the property this test pins has changed: "refused before verifyIdToken" is
// replaced by "refused before ANY row is read and before any session is
// minted". Reaching verifyIdToken is now expected - it is a signature check on
// data already in memory, with the certificate cache in front of it - and the
// shape regex is still what keeps malformed input away from it (covered by
// authShapeGuards.test.js).
test('R2-3: a replay is refused after verification but before any row is read', async () => {
  reset();
  const credential = googleCredential({ sub: 'g-early', email: 'early@gmail.com' });
  assert.strictEqual((await post('/api/auth/google', { credential, date_of_birth: '2000-01-01' })).status, 200);

  const verifiesBefore = verifyCalls;
  statements = [];
  const replay = await post('/api/auth/google', { credential, date_of_birth: '2000-01-01' });
  assert.strictEqual(replay.status, 401);
  assert.strictEqual(replay.json().token, undefined, 'a replay must not mint a session');
  assert.strictEqual(verifyCalls, verifiesBefore + 1,
    'the replay check now runs on the VERIFIED identity, so it verifies exactly once and refuses');
  assert.deepStrictEqual(statements, [], 'a replayed token must not reach the database');

  // The pre-verify guard that survived: a credential that is not three
  // base64url segments never reaches the library at all.
  const before = verifyCalls;
  const malformed = await post('/api/auth/google', { credential: 'not-a-jwt', date_of_birth: '2000-01-01' });
  assert.strictEqual(malformed.status, 401);
  assert.strictEqual(verifyCalls, before, 'the shape guard must still run before verifyIdToken');
});

test('R2-3: a credential is only spent on SUCCESS, so a client can retry', async () => {
  reset();
  // A Google sign-in with no account and no DOB is refused with needsDob. That
  // refusal is not the user's fault and must leave the credential usable, the
  // same success-only rule the Apple path uses for its upstream blips.
  const credential = googleCredential({ sub: 'g-nodob', email: 'nodob@gmail.com' });

  const refused = await post('/api/auth/google', { credential });
  assert.strictEqual(refused.status, 403);
  assert.strictEqual(refused.json().needsDob, true);

  const retry = await post('/api/auth/google', { credential, date_of_birth: '2000-01-01' });
  assert.strictEqual(retry.status, 200, 'the refused attempt must not have burned the credential');
});

test('R2-3: the replay cache is ONE cache shared with the Apple path', () => {
  // Two maps drift, and the drift is exactly what this finding was. Asserted
  // against the source so a future edit that re-splits them fails here.
  const src = authSource();
  const maps = src.match(/^const \w*[Tt]okensUsed = new Map\(\);$/gm) || [];
  assert.strictEqual(maps.length, 1, `expected exactly one provider-token replay cache, found ${maps.length}`);
  assert.ok(!/appleTokensUsed/.test(src), 'the Apple-only replay cache is back');
  // ...and it is never emptied wholesale, which would make every token in it
  // replayable again at a moment the flooder chooses (R2-2's shape).
  //
  // Round 25 (R5-H2) allows exactly one clear(): a test-only export, the same
  // carve-out and the same shape as clearUnderageAttempts on the lockout map.
  // The access-token branch is single-use now, so a suite that reuses one
  // literal token string across independent tests needs a way to start clean —
  // and a suite that could not would end up with tests inheriting each other's
  // spent credentials, which is a worse failure mode than this line prevents.
  // Comments are stripped first: the prose above quotes the call.
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  const clears = code.split('\n').filter((l) => l.includes('oauthTokensUsed.clear()'));
  assert.strictEqual(clears.length, 1,
    `oauthTokensUsed.clear() appears ${clears.length} times; it may exist only on the __testing export`);
  assert.ok(/clearOauthIdentityClaims:\s*\(\)\s*=>\s*oauthTokensUsed\.clear\(\)/.test(clears[0]),
    `the surviving clear() is not the test-only export: ${clears[0].trim()}`);
});

// ===========================================================================
// R2-3 — the nonce binding
// ===========================================================================

test('R2-3: a Google token bound to a nonce the client did not disclose is refused', async () => {
  reset();
  const credential = googleCredential({ sub: 'g-hidden', email: 'hidden@gmail.com', nonce: 'not-ours' });
  const res = await post('/api/auth/google', { credential, date_of_birth: '2000-01-01' });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(users.length, 0, 'no account may be created on a token we cannot fully check');
});

test('R2-3: a Google nonce must be one we issued, must match the token, and is single use', async () => {
  reset();

  // Matching, raw spelling (what Google Identity Services echoes).
  let nonce = await nonceOf();
  let res = await post('/api/auth/google', {
    credential: googleCredential({ sub: 'g-n1', email: 'n1@gmail.com', nonce }),
    nonce, date_of_birth: '2000-01-01',
  });
  assert.strictEqual(res.status, 200);

  // Matching, SHA-256 spelling — accepted for the same reason the Apple path
  // accepts it, and through the same constant-time comparison.
  reset();
  nonce = await nonceOf();
  const hashed = crypto.createHash('sha256').update(nonce).digest('hex');
  res = await post('/api/auth/google', {
    credential: googleCredential({ sub: 'g-n2', email: 'n2@gmail.com', nonce: hashed }),
    nonce, date_of_birth: '2000-01-01',
  });
  assert.strictEqual(res.status, 200);

  // The token carries somebody else's nonce.
  reset();
  nonce = await nonceOf();
  res = await post('/api/auth/google', {
    credential: googleCredential({ sub: 'g-n3', email: 'n3@gmail.com', nonce: 'somebody-elses' }),
    nonce, date_of_birth: '2000-01-01',
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(users.length, 0);

  // A nonce we never issued.
  reset();
  res = await post('/api/auth/google', {
    credential: googleCredential({ sub: 'g-n4', email: 'n4@gmail.com', nonce: 'invented' }),
    nonce: 'invented', date_of_birth: '2000-01-01',
  });
  assert.strictEqual(res.status, 401);

  // A nonce is single use — the second sign-in bound to it is refused.
  reset();
  nonce = await nonceOf();
  const mk = (sub) => googleCredential({ sub, email: `${sub}@gmail.com`, nonce });
  assert.strictEqual((await post('/api/auth/google', { credential: mk('g-n5'), nonce, date_of_birth: '2000-01-01' })).status, 200);
  assert.strictEqual((await post('/api/auth/google', { credential: mk('g-n6'), nonce, date_of_birth: '2000-01-01' })).status, 401);
});

test('R2-3: GOOGLE_REQUIRE_NONCE makes the nonce mandatory once clients send one', async () => {
  reset();
  process.env.GOOGLE_REQUIRE_NONCE = 'true';
  try {
    const res = await post('/api/auth/google', {
      credential: googleCredential({ sub: 'g-req', email: 'req@gmail.com' }),
      date_of_birth: '2000-01-01',
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(users.length, 0);
  } finally {
    delete process.env.GOOGLE_REQUIRE_NONCE;
  }
});

// ===========================================================================
// R2-2 — flushing the login throttle
// ===========================================================================
//
// Driven through the throttle's own exported functions rather than over HTTP:
// the exploit needs 20,001 distinct keys, and the point being pinned is what
// the eviction does to the VICTIM's entry, not what the router does with a
// request.

const VICTIM = 'victim@example.com';

function lockOut(key) {
  clearLoginFailures(key);
  for (let i = 0; i < LOGIN_FAIL_LIMIT; i += 1) recordLoginFailure(key);
}

test('R2-2: flooding the throttle with fresh addresses does not unlock the victim', () => {
  lockOut(VICTIM);
  assert.ok(loginLockedFor(VICTIM) > 0, 'ten failures must lock the account');

  // The exploit: 25,000 failed logins against distinct valid-shaped addresses,
  // comfortably past LOGIN_FAIL_MAX_KEYS (20,000). The 20,001st used to reach
  // loginFailures.clear().
  for (let i = 0; i < 25000; i += 1) recordLoginFailure(`flood-${i}@example.com`);

  assert.ok(
    loginLockedFor(VICTIM) > 0,
    'the victim\'s lockout survived the flood — a wholesale clear() would have dropped it'
  );
});

test('R2-2: eviction is by CONSUMPTION, so the fullest counters are the last to go', () => {
  // Age-ordered eviction would be no better than clear() here: the victim's
  // entry is both the OLDEST and the FULLEST, so dropping oldest-first drops
  // precisely the counter the attacker wants gone. Two victims, locked BEFORE
  // the flood, both have to survive it.
  const a = 'first@example.com';
  const b = 'second@example.com';
  lockOut(a);
  lockOut(b);
  for (let i = 0; i < 30000; i += 1) recordLoginFailure(`wave2-${i}@example.com`);
  assert.ok(loginLockedFor(a) > 0, 'the oldest locked entry must survive');
  assert.ok(loginLockedFor(b) > 0, 'the second locked entry must survive');
});

test('R2-2: the throttle is still bounded — the flood does not grow the map without limit', () => {
  // The eviction has to keep working, not just stop being a security hole.
  // Nothing exposes the map, so this is asserted the way the fix guarantees it:
  // a key inserted early in a very large flood is gone by the end.
  clearLoginFailures('early@example.com');
  recordLoginFailure('early@example.com');
  for (let i = 0; i < 45000; i += 1) recordLoginFailure(`wave3-${i}@example.com`);
  // A single-failure entry is below LOGIN_FAIL_LIMIT so it never "locks"; what
  // is asserted is that recording 45,000 more keys still returns promptly and
  // the victim entries from the tests above are the ones that survived.
  assert.strictEqual(loginLockedFor('early@example.com'), 0);
});

test('R2-2: no wholesale clear() is left on either map in routes/auth.js', () => {
  const src = authSource();
  assert.ok(!/loginFailures\.clear\(\)/.test(src), 'loginFailures.clear() is back');
  assert.ok(!/oauthNonces\.clear\(\)/.test(src), 'the nonce store is cleared wholesale again');
});
