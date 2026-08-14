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
// venue_profiles.tier is server-written only. The ONLY writer in the codebase
// is POST /api/admin/venues/:userId/tier (routes/admin.js, behind requireAdmin,
// whitelisted to free|premium|pro). routes/venueProfile.js accepts no `tier`
// field on either the POST or the PUT, and neither statement names the column.
// Re-verify both of those before adding a route that touches venue_profiles.
// ---------------------------------------------------------------------------
const pool = require('../config/database');

// Null-prototype so a tier string that happens to name an Object.prototype
// member ('constructor', 'toString', '__proto__') cannot resolve to a
// truthy-but-meaningless rank. Reads go through rankOf, never a bare index.
const TIER_ORDER = Object.assign(Object.create(null), { free: 0, premium: 1, pro: 2 });

function rankOf(tier) {
  return typeof tier === 'string' && Object.prototype.hasOwnProperty.call(TIER_ORDER, tier)
    ? TIER_ORDER[tier]
    : null;
}

function venueBillingEnabled() {
  return process.env.VENUE_BILLING_ENABLED === 'true';
}

async function getVenueTier(userId) {
  const { rows } = await pool.query('SELECT tier FROM venue_profiles WHERE user_id = $1', [userId]);
  // Unknown / null / garbage tier is free, never a bypass.
  return rankOf(rows[0]?.tier) === null ? 'free' : rows[0].tier;
}

// Express middleware: 403 {code: 'UPGRADE_REQUIRED'} below the minimum tier
// (same contract Birdie uses; the frontend api client forwards err.code).
function requireVenueTier(minTier) {
  const minRank = rankOf(minTier);
  // A typo in a call site would otherwise produce a gate that denies everyone
  // once billing is on and nobody notices until a paying venue complains.
  if (minRank === null) throw new Error(`requireVenueTier: unknown tier "${minTier}"`);

  return async (req, res, next) => {
    try {
      if (!venueBillingEnabled()) return next();
      // Mounted after authenticate everywhere today; if that ever stops being
      // true the gate must not read `undefined.id` and 500 into an open door.
      if (!req.user?.id) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      const rank = rankOf(await getVenueTier(req.user.id));
      // Explicit null check: `null >= 0` is true in JS, so an unrecognised tier
      // would have walked through any gate whose minimum is 'free'.
      if (rank !== null && rank >= minRank) return next();
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
