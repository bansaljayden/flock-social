// "Do these two accounts actually know each other?"
//
// sockets/handlers.js already refuses to persist a DM, a DM venue vote, or a
// pinned venue between two accounts with no relationship — its own comment
// explains why: `dm_pinned_venues` is keyed on the ORDERED PAIR and upserted,
// so one event from an outsider overwrites whatever those two people had
// pinned. The REST twins of those handlers (routes/messages.js) never got the
// same gate, so the rule held on one transport and not the other.
//
// It lives here so both transports can share one definition. sockets/handlers.js
// can drop its private `hasDmRelationship` in favour of:
//   const { hasDmRelationship } = require('./../utils/relationships');
//
// Existence is deliberately NOT checked separately: a friendship row or a DM
// row proves the counterpart exists, and a separate "user not found" answer is
// exactly the oracle that lets someone walk the user table one id at a time.

const pool = require('../config/database');

/**
 * True when `userId` and `otherId` have an accepted friendship, or have already
 * exchanged at least one DM.
 */
async function hasDmRelationship(userId, otherId) {
  const a = Number(userId);
  const b = Number(otherId);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) return false;
  const r = await pool.query(
    `SELECT 1 WHERE EXISTS (
       SELECT 1 FROM friendships
       WHERE status = 'accepted'
         AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
     ) OR EXISTS (
       SELECT 1 FROM direct_messages
       WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
     )`,
    [a, b]
  );
  return r.rows.length > 0;
}

// One answer for "no such user" and "not connected to you", so neither can be
// read off the other. Phrased for the case a real person will hit.
const NOT_CONNECTED_MESSAGE = "You can only do that with people you're connected with.";

module.exports = { hasDmRelationship, NOT_CONNECTED_MESSAGE };
