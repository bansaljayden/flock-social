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

// userId -> { month: 'YYYY-MM', count: number }
const usage = new Map();

function monthKey() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

function getUsedThisMonth(userId) {
  const rec = usage.get(userId);
  if (!rec || rec.month !== monthKey()) return 0;
  return rec.count;
}

// Record one forecast view. Returns the post-increment count. Call this only when
// a free (non-premium) user is actually consuming a gated forecast.
function recordView(userId) {
  const month = monthKey();
  const rec = usage.get(userId);
  if (!rec || rec.month !== month) {
    usage.set(userId, { month, count: 1 });
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
