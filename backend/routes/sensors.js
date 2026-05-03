const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const pool = require('../config/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /api/sensors/data
// Pi sensor unit pushes a reading. Auth via x-api-key header (NOT JWT).
// ---------------------------------------------------------------------------
router.post('/data',
  body('ir_beam_count').isInt({ min: 0 }).withMessage('ir_beam_count must be an integer >= 0'),
  body('thermal_headcount').isInt({ min: 0, max: 1000 }).withMessage('thermal_headcount must be 0-1000'),
  body('noise_db').isFloat({ min: 0, max: 200 }).withMessage('noise_db must be 0-200'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const apiKey = req.headers['x-api-key'];
      if (!apiKey) return res.status(401).json({ error: 'Missing x-api-key header' });

      const deviceLookup = await pool.query(
        'SELECT device_id, venue_place_id, is_active FROM sensor_devices WHERE api_key = $1',
        [apiKey]
      );
      if (deviceLookup.rows.length === 0) return res.status(401).json({ error: 'Invalid API key' });
      const device = deviceLookup.rows[0];
      if (!device.is_active) return res.status(401).json({ error: 'Device deactivated' });

      // Mark device alive + insert reading
      await pool.query('UPDATE sensor_devices SET last_seen_at = NOW() WHERE api_key = $1', [apiKey]);

      const { ir_beam_count, thermal_headcount, noise_db } = req.body;
      const insert = await pool.query(
        `INSERT INTO venue_sensor_data
          (venue_place_id, ir_beam_count, thermal_headcount, noise_db, sensor_device_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING recorded_at`,
        [device.venue_place_id, ir_beam_count, thermal_headcount, noise_db, device.device_id]
      );
      const recorded_at = insert.rows[0].recorded_at;

      const io = req.app.get('io');
      if (io) {
        io.to(`venue:${device.venue_place_id}`).emit('venue_sensor_update', {
          venue_place_id: device.venue_place_id,
          ir_beam_count,
          thermal_headcount,
          noise_db,
          recorded_at,
        });
      }

      res.status(201).json({ success: true, recorded_at });
    } catch (err) {
      console.error('Sensor data ingest error:', err);
      res.status(500).json({ error: 'Failed to ingest sensor data' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/sensors/:placeId/current — most recent reading + recent checkins
// ---------------------------------------------------------------------------
router.get('/:placeId/current', authenticate, async (req, res) => {
  try {
    const { placeId } = req.params;
    if (!placeId) return res.status(400).json({ error: 'placeId required' });

    const reading = await pool.query(
      `SELECT venue_place_id, ir_beam_count, thermal_headcount, noise_db,
              sensor_device_id, recorded_at
       FROM venue_sensor_data
       WHERE venue_place_id = $1
       ORDER BY recorded_at DESC
       LIMIT 1`,
      [placeId]
    );

    const checkins = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM venue_checkins
       WHERE venue_place_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
      [placeId]
    );

    res.json({
      sensor_data: reading.rows[0] || null,
      recent_checkins: checkins.rows[0]?.count || 0,
    });
  } catch (err) {
    console.error('Get current sensor data error:', err);
    res.status(500).json({ error: 'Failed to fetch sensor data' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/sensors/:placeId/history?hours=24 — hourly-bucketed readings for charts
// One row per hour: thermal/noise are AVG, ir_beam_count is SUM (cumulative entries
// per hour). Empty hours are omitted — frontends construct fixed-width slot arrays
// and treat missing hours as gaps.
// ---------------------------------------------------------------------------
router.get('/:placeId/history',
  authenticate,
  query('hours').optional().isInt({ min: 1, max: 168 }).withMessage('hours must be 1-168'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const { placeId } = req.params;
      const hours = parseInt(req.query.hours, 10) || 24;

      const result = await pool.query(
        `SELECT
           date_trunc('hour', recorded_at) AS recorded_at,
           ROUND(AVG(thermal_headcount))::int AS thermal_headcount,
           SUM(ir_beam_count)::int AS ir_beam_count,
           ROUND(AVG(noise_db)::numeric, 2) AS noise_db,
           COUNT(*)::int AS sample_count
         FROM venue_sensor_data
         WHERE venue_place_id = $1
           AND recorded_at >= NOW() - INTERVAL '1 hour' * $2
         GROUP BY date_trunc('hour', recorded_at)
         ORDER BY recorded_at ASC`,
        [placeId, hours]
      );

      res.json({ readings: result.rows });
    } catch (err) {
      console.error('Get sensor history error:', err);
      res.status(500).json({ error: 'Failed to fetch sensor history' });
    }
  }
);

module.exports = router;
