// Run: node --test  (from backend/)
//
// A DECLINED REQUEST, CANCELLED, ON A REAL DATABASE (backend audit 2026-10-03).
//
// A decline is never shown to the person declined: their request keeps
// reading as pending. But cancelling it used to answer differently from
// cancelling one still pending. A pending one left Sent requests; a declined
// one stayed there, which told the requester exactly which requests had been
// declined. Migration 113 adds 'withdrawn': the declined row after its
// requester cancels it. To them it is no request at all, as a cancelled
// pending one is; to the person who declined it is still the decline; and it
// keeps the one-revive-a-day cooldown the decline record exists to carry.
//
// Walked here through the real friends router on an embedded Postgres, so the
// migration's CHECK constraint and every statement are the real ones.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');

const PG_PORT = pickEmbeddedPgPort('friendWithdrawnRealDb');
const DB_NAME = 'flock_friend_withdrawn_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-friend-withdrawn';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.RESEND_API_KEY;

let pg;
let pool;
let dataDir;
let server;
let base;
let signUserToken;
let seq = 0;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-friend-withdrawn-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'friendWithdrawnRealDb', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);
  ({ signUserToken } = require('../middleware/auth'));
  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/friends', require('../routes/friends'));
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function user(name) {
  seq += 1;
  const { rows: [u] } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified) VALUES ($1, 'x', $2, true) RETURNING *`,
    [`friend${seq}.${Date.now()}@example.com`, name]
  );
  return { ...u, token: signUserToken(u) };
}

async function call(method, p, who, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

const rowOf = async (a, b) => (await pool.query(
  'SELECT status, created_at FROM friendships WHERE requester_id = $1 AND addressee_id = $2', [a.id, b.id]
)).rows[0];
const sent = async (who) => (await call('GET', '/api/friends/outgoing', who)).body.requests.map((r) => r.id);

test('the widened CHECK holds withdrawn and still refuses anything else', async () => {
  const a = await user('Ada');
  const b = await user('Bo');
  await pool.query("INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'withdrawn')", [a.id, b.id]);
  await assert.rejects(
    pool.query("INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($2, $1, 'ghosted')", [a.id, b.id]),
    (err) => err.code === '23514'
  );
});

test('cancelling a declined request reads, to its requester, exactly like cancelling a pending one', async () => {
  const ada = await user('Ada');
  const bo = await user('Bo');
  const cy = await user('Cy');
  // Ada asked both. Bo declined; Cy has not answered.
  await pool.query("INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'declined')", [ada.id, bo.id]);
  await pool.query("INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'pending')", [ada.id, cy.id]);
  assert.deepStrictEqual((await sent(ada)).sort(), [bo.id, cy.id].sort(), 'both read as sent before the cancels');

  const cancelBo = await call('DELETE', `/api/friends/${bo.id}`, ada);
  const cancelCy = await call('DELETE', `/api/friends/${cy.id}`, ada);
  assert.deepStrictEqual([cancelBo.status, cancelBo.body], [cancelCy.status, cancelCy.body]);
  assert.deepStrictEqual(await sent(ada), [], 'a cancelled request stays on Sent requests, which is the decline showing');

  for (const other of [bo, cy]) {
    // eslint-disable-next-line no-await-in-loop
    const st = await call('GET', `/api/friends/status/${other.id}`, ada);
    // The whole body, not just its status: a requester_id beside 'none' was
    // the decline showing through (review 2026-10-03).
    assert.deepStrictEqual(st.body, { status: 'none' }, `status toward ${other.name}`);
    // eslint-disable-next-line no-await-in-loop
    const again = await call('DELETE', `/api/friends/${other.id}`, ada);
    assert.strictEqual(again.status, 404, `a second cancel toward ${other.name}`);
  }

  // The record of the decline is kept, for the cooldown, and Bo still sees it.
  assert.strictEqual((await rowOf(ada, bo)).status, 'withdrawn');
  assert.strictEqual((await call('GET', `/api/friends/status/${ada.id}`, bo)).body.status, 'declined');
});

test('asking again inside the cooldown reads as sent, and nothing reaches the person who declined', async () => {
  const ada = await user('Ada');
  const bo = await user('Bo');
  await pool.query("INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'declined')", [ada.id, bo.id]);
  await call('DELETE', `/api/friends/${bo.id}`, ada);

  const again = await call('POST', '/api/friends/request', ada, { user_id: bo.id });
  assert.strictEqual(again.status, 200, again.text);
  assert.strictEqual(again.body.status, 'pending');
  assert.strictEqual((await rowOf(ada, bo)).status, 'declined', 'back to the masked decline, not a live request');
  assert.deepStrictEqual(await sent(ada), [bo.id]);
  const incoming = await call('GET', '/api/friends/pending', bo);
  assert.ok(!(incoming.body.requests || []).some((r) => Number(r.id) === ada.id), 'a request inside the cooldown reached Bo');
});

test('after the cooldown a withdrawn request revives like a declined one', async () => {
  const ada = await user('Ada');
  const bo = await user('Bo');
  await pool.query(
    "INSERT INTO friendships (requester_id, addressee_id, status, created_at) VALUES ($1, $2, 'withdrawn', NOW() - INTERVAL '3 days')",
    [ada.id, bo.id]
  );
  const res = await call('POST', '/api/friends/request', ada, { user_id: bo.id });
  assert.strictEqual(res.body.status, 'pending');
  assert.strictEqual((await rowOf(ada, bo)).status, 'pending');
});

test('a block keeps a withdrawn record, as it keeps a declined one', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'moderation.js'), 'utf8');
  assert.match(source, /AND status NOT IN \('declined', 'withdrawn'\)/);
});
