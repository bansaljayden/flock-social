// Shared upstream budget for PAID Google Places calls (text search, details,
// nearby). One global pool: 30 fresh calls/hour per user, 3000/day across the
// whole process. Round 8: venueSearch had this budget but crowd.js's own
// Places fetches bypassed it entirely — a shared counter closes that.
// In-memory is fine on the single-instance deployment.

const userHits = new Map();
let dayKey = new Date().toISOString().slice(0, 10);
let dayCount = 0;

const PER_USER_HOURLY = 30;
const GLOBAL_DAILY = 3000;

function allowPlacesSearch(userId) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; dayCount = 0; }
  if (dayCount >= GLOBAL_DAILY) return false;
  const now = Date.now();
  const hits = (userHits.get(userId) || []).filter((t) => now - t < 3600_000);
  if (hits.length >= PER_USER_HOURLY) return false;
  hits.push(now);
  userHits.set(userId, hits);
  if (userHits.size > 5000) userHits.clear();
  dayCount++;
  return true;
}

module.exports = { allowPlacesSearch };
