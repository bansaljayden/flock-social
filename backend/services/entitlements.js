// ---------------------------------------------------------------------------
// CONSUMER ENTITLEMENTS (Flock Pro).
//
// Source of truth: users.is_premium, written only by routes/revenuecat.js.
// There is no subscription table, no expiry column and no cache: every check
// below is a fresh read, so a revocation takes effect on the next request and a
// new subscriber is live the moment the webhook lands.
//
// WHAT THE DORMANT FLAG ACTUALLY DOES. With PAYWALL_ENABLED unset the answer is
// "everything is free", and that is asserted rather than assumed in
// __tests__/entitlementGates.test.js:
//   * Birdie gets PREMIUM_DAILY_LIMIT (150/day), which is the anti-abuse meter
//     that predates the paywall and is enforced for everyone either way. The
//     documented free tier of 10 is dormant.
//   * The forecast meter is not merely uncounted, it is never TOUCHED —
//     routes/crowd.js forecastAccess() returns before recordView().
//   * venue_profiles.tier is never even read (services/venueEntitlements.js).
//
// An older version of this header, and PAYWALL-DECISION.md with it, claimed
// "with the paywall off isPremium is false for everyone". THAT IS NOT WHAT THIS
// CODE DOES. isPremium reports the column whatever the flag says; what the flag
// controls is whether anything is METERED. It is false for everyone today only
// because nothing can currently set the column (the webhook 503s without
// REVENUECAT_WEBHOOK_SECRET), which is a fact about the environment, not about
// this file.
//
// FAIL CLOSED, BUT SAY WHICH KIND OF NO IT IS. A tier lookup that errors must
// never grant access — but "you are not a subscriber" and "we could not find
// out" are different answers, and collapsing them is how a paying customer gets
// shown an upgrade prompt during a database blip. isPremium() keeps the
// fail-closed boolean its callers depend on; getPremiumState() is the honest
// tri-state, and it is what the client-facing snapshot uses so the endpoint can
// answer 503 instead of a confident "you have not paid".
// ---------------------------------------------------------------------------
const pool = require('../config/database');
const { getUsedToday, PREMIUM_DAILY_LIMIT, FREE_DAILY_LIMIT } = require('./birdieUsage');
const { FREE_MONTHLY_FORECASTS, getUsedThisMonth } = require('./forecastUsage');

// Thrown by getEntitlements when the premium state could not be established.
// Carries its own status/code so routes/entitlements.js does not have to guess
// which failures are retryable, and so a real programming error still gets the
// 500 it deserves instead of being laundered into a friendly 503.
class EntitlementUnavailableError extends Error {
  constructor(reason) {
    super('Entitlement state could not be read');
    this.name = 'EntitlementUnavailableError';
    this.entitlementUnavailable = true;
    this.status = 503;
    this.code = 'ENTITLEMENT_UNAVAILABLE';
    this.reason = reason || 'lookup_failed';
  }
}

// users.id is SERIAL, so a positive integer is the only valid shape, and '5'
// and 5 are the same account. Same rule and the same reasoning as
// services/birdieUsage.js accountKey() and services/forecastUsage.js — the
// meters this file REPORTS are keyed through that function, so normalising here
// too is what keeps the number shown to the user and the number enforced by the
// meter the same number.
//
// It also means an unusable id never reaches Postgres: `WHERE id = 'abc'` is a
// 22P02 that would land in the catch below and read as "not a subscriber",
// which is fail-closed but indistinguishable from a real database outage.
function accountId(userId) {
  if (typeof userId !== 'number' && typeof userId !== 'string') return null;
  const n = Number(userId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// A boolean kill switch is ON only for the exact string "true".
//
// Strict on purpose: the failure direction of a strict read is that a
// mis-spelled flag leaves the paywall OFF, i.e. nobody is charged and nobody
// loses access. A permissive read ("1", "yes", "TRUE") has the opposite failure
// direction, where a stray value in a dashboard starts metering real accounts.
//
// But a flag that is SET and silently ignored is its own incident: somebody
// believes billing is live, nothing is metered, and there is no evidence
// anywhere. So a value that is neither "true" nor "false" is announced once per
// process rather than swallowed.
const warnedFlags = new Set();
function warnOnce(key, message) {
  if (warnedFlags.has(key)) return false;
  warnedFlags.add(key);
  console.warn(message);
  return true;
}

// Most flags here default OFF, which is the safe direction for a gate that
// meters money. A few default ON, because the thing they gate is invisible
// when it is off and an invisible feature is not a safe default, it is a
// feature nobody can find: Roost's typed question field is the case that
// forced this parameter (ADVISOR_FREETEXT_ENABLED, ADVISOR_PHRASING_ENABLED).
// Either way the env var still decides: "false" turns a default-on flag off.
function boolFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  warnOnce(
    `flag:${name}`,
    `[entitlements] ${name}=${JSON.stringify(String(raw).slice(0, 32))} is not "true" or "false". Treating it as its default (${defaultValue ? 'ON' : 'OFF'}). This flag reads the exact strings "true" and "false" and nothing else.`
  );
  return defaultValue;
}

/**
 * The honest three-way answer about one account's Pro state.
 *
 * @returns {Promise<{premium: boolean, known: boolean, reason: string|null}>}
 *   known === false means the lookup did not happen or did not succeed. `premium`
 *   is false in that case, because a paid boundary must not open on a shrug —
 *   but a caller that can tell the user something better than "you have not
 *   paid" should branch on `known`, not on `premium`.
 */
async function getPremiumState(userId) {
  const id = accountId(userId);
  if (id === null) return { premium: false, known: false, reason: 'identity' };
  try {
    const r = await pool.query('SELECT is_premium FROM users WHERE id = $1', [id]);
    const rows = r && Array.isArray(r.rows) ? r.rows : [];
    // No row is a KNOWN answer: the account was deleted, and deleted accounts
    // are not subscribers. Only a failure to ask is unknown.
    if (rows.length === 0) return { premium: false, known: true, reason: 'no_such_user' };
    return { premium: rows[0].is_premium === true, known: true, reason: null };
  } catch (err) {
    // Never silent. The previous version of this function was a bare `catch {}`,
    // so a paid boundary could deny every subscriber in the fleet for as long as
    // one query was broken and nothing anywhere would say so.
    console.error(`Entitlement lookup failed for user ${id}:`, err?.message || err);
    return { premium: false, known: false, reason: 'lookup_failed' };
  }
}

// Premium entitlement check. Fail-closed boolean: an id we cannot use and a
// lookup that throws both answer false, because this is read as "may this
// account have the paid thing".
//
// CALLERS THAT SHOW SOMETHING TO A USER SHOULD USE getPremiumState INSTEAD.
// The two route consumers that used to derive a free-tier decision from this
// boolean — routes/ai.js (Birdie's daily meter) and routes/crowd.js
// (forecastAccess) — both branch on `known` now and answer a retryable 503 on
// an unknown state instead of metering, so a failed query no longer drops a
// paying subscriber to the free tier or pitches them the plan they already
// bought (__tests__/premiumKnownState.test.js pins both, and pins that the
// dormant paywall never runs the lookup at all). This function stays exported
// for boundaries where a fail-closed boolean is the whole question; anything
// user-facing wants the tri-state.
async function isPremium(userId) {
  return (await getPremiumState(userId)).premium;
}

// Paywall master switch. Dormant unless PAYWALL_ENABLED=true is set (Railway env).
//
// A WALL WITH NO DOOR IN IT. users.is_premium has exactly one writer in this
// repo, the RevenueCat webhook, and that route answers 503 to everything when
// REVENUECAT_WEBHOOK_SECRET is unset. So turning the paywall on without the
// secret meters every account down to the free tier and makes it impossible for
// any of them to ever leave it: the purchase succeeds in the App Store, the
// entitlement event is refused, and the customer has paid for nothing. Both
// variables are unset today, which is the correct dormant state; they have to be
// turned on in the right ORDER, and this is the only place in the process that
// can notice they were not.
//
// It warns rather than overriding. Quietly ignoring an operator's explicit
// PAYWALL_ENABLED=true because of the value of a different variable is a worse
// surprise than a loud log line, and it is the kind of hidden coupling nobody
// can debug at the moment it matters.
function paywallEnabled() {
  const on = boolFlag('PAYWALL_ENABLED');
  // Ask the webhook route what it considers configured rather than reading the
  // variable raw. A blank, whitespace-only, or too-short secret is refused
  // there but looked SET to a raw truthiness test, so this preflight went
  // quiet in exactly the case it exists to catch: every account metered while
  // no purchase can lift any of them. Required lazily because the route is
  // mounted after this module loads.
  const secretConfigured = require('../routes/revenuecat').configuredSecret();
  if (on && !secretConfigured) {
    warnOnce(
      'preflight:paywall-no-grant-path',
      '[entitlements] PAYWALL_ENABLED=true but REVENUECAT_WEBHOOK_SECRET is unset. routes/revenuecat.js refuses every event without it, and it is the only writer of users.is_premium, so every account is metered on the free tier and NO purchase can lift it. Set the webhook secret before metering anyone.'
    );
  }
  return on;
}

// Entitlements snapshot for the client (GET /api/entitlements).
// Shape is a frontend contract:
// { isPremium, paywallEnabled,
//   birdie:   { limit, used, remaining },     // per day
//   forecast: { limit, used, remaining } }    // per calendar month
//
// THROWS EntitlementUnavailableError rather than reporting isPremium:false on a
// failed lookup. The client caches this snapshot for the life of the session
// (frontend/src/App.js fetches it once at boot), so a single blip answered with
// a confident "false" would show the paywall to a subscriber until they killed
// the app. A 503 leaves the client with no snapshot at all, which renders as
// neither Pro nor paywalled, and the boot fetch is retried after any purchase.
//
// WHAT THESE NUMBERS ARE AND ARE NOT. `used`/`remaining` come from the
// in-process meters in services/birdieUsage.js and services/forecastUsage.js.
// They reset on every deploy and they are per-instance, so on more than one
// Railway instance this is the allowance on WHICHEVER instance answered. Stated
// out loud because it is the one thing here that is shown to a user and is not
// backed by durable data; the fix is a Postgres-backed meter, not a different
// sentence.
async function getEntitlements(userId) {
  const enabled = paywallEnabled();
  const state = await getPremiumState(userId);
  if (!state.known) throw new EntitlementUnavailableError(state.reason);
  const premium = state.premium;
  const metered = enabled && !premium;
  const birdieLimit = metered ? FREE_DAILY_LIMIT : PREMIUM_DAILY_LIMIT;
  const birdieUsed = getUsedToday(userId);
  const forecastUsed = getUsedThisMonth(userId);
  return {
    isPremium: premium,
    paywallEnabled: enabled,
    birdie: {
      limit: birdieLimit,
      used: birdieUsed,
      // Clamped: switching the paywall on mid-day drops the limit from 150 to
      // 10 under accounts that have already spent more than 10, and a negative
      // "remaining" would render as a negative number on a screen.
      remaining: Math.max(0, birdieLimit - birdieUsed),
    },
    forecast: {
      limit: metered ? FREE_MONTHLY_FORECASTS : null,
      used: forecastUsed,
      remaining: metered ? Math.max(0, FREE_MONTHLY_FORECASTS - forecastUsed) : null,
    },
  };
}

module.exports = {
  isPremium,
  getPremiumState,
  paywallEnabled,
  getEntitlements,
  EntitlementUnavailableError,
  // Shared with services/venueEntitlements.js so both kill switches read their
  // env var the same way and warn about the same mis-spellings.
  boolFlag,
  warnOnce,
};
