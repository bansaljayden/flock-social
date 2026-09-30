// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// "SHARE USAGE ANALYTICS": THE ACCOUNT'S OWN SWITCH, ON THE SERVER.
// ---------------------------------------------------------------------------
// The app asks no analytics question on screen. Signed-in product analytics is
// part of the service agreed to at signup, and Settings has a switch that
// turns it off. The answer lives in users.analytics_opt_out (migration 111) so
// that it survives a sign-out, a reinstall and a sign-in on another device;
// the device-local answer is swept at every sign-out. The app reads it through
// GET /api/users/me/analytics before it sends anything, and writes it through
// PUT with { optOut: boolean }.
//
// What is pinned here:
//   1. Both halves need a session, and read or write the caller's own row
//      only, by a parameterised statement.
//   2. A fresh account reads optOut false, which is the default agreed to at
//      signup; the answer is what the row holds, round trip.
//   3. The PUT takes a JSON boolean and nothing else. The strings 'true' and
//      'false', numbers, null, arrays, objects and a missing field are each a
//      400 with nothing written.
//   4. The migration adds the column the way the runner expects, and the data
//      export carries it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'test-secret-for-analytics-opt-out';
delete process.env.FIREBASE_SERVICE_ACCOUNT; // push stays a no-op

const pool = require('../config/database');
const { signUserToken } = require('../middleware/auth');

const ROOT = path.join(__dirname, '..');

const ME = {
  id: 7, email: 'ren@example.com', name: 'Ren', role: 'user',
  profile_image_url: null, email_verified: true, is_banned: false, token_version: 0,
};

const AUTH_SQL = /^SELECT id, email, name, role,.*FROM users WHERE id = \$1$/i;

// The fake users table: one column per account, as migration 111 adds it.
let optOutById;  // Map<number, boolean>
let queries;     // every statement after the auth lookup
let writes;      // every INSERT/UPDATE/DELETE

function dispatch(text, params) {
  const sql = String(text).replace(/\s+/g, ' ').trim();
  if (AUTH_SQL.test(sql)) {
    const id = Number(params[0]);
    return Promise.resolve(id === ME.id ? { rows: [ME], rowCount: 1 } : { rows: [], rowCount: 0 });
  }
  queries.push({ sql, params: params || [] });
  if (/^(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push({ sql, params: params || [] });

  if (sql === 'SELECT analytics_opt_out FROM users WHERE id = $1') {
    const id = Number(params[0]);
    if (!optOutById.has(id)) return Promise.resolve({ rows: [], rowCount: 0 });
    return Promise.resolve({ rows: [{ analytics_opt_out: optOutById.get(id) }], rowCount: 1 });
  }
  if (sql === 'UPDATE users SET analytics_opt_out = $2::boolean, updated_at = NOW() WHERE id = $1 RETURNING analytics_opt_out') {
    const id = Number(params[0]);
    if (!optOutById.has(id)) return Promise.resolve({ rows: [], rowCount: 0 });
    // What Postgres does with the ::boolean cast: a JS boolean goes in as-is.
    assert.strictEqual(typeof params[1], 'boolean', 'the stored value is a boolean, never a string');
    optOutById.set(id, params[1]);
    return Promise.resolve({ rows: [{ analytics_opt_out: params[1] }], rowCount: 1 });
  }
  return Promise.resolve({ rows: [], rowCount: 0 });
}
pool.query = (text, params) => dispatch(text, params);
pool.connect = async () => ({ query: (t, p) => dispatch(t, p), release: () => {} });

const usersRouter = require('../routes/users');
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/users', usersRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((r) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise((r) => server.close(() => r())));

test.beforeEach(() => {
  queries = [];
  writes = [];
  // Account 7 is the caller. Account 8 exists and has opted out, so a write
  // that reached the wrong row would show up as 8 changing.
  optOutById = new Map([[7, false], [8, true]]);
});

async function call(method, body, { token = signUserToken(ME), raw } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/api/users/me/analytics`, {
    method,
    headers,
    ...(raw !== undefined ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------------
// 1. A session, and the caller's own row
// ---------------------------------------------------------------------------

test('neither half answers without a session, and nothing is read or written', async () => {
  for (const method of ['GET', 'PUT']) {
    const res = await call(method, method === 'PUT' ? { optOut: true } : undefined, { token: null });
    assert.strictEqual(res.status, 401, `${method} without a token`);
  }
  assert.deepStrictEqual(queries, []);
  assert.deepStrictEqual(writes, []);
});

test('the read and the write name the caller by id and nothing else', async () => {
  await call('GET');
  await call('PUT', { optOut: true, userId: 8, id: 8 });
  assert.deepStrictEqual(queries.map((q) => q.params), [[7], [7, true]]);
  // A body that names another account changes nothing about which row moves.
  assert.strictEqual(optOutById.get(7), true);
  assert.strictEqual(optOutById.get(8), true);
  for (const { sql } of queries) {
    assert.doesNotMatch(sql, /'\d+'|= 7\b/, 'the id is a parameter, never spliced into the text');
  }
});

// ---------------------------------------------------------------------------
// 2. The answer, round trip
// ---------------------------------------------------------------------------

test('a fresh account reads analytics on, which is the default agreed to at signup', async () => {
  const res = await call('GET');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { optOut: false });
});

test('switching off and on again is what the next read says', async () => {
  let res = await call('PUT', { optOut: true });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { optOut: true });
  assert.deepStrictEqual((await call('GET')).body, { optOut: true });

  res = await call('PUT', { optOut: false });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { optOut: false });
  assert.deepStrictEqual((await call('GET')).body, { optOut: false });
  assert.strictEqual(writes.length, 2);
});

test('the answer is the row\'s, not the request\'s', async () => {
  // The response is read back from RETURNING, so a switch can never show a
  // value the database did not keep.
  optOutById.set(7, false);
  const res = await call('PUT', { optOut: true });
  assert.deepStrictEqual(res.body, { optOut: optOutById.get(7) });
});

// ---------------------------------------------------------------------------
// 3. A JSON boolean and nothing else
// ---------------------------------------------------------------------------

test('anything that is not a JSON true or false is refused before any write', async () => {
  const refused = [
    { optOut: 'true' },
    { optOut: 'false' },
    { optOut: 1 },
    { optOut: 0 },
    { optOut: null },
    { optOut: [true] },
    { optOut: { value: true } },
    { optOut: 'yes' },
    {},
  ];
  for (const body of refused) {
    const res = await call('PUT', body);
    assert.strictEqual(res.status, 400, `${JSON.stringify(body)} was accepted`);
    assert.ok(res.body && typeof res.body.error === 'string' && res.body.error.length > 0);
  }
  assert.deepStrictEqual(writes, []);
  assert.strictEqual(optOutById.get(7), false);
});

test('an account the database no longer has is a 404, not a 500', async () => {
  optOutById.delete(7);
  assert.strictEqual((await call('GET')).status, 404);
  assert.strictEqual((await call('PUT', { optOut: true })).status, 404);
});

// ---------------------------------------------------------------------------
// 4. The migration and the export
// ---------------------------------------------------------------------------

test('migration 111 adds the column the way the runner and the replay suite expect', () => {
  const file = path.join(ROOT, 'migrations', '111_users_analytics_opt_out.sql');
  const sql = fs.readFileSync(file, 'utf8');
  assert.match(sql, /ALTER TABLE users ADD COLUMN IF NOT EXISTS analytics_opt_out BOOLEAN NOT NULL DEFAULT FALSE;/);
  assert.match(sql, /^-- @requires column users\.analytics_opt_out$/m);
  // The boot-safety suite runs an embedded server whose encoding is WIN1252.
  assert.ok(/^[\x00-\x7F]*$/.test(sql), 'the migration is ASCII only');
  // Numbered after every file that is already there, so it runs last.
  const numbers = fs.readdirSync(path.join(ROOT, 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => Number(f.slice(0, 3)));
  assert.strictEqual(numbers.filter((n) => n === 111).length, 1, 'one file numbered 111');
});

test('the data export selects the column and publishes it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'users.js'), 'utf8');
  const exportSelect = src.match(/router\.get\('\/export'[\s\S]*?`(SELECT id, email, name[\s\S]*?FROM users WHERE id = \$1)`/);
  assert.ok(exportSelect, "could not find the export's SELECT in routes/users.js");
  assert.match(exportSelect[1], /\banalytics_opt_out\b/);
  assert.match(src, /analytics_opt_out: account\.analytics_opt_out \?\? false,/);
});
