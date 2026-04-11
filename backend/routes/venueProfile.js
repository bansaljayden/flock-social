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

    // Set user role to venue_owner
    await pool.query('UPDATE users SET role = $1 WHERE id = $2', ['venue_owner', req.user.id]);

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

// PUT /api/venue-profile — update venue profile
router.put('/', [
  body('businessName').optional().trim(),
  body('category').optional().trim(),
  body('location').optional().trim(),
  body('description').optional().trim(),
  body('goals').optional().isArray(),
], async (req, res) => {
  try {
    const { businessName, category, location, description, goals } = req.body;

    const result = await pool.query(
      `UPDATE venue_profiles SET
        business_name = COALESCE($1, business_name),
        category = COALESCE($2, category),
        location = COALESCE($3, location),
        description = COALESCE($4, description),
        goals = COALESCE($5, goals),
        updated_at = NOW()
      WHERE user_id = $6
      RETURNING *`,
      [businessName || null, category || null, location || null, description || null, goals || null, req.user.id]
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
