// Run: node --test  (from backend/)
//
// THE WAITLIST BECOMES A LOOP INSTEAD OF A BUCKET.
//
// Joining the waitlist has always sent a confirmation (waitlist.js,
// waitlistMailConsolidation.test.js). What never existed was the other end:
// nothing could ever tell those people the app is out, and an account created
// with a waitlisted email never touched its row, so "your friends on the
// waitlist get informed, and their signup counts from when they joined" was a
// promise with no machinery. Jayden asked for the machinery on 2026-08-27.
//
// What is pinned here:
//   1. THE ANNOUNCE ROUTE IS ADMIN-ONLY and idempotent by column: a row is
//      picked only while announced_at IS NULL and unconverted, and stamping
//      happens exactly when the email's fate is settled (sent, or permanently
//      unsendable). Transient failures leave the row for the next run.
//   2. DRY RUN COUNTS AND SENDS NOTHING.
//   3. SIGNUP LINKS THE ROW. All three account-creation paths (password,
//      Google, Apple) call linkWaitlistConversion, so an arriving waitlister
//      is recorded and never re-announced. Source-pinned because the three
//      sites live deep inside OAuth flows a unit harness cannot cheaply walk.
//   4. THE MIGRATION CARRIES THE THREE COLUMNS the route and the hook write.
//   5. THE LAUNCH EMAIL is marketing-category (so the do-not-mail list and
//      the one-click unsubscribe apply), tells the truth about place-in-line,
//      and carries no em dash.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'waitlist-launch-test-secret';

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

const ADMIN = { id: 9, email: 'admin@example.com', name: 'Admin', role: 'admin', email_verified: true, is_banned: false, token_version: 0 };
const USER = { id: 3, email: 'user@example.com', name: 'User', role: 'user', email_verified: true, is_banned: false, token_version: 0 };
const CURRENT = { user: ADMIN };

// Scripted pool: answers the auth lookup from CURRENT, and everything else
// from the per-test script below.
let waitlistRows = [];
let statsRow = { total: 0, converted: 0, announced: 0, pending: 0 };
let updates = [];
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (sql.includes('FROM users WHERE id = $1') && sql.includes('token_version')) {
    return { rows: [CURRENT.user], rowCount: 1 };
  }
  if (sql.includes('FROM waitlist') && sql.includes('COUNT(*)')) {
    return { rows: [statsRow], rowCount: 1 };
  }
  if (sql.startsWith('SELECT id, email FROM waitlist')) {
    return { rows: waitlistRows, rowCount: waitlistRows.length };
  }
  if (sql.startsWith('UPDATE waitlist SET announced_at')) {
    updates.push(params[0]);
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};
pool.connect = async () => { throw new Error('pool.connect reached unexpectedly'); };

const emailService = require('../services/emailService');
let outcomes = {};
let sendsAsked = [];
emailService.sendWaitlistLaunchEmail = async ({ to }) => {
  sendsAsked.push(to);
  return outcomes[to] || { sent: true };
};

const app = express();
app.use(express.json());
app.use('/api/admin', require('../routes/admin'));
const server = http.createServer(app);

function call(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const addr = server.address();
    const req = http.request({
      host: '127.0.0.1', port: addr.port, path: urlPath, method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function reset() {
  waitlistRows = [];
  statsRow = { total: 0, converted: 0, announced: 0, pending: 0 };
  updates = [];
  outcomes = {};
  sendsAsked = [];
  CURRENT.user = ADMIN;
}

test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
test.after(() => new Promise((resolve) => server.close(resolve)));

test('a non-admin cannot announce', async () => {
  reset();
  CURRENT.user = USER;
  const res = await call('POST', '/api/admin/waitlist/announce', {}, signUserToken(USER));
  assert.strictEqual(res.status, 403);
  assert.strictEqual(sendsAsked.length, 0);
});

test('dry run counts and sends nothing', async () => {
  reset();
  statsRow = { total: 40, converted: 5, announced: 10, pending: 25 };
  const res = await call('POST', '/api/admin/waitlist/announce', { dry_run: true }, signUserToken(ADMIN));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.dry_run, true);
  assert.strictEqual(res.body.pending, 25);
  assert.strictEqual(sendsAsked.length, 0);
  assert.strictEqual(updates.length, 0);
});

test('a sent or permanently unsendable email stamps the row; a transient failure leaves it for the next run', async () => {
  reset();
  statsRow = { total: 4, converted: 0, announced: 0, pending: 4 };
  waitlistRows = [
    { id: 1, email: 'ok@example.com' },
    { id: 2, email: 'gone@example.com' },
    { id: 3, email: 'bad@example.com' },
    { id: 4, email: 'flaky@example.com' },
  ];
  outcomes = {
    'ok@example.com': { sent: true },
    'gone@example.com': { sent: false, suppressed: true, reason: 'unsubscribed', refused: true },
    'bad@example.com': { sent: false, error: 'invalid recipient', refused: true },
    'flaky@example.com': { sent: false, error: 'provider 500' },
  };
  const res = await call('POST', '/api/admin/waitlist/announce', {}, signUserToken(ADMIN));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.batch, 4);
  assert.strictEqual(res.body.sent, 1);
  assert.strictEqual(res.body.suppressed, 2, 'do-not-mail and invalid address are both settled fates');
  assert.strictEqual(res.body.failed, 1);
  assert.deepStrictEqual(updates.sort(), [1, 2, 3], 'the flaky row is NOT stamped, so the next run retries it');
});

test('every waiting person is asked about, in list order', async () => {
  reset();
  statsRow = { total: 2, converted: 0, announced: 0, pending: 2 };
  waitlistRows = [
    { id: 7, email: 'first@example.com' },
    { id: 8, email: 'second@example.com' },
  ];
  const res = await call('POST', '/api/admin/waitlist/announce', {}, signUserToken(ADMIN));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(sendsAsked, ['first@example.com', 'second@example.com']);
});

// ---------------------------------------------------------------------------
// Source pins.
// ---------------------------------------------------------------------------
const AUTH_SRC = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
const EMAIL_SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'emailService.js'), 'utf8');
const MIG_SRC = fs.readFileSync(path.join(__dirname, '..', 'migrations', '054_waitlist_launch.sql'), 'utf8');

test('all three account-creation paths link the waitlist row', () => {
  const calls = AUTH_SRC.match(/linkWaitlistConversion\(user\.email, user\.id\);/g) || [];
  assert.strictEqual(calls.length, 3, 'password, Google and Apple signups each claim the row');
  assert.match(AUTH_SRC, /WHERE LOWER\(email\) = LOWER\(\$1\) AND converted_user_id IS NULL/);
  assert.match(AUTH_SRC, /\.catch\(/, 'fire and forget: a marketing table must never fail a signup');
});

test('the migration carries the three columns the loop writes', () => {
  assert.match(MIG_SRC, /ADD COLUMN IF NOT EXISTS announced_at TIMESTAMPTZ/);
  assert.match(MIG_SRC, /ADD COLUMN IF NOT EXISTS converted_user_id INTEGER REFERENCES users\(id\) ON DELETE CASCADE/,
    'a claimed waitlist row dies with the account; SET NULL would strand the address');
  assert.match(MIG_SRC, /ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ/);
});

test('the launch email is marketing-category, honest about place in line, and em dash free', () => {
  const start = EMAIL_SRC.indexOf('async function sendWaitlistLaunchEmail');
  assert.ok(start > -1);
  const end = EMAIL_SRC.indexOf('module.exports', start);
  const fn = EMAIL_SRC.slice(start, end);
  assert.match(fn, /category: 'marketing'/, 'the do-not-mail list and unsubscribe apply');
  assert.match(fn, /List-Unsubscribe/);
  assert.match(fn, /APP_STORE_URL/, 'points at the store once that env var exists');
  assert.match(fn, /your spot counts from the day you joined the list/);
  assert.ok(!fn.includes('—'), 'no em dashes in anything a user reads');
});
