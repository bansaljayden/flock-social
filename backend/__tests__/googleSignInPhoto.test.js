// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// A GOOGLE SIGN-IN DOES NOT BRING THE GOOGLE PHOTO (2026-10-06)
// ---------------------------------------------------------------------------
//
// POST /api/auth/google read the token's `picture` claim and stored it as
// users.profile_image_url: on every new Google account, and, through a
// COALESCE, on a password account the sign-in claimed while it had no avatar.
// Every other avatar comes in through routes/users.js, which screens it
// (moderateImage), strips its metadata and stores a data URL. This one was a
// link to Google's image host that none of that ever saw, drawn on every
// roster, chat row and friends list, so a picture the upload screen refuses
// could be set as the Google photo and carried in by signing in.
//
// What is pinned:
//   * both branches (ID token and access token) create the account with no
//     avatar, and the link never reaches the database as any parameter;
//   * a claimed account keeps exactly the avatar it had, none or its own;
//   * routes/auth.js does not read the claim at all, so a third branch added
//     later cannot quietly start storing it again;
//   * migration 120 clears exactly the Google-hosted links and nothing else.
//
// No database and no network: google-auth-library, fetch and pool.query are
// fixtures. The users fake EXECUTES the INSERT and the claim UPDATE (columns,
// placeholders, COALESCE) rather than recognising them, so the row this file
// reads is the row the route's own statement would leave behind.

// Env must be set before ANY require.
process.env.JWT_SECRET = 'google-photo-test-secret';
process.env.GOOGLE_CLIENT_ID = 'flock-photo.apps.googleusercontent.com';
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

// The ID-token branch. Keyed on the credential string, the way
// googleReplayAndThrottle.test.js keys it.
const googlePayloads = new Map();
const googleLibPath = require.resolve('google-auth-library');
require.cache[googleLibPath] = {
  id: googleLibPath, filename: googleLibPath, loaded: true,
  exports: {
    OAuth2Client: class {
      async verifyIdToken({ idToken }) {
        const payload = googlePayloads.get(idToken);
        if (!payload) throw new Error('Invalid token');
        return { getPayload: () => payload };
      }
    },
  },
};

// A real Google profile photo link, the shape the claim carries.
const PICTURE = 'https://lh3.googleusercontent.com/a/ACg8ocJfakePhotoForTests000=s96-c';
const PICTURE_HOST = 'lh3.googleusercontent.com';

// The access-token branch asks Google twice: tokeninfo for the audience, then
// userinfo for the profile. Both answered here, everything else refused, so
// nothing in this file can reach the network.
const realFetch = global.fetch;
let userinfoProfile = null;
global.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
    return { ok: true, json: async () => ({ aud: process.env.GOOGLE_CLIENT_ID, expires_in: 3600 }) };
  }
  if (u.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
    return { ok: true, json: async () => userinfoProfile };
  }
  throw new Error(`unexpected outbound fetch: ${u}`);
};

const pool = require('../config/database');
const authRouter = require('../routes/auth');
const { canonicalEmail } = authRouter.__testing;

// ---------------------------------------------------------------------------
// The users table, and an evaluator for the two statements that write it
// ---------------------------------------------------------------------------
let users = [];
let nextUserId = 1;
let statements = []; // { sql, params } for every query the route sends

// Split on a top-level comma: COALESCE(a, b) and NOW() keep theirs.
function splitTop(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

// The expressions the two users writes actually use. Anything else throws, so
// a statement this file does not understand fails loudly instead of being
// half applied.
function evalExpr(expr, row, params) {
  const e = expr.trim();
  let m;
  if ((m = /^\$(\d+)$/.exec(e))) return params[Number(m[1]) - 1] ?? null;
  if (/^NULL$/i.test(e)) return null;
  if (/^TRUE$/i.test(e)) return true;
  if (/^FALSE$/i.test(e)) return false;
  if (/^NOW\(\)$/i.test(e)) return new Date().toISOString();
  if ((m = /^'([^']*)'$/.exec(e))) return m[1];
  if ((m = /^([a-z_]+) \+ 1$/i.exec(e))) return Number(row[m[1]]) + 1;
  if ((m = /^COALESCE\(([\s\S]+)\)$/i.exec(e))) {
    for (const arg of splitTop(m[1])) {
      const v = evalExpr(arg, row, params);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  }
  if (/^[a-z_]+$/i.test(e)) return row[e];
  throw new Error(`fake: unsupported expression "${e}"`);
}

function insertUser(sql, params) {
  const flat = sql.replace(/NOW\(\)/gi, 'NOW()');
  const cols = splitTop(flat.slice(flat.indexOf('(') + 1, flat.indexOf(')')));
  const valuesAt = flat.indexOf('VALUES');
  const open = flat.indexOf('(', valuesAt);
  let depth = 0;
  let close = open;
  for (; close < flat.length; close += 1) {
    if (flat[close] === '(') depth += 1;
    else if (flat[close] === ')') { depth -= 1; if (depth === 0) break; }
  }
  const vals = splitTop(flat.slice(open + 1, close));
  assert.strictEqual(cols.length, vals.length, `fake: column/value count mismatch in ${sql}`);
  const row = {
    id: nextUserId++, token_version: 0, is_banned: false, password: null,
    oauth_provider: null, oauth_id: null, profile_image_url: null,
    email_verified: false, verified_email: null, date_of_birth: null,
  };
  cols.forEach((col, i) => { row[col] = evalExpr(vals[i], row, params); });
  users.push(row);
  return { rows: [{ ...row }], rowCount: 1 };
}

// UPDATE users SET <assignments> WHERE id = $n RETURNING *. Every right-hand
// side is read against the row as it was before the statement, as one SQL
// statement sees one snapshot.
function updateUser(sql, params) {
  const m = /^UPDATE users SET ([\s\S]+?) WHERE id = \$(\d+)(?: RETURNING \*)?$/.exec(sql);
  if (!m) throw new Error(`fake: cannot parse ${sql}`);
  const row = users.find((u) => u.id === params[Number(m[2]) - 1]);
  if (!row) return { rows: [], rowCount: 0 };
  const next = {};
  for (const a of splitTop(m[1])) {
    const eq = a.indexOf('=');
    next[a.slice(0, eq).trim()] = evalExpr(a.slice(eq + 1), row, params);
  }
  Object.assign(row, next);
  return { rows: [{ ...row }], rowCount: 1 };
}

const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  statements.push({ sql, params });

  if (sql.includes("oauth_provider = 'google' AND oauth_id")) {
    return { rows: users.filter((u) => u.oauth_provider === 'google' && u.oauth_id === params[0]) };
  }
  if (sql.startsWith('SELECT * FROM users') && sql.includes('split_part')) {
    const hit = users.find((u) => canonicalEmail(u.email) === canonicalEmail(params[0])) || null;
    return { rows: hit ? [{ ...hit }] : [] };
  }
  if (sql.startsWith('INSERT INTO users')) return insertUser(sql, params);
  if (sql.startsWith("UPDATE users SET oauth_provider = 'google'")) return updateUser(sql, params);
  // The first-week check after a new account (migration 076): no returning
  // identity in this file.
  if (sql.startsWith('UPDATE users SET grace_forfeited')) return { rows: [], rowCount: 0 };
  // Side tables a sign-in touches, none of them under test here.
  if (sql.startsWith('SELECT 1 FROM banned_identities')) return { rows: [] };
  if (sql.startsWith('DELETE FROM banned_identities')) return { rows: [], rowCount: 0 };
  if (sql.startsWith('DELETE FROM grace_spent_identities')) return { rows: [], rowCount: 0 };
  if (sql.startsWith('UPDATE waitlist')) return { rows: [], rowCount: 0 };
  if (sql.startsWith('DELETE FROM device_tokens')) return { rows: [], rowCount: 0 };
  if (sql.startsWith('INSERT INTO refresh_tokens')) return { rows: [], rowCount: 0 };

  throw new Error(`unstubbed query: ${sql.slice(0, 140)}`);
};

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.set('io', { in: () => ({ disconnectSockets: () => {} }) });
app.use('/api/auth', authRouter);

const server = app.listen(0, '127.0.0.1');
test.after(() => {
  server.close();
  pool.query = realQuery;
  global.fetch = realFetch;
});

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: data, json: () => (data ? JSON.parse(data) : {}) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function reset() {
  users = [];
  nextUserId = 1;
  statements = [];
  userinfoProfile = null;
  authRouter.__testing.clearUnderageAttempts();
  authRouter.__testing.clearOauthIdentityClaims();
}

// An ID token is three base64url segments before the route looks at it.
let credentialSeq = 0;
function googleCredential(claims) {
  credentialSeq += 1;
  const seg = () => crypto.randomBytes(9).toString('base64url');
  const cred = `${seg()}.${seg()}${credentialSeq}.${seg()}`;
  googlePayloads.set(cred, { exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  return cred;
}

// The two ways the route is reached, each carrying the same Google profile.
const BRANCHES = {
  credential: (profile) => ({ credential: googleCredential(profile) }),
  access_token: (profile) => {
    userinfoProfile = profile;
    return { access_token: `opaque-${crypto.randomBytes(6).toString('hex')}` };
  },
};

// The property in one place: nothing the route sent to the database carries
// Google's photo link, whatever column or position it would have gone to.
function assertPictureNeverStored(label) {
  for (const { sql, params } of statements) {
    for (const p of params) {
      assert.ok(!(typeof p === 'string' && p.includes(PICTURE_HOST)),
        `${label}: Google's photo link reached the database in ${sql.slice(0, 90)}`);
    }
  }
}

// ===========================================================================
// A new account
// ===========================================================================

for (const [branch, body] of Object.entries(BRANCHES)) {
  test(`${branch}: a new Google account starts with no avatar, not the Google photo`, async () => {
    reset();
    const profile = {
      sub: `g-new-${branch}`, email: `new-${branch}@gmail.com`, email_verified: true,
      name: 'Nia', picture: PICTURE,
    };
    const res = await post('/api/auth/google', { ...body(profile), date_of_birth: '2000-01-01' });
    assert.strictEqual(res.status, 200, res.text);

    assert.strictEqual(users.length, 1, 'the sign-in should have created exactly one account');
    assert.strictEqual(users[0].profile_image_url, null,
      'the new row holds a Google photo link that was never screened');
    assert.strictEqual(res.json().user.profile_image_url, null,
      'the client was handed the Google photo as the avatar');
    assertPictureNeverStored(branch);
  });
}

// ===========================================================================
// A claimed password account
// ===========================================================================

// An address the password row proved it can read, so claimDecision answers
// 'claim' and the Google identity takes the row over (routes/auth.js).
function addProvedPasswordAccount(email, avatar) {
  const row = {
    id: nextUserId++, email, name: 'Sam', password: '$2a$10$abcdefghijklmnopqrstuv',
    oauth_provider: null, oauth_id: null, email_verified: true, verified_email: email,
    is_banned: false, date_of_birth: '2000-01-01', token_version: 0,
    venmo_username: null, cashapp_cashtag: null, zelle_identifier: null,
    profile_image_url: avatar,
  };
  users.push(row);
  return row;
}

const OWN_PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgK';

for (const [branch, body] of Object.entries(BRANCHES)) {
  for (const [label, avatar] of [['no avatar', null], ['their own photo', OWN_PHOTO]]) {
    test(`${branch}: a claimed account with ${label} keeps it, and gets no Google photo`, async () => {
      reset();
      const row = addProvedPasswordAccount(`sam-${branch}@gmail.com`, avatar);
      const profile = {
        sub: `g-claim-${branch}`, email: row.email, email_verified: true,
        name: 'Sam', picture: PICTURE,
      };
      const res = await post('/api/auth/google', body(profile));
      assert.strictEqual(res.status, 200, res.text);

      assert.strictEqual(row.oauth_provider, 'google', 'the claim never ran, so nothing here was tested');
      assert.strictEqual(row.profile_image_url, avatar,
        `the claimed row's avatar changed from ${JSON.stringify(avatar)} to ${JSON.stringify(row.profile_image_url)}`);
      assert.strictEqual(res.json().user.profile_image_url, avatar);
      assertPictureNeverStored(`${branch} claim`);
    });
  }
}

// ===========================================================================
// The source: the claim is not read anywhere
// ===========================================================================

test('routes/auth.js does not read the picture claim on any branch', () => {
  // Comments stripped: the comment that explains the fix names the claim.
  const code = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\bpicture\b/,
    'a branch reads `picture` again; an avatar comes through the upload route or not at all');
});

// ===========================================================================
// Migration 120: the links already stored
// ===========================================================================

const MIGRATION = path.join(__dirname, '..', 'migrations', '120_google_photo_avatars.sql');

test('migration 120 is ASCII, sets the avatar to NULL, and matches case-insensitively', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  // The boot-safety suite's embedded server is WIN1252 (see 116's header).
  assert.ok(/^[\x00-\x7F]*$/.test(sql), 'migration 120 must be ASCII only');
  assert.match(sql, /UPDATE users\s+SET profile_image_url = NULL\s+WHERE profile_image_url ~\* '/);
});

test('migration 120 clears exactly the Google-hosted links', () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  // `~*` in Postgres is a case-insensitive match, which is `i` here. The
  // pattern uses nothing whose meaning differs between the two engines.
  const where = new RegExp(/profile_image_url ~\* '([^']+)'/.exec(sql)[1], 'i');
  const cleared = [
    PICTURE,
    'https://lh3.googleusercontent.com/a-/AOh14GgOldStylePhoto=s96-c',
    'https://lh5.googleusercontent.com/-abc/AAAAAAAAAAI/AAAAAAAAAAA/xyz/photo.jpg',
    'https://LH3.GoogleUserContent.com/a/UPPERCASE=s96-c',
    'http://lh3.googleusercontent.com/a/plainhttp',
    'https://googleusercontent.com/a/bare-host',
    'https://lh3.googleusercontent.com:443/a/with-port',
  ];
  const kept = [
    null,
    'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ',
    'https://api.flockcorp.com/api/avatars/bottts/svg?seed=k3x9q',
    'https://api.dicebear.com/7.x/thumbs/svg?seed=abc',
    // Lookalikes: the host has to BE googleusercontent.com or end in it.
    'https://lh3.googleusercontent.com.evil.example/a/x',
    'https://evilgoogleusercontent.com/a/x',
    'https://example.com/?next=https://lh3.googleusercontent.com/a/x',
    'https://example.com/lh3.googleusercontent.com/a/x',
  ];
  for (const url of cleared) assert.ok(where.test(url), `120 would leave ${url} in place`);
  for (const url of kept) {
    assert.ok(url === null || !where.test(url), `120 would clear ${url}, which is not a Google photo`);
  }
});
