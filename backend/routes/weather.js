const express = require('express');
const { query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { getWeather, getForecast } = require('../services/weatherService');

const router = express.Router();

router.use(authenticate);

// GET /api/weather?lat=...&lon=...
router.get('/',
  query('lat').isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
  query('lon').isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const lat = parseFloat(req.query.lat);
      const lon = parseFloat(req.query.lon);
      const weather = await getWeather(lat, lon);

      if (!weather) {
        return res.status(502).json({ error: 'Weather data unavailable' });
      }

      res.json(weather);
    } catch (err) {
      console.error('[Weather] Route error:', err);
      res.status(500).json({ error: 'Failed to fetch weather' });
    }
  }
);

// GET /api/weather/forecast?lat=...&lon=... — 5-day daily forecast
router.get('/forecast',
  query('lat').isFloat({ min: -90, max: 90 }).withMessage('Valid latitude required'),
  query('lon').isFloat({ min: -180, max: 180 }).withMessage('Valid longitude required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const lat = parseFloat(req.query.lat);
      const lon = parseFloat(req.query.lon);
      const forecast = await getForecast(lat, lon);

      if (!forecast) {
        return res.status(502).json({ error: 'Forecast data unavailable' });
      }

      res.json({ forecast });
    } catch (err) {
      console.error('[Weather] Forecast route error:', err);
      res.status(500).json({ error: 'Failed to fetch forecast' });
    }
  }
);

module.exports = router;
