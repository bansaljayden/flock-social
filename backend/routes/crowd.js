const express = require('express');
const { param, body, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { getWeather } = require('../services/weatherService');
const crowdEngine = require('../services/crowdEngine');
const { buildHoursByDay } = crowdEngine;
const mlPredictor = require('../services/mlPredictor');
const { upstreamSignal } = require('../utils/upstream');
const { isPlaceIdShaped } = require('../utils/places');

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

// ---------------------------------------------------------------------------
// THE FLOCK PRO FORECAST GATE
//
// Split deliberately into two halves, because the leak this file has already
// suffered once was a FIELD-LIST problem and the leak the rest of the app
// suffered was a ROUTE-COVERAGE problem, and they need different fixes:
//
//   forecastAccess()  — the POLICY. Who is locked, and does this request spend
//                       one of the free monthly views. Identical everywhere, so
//                       it is written once and exported.
//   gateForecast()    — the FIELDS, for THIS route's payload shape. Every
//                       surface names the same three answers differently
//                       (`bestTime` here, `best_time` in routes/publicCrowd.js
//                       and routes/ai.js), so the stripping cannot be shared;
//                       what is shared is the rule that all three go.
//
// Round 20: routes/crowd.js was the ONLY metered door. routes/publicCrowd.js
// (unauthenticated) and routes/ai.js (Birdie) both served the same best time,
// peak and hourly curve with no gate at all, so the moment PAYWALL_ENABLED went
// true the meter would have been decorative: a locked user asks Birdie, or the
// public demo, and gets the thing they just hit a wall for. Both now apply this
// same policy to their own shapes. See __tests__/forecastGateParity.test.js.
// ---------------------------------------------------------------------------

// The free-tier answer, used when the paywall is off and for a Pro subscriber:
// unlimited, unmetered, and (with the paywall off) not even announced.
// Frozen: it is handed out by reference to every caller, including
// routes/ai.js, and a shared policy object that one route can mutate is a
// paywall one route can turn off for the process.
const UNMETERED_ACCESS = Object.freeze({ locked: false, remaining: null, limit: null });

// `count` = true means this request should consume one of the free allowance
// (only a single-venue detail view counts, not batch/list previews).
// `premium` lets a caller that has ALREADY resolved the tier pass it in rather
// than pay for a second `SELECT is_premium` on the same request.
async function forecastAccess(userId, { count, premium } = {}) {
  // Paywall off (or unset) → today's behavior, unlimited, no meter.
  if (!paywallEnabled()) return UNMETERED_ACCESS;
  const pro = premium != null ? premium : await isPremium(userId);
  if (pro) return UNMETERED_ACCESS;
  const usedBefore = getUsedThisMonth(userId);
  if (usedBefore >= FREE_MONTHLY_FORECASTS) {
    return { locked: true, remaining: 0, limit: FREE_MONTHLY_FORECASTS };
  }
  const usedNow = count ? recordView(userId) : usedBefore;
  return {
    locked: false,
    remaining: Math.max(0, FREE_MONTHLY_FORECASTS - usedNow),
    limit: FREE_MONTHLY_FORECASTS,
  };
}

// EVERY FIELD THAT CARRIES THE BEST-TIME ANSWER GOES, not just the sentence.
// bestHour / bestIndex / bestIsNow were added later, in the same rewrite that
// made the chart mark the recommended bar, and this gate was not updated with
// them: `bestTime: null` blanked the sentence while `bestHour: "9 PM"` sat two
// lines below it, so a locked response still named the hour the paywall exists
// to sell, and `bestIsNow` still answered "is now a good time" outright.
// Frontend gating is cosmetic (SLOP-AUDIT rule 7), so anything left in this
// payload is shipped.
//
// What deliberately STAYS is the free half: score, label, capacity,
// waitEstimate and the live calibration all describe "how busy is it right
// now", plus hoursToday/isOpen, which are Google's posted hours and were never
// ours to sell. __tests__/presenceParity.test.js pins both halves — add a field
// to the premium set and it must be added here too.
// Frozen, and the empty array with it. This used to be written inline at the
// one call site, so every locked response got its own `[]`; hoisting it into a
// constant means every locked response now shares ONE array by reference, and
// a frozen one cannot be quietly filled in by something downstream.
const LOCKED_FORECAST_FIELDS = Object.freeze({
  bestTime: null,
  hourly: Object.freeze([]),
  peak: null,
  bestHour: null,
  bestIndex: null,
  bestIsNow: null,
});

// Returns a per-request copy so the shared cache stays ungated.
async function gateForecast(result, userId, { count } = {}) {
  if (!paywallEnabled()) return result;
  const access = await forecastAccess(userId, { count });
  // Rebuilt field by field rather than spread: `access` is a policy object and
  // this one is a frontend contract, so a field added to the former must never
  // ride out to clients by accident.
  const forecastAccessField = { locked: access.locked, remaining: access.remaining, limit: access.limit };
  if (!access.locked) return { ...result, forecastAccess: forecastAccessField };
  return { ...result, ...LOCKED_FORECAST_FIELDS, forecastAccess: forecastAccessField };
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

// A user's crowd report informs reads within an hour either side of it.
//
// Round 15: that window was written as `hour BETWEEN GREATEST(0, h-1) AND
// LEAST(23, h+1)`, which CLAMPS where the clock WRAPS. At hour 23 it asked for
// 22..23 and at hour 0 it asked for 0..1, so a report filed at 11 PM could
// never reach the midnight read and a midnight report could never reach 11 PM —
// the exact hours where "how busy is it right now" is the whole question, and
// the hours a bar's night actually turns on.
//
// Midnight is also a different weekday, so the window is (day, hour) PAIRS on
// the 168-hour week rather than a range of hours: the neighbour of Friday 23:00
// is Saturday 00:00, not Friday 00:00. Same shape as the neighbour smoothing in
// services/mlPredictor.js getBaseline.
function feedbackWindow(day, hour) {
  const d = (((Math.trunc(day) % 7) + 7) % 7);
  const h = (((Math.trunc(hour) % 24) + 24) % 24);
  const slot = d * 24 + h;
  return [(slot + 167) % 168, slot, (slot + 1) % 168].map((s) => [Math.floor(s / 24), s % 24]);
}

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

  // ENCODED. `placeId` is a raw path segment off the request — Express has
  // already percent-DECODED it, so `/api/crowd/x%2F..%2Fadmin` arrives here as
  // `x/../admin` and interpolating it raw builds a URL that the WHATWG parser
  // then normalises into a DIFFERENT Google endpoint, called with our API key
  // attached. A `?` or `#` in the id does the same to the query string.
  //
  // The encoding stays even though `placeIdParam` below now refuses anything
  // that is not [A-Za-z0-9_-]{6,128}, so no traversal can reach this line any
  // more: this function is not a route handler and nothing in its signature says
  // its argument was validated, so it defends itself. One segment, always. A
  // bogus id is then Google's 404, which fetchVenueFromGoogle already turns into
  // a 502. (routes/publicCrowd.js has encoded its copy since it was written.)
  // The deadline from round 12 is what makes the try/catch below load-bearing
  // rather than paranoia: an upstreamSignal abort REJECTS this fetch, and a
  // rejection here escaped to each route's outer catch as a 500 "Prediction
  // error". Google timing out is Google failing, and both callers already have
  // the right answer for that — a null return is a 502 in GET /:placeId and in
  // /alternatives, which is the code the round-19 note picked for exactly this
  // case ("both are Google failing rather than this server"). A non-JSON body
  // from a proxy takes the same route out. Only a genuinely bad place id should
  // ever have produced the same null, and it still does.
  let p;
  try {
    const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: {
        'X-Goog-Api-Key': API_KEY,
        'X-Goog-FieldMask': 'id,displayName,formattedAddress,rating,userRatingCount,priceLevel,types,location,currentOpeningHours,utcOffsetMinutes',
      },
      // Round 12: no deadline meant a hung Google socket parked this request (and
      // its pg pool slot) for ~5 minutes. See utils/upstream.js.
      signal: upstreamSignal('places'),
    });
    p = await response.json();
  } catch (err) {
    console.error('[Crowd] Place details unreachable:', err.message);
    return null;
  }
  if (!p || p.error) return null;

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

// SHAPED, not merely bounded — the last consumer in the repo to adopt the rule
// routes/checkin.js, flocks.js, feedback.js, venueProfile.js, venueDashboard.js
// and sockets/handlers.js all already enforce. Length alone was never the point:
//   * MONEY. Both routes below spend a PAID Google Place Details call (and
//     /alternatives spends two) on whatever string arrives. An id that cannot be
//     a Google place id is an invoice line that can only ever return a 404, and
//     rotating them is how you spend somebody's whole hourly budget on nothing.
//   * ML DATA. The same unvalidated string is the key
//     services/mlPredictor.js storeGoogleBaselines writes ml_venue_baselines
//     rows under, and the key its baseline/feedback caches are keyed by, so junk
//     ids become junk rows in the corpus the crowd model retrains from.
// max 200 before the shape check so an oversized id is refused by length rather
// than by regex, matching routes/publicCrowd.js and routes/feedback.js; the
// shape check then bounds it to 128 in practice.
//
// GRANDFATHERING: nothing legitimate is refused. Every id these routes are
// reached with came from Google (routes/venueSearch.js results, or a flock's
// venue_id, which routes/flocks.js has already validated against this same
// predicate). Ids already stored under venue_feedback.venue_place_id and
// ml_venue_baselines.google_place_id are read by these routes but never written
// by them, so no cleanup is required — an unshaped row there was unreachable
// junk before this change and is unreachable junk after it.
const placeIdParam = param('placeId').trim()
  .isLength({ min: 1, max: 200 }).withMessage('placeId is required')
  .bail()
  .custom((v) => isPlaceIdShaped(v)).withMessage('placeId is not a valid place id');

// ---------------------------------------------------------------------------
// GET /api/crowd/:placeId — Full crowd prediction for one venue
// ---------------------------------------------------------------------------
router.get('/:placeId',
  placeIdParam,
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
          // Round 16: this SELECT is what decides whether the calibration guard
          // rails in crowdEngine.buildCalibrationAdjustment do anything at all.
          // It used to ask for `crowd_level, predicted_score` and nothing else,
          // so every row arrived with no account on it and no age on it, and
          // both of that function's protections degraded to "keep every row":
          // one account's six reports counted as six reporters, and a report
          // from last spring voted on tonight's number. user_id and created_at
          // are in the projection now so the dedupe and the recency window act
          // on real values.
          //
          // The 28 days is also enforced HERE rather than only in JavaScript,
          // for a reason beyond belt-and-braces: `ORDER BY created_at DESC
          // LIMIT 50` spends its row budget before the JS filter ever runs, so
          // a venue whose recent reports are outnumbered by old ones could
          // return 50 rows and zero usable ones. Bounding the age in SQL means
          // all 50 are rows that can vote. Keep this window equal to
          // crowdEngine.CALIBRATION_MAX_AGE_MS — __tests__/calibrationQueries
          // .test.js fails if the two ever drift.
          //
          // DISTINCT ON is the same argument one level down. The function keeps
          // exactly one report per account, so without it a handful of accounts
          // holding several in-window rows each could fill all 50 slots and
          // push genuine reporters out of a budget spent on rows that were
          // going to be discarded. Deduping here makes LIMIT 50 mean "50
          // reporters" instead of "50 rows". (A NULL user_id collapses to a
          // single row, which is the safe direction: an unattributable report
          // loses influence, it never gains any.)
          `SELECT crowd_level, predicted_score, user_id, created_at FROM (
             SELECT DISTINCT ON (user_id) crowd_level, predicted_score, user_id, created_at
               FROM venue_feedback
              WHERE venue_place_id = $1
                AND (day_of_week, hour) IN (($2::int, $3::int), ($4::int, $5::int), ($6::int, $7::int))
                AND verified = true -- only presence-verified reports: Sybil accounts could steer public predictions (REVIEW-ROUND5)
                AND created_at > NOW() - INTERVAL '28 days'
              ORDER BY user_id, created_at DESC
           ) newest_per_reporter
           ORDER BY created_at DESC LIMIT 50`,
          [placeId, ...feedbackWindow(localDay, localHour).flat()]
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
        // `estimatedAttendance` IS NOT PUBLISHED, and that is the whole point
        // of reshaping this instead of forwarding it.
        //
        // services/mlPredictor.js estimateTmAttendance returns a Ticketmaster
        // capacity when the payload happens to carry one, and otherwise a
        // number picked by looking for "arena" / "stadium" / "garden" / "field"
        // / "theatre" in the venue's NAME: 25000, 20000, 5000, 3000, 1500,
        // 1000, or a 500 default. Those are fine as MODEL FEATURES, which is
        // what they were built for, and they are trained against — a systematic
        // guess feeding a fitted weight is a legitimate feature. They are not a
        // headcount, and "20,000 people expected" on a card is a number a user
        // would read as one. This project has a hard rule against showing
        // people figures that are not real.
        //
        // Dropped rather than relabelled because THIS LAYER CANNOT LABEL IT
        // HONESTLY: the two cases arrive indistinguishable here, so the only
        // truthful caption would be "somewhere between a box-office capacity
        // and a guess from the venue's name", which is not a caption. Nothing
        // in the frontend reads the field today (grep: it has no consumer), so
        // this costs no UI. If a real figure is ever wanted, mlPredictor has to
        // say which branch produced it and the card can print only the sourced
        // one.
        //
        // The rest of the alert is real: the name and the distance come
        // straight off the Ticketmaster event, and the >5,000 threshold that
        // fires it stays a model-side judgement about whether to warn at all.
        eventAlert: crowdResult.eventAlert
          ? {
            hasEvent: crowdResult.eventAlert.hasEvent,
            eventName: crowdResult.eventAlert.eventName,
            distance: crowdResult.eventAlert.distance,
          }
          : null,
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
//
// KNOWN, MEASURED, AND DELIBERATELY NOT CLOSED: this endpoint is an oracle for
// the curve the gate above sells. Written down here rather than in a report,
// because the person most likely to need it is whoever next edits gateForecast.
//
// This route scores each venue on a clock the CLIENT asserts, via that item's
// `utcOffsetMinutes` (and `localHour`/`localDay` for items without one). The
// score it returns is the free "how busy right now" number, which is correct
// and by design. But the caller chooses the "now". Verified by experiment on
// 2026-08-14: ONE POST carrying twenty copies of the same venue at twenty
// different offsets came back with twenty distinct hours and twenty scores,
// i.e. most of a day's curve, for a user whose monthly allowance was spent —
// no Google call, no Places charge, nothing metered.
//
// WHY IT IS STILL OPEN. Every fix trades against something rounds 13 to 15
// deliberately bought:
//   * "one clock per request" reverts the multi-timezone fix directly. A vote
//     list can hold venues in three zones and each has to answer on its own.
//   * "the offset must be plausible for the longitude" (the sun does not move
//     for one caller) is the good version and would bound the oracle to about
//     +/-3.5 hours instead of 24. It is a HEURISTIC on the hottest crowd path,
//     and its failure mode is silent: a real venue whose offset it mis-rejects
//     falls back to the caller's clock and is scored at the wrong hour, which
//     is the exact bug those rounds were fixing. Wrong scores on the vote list
//     cost more than a rough curve does.
//   * deduping by place_id closes only the tidiest shape. The same request
//     works with the ids removed.
// The residual is the same one the card and the public demo carry for venues
// Google gives no offset for: a client-asserted wall clock is unverifiable, so
// the FREE live score is inherently a one-hour-at-a-time probe of the paid
// curve, everywhere. What the gate stops is the PRODUCT — the labelled 12-hour
// strip, the named best hour, the peak window, the chart the app draws. It does
// not stop somebody willing to rebuild an unlabelled curve by hand.
//
// If the paywall is ever switched on and this matters commercially, the
// longitude check is the change to make, with the fallback tested.
// ---------------------------------------------------------------------------
router.post('/batch',
  body('venues').isArray({ min: 1, max: 20 }).withMessage('venues must be an array (1-20 items)'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { venues: rawVenues } = req.body;
      // Round 15: localHour/localDay were read straight out of the body with no
      // validation, unlike GET /:placeId which parses and range-checks them.
      // `localHour: "abc"` reached setHours(NaN), which makes an Invalid Date,
      // and every feature derived from it (day, hour, month, holiday, the event
      // window) then came out NaN and was zero-filled into the vector — a
      // confidently wrong score with no error anywhere. Anything that is not a
      // real clock reading is treated as "not supplied".
      let localHour = req.body.localHour != null ? parseInt(req.body.localHour, 10) : null;
      let localDay = req.body.localDay != null ? parseInt(req.body.localDay, 10) : null;
      if (!Number.isInteger(localHour) || localHour < 0 || localHour > 23) localHour = null;
      if (!Number.isInteger(localDay) || localDay < 0 || localDay > 6) localDay = null;
      // Round 8: items were passed to the predictor as arbitrary objects,
      // pushing attacker-shaped keys into its caches. Keep only known fields
      // with the right types; malformed items score as low-signal venues.
      //
      // `place_id` here is NOT run through utils/places.isPlaceIdShaped, unlike
      // the two GET routes in this file, and that is a decision rather than an
      // oversight. It holds on two legs:
      //   * this endpoint makes NO paid Google call, so a junk id costs nothing;
      //   * it never WRITES a place id anywhere. It reads venue_feedback
      //     (parameterised) and the predictor's caches, which are bounded
      //     (services/mlPredictor.js boundedSet, round 8).
      // Refusing instead would drop a row's crowd badge on the floor, which is a
      // worse answer for a body the client assembled from its own search results.
      //
      // THE LEG THAT COULD BREAK: add `popular_times` to this whitelist and
      // services/mlPredictor.js predictBusyness starts calling
      // storeGoogleBaselines with this id, which INSERTs into
      // ml_venue_baselines — the corpus the crowd model retrains from. No route
      // supplies popular_times today, so that write is currently unreachable
      // from every request path. If one ever does, this whitelist needs the
      // shape check in the same edit.

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

      // WHOSE CLOCK: each venue's own, not the viewer's — and not one shared
      // clock for the whole list either.
      //
      // Rounds 13-15 moved the card, the alternatives list, the marketing demo
      // and the owner dashboard onto the venue's wall clock and left THIS list
      // behind, even though it is the list the card sits under: for a venue
      // outside the viewer's zone its detail page scored 8 PM at the door while
      // the vote-list row beside it scored 11 PM in the viewer's living room.
      //
      // The difference from every other surface is that these venues arrive in
      // the REQUEST BODY rather than from Google, so there is no single clock to
      // put the request on: a list can hold venues in three time zones at once
      // and each one has to answer on its own. That is why the feedback lookup
      // below is a (venue_place_id, day_of_week, hour) tuple list rather than
      // one (day, hour) window shared by every venue — the score and the reports
      // calibrating it are read on the SAME clock, per venue, or this endpoint
      // publishes a number calibrated against a different hour of the week.
      //
      // A venue whose client did not send utcOffsetMinutes falls back to the
      // caller's clock, exactly as before, which is also the right answer for
      // the overwhelmingly common case where the venue is local anyway.
      const fallbackHour = localHour != null ? localHour : now.getHours();
      const fallbackDay = localDay != null ? localDay : now.getDay();
      const clocks = venues.map((v) => {
        const vc = crowdEngine.venueLocalNow(v.utcOffsetMinutes, now);
        const hour = vc ? vc.hour : fallbackHour;
        const day = vc ? vc.day : fallbackDay;
        // Same three lines as the card: nearest matching weekday, then the hour.
        // weekdayOffset rather than a signed weekday difference — see round 14.
        const at = new Date(now);
        at.setDate(at.getDate() + crowdEngine.weekdayOffset(at.getDay(), day));
        at.setHours(hour, 0, 0, 0);
        return { hour, day, at, local: !!vc };
      });

      // Get weather once from the first venue's location.
      //
      // Round 15: these coordinates LOOK venue-derived but they are not — they
      // arrive in the request body, so a caller can put any lat/lng in the first
      // item and this is an enumeration surface for the paid weather API exactly
      // like GET /api/weather. Identify the caller so the per-user hourly
      // ceiling applies. Real browsing is unaffected: the reading is cached per
      // ~1km coordinate bucket and a cache hit charges nothing.
      //
      // KNOWN LIMIT, and it is louder now that each venue answers on its own
      // clock: this is ONE reading for the whole list, so a venue in another
      // time zone is scored against the first venue's weather. It stays one
      // call on purpose — per-venue readings would be up to twenty paid weather
      // calls per vote-list scroll, and weather is a small term in the feature
      // vector next to the hour. A list spanning zones is the rare case; a list
      // of twenty is the common one.
      const firstLoc = venues[0]?.location;
      const weather = (firstLoc?.latitude && firstLoc?.longitude)
        ? await getWeather(firstLoc.latitude, firstLoc.longitude, { userId: req.user.id })
        : null;

      // Bulk query feedback for all venues at once (non-blocking).
      //
      // One (venue_place_id, day_of_week, hour) tuple per venue per window
      // slot, because each venue is scored on its own clock above and a
      // calibration read on a different clock than the score it adjusts is
      // worse than no calibration at all. Three parallel arrays rather than an
      // inlined tuple list: the parameter COUNT is then fixed at three however
      // many venues arrive (20 venues x 3 slots would otherwise be 180 bind
      // parameters), and idx_venue_feedback_day_hour — (venue_place_id,
      // day_of_week, hour), migration 001 — is still the index this probes.
      //
      // Deduped as it is built: the same place id twice in one body is one
      // question, not two. (Two DIFFERENT venues sharing a clock are still two
      // tuples — the place id is part of the key.)
      const fbPlaceIds = [];
      const fbDays = [];
      const fbHours = [];
      const seenSlot = new Set();
      venues.forEach((v, i) => {
        if (!v.place_id) return;
        for (const [d, h] of feedbackWindow(clocks[i].day, clocks[i].hour)) {
          const slot = `${v.place_id}|${d}|${h}`;
          if (seenSlot.has(slot)) continue;
          seenSlot.add(slot);
          fbPlaceIds.push(v.place_id);
          fbDays.push(d);
          fbHours.push(h);
        }
      });

      let feedbackByVenue = {};
      try {
        // An empty tuple list is a round trip that can only return zero rows:
        // every item in this body was malformed enough to lose its place id.
        const fbResult = fbPlaceIds.length === 0 ? { rows: [] } : await pool.query(
          // Same projection as the single-venue read above, and for the same
          // reason: without user_id and created_at on the row, the per-account
          // dedupe and the 28-day window inside buildCalibrationAdjustment have
          // nothing to act on and every row votes. This list drives the score
          // printed beside each venue in the vote list, so it is the surface a
          // Sybil would actually aim at. Window must match
          // crowdEngine.CALIBRATION_MAX_AGE_MS.
          //
          // NO `DISTINCT ON (user_id)` HERE, AND THAT IS A DECISION — one that
          // holds only because of the line below it. Re-checked this round:
          //   * buildCalibrationAdjustment collapses repeat rows per account in
          //     JavaScript, so duplicates cost bytes, never votes. Verified: the
          //     one account / four rows case is pinned in
          //     __tests__/calibrationQueries.test.js.
          //   * a NULL user_id is the one row shape that JS counts individually,
          //     and no such row can exist: routes/feedback.js is the only writer
          //     and always binds the authenticated caller, and the column is
          //     `REFERENCES users(id) ON DELETE CASCADE` (migration 001), so a
          //     deleted account takes its reports with it rather than orphaning
          //     them as NULLs. Change that FK to SET NULL and this query starts
          //     counting one dead account as many reporters.
          //   * THERE IS NO `LIMIT`. That is what makes the dedupe optional here
          //     and mandatory on the single-venue read: a row budget spent on
          //     duplicates is a genuine reporter pushed out of the sample,
          //     whereas an unbudgeted read simply fetches the duplicates and
          //     discards them.
          // So the invariant is: **a LIMIT on a calibration read requires
          // DISTINCT ON (user_id)**. Adding a row cap to bound this query — a
          // reasonable thing to want, since only the 28-day window bounds it
          // today — silently re-introduces the exact bug DISTINCT ON was added
          // to fix. __tests__/presenceParity.test.js fails if a LIMIT ever
          // appears here without one, and if the FK stops being CASCADE.
          `SELECT venue_place_id, crowd_level, predicted_score, user_id, created_at FROM venue_feedback
           WHERE (venue_place_id, day_of_week, hour) IN (
                   SELECT w.place_id, w.dow, w.hr
                     FROM unnest($1::text[], $2::int[], $3::int[]) AS w(place_id, dow, hr))
             AND verified = true -- only presence-verified reports: Sybil accounts could steer public predictions (REVIEW-ROUND5)
             AND created_at > NOW() - INTERVAL '28 days'`,
          [fbPlaceIds, fbDays, fbHours]
        );
        for (const row of fbResult.rows) {
          if (!feedbackByVenue[row.venue_place_id]) feedbackByVenue[row.venue_place_id] = [];
          feedbackByVenue[row.venue_place_id].push(row);
        }
      } catch (fbErr) {
        console.error('[Crowd] Batch feedback query failed, using raw scores:', fbErr.message);
      }

      // One venue's failure is one venue's failure. predictBusyness reads a
      // venue-shaped object built from REQUEST BODY fields, so a single
      // malformed item that throws inside it used to reject this Promise.all
      // and return a 500 for the whole list: nineteen good venues lost their
      // scores because of the twentieth. /alternatives already guards each
      // neighbour individually and drops the one that failed; this is the same
      // rule, and the client keys predictions by placeId, so a missing entry
      // degrades to "no crowd badge on that row" instead of an empty list.
      const predictions = (await Promise.all(venues.map(async (v, i) => {
        const clock = clocks[i];
        try {
          const result = await mlPredictor.predictBusyness(v, weather, clock.at);
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
            // The clock THIS row was scored and calibrated on, same field the
            // card publishes, so a client can label the row with the venue's
            // hour rather than the phone's. `local` is false when the caller
            // sent no offset for this venue and it fell back to their clock.
            venueClock: {
              hour: clock.hour,
              day: clock.day,
              utcOffsetMinutes: clock.local ? Number(v.utcOffsetMinutes) : null,
              local: clock.local,
            },
          };
        } catch (err) {
          console.error('[Crowd] Batch venue prediction failed, dropping', v.place_id, err.message);
          return null;
        }
      }))).filter(Boolean);

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
  placeIdParam,
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

      // Cached like the card, and for a stronger reason than the card has: this
      // is the only request in this file that makes TWO paid Google calls, and
      // it had no cache at all, so the only thing standing between a client that
      // re-asks and a Google invoice was the 30-per-user-hour budget — fifteen
      // requests. Same 10-minute TTL and the same key shape as
      // GET /:placeId, since it answers the same question about the same venue
      // at the same hour, and nothing in the payload is user-specific (no
      // paywall gate here, unlike the card).
      //
      // Read BEFORE the charge, deliberately: utils/placesBudget.js says cache
      // hits must be answered before the charge, because charging for a call we
      // did not make masks the real burn rate. The key uses the CALLER's clock
      // rather than the venue's — the venue's offset is not known until the
      // Place Details call below has already happened — which is the same
      // trade-off the card makes: two viewers in different zones mint two
      // entries holding the same answer, and neither ever sees the other's.
      //
      // `currentVenue.score` can now be up to a TTL older than the card's own
      // number, where before it was always fresh against a card that could be
      // ten minutes stale. The bound on how far the two may drift is the same
      // ten minutes either way; what changes is which side is the stale one.
      //
      // These entries share the card's 200-entry cap, so a busy process evicts
      // the oldest of BOTH kinds. That is the right direction — an evicted entry
      // costs a re-fetch, and the cap is what stops unique-key spam growing the
      // map — but it does mean the card's effective cache depth is now shared.
      const cacheKey = `alt:${placeId}:${localHour}:${localDay}`;
      const cachedAlts = getCached(cacheKey);
      if (cachedAlts) return res.json(cachedAlts);

      // Two paid Google calls per request — a Place Details for the target and
      // a Text Search for the neighbours — so charge two. Round 15: the comment
      // already said two and the charge was one, which let this endpoint spend
      // twice its share of the budget; `cost` exists for exactly this.
      if (!allowPlacesSearch(req.user.id, 2)) {
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

      // WHOSE CLOCK — the last surface still answering on the viewer's.
      //
      // Round 14 moved this endpoint onto the same predictor and the same
      // calibration as GET /api/crowd/:placeId, so the two could not disagree
      // about the same venue. It left the CLOCK behind: the card re-derives the
      // hour from Google's utcOffsetMinutes and this route never did, so for any
      // venue outside the viewer's zone the card scored 8 PM at the door while
      // this scored 11 PM in the viewer's living room. Two consequences, and the
      // second is the one that makes the calibration work above pointless here:
      //   * `currentVenue.score` is the number this endpoint claims the card is
      //     showing, and it was a different hour's answer;
      //   * the feedback lookup below is keyed on (day_of_week, hour), so it was
      //     reading a DIFFERENT weekly bucket than the card's. Three verified
      //     reporters could move the card and leave this list untouched.
      // Same three lines as the card, so there is one rule about which clock a
      // venue is scored on. Google omits the offset for some places; those fall
      // back to the caller's clock exactly as before.
      const venueClock = crowdEngine.venueLocalNow(target.utcOffsetMinutes, now);
      if (venueClock) {
        localHour = venueClock.hour;
        localDay = venueClock.day;
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
      // Wrapped for the same reason as the target fetch above: the round-12
      // deadline makes a rejection here a normal upstream outcome, and it used
      // to leave as a 500 while the identical failure one status check later
      // left as a 502. One answer for "we could not ask", whichever way the
      // asking failed.
      let searchResponse;
      let searchData;
      try {
        searchResponse = await fetch('https://places.googleapis.com/v1/places:searchText', {
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
        searchData = await searchResponse.json();
      } catch (netErr) {
        console.error('[Crowd] Alternatives search unreachable:', netErr.message);
        return res.status(502).json({ error: 'Could not load nearby venues right now', unavailable: true });
      }
      // Round 19: `(searchData.places || [])` turned every upstream failure into
      // an empty neighbour list, and an empty list is this endpoint's way of
      // saying "we looked, and nothing near you is quieter". A quota, auth or
      // Places outage is not that answer — it is "we could not ask". Same rule
      // routes/publicCrowd.js adopted in round 11 for its two searches: only a
      // genuine zero-result search returns 200 with an empty list. 502, matching
      // the target-fetch failure a few lines up, since both are Google failing
      // rather than this server.
      if (!searchResponse.ok || searchData.error) {
        console.error('[Crowd] Alternatives search failed:',
          searchData.error?.message || searchData.error?.status || `HTTP ${searchResponse.status}`);
        return res.status(502).json({ error: 'Could not load nearby venues right now', unavailable: true });
      }
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
          // Third copy of the same projection, and the one it would be easiest
          // to leave behind: "Less crowded nearby" compares the target's
          // calibrated score against each neighbour's, so if only this query
          // stayed un-deduped the two sides of that comparison would be
          // calibrated under different rules and a venue could be listed as
          // quieter than a card it is in fact busier than. Window must match
          // crowdEngine.CALIBRATION_MAX_AGE_MS.
          //
          // Un-deduped in SQL for the same reason as the batch read above, and
          // under the same invariant: no LIMIT, so duplicate rows cost bytes
          // rather than crowding a genuine reporter out of a budget. Put a
          // LIMIT on this and it needs DISTINCT ON (user_id) in the same edit.
          `SELECT venue_place_id, crowd_level, predicted_score, user_id, created_at FROM venue_feedback
           WHERE venue_place_id = ANY($1::text[])
             AND (day_of_week, hour) IN (($2::int, $3::int), ($4::int, $5::int), ($6::int, $7::int))
             AND verified = true
             AND created_at > NOW() - INTERVAL '28 days'`,
          [[placeId, ...altIds], ...feedbackWindow(localDay, localHour).flat()]
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

      // Only a real answer is remembered. A 502 above returns before this line,
      // so an outage is never cached as "we looked and found nothing quieter" —
      // the same mistake round 19 fixed one level up, which caching would have
      // re-introduced for ten minutes at a time.
      const payload = {
        currentVenue: { name: target.name, score: targetScore },
        alternatives,
      };
      setCache(cacheKey, payload);
      res.json(payload);
    } catch (err) {
      console.error('[Crowd] Alternatives error:', err);
      res.status(500).json({ error: 'Failed to find alternatives' });
    }
  }
);

module.exports = router;
// THE forecast paywall policy, for every route that serves the forecast.
// routes/ai.js imports this rather than re-deriving "is this user locked" from
// entitlements + forecastUsage, because a second copy of that derivation is
// exactly how routes/publicCrowd.js and routes/ai.js came to have no gate at
// all while this file had one. A route module importing another route module is
// unusual; the alternative was a third private copy of the rule that decides
// who has paid, and that is worse. (No cycle: routes/ai.js is never required
// from here.)
module.exports.forecastAccess = forecastAccess;
// Exposed for backend/__tests__/crowdReaudit.test.js — the venue-clock path
// depends on utcOffsetMinutes surviving the Google->venue shaping, and that
// drop was invisible to every existing test because the shaping is internal.
module.exports.__testables = { fetchVenueFromGoogle, feedbackWindow };
