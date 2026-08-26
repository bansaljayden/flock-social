'use strict';
// Run: node --test  (from backend/)
//
// ---------------------------------------------------------------------------
// THE CROWD ALERT SWEEP: WHAT IT SCANS, HOW MUCH OF IT, AND WHAT ELSE RIDES
// ON ITS TIMER.
// ---------------------------------------------------------------------------
//
// services/crowdAlerts.js is the fifteen-minute timer registered in server.js.
// Three properties of it are invisible from the outside, which is the whole
// problem with a scheduled job: nobody is watching it, and it answers no
// request, so every one of these fails silently and forever.
//
//   1. THE CLOCK. `flocks.event_time` is TIMESTAMP WITHOUT TIME ZONE holding a
//      UTC wall clock. Compared against NOW(), a timestamptz, Postgres casts
//      the naive side at the DATABASE SESSION's TimeZone, so the three-hour
//      pre-event window was measured on the Postgres server's zone rather than
//      on UTC. Railway's is UTC, so it landed correctly by coincidence. On a
//      database configured for anything else the window sits off by that offset
//      and the sweep alerts nobody, every night, with nothing in the log.
//
//   2. THE BOUND. Nothing capped the scan, and the caller walks the result one
//      flock at a time doing per-flock database and scoring work. Once a sweep
//      takes longer than the fifteen minutes between sweeps, setInterval starts
//      the next one on top of it. The claim row stops the overlap from
//      double-pushing anybody; nothing stops it from compounding.
//
//   3. THE PASSENGERS. sweepPushOutbox and sweepPushMaintenance have no timer
//      of their own. The outbox holds the app's quiet-hours deferrals and its
//      failed-delivery retries for EVERY push type, not just crowd alerts, so
//      the whole product's deferred push delivery is a side effect of this
//      function running. Anything that returns before them, including a future
//      CROWD_ALERTS_ENABLED flag of the kind flockSweep and nightContext both
//      have, takes that with it and says nothing.
//
// Source-read rather than executed: what is under test is which statement the
// sweep issues and what its body reaches, and the end-to-end harness that drives
// this function lives in __tests__/alertPreferences.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'services', 'crowdAlerts.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// The flock scan, isolated so a match cannot be satisfied by some other query
// in the file.
const SCAN = (() => {
  const m = /SELECT f\.id, f\.name[\s\S]*?LIMIT \$2\s*`/.exec(SRC);
  assert.ok(m, 'the flock scan is gone or has been reshaped past recognition. '
    + 'It is the statement that decides which flocks get a pre-event push at all.');
  return m[0];
})();

// ═══════════════════════════════════════════════════════════════════════════
// 1. The clock
// ═══════════════════════════════════════════════════════════════════════════

test('the pre-event window is measured in UTC, not in the database session zone', () => {
  assert.match(SCAN, /f\.event_time > \(NOW\(\) AT TIME ZONE 'UTC'\)/,
    'both sides of the comparison have to be naive UTC, because event_time is a '
    + 'naive column holding a UTC wall clock');
  assert.match(SCAN, /f\.event_time < \(NOW\(\) AT TIME ZONE 'UTC'\) \+ INTERVAL '3 hours'/);
  assert.ok(!/event_time [<>] NOW\(\)/.test(SCAN),
    'a bare NOW() against event_time silently borrows the Postgres session TimeZone');
});

test('the sweep and the completion sweep read the same column the same way', () => {
  // Two different jobs, one column, one storage convention. If either one of
  // them starts reading event_time in a different zone, one of them is wrong
  // and neither will say so.
  const sweep = fs.readFileSync(path.join(__dirname, '..', 'services', 'flockSweep.js'), 'utf8');
  assert.match(sweep, /NOW\(\) AT TIME ZONE 'UTC'/,
    'services/flockSweep.js compares the same column and must resolve it the same way');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The bound
// ═══════════════════════════════════════════════════════════════════════════

test('the scan is ordered by event time and limited, so one sweep cannot run into the next', () => {
  assert.match(SCAN, /ORDER BY f\.event_time/,
    'the soonest events are the ones a pre-event push is still useful for');
  assert.match(SCAN, /LIMIT \$2/, 'an unbounded scan makes the sweep as long as a busy Friday is');
  assert.match(SRC, /const MAX_FLOCKS_PER_SWEEP = \d+/);
});

test('the limit counts outstanding work only, or the soonest flocks starve', () => {
  // A flock sits inside its own three-hour window for twelve consecutive
  // sweeps after it is served. Ordering by event_time with no exclusion would
  // let those twelve reappearances occupy every slot under the limit and push
  // the flocks that still need alerting off the end of the list, permanently,
  // on exactly the busy night the limit exists for.
  assert.match(SCAN, /NOT EXISTS\s*\(\s*SELECT 1 FROM crowd_alert_sends s/,
    'the scan must exclude flocks that already hold a claim');
  assert.match(SCAN, /s\.alert_type = \$1/,
    'the exclusion is per alert type, not per flock, so a future second type is unaffected');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The passengers
// ═══════════════════════════════════════════════════════════════════════════

const CHECK_BODY = (() => {
  const m = /async function checkCrowdAlerts\(\) \{([\s\S]*?)\n\}/.exec(SRC);
  assert.ok(m, 'checkCrowdAlerts is gone from services/crowdAlerts.js');
  return m[1];
})();

test('the push outbox and push maintenance sweeps ride this timer', () => {
  assert.match(CHECK_BODY, /sweepPushOutbox\(\)/,
    'the outbox holds every quiet-hours deferral and every failed-delivery retry '
    + 'in the product. It has no timer of its own in the boot path.');
  assert.match(CHECK_BODY, /sweepPushMaintenance\(\)/);
  assert.match(SERVER, /crowdAlertsInterval = setInterval\(checkCrowdAlerts, 15 \* 60 \* 1000\)/,
    'and this is the only thing that calls them on a schedule');
});

test('nothing returns ahead of the passengers except the gate that makes them pointless', () => {
  // The one early return is `if (!isPushConfigured()) return;`, and it is
  // correct: with no Firebase there is nothing in the outbox to release and
  // nothing to maintain. Any OTHER early return added above them, a
  // CROWD_ALERTS_ENABLED flag of the kind services/flockSweep.js and
  // services/nightContext.js both carry being the obvious one, silently stops
  // the whole app's deferred push delivery along with the crowd alerts, and the
  // symptom is chat notifications that never arrive after 2 AM.
  const beforeOutbox = CHECK_BODY.slice(0, CHECK_BODY.indexOf('sweepPushOutbox'));
  const returns = beforeOutbox.match(/^[ \t]*if \(.*?\) return;/gm) || [];
  assert.deepStrictEqual(
    returns.map((r) => r.trim()),
    ['if (!isPushConfigured()) return;'],
    'a new early return here takes sweepPushOutbox and sweepPushMaintenance with it. '
    + 'Give them their own timer in server.js first.'
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. One bad flock does not cancel the rest
// ═══════════════════════════════════════════════════════════════════════════

test('the per-flock body is wrapped, so a single failure does not end the sweep', () => {
  const m = /async function processFlockAlert\(flock\) \{\s*try \{/.exec(SRC);
  assert.ok(m, 'processFlockAlert must open with try, because the caller awaits it inside a '
    + 'for loop wrapped in ONE try for the whole sweep: a rejection there cancels the '
    + 'alerts for every flock still behind it in the list');
  assert.match(SRC, /catch \(err\) \{\s*console\.error\(`\[CrowdAlerts\] Error processing flock/);
});
