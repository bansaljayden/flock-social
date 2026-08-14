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
const BLOCK_CACHE_MAX = 5000;

// One key builder for BOTH the cache write and the invalidation. They each had
// their own copy of `a < b ? \`${a}_${b}\` : \`${b}_${a}\``, which is a
// relational comparison over values that arrive as numbers from REST and as
// strings from socket payloads: '10' < '9' is true, 10 < 9 is false. So a pair
// cached from a socket event could be stored under a key the REST block route's
// invalidation never looked at, and the "block must bite immediately" guarantee
// silently degraded back to waiting out the 30-second TTL — on live location
// and typing, the two events a fresh block most urgently needs to stop.
function pairKey(a, b) {
  const [x, y] = [Number(a), Number(b)].sort((m, n) => m - n);
  return `${x}_${y}`;
}
async function isBlockedBetweenCached(a, b) {
  if (!a || !b || Number(a) === Number(b)) return false;
  // Round 17: the key was built with `a < b`, a RELATIONAL comparison on values
  // that arrive as numbers from REST and as strings from socket payloads.
  // '10' < '9' is true while 10 < 9 is false, so the same pair could produce
  // two different keys depending on which transport asked — one of them a cache
  // entry that the other's invalidation never touches. Normalize to numbers,
  // which is also what isBlockedBetween's self-check already assumes.
  const key = pairKey(a, b);
  const now = Date.now();
  const hit = blockCache.get(key);
  if (hit && now - hit.ts < BLOCK_CACHE_TTL) return hit.blocked;
  const blocked = await isBlockedBetween(a, b);
  // Was `blockCache.clear()`, which dropped every entry at once and sent every
  // in-flight typing/location event back to the database simultaneously — and
  // anyone could force that moment by touching enough pairs. Expire what is
  // stale, then evict oldest-first (same shape as checkin.js's tapCache).
  // Delete-then-set so insertion order really is least-recently-written.
  blockCache.delete(key);
  blockCache.set(key, { ts: now, blocked });
  if (blockCache.size > BLOCK_CACHE_MAX) {
    for (const [k, v] of blockCache) {
      if (now - v.ts >= BLOCK_CACHE_TTL) blockCache.delete(k);
    }
    while (blockCache.size > BLOCK_CACHE_MAX) {
      blockCache.delete(blockCache.keys().next().value);
    }
  }
  return blocked;
}

/**
 * Call when a block is created or removed: kills the cached pair decision so
 * the 30s TTL can't keep leaking live coordinates/typing to a fresh blocker
 * (round 5 — block creation must invalidate, not wait out, the cache).
 */
function invalidateBlockCache(a, b) {
  if (!a || !b) return;
  blockCache.delete(pairKey(a, b));
}

module.exports = { isBlockedBetween, isBlockedBetweenCached, getInvisibleUserIds, invalidateBlockCache };
// Exposed for __tests__/safetyFlow.test.js.
module.exports.__test = { pairKey, blockCache, BLOCK_CACHE_TTL };
