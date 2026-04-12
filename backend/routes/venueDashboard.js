const express = require('express');
const { body, param, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Helper: get venue profile for current user
async function getVenueCtx(userId) {
  const { rows } = await pool.query(
    'SELECT id, google_place_id FROM venue_profiles WHERE user_id = $1',
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
router.post('/promotions', [
  body('title').trim().isLength({ min: 1 }).withMessage('Title is required'),
  body('description').optional().trim(),
  body('timeSlot').optional().trim(),
  body('days').optional().trim(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

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
router.put('/promotions/:id', [
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
router.delete('/promotions/:id', param('id').isInt(), async (req, res) => {
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
router.post('/events', [
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
router.put('/events/:id', [
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
router.delete('/events/:id', param('id').isInt(), async (req, res) => {
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
router.get('/incoming-flocks', async (req, res) => {
  try {
    const venue = await getVenueCtx(req.user.id);
    if (!venue || !venue.google_place_id) return res.json({ flocks: [] });

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
  body('reply').trim().isLength({ min: 1 }).withMessage('Reply is required'),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const venue = await getVenueCtx(req.user.id);
    if (!venue) return res.status(403).json({ error: 'Not a venue owner' });

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
  body('text').optional().trim(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const { googlePlaceId, rating, text } = req.body;
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
    const { rows } = await pool.query(
      `SELECT vr.id, vr.rating, vr.text, vr.venue_reply, vr.venue_replied_at, vr.created_at,
              u.name, u.profile_image_url
       FROM venue_reviews vr
       JOIN users u ON u.id = vr.user_id
       WHERE vr.google_place_id = $1
       ORDER BY vr.created_at DESC
       LIMIT 50`,
      [req.params.placeId]
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
    const { rows } = await pool.query(
      `SELECT id, title, description, time_slot, days FROM venue_promotions
       WHERE google_place_id = $1 AND active = true
       ORDER BY created_at DESC`,
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

module.exports = router;
