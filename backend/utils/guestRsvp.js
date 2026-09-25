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
// WHICH GUEST ROW A JOIN MAY RETIRE, AND WHOSE.
//
// A guest identity is a UUID the invite page keeps in the browser that
// answered (`flock_guest_<link token>`), so holding one proves only that this
// device answered. A shared laptop holds other people's answers too, and the
// joins retired whatever rows they were handed. The app chose which
// identities to send by first name, so one Sam answered the link, a different
// Sam accepted the invite in the app on the same browser, and the first Sam's
// answer left the roster, their budget number left the total and their venue
// vote became the second Sam's.
//
// So the name on the row has to be the joining account's name, checked inside
// the UPDATE that retires it. Names are compared the way the guest ledger
// compares them everywhere else (normalizeGuestName in routes/guest.js):
// trimmed, case-folded, whitespace runs collapsed. How close the match has to
// be depends on the door:
//
//   AN INVITE ACCEPTED IN THE APP (POST /api/flocks/:id/join) sends the
//   identities the device holds for any link, and the person was shown none
//   of them. The device cannot tell which of two people called Sam typed
//   "Sam", so the row must carry the account's whole name, and that name must
//   be more than one word: the answer itself has to say which Sam it is. A
//   first name alone leaves the row where it is. That person stays counted
//   twice, which is the state before any door retired rows, and no one else's
//   answer is taken.
//
//   THE LINK'S OWN JOIN (POST /api/guest/:token/join) is handed one identity:
//   the one the page for that link showed as theirs when they tapped Join, or
//   that the app kept for the link it was opened on. The page asks for a first
//   name (its placeholder is "Maya"), so demanding the whole name here would
//   stop the retirement for nearly every guest who makes an account, which is
//   the conversion this door exists for. The name has to FIT instead: the
//   account's first name, optionally followed by the start of the rest of it.
//   "Sam", "Sam R" and "Sam Rivera" fit Sam Rivera; "Maya", "Sam S", "Sam
//   Smith" and "Samantha" do not. A row that is plainly somebody else's is
//   refused. A bare "Sam" handed over by a different Sam is not, and cannot be
//   told apart without asking: the page offered that answer as theirs, and the
//   page already lets whoever holds the device change it, vote with it and
//   read its budget answer.
//
// A marker stored beside the identity, naming the account that was signed in
// when the answer was typed, would have let the app carry first-name answers.
// It is not used. The invite page never shows that a session is live, so the
// marker would bind whoever typed to whoever last signed in on that browser,
// which is the shared-device case itself, and a value in the browser is not
// something this server can check.
//
// Both statements also retire nothing on a plan that is over, and nothing for
// somebody who is not an accepted member once the join has landed, so a
// refused join retires nothing. $1 flock, $2 the presented token(s), $3 the
// joining account.
// ---------------------------------------------------------------------------
const RETIRE_ON_INVITE_ACCEPT_SQL = `UPDATE guest_rsvps SET is_hidden = TRUE
  WHERE flock_id = $1 AND guest_token = ANY($2::uuid[]) AND COALESCE(is_hidden, false) = false
    AND EXISTS (SELECT 1 FROM flocks f WHERE f.id = $1 AND f.status NOT IN ('completed', 'cancelled'))
    AND EXISTS (SELECT 1 FROM flock_members fm WHERE fm.flock_id = $1 AND fm.user_id = $3 AND fm.status = 'accepted')
    AND EXISTS (SELECT 1 FROM users u
                 CROSS JOIN LATERAL (SELECT lower(regexp_replace(btrim(guest_rsvps.name), '\\s+', ' ', 'g')) AS said,
                                            lower(regexp_replace(btrim(u.name), '\\s+', ' ', 'g')) AS account) n
                 WHERE u.id = $3 AND strpos(n.account, ' ') > 0 AND n.said = n.account)
  RETURNING id`;

const RETIRE_ON_LINK_JOIN_SQL = `UPDATE guest_rsvps SET is_hidden = TRUE
  WHERE flock_id = $1 AND guest_token = $2 AND COALESCE(is_hidden, false) = false
    AND EXISTS (SELECT 1 FROM flocks f WHERE f.id = $1 AND f.status NOT IN ('completed', 'cancelled'))
    AND EXISTS (SELECT 1 FROM flock_members fm WHERE fm.flock_id = $1 AND fm.user_id = $3 AND fm.status = 'accepted')
    AND EXISTS (SELECT 1 FROM users u
                 CROSS JOIN LATERAL (SELECT lower(regexp_replace(btrim(guest_rsvps.name), '\\s+', ' ', 'g')) AS said,
                                            lower(regexp_replace(btrim(u.name), '\\s+', ' ', 'g')) AS account) n
                 WHERE u.id = $3 AND n.said <> ''
                   AND (n.said = n.account
                        OR left(n.account, length(n.said) + 1) = n.said || ' '
                        OR (strpos(n.said, ' ') > 0 AND left(n.account, length(n.said)) = n.said)))
  RETURNING id`;

// ---------------------------------------------------------------------------
// THE FLOCKVOTE LOCK COMES FIRST.
//
// The member vote routes (routes/venues.js, vote_venue in sockets/handlers.js)
// take this lock and then INSERT into venue_votes, and that INSERT's foreign
// key takes FOR KEY SHARE on the plan's flocks row. The in-app accept and the
// link join for a new member locked that row FOR UPDATE first and reached this
// lock only later, inside carryGuestVote, so a vote and a join for the same
// person at the same moment each held what the other needed next, and
// Postgres broke the cycle by failing one of them (40P01). Every transaction
// that may carry a vote now takes this lock first, then the plan's row, then
// the rows it writes: the joins take the row FOR UPDATE (the link join for
// somebody already in included, before the guest row it hides, since a plan
// delete takes the row and then cascades into that guest row), and the vote
// routes take its key share (routes/venues.js VOTE_PLAN_LOCK_SQL) before the
// old vote row they delete, for the same reason. Advisory transaction locks
// nest, so carryGuestVote taking it again inside the same transaction costs
// nothing.
// ---------------------------------------------------------------------------
function lockVoteSlot(run, flockId, userId) {
  return run(
    "SELECT pg_advisory_xact_lock(hashtext('flockvote:' || $1::text || ':' || $2::text))",
    [String(flockId), String(userId)]
  );
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
// { venueName, moved }: moved is false when the member's own newer vote stood,
// and either way the guest tally changed, which the caller announces. When the
// write was refused because the plan is over it also carries `closed: true`,
// and the caller rolls the retirement back: a row hidden while its vote could
// not be copied would take that vote off the tally of a plan that is already
// a record. That flag is a backstop and not the plan-state check: it is only
// raised when a vote write is attempted, so a retired row with no vote, or one
// whose member vote is newer, never raises it. Every caller therefore holds
// the plan's row FOR UPDATE and has read its status under that lock before it
// retires anything, and a cancel, which is an UPDATE on that row, waits for
// the caller's COMMIT.
async function carryGuestVote(run, flockId, userId, guestRsvpIds) {
  const ids = (Array.isArray(guestRsvpIds) ? guestRsvpIds : [guestRsvpIds])
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return null;
  await lockVoteSlot(run, flockId, userId);
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
  // The ON CONFLICT arm always answers, so an empty RETURNING is the status
  // test refusing: the plan is completed, cancelled or gone.
  if (!written || !written.rows || written.rows.length === 0) {
    return { venueName: row.venue_name, moved: false, closed: true };
  }
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
  lockVoteSlot,
  RETIRE_ON_INVITE_ACCEPT_SQL,
  RETIRE_ON_LINK_JOIN_SQL,
};
