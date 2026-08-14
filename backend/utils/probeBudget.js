// Per-user probe budgets.
//
// The general limiter (300 requests / 15 min) is a DoS control, not an abuse
// control: 300/15min is ~28,000 requests a day, which is enough to walk the
// entire user table one id at a time. Endpoints that answer a question about
// SOMEBODY ELSE ("does user 4193 exist, and what are they called?") therefore
// need a second budget denominated in what a real person actually does, not in
// what a server can survive.
//
// Identity is the authenticated numeric user id and nothing else. The
// equivalent limits elsewhere in this codebase were defeated by rotating IPs,
// changing the case of an email, and reconnecting sockets; none of those touch
// a user id, and a fresh id costs a fresh account.
//
// In-memory is fine on the single-instance Railway deployment (same assumption
// as utils/placesBudget.js). If this ever runs multi-instance the counters must
// move to Postgres or Redis, otherwise the budget divides by the instance count.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * @param {object} opts
 * @param {string} opts.name     label, for debugging only
 * @param {number} opts.hourly   probes allowed per rolling hour
 * @param {number} opts.daily    probes allowed per rolling 24h
 * @param {number} [opts.maxEntries] soft ceiling on tracked users
 */
function createUserBudget({ name = 'budget', hourly, daily, maxEntries = 20000 }) {
  if (!Number.isInteger(hourly) || hourly < 1) throw new Error(`${name}: hourly must be a positive integer`);
  if (!Number.isInteger(daily) || daily < 1) throw new Error(`${name}: daily must be a positive integer`);

  const entries = new Map(); // userId (number) -> { hits: number[], dayCount, dayResetAt }
  let lastPrune = 0;

  function prune(now) {
    lastPrune = now;
    for (const [k, v] of entries) {
      if (now >= v.dayResetAt) entries.delete(k);
    }
    if (entries.size <= maxEntries) return;
    // Never `clear()` the whole map to make room: a wholesale clear hands every
    // tracked user a fresh budget, so anyone able to push the map over the
    // threshold could wipe their own counter. (That is exactly what the
    // hand-rolled counter in routes/friends.js used to do.)
    //
    // Eviction order is LEAST CONSUMED first, so the entries that get dropped
    // are the ones with almost nothing left to remember. Age is the wrong key:
    // an attacker spends their budget and only THEN floods the map, so their
    // entry is the oldest one there and an oldest-first policy would delete
    // precisely the counter they wanted gone. Recovering a spent budget this
    // way now costs a flood of accounts that have each already spent a full
    // day's allowance, which is more than the budget being recovered.
    const byValue = [...entries.entries()].sort(
      (a, b) => (a[1].dayCount - b[1].dayCount) || (a[1].dayResetAt - b[1].dayResetAt)
    );
    for (const [k] of byValue) {
      if (entries.size <= maxEntries) break;
      entries.delete(k);
    }
  }

  function keyOf(userId) {
    const n = Number(userId);
    // '5' and 5 must land in the same bucket, and anything that is not a real
    // id is denied rather than given a free lane. Number.isFinite alone was not
    // enough: Number(null), Number(''), Number(false) and Number([]) are all 0,
    // so every unidentifiable caller shared one bucket AND was allowed through.
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  // Consumes one unit if there is one. Returns true when the caller may proceed.
  function allow(userId) {
    const id = keyOf(userId);
    if (id === null) return false;
    const now = Date.now();
    if (now - lastPrune > PRUNE_INTERVAL_MS || entries.size > maxEntries) prune(now);

    let e = entries.get(id);
    if (!e || now >= e.dayResetAt) {
      e = { hits: [], dayCount: 0, dayResetAt: now + DAY_MS };
      entries.set(id, e);
    }
    e.hits = e.hits.filter((t) => now - t < HOUR_MS);
    if (e.hits.length >= hourly || e.dayCount >= daily) return false;
    e.hits.push(now);
    e.dayCount += 1;
    return true;
  }

  // Non-consuming read, for tests and diagnostics.
  function remaining(userId) {
    const id = keyOf(userId);
    if (id === null) return { hourly: 0, daily: 0 };
    const now = Date.now();
    const e = entries.get(id);
    if (!e || now >= e.dayResetAt) return { hourly, daily };
    const hits = e.hits.filter((t) => now - t < HOUR_MS).length;
    return { hourly: Math.max(0, hourly - hits), daily: Math.max(0, daily - e.dayCount) };
  }

  function reset() { entries.clear(); lastPrune = 0; }

  return { allow, remaining, reset, limits: { hourly, daily }, name };
}

module.exports = { createUserBudget };
