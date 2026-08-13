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

/**
 * Cached variant for HIGH-FREQUENCY paths (socket typing/location events fire
 * per keystroke or per second). 30s TTL: a fresh block can take up to 30s to
 * bite on these ephemeral events; the persistent paths (DMs, invites) keep
 * using the uncached check so blocks are immediate where it matters.
 */
const blockCache = new Map();
const BLOCK_CACHE_TTL = 30 * 1000;
async function isBlockedBetweenCached(a, b) {
  if (!a || !b || Number(a) === Number(b)) return false;
  const key = a < b ? `${a}_${b}` : `${b}_${a}`;
  const hit = blockCache.get(key);
  if (hit && Date.now() - hit.ts < BLOCK_CACHE_TTL) return hit.blocked;
  const blocked = await isBlockedBetween(a, b);
  if (blockCache.size > 5000) blockCache.clear();
  blockCache.set(key, { ts: Date.now(), blocked });
  return blocked;
}

/**
 * Call when a block is created or removed: kills the cached pair decision so
 * the 30s TTL can't keep leaking live coordinates/typing to a fresh blocker
 * (round 5 — block creation must invalidate, not wait out, the cache).
 */
function invalidateBlockCache(a, b) {
  if (!a || !b) return;
  const key = a < b ? `${a}_${b}` : `${b}_${a}`;
  blockCache.delete(key);
}

module.exports = { isBlockedBetween, isBlockedBetweenCached, getInvisibleUserIds, invalidateBlockCache };
