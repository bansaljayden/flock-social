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
// 3. A PLAN DELETE AND THE REPORTS FILED IN IT. messages and guest_rsvps
//    cascade away with their plan, so deleting a plan took reported content
//    with it and the moderator opened the report to nothing. What an open
//    report names is now copied out in the delete's own transaction
//    (migration 110), on every door that deletes a plan. And the copy is not
//    kept for good: it goes a stated period after the last report naming it
//    is closed, which is what the privacy policy says. Until then it is in
//    nobody's data export, its author's included, since a copy there would
//    tell the author about an open report.
//
// 4. TWO ACCOUNT DELETIONS AND THE REPORTS BETWEEN THEM. Two people who had
//    reported each other and deleted their accounts at once each cleared the
//    report they filed, then waited for the one the other filed: 40P01. The
//    deletion now locks every report naming the account in id order before
//    it clears any (ACCOUNT_REPORT_LOCKS_SQL in routes/users.js). And it
//    clears them under the account row's lock, so a report filed during the
//    deletion is either cleared and kept or refused, never cascaded away.
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
let ACCOUNT_REPORT_LOCKS_SQL;

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
  ({ ACCOUNT_FLOCK_LOCKS_SQL, ACCOUNT_REPORT_LOCKS_SQL } = users.__testing);
  const app = express();
  app.use(express.json());
  app.set('io', null);
  app.use('/api/flocks', require('../routes/flocks'));
  app.use('/api/users', users);
  // The moderation console's readers, for section 3: what a moderator is shown
  // once the plan a report was filed in is gone.
  app.use('/api/admin', require('../routes/admin'));
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

// ---------------------------------------------------------------------------
// 3. REPORTED CONTENT OUTLIVES THE PLAN IT WAS POSTED IN
// ---------------------------------------------------------------------------

async function mkModerator() {
  const mod = await mkUser('Mod');
  await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [mod.id]);
  return mod;
}

async function postIn(flockId, author, { text = '', type = 'text', venue = null, image = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO messages (flock_id, sender_id, message_text, message_type, venue_data, image_url)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [flockId, author.id, text, type, venue ? JSON.stringify(venue) : null, image]
  );
  return rows[0].id;
}

async function guestIn(flockId, name) {
  const { rows } = await pool.query(
    `INSERT INTO guest_rsvps (flock_id, name, status) VALUES ($1, $2, 'in') RETURNING id`, [flockId, name]
  );
  return rows[0].id;
}

async function report(reporter, author, type, contentId, status = 'open') {
  const { rows } = await pool.query(
    `INSERT INTO content_reports (reporter_id, reported_user_id, content_type, content_id, reason, status)
     VALUES ($1, $2, $3, $4, 'harassment', $5) RETURNING id`,
    [reporter.id, author ? author.id : null, type, contentId, status]
  );
  return rows[0].id;
}

const IMAGE = 'data:image/png;base64,iVBORw0KGgo=';

// One plan with everything a report can name in it, and the reports: open ones
// on a venue card, a photo and a guest's name, and two that must not be kept,
// one on a message a moderator already resolved and nothing at all on the rest.
async function reportedPlan({ host, abuser, reporter, roster }) {
  const flockId = await planWith(host, roster, []);
  const ids = {
    card: await postIn(flockId, abuser, {
      text: 'look', type: 'venue_card', venue: { name: 'Bad Place', addr: '1 Main St', category: 'bar' },
    }),
    photo: await postIn(flockId, host, { type: 'image', image: IMAGE }),
    judged: await postIn(flockId, abuser, { text: 'already judged' }),
    plain: await postIn(flockId, abuser, { text: 'nobody reported this' }),
    guest: await guestIn(flockId, 'Rude Name'),
    quiet: await guestIn(flockId, 'Cass'),
  };
  const reports = {
    card: await report(reporter, abuser, 'flock_message', ids.card),
    photo: await report(reporter, host, 'flock_message', ids.photo, 'under_review'),
    judged: await report(reporter, abuser, 'flock_message', ids.judged, 'resolved'),
    guest: await report(reporter, null, 'guest_rsvp', ids.guest),
  };
  return { flockId, ids, reports };
}

const keptCopies = async (ids) => (await pool.query(
  `SELECT content_type, content_id FROM content_report_evidence
    WHERE (content_type = 'flock_message' AND content_id = ANY($1))
       OR (content_type = 'guest_rsvp' AND content_id = ANY($2))`,
  [[ids.card, ids.photo, ids.judged, ids.plain], [ids.guest, ids.quiet]]
)).rows.map((r) => `${r.content_type}:${r.content_id}`).sort();

async function queueCard(mod, reportId) {
  const res = await call('GET', '/api/admin/reports?limit=1000', { token: mod.token });
  assert.equal(res.status, 200, res.text);
  const card = res.body.reports.find((r) => r.id === reportId);
  assert.ok(card, `report ${reportId} is in the queue`);
  return card;
}

// Every door that deletes a plan, and who the roster has to hold for that door
// to be the one that deletes it. The last member out only deletes a plan whose
// host is not in the roster any more.
const PLAN_DOORS = [
  {
    door: 'the host deletes the plan',
    roster: ({ host, abuser, reporter }) => [host, abuser, reporter],
    run: (flockId, { host }) => call('DELETE', `/api/flocks/${flockId}`, { token: host.token }),
  },
  {
    door: 'the host leaves the plan',
    roster: ({ host, abuser, reporter }) => [host, abuser, reporter],
    run: (flockId, { host }) => call('POST', `/api/flocks/${flockId}/leave`, { token: host.token }),
  },
  {
    door: 'the last member leaves the plan',
    roster: ({ abuser }) => [abuser],
    run: (flockId, { abuser }) => call('POST', `/api/flocks/${flockId}/leave`, { token: abuser.token }),
  },
];

for (const { door, roster, run } of PLAN_DOORS) {
  test(`when ${door}, what an open report names is kept, and the moderator still sees it`, async () => {
    const people = {
      host: await mkUser('Host'), abuser: await mkUser('Abuser'), reporter: await mkUser('Reporter'),
    };
    const mod = await mkModerator();
    const { flockId, ids, reports } = await reportedPlan({ ...people, roster: roster(people) });

    const res = await run(flockId, people);
    assert.equal(res.status, 200, `${door}: ${res.text}`);
    assert.equal(await count('SELECT COUNT(*)::int AS n FROM flocks WHERE id = $1', [flockId]), 0, 'the plan is gone');
    assert.equal(await count('SELECT COUNT(*)::int AS n FROM messages WHERE flock_id = $1', [flockId]), 0);

    // Exactly what an open or under-review report names: not the message a
    // moderator already resolved, not what nobody reported.
    assert.deepEqual(await keptCopies(ids), [
      `flock_message:${ids.card}`, `flock_message:${ids.photo}`, `guest_rsvp:${ids.guest}`,
    ].sort());

    const card = await queueCard(mod, reports.card);
    assert.equal(card.content_missing, false, 'the report no longer points at nothing');
    assert.equal(card.content_preserved, true);
    assert.match(card.content_excerpt, /look/);
    assert.match(card.content_excerpt, /Venue card: Bad Place/, 'the venue card reads as it did live');
    assert.equal(card.content_author_id, people.abuser.id);

    const photo = await queueCard(mod, reports.photo);
    assert.equal(photo.content_preserved, true);
    assert.equal(photo.content_has_image, true);
    const image = await call('GET', `/api/admin/reports/${reports.photo}/image`, { token: mod.token });
    assert.equal(image.status, 200, image.text);
    assert.equal(image.body.imageUrl, IMAGE, 'the photo itself survived');

    const guest = await queueCard(mod, reports.guest);
    assert.equal(guest.content_preserved, true);
    assert.equal(guest.content_excerpt, 'Rude Name');

    const text = await call('GET', `/api/admin/reports/${reports.card}/content`, { token: mod.token });
    assert.equal(text.status, 200, text.text);
    assert.match(text.body.text, /Venue card: Bad Place/);

    // A report a moderator already closed keeps nothing, as the story purge.
    const judged = await queueCard(mod, reports.judged);
    assert.equal(judged.content_missing, true);
    assert.equal(judged.content_preserved, false);
  });
}

test('a leave that does not empty the plan copies nothing, and the chat stays where it is', async () => {
  const people = {
    host: await mkUser('Host'), abuser: await mkUser('Abuser'), reporter: await mkUser('Reporter'),
  };
  // The host is not in the roster, so the abuser leaving is a member's leave,
  // and the reporter is still in: the plan stays.
  const { flockId, ids } = await reportedPlan({ ...people, roster: [people.abuser, people.reporter] });
  const res = await call('POST', `/api/flocks/${flockId}/leave`, { token: people.abuser.token });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.deleted, false);
  assert.deepEqual(await keptCopies(ids), [], 'a copy is only for a plan that is going');
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM messages WHERE flock_id = $1', [flockId]), 4);
});

test("the host's account deletion keeps other people's reported content from the plans it takes, and a copy still goes with its author", async () => {
  const people = {
    host: await mkUser('Host'), abuser: await mkUser('Abuser'), reporter: await mkUser('Reporter'),
  };
  const mod = await mkModerator();
  const { flockId, ids, reports } = await reportedPlan({
    ...people, roster: [people.host, people.abuser, people.reporter],
  });

  const del = await call('DELETE', '/api/users/me', { token: people.host.token, body: { password: PASSWORD } });
  assert.equal(del.status, 200, del.text);
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM flocks WHERE id = $1', [flockId]), 0);
  // The host's own photo goes with the host's account, as an account deletion
  // always takes its author's messages (MODERATION-LEGAL.md step 2). Somebody
  // else's reported words, and a guest's reported name, do not go with it.
  assert.deepEqual(await keptCopies(ids), [`flock_message:${ids.card}`, `guest_rsvp:${ids.guest}`].sort());
  assert.equal((await queueCard(mod, reports.card)).content_preserved, true);
  assert.equal((await queueCard(mod, reports.photo)).content_missing, true);

  // And the copy is the message's stand-in, not a way around its author's own
  // deletion: when the abuser deletes their account, the copy of their words
  // goes with it. The guest's name has no account behind it and stays.
  const gone = await call('DELETE', '/api/users/me', { token: people.abuser.token, body: { password: PASSWORD } });
  assert.equal(gone.status, 200, gone.text);
  assert.deepEqual(await keptCopies(ids), [`guest_rsvp:${ids.guest}`]);
});

test("a kept copy is not in its author's data export, so the export cannot tell them they were reported", async () => {
  // A copy exists only because a report about the message was open when its
  // plan was deleted. Handing it back to the author would tell them about a
  // report nobody had judged yet, so the privacy policy names it as an
  // exception to "the messages you sent" instead.
  const people = {
    host: await mkUser('Host'), abuser: await mkUser('Abuser'), reporter: await mkUser('Reporter'),
  };
  const { flockId, ids } = await reportedPlan({
    ...people, roster: [people.host, people.abuser, people.reporter],
  });
  assert.equal((await call('DELETE', `/api/flocks/${flockId}`, { token: people.host.token })).status, 200);
  // Both copies are held, which is what makes their absence below mean something.
  assert.deepEqual(await keptCopies(ids), [`flock_message:${ids.card}`, `flock_message:${ids.photo}`, `guest_rsvp:${ids.guest}`].sort());

  const exportOf = async (user) => {
    const res = await fetch(`${base}/api/users/export`, {
      headers: { Authorization: `Bearer ${user.token}`, 'X-Export-Password': PASSWORD },
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    return { body: JSON.parse(text), text };
  };

  // The abuser wrote the reported venue card; their file has no trace of it.
  const abuser = await exportOf(people.abuser);
  assert.ok(!abuser.text.includes('Bad Place'), "the reported card's copy reached its author's export");
  assert.ok(!abuser.text.includes('1 Main St'));
  assert.ok(!abuser.body.flock_messages.some((m) => m.id === ids.card));
  // The host's reported photo is the host's, and is not in the host's file either.
  const host = await exportOf(people.host);
  assert.ok(!host.body.flock_messages.some((m) => m.id === ids.photo), "the reported photo's copy reached its author's export");
  // Nor does a guest's kept name reach anybody's.
  for (const { text } of [abuser, host, await exportOf(people.reporter)]) {
    assert.ok(!text.includes('Rude Name'), "a guest's kept name reached an export");
  }
});

test('a copy goes once every report naming it has been closed for the retention period, and not before', async () => {
  const {
    purgeClosedReportEvidence, EVIDENCE_RETENTION_DAYS,
  } = require('../utils/reportEvidence');
  const people = {
    host: await mkUser('Host'), abuser: await mkUser('Abuser'), reporter: await mkUser('Reporter'),
  };
  const second = await mkUser('Witness');
  const mod = await mkModerator();
  const { flockId, ids, reports } = await reportedPlan({
    ...people, roster: [people.host, people.abuser, people.reporter, second],
  });
  // A second person reported the venue card too, so one close is not enough.
  const cardAgain = await report(second, people.abuser, 'flock_message', ids.card);

  assert.equal((await call('DELETE', `/api/flocks/${flockId}`, { token: people.host.token })).status, 200);
  assert.deepEqual(await keptCopies(ids), [
    `flock_message:${ids.card}`, `flock_message:${ids.photo}`, `guest_rsvp:${ids.guest}`,
  ].sort());

  // Closed through the console, which is what writes resolved_at, the clock.
  const close = async (reportId) => {
    const res = await call('PUT', `/api/admin/reports/${reportId}`, {
      token: mod.token, body: { action: 'dismiss' },
    });
    assert.equal(res.status, 200, res.text);
  };
  const closedAgo = (reportId, days) => pool.query(
    `UPDATE content_reports SET resolved_at = NOW() - ($2::int * INTERVAL '1 day') - INTERVAL '1 minute'
      WHERE id = $1`,
    [reportId, days]
  );

  // Just closed: still inside the period, so nothing goes.
  for (const id of [reports.photo, reports.guest, reports.card]) await close(id);
  await purgeClosedReportEvidence();
  assert.deepEqual(await keptCopies(ids), [
    `flock_message:${ids.card}`, `flock_message:${ids.photo}`, `guest_rsvp:${ids.guest}`,
  ].sort());

  // A day short of the period: still kept.
  await closedAgo(reports.photo, EVIDENCE_RETENTION_DAYS - 1);
  await purgeClosedReportEvidence();
  assert.ok((await keptCopies(ids)).includes(`flock_message:${ids.photo}`));

  // Past the period: the photo and the guest's name go, the guest's with no
  // account behind it whose deletion would ever have taken it. The card stays,
  // because another report about it is still open.
  await closedAgo(reports.photo, EVIDENCE_RETENTION_DAYS);
  await closedAgo(reports.guest, EVIDENCE_RETENTION_DAYS);
  await closedAgo(reports.card, EVIDENCE_RETENTION_DAYS);
  assert.equal(await purgeClosedReportEvidence(), 2);
  assert.deepEqual(await keptCopies(ids), [`flock_message:${ids.card}`]);

  // The last report closes: the period starts from that close, not the first.
  await close(cardAgain);
  await purgeClosedReportEvidence();
  assert.deepEqual(await keptCopies(ids), [`flock_message:${ids.card}`]);
  await closedAgo(cardAgain, EVIDENCE_RETENTION_DAYS);
  await purgeClosedReportEvidence();
  assert.deepEqual(await keptCopies(ids), [], 'a closed report leaves no copy behind');

  // And the console says the content is gone rather than showing a copy.
  const card = await queueCard(mod, reports.card);
  assert.equal(card.content_preserved, false);
  assert.equal(card.content_missing, true);

  // A copy no report names at all holds nothing either, and a batch of one
  // still deletes everything there is to delete.
  await pool.query(
    `INSERT INTO content_report_evidence (content_type, content_id, name)
     VALUES ('guest_rsvp', 2000000001, 'orphan'), ('guest_rsvp', 2000000002, 'orphan')`
  );
  assert.equal(await purgeClosedReportEvidence(1), 2);
  assert.equal(await count(
    'SELECT COUNT(*)::int AS n FROM content_report_evidence WHERE content_id IN (2000000001, 2000000002)'
  ), 0);
});

test('server.js runs the saved copy purge on a timer and clears it on shutdown', () => {
  // Anchored at the start of each line, so a commented-out line does not pass.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r/g, '');
  const { EVIDENCE_PURGE_INTERVAL_MS } = require('../utils/reportEvidence');
  assert.equal(EVIDENCE_PURGE_INTERVAL_MS, 60 * 60 * 1000, 'the privacy policy says the cleanup runs every hour');
  assert.match(src, /^let evidencePurgeInterval = null;$/m);
  assert.match(src, /^let evidencePurgeKickoff = null;$/m);
  assert.match(src, /^\s*const evidencePurge = \(\) => purgeClosedReportEvidence\(\)$/m);
  assert.match(src, /^\s*evidencePurgeInterval = setInterval\(evidencePurge, EVIDENCE_PURGE_INTERVAL_MS\);$/m);
  assert.match(src, /^\s*evidencePurgeKickoff = setTimeout\(evidencePurge, /m);
  const shutdown = src.slice(src.indexOf('function shutdown('));
  assert.match(shutdown, /^\s*if \(evidencePurgeInterval\) clearInterval\(evidencePurgeInterval\);$/m);
  assert.match(shutdown, /^\s*if \(evidencePurgeKickoff\) clearTimeout\(evidencePurgeKickoff\);$/m);
});

// ---------------------------------------------------------------------------
// 4. TWO ACCOUNT DELETIONS AND THE REPORTS BETWEEN THEM
// ---------------------------------------------------------------------------

const reportNames = async (ids) => (await pool.query(
  'SELECT id, reporter_id, reported_user_id FROM content_reports WHERE id = ANY($1) ORDER BY id', [ids]
)).rows;

test('two people who reported each other delete their accounts at once: both finish, and both reports are kept', async () => {
  const ana = await mkUser('Ana');
  const ben = await mkUser('Ben');
  const aboutBen = await report(ana, ben, 'profile', null);
  const aboutAna = await report(ben, ana, 'profile', null);

  // Ana's deletion takes her account row after the reports, so holding that
  // row stops it there with both reports in hand.
  const release = await holdRow('SELECT id FROM users WHERE id = $1 FOR UPDATE', [ana.id]);
  try {
    const first = call('DELETE', '/api/users/me', { token: ana.token, body: { password: PASSWORD } });
    const held = await waitForWaiter('the first deletion', (w) => /FROM users WHERE id = \$1 FOR UPDATE/.test(w.query));

    const second = call('DELETE', '/api/users/me', { token: ben.token, body: { password: PASSWORD } });
    const queued = await waitForWaiter('the second deletion', (w) => w.pid !== held.pid);
    // Where it waits is the fix: on the id-ordered lock, before it has
    // cleared a single report, so it holds nothing the first one needs.
    assert.equal(flat(queued.query), flat(ACCOUNT_REPORT_LOCKS_SQL));

    await release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200, `the first deletion: ${a.text}`);
    assert.equal(b.status, 200, `the second deletion: ${b.text}`);
  } finally {
    await release();
  }
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM users WHERE id = ANY($1)', [[ana.id, ben.id]]), 0);
  // Moderation records outlive both accounts, with neither name on them.
  assert.deepEqual(await reportNames([aboutBen, aboutAna]), [
    { id: aboutBen, reporter_id: null, reported_user_id: null },
    { id: aboutAna, reporter_id: null, reported_user_id: null },
  ]);
});

test('with the two report statements as they were, the same pair is a deadlock', async () => {
  // The de-attribution as it was: the reports this account filed, then the
  // reports about it, on the schedule two simultaneous deletions produce.
  const ana = await mkUser('Ana');
  const ben = await mkUser('Ben');
  await report(ana, ben, 'profile', null);
  await report(ben, ana, 'profile', null);
  const byAna = await pool.connect();
  const byBen = await pool.connect();
  try {
    await byAna.query('BEGIN');
    await byBen.query('BEGIN');
    await byAna.query('UPDATE content_reports SET reporter_id = NULL WHERE reporter_id = $1', [ana.id]);
    await byBen.query('UPDATE content_reports SET reporter_id = NULL WHERE reporter_id = $1', [ben.id]);
    const anaDone = byAna.query(
      'UPDATE content_reports SET reported_user_id = NULL WHERE reported_user_id = $1', [ana.id]
    ).then(() => null, (e) => e);
    await waitForWaiter("Ana's deletion", (w) => /reported_user_id = NULL/.test(w.query));
    const benDone = byBen.query(
      'UPDATE content_reports SET reported_user_id = NULL WHERE reported_user_id = $1', [ben.id]
    ).then(() => null, (e) => e);
    const failures = (await Promise.all([anaDone, benDone])).filter(Boolean);
    assert.deepEqual(failures.map((e) => e.code), ['40P01'], 'exactly one of the two is chosen as the deadlock victim');
  } finally {
    await byAna.query('ROLLBACK').catch(() => {});
    await byBen.query('ROLLBACK').catch(() => {});
    byAna.release();
    byBen.release();
  }
});

// The statement routes/moderation.js files a profile report with, as it runs it.
const fileReport = (reporter, about) => pool.query(
  `INSERT INTO content_reports (reporter_id, reported_user_id, content_type, content_id, reason, details)
   VALUES ($1, $2, 'profile', NULL, 'harassment', NULL)
   RETURNING id`,
  [reporter.id, about.id]
);

test('a report filed about an account while its deletion is under way is kept, with that name cleared', async () => {
  // content_reports.reported_user_id is ON DELETE CASCADE. The deletion
  // cleared the reports before it locked the account row, so a report that
  // committed between the two was cascaded away by the DELETE, and a moderator
  // never saw it. The key-share lock held here is the one a report's own
  // foreign key check takes, so it stops the deletion at the account row
  // without stopping the report.
  const leaving = await mkUser('Leaving');
  const reporter = await mkUser('Reporter');
  const release = await holdRow('SELECT id FROM users WHERE id = $1 FOR KEY SHARE', [leaving.id]);
  let filed;
  try {
    const deletion = call('DELETE', '/api/users/me', { token: leaving.token, body: { password: PASSWORD } });
    await waitForWaiter('the deletion', (w) => /FROM users WHERE id = \$1 FOR UPDATE/.test(w.query));

    // Filed and committed while the deletion is past the report lock and
    // waiting on the account row.
    filed = (await fileReport(reporter, leaving)).rows[0].id;

    await release();
    const res = await deletion;
    assert.equal(res.status, 200, res.text);
  } finally {
    await release();
  }
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM users WHERE id = $1', [leaving.id]), 0);
  assert.deepEqual(await reportNames([filed]), [{ id: filed, reporter_id: reporter.id, reported_user_id: null }],
    'the report filed during the deletion was cascaded away instead of kept');
});

test('a report filed after the deletion holds the account row waits for it, then fails because the account is gone', async () => {
  const host = await mkUser('Host');
  const leaving = await mkUser('Leaving');
  const reporter = await mkUser('Reporter');
  const flockId = await planWith(host, [leaving, host], []);
  // Stops the deletion inside its DELETE, whose cascade reaches this
  // membership row, long after it has taken the account row.
  const release = await holdRow(
    'SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 FOR UPDATE', [flockId, leaving.id]
  );
  try {
    const deletion = call('DELETE', '/api/users/me', { token: leaving.token, body: { password: PASSWORD } });
    const deleting = await waitForWaiter('the deletion', (w) => /DELETE FROM users/.test(w.query));

    const late = fileReport(reporter, leaving).then(() => null, (e) => e);
    await waitForWaiter('the report', (w) => w.pid !== deleting.pid && /INSERT INTO content_reports/.test(w.query));

    await release();
    const res = await deletion;
    assert.equal(res.status, 200, res.text);
    const err = await late;
    assert.ok(err, 'a report about an account that no longer exists was accepted');
    assert.equal(err.code, '23503', 'refused by the foreign key, not by anything that would hide a real fault');
  } finally {
    await release();
  }
  assert.equal(await count('SELECT COUNT(*)::int AS n FROM content_reports WHERE reporter_id = $1', [reporter.id]), 0);
});

test("a ban and the reported account's own deletion queue on the report, whichever starts first", async () => {
  const { MODERATION_REPORT_LOCKS_SQL } = require('../routes/admin').__test;

  // The deletion first. Stopped at the account row with every report naming it
  // in hand, so the ban has to wait on the report, holding nothing yet.
  {
    const mod = await mkModerator();
    const target = await mkUser('Target');
    const reporter = await mkUser('Reporter');
    const reportId = await report(reporter, target, 'profile', null);
    const release = await holdRow('SELECT id FROM users WHERE id = $1 FOR KEY SHARE', [target.id]);
    try {
      const deletion = call('DELETE', '/api/users/me', { token: target.token, body: { password: PASSWORD } });
      const deleting = await waitForWaiter('the deletion', (w) => /FROM users WHERE id = \$1 FOR UPDATE/.test(w.query));
      const ban = call('PUT', `/api/admin/reports/${reportId}`, { token: mod.token, body: { action: 'ban' } });
      const queued = await waitForWaiter('the ban', (w) => w.pid !== deleting.pid);
      assert.equal(flat(queued.query), flat(MODERATION_REPORT_LOCKS_SQL));

      await release();
      const [d, b] = await Promise.all([deletion, ban]);
      assert.equal(d.status, 200, `the deletion: ${d.text}`);
      assert.equal(b.status, 404, `the ban, on an account that is gone: ${b.text}`);
    } finally {
      await release();
    }
    assert.equal(await count('SELECT COUNT(*)::int AS n FROM users WHERE id = $1', [target.id]), 0);
    assert.deepEqual(await reportNames([reportId]), [{ id: reportId, reporter_id: reporter.id, reported_user_id: null }]);
  }

  // The ban first. Stopped at the account row with the report in hand, so the
  // deletion has to wait on its id-ordered report lock, holding nothing yet.
  {
    const mod = await mkModerator();
    const target = await mkUser('Target');
    const reporter = await mkUser('Reporter');
    const reportId = await report(reporter, target, 'profile', null);
    const release = await holdRow('SELECT id FROM users WHERE id = $1 FOR UPDATE', [target.id]);
    try {
      const ban = call('PUT', `/api/admin/reports/${reportId}`, { token: mod.token, body: { action: 'ban' } });
      const banning = await waitForWaiter('the ban', (w) => /UPDATE users SET is_banned = true/.test(w.query));
      const deletion = call('DELETE', '/api/users/me', { token: target.token, body: { password: PASSWORD } });
      const queued = await waitForWaiter('the deletion', (w) => w.pid !== banning.pid);
      assert.equal(flat(queued.query), flat(ACCOUNT_REPORT_LOCKS_SQL));

      await release();
      const [b, d] = await Promise.all([ban, deletion]);
      assert.equal(b.status, 200, `the ban: ${b.text}`);
      assert.equal(d.status, 200, `the deletion: ${d.text}`);
    } finally {
      await release();
    }
    assert.equal(await count('SELECT COUNT(*)::int AS n FROM users WHERE id = $1', [target.id]), 0);
    // The ban's record outlives the account it was about.
    assert.equal(await count(
      "SELECT COUNT(*)::int AS n FROM moderation_actions WHERE report_id = $1 AND action = 'user_banned'", [reportId]
    ), 1);
  }
});

test('with the ban taking the account row before the report, the same race is a deadlock', async () => {
  // The moderation transaction as it was: the account row, then the report,
  // against a deletion that holds the report and wants the account row.
  const target = await mkUser('Target');
  const reporter = await mkUser('Reporter');
  const reportId = await report(reporter, target, 'profile', null);
  const byMod = await pool.connect();
  const byDeletion = await pool.connect();
  try {
    await byMod.query('BEGIN');
    await byDeletion.query('BEGIN');
    await byMod.query('UPDATE users SET is_banned = true, banned_at = NOW() WHERE id = $1', [target.id]);
    await byDeletion.query(ACCOUNT_REPORT_LOCKS_SQL, [target.id]);
    const modDone = byMod.query(
      "UPDATE content_reports SET status = 'resolved' WHERE id = $1", [reportId]
    ).then(() => null, (e) => e);
    await waitForWaiter('the ban', (w) => /UPDATE content_reports SET status/.test(w.query));
    const deletionDone = byDeletion.query(
      'SELECT id FROM users WHERE id = $1 FOR UPDATE', [target.id]
    ).then(() => null, (e) => e);
    const failures = (await Promise.all([modDone, deletionDone])).filter(Boolean);
    assert.deepEqual(failures.map((e) => e.code), ['40P01'], 'exactly one of the two is chosen as the deadlock victim');
  } finally {
    await byMod.query('ROLLBACK').catch(() => {});
    await byDeletion.query('ROLLBACK').catch(() => {});
    byMod.release();
    byDeletion.release();
  }
});

test("a deletion clears only the account's own side of each report", async () => {
  const gone = await mkUser('Gone');
  const stays = await mkUser('Stays');
  const filed = await report(gone, stays, 'profile', null);
  const about = await report(stays, gone, 'profile', null);
  const res = await call('DELETE', '/api/users/me', { token: gone.token, body: { password: PASSWORD } });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(await reportNames([filed, about]), [
    { id: filed, reporter_id: null, reported_user_id: stays.id },
    { id: about, reporter_id: stays.id, reported_user_id: null },
  ]);
});
