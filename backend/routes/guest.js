const express = require('express');
const crypto = require('crypto');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { rejectIfProfane } = require('../utils/moderation');
const { guestEntryId } = require('../utils/guestRsvp');
// Shape before content — see validators/shape.js. This router is the only
// UNAUTHENTICATED write surface in the app and every value it takes is
// re-broadcast to the flock, so it is the one that could least afford the hole.
const { scalarOnly, freeText } = require('../validators/shape');
const { broadcastGuestRsvp } = require('../sockets/handlers');
// The member-facing venue tally has one implementation and it lives with the
// member vote routes — see broadcastGuestVote there for why a guest vote is
// announced through it rather than emitted from here.
const { broadcastGuestVote } = require('./venues');
const { pushIfOffline } = require('../services/pushHelper');

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

// ---------------------------------------------------------------------------
// Round 15 — creating a NEW guest identity is the only unauthenticated INSERT
// in the app, and everything expensive hangs off it:
//
//   - Each new guest may cast one guest vote, and guest votes are NOT
//     display-only: routes/venues.js folds them into the member-facing venue
//     tally and routes/flocks.js counts them as voters. A typical flock has ~5
//     members, and the per-flock guest cap is 50, so anyone holding a share link
//     could mint 50 identities and outvote the actual group 10:1, deciding
//     where they go.
//   - Each new "in" answer pushes the host a notification.
//   - Each one consumes a slot in the 50-guest cap, and hidden rows
//     deliberately still count toward that cap (a takedown must not hand the
//     abuser a fresh slot). The consequence nobody costed: filling all 50 slots
//     with junk is a PERMANENT denial of service on that invite link that no
//     moderator action can reverse — real guests get 429 until the host revokes
//     the link and re-shares a new one.
//
// The general limiter (300/15min per IP) is nowhere near tight enough: 50
// identities is 50 requests. A single script did the whole thing in one burst.
// So new-identity creation gets its own budget, per IP, per flock. Editing an
// existing RSVP is untouched — that path is already gated on holding a
// server-issued UUID and cannot create anything.
// ---------------------------------------------------------------------------
const NEW_GUESTS_PER_IP_PER_FLOCK = 3;
const NEW_GUEST_WINDOW_MS = 60 * 60 * 1000;
const newGuestLog = new Map(); // "ip|flockId" -> { count, resetAt }

function allowNewGuest(ip, flockId) {
  const now = Date.now();
  if (newGuestLog.size > 5000) {
    for (const [k, v] of newGuestLog) { if (now > v.resetAt) newGuestLog.delete(k); }
  }
  const key = `${ip}|${flockId}`;
  let entry = newGuestLog.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + NEW_GUEST_WINDOW_MS };
    newGuestLog.set(key, entry);
  }
  if (entry.count >= NEW_GUESTS_PER_IP_PER_FLOCK) return false;
  entry.count += 1;
  return true;
}

// Two display names are "the same" for takedown purposes if they differ only by
// case, surrounding space, or runs of whitespace. Deliberately conservative: it
// is a replay guard, not a similarity engine.
function normalizeGuestName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

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

// Tell the members a guest answered the link.
//
// Round 14: the old code emitted `guest_rsvp` into the `flock:{id}` room and
// only on first insert. Two holes: (1) nobody is in that room unless they have
// the flock screen open, so the host normally never saw it; (2) a guest
// CHANGING their answer (in -> out) returned early and broadcast nothing, so
// the host's count silently drifted from the truth. Fan-out is in
// sockets/handlers so the "reach the host wherever they are" rule has exactly
// one implementation.
//
// Never throws: the RSVP is already committed, and a broadcast failure must not
// turn a saved RSVP into a 500 the guest will retry.
async function announceGuestRsvp(req, link, { guestId, name, status, isNew }) {
  try {
    const io = req.app.get('io');
    if (!io) return;

    const counts = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM flock_members WHERE flock_id = $1 AND status = 'accepted')::int AS members,
         (SELECT COUNT(*) FROM guest_rsvps WHERE flock_id = $1 AND status = 'in'
            AND COALESCE(is_hidden, false) = false)::int AS guests`,
      [link.flock_id]
    );
    const guestsGoing = counts.rows[0].guests;
    const going = counts.rows[0].members + guestsGoing;

    await broadcastGuestRsvp(io, link.flock_id, {
      flockId: link.flock_id,
      // Same identity shape the REST roster returns, so a client can reconcile
      // the live event against the list it already rendered.
      guestId: guestEntryId(guestId),
      name,
      status,
      isGuest: true,
      going,
      guestsGoing,
    });

    // An offline host still needs to know somebody answered the link — that is
    // the whole point of sharing it. Only on a NEW yes, so a guest toggling
    // their answer can't be used to hammer the host's notifications.
    if (isNew && status === 'in') {
      const host = await pool.query('SELECT creator_id, name FROM flocks WHERE id = $1', [link.flock_id]);
      if (host.rows.length) {
        await pushIfOffline(io, host.rows[0].creator_id,
          `${name} is in!`,
          host.rows[0].name,
          // A guest has no user account, so there is nobody the host could have
          // blocked; the namespaced guest id (guest:N) is a non-numeric string,
          // so the block-gate's actor check reads it as "no actor" and correctly
          // skips the block lookup. Carried for payload consistency with the
          // authenticated push sites.
          { type: 'guest_rsvp', flockId: String(link.flock_id), fromUserId: guestEntryId(guestId) }
        );
      }
    }
  } catch (err) {
    console.error('Guest RSVP broadcast error:', err.message);
  }
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
    // Round 13: this was the only user-writable name field in the app that
    // skipped stripHtml, and it is written WITHOUT authentication then
    // broadcast to every member over the `guest_rsvp` socket event. Sanitize
    // before the length check so markup can't smuggle past the 60-char cap.
    // Round 19 (shape sweep): `name: ["<b>x</b>"]` satisfied isLength, was left
    // untouched by stripHtml AND by rejectIfProfane (both return a non-string
    // unchanged), and then went into a VARCHAR(60) column, out over the
    // `guest_rsvp` socket event to every member, and into the host's push
    // notification title — with its markup and anything the profanity filter
    // exists to stop. It also slipped the takedown replay guard, because
    // normalizeGuestName(["Bob",""]) is "bob," and no longer matches the hidden
    // "bob". Unauthenticated, so this was the cheapest hole in the app.
    freeText(body('name'), 'name').isLength({ min: 1, max: 60 }).withMessage('Tell them who you are'),
    // guest_rsvps.status is VARCHAR(10) with CHECK (status IN ('in','out')).
    // `["in"]` passed isIn by coercion and reached the INSERT as '{in}', which
    // Postgres refused with 23514 — a 500 on an unauthenticated route.
    scalarOnly(body('status'), 'RSVP').isIn(['in', 'out']).withMessage('RSVP must be in or out'),
    // isUUID() accepts a one-element array too, and guest_rsvps.guest_token is
    // a UUID column: '{9d3f...}' is 22P02, i.e. another unauthenticated 500.
    scalarOnly(body('guestToken').optional({ values: 'null' }), 'guest token').isUUID(),
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
          `SELECT name, status, COALESCE(is_hidden, false) AS is_hidden
           FROM guest_rsvps WHERE guest_token = $1 AND flock_id = $2`,
          [guestToken, link.flock_id]
        );
        if (existing.rows.length && existing.rows[0].is_hidden) {
          return res.status(403).json({ error: 'This RSVP was removed and cannot be edited' });
        }
        // A guest editing their answer is now broadcast (it wasn't before, which
        // is how a host's count silently drifted). That makes an UNAUTHENTICATED
        // route a fan-out amplifier, so a re-POST of the SAME answer — the
        // cheapest thing to script against a link — announces nothing.
        const prior = existing.rows[0] || null;
        const changed = !prior || prior.name !== name || prior.status !== status;
        const upd = await pool.query(
          `UPDATE guest_rsvps SET name = $1, status = $2, updated_at = NOW()
           WHERE guest_token = $3 AND flock_id = $4 AND COALESCE(is_hidden, false) = false
           RETURNING id, guest_token`,
          [name, status, guestToken, link.flock_id]
        );
        if (upd.rows.length) {
          if (changed) {
            await announceGuestRsvp(req, link, { guestId: upd.rows[0].id, name, status, isNew: false });
          }
          return res.json({ guestToken: upd.rows[0].guest_token, status });
        }
      }

      // Everything below creates a NEW guest identity. See allowNewGuest above
      // for why that is the expensive operation on this route and the edit path
      // is not.
      if (!allowNewGuest(req.ip, link.flock_id)) {
        return res.status(429).json({ error: 'Too many RSVPs from here. Try again later.' });
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
      let blockedByTakedown = false;
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('guest_rsvp:' || $1::text))", [String(link.flock_id)]);

        const count = await client.query('SELECT COUNT(*)::int AS n FROM guest_rsvps WHERE flock_id = $1', [link.flock_id]);
        if (count.rows[0].n >= 50) {
          await client.query('ROLLBACK');
          return res.status(429).json({ error: 'This flock has too many guest RSVPs' });
        }

        // Round 15 — make a takedown STICK.
        //
        // Hiding a guest RSVP was a one-request bypass: the 403 above only
        // guards the path where the guest presents their original guestToken,
        // and nothing forces them to. Dropping the token fell straight through
        // to this INSERT, minting a fresh row with a fresh guest_token and the
        // SAME abusive display name — which is then broadcast live to every
        // member of the flock again. The name is the reported content here, so
        // a moderator who removed it had removed nothing.
        //
        // Profanity screening does not cover this: the names that get reported
        // are targeted at a person, not obscene, and pass the filter cleanly.
        const revoked = await client.query(
          `SELECT 1 FROM guest_rsvps
           WHERE flock_id = $1
             AND COALESCE(is_hidden, false) = true
             AND lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = $2
           LIMIT 1`,
          [link.flock_id, normalizeGuestName(name)]
        );
        if (revoked.rows.length > 0) {
          blockedByTakedown = true;
          await client.query('ROLLBACK');
        } else {
          ins = await client.query(
            `INSERT INTO guest_rsvps (flock_id, name, status) VALUES ($1, $2, $3)
             RETURNING id, guest_token, COALESCE(is_hidden, false) AS is_hidden`,
            [link.flock_id, name, status]
          );
          await client.query('COMMIT');
        }
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      // Deliberately vague, and the same shape as any other refusal: a
      // moderated-off guest learns that this name will not go through, not that
      // a moderator acted on them specifically.
      if (blockedByTakedown) {
        return res.status(403).json({ error: 'That name cannot be used on this flock. Try a different one.' });
      }

      // Let members see the RSVP land in real time. Hidden rows are never
      // broadcast (a default-false column means this is normally true).
      if (!ins.rows[0].is_hidden) {
        await announceGuestRsvp(req, link, { guestId: ins.rows[0].id, name, status, isNew: true });
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
    scalarOnly(body('guestToken'), 'guest token').isUUID().withMessage('RSVP first, then vote'),
    // venueName is compared against three tables and then written to a
    // VARCHAR(255); as an array it reached all four as a Postgres array literal.
    scalarOnly(body('venueName'), 'venue').trim().isLength({ min: 1, max: 255 }).withMessage('Pick a venue'),
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

      // The GUEST gets counts only (guestTallies) — no voter identities ever
      // cross onto the public link surface. The MEMBERS get the same `new_vote`
      // payload a member vote produces, fanned out to their personal rooms, so
      // a guest answering the link reaches them wherever they are in the app
      // and their tally arrives complete rather than needing a refetch. One
      // implementation of that tally, in the file that owns it — see
      // broadcastGuestVote in routes/venues.js.
      await broadcastGuestVote(req.app.get('io'), link.flock_id, venueName);

      res.status(201).json({ venues });
    } catch (err) {
      console.error('Guest vote error:', err);
      res.status(500).json({ error: 'Could not save your vote' });
    }
  }
);

module.exports = { router, newLinkToken, allowNewGuest, normalizeGuestName, newGuestLog };
