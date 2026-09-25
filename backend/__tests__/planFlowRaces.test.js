'use strict';
// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE PLAN FLOW'S SHARED ROWS, AGAINST A REAL POSTGRES
// ---------------------------------------------------------------------------
//
// Four rules that only a database can prove, because each is about what a
// statement does to rows another writer is touching, or about which rows a
// join actually keeps:
//
//   1. OVERLAPPING COMPLETION SWEEPS. services/flockSweep.js picked its batch
//      in a subquery and wrote `WHERE id IN (subquery)` with nothing else, so
//      a row it waited on was never re-checked. A second pass turned a plan the
//      first had just completed into a cancelled one, and a host moving the
//      time out mid-pass had the plan closed anyway. Driven here with a real
//      second connection holding the row, the way the overlap happens.
//   2. A GUEST WHO BECOMES A MEMBER BRINGS ONE VOTE (utils/guestRsvp.js
//      carryGuestVote): the newer of the two picks, never both. The timestamp
//      comparison crosses a naive column and a zoned one, so it is run.
//   3. BOTH TALLIES COUNT THE SAME VOTERS: an accepted, unbanned member and an
//      'in' guest, on the link's page, on the app's tally and in momentum, so
//      the link and the app name the same leader.
//   4. AN INVITE ACCEPTED IN THE APP RETIRES THE SAME PERSON'S GUEST ROW, with
//      a real uuid[] and the membership its own transaction just wrote.
//
// The fixture suites pin the statements' text; this one runs them.

const test = require('node:test');
const assert = require('node:assert');
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
// the live database. Everything that touches the database is required lazily
// inside test.before() so it binds to this.
const PG_PORT = pickEmbeddedPgPort('planFlowRaces');
const DB_NAME = 'flock_plan_flow_races';
process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/${DB_NAME}`;
process.env.PGSSLMODE = 'disable';
process.env.JWT_SECRET = 'test-secret-for-plan-flow-races';
process.env.NODE_ENV = 'test';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

let pg;
let pool;
let dataDir;
let server;
let base;
let runFlockCompletionSweep;
let carryGuestVote;
let signUserToken;
let seq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function call(method, url, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(base + url, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function mkUser(name, { banned = false } = {}) {
  seq += 1;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password, name, email_verified, is_banned)
     VALUES ($1, 'x', $2, true, $3) RETURNING *`,
    [`u${seq}-${Date.now()}@planflow.test`, name, banned]
  );
  return { ...rows[0], token: signUserToken(rows[0]) };
}

// event_time is a naive TIMESTAMP holding the UTC wall clock.
async function mkFlock(creator, { status = 'planning', hoursFromNow = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO flocks (name, creator_id, event_time, status)
     VALUES ('Plan', $1,
             CASE WHEN $2::int IS NULL THEN NULL
                  ELSE (NOW() AT TIME ZONE 'UTC') + make_interval(hours => $2::int) END,
             $3)
     RETURNING id`,
    [creator.id, hoursFromNow, status]
  );
  await addMember(rows[0].id, creator, 'accepted');
  return rows[0].id;
}

async function addMember(flockId, user, status) {
  await pool.query(
    'INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, $3)',
    [flockId, user.id, status]
  );
}

// A member vote cast `minutesAgo` minutes ago (venue_votes.created_at is naive).
async function memberVote(flockId, user, venue, minutesAgo = 0) {
  await pool.query(
    `INSERT INTO venue_votes (flock_id, user_id, venue_name, created_at)
     VALUES ($1, $2, $3, (NOW() AT TIME ZONE 'UTC') - make_interval(mins => $4::int))`,
    [flockId, user.id, venue, minutesAgo]
  );
}

async function guestRow(flockId, name, status = 'in') {
  const { rows } = await pool.query(
    'INSERT INTO guest_rsvps (flock_id, name, status) VALUES ($1, $2, $3) RETURNING id, guest_token',
    [flockId, name, status]
  );
  return rows[0];
}

// A guest vote cast `minutesAgo` minutes ago (guest_votes.created_at is zoned).
async function guestVote(flockId, guest, venue, minutesAgo = 0) {
  await pool.query(
    `INSERT INTO guest_votes (flock_id, guest_rsvp_id, venue_name, created_at)
     VALUES ($1, $2, $3, NOW() - make_interval(mins => $4::int))`,
    [flockId, guest.id, venue, minutesAgo]
  );
}

const votesOf = async (flockId, user) => (await pool.query(
  'SELECT venue_name FROM venue_votes WHERE flock_id = $1 AND user_id = $2 ORDER BY venue_name',
  [flockId, user.id]
)).rows.map((r) => r.venue_name);

const statusOf = async (flockId) => (await pool.query('SELECT status FROM flocks WHERE id = $1', [flockId])).rows[0].status;

async function carry(flockId, user, guestIds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await carryGuestVote((q, p) => client.query(q, p), flockId, user.id, guestIds);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

test.before(async () => {
  dataDir = path.join(os.tmpdir(), 'flock-plan-flow-races-pg-' + Date.now());
  pg = createEmbeddedPostgres(EmbeddedPostgres, {
    suite: 'planFlowRaces', port: PG_PORT, databaseDir: dataDir,
  });
  await startEmbeddedPostgres(pg);
  await pg.createDatabase(DB_NAME);

  pool = require('../config/database');
  const { migrate } = require('../db/migrate');
  await migrate(pool);

  ({ signUserToken } = require('../middleware/auth'));
  ({ runFlockCompletionSweep } = require('../services/flockSweep'));
  ({ carryGuestVote } = require('../utils/guestRsvp'));

  const app = express();
  app.use(express.json());
  app.use('/api/flocks', require('../routes/flocks'));
  app.use('/api/guest', require('../routes/guest').router);
  app.use('/api/flocks', require('../routes/venues'));
  server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((r) => (server ? server.close(r) : r()));
  await pool?.end().catch(() => {});
  await pg?.stop().catch(() => {});
  try {
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (err) {
    console.warn('[planFlowRaces] could not remove %s: %s', dataDir, err.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Overlapping completion sweeps
// ═══════════════════════════════════════════════════════════════════════════

test('a second sweep pass cannot rewrite a plan the first pass completed as cancelled', async () => {
  const host = await mkUser('Host One');
  const flockId = await mkFlock(host, { status: 'confirmed', hoursFromNow: -20 });

  // The first pass, mid-flight on its own connection: it has claimed the row
  // and completed it, and has not committed yet.
  const first = await pool.connect();
  let second;
  try {
    await first.query('BEGIN');
    await first.query("UPDATE flocks SET status = 'completed', updated_at = NOW() WHERE id = $1", [flockId]);
    second = runFlockCompletionSweep();
    await sleep(400);
    await first.query('COMMIT');
    await second;
  } finally {
    first.release();
  }
  assert.strictEqual(await statusOf(flockId), 'completed',
    'the night happened; a stale second claim must not CASE it into cancelled');
});

test('a host moving the time out while a sweep runs keeps the plan open', async () => {
  const host = await mkUser('Host Two');
  const flockId = await mkFlock(host, { status: 'confirmed', hoursFromNow: -20 });

  const edit = await pool.connect();
  try {
    await edit.query('BEGIN');
    await edit.query(
      "UPDATE flocks SET event_time = (NOW() AT TIME ZONE 'UTC') + INTERVAL '2 days', updated_at = NOW() WHERE id = $1",
      [flockId]
    );
    const sweep = runFlockCompletionSweep();
    await sleep(400);
    await edit.query('COMMIT');
    await sweep;
  } finally {
    edit.release();
  }
  assert.strictEqual(await statusOf(flockId), 'confirmed',
    'the plan is now two days out; a pass that picked it from an older snapshot must leave it');
});

test('a plan nobody is touching still completes, and a planning one is still cancelled', async () => {
  const host = await mkUser('Host Three');
  const confirmed = await mkFlock(host, { status: 'confirmed', hoursFromNow: -20 });
  const planning = await mkFlock(host, { status: 'planning', hoursFromNow: -20 });
  await runFlockCompletionSweep();
  assert.strictEqual(await statusOf(confirmed), 'completed');
  assert.strictEqual(await statusOf(planning), 'cancelled');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. One person, one vote, when a guest becomes a member
// ═══════════════════════════════════════════════════════════════════════════

test('a newer guest pick replaces the member\'s older vote for another venue', async () => {
  const host = await mkUser('Host Four');
  const sam = await mkUser('Sam Four');
  const flockId = await mkFlock(host);
  await addMember(flockId, sam, 'accepted');
  await memberVote(flockId, sam, 'Old Place', 60);
  const g = await guestRow(flockId, 'Sam');
  await guestVote(flockId, g, 'New Place', 1);

  const out = await carry(flockId, sam, [g.id]);
  assert.deepStrictEqual(out, { venueName: 'New Place', moved: true });
  assert.deepStrictEqual(await votesOf(flockId, sam), ['New Place'], 'one vote, the newer one');
});

test('an older guest pick does not overwrite a vote the member cast since', async () => {
  const host = await mkUser('Host Five');
  const sam = await mkUser('Sam Five');
  const flockId = await mkFlock(host);
  await addMember(flockId, sam, 'accepted');
  const g = await guestRow(flockId, 'Sam');
  await guestVote(flockId, g, 'Link Pick', 90);
  await memberVote(flockId, sam, 'App Pick', 5);

  const out = await carry(flockId, sam, [g.id]);
  assert.deepStrictEqual(out, { venueName: 'Link Pick', moved: false });
  assert.deepStrictEqual(await votesOf(flockId, sam), ['App Pick']);
});

test('a guest pick fills an empty ballot, and the same venue is not doubled', async () => {
  const host = await mkUser('Host Six');
  const sam = await mkUser('Sam Six');
  const ada = await mkUser('Ada Six');
  const flockId = await mkFlock(host);
  await addMember(flockId, sam, 'accepted');
  await addMember(flockId, ada, 'accepted');
  const g1 = await guestRow(flockId, 'Sam');
  await guestVote(flockId, g1, 'Kome', 1);
  assert.deepStrictEqual(await carry(flockId, sam, [g1.id]), { venueName: 'Kome', moved: true });
  assert.deepStrictEqual(await votesOf(flockId, sam), ['Kome']);

  await memberVote(flockId, ada, 'Kome', 30);
  const g2 = await guestRow(flockId, 'Ada');
  await guestVote(flockId, g2, 'Kome', 1);
  assert.deepStrictEqual(await carry(flockId, ada, [g2.id]), { venueName: 'Kome', moved: true });
  assert.deepStrictEqual(await votesOf(flockId, ada), ['Kome'], 'already held: still one row');
});

test('a plan that is over takes no carried vote and keeps the one it had', async () => {
  const host = await mkUser('Host Seven');
  const sam = await mkUser('Sam Seven');
  const flockId = await mkFlock(host, { status: 'cancelled' });
  await addMember(flockId, sam, 'accepted');
  await memberVote(flockId, sam, 'Old Place', 60);
  const g = await guestRow(flockId, 'Sam');
  await guestVote(flockId, g, 'New Place', 1);

  const out = await carry(flockId, sam, [g.id]);
  // `closed` is what tells a join to take its hide back with it: a row hidden
  // while its vote could not be copied would drop that vote from the record.
  assert.deepStrictEqual(out, { venueName: 'New Place', moved: false, closed: true });
  assert.deepStrictEqual(await votesOf(flockId, sam), ['Old Place']);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The link, the app and momentum count the same voters
// ═══════════════════════════════════════════════════════════════════════════

test('the link, the app and momentum count the same voters and name the same leader', async () => {
  const ava = await mkUser('Ava Eight');
  const bo = await mkUser('Bo Eight');
  const cy = await mkUser('Cy Eight');
  const di = await mkUser('Di Eight', { banned: true });
  const flockId = await mkFlock(ava);
  await addMember(flockId, bo, 'accepted');
  await addMember(flockId, di, 'accepted');
  await memberVote(flockId, ava, 'Kome');
  await memberVote(flockId, bo, 'Kome');
  // Cy voted and then left (the leave route deletes the membership row and
  // nothing else); Di voted and was banned.
  await memberVote(flockId, cy, 'Ramen');
  await memberVote(flockId, di, 'Ramen');
  // Two guests who said they cannot come, and one who is coming.
  const out1 = await guestRow(flockId, 'Out One', 'out');
  const out2 = await guestRow(flockId, 'Out Two', 'out');
  const going = await guestRow(flockId, 'Going', 'in');
  await guestVote(flockId, out1, 'Ramen');
  await guestVote(flockId, out2, 'Ramen');
  await guestVote(flockId, going, 'Ramen');
  const token = `PlanFlowLink${flockId}abcdefgh`;
  await pool.query('INSERT INTO flock_invite_links (token, flock_id, created_by) VALUES ($1, $2, $3)', [token, flockId, ava.id]);

  const link = await call('GET', `/api/guest/${token}`);
  assert.strictEqual(link.status, 200, JSON.stringify(link.body));
  assert.deepStrictEqual(link.body.venues, [{ venue_name: 'Kome', votes: 2 }, { venue_name: 'Ramen', votes: 1 }],
    'two members for Kome; for Ramen only the guest who is going (the departed, the banned and the two who are out are not voters)');

  const app = await call('GET', `/api/flocks/${flockId}/votes`, { token: ava.token });
  assert.strictEqual(app.status, 200, JSON.stringify(app.body));
  assert.deepStrictEqual(app.body.votes.map((v) => [v.venue_name, v.vote_count, v.guest_count]),
    [['Kome', 2, 0], ['Ramen', 1, 1]], 'the app names the same leader, by the same counts');

  const detail = await call('GET', `/api/flocks/${flockId}`, { token: ava.token });
  assert.strictEqual(detail.status, 200, JSON.stringify(detail.body));
  assert.strictEqual(detail.body.momentum.uniqueVoters, 3, 'Ava, Bo and the one guest who is going');

  // And a guest who said out is refused rather than stored as a vote that
  // counts for nothing.
  const refused = await call('POST', `/api/guest/${token}/vote`, { body: { guestToken: out1.guest_token, venueName: 'Kome' } });
  assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
  assert.strictEqual(refused.body.code, 'NOT_IN');

  // The guest who was going says out: their vote leaves both tallies with
  // them, through the real RSVP edit (whose RETURNING now names the vote the
  // members must re-tally for).
  const flipped = await call('POST', `/api/guest/${token}/rsvp`, { body: { guestToken: going.guest_token, name: 'Going', status: 'out' } });
  assert.strictEqual(flipped.status, 200, JSON.stringify(flipped.body));
  const after = await call('GET', `/api/guest/${token}`);
  assert.deepStrictEqual(after.body.venues, [{ venue_name: 'Kome', votes: 2 }]);
  const appAfter = await call('GET', `/api/flocks/${flockId}/votes`, { token: ava.token });
  assert.deepStrictEqual(appAfter.body.votes.map((v) => [v.venue_name, v.vote_count]), [['Kome', 2]]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. An invite accepted in the app retires the guest row
// ═══════════════════════════════════════════════════════════════════════════

test('accepting the in-app invite retires this plan\'s guest row, carries its vote, and nothing else', async () => {
  const host = await mkUser('Host Nine');
  const uma = await mkUser('Uma Nine');
  const flockId = await mkFlock(host);
  const otherFlock = await mkFlock(host);
  await addMember(flockId, uma, 'invited');
  // Answered under the account's whole name: the only answer this door may
  // take as hers (utils/guestRsvp.js; planFlowLocks.test.js runs the rest).
  const here = await guestRow(flockId, 'Uma Nine');
  await guestVote(flockId, here, 'Kome', 1);
  const elsewhere = await guestRow(otherFlock, 'Uma Nine');

  const res = await call('POST', `/api/flocks/${flockId}/join`, {
    token: uma.token,
    body: { guestTokens: [here.guest_token.toUpperCase(), elsewhere.guest_token] },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.member.status, 'accepted');

  const hidden = async (id) => (await pool.query('SELECT is_hidden FROM guest_rsvps WHERE id = $1', [id])).rows[0].is_hidden;
  assert.strictEqual(await hidden(here.id), true, 'this plan\'s row is retired');
  assert.strictEqual(await hidden(elsewhere.id), false, 'another plan\'s row is not this accept\'s to touch');
  assert.deepStrictEqual(await votesOf(flockId, uma), ['Kome'], 'and the vote came with them');

  const detail = await call('GET', `/api/flocks/${flockId}`, { token: host.token });
  assert.strictEqual(detail.body.flock.going_count, 2, 'the host and Uma, not Uma twice');
  assert.strictEqual(detail.body.momentum.uniqueVoters, 1);
});

test('an accept the server refuses retires nothing', async () => {
  const host = await mkUser('Host Ten');
  const vic = await mkUser('Vic Ten');
  const flockId = await mkFlock(host, { status: 'cancelled' });
  await addMember(flockId, vic, 'invited');
  // Under the account's whole name, so the only thing refusing it is the
  // closed plan.
  const g = await guestRow(flockId, 'Vic Ten');

  const res = await call('POST', `/api/flocks/${flockId}/join`, { token: vic.token, body: { guestTokens: [g.guest_token] } });
  assert.strictEqual(res.status, 409, JSON.stringify(res.body));
  const row = (await pool.query('SELECT is_hidden FROM guest_rsvps WHERE id = $1', [g.id])).rows[0];
  assert.strictEqual(row.is_hidden, false);
});
