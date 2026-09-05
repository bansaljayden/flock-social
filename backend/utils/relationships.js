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
  // A BANNED ACCOUNT HAS NO DM RELATIONSHIP (UGC-loop audit, 2026-09-05).
  // Every DM door on both transports asks this question, so answering "no"
  // for a banned counterpart closes the thread the way a block does: send,
  // react, vote, pin, typing and live location all stop, with no new query
  // on any of them. The clause is repeated on both halves so the statement's
  // shape, and the prefix the test fakes key on, stays what it was.
  const r = await pool.query(
    `SELECT 1 WHERE EXISTS (
       SELECT 1 FROM friendships
       WHERE status = 'accepted'
         AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
     ) AND NOT EXISTS (SELECT 1 FROM users bu WHERE bu.id = $2 AND bu.is_banned IS TRUE)
     OR EXISTS (
       SELECT 1 FROM direct_messages
       WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
     ) AND NOT EXISTS (SELECT 1 FROM users bu WHERE bu.id = $2 AND bu.is_banned IS TRUE)`,
    [a, b]
  );
  return r.rows.length > 0;
}

// ---------------------------------------------------------------------------
// The same question, asked per keystroke
// ---------------------------------------------------------------------------
// The ephemeral DM socket handlers (typing, live location) fire per keystroke
// and every ten seconds, so the uncached query above is the wrong shape for
// them: it is two EXISTS scans per packet. utils/blocks.js already solved this
// exact problem for the block half of the same gate with a short-TTL pair
// cache, and this is that, deliberately built the same way so the two controls
// on the same handler behave alike.
//
// 30s TTL, matching BLOCK_CACHE_TTL. What that costs is bounded and one-sided:
// a relationship that has just STARTED can take up to 30 seconds before typing
// dots flow, which is a cosmetic delay on a feature that has no meaning before
// the first message anyway. It cannot go the other way and keep a stale "yes"
// alive past a block, because the block check is a separate control that runs
// first and has its own invalidation. sockets/handlers.js also invalidates the
// pair the moment it persists a DM, so the ordinary "you just messaged someone
// new" path does not wait out the TTL at all.
//
// The pair key is arithmetic on two values that are already positive integers
// (hasDmRelationship's guard rejects everything else and this defers to it), so
// unlike utils/blocks.js's pairKey there is no mixed-type ordering to get
// wrong here.
const relationshipCache = new Map();
const RELATIONSHIP_CACHE_TTL = 30 * 1000;
const RELATIONSHIP_CACHE_MAX = 5000;

function relationshipKey(a, b) {
  return a <= b ? `${a}_${b}` : `${b}_${a}`;
}

function readableParticipants(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x === y) return null;
  return [x, y];
}

async function hasDmRelationshipCached(userId, otherId) {
  const pair = readableParticipants(userId, otherId);
  // Nothing unreadable may reach the cache. Caching a decision under a key
  // built from junk is how utils/blocks.js's round 20 defect worked, and the
  // fail-closed answer for "cannot read the id" is false either way.
  if (!pair) return false;
  const key = relationshipKey(pair[0], pair[1]);
  const now = Date.now();
  const hit = relationshipCache.get(key);
  if (hit && now - hit.ts < RELATIONSHIP_CACHE_TTL) return hit.connected;
  const connected = await hasDmRelationship(pair[0], pair[1]);
  // Delete-then-set so insertion order is least-recently-written, which is what
  // makes the eviction below oldest-first. Same shape as blocks.js.
  relationshipCache.delete(key);
  relationshipCache.set(key, { ts: now, connected });
  if (relationshipCache.size > RELATIONSHIP_CACHE_MAX) {
    for (const [k, v] of relationshipCache) {
      if (now - v.ts >= RELATIONSHIP_CACHE_TTL) relationshipCache.delete(k);
    }
    while (relationshipCache.size > RELATIONSHIP_CACHE_MAX) {
      relationshipCache.delete(relationshipCache.keys().next().value);
    }
  }
  return connected;
}

// Call after a DM is persisted between two accounts: that row is what CREATES
// the relationship, so a cached "no" from seconds earlier is now wrong.
// Deliberately tolerant, like invalidateBlockCache: this runs on the success
// path of a send, and an id the reader refuses could never have written an
// entry anyway.
function invalidateDmRelationshipCache(a, b) {
  const pair = readableParticipants(a, b);
  if (!pair) return;
  relationshipCache.delete(relationshipKey(pair[0], pair[1]));
}

// One answer for "no such user" and "not connected to you", so neither can be
// read off the other. Phrased for the case a real person will hit.
const NOT_CONNECTED_MESSAGE = "You can only do that with people you're connected with.";

// ---------------------------------------------------------------------------
// "Can this account see that story?" — ONE definition, two callers
// ---------------------------------------------------------------------------
//
// routes/stories.js (the feed) and routes/moderation.js (the gate on
// POST /api/reports, which exists so the report pipeline is not an oracle for
// stories you could never see) both need the same answer, and both had their
// own copy of the SQL. The copies had ALREADY drifted: the report gate has no
// is_banned filter and does not grant you your own stories. One of those
// differences is deliberate and one was an oversight, and with two literal
// blocks of SQL there was no way to tell which was which — the next person to
// fix the feed would have had to know the report gate existed.
//
// So every difference is now a named argument with a reason attached, and there
// is one place to change when the rule changes.
//
// The emitted text is deliberately byte-for-byte what routes/stories.js already
// runs when called with its settings, so adopting it there is a no-op:
//
//   const { storyVisibilitySql } = require('../utils/relationships');
//   ...
//   WHERE ${storyVisibilitySql({ viewer: '$1', authorAlias: 'u' })}
//
// __tests__/moderationReach.test.js pins that equivalence, so the two cannot
// silently part company again in the window before stories.js adopts it.
//
// NOTHING here is interpolated from a request. Aliases and placeholders are
// route constants, and they are validated anyway: this function builds SQL by
// string concatenation, which is the one construct in this codebase that could
// become an injection if a caller ever passed something through from a body.

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;
const SQL_PLACEHOLDER = /^\$[1-9][0-9]*$/;

function assertIdentifier(value, what) {
  if (typeof value !== 'string' || !SQL_IDENTIFIER.test(value)) {
    throw new Error(`storyVisibilitySql: ${what} must be a bare SQL identifier, got ${JSON.stringify(value)}`);
  }
}

function assertPlaceholder(value) {
  if (typeof value !== 'string' || !SQL_PLACEHOLDER.test(value)) {
    throw new Error(`storyVisibilitySql: viewer must be a bind placeholder like "$1", got ${JSON.stringify(value)}`);
  }
}

/**
 * The story visibility predicate, as a SQL fragment with no leading AND.
 *
 * @param {object}  [options]
 * @param {string}  [options.story='s']       alias of the `stories` row.
 * @param {string}  [options.viewer='$1']     bind placeholder holding the viewer's user id.
 * @param {boolean} [options.includeOwn=true] grant the viewer their own stories.
 * @param {boolean} [options.excludeHidden=true]
 *        Filter moderator takedowns. The FEED must. The report gate must NOT:
 *        it reads is_hidden as a COLUMN and answers "already handled" with the
 *        same success string as a fresh report, because two people reporting
 *        the same story seconds apart used to mean the second one was told the
 *        content did not exist.
 * @param {boolean} [options.excludeBannedAuthor=true]
 *        Filter stories by suspended accounts. The FEED must: a ban has to take
 *        the banned account's content down with it. The report gate must NOT —
 *        a report filed against a story whose author was banned an instant
 *        earlier is still a real report about content that was on real screens,
 *        and refusing it would tell the reporter they made it up.
 * @param {?string} [options.authorAlias=null]
 *        When the caller already joins `users` (the feed joins it for the name
 *        and avatar), pass that alias and the ban check is a column read. With
 *        null it becomes a self-contained EXISTS, so a caller that has not
 *        joined `users` still gets a correct predicate rather than a syntax
 *        error naming an alias it never declared.
 * @returns {string} SQL, safe to drop after WHERE or after an AND.
 */
function storyVisibilitySql(options = {}) {
  const {
    story = 's',
    viewer = '$1',
    includeOwn = true,
    excludeHidden = true,
    excludeBannedAuthor = true,
    authorAlias = null,
  } = options;

  assertIdentifier(story, 'story alias');
  assertPlaceholder(viewer);
  if (authorAlias !== null) assertIdentifier(authorAlias, 'author alias');

  const s = story;
  const me = viewer;

  const parts = [`${s}.expires_at > NOW()`];

  if (excludeHidden) parts.push(`${s}.is_hidden IS NOT TRUE`);

  if (excludeBannedAuthor) {
    parts.push(authorAlias
      ? `${authorAlias}.is_banned IS NOT TRUE`
      : `NOT EXISTS (SELECT 1 FROM users ban_u WHERE ban_u.id = ${s}.user_id AND ban_u.is_banned IS TRUE)`);
  }

  // Blocks are mutual and are checked in BOTH directions: shared-flock
  // membership survives a block, so the grants below would otherwise keep
  // leaking stories across it either way round.
  parts.push(
    `NOT EXISTS (
             SELECT 1 FROM user_blocks b
             WHERE (b.blocker_id = ${me} AND b.blocked_id = ${s}.user_id)
                OR (b.blocker_id = ${s}.user_id AND b.blocked_id = ${me})
           )`
  );

  const reach = [];
  if (includeOwn) reach.push(`${s}.user_id = ${me}`);
  reach.push(
    `${s}.user_id IN (
               SELECT CASE WHEN requester_id = ${me} THEN addressee_id ELSE requester_id END
               FROM friendships WHERE (requester_id = ${me} OR addressee_id = ${me}) AND status = 'accepted'
             )`
  );
  reach.push(
    `${s}.user_id IN (
               SELECT fm2.user_id FROM flock_members fm1
               JOIN flock_members fm2 ON fm2.flock_id = fm1.flock_id AND fm2.user_id != ${me} AND fm2.status = 'accepted'
               WHERE fm1.user_id = ${me} AND fm1.status = 'accepted'
             )`
  );
  parts.push(`(\n             ${reach.join('\n             OR ')}\n           )`);

  return parts.join('\n           AND ');
}

module.exports = {
  hasDmRelationship,
  hasDmRelationshipCached,
  invalidateDmRelationshipCache,
  NOT_CONNECTED_MESSAGE,
  storyVisibilitySql,
};

// Exposed so the socket tests can start from a known-empty cache, the way
// __resetRateLimiters does for the event buckets.
module.exports.__test = { relationshipCache, RELATIONSHIP_CACHE_TTL };
