// Run: node --test  (from backend/)
//
// Retention sweep for password_resets. The request ledger
// (password_reset_requests) has had a 7-day janitor since round 17; the token
// table did not, so every used or expired row — a token hash plus the request
// IP that asked for it — sat forever as dead PII. routes/auth.js now sweeps
// both tables from the same hourly, fire-and-forget janitor. This file pins:
//
//   1. Dead rows (used, or past expiry) older than the retention window are
//      deleted; EVERYTHING else survives, including a row that is old but
//      somehow still live — dead-state, not age, is what licenses deletion.
//   2. The sweep rides the same opportunistic trigger as the ledger sweep
//      (a /forgot-password request), is debounced to the hour, and carries the
//      retention as a bind parameter, not interpolated SQL.
//   3. A valid un-used token still resets after a sweep has run.
//   4. A sweep failure, or a sweep still in flight, never breaks the request
//      that triggered it, and a sweep racing an in-flight reset takes nothing.
//
// No database is touched: pool.query is a dispatcher over in-memory tables,
// the same technique passwordReset.test.js uses, including its round-19 rule —
// every WHERE guard is honoured only if the statement actually carries it, so
// a guard deleted from routes/auth.js stops being enforced here too.

// Env must be set before ANY require.
process.env.JWT_SECRET = 'test-secret-for-password-reset-purge-tests';
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
const resendPath = require.resolve('resend');
require.cache[resendPath] = {
  id: resendPath, filename: resendPath, loaded: true,
  exports: {
    Resend: class {
      constructor() {
        this.emails = {
          send: async (msg) => {
            sentMail.push(msg);
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
    exchangeAppleCode: async () => ({}),
    revokeAppleToken: async () => {},
  },
};

const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const authRouter = require('../routes/auth');
const emailService = require('../services/emailService');
const {
  canonicalEmail, flushResetMail, flushResetSweeps, rewindResetPurgeClock,
  RESET_ROW_RETENTION_DAYS, RESET_NEUTRAL_MESSAGE,
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

// Every executed token-table sweep, so the trigger pattern, the debounce and
// the bind parameter are all assertable.
let tokenSweeps = [];
// 'ok' | 'fail'; 'fail' models the database refusing the DELETE.
let sweepBehaviour = 'ok';
// When set, the token sweep waits on this promise before touching the table:
// the in-flight-sweep race is orchestrated, not timed.
let sweepHold = null;

const findByEmail = (email) => users.find((u) => String(u.email).toLowerCase() === String(email).toLowerCase())
  || users.find((u) => canonicalEmail(u.email) === canonicalEmail(email))
  || null;

// Round-19 rule: a guard is enforced only if the statement carries it.
const clause = (sql, re) => re.test(sql);

const realQuery = pool.query;
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  const now = Date.now();

  // ---- users --------------------------------------------------------------
  if (sql.includes('split_part') && sql.startsWith('SELECT * FROM users')) {
    const hit = findByEmail(params[0]);
    return { rows: hit ? [hit] : [] };
  }
  if (sql.startsWith('UPDATE users SET password = $1, token_version = token_version + 1')) {
    const row = users.find((u) => u.id === params[1]
      && (!clause(sql, /AND oauth_provider IS NULL/) || u.oauth_provider == null)
      && (!clause(sql, /AND is_banned IS NOT TRUE/) || u.is_banned !== true)
      && (!clause(sql, /AND LOWER\(email\) = LOWER\(\$3\)/)
        || String(u.email).toLowerCase() === String(params[2]).toLowerCase()));
    if (!row) return { rows: [], rowCount: 0 };
    row.password = params[0];
    if (clause(sql, /token_version = token_version \+ 1/)) row.token_version += 1;
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
  // Retiring a SUPERSEDED link deletes it rather than stamping used_at, so
  // /reset-password/check can tell "a newer one replaced this" apart from "this
  // one was spent". Both credential-change paths delete them too.
  if (sql.startsWith('DELETE FROM password_resets WHERE user_id')) {
    const before = resets.length;
    for (let i = resets.length - 1; i >= 0; i -= 1) {
      if (resets[i].user_id === params[0] && !resets[i].used_at) resets.splice(i, 1);
    }
    return { rows: [], rowCount: before - resets.length };
  }
  if (sql.startsWith('DELETE FROM password_resets')) {
    tokenSweeps.push({ sql, params });
    if (sweepBehaviour === 'fail') throw new Error('sweep exploded');
    if (sweepHold) await sweepHold;
    const late = Date.now(); // re-read: the hold may have parked us across writes
    const cutoff = late - Number(params[0]) * 86400e3;
    const takes = (r) => {
      const oldEnough = !clause(sql, /AND created_at </) || Date.parse(r.created_at) < cutoff;
      const dead = !clause(sql, /\(used_at IS NOT NULL OR expires_at <= NOW\(\)\)/)
        || Boolean(r.used_at) || Date.parse(r.expires_at) <= late;
      return oldEnough && dead;
    };
    const before = resets.length;
    resets = resets.filter((r) => !takes(r));
    return { rows: [], rowCount: before - resets.length };
  }
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
    const unused = (r) => !clause(sql, /AND used_at IS NULL/) || !r.used_at;
    const live = (r) => !clause(sql, /AND expires_at > NOW\(\)/) || Date.parse(r.expires_at) > now;
    if (sql.includes('WHERE id = $1')) {
      const r = resets.find((x) => x.id === params[0]);
      const ok = Boolean(r) && unused(r) && live(r);
      if (ok) r.used_at = new Date(now).toISOString();
      return { rows: ok ? [{ id: r.id }] : [], rowCount: ok ? 1 : 0 };
    }
    let n = 0;
    for (const r of resets) {
      if (r.user_id === params[0] && unused(r) && live(r)) { r.used_at = new Date(now).toISOString(); n += 1; }
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

const post = (path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function reset() {
  users = []; resets = []; requests = []; sentMail = []; tokenSweeps = [];
  nextUserId = 1; nextResetId = 1; nextRequestId = 1;
  sweepBehaviour = 'ok'; sweepHold = null;
  emailService.resetClient();
  rewindResetPurgeClock();
}

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

const DAY = 86400e3;
function addResetRow(overrides = {}) {
  const row = {
    id: nextResetId++, user_id: 999, selector: crypto.randomBytes(16).toString('hex'),
    verifier_hash: crypto.createHash('sha256').update(`v-${nextResetId}`).digest('hex'),
    email: 'someone@example.com', request_ip: '203.0.113.7',
    created_at: new Date(Date.now() - 3600e3).toISOString(),
    expires_at: new Date(Date.now() - 1000).toISOString(),
    used_at: null,
    ...overrides,
  };
  resets.push(row);
  return row;
}

function tokenFromLastMail() {
  const html = sentMail[sentMail.length - 1].html;
  const m = html.match(/reset-password#token=([A-Za-z0-9._%-]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Trigger the janitor the way production triggers it: an accepted
// /forgot-password request. A ghost address, so nothing is mailed, no token is
// minted, and the resets table holds exactly what the test seeded.
async function triggerSweep(email = `ghost-${crypto.randomBytes(4).toString('hex')}@example.com`) {
  const res = await post('/api/auth/forgot-password', { email });
  const body = await res.json();
  await flushResetMail();
  await flushResetSweeps();
  return { res, body };
}

// ---------------------------------------------------------------------------
// 1. What the sweep takes, and what it must never take.
// ---------------------------------------------------------------------------
test('used and expired rows past retention are deleted; everything else survives', async () => {
  reset();
  const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
  const ahead = (ms) => new Date(Date.now() + ms).toISOString();

  const usedOld = addResetRow({ created_at: ago(8), expires_at: ago(8 - 1 / 24), used_at: ago(8 - 1 / 48) });
  const expiredOld = addResetRow({ created_at: ago(8), expires_at: ago(8 - 1 / 24), used_at: null });
  const usedRecent = addResetRow({ created_at: ago(1 / 24), expires_at: ahead(3000e3), used_at: new Date().toISOString() });
  const expiredRecent = addResetRow({ created_at: ago(2), expires_at: ago(2 - 1 / 24), used_at: null });
  const liveNow = addResetRow({ created_at: new Date().toISOString(), expires_at: ahead(3600e3), used_at: null });
  // The retention-boundary adversary: OLDER than the window but somehow still
  // live. Cannot happen with a 60-minute TTL, which is exactly why it is the
  // row to seed — if age alone ever licenses deletion, this is the row that
  // catches it.
  const oldButLive = addResetRow({ created_at: ago(30), expires_at: ahead(3600e3), used_at: null });

  const { res } = await triggerSweep();
  assert.strictEqual(res.status, 200);

  const left = new Set(resets.map((r) => r.id));
  assert.ok(!left.has(usedOld.id), 'a used row past retention is dead PII and must go');
  assert.ok(!left.has(expiredOld.id), 'an expired row past retention must go');
  assert.ok(left.has(usedRecent.id), 'a recently used row stays, so /check can still say "used"');
  assert.ok(left.has(expiredRecent.id), 'a recently expired row stays, so /check can still say "expired"');
  assert.ok(left.has(liveNow.id), 'a live link is untouchable');
  assert.ok(left.has(oldButLive.id), 'age alone must never take a row a reset could still consume');
});

test('the retention window is the ledger\'s 7 days, and rides as a bind parameter', async () => {
  reset();
  assert.strictEqual(RESET_ROW_RETENTION_DAYS, 7);

  await triggerSweep();
  assert.strictEqual(tokenSweeps.length, 1, 'the token sweep must fire alongside the ledger sweep');
  const { sql, params } = tokenSweeps[0];
  assert.deepStrictEqual(params, [RESET_ROW_RETENTION_DAYS], 'retention is a parameter, not interpolated SQL');
  assert.ok(sql.includes('$1'), 'the interval must bind, not concatenate');
  assert.ok(!sql.includes(`${RESET_ROW_RETENTION_DAYS} day'`), 'no literal day count in the statement');
});

test('the sweep is debounced to the janitor\'s hour, not run per request', async () => {
  reset();
  await triggerSweep();
  assert.strictEqual(tokenSweeps.length, 1);

  // A second accepted request inside the hour: the janitor stays quiet.
  const second = await post('/api/auth/forgot-password', { email: 'another-ghost@example.com' });
  assert.strictEqual(second.status, 200);
  await second.text();
  await flushResetSweeps();
  assert.strictEqual(tokenSweeps.length, 1, 'one sweep per interval, same as the ledger');
});

// ---------------------------------------------------------------------------
// 2. Live resets are not collateral.
// ---------------------------------------------------------------------------
test('a valid un-used token still resets after a sweep has run', async () => {
  reset();
  const user = addPasswordUser();
  const req = await post('/api/auth/forgot-password', { email: user.email });
  assert.strictEqual(req.status, 200);
  await req.text();
  await flushResetMail();
  await flushResetSweeps();
  const token = tokenFromLastMail();
  assert.ok(token, 'a link was mailed');

  // A fresh sweep between issue and use, with dead neighbours to actually take.
  addResetRow({ created_at: new Date(Date.now() - 8 * DAY).toISOString() });
  rewindResetPurgeClock();
  await triggerSweep();
  assert.strictEqual(resets.filter((r) => r.user_id === user.id).length, 1, 'the live link survived the sweep');

  const res = await post('/api/auth/reset-password', { token, password: 'BrandNew1' });
  assert.strictEqual(res.status, 200);
  assert.ok(bcrypt.compareSync('BrandNew1', users[0].password), 'and it still works');
});

test('a sweep in flight while a token is spent takes nothing and blocks nothing', async () => {
  reset();
  const user = addPasswordUser();
  const req = await post('/api/auth/forgot-password', { email: user.email });
  await req.text();
  await flushResetMail();
  await flushResetSweeps();
  const token = tokenFromLastMail();

  // Park the NEXT sweep mid-flight, then trigger it.
  let releaseSweep;
  sweepHold = new Promise((r) => { releaseSweep = r; });
  rewindResetPurgeClock();
  const trigger = await post('/api/auth/forgot-password', { email: 'ghost-race@example.com' });
  assert.strictEqual(trigger.status, 200, 'the triggering request never waits on the sweep');
  assert.strictEqual((await trigger.json()).message, RESET_NEUTRAL_MESSAGE);

  // Spend the token while the sweep is still parked, then let it finish.
  const spend = await post('/api/auth/reset-password', { token, password: 'BrandNew1' });
  assert.strictEqual(spend.status, 200);
  releaseSweep();
  sweepHold = null;
  await flushResetSweeps();

  assert.ok(bcrypt.compareSync('BrandNew1', users[0].password), 'the reset won');
  const mine = resets.filter((r) => r.user_id === user.id);
  assert.strictEqual(mine.length, 1, 'the just-spent row is recent, so the sweep left it for /check to explain');
  assert.ok(mine[0].used_at, 'spent, not deleted');
});

// ---------------------------------------------------------------------------
// 3. Failure is invisible, exactly like the ledger sweep's.
// ---------------------------------------------------------------------------
test('a failed sweep never fails the request that triggered it, and the flow still works', async () => {
  reset();
  sweepBehaviour = 'fail';
  const user = addPasswordUser();

  const res = await post('/api/auth/forgot-password', { email: user.email });
  assert.strictEqual(res.status, 200, 'the janitor breaking is not the caller\'s problem');
  assert.strictEqual((await res.json()).message, RESET_NEUTRAL_MESSAGE);
  await flushResetMail();
  await flushResetSweeps();
  assert.strictEqual(tokenSweeps.length, 1, 'the sweep was attempted');
  assert.strictEqual(sentMail.length, 1, 'the mail still went out');
  assert.strictEqual(resets.length, 1, 'the token was still issued');

  // And the mailed link is not damaged by the failure.
  sweepBehaviour = 'ok';
  const spend = await post('/api/auth/reset-password', { token: tokenFromLastMail(), password: 'BrandNew1' });
  assert.strictEqual(spend.status, 200);
  assert.ok(bcrypt.compareSync('BrandNew1', users[0].password));
});
