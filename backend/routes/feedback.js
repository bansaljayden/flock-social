const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');

const router = express.Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// POST /api/feedback — Submit post-hangout venue feedback
// ---------------------------------------------------------------------------
router.post('/',
  [
    body('venue_place_id').trim().isLength({ min: 1 }).withMessage('venue_place_id is required'),
    body('venue_name').trim().isLength({ min: 1 }).withMessage('venue_name is required'),
    body('crowd_level').isInt({ min: 1, max: 3 }).withMessage('crowd_level must be 1-3'),
    body('price_worth').optional().isBoolean().withMessage('price_worth must be a boolean'),
    body('rating').optional().isInt({ min: 1, max: 5 }).withMessage('rating must be 1-5'),
    body('predicted_score').optional().isInt({ min: 0, max: 100 }).withMessage('predicted_score must be 0-100'),
    body('flock_id').optional().isUUID().withMessage('flock_id must be a valid UUID'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const {
        venue_place_id,
        venue_name,
        crowd_level,
        price_worth,
        rating,
        predicted_score,
        flock_id,
      } = req.body;

      const result = await pool.query(
        `INSERT INTO venue_feedback
          (user_id, flock_id, venue_place_id, venue_name, crowd_level, price_worth, rating, predicted_score, day_of_week, hour)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, EXTRACT(DOW FROM NOW()), EXTRACT(HOUR FROM NOW()))
        RETURNING *`,
        [req.user.id, flock_id || null, venue_place_id, venue_name, crowd_level, price_worth ?? null, rating || null, predicted_score ?? null]
      );

      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error('[Feedback] Submit error:', err);
      res.status(500).json({ error: 'Failed to submit feedback' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/feedback/venue/:placeId — Aggregate feedback for a venue
// ---------------------------------------------------------------------------
router.get('/venue/:placeId',
  param('placeId').trim().isLength({ min: 1 }).withMessage('placeId is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const placeId = req.params.placeId;

      // Overall aggregates
      const overall = await pool.query(
        `SELECT
          COUNT(*)::int AS total_feedback,
          ROUND(AVG(crowd_level)::numeric, 1) AS avg_crowd_level,
          ROUND(AVG(rating)::numeric, 1) AS avg_rating,
          ROUND(100.0 * COUNT(*) FILTER (WHERE price_worth = true) / NULLIF(COUNT(*) FILTER (WHERE price_worth IS NOT NULL), 0), 0) AS price_worth_percent
        FROM venue_feedback
        WHERE venue_place_id = $1`,
        [placeId]
      );

      // Breakdown by day of week
      const byDay = await pool.query(
        `SELECT
          day_of_week,
          ROUND(AVG(crowd_level)::numeric, 1) AS avg_crowd_level,
          COUNT(*)::int AS count
        FROM venue_feedback
        WHERE venue_place_id = $1
        GROUP BY day_of_week
        ORDER BY day_of_week`,
        [placeId]
      );

      const byDayOfWeek = {};
      for (const row of byDay.rows) {
        byDayOfWeek[row.day_of_week] = {
          avgCrowdLevel: parseFloat(row.avg_crowd_level),
          count: row.count,
        };
      }

      const row = overall.rows[0];
      res.json({
        placeId,
        totalFeedback: row.total_feedback,
        avgCrowdLevel: row.avg_crowd_level ? parseFloat(row.avg_crowd_level) : null,
        avgRating: row.avg_rating ? parseFloat(row.avg_rating) : null,
        priceWorthPercent: row.price_worth_percent ? parseFloat(row.price_worth_percent) : null,
        byDayOfWeek,
      });
    } catch (err) {
      console.error('[Feedback] Aggregate error:', err);
      res.status(500).json({ error: 'Failed to fetch feedback' });
    }
  }
);

module.exports = router;
