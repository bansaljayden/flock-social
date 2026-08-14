const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const { pushIfOffline } = require('../services/pushHelper');
const { isBlockedBetween, getInvisibleUserIds } = require('../utils/blocks');
const { createUserBudget } = require('../utils/probeBudget');
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
      const existing = await pool.query(
        `SELECT id, status, requester_id FROM friendships
         WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
        [req.user.id, user_id]
      );

      // Charged on every probe at a stranger, hit or miss. Charging only on
      // hits would leave misses free and unbounded, and "the free answers are
      // the misses" is the enumeration signal itself.
      const withinBudget = existing.rows.length > 0 || friendProbeBudget.allow(req.user.id);

      // Deliberately queried even when the budget is spent, so the exhausted
      // path does the same work as a genuine miss and cannot be separated from
      // it by response time.
      const userCheck = await pool.query('SELECT id, name FROM users WHERE id = $1', [user_id]);
      if (!withinBudget || userCheck.rows.length === 0) {
        return miss();
      }

      // Mutual block — can't friend someone you (or they) blocked.
      if (await isBlockedBetween(req.user.id, user_id)) {
        return res.status(403).json({ error: 'You can no longer connect with this user.' });
      }

      const io = req.app.get('io');

      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.status === 'accepted') {
          return res.json({ message: 'Already friends', status: 'accepted' });
        }
        if (row.status === 'pending') {
          // If the OTHER person sent us a request, auto-accept
          if (row.requester_id === user_id) {
            await pool.query("UPDATE friendships SET status = 'accepted' WHERE id = $1", [row.id]);
            // Notify both sides
            if (io) {
              io.to(`user:${user_id}`).emit('friend_request_responded', { fromUserId: req.user.id, fromUserName: req.user.name, action: 'accepted' });
            }
            return res.json({ message: `You and ${userCheck.rows[0].name} are now friends!`, status: 'accepted' });
          }
          return res.json({ message: 'Friend request already sent', status: 'pending' });
        }
        // If declined, allow re-request
        await pool.query(
          "UPDATE friendships SET status = 'pending', requester_id = $1, addressee_id = $2 WHERE id = $3",
          [req.user.id, user_id, row.id]
        );
        if (io) io.to(`user:${user_id}`).emit('friend_request_received', { fromUserId: req.user.id, fromUserName: req.user.name });
        return res.json({ message: `Friend request sent to ${userCheck.rows[0].name}`, status: 'pending' });
      }

      await pool.query(
        "INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'pending')",
        [req.user.id, user_id]
      );

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

      const result = await pool.query(
        `UPDATE friendships SET status = 'accepted'
         WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'
         RETURNING *`,
        [user_id, req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'No pending request from this user' });
      }

      // Notify the requester
      const io = req.app.get('io');
      if (io) {
        io.to(`user:${user_id}`).emit('friend_request_responded', { fromUserId: req.user.id, fromUserName: req.user.name, action: 'accepted' });
      }

      res.json({ message: 'Friend request accepted' });
    } catch (err) {
      console.error('Accept friend error:', err);
      res.status(500).json({ error: 'Failed to accept friend request' });
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
router.get('/pending', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.profile_image_url, f.created_at
       FROM friendships f
       JOIN users u ON u.id = f.requester_id
       WHERE f.addressee_id = $1 AND f.status = 'pending'
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );
    res.json({ requests: result.rows });
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

      const result = await pool.query(
        `DELETE FROM friendships
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

    const result = await pool.query(
      `DELETE FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)
       RETURNING id`,
      [req.user.id, userId]
    );

    if (result.rows.length === 0) {
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
      `SELECT u.id, u.name, u.profile_image_url, f.created_at
       FROM friendships f
       JOIN users u ON u.id = f.addressee_id
       WHERE f.requester_id = $1 AND f.status = 'pending'
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );
    res.json({ requests: result.rows });
  } catch (err) {
    console.error('Get outgoing requests error:', err);
    res.status(500).json({ error: 'Failed to get outgoing requests' });
  }
});

// GET /api/friends/suggestions - Mutual friend suggestions (friends of friends)
router.get('/suggestions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.profile_image_url, COUNT(*) AS mutual_count
       FROM friendships f1
       JOIN friendships f2 ON (
         (CASE WHEN f1.requester_id = $1 THEN f1.addressee_id ELSE f1.requester_id END) =
         (CASE WHEN f2.requester_id = $1 THEN f2.requester_id ELSE f2.addressee_id END)
       )
       JOIN users u ON u.id = CASE WHEN f2.requester_id = (CASE WHEN f1.requester_id = $1 THEN f1.addressee_id ELSE f1.requester_id END) THEN f2.addressee_id ELSE f2.requester_id END
       WHERE f1.status = 'accepted'
       AND f2.status = 'accepted'
       AND (f1.requester_id = $1 OR f1.addressee_id = $1)
       AND u.id != $1
       AND NOT EXISTS (
         SELECT 1 FROM friendships
         WHERE ((requester_id = $1 AND addressee_id = u.id) OR (requester_id = u.id AND addressee_id = $1))
       )
       AND NOT EXISTS (
         SELECT 1 FROM user_blocks
         WHERE (blocker_id = $1 AND blocked_id = u.id) OR (blocker_id = u.id AND blocked_id = $1)
       )
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
        `SELECT u.id, u.name, u.profile_image_url, COUNT(fm2.flock_id) AS mutual_count
         FROM flock_members fm1
         JOIN flock_members fm2 ON fm2.flock_id = fm1.flock_id AND fm2.user_id != fm1.user_id AND fm2.status = 'accepted'
         JOIN users u ON u.id = fm2.user_id
         WHERE fm1.user_id = $1 AND fm1.status = 'accepted'
         AND NOT EXISTS (
           SELECT 1 FROM friendships
           WHERE ((requester_id = $1 AND addressee_id = u.id) OR (requester_id = u.id AND addressee_id = $1))
         )
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks
           WHERE (blocker_id = $1 AND blocked_id = u.id) OR (blocker_id = u.id AND blocked_id = $1)
         )
         GROUP BY u.id, u.name, u.profile_image_url
         ORDER BY mutual_count DESC
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
      const existing = await pool.query(
        `SELECT id, status, requester_id FROM friendships
         WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
        [req.user.id, targetUserId]
      );

      const withinBudget = existing.rows.length > 0 || friendProbeBudget.allow(req.user.id);

      const userCheck = await pool.query('SELECT id, name FROM users WHERE id = $1', [targetUserId]);
      if (!withinBudget || userCheck.rows.length === 0) {
        return miss();
      }

      // Mutual block — can't friend someone you (or they) blocked.
      if (await isBlockedBetween(req.user.id, targetUserId)) {
        return res.status(403).json({ error: 'You can no longer connect with this user.' });
      }

      const io = req.app.get('io');

      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        if (row.status === 'accepted') {
          return res.json({ message: `Already friends with ${userCheck.rows[0].name}`, status: 'accepted', user: userCheck.rows[0] });
        }
        if (row.status === 'pending' && row.requester_id === targetUserId) {
          await pool.query("UPDATE friendships SET status = 'accepted' WHERE id = $1", [row.id]);
          if (io) io.to(`user:${targetUserId}`).emit('friend_request_responded', { fromUserId: req.user.id, fromUserName: req.user.name, action: 'accepted' });
          return res.json({ message: `You and ${userCheck.rows[0].name} are now friends!`, status: 'accepted', user: userCheck.rows[0] });
        }
        if (row.status === 'pending') {
          return res.json({ message: 'Friend request already sent', status: 'pending', user: userCheck.rows[0] });
        }
        await pool.query("UPDATE friendships SET status = 'pending', requester_id = $1, addressee_id = $2 WHERE id = $3", [req.user.id, targetUserId, row.id]);
        if (io) io.to(`user:${targetUserId}`).emit('friend_request_received', { fromUserId: req.user.id, fromUserName: req.user.name });
        return res.json({ message: `Friend request sent to ${userCheck.rows[0].name}`, status: 'pending', user: userCheck.rows[0] });
      }

      await pool.query(
        "INSERT INTO friendships (requester_id, addressee_id, status) VALUES ($1, $2, 'pending')",
        [req.user.id, targetUserId]
      );
      if (io) io.to(`user:${targetUserId}`).emit('friend_request_received', { fromUserId: req.user.id, fromUserName: req.user.name });
      res.json({ message: `Friend request sent to ${userCheck.rows[0].name}`, status: 'pending', user: userCheck.rows[0] });
    } catch (err) {
      console.error('Add by code error:', err);
      res.status(500).json({ error: 'Failed to add friend by code' });
    }
  }
);

// Contact-discovery budget (round 9). find-by-phone answers "does this phone
// number belong to a Flock user, and who?", so an unbudgeted caller could walk
// a number range and harvest id/name/photo for the whole user base. Contact
// sync is something a real user does a handful of times, not hundreds, so it
// keeps its hard per-user budget of 3/hour and 10/day.
//
// The hand-rolled counter this used to carry is now utils/probeBudget.js — the
// same code was about to exist a third time for the friend-probe budget, and
// the old version could be flushed wholesale (`contactSyncHits.clear()` on
// overflow handed everyone a fresh allowance).
//
// Unlike the friend-probe budget, an exhausted sync answers 429: this endpoint
// takes a caller-supplied list and returns matches, so "no matches" and "you
// are throttled" are not confusable states an attacker can exploit — and a
// silent empty result would look like "none of your contacts use Flock", which
// is a lie the UI would show to a real user.
const MAX_SYNC_PHONES = 200;
const contactSyncBudget = createUserBudget({ name: 'contact-sync', hourly: 3, daily: 10 });

// POST /api/friends/find-by-phone - Find users by phone numbers (for contacts sync)
router.post('/find-by-phone',
  body('phones').isArray({ min: 1 }).withMessage('Phone numbers array required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { phones } = req.body;
      // Bounded + type-safe: the normalized values are joined into ONE SQL
      // regex, so an unbounded array is an expensive scan and a non-string
      // element throws (round 6). Round 9 lowered the ceiling from 500 — a
      // phone book slice that large is a lookup oracle, not a contact sync.
      if (!Array.isArray(phones) || phones.length > MAX_SYNC_PHONES) {
        return res.status(400).json({ error: `Sync up to ${MAX_SYNC_PHONES} contacts at a time` });
      }

      if (!contactSyncBudget.allow(req.user.id)) {
        return res.status(429).json({ error: 'You have synced your contacts a few times already. Try again later.' });
      }

      const normalized = phones
        .filter((p) => typeof p === 'string')
        .map((p) => p.replace(/\D/g, '').slice(-10))
        .filter((p) => p.length >= 7)
        .slice(0, MAX_SYNC_PHONES);
      if (normalized.length === 0) return res.json({ users: [] });

      // Find users whose phone matches (last 10 digits comparison).
      // Blocked pairs never rediscover each other via contact sync (round 5).
      const result = await pool.query(
        `SELECT id, name, profile_image_url, phone FROM users
         WHERE id != $1 AND phone IS NOT NULL
         AND REGEXP_REPLACE(phone, '\\D', '', 'g') SIMILAR TO '%(' || $2 || ')'
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks
           WHERE (blocker_id = $1 AND blocked_id = users.id) OR (blocker_id = users.id AND blocked_id = $1)
         )`,
        [req.user.id, normalized.join('|')]
      );

      // Get friendship statuses
      const userIds = result.rows.map(u => u.id);
      let friendshipMap = {};
      if (userIds.length > 0) {
        const friendships = await pool.query(
          `SELECT
            CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS friend_id,
            status
           FROM friendships
           WHERE (requester_id = $1 OR addressee_id = $1)
           AND (requester_id = ANY($2::int[]) OR addressee_id = ANY($2::int[]))`,
          [req.user.id, userIds]
        );
        friendships.rows.forEach(f => { friendshipMap[f.friend_id] = f.status; });
      }

      const users = result.rows.map(u => ({
        id: u.id,
        name: u.name,
        profile_image_url: u.profile_image_url,
        friendship_status: friendshipMap[u.id] || null,
      }));

      res.json({ users });
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
    res.json({ status: result.rows[0].status, requester_id: result.rows[0].requester_id });
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
};
