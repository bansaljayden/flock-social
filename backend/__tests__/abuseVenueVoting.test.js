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
function assertQueriesUnderstood() {
  assert.deepStrictEqual(unknown, [], `unmodelled queries: ${JSON.stringify(unknown.slice(0, 3))}`);
}

async function dispatch(sql, params) {
  const flat = String(sql).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  const p = params || [];
  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(flat)) return { rows: [], rowCount: 0 };
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
    return world.flock ? { rows: [{ status: world.flock.status }], rowCount: 1 } : { rows: [], rowCount: 0 };
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
  if (/^DELETE FROM venue_votes WHERE flock_id = \$1 AND user_id = \$2 RETURNING venue_name$/.test(flat)) {
    const gone = world.votes.filter((v) => v.user_id === Number(p[1]));
    world.votes = world.votes.filter((v) => v.user_id !== Number(p[1]));
    return { rows: gone.map((v) => ({ venue_name: v.venue_name })), rowCount: gone.length };
  }
  if (/^INSERT INTO venue_votes/.test(flat)) {
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
  // guest tally
  if (/FROM guest_votes gv JOIN guest_rsvps gr/.test(flat)) {
    const byName = new Map();
    for (const g of world.guestVotes) {
      if (g.hidden) continue;
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

test.beforeEach(() => { world = freshWorld(); log = []; unknown = []; });

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
  assert.match(guestSrc, /if \(count\.rows\[0\]\.n >= 50\)/, 'the cap, read from the route');
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
