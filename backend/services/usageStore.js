// ---------------------------------------------------------------------------
// POSTGRES BEHIND THE FREE-TIER METERS.
//
// services/forecastUsage.js (venues a month) and services/birdieUsage.js
// (messages a day, and each account's Gemini token spend for the day) enforce
// from process memory, synchronously, and a great many callers and tests rely
// on that. What memory cannot do is survive a restart, and Railway restarts
// this process on every push to main. A "30 venues a month" allowance was
// really "30 venues per deploy", and on a day with five deploys the free tier
// was five times what the Pro page says it is.
//
// So memory stays the enforcer and this file is what it remembers across a
// restart:
//
//   * WRITE-THROUGH. Every change hands this module the meter's new ABSOLUTE
//     value for one (account, meter, period). Writes are coalesced per row and
//     flushed a moment later, one batch at a time, so a Birdie turn that
//     charges the token ledger six times costs one upsert, and two batches can
//     never race each other for the same row. A failed write is logged (rate
//     limited) and dropped: the request that caused it was answered long ago,
//     and the next change to that row carries its whole value again.
//
//   * HYDRATION AT BOOT. server.js awaits hydrate() after migrations and before
//     listen(). It loads the CURRENT month's forecast rows and the CURRENT UTC
//     day's Birdie rows back into the two meters.
//
// NOTHING IS WRITTEN UNTIL hydrate() HAS SUCCEEDED. Writing absolute values
// from a process that never read the table would overwrite a real count with a
// fresh zero and hand every account a new allowance, which is the one direction
// a meter must not fail in. A boot whose hydration fails therefore runs from
// memory only, exactly as before this file existed, says so in the log, and
// tries again every minute. The same rule is why unit tests, which never boot
// the server, never reach the database from here.
//
// WHAT THIS DOES NOT DO.
//   * It does not make two instances agree. The app is pinned to one replica
//     (root project documentation, "exactly one server"); a second would enforce from its
//     own memory and the two would overwrite each other's rows.
//   * A deploy overlap (the new process has hydrated, the old one serves for a
//     few more seconds) can lose the old process's last increments. That error
//     is in the user's favour and bounded by those seconds. Absolute writes
//     were chosen over GREATEST() on purpose: GREATEST would also throw away
//     every refunded Birdie message at the next restart, which is an error
//     against the user.
//   * The rolling hour of the token ledger is not stored, so a restart can hand
//     back at most one hour of that window. The daily figures per account are
//     stored, and the global daily figure is rebuilt from them.
// ---------------------------------------------------------------------------

// Lazy, so the two meters can require this file without pulling the pool into
// every unit test that loads them.
const db = () => require('../config/database');

// How long a change waits for company before it is written. Long enough to
// fold a Birdie turn's several ledger charges into one write, short enough that
// a deploy's SIGTERM rarely lands inside it (and shutdown flushes anyway).
const FLUSH_DELAY_MS = 250;
const RETRY_HYDRATE_MS = 60 * 1000;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;
const LOG_EVERY_MS = 10 * 60 * 1000;

// Rows older than this are deleted. Long enough to keep one whole finished
// month next to the current one, which is what reading real usage against the
// free limits needs, and no longer: the venues column says which places an
// account opened, and nothing needs that once the month it paid for is over.
const KEEP_DAYS = 62;

const UPSERT_SQL = `INSERT INTO usage_meters (user_id, meter, period, used, tokens, venues, updated_at)
VALUES ($1::int, $2::text, $3::text, $4::int, $5::bigint, $6::text[], NOW())
ON CONFLICT (user_id, meter, period) DO UPDATE
   SET used = EXCLUDED.used,
       tokens = EXCLUDED.tokens,
       venues = ARRAY(SELECT DISTINCT v FROM unnest(usage_meters.venues || EXCLUDED.venues) AS v),
       updated_at = NOW()`;

// Venues are a union rather than an overwrite for the deploy-overlap case
// above: a venue the old process charged in its last seconds must stay free to
// reopen, not be charged a second time by the new one.

const SELECT_SQL = `SELECT user_id, meter, period, used, tokens, venues
  FROM usage_meters
 WHERE (meter = 'forecast' AND period = $1::text)
    OR (meter = 'birdie' AND period = $2::text)`;

const PRUNE_SQL = `DELETE FROM usage_meters WHERE updated_at < NOW() - make_interval(days => $1::int)`;

// A foreign-key refusal means the account was deleted between the change and
// the write. The CASCADE already took its rows; there is nothing to say.
const FK_VIOLATION = '23503';

let enabled = false;
const pending = new Map(); // `${userId}|${meter}|${period}` -> row
let flushTimer = null;
let flushing = false;
let hydrateRetry = null;
let pruneTimer = null;
let lastFailureLog = 0;

function monthKey(now = new Date()) {
  return now.toISOString().slice(0, 7); // YYYY-MM (UTC), forecastUsage's period
}

function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC), birdieUsage's period
}

function logFailure(what, err) {
  if (err && err.code === FK_VIOLATION) return;
  const now = Date.now();
  if (now - lastFailureLog < LOG_EVERY_MS) return;
  lastFailureLog = now;
  console.error(`[usage-meters] ${what} failed; the meters keep enforcing from memory:`, err?.message || err);
}

function scheduleFlush() {
  if (flushTimer || flushing) return;
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  if (flushTimer.unref) flushTimer.unref();
}

async function flush() {
  flushTimer = null;
  if (flushing || pending.size === 0) return;
  flushing = true;
  const batch = [...pending.values()];
  pending.clear();
  try {
    for (const row of batch) {
      try {
        await db().query(UPSERT_SQL, [row.userId, row.meter, row.period, row.used, row.tokens, row.venues]);
      } catch (err) {
        logFailure('a meter write', err);
      }
    }
  } finally {
    flushing = false;
    if (pending.size > 0) scheduleFlush();
  }
}

/**
 * Record one meter row's new absolute value. Called by the meters on every
 * change; a no-op until hydrate() has succeeded (see the header).
 *
 * @param {{userId: number, meter: 'forecast'|'birdie', period: string,
 *          used: number, tokens: number, venues: string[]}} row
 */
function persist(row) {
  if (!enabled) return;
  pending.set(`${row.userId}|${row.meter}|${row.period}`, row);
  scheduleFlush();
}

/** Write whatever is waiting now. Shutdown calls this before the pool closes. */
async function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  // A batch already in flight finishes on its own; wait for it, then write
  // what arrived meanwhile. Bounded, because shutdown has its own deadline.
  for (let i = 0; i < 40 && (flushing || pending.size > 0); i += 1) {
    if (flushing) await new Promise((r) => setTimeout(r, 25));
    else await flush();
  }
}

function schedulePrune() {
  if (pruneTimer) return;
  const run = () => {
    Promise.resolve()
      .then(() => db().query(PRUNE_SQL, [KEEP_DAYS]))
      .catch((err) => logFailure('the meter prune', err));
  };
  run();
  pruneTimer = setInterval(run, PRUNE_EVERY_MS);
  if (pruneTimer.unref) pruneTimer.unref();
}

/**
 * Load this period's rows into the meters and turn writes on. Never throws: a
 * failure leaves the meters enforcing from memory and schedules a retry.
 *
 * A retry merges rather than replaces (each meter's __hydrate keeps the larger
 * count), so a count that grew in memory while the database was unreachable is
 * never lowered by the older stored value.
 *
 * @returns {Promise<boolean>} true once writes are on
 */
async function hydrate() {
  if (enabled) return true;
  const month = monthKey();
  const day = dayKey();
  try {
    const r = await db().query(SELECT_SQL, [month, day]);
    const rows = r && Array.isArray(r.rows) ? r.rows : [];
    // Required here rather than at the top: both meters require this file.
    const forecastUsage = require('./forecastUsage');
    const birdieUsage = require('./birdieUsage');
    let loaded = 0;
    for (const row of rows) {
      const took = row.meter === 'forecast' ? forecastUsage.__hydrate(row)
        : row.meter === 'birdie' ? birdieUsage.__hydrate(row)
          : false;
      if (took) loaded += 1;
    }
    enabled = true;
    if (hydrateRetry) {
      clearTimeout(hydrateRetry);
      hydrateRetry = null;
    }
    console.log(`[usage-meters] loaded ${loaded} meter row(s) for ${month} and ${day}; meters are kept across restarts`);
    schedulePrune();
    return true;
  } catch (err) {
    console.error('[usage-meters] could not load the stored meters. The free-tier meters enforce from memory only, and reset on the next restart, until a retry succeeds:', err?.message || err);
    if (!hydrateRetry) {
      hydrateRetry = setTimeout(() => {
        hydrateRetry = null;
        hydrate();
      }, RETRY_HYDRATE_MS);
      if (hydrateRetry.unref) hydrateRetry.unref();
    }
    return false;
  }
}

function isEnabled() {
  return enabled;
}

// Tests only. Production never turns persistence back off.
function __reset() {
  enabled = false;
  pending.clear();
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (hydrateRetry) clearTimeout(hydrateRetry);
  hydrateRetry = null;
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = null;
  flushing = false;
  lastFailureLog = 0;
}

module.exports = {
  persist,
  flushNow,
  hydrate,
  isEnabled,
  KEEP_DAYS,
  __reset,
};
