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
const { upstreamSignal } = require('../utils/upstream');
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
      // Midnight close is 24, not 0, so a 10 AM - 12 AM day stays a normal
      // window. An overnight venue still lands here as open 22 / close 3 —
      // that wrap is handled by crowdEngine.hourInWindow (round 11), which is
      // the single place open/closed is decided.
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

const PLACE_FIELDS = 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.priceLevel,places.types,places.currentOpeningHours,places.location,places.photos';

// The full venue card: current score + best time + peak + 12h forecast.
async function buildCard(v, weather, scoreTime, localHour) {
  const scored = await mlPredictor.predictBusyness(v, weather, scoreTime);
  const [hourly, fullDay] = await Promise.all([
    mlPredictor.predictHourlyForecast(v, weather, localHour, 12, scoreTime),
    mlPredictor.predictHourlyForecast(v, weather, 6, 24, scoreTime),
  ]);
  const peakResult = findPeakTime(fullDay, v);
  const bestTime = findBestTime(fullDay, v, peakResult.startIdx, peakResult.endIdx, v.isOpen);
  return {
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
    as_of: Date.now(),
  };
}

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
      const { time: scoreTime, localHour, localDay } = clientNow(req);

      // localDay changes the score, so it MUST be in the key — otherwise a
      // weekend request could poison the weekday cache (round 6).
      const cacheKey = `area:${lat}:${lng}:${q}:${localDay}:${localHour}`;
      const cached = getCache(cacheKey);
      if (cached) return res.json(cached);

      if (!allowDemo(req)) return res.status(429).json({ error: DEMO_BUSY_MSG });

      // Round 11: resp.ok was never checked, so a quota, auth or upstream
      // outage came back as a 200 with an empty venue list and the marketing
      // page told visitors their city had no spots. An upstream failure is now
      // an explicit 503 the page can be honest about; only a real zero-result
      // search returns 200 with an empty list.
      let resp;
      try {
        resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
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
          // Round 12: a timeout lands in the catch below, which already turns
          // an unreachable upstream into an honest 503.
          signal: upstreamSignal('places'),
        });
      } catch (netErr) {
        console.error('[PublicDemo] Places search unreachable:', netErr.message);
        return res.status(503).json({ error: DEMO_BUSY_MSG, unavailable: true });
      }
      if (!resp.ok) {
        console.error(`[PublicDemo] Places search failed: HTTP ${resp.status}`);
        return res.status(503).json({ error: DEMO_BUSY_MSG, unavailable: true });
      }

      const data = await resp.json();
      if (data.error) {
        console.error('[PublicDemo] Places search error:', data.error.message || data.error.status);
        return res.status(503).json({ error: DEMO_BUSY_MSG, unavailable: true });
      }
      const places = (data.places || []).filter(p => p.location);
      if (places.length === 0) return res.json({ venues: [] });

      // One weather lookup for the whole area; venues scored in parallel —
      // serial scoring made the first paint feel like dial-up.
      const weather = await getWeather(lat, lng).catch(() => null);
      const localDayParam = req.query.localDay != null ? parseInt(req.query.localDay, 10) : null;

      const venues = (await Promise.all(places.map(async (p) => {
        const v = toVenueShape(p, localDayParam);
        try {
          const scored = await mlPredictor.predictBusyness(v, weather, scoreTime);
          return {
            place_id: v.place_id,
            name: v.name,
            address: v.formatted_address,
            rating: v.rating,
            price_level: v.price_level,
            lat: v.location.latitude,
            lng: v.location.longitude,
            is_open: v.isOpen,
            // The photo proxy takes a Google photo resource ref, not a place id
            photo_url: p.photos?.[0]?.name ? `/api/venues/photo?ref=${encodeURIComponent(p.photos[0].name)}&maxwidth=160` : null,
            score: scored.score,
            label: getLabel(scored.score),
          };
        } catch { return null; } // skip venues the model can't score
      }))).filter(Boolean);

      const result = { venues };

      // Embed the busiest venue's full card so the section renders in ONE
      // round trip instead of venues -> card chaining.
      if (venues.length > 0) {
        try {
          const busiest = [...venues].sort((a, b) => b.score - a.score)[0];
          const bp = places.find(p => p.id === busiest.place_id);
          const bv = toVenueShape(bp, localDayParam);
          result.card = await buildCard(bv, weather, scoreTime, localHour);
        } catch { /* card arrives via the venue endpoint instead */ }
      }

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
      const { time: scoreTime, localHour, localDay } = clientNow(req);
      const cacheKey = `venue:${placeId}:${localDay}:${localHour}`;
      const cached = getCache(cacheKey);
      if (cached) return res.json(cached);

      if (!allowDemo(req)) return res.status(429).json({ error: DEMO_BUSY_MSG });

      // Round 11: same as the area search — an upstream failure used to read as
      // "Venue not found". Only a real upstream 404 is a 404 now.
      let resp;
      try {
        resp = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
          headers: {
            'X-Goog-Api-Key': API_KEY,
            'X-Goog-FieldMask': PLACE_FIELDS.replaceAll('places.', ''),
          },
          signal: upstreamSignal('places'), // round 12
        });
      } catch (netErr) {
        console.error('[PublicDemo] Places details unreachable:', netErr.message);
        return res.status(503).json({ error: DEMO_BUSY_MSG, unavailable: true });
      }
      if (!resp.ok) {
        if (resp.status === 404) return res.status(404).json({ error: 'Venue not found' });
        console.error(`[PublicDemo] Places details failed: HTTP ${resp.status}`);
        return res.status(503).json({ error: DEMO_BUSY_MSG, unavailable: true });
      }

      const p = await resp.json();
      if (p.error || !p.id) return res.status(404).json({ error: 'Venue not found' });

      const v = toVenueShape(p, req.query.localDay != null ? parseInt(req.query.localDay, 10) : null);
      const lat = v.location?.latitude;
      const lng = v.location?.longitude;
      const weather = (lat && lng) ? await getWeather(lat, lng).catch(() => null) : null;

      const result = await buildCard(v, weather, scoreTime, localHour);
      setCache(cacheKey, result, 10 * 60_000);
      res.json(result);
    } catch (err) {
      console.error('[PublicDemo] venue error:', err.message);
      res.status(500).json({ error: DEMO_BUSY_MSG });
    }
  }
);

module.exports = router;
