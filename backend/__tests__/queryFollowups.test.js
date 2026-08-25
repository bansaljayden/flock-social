// Run: node --test  (from backend/)
//
// Two follow-ups from the query-reliability round, both in the same shape: a
// bound that was reasoned about and then not applied, and a catch that was
// wider than the reason it was written for.
//
//   1. routes/flocks.js — MAX_FLOCK_ROWS, the second ceiling on a flock.
//   2. routes/venues.js — collectVoteRows' guest-vote catch.
//
// ─────────────────────────────────────────────────────────────────────────────
// 1. THE SECOND CEILING ON A FLOCK: ROWS, NOT SEATS
// ─────────────────────────────────────────────────────────────────────────────
//
// routes/flocks.js has always had MAX_FLOCK_MEMBERSHIPS (50), and it counts only
// `invited` and `accepted` rows. That is deliberate and it stays: somebody who
// said no is not occupying the plan, so declining has to give the seat back.
//
// The consequence nobody had bounded is that a DECLINED row is still a row, and
// both roster reads in that file (GET /:id and GET /:id/members) return EVERY
// row for the flock — no status filter, no LIMIT, each joined to `users` for a
// name and an avatar. So "invite 50, they all decline, invite 50 more" grew the
// roster payload without limit while the seat cap sat there reading 0 of 50, and
// every member paid for it on every load of the flock.
//
// MAX_FLOCK_ROWS (200) is that bound. What this file pins is not the number, it
// is the four properties that make the number safe to have:
//
//   1. It counts declined rows. (Otherwise it is the seat cap again.)
//   2. It is charged ONLY on a brand-new row, so re-inviting somebody who
//      declined — the one call that reuses a row instead of adding one — still
//      works at the ceiling. This is the difference between `continue` and
//      `break` in the loop, and it is the property most likely to be lost.
//   3. It does not cost a second round trip: the seat count and the row count
//      come back from ONE statement.
//   4. The seat count is unchanged by its arrival. The row count and the seat
//      count ask different questions of the same table and a fixture that
//      answered both from the same filter would hide it, so the dispatcher
//      below reads the predicates out of the SQL and evaluates them, rather than
//      knowing in advance what the statement is supposed to say.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

process.env.JWT_SECRET = 'invite-row-ceiling-test-secret';
delete process.env.FIREBASE_SERVICE_ACCOUNT;

const pool = require('../config/database');

// The two ceilings in routes/flocks.js. Literals, because neither constant is
// exported; if either moves, the tests below fail loudly rather than drifting.
const MAX_FLOCK_MEMBERSHIPS = 50;
const MAX_FLOCK_ROWS = 200;

const FLOCK_ID = 7;
const ME = 1;

let members;   // Map<user_id, status> — the flock_members table for FLOCK_ID
let log;       // every statement, flattened
let writes;
let unknown;
let memberVotes;       // rows the venue_votes tally returns
let guestVotes;        // rows the guest_votes tally returns
let guestVoteFailure;  // an Error the guest-vote query rejects with, or null

function reset() {
  members = new Map([[ME, 'accepted']]);
  log = [];
  writes = [];
  unknown = [];
  memberVotes = [{ venue_name: 'The Fig', venue_id: 'ChIJfig', member_count: 1, voter_rows: [{ id: ME, name: 'Ava' }] }];
  guestVotes = [{ venue_name: 'The Fig', guest_count: 2 }];
  guestVoteFailure = null;
  flocksRouter.__resetBudgets();
}

const pgError = (code) => Object.assign(new Error(`pg ${code}`), { code });

// ── The roster-size statement, INTERPRETED ──────────────────────────────────
//
// The route asks for both ceilings in one statement:
//
//   SELECT (SELECT COUNT(*)::int FROM flock_members WHERE <predA>) AS total,
//          COUNT(*)::int AS n FROM flock_members WHERE <predB>
//
// A fixture that returned { n: seats, total: all } from a hardcoded filter would
// stay green if somebody swapped the two predicates, dropped the status filter
// off the seat count, or scoped either one to the wrong flock — it would be
// testing what the statement was MEANT to say. So each predicate is pulled out
// of the text and evaluated against the fixture table the way Postgres would.
function evalPredicate(where, params) {
  // Flock scoping. `flock_id = $1` against the parameter actually passed.
  const flockMatch = /flock_id = \$(\d+)/.exec(where);
  if (!flockMatch) throw new Error(`roster-size predicate is not scoped to a flock: ${where}`);
  if (Number(params[Number(flockMatch[1]) - 1]) !== FLOCK_ID) return () => false;

  // Optional status filter: IN ('a', 'b').
  const statusMatch = /status IN \(([^)]*)\)/.exec(where);
  const allowed = statusMatch
    ? statusMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))
    : null;

  return (status) => (allowed === null ? true : allowed.includes(status));
}

function rosterSizeRow(flat, params) {
  // The table may be aliased or not; the predicate is what is being read.
  const sub = /\(SELECT COUNT\(\*\)::int FROM flock_members(?: \w+)? WHERE (.*?)\) AS total/.exec(flat);
  const outer = /COUNT\(\*\)::int AS n FROM flock_members(?: \w+)? WHERE (.+?)$/.exec(flat);
  assert.ok(sub, `no total-rows subquery in the roster-size statement: ${flat}`);
  assert.ok(outer, `no seat COUNT in the roster-size statement: ${flat}`);

  const countsTotal = evalPredicate(sub[1], params);
  const countsSeat = evalPredicate(outer[1], params);

  let total = 0;
  let n = 0;
  for (const status of members.values()) {
    if (countsTotal(status)) total += 1;
    if (countsSeat(status)) n += 1;
  }
  return { total, n };
}

// ── Fixture-backed pool ─────────────────────────────────────────────────────
pool.query = async (text, params = []) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  log.push({ sql: flat, params });
  const has = (f) => flat.includes(f);
  if (/^(INSERT|UPDATE|DELETE)/i.test(flat)) writes.push({ sql: flat, params });

  if (has("SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'")) {
    const ok = Number(params[0]) === FLOCK_ID && members.get(Number(params[1])) === 'accepted';
    return { rows: ok ? [{ id: 1 }] : [], rowCount: ok ? 1 : 0 };
  }
  if (has('SELECT id, name FROM flocks WHERE id = $1')) {
    return Number(params[0]) === FLOCK_ID
      ? { rows: [{ id: FLOCK_ID, name: 'Friday' }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }
  if (has('AS total') && has('FROM flock_members')) {
    return { rows: [rosterSizeRow(flat, params)], rowCount: 1 };
  }
  // The invite path reads the roster, the directory and the block set ONE set at
  // a time now, not one row at a time. Each branch below answers EXACTLY what
  // the per-row branch it replaced answered, id for id — this file's ceiling
  // arithmetic is asserted to the row, so anything else would show up as a
  // different number rather than as a green test.
  if (has('SELECT user_id, status FROM flock_members WHERE flock_id = $1 AND user_id = ANY($2::int[])')) {
    // Scoped to the flock the same way Postgres would scope it: asked about
    // another flock, this table has nothing to say.
    if (Number(params[0]) !== FLOCK_ID) return { rows: [], rowCount: 0 };
    const asked = new Set((params[1] || []).map(Number));
    const rows = [...members.entries()]
      .filter(([uid]) => asked.has(uid))
      .map(([user_id, status]) => ({ user_id, status }));
    return { rows, rowCount: rows.length };
  }
  if (has('SELECT id, name FROM users WHERE id = ANY($1::int[])')) {
    // The per-row branch answered a row for every id it was handed (there is no
    // user directory in this file — every id exists), so this returns a row for
    // every id in the array and no others.
    const rows = (params[0] || []).map((id) => ({ id: Number(id), name: `User${Number(id)}` }));
    return { rows, rowCount: rows.length };
  }
  if (has('FROM user_blocks')) return { rows: [], rowCount: 0 };

  // ── routes/venues.js, collectVoteRows ────────────────────────────────────
  if (has('FROM venue_votes vv')) return { rows: memberVotes, rowCount: memberVotes.length };
  if (has('FROM guest_votes gv')) {
    if (guestVoteFailure) throw guestVoteFailure;
    return { rows: guestVotes, rowCount: guestVotes.length };
  }

  if (has('INSERT INTO flock_members')) {
    // One statement over an id ARRAY now (UNNEST), so the row-by-row rule is
    // applied per element and the rowCount is the number of rows that really
    // landed. ON CONFLICT DO NOTHING: an id that already has a row is not a new
    // row — unchanged, just applied to each id instead of to the only id.
    const ids = Array.isArray(params[1]) ? params[1].map(Number) : [Number(params[1])];
    let affected = 0;
    for (const uid of ids) {
      if (members.has(uid)) continue;
      members.set(uid, 'invited');
      affected += 1;
    }
    return { rows: [], rowCount: affected };
  }
  if (has("UPDATE flock_members SET status = 'invited'")) {
    // Honour the statement's own `AND status = 'declined'` guard, so the SQL
    // predicate is exercised rather than merely present. Same per-id rule as
    // before; the id list is now `user_id = ANY($2::int[])`, so a statement that
    // dropped the guard would still promote a non-declined row here and the
    // demotion test would still catch it.
    // Flock scope, read out of the statement rather than assumed. This table
    // holds one flock, so a fixture that just applied the update would answer
    // identically for a statement that had lost `flock_id = $1` — and that
    // statement promotes a declined row in EVERY flock the person has ever been
    // asked to, which is a silent re-invite from strangers.
    assert.match(flat, /WHERE flock_id = \$1 AND/,
      'the re-invite UPDATE must still be scoped to one flock');
    if (Number(params[0]) !== FLOCK_ID) return { rows: [], rowCount: 0 };
    const ids = Array.isArray(params[1]) ? params[1].map(Number) : [Number(params[1])];
    const guarded = /AND status = 'declined'/.test(flat);
    let affected = 0;
    for (const uid of ids) {
      if (!members.has(uid)) continue;
      if (guarded && members.get(uid) !== 'declined') continue;
      members.set(uid, 'invited');
      affected += 1;
    }
    return { rows: [], rowCount: affected };
  }

  unknown.push(flat);
  return { rows: [], rowCount: 0 };
};
pool.connect = async () => ({ query: pool.query, release() {} });

// Replaced BEFORE the router is required — it destructures at module load.
const authMod = require('../middleware/auth');
authMod.authenticate = (req, _res, next) => {
  req.user = { id: ME, name: 'Ava', email_verified: true, role: 'user' };
  next();
};

const flocksRouter = require('../routes/flocks');
const venuesRouter = require('../routes/venues');

const app = express();
app.use(express.json());
app.set('io', null); // no fan-out and no push: this file counts the route's own work
// Both routers under /api/flocks, exactly as server.js mounts them.
app.use('/api/flocks', flocksRouter);
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
test.beforeEach(reset);

async function getVotes() {
  const res = await fetch(`${base}/api/flocks/${FLOCK_ID}/votes`, { headers: { 'Content-Type': 'application/json' } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body, text };
}

async function invite(ids) {
  const res = await fetch(`${base}/api/flocks/${FLOCK_ID}/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_ids: ids }),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body, text };
}

const assertQueriesUnderstood = () =>
  assert.deepStrictEqual(unknown, [], 'the fixture did not model one of the queries the route ran');

// Fill the flock with `n` declined rows, ids starting at 1000. Declined rows
// hold no seat, so this moves the ROW count and nothing else.
function fillDeclined(n, from = 1000) {
  for (let i = 0; i < n; i++) members.set(from + i, 'declined');
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Both ceilings, one statement
// ═══════════════════════════════════════════════════════════════════════════

test('the seat count and the row count come back from ONE round trip', async () => {
  fillDeclined(10);
  const res = await invite([500]);
  assert.strictEqual(res.status, 200, res.text);

  const rosterQueries = log.filter((q) => /AS total/.test(q.sql) && /FROM flock_members/.test(q.sql));
  assert.strictEqual(rosterQueries.length, 1,
    'a second ceiling must not cost a second query — this read is on the hot path of every invite');
  assertQueriesUnderstood();
});

test('the two counts ask DIFFERENT questions of the same table', async () => {
  // 1 accepted + 10 declined. Seats used = 1, rows used = 11. If either
  // predicate were the other, or the status filter fell off the seat count,
  // these two numbers would be equal and the interpreter above would say so.
  fillDeclined(10);
  await invite([500]);

  const flat = log.find((q) => /AS total/.test(q.sql)).sql;
  const params = log.find((q) => /AS total/.test(q.sql)).params;
  const { n, total } = rosterSizeRow(flat, params);
  assert.strictEqual(n, 2, 'seats: the accepted host plus the one just invited');
  assert.strictEqual(total, 12, 'rows: the same two, plus the ten declines');
  assert.notStrictEqual(n, total, 'a declined row costs a row and no seat — that is the whole distinction');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Declined rows still give the seat back (the property that made the hole)
// ═══════════════════════════════════════════════════════════════════════════

test('declining still returns the seat, so a churned flock keeps inviting', async () => {
  fillDeclined(20);                       // 21 rows, 1 seat used
  const res = await invite(Array.from({ length: 10 }, (_, i) => 600 + i));
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.invited.length, 10,
    'the seat cap counts invited+accepted only; 20 declines must not have consumed 20 of 50 seats');
  assert.strictEqual(res.body.full, undefined);
  assertQueriesUnderstood();
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The row ceiling bites, and bites the right call
// ═══════════════════════════════════════════════════════════════════════════

test('a brand-new invite is refused once the flock is out of ROWS, with seats to spare', async () => {
  fillDeclined(MAX_FLOCK_ROWS - 1);       // 200 rows exactly, 1 seat used
  assert.strictEqual(members.size, MAX_FLOCK_ROWS);

  const res = await invite([500]);
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /as many people as it can hold/);
  assert.ok(!writes.some((w) => /INSERT INTO flock_members/.test(w.sql)),
    'no row may be written past the ceiling');

  // And it really was the ROW ceiling: 49 of the 50 seats were free.
  const { n } = rosterSizeRow(log.find((q) => /AS total/.test(q.sql)).sql,
    log.find((q) => /AS total/.test(q.sql)).params);
  assert.strictEqual(MAX_FLOCK_MEMBERSHIPS - n, 49, 'the seat cap was nowhere near being reached');
  assertQueriesUnderstood();
});

test('the person who declined can still be re-invited at the ceiling', async () => {
  // This is the `continue` rather than `break`, and it is the reason the ceiling
  // is charged on new ROWS instead of on invites: somebody changing their mind
  // reuses the row they already have, and must never be the one refused by a
  // limit that exists because of rows like theirs.
  fillDeclined(MAX_FLOCK_ROWS - 1);
  const someoneWhoDeclined = 1000;
  assert.strictEqual(members.get(someoneWhoDeclined), 'declined');

  const res = await invite([someoneWhoDeclined]);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.invited, [{ user_id: someoneWhoDeclined, user_name: 'User1000' }]);
  assert.strictEqual(members.get(someoneWhoDeclined), 'invited');

  // Re-invite is an UPDATE of the existing row, never an INSERT of a new one.
  assert.ok(writes.some((w) => /UPDATE flock_members SET status = 'invited'/.test(w.sql)));
  assert.ok(!writes.some((w) => /INSERT INTO flock_members/.test(w.sql)));
  assert.strictEqual(members.size, MAX_FLOCK_ROWS, 'and the table did not grow');
  assertQueriesUnderstood();
});

test('in one call, the re-invite survives the ceiling and the brand-new id does not', async () => {
  // The mixed case is where `break` would have been wrong: refusing 500 must not
  // also refuse 1000, whose row already exists. Order matters — the new id is
  // listed FIRST, so a `break` here would swallow the re-invite behind it.
  fillDeclined(MAX_FLOCK_ROWS - 1);
  const res = await invite([500, 1000]);

  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.invited.map((i) => i.user_id), [1000],
    'the new row is refused; the reused one goes through');
  assert.strictEqual(res.body.full, true, 'and the caller is told the flock is out of room');
  assert.ok(!members.has(500));
  assert.strictEqual(members.get(1000), 'invited');
  assertQueriesUnderstood();
});

test('the ceiling is charged as rows are created, not only as the request starts', async () => {
  // Two seats and four rows short of the ceiling, asked for six new people: the
  // first four land and the last two do not. A ceiling read once and never
  // decremented would have let all six through, since the roster read at the top
  // of the request says there is room.
  fillDeclined(MAX_FLOCK_ROWS - 5);       // 196 rows, 1 seat used
  const res = await invite([701, 702, 703, 704, 705, 706]);

  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.invited.map((i) => i.user_id), [701, 702, 703, 704]);
  assert.strictEqual(res.body.full, true);
  assert.strictEqual(members.size, MAX_FLOCK_ROWS);
  assertQueriesUnderstood();
});

test('re-invites in the same call do not eat the rows the new people need', async () => {
  // The other half of "charged only on a brand-new row", and the half a
  // decrement written one line too wide gets wrong: if a re-invite spends a row
  // it does not use, then a call that re-invites two people who declined and
  // then invites one new one runs the counter to zero on the way and refuses the
  // new person for no reason at all. Two rows to spare, two re-invites and one
  // new invite: all three must go through.
  fillDeclined(MAX_FLOCK_ROWS - 3);       // 198 rows, 2 to spare, 1 seat used
  const res = await invite([1000, 1001, 500]);

  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.invited.map((i) => i.user_id), [1000, 1001, 500],
    'two reused rows and one new one fit in a flock with two rows left');
  assert.strictEqual(res.body.full, undefined, 'nothing was refused');
  assert.strictEqual(members.size, MAX_FLOCK_ROWS - 1,
    'and only ONE row was actually added: 198 rows in, 199 out, not 201');
  assertQueriesUnderstood();
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The refusal tells an outsider nothing
// ═══════════════════════════════════════════════════════════════════════════

test('out of seats and out of rows are the same answer', async () => {
  // Two different facts about a flock, one of which ("how many people have said
  // no to this") is nobody's business. Same status, same body.
  for (let i = 0; i < MAX_FLOCK_MEMBERSHIPS - 1; i++) members.set(2000 + i, 'invited');
  const seatFull = await invite([500]);

  reset();
  fillDeclined(MAX_FLOCK_ROWS - 1);
  const rowFull = await invite([500]);

  assert.strictEqual(seatFull.status, 400);
  assert.strictEqual(rowFull.status, 400);
  assert.deepStrictEqual(seatFull.body, rowFull.body);
  assertQueriesUnderstood();
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. routes/venues.js — the guest-vote catch, narrowed to its reason
// ═══════════════════════════════════════════════════════════════════════════
//
// collectVoteRows' guest-vote query ended in `.catch(() => ({ rows: [] }))`.
// The fail-open is deliberate and it stays, but the catch was far wider than the
// reason for it: a connection reset, a statement timeout or a permissions error
// was swallowed exactly as readily as the case it was written for, and the
// member-facing tally then reported ZERO guest votes as though that were the
// answer. The venue a flock actually goes to is decided by this tally, so a
// silent drop does not degrade a number on a screen — it changes where people
// end up, and leaves nothing behind to say it happened.
//
// The reason it was written for is a database that has not run the migrations
// these tables came from (guest_votes/guest_rsvps in 001, guest_rsvps.is_hidden
// in 005): undefined_table (42P01) and undefined_column (42703). On such a
// deploy there are no guest votes to miss, so answering with none is correct.

test('guest votes count toward the tally members see, up to what the members have cast', async () => {
  // The game-rule abuse round capped the guest WEIGHT at the total number of
  // member votes in the flock (floor of 1), because guest_votes rows have no
  // identity behind them and routes/guest.js caps RSVPs at 50 per FLOCK, not
  // per person: one holder of the share link used to outvote the whole roster.
  // This fixture has one member vote, so two guest votes weigh one between
  // them. guest_count still reports both, which is the number the UI shows.
  const res = await getVotes();
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.body.votes, [{
    venue_name: 'The Fig', venue_id: 'ChIJfig', vote_count: 2, guest_count: 2,
    voters: [{ id: ME, name: 'Ava' }],
  }]);
  assertQueriesUnderstood();
});

test('an unmigrated database still answers, with the member votes it does have', async () => {
  for (const code of ['42P01', '42703']) {
    reset();
    guestVoteFailure = pgError(code);
    const res = await getVotes();
    assert.strictEqual(res.status, 200, `${code}: ${res.text}`);
    assert.strictEqual(res.body.votes.length, 1, code);
    assert.strictEqual(res.body.votes[0].guest_count, 0, `${code}: there are no guest votes to report`);
    assert.strictEqual(res.body.votes[0].vote_count, 1, `${code}: the member votes are still counted`);
  }
});

test('a connection failure is an error, not a tally with the guests quietly removed', async () => {
  // The bug, stated as the test: with the wide catch this answered 200 and
  // "The Fig, 1 vote" — the same shape as a truthful answer, one vote short,
  // with nothing in the response or the logs to distinguish the two.
  for (const failure of [pgError('ECONNRESET'), pgError('57014'), new Error('Connection terminated unexpectedly')]) {
    reset();
    guestVoteFailure = failure;
    const res = await getVotes();
    assert.strictEqual(res.status, 500,
      `a ${failure.code || 'codeless'} failure must not be served as a complete tally`);
    assert.ok(!res.text.includes('vote_count'), 'and no tally may be handed back at all');
  }
});
