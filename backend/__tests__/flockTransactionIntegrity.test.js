'use strict';
// Run: node --test __tests__/flockTransactionIntegrity.test.js  (from backend/)
//
// ---------------------------------------------------------------------------
// TWO PAIRS OF WRITES THAT HAVE TO BEHAVE AS ONE, ON REAL LOCKS.
// ---------------------------------------------------------------------------
//
// 1. AN ACCOUNT DELETION AND A PLAN DELETE. DELETE /api/flocks/:id locks the
//    plan's row and cascades through it: flock_members first, then messages,
//    then the rest, in the order Postgres fires the foreign keys. DELETE
//    /api/users/me deleted the account's messages first and then the users
//    row, whose cascade reaches flock_members. With a member deleting their
//    account while the host deletes the plan, each held a row the other needed
//    next and Postgres broke the cycle with 40P01, so one of the two people got
//    an error. The deletion now locks every plan it will touch, in id order,
//    before anything else (ACCOUNT_FLOCK_LOCKS_SQL in routes/users.js), and
//    the two queue instead.
//
// 2. A PLAN EDIT AND ITS NIGHT-OF RESET. PUT /api/flocks/:id committed a new
//    time, then cleared the night-of window and every answer in it in a second
//    transaction whose failure was logged while the route answered 200. The
//    plan had moved and the old window stayed open with its answers counting.
//    They are one transaction now.
//
// Real routes on a real migrated Postgres, because both defects are about what
// the server does with locks and transactions, and a scripted pool can only
// assert the order of statements it was written to expect. The interleavings
// are produced with row locks held on a connection of the test's own, never
// with timers: a test holds the row a route needs next, waits until
// pg_stat_activity shows the route blocked on it, starts the other route, and
// only then lets go. One test runs the old statement order on the same
// interleaving and shows it deadlocking, so the route tests passing means the
// lock, not a lucky schedule.
// ---------------------------------------------------------------------------
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcrypt');

const EP = require('embedded-postgres');
const EmbeddedPostgres = EP.default || EP;
const {
  pickEmbeddedPgPort, createEmbeddedPostgres, startEmbeddedPostgres,
} = require('./helpers/embeddedPgPort');

// Synchronous, and before config/database is required anywhere: that module
// builds its Pool from DATABASE_URL at require time, and backend/.env points at
// the live database.
const PG_PORT = pickEmbeddedPgPort('flockTransactionIntegrity');
const DB_NAME = 'flock_transaction_integrity_test';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-flock-transaction-integrity';
delete process.env.RESEND_API_KEY;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.FIREBASE_SERVICE_ACCOUNT;

let pg;
let pool;
let dataDir;
let server;
let base;
let signUserToken;
let ACCOUNT_FLOCK_LOCKS_SQL;

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-txintegrity-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'flockTransactionIntegrity', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);
  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);
  ({ signUserToken } = require('../middleware/auth'));

  const users = require('../routes/users');
  ({ ACCOUNT_FLOCK_LOCKS_SQL } = users.__testing);
  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/flocks', require('../routes/flocks'));
  app.use('/api/users', users);
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  try {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (_) { /* a leftover temp directory is not a failed test */ }
});

async function call(method, p, { token, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}

const count = async (sql, params = []) => (await pool.query(sql, params)).rows[0].n;

const PASSWORD = 'Test-Password-1';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
let seq = 0;

async function mkUser(name) {
  seq += 1;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified)
     VALUES ($1, $2, $3, true) RETURNING *`,
    [`${name.toLowerCase()}.${seq}@txintegrity.test`, PASSWORD_HASH, name]
  );
  return { ...rows[0], token: signUserToken(rows[0]) };
}

// A plan hosted by `host`, with `members` accepted in that order (row order is
// the order a cascade reaches them) and `messages` as [author, text] pairs.
async function planWith(host, members, messages) {
  const { rows } = await pool.query(
    `INSERT INTO flocks (name, creator_id) VALUES ('Friday', $1) RETURNING id`, [host.id]
  );
  const flockId = rows[0].id;
  for (const m of members) {
    await pool.query(
      `INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted')`, [flockId, m.id]
    );
  }
  for (const [author, text] of messages) {
    await pool.query(
      'INSERT INTO messages (flock_id, sender_id, message_text) VALUES ($1, $2, $3)', [flockId, author.id, text]
    );
  }
  return flockId;
}

// The backends in this database that are waiting on a lock right now.
async function lockWaiters() {
  const { rows } = await pool.query(
    `SELECT pid, query FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`
  );
  return rows;
}

async function waitForWaiter(label, match) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const found = (await lockWaiters()).find(match);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`${label} never blocked on a lock; waiting now: ${JSON.stringify(await lockWaiters())}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

// A connection holding one row lock, released exactly once however the test ends.
async function holdRow(sql, params) {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query(sql, params);
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  };
}

const flat = (sql) => String(sql).replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// 1. THE ACCOUNT DELETION AND THE PLAN DELETE
// ---------------------------------------------------------------------------

// Both doors that delete a plan: DELETE /:id, and the host leaving, which
// deletes it the same way under the same lock.
const PLAN_DELETES = [
  ['the host deletes the plan', (flockId, host) => call('DELETE', `/api/flocks/${flockId}`, { token: host.token })],
  ['the host leaves the plan', (flockId, host) => call('POST', `/api/flocks/${flockId}/leave`, { token: host.token })],
];

for (const [door, deletePlan] of PLAN_DELETES) {
  test(`a member deletes their account while ${door}: both finish, and nobody is a deadlock victim`, async () => {
    const host = await mkUser('Host');
    const member = await mkUser('Member');
    const flockId = await planWith(host, [member, host], [[member, 'on my way'], [member, 'here'], [host, 'see you']]);

    // The deletion reads its own users row FOR UPDATE after it has deleted the
    // member's messages, so holding that row stops it exactly there. That is
    // the point where, before the plan locks, it held the messages the plan
    // delete's cascade was about to need.
    const release = await holdRow('SELECT id FROM users WHERE id = $1 FOR UPDATE', [member.id]);
    try {
      const deletion = call('DELETE', '/api/users/me', { token: member.token, body: { password: PASSWORD } });
      await waitForWaiter('the account deletion', (w) => /FROM users WHERE id = \$1 FOR UPDATE/.test(w.query));

      const planDelete = deletePlan(flockId, host);
      const blocked = await waitForWaiter('the plan delete', (w) => /FROM flocks/.test(w.query));
      // Where it waits is the fix: on the plan row the deletion took first,
      // not halfway through a cascade holding rows the deletion needs.
      assert.match(flat(blocked.query), /^SELECT id FROM flocks WHERE id = \$1 FOR UPDATE$/);

      await release();
      const [del, gone] = await Promise.all([deletion, planDelete]);
      assert.equal(del.status, 200, `the account deletion: ${del.text}`);
      assert.equal(gone.status, 200, `${door}: ${gone.text}`);
    } finally {
      await release();
    }
    assert.equal(await count('SELECT COUNT(*)::int AS n FROM users WHERE id = $1', [member.id]), 0);
    assert.equal(await count('SELECT COUNT(*)::int AS n FROM flocks WHERE id = $1', [flockId]), 0);
    assert.equal(await count('SELECT COUNT(*)::int AS n FROM messages WHERE flock_id = $1', [flockId]), 0);
  });
}

test('an account deletion that arrives in the middle of a plan delete waits for it, then finishes without the plan', async () => {
  const host = await mkUser('Host');
  const member = await mkUser('Member');
  // The member's membership row first, so the plan delete's cascade takes it
  // before reaching the host's, which is held below.
  const flockId = await planWith(host, [member, host], [[member, 'one'], [member, 'two']]);
  const other = await planWith(host, [member, host], [[member, 'elsewhere']]);

  const release = await holdRow(
    'SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 FOR UPDATE', [flockId, host.id]
  );
  try {
    const planDelete = call('DELETE', `/api/flocks/${flockId}`, { token: host.token });
    const cascading = await waitForWaiter('the plan delete', (w) => /DELETE FROM flocks/.test(w.query));

    const deletion = call('DELETE', '/api/users/me', { token: member.token, body: { password: PASSWORD } });
    const queued = await waitForWaiter('the account deletion', (w) => w.pid !== cascading.pid);
    // Its first statement, before any row of the member's was touched.
    assert.equal(flat(queued.query), flat(ACCOUNT_FLOCK_LOCKS_SQL));

    await release();
    const [gone, del] = await Promise.all([planDelete, deletion]);
    assert.equal(gone.status, 200, `the plan delete: ${gone.text}`);
    assert.equal(del.status, 200, `the account deletion: ${del.text}`);
  } finally {
    await release();
  }
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM users WHERE id = $1', [member.id]), 0);
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM flocks WHERE id = $1', [flockId]), 0);
  // The plan the deletion did lock, and that nobody deleted, is still there,
  // without the member.
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM flocks WHERE id = $1', [other]), 1);
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM messages WHERE flock_id = $1', [other]), 0);
  assert.equal(
    await count('SELECT COUNT(*)::int AS n FROM flock_members WHERE flock_id = $1 AND user_id = $2', [other, member.id]), 0
  );
});

test('without the plan locks, the same interleaving is a deadlock', async () => {
  // deleteAccount's statements as they were, minus the moderation
  // de-attribution that touches no plan, on the schedule the first test
  // produces. This is what makes the two tests above mean something.
  const host = await mkUser('Host');
  const member = await mkUser('Member');
  const flockId = await planWith(host, [member, host], [[member, 'on my way'], [member, 'here']]);
  const account = await pool.connect();
  const plan = await pool.connect();
  try {
    await account.query('BEGIN');
    await account.query('DELETE FROM messages WHERE sender_id = $1', [member.id]);
    await plan.query('BEGIN');
    await plan.query('SELECT id FROM flocks WHERE id = $1 FOR UPDATE', [flockId]);
    const planDone = plan.query('DELETE FROM flocks WHERE id = $1', [flockId]).then(() => null, (e) => e);
    await waitForWaiter('the plan delete', (w) => /DELETE FROM flocks/.test(w.query));
    const accountDone = account.query('DELETE FROM users WHERE id = $1', [member.id]).then(() => null, (e) => e);
    const failures = (await Promise.all([planDone, accountDone])).filter(Boolean);
    assert.deepEqual(failures.map((e) => e.code), ['40P01'], 'exactly one of the two is chosen as the deadlock victim');
  } finally {
    await account.query('ROLLBACK').catch(() => {});
    await plan.query('ROLLBACK').catch(() => {});
    account.release();
    plan.release();
  }
});

test('every table a plan delete reaches that also names a user is in the deletion lock', async () => {
  // The lock has to cover every plan holding a row both deletes touch. A
  // plan delete touches what its foreign keys reach, cascading or setting
  // null; an account deletion touches every row naming the account. So the
  // tables are those two sets' overlap, read off the catalog, and a new table
  // in it that the statement does not name reopens the deadlock for plans the
  // account has rows in there.
  const { rows } = await pool.query(
    `WITH RECURSIVE deleted(rel) AS (
       SELECT 'flocks'::regclass::oid
       UNION
       SELECT c.conrelid FROM pg_constraint c JOIN deleted d ON c.confrelid = d.rel
        WHERE c.contype = 'f' AND c.confdeltype = 'c'
     ), touched(rel) AS (
       SELECT rel FROM deleted
       UNION
       SELECT c.conrelid FROM pg_constraint c JOIN deleted d ON c.confrelid = d.rel
        WHERE c.contype = 'f' AND c.confdeltype IN ('n', 'd')
     )
     SELECT DISTINCT cl.relname
       FROM touched t
       JOIN pg_class cl ON cl.oid = t.rel
      WHERE EXISTS (SELECT 1 FROM pg_constraint u
                     WHERE u.contype = 'f' AND u.conrelid = t.rel AND u.confrelid = 'users'::regclass)
      ORDER BY 1`
  );
  const tables = rows.map((r) => r.relname);
  for (const t of ['flocks', 'flock_members', 'messages', 'venue_votes', 'emoji_reactions']) {
    assert.ok(tables.includes(t), `the catalog walk must find ${t}, or it is not walking the plan`);
  }
  const missing = tables.filter((t) => !new RegExp(`\\b${t}\\b`).test(ACCOUNT_FLOCK_LOCKS_SQL));
  assert.deepEqual(
    missing, [],
    'ACCOUNT_FLOCK_LOCKS_SQL in routes/users.js must lock the plans these tables hold rows of for the account'
  );
});

// ---------------------------------------------------------------------------
// 2. THE PLAN EDIT AND ITS NIGHT-OF RESET
// ---------------------------------------------------------------------------

// event_time is a naive TIMESTAMP holding UTC wall-clock, and node-postgres
// reads a naive value in this process's zone, so it is compared as Postgres
// prints it rather than as a Date.
async function planState(flockId) {
  const f = (await pool.query(
    'SELECT event_time::text AS event_time, status, reconfirm_opened_at FROM flocks WHERE id = $1', [flockId]
  )).rows[0];
  const members = (await pool.query(
    'SELECT user_id, reconfirmed_at FROM flock_members WHERE flock_id = $1 ORDER BY user_id', [flockId]
  )).rows;
  const guests = (await pool.query(
    'SELECT id, reconfirmed_at FROM guest_rsvps WHERE flock_id = $1 ORDER BY id', [flockId]
  )).rows;
  return { ...f, members, guests };
}

test('a plan edit whose night-of reset fails changes nothing and says so, and one that succeeds does both', async () => {
  const host = await mkUser('Host');
  const member = await mkUser('Member');
  // Confirmed, two hours out, with the "still in?" window open and answered.
  const flockId = (await pool.query(
    `INSERT INTO flocks (name, creator_id, status, event_time, reconfirm_opened_at)
     VALUES ('Dinner', $1, 'confirmed', (NOW() AT TIME ZONE 'UTC') + INTERVAL '2 hours', NOW())
     RETURNING id`,
    [host.id]
  )).rows[0].id;
  for (const u of [host, member]) {
    await pool.query(
      `INSERT INTO flock_members (flock_id, user_id, status, reconfirmed_at) VALUES ($1, $2, 'accepted', NOW())`,
      [flockId, u.id]
    );
  }
  await pool.query(
    `INSERT INTO guest_rsvps (flock_id, name, status, reconfirmed_at) VALUES ($1, 'Cass', 'in', NOW())`, [flockId]
  );
  const before = await planState(flockId);
  assert.ok(before.reconfirm_opened_at && before.members.every((m) => m.reconfirmed_at));

  const moved = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
  const ddl = await pool.connect();
  try {
    // The guest roster refuses the reset's UPDATE, the way a lock timeout or a
    // dropped connection would refuse it.
    await ddl.query(
      `CREATE FUNCTION txintegrity_refuse_reset() RETURNS trigger LANGUAGE plpgsql
         AS $$ BEGIN RAISE EXCEPTION 'reset refused for this test'; END $$`
    );
    await ddl.query(
      `CREATE TRIGGER txintegrity_refuse_reset BEFORE UPDATE ON guest_rsvps
         FOR EACH STATEMENT EXECUTE FUNCTION txintegrity_refuse_reset()`
    );
    await assert.rejects(
      pool.query('UPDATE guest_rsvps SET reconfirmed_at = NULL WHERE flock_id = $1', [flockId]),
      /reset refused for this test/,
      'the fault has to be real for the next assertion to mean anything'
    );

    const res = await call('PUT', `/api/flocks/${flockId}`, { token: host.token, body: { event_time: moved } });
    assert.equal(res.status, 500, `a failed reset has to fail the edit: ${res.text}`);
    assert.deepEqual(
      await planState(flockId), before,
      'nothing may change: not the time, not the window, not one answer'
    );
  } finally {
    await ddl.query('DROP TRIGGER IF EXISTS txintegrity_refuse_reset ON guest_rsvps').catch(() => {});
    await ddl.query('DROP FUNCTION IF EXISTS txintegrity_refuse_reset()').catch(() => {});
    ddl.release();
  }

  // With nothing in the way, the same edit moves the plan and closes the
  // window, together.
  const res = await call('PUT', `/api/flocks/${flockId}`, { token: host.token, body: { event_time: moved } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.flock.reconfirm_opened_at, null, 'the response shows the window closed');
  const after = await planState(flockId);
  const { rows: [{ ok: movedThere }] } = await pool.query(
    `SELECT event_time = ($2::timestamptz AT TIME ZONE 'UTC') AS ok FROM flocks WHERE id = $1`, [flockId, moved]
  );
  assert.equal(movedThere, true, 'the plan moved to the time asked for');
  assert.equal(after.reconfirm_opened_at, null);
  assert.ok(after.members.every((m) => m.reconfirmed_at === null), 'every member answer cleared');
  assert.ok(after.guests.every((g) => g.reconfirmed_at === null), 'every guest answer cleared');
});
