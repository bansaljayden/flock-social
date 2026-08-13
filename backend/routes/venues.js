const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { getInvisibleUserIds } = require('../utils/blocks');

const router = express.Router();

router.use(authenticate);

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

// POST /api/flocks/:id/vote - Vote for a venue
router.post('/:id/vote',
  [
    param('id').isInt(),
    body('venue_name').trim().isLength({ min: 1 }).withMessage('Venue name is required'),
    body('venue_id').optional().trim(),
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

      const result = await pool.query(
        `INSERT INTO venue_votes (flock_id, user_id, venue_name, venue_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (flock_id, user_id, venue_name) DO NOTHING
         RETURNING *`,
        [flockId, req.user.id, venue_name, venue_id || null]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({ error: 'Already voted for this venue' });
      }

      // Return updated vote counts (voters carry ids internally so blocks can
      // be applied per recipient; the wire shape stays a names array)
      const votes = await pool.query(
        `SELECT venue_name, venue_id, COUNT(*) AS vote_count,
                ARRAY_AGG(json_build_object('id', u.id, 'name', u.name)) AS voter_rows
         FROM venue_votes vv
         JOIN users u ON u.id = vv.user_id
         WHERE vv.flock_id = $1
         GROUP BY venue_name, venue_id
         ORDER BY vote_count DESC`,
        [flockId]
      );

      const tailorVotes = (invisible) => votes.rows.map(v => ({
        venue_name: v.venue_name,
        venue_id: v.venue_id,
        vote_count: v.vote_count,
        voters: (v.voter_rows || []).filter(p => !invisible.has(p.id)).map(p => p.name),
      }));

      // Notify flock members in real-time — per member, with that member's
      // blocked users removed from voter lists (and from the voter line).
      const io = req.app.get('io');
      const { ids, sets } = await invisibleSetsForFlock(flockId);
      if (io) {
        for (const uid of ids) {
          if (uid === req.user.id) continue;
          const invisible = sets.get(uid) || new Set();
          if (invisible.has(req.user.id)) continue; // blocked pair: no event at all
          io.to(`user:${uid}`).emit('new_vote', {
            flockId: parseInt(flockId),
            voter: { userId: req.user.id, name: req.user.name },
            venue_name,
            votes: tailorVotes(invisible),
          });
        }
      }

      const myInvisible = sets.get(req.user.id) || new Set();
      res.status(201).json({ vote: result.rows[0], votes: tailorVotes(myInvisible) });
    } catch (err) {
      console.error('Vote error:', err);
      res.status(500).json({ error: 'Failed to vote' });
    }
  }
);

// GET /api/flocks/:id/votes - Get vote counts for a flock
router.get('/:id/votes', param('id').isInt(), async (req, res) => {
  try {
    const flockId = req.params.id;

    if (!(await verifyFlockMember(flockId, req.user.id))) {
      return res.status(403).json({ error: 'Not a member of this flock' });
    }

    const invisible = new Set(await getInvisibleUserIds(req.user.id));
    const raw = await pool.query(
      `SELECT venue_name, venue_id, COUNT(*) AS vote_count,
              ARRAY_AGG(json_build_object('id', u.id, 'name', u.name)) AS voters
       FROM venue_votes vv
       JOIN users u ON u.id = vv.user_id
       WHERE vv.flock_id = $1
       GROUP BY venue_name, venue_id
       ORDER BY vote_count DESC`,
      [flockId]
    );
    // Counts stay honest; blocked identities disappear from the lists.
    const result = { rows: raw.rows.map(v => ({ ...v, voters: (v.voters || []).filter(p => !invisible.has(p.id)) })) };

    // Fold in guest-link votes (no identities, counts only). vote_count stays
    // the total the vote bars are drawn from; guest_count lets the UI say
    // "+2 guests" if it wants to.
    const guests = await pool.query(
      `SELECT venue_name, COUNT(*)::int AS guest_count
       FROM guest_votes WHERE flock_id = $1 GROUP BY venue_name`,
      [flockId]
    ).catch(() => ({ rows: [] }));
    const guestByVenue = Object.fromEntries(guests.rows.map((g) => [g.venue_name, g.guest_count]));
    const votes = result.rows.map((v) => ({
      ...v,
      guest_count: guestByVenue[v.venue_name] || 0,
      vote_count: parseInt(v.vote_count, 10) + (guestByVenue[v.venue_name] || 0),
    }));
    // Venues only guests have voted on so far still show up for members.
    for (const [name, n] of Object.entries(guestByVenue)) {
      if (!votes.some((v) => v.venue_name === name)) {
        votes.push({ venue_name: name, venue_id: null, vote_count: n, guest_count: n, voters: [] });
      }
    }
    votes.sort((a, b) => b.vote_count - a.vote_count);

    res.json({ votes });
  } catch (err) {
    console.error('Get votes error:', err);
    res.status(500).json({ error: 'Failed to get votes' });
  }
});

module.exports = router;
