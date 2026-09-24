// Monthly per-user meter for crowd levels AND the AI crowd forecast.
//
// Product rule (Flock Pro, 2026-09-24): a free account gets the crowd level
// ("how busy right now") and the forecast (best time to go, the hourly curve,
// the peak window) for FREE_MONTHLY_FORECASTS distinct venues each calendar
// month. Once those are spent, a venue it has not opened this month shows
// neither (routes/crowd.js lockedCard and crowdVisibility); a venue it already
// opened stays fully open. The live level used to be free forever; that rule
// was retired on this date.
//
// Enforced from memory, per calendar month (UTC), mirroring
// services/birdieUsage.js. It used to reset on every deploy, and Railway
// deploys on every push, so the monthly allowance was really an allowance per
// deploy. services/usageStore.js now writes every change to usage_meters
// (migration 075) and loads the current month back at boot, so the count and
// the venues already charged survive a restart. Memory is still what enforces.
const usageStore = require('./usageStore');

const FREE_MONTHLY_FORECASTS = 30;

// account id (positive integer) -> { month: 'YYYY-MM', count: number, venues: Set }
const usage = new Map();

function monthKey() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

// '5' and 5 are the same account and must share one bucket, and anything that
// is not a real id gets no bucket at all. Copied in intent from
// services/birdieUsage.js accountKey(), which this module already says it
// mirrors — and which states the rule this one was missing.
//
// Why it matters even though every caller today passes a number: this is a Map
// keyed by whatever it is handed, so the moment ONE call site reaches it with a
// string id (a route param, a socket payload, a JSON body — the shapes user ids
// arrive in everywhere else in this repo) that spelling gets its own fresh
// allowance, and the same person can spend the free tier twice. It also stops
// `undefined` from becoming a single shared bucket that every unidentified
// caller in the process draws down together.
//
// Fail closed: an unusable id records nothing and reads as 0 used. That is the
// safe direction for a METER, because routes/crowd.js gateForecast compares
// `used >= FREE_MONTHLY_FORECASTS` — an id we cannot attribute is one we cannot
// bill, and it must not be able to bill somebody else instead.
function accountKey(userId) {
  if (typeof userId !== 'number' && typeof userId !== 'string') return null;
  const n = Number(userId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// A venue already viewed this month is free to view again. The detail card
// refreshes every few minutes while open, a map pin and the detail modal each
// fetch, and people re-open the bar they are deciding on; counting requests
// burned a month's allowance in one evening on one venue. The allowance is
// "N different venues a month", which is what the upgrade copy says.
function hasViewed(userId, placeId) {
  const id = accountKey(userId);
  if (id === null || typeof placeId !== 'string' || !placeId) return false;
  const rec = usage.get(id);
  return !!(rec && rec.month === monthKey() && rec.venues && rec.venues.has(placeId));
}

function getUsedThisMonth(userId) {
  const id = accountKey(userId);
  if (id === null) return 0;
  const rec = usage.get(id);
  if (!rec || rec.month !== monthKey()) return 0;
  return rec.count;
}

function persist(id, rec) {
  // Skip building the row at all until boot has loaded the table.
  if (!usageStore.isEnabled()) return;
  usageStore.persist({
    userId: id, meter: 'forecast', period: rec.month, used: rec.count, tokens: 0, venues: [...rec.venues],
  });
}

// Record one forecast view. Returns the post-increment count, or 0 when the
// caller could not be identified (nothing was recorded). Call this only when
// a free (non-premium) user is actually consuming a gated forecast.
// With a placeId, a venue already counted this month is not counted again.
// Without one (Birdie charges one view per turn), every call counts.
function recordView(userId, placeId) {
  const id = accountKey(userId);
  if (id === null) return 0;
  const venue = typeof placeId === 'string' && placeId ? placeId : null;
  const month = monthKey();
  const rec = usage.get(id);
  if (!rec || rec.month !== month) {
    const fresh = { month, count: 1, venues: new Set(venue ? [venue] : []) };
    usage.set(id, fresh);
    persist(id, fresh);
    return 1;
  }
  if (venue && rec.venues.has(venue)) return rec.count;
  if (venue) rec.venues.add(venue);
  rec.count += 1;
  persist(id, rec);
  return rec.count;
}

// Boot only (services/usageStore.js hydrate). Loads one stored row for the
// CURRENT month; a row for any other month is ignored. Merges rather than
// replaces, keeping the larger count and the union of venues, so a retry after
// a failed boot load can never lower a count that grew in memory meanwhile.
// Returns true when the row was taken.
function __hydrate(row) {
  const id = accountKey(row && row.user_id);
  if (id === null || !row || row.period !== monthKey()) return false;
  const used = Number(row.used);
  const count = Number.isInteger(used) && used > 0 ? used : 0;
  const venues = Array.isArray(row.venues) ? row.venues.filter((v) => typeof v === 'string' && v) : [];
  const rec = usage.get(id);
  if (!rec || rec.month !== row.period) {
    const set = new Set(venues);
    usage.set(id, { month: row.period, count: Math.max(count, set.size), venues: set });
  } else {
    for (const v of venues) rec.venues.add(v);
    // Every venue in the set was charged once, so the count can never be
    // below the set's size. A retry after a failed boot load merges two
    // different months' worth of venues (the stored one and the one memory
    // collected meanwhile); keeping only the larger count left, say, 60
    // venues open on a meter reading 30.
    rec.count = Math.max(rec.count, count, rec.venues.size);
  }
  return true;
}

// Hourly cleanup of stale (previous-month) entries so the map can't grow forever.
const cleanup = setInterval(() => {
  const month = monthKey();
  for (const [userId, rec] of usage) {
    if (rec.month !== month) usage.delete(userId);
  }
}, 3600000);
if (cleanup.unref) cleanup.unref(); // don't hold the process / test runner open

module.exports = { FREE_MONTHLY_FORECASTS, getUsedThisMonth, recordView, hasViewed, __hydrate };
