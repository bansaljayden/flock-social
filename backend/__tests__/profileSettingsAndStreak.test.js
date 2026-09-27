'use strict';
// Run: node --test __tests__/profileSettingsAndStreak.test.js  (from backend/)
//
// ---------------------------------------------------------------------------
// SYNCED SETTINGS, ON A REAL POSTGRES
// ---------------------------------------------------------------------------
// PATCH /api/users/settings used to read the stored blob, merge the partial
// into it in JavaScript and write the whole merged object back. Every device
// sends only the keys it changed, so two saves that overlapped (Crowd alerts
// turned off on the phone while a web tab flushed a flock reorder) both read
// the same old blob, and the second write put the first one's key back. The
// pre-peak crowd push reads crowdAlerts from that row, so the lost save was an
// opt-out the server went on ignoring.
//
// The merge is now the upsert's own `settings || EXCLUDED.settings`, which
// Postgres evaluates against the row as it stands once the statement holds its
// lock. A scripted pool cannot show that, so this file runs the real route
// against a migrated embedded Postgres, holds one save open between its first
// statement and its answer while a second save runs to completion, and reads
// back what was stored.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');

// Synchronous and before config/database is required anywhere: that module
// builds its Pool from DATABASE_URL at require time, and backend/.env points at
// the live database.
const PG_PORT = pickEmbeddedPgPort('profileSettingsAndStreak');
const DB_NAME = 'flock_profile_settings_streak';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-profile-settings-and-streak';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.RESEND_API_KEY;

let pg;
let pool;
let dataDir;
let server;
let base;
let signUserToken;
let seq = 0;

// A hold on the next statement that touches user_settings: it runs, and its
// answer is kept from the route until release() (or a timeout, so a version of
// the route that took a row lock and waited could not wedge the file).
let gate = null;
function holdNextSettingsStatement() {
  let reached;
  let release;
  const g = {
    taken: false,
    reached: new Promise((r) => { reached = r; }),
    released: new Promise((r) => { release = r; }),
  };
  g.arrive = reached;
  g.release = release;
  gate = g;
  return g;
}

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-profile-settings-streak-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'profileSettingsAndStreak', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);

  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  const query = pool.query;
  pool.query = async function heldQuery(...args) {
    const out = await query.apply(this, args);
    const g = gate;
    if (g && !g.taken && typeof args[0] === 'string' && /user_settings/.test(args[0])) {
      g.taken = true;
      g.arrive();
      await Promise.race([g.released, new Promise((r) => setTimeout(r, 2000))]);
    }
    return out;
  };

  ({ signUserToken } = require('../middleware/auth'));

  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/users', require('../routes/users'));
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  gate = null;
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  try {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (err) {
    console.warn('[profileSettingsAndStreak] could not remove %s: %s', dataDir, err.message);
  }
});

async function call(method, url, { token, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

async function mkUser(name) {
  seq += 1;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified)
     VALUES ($1, 'x', $2, true) RETURNING *`,
    [`u${seq}-${Date.now()}@profile-settings.test`, name]
  );
  return { ...rows[0], token: signUserToken(rows[0]) };
}

const stored = async (user) => {
  const r = await call('GET', '/api/users/settings', { token: user.token });
  assert.equal(r.status, 200, r.text);
  return r.body.settings;
};
const save = (user, body) => call('PATCH', '/api/users/settings', { token: user.token, body });

// ── Settings ─────────────────────────────────────────────────────────────────

test('a save that overlaps another save keeps both changes', async () => {
  const dana = await mkUser('Dana');
  assert.equal((await save(dana, { crowdAlerts: 'true', theme: 'dark' })).status, 200);

  // The phone turns Crowd alerts off. Its save is held just after its first
  // statement on user_settings has answered.
  const hold = holdNextSettingsStatement();
  const phone = save(dana, { crowdAlerts: 'false' });
  await hold.reached;

  // Meanwhile the web tab flushes a flock reorder, start to finish.
  const web = await save(dana, { flockOrder: [3, 1, 2] });
  hold.release();
  const phoneRes = await phone;
  gate = null;

  assert.equal(web.status, 200, web.text);
  assert.equal(phoneRes.status, 200, phoneRes.text);
  assert.deepEqual(await stored(dana), { crowdAlerts: 'false', theme: 'dark', flockOrder: [3, 1, 2] },
    'one of two overlapping saves was lost; the crowd-alerts opt-out must survive a save of another key');
});

test('a burst of saves, one key each, keeps every key', async () => {
  const eli = await mkUser('Eli');
  const keys = Array.from({ length: 12 }, (_, i) => `k${i}`);
  const answers = await Promise.all(keys.map((k, i) => save(eli, { [k]: i })));
  assert.deepEqual(answers.map((a) => a.status), keys.map(() => 200));
  const settings = await stored(eli);
  for (const [i, k] of keys.entries()) assert.equal(settings[k], i, `key ${k} was lost to an overlapping save`);
});

test('the first save creates the row, and a later save merges into it', async () => {
  const fay = await mkUser('Fay');
  assert.deepEqual(await stored(fay), {});
  const first = await save(fay, { pinnedFlockIds: [7] });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(first.body.settings, { pinnedFlockIds: [7] });
  const second = await save(fay, { pinnedFlockIds: [7, 9], crowdAlerts: 'false' });
  assert.deepEqual(second.body.settings, { pinnedFlockIds: [7, 9], crowdAlerts: 'false' },
    'a key sent again replaces its value; an array is not concatenated');
});

test('a save that would push the merged blob past the cap is refused and changes nothing', async () => {
  const gus = await mkUser('Gus');
  const big = 'x'.repeat(7000);
  assert.equal((await save(gus, { a: big })).status, 200);
  assert.equal((await save(gus, { b: big })).status, 200);

  const over = await save(gus, { c: 'y'.repeat(3000) });
  assert.equal(over.status, 400, over.text);
  assert.equal(over.body.error, 'Settings storage limit reached');
  assert.deepEqual(Object.keys(await stored(gus)).sort(), ['a', 'b'], 'a refused save wrote its key anyway');

  // Shrinking a key near the cap is still allowed.
  const smaller = await save(gus, { a: 'short' });
  assert.equal(smaller.status, 200, smaller.text);
  assert.equal((await stored(gus)).a, 'short');

  // The payload cap still answers first.
  const huge = await save(gus, { d: 'z'.repeat(9000) });
  assert.equal(huge.status, 400);
  assert.equal(huge.body.error, 'Settings payload too large');
});
