const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const { pushIfOffline } = require('../services/pushHelper');
const { isBlockedBetween, getInvisibleUserIds } = require('../utils/blocks');
const { createUserBudget } = require('../utils/probeBudget');
// One canonical form for a phone number, and a keyed digest to match it by.
// See the long note above find-by-phone, and utils/phone.js for why the old
// last-10-digits suffix comparison had to go.
const { normalizePhoneList, discoveryDigest } = require('../utils/phone');
// Shape before content — see validators/shape.js.
const { scalarOnly } = require('../validators/shape');

const router = express.Router();
router.use(authenticate);

// friendships table lives in migrations/003 — route-owned DDL raced the
// migration runner on fresh deployments (see REVIEW-ROUND5).

// ---------------------------------------------------------------------------
// Directory-probe budget (audit 2026-08-14)
//
// /request and /add-by-code both answer "is there a user behind this id, and
// what are they called?" and both fire a push notification at whoever is
// behind it. find-by-phone already carried a budget for exactly that reason;
// these two did not, so under the general 300/15min limiter one account could
// walk ~28,000 ids a day, harvest the display name for every hit, and ring a
// real person's phone on each one.
//
// 20/hour and 60/day: a legitimate burst is "I met a group of people tonight
// and I am adding all of them", which tops out around 10-15. 60 a day covers an
// unusually social onboarding day with room to spare, while cutting a directory
// walk from ~28,000 ids/day to 60 (a ~460x reduction) and capping the push
// spam any one account can send at 60 strangers a day.
//
// ONE budget shared by both endpoints, on purpose: two separate 60s would just
// hand an enumerator 120.
//
// A probe is only charged when the caller has NO existing friendship row with
// the target. Re-tapping "add" on someone you already have a relationship with
// tells you nothing you did not already know, so it stays free and the UI
// cannot burn a user's budget on double-taps.
// ---------------------------------------------------------------------------
const friendProbeBudget = createUserBudget({ name: 'friend-probe', hourly: 20, daily: 60 });

// Postgres INTEGER ceiling. An id past this reaches the query as an out-of-range
// value and comes back a 500 (which is itself a signal); it is a malformed id,
// so it is rejected as one.
const MAX_USER_ID = 2147483647;

// SHAPE BEFORE CONTENT (round 20). `{"user_id": [5]}` satisfies
// isInt({ min, max }) — express-validator stringifies a one-element array
// before testing it — and the value STAYS an array in req.body. On this route
// parseInt() below flattened it back to a number, so it was merely untidy; on
// /accept and /decline, which read `user_id` straight off the body, the array
// reached pg as a parameter for the INTEGER columns friendships.requester_id /
// addressee_id and came back a 500 rather than a 400. Same guard on all three
// so the three siblings cannot drift apart again. See validators/shape.js.
const scalarUserId = () =>
  scalarOnly(body('user_id'), 'user_id').isInt({ min: 1, max: MAX_USER_ID }).withMessage('user_id is required');

// ---------------------------------------------------------------------------
// EVERY WRITE HERE IS A READ-THEN-WRITE, AND THE WRITE MUST NAME WHAT IT READ.
// (§O round: "two things at once".)
//
// Both request paths do the same thing: SELECT the existing friendship, branch
// on its `status`, then UPDATE by row id. Between those two statements the
// other person is looking at the same row on their own phone. The window is
// small and it is exactly the window that matters, because the two people
// involved are both acting on the same relationship at the same time — that is
// what a friend request IS.
//
// The re-request write was:
//
//     UPDATE friendships SET status = 'pending', requester_id = $1,
//            addressee_id = $2 WHERE id = $3
//
// keyed on the row id and nothing else. If the other person tapped Accept in
// that window, this landed on an ACCEPTED row and put it back to pending, with
// the direction flipped: two people who are friends, neither of whom is told,
// and the accepter's own confirmation silently undone. This is the same shape
// as the invite bug found in flocks this week, where re-inviting demoted a
// member who had accepted mid-request.
//
// So each write carries the status it was decided on. A write that matches
// nothing means the row moved, and the honest answer is what the row says NOW,
// re-read rather than assumed.
// ---------------------------------------------------------------------------
async function reRequestDeclined(rowId, requesterId, addresseeId) {
  try {
    // ONE REVIVE A DAY PER PAIR (friends audit, 2026-09-05). A declined row
    // could be flipped back to pending as fast as the API limiter allowed,
    // and each flip put the request back at the top of the decliner's list
    // with a live toast, so the only exit from a persistent requester was a
    // block. created_at is the row's last-request time: it moves on a
    // revive, and a revive inside a day of it is refused, which the route
    // answers exactly as it answers a request that is already pending, so
    // the refusal itself says nothing about a decline. Naive column, so the
    // window is read the way every other naive window in the codebase is.
    const r = await pool.query(
      `UPDATE friendships SET status = 'pending', requester_id = $1, addressee_id = $2, created_at = NOW()
        WHERE id = $3 AND status = 'declined'
          AND created_at < (NOW() AT TIME ZONE 'UTC') - INTERVAL '24 hours'
        RETURNING id`,
      [requesterId, addresseeId, rowId]
    );
    return r.rows.length > 0;
  } catch (err) {
    // 23505: the direction flip collided with an OPPOSITE-ordered row for the
    // same pair (a crossed pair where both rows ended up declined; the decline
    // keeps its row as 'declined' since 2026-09-04, so this shape is live). The
    // caller answers with currentState() on `false`, which is the honest
    // report; before this catch the constraint violation fell into the outer
    // catch and answered 500 for a tap on a perfectly ordinary button.
    if (err.code === '23505') return false;
    throw err;
  }
}

async function acceptPending(rowId) {
  const r = await pool.query(
    "UPDATE friendships SET status = 'accepted' WHERE id = $1 AND status = 'pending' RETURNING id",
    [rowId]
  );
  return r.rows.length > 0;
}

// REQUEST-THEN-BLOCK, CLOSED FROM THE WRITE SIDE (reliability pass 2026-08-14).
//
// Every relationship write here is preceded by an isBlockedBetween() check, and
// the check and the write are two snapshots: a block committed in the gap used
// to mint a pending request — or an accepted friendship — across a block that
// was already in force. The block route separates the pair too (it deletes
// friendship rows after inserting the block), but ITS delete and OUR insert are
// also two snapshots, so each side could miss the other.
//
// So the write is verified AFTER it lands: re-ask the block table, and if a
// block turned up while the write was in flight, undo the relationship the same
// way routes/moderation.js does — delete the pair's rows — and tell the caller.
// This converges in every interleaving: either our write happens before the
// block route's sweep (their delete removes it), or after (this re-check runs
// later still, so it necessarily sees the committed block and undoes the write
// itself).
//
// The undo swallows its own failure for the same reason the cleanup above does:
// by this point the block verdict is what decides the response, and a failed
// delete leaves rows the block route's sweep or the next accept will clear.
async function severedByFreshBlock(a, b) {
  if (!await isBlockedBetween(a, b)) return false;
  try {
    await pool.query(
      `DELETE FROM friendships
        WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
      [a, b]
    );
  } catch (err) {
    console.error('Post-write block separation failed:', err.message);
  }
  return true;
}

// ---------------------------------------------------------------------------
// A BAN HAS TO REACH THE PLACES A BLOCK ALREADY REACHES.
// ---------------------------------------------------------------------------
// Every relationship path in this file consults utils/blocks.js, and until now
// not one of them consulted `users.is_banned`. POST /find-by-phone was the sole
// exception, and its own header says why: "a banned account is not somebody to
// hand anyone". That sentence was true of the whole file and enforced on one
// route of it, because contact discovery was written last and the rest was
// written before there was a ban.
//
// What that left, on a product whose floor is 13 and whose bans are handed out
// for exactly this: a moderator bans an account, and Flock keeps offering it.
// It came back from Quick Add as a suggestion with a face and a mutual-friend
// count. A friend request aimed at it was accepted and answered "Friend request
// sent", so the sender watched a request sit on Pending forever against an
// account that can never sign in to accept it. A pending request it had sent
// BEFORE the ban stayed at the top of the victim's requests screen, actionable,
// and accepting it minted a live friendship. And GET /api/users/:id/card has
// refused banned rows since it was written, so the friends list was already
// offering a row whose profile card could not open.
//
// TWO SHAPES, matching what the rest of the repo already does:
//
//   LISTS filter, the same way they filter blocked accounts (`GET /`,
//   /pending, /outgoing, /suggestions). Filtering is not deleting: an
//   unbanned account reappears in every one of them with nothing to restore.
//
//   PROBES fold the banned row into the miss they already have. POST /request
//   and POST /add-by-code answer their existing single `miss()`, and POST
//   /accept answers its existing "No pending request from this user", byte
//   for byte the answer a missing row and a blocked pair already get. A
//   distinguishable "that account is banned" would be a NEW oracle: it
//   confirms an id exists AND reports a moderation decision about a named
//   person to a stranger. Same rule routes/users.js's card probe and
//   routes/moderation.js's block probe were built on.
//
// The budget is charged before the ban is consulted, so a banned target costs
// a probe exactly like any other miss and cannot be walked for free.
const NOT_BANNED_SQL = 'COALESCE(u.is_banned, FALSE) = FALSE';

// A CROSSED PAIR IS AN ORPHAN THAT NO SCREEN CAN CLEAR (§O round: "two things
// at once", the other direction).
//
// A requests B and B requests A in the same instant. Neither read finds a row,
// both INSERTs succeed — the unique constraint is on the ORDERED pair, so
// (A,B) and (B,A) are two different keys — and the two of them now hold two
// pending rows. Accepting one left the other pending forever: the accepter sees
// a live outgoing request to somebody they are already friends with, sitting on
// the outgoing screen with no button that touches it, because every other
// handler here matches on `status = 'pending'` in ONE direction.
//
// Once the pair is accepted, any remaining PENDING (or legacy declined) row
// between them is that orphan by definition. Reliability pass 2026-08-14: the
// pending-only DELETE left one more shape behind — BOTH crossed rows accepted.
// A crossed pair holds two pending rows, and two people tapping Accept on each
// other's request at the same moment each update a DIFFERENT row: two accepted
// rows, and the friends list showed the same person twice, forever, because
// nothing pending was left for this cleanup to find. So the statement now also
// collapses duplicate ACCEPTED rows down to one canonical survivor — MIN(id),
// the same row every racer computes, so concurrent cleanups agree instead of
// deleting each other's survivor. The subquery guard means it can NEVER delete
// the last accepted row: with one accepted row the pair is already canonical
// and only the pending/declined leftovers go.
// CLEANUP MUST NOT FAIL THE THING IT FOLLOWS. This runs AFTER the friendship
// has been accepted and committed, and it is housekeeping. Letting it throw
// would answer a successful accept with a 500 — and the retry cannot succeed,
// because the accept is status-guarded and the row is no longer pending, so the
// user would be told "no pending request from this user" about the friend they
// just made. A leftover orphan row is a far smaller problem than that, and the
// next accept between these two would clear it anyway.
async function collapseToOneFriendship(a, b) {
  try {
    await pool.query(
      `DELETE FROM friendships
        WHERE ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
          AND (status = 'pending' OR status = 'declined'
               OR (status = 'accepted' AND id <> (
                     SELECT MIN(f2.id) FROM friendships f2
                      WHERE ((f2.requester_id = $1 AND f2.addressee_id = $2) OR (f2.requester_id = $2 AND f2.addressee_id = $1))
                        AND f2.status = 'accepted')))`,
      [a, b]
    );
  } catch (err) {
    console.error('Crossed-request cleanup failed (friendship is accepted regardless):', err.message);
  }
}

// ONE statement text for every read of "what is between these two people",
// shared by the pre-insert read AND the post-insert convergence re-read below,
// so the two cannot drift apart. Strongest state first, then lowest id, so a
// crossed pair (two legal rows for one pair of people) always yields the same
// answer — and, on the re-read after a fresh INSERT, yields the OTHER side's
// earlier row rather than our own when both are pending.
const PAIR_LOOKUP_SQL =
  `SELECT id, status, requester_id FROM friendships
   WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)
   ORDER BY CASE status WHEN 'accepted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, id
   LIMIT 1`;

// What the relationship is right now, for the caller who lost one of the races
// above. Reported rather than guessed: the whole point is that we no longer
// know without asking.
// A DECLINE IS NEVER VISIBLE TO THE PERSON DECLINED. /outgoing has masked a
// declined row as pending for as long as declines have been kept; three
// other reads did not (friends audit, 2026-09-05): this helper answered
// status 'declined' with a sentence that differed from the pending one,
// GET /status returned the raw status, and find-by-phone put it on the
// row. maskedStatus is the one rule, applied wherever the caller is the
// requester of a declined row.
function maskedStatus(row, callerId) {
  if (!row) return 'none';
  if (row.status === 'declined' && Number(row.requester_id) === Number(callerId)) return 'pending';
  return row.status;
}

async function currentState(a, b) {
  const r = await pool.query(
    `SELECT id, status, requester_id FROM friendships
      WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)
      ORDER BY CASE status WHEN 'accepted' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, id
      LIMIT 1`,
    [a, b]
  );
  const status = maskedStatus(r.rows[0], a) || 'none';
  if (status === 'accepted') return { message: 'Already friends', status: 'accepted' };
  if (status === 'pending') return { message: 'Friend request already sent', status: 'pending' };
  return { message: 'Friend request could not be sent. Try again.', status };
}

// POST /api/friends/request - Send a friend request
router.post('/request',
  scalarUserId(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      // isInt() passes for the STRING "5", and `"5" === 5` is false, so the
      // self-check below used to be bypassable by sending user_id as a string —
      // which minted a friendship row pointing at yourself.
      const user_id = parseInt(req.body.user_id, 10);

      if (user_id === req.user.id) {
        return res.status(400).json({ error: 'Cannot send friend request to yourself' });
      }

      // The single response for "nothing here". Budget exhaustion answers with
      // exactly this, because a distinguishable 429 would replace the
      // enumeration channel rather than close it: "429 = real user, 404 = no
      // such user" is the same oracle wearing a different status code.
      const miss = () => res.status(404).json({ error: 'User not found' });

      // Check if a friendship already exists in either direction. This runs
      // FIRST because it reads the caller's own relationships (no directory
      // information) and decides whether this call is a probe at all.
      //
      // ORDERED, because there can be two rows. The unique constraint is on the
      // ORDERED pair, so a crossed request (A asks B while B asks A) leaves
      // (A,B) and (B,A) both present and legal. With no ORDER BY, `rows[0]` was
      // whatever Postgres handed back first, so the same pair of people got a
      // different answer to the same tap depending on physical row order —
      // including "friend request sent" to somebody they are already friends
      // with. Strongest state first: an accepted relationship is the truth
      // about these two people whatever else is lying around.
      const existing = await pool.query(PAIR_LOOKUP_SQL, [req.user.id, user_id]);

      // Charged on every probe at a stranger, hit or miss. Charging only on
      // hits would leave misses free and unbounded, and "the free answers are
      // the misses" is the enumeration signal itself.
      // An existing row is not charged, because it is not a probe, with one
      // exception: reviving a DECLINED row is a fresh request to somebody who
      // said no, and it is metered like any other (friends audit, 2026-09-05).
      const untouched = existing.rows.length > 0 && !existing.rows.some((r) => r.status === 'declined');
      const withinBudget = untouched || friendProbeBudget.allow(req.user.id);

      // Deliberately queried even when the budget is spent, so the exhausted
      // path does the same work as a genuine miss and cannot be separated from
      // it by response time.
      //
      // is_banned rides along in the SAME statement rather than a second one,
      // so a banned target and a missing one still cost one identical query and
      // one identical 404 (see NOT_BANNED_SQL above).
      const userCheck = await pool.query('SELECT id, name, is_banned FROM users WHERE id = $1', [user_id]);
      if (!withinBudget || userCheck.rows.length === 0 || userCheck.rows[0].is_banned) {
        return miss();
      }

      // Mutual block — can't friend someone you (or they) blocked.
      // Answered like a miss, on purpose. The accept route already answers a
      // blocked pair with the miss-shaped 404; this door answered a distinct
      // 403, so one request confirmed a block to the person who was blocked.
      if (await isBlockedBetween(req.user.id, user_id)) {
        return miss();
      }

      const io = req.app.get('io');

      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.status === 'accepted') {
          return res.json({ message: 'Already friends', status: 'accepted' });
        }
        if (row.status === 'pending') {
          // If the OTHER person sent us a request, auto-accept. Guarded by the
          // status it read: if they withdrew it in the meantime this must not
          // resurrect a relationship neither side is currently asking for.
          if (row.requester_id === user_id) {
            if (!await acceptPending(row.id)) {
              return res.json(await currentState(req.user.id, user_id));
            }
            if (await severedByFreshBlock(req.user.id, user_id)) {
              return res.status(403).json({ error: 'You can no longer connect with this user.' });
            }
            await collapseToOneFriendship(req.user.id, user_id);
            // Notify both sides
            if (io) {
              io.to(`user:${user_id}`).emit('friend_request_responded', { fromUserId: req.user.id, fromUserName: req.user.name, action: 'accepted' });
            }
            // A mutual request that accepted itself told the other side over the
            // socket only; an explicit accept also pushes. Same words, same type.
            await pushIfOffline(io, user_id, 'You are now friends', `${req.user.name} accepted your friend request.`, { type: 'friend_accepted', fromUserId: String(req.user.id) });
            return res.json({ message: `You and ${userCheck.rows[0].name} are now friends!`, status: 'accepted' });
          }
          return res.json({ message: 'Friend request already sent', status: 'pending' });
        }
        // If declined, allow re-request — but only over a row that is STILL
        // declined. See reRequestDeclined() for what the unguarded version did.
        const revived = await reRequestDeclined(row.id, req.user.id, user_id);
        if (!revived) return res.json(await currentState(req.user.id, user_id));
        if (io) io.to(`user:${user_id}`).emit('friend_request_received', { fromUserId: req.user.id, fromUserName: req.user.name });
        // The same sentence a pending row gets: "sent to <name>" here and
        // "already sent" there told the requester which one they were.
        return res.json({ message: 'Friend request already sent', status: 'pending' });
      }

      // ON CONFLICT DO NOTHING, because the read above and this write are not
      // one operation (§O round: "two things at once"). friendships carries
      // UNIQUE(requester_id, addressee_id). Two taps of the same button, or the
      // client's own retry after a lost connection, both read "no relationship"
      // and both INSERT; the loser raised 23505 straight into the outer catch
      // and answered 500 — for a request that had in fact succeeded a
      // millisecond earlier, on a row already committed and a push already sent
      // to the other person. The user sees a failure, taps again, and the same
      // thing happens for as long as the row exists.
      const inserted = await pool.query(
        `INSERT INTO friendships (requester_id, addressee_id, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (requester_id, addressee_id) DO NOTHING
         RETURNING id`,
        [req.user.id, user_id]
      );

      // Nothing inserted means the row was already there. It is the same
      // outcome the caller asked for, so it is a success — but it is NOT a new
      // event, so nothing is emitted and nobody's phone rings a second time.
      if (inserted.rows.length === 0) {
        return res.json({ message: 'Friend request already sent', status: 'pending' });
      }

      // Verify the write against a block that may have landed while it was in
      // flight — see severedByFreshBlock.
      if (await severedByFreshBlock(req.user.id, user_id)) {
        return res.status(403).json({ error: 'You can no longer connect with this user.' });
      }

      // CONVERGE THE CROSSED PAIR AT THE MOMENT IT IS CREATED. The read at the
      // top and the insert above are two snapshots: A requests B while B
      // requests A, both reads see nothing, both inserts succeed (the unique
      // key is on the ORDERED pair), and the two of them used to hold two
      // pending rows until someone accepted — and if both then accepted, two
      // ACCEPTED rows. So re-read the pair now, after our insert. The later of
      // the two crossed inserts is GUARANTEED to see both rows here, and the
      // lookup's ORDER BY hands it the other side's earlier row: two people who
      // asked for each other at the same instant are two people who agree, so
      // it is accepted on the spot and the pair collapses to one row. A plain
      // un-crossed request just sees its own row and takes the normal path.
      const after = await pool.query(PAIR_LOOKUP_SQL, [req.user.id, user_id]);
      const seen = after.rows[0];
      if (seen && seen.status === 'accepted') {
        // An accept landed between our insert and this read.
        await collapseToOneFriendship(req.user.id, user_id);
        return res.json({ message: `You and ${userCheck.rows[0].name} are now friends!`, status: 'accepted' });
      }
      if (seen && seen.status === 'pending' && seen.requester_id === user_id) {
        if (await acceptPending(seen.id)) {
          await collapseToOneFriendship(req.user.id, user_id);
          if (io) {
            io.to(`user:${user_id}`).emit('friend_request_responded', { fromUserId: req.user.id, fromUserName: req.user.name, action: 'accepted' });
          }
          // A mutual request that accepted itself told the other side over the
          // socket only; an explicit accept also pushes. Same words, same type.
          await pushIfOffline(io, user_id, 'You are now friends', `${req.user.name} accepted your friend request.`, { type: 'friend_accepted', fromUserId: String(req.user.id) });
          return res.json({ message: `You and ${userCheck.rows[0].name} are now friends!`, status: 'accepted' });
        }
        return res.json(await currentState(req.user.id, user_id));
      }

      // Notify target user
      if (io) io.to(`user:${user_id}`).emit('friend_request_received', { fromUserId: req.user.id, fromUserName: req.user.name });

      // Push notification
      await pushIfOffline(io, user_id,
        'New friend request',
        `${req.user.name} wants to be friends`,
        { type: 'friend_request', fromUserId: String(req.user.id) }
      );

      res.json({ message: `Friend request sent to ${userCheck.rows[0].name}`, status: 'pending' });
    } catch (err) {
      console.error('Friend request error:', err);
      res.status(500).json({ error: 'Failed to send friend request' });
    }
  }
);

// POST /api/friends/accept - Accept a friend request
router.post('/accept',
  scalarUserId(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { user_id } = req.body;

      // Blocks were checked when SENDING a request but not when accepting one,
      // and blocking never cleared requests already in flight. So a request
      // sent before the block stayed sitting in the addressee's list, and
      // accepting it minted an 'accepted' friendship across the block plus a
      // `friend_request_responded` socket event carrying the accepter's name
      // straight into the blocked party's client. A block ends the pending
      // request instead of leaving it as a live path back in.
      if (await isBlockedBetween(req.user.id, user_id)) {
        await pool.query(
          `DELETE FROM friendships
           WHERE status = 'pending'
             AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
          [req.user.id, user_id]
        );
        return res.status(404).json({ error: 'No pending request from this user' });
      }

      // The requester may have been banned since they asked. A request sent
      // before the ban is still a live pending row, and accepting it minted a
      // friendship with an account moderation has removed. That is the one
      // shape a ban most needs to stop, because the requests screen is where a
      // stranger
      // reaches a 13-year-old. Refused in the UPDATE itself rather than in a
      // second round trip: nothing matches, so the existing `rows.length === 0`
      // branch answers the same "No pending request from this user" a missing
      // row and a blocked pair already answer (see NOT_BANNED_SQL).
      //
      // The row is NOT deleted, unlike the block path above it. A ban expires
      // and can be lifted; GET /pending already stops listing the request, so
      // it is invisible rather than lingering, and it comes back intact if the
      // account is restored. Deleting would destroy a real request over a
      // decision that is reversible.
      const result = await pool.query(
        `UPDATE friendships SET status = 'accepted'
         WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'
           AND EXISTS (SELECT 1 FROM users u WHERE u.id = $1 AND ${NOT_BANNED_SQL})
         RETURNING *`,
        [user_id, req.user.id]
      );

      if (result.rows.length === 0) {
        // Two accepts racing over a crossed pair: the winner's cleanup can
        // delete the pending row this accept was aimed at AFTER our block check
        // passed. The two people ARE friends — telling this caller "no pending
        // request from this user" about the friend they just made is the race
        // leaking into the UI. Report what the relationship actually is.
        const state = await currentState(req.user.id, user_id);
        if (state.status === 'accepted') {
          return res.json({ message: 'Friend request accepted' });
        }
        return res.status(404).json({ error: 'No pending request from this user' });
      }

      // Verify the accept against a block that landed while it was in flight.
      // The blocked-early path above answers the same 404, so the two are
      // indistinguishable to the caller — and either way no friendship remains.
      if (await severedByFreshBlock(req.user.id, user_id)) {
        return res.status(404).json({ error: 'No pending request from this user' });
      }

      // If they had also requested us at the same moment, that second row is
      // now an orphan — and if both of us accepted at once, there are two
      // accepted rows to collapse. See collapseToOneFriendship.
      await collapseToOneFriendship(req.user.id, user_id);

      // Notify the requester
      const io = req.app.get('io');
      if (io) {
        io.to(`user:${user_id}`).emit('friend_request_responded', { fromUserId: req.user.id, fromUserName: req.user.name, action: 'accepted' });
      }

      res.json({ message: 'Friend request accepted' });

      // The ASK pushed and the YES did not, so the person who reached out was
      // told nothing when it worked. One push, to one person, caused by a
      // human tapping accept, and it is the end of that exchange rather than
      // the start of a thread: there is nothing after this to be notified
      // about. fromUserId is the accepter, whose name is in the body.
      //
      // Post-response like every other push, with its own try/catch so a
      // Firebase failure cannot try to answer a request that is already
      // answered.
      try {
        await pushIfOffline(io, user_id,
          'You are now friends',
          `${req.user.name} accepted your friend request.`,
          { type: 'friend_accepted', fromUserId: String(req.user.id) }
        );
      } catch (pushErr) {
        console.error('Friend accepted push error:', pushErr.message);
      }
    } catch (err) {
      console.error('Accept friend error:', err);
      // headersSent: the push above runs post-response, so a failure that
      // reaches here must not attempt a second write to a finished response.
      if (!res.headersSent) res.status(500).json({ error: 'Failed to accept friend request' });
    }
  }
);

// GET /api/friends - List all accepted friends
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.profile_image_url, f.created_at AS friends_since
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
       WHERE (f.requester_id = $1 OR f.addressee_id = $1) AND f.status = 'accepted'
         AND ${NOT_BANNED_SQL}
       ORDER BY u.name ASC`,
      [req.user.id]
    );
    // Mutual invisibility — hide blocked users from the friends list.
    const invisible = new Set(await getInvisibleUserIds(req.user.id));
    res.json({ friends: result.rows.filter((f) => !invisible.has(f.id)) });
  } catch (err) {
    console.error('Get friends error:', err);
    res.status(500).json({ error: 'Failed to get friends' });
  }
});

// GET /api/friends/pending - List pending friend requests received
//
// MUTUAL INVISIBILITY HAS TO HOLD ON EVERY LIST, NOT JUST THE MAIN ONE.
// GET /api/friends has filtered blocked accounts out since round 5. These two
// lists did not, and they are the ones where it shows: blocking somebody left
// their name and their photo sitting at the top of the requests screen, which
// is the most visible place in the app that a block is supposed to reach.
// POST /accept already refuses a blocked requester and deletes the row, so
// until that was tapped the entry was both unactionable and undismissable — the
// user's only reading is that the block did not work.
//
// getInvisibleUserIds, once, rather than a per-row check: see utils/blocks.js
// on what the per-pair version cost the invite path.
router.get('/pending', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.profile_image_url, f.created_at
       FROM friendships f
       JOIN users u ON u.id = f.requester_id
       WHERE f.addressee_id = $1 AND f.status = 'pending'
         AND ${NOT_BANNED_SQL}
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );
    const invisible = new Set(await getInvisibleUserIds(req.user.id));
    res.json({ requests: result.rows.filter((r) => !invisible.has(r.id)) });
  } catch (err) {
    console.error('Get pending requests error:', err);
    res.status(500).json({ error: 'Failed to get pending requests' });
  }
});

// POST /api/friends/decline - Decline a friend request
router.post('/decline',
  scalarUserId(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { user_id } = req.body;

      // The row STAYS, as 'declined'. It used to be deleted, which left no
      // record at all: the next request from the same person inserted fresh
      // and pushed again, bounded only by the daily probe budget, so a
      // declined stranger could ring a phone dozens of times a day. Over a
      // declined row the request door revives quietly (reRequestDeclined:
      // socket event to the addressee's open app, no push), the addressee's
      // pending list filters on 'pending' so nothing reappears there, and the
      // requester still reads 'pending', which is the non-leak the decline
      // has always kept.
      const result = await pool.query(
        `UPDATE friendships SET status = 'declined'
         WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'
         RETURNING id`,
        [user_id, req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'No pending request from this user' });
      }

      res.json({ message: 'Friend request declined' });
    } catch (err) {
      console.error('Decline friend error:', err);
      res.status(500).json({ error: 'Failed to decline friend request' });
    }
  }
);

// DELETE /api/friends/:userId - Remove a friend or cancel outgoing request
router.delete('/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    // Bounded to INT4: an id past MAX_USER_ID reaches the DELETE as an
    // out-of-range value and 500s instead of returning a clean 400.
    if (!Number.isInteger(userId) || userId < 1 || userId > MAX_USER_ID) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // A declined row belongs to the person who declined it. Its requester
    // cannot remove it and then request again as if for the first time (which
    // would insert fresh and push), so the exclusion below keeps the decline's
    // record in the one hand that can clear it.
    const result = await pool.query(
      `DELETE FROM friendships
       WHERE ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))
         AND NOT (status = 'declined' AND requester_id = $1)
       RETURNING id`,
      [req.user.id, userId]
    );

    if (result.rows.length === 0) {
      // A declined request reads as pending to its requester, so cancelling
      // it must answer as cancelling a pending one does; the 404 here was a
      // decline oracle (Codex round 3, 2026-09-05). The row stays, because it
      // carries the one-a-day revive cooldown.
      const masked = await pool.query(
        "SELECT 1 FROM friendships WHERE requester_id = $1 AND addressee_id = $2 AND status = 'declined'",
        [req.user.id, userId]
      );
      if (masked.rows.length > 0) return res.json({ message: 'Removed' });
      return res.status(404).json({ error: 'No friendship found' });
    }

    res.json({ message: 'Removed' });
  } catch (err) {
    console.error('Remove friend error:', err);
    res.status(500).json({ error: 'Failed to remove friend' });
  }
});

// GET /api/friends/outgoing - List pending friend requests sent by current user
router.get('/outgoing', async (req, res) => {
  try {
    const result = await pool.query(
      // 'declined' rides along and is reported as pending. The decline path
      // keeps the row precisely so the requester is not told they were turned
      // down, and this read was dropping it instead, so the request silently
      // vanished from Sent Requests. Vanishing is its own disclosure.
      `SELECT u.id, u.name, u.profile_image_url, f.created_at
       FROM friendships f
       JOIN users u ON u.id = f.addressee_id
       WHERE f.requester_id = $1 AND f.status IN ('pending', 'declined')
         AND ${NOT_BANNED_SQL}
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );
    // Same reason as /pending above.
    const invisible = new Set(await getInvisibleUserIds(req.user.id));
    res.json({ requests: result.rows.filter((r) => !invisible.has(r.id)) });
  } catch (err) {
    console.error('Get outgoing requests error:', err);
    res.status(500).json({ error: 'Failed to get outgoing requests' });
  }
});

// GET /api/friends/suggestions - Mutual friend suggestions (friends of friends)
router.get('/suggestions', async (req, res) => {
  try {
    const result = await pool.query(
      `WITH mine AS (
         SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS friend_id
           FROM friendships
          WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)
       ), theirs AS (
         -- Either end of the friend's own rows. The old join only matched a
         -- friend who was the ADDRESSEE of f2, so every friend-of-a-friend
         -- where the friend had sent the request never surfaced.
         SELECT CASE WHEN f2.requester_id = m.friend_id THEN f2.addressee_id ELSE f2.requester_id END AS candidate
           FROM mine m
           JOIN friendships f2
             ON f2.status = 'accepted'
            AND (f2.requester_id = m.friend_id OR f2.addressee_id = m.friend_id)
       )
       SELECT u.id, u.name, u.profile_image_url, COUNT(*) AS mutual_count
       FROM theirs t
       JOIN users u ON u.id = t.candidate
       WHERE NOT EXISTS (
         SELECT 1 FROM friendships
         WHERE ((requester_id = $1 AND addressee_id = u.id) OR (requester_id = u.id AND addressee_id = $1))
       )
       AND NOT EXISTS (
         SELECT 1 FROM user_blocks
         WHERE (blocker_id = $1 AND blocked_id = u.id) OR (blocker_id = u.id AND blocked_id = $1)
       )
       AND u.id != $1
       AND ${NOT_BANNED_SQL}
       GROUP BY u.id, u.name, u.profile_image_url
       ORDER BY mutual_count DESC
       LIMIT 20`,
      [req.user.id]
    );
    res.json({ suggestions: result.rows });
  } catch (err) {
    // Fallback: return suggested users from shared flocks if mutual friends query fails
    console.error('Suggestions error (trying fallback):', err.message);
    try {
      const fallback = await pool.query(
        // Shared FLOCKS, not mutual friends. Returned under its own name and
        // labelled by `source` so the row cannot print "3 mutual friends" about
        // somebody the caller has no mutual friends with.
        `SELECT u.id, u.name, u.profile_image_url, COUNT(fm2.flock_id) AS shared_flocks
         FROM flock_members fm1
         JOIN flock_members fm2 ON fm2.flock_id = fm1.flock_id AND fm2.user_id != fm1.user_id AND fm2.status = 'accepted'
         JOIN users u ON u.id = fm2.user_id
         WHERE fm1.user_id = $1 AND fm1.status = 'accepted'
         AND ${NOT_BANNED_SQL}
         AND NOT EXISTS (
           SELECT 1 FROM friendships
           WHERE ((requester_id = $1 AND addressee_id = u.id) OR (requester_id = u.id AND addressee_id = $1))
         )
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks
           WHERE (blocker_id = $1 AND blocked_id = u.id) OR (blocker_id = u.id AND blocked_id = $1)
         )
         GROUP BY u.id, u.name, u.profile_image_url
         ORDER BY shared_flocks DESC
         LIMIT 20`,
        [req.user.id]
      );
      res.json({ suggestions: fallback.rows });
    } catch (err2) {
      console.error('Suggestions fallback error:', err2);
      res.status(500).json({ error: 'Failed to get suggestions' });
    }
  }
});

// GET /api/friends/my-code - Get current user's friend code
router.get('/my-code', async (req, res) => {
  try {
    // Generate a deterministic, short friend code from user ID
    const code = 'FLOCK-' + req.user.id.toString(36).toUpperCase().padStart(4, '0');
    res.json({ code, userId: req.user.id, name: req.user.name });
  } catch (err) {
    console.error('Friend code error:', err);
    res.status(500).json({ error: 'Failed to get friend code' });
  }
});

// POST /api/friends/add-by-code - Add friend by their friend code
router.post('/add-by-code',
  // Bounded: a code is 'FLOCK-' plus a base36 id, so anything long is not a
  // typo, it is someone feeding a megabyte to a regex and a toUpperCase().
  //
  // Shape first (round 20): `{"code": ["FLOCK-1"]}` satisfies isLength — the
  // array is stringified before the rule sees it — and stays an array, so
  // `code.toUpperCase()` below threw a TypeError and the route answered 500 for
  // a body the caller picked. An empty array satisfied isLength({ min: 1 })
  // vacuously for the same reason, which is a "required" field that was not.
  scalarOnly(body('code'), 'friend code').trim().isLength({ min: 1, max: 64 }).withMessage('Friend code is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { code } = req.body;
      // Parse code: FLOCK-XXXX -> base36 user ID
      const match = code.toUpperCase().match(/^FLOCK-([A-Z0-9]+)$/);
      if (!match) {
        return res.status(400).json({ error: 'Invalid friend code format' });
      }

      const targetUserId = parseInt(match[1], 36);
      if (targetUserId === req.user.id) {
        return res.status(400).json({ error: "That's your own code!" });
      }

      // The single "no such code" response. Budget exhaustion answers with this
      // too — see the note on POST /request. Friend codes are just base36 user
      // ids, so the code space IS the id space and walking it is trivial.
      const miss = () => res.status(404).json({ error: 'No user found with this code' });

      // 'FLOCK-ZZZZZZZZZZ' parses to a number far past Postgres's INTEGER
      // range, which used to surface as a 500 (and a 500 vs a 404 is a signal).
      if (!Number.isSafeInteger(targetUserId) || targetUserId < 1 || targetUserId > MAX_USER_ID) {
        return miss();
      }

      // Same order as POST /request: own-relationship lookup, then budget, then
      // the directory read, with one indistinguishable answer for all misses.
      const existing = await pool.query(PAIR_LOOKUP_SQL, [req.user.id, targetUserId]);

      // An existing row is not charged, because it is not a probe, with one
      // exception: reviving a DECLINED row is a fresh request to somebody who
      // said no, and it is metered like any other (friends audit, 2026-09-05).
      const untouched = existing.rows.length > 0 && !existing.rows.some((r) => r.status === 'declined');
      const withinBudget = untouched || friendProbeBudget.allow(req.user.id);

      // Same statement, same single miss, and the banned row folded into it.
      // See NOT_BANNED_SQL. A friend code is a base36 user id, so this door is
      // the id space walked with a different spelling and has to answer
      // identically to POST /request.
      const userCheck = await pool.query('SELECT id, name, is_banned FROM users WHERE id = $1', [targetUserId]);
      if (!withinBudget || userCheck.rows.length === 0 || userCheck.rows[0].is_banned) {
        return miss();
      }

      // Mutual block — can't friend someone you (or they) blocked.
      // Same as /request above: a block reads as a miss.
      if (await isBlockedBetween(req.user.id, targetUserId)) {
        return miss();
      }

      const io = req.app.get('io');

      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.status === 'accepted') {
          return res.json({ message: `Already friends with ${userCheck.rows[0].name}`, status: 'accepted', user: userCheck.rows[0] });
        }
        // Every write below carries the status it was decided on, and every
        // race answers with the state the row actually reached. Same rules as
        // POST /request — the two paths are the same operation reached through
        // two different front doors, and they must not drift apart.
        if (row.status === 'pending' && row.requester_id === targetUserId) {
          if (!await acceptPending(row.id)) {
            return res.json({ ...await currentState(req.user.id, targetUserId), user: userCheck.rows[0] });
          }
          if (await severedByFreshBlock(req.user.id, targetUserId)) {
            return res.status(403).json({ error: 'You can no longer connect with this user.' });
          }
          await collapseToOneFriendship(req.user.id, targetUserId);
          if (io) io.to(`user:${targetUserId}`).emit('friend_request_responded', { fromUserId: req.user.id, fromUserName: req.user.name, action: 'accepted' });
          await pushIfOffline(io, targetUserId, 'You are now friends', `${req.user.name} accepted your friend request.`, { type: 'friend_accepted', fromUserId: String(req.user.id) });
          return res.json({ message: `You and ${userCheck.rows[0].name} are now friends!`, status: 'accepted', user: userCheck.rows[0] });
        }
        if (row.status === 'pending') {
          return res.json({ message: 'Friend request already sent', status: 'pending', user: userCheck.rows[0] });
        }
        if (!await reRequestDeclined(row.id, req.user.id, targetUserId)) {
          return res.json({ ...await currentState(req.user.id, targetUserId), user: userCheck.rows[0] });
        }
        if (io) io.to(`user:${targetUserId}`).emit('friend_request_received', { fromUserId: req.user.id, fromUserName: req.user.name });
        // Same sentence as a pending row; see POST /request.
        return res.json({ message: 'Friend request already sent', status: 'pending', user: userCheck.rows[0] });
      }

      // Conflict-tolerant insert, post-write block verify, and the crossed-pair
      // convergence re-read — same three steps, same reasons, as POST /request.
      const inserted = await pool.query(
        `INSERT INTO friendships (requester_id, addressee_id, status)
         VALUES ($1, $2, 'pending')
         ON CONFLICT (requester_id, addressee_id) DO NOTHING
         RETURNING id`,
        [req.user.id, targetUserId]
      );
      if (inserted.rows.length === 0) {
        return res.json({ message: 'Friend request already sent', status: 'pending', user: userCheck.rows[0] });
      }

      if (await severedByFreshBlock(req.user.id, targetUserId)) {
        return res.status(403).json({ error: 'You can no longer connect with this user.' });
      }

      const after = await pool.query(PAIR_LOOKUP_SQL, [req.user.id, targetUserId]);
      const seen = after.rows[0];
      if (seen && seen.status === 'accepted') {
        await collapseToOneFriendship(req.user.id, targetUserId);
        return res.json({ message: `You and ${userCheck.rows[0].name} are now friends!`, status: 'accepted', user: userCheck.rows[0] });
      }
      if (seen && seen.status === 'pending' && seen.requester_id === targetUserId) {
        if (await acceptPending(seen.id)) {
          await collapseToOneFriendship(req.user.id, targetUserId);
          if (io) io.to(`user:${targetUserId}`).emit('friend_request_responded', { fromUserId: req.user.id, fromUserName: req.user.name, action: 'accepted' });
          await pushIfOffline(io, targetUserId, 'You are now friends', `${req.user.name} accepted your friend request.`, { type: 'friend_accepted', fromUserId: String(req.user.id) });
          return res.json({ message: `You and ${userCheck.rows[0].name} are now friends!`, status: 'accepted', user: userCheck.rows[0] });
        }
        return res.json({ ...await currentState(req.user.id, targetUserId), user: userCheck.rows[0] });
      }

      if (io) io.to(`user:${targetUserId}`).emit('friend_request_received', { fromUserId: req.user.id, fromUserName: req.user.name });
      // The push /request sends. This door emitted the socket event only, so
      // a code scanned while its owner was offline reached them never.
      await pushIfOffline(io, targetUserId,
        'New friend request',
        `${req.user.name} wants to be friends`,
        { type: 'friend_request', fromUserId: String(req.user.id) }
      );
      res.json({ message: `Friend request sent to ${userCheck.rows[0].name}`, status: 'pending', user: userCheck.rows[0] });
    } catch (err) {
      console.error('Add by code error:', err);
      res.status(500).json({ error: 'Failed to add friend by code' });
    }
  }
);

// ---------------------------------------------------------------------------
// CONTACT DISCOVERY (round 9 budget, rebuilt 2026-08-25 for the contacts feature)
//
// This endpoint answers "does this phone number belong to a Flock user, and who
// is it?" It is the highest-yield probe in the API, and it is the one place the
// product asks a user to hand over OTHER people's personal data. Four things
// hold it together, and none of them is optional:
//
//   1. OPT-IN. A user is findable by number only while users.phone_discoverable
//      is TRUE (migration 051). Giving Flock a number so an account can be
//      recovered is not agreeing to be found by everyone who has it. The column
//      defaults FALSE, so nobody became discoverable by this code shipping.
//
//   2. KEYED DIGEST, NOT DIGITS. Uploaded numbers are normalised to E.164 and
//      HMAC'd (utils/phone.js) before they touch a query. Nothing raw is
//      compared, indexed or written, and a number belonging to a non-user
//      leaves no trace at all: it exists as a string on this request and is
//      gone when the request ends. The previous version compared the last 10
//      digits with a suffix regex over a full scan of `users`, so a 7-digit
//      fragment matched every number ending in those digits across a thousand
//      area codes.
//
//   3. THE RESPONSE IS NOT A MAP. Matches come back sorted by user id, with no
//      echo of which uploaded number produced which person. A batch of 200 that
//      returns 3 people does not say which 3 of the 200 they are. That does not
//      make targeted identification impossible (split the batch and look again)
//      but it prices it: narrowing one number out of 200 costs about 8 of the
//      caller's 10 daily syncs instead of being free.
//
//   4. BUDGETS, CHARGED ON HITS AND MISSES ALIKE, AFTER NORMALISATION.
//      Charging before normalising was the round-O defect: an address book with
//      nothing usable in it spent the whole allowance on lookups that never
//      happened, and the attempt where the user had finally granted the right
//      permission was refused. A budget denominated in directory reads may only
//      be charged for a directory read.
//
// TWO BUDGETS, because there are two genuinely different gestures behind this
// one route and one budget cannot serve both:
//
//   BULK (more than one number): the address-book sync. 3/hour and 10/day, the
//   tightest budget in the repo, correctly, because one call is up to 200
//   directory reads.
//
//   SINGLE (exactly one number): "add this person by their number", which is
//   what both the typed-number field and a contact picked one at a time
//   produce. Under the bulk budget a user could do that three times an hour,
//   which is not a feature. It is metered at the friend probe's own limits
//   because it is the friend probe's question asked with a number instead of an
//   id, and its yield is the same: one person.
//
//   Splitting a list into singles is not a way around the bulk budget. 60
//   single lookups a day is far under the 2,000 numbers a day the bulk lane
//   already allows, so the small lane adds no capacity to an enumerator. It
//   exists so the small gesture is not priced like the large one.
//
// AN EXHAUSTED BUDGET ANSWERS 429, and that is deliberately NOT the pattern
// moderation.js's block probe uses. There the refusal had to be shaped like a
// miss, because a miss was an answer about ONE named id and a distinguishable
// refusal would have leaked whether that id existed. Here the caller already
// knows every number they sent, and the refusal covers the whole request rather
// than any one number, so it carries no information about anybody. Given that,
// a silent empty result would be a plain lie to a real user: it reads as
// "nobody in your contacts uses Flock", which is the one sentence this screen
// must never say when it does not know.
const MAX_SYNC_PHONES = 200;
const contactSyncBudget = createUserBudget({ name: 'contact-sync', hourly: 3, daily: 10 });
const phoneLookupBudget = createUserBudget({ name: 'phone-lookup', hourly: 20, daily: 60 });

// POST /api/friends/find-by-phone - resolve phone numbers to Flock accounts
router.post('/find-by-phone',
  body('phones').isArray({ min: 1 }).withMessage('Phone numbers array required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { phones } = req.body;
      // Bounded before anything else: the list is walked, normalised and
      // hashed, so an unbounded array is CPU on the only thread. Round 9
      // lowered the ceiling from 500, because a phone book slice that large is
      // a lookup oracle rather than a contact sync.
      if (!Array.isArray(phones) || phones.length > MAX_SYNC_PHONES) {
        return res.status(400).json({ error: `Sync up to ${MAX_SYNC_PHONES} contacts at a time` });
      }

      // NORMALISE FIRST, THEN CHARGE. See point 4 above. normalizePhoneList
      // drops everything that cannot be resolved to one whole number without
      // guessing (a 7-digit local fragment, a name typed into a phone field, an
      // address book entry that carries only an email), de-duplicates, and caps.
      const numbers = normalizePhoneList(phones, MAX_SYNC_PHONES);
      if (numbers.length === 0) return res.json({ users: [], checked: 0 });

      const budget = numbers.length === 1 ? phoneLookupBudget : contactSyncBudget;
      if (!budget.allow(req.user.id)) {
        return res.status(429).json({
          error: numbers.length === 1
            ? 'You have looked up several numbers already. Try again later.'
            : 'You have synced your contacts a few times already. Try again later.',
        });
      }

      // A null digest means the server holds no key at all, which disables the
      // feature rather than degrading it to something reversible.
      const digests = numbers.map((n) => discoveryDigest(n)).filter(Boolean);
      if (digests.length === 0) {
        console.error('Find by phone: no discovery key configured (CONTACT_DISCOVERY_SECRET / JWT_SECRET)');
        return res.json({ users: [], checked: numbers.length });
      }

      // Equality on an indexed digest, gated on consent. Blocked pairs never
      // rediscover each other through this path (round 5), and a banned account
      // is not somebody to hand anyone. ORDER BY id, never input order, so the
      // response cannot be lined up against the list that produced it.
      const result = await pool.query(
        `SELECT id, name, profile_image_url FROM users
          WHERE phone_hash = ANY($2::text[])
            AND phone_discoverable
            AND id != $1
            AND COALESCE(is_banned, FALSE) = FALSE
            AND NOT EXISTS (
              SELECT 1 FROM user_blocks
               WHERE (blocker_id = $1 AND blocked_id = users.id)
                  OR (blocker_id = users.id AND blocked_id = $1)
            )
          ORDER BY id
          LIMIT ${MAX_SYNC_PHONES}`,
        [req.user.id, digests]
      );

      // Get friendship statuses
      const userIds = result.rows.map(u => u.id);
      let friendshipMap = {};
      if (userIds.length > 0) {
        const friendships = await pool.query(
          `SELECT
            CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS friend_id,
            status, requester_id
           FROM friendships
           WHERE (requester_id = $1 OR addressee_id = $1)
           AND (requester_id = ANY($2::int[]) OR addressee_id = ANY($2::int[]))`,
          [req.user.id, userIds]
        );
        // A declined row reads as pending to the person declined; see
        // maskedStatus.
        friendships.rows.forEach(f => { friendshipMap[f.friend_id] = maskedStatus(f, req.user.id); });
      }

      const users = result.rows.map(u => ({
        id: u.id,
        name: u.name,
        profile_image_url: u.profile_image_url,
        friendship_status: friendshipMap[u.id] || null,
      }));

      // `checked` is how many numbers were actually looked up, which is what
      // lets the client say "we checked 143 of your contacts" instead of
      // guessing from the length of what it sent. It is the caller's own data,
      // so it reveals nothing.
      res.json({ users, checked: numbers.length });
    } catch (err) {
      console.error('Find by phone error:', err);
      res.status(500).json({ error: 'Failed to search contacts' });
    }
  }
);

// GET /api/friends/status/:userId - Check friendship status with a specific user
router.get('/status/:userId', async (req, res) => {
  try {
    // parseInt('abc') is NaN, which used to go straight into an INTEGER
    // comparison and come back as a 500 (see DELETE /:userId, which already
    // guarded this).
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isInteger(userId) || userId <= 0 || userId > MAX_USER_ID) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const result = await pool.query(
      `SELECT status, requester_id FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
      [req.user.id, userId]
    );
    if (result.rows.length === 0) {
      return res.json({ status: 'none' });
    }
    // Masked for the requester of a declined row; see maskedStatus.
    res.json({ status: maskedStatus(result.rows[0], req.user.id), requester_id: result.rows[0].requester_id });
  } catch (err) {
    console.error('Friend status error:', err);
    res.status(500).json({ error: 'Failed to check friendship status' });
  }
});

module.exports = router;

// Test hook only. The budgets above are process-wide in-memory state, so a test
// suite needs a way to start each case from a clean allowance. Nothing in the
// running server calls this.
module.exports.__resetBudgets = () => {
  friendProbeBudget.reset();
  contactSyncBudget.reset();
  phoneLookupBudget.reset();
};

// Test hook only. The relationship between the two contact-discovery lanes is
// an argument about arithmetic ("splitting a list into singles buys you less"),
// so the numbers are readable rather than restated in a test where they could
// drift out of step with these.
module.exports.__budgetLimits = () => ({
  friendProbe: friendProbeBudget.limits,
  contactSync: contactSyncBudget.limits,
  phoneLookup: phoneLookupBudget.limits,
});

module.exports.__test = { maskedStatus };
