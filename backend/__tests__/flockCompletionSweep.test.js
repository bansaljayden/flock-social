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

const db = { log: [], fail: false, rowCount: 0 };
pool.query = (sql, params) => {
  if (db.fail) return Promise.reject(new Error('connection terminated unexpectedly'));
  db.log.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params || [] });
  return Promise.resolve({ rows: [], rowCount: db.rowCount });
};

const sweep = require('../services/flockSweep');
const { runFlockCompletionSweep, flockSweepEnabled, graceHours, DEFAULT_GRACE_HOURS } = sweep;

function reset() {
  db.log = [];
  db.fail = false;
  db.rowCount = 0;
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
  assert.match(sql, /SET status = 'completed'/i);
  // The three halves of the predicate, each of which is a separate way to
  // close a plan that is not over.
  assert.match(sql, /WHERE status = 'confirmed'/i);
  assert.match(sql, /event_time IS NOT NULL/i);
  assert.match(sql, /event_time < NOW\(\) - make_interval\(hours => \$1::int\)/i);
});

test('a planning flock is never swept, however old it is', async () => {
  reset();
  await runFlockCompletionSweep();
  // 'planning' is the status every flock in production is stuck at, and a plan
  // nobody ever confirmed did not happen. Completing it would invent an
  // outcome and would put it in everyone's history.
  assert.ok(!/status IN|status <>|status !=/i.test(lastSql()),
    'the predicate must be an equality on confirmed, not a set or a negation');
  assert.match(lastSql(), /status = 'confirmed'/);
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
  assert.deepEqual(db.log[0].params, [12]);
});

test('FLOCK_COMPLETE_AFTER_HOURS moves the window without a deploy', async () => {
  reset();
  process.env.FLOCK_COMPLETE_AFTER_HOURS = '6';
  await runFlockCompletionSweep();
  assert.deepEqual(db.log[0].params, [6]);
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
  assert.match(SERVER, /flockSweepInterval = setInterval\(runFlockCompletionSweep, FLOCK_SWEEP_INTERVAL_MS\)/);
  assert.match(SERVER, /flockSweepKickoff = setTimeout\(runFlockCompletionSweep/);
});

test('both handles are cleared in shutdown, so no sweep fires into a closing pool', () => {
  const start = SERVER.indexOf('function shutdown(');
  assert.ok(start > -1);
  const body = SERVER.slice(start, SERVER.indexOf('process.on(\'SIGTERM\'', start));
  assert.match(body, /clearInterval\(flockSweepInterval\)/);
  assert.match(body, /clearTimeout\(flockSweepKickoff\)/);
});

test('the sweep does not write a research_analytics row', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'flockSweep.js'), 'utf8');
  // Deliberate, and worth pinning: that row records `flock_completed: true` and
  // a time to confirmation, and for a swept flock nobody observed either. The
  // clock closed the plan, not a person. Only a host-driven completion through
  // PUT /api/flocks/:id writes it.
  assert.ok(!/INSERT INTO research_analytics/i.test(src));
});
