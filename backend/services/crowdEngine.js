// ---------------------------------------------------------------------------
// Crowd Intelligence Engine — rule-based multi-factor scoring
// Sources: Google Places + OpenWeatherMap + time patterns
// ---------------------------------------------------------------------------

const BASE_SCORE = 30;

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
  if (!types || !types.length) return true; // assume indoor by default
  return types.some(t => ['restaurant', 'bar', 'night_club', 'cafe', 'movie_theater', 'bowling_alley', 'shopping_mall'].includes(t));
}

function hasType(types, ...targets) {
  if (!types) return false;
  return targets.some(t => types.includes(t));
}

function formatHour(h) {
  const hour24 = ((h % 24) + 24) % 24;
  if (hour24 === 0) return '12 AM';
  if (hour24 < 12) return `${hour24} AM`;
  if (hour24 === 12) return '12 PM';
  return `${hour24 - 12} PM`;
}

function formatHourFull(h) {
  const hour24 = ((h % 24) + 24) % 24;
  if (hour24 === 0) return '12 AM';
  if (hour24 < 12) return `${hour24} AM`;
  if (hour24 === 12) return '12 PM';
  return `${hour24 - 12} PM`;
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

function getPopularityFactor(reviewCount) {
  if (!reviewCount) return 1;
  if (reviewCount >= 2000) return 15;
  if (reviewCount >= 1000) return 12;
  if (reviewCount >= 500) return 10;
  if (reviewCount >= 200) return 7;
  if (reviewCount >= 100) return 5;
  if (reviewCount >= 50) return 3;
  return 1;
}

function getRatingFactor(rating) {
  if (!rating) return 0;
  if (rating >= 4.5) return 7;
  if (rating >= 4.2) return 5;
  if (rating >= 4.0) return 4;
  if (rating >= 3.5) return 3;
  if (rating >= 3.0) return 1;
  return 0;
}

function getVenueTypeFactor(types, dayOfWeek, hour) {
  if (!types || !types.length) return 0;

  const weekend = isWeekend(dayOfWeek);

  if (hasType(types, 'bar', 'night_club')) {
    if (weekend && hour >= 21 && hour <= 23) return 10;
    if (weekend && hour >= 18 && hour <= 20) return 6;
    if (!weekend && hour >= 6 && hour <= 17) return -8;
    if (!weekend && hour >= 18) return 3;
  }

  if (hasType(types, 'restaurant')) {
    if (hour >= 18 && hour <= 20) return 8;
    if (hour >= 11 && hour <= 13) return 6;
    if (hour >= 14 && hour <= 17) return -10;
    if (hour >= 0 && hour <= 10) return -8;
  }

  if (hasType(types, 'cafe')) {
    if (hour >= 7 && hour <= 10) return 8;
    if (hour >= 10 && hour <= 12) return 5;
    if (hour >= 20) return -10;
  }

  if (hasType(types, 'movie_theater')) {
    if (weekend && hour >= 18 && hour <= 23) return 8;
    if ((dayOfWeek === 0 || dayOfWeek === 6) && hour >= 12 && hour <= 17) return 5;
    if (!weekend && hour >= 6 && hour <= 11) return -8;
  }

  return 0;
}

function getPriceLevelFactor(priceLevel, dayOfWeek) {
  if (priceLevel == null) return 0;
  const weekend = isWeekend(dayOfWeek);

  if (priceLevel >= 3) return weekend ? 5 : 2;
  if (priceLevel === 1) return weekend ? 3 : 0;
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

  return Math.max(-15, Math.min(8, modifier));
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

  const rawScore = BASE_SCORE + time + popularity + rating + venueType + priceLevel + weatherMod;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  // Confidence based on data availability
  let confidence = 25; // time/day always available
  if (venue.rating != null) confidence += 15;
  if (reviews > 0) confidence += 15;
  if (types.length > 0) confidence += 10;
  if (venue.price_level != null) confidence += 5;
  if (weather) confidence += 20;
  confidence = Math.min(100, confidence);

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

function generateHourlyForecast(venue, weather, startHour, count) {
  const hours = count || 12;
  const start = startHour != null ? startHour : new Date().getHours();
  const now = new Date();
  const forecast = [];

  for (let i = 0; i < hours; i++) {
    const h = start + i;
    const ts = new Date(now);
    ts.setHours(h, 0, 0, 0);

    const result = calculateCrowdScore(venue, weather, ts);
    forecast.push({
      hour: formatHour(h),
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
  } else if (hasType(types, 'restaurant')) {
    max = reviews >= 2000 ? 200 : reviews >= 500 ? 120 : reviews >= 100 ? 60 : 40;
  } else if (hasType(types, 'cafe')) {
    max = reviews >= 500 ? 80 : reviews >= 100 ? 40 : 25;
  } else {
    max = reviews >= 1000 ? 150 : reviews >= 200 ? 80 : 40;
  }

  return { current: Math.round(max * score / 100), max };
}

// ---------------------------------------------------------------------------
// Wait estimate
// ---------------------------------------------------------------------------

function estimateWait(score) {
  if (score < 40) return 'No wait';
  if (score <= 55) return '~5 min';
  if (score <= 70) return '5-15 min';
  if (score <= 85) return '15-30 min';
  return '30+ min';
}

// ---------------------------------------------------------------------------
// Best time (lowest score in reasonable future hours)
// ---------------------------------------------------------------------------

function findBestTime(hourlyForecast, venue) {
  if (!hourlyForecast || !hourlyForecast.length) return 'Right now';

  const currentScore = hourlyForecast[0].score;
  const startHour = new Date().getHours();
  const types = venue?.types || [];

  // Filter to hours when venue is likely open
  const candidates = hourlyForecast.filter((_, i) => {
    const h = ((startHour + i) % 24 + 24) % 24;
    if (hasType(types, 'restaurant')) return h >= 11 && h <= 22;
    if (hasType(types, 'cafe')) return h >= 6 && h <= 21;
    if (hasType(types, 'bar', 'night_club')) return h >= 16 || h <= 2;
    return h >= 7 && h <= 23;
  });

  if (!candidates.length) return 'Right now';

  let minEntry = candidates[0];
  let minOrigIdx = hourlyForecast.indexOf(minEntry);

  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i].score < minEntry.score) {
      minEntry = candidates[i];
      minOrigIdx = hourlyForecast.indexOf(candidates[i]);
    }
  }

  if (currentScore <= minEntry.score + 5) return 'Right now';

  return formatHourFull(startHour + minOrigIdx);
}

// ---------------------------------------------------------------------------
// Peak time (highest score, range if consecutive tie)
// ---------------------------------------------------------------------------

function findPeakTime(hourlyForecast) {
  if (!hourlyForecast || !hourlyForecast.length) return '';

  let maxScore = -1;
  let maxIndex = 0;

  for (let i = 0; i < hourlyForecast.length; i++) {
    if (hourlyForecast[i].score > maxScore) {
      maxScore = hourlyForecast[i].score;
      maxIndex = i;
    }
  }

  // Check if next hour ties (within 3 points)
  let endIndex = maxIndex;
  for (let i = maxIndex + 1; i < hourlyForecast.length; i++) {
    if (Math.abs(hourlyForecast[i].score - maxScore) <= 3) {
      endIndex = i;
    } else {
      break;
    }
  }

  const startHour = new Date().getHours() + maxIndex;
  if (endIndex > maxIndex) {
    const endHour = new Date().getHours() + endIndex + 1;
    return `${formatHourFull(startHour)} - ${formatHourFull(endHour)}`;
  }

  return formatHourFull(startHour);
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
