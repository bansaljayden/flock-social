'use strict';
// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE FLOCK COMPLETION SWEEP — services/flockSweep.js
// ---------------------------------------------------------------------------
//
// WHY THIS FILE EXISTS AT ALL. Until 2026-08-25 no flock in the product had
// ever reached status 'completed' through any path a user could walk. The only
// control that wrote 'confirmed' was a socket event the frontend never emitted,
// so `isConfirmed` was permanently false, so the slide-to-complete bar never
// rendered, so nothing was ever completed, so attendance was never marked, so
// no reliability score was ever written, and GET /api/flocks/history answered
// [] for every account. The whole back half of the product had never been
// exercised end to end. The frontend half of that fix is pinned in
// frontend/src/__tests__/planLifecycleAndVenueTruth.test.js; this is the half
// that makes a finished night finish on its own.
//
// What is pinned here:
//   1. THE PREDICATE. Only 'confirmed', only with an event_time, only past the
//      grace window. Each of those three is a way to close a plan that is not
//      over: a planning flock nobody confirmed, a confirmed flock with no time
//      on it (there is no night to be past), and tonight's plan an hour after
//      it started.
//   2. IDEMPOTENCE. The sweep runs every 30 minutes, restarts on every deploy,
//      and may run on two instances at once. Matching only 'confirmed' is what
//      makes a second pass a no-op instead of a rewrite.
//   3. IT NEVER REJECTS. It runs inside setInterval, where an unhandled
//      rejection is a process crash on a timer.
//   4. THE GRACE WINDOW IS BOUNDED. A typo in FLOCK_COMPLETE_AFTER_HOURS must
//      not close every plan in the database an hour after it starts.
//   5. THE SCHEDULE IS REAL. A job that exists but was never registered is
//      worth nothing, so server.js is read: registered beside its siblings and
//      cleared in shutdown() so a sweep cannot fire into a closing pool.
//
// No database. pool.query is replaced with a recorder, because everything under
// test here is which rows the statement claims and when it is allowed to run.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pool = require('../config/database');

const db = { log: [], fail: false, rowCount: 0, rowsByCall: null };
pool.query = (sql, params) => {
  if (db.fail) return Promise.reject(new Error('connection terminated unexpectedly'));
  db.log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
  // rowsByCall, when set, hands each successive query its own rows; the
  // default recorder answers empty rows with a configurable rowCount, which
  // every predicate test relies on.
  const rows = db.rowsByCall ? (db.rowsByCall.shift() || []) : [];
  return Promise.resolve({ rows, rowCount: db.rowsByCall ? rows.length : db.rowCount });
};

const sweep = require('../services/flockSweep');
const { runFlockCompletionSweep, flockSweepEnabled, graceHours, DEFAULT_GRACE_HOURS } = sweep;

function reset() {
  db.log = [];
  db.fail = false;
  db.rowCount = 0;
  db.rowsByCall = null;
  delete process.env.FLOCK_COMPLETE_AFTER_HOURS;
  delete process.env.FLOCK_SWEEP_ENABLED;
}

const lastSql = () => db.log[db.log.length - 1].sql;

// ═══════════════════════════════════════════════════════════════════════════
// 1. The predicate
// ═══════════════════════════════════════════════════════════════════════════

test('the sweep moves confirmed flocks to completed and touches nothing else', async () => {
  reset();
  await runFlockCompletionSweep();
  assert.equal(db.log.length, 1, 'one statement per sweep');
  const sql = lastSql();
  assert.match(sql, /UPDATE flocks/i);
  assert.match(sql, /SET status = CASE WHEN status = 'confirmed' THEN 'completed' ELSE 'cancelled' END/i);
  // The three halves of the predicate, each of which is a separate way to
  // close a plan that is not over.
  assert.match(sql, /WHERE status IN \('planning', 'confirmed'\)/i);
  assert.match(sql, /event_time IS NOT NULL/i);
  // NOT bare NOW(). event_time is TIMESTAMP WITHOUT TIME ZONE holding a UTC
  // wall clock (the writers in App.js all send .toISOString(), and Postgres
  // drops the Z on the way into a naive column). Compared against NOW(), which
  // is a timestamptz, Postgres casts the naive side at the DATABASE SESSION's
  // TimeZone, so the grace window was being measured on whatever zone the
  // Postgres server is configured for. It is UTC on Railway, so the arithmetic
  // came out right by coincidence; on a server set to America/New_York every
  // plan in the product would have closed four hours late, uniformly and
  // invisibly. Both sides must be naive UTC.
  assert.match(sql, /event_time < \(NOW\(\) AT TIME ZONE 'UTC'\) - make_interval\(hours => \$1::int\)/i,
    'the comparison must not depend on the Postgres session TimeZone');
});

test('one pass is a bounded loop of bounded statements, not one unbounded UPDATE', async () => {
  reset();
  // config/database.js caps every pooled statement at 15 seconds. An UPDATE
  // over a backlog too big to write inside that is killed with NOTHING
  // committed, and the next pass thirty minutes later inherits exactly the same
  // backlog and fails exactly the same way, forever. The first pass on a
  // database that has been running without this sweep is precisely that
  // backlog, and so is a restored backup.
  db.rowCount = sweep.SWEEP_BATCH_SIZE;
  const moved = await runFlockCompletionSweep();
  assert.match(db.log[0].sql, /LIMIT \$2::int/i, 'the statement must carry a row limit');
  assert.equal(db.log[0].params[1], sweep.SWEEP_BATCH_SIZE);
  assert.equal(db.log.length, sweep.SWEEP_MAX_BATCHES,
    'a full batch means more may remain, so the pass keeps going until it is capped');
  assert.equal(moved, sweep.SWEEP_BATCH_SIZE * sweep.SWEEP_MAX_BATCHES);
});

test('a short batch ends the pass, so the steady state is still one statement', async () => {
  reset();
  db.rowCount = 2;
  const moved = await runFlockCompletionSweep();
  assert.equal(moved, 2);
  assert.equal(db.log.length, 1, 'only a FULL batch can have left anything behind');
});

test('a failure part way through reports the batches that did commit', async () => {
  reset();
  // Each batch is its own statement and commits on its own, so a timeout costs
  // the batch it was in and not the 9,500 rows already written. Reporting zero
  // would say the pass achieved nothing.
  db.rowCount = sweep.SWEEP_BATCH_SIZE;
  let calls = 0;
  const real = pool.query;
  pool.query = (sql, params) => {
    calls += 1;
    if (calls > 2) return Promise.reject(new Error('canceling statement due to statement timeout'));
    return real(sql, params);
  };
  const moved = await runFlockCompletionSweep();
  pool.query = real;
  assert.equal(moved, sweep.SWEEP_BATCH_SIZE * 2);
});

test('a planning flock past its night is cancelled, never completed', async () => {
  reset();
  await runFlockCompletionSweep();
  // 'planning' is the status every flock in production is stuck at, and a plan
  // nobody ever confirmed did not happen. Completing it would invent an
  // outcome; leaving it forever (the rule until 2026-09-05) kept it on the
  // Nest as "Time passed" with no exit. Cancelled says what is true.
  const sql = lastSql();
  assert.match(sql, /WHERE status IN \('planning', 'confirmed'\)/);
  assert.match(sql, /CASE WHEN status = 'confirmed' THEN 'completed' ELSE 'cancelled' END/);
  assert.ok(!/status <>|status !=/i.test(sql), 'a set of two, never a negation that would sweep completed rows');
  assert.match(sql, /RETURNING id, status/);
});

test('the grace window is measured from event_time, not from created_at', async () => {
  reset();
  await runFlockCompletionSweep();
  assert.ok(!/created_at/i.test(lastSql()),
    'created_at is when the plan was made, which says nothing about when its night ended');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Idempotence
// ═══════════════════════════════════════════════════════════════════════════

test('a second pass has nothing left to move', async () => {
  reset();
  db.rowCount = 3;
  const first = await runFlockCompletionSweep();
  assert.equal(first, 3);
  // The statement itself is the guarantee: the rows it just wrote are no
  // longer 'confirmed', so the identical statement matches none of them. Two
  // instances running the same tick collide on the row lock, not on the data.
  db.rowCount = 0;
  const second = await runFlockCompletionSweep();
  assert.equal(second, 0);
  assert.equal(db.log[0].sql, db.log[1].sql, 'the sweep is one fixed statement');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. It never rejects
// ═══════════════════════════════════════════════════════════════════════════

test('a database failure resolves instead of crashing the timer', async () => {
  reset();
  db.fail = true;
  const n = await runFlockCompletionSweep();
  assert.equal(n, 0, 'a failed sweep reports nothing moved');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The grace window
// ═══════════════════════════════════════════════════════════════════════════

test('the default window is twelve hours, so a 9 PM plan closes the next morning', async () => {
  reset();
  assert.equal(DEFAULT_GRACE_HOURS, 12);
  assert.equal(graceHours(), 12);
  await runFlockCompletionSweep();
  assert.deepEqual(db.log[0].params, [12, sweep.SWEEP_BATCH_SIZE]);
});

test('FLOCK_COMPLETE_AFTER_HOURS moves the window without a deploy', async () => {
  reset();
  process.env.FLOCK_COMPLETE_AFTER_HOURS = '6';
  await runFlockCompletionSweep();
  assert.deepEqual(db.log[0].params, [6, sweep.SWEEP_BATCH_SIZE]);
});

test('an unreadable or out-of-range window falls back to the default', () => {
  for (const bad of ['', '   ', 'soon', '0', '-4', '100000', 'NaN']) {
    reset();
    process.env.FLOCK_COMPLETE_AFTER_HOURS = bad;
    assert.equal(graceHours(), DEFAULT_GRACE_HOURS,
      `"${bad}" must not become the live grace window`);
  }
});

test('the sweep can be switched off, and is on unless it is', async () => {
  reset();
  assert.equal(flockSweepEnabled(), true, 'default ON');
  process.env.FLOCK_SWEEP_ENABLED = 'false';
  assert.equal(flockSweepEnabled(), false);
  const n = await runFlockCompletionSweep();
  assert.equal(n, 0);
  assert.equal(db.log.length, 0, 'a disabled sweep issues no statement at all');
  reset();
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The schedule is real
// ═══════════════════════════════════════════════════════════════════════════

const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('the sweep is registered on a timer in server.js', () => {
  assert.match(SERVER, /require\('\.\/services\/flockSweep'\)/);
  assert.match(SERVER, /flockSweepInterval = setInterval\(\(\) => runFlockCompletionSweep\(io\), FLOCK_SWEEP_INTERVAL_MS\)/);
  assert.match(SERVER, /flockSweepKickoff = setTimeout\(\(\) => runFlockCompletionSweep\(io\)/);
});

test('both handles are cleared in shutdown, so no sweep fires into a closing pool', () => {
  const start = SERVER.indexOf('function shutdown(');
  assert.ok(start > -1);
  const body = SERVER.slice(start, SERVER.indexOf('process.on(\'SIGTERM\'', start));
  assert.match(body, /clearInterval\(flockSweepInterval\)/);
  assert.match(body, /clearTimeout\(flockSweepKickoff\)/);
});

test('a swept flock is announced to its members over their user rooms', async () => {
  // The row move alone left every open app showing Locked In until a cold
  // reload; flock_updated had only ever fired from the host-driven PUT. The
  // sweep now fans out per accepted member, and treats io as optional so the
  // predicate tests above (which pass none) run exactly as before.
  reset();
  db.rowsByCall = [
    [{ id: 7 }, { id: 9 }],
    [{ flock_id: 7, user_id: 1 }, { flock_id: 7, user_id: 2 }, { flock_id: 9, user_id: 1 }],
  ];
  const emits = [];
  const io = { to: (room) => ({ emit: (event, payload) => emits.push({ room, event, payload }) }) };
  const n = await runFlockCompletionSweep(io);
  assert.strictEqual(n, 2);
  const memberQuery = db.log.find((q) => q.sql.includes('FROM flock_members'));
  assert.ok(memberQuery, 'members are read for the fan-out');
  assert.deepStrictEqual(memberQuery.params[0], [7, 9]);
  // Invitees hear it too, so a stale invite card leaves (lifecycle audit).
  assert.match(memberQuery.sql, /status IN \('accepted', 'invited'\)/);
  assert.deepStrictEqual(emits, [
    { room: 'user:1', event: 'flock_updated', payload: { flockId: 7, status: 'completed' } },
    { room: 'user:2', event: 'flock_updated', payload: { flockId: 7, status: 'completed' } },
    { room: 'user:1', event: 'flock_updated', payload: { flockId: 9, status: 'completed' } },
  ]);
});

test('a fan-out failure never reaches the timer, and the move still counts', async () => {
  reset();
  db.rowsByCall = [[{ id: 4 }], [{ flock_id: 4, user_id: 8 }]];
  const io = { to: () => { throw new Error('adapter gone'); } };
  const n = await runFlockCompletionSweep(io);
  assert.strictEqual(n, 1, 'the committed move is reported despite the failed fan-out');
});

test('the sweep does not write a research_analytics row', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'flockSweep.js'), 'utf8');
  // Deliberate, and worth pinning: that row records `flock_completed: true` and
  // a time to confirmation, and for a swept flock nobody observed either. The
  // clock closed the plan, not a person. Only a host-driven completion through
  // PUT /api/flocks/:id writes it.
  assert.ok(!/INSERT INTO research_analytics/i.test(src));
});
