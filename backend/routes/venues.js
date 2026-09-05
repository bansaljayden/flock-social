const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { rejectIfProfane, rejectIfProfaneVenue } = require('../utils/moderation');
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

// ---------------------------------------------------------------------------
// THE TALLY HAS A CLOSING TIME (game-rule abuse round)
//
// POST and DELETE /:id/vote checked membership and nothing else. They never
// loaded the `flocks` row at all, so no state of the plan could refuse them:
//
//   - a COMPLETED flock still accepted new votes. The evening had happened, at
//     a venue the group had already gone to, and one member could re-open the
//     standings afterwards and make the record say the group had been split;
//   - a vote could be WITHDRAWN after the fact. Three members vote 2-1 for the
//     taqueria, the flock goes there, and then the two taqueria voters delete
//     their votes. The tally now says ramen was the only venue anyone ever
//     wanted. The flock's own history of what it chose is rewritten by the
//     people who lost.
//
// Only 'completed' and 'cancelled' are refused, deliberately. 'planning' and
// 'confirmed' both stay open: groups change their minds about where to go right
// up to the door, and a confirmed venue that nobody can vote against any more
// would be a worse product than the bug. What is refused is voting on a plan
// that is OVER, where there is no decision left to influence and the only thing
// a vote can still do is alter the record.
//
// Reading stays open on any status (GET /:id/votes is untouched): seeing what
// the group picked for a plan that already happened is the honest use.
const VOTING_CLOSED = new Set(['completed', 'cancelled']);

// Returns null when the flock is open to votes, or the message explaining why
// it is not. Called AFTER verifyFlockMember on every write path, so a
// non-member's 403 is still decided without consulting `flocks` and the route
// stays the non-oracle it already was.
async function votingClosedReason(flockId) {
  const flock = await pool.query('SELECT status FROM flocks WHERE id = $1', [flockId]);
  if (flock.rows.length === 0) return 'Flock not found';
  const status = flock.rows[0].status;
  if (!VOTING_CLOSED.has(status)) return null;
  return status === 'cancelled'
    ? 'This plan was cancelled, so its venue vote is closed'
    : 'This plan is finished, so its venue vote is closed';
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
  ).catch((err) => {
    // NARROWED (query-reliability follow-up). This was `.catch(() => ({ rows: [] }))`,
    // which swallowed a connection reset, a statement timeout and a permissions
    // error exactly as readily as the case it was written for — and every one of
    // those answered the member-facing tally with ZERO guest votes. The venue a
    // flock is about to go to is decided by this tally, so a silent drop does not
    // degrade a number on a screen, it changes where people end up, and it leaves
    // nothing behind to say it happened.
    //
    // The fail-open is still right for the one case it was written for: a
    // database that has not run the migrations these two tables came from
    // (`guest_votes`/`guest_rsvps` in 001, `guest_rsvps.is_hidden` in 005). That
    // is undefined_table (42P01) and undefined_column (42703), and on such a
    // deploy there are no guest votes to miss. Anything else is a real failure
    // and now reaches the caller's 500 — every call site of collectVoteRows is
    // inside a try/catch that answers one, and broadcastGuestVote's own catch
    // keeps a fan-out failure from turning a committed guest vote into an error.
    if (err?.code === '42P01' || err?.code === '42703') {
      console.warn('[venues] guest vote tally skipped: schema not migrated (' + err.code + ')');
      return { rows: [] };
    }
    throw err;
  });
  const guestByVenue = Object.fromEntries(guests.rows.map(g => [g.venue_name, g.guest_count]));

  // ── THE GUEST LINK CANNOT OUTWEIGH THE ROSTER (game-rule abuse round) ─────
  //
  // A guest_votes row counted one for one with a member vote in vote_count, and
  // routes/guest.js caps guest RSVPs at 50 PER FLOCK, not per person: whoever
  // holds the share link can mint RSVPs up to that cap and vote every one of
  // them. So one anonymous link-holder outvoted a three-member roster 50 to 3,
  // with no account, no email and no name attached to any of it. The members
  // could not even argue with it, because the voters list is empty for guests
  // by design (they have no identity to show).
  //
  // The guest link is a real feature and the people who use it are usually real
  // invitees without accounts, so their votes are not thrown away. They are
  // BOUNDED: the guest weight counted for any ONE venue is capped at the total
  // number of member votes cast in this flock. Guests weigh in alongside the
  // members and can tip a decision the members are split on; they can never be
  // louder than all the members put together, so a bloc of them cannot beat the
  // venue the members are agreed on, only draw level with it (and tailorVotes
  // breaks that tie toward the members).
  //
  // Members' turnout rather than the roster size, for two reasons: it compares
  // like with like (votes against votes, not votes against headcount), and it
  // is already in hand, so the tally does not grow a round trip on a read that
  // runs on every vote, every un-vote, every guest vote and every screen open.
  // The floor of 1 keeps an early tally sane: before any member has voted, a
  // guest's pick is still worth a vote, it just cannot be worth fifty.
  //
  // guest_count is still reported RAW, so the UI's "+N guests" keeps telling the
  // truth about how many link votes came in; only the weight that feeds
  // vote_count is capped. A tally that quietly under-reported the guest count
  // would just move the confusion somewhere else.
  //
  // The root cause (one person being able to BE fifty guests) lives in
  // routes/guest.js, which owns RSVP creation, and how much an anonymous
  // opinion should weigh at all is a product question. This is the tally's
  // half: even with the sybil door wide open, what it can do here is bounded.
  const memberVotesCast = raw.rows.reduce((n, v) => n + v.member_count, 0);
  const guestCap = Math.max(memberVotesCast, 1);
  const weigh = (n) => Math.min(n, guestCap);

  const rows = raw.rows.map(v => ({
    venue_name: v.venue_name,
    venue_id: v.venue_id,
    member_count: v.member_count,
    guest_count: guestByVenue[v.venue_name] || 0,
    guest_weight: weigh(guestByVenue[v.venue_name] || 0),
    voter_rows: v.voter_rows || [],
  }));
  // Venues only guests have voted on so far still show up for members.
  for (const [name, n] of Object.entries(guestByVenue)) {
    if (!rows.some(r => r.venue_name === name)) {
      rows.push({ venue_name: name, venue_id: null, member_count: 0, guest_count: n, guest_weight: weigh(n), voter_rows: [] });
    }
  }
  return rows;
}

// Wire shape for one recipient. vote_count is the total the vote bars are drawn
// from (members + guests); guest_count lets the UI say "+2 guests".
// voterObjects keeps the { id, name } rows the GET has always returned; the
// POST/DELETE and socket payloads stay a names array.
function tailorVotes(rows, invisible, { voterObjects = false } = {}) {
  // Sorted on the SOURCE rows, not on the wire objects: the tiebreak needs
  // member_count, and member_count is not part of the wire shape (payload
  // equality is pinned by __tests__/arrayShapeSweep.test.js, and adding a field
  // to a broadcast is a change to what every recipient is told).
  //
  // Ties break toward the venue MEMBERS picked. Without this a capped guest
  // bloc that draws level with the roster still took the top row and read as
  // the group's choice on every screen that shows the leader.
  return [...rows]
    .sort((a, b) =>
      ((b.member_count + b.guest_weight) - (a.member_count + a.guest_weight))
      || (b.member_count - a.member_count))
    .map(v => {
      const visible = v.voter_rows.filter(p => !invisible.has(p.id));
      return {
        venue_name: v.venue_name,
        venue_id: v.venue_id,
        // Members count themselves; guests count up to the roster's own size
        // (see collectVoteRows). guest_count below is still the raw number.
        vote_count: v.member_count + v.guest_weight,
        guest_count: v.guest_count,
        voters: voterObjects ? visible : visible.map(p => p.name),
      };
    });
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

      // The plan has to still be a plan (see votingClosedReason).
      const closed = await votingClosedReason(flockId);
      if (closed) {
        return res.status(closed === 'Flock not found' ? 404 : 409).json({ error: closed });
      }

      const { venue_name, venue_id } = req.body;

      // Same UGC screen the socket path runs (Apple 1.2). Google's text is
      // screened as Google's text; see moderateVenueText.
      if (rejectIfProfaneVenue(res, venue_name, venue_id)) return;

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

    // Taking a vote back is the half of this that rewrites history rather than
    // just adding to it, so it gets the same closing time (votingClosedReason).
    const closed = await votingClosedReason(flockId);
    if (closed) {
      return res.status(closed === 'Flock not found' ? 404 : 409).json({ error: closed });
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
// The tally itself, for sockets/handlers.js. `new_vote` has two producers,
// this file and the socket handler, and the handler used to carry its own
// copy of the SQL and its own arithmetic. The copies drifted: the socket added
// guest_count to member_count raw, while collectVoteRows caps guest weight at
// the member turnout (guestCap above) and tailorVotes breaks ties toward
// members - the defence against one link-holder minting fifty guest RSVPs.
// A comment in the handler claimed "same wire shape as tailorVotes" over
// arithmetic that was not. Sharing the functions makes parity structural.
module.exports.collectVoteRows = collectVoteRows;
module.exports.tailorVotes = tailorVotes;
