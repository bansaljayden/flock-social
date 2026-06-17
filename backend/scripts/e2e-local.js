/* Local end-to-end harness — proves the compliance backend actually RUNS, not
 * just parses. Boots a throwaway embedded Postgres, applies the real migrations
 * by booting server.js, then exercises the endpoints over HTTP + checks rows.
 *
 * Adversarial scenario: Alice (moderator), Bob (reporter), Carol (bad actor).
 * Covers: age gate, content filter, report, mutual block + UNBLOCK, admin
 * HIDE (content actually disappears), admin BAN (lockout on next request),
 * the banned-user-can-still-DELETE edge case, and deletion cascade.
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

const signup = (name, email, dob) =>
  req('POST', '/api/auth/signup', { body: { name, email, password: 'Passw0rd', date_of_birth: dob } });

(async () => {
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(os.tmpdir(), 'flock-e2e-pg-' + Date.now()),
    user: 'postgres', password: 'postgres', port: 59595, persistent: false,
  });

  console.log('Starting embedded Postgres (first run downloads binaries)...');
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('flock_e2e');

  process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:59595/flock_e2e';
  process.env.NODE_ENV = 'development';
  process.env.PORT = String(PORT);
  process.env.JWT_SECRET = 'e2e-test-secret';

  // Base schema first — runMigrations() only ADDS to existing tables. Fresh DBs
  // (local/staging) need schema.sql; prod already has it.
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

  // Readiness: /api/health now sits before the auth catch-all; a 200 means up.
  const up = await waitFor(async () => { try { return (await fetch(BASE + '/api/health')).ok; } catch { return false; } }, 30000);
  check('server boots + /api/health 200', up);
  if (!up) { await pg.stop(); process.exit(1); }
  await new Promise(r => setTimeout(r, 1500));

  const t = await pool.query("SELECT to_regclass('public.content_reports') a, to_regclass('public.user_blocks') b, to_regclass('public.moderation_actions') c");
  check('migrations applied (moderation tables exist)', !!(t.rows[0].a && t.rows[0].b && t.rows[0].c), t.rows[0]);

  // --- Age gate (server-side) ---
  let r = await signup('Kid', 'kid@e2e.test', '2015-01-01');
  check('under-13 signup rejected (403)', r.status === 403, r);

  r = await signup('Alice', 'alice@e2e.test', '2000-01-01');
  check('Alice signup (201 + token)', r.status === 201 && !!r.data?.token, r);
  const tA = r.data?.token, idA = r.data?.user?.id;
  r = await signup('Bob', 'bob@e2e.test', '1999-02-02');
  const tB = r.data?.token, idB = r.data?.user?.id;
  check('Bob signup', r.status === 201, r);
  r = await signup('Carol', 'carol@e2e.test', '1998-03-03');
  const tC = r.data?.token, idC = r.data?.user?.id;
  check('Carol signup', r.status === 201, r);

  const meta = await pool.query('SELECT date_of_birth, terms_accepted_at FROM users WHERE id = $1', [idA]);
  check('DOB persisted on row', !!meta.rows[0]?.date_of_birth, meta.rows[0]);
  check('terms_accepted_at recorded on signup', !!meta.rows[0]?.terms_accepted_at, meta.rows[0]);

  // --- Flock + members ---
  r = await req('POST', '/api/flocks', { token: tA, body: { name: 'Test Flock' } });
  const flockId = r.data?.flock?.id ?? r.data?.id ?? r.data?.flock_id;
  check('Alice creates flock', r.status === 201 && !!flockId, r);
  await pool.query("INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1,$2,'accepted'),($1,$3,'accepted')", [flockId, idB, idC]);

  // --- Content filter (Carol posts) ---
  r = await req('POST', `/api/flocks/${flockId}/messages`, { token: tC, body: { message_text: 'you piece of shit' } });
  check('profane flock message blocked (400)', r.status === 400, r);
  r = await req('POST', `/api/flocks/${flockId}/messages`, { token: tC, body: { message_text: 'meeting at 8 works for me' } });
  const msgC = r.data?.message?.id;
  check('clean flock message accepted (201)', r.status === 201 && !!msgC, r);

  // --- Report (Bob reports Carol's message) ---
  r = await req('POST', '/api/reports', { token: tB, body: { content_type: 'flock_message', content_id: msgC, reported_user_id: idC, reason: 'harassment' } });
  const report1 = r.data?.report?.id;
  check('report accepted (201)', r.status === 201 && !!report1, r);

  // --- Mutual block + UNBLOCK ---
  r = await req('POST', `/api/blocks/${idC}`, { token: tB });
  check('Bob blocks Carol (201)', r.status === 201, r);
  r = await req('POST', `/api/dm/${idB}`, { token: tC, body: { message_text: 'hi' } });
  check('blocked user DM rejected (403)', r.status === 403, r);
  r = await req('DELETE', `/api/blocks/${idC}`, { token: tB });
  check('Bob unblocks Carol (200)', r.status === 200, r);
  r = await req('POST', `/api/dm/${idB}`, { token: tC, body: { message_text: 'hi again' } });
  check('DM allowed again after unblock (201)', r.status === 201, r);

  // --- Admin: hide content, then it must vanish from reads ---
  await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [idA]);
  r = await req('GET', '/api/admin/reports', { token: tA });
  check('admin can list reports', r.status === 200 && Array.isArray(r.data?.reports), r);

  r = await req('PUT', `/api/admin/reports/${report1}`, { token: tA, body: { action: 'hide' } });
  check('admin hide action (200)', r.status === 200, r);
  r = await req('GET', `/api/flocks/${flockId}/messages`, { token: tB });
  const stillVisible = (r.data?.messages || []).some(m => m.id === msgC);
  check('hidden message no longer returned to members', r.status === 200 && !stillVisible, { stillVisible });

  // --- Admin: ban, then lockout on next request ---
  r = await req('POST', '/api/reports', { token: tB, body: { content_type: 'profile', reported_user_id: idC, reason: 'harassment' } });
  const report2 = r.data?.report?.id;
  r = await req('PUT', `/api/admin/reports/${report2}`, { token: tA, body: { action: 'ban' } });
  check('admin ban action (200)', r.status === 200, r);
  r = await req('GET', '/api/auth/me', { token: tC });
  check('banned user locked out on next request (403)', r.status === 403, r);

  // --- Banned user must STILL be able to delete their account (deletion right) ---
  r = await req('DELETE', '/api/users/me', { token: tC });
  check('banned user can still delete account (200)', r.status === 200, r);

  // --- Deletion cascade (Bob) ---
  r = await req('DELETE', '/api/users/me', { token: tB });
  check('account deletion (200)', r.status === 200, r);
  r = await req('GET', '/api/auth/me', { token: tB });
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
