const express = require('express');
const { query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { getWeather, getForecast } = require('../services/weatherService');

const router = express.Router();

router.use(authenticate);

// THIS ROUTER IS THE ENUMERATION SURFACE FOR A PAID API.
//
// Both endpoints take latitude and longitude straight from the caller, and
// weatherService's daily and per-minute ceilings are GLOBAL. Authentication is
// not a spending control: one signed-in account walking coordinates at 0.01
// resolution can spend the whole daily allowance and deny weather to every
// crowd score in the product for the rest of the day, and the general API
// limiter (3000 / 15 min) sits far above that ceiling. So both calls below pass
// the caller's id, which switches on the per-user hourly ceiling in
// services/weatherService.js.
//
// Routes that derive coordinates from a venue rather than from user input
// (crowd, publicCrowd, badge, venueDashboard) are NOT this surface and
// deliberately keep calling with two arguments.

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
      const weather = await getWeather(lat, lon, { userId: req.user.id });

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
      const forecast = await getForecast(lat, lon, { userId: req.user.id });

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
