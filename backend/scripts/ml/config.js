// ---------------------------------------------------------------------------
// ML Data Collection Pipeline — Configuration
// ---------------------------------------------------------------------------

const CITIES = {
  nyc:     { name: 'New York City', lat: 40.7128, lon: -74.0060, tz: 'America/New_York' },
  la:      { name: 'Los Angeles',   lat: 34.0522, lon: -118.2437, tz: 'America/Los_Angeles' },
  chicago: { name: 'Chicago',       lat: 41.8781, lon: -87.6298, tz: 'America/Chicago' },
  london:  { name: 'London',        lat: 51.5074, lon: -0.1278, tz: 'Europe/London' },
  tokyo:   { name: 'Tokyo',         lat: 35.6762, lon: 139.6503, tz: 'Asia/Tokyo' },
  miami:   { name: 'Miami',         lat: 25.7617, lon: -80.1918, tz: 'America/New_York' },
  lehigh:  { name: 'Lehigh Valley', lat: 40.6023, lon: -75.4714, tz: 'America/New_York' },
};

// Max venues per city — more queries = more diversity
// Google Places returns max 20 per search, so we use many specific queries
// Duplicates are handled by the UNIQUE constraint on google_place_id
const VENUE_TARGETS = [
  // Restaurants — diverse cuisines
  { query: 'popular restaurants',        count: 20, category: 'restaurant' },
  { query: 'Italian restaurants',        count: 20, category: 'restaurant' },
  { query: 'Chinese restaurants',        count: 20, category: 'restaurant' },
  { query: 'Japanese restaurants',       count: 20, category: 'restaurant' },
  { query: 'Mexican restaurants',        count: 20, category: 'restaurant' },
  { query: 'Indian restaurants',         count: 20, category: 'restaurant' },
  { query: 'Thai restaurants',           count: 20, category: 'restaurant' },
  { query: 'Korean restaurants',         count: 20, category: 'restaurant' },
  { query: 'steakhouses',               count: 20, category: 'restaurant' },
  { query: 'seafood restaurants',        count: 20, category: 'restaurant' },
  { query: 'sushi restaurants',          count: 20, category: 'restaurant' },
  { query: 'pizza restaurants',          count: 20, category: 'restaurant' },
  { query: 'fine dining restaurants',    count: 20, category: 'restaurant' },
  { query: 'brunch restaurants',         count: 20, category: 'restaurant' },
  { query: 'diners',                     count: 20, category: 'restaurant' },
  { query: 'ramen restaurants',          count: 20, category: 'restaurant' },
  { query: 'BBQ restaurants',            count: 20, category: 'restaurant' },
  { query: 'Mediterranean restaurants',  count: 20, category: 'restaurant' },
  { query: 'Vietnamese restaurants',     count: 20, category: 'restaurant' },

  // Fast food — heavy coverage
  { query: 'fast food restaurants',      count: 20, category: 'fast_food' },
  { query: 'McDonalds',                 count: 20, category: 'fast_food' },
  { query: 'burger restaurants',         count: 20, category: 'fast_food' },
  { query: 'Chick-fil-A',               count: 20, category: 'fast_food' },
  { query: 'Taco Bell',                 count: 20, category: 'fast_food' },
  { query: 'Wendys',                    count: 20, category: 'fast_food' },
  { query: 'Subway sandwich',           count: 20, category: 'fast_food' },
  { query: 'Chipotle',                  count: 20, category: 'fast_food' },
  { query: 'pizza delivery',            count: 20, category: 'fast_food' },
  { query: 'chicken wings restaurant',  count: 20, category: 'fast_food' },

  // Bars & nightlife
  { query: 'popular bars',              count: 20, category: 'bar' },
  { query: 'cocktail bars',             count: 20, category: 'bar' },
  { query: 'sports bars',               count: 20, category: 'bar' },
  { query: 'wine bars',                 count: 20, category: 'bar' },
  { query: 'pubs',                      count: 20, category: 'bar' },
  { query: 'rooftop bars',              count: 20, category: 'bar' },
  { query: 'nightclubs',                count: 20, category: 'nightclub' },

  // Cafes & coffee
  { query: 'popular cafes',             count: 20, category: 'cafe' },
  { query: 'Starbucks',                 count: 20, category: 'cafe' },
  { query: 'coffee shops',              count: 20, category: 'cafe' },
  { query: 'tea houses',                count: 20, category: 'cafe' },

  // Breweries
  { query: 'breweries',                 count: 20, category: 'brewery' },
  { query: 'beer gardens',              count: 20, category: 'brewery' },

  // Desserts & sweets
  { query: 'ice cream shops',           count: 20, category: 'dessert' },
  { query: 'bakeries',                  count: 20, category: 'dessert' },
  { query: 'dessert shops',             count: 20, category: 'dessert' },
  { query: 'bubble tea',                count: 20, category: 'dessert' },

  // Gyms & fitness
  { query: 'gyms',                      count: 20, category: 'gym' },
  { query: 'fitness centers',           count: 20, category: 'gym' },

  // Shopping
  { query: 'shopping malls',            count: 20, category: 'mall' },
  { query: 'shopping centers',          count: 20, category: 'mall' },

  // Entertainment & culture
  { query: 'museums',                   count: 20, category: 'museum' },
  { query: 'movie theaters',            count: 20, category: 'movie_theater' },
  { query: 'bowling alleys',            count: 20, category: 'entertainment' },
  { query: 'arcades',                   count: 20, category: 'entertainment' },
  { query: 'amusement parks',           count: 20, category: 'entertainment' },

  // Parks & outdoor
  { query: 'popular parks',             count: 20, category: 'park' },
];

// US holidays 2025-2026
const HOLIDAYS = new Set([
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-05-26',
  '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11',
  '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25',
  '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11',
  '2026-11-26', '2026-12-25',
]);

// US school breaks (approximate)
const SCHOOL_BREAKS = [
  { start: '2025-06-15', end: '2025-09-01' },
  { start: '2025-12-20', end: '2026-01-05' },
  { start: '2026-03-14', end: '2026-03-22' },
  { start: '2026-06-15', end: '2026-09-01' },
];

function getSeason(month) {
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'fall';
  return 'winter';
}

function isHoliday(dateStr) {
  return HOLIDAYS.has(dateStr);
}

function isSchoolBreak(dateStr) {
  return SCHOOL_BREAKS.some(b => dateStr >= b.start && dateStr <= b.end);
}

// BestTime uses Mon=0..Sun=6, JavaScript uses Sun=0..Sat=6
function jsDayToBestTimeDay(jsDay) {
  return jsDay === 0 ? 6 : jsDay - 1;
}

function bestTimeDayToJsDay(btDay) {
  return btDay === 6 ? 0 : btDay + 1;
}

// Get local time components for a venue's timezone
function getLocalTime(timezone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short',
  }).formatToParts(now);

  const get = (type) => parts.find(p => p.type === type)?.value;

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = weekdayMap[get('weekday')] ?? now.getDay();
  const hour = parseInt(get('hour'), 10);
  const month = parseInt(get('month'), 10);
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;

  return { dayOfWeek, hour, month, dateStr, season: getSeason(month) };
}

// Google Places price level enum → number
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  CITIES,
  VENUE_TARGETS,
  getSeason,
  isHoliday,
  isSchoolBreak,
  jsDayToBestTimeDay,
  bestTimeDayToJsDay,
  getLocalTime,
  priceLevelToNum,
  sleep,
};
