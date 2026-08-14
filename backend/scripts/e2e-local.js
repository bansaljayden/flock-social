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
  process.env.IMAGE_MODERATION_REQUIRED = 'true'; // exercise the fail-closed image path (no provider configured)

  // Round 12: the harness used to apply database/schema.sql by hand before
  // boot, which hid the fact that a REBUILT DATABASE COULD NOT BOOT — the core
  // tables existed in no migration, so against an empty Postgres 001 (tolerant)
  // skipped everything and 002 threw on a nonexistent device_tokens. Nothing is
  // pre-applied now: the database below is empty and migrations alone have to
  // build it. Assert the emptiness so this can never silently regress.
  const { Client } = require('pg');
  {
    const sc = new Client({ connectionString: process.env.DATABASE_URL });
    await sc.connect();
    const pre = await sc.query("SELECT to_regclass('public.users') u, to_regclass('public.flocks') f");
    check('database starts EMPTY (no users/flocks before migrations)', !pre.rows[0].u && !pre.rows[0].f, pre.rows[0]);
    await sc.end();
  }

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

  // Round 12: the bootstrap + ML + alert-dedupe migrations built the whole
  // database from nothing. If any of these is null, a fresh deploy crash-loops.
  const core = await pool.query(`SELECT
      to_regclass('public.users') users,
      to_regclass('public.flocks') flocks,
      to_regclass('public.messages') messages,
      to_regclass('public.direct_messages') dms,
      to_regclass('public.device_tokens') device_tokens,
      to_regclass('public.ml_venues') ml_venues,
      to_regclass('public.ml_venue_baselines') ml_baselines,
      to_regclass('public.crowd_alert_sends') crowd_alert_sends`);
  check('fresh database built from migrations alone', Object.values(core.rows[0]).every(Boolean), core.rows[0]);

  const idx = await pool.query(
    `SELECT COUNT(*)::int n FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)`,
    [['idx_messages_flock_created', 'idx_dm_sender_receiver_created', 'idx_dm_receiver_sender_created',
      'idx_dm_reply_to', 'idx_venue_checkins_place_created', 'idx_venue_votes_user',
      'idx_ml_venues_lat_lng', 'idx_venue_sensor_data_place_recorded']]
  );
  check('growth indexes created (all 8)', idx.rows[0].n === 8, idx.rows[0]);

  // Every migration must be RECORDED, or the next boot replays it forever.
  const migFiles = require('fs').readdirSync(path.join(__dirname, '..', 'migrations')).filter((f) => f.endsWith('.sql')).length;
  const mig = await pool.query('SELECT COUNT(*)::int n FROM schema_migrations');
  check('every migration recorded as applied', mig.rows[0].n === migFiles, { recorded: mig.rows[0].n, files: migFiles });

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
  r = await signup('Dave', 'dave@e2e.test', '1997-04-04');
  const tD = r.data?.token;
  check('Dave signup', r.status === 201, r);

  const meta = await pool.query('SELECT date_of_birth, terms_accepted_at, email_verified FROM users WHERE id = $1', [idA]);
  check('DOB persisted on row', !!meta.rows[0]?.date_of_birth, meta.rows[0]);
  check('terms_accepted_at recorded on signup', !!meta.rows[0]?.terms_accepted_at, meta.rows[0]);

  // --- Email verification (round 16, migration 011) ---
  // A password signup starts UNVERIFIED and cannot accumulate the things that
  // make squatting a victim's address profitable: payment handles, accepted
  // friendships, flock membership. This is the one place that runs against a
  // real Postgres, so it is also the check that migration 011 actually applied.
  check('signup account starts unverified', meta.rows[0]?.email_verified === false, meta.rows[0]);
  const evTable = await pool.query("SELECT to_regclass('public.email_verifications') t");
  check('email_verifications table created', !!evTable.rows[0].t, evTable.rows[0]);
  const evRow = await pool.query(
    'SELECT selector, verifier_hash, email, expires_at, used_at FROM email_verifications WHERE user_id = $1',
    [idA]
  );
  check('a verification link was issued at signup', evRow.rows.length === 1, evRow.rows[0]);
  check('the link expires', evRow.rows[0] && new Date(evRow.rows[0].expires_at) > new Date(), evRow.rows[0]);
  check('the token secret is not stored in the clear', /^[0-9a-f]{64}$/.test(evRow.rows[0]?.verifier_hash || ''), evRow.rows[0]);

  r = await req('POST', '/api/flocks', { token: tA, body: { name: 'Blocked Flock' } });
  check('unverified account cannot create a flock (403)', r.status === 403, r);
  r = await req('PUT', '/api/users/payment-methods', { token: tA, body: { venmo_username: 'attacker' } });
  check('unverified account cannot set a payment handle (403)', r.status === 403, r);
  r = await req('POST', '/api/friends/request', { token: tA, body: { user_id: idB } });
  check('unverified account cannot send a friend request (403)', r.status === 403, r);
  r = await req('GET', '/api/auth/me', { token: tA });
  check('unverified account is not locked out of the app (200)', r.status === 200, r);
  check('/me reports the verification state', r.data?.user?.email_verified === false, r.data?.user);

  // The link itself only exists inside the email, which is not sent here (no
  // RESEND_API_KEY), so the rest of the run verifies these accounts directly.
  // The single-use/expiry/constant-time behaviour of the link is covered in
  // backend/__tests__/emailVerification.test.js.
  await pool.query("UPDATE users SET email_verified = TRUE, verified_email = email WHERE email LIKE '%@e2e.test'");

  r = await req('POST', '/api/friends/request', { token: tA, body: { user_id: idB } });
  check('verifying lifts the gate (friend request now allowed)', r.status < 400, r);

  // --- Flock + members ---
  r = await req('POST', '/api/flocks', { token: tA, body: { name: 'Test Flock' } });
  const flockId = r.data?.flock?.id ?? r.data?.id ?? r.data?.flock_id;
  check('Alice creates flock', r.status === 201 && !!flockId, r);
  await pool.query("INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1,$2,'accepted'),($1,$3,'accepted')", [flockId, idB, idC]);

  // --- Authorization boundaries + input validation ---
  r = await req('POST', `/api/flocks/${flockId}/messages`, { token: tD, body: { message_text: 'i am not a member' } });
  check('non-member cannot post to flock (403)', r.status === 403, r);
  r = await req('GET', '/api/admin/reports', { token: tB });
  check('non-admin blocked from admin reports (403)', r.status === 403, r);
  r = await req('POST', `/api/blocks/${idA}`, { token: tA });
  check('cannot block yourself (400)', r.status === 400, r);
  r = await req('POST', '/api/reports', { token: tB, body: { reason: 'harassment' } });
  check('report without content_type rejected (400)', r.status === 400, r);

  // --- Content filter (Carol posts) ---
  r = await req('POST', `/api/flocks/${flockId}/messages`, { token: tC, body: { message_text: 'you piece of shit' } });
  check('profane flock message blocked (400)', r.status === 400, r);
  r = await req('POST', `/api/flocks/${flockId}/messages`, { token: tC, body: { message_text: 'meeting at 8 works for me' } });
  const msgC = r.data?.message?.id;
  check('clean flock message accepted (201)', r.status === 201 && !!msgC, r);

  // Image moderation INTEGRATION: with IMAGE_MODERATION_REQUIRED + no provider,
  // the upload route must FAIL-CLOSED. Proves moderateImage is wired into the
  // upload path (a valid 1x1 PNG clears the magic-byte check, then is rejected).
  {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
    const fd = new FormData();
    fd.append('image', new Blob([png], { type: 'image/png' }), 'x.png');
    const ir = await fetch(BASE + '/api/users/upload-image', { method: 'POST', headers: { Authorization: 'Bearer ' + tA }, body: fd });
    check('image upload fail-closed when moderation required + unconfigured (400)', ir.status === 400, { status: ir.status });
  }

  // --- Report (Bob reports Carol's message) ---
  r = await req('POST', '/api/reports', { token: tB, body: { content_type: 'flock_message', content_id: msgC, reported_user_id: idC, reason: 'harassment' } });
  const report1 = r.data?.report?.id;
  check('report accepted (201)', r.status === 201 && !!report1, r);

  // --- Mutual block + UNBLOCK ---
  r = await req('POST', `/api/blocks/${idC}`, { token: tB });
  check('Bob blocks Carol (201)', r.status === 201, r);
  r = await req('POST', `/api/dm/${idB}`, { token: tC, body: { message_text: 'hi' } });
  check('blocked user DM rejected (403)', r.status === 403, r);
  r = await req('GET', `/api/flocks/${flockId}/messages`, { token: tB });
  const carolVisibleWhileBlocked = (r.data?.messages || []).some(m => m.id === msgC);
  check('blocked user message hidden in shared flock', r.status === 200 && !carolVisibleWhileBlocked, { carolVisibleWhileBlocked });
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

  // --- Unauthenticated NFC check-in: shape + known-venue gate (round 12) ---
  {
    const longId = 'C'.repeat(300); // used to overflow VARCHAR(255) as a 500
    let cr = await req('GET', `/api/checkin/${longId}`);
    check('over-long place id rejected 400 (was a VARCHAR overflow 500)', cr.status === 400, cr);
    cr = await req('GET', '/api/checkin/not a place id!');
    check('malformed place id rejected 400', cr.status === 400, cr);
    cr = await req('GET', '/api/checkin/ChIJfabricated0000000000');
    check('unknown venue rejected 404 (no unbounded anon writes)', cr.status === 404, cr);
    const rows0 = await pool.query('SELECT COUNT(*)::int n FROM venue_checkins');
    check('no venue_checkins rows written by rejected taps', rows0.rows[0].n === 0, rows0.rows[0]);

    // A venue a flock actually planned at IS known — real taps still work.
    await pool.query('UPDATE flocks SET venue_id = $1 WHERE id = $2', ['ChIJe2eKnownVenue0001', flockId]);
    cr = await req('GET', '/api/checkin/ChIJe2eKnownVenue0001');
    check('known venue tap accepted (200)', cr.status === 200, cr);
    const rows1 = await pool.query('SELECT COUNT(*)::int n FROM venue_checkins WHERE venue_place_id = $1', ['ChIJe2eKnownVenue0001']);
    check('known venue tap recorded', rows1.rows[0].n === 1, rows1.rows[0]);
  }

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

  // Round 12: deletion de-attributes moderation evidence inside ONE transaction
  // instead of three swallowed UPDATEs. Both the reporter (Bob) and the
  // reported abuser (Carol) are gone; the reports and the ban action must not
  // be — that is the whole point of the code path.
  const evid = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM content_reports) reports,
      (SELECT COUNT(*)::int FROM content_reports WHERE reporter_id IS NOT NULL OR reported_user_id IS NOT NULL) attributed,
      (SELECT COUNT(*)::int FROM moderation_actions WHERE action = 'user_banned') bans`);
  check('moderation evidence survives deletion of both parties', evid.rows[0].reports > 0 && evid.rows[0].bans > 0, evid.rows[0]);
  check('deleted users de-attributed, not cascaded away', evid.rows[0].attributed === 0, evid.rows[0]);

  // Verify the reviewer seed script actually runs against a migrated DB (it's the
  // App Review demo fixture — it must work). Child inherits DATABASE_URL=embedded.
  try {
    require('child_process').execSync('node scripts/seed-review-account.js', { cwd: path.join(__dirname, '..'), env: process.env, stdio: 'ignore' });
    const seeded = await pool.query("SELECT COUNT(*)::int n FROM users WHERE email IN ('review@flockcorp.com','buddy@flockcorp.com')");
    check('reviewer seed script runs + creates accounts', seeded.rows[0].n === 2, seeded.rows[0]);
  } catch (e) {
    check('reviewer seed script runs + creates accounts', false, { err: String(e.message).slice(0, 140) });
  }

  console.log(`\nE2E: ${passed} passed, ${failed} failed`);
  await pg.stop();
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('E2E harness error:', e);
  process.exit(1);
});
