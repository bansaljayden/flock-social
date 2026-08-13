const express = require('express');
const crypto = require('crypto');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { rejectIfProfane } = require('../utils/moderation');

const router = express.Router();

// ---------------------------------------------------------------------------
// Guest access (NO auth) — the cold-start growth mechanic. Someone invited to
// a flock can see the plan, RSVP, and vote from a link WITHOUT an account.
//
// Security model:
// - The link token is 12 chars of crypto randomness (~62^12); knowing a flock
//   id gets you nothing, and links can be revoked by re-generating.
// - Guests see the PLAN only: flock name/date/time, host FIRST name, going
//   count, and venue tallies. Never member lists, messages, budgets, or
//   anything with PII.
// - Guests are identified by a server-issued UUID (guest_token) returned once
//   at RSVP time; votes require it. Clients never mint their own identity.
// - Every route is rate-limited by the mount in server.js.
// ---------------------------------------------------------------------------

const newLinkToken = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let t = '';
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) t += alphabet[bytes[i] % alphabet.length];
  return t;
};

// Resolve a link token to its live flock, or null.
async function resolveLink(token) {
  const r = await pool.query(
    `SELECT il.flock_id, f.name, f.event_time, f.venue_name,
            f.status, u.name AS host_name
     FROM flock_invite_links il
     JOIN flocks f ON f.id = il.flock_id
     JOIN users u ON u.id = f.creator_id
     WHERE il.token = $1 AND il.revoked = false`,
    [token]
  );
  return r.rows[0] || null;
}

// Member + guest vote tallies for a flock, grouped by venue name. No voter
// identities are exposed on the guest surface, only counts.
// Round 9: a hidden (taken-down) guest RSVP contributes nothing anywhere, votes
// included, so a moderator action fully removes them from the public surface.
async function guestTallies(flockId) {
  const r = await pool.query(
    `SELECT venue_name, SUM(c)::int AS votes FROM (
       SELECT venue_name, COUNT(*) AS c FROM venue_votes WHERE flock_id = $1 GROUP BY venue_name
       UNION ALL
       SELECT gv.venue_name, COUNT(*) AS c FROM guest_votes gv
       JOIN guest_rsvps gr ON gr.id = gv.guest_rsvp_id
       WHERE gv.flock_id = $1 AND COALESCE(gr.is_hidden, false) = false
       GROUP BY gv.venue_name
     ) t GROUP BY venue_name ORDER BY votes DESC LIMIT 12`,
    [flockId]
  );
  return r.rows;
}

// GET /api/guest/:token — the public plan preview
router.get('/:token',
  param('token').trim().isLength({ min: 8, max: 20 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Invalid link' });

      const link = await resolveLink(req.params.token);
      if (!link) return res.status(404).json({ error: 'This invite link is no longer active' });

      const [tallies, going] = await Promise.all([
        guestTallies(link.flock_id),
        pool.query(
          `SELECT
             (SELECT COUNT(*) FROM flock_members WHERE flock_id = $1 AND status = 'accepted')::int AS members,
             (SELECT COUNT(*) FROM guest_rsvps WHERE flock_id = $1 AND status = 'in' AND COALESCE(is_hidden, false) = false)::int AS guests`,
          [link.flock_id]
        ),
      ]);

      res.json({
        flock: {
          name: link.name,
          // event_time is the full timestamp; the page formats day + time
          // in the guest's own locale.
          when: link.event_time || null,
          chosenVenue: link.venue_name || null,
          status: link.status,
        },
        // First name only — the host invited these people, but the page is
        // reachable by anyone with the link, so keep it minimal.
        host: String(link.host_name || '').split(' ')[0],
        going: going.rows[0].members + going.rows[0].guests,
        venues: tallies,
      });
    } catch (err) {
      console.error('Guest preview error:', err);
      res.status(500).json({ error: 'Could not load this invite' });
    }
  }
);

// POST /api/guest/:token/rsvp — { name, status } -> { guestToken }
router.post('/:token/rsvp',
  [
    param('token').trim().isLength({ min: 8, max: 20 }),
    // max 60 matches the guest_rsvps.name column cap, so an over-long name is a
    // 400 here instead of a database error.
    body('name').trim().isLength({ min: 1, max: 60 }).withMessage('Tell them who you are'),
    body('status').isIn(['in', 'out']).withMessage('RSVP must be in or out'),
    body('guestToken').optional().isUUID(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const link = await resolveLink(req.params.token);
      if (!link) return res.status(404).json({ error: 'This invite link is no longer active' });

      const { name, status, guestToken } = req.body;

      // Round 9: this is an UNAUTHENTICATED write whose value is broadcast to
      // every member over the socket, so it gets the same profanity screen as
      // every other user-writable text field.
      if (rejectIfProfane(res, name)) return;

      // Returning guest updates their RSVP; new guest gets a fresh identity.
      if (guestToken) {
        const existing = await pool.query(
          'SELECT COALESCE(is_hidden, false) AS is_hidden FROM guest_rsvps WHERE guest_token = $1 AND flock_id = $2',
          [guestToken, link.flock_id]
        );
        if (existing.rows.length && existing.rows[0].is_hidden) {
          return res.status(403).json({ error: 'This RSVP was removed and cannot be edited' });
        }
        const upd = await pool.query(
          `UPDATE guest_rsvps SET name = $1, status = $2, updated_at = NOW()
           WHERE guest_token = $3 AND flock_id = $4 AND COALESCE(is_hidden, false) = false
           RETURNING guest_token`,
          [name, status, guestToken, link.flock_id]
        );
        if (upd.rows.length) return res.json({ guestToken: upd.rows[0].guest_token, status });
      }

      // Cap guests per flock so a leaked link can't flood a plan. Hidden rows
      // still count toward the cap: a takedown must not free up a slot.
      //
      // Round 10: the count and the insert were separate statements on an
      // UNAUTHENTICATED route, so concurrent requests all read the same
      // under-cap number and every one of them landed. Both now run in one
      // transaction behind a per-flock advisory lock, which serializes
      // concurrent RSVPs on the same link.
      const client = await pool.connect();
      let ins;
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('guest_rsvp:' || $1::text))", [String(link.flock_id)]);

        const count = await client.query('SELECT COUNT(*)::int AS n FROM guest_rsvps WHERE flock_id = $1', [link.flock_id]);
        if (count.rows[0].n >= 50) {
          await client.query('ROLLBACK');
          return res.status(429).json({ error: 'This flock has too many guest RSVPs' });
        }

        ins = await client.query(
          `INSERT INTO guest_rsvps (flock_id, name, status) VALUES ($1, $2, $3)
           RETURNING guest_token, COALESCE(is_hidden, false) AS is_hidden`,
          [link.flock_id, name, status]
        );
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      // Let members see the RSVP land in real time. Hidden rows are never
      // broadcast (a default-false column means this is normally true).
      const io = req.app.get('io');
      if (io && !ins.rows[0].is_hidden) {
        io.to(`flock:${link.flock_id}`).emit('guest_rsvp', {
          flockId: link.flock_id, name, status,
        });
      }

      res.status(201).json({ guestToken: ins.rows[0].guest_token, status });
    } catch (err) {
      console.error('Guest RSVP error:', err);
      res.status(500).json({ error: 'Could not save your RSVP' });
    }
  }
);

// POST /api/guest/:token/vote — { guestToken, venueName } -> updated tallies
router.post('/:token/vote',
  [
    param('token').trim().isLength({ min: 8, max: 20 }),
    body('guestToken').isUUID().withMessage('RSVP first, then vote'),
    body('venueName').trim().isLength({ min: 1, max: 255 }).withMessage('Pick a venue'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const link = await resolveLink(req.params.token);
      if (!link) return res.status(404).json({ error: 'This invite link is no longer active' });

      const { guestToken, venueName } = req.body;

      const guest = await pool.query(
        `SELECT id FROM guest_rsvps
         WHERE guest_token = $1 AND flock_id = $2 AND COALESCE(is_hidden, false) = false`,
        [guestToken, link.flock_id]
      );
      if (!guest.rows.length) return res.status(403).json({ error: 'RSVP first, then vote' });

      // Guests vote on venues the group is already considering — they can't
      // introduce new venues from outside the flock.
      const known = await pool.query(
        `SELECT 1 FROM venue_votes WHERE flock_id = $1 AND venue_name = $2
         UNION SELECT 1 FROM guest_votes WHERE flock_id = $1 AND venue_name = $2
         UNION SELECT 1 FROM flocks WHERE id = $1 AND venue_name = $2 LIMIT 1`,
        [link.flock_id, venueName]
      );
      if (!known.rows.length) return res.status(400).json({ error: 'That venue is not in this flock' });

      // One vote per guest per flock — the same model member voting follows in
      // routes/venues.js. Round 11: this was an INSERT ... DO NOTHING that
      // never cleared the guest's previous pick, so a single guest could vote
      // for every venue in the flock one after another and inflate all of them.
      // Delete-then-insert under a per-guest advisory lock, so two taps racing
      // each other can't both land (guest.rsvp id, not the flock: guests on the
      // same link vote independently).
      const guestId = guest.rows[0].id;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('guest_vote:' || $1::text))", [String(guestId)]);
        await client.query(
          'DELETE FROM guest_votes WHERE flock_id = $1 AND guest_rsvp_id = $2 AND venue_name <> $3',
          [link.flock_id, guestId, venueName]
        );
        await client.query(
          `INSERT INTO guest_votes (flock_id, guest_rsvp_id, venue_name)
           VALUES ($1, $2, $3) ON CONFLICT (flock_id, guest_rsvp_id, venue_name) DO NOTHING`,
          [link.flock_id, guestId, venueName]
        );
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      const venues = await guestTallies(link.flock_id);

      const io = req.app.get('io');
      if (io) {
        io.to(`flock:${link.flock_id}`).emit('new_vote', {
          flockId: link.flock_id,
          voter: { guest: true },
          venue_name: venueName,
        });
      }

      res.status(201).json({ venues });
    } catch (err) {
      console.error('Guest vote error:', err);
      res.status(500).json({ error: 'Could not save your vote' });
    }
  }
);

module.exports = { router, newLinkToken };
