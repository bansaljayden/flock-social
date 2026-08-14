// Monthly per-user meter for the AI crowd FORECAST (best-time / hourly / peak).
//
// Product intent (Flock Pro): the "how busy right now" score stays free forever
// (it's the Google-Maps-equivalent commodity). The richer AI prediction — best
// time to go, the hourly curve, the peak window — is free for the first
// FREE_MONTHLY_FORECASTS venue views each calendar month, then Pro-only.
//
// In-memory + per calendar month, mirroring services/birdieUsage.js. Resets on
// deploy; acceptable because the paywall is a nudge, not DRM. If this ever needs
// to survive restarts, back it with a `forecast_views` table keyed (user_id, month).
const FREE_MONTHLY_FORECASTS = 10;

// account id (positive integer) -> { month: 'YYYY-MM', count: number }
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

function getUsedThisMonth(userId) {
  const id = accountKey(userId);
  if (id === null) return 0;
  const rec = usage.get(id);
  if (!rec || rec.month !== monthKey()) return 0;
  return rec.count;
}

// Record one forecast view. Returns the post-increment count, or 0 when the
// caller could not be identified (nothing was recorded). Call this only when
// a free (non-premium) user is actually consuming a gated forecast.
function recordView(userId) {
  const id = accountKey(userId);
  if (id === null) return 0;
  const month = monthKey();
  const rec = usage.get(id);
  if (!rec || rec.month !== month) {
    usage.set(id, { month, count: 1 });
    return 1;
  }
  rec.count += 1;
  return rec.count;
}

// Hourly cleanup of stale (previous-month) entries so the map can't grow forever.
const cleanup = setInterval(() => {
  const month = monthKey();
  for (const [userId, rec] of usage) {
    if (rec.month !== month) usage.delete(userId);
  }
}, 3600000);
if (cleanup.unref) cleanup.unref(); // don't hold the process / test runner open

module.exports = { FREE_MONTHLY_FORECASTS, getUsedThisMonth, recordView };
