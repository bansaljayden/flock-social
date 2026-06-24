const pool = require('../config/database');

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

module.exports = { isPremium };
