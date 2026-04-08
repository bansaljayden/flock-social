// ---------------------------------------------------------------------------
// ML Crowd Predictor — loads ONNX model, serves predictions
// Falls back to rule-based crowdEngine.js if model not available
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
const crowdEngine = require('./crowdEngine');

const MODEL_DIR = path.join(__dirname, '..', 'scripts', 'ml', 'models');
const ONNX_PATH = path.join(MODEL_DIR, 'crowd_model.onnx');
const META_PATH = path.join(MODEL_DIR, 'model_metadata.json');

let pool = null;
try { pool = require('../config/database'); } catch (_) {}

let session = null;
let metadata = null;
let loadAttempted = false;
let useML = false;

// Event cache: key = "lat,lng,hour" → { data, ts }
const eventCache = new Map();
const EVENT_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Baseline cache: key = "placeId_dow_hour" → baseline value
const baselineCache = new Map();
const BASELINE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours (static data)

// User feedback cache: key = venue_place_id → { data, ts }
const feedbackCache = new Map();
const FEEDBACK_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function init() {
  if (loadAttempted) return useML;
  loadAttempted = true;

  if (!fs.existsSync(ONNX_PATH) || !fs.existsSync(META_PATH)) {
    console.log('[MLPredictor] Model files not found — using rule engine');
    return false;
  }

  try {
    const ort = require('onnxruntime-node');
    metadata = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
    session = await ort.InferenceSession.create(ONNX_PATH);
    useML = true;
    console.log(`[MLPredictor] Loaded ONNX model v${metadata.model_version || '?'} (${metadata.best_model || '?'}, ${metadata.feature_count || '?'} features)`);
    return true;
  } catch (err) {
    console.warn('[MLPredictor] Failed to load model:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Baseline Lookup (from precomputed ml_venue_baselines table)
// ---------------------------------------------------------------------------

async function getBaseline(placeId, dayOfWeek, hour) {
  if (!pool || !placeId) return 0;

  const cacheKey = `${placeId}_${dayOfWeek}_${hour}`;
  const cached = baselineCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < BASELINE_CACHE_TTL) return cached.data;

  try {
    const { rows } = await pool.query(
      `SELECT baseline FROM ml_venue_baselines
       WHERE google_place_id = $1 AND day_of_week = $2 AND hour = $3`,
      [placeId, dayOfWeek, hour]
    );
    const val = rows.length > 0 ? parseInt(rows[0].baseline) : 0;
    baselineCache.set(cacheKey, { data: val, ts: Date.now() });
    return val;
  } catch (err) {
    console.error('[MLPredictor] Baseline lookup failed:', err.message);
    return 0;
  }
}

// Store Google popular_times as baselines on first encounter
async function storeGoogleBaselines(placeId, popularTimes) {
  if (!pool || !placeId || !popularTimes || !Array.isArray(popularTimes)) return;
  try {
    for (const day of popularTimes) {
      const dow = day.day != null ? day.day : null;
      const hours = day.data || day.hours || [];
      if (dow == null || !hours.length) continue;
      for (let h = 0; h < hours.length && h < 24; h++) {
        const val = hours[h];
        if (val == null) continue;
        await pool.query(
          `INSERT INTO ml_venue_baselines (google_place_id, day_of_week, hour, baseline, source)
           VALUES ($1, $2, $3, $4, 'google')
           ON CONFLICT (google_place_id, day_of_week, hour) DO NOTHING`,
          [placeId, dow, h, Math.max(0, Math.min(100, Math.round(val)))]
        );
      }
    }
  } catch (err) {
    console.error('[MLPredictor] Store Google baselines failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// User Feedback Lookup
// ---------------------------------------------------------------------------

async function getUserFeedback(placeId) {
  const noFeedback = { avgCrowd: 0, count: 0, avgError: 0 };
  if (!pool || !placeId) return noFeedback;

  const cached = feedbackCache.get(placeId);
  if (cached && Date.now() - cached.ts < FEEDBACK_CACHE_TTL) return cached.data;

  try {
    const { rows } = await pool.query(
      `SELECT
        AVG(crowd_level)::numeric(4,1) AS avg_crowd,
        COUNT(*)::int AS count,
        AVG(crowd_level - predicted_score)::numeric(5,2) AS avg_error
      FROM venue_feedback WHERE venue_place_id = $1`,
      [placeId]
    );
    const r = rows[0];
    const result = {
      avgCrowd: parseFloat(r?.avg_crowd) || 0,
      count: parseInt(r?.count) || 0,
      avgError: parseFloat(r?.avg_error) || 0,
    };
    feedbackCache.set(placeId, { data: result, ts: Date.now() });
    return result;
  } catch (err) {
    console.error('[MLPredictor] Feedback lookup failed:', err.message);
    return noFeedback;
  }
}

// ---------------------------------------------------------------------------
// Feature Engineering (mirrors prepare_features.py)
// ---------------------------------------------------------------------------

function getLabel(score) {
  if (score <= 20) return 'Quiet';
  if (score <= 40) return 'Not Busy';
  if (score <= 60) return 'Moderate';
  if (score <= 80) return 'Busy';
  return 'Very Busy';
}

function groupWeatherCode(code) {
  if (!code && code !== 0) return 'unknown';
  const c = Number(code);
  if (c >= 200 && c <= 232) return 'thunderstorm';
  if ((c >= 300 && c <= 321) || (c >= 500 && c <= 501)) return 'light_rain';
  if (c >= 502 && c <= 531) return 'heavy_rain';
  if (c >= 600 && c <= 622) return 'snow';
  if (c === 800) return 'clear';
  if (c >= 801 && c <= 802) return 'few_clouds';
  if (c >= 803 && c <= 804) return 'cloudy';
  return 'other';
}

// ---------------------------------------------------------------------------
// Live Ticketmaster Event Lookup
// ---------------------------------------------------------------------------

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function mapTmEventType(classifications) {
  if (!classifications || !classifications.length) return 'other';
  const seg = (classifications[0].segment?.name || '').toLowerCase();
  if (seg.includes('music')) return 'music';
  if (seg.includes('sport')) return 'sports';
  if (seg.includes('arts') || seg.includes('theatre')) return 'arts';
  if (seg.includes('family')) return 'family';
  return 'other';
}

function estimateTmAttendance(event) {
  const venues = event._embedded?.venues || [];
  for (const v of venues) {
    const cap = parseInt(v.generalInfo?.capacity, 10) ||
                parseInt(v.boxOfficeInfo?.capacity, 10) || 0;
    if (cap > 0) return cap;
  }
  const venueName = (venues[0]?.name || '').toLowerCase();
  const isArena = venueName.includes('arena') || venueName.includes('stadium') ||
                  venueName.includes('center') || venueName.includes('centre');
  const type = mapTmEventType(event.classifications);
  if (type === 'sports') return isArena ? 25000 : 5000;
  if (type === 'music') return isArena ? 20000 : 500;
  return 500;
}

async function getNearbyEvents(lat, lng, timestamp) {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  const noEvents = {
    hasEvent: false, nearestAttendance: 0, totalEvents: 0,
    totalAttendance: 0, nearestType: null, nearestDistance: 0,
    nearestName: null,
  };
  if (!apiKey || !lat || !lng) return noEvents;

  const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)},${new Date(timestamp).getHours()}`;
  const cached = eventCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < EVENT_CACHE_TTL) return cached.data;

  try {
    const ts = timestamp ? new Date(timestamp) : new Date();
    const startDt = ts.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const endTs = new Date(ts.getTime() + 3 * 60 * 60 * 1000);
    const endDt = endTs.toISOString().replace(/\.\d{3}Z$/, 'Z');

    const params = new URLSearchParams({
      apikey: apiKey,
      latlong: `${lat},${lng}`,
      radius: '2',
      unit: 'km',
      startDateTime: startDt,
      endDateTime: endDt,
      size: '20',
      sort: 'date,asc',
    });

    const response = await fetch(
      `https://app.ticketmaster.com/discovery/v2/events.json?${params}`
    );

    if (!response.ok) {
      eventCache.set(cacheKey, { data: noEvents, ts: Date.now() });
      return noEvents;
    }

    const data = await response.json();
    const events = data._embedded?.events || [];

    if (events.length === 0) {
      eventCache.set(cacheKey, { data: noEvents, ts: Date.now() });
      return noEvents;
    }

    let nearestDist = Infinity;
    let nearestEvent = null;
    let totalAttendance = 0;

    for (const e of events) {
      const eLat = parseFloat(e._embedded?.venues?.[0]?.location?.latitude) || 0;
      const eLng = parseFloat(e._embedded?.venues?.[0]?.location?.longitude) || 0;
      if (!eLat || !eLng) continue;

      const dist = distanceKm(lat, lng, eLat, eLng);
      const attendance = estimateTmAttendance(e);
      totalAttendance += attendance;

      if (dist < nearestDist) {
        nearestDist = dist;
        nearestEvent = { name: e.name, type: mapTmEventType(e.classifications), attendance };
      }
    }

    const result = nearestEvent ? {
      hasEvent: true,
      nearestAttendance: nearestEvent.attendance,
      totalEvents: events.length,
      totalAttendance,
      nearestType: nearestEvent.type,
      nearestDistance: Math.round(nearestDist * 100) / 100,
      nearestName: nearestEvent.name,
    } : noEvents;

    eventCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  } catch (err) {
    console.error('[MLPredictor] Event lookup failed:', err.message);
    eventCache.set(cacheKey, { data: noEvents, ts: Date.now() });
    return noEvents;
  }
}

// ---------------------------------------------------------------------------
// Feature Engineering (mirrors prepare_features.py)
// ---------------------------------------------------------------------------

function buildFeatureVector(venue, weather, timestamp, eventData, feedback, baseline) {
  const ts = timestamp ? new Date(timestamp) : new Date();
  const dayOfWeek = ts.getDay(); // 0=Sun
  const hour = ts.getHours();
  const month = ts.getMonth() + 1;

  // Determine season
  let season;
  if (month >= 3 && month <= 5) season = 'spring';
  else if (month >= 6 && month <= 8) season = 'summer';
  else if (month >= 9 && month <= 11) season = 'fall';
  else season = 'winter';

  const types = venue.types || [];
  const rating = venue.rating || metadata.median_rating || 4.0;
  const priceLevel = venue.price_level != null ? venue.price_level : (metadata.median_price_level || 2);
  const reviewCount = venue.user_ratings_total || venue.review_count || 0;

  // Weather
  const temp = weather?.temp ?? weather?.temperature ?? 20;
  const humidity = weather?.humidity ?? 50;
  const windSpeed = weather?.wind_speed ?? 0;
  const isRaining = weather?.is_raining ? 1 : 0;
  const weatherCode = weather?.weather_condition_code || weather?.id || null;
  const weatherGroup = groupWeatherCode(weatherCode);

  const lat = venue.latitude || venue.lat || 0;
  const lng = venue.longitude || venue.lng || 0;

  // Map venue category
  const categoryMap = metadata.category_encoding || {};
  const venueCategory = venue.venue_category || venue.category || guessCategory(types);
  const categoryEncoded = categoryMap[venueCategory] ?? -1;

  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6) ? 1 : 0;
  const isFriSatNight = ((dayOfWeek === 5 || dayOfWeek === 6) && hour >= 18) ? 1 : 0;
  const isLunch = (hour >= 11 && hour <= 13) ? 1 : 0;
  const isDinner = (hour >= 17 && hour <= 21) ? 1 : 0;
  const isLateNight = (hour >= 22 || hour <= 3) ? 1 : 0;
  const isMorning = (hour >= 6 && hour <= 10) ? 1 : 0;

  // Event data (from live Ticketmaster lookup)
  const ev = eventData || {};
  const hasEvent = ev.hasEvent ? 1 : 0;
  const nearestAttendance = ev.nearestAttendance || 0;
  const totalEvents = ev.totalEvents || 0;
  const totalAttendance = ev.totalAttendance || 0;
  const nearestDistance = ev.nearestDistance || 0;
  const nearestType = ev.nearestType || null;
  const isBar = (venueCategory === 'bar' || venueCategory === 'nightclub') ? 1 : 0;

  // Build feature dict
  const features = {
    day_of_week: dayOfWeek,
    hour: hour,
    month: month,
    is_holiday: 0,
    is_school_break: 0,
    price_level: priceLevel,
    rating: rating,
    review_count: reviewCount,
    temperature: temp,
    humidity: humidity,
    wind_speed: windSpeed,
    is_raining: isRaining,
    hour_sin: Math.sin(2 * Math.PI * hour / 24),
    hour_cos: Math.cos(2 * Math.PI * hour / 24),
    month_sin: Math.sin(2 * Math.PI * month / 12),
    month_cos: Math.cos(2 * Math.PI * month / 12),
    dow_sin: Math.sin(2 * Math.PI * dayOfWeek / 7),
    dow_cos: Math.cos(2 * Math.PI * dayOfWeek / 7),
    is_weekend: isWeekend,
    is_friday_saturday_night: isFriSatNight,
    is_lunch_hour: isLunch,
    is_dinner_hour: isDinner,
    is_late_night: isLateNight,
    is_morning: isMorning,
    season_spring: season === 'spring' ? 1 : 0,
    season_summer: season === 'summer' ? 1 : 0,
    season_fall: season === 'fall' ? 1 : 0,
    season_winter: season === 'winter' ? 1 : 0,
    venue_category_encoded: categoryEncoded,
    log_review_count: Math.log(reviewCount + 1),
    rain_x_weekend: isRaining * isWeekend,
    rain_x_dinner: isRaining * isDinner,
    cold_outdoor: (temp < 5 && weatherGroup === 'clear') ? 1 : 0,
    // Baseline + freshness — venue-specific if available, category fallback otherwise
    baseline_busyness: baseline || 0,
    category_baseline: (metadata.category_baselines || {})[`${venueCategory}_${dayOfWeek}_${hour}`] || 0,
    refined_category_baseline: (() => {
      const pt = priceLevel >= 2 ? 1 : 0;
      const pop = rating >= 4.3 ? 1 : 0;
      return (metadata.refined_baselines || {})[`${venueCategory}_${pt}_${pop}_${dayOfWeek}_${hour}`]
        || (metadata.category_baselines || {})[`${venueCategory}_${dayOfWeek}_${hour}`] || 0;
    })(),
    has_venue_baseline: baseline > 0 ? 1 : 0,
    is_realtime: 1, // live predictions are always "realtime" quality
    // Event features
    has_nearby_event: hasEvent,
    nearest_event_attendance: nearestAttendance,
    log_nearest_event_attendance: Math.log(nearestAttendance + 1),
    nearest_event_distance_km: nearestDistance,
    total_nearby_events: totalEvents,
    total_nearby_attendance: totalAttendance,
    log_total_nearby_attendance: Math.log(totalAttendance + 1),
    large_event_nearby: nearestAttendance > 5000 ? 1 : 0,
    event_x_weekend: hasEvent * isWeekend,
    event_x_dinner: hasEvent * isDinner,
    event_x_bar: hasEvent * isBar,
    etype_music: nearestType === 'music' ? 1 : 0,
    etype_sports: nearestType === 'sports' ? 1 : 0,
    etype_arts: nearestType === 'arts' ? 1 : 0,
    etype_family: nearestType === 'family' ? 1 : 0,
    etype_other: nearestType === 'other' ? 1 : 0,
    // User feedback features
    avg_user_crowd: feedback?.avgCrowd || 0,
    log_user_feedback_count: Math.log((feedback?.count || 0) + 1),
    has_user_feedback: (feedback?.count > 0) ? 1 : 0,
    avg_prediction_error: feedback?.avgError || 0,
  };

  // Weather group one-hot
  const weatherGroups = ['clear', 'few_clouds', 'cloudy', 'light_rain', 'heavy_rain',
    'snow', 'thunderstorm', 'other', 'unknown'];
  for (const g of weatherGroups) {
    features[`weather_${g}`] = weatherGroup === g ? 1 : 0;
  }

  // Google types one-hot
  const topTypes = metadata.top_google_types || [];
  for (const t of topTypes) {
    features[`gtype_${t}`] = types.includes(t) ? 1 : 0;
  }

  // Build ordered array matching feature_names
  const featureNames = metadata.feature_names || [];
  const vector = new Float32Array(featureNames.length);
  for (let i = 0; i < featureNames.length; i++) {
    vector[i] = features[featureNames[i]] || 0;
  }

  return vector;
}

function guessCategory(types) {
  if (!types || !types.length) return 'restaurant';
  if (types.includes('bar') || types.includes('night_club')) return 'bar';
  if (types.includes('cafe') || types.includes('coffee_shop')) return 'cafe';
  if (types.includes('gym') || types.includes('fitness_center')) return 'gym';
  if (types.includes('shopping_mall')) return 'mall';
  if (types.includes('museum')) return 'museum';
  if (types.includes('movie_theater')) return 'movie_theater';
  if (types.includes('fast_food_restaurant') || types.includes('meal_takeaway')) return 'fast_food';
  if (types.includes('bakery') || types.includes('ice_cream_shop')) return 'dessert';
  if (types.includes('brewery')) return 'brewery';
  return 'restaurant';
}

// ---------------------------------------------------------------------------
// Prediction Functions
// ---------------------------------------------------------------------------

async function predictBusyness(venue, weather, timestamp) {
  await init();

  if (!useML) {
    const result = crowdEngine.calculateCrowdScore(venue, weather, timestamp);
    result.predictionMethod = 'rule_engine';
    result.modelVersion = null;
    return result;
  }

  try {
    // Fetch events, feedback, and baseline in parallel — all from local DB/cache
    const lat = venue.location?.latitude || venue.latitude || venue.lat || 0;
    const lng = venue.location?.longitude || venue.longitude || venue.lng || 0;
    const placeId = venue.place_id || venue.google_place_id || null;
    const ts = timestamp ? new Date(timestamp) : new Date();
    const [eventData, feedback, baseline] = await Promise.all([
      getNearbyEvents(lat, lng, timestamp),
      getUserFeedback(placeId),
      getBaseline(placeId, ts.getDay(), ts.getHours()),
    ]);

    const ort = require('onnxruntime-node');
    const vector = buildFeatureVector(venue, weather, timestamp, eventData, feedback, baseline);

    // If venue has Google popular_times and no baseline stored yet, save it
    if (baseline === 0 && venue.popular_times) {
      storeGoogleBaselines(placeId, venue.popular_times).catch(() => {});
    }
    const inputName = metadata.onnx_input_name || 'input';
    const tensor = new ort.Tensor('float32', vector, [1, vector.length]);
    const results = await session.run({ [inputName]: tensor });

    const outputName = session.outputNames[0];
    let score = results[outputName].data[0];
    score = Math.max(0, Math.min(100, Math.round(score)));
    const label = getLabel(score);

    // Real accuracy from training metrics (within_15 = % of predictions within 15 pts)
    const confidence = Math.round(metadata.training_metrics?.within_15 || 58);

    const dataSources = ['ml_model', weather ? 'weather' : null, 'venue_data'];
    if (eventData.hasEvent) dataSources.push('ticketmaster_events');

    const response = {
      score,
      label,
      confidence,
      factors: {},
      dataSourcesUsed: dataSources.filter(Boolean),
      predictionMethod: 'ml',
      modelVersion: metadata.model_version || '2.1.0',
    };

    // Add event alert when large event nearby
    if (eventData.hasEvent && eventData.nearestAttendance > 5000) {
      response.eventAlert = {
        hasEvent: true,
        eventName: eventData.nearestName,
        estimatedAttendance: eventData.nearestAttendance,
        distance: `${eventData.nearestDistance} km away`,
      };
    }

    return response;
  } catch (err) {
    console.error('[MLPredictor] Prediction error, falling back:', err.message);
    const result = crowdEngine.calculateCrowdScore(venue, weather, timestamp);
    result.predictionMethod = 'rule_engine_fallback';
    result.modelVersion = null;
    return result;
  }
}

async function predictHourlyForecast(venue, weather, startHour, count, baseTimestamp) {
  await init();

  if (!useML) {
    return crowdEngine.generateHourlyForecast(venue, weather, startHour, count, baseTimestamp);
  }

  const hours = count || 12;
  const start = startHour != null ? startHour : new Date().getHours();
  const forecast = [];

  const base = baseTimestamp ? new Date(baseTimestamp) : new Date();
  base.setHours(start, 0, 0, 0);

  for (let i = 0; i < hours; i++) {
    const ts = new Date(base.getTime() + i * 60 * 60 * 1000);
    try {
      const result = await predictBusyness(venue, weather, ts);
      const h = (start + i) % 24;
      const period = h >= 12 ? 'PM' : 'AM';
      const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
      forecast.push({
        hour: `${displayHour} ${period}`,
        score: result.score,
        label: result.label,
      });
    } catch (err) {
      // Fallback for this hour
      const fallback = crowdEngine.calculateCrowdScore(venue, weather, ts);
      const h = (start + i) % 24;
      const period = h >= 12 ? 'PM' : 'AM';
      const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
      forecast.push({
        hour: `${displayHour} ${period}`,
        score: fallback.score,
        label: fallback.label,
      });
    }
  }

  return forecast;
}

// Re-export crowdEngine functions that ML doesn't replace
const { estimateCapacity, estimateWait, findBestTime, findPeakTime,
  findQuieterAlternatives, buildCalibrationAdjustment } = crowdEngine;

module.exports = {
  predictBusyness,
  predictHourlyForecast,
  estimateCapacity,
  estimateWait,
  findBestTime,
  findPeakTime,
  findQuieterAlternatives,
  buildCalibrationAdjustment,
  storeGoogleBaselines,
  getLabel,
  init,
};
