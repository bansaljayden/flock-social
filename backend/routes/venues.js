const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { rejectIfProfane } = require('../utils/moderation');
const { getInvisibleUserIds } = require('../utils/blocks');
// Shape before content — see validators/shape.js.
const { scalarOnly, freeText } = require('../validators/shape');

const router = express.Router();

router.use(authenticate);

// flocks.id is INTEGER. A bare isInt() accepts 99999999999, which Postgres
// rejects with 22003 — a 500 on a route where the honest answer is "no such
// flock". Same bound routes/flocks.js already uses on its own :id params.
const INT4_MAX = 2147483647;
const flockIdParam = () => param('id').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID');

// Voter identities respect mutual blocks (round 5): counts stay honest, but a
// blocked user's id/name never appears in a voters list either direction.
async function invisibleSetsForFlock(flockId) {
  const members = await pool.query(
    "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
    [flockId]
  );
  const ids = members.rows.map(r => r.user_id);
  if (ids.length === 0) return { ids, sets: new Map() };
  const blocks = await pool.query(
    'SELECT blocker_id, blocked_id FROM user_blocks WHERE blocker_id = ANY($1::int[]) OR blocked_id = ANY($1::int[])',
    [ids]
  );
  const sets = new Map(ids.map(id => [id, new Set()]));
  for (const b of blocks.rows) {
    if (sets.has(b.blocker_id)) sets.get(b.blocker_id).add(b.blocked_id);
    if (sets.has(b.blocked_id)) sets.get(b.blocked_id).add(b.blocker_id);
  }
  return { ids, sets };
}

// Helper: check flock membership
async function verifyFlockMember(flockId, userId) {
  const result = await pool.query(
    "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
    [flockId, userId]
  );
  return result.rows.length > 0;
}

// Every tally in this file comes from here so the REST responses, the socket
// broadcasts and the GET all agree: member votes carry identities (kept
// internally so each recipient's blocked users can be stripped), guest-link
// votes are counts only.
async function collectVoteRows(flockId) {
  // Round 16: grouping by (venue_name, venue_id) split one venue into several
  // rows. venue_votes' unique key is (flock_id, user_id, venue_name) and
  // venue_id is nullable, so two members picking the same place through
  // different paths (search result with a place id vs. a typed/legacy row with
  // NULL) landed in different groups. Consequences, all real:
  //   - the same name appeared twice in the list, each with a fraction of the
  //     real count, so the leading venue could lose to a split rival;
  //   - guestByVenue below is keyed by NAME, so every duplicate group got the
  //     FULL guest count added to it — guest votes were double counted.
  // Grouping by the name alone (what the unique key is on) fixes both.
  //
  // Round 17: the tally counted every venue_votes row for the flock, whether or
  // not its author is still in it. POST /api/flocks/:id/leave deletes the
  // flock_members row and nothing else, so a vote outlived its voter: the
  // departed member kept a permanent vote in the tally, their name kept
  // appearing in the voters list, and they could not take it back either
  // (DELETE /vote requires membership). That is a public tally anyone can skew
  // — join, vote, leave, repeat from a second account — and the winning venue
  // is what the flock actually goes to. Membership is the rule for reading the
  // tally (verifyFlockMember on all three routes); it is the rule for
  // contributing to it too.
  const raw = await pool.query(
    `SELECT venue_name,
            MIN(venue_id) FILTER (WHERE venue_id IS NOT NULL) AS venue_id,
            COUNT(*)::int AS member_count,
            ARRAY_AGG(json_build_object('id', u.id, 'name', u.name)) AS voter_rows
     FROM venue_votes vv
     JOIN users u ON u.id = vv.user_id
     JOIN flock_members fm ON fm.flock_id = vv.flock_id AND fm.user_id = vv.user_id
       AND fm.status = 'accepted'
     WHERE vv.flock_id = $1
     GROUP BY venue_name
     ORDER BY member_count DESC`,
    [flockId]
  );

  // Round 13: this counted guest votes WITHOUT the is_hidden join that
  // routes/guest.js applies, so a guest whose RSVP a moderator took down still
  // moved the member-facing tally. A takedown has to remove them everywhere.
  const guests = await pool.query(
    `SELECT gv.venue_name, COUNT(*)::int AS guest_count
     FROM guest_votes gv
     JOIN guest_rsvps gr ON gr.id = gv.guest_rsvp_id
     WHERE gv.flock_id = $1 AND COALESCE(gr.is_hidden, false) = false
     GROUP BY gv.venue_name`,
    [flockId]
  ).catch(() => ({ rows: [] }));
  const guestByVenue = Object.fromEntries(guests.rows.map(g => [g.venue_name, g.guest_count]));

  const rows = raw.rows.map(v => ({
    venue_name: v.venue_name,
    venue_id: v.venue_id,
    member_count: v.member_count,
    guest_count: guestByVenue[v.venue_name] || 0,
    voter_rows: v.voter_rows || [],
  }));
  // Venues only guests have voted on so far still show up for members.
  for (const [name, n] of Object.entries(guestByVenue)) {
    if (!rows.some(r => r.venue_name === name)) {
      rows.push({ venue_name: name, venue_id: null, member_count: 0, guest_count: n, voter_rows: [] });
    }
  }
  return rows;
}

// Wire shape for one recipient. vote_count is the total the vote bars are drawn
// from (members + guests); guest_count lets the UI say "+2 guests".
// voterObjects keeps the { id, name } rows the GET has always returned; the
// POST/DELETE and socket payloads stay a names array.
function tailorVotes(rows, invisible, { voterObjects = false } = {}) {
  return rows
    .map(v => {
      const visible = v.voter_rows.filter(p => !invisible.has(p.id));
      return {
        venue_name: v.venue_name,
        venue_id: v.venue_id,
        vote_count: v.member_count + v.guest_count,
        guest_count: v.guest_count,
        voters: voterObjects ? visible : visible.map(p => p.name),
      };
    })
    .sort((a, b) => b.vote_count - a.vote_count);
}

// Broadcast the new tallies to every other accepted member, tailored to what
// each of them is allowed to see.
async function broadcastVotes(req, flockId, rows, venue_name, notify = true) {
  const io = req.app.get('io');
  const { ids, sets } = await invisibleSetsForFlock(flockId);
  if (io && notify) {
    for (const uid of ids) {
      if (uid === req.user.id) continue;
      const invisible = sets.get(uid) || new Set();
      if (invisible.has(req.user.id)) continue; // blocked pair: no event at all
      io.to(`user:${uid}`).emit('new_vote', {
        flockId: parseInt(flockId, 10),
        voter: { userId: req.user.id, name: req.user.name },
        venue_name,
        votes: tailorVotes(rows, invisible),
      });
    }
  }
  return sets.get(req.user.id) || new Set();
}

// POST /api/flocks/:id/vote - Vote for a venue
router.post('/:id/vote',
  [
    flockIdParam(),
    // Round 13: this was the ONE venue-name write with no stripHtml, no
    // profanity screen and no maximum length — the socket `vote_venue` handler
    // does all three (sockets/handlers.js). The name is persisted and
    // broadcast to the whole flock, and 255 matches the VARCHAR(255) column,
    // so an over-long name was a 500 from Postgres instead of a 400.
    //
    // Round 19 (shape sweep): round 13 added stripHtml and the profanity screen
    // here, and a one-element array walked past BOTH of them — stripHtml returns
    // a non-string unchanged and moderateText answers allowed:true for one. The
    // array then satisfied isLength by coercion and was persisted to
    // venue_votes.venue_name and broadcast to the whole flock as `new_vote`.
    // Shape first, so the screen round 13 added is actually reached.
    freeText(body('venue_name'), 'venue name')
      .isLength({ min: 1 }).withMessage('Venue name is required')
      .isLength({ max: 255 }).withMessage('Venue name too long'),
    scalarOnly(body('venue_id').optional(), 'venue id').trim().isLength({ max: 255 }).withMessage('Venue id too long'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = req.params.id;

      if (!(await verifyFlockMember(flockId, req.user.id))) {
        return res.status(403).json({ error: 'Not a member of this flock' });
      }

      const { venue_name, venue_id } = req.body;

      // Same UGC screen the socket path runs (Apple 1.2).
      if (rejectIfProfane(res, venue_name)) return;

      // One vote per member per flock. Switching venues used to stack a second
      // row (the unique key is per venue name), so both venues came back from
      // the server (round 10). Replace the old row inside one transaction.
      //
      // Round 11: the transaction alone was not enough. Two rapid switches
      // could each DELETE before the other INSERTed, and UNIQUE(flock_id,
      // user_id, venue_name) happily accepts both rows, so one member ended up
      // holding two votes. Serialize per (flock, user) with an advisory lock
      // held for the transaction, same pattern as safety.js/guest.js.
      const client = await pool.connect();
      let vote;
      let changed;
      try {
        await client.query('BEGIN');
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext('flockvote:' || $1::text || ':' || $2::text))",
          [String(flockId), String(req.user.id)]
        );
        const before = await client.query(
          'SELECT venue_name FROM venue_votes WHERE flock_id = $1 AND user_id = $2',
          [flockId, req.user.id]
        );
        changed = !(before.rows.length === 1 && before.rows[0].venue_name === venue_name);
        await client.query(
          'DELETE FROM venue_votes WHERE flock_id = $1 AND user_id = $2 AND venue_name <> $3',
          [flockId, req.user.id, venue_name]
        );
        const upsert = await client.query(
          `INSERT INTO venue_votes (flock_id, user_id, venue_name, venue_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (flock_id, user_id, venue_name)
           DO UPDATE SET venue_id = COALESCE(EXCLUDED.venue_id, venue_votes.venue_id)
           RETURNING *`,
          [flockId, req.user.id, venue_name, venue_id || null]
        );
        await client.query('COMMIT');
        vote = upsert.rows[0];
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      const rows = await collectVoteRows(flockId);
      const myInvisible = await broadcastVotes(req, flockId, rows, venue_name);

      // Re-voting for the venue you already picked is a no-op, not an error:
      // the client re-sends its current pick whenever the vote list changes.
      res.status(changed ? 201 : 200).json({ vote, votes: tailorVotes(rows, myInvisible) });
    } catch (err) {
      console.error('Vote error:', err);
      res.status(500).json({ error: 'Failed to vote' });
    }
  }
);

// DELETE /api/flocks/:id/vote - Take back my vote
// Without this an un-vote in the UI never reached the server and came back on
// the next refresh (round 10).
router.delete('/:id/vote', flockIdParam(), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const flockId = req.params.id;

    if (!(await verifyFlockMember(flockId, req.user.id))) {
      return res.status(403).json({ error: 'Not a member of this flock' });
    }

    const removed = await pool.query(
      'DELETE FROM venue_votes WHERE flock_id = $1 AND user_id = $2 RETURNING venue_name',
      [flockId, req.user.id]
    );

    const rows = await collectVoteRows(flockId);
    // Nothing removed means nothing changed, so peers get no event.
    const myInvisible = await broadcastVotes(req, flockId, rows, removed.rows[0]?.venue_name || null, removed.rows.length > 0);

    res.json({ removed: removed.rows.length, votes: tailorVotes(rows, myInvisible) });
  } catch (err) {
    console.error('Unvote error:', err);
    res.status(500).json({ error: 'Failed to remove vote' });
  }
});

// GET /api/flocks/:id/votes - Get vote counts for a flock
router.get('/:id/votes', flockIdParam(), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const flockId = req.params.id;

    if (!(await verifyFlockMember(flockId, req.user.id))) {
      return res.status(403).json({ error: 'Not a member of this flock' });
    }

    const invisible = new Set(await getInvisibleUserIds(req.user.id));
    const rows = await collectVoteRows(flockId);

    res.json({ votes: tailorVotes(rows, invisible, { voterObjects: true }) });
  } catch (err) {
    console.error('Get votes error:', err);
    res.status(500).json({ error: 'Failed to get votes' });
  }
});

// ---------------------------------------------------------------------------
// The guest transport's half of `new_vote` (audit 2026-08-14).
//
// routes/guest.js used to emit this event itself, straight into
// `io.to('flock:'+id)`, with a third payload shape. Two problems, and
// sockets/handlers.js's own export comment had already flagged the first:
//
//   1. The flock room is NOT a membership list. A socket joins it when the
//      client opens that flock's screen and leaves when the connection drops,
//      so a member sitting anywhere else in the app never learned a guest had
//      voted — on the one surface (a shared invite link) whose entire purpose
//      is to tell the group what the people they invited want.
//   2. It carried `{ flockId, voter, venue_name }` and no `votes` array, while
//      the member and socket producers of the same event both carry the
//      recipient's tailored tally. A client handling one shape got a partial
//      update from the other and had to refetch to find out what happened.
//
// So the guest path calls into THIS file, which owns the member-facing tally
// (collectVoteRows + tailorVotes), rather than growing a fourth implementation
// of it. Per-member fan-out to personal rooms, one payload per recipient.
//
// The per-recipient tailoring is still needed even though the VOTER is
// anonymous: a guest has no account so nobody can have blocked them, but the
// `votes` array names the MEMBER voters, and those blocks are real.
//
// Never throws: the vote is already committed by the time this runs, and a
// fan-out failure must not turn a saved vote into a 500 the guest retries.
async function broadcastGuestVote(io, flockId, venue_name) {
  if (!io) return;
  try {
    const rows = await collectVoteRows(flockId);
    const { ids, sets } = await invisibleSetsForFlock(flockId);
    for (const uid of ids) {
      io.to(`user:${uid}`).emit('new_vote', {
        flockId: parseInt(flockId, 10),
        voter: { guest: true },
        venue_name,
        votes: tailorVotes(rows, sets.get(uid) || new Set()),
      });
    }
  } catch (err) {
    console.error('Guest vote fan-out failed:', err.message);
  }
}

module.exports = router;
// A property on the router changes nothing about the mount in server.js — an
// express Router is a function object. Same pattern as checkin.js/stories.js.
module.exports.broadcastGuestVote = broadcastGuestVote;
