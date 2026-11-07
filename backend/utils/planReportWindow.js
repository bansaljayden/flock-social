'use strict';
// ---------------------------------------------------------------------------
// HOW LONG A PLAN MEMBER'S "HOW WAS IT?" ANSWER COUNTS.
//
// A crowd report counts (venue_feedback.verified) only on evidence that the
// person was there. One kind of evidence is a plan: routes/feedback.js
// VERIFIED_PRESENCE_SQL accepts a report from an accepted member of a
// two-person plan at the venue whose time is within 12 hours of the report,
// either side. A 9 PM plan's answers therefore stopped counting at 9 AM, while
// "How was it?" is asked about the night after it: the plan screen asks from
// an hour in, and the Nest redesign asks once the night has rolled over at
// 4 AM. An answer given after 9 AM the next morning could not count.
//
// THE RULE (2026-11-06). A report from somebody who was a member of the plan
// when it was locked in counts from the plan's start until 12:00 noon on the
// day after the plan's night, on the VENUE's clock. The old 12 hours stay as a
// floor, so a plan whose 12 hours run past that noon keeps them: a 2 AM plan
// counts until 2 PM.
//
// THE PLAN'S NIGHT. A plan between midnight and 4 AM belongs to the night
// before, the way the rest of the app reads a night: the Tonight answer clears
// at 4 AM (routes/availability.js, frontend lib/pulse.js), and the Nest
// redesign rolls its day over at the same hour. So a 1 AM Saturday plan is
// Friday's night, its "next morning" is Saturday's, and noon Saturday is
// earlier than its 12-hour floor (1 PM), which wins. A 9 PM Friday plan counts
// until noon Saturday; an 11 AM Saturday brunch until noon Sunday.
//
// NOON IS A WALL-CLOCK TIME, so it is found with the zone's own rules
// (utils/venueZone.js instantForWallClock), never by adding hours: on the
// night New York falls back (2026-11-01), 9 PM Saturday to noon Sunday is 16
// hours, and on the night it springs forward (2027-03-14) it is 14. Zones
// change their clocks in the small hours, so noon has one instant;
// instantForWallClock would still place one inside a change.
//
// WITHOUT A ZONE there is no venue noon to find, and the floor alone applies:
// the old 12 hours, nothing added. The caller supplies the zone
// (ml_venues.timezone, else the reporter's device zone).
//
// WHAT ELSE A REPORT NEEDS for this window (planReportStanding), each a rule
// the plan clause of VERIFIED_PRESENCE_SQL already has or a tighter one:
//   - the plan is LOCKED IN: confirmed_at is set and it is confirmed or
//     completed now (the sweep completes a confirmed plan 12 hours after its
//     time, which must not end the window);
//   - the reporter was a member AT LOCK-IN: accepted at or before
//     confirmed_at, so joining the night after buys nothing;
//   - the host has not marked them absent (attendance 'no_show');
//   - the plan names this venue and has at least two accepted members;
//   - the plan has STARTED: nothing before its time counts through this
//     window (the old ±12 hours still decide a report filed earlier).
// One report per member per plan is the route's job: an in-window report
// replaces the member's earlier reports on the same plan.
// ---------------------------------------------------------------------------

const { civilTime, instantForWallClock, validTimeZone, clockInZone } = require('./venueZone');

const HOUR_MS = 60 * 60 * 1000;
// The hour a night ends: the 4 AM routes/availability.js clears a Tonight
// answer at, and the hour the Nest redesign rolls its day over.
const NIGHT_ROLL_HOUR = 4;
// Noon on the venue's clock, the day after the plan's night.
const REPORT_CLOSE_HOUR = 12;
// The window before this rule, kept as the floor.
const PLAN_REPORT_FLOOR_MS = 12 * HOUR_MS;
// A plan needs a second accepted member, as VERIFIED_PRESENCE_SQL does: one
// account can make a plan at any place id, so a solo plan certifies itself.
const MIN_ACCEPTED_MEMBERS = 2;

/**
 * Noon on the venue's clock on the day after the plan's night, as an instant,
 * or null when the zone or the time cannot be read.
 * @param {number} eventMs the plan's start, epoch ms
 * @param {string|null} zone IANA name
 * @returns {number|null}
 */
function noonAfterNightMs(eventMs, zone) {
  const z = validTimeZone(zone);
  if (!z || !Number.isFinite(eventMs)) return null;
  const c = civilTime(eventMs, z);
  if (!c) return null;
  // Calendar arithmetic on the civil date, in UTC so no zone moves it: the
  // night is the plan's date, or the day before for a time before 4 AM, and
  // the morning after is one day on.
  const nightShift = c.hour < NIGHT_ROLL_HOUR ? -1 : 0;
  const after = new Date(Date.UTC(c.year, c.month - 1, c.day + nightShift + 1));
  return instantForWallClock({
    year: after.getUTCFullYear(),
    month: after.getUTCMonth() + 1,
    day: after.getUTCDate(),
    hour: REPORT_CLOSE_HOUR,
    minute: 0,
  }, z);
}

/**
 * When a plan member's report stops counting: the later of noon after the
 * night (venue clock) and 12 hours after the start. The floor alone when the
 * zone is unknown. Null for an unreadable start.
 * @param {number} eventMs
 * @param {string|null} zone
 * @returns {number|null}
 */
function planReportClosesAtMs(eventMs, zone) {
  if (!Number.isFinite(eventMs)) return null;
  const floor = eventMs + PLAN_REPORT_FLOOR_MS;
  const noon = noonAfterNightMs(eventMs, zone);
  return noon == null ? floor : Math.max(floor, noon);
}

const asNumber = (v) => {
  if (v == null || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Where one member's report on one plan stands against this window.
 *
 * `plan` is the route's read of the plan and of this member's row:
 *   { venue_id, event_ms, locked_in, member_at_lock, not_marked_absent,
 *     accepted_members }
 * (column names as routes/feedback.js PLAN_FACTS_SQL selects them; event_ms
 * may arrive as a numeric string).
 *
 * Returns null when there is no plan to judge (no row, or no readable start).
 * Otherwise:
 *   eventMs       the plan's start
 *   sameVenue     the plan names the venue the report is about
 *   eligible      every rule but time holds: this member's report on this plan
 *                 is the kind the window is for
 *   started       the plan's time has come
 *   closesAtMs    when the window shuts (planReportClosesAtMs)
 *   counts        eligible, started, and before closesAtMs
 *   windowClosed  eligible and the window has shut: the one case where the
 *                 reason a report does not count is the clock
 * @param {object|null} plan
 * @param {{ venuePlaceId: string, nowMs: number, zone: string|null }} opts
 */
function planReportStanding(plan, { venuePlaceId, nowMs, zone }) {
  if (!plan || typeof plan !== 'object') return null;
  const eventMs = asNumber(plan.event_ms);
  if (!Number.isFinite(eventMs) || !Number.isFinite(nowMs)) return null;
  const accepted = asNumber(plan.accepted_members);
  const eligible = plan.locked_in === true
    && plan.member_at_lock === true
    && plan.not_marked_absent === true
    && typeof plan.venue_id === 'string' && plan.venue_id === venuePlaceId
    && Number.isFinite(accepted) && accepted >= MIN_ACCEPTED_MEMBERS;
  const closesAtMs = planReportClosesAtMs(eventMs, zone);
  const started = nowMs >= eventMs;
  const open = closesAtMs != null && nowMs < closesAtMs;
  return {
    eventMs,
    // The report is about this plan's venue at all. A report naming a plan
    // but a different place is not a report on that plan's night.
    sameVenue: typeof plan.venue_id === 'string' && plan.venue_id === venuePlaceId,
    eligible,
    started,
    closesAtMs,
    counts: eligible && started && open,
    windowClosed: eligible && closesAtMs != null && nowMs >= closesAtMs,
  };
}

/**
 * The plan's start on the venue's clock, { day (0 = Sunday), hour }, for the
 * bucket keys a report about that plan is filed under. Null without a zone.
 */
function planClock(eventMs, zone) {
  const z = validTimeZone(zone);
  if (!z || !Number.isFinite(eventMs)) return null;
  const c = clockInZone(eventMs, z);
  return c ? { day: c.day, hour: c.hour } : null;
}

module.exports = {
  NIGHT_ROLL_HOUR,
  REPORT_CLOSE_HOUR,
  PLAN_REPORT_FLOOR_MS,
  MIN_ACCEPTED_MEMBERS,
  noonAfterNightMs,
  planReportClosesAtMs,
  planReportStanding,
  planClock,
};
