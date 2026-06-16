// ---------------------------------------------------------------------------
// User blocking — mutual / bidirectional (Apple 1.2, Google UGC policy).
// If A blocks B, neither can DM, friend-request, invite, or see the other's
// content. These helpers are the single source of truth for that enforcement.
// ---------------------------------------------------------------------------
const pool = require('../config/database');

/**
 * True if A blocked B OR B blocked A (mutual invisibility).
 */
async function isBlockedBetween(a, b) {
  if (!a || !b || Number(a) === Number(b)) return false;
  const r = await pool.query(
    `SELECT 1 FROM user_blocks
     WHERE (blocker_id = $1 AND blocked_id = $2)
        OR (blocker_id = $2 AND blocked_id = $1)
     LIMIT 1`,
    [a, b]
  );
  return r.rows.length > 0;
}

/**
 * All user ids that should be invisible to `userId` (blocked in either
 * direction) — for filtering lists, feeds, and group surfaces.
 * @returns {Promise<number[]>}
 */
async function getInvisibleUserIds(userId) {
  const r = await pool.query(
    `SELECT blocked_id AS id FROM user_blocks WHERE blocker_id = $1
     UNION
     SELECT blocker_id AS id FROM user_blocks WHERE blocked_id = $1`,
    [userId]
  );
  return r.rows.map((row) => row.id);
}

module.exports = { isBlockedBetween, getInvisibleUserIds };
