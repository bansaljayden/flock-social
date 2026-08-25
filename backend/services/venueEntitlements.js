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
// venue_profiles.tier is now a CACHE of the grant, not the authority. Both are
// written by that one route in one statement, and where they disagree the gate
// takes the lower of the two. Nothing in here trusts the column on its own.
//
// A TIER CAN NOW EXPIRE, AND THE EXPIRY IS READ HERE (migration 040). This
// file used to say "nothing expires a tier", which was true and was a revenue
// hole: the founding-venue offer in VENUE-PRICING.md comps Roost for six months
// in exchange for a maintained slider habit, and comping fifteen venues against
// a grant that never ends is fifteen permanent free accounts by accident.
// venue_subscriptions.expires_at carries the end date (NULL means there is no
// end date, said out loud rather than assumed) and resolveGrantedTier below
// applies it on every read. There is still no periodic job and there should not
// be one: a sweep is a promise to revoke soon, and "soon" is exactly the window
// in which an expired comp is still being served.
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

// The statuses that KEEP a tier. Stripe's vocabulary, adopted whole (migration
// 040) so the webhook has nothing to translate. past_due is deliberately in the
// keep set: VENUE-BILLING.md's status map says "keep + warn", because a card
// that failed on Tuesday is a card, not a cancellation. Everything else —
// canceled, unpaid, incomplete, incomplete_expired, paused, and anything this
// list has never heard of — revokes. A Set, and membership is tested with a
// string, so no prototype member can answer for a status.
const GRANT_LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

// THE EXPIRY RULE, AND IT IS EVALUATED HERE RATHER THAN BY A JOB.
//
// A grant that ran out at 03:00 must not be serving Roost at 04:00. There is no
// cron in this product and there should not be one for this: a sweep is a
// promise to revoke soon, and "soon" is the window in which a venue is being
// served something it is no longer entitled to. Read time has no window.
//
// Inputs are one row of the join below: venue_profiles.tier (the CACHE, which
// the admin route writes alongside the grant) plus the grant's own tier, status
// and end date. Three rules, in order:
//
//   1. NO GRANT ROW -> the cached column is the answer. That is the pre-040
//      world (a hand-granted tier with no end date agreed) and the local e2e
//      harness, which drives venue_profiles.tier directly. Not a bypass: a row
//      with no grant has no expiry to have missed.
//   2. A GRANT ROW THAT IS DEAD — lapsed, or in a status that revokes — is the
//      free tier, whatever the cached column still says. This is the whole
//      point: the column is never trusted over the grant.
//   3. A GRANT ROW THAT IS LIVE gives the LOWER of the two tiers. One statement
//      writes both, so they agree; if they ever disagree, the disagreement is a
//      bug and the fail-closed reading of a bug is the smaller entitlement.
//
// `now` is the app clock rather than NOW() in the query, so this is a pure
// function a test can walk across a boundary. Both clocks are NTP-synced and a
// tier expiry is a date, not a microsecond fence.
function resolveGrantedTier(row, now) {
  // Unknown / null / garbage tier is free, never a bypass.
  const cached = rankOf(row?.tier) === null ? 'free' : row.tier;
  if (!row || row.grant_tier === null || row.grant_tier === undefined) return cached;
  if (!GRANT_LIVE_STATUSES.has(row.grant_status)) return 'free';
  if (row.expires_at !== null && row.expires_at !== undefined) {
    const endsAt = new Date(row.expires_at).getTime();
    // NaN from an unparseable date fails this test and revokes, which is the
    // direction a date nobody can read should fail in.
    if (!(endsAt > (typeof now === 'number' ? now : Date.now()))) return 'free';
  }
  const granted = rankOf(row.grant_tier) === null ? 'free' : row.grant_tier;
  return rankOf(granted) <= rankOf(cached) ? granted : cached;
}

// ONE LINE, ON PURPOSE. Several suites drive this module against a scripted pg
// fake that matches on the raw SQL text, and a multi-line template literal
// arrives at those matchers with newlines in it.
const TIER_SQL = 'SELECT vp.tier, vs.tier AS grant_tier, vs.status AS grant_status, vs.source AS grant_source, vs.granted_reason, vs.granted_at, vs.expires_at FROM venue_profiles vp LEFT JOIN venue_subscriptions vs ON vs.user_id = vp.user_id WHERE vp.user_id = $1';

// The full entitlement, for the surfaces that have to SAY what a venue holds
// and until when (GET /api/venue-profile). Same resolution as the gate, so the
// dashboard cannot show one answer while the gate enforces another.
async function getVenueEntitlement(userId) {
  const r = await pool.query(TIER_SQL, [userId]);
  // venue_profiles.user_id is UNIQUE (migration 001) and venue_subscriptions is
  // keyed on user_id, so this join returns exactly one row or none — no ORDER BY
  // is needed to make it deterministic. A driver that answered with no `rows` at
  // all throws here rather than reading as a missing profile, which is the
  // fail-closed direction: requireVenueTier turns a throw into a refusal.
  const rows = r.rows;
  if (!Array.isArray(rows)) throw new Error('venue tier lookup returned no rows array');
  const row = rows[0];
  const tier = resolveGrantedTier(row, Date.now());
  return {
    tier,
    // Null unless a grant row exists, so a caller can tell "granted, with no end
    // date" from "no grant on file" instead of guessing from a null.
    hasGrant: !!(row && row.grant_tier !== null && row.grant_tier !== undefined),
    grantedTier: row?.grant_tier ?? null,
    source: row?.grant_source ?? null,
    reason: row?.granted_reason ?? null,
    grantedAt: row?.granted_at ?? null,
    expiresAt: row?.expires_at ?? null,
    status: row?.grant_status ?? null,
    // True only when there IS an end date and it has passed. A permanent grant
    // is not expired and neither is a venue with no grant at all.
    expired: tier === 'free' && !!row?.expires_at && rankOf(row?.grant_tier) > 0,
  };
}

async function getVenueTier(userId) {
  return (await getVenueEntitlement(userId)).tier;
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

// GRANT_LIVE_STATUSES is exported so the ONE public surface that has to make
// this decision in SQL (GET /api/venue-dashboard/public-promotions/:placeId,
// which serves a paid benefit to end users and cannot call the resolver per
// row) binds the same vocabulary rather than retyping it. Frozen array, because
// it is bound straight into a query as a text[] parameter.
const GRANT_LIVE_STATUS_LIST = Object.freeze([...GRANT_LIVE_STATUSES]);

module.exports = { requireVenueTier, getVenueTier, getVenueEntitlement, resolveGrantedTier, venueBillingEnabled, GRANT_LIVE_STATUS_LIST };
