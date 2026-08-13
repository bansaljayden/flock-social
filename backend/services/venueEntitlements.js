// ---------------------------------------------------------------------------
// Venue tier entitlements (VENUE-BILLING.md Phase 0).
//
// Server-side enforcement for paid venue features — the dashboard UI gate is
// cosmetic and always was. Mirrors the consumer paywall pattern
// (services/entitlements.js): a kill switch keeps behavior unchanged until
// billing actually ships.
//
//   VENUE_BILLING_ENABLED unset/false  -> every venue owner acts Pro
//   VENUE_BILLING_ENABLED=true         -> venue_profiles.tier is enforced
//
// venue_profiles.tier is server-written only (client writes were removed in
// the 2026-08-12 audit); admins comp tiers via POST /api/admin/venues/:userId/tier.
// ---------------------------------------------------------------------------
const pool = require('../config/database');

const TIER_ORDER = { free: 0, premium: 1, pro: 2 };

function venueBillingEnabled() {
  return process.env.VENUE_BILLING_ENABLED === 'true';
}

async function getVenueTier(userId) {
  const { rows } = await pool.query('SELECT tier FROM venue_profiles WHERE user_id = $1', [userId]);
  const tier = rows[0]?.tier;
  return TIER_ORDER[tier] !== undefined ? tier : 'free';
}

// Express middleware: 403 {code: 'UPGRADE_REQUIRED'} below the minimum tier
// (same contract Birdie uses; the frontend api client forwards err.code).
function requireVenueTier(minTier) {
  return async (req, res, next) => {
    try {
      if (!venueBillingEnabled()) return next();
      const tier = await getVenueTier(req.user.id);
      if (TIER_ORDER[tier] >= TIER_ORDER[minTier]) return next();
      return res.status(403).json({
        error: 'This feature needs a venue plan upgrade.',
        code: 'UPGRADE_REQUIRED',
        requiredTier: minTier,
      });
    } catch (err) {
      console.error('Venue tier check error:', err);
      // Fail closed on a paid boundary.
      return res.status(403).json({ error: 'Could not verify your venue plan.', code: 'UPGRADE_REQUIRED' });
    }
  };
}

module.exports = { requireVenueTier, getVenueTier, venueBillingEnabled };
