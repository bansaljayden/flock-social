'use strict';
// Run: node --test __tests__/planFlowLocks.test.js  (from backend/)
//
// ---------------------------------------------------------------------------
// THE PLAN FLOW'S JOINS, VOTES AND LEAVES, ON REAL LOCKS
// ---------------------------------------------------------------------------
//
// Five rules, each about what a statement does to rows or connections another
// writer is using, so each is run against a real migrated Postgres:
//
//   1. WHOSE GUEST ROW A JOIN MAY RETIRE. A guest identity proves only that a
//      device answered. The in-app accept retires a presented row only when it
//      carries the account's whole name; the link's own join only when its name
//      fits the account's (utils/guestRsvp.js has the rule and why). A
//      different Sam on a shared browser keeps their answer, their vote and
//      their budget answer.
//   2. A JOIN AND A VOTE FOR THE SAME PERSON QUEUE INSTEAD OF DEADLOCKING. The
//      joins locked the plan's row and then reached for the flockvote: lock; a
//      vote holds that lock and then needs the row's key share. One test runs
//      the old order on the same interleaving and shows the deadlock, so the
//      route tests passing means the lock order, not a lucky schedule.
//   3. A PLAN THAT CLOSES MID-JOIN KEEPS ITS GUEST ROWS AND THEIR VOTES, on both
//      of the link join's paths.
//   4. A LEAVE OR A PLAN DELETE ANNOUNCES ON THE CONNECTION IT HOLDS. With the
//      pool one connection from full, the fan-outs used to wait for a second
//      connection that never came, and the plan heard nothing.
//   5. AN UN-VOTE THAT FOUND NOTHING SAYS SO, even when the same person's vote
//      from another device lands right after it.
//
// The interleavings are made with locks held on connections of the test's own,
// never with timers: a test holds what a route needs next, waits until
// pg_stat_activity shows the route waiting on it, does the other writer's part,
// and only then lets go (the house style of flockTransactionIntegrity.test.js).
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
const PG_PORT = pickEmbeddedPgPort('planFlowLocks');
const DB_NAME = 'flock_plan_flow_locks';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
for (const k of ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGPORT']) delete process.env[k];
process.env.PGSSLMODE = 'disable';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-for-plan-flow-locks';
delete process.env.FIREBASE_SERVICE_ACCOUNT;
delete process.env.RESEND_API_KEY;

let pg;
let pool;
let dataDir;
let server;
let base;
let signUserToken;
let guestRsvp;
let seq = 0;

// Every socket event the routes send, by room. `sockets` is what the push
// helper reads to decide a recipient is offline.
const emits = [];
const io = {
  sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
  to(room) {
    const op = { except() { return op; }, emit(event, payload) { emits.push({ room, event, payload }); } };
    return op;
  },
  in() { return { socketsLeave() {}, disconnectSockets() {} }; },
  socketsLeave() {},
};

test.before(async () => {
  dataDir = path.join(os.tmpdir(), `flock-plan-flow-locks-pg-${Date.now()}`);
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'planFlowLocks', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);

  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  ({ signUserToken } = require('../middleware/auth'));
  guestRsvp = require('../utils/guestRsvp');

  const app = express();
  app.use(express.json());
  app.set('io', io);
  app.use('/api/flocks', require('../routes/flocks'));
  app.use('/api/guest', require('../routes/guest').router);
  app.use('/api/flocks', require('../routes/venues'));
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
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (err) {
    console.warn('[planFlowLocks] could not remove %s: %s', dataDir, err.message);
  }
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

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
    [`u${seq}-${Date.now()}@planflowlocks.test`, name]
  );
  return { ...rows[0], token: signUserToken(rows[0]) };
}

async function mkFlock(creator, { status = 'planning' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO flocks (name, creator_id, status, event_time)
     VALUES ('Plan', $1, $2, (NOW() AT TIME ZONE 'UTC') + INTERVAL '2 days') RETURNING id`,
    [creator.id, status]
  );
  await addMember(rows[0].id, creator, 'accepted');
  return rows[0].id;
}

async function addMember(flockId, user, status) {
  await pool.query('INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, $3)', [flockId, user.id, status]);
}

async function mkLink(flockId, creator) {
  seq += 1;
  const token = `PlanLocks${seq}x${flockId}abcdefgh`;
  await pool.query('INSERT INTO flock_invite_links (token, flock_id, created_by) VALUES ($1, $2, $3)', [token, flockId, creator.id]);
  return token;
}

async function guestRow(flockId, name, status = 'in') {
  const { rows } = await pool.query(
    'INSERT INTO guest_rsvps (flock_id, name, status) VALUES ($1, $2, $3) RETURNING id, guest_token',
    [flockId, name, status]
  );
  return rows[0];
}

async function guestVote(flockId, guest, venue, minutesAgo = 0) {
  await pool.query(
    `INSERT INTO guest_votes (flock_id, guest_rsvp_id, venue_name, created_at)
     VALUES ($1, $2, $3, NOW() - make_interval(mins => $4::int))`,
    [flockId, guest.id, venue, minutesAgo]
  );
}

async function memberVote(flockId, user, venue) {
  const { rows } = await pool.query(
    'INSERT INTO venue_votes (flock_id, user_id, venue_name) VALUES ($1, $2, $3) RETURNING id',
    [flockId, user.id, venue]
  );
  return rows[0].id;
}

const hidden = async (guest) => (await pool.query('SELECT is_hidden FROM guest_rsvps WHERE id = $1', [guest.id])).rows[0].is_hidden;
const guestVotesOf = async (guest) => (await pool.query(
  'SELECT venue_name FROM guest_votes WHERE guest_rsvp_id = $1 ORDER BY venue_name', [guest.id]
)).rows.map((r) => r.venue_name);
const votesOf = async (flockId, user) => (await pool.query(
  'SELECT venue_name FROM venue_votes WHERE flock_id = $1 AND user_id = $2 ORDER BY venue_name', [flockId, user.id]
)).rows.map((r) => r.venue_name);
const memberStatus = async (flockId, user) => {
  const { rows } = await pool.query('SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2', [flockId, user.id]);
  return rows[0] ? rows[0].status : null;
};

// The backends in this database that are waiting on a lock right now.
async function lockWaiters() {
  const { rows } = await pool.query(
    `SELECT pid, query, wait_event FROM pg_stat_activity
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

// A connection of the test's own, inside a transaction, released exactly once.
async function holder() {
  const client = await pool.connect();
  await client.query('BEGIN');
  let done = false;
  const end = async (how = 'ROLLBACK') => {
    if (done) return;
    done = true;
    await client.query(how).catch(() => {});
    client.release();
  };
  return { client, end };
}

const VOTE_LOCK = "SELECT pg_advisory_xact_lock(hashtext('flockvote:' || $1::text || ':' || $2::text))";
const isVoteLockWait = (w) => w.wait_event === 'advisory' && /flockvote:/.test(w.query);

// Nothing checked out of the pool, so a test that counts connections starts
// from zero rather than from whatever a previous route's post-response work
// is still doing.
async function quiesce() {
  const deadline = Date.now() + 10000;
  while (pool.totalCount !== pool.idleCount || pool.waitingCount > 0) {
    if (Date.now() > deadline) throw new Error('the pool never went idle');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Whose guest row a join may retire
// ═══════════════════════════════════════════════════════════════════════════

// The two statements, run directly: one plan, one account, one guest row per
// case, rolled back after. `retires` is whether the statement took the row.
async function retires(sql, { account, guest, asArray, planStatus = 'planning', memberAs = 'accepted' }) {
  const host = await mkUser('Rule Host');
  const user = await mkUser(account);
  const flockId = await mkFlock(host, { status: planStatus });
  await addMember(flockId, user, memberAs);
  const g = await guestRow(flockId, guest);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(sql, [flockId, asArray ? [g.guest_token] : g.guest_token, user.id]);
    return r.rows.length === 1;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

test('the in-app accept retires only a row under the account\'s whole name, and only a name that says which person', async () => {
  const sql = guestRsvp.RETIRE_ON_INVITE_ACCEPT_SQL;
  const cases = [
    // [account, guest name, retired?]
    ['Sam Rivera', 'Sam Rivera', true],
    ['Sam Rivera', '  sam   RIVERA ', true],
    ['Sam Rivera', 'Sam', false],          // another Sam on this browser could have typed it
    ['Sam Rivera', 'Sam R', false],        // so could Sam Rodriguez
    ['Sam Rivera', 'Sam Smith', false],
    ['Sam Rivera', 'Maya', false],
    ['Sam Rivera', 'Sam Rivera Jr', false],
    ['Sam', 'Sam', false],                 // a one-word account name cannot say which Sam
  ];
  for (const [account, guest, expected] of cases) {
    assert.equal(await retires(sql, { account, guest, asArray: true }), expected, `${account} presenting "${guest}"`);
  }
  // And never on a plan that is over, or for somebody who is not in it.
  assert.equal(await retires(sql, { account: 'Sam Rivera', guest: 'Sam Rivera', asArray: true, planStatus: 'cancelled' }), false);
  assert.equal(await retires(sql, { account: 'Sam Rivera', guest: 'Sam Rivera', asArray: true, memberAs: 'invited' }), false);
});

test('the link\'s own join retires a row whose name fits the account and refuses one that is somebody else\'s', async () => {
  const sql = guestRsvp.RETIRE_ON_LINK_JOIN_SQL;
  const cases = [
    ['Sam Rivera', 'Sam', true],           // the page asks for a first name
    ['Sam Rivera', '  SAM ', true],
    ['Sam Rivera', 'Sam R', true],         // the page suggests a last initial when a name is taken
    ['Sam Rivera', 'Sam Riv', true],
    ['Sam Rivera', 'sam   rivera', true],
    ['Sam Rivera', 'Sam S', false],
    ['Sam Rivera', 'Sam Smith', false],
    ['Sam Rivera', 'Maya', false],
    ['Sam Rivera', 'Samantha', false],
    ['Sam Rivera', 'Sa', false],
    ['Sam Rivera', 'Rivera', false],
    ['Sam Rivera', 'Sam Rivera Jr', false],
    ['Sam', 'Sam', true],
    ['Sam', 'Sam R', false],
    ['Mary Ann Lee', 'Mary', true],
    ['Mary Ann Lee', 'Mary Ann', true],
    ['Mary Ann Lee', 'Mary A', true],
    ['Mary Ann Lee', 'Mary L', false],     // a miss, never somebody else's row
  ];
  for (const [account, guest, expected] of cases) {
    assert.equal(await retires(sql, { account, guest, asArray: false }), expected, `${account} presenting "${guest}"`);
  }
  assert.equal(await retires(sql, { account: 'Sam Rivera', guest: 'Sam', planStatus: 'completed' }), false);
  assert.equal(await retires(sql, { account: 'Sam Rivera', guest: 'Sam', memberAs: 'declined' }), false);
});

test('a different Sam accepting in the app on a shared browser leaves the first Sam\'s answer, vote and place alone', async () => {
  const host = await mkUser('Host Shared');
  const samJones = await mkUser('Sam Jones');
  const flockId = await mkFlock(host);
  await addMember(flockId, samJones, 'invited');
  // Everything this browser answered: another Sam's first-name answer and
  // full-name answer, and Sam Jones's own.
  const otherSam = await guestRow(flockId, 'Sam');
  await guestVote(flockId, otherSam, 'Their Pick', 5);
  const samSmith = await guestRow(flockId, 'Sam Smith');
  const own = await guestRow(flockId, 'Sam Jones');
  await guestVote(flockId, own, 'My Pick', 1);

  const res = await call('POST', `/api/flocks/${flockId}/join`, {
    token: samJones.token,
    body: { guestTokens: [otherSam.guest_token, samSmith.guest_token, own.guest_token] },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(await hidden(own), true, 'his own answer is retired');
  assert.equal(await hidden(otherSam), false, 'the other Sam keeps their answer');
  assert.equal(await hidden(samSmith), false);
  assert.deepEqual(await votesOf(flockId, samJones), ['My Pick'], 'only his own vote came across');
  assert.deepEqual(await guestVotesOf(otherSam), ['Their Pick'], 'and theirs was not taken');

  const tally = await call('GET', `/api/flocks/${flockId}/votes`, { token: host.token });
  assert.deepEqual(
    tally.body.votes.map((v) => [v.venue_name, v.guest_count]).sort(),
    [['My Pick', 0], ['Their Pick', 1]],
    'the other Sam\'s vote is still on the tally, as a guest vote'
  );
});

test('the link join keeps somebody else\'s answer on this device, and retires the joiner\'s own', async () => {
  const host = await mkUser('Host Link');
  const sam = await mkUser('Sam Rivera');
  const flockId = await mkFlock(host);
  const link = await mkLink(flockId, host);
  // A shared laptop: Maya answered on it, then Sam answered on it.
  const maya = await guestRow(flockId, 'Maya');
  await guestVote(flockId, maya, 'Maya Pick', 5);
  const samRow = await guestRow(flockId, 'Sam');
  await guestVote(flockId, samRow, 'Sam Pick', 2);

  // The page's stored identity was Maya's when Sam tapped Join.
  const first = await call('POST', `/api/guest/${link}/join`, { token: sam.token, body: { guestToken: maya.guest_token } });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.joined, true, 'the join is the point, and it lands');
  assert.equal(await hidden(maya), false, 'Maya\'s answer is not his to retire');
  assert.deepEqual(await votesOf(flockId, sam), [], 'nor her vote his to take');

  // His own answer, presented on a re-tap (the already-in path).
  const second = await call('POST', `/api/guest/${link}/join`, { token: sam.token, body: { guestToken: samRow.guest_token } });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.body.joined, false);
  assert.equal(await hidden(samRow), true);
  assert.deepEqual(await votesOf(flockId, sam), ['Sam Pick']);
  assert.deepEqual(await guestVotesOf(maya), ['Maya Pick']);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. A join and a vote for the same person queue instead of deadlocking
// ═══════════════════════════════════════════════════════════════════════════

test('in the old order, a join holding the plan\'s row and a vote holding flockvote: deadlock', async () => {
  const host = await mkUser('Host Old');
  const uma = await mkUser('Uma Old');
  const flockId = await mkFlock(host);
  await addMember(flockId, uma, 'accepted');
  const join = await holder();
  const vote = await holder();
  try {
    await join.client.query('SELECT id FROM flocks WHERE id = $1 FOR UPDATE', [flockId]);
    await vote.client.query(VOTE_LOCK, [String(flockId), String(uma.id)]);
    const joinDone = join.client.query(VOTE_LOCK, [String(flockId), String(uma.id)]).then(() => null, (e) => e);
    await waitForWaiter('the old join', isVoteLockWait);
    const voteDone = vote.client.query(
      'INSERT INTO venue_votes (flock_id, user_id, venue_name) VALUES ($1, $2, $3)', [flockId, uma.id, 'Kome']
    ).then(() => null, (e) => e);
    const failures = (await Promise.all([joinDone, voteDone])).filter(Boolean);
    assert.deepEqual(failures.map((e) => e.code), ['40P01'], 'exactly one of the two is the deadlock victim');
  } finally {
    await join.end();
    await vote.end();
  }
});

test('an in-app accept carrying a guest vote and a vote from the same person\'s phone both finish', async () => {
  const host = await mkUser('Host Accept');
  const uma = await mkUser('Uma Accept');
  const flockId = await mkFlock(host);
  await addMember(flockId, uma, 'invited');
  const g = await guestRow(flockId, 'Uma Accept');
  await guestVote(flockId, g, 'Link Pick', 1);

  // Her vote is mid-flight: it holds flockvote: and has not written yet.
  const vote = await holder();
  try {
    await vote.client.query(VOTE_LOCK, [String(flockId), String(uma.id)]);
    const accept = call('POST', `/api/flocks/${flockId}/join`, { token: uma.token, body: { guestTokens: [g.guest_token] } });
    await waitForWaiter('the accept', isVoteLockWait);
    // The accept queued on the vote's lock before it took the plan's row, so
    // the vote's write, whose foreign key needs a key share on that row,
    // goes straight through instead of closing a cycle.
    await vote.client.query(
      'INSERT INTO venue_votes (flock_id, user_id, venue_name) VALUES ($1, $2, $3)', [flockId, uma.id, 'App Pick']
    );
    await vote.end('COMMIT');
    const res = await accept;
    assert.equal(res.status, 200, res.text);
  } finally {
    await vote.end();
  }
  assert.equal(await memberStatus(flockId, uma), 'accepted');
  assert.equal(await hidden(g), true);
  assert.deepEqual(await votesOf(flockId, uma), ['App Pick'], 'one vote: the newer one, cast in the app');
});

test('a link join carrying a guest vote and a vote for the same person both finish', async () => {
  const host = await mkUser('Host LinkVote');
  const uma = await mkUser('Uma Rivera');
  const flockId = await mkFlock(host);
  const link = await mkLink(flockId, host);
  const g = await guestRow(flockId, 'Uma');
  await guestVote(flockId, g, 'Link Pick', 1);

  const vote = await holder();
  try {
    await vote.client.query(VOTE_LOCK, [String(flockId), String(uma.id)]);
    const join = call('POST', `/api/guest/${link}/join`, { token: uma.token, body: { guestToken: g.guest_token } });
    await waitForWaiter('the link join', isVoteLockWait);
    await vote.client.query(
      'INSERT INTO venue_votes (flock_id, user_id, venue_name) VALUES ($1, $2, $3)', [flockId, uma.id, 'App Pick']
    );
    await vote.end('COMMIT');
    const res = await join;
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.joined, true);
  } finally {
    await vote.end();
  }
  assert.equal(await hidden(g), true);
  assert.deepEqual(await votesOf(flockId, uma), ['App Pick']);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. A plan that closes mid-join keeps its guest rows and their votes
// ═══════════════════════════════════════════════════════════════════════════

test('already in: a plan cancelled before the retire keeps the guest row and its vote', async () => {
  const host = await mkUser('Host Closed A');
  const sam = await mkUser('Sam Closed');
  const flockId = await mkFlock(host);
  const link = await mkLink(flockId, host);
  await addMember(flockId, sam, 'accepted');
  const g = await guestRow(flockId, 'Sam');
  await guestVote(flockId, g, 'Link Pick', 1);

  // The route passes flockIsOver on an open plan and queues on flockvote:,
  // and the plan is cancelled while it waits.
  const hold = await holder();
  try {
    await hold.client.query(VOTE_LOCK, [String(flockId), String(sam.id)]);
    const join = call('POST', `/api/guest/${link}/join`, { token: sam.token, body: { guestToken: g.guest_token } });
    await waitForWaiter('the retire', isVoteLockWait);
    await pool.query("UPDATE flocks SET status = 'cancelled' WHERE id = $1", [flockId]);
    await hold.end();
    const res = await join;
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.joined, false);
  } finally {
    await hold.end();
  }
  assert.equal(await hidden(g), false, 'the row stays on the record of a plan that is over');
  assert.deepEqual(await guestVotesOf(g), ['Link Pick']);
  assert.deepEqual(await votesOf(flockId, sam), []);
});

test('already in: a plan cancelled between the retire and the vote copy takes the retire back', async () => {
  const host = await mkUser('Host Closed B');
  const sam = await mkUser('Sam Between');
  const flockId = await mkFlock(host);
  const link = await mkLink(flockId, host);
  await addMember(flockId, sam, 'accepted');
  const g = await guestRow(flockId, 'Sam');
  await guestVote(flockId, g, 'Link Pick', 1);

  // The carry reads guest_votes right after the hide, so holding that table
  // stops the route with the row already hidden and the vote not yet copied.
  const hold = await holder();
  try {
    await hold.client.query('LOCK TABLE guest_votes IN ACCESS EXCLUSIVE MODE');
    const join = call('POST', `/api/guest/${link}/join`, { token: sam.token, body: { guestToken: g.guest_token } });
    await waitForWaiter('the vote copy', (w) => /FROM guest_votes gv/.test(w.query));
    await pool.query("UPDATE flocks SET status = 'cancelled' WHERE id = $1", [flockId]);
    await hold.end();
    const res = await join;
    assert.equal(res.status, 200, res.text);
  } finally {
    await hold.end();
  }
  assert.equal(await hidden(g), false, 'the copy was refused, so the hide went back with it');
  assert.deepEqual(await guestVotesOf(g), ['Link Pick']);
  assert.deepEqual(await votesOf(flockId, sam), []);
});

test('new member: a plan cancelled while the join waits for its row is refused, and nothing moves', async () => {
  const host = await mkUser('Host Closed C');
  const sam = await mkUser('Sam Newcomer');
  const flockId = await mkFlock(host);
  const link = await mkLink(flockId, host);
  const g = await guestRow(flockId, 'Sam');
  await guestVote(flockId, g, 'Link Pick', 1);

  const hold = await holder();
  try {
    await hold.client.query('SELECT id FROM flocks WHERE id = $1 FOR UPDATE', [flockId]);
    const join = call('POST', `/api/guest/${link}/join`, { token: sam.token, body: { guestToken: g.guest_token } });
    await waitForWaiter('the link join', (w) => /FROM flocks WHERE id = \$1 FOR UPDATE/.test(w.query));
    await hold.client.query("UPDATE flocks SET status = 'cancelled' WHERE id = $1", [flockId]);
    await hold.end('COMMIT');
    const res = await join;
    assert.equal(res.status, 409, res.text);
  } finally {
    await hold.end();
  }
  assert.equal(await memberStatus(flockId, sam), null, 'no member seated on a cancelled plan');
  assert.equal(await hidden(g), false);
  assert.deepEqual(await guestVotesOf(g), ['Link Pick']);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. A leave or a plan delete announces on the connection it holds
// ═══════════════════════════════════════════════════════════════════════════

// Nineteen other requests hold a connection each, so the route gets the last
// one. Its fan-outs used to ask the pool for a second connection while the
// first held the plan's row lock, and waited for one that never came.
const DEPARTURES = [
  ['a member leaves', async ({ flockId, leaver }) => call('POST', `/api/flocks/${flockId}/leave`, { token: leaver.token }),
    (ctx) => ({ event: 'flock_member_left', rooms: [ctx.host.id, ctx.stay.id] }),
    (ctx) => ({ event: 'member_stopped_sharing', rooms: [ctx.host.id, ctx.stay.id] })],
  ['the host deletes the plan', async ({ flockId, host }) => call('DELETE', `/api/flocks/${flockId}`, { token: host.token }),
    (ctx) => ({ event: 'flock_deleted', rooms: [ctx.leaver.id, ctx.stay.id, ctx.invitee.id] })],
  ['the host leaves the plan', async ({ flockId, host }) => call('POST', `/api/flocks/${flockId}/leave`, { token: host.token }),
    (ctx) => ({ event: 'flock_deleted', rooms: [ctx.leaver.id, ctx.stay.id, ctx.invitee.id] })],
];

for (const [door, act, ...expectations] of DEPARTURES) {
  test(`${door} with the pool one connection from full: it finishes and the plan hears it`, async () => {
    const host = await mkUser('Host Pool');
    const leaver = await mkUser('Ada Pool');
    const stay = await mkUser('Bo Pool');
    const invitee = await mkUser('Cy Pool');
    const flockId = await mkFlock(host);
    await addMember(flockId, leaver, 'accepted');
    await addMember(flockId, stay, 'accepted');
    await addMember(flockId, invitee, 'invited');
    const ctx = { flockId, host, leaver, stay, invitee };

    await quiesce();
    const savedTimeout = pool.options.connectionTimeoutMillis;
    pool.options.connectionTimeoutMillis = 1500;
    const held = [];
    let res;
    try {
      while (held.length < pool.options.max - 1) held.push(await pool.connect());
      emits.length = 0;
      res = await act(ctx);
    } finally {
      for (const c of held) c.release();
      pool.options.connectionTimeoutMillis = savedTimeout;
    }
    assert.equal(res.status, 200, res.text);
    for (const expect of expectations) {
      const { event, rooms } = expect(ctx);
      assert.deepEqual(
        emits.filter((e) => e.event === event).map((e) => e.room).sort(),
        rooms.map((id) => `user:${id}`).sort(),
        `${event} reached everyone it should`
      );
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. An un-vote that found nothing says so
// ═══════════════════════════════════════════════════════════════════════════

test('an un-vote that removed nothing answers 200 even when the same person\'s vote lands right after it', async () => {
  const host = await mkUser('Host Unvote');
  const ava = await mkUser('Ava Unvote');
  const flockId = await mkFlock(host);
  await addMember(flockId, ava, 'accepted');
  const voteId = await memberVote(flockId, ava, 'Old Place');

  // A: a transaction holding her vote row, so the route's DELETE waits on it
  // with the plan's table already open. B: a lock on the plans table queued
  // behind the route, which it is granted the moment the route commits. B
  // then casts the vote from her other device, the way the vote routes do.
  const a = await holder();
  const b = await holder();
  try {
    await a.client.query('DELETE FROM venue_votes WHERE id = $1', [voteId]);
    const unvote = call('DELETE', `/api/flocks/${flockId}/vote`, { token: ava.token });
    await waitForWaiter('the un-vote', (w) => /DELETE FROM venue_votes/.test(w.query));
    const locked = b.client.query('LOCK TABLE flocks IN ACCESS EXCLUSIVE MODE');
    await waitForWaiter('the table lock', (w) => /LOCK TABLE flocks/.test(w.query));
    await a.end('COMMIT');
    await locked;
    await b.client.query(VOTE_LOCK, [String(flockId), String(ava.id)]);
    await b.client.query(
      'INSERT INTO venue_votes (flock_id, user_id, venue_name) VALUES ($1, $2, $3)', [flockId, ava.id, 'New Place']
    );
    await b.end('COMMIT');
    const res = await unvote;
    assert.equal(res.status, 200, `nothing was there to take back, and a 409 invites a retry that deletes the new vote: ${res.text}`);
    assert.equal(res.body.removed, 0);
  } finally {
    await a.end();
    await b.end();
  }
  assert.deepEqual(await votesOf(flockId, ava), ['New Place'], 'the vote from her other device stands');
});
