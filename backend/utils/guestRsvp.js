// Shared shaping for guest-link RSVPs (the `guest_rsvps` table).
//
// A guest has NO user account: no row in `users`, no avatar, no reliability
// score, no `flock_members` row. They still have to show up in the host's
// roster and in every "N going" count, so every surface that returns them goes
// through here and gets one shape:
//
//   - `is_guest: true`, so the client never renders one as a member;
//   - a NAMESPACED STRING id (`guest:12`). Member-only paths take integer user
//     ids (attendance marking does `WHERE user_id = $1` against an INTEGER
//     column), so a guest id must be impossible to mistake for one — a bare
//     numeric id would silently collide with a real account and a raw
//     `guest:12` fed to an integer column is a 500. The prefix makes both
//     mistakes loud instead of silent.
//   - member status vocabulary (`accepted` / `declined`) alongside the raw
//     `guest_status` (`in` / `out`), so existing status filters work unchanged.
//
// Hidden rows (moderator takedown — migration 005) are filtered in SQL, not
// here, so the caller can never forget: a taken-down guest contributes nothing
// to any surface, member-facing ones included.

const GUEST_ID_PREFIX = 'guest:';

// Every member-facing read of guest_rsvps uses this exact projection + filter.
// $1 is the flock id.
const GUEST_RSVP_SELECT = `
  SELECT id, name, status, created_at, updated_at, reconfirmed_at,
         (reconfirmed_at IS NOT NULL AND reconfirmed_at >= (SELECT reconfirm_opened_at FROM flocks WHERE id = guest_rsvps.flock_id)) AS reconfirmed
  FROM guest_rsvps
  WHERE flock_id = $1 AND COALESCE(is_hidden, false) = false
  ORDER BY created_at ASC`;

function guestEntryId(guestRowId) {
  return `${GUEST_ID_PREFIX}${guestRowId}`;
}

function toGuestEntry(row) {
  return {
    id: guestEntryId(row.id),
    guest_id: row.id,
    is_guest: true,
    name: row.name,
    profile_image_url: null,
    reliability_score: null,
    status: row.status === 'in' ? 'accepted' : 'declined',
    guest_status: row.status,
    attendance: null,
    // The night-of answer (migration 072), read by the chat's roster: true
    // only for an answer given inside the window that is open now.
    reconfirmed_at: row.reconfirmed_at || null,
    reconfirmed: row.reconfirmed === true,
    joined_at: row.created_at,
  };
}

// Roster totals with guests folded in. Members carry three states
// (invited / accepted / declined); a guest row only exists because somebody
// answered the link, so every guest has already responded — which is why
// `responded` is not simply `members.length`.
//
// `guests` must already be mapped through toGuestEntry (member vocabulary).
function combineRsvpCounts(members = [], guests = []) {
  const memberAccepted = members.filter((m) => m.status === 'accepted').length;
  const memberDeclined = members.filter((m) => m.status === 'declined').length;
  const guestsGoing = guests.filter((g) => g.status === 'accepted').length;
  const guestsOut = guests.length - guestsGoing;

  const accepted = memberAccepted + guestsGoing;
  const declined = memberDeclined + guestsOut;

  return {
    memberAccepted,
    memberDeclined,
    memberTotal: members.length,
    guestsGoing,
    guestsOut,
    guestCount: guests.length,
    accepted,
    declined,
    responded: accepted + declined,
    total: members.length + guests.length,
  };
}

// ---------------------------------------------------------------------------
// A GUEST WHO BECOMES A MEMBER BRINGS ONE VOTE, NOT A SECOND ONE.
//
// Hiding a guest row takes its vote off both tallies (every read filters
// is_hidden), so the doors that retire a guest row as its person becomes a
// member carry the vote across: POST /api/guest/:token/join, for a new member
// and for one already in, and POST /api/flocks/:id/join, an invite accepted in
// the app. They used to copy it with INSERT ... ON CONFLICT DO NOTHING, and the
// conflict key is (flock_id, user_id, venue_name), so a member who already held
// a vote for a DIFFERENT venue came out holding two, which is exactly what the
// member vote routes exist to make impossible.
//
// THE RULE IS THE ONE-VOTE RULE THOSE ROUTES FOLLOW: a person holds one vote
// per plan, and the newer pick replaces the older (routes/venues.js deletes
// the other venues before it writes; the guest vote does the same). The guest
// pick and the member pick are the same person's two picks, so the newer of
// them is the vote. Replacing unconditionally would let a stale link answer
// overwrite a vote cast in the app since (a guest who joined through an invite,
// voted in the app, then tapped the link again); skipping whenever a member
// vote exists would drop the pick somebody made on the link a minute before
// signing in, which the page had just told them was counted. Ties go to the
// member vote, the one the person can see and change in the app.
//
// venue_votes.created_at is a naive TIMESTAMP holding the UTC wall clock
// (config/database.js pins every session to UTC); guest_votes.created_at is a
// TIMESTAMPTZ. The member side is read AT TIME ZONE 'UTC' so the comparison
// never depends on a session setting.
//
// `run(sql, params)` is the caller's transaction, which must already hold the
// guest row it is retiring: the vote moves in the same commit as the hide, and
// under the same flockvote: lock the member vote routes and the socket vote
// take, so a vote from the app landing at the same moment cannot leave this
// person holding two. Written only while the plan is open, the way every vote
// write is. Returns null when the retired rows held no vote, or
// { venueName, moved }: moved is false when the member's own vote stood (newer,
// or the plan closed), and either way the guest tally changed, which the
// caller announces.
async function carryGuestVote(run, flockId, userId, guestRsvpIds) {
  const ids = (Array.isArray(guestRsvpIds) ? guestRsvpIds : [guestRsvpIds])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return null;
  await run(
    "SELECT pg_advisory_xact_lock(hashtext('flockvote:' || $1::text || ':' || $2::text))",
    [String(flockId), String(userId)]
  );
  const pick = await run(
    `SELECT gv.venue_name,
            NOT EXISTS (
              SELECT 1 FROM venue_votes vv
               WHERE vv.flock_id = $1 AND vv.user_id = $2
                 AND (vv.created_at AT TIME ZONE 'UTC') >= gv.created_at
            ) AS newest
       FROM guest_votes gv
      WHERE gv.flock_id = $1 AND gv.guest_rsvp_id = ANY($3::int[])
      ORDER BY gv.created_at DESC, gv.id DESC
      LIMIT 1`,
    [flockId, userId, ids]
  );
  const row = pick && pick.rows && pick.rows[0];
  if (!row || !row.venue_name) return null;
  if (row.newest !== true) return { venueName: row.venue_name, moved: false };
  // Written first, then the other venues cleared, so nothing is removed from
  // a plan the write refused. The no-op DO UPDATE is what makes RETURNING
  // answer for a venue the member already held.
  const written = await run(
    `INSERT INTO venue_votes (flock_id, user_id, venue_name)
     SELECT $1::int, $2::int, $3::text
      WHERE EXISTS (SELECT 1 FROM flocks WHERE id = $1::int AND status NOT IN ('completed', 'cancelled'))
     ON CONFLICT (flock_id, user_id, venue_name)
     DO UPDATE SET venue_id = venue_votes.venue_id
     RETURNING venue_name`,
    [flockId, userId, row.venue_name]
  );
  if (!written || !written.rows || written.rows.length === 0) return { venueName: row.venue_name, moved: false };
  await run(
    'DELETE FROM venue_votes WHERE flock_id = $1 AND user_id = $2 AND venue_name <> $3',
    [flockId, userId, row.venue_name]
  );
  return { venueName: row.venue_name, moved: true };
}

module.exports = {
  GUEST_ID_PREFIX,
  GUEST_RSVP_SELECT,
  guestEntryId,
  toGuestEntry,
  combineRsvpCounts,
  carryGuestVote,
};
