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
  try {
    const hours = graceHours();
    const result = await pool.query(
      `UPDATE flocks
          SET status = 'completed', updated_at = NOW()
        WHERE status = 'confirmed'
          AND event_time IS NOT NULL
          AND event_time < NOW() - make_interval(hours => $1::int)
        RETURNING id`,
      [hours]
    );
    const n = result.rowCount || 0;
    if (n > 0) {
      console.log(`[flockSweep] completed ${n} flock${n === 1 ? '' : 's'} past ${hours}h after their time`);
    }
    return n;
  } catch (err) {
    console.error('[flockSweep] sweep failed:', err.message);
    return 0;
  }
}

module.exports = {
  runFlockCompletionSweep,
  flockSweepEnabled,
  graceHours,
  FLOCK_SWEEP_INTERVAL_MS,
  DEFAULT_GRACE_HOURS,
};
