// ---------------------------------------------------------------------------
// PUBLIC crowd demo — powers the "try it live" section on flockcorp.com.
// No auth: visitors get the real Discover experience (map pins + the full
// venue card, scored by the same ML model the app serves) before they sign up.
//
// Cost/abuse controls, since every fresh area search is a Google Places call:
//  - per-IP limit: 20 requests/hour across both endpoints
//  - global cap: 600 scored requests/day (after that: 429, the site says
//    "the demo is resting, see it in the app")
//  - aggressive caching: area searches 20 min, venue cards 10 min
// ---------------------------------------------------------------------------
const express = require('express');
const { query, param, validationResult } = require('express-validator');
const { getWeather } = require('../services/weatherService');
const mlPredictor = require('../services/mlPredictor');
const { findBestTime, findPeakTime, getLabel } = require('../services/crowdEngine');

const router = express.Router();
const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// --- limits ---------------------------------------------------------------
const ipHits = new Map(); // ip -> [timestamps]
let dayKey = new Date().toISOString().slice(0, 10);
let dayCount = 0;

function allowDemo(req) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; dayCount = 0; }
  if (dayCount >= 600) return false;

  const now = Date.now();
  const ip = req.ip || 'unknown';
  const hits = (ipHits.get(ip) || []).filter(t => now - t < 3600_000);
  if (hits.length >= 20) return false;
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) ipHits.clear(); // memory guard, resets everyone hourly-ish
  dayCount++;
  return true;
}

const DEMO_BUSY_MSG = 'The live demo is taking a breather. The full thing is in the app.';

// --- cache ----------------------------------------------------------------
const cache = new Map(); // key -> { data, expires }
function getCache(key) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  cache.delete(key);
  return null;
}
function setCache(key, data, ttlMs) {
  if (cache.size > 500) cache.clear();
  cache.set(key, { data, expires: Date.now() + ttlMs });
}

// --- helpers --------------------------------------------------------------
function priceLevelToNum(priceLevel) {
  const map = {
    PRICE_LEVEL_FREE: 0,
    PRICE_LEVEL_INEXPENSIVE: 1,
    PRICE_LEVEL_MODERATE: 2,
    PRICE_LEVEL_EXPENSIVE: 3,
    PRICE_LEVEL_VERY_EXPENSIVE: 4,
  };
  return map[priceLevel] ?? null;
}

function toVenueShape(p, localDay) {
  let openHour = null, closeHour = null;
  const periods = p.currentOpeningHours?.periods;
  if (periods && periods.length) {
    const today = localDay != null ? localDay : new Date().getDay();
    const todayPeriod = periods.find(pd => pd.open?.day === today);
    if (todayPeriod) {
      openHour = todayPeriod.open?.hour ?? null;
      closeHour = todayPeriod.close?.hour ?? null;
      if (closeHour === 0) closeHour = 24;
    }
  }
  return {
    place_id: p.id,
    name: p.displayName?.text || '',
    formatted_address: p.formattedAddress || '',
    rating: p.rating || null,
    user_ratings_total: p.userRatingCount || 0,
    price_level: priceLevelToNum(p.priceLevel),
    types: p.types || [],
    location: p.location || null,
    isOpen: p.currentOpeningHours?.openNow ?? null,
    openHour,
    closeHour,
  };
}

const PLACE_FIELDS = 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.priceLevel,places.types,places.currentOpeningHours,places.location';

// ---------------------------------------------------------------------------
// GET /api/public/demo/venues?lat=..&lng=..&q=..
// Area search -> up to 8 venues, each scored by the live model.
// ---------------------------------------------------------------------------
// Visitors' clocks, not Railway's: the server runs UTC, so scoring "now" with
// server time shifts every prediction by the visitor's UTC offset. Same
// localHour/localDay contract as GET /api/crowd.
function clientNow(req) {
  const now = new Date();
  const localHour = req.query.localHour != null ? parseInt(req.query.localHour, 10) : now.getHours();
  const localDay = req.query.localDay != null ? parseInt(req.query.localDay, 10) : now.getDay();
  const t = new Date(now);
  t.setDate(t.getDate() + (localDay - t.getDay()));
  t.setHours(localHour, 0, 0, 0);
  return { time: t, localHour, localDay };
}

router.get('/demo/venues',
  [
    query('lat').isFloat({ min: -90, max: 90 }),
    query('lng').isFloat({ min: -180, max: 180 }),
    query('q').optional().trim().isLength({ max: 60 }),
    query('localHour').optional().isInt({ min: 0, max: 23 }),
    query('localDay').optional().isInt({ min: 0, max: 6 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
      if (!API_KEY) return res.status(503).json({ error: DEMO_BUSY_MSG });

      const lat = +(+req.query.lat).toFixed(2); // ~1km buckets = shared cache
      const lng = +(+req.query.lng).toFixed(2);
      const q = (req.query.q || 'restaurants and bars').toLowerCase();
      const { time: scoreTime, localHour } = clientNow(req);

      const cacheKey = `area:${lat}:${lng}:${q}:${localHour}`;
      const cached = getCache(cacheKey);
      if (cached) return res.json(cached);

      if (!allowDemo(req)) return res.status(429).json({ error: DEMO_BUSY_MSG });

      const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': API_KEY,
          'X-Goog-FieldMask': PLACE_FIELDS,
        },
        body: JSON.stringify({
          textQuery: q,
          maxResultCount: 8,
          locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 8000.0 } },
        }),
      });
      const data = await resp.json();
      const places = (data.places || []).filter(p => p.location);
      if (places.length === 0) return res.json({ venues: [] });

      // One weather lookup for the whole area
      const weather = await getWeather(lat, lng).catch(() => null);

      const venues = [];
      for (const p of places) {
        const v = toVenueShape(p, req.query.localDay != null ? parseInt(req.query.localDay, 10) : null);
        try {
          const scored = await mlPredictor.predictBusyness(v, weather, scoreTime);
          venues.push({
            place_id: v.place_id,
            name: v.name,
            address: v.formatted_address,
            rating: v.rating,
            price_level: v.price_level,
            lat: v.location.latitude,
            lng: v.location.longitude,
            is_open: v.isOpen,
            score: scored.score,
            label: getLabel(scored.score),
          });
        } catch { /* skip venues the model can't score */ }
      }

      const result = { venues };
      setCache(cacheKey, result, 20 * 60_000);
      res.json(result);
    } catch (err) {
      console.error('[PublicDemo] venues error:', err.message);
      res.status(500).json({ error: DEMO_BUSY_MSG });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/public/demo/venue/:placeId — the full card: dial + forecast + best time
// ---------------------------------------------------------------------------
router.get('/demo/venue/:placeId',
  [
    param('placeId').trim().isLength({ min: 1, max: 200 }),
    query('localHour').optional().isInt({ min: 0, max: 23 }),
    query('localDay').optional().isInt({ min: 0, max: 6 }),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
      if (!API_KEY) return res.status(503).json({ error: DEMO_BUSY_MSG });

      const placeId = req.params.placeId;
      const { time: scoreTime, localHour } = clientNow(req);
      const cacheKey = `venue:${placeId}:${localHour}`;
      const cached = getCache(cacheKey);
      if (cached) return res.json(cached);

      if (!allowDemo(req)) return res.status(429).json({ error: DEMO_BUSY_MSG });

      const resp = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
        headers: {
          'X-Goog-Api-Key': API_KEY,
          'X-Goog-FieldMask': PLACE_FIELDS.replaceAll('places.', ''),
        },
      });
      const p = await resp.json();
      if (p.error || !p.id) return res.status(404).json({ error: 'Venue not found' });

      const v = toVenueShape(p, req.query.localDay != null ? parseInt(req.query.localDay, 10) : null);
      const lat = v.location?.latitude;
      const lng = v.location?.longitude;
      const weather = (lat && lng) ? await getWeather(lat, lng).catch(() => null) : null;

      const scored = await mlPredictor.predictBusyness(v, weather, scoreTime);
      const hourly = await mlPredictor.predictHourlyForecast(v, weather, localHour, 12, scoreTime);
      const fullDay = await mlPredictor.predictHourlyForecast(v, weather, 6, 24, scoreTime);
      const peakResult = findPeakTime(fullDay, v);
      const bestTime = findBestTime(fullDay, v, peakResult.startIdx, peakResult.endIdx, v.isOpen);

      const result = {
        place_id: v.place_id,
        name: v.name,
        address: v.formatted_address,
        rating: v.rating,
        reviews: v.user_ratings_total,
        price_level: v.price_level,
        is_open: v.isOpen,
        score: scored.score,
        label: getLabel(scored.score),
        confidence: scored.confidence,
        best_time: bestTime,
        peak_hours: peakResult.text,
        hourly: hourly.map(h => ({ hour: h.hour, label: h.label, score: h.score })),
      };
      setCache(cacheKey, result, 10 * 60_000);
      res.json(result);
    } catch (err) {
      console.error('[PublicDemo] venue error:', err.message);
      res.status(500).json({ error: DEMO_BUSY_MSG });
    }
  }
);

module.exports = router;
