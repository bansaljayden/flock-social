const express = require('express');
const { query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { getWeather, getForecast } = require('../services/weatherService');
// Shape before content — see validators/shape.js.
const { scalarOnly } = require('../validators/shape');

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

// SHAPE BEFORE CONTENT (§O round). `?lat=39.7&lat=40` — and its `?lat[]=`
// twin — makes req.query.lat an ARRAY, and express-validator 7 expands an
// array-valued field into one instance PER ELEMENT and validates each on its
// own, so two perfectly good latitudes satisfy isFloat and the value stays an
// array. `parseFloat(['39.7','40'])` is 39.7: the second coordinate is
// silently dropped and the caller is charged for, and shown, weather somewhere
// they did not ask about. Two latitudes is not a latitude; it is a 400.
const scalarCoord = (name, min, max, label) =>
  scalarOnly(query(name), label).isFloat({ min, max }).withMessage(`Valid ${label} required`);

// GET /api/weather?lat=...&lon=...
router.get('/',
  scalarCoord('lat', -90, 90, 'latitude'),
  scalarCoord('lon', -180, 180, 'longitude'),
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
  scalarCoord('lat', -90, 90, 'latitude'),
  scalarCoord('lon', -180, 180, 'longitude'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const lat = parseFloat(req.query.lat);
      const lon = parseFloat(req.query.lon);
      const forecast = await getForecast(lat, lon, { userId: req.user.id });

      // AN EMPTY FORECAST IS NOT A FORECAST (§O round: "does nothing").
      //
      // `if (!forecast)` was the whole guard, and an empty ARRAY is truthy. So
      // a 200 from OpenWeatherMap whose `list` held nothing this route could
      // read — a malformed payload, a partial response, an upstream having a
      // bad minute — was served to the client as `{ forecast: [] }` with a 200,
      // which reads as "we have the next five days and there is nothing to say
      // about them". The honest answer is the one getForecast gives for every
      // other kind of failure: we have no forecast.
      //
      // weatherService caches that empty array as a SUCCESS for thirty minutes,
      // so the wrong answer outlives the bad response by a long way. That part
      // is in services/weatherService.js, which this router does not own — see
      // the handoff note in the audit report.
      if (!forecast || (Array.isArray(forecast) && forecast.length === 0)) {
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
