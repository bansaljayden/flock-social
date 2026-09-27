'use strict';
// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE PLAN FLOW'S SHARED ROWS, AGAINST A REAL POSTGRES
// ---------------------------------------------------------------------------
//
// Rules that only a database can prove, because each is about what a
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
//   5. A BLOCKED PAIR DOES NOT BECOME CO-MEMBERS through a third member's
//      invite: the accept asks the whole accepted roster, both directions.
//      Nor through the two doors at once: the accept and the share link's
//      join both ask under the plan's row lock, forced here into both orders.
//   6. A PLAN CREATED FOR A PAST TIME COUNTS AS HAPPENING WHEN IT WAS MADE,
//      so the reliability tally cannot be farmed one past slot per create.
//   7. A NEW VENUE REPLACES THE OLD ONE WHOLE: no coordinate, photo, rating
//      or place id of the old venue survives a PUT that names another, or
//      the socket's select_venue.
//   8. THE SHARED LINK FOLLOWS THE PLAN TO ITS NEW TIME, and a reschedule
//      never revives a link that was revoked or had already lapsed.
//   9. A GUEST ANSWER RETIRED ON A JOIN IS NOT A TAKEDOWN: its name stays
//      free on the plan, and its own page is told the person joined.
//  10. THE HOST HEARS ONCE WHEN EVERYONE ELSE HAS VOTED (routes/venues.js
//      notifyHostVotesIn). "Once" is an UPDATE that claims
//      flocks.votes_in_pushed_at only while it is NULL, so it is run here,
//      with two last votes fired together, rather than trusted.
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

// ═══════════════════════════════════════════════════════════════════════════
// 5. A blocked pair does not become co-members through a third member's invite
// ═══════════════════════════════════════════════════════════════════════════
//
// The invite checks a block only between the inviter and the invitee, so a
// member could invite somebody the host had blocked, and the in-app accept
// seated them while every roster read hid each from the other. Run on the real
// invite route and the real accept, so the roster the refusal reads is the one
// the accept would have written into.

async function block(blocker, blocked) {
  await pool.query('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)', [blocker.id, blocked.id]);
}

const memberStatus = async (flockId, user) => (await pool.query(
  'SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2', [flockId, user.id]
)).rows[0]?.status;

test('somebody the host blocked cannot accept a plan another member invited them to', async () => {
  const alice = await mkUser('Alice Eleven');
  const carol = await mkUser('Carol Eleven');
  const bob = await mkUser('Bob Eleven');
  const flockId = await mkFlock(alice, { hoursFromNow: 24 });
  await addMember(flockId, carol, 'accepted');
  await block(alice, bob);

  const invite = await call('POST', `/api/flocks/${flockId}/invite`, { token: carol.token, body: { user_ids: [bob.id] } });
  assert.ok(invite.status < 300, JSON.stringify(invite.body));
  assert.strictEqual(await memberStatus(flockId, bob), 'invited', 'the invite itself is Carol\'s and lands');

  const res = await call('POST', `/api/flocks/${flockId}/join`, { token: bob.token });
  assert.strictEqual(res.status, 403, JSON.stringify(res.body));
  assert.strictEqual(res.body.error, 'You cannot join this plan.', 'the link door\'s sentence, naming nobody');
  assert.doesNotMatch(JSON.stringify(res.body), /Alice/);
  assert.strictEqual(await memberStatus(flockId, bob), 'invited', 'nothing was written');
});

test('the refusal holds the other way round, and against any member, not only the host', async () => {
  const host = await mkUser('Host Twelve');
  const dana = await mkUser('Dana Twelve');
  const eli = await mkUser('Eli Twelve');
  const flockId = await mkFlock(host, { hoursFromNow: 24 });
  await addMember(flockId, dana, 'accepted');
  await addMember(flockId, eli, 'invited');
  // The joiner is the one who pressed block, on a member who is not the host.
  await block(eli, dana);

  const res = await call('POST', `/api/flocks/${flockId}/join`, { token: eli.token });
  assert.strictEqual(res.status, 403, JSON.stringify(res.body));
  assert.strictEqual(await memberStatus(flockId, eli), 'invited');
});

test('a member already in is not turned out by a block made since, and a plan with no block still seats', async () => {
  const host = await mkUser('Host Thirteen');
  const fay = await mkUser('Fay Thirteen');
  const gus = await mkUser('Gus Thirteen');
  const flockId = await mkFlock(host, { hoursFromNow: 24 });
  await addMember(flockId, fay, 'accepted');
  await addMember(flockId, gus, 'invited');

  const seated = await call('POST', `/api/flocks/${flockId}/join`, { token: gus.token });
  assert.strictEqual(seated.status, 200, JSON.stringify(seated.body));
  assert.strictEqual(await memberStatus(flockId, gus), 'accepted');

  // Two people already in who then block each other stay where they were, as
  // on the link: a re-tap of the plan is not a new membership.
  await block(fay, gus);
  const again = await call('POST', `/api/flocks/${flockId}/join`, { token: gus.token });
  assert.strictEqual(again.status, 200, JSON.stringify(again.body));
  assert.strictEqual(await memberStatus(flockId, gus), 'accepted');
});

// How many requests are queued behind a lock right now. Both doors wait on
// the plan's row the same way, so this is how a test knows each one has got
// as far as the lock before the holder lets go.
async function waitForLockWaiters(n) {
  for (let i = 0; i < 200; i += 1) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`
    );
    if (rows[0].n >= n) return;
    await sleep(25);
  }
  throw new Error(`fewer than ${n} requests ever waited on the plan's row`);
}

test('a blocked pair joining through the two doors at once cannot both be seated', async () => {
  // Alice holds an in-app invite and Bob holds the share link, and Alice has
  // blocked him. The link door used to ask the roster on the pool before its
  // transaction: Bob read no Alice (she was still only invited), Alice's
  // accept took the row, read no Bob and committed, and Bob's join then
  // seated him beside her. Both doors ask under the row lock now, so the
  // second to commit reads the first one's member. The interleaving is
  // forced: the row is held while both requests queue on it, Alice first.
  const host = await mkUser('Host TwentyFour');
  const alice = await mkUser('Alice TwentyFour');
  const bob = await mkUser('Bob TwentyFour');
  const flockId = await mkFlock(host, { hoursFromNow: 24 });
  await addMember(flockId, alice, 'invited');
  await block(alice, bob);
  const link = await mkLinkRow(flockId, host, { revoked: false, expiresInDays: 10 });

  const holder = await pool.connect();
  let accept;
  let walkIn;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM flocks WHERE id = $1 FOR UPDATE', [flockId]);
    accept = call('POST', `/api/flocks/${flockId}/join`, { token: alice.token });
    await waitForLockWaiters(1);
    walkIn = call('POST', `/api/guest/${link}/join`, { token: bob.token });
    await waitForLockWaiters(2);
    await holder.query('COMMIT');
  } finally {
    holder.release();
  }
  const [a, b] = await Promise.all([accept, walkIn]);

  assert.strictEqual(a.status, 200, JSON.stringify(a.body));
  assert.strictEqual(await memberStatus(flockId, alice), 'accepted', 'Alice took the row first and is in');
  assert.strictEqual(b.status, 403, JSON.stringify(b.body));
  assert.deepStrictEqual(b.body, { error: 'You cannot join this plan.', code: 'CANNOT_JOIN' },
    'the link door reads her under the lock, and says it the way the accept does');
  assert.strictEqual(await memberStatus(flockId, bob), undefined, 'and nothing was written for Bob');
});

test('the accept is refused the same way when the walk-in commits first', async () => {
  // The other order: Bob's link join takes the row first and is seated, and
  // Alice's accept, queued behind it, reads him and is refused with the
  // code the app takes the invite card away on.
  const host = await mkUser('Host TwentyFive');
  const alice = await mkUser('Alice TwentyFive');
  const bob = await mkUser('Bob TwentyFive');
  const flockId = await mkFlock(host, { hoursFromNow: 24 });
  await addMember(flockId, alice, 'invited');
  await block(bob, alice);
  const link = await mkLinkRow(flockId, host, { revoked: false, expiresInDays: 10 });

  const holder = await pool.connect();
  let walkIn;
  let accept;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM flocks WHERE id = $1 FOR UPDATE', [flockId]);
    walkIn = call('POST', `/api/guest/${link}/join`, { token: bob.token });
    await waitForLockWaiters(1);
    accept = call('POST', `/api/flocks/${flockId}/join`, { token: alice.token });
    await waitForLockWaiters(2);
    await holder.query('COMMIT');
  } finally {
    holder.release();
  }
  const [b, a] = await Promise.all([walkIn, accept]);

  assert.strictEqual(b.status, 200, JSON.stringify(b.body));
  assert.strictEqual(b.body.joined, true);
  assert.strictEqual(a.status, 403, JSON.stringify(a.body));
  assert.deepStrictEqual(a.body, { error: 'You cannot join this plan.', code: 'CANNOT_JOIN' });
  assert.strictEqual(await memberStatus(flockId, alice), 'invited');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. A plan created for a past time counts as happening when it was made
// ═══════════════════════════════════════════════════════════════════════════
//
// PUT refuses an event_time earlier than the row, and POST / takes any. Each
// farm loop created its flock for a different past four-hour slot, so each one
// had already started and was a slot of its own. The tally reads a naive
// event_time against a naive created_at, so it is run here rather than read.

test('three plans created for three different past slots earn one plan, not three', async () => {
  const ada = await mkUser('Ada Fourteen');
  const bea = await mkUser('Bea Fourteen');
  const weeksAgo = Date.now() - 30 * 86400e3;
  for (let i = 0; i < 3; i += 1) {
    const created = await call('POST', '/api/flocks', {
      token: ada.token,
      body: { name: `Loop ${i}`, event_time: new Date(weeksAgo + i * 4 * 3600e3).toISOString() },
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const flockId = created.body.flock.id;
    await addMember(flockId, bea, 'accepted');
    const done = await call('PUT', `/api/flocks/${flockId}`, { token: ada.token, body: { status: 'completed' } });
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    const marked = await call('POST', `/api/flocks/${flockId}/attendance`, {
      token: ada.token,
      body: { attendance: [{ userId: ada.id, attended: true }, { userId: bea.id, attended: true }] },
    });
    assert.strictEqual(marked.status, 200, JSON.stringify(marked.body));
  }
  const { rows } = await pool.query('SELECT total_plans_joined, total_plans_attended FROM users WHERE id = $1', [ada.id]);
  assert.deepStrictEqual(rows[0], { total_plans_joined: 1, total_plans_attended: 1 },
    'one burst of creates is one evening, whatever times they were given');
});

test('a plan made before its evening still counts at the evening it was for', async () => {
  const cal = await mkUser('Cal Fifteen');
  const dee = await mkUser('Dee Fifteen');
  // Two real plans, made days ahead and eight hours apart: two evenings.
  for (const hoursAgo of [9, 1]) {
    const { rows } = await pool.query(
      `INSERT INTO flocks (name, creator_id, status, event_time, created_at)
       VALUES ('Real', $1, 'completed', (NOW() AT TIME ZONE 'UTC') - make_interval(hours => $2::int),
               (NOW() AT TIME ZONE 'UTC') - INTERVAL '3 days')
       RETURNING id`,
      [cal.id, hoursAgo]
    );
    await addMember(rows[0].id, cal, 'accepted');
    await addMember(rows[0].id, dee, 'accepted');
    const marked = await call('POST', `/api/flocks/${rows[0].id}/attendance`, {
      token: cal.token,
      body: { attendance: [{ userId: cal.id, attended: true }, { userId: dee.id, attended: true }] },
    });
    assert.strictEqual(marked.status, 200, JSON.stringify(marked.body));
  }
  const { rows } = await pool.query('SELECT total_plans_joined FROM users WHERE id = $1', [cal.id]);
  assert.strictEqual(rows[0].total_plans_joined, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. A new venue replaces the old one whole
// ═══════════════════════════════════════════════════════════════════════════
//
// Every venue column was COALESCEd on its own, so a PUT naming a different
// venue with no coordinates, photo or rating kept the old venue's: a plan
// called Joe's Bar that pointed at Kome. Which venue the plan is at is decided
// in the statement, against the row, so it is run.

const KOME_PHOTO = '/api/venues/photo?ref=kome0001';

async function venueOf(flockId) {
  const { rows } = await pool.query(
    `SELECT venue_name, venue_address, venue_id, venue_latitude, venue_longitude,
            venue_rating::float AS venue_rating, venue_photo_url
       FROM flocks WHERE id = $1`,
    [flockId]
  );
  return rows[0];
}

async function atKome(host) {
  const flockId = await mkFlock(host, { hoursFromNow: 24 });
  await pool.query(
    `UPDATE flocks SET venue_name = 'Kome', venue_address = '1 Kome St', venue_id = 'ChIJkome000001',
                       venue_latitude = 40.7, venue_longitude = -74.0, venue_rating = 4.5,
                       venue_photo_url = $2
      WHERE id = $1`,
    [flockId, KOME_PHOTO]
  );
  return flockId;
}

test('confirming a different venue with no coordinates leaves nothing of the old venue behind', async () => {
  const host = await mkUser('Host Sixteen');
  const flockId = await atKome(host);

  // What the vote panel sends for a venue voted from a shared card that
  // carried no coordinates, photo or rating: a name, an empty address and
  // the vote row's place id.
  const res = await call('PUT', `/api/flocks/${flockId}`, {
    token: host.token,
    body: { venue_name: "Joe's Bar", venue_address: '', venue_id: 'ChIJjoes00001', status: 'confirmed' },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const want = {
    venue_name: "Joe's Bar", venue_address: '', venue_id: 'ChIJjoes00001',
    venue_latitude: null, venue_longitude: null, venue_rating: null, venue_photo_url: null,
  };
  assert.deepStrictEqual(await venueOf(flockId), want, 'no coordinate, photo or rating of Kome survives');
  assert.strictEqual(res.body.flock.venue_latitude, null, 'and the members are told the same thing');
});

test('a different venue with no place id does not keep the old place id', async () => {
  const host = await mkUser('Host Seventeen');
  const flockId = await atKome(host);
  const res = await call('PUT', `/api/flocks/${flockId}`, {
    token: host.token,
    body: { venue_name: "Joe's Bar", venue_latitude: 40.8, venue_longitude: -73.9 },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const v = await venueOf(flockId);
  assert.strictEqual(v.venue_id, null, 'Directions and check-in no longer lead to Kome');
  assert.deepStrictEqual([v.venue_latitude, v.venue_longitude], [40.8, -73.9]);
  assert.strictEqual(v.venue_address, null);
});

test('the same venue sent again with less than the plan has keeps what the plan has', async () => {
  const host = await mkUser('Host Eighteen');
  const flockId = await atKome(host);
  // Lock it in on the venue the plan is already at, from a card with none of
  // the detail: by place id, and by name when the body carries no id.
  const byId = await call('PUT', `/api/flocks/${flockId}`, {
    token: host.token,
    body: { venue_name: 'Kome', venue_id: 'ChIJkome000001', status: 'confirmed' },
  });
  assert.strictEqual(byId.status, 200, JSON.stringify(byId.body));
  const byName = await call('PUT', `/api/flocks/${flockId}`, {
    token: host.token,
    body: { venue_name: 'Kome', venue_rating: 4.8 },
  });
  assert.strictEqual(byName.status, 200, JSON.stringify(byName.body));
  assert.deepStrictEqual(await venueOf(flockId), {
    venue_name: 'Kome', venue_address: '1 Kome St', venue_id: 'ChIJkome000001',
    venue_latitude: 40.7, venue_longitude: -74.0, venue_rating: 4.8, venue_photo_url: KOME_PHOTO,
  }, 'kept, and filled in where the body added something');

  // A PUT that names no venue at all touches none of it.
  const rename = await call('PUT', `/api/flocks/${flockId}`, { token: host.token, body: { name: 'Friday' } });
  assert.strictEqual(rename.status, 200, JSON.stringify(rename.body));
  assert.strictEqual((await venueOf(flockId)).venue_latitude, 40.7);
});

test('the same name at a different place id is a different venue', async () => {
  const host = await mkUser('Host Nineteen');
  const flockId = await atKome(host);
  const res = await call('PUT', `/api/flocks/${flockId}`, {
    token: host.token,
    body: { venue_name: 'Kome', venue_id: 'ChIJkome000002' },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const v = await venueOf(flockId);
  assert.deepStrictEqual([v.venue_id, v.venue_latitude, v.venue_photo_url], ['ChIJkome000002', null, null]);
});

// The socket's confirm, select_venue, is the second writer of the same row.
// It carries a name, an address and a place id and nothing else, and it wrote
// those three over a row that kept the old venue's coordinates, rating and
// photo. Run through the real handler, with a stand-in socket and server that
// record what they are asked to send.
function socketAs(user) {
  const handlers = new Map();
  const io = {
    emitted: [],
    sockets: { sockets: new Map(), adapter: { rooms: new Map() } },
    to(room) {
      return {
        except() { return this; },
        emit(event, payload) { io.emitted.push({ room, event, payload }); },
      };
    },
  };
  const socket = {
    id: `plan-flow-${user.id}`,
    user: { id: user.id, name: user.name },
    rooms: new Set(),
    handshake: null,
    on(event, fn) { handlers.set(event, fn); },
    join(room) { socket.rooms.add(room); },
    leave(room) { socket.rooms.delete(room); },
    emit(event, payload) { io.emitted.push({ room: 'self', event, payload }); },
    disconnect() {},
  };
  require('../sockets/handlers').registerHandlers(io, socket);
  return { io, fire: (event, payload) => handlers.get(event)(payload) };
}

test('the socket confirm of a different venue leaves nothing of the old one, and tells the room so', async () => {
  const host = await mkUser('Host TwentySix');
  const flockId = await atKome(host);
  const { io, fire } = socketAs(host);

  await fire('select_venue', { flockId, venue_name: "Joe's Bar", venue_id: 'ChIJjoes00001' });
  assert.deepStrictEqual(await venueOf(flockId), {
    venue_name: "Joe's Bar", venue_address: null, venue_id: 'ChIJjoes00001',
    venue_latitude: null, venue_longitude: null, venue_rating: null, venue_photo_url: null,
  }, 'no address, coordinate, rating or photo of Kome survives');
  assert.strictEqual(await statusOf(flockId), 'confirmed');

  const selected = io.emitted.find((e) => e.event === 'venue_selected');
  assert.ok(selected, JSON.stringify(io.emitted));
  assert.deepStrictEqual(
    [selected.payload.venue_latitude, selected.payload.venue_longitude, selected.payload.venue_photo_url],
    [null, null, null],
    'every open app is told the old pin is gone'
  );
});

test('the socket confirm of the venue the plan is already at keeps what the plan has', async () => {
  const host = await mkUser('Host TwentySeven');
  const flockId = await atKome(host);
  const { io, fire } = socketAs(host);

  // By name alone, the way a client that holds no place id sends it.
  await fire('select_venue', { flockId, venue_name: 'Kome' });
  assert.deepStrictEqual(await venueOf(flockId), {
    venue_name: 'Kome', venue_address: '1 Kome St', venue_id: 'ChIJkome000001',
    venue_latitude: 40.7, venue_longitude: -74.0, venue_rating: 4.5, venue_photo_url: KOME_PHOTO,
  });
  const selected = io.emitted.find((e) => e.event === 'venue_selected');
  assert.strictEqual(selected.payload.venue_id, 'ChIJkome000001', 'the room hears the place id the row kept');
  assert.strictEqual(selected.payload.venue_latitude, 40.7);

  // The same name at a different place id is a different venue here too.
  await fire('select_venue', { flockId, venue_name: 'Kome', venue_id: 'ChIJkome000002' });
  const moved = await venueOf(flockId);
  assert.deepStrictEqual([moved.venue_id, moved.venue_latitude, moved.venue_photo_url], ['ChIJkome000002', null, null]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. The shared link follows the plan to its new time
// ═══════════════════════════════════════════════════════════════════════════
//
// The link's deadline was computed once, at minting, from the time the plan
// had then. A plan moved three weeks out kept a link that closed two weeks
// before the night. The deadline crosses a naive event_time and a zoned
// expires_at, so it is run.

const DAY_MS = 86400e3;
const linkExpiry = async (token) => new Date((await pool.query(
  'SELECT expires_at FROM flock_invite_links WHERE token = $1', [token]
)).rows[0].expires_at).getTime();

test('moving a plan weeks out moves the shared link\'s deadline with it', async () => {
  const host = await mkUser('Host Twenty');
  const flockId = await mkFlock(host, { hoursFromNow: 48 });
  const minted = await call('POST', `/api/flocks/${flockId}/invite-link`, { token: host.token });
  assert.strictEqual(minted.status, 200, JSON.stringify(minted.body));
  const before = await linkExpiry(minted.body.token);
  assert.ok(before < Date.now() + 15 * DAY_MS, 'minted for a plan two days out: the fourteen-day floor');

  const newTime = new Date(Date.now() + 30 * DAY_MS);
  const moved = await call('PUT', `/api/flocks/${flockId}`, { token: host.token, body: { event_time: newTime.toISOString() } });
  assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
  const after = await linkExpiry(minted.body.token);
  assert.ok(Math.abs(after - (newTime.getTime() + 7 * DAY_MS)) < 5000,
    `the link now lasts to a week after the new time (off by ${after - (newTime.getTime() + 7 * DAY_MS)}ms)`);

  // And it is the same link: Share hands back the token already in the chat.
  const again = await call('POST', `/api/flocks/${flockId}/invite-link`, { token: host.token });
  assert.strictEqual(again.body.token, minted.body.token);

  // Moving it back earlier shortens nothing already promised.
  const earlier = await call('PUT', `/api/flocks/${flockId}`, {
    token: host.token, body: { event_time: new Date(Date.now() + 3 * DAY_MS).toISOString() },
  });
  assert.strictEqual(earlier.status, 200, JSON.stringify(earlier.body));
  assert.strictEqual(await linkExpiry(minted.body.token), after);
});

test('a reschedule never revives a revoked or a lapsed link', async () => {
  const host = await mkUser('Host TwentyOne');
  const flockId = await mkFlock(host, { hoursFromNow: 48 });
  const revoked = await mkLinkRow(flockId, host, { revoked: true, expiresInDays: 10 });
  const lapsed = await mkLinkRow(flockId, host, { revoked: false, expiresInDays: -1 });
  const before = [await linkExpiry(revoked), await linkExpiry(lapsed)];

  const moved = await call('PUT', `/api/flocks/${flockId}`, {
    token: host.token, body: { event_time: new Date(Date.now() + 30 * DAY_MS).toISOString() },
  });
  assert.strictEqual(moved.status, 200, JSON.stringify(moved.body));
  assert.deepStrictEqual([await linkExpiry(revoked), await linkExpiry(lapsed)], before);
});

async function mkLinkRow(flockId, creator, { revoked, expiresInDays }) {
  seq += 1;
  const token = `RaceLink${seq}x${flockId}abcdefgh`;
  await pool.query(
    `INSERT INTO flock_invite_links (token, flock_id, created_by, revoked, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + make_interval(days => $5::int))`,
    [token, flockId, creator.id, revoked, expiresInDays]
  );
  return token;
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. A guest answer retired on a join is not a takedown
// ═══════════════════════════════════════════════════════════════════════════
//
// The joins hide the guest row of somebody who just became a member, and a
// hidden row was all a moderator's takedown wrote too, so the takedown's name
// guard refused that name to everybody else on the plan and the new member's
// own page told them their answer was gone. Both readers ask the database
// which kind of hidden a row is, so they are run.

async function sayAs(linkToken, body) {
  return call('POST', `/api/guest/${linkToken}/rsvp`, { body });
}

test('a first name retired on a join stays free for the next person, and its own page says they joined', async () => {
  const host = await mkUser('Host TwentyTwo');
  const sam = await mkUser('Sam Rivera');
  const flockId = await mkFlock(host, { hoursFromNow: 24 });
  const link = await mkLinkRow(flockId, host, { revoked: false, expiresInDays: 10 });

  // Sam answers the link by first name, then makes the account and joins.
  const answered = await sayAs(link, { name: 'Sam', status: 'in' });
  assert.strictEqual(answered.status, 201, JSON.stringify(answered.body));
  const joined = await call('POST', `/api/guest/${link}/join`, { token: sam.token, body: { guestToken: answered.body.guestToken } });
  assert.strictEqual(joined.status, 200, JSON.stringify(joined.body));

  // A different Sam on the same link is an ordinary new answer. So is the Sam
  // who joined, answering again from a browser that holds no identity: the
  // route is anonymous and cannot tell the two apart, and refusing both is
  // the defect (migration 098, WHAT THE STAMP OPENS). Pinned so the opening
  // is a decision someone has to undo on purpose, not a surprise.
  const other = await sayAs(link, { name: 'Sam', status: 'in' });
  assert.strictEqual(other.status, 201, JSON.stringify(other.body));

  const row = (await pool.query(
    'SELECT is_hidden, retired_at FROM guest_rsvps WHERE guest_token = $1', [answered.body.guestToken]
  )).rows[0];
  assert.strictEqual(row.is_hidden, true, 'retired, so counted once');
  assert.ok(row.retired_at, 'and stamped as retired, not taken down');

  // The first Sam's browser is told they joined, not that the answer is gone.
  const me = await call('POST', `/api/guest/${link}/me`, { body: { guestToken: answered.body.guestToken } });
  assert.strictEqual(me.status, 403, JSON.stringify(me.body));
  assert.strictEqual(me.body.code, 'JOINED_IN_APP');
  assert.doesNotMatch(me.body.error, /removed|cannot be used/);
  const edit = await sayAs(link, { name: 'Sam', status: 'out', guestToken: answered.body.guestToken });
  assert.strictEqual(edit.status, 403, JSON.stringify(edit.body));
  assert.strictEqual(edit.body.code, 'JOINED_IN_APP');
});

test('a name a moderator took down is still refused, and a stranger\'s token is still just unknown', async () => {
  const host = await mkUser('Host TwentyThree');
  const flockId = await mkFlock(host, { hoursFromNow: 24 });
  const link = await mkLinkRow(flockId, host, { revoked: false, expiresInDays: 10 });
  const abusive = await sayAs(link, { name: 'Rude Name', status: 'in' });
  assert.strictEqual(abusive.status, 201, JSON.stringify(abusive.body));
  // What the moderator's hide writes for a guest row (routes/admin.js
  // TAKEDOWN_TARGETS: is_hidden, and the retired stamp cleared).
  await pool.query('UPDATE guest_rsvps SET is_hidden = TRUE, retired_at = NULL WHERE guest_token = $1', [abusive.body.guestToken]);

  const again = await sayAs(link, { name: 'rude  name', status: 'in' });
  assert.strictEqual(again.status, 403, JSON.stringify(again.body));
  assert.match(again.body.error, /cannot be used on this flock/);
  const me = await call('POST', `/api/guest/${link}/me`, { body: { guestToken: abusive.body.guestToken } });
  assert.strictEqual(me.status, 403);
  assert.strictEqual(me.body.code, undefined, 'a takedown is not told it joined anything');
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. The host hears once when everyone else has voted
// ═══════════════════════════════════════════════════════════════════════════
//
// Push is switched on for these by replacing the provider, never by reaching
// one: firebaseService is held as a module object by services/pushHelper.js,
// so its isEnabled and sendPushToUser are what every delivery calls. The vote
// route answers first and pushes after, so each check waits for the send.

async function withPush(fn) {
  const firebaseService = require('../services/firebaseService');
  const realEnabled = firebaseService.isEnabled;
  const realSend = firebaseService.sendPushToUser;
  const sends = [];
  firebaseService.isEnabled = () => true;
  firebaseService.sendPushToUser = async (userId, title, body, data) => {
    sends.push({ userId: Number(userId), title, body, data });
    return { sent: 1, failed: 0 };
  };
  try {
    return await fn(sends);
  } finally {
    firebaseService.isEnabled = realEnabled;
    firebaseService.sendPushToUser = realSend;
  }
}

const votesIn = (sends) => sends.filter((s) => s.data && s.data.type === 'flock_votes_in');
const pushedAt = async (flockId) => (await pool.query(
  'SELECT votes_in_pushed_at FROM flocks WHERE id = $1', [flockId]
)).rows[0].votes_in_pushed_at;

async function vote(user, flockId, venue) {
  const res = await call('POST', `/api/flocks/${flockId}/vote`, { token: user.token, body: { venue_name: venue } });
  assert.ok(res.status === 201 || res.status === 200, JSON.stringify(res.body));
  return res;
}

// Waits long enough for a push the route would send after answering, so
// "nothing was sent" is a finding rather than a race.
async function settle() { await sleep(150); }

test('the host hears once, when the last member other than the host votes, with the leader', async () => {
  await withPush(async (sends) => {
    const host = await mkUser('Host Eleven');
    const bo = await mkUser('Bo Eleven');
    const cy = await mkUser('Cy Eleven');
    const dee = await mkUser('Dee Eleven');
    const flockId = await mkFlock(host);
    await addMember(flockId, bo, 'accepted');
    await addMember(flockId, cy, 'accepted');
    // An invite nobody answered is not a voter the host is waiting on.
    await addMember(flockId, dee, 'invited');

    await vote(bo, flockId, 'Kome');
    await vote(host, flockId, 'Ramen');
    await settle();
    assert.deepStrictEqual(votesIn(sends), [], 'Cy has not voted yet');
    assert.strictEqual(await pushedAt(flockId), null);

    await vote(cy, flockId, 'Kome');
    const until = Date.now() + 3000;
    while (votesIn(sends).length === 0 && Date.now() < until) await sleep(20);
    assert.deepStrictEqual(votesIn(sends).map((s) => [s.userId, s.title, s.body]),
      [[host.id, 'The votes are in', 'Kome is ahead for Plan. Lock it in?']]);
    assert.strictEqual(votesIn(sends)[0].data.flockId, String(flockId));
    assert.ok(await pushedAt(flockId), 'the claim is recorded on the plan');

    // A member changing their mind afterwards is not a second "votes are in".
    await vote(bo, flockId, 'Ramen');
    await settle();
    assert.strictEqual(votesIn(sends).length, 1);
  });
});

test('two last votes landing together send the host one push', async () => {
  await withPush(async (sends) => {
    const host = await mkUser('Host Twelve');
    const ed = await mkUser('Ed Twelve');
    const flo = await mkUser('Flo Twelve');
    const flockId = await mkFlock(host);
    await addMember(flockId, ed, 'accepted');
    await addMember(flockId, flo, 'accepted');

    await Promise.all([vote(ed, flockId, 'Kome'), vote(flo, flockId, 'Kome')]);
    const until = Date.now() + 3000;
    while (votesIn(sends).length === 0 && Date.now() < until) await sleep(20);
    await settle();
    assert.strictEqual(votesIn(sends).length, 1, 'both votes found everyone voted; only one may claim the push');
    assert.strictEqual(votesIn(sends)[0].userId, host.id);
  });
});

test('a plan already locked in, or voted on only by its host, sends nothing', async () => {
  await withPush(async (sends) => {
    const host = await mkUser('Host Thirteen');
    const gus = await mkUser('Gus Thirteen');
    const locked = await mkFlock(host, { status: 'confirmed' });
    await addMember(locked, gus, 'accepted');
    await vote(gus, locked, 'Kome');

    // The host voting on a plan whose only other member has not.
    const hal = await mkUser('Hal Thirteen');
    const open = await mkFlock(host);
    await addMember(open, hal, 'accepted');
    await vote(host, open, 'Kome');

    await settle();
    assert.deepStrictEqual(votesIn(sends), []);
    assert.strictEqual(await pushedAt(locked), null, 'a confirmed plan has nothing left to lock in');
    assert.strictEqual(await pushedAt(open), null);
  });
});

test('with push not configured the vote claims nothing, so a later vote can still tell the host', async () => {
  const host = await mkUser('Host Fourteen');
  const ivy = await mkUser('Ivy Fourteen');
  const flockId = await mkFlock(host);
  await addMember(flockId, ivy, 'accepted');
  await vote(ivy, flockId, 'Kome');
  await settle();
  assert.strictEqual(await pushedAt(flockId), null);
});
