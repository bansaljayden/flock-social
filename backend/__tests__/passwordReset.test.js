// Run: node --test  (from backend/)
//
// Round 17. Password reset: the flow that turns "can read this mailbox" into
// "owns this account", which is why every test below is an attack rather than a
// happy path. The comment above each block is the thing that goes wrong when
// the code under it is missing.
//
// No database is touched. pool.query is replaced with a dispatcher over
// in-memory `users`, `password_resets` and `password_reset_requests` tables,
// the same technique authSurface.test.js and emailVerification.test.js use.
// Resend is replaced with a recorder so the mail body, its link and the fact
// that mail was sent AT ALL can be asserted.

// Env must be set before ANY require.
//   PUBLIC_WEB_URL is deliberately LOCALHOST here: the point of the link test
//   is that a localhost value in the environment can never reach an inbox.
process.env.JWT_SECRET = 'test-secret-for-password-reset-tests';
process.env.GOOGLE_CLIENT_ID = 'flock-test.apps.googleusercontent.com';
process.env.PUBLIC_WEB_URL = 'http://localhost:3000';
process.env.PUBLIC_API_URL = 'http://localhost:5000';
process.env.RESEND_API_KEY = 'test-resend-key';
delete process.env.NODE_ENV;

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

// ---------------------------------------------------------------------------
// Module stubs, installed in the require cache BEFORE routes/auth.js loads.
// ---------------------------------------------------------------------------
const { publicKey: APPLE_PUB } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const jwksPath = require.resolve('jwks-rsa');
require.cache[jwksPath] = {
  id: jwksPath, filename: jwksPath, loaded: true,
  exports: () => ({ getSigningKey: (_kid, cb) => cb(null, { getPublicKey: () => APPLE_PUB }) }),
};

let sentMail = [];
let resendBehaviour = 'ok'; // 'ok' | 'error' | 'throw' | 'hang'
// 'hang' models the thing that matters for enumeration: Resend taking real
// time. releaseResend() is how a test lets the send finish.
let releaseResend = null;
const resendPath = require.resolve('resend');
require.cache[resendPath] = {
  id: resendPath, filename: resendPath, loaded: true,
  exports: {
    Resend: class {
      constructor() {
        this.emails = {
          send: async (msg) => {
            if (resendBehaviour === 'hang') {
              await new Promise((resolve) => { releaseResend = resolve; });
            }
            sentMail.push(msg);
            if (resendBehaviour === 'throw') throw new Error('resend exploded');
            if (resendBehaviour === 'error') return { data: null, error: { message: 'rejected' } };
            return { data: { id: `mail-${sentMail.length}` }, error: null };
          },
        };
      }
    },
  },
};

const appleAuthPath = require.resolve('../services/appleAuth');
require.cache[appleAuthPath] = {
  id: appleAuthPath, filename: appleAuthPath, loaded: true,
  exports: {
    isConfigured: () => false,
    exchangeAppleCode: async () => ({ refresh_token: 'apple-refresh' }),
    revokeAppleToken: async () => {},
  },
};

const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const authRouter = require('../routes/auth');
const emailService = require('../services/emailService');
const {
  canonicalEmail, resetBucketKey, flushResetMail,
  RESET_TTL_MINUTES, RESET_MAX_PER_HOUR_EMAIL, RESET_MAX_PER_DAY_EMAIL,
  RESET_MAX_PER_HOUR_IP, RESET_NEUTRAL_MESSAGE,
} = authRouter.__testing;

// ---------------------------------------------------------------------------
// In-memory tables
// ---------------------------------------------------------------------------
let users = [];
let resets = [];
let requests = [];
let nextUserId = 1;
let nextResetId = 1;
let nextRequestId = 1;

const findByEmail = (email) => users.find((u) => String(u.email).toLowerCase() === String(email).toLowerCase())
  || users.find((u) => canonicalEmail(u.email) === canonicalEmail(email))
  || null;

const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  const now = Date.now();

  // ---- users --------------------------------------------------------------
  if (sql.includes('split_part') && sql.startsWith('SELECT * FROM users')) {
    const hit = findByEmail(params[0]);
    return { rows: hit ? [hit] : [] };
  }
  if (sql === 'SELECT * FROM users WHERE LOWER(email) = LOWER($1)') {
    return { rows: users.filter((u) => String(u.email).toLowerCase() === String(params[0]).toLowerCase()) };
  }
  if (sql.startsWith('SELECT id, email, name, role') && sql.includes('FROM users WHERE id')) {
    return { rows: users.filter((u) => u.id === params[0]) };
  }
  if (sql.startsWith('UPDATE users SET password = $1, token_version = token_version + 1')) {
    const row = users.find((u) => u.id === params[1]
      && u.oauth_provider == null
      && String(u.email).toLowerCase() === String(params[2]).toLowerCase());
    if (!row) return { rows: [], rowCount: 0 };
    row.password = params[0];
    row.token_version += 1;
    return { rows: [{ id: row.id }], rowCount: 1 };
  }

  // ---- password_reset_requests -------------------------------------------
  if (sql.startsWith('SELECT COUNT(*)') && sql.includes('FROM password_reset_requests')) {
    const within = (r, ms) => now - Date.parse(r.created_at) < ms;
    const mine = requests.filter((r) => r.email_key === params[0]);
    return {
      rows: [{
        email_hour: mine.filter((r) => within(r, 3600e3)).length,
        email_day: mine.filter((r) => within(r, 86400e3)).length,
        email_last: mine.length ? mine[mine.length - 1].created_at : null,
        ip_hour: requests.filter((r) => r.request_ip === params[1] && within(r, 3600e3)).length,
      }],
    };
  }
  if (sql.startsWith('DELETE FROM password_reset_requests')) {
    const cutoff = now - 7 * 86400e3;
    const before = requests.length;
    requests = requests.filter((r) => Date.parse(r.created_at) >= cutoff);
    return { rows: [], rowCount: before - requests.length };
  }
  if (sql.startsWith('INSERT INTO password_reset_requests')) {
    requests.push({
      id: nextRequestId++, email_key: params[0], request_ip: params[1],
      created_at: new Date(now).toISOString(),
    });
    return { rows: [], rowCount: 1 };
  }

  // ---- password_resets ----------------------------------------------------
  if (sql.startsWith('INSERT INTO password_resets')) {
    resets.push({
      id: nextResetId++, user_id: params[0], selector: params[1], verifier_hash: params[2],
      email: params[3], request_ip: params[4],
      expires_at: new Date(now + params[5] * 60 * 1000).toISOString(),
      used_at: null, created_at: new Date(now).toISOString(),
    });
    return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith('UPDATE password_resets SET used_at')) {
    if (sql.includes('WHERE id = $1')) {
      const r = resets.find((x) => x.id === params[0]);
      const ok = r && !r.used_at && Date.parse(r.expires_at) > now;
      if (ok) r.used_at = new Date(now).toISOString();
      return { rows: ok ? [{ id: r.id }] : [], rowCount: ok ? 1 : 0 };
    }
    let n = 0;
    for (const r of resets) {
      if (r.user_id === params[0] && !r.used_at) { r.used_at = new Date(now).toISOString(); n += 1; }
    }
    return { rows: [], rowCount: n };
  }
  if (sql.startsWith('SELECT r.id, r.user_id')) {
    const r = resets.find((x) => x.selector === params[0]);
    if (!r) return { rows: [] };
    const u = users.find((x) => x.id === r.user_id);
    return {
      rows: [{
        ...r,
        current_email: u?.email ?? null,
        oauth_provider: u?.oauth_provider ?? null,
        is_banned: u?.is_banned ?? false,
        has_password: u?.password != null,
      }],
    };
  }

  throw new Error(`unstubbed query: ${sql.slice(0, 140)}`);
};

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
let disconnectedRooms = [];
const fakeIo = { in: (room) => ({ disconnectSockets: (c) => disconnectedRooms.push(`${room}|${c}`) }) };

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

const post = (path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function reset() {
  users = []; resets = []; requests = [];
  nextUserId = 1; nextResetId = 1; nextRequestId = 1;
  sentMail = []; disconnectedRooms = []; resendBehaviour = 'ok'; releaseResend = null;
  emailService.resetClient();
}

// A password account, verified, with a real bcrypt hash so a "the password
// actually changed" assertion means something.
const OLD_HASH = bcrypt.hashSync('OldPassword1', 10);
function addPasswordUser(overrides = {}) {
  const row = {
    id: nextUserId++, email: 'user@example.com', name: 'Real User', password: OLD_HASH,
    oauth_provider: null, oauth_id: null, is_banned: false, token_version: 0,
    email_verified: true, verified_email: 'user@example.com', date_of_birth: '2000-01-01',
    ...overrides,
  };
  users.push(row);
  return row;
}

// The token only ever exists inside the mailed link, which is the property.
function tokenFromLastMail() {
  const html = sentMail[sentMail.length - 1].html;
  const m = html.match(/reset-password#token=([A-Za-z0-9._%-]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function requestReset(email) {
  const res = await post('/api/auth/forgot-password', { email });
  const body = await res.json();
  // Mail leaves the request on purpose (see below); wait for it before asserting.
  await flushResetMail();
  return { res, body };
}

// ---------------------------------------------------------------------------
// FINDING 1 (the reason this endpoint is dangerous): account enumeration. If
// the answer differs at all between "this address has an account" and "it does
// not", a leaked address list becomes a list of Flock users, and for a product
// whose users are 15-22 that is a list worth having.
// ---------------------------------------------------------------------------
test('the answer is byte-for-byte identical whether or not the account exists', async () => {
  reset();
  addPasswordUser({ email: 'real@example.com' });

  const hit = await post('/api/auth/forgot-password', { email: 'real@example.com' });
  const hitBody = await hit.text();
  await flushResetMail();

  const miss = await post('/api/auth/forgot-password', { email: 'nobody@example.com' });
  const missBody = await miss.text();
  await flushResetMail();

  assert.strictEqual(hit.status, miss.status);
  assert.strictEqual(hit.status, 200);
  assert.strictEqual(hitBody, missBody, 'the two responses must be the same bytes');
  assert.strictEqual(JSON.parse(hitBody).message, RESET_NEUTRAL_MESSAGE);
  // The copy must not claim an email was sent, because for the miss it was not.
  assert.match(RESET_NEUTRAL_MESSAGE, /If there's an account/);

  // Only the mailbox differs.
  assert.strictEqual(sentMail.length, 1);
  assert.strictEqual(sentMail[0].to, 'real@example.com');
});

test('an OAuth account answers the same way and is never told apart from the rest', async () => {
  reset();
  users.push({
    id: 1, email: 'google@example.com', name: 'G', password: null,
    oauth_provider: 'google', oauth_id: 'g-1', is_banned: false, token_version: 0,
    email_verified: true, verified_email: 'google@example.com',
  });

  const res = await post('/api/auth/forgot-password', { email: 'google@example.com' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).message, RESET_NEUTRAL_MESSAGE);
});

test('the reply does not wait on Resend, so it cannot be timed for existence', async () => {
  reset();
  addPasswordUser({ email: 'real@example.com' });

  // Resend is made to hang forever. The reply must land anyway: that latency
  // exists ONLY on the branch where the account does, so awaiting it inside the
  // request would make the neutral body a fiction anyone could time around.
  resendBehaviour = 'hang';
  const res = await post('/api/auth/forgot-password', { email: 'real@example.com' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).message, RESET_NEUTRAL_MESSAGE);
  assert.strictEqual(sentMail.length, 0, 'the reply beat the mail, which is the point');

  resendBehaviour = 'ok';
  assert.ok(releaseResend, 'the background send should have started by now');
  releaseResend();
  await flushResetMail();
  assert.strictEqual(sentMail.length, 1);
  assert.strictEqual(resets.length, 1);
});

test('the request does not wait on the token write either', async () => {
  // The mail is the obvious latency, but writing the token is work that only
  // ever happens on the branch where the account exists, and work that can also
  // FAIL. If the reply waited on it, both its duration and its status code
  // would differ for a real address. Both branches run the same three queries
  // inside the request and nothing else.
  reset();
  addPasswordUser({ email: 'real@example.com' });

  let releaseWrite = null;
  const inner = pool.query;
  pool.query = async (text, params) => {
    if (String(text).includes('password_resets')) {
      await new Promise((resolve) => { releaseWrite = resolve; });
    }
    return inner(text, params);
  };

  try {
    const res = await post('/api/auth/forgot-password', { email: 'real@example.com' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).message, RESET_NEUTRAL_MESSAGE);
    assert.ok(releaseWrite, 'the token write should have started');
    assert.strictEqual(resets.length, 0, 'and the reply landed before it finished');
  } finally {
    pool.query = inner;
    if (releaseWrite) releaseWrite();
    await flushResetMail();
  }
});

test('a Resend outage is invisible to the caller and never crashes the process', async () => {
  reset();
  resendBehaviour = 'throw';
  addPasswordUser({ email: 'real@example.com' });

  const { res, body } = await requestReset('real@example.com');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.message, RESET_NEUTRAL_MESSAGE);
  assert.strictEqual(resets.length, 1, 'the token was issued; only the delivery failed');
});

// ---------------------------------------------------------------------------
// FINDING 2: OAuth accounts have no password. Silently creating one would bolt
// a second, weaker credential onto an account whose owner never asked for one
// and would never think to protect it.
// ---------------------------------------------------------------------------
test('an OAuth account is mailed a "there is no password" notice and no link', async () => {
  reset();
  users.push({
    id: 1, email: 'google@example.com', name: 'G', password: null,
    oauth_provider: 'google', oauth_id: 'g-1', is_banned: false, token_version: 0,
    email_verified: true, verified_email: 'google@example.com',
  });

  await requestReset('google@example.com');

  assert.strictEqual(resets.length, 0, 'no reset token may be issued for an account with no password');
  assert.strictEqual(sentMail.length, 1);
  assert.match(sentMail[0].html, /signs in with Google/);
  assert.ok(!/reset-password#token=/.test(sentMail[0].html), 'and the mail carries no reset link');
  assert.strictEqual(users[0].password, null, 'no password is invented on an OAuth row');
  assert.strictEqual(users[0].token_version, 0);
});

test('an Apple account is named correctly in the same notice', async () => {
  reset();
  users.push({
    id: 1, email: 'a@icloud.com', name: 'A', password: null,
    oauth_provider: 'apple', oauth_id: 'a-1', is_banned: false, token_version: 0,
    email_verified: true, verified_email: 'a@icloud.com',
  });
  await requestReset('a@icloud.com');
  assert.match(sentMail[0].html, /signs in with Apple/);
});

test('a reset token that lands on an account that became OAuth in the meantime is refused', async () => {
  reset();
  const user = addPasswordUser();
  await requestReset(user.email);
  const token = tokenFromLastMail();

  // The legitimate password-to-Google upgrade (round 8) clears the password.
  user.oauth_provider = 'google';
  user.password = null;

  const res = await post('/api/auth/reset-password', { token, password: 'BrandNew1' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(users[0].password, null, 'nothing is welded onto the OAuth row');
});

// ---------------------------------------------------------------------------
// FINDING 3: token shape. Same split token as email verification — a public
// selector to look up by, a secret verifier whose SHA-256 is all that is
// stored, compared in constant time, single use, short lived.
// ---------------------------------------------------------------------------
test('the mailed token is never stored, only its digest', async () => {
  reset();
  await requestReset(addPasswordUser().email);
  const token = tokenFromLastMail();
  assert.ok(token, 'the link must carry a token');

  const [selector, verifier] = token.split('.');
  assert.match(selector, /^[0-9a-f]{32}$/);
  assert.strictEqual(resets[0].selector, selector, 'the public half is the lookup key');
  assert.ok(!resets[0].verifier_hash.includes(verifier), 'the secret half is never stored');
  assert.strictEqual(
    resets[0].verifier_hash,
    crypto.createHash('sha256').update(verifier).digest('hex')
  );
});

test('a reset link works exactly once', async () => {
  reset();
  const user = addPasswordUser();
  await requestReset(user.email);
  const token = tokenFromLastMail();

  const first = await post('/api/auth/reset-password', { token, password: 'BrandNew1' });
  assert.strictEqual(first.status, 200);
  assert.ok(bcrypt.compareSync('BrandNew1', users[0].password), 'the password really changed');

  const second = await post('/api/auth/reset-password', { token, password: 'Different1' });
  assert.strictEqual(second.status, 400);
  assert.strictEqual((await second.json()).reason, 'used');
  assert.ok(bcrypt.compareSync('BrandNew1', users[0].password), 'and the second attempt changed nothing');
});

test('an expired link is refused, and says so honestly', async () => {
  reset();
  await requestReset(addPasswordUser().email);
  const token = tokenFromLastMail();
  resets[0].expires_at = new Date(Date.now() - 1000).toISOString();

  const res = await post('/api/auth/reset-password', { token, password: 'BrandNew1' });
  assert.strictEqual(res.status, 400);
  const body = await res.json();
  assert.strictEqual(body.reason, 'expired');
  assert.match(body.error, /expired/i);
  assert.ok(bcrypt.compareSync('OldPassword1', users[0].password));
});

test('the link expires in one hour, not a day', async () => {
  reset();
  assert.strictEqual(RESET_TTL_MINUTES, 60);
  await requestReset(addPasswordUser().email);
  const life = Date.parse(resets[0].expires_at) - Date.parse(resets[0].created_at);
  assert.strictEqual(life, 60 * 60 * 1000);
  assert.match(sentMail[0].html, /expires in 60 minutes/);
});

test('the right selector with a forged verifier is refused and does not spend the real link', async () => {
  reset();
  await requestReset(addPasswordUser().email);
  const token = tokenFromLastMail();
  const [selector] = token.split('.');

  const forged = `${selector}.${crypto.randomBytes(32).toString('base64url')}`;
  const res = await post('/api/auth/reset-password', { token: forged, password: 'BrandNew1' });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(resets[0].used_at, null, 'a forged attempt must not burn the real link');
  assert.ok(bcrypt.compareSync('OldPassword1', users[0].password));
});

test('junk tokens are refused without a stack trace or a distinguishing message', async () => {
  reset();
  addPasswordUser();
  for (const token of ['', 'x', 'x'.repeat(500), `${'z'.repeat(32)}.${'a'.repeat(43)}`]) {
    const res = await post('/api/auth/reset-password', { token, password: 'BrandNew1' });
    assert.strictEqual(res.status, 400, `token ${token.slice(0, 12)} must be refused`);
  }
  assert.ok(bcrypt.compareSync('OldPassword1', users[0].password));
});

test('a link issued for one address stops working when the account moves', async () => {
  reset();
  const user = addPasswordUser();
  await requestReset(user.email);
  const token = tokenFromLastMail();

  // The link proves control of the OLD mailbox and says nothing about the new
  // one, so it must not keep working after PUT /api/users/profile moves the row.
  user.email = 'somewhere-else@example.com';

  const res = await post('/api/auth/reset-password', { token, password: 'BrandNew1' });
  assert.strictEqual(res.status, 400);
  assert.ok(bcrypt.compareSync('OldPassword1', users[0].password));
});

test('asking again retires the previous link, so only the newest one works', async () => {
  reset();
  const user = addPasswordUser();
  await requestReset(user.email);
  const first = tokenFromLastMail();

  // Past the minimum gap.
  requests[0].created_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await requestReset(user.email);
  const second = tokenFromLastMail();
  assert.notStrictEqual(first, second);

  assert.strictEqual((await post('/api/auth/reset-password', { token: first, password: 'BrandNew1' })).status, 400);
  assert.strictEqual((await post('/api/auth/reset-password', { token: second, password: 'BrandNew1' })).status, 200);
});

test('a completed reset kills every other outstanding link for that account', async () => {
  reset();
  const user = addPasswordUser();
  await requestReset(user.email);
  const token = tokenFromLastMail();
  // A second live link, as if two were in flight at once (a redeploy, a race,
  // two copies of the same mail). Spending one must not leave the other usable.
  resets.push({
    id: nextResetId++, user_id: user.id, selector: 'b'.repeat(32), verifier_hash: 'h',
    email: user.email, request_ip: null, used_at: null,
    expires_at: new Date(Date.now() + 3600e3).toISOString(), created_at: new Date().toISOString(),
  });

  assert.strictEqual((await post('/api/auth/reset-password', { token, password: 'BrandNew1' })).status, 200);
  assert.ok(resets.every((r) => r.used_at), 'no reset link may survive a completed reset');
});

// ---------------------------------------------------------------------------
// FINDING 4: blast radius. A reset is what someone does when they believe an
// attacker has their password. Leaving the attacker's 24h JWT and their live
// socket alive through it defeats the entire exercise.
// ---------------------------------------------------------------------------
test('a reset revokes every existing session and drops the live sockets', async () => {
  reset();
  const user = addPasswordUser({ token_version: 7 });
  await requestReset(user.email);
  const token = tokenFromLastMail();

  const res = await post('/api/auth/reset-password', { token, password: 'BrandNew1' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(users[0].token_version, 8, 'every outstanding JWT for this account must die');
  assert.deepStrictEqual(disconnectedRooms, [`user:${user.id}|true`], 'and so must the live sockets');
});

test('no session is handed back by the reset itself', async () => {
  reset();
  const user = addPasswordUser();
  await requestReset(user.email);
  const body = await (await post('/api/auth/reset-password', {
    token: tokenFromLastMail(), password: 'BrandNew1',
  })).json();
  assert.strictEqual(body.token, undefined, 'signing in is the moment the new password is proved');
  assert.match(body.message, /Sign in/);
});

// ---------------------------------------------------------------------------
// The password policy. A recovery flow that accepts a weaker password than
// signup does is signup with the rules switched off.
// ---------------------------------------------------------------------------
test('the new password is held to exactly the signup policy', async () => {
  reset();
  const user = addPasswordUser();
  await requestReset(user.email);
  const token = tokenFromLastMail();

  for (const bad of ['Short1A', 'alllowercase1', 'ALLUPPERCASELETTERS', 'NoDigitsHere', '']) {
    const res = await post('/api/auth/reset-password', { token, password: bad });
    assert.strictEqual(res.status, 400, `"${bad}" must be refused`);
  }
  assert.strictEqual(resets[0].used_at, null, 'a refused password must not burn the link');
  assert.strictEqual((await post('/api/auth/reset-password', { token, password: 'Password1' })).status, 200);
});

test('array-shaped bodies are refused instead of reaching bcrypt or pg', async () => {
  reset();
  addPasswordUser();
  // express-validator runs per ELEMENT on an array and writes the array back,
  // so content validation alone lets `["a@b.com"]` through (see the same trap
  // in routes/users.js PUT /profile).
  assert.strictEqual((await post('/api/auth/forgot-password', { email: ['user@example.com'] })).status, 400);
  assert.strictEqual((await post('/api/auth/reset-password', {
    token: ['a'], password: ['Password1'],
  })).status, 400);
  assert.strictEqual(requests.length, 0, 'and no rate-limit row is spent on a malformed request');
});

// ---------------------------------------------------------------------------
// The budget. Counted in the DATABASE (an in-memory counter resets on every
// Railway redeploy, and mail budget is exactly what an attacker would redeploy
// to reset) and keyed on the ADDRESS, so it counts identically for addresses
// with no account. A budget that could only count issued tokens would be
// finding 1 all over again: spray, watch for a 429, learn who exists.
// ---------------------------------------------------------------------------
test('requests are counted for addresses that have NO account', async () => {
  reset();
  const key = resetBucketKey('nobody@example.com');
  await requestReset('nobody@example.com');
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].email_key, key);
  assert.strictEqual(sentMail.length, 0, 'nothing was mailed, but the attempt was still counted');
});

test('the per-address cap throttles a real account and an imaginary one identically', async () => {
  const run = async (email) => {
    const statuses = [];
    for (let i = 0; i < RESET_MAX_PER_HOUR_EMAIL + 1; i++) {
      // Age the previous attempts past the minimum gap so the HOURLY cap is
      // unambiguously what refuses the last one.
      for (const r of requests) r.created_at = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const res = await post('/api/auth/forgot-password', { email });
      statuses.push(res.status);
      await res.text();
    }
    await flushResetMail();
    return statuses;
  };

  reset();
  addPasswordUser({ email: 'real@example.com' });
  const real = await run('real@example.com');

  reset();
  const imaginary = await run('nobody@example.com');

  assert.deepStrictEqual(real, imaginary, 'the throttle must not be an existence oracle');
  assert.strictEqual(real[real.length - 1], 429);
});

test('a second request inside the minimum gap is refused', async () => {
  reset();
  const user = addPasswordUser();
  await requestReset(user.email);
  const immediate = await post('/api/auth/forgot-password', { email: user.email });
  assert.strictEqual(immediate.status, 429);
  await immediate.text();
  await flushResetMail();
  assert.strictEqual(sentMail.length, 1, 'no mail leaves once the budget is spent');
});

test('the daily cap holds even when every request is an hour apart', async () => {
  reset();
  const user = addPasswordUser();
  const key = resetBucketKey(user.email);
  for (let i = 0; i < RESET_MAX_PER_DAY_EMAIL; i++) {
    requests.push({
      id: nextRequestId++, email_key: key, request_ip: null,
      created_at: new Date(Date.now() - (i + 2) * 3600e3).toISOString(),
    });
  }
  const res = await post('/api/auth/forgot-password', { email: user.email });
  assert.strictEqual(res.status, 429);
  await res.text();
});

test('one IP cannot spray many addresses', async () => {
  reset();
  const first = await post('/api/auth/forgot-password', { email: 'a@example.com' });
  await first.text();
  await flushResetMail();
  const ip = requests[0].request_ip;
  assert.ok(ip, 'the requesting IP must be recorded, or the per-IP budget is fiction');

  for (let i = 0; i < RESET_MAX_PER_HOUR_IP; i++) {
    requests.push({
      id: nextRequestId++, email_key: `other-${i}`, request_ip: ip,
      created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
  }

  const res = await post('/api/auth/forgot-password', { email: 'fresh@example.com' });
  assert.strictEqual(res.status, 429);
  await res.text();
});

test('the bucket key is an HMAC, not the address, and folds gmail variants together', () => {
  const key = resetBucketKey('Some.One+tag@GMail.com');
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.ok(!key.includes('someone'), 'the table must not become a list of addresses people typed');
  assert.strictEqual(key, resetBucketKey('someone@gmail.com'), 'gmail dot and +tag variants are one mailbox');
  assert.notStrictEqual(key, resetBucketKey('someone@example.com'));
  // Unkeyed SHA-256 of an address is reversible with a wordlist, so the pepper
  // has to actually be in the input.
  assert.notStrictEqual(
    key,
    crypto.createHash('sha256').update('reset:someone@gmail.com').digest('hex')
  );
});

test('a gmail dot variant finds the account it belongs to', async () => {
  reset();
  addPasswordUser({ email: 'someone@gmail.com', verified_email: 'someone@gmail.com' });
  await requestReset('some.one@gmail.com');
  assert.strictEqual(resets.length, 1, 'the canonical match must find the row');
  assert.strictEqual(sentMail[0].to, 'someone@gmail.com', 'and mail the address on the row');
});

// ---------------------------------------------------------------------------
// Reset must not walk around the gates that already exist.
// ---------------------------------------------------------------------------
test('a completed reset does NOT mark the address verified', async () => {
  reset();
  // The trap: a reset proves mailbox control just as well as a verification
  // link does, so it is tempting to set email_verified here. Doing that would
  // let the recovery flow hand an unverified squat row (migration 011) and
  // whatever it holds to the address's real owner, wearing a verified badge it
  // never earned.
  const user = addPasswordUser({ email_verified: false, verified_email: null });
  await requestReset(user.email);

  assert.strictEqual((await post('/api/auth/reset-password', {
    token: tokenFromLastMail(), password: 'BrandNew1',
  })).status, 200);
  assert.strictEqual(users[0].email_verified, false, 'still unverified, still inside the round-16 gate');
  assert.strictEqual(users[0].verified_email, null);
});

test('a banned account is mailed nothing and cannot be reset', async () => {
  reset();
  const user = addPasswordUser({ is_banned: true });
  await requestReset(user.email);
  assert.strictEqual(sentMail.length, 0, 'a ban is not a mail budget');
  assert.strictEqual(resets.length, 0);

  // And even a token minted before the ban is refused.
  resets.push({
    id: nextResetId++, user_id: user.id, selector: 'c'.repeat(32),
    verifier_hash: crypto.createHash('sha256').update('secret-verifier-value').digest('hex'),
    email: user.email, request_ip: null, used_at: null,
    expires_at: new Date(Date.now() + 3600e3).toISOString(), created_at: new Date().toISOString(),
  });
  const res = await post('/api/auth/reset-password', {
    token: `${'c'.repeat(32)}.secret-verifier-value`, password: 'BrandNew1',
  });
  assert.strictEqual(res.status, 400);
  assert.ok(bcrypt.compareSync('OldPassword1', users[0].password));
});

test('nothing is mailed to a non-routable placeholder address', async () => {
  reset();
  // The Apple placeholder and the evicted-squat tombstone can never receive
  // mail; issuing a token for one would be a link nobody can ever open.
  addPasswordUser({ email: 'apple_x@apple-signin.invalid' });
  await requestReset('apple_x@apple-signin.invalid');
  assert.strictEqual(sentMail.length, 0);
  assert.strictEqual(resets.length, 0);
});

// ---------------------------------------------------------------------------
// Links must point at production. A localhost value in the environment is a
// link that can never work, mailed to a real person, for the one action that
// gets them back into their account.
// ---------------------------------------------------------------------------
test('reset links point at the production web app, never at localhost', async () => {
  reset();
  await requestReset(addPasswordUser().email);
  const html = sentMail[0].html;

  assert.ok(!/localhost/i.test(html), 'no localhost may reach an inbox');
  assert.ok(!/127\.0\.0\.1/.test(html));
  assert.ok(html.includes(`${emailService.PROD_WEB_URL}/reset-password#token=`));
});

test('the token rides in the fragment, so it never reaches a server log', () => {
  const link = emailService.passwordResetLink('abc.def');
  assert.strictEqual(link, `${emailService.PROD_WEB_URL}/reset-password#token=abc.def`);
  // Everything before the '#' is what a web server, a proxy log and a Referer
  // header get to see. It must carry no secret.
  assert.ok(!link.split('#')[0].includes('abc.def'));
});

// ---------------------------------------------------------------------------
// The state-check endpoint, which is what lets the screen say "this link
// expired" before the user picks and types a new password.
// ---------------------------------------------------------------------------
test('checking a link reports its state without spending it', async () => {
  reset();
  const user = addPasswordUser();
  await requestReset(user.email);
  const token = tokenFromLastMail();

  const good = await (await post('/api/auth/reset-password/check', { token })).json();
  assert.deepStrictEqual(good, { valid: true, reason: null });
  assert.strictEqual(resets[0].used_at, null, 'checking must never consume the link');

  resets[0].expires_at = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual((await (await post('/api/auth/reset-password/check', { token })).json()).reason, 'expired');

  resets[0].expires_at = new Date(Date.now() + 3600e3).toISOString();
  resets[0].used_at = new Date().toISOString();
  assert.strictEqual((await (await post('/api/auth/reset-password/check', { token })).json()).reason, 'used');

  const junk = await (await post('/api/auth/reset-password/check', { token: 'nonsense' })).json();
  assert.deepStrictEqual(junk, { valid: false, reason: 'invalid' });
});

// ---------------------------------------------------------------------------
// Migration 015, checked structurally. Every other test here runs against an
// in-memory table, so nothing else in `node --test` would notice if the
// migration stopped creating a column the flow depends on.
// (scripts/e2e-local.js applies this file to a real Postgres.)
// ---------------------------------------------------------------------------
test('migration 015 creates both tables with the columns the flow depends on', () => {
  const sql = require('node:fs')
    .readFileSync(require('node:path').join(__dirname, '..', 'migrations', '015_password_reset.sql'), 'utf8');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS password_resets/);
  assert.match(sql, /selector\s+VARCHAR\(64\)\s+NOT NULL UNIQUE/,
    'the selector is the lookup key and must be unique');
  assert.match(sql, /user_id\s+INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/,
    'deleting an account must take its outstanding reset links with it');
  for (const col of ['verifier_hash', 'email', 'request_ip', 'expires_at', 'used_at']) {
    assert.ok(sql.includes(col), `password_resets.${col} is load-bearing`);
  }

  // The rate-limit ledger is a SEPARATE table on purpose: it has to count
  // requests for addresses that have no account, which a table of issued
  // tokens structurally cannot do.
  const ledgerAt = sql.indexOf('CREATE TABLE IF NOT EXISTS password_reset_requests');
  assert.ok(ledgerAt > -1);
  const ledger = sql.slice(ledgerAt, sql.indexOf(');', ledgerAt));
  assert.match(ledger, /email_key\s+VARCHAR\(64\)\s+NOT NULL/);
  assert.ok(!/\bemail\s+VARCHAR/.test(ledger),
    'the request ledger must key on a digest, not store raw addresses');
  assert.match(ledger, /request_ip/);

  // Every statement is IF NOT EXISTS, so a replay is a no-op.
  assert.ok(!/CREATE INDEX (?!IF NOT EXISTS)/.test(sql));
  assert.ok(!/CREATE TABLE (?!IF NOT EXISTS)/.test(sql));
});
