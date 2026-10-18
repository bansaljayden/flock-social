// Run: node --test __tests__/iosAppNoDateOfBirth.test.js  (from backend/)
//
// THE IPHONE APP ASKS NOBODY FOR A DATE OF BIRTH.
//
// App Review rejected version 1.0 (build 47) on 2026-10-18 under guideline
// 5.1.1(v): "Update the app to not require users to provide the following
// personal information: Date of Birth". The iPhone app now asks for none and
// relies on the App Store's 13+ age rating; the website keeps its neutral age
// screen. utils/clientShell.js recognises the app by the Origin its WebView
// sends (capacitor://localhost), and routes/auth.js reads it on every path that
// used to answer needsDob. What is pinned here:
//
//   - from the app, all three creation doors (password, Google, Apple) and
//     every sign-in go through with no date at all, and the row stores none;
//   - from the website, every one of them still refuses without a date;
//   - a date the app does send is still judged: under 13 is refused with the
//     same neutral sentence, and the retry lockout still holds;
//   - an account we know to be under 13 stays frozen when it signs in from the
//     app, and a full under-13 date the app sends to a legacy account still
//     freezes it;
//   - a year-derived date from the app is never written onto an existing row;
//   - the delete and export dialogs' "confirm it's you" sheet (reconfirm) never
//     creates an account, now that a missing date no longer refuses one.
//
// No database is touched: pool.query is a dispatcher over in-memory tables, the
// technique minorsCompliance.test.js uses.

process.env.JWT_SECRET = 'test-secret-for-ios-no-dob-tests';
process.env.GOOGLE_CLIENT_ID = 'flock-test.apps.googleusercontent.com';
process.env.PUBLIC_WEB_URL = 'http://localhost:3000';
process.env.PUBLIC_API_URL = 'http://localhost:5000';
delete process.env.RESEND_API_KEY;
delete process.env.APPLE_REQUIRE_NONCE;
delete process.env.NODE_ENV;

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const { pinClock } = require('./helpers/pinnedClock');
const pinnedClock = pinClock(Date.UTC(2026, 9, 18, 12, 0, 0));
test.after(() => pinnedClock.restore());

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
const appleAuthPath = require.resolve('../services/appleAuth');
require.cache[appleAuthPath] = {
  id: appleAuthPath, filename: appleAuthPath, loaded: true,
  exports: {
    isConfigured: () => false,
    exchangeAppleCode: async () => ({}),
    revokeAppleToken: async () => {},
  },
};

const appleIdentityToken = (claims) => jwt.sign(
  { iss: 'https://appleid.apple.com', aud: 'com.flockcorp.flock', ...claims },
  APPLE_PRIV,
  { algorithm: 'RS256', expiresIn: '10m', keyid: 'test-kid' }
);

const pool = require('../config/database');
const authRouter = require('../routes/auth');
const { UNDERAGE_MSG, clearUnderageAttempts } = authRouter.__testing;
const { IOS_APP_ORIGINS, isIOSAppRequest } = require('../utils/clientShell');

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
  if (sql.includes("oauth_provider = 'google' AND oauth_id")) {
    return { rows: users.filter((u) => u.oauth_provider === 'google' && u.oauth_id === params[0]) };
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
      venmo_username: null, cashapp_cashtag: null, zelle_identifier: null,
      verified_email: null, email_verified: false,
    };
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
    const m = /RETURNING (.+)$/i.exec(sql);
    if (m && m[1].trim() !== '*') {
      const out = {};
      for (const col of m[1].split(',').map((c) => c.trim())) out[col] = row[col];
      return { rows: [out], rowCount: 1 };
    }
    return { rows: [row], rowCount: 1 };
  }
  // The guarded backfill write (WHERE ... AND date_of_birth IS NULL) and the
  // unguarded under-13 freeze write both start this way.
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
  if (sql.startsWith('SELECT COUNT(*)') && sql.includes('FROM email_verifications')) {
    return { rows: [{ account_hour: 0, account_day: 0, account_last: null, ip_hour: 0 }] };
  }
  // Everything else on these paths (verification mail rows, the waitlist link,
  // the first-week record, refresh credentials, sign-in bookkeeping) is not
  // what is under test, and every one of those writers tolerates an empty
  // answer.
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
const fromApp = (path, body) => post(path, body, APP_ORIGIN);
// The Google route refuses a replayed access token, so every call gets its own.
const freshToken = () => `opaque-${crypto.randomUUID()}`;
const fromWeb = (path, body) => post(path, body, WEB_ORIGIN);

async function withGoogle(profile, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('googleapis.com')) {
      if (u.includes('tokeninfo')) return { ok: true, json: async () => ({ aud: process.env.GOOGLE_CLIENT_ID }) };
      return { ok: true, json: async () => profile };
    }
    return saved(url, init);
  };
  try { return await fn(); } finally { globalThis.fetch = saved; }
}

function reset() {
  users = [];
  nextUserId = 1;
  clearUnderageAttempts();
}

const PASSWORD_HASH = bcrypt.hashSync('Password1', 4);
function mkPasswordUser(email, dob = null) {
  const row = {
    id: nextUserId++, email, name: 'Legacy', password: PASSWORD_HASH,
    token_version: 0, is_banned: false, oauth_provider: null, oauth_id: null,
    date_of_birth: dob, role: 'user', email_verified: true, verified_email: email,
  };
  users.push(row);
  return row;
}

const ADULT_DOB = '2000-01-01';
const CHILD_DOB = '2016-05-05'; // ten on the pinned date
const signupBody = (over = {}) => ({ email: 'sam@example.com', password: 'Password1', name: 'Sam Lee', ...over });

// ===========================================================================
// How the app is recognised
// ===========================================================================
test('the iPhone app is exactly the WebView origins Capacitor serves iOS from', () => {
  assert.deepStrictEqual([...IOS_APP_ORIGINS], ['capacitor://localhost', 'ionic://localhost']);
  const req = (origin) => ({ get: (h) => (h.toLowerCase() === 'origin' ? origin : undefined) });
  assert.strictEqual(isIOSAppRequest(req('capacitor://localhost')), true);
  assert.strictEqual(isIOSAppRequest(req('ionic://localhost')), true);
  // Android's shell and a laptop's dev server send these, and the website is
  // never the app.
  for (const other of ['https://localhost', 'http://localhost', 'http://localhost:3000',
    'https://www.flockcorp.com', 'https://flockcorp.com', 'capacitor://localhost.evil.example',
    'Capacitor://localhost', 'null', '', undefined]) {
    assert.strictEqual(isIOSAppRequest(req(other)), false, `${other} is not the iPhone app`);
  }
  assert.strictEqual(isIOSAppRequest(undefined), false);
  assert.strictEqual(isIOSAppRequest({ headers: { origin: 'capacitor://localhost' } }), true,
    'a request without Express helpers is read from its raw headers');
});

test('server.js lets the app origin through CORS, and the app is still served from it', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSrc, /'capacitor:\/\/localhost',/);
  // The app's origin moves if the WebView is given a scheme, a hostname or a
  // remote URL. capacitor.config.ts parks exactly that change; if it ever
  // lands, this rule and frontend lib/nativeShell.js isIOSAppShell() must move
  // with it, or the server starts asking the app for a date of birth again.
  const cap = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'capacitor.config.ts'), 'utf8');
  const code = cap.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  assert.doesNotMatch(code, /\biosScheme\s*:/);
  assert.doesNotMatch(code, /\bhostname\s*:/);
  assert.doesNotMatch(code, /\bserver\s*:/);
});

// ===========================================================================
// Password sign-up
// ===========================================================================
test('password sign-up from the app needs no date of birth, and the row stores none', async () => {
  reset();
  const res = await fromApp('/api/auth/signup', signupBody());
  assert.strictEqual(res.status, 201, JSON.stringify(res.json));
  assert.ok(!('needsDob' in res.json));
  assert.strictEqual(users.length, 1);
  assert.strictEqual(users[0].date_of_birth, null);
});

test('a null or blank date from the app counts as no date', async () => {
  reset();
  const a = await fromApp('/api/auth/signup', signupBody({ email: 'a@example.com', date_of_birth: null }));
  assert.strictEqual(a.status, 201, JSON.stringify(a.json));
  const b = await fromApp('/api/auth/signup', signupBody({ email: 'b@example.com', date_of_birth: '  ' }));
  assert.strictEqual(b.status, 201, JSON.stringify(b.json));
  assert.deepStrictEqual(users.map((u) => u.date_of_birth), [null, null]);
});

test('password sign-up from the website still refuses without a date of birth', async () => {
  reset();
  for (const send of [fromWeb, (p, b) => post(p, b)]) {
    const res = await send('/api/auth/signup', signupBody());
    assert.strictEqual(res.status, 400);
    assert.match(res.json.error, /date of birth/i);
  }
  assert.deepStrictEqual(users, []);
});

test('a date the app does send is judged: under 13 is refused neutrally, and the retry is locked out', async () => {
  reset();
  const kid = await fromApp('/api/auth/signup', signupBody({ date_of_birth: CHILD_DOB }));
  assert.strictEqual(kid.status, 403);
  assert.strictEqual(kid.json.error, UNDERAGE_MSG);
  assert.ok(!('needsDob' in kid.json));
  // Back-button, no date this time: the lockout still answers.
  const retry = await fromApp('/api/auth/signup', signupBody());
  assert.strictEqual(retry.status, 403);
  assert.strictEqual(retry.json.error, UNDERAGE_MSG);
  assert.deepStrictEqual(users, []);
});

test('a malformed date from the app is still refused by its shape, not stored', async () => {
  reset();
  const res = await fromApp('/api/auth/signup', signupBody({ date_of_birth: 'next tuesday' }));
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(users, []);
});

test('an adult date from the app is stored as the website would store it', async () => {
  reset();
  const res = await fromApp('/api/auth/signup', signupBody({ date_of_birth: ADULT_DOB }));
  assert.strictEqual(res.status, 201);
  assert.strictEqual(users[0].date_of_birth, '2000-12-31');
});

// ===========================================================================
// Google and Apple account creation
// ===========================================================================
test('a new Google account from the app is created with no date and no year question', async () => {
  reset();
  const profile = { sub: 'g-new', email: 'new@gmail.com', email_verified: true, name: 'New Person' };
  const res = await withGoogle(profile, () => fromApp('/api/auth/google', { access_token: freshToken() }));
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  assert.ok(res.json.token);
  assert.ok(!('needsDob' in res.json));
  assert.strictEqual(users.length, 1);
  assert.strictEqual(users[0].date_of_birth, null);
});

test('a new Google account from the website is still asked for its year', async () => {
  reset();
  const profile = { sub: 'g-web', email: 'web@gmail.com', email_verified: true, name: 'Web Person' };
  const res = await withGoogle(profile, () => fromWeb('/api/auth/google', { access_token: freshToken() }));
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.json.needsDob, true);
  assert.strictEqual(res.json.dobGranularity, 'year');
  assert.deepStrictEqual(users, []);
});

test('a new Apple account from the app is created with no date and no year question', async () => {
  reset();
  const res = await fromApp('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'apple-new', email: 'new@icloud.com', email_verified: true }),
    fullName: { givenName: 'Ada', familyName: 'Park' },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  assert.ok(res.json.token);
  assert.ok(!('needsDob' in res.json));
  assert.strictEqual(users.length, 1);
  assert.strictEqual(users[0].date_of_birth, null);
  assert.strictEqual(users[0].name, 'Ada Park');
});

test('an under-13 date the app sends with Apple or Google is still refused neutrally', async () => {
  reset();
  const apple = await fromApp('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'apple-kid', email: 'kid@icloud.com', email_verified: true }),
    date_of_birth: CHILD_DOB,
  });
  assert.strictEqual(apple.status, 403);
  assert.strictEqual(apple.json.error, UNDERAGE_MSG);
  reset();
  const profile = { sub: 'g-kid', email: 'kid@gmail.com', email_verified: true, name: 'Kid' };
  const google = await withGoogle(profile, () => fromApp('/api/auth/google', { access_token: freshToken(), date_of_birth: CHILD_DOB }));
  assert.strictEqual(google.status, 403);
  assert.strictEqual(google.json.error, UNDERAGE_MSG);
  assert.deepStrictEqual(users, []);
});

// ===========================================================================
// Sign-in to an account that has no date on file
// ===========================================================================
test('an account with no date on file signs in from the app without being asked for one', async () => {
  reset();
  const row = mkPasswordUser('legacy@example.com');
  const res = await fromApp('/api/auth/login', { email: 'legacy@example.com', password: 'Password1' });
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  assert.ok(res.json.token);
  assert.strictEqual(row.date_of_birth, null);
});

test('the same account is still asked for its full date on the website', async () => {
  reset();
  mkPasswordUser('legacy@example.com');
  const res = await fromWeb('/api/auth/login', { email: 'legacy@example.com', password: 'Password1' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.json.needsDob, true);
  assert.ok(!('dobGranularity' in res.json), 'the backfill asks for the full date');
});

test('a year-derived date from the app is never written onto an existing account', async () => {
  reset();
  const row = mkPasswordUser('legacy@example.com');
  const res = await fromApp('/api/auth/login', {
    email: 'legacy@example.com', password: 'Password1', date_of_birth: '2012-12-31', dob_granularity: 'year',
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  assert.strictEqual(row.date_of_birth, null);
});

test('a full under-13 date the app sends to a legacy account still freezes it', async () => {
  reset();
  const row = mkPasswordUser('legacy@example.com');
  const res = await fromApp('/api/auth/login', {
    email: 'legacy@example.com', password: 'Password1', date_of_birth: CHILD_DOB,
  });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.json.error, UNDERAGE_MSG);
  assert.ok(!('token' in res.json));
  assert.strictEqual(row.date_of_birth, CHILD_DOB);
  const later = await fromApp('/api/auth/login', { email: 'legacy@example.com', password: 'Password1' });
  assert.strictEqual(later.status, 403, 'the freeze holds on the next sign-in from the app');
});

test('an account we know to be under 13 cannot sign in from the app', async () => {
  reset();
  mkPasswordUser('frozen@example.com', CHILD_DOB);
  const res = await fromApp('/api/auth/login', { email: 'frozen@example.com', password: 'Password1' });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.json.error, UNDERAGE_MSG);
  assert.ok(!('needsDob' in res.json));
  assert.ok(!('token' in res.json));
});

// ===========================================================================
// The delete and export dialogs never create an account
// ===========================================================================
test('"confirm it\'s you" with an Apple ID that has no account creates nothing', async () => {
  reset();
  const res = await fromApp('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'apple-stranger', email: 'stranger@icloud.com', email_verified: true }),
    reconfirm: true,
  });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.json.noAccount, true);
  assert.ok(!('needsDob' in res.json));
  assert.deepStrictEqual(users, []);
});

test('"confirm it\'s you" with a Google account that has no account creates nothing, on the app or the website', async () => {
  for (const send of [fromApp, fromWeb]) {
    reset();
    const profile = { sub: 'g-stranger', email: 'stranger@gmail.com', email_verified: true, name: 'Stranger' };
    const res = await withGoogle(profile, () => send('/api/auth/google', { access_token: freshToken(), reconfirm: true }));
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.json.noAccount, true);
    assert.deepStrictEqual(users, []);
  }
});

test('"confirm it\'s you" with the account\'s own Apple ID signs it in as before', async () => {
  reset();
  users.push({
    id: nextUserId++, email: 'owner@icloud.com', name: 'Owner', password: null, token_version: 0,
    is_banned: false, oauth_provider: 'apple', oauth_id: 'apple-owner', date_of_birth: null,
    role: 'user', email_verified: true, verified_email: 'owner@icloud.com',
  });
  const res = await fromApp('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'apple-owner', email: 'owner@icloud.com', email_verified: true }),
    reconfirm: true,
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  assert.strictEqual(res.json.user.id, 1);
  assert.strictEqual(users.length, 1);
});
