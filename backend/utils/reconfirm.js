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
const RECONFIRM_STATE_SQL = `SELECT
     (f.reconfirm_opened_at IS NOT NULL AND f.status = 'confirmed'
        AND f.event_time > (NOW() AT TIME ZONE 'UTC')) AS open,
     f.event_time AS deadline,
     (SELECT COUNT(*) FROM flock_members
       WHERE flock_id = f.id AND status = 'accepted' AND reconfirmed_at IS NOT NULL)::int
   + (SELECT COUNT(*) FROM guest_rsvps
       WHERE flock_id = f.id AND status = 'in' AND COALESCE(is_hidden, false) = false
         AND reconfirmed_at IS NOT NULL)::int AS count,
     (SELECT COUNT(*) FROM flock_members
       WHERE flock_id = f.id AND status = 'accepted')::int
   + (SELECT COUNT(*) FROM guest_rsvps
       WHERE flock_id = f.id AND status = 'in' AND COALESCE(is_hidden, false) = false)::int AS total
   FROM flocks f WHERE f.id = $1`;

const CLOSED = Object.freeze({ open: false, deadline: null, count: 0, total: 0 });

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
  RECONFIRM_STATE_SQL,
  DEFAULT_LEAD_HOURS,
  MIN_LEAD_HOURS,
  MAX_LEAD_HOURS,
};
