// ---------------------------------------------------------------------------
// Shared upstream budget for PAID Google Cloud Vision SafeSearch calls.
//
// THIS IS A FINANCIAL CONTROL, NOT AN ABUSE CONTROL — the same sentence
// utils/placesBudget.js opens with, and this file is deliberately its twin.
// Read that one first; everything it says about in-memory counters, about
// charging before the call, and about what should eventually move to Postgres
// applies here word for word.
//
// WHY THIS FILE EXISTS. The round-3 money audit (SECURITY-AUDIT-money.md, M3-2)
// found Vision to be the ONLY paid upstream in the repo with neither a
// per-account daily ceiling nor a global one. Its lone control was the
// `imageSpendLimiter` in server.js: 10 billed images per 60 seconds per
// account. Sustained, that is ~14,400 Vision calls per account per day —
// ~$21.60/day/account — and, because there was no global counter of any kind,
// N accounts cost N x $21.60/day with nothing to stop it and nothing to report
// it. Ten throwaway accounts was $216/day. A hundred was $2,160/day. Account
// creation was the only brake and it is the cheapest one in the system.
//
// Places was already capped in aggregate at ~$96/day; Vision, the upstream with
// the cheapest door (an avatar change on the attacker's own account, needing no
// flock, no membership and no second party), had no aggregate cap at all. That
// asymmetry is what this file removes.
//
// ---------------------------------------------------------------------------
// THE LIMITS, AND THE ARITHMETIC BEHIND THEM
// ---------------------------------------------------------------------------
// Unit price: SafeSearch Detection bills $1.50 per 1,000 images (the first
// 1,000 in a month are free, which is noise at these volumes). One screened
// image = $0.0015. Every number below is derived from that one figure, so if
// Google's price changes this block is the only place to redo the sums.
//
//   VISION_GLOBAL_DAILY = 2000   billed Vision calls across the WHOLE PROCESS,
//                                per FIXED UTC calendar day.
//
//     2000 x $0.0015 = $3.00/day, i.e. ~$90/month, as the worst case for the
//     entire service no matter how many accounts attack it. Before this it was
//     unbounded.
//
//     Sized from real usage, not from a round number. The app has ~14 users
//     today and an avatar change is a once-in-a-while action, so the volume
//     driver is chat and DM photos. Budget for a user base twenty times the
//     current one: 300 daily-active users x 5 screened images each = 1,500 a
//     day. 2,000 clears that with headroom, and is ~40x what today's 14 users
//     could plausibly generate. An abuser, by contrast, reaches their own
//     per-account ceiling in minutes (see below), so this ceiling separates the
//     two populations rather than splitting the difference.
//
//     REVIEW TRIGGER: past ~350 daily-active users this number is too small and
//     legitimate uploads will start being refused. Raising it is a one-line
//     change — redo the multiplication above and move the dollar figure with
//     it. Do NOT raise it just because a log line appeared; read the log first,
//     it names the account that spent the day.
//
//   VISION_USER_HOURLY = 30      per authenticated account, per ROLLING hour
//   VISION_USER_DAILY   = 60     per authenticated account, per 24h window
//                                anchored at that account's first screened
//                                image (utils/probeBudget.js's window; the
//                                rolling hour is what bounds the burst at the
//                                boundary).
//
//     60 x $0.0015 = $0.09/day/account, down from ~$21.60. This is the
//     dimension the audit says Places lacks and Vision needed most.
//
//     Why 60 and not something tighter: a heavy real night out is maybe 20-30
//     photos across a flock chat and a couple of DM threads, plus the odd
//     avatar. 60 is roughly double that and twelve times the 5/day the global
//     ceiling is sized on, so no real user will ever see it. An account driving
//     the existing 10-per-60s limiter flat out reaches it in six minutes.
//
//     Why an hourly leg as well: without one, a caller spends the whole day's
//     60 inside those six minutes. 30/hour is still about three times a heavy
//     hour of real posting and it stretches an abuser across the day instead.
//
// TWO INVARIANTS, both pinned by __tests__/visionSpendBudget.test.js. Keep them
// if either constant is ever changed — they are the same pair of inequalities
// services/mlPredictor.js states for the event budget, for the same reasons:
//
//   VISION_USER_DAILY (60) < VISION_GLOBAL_DAILY (2000)
//       The PER-ACCOUNT ceiling bites first. One account can consume at most 3%
//       of the day's global allowance, so it takes at least 34 cooperating
//       accounts to exhaust it rather than one. This is the dimension the audit
//       says the Places budget is missing.
//
//   VISION_USER_HOURLY (30) < VISION_USER_DAILY (60)
//       A single hour cannot spend the day.
//
// ---------------------------------------------------------------------------
// WHAT HAPPENS WHEN A CEILING IS HIT: THE UPLOAD IS REFUSED. FAIL CLOSED.
// ---------------------------------------------------------------------------
// READ THIS BEFORE "FIXING" IT. utils/moderation.js fails CLOSED on every other
// way a screen can fail to happen — no provider configured, bytes unreadable,
// provider 5xx, provider timeout, a 200 carrying no annotation. Budget
// exhaustion is another way the screen did not happen, so it takes the same
// answer: the image is REFUSED, not stored.
//
// The tempting alternative is to let the image through once the budget is gone,
// on the grounds that a spend cap should not break the product. Do not. Failing
// open here would convert this spending control into an IMAGE MODERATION
// BYPASS: an attacker who wants to post unscreened imagery would simply burn
// the day's cheap calls first and then upload whatever they liked. On an app
// whose enforced age floor is 13 that is far worse than the bill this file
// exists to cap, and it would be a bypass anyone could trigger for $3.
//
// The cost of that decision, stated honestly rather than hidden: exhausting the
// GLOBAL ceiling turns image uploads off for everyone until 00:00 UTC, so it is
// a denial lever for whoever can afford ~34 accounts. That is the same shape
// the OpenWeatherMap ceiling already has (the audit's own cost table records it
// as "$0, but denies every other user"), and it is why the global number is set
// well above real usage and why exhaustion logs loudly instead of silently. A
// day of no photo uploads is recoverable; a day of unscreened photo uploads
// reaching minors is not.
//
// ---------------------------------------------------------------------------
// EXHAUSTION IS LOUD ON PURPOSE
// ---------------------------------------------------------------------------
// The audit's complaint about every existing ceiling in this repo is that they
// are silent in-heap counters nothing can inspect, so the first evidence of a
// problem is an invoice. This one talks:
//
//   * an 80%-of-global warning, once per UTC day, so there is a chance to look
//     BEFORE uploads start being refused;
//   * a console.error on every exhaustion, naming which leg bit and which
//     account, using the 'MONEY' token so it is greppable in Railway logs;
//   * that error is throttled to one line per leg per 60 seconds, carrying a
//     count of what it suppressed. An unthrottled line per refusal would let
//     the attacker choose our log bill too, and a flooded log is as unreadable
//     as a silent one.
//
// ---------------------------------------------------------------------------
// CALL SITES — WHICH LEG EACH ONE CHARGES TODAY
// ---------------------------------------------------------------------------
// utils/placesBudget.js keeps a list like this and says to check the call site
// rather than the comment. Same rule here. There is exactly ONE chokepoint —
// moderateImage() in utils/moderation.js — and every billed Vision call in the
// repo goes through it, so the GLOBAL ceiling already covers all of them.
//
// The PER-ACCOUNT ceiling bites only when the caller passes `{ userId }`, and
// as of 2026-08-18 ALL SIX call sites do. They are:
//
//   routes/users.js:~1485        avatar upload   req.user.id
//   routes/messages.js:~305      flock photo     req.user.id
//   routes/messages.js:~834      DM photo        req.user.id
//   routes/stories.js:~417       story           req.user.id
//   sockets/handlers.js:~1156    flock photo     socket.user.id
//   sockets/handlers.js:~1819    DM photo        socket.user.id
//
// The REST doors sit behind `authenticate`, and both socket doors close over
// `socket.user`, which authenticateSocket loads from the users table rather
// than trusting the JWT claim, so every id here is a real row id. The
// `identity` refusal below is therefore reachable only through a caller bug.
//
// __tests__/visionSpendBudget.test.js pins this list two ways: each site's
// call count and identity expression, and a sweep over routes/ services/
// sockets/ utils/ middleware/ that fails on any moderateImage( without a
// userId. A seventh door cannot land silently.
//
// The avatar path is the one to do first: the audit names it as the cheapest
// door in the app, because it needs no flock, no membership and no second
// party.
//
// ---------------------------------------------------------------------------
// IN-MEMORY STATE
// ---------------------------------------------------------------------------
// Both counters live in this process's heap, exactly like placesBudget and
// probeBudget: they reset on every Railway deploy, crash and restart, and they
// divide by the instance count. So VISION_GLOBAL_DAILY is a brake, not a cap —
// a day with ten deploys has ten fresh $3 allowances. It is still the whole
// difference between a bounded worst case and an unbounded one. If this ever
// runs multi-instance, or if the deploy loop ever matters, GLOBAL_DAILY is the
// piece that moves to Postgres first (a single `vision_spend(day, units)` row
// updated with INSERT ... ON CONFLICT DO UPDATE), because it is the leg
// denominated in money. Nothing here races: every function below is fully
// synchronous, so two concurrent requests cannot interleave inside a counter.
// That guarantee is per process and evaporates the moment there are two.
// ---------------------------------------------------------------------------

const { createUserBudget } = require('./probeBudget');

const VISION_USER_HOURLY = 30;
const VISION_USER_DAILY = 60;
const VISION_GLOBAL_DAILY = 2000;

// $1.50 per 1,000 images. Kept in one place so the log lines, the status read
// and the tests quote one number rather than three copies of it.
const VISION_UNIT_PRICE_USD = 0.0015;

// Warn before the wall, not only at it.
const GLOBAL_WARN_AT = Math.floor(VISION_GLOBAL_DAILY * 0.8);

// One error line per leg per minute; the rest are counted and reported on the
// next one. See EXHAUSTION IS LOUD ON PURPOSE above.
const LOG_THROTTLE_MS = 60 * 1000;

const userBudget = createUserBudget({
  name: 'vision-safesearch',
  hourly: VISION_USER_HOURLY,
  daily: VISION_USER_DAILY,
});

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

let dayKey = utcDay();
let dayCount = 0;
let warnedToday = false;
const lastLog = { global: 0, account: 0, identity: 0 };
const suppressed = { global: 0, account: 0, identity: 0 };

function usd(units) {
  return (units * VISION_UNIT_PRICE_USD).toFixed(2);
}

function rollDay() {
  const today = utcDay();
  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
    warnedToday = false;
  }
}

// Loud, greppable, and not floodable. 'MONEY' is the token an operator searches
// Railway logs for; the shield matches the moderation convention so a reader
// can see at a glance that an upload was refused as a consequence.
// Is this id one createUserBudget will actually meter? Restated here for the
// LOG only, never for the decision — createUserBudget.keyOf stays the single
// judge of that. Without it a malformed id refused by the budget got logged as
// "account 0 exhausted its Cloud Vision budget", which is not what happened and
// would send an operator hunting for a user that does not exist.
function isMeterableId(userId) {
  if (typeof userId !== 'number' && typeof userId !== 'string') return false;
  const n = Number(userId);
  return Number.isInteger(n) && n > 0;
}

function reportExhaustion(scope, userId) {
  const now = Date.now();
  if (now - lastLog[scope] < LOG_THROTTLE_MS) {
    suppressed[scope] += 1;
    return;
  }
  const alsoSuppressed = suppressed[scope];
  suppressed[scope] = 0;
  lastLog[scope] = now;
  const tail = alsoSuppressed > 0
    ? ` (${alsoSuppressed} further refusals in the last minute were not logged)`
    : '';
  if (scope === 'identity') {
    console.error(
      `🛡️ MONEY: refused a Cloud Vision screen for an unusable account id (${JSON.stringify(userId)}). ` +
      'Nothing was billed and the upload was REJECTED. This is a caller passing a bad userId, ' +
      `not a budget being spent — fix the call site.${tail}`
    );
  } else if (scope === 'global') {
    console.error(
      `🛡️ MONEY: Cloud Vision GLOBAL daily budget EXHAUSTED (${dayCount}/${VISION_GLOBAL_DAILY} calls, ` +
      `~$${usd(dayCount)} on ${dayKey} UTC). EVERY image upload in the app is now being REJECTED ` +
      'until 00:00 UTC. That is fail-closed BY DESIGN — see utils/visionBudget.js before changing it. ' +
      `Find out who spent it before raising the ceiling.${tail}`
    );
  } else {
    console.error(
      `🛡️ MONEY: account ${String(userId)} exhausted its Cloud Vision budget ` +
      `(${VISION_USER_HOURLY}/hour, ${VISION_USER_DAILY}/day, ~$${usd(VISION_USER_DAILY)}/day). ` +
      'Its image uploads are being REJECTED. One account cannot reach the global ' +
      `${VISION_GLOBAL_DAILY}/day ceiling; ${Math.ceil(VISION_GLOBAL_DAILY / VISION_USER_DAILY)} ` +
      `cooperating accounts can.${tail}`
    );
  }
}

/**
 * Charge the shared paid-Vision budget for ONE SafeSearch call.
 *
 * Charge BEFORE the fetch, and only for a call that is actually going to be
 * made — the rule utils/placesBudget.js states. An image refused for free
 * (animated, malformed, oversized, no provider configured) must never reach
 * this function.
 *
 * ORDER MATTERS, and it is the order services/mlPredictor.js's allowEventFetch
 * uses: the global ceiling is READ first and INCREMENTED last, with the
 * per-account charge in between, so a call the global budget was going to
 * refuse never eats one of the caller's units.
 *
 * @param {number|string} [userId] authenticated users.id. Optional: background
 *   and not-yet-wired callers charge the global leg only, exactly the way
 *   allowEventFetch treats a caller with no account. A userId that is SUPPLIED
 *   but malformed is refused rather than waved through — createUserBudget.allow
 *   fails closed on anything that is not a positive integer id, matching
 *   placesBudget.keyOf().
 * @returns {{ allowed: boolean, scope: 'global'|'account'|'identity'|null }}
 */
function allowVisionCall(userId) {
  rollDay();

  if (dayCount >= VISION_GLOBAL_DAILY) {
    reportExhaustion('global');
    return { allowed: false, scope: 'global' };
  }

  if (userId != null && !userBudget.allow(userId)) {
    // Two different failures wear the same refusal here, and they are worth
    // telling apart in the logs: a real account that spent its allowance, and a
    // caller that handed us something that is not an id at all. Both fail
    // CLOSED — a bad id must never buy a free lane, which is placesBudget's
    // rule — but only the first is a budget being spent.
    const scope = isMeterableId(userId) ? 'account' : 'identity';
    reportExhaustion(scope, userId);
    return { allowed: false, scope };
  }

  dayCount += 1;

  if (!warnedToday && dayCount >= GLOBAL_WARN_AT) {
    warnedToday = true;
    console.error(
      `🛡️ MONEY: Cloud Vision global daily budget is ${Math.round((dayCount / VISION_GLOBAL_DAILY) * 100)}% spent ` +
      `(${dayCount}/${VISION_GLOBAL_DAILY} calls, ~$${usd(dayCount)} on ${dayKey} UTC). ` +
      'At 100% every image upload in the app is REJECTED. This warning fires once per UTC day.'
    );
  }

  return { allowed: true, scope: null };
}

/**
 * Non-consuming read, for tests and diagnostics. Never gate on this and then
 * call Vision — read-then-act is not the same as allowVisionCall()'s single
 * synchronous charge.
 */
function visionBudgetStatus(userId) {
  rollDay();
  const perUser = userId == null
    ? { hourly: VISION_USER_HOURLY, daily: VISION_USER_DAILY }
    : userBudget.remaining(userId);
  return {
    day: dayKey,
    globalUsed: dayCount,
    globalRemaining: Math.max(0, VISION_GLOBAL_DAILY - dayCount),
    globalSpendUsd: Number(usd(dayCount)),
    userRemaining: perUser,
    limits: {
      perUserHourly: VISION_USER_HOURLY,
      perUserDaily: VISION_USER_DAILY,
      globalDaily: VISION_GLOBAL_DAILY,
      unitPriceUsd: VISION_UNIT_PRICE_USD,
      globalDailyMaxSpendUsd: Number(usd(VISION_GLOBAL_DAILY)),
      perUserDailyMaxSpendUsd: Number(usd(VISION_USER_DAILY)),
    },
    // Say it out loud everywhere the numbers are read: this is process-local.
    inMemory: true,
  };
}

// Tests only. Production code must never reset a spending counter.
function __resetVisionBudget() {
  userBudget.reset();
  dayKey = utcDay();
  dayCount = 0;
  warnedToday = false;
  lastLog.global = 0;
  lastLog.account = 0;
  lastLog.identity = 0;
  suppressed.global = 0;
  suppressed.account = 0;
  suppressed.identity = 0;
}

module.exports = {
  allowVisionCall,
  visionBudgetStatus,
  __resetVisionBudget,
  VISION_USER_HOURLY,
  VISION_USER_DAILY,
  VISION_GLOBAL_DAILY,
  VISION_UNIT_PRICE_USD,
};
