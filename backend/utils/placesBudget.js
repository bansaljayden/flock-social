// ---------------------------------------------------------------------------
// Shared upstream budget for PAID Google Places calls.
//
// THIS IS A FINANCIAL CONTROL, NOT AN ABUSE CONTROL. Every unit spent here is
// a real invoice line from Google. Text Search, Place Details, Nearby Search
// and Place Photos are each billed per request (see utils/upstream.js for which
// leg of the photo proxy is the metered one). At the designed
// usage of this app an ungated Places surface was measured at roughly $15,750
// a month against zero revenue, so treat a change to this file the way you
// would treat a change to a payment amount.
//
// THE LIMITS (the authoritative statement — nothing else in the repo states
// them, so keep this block current and mirror it into MONEY-MODEL.md):
//
//   PER_USER_HOURLY = 30    paid Places calls per authenticated user, per
//                           ROLLING 60 minutes. Rolling, so there is no
//                           boundary a user can wait for and burst across.
//   GLOBAL_DAILY    = 3000  paid Places calls across the whole process, per
//                           FIXED UTC calendar day. Fixed, so the worst case at
//                           the boundary is 6000 calls inside a couple of
//                           minutes either side of 00:00 UTC. No single user
//                           can do that (the rolling hourly cap holds them to
//                           30), so it takes ~200 accounts acting together; the
//                           per-user cap is what makes the boundary tolerable.
//                           A rolling daily window would need a full day of
//                           timestamps per user in memory, which is the wrong
//                           trade here — the right fix is moving this counter
//                           to Postgres (see below), where a rolling window is
//                           a WHERE clause rather than an array.
//
// CHARGE BEFORE YOU CALL, AND CHARGE WHAT YOU SPEND.
//   * A request that makes N paid Google calls must charge N. Use the `cost`
//     argument. Gating N calls behind one unit lets a caller spend N times its
//     budget, which is the exact bug this file exists to prevent.
//   * Charge BEFORE the fetch, never after. Google bills a request it received
//     even if we abort it on timeout (see utils/upstream.js), so a
//     charge-on-success design undercounts precisely when things are going
//     wrong and the retry pressure is highest.
//   * Cache hits must be answered before the charge. Charging for a call you
//     did not make is only wasteful, but it also masks the real burn rate.
//
// IN-MEMORY STATE — READ THIS BEFORE TRUSTING THE NUMBERS.
//   Both counters live in this process's heap. That means:
//     * They reset to zero on every Railway deploy, crash and restart. A day
//       with ten deploys has no 3000/day ceiling in any real sense; it has ten
//       fresh 3000-call allowances. GLOBAL_DAILY is therefore a brake, not a
//       cap.
//     * They divide by the instance count. Two instances = 6000/day and
//       60/user/hour, silently.
//     * They cannot be inspected, alerted on, or audited after the fact.
//   Nothing here races: allow() is fully synchronous and Node runs one turn at
//   a time, so two concurrent requests cannot interleave inside the counter.
//   That guarantee is per process and evaporates the moment there are two.
//
//   WHAT SHOULD MOVE TO POSTGRES: GLOBAL_DAILY. It is the only limit here that
//   is denominated in money rather than in politeness, and it is the one an
//   in-memory implementation fails hardest at, because a deploy loop is
//   indistinguishable from having no cap. A single row
//   (`places_spend(day date primary key, units int)`) updated with
//   `INSERT ... ON CONFLICT DO UPDATE SET units = units + $1 RETURNING units`
//   is one round trip, is correct across restarts and instances, and gives a
//   human something to query when the Google invoice looks wrong. Keep the
//   in-memory counter in front of it as a cheap first gate.
//
//   PER_USER_HOURLY can stay in memory: it is an abuse control, a restart only
//   ever helps a user who was already being throttled, and the global ceiling
//   is what actually bounds the bill.
//
// EVERY PAID PLACES SURFACE NOW CHARGES THIS LEDGER. Re-verified call site by
// call site (grep `places.googleapis.com` under backend/, excluding scripts/ and
// tests) — the three surfaces this block used to list as UNCHARGED were all
// wired up and the note went stale, which is worse than no note: it invited the
// next reader to "fix" work that was already done and to trust a $/day figure
// that was already wrong.
//
//   allowPlacesSearch(userId, cost)  — authenticated, charges BOTH ceilings:
//     routes/crowd.js         1 for the card (GET /:placeId), 2 for
//                             /:placeId/alternatives (Place Details + Text
//                             Search). Both behind a 10-minute response cache.
//     routes/venueSearch.js   1 for the text search, 1 for place details.
//     routes/ai.js            1 per Birdie search_venues / get_crowd_prediction
//                             tool call, charged to the user steering the model.
//     routes/venueDashboard.js 1 per owner-dashboard Place Details and 1 per
//                             competitor searchNearby.
//
//   allowGlobalPlacesCall(cost)      — no user to charge, so GLOBAL_DAILY only.
//     Each keeps its own per-IP or per-venue gate; this module is what makes
//     the daily ceiling cover them too.
//     routes/badge.js         1 per cache miss, behind "claimed AND verified"
//                             plus a 15-minute cache.
//     routes/publicCrowd.js   1 per cache miss on each marketing-demo endpoint
//                             (Text Search, Place Details), behind allowDemo()
//                             per IP — and charged AFTER that gate, so a demo
//                             request that is refused never charges for a call
//                             it was never going to make.
//     routes/venueSearch.js   1 per photo-proxy cache miss, behind
//                             allowPhotoFetch() per IP. Cost 1 and not 2
//                             because only the /media metadata leg is believed
//                             billed; the second leg pulls bytes from Google's
//                             CDN. If an invoice ever shows otherwise, that is
//                             the one number here that should become a 2.
//
//   THE REMAINING HOLE is not a surface, it is a dimension: those three charge
//   no per-user ceiling because they have no user. An unauthenticated caller is
//   therefore bounded by GLOBAL_DAILY and their own per-IP gate alone, and
//   GLOBAL_DAILY resets on every deploy (see IN-MEMORY STATE above).
//
//   backend/scripts/ml/* calls Places directly and charges nothing. That is
//   correct — they are operator-run batch jobs, not request paths — but their
//   spend does not appear in these counters either, so the invoice can exceed
//   what this module thinks was spent on any day a training run happened.
//
//   __tests__/paidCallBudgets.test.js drives the real routers against the real
//   ledger and fails if any of the above stops charging. Keep this list current
//   the same way: check the call site, not the comment.
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;

const PER_USER_HOURLY = 30;
const GLOBAL_DAILY = 3000;

// Soft ceiling on tracked users. Deliberately generous: the entries are tiny
// and dropping them is what costs money, not keeping them.
const MAX_TRACKED_USERS = 20000;
// Evict down to here rather than to exactly MAX. Without the gap, a map sitting
// at the ceiling pays a full scan and sort of 20,000 entries on EVERY call —
// add one, exceed by one, sort, evict one, repeat. That is a self-inflicted CPU
// DoS reachable by anyone who can hold the map full. With the gap, eviction
// runs at most once per 2,000 charges.
const EVICT_TARGET = 18000;

const userHits = new Map(); // userId (number) -> number[] of charge timestamps
let dayKey = utcDay();
let dayCount = 0;

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

// '5' and 5 are the same user and must share one bucket. Anything that is not
// a real id is denied rather than handed a free lane: Number(null), Number(''),
// Number(false) and Number([]) are all 0, so a permissive check would give
// every unidentifiable caller one shared 30/hour allowance AND let them
// through. users.id is SERIAL, so a positive integer is the only valid shape.
// Fail closed — this is a spending control.
function keyOf(userId) {
  // Only a number or a numeric string is an id. Without the type gate, Number()
  // coerces `true` and `[9]` into 1 and 9, so a stray boolean or single-element
  // array would spend a real user's allowance rather than being refused.
  if (typeof userId !== 'number' && typeof userId !== 'string') return null;
  const n = Number(userId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function assertCost(cost) {
  if (!Number.isInteger(cost) || cost < 1 || cost > PER_USER_HOURLY) {
    throw new Error(
      `placesBudget: cost must be an integer between 1 and ${PER_USER_HOURLY}, got ${String(cost)}`
    );
  }
}

function rollDay() {
  const today = utcDay();
  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
  }
}

// Never clear() the whole map to make room. A wholesale clear hands every
// tracked user a fresh hourly allowance, so whoever pushes the map over the
// threshold wipes their own counter — and the caller who trips the threshold is
// the one who just spent a unit. Evict LEAST CONSUMED first instead: the
// entries dropped are the ones with almost nothing left to remember, and an
// attacker who has spent all 30 is the last entry to go. Age is the wrong key,
// because an attacker spends their budget and only then floods the map, which
// makes their entry the oldest one there.
function evictIfOversized(now) {
  if (userHits.size <= MAX_TRACKED_USERS) return;
  for (const [k, v] of userHits) {
    const live = v.filter((t) => now - t < HOUR_MS);
    if (live.length === 0) userHits.delete(k);
    else if (live.length !== v.length) userHits.set(k, live);
  }
  if (userHits.size <= MAX_TRACKED_USERS) return;
  const bySpend = [...userHits.entries()].sort((a, b) => a[1].length - b[1].length);
  for (const [k] of bySpend) {
    if (userHits.size <= EVICT_TARGET) break;
    userHits.delete(k);
  }
}

/**
 * Charge the shared paid-Places budget for an authenticated user.
 *
 * All-or-nothing: a request that needs 2 units and only has 1 left is refused
 * and charged nothing, so a partial charge can never leave the caller believing
 * it may proceed.
 *
 * @param {number|string} userId  authenticated users.id
 * @param {number} [cost=1]       how many PAID Google calls this request makes
 * @returns {boolean} true when the caller may proceed
 */
function allowPlacesSearch(userId, cost = 1) {
  // `cost` is always a literal in the calling code, never user input, so a bad
  // one is a programming error. Throw rather than silently refuse forever: a
  // cost above the hourly ceiling can never be satisfied, and quietly returning
  // false would look like ordinary throttling and hide a broken route.
  assertCost(cost);
  const units = cost;
  const id = keyOf(userId);
  if (id === null) return false;

  rollDay();
  if (dayCount + units > GLOBAL_DAILY) return false;

  const now = Date.now();
  const hits = (userHits.get(id) || []).filter((t) => now - t < HOUR_MS);
  if (hits.length + units > PER_USER_HOURLY) {
    // Still write back the pruned array so an idle-then-refused user does not
    // keep a stale hour of timestamps alive.
    userHits.set(id, hits);
    return false;
  }

  for (let i = 0; i < units; i++) hits.push(now);
  userHits.set(id, hits);
  dayCount += units;
  evictIfOversized(now);
  return true;
}

/**
 * Charge ONLY the global daily ceiling, for paid Places surfaces that have no
 * authenticated user to charge (the public marketing demo, the venue badge, the
 * photo proxy). Those endpoints keep their own per-IP gate; this exists so the
 * daily ceiling is genuinely a ceiling on the Google invoice rather than a
 * ceiling on the authenticated slice of it.
 *
 * @param {number} [cost=1] how many PAID Google calls this request makes
 * @returns {boolean} true when the caller may proceed
 */
function allowGlobalPlacesCall(cost = 1) {
  assertCost(cost);
  const units = cost;
  rollDay();
  if (dayCount + units > GLOBAL_DAILY) return false;
  dayCount += units;
  return true;
}

/**
 * Non-consuming read, for tests and diagnostics. Never gate on this and then
 * call Google — read-then-act is not the same as allowPlacesSearch()'s single
 * synchronous charge.
 */
function placesBudgetStatus(userId) {
  rollDay();
  const now = Date.now();
  const id = keyOf(userId);
  const hits = id === null ? [] : (userHits.get(id) || []).filter((t) => now - t < HOUR_MS);
  return {
    day: dayKey,
    globalUsed: dayCount,
    globalRemaining: Math.max(0, GLOBAL_DAILY - dayCount),
    userRemaining: id === null ? 0 : Math.max(0, PER_USER_HOURLY - hits.length),
    trackedUsers: userHits.size,
    limits: { perUserHourly: PER_USER_HOURLY, globalDaily: GLOBAL_DAILY },
    // Say it out loud everywhere the numbers are read: this is process-local.
    inMemory: true,
  };
}

// Tests only. Production code must never reset a spending counter.
// `keepUsers` rolls only the global day, which is what a real UTC midnight does:
// the per-user map survives day boundaries, which is why it can grow past a
// single day's 3000 charges and why the eviction path is reachable at all.
function __resetPlacesBudget({ keepUsers = false } = {}) {
  if (!keepUsers) userHits.clear();
  dayKey = utcDay();
  dayCount = 0;
}

module.exports = {
  allowPlacesSearch,
  allowGlobalPlacesCall,
  placesBudgetStatus,
  __resetPlacesBudget,
  PER_USER_HOURLY,
  GLOBAL_DAILY,
};
