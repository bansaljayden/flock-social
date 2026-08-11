// In-memory Birdie (AI chat) usage tracking. Shared between routes/ai.js
// (metering) and services/entitlements.js (reporting) so both see the same
// counters. Deliberately simple + in-memory, same as the original ai.js
// implementation — counts reset on deploy/restart and at UTC midnight.

const userRateLimits = new Map();

const PREMIUM_DAILY_LIMIT = 150; // was USER_DAILY_LIMIT — applies when paywall off or user is premium
const FREE_DAILY_LIMIT = 10;     // applies when paywall on and user is not premium
const USER_PER_MIN_LIMIT = 15;   // everyone, always

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function checkUserRateLimit(userId, dailyLimit = PREMIUM_DAILY_LIMIT) {
  const now = Date.now();
  const key = todayKey();

  if (!userRateLimits.has(userId)) {
    userRateLimits.set(userId, { day: key, dailyCount: 0, recentTimestamps: [] });
  }

  const limit = userRateLimits.get(userId);

  // Reset daily count if new day
  if (limit.day !== key) {
    limit.day = key;
    limit.dailyCount = 0;
  }

  // Check daily limit
  if (limit.dailyCount >= dailyLimit) {
    return { allowed: false, reason: 'daily', error: `you've been chatting up a storm 🐦 catch up tomorrow!` };
  }

  // Check per-minute limit
  const oneMinAgo = now - 60000;
  limit.recentTimestamps = limit.recentTimestamps.filter(ts => ts > oneMinAgo);
  if (limit.recentTimestamps.length >= USER_PER_MIN_LIMIT) {
    return { allowed: false, reason: 'minute', error: 'easy there — gimme a sec to catch up' };
  }

  // Allow and record
  limit.dailyCount++;
  limit.recentTimestamps.push(now);
  return { allowed: true, remaining: dailyLimit - limit.dailyCount };
}

// How many Birdie messages this user has used today (0 if none or stale day).
function getUsedToday(userId) {
  const limit = userRateLimits.get(userId);
  if (!limit || limit.day !== todayKey()) return 0;
  return limit.dailyCount;
}

// ISO timestamp of the next UTC midnight — when daily counts reset.
function nextUtcMidnightISO() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
}

// Clean up stale entries every hour (unref so this never keeps the process alive)
setInterval(() => {
  const key = todayKey();
  for (const [userId, limit] of userRateLimits) {
    if (limit.day !== key) userRateLimits.delete(userId);
  }
}, 3600000).unref();

module.exports = {
  checkUserRateLimit,
  getUsedToday,
  nextUtcMidnightISO,
  PREMIUM_DAILY_LIMIT,
  FREE_DAILY_LIMIT,
  USER_PER_MIN_LIMIT,
};
