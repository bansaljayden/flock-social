// Run: node --test __tests__/appleWebSignIn.test.js  (from backend/)
//
// SIGN IN WITH APPLE ON THE WEBSITE.
//
// flockcorp.com signs in with Apple through Apple's JS popup, under the
// Services ID com.flockcorp.flock.web, which the Apple Developer portal groups
// with the iPhone app's bundle id com.flockcorp.flock. Grouped clients share one
// Apple user identifier (`sub`), so an Apple ID is one Flock account wherever it
// signs in. What is pinned here, all on POST /api/auth/apple:
//
//   - an identity token is accepted for either audience and for nothing else;
//   - an Apple ID first used in the iPhone app signs in on the website as the
//     SAME account, row and id;
//   - a website token must carry a nonce this server issued (the app's flow is
//     unchanged: it sends none and is not asked for one until
//     APPLE_REQUIRE_NONCE is on);
//   - a new account from the website meets the website's age question, the year,
//     exactly as Google does there, and finishes from the same popup;
//   - the authorization code is exchanged as the client it was issued to, and
//     the refresh token is stored with that client id
//     (users.apple_refresh_client_id, migration 128), so account deletion can
//     revoke it as the right client (appleRevocationClient.test.js).
//
// No database is touched: pool.query is a dispatcher over in-memory tables, the
// technique iosAppNoDateOfBirth.test.js uses.

process.env.JWT_SECRET = 'test-secret-for-apple-web-tests';
process.env.PUBLIC_WEB_URL = 'http://localhost:3000';
process.env.PUBLIC_API_URL = 'http://localhost:5000';
delete process.env.RESEND_API_KEY;
delete process.env.APPLE_REQUIRE_NONCE;
delete process.env.APPLE_BUNDLE_ID;
delete process.env.APPLE_WEB_CLIENT_ID;
delete process.env.NODE_ENV;

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pinClock } = require('./helpers/pinnedClock');
const pinnedClock = pinClock(Date.UTC(2026, 9, 20, 12, 0, 0));
test.after(() => pinnedClock.restore());

const APP_CLIENT = 'com.flockcorp.flock';
const WEB_CLIENT = 'com.flockcorp.flock.web';

// ---------------------------------------------------------------------------
// Module stubs, installed before routes/auth.js loads.
// ---------------------------------------------------------------------------
const { publicKey: APPLE_PUB, privateKey: APPLE_PRIV } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const jwksPath = require.resolve('jwks-rsa');
require.cache[jwksPath] = {
  id: jwksPath, filename: jwksPath, loaded: true,
  exports: () => ({ getSigningKey: (_kid, cb) => cb(null, { getPublicKey: () => APPLE_PUB }) }),
};

// Apple's token endpoint, as the route sees it: which client each code was
// exchanged as, and a refresh token named after the code.
const apple = { configured: false, exchanges: [] };
const appleAuthPath = require.resolve('../services/appleAuth');
require.cache[appleAuthPath] = {
  id: appleAuthPath, filename: appleAuthPath, loaded: true,
  exports: {
    isConfigured: () => apple.configured,
    exchangeAppleCode: async (code, clientId) => {
      apple.exchanges.push({ code, clientId });
      return { refresh_token: `rt-${code}` };
    },
    revokeAppleToken: async () => true,
  },
};

// The clock is pinned and RS256 signatures are deterministic, so two tokens
// with the same claims would be byte-identical and the second one a replay.
// Every popup Apple completes is a different token; the jti makes these so.
const appleIdentityToken = (claims) => jwt.sign(
  { iss: 'https://appleid.apple.com', aud: APP_CLIENT, email_verified: true, jti: crypto.randomUUID(), ...claims },
  APPLE_PRIV,
  { algorithm: 'RS256', expiresIn: '10m', keyid: 'test-kid' }
);

const pool = require('../config/database');
const authRouter = require('../routes/auth');
const { UNDERAGE_MSG, clearUnderageAttempts } = authRouter.__testing;

// ---------------------------------------------------------------------------
// In-memory tables
// ---------------------------------------------------------------------------
let users = [];
let nextUserId = 1;
const canonical = authRouter.__testing.canonicalEmail;
const findByEmail = (email) => users.find((u) => String(u.email).toLowerCase() === String(email).toLowerCase())
  || users.find((u) => canonical(u.email) === canonical(email))
  || null;

const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();

  if (sql.includes('split_part') && sql.startsWith('SELECT * FROM users')) {
    const hit = findByEmail(params[0]);
    return { rows: hit ? [hit] : [] };
  }
  if (sql.includes("oauth_provider = 'apple' AND oauth_id")) {
    return { rows: users.filter((u) => u.oauth_provider === 'apple' && u.oauth_id === params[0]) };
  }
  if (sql === 'SELECT * FROM users WHERE LOWER(email) = LOWER($1)') {
    return { rows: users.filter((u) => String(u.email).toLowerCase() === String(params[0]).toLowerCase()) };
  }
  if (sql.startsWith('INSERT INTO users')) {
    const row = {
      id: nextUserId++, token_version: 0, is_banned: false, password: null,
      oauth_provider: null, oauth_id: null, date_of_birth: null, role: 'user',
      verified_email: null, email_verified: false,
      apple_refresh_token: null, apple_refresh_client_id: null,
    };
    // Walks the column list and the VALUES list together, so the test reads
    // the statement the route really sends and a column added at the end
    // (apple_refresh_client_id, $7) is stored as written.
    const flat = sql.replace(/NOW\(\)/gi, 'NOW');
    const cols = flat.slice(flat.indexOf('(') + 1, flat.indexOf(')')).split(',').map((c) => c.trim());
    const valsStart = flat.indexOf('(', flat.indexOf('VALUES'));
    const vals = flat.slice(valsStart + 1, flat.indexOf(')', valsStart)).split(',').map((v) => v.trim());
    cols.forEach((col, i) => {
      const v = vals[i];
      if (v === undefined) return;
      if (/^\$\d+$/.test(v)) { row[col] = params[Number(v.slice(1)) - 1]; return; }
      if (/^NOW$/i.test(v)) { row[col] = new Date().toISOString(); return; }
      if (/^TRUE$/i.test(v)) { row[col] = true; return; }
      if (/^FALSE$/i.test(v)) { row[col] = false; return; }
      row[col] = v.replace(/^'|'$/g, '');
    });
    users.push(row);
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE users SET apple_refresh_token')) {
    const row = users.find((u) => u.id === params[1]);
    if (!row) return { rows: [], rowCount: 0 };
    row.apple_refresh_token = params[0];
    if (sql.includes('apple_refresh_client_id = $3')) row.apple_refresh_client_id = params[2];
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE users SET date_of_birth')) {
    const row = users.find((u) => u.id === params[1]);
    const guarded = sql.includes('date_of_birth IS NULL');
    if (!row || (guarded && row.date_of_birth)) return { rows: [], rowCount: 0 };
    row.date_of_birth = params[0];
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith('SELECT date_of_birth FROM users WHERE id')) {
    const row = users.find((u) => u.id === params[0]);
    return { rows: row ? [{ date_of_birth: row.date_of_birth }] : [] };
  }
  if (sql.startsWith('SELECT 1 FROM banned_identities')) return { rows: [] };
  if (sql.startsWith('DELETE FROM banned_identities')) return { rows: [], rowCount: 0 };
  // Everything else on this path (the waitlist link, the first-week record,
  // refresh credentials, sign-in bookkeeping) is not what is under test, and
  // every one of those writers tolerates an empty answer.
  return { rows: [], rowCount: 0 };
};

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const fakeIo = { in: () => ({ disconnectSockets: () => {} }) };
const app = express();
app.use(express.json());
app.set('io', fakeIo);
app.use('/api/auth', authRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => { pool.query = realQuery; pool.end().catch(() => {}); });

const APP_ORIGIN = 'capacitor://localhost';
const WEB_ORIGIN = 'https://www.flockcorp.com';

// http.request rather than fetch, because a fetch implementation may treat
// Origin as a header it sets itself.
function post(path, body, origin) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(base + path);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (origin) headers.Origin = origin;
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const fromApp = (body) => post('/api/auth/apple', body, APP_ORIGIN);
const fromWeb = (body) => post('/api/auth/apple', body, WEB_ORIGIN);

// What the website's button does before each popup.
async function webNonce() {
  const res = await post('/api/auth/apple/nonce', {}, WEB_ORIGIN);
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  assert.ok(res.json.nonce);
  return res.json.nonce;
}

// One website popup: a token for the Services ID carrying the nonce, and the
// body the button posts with it.
async function webPopup(claims, extra = {}) {
  const nonce = await webNonce();
  const identityToken = appleIdentityToken({ aud: WEB_CLIENT, nonce, ...claims });
  return { identityToken, nonce, ...extra };
}

function reset() {
  users = [];
  nextUserId = 1;
  apple.configured = false;
  apple.exchanges = [];
  clearUnderageAttempts();
}

function seedAppleUser(over = {}) {
  const row = {
    id: nextUserId++, email: 'ada@icloud.com', name: 'Ada Park', password: null, token_version: 0,
    is_banned: false, oauth_provider: 'apple', oauth_id: 'apple-ada', date_of_birth: '2001-12-31',
    role: 'user', email_verified: true, verified_email: 'ada@icloud.com',
    apple_refresh_token: null, apple_refresh_client_id: null, ...over,
  };
  users.push(row);
  return row;
}

const ADA = { sub: 'apple-ada', email: 'ada@icloud.com' };

// ===========================================================================
// The audience
// ===========================================================================
test('a token for the app or for the website is accepted, and one for any other client is not', async () => {
  reset();
  seedAppleUser();
  const app = await fromApp({ identityToken: appleIdentityToken({ ...ADA, aud: APP_CLIENT }) });
  assert.strictEqual(app.status, 200, JSON.stringify(app.json));

  const web = await fromWeb(await webPopup(ADA));
  assert.strictEqual(web.status, 200, JSON.stringify(web.json));
  assert.strictEqual(web.json.user.id, app.json.user.id);

  // A valid Apple signature minted for somebody else's app or website.
  for (const aud of ['com.example.other', 'com.flockcorp.flock.web.evil', 'com.flockcorp']) {
    const res = await fromWeb(await webPopup({ ...ADA, aud }));
    assert.strictEqual(res.status, 401, `${aud} must not sign in`);
    assert.ok(!res.json.token);
  }
  // And a token that names no audience at all.
  const nonce = await webNonce();
  const unaddressed = jwt.sign({ iss: 'https://appleid.apple.com', ...ADA, nonce, jti: crypto.randomUUID() }, APPLE_PRIV,
    { algorithm: 'RS256', expiresIn: '10m', keyid: 'test-kid' });
  const res = await fromWeb({ identityToken: unaddressed, nonce });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(users.length, 1);
});

test('the audience list is fixed in code, both entries with a fallback, so an unset variable still checks one', () => {
  const src = require('node:fs').readFileSync(require.resolve('../routes/auth'), 'utf8');
  assert.match(src, /const APPLE_APP_AUDIENCE = process\.env\.APPLE_BUNDLE_ID \|\| 'com\.flockcorp\.flock';/);
  assert.match(src, /const APPLE_WEB_CLIENT_ID = process\.env\.APPLE_WEB_CLIENT_ID \|\| 'com\.flockcorp\.flock\.web';/);
  assert.match(src, /audience: \[APPLE_APP_AUDIENCE, APPLE_WEB_CLIENT_ID\],/);
});

// ===========================================================================
// One Apple ID, one Flock account, on both
// ===========================================================================
test('an Apple ID first used in the iPhone app signs in on the website as the same account', async () => {
  reset();
  const made = await fromApp({
    identityToken: appleIdentityToken({ sub: 'apple-cross', email: 'cross@icloud.com', aud: APP_CLIENT }),
    fullName: { givenName: 'Cam', familyName: 'Reyes' },
  });
  assert.strictEqual(made.status, 200, JSON.stringify(made.json));
  assert.strictEqual(users.length, 1);
  const id = made.json.user.id;

  // The iPhone app asked for no date of birth, and the website asks every
  // account with none on file for its full date (the backfill), Apple or not.
  const first = await fromWeb(await webPopup({ sub: 'apple-cross', email: 'cross@icloud.com' }));
  assert.strictEqual(first.status, 403, JSON.stringify(first.json));
  assert.strictEqual(first.json.needsDob, true);
  assert.ok(!('dobGranularity' in first.json), 'an existing account is asked for the full date');

  // Apple's later sign-ins carry no email; the sub alone finds the row.
  const second = await fromWeb(await webPopup({ sub: 'apple-cross', email: undefined }, { date_of_birth: '2003-04-05' }));
  assert.strictEqual(second.status, 200, JSON.stringify(second.json));
  assert.strictEqual(second.json.user.id, id, 'the same Flock account');
  assert.strictEqual(users.length, 1, 'and no second row');
  assert.strictEqual(users[0].name, 'Cam Reyes');
  assert.strictEqual(users[0].date_of_birth, '2003-04-05');
});

test('an app account that already has a date of birth signs in on the website straight away', async () => {
  reset();
  const row = seedAppleUser();
  const res = await fromWeb(await webPopup(ADA));
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  assert.strictEqual(res.json.user.id, row.id);
  assert.strictEqual(users.length, 1);
});

// ===========================================================================
// The nonce
// ===========================================================================
test('a website token with no nonce is refused, while the app still signs in without one', async () => {
  reset();
  seedAppleUser();
  const res = await fromWeb({ identityToken: appleIdentityToken({ ...ADA, aud: WEB_CLIENT }) });
  assert.strictEqual(res.status, 400);
  assert.ok(!res.json.token);
  // The app's flow is exactly what build 49 sends today.
  const app = await fromApp({ identityToken: appleIdentityToken({ ...ADA, aud: APP_CLIENT }) });
  assert.strictEqual(app.status, 200, JSON.stringify(app.json));
});

test('a website nonce has to be one this server issued, has to match the token, and works once', async () => {
  reset();
  seedAppleUser();
  // Made up by the caller.
  const invented = crypto.randomBytes(24).toString('base64url');
  const a = await fromWeb({ identityToken: appleIdentityToken({ ...ADA, aud: WEB_CLIENT, nonce: invented }), nonce: invented });
  assert.strictEqual(a.status, 401);

  // Issued, but the token was minted for another one.
  const issued = await webNonce();
  const other = await webNonce();
  const b = await fromWeb({ identityToken: appleIdentityToken({ ...ADA, aud: WEB_CLIENT, nonce: other }), nonce: issued });
  assert.strictEqual(b.status, 401);

  // Issued and matching: in. Apple may echo the nonce raw or as its SHA-256.
  const hashed = crypto.createHash('sha256').update(issued).digest('hex');
  const c = await fromWeb({ identityToken: appleIdentityToken({ ...ADA, aud: WEB_CLIENT, nonce: hashed }), nonce: issued });
  assert.strictEqual(c.status, 200, JSON.stringify(c.json));

  // Spent by that sign-in, so a second token bound to it gets nowhere.
  const d = await fromWeb({ identityToken: appleIdentityToken({ ...ADA, aud: WEB_CLIENT, nonce: issued }), nonce: issued });
  assert.strictEqual(d.status, 401);
});

// ===========================================================================
// A new account from the website
// ===========================================================================
test('a new Apple account from the website is asked for its year, then created from the same popup', async () => {
  reset();
  apple.configured = true;
  const popup = await webPopup(
    { sub: 'apple-new-web', email: 'new@privaterelay.appleid.com' },
    { authorizationCode: 'code-web-1', fullName: { givenName: 'Noor', familyName: 'Ali' } },
  );
  const asked = await fromWeb(popup);
  assert.strictEqual(asked.status, 403, JSON.stringify(asked.json));
  assert.strictEqual(asked.json.needsDob, true);
  assert.strictEqual(asked.json.dobGranularity, 'year', 'the same year question the website asks for Google');
  assert.deepStrictEqual(users, []);
  assert.deepStrictEqual(apple.exchanges, [], 'the one-use code is not spent on a refusal');

  // The same credentials, sent again with the year (makeResume on the button).
  const made = await fromWeb({ ...popup, date_of_birth: '2004-12-31', dob_granularity: 'year' });
  assert.strictEqual(made.status, 200, JSON.stringify(made.json));
  assert.strictEqual(users.length, 1);
  assert.strictEqual(users[0].name, 'Noor Ali');
  assert.strictEqual(users[0].date_of_birth, '2004-12-31');
  assert.deepStrictEqual(apple.exchanges, [{ code: 'code-web-1', clientId: WEB_CLIENT }],
    "a website code is exchanged as the website's Services ID");
  assert.strictEqual(users[0].apple_refresh_token, 'rt-code-web-1');
  assert.strictEqual(users[0].apple_refresh_client_id, WEB_CLIENT);
});

test('the website refuses an under-13 year for Apple in the same neutral words as everywhere else', async () => {
  reset();
  const res = await fromWeb(await webPopup({ sub: 'apple-kid', email: 'kid@icloud.com' },
    { date_of_birth: '2016-12-31', dob_granularity: 'year' }));
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.json.error, UNDERAGE_MSG);
  assert.ok(!('needsDob' in res.json));
  assert.deepStrictEqual(users, []);
});

test('a new account from the app keeps the app as its client: no year, and no client id stored', async () => {
  reset();
  apple.configured = true;
  const res = await fromApp({
    identityToken: appleIdentityToken({ sub: 'apple-new-app', email: 'app@icloud.com', aud: APP_CLIENT }),
    authorizationCode: 'code-app-1',
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  assert.deepStrictEqual(apple.exchanges, [{ code: 'code-app-1', clientId: undefined }]);
  assert.strictEqual(users[0].apple_refresh_token, 'rt-code-app-1');
  assert.strictEqual(users[0].apple_refresh_client_id, null, 'NULL is the app');
  assert.strictEqual(users[0].date_of_birth, null);
});

// ===========================================================================
// The stored token and its client move together
// ===========================================================================
test('each sign-in that brings a code replaces the stored token and the client it belongs to', async () => {
  reset();
  apple.configured = true;
  const row = seedAppleUser({ apple_refresh_token: 'rt-old', apple_refresh_client_id: null });

  const web = await fromWeb(await webPopup(ADA, { authorizationCode: 'code-w' }));
  assert.strictEqual(web.status, 200, JSON.stringify(web.json));
  assert.strictEqual(row.apple_refresh_token, 'rt-code-w');
  assert.strictEqual(row.apple_refresh_client_id, WEB_CLIENT);

  const app = await fromApp({ identityToken: appleIdentityToken({ ...ADA, aud: APP_CLIENT }), authorizationCode: 'code-i' });
  assert.strictEqual(app.status, 200, JSON.stringify(app.json));
  assert.strictEqual(row.apple_refresh_token, 'rt-code-i');
  assert.strictEqual(row.apple_refresh_client_id, null);

  assert.deepStrictEqual(apple.exchanges.map((e) => e.clientId), [WEB_CLIENT, undefined]);
});

test('the response never carries the stored Apple credential', async () => {
  reset();
  seedAppleUser({ apple_refresh_token: 'rt-secret', apple_refresh_client_id: WEB_CLIENT });
  const res = await fromWeb(await webPopup(ADA));
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  assert.ok(!('apple_refresh_token' in res.json.user));
  assert.ok(!JSON.stringify(res.json).includes('rt-secret'));
});
