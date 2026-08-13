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
  SELECT id, name, status, created_at, updated_at
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

module.exports = {
  GUEST_ID_PREFIX,
  GUEST_RSVP_SELECT,
  guestEntryId,
  toGuestEntry,
  combineRsvpCounts,
};
