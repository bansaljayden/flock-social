// ---------------------------------------------------------------------------
// Saying when a refusal lifts, in one place.
//
// WHY THIS FILE EXISTS. A 429 that names the wrong window is worse than one
// that names no window at all. The person follows the advice, comes back at the
// time they were given, is refused a second time, and concludes the feature is
// broken rather than that they were throttled. The audit that produced this
// module found "Loading venues too fast. Give it a few seconds." sitting on a
// budget of 30 calls per ROLLING HOUR, and "Give it a minute." on a counter
// that resets once an hour. Both were advice that could not work.
//
// THE RULE THE ROUTES FOLLOW. Prefer telling the caller WHEN the limit resets
// over guessing an adjective. Where a route cannot know which of several legs
// refused it, it must say something that is true of all of them rather than
// pick the friendliest one.
//
// Every refusal that uses this should carry three things:
//   * a sentence built with waitPhrase(), so a human reads a real window;
//   * `retryAfterSeconds` and `resetsAt` in the body, so a client can act;
//   * the `Retry-After` header, via setRetryAfter(), which is the only one of
//     the three that an <img> tag or a background fetch can see.
//
// PRECEDENTS THIS GENERALISES: routes/sensors.js already sets Retry-After,
// routes/safety.js already computes the minutes left, routes/ai.js already
// returns a resetsAt, and routes/venueDashboard.js names the minute and the day
// on the owner-report caps.
//
// ROUND, NEVER TRUNCATE DOWN. Every number here is rounded UP or to the nearest
// whole unit above a floor, because a wait reported short is the same defect
// this module exists to remove: the caller returns early and is refused again.
// ---------------------------------------------------------------------------

const MINUTE_MS = 60 * 1000;

/**
 * Seconds for the `Retry-After` header. Always at least 1, because a header of
 * 0 tells a client to retry immediately into the same refusal.
 *
 * @param {number} ms  milliseconds until the limit frees a unit
 * @returns {number} whole seconds, at least 1
 */
function retryAfterSeconds(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.ceil(n / 1000));
}

/**
 * An ISO timestamp for when the limit frees a unit, for clients that would
 * rather compute their own countdown than parse a sentence.
 *
 * @param {number} ms
 * @returns {string} ISO 8601
 */
function resetsAtISO(ms) {
  const n = Number.isFinite(Number(ms)) ? Math.max(0, Number(ms)) : 0;
  return new Date(Date.now() + n).toISOString();
}

/**
 * The human half. Returns a phrase that completes a sentence like
 * "You can search again ___." and never over-promises.
 *
 * Deliberately vague at the edges and never vague in the middle: "in about 12
 * minutes" is worth saying, "in about 47 hours" is not, and neither is a
 * seconds-level countdown on a window measured in hours.
 *
 * @param {number} ms  milliseconds until the limit frees a unit
 * @returns {string}
 */
function waitPhrase(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 'in a moment';
  const seconds = Math.ceil(n / 1000);
  if (seconds <= 60) return 'in under a minute';
  const minutes = Math.ceil(n / MINUTE_MS);
  if (minutes === 1) return 'in about a minute';
  if (minutes < 45) return `in about ${minutes} minutes`;
  if (minutes < 90) return 'in about an hour';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in about ${hours} hours`;
  const days = Math.round(minutes / (60 * 24));
  return days <= 1 ? 'in about a day' : `in about ${days} days`;
}

/**
 * Set the header. Separated from the body so a route that answers with an image
 * or an empty payload can still say when to come back.
 *
 * @param {import('express').Response} res
 * @param {number} ms
 */
function setRetryAfter(res, ms) {
  res.set('Retry-After', String(retryAfterSeconds(ms)));
}

/**
 * The whole refusal, for the common case: set the header and return the body
 * fields a JSON 429 should carry alongside its sentence.
 *
 * @param {import('express').Response} res
 * @param {number} ms
 * @param {string} error  the sentence, already built with waitPhrase()
 * @returns {{error: string, retryAfterSeconds: number, resetsAt: string}}
 */
function refusalBody(res, ms, error) {
  setRetryAfter(res, ms);
  return {
    error,
    retryAfterSeconds: retryAfterSeconds(ms),
    resetsAt: resetsAtISO(ms),
  };
}

/**
 * Milliseconds until the next UTC midnight. Several counters in this codebase
 * roll on a FIXED UTC day (utils/placesBudget.js GLOBAL_DAILY, the Ticketmaster
 * day in routes/events.js, the photo day brake in services/photoStore.js), and
 * "tomorrow" is the wrong word for a boundary that lands in the evening for a
 * US caller.
 *
 * @returns {number}
 */
function msUntilUtcMidnight() {
  const now = new Date();
  const next = Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0
  );
  return Math.max(1, next - now.getTime());
}

/**
 * Milliseconds until the first of the next month, UTC. The photo budget in
 * services/photoStore.js is denominated per calendar month, and no phrase built
 * from hours is true about it.
 *
 * @returns {number}
 */
function msUntilUtcMonthStart() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  return Math.max(1, next - now.getTime());
}

module.exports = {
  retryAfterSeconds,
  resetsAtISO,
  waitPhrase,
  setRetryAfter,
  refusalBody,
  msUntilUtcMidnight,
  msUntilUtcMonthStart,
};
