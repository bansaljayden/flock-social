const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { stripHtml } = require('../utils/sanitize');
const { rejectIfProfane, rejectIfProfaneChat, moderateImage, imageRejectionMessage } = require('../utils/moderation');
const { sanitizeVenueData, safeVenuePhotoUrl } = require('../utils/venuePayload');
const VENUE_REJECTED_MESSAGE = "That venue card couldn't be shared.";
const { isBlockedBetween, getInvisibleUserIds } = require('../utils/blocks');
const { hasDmRelationship, invalidateDmRelationshipCache, NOT_CONNECTED_MESSAGE } = require('../utils/relationships');
// Read receipts (migration 065). The ladder itself — which stored fact becomes
// which word — lives in ONE module that both transports import, never spelled
// twice; see the header of utils/messageStatus.js.
const { attachDmStatus, attachFlockStatus, flockRoster } = require('../utils/messageStatus');
// CHAT_IMAGE_MAX_BYTES is the ONE ceiling on a chat photo's data: URL, defined
// in sockets/handlers.js and imported (never re-declared) by everything that has
// to agree with it: server.js sizes the JSON body limit from it, the socket
// handler enforces it on the way in, and the two send routes below enforce it on
// the REST twin. IMAGE_TOO_LARGE_MESSAGE / IMAGE_FORMAT_MESSAGE come from the
// same place for the same reason — the user is shown these strings verbatim, and
// two transports refusing the same photo with two different sentences reads as
// two different products.
// sanitizeStoredImage rides in the same import: it is restampImageMime (the
// MIME a stored data: URL declares is re-typed from the sniffed bytes, so the
// column never repeats a sender's claim the payload contradicts) followed by
// the EXIF/XMP/IPTC strip. One byte-typer and one stripper for both transports,
// defined next to the socket twin that shares them.
const {
  emitToFlockExcludingBlocked,
  // Who may see a reply's quote, the rule the socket send_message fan-out
  // applies. The send route below fans out one row to many members too, so it
  // takes the same function rather than a second copy of the rule.
  replyCopies,
  // A copy with its quote cut out: what the sender is answered with when the
  // quote's audience could not be decided.
  quoteWithheld,
  // The sender's own name for a send, validated the way the socket twin
  // validates it and echoed only on the sender's copies. See readClientId.
  readClientId,
  ownEcho,
  CHAT_IMAGE_MAX_BYTES,
  sanitizeStoredImage,
  IMAGE_TOO_LARGE_MESSAGE,
  IMAGE_FORMAT_MESSAGE,
  // Receipt writers (migration 065). Imported for the same reason as the image
  // constants directly above: two transports refusing, or confirming, the same
  // thing in two different ways reads as two different products.
  markFlockDelivered,
  markFlockOpened,
  markDmDelivered,
  markDmOpened,
  flockReadPayload,
  // "Did the emit reach a device?" — the one signal the DELIVERY half of a
  // receipt is allowed to assert on a send, and never the OPENED half. It
  // wraps pushHelper's isUserOnline so a broadcaster it cannot inspect answers
  // "no" instead of throwing; presence is not attention either way, and
  // services/pushHelper.js writes out at length why.
  deliveredToLiveSocket,
} = require('../sockets/handlers');
const { pushIfOfflineDebounced, pushBadgeSync } = require('../services/pushHelper');
// Shape before content — see validators/shape.js.
const { scalarOnly, freeText } = require('../validators/shape');

const router = express.Router();

router.use(authenticate);

// SERIAL message/user ids are INT4; an id past this 500s on the query instead of
// 400ing (same class as routesReliability.test.js; friends.js bounds user ids the
// same way). Every :id/:userId/:messageId param and the int cursors below are
// bounded to it so a too-large id is rejected before any query runs.
const INT4_MAX = 2147483647;

// Several routes below declared param()/body() chains and then never read the
// result, which made those chains decorative: `/api/dm/messages/abc/react`
// reached Postgres as NaN and came back a 500, and an unvalidated `emoji`
// (VARCHAR(10) in the schema) turned any long string into a 500 as well. This
// is the single gate they all call now.
// ---------------------------------------------------------------------------
// One spelling of "is this a chat image", used by both send routes. It is the
// same prefix the socket's checkInboundImage tests, INCLUDING its treatment of
// the empty string: '' there means "no image", and the routes below read it the
// same way (`empty` sees a falsy image; the INSERT stores null). The validator
// used to refuse it outright, so `{ message_text: 'hi', image_url: '' }` was a
// 400 over REST and a delivered message over the socket — the same divergence
// as the size cap, one field over. Nothing else falsy is waved through: `false`
// and `0` are not "no image", they are a client bug, and both transports say so.
const IMAGE_DATA_URL_PREFIX = /^data:image\/(png|jpe?g|gif|webp);base64,/;
const isChatImageUrl = (value) => value === '' || IMAGE_DATA_URL_PREFIX.test(value);

// ---------------------------------------------------------------------------
// A message must CARRY something — text or an image. Not text unconditionally.
//
// Both send routes required `message_text` with isLength({ min: 1 }), so an
// image-only message was a 400 over REST while the socket transport accepted it
// (sockets/handlers.js send_message: `!message_text && message_type !== 'image'`
// is its whole test). These REST routes are the FALLBACK the socket client uses
// when its connection is down — so sending a photo failed exactly when the
// network was already struggling and the user was most likely to retry, and the
// same photo went through the moment the socket reconnected. A transport
// fallback that refuses what the primary accepts is not a fallback.
//
// The rule is spelled as "text or an image" rather than copied from the socket's
// old `message_type !== 'image'`, which tested the TYPE LABEL instead of the
// payload: a bare `{ message_type: 'image' }` with no image and no text passed
// it and stored an empty row (a blank bubble in the thread). The socket handler
// has since adopted this spelling — `!message_text && !checkInboundImage(...)`
// in sockets/handlers.js send_message and send_dm — so both transports now
// answer the same question about the same payload rather than about a label.
//
// message_text is NOT NULL on both tables, so an absent or null value has to
// become '' rather than travelling to Postgres as NULL (23502, a 500). Same
// normalisation the socket path does with `typeof ... === 'string' ? ... : ''`.
//
// SIZE is settled here too, and for the same parity reason. The JSON body limit
// server.js hands these three routes is CHAT_IMAGE_MAX_BYTES + a 64KB envelope,
// which is a limit on the WHOLE BODY and therefore not a cap on the image: a
// request carrying nothing but `image_url` was accepted up to ~1.09MB over REST
// while the socket refused anything past 1,048,576 — the fallback transport
// admitting a photo the primary would not, into a column both of them share.
// Byte length, not .length: isChatImageUrl above is prefix-anchored, so
// multi-byte characters can follow the base64 payload and make `.length`
// (UTF-16 code units) smaller than what the body limit and the socket both
// count. Same expression as checkInboundImage.
function messageBody(req) {
  const text = typeof req.body.message_text === 'string' ? req.body.message_text : '';
  const image = typeof req.body.image_url === 'string' ? req.body.image_url : null;
  return {
    text,
    image,
    // The optional small twin of `image`, meaningful only alongside one, and
    // read here so both transports and both message tables share one rule.
    // Its whole failure mode is "no thumbnail": readImageThumb answers null
    // for anything oversized or mis-shaped, and a null thumb costs the reader
    // nothing but the old full-image history payload.
    thumb: image ? readImageThumb(req.body.thumb_url) : null,
    empty: !text && !image,
    tooLarge: image !== null && Buffer.byteLength(image, 'utf8') > CHAT_IMAGE_MAX_BYTES,
  };
}

// CHAT IMAGE THUMBNAILS (2026-08-27). A chat photo is stored and served as a
// full ~700KB base64 data URL, inline in every history page, and the app
// draws it at most 260px wide with no zoom viewer, so nearly all of those
// bytes are waste the reader pays for again on every thread open. The sender's
// phone now derives a small thumbnail from the same sized-down bytes and sends
// both; history serves the thumbnail and withholds the full image when one
// exists (the CASE in both history queries), so a photo-heavy thread costs
// kilobytes instead of megabytes to reopen. The full image stays stored for a
// future full-size viewer. Legacy rows have no thumbnail and serve as before.
//
// TRUST RULE: the thumbnail is CLIENT-derived, so a hostile client could pair
// an innocent full image with an unrelated thumbnail. Both are therefore
// moderated exactly like the full image, and a thumbnail that fails shape,
// size, or moderation is simply DROPPED, never a reason to reject the send:
// the worst outcome of a bad thumb is the old bandwidth bill, not a lost
// message and not an unmoderated pixel reaching a screen.
const THUMB_MAX_BYTES = 96 * 1024;
function readImageThumb(value) {
  if (typeof value !== 'string') return null;
  if (!/^data:image\//.test(value)) return null;
  if (Buffer.byteLength(value, 'utf8') > THUMB_MAX_BYTES) return null;
  return value;
}
const EMPTY_MESSAGE = 'Message is required';

function rejectInvalid(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ error: errors.array()[0].msg || 'Invalid request' });
  return true;
}

// Helper: check if user is a member of the flock
async function verifyFlockMember(flockId, userId) {
  const result = await pool.query(
    "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
    [flockId, userId]
  );
  return result.rows.length > 0;
}

// "IS THIS ONE COUNTERPARTY BANNED?" — a pair question, asked as a pair.
//
// Every DM route that needs it (the read receipt, the thread read, the
// reaction, the venue-vote and pinned-venue reads, and the unsend fan-out) has
// already run isBlockedBetween one line earlier, which is a single indexed
// lookup on the pair. The only fact left to establish is whether this one
// counterparty is banned, and the first two used to establish it with
// getInvisibleUserIds: a three-leg UNION whose third leg is EVERY banned
// account in the product, whose other two legs re-ask the block question that
// was just answered, all shipped to Node so one id could be scanned for. The
// cost of opening a DM thread therefore grew with the total number of bans in
// the database and with nothing about the request.
//
// A self-addressed id answers false rather than reading the row, deliberately:
// the UNION excludes the caller from their own invisible set (`id <> $1` —
// utils/blocks.js, "a banned account's OWN reads still see everyone"), so this
// has to answer the same way for the same input.
//
// getInvisibleUserIds stays everywhere in this file that genuinely needs the
// whole SET: the inbox, the history reads, the fan-outs. This is only for the
// callers holding one id and wanting one answer.
async function counterpartyIsBanned(viewerId, otherUserId) {
  if (otherUserId === viewerId) return false;
  const result = await pool.query(
    'SELECT 1 FROM users WHERE id = $1 AND is_banned IS TRUE',
    [otherUserId]
  );
  return result.rows.length > 0;
}


/* ── PINNED MESSAGES (migration 068) ──────────────────────────────────────
 *
 * SHARED pins, not the reference app's private save: anyone in the thread can
 * pin, up to three, and everyone sees them. The thing a group needs to keep is
 * the Venmo handle, the address, the door code, and every one of those is
 * worth keeping for the whole group rather than for whoever thought to save
 * it.
 *
 * THE CEILING LIVES HERE, not in the schema. A CHECK cannot count rows in a
 * sibling group and a trigger would put the rule somewhere nobody reading this
 * route would find it. Migration 068 says so at length and 067 left
 * system_kind unconstrained for the same reason: a rule the database enforces
 * and the route does not know about surfaces as a 23514 that the catch turns
 * into a 500 on a feature nobody can reach.
 *
 * A FOURTH PIN IS REFUSED, NOT SWAPPED IN. Evicting the oldest would let one
 * person silently remove something another person put there, on a surface
 * whose whole point is that it is shared. The refusal says which.
 */
const MAX_PINS = 3;

/**
 * This flock's pins, in the order the bar pages through them.
 *
 * SAME THREE FILTERS AS THE REPLY QUOTE, and for the same reason: a pin is
 * another path to a message's words. Scoped to the flock, hidden and unsent
 * parents dropped so a pin cannot outlive what it points at, and blocked
 * senders dropped so a pin is not how a blocked member's line reaches the
 * person who blocked them. The CASCADE in 068 covers a DELETED message; these
 * cover a message that still exists and must not be shown to this reader.
 *
 * SPLIT INTO ROWS AND PAYLOAD so the fan-out below can read the pins ONCE and
 * cut every member's copy out of the same rows, rather than running this join
 * once per recipient. An EMPTY invisible array filters nothing — `x = ANY('{}')`
 * is false, so the `NOT (...)` keeps every row — and that is what lets the
 * unfiltered batch read and the per-reader filtered read be the SAME statement
 * instead of two copies of it that drift the next time these filters change.
 */
async function readFlockPinRows(flockId, invisibleArr) {
  const result = await pool.query(
    `SELECT p.id, p.message_id, p.pinned_by, p.created_at,
            m.message_text, m.message_type, m.sender_id,
            u.name AS sender_name
       FROM pinned_messages p
       JOIN messages m ON m.id = p.message_id
       LEFT JOIN users u ON u.id = m.sender_id
      WHERE p.flock_id = $1
        AND m.is_hidden IS NOT TRUE
        AND m.sender_deleted_at IS NULL
        AND (m.sender_id IS NULL OR NOT (m.sender_id = ANY($2::int[])))
      ORDER BY p.created_at ASC, p.id ASC`,
    [flockId, invisibleArr]
  );
  return result.rows;
}

/**
 * One pin row as the bar draws it.
 *
 * The pinned message's sender rides as senderId. The visibility filter tests it
 * here, and the client needs it for the case this filter cannot reach: a list
 * read before a block and answered after it, or a pin of a message the app
 * never loaded, both of which have to come off the bar when that person is
 * blocked. Shared by the per-reader read below and by the fan-out, so one pin
 * can never end up shaped two ways.
 */
function pinPayload(r) {
  return {
    id: r.message_id,
    messageId: r.message_id,
    text: r.message_text,
    messageType: r.message_type,
    senderId: r.sender_id,
    senderName: r.sender_name,
    pinnedBy: r.pinned_by,
  };
}

/** The list ONE reader is allowed to see, filtered in SQL by their own set. */
async function readFlockPins(flockId, invisibleArr) {
  return (await readFlockPinRows(flockId, invisibleArr)).map(pinPayload);
}

/**
 * Tell the room its pin list changed.
 *
 * Per member and never to the flock room, the same rule the message fan-out
 * follows: a pin names a message and a sender, so the list one member should
 * see is not the list another should. Each member's own invisible set decides
 * their copy.
 *
 * FOUR STATEMENTS, WHATEVER THE FLOCK SIZE. This used to read the pin list and
 * the block list once PER MEMBER, inside the loop. getInvisibleUserIds is a
 * three-leg UNION and readFlockPins is a three-table join, so a full flock
 * (MAX_FLOCK_MEMBERSHIPS, routes/flocks.js, is 50 seats) paid 1 + 2x50 = 101
 * statements to publish at most three rows, because MAX_PINS is 3. Most of
 * that was the same work over and over: the UNION's third leg is every banned
 * account in the product, which does not vary by member at all, and the pin
 * join differs per member only by a filter on a column the projection already
 * returns. So the rows are read ONCE unfiltered, every block edge touching the
 * roster comes back in one statement, the banned set in one more, and each
 * member's copy is derived in memory. Four, counted honestly: the roster, the
 * pins, the block edges and the banned set. The pin and unpin routes each pay
 * two more before calling this, for the caller's own copy of the same two
 * reads, which is a duplicate worth removing separately and is not removed
 * here. Same read-once-and-replay shape
 * routes/venues.js invisibleSetsForFlock already uses to fan a vote out to this
 * very set of members.
 *
 * NOBODY'S COPY CHANGES, and the in-memory test is the SQL filter's test
 * written out: a pin is dropped when its sender is in that member's set, a pin
 * whose author was deleted (sender_id NULL, ON DELETE SET NULL) is kept, and a
 * member with an empty set still sees everything. The ban half keeps the
 * UNION's `id <> $1` too, so a banned member's own copy still shows them the
 * bar everyone else sees.
 *
 * NEVER THROWS. The pin is already written; a failure to announce it costs the
 * live update and nothing else, and the next history read carries the truth.
 * What the batch does change is the GRANULARITY of that failure: an unreadable
 * user_blocks now costs everybody the live update rather than one member. That
 * is the trade for not asking the same question fifty times, and the per-member
 * catch stays for what can still fail one member at a time.
 */
async function broadcastPins(req, flockId) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const members = await pool.query(
      "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
      [flockId]
    );
    const memberIds = members.rows.map((m) => m.user_id);
    if (memberIds.length === 0) return;

    const [rows, blocks, banned] = await Promise.all([
      // Unfiltered on purpose: every member's copy is cut from these rows.
      readFlockPinRows(flockId, []),
      // Both directions at once — the two block legs of getInvisibleUserIds,
      // asked once for the whole roster instead of once per member.
      pool.query(
        'SELECT blocker_id, blocked_id FROM user_blocks WHERE blocker_id = ANY($1::int[]) OR blocked_id = ANY($1::int[])',
        [memberIds]
      ),
      // The leg that was identical for all fifty of them, served by the
      // idx_users_banned index migration 069 added for exactly this leg.
      pool.query('SELECT id FROM users WHERE is_banned IS TRUE'),
    ]);

    const invisibleBy = new Map(memberIds.map((id) => [id, new Set()]));
    for (const b of blocks.rows) {
      // An edge comes back when EITHER end is on the roster, so each end is
      // recorded only for the members this flock has to answer for.
      if (invisibleBy.has(b.blocker_id)) invisibleBy.get(b.blocker_id).add(b.blocked_id);
      if (invisibleBy.has(b.blocked_id)) invisibleBy.get(b.blocked_id).add(b.blocker_id);
    }
    for (const [memberId, invisible] of invisibleBy) {
      for (const b of banned.rows) {
        if (b.id !== memberId) invisible.add(b.id);
      }
    }

    for (const memberId of memberIds) {
      try {
        const invisible = invisibleBy.get(memberId);
        const pins = rows
          .filter((r) => r.sender_id == null || !invisible.has(r.sender_id))
          .map(pinPayload);
        io.to(`user:${memberId}`).emit('flock_pins_changed', { flockId, pins });
      } catch (perMember) {
        // One member's emit failing must not cost everybody else the update.
        console.error('Pin broadcast (member) error:', perMember.message);
      }
    }
  } catch (err) {
    console.error('Pin broadcast error:', err.message);
  }
}

// POST /api/flocks/:id/pins - pin a message
router.post('/flocks/:id/pins',
  authenticate,
  [
    param('id').isInt({ min: 1, max: INT4_MAX }),
    scalarOnly(body('message_id'), 'message').isInt({ min: 1, max: INT4_MAX }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const flockId = parseInt(req.params.id, 10);
      const messageId = parseInt(req.body.message_id, 10);

      if (!(await verifyFlockMember(flockId, req.user.id))) {
        return res.status(403).json({ error: 'You are not in this flock' });
      }

      // The message must live in THIS flock and still be readable. Without the
      // flock_id predicate any member could pin an arbitrary message id and
      // have its text drawn at the top of a thread it was never in.
      const target = await pool.query(
        `SELECT id FROM messages
          WHERE id = $1 AND flock_id = $2
            AND is_hidden IS NOT TRUE AND sender_deleted_at IS NULL`,
        [messageId, flockId]
      );
      if (target.rows.length === 0) {
        return res.status(404).json({ error: 'That message is no longer there to pin' });
      }

      /* THE COUNT AND THE INSERT ARE ONE TRANSACTION, UNDER THE FLOCK ROW
         LOCK, which is the same lock and the same reason DELETE /api/flocks/:id
         and POST /:id/leave take: "a guard in one autocommit statement and a
         write in another leaves a gap".

         The comment that stood here claimed the unique index made the count
         safe under a race. IT DOES NOT, and I wrote that without checking. The
         index is on (flock_id, message_id), so it stops the SAME message being
         pinned twice and has nothing to say about how many pins a flock has.
         Two people pinning two DIFFERENT messages with two already pinned both
         read 2, both pass the check, both insert, and the flock ends up with
         four. The same comment also promised the ceiling was "re-checked
         after", which was never written.

         Under the lock the second request either reads 3 and is refused, or
         waits and then reads 3 and is refused. Three is three.

         ON CONFLICT DO NOTHING stays, and is a separate concern: two people
         tapping Pin on the SAME message within a second of each other is the
         ordinary case and must be a no-op rather than a 23505 the catch turns
         into a 500. */
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM flocks WHERE id = $1 FOR UPDATE', [flockId]);
        // LIVE PINS ONLY. A pin whose message was unsent or taken down is
        // dropped by every read (readFlockPinRows), so nobody can see it to
        // unpin it, and counting it here left a flock stuck at "Only 3" with
        // two pins on screen and no way to clear the third. Unsend and the
        // moderator hide now delete the row as well; this is what keeps a
        // row left over from before that, or from a delete that failed, from
        // holding a seat.
        const existing = await client.query(
          `SELECT COUNT(*)::int AS n FROM pinned_messages
            WHERE flock_id = $1
              AND EXISTS (SELECT 1 FROM messages m
                           WHERE m.id = pinned_messages.message_id
                             AND m.is_hidden IS NOT TRUE
                             AND m.sender_deleted_at IS NULL)`,
          [flockId]
        );
        if (existing.rows[0].n >= MAX_PINS) {
          await client.query('ROLLBACK').catch(() => {});
          return res.status(409).json({ error: `Only ${MAX_PINS} messages can be pinned. Unpin one first.` });
        }
        await client.query(
          `INSERT INTO pinned_messages (flock_id, message_id, pinned_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (flock_id, message_id) DO NOTHING`,
          [flockId, messageId, req.user.id]
        );
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      const invisible = await getInvisibleUserIds(req.user.id);
      const pins = await readFlockPins(flockId, invisible);
      res.status(201).json({ pins });
      broadcastPins(req, flockId);
    } catch (err) {
      console.error('Pin message error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// DELETE /api/flocks/:id/pins/:messageId - unpin
router.delete('/flocks/:id/pins/:messageId',
  authenticate,
  [
    param('id').isInt({ min: 1, max: INT4_MAX }),
    param('messageId').isInt({ min: 1, max: INT4_MAX }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const flockId = parseInt(req.params.id, 10);
      const messageId = parseInt(req.params.messageId, 10);

      if (!(await verifyFlockMember(flockId, req.user.id))) {
        return res.status(403).json({ error: 'You are not in this flock' });
      }

      // ANYONE IN THE FLOCK CAN UNPIN, not only whoever pinned it. A shared
      // surface that only its author can clear is a surface one person can
      // fill and walk away from, and the three slots are the whole group's.
      await pool.query(
        'DELETE FROM pinned_messages WHERE flock_id = $1 AND message_id = $2',
        [flockId, messageId]
      );

      const invisible = await getInvisibleUserIds(req.user.id);
      const pins = await readFlockPins(flockId, invisible);
      res.json({ pins });
      broadcastPins(req, flockId);
    } catch (err) {
      console.error('Unpin message error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// GET /api/flocks/:id/messages - Get messages for a flock (paginated)
router.get('/flocks/:id/messages',
  [
    param('id').isInt({ min: 1, max: INT4_MAX }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('before').optional().isInt({ min: 1, max: INT4_MAX }), // message ID cursor for pagination
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = req.params.id;
      const limit = parseInt(req.query.limit) || 50;
      const before = req.query.before ? parseInt(req.query.before) : null;

      if (!(await verifyFlockMember(flockId, req.user.id))) {
        return res.status(403).json({ error: 'Not a member of this flock' });
      }

      // Moderator-hidden messages (A6 takedown) and messages from users blocked
      // in either direction are filtered IN SQL, before LIMIT — filtering after
      // pagination could return an empty page (with no cursor to page past)
      // while older visible messages still existed.
      const invisible = new Set(await getInvisibleUserIds(req.user.id));
      const invisibleArr = [...invisible];

      // ORDER BY the CURSOR column (messages-reliability round). This read
      // sorted on created_at DESC while paging on `id < before` — two different
      // keys. created_at is TIMESTAMP DEFAULT NOW(): NOW() is transaction-start
      // time and carries no uniqueness, so a burst of sends ties on it (tie
      // order unspecified, so the LIMIT boundary could split the tie one way on
      // page 1 and the other way on page 2 — a duplicated or vanished row), and
      // two concurrent transactions can commit with timestamps in the opposite
      // order to their ids — a row stamped older than everything on page 1 but
      // carrying an id ABOVE the cursor is then excluded by `id < before` on
      // every later page: skipped forever, not just misplaced. id is SERIAL —
      // unique and monotone with arrival — so sorting on the same key the
      // cursor filters on makes pages tile exactly, and a message arriving
      // between two page fetches (always a higher id) can never shift what an
      // older cursor returns. The two branches this used to be are one
      // statement: `$2::int IS NULL` is the first page, so the cursor predicate
      // and the ordering can never drift apart between copies again.
      const messagesQuery = `
          -- Giant legacy base64 avatars would be repeated on every one of up to 100 rows; drop oversized ones instead of amplifying them (REVIEW-ROUND5)
          -- EVERY COLUMN NAMED, because m.* was one of them.
          -- The star already contained image_url, so Postgres detoasted and
          -- transmitted the whole base64 image for every row and node-postgres
          -- then dropped it in favour of the CASE below (last duplicate name
          -- wins). That saved the CLIENT's bandwidth and none of the database's:
          -- fifteen photos at ~800 KB is ~12 MB read, pulled over the pool and
          -- allocated on the heap, to deliver ~1.4 MB of thumbnails.
          -- __tests__/historyColumnCoverage.test.js derives this list from the
          -- schema and fails if a migration adds a column and this falls behind.
          SELECT m.id, m.flock_id, m.sender_id, m.message_text, m.message_type,
                 m.venue_data, m.created_at, m.is_hidden, m.thumb_url,
                 m.sender_deleted_at, m.reply_to_id, m.system_kind,
                 u.name AS sender_name, CASE WHEN LENGTH(u.profile_image_url) > 12000 THEN NULL ELSE u.profile_image_url END AS sender_image,
                 -- The bandwidth half of the thumbnail feature: when a row has
                 -- one, history ships ONLY the thumbnail (the app draws 260px
                 -- max and has no zoom viewer, so the full image was pure
                 -- re-download waste). It is the ONLY source of image_url now,
                 -- rather than an override of a column that was fetched anyway.
                 CASE WHEN m.thumb_url IS NOT NULL THEN NULL ELSE m.image_url END AS image_url
          FROM messages m
          LEFT JOIN users u ON u.id = m.sender_id
          WHERE m.flock_id = $1
            AND ($2::int IS NULL OR m.id < $2)
            AND m.is_hidden IS NOT TRUE
            AND m.sender_deleted_at IS NULL
            AND (m.sender_id IS NULL OR NOT (m.sender_id = ANY($4::int[])))
          ORDER BY m.id DESC
          LIMIT $3`;
      // The `IS NULL OR` guard on sender_id is load-bearing, not defensive
      // noise: messages.sender_id is ON DELETE SET NULL (schema 000), and in
      // SQL `NOT (NULL = ANY(nonempty_array))` is NULL, which WHERE discards.
      // So a deleted member's messages vanished from history — but only for
      // viewers with at least one block relationship (an EMPTY array compares
      // to FALSE, and NOT FALSE keeps the row), meaning two members of the same
      // flock saw two different histories depending on who they had blocked,
      // anywhere else in the app, ever.
      const params = [flockId, before, limit, invisibleArr];

      const messagesResult = await pool.query(messagesQuery, params);
      const messages = messagesResult.rows;

      // Fetch reactions for all returned messages in one query
      if (messages.length > 0) {
        const messageIds = messages.map((m) => m.id);
        const reactionsResult = await pool.query(
          `SELECT er.message_id, er.emoji, er.user_id, u.name AS user_name
           FROM emoji_reactions er
           JOIN users u ON u.id = er.user_id
           WHERE er.message_id = ANY($1)`,
          [messageIds]
        );

        // Group reactions by message ID — a blocked user's reaction on a third
        // member's message would otherwise still expose their name/activity.
        const reactionsByMessage = {};
        for (const r of reactionsResult.rows) {
          if (invisible.has(r.user_id)) continue;
          if (!reactionsByMessage[r.message_id]) {
            reactionsByMessage[r.message_id] = [];
          }
          reactionsByMessage[r.message_id].push(r);
        }

        for (const msg of messages) {
          msg.reactions = reactionsByMessage[msg.id] || [];
        }
      }

      // The quoted parent for any reply on this page, in one query.
      //
      // THREE FILTERS, AND EACH CLOSES A REAL HOLE RATHER THAN A THEORETICAL
      // ONE. Scoped to this flock, so a reply_to_id aimed at another flock
      // cannot pull its text in here. Filtered by `invisible`, because a quote
      // is a SECOND PATH TO A BLOCKED MEMBER'S WORDS: the history query drops
      // Bob's own rows and the reactions loop above drops his reactions, but
      // without this line Alice's reply would still carry his sentence inside
      // it, quoted, to somebody who blocked him. And hidden or unsent parents
      // are dropped, so a quote cannot outlive the message it quotes.
      //
      // A miss leaves reply_to_id on the row with no reply_to beside it, and
      // the bubble draws that as an ordinary message. That is the honest
      // fallback: the reply is still its author's message and still theirs to
      // read; only the quote is withheld.
      //
      // message_type rides along so a reply to a photo or a venue card can say
      // so instead of quoting an empty string. The DM twin does not fetch it
      // and shows a blank quote in that case, which is a real gap on that side
      // and not one to fix silently from here.
      //
      // sender_id rides along too, the quoted author's, and both send paths
      // ship the same five fields. The filter above only covers what this
      // read returns: a block made while the app already holds a quote has
      // to take it down on the client, and the quoted message is often one
      // the app never loaded (further back than the page, or answered by a
      // read that left before the block). Without the id there is no telling
      // whose words the quote carries. Every row on this page already names
      // its own sender the same way.
      const replyIds = messages.filter((m) => m.reply_to_id).map((m) => m.reply_to_id);
      if (replyIds.length > 0) {
        try {
          const replyResult = await pool.query(
            `SELECT m.id, m.message_text, m.message_type, m.sender_id, u.name AS sender_name
               FROM messages m
               LEFT JOIN users u ON u.id = m.sender_id
              WHERE m.id = ANY($1) AND m.flock_id = $2
                AND m.is_hidden IS NOT TRUE AND m.sender_deleted_at IS NULL`,
            [replyIds, flockId]
          );
          const replyMap = {};
          for (const r of replyResult.rows) {
            if (r.sender_id != null && invisible.has(r.sender_id)) continue;
            replyMap[r.id] = {
              id: r.id,
              message_text: r.message_text,
              message_type: r.message_type,
              sender_id: r.sender_id,
              sender_name: r.sender_name,
            };
          }
          for (const msg of messages) {
            if (msg.reply_to_id && replyMap[msg.reply_to_id]) {
              msg.reply_to = replyMap[msg.reply_to_id];
            }
          }
        } catch (quoteErr) {
          // Same rule as the receipts block below: a decoration failing must
          // never cost the history read that is already owed.
          console.error('Flock reply hydrate error:', quoteErr.message);
        }
      }

      // ── READ RECEIPTS (migration 065) ──────────────────────────────────
      //
      // The roster is every OTHER accepted member with their two watermarks,
      // filtered by the same invisible set the history query above already
      // used. That filter is the whole reason this is a separate query rather
      // than a join onto the messages read: a blocked or banned member must
      // not appear in an "Opened by" list, and `invisibleArr` is exactly the
      // set utils/blocks.js says covers blocks in either direction plus bans.
      //
      // ONE query for the whole page, bounded by flock size. The status of
      // each own row is then a comparison against a list already in memory —
      // see utils/messageStatus.js for why the group side stores a watermark
      // per member instead of a row per reader.
      //
      // A failure here costs the receipts and NOTHING ELSE. The messages are
      // read, the response is owed, and a decoration on the payload must never
      // be able to turn a history read into a 500 — the same rule the DM reply
      // hydrate below already follows.
      let readers = [];
      try {
        const rosterResult = await pool.query(
          `SELECT fm.user_id, u.name, fm.last_delivered_message_id, fm.last_opened_message_id
             FROM flock_members fm
             JOIN users u ON u.id = fm.user_id
            WHERE fm.flock_id = $1 AND fm.status = 'accepted'
              AND fm.user_id <> $2
              AND NOT (fm.user_id = ANY($3::int[]))`,
          [flockId, req.user.id, invisibleArr]
        );
        readers = flockRoster(rosterResult.rows);
        attachFlockStatus(messages, req.user.id, readers);
      } catch (receiptErr) {
        console.error('Flock receipt roster error:', receiptErr.message);
      }

      /* The pins ride with the history read rather than costing a second
         round trip, the same way the receipt roster above does. A failure
         here costs the pins and NOTHING else: the messages are read, the
         response is owed, and a decoration on the payload must never be able
         to turn a history read into a 500. */
      let pins = [];
      try {
        pins = await readFlockPins(flockId, invisibleArr);
      } catch (pinErr) {
        console.error('Flock pin read error:', pinErr.message);
      }

      // Return in chronological order
      res.json({ messages: messages.reverse(), readers, pins });

      // ── DELIVERY, THE VIEWER'S OWN ─────────────────────────────────────
      //
      // These rows just reached this person's device, which is what
      // "Delivered" claims and the whole of what it claims. It is NOT an open:
      // a client pages history on reconnect, on a background catch-up and on
      // every scroll to the top, and none of those is somebody reading. The
      // opened half has its own route below and is written only when the
      // client says the thread is on screen.
      //
      // FIRST PAGE ONLY (`before` absent). A cursor page is older history, so
      // it can never move a watermark that GREATEST already holds at or above
      // it, and asking is a write on the hottest table in the chat for a row
      // count of zero.
      //
      // The UPDATE's `<` predicate makes the emit conditional on the watermark
      // actually moving, so a member re-opening a quiet thread does not fan a
      // no-op receipt out to everybody every time.
      if (!before && messages.length > 0) {
        try {
          const newest = Math.max(...messages.map((m) => Number(m.id) || 0));
          if (newest > 0) await markFlockDelivered(req.app.get('io'), flockId, req.user.id, req.user.name, newest);
        } catch (deliverErr) {
          console.error('Flock delivery receipt error:', deliverErr.message);
        }
      }
    } catch (err) {
      console.error('Get messages error:', err);
      res.status(500).json({ error: 'Failed to get messages' });
    }
  }
);

// POST /api/flocks/:id/messages - Send a message to a flock
router.post('/flocks/:id/messages',
  [
    param('id').isInt({ min: 1, max: INT4_MAX }),
    // Round 19 (shape sweep). `message_text: ["<b>hi</b>"]` was the worst case
    // in this file: stripHtml returns a non-string untouched, rejectIfProfane
    // does the same (utils/moderation.js moderateText answers allowed:true for
    // anything that is not a string), and isLength passes on the coerced
    // "<b>hi</b>" — so the ONE text field in flock chat reached the messages
    // table having been screened by nothing at all. Shape first.
    // Optional here, and "must carry something" is enforced in the handler —
    // see messageBody above. A `min: 1` on this field alone cannot express
    // "text OR an image", and an .optional() chain is skipped entirely for an
    // absent field, so a cross-field rule cannot live on it either.
    freeText(body('message_text').optional({ values: 'null' }), 'message')
      .isLength({ max: 5000 }).withMessage('Message is too long (max 5000 characters)'),
    scalarOnly(body('message_type').optional({ values: 'null' }), 'message type').isIn(['text', 'venue_card', 'image']),
    // venue_data is LEGITIMATELY an object, so it gets isObject() (which already
    // rejects an array) plus sanitizeVenueData, never a scalar guard.
    body('venue_data').optional({ values: 'null' }).isObject(),
    scalarOnly(body('image_url').optional({ values: 'null' }), 'image')
      .custom(isChatImageUrl).withMessage(IMAGE_FORMAT_MESSAGE),
    // No format rejection for the thumb: readImageThumb drops anything
    // mis-shaped, because a bad thumbnail must never cost the message.
    scalarOnly(body('thumb_url').optional({ values: 'null' }), 'thumbnail'),
    // messages.reply_to_id is int4 (migration 066), and the DM twin's warning
    // further down this file applies here word for word: `[5]` passes isInt
    // and then reaches the query as an array. scalarOnly is what stops that.
    scalarOnly(body('reply_to_id').optional({ values: 'null' }), 'reply target').isInt({ min: 1, max: INT4_MAX }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      // Read and settle the content BEFORE the membership query: it is the last
      // piece of validation, it costs nothing, and the validator chain it used
      // to live in ran ahead of every query too. See messageBody.
      const { text: message_text, image: image_url, thumb, empty, tooLarge } = messageBody(req);
      if (empty) return res.status(400).json({ error: EMPTY_MESSAGE });
      // Ahead of every query AND ahead of moderateImage, which is a BILLED Cloud
      // Vision call: a refusal we can make for free from the byte count must
      // never be made after paying for one. Same ordering the socket path uses
      // (checkInboundImage runs before the send_image rate bucket and before
      // moderateImage), and the same sentence, so the two transports refuse the
      // same photo identically.
      if (tooLarge) return res.status(400).json({ error: IMAGE_TOO_LARGE_MESSAGE });
      // Echo matching only, dropped rather than refused when it is not a
      // short safe token, exactly as the socket twin reads it.
      const clientId = readClientId(req.body.client_id);

      const flockId = req.params.id;

      if (!(await verifyFlockMember(flockId, req.user.id))) {
        return res.status(403).json({ error: 'Not a member of this flock' });
      }

      const { message_type, venue_data, reply_to_id } = req.body;

      // UGC text filter (Apple 1.2) — reject objectionable content before storing.
      if (rejectIfProfaneChat(res, message_text)) return;

      // Round 8: venue_data was stored verbatim — nested name/photo_url dodged
      // the text screen and rendered sender-controlled <img> URLs (tracking).
      const venueCheck = sanitizeVenueData(venue_data);
      if (!venueCheck.ok) {
        return res.status(400).json({ error: VENUE_REJECTED_MESSAGE });
      }

      // Image moderation must hold on the REST transport too — the socket-only
      // check left this endpoint delivering unmoderated (and trackable) URLs.
      //
      // Round 18: the `(png|jpe?g|gif|webp)` allowlist above is NOT the
      // animation gate and must not be mistaken for one — an APNG arrives as
      // `image/png` and an animated WebP as `image/webp`, so tightening this
      // regex would close nothing. moderateImage inspects the actual bytes and
      // refuses multi-frame files there, for every upload path at once.
      //
      // This line is BILLED, once per image. The socket twin charges a
      // 'send_image' bucket before its own call; this route is metered by the
      // billed-image limiter in server.js, which is mounted ahead of every
      // router and keyed on the account rather than the address, so the two
      // transports cost roughly the same per minute. Until it existed, the only
      // ceiling in front of this call was apiLimiter at 3000 per 15 minutes.
      if (image_url) {
        const verdict = await moderateImage(image_url, { userId: req.user.id });
        if (!verdict.allowed) {
          return res.status(400).json({ error: imageRejectionMessage(verdict), moderation: verdict.reason });
        }
      }
      // The thumb is client-derived, so it is moderated like the image it
      // claims to shrink; one that fails anything is dropped, never fatal.
      let safeThumb = null;
      if (thumb) {
        try {
          const thumbVerdict = await moderateImage(thumb, { userId: req.user.id });
          if (thumbVerdict.allowed) safeThumb = sanitizeStoredImage(thumb);
        } catch { /* no thumbnail, full image serves as before */ }
      }

      // SECURITY: the quoted message must live in THIS flock. A stored
      // reply_to_id pointing anywhere else would hydrate another flock's text
      // into this thread for every member of it, which is a cross-flock read
      // through a field the sender controls. Hidden and unsent parents are
      // refused too, so a reply can never be used to resurrect a line that
      // moderation removed or its author withdrew.
      //
      // A bad target is a 400 rather than a silent null, matching the DM twin:
      // the person meant to quote something, and a reply that quietly arrives
      // quoting nothing reads as the app losing their intent.
      let safeReplyId = null;
      if (reply_to_id) {
        const replyCheck = await pool.query(
          `SELECT id FROM messages
           WHERE id = $1 AND flock_id = $2
             AND is_hidden IS NOT TRUE AND sender_deleted_at IS NULL`,
          [reply_to_id, flockId]
        );
        if (replyCheck.rows.length === 0) {
          return res.status(400).json({ error: 'Invalid reply target' });
        }
        safeReplyId = reply_to_id;
      }

      const result = await pool.query(
        `INSERT INTO messages (flock_id, sender_id, message_text, message_type, venue_data, image_url, thumb_url, reply_to_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          flockId,
          req.user.id,
          message_text,
          message_type || 'text',
          venueCheck.data,
          // Stored with its MIME re-typed from the sniffed bytes and its EXIF
          // removed (see sanitizeStoredImage in sockets/handlers.js). The
          // declared prefix is a client claim, and the phone's GPS block is a
          // home address nobody meant to send.
          image_url ? sanitizeStoredImage(image_url) : null,
          safeThumb,
          safeReplyId,
        ]
      );

      const message = result.rows[0];
      message.sender_name = req.user.name;
      message.reactions = [];

      // The quoted row every other member's bubble reads, same shape the
      // history read builds below. Without it a reply sent over this transport
      // drew a blank line under a blank name for everyone receiving it. The id
      // is already scope-checked above, so this only fetches display fields,
      // and a failure drops the QUOTE rather than the message: the row is
      // stored and reply_to_id is on it either way, and a decoration on the
      // payload must never turn a saved message into a 500.
      //
      // sender_id and sender_banned are read for the fan-out below, which has
      // to know whose words the quote carries and whether that account is
      // banned. sender_banned stays off the quote. sender_id is on it, as it
      // is on the socket twin's and the history read's: all three ship the
      // same five fields, so a live reply and a reloaded one are the same
      // object, and a client that learns of a block needs the id to take that
      // person's words out of a quote of a message it never loaded.
      let quotedRow = null;
      if (safeReplyId) {
        try {
          const quoted = await pool.query(
            `SELECT m.id, m.message_text, m.message_type, m.sender_id, u.name AS sender_name,
                    u.is_banned IS TRUE AS sender_banned
               FROM messages m
               LEFT JOIN users u ON u.id = m.sender_id
              WHERE m.id = $1`,
            [safeReplyId]
          );
          const q = quoted.rows[0];
          if (q) {
            message.reply_to = {
              id: q.id,
              message_text: q.message_text,
              message_type: q.message_type,
              sender_id: q.sender_id,
              sender_name: q.sender_name,
            };
            quotedRow = { sender_id: q.sender_id, sender_banned: q.sender_banned };
          }
        } catch (quoteErr) {
          console.error('Flock reply hydrate error:', quoteErr.message);
        }
      }

      // WHO MAY SEE THE QUOTE, decided BEFORE the answer, because the sender
      // is one of the people it is decided for. copyFor (replyCopies, the
      // socket twin's rule) cuts the quote out of the copy for anybody who
      // cannot see the quoted author: a block either way, or a ban on the
      // author. The sender is not exempt. reply_to_id is a number the client
      // sends, and the scope check above asks only that the message is in
      // this flock and still up, so it can name a banned author's message or
      // one across a block from the sender. The history read withholds that
      // quote from the sender (the hydrate filters by their invisible set),
      // and this answer used to hand it straight back, which made a reply a
      // way to read those words. A question that cannot be answered withholds
      // the quote from the sender too, and costs the live delivery below the
      // way it always has; the row is stored either way.
      let copyFor = null;
      try {
        copyFor = await replyCopies(message, quotedRow);
      } catch (audienceErr) {
        console.error('Flock reply audience error:', audienceErr.message);
      }

      // The send echo carries 'sent' and only the SENDER's copy does. The row
      // below fans out to every member, and a status on somebody else's copy
      // would be a receipt about a message that is not theirs — harmless to
      // draw (StatusLine only ever renders under the viewer's own last
      // message) and wrong to send, so it is not sent.
      const senderCopy = ownEcho(copyFor ? copyFor(req.user.id) : quoteWithheld(message), clientId, { status: 'sent' });
      res.status(201).json({ message: senderCopy });

      // Offline push, mirroring the socket send_message path in
      // sockets/handlers.js. The socket client falls back to THIS endpoint when
      // its connection is down — which is exactly when the recipient is likely
      // offline and a push matters most — so a REST send has to notify offline
      // members just like the socket send does. Same debounce key shape
      // ({ type: 'flock_message', flockId }) so a message that happens to go out
      // on both transports collapses into one notification rather than two.
      // Runs AFTER the response and is fully self-contained, so a Firebase
      // hiccup can never turn a stored message into a 500.
      try {
        const io = req.app.get('io');
        // `copyFor` null is a quote whose audience could not be decided (see
        // above): nobody gets this row live and nobody is pushed, and every
        // member, the sender's other devices included, reads it from history,
        // which drops the quote per viewer. Delivering it blind would be the
        // leak copyFor exists to close.
        if (io && copyFor) {
          const flockInfo = await pool.query('SELECT name FROM flocks WHERE id = $1', [flockId]);
          const flockName = flockInfo.rows[0]?.name || 'Flock';
          // STILL A MEMBER? Asked beside the roster: the membership check up
          // top ran before the image screen, which can take seconds, and an
          // account that left the plan in that time must not have the row
          // delivered to its other devices below.
          const [members, stillMember] = await Promise.all([
            pool.query(
              "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2",
              [flockId, req.user.id]
            ),
            verifyFlockMember(flockId, req.user.id),
          ]);
          const invisible = new Set(await getInvisibleUserIds(req.user.id));
          // `invisible` is the SENDER's set: it decides who receives this row
          // at all and says nothing about the person a reply quotes. copyFor
          // answers that second question with the socket twin's rule: a member
          // who cannot see the quoted sender (a block either way, or a ban on
          // the quoted account, which hides it from everyone) gets the reply
          // with the quote cut out, which is what the history read above shows
          // them on reload. This route used to hand every member the quote, so
          // a member who had blocked the quoted person got that person's words
          // live whenever the sender's socket happened to be down.
          //
          // THE SENDER'S OTHER DEVICES. The member list above leaves the sender
          // out, and the HTTP response reaches only the device that posted,
          // which is the one whose socket was down. The account's other phones
          // and tabs were told nothing, and the app dropped an own message it
          // had no bubble for. Same room and the same copy as the socket
          // twin's echo. The posting device dedupes it against its bubble by
          // client id. Not for an account that has left the plan meanwhile.
          if (stillMember) io.to(`user:${req.user.id}`).emit('new_message', senderCopy);
          // An image-only message makes this the empty string, which is correct
          // and deliberate rather than an oversight. services/firebaseService.js
          // normalizeBody() turns an empty body into "Shared something in the
          // chat" for a flock_message and "Sent you something" for a dm_message,
          // so nothing arrives as a title over a blank line, and that single
          // fallback covers the socket send path (which builds this preview the
          // same way), the crowd alerts, and anything else that pushes. Writing
          // a REST-only "Sent a photo" here would put a different sentence on
          // the same message depending on which transport happened to be up —
          // the exact divergence the rest of this file exists to close.
          const preview = (message_text || '').substring(0, 100);
          await Promise.allSettled(
            members.rows
              .filter((m) => !invisible.has(m.user_id))
              .map((m) => {
                // LIVE DELIVERY, not just the push. This route is the socket
                // client's fallback when ITS connection is down, and it used to
                // persist the row and then notify only members who were
                // OFFLINE. A member sitting in the chat with a working socket is
                // by definition not offline, so they were told nothing at all:
                // no bubble, no notification, nothing until they backgrounded
                // the app or their reconnect catch-up fired. One person on a
                // weak signal and the whole room went quiet for everybody else.
                //
                // Same room and same event name as sockets/handlers.js
                // send_message (`user:{id}`, never the flock room, so a member
                // who has not opened this chat still receives it), the same
                // per-member block filter, and the same row shape. The client
                // dedupes on message id, so a sender whose socket comes back
                // mid-request cannot end up with two bubbles.
                io.to(`user:${m.user_id}`).emit('new_message', copyFor(m.user_id));
                // senderId and messageId: see the socket twin.
                return pushIfOfflineDebounced(io, m.user_id,
                  `${req.user.name} in ${flockName}`,
                  preview,
                  { type: 'flock_message', flockId: String(flockId), senderId: String(req.user.id), messageId: String(message.id) }
                );
              })
          );

          // DELIVERY, on the way out. A member with a live socket in
          // `user:{id}` just took the emit above, so the bytes reached a
          // device — which is the whole of what "Delivered" claims, and is
          // deliberately not a claim about attention (services/pushHelper.js
          // writes out at length why a socket is not a person looking, and the
          // OPENED half never uses this signal).
          //
          // One UPDATE over the online members rather than one per member, and
          // the receipt goes to the SENDER alone: telling the rest of the room
          // would need each reader's own block list, and the sender's is
          // already in hand as `invisible`. Everyone else learns the same fact
          // from their own history read, which carries the roster.
          const online = members.rows
            .map((m) => m.user_id)
            .filter((id) => !invisible.has(id) && deliveredToLiveSocket(io, id));
          if (online.length > 0) {
            const moved = await pool.query(
              `UPDATE flock_members
                  SET last_delivered_message_id = $3
                WHERE flock_id = $1 AND user_id = ANY($2::int[]) AND status = 'accepted'
                  AND last_delivered_message_id < $3
                RETURNING user_id, last_delivered_message_id, last_opened_message_id`,
              [flockId, online, message.id]
            );
            for (const row of moved.rows) {
              io.to(`user:${req.user.id}`).emit('flock_read',
                flockReadPayload(flockId, row.user_id, null, row));
            }
          }
        }
      } catch (pushErr) {
        console.error('Flock message push error:', pushErr.message);
      }
    } catch (err) {
      console.error('Send message error:', err);
      res.status(500).json({ error: 'Failed to send message' });
    }
  }
);

// POST /api/messages/:id/react - Add emoji reaction to a message
// -------------------------------------------------------------------------
// FULL-SIZE PHOTO, ON DEMAND
// -------------------------------------------------------------------------
// History deliberately ships only the thumbnail for image messages (the CASE
// in both history SELECTs above); the full image stays in the row exactly for
// this. One authenticated, membership-gated read returns it when a person
// actually taps the photo, so the 95 percent bandwidth saving on history
// survives while full quality stays one tap away. Same visibility rules as
// history: a hidden (taken down) message serves nothing.
router.get('/flocks/:id/messages/:messageId/image',
  [
    param('id').isInt({ min: 1, max: INT4_MAX }),
    param('messageId').isInt({ min: 1, max: INT4_MAX }),
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
      // The same visibility filter every other read in this file applies, and
      // the only one that was missing it. The history query drops a blocked
      // member's rows and the reaction grouping drops their reactions; this
      // route took a message id and a membership check and nothing else, so the
      // full resolution photo of somebody you had blocked, or who had blocked
      // you, was still served to a fellow member who asked for it by id. The UI
      // closes it (handleUserBlocked strips their messages, so no row is
      // tappable) and that is exactly why it has to be closed here as well:
      // a screen-level fix is not an access rule.
      const invisible = await getInvisibleUserIds(req.user.id);
      const row = await pool.query(
        `SELECT image_url FROM messages
          WHERE id = $1 AND flock_id = $2 AND COALESCE(is_hidden, false) = false AND sender_deleted_at IS NULL
            AND (sender_id IS NULL OR NOT (sender_id = ANY($3::int[])))`,
        [req.params.messageId, flockId, invisible]
      );
      if (row.rows.length === 0 || !row.rows[0].image_url) {
        return res.status(404).json({ error: 'Photo not found' });
      }
      res.json({ image: row.rows[0].image_url });
    } catch (err) {
      console.error('Get full-size image error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

router.get('/dm/messages/:id/image',
  [param('id').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid message ID')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }
      const dm = await pool.query(
        `SELECT sender_id, receiver_id, image_url FROM direct_messages
          WHERE id = $1 AND COALESCE(is_hidden, false) = false AND sender_deleted_at IS NULL`,
        [req.params.id]
      );
      if (dm.rows.length === 0) return res.status(404).json({ error: 'Photo not found' });
      if (dm.rows[0].sender_id !== req.user.id && dm.rows[0].receiver_id !== req.user.id) {
        // 404, not 403: a stranger must not learn the message id exists.
        return res.status(404).json({ error: 'Photo not found' });
      }
      if (!dm.rows[0].image_url) return res.status(404).json({ error: 'Photo not found' });
      res.json({ image: dm.rows[0].image_url });
    } catch (err) {
      console.error('Get DM full-size image error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// -------------------------------------------------------------------------
// UNSEND
// -------------------------------------------------------------------------
// A sent message could never be taken back. The tombstone
// (sender_deleted_at, migration 055) is a sender-owned retirement, NOT a
// delete: a reported message is evidence and the one person with a motive to
// destroy it must not be able to (the owner-deleted promotions rule,
// migration 020, applied to chat). Authorization lives in the UPDATE's own
// predicate, sender_id = the verified caller, so there is no
// check-then-act window and a non-sender learns only 404.
router.delete('/flocks/:id/messages/:messageId',
  [
    param('id').isInt({ min: 1, max: INT4_MAX }),
    param('messageId').isInt({ min: 1, max: INT4_MAX }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }
      const flockId = parseInt(req.params.id);
      const result = await pool.query(
        `UPDATE messages SET sender_deleted_at = NOW()
          WHERE id = $1 AND flock_id = $2 AND sender_id = $3
            AND sender_deleted_at IS NULL
          RETURNING id`,
        [req.params.messageId, flockId, req.user.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
      // THE PIN GOES WITH THE WORDS (migration 068). Every pin read drops an
      // unsent message, so its pin row sat on unseen: nobody could see it to
      // unpin it, it held one of the three seats, and nobody was told the bar
      // had changed. The row is retired with the message and the list goes
      // out again. A separate statement, and a failure here costs the cleanup
      // and never the unsend, which is already written: the pin count and
      // every read ignore a pin whose message is gone either way.
      let unpinned = false;
      try {
        const pin = await pool.query(
          'DELETE FROM pinned_messages WHERE flock_id = $1 AND message_id = $2 RETURNING message_id',
          [flockId, result.rows[0].id]
        );
        unpinned = pin.rows.length > 0;
      } catch (pinErr) {
        console.error('Unsend unpin error:', pinErr.message);
      }
      const io = req.app.get('io');
      if (io) {
        emitToFlockExcludingBlocked(io, flockId, req.user.id, 'flock_message_unsent', {
          flockId, messageId: result.rows[0].id,
        }).catch((e) => console.error('unsend fan-out failed:', e.message));
        io.to(`user:${req.user.id}`).emit('flock_message_unsent', { flockId, messageId: result.rows[0].id });
      }
      res.json({ success: true });
      if (unpinned) broadcastPins(req, flockId);
    } catch (err) {
      console.error('Unsend flock message error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

router.delete('/dm/messages/:id',
  [param('id').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid message ID')],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }
      const result = await pool.query(
        `UPDATE direct_messages SET sender_deleted_at = NOW()
          WHERE id = $1 AND sender_id = $2 AND sender_deleted_at IS NULL
          RETURNING id, receiver_id`,
        [req.params.id, req.user.id]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
      const io = req.app.get('io');
      if (io) {
        const payload = { messageId: result.rows[0].id, senderId: req.user.id };
        const receiverId = result.rows[0].receiver_id;
        // THE TOMBSTONE ALWAYS LANDS; THE EVENT DOES NOT ALWAYS TRAVEL. A block
        // does not take a sender's words back out of their hands, so the
        // UPDATE above runs whatever the pair's state. What a block does end is
        // one of them reaching the other's screen, and this emit used to go to
        // the counterpart unconditionally: a blocked sender could push an event
        // into the blocker's open socket for every message they had ever sent
        // them. This is the audience emitToFlockExcludingBlocked gives the flock
        // twin above: nobody blocked in either direction, and no banned account.
        // Nothing is lost by skipping it, because every read of this row
        // already filters the tombstone.
        //
        // Asked before the response and caught here, so a failed lookup costs
        // the counterpart's live removal and nothing else. It must not turn an
        // unsend that is already written into a 500 the client would retry
        // into a 404.
        let counterpartHears = false;
        try {
          counterpartHears = !(await isBlockedBetween(req.user.id, receiverId))
            && !(await counterpartyIsBanned(req.user.id, receiverId));
        } catch (audienceErr) {
          console.error('DM unsend audience check failed:', audienceErr.message);
        }
        if (counterpartHears) io.to(`user:${receiverId}`).emit('dm_message_unsent', payload);
        io.to(`user:${req.user.id}`).emit('dm_message_unsent', payload);
      }
      res.json({ success: true });
    } catch (err) {
      console.error('Unsend DM error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// -------------------------------------------------------------------------
// READ CURSOR
// -------------------------------------------------------------------------
// Flock chat's first read state (migration 056). The cursor is a message id
// watermark on flock_members rather than a timestamp because
// messages.created_at is a NAIVE timestamp and a TIMESTAMPTZ comparison
// against it is the four-hour restore shift again; ids are SERIAL and
// monotone, which is all a watermark needs. GREATEST makes the route
// idempotent and order-proof: a late or repeated PUT can only ever move the
// cursor forward. Membership is the UPDATE's own predicate, the same shape as
// unsend above, so a non-member learns only 404.
router.put('/flocks/:id/read',
  [
    param('id').isInt({ min: 1, max: INT4_MAX }),
    body('lastMessageId').isInt({ min: 1, max: INT4_MAX }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }
      const result = await pool.query(
        `UPDATE flock_members
            SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), $3)
          WHERE flock_id = $1 AND user_id = $2
          RETURNING last_read_message_id`,
        [parseInt(req.params.id), req.user.id, parseInt(req.body.lastMessageId)]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Flock not found' });
      res.json({ success: true, lastReadMessageId: result.rows[0].last_read_message_id });
      // The icon badge is only ever written by the server, on a push. A read
      // that empties the unread count has to push a zero or the number stays on
      // the icon until the next notification. Fire and forget: a push failure
      // never fails a read (services/pushHelper.js pushBadgeSync).
      pushBadgeSync(req.user.id).catch(() => {});
    } catch (err) {
      console.error('Mark flock read error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// -------------------------------------------------------------------------
// OPENED — the receipt, which is NOT the read cursor above
// -------------------------------------------------------------------------
// Two watermarks on the same row that look alike and mean different things,
// so it is worth being blunt about which is which.
//
//   last_read_message_id (056, the PUT above) is the UNREAD BADGE. The client
//   writes it whenever it decides the dot should clear, which includes a
//   background catch-up and a history page it never showed anyone. It is a
//   count, and a count that runs ahead of the truth costs nothing.
//
//   last_opened_message_id (065, this route) is a CLAIM MADE TO SOMEBODY
//   ELSE. It tells the sender a person looked. Nothing may set it except a
//   client saying, of itself, that the thread is on screen — which is why
//   this is its own route and its own column, and why the history read
//   below does not touch it. Reusing 056 here is the one shortcut that would
//   make every receipt in the product a lie.
//
// Delivery is set alongside, because opening a thread from a push is a real
// path that never ran a history read (see markFlockOpened).
router.put('/flocks/:id/opened',
  [
    param('id').isInt({ min: 1, max: INT4_MAX }),
    body('lastMessageId').isInt({ min: 1, max: INT4_MAX }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }
      const flockId = parseInt(req.params.id);
      // Membership is the UPDATE's own predicate inside the helper, the same
      // shape as unsend and the read cursor, so there is no check-then-act
      // window and a non-member learns only 404.
      const row = await markFlockOpened(
        req.app.get('io'), flockId, req.user.id, req.user.name, parseInt(req.body.lastMessageId)
      );
      if (!row) return res.status(404).json({ error: 'Flock not found' });
      res.json({
        success: true,
        lastOpenedMessageId: row.last_opened_message_id,
        lastDeliveredMessageId: row.last_delivered_message_id,
      });
    } catch (err) {
      console.error('Mark flock opened error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// The DM twin. `lastMessageId` is optional here and absent means "everything
// from this person": a DM thread has one counterparty, so there is no
// ambiguity about what was on screen, and a client that opened a thread from
// a push has no id to send.
//
// 403 rather than 404 on a block, matching every other DM metadata route in
// this file — the pair already know each other exists, so nothing is leaked
// by saying the interaction is over.
router.put('/dm/:userId/opened',
  [
    param('userId').isInt({ min: 1, max: INT4_MAX }),
    body('lastMessageId').optional({ values: 'null' }).isInt({ min: 1, max: INT4_MAX }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }
      const otherUserId = parseInt(req.params.userId);
      if (otherUserId === req.user.id) {
        return res.status(400).json({ error: 'Cannot receipt your own messages' });
      }
      if (await isBlockedBetween(req.user.id, otherUserId)) {
        return res.status(403).json({ error: 'You can no longer interact with this user.' });
      }
      // A banned counterpart is invisible everywhere else in this file, and a
      // receipt is a message to them; the thread read a few routes down
      // refuses the same pair for the same reason. ONE PAIR QUERY rather than
      // the product's whole ban list — see counterpartyIsBanned.
      if (await counterpartyIsBanned(req.user.id, otherUserId)) {
        return res.status(403).json({ error: 'You can no longer interact with this user.' });
      }
      const upTo = req.body.lastMessageId == null ? null : parseInt(req.body.lastMessageId);
      const opened = await markDmOpened(
        req.app.get('io'), req.user.id, otherUserId, upTo, { blockChecked: true }
      );
      // Idempotent: a repeat opens nothing and says so with an empty list
      // rather than an error. Nothing about this call can fail in a way the
      // caller can fix.
      res.json({ success: true, openedMessageIds: opened });
    } catch (err) {
      console.error('Mark DM opened error:', err);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

router.post('/messages/:id/react',
  [
    param('id').isInt({ min: 1, max: INT4_MAX }),
    // emoji_reactions.emoji is VARCHAR(10). `["👍"]` measures 2 through
    // isLength but reaches pg as the 5-character literal '{"👍"}', so a long
    // enough one-element array was a 22001 turned into a 500.
    scalarOnly(body('emoji'), 'emoji').trim().isLength({ min: 1, max: 10 }).withMessage('Emoji is required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const messageId = req.params.id;
      const { emoji } = req.body;

      // Verify the message exists and user is in that flock.
      // A6 takedown: a hidden message is gone from every read path, so it must
      // not still be reactable — otherwise a taken-down message keeps
      // generating flock_reaction_added broadcasts naming the reactor against
      // content nobody is allowed to see. Removing a reaction stays possible
      // (see the DELETE twin): cleanup after a takedown is not interaction.
      const msgResult = await pool.query(
        'SELECT flock_id FROM messages WHERE id = $1 AND is_hidden IS NOT TRUE AND sender_deleted_at IS NULL',
        [messageId]
      );
      if (msgResult.rows.length === 0) {
        return res.status(404).json({ error: 'Message not found' });
      }

      const flockId = msgResult.rows[0].flock_id;
      if (!(await verifyFlockMember(flockId, req.user.id))) {
        // 404, not 403: message ids are sequential, and a 403 here would
        // confirm "message 91824 exists, in a flock you cannot see" for every
        // id an outsider cared to try. A non-member gets the same answer as
        // for an id that was never issued.
        return res.status(404).json({ error: 'Message not found' });
      }

      const result = await pool.query(
        `INSERT INTO emoji_reactions (message_id, user_id, emoji)
         VALUES ($1, $2, $3)
         ON CONFLICT (message_id, user_id, emoji) DO NOTHING
         RETURNING *`,
        [messageId, req.user.id, emoji]
      );

      if (result.rows.length === 0) {
        // The same account reacting from a second device loses this race to
        // its first, and the reaction it asked for IS stored. The code lets the
        // app tell that apart from a refusal, keep the pill it drew, and not
        // roll back to a state without a reaction the server kept.
        return res.status(400).json({ error: 'Already reacted with this emoji', code: 'ALREADY_REACTED' });
      }

      // Notify flock members in real-time — block-aware fan-out, a room
      // broadcast would hand the reactor's identity to blocked members.
      const io = req.app.get('io');
      if (io) {
        emitToFlockExcludingBlocked(io, flockId, req.user.id, 'flock_reaction_added', {
          messageId: parseInt(messageId),
          emoji,
          userId: req.user.id,
          userName: req.user.name,
        }).catch(() => {});
        io.to(`user:${req.user.id}`).emit('flock_reaction_added', {
          messageId: parseInt(messageId),
          emoji,
          userId: req.user.id,
          userName: req.user.name,
        });
      }

      res.status(201).json({ reaction: result.rows[0] });
    } catch (err) {
      console.error('Add reaction error:', err);
      res.status(500).json({ error: 'Failed to add reaction' });
    }
  }
);

// DELETE /api/messages/:id/react/:emoji - Remove emoji reaction
router.delete('/messages/:id/react/:emoji',
  [param('id').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid message ID')],
  async (req, res) => {
    try {
      if (rejectInvalid(req, res)) return;
      const messageId = req.params.id;
      // Bounded before it reaches a VARCHAR(10) column (schema 000_bootstrap).
      const emoji = decodeURIComponent(req.params.emoji).slice(0, 10);

      // Get flock_id for socket notification
      const msgResult = await pool.query('SELECT flock_id FROM messages WHERE id = $1', [messageId]);
      const flockId = msgResult.rows[0]?.flock_id;

      const result = await pool.query(
        'DELETE FROM emoji_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3 RETURNING *',
        [messageId, req.user.id, emoji]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Reaction not found' });
      }

      // Notify flock members — block-aware fan-out (see the add path).
      if (flockId) {
        const io = req.app.get('io');
        if (io) {
          emitToFlockExcludingBlocked(io, flockId, req.user.id, 'flock_reaction_removed', {
            messageId: parseInt(messageId),
            emoji,
            userId: req.user.id,
          }).catch(() => {});
          io.to(`user:${req.user.id}`).emit('flock_reaction_removed', {
            messageId: parseInt(messageId),
            emoji,
            userId: req.user.id,
          });
        }
      }

      res.json({ message: 'Reaction removed' });
    } catch (err) {
      console.error('Remove reaction error:', err);
      res.status(500).json({ error: 'Failed to remove reaction' });
    }
  }
);

// --- Direct Messages ---

// The DM list is the inbox: newest conversations first, and nobody scrolls to
// the four-hundredth one. It is also the only read in this file with no bound
// of any kind, on the fastest-growing table in the schema — see the note in the
// route below.
const DM_CONVERSATION_LIMIT = 200;

// GET /api/dm - List all DM conversations (latest message per user)
router.get('/dm', async (req, res) => {
  try {
    // ── Three things were wrong with the query below (query-reliability round)
    //
    // 1. AVATAR AMPLIFICATION. `u.profile_image_url` was selected inside the
    //    subquery, i.e. once per DM ROW, and DISTINCT ON collapses to one row
    //    per partner only after the sort has already carried every one of those
    //    rows. Legacy avatars in this database are base64 data URLs — every
    //    other read path in this file guards them explicitly ("Giant legacy
    //    base64 avatars would be repeated on every one of up to 100 rows"), and
    //    this one repeated them over EVERY DM the account has ever sent or
    //    received, with no cap at all. A user with 10,000 messages and a 12KB
    //    avatar on the other side made Postgres sort ~120MB to return twenty
    //    rows. The join now happens AFTER the collapse, once per partner, and
    //    carries the same >12000 guard the sibling queries use.
    //
    // 2. NO LIMIT. A list the user grows without bound, with none.
    //
    // 3. THE BLOCK FILTER WAS APPLIED IN JAVASCRIPT, after the query. That was
    //    harmless while the result was the complete list; with a LIMIT it is
    //    not, because blocked partners would eat slots and push real
    //    conversations off the end. Moved into SQL, ahead of the LIMIT — the
    //    same reasoning the flock-message read above already writes down
    //    ("filtered IN SQL, before LIMIT — filtering after pagination could
    //    return an empty page while older visible messages still existed").
    //
    // BEHAVIOUR CHANGE, stated plainly: an account with more than 200 visible
    // conversations now sees its 200 most recent. Nothing else moves.
    const invisible = await getInvisibleUserIds(req.user.id);

    const result = await pool.query(
      // Nested subqueries rather than CTEs on purpose: a CTE is an optimization
      // fence on PostgreSQL 11 and older, which would force the whole message
      // history to be materialized before the DISTINCT ON — the very cost this
      // rewrite exists to remove. Plain subqueries are never fenced on any
      // version, and this query has to be right on whatever Railway is running.
      `SELECT l.*, u.name AS other_name,
              CASE WHEN LENGTH(u.profile_image_url) > 12000 THEN NULL ELSE u.profile_image_url END AS other_image
       FROM (
         SELECT DISTINCT ON (other_id) *
         FROM (
           -- A PREVIEW, NOT THE BODY. This row exists to draw one ellipsized
           -- line. A DM is capped at 5,000 characters on both transports (the
           -- isLength on the send route below, and the socket twin), the
           -- collapse above keeps one row per partner, DM_CONVERSATION_LIMIT is
           -- 200, and the outer SELECT l.* forwards whatever is selected
           -- here — so one response could carry 200 full bodies, about a
           -- megabyte, read, detoasted, sorted and serialised to fill rows
           -- the inbox renders
           -- with overflow hidden, text-overflow ellipsis and white-space
           -- nowrap. Everything past the first line was thrown away by CSS.
           -- Nothing else reads the field: the FULL body comes from the thread
           -- read (GET /api/dm/:userId), and a thread already loaded in the
           -- client derives its preview from those messages instead. 160
           -- characters is past what any phone width fits on that one line, so
           -- unlike the report queue in routes/admin.js this needs no "was it
           -- clipped" flag beside it; there is nothing the row could do with one.
           SELECT dm.id, LEFT(dm.message_text, 160) AS message_text, dm.created_at, dm.read_status, dm.sender_id,
                  CASE WHEN dm.sender_id = $1 THEN dm.receiver_id ELSE dm.sender_id END AS other_id
           FROM direct_messages dm
           WHERE (dm.sender_id = $1 OR dm.receiver_id = $1)
             AND COALESCE(dm.is_hidden, false) = false AND dm.sender_deleted_at IS NULL
         ) mine
         WHERE NOT (other_id = ANY($2::int[]))
         ORDER BY other_id, created_at DESC, id DESC
       ) l
       JOIN users u ON u.id = l.other_id
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT $3`,
      [req.user.id, invisible, DM_CONVERSATION_LIMIT]
    );

    const partnerIds = result.rows.map((r) => r.other_id);

    // Get unread counts per conversation. Moderator-hidden DMs are excluded —
    // no projection will ever display them, so counting them left a ghost
    // unread badge that could never be cleared. Scoped to the partners actually
    // being returned: every other group in this aggregate was discarded
    // unread, and with a blocked partner it was counted and then thrown away.
    let unreadMap = {};
    if (partnerIds.length > 0) {
      const unreadResult = await pool.query(
        `SELECT sender_id, COUNT(*)::int AS unread_count
         FROM direct_messages
         WHERE receiver_id = $1 AND read_status = FALSE
           AND COALESCE(is_hidden, false) = false AND sender_deleted_at IS NULL
           AND sender_id = ANY($2::int[])
         GROUP BY sender_id`,
        [req.user.id, partnerIds]
      );
      unreadResult.rows.forEach(r => { unreadMap[r.sender_id] = parseInt(r.unread_count); });
    }

    // Already ordered newest-first by the query; the JS sort it used to need is
    // gone with the DISTINCT ON ordering that forced it.
    const conversations = result.rows.map(r => ({
      userId: r.other_id,
      name: r.other_name,
      image: r.other_image,
      lastMessage: r.message_text,
      lastMessageTime: r.created_at,
      lastMessageIsYou: r.sender_id === req.user.id,
      unread: unreadMap[r.other_id] || 0,
    }));

    res.json({ conversations });
  } catch (err) {
    console.error('Get DM conversations error:', err);
    res.status(500).json({ error: 'Failed to get conversations' });
  }
});

// GET /api/dm/:userId - Get DM conversation with a user (paginated)
router.get('/dm/:userId',
  [
    param('userId').isInt({ min: 1, max: INT4_MAX }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('before').optional().isInt({ min: 1, max: INT4_MAX }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }
      const otherUserId = parseInt(req.params.userId);
      const limit = Math.min(parseInt(req.query.limit) || 50, 100);
      const before = req.query.before ? parseInt(req.query.before) : null;

      // Mutual block: hide the conversation entirely if either side blocked the other.
      if (await isBlockedBetween(req.user.id, otherUserId)) {
        return res.json({ messages: [], blocked: true });
      }
      // A banned counterpart is gone from the inbox; the direct thread read
      // used to hand it back by id (hardening round, 2026-09-05). ONE PAIR
      // QUERY rather than the product's whole ban list — see
      // counterpartyIsBanned, which the receipt route above refuses the same
      // pair with.
      if (await counterpartyIsBanned(req.user.id, otherUserId)) {
        return res.json({ messages: [], blocked: true });
      }

      // Same cursor/order alignment as the flock read above, for the same
      // reasons: the sort key IS the cursor key (id — SERIAL, unique, monotone
      // with arrival), so pages tile exactly under ties and concurrent sends,
      // and the first page and the cursor page are one statement instead of two
      // copies that can drift. (direct_messages.sender_id is ON DELETE CASCADE,
      // not SET NULL, so the null-sender guard the flock read needs has no
      // equivalent here — a DM cannot outlive its sender.)
      const dmQuery = `
          -- Giant legacy base64 avatars would be repeated on every one of up to 100 rows; drop oversized ones instead of amplifying them (REVIEW-ROUND5)
          -- Named for the same reason as the flock history above: dm.*
          -- carried image_url, so the full base64 was read and transmitted for
          -- every row before being discarded in JS.
          SELECT dm.id, dm.sender_id, dm.receiver_id, dm.message_text, dm.message_type,
                 dm.venue_data, dm.reply_to_id, dm.read_status, dm.created_at,
                 dm.delivered_at, dm.opened_at, dm.is_hidden, dm.thumb_url,
                 dm.sender_deleted_at,
                 u.name AS sender_name, CASE WHEN LENGTH(u.profile_image_url) > 12000 THEN NULL ELSE u.profile_image_url END AS sender_image,
                 -- Same rule as the flock history: a row with a thumbnail ships
                 -- only the thumbnail, and this is now its only source.
                 CASE WHEN dm.thumb_url IS NOT NULL THEN NULL ELSE dm.image_url END AS image_url
          FROM direct_messages dm
          JOIN users u ON u.id = dm.sender_id
          WHERE ((dm.sender_id = $1 AND dm.receiver_id = $2)
              OR (dm.sender_id = $2 AND dm.receiver_id = $1))
            AND COALESCE(dm.is_hidden, false) = false AND dm.sender_deleted_at IS NULL
            AND ($3::int IS NULL OR dm.id < $3)
          ORDER BY dm.id DESC
          LIMIT $4`;
      const params = [req.user.id, otherUserId, before, limit];

      const result = await pool.query(dmQuery, params);
      // Exclude moderator-hidden DMs (A6 takedown).
      const messages = result.rows.filter((m) => !m.is_hidden);

      // Fetch reactions for all returned DMs
      if (messages.length > 0) {
        const dmIds = messages.map((m) => m.id);
        const reactionsResult = await pool.query(
          `SELECT dr.dm_id, dr.emoji, dr.user_id, u.name AS user_name
           FROM dm_emoji_reactions dr
           JOIN users u ON u.id = dr.user_id
           WHERE dr.dm_id = ANY($1)`,
          [dmIds]
        );
        const reactionsByDm = {};
        for (const r of reactionsResult.rows) {
          if (!reactionsByDm[r.dm_id]) reactionsByDm[r.dm_id] = [];
          reactionsByDm[r.dm_id].push(r);
        }
        for (const msg of messages) {
          msg.reactions = reactionsByDm[msg.id] || [];
        }
      }

      // Fetch reply-to message text for any replies.
      // SECURITY: scoped to this conversation's pair — a stored reply_to_id
      // pointing at another conversation must never hydrate its text here.
      const replyIds = messages.filter(m => m.reply_to_id).map(m => m.reply_to_id);
      if (replyIds.length > 0) {
        const replyResult = await pool.query(
          `SELECT dm.id, dm.message_text, u.name AS sender_name
           FROM direct_messages dm JOIN users u ON u.id = dm.sender_id
           WHERE dm.id = ANY($1)
             AND COALESCE(dm.is_hidden, false) = false AND dm.sender_deleted_at IS NULL
             AND ((dm.sender_id = $2 AND dm.receiver_id = $3) OR (dm.sender_id = $3 AND dm.receiver_id = $2))`,
          [replyIds, req.user.id, otherUserId]
        );
        const replyMap = {};
        replyResult.rows.forEach(r => { replyMap[r.id] = r; });
        for (const msg of messages) {
          if (msg.reply_to_id && replyMap[msg.reply_to_id]) {
            msg.reply_to = replyMap[msg.reply_to_id];
          }
        }
      }

      // Receipts (migration 065). Nothing is fetched for this: the two
      // timestamp columns arrived on `dm.*` above, and attachDmStatus turns
      // them into the one word StatusLine draws, on the viewer's OWN rows
      // only. A receipt belongs to the person who sent the message.
      attachDmStatus(messages, req.user.id);

      // Mark unread messages from the other user as read
      await pool.query(
        `UPDATE direct_messages SET read_status = TRUE
         WHERE sender_id = $1 AND receiver_id = $2 AND read_status = FALSE`,
        [otherUserId, req.user.id]
      );

      res.json({ messages: messages.reverse() });
      // The rows above just left the unread count, so the app icon's badge is
      // stale until the next push. The flock read route resyncs it here
      // (PUT /flocks/:id/read); this one never did, so opening a DM with
      // unread left the old number on the icon. Best effort, after the
      // response, never fails a read.
      pushBadgeSync(req.user.id).catch(() => {});

      // DELIVERY, and deliberately not opening. This client just pulled the
      // thread, so the bytes reached a device and "Delivered" is true. Whether
      // anyone LOOKED is a different fact with a different door
      // (PUT /dm/:userId/opened): a history read fires on reconnect, on a
      // background catch-up and on a scroll to the top, and calling any of
      // those "Opened" is the lie StatusLine refuses to draw.
      //
      // After the response and self-contained, like the badge sync above it: a
      // receipt is worth less than the read it rides on, so it never delays it
      // and never fails it. blockChecked because both block gates ran at the
      // top of this route.
      markDmDelivered(req.app.get('io'), req.user.id, otherUserId, null, { blockChecked: true })
        .catch((e) => console.error('DM delivery receipt error:', e.message));
    } catch (err) {
      console.error('Get DMs error:', err);
      res.status(500).json({ error: 'Failed to get messages' });
    }
  }
);

// POST /api/dm/:userId - Send a DM (supports text, venue_card, image)
router.post('/dm/:userId',
  [
    param('userId').isInt({ min: 1, max: INT4_MAX }),
    // Same shape rules as the flock-message twin above, for the same reasons.
    // Optional here, and "must carry something" is enforced in the handler —
    // see messageBody above. A `min: 1` on this field alone cannot express
    // "text OR an image", and an .optional() chain is skipped entirely for an
    // absent field, so a cross-field rule cannot live on it either.
    freeText(body('message_text').optional({ values: 'null' }), 'message')
      .isLength({ max: 5000 }).withMessage('Message is too long (max 5000 characters)'),
    scalarOnly(body('message_type').optional({ values: 'null' }), 'message type').isIn(['text', 'venue_card', 'image']),
    body('venue_data').optional({ values: 'null' }).isObject(),
    // data: URLs only — a sender-controlled https image is a tracking pixel
    // aimed at every recipient (round 7); the socket path already refuses them.
    scalarOnly(body('image_url').optional({ values: 'null' }), 'image')
      .custom(isChatImageUrl).withMessage(IMAGE_FORMAT_MESSAGE),
    scalarOnly(body('thumb_url').optional({ values: 'null' }), 'thumbnail'),
    // direct_messages.reply_to_id is int4: `[5]` passed isInt and then reached
    // the reply-scope lookup as '{5}', which is 22P02 — a 500 rather than the
    // 400 an unusable reply target deserves.
    scalarOnly(body('reply_to_id').optional({ values: 'null' }), 'reply target').isInt({ min: 1, max: INT4_MAX }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      // Same "text or an image" rule as the flock-message twin, and in the same
      // place — before any query. This is no longer theoretical: App.js used to
      // send the literal word "Photo" as the text of every image DM, which is
      // the only reason the old text-is-mandatory rule survived contact with the
      // client. It stopped, so an image DM now genuinely carries no text.
      const { text: message_text, image: image_url, thumb, empty, tooLarge } = messageBody(req);
      if (empty) return res.status(400).json({ error: EMPTY_MESSAGE });
      // Same free-before-billed ordering as the flock twin above, and the same
      // ceiling the socket's send_dm enforces.
      if (tooLarge) return res.status(400).json({ error: IMAGE_TOO_LARGE_MESSAGE });
      // Echo matching only; see the flock twin above and readClientId.
      const clientId = readClientId(req.body.client_id);

      const receiverId = parseInt(req.params.userId);
      if (receiverId === req.user.id) {
        return res.status(400).json({ error: 'Cannot send a DM to yourself' });
      }

      // Mutual block: if either user blocked the other, no DMs in either direction.
      if (await isBlockedBetween(req.user.id, receiverId)) {
        return res.status(403).json({ error: 'You can no longer message this user.' });
      }

      // Audit 2026-08-14: this route used to answer "404 User not found" for an
      // id nobody holds and "201 Created" for one somebody does, with no
      // relationship required either way — a directory walk that dropped a
      // message in a stranger's inbox on every hit. The socket transport has
      // required a real relationship for persisting DM writes since round 5;
      // the REST twin now does too, and the ONE refusal covers both "no such
      // user" and "not connected", so neither can be read off the other.
      if (!(await hasDmRelationship(req.user.id, receiverId))) {
        return res.status(403).json({ error: NOT_CONNECTED_MESSAGE });
      }

      const { message_type, venue_data, reply_to_id } = req.body;

      // UGC text filter (Apple 1.2) — reject objectionable content before storing.
      if (rejectIfProfaneChat(res, message_text)) return;

      // Same venue-card sanitizing as flock messages (round 8).
      const venueCheck = sanitizeVenueData(venue_data);
      if (!venueCheck.ok) {
        return res.status(400).json({ error: VENUE_REJECTED_MESSAGE });
      }

      // SECURITY: a reply may only reference a message from THIS conversation
      // (same invariant as the socket path — see sockets/handlers.js).
      //
      // The socket twin also refuses a HIDDEN target; this one did not, so a
      // moderator-hidden DM could be quoted back into the thread by replying to
      // it over REST — the takedown undone through the transport that forgot to
      // check. Kept identical to the socket predicate so the two transports
      // cannot drift again.
      //
      // MOVED AHEAD OF moderateImage (query-reliability round). This is a
      // primary-key lookup on direct_messages that can REFUSE the request, and
      // moderateImage is a BILLED Google Vision call. Every other refusal on
      // this route — empty, oversized, self-DM, blocked, not connected, profane,
      // bad venue card — already sits in front of that call for exactly this
      // reason; the reply check was the one free refusal left behind it, so a
      // client looping a send with a stale reply id paid for a Vision screen on
      // every attempt and was refused anyway.
      //
      // WHAT CHANGES: a request that is BOTH carrying a rejectable image AND
      // naming an invalid reply target now answers "Invalid reply target"
      // instead of the image rejection. Both are 400s and both refuse the send;
      // only which sentence comes back moves. sockets/handlers.js send_dm still
      // has the old order (it is not this rotation's file) — see the handoff.
      let safeReplyId = null;
      if (reply_to_id) {
        const replyCheck = await pool.query(
          `SELECT id FROM direct_messages
           WHERE id = $1
             AND COALESCE(is_hidden, false) = false AND sender_deleted_at IS NULL
             AND ((sender_id = $2 AND receiver_id = $3) OR (sender_id = $3 AND receiver_id = $2))`,
          [reply_to_id, req.user.id, receiverId]
        );
        if (replyCheck.rows.length === 0) {
          return res.status(400).json({ error: 'Invalid reply target' });
        }
        safeReplyId = reply_to_id;
      }

      // Image moderation on the REST transport too (same as flock messages),
      // including the byte-level multi-frame gate — and metered by the same
      // per-account billed-image limiter in server.js. See the note there.
      if (image_url) {
        const verdict = await moderateImage(image_url, { userId: req.user.id });
        if (!verdict.allowed) {
          return res.status(400).json({ error: imageRejectionMessage(verdict), moderation: verdict.reason });
        }
      }
      // Same thumb rule as the flock twin: moderated like the image, dropped
      // on any failure, never fatal to the send.
      let safeThumb = null;
      if (thumb) {
        try {
          const thumbVerdict = await moderateImage(thumb, { userId: req.user.id });
          if (thumbVerdict.allowed) safeThumb = sanitizeStoredImage(thumb);
        } catch { /* no thumbnail, full image serves as before */ }
      }

      const result = await pool.query(
        `INSERT INTO direct_messages (sender_id, receiver_id, message_text, message_type, venue_data, image_url, reply_to_id, thumb_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [req.user.id, receiverId, message_text, message_type || 'text', venueCheck.data,
          // Same re-typing as the flock twin above and both socket paths.
          image_url ? sanitizeStoredImage(image_url) : null,
          safeReplyId,
          safeThumb]
      );

      const message = result.rows[0];
      message.sender_name = req.user.name;
      message.reactions = [];
      // The quoted row the recipient's bubble reads, same shape as the socket
      // twin's `msg.reply_to`. Without it a reply delivered over this transport
      // quoted a blank line under a blank name on the recipient's screen. The
      // id is already scope-checked above, so this only fetches the two display
      // fields, and a failure here drops the quote rather than the message: the
      // row is stored and reply_to_id is on it either way, and a decoration on
      // the payload must never be able to turn a saved DM into a 500.
      if (safeReplyId) {
        try {
          const quoted = await pool.query(
            `SELECT dm.id, dm.message_text, u.name AS sender_name
             FROM direct_messages dm JOIN users u ON u.id = dm.sender_id
             WHERE dm.id = $1`,
            [safeReplyId]
          );
          if (quoted.rows[0]) message.reply_to = quoted.rows[0];
        } catch (quoteErr) {
          console.error('DM reply hydrate error:', quoteErr.message);
        }
      }

      // This row IS the relationship (utils/relationships.js counts one stored
      // DM), so the cached "not connected" from a moment ago is now wrong. The
      // socket twin invalidates here and this one did not, so a first DM sent
      // over the fallback transport left typing dots and live location refused
      // for the rest of the 30s TTL.
      invalidateDmRelationshipCache(req.user.id, receiverId);

      // Same rule as the flock twin: the send echo carries 'sent', the
      // recipient's copy carries no status at all. The client id rides on the
      // sender's copies only, never on the one the recipient gets.
      const senderCopy = ownEcho(message, clientId, { status: 'sent' });
      res.status(201).json({ message: senderCopy });

      // Offline push, mirroring the socket send_dm path in sockets/handlers.js.
      // This route is the socket client's fallback when disconnected, so without
      // this an offline recipient of a fallback-delivered DM was never notified.
      // Same debounce key shape ({ type: 'dm_message', senderId }) as the socket
      // path so the two transports never double-notify. The block gate reads
      // senderId; a mutual block was already refused above. Post-response and
      // self-contained so Firebase cannot turn a stored DM into a 500.
      try {
        const io = req.app.get('io');
        if (io) {
          // Empty for an image-only DM, and normalizeBody() answers that with
          // "Sent you something" — see the note on the flock twin above.
          // LIVE DELIVERY, not just the push. Same gap as the flock twin
          // above. This route runs when the SENDER's socket is down, which says
          // nothing about the recipient's: someone sitting in the thread with a
          // working connection is not offline, so pushIfOfflineDebounced told
          // them nothing and no `new_dm` was ever emitted either. The message
          // simply did not arrive until they left the screen and came back.
          // Same room and event name as sockets/handlers.js send_dm; the client
          // dedupes on message id.
          io.to(`user:${receiverId}`).emit('new_dm', message);
          // And the sender's other devices, for the reason send_dm gives: an
          // account is several devices, and the one that posted this over
          // REST is the one whose socket is down, so the others are the ones
          // that need telling. The client dedupes on id.
          io.to(`user:${req.user.id}`).emit('new_dm', senderCopy);
          // The emit above went out over the recipient's open connection, so
          // the bytes reached a device: that is "Delivered", and it is the
          // only claim a live socket may support. The dm_delivered receipt
          // that follows lands on the sender's room AFTER their own new_dm
          // echo, which is the order the client needs to have a row to attach
          // it to. Ordering within one room is Socket.io's own guarantee.
          if (deliveredToLiveSocket(io, receiverId)) {
            await markDmDelivered(io, receiverId, req.user.id, message.id, { blockChecked: true })
              .catch((e) => console.error('DM delivery receipt error:', e.message));
          }
          const preview = (message_text || '').substring(0, 100);
          await pushIfOfflineDebounced(io, receiverId,
            req.user.name,
            preview,
            { type: 'dm_message', senderId: String(req.user.id), dmId: String(message.id) }
          );
        }
      } catch (pushErr) {
        console.error('DM push error:', pushErr.message);
      }
    } catch (err) {
      console.error('Send DM error:', err);
      res.status(500).json({ error: 'Failed to send message' });
    }
  }
);

// Helper: canonical DM pair key (always smaller ID first)
function dmPairKey(a, b) {
  return a < b ? { user1: a, user2: b } : { user1: b, user2: a };
}

// POST /api/dm/messages/:id/react - Add reaction to a DM
router.post('/dm/messages/:id/react',
  [
    param('id').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid message ID'),
    body('emoji').isString().withMessage('Emoji is required')
      .trim().isLength({ min: 1, max: 10 }).withMessage('Emoji is required'),
  ],
  async (req, res) => {
    try {
      if (rejectInvalid(req, res)) return;
      const dmId = parseInt(req.params.id);
      const { emoji } = req.body;

      // Verify DM exists and user is sender or receiver. Hidden DMs are not
      // reactable, for the same reason as flock messages above: a takedown ends
      // the message, and reacting is the one interaction left that could still
      // reach across it.
      const dm = await pool.query(
        `SELECT sender_id, receiver_id FROM direct_messages
         WHERE id = $1 AND COALESCE(is_hidden, false) = false AND sender_deleted_at IS NULL`,
        [dmId]
      );
      if (dm.rows.length === 0) return res.status(404).json({ error: 'Message not found' });
      if (dm.rows[0].sender_id !== req.user.id && dm.rows[0].receiver_id !== req.user.id) {
        // 404, not 403, and the same body as an id that was never issued.
        // DM ids are serial, and a 403 here confirmed "message 91824 exists,
        // between two other people" for every id an outsider cared to try.
        // The flock twin above and the DM photo route already answer this way.
        return res.status(404).json({ error: 'Message not found' });
      }
      const counterpart = dm.rows[0].sender_id === req.user.id ? dm.rows[0].receiver_id : dm.rows[0].sender_id;
      if (await isBlockedBetween(req.user.id, counterpart)) {
        return res.status(403).json({ error: 'You can no longer interact with this user.' });
      }
      // A banned counterpart ends the conversation the way a block does: the
      // thread read hands back nothing for this pair, and every DM write door
      // that asks hasDmRelationship is told no. This one asked only about
      // blocks, so a reaction still landed in a banned account's thread. Same
      // pair question and same refusal as the read receipt above.
      if (await counterpartyIsBanned(req.user.id, counterpart)) {
        return res.status(403).json({ error: 'You can no longer interact with this user.' });
      }

      const result = await pool.query(
        `INSERT INTO dm_emoji_reactions (dm_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT (dm_id, user_id, emoji) DO NOTHING RETURNING *`,
        [dmId, req.user.id, emoji]
      );
      if (result.rows.length === 0) return res.status(400).json({ error: 'Already reacted' });
      // The socket path (sockets/handlers.js dm_react) tells both sides live;
      // this route told nobody, so a reaction that arrived here, which is the
      // client's fallback when its socket is down, stayed invisible to the
      // other person until a reload. Same payload as the socket path.
      const io = req.app.get('io');
      if (io) {
        const payload = { dmId, emoji, userId: req.user.id, userName: req.user.name };
        io.to(`user:${counterpart}`).emit('dm_reaction_added', payload);
        io.to(`user:${req.user.id}`).emit('dm_reaction_added', payload);
      }
      res.status(201).json({ reaction: result.rows[0] });
    } catch (err) {
      console.error('DM react error:', err);
      res.status(500).json({ error: 'Failed to add reaction' });
    }
  }
);

// DELETE /api/dm/messages/:id/react/:emoji - Remove DM reaction
router.delete('/dm/messages/:id/react/:emoji', [param('id').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid message ID')], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const dmId = parseInt(req.params.id);
    const emoji = decodeURIComponent(req.params.emoji).slice(0, 10);
    // ONE ANSWER FOR "NOT YOURS": the 404 an id that was never issued gets,
    // byte for byte, and before anything else is asked. The block check below
    // used to run for anybody, reading the message's SENDER as the caller's
    // counterpart when the caller was neither party, so an outsider with a
    // block against someone got a 403 for every DM that person had ever sent
    // and a 404 for everything else: a walk over the serial DM ids that
    // picked out one person's messages. The add route above has answered a
    // non-participant this way since it was closed; nobody outside the pair
    // has a reaction here to remove.
    const notFound = () => res.status(404).json({ error: 'Reaction not found' });
    const dm = await pool.query('SELECT sender_id, receiver_id FROM direct_messages WHERE id = $1', [dmId]);
    if (dm.rows.length === 0) return notFound();
    if (dm.rows[0].sender_id !== req.user.id && dm.rows[0].receiver_id !== req.user.id) return notFound();
    const counterpart = dm.rows[0].sender_id === req.user.id ? dm.rows[0].receiver_id : dm.rows[0].sender_id;
    // Blocks end ALL interaction with the shared conversation, removals included.
    if (await isBlockedBetween(req.user.id, counterpart)) {
      return res.status(403).json({ error: 'You can no longer interact with this user.' });
    }
    const result = await pool.query(
      'DELETE FROM dm_emoji_reactions WHERE dm_id = $1 AND user_id = $2 AND emoji = $3 RETURNING *',
      [dmId, req.user.id, emoji]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Reaction not found' });
    // Mirror of the add route above: the removal reaches both sides live.
    //
    // THE REMOVAL IS CLEANUP; TELLING THE OTHER SIDE IS CONTACT. Taking your
    // own reaction back stays allowed whatever the pair's state short of a
    // block (the row is yours), but the event names you and lands in the
    // counterpart's open socket, and a banned account is not reachable on any
    // other DM door: the add route above refuses one, the thread read hands it
    // nothing. So the counterpart hears it only when they are not banned.
    // Asked only after a row really went, and a lookup that fails reads as
    // banned, so the answer is never an event that should not have gone.
    const io = req.app.get('io');
    if (io) {
      let counterpartHears = false;
      try {
        counterpartHears = !(await counterpartyIsBanned(req.user.id, counterpart));
      } catch (audienceErr) {
        console.error('DM reaction removal audience check failed:', audienceErr.message);
      }
      const payload = { dmId, emoji, userId: req.user.id, userName: req.user.name };
      if (counterpartHears) io.to(`user:${counterpart}`).emit('dm_reaction_removed', payload);
      io.to(`user:${req.user.id}`).emit('dm_reaction_removed', payload);
    }
    res.json({ message: 'Reaction removed' });
  } catch (err) {
    console.error('DM remove react error:', err);
    res.status(500).json({ error: 'Failed to remove reaction' });
  }
});

// GET /api/dm/:userId/venue-votes - Get venue votes for a DM conversation
router.get('/dm/:userId/venue-votes', [param('userId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid user ID')], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const otherUserId = parseInt(req.params.userId);
    // Mutual invisibility covers shared DM metadata reads, not just messages.
    if (await isBlockedBetween(req.user.id, otherUserId)) {
      return res.status(403).json({ error: 'You can no longer interact with this user.' });
    }
    // And so does a ban. The thread read refuses a banned counterpart and the
    // vote write beside this route does too (hasDmRelationship answers no),
    // but this read stopped at blocks, so the tally could still name the
    // banned account among its voters. Same pair query as the thread read,
    // and the same answer this route gives a block.
    if (await counterpartyIsBanned(req.user.id, otherUserId)) {
      return res.status(403).json({ error: 'You can no longer interact with this user.' });
    }
    const { user1, user2 } = dmPairKey(req.user.id, otherUserId);
    const result = await pool.query(
      `SELECT venue_name, MIN(venue_id) FILTER (WHERE venue_id IS NOT NULL) AS venue_id, COUNT(*)::int AS vote_count, ARRAY_AGG(u.name) AS voters
       FROM dm_venue_votes vv JOIN users u ON u.id = vv.user_id
       WHERE vv.user1_id = $1 AND vv.user2_id = $2
       GROUP BY venue_name ORDER BY vote_count DESC`,
      [user1, user2]
    );
    res.json({ votes: result.rows });
  } catch (err) {
    console.error('DM venue votes error:', err);
    res.status(500).json({ error: 'Failed to get votes' });
  }
});

// POST /api/dm/:userId/venue-votes - Vote for a venue in a DM conversation
router.post('/dm/:userId/venue-votes',
  [
    param('userId').isInt({ min: 1, max: INT4_MAX }),
    // Shape first: the handler runs stripHtml + rejectIfProfane on this value
    // and BOTH pass a non-string straight through, so an array was a screened
    // field that had never been screened — and it then reached the VARCHAR(255)
    // column and the vote lookup as an array literal. (venue_id below is safe
    // already: isString() is itself a shape check, and the handler re-tests
    // `typeof === 'string'` before slicing.)
    scalarOnly(body('venue_name'), 'venue name').trim().isLength({ min: 1, max: 255 }),
    body('venue_id').optional({ values: 'null' }).isString(),
  ],
  async (req, res) => {
    try {
      // The validator chain above was decorative: without validationResult the
      // length/type rules never rejected anything, so an unbounded venue_name
      // reached the INSERT (round 9 follow-up).
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const otherUserId = parseInt(req.params.userId);
      const { user1, user2 } = dmPairKey(req.user.id, otherUserId);
      if (await isBlockedBetween(req.user.id, otherUserId)) {
        return res.status(403).json({ error: 'You can no longer interact with this user.' });
      }
      // Round 9 checked the counterpart existed; that turned the route into an
      // existence oracle (404 vs 200) and still let anyone write DM metadata
      // into a conversation they are not part of. dm_venue_votes is keyed on
      // the ordered pair, which is why the socket transport requires a real
      // relationship here — this is the REST twin of that gate, with one
      // refusal covering both "no such user" and "not connected".
      if (!(await hasDmRelationship(req.user.id, otherUserId))) {
        return res.status(403).json({ error: NOT_CONNECTED_MESSAGE });
      }
      const venue_name = stripHtml(req.body.venue_name);
      // Venue names ride into the other person's UI (round 9 follow-up).
      if (rejectIfProfane(res, venue_name)) return;
      // dm_venue_votes.venue_id is VARCHAR(255) and the validator only checks
      // that it is a string, so an over-long id used to reach the INSERT and
      // come back as a swallowed 500 — and now would do it with a transaction
      // and an advisory lock held. Clamped, exactly as the socket twin does.
      const venue_id = typeof req.body.venue_id === 'string' ? req.body.venue_id.slice(0, 255) : null;
      // Toggle: if already voted for this venue, unvote; otherwise switch vote.
      //
      // This was read, DELETE, INSERT as three separate autocommit statements —
      // the exact race sockets/handlers.js fixed in dm_vote_venue. Two taps in
      // flight both saw "no existing vote", both deleted, and both inserted:
      // the UNIQUE key is (pair, user, venue_name), so two DIFFERENT venue names
      // both survive and one person holds two live votes in a two-person
      // conversation, while two taps on the SAME venue race the unique
      // constraint into a swallowed 500.
      //
      // Same implementation as the socket twin, and deliberately the SAME LOCK
      // KEY EXPRESSION ('dmvote:' || u1 || ':' || u2 || ':' || voter) so the REST
      // and socket transports serialize against EACH OTHER, not just against
      // themselves — a tap in the app and a tap on the web client are the same
      // toggle and must queue behind one another.
      const voteClient = await pool.connect();
      try {
        await voteClient.query('BEGIN');
        await voteClient.query(
          "SELECT pg_advisory_xact_lock(hashtext('dmvote:' || $1::text || ':' || $2::text || ':' || $3::text))",
          [String(user1), String(user2), String(req.user.id)]
        );
        const existing = await voteClient.query(
          `SELECT id FROM dm_venue_votes WHERE user1_id = $1 AND user2_id = $2 AND user_id = $3 AND venue_name = $4`,
          [user1, user2, req.user.id, venue_name]
        );
        // Either way the voter ends up with AT MOST one row in this pair: the
        // unconditional delete makes toggle-off and switch-vote the same
        // statement, so no path can leave two behind.
        await voteClient.query(
          `DELETE FROM dm_venue_votes WHERE user1_id = $1 AND user2_id = $2 AND user_id = $3`,
          [user1, user2, req.user.id]
        );
        if (existing.rows.length === 0) {
          await voteClient.query(
            `INSERT INTO dm_venue_votes (user1_id, user2_id, user_id, venue_name, venue_id) VALUES ($1, $2, $3, $4, $5)`,
            [user1, user2, req.user.id, venue_name, venue_id]
          );
        }
        await voteClient.query('COMMIT');
      } catch (txErr) {
        await voteClient.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        voteClient.release();
      }
      // Return updated tallies
      const result = await pool.query(
        `SELECT venue_name, MIN(venue_id) FILTER (WHERE venue_id IS NOT NULL) AS venue_id, COUNT(*)::int AS vote_count, ARRAY_AGG(u.name) AS voters
         FROM dm_venue_votes vv JOIN users u ON u.id = vv.user_id
         WHERE vv.user1_id = $1 AND vv.user2_id = $2
         GROUP BY venue_name ORDER BY vote_count DESC`,
        [user1, user2]
      );
      res.json({ votes: result.rows });
    } catch (err) {
      console.error('DM venue vote error:', err);
      res.status(500).json({ error: 'Failed to vote' });
    }
  }
);

// PUT /api/dm/:messageId/read - Mark a DM as read
router.put('/dm/:messageId/read', param('messageId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid message ID'), async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const messageId = parseInt(req.params.messageId);

    // A6 takedown: every OTHER read path on this table filters
    // `COALESCE(is_hidden, false) = false AND sender_deleted_at IS NULL` (the thread reads above, the socket
    // twin, the reply lookup). This one did not, and `RETURNING *` handed back
    // message_text, image_url and venue_data — so the recipient of a
    // moderator-hidden DM could re-read the taken-down content verbatim,
    // forever, using an id their client already held. A takedown that any
    // recipient can undo with a PUT is not a takedown.
    //
    // Both halves of the fix, because either alone leaves a gap: the predicate
    // stops hidden rows being touched at all, and the narrowed RETURNING means
    // a route whose entire job is "flip a boolean" can never be a content read
    // again. No caller reads anything but the ack (App.js calls this for live
    // arrivals while the thread is open; the ack is all it uses).
    const result = await pool.query(
      `UPDATE direct_messages SET read_status = TRUE
       WHERE id = $1 AND receiver_id = $2
         AND COALESCE(is_hidden, false) = false AND sender_deleted_at IS NULL
       RETURNING id, read_status`,
      [messageId, req.user.id]
    );

    if (result.rows.length === 0) {
      // Same answer for "no such message", "not yours" and "taken down" — the
      // status code must not tell a holder of the id which one it was.
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json({ message: result.rows[0] });
    pushBadgeSync(req.user.id).catch(() => {});
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Failed to mark message as read' });
  }
});

// GET /api/dm/:userId/pinned-venue - Get pinned venue for a DM conversation
router.get('/dm/:userId/pinned-venue', [param('userId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid user ID')], async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const otherUserId = parseInt(req.params.userId);
    // Mutual invisibility covers shared DM metadata reads, not just messages.
    if (await isBlockedBetween(req.user.id, otherUserId)) {
      return res.status(403).json({ error: 'You can no longer interact with this user.' });
    }
    // A banned counterpart too, for the reason the venue-votes read gives:
    // the pin and unpin writes refuse one through hasDmRelationship, and this
    // read could still serve a pin the banned account set, under their name.
    if (await counterpartyIsBanned(req.user.id, otherUserId)) {
      return res.status(403).json({ error: 'You can no longer interact with this user.' });
    }
    const { user1, user2 } = dmPairKey(req.user.id, otherUserId);
    const result = await pool.query(
      `SELECT venue_name, venue_address, venue_id, venue_rating, venue_photo_url, pinned_by, u.name AS pinned_by_name
       FROM dm_pinned_venues pv LEFT JOIN users u ON u.id = pv.pinned_by
       WHERE pv.user1_id = $1 AND pv.user2_id = $2`,
      [user1, user2]
    );
    res.json({ venue: result.rows[0] || null });
  } catch (err) {
    console.error('DM pinned venue error:', err);
    res.status(500).json({ error: 'Failed to get pinned venue' });
  }
});

// PUT /api/dm/:userId/pinned-venue - Pin or update a venue for a DM conversation
router.put('/dm/:userId/pinned-venue',
  [
    param('userId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid user ID'),
    body('venue_name').isString().withMessage('Venue name is required')
      .trim().isLength({ min: 1, max: 255 }).withMessage('Venue name is required'),
  ],
  async (req, res) => {
    try {
      // Unenforced before: a body with no venue_name reached
      // `stripHtml(undefined).slice(...)` and threw a TypeError out of the
      // handler, and a non-string reached the same call.
      if (rejectInvalid(req, res)) return;
      const otherUserId = parseInt(req.params.userId);
      if (await isBlockedBetween(req.user.id, otherUserId)) {
        return res.status(403).json({ error: 'You can no longer interact with this user.' });
      }
      // Same gate as the venue-vote route. dm_pinned_venues is an UPSERT on the
      // ordered pair, so an outsider writing here overwrites what those two
      // people pinned — the exact case sockets/handlers.js closed on its side.
      if (!(await hasDmRelationship(req.user.id, otherUserId))) {
        return res.status(403).json({ error: NOT_CONNECTED_MESSAGE });
      }
      const { user1, user2 } = dmPairKey(req.user.id, otherUserId);
      const venue_name = stripHtml(req.body.venue_name).slice(0, 255);
      const venue_address = req.body.venue_address ? stripHtml(String(req.body.venue_address)).slice(0, 512) : null;
      // Same screen + photo-proxy-only rule as venue cards (round 8).
      if (rejectIfProfane(res, venue_name)) return;
      if (venue_address && rejectIfProfane(res, venue_address)) return;
      const venue_id = typeof req.body.venue_id === 'string' ? req.body.venue_id.slice(0, 256) : null;
      // NUMERIC(2,1) and a five-star scale; see the socket twin.
      const venue_rating = Number.isFinite(req.body.venue_rating) && req.body.venue_rating >= 0 && req.body.venue_rating <= 5
        ? req.body.venue_rating : null;
      const venue_photo_url = safeVenuePhotoUrl(req.body.venue_photo_url);

      await pool.query(
        `INSERT INTO dm_pinned_venues (user1_id, user2_id, venue_name, venue_address, venue_id, venue_rating, venue_photo_url, pinned_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (user1_id, user2_id) DO UPDATE SET
           venue_name = EXCLUDED.venue_name, venue_address = EXCLUDED.venue_address, venue_id = EXCLUDED.venue_id,
           venue_rating = EXCLUDED.venue_rating, venue_photo_url = EXCLUDED.venue_photo_url,
           pinned_by = EXCLUDED.pinned_by, updated_at = NOW()`,
        [user1, user2, venue_name, venue_address, venue_id, venue_rating, venue_photo_url, req.user.id]
      );

      const venue = { venue_name, venue_address, venue_id, venue_rating, venue_photo_url, pinned_by: req.user.id };
      /* THE ANNOUNCEMENT IS IN THE SHAPE THE CLIENT ACTUALLY READS, which it
         was not. This emitted `{ userId, venue }` while sockets/handlers.js
         emits the fields FLAT alongside `withUserId`, and App.js's listener
         gates on `data.withUserId` and then reads `data.venue_name`. Against
         the nested payload that gate saw undefined, returned early, and the
         update was dropped. So the comment below was half right: this route
         told nobody, and adding an emit in a shape nothing parses did not
         change that.
         `withUserId` is the OTHER person from each recipient's point of view,
         which is why it differs per emit and cannot be one shared object. */
      const io = req.app.get('io');
      if (io) {
        io.to(`user:${otherUserId}`).emit('dm_venue_pinned', { ...venue, withUserId: req.user.id });
        io.to(`user:${req.user.id}`).emit('dm_venue_pinned', { ...venue, withUserId: otherUserId });
      }
      res.json({ venue });
    } catch (err) {
      console.error('DM pin venue error:', err);
      res.status(500).json({ error: 'Failed to pin venue' });
    }
  }
);

/* DELETE /api/dm/:userId/pinned-venue - take the pin down.
 *
 * WHY THIS DID NOT EXIST. dm_pinned_venues UPSERTS on the ordered pair, so a
 * pin could be REPLACED forever and never cleared: once a DM had a pinned
 * venue, that 36pt strip was in the conversation for good. DmDetail's own note
 * recorded the consequence honestly rather than papering over it: PinStrip
 * draws an Unpin item only when handed a callback, "there is no unpin anywhere
 * in this product", and "a menu item that cannot unpin is the dead control
 * DESIGN-STANDARD rule 5 bans, so it is not drawn". The screen was right; the door
 * was one-way.
 *
 * THE SAME GATES AS THE PUT, and for the same reasons. A blocked pair cannot
 * touch each other's thread, and the row is keyed on the PAIR rather than on
 * the pinner, so an outsider clearing it would be deleting what two other
 * people pinned. That is the case the socket side closed on its own.
 *
 * ANYONE IN THE PAIR MAY UNPIN, not only whoever pinned it, which is the rule
 * the flock's message pins already follow: a shared surface only its author
 * can clear is one somebody can fill and walk away from. A DM has two people
 * and the strip is in both their conversations.
 *
 * The delete is unconditional, so unpinning nothing is a 200 rather than a
 * 404. Two people tapping Unpin at once is the ordinary case, and the second
 * one has not made a mistake.
 */
router.delete('/dm/:userId/pinned-venue',
  [param('userId').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid user ID')],
  async (req, res) => {
    try {
      if (rejectInvalid(req, res)) return;
      const otherUserId = parseInt(req.params.userId);
      if (await isBlockedBetween(req.user.id, otherUserId)) {
        return res.status(403).json({ error: 'You can no longer interact with this user.' });
      }
      if (!(await hasDmRelationship(req.user.id, otherUserId))) {
        return res.status(403).json({ error: NOT_CONNECTED_MESSAGE });
      }
      const { user1, user2 } = dmPairKey(req.user.id, otherUserId);

      await pool.query(
        'DELETE FROM dm_pinned_venues WHERE user1_id = $1 AND user2_id = $2',
        [user1, user2]
      );

      /* THE SAME EVENT THE PIN USES, with venue_name null. A second event
         name would be a second thing every listener has to learn and a second
         place to forget, and the client already stores whatever this carries.
         A null name is the honest value for "there is no pinned venue" and is
         exactly what the history read returns for a pair that never pinned
         one, so the listener needs one branch rather than a new code path.
         Flat, with a per-recipient `withUserId`, for the reason spelled out on
         the PUT above: that is the shape App.js parses. */
      const io = req.app.get('io');
      if (io) {
        io.to(`user:${otherUserId}`).emit('dm_venue_pinned', { venue_name: null, withUserId: req.user.id });
        io.to(`user:${req.user.id}`).emit('dm_venue_pinned', { venue_name: null, withUserId: otherUserId });
      }
      res.json({ venue: null });
    } catch (err) {
      console.error('DM unpin venue error:', err);
      res.status(500).json({ error: 'Failed to unpin venue' });
    }
  }
);

module.exports = router;
// The pin list's per-member fan-out, for the one writer outside this file:
// routes/admin.js, when a moderator's takedown retires a pinned message.
// Attached to the router rather than moved, so every reader of the pin rules
// still finds them next to the pin routes.
module.exports.broadcastPins = broadcastPins;
