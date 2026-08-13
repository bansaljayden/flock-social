const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { requireVenueTier } = require('../services/venueEntitlements');

const router = express.Router();
router.use(authenticate);

// Paid-tier boundaries (VENUE-BILLING.md): promotions, events, and the full
// incoming-flocks feed are Insights ('premium') features. Server-enforced —
// the locked dashboard tabs are cosmetic. No-op until VENUE_BILLING_ENABLED.
const requirePremium = requireVenueTier('premium');

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

    const { rows } = await pool.query(
      'SELECT * FROM venue_promotions WHERE venue_user_id = $1 ORDER BY created_at DESC',
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
  body('title').optional().trim(),
  body('description').optional().trim(),
  body('timeSlot').optional().trim(),
  body('days').optional().trim(),
], async (req, res) => {
  try {
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

    const { rows } = await pool.query(
      'SELECT * FROM venue_events WHERE venue_user_id = $1 ORDER BY created_at DESC',
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
  body('title').trim().isLength({ min: 1 }).withMessage('Title is required'),
  body('eventDate').optional().trim(),
  body('eventTime').optional().trim(),
  body('capacity').optional().isInt({ min: 1 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

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
  body('title').optional().trim(),
  body('eventDate').optional().trim(),
  body('eventTime').optional().trim(),
  body('capacity').optional().isInt({ min: 1 }),
], async (req, res) => {
  try {
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
    const ver = await pool.query(
      'SELECT verified FROM venue_profiles WHERE user_id = $1',
      [req.user.id]
    );
    if (!ver.rows[0]?.verified) return res.json({ flocks: [], unverified: true });

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

// GET /api/venue-dashboard/reviews — get Flock reviews for this venue
router.get('/reviews', async (req, res) => {
  try {
    const venue = await getVenueCtx(req.user.id);
    if (!venue || !venue.google_place_id) return res.json({ reviews: [], stats: null });

    const { rows } = await pool.query(
      `SELECT vr.*, u.name, u.profile_image_url
       FROM venue_reviews vr
       JOIN users u ON u.id = vr.user_id
       WHERE vr.google_place_id = $1
       ORDER BY vr.created_at DESC`,
      [venue.google_place_id]
    );

    // Calculate stats
    const total = rows.length;
    const avg = total > 0 ? (rows.reduce((s, r) => s + r.rating, 0) / total).toFixed(1) : 0;
    const dist = [0, 0, 0, 0, 0];
    rows.forEach(r => dist[r.rating - 1]++);

    res.json({
      reviews: rows,
      stats: { average: parseFloat(avg), total, distribution: dist }
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
  body('googlePlaceId').trim().isLength({ min: 1 }).withMessage('Place ID is required'),
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating 1-5 required'),
  body('text').optional().trim().isLength({ max: 1000 }).withMessage('Review is too long (max 1000 characters)'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { googlePlaceId, rating, text } = req.body;
    // Reviews are UGC — same text screen as every other user-writable field.
    if (text && rejectIfProfane(res, text)) return;
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
    // venue_reply comes from whoever claimed the place — expose it publicly
    // only when that claim is verified. User reviews themselves always show.
    const { rows } = await pool.query(
      `SELECT vr.id, vr.rating, vr.text,
              CASE WHEN vp.verified THEN vr.venue_reply ELSE NULL END AS venue_reply,
              CASE WHEN vp.verified THEN vr.venue_replied_at ELSE NULL END AS venue_replied_at,
              vr.created_at, u.name, u.profile_image_url
       FROM venue_reviews vr
       JOIN users u ON u.id = vr.user_id
       LEFT JOIN venue_profiles vp ON vp.google_place_id = vr.google_place_id AND vp.verified = true
       WHERE vr.google_place_id = $1
         AND COALESCE(vr.is_hidden, false) = false
         AND NOT EXISTS (
           SELECT 1 FROM user_blocks b
           WHERE (b.blocker_id = $2 AND b.blocked_id = vr.user_id)
              OR (b.blocker_id = vr.user_id AND b.blocked_id = $2)
         )
       ORDER BY vr.created_at DESC
       LIMIT 50`,
      [req.params.placeId, req.user.id]
    );

    const total = rows.length;
    const avg = total > 0 ? (rows.reduce((s, r) => s + r.rating, 0) / total).toFixed(1) : 0;

    res.json({ reviews: rows, average: parseFloat(avg), total });
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
    const { rows } = await pool.query(
      `SELECT p.id, p.title, p.description, p.time_slot, p.days FROM venue_promotions p
       JOIN venue_profiles vp ON vp.user_id = p.venue_user_id
         AND vp.google_place_id = p.google_place_id
         AND vp.verified = true
       WHERE p.google_place_id = $1 AND p.active = true AND COALESCE(p.is_hidden, false) = false
       ORDER BY p.created_at DESC`,
      [req.params.placeId]
    );
    // Increment view count
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
const GOOGLE_KEY = process.env.GOOGLE_PLACES_API_KEY;

// 60-min cache: Google calls cost money and forecasts don't move fast.
const intelCache = new Map();
const INTEL_TTL = 60 * 60 * 1000;
const cacheGet = (k) => {
  const hit = intelCache.get(k);
  if (hit && Date.now() - hit.ts < INTEL_TTL) return hit.data;
  intelCache.delete(k);
  return null;
};
const cacheSet = (k, data) => intelCache.set(k, { ts: Date.now(), data });

async function fetchVenueBasics(placeId) {
  if (!GOOGLE_KEY) return null;
  const r = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': GOOGLE_KEY,
      'X-Goog-FieldMask': 'id,displayName,rating,userRatingCount,priceLevel,types,location,currentOpeningHours',
    },
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
  };
}

// GET /api/venue-dashboard/intelligence — the owner's own forecast
router.get('/intelligence', async (req, res) => {
  try {
    const ctx = await getVenueCtx(req.user.id);
    if (!ctx?.google_place_id) {
      return res.json({ available: false, reason: 'Link your Google listing in Edit Profile to unlock forecasts' });
    }
    const cached = cacheGet(`intel:${ctx.google_place_id}`);
    if (cached) return res.json(cached);

    const venue = await fetchVenueBasics(ctx.google_place_id);
    if (!venue) return res.json({ available: false, reason: 'Could not reach your Google listing right now' });

    const lat = venue.location?.latitude;
    const lng = venue.location?.longitude;
    const weather = (lat && lng) ? await getWeather(lat, lng).catch(() => null) : null;

    const now = new Date();
    const current = await mlPredictor.predictBusyness(venue, weather, now);
    // Full day today (6 AM start), then evening curves for the next 6 days.
    const todayHourly = await mlPredictor.predictHourlyForecast(venue, weather, 6, 18, now);
    const week = [];
    for (let d = 1; d <= 6; d++) {
      const day = new Date(now);
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
router.get('/strip', async (req, res) => {
  try {
    const ctx = await getVenueCtx(req.user.id);
    if (!ctx?.google_place_id) {
      return res.json({ available: false, reason: 'Link your Google listing in Edit Profile to unlock the strip view' });
    }
    const cached = cacheGet(`strip:${ctx.google_place_id}`);
    if (cached) return res.json(cached);
    if (!GOOGLE_KEY) return res.json({ available: false, reason: 'Search unavailable right now' });

    const me = await fetchVenueBasics(ctx.google_place_id);
    if (!me?.location) return res.json({ available: false, reason: 'Could not reach your Google listing right now' });

    // Same-category venues within walking distance.
    const wanted = ['bar', 'night_club', 'restaurant'].filter((t) => me.types.includes(t));
    const nearby = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.types,places.location,places.priceLevel,places.rating,places.currentOpeningHours',
      },
      body: JSON.stringify({
        includedTypes: wanted.length ? wanted : ['bar'],
        maxResultCount: 8,
        locationRestriction: {
          circle: { center: { latitude: me.location.latitude, longitude: me.location.longitude }, radius: 1500 },
        },
      }),
    }).then((r) => r.json());

    const weather = await getWeather(me.location.latitude, me.location.longitude).catch(() => null);
    const now = new Date();

    const scoreOne = async (v) => {
      const [current, evening] = await Promise.all([
        mlPredictor.predictBusyness(v, weather, now),
        mlPredictor.predictHourlyForecast(v, weather, 17, 7, now),
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
