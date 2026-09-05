/**
 * SYSTEM MESSAGES: the plan's own events, written into the stream.
 *
 * A system row is a real row in `messages` with message_type 'system' and a
 * `system_kind` naming the event (migration 067). It is drawn by
 * components/chat/cards/SystemRow.js as a centred grey line: "Maya set the
 * venue: Kome".
 *
 * WHY A ROW AND NOT AN EVENT. Because the stream is the record and the header
 * is the state. A venue confirmation already broadcasts a toast and repaints
 * the header, and both of those only ever show the CURRENT venue. A member who
 * was not looking has no way to learn when the decision happened or who made
 * it, and somebody who joins tomorrow sees a plan with no history of how it
 * was reached. A row survives all of that, and it pages, searches and moderates
 * like every other message because it IS one.
 *
 * WHY THE SERVER SENDS NO PROSE. `system_kind` plus the changed value, never a
 * finished sentence. SystemRow's documented contract is that it receives an
 * array of pieces and decides itself which piece is accented, so a server
 * shipping "Maya set the venue: Kome" would be choosing the wording, the
 * casing and the accent for a component built not to receive them. It also
 * keeps the copy re-wordable without a data migration.
 *
 * NOTHING HERE IS REACHABLE FROM THE WIRE. Every caller is server-side. The
 * two socket send paths clamp an unknown message_type to 'text' through their
 * own allowedTypes lists and the two REST validators run
 * .isIn(['text','venue_card','image']); none of the four knows 'system'. A
 * client able to author one could forge a plan change in the app's own voice,
 * which reads as the app speaking rather than as a person.
 */

const pool = require('../config/database');

/**
 * The closed set of events the stream records.
 *
 * Deliberately NOT a CHECK constraint on the column. That is the bug migration
 * 067 exists to fix, and 016 records the same shape shipping twice before: a
 * route learns a new value, the constraint does not, and the INSERT dies as a
 * 23514 that the route's catch turns into a 500 on a feature nobody can reach.
 * An unknown kind renders as nothing on the client, so a value this list has
 * not heard of is inert rather than fatal.
 */
const SYSTEM_KINDS = Object.freeze({
  VENUE_SET: 'venue_set',
});

/**
 * Write one system row and return it, or null.
 *
 * NEVER THROWS. Every caller is a side effect of an action that has already
 * succeeded: the venue is confirmed, the row in `flocks` is written, the
 * broadcast is owed. A failure to record that in the stream must not turn a
 * completed action into an error the user sees, so this swallows and logs. The
 * caller checks for null rather than catching.
 *
 * @param {number} flockId
 * @param {number} actorId   whose name the row names. A real user id, so the
 *                           history read's blocked-sender filter applies to
 *                           this row exactly as it does to anything they typed.
 * @param {string} kind      one of SYSTEM_KINDS
 * @param {string} value     the changed value, which SystemRow accents
 */
async function writeSystemMessage(flockId, actorId, kind, value) {
  const text = typeof value === 'string' ? value.trim() : '';
  // A row with nothing in it would draw an empty grey line the reader has to
  // interpret, and message_text is NOT NULL besides. SystemRow drops empty
  // pieces for the same reason; this refuses to create one in the first place.
  if (!text) return null;
  if (!Object.values(SYSTEM_KINDS).includes(kind)) return null;

  try {
    const result = await pool.query(
      `INSERT INTO messages (flock_id, sender_id, message_text, message_type, system_kind)
       VALUES ($1, $2, $3, 'system', $4)
       RETURNING *`,
      [flockId, actorId, text, kind]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('writeSystemMessage error:', err.message);
    return null;
  }
}

module.exports = { SYSTEM_KINDS, writeSystemMessage };
