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
// IN-MEMORY STATE — the same caveat as utils/placesBudget.js, restated because
// it changes what these numbers mean:
//   * Every counter lives in this process's heap, so it resets to zero on each
//     Railway deploy, crash and restart. A deploy hands every throttled user a
//     fresh allowance. An attacker cannot cause a deploy, so this is an
//     annoyance rather than a hole — but "60 probes a day" is really "60 probes
//     per deploy interval".
//   * The counters divide by the instance count. Two instances = double every
//     limit, silently. If this ever runs multi-instance the counters must move
//     to Postgres or Redis.
//   * Unlike placesBudget, nothing here is denominated in money. These are
//     abuse controls on a directory-enumeration channel, so a restart costs
//     privacy exposure, not dollars, and in-memory remains the right trade for
//     now. If enumeration ever becomes a live incident, the daily counter is
//     the piece worth moving to Postgres — it is the one whose window is long
//     enough for a restart to matter.
//   * allow() is fully synchronous and Node runs one turn at a time, so two
//     concurrent requests cannot interleave inside a counter. That guarantee is
//     per process.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * @param {object} opts
 * @param {string} opts.name     label, for debugging only
 * @param {number} opts.hourly   probes allowed per rolling 60 minutes
 * @param {number} opts.daily    probes allowed per fixed 24h window, anchored
 *                               at the caller's first probe (not a rolling 24h:
 *                               keeping a full day of timestamps per user to
 *                               get a rolling window costs more memory than the
 *                               precision is worth). The rolling hourly limit
 *                               is what bounds the burst at the boundary.
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
      // An entry is only forgettable when BOTH windows are empty. Dropping it
      // on the day reset alone was the same hourly-history wipe that allow()
      // guards against, reached through a different door: prune is triggered by
      // ANY user's call once PRUNE_INTERVAL_MS has passed, so a user whose day
      // window had just rolled could lose their live hourly timestamps without
      // ever calling allow() themselves, and got a second full hourly
      // allowance. Filter the hits first, then delete only if nothing is left.
      if (now < v.dayResetAt) continue;
      v.hits = v.hits.filter((t) => now - t < HOUR_MS);
      if (v.hits.length === 0) entries.delete(k);
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
    // Evict down to a low-water mark, not to exactly maxEntries. Stopping at
    // the ceiling means a map held at the ceiling pays a full scan and sort of
    // `maxEntries` entries on EVERY allow() — add one, exceed by one, sort,
    // evict one, repeat — which is a self-inflicted CPU DoS for anyone able to
    // keep the map full. With the gap, eviction runs once per 10% of maxEntries.
    const target = Math.floor(maxEntries * 0.9);
    for (const [k] of byValue) {
      if (entries.size <= target) break;
      entries.delete(k);
    }
  }

  function keyOf(userId) {
    // Only a number or a numeric string is an id. Without the type gate,
    // Number() coerces `true` and `[9]` into 1 and 9, so a stray boolean or
    // single-element array would consume a real user's probe budget instead of
    // being refused.
    if (typeof userId !== 'number' && typeof userId !== 'string') return null;
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
    if (!e) {
      e = { hits: [], dayCount: 0, dayResetAt: now + DAY_MS };
      entries.set(id, e);
    } else if (now >= e.dayResetAt) {
      // Roll the DAY only. The rolling hour must survive the rollover: building
      // a fresh entry here used to discard `hits`, so a caller who spent their
      // hourly allowance in the last minutes of the day window got a second
      // full hourly allowance seconds later — 2x `hourly` inside two minutes,
      // at a moment an attacker can compute exactly (24h after their own first
      // probe). Carrying the timestamps across makes the hourly window
      // genuinely rolling everywhere, including here.
      e.dayCount = 0;
      e.dayResetAt = now + DAY_MS;
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
    if (!e) return { hourly, daily };
    // The hour is rolling and survives the day rollover, so it is read the same
    // way either side of dayResetAt — mirroring allow(). Reporting a full
    // hourly allowance here just because the day flipped would have made this
    // read disagree with what allow() actually does.
    const hits = e.hits.filter((t) => now - t < HOUR_MS).length;
    const spentToday = now >= e.dayResetAt ? 0 : e.dayCount;
    return { hourly: Math.max(0, hourly - hits), daily: Math.max(0, daily - spentToday) };
  }

  function reset() { entries.clear(); lastPrune = 0; }

  return { allow, remaining, reset, limits: { hourly, daily }, name };
}

module.exports = { createUserBudget };
