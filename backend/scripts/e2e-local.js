/* Local end-to-end harness — proves the compliance backend actually RUNS, not
 * just parses. Boots a throwaway embedded Postgres, applies the real migrations
 * by booting server.js, then exercises the endpoints over HTTP + checks rows.
 *
 * Run: node scripts/e2e-local.js   (no Docker, no admin, no prod DB)
 */
const path = require('path');
const os = require('os');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;

const PORT = 5099;
// 127.0.0.1 not "localhost" — Node's fetch (undici) can fail localhost on the
// IPv6/IPv4 split even when the server is listening.
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  -> ' + JSON.stringify(extra) : '')); }
}

async function req(method, p, { token, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

(async () => {
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(os.tmpdir(), 'flock-e2e-pg-' + Date.now()),
    user: 'postgres', password: 'postgres', port: 59595, persistent: false,
  });

  console.log('Starting embedded Postgres (first run downloads binaries)...');
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('flock_e2e');

  // MUST be set before requiring server.js (dotenv won't override pre-set vars).
  process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:59595/flock_e2e';
  process.env.NODE_ENV = 'development';
  process.env.PORT = String(PORT);
  process.env.JWT_SECRET = 'e2e-test-secret';

  // Apply the base schema first — runMigrations() only ADDS feature columns/tables
  // and assumes the core tables exist. A fresh DB (local/staging) needs schema.sql;
  // prod already has it. (This is the real fresh-DB bootstrap order.)
  const fs = require('fs');
  const { Client } = require('pg');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
  const sc = new Client({ connectionString: process.env.DATABASE_URL });
  await sc.connect();
  await sc.query(schemaSql);
  await sc.end();
  console.log('Base schema applied.');

  console.log('Booting backend (runs migrations)...');
  require('../server.js');
  const pool = require('../config/database');

  // Readiness probe: /api/health is shadowed by the authenticated /api catch-all
  // (returns 401), so probe an unauthenticated auth route instead — a 400 on an
  // empty login body means Express + the auth router are up.
  let healthErr = '';
  const up = await waitFor(async () => {
    try {
      const res = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return res.status === 400;
    } catch (e) { healthErr = e.message + (e.cause ? ' / cause: ' + e.cause.message : ''); return false; }
  }, 30000);
  check('server boots + responds', up, healthErr);
  if (!up) { await pg.stop(); process.exit(1); }
  await new Promise(r => setTimeout(r, 2000)); // let migrations finish

  // migrations applied? the new moderation tables exist
  const tbl = await pool.query("SELECT to_regclass('public.content_reports') a, to_regclass('public.user_blocks') b, to_regclass('public.moderation_actions') c");
  check('migrations applied (moderation tables exist)', !!(tbl.rows[0].a && tbl.rows[0].b && tbl.rows[0].c), tbl.rows[0]);

  // --- Age gate (server-side) ---
  let r = await req('POST', '/api/auth/signup', { body: { name: 'Kid', email: 'kid@e2e.test', password: 'Passw0rd', date_of_birth: '2015-01-01' } });
  check('under-13 signup rejected (403)', r.status === 403, r);

  r = await req('POST', '/api/auth/signup', { body: { name: 'Alice', email: 'alice@e2e.test', password: 'Passw0rd', date_of_birth: '2000-01-01' } });
  check('valid signup (201 + token)', r.status === 201 && !!r.data?.token, r);
  const tokenA = r.data?.token, idA = r.data?.user?.id;

  r = await req('POST', '/api/auth/signup', { body: { name: 'Bob', email: 'bob@e2e.test', password: 'Passw0rd', date_of_birth: '1999-01-01' } });
  const tokenB = r.data?.token, idB = r.data?.user?.id;
  check('second signup ok', r.status === 201, r);

  // DOB persisted on the row
  const dobRow = await pool.query('SELECT date_of_birth FROM users WHERE id = $1', [idA]);
  check('date_of_birth persisted on user row', !!dobRow.rows[0]?.date_of_birth, dobRow.rows[0]);

  // --- Content filter ---
  r = await req('POST', '/api/flocks', { token: tokenA, body: { name: 'Test Flock' } });
  const flockId = r.data?.flock?.id ?? r.data?.id ?? r.data?.flock_id;
  check('create flock', r.status === 201 && !!flockId, r);

  r = await req('POST', `/api/flocks/${flockId}/messages`, { token: tokenA, body: { message_text: 'you piece of shit' } });
  check('profane flock message blocked (400)', r.status === 400, r);

  r = await req('POST', `/api/flocks/${flockId}/messages`, { token: tokenA, body: { message_text: 'lets meet at 8pm' } });
  const msgId = r.data?.message?.id;
  check('clean flock message accepted (201)', r.status === 201 && !!msgId, r);

  // --- Report ---
  r = await req('POST', '/api/reports', { token: tokenB, body: { content_type: 'flock_message', content_id: msgId, reported_user_id: idA, reason: 'harassment' } });
  check('report accepted (201)', r.status === 201, r);
  const repCount = await pool.query('SELECT COUNT(*)::int n FROM content_reports');
  check('report row written', repCount.rows[0].n >= 1, repCount.rows[0]);

  // --- Mutual block ---
  r = await req('POST', `/api/blocks/${idB}`, { token: tokenA });
  check('Alice blocks Bob (201)', r.status === 201, r);
  r = await req('POST', `/api/dm/${idA}`, { token: tokenB, body: { message_text: 'hi' } });
  check('blocked user DM rejected (403)', r.status === 403, r);

  // --- Admin queue (make Alice admin to read it) ---
  await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [idA]);
  r = await req('GET', '/api/admin/reports', { token: tokenA });
  check('admin can list reports', r.status === 200 && Array.isArray(r.data?.reports), r);

  // --- Account deletion + cascade ---
  r = await req('DELETE', '/api/users/me', { token: tokenB });
  check('account deletion (200)', r.status === 200, r);
  r = await req('GET', '/api/auth/me', { token: tokenB });
  check('token invalid after deletion', r.status === 401 || r.status === 404, r);
  const bobMsgs = await pool.query('SELECT COUNT(*)::int n FROM direct_messages WHERE sender_id = $1', [idB]);
  check('deleted user content cascade-cleared', bobMsgs.rows[0].n === 0, bobMsgs.rows[0]);

  console.log(`\nE2E: ${passed} passed, ${failed} failed`);
  await pg.stop();
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('E2E harness error:', e);
  process.exit(1);
});
