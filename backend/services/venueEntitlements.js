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
//
// NOTHING EXPIRES A TIER. There is no billing integration on this side (no
// Stripe code exists), so a tier granted by an admin is held until an admin
// takes it away. That is correct while comping is the only way to get one and
// is a revenue hole the day it is sold; see the report in
// __tests__/entitlementGates.test.js.
//
// NO CACHE, DELIBERATELY. Every gated request re-reads the column, so a
// downgrade bites on the next request and an upgrade lands on the next request.
// One indexed single-row read on a dashboard route is not the thing to optimise,
// and a cache here is measured in "how long does a downgraded venue keep the
// paid feature".
// ---------------------------------------------------------------------------
const pool = require('../config/database');
const { boolFlag, warnOnce } = require('./entitlements');

// Null-prototype so a tier string that happens to name an Object.prototype
// member ('constructor', 'toString', '__proto__') cannot resolve to a
// truthy-but-meaningless rank. Reads go through rankOf, never a bare index.
const TIER_ORDER = Object.assign(Object.create(null), { free: 0, premium: 1, pro: 2 });

function rankOf(tier) {
  return typeof tier === 'string' && Object.prototype.hasOwnProperty.call(TIER_ORDER, tier)
    ? TIER_ORDER[tier]
    : null;
}

// THE SAME WALL-WITH-NO-DOOR CHECK the consumer paywall does, and here it is
// sharper, because this side has no billing integration at all: the only writer
// of venue_profiles.tier is POST /api/admin/venues/:userId/tier behind
// requireAdmin, and role='admin' is granted ONLY from ADMIN_USER_IDS at boot
// (server.js). With that unset there are no admin accounts, so switching this
// flag on pins every venue in the product to the free tier with no in-app way to
// grant one, and the only remedy is hand-written SQL against production.
function venueBillingEnabled() {
  const on = boolFlag('VENUE_BILLING_ENABLED');
  if (on && !process.env.ADMIN_USER_IDS) {
    warnOnce(
      'preflight:venue-billing-no-grant-path',
      '[venueEntitlements] VENUE_BILLING_ENABLED=true but ADMIN_USER_IDS is unset, so no account holds role=admin and POST /api/admin/venues/:userId/tier is unreachable. That route is the ONLY writer of venue_profiles.tier, so every venue is now pinned to the free tier with no way to grant one. Set ADMIN_USER_IDS before enforcing tiers.'
    );
  }
  return on;
}

async function getVenueTier(userId) {
  const r = await pool.query('SELECT tier FROM venue_profiles WHERE user_id = $1', [userId]);
  // venue_profiles.user_id is UNIQUE (migration 001), so there is exactly one
  // row or none — no ORDER BY is needed to make this deterministic. A driver
  // that answered with no `rows` at all would throw here rather than read as a
  // missing profile, which is the fail-closed direction: requireVenueTier turns
  // a throw into a refusal.
  const rows = r.rows;
  if (!Array.isArray(rows)) throw new Error('venue tier lookup returned no rows array');
  // Unknown / null / garbage tier is free, never a bypass.
  return rankOf(rows[0]?.tier) === null ? 'free' : rows[0].tier;
}

// Express middleware: 403 {code: 'UPGRADE_REQUIRED'} below the minimum tier
// (same contract Birdie uses; the frontend api client forwards err.code).
//
// TWO DIFFERENT REFUSALS, AND THEY MUST BE TELLABLE APART. A tier that is
// genuinely too low is permanent until the plan changes: the client is right to
// show an upgrade CTA and right never to retry. A tier lookup that FAILED is
// neither — it is temporary, it is our fault, and treating it as "your plan does
// not include this" pitches an upgrade at a venue that is already paying for
// one, and pitches it forever because nothing retries.
//
// Both stay 403 with code UPGRADE_REQUIRED, deliberately. That pair is the
// existing client contract (frontend/src/App.js branches on it to show the
// locked state rather than an empty list, and __tests__/money.test.js and
// __tests__/venueOwner.test.js both pin it as the fail-closed answer), and
// changing the code on the error path would silently move every current client
// onto its generic-failure branch. What is added is the part that was missing:
// `retryable: true` and `reason: 'ENTITLEMENT_UNAVAILABLE'`, so a client that
// wants to say "could not check your plan, try again" can, and so the two cases
// are distinguishable in a log and in a test. A genuine tier refusal carries
// `requiredTier` and no `reason`; this one carries `reason` and no tier, because
// it never got far enough to compare one.
//
// The consumer side answers this same condition differently on purpose:
// GET /api/entitlements is a STATE READ rather than a gate on a feature, so it
// has no lock contract to preserve and answers a plain 503.
function requireVenueTier(minTier) {
  const minRank = rankOf(minTier);
  // A typo in a call site would otherwise produce a gate that denies everyone
  // once billing is on and nobody notices until a paying venue complains.
  if (minRank === null) throw new Error(`requireVenueTier: unknown tier "${minTier}"`);

  return async (req, res, next) => {
    // NOT INSIDE THE TRY, and neither is the allow path below. `return next()`
    // used to sit inside it, which put every downstream failure inside the scope
    // of a catch whose only sensible answer is "upgrade your plan". Measured
    // rather than assumed: express 4 wraps each layer in its own try and turns a
    // downstream synchronous throw into next(err), so this was latent and not a
    // live leak — a route handler that throws still reaches the error handler as
    // a 500, before and after this change. It is moved anyway because the catch
    // must own exactly one statement (the tier lookup) for its answer to be
    // truthful, and because the version where it owned more was one express
    // internals change away from rewriting a server bug as a sales pitch.
    //
    // NOTE FOR WHOEVER READS THE FRONTEND COMMENT. frontend/src/App.js
    // (loadIncomingFlocks) says this gate "answers 403 UPGRADE_REQUIRED even
    // with billing off" if the tier lookup throws. It cannot: with billing off
    // the line below returns before any lookup exists to throw. The client's
    // handling is still right for the billing-ON case, but that sentence
    // describes a path that does not exist.
    if (!venueBillingEnabled()) return next();
    // Mounted after authenticate everywhere today; if that ever stops being
    // true the gate must not read `undefined.id` and 500 into an open door.
    if (!req.user?.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let rank;
    try {
      rank = rankOf(await getVenueTier(req.user.id));
    } catch (err) {
      console.error('Venue tier check error:', err);
      // Fail closed on a paid boundary, and say which kind of no this is.
      if (res.headersSent) return next(err);
      return res.status(403).json({
        error: 'Could not check your venue plan just now. Try again.',
        code: 'UPGRADE_REQUIRED',
        reason: 'ENTITLEMENT_UNAVAILABLE',
        retryable: true,
      });
    }

    // Explicit null check: `null >= 0` is true in JS, so an unrecognised tier
    // would have walked through any gate whose minimum is 'free'.
    if (rank !== null && rank >= minRank) return next();
    return res.status(403).json({
      error: 'This feature needs a venue plan upgrade.',
      code: 'UPGRADE_REQUIRED',
      requiredTier: minTier,
    });
  };
}

module.exports = { requireVenueTier, getVenueTier, venueBillingEnabled };
