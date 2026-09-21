'use strict';

// The night-of "still in?" window, the parts three files have to agree on.
//
// services/reconfirmSweep.js OPENS the window (flocks.reconfirm_opened_at) a
// fixed lead before a confirmed plan's time. routes/flocks.js and
// routes/guest.js ANSWER it (flock_members.reconfirmed_at,
// guest_rsvps.reconfirmed_at) and both READ it for their payloads. "Is it open"
// and "how many have said so" are one question with one answer, so they are
// one statement here rather than a definition per file. See migration 072 for
// why the window exists at all.
//
// TIMES. flocks.event_time is a naive TIMESTAMP holding UTC wall-clock, so the
// open test compares it against NOW() AT TIME ZONE 'UTC', the same reading
// services/flockSweep.js uses. It is decided in SQL on purpose: a Date built
// from a naive column in Node is only right when the process runs in UTC, and
// the answer to "is the window open" must not depend on where the server is.

const DEFAULT_LEAD_HOURS = 3;
const MIN_LEAD_HOURS = 1;
const MAX_LEAD_HOURS = 24;

// How long before the plan the question is asked. Env-tunable within a sane
// band, like FLOCK_COMPLETE_AFTER_HOURS; anything outside it falls back rather
// than opening windows a day early or a minute late.
function reconfirmLeadHours() {
  const raw = process.env.FLOCK_RECONFIRM_LEAD_HOURS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_LEAD_HOURS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LEAD_HOURS;
  const whole = Math.round(n);
  if (whole < MIN_LEAD_HOURS || whole > MAX_LEAD_HOURS) return DEFAULT_LEAD_HOURS;
  return whole;
}

// Open, deadline, and the count over BOTH rosters. The population is the same
// one the budget's "n of m answered" ranges over (routes/budget.js
// answeringPopulation): accepted members plus visible 'in' guests, which is
// who the roster shows as going. A guest who is out or hidden is not asked and
// is not counted, in the same statement, so the two numbers cannot drift.
//
// AN ANSWER BELONGS TO THE WINDOW IT WAS GIVEN IN. Only a reconfirmed_at at or
// after reconfirm_opened_at counts: a tap that raced a time change (the reset
// in routes/flocks.js clears answers, but a tap in flight can land after it),
// or a reset that failed half way, leaves a timestamp older than the window,
// and an older timestamp is not an answer to this question.
const RECONFIRM_STATE_SQL = `SELECT
     (f.reconfirm_opened_at IS NOT NULL AND f.status = 'confirmed'
        AND f.event_time > (NOW() AT TIME ZONE 'UTC')) AS open,
     f.event_time AS deadline,
     (SELECT COUNT(*) FROM flock_members
       WHERE flock_id = f.id AND status = 'accepted' AND reconfirmed_at IS NOT NULL
         AND reconfirmed_at >= f.reconfirm_opened_at)::int
   + (SELECT COUNT(*) FROM guest_rsvps
       WHERE flock_id = f.id AND status = 'in' AND COALESCE(is_hidden, false) = false
         AND reconfirmed_at IS NOT NULL AND reconfirmed_at >= f.reconfirm_opened_at)::int AS count,
     (SELECT COUNT(*) FROM flock_members
       WHERE flock_id = f.id AND status = 'accepted')::int
   + (SELECT COUNT(*) FROM guest_rsvps
       WHERE flock_id = f.id AND status = 'in' AND COALESCE(is_hidden, false) = false)::int AS total
   FROM flocks f WHERE f.id = $1`;

const CLOSED = Object.freeze({ open: false, deadline: null, count: 0, total: 0 });

// THE TWO WRITES, BOUND TO THE WINDOW THEY VALIDATED. Each route reads the
// state, decides, and then writes; a time change or an un-confirm can land
// between those two, and a write that only named the row would put an answer
// back into a window that had just been cleared, or into no window at all.
// So the write joins the flock and re-checks the window in the same
// statement, and writes only a row that has not answered THIS window yet.
// Zero rows changed means one of two things the caller tells apart by
// re-reading the state: the window closed, or this person had already
// answered it.
const RECONFIRM_MEMBER_WRITE_SQL = `UPDATE flock_members fm SET reconfirmed_at = NOW()
     FROM flocks f
    WHERE fm.flock_id = $1 AND fm.user_id = $2 AND fm.status = 'accepted'
      AND f.id = fm.flock_id AND f.reconfirm_opened_at IS NOT NULL AND f.status = 'confirmed'
      AND f.event_time > (NOW() AT TIME ZONE 'UTC')
      AND (fm.reconfirmed_at IS NULL OR fm.reconfirmed_at < f.reconfirm_opened_at)
    RETURNING 1`;
const RECONFIRM_GUEST_WRITE_SQL = `UPDATE guest_rsvps g SET reconfirmed_at = NOW(), updated_at = NOW()
     FROM flocks f
    WHERE g.id = $1 AND g.flock_id = $2 AND g.status = 'in' AND COALESCE(g.is_hidden, false) = false
      AND f.id = g.flock_id AND f.reconfirm_opened_at IS NOT NULL AND f.status = 'confirmed'
      AND f.event_time > (NOW() AT TIME ZONE 'UTC')
      AND (g.reconfirmed_at IS NULL OR g.reconfirmed_at < f.reconfirm_opened_at)
    RETURNING 1`;

// "Did this person answer THIS window": the same rule the count applies, for
// a row a route already holds. Both values are TIMESTAMPTZ, so the Dates are
// instants and the comparison does not depend on the process zone.
function answeredWindow(reconfirmedAt, openedAt) {
  if (!reconfirmedAt || !openedAt) return false;
  const a = new Date(reconfirmedAt).getTime();
  const o = new Date(openedAt).getTime();
  return Number.isFinite(a) && Number.isFinite(o) && a >= o;
}

// `run` is the query function (pool.query, or a checked-out client's), so a
// route can ask inside its own transaction.
async function reconfirmState(run, flockId) {
  const r = await run(RECONFIRM_STATE_SQL, [flockId]);
  const row = r && r.rows && r.rows[0];
  if (!row) return CLOSED;
  return {
    open: row.open === true,
    deadline: row.deadline || null,
    count: Number(row.count) || 0,
    total: Number(row.total) || 0,
  };
}

module.exports = {
  reconfirmLeadHours,
  reconfirmState,
  answeredWindow,
  RECONFIRM_STATE_SQL,
  RECONFIRM_MEMBER_WRITE_SQL,
  RECONFIRM_GUEST_WRITE_SQL,
  DEFAULT_LEAD_HOURS,
  MIN_LEAD_HOURS,
  MAX_LEAD_HOURS,
};
