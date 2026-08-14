const express = require('express');
const { param, body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { getWeather } = require('../services/weatherService');
const crowdEngine = require('../services/crowdEngine');
const { buildHoursByDay } = crowdEngine;
const mlPredictor = require('../services/mlPredictor');
const { upstreamSignal } = require('../utils/upstream');

// Use ML predictor when available, fall back to rule engine
const {
  estimateCapacity,
  estimateWait,
  findPeakTime,
  buildCalibrationAdjustment,
  getLabel,
} = mlPredictor;
const pool = require('../config/database');
const { isPremium, paywallEnabled } = require('../services/entitlements');
const { FREE_MONTHLY_FORECASTS, getUsedThisMonth, recordView } = require('../services/forecastUsage');

const router = express.Router();

// Flock Pro gate for the single-venue AI forecast. The live "how busy now" score
// stays free; best-time / hourly / peak are free for the first N venue views a
// month, then Pro. Returns a per-request copy so the shared cache stays ungated.
// `count` = true means this request should consume one of the free allowance
// (only the single-venue detail view counts, not batch/list previews).
async function gateForecast(result, userId, { count } = {}) {
  // Paywall off (or unset) → today's behavior, unlimited, no meter.
  if (!paywallEnabled()) return result;
  if (await isPremium(userId)) {
    return { ...result, forecastAccess: { locked: false, remaining: null, limit: null } };
  }
  const usedBefore = getUsedThisMonth(userId);
  if (usedBefore >= FREE_MONTHLY_FORECASTS) {
    // Allowance spent — strip the premium prediction, keep the free live score.
    return {
      ...result,
      bestTime: null,
      hourly: [],
      peak: null,
      forecastAccess: { locked: true, remaining: 0, limit: FREE_MONTHLY_FORECASTS },
    };
  }
  const usedNow = count ? recordView(userId) : usedBefore;
  return {
    ...result,
    forecastAccess: { locked: false, remaining: Math.max(0, FREE_MONTHLY_FORECASTS - usedNow), limit: FREE_MONTHLY_FORECASTS },
  };
}
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
    // Fresh-but-oversized: evict oldest so unique-key spam can't grow it (round 8)
    while (crowdCache.size > 200) crowdCache.delete(crowdCache.keys().next().value);
  }
}

// Paid-call budget shared with venueSearch (round 8: these fetches bypassed it)
const { allowPlacesSearch } = require('../utils/placesBudget');

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

async function fetchVenueFromGoogle(placeId, clientDay) {
  if (!API_KEY) return null;

  const response = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': API_KEY,
      'X-Goog-FieldMask': 'id,displayName,formattedAddress,rating,userRatingCount,priceLevel,types,location,currentOpeningHours,utcOffsetMinutes',
    },
    // Round 12: no deadline meant a hung Google socket parked this request (and
    // its pg pool slot) for ~5 minutes. See utils/upstream.js.
    signal: upstreamSignal('places'),
  });

  const p = await response.json();
  if (p.error) return null;

  // Extract opening hours. Round 14: one window for "today" could not express
  // a 24-hour venue (Google sends no `close` at all), split lunch/dinner
  // service, or a day the venue is dark, and all three drew a wrong card. The
  // per-day map is what the engine reads now; the scalars below stay for
  // clients still reading a single window.
  const periods = p.currentOpeningHours?.periods;
  const hoursByDay = buildHoursByDay(periods);
  // The venue's OWN weekday decides "today's hours", not the viewer's. A bar in
  // Los Angeles is still on Friday's window while a viewer in London has rolled
  // over to Saturday, and the card is scored on the venue's clock — so the
  // displayed hours must use the same day the score does, or the two disagree by
  // a day. Mirrors publicCrowd.toVenueShape. Falls back to the caller's day, then
  // the server's, when Google gives us no offset.
  const venueDay = crowdEngine.venueLocalNow(p.utcOffsetMinutes)?.day;
  const today = venueDay != null ? venueDay : (clientDay != null ? clientDay : new Date().getDay()); // 0=Sun
  const hoursToday = hoursByDay ? (hoursByDay[today] || []) : [];
  const todayWindow = hoursToday[0] || null;
  const openHour = todayWindow ? todayWindow.open : null;
  const closeHour = todayWindow ? todayWindow.close : null;
  const closeMinute = todayWindow ? todayWindow.closeMinute : 0;

  return {
    hoursByDay,
    hoursToday,
    closeMinute,
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
    // The field mask fetches this and the whole venue-clock path depends on it:
    // venueLocalNow (scores on the venue's wall clock) and trueEventInstant
    // (the Ticketmaster query window) both read venue.utcOffsetMinutes. Dropping
    // it here silently reverted BOTH to the server/viewer clock — the exact bug
    // the venue-clock rewrite was meant to kill. Google omits it for some
    // places, so it stays nullable and callers fall back to the caller's clock.
    utcOffsetMinutes: p.utcOffsetMinutes != null ? p.utcOffsetMinutes : null,
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

      // Use client's local time if provided, else fall back to server time.
      // Parse BEFORE building the cache key: raw query strings like '12a'/'12b'
      // parseInt to the same prediction but minted distinct cache entries and
      // Google calls (round 8).
      const now = new Date();
      let localHour = req.query.localHour != null ? parseInt(req.query.localHour, 10) : now.getHours();
      let localDay = req.query.localDay != null ? parseInt(req.query.localDay, 10) : now.getDay();
      if (!Number.isInteger(localHour) || localHour < 0 || localHour > 23) localHour = now.getHours();
      if (!Number.isInteger(localDay) || localDay < 0 || localDay > 6) localDay = now.getDay();

      // Check cache (include local time in key so different hours aren't stale)
      const cacheKey = `full:${placeId}:${localHour}:${localDay}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(await gateForecast(cached, req.user.id, { count: true }));

      if (!allowPlacesSearch(req.user.id)) {
        return res.status(429).json({ error: 'Loading venues too fast. Give it a few seconds.' });
      }

      // Fetch venue from Google Places
      const venue = await fetchVenueFromGoogle(placeId, localDay);
      if (!venue) {
        return res.status(502).json({ error: 'Failed to fetch venue data from Google Places' });
      }

      // Get weather (may return null)
      const lat = venue.location?.latitude;
      const lon = venue.location?.longitude;
      const weather = (lat && lon) ? await getWeather(lat, lon) : null;

      // WHOSE CLOCK: the venue's, not the phone's.
      //
      // "How busy is this place" is a fact about that place's night. At 11 PM
      // in Bethlehem, a bar in Los Angeles is at 8 PM and is only starting to
      // fill; scoring it against the viewer's 11 PM answers a question nobody
      // asked. The marketing demo already scores on the venue clock, so this
      // also stops the two surfaces disagreeing about the same venue.
      //
      // The client's own hour stays the fallback for the overwhelmingly common
      // case where Google gives us no offset, and for the far more common case
      // where the venue is local anyway and the two are identical.
      const venueClock = crowdEngine.venueLocalNow(venue.utcOffsetMinutes, now);
      if (venueClock) {
        localHour = venueClock.hour;
        localDay = venueClock.day;
      }

      // Build a timestamp with the venue's local hour/day for accurate scoring
      const clientTime = new Date(now);
      // Adjust to match client's day of week and hour. Round 14: this used to
      // be `localDay - serverDay`, a signed weekday difference used as a day
      // count, which lands up to six days from today when the client and the
      // UTC server are on different sides of midnight. Nearest matching
      // weekday is the only reading that means "this venue, now".
      clientTime.setDate(clientTime.getDate() + crowdEngine.weekdayOffset(clientTime.getDay(), localDay));
      clientTime.setHours(localHour, 0, 0, 0);

      const crowdResult = await mlPredictor.predictBusyness(venue, weather, clientTime);

      // Round 13: this 24-hour forecast used to start at 6 AM, so "best time"
      // could name an hour that already happened and "now" was read off the
      // 6 AM entry instead of the score on screen. It starts at the current
      // hour and runs forward now, and the hourly strip is its first 12 entries
      // so the chart and the recommendation can never disagree.
      const fullDay = await mlPredictor.predictHourlyForecast(venue, weather, localHour, 24, clientTime);
      const hourly = fullDay.slice(0, 12);
      // Peak comes off the same 12 hours the forecast meter draws, so it names
      // a rush the user can see rather than tomorrow evening.
      const peakResult = findPeakTime(hourly, venue, { startDay: localDay });

      // Query user feedback for calibration (non-blocking — fallback to raw score on failure)
      let calibration = { adjustedScore: crowdResult.score, feedbackUsed: false, reportCount: 0 };
      try {
        const fbResult = await pool.query(
          `SELECT crowd_level, predicted_score FROM venue_feedback
           WHERE venue_place_id = $1 AND day_of_week = $2 AND hour BETWEEN $3 AND $4
             AND verified = true -- only presence-verified reports: Sybil accounts could steer public predictions (REVIEW-ROUND5)
           ORDER BY created_at DESC LIMIT 50`,
          [placeId, localDay, Math.max(0, localHour - 1), Math.min(23, localHour + 1)]
        );
        calibration = buildCalibrationAdjustment(fbResult.rows, crowdResult.score);
      } catch (fbErr) {
        console.error('[Crowd] Feedback query failed, using raw score:', fbErr.message);
      }

      const finalScore = calibration.adjustedScore;
      // Best time is decided against the score the client actually renders, so
      // a venue reported busy by real users can't also be told "now is good".
      const best = crowdEngine.recommendBestTime(fullDay, venue, peakResult.startIdx, peakResult.endIdx, venue.isOpen, {
        currentHour: localHour,
        // Round 14: without the day, a venue closed on Mondays was told to come
        // at 7 PM tonight, and split-service hours read as closed all evening.
        currentDay: localDay,
        currentScore: finalScore,
      });
      const bestTime = best.text;
      const capacity = estimateCapacity(venue, finalScore);
      const waitEstimateTyped = estimateWait(finalScore, venue.types, venue.price_level);

      const dataSources = [...crowdResult.dataSourcesUsed];
      if (calibration.feedbackUsed) dataSources.push('user_feedback');

      const feedbackConfidenceBoost = calibration.feedbackUsed
        ? Math.min(15, calibration.reportCount * 3)
        : 0;

      const result = {
        placeId,
        name: venue.name,
        score: finalScore,
        label: getLabel(finalScore),
        rawEngineScore: crowdResult.score,
        confidence: Math.min(100, crowdResult.confidence + feedbackConfidenceBoost),
        capacity,
        bestTime,
        peak: peakResult.text,
        waitEstimate: waitEstimateTyped,
        isOpen: venue.isOpen,
        openHour: venue.openHour,
        closeHour: venue.closeHour,
        // Round 14: openHour/closeHour cannot express 24-hour venues, split
        // service or a dark day, and every client that re-derived open/closed
        // from those two numbers got one of the three wrong. This is today's
        // real window list, and each hour below carries the server's own
        // open/closed answer so no client has to guess.
        hoursToday: venue.hoursToday || [],
        hourly: hourly.map((h, i) => {
          const abs = localHour + i;
          return {
            ...h,
            // Google's openNow wins for the "Now" bar: posted hours and reality
            // disagree often enough that the bar under a "Closed" header must
            // not be drawn as a live crowd.
            open: (i === 0 && venue.isOpen != null)
              ? venue.isOpen
              : crowdEngine.isOpenAt(venue, abs % 24, localDay + Math.floor(abs / 24)),
          };
        }),
        // Which hourly entry the best-time sentence names (null when it says
        // "now", or when the named hour sits past the 12 drawn bars), so a
        // chart can mark the same hour the sentence names instead of guessing.
        bestHour: best.dayOffset === 0 ? best.hourLabel : null,
        bestIndex: (best.dayOffset === 0 && best.index >= 0 && best.index < hourly.length && best.hourLabel)
          ? best.index
          : null,
        bestIsNow: best.hourLabel == null,
        factors: crowdResult.factors,
        calibration: {
          feedbackUsed: calibration.feedbackUsed,
          reportCount: calibration.reportCount,
          predictionDrift: calibration.predictionDrift || 0,
        },
        dataSourcesUsed: dataSources,
        modelVersion: crowdResult.modelVersion || null,
        weather: weather ? { temp: weather.temp, conditions: weather.conditions } : null,
        eventAlert: crowdResult.eventAlert || null,
        lastUpdated: now.toISOString(),
        // The clock this card was scored on, so the client labels its bars
        // with the venue's hours rather than the phone's. Sending it makes the
        // two halves of this change independent: a client that ignores the
        // field keeps its old behaviour, and one that reads it is correct
        // whichever order the two deploys land in. `local` is false when
        // Google gave us no offset and we fell back to the caller's clock.
        venueClock: {
          hour: localHour,
          day: localDay,
          utcOffsetMinutes: venueClock ? Number(venue.utcOffsetMinutes) : null,
          local: !!venueClock,
        },
      };

      setCache(cacheKey, result);
      res.json(await gateForecast(result, req.user.id, { count: true }));
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

      const { venues: rawVenues, localHour, localDay } = req.body;
      // Round 8: items were passed to the predictor as arbitrary objects,
      // pushing attacker-shaped keys into its caches. Keep only known fields
      // with the right types; malformed items score as low-signal venues.
      const venues = rawVenues.slice(0, 20).map((v) => ({
        place_id: typeof v?.place_id === 'string' ? v.place_id.slice(0, 256) : null,
        name: typeof v?.name === 'string' ? v.name.slice(0, 256) : '',
        rating: Number.isFinite(v?.rating) ? v.rating : null,
        user_ratings_total: Number.isFinite(v?.user_ratings_total) ? v.user_ratings_total : 0,
        price_level: Number.isInteger(v?.price_level) ? v.price_level : null,
        types: Array.isArray(v?.types) ? v.types.filter((t) => typeof t === 'string').slice(0, 10) : [],
        location: (v?.location && Number.isFinite(v.location.latitude) && Number.isFinite(v.location.longitude))
          ? { latitude: v.location.latitude, longitude: v.location.longitude }
          : null,
        isOpen: typeof v?.isOpen === 'boolean' ? v.isOpen : null,
        openHour: Number.isInteger(v?.openHour) ? v.openHour : null,
        closeHour: Number.isInteger(v?.closeHour) ? v.closeHour : null,
        // Whitelisted so a client that has the venue's Google offset lets the
        // event window (trueEventInstant) land on the venue's real instant
        // rather than the viewer's. Absent -> null -> old fallback behavior.
        utcOffsetMinutes: Number.isFinite(v?.utcOffsetMinutes) ? v.utcOffsetMinutes : null,
      }));
      const now = new Date();

      // Use client's local time if provided
      const clientTime = new Date(now);
      if (localHour != null && localDay != null) {
        clientTime.setDate(clientTime.getDate() + crowdEngine.weekdayOffset(clientTime.getDay(), localDay));
        clientTime.setHours(localHour, 0, 0, 0);
      }

      // Get weather once from the first venue's location
      const firstLoc = venues[0]?.location;
      const weather = (firstLoc?.latitude && firstLoc?.longitude)
        ? await getWeather(firstLoc.latitude, firstLoc.longitude)
        : null;

      // Bulk query feedback for all venues at once (non-blocking)
      const placeIds = venues.map(v => v.place_id).filter(Boolean);
      const batchHour = localHour != null ? localHour : clientTime.getHours();
      const batchDay = localDay != null ? localDay : clientTime.getDay();
      let feedbackByVenue = {};
      try {
        const fbResult = await pool.query(
          `SELECT venue_place_id, crowd_level, predicted_score FROM venue_feedback
           WHERE venue_place_id = ANY($1::text[])
             AND day_of_week = $2
             AND hour BETWEEN $3 AND $4
             AND verified = true -- only presence-verified reports: Sybil accounts could steer public predictions (REVIEW-ROUND5)`,
          [placeIds, batchDay, Math.max(0, batchHour - 1), Math.min(23, batchHour + 1)]
        );
        for (const row of fbResult.rows) {
          if (!feedbackByVenue[row.venue_place_id]) feedbackByVenue[row.venue_place_id] = [];
          feedbackByVenue[row.venue_place_id].push(row);
        }
      } catch (fbErr) {
        console.error('[Crowd] Batch feedback query failed, using raw scores:', fbErr.message);
      }

      const predictions = await Promise.all(venues.map(async v => {
        const result = await mlPredictor.predictBusyness(v, weather, clientTime);
        const cal = buildCalibrationAdjustment(feedbackByVenue[v.place_id] || [], result.score);
        const boost = cal.feedbackUsed ? Math.min(15, cal.reportCount * 3) : 0;
        return {
          placeId: v.place_id,
          name: v.name,
          score: cal.adjustedScore,
          label: getLabel(cal.adjustedScore),
          rawEngineScore: result.score,
          confidence: Math.min(100, result.confidence + boost),
          calibration: {
            feedbackUsed: cal.feedbackUsed,
            reportCount: cal.reportCount,
            predictionDrift: cal.predictionDrift || 0,
          },
        };
      }));

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

      // Use client's local time if provided, else fall back to server time
      const now = new Date();
      let localHour = req.query.localHour != null ? parseInt(req.query.localHour, 10) : now.getHours();
      let localDay = req.query.localDay != null ? parseInt(req.query.localDay, 10) : now.getDay();
      if (!Number.isInteger(localHour) || localHour < 0 || localHour > 23) localHour = now.getHours();
      if (!Number.isInteger(localDay) || localDay < 0 || localDay > 6) localDay = now.getDay();

      // Two paid Google calls per request — budget them (round 8)
      if (!allowPlacesSearch(req.user.id)) {
        return res.status(429).json({ error: 'Loading venues too fast. Give it a few seconds.' });
      }

      // Fetch target venue
      const target = await fetchVenueFromGoogle(placeId, localDay);
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
      const clientTime = new Date(now);
      clientTime.setDate(clientTime.getDate() + crowdEngine.weekdayOffset(clientTime.getDay(), localDay));
      clientTime.setHours(localHour, 0, 0, 0);

      // Score the target venue
      const targetResult = await mlPredictor.predictBusyness(target, weather, clientTime);

      // Search nearby venues of similar type
      const primaryType = target.types[0] || 'restaurant';
      const searchResponse = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': API_KEY,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.rating,places.userRatingCount,places.priceLevel,places.types,places.location,places.currentOpeningHours,places.utcOffsetMinutes',
        },
        body: JSON.stringify({
          textQuery: primaryType,
          locationBias: {
            circle: { center: { latitude: lat, longitude: lon }, radius: 2000.0 },
          },
          maxResultCount: 10,
        }),
        signal: upstreamSignal('places'), // round 12
      });

      const searchData = await searchResponse.json();
      const nearby = (searchData.places || [])
        .filter(p => p.id !== placeId)
        .filter(p => p.currentOpeningHours?.openNow !== false) // exclude closed venues
        .map(p => ({
          place_id: p.id,
          name: p.displayName?.text || '',
          rating: p.rating || null,
          user_ratings_total: p.userRatingCount || 0,
          price_level: priceLevelToNum(p.priceLevel),
          types: p.types || [],
          location: p.location || null,
          // Same reason as fetchVenueFromGoogle: predictBusyness reads this for
          // the Ticketmaster event window (trueEventInstant). The searchText
          // field mask requests it, so pass it through instead of dropping it.
          utcOffsetMinutes: p.utcOffsetMinutes != null ? p.utcOffsetMinutes : null,
        }));

      // Round 14: "Less crowded nearby" was scored by a different engine than
      // the card it sits under. findQuieterAlternatives calls the RULE ENGINE
      // while the card's number comes from the ML model, and the target it
      // compared against was the UNCALIBRATED score while the card shows the
      // calibrated one. Both gaps could list a venue as quieter than a card it
      // was in fact busier than. Everything here now goes through the same
      // predictor and the same calibration as GET /api/crowd/:placeId.
      const altIds = nearby.map(v => v.place_id).filter(Boolean);
      let feedbackByVenue = {};
      try {
        const fbResult = await pool.query(
          `SELECT venue_place_id, crowd_level, predicted_score FROM venue_feedback
           WHERE venue_place_id = ANY($1::text[])
             AND day_of_week = $2 AND hour BETWEEN $3 AND $4
             AND verified = true`,
          [[placeId, ...altIds], localDay, Math.max(0, localHour - 1), Math.min(23, localHour + 1)]
        );
        for (const row of fbResult.rows) {
          (feedbackByVenue[row.venue_place_id] ||= []).push(row);
        }
      } catch (fbErr) {
        console.error('[Crowd] Alternatives feedback query failed, using raw scores:', fbErr.message);
      }

      const targetScore = buildCalibrationAdjustment(feedbackByVenue[placeId] || [], targetResult.score).adjustedScore;
      const scoredNearby = await Promise.all(nearby.map(async (v) => {
        try {
          const r = await mlPredictor.predictBusyness(v, weather, clientTime);
          const score = buildCalibrationAdjustment(feedbackByVenue[v.place_id] || [], r.score).adjustedScore;
          return { placeId: v.place_id, name: v.name, score, label: getLabel(score) };
        } catch { return null; }
      }));

      const alternatives = scoredNearby
        .filter(v => v && v.score < targetScore)
        .sort((a, b) => a.score - b.score)
        .slice(0, 3);

      res.json({
        currentVenue: { name: target.name, score: targetScore },
        alternatives,
      });
    } catch (err) {
      console.error('[Crowd] Alternatives error:', err);
      res.status(500).json({ error: 'Failed to find alternatives' });
    }
  }
);

module.exports = router;
// Exposed for backend/__tests__/crowdReaudit.test.js — the venue-clock path
// depends on utcOffsetMinutes surviving the Google->venue shaping, and that
// drop was invisible to every existing test because the shaping is internal.
module.exports.__testables = { fetchVenueFromGoogle };
