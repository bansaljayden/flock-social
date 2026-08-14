const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// POST /api/venue-profile — create venue profile (onboarding)
router.post('/', [
  body('businessName').trim().isLength({ min: 1 }).withMessage('Business name is required'),
  body('category').optional().trim(),
  body('location').optional().trim(),
  body('description').optional().trim(),
  body('goals').optional().isArray(),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { businessName, category, location, description, goals, googlePlaceId } = req.body;

    // Set user role to venue_owner.
    //
    // This is still self-serve (VENUE-BILLING.md finding 2 — gating it needs an
    // approval flow that does not exist yet). It is survivable because the role
    // grants nothing on its own: every venue capability that reaches real users
    // is gated on venue_profiles.verified, which only an admin can set
    // (routes/admin.js), and sockets/handlers.js:997 already treats the role as
    // forgeable.
    //
    // What it must NOT do is DOWNGRADE a role (audit 2026-08-13). The old
    // unconditional write let an admin who opened venue onboarding once demote
    // themselves to venue_owner permanently — nothing in the codebase grants
    // 'admin' back, so it locks the moderation dashboard, /api/admin/* and the
    // tier-comp endpoint out of the only account that has them.
    await pool.query(
      "UPDATE users SET role = $1 WHERE id = $2 AND role NOT IN ('admin', 'venue_owner')",
      ['venue_owner', req.user.id]
    );

    // Upsert venue profile
    const result = await pool.query(
      `INSERT INTO venue_profiles (user_id, business_name, category, location, description, goals, google_place_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET
         business_name = EXCLUDED.business_name,
         category = EXCLUDED.category,
         location = EXCLUDED.location,
         description = EXCLUDED.description,
         goals = EXCLUDED.goals,
         google_place_id = COALESCE(EXCLUDED.google_place_id, venue_profiles.google_place_id),
         -- Verification binds to the place: re-claiming with a different place
         -- id resets it (round 3: this reset existed only on the PUT path)
         verified = CASE WHEN EXCLUDED.google_place_id IS NOT NULL
                          AND EXCLUDED.google_place_id IS DISTINCT FROM venue_profiles.google_place_id
                         THEN false ELSE venue_profiles.verified END,
         updated_at = NOW()
       RETURNING *`,
      [req.user.id, businessName, category || null, location || null, description || null, goals || [], googlePlaceId || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create venue profile error:', err);
    res.status(500).json({ error: 'Failed to create venue profile' });
  }
});

// GET /api/venue-profile — get current user's venue profile
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM venue_profiles WHERE user_id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No venue profile found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Get venue profile error:', err);
    res.status(500).json({ error: 'Failed to get venue profile' });
  }
});

// PUT /api/venue-profile — update venue profile (all settings)
router.put('/', [
  body('businessName').optional().trim(),
  body('category').optional().trim(),
  body('location').optional().trim(),
  body('description').optional().trim(),
  body('goals').optional().isArray(),
  body('phone').optional().trim(),
  body('operatingHours').optional().isArray(),
  body('notificationPrefs').optional().isObject(),
  body('googlePlaceId').optional().trim(),
  // tier is intentionally NOT accepted from the client — it maps to paid
  // plans and is set server-side only (audit 2026-08-12: clients could
  // PATCH themselves to 'pro').
  body('photoUrl').optional().trim(),
], async (req, res) => {
  try {
    const { businessName, category, location, description, goals, phone, operatingHours, notificationPrefs, googlePlaceId, photoUrl } = req.body;

    const result = await pool.query(
      `UPDATE venue_profiles SET
        business_name = COALESCE($1, business_name),
        category = COALESCE($2, category),
        location = COALESCE($3, location),
        description = COALESCE($4, description),
        goals = COALESCE($5, goals),
        phone = COALESCE($6, phone),
        operating_hours = COALESCE($7, operating_hours),
        notification_prefs = COALESCE($8, notification_prefs),
        google_place_id = COALESCE($9, google_place_id),
        -- Verification binds to the PLACE, not the profile row: changing the
        -- place id resets verified so a verified owner can't pivot their badge
        -- onto a business they don't own (audit 2026-08-12). CASE evaluates
        -- against the OLD row, so this compares new id vs current id.
        verified = CASE WHEN $9 IS NOT NULL AND $9 IS DISTINCT FROM google_place_id
                        THEN false ELSE verified END,
        photo_url = COALESCE($10, photo_url),
        updated_at = NOW()
      WHERE user_id = $11
      RETURNING *`,
      [businessName || null, category || null, location || null, description || null, goals || null,
       phone || null, operatingHours ? JSON.stringify(operatingHours) : null,
       notificationPrefs ? JSON.stringify(notificationPrefs) : null, googlePlaceId || null, photoUrl || null, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No venue profile found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update venue profile error:', err);
    res.status(500).json({ error: 'Failed to update venue profile' });
  }
});

module.exports = router;
