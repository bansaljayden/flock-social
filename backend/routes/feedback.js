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
    // Flock ids are integers (SERIAL) — the old UUID validator rejected every
    // legitimate post-hangout feedback submission (audit 2026-08-12)
    body('flock_id').optional().isInt().withMessage('flock_id must be a valid flock id'),
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

      // Anti-forgery (audit 2026-08-12): one report per user per venue per 2h
      // window. Unlimited reports let a single account own a venue's live
      // calibration AND poison future training labels. Newest report wins
      // within the window (people can correct themselves).
      // Round 4: the dedup + hourly cap + insert run in ONE transaction under
      // a per-user advisory lock — as autocommit statements, concurrent
      // submissions could all pass the count and blow through both limits.
      const client = await pool.connect();
      let inserted;
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [81422, req.user.id]);

        await client.query(
          `DELETE FROM venue_feedback
           WHERE user_id = $1 AND venue_place_id = $2 AND created_at > NOW() - INTERVAL '2 hours'`,
          [req.user.id, venue_place_id]
        );
        const recentCount = await client.query(
          `SELECT COUNT(*)::int AS n FROM venue_feedback
           WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
          [req.user.id]
        );
        if ((recentCount.rows[0]?.n || 0) >= 10) {
          await client.query('ROLLBACK');
          return res.status(429).json({ error: 'Too many reports in a short time. Try again later.' });
        }

        // Round 5: mark feedback "verified" only when we have independent
        // evidence the user was actually there — a recent check-in at the
        // venue, or accepted membership in a flock that met at this venue
        // around now. Unverified rows are still stored (product UX) but are
        // excluded from live calibration and training export: otherwise
        // Sybil accounts could steer public crowd predictions and poison
        // future model features with fabricated reports.
        const verifiedCheck = await client.query(
          `SELECT
             EXISTS (
               SELECT 1 FROM venue_checkins
               WHERE user_id = $1
                 AND venue_place_id = $2
                 AND created_at > NOW() - INTERVAL '3 hours'
                 -- NFC taps prove physical presence; a self-reported manual
                 -- check-in does not, so it cannot mint verification (round 6)
                 AND COALESCE(checkin_source, 'nfc') <> 'manual'
             )
             OR EXISTS (
               SELECT 1
               FROM flock_members fm
               JOIN flocks f ON f.id = fm.flock_id
               WHERE fm.user_id = $1
                 AND fm.status = 'accepted'
                 AND f.venue_id = $2
                 AND f.event_time BETWEEN NOW() - INTERVAL '12 hours'
                                      AND NOW() + INTERVAL '12 hours'
             ) AS verified`,
          [req.user.id, venue_place_id]
        );
        const verified = verifiedCheck.rows[0]?.verified === true;

        const result = await client.query(
          `INSERT INTO venue_feedback
            (user_id, flock_id, venue_place_id, venue_name, crowd_level, price_worth, rating, predicted_score, day_of_week, hour, verified)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, EXTRACT(DOW FROM NOW()), EXTRACT(HOUR FROM NOW()), $9)
          RETURNING *`,
          [req.user.id, flock_id || null, venue_place_id, venue_name, crowd_level, price_worth ?? null, rating || null, predicted_score ?? null, verified]
        );
        inserted = result.rows[0];

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }

      res.status(201).json(inserted);
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
