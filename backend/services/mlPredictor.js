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

let session = null;
let metadata = null;
let loadAttempted = false;
let useML = false;

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

function buildFeatureVector(venue, weather, timestamp) {
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
    event_nearby: 0,
    event_distance_km: 0,
    event_size: 0,
    event_hours_until: 0,
    latitude: lat,
    longitude: lng,
    busyness_pct: 0, // placeholder, not used for inference but may be in feature list
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
    lat_bin: Math.round(lat * 10) / 10,
    lng_bin: Math.round(lng * 10) / 10,
    rain_x_weekend: isRaining * isWeekend,
    rain_x_dinner: isRaining * isDinner,
    cold_outdoor: (temp < 5 && weatherGroup === 'clear') ? 1 : 0,
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
    const ort = require('onnxruntime-node');
    const vector = buildFeatureVector(venue, weather, timestamp);
    const inputName = metadata.onnx_input_name || 'input';
    const tensor = new ort.Tensor('float32', vector, [1, vector.length]);
    const results = await session.run({ [inputName]: tensor });

    const outputName = session.outputNames[0];
    let score = results[outputName].data[0];
    score = Math.max(0, Math.min(100, Math.round(score)));
    const label = getLabel(score);

    // Confidence
    let confidence = 70;
    if (weather && (weather.temp || weather.temperature)) confidence += 15;
    if (venue.rating && venue.user_ratings_total) confidence += 15;
    confidence = Math.min(95, confidence);

    return {
      score,
      label,
      confidence,
      factors: {},
      dataSourcesUsed: ['ml_model', weather ? 'weather' : null, 'venue_data'].filter(Boolean),
      predictionMethod: 'ml',
      modelVersion: metadata.model_version || '1.0.0',
    };
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
  getLabel,
  init,
};
