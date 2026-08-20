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

async function req(method, p, { token, body, headers } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
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

const signup = (name, email, dob, headers) =>
  req('POST', '/api/auth/signup', { body: { name, email, password: 'Passw0rd', date_of_birth: dob }, headers });

(async () => {
  const pg = new EmbeddedPostgres({
    databaseDir: path.join(os.tmpdir(), 'flock-e2e-pg-' + Date.now()),
    user: 'postgres', password: 'postgres', port: 59595, persistent: false,
    // io_method=sync, for the reason spelled out in __tests__/helpers/embeddedPgPort.js:
    // PostgreSQL 18's default `worker` method starts io_worker children that
    // outlive a killed run forever, because nothing they do ever notices the
    // parent is gone. `sync` starts none, so a Ctrl-C here cannot leave one behind.
    postgresFlags: ['-c', 'io_method=sync'],
  });

  console.log('Starting embedded Postgres (first run downloads binaries)...');
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('flock_e2e');

  process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:59595/flock_e2e';
  // backend/.env carries PGHOST pointing at the PRODUCTION Railway proxy, and
  // server.js's dotenv loads it into any process that has not set it already.
  // The pool never uses it here (DATABASE_URL wins), but the production-
  // database quarantine guard in server.js checks PGHOST FIRST and refuses to
  // boot on a Railway host. Pre-setting it empty keeps dotenv from filling it
  // in (dotenv never overrides an existing value), so the guard sees the
  // embedded localhost database this harness actually uses.
  process.env.PGHOST = '';
  // Same dotenv leak, different variable: .env sets PGSSLMODE=require for the
  // Railway proxy, and config/database.js honors an explicit PGSSLMODE above
  // everything else — but the embedded Postgres speaks no TLS, so the pool
  // died at the handshake ("The server does not support SSL connections").
  process.env.PGSSLMODE = 'disable';
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
  if (!up) { await stopQuietly(pg); process.exit(1); }
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
  // The under-13 refusal now RECORDS the attempt (routes/auth.js underage
  // retry lockout): the same IP cannot sign up again for 15 minutes, so every
  // adult signup below from 127.0.0.1 would be refused with the same neutral
  // sentence. The server trusts one proxy hop (`app.set('trust proxy', 1)`),
  // so giving the kid signup its own X-Forwarded-For source address keeps the
  // lockout scoped to it — which also exercises that the lockout keys on
  // req.ip rather than the raw socket.
  let r = await signup('Kid', 'kid@e2e.test', '2015-01-01', { 'X-Forwarded-For': '203.0.113.66' });
  check('under-13 signup rejected (403)', r.status === 403, r);
  r = await signup('Kid Retry', 'kid@e2e.test', '2000-01-01', { 'X-Forwarded-For': '203.0.113.66' });
  check('same mailbox retrying with a passing birthday still refused (403)', r.status === 403, r);

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
  const tD = r.data?.token, idD = r.data?.user?.id;
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

  // --- Guest RSVP report (round 17, migration 016) ---
  // guest_rsvps.name is unauthenticated UGC broadcast to every member of a
  // flock, and reporting one was a 500 for two rounds: routes/moderation.js
  // accepted the type, routes/admin.js could take it down, and the CHECK
  // constraint on content_reports.content_type had never been widened, so the
  // INSERT died with 23514 and the route's catch turned it into "Failed to
  // submit report". A unit test cannot catch that — the constraint only exists
  // in the database. This is the check that migration 016 actually applied.
  {
    const g = await pool.query(
      "INSERT INTO guest_rsvps (flock_id, name) VALUES ($1, 'Rude Guest Name') RETURNING id",
      [flockId]
    );
    const gr = await req('POST', '/api/reports', {
      token: tB, body: { content_type: 'guest_rsvp', content_id: g.rows[0].id, reason: 'harassment' },
    });
    check('guest RSVP report reaches the queue (was a CHECK-violation 500)', gr.status === 201, gr);
  }

  // --- Mutual block + UNBLOCK ---
  // Round 17: Bob and Carol are made friends FIRST, and their DM is proven to
  // work BEFORE anyone blocks anyone. Without that this whole section was a
  // FALSE PASS: routes/messages.js grew a relationship gate
  // (utils/relationships.js) that refuses a DM between two accounts with no
  // friendship and no DM history, so "blocked user DM rejected (403)" passed
  // for a reason that has nothing to do with blocking — it would have kept
  // passing on a build where blocking did not work at all. Only the unblock
  // check noticed, by failing. The reason is asserted too, so a future reorder
  // of those two gates cannot quietly hollow this out again.
  await pool.query(
    `INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1,$2,'accepted')
     ON CONFLICT (requester_id, addressee_id) DO UPDATE SET status = 'accepted'`,
    [idB, idC]
  );
  r = await req('POST', `/api/dm/${idB}`, { token: tC, body: { message_text: 'hey' } });
  check('connected users can DM before any block (201)', r.status === 201, r);

  r = await req('POST', `/api/blocks/${idC}`, { token: tB });
  check('Bob blocks Carol (201)', r.status === 201, r);
  r = await req('POST', `/api/dm/${idB}`, { token: tC, body: { message_text: 'hi' } });
  check('blocked user DM rejected (403)', r.status === 403, r);
  check(
    'the DM was refused BY THE BLOCK, not by the not-connected gate',
    r.status === 403 && !/connected with/i.test(r.data?.error || ''),
    r.data
  );
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

    // Round 17: naming a place id on a flock no longer makes it "known".
    // utils/places.js dropped that clause because creating a flock is free and
    // its venue_id is a client-supplied string, so any account could promote an
    // arbitrary place id and start writing venue_checkins rows — the table the
    // public occupancy figure sums and the ML pipeline exports. Pin the closed
    // hole here, because the harness's own fixture used to depend on it.
    await pool.query('UPDATE flocks SET venue_id = $1 WHERE id = $2', ['ChIJe2eFlockOnly00001', flockId]);
    cr = await req('GET', '/api/checkin/ChIJe2eFlockOnly00001');
    check('a flock naming a venue does NOT make it known (404)', cr.status === 404, cr);

    // "Known" now means evidence WE created: a claimed profile, provisioned
    // hardware, or a curated ML venue. Real taps still work.
    await pool.query(
      `INSERT INTO ml_venues (google_place_id, name, city, latitude, longitude, venue_category, timezone)
       VALUES ($1, 'E2E Known Venue', 'Bethlehem', 40.6, -75.37, 'bar', 'America/New_York')
       ON CONFLICT (google_place_id) DO NOTHING`,
      ['ChIJe2eKnownVenue0001']
    );
    cr = await req('GET', '/api/checkin/ChIJe2eKnownVenue0001');
    check('known venue tap accepted (200)', cr.status === 200, cr);
    const rows1 = await pool.query('SELECT COUNT(*)::int n FROM venue_checkins WHERE venue_place_id = $1', ['ChIJe2eKnownVenue0001']);
    check('known venue tap recorded', rows1.rows[0].n === 1, rows1.rows[0]);
  }

  // --- Venue tier gate (round 17, services/venueEntitlements.js) ---
  // A PAID boundary whose dashboard-side lock is explicitly cosmetic, so the
  // server side is the only real one. It ships behind a kill switch, which
  // means "correctly a no-op until billing launches" and "silently broken"
  // look identical from the outside — both states are exercised here, over
  // HTTP, against a real venue_profiles row. venueBillingEnabled() reads
  // process.env per request and the server runs in this process, so the switch
  // can be flipped mid-run.
  {
    await pool.query(
      `INSERT INTO venue_profiles (user_id, business_name, google_place_id, tier, verified)
       VALUES ($1, 'E2E Bar', 'ChIJe2eVenueOwner0001', 'free', true)
       ON CONFLICT (user_id) DO UPDATE SET tier = 'free'`,
      [idD]
    );
    const promo = { title: 'Half price wings' };

    let vr = await req('POST', '/api/venue-dashboard/promotions', { token: tD, body: promo });
    check('free tier is unaffected while the billing kill switch is off (201)', vr.status === 201, vr);

    process.env.VENUE_BILLING_ENABLED = 'true';
    vr = await req('POST', '/api/venue-dashboard/promotions', { token: tD, body: promo });
    check('free tier refused once billing is on (403 UPGRADE_REQUIRED)',
      vr.status === 403 && vr.data?.code === 'UPGRADE_REQUIRED', vr);

    await pool.query("UPDATE venue_profiles SET tier = 'premium' WHERE user_id = $1", [idD]);
    vr = await req('POST', '/api/venue-dashboard/promotions', { token: tD, body: promo });
    check('the Insights tier is served (201)', vr.status === 201, vr);

    // A tier string nobody recognises must fail closed. 'constructor' is the
    // specific one: TIER_ORDER is a null-prototype object precisely so this
    // cannot resolve to a truthy rank and walk through the gate.
    await pool.query("UPDATE venue_profiles SET tier = 'constructor' WHERE user_id = $1", [idD]);
    vr = await req('POST', '/api/venue-dashboard/promotions', { token: tD, body: promo });
    check('an unrecognised tier is refused, never treated as paid (403)', vr.status === 403, vr);

    delete process.env.VENUE_BILLING_ENABLED;
    const promos = await pool.query('SELECT COUNT(*)::int n FROM venue_promotions WHERE venue_user_id = $1', [idD]);
    check('exactly the two allowed promotions were written', promos.rows[0].n === 2, promos.rows[0]);
  }

  // --- Banned user must STILL be able to delete their account (deletion right) ---
  // Round 16 put re-authentication in front of this route: a bearer token
  // lifted off an unlocked phone can no longer irreversibly destroy an account.
  // Both halves are asserted, because a harness that only checked the happy
  // path would pass just as well if the proof were never demanded. The
  // no-password probe is free by construction — routes/users.js only spends a
  // rate-limit attempt on a password that was supplied and wrong — so this
  // cannot lock the account out of its own deletion.
  r = await req('DELETE', '/api/users/me', { token: tC });
  check('deletion demands re-authentication (401 + reauthRequired)',
    r.status === 401 && r.data?.reauthRequired === 'password', r);
  r = await req('DELETE', '/api/users/me', { token: tC, body: { password: 'wrong-password' } });
  check('a wrong password does not delete the account (401)', r.status === 401, r);
  r = await req('GET', '/api/auth/me', { token: tC });
  check('the account still exists after the refused deletions (403 banned, not 401)', r.status === 403, r);
  r = await req('DELETE', '/api/users/me', { token: tC, body: { password: 'Passw0rd' } });
  check('banned user can still delete account (200)', r.status === 200, r);

  // --- Ban tombstone (round 16, migration 012) ---
  // Deleting a banned account used to be a one-tap ban reset. The tombstone is
  // written inside the deletion transaction, so this also proves the deletion
  // above did not silently skip it.
  const tomb = await pool.query('SELECT email_hash, phone_hash, oauth_hash, expires_at FROM banned_identities');
  check('deleting a BANNED account leaves a tombstone', tomb.rows.length === 1, tomb.rows);
  check('the tombstone holds a keyed digest, never the address',
    /^[0-9a-f]{64}$/.test(tomb.rows[0]?.email_hash || '')
      && !JSON.stringify(tomb.rows[0] || {}).includes('carol@e2e.test'), tomb.rows[0]);
  check('the tombstone expires', !!tomb.rows[0] && new Date(tomb.rows[0].expires_at) > new Date(), tomb.rows[0]);
  r = await signup('Carol Again', 'carol@e2e.test', '1998-03-03');
  check('the banned identity cannot sign up again (403)', r.status === 403, r);
  check('...and the refusal does not say which identifier matched',
    !/email|phone|address/i.test(r.data?.error || ''), r.data);
  r = await signup('Erin', 'erin@e2e.test', '1996-06-06');
  check('an unrelated address still signs up normally (201)', r.status === 201, r);

  // --- Deletion cascade (Bob) ---
  r = await req('DELETE', '/api/users/me', { token: tB, body: { password: 'Passw0rd' } });
  check('account deletion (200)', r.status === 200, r);
  const tombAfterBob = await pool.query('SELECT COUNT(*)::int n FROM banned_identities');
  check('deleting an UNBANNED account leaves no tombstone', tombAfterBob.rows[0].n === 1, tombAfterBob.rows[0]);
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

    // "The rows exist" was the whole assertion, and rows existing is not what
    // App Review needs — it needs to LOG IN and use the app. Since round 16 an
    // account can exist and still be refused at every screen that matters, so
    // the seeded state is exercised over HTTP the way a reviewer would.
    let sr = await req('POST', '/api/auth/login', { body: { email: 'review@flockcorp.com', password: 'ReviewPass123' } });
    const tR = sr.data?.token;
    check('the seeded reviewer account can log in', sr.status === 200 && !!tR, sr);
    check('the seeded account is verified, so the gates are open',
      sr.data?.user?.email_verified === true, sr.data?.user);
    sr = await req('POST', '/api/flocks', { token: tR, body: { name: 'Reviewer Smoke Flock' } });
    check('the seeded reviewer can create a flock (not 403 unverified)', sr.status === 201, sr);

    // Re-seeding must recover a reviewer account that got BANNED while
    // demonstrating the moderation flow, which is exactly what the seeded
    // reportable content invites a reviewer to do.
    await pool.query("UPDATE users SET is_banned = TRUE, banned_at = NOW() WHERE email = 'review@flockcorp.com'");
    require('child_process').execSync('node scripts/seed-review-account.js', { cwd: path.join(__dirname, '..'), env: process.env, stdio: 'ignore' });
    sr = await req('POST', '/api/auth/login', { body: { email: 'review@flockcorp.com', password: 'ReviewPass123' } });
    sr = await req('GET', '/api/auth/me', { token: sr.data?.token });
    check('re-seeding un-bans the reviewer account', sr.status === 200, sr);
  } catch (e) {
    check('reviewer seed script runs + creates accounts', false, { err: String(e.message).slice(0, 140) });
  }

  console.log(`\nE2E: ${passed} passed, ${failed} failed`);

  // Teardown must never decide the exit code. On Windows, pg.stop() removes the
  // temp data directory and intermittently throws EBUSY because the postgres
  // process has not finished releasing its files yet — which threw out of here,
  // hit the catch below, and turned a run that printed "79 passed, 0 failed"
  // into exit 1. A harness that reports red on a green run gets ignored, which
  // is the same failure as not having one.
  await stopQuietly(pg);
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('E2E harness error:', e);
  process.exit(1);
});

async function stopQuietly(pg) {
  try {
    await pg.stop();
  } catch (e) {
    console.warn(`(cleanup) could not stop/remove the embedded Postgres: ${e.message}`);
    console.warn('(cleanup) the throwaway data directory can be deleted by hand; results above stand.');
  }
}
