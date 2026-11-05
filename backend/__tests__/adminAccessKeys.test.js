'use strict';
// Run: node --test  (from backend/)
//
// ADMIN ACCESS KEYS ON A REAL DATABASE, THROUGH EVERY REAL ROUTER.
//
// Migration 135 and middleware/adminKeys.js, end to end: a key minted from a
// fresh session, used, logged, expired, revoked and ended, against an embedded
// Postgres with the whole migration chain applied. The route rules are proved
// against every router server.js mounts, in server.js's own order, read from
// server.js rather than copied, because the order is part of the rule: the
// two bare /api catch-alls see every request after them, and a key bound for
// /api/admin has to pass them without either one running.
//
// What this holds, in order:
//   1. the migration: both tables, their checks, the cascade, a replay;
//   2. minting: a session signed in within the window, never a key; the key in
//      that one answer and stored only as its hash; days and the ceiling;
//   3. a key at work: who it acts as, the use log written before the route
//      runs and its status after, last used, and refusal when the log cannot
//      be written;
//   4. what ends a key: expiry, revocation, sign out everywhere, the admin
//      role going, a ban, the account going;
//   5. the route list: every admin route has a decision, every authenticated
//      route outside /api/admin answers a live key with 403, every refused
//      admin route answers 403, every listed one lets it through;
//   6. listing and revoking: metadata only, a session to list, a key revoking
//      itself and no other.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');
const { removeTempDir } = require('./helpers/removeTempDir');

const PG_PORT = pickEmbeddedPgPort('adminAccessKeys');
const DB_NAME = 'flock_admin_access_keys_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-admin-access-keys';
// Nothing this file runs may reach a vendor: every route that would read one
// finds it not connected.
for (const k of [
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'REVENUECAT_SECRET_API_KEY', 'REVENUECAT_WEBHOOK_SECRET',
  'RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'BESTTIME_API_KEY', 'BESTTIME_API_KEY_PRIVATE', 'BESTTIME_API_KEY_PUBLIC',
  'MAPTILER_SERVICE_TOKEN', 'GEMINI_API_KEY', 'GOOGLE_PLACES_API_KEY', 'VISION_API_KEY', 'FIREBASE_SERVICE_ACCOUNT',
  'POSTHOG_API_KEY', 'SENTRY_DSN', 'TICKETMASTER_API_KEY', 'WEATHER_API_KEY', 'OPENWEATHER_API_KEY',
  'APPLE_PRIVATE_KEY', 'APPLE_TEAM_ID', 'APPLE_KEY_ID', 'NFC_TAG_SECRET', 'PAYWALL_ENABLED', 'ADMIN_USER_IDS',
]) delete process.env[k];

const BACKEND = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const MIGRATION = path.join(BACKEND, 'migrations', '135_admin_access_keys.sql');

let pg;
let pool;
let dataDir;
let server;
let base;
let auth;
let keys;
let adminRouter;
let mounts;
let seq = 0;

// Everything the server printed while this file ran, so no key can be shown
// to have reached a log.
const printed = [];
for (const level of ['log', 'warn', 'error', 'info']) {
  const real = console[level].bind(console);
  console[level] = (...args) => {
    printed.push(args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    if (level === 'error') real(...args);
  };
}

// Every email the code asked to send, in order, and what the stand-in sender
// answers. services/emailService.js is replaced on its module object, which is
// what routes/admin.js, routes/keyApproval.js and services/adminKeyMail.js
// call through, so nothing here reaches Resend.
let mails = [];
let mailAnswer = () => ({ sent: true, id: 'test-mail' });

const fakeIo = {
  to: () => fakeIo,
  in: () => fakeIo,
  emit: () => true,
  disconnectSockets: () => {},
  fetchSockets: async () => [],
  sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
};

// Every `app.use('/api…', …, <router>)` in server.js, in order, with the module
// each one mounts. A mount whose last argument is a limiter alone is skipped:
// it adds no router.
function serverMounts() {
  const named = new Map();
  for (const m of SERVER_SRC.matchAll(/^const (\w+) = require\('\.\/routes\/([\w-]+)'\);/gm)) named.set(m[1], { file: m[2], prop: null });
  const out = [];
  for (const line of SERVER_SRC.split('\n')) {
    const code = line.replace(/\s+\/\/.*$/, '');
    const m = /^app\.use\('(\/api[^']*)',\s*(.+)\);$/.exec(code);
    if (!m) continue;
    const last = m[2].split(',').pop().trim();
    const inline = /^require\('\.\/routes\/([\w-]+)'\)(?:\.(\w+))?$/.exec(last);
    const mod = inline ? { file: inline[1], prop: inline[2] || null } : named.get(last);
    if (mod) out.push({ prefix: m[1], ...mod });
  }
  return out;
}

async function insertUser({ role = 'user', name = 'Ava Lee' } = {}) {
  seq += 1;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password, name, role, email_verified)
     VALUES ($1, 'x', $2, $3, true) RETURNING *`,
    [`keys${seq}.${Date.now()}@example.com`, name, role]
  );
  return u;
}

const freshRow = async (id) => (await pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0];

// A session token signed in `ago` seconds before now, the way a sign-in or a
// renewal of that sign-in mints one.
function session(user, ago = 0) {
  return auth.signUserToken(user, { authTime: Math.floor(Date.now() / 1000) - ago });
}

async function call(method, p, { bearer, body } = {}) {
  const headers = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text, headers: res.headers };
}

async function mint(user, body = { name: 'Test tools' }) {
  const res = await call('POST', '/api/admin/keys', { bearer: session(user), body });
  assert.strictEqual(res.status, 201, res.text);
  return res.body;
}

// A mint from a session that signed in two hours ago: a pending key, and the
// approval email it sent. The token is read out of the email's Approve link,
// the only place it exists.
async function mintPending(user, body = { name: 'Phone approved' }) {
  const before = mails.length;
  const res = await call('POST', '/api/admin/keys', { bearer: session(user, 2 * 3600), body });
  assert.strictEqual(res.status, 202, res.text);
  const mail = mails.slice(before).find((m) => m.subject === 'Approve a Flock admin access key');
  assert.ok(mail, 'a pending mint sent no approval email');
  const token = /token=([A-Za-z0-9_-]{43})&do=approve/.exec(mail.text)[1];
  return { ...res.body, token, mail };
}

// The two links in an approval email, as a phone opens them: no session.
async function link(method, token, action) {
  const res = await fetch(`${base}/api/key-approval?token=${encodeURIComponent(token)}&do=${action}`, { method });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const keyRow = async (id) => (await pool.query('SELECT * FROM admin_access_keys WHERE id = $1', [id])).rows[0];

const usesOf = async (keyId) => (await pool.query(
  'SELECT method, route, status, refused, ip, used_at FROM admin_key_uses WHERE key_id = $1 ORDER BY id', [keyId]
)).rows;

// The status is written when the answer goes out, which can land a moment
// after the client has read it.
async function settled(keyId) {
  for (let i = 0; i < 100; i += 1) {
    const rows = await usesOf(keyId);
    if (rows.every((r) => r.status !== null)) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  return usesOf(keyId);
}

const isKeyRefusal = (res) => res.status === 403 && res.body && res.body.adminKeyRefused === true;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-admin-keys-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'adminAccessKeys', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);
  auth = require('../middleware/auth');
  keys = require('../middleware/adminKeys');
  const emailService = require('../services/emailService');
  emailService.sendEmail = async (msg) => { mails.push(msg); return mailAnswer(msg); };

  mounts = serverMounts();
  const app = express();
  app.use(express.json());
  app.set('io', fakeIo);
  for (const m of mounts) {
    const mod = require(path.join(BACKEND, 'routes', m.file));
    const router = m.prop ? mod[m.prop] : mod;
    m.router = router;
    if (m.prefix === '/api/admin') adminRouter = router;
    app.use(m.prefix, router);
  }
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  removeTempDir(dataDir, 'adminAccessKeys');
});

// ---------------------------------------------------------------------------
// 1. THE MIGRATION
// ---------------------------------------------------------------------------

test('135 is the one file with its number, and ASCII only for the replay suite', () => {
  const dir = path.join(BACKEND, 'migrations');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.sql') && f.startsWith('135_')), ['135_admin_access_keys.sql']);
  assert.ok(/^[\x00-\x7F]*$/.test(fs.readFileSync(MIGRATION, 'utf8')), 'the migration is ASCII only (the replay suite runs WIN1252)');
});

test('135 builds both tables with the columns the code reads', async () => {
  const cols = async (t) => (await pool.query(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [t]
  )).rows.map((r) => `${r.column_name} ${r.data_type} ${r.is_nullable === 'YES' ? 'null' : 'not null'}`);
  assert.deepStrictEqual(await cols('admin_access_keys'), [
    'id integer not null',
    'name text not null',
    'key_hash text not null',
    'scopes ARRAY not null',
    'created_by integer not null',
    'created_ip text null',
    'session_version integer not null',
    'created_at timestamp with time zone not null',
    'expires_at timestamp with time zone not null',
    'approved_at timestamp with time zone null',
    'approved_via text null',
    'approved_ip text null',
    'approval_hash text null',
    'approval_expires_at timestamp with time zone null',
    'approval_used_at timestamp with time zone null',
    'last_used_at timestamp with time zone null',
    'last_used_ip text null',
    'revoked_at timestamp with time zone null',
    'revoked_via text null',
  ]);
  assert.deepStrictEqual(await cols('admin_key_uses'), [
    'id bigint not null',
    'key_id integer not null',
    'used_at timestamp with time zone not null',
    'method text not null',
    'route text not null',
    'status smallint null',
    'ip text null',
    'refused text null',
  ]);
});

test('135 refuses a row the code would never write', async () => {
  const owner = await insertUser({ role: 'admin' });
  const hash = 'a'.repeat(64);
  const bad = [
    // Not a SHA-256 in hex: a key itself, upper case, short.
    [`INSERT INTO admin_access_keys (name, key_hash, created_by) VALUES ('x', $1, $2)`, [`flk_admin_${'A'.repeat(43)}`, owner.id]],
    [`INSERT INTO admin_access_keys (name, key_hash, created_by) VALUES ('x', $1, $2)`, ['A'.repeat(64), owner.id]],
    [`INSERT INTO admin_access_keys (name, key_hash, created_by) VALUES ('x', $1, $2)`, ['a'.repeat(63), owner.id]],
    // A scope the code does not know, and no scope at all.
    [`INSERT INTO admin_access_keys (name, key_hash, created_by, scopes) VALUES ('x', $1, $2, ARRAY['root'])`, [hash, owner.id]],
    [`INSERT INTO admin_access_keys (name, key_hash, created_by, scopes) VALUES ('x', $1, $2, ARRAY[]::text[])`, [hash, owner.id]],
    // Past the 180-day ceiling, and already expired at birth.
    [`INSERT INTO admin_access_keys (name, key_hash, created_by, expires_at) VALUES ('x', $1, $2, NOW() + INTERVAL '181 days')`, [hash, owner.id]],
    [`INSERT INTO admin_access_keys (name, key_hash, created_by, expires_at) VALUES ('x', $1, $2, NOW())`, [hash, owner.id]],
    // A revoke that does not say how, and a name too long.
    [`INSERT INTO admin_access_keys (name, key_hash, created_by, revoked_at) VALUES ('x', $1, $2, NOW())`, [hash, owner.id]],
    [`INSERT INTO admin_access_keys (name, key_hash, created_by) VALUES ($3, $1, $2)`, [hash, owner.id, 'x'.repeat(61)]],
    // An approval that does not say how, a way nobody approves by, an approval
    // token that is not a hash, a token with no deadline, and an emailed
    // approval with no token behind it.
    [`INSERT INTO admin_access_keys (name, key_hash, created_by, approved_at) VALUES ('x', $1, $2, NOW())`, [hash, owner.id]],
    [`INSERT INTO admin_access_keys (name, key_hash, created_by, approved_at, approved_via) VALUES ('x', $1, $2, NOW(), 'phone')`, [hash, owner.id]],
    [`INSERT INTO admin_access_keys (name, key_hash, created_by, approval_hash, approval_expires_at) VALUES ('x', $1, $2, 'token', NOW())`, [hash, owner.id]],
    [`INSERT INTO admin_access_keys (name, key_hash, created_by, approval_hash) VALUES ('x', $1, $2, $3)`, [hash, owner.id, 'b'.repeat(64)]],
    [`INSERT INTO admin_access_keys (name, key_hash, created_by, approved_at, approved_via) VALUES ('x', $1, $2, NOW(), 'email')`, [hash, owner.id]],
    [`INSERT INTO admin_access_keys (name, key_hash, created_by, revoked_at, revoked_via) VALUES ('x', $1, $2, NOW(), 'phone')`, [hash, owner.id]],
  ];
  for (const [sql, params] of bad) {
    await assert.rejects(pool.query(sql, params), /violates check constraint/, sql);
  }
  // The defaults: the one scope, ninety days, no use yet.
  const { rows: [row] } = await pool.query(
    `INSERT INTO admin_access_keys (name, key_hash, created_by) VALUES ('ok', $1, $2)
     RETURNING scopes, EXTRACT(EPOCH FROM (expires_at - created_at))::int AS life, last_used_at`, [hash, owner.id]
  );
  assert.deepStrictEqual(row.scopes, ['admin']);
  assert.strictEqual(row.life, 90 * 86400);
  assert.strictEqual(row.last_used_at, null);
  // One hash, one key.
  await assert.rejects(
    pool.query(`INSERT INTO admin_access_keys (name, key_hash, created_by) VALUES ('dup', $1, $2)`, [hash, owner.id]),
    /duplicate key value/
  );
  // The same approval token cannot stand behind two keys.
  await pool.query(
    `INSERT INTO admin_access_keys (name, key_hash, created_by, approval_hash, approval_expires_at)
     VALUES ('p1', $1, $2, $3, NOW() + INTERVAL '15 minutes')`, ['c'.repeat(64), owner.id, 'd'.repeat(64)]
  );
  await assert.rejects(pool.query(
    `INSERT INTO admin_access_keys (name, key_hash, created_by, approval_hash, approval_expires_at)
     VALUES ('p2', $1, $2, $3, NOW() + INTERVAL '15 minutes')`, ['e'.repeat(64), owner.id, 'd'.repeat(64)]
  ), /duplicate key value/);
  for (const refused of ['nope', 'not_admin']) {
    await assert.rejects(pool.query(
      `INSERT INTO admin_key_uses (key_id, method, route, refused)
       SELECT id, 'GET', '/api/admin/money', $1 FROM admin_access_keys WHERE key_hash = $2`, [refused, hash]
    ), /violates check constraint/);
  }
  await pool.query('DELETE FROM users WHERE id = $1', [owner.id]);
});

test('an account deleted takes its keys and their log with it', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mint(owner);
  assert.strictEqual((await call('GET', '/api/admin/whoami', { bearer: k.key })).status, 200);
  assert.ok((await usesOf(k.id)).length > 0);
  await pool.query('DELETE FROM users WHERE id = $1', [owner.id]);
  assert.strictEqual(Number((await pool.query('SELECT COUNT(*) AS n FROM admin_access_keys WHERE id = $1', [k.id])).rows[0].n), 0);
  assert.strictEqual((await usesOf(k.id)).length, 0);
  assert.strictEqual((await call('GET', '/api/admin/whoami', { bearer: k.key })).status, 401);
});

test('135 replays over a populated database and moves nothing', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mint(owner);
  await call('GET', '/api/admin/whoami', { bearer: k.key });
  const before = (await pool.query('SELECT * FROM admin_access_keys ORDER BY id')).rows;
  const usesBefore = (await pool.query('SELECT * FROM admin_key_uses ORDER BY id')).rows;
  await pool.query(fs.readFileSync(MIGRATION, 'utf8'));
  assert.deepStrictEqual((await pool.query('SELECT * FROM admin_access_keys ORDER BY id')).rows, before);
  assert.deepStrictEqual((await pool.query('SELECT * FROM admin_key_uses ORDER BY id')).rows, usesBefore);
});

// ---------------------------------------------------------------------------
// 2. MINTING
// ---------------------------------------------------------------------------

test('a fresh session mints a key: shown once, stored as its hash, 90 days by default', async () => {
  const owner = await insertUser({ role: 'admin' });
  const res = await call('POST', '/api/admin/keys', { bearer: session(owner, 30), body: { name: 'PC tools' } });
  assert.strictEqual(res.status, 201, res.text);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  const k = res.body;
  assert.match(k.key, /^flk_admin_[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(k.shownOnce, true);
  assert.strictEqual(k.name, 'PC tools');
  assert.deepStrictEqual(k.scopes, ['admin']);
  assert.strictEqual(k.state, 'active');
  assert.strictEqual(Date.parse(k.expiresAt) - Date.parse(k.createdAt), 90 * 86400 * 1000);

  const { rows: [row] } = await pool.query('SELECT * FROM admin_access_keys WHERE id = $1', [k.id]);
  assert.strictEqual(row.key_hash, keys.hashAdminKey(k.key));
  assert.strictEqual(row.created_by, owner.id);
  assert.strictEqual(row.session_version, owner.token_version);
  // The key itself is nowhere in the row, in any column.
  assert.ok(!JSON.stringify(row).includes(k.key.slice(10)), 'the key, or its random part, was stored');
});

test('days may be set from 1 to 180, and nothing else is accepted', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mint(owner, { name: 'long', days: 180 });
  assert.strictEqual(Date.parse(k.expiresAt) - Date.parse(k.createdAt), 180 * 86400 * 1000);
  for (const body of [{ name: 'x', days: 181 }, { name: 'x', days: 0 }, { name: 'x', days: '30' }, { days: 30 }, { name: '' }]) {
    const res = await call('POST', '/api/admin/keys', { bearer: session(owner), body });
    assert.strictEqual(res.status, 400, JSON.stringify(body));
  }
});

test('the fresh path is unchanged: a key minted within the window works at once and asks for no approval', async () => {
  const owner = await insertUser({ role: 'admin' });
  mails = [];
  const k = await mint(owner, { name: 'Fresh' });
  assert.strictEqual(k.pending, false);
  assert.strictEqual(k.state, 'active');
  assert.strictEqual(k.approvedVia, 'session');
  assert.strictEqual((await call('GET', '/api/admin/whoami', { bearer: k.key })).status, 200);
  const row = await keyRow(k.id);
  assert.strictEqual(row.approval_hash, null, 'a fresh key carries no approval token');
  assert.ok(row.approved_at instanceof Date);
  assert.deepStrictEqual(mails.map((m) => m.subject), ['A Flock admin access key was made'], 'a fresh mint asks for no approval, and says it was made');
  // The edge of the window is still fresh.
  const edge = await call('POST', '/api/admin/keys', { bearer: session(owner, keys.ADMIN_KEY_MINT_FRESH_SECONDS - 5), body: { name: 'Edge' } });
  assert.strictEqual(edge.status, 201, edge.text);
});

test('a session older than the window mints a pending key, shown once and marked pending, and emails the approval link', async () => {
  const owner = await insertUser({ role: 'admin', name: 'Owner Admin' });
  mails = [];
  const res = await call('POST', '/api/admin/keys', { bearer: session(owner, 3 * 86400), body: { name: 'From the phone', days: 30 } });
  assert.strictEqual(res.status, 202, res.text);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  const k = res.body;
  assert.match(k.key, /^flk_admin_[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(k.pending, true);
  assert.strictEqual(k.state, 'pending');
  assert.strictEqual(k.shownOnce, true);
  assert.strictEqual(k.approvedAt, null);
  assert.match(k.approval.sentTo, /^k\*{5}@example\.com$/, 'the answer says which mailbox to look in, masked');
  const window = Date.parse(k.approval.expiresAt) - Date.parse(k.createdAt);
  assert.strictEqual(window, keys.ADMIN_KEY_APPROVAL_MINUTES * 60000);
  assert.strictEqual(Date.parse(k.expiresAt) - Date.parse(k.createdAt), 30 * 86400 * 1000);
  // One email, to the account's own address, and the token in it is stored
  // only as its hash.
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, owner.email);
  const token = /token=([A-Za-z0-9_-]{43})&do=approve/.exec(mails[0].text)[1];
  const row = await keyRow(k.id);
  assert.strictEqual(row.approval_hash, keys.hashAdminKey(token));
  assert.ok(!JSON.stringify(row).includes(token), 'the approval token was stored');
  assert.strictEqual(row.key_hash, keys.hashAdminKey(k.key));
  assert.strictEqual(row.created_ip, '127.0.0.1');
});

test('a pending mint on an account no email can reach is refused, and makes nothing', async () => {
  const owner = await insertUser({ role: 'admin' });
  await pool.query("UPDATE users SET email = $2 WHERE id = $1", [owner.id, `gone${owner.id}@account.invalid`]);
  const fresh = await freshRow(owner.id);
  mails = [];
  const res = await call('POST', '/api/admin/keys', { bearer: session(fresh, 3600), body: { name: 'nowhere to send' } });
  assert.strictEqual(res.status, 403, res.text);
  assert.strictEqual(res.body.signInAgain, true);
  assert.deepStrictEqual(mails, []);
  assert.strictEqual(Number((await pool.query('SELECT COUNT(*) AS n FROM admin_access_keys WHERE created_by = $1', [owner.id])).rows[0].n), 0);
});

test('an approval email that does not go out undoes the mint: no key is handed out dead', async () => {
  const owner = await insertUser({ role: 'admin' });
  mailAnswer = () => ({ sent: false, error: 'provider down' });
  try {
    const res = await call('POST', '/api/admin/keys', { bearer: session(owner, 3600), body: { name: 'unsent' } });
    assert.strictEqual(res.status, 503, res.text);
    assert.ok(!res.text.includes('flk_admin_'), 'a key was handed out for a mint that was undone');
  } finally {
    mailAnswer = () => ({ sent: true, id: 'test-mail' });
  }
  assert.strictEqual(Number((await pool.query('SELECT COUNT(*) AS n FROM admin_access_keys WHERE created_by = $1', [owner.id])).rows[0].n), 0);
});

test('at most a few keys wait for approval at once, which bounds the approval emails an old session can send', async () => {
  const owner = await insertUser({ role: 'admin' });
  for (let i = 0; i < keys.ADMIN_KEY_PENDING_MAX; i += 1) await mintPending(owner, { name: `waiting ${i}` });
  mails = [];
  const over = await call('POST', '/api/admin/keys', { bearer: session(owner, 3600), body: { name: 'one more' } });
  assert.strictEqual(over.status, 409, over.text);
  assert.deepStrictEqual(mails, [], 'a refused mint sent an email');
  // A fresh session is not held back by them.
  assert.strictEqual((await call('POST', '/api/admin/keys', { bearer: session(owner), body: { name: 'fresh' } })).status, 201);
  // Once a waiting key's link runs out it no longer counts.
  await pool.query(
    "UPDATE admin_access_keys SET approval_expires_at = NOW() - INTERVAL '1 second' WHERE created_by = $1 AND approved_at IS NULL", [owner.id]
  );
  await mintPending(owner, { name: 'after they lapsed' });
});

test('a key cannot mint a key, and a signed-in account that is not an admin cannot either', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mint(owner);
  const byKey = await call('POST', '/api/admin/keys', { bearer: k.key, body: { name: 'child' } });
  assert.ok(isKeyRefusal(byKey), byKey.text);
  const member = await insertUser();
  const byMember = await call('POST', '/api/admin/keys', { bearer: session(member), body: { name: 'mine' } });
  assert.strictEqual(byMember.status, 403);
  assert.strictEqual(byMember.body.error, 'Admin access required');
  assert.strictEqual(Number((await pool.query('SELECT COUNT(*) AS n FROM admin_access_keys WHERE created_by = ANY($1)', [[owner.id, member.id]])).rows[0].n), 1);
});

test('one account holds at most the ceiling of live keys at once', async () => {
  const owner = await insertUser({ role: 'admin' });
  const made = [];
  for (let i = 0; i < keys.ADMIN_KEY_ACTIVE_MAX; i += 1) made.push(await mint(owner, { name: `k${i}` }));
  const over = await call('POST', '/api/admin/keys', { bearer: session(owner), body: { name: 'one more' } });
  assert.strictEqual(over.status, 409);
  // A revoked key no longer counts.
  assert.strictEqual((await call('DELETE', `/api/admin/keys/${made[0].id}`, { bearer: session(owner) })).status, 200);
  await mint(owner, { name: 'replacement' });
});

// ---------------------------------------------------------------------------
// 3. A KEY AT WORK
// ---------------------------------------------------------------------------

test('a key acts as the admin who minted it, and every use is logged with its status', async () => {
  const owner = await insertUser({ role: 'admin', name: 'Owner Admin' });
  const k = await mint(owner);
  const who = await call('GET', '/api/admin/whoami', { bearer: k.key });
  assert.strictEqual(who.status, 200, who.text);
  assert.strictEqual(who.body.authVia, 'admin_key');
  assert.deepStrictEqual(who.body.user, { id: owner.id, name: 'Owner Admin', role: 'admin' });
  assert.strictEqual(who.body.key.id, k.id);
  assert.strictEqual(who.body.key.expiresAt, k.expiresAt);
  assert.ok(who.body.key.daysLeft === 89 || who.body.key.daysLeft === 90, String(who.body.key.daysLeft));
  assert.ok(!who.text.includes(k.key), 'the key came back in an answer');

  const expenses = await call('GET', '/api/admin/expenses', { bearer: k.key });
  assert.strictEqual(expenses.status, 200, expenses.text);
  const uses = await settled(k.id);
  assert.deepStrictEqual(uses.map((u) => [u.method, u.route, u.status, u.refused]), [
    ['GET', '/api/admin/whoami', 200, null],
    ['GET', '/api/admin/expenses', 200, null],
  ]);
  assert.ok(uses.every((u) => u.ip && u.used_at instanceof Date));
  const { rows: [row] } = await pool.query('SELECT last_used_at, last_used_ip FROM admin_access_keys WHERE id = $1', [k.id]);
  assert.ok(row.last_used_at instanceof Date && Date.now() - row.last_used_at.getTime() < 60000);
  assert.ok(row.last_used_ip);
});

test('a write through a key is a write as its admin, and the query string never reaches the log', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mint(owner);
  const add = await call('POST', '/api/admin/expenses?note=secret-ish', {
    bearer: k.key,
    body: { vendor: 'Example Host', kind: 'infrastructure', cadence: 'monthly', amount: '12.00', product: `key test ${k.id}` },
  });
  assert.strictEqual(add.status, 201, add.text);
  const { rows: [bill] } = await pool.query('SELECT updated_by FROM business_expenses WHERE id = $1', [add.body.expense.id]);
  assert.strictEqual(bill.updated_by, owner.id);
  const uses = await settled(k.id);
  assert.deepStrictEqual(uses.map((u) => [u.method, u.route, u.status]), [['POST', '/api/admin/expenses', 201]]);
  await pool.query('DELETE FROM business_expenses WHERE id = $1', [add.body.expense.id]);
});

test('a use that cannot be logged does not happen: the route never runs', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mint(owner);
  await pool.query('ALTER TABLE admin_key_uses ADD CONSTRAINT admin_key_uses_test_block CHECK (key_id < 0) NOT VALID');
  try {
    const res = await call('POST', '/api/admin/expenses', {
      bearer: k.key,
      body: { vendor: 'Never Written', kind: 'other', cadence: 'monthly', amount: '1.00' },
    });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.body.error, keys.KEY_WORDS.unlogged);
  } finally {
    await pool.query('ALTER TABLE admin_key_uses DROP CONSTRAINT admin_key_uses_test_block');
  }
  assert.strictEqual(Number((await pool.query("SELECT COUNT(*) AS n FROM business_expenses WHERE vendor = 'Never Written'")).rows[0].n), 0);
  const { rows: [row] } = await pool.query('SELECT last_used_at FROM admin_access_keys WHERE id = $1', [k.id]);
  assert.strictEqual(row.last_used_at, null, 'the key was marked used by a use that never happened');
});

test('a key nobody minted is refused and writes no row; a well-formed key with one character changed is a different key', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mint(owner);
  const flipped = k.key.slice(0, -1) + (k.key.endsWith('A') ? 'B' : 'A');
  const before = Number((await pool.query('SELECT COUNT(*) AS n FROM admin_key_uses')).rows[0].n);
  for (const bearer of [flipped, keys.generateAdminKey(), 'flk_admin_tooshort']) {
    const res = await call('GET', '/api/admin/money', { bearer });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.error, keys.KEY_WORDS.invalid);
  }
  assert.strictEqual(Number((await pool.query('SELECT COUNT(*) AS n FROM admin_key_uses')).rows[0].n), before);
});

// ---------------------------------------------------------------------------
// 4. WHAT ENDS A KEY
// ---------------------------------------------------------------------------

async function endedBy(change, expectError) {
  const owner = await insertUser({ role: 'admin' });
  const k = await mint(owner);
  assert.strictEqual((await call('GET', '/api/admin/whoami', { bearer: k.key })).status, 200);
  await change(owner, k);
  for (const p of ['/api/admin/whoami', '/api/users/me']) {
    const res = await call('GET', p, { bearer: k.key });
    assert.strictEqual(res.status, 401, `${p}: ${res.text}`);
    assert.strictEqual(res.body.error, expectError);
  }
  const uses = await settled(k.id);
  return { uses, owner, k };
}

test('an expired key is refused, and the refusal is logged', async () => {
  const { uses } = await endedBy(async (owner, k) => {
    await pool.query(
      "UPDATE admin_access_keys SET created_at = NOW() - INTERVAL '100 days', expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [k.id]
    );
  }, keys.KEY_WORDS.expired);
  assert.deepStrictEqual(uses.slice(1).map((u) => [u.route, u.status, u.refused]), [
    ['/api/admin/whoami', 401, 'expired'],
    ['/api/users/me', 401, 'expired'],
  ]);
});

test('a revoked key is refused at once', async () => {
  const { uses } = await endedBy(async (owner, k) => {
    assert.strictEqual((await call('DELETE', `/api/admin/keys/${k.id}`, { bearer: session(owner) })).status, 200);
  }, keys.KEY_WORDS.revoked);
  assert.deepStrictEqual(uses.slice(1).map((u) => u.refused), ['revoked', 'revoked']);
});

test('sign out everywhere, a password change or a reset ends every key minted before it', async () => {
  const { uses } = await endedBy(async (owner) => {
    await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [owner.id]);
  }, keys.KEY_WORDS.ended);
  assert.deepStrictEqual(uses.slice(1).map((u) => u.refused), ['ended', 'ended']);
});

test('a key stops the moment its account is no longer an admin, or is banned', async () => {
  await endedBy(async (owner) => {
    await pool.query("UPDATE users SET role = 'user' WHERE id = $1", [owner.id]);
  }, keys.KEY_WORDS.ended);
  await endedBy(async (owner) => {
    await pool.query('UPDATE users SET is_banned = true, banned_at = NOW() WHERE id = $1', [owner.id]);
  }, keys.KEY_WORDS.ended);
});

test('a revoke that lands between the lookup and the use wins: the route never runs', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mint(owner);
  const realQuery = pool.query.bind(pool);
  let raced = false;
  pool.query = async (sql, params) => {
    const out = await realQuery(sql, params);
    if (!raced && /FROM admin_access_keys k\s+JOIN users u/.test(String(sql))) {
      raced = true;
      await realQuery("UPDATE admin_access_keys SET revoked_at = NOW(), revoked_via = 'session' WHERE id = $1", [k.id]);
    }
    return out;
  };
  try {
    const res = await call('POST', '/api/admin/expenses', {
      bearer: k.key, body: { vendor: 'Raced Bill', kind: 'other', cadence: 'monthly', amount: '1.00' },
    });
    assert.strictEqual(res.status, 401, res.text);
  } finally {
    pool.query = realQuery;
  }
  assert.ok(raced);
  assert.strictEqual(Number((await pool.query("SELECT COUNT(*) AS n FROM business_expenses WHERE vendor = 'Raced Bill'")).rows[0].n), 0);
  assert.strictEqual((await usesOf(k.id)).length, 0);
});

test('a dead key replayed all hour writes at most the hourly ceiling of refusals', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mint(owner);
  assert.strictEqual((await call('DELETE', `/api/admin/keys/${k.id}`, { bearer: session(owner) })).status, 200);
  // The hour's ceiling, less one, already logged.
  await pool.query(
    `INSERT INTO admin_key_uses (key_id, method, route, status, refused)
     SELECT $1::int, 'GET', '/api/admin/whoami', 401, 'revoked' FROM generate_series(1, $2::int)`,
    [k.id, keys.ADMIN_KEY_REFUSALS_LOGGED_PER_HOUR - 1]
  );
  for (let i = 0; i < 3; i += 1) assert.strictEqual((await call('GET', '/api/admin/whoami', { bearer: k.key })).status, 401);
  const n = Number((await pool.query('SELECT COUNT(*) AS n FROM admin_key_uses WHERE key_id = $1', [k.id])).rows[0].n);
  assert.strictEqual(n, keys.ADMIN_KEY_REFUSALS_LOGGED_PER_HOUR, 'the log kept growing past the ceiling');
  // An hour on, refusals are written again.
  await pool.query("UPDATE admin_key_uses SET used_at = used_at - INTERVAL '61 minutes' WHERE key_id = $1", [k.id]);
  assert.strictEqual((await call('GET', '/api/admin/whoami', { bearer: k.key })).status, 401);
  assert.strictEqual(Number((await pool.query('SELECT COUNT(*) AS n FROM admin_key_uses WHERE key_id = $1', [k.id])).rows[0].n), n + 1);
});

test('a key minted after sign out everywhere works: only keys from before it end', async () => {
  const owner = await insertUser({ role: 'admin' });
  const old = await mint(owner);
  await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [owner.id]);
  const now = await mint(await freshRow(owner.id));
  assert.strictEqual((await call('GET', '/api/admin/whoami', { bearer: old.key })).status, 401);
  assert.strictEqual((await call('GET', '/api/admin/whoami', { bearer: now.key })).status, 200);
});

// ---------------------------------------------------------------------------
// 5. THE ROUTE LIST, AGAINST EVERY ROUTER
// ---------------------------------------------------------------------------

const AUTH_FNS = () => new Set([auth.authenticate, auth.authenticateAllowBanned, auth.authenticateAllowExpired]);

// Every route a router serves, with whether an authenticate variant runs
// before it: router-wide (router.use) or in the route's own chain.
function routesOf(router) {
  const fns = AUTH_FNS();
  const out = [];
  let guarded = false;
  for (const layer of router.stack) {
    if (!layer.route) {
      if (fns.has(layer.handle)) guarded = true;
      continue;
    }
    const inRoute = layer.route.stack.some((l) => fns.has(l.handle));
    for (const method of Object.keys(layer.route.methods)) {
      if (method === '_all') continue;
      out.push({ method: method.toUpperCase(), path: layer.route.path, guarded: guarded || inRoute });
    }
  }
  return out;
}

const concrete = (p) => p.replace(/:(\w+)(\([^)]*\))?\??/g, '1').replace(/\*/g, 'x');

test('server.js was read: the mounts are the real ones, in order, with the catch-alls before the admin router', () => {
  assert.ok(mounts.length >= 35, `only ${mounts.length} router mounts were read out of server.js`);
  const at = (prefix, file) => mounts.findIndex((m) => m.prefix === prefix && m.file === file);
  assert.ok(at('/api', 'moderation') >= 0 && at('/api', 'messages') >= 0, 'the two catch-alls were not found');
  assert.ok(at('/api', 'messages') < at('/api/admin', 'admin'), 'the admin router is no longer behind the catch-alls');
  assert.ok(adminRouter, 'the admin router was not mounted');
});

test('every admin route has a decision for keys, and both lists name only routes that exist', () => {
  const live = routesOf(adminRouter).map((r) => `${r.method} /api/admin${r.path}`);
  const allowed = keys.ADMIN_KEY_ROUTES.map((r) => `${r.method} ${r.path}`);
  const refused = keys.ADMIN_KEY_REFUSED_ROUTES.map((r) => `${r.method} ${r.path}`);
  const undecided = live.filter((r) => !allowed.includes(r) && !refused.includes(r));
  assert.deepStrictEqual(undecided, [],
    'an admin route has no decision for access keys. Add it to ADMIN_KEY_ROUTES in middleware/adminKeys.js if a key '
    + 'may use it, or to ADMIN_KEY_REFUSED_ROUTES with the reason it may not. Until then it refuses every key.');
  assert.deepStrictEqual([...allowed, ...refused].filter((r) => !live.includes(r)), [], 'a list names a route the admin router does not have');
  assert.deepStrictEqual(live.filter((r) => allowed.includes(r) && refused.includes(r)), []);
});

test('a live key reaches nothing outside the admin routes: every authenticated route answers it 403', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mint(owner);
  const before = Number((await pool.query('SELECT COUNT(*) AS n FROM admin_key_uses WHERE key_id = $1', [k.id])).rows[0].n);
  let refused = 0;
  const answeredFirst = [];
  for (const m of mounts) {
    if (m.prefix === '/api/admin') continue;
    for (const r of routesOf(m.router)) {
      if (!r.guarded || typeof r.path !== 'string') continue;
      const url = m.prefix + concrete(r.path);
      const withKey = await call(r.method, url, { bearer: k.key, body: r.method === 'GET' ? undefined : {} });
      if (isKeyRefusal(withKey)) {
        refused += 1;
        assert.strictEqual(withKey.body.error, keys.KEY_WORDS.offAdmin, `${r.method} ${url}`);
        continue;
      }
      // Answered before any authenticate ran (an earlier public route on the
      // same path, or a check in front of the middleware). Then a key must do
      // exactly what no credential at all does.
      const bare = await call(r.method, url, { body: r.method === 'GET' ? undefined : {} });
      assert.notStrictEqual(bare.status, 401, `${r.method} ${url}: no credential is refused there, so the key (${withKey.status}) got past an authenticate`);
      assert.strictEqual(withKey.status, bare.status, `${r.method} ${url}: a key answered ${withKey.status} where no credential answers ${bare.status}`);
      answeredFirst.push(`${r.method} ${url}`);
    }
  }
  assert.ok(refused >= 150, `only ${refused} authenticated routes were swept; the router walk is wrong`);
  assert.ok(answeredFirst.length < 20, `${answeredFirst.length} routes answered before authentication: ${answeredFirst.join(', ')}`);
  // Every refusal is on the key's log, as a route refusal.
  const uses = await settled(k.id);
  assert.strictEqual(uses.length - before, refused);
  assert.ok(uses.slice(before).every((u) => u.status === 403 && u.refused === 'route'));
});

test('the account security and account deletion doors answer a key 403', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mint(owner);
  for (const [method, p, body] of [
    ['PUT', '/api/users/password', { current_password: 'x', new_password: 'y'.repeat(12) }],
    ['PUT', '/api/users/profile', { email: 'new@example.com' }],
    ['POST', '/api/auth/logout-all', {}],
    ['POST', '/api/auth/logout', {}],
    ['DELETE', '/api/users/me', {}],
    ['GET', '/api/users/me', undefined],
    ['GET', '/api/users/export', undefined],
    ['GET', '/api/auth/me', undefined],
  ]) {
    const res = await call(method, p, { bearer: k.key, body });
    assert.ok(isKeyRefusal(res), `${method} ${p}: ${res.status} ${res.text}`);
  }
  assert.ok(await freshRow(owner.id), 'the account went');
  assert.strictEqual((await freshRow(owner.id)).token_version, owner.token_version, 'a key moved the account\'s sessions');
});

test('every admin route a key may never reach answers it 403, and every listed one lets it through', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mint(owner);
  for (const r of keys.ADMIN_KEY_REFUSED_ROUTES) {
    const url = concrete(r.path);
    const res = await call(r.method, url, { bearer: k.key, body: r.method === 'GET' ? undefined : {} });
    assert.ok(isKeyRefusal(res), `${r.method} ${url}: ${res.status} ${res.text}`);
    assert.strictEqual(res.body.error, keys.KEY_WORDS.route);
  }
  for (const r of keys.ADMIN_KEY_ROUTES) {
    // Revoking is tested on its own below; here it would revoke this key.
    if (r.self) continue;
    const url = concrete(r.path);
    const body = r.path === '/api/admin/waitlist/announce' ? { dry_run: true } : (r.method === 'GET' ? undefined : {});
    const res = await call(r.method, url, { bearer: k.key, body });
    assert.ok(!isKeyRefusal(res) && res.status !== 401, `${r.method} ${url} refused a listed key: ${res.status} ${res.text}`);
    assert.ok(res.status < 500, `${r.method} ${url}: ${res.status} ${res.text}`);
  }
  const uses = await settled(k.id);
  assert.strictEqual(uses.filter((u) => u.refused === 'route').length, keys.ADMIN_KEY_REFUSED_ROUTES.length);
  assert.strictEqual(uses.filter((u) => u.refused === null).length, keys.ADMIN_KEY_ROUTES.length - 1);
});

test('the waitlist dry run answers a key, and a send without the dry-run flag is the same route', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mint(owner);
  const dry = await call('POST', '/api/admin/waitlist/announce', { bearer: k.key, body: { dry_run: true } });
  assert.strictEqual(dry.status, 200, dry.text);
  assert.strictEqual(dry.body.dry_run, true);
  assert.ok(Number.isInteger(dry.body.pending));
});

// fetch resolves dot segments before it sends anything, so the paths a script
// could send raw go out through http.request, exactly as written.
function rawCall(method, rawPath, bearer) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = http.request({
      host: url.hostname, port: url.port, method, path: rawPath, headers: { Authorization: `Bearer ${bearer}` },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('an odd spelling of an admin path is judged as Express routes it, or refused', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mint(owner);
  // Express routes without regard to case or one trailing slash, and so does
  // the list. A doubled slash straight after the mount is folded by Express's
  // own mount match, so the router sees /whoami and so does the list.
  assert.strictEqual((await call('GET', '/api/admin/WHOAMI', { bearer: k.key })).status, 200);
  assert.strictEqual((await call('GET', '/api/admin/whoami/', { bearer: k.key })).status, 200);
  assert.strictEqual((await rawCall('GET', '/api/admin//whoami', k.key)).status, 200);
  // Anything else that is not a plain path is refused before a route runs,
  // where Express on its own would not have found a route either.
  for (const p of ['/api/admin/%77hoami', '/api/admin/keys/../whoami', '/api/admin/./whoami', '/api/admin/whoami%2F', '/api/admin/whoami//']) {
    const res = await rawCall('GET', p, k.key);
    assert.ok(isKeyRefusal(res), `${p}: ${res.status} ${res.text}`);
  }
  assert.ok(isKeyRefusal(await call('GET', '/api/admin/nothing-here', { bearer: k.key })), 'an unknown admin path let a key through');
});

// ---------------------------------------------------------------------------
// 5b. PENDING KEYS AND THE APPROVAL LINK
// ---------------------------------------------------------------------------

const isPendingRefusal = (res) => res.status === 403 && res.body && res.body.adminKeyPending === true
  && /awaiting approval/.test(res.body.error);

test('a pending key authenticates nothing: every authenticated route and every admin route answers 403 awaiting approval', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mintPending(owner);
  let refused = 0;
  for (const m of mounts) {
    for (const r of routesOf(m.router)) {
      if (!r.guarded || typeof r.path !== 'string') continue;
      const url = m.prefix + concrete(r.path);
      const res = await call(r.method, url, { bearer: k.key, body: r.method === 'GET' ? undefined : {} });
      assert.ok(isPendingRefusal(res), `${r.method} ${url} answered a pending key ${res.status} ${res.text}`);
      refused += 1;
    }
  }
  assert.ok(refused >= 200, `only ${refused} routes were tried`);
  // Not a single use reached a route: the key was never marked used.
  const row = await keyRow(k.id);
  assert.strictEqual(row.last_used_at, null);
  assert.strictEqual(row.approved_at, null);
  const uses = await settled(k.id);
  assert.ok(uses.length > 0 && uses.every((u) => u.refused === 'pending' && u.status === 403));
});

test('opening a link draws a page and changes nothing: a mail scanner that fetches both links approves and revokes nothing', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mintPending(owner, { name: 'Scanned' });
  for (const action of ['approve', 'deny', 'approve', 'deny']) {
    const page = await link('GET', k.token, action);
    assert.strictEqual(page.status, 200, page.text);
    assert.match(page.text, /<form method="post"/);
    assert.match(page.text, /Scanned/);
    assert.match(page.text, action === 'approve' ? /Approve the key/ : /Revoke the key/);
    assert.strictEqual(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(page.headers.get('content-security-policy'), /form-action 'self'/);
    assert.ok(!page.text.includes(owner.email), 'the page echoed the address');
  }
  const row = await keyRow(k.id);
  assert.deepStrictEqual([row.approved_at, row.revoked_at, row.approval_used_at], [null, null, null]);
  assert.ok(isPendingRefusal(await call('GET', '/api/admin/whoami', { bearer: k.key })));
});

test('the Approve button approves once: the key works, and the same link never works again', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mintPending(owner, { name: 'Approved' });
  mails = [];
  const done = await link('POST', k.token, 'approve');
  assert.strictEqual(done.status, 200, done.text);
  assert.match(done.text, /The key is approved/);
  const who = await call('GET', '/api/admin/whoami', { bearer: k.key });
  assert.strictEqual(who.status, 200, who.text);
  assert.strictEqual(who.body.key.id, k.id);
  const row = await keyRow(k.id);
  assert.strictEqual(row.approved_via, 'email');
  assert.strictEqual(row.approved_ip, '127.0.0.1');
  assert.ok(row.approval_used_at instanceof Date);
  assert.deepStrictEqual(mails.map((m) => m.subject), ['Flock admin access key approved']);
  // Used: a second tap, and either link opened again, refuse and change nothing.
  for (const [method, action] of [['POST', 'approve'], ['POST', 'deny'], ['GET', 'approve'], ['GET', 'deny']]) {
    const again = await link(method, k.token, action);
    assert.ok(again.status === 409 || again.status === 410, `${method} ${action}: ${again.status}`);
    assert.match(again.text, /already approved/);
  }
  assert.strictEqual((await keyRow(k.id)).revoked_at, null, 'the deny link revoked a key after the link was spent');
  assert.strictEqual((await call('GET', '/api/admin/whoami', { bearer: k.key })).status, 200);
});

test('"This wasn\'t me" revokes the pending key for good, and says so by email', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mintPending(owner, { name: 'Not mine' });
  mails = [];
  const done = await link('POST', k.token, 'deny');
  assert.strictEqual(done.status, 200, done.text);
  assert.match(done.text, /The key is revoked/);
  const row = await keyRow(k.id);
  assert.strictEqual(row.revoked_via, 'email');
  assert.strictEqual(row.approved_at, null);
  const who = await call('GET', '/api/admin/whoami', { bearer: k.key });
  assert.strictEqual(who.status, 401);
  assert.strictEqual(who.body.error, keys.KEY_WORDS.revoked);
  assert.deepStrictEqual(mails.map((m) => m.subject), ['Flock admin access key revoked']);
  assert.match(mails[0].text, /revoked from the "This wasn't me" link in its email/);
  // And the Approve link cannot bring it back.
  const late = await link('POST', k.token, 'approve');
  assert.strictEqual(late.status, 409);
  assert.strictEqual((await keyRow(k.id)).approved_at, null);
});

test('an expired approval link is refused, and its key can never work', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mintPending(owner, { name: 'Too late' });
  await pool.query("UPDATE admin_access_keys SET approval_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [k.id]);
  const page = await link('GET', k.token, 'approve');
  assert.strictEqual(page.status, 410);
  assert.match(page.text, /This link has expired/);
  assert.ok(!/<form/.test(page.text), 'an expired link drew a button');
  const post = await link('POST', k.token, 'approve');
  assert.strictEqual(post.status, 409);
  assert.strictEqual((await keyRow(k.id)).approved_at, null);
  const who = await call('GET', '/api/admin/whoami', { bearer: k.key });
  assert.strictEqual(who.status, 401);
  assert.strictEqual(who.body.error, keys.KEY_WORDS.unapproved);
  // The list says so too.
  const list = await call('GET', '/api/admin/keys', { bearer: session(owner) });
  assert.strictEqual(list.body.keys.find((x) => x.id === k.id).state, 'expired');
});

test('a key revoked while it waited cannot be approved', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mintPending(owner, { name: 'Revoked first' });
  const revoke = await call('DELETE', `/api/admin/keys/${k.id}`, { bearer: session(owner) });
  assert.strictEqual(revoke.status, 200, revoke.text);
  const page = await link('GET', k.token, 'approve');
  assert.strictEqual(page.status, 410);
  assert.match(page.text, /This key is revoked/);
  const post = await link('POST', k.token, 'approve');
  assert.strictEqual(post.status, 409);
  assert.match(post.text, /This key is revoked/);
  const row = await keyRow(k.id);
  assert.strictEqual(row.approved_at, null);
  assert.strictEqual(row.revoked_via, 'session');
  assert.strictEqual((await call('GET', '/api/admin/whoami', { bearer: k.key })).status, 401);
});

test('a key whose account signed out everywhere while it waited cannot be approved', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mintPending(owner, { name: 'Outlived' });
  await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [owner.id]);
  const page = await link('GET', k.token, 'approve');
  assert.strictEqual(page.status, 410);
  assert.match(page.text, /can no longer be approved/);
  assert.strictEqual((await link('POST', k.token, 'approve')).status, 409);
  assert.strictEqual((await keyRow(k.id)).approved_at, null);
});

test('a link that is not one Flock sent is refused without touching any key', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mintPending(owner);
  const flipped = k.token.slice(0, -1) + (k.token.endsWith('A') ? 'B' : 'A');
  for (const [token, action] of [[flipped, 'approve'], ['short', 'approve'], [k.token, 'approve-all'], [k.token, ''], [`${k.token}A`, 'deny']]) {
    for (const method of ['GET', 'POST']) {
      const res = await link(method, token, action);
      assert.ok(res.status === 400 || res.status === 404, `${method} ${action}: ${res.status}`);
      assert.match(res.text, /This link does not work/);
    }
  }
  const row = await keyRow(k.id);
  assert.deepStrictEqual([row.approved_at, row.revoked_at], [null, null]);
});

test('the page\'s button gets past server.js\'s own cors: the self-posting exemption covers the approval page', async () => {
  // server.js's allowlist and cors mount, lifted from the source as
  // emailSuppressionAndUnsubscribe.test.js does for the unsubscribe page, in
  // front of the real approval router.
  const src = fs.readFileSync(path.join(BACKEND, 'server.js'), 'utf8');
  const start = src.indexOf('const allowedOrigins = [');
  const mountAt = src.indexOf('app.use(cors(', start);
  const tail = /\)\);\r?\n/.exec(src.slice(mountAt));
  assert.ok(start > 0 && mountAt > start && tail, 'the cors block in server.js has moved; retarget this lift');
  const app = express();
  // eslint-disable-next-line no-new-func
  new Function('app', 'cors', 'process', 'console', src.slice(start, mountAt + tail.index + 3))(
    app, require('cors'), { env: {} }, { log() {}, warn() {}, error() {} }
  );
  app.use('/api/key-approval', require('../routes/keyApproval'));
  app.use((err, _req, res, _next) => res.status(err && err.type === 'cors.origin.refused' ? 403 : 500).json({ error: 'Not allowed by CORS' }));
  const lifted = await new Promise((resolve) => { const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const owner = await insertUser({ role: 'admin' });
    const k = await mintPending(owner, { name: 'Through cors' });
    const port = lifted.address().port;
    const post = (origin) => new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, method: 'POST', path: `/api/key-approval?token=${k.token}&do=approve`,
        headers: { Origin: origin, Host: 'api.flockcorp.com', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': 0 },
      }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual((await post('https://evil.example')).status, 403, 'a foreign site posted the approval');
    assert.strictEqual((await keyRow(k.id)).approved_at, null);
    const ok = await post('null');
    assert.strictEqual(ok.status, 200, ok.text);
    assert.ok((await keyRow(k.id)).approved_at instanceof Date);
  } finally {
    await new Promise((r) => lifted.close(r));
  }
});

// ---------------------------------------------------------------------------
// 5c. THE EMAILS, WORD FOR WORD WHERE IT MATTERS
// ---------------------------------------------------------------------------

test('the approval email names the key, its expiry, where and when it was asked for, and carries both links', async () => {
  const owner = await insertUser({ role: 'admin', name: 'Owner Admin' });
  const k = await mintPending(owner, { name: 'Laptop tools', days: 60 });
  const m = k.mail;
  const mailKit = require('../services/adminKeyMail');
  assert.strictEqual(m.to, owner.email);
  assert.strictEqual(m.subject, 'Approve a Flock admin access key');
  const approve = `https://api.flockcorp.com/api/key-approval?token=${k.token}&do=approve`;
  const deny = `https://api.flockcorp.com/api/key-approval?token=${k.token}&do=deny`;
  assert.strictEqual(m.text, [
    'Approve a Flock admin access key',
    '',
    'Hi Owner Admin, an admin access key was asked for on your Flock account.',
    '',
    'Name: Laptop tools',
    `Asked for: ${mailKit.when(k.createdAt)} from 127.0.0.1`,
    `Works until: ${mailKit.day(k.expiresAt)}, if approved`,
    '',
    'Approve it here. The link works once and expires in 15 minutes:',
    approve,
    '',
    'If you did not ask for this, revoke it here:',
    deny,
    '',
    'The key does nothing until it is approved. If it was not you, someone is signed in as you: revoke the key, then change your password, which signs out every session.',
    '',
    'The Flock Team',
  ].join('\n'));
  assert.ok(m.html.includes(`href="${approve.replace(/&/g, '&amp;')}"`), 'the Approve button is not the approve link');
  assert.ok(m.html.includes(`href="${deny.replace(/&/g, '&amp;')}"`), 'the "This wasn\'t me" button is not the deny link');
  assert.match(m.html, />Approve the key</);
  assert.match(m.html, />This wasn&#39;t me</);
  assert.ok(!m.text.includes('flk_admin_') && !m.html.includes('flk_admin_'), 'the email carried the key');
  assert.match(mailKit.when(k.createdAt), /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M E[SD]T$/);
});

test('every key event is emailed: a fresh mint, an approval, and each way of revoking', async () => {
  const owner = await insertUser({ role: 'admin', name: 'Owner Admin' });
  const mailKit = require('../services/adminKeyMail');
  mails = [];
  const fresh = await mint(owner, { name: 'Fresh one' });
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].subject, 'A Flock admin access key was made');
  assert.strictEqual(mails[0].text, [
    'A Flock admin access key was made',
    '',
    'Hi Owner Admin, an admin access key was made on your Flock account from a session that had just signed in, so it works now.',
    '',
    'Name: Fresh one',
    `Made: ${mailKit.when(fresh.createdAt)} from 127.0.0.1`,
    `Works until: ${mailKit.day(fresh.expiresAt)}`,
    '',
    'If this was you, there is nothing to do. If it was not you, someone is signed in as you: revoke the key, then change your password, which signs out every session. Keys are revoked on the Admin dashboard under Access keys.',
    '',
    'The Flock Team',
  ].join('\n'));

  const pend = await mintPending(owner, { name: 'Phone one' });
  mails = [];
  await link('POST', pend.token, 'approve');
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].subject, 'Flock admin access key approved');
  assert.match(mails[0].text, /^A Flock admin access key was approved\n\nHi Owner Admin, the admin access key "Phone one" was approved from the link in its email, so it works now\.\n\nApproved: .+ from 127\.0\.0\.1\nWorks until: .+\n\nIf you did not approve it, revoke it on the Admin dashboard under Access keys, then change your password, which signs out every session\.\n\nThe Flock Team$/);

  mails = [];
  await call('DELETE', `/api/admin/keys/${fresh.id}`, { bearer: session(owner) });
  await call('DELETE', `/api/admin/keys/${pend.id}`, { bearer: pend.key });
  assert.deepStrictEqual(mails.map((m) => m.subject), ['Flock admin access key revoked', 'Flock admin access key revoked']);
  assert.match(mails[0].text, /the admin access key "Fresh one" was revoked from the Admin dashboard\. It no longer works\./);
  assert.match(mails[1].text, /the admin access key "Phone one" was revoked by the key itself\. It no longer works\./);
  assert.ok(mails.every((m) => m.to === owner.email));
  // A second revoke is no event, and sends nothing.
  mails = [];
  await call('DELETE', `/api/admin/keys/${fresh.id}`, { bearer: session(owner) });
  assert.deepStrictEqual(mails, []);
});

// ---------------------------------------------------------------------------
// 6. LISTING AND REVOKING
// ---------------------------------------------------------------------------

test('the list is metadata and recent uses, for a session only, and never the key or its hash', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mint(owner, { name: 'Listed' });
  for (let i = 0; i < keys.ADMIN_KEY_RECENT_USES + 2; i += 1) await call('GET', '/api/admin/whoami', { bearer: k.key });
  await settled(k.id);
  const res = await call('GET', '/api/admin/keys', { bearer: session(owner, 3 * 86400) });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  const mine = res.body.keys.find((x) => x.id === k.id);
  assert.ok(mine);
  assert.strictEqual(mine.name, 'Listed');
  assert.strictEqual(mine.state, 'active');
  assert.ok(mine.lastUsedAt && mine.lastUsedIp);
  assert.strictEqual(mine.recentUses.length, keys.ADMIN_KEY_RECENT_USES);
  assert.ok(mine.recentUses.every((u) => u.method === 'GET' && u.route === '/api/admin/whoami'));
  const times = mine.recentUses.map((u) => Date.parse(u.at));
  assert.deepStrictEqual(times, [...times].sort((a, b) => b - a), 'newest first');
  const { rows: [row] } = await pool.query('SELECT key_hash FROM admin_access_keys WHERE id = $1', [k.id]);
  assert.ok(!res.text.includes(row.key_hash) && !res.text.includes(k.key.slice(10)));
  assert.ok(!/key_hash|keyHash/.test(res.text));

  const byKey = await call('GET', '/api/admin/keys', { bearer: k.key });
  assert.ok(isKeyRefusal(byKey), byKey.text);
});

test('a key revokes itself and is dead on its next use; it cannot revoke another key', async () => {
  const owner = await insertUser({ role: 'admin' });
  const a = await mint(owner, { name: 'a' });
  const b = await mint(owner, { name: 'b' });
  const other = await call('DELETE', `/api/admin/keys/${b.id}`, { bearer: a.key });
  assert.ok(isKeyRefusal(other), other.text);
  assert.strictEqual(other.body.error, keys.KEY_WORDS.notSelf);
  assert.strictEqual((await call('GET', '/api/admin/whoami', { bearer: b.key })).status, 200, 'b was revoked by a');

  const self = await call('DELETE', `/api/admin/keys/${a.id}`, { bearer: a.key });
  assert.strictEqual(self.status, 200, self.text);
  assert.strictEqual(self.body.revoked, true);
  assert.strictEqual(self.body.key.revokedVia, 'key');
  assert.strictEqual((await call('GET', '/api/admin/whoami', { bearer: a.key })).status, 401);
  const uses = await settled(a.id);
  assert.deepStrictEqual(uses.map((u) => [u.method, u.route, u.status, u.refused]), [
    ['DELETE', `/api/admin/keys/${b.id}`, 403, 'route'],
    ['DELETE', `/api/admin/keys/${a.id}`, 200, null],
    ['GET', '/api/admin/whoami', 401, 'revoked'],
  ]);
});

test('a session revokes any key, a second revoke says so, and an unknown id is 404', async () => {
  const owner = await insertUser({ role: 'admin' });
  const k = await mint(owner);
  const s = session(owner, 7 * 86400);
  const first = await call('DELETE', `/api/admin/keys/${k.id}`, { bearer: s });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.alreadyRevoked, false);
  assert.strictEqual(first.body.key.revokedVia, 'session');
  assert.strictEqual(first.body.key.state, 'revoked');
  const again = await call('DELETE', `/api/admin/keys/${k.id}`, { bearer: s });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.body.alreadyRevoked, true);
  assert.strictEqual((await call('DELETE', '/api/admin/keys/2147483647', { bearer: s })).status, 404);
  assert.strictEqual((await call('DELETE', '/api/admin/keys/99999999999', { bearer: s })).status, 404);
});

// ---------------------------------------------------------------------------
// 7. THE ADMIN TOOL AGAINST THE REAL ROUTES
// ---------------------------------------------------------------------------

test('tools/flock-admin/admin.mjs does its work through the real routes with a real key', async () => {
  const { pathToFileURL } = require('node:url');
  const cli = await import(pathToFileURL(path.join(BACKEND, '..', 'tools', 'flock-admin', 'admin.mjs')).href);
  const owner = await insertUser({ role: 'admin', name: 'Tool Owner' });
  const k = await mint(owner, { name: 'CLI test' });
  const keyFile = path.join(dataDir, '..', `flock-admin-key-${process.pid}`);
  cli.writeKeyFile(keyFile, k.key, { replace: true });
  const tool = async (args) => {
    let out = '';
    const code = await cli.main(args, {
      env: { FLOCK_API_URL: base, FLOCK_ADMIN_KEY_FILE: keyFile },
      stdout: (s) => { out += s; },
      stderr: (s) => { out += s; },
      stdin: null,
    });
    assert.ok(!out.includes(k.key.slice(10)), 'the tool printed the key');
    return { code, out };
  };
  try {
    const status = await tool(['status']);
    assert.strictEqual(status.code, 0, status.out);
    assert.match(status.out, /Admin key "CLI test" \(key \d+\), acting as Tool Owner/);

    const product = `cli ${k.id}`;
    const add = await tool(['expenses', 'add', '--vendor', 'Example Host', '--product', product, '--amount', '9.99',
      '--kind', 'tooling', '--cadence', 'monthly', '--renews', '2026-12-01', '--yes']);
    assert.strictEqual(add.code, 0, add.out);
    const { rows: [bill] } = await pool.query('SELECT id, active, amount_cents, updated_by FROM business_expenses WHERE product = $1', [product]);
    assert.deepStrictEqual([bill.active, bill.amount_cents, bill.updated_by], [true, 999, owner.id]);

    const list = await tool(['expenses', 'list']);
    assert.match(list.out, new RegExp(`${bill.id}\\s+Example Host, ${product}\\s+\\$9\\.99 a month\\s+running`));

    // The row the list read goes back whole, so the real validators accept it.
    const stop = await tool(['expenses', 'stop', String(bill.id), '--yes']);
    assert.strictEqual(stop.code, 0, stop.out);
    assert.strictEqual((await pool.query('SELECT active FROM business_expenses WHERE id = $1', [bill.id])).rows[0].active, false);

    const dry = await tool(['waitlist', 'announce', '--dry-run']);
    assert.strictEqual(dry.code, 0, dry.out);
    assert.match(dry.out, /waiting for the launch email/);

    const money = await tool(['money']);
    assert.strictEqual(money.code, 0, money.out);
    assert.match(money.out, /Money in/);
    assert.match(money.out, /Monthly bills/);

    const refusedGet = await tool(['get', '/api/admin/keys']);
    assert.strictEqual(refusedGet.code, 1, 'a key listed keys through the tool');
    assert.match(refusedGet.out, /Refused \(403\)/);

    const uses = await settled(k.id);
    assert.ok(uses.length >= 8);
    assert.ok(uses.every((u) => u.route.startsWith('/api/admin/')));
    await pool.query('DELETE FROM business_expenses WHERE id = $1', [bill.id]);
  } finally {
    fs.rmSync(keyFile, { force: true });
  }
});

test('no key ever reached a log line', () => {
  const leaks = printed.filter((line) => /flk_admin_[A-Za-z0-9_-]{20,}/.test(line));
  assert.deepStrictEqual(leaks, []);
});
