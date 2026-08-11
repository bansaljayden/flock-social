const pool = require('../config/database');
const { getUsedToday, PREMIUM_DAILY_LIMIT, FREE_DAILY_LIMIT } = require('./birdieUsage');
const { FREE_MONTHLY_FORECASTS, getUsedThisMonth } = require('./forecastUsage');

// Premium entitlement check (D-lite). v1.0 ships FREE — the paywall is dormant,
// so this returns false for everyone until v1.1 turns purchasing on. Centralized
// here so flipping the paywall on later is a config change, not new plumbing.
// Source of truth: users.is_premium, set by the RevenueCat webhook.
async function isPremium(userId) {
  if (!userId) return false;
  try {
    const r = await pool.query('SELECT is_premium FROM users WHERE id = $1', [userId]);
    return !!r.rows[0]?.is_premium;
  } catch {
    return false;
  }
}

// Paywall master switch. Dormant unless PAYWALL_ENABLED=true is set (Railway env).
function paywallEnabled() {
  return process.env.PAYWALL_ENABLED === 'true';
}

// Entitlements snapshot for the client (GET /api/entitlements).
// Shape is a frontend contract:
// { isPremium, paywallEnabled,
//   birdie:   { limit, used, remaining },     // per day
//   forecast: { limit, used, remaining } }    // per calendar month
async function getEntitlements(userId) {
  const premium = await isPremium(userId);
  const enabled = paywallEnabled();
  const birdieLimit = (enabled && !premium) ? FREE_DAILY_LIMIT : PREMIUM_DAILY_LIMIT;
  const birdieUsed = getUsedToday(userId);
  const forecastUsed = getUsedThisMonth(userId);
  const metered = enabled && !premium;
  return {
    isPremium: premium,
    paywallEnabled: enabled,
    birdie: {
      limit: birdieLimit,
      used: birdieUsed,
      remaining: Math.max(0, birdieLimit - birdieUsed),
    },
    forecast: {
      limit: metered ? FREE_MONTHLY_FORECASTS : null,
      used: forecastUsed,
      remaining: metered ? Math.max(0, FREE_MONTHLY_FORECASTS - forecastUsed) : null,
    },
  };
}

module.exports = { isPremium, paywallEnabled, getEntitlements };
