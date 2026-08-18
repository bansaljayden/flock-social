const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate, requireVerified, UNVERIFIED_MESSAGE } = require('../middleware/auth');
const { stripHtml } = require('../utils/sanitize');
const { rejectIfProfane } = require('../utils/moderation');
const { safeVenuePhotoUrl } = require('../utils/venuePayload');
// isBlockedBetween is NOT imported here any more: the two places in this file
// that asked the block question — flock creation and POST /:id/invite — both ask
// it once for a whole id set now, with the same bidirectional predicate written
// out inline. The helper is unchanged and keeps every other caller it has.
const { getInvisibleUserIds } = require('../utils/blocks');
const { GUEST_RSVP_SELECT, toGuestEntry, combineRsvpCounts } = require('../utils/guestRsvp');
const { createUserBudget } = require('../utils/probeBudget');
const { isPlaceIdShaped } = require('../utils/places');
const { emitToFlockExcludingBlocked, emitToFlockMembers } = require('../sockets/handlers');

const { pushIfOffline } = require('../services/pushHelper');

const router = express.Router();

// SERIAL primary/foreign keys are INT4 (migrations 000/001). express-validator
// `isInt()` with no bound accepts "9999999999", which then reaches the query and
// comes back a 500 ("integer out of range") instead of a clean 400 — the same
// class routesReliability.test.js pins for admin.js/venueDashboard.js, and the
// reason friends.js bounds user ids with MAX_USER_ID. Every :id/:flockId param
// below is bounded to this ceiling so a too-large id is a 400 before any query.
const INT4_MAX = 2147483647;

// ---------------------------------------------------------------------------
// Invite budget (audit 2026-08-14)
//
// POST /:id/invite took 25 arbitrary user ids per call from any accepted
// member, wrote a membership row for each, pushed a notification to each, and
// handed the caller back every target's display name. Nothing bounded it but
// the general 300/15min limiter, so one account could ring ~28,000 strangers'
// phones a day — and read the directory while doing it.
//
// 25/hour and 60/day of NEW invitations per inviter. A real flock is 3-15
// people; 25 in an hour already covers "I invited my whole group and then
// remembered six more", and 60 a day covers someone running several plans.
// Beyond that it is not planning, it is broadcast.
//
// Re-inviting someone who is already invited or already a member costs nothing
// (those calls are idempotent and reveal nothing), so normal UI behaviour —
// re-submitting the same list, tapping twice — never eats the allowance.
// ---------------------------------------------------------------------------
const inviteBudget = createUserBudget({ name: 'flock-invite', hourly: 25, daily: 60 });

// A flock is a plan, not a mailing list. This bounds the OTHER shape of the
// same abuse: one flock accumulating thousands of `invited` rows (and the push
// notification each one sends) across many callers or many days.
const MAX_FLOCK_MEMBERSHIPS = 50;

// The ROW count of a flock is bounded SEPARATELY, and by a different number
// (query-reliability round). MAX_FLOCK_MEMBERSHIPS counts only `invited` and
// `accepted` rows, deliberately — somebody who said no is not occupying the
// plan, so declining has to give the seat back. But a DECLINED row is still a
// row, and the two roster reads in this file (GET /:id's membersResult and GET
// /:id/members) return EVERY row for the flock, with no status filter and no
// LIMIT, each joined to `users` for a name and an avatar. So "invite 50, they
// all decline, invite 50 more" grew the roster payload forever without ever
// touching the seat ceiling — every roster load paying for it.
//
// This is the second ceiling, and it is charged ONLY when a brand-new
// membership row is created. Re-inviting somebody who declined re-uses their
// existing row, so it costs a seat and no row, and the person who changed their
// mind is never the one who gets refused.
//
// 200, not 50: the seat cap is what bounds the PLAN, and this only has to bound
// the TABLE. A flock that has churned its entire 50-person roster three times
// over is not a flock any more, and 200 rows is still a roster payload that
// fits in one response. A caller who hits it sees the same message as a full
// flock — the two are the same fact from the invitee's side ("there is no room
// for another person here"), and spelling them differently would tell an
// outsider how many people have declined.
const MAX_FLOCK_ROWS = 200;

// ---------------------------------------------------------------------------
// The home list needs a ceiling (query-reliability round)
//
// GET /api/flocks returns every flock the caller has ANY membership row in,
// with no LIMIT, and each row carries a budget-threshold subquery, a host-block
// EXISTS, two counts, and a member_previews subquery that runs its own
// per-member NOT EXISTS against user_blocks. That is roughly five correlated
// subqueries per flock, on the read the app issues every time it opens.
//
// Nothing bounded the row count. A user's own flocks grow slowly, but the list
// also contains INVITES — rows somebody else created — and the flock list is
// ordered by f.updated_at DESC, so a flood of fresh invites sorts to the top.
// Between the per-inviter budget (25/hour, 60/day) and MAX_FLOCK_ROWS that
// flood is already slow and expensive to produce, and 300 is far past any real
// account: the alternative was an unbounded response with unbounded subquery
// work behind it, which is the failure mode that actually costs a pool slot.
//
// BEHAVIOUR CHANGE, stated plainly: an account in more than 300 flocks sees the
// 300 most recently updated. There is no cursor on this route, so the rest are
// not reachable — which is the honest cost, and the reason the number is
// generous rather than tight.
const FLOCK_LIST_LIMIT = 300;

// ---------------------------------------------------------------------------
// Free text on a flock (audit 2026-08-14)
//
// Four fields on this router are free text a person types: `name`,
// `venue_name`, `venue_address` and `budget_context`. Every one of them is read
// back on surfaces this file does not own — the flock card, the roster header,
// the guest invite page, push notification bodies, the link preview, the venue
// dashboard's incoming-flocks list. Escaping at each of those is a promise that
// has to be kept N times and only has to be broken once, so the markup is
// stripped HERE, at the single point of entry, and the column holds text.
//
// The create route had `stripHtml` on the first three; PUT /:id had it on NONE,
// so a flock created clean could be renamed into stored markup one request
// later, and `budget_context` skipped it on both. This helper is the one
// spelling of the rule, applied identically on create and on update, so the two
// cannot drift apart again.
//
// The trailing trim matters: stripping `<b> </b>` leaves a single space, which
// satisfies isLength({ min: 1 }) while being a blank name. Sanitize, then trim,
// then measure — measuring the pre-sanitized string is how a 300-character
// value made of tags gets rejected while a real 300-character name that would
// overflow the column gets through.
//
// LENGTHS: flocks.name and flocks.venue_name are VARCHAR(255) (migration 000).
// Neither route bounded venue_name at all, so a 256-character venue name came
// back as a 500 (Postgres 22001) rather than a 400. venue_address is TEXT and
// so has no column ceiling of its own — 512 is not the column, it is the number
// the OTHER writer of these two columns already uses: sockets/handlers.js
// `select_venue` clamps venue_name to 255 and venue_address to 512 before the
// same UPDATE. Two writers, one pair of ceilings. (It clamps where these routes
// refuse, which is right for a transport with no response to refuse into.)
const NAME_MAX = 255;
const VENUE_NAME_MAX = 255;
const VENUE_ADDRESS_MAX = 512;
const BUDGET_CONTEXT_MAX = 100;

// SHAPE BEFORE CONTENT. express-validator's validators coerce before they test,
// and coercion hides shape: `{"venue_latitude": ["1.5"]}` passes isFloat()
// because validator.js stringifies a one-element array to "1.5", and
// `{"status": ["planning"]}` passes isIn() the same way. The value then stays an
// ARRAY in req.body — sanitizers leave non-strings alone — and node-postgres
// sends it as a Postgres array against a scalar column, so the request comes
// back a 500 ("column is of type character varying but expression is of type
// text[]") instead of a 400. Same trick walks straight past stripHtml, which
// returns non-strings untouched by design, so a non-scalar was ALSO a sanitizer
// bypass. This is the id-range guard's twin: settle the shape before anything
// else looks at the value, and let a bad shape be a 400 before any query.
//
// Arrays and objects only. null and undefined pass through to `.optional()` and
// the existing coercions, which already handle them.
const isScalar = (v) => v === undefined || v === null || typeof v !== 'object';
const scalarOnly = (chain, label) => chain.custom(isScalar).withMessage(`Invalid ${label}`);

// `shape → trim → strip markup → trim again`, as a reusable chain fragment.
const freeText = (chain, label) => scalarOnly(chain, label).trim().customSanitizer(stripHtml).trim();

// ---------------------------------------------------------------------------
// Unverified accounts and flock membership (audit 2026-08-14)
//
// middleware/auth.js states the rule: an unverified account may READ AND BE
// REACHED, BUT MUST NOT ACCUMULATE, and names flock membership as one of the
// three assets that make squatting somebody's email address worth doing. It
// enforces that with a deny list of method+path patterns — a backstop whose own
// comment says the routes "should each mount `requireVerified`" and that this
// table holds until they do. This file is one of the three; it now does.
//
// WHY BOTH. The deny list matches `POST /api/flocks/:id/join`. Rename that
// route to `/accept`, mount this router under a second prefix, or add a new way
// to become a member, and the pattern quietly stops matching while the routes
// keep working — the gate would fail silently and open. `requireVerified` on
// the route itself travels with the route.
//
// WHAT ABOUT THE TARGET OF AN INVITE — see the note above POST /:id/invite.
// ---------------------------------------------------------------------------

// All flock routes require authentication
router.use(authenticate);

// A validator chain is inert unless something reads its result. Six routes in
// this file declared `param('id').isInt()` and then never called
// validationResult, so `/api/flocks/abc/join` handed "abc" straight to
// Postgres: `invalid input syntax for type integer` came back as a 500 with a
// stack in the logs instead of a 400. Every route below now runs this gate, so
// an id is known to be a positive integer before it reaches a query.
function rejectInvalid(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({ error: errors.array()[0].msg || 'Invalid request' });
  return true;
}

// Flock ids are sequential integers, so "does flock 4193 exist?" is a question
// an outsider must not be able to answer. GET /:id already returns 404 to
// non-members; the mutating routes used to answer 403 ("only the creator can
// …") for a real flock and 404 for a made-up one, which made the whole table
// enumerable one request at a time. This collapses that distinction: unless
// you hold a membership row, every flock looks like it does not exist.
async function hasMembershipRow(flockId, userId) {
  const r = await pool.query(
    'SELECT 1 FROM flock_members WHERE flock_id = $1 AND user_id = $2',
    [flockId, userId]
  );
  return r.rows.length > 0;
}

// GET /api/flocks - Get all flocks the user belongs to
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT f.*,
              -- PRIVACY: budget_ceiling is MIN(submissions); below the 3-non-skip
              -- threshold it IS someone's exact budget. This aliased CASE
              -- overrides the f.* column in the result row (node-postgres keeps
              -- the last duplicate field), mirroring the budget-status gate.
              CASE WHEN (SELECT COUNT(*) FROM budget_submissions bs
                         WHERE bs.flock_id = f.id AND bs.skipped = false) >= 3
                   THEN f.budget_ceiling ELSE NULL END AS budget_ceiling,
              -- Blocks: the host's name is a name like any other. Withheld in
              -- SQL (free, versus a second round trip) rather than post-filtered;
              -- the client already falls back to "Unknown" for a host it cannot
              -- name. The flock itself stays visible — you are still in it.
              CASE WHEN EXISTS (
                SELECT 1 FROM user_blocks b
                WHERE (b.blocker_id = $1 AND b.blocked_id = f.creator_id)
                   OR (b.blocker_id = f.creator_id AND b.blocked_id = $1)
              ) THEN NULL ELSE u.name END AS creator_name,
              fm.status AS member_status,
              -- These were FIVE scalar subqueries doing the work of two, and are
              -- now two (query-reliability round, applied). going_count is
              -- member_count + guest_count, a SELECT list cannot reference its
              -- own output aliases, and Postgres does not deduplicate identical
              -- scalar subqueries — it executes each one. So the roster count
              -- ran twice and the guest count ran twice, per flock row, on the
              -- read the app issues every time it opens.
              --
              -- The "c" lateral below computes each ONCE; these three columns
              -- read it. going_count is now arithmetic on two values already in
              -- hand rather than two more index scans.
              --
              -- THE TWO COUNTS KEEP THEIR EXACT OLD SPELLING inside that
              -- lateral, and that is load-bearing, not laziness:
              -- __tests__/rosterBlocks.test.js and __tests__/queryReliability.test.js
              -- both assert that text in order to pin a DIFFERENT decision —
              -- these are plain, unfiltered COUNTs, and only member_previews,
              -- which carries names and faces, is block-filtered. Computing them
              -- in a different place must not read as counting different rows.
              --
              -- TYPES ARE UNCHANGED, deliberately: member_count stays an uncast
              -- bigint (node-postgres hands it to the client as a STRING, which
              -- is what it has always done), guest_count and going_count stay
              -- ::int. A performance fix is not a licence to change what the
              -- client receives.
              c.member_count,
              -- Guests RSVP from the share link and have no membership row, so
              -- they were invisible in every count the host saw. member_count
              -- keeps its old meaning (accounts); going_count is the number to
              -- put next to "going".
              c.guest_count,
              (c.member_count + c.guest_count)::int AS going_count,
              -- Blocks: member_previews carries a NAME and an AVATAR for up to
              -- four people, and had no block predicate at all — so a blocked
              -- user's face sat on the flock card of the person who blocked
              -- them, on the app's home list. Filtered IN SQL rather than after
              -- the fact because of the LIMIT 4: post-filtering would return
              -- three faces where four visible members exist.
              (SELECT json_agg(row_to_json(m) ORDER BY m.is_creator DESC, m.id)
                 FROM (
                   SELECT mu.id, mu.name, mu.profile_image_url, (mu.id = f.creator_id) AS is_creator
                   FROM flock_members mfm
                   JOIN users mu ON mu.id = mfm.user_id
                   WHERE mfm.flock_id = f.id AND mfm.status = 'accepted'
                     AND NOT EXISTS (
                       SELECT 1 FROM user_blocks b
                       WHERE (b.blocker_id = $1 AND b.blocked_id = mu.id)
                          OR (b.blocker_id = mu.id AND b.blocked_id = $1)
                     )
                   ORDER BY (mu.id = f.creator_id) DESC, mfm.id
                   LIMIT 4
                 ) m
              ) AS member_previews
       FROM flocks f
       JOIN flock_members fm ON fm.flock_id = f.id AND fm.user_id = $1
       JOIN users u ON u.id = f.creator_id
       -- The two counts, computed once per flock row and read three times above.
       -- LATERAL because both correlate on f.id; LEFT ... ON TRUE because an
       -- aggregate with no GROUP BY always produces exactly one row, so this can
       -- never drop a flock from the list or introduce a NULL count.
       LEFT JOIN LATERAL (
         SELECT (SELECT COUNT(*) FROM flock_members WHERE flock_id = f.id AND status = 'accepted') AS member_count,
                (SELECT COUNT(*) FROM guest_rsvps gr
                  WHERE gr.flock_id = f.id AND gr.status = 'in'
                    AND COALESCE(gr.is_hidden, false) = false)::int AS guest_count
       ) c ON TRUE
       ORDER BY f.updated_at DESC
       LIMIT $2`,
      [req.user.id, FLOCK_LIST_LIMIT]
    );

    // Non-accepted rows collapse to an invite card (round 3: the list was
    // still handing invitees f.*, coordinates, and member previews even
    // after the detail route got its minimal DTO)
    const flocks = result.rows.map((f) => {
      if (f.member_status === 'accepted') return f;
      return {
        id: f.id,
        name: f.name,
        venue_name: f.venue_name,
        event_time: f.event_time,
        creator_name: f.creator_name,
        member_count: f.member_count,
        guest_count: f.guest_count,
        going_count: f.going_count,
        member_status: f.member_status,
        invitePreview: true,
      };
    });
    res.json({ flocks });
  } catch (err) {
    console.error('Get flocks error:', err);
    res.status(500).json({ error: 'Failed to get flocks' });
  }
});

// POST /api/flocks - Create a new flock
router.post('/',
  // Creating a flock makes you its first accepted member — the exact asset the
  // unverified-account gate exists to withhold. Explicit here as well as in the
  // middleware deny list (see the note above `router.use(authenticate)`).
  requireVerified,
  [
    freeText(body('name'), 'flock name').isLength({ min: 1, max: NAME_MAX }).withMessage('Flock name is required'),
    freeText(body('venue_name').optional(), 'venue name').isLength({ max: VENUE_NAME_MAX }).withMessage('Venue name is too long'),
    freeText(body('venue_address').optional(), 'venue address').isLength({ max: VENUE_ADDRESS_MAX }).withMessage('Venue address is too long'),
    // Google place id shape (utils/places.js). flocks.venue_id is one of the
    // sources the known-venue check reads, and it used to accept any string of
    // any length, including one long enough to overflow the column.
    scalarOnly(body('venue_id').optional({ checkFalsy: true }), 'venue id').trim().custom(isPlaceIdShaped).withMessage('Invalid venue id'),
    scalarOnly(body('venue_latitude').optional(), 'latitude').isFloat(),
    scalarOnly(body('venue_longitude').optional(), 'longitude').isFloat(),
    scalarOnly(body('venue_rating').optional(), 'rating').isFloat(),
    scalarOnly(body('venue_photo_url').optional(), 'photo url').trim(),
    scalarOnly(body('event_time').optional(), 'event time').isISO8601().withMessage('Invalid event time'),
    body('invited_user_ids').optional().isArray({ max: 25 }).withMessage('invited_user_ids must be an array'),
    scalarOnly(body('budget_enabled').optional(), 'budget flag').isBoolean(),
    // Free text: it is shown to every member above the budget prompt, so it
    // gets the same treatment as the name (it was the one create-route text
    // field that skipped the sanitizer).
    freeText(body('budget_context').optional(), 'budget note').isLength({ max: BUDGET_CONTEXT_MAX }).withMessage('Budget note is too long'),
    scalarOnly(body('ghost_mode_enabled').optional(), 'ghost mode flag').isBoolean(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.error('[Flock Create] Validation error:', errors.array());
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { name, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, venue_photo_url, event_time, invited_user_ids, budget_enabled, budget_context, ghost_mode_enabled } = req.body;

      // UGC text filter on user-writable flock fields (Apple 1.2).
      if (rejectIfProfane(res, name)) return;
      if (budget_context && rejectIfProfane(res, budget_context)) return;
      if (venue_name && rejectIfProfane(res, venue_name)) return;
      if (venue_address && rejectIfProfane(res, venue_address)) return;
      // Photo URLs render as <img> for every member — proxy path only (round 8).
      const safePhotoUrl = safeVenuePhotoUrl(venue_photo_url);

      console.log('[Flock Create] User:', req.user.id, '| Name:', name, '| Venue:', venue_name || '(none)');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Create the flock
        const flockResult = await client.query(
          `INSERT INTO flocks (name, creator_id, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, venue_photo_url, event_time, budget_enabled, budget_context, ghost_mode_enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING *`,
          [name, req.user.id, venue_name || null, venue_address || null, venue_id || null, venue_latitude || null, venue_longitude || null, venue_rating || null, safePhotoUrl, event_time || null, !!budget_enabled, budget_context || null, budget_enabled ? !!ghost_mode_enabled : false]
        );

        const flock = flockResult.rows[0];
        console.log('[Flock Create] Flock created with id:', flock.id);

        // Add the creator as an accepted member
        await client.query(
          `INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted')`,
          [flock.id, req.user.id]
        );

        // Invite additional users if provided (parameterized, status = 'invited').
        // Mutual blocks hold here too — the standalone invite endpoint skips
        // blocked pairs, and creating a fresh flock must not be a way around it.
        // Creating a flock with invited_user_ids is the SAME action as POST
        // /:id/invite — a membership row and a push notification per id — so it
        // draws on the same budget. Budgeting only the standalone endpoint
        // would have left "create a throwaway flock, invite 25 strangers,
        // repeat" wide open, which is the cheaper version of the attack.
        const invitedUids = [];
        const seenInvitees = new Set();
        if (invited_user_ids && invited_user_ids.length > 0) {
          // Candidate pass — pure bookkeeping, no I/O. The budget is still
          // charged one unit per distinct id in the order they were submitted,
          // and exhaustion still stops the whole list rather than answering
          // per-id, so an exhausted caller cannot read "4193 exists, 4194 does
          // not" off the response.
          const candidates = [];
          for (const userId of invited_user_ids) {
            const uid = parseInt(userId, 10);
            // Round-2 audit: `Number.isFinite` alone let an id past Postgres's
            // INTEGER range through, and a fabricated id had no existence check
            // at all — the FK rejection rolled the whole transaction back, so
            // "did the create succeed?" answered "does user 91824 exist?" for
            // free, and cost the caller their flock either way.
            if (!Number.isInteger(uid) || uid < 1 || uid > 2147483647 || uid === req.user.id) continue;
            if (seenInvitees.has(uid)) continue;
            seenInvitees.add(uid);
            if (!inviteBudget.allow(req.user.id)) break;
            candidates.push(uid);
          }

          // The three checks below used to run PER INVITEE inside this
          // transaction — existence, block, insert — so a full 25-id create was
          // ~75 round trips held open across the flock's own INSERT, and the
          // block check borrowed a SECOND pool connection (isBlockedBetween
          // talks to the pool, not this client) while this one was busy. Both
          // are now one set-based query each against the same client.
          if (candidates.length > 0) {
            const realUsers = await client.query(
              'SELECT id FROM users WHERE id = ANY($1::int[])',
              [candidates]
            );
            const exists = new Set(realUsers.rows.map((r) => r.id));

            // Same bidirectional rule as utils/blocks.js, asked once.
            const blockRows = await client.query(
              `SELECT blocker_id, blocked_id FROM user_blocks
               WHERE (blocker_id = $1 AND blocked_id = ANY($2::int[]))
                  OR (blocked_id = $1 AND blocker_id = ANY($2::int[]))`,
              [req.user.id, candidates]
            );
            const blocked = new Set(
              blockRows.rows.map((r) => (r.blocker_id === req.user.id ? r.blocked_id : r.blocker_id))
            );

            for (const uid of candidates) {
              if (!exists.has(uid) || blocked.has(uid)) continue;
              invitedUids.push(uid);
            }

            if (invitedUids.length > 0) {
              await client.query(
                // $1::int is explicit on purpose: in INSERT ... SELECT (unlike
                // INSERT ... VALUES) Postgres does NOT infer a parameter's type
                // from the target column, so an uncast $1 resolves to text and
                // the insert fails on the integer column at runtime.
                `INSERT INTO flock_members (flock_id, user_id, status)
                 SELECT $1::int, t.uid, 'invited' FROM UNNEST($2::int[]) AS t(uid)
                 ON CONFLICT (flock_id, user_id) DO NOTHING`,
                [flock.id, invitedUids]
              );
            }
          }
          console.log('[Flock Create] Invited', invitedUids.length, 'users');
        }

        await client.query('COMMIT');
        console.log('[Flock Create] Success - flock id:', flock.id);

        // Notify invited users via socket (only the ones actually inserted —
        // blocked pairs were skipped above)
        if (invitedUids.length > 0) {
          const io = req.app.get('io');
          if (io) {
            for (const uid of invitedUids) {
              io.to(`user:${uid}`).emit('flock_invite_received', {
                flockId: flock.id,
                flockName: flock.name,
                invitedBy: { userId: req.user.id, name: req.user.name },
              });
            }
          }
        }

        // invited_user_ids echoes who actually got a row: with a budget in play
        // the list can be shorter than what was asked for, and a client that
        // assumes "everyone I listed" would show a member count nobody has.
        res.status(201).json({ flock, invited_user_ids: invitedUids });
      } catch (err) {
        // .catch: on a dead or reset connection ROLLBACK throws too, and an
        // unguarded await here would replace the REAL failure with a generic
        // connection error — the outer handler would log "Connection
        // terminated" instead of the constraint that actually broke.
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('[Flock Create] Error:', err.message);
      console.error('[Flock Create] Detail:', err.detail || 'none');
      res.status(500).json({ error: 'Failed to create flock' });
    }
  }
);

// GET /api/flocks/activity - Recent activity from user's flocks
router.get('/activity', async (req, res) => {
  try {
    // Blocks: every row here is "{name} did {thing}". Unfiltered, this feed
    // narrated a blocked user's movements to the person who blocked them — the
    // one surface where they'd keep showing up by name every time they joined
    // or declined anything in a shared flock. Both branches get the predicate:
    // the first names the CREATOR, the second names the member who responded.
    const result = await pool.query(
      `(
        SELECT 'created' AS action, f.creator_id AS user_id, u.name AS user_name,
               f.name AS flock_name, f.id AS flock_id, f.created_at AS happened_at
        FROM flocks f
        JOIN users u ON u.id = f.creator_id
        JOIN flock_members fm ON fm.flock_id = f.id AND fm.user_id = $1 AND fm.status = 'accepted'
        WHERE f.created_at > NOW() - INTERVAL '7 days'
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
            WHERE (b.blocker_id = $1 AND b.blocked_id = f.creator_id)
               OR (b.blocker_id = f.creator_id AND b.blocked_id = $1)
          )
      )
      UNION ALL
      (
        SELECT
          CASE WHEN fm2.status = 'accepted' THEN 'joined' ELSE 'declined' END AS action,
          fm2.user_id, u2.name AS user_name,
          f2.name AS flock_name, f2.id AS flock_id, fm2.joined_at AS happened_at
        FROM flock_members fm2
        JOIN users u2 ON u2.id = fm2.user_id
        JOIN flocks f2 ON f2.id = fm2.flock_id
        JOIN flock_members my ON my.flock_id = f2.id AND my.user_id = $1 AND my.status = 'accepted'
        WHERE fm2.user_id != $1
          AND fm2.joined_at > NOW() - INTERVAL '7 days'
          AND fm2.status IN ('accepted', 'declined')
          AND NOT EXISTS (
            SELECT 1 FROM user_blocks b
            WHERE (b.blocker_id = $1 AND b.blocked_id = fm2.user_id)
               OR (b.blocker_id = fm2.user_id AND b.blocked_id = $1)
          )
      )
      ORDER BY happened_at DESC
      LIMIT 20`,
      [req.user.id]
    );
    res.json({ activity: result.rows });
  } catch (err) {
    console.error('Get activity error:', err);
    res.status(500).json({ error: 'Failed to get activity' });
  }
});

// GET /api/flocks/history - Flocks the caller was an accepted member of that
// have finished, one way or the other: status IN ('completed', 'cancelled'),
// newest event first, capped at 50.
//
// Registered BEFORE /:id — Express matches in order, and "history" satisfies
// :id's pattern position, so the other order would answer this path with
// "Invalid flock ID".
//
// Shape note for the frontend being built against this in parallel: each entry
// is { id, name, status, event_time, venue_name, venue_address, venue_place_id,
// members: [{ id, name, profile_image_url }] }. venue_place_id is flocks.venue_id
// under the name the client-side venue code uses everywhere else.
//
// ONE roster subquery per flock via json_agg rather than a per-flock members
// query — the N+1 shape is the one GET / already refuses. Blocks are handled
// exactly the way GET /:id/members handles them: the aggregate carries the FULL
// accepted roster and the blocked members are filtered out here, per caller,
// with the same getInvisibleUserIds set. Two queries total.
router.get('/history', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT f.id, f.name, f.status, f.event_time, f.venue_name, f.venue_address,
              f.venue_id AS venue_place_id,
              (SELECT COALESCE(json_agg(json_build_object(
                        'id', hu.id,
                        'name', hu.name,
                        'profile_image_url', hu.profile_image_url)
                        ORDER BY hm.joined_at, hu.id), '[]'::json)
                 FROM flock_members hm
                 JOIN users hu ON hu.id = hm.user_id
                WHERE hm.flock_id = f.id AND hm.status = 'accepted') AS members
         FROM flocks f
         JOIN flock_members fm ON fm.flock_id = f.id AND fm.user_id = $1 AND fm.status = 'accepted'
        WHERE f.status IN ('completed', 'cancelled')
        ORDER BY f.event_time DESC NULLS LAST, f.id DESC
        LIMIT 50`,
      [req.user.id]
    );

    // Same block rule as GET /:id/members: the names and faces of blocked
    // users are withheld from the caller's copy of the roster.
    const invisible = new Set(await getInvisibleUserIds(req.user.id));
    const flocks = result.rows.map((f) => ({
      ...f,
      members: (f.members || []).filter((m) => !invisible.has(m.id)),
    }));

    res.json({ flocks });
  } catch (err) {
    console.error('Get flock history error:', err);
    res.status(500).json({ error: 'Failed to get flock history' });
  }
});

// GET /api/flocks/:id - Get a specific flock with members
router.get('/:id', param('id').isInt({ min: 1, max: INT4_MAX }), async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid flock ID' });
    }

    const flockId = req.params.id;

    // Verify user is a member
    const membership = await pool.query(
      'SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2',
      [flockId, req.user.id]
    );
    if (membership.rows.length === 0) {
      return res.status(404).json({ error: 'Flock not found' });
    }

    const flockResult = await pool.query(
      `SELECT f.*,
              CASE WHEN (SELECT COUNT(*) FROM budget_submissions bs
                         WHERE bs.flock_id = f.id AND bs.skipped = false) >= 3
                   THEN f.budget_ceiling ELSE NULL END AS budget_ceiling,
              -- Same host rule as the list route, and applied here so the
              -- invite-preview branch below (which returns before any roster
              -- filtering) is covered by it too.
              CASE WHEN EXISTS (
                SELECT 1 FROM user_blocks b
                WHERE (b.blocker_id = $2 AND b.blocked_id = f.creator_id)
                   OR (b.blocker_id = f.creator_id AND b.blocked_id = $2)
              ) THEN NULL ELSE u.name END AS creator_name
       FROM flocks f
       JOIN users u ON u.id = f.creator_id
       WHERE f.id = $1`,
      [flockId, req.user.id]
    );

    if (flockResult.rows.length === 0) {
      return res.status(404).json({ error: 'Flock not found' });
    }

    // Invited/declined users get a minimal invite card, not the full flock:
    // no member emails, reliability scores, attendance, budgets, or messages
    // (audit 2026-08-12 — membership-row existence is not acceptance).
    if (membership.rows[0].status !== 'accepted') {
      const inv = flockResult.rows[0];
      const cnt = await pool.query(
        `SELECT
           (SELECT COUNT(*) FROM flock_members WHERE flock_id = $1 AND status = 'accepted')::int AS n,
           (SELECT COUNT(*) FROM guest_rsvps WHERE flock_id = $1 AND status = 'in'
              AND COALESCE(is_hidden, false) = false)::int AS guests`,
        [flockId]
      );
      return res.json({
        flock: {
          id: inv.id,
          name: inv.name,
          venue_name: inv.venue_name,
          event_time: inv.event_time,
          creator_name: inv.creator_name,
          member_count: cnt.rows[0].n,
          // Counts only — an invitee still gets no names, guests included.
          guest_count: cnt.rows[0].guests,
          going_count: cnt.rows[0].n + cnt.rows[0].guests,
          member_status: membership.rows[0].status,
        },
        members: [],
        guests: [],
        invitePreview: true,
      });
    }

    const membersResult = await pool.query(
      `SELECT u.id, u.name, u.profile_image_url, u.reliability_score, fm.status, fm.attendance, fm.joined_at
       FROM flock_members fm
       JOIN users u ON u.id = fm.user_id
       WHERE fm.flock_id = $1
       ORDER BY fm.joined_at ASC`,
      [flockId]
    );

    // Guest-link RSVPs. Nothing in this file read this table before, so a guest
    // who answered the share link appeared NOWHERE for the host: not in the
    // roster, not in the counts, not in momentum. They come back as their own
    // array (tagged is_guest, string ids) rather than mixed into `members`,
    // where a guest id would leak into member-only, integer-keyed paths.
    const guestsResult = await pool.query(GUEST_RSVP_SELECT, [flockId]);
    const guests = guestsResult.rows.map(toGuestEntry);

    // ── Momentum Meter calculation ──
    const flock = flockResult.rows[0];
    const members = membersResult.rows;
    // Counts come from the FULL roster on purpose (see visibleMembers below).
    const counts = combineRsvpCounts(members, guests);
    const totalMembers = counts.total;
    const accepted = counts.accepted;   // members + guests who said yes
    const declined = counts.declined;
    const responded = counts.responded;

    let score = 0;

    // RSVP progress (0-30 pts) — based on response rate
    if (totalMembers > 0) {
      score += Math.round((responded / totalMembers) * 15); // responses
      score += Math.round((accepted / totalMembers) * 15);  // acceptances
    }

    // Venue set (20 pts)
    const hasVenue = flock.venue_name && flock.venue_name !== 'TBD';
    if (hasVenue) score += 20;

    // Venue votes cast (0-10 pts). Guests vote too (routes/guest.js), and the
    // denominator below now includes them, so counting only member voters would
    // have made every guest RSVP push this score DOWN. Hidden guests are
    // excluded here exactly as they are in routes/venues.js and routes/guest.js.
    const votesResult = await pool.query(
      'SELECT COUNT(DISTINCT user_id) AS voters FROM venue_votes WHERE flock_id = $1',
      [flockId]
    );
    const guestVotesResult = await pool.query(
      `SELECT COUNT(DISTINCT gv.guest_rsvp_id) AS voters
       FROM guest_votes gv
       JOIN guest_rsvps gr ON gr.id = gv.guest_rsvp_id
       WHERE gv.flock_id = $1 AND COALESCE(gr.is_hidden, false) = false`,
      [flockId]
    );
    const uniqueVoters =
      parseInt(votesResult.rows[0].voters || 0) + parseInt(guestVotesResult.rows[0].voters || 0);
    if (accepted > 0) {
      score += Math.min(10, Math.round((uniqueVoters / accepted) * 10));
    }

    // Event time set (10 pts)
    if (flock.event_time) score += 10;

    // Budget progress (0-20 pts, only if budget enabled)
    if (flock.budget_enabled) {
      const budgetResult = await pool.query(
        'SELECT COUNT(*) AS submissions FROM budget_submissions WHERE flock_id = $1',
        [flockId]
      );
      const submissions = parseInt(budgetResult.rows[0].submissions || 0);
      // Budget submissions are account-only — a guest has no way to submit one,
      // so the denominator stays members. Using the guest-inclusive `accepted`
      // here would make inviting guests look like budget regress.
      if (counts.memberAccepted > 0) {
        score += Math.min(10, Math.round((submissions / counts.memberAccepted) * 10));
      }
      if (flock.budget_locked) score += 10;
    } else {
      // No budget = auto-fill those 20 pts based on other signals
      score += 20;
    }

    // Flock confirmed (10 pts)
    if (flock.status === 'confirmed' || flock.status === 'locked') score += 10;

    // Cap at 100
    score = Math.min(100, score);

    // Map score to stage
    let stage;
    if (flock.status === 'completed') stage = 'complete';
    else if (score >= 85) stage = 'lets_go';
    else if (score >= 65) stage = 'locked_in';
    else if (score >= 40) stage = 'almost_there';
    else if (score >= 15) stage = 'building';
    else stage = 'idea';

    const momentum = {
      score, stage, accepted, totalMembers, responded, hasVenue,
      hasTime: !!flock.event_time, uniqueVoters,
      // Broken out so the UI can say "4 going (2 guests)" without re-deriving it.
      memberAccepted: counts.memberAccepted,
      guestsGoing: counts.guestsGoing,
      guestCount: counts.guestCount,
    };

    // Counts on the flock object itself, for the header/list surfaces that read
    // the flock row rather than the roster.
    flock.member_count = counts.memberAccepted;
    flock.guest_count = counts.guestsGoing;
    flock.going_count = counts.accepted;

    // Blocks: the roster is name + avatar + reliability score per member and had
    // no block filter, so blocking someone you share a flock with removed them
    // from your friends list and your DMs and left them sitting in the roster.
    //
    // Filtered HERE rather than in the query above because the counts and the
    // momentum score are derived from that roster: a SQL predicate would have
    // silently decremented "going" for the blocker only, so two people looking
    // at the same plan would read a different headcount and a different momentum
    // score — and the list route's member_count (a plain COUNT) would disagree
    // with the detail route's on the same screen. A head count is not identity;
    // the name and the face are, and those are what stop being served.
    const invisible = new Set(await getInvisibleUserIds(req.user.id));
    const visibleMembers = members.filter((m) => !invisible.has(m.id));

    res.json({
      flock,
      members: visibleMembers,
      guests,
      momentum,
    });
  } catch (err) {
    console.error('Get flock error:', err);
    res.status(500).json({ error: 'Failed to get flock' });
  }
});

// PUT /api/flocks/:id - Update a flock (creator only)
router.put('/:id',
  [
    param('id').isInt({ min: 1, max: INT4_MAX }),
    // Same sanitizer, same lengths, same order as POST / above. These three
    // used to be a bare `.trim()`: a flock created clean could be renamed into
    // stored markup one request later, and the column kept it. Rename is not a
    // weaker action than create, so it does not get a weaker filter.
    freeText(body('name').optional(), 'flock name').isLength({ min: 1, max: NAME_MAX }).withMessage('Flock name is required'),
    freeText(body('venue_name').optional(), 'venue name').isLength({ max: VENUE_NAME_MAX }).withMessage('Venue name is too long'),
    freeText(body('venue_address').optional(), 'venue address').isLength({ max: VENUE_ADDRESS_MAX }).withMessage('Venue address is too long'),
    // Google place id shape (utils/places.js). flocks.venue_id is one of the
    // sources the known-venue check reads, and it used to accept any string of
    // any length, including one long enough to overflow the column.
    scalarOnly(body('venue_id').optional({ checkFalsy: true }), 'venue id').trim().custom(isPlaceIdShaped).withMessage('Invalid venue id'),
    scalarOnly(body('venue_latitude').optional(), 'latitude').isFloat(),
    scalarOnly(body('venue_longitude').optional(), 'longitude').isFloat(),
    scalarOnly(body('venue_rating').optional(), 'rating').isFloat(),
    scalarOnly(body('venue_photo_url').optional(), 'photo url').trim(),
    scalarOnly(body('event_time').optional(), 'event time').isISO8601(),
    // isIn() coerces too — `{"status": ["planning"]}` passed it and then went
    // into the column as an array. scalarOnly settles that before isIn looks.
    scalarOnly(body('status').optional(), 'status').isIn(['planning', 'confirmed', 'completed', 'cancelled']),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = req.params.id;

      // Verify ownership
      const flock = await pool.query('SELECT creator_id FROM flocks WHERE id = $1', [flockId]);
      if (flock.rows.length === 0) {
        return res.status(404).json({ error: 'Flock not found' });
      }
      if (flock.rows[0].creator_id !== req.user.id) {
        // 403 here would confirm the flock is real to a total outsider walking
        // the id space (see hasMembershipRow). Members already know it exists.
        if (!(await hasMembershipRow(flockId, req.user.id))) {
          return res.status(404).json({ error: 'Flock not found' });
        }
        return res.status(403).json({ error: 'Only the creator can update this flock' });
      }

      const { name, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, venue_photo_url, event_time, status } = req.body;

      // Same UGC screen as creation — editing must not be a bypass (round 7).
      if (name && rejectIfProfane(res, name)) return;
      if (venue_name && rejectIfProfane(res, venue_name)) return;
      if (venue_address && rejectIfProfane(res, venue_address)) return;
      // Photo-proxy-only, same as creation (round 8).
      const safePhotoUrl = safeVenuePhotoUrl(venue_photo_url);

      const result = await pool.query(
        `UPDATE flocks
         SET name = COALESCE($1, name),
             venue_name = COALESCE($2, venue_name),
             venue_address = COALESCE($3, venue_address),
             venue_id = COALESCE($4, venue_id),
             venue_latitude = COALESCE($5, venue_latitude),
             venue_longitude = COALESCE($6, venue_longitude),
             venue_rating = COALESCE($7, venue_rating),
             venue_photo_url = COALESCE($8, venue_photo_url),
             event_time = COALESCE($9, event_time),
             status = COALESCE($10, status),
             updated_at = NOW()
         WHERE id = $11
         RETURNING *`,
        [name, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, safePhotoUrl, event_time, status, flockId]
      );

      // The ownership check above and this UPDATE are two statements, and the
      // row can go between them — a co-creator's DELETE, the creator's own
      // `leave` from a second device, an admin takedown. Everything below
      // assumed a row came back: `updated.name` on the fan-out payload threw a
      // TypeError into the outer catch (a 500 on a request that was merely
      // late), and with no socket attached the route answered 200 with
      // `{ flock: {} }` — reporting success for a write that matched nothing.
      // Same 404 the ownership check gives, which is also the honest answer:
      // by the time we finished, there was no such flock.
      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Flock not found' });
      }

      // Notify flock members of the update
      const io = req.app.get('io');
      const updated = result.rows[0];
      if (io) {
        // Block-aware per-member fan-out: this payload carries `updatedBy`, the
        // editor's NAME, so a room broadcast handed a blocked user's name
        // straight to the person who blocked them every time the plan changed.
        // Same helper the RSVP/leave events already use. Guarded: a fan-out
        // failure must not 500 an update that already committed.
        await emitToFlockExcludingBlocked(io, flockId, req.user.id, 'flock_updated', {
          flockId: parseInt(flockId),
          name: updated.name,
          venue_name: updated.venue_name,
          venue_address: updated.venue_address,
          venue_id: updated.venue_id,
          venue_latitude: updated.venue_latitude,
          venue_longitude: updated.venue_longitude,
          venue_rating: updated.venue_rating,
          venue_photo_url: updated.venue_photo_url,
          event_time: updated.event_time,
          status: updated.status,
          updatedBy: req.user.name,
        }).catch((e) => console.error('flock_updated fan-out failed:', e.message));
      }

      // Auto-populate research analytics on completion or cancellation
      if (status === 'completed' || status === 'cancelled') {
        try {
          const memberCount = await pool.query(
            "SELECT COUNT(*) AS cnt FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
            [flockId]
          );
          const budgetInfo = await pool.query(
            `SELECT COUNT(*) AS sub_count, COUNT(*) FILTER (WHERE skipped = true) AS skip_count
             FROM budget_submissions WHERE flock_id = $1`,
            [flockId]
          );
          const ff = updated;
          const minutesElapsed = Math.round((Date.now() - new Date(ff.created_at).getTime()) / 60000);

          let stallPoint = 'completed';
          if (status === 'cancelled') {
            const accepted = parseInt(memberCount.rows[0].cnt);
            if (accepted < 2) stallPoint = 'rsvp';
            else if (ff.budget_enabled && !ff.budget_locked) stallPoint = 'budget';
            else if (!ff.venue_name) stallPoint = 'venue';
            else stallPoint = 'confirmation';
          }

          await pool.query(
            `INSERT INTO research_analytics
              (flock_id, group_size, budget_enabled, budget_ceiling, submission_count, skip_count,
               flock_completed, venue_price_level_selected, time_to_confirmation, stall_point)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (flock_id) DO NOTHING`,
            [
              flockId,
              parseInt(memberCount.rows[0].cnt),
              ff.budget_enabled || false,
              ff.budget_ceiling ? parseFloat(ff.budget_ceiling) : null,
              parseInt(budgetInfo.rows[0].sub_count),
              parseInt(budgetInfo.rows[0].skip_count),
              status === 'completed',
              null,
              minutesElapsed,
              stallPoint,
            ]
          );
        } catch (analyticsErr) {
          console.error('Research analytics error (non-fatal):', analyticsErr.message);
        }
      }

      // PRIVACY: RETURNING * carries the raw budget_ceiling — apply the same
      // 3-submission threshold as every other surface before responding
      // (review round 3: an innocuous update was a fourth door to the value).
      const flockResponse = { ...result.rows[0] };
      if (flockResponse.budget_ceiling != null) {
        const thr = await pool.query(
          `SELECT COUNT(*)::int AS n FROM budget_submissions WHERE flock_id = $1 AND skipped = false`,
          [flockId]
        );
        if ((thr.rows[0]?.n || 0) < 3) flockResponse.budget_ceiling = null;
      }
      res.json({ flock: flockResponse });

      // Push "It's happening!" when flock is confirmed.
      //
      // AFTER the response, like routes/billing.js and routes/messages.js. The
      // update is already committed and nothing in the response depends on a
      // notification, so holding the request open on Firebase only ever made
      // the confirm button spin. services/firebaseService.js now caps each
      // attempt, so this could no longer hang forever, but a bounded wait for
      // something the caller is not waiting for is still the wrong shape.
      //
      // Its own try/catch, not the outer one: the response has been sent, so a
      // throw reaching the handler's catch would try to send a second one
      // (ERR_HTTP_HEADERS_SENT) instead of logging the real failure.
      if (status === 'confirmed') {
        try {
          const membersResult = await pool.query(
            "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2",
            [flockId, req.user.id]
          );
          const timeStr = updated.event_time ? new Date(updated.event_time).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
          // SLOP-AUDIT rule 1: this used to join the three parts on ' — ' and
          // land an em dash on a lock screen. Restructured rather than swapped
          // for another separator, because the parts are not a list: the venue
          // belongs to the plan, and the time is a second sentence. The
          // formatted time already contains a comma ("Fri, 7:00 PM"), so a
          // comma-joined version would have read as one long stutter.
          const where = [updated.name, updated.venue_name].filter(Boolean).join(' at ');
          const bodyText = [where, timeStr].filter(Boolean).join('. ');
          // Concurrent fan-out: a 20-member confirm was 20 sequential Firebase
          // round trips. allSettled so one member's failed delivery does not
          // abort the rest. (No actor id: this push names the flock, not a user.)
          await Promise.allSettled(
            membersResult.rows.map((m) => pushIfOffline(io, m.user_id,
              "It's happening!",
              bodyText,
              { type: 'flock_confirmed', flockId: String(flockId) }
            ))
          );
        } catch (pushErr) {
          console.error('Flock confirmed push error:', pushErr.message);
        }
      }
    } catch (err) {
      console.error('Update flock error:', err);
      // headersSent: everything after res.json above runs post-response, so a
      // failure there must not attempt a second write to a finished response.
      if (!res.headersSent) res.status(500).json({ error: 'Failed to update flock' });
    }
  }
);

// DELETE /api/flocks/:id - Delete a flock (creator only)
router.delete('/:id', param('id').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID'), async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const flockId = req.params.id;

    const flock = await pool.query('SELECT creator_id FROM flocks WHERE id = $1', [flockId]);
    if (flock.rows.length === 0) {
      return res.status(404).json({ error: 'Flock not found' });
    }
    if (flock.rows[0].creator_id !== req.user.id) {
      // Same existence-oracle rule as PUT — outsiders get 404, not 403.
      if (!(await hasMembershipRow(flockId, req.user.id))) {
        return res.status(404).json({ error: 'Flock not found' });
      }
      return res.status(403).json({ error: 'Only the creator can delete this flock' });
    }

    // Notify members before deleting
    const io = req.app.get('io');
    const nameResult = await pool.query('SELECT name FROM flocks WHERE id = $1', [flockId]);
    if (io) {
      // `deletedBy` is the deleter's NAME, so this needs the same block-aware
      // fan-out as every other actor-naming event. AWAITED, and deliberately
      // before the DELETE below: the helper reads flock_members to find its
      // recipients, and the delete CASCADEs those rows away — fire-and-forget
      // here would race the delete and reach nobody at all.
      await emitToFlockExcludingBlocked(io, flockId, req.user.id, 'flock_deleted', {
        flockId: parseInt(flockId), flockName: nameResult.rows[0]?.name, deletedBy: req.user.name,
      }).catch((e) => console.error('flock_deleted fan-out failed:', e.message));
    }

    const removed = await pool.query('DELETE FROM flocks WHERE id = $1', [flockId]);
    // Same two-statement window as PUT: the ownership check read a row that was
    // gone by the time this ran. Reporting "Flock deleted" for a DELETE that
    // matched nothing tells the caller their action landed when somebody else's
    // did, so it gets the same 404 the check itself would have given.
    if (removed.rowCount === 0) {
      return res.status(404).json({ error: 'Flock not found' });
    }
    res.json({ message: 'Flock deleted' });
  } catch (err) {
    console.error('Delete flock error:', err);
    res.status(500).json({ error: 'Failed to delete flock' });
  }
});

// POST /api/flocks/:id/invite-link — create (or return) the flock's shareable
// guest link. Any accepted member can share it; guests RSVP + vote from the
// link with no account (routes/guest.js). One active link per flock; calling
// with { regenerate: true } revokes the old one (kills a leaked link).
router.post('/:id/invite-link', requireVerified, param('id').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID'), async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const flockId = req.params.id;
    const member = await pool.query(
      "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
      [flockId, req.user.id]
    );
    if (member.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this flock' });
    }

    if (req.body?.regenerate) {
      await pool.query('UPDATE flock_invite_links SET revoked = true WHERE flock_id = $1', [flockId]);
    }

    const existing = await pool.query(
      'SELECT token FROM flock_invite_links WHERE flock_id = $1 AND revoked = false LIMIT 1',
      [flockId]
    );
    let token = existing.rows[0]?.token;
    if (!token) {
      const { newLinkToken } = require('./guest');
      token = newLinkToken();
      await pool.query(
        'INSERT INTO flock_invite_links (token, flock_id, created_by) VALUES ($1, $2, $3)',
        [token, flockId, req.user.id]
      );
    }

    const base = process.env.PUBLIC_WEB_URL || 'https://flock-app-w65m.vercel.app';
    res.json({ token, url: `${base}/i/${token}` });
  } catch (err) {
    console.error('Invite link error:', err);
    res.status(500).json({ error: 'Could not create invite link' });
  }
});

// POST /api/flocks/:id/join - Accept a flock invite
router.post('/:id/join', requireVerified, param('id').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID'), async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const flockId = req.params.id;

    // Access control: only users with an existing membership row (invited,
    // previously declined, or already accepted) may join. Without this check,
    // any authenticated user could add themselves to any flock by ID and read
    // its messages (IDOR).
    //
    // The membership lookup is also the existence check now. It used to run
    // AFTER a `SELECT id FROM flocks`, so an uninvited caller got 404 for a
    // made-up id and 403 for a real one — a two-response oracle that let
    // anyone map every flock id in the database. A membership row cannot
    // outlive its flock (FK, ON DELETE CASCADE), so no row means "not found"
    // for this caller either way.
    const membership = await pool.query(
      'SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2',
      [flockId, req.user.id]
    );
    if (membership.rows.length === 0) {
      return res.status(404).json({ error: 'Flock not found' });
    }

    // Flip membership to 'accepted'. Round 9: the UPDATE matched unconditionally,
    // so an already-accepted member could re-POST this route as often as they
    // liked and every call re-broadcast the join and re-pushed a notification to
    // the creator. `AND status <> 'accepted'` makes rowCount the record of a REAL
    // transition; a repeat is still a 200, it just stays silent.
    //
    // The EXISTS clause is the LAST line of the unverified-account gate, and
    // the only one written where the asset is actually minted. `requireVerified`
    // above and the middleware deny list both already refuse this request, so in
    // normal operation this predicate never decides anything. It is here because
    // "an unverified account is never an accepted member" should be a property
    // of the write, not a property of two middlewares both continuing to be
    // mounted: this is the one statement in the codebase that promotes anybody
    // to accepted membership (the only other 'accepted' write is the creator's
    // own row, on a route that is gated the same way), so guarding it makes the
    // invariant true no matter what happens upstream of it.
    //
    // IS NOT FALSE, not `= TRUE`: users.email_verified is NOT NULL in any real
    // database, and a hypothetical NULL must read as "not gated" for the same
    // reason isUnverified() in middleware/auth.js only trips on a literal false
    // — a fail-closed reading here would lock the whole user base out of joining
    // flocks the moment a fixture or a future SELECT omitted the column.
    const result = await pool.query(
      `UPDATE flock_members SET status = 'accepted', joined_at = NOW()
       WHERE flock_id = $1 AND user_id = $2 AND status <> 'accepted'
         AND EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.email_verified IS NOT FALSE)
       RETURNING *`,
      [flockId, req.user.id]
    );
    const transitioned = result.rowCount > 0;

    let member = result.rows[0];
    if (!transitioned) {
      const current = await pool.query(
        'SELECT * FROM flock_members WHERE flock_id = $1 AND user_id = $2',
        [flockId, req.user.id]
      );
      member = current.rows[0];
      // Before the guard above existed there was exactly one way to reach this
      // branch — the row was already 'accepted' — so returning it as a 200 was
      // right. Now a still-unaccepted row means the promotion was REFUSED, and
      // answering 200 with `{ member: { status: 'invited' } }` would tell the
      // client it had joined when it had not. A vanished row (they left between
      // the two queries) is the 404 every other route gives a non-member.
      if (!member) {
        return res.status(404).json({ error: 'Flock not found' });
      }
      if (member.status !== 'accepted') {
        return res.status(403).json({ error: UNVERIFIED_MESSAGE, emailVerificationRequired: true });
      }
    }

    if (transitioned) {
      // Notify flock members that someone joined
      const io = req.app.get('io');
      if (io) {
        // Per-member fan-out, not the `flock:{id}` room. A socket only joins
        // that room while the flock's screen is open, so the host — who is the
        // one waiting to hear "Bob is coming" and is almost never sitting on
        // that screen — never got this. Same fix, and the same reasoning, as
        // broadcastGuestRsvp in sockets/handlers.js: `user:{id}` is joined on
        // connect, so it is a superset of the flock room and still delivers
        // exactly once. Block-aware, so an accepted RSVP does not carry the
        // joiner's name and photo to someone who blocked them.
        emitToFlockExcludingBlocked(io, flockId, req.user.id, 'flock_invite_responded', {
          flockId: parseInt(flockId),
          userId: req.user.id,
          userName: req.user.name,
          userImage: req.user.profile_image_url || null,
          action: 'accepted',
        }).catch(() => {});
      }
    }

    res.json({ member });

    // Push notification to flock creator, AFTER the response. The membership row
    // is committed; the host learning about it is not something the joiner is
    // waiting on. Own try/catch so a Firebase failure cannot try to answer an
    // already-answered request.
    if (transitioned) {
      try {
        const io = req.app.get('io');
        const flockData = await pool.query('SELECT creator_id, name FROM flocks WHERE id = $1', [flockId]);
        if (flockData.rows.length > 0 && flockData.rows[0].creator_id !== req.user.id) {
          await pushIfOffline(io, flockData.rows[0].creator_id,
            `${req.user.name} is going!`,
            flockData.rows[0].name,
            { type: 'flock_rsvp', flockId: String(flockId), fromUserId: String(req.user.id) }
          );
        }
      } catch (pushErr) {
        console.error('Join flock push error:', pushErr.message);
      }
    }
  } catch (err) {
    console.error('Join flock error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to join flock' });
  }
});

// ---------------------------------------------------------------------------
// The invite rules, as ONE function (rerun round)
// ---------------------------------------------------------------------------
// POST /:id/invite and POST /:id/rerun both invite a set of users into a flock
// the caller is an accepted member of, and the rules are not allowed to drift
// apart: the seat and row ceilings, the per-inviter budget, the existence
// check, the block check, the declined-row reuse, and the notification fan-out
// are ONE policy with two doors. So the whole pipeline lives here, verbatim
// from the invite route it was lifted out of — every query keeps its exact
// spelling (fixture dispatchers and queryReliability.test.js match on the
// text), and the replay loop keeps its exact order of decisions.
//
// The caller has already established that `inviter` is an accepted member of
// `flockId` and that the flock exists; this function does everything after
// that. Returns { invited, throttled, full }:
//   invited   [{ user_id, user_name }] — the rows actually written
//   throttled the inviter's personal budget ran out mid-list
//   full      the flock ran out of seats, or of rows
// It never touches `res`; each route owns its own response shape.
async function inviteUsersToFlock({ io, inviter, flockId, flockName, userIds }) {
  // Bound the flock itself, not just the caller — on BOTH of its ceilings
  // (see MAX_FLOCK_MEMBERSHIPS and MAX_FLOCK_ROWS). `n` is the seats:
  // declined rows do not hold one, because someone who said no is not
  // occupying the plan. `total` is every row, declined included, because
  // every row is read back on every roster load. Soft caps: two invite calls
  // racing can overshoot either slightly, which is fine for a spam ceiling
  // and not worth a lock.
  //
  // ONE ROUND TRIP, and the shape is chosen so that `n` keeps the exact
  // spelling it has always had. Several fixture dispatchers outside this
  // rotation's files match the seat count on its literal SQL text; a
  // `COUNT(*) FILTER (...) AS n` rewrite would have been tidier to read and
  // would have silently handed those fixtures an undefined seat count —
  // turning `seatsLeft` into NaN and quietly deleting the cap in four test
  // files that never mention it. The total goes in front as a scalar
  // subquery so the seat count stays the last item and its text stays
  // contiguous. A fixture that models only `n` therefore keeps the seat cap
  // exactly as it was and simply reports no rows for the row cap, which is
  // the harmless direction for a ceiling being introduced.
  const rosterSize = await pool.query(
    // The inner table is aliased so nothing here reads as correlated: an
    // unaliased `flock_id` inside a subquery over the same table binds to the
    // INNER reference, which is what is wanted, but only a reader who knows
    // that can tell it apart from a correlation bug.
    `SELECT (SELECT COUNT(*)::int FROM flock_members fm_all WHERE fm_all.flock_id = $1) AS total,
            COUNT(*)::int AS n FROM flock_members WHERE flock_id = $1 AND status IN ('invited', 'accepted')`,
    [flockId]
  );
  let seatsLeft = MAX_FLOCK_MEMBERSHIPS - (rosterSize.rows[0]?.n || 0);
  let rowsLeft = MAX_FLOCK_ROWS - (rosterSize.rows[0]?.total || 0);
  if (seatsLeft <= 0) {
    // Nothing was consulted and nothing is written; the caller turns an empty
    // `invited` plus `full` into the same 400 the old early return sent.
    return { invited: [], throttled: false, full: true };
  }

  // ── THIS WAS AN N+1. IT IS BATCHED NOW (landed 2026-08-14) ─────────────
  //
  // What it used to be: per submitted id, up to FOUR round trips — the
  // membership lookup, the user lookup, isBlockedBetween (which talks to the
  // POOL, so it borrowed a SECOND connection while this request already held
  // one), and the write. Measured on the fixture harness at a 4ms simulated
  // round trip, 25 ids (the validator's cap):
  //
  //     before   103 queries   1594ms   25 extra pool checkouts
  //     after      7 queries    105ms    0 extra pool checkouts
  //
  // and the count is now FLAT: one invitee and twenty-five invitees issue
  // the same 7 (8 if the call both re-invites and invites, because the two
  // writes are separate statements). That flatness, not the absolute number,
  // is what __tests__/queryReliability.test.js pins — see the note there
  // about what replaced the old `countForMany === 103` ceiling.
  //
  // The shape is three set-based reads, copied from POST / above rather than
  // re-derived, then ONE replay loop over the candidates in submission
  // order, then at most two array writes:
  //
  //   SELECT user_id, status FROM flock_members WHERE flock_id = $1 AND user_id = ANY($2::int[])
  //   SELECT id, name FROM users WHERE id = ANY($1::int[])
  //   SELECT blocker_id, blocked_id FROM user_blocks ...   (verbatim from POST /)
  //
  // utils/blocks.js is UNCHANGED and isBlockedBetween keeps every other
  // caller it has. The set-based block query is the same rule asked once,
  // and it is deliberately the same TEXT as the one in POST / — two
  // spellings of one safety rule is how the drift bugs in this file start.
  //
  // NO ASSERTED BEHAVIOUR CHANGES. The replay loop below runs the same
  // decisions in the same order the per-id loop did: the free skip for the
  // already-invited and already-accepted, then the seat ceiling, then the
  // row ceiling, then the budget charge, then existence, then blocks. Both
  // ceilings are still decremented AS rows are taken, inside the loop, so
  // "the ceiling is charged as rows are created" still holds; the budget is
  // still charged before existence is consulted and still stops the whole
  // list, so the response still cannot be read as "4193 exists, 4194 does
  // not".
  //
  // TWO GATES SAY THE SAME THING ON PURPOSE. The already-invited and the
  // already-accepted are dropped both from `pending` (so they are never
  // looked up) and again at the top of the replay loop (so they can never be
  // charged or written). Removing either one alone changes no behaviour,
  // which is exactly why neither should be "tidied" away: the first is what
  // keeps a repeat invite free, the second is what keeps it correct.
  //
  // ATOMICITY, since the writes moved. This is still autocommit — there is
  // no transaction here and there never was — but it is now at most TWO
  // statements instead of up to fifty, so the window in which a request can
  // half-apply shrank by an order of magnitude. Both statements are
  // idempotent (`ON CONFLICT DO NOTHING`, and an UPDATE guarded on the
  // status it is replacing), so the client's retry is safe.
  //
  // WHY THE READS ARE NOT SLICED TO `inviteBudget.remaining()`. Two earlier
  // rotations wrote that they were, and it is not sound: the set of ids the
  // loop actually charges is not a prefix of the candidate list, because the
  // ROW ceiling skips a brand-new id WITHOUT charging it (`continue`, not
  // `break`) and a later re-invite is then charged after it. So a slice can
  // cut off an id the loop really does reach — e.g. one row left, ids
  // [new, new, declined], two units of allowance: the loop charges the first
  // and the third. The reads therefore cover every candidate that is not
  // already invited or accepted, which is at most 25 ids in one round trip
  // and is invisible from outside: nothing past an exhausted budget is ever
  // CONSULTED, which is the property that mattered. The one sound saving is
  // kept — an allowance of zero skips both reads entirely.
  const invited = [];
  let throttled = false; // ran out of personal allowance
  let full = false;      // ran out of seats, or of rows, in this flock

  // Candidate pass — pure bookkeeping, no I/O, same filters as before.
  // Duplicate ids in one call must not each buy a seat or a budget unit.
  const seen = new Set();
  const candidates = [];
  for (const userId of userIds) {
    const uid = parseInt(userId, 10);
    if (!Number.isInteger(uid) || uid < 1 || uid > INT4_MAX || uid === inviter.id) continue;
    if (seen.has(uid)) continue;
    seen.add(uid);
    candidates.push(uid);
  }

  // Read 1 — who already has a row here. Flock-scoped, tells the caller
  // nothing about the user directory, so it stays ahead of the budget: a
  // repeat invite is still free.
  const statusByUid = new Map();
  if (candidates.length > 0) {
    const existingRows = await pool.query(
      'SELECT user_id, status FROM flock_members WHERE flock_id = $1 AND user_id = ANY($2::int[])',
      [flockId, candidates]
    );
    for (const row of existingRows.rows) statusByUid.set(Number(row.user_id), row.status);
  }

  // Everyone who could still cost something. The already-invited and the
  // already-accepted are dropped here, exactly as the old loop's two free
  // `continue`s dropped them before it ever looked them up.
  const pending = candidates.filter((uid) => {
    const st = statusByUid.get(uid);
    if (st === 'accepted') { console.log('[Invite] User', uid, 'already accepted member, skipping'); return false; }
    if (st === 'invited') { console.log('[Invite] User', uid, 'already invited, skipping'); return false; }
    return true;
  });

  // Reads 2 and 3 — the directory and the block set, one round trip each.
  const allowance = inviteBudget.remaining(inviter.id);
  const names = new Map();
  const blocked = new Set();
  if (pending.length > 0 && Math.min(allowance.hourly, allowance.daily) > 0) {
    const userRows = await pool.query(
      'SELECT id, name FROM users WHERE id = ANY($1::int[])',
      [pending]
    );
    // `set`, not a truthiness test: a NULL display name is an EXISTING user,
    // and the per-id version pushed that null through to the response.
    for (const row of userRows.rows) names.set(Number(row.id), row.name);

    // Same bidirectional rule as utils/blocks.js, asked once. Verbatim from
    // POST / — do not respell it.
    const blockRows = await pool.query(
      `SELECT blocker_id, blocked_id FROM user_blocks
       WHERE (blocker_id = $1 AND blocked_id = ANY($2::int[]))
          OR (blocked_id = $1 AND blocker_id = ANY($2::int[]))`,
      [inviter.id, pending]
    );
    for (const row of blockRows.rows) {
      blocked.add(Number(row.blocker_id === inviter.id ? row.blocked_id : row.blocker_id));
    }
  }

  // The replay. Same order of decisions as the per-id loop, no I/O.
  const reinviteIds = [];
  const newIds = [];
  for (const uid of candidates) {
    const status = statusByUid.get(uid);
    if (status === 'accepted' || status === 'invited') continue;

    if (seatsLeft <= 0) { full = true; break; }

    // The ROW ceiling, charged only on a BRAND NEW row. `continue`, not
    // `break`, and that difference is the whole point: a flock can be out of
    // rows while it still has seats (50 seats, 200 rows, 150 of them
    // declines), and in exactly that state re-inviting somebody who declined
    // is the call that must still work — it re-uses their row and costs
    // nothing. Breaking here would refuse the one person the ceiling was
    // never aimed at.
    //
    // Before the budget charge, for the same reason as the seat check above:
    // a ceiling the caller can do nothing about must not also cost them
    // their allowance.
    if (status === undefined && rowsLeft <= 0) { full = true; continue; }

    // Charged BEFORE existence is consulted and stops the whole loop, so an
    // exhausted caller gets no per-id answers at all: the response cannot
    // be read as "id 4193 exists but id 4194 does not".
    if (!inviteBudget.allow(inviter.id)) { throttled = true; break; }

    if (!names.has(uid)) continue;

    // Blocked pairs never invite each other (round 3: filtering only the
    // socket notification still created the membership row)
    if (blocked.has(uid)) continue;

    seatsLeft -= 1;
    // A row is only spent when one is created. The re-invite branch writes
    // into a row that is already counted in `total`.
    if (status === undefined) rowsLeft -= 1;

    if (status === 'declined') {
      reinviteIds.push(uid);
      console.log('[Invite] Re-invited declined user', uid);
    } else {
      newIds.push(uid);
      console.log('[Invite] Invited new user', uid);
    }
    invited.push({ user_id: uid, user_name: names.get(uid) });
  }

  if (reinviteIds.length > 0) {
    // Re-invite.
    //
    // `AND status = 'declined'` is load-bearing. Without it this statement
    // has no predicate on the status it is overwriting, so if a target
    // ACCEPTED an invite between the read above and this write, the
    // re-invite DEMOTED an accepted member back to `invited` — silently
    // removing them from the roster, the chat, the votes and every count, on
    // a plan they had already joined. Batching WIDENS that window (the read
    // now happens once, at the top), which makes the clause more important,
    // not less: it is what makes the write safe to issue late.
    await pool.query(
      `UPDATE flock_members SET status = 'invited'
       WHERE flock_id = $1 AND user_id = ANY($2::int[]) AND status = 'declined'`,
      [flockId, reinviteIds]
    );
  }

  if (newIds.length > 0) {
    // New invites, one statement — the same UNNEST form POST / uses.
    //
    // ON CONFLICT DO NOTHING: two invite calls naming the same person at the
    // same moment raced UNIQUE(flock_id, user_id) into a 23505, and a
    // partially applied invite reported as a total failure is the worst of
    // both, because the client's only sane response (retry) then re-notifies
    // everyone it already reached.
    //
    // $1::int is explicit on purpose: in INSERT ... SELECT (unlike
    // INSERT ... VALUES) Postgres does NOT infer a parameter's type from the
    // target column, so an uncast $1 resolves to text and the insert fails on
    // the integer column at runtime.
    await pool.query(
      `INSERT INTO flock_members (flock_id, user_id, status)
       SELECT $1::int, t.uid, 'invited' FROM UNNEST($2::int[]) AS t(uid)
       ON CONFLICT (flock_id, user_id) DO NOTHING`,
      [flockId, newIds]
    );
  }

  // Notify invited users via socket
  if (invited.length > 0 && io) {
    for (const inv of invited) {
      io.to(`user:${inv.user_id}`).emit('flock_invite_received', {
        flockId,
        flockName,
        invitedBy: { userId: inviter.id, name: inviter.name },
      });
    }
    // `invitedBy` names the inviter, so the room broadcast leaked that
    // name to anyone in the flock who had blocked them. Per-member,
    // block-aware fan-out — and it also reaches members who are in the
    // app but not sitting on this flock's screen, who were never in the
    // room to begin with.
    await emitToFlockExcludingBlocked(io, flockId, inviter.id, 'flock_members_invited', {
      flockId,
      invitedBy: { userId: inviter.id, name: inviter.name },
      invitedUserIds: invited.map(i => i.user_id),
    }).catch((e) => console.error('flock_members_invited fan-out failed:', e.message));
  }

  return { invited, throttled, full };
}

// The offline-push half of an invite, AFTER the response. A 25-person invite
// was 25 Firebase round trips the inviter sat through before their own screen
// updated, and the rows were already written. Concurrent + allSettled so one
// failure does not abort the rest. fromUserId lets the block-gate suppress a
// push that names the inviter. Own try/catch: the response is gone by the time
// this runs, so nothing here may reach a route's outer handler and try to send
// a second one.
async function pushInvitesToOffline({ io, inviter, flockId, flockName, invited }) {
  if (invited.length === 0) return;
  try {
    if (io) {
      await Promise.allSettled(
        invited.map((inv) => pushIfOffline(io, inv.user_id,
          `${inviter.name} invited you to a flock`,
          flockName,
          { type: 'flock_invite', flockId: String(flockId), fromUserId: String(inviter.id) }
        ))
      );
    }
  } catch (pushErr) {
    console.error('[Invite] push error:', pushErr.message);
  }
}

// POST /api/flocks/:id/invite - Invite users to an existing flock
//
// ---------------------------------------------------------------------------
// The TARGET of an invite, and why it is not checked (audit 2026-08-14)
// ---------------------------------------------------------------------------
// The unverified-account gate is written against the ACTOR: `requireVerified`
// below stops an unverified account from inviting anyone. It says nothing about
// who is being invited, and that was raised as a hole — a verified user can
// invite an unverified account, so the invite path appears to hand out the
// membership the gate would have refused.
//
// It does not, and the distinction is worth writing down because it is the
// whole reason this route can stay friendly.
//
// An invite writes `status = 'invited'`. That is not membership. Every
// capability and every count in this backend keys on `status = 'accepted'`:
// flock chat (routes/messages.js), venue voting (routes/venues.js), budget
// submission and the anonymous ceiling (routes/budget.js), bill splits
// (routes/billing.js), the roster and member_count/going_count (this file), the
// live socket rooms and every fan-out (sockets/handlers.js), reliability
// scoring, mutual-flock friend suggestions, crowd alerts, stories audience. An
// `invited` row buys none of them. What it buys is the invite card — the flock
// name, venue, time and host name — plus a notification, which is precisely the
// "READ AND BE REACHED" half the gate deliberately allows.
//
// The only way an `invited` row becomes an `accepted` one is POST /:id/join,
// which the target must call themselves and which refuses them while they are
// unverified — in the middleware deny list, in `requireVerified` on that route,
// and in the UPDATE's own WHERE clause. So the row exists and does not count
// until they verify, which is exactly the shape we want.
//
// REFUSING the invite outright was the alternative and it is worse. A friend
// who signed up ten minutes ago and has not opened their mail yet is the normal
// case, not an attack; refusing would make them invisible to the person trying
// to plan with them, and the error would land on the inviter, who has done
// nothing wrong and cannot fix it. It would also leak the target's verification
// state to anyone who can guess an id — a fact about someone else's account
// that no caller is entitled to. Accepting the invite and letting it sit inert
// costs one row, tells the inviter nothing, and resolves itself the moment the
// target clicks the link they already have.
//
// This is the same shape routes/friends.js already has: a verified user may
// send a friend request TO an unverified account (a `pending` row), and the
// squatter can never accept it. Pending is not friendship; invited is not
// membership.
router.post('/:id/invite',
  // Inviting is a state-changing action on a flock the caller is a member of,
  // so it needs a verified actor for the same reason join and create do.
  requireVerified,
  [
    param('id').isInt({ min: 1, max: INT4_MAX }),
    body('user_ids').isArray({ min: 1, max: 25 }).withMessage('user_ids must be a non-empty array'),
  ],
  async (req, res) => {
    try {
      console.log('[Invite] Route hit — flock:', req.params.id, '| user_ids count:', Array.isArray(req.body?.user_ids) ? req.body.user_ids.length : 0);
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        console.log('[Invite] Validation error:', errors.array());
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = parseInt(req.params.id);
      const { user_ids } = req.body;

      // Verify the inviter is an accepted member
      const membership = await pool.query(
        "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
        [flockId, req.user.id]
      );
      if (membership.rows.length === 0) {
        return res.status(403).json({ error: 'You must be a member of this flock to invite others' });
      }

      const flockResult = await pool.query('SELECT id, name FROM flocks WHERE id = $1', [flockId]);
      if (flockResult.rows.length === 0) {
        return res.status(404).json({ error: 'Flock not found' });
      }

      // Everything from the roster ceilings to the socket fan-out is the
      // shared pipeline — see inviteUsersToFlock above. POST /:id/rerun runs
      // the same function, so the rules cannot drift between the two doors.
      const { invited, throttled, full } = await inviteUsersToFlock({
        io: req.app.get('io'),
        inviter: req.user,
        flockId,
        flockName: flockResult.rows[0].name,
        userIds: user_ids,
      });

      if (invited.length === 0 && full) {
        return res.status(400).json({ error: 'This flock already has as many people as it can hold' });
      }
      if (invited.length === 0 && throttled) {
        return res.status(429).json({ error: "You've invited a lot of people recently. Try again in a bit." });
      }

      res.json({
        message: `Invited ${invited.length} user(s)`,
        invited,
        ...(throttled ? { throttled: true } : {}),
        ...(full ? { full: true } : {}),
        flock: flockResult.rows[0],
      });

      // Offline pushes, after the response — shared with rerun for the same
      // reason as the pipeline above (see pushInvitesToOffline).
      await pushInvitesToOffline({
        io: req.app.get('io'),
        inviter: req.user,
        flockId,
        flockName: flockResult.rows[0].name,
        invited,
      });
    } catch (err) {
      console.error('[Invite] Error:', err.message, err.detail || '');
      if (!res.headersSent) res.status(500).json({ error: 'Failed to invite users' });
    }
  }
);

// POST /api/flocks/:id/rerun - "Do it again": clone a finished flock
//
// Any ACCEPTED member of a completed or cancelled flock can spin up a fresh
// one from it: same name, same venue fields, same budget settings, status
// 'planning', with every OTHER accepted member of the source invited to the
// new plan. The copied fields come out of our own flocks row, which was
// sanitized, profanity-screened and photo-proxied when it was written, so they
// are not re-screened here — this route accepts no free text of its own.
//
// event_time: POST / treats it as optional (a plan can exist before a time is
// picked), so this route does too — same validator, NULL when absent. The old
// flock's time is deliberately NOT copied: it is in the past, which is the one
// value a new plan can never want.
//
// requireVerified for the same reason POST / has it: creating a flock makes
// you its first accepted member, the exact asset the unverified-account gate
// withholds.
//
// The invites reuse inviteUsersToFlock — the SAME pipeline as POST /:id/invite,
// blocks, budget, ceilings and notifications included, not a re-derivation.
// That means a rerun draws on the caller's invite budget exactly like creating
// a flock with invited_user_ids does; a throttled or partially full result
// still returns the new flock, and the caller can invite the rest later.
//
// Response: the same shape POST / returns — 201 { flock, invited_user_ids } —
// so the client can navigate straight into the new flock.
router.post('/:id/rerun',
  requireVerified,
  [
    param('id').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID'),
    scalarOnly(body('event_time').optional(), 'event time').isISO8601().withMessage('Invalid event time'),
  ],
  async (req, res) => {
    try {
      if (rejectInvalid(req, res)) return;
      const sourceId = parseInt(req.params.id);
      const { event_time } = req.body;

      // Same existence-oracle rule as every other route here: no membership
      // row, no admission the flock exists. A member whose row never reached
      // 'accepted' (invited, declined) was not part of the plan and does not
      // get to replay it — but they already know it exists, so 403 is honest.
      const membership = await pool.query(
        'SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2',
        [sourceId, req.user.id]
      );
      if (membership.rows.length === 0) {
        return res.status(404).json({ error: 'Flock not found' });
      }
      if (membership.rows[0].status !== 'accepted') {
        return res.status(403).json({ error: 'Only members of this flock can run it again' });
      }

      const source = await pool.query(
        'SELECT name, status, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, venue_photo_url, budget_enabled, budget_context, ghost_mode_enabled FROM flocks WHERE id = $1',
        [sourceId]
      );
      if (source.rows.length === 0) {
        return res.status(404).json({ error: 'Flock not found' });
      }
      const src = source.rows[0];
      // A live plan is not rerun, it is continued. Only a finished one clones.
      if (src.status !== 'completed' && src.status !== 'cancelled') {
        return res.status(400).json({ error: 'Only a completed or cancelled flock can be run again' });
      }

      // Same transaction shape as POST /: the flock and its creator row land
      // together or not at all.
      const client = await pool.connect();
      let flock;
      try {
        await client.query('BEGIN');
        const flockResult = await client.query(
          `INSERT INTO flocks (name, creator_id, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, venue_photo_url, event_time, budget_enabled, budget_context, ghost_mode_enabled)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING *`,
          [src.name, req.user.id, src.venue_name, src.venue_address, src.venue_id, src.venue_latitude, src.venue_longitude, src.venue_rating, src.venue_photo_url, event_time || null, !!src.budget_enabled, src.budget_context, src.budget_enabled ? !!src.ghost_mode_enabled : false]
        );
        flock = flockResult.rows[0];
        await client.query(
          `INSERT INTO flock_members (flock_id, user_id, status) VALUES ($1, $2, 'accepted')`,
          [flock.id, req.user.id]
        );
        await client.query('COMMIT');
      } catch (txErr) {
        // Guarded for the same reason as POST /: a throwing ROLLBACK must not
        // swallow the error that caused it.
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
      console.log('[Rerun] Flock', sourceId, 'cloned as', flock.id, 'by user', req.user.id);

      // Everyone who was actually IN the old plan, except the caller — the
      // set the "do it again" button means. The shared pipeline re-applies
      // blocks and the rest, so a pair that blocked each other since the old
      // flock is not re-joined by replaying it.
      const prior = await pool.query(
        "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted' AND user_id != $2",
        [sourceId, req.user.id]
      );

      const io = req.app.get('io');
      const outcome = prior.rows.length > 0
        ? await inviteUsersToFlock({
            io,
            inviter: req.user,
            flockId: flock.id,
            flockName: flock.name,
            userIds: prior.rows.map((r) => r.user_id),
          })
        : { invited: [], throttled: false, full: false };

      // Same shape as POST /, and like POST / the id list is who actually got
      // a row — blocks or an exhausted budget can make it shorter than the
      // old roster, and the client must not display members nobody invited.
      res.status(201).json({ flock, invited_user_ids: outcome.invited.map((i) => i.user_id) });

      await pushInvitesToOffline({
        io,
        inviter: req.user,
        flockId: flock.id,
        flockName: flock.name,
        invited: outcome.invited,
      });
    } catch (err) {
      console.error('[Rerun] Error:', err.message, err.detail || '');
      if (!res.headersSent) res.status(500).json({ error: 'Failed to rerun flock' });
    }
  }
);

// POST /api/flocks/:id/decline - Decline a flock invite
router.post('/:id/decline', param('id').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID'), async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    console.log('[Decline] Route hit — flock:', req.params.id, '| user:', req.user.id);
    const flockId = parseInt(req.params.id);

    const result = await pool.query(
      `UPDATE flock_members SET status = 'declined'
       WHERE flock_id = $1 AND user_id = $2 AND status = 'invited'
       RETURNING *`,
      [flockId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No pending invite for this flock' });
    }

    // Notify flock members
    const io = req.app.get('io');
    if (io) {
      // Per-member fan-out for the same reason as the accept path above.
      emitToFlockExcludingBlocked(io, flockId, req.user.id, 'flock_invite_responded', {
        flockId,
        userId: req.user.id,
        userName: req.user.name,
        action: 'declined',
      }).catch(() => {});
    }

    res.json({ message: 'Invite declined' });
  } catch (err) {
    console.error('Decline flock error:', err);
    res.status(500).json({ error: 'Failed to decline invite' });
  }
});

// POST /api/flocks/:id/leave - Leave a flock
router.post('/:id/leave', param('id').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID'), async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const flockId = req.params.id;

    const flock = await pool.query('SELECT id, name, creator_id FROM flocks WHERE id = $1', [flockId]);
    if (flock.rows.length === 0) {
      return res.status(404).json({ error: 'Flock not found' });
    }

    const isCreator = flock.rows[0].creator_id === req.user.id;
    const flockName = flock.rows[0].name;

    // Round 5: without this, any authenticated user who guessed a flock id
    // could learn its name and broadcast fake departures that decrement every
    // member's displayed count. Non-members get the same 404 as a bad id.
    let wasAccepted = isCreator;
    if (!isCreator) {
      const mem = await pool.query(
        'SELECT status FROM flock_members WHERE flock_id = $1 AND user_id = $2',
        [flockId, req.user.id]
      );
      if (mem.rows.length === 0) {
        return res.status(404).json({ error: 'Flock not found' });
      }
      // An invitee who never accepted was never in the roster, but leaving
      // still broadcast `flock_member_left` — which every open client applies
      // to its own count. Anyone holding an invite could fire that at a flock
      // repeatedly and make the roster appear to drain. The row still goes
      // (declining by another name); only the departure event is now reserved
      // for someone who had actually joined.
      wasAccepted = mem.rows[0].status === 'accepted';
    }

    const io = req.app.get('io');

    if (isCreator) {
      // Notify all members before deleting. Block-aware (`deletedBy` is a name)
      // and awaited: the fan-out reads flock_members, which the DELETE on the
      // next line cascades away, so the read has to finish first.
      if (io) {
        await emitToFlockExcludingBlocked(io, flockId, req.user.id, 'flock_deleted', {
          flockId: parseInt(flockId), flockName, deletedBy: req.user.name,
        }).catch((e) => console.error('flock_deleted fan-out failed:', e.message));
      }
      // Creator leaving deletes the entire flock (cascade removes members, messages, votes)
      await pool.query('DELETE FROM flocks WHERE id = $1', [flockId]);
      if (io) io.socketsLeave(`flock:${flockId}`); // no ghost listeners on a dead room
      return res.json({ message: 'Left flock', flock_name: flockName, deleted: true });
    }

    // Notify flock that member left (accepted members only — see above).
    // Per-member fan-out, not the `flock:{id}` room: a member sitting anywhere
    // else in the app was never in that room and missed the count change. The
    // DELETE is below, so the leaver still holds their accepted row and the
    // roster read reaches the same set the room held. Guarded so a fan-out
    // failure cannot 500 a leave that is about to succeed.
    if (io && wasAccepted) {
      // Block-aware, because this payload carries the leaver's NAME. Per-member
      // fan-out reaches a blocker wherever they are in the app, where the old
      // room broadcast only reached one who happened to have the flock screen
      // open, so delivering it unfiltered would widen what a block leaks.
      await emitToFlockExcludingBlocked(io, flockId, req.user.id, 'flock_member_left', {
        flockId: parseInt(flockId), userId: req.user.id, userName: req.user.name,
      }).catch((e) => console.error('flock_member_left fan-out failed:', e.message));
    }

    // Remove member
    await pool.query(
      'DELETE FROM flock_members WHERE flock_id = $1 AND user_id = $2',
      [flockId, req.user.id]
    );

    // Revoke live room access (audit 2026-08-12): room auth is checked only at
    // join time, so without this a departed member's open sockets kept
    // receiving messages, locations, and votes until they disconnected.
    if (io) io.in(`user:${req.user.id}`).socketsLeave(`flock:${flockId}`);

    // If no accepted members remain, delete the flock
    const remaining = await pool.query(
      "SELECT COUNT(*) AS cnt FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
      [flockId]
    );

    const deleted = parseInt(remaining.rows[0].cnt) === 0;
    if (deleted) {
      await pool.query('DELETE FROM flocks WHERE id = $1', [flockId]);
    }

    res.json({ message: 'Left flock', flock_name: flockName, deleted });
  } catch (err) {
    console.error('Leave flock error:', err);
    res.status(500).json({ error: 'Failed to leave flock' });
  }
});

// GET /api/flocks/:id/members - Get members of a flock
router.get('/:id/members', param('id').isInt({ min: 1, max: INT4_MAX }).withMessage('Invalid flock ID'), async (req, res) => {
  try {
    if (rejectInvalid(req, res)) return;
    const flockId = req.params.id;

    // ACCEPTED members only see the roster (round 3: invitees got every
    // member's email from here). Email dropped from the payload entirely —
    // flockmates don't need each other's addresses.
    const membership = await pool.query(
      "SELECT id FROM flock_members WHERE flock_id = $1 AND user_id = $2 AND status = 'accepted'",
      [flockId, req.user.id]
    );
    if (membership.rows.length === 0) {
      return res.status(404).json({ error: 'Flock not found' });
    }

    const result = await pool.query(
      `SELECT u.id, u.name, u.profile_image_url, fm.status, fm.joined_at
       FROM flock_members fm
       JOIN users u ON u.id = fm.user_id
       WHERE fm.flock_id = $1
       ORDER BY fm.joined_at ASC`,
      [flockId]
    );

    // Same roster, same omission: guests were missing here too. Separate array,
    // so a caller that only wants accounts is unaffected.
    const guestsResult = await pool.query(GUEST_RSVP_SELECT, [flockId]);
    const guests = guestsResult.rows.map(toGuestEntry);

    // Blocks, same rule as GET /:id: the names and avatars of blocked users are
    // withheld, the head count is not. going_count is still computed from the
    // full roster so this route, GET /:id and the flock list all answer with the
    // same number of people.
    const invisible = new Set(await getInvisibleUserIds(req.user.id));

    res.json({
      members: result.rows.filter((m) => !invisible.has(m.id)),
      guests,
      going_count: result.rows.filter(m => m.status === 'accepted').length
        + guests.filter(g => g.status === 'accepted').length,
    });
  } catch (err) {
    console.error('Get members error:', err);
    res.status(500).json({ error: 'Failed to get members' });
  }
});

// POST /api/flocks/:id/attendance - Mark who attended (creator only, completed flocks)
router.post('/:id/attendance',
  [
    param('id').isInt({ min: 1, max: INT4_MAX }),
    body('attendance').isArray({ min: 1, max: 50 }).withMessage('Attendance array required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const flockId = req.params.id;
      const { attendance } = req.body;

      // Verify creator + completed status
      const flock = await pool.query('SELECT creator_id, status, name FROM flocks WHERE id = $1', [flockId]);
      if (flock.rows.length === 0) return res.status(404).json({ error: 'Flock not found' });
      if (flock.rows[0].creator_id !== req.user.id) {
        // Outsiders get 404 so this cannot be used to probe flock ids either.
        if (!(await hasMembershipRow(flockId, req.user.id))) {
          return res.status(404).json({ error: 'Flock not found' });
        }
        return res.status(403).json({ error: 'Only the creator can mark attendance' });
      }
      if (flock.rows[0].status !== 'completed') return res.status(400).json({ error: 'Flock must be completed to mark attendance' });

      const client = await pool.connect();
      const results = [];
      try {
        await client.query('BEGIN');

        // ── Why this is four statements and not 4N (query-reliability round) ──
        //
        // This block used to be one UPDATE per submitted entry, then THREE more
        // queries per affected member, every one of them on a checked-out pool
        // client with a transaction open. `attendance` is capped at 50, so the
        // worst case was ~200 sequential round trips holding one of roughly
        // twenty Railway pool slots for their entire duration — and holding row
        // locks on `users` the whole time, since the score writes are inside the
        // transaction. Two hosts marking two 50-person flocks at once occupied a
        // tenth of the pool between them for as long as the slowest round trip
        // chain took. That is not a slow endpoint, it is an availability risk.
        //
        // It is now a fixed four statements no matter how big the flock is. The
        // ARITHMETIC is deliberately left in JavaScript rather than moved into
        // SQL: `Math.round(x * 100) / 100` and Postgres ROUND() agree on these
        // values today, but reliability_score is DECIMAL(5,2) on a column real
        // users see, and a rounding difference introduced by a performance fix
        // would be invisible until someone's score moved by 0.01 for no reason.
        // One aggregate read, the same expression, one batched write.

        // userId went into an INTEGER column unparsed. A guest roster entry
        // ("guest:12", which is exactly what GET /:id hands the client) or any
        // other non-numeric value aborted the whole transaction, so one bad
        // element rolled back every other member's attendance and returned a
        // 500. Non-integers are skipped instead. Upper bound as well as lower:
        // an id past INT4 (still a positive integer) reaches the UPDATE below
        // and aborts the transaction with an out-of-range 500.
        //
        // A Map, so a duplicate userId in one payload resolves to the LAST
        // entry — which is exactly what the sequential UPDATEs did. A single
        // set-based UPDATE joined against duplicate keys would instead pick an
        // arbitrary one of them, so the dedupe has to happen here, not in SQL.
        const attendanceByUid = new Map();
        for (const entry of attendance) {
          const userId = parseInt(entry?.userId, 10);
          if (!Number.isInteger(userId) || userId <= 0 || userId > INT4_MAX) continue;
          attendanceByUid.set(userId, entry?.attended ? 'attended' : 'no_show');
        }

        if (attendanceByUid.size > 0) {
          await client.query(
            // Two spelling choices here, both deliberate:
            //
            // t(uid, mark), NOT t(user_id, attendance) — the SET target left of
            // the `=` is always the target table's column and cannot be
            // qualified, so an alias column of the same name reads as a shadow
            // to whoever edits this next. Different names, no question to ask.
            //
            // No `fm` alias on flock_members — the target table is spelled out
            // in the WHERE instead. That keeps the statement's opening literally
            // `UPDATE flock_members SET attendance`, which is what the fixture
            // dispatchers in __tests__/alertPreferences.test.js and
            // __tests__/pushRestDelivery.test.js match on. Aliasing it would
            // have red-tested four passing cases for a cosmetic reason.
            `UPDATE flock_members SET attendance = t.mark
             FROM UNNEST($1::int[], $2::text[]) AS t(uid, mark)
             WHERE flock_members.flock_id = $3
               AND flock_members.user_id = t.uid
               AND flock_members.status = 'accepted'`,
            [[...attendanceByUid.keys()], [...attendanceByUid.values()], flockId]
          );
        }

        // Recalculate reliability for each affected user. Scoped to ACCEPTED
        // members of THIS flock and deduped — unbounded arbitrary ids meant
        // query amplification + push spam to strangers (round 7).
        const memberRows = await client.query(
          "SELECT user_id FROM flock_members WHERE flock_id = $1 AND status = 'accepted'",
          [flockId]
        );
        const memberSet = new Set(memberRows.rows.map(r => r.user_id));
        // `a?.userId`, not `a.userId`. `body('attendance').isArray()` says
        // nothing about the ELEMENTS, so `{"attendance":[null]}` reached this
        // line and threw a TypeError — inside the transaction, so it rolled
        // back and answered 500 for a body the validator had accepted. The loop
        // above has always read the same field defensively; this one did not.
        const affectedUserIds = [...new Set(attendance.map(a => parseInt(a?.userId)).filter(id => Number.isFinite(id) && memberSet.has(id)))];

        if (affectedUserIds.length > 0) {
          // The two per-user COUNTs, asked once for the whole set.
          //
          // The predicates are NOT the same as each other and that is not an
          // oversight to tidy up while batching: `joined` requires
          // fm.status = 'accepted' AND an attendance that is not 'unmarked';
          // `attended` requires only attendance = 'attended'. Both require a
          // COMPLETED flock (numerator scoped like the denominator — counting a
          // live check-in on an active flock produced 200% scores, round 5).
          // Reproduced verbatim as FILTER clauses, because narrowing either one
          // silently moves every reliability score in the database.
          //
          // ── SOLO FLOCKS EARN NOTHING (self-credit audit) ──────────────────
          // Both counts additionally require the flock to have at least TWO
          // accepted members (mc.accepted_count >= 2). Without that bar the
          // score was self-serviceable at zero social cost, two ways:
          //   - create a flock at any venue with event_time = now, check in
          //     (routes/checkin.js markFlockAttendance pre-sets
          //     attendance = 'attended'), mark the flock completed, and mark
          //     attendance — the tally counted the solo flock and the score
          //     climbed with nobody else involved;
          //   - skip the check-in entirely: the creator of a completed solo
          //     flock can POST this very route naming themselves.
          // ">= 2 accepted members" is the app's existing evidence bar for a
          // real flock — routes/feedback.js VERIFIED_PRESENCE_SQL and the
          // venue-review gate both use it, for the same reason: a solo flock
          // is one free POST, so it certifies nothing. Requiring a second
          // ACCEPTED member moves the cost from one request to a second real,
          // email-verified account (middleware/auth.js UNVERIFIED_DENY blocks
          // flock create/join/invite until the email link is clicked).
          //
          // The bar is applied to the DENOMINATOR too, deliberately: a solo
          // flock must not count as "joined" either, or every solo plan would
          // read as a flake and drag honest scores down. A plan with no other
          // participants carries no social cost in either direction, so it is
          // invisible to the score in both.
          //
          // A creation-time-vs-event_time floor ("no coordination happened")
          // was considered and rejected: with the two-member bar an instant
          // solo flock already earns nothing, and a lead-time floor would rob
          // honest spontaneous groups — a "we're going out right now" flock a
          // real friend accepts minutes before leaving is exactly the
          // coordination this app exists for.
          //
          // LEFT JOINs so an affected user with no other rows still comes back
          // as a row with zeroes rather than vanishing from the result — a
          // missing row here would leave their old score in place instead of
          // clearing it, which the per-user loop never did. The member count
          // is a LATERAL for the same reason: it must never drop the t.uid row.
          const tally = await client.query(
            `SELECT t.uid,
                    COUNT(*) FILTER (
                      WHERE f.status = 'completed'
                        AND fm.status = 'accepted'
                        AND fm.attendance <> 'unmarked'
                        AND mc.accepted_count >= 2
                    )::int AS joined,
                    COUNT(*) FILTER (
                      WHERE f.status = 'completed'
                        AND fm.attendance = 'attended'
                        AND mc.accepted_count >= 2
                    )::int AS attended
             FROM UNNEST($1::int[]) AS t(uid)
             LEFT JOIN flock_members fm ON fm.user_id = t.uid
             LEFT JOIN flocks f ON f.id = fm.flock_id
             LEFT JOIN LATERAL (
               SELECT COUNT(*)::int AS accepted_count
               FROM flock_members m2
               WHERE m2.flock_id = fm.flock_id AND m2.status = 'accepted'
             ) mc ON TRUE
             GROUP BY t.uid`,
            [affectedUserIds]
          );
          const tallyByUid = new Map(tally.rows.map((r) => [r.uid, r]));

          const scores = [];
          const joinedCounts = [];
          const attendedCounts = [];
          for (const userId of affectedUserIds) {
            const row = tallyByUid.get(userId);
            const totalJoined = parseInt(row?.joined ?? 0);
            const totalAttended = parseInt(row?.attended ?? 0);
            const score = totalJoined > 0 ? Math.round((totalAttended / totalJoined) * 100 * 100) / 100 : null;
            scores.push(score);
            joinedCounts.push(totalJoined);
            attendedCounts.push(totalAttended);
            results.push({ userId, reliabilityScore: score, totalPlansJoined: totalJoined, totalPlansAttended: totalAttended });
          }

          // numeric[], because reliability_score is DECIMAL(5,2) and `score` is
          // null for a user with nothing completed — the per-user UPDATE wrote
          // that null too, and it means "no score yet", not zero.
          // Unaliased for the same reason as the UPDATE above: the opening stays
          // literally `UPDATE users SET reliability_score`.
          await client.query(
            `UPDATE users SET reliability_score = t.score,
                              total_plans_joined = t.joined,
                              total_plans_attended = t.attended
             FROM UNNEST($1::int[], $2::numeric[], $3::int[], $4::int[]) AS t(uid, score, joined, attended)
             WHERE users.id = t.uid`,
            [affectedUserIds, scores, joinedCounts, attendedCounts]
          );
        }

        await client.query('COMMIT');
      } catch (txErr) {
        // Guarded for the same reason as the create path: a throwing ROLLBACK
        // must not swallow the error that caused it.
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      // Socket notifications
      const io = req.app.get('io');
      if (io) {
        // Per-member fan-out so a member not on the flock screen still learns
        // attendance was recorded. Guarded (post-commit work must not 500 it).
        // Block-aware for the same reason as flock_member_left: this names
        // members and their scores, and per-member delivery would otherwise
        // carry it to someone who blocked the marker.
        //
        // ── WHAT THE ROOM IS TOLD, AND WHAT IT IS NOT (authz sweep) ─────────
        // This used to broadcast `results` verbatim, which carries
        // totalPlansJoined and totalPlansAttended — counts computed across
        // EVERY completed flock each person has ever been in. So marking one
        // evening's attendance told every member of this flock how many plans
        // each of the others has joined and shown up to app-wide, in groups
        // these recipients have no relationship to. reliability_score is a
        // different matter: it is already on this flock's roster (GET /:id
        // selects u.reliability_score), so re-sending it live tells nobody
        // anything a refresh would not, and withholding it would only make the
        // live update disagree with the screen underneath it.
        //
        // The counts still go to the person they belong to, on the
        // `reliability_updated` event below, and routes/users.js already serves
        // them the same three fields about themselves.
        //
        // The HTTP `results` above is deliberately UNCHANGED. It answers one
        // caller — the creator, about the write they just made — and its exact
        // shape is the contract __tests__/reliabilitySelfCredit.test.js and
        // __tests__/queryReliability.test.js pin. A broadcast to N people and a
        // reply to the one who acted are not the same disclosure, so they do
        // not have to carry the same payload.
        await emitToFlockExcludingBlocked(io, flockId, req.user.id, 'attendance_marked', {
          flockId: parseInt(flockId),
          attendance: results.map((r) => ({ userId: r.userId, reliabilityScore: r.reliabilityScore })),
        }).catch((e) => console.error('attendance_marked fan-out failed:', e.message));
        for (const r of results) {
          io.to(`user:${r.userId}`).emit('reliability_updated', {
            reliabilityScore: r.reliabilityScore,
            totalPlansJoined: r.totalPlansJoined,
            totalPlansAttended: r.totalPlansAttended,
          });
        }
      }

      res.json({ success: true, results });

      // Push to offline users, AFTER the response, for the same reason as the
      // confirm path above: the transaction has committed, `results` is already
      // in the client's hands, and nothing here can change it. Own try/catch so
      // a post-response throw cannot try to answer a finished request.
      //
      // Concurrent so a full flock is not one sequential Firebase round trip per
      // member; allSettled so one failure does not abort the rest. fromUserId
      // lets the block-gate suppress a push naming the person who marked
      // attendance. The body used to read "{flock} — your reliability score
      // updated"; SLOP-AUDIT rule 1 forbids the em dash, and the sentence reads
      // better as a sentence.
      try {
        await Promise.allSettled(
          results
            .filter((r) => r.userId !== req.user.id)
            .map((r) => pushIfOffline(io, r.userId,
              'Attendance recorded',
              `Your reliability score updated after ${flock.rows[0].name}.`,
              { type: 'attendance_marked', flockId: String(flockId), fromUserId: String(req.user.id) }
            ))
        );
      } catch (pushErr) {
        console.error('Attendance push error:', pushErr.message);
      }
    } catch (err) {
      console.error('Attendance error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to record attendance' });
    }
  }
);

module.exports = router;

// Test hook only — the invite budget is process-wide in-memory state, so a test
// suite needs a way to start each case from a clean allowance.
module.exports.__resetBudgets = () => { inviteBudget.reset(); };
