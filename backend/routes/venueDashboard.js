const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requireVenueTier, venueBillingEnabled } = require('../services/venueEntitlements');
const { rejectIfProfane } = require('../utils/moderation');
const { upstreamSignal } = require('../utils/upstream');

const router = express.Router();
router.use(authenticate);

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
    const { rows } = await pool.query(
      'SELECT * FROM venue_promotions WHERE venue_user_id = $1 ORDER BY created_at DESC LIMIT 200',
      [req.user.id]
    );
    res.json({ promotions: rows });
  } catch (err) {
    console.error('Get promotions error:', err);
    res.status(500).json({ error: 'Failed to get promotions' });
  }
});

// POST /api/venue-dashboard/promotions
router.post('/promotions', requirePremium, [
  body('title').trim().isLength({ min: 1, max: 80 }).withMessage('Title is required (max 80 characters)'),
  body('description').optional().trim().isLength({ max: 300 }),
  body('timeSlot').optional().trim().isLength({ max: 60 }),
  body('days').optional().trim().isLength({ max: 60 }),
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
router.put('/promotions/:id', requirePremium, [
  param('id').isInt(),
  body('title').optional().trim().isLength({ min: 1, max: 80 }).withMessage('Title too long (max 80 characters)'),
  body('description').optional().trim().isLength({ max: 300 }),
  body('timeSlot').optional().trim().isLength({ max: 60 }),
  body('days').optional().trim().isLength({ max: 60 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
    // Edits are the same public UGC surface as creation (round 8).
    if (req.body.title && rejectIfProfane(res, req.body.title)) return;
    if (req.body.description && rejectIfProfane(res, req.body.description)) return;

    const { title, description, timeSlot, days } = req.body;
    const { rows } = await pool.query(
      `UPDATE venue_promotions SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        time_slot = COALESCE($3, time_slot),
        days = COALESCE($4, days),
        updated_at = NOW()
      WHERE id = $5 AND venue_user_id = $6 RETURNING *`,
      [title || null, description || null, timeSlot || null, days || null, req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Promotion not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Update promotion error:', err);
    res.status(500).json({ error: 'Failed to update promotion' });
  }
});

// DELETE /api/venue-dashboard/promotions/:id
router.delete('/promotions/:id', requirePremium, param('id').isInt(), async (req, res) => {
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
router.post('/events', requirePremium, [
  body('title').trim().isLength({ min: 1, max: 120 }).withMessage('Title is required (max 120 characters)'),
  body('eventDate').optional().trim().isLength({ max: 40 }),
  body('eventTime').optional().trim().isLength({ max: 40 }),
  body('capacity').optional().isInt({ min: 1 }),
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
  param('id').isInt(),
  body('title').optional().trim().isLength({ min: 1, max: 120 }).withMessage('Title too long (max 120 characters)'),
  body('eventDate').optional().trim().isLength({ max: 40 }),
  body('eventTime').optional().trim().isLength({ max: 40 }),
  body('capacity').optional().isInt({ min: 1 }),
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
router.delete('/events/:id', requirePremium, param('id').isInt(), async (req, res) => {
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
      `SELECT COUNT(*)::int AS total,
              AVG(vr.rating)::float AS average,
              COUNT(*) FILTER (WHERE vr.rating = 1)::int AS r1,
              COUNT(*) FILTER (WHERE vr.rating = 2)::int AS r2,
              COUNT(*) FILTER (WHERE vr.rating = 3)::int AS r3,
              COUNT(*) FILTER (WHERE vr.rating = 4)::int AS r4,
              COUNT(*) FILTER (WHERE vr.rating = 5)::int AS r5
       FROM venue_reviews vr
       JOIN users u ON u.id = vr.user_id
       WHERE vr.google_place_id = $1`,
      [venue.google_place_id]
    );
    const s = statsResult.rows[0] || {};
    const total = s.total || 0;

    const { rows } = await pool.query(
      `SELECT vr.*, u.name, u.profile_image_url
       FROM venue_reviews vr
       JOIN users u ON u.id = vr.user_id
       WHERE vr.google_place_id = $1
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
router.post('/reviews/:id/reply', [
  param('id').isInt(),
  body('reply').trim().isLength({ min: 1, max: 1000 }).withMessage('Reply is required (max 1000 characters)'),
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

    const { rows } = await pool.query(
      `UPDATE venue_reviews SET venue_reply = $1, venue_replied_at = NOW()
       WHERE id = $2 AND google_place_id = $3 RETURNING *`,
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
  body('googlePlaceId').trim().isLength({ min: 1, max: 200 }).withMessage('Place ID is required'),
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating 1-5 required'),
  body('text').optional().trim().isLength({ max: 1000 }).withMessage('Review is too long (max 1000 characters)'),
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
    // feedback.js): an HMAC-signed NFC tap ('nfc'; unsigned URL visits are
    // stored as 'nfc_unverified' by migration 004 and prove nothing), OR
    // accepted membership in a flock that met at this venue. Both halves are
    // required to keep the real flow working — almost no venue has an NFC tag
    // yet, so check-ins alone would refuse nearly every honest review, and the
    // flock signal is what the product's own loop produces.
    //
    // The windows are the one deliberate difference from feedback.js. Feedback
    // is a live crowd report, so it trusts a 3-hour tap and a ±12-hour event.
    // A review is written after the fact, often the next morning, so presence
    // counts for 30 days. Reviewing while you are still there also works: the
    // event window keeps feedback's 12-hour lead. A cancelled flock is an
    // explicit "we did not go", so it proves nothing; a flock with no
    // event_time cannot be dated and is not counted either.
    //
    // Honest about what this is: it raises the cost of a fabricated review from
    // one POST to a fabricated flock, and it is the strongest presence signal
    // this codebase has. It is not proof against a determined script — a user
    // can still create a flock naming any place id and confirm it. Closing that
    // needs the NFC/geo signal, which almost no venue has hardware for yet.
    // The same limit applies to venue_feedback.verified today.
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
  const r = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
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
    const nearby = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
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
    }).then((r) => r.json());

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
