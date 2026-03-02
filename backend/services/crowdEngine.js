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
  return types.some(t => ['restaurant', 'bar', 'night_club', 'cafe', 'movie_theater', 'bowling_alley', 'shopping_mall', 'juice_shop', 'diner', 'american_restaurant', 'fast_food_restaurant', 'gym', 'fitness_center', 'library', 'museum', 'steak_house', 'seafood_restaurant', 'sushi_restaurant', 'italian_restaurant', 'mexican_restaurant', 'indian_restaurant', 'chinese_restaurant', 'japanese_restaurant', 'korean_restaurant', 'thai_restaurant', 'vietnamese_restaurant', 'french_restaurant', 'mediterranean_restaurant', 'pizza_restaurant', 'hamburger_restaurant', 'ice_cream_shop', 'bakery', 'dessert_shop', 'ramen_restaurant', 'barbecue_restaurant'].includes(t));
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
  return hasType(types, 'fast_food_restaurant', 'meal_takeaway', 'hamburger_restaurant');
}

function isSteakhouseLike(types) {
  return hasType(types, 'steak_house', 'barbecue_restaurant');
}

function isFineDining(types, priceLevel) {
  return (priceLevel >= 3 && hasType(types, 'restaurant', 'steak_house', 'seafood_restaurant', 'french_restaurant', 'italian_restaurant', 'japanese_restaurant', 'mediterranean_restaurant'));
}

function isBrunchSpot(types) {
  return hasType(types, 'brunch_restaurant', 'breakfast_restaurant') || isDinerLike(types);
}

function isSushiLike(types) {
  return hasType(types, 'sushi_restaurant', 'japanese_restaurant');
}

function isSeafoodLike(types) {
  return hasType(types, 'seafood_restaurant');
}

function isPizzaLike(types) {
  return hasType(types, 'pizza_restaurant');
}

function isMexicanLike(types) {
  return hasType(types, 'mexican_restaurant', 'taco_shop');
}

function isAsianLike(types) {
  return hasType(types, 'chinese_restaurant', 'korean_restaurant', 'thai_restaurant', 'vietnamese_restaurant', 'ramen_restaurant', 'indian_restaurant');
}

function isDessertLike(types) {
  return hasType(types, 'ice_cream_shop', 'bakery', 'dessert_shop', 'dessert_restaurant');
}

function isBarLike(types) {
  return hasType(types, 'bar', 'wine_bar', 'cocktail_bar', 'sports_bar', 'pub', 'brewery', 'beer_garden');
}

function isSportsBar(types) {
  return hasType(types, 'sports_bar');
}

function isBreweryLike(types) {
  return hasType(types, 'brewery', 'beer_garden');
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
// Popularity tiers — defines how strongly review count amplifies everything
// ---------------------------------------------------------------------------

function getPopularityTier(reviewCount) {
  if (!reviewCount || reviewCount <= 0) return { tier: 'unknown', base: 0, multiplier: 1.0 };
  if (reviewCount >= 10000) return { tier: 'landmark', base: 22, multiplier: 1.45 };
  if (reviewCount >= 5000) return { tier: 'destination', base: 20, multiplier: 1.35 };
  if (reviewCount >= 2000) return { tier: 'very_popular', base: 17, multiplier: 1.25 };
  if (reviewCount >= 1000) return { tier: 'popular', base: 14, multiplier: 1.18 };
  if (reviewCount >= 500) return { tier: 'well_known', base: 11, multiplier: 1.12 };
  if (reviewCount >= 200) return { tier: 'established', base: 8, multiplier: 1.06 };
  if (reviewCount >= 100) return { tier: 'moderate', base: 5, multiplier: 1.0 };
  if (reviewCount >= 50) return { tier: 'small', base: 3, multiplier: 0.95 };
  return { tier: 'new', base: 1, multiplier: 0.9 };
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

function getRatingFactor(rating) {
  if (!rating) return 0;
  // Continuous: 3.0 → 0, 4.0 → 6, 4.5 → 9, 5.0 → 12
  return Math.min(12, Math.max(0, Math.round((rating - 3.0) * 6)));
}

// ---------------------------------------------------------------------------
// Venue-type × time × price interaction — this is where realism lives
// Returns a modifier that stacks on top of the base time factor
// Popular venues get these bonuses AMPLIFIED by their popularity multiplier
// ---------------------------------------------------------------------------

function getVenueContextBonus(types, dayOfWeek, hour, priceLevel, reviews) {
  if (!types || !types.length) return 0;

  const weekend = isWeekend(dayOfWeek);
  const thursdayPlus = dayOfWeek >= 4 && dayOfWeek <= 6; // Thu-Sat
  const sunday = dayOfWeek === 0;
  let bonus = 0;

  // ─── STEAKHOUSES & BBQ ───
  // Popular steakhouses at 7-9 PM are almost always booked out
  if (isSteakhouseLike(types)) {
    if (hour >= 19 && hour <= 21 && weekend) bonus += 20;
    else if (hour >= 18 && hour <= 21 && thursdayPlus) bonus += 16;
    else if (hour >= 18 && hour <= 20) bonus += 12; // Even weekday dinners are solid
    else if (hour >= 12 && hour <= 13 && weekend) bonus += 8; // Weekend lunch
    else if (hour >= 12 && hour <= 13) bonus += 4; // Weekday lunch
    else if (hour >= 14 && hour <= 17) bonus += -10; // Dead afternoon
    else if (hour >= 22) bonus += -5; // Winding down
    else if (hour <= 11) bonus += -12; // Most aren't open

    // Expensive steakhouses are even more packed
    if (priceLevel >= 3 && hour >= 18 && hour <= 21) bonus += 8;
    return bonus;
  }

  // ─── FINE DINING (price 3-4, any cuisine) ───
  // These are reservation-heavy, packed at prime dinner, dead off-hours
  if (isFineDining(types, priceLevel)) {
    if (hour >= 19 && hour <= 21 && weekend) bonus += 22;
    else if (hour >= 18 && hour <= 21 && thursdayPlus) bonus += 18;
    else if (hour >= 18 && hour <= 20) bonus += 14; // Weekday dinner
    else if (hour >= 12 && hour <= 13) bonus += (weekend ? 6 : 8); // Weekday business lunch
    else if (hour >= 14 && hour <= 17) bonus += -12;
    else if (hour <= 11) bonus += -15;
    return bonus;
  }

  // ─── SUSHI RESTAURANTS ───
  // Prime dinner time 6:30-9, weekend is crazy for popular spots
  if (isSushiLike(types)) {
    if (hour >= 18 && hour <= 21 && weekend) bonus += 18;
    else if (hour >= 18 && hour <= 20 && thursdayPlus) bonus += 14;
    else if (hour >= 18 && hour <= 20) bonus += 10;
    else if (hour >= 12 && hour <= 13) bonus += 6; // Lunch specials
    else if (hour >= 14 && hour <= 17) bonus += -10;
    else if (hour <= 11) bonus += -12;
    // Expensive sushi = even busier at dinner
    if (priceLevel >= 3 && hour >= 18 && hour <= 21) bonus += 6;
    return bonus;
  }

  // ─── SEAFOOD ───
  // Weekend dinner is king, Friday especially
  if (isSeafoodLike(types)) {
    if (hour >= 18 && hour <= 21 && dayOfWeek === 5) bonus += 20; // Friday seafood
    else if (hour >= 18 && hour <= 21 && weekend) bonus += 18;
    else if (hour >= 18 && hour <= 20 && thursdayPlus) bonus += 14;
    else if (hour >= 18 && hour <= 20) bonus += 10;
    else if (hour >= 11 && hour <= 13 && sunday) bonus += 10; // Sunday brunch/lunch
    else if (hour >= 12 && hour <= 13) bonus += 5;
    else if (hour >= 14 && hour <= 17) bonus += -10;
    else if (hour <= 11) bonus += -12;
    return bonus;
  }

  // ─── MEXICAN / TACO ───
  // Happy hour 4-6 is a thing, dinner 7-9, late night on weekends
  if (isMexicanLike(types)) {
    if (hour >= 19 && hour <= 21 && weekend) bonus += 16;
    else if (hour >= 16 && hour <= 18 && thursdayPlus) bonus += 12; // Happy hour
    else if (hour >= 18 && hour <= 20) bonus += 10;
    else if (hour >= 22 && hour <= 24 && weekend) bonus += 8; // Late night mex
    else if (hour >= 11 && hour <= 13) bonus += 6; // Lunch
    else if (hour >= 14 && hour <= 15) bonus += -8;
    else if (hour <= 10) bonus += -10;
    // Cheap Mexican = packed at lunch
    if (priceLevel <= 1 && hour >= 11 && hour <= 13) bonus += 6;
    return bonus;
  }

  // ─── PIZZA ───
  // Dinner peak, late night on weekends, family lunch on weekends
  if (isPizzaLike(types)) {
    if (hour >= 18 && hour <= 20 && weekend) bonus += 14;
    else if (hour >= 21 && hour <= 23 && weekend) bonus += 10; // Late night pizza
    else if (hour >= 18 && hour <= 20) bonus += 10;
    else if (hour >= 11 && hour <= 13 && weekend) bonus += 8; // Family lunch
    else if (hour >= 11 && hour <= 13) bonus += 6;
    else if (hour >= 14 && hour <= 17) bonus += -6;
    else if (hour <= 10) bonus += -10;
    // Cheap pizza = always busy
    if (priceLevel <= 1 && hour >= 11 && hour <= 21) bonus += 4;
    return bonus;
  }

  // ─── ASIAN (Chinese, Korean, Thai, Vietnamese, Ramen, Indian) ───
  // Dinner is king, lunch specials draw crowds
  if (isAsianLike(types)) {
    if (hour >= 18 && hour <= 20 && weekend) bonus += 16;
    else if (hour >= 18 && hour <= 20) bonus += 12;
    else if (hour >= 11 && hour <= 13) bonus += (priceLevel <= 1 ? 10 : 6); // Cheap lunch = packed
    else if (hour >= 21 && hour <= 22 && weekend) bonus += 6;
    else if (hour >= 14 && hour <= 17) bonus += -8;
    else if (hour <= 10) bonus += -10;
    // Korean BBQ, hot pot — weekend dinner is an EVENT
    if (hasType(types, 'korean_restaurant') && hour >= 18 && hour <= 21 && weekend) bonus += 6;
    return bonus;
  }

  // ─── DESSERT / ICE CREAM / BAKERY ───
  // Afternoon and evening, weekends especially, weather dependent
  if (isDessertLike(types)) {
    if (hour >= 14 && hour <= 17 && weekend) bonus += 14;
    else if (hour >= 19 && hour <= 21 && weekend) bonus += 12;
    else if (hour >= 14 && hour <= 17) bonus += 8;
    else if (hour >= 19 && hour <= 21) bonus += 6;
    else if (hour >= 7 && hour <= 9 && hasType(types, 'bakery')) bonus += 8; // Morning bakery
    else if (hour >= 10 && hour <= 13) bonus += 3;
    else if (hour >= 22 || hour <= 6) bonus += -12;
    return bonus;
  }

  // ─── BRUNCH SPOTS / BREAKFAST ───
  // Sunday brunch is INSANE for popular spots, Saturday too
  if (isBrunchSpot(types)) {
    if (hour >= 9 && hour <= 12 && sunday) bonus += 20;
    else if (hour >= 9 && hour <= 12 && dayOfWeek === 6) bonus += 18;
    else if (hour >= 7 && hour <= 9 && !weekend) bonus += 12; // Weekday breakfast rush
    else if (hour >= 10 && hour <= 13 && weekend) bonus += 16;
    else if (hour >= 10 && hour <= 13) bonus += 8;
    else if (hour >= 14 && hour <= 16) bonus += -8;
    else if (hour >= 17 && hour <= 20) bonus += -5;
    else if (hour >= 21 || hour <= 6) bonus += -15;
    return bonus;
  }

  // ─── SPORTS BARS ───
  // Game nights (especially weekends), Thursday night football
  if (isSportsBar(types)) {
    if (hour >= 18 && hour <= 23 && weekend) bonus += 18;
    else if (hour >= 18 && hour <= 22 && dayOfWeek === 4) bonus += 16; // Thursday night
    else if (hour >= 12 && hour <= 16 && sunday) bonus += 14; // Sunday football
    else if (hour >= 18 && hour <= 22) bonus += 8;
    else if (hour >= 11 && hour <= 13) bonus += 4; // Lunch
    else if (hour >= 6 && hour <= 10) bonus += -12;
    return bonus;
  }

  // ─── BREWERIES & BEER GARDENS ───
  // Thu-Sat evening is prime, weekend afternoons are popular
  if (isBreweryLike(types)) {
    if (hour >= 17 && hour <= 21 && weekend) bonus += 16;
    else if (hour >= 14 && hour <= 16 && weekend) bonus += 12; // Weekend afternoon hangs
    else if (hour >= 17 && hour <= 21 && thursdayPlus) bonus += 14;
    else if (hour >= 17 && hour <= 20) bonus += 6;
    else if (hour >= 12 && hour <= 14) bonus += 3;
    else if (hour >= 22) bonus += -5;
    else if (hour <= 11) bonus += -12;
    return bonus;
  }

  // ─── BARS / NIGHTLIFE (generic) ───
  if (isBarLike(types)) {
    if (weekend && hour >= 22) bonus += 18;
    else if (weekend && hour >= 21) bonus += 15;
    else if (weekend && hour >= 18 && hour <= 20) bonus += 10;
    else if (thursdayPlus && hour >= 21) bonus += 14;
    else if (hour >= 22) bonus += 12;
    else if (hour >= 21) bonus += 10;
    else if (hour >= 17 && hour <= 20) bonus += 5; // Happy hour
    else if (hour >= 6 && hour <= 16) bonus += -12;
    else if (hour >= 0 && hour <= 5) bonus += -5;
    return bonus;
  }

  // ─── NIGHTCLUBS ───
  if (hasType(types, 'night_club')) {
    if (weekend && hour >= 23) bonus += 22;
    else if (weekend && hour >= 22) bonus += 20;
    else if (weekend && hour >= 21) bonus += 14;
    else if (thursdayPlus && hour >= 22) bonus += 16;
    else if (hour >= 22) bonus += 12;
    else if (hour >= 0 && hour <= 2) bonus += (weekend ? 18 : 8);
    else if (hour >= 3 && hour <= 17) bonus += -15;
    return bonus;
  }

  // ─── FAST FOOD ───
  // Lunch rush is massive, especially cheap popular ones
  if (isFastFoodLike(types)) {
    if (hour >= 11 && hour <= 13 && !weekend) bonus += 14; // Weekday lunch rush
    else if (hour >= 11 && hour <= 13 && weekend) bonus += 10;
    else if (hour >= 18 && hour <= 20) bonus += 8;
    else if (hour >= 22 && hour <= 24 && weekend) bonus += 6; // Late night drive-thru
    else if (hour >= 7 && hour <= 9) bonus += 4; // Breakfast
    else if (hour >= 14 && hour <= 17) bonus += -6;
    else if (hour >= 21 && !weekend) bonus += -8;
    // Cheap + popular fast food = ALWAYS a line at peak
    if (priceLevel <= 1 && reviews >= 500 && hour >= 11 && hour <= 13) bonus += 6;
    return bonus;
  }

  // ─── CAFES / COFFEE SHOPS ───
  if (isCafeLike(types)) {
    if (hour >= 7 && hour <= 9 && !weekend) bonus += 14; // Weekday morning rush
    else if (hour >= 8 && hour <= 10 && weekend) bonus += 10; // Chill weekend morning
    else if (hour >= 10 && hour <= 12) bonus += 5;
    else if (hour >= 13 && hour <= 15) bonus += 2; // Afternoon work crowd
    else if (hour >= 16 && hour <= 17) bonus += -6;
    else if (hour >= 20) bonus += -15;
    else if (hour <= 6) bonus += -15;
    return bonus;
  }

  // ─── GENERIC RESTAURANTS (catch-all) ───
  if (hasType(types, 'restaurant')) {
    if (hour >= 18 && hour <= 20 && weekend) bonus += 16;
    else if (hour >= 18 && hour <= 20) bonus += 12;
    else if (hour >= 21 && hour <= 22 && weekend) bonus += 8;
    else if (hour >= 11 && hour <= 13 && weekend) bonus += 6;
    else if (hour >= 11 && hour <= 13) bonus += 4;
    else if (hour >= 14 && hour <= 17) bonus += -10;
    else if (hour >= 0 && hour <= 10) bonus += -10;

    // Expensive restaurants on weekend nights = packed
    if (priceLevel >= 3 && hour >= 18 && hour <= 21 && weekend) bonus += 10;
    // Expensive weekday lunch = business crowd
    else if (priceLevel >= 3 && hour >= 11 && hour <= 13 && !weekend) bonus += 6;
    // Cheap restaurants = steady all day, packed at peaks
    if (priceLevel <= 1 && hour >= 11 && hour <= 20) bonus += 4;
    return bonus;
  }

  // ─── MOVIE THEATERS ───
  if (hasType(types, 'movie_theater')) {
    if (weekend && hour >= 18 && hour <= 22) bonus += 14;
    if (weekend && hour >= 13 && hour <= 17) bonus += 8;
    if (hour >= 18 && hour <= 21) bonus += 6;
    if (hour >= 6 && hour <= 11) bonus += -12;
    return bonus;
  }

  // ─── SHOPPING MALLS ───
  if (hasType(types, 'shopping_mall')) {
    if (weekend && hour >= 12 && hour <= 17) bonus += 16;
    if (weekend && hour >= 10 && hour <= 11) bonus += 10;
    if (weekend && hour >= 18 && hour <= 20) bonus += 8;
    if (hour >= 12 && hour <= 14) bonus += 8;
    if (hour >= 15 && hour <= 17) bonus += 5;
    if (hour >= 21 || hour <= 9) bonus += -12;
    return bonus;
  }

  // ─── GYMS ───
  if (hasType(types, 'gym', 'fitness_center')) {
    if (hour >= 6 && hour <= 8 && !weekend) bonus += 12;
    if (hour >= 17 && hour <= 19 && !weekend) bonus += 15;
    if (hour >= 9 && hour <= 11 && weekend) bonus += 10;
    if (hour >= 12 && hour <= 14) bonus += 3;
    if (hour >= 22 || hour <= 5) bonus += -15;
    return bonus;
  }

  // ─── LIBRARIES & MUSEUMS ───
  if (hasType(types, 'library', 'museum')) {
    if (weekend && hour >= 11 && hour <= 15) bonus += 10;
    if (hour >= 11 && hour <= 14) bonus += 6;
    if (hour >= 18 || hour <= 8) bonus += -12;
    return bonus;
  }

  // ─── PARKS ───
  if (hasType(types, 'park')) {
    if (weekend && hour >= 10 && hour <= 16) bonus += 12;
    if (hour >= 10 && hour <= 16) bonus += 5;
    if (hour >= 20 || hour <= 6) bonus += -10;
    return bonus;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Price × popularity interaction
// Expensive + popular = destination dining = packed at peak
// Cheap + popular = everyone goes there = always busy
// Expensive + low reviews = exclusive/quiet
// ---------------------------------------------------------------------------

function getPricePopularityBonus(priceLevel, reviews, dayOfWeek, hour, types) {
  if (priceLevel == null || !reviews) return 0;

  const weekend = isWeekend(dayOfWeek);
  const dinnerTime = hour >= 18 && hour <= 21;
  const lunchTime = hour >= 11 && hour <= 13;
  let bonus = 0;

  // ─── HIGH-END (price 3-4) ───
  if (priceLevel >= 3) {
    if (reviews >= 2000 && dinnerTime && weekend) bonus += 12; // Destination + prime time
    else if (reviews >= 1000 && dinnerTime && weekend) bonus += 10;
    else if (reviews >= 500 && dinnerTime && weekend) bonus += 7;
    else if (reviews >= 2000 && dinnerTime) bonus += 8; // Weekday but popular
    else if (reviews >= 1000 && dinnerTime) bonus += 6;
    else if (reviews >= 500 && lunchTime && !weekend) bonus += 5; // Business lunch

    // Low reviews + expensive = exclusive, quieter
    if (reviews < 100 && dinnerTime) bonus += -5;
    if (reviews < 50) bonus += -8;
  }

  // ─── BUDGET (price 0-1) ───
  if (priceLevel <= 1) {
    // Cheap + very popular = always a line
    if (reviews >= 2000 && (dinnerTime || lunchTime)) bonus += 10;
    else if (reviews >= 1000 && (dinnerTime || lunchTime)) bonus += 8;
    else if (reviews >= 500 && lunchTime) bonus += 6; // Lunch rush at cheap spots
    else if (reviews >= 500 && dinnerTime) bonus += 5;

    // Cheap + late night + popular = college crowd
    if (reviews >= 500 && hour >= 22 && weekend) bonus += 6;
  }

  // ─── MID-RANGE (price 2) ───
  if (priceLevel === 2) {
    if (reviews >= 2000 && dinnerTime && weekend) bonus += 8;
    else if (reviews >= 1000 && dinnerTime) bonus += 5;
    else if (reviews >= 500 && lunchTime) bonus += 4;
  }

  return bonus;
}

// ---------------------------------------------------------------------------
// Weather factor
// ---------------------------------------------------------------------------

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
    // Perfect weather boosts outdoor venues
    if (hasType(types, 'park', 'beer_garden')) modifier += 5;
  }

  if (weather.windSpeed > 25) {
    if (!indoor) modifier += -8;
  }

  // Hot weather boosts ice cream / dessert
  if (weather.temp > 85 && isDessertLike(types)) modifier += 8;

  return Math.max(-15, Math.min(15, modifier));
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
  const priceLevel = venue.price_level;

  // Get popularity tier — this determines both the base and the multiplier
  const pop = getPopularityTier(reviews);

  // Individual factors
  const time = getTimeFactor(dayOfWeek, hour);
  const rating = getRatingFactor(venue.rating);
  const venueContext = getVenueContextBonus(types, dayOfWeek, hour, priceLevel, reviews);
  const pricePopBonus = getPricePopularityBonus(priceLevel, reviews, dayOfWeek, hour, types);
  const weatherMod = getWeatherFactor(weather, types);

  // Per-venue variance: ±5 points from place_id hash so no two venues are identical
  const hash = venueHash(venue.place_id);
  const venueVariance = (hash % 11) - 5; // range: -5 to +5

  // Combine: base is lower, but factors are more differentiated
  // Popularity multiplier amplifies the time-sensitive factors for popular venues
  const timeSensitiveFactors = venueContext + pricePopBonus;
  const amplifiedFactors = Math.round(timeSensitiveFactors * pop.multiplier);

  const rawScore = 8 + time + pop.base + rating + amplifiedFactors + weatherMod + venueVariance;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  // Confidence based on data quality
  let confidence = 20; // time/day always available

  // Review count is the strongest confidence signal
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

  // Price level is a useful signal
  if (priceLevel != null) confidence += 3;

  // Weather data adds real-time accuracy
  if (weather) confidence += 15;

  confidence = Math.min(95, confidence);

  const dataSourcesUsed = ['google_places', 'time_patterns'];
  if (weather) dataSourcesUsed.push('weather');

  return {
    score,
    label: getLabel(score),
    confidence,
    factors: { time, popularity: pop.base, rating, venueContext: amplifiedFactors, weather: weatherMod, variance: venueVariance },
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
    max = reviews >= 2000 ? 400 : reviews >= 1000 ? 300 : reviews >= 500 ? 200 : 100;
  } else if (isSportsBar(types)) {
    max = reviews >= 2000 ? 250 : reviews >= 1000 ? 180 : reviews >= 500 ? 120 : 60;
  } else if (isBreweryLike(types)) {
    max = reviews >= 2000 ? 200 : reviews >= 1000 ? 150 : reviews >= 500 ? 100 : 50;
  } else if (isBarLike(types)) {
    max = reviews >= 1000 ? 200 : reviews >= 500 ? 120 : 60;
  } else if (isSteakhouseLike(types)) {
    max = reviews >= 2000 ? 180 : reviews >= 1000 ? 120 : reviews >= 500 ? 80 : 50;
  } else if (isDinerLike(types)) {
    max = reviews >= 1000 ? 120 : reviews >= 500 ? 80 : reviews >= 100 ? 50 : 30;
  } else if (isFastFoodLike(types)) {
    max = reviews >= 2000 ? 150 : reviews >= 500 ? 100 : reviews >= 100 ? 60 : 35;
  } else if (hasType(types, 'restaurant')) {
    max = reviews >= 5000 ? 250 : reviews >= 2000 ? 200 : reviews >= 500 ? 120 : reviews >= 100 ? 60 : 40;
  } else if (isCafeLike(types)) {
    max = reviews >= 500 ? 80 : reviews >= 100 ? 40 : 25;
  } else if (isDessertLike(types)) {
    max = reviews >= 1000 ? 60 : reviews >= 500 ? 40 : 20;
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

function estimateWait(score, types, priceLevel) {
  // Steakhouses — reservation culture, long waits without one
  if (isSteakhouseLike(types)) {
    if (score < 40) return 'Walk-in OK';
    if (score <= 60) return '10-20 min';
    if (score <= 80) return '30-45 min';
    return '45+ min — reserve ahead';
  }

  // Fine dining — almost always need reservations at peak
  if (isFineDining(types)) {
    if (score < 40) return 'Walk-in likely';
    if (score <= 60) return '15-25 min';
    if (score <= 80) return '30-60 min';
    return 'Reservation needed';
  }

  if (isBarLike(types)) {
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

  // Dessert / ice cream — line based
  if (isDessertLike(types)) {
    if (score < 40) return 'No line';
    if (score <= 60) return '~3 min';
    if (score <= 80) return '5-10 min';
    return '10-20 min';
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

  // Generic restaurants: table waits
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
  if (hasType(types, 'bar', 'night_club') || isBarLike(types)) return (h >= 16 || h <= 2);
  if (isDinerLike(types)) return (h >= 6 && h <= 21);
  if (isFastFoodLike(types)) return (h >= 6 && h <= 23);
  if (hasType(types, 'restaurant') || isSteakhouseLike(types) || isSushiLike(types) || isSeafoodLike(types)) return (h >= 11 && h <= 22);
  if (isCafeLike(types)) return (h >= 6 && h <= 21);
  if (isDessertLike(types)) return (h >= 10 && h <= 22);
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
