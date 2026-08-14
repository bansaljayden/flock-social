const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requireVenueTier, venueBillingEnabled } = require('../services/venueEntitlements');
const { rejectIfProfane } = require('../utils/moderation');
const { upstreamSignal } = require('../utils/upstream');
// Shape before content — see validators/shape.js. Nothing this router accepts
// is ever legitimately an array or an object, so every body field below is
// either scalarOnly (identifiers, numbers) or freeText (anything a person types
// that another person reads back).
const { scalarOnly, freeText } = require('../validators/shape');

const router = express.Router();
router.use(authenticate);

// Every :id here is a SERIAL, i.e. int4. `isInt()` with no ceiling let
// /promotions/99999999999999999999 satisfy the chain and reach Postgres, which
// answers 22003 "value out of range for type integer" — a 500 for what is
// plainly a 404. Same bound the other routers use (routes/messages.js et al).
const INT4_MAX = 2147483647;

// Paid-tier boundaries (VENUE-BILLING.md): promotions, events, the full
// incoming-flocks feed, the demand curve (/intelligence) and the competitive
// strip (/strip) are Insights ('premium') features. Server-enforced — the
// locked dashboard tabs are cosmetic. No-op until VENUE_BILLING_ENABLED.
//
// Tier assignment, from the VENUE-BILLING.md pricing table:
//   Free      = "Claimed profile, hours, logo, reviews + reply, 30-day
//                'groups considered you' count" — nothing model-powered.
//   Insights  = "Full incoming-flocks feed + history, demand curve,
//                promotions to nearby groups, events" — /intelligence IS the
//                demand curve, so it is premium by name.
//   Boost     = "Everything + promoted placement + slow-night push offers" —
//                advertising surfaces, not analytics.
// The competitive strip is named in NO row of that table (ambiguity flagged in
// the audit report). The conservative reading is to gate it rather than leave a
// headline paid analytic free; it is the same crowd model as the demand curve
// applied to the neighbours, so it sits with Insights, not with Boost's ad
// surfaces. Move it to 'pro' if the pricing table is ever made explicit.
const requirePremium = requireVenueTier('premium');

// The tiers that may have a paid benefit SERVED to end users on their behalf.
// Read at request time, never at claim/creation time: a venue that upgrades,
// creates promotions and then downgrades must stop being promoted.
const SERVING_TIERS = ['premium', 'pro'];

// Helper: get venue profile for current user
async function getVenueCtx(userId) {
  const { rows } = await pool.query(
    'SELECT id, google_place_id, verified FROM venue_profiles WHERE user_id = $1',
    [userId]
  );
  return rows[0] || null;
}

// ─── PROMOTIONS ──────────────────────────────────────────────────────────────

// GET /api/venue-dashboard/promotions
router.get('/promotions', async (req, res) => {
  try {
    const venue = await getVenueCtx(req.user.id);
    if (!venue) return res.json({ promotions: [] });

    // venue_promotions grows with usage and one owner can create arbitrarily
    // many over time — this list had no ceiling. A generous cap bounds the worst
    // case without hiding any realistic set.
    // Round 18: hidden promotions stay VISIBLE to their author, unlike reviews.
    // The asymmetry is the point. A hidden review is somebody else's words about
    // this owner and they have no business reading it after a takedown; a hidden
    // promotion is the owner's OWN copy, and silently dropping it from their
    // list would leave them staring at a promotion that vanished with no reason
    // given, re-creating it, and having that hidden too.
    //
    // But it must be MARKED, not just present. Before this the row came back
    // through `SELECT *` looking exactly like a live one, so the dashboard
    // showed a taken-down promotion as running while /public-promotions refused
    // to serve it to a single user. `hidden_by_moderation` is stated explicitly
    // rather than leaving the frontend to infer it from a raw `is_hidden`
    // column that a future SELECT list could quietly drop.
    const { rows } = await pool.query(
      'SELECT * FROM venue_promotions WHERE venue_user_id = $1 ORDER BY created_at DESC LIMIT 200',
      [req.user.id]
    );
    const promotions = rows.map((p) => ({ ...p, hidden_by_moderation: p.is_hidden === true }));
    res.json({ promotions });
  } catch (err) {
    console.error('Get promotions error:', err);
    res.status(500).json({ error: 'Failed to get promotions' });
  }
});

// POST /api/venue-dashboard/promotions
// Round 20 (shape sweep): all four fields are PUBLIC UGC — /public-promotions
// serves title, description, time_slot and days to every user looking at the
// venue card — and not one of them was passed through stripHtml. The array form
// made that worse rather than merely equal: `title: ["<b>x</b>"]` satisfies
// isLength by coercion, skips .trim() (a sanitizer returns a non-string
// untouched), and is answered allowed:true by rejectIfProfane, so the one screen
// this route did run was skipped as well. It then reached VARCHAR(255) as the
// Postgres literal `{"<b>x</b>"}`. freeText settles the shape first, strips the
// markup, and measures the length AFTER stripping.
router.post('/promotions', requirePremium, [
  freeText(body('title'), 'title').isLength({ min: 1, max: 80 }).withMessage('Title is required (max 80 characters)'),
  freeText(body('description').optional({ nullable: true }), 'description').isLength({ max: 300 }).withMessage('Description is too long (max 300 characters)'),
  freeText(body('timeSlot').optional({ nullable: true }), 'time slot').isLength({ max: 60 }).withMessage('Time slot is too long (max 60 characters)'),
  freeText(body('days').optional({ nullable: true }), 'days').isLength({ max: 60 }).withMessage('Days is too long (max 60 characters)'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    // Promotions are public UGC — same screen as every user-writable field.
    if (rejectIfProfane(res, req.body.title)) return;
    if (req.body.description && rejectIfProfane(res, req.body.description)) return;

    const venue = await getVenueCtx(req.user.id);
    if (!venue) return res.status(404).json({ error: 'No venue profile found' });

    const { title, description, timeSlot, days } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO venue_promotions (venue_user_id, google_place_id, title, description, time_slot, days)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.id, venue.google_place_id, title, description || null, timeSlot || null, days || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Create promotion error:', err);
    res.status(500).json({ error: 'Failed to create promotion' });
  }
});

// PUT /api/venue-dashboard/promotions/:id
// Same four public fields, same guard. `optional({ nullable: true })` rather
// than `optional()` throughout: express-validator 7 skips only `undefined`, and
// the handler below already reads a null as "leave this one alone" (`title ||
// null` feeding a COALESCE), so a client that spells "no change" as an explicit
// null was being answered 400 by the chain for a request the route knows how to
// serve.
router.put('/promotions/:id', requirePremium, [
  param('id').isInt({ min: 1, max: INT4_MAX }),
  freeText(body('title').optional({ nullable: true }), 'title').isLength({ min: 1, max: 80 }).withMessage('Title too long (max 80 characters)'),
  freeText(body('description').optional({ nullable: true }), 'description').isLength({ max: 300 }).withMessage('Description is too long (max 300 characters)'),
  freeText(body('timeSlot').optional({ nullable: true }), 'time slot').isLength({ max: 60 }).withMessage('Time slot is too long (max 60 characters)'),
  freeText(body('days').optional({ nullable: true }), 'days').isLength({ max: 60 }).withMessage('Days is too long (max 60 characters)'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    // Edits are the same public UGC surface as creation (round 8).
    if (req.body.title && rejectIfProfane(res, req.body.title)) return;
    if (req.body.description && rejectIfProfane(res, req.body.description)) return;

    // Round 18: an edit to a taken-down promotion is REFUSED, and refused by
    // name. The old statement happily updated a hidden row and answered 200 with
    // it, so the owner retitled a promotion, was told it saved, and it stayed
    // invisible to every user because /public-promotions filters is_hidden. An
    // endpoint that reports success for work the product then declines to honour
    // is worse than one that says no.
    //
    // Unlike the reply route, naming the takedown here leaks nothing: it is the
    // owner's own promotion, GET /promotions already returns it flagged, and
    // "why can I not edit this" has no other answer.
    //
    // One statement, not a SELECT-then-UPDATE: `target` names the row, the
    // UPDATE simply does not fire when it is hidden, and the outer SELECT still
    // returns a row whenever the promotion exists — so "not yours / gone" (0
    // rows) stays distinguishable from "taken down" (a row whose UPDATE half is
    // missing) with no window between the check and the write. Same shape as the
    // verify route in routes/admin.js.
    const { title, description, timeSlot, days } = req.body;
    const { rows } = await pool.query(
      `WITH target AS (
         SELECT id, COALESCE(is_hidden, false) AS is_hidden
         FROM venue_promotions WHERE id = $5 AND venue_user_id = $6
       ),
       upd AS (
         UPDATE venue_promotions SET
           title = COALESCE($1, title),
           description = COALESCE($2, description),
           time_slot = COALESCE($3, time_slot),
           days = COALESCE($4, days),
           updated_at = NOW()
         WHERE id = $5 AND venue_user_id = $6
           AND EXISTS (SELECT 1 FROM target t WHERE t.is_hidden = false)
         RETURNING *
       )
       SELECT t.is_hidden AS target_hidden, u.*
       FROM target t LEFT JOIN upd u ON true`,
      [title || null, description || null, timeSlot || null, days || null, req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Promotion not found' });
    const row = rows[0];
    // The refusal is read off the UPDATE, never off `target_hidden` alone: the
    // missing updated row IS the refusal, and nothing else can stop the write.
    if (row.id == null) {
      return res.status(409).json({
        // SLOP-AUDIT.md rule 5: this names only things that exist. Nothing in
        // the codebase emails a content author about a takedown, so an earlier
        // draft of this line ("reply to the moderation email") pointed at a
        // feature that has never been built. Delete and re-create both work on
        // a hidden row today, so that is what it says.
        error: 'This promotion was taken down by moderation and cannot be edited. Delete it and create a new one if you want to run something different.',
        code: 'CONTENT_HIDDEN',
      });
    }
    const { target_hidden: _targetHidden, ...promotion } = row;
    res.json(promotion);
  } catch (err) {
    console.error('Update promotion error:', err);
    res.status(500).json({ error: 'Failed to update promotion' });
  }
});

// DELETE /api/venue-dashboard/promotions/:id
router.delete('/promotions/:id', requirePremium, param('id').isInt({ min: 1, max: INT4_MAX }), async (req, res) => {
  try {
    // param('id').isInt() was declared but its result was never read, so a
    // non-numeric id (e.g. /promotions/abc) reached Postgres as a string and came
    // back a 500 instead of a 404 (same class as the PUT routes above already guard).
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(404).json({ error: 'Promotion not found' });
    const { rowCount } = await pool.query(
      'DELETE FROM venue_promotions WHERE id = $1 AND venue_user_id = $2',
      [req.params.id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Promotion not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete promotion error:', err);
    res.status(500).json({ error: 'Failed to delete promotion' });
  }
});

// ─── EVENTS ──────────────────────────────────────────────────────────────────

// GET /api/venue-dashboard/events
router.get('/events', async (req, res) => {
  try {
    const venue = await getVenueCtx(req.user.id);
    if (!venue) return res.json({ events: [] });

    // Same unbounded-growth cap as the promotions list above.
    const { rows } = await pool.query(
      'SELECT * FROM venue_events WHERE venue_user_id = $1 ORDER BY created_at DESC LIMIT 200',
      [req.user.id]
    );
    res.json({ events: rows });
  } catch (err) {
    console.error('Get events error:', err);
    res.status(500).json({ error: 'Failed to get events' });
  }
});

// POST /api/venue-dashboard/events
// Event titles are the same story as promotion titles: owner-typed, read back
// on the dashboard and (via venue_events) intended for the venue card, screened
// by rejectIfProfane and by nothing else. An array skipped even that.
//
// `capacity` had a second problem of its own. `isInt({ min: 1 })` has no
// ceiling, and the column is INTEGER — so `capacity: 3000000000` was a 22003
// from Postgres, a 500 for a plainly bad request. Bound it to int4 the same way
// the :id params are.
router.post('/events', requirePremium, [
  freeText(body('title'), 'title').isLength({ min: 1, max: 120 }).withMessage('Title is required (max 120 characters)'),
  freeText(body('eventDate').optional({ nullable: true }), 'event date').isLength({ max: 40 }).withMessage('Event date is too long (max 40 characters)'),
  freeText(body('eventTime').optional({ nullable: true }), 'event time').isLength({ max: 40 }).withMessage('Event time is too long (max 40 characters)'),
  scalarOnly(body('capacity').optional({ nullable: true }), 'capacity').isInt({ min: 1, max: INT4_MAX }).withMessage('Capacity must be a whole number of people'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    if (rejectIfProfane(res, req.body.title)) return;

    const venue = await getVenueCtx(req.user.id);
    if (!venue) return res.status(404).json({ error: 'No venue profile found' });

    const { title, eventDate, eventTime, capacity } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO venue_events (venue_user_id, google_place_id, title, event_date, event_time, capacity)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.id, venue.google_place_id, title, eventDate || null, eventTime || null, capacity || 50]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Create event error:', err);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// PUT /api/venue-dashboard/events/:id
router.put('/events/:id', requirePremium, [
  param('id').isInt({ min: 1, max: INT4_MAX }),
  freeText(body('title').optional({ nullable: true }), 'title').isLength({ min: 1, max: 120 }).withMessage('Title too long (max 120 characters)'),
  freeText(body('eventDate').optional({ nullable: true }), 'event date').isLength({ max: 40 }).withMessage('Event date is too long (max 40 characters)'),
  freeText(body('eventTime').optional({ nullable: true }), 'event time').isLength({ max: 40 }).withMessage('Event time is too long (max 40 characters)'),
  scalarOnly(body('capacity').optional({ nullable: true }), 'capacity').isInt({ min: 1, max: INT4_MAX }).withMessage('Capacity must be a whole number of people'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    if (req.body.title && rejectIfProfane(res, req.body.title)) return;

    const { title, eventDate, eventTime, capacity } = req.body;
    const { rows } = await pool.query(
      `UPDATE venue_events SET
        title = COALESCE($1, title),
        event_date = COALESCE($2, event_date),
        event_time = COALESCE($3, event_time),
        capacity = COALESCE($4, capacity),
        updated_at = NOW()
      WHERE id = $5 AND venue_user_id = $6 RETURNING *`,
      [title || null, eventDate || null, eventTime || null, capacity || null, req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Update event error:', err);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// DELETE /api/venue-dashboard/events/:id
router.delete('/events/:id', requirePremium, param('id').isInt({ min: 1, max: INT4_MAX }), async (req, res) => {
  try {
    // Same unenforced validator as the promotions DELETE: read it so a
    // non-numeric id is a 404 rather than a Postgres 500.
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(404).json({ error: 'Event not found' });
    const { rowCount } = await pool.query(
      'DELETE FROM venue_events WHERE id = $1 AND venue_user_id = $2',
      [req.params.id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Event not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete event error:', err);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// ─── INCOMING FLOCKS ─────────────────────────────────────────────────────────

// GET /api/venue-dashboard/incoming-flocks — flocks that selected this venue
router.get('/incoming-flocks', requirePremium, async (req, res) => {
  try {
    const venue = await getVenueCtx(req.user.id);
    if (!venue || !venue.google_place_id) return res.json({ flocks: [] });
    // Verified claims only (round 3): an unverified claim on an arbitrary
    // place id must not expose which groups are privately considering it.
    // getVenueCtx already selected `verified` — the second SELECT this used to
    // run against the same row was a duplicate read, not a second opinion.
    if (!venue.verified) return res.json({ flocks: [], unverified: true });

    // Find flocks where venue_votes reference this venue's place_id (venue_id column)
    const { rows } = await pool.query(
      `SELECT DISTINCT f.id, f.name AS title, f.event_time, f.status,
              (SELECT COUNT(*) FROM flock_members fm WHERE fm.flock_id = f.id AND fm.status = 'accepted') AS member_count
       FROM flocks f
       JOIN venue_votes vv ON vv.flock_id = f.id
       WHERE vv.venue_id = $1
         AND (f.status IS NULL OR f.status IN ('active', 'confirmed'))
       ORDER BY f.event_time DESC NULLS LAST
       LIMIT 20`,
      [venue.google_place_id]
    );
    res.json({ flocks: rows });
  } catch (err) {
    console.error('Get incoming flocks error:', err);
    res.status(500).json({ error: 'Failed to get incoming flocks' });
  }
});

// ─── REVIEWS ─────────────────────────────────────────────────────────────────

// Reviews are unbounded user-generated rows. Both review routes below used to
// SELECT the whole set (or a 50-row window) and reduce it in JavaScript, so the
// response grew without limit and the numbers drifted from the truth. The stats
// are computed by Postgres over EVERY row now, and the row list is a page.
const REVIEW_PAGE_DEFAULT = 50;
const REVIEW_PAGE_MAX = 100;
function reviewPageSize(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) return REVIEW_PAGE_DEFAULT;
  return Math.min(n, REVIEW_PAGE_MAX);
}

// GET /api/venue-dashboard/reviews — get Flock reviews for this venue
router.get('/reviews', async (req, res) => {
  try {
    const venue = await getVenueCtx(req.user.id);
    if (!venue || !venue.google_place_id) return res.json({ reviews: [], stats: null });

    const limit = reviewPageSize(req.query.limit);

    // Aggregates in SQL over the full set. Loading every review ever written
    // just to average five integers meant the dashboard's memory and payload
    // grew with the venue's popularity, and one busy venue could return tens of
    // thousands of rows including full review text.
    const statsResult = await pool.query(
      // Same JOIN as the list below, so the two can never disagree about which
      // rows count (venue_reviews.user_id is nullable; the join is the rule).
      // Round 18: `AND COALESCE(vr.is_hidden, false) = false`, the same
      // predicate /public-reviews has carried since the takedown shipped. The
      // owner tab ignored takedowns entirely, in both queries. Two consequences,
      // and the second is the worse one:
      //   * a review taken down FOR HARASSING THIS OWNER was still served to
      //     them in full text, so moderation removed it from everyone except
      //     the person it was aimed at;
      //   * the hidden row still moved the average and the star distribution the
      //     owner sees, so the owner's number permanently disagreed with the
      //     public one and there was nothing on the screen to explain the gap.
      `SELECT COUNT(*)::int AS total,
              AVG(vr.rating)::float AS average,
              COUNT(*) FILTER (WHERE vr.rating = 1)::int AS r1,
              COUNT(*) FILTER (WHERE vr.rating = 2)::int AS r2,
              COUNT(*) FILTER (WHERE vr.rating = 3)::int AS r3,
              COUNT(*) FILTER (WHERE vr.rating = 4)::int AS r4,
              COUNT(*) FILTER (WHERE vr.rating = 5)::int AS r5
       FROM venue_reviews vr
       JOIN users u ON u.id = vr.user_id
       WHERE vr.google_place_id = $1
         AND COALESCE(vr.is_hidden, false) = false`,
      [venue.google_place_id]
    );
    const s = statsResult.rows[0] || {};
    const total = s.total || 0;

    const { rows } = await pool.query(
      // Same visibility predicate as the stats above, for the same reason the
      // JOIN is duplicated: the two must never disagree about which rows count.
      `SELECT vr.*, u.name, u.profile_image_url
       FROM venue_reviews vr
       JOIN users u ON u.id = vr.user_id
       WHERE vr.google_place_id = $1
         AND COALESCE(vr.is_hidden, false) = false
       ORDER BY vr.created_at DESC
       LIMIT $2`,
      [venue.google_place_id, limit]
    );

    res.json({
      reviews: rows,
      stats: {
        // Rounded the same way the old .toFixed(1) rounded, so the displayed
        // number does not move for venues that already had fewer than 50.
        average: total > 0 ? parseFloat(Number(s.average).toFixed(1)) : 0,
        total,
        distribution: [s.r1 || 0, s.r2 || 0, s.r3 || 0, s.r4 || 0, s.r5 || 0],
      },
      // The list is a page now; `total` above is the real count.
      hasMore: total > rows.length,
    });
  } catch (err) {
    console.error('Get reviews error:', err);
    res.status(500).json({ error: 'Failed to get reviews' });
  }
});

// POST /api/venue-dashboard/reviews/:id/reply — venue owner replies to a review
// `reply` is the single most publicly-visible string this router writes: it
// rides the verified badge on the venue card in /public-reviews, addressed to
// every user who reads that venue's reviews. It had no stripHtml, and
// `reply: ["<img src=x onerror=…>"]` also walked past the rejectIfProfane call
// two lines below — the only screen it had.
router.post('/reviews/:id/reply', [
  param('id').isInt({ min: 1, max: INT4_MAX }),
  freeText(body('reply'), 'reply').isLength({ min: 1, max: 1000 }).withMessage('Reply is required (max 1000 characters)'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    // Round 5: only the VERIFIED claim holder speaks as the business. An
    // unverified claim on the same place id must never write a reply that
    // later rides the legitimate owner's verified badge.
    const venue = await getVenueCtx(req.user.id);
    if (!venue) return res.status(403).json({ error: 'Not a venue owner' });
    if (!venue.verified) return res.status(403).json({ error: 'Replies unlock once your venue is verified' });
    if (rejectIfProfane(res, req.body.reply)) return;

    // Round 18: a hidden review is not repliable, and `RETURNING *` on one was
    // the worst leak of the three on this file. The route had no is_hidden
    // predicate at all, so an owner holding an id their client cached before the
    // takedown could POST a one-character reply and get the full row back —
    // rating, text, author — reading taken-down content straight through a write
    // endpoint. Writing the reply was itself a bypass: replies ride the verified
    // badge on the public card, so it attached business speech to a review
    // moderation had removed.
    //
    // 404 rather than a named refusal, and that is the deliberate answer: the
    // GET above no longer lists hidden reviews, so from this owner's side the
    // review genuinely is not there. Saying "that review was taken down" would
    // confirm the existence and the moderation state of a row we just decided
    // they may not see, and it would tell a harassing owner that their complaint
    // landed on a specific review.
    const { rows } = await pool.query(
      `UPDATE venue_reviews SET venue_reply = $1, venue_replied_at = NOW()
       WHERE id = $2 AND google_place_id = $3
         AND COALESCE(is_hidden, false) = false
       RETURNING *`,
      [req.body.reply, req.params.id, venue.google_place_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Review not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Reply to review error:', err);
    res.status(500).json({ error: 'Failed to reply to review' });
  }
});

// ─── PUBLIC: User submits a review (no venue-owner auth needed) ──────────────

// POST /api/venue-dashboard/submit-review — any logged-in user can review a venue
router.post('/submit-review', [
  // Round 12: venue_reviews.google_place_id is VARCHAR(255) — an unbounded id
  // overflowed it and surfaced as a 500 instead of a 400.
  // Round 20 (shape sweep). All three fields were reachable as arrays:
  //   * googlePlaceId fed the presence query AND a VARCHAR(255) column;
  //   * rating fed an INTEGER column behind CHECK (rating BETWEEN 1 AND 5), so
  //     `rating: [3]` satisfied isInt by coercion and came back 22P02 — a 500;
  //   * `text` is the review body itself. It is PUBLIC UGC about someone else's
  //     business, shown on the venue card and on the owner's dashboard, and it
  //     had no stripHtml on any path. `text: ["<b>x</b>"]` cleared isLength by
  //     coercion and was answered allowed:true by rejectIfProfane, so the
  //     profanity screen five lines down never saw it either.
  scalarOnly(body('googlePlaceId'), 'place id').trim().isLength({ min: 1, max: 200 }).withMessage('Place ID is required'),
  scalarOnly(body('rating'), 'rating').isInt({ min: 1, max: 5 }).withMessage('Rating 1-5 required'),
  freeText(body('text').optional({ nullable: true }), 'review').isLength({ max: 1000 }).withMessage('Review is too long (max 1000 characters)'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { googlePlaceId, rating, text } = req.body;
    // Reviews are UGC — same text screen as every other user-writable field.
    if (text && rejectIfProfane(res, text)) return;

    // Round 16: you may only review a venue you can be shown to have visited.
    // ON CONFLICT (google_place_id, user_id) already stopped ONE account from
    // stuffing repeats, but nothing stopped an account from rating a place it
    // had never been to — including a competitor's, one star at a time, from as
    // many accounts as someone cares to make. The public rating on the venue
    // card is derived from these rows.
    //
    // This is the same trust rule venue_feedback.verified uses (routes/
    // feedback.js VERIFIED_PRESENCE_SQL): an HMAC-signed NFC tap ('nfc';
    // unsigned URL visits are stored as 'nfc_unverified' by migration 004 and
    // prove nothing), OR accepted membership in a flock that met at this venue.
    // Both halves are required to keep the real flow working — almost no venue
    // has an NFC tag yet, so check-ins alone would refuse nearly every honest
    // review, and the flock signal is what the product's own loop produces.
    //
    // THE CONDITIONS ARE NOW IDENTICAL TO feedback.js; ONLY THE WINDOWS DIFFER.
    // That was not true until this round. The flock branch was missing the
    // "at least two accepted members" clause while the comment above it claimed
    // parity, and the missing clause is the load-bearing one: creating a flock
    // is a single POST with a client-supplied venue_id, so a solo flock is
    // self-certification. One account could mint a five-star review — or a
    // one-star review of a competitor — for any Google place id on earth, at
    // will, and the public star rating on the venue card is derived from these
    // rows. Requiring a second account to ACCEPT does not make forgery
    // impossible; it changes the cost from one request to a second real account
    // that also has to accept, per fabricated venue. Flock is a group product,
    // and a hangout of one is not what a venue review is supposed to describe.
    // Keep this clause in step with feedback.js — __tests__/presenceParity
    // .test.js compares the two statements clause by clause.
    //
    // DELIBERATE DIFFERENCES, kept on purpose (the test above asserts these too,
    // so they cannot be "fixed" into a false equivalence):
    //   * Windows. Feedback is a LIVE crowd report, so it trusts a 3-hour tap
    //     and a ±12-hour event. A review is written after the fact, often the
    //     next morning, so presence counts for 30 days on both signals.
    //     Reviewing while you are still there also works: the event window
    //     keeps feedback's 12-hour lead.
    //   * The third EXISTS below has no counterpart in feedback.js, because
    //     feedback INSERTs and this route UPSERTs. See the note on it.
    // Shared with feedback.js and NOT a difference: a cancelled flock is an
    // explicit "we did not go" and proves nothing, and a flock with no
    // event_time cannot be dated and is not counted either.
    //
    // Honest about what this is: it raises the cost of a fabricated review from
    // one POST to a fabricated flock with a second consenting account, and it is
    // the strongest presence signal this codebase has. It is not proof against a
    // determined script with two accounts. Closing that needs the NFC/geo
    // signal, which almost no venue has hardware for yet. The same limit applies
    // to venue_feedback.verified today.
    const presence = await pool.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM venue_checkins
           WHERE user_id = $1
             AND venue_place_id = $2
             AND checkin_source = 'nfc'
             AND created_at > NOW() - INTERVAL '30 days'
         )
         OR EXISTS (
           SELECT 1
           FROM flock_members fm
           JOIN flocks f ON f.id = fm.flock_id
           WHERE fm.user_id = $1
             AND fm.status = 'accepted'
             AND f.venue_id = $2
             AND f.status IS DISTINCT FROM 'cancelled'
             AND f.event_time BETWEEN NOW() - INTERVAL '30 days'
                                  AND NOW() + INTERVAL '12 hours'
             AND (
               SELECT COUNT(*) FROM flock_members m
               WHERE m.flock_id = f.id AND m.status = 'accepted'
             ) >= 2
         )
         -- This route is an upsert: the same POST edits an existing review.
         -- Presence is proved when the review is FIRST written, and it would be
         -- absurd to lock someone out of correcting their own words two months
         -- later. Rows that predate this rule keep their author's edit rights
         -- for the same reason nothing backfills them away.
         OR EXISTS (
           SELECT 1 FROM venue_reviews
           WHERE user_id = $1 AND google_place_id = $2
         ) AS visited`,
      [req.user.id, googlePlaceId]
    );
    if (presence.rows[0]?.visited !== true) {
      return res.status(403).json({
        error: 'You can review a venue after you have been there with a flock.',
        code: 'VISIT_REQUIRED',
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO venue_reviews (google_place_id, user_id, rating, text)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (google_place_id, user_id) DO UPDATE SET
         rating = EXCLUDED.rating,
         text = EXCLUDED.text,
         created_at = NOW()
       RETURNING *`,
      [googlePlaceId, req.user.id, rating, text || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Submit review error:', err);
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

// GET /api/venue-dashboard/public-reviews/:placeId — get reviews for any venue (for user-facing venue cards)
router.get('/public-reviews/:placeId', async (req, res) => {
  try {
    const limit = reviewPageSize(req.query.limit);

    // `average` and `total` were derived from the 50-row page, so past 50
    // reviews a venue's public rating silently became "average of the newest
    // 50" and the count froze at 50 — the number users compare venues on was
    // wrong precisely for the venues with the most reviews. Aggregate over
    // every visible row, with the SAME visibility rules as the list below so
    // the two cannot disagree.
    const statsResult = await pool.query(
      `SELECT COUNT(*)::int AS total, AVG(vr.rating)::float AS average
       FROM venue_reviews vr
       JOIN users u ON u.id = vr.user_id
       WHERE vr.google_place_id = $1
         AND COALESCE(vr.is_hidden, false) = false
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $2 AND b.blocked_id = vr.user_id)
              OR (b.blocker_id = vr.user_id AND b.blocked_id = $2)
         )`,
      [req.params.placeId, req.user.id]
    );
    const total = statsResult.rows[0]?.total || 0;
    const average = total > 0 ? parseFloat(Number(statsResult.rows[0].average).toFixed(1)) : 0;

    // venue_reply comes from whoever claimed the place — expose it publicly
    // only when that claim is verified. User reviews themselves always show.
    // EXISTS rather than the previous LEFT JOIN on venue_profiles: nothing
    // makes google_place_id unique in that table, so two verified claims on one
    // place duplicated every review row in this response (and would have
    // double-weighted them in the average).
    const { rows } = await pool.query(
      `SELECT vr.id, vr.rating, vr.text,
              CASE WHEN EXISTS (
                SELECT 1 FROM venue_profiles vp
                WHERE vp.google_place_id = vr.google_place_id AND vp.verified = true
              ) THEN vr.venue_reply ELSE NULL END AS venue_reply,
              CASE WHEN EXISTS (
                SELECT 1 FROM venue_profiles vp
                WHERE vp.google_place_id = vr.google_place_id AND vp.verified = true
              ) THEN vr.venue_replied_at ELSE NULL END AS venue_replied_at,
              vr.created_at, u.name, u.profile_image_url
       FROM venue_reviews vr
       JOIN users u ON u.id = vr.user_id
       WHERE vr.google_place_id = $1
         AND COALESCE(vr.is_hidden, false) = false
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $2 AND b.blocked_id = vr.user_id)
              OR (b.blocker_id = vr.user_id AND b.blocked_id = $2)
         )
       ORDER BY vr.created_at DESC
       LIMIT $3`,
      [req.params.placeId, req.user.id, limit]
    );

    res.json({ reviews: rows, average, total, hasMore: total > rows.length });
  } catch (err) {
    console.error('Get public reviews error:', err);
    res.status(500).json({ error: 'Failed to get reviews' });
  }
});

// GET /api/venue-dashboard/public-promotions/:placeId — get active promotions for a venue (user-facing)
router.get('/public-promotions/:placeId', async (req, res) => {
  try {
    // Only VERIFIED venues publish publicly — an unverified claim on a Google
    // Place ID must not let a stranger speak as that business (audit 2026-08-12).
    // Round 4: the join is on the promotion AUTHOR's own profile, not the place
    // id alone — matching by place id let an unverified claimant's promotion
    // ride on someone else's verified claim for the same place.
    //
    // Round 16: `verified` is a permanent property of the claim, so gating on it
    // alone meant upgrade -> create promotions -> downgrade kept the benefit
    // forever. "Promotions to nearby groups" is an Insights line item in the
    // VENUE-BILLING.md pricing table, so the SERVING of one is gated on the tier
    // the author holds right now, exactly as creating one is (requirePremium).
    // The kill switch is a bound PARAMETER, not string-built SQL: one query
    // shape, no request data anywhere near the text, and "flag off => every
    // venue owner acts Pro" holds for this public route the same way
    // requireVenueTier makes it hold for the owner-facing ones. A NULL tier
    // fails the ANY test, so an unrecognised tier is not served either.
    const { rows } = await pool.query(
      `SELECT p.id, p.title, p.description, p.time_slot, p.days FROM venue_promotions p
       JOIN venue_profiles vp ON vp.user_id = p.venue_user_id
         AND vp.google_place_id = p.google_place_id
         AND vp.verified = true
         AND ($2::boolean = false OR vp.tier = ANY($3::text[]))
       WHERE p.google_place_id = $1 AND p.active = true AND COALESCE(p.is_hidden, false) = false
       ORDER BY p.created_at DESC
       LIMIT 100`,
      [req.params.placeId, venueBillingEnabled(), SERVING_TIERS]
    );
    // Increment view count (bounded by the LIMIT above, so the ANY($1) set never
    // grows without limit either).
    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      await pool.query(
        'UPDATE venue_promotions SET views = views + 1 WHERE id = ANY($1)',
        [ids]
      );
    }
    res.json({ promotions: rows });
  } catch (err) {
    console.error('Get public promotions error:', err);
    res.status(500).json({ error: 'Failed to get promotions' });
  }
});

// ─── VENUE INTELLIGENCE ──────────────────────────────────────────────────────
// Real, model-powered analytics for the venue owner. This is the zero-user
// venue product: their own forecast and the competitive strip view, computed
// by the same crowd model users see. It replaces the hardcoded demo numbers
// the old Analytics tab showed (VENUE-BILLING.md finding #3): nothing here is
// invented; if we can't compute it, the field is null and the UI says so.

const { getWeather } = require('../services/weatherService');
const mlPredictor = require('../services/mlPredictor');
// Round 15: the owner dashboard scored on Railway's UTC clock. venueLocalNow +
// weekdayOffset move scoring onto the venue's wall clock, same as routes/crowd.js.
const crowdEngine = require('../services/crowdEngine');
// Round 9: these Places fetches bypassed the shared paid-call budget that
// venueSearch and crowd.js are both charged against.
const { allowPlacesSearch } = require('../utils/placesBudget');
const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;
const BUDGET_MESSAGE = 'Too many venue lookups right now. Try again in a little while.';

// 60-min cache: Google calls cost money and forecasts don't move fast.
const intelCache = new Map();
const INTEL_TTL = 60 * 60 * 1000;
const INTEL_MAX = 500;
const cacheGet = (k) => {
  const hit = intelCache.get(k);
  if (hit && Date.now() - hit.ts < INTEL_TTL) return hit.data;
  intelCache.delete(k);
  return null;
};
const cacheSet = (k, data) => {
  intelCache.set(k, { ts: Date.now(), data });
  // Round 9: unbounded before — one entry per place id the owner can relink to.
  if (intelCache.size > INTEL_MAX) {
    const now = Date.now();
    for (const [key, v] of intelCache) {
      if (now - v.ts > INTEL_TTL) intelCache.delete(key);
    }
    // Fresh-but-oversized: evict oldest first (same pattern as crowd.js).
    while (intelCache.size > INTEL_MAX) intelCache.delete(intelCache.keys().next().value);
  }
};

// Returned instead of a venue when the shared Places budget is spent, so the
// route can answer 429 rather than pretend Google was unreachable.
const BUDGET_EXCEEDED = Symbol('places_budget_exceeded');

async function fetchVenueBasics(placeId, userId) {
  if (!GOOGLE_KEY) return null;
  // Round 9: charge the shared budget before every paid upstream call.
  if (!allowPlacesSearch(userId)) return BUDGET_EXCEEDED;
  // ENCODED, same reason as routes/crowd.js fetchVenueFromGoogle. This id is
  // less obviously attacker-shaped — it is venue_profiles.google_place_id, not
  // a path segment — but it is still a string the venue owner typed into Edit
  // Profile, and nothing on that write path constrains it to
  // utils/places.isPlaceIdShaped. A `/../` or a `?` in it re-points this call
  // at a different Google endpoint carrying our API key.
  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: {
      'X-Goog-Api-Key': GOOGLE_KEY,
      // Round 15: utcOffsetMinutes drives the venue-clock scoring below and the
      // event window in predictBusyness (trueEventInstant). Dropping it reverts
      // both to the server clock — mirrors the crowd.js field mask.
      'X-Goog-FieldMask': 'id,displayName,rating,userRatingCount,priceLevel,types,location,currentOpeningHours,utcOffsetMinutes',
    },
    signal: upstreamSignal('places'), // round 12 — see utils/upstream.js
  });
  const p = await r.json();
  if (p.error) return null;
  return {
    place_id: p.id,
    name: p.displayName?.text || '',
    rating: p.rating || null,
    user_ratings_total: p.userRatingCount || 0,
    types: p.types || [],
    location: p.location || null,
    isOpen: p.currentOpeningHours?.openNow ?? null,
    // Nullable: Google omits it for some places, and callers fall back to the
    // server clock when it is null.
    utcOffsetMinutes: p.utcOffsetMinutes != null ? p.utcOffsetMinutes : null,
  };
}

// Both routes below are gated the same way, and BOTH checks run before the
// cache read: the cache is keyed by place id, so an unverified claimant on the
// same place id would otherwise be handed the verified owner's cached forecast
// without a single Google call to notice.
//
//   requirePremium — the demand curve is an Insights line item in the
//   VENUE-BILLING.md pricing table (see the tier note at the top of this file).
//   403 UPGRADE_REQUIRED, the contract the frontend already forwards.
//
//   verified — an unverified claim is an unproven one. Serving these two costs
//   real money (each spends the shared Places budget) and the strip hands out
//   competitive data about the neighbours, so a mere claim on an arbitrary
//   Google place id must not buy either. Answered as `available: false` with a
//   reason rather than a 403 so the dashboard can say what to do about it —
//   same shape incoming-flocks already uses for the same condition.
const UNVERIFIED_REASON = 'Verify your venue to unlock this. We check ownership before turning on forecasts.';

// GET /api/venue-dashboard/intelligence — the owner's own forecast
router.get('/intelligence', requirePremium, async (req, res) => {
  try {
    const ctx = await getVenueCtx(req.user.id);
    if (!ctx?.google_place_id) {
      return res.json({ available: false, reason: 'Link your Google listing in Edit Profile to unlock forecasts' });
    }
    if (!ctx.verified) return res.json({ available: false, unverified: true, reason: UNVERIFIED_REASON });
    const cached = cacheGet(`intel:${ctx.google_place_id}`);
    if (cached) return res.json(cached);

    const venue = await fetchVenueBasics(ctx.google_place_id, req.user.id);
    if (venue === BUDGET_EXCEEDED) return res.status(429).json({ error: BUDGET_MESSAGE });
    if (!venue) return res.json({ available: false, reason: 'Could not reach your Google listing right now' });

    const lat = venue.location?.latitude;
    const lng = venue.location?.longitude;
    const weather = (lat && lng) ? await getWeather(lat, lng).catch(() => null) : null;

    const now = new Date();
    // Score on the VENUE's wall clock, not Railway's UTC. Same contract as
    // routes/crowd.js: venueLocalNow turns Google's utcOffsetMinutes into the
    // hour/day the doors actually run on, and weekdayOffset lands the base date
    // on the venue's own weekday (nearest match) so the holiday / special-night
    // features and the 6-day outlook walk the venue's calendar, not the
    // server's. Falls back to the server clock when Google gives us no offset.
    const venueClock = crowdEngine.venueLocalNow(venue.utcOffsetMinutes, now);
    const localHour = venueClock ? venueClock.hour : now.getHours();
    const localDay = venueClock ? venueClock.day : now.getDay();
    const venueBase = new Date(now);
    venueBase.setDate(venueBase.getDate() + crowdEngine.weekdayOffset(venueBase.getDay(), localDay));
    const scoreTime = new Date(venueBase);
    scoreTime.setHours(localHour, 0, 0, 0);

    const current = await mlPredictor.predictBusyness(venue, weather, scoreTime);
    // Full day today (6 AM start), then evening curves for the next 6 days.
    const todayHourly = await mlPredictor.predictHourlyForecast(venue, weather, 6, 18, venueBase);
    const week = [];
    for (let d = 1; d <= 6; d++) {
      const day = new Date(venueBase);
      day.setDate(day.getDate() + d);
      day.setHours(17, 0, 0, 0);
      const evening = await mlPredictor.predictHourlyForecast(venue, weather, 17, 7, day);
      const peak = evening.reduce((a, b) => (b.score > a.score ? b : a), { score: -1 });
      week.push({
        date: day.toISOString().slice(0, 10),
        weekday: day.toLocaleDateString('en-US', { weekday: 'short' }),
        peakScore: peak.score ?? null,
        peakHour: peak.hour ?? null,
      });
    }

    const result = {
      available: true,
      venue: { name: venue.name, placeId: venue.place_id },
      now: { score: current.score, label: current.label, method: current.predictionMethod || (current.dataSourcesUsed?.includes('ml_model') ? 'ml' : 'rule_engine') },
      todayHourly,
      week,
      model: current.modelVersion || null,
      generatedAt: new Date().toISOString(),
    };
    cacheSet(`intel:${ctx.google_place_id}`, result);
    res.json(result);
  } catch (err) {
    console.error('Venue intelligence error:', err);
    res.status(500).json({ error: 'Failed to build venue intelligence' });
  }
});

// GET /api/venue-dashboard/strip — you vs the venues around you, tonight.
// Google Popular Times cannot do this: it is per-venue, read-only, no API.
router.get('/strip', requirePremium, async (req, res) => {
  try {
    const ctx = await getVenueCtx(req.user.id);
    if (!ctx?.google_place_id) {
      return res.json({ available: false, reason: 'Link your Google listing in Edit Profile to unlock the strip view' });
    }
    if (!ctx.verified) return res.json({ available: false, unverified: true, reason: UNVERIFIED_REASON });
    const cached = cacheGet(`strip:${ctx.google_place_id}`);
    if (cached) return res.json(cached);
    if (!GOOGLE_KEY) return res.json({ available: false, reason: 'Search unavailable right now' });

    const me = await fetchVenueBasics(ctx.google_place_id, req.user.id);
    if (me === BUDGET_EXCEEDED) return res.status(429).json({ error: BUDGET_MESSAGE });
    if (!me?.location) return res.json({ available: false, reason: 'Could not reach your Google listing right now' });

    // Same-category venues within walking distance.
    const wanted = ['bar', 'night_club', 'restaurant'].filter((t) => me.types.includes(t));
    // Round 9: searchNearby is a second paid call — charge it separately.
    if (!allowPlacesSearch(req.user.id)) return res.status(429).json({ error: BUDGET_MESSAGE });
    const nearbyRes = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_KEY,
        // Round 15: utcOffsetMinutes so each competitor is scored on its own
        // wall clock (see scoreOne) instead of the server's.
        'X-Goog-FieldMask': 'places.id,places.displayName,places.types,places.location,places.priceLevel,places.rating,places.currentOpeningHours,places.utcOffsetMinutes',
      },
      body: JSON.stringify({
        includedTypes: wanted.length ? wanted : ['bar'],
        maxResultCount: 8,
        locationRestriction: {
          circle: { center: { latitude: me.location.latitude, longitude: me.location.longitude }, radius: 1500 },
        },
      }),
      signal: upstreamSignal('places'), // round 12
    });
    // The verdict is read from the RESPONSE as well as from the body. Round 19
    // checked `nearby.error` alone, which is Google's own error envelope and
    // covers Google's own failures — but not the two that arrive without one: a
    // gateway or proxy in front of Places answering a non-2xx with a body that
    // is not that envelope, and a body that is not JSON at all (which used to
    // throw out of the old `.then(r => r.json())` and land in the outer catch as
    // a 500). Both previously left `places` undefined, which `(nearby.places ||
    // [])` below reads as a successful search that found nobody — the exact
    // false answer round 19 removed, through a different door.
    let nearby = null;
    try { nearby = await nearbyRes.json(); } catch { /* not JSON: handled below */ }

    // Round 19: `(nearby.places || [])` swallowed an upstream failure. A quota,
    // auth or Places outage comes back as `{ error: ... }` with no `places` key,
    // which read as a successful search that found nothing — so the strip view
    // answered `available: true` with an empty competitor list and told a venue
    // owner there is nobody around them tonight. Worse, that answer was written
    // into the 60-minute cache, so one blip froze the false reading for an hour
    // while the owner's own dial kept updating beside it. An honest refusal the
    // dashboard can explain, and nothing cached, so the next request retries.
    // (Same rule routes/publicCrowd.js already follows for its two searches, and
    // the same one fetchVenueBasics above follows for the owner's own listing.)
    if (!nearby || nearby.error || nearbyRes.status >= 400) {
      console.error('[VenueStrip] Places searchNearby failed:',
        nearby?.error?.message || nearby?.error?.status || `HTTP ${nearbyRes.status}`);
      return res.json({
        available: false,
        reason: 'Could not load the venues around you right now. Try again in a few minutes.',
      });
    }

    const weather = await getWeather(me.location.latitude, me.location.longitude).catch(() => null);
    const now = new Date();

    const scoreOne = async (v) => {
      // Each venue is scored on ITS OWN wall clock (same contract as
      // routes/crowd.js), not Railway's UTC. Competitors sit beside `me` so
      // they share a zone in practice, but reading the offset per venue keeps
      // this correct regardless, and lets trueEventInstant land the event
      // window on the real instant. Server clock is the fallback when Google
      // gave us no offset.
      const clock = crowdEngine.venueLocalNow(v.utcOffsetMinutes, now);
      const localHour = clock ? clock.hour : now.getHours();
      const localDay = clock ? clock.day : now.getDay();
      const base = new Date(now);
      base.setDate(base.getDate() + crowdEngine.weekdayOffset(base.getDay(), localDay));
      const scoreTime = new Date(base);
      scoreTime.setHours(localHour, 0, 0, 0);
      const [current, evening] = await Promise.all([
        mlPredictor.predictBusyness(v, weather, scoreTime),
        mlPredictor.predictHourlyForecast(v, weather, 17, 7, base),
      ]);
      const peak = evening.reduce((a, b) => (b.score > a.score ? b : a), { score: -1 });
      return { name: v.name, score: current.score, label: current.label, peakScore: peak.score ?? null, peakHour: peak.hour ?? null };
    };

    const competitors = (nearby.places || [])
      .filter((p) => p.id !== me.place_id)
      .slice(0, 6)
      .map((p) => ({
        place_id: p.id,
        name: p.displayName?.text || '',
        types: p.types || [],
        location: p.location || null,
        rating: p.rating || null,
        isOpen: p.currentOpeningHours?.openNow ?? null,
        // Scored on the competitor's own clock in scoreOne; null -> server clock.
        utcOffsetMinutes: p.utcOffsetMinutes != null ? p.utcOffsetMinutes : null,
      }));

    const result = {
      available: true,
      you: await scoreOne(me),
      competitors: await Promise.all(competitors.map(scoreOne)),
      generatedAt: new Date().toISOString(),
    };
    cacheSet(`strip:${ctx.google_place_id}`, result);
    res.json(result);
  } catch (err) {
    console.error('Venue strip error:', err);
    res.status(500).json({ error: 'Failed to build the strip view' });
  }
});

module.exports = router;
