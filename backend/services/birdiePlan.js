// ---------------------------------------------------------------------------
// THE GROUP'S PLAN, FOR BIRDIE ASKED FROM INSIDE A FLOCK (2026-11-03).
//
// Filming the LionCage demo, Alex opened "Ask Birdie" from the plus menu of
// the "Friday night" flock, where the group was voting on its own picks, and
// asked "Where's good tonight for 6 of us?". Birdie recommended a place none of
// them had picked. It could not have known better: the app told it the flock's
// name, venue and status and nothing else, so the vote it was asked inside of
// never reached it.
//
// The app now names the flock it was asked from (frontend App.js
// toAiWireContext sends its id), and this reads that flock's plan for a
// requester who is an accepted member of it: how many are going, the vote's
// picks with their counts, and the venue it is locked in at. Anyone else gets
// nothing, and no word about why: the turn goes on exactly as a turn with no
// flock id does, so the id is no way to learn whether a plan exists.
//
// WHAT IT CARRIES, AND WHAT IT DOES NOT. Counts and venues, the figures that
// flock's own screen already shows its members, never a name or an answer of
// anyone's. The going count is the screen's (an accepted member the requester
// can see, plus a guest who said in and was not taken down), so a member the
// requester has blocked is not counted where the screen does not count them.
// The picks are the screen's tally (routes/venues.js collectVoteRows and
// tailorVotes: accepted, unbanned members' votes and the capped guest weight),
// read through the same two functions so the two cannot disagree; only the
// venue and its count leave here, never the voters. A plan that is over
// (completed or cancelled) has no plan to read.
//
// A locked plan sends no picks: where to go is settled, and the vote that
// settled it is nothing Birdie needs to answer about the venue.
// ---------------------------------------------------------------------------

'use strict';

const pool = require('../config/database');
const { getInvisibleUserIds } = require('../utils/blocks');
const { collectVoteRows, tailorVotes } = require('../routes/venues');

// The most picks one plan line carries. A vote has a handful of rows; a plan
// with more is still read for its leaders.
const MAX_PICKS = 6;
const INT4_MAX = 2147483647;

// The plan row, for an accepted member only: the JOIN on the requester's own
// membership is the gate, and a flock they are not in returns no row at all.
const PLAN_SQL = `
  SELECT f.status, f.venue_name, f.venue_id,
         (SELECT ARRAY_AGG(m.user_id) FROM flock_members m
           WHERE m.flock_id = f.id AND m.status = 'accepted') AS going_member_ids,
         (SELECT COUNT(*) FROM guest_rsvps g
           WHERE g.flock_id = f.id AND g.status = 'in' AND COALESCE(g.is_hidden, false) = false)::int AS guests_going
    FROM flocks f
    JOIN flock_members me ON me.flock_id = f.id AND me.user_id = $2 AND me.status = 'accepted'
   WHERE f.id = $1 AND f.status IN ('planning', 'confirmed')`;

// A flock id as the app sends it, or null for anything that cannot be one.
function planFlockId(value) {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isInteger(id) && id > 0 && id <= INT4_MAX ? id : null;
}

const venueOf = (name, placeId) => {
  if (typeof name !== 'string' || !name.trim() || name.trim() === 'TBD') return null;
  return { name: name.trim(), placeId: typeof placeId === 'string' && placeId ? placeId : null };
};

/**
 * The plan of flock `flockId` for `userId`, or null when there is none to give
 * them. { going, locked, venueSoFar, picks: [{ name, placeId, votes }] }.
 */
async function loadFlockPlan(flockId, userId, db = pool) {
  const id = planFlockId(flockId);
  if (id == null || userId == null) return null;
  // The membership gate and the block set are independent reads; nothing past
  // them is read before the gate has answered.
  const [planRes, invisible] = await Promise.all([
    db.query(PLAN_SQL, [id, userId]),
    getInvisibleUserIds(userId, db),
  ]);
  const row = planRes.rows[0];
  if (!row) return null;
  const hidden = new Set((invisible || []).map(Number));
  const members = (row.going_member_ids || []).filter((m) => !hidden.has(Number(m))).length;
  const going = members + (Number(row.guests_going) || 0);
  const venue = venueOf(row.venue_name, row.venue_id);
  if (row.status === 'confirmed' && venue) return { going, locked: venue, venueSoFar: null, picks: [] };
  const tally = tailorVotes(await collectVoteRows(id), new Set());
  const picks = tally
    .filter((v) => Number(v.vote_count) > 0)
    .slice(0, MAX_PICKS)
    .map((v) => ({ name: v.venue_name, placeId: v.venue_id || null, votes: Number(v.vote_count) }))
    .filter((p) => typeof p.name === 'string' && p.name.trim());
  return { going, locked: null, venueSoFar: row.status === 'planning' ? venue : null, picks };
}

module.exports = { loadFlockPlan, planFlockId, PLAN_SQL, MAX_PICKS };
