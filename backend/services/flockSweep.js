'use strict';
// ---------------------------------------------------------------------------
// THE FLOCK COMPLETION SWEEP
// ---------------------------------------------------------------------------
// A confirmed plan whose night has been and gone becomes 'completed'.
//
// WHY THIS EXISTS. Nothing time-based moved a flock anywhere. The four other
// timers in server.js are crowd alerts, the night-context snapshot, the venue
// digest and the photo-cache prune; none of them touches a flock's status. The
// ONLY writer of 'completed' was the host sliding a bar on the plan screen, and
// that bar renders only on a confirmed flock. So a plan whose host never slid
// it stayed 'confirmed' forever: it sat in the plans list as a live plan for a
// night that ended weeks ago, GET /api/flocks/history never listed it, and the
// Past screen's empty state ("A flock lands here once its night has been and
// gone") was a promise nothing in the system kept.
//
// WHY TWELVE HOURS, AND NOT ONE OR FORTY-EIGHT.
// The window is a compromise between two real costs, in this order:
//   * The host's own slide is the PRIMARY path, because it is the only one
//     that opens the attendance sheet, and attendance is the only thing that
//     writes anybody a reliability score. Sweeping too soon takes that away
//     from a host who was going to do it. A night out ends in the small hours,
//     and people mark it in the morning.
//   * A plan for last night must not still be presenting itself as tonight's
//     plan when tonight arrives.
// Twelve hours after event_time satisfies both: a 9 PM plan completes at 9 AM
// the next morning, after any plausible end to the night and after the host has
// had the whole night to close it themselves, and well before the next evening.
// FLOCK_COMPLETE_AFTER_HOURS moves it without a deploy if that turns out wrong.
//
// WHOSE CLOCK CLOSES THE PLAN, AND WHY IT IS NOT THE VENUE'S.
// Twelve hours after an instant is twelve hours after that instant everywhere,
// so a 9 PM plan in Tokyo closes at 9 AM in Tokyo and a 9 PM plan in Philly
// closes at 9 AM in Philly with no timezone lookup at all. This sweep needs no
// venue clock, which is exactly why it must not accidentally be running on one.
//
// It nearly was. `flocks.event_time` is TIMESTAMP WITHOUT TIME ZONE
// (migrations/000_bootstrap.sql), and the three writers in App.js all send
// `.toISOString()`, so Postgres parses the string, DISCARDS the trailing Z and
// stores the UTC wall clock in a column that does not record that fact. The
// original predicate then compared that naive column against NOW(), which is a
// timestamptz. Postgres resolves a naive-versus-aware comparison by casting the
// naive side at the DATABASE SESSION'S TimeZone, so the sweep was reading
// event_time as local time in whatever zone the Postgres server happens to be
// configured for. It is UTC on Railway today and the arithmetic came out right
// by that coincidence; on a server set to America/New_York every plan in the
// product would have closed four hours late, uniformly, with nothing to see.
//
// `NOW() AT TIME ZONE 'UTC'` is the current instant rendered as a naive UTC
// timestamp, so both sides of the comparison are naive UTC and the session
// setting cannot reach it. The behaviour is identical on a UTC database and
// correct on one that is not.
//
// A swept flock is not a dead end. The plan screen offers the host the
// attendance sheet for any completed flock whose roster still has an unmarked
// member, so a night the sweep closed can still be marked (POST
// /api/flocks/:id/attendance requires status 'completed', which it now is).
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not write a research_analytics
// row, which PUT /api/flocks/:id does on a host-driven completion. That row
// records `flock_completed: true` and a time-to-confirmation, and for a swept
// flock nobody observed either: the host never said the plan happened, the
// clock did. Writing one would put an outcome nobody reported into the research
// corpus. Only 'planning' -> 'confirmed' -> host-completed produces that row,
// and that is the honest reading of it.
// ---------------------------------------------------------------------------
const pool = require('../config/database');

// Every half hour. The grace period is measured in hours, so the only cost of
// being a few minutes late is a few minutes.
const FLOCK_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

const DEFAULT_GRACE_HOURS = 12;
const MIN_GRACE_HOURS = 1;
const MAX_GRACE_HOURS = 24 * 14;

// ---------------------------------------------------------------------------
// HOW MANY ROWS ONE PASS IS ALLOWED TO MOVE, AND WHY THERE IS A NUMBER HERE.
//
// The statement used to have no LIMIT, which is fine on a small table and is a
// job that stops forever on a large one. config/database.js sets
// `statement_timeout` to 15 seconds on every pooled connection, so one UPDATE
// over a backlog bigger than the server can write in fifteen seconds is KILLED
// BY POSTGRES WITH NOTHING COMMITTED. The catch below turns that into one
// console line, the next pass thirty minutes later inherits exactly the same
// backlog, and it fails exactly the same way, forever. The Past screen stays
// empty, every stale plan stays listed as live, and the only symptom is a log
// line nobody is watching.
//
// The backlog that gets us there is not hypothetical: the FIRST pass on a
// database that has been running without this sweep has to move every confirmed
// flock ever created, and after that a restored backup or a long outage does
// the same thing again.
//
// So a pass is a bounded loop of bounded statements. Each statement commits on
// its own, so a timeout costs the batch it was in and not the batches already
// written, and the next batch starts from a strictly smaller backlog. 500 rows
// is far inside fifteen seconds for a single-column UPDATE on an indexed match,
// and 20 batches caps one pass at 10,000 flocks, which drains at 480,000 a day
// against a sweep that in steady state moves single digits.
const SWEEP_BATCH_SIZE = 500;
const SWEEP_MAX_BATCHES = 20;

/** Hours after `event_time` a confirmed flock is considered finished. */
function graceHours() {
  const raw = process.env.FLOCK_COMPLETE_AFTER_HOURS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_GRACE_HOURS;
  const n = Number(raw);
  // A typo must not close every plan in the database an hour after it starts,
  // and must not silently disable the sweep either. Out of range or unreadable
  // falls back to the documented default rather than to whatever Number() made
  // of it.
  if (!Number.isFinite(n)) return DEFAULT_GRACE_HOURS;
  const whole = Math.round(n);
  if (whole < MIN_GRACE_HOURS || whole > MAX_GRACE_HOURS) return DEFAULT_GRACE_HOURS;
  return whole;
}

/** Default ON. Set FLOCK_SWEEP_ENABLED=false to stop it. */
function flockSweepEnabled() {
  return String(process.env.FLOCK_SWEEP_ENABLED || '').toLowerCase() !== 'false';
}

/**
 * Move every confirmed flock whose event_time is more than `graceHours()` in
 * the past to 'completed'. Resolves to the number of rows moved.
 *
 * NEVER REJECTS. It runs inside setInterval, where an unhandled rejection is a
 * process crash on a timer.
 *
 * Idempotent by construction: the WHERE clause matches only 'confirmed', so a
 * second pass (a redeploy, two instances running at once) finds nothing left to
 * move rather than re-completing what it already did. `event_time IS NOT NULL`
 * matters as much: a confirmed plan with no time on it has no night to be past,
 * and guessing one from created_at would close plans nobody has been to yet.
 */
async function runFlockCompletionSweep() {
  if (!flockSweepEnabled()) return 0;
  const hours = graceHours();
  let moved = 0;
  try {
    for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
      const result = await pool.query(
        `UPDATE flocks
            SET status = 'completed', updated_at = NOW()
          WHERE id IN (
            SELECT id FROM flocks
             WHERE status = 'confirmed'
               AND event_time IS NOT NULL
               AND event_time < (NOW() AT TIME ZONE 'UTC') - make_interval(hours => $1::int)
             ORDER BY event_time
             LIMIT $2::int
          )
          RETURNING id`,
        [hours, SWEEP_BATCH_SIZE]
      );
      const n = result.rowCount || 0;
      moved += n;
      // A short batch means the backlog is drained. Only a FULL batch can have
      // left anything behind, so this is the one condition worth another round
      // trip for.
      if (n < SWEEP_BATCH_SIZE) break;
    }
    if (moved > 0) {
      console.log(`[flockSweep] completed ${moved} flock${moved === 1 ? '' : 's'} past ${hours}h after their time`);
    }
    return moved;
  } catch (err) {
    // `moved`, not 0. Every batch before the failure is committed, and
    // reporting zero would say the pass achieved nothing when it may have moved
    // 9,500 rows before the 9,501st statement timed out.
    console.error('[flockSweep] sweep failed:', err.message);
    return moved;
  }
}

module.exports = {
  runFlockCompletionSweep,
  flockSweepEnabled,
  graceHours,
  FLOCK_SWEEP_INTERVAL_MS,
  DEFAULT_GRACE_HOURS,
  // Exported so the test names the same numbers the sweep does. A test that
  // spells 500 itself passes after somebody changes the batch size, which is
  // the one edit that could put the statement back over the 15s cap.
  SWEEP_BATCH_SIZE,
  SWEEP_MAX_BATCHES,
};
