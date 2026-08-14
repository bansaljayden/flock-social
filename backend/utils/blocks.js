// ---------------------------------------------------------------------------
// User blocking — mutual / bidirectional (Apple 1.2, Google UGC policy).
// If A blocks B, neither can DM, friend-request, invite, or see the other's
// content. These helpers are the single source of truth for that enforcement.
// ---------------------------------------------------------------------------
const pool = require('../config/database');

// ---------------------------------------------------------------------------
// "NOT BLOCKED" IS A CLAIM, AND THIS MODULE MAY ONLY MAKE IT WHEN IT IS TRUE.
// ---------------------------------------------------------------------------
// Round 20. The guard was `if (!a || !b || Number(a) === Number(b)) return
// false`, and `!NaN` is TRUE. So every counterparty this module could not read
// — NaN, 'abc', a float, a negative — was answered `false`, which every caller
// in the codebase reads as "these two are allowed to reach each other". That is
// the fail-open shape on the one control Apple 1.2 actually tests, in the file
// whose own header calls itself "the single source of truth for that
// enforcement".
//
// It is reachable through ordinary code: routes/messages.js asks
// `isBlockedBetween(req.user.id, parseInt(req.params.userId))` in five places
// and `parseInt` answers NaN for anything non-numeric. A validator sits in
// front of those today, so the hole is closed by the CALLERS rather than by the
// control — which is precisely the arrangement a single source of truth is
// supposed to replace, and it only takes one new route to forget.
//
// Two different questions were sharing one answer, so they are separated:
//
//   ABSENT   — null, undefined, '', 0, false. "There is nobody on the other
//              side of this." Legitimate and common: services/pushHelper.js
//              gates on `actorId &&`, several socket handlers pass a value that
//              may not have arrived. Still false, exactly as before.
//   UNUSABLE — present, and not a positive integer. We cannot answer, so we do
//              not: it throws. Every caller already fails closed on a throw
//              (pushHelper suppresses the push, handlers.js returns,
//              announceToRoomExcludingBlocked stays silent, the route catches
//              and 500s), which is the safe direction on this control.
const ABSENT = Symbol('absent');

function participantId(value, which) {
  if (value === null || value === undefined || value === false
    || value === '' || value === 0 || value === '0') return ABSENT;
  // Number() is happy to manufacture a plausible id out of things that are not
  // one, and the check below only asks whether the RESULT is a positive
  // integer. `Number(true) === 1` and `Number(['5']) === 5`, so a boolean or a
  // one-element array produced a confident answer about a DIFFERENT USER rather
  // than a refusal, and no call site can tell that apart from a correct answer.
  // The array case is not hypothetical: socket payloads are attacker-shaped
  // JSON and `{"receiverId": ["5"]}` is the coerced-non-scalar family
  // validators/shape.js exists for. `false` is still ABSENT above because
  // callers use it to mean "nobody"; `true` never means anybody.
  if (typeof value === 'boolean' || typeof value === 'object') {
    throw new TypeError(`blocks: unusable participant id (argument ${which}) — refusing to report "not blocked"`);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    // The value itself is not put in the message: it is user-supplied and this
    // string reaches a log. The position is what a developer needs.
    throw new TypeError(`blocks: unusable participant id (argument ${which}) — refusing to report "not blocked"`);
  }
  return n;
}

/**
 * True if A blocked B OR B blocked A (mutual invisibility).
 *
 * `db` is an optional pg client. A caller that is ALREADY inside a transaction
 * must pass the client it is holding: without it this checks a second
 * connection out of a 20-slot pool while the first is still held, which is the
 * shape that turns a slow query into a pool exhaustion under load. Defaults to
 * the pool, so every existing caller is unchanged.
 */
async function isBlockedBetween(a, b, db = pool) {
  const x = participantId(a, 'a');
  const y = participantId(b, 'b');
  if (x === ABSENT || y === ABSENT || x === y) return false;
  const r = await db.query(
    `SELECT 1 FROM user_blocks
     WHERE (blocker_id = $1 AND blocked_id = $2)
        OR (blocker_id = $2 AND blocked_id = $1)
     LIMIT 1`,
    [x, y]
  );
  return r.rows.length > 0;
}

/**
 * All user ids that should be invisible to `userId` (blocked in either
 * direction) — for filtering lists, feeds, and group surfaces.
 *
 * This is also the answer to "I need a block decision for N people": ask once
 * and test a Set, never `isBlockedBetween` in a loop. See the note in
 * routes/flocks.js on what the per-pair version cost the invite path.
 *
 * @returns {Promise<number[]>}
 */
async function getInvisibleUserIds(userId, db = pool) {
  const id = participantId(userId, 'userId');
  if (id === ABSENT) return [];
  const r = await db.query(
    `SELECT blocked_id AS id FROM user_blocks WHERE blocker_id = $1
     UNION
     SELECT blocker_id AS id FROM user_blocks WHERE blocked_id = $1`,
    [id]
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
//
// Round 20: `.sort((m, n) => m - n)` over a value Number() could not read left
// the pair in place, because the comparator returns NaN and the sort treats
// that as "no swap". So `[NaN, 5]` stayed `NaN_5` and `[5, NaN]` stayed
// `5_NaN`: one pair, two keys, and an invalidation that could never find what
// the other call site wrote. That is the SAME defect round 17 fixed for the
// string-vs-number case, reintroduced one layer down. Ordering by string
// whenever either side is not a finite number is total, so there is no input
// left for which the key depends on argument order.
function pairKey(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return x <= y ? `${x}_${y}` : `${y}_${x}`;
  const [p, q] = [String(a), String(b)].sort();
  return `${p}_${q}`;
}
async function isBlockedBetweenCached(a, b) {
  // Same rule as the uncached check, asked BEFORE the cache: an id we cannot
  // read must not produce a lookup, and above all must not produce a
  // `blocked: false` entry that then stands for the next 30 seconds on live
  // location and typing.
  const x = participantId(a, 'a');
  const y = participantId(b, 'b');
  if (x === ABSENT || y === ABSENT || x === y) return false;
  // Round 17: the key was built with `a < b`, a RELATIONAL comparison on values
  // that arrive as numbers from REST and as strings from socket payloads.
  // '10' < '9' is true while 10 < 9 is false, so the same pair could produce
  // two different keys depending on which transport asked — one of them a cache
  // entry that the other's invalidation never touches. Keyed off the NORMALIZED
  // ids now, which is the same normalization isBlockedBetween applies.
  const key = pairKey(x, y);
  const now = Date.now();
  const hit = blockCache.get(key);
  if (hit && now - hit.ts < BLOCK_CACHE_TTL) return hit.blocked;
  const blocked = await isBlockedBetween(x, y);
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
// Deliberately TOLERANT where the two checks above are strict. This is cache
// eviction on the success path of a block or an unblock, so throwing here would
// turn a block that worked into a 500 for the person who just used the control.
// Nothing is lost by being tolerant: an id the checks refuse can never have
// written a cache entry in the first place, because they now throw before the
// write rather than caching `blocked: false`.
function invalidateBlockCache(a, b) {
  if (!a || !b) return;
  blockCache.delete(pairKey(a, b));
}

module.exports = { isBlockedBetween, isBlockedBetweenCached, getInvisibleUserIds, invalidateBlockCache };
// Exposed for __tests__/safetyFlow.test.js.
module.exports.__test = { pairKey, blockCache, BLOCK_CACHE_TTL };
