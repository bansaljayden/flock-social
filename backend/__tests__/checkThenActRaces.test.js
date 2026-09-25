'use strict';
// ---------------------------------------------------------------------------
// CHECK-THEN-ACT RACES, ON A REAL POSTGRES.
//
// Three places read something, awaited, and then wrote as if nothing could
// have happened in between:
//
//   * POST /api/auth/forgot-password read the per-address budget, then wrote
//     the ledger row and mailed. A parallel burst all read the same counts, so
//     the sixty-second gap and the hourly and daily caps held only against
//     requests that arrived one at a time, and any mailbox could be buried.
//   * POST /api/auth/resend-verification did the same with the per-account
//     budget.
//   * routes/revenuecat.js syncPremiumFromRevenueCat read RevenueCat and then
//     wrote an absolute is_premium, so a slow read taken before a refund could
//     commit after a fast read taken after it and leave the account Pro.
//
// Each now holds a transaction-scoped advisory lock across the read and the
// write. A scripted pool cannot show that a lock blocks anything, so this
// suite runs the real routes and the real sync against a migrated embedded
// Postgres and fires the requests together.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');

const PG_PORT = pickEmbeddedPgPort('checkThenActRaces');
const DB_NAME = 'flock_check_then_act_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-check-then-act-races';
delete process.env.BAN_TOMBSTONE_SECRET;
delete process.env.RESEND_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.FIREBASE_SERVICE_ACCOUNT;
// Fake, assembled at runtime so nothing here looks like a real key.
process.env.REVENUECAT_SECRET_API_KEY = ['rc', 'secret', 'r'.repeat(24)].join('-');

// RevenueCat is a fake global fetch, answered by whichever handler the test
// installs. Nothing leaves the process.
const realFetch = global.fetch;
let rcHandler = null;
global.fetch = async (url, init) => {
  if (String(url).startsWith('https://api.revenuecat.com/') && rcHandler) return rcHandler(String(url), init);
  return realFetch(url, init);
};

let pg;
let pool;
let dataDir;
let server;
let base;
let authRouter;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-check-then-act-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'checkThenActRaces', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  authRouter = require('../routes/auth');
  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/auth', authRouter);
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  global.fetch = realFetch;
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function call(method, p, { token, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

const PASSWORD = 'R4ceCondition';
const signup = (email) => call('POST', '/api/auth/signup', {
  body: { email, password: PASSWORD, name: 'Riley', date_of_birth: '2000-01-01' },
});
const count = async (sql, params = []) => (await pool.query(sql, params)).rows[0].n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond) => { for (let i = 0; i < 400 && !cond(); i += 1) await sleep(5); };
const statusesOf = (answers) => answers.map((a) => a.status);

test('a burst of reset requests for one address passes the budget exactly as often as requests one at a time would', async () => {
  const s = await signup('burst.reset@example.com');
  assert.strictEqual(s.status, 201, s.text);
  await pool.query('DELETE FROM password_reset_requests WHERE id > 0');
  const burst = () => Promise.all(Array.from({ length: 8 }, () =>
    call('POST', '/api/auth/forgot-password', { body: { email: 'burst.reset@example.com' } })));

  // The sixty-second gap: one request of the burst is accepted, the rest are
  // refused with the ordinary 429, and one reset link is issued.
  let statuses = statusesOf(await burst());
  assert.strictEqual(statuses.filter((x) => x === 200).length, 1, `a burst passed the gap more than once: ${statuses}`);
  assert.strictEqual(statuses.filter((x) => x === 429).length, 7, `${statuses}`);
  await authRouter.__testing.flushResetMail();
  assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM password_reset_requests'), 1);
  assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM password_resets WHERE user_id = $1', [s.body.user.id]), 1,
    'more than one reset link was issued for one address');

  // The hourly cap (three) holds under bursts too: with the gap opened before
  // each burst, exactly one more request gets through each time, and none once
  // three are in the hour.
  const accepted = [1];
  for (let round = 0; round < 3; round += 1) {
    await pool.query("UPDATE password_reset_requests SET created_at = created_at - INTERVAL '2 minutes' WHERE id > 0");
    statuses = statusesOf(await burst());
    accepted.push(statuses.filter((x) => x === 200).length);
  }
  assert.deepStrictEqual(accepted, [1, 1, 1, 0], 'the hourly cap was exceeded by a burst');
  assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM password_reset_requests'), 3);
  await authRouter.__testing.flushResetMail();
});

test('a single reset request is still accepted and recorded once', async () => {
  const s = await signup('single.reset@example.com');
  assert.strictEqual(s.status, 201, s.text);
  await pool.query('DELETE FROM password_reset_requests WHERE id > 0');
  const one = await call('POST', '/api/auth/forgot-password', { body: { email: 'single.reset@example.com' } });
  assert.strictEqual(one.status, 200, one.text);
  // An address with no account is budgeted the same way, so a refusal still
  // says nothing about whether the mailbox has one.
  const ghost = await call('POST', '/api/auth/forgot-password', { body: { email: 'nobody.here@example.com' } });
  assert.strictEqual(ghost.status, 200, ghost.text);
  assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM password_reset_requests'), 2);
  await authRouter.__testing.flushResetMail();
});

test('a burst of resend requests issues one confirmation link, not one per request', async () => {
  const s = await signup('burst.verify@example.com');
  assert.strictEqual(s.status, 201, s.text);
  const userId = s.body.user.id;
  assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM email_verifications WHERE user_id = $1', [userId]), 1,
    'signup should have issued the first link');
  // Past the sixty-second gap, so exactly one resend is due.
  await pool.query("UPDATE email_verifications SET created_at = created_at - INTERVAL '2 minutes' WHERE user_id = $1", [userId]);

  const answers = await Promise.all(Array.from({ length: 8 }, () =>
    call('POST', '/api/auth/resend-verification', { token: s.body.token })));
  const statuses = statusesOf(answers);
  assert.strictEqual(statuses.filter((x) => x === 200).length, 1, `a burst was sent more than once: ${statuses}`);
  assert.strictEqual(statuses.filter((x) => x === 429).length, 7, `${statuses}`);
  assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM email_verifications WHERE user_id = $1', [userId]), 2);
  assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM email_verifications WHERE user_id = $1 AND used_at IS NULL', [userId]), 1,
    'exactly one link is live, the one the accepted request issued');
});

test('two overlapping Pro syncs for one account: the second reads RevenueCat only after the first has committed', async () => {
  const { rows: [u] } = await pool.query(
    "INSERT INTO users (email, password, name) VALUES ('sync.race@example.com', 'x', 'S') RETURNING id"
  );
  const { syncPremiumFromRevenueCat } = require('../routes/revenuecat');
  const future = new Date(Date.now() + 30 * 864e5).toISOString();
  let rcActive = true;
  let reads = 0;
  let letFirstReadFinish;
  const firstReadHeld = new Promise((r) => { letFirstReadFinish = r; });
  const seen = [];
  rcHandler = async (url) => {
    if (!url.includes('/subscribers/')) return new Response('{}', { status: 200 });
    reads += 1;
    const n = reads;
    const answer = rcActive;
    seen.push(`read${n}:${answer}`);
    if (n === 1) await firstReadHeld;
    return new Response(JSON.stringify({ subscriber: { entitlements: answer ? { pro: { expires_date: future } } : {} } }), { status: 200 });
  };
  try {
    const first = syncPremiumFromRevenueCat(u.id);
    await until(() => reads === 1);
    rcActive = false; // a refund lands at RevenueCat while the first read is out
    const second = syncPremiumFromRevenueCat(u.id);
    await sleep(200);
    assert.strictEqual(reads, 1, 'the second sync read RevenueCat while the first still held the account');
    letFirstReadFinish();
    assert.deepStrictEqual(await Promise.all([first, second]), [true, false]);
    assert.deepStrictEqual(seen, ['read1:true', 'read2:false']);
    const { rows: [row] } = await pool.query('SELECT is_premium FROM users WHERE id = $1', [u.id]);
    assert.strictEqual(row.is_premium, false, 'a stale read left a refunded account Pro');
  } finally {
    rcHandler = null;
  }
});

test('Pro syncs for different accounts do not wait on each other', async () => {
  const { rows: [a] } = await pool.query("INSERT INTO users (email, password, name) VALUES ('sync.a@example.com', 'x', 'A') RETURNING id");
  const { rows: [b] } = await pool.query("INSERT INTO users (email, password, name) VALUES ('sync.b@example.com', 'x', 'B') RETURNING id");
  const { syncPremiumFromRevenueCat } = require('../routes/revenuecat');
  const future = new Date(Date.now() + 30 * 864e5).toISOString();
  let letSlowFinish;
  const slowHeld = new Promise((r) => { letSlowFinish = r; });
  rcHandler = async (url) => {
    if (url.includes(`/subscribers/${a.id}`)) await slowHeld;
    return new Response(JSON.stringify({ subscriber: { entitlements: { pro: { expires_date: future } } } }), { status: 200 });
  };
  try {
    const slow = syncPremiumFromRevenueCat(a.id);
    await sleep(50);
    assert.strictEqual(await syncPremiumFromRevenueCat(b.id), true, 'one account\'s sync waited on another\'s');
    const { rows: [rowB] } = await pool.query('SELECT is_premium FROM users WHERE id = $1', [b.id]);
    assert.strictEqual(rowB.is_premium, true);
    letSlowFinish();
    assert.strictEqual(await slow, true);
  } finally {
    rcHandler = null;
  }
});
