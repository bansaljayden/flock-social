// Run: node --test  (from backend/)
//
// ─────────────────────────────────────────────────────────────────────────────
// GAME-RULE ABUSE — venue voting (routes/venues.js, routes/guest.js)
// ─────────────────────────────────────────────────────────────────────────────
//
// The tally decides where a flock actually goes, so it is a real target. Round
// 17 already closed the obvious one (a departed member's vote outliving them),
// and that fix is re-attacked here rather than assumed.
//
// Both findings this file opened with are now CLOSED, and every case below
// asserts the fix rather than the defect:
//
//   U. THE TALLY HAS A CLOSING TIME. POST/DELETE /api/flocks/:id/vote used to
//      check membership and nothing else, and never loaded the flocks row at
//      all, so no state of the plan could refuse them: a completed flock still
//      accepted votes and re-opened its standings, and a vote could be pulled
//      back afterwards until the venue that lost was the only one anyone had
//      ever voted for. Both write paths now refuse a completed or a cancelled
//      flock with a 409. Planning and confirmed stay open, because groups
//      change their minds right up to the door, and READING stays open on any
//      status, because looking at what the group picked is the honest use.
//
//   V. GUESTS NO LONGER OUTVOTE MEMBERS. A guest_votes row counted one for one
//      with a member vote, and routes/guest.js caps RSVPs at 50 PER FLOCK, not
//      per person, so one holder of the share link outvoted a three-member
//      roster 50 to 3 with no account and no name attached. Guest weight is now
//      capped per venue at the number of accepted members, so guests can tip a
//      decision the members are split on and can no longer overrule them. The
//      raw guest_count is still reported honestly, and a tie now breaks toward
//      the venue the members picked.
//
// Held, and asserted: one member is one vote however many times they post, a
// departed member's vote leaves the tally with them, and a non-member cannot
// read or write the tally at all.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.JWT_SECRET = 'abuse-venue-voting-test-secret';

const pool = require('../config/database');

const authMod = require('../middleware/auth');
let CURRENT_USER = { id: 1, name: 'Ava', email_verified: true, role: 'user' };
authMod.authenticate = (req, _res, next) => { req.user = CURRENT_USER; next(); };

const FLOCK = 3300;

let world;
function freshWorld() {
  return {
    flock: { id: FLOCK, status: 'planning', venue_name: null },
    members: [],       // { user_id, status }
    votes: [],         // { user_id, venue_name, venue_id }
    guestVotes: [],    // { guest_rsvp_id, venue_name, hidden }
    users: new Map(),
  };
}
const accepted = () => world.members.filter((m) => m.status === 'accepted');

let log = [];
let unknown = [];
// "Cancelled mid-request": the closure check reads an open plan, and the plan
// is closed by the time the write lands. The write carries the rule itself.
// `true` cancels the plan after the read; any other non-false value is the
// status the plan takes instead (null: a row whose status cannot be read).
let closeAfterStatusRead = false;
// A transaction's writes are staged: BEGIN keeps a copy of the vote rows,
// ROLLBACK puts it back, COMMIT drops it. "A refused vote leaves the old one
// in place" is only testable with real undo.
let txnVotes = null;
function assertQueriesUnderstood() {
  assert.deepStrictEqual(unknown, [], `unmodelled queries: ${JSON.stringify(unknown.slice(0, 3))}`);
}

async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  const p = params || [];
  if (/^BEGIN/i.test(flat)) { txnVotes = world.votes.map((v) => ({ ...v })); return { rows: [], rowCount: 0 }; }
  if (/^ROLLBACK/i.test(flat)) {
    if (txnVotes) world.votes.splice(0, world.votes.length, ...txnVotes);
    txnVotes = null;
    return { rows: [], rowCount: 0 };
  }
  if (/^COMMIT/i.test(flat)) { txnVotes = null; return { rows: [], rowCount: 0 }; }
  if (/pg_advisory_xact_lock/.test(flat)) return { rows: [], rowCount: 0 };

  if (/^SELECT id FROM flock_members WHERE flock_id = \$1 AND user_id = \$2 AND status = 'accepted'$/.test(flat)) {
    const m = world.members.find((x) => x.user_id === Number(p[1]) && x.status === 'accepted');
    return m ? { rows: [{ id: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^SELECT user_id FROM flock_members WHERE flock_id = \$1 AND status = 'accepted'$/.test(flat)) {
    return { rows: accepted().map((m) => ({ user_id: m.user_id })), rowCount: accepted().length };
  }
  // The closing-time read the vote write paths gained. Modelled, so the refusal
  // below is the route's own decision about a real status, not a fixture that
  // happens to answer nothing.
  if (/^SELECT status FROM flocks WHERE id = \$1$/.test(flat)) {
    const answer = world.flock ? { rows: [{ status: world.flock.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (world.flock && closeAfterStatusRead !== false) {
      world.flock.status = closeAfterStatusRead === true ? 'cancelled' : closeAfterStatusRead;
      closeAfterStatusRead = false;
    }
    return answer;
  }
  if (/^SELECT blocker_id, blocked_id FROM user_blocks/.test(flat)) {
    return { rows: [], rowCount: 0 };
  }
  // utils/blocks.js getInvisibleUserIds — no blocks anywhere in these cases.
  if (/^SELECT blocked_id AS id FROM user_blocks WHERE blocker_id = \$1 UNION/.test(flat)) {
    return { rows: [], rowCount: 0 };
  }
  if (/^SELECT venue_name FROM venue_votes WHERE flock_id = \$1 AND user_id = \$2$/.test(flat)) {
    const v = world.votes.find((x) => x.user_id === Number(p[1]));
    return v ? { rows: [{ venue_name: v.venue_name }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^DELETE FROM venue_votes WHERE flock_id = \$1 AND user_id = \$2 AND venue_name <> \$3$/.test(flat)) {
    const before = world.votes.length;
    world.votes = world.votes.filter((v) => !(v.user_id === Number(p[1]) && v.venue_name !== p[2]));
    return { rows: [], rowCount: before - world.votes.length };
  }
  // The un-vote. It carries the same closing time the INSERT below does, in
  // the statement, so a plan that closed after the route's own check keeps
  // every vote it had; the fixture does what the EXISTS does.
  if (/^DELETE FROM venue_votes WHERE flock_id = \$1::int AND user_id = \$2::int AND EXISTS \(SELECT 1 FROM flocks WHERE id = \$1::int AND status NOT IN \('completed', 'cancelled'\)\) RETURNING venue_name$/.test(flat)) {
    const open = world.flock && typeof world.flock.status === 'string'
      && world.flock.status !== 'completed' && world.flock.status !== 'cancelled';
    if (!open) return { rows: [], rowCount: 0 };
    const gone = world.votes.filter((v) => v.user_id === Number(p[1]));
    world.votes = world.votes.filter((v) => v.user_id !== Number(p[1]));
    return { rows: gone.map((v) => ({ venue_name: v.venue_name })), rowCount: gone.length };
  }
  // What an empty un-vote reads back: does the caller still hold a vote.
  if (/^SELECT 1 FROM venue_votes WHERE flock_id = \$1 AND user_id = \$2 LIMIT 1$/.test(flat)) {
    const held = world.votes.some((v) => v.user_id === Number(p[1]));
    return held ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (/^INSERT INTO venue_votes/.test(flat)) {
    // The route's INSERT ... SELECT writes nothing for a closed plan (WHERE
    // EXISTS on the status); the fixture does what the WHERE does.
    // `status NOT IN (...)` is true only for a readable, open status: a NULL
    // status is neither, and the statement writes nothing for it.
    const open = world.flock && typeof world.flock.status === 'string'
      && world.flock.status !== 'completed' && world.flock.status !== 'cancelled';
    if (/WHERE EXISTS \(SELECT 1 FROM flocks WHERE id = \$1::int AND status NOT IN/.test(flat) && !open) {
      return { rows: [], rowCount: 0 };
    }
    const [uid, name, vid] = [Number(p[1]), p[2], p[3]];
    let v = world.votes.find((x) => x.user_id === uid && x.venue_name === name);
    if (v) { v.venue_id = v.venue_id || vid; }
    else { v = { user_id: uid, venue_name: name, venue_id: vid }; world.votes.push(v); }
    return { rows: [{ flock_id: FLOCK, ...v }], rowCount: 1 };
  }
  // collectVoteRows — member tally, executed WITH the membership join the
  // round-17 fix added, only when the arriving SQL actually carries it.
  if (/FROM venue_votes vv JOIN users u/.test(flat)) {
    const joined = /JOIN flock_members fm ON fm\.flock_id = vv\.flock_id AND fm\.user_id = vv\.user_id AND fm\.status = 'accepted'/.test(flat);
    const counted = world.votes.filter((v) =>
      !joined || world.members.some((m) => m.user_id === v.user_id && m.status === 'accepted'));
    const byName = new Map();
    for (const v of counted) {
      if (!byName.has(v.venue_name)) byName.set(v.venue_name, { venue_name: v.venue_name, venue_id: v.venue_id || null, member_count: 0, voter_rows: [] });
      const g = byName.get(v.venue_name);
      g.member_count += 1;
      g.voter_rows.push({ id: v.user_id, name: world.users.get(v.user_id)?.name || `U${v.user_id}` });
    }
    const rows = [...byName.values()].sort((a, b) => b.member_count - a.member_count);
    return { rows, rowCount: rows.length };
  }
  // guest tally. A guest who said out (`out: true`) is left out only when the
  // arriving SQL carries the 'in' predicate, so dropping it goes red below.
  if (/FROM guest_votes gv JOIN guest_rsvps gr/.test(flat)) {
    const onlyIn = /AND gr\.status = 'in'/.test(flat);
    const byName = new Map();
    for (const g of world.guestVotes) {
      if (g.hidden) continue;
      if (onlyIn && g.out) continue;
      byName.set(g.venue_name, (byName.get(g.venue_name) || 0) + 1);
    }
    const rows = [...byName.entries()].map(([venue_name, guest_count]) => ({ venue_name, guest_count }));
    return { rows, rowCount: rows.length };
  }

  unknown.push(flat.slice(0, 160));
  throw new Error(`unscripted query: ${flat.slice(0, 160)}`);
}

pool.query = (sql, params) => dispatch(sql, params);
pool.connect = async () => ({ query: (sql, params) => dispatch(sql, params), release: () => {} });

const venuesRouter = require('../routes/venues');

const app = express();
app.use(express.json());
app.set('io', null);
app.use('/api/flocks', venuesRouter);

let base;
const server = http.createServer(app);
test.before(() => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(() => new Promise((resolve) => {
  server.close(() => resolve());
  pool.end?.().catch(() => {});
}));

test.beforeEach(() => {
  world = freshWorld(); log = []; unknown = []; closeAfterStatusRead = false; txnVotes = null;
});

test('a vote on a plan cancelled between the closure check and the write records nothing', async () => {
  as(1, 'Ava'); as(2, 'Bo');
  world.members.push({ user_id: 1, status: 'accepted' }, { user_id: 2, status: 'accepted' });
  // The caller's own earlier vote: the route deletes it before writing the
  // new one, so a refused write must undo that delete too.
  world.votes.push({ user_id: 1, venue_name: 'Taqueria', venue_id: null });
  as(1, 'Ava');
  closeAfterStatusRead = true;

  const r = await vote('Ramen');
  assert.strictEqual(r.status, 409, r.text);
  assert.match(r.body.error, /cancelled/);
  assert.deepStrictEqual(world.votes.map((v) => [v.user_id, v.venue_name]), [[1, 'Taqueria']],
    'the vote the caller had did not survive the refused one');
  const insert = log.find((q) => /^INSERT INTO venue_votes/.test(q.sql));
  assert.ok(insert, 'the write is what decides, so it must run');
  assert.match(insert.sql, /WHERE EXISTS \(SELECT 1 FROM flocks WHERE id = \$1::int AND status NOT IN \('completed', 'cancelled'\)\)/);
  assert.ok(log.some((q) => /^ROLLBACK/i.test(q.sql)), 'a write that did not land must be rolled back');
  assert.ok(!log.some((q) => /^COMMIT/i.test(q.sql)), 'and never committed');
  assertQueriesUnderstood();
});

test('a plan whose status cannot be read as open gets no vote, keeps the old one, and says so', async () => {
  // The closure check treats an unreadable status as open; the write's
  // NOT IN treats it as not open and lands nothing. That disagreement must
  // end in a rollback and a retry message, never in a committed delete of
  // the caller's earlier vote with nothing in its place.
  as(1, 'Ava');
  world.members.push({ user_id: 1, status: 'accepted' });
  world.votes.push({ user_id: 1, venue_name: 'Taqueria', venue_id: null });
  closeAfterStatusRead = null;

  const r = await vote('Ramen');
  assert.strictEqual(r.status, 409, r.text);
  assert.match(r.body.error, /changed .* try again/i);
  assert.deepStrictEqual(world.votes.map((v) => [v.user_id, v.venue_name]), [[1, 'Taqueria']]);
  assert.ok(log.some((q) => /^ROLLBACK/i.test(q.sql)));
  assert.ok(!log.some((q) => /^COMMIT/i.test(q.sql)));
  assertQueriesUnderstood();
});

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}
const as = (id, name) => {
  CURRENT_USER = { id, name, email_verified: true, role: 'user' };
  world.users.set(id, { id, name });
};
const vote = (venueName) => call('POST', `/api/flocks/${FLOCK}/vote`, { venue_name: venueName });
const votes = () => call('GET', `/api/flocks/${FLOCK}/votes`);

// ═════════════════════════════════════════════════════════════════════════════
// U. NO CLOCK ON THE TALLY
// ═════════════════════════════════════════════════════════════════════════════

test('FIXED U: a completed flock refuses a new vote, and the standings do not move', async () => {
  as(1, 'Ava'); as(2, 'Bo');
  world.members.push({ user_id: 1, status: 'accepted' }, { user_id: 2, status: 'accepted' });
  world.flock.status = 'completed';
  world.flock.venue_name = 'The Chosen Bar';
  world.votes.push({ user_id: 2, venue_name: 'The Chosen Bar', venue_id: null });

  as(1, 'Ava');
  const r = await vote('Somewhere Else');
  assert.strictEqual(r.status, 409, r.text);
  assert.match(r.body.error, /finished/);
  assert.deepStrictEqual(world.votes.map((v) => v.venue_name), ['The Chosen Bar'],
    'nothing was written: the evening is over and the record of it stands');

  // The route now loads the flock row, which is what makes any state of the
  // plan able to refuse a vote at all.
  assert.strictEqual(log.some((q) => /^SELECT status FROM flocks WHERE id = \$1$/.test(q.sql)), true,
    'the vote path reads the flock status before it writes');
  assertQueriesUnderstood();
});

test('FIXED U2: a vote cannot be withdrawn after the plan is over, so the losing venue cannot become the only one', async () => {
  as(1, 'Ava'); as(2, 'Bo'); as(3, 'Cy');
  world.members.push({ user_id: 1, status: 'accepted' }, { user_id: 2, status: 'accepted' }, { user_id: 3, status: 'accepted' });
  world.votes.push(
    { user_id: 1, venue_name: 'Taqueria', venue_id: null },
    { user_id: 2, venue_name: 'Taqueria', venue_id: null },
    { user_id: 3, venue_name: 'Ramen', venue_id: null },
  );
  world.flock.status = 'cancelled';

  as(1, 'Ava');
  const r = await call('DELETE', `/api/flocks/${FLOCK}/vote`);
  assert.strictEqual(r.status, 409, r.text);
  assert.match(r.body.error, /cancelled/);
  as(2, 'Bo');
  assert.strictEqual((await call('DELETE', `/api/flocks/${FLOCK}/vote`)).status, 409);

  as(3, 'Cy');
  const after = await votes();
  assert.deepStrictEqual(after.body.votes.map((v) => [v.venue_name, v.vote_count]), [['Taqueria', 2], ['Ramen', 1]],
    'the record still says what the group actually chose');
  assertQueriesUnderstood();
});

test('FIXED U3: a plan that is still a plan is untouched, confirmed included', async () => {
  as(1, 'Ava'); as(2, 'Bo');
  world.members.push({ user_id: 1, status: 'accepted' }, { user_id: 2, status: 'accepted' });

  for (const status of ['planning', 'confirmed']) {
    world.votes = [];
    world.flock.status = status;
    as(1, 'Ava');
    assert.strictEqual((await vote('Late Change Of Heart')).status, 201, `${status} refused a vote`);
    assert.strictEqual((await call('DELETE', `/api/flocks/${FLOCK}/vote`)).status, 200, `${status} refused an un-vote`);
  }
  assertQueriesUnderstood();
});

test('FIXED U4: reading the tally of a finished plan is still allowed', async () => {
  as(1, 'Ava'); as(2, 'Bo');
  world.members.push({ user_id: 1, status: 'accepted' }, { user_id: 2, status: 'accepted' });
  world.votes.push({ user_id: 2, venue_name: 'The Chosen Bar', venue_id: null });
  world.flock.status = 'completed';

  as(1, 'Ava');
  const after = await votes();
  assert.strictEqual(after.status, 200, after.text);
  assert.deepStrictEqual(after.body.votes.map((v) => v.venue_name), ['The Chosen Bar'],
    'the vote closes; the history stays readable');
  assertQueriesUnderstood();
});

// The un-vote had the closing time as a separate read on the pool and then a
// bare DELETE with no lock, so a plan completing in the gap between the two
// still lost the vote, and the delete could interleave with the same person's
// vote from another device. It is the POST's twin now.

test('FIXED U5: an un-vote on a plan closed between the check and the delete removes nothing', async () => {
  as(1, 'Ava'); as(2, 'Bo');
  world.members.push({ user_id: 1, status: 'accepted' }, { user_id: 2, status: 'accepted' });
  world.votes.push(
    { user_id: 1, venue_name: 'Taqueria', venue_id: null },
    { user_id: 2, venue_name: 'Ramen', venue_id: null },
  );
  as(1, 'Ava');
  closeAfterStatusRead = 'completed';

  const r = await call('DELETE', `/api/flocks/${FLOCK}/vote`);
  assert.strictEqual(r.status, 409, r.text);
  assert.match(r.body.error, /finished/);
  assert.deepStrictEqual(world.votes.map((v) => [v.user_id, v.venue_name]), [[1, 'Taqueria'], [2, 'Ramen']],
    'the record of the finished night keeps the vote');
  const del = log.find((q) => /^DELETE FROM venue_votes WHERE flock_id = \$1::int/.test(q.sql));
  assert.ok(del, 'the delete is what decides, so it must run');
  assert.match(del.sql, /AND EXISTS \(SELECT 1 FROM flocks WHERE id = \$1::int AND status NOT IN \('completed', 'cancelled'\)\)/);
  assertQueriesUnderstood();
});

test('FIXED U6: the un-vote takes the same per-person lock as the vote, inside one transaction', async () => {
  as(1, 'Ava');
  world.members.push({ user_id: 1, status: 'accepted' });
  world.votes.push({ user_id: 1, venue_name: 'Taqueria', venue_id: null });

  const r = await call('DELETE', `/api/flocks/${FLOCK}/vote`);
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.removed, 1);
  assert.deepStrictEqual(world.votes, []);
  const begin = log.findIndex((q) => /^BEGIN/i.test(q.sql));
  const lock = log.findIndex((q) => /pg_advisory_xact_lock\(hashtext\('flockvote:' \|\| \$1::text \|\| ':' \|\| \$2::text\)\)/.test(q.sql));
  const del = log.findIndex((q) => /^DELETE FROM venue_votes/.test(q.sql));
  const commit = log.findIndex((q) => /^COMMIT/i.test(q.sql));
  assert.ok(begin > -1 && begin < lock && lock < del && del < commit,
    'BEGIN, the flockvote: lock the POST holds, the delete, then COMMIT');
  assert.deepStrictEqual(log[lock].params, [String(FLOCK), '1'],
    'keyed on the same (flock, person) pair as the vote, so the two serialise');
  assertQueriesUnderstood();
});

test('FIXED U7: a plan whose status cannot be read as open keeps the vote and says so', async () => {
  as(1, 'Ava');
  world.members.push({ user_id: 1, status: 'accepted' });
  world.votes.push({ user_id: 1, venue_name: 'Taqueria', venue_id: null });
  closeAfterStatusRead = null;

  const r = await call('DELETE', `/api/flocks/${FLOCK}/vote`);
  assert.strictEqual(r.status, 409, r.text);
  assert.match(r.body.error, /changed .* try again/i);
  assert.deepStrictEqual(world.votes.map((v) => v.venue_name), ['Taqueria'],
    'never a 200 that says nothing was removed while the vote is still counted');
  assertQueriesUnderstood();
});

test('HELD: taking back a vote you do not have is still a quiet 200 on an open plan', async () => {
  as(1, 'Ava');
  world.members.push({ user_id: 1, status: 'accepted' });

  const r = await call('DELETE', `/api/flocks/${FLOCK}/vote`);
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.removed, 0);
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// V. GUESTS OUTVOTE MEMBERS
// ═════════════════════════════════════════════════════════════════════════════

test('FIXED V: fifty stuffed guest votes cannot outweigh a three-member roster', async () => {
  as(1, 'Ava'); as(2, 'Bo'); as(3, 'Cy');
  world.members.push({ user_id: 1, status: 'accepted' }, { user_id: 2, status: 'accepted' }, { user_id: 3, status: 'accepted' });
  for (const id of [1, 2, 3]) { as(id, `U${id}`); await vote('The Members Pick'); }

  as(1, 'Ava');
  let tally = await votes();
  assert.deepStrictEqual(tally.body.votes.map((v) => [v.venue_name, v.vote_count]), [['The Members Pick', 3]]);

  // One person holding the share link fills the guest cap and votes them all.
  // routes/guest.js refuses at 50 RSVPs per flock, per its own transaction, and
  // that cap is per FLOCK, not per person, which is why this is reachable at
  // all. The sybil door is still open; what it can do here is now bounded.
  const guestSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'guest.js'), 'utf8');
  // The literal 50 became the named GUEST_ROWS_CAP on 2026-08-27, when the
  // GET preview started warning about the same ceiling and two places had to
  // agree on it. Pin the named form AND the value, so renaming cannot
  // silently loosen the cap either.
  assert.match(guestSrc, /if \(count\.rows\[0\]\.n >= GUEST_ROWS_CAP\)/, 'the cap, read from the route');
  assert.match(guestSrc, /const GUEST_ROWS_CAP = 50;/, 'and the ceiling is still fifty');
  for (let i = 0; i < 50; i += 1) world.guestVotes.push({ guest_rsvp_id: i + 1, venue_name: 'The Link Holders Pick', hidden: false });

  tally = await votes();
  const rows = tally.body.votes;
  assert.strictEqual(rows[0].venue_name, 'The Members Pick',
    'the members still hold the top row: a tie breaks toward the people with names on it');
  assert.strictEqual(rows[0].vote_count, 3);
  assert.strictEqual(rows[1].venue_name, 'The Link Holders Pick');
  assert.strictEqual(rows[1].vote_count, 3,
    'fifty anonymous ballots weigh what the roster weighs, and no more');
  assert.strictEqual(rows[1].guest_count, 50,
    'and the raw count is still reported, so the UI can say what actually arrived');
  assert.strictEqual(rows[1].voters.length, 0);
  assertQueriesUnderstood();
});

test('FIXED V2: a real guest on a real flock still counts, one for one', async () => {
  as(1, 'Ava'); as(2, 'Bo'); as(3, 'Cy'); as(4, 'Di');
  for (const id of [1, 2, 3, 4]) world.members.push({ user_id: id, status: 'accepted' });
  as(1, 'Ava'); await vote('Taqueria');
  as(2, 'Bo'); await vote('Ramen');
  // Two friends without accounts RSVP through the link and pick the taqueria.
  world.guestVotes.push(
    { guest_rsvp_id: 1, venue_name: 'Taqueria', hidden: false },
    { guest_rsvp_id: 2, venue_name: 'Taqueria', hidden: false },
  );

  as(1, 'Ava');
  const tally = await votes();
  assert.deepStrictEqual(tally.body.votes.map((v) => [v.venue_name, v.vote_count, v.guest_count]),
    [['Taqueria', 3, 2], ['Ramen', 1, 0]],
    'under the roster size the cap does nothing: guests you actually invited still weigh in');
  assertQueriesUnderstood();
});

test('FIXED V3: a guest who said out does not count, the way a member who declined does not', async () => {
  // A guest vote counted whatever the guest's answer was, so two friends who
  // said they could not come still decided between the two places the people
  // coming were split on.
  as(1, 'Ava'); as(2, 'Bo');
  for (const id of [1, 2]) world.members.push({ user_id: id, status: 'accepted' });
  as(1, 'Ava'); await vote('Taqueria');
  as(2, 'Bo'); await vote('Ramen');
  world.guestVotes.push(
    { guest_rsvp_id: 1, venue_name: 'Ramen', hidden: false, out: true },
    { guest_rsvp_id: 2, venue_name: 'Ramen', hidden: false, out: true },
    { guest_rsvp_id: 3, venue_name: 'Taqueria', hidden: false },
  );

  as(1, 'Ava');
  const tally = await votes();
  assert.deepStrictEqual(tally.body.votes.map((v) => [v.venue_name, v.vote_count, v.guest_count]),
    [['Taqueria', 2, 1], ['Ramen', 1, 0]],
    'only the guest who is going weighs in');
  const guestSql = log.find((q) => /FROM guest_votes gv JOIN guest_rsvps gr/.test(q.sql)).sql;
  assert.match(guestSql, /WHERE gv\.flock_id = \$1 AND COALESCE\(gr\.is_hidden, false\) = false AND gr\.status = 'in'/);
  assertQueriesUnderstood();
});

// ═════════════════════════════════════════════════════════════════════════════
// WHAT HELD
// ═════════════════════════════════════════════════════════════════════════════

test('HELD: one member is one vote, however many times they post and however fast', async () => {
  as(1, 'Ava'); as(2, 'Bo');
  world.members.push({ user_id: 1, status: 'accepted' }, { user_id: 2, status: 'accepted' });

  as(1, 'Ava');
  await vote('A');
  await vote('B');
  await vote('C');
  await Promise.all([vote('D'), vote('E'), vote('D')]);

  assert.strictEqual(world.votes.filter((v) => v.user_id === 1).length, 1,
    'switching venues replaces the row, it never stacks');
  assertQueriesUnderstood();
});

test('HELD: a departed member takes their vote out of the tally with them (round 17)', async () => {
  as(1, 'Ava'); as(2, 'Bo');
  world.members.push({ user_id: 1, status: 'accepted' }, { user_id: 2, status: 'accepted' });
  as(2, 'Bo'); await vote('Bo\'s Bar');
  as(1, 'Ava'); await vote('Ava\'s Place');

  let tally = await votes();
  assert.strictEqual(tally.body.votes.length, 2);

  // Bo leaves: POST /api/flocks/:id/leave deletes the flock_members row and
  // nothing else, so the venue_votes row is still in the table.
  world.members = world.members.filter((m) => m.user_id !== 2);
  assert.ok(world.votes.some((v) => v.user_id === 2), 'the row really is still there');

  as(1, 'Ava');
  tally = await votes();
  assert.deepStrictEqual(tally.body.votes.map((v) => v.venue_name), ['Ava\'s Place'],
    'but the tally joins flock_members, so it does not count');
  assertQueriesUnderstood();
});

test('HELD: a non-member can neither read nor write the tally', async () => {
  as(1, 'Ava');
  world.members.push({ user_id: 1, status: 'accepted' });
  as(99, 'Outsider');
  assert.strictEqual((await vote('Anywhere')).status, 403);
  assert.strictEqual((await votes()).status, 403);
  assert.strictEqual((await call('DELETE', `/api/flocks/${FLOCK}/vote`)).status, 403);
  assert.strictEqual(world.votes.length, 0);
  assertQueriesUnderstood();
});

test('HELD: an INVITED member who has not accepted cannot vote', async () => {
  as(1, 'Ava'); as(2, 'Bo');
  world.members.push({ user_id: 1, status: 'accepted' }, { user_id: 2, status: 'invited' });
  as(2, 'Bo');
  assert.strictEqual((await vote('Bo picks')).status, 403);
  assertQueriesUnderstood();
});
