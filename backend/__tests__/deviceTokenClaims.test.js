'use strict';
// Run: node --test __tests__/deviceTokenClaims.test.js  (from backend/)
//
// ---------------------------------------------------------------------------
// WHO A PHONE'S PUSH TOKEN BELONGS TO, AND WHICH DEVICES A PUSH IS OWED TO,
// ON A REAL POSTGRES (migration 085)
// ---------------------------------------------------------------------------
//
//   1. THE NEWER SESSION KEEPS THE TOKEN. A registration is sent with the bearer
//      token its request started with, and a plain sign-out revokes nothing, so
//      one still in flight when its account signed out could commit after the
//      next account on the same phone had registered and point the phone back
//      at the account that left: every later push for that account then landed
//      on the phone somebody else was holding. The race is run with the older
//      request committing LAST, and the statement this replaced is run on the
//      same interleaving to show the race was real.
//   2. SIGN-OUT DELETES THIS DEVICE'S ROW, and only while it is still the
//      caller's. A token that has moved to the next account on the phone is not
//      the signed-out account's to delete.
//   3. QUIET HOURS READ THE CLOCK THE ACCOUNT REPORTED LAST, whatever a clean
//      send's liveness stamp did to updated_at.
//   4. THE ICON BADGE DOES NOT COUNT A BANNED SENDER, whose messages no screen
//      shows and nothing can mark read.
//   5. A PUSH IS OWED TO DEVICES, NOT ONLY TO ACCOUNTS. A batch where one device
//      took it and another got a 5xx is retried to the one that failed and no
//      other, and the retry row names it; a quiet-hours hold keeps one row per
//      person for the types that name a person rather than a plan.
//
// Interleavings are made with locks held on the test's own connections, never
// with timers (the house style of planFlowLocks.test.js).
// ---------------------------------------------------------------------------

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');

// Synchronous and before config/database is required anywhere: that module
// builds its Pool from DATABASE_URL at require time, and backend/.env points at
// the live database.
const PG_PORT = pickEmbeddedPgPort('deviceTokenClaims');
const DB_NAME = 'flock_device_token_claims';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-device-token-claims';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.RESEND_API_KEY;
delete process.env.PUSH_QUIET_DEFAULT_TZ;

let pg;
let pool;
let dataDir;
let server;
let base;
let pushHelper;
let firebaseService;
let seq = 0;

// Nobody is connected, so every push is a push.
const offline = { sockets: { adapter: { rooms: new Map() }, sockets: new Map() } };

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-device-token-claims-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'deviceTokenClaims', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);

  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  firebaseService = require('../services/firebaseService');
  pushHelper = require('../services/pushHelper');

  const app = express();
  app.use(express.json());
  app.use('/api/notifications', require('../routes/notifications'));
  app.use('/api/auth', require('../routes/auth'));
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  pushHelper?._resetDebounce();
  firebaseService?.__setSenderForTests(null);
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  try {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (err) {
    console.warn('[deviceTokenClaims] could not remove %s: %s', dataDir, err.message);
  }
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

// A user and a session that signed in `signedInSecondsAgo` seconds ago. The iat
// is set by hand because the whole question is which of two sessions is newer;
// the token is otherwise exactly what signUserToken mints.
async function mkUser(name, signedInSecondsAgo = 60) {
  seq += 1;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified)
     VALUES ($1, 'x', $2, true) RETURNING id, token_version`,
    [`u${seq}-${Date.now()}@devicetokenclaims.test`, name]
  );
  const iat = Math.floor(Date.now() / 1000) - signedInSecondsAgo;
  const session = jwt.sign(
    { userId: rows[0].id, tv: rows[0].token_version || 0, iat },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );
  return { id: rows[0].id, name, iat, session };
}

// An FCM registration token: one per install, shared by whoever signs in on it.
function deviceToken() {
  seq += 1;
  return `fcm-${seq}-${Date.now()}-${'x'.repeat(140)}`;
}

async function call(method, url, { session, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

const register = (user, token, timezone) => call('POST', '/api/notifications/register', {
  session: user.session,
  body: { token, deviceType: 'ios', ...(timezone ? { timezone } : {}) },
});
const signOut = (user, pushToken) => call('POST', '/api/auth/logout', {
  session: user.session,
  body: pushToken ? { pushToken } : {},
});

async function rowOf(token) {
  const { rows } = await pool.query(
    'SELECT id, user_id, signed_in_at, timezone, timezone_reported_at FROM device_tokens WHERE token = $1',
    [token]
  );
  return rows[0] || null;
}
const ownerOf = async (token) => (await rowOf(token))?.user_id ?? null;

// The backends in this database that are waiting on a lock right now.
async function lockWaiters() {
  const { rows } = await pool.query(
    `SELECT pid, query, wait_event FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
  );
  return rows;
}

async function waitForWaiters(label, count, match) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const found = (await lockWaiters()).filter(match);
    if (found.length >= count) return found;
    if (Date.now() > deadline) {
      throw new Error(`${label}: expected ${count} waiting; waiting now: ${JSON.stringify(await lockWaiters())}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}
const isUpsertWait = (w) => /INSERT INTO device_tokens/.test(w.query);

// A connection of the test's own holding the device's row, released once.
async function holdRow(token) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT id FROM device_tokens WHERE token = $1 FOR UPDATE', [token]);
  let done = false;
  return async (how = 'COMMIT') => {
    if (done) return;
    done = true;
    await client.query(how).catch(() => {});
    client.release();
  };
}

// A fixed-offset IANA zone in which the wall clock is `target` hours now.
// Etc/GMT+N is UTC minus N. A real zone keeps the Intl path under test.
function zoneWhereLocalHourIs(target) {
  const utcHour = new Date().getUTCHours();
  let offset = (((target - utcHour) % 24) + 24) % 24;
  if (offset > 12) offset -= 24;
  if (offset === 0) return 'Etc/GMT';
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

// ── 1. The newer session keeps the token ────────────────────────────────────

test('a registration from a session older than the one holding the phone is refused', async () => {
  const phone = deviceToken();
  const ava = await mkUser('Ava', 3600);   // signed in an hour ago, since signed out
  const ben = await mkUser('Ben', 60);     // signed in on the same phone a minute ago

  assert.equal((await register(ava, phone)).status, 200);
  assert.equal(await ownerOf(phone), ava.id);

  assert.equal((await register(ben, phone)).status, 200, 'the newer session takes the phone');
  assert.equal(await ownerOf(phone), ben.id);

  const stale = await register(ava, phone);
  assert.equal(stale.status, 409, stale.text);
  assert.equal(await ownerOf(phone), ben.id, 'the older session took the phone back');

  // The claim on the row is the holding session's sign-in, to the second.
  const row = await rowOf(phone);
  assert.equal(Math.floor(new Date(row.signed_in_at).getTime() / 1000), ben.iat);
});

test('the account holding a token always refreshes its own row, from any of its sessions', async () => {
  const phone = deviceToken();
  const ava = await mkUser('Ava', 30);
  const avaEarlier = { ...ava, iat: ava.iat - 7200 };
  avaEarlier.session = jwt.sign({ userId: ava.id, tv: 0, iat: avaEarlier.iat }, process.env.JWT_SECRET, { expiresIn: '24h' });

  assert.equal((await register(ava, phone, 'America/New_York')).status, 200);
  const res = await register(avaEarlier, phone, 'Europe/London');
  assert.equal(res.status, 200, res.text);
  const row = await rowOf(phone);
  assert.equal(row.user_id, ava.id);
  assert.equal(row.timezone, 'Europe/London');
  assert.equal(Math.floor(new Date(row.signed_in_at).getTime() / 1000), ava.iat,
    'an older session of the same account must not lower the claim a newer one made');
});

test('a row from before migration 085, with no claim on it, can still be taken', async () => {
  const phone = deviceToken();
  const old = await mkUser('Old', 90000);
  const cal = await mkUser('Cal', 3600);
  await pool.query(
    "INSERT INTO device_tokens (user_id, token, device_type) VALUES ($1, $2, 'ios')",
    [old.id, phone]
  );
  assert.equal((await register(cal, phone)).status, 200);
  assert.equal(await ownerOf(phone), cal.id);
});

// THE RACE. Ava's registration was in flight when she signed out and Ben signed
// in on the same phone. Both requests reach the row; a lock the test holds
// queues them, Ben's first, so Ava's commits LAST, which is the order the old
// statement lost.
test('the older session\'s registration committing last still does not take the phone back', async () => {
  const phone = deviceToken();
  const ava = await mkUser('Ava', 3600);
  const ben = await mkUser('Ben', 60);
  assert.equal((await register(ava, phone)).status, 200);

  const release = await holdRow(phone);
  let benReq;
  let avaReq;
  try {
    benReq = register(ben, phone);
    await waitForWaiters('Ben\'s registration', 1, isUpsertWait);
    avaReq = register(ava, phone);
    await waitForWaiters('Ava\'s registration', 2, isUpsertWait);
  } finally {
    await release('COMMIT');
  }
  const [benRes, avaRes] = await Promise.all([benReq, avaReq]);

  assert.equal(benRes.status, 200, benRes.text);
  assert.equal(avaRes.status, 409, `the stale registration was applied: ${avaRes.text}`);
  assert.equal(await ownerOf(phone), ben.id, 'the phone Ben is holding was pointed back at Ava');
});

test('the same interleaving under the statement this replaced hands the phone back to the account that left', async () => {
  // routes/notifications.js before migration 085, verbatim.
  const OLD_UPSERT = `INSERT INTO device_tokens (user_id, token, device_type, timezone)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             device_type = EXCLUDED.device_type,
             timezone = COALESCE(EXCLUDED.timezone, device_tokens.timezone),
             updated_at = NOW()`;
  const phone = deviceToken();
  const ava = await mkUser('Ava', 3600);
  const ben = await mkUser('Ben', 60);
  await pool.query(OLD_UPSERT, [ava.id, phone, 'ios', null]);

  const benConn = await pool.connect();
  const avaConn = await pool.connect();
  const release = await holdRow(phone);
  let benDone;
  let avaDone;
  try {
    benDone = benConn.query(OLD_UPSERT, [ben.id, phone, 'ios', null]);
    await waitForWaiters('Ben\'s statement', 1, isUpsertWait);
    avaDone = avaConn.query(OLD_UPSERT, [ava.id, phone, 'ios', null]);
    await waitForWaiters('Ava\'s statement', 2, isUpsertWait);
  } finally {
    await release('COMMIT');
  }
  await Promise.all([benDone, avaDone]);
  benConn.release();
  avaConn.release();

  assert.equal(await ownerOf(phone), ava.id,
    'the control must reproduce the defect, or the test above proves nothing about it');
});

// ── 2. Sign-out deletes this device's row ────────────────────────────────────

test('sign-out deletes the row for the push token it names, and leaves the account\'s other devices', async () => {
  const phone = deviceToken();
  const laptop = deviceToken();
  const ava = await mkUser('Ava', 600);
  await register(ava, phone);
  await register(ava, laptop);

  const out = await signOut(ava, phone);
  assert.equal(out.status, 200, out.text);
  assert.equal(await rowOf(phone), null, 'the phone signed out and still receives Ava\'s pushes');
  assert.equal(await ownerOf(laptop), ava.id, 'signing out of the phone took the laptop with it');

  // No token named, nothing identified, nothing deleted.
  assert.equal((await signOut(ava)).status, 200);
  assert.equal(await ownerOf(laptop), ava.id);
});

test('a late sign-out cannot delete a token that has moved to the next account on the phone', async () => {
  const phone = deviceToken();
  const ava = await mkUser('Ava', 600);
  const ben = await mkUser('Ben', 30);
  await register(ava, phone);
  await register(ben, phone);

  const late = await signOut(ava, phone);
  assert.equal(late.status, 200, late.text);
  assert.equal(await ownerOf(phone), ben.id, 'Ava\'s sign-out unsubscribed Ben');
});

// ── 3. Whose clock ───────────────────────────────────────────────────────────

test('quiet hours read the zone reported last, not the row a liveness stamp left on top', async () => {
  const cal = await mkUser('Cal', 60);
  const phone = deviceToken();
  const laptop = deviceToken();
  await register(cal, phone, 'America/New_York');   // the phone at home, first (lower id)
  await register(cal, laptop, 'America/New_York');  // the laptop, later (higher id)
  await register(cal, phone, 'Europe/London');      // the phone lands and re-registers
  assert.ok((await rowOf(phone)).id < (await rowOf(laptop)).id, 'the fixture needs the phone on the lower id');

  // A clean send stamps every row of the account in one statement: a tie.
  await pool.query('UPDATE device_tokens SET updated_at = NOW() WHERE user_id = $1', [cal.id]);
  assert.equal(await pushHelper.recipientZone(cal.id), 'Europe/London');

  // The control: the ordering this replaced gives the laptop's clock.
  const { rows } = await pool.query(
    `SELECT timezone FROM device_tokens
      WHERE user_id = $1 AND timezone IS NOT NULL AND timezone <> ''
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [cal.id]
  );
  assert.equal(rows[0].timezone, 'America/New_York', 'the control must reproduce the tie');

  // A registration that reports no zone has not reported where it is.
  assert.equal((await register(cal, laptop)).status, 200);
  assert.equal(await pushHelper.recipientZone(cal.id), 'Europe/London');
});

// ── 4. The badge ─────────────────────────────────────────────────────────────

test('the icon badge does not count unread messages from a banned sender, in DMs or in a plan', async () => {
  const rae = await mkUser('Rae');
  const sol = await mkUser('Sol');
  const max = await mkUser('Max');

  await pool.query(
    `INSERT INTO direct_messages (sender_id, receiver_id, message_text)
     VALUES ($1, $3, 'one'), ($1, $3, 'two'), ($2, $3, 'hey')`,
    [sol.id, max.id, rae.id]
  );
  const { rows: [flock] } = await pool.query(
    `INSERT INTO flocks (name, creator_id, status) VALUES ('Friday', $1, 'planning') RETURNING id`,
    [rae.id]
  );
  await pool.query(
    `INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted'), ($1, $3, 'accepted')`,
    [flock.id, rae.id, max.id]
  );
  const { rows: [read] } = await pool.query(
    `INSERT INTO messages (flock_id, sender_id, message_text) VALUES ($1, $2, 'seen') RETURNING id`,
    [flock.id, max.id]
  );
  await pool.query('UPDATE flock_members SET last_read_message_id = $3 WHERE flock_id = $1 AND user_id = $2',
    [flock.id, rae.id, read.id]);
  await pool.query(`INSERT INTO messages (flock_id, sender_id, message_text) VALUES ($1, $2, 'new')`, [flock.id, max.id]);

  assert.equal(await pushHelper.unreadBadge(rae.id), 4, 'two DMs from Sol, one from Max, one plan message from Max');

  await pool.query('UPDATE users SET is_banned = TRUE WHERE id = $1', [max.id]);
  assert.equal(await pushHelper.unreadBadge(rae.id), 2,
    'a banned sender\'s DM and plan message are on no screen and can never be read, so the icon kept them forever');
});

// ── 5. What a push is owed to ────────────────────────────────────────────────

test('a batch where one device failed is retried to that device alone', async () => {
  const rae = await mkUser('Rae');
  const ava = await mkUser('Ava');
  const laptop = deviceToken();
  const phone = deviceToken();
  await register(rae, laptop);
  await register(rae, phone);
  const phoneId = (await rowOf(phone)).id;

  pushHelper._resetDebounce();
  const sent = [];
  firebaseService.__setSenderForTests((message) => {
    sent.push(message.token);
    if (message.token === phone) {
      const e = new Error('Internal error encountered.');
      e.code = 'messaging/internal-error';
      throw e;
    }
    return 'ok';
  });
  try {
    const res = await pushHelper.pushIfOffline(offline, rae.id, 'Ava', 'running late', {
      type: 'dm_message', senderId: String(ava.id),
    });
    assert.equal(res.sent, 1);
    assert.deepEqual(res.retryIds, [phoneId]);

    const { rows: queued } = await pool.query(
      "SELECT id, reason, token_ids FROM push_outbox WHERE user_id = $1", [rae.id]
    );
    assert.equal(queued.length, 1, 'the phone that got the 5xx was never retried');
    assert.equal(queued[0].reason, 'retry');
    assert.deepEqual(queued[0].token_ids, [phoneId], 'the retry would tell the laptop twice');

    // Released: to the phone and nobody else, and then forgotten.
    sent.length = 0;
    firebaseService.__setSenderForTests((message) => { sent.push(message.token); return 'ok'; });
    await pool.query("UPDATE push_outbox SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1", [queued[0].id]);
    await pushHelper.sweepPushOutbox();
    assert.deepEqual(sent, [phone]);
    const { rows: left } = await pool.query('SELECT id FROM push_outbox WHERE id = $1', [queued[0].id]);
    assert.equal(left.length, 0, 'a delivered row must not be released twice');
  } finally {
    firebaseService.__setSenderForTests(null);
    pushHelper._resetDebounce();
  }
});

test('a release that reaches some devices keeps the row for the ones it did not', async () => {
  const rae = await mkUser('Rae');
  const ava = await mkUser('Ava');
  const laptop = deviceToken();
  const phone = deviceToken();
  await register(rae, laptop);
  await register(rae, phone);
  const phoneId = (await rowOf(phone)).id;
  const { rows: [row] } = await pool.query(
    `INSERT INTO push_outbox (user_id, reason, title, body, data, next_attempt_at, expires_at)
     VALUES ($1, 'quiet', 'Ava', 'running late', $2::jsonb, NOW() - INTERVAL '1 second', NOW() + INTERVAL '1 hour')
     RETURNING id`,
    [rae.id, JSON.stringify({ type: 'dm_message', senderId: String(ava.id) })]
  );

  pushHelper._resetDebounce();
  firebaseService.__setSenderForTests((message) => {
    if (message.token === phone) {
      const e = new Error('Service unavailable'); e.code = 'messaging/server-unavailable'; throw e;
    }
    return 'ok';
  });
  try {
    await pushHelper.sweepPushOutbox();
    const { rows } = await pool.query('SELECT token_ids FROM push_outbox WHERE id = $1', [row.id]);
    assert.equal(rows.length, 1, 'the row was dropped whole and the phone never heard');
    assert.deepEqual(rows[0].token_ids, [phoneId]);
  } finally {
    firebaseService.__setSenderForTests(null);
    pushHelper._resetDebounce();
  }
});

test('overnight, each person\'s request is held on its own row, and each payer\'s claim on its own', async () => {
  const rae = await mkUser('Rae');
  const ava = await mkUser('Ava');
  const ben = await mkUser('Ben');
  const zone = zoneWhereLocalHourIs(3);
  if (pushHelper.localHourIn(zone) === null) return; // runtime without the zone database
  await register(rae, deviceToken(), zone);
  const { rows: [flock] } = await pool.query(
    `INSERT INTO flocks (name, creator_id, status) VALUES ('Friday', $1, 'planning') RETURNING id`,
    [rae.id]
  );

  pushHelper._resetDebounce();
  firebaseService.__setSenderForTests(() => { throw new Error('nothing may be sent at 3am'); });
  try {
    const push = (title, body, data) => pushHelper.pushIfOffline(offline, rae.id, title, body, data);
    assert.equal((await push('New friend request', 'Ava wants to be friends',
      { type: 'friend_request', fromUserId: String(ava.id) })).reason, 'quiet-held');
    await push('New friend request', 'Ben wants to be friends', { type: 'friend_request', fromUserId: String(ben.id) });
    await push('New friend request', 'Ava wants to be friends', { type: 'friend_request', fromUserId: String(ava.id) });
    await push('Marked as paid back', 'Ava says they paid you $12 for Friday.',
      { type: 'bill_settled', flockId: String(flock.id), fromUserId: String(ava.id) });
    await push('Marked as paid back', 'Ben says they paid you $8 for Friday.',
      { type: 'bill_settled', flockId: String(flock.id), fromUserId: String(ben.id) });

    const { rows } = await pool.query(
      `SELECT data->>'type' AS type, data->>'fromUserId' AS from_user, body
         FROM push_outbox WHERE user_id = $1 AND reason = 'quiet' ORDER BY id`,
      [rae.id]
    );
    const held = rows.map((r) => `${r.type}:${r.from_user}`).sort();
    assert.deepEqual(held, [
      `bill_settled:${ava.id}`, `bill_settled:${ben.id}`,
      `friend_request:${ava.id}`, `friend_request:${ben.id}`,
    ].sort(), 'one person replaced another overnight: only the last name reached the morning');
    assert.ok(rows.some((r) => r.body === 'Ava says they paid you $12 for Friday.'));
    assert.ok(rows.some((r) => r.body === 'Ben says they paid you $8 for Friday.'));
  } finally {
    firebaseService.__setSenderForTests(null);
    pushHelper._resetDebounce();
  }
});
