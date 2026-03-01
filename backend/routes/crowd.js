const express = require('express');
const { param, body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { getWeather } = require('../services/weatherService');
const {
  calculateCrowdScore,
  generateHourlyForecast,
  estimateCapacity,
  estimateWait,
  findBestTime,
  findPeakTime,
  findQuieterAlternatives,
} = require('../services/crowdEngine');

const router = express.Router();
const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// ---------------------------------------------------------------------------
// Cache (10-min TTL for crowd predictions)
// ---------------------------------------------------------------------------
const crowdCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function getCached(key) {
  const entry = crowdCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  if (entry) crowdCache.delete(key);
  return null;
}

function setCache(key, data) {
  crowdCache.set(key, { data, ts: Date.now() });
  if (crowdCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of crowdCache) {
      if (now - v.ts > CACHE_TTL) crowdCache.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function priceLevelToNum(priceLevel) {
  const map = {
    'PRICE_LEVEL_FREE': 0,
    'PRICE_LEVEL_INEXPENSIVE': 1,
    'PRICE_LEVEL_MODERATE': 2,
    'PRICE_LEVEL_EXPENSIVE': 3,
    'PRICE_LEVEL_VERY_EXPENSIVE': 4,
  };
  return map[priceLevel] ?? null;
}

async function fetchVenueFromGoogle(placeId) {
  if (!API_KEY) return null;

  const response = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': 'id,displayName,formattedAddress,rating,userRatingCount,priceLevel,types,location,currentOpeningHours',
    },
  });

  const p = await response.json();
  if (p.error) return null;

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
  };
}

// All routes require auth
router.use(authenticate);

// ---------------------------------------------------------------------------
// GET /api/crowd/:placeId — Full crowd prediction for one venue
// ---------------------------------------------------------------------------
router.get('/:placeId',
  param('placeId').trim().isLength({ min: 1 }).withMessage('placeId is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const placeId = req.params.placeId;

      // Check cache (include local time in key so different hours aren't stale)
      const cacheKey = `full:${placeId}:${req.query.localHour || ''}:${req.query.localDay || ''}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);

      // Fetch venue from Google Places
      const venue = await fetchVenueFromGoogle(placeId);
      if (!venue) {
        return res.status(502).json({ error: 'Failed to fetch venue data from Google Places' });
      }

      // Get weather (may return null)
      const lat = venue.location?.latitude;
      const lon = venue.location?.longitude;
      const weather = (lat && lon) ? await getWeather(lat, lon) : null;

      // Use client's local time if provided, else fall back to server time
      const now = new Date();
      const localHour = req.query.localHour != null ? parseInt(req.query.localHour, 10) : now.getHours();
      const localDay = req.query.localDay != null ? parseInt(req.query.localDay, 10) : now.getDay();

      // Build a timestamp with the client's local hour/day for accurate scoring
      const clientTime = new Date(now);
      // Adjust to match client's day of week and hour
      const serverDay = clientTime.getDay();
      const dayDiff = localDay - serverDay;
      clientTime.setDate(clientTime.getDate() + dayDiff);
      clientTime.setHours(localHour, 0, 0, 0);

      const crowdResult = calculateCrowdScore(venue, weather, clientTime);
      const hourly = generateHourlyForecast(venue, weather, localHour, 12);
      const capacity = estimateCapacity(venue, crowdResult.score);

      // Full-day forecast (6 AM - 5 AM) for accurate peak/best detection
      const fullDay = generateHourlyForecast(venue, weather, 6, 24);
      const peakResult = findPeakTime(fullDay);
      const bestTime = findBestTime(fullDay, venue, peakResult.startIdx, peakResult.endIdx);

      const waitEstimateTyped = estimateWait(crowdResult.score, venue.types);

      const result = {
        placeId,
        name: venue.name,
        score: crowdResult.score,
        label: crowdResult.label,
        confidence: crowdResult.confidence,
        capacity,
        bestTime,
        peak: peakResult.text,
        waitEstimate: waitEstimateTyped,
        isOpen: venue.isOpen,
        hourly,
        factors: crowdResult.factors,
        dataSourcesUsed: crowdResult.dataSourcesUsed,
        weather: weather ? { temp: weather.temp, conditions: weather.conditions } : null,
        lastUpdated: now.toISOString(),
      };

      setCache(cacheKey, result);
      res.json(result);
    } catch (err) {
      console.error('[Crowd] Prediction error:', err);
      res.status(500).json({ error: 'Failed to generate crowd prediction' });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/crowd/batch — Batch predictions (uses frontend venue data)
// ---------------------------------------------------------------------------
router.post('/batch',
  body('venues').isArray({ min: 1, max: 20 }).withMessage('venues must be an array (1-20 items)'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { venues, localHour, localDay } = req.body;
      const now = new Date();

      // Use client's local time if provided
      const clientTime = new Date(now);
      if (localHour != null && localDay != null) {
        const dayDiff = localDay - clientTime.getDay();
        clientTime.setDate(clientTime.getDate() + dayDiff);
        clientTime.setHours(localHour, 0, 0, 0);
      }

      // Get weather once from the first venue's location
      const firstLoc = venues[0]?.location;
      const weather = (firstLoc?.latitude && firstLoc?.longitude)
        ? await getWeather(firstLoc.latitude, firstLoc.longitude)
        : null;

      const predictions = venues.map(v => {
        const result = calculateCrowdScore(v, weather, clientTime);
        return {
          placeId: v.place_id,
          name: v.name,
          score: result.score,
          label: result.label,
          confidence: result.confidence,
        };
      });

      res.json({
        predictions,
        weather: weather ? { temp: weather.temp, conditions: weather.conditions } : null,
        timestamp: now.toISOString(),
      });
    } catch (err) {
      console.error('[Crowd] Batch prediction error:', err);
      res.status(500).json({ error: 'Failed to generate batch predictions' });
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/crowd/:placeId/alternatives — Quieter nearby venues
// ---------------------------------------------------------------------------
router.get('/:placeId/alternatives',
  param('placeId').trim().isLength({ min: 1 }).withMessage('placeId is required'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const placeId = req.params.placeId;

      // Fetch target venue
      const target = await fetchVenueFromGoogle(placeId);
      if (!target) {
        return res.status(502).json({ error: 'Failed to fetch venue data' });
      }

      const lat = target.location?.latitude;
      const lon = target.location?.longitude;
      if (!lat || !lon) {
        return res.status(400).json({ error: 'Venue has no location data' });
      }

      // Get weather
      const weather = await getWeather(lat, lon);

      // Score the target venue
      const now = new Date();
      const targetResult = calculateCrowdScore(target, weather, now);

      // Search nearby venues of similar type
      const primaryType = target.types[0] || 'restaurant';
      const searchResponse = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': API_KEY,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.rating,places.userRatingCount,places.priceLevel,places.types,places.location',
        },
        body: JSON.stringify({
          textQuery: primaryType,
          locationBias: {
            circle: { center: { latitude: lat, longitude: lon }, radius: 2000.0 },
          },
          maxResultCount: 10,
        }),
      });

      const searchData = await searchResponse.json();
      const nearby = (searchData.places || [])
        .filter(p => p.id !== placeId)
        .map(p => ({
          place_id: p.id,
          name: p.displayName?.text || '',
          rating: p.rating || null,
          user_ratings_total: p.userRatingCount || 0,
          price_level: priceLevelToNum(p.priceLevel),
          types: p.types || [],
          location: p.location || null,
        }));

      const alternatives = findQuieterAlternatives(nearby, targetResult.score, weather, now, 3);

      res.json({
        currentVenue: { name: target.name, score: targetResult.score },
        alternatives,
      });
    } catch (err) {
      console.error('[Crowd] Alternatives error:', err);
      res.status(500).json({ error: 'Failed to find alternatives' });
    }
  }
);

module.exports = router;
