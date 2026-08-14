// Run: node --test  (from backend/)
//
// Round 15 auth-surface audit. Every test here is a regression test for a
// finding, and the comment above each one is the exploit it closes.
//
// No database is touched: pool.query is replaced with a dispatcher over a
// small in-memory users table (same technique as authMiddleware.test.js). The
// canonical-email SQL is the one piece that cannot run here; it is covered by
// unit-testing its JavaScript twin, canonicalEmail(), plus a structural
// assertion that the SQL applies the same Gmail rule to the stored column. The
// expression itself was executed once against Postgres 18 (embedded-postgres)
// during the round-15 audit: `john.doe@gmail.com`, `johndoe@googlemail.com`
// and `j.o.h.n.doe+tag@GMAIL.com` all resolve to one another, `fastmail.com`
// addresses keep their dots, and nothing else matches.

// Env must be set before ANY require: routes/auth.js refuses Google sign-in
// outright when GOOGLE_CLIENT_ID is unset, and the Apple branch's refresh-token
// requirement is gated on the APPLE_* signing env being absent here.
process.env.JWT_SECRET = 'test-secret-for-auth-surface-tests';
process.env.GOOGLE_CLIENT_ID = 'flock-test.apps.googleusercontent.com';
delete process.env.APPLE_TEAM_ID;
delete process.env.APPLE_KEY_ID;
delete process.env.APPLE_PRIVATE_KEY;

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

// ---------------------------------------------------------------------------
// Apple JWKS stub — installed in the require cache BEFORE routes/auth.js is
// loaded, so its module-level jwksClient() resolves to our local key pair.
// ---------------------------------------------------------------------------
const { publicKey: APPLE_PUB, privateKey: APPLE_PRIV } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const jwksPath = require.resolve('jwks-rsa');
require.cache[jwksPath] = {
  id: jwksPath,
  filename: jwksPath,
  loaded: true,
  exports: () => ({
    getSigningKey: (_kid, cb) => cb(null, { getPublicKey: () => APPLE_PUB }),
  }),
};

const appleIdentityToken = (claims) => jwt.sign(
  { iss: 'https://appleid.apple.com', aud: 'com.flockcorp.flock', ...claims },
  APPLE_PRIV,
  { algorithm: 'RS256', expiresIn: '10m', keyid: 'test-kid' }
);

const pool = require('../config/database');
const authRouter = require('../routes/auth');
const { authenticateSocket, signUserToken, revokeUserSessions } = require('../middleware/auth');
const { canonicalEmail, EMAIL_MATCH_SQL, LOGIN_FAIL_LIMIT } = authRouter.__testing;

// ---------------------------------------------------------------------------
// In-memory users table
// ---------------------------------------------------------------------------
let users = [];
let verifications = [];
let nextId = 1;

const byCanonical = (email) => {
  const exact = users.find((u) => String(u.email).toLowerCase() === String(email).toLowerCase());
  if (exact) return exact;
  // Mirrors EMAIL_MATCH_SQL's CASE branch applied to the stored column.
  return users.find((u) => canonicalEmail(u.email) === canonicalEmail(email)) || null;
};

const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();

  // findUserByEmail — the only query carrying the canonical CASE expression.
  if (sql.includes('split_part') && sql.startsWith('SELECT * FROM users')) {
    const hit = byCanonical(params[0]);
    return { rows: hit ? [hit] : [] };
  }
  if (sql.includes("oauth_provider = 'google' AND oauth_id")) {
    return { rows: users.filter((u) => u.oauth_provider === 'google' && u.oauth_id === params[0]) };
  }
  if (sql.includes("oauth_provider = 'apple' AND oauth_id")) {
    return { rows: users.filter((u) => u.oauth_provider === 'apple' && u.oauth_id === params[0]) };
  }
  // Login's exact-match lookup (deliberately NOT canonical — see routes/auth.js).
  if (sql === 'SELECT * FROM users WHERE LOWER(email) = LOWER($1)') {
    return { rows: users.filter((u) => String(u.email).toLowerCase() === String(params[0]).toLowerCase()) };
  }
  if (sql.startsWith('SELECT id, email, name, role, email_verified, is_banned, token_version FROM users WHERE id')) {
    return { rows: users.filter((u) => u.id === params[0]) };
  }
  if (sql.startsWith('SELECT id, email, name, role, profile_image_url, email_verified, is_banned, token_version FROM users WHERE id')) {
    return { rows: users.filter((u) => u.id === params[0]) };
  }
  if (sql.startsWith('SELECT id, email, name, email_verified FROM users WHERE id')) {
    return { rows: users.filter((u) => u.id === params[0]) };
  }
  if (sql.startsWith('SELECT is_banned, token_version FROM users WHERE id')) {
    return { rows: users.filter((u) => u.id === params[0]) };
  }
  if (sql.startsWith('INSERT INTO users')) {
    const row = {
      id: nextId++, token_version: 0, is_banned: false, password: null,
      oauth_provider: null, oauth_id: null, date_of_birth: null,
    };
    // Round 16: the VALUES list now carries literals (TRUE / FALSE) as well as
    // placeholders, so columns and values are walked in parallel instead of
    // assuming every column consumes the next parameter.
    // NOW() is flattened first: its own ')' would otherwise terminate the
    // VALUES scan early, silently dropping every column after it.
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
    return { rows: [row] };
  }
  if (sql.startsWith("UPDATE users SET oauth_provider = 'google'")) {
    const row = users.find((u) => u.id === params[2]);
    Object.assign(row, {
      oauth_provider: 'google', oauth_id: params[0], password: null,
      profile_image_url: row.profile_image_url ?? params[1],
      email_verified: true, verified_email: row.email,
      token_version: row.token_version + 1,
    });
    return { rows: [row] };
  }
  if (sql.startsWith("UPDATE users SET oauth_provider = 'apple'")) {
    const row = users.find((u) => u.id === params[1]);
    Object.assign(row, {
      oauth_provider: 'apple', oauth_id: params[0], password: null,
      email_verified: true, verified_email: row.email,
      token_version: row.token_version + 1,
    });
    return { rows: [row] };
  }
  // ---- round 16: email verification ------------------------------------
  if (sql.startsWith('UPDATE users SET email = $1, email_verified = FALSE')) {
    const row = users.find((u) => u.id === params[1] && u.email_verified === false);
    if (!row) return { rows: [], rowCount: 0 };
    Object.assign(row, {
      email: params[0], email_verified: false, verified_email: null,
      venmo_username: null, cashapp_cashtag: null, zelle_identifier: null,
      token_version: row.token_version + 1,
    });
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE users SET email_verified = TRUE, verified_email = email')) {
    const row = users.find((u) => u.id === params[0]);
    if (!row) return { rows: [], rowCount: 0 };
    Object.assign(row, { email_verified: true, verified_email: row.email });
    return { rows: [row], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE email_verifications SET used_at')) {
    let n = 0;
    for (const v of verifications) {
      const hit = sql.includes('WHERE id = $1') ? v.id === params[0] : v.user_id === params[0];
      if (hit && !v.used_at) { v.used_at = new Date().toISOString(); n += 1; }
    }
    return { rows: n ? [{ id: params[0] }] : [], rowCount: n };
  }
  if (sql.startsWith('INSERT INTO email_verifications')) {
    verifications.push({
      id: verifications.length + 1, user_id: params[0], selector: params[1],
      verifier_hash: params[2], email: params[3], request_ip: params[4],
      expires_at: new Date(Date.now() + params[5] * 3600 * 1000).toISOString(),
      used_at: null, created_at: new Date().toISOString(),
    });
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes('FROM email_verifications') && sql.startsWith('SELECT COUNT(*)')) {
    const mine = verifications.filter((v) => v.user_id === params[0]);
    return {
      rows: [{
        account_hour: mine.length, account_day: mine.length,
        account_last: mine.length ? mine[mine.length - 1].created_at : null,
        ip_hour: verifications.filter((v) => v.request_ip === params[1]).length,
      }],
    };
  }
  if (sql.startsWith('SELECT v.id, v.user_id')) {
    const v = verifications.find((x) => x.selector === params[0]);
    if (!v) return { rows: [] };
    const u = users.find((x) => x.id === v.user_id);
    return { rows: [{ ...v, current_email: u?.email, email_verified: u?.email_verified }] };
  }
  if (sql.startsWith('UPDATE users SET token_version = token_version + 1')) {
    const row = users.find((u) => u.id === params[0]);
    if (!row) return { rows: [] };
    row.token_version += 1;
    return { rows: [row] };
  }
  if (sql.startsWith('UPDATE users SET date_of_birth')) {
    const row = users.find((u) => u.id === params[1]);
    if (row) row.date_of_birth = params[0];
    return { rows: row ? [row] : [] };
  }
  if (sql.startsWith('UPDATE users SET apple_refresh_token')) {
    return { rows: [] };
  }
  // Ban-evasion tombstone lookup (migration 012) — never tombstoned here.
  if (sql.includes('banned_identities')) return { rows: [], rowCount: 0 };
  throw new Error(`unstubbed query: ${sql}`);
};

// ---------------------------------------------------------------------------
// App + fake Socket.io server
// ---------------------------------------------------------------------------
let disconnectedRooms = [];
const fakeIo = {
  in: (room) => ({ disconnectSockets: (close) => disconnectedRooms.push(`${room}|${close}`) }),
};

const app = express();
app.use(express.json());
app.set('io', fakeIo);
app.use('/api/auth', authRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
test.after(() => new Promise((resolve) => server.close(resolve)));
test.after(() => {
  pool.query = realQuery;
  pool.end().catch(() => {});
});

const post = (path, body, token) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body || {}),
});

const reset = () => { users = []; verifications = []; nextId = 1; disconnectedRooms = []; };

// Google's tokeninfo + userinfo endpoints, stubbed for the duration of one
// call. Only the googleapis.com hosts are intercepted — the test client's own
// fetch to `base` has to keep working.
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

// ---------------------------------------------------------------------------
// FINDING 1 (HIGH): a token_version bump never reached a LIVE Socket.io
// connection. Sockets authenticate ONCE, at the handshake, then sit in
// `user:{id}` — the room every DM, flock message, invite and location_update
// is delivered to. So the round-13 OAuth account-claim revoked the squatter's
// REST session and left their websocket streaming the real owner's private
// traffic for as long as they kept the TCP connection open.
// ---------------------------------------------------------------------------
test('Google account claim disconnects the squatter\'s live sockets, not just their REST token', async () => {
  reset();
  users.push({
    id: 42, email: 'victim@gmail.com', name: 'Squatter', password: 'bcrypt-hash',
    oauth_provider: null, oauth_id: null, is_banned: false, token_version: 3,
    date_of_birth: '2000-01-01', profile_image_url: null,
  });

  const res = await withGoogle(
    { sub: 'google-sub-1', email: 'victim@gmail.com', email_verified: true, name: 'Real Owner' },
    () => post('/api/auth/google', { access_token: 'opaque' })
  );

  assert.strictEqual(res.status, 200);
  assert.strictEqual(users[0].oauth_id, 'google-sub-1');
  assert.strictEqual(users[0].password, null);
  assert.strictEqual(users[0].token_version, 4, 'claim must bump token_version');
  assert.deepStrictEqual(disconnectedRooms, ['user:42|true'],
    'the claimed account\'s live sockets must be force-disconnected');
});

test('Apple account claim disconnects the squatter\'s live sockets too', async () => {
  reset();
  users.push({
    id: 77, email: 'victim@icloud.com', name: 'Squatter', password: 'bcrypt-hash',
    oauth_provider: null, oauth_id: null, is_banned: false, token_version: 0,
    date_of_birth: '2000-01-01',
  });

  const res = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'apple-sub-1', email: 'victim@icloud.com', email_verified: 'true' }),
  });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(users[0].oauth_id, 'apple-sub-1');
  assert.strictEqual(users[0].token_version, 1);
  assert.deepStrictEqual(disconnectedRooms, ['user:77|true']);
});

// ---------------------------------------------------------------------------
// FINDING 1b: revokeUserSessions is the IMMEDIATE half of the fix. The socket
// layer also revalidates every live connection on a timer
// (sockets/handlers.js, SESSION_RECHECK_MS), which catches bumps made by code
// that never calls this — but only after up to a minute, during which the
// intruder is still reading. The contract below is what the timer cannot
// provide, so it must not silently become a no-op.
// ---------------------------------------------------------------------------
test('revokeUserSessions targets the user room and force-closes, and survives a missing io', () => {
  const calls = [];
  const io = { in: (room) => ({ disconnectSockets: (close) => calls.push([room, close]) }) };

  assert.strictEqual(revokeUserSessions(io, 99), true);
  assert.deepStrictEqual(calls, [['user:99', true]], 'must close, not just leave the room');

  // A route without io wired must not 500 the sign-in that triggered revocation.
  assert.strictEqual(revokeUserSessions(undefined, 99), false);
  assert.strictEqual(revokeUserSessions(io, null), false);
  assert.strictEqual(calls.length, 1);

  // Nor may a broken io take the request down with it.
  const throwing = { in: () => { throw new Error('io exploded'); } };
  assert.strictEqual(revokeUserSessions(throwing, 99), false);
});

test('the socket handshake still refuses a revoked or banned session outright', async () => {
  reset();
  users.push({ id: 5, email: 'a@b.com', name: 'A', role: 'user', is_banned: false, token_version: 0 });
  const token = signUserToken(users[0]);

  const connect = () => new Promise((resolve) => {
    authenticateSocket({ handshake: { auth: { token } }, on() {} }, (err) => resolve(err));
  });

  assert.strictEqual(await connect(), undefined, 'a valid session connects');

  users[0].token_version = 1;
  assert.match((await connect()).message, /Session expired/);

  users[0].token_version = 0;
  users[0].is_banned = true;
  assert.match((await connect()).message, /Account suspended/);
});

// ---------------------------------------------------------------------------
// FINDING 2 (MEDIUM): the round-8 account claim handed a BANNED row to the
// address's verified owner. Squat victim@gmail.com with a password, get that
// row banned for abuse, and the victim's first Google sign-in welds their
// Google identity onto a suspended account: HTTP 403 on every request
// afterwards with no way back. Refusing the claim is the fix; lifting the ban
// would instead make "sign in with Google on the same address" a one-click
// ban evasion.
// ---------------------------------------------------------------------------
test('Google will not claim a banned account, and will not silently unban it', async () => {
  reset();
  users.push({
    id: 3, email: 'banned@gmail.com', name: 'Abuser', password: 'hash',
    oauth_provider: null, oauth_id: null, is_banned: true, token_version: 0,
  });

  const res = await withGoogle(
    { sub: 'google-sub-2', email: 'banned@gmail.com', email_verified: true, name: 'Owner' },
    () => post('/api/auth/google', { access_token: 'opaque', date_of_birth: '2000-01-01' })
  );

  assert.strictEqual(res.status, 403);
  assert.match((await res.json()).error, /suspended/i);
  assert.strictEqual(users[0].is_banned, true, 'the ban must survive');
  assert.strictEqual(users[0].oauth_provider, null, 'no provider may be welded onto a banned row');
  assert.strictEqual(users.length, 1, 'and no shadow account is created instead');
});

test('Apple will not claim a banned account either', async () => {
  reset();
  users.push({
    id: 4, email: 'banned@icloud.com', name: 'Abuser', password: 'hash',
    oauth_provider: null, oauth_id: null, is_banned: true, token_version: 0,
  });

  const res = await post('/api/auth/apple', {
    identityToken: appleIdentityToken({ sub: 'apple-sub-2', email: 'banned@icloud.com', email_verified: true }),
    date_of_birth: '2000-01-01',
  });

  assert.strictEqual(res.status, 403);
  assert.strictEqual(users[0].is_banned, true);
  assert.strictEqual(users[0].oauth_provider, null);
});

// ---------------------------------------------------------------------------
// FINDING 3 (MEDIUM): signup/login run normalizeEmail() (Gmail dots and
// +subaddresses stripped); OAuth addresses are stored verbatim. Every
// "does this email exist?" check compared the two with LOWER(email) = LOWER($1),
// which cannot see across that gap.
// ---------------------------------------------------------------------------
test('canonicalEmail collapses exactly the variants normalizeEmail() does', () => {
  assert.strictEqual(canonicalEmail('John.Doe+flock@GMail.com'), 'johndoe@gmail.com');
  assert.strictEqual(canonicalEmail('j.o.h.n.d.o.e@googlemail.com'), 'johndoe@gmail.com');
  assert.strictEqual(canonicalEmail(' JohnDoe@Gmail.com '), 'johndoe@gmail.com');
  // Non-Gmail domains keep dots and subaddresses: they are DIFFERENT mailboxes.
  assert.strictEqual(canonicalEmail('John.Doe+x@Fastmail.com'), 'john.doe+x@fastmail.com');
  assert.strictEqual(canonicalEmail('a@b.co.uk'), 'a@b.co.uk');
  // Never throws on junk, never returns undefined.
  assert.strictEqual(canonicalEmail(null), '');
  assert.strictEqual(canonicalEmail('not-an-email'), 'not-an-email');
  assert.strictEqual(canonicalEmail('@nolocal.com'), '@nolocal.com');
});

test('the SQL match applies the same Gmail rule to the STORED column', () => {
  // Without this the canonicalization would only ever run on the submitted
  // side, which is the half that normalizeEmail already handled.
  assert.match(EMAIL_MATCH_SQL, /split_part\(LOWER\(email\), '@', 2\) IN \('gmail\.com', 'googlemail\.com'\)/);
  assert.match(EMAIL_MATCH_SQL, /regexp_replace\(split_part\(split_part\(LOWER\(email\), '@', 1\), '\+', 1\), /);
  assert.match(EMAIL_MATCH_SQL, /LOWER\(email\) = LOWER\(\$1\)/, 'exact match stays the first branch');
});

test('signup cannot open a shadow account on a Gmail address an OAuth user already owns', async () => {
  reset();
  // What Google stored, verbatim, dots and all.
  users.push({
    id: 9, email: 'john.doe@gmail.com', name: 'Real Owner',
    oauth_provider: 'google', oauth_id: 'g-9', password: null, is_banned: false, token_version: 0,
  });

  const res = await post('/api/auth/signup', {
    email: 'johndoe@gmail.com', password: 'Password1', name: 'Impostor', date_of_birth: '2000-01-01',
  });

  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).error, 'Email already registered');
  assert.strictEqual(users.length, 1, 'the victim\'s mailbox must not end up with two accounts');
});

test('the anti-squat claim still fires when the squatted row was normalized and the Google address was not', async () => {
  reset();
  // normalizeEmail() stored the squatter's `john.doe@gmail.com` without dots.
  users.push({
    id: 11, email: 'johndoe@gmail.com', name: 'Squatter', password: 'hash',
    oauth_provider: null, oauth_id: null, is_banned: false, token_version: 0,
    date_of_birth: '2000-01-01', profile_image_url: null,
  });

  const res = await withGoogle(
    { sub: 'google-sub-3', email: 'john.doe@gmail.com', email_verified: true, name: 'Real Owner' },
    () => post('/api/auth/google', { access_token: 'opaque' })
  );

  assert.strictEqual(res.status, 200);
  assert.strictEqual(users.length, 1, 'a second account would leave the squat standing');
  assert.strictEqual(users[0].id, 11);
  assert.strictEqual(users[0].oauth_id, 'google-sub-3');
  assert.strictEqual(users[0].password, null);
  assert.deepStrictEqual(disconnectedRooms, ['user:11|true']);
});

// ---------------------------------------------------------------------------
// FINDING 4 (MEDIUM): nothing a user could reach revoked a token. /logout was
// advisory only, so a token lifted off a shared or lost phone stayed good for
// the rest of its 24 hours no matter what its owner did — and an OAuth account
// has no password to change, which was the only other thing that bumped
// token_version.
// ---------------------------------------------------------------------------
test('logout-all revokes every outstanding token and drops the live sockets holding them', async () => {
  reset();
  users.push({ id: 21, email: 'g@h.com', name: 'G', role: 'user', is_banned: false, token_version: 2 });
  const token = signUserToken(users[0]);

  const res = await post('/api/auth/logout-all', {}, token);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(users[0].token_version, 3);
  assert.deepStrictEqual(disconnectedRooms, ['user:21|true']);

  // The token that made the call is dead too — that is the point.
  const again = await post('/api/auth/logout-all', {}, token);
  assert.strictEqual(again.status, 401);
});

test('plain /logout stays advisory so signing out one device does not sign out the others', async () => {
  reset();
  users.push({ id: 22, email: 'i@j.com', name: 'I', role: 'user', is_banned: false, token_version: 0 });
  const token = signUserToken(users[0]);

  assert.strictEqual((await post('/api/auth/logout', {}, token)).status, 200);
  assert.strictEqual(users[0].token_version, 0);
  assert.deepStrictEqual(disconnectedRooms, []);
});

// ---------------------------------------------------------------------------
// FINDING 6 (LOW): only /signup validates date_of_birth. The legacy-DOB
// backfill on /login and both OAuth paths read it straight off the body, so
// anything Date() could parse cleared the age gate and then hit a DATE column,
// where pg rejected it and the sign-in 500'd.
// ---------------------------------------------------------------------------
test('the legacy DOB backfill only persists a real date, and never 500s on junk', async () => {
  reset();
  const bcrypt = require('bcryptjs');
  const mk = (id, email) => users.push({
    id, email, name: 'Legacy', role: 'user', password: bcrypt.hashSync('Password1', 4),
    is_banned: false, token_version: 0, date_of_birth: null,
  });

  // A number of milliseconds is a perfectly valid Date and a broken DATE value.
  mk(41, 'legacy1@example.com');
  const junk = await post('/api/auth/login', {
    email: 'legacy1@example.com', password: 'Password1', date_of_birth: 946684800000,
  });
  assert.strictEqual(junk.status, 403);
  assert.strictEqual((await junk.json()).needsDob, true);
  assert.strictEqual(users[0].date_of_birth, null, 'junk must never be written');

  // A real ISO date is accepted and persisted.
  mk(42, 'legacy2@example.com');
  const ok = await post('/api/auth/login', {
    email: 'legacy2@example.com', password: 'Password1', date_of_birth: '2000-05-04',
  });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(users[1].date_of_birth, '2000-05-04');

  // And the under-13 gate still bites on a well-formed date.
  mk(43, 'legacy3@example.com');
  const kid = await post('/api/auth/login', {
    email: 'legacy3@example.com', password: 'Password1',
    date_of_birth: `${new Date().getFullYear() - 9}-01-01`,
  });
  assert.strictEqual(kid.status, 403);
  assert.match((await kid.json()).error, /at least 13/);
  assert.strictEqual(users[2].date_of_birth, null);
});

// ---------------------------------------------------------------------------
// FINDING 5 (MEDIUM): the only limit on login was 10/min PER IP. That caps one
// attacker's connection, not attempts against one account, so a credential
// stuffing run spread over a botnet had unlimited guesses at a single
// password. Nothing counted failures per account.
// ---------------------------------------------------------------------------
test('an account locks out after repeated failures no matter how many IPs are used', async () => {
  reset();
  const email = 'stuffing-target@gmail.com';

  for (let i = 0; i < LOGIN_FAIL_LIMIT; i++) {
    const res = await post('/api/auth/login', { email, password: `Guess${i}x` });
    assert.strictEqual(res.status, 401, `attempt ${i + 1} should still be a plain 401`);
  }

  const blocked = await post('/api/auth/login', { email, password: 'Guess99x' });
  assert.strictEqual(blocked.status, 429);
  assert.match((await blocked.json()).error, /too many failed sign-in attempts/i);
});

test('the lockout is keyed on the canonical address, so Gmail dots do not mint a fresh bucket', async () => {
  reset();
  for (let i = 0; i < LOGIN_FAIL_LIMIT; i++) {
    await post('/api/auth/login', { email: 'dotted.target@gmail.com', password: `Guess${i}x` });
  }
  // Same mailbox, different spelling. normalizeEmail() would collapse this one
  // anyway; the +subaddress below is the shape that survives it in other paths.
  const variant = await post('/api/auth/login', { email: 'dottedtarget@gmail.com', password: 'Guess99x' });
  assert.strictEqual(variant.status, 429);
});

test('a successful sign-in clears the failure counter', async () => {
  reset();
  const bcrypt = require('bcryptjs');
  users.push({
    id: 31, email: 'realuser@example.com', name: 'Real', role: 'user',
    password: bcrypt.hashSync('Password1', 4), is_banned: false, token_version: 0,
    date_of_birth: '2000-01-01',
  });

  for (let i = 0; i < LOGIN_FAIL_LIMIT - 1; i++) {
    const res = await post('/api/auth/login', { email: 'realuser@example.com', password: 'WrongPass1' });
    assert.strictEqual(res.status, 401);
  }

  const ok = await post('/api/auth/login', { email: 'realuser@example.com', password: 'Password1' });
  assert.strictEqual(ok.status, 200);

  // Counter reset: the budget starts over instead of locking on the next miss.
  const after = await post('/api/auth/login', { email: 'realuser@example.com', password: 'WrongPass1' });
  assert.strictEqual(after.status, 401);
});
