'use strict';
// ---------------------------------------------------------------------------
// THE INCOMING-FLOCKS FEED: which plans are coming to a venue, as counts.
// ---------------------------------------------------------------------------
// One query, two readers. GET /api/venue-dashboard/incoming-flocks is the feed
// itself (routes/venueDashboard.js, where the rules below were argued and are
// still written out at length), and GET /api/sensors/:placeId/tables/incoming
// lays the same plans over the live table floor to suggest a table for each.
// The second reader must never be a second copy of the query: the window, the
// membership rule and, above all, the list of columns are the privacy of
// this feed, and two copies drift. So the statement lives here and both
// routes call it.
//
// WHAT IT SELECTS, AND WHAT IT NEVER WILL. A plan's id, when it is, whether it
// is confirmed, and HOW MANY people said they are going: accepted members
// plus link guests who said in, the going count the app shows the group
// (routes/flocks.js). f.name is not selected:
// the group's own name for their night ("Emma's 21st") pairs a first name
// with a venue, a date and a time, and nobody in the group chose to hand that
// to a business (SECURITY ROUND 5, 2026-08-20, routes/venueDashboard.js). No
// member, no host, no vote, no user text of any kind leaves this statement.
// __tests__/incomingFlocksWindow.test.js holds the SQL to that.
//
// WHICH PLANS. A CONFIRMED plan is on the feed only when flocks.venue_id is
// this place, whatever its members voted; a plan still PLANNING is on it when
// this place is its current pick, or when a member who is still in the plan
// and not banned has it in their vote, the same membership the tally reads.
// Inside [NOW() - 12h, NOW() + 7d]: the tail of the check-in window and a
// week ahead (INCOMING_PAST_HOURS, INCOMING_AHEAD_HOURS, and the literals in
// the statement must agree with them; the window suite checks). The intervals
// are SQL literals rather than bound parameters on purpose: the only bound
// value is the server-derived place id, and the object-authz suite pins that.
// ---------------------------------------------------------------------------
const pool = require('../config/database');

const INCOMING_PAST_HOURS = 12;   // = the tail of the routes/checkin.js window
const INCOMING_AHEAD_HOURS = 168; // = 7 days

// The statement. guest_count uses the predicate routes/flocks.js counts
// going guests with, so the venue and the app count the same people.
const INCOMING_FLOCKS_SQL = `SELECT f.id, f.event_time, f.status,
              (SELECT COUNT(*) FROM flock_members fm WHERE fm.flock_id = f.id AND fm.status = 'accepted') AS member_count,
              (SELECT COUNT(*) FROM guest_rsvps gr WHERE gr.flock_id = f.id AND gr.status = 'in' AND COALESCE(gr.is_hidden, false) = false)::int AS guest_count
       FROM flocks f
       WHERE (
               (f.venue_id = $1 AND (f.status IS NULL OR f.status IN ('planning', 'confirmed')))
               OR ((f.status IS NULL OR f.status = 'planning') AND EXISTS (
                 SELECT 1 FROM venue_votes vv
                   JOIN users u ON u.id = vv.user_id AND u.is_banned IS NOT TRUE
                   JOIN flock_members vm ON vm.flock_id = vv.flock_id AND vm.user_id = vv.user_id
                     AND vm.status = 'accepted'
                  WHERE vv.flock_id = f.id AND vv.venue_id = $1))
             )
         AND f.event_time IS NOT NULL
         AND f.event_time > (NOW() AT TIME ZONE 'UTC') - INTERVAL '12 hours'
         AND f.event_time < (NOW() AT TIME ZONE 'UTC') + INTERVAL '7 days'
       ORDER BY f.event_time ASC
       LIMIT 20`;

/**
 * The plans coming to `placeId`, soonest first: rows of { id, event_time,
 * status, member_count, guest_count } exactly as the statement returns them
 * (member_count is a bigint, so a string; guest_count an int). The caller has already settled that it may know:
 * both routes read it only for the verified owner of the place.
 */
async function listIncomingFlocks(placeId) {
  const { rows } = await pool.query(INCOMING_FLOCKS_SQL, [placeId]);
  return rows;
}

/**
 * The party size of a feed row as a number: accepted members plus going
 * guests (a missing guest_count is 0), or 0 when the count has not landed or cannot be read. The dashboard says "A group" for 0 rather
 * than "Party of 0"; the table routes fit a party of 0 to any table.
 */
function partyOf(row) {
  const m = Number(row && row.member_count);
  const g = Number(row && row.guest_count);
  const n = (Number.isFinite(m) ? m : 0) + (Number.isFinite(g) ? g : 0);
  return n > 0 ? Math.floor(n) : 0;
}

module.exports = {
  INCOMING_PAST_HOURS,
  INCOMING_AHEAD_HOURS,
  INCOMING_FLOCKS_SQL,
  listIncomingFlocks,
  partyOf,
};
