// Run: node --test  (from backend/)
//
// THE REVIEW ACCOUNT CAN SEE THE BUDGET WORK (2026-10-03).
//
// Budget matching is a headline of the listing, and no group figure is
// published until every accepted member has answered and at least three have
// shared an amount. The seeded demo flock had two members, so a reviewer could
// never see one. The seed now adds a third member, and two amounts are already
// in; the reviewer's own answer publishes the ceiling.
//
// The real seed script is run as a child process against an embedded Postgres
// (its production guard sees a local host), then the real budget router is
// called as the reviewer.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const express = require('express');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const { pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres } = require('./helpers/embeddedPgPort');

const PG_PORT = pickEmbeddedPgPort('reviewSeedBudgetRealDb');
const DB_NAME = 'flock_review_seed_budget_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-review-seed-budget';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.RESEND_API_KEY;

let pg;
let pool;
let dataDir;
let server;
let base;
let signUserToken;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-review-seed-budget-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, { suite: 'reviewSeedBudgetRealDb', port: PG_PORT, databaseDir: dataDir });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);
  ({ signUserToken } = require('../middleware/auth'));
  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/budget', require('../routes/budget'));
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

async function call(method, url, token, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* empty body */ }
  return { status: res.status, body: json };
}

test('the seeded reviewer answers the budget and the group ceiling appears', async () => {
  // The child inherits the embedded DATABASE_URL; dotenv never overrides a set
  // variable, so backend/.env cannot point it anywhere else.
  execFileSync(process.execPath, ['scripts/seed-review-account.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, SEED_REVIEW_CONFIRM: '' },
    stdio: 'pipe',
  });

  const { rows: [reviewer] } = await pool.query(`SELECT * FROM users WHERE email = 'review@flockcorp.com'`);
  const { rows: [flock] } = await pool.query(`SELECT id FROM flocks WHERE creator_id = $1 AND name = 'Friday Night Out'`, [reviewer.id]);
  const members = (await pool.query(`SELECT COUNT(*)::int AS n FROM flock_members WHERE flock_id = $1 AND status = 'accepted'`, [flock.id])).rows[0].n;
  assert.strictEqual(members, 3);
  const token = signUserToken(reviewer);

  const before = await call('GET', `/api/budget/${flock.id}`, token);
  assert.strictEqual(before.status, 200, JSON.stringify(before.body));
  assert.ok(before.body.ceiling == null, `a ceiling showed before the reviewer answered: ${JSON.stringify(before.body)}`);

  const submit = await call('POST', `/api/budget/${flock.id}/submit`, token, { amount: 50 });
  assert.ok([200, 201].includes(submit.status), JSON.stringify(submit.body));

  const after = await call('GET', `/api/budget/${flock.id}`, token);
  assert.strictEqual(after.status, 200, JSON.stringify(after.body));
  assert.ok(after.body.ceiling != null, `no ceiling after the third amount: ${JSON.stringify(after.body)}`);
  // Nobody's number is ever in the response, only the group figure.
  assert.ok(!JSON.stringify(after.body).includes('"amount":60'), JSON.stringify(after.body));
});

test('re-running the seed leaves one demo flock with the same three members', async () => {
  execFileSync(process.execPath, ['scripts/seed-review-account.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, SEED_REVIEW_CONFIRM: '' },
    stdio: 'pipe',
  });
  const { rows } = await pool.query(
    `SELECT f.id, COUNT(m.*)::int AS n FROM flocks f JOIN flock_members m ON m.flock_id = f.id
      WHERE f.name = 'Friday Night Out' GROUP BY f.id`
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].n, 3);
});
