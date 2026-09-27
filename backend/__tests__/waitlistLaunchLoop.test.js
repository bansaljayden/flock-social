// Run: node --test  (from backend/)
//
// THE WAITLIST BECOMES A LOOP INSTEAD OF A BUCKET.
//
// Joining the waitlist has always sent a confirmation (waitlist.js,
// waitlistMailConsolidation.test.js). What never existed was the other end:
// nothing could ever tell those people the app is out, and an account created
// with a waitlisted email never touched its row, so "your friends on the
// waitlist get informed, and their signup counts from when they joined" was a
// promise with no machinery. The machinery was specified on 2026-08-27.
//
// What is pinned here:
//   1. THE ANNOUNCE ROUTE IS ADMIN-ONLY and idempotent by column: a row is
//      picked only while announced_at IS NULL and unconverted, and it is
//      stamped as it is picked, before its email goes, so two runs that
//      overlap cannot both mail it. The stamp is handed back only when the
//      email certainly did not leave (a refusal, a keyless deploy); a send
//      whose outcome is unknown, like the 8 second abort, keeps it.
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
// The route refuses a real send until the launch mail can point at the store.
process.env.APP_STORE_URL = 'https://apps.apple.com/app/id0000000000';

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

const ADMIN = { id: 9, email: 'admin@example.com', name: 'Admin', role: 'admin', email_verified: true, is_banned: false, token_version: 0 };
const USER = { id: 3, email: 'user@example.com', name: 'User', role: 'user', email_verified: true, is_banned: false, token_version: 0 };
const CURRENT = { user: ADMIN };

// Scripted pool: answers the auth lookup from CURRENT, and the waitlist
// statements against a small table held here. The table is what the tests
// read back, so they judge which rows end up marked announced and who was
// mailed, not how the route spells its SQL: a read of the unannounced rows, a
// claim of the next one, and a stamp or an unstamp by id each act on it.
let waitlistRows = [];
let statsRow = { total: 0, converted: 0, announced: 0, pending: 0 };
function unannounced() {
  return waitlistRows
    .filter((r) => !r.announced && !r.converted)
    .sort((a, b) => a.id - b.id);
}
const announcedIds = () => waitlistRows.filter((r) => r.announced).map((r) => r.id).sort((a, b) => a - b);
pool.query = async (text, params = []) => {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (sql.includes('FROM users WHERE id = $1') && sql.includes('token_version')) {
    return { rows: [CURRENT.user], rowCount: 1 };
  }
  if (sql.includes('FROM waitlist') && sql.includes('COUNT(*)')) {
    return { rows: [statsRow], rowCount: 1 };
  }
  // Claim the next unannounced row after an id, marking it as it is taken.
  // One statement in Postgres, so nothing can run between the read and the
  // mark here either.
  if (/^UPDATE waitlist SET announced_at = NOW\(\) WHERE id = \(SELECT id FROM waitlist/.test(sql)) {
    const after = /id > \$1/.test(sql) ? Number(params[0]) : 0;
    const row = unannounced().find((r) => r.id > after);
    if (!row) return { rows: [], rowCount: 0 };
    row.announced = true;
    return { rows: [{ id: row.id, email: row.email }], rowCount: 1 };
  }
  if (sql.startsWith('SELECT id, email FROM waitlist')) {
    const rows = unannounced().slice(0, 100).map(({ id, email }) => ({ id, email }));
    return { rows, rowCount: rows.length };
  }
  if (/^UPDATE waitlist SET announced_at = NOW\(\) WHERE id = \$1/.test(sql)) {
    const row = waitlistRows.find((r) => r.id === params[0]);
    if (row) row.announced = true;
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  if (/^UPDATE waitlist SET announced_at = NULL WHERE id = \$1/.test(sql)) {
    const row = waitlistRows.find((r) => r.id === params[0]);
    if (row) row.announced = false;
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  return { rows: [], rowCount: 0 };
};
pool.connect = async () => { throw new Error('pool.connect reached unexpectedly'); };

const emailService = require('../services/emailService');
let outcomes = {};
let sendsAsked = [];
// How long each send takes, so two runs can be made to overlap the way two
// calls do while Resend is slow.
let sendDelayMs = 0;
emailService.sendWaitlistLaunchEmail = async ({ to }) => {
  sendsAsked.push(to);
  if (sendDelayMs) await new Promise((r) => setTimeout(r, sendDelayMs));
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
    const req = http.request({ agent: false,
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
  outcomes = {};
  sendsAsked = [];
  sendDelayMs = 0;
  CURRENT.user = ADMIN;
}

test.before(() => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)));
test.after(() => new Promise((resolve) => server.close(resolve)));

test('a real send is refused while APP_STORE_URL is unset, and nothing goes out', async () => {
  // Without the variable the button resolves to `${web}/signup`, a web signup
  // form, in a mail titled for an iOS launch. The dry run still reports.
  const saved = process.env.APP_STORE_URL;
  delete process.env.APP_STORE_URL;
  try {
    statsRow = { total: 4, converted: 0, announced: 0, pending: 4 };
    const dry = await call('POST', '/api/admin/waitlist/announce', { dry_run: true }, signUserToken(ADMIN));
    assert.strictEqual(dry.status, 200);
    const res = await call('POST', '/api/admin/waitlist/announce', {}, signUserToken(ADMIN));
    assert.strictEqual(res.status, 409);
    assert.match(res.body.error, /APP_STORE_URL/);
  } finally {
    process.env.APP_STORE_URL = saved;
  }
});

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
  assert.deepStrictEqual(announcedIds(), []);
});

test('only an email that certainly did not leave is handed back to the next run', async () => {
  reset();
  statsRow = { total: 6, converted: 0, announced: 0, pending: 6 };
  waitlistRows = [
    { id: 1, email: 'ok@example.com' },
    { id: 2, email: 'gone@example.com' },
    { id: 3, email: 'bad@example.com' },
    { id: 4, email: 'capped@example.com' },
    { id: 5, email: 'keyless@example.com' },
    { id: 6, email: 'aborted@example.com' },
  ];
  // Each outcome in the shape services/emailService.js sendEmail returns it.
  outcomes = {
    'ok@example.com': { sent: true },
    'gone@example.com': { sent: false, suppressed: true, reason: 'unsubscribed', refused: true },
    'bad@example.com': { sent: false, error: 'invalid recipient', refused: true },
    'capped@example.com': { sent: false, error: 'per-recipient daily cap', refused: true },
    'keyless@example.com': { sent: false, skipped: true },
    // The 8 second abort, or a 5xx: Resend may already have queued it.
    'aborted@example.com': { sent: false, error: 'This operation was aborted' },
  };
  const res = await call('POST', '/api/admin/waitlist/announce', {}, signUserToken(ADMIN));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.batch, 6);
  assert.strictEqual(res.body.sent, 1);
  assert.strictEqual(res.body.suppressed, 2, 'do-not-mail and invalid address are both settled fates');
  assert.strictEqual(res.body.failed, 2, 'a refusal and a keyless deploy sent nothing');
  assert.strictEqual(res.body.unknown, 1);
  assert.strictEqual(res.body.remaining, 2);
  assert.deepStrictEqual(announcedIds(), [1, 2, 3, 6],
    'the refused and skipped rows go back for the next run; the aborted one stays marked, because it may have been sent');

  // The next run retries exactly the two that certainly did not go out.
  sendsAsked = [];
  outcomes = {};
  const again = await call('POST', '/api/admin/waitlist/announce', {}, signUserToken(ADMIN));
  assert.strictEqual(again.status, 200);
  assert.deepStrictEqual(sendsAsked, ['capped@example.com', 'keyless@example.com'],
    'an aborted launch email was sent a second time');
});

test('two runs that overlap mail each waiting person once', async () => {
  // A slow Resend day: one call runs for minutes, the operator's client gives
  // up, and they run it again while the first is still sending.
  reset();
  statsRow = { total: 5, converted: 0, announced: 0, pending: 5 };
  waitlistRows = [1, 2, 3, 4, 5].map((id) => ({ id, email: `person${id}@example.com` }));
  sendDelayMs = 30;
  const [a, b] = await Promise.all([
    call('POST', '/api/admin/waitlist/announce', {}, signUserToken(ADMIN)),
    call('POST', '/api/admin/waitlist/announce', {}, signUserToken(ADMIN)),
  ]);
  assert.strictEqual(a.status, 200);
  assert.strictEqual(b.status, 200);
  assert.deepStrictEqual([...sendsAsked].sort(), waitlistRows.map((r) => r.email).sort(),
    'somebody on the waitlist got the launch email twice');
  assert.strictEqual(a.body.sent + b.body.sent, 5);
  assert.deepStrictEqual(announcedIds(), [1, 2, 3, 4, 5]);
});

test('a row given back after a refusal is not taken again by the same run', async () => {
  // Without a cursor the run would claim the lowest unannounced id again,
  // which is the row it just released, and mail one refusing address over and
  // over until the batch ran out.
  reset();
  statsRow = { total: 2, converted: 0, announced: 0, pending: 2 };
  waitlistRows = [
    { id: 1, email: 'capped@example.com' },
    { id: 2, email: 'next@example.com' },
  ];
  outcomes = { 'capped@example.com': { sent: false, error: 'per-recipient daily cap', refused: true } };
  const res = await call('POST', '/api/admin/waitlist/announce', {}, signUserToken(ADMIN));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(sendsAsked, ['capped@example.com', 'next@example.com']);
  assert.deepStrictEqual(announcedIds(), [2]);
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
