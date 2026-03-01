// ---------------------------------------------------------------------------
// Crowd Intelligence Engine — rule-based multi-factor scoring
// Sources: Google Places + OpenWeatherMap + time patterns
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLabel(score) {
  if (score <= 20) return 'Quiet';
  if (score <= 40) return 'Not Busy';
  if (score <= 60) return 'Moderate';
  if (score <= 80) return 'Busy';
  return 'Very Busy';
}

function isWeekend(day) {
  return day === 5 || day === 6; // Fri or Sat
}

function isIndoor(types) {
  if (!types || !types.length) return true;
  return types.some(t => ['restaurant', 'bar', 'night_club', 'cafe', 'movie_theater', 'bowling_alley', 'shopping_mall', 'juice_shop', 'diner', 'american_restaurant', 'fast_food_restaurant', 'gym', 'fitness_center', 'library', 'museum'].includes(t));
}

function hasType(types, ...targets) {
  if (!types) return false;
  return targets.some(t => types.includes(t));
}

// Google returns granular types — map them to behavioral categories
function isCafeLike(types) {
  return hasType(types, 'cafe', 'juice_shop', 'smoothie_shop', 'juice_bar', 'tea_house', 'coffee_shop');
}

function isDinerLike(types) {
  return hasType(types, 'diner', 'breakfast_restaurant', 'brunch_restaurant');
}

function isFastFoodLike(types) {
  return hasType(types, 'fast_food_restaurant', 'meal_takeaway');
}

function formatHour(h) {
  const hour24 = ((h % 24) + 24) % 24;
  if (hour24 === 0) return '12 AM';
  if (hour24 < 12) return `${hour24} AM`;
  if (hour24 === 12) return '12 PM';
  return `${hour24 - 12} PM`;
}

// Simple deterministic hash from place_id to add per-venue variance
function venueHash(placeId) {
  if (!placeId) return 0;
  let hash = 0;
  for (let i = 0; i < placeId.length; i++) {
    hash = ((hash << 5) - hash + placeId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// ---------------------------------------------------------------------------
// Scoring factors
// ---------------------------------------------------------------------------

function getTimeFactor(dayOfWeek, hour) {
  // Friday (5) or Saturday (6)
  if (dayOfWeek === 5 || dayOfWeek === 6) {
    if (hour >= 21 && hour <= 23) return 30;
    if (hour >= 18 && hour <= 20) return 28;
    if (hour >= 12 && hour <= 14) return 18;
    if (hour >= 9 && hour <= 11) return 8;
    if (hour >= 0 && hour <= 5) return 3;
    return 12;
  }

  // Thursday (4)
  if (dayOfWeek === 4) {
    if (hour >= 21 && hour <= 23) return 24;
    if (hour >= 18 && hour <= 20) return 22;
    return 10;
  }

  // Sunday (0)
  if (dayOfWeek === 0) {
    if (hour >= 10 && hour <= 13) return 20;
    if (hour >= 18 && hour <= 20) return 15;
    return 5;
  }

  // Mon-Wed (1-3)
  if (hour >= 11 && hour <= 13) return 15;
  if (hour >= 18 && hour <= 20) return 18;
  if (hour >= 21 && hour <= 23) return 10;
  if (hour >= 14 && hour <= 17) return 3;
  if (hour >= 6 && hour <= 10) return 5;
  return 2;
}

// Continuous popularity using log scale — venues with more reviews are busier
function getPopularityFactor(reviewCount) {
  if (!reviewCount || reviewCount <= 0) return 0;
  // log2(50) ≈ 5.6 → 8, log2(500) ≈ 9 → 13, log2(5000) ≈ 12.3 → 18
  return Math.min(25, Math.round(Math.log2(reviewCount) * 1.5));
}

function getRatingFactor(rating) {
  if (!rating) return 0;
  // Continuous: 3.0 → 0, 4.0 → 6, 4.5 → 9, 5.0 → 12
  return Math.min(12, Math.max(0, Math.round((rating - 3.0) * 6)));
}

function getVenueTypeFactor(types, dayOfWeek, hour) {
  if (!types || !types.length) return 0;

  const weekend = isWeekend(dayOfWeek);

  // Bars & clubs — big swings between dead daytime and peak nightlife
  if (hasType(types, 'bar', 'night_club')) {
    if (weekend && hour >= 22) return 15;
    if (weekend && hour >= 21) return 12;
    if (weekend && hour >= 18 && hour <= 20) return 8;
    if (hour >= 22) return 12;
    if (hour >= 21) return 10;
    if (hour >= 18 && hour <= 20) return 5;
    if (hour >= 6 && hour <= 16) return -12;
    if (hour >= 0 && hour <= 5) return -5;
    return -8;
  }

  // Diners — breakfast/lunch spots, NOT dinner places
  if (isDinerLike(types)) {
    if (hour >= 7 && hour <= 9) return weekend ? 18 : 15;   // Breakfast rush
    if (hour >= 10 && hour <= 11) return weekend ? 14 : 10;  // Late breakfast
    if (hour >= 11 && hour <= 13) return weekend ? 12 : 10;  // Lunch
    if (hour >= 14 && hour <= 16) return -8;                  // Dead afternoon
    if (hour >= 17 && hour <= 20) return -5;                  // Some dinner but not peak
    if (hour >= 21) return -12;                               // Closing up
    if (hour >= 0 && hour <= 6) return -15;                   // Closed
    return -5;
  }

  // Fast food — lunch peak, steady dinner, quick turnover
  if (isFastFoodLike(types)) {
    if (hour >= 11 && hour <= 13) return weekend ? 12 : 15;  // Lunch rush (bigger weekday)
    if (hour >= 18 && hour <= 20) return weekend ? 10 : 8;   // Dinner secondary
    if (hour >= 14 && hour <= 17) return -5;                  // Afternoon lull
    if (hour >= 7 && hour <= 10) return 3;                    // Breakfast
    if (hour >= 21) return -10;
    return -8;
  }

  // Restaurants — dinner is ALWAYS the peak, lunch is secondary
  if (hasType(types, 'restaurant')) {
    if (hour >= 18 && hour <= 20) return weekend ? 18 : 15;
    if (hour >= 21 && hour <= 22) return weekend ? 10 : 6;
    if (hour >= 11 && hour <= 13) return weekend ? 5 : 4;
    if (hour >= 14 && hour <= 17) return -12;
    if (hour >= 0 && hour <= 10) return -10;
    return -5;
  }

  // Cafes, juice shops, smoothie shops — morning rush, dead evening
  if (isCafeLike(types)) {
    if (hour >= 7 && hour <= 9) return 10;
    if (hour >= 10 && hour <= 11) return 6;
    if (hour >= 12 && hour <= 14) return 2;
    if (hour >= 15 && hour <= 17) return -8;
    if (hour >= 20) return -15;
    return -5;
  }

  // Movie theaters
  if (hasType(types, 'movie_theater')) {
    if (weekend && hour >= 18 && hour <= 22) return 10;
    if (weekend && hour >= 13 && hour <= 17) return 6;
    if (hour >= 18 && hour <= 21) return 5;
    if (hour >= 6 && hour <= 11) return -10;
    return -3;
  }

  // Shopping malls — weekend afternoon peak, weekday lunch secondary
  if (hasType(types, 'shopping_mall')) {
    if (weekend && hour >= 12 && hour <= 17) return 15;
    if (weekend && hour >= 10 && hour <= 11) return 10;
    if (weekend && hour >= 18 && hour <= 20) return 8;
    if (hour >= 12 && hour <= 14) return 8;  // Weekday lunch
    if (hour >= 15 && hour <= 17) return 5;
    if (hour >= 18 && hour <= 20) return 3;
    if (hour >= 10 && hour <= 11) return 2;
    if (hour >= 21 || hour <= 9) return -12;
    return -5;
  }

  // Gyms & fitness — early morning and after-work peaks
  if (hasType(types, 'gym', 'fitness_center')) {
    if (hour >= 6 && hour <= 8) return weekend ? 5 : 12;   // Morning rush (bigger weekday)
    if (hour >= 17 && hour <= 19) return weekend ? 5 : 15;  // After-work peak
    if (hour >= 9 && hour <= 11) return weekend ? 10 : 3;   // Weekend morning
    if (hour >= 12 && hour <= 14) return 3;                  // Lunch crowd
    if (hour >= 20 && hour <= 21) return -3;
    if (hour >= 22 || hour <= 5) return -15;
    return -5;
  }

  // Libraries & museums — daytime only, quiet evenings
  if (hasType(types, 'library', 'museum')) {
    if (weekend && hour >= 11 && hour <= 15) return 10;
    if (hour >= 11 && hour <= 14) return 6;
    if (hour >= 15 && hour <= 17) return 3;
    if (hour >= 9 && hour <= 10) return 2;
    if (hour >= 18 || hour <= 8) return -12;
    return -5;
  }

  // Parks
  if (hasType(types, 'park')) {
    if (weekend && hour >= 10 && hour <= 16) return 10;
    if (hour >= 10 && hour <= 16) return 5;
    if (hour >= 17 && hour <= 19) return 3;
    if (hour >= 20 || hour <= 6) return -10;
    return 0;
  }

  return 0;
}

function getPriceLevelFactor(priceLevel, dayOfWeek) {
  if (priceLevel == null) return 0;
  const weekend = isWeekend(dayOfWeek);

  if (priceLevel >= 3) return weekend ? 6 : 3;
  if (priceLevel === 2) return weekend ? 3 : 1;
  if (priceLevel === 1) return weekend ? 4 : 2;
  return 0;
}

function getWeatherFactor(weather, types) {
  if (!weather) return 0;

  let modifier = 0;
  const indoor = isIndoor(types);

  if (weather.isRaining) {
    if (hasType(types, 'park')) modifier += -15;
    else if (indoor) modifier += 5;
    else modifier += -5;
  }

  if (weather.temp > 95 || weather.temp < 20) {
    modifier += indoor ? 5 : -10;
  } else if (weather.temp >= 65 && weather.temp <= 80 && !weather.isRaining) {
    modifier += 5;
  }

  if (weather.windSpeed > 25) {
    if (!indoor) modifier += -8;
  }

  return Math.max(-15, Math.min(10, modifier));
}

// ---------------------------------------------------------------------------
// Main scoring function
// ---------------------------------------------------------------------------

function calculateCrowdScore(venue, weather, timestamp) {
  const ts = timestamp || new Date();
  const dayOfWeek = ts.getDay();
  const hour = ts.getHours();

  const types = venue.types || [];
  const reviews = venue.user_ratings_total || 0;

  const time = getTimeFactor(dayOfWeek, hour);
  const popularity = getPopularityFactor(reviews);
  const rating = getRatingFactor(venue.rating);
  const venueType = getVenueTypeFactor(types, dayOfWeek, hour);
  const priceLevel = getPriceLevelFactor(venue.price_level, dayOfWeek);
  const weatherMod = getWeatherFactor(weather, types);

  // Per-venue variance: ±7 points from place_id hash so no two venues are identical
  const hash = venueHash(venue.place_id);
  const venueVariance = (hash % 15) - 7; // range: -7 to +7

  const rawScore = 10 + time + popularity + rating + venueType + priceLevel + weatherMod + venueVariance;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  // Confidence based on data quality
  let confidence = 20; // time/day always available

  // Review count is the strongest confidence signal (continuous)
  if (reviews >= 5000) confidence += 30;
  else if (reviews >= 2000) confidence += 25;
  else if (reviews >= 1000) confidence += 20;
  else if (reviews >= 500) confidence += 16;
  else if (reviews >= 200) confidence += 12;
  else if (reviews >= 100) confidence += 8;
  else if (reviews >= 50) confidence += 5;
  else if (reviews > 0) confidence += 2;

  // Rating precision (more reviews = more reliable rating)
  if (venue.rating != null) {
    if (reviews >= 500) confidence += 10;
    else if (reviews >= 100) confidence += 6;
    else confidence += 3;
  }

  // Venue type helps scoring accuracy
  if (types.length >= 3) confidence += 8;
  else if (types.length > 0) confidence += 4;

  // Price level is a minor signal
  if (venue.price_level != null) confidence += 3;

  // Weather data adds real-time accuracy
  if (weather) confidence += 15;

  confidence = Math.min(95, confidence);

  const dataSourcesUsed = ['google_places', 'time_patterns'];
  if (weather) dataSourcesUsed.push('weather');

  return {
    score,
    label: getLabel(score),
    confidence,
    factors: { time, popularity, rating, venueType, priceLevel, weather: weatherMod },
    dataSourcesUsed,
  };
}

// ---------------------------------------------------------------------------
// Hourly forecast
// ---------------------------------------------------------------------------

function generateHourlyForecast(venue, weather, startHour, count, baseTimestamp) {
  const hours = count || 12;
  const start = startHour != null ? startHour : new Date().getHours();
  const forecast = [];

  // Use provided base timestamp (already timezone-adjusted) or create one
  const base = baseTimestamp ? new Date(baseTimestamp) : new Date();
  base.setHours(start, 0, 0, 0);

  for (let i = 0; i < hours; i++) {
    const ts = new Date(base.getTime() + i * 60 * 60 * 1000);

    const result = calculateCrowdScore(venue, weather, ts);
    forecast.push({
      hour: formatHour(start + i),
      score: result.score,
      label: result.label,
    });
  }

  return forecast;
}

// ---------------------------------------------------------------------------
// Capacity estimate
// ---------------------------------------------------------------------------

function estimateCapacity(venue, score) {
  const types = venue.types || [];
  const reviews = venue.user_ratings_total || 0;
  let max;

  if (hasType(types, 'night_club')) {
    max = reviews >= 1000 ? 300 : reviews >= 500 ? 200 : 100;
  } else if (hasType(types, 'bar')) {
    max = reviews >= 1000 ? 200 : reviews >= 500 ? 120 : 60;
  } else if (isDinerLike(types)) {
    max = reviews >= 1000 ? 120 : reviews >= 500 ? 80 : reviews >= 100 ? 50 : 30;
  } else if (isFastFoodLike(types)) {
    max = reviews >= 2000 ? 150 : reviews >= 500 ? 100 : reviews >= 100 ? 60 : 35;
  } else if (hasType(types, 'restaurant')) {
    max = reviews >= 2000 ? 200 : reviews >= 500 ? 120 : reviews >= 100 ? 60 : 40;
  } else if (isCafeLike(types)) {
    max = reviews >= 500 ? 80 : reviews >= 100 ? 40 : 25;
  } else if (hasType(types, 'shopping_mall')) {
    max = reviews >= 5000 ? 2000 : reviews >= 2000 ? 1000 : reviews >= 500 ? 500 : 200;
  } else if (hasType(types, 'gym', 'fitness_center')) {
    max = reviews >= 1000 ? 200 : reviews >= 500 ? 120 : reviews >= 100 ? 60 : 30;
  } else if (hasType(types, 'library', 'museum')) {
    max = reviews >= 2000 ? 300 : reviews >= 500 ? 150 : reviews >= 100 ? 80 : 40;
  } else if (hasType(types, 'movie_theater')) {
    max = reviews >= 2000 ? 400 : reviews >= 500 ? 200 : 100;
  } else {
    max = reviews >= 1000 ? 150 : reviews >= 200 ? 80 : 40;
  }

  return { current: Math.round(max * score / 100), max };
}

// ---------------------------------------------------------------------------
// Wait estimate
// ---------------------------------------------------------------------------

function estimateWait(score, types) {
  if (hasType(types, 'bar')) {
    if (score < 50) return 'No wait';
    if (score <= 70) return '~5 min';
    if (score <= 85) return '5-10 min';
    return '10-15 min';
  }

  if (hasType(types, 'night_club')) {
    if (score < 40) return 'No wait';
    if (score <= 60) return '5-10 min';
    if (score <= 80) return '15-30 min';
    return '30-60 min';
  }

  // Cafes, juice shops, smoothie shops — quick service
  if (isCafeLike(types)) {
    if (score < 50) return 'No wait';
    if (score <= 70) return '~3 min';
    if (score <= 85) return '5-10 min';
    return '10-15 min';
  }

  // Fast food — quick turnover
  if (isFastFoodLike(types)) {
    if (score < 40) return 'No wait';
    if (score <= 60) return '~3 min';
    if (score <= 80) return '5-10 min';
    return '10-15 min';
  }

  // Diners — counter + table service, faster than fine dining
  if (isDinerLike(types)) {
    if (score < 40) return 'No wait';
    if (score <= 55) return '~5 min';
    if (score <= 70) return '5-15 min';
    if (score <= 85) return '15-25 min';
    return '25+ min';
  }

  // Shopping malls — no real "wait", describe crowd level
  if (hasType(types, 'shopping_mall')) {
    if (score < 30) return 'Uncrowded';
    if (score <= 50) return 'Light crowds';
    if (score <= 70) return 'Moderate crowds';
    if (score <= 85) return 'Crowded';
    return 'Very crowded';
  }

  // Gyms — equipment wait
  if (hasType(types, 'gym', 'fitness_center')) {
    if (score < 40) return 'Equipment open';
    if (score <= 60) return 'Some equipment in use';
    if (score <= 80) return 'Most equipment busy';
    return 'Packed — expect waits';
  }

  // Libraries, museums — space availability
  if (hasType(types, 'library', 'museum')) {
    if (score < 40) return 'Plenty of space';
    if (score <= 60) return 'Some seats taken';
    if (score <= 80) return 'Getting full';
    return 'Very full';
  }

  // Movie theaters — ticket line
  if (hasType(types, 'movie_theater')) {
    if (score < 40) return 'No line';
    if (score <= 60) return 'Short line';
    if (score <= 80) return '10-15 min line';
    return '15-30 min line';
  }

  // Restaurants: table waits
  if (score < 40) return 'No wait';
  if (score <= 55) return '~5 min';
  if (score <= 70) return '10-20 min';
  if (score <= 85) return '20-35 min';
  return '35+ min';
}

// ---------------------------------------------------------------------------
// Best time — lowest score, excluding peak hours and closed hours
// ---------------------------------------------------------------------------

function isOpenHour(h, types, openHour, closeHour) {
  // Use real hours from Google if available
  if (openHour != null && closeHour != null) return h >= openHour && h <= closeHour;
  if (hasType(types, 'bar', 'night_club')) return (h >= 16 || h <= 2);
  if (isDinerLike(types)) return (h >= 6 && h <= 21);
  if (isFastFoodLike(types)) return (h >= 6 && h <= 23);
  if (hasType(types, 'restaurant')) return (h >= 11 && h <= 22);
  if (isCafeLike(types)) return (h >= 6 && h <= 21);
  if (hasType(types, 'shopping_mall')) return (h >= 10 && h <= 21);
  if (hasType(types, 'gym', 'fitness_center')) return (h >= 5 && h <= 23);
  if (hasType(types, 'library', 'museum')) return (h >= 9 && h <= 18);
  if (hasType(types, 'park')) return (h >= 6 && h <= 21);
  return (h >= 8 && h <= 23);
}

function findBestTime(hourlyForecast, venue, peakStartIdx, peakEndIdx, isOpen) {
  if (!hourlyForecast || !hourlyForecast.length) return 'Now is good';

  const currentScore = hourlyForecast[0].score;
  const types = venue?.types || [];

  const candidates = [];
  for (let i = 0; i < hourlyForecast.length; i++) {
    if (peakStartIdx != null && i >= peakStartIdx && i <= peakEndIdx) continue;

    const h = parseHourLabel(hourlyForecast[i].hour);
    if (!isOpenHour(h, types, venue?.openHour, venue?.closeHour)) continue;

    candidates.push({ entry: hourlyForecast[i], idx: i });
  }

  if (!candidates.length) return 'Now is good';

  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i].entry.score < best.entry.score) {
      best = candidates[i];
    }
  }

  // If venue is currently closed, never say "Now is good"
  if (isOpen === false) return hourlyForecast[best.idx].hour;

  if (currentScore <= best.entry.score + 5) return 'Now is good';

  return hourlyForecast[best.idx].hour;
}

function parseHourLabel(label) {
  if (!label) return 12;
  const parts = label.match(/^(\d+)\s*(AM|PM)$/i);
  if (!parts) return 12;
  let h = parseInt(parts[1], 10);
  const ampm = parts[2].toUpperCase();
  if (ampm === 'AM' && h === 12) h = 0;
  else if (ampm === 'PM' && h !== 12) h += 12;
  return h;
}

// ---------------------------------------------------------------------------
// Peak time (highest score, range if consecutive tie)
// Returns { text, startIdx, endIdx } so bestTime can avoid peak
// ---------------------------------------------------------------------------

function findPeakTime(hourlyForecast, venue) {
  if (!hourlyForecast || !hourlyForecast.length) return { text: '', startIdx: 0, endIdx: 0 };

  const types = venue?.types || [];
  let maxScore = -1;
  let maxIndex = 0;

  for (let i = 0; i < hourlyForecast.length; i++) {
    const h = parseHourLabel(hourlyForecast[i].hour);
    if (types.length && !isOpenHour(h, types, venue?.openHour, venue?.closeHour)) continue;

    if (hourlyForecast[i].score > maxScore) {
      maxScore = hourlyForecast[i].score;
      maxIndex = i;
    }
  }

  let endIndex = maxIndex;
  for (let i = maxIndex + 1; i < hourlyForecast.length; i++) {
    const h = parseHourLabel(hourlyForecast[i].hour);
    if (types.length && !isOpenHour(h, types, venue?.openHour, venue?.closeHour)) break;
    if (Math.abs(hourlyForecast[i].score - maxScore) <= 3) {
      endIndex = i;
    } else {
      break;
    }
  }

  const startLabel = hourlyForecast[maxIndex].hour;
  let text;
  if (endIndex > maxIndex) {
    const endLabel = hourlyForecast[endIndex].hour;
    text = `${startLabel} - ${endLabel}`;
  } else {
    text = startLabel;
  }

  return { text, startIdx: maxIndex, endIdx: endIndex };
}

// ---------------------------------------------------------------------------
// Quieter alternatives
// ---------------------------------------------------------------------------

function findQuieterAlternatives(venues, currentScore, weather, timestamp, limit) {
  const max = limit || 2;
  const scored = venues.map(v => {
    const result = calculateCrowdScore(v, weather, timestamp);
    return {
      placeId: v.place_id,
      name: v.name,
      score: result.score,
      label: result.label,
    };
  });

  return scored
    .filter(v => v.score < currentScore)
    .sort((a, b) => a.score - b.score)
    .slice(0, max);
}

module.exports = {
  calculateCrowdScore,
  generateHourlyForecast,
  estimateCapacity,
  estimateWait,
  findBestTime,
  findPeakTime,
  findQuieterAlternatives,
};
