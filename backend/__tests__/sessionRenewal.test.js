'use strict';
// Run: node --test __tests__/sessionRenewal.test.js  (from backend/)
//
// ---------------------------------------------------------------------------
// A SESSION IS RENEWED, NOT ENDED, ON A REAL POSTGRES (migration 097)
// ---------------------------------------------------------------------------
//
// The access token lives 24 hours and nothing renewed it, so every user was
// signed out a day after signing in: mid-chat when the socket recheck found the
// token expired, and at the next launch when GET /api/auth/me answered 401.
// Sign-in now also hands out a refresh credential, and POST /api/auth/refresh
// trades it for a new access token (services/refreshTokens.js). This suite
// holds both halves of that bargain:
//
//   STAYING SIGNED IN. A session whose access token has run out, or that is
//   opened again days later, is renewed. Two tabs or a retry presenting one
//   credential at once are a race, not a replay. A renewal whose answer was
//   lost can be repeated.
//
//   STAYING REVOCABLE. The credential rotates on every use and a replayed old
//   one ends the whole sign-in. A token_version bump (password change, sign out
//   everywhere) ends it, a ban ends it, a sign-out ends it, an idle one expires,
//   and the credential is never stored in a form that could be presented.
//
//   AND A RENEWAL IS NOT A SIGN-IN. The renewed access token carries the time
//   the person actually signed in as auth_time, so hasFreshSession (deletion,
//   export, phone change) and the device-token claim read the sign-in, never
//   the renewal.
//
// The SQL is the thing under test (FOR UPDATE, the interval arithmetic, the
// epoch round trip), which is why this runs on a real, migrated database rather
// than a fixture that would restate it.
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');

// Synchronous and before config/database is required anywhere: that module
// builds its Pool from DATABASE_URL at require time, and backend/.env points at
// the live database.
const PG_PORT = pickEmbeddedPgPort('sessionRenewal');
const DB_NAME = 'flock_session_renewal';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-session-renewal';
delete process.env.RESEND_API_KEY;
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const PASSWORD = 'Password1';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

let pg;
let pool;
let dataDir;
let server;
let base;
let refreshTokens;
let usersTesting;
let seq = 0;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-session-renewal-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'sessionRenewal', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);

  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  refreshTokens = require('../services/refreshTokens');
  const { authenticate } = require('../middleware/auth');
  const usersRouter = require('../routes/users');
  usersTesting = usersRouter.__testing;

  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/auth', require('../routes/auth'));
  app.use('/api/users', usersRouter);
  // What the device-token claim reads (routes/notifications.js): the session's
  // sign-in time as middleware/auth.js hands it on.
  app.get('/probe/signed-in-at', authenticate, (req, res) => res.json({ signedInAt: req.tokenIssuedAt }));
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  try {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (err) {
    console.warn('[sessionRenewal] could not remove %s: %s', dataDir, err.message);
  }
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

async function call(method, url, { session, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

// A password account, and a real sign-in through POST /api/auth/login, so what
// is under test is what the app is actually handed.
async function signIn() {
  seq += 1;
  const email = `renew${seq}-${Date.now()}@sessionrenewal.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified, verified_email, date_of_birth)
     VALUES ($1, $2, $3, true, $1, '2000-01-01') RETURNING id`,
    [email, PASSWORD_HASH, `Renew ${seq}`]
  );
  const res = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(res.status, 200, `login failed: ${res.text}`);
  return { id: rows[0].id, email, token: res.body.token, refreshToken: res.body.refreshToken };
}

const renew = (refreshToken) => call('POST', '/api/auth/refresh', { body: { refreshToken } });
const hash = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
const claimsOf = (token) => jwt.decode(token);

async function rowOf(raw) {
  const { rows } = await pool.query('SELECT * FROM refresh_tokens WHERE token_hash = $1', [hash(raw)]);
  return rows[0] || null;
}

// Move a credential's clock instead of waiting on it.
async function backdate(raw, column, interval) {
  await pool.query(`UPDATE refresh_tokens SET ${column} = ${column} - $2::interval WHERE token_hash = $1`, [hash(raw), interval]);
}

// An access token with the same claims the session holds, already expired:
// what the device is holding when it opens the app a day later.
function expiredCopyOf(token) {
  const { userId, tv, auth_time: authTime } = claimsOf(token);
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ userId, tv, auth_time: authTime, iat: now - 90000, exp: now - 3600 }, process.env.JWT_SECRET);
}

// ── Staying signed in ────────────────────────────────────────────────────────

test('a sign-in hands out a refresh credential, and the database holds only its hash', async () => {
  const u = await signIn();
  assert.equal(typeof u.refreshToken, 'string');
  assert.match(u.refreshToken, /^[A-Za-z0-9_-]{43}$/);

  const row = await rowOf(u.refreshToken);
  assert.ok(row, 'no row for the credential the sign-in returned');
  assert.equal(row.user_id, u.id);
  assert.equal(row.parent_id, null, 'a sign-in starts a family; it has no parent');
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE token_hash = $1 OR family_id::text = $1', [u.refreshToken]
  );
  assert.equal(rows[0].n, 0, 'the raw credential must never be stored');

  // Its idle life is REFRESH_TOKEN_TTL_DAYS, not the access token's day.
  const days = (new Date(row.expires_at) - new Date(row.created_at)) / 86400000;
  assert.ok(Math.abs(days - refreshTokens.REFRESH_TOKEN_TTL_DAYS) < 0.01, `expires ${days} days after issue`);

  // And the access token says when the person signed in.
  const claims = claimsOf(u.token);
  assert.ok(Number.isInteger(claims.auth_time));
  assert.ok(Math.abs(claims.auth_time - Math.floor(Date.now() / 1000)) < 60);
  assert.equal(Math.floor(new Date(row.auth_time).getTime() / 1000), claims.auth_time);
});

test('a day later the session is renewed instead of signed out', async () => {
  const u = await signIn();
  // The person opens the app a day after signing in. The access token they
  // hold has run out, which is what used to end the session right here.
  const stale = expiredCopyOf(u.token);
  const refused = await call('GET', '/api/auth/me', { session: stale });
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error, 'Token expired');

  const renewed = await renew(u.refreshToken);
  assert.equal(renewed.status, 200, renewed.text);
  assert.equal(renewed.body.token.split('.').length, 3);
  assert.notEqual(renewed.body.refreshToken, u.refreshToken, 'the credential must rotate on use');

  const me = await call('GET', '/api/auth/me', { session: renewed.body.token });
  assert.equal(me.status, 200, 'the renewed access token must work everywhere the old one did');
  assert.equal(me.body.user.id, u.id);

  // And it keeps renewing: the new credential is the one that works now.
  const again = await renew(renewed.body.refreshToken);
  assert.equal(again.status, 200);
});

test('a renewal carries the original sign-in time, so it never counts as a fresh sign-in', async () => {
  const u = await signIn();
  // The sign-in was three days ago.
  await backdate(u.refreshToken, 'auth_time', '3 days');
  const threeDaysAgo = Math.floor((await rowOf(u.refreshToken)).auth_time.getTime() / 1000);

  const renewed = await renew(u.refreshToken);
  assert.equal(renewed.status, 200);
  const claims = claimsOf(renewed.body.token);
  assert.equal(claims.auth_time, threeDaysAgo, 'the renewed token must carry the sign-in time, not the renewal time');
  assert.ok(claims.iat > threeDaysAgo + 86400, 'while iat is the renewal itself');

  // hasFreshSession is the sudo-mode proof for deleting the account, the data
  // export and the phone change on an OAuth account. A renewal a thief can
  // perform with a copied credential must not produce it.
  const header = (t) => ({ headers: { authorization: `Bearer ${t}` } });
  assert.equal(usersTesting.hasFreshSession(header(u.token)), true, 'a real sign-in a moment ago is fresh');
  assert.equal(usersTesting.hasFreshSession(header(renewed.body.token)), false,
    'a renewed token passed the recent sign-in check because its iat is new');

  // The device-token claim reads the same thing, so a renewed old session
  // cannot look newer than a later sign-in on the same phone.
  const probe = await call('GET', '/probe/signed-in-at', { session: renewed.body.token });
  assert.equal(probe.status, 200);
  assert.equal(probe.body.signedInAt, threeDaysAgo);

  // The next renewal down the chain keeps it too.
  const later = await renew(renewed.body.refreshToken);
  assert.equal(claimsOf(later.body.token).auth_time, threeDaysAgo);
});

test('two tabs renewing with one credential at once is a race, not a replay', async () => {
  const u = await signIn();
  const [a, b] = await Promise.all([renew(u.refreshToken), renew(u.refreshToken)]);
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  assert.notEqual(a.body.refreshToken, b.body.refreshToken);
  // The tabs share one storage, and the client keeps whichever answer landed
  // first and drops the other (services/api.js performRenewal), so the one
  // kept carries on and neither tab is signed out by the other.
  assert.equal((await renew(a.body.refreshToken)).status, 200);
  // And the row lock serialised them: the credential was spent once.
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE parent_id = $1', [(await rowOf(u.refreshToken)).id]
  );
  assert.equal(rows[0].n, 2, 'two children, one per tab');
});

// ── A copy inside the race window ────────────────────────────────────────────
// The grace above forgives a second presentation of a spent credential for a
// couple of minutes. A thief presenting a copy inside that window used to get
// a live sibling, and the session forked into two chains that each renewed for
// as long as they were used: no replay was ever seen, because each holder only
// ever presented its own latest credential. Only one answer to a credential is
// ever kept by the client, so the first use of a second one is the tell.

test('a copy presented inside the race window forks nothing: the thief renewing second ends the sign-in', async () => {
  const u = await signIn();
  const device = await renew(u.refreshToken);
  assert.equal(device.status, 200);
  // The copy, a moment later: inside the window, so it is answered.
  const copy = await renew(u.refreshToken);
  assert.equal(copy.status, 200, 'a presentation inside the race window was refused');

  // The person's device carries on with its own answer.
  const deviceNext = await renew(device.body.refreshToken);
  assert.equal(deviceNext.status, 200);

  // The thief's answer, used after the device's: two holders exist.
  const thief = await renew(copy.body.refreshToken);
  assert.equal(thief.status, 401, 'a copy presented inside the race window became a second chain');
  assert.equal((await renew(deviceNext.body.refreshToken)).status, 401,
    'the fork was seen and the sign-in survived it; one of the two holders is not the person');
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL',
    [(await rowOf(u.refreshToken)).family_id]
  );
  assert.equal(rows[0].n, 0);
});

test('a copy presented inside the race window forks nothing: the thief renewing first is caught at the device', async () => {
  const u = await signIn();
  const device = await renew(u.refreshToken);
  const copy = await renew(u.refreshToken);
  assert.equal(copy.status, 200);

  // The thief renews first, before the device's next renewal.
  const thiefNext = await renew(copy.body.refreshToken);
  assert.equal(thiefNext.status, 200);
  // The device's own answer is now the second fork used.
  assert.equal((await renew(device.body.refreshToken)).status, 401);
  assert.equal((await renew(thiefNext.body.refreshToken)).status, 401,
    'the thief kept a chain of its own after the fork was seen');
});

test('inside the race window, a credential whose answer was already used is a replay, not a race', async () => {
  const u = await signIn();
  const device = await renew(u.refreshToken);
  // The device's answer has been used already: the chain has moved on, so the
  // presentation below is not a tab racing the first one.
  const deviceNext = await renew(device.body.refreshToken);
  assert.equal(deviceNext.status, 200);

  const copy = await renew(u.refreshToken);
  assert.equal(copy.status, 401, 'a spent credential minted a second chain after the first had moved on');
  assert.equal((await renew(deviceNext.body.refreshToken)).status, 401);
});

test('two forks presented at the same moment cannot both go on', async () => {
  const u = await signIn();
  const device = await renew(u.refreshToken);
  const copy = await renew(u.refreshToken);
  // The parent's row lock serialises the two first uses, so the second one
  // always sees the first and neither reads the other as unused.
  const [a, b] = await Promise.all([renew(device.body.refreshToken), renew(copy.body.refreshToken)]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 401], `both forks answered ${a.status} and ${b.status}`);
  const survivor = a.status === 200 ? a : b;
  assert.equal((await renew(survivor.body.refreshToken)).status, 401,
    'the fork that went first kept renewing after the other was seen');
});

test('a renewal whose answer was lost can be repeated later, and only the repeat carries on', async () => {
  const u = await signIn();
  const lost = await renew(u.refreshToken); // the device never received this
  assert.equal(lost.status, 200);
  // Well past the race window, the device tries again with what it still has.
  await backdate(u.refreshToken, 'rotated_at', '10 minutes');

  const retry = await renew(u.refreshToken);
  assert.equal(retry.status, 200, 'a device whose renewal answer was lost got signed out');
  const next = await renew(retry.body.refreshToken);
  assert.equal(next.status, 200);

  // The answer that was lost was retired when the retry replaced it, and it
  // turning up now means two holders exist, so the sign-in ends.
  assert.equal((await renew(lost.body.refreshToken)).status, 401);
  assert.equal((await renew(next.body.refreshToken)).status, 401, 'a replaced credential came back and the chain survived it');
});

// ── Staying revocable ────────────────────────────────────────────────────────

test('a replayed old credential ends the whole sign-in, the current holder included', async () => {
  const u = await signIn();
  // The person's device renews twice; a copy of the first credential was
  // taken before that.
  const first = await renew(u.refreshToken);
  const second = await renew(first.body.refreshToken);
  assert.equal(second.status, 200);
  await backdate(u.refreshToken, 'rotated_at', '10 minutes');

  const replay = await renew(u.refreshToken);
  assert.equal(replay.status, 401, 'an old credential whose successor was already used renewed again');
  assert.equal(replay.body.error, 'Session expired, please sign in again');

  // One of the two holders is not the person and there is no telling which,
  // so the live end of the chain is dead as well.
  assert.equal((await renew(second.body.refreshToken)).status, 401);
  const family = (await rowOf(u.refreshToken)).family_id;
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL', [family]
  );
  assert.equal(rows[0].n, 0);
});

test('a token_version bump ends every refresh credential, as it ends every access token', async () => {
  const u = await signIn();
  const other = await signIn();
  // Sign out everywhere, through the real route.
  const all = await call('POST', '/api/auth/logout-all', { session: u.token });
  assert.equal(all.status, 200);
  assert.equal((await renew(u.refreshToken)).status, 401,
    'sign out everywhere left a credential that renews the session it ended');
  // Somebody else's session is untouched.
  assert.equal((await renew(other.refreshToken)).status, 200);
});

test('a password change hands back a whole new session and ends the old credentials', async () => {
  const u = await signIn();
  const res = await call('PUT', '/api/users/profile', {
    session: u.token,
    body: { current_password: PASSWORD, new_password: 'BrandNew1' },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(typeof res.body.token, 'string');
  assert.equal(typeof res.body.refreshToken, 'string',
    'the password change returned an access token nothing can renew, which signs this device out a day later');

  assert.equal((await renew(u.refreshToken)).status, 401, 'a credential from before the change still renews');
  const renewed = await renew(res.body.refreshToken);
  assert.equal(renewed.status, 200);
  assert.equal((await call('GET', '/api/auth/me', { session: renewed.body.token })).status, 200);
});

test('a ban ends the session at the renewal, and lifting it does not revive the old credential', async () => {
  const u = await signIn();
  await pool.query('UPDATE users SET is_banned = true WHERE id = $1', [u.id]);
  const banned = await renew(u.refreshToken);
  assert.equal(banned.status, 403);
  assert.match(banned.body.error, /suspended/);

  await pool.query('UPDATE users SET is_banned = false WHERE id = $1', [u.id]);
  assert.equal((await renew(u.refreshToken)).status, 401, 'the banned session came back when the ban lifted');
});

test('signing out retires this sign-in only', async () => {
  const phone = await signIn();
  // The same account signed in on a laptop too.
  const laptopLogin = await call('POST', '/api/auth/login', { body: { email: phone.email, password: PASSWORD } });
  assert.equal(laptopLogin.status, 200);

  const out = await call('POST', '/api/auth/logout', {
    session: phone.token, body: { refreshToken: phone.refreshToken },
  });
  assert.equal(out.status, 200);
  assert.equal((await renew(phone.refreshToken)).status, 401,
    'a signed-out phone could go on renewing its session for weeks');
  assert.equal((await renew(laptopLogin.body.refreshToken)).status, 200, 'signing out the phone signed out the laptop');

  // A credential that is not the caller's is not the caller's to retire.
  const stranger = await signIn();
  await call('POST', '/api/auth/logout', { session: phone.token, body: { refreshToken: stranger.refreshToken } });
  assert.equal((await renew(stranger.refreshToken)).status, 200);
});

test('signing out on an access token that has already run out still ends the sign-in and drops the phone', async () => {
  // Tapping Log out after a day away. The client never renews to sign out, so
  // the access token it sends has run out, and this used to be a 401: the
  // family stayed renewable for weeks and the push row stayed.
  const u = await signIn();
  const pushToken = `fcm-${u.id}-${'x'.repeat(140)}`;
  await pool.query(
    'INSERT INTO device_tokens (user_id, token, device_type, signed_in_at) VALUES ($1, $2, $3, NOW())',
    [u.id, pushToken, 'ios']
  );
  const stale = expiredCopyOf(u.token);
  assert.equal((await call('GET', '/api/auth/me', { session: stale })).status, 401,
    'an expired token must still be refused everywhere but the sign-out');

  const out = await call('POST', '/api/auth/logout', {
    session: stale, body: { refreshToken: u.refreshToken, pushToken },
  });
  assert.equal(out.status, 200, out.text);
  assert.equal((await renew(u.refreshToken)).status, 401,
    'a sign-out on an expired token left the sign-in renewable');
  const { rows } = await pool.query('SELECT 1 FROM device_tokens WHERE token = $1', [pushToken]);
  assert.equal(rows.length, 0, 'a sign-out on an expired token left the phone registered to the account');
});

test('the sign-out waives the clock and nothing else', async () => {
  const u = await signIn();
  const stale = expiredCopyOf(u.token);
  const logout = (session) => call('POST', '/api/auth/logout', { session, body: {} });

  // Forged: signed with another secret.
  const { userId, tv, auth_time: authTime } = claimsOf(u.token);
  const now = Math.floor(Date.now() / 1000);
  const forged = jwt.sign({ userId, tv, auth_time: authTime, iat: now - 90000, exp: now - 3600 }, 'not-the-secret');
  assert.equal((await logout(forged)).status, 401, 'a forged expired token signed out');
  assert.equal((await logout(undefined)).status, 401);

  // Banned: refused as before.
  await pool.query('UPDATE users SET is_banned = true WHERE id = $1', [u.id]);
  assert.equal((await logout(stale)).status, 403);
  await pool.query('UPDATE users SET is_banned = false WHERE id = $1', [u.id]);

  // Revoked: a token from before a token_version bump is refused, expired or
  // not, exactly as it is on every other route.
  assert.equal((await logout(stale)).status, 200);
  await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [u.id]);
  assert.equal((await logout(stale)).status, 401, 'a revoked token signed out');
  assert.equal((await logout(u.token)).status, 401);

  // And the waiver is mounted on that one route: every other route mounts the
  // strict middleware or one of its other named variants.
  const routesDir = path.join(__dirname, '..', 'routes');
  const mounts = [];
  for (const file of fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'))) {
    for (const line of fs.readFileSync(path.join(routesDir, file), 'utf8').split(/\r?\n/)) {
      if (/authenticateAllowExpired\b/.test(line) && /router\.[a-z]+\(/.test(line)) mounts.push(`${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual(mounts, ["auth.js: router.post('/logout', authenticateAllowExpired, ["],
    `the expired-token waiver is mounted somewhere new: ${mounts.join(' | ')}`);
});

// ── The table does not grow for ever ─────────────────────────────────────────

test('the hourly prune deletes credentials no account can use again, and keeps the ones a check still needs', async () => {
  // An account that signed in, renewed once and never came back.
  const gone = await signIn();
  const goneNext = await renew(gone.refreshToken);
  assert.equal(goneNext.status, 200);
  const goneRows = [(await rowOf(gone.refreshToken)).id, (await rowOf(goneNext.body.refreshToken)).id];
  await pool.query(
    'UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL \'1 day\' WHERE id = ANY($1::bigint[])', [goneRows]
  );

  // An account still in use, whose first credential has expired while the
  // credential it was exchanged for is live. The parent stays: it is how a
  // second answer to it would be found.
  const kept = await signIn();
  const keptNext = await renew(kept.refreshToken);
  await backdate(kept.refreshToken, 'expires_at', `${refreshTokens.REFRESH_TOKEN_TTL_DAYS + 1} days`);

  const deleted = await refreshTokens.pruneExpiredRefreshTokens();
  assert.ok(deleted >= 2, `the prune deleted ${deleted} rows`);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM refresh_tokens WHERE id = ANY($1::bigint[])', [goneRows]);
  assert.equal(rows[0].n, 0, 'expired credentials of an account that never renews again were kept for ever');
  assert.ok(await rowOf(kept.refreshToken), 'an expired parent of a live credential was pruned');
  assert.equal((await rowOf(keptNext.body.refreshToken)).parent_id, (await rowOf(kept.refreshToken)).id);
  assert.equal((await renew(keptNext.body.refreshToken)).status, 200);

  // In batches: a batch of one still deletes everything there is to delete.
  const more = await signIn();
  await backdate(more.refreshToken, 'expires_at', `${refreshTokens.REFRESH_TOKEN_TTL_DAYS + 1} days`);
  const other = await signIn();
  await backdate(other.refreshToken, 'expires_at', `${refreshTokens.REFRESH_TOKEN_TTL_DAYS + 1} days`);
  assert.ok((await refreshTokens.pruneExpiredRefreshTokens(1)) >= 2);
  assert.equal(await rowOf(more.refreshToken), null);
  assert.equal(await rowOf(other.refreshToken), null);
});

test('server.js runs the prune on a timer and clears it on shutdown', () => {
  // Every pattern is anchored at the start of its line, so a line that was
  // commented out (it would start with //) does not satisfy it.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r/g, '');
  assert.match(src, /^let refreshPruneInterval = null;$/m);
  assert.match(src, /^\s*const refreshPrune = \(\) => pruneExpiredRefreshTokens\(\)$/m);
  assert.match(src, /^\s*refreshPruneInterval = setInterval\(refreshPrune, /m);
  const shutdown = src.slice(src.indexOf('function shutdown('));
  assert.match(shutdown, /^\s*if \(refreshPruneInterval\) clearInterval\(refreshPruneInterval\);$/m);
  assert.match(shutdown, /^\s*if \(refreshPruneKickoff\) clearTimeout\(refreshPruneKickoff\);$/m);
});

test('an idle credential expires, and junk is refused without a query', async () => {
  const u = await signIn();
  await backdate(u.refreshToken, 'expires_at', `${refreshTokens.REFRESH_TOKEN_TTL_DAYS + 1} days`);
  assert.equal((await renew(u.refreshToken)).status, 401);

  // Strings that are not a credential's shape are dead credentials like any
  // other; a body that is not even a string is a malformed request.
  for (const junk of ['', 'short', 'x'.repeat(43) + '=', '!'.repeat(43)]) {
    const res = await call('POST', '/api/auth/refresh', { body: { refreshToken: junk } });
    assert.equal(res.status, 401, `${JSON.stringify(junk)} answered ${res.status}`);
  }
  // The access token is not a refresh credential, and at its length it is not
  // even the shape of one.
  for (const junk of [null, 42, ['a'], { a: 1 }, 'x'.repeat(200), u.token]) {
    const res = await call('POST', '/api/auth/refresh', { body: { refreshToken: junk } });
    assert.equal(res.status, 400, `${JSON.stringify(junk).slice(0, 40)} answered ${res.status}`);
  }
  // Unknown but well-formed: the same answer as every other dead credential.
  const unknown = await renew(crypto.randomBytes(32).toString('base64url'));
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error, 'Session expired, please sign in again');
});

test('a deleted account takes its credentials with it', async () => {
  const u = await signIn();
  await pool.query('DELETE FROM users WHERE id = $1', [u.id]);
  assert.equal(await rowOf(u.refreshToken), null);
  assert.equal((await renew(u.refreshToken)).status, 401);
});
