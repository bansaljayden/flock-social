// ---------------------------------------------------------------------------
// Outbound HTTP timeouts (round 12).
//
// Audit finding: image moderation was the ONLY outbound call with a timeout.
// Node's fetch (undici) applies no request deadline of its own, so a hung
// socket sits open for roughly five minutes. Every one of those minutes an
// Express connection and — in every handler that queries the database around
// the call — one of the 20 pg pool slots is parked. That is how a brownout at
// Google Places took down endpoints that never touch Google Places.
//
// Budgets are deliberately shorter than any client-side patience: a user would
// rather see "couldn't reach it, try again" than a spinner.
//
// ---------------------------------------------------------------------------
// AN ABORTED PAID REQUEST STILL COSTS MONEY. Read this before adding a retry.
// ---------------------------------------------------------------------------
// Aborting is a local act. By the time our deadline fires, Google, Ticketmaster
// or Resend has already received, parsed and metered the request; hanging up on
// the response does not un-bill it. So for the PAID upstreams below:
//
//   * Charge the budget BEFORE the fetch, never after. utils/placesBudget.js
//     works this way on purpose — a charge-on-success design undercounts
//     exactly when the upstream is sick and our request rate is highest.
//   * NEVER retry a paid call after a timeout. A retry is a second invoice for
//     a question we already paid to ask, and a slow upstream is precisely when
//     retries pile up. routes/events.js has a Ticketmaster fallback fetch after
//     a failed first call: that is a deliberate second charge, and it is the
//     only one in the codebase. Do not add more.
//   * A timeout is therefore a LOSS, not a free operation. Timeouts belong in
//     the same mental column as errors when someone reads the Google invoice
//     and the request log disagree.
//
// PAID vs FREE, per key below:
//   places       PAID, per request: Text Search, Place Details, Nearby Search,
//                and the photo proxy's FIRST leg (the /media metadata call).
//                The second leg fetches bytes from Google's CDN using the
//                returned photoUri; that is believed not to be separately
//                metered, but confirm against an invoice before relying on it
//                to size a `cost` — if it is metered, the photo proxy costs 2.
//   ticketmaster PAID above the free daily quota.
//   weather      PAID above OpenWeatherMap's free daily allowance.
//   gemini       PAID per token.
//   email        PAID per send above the Resend free tier.
//   oauth        free (Google/Apple token + userinfo endpoints).
//
// ---------------------------------------------------------------------------
// ABORT CLEANUP: what actually happens.
// ---------------------------------------------------------------------------
// * Socket: undici destroys the underlying socket when the signal aborts, and
//   the in-flight request is removed from the connection pool. No socket leak,
//   and no half-read response left parked on a keep-alive connection.
// * Timer: AbortSignal.timeout() schedules ONE timer that lives until it fires,
//   even when the fetch settles first. That timer is unref'd by Node, so it
//   never holds the event loop open and never delays shutdown; the cost is
//   bounded memory — at most (requests in the last `ms`) pending timers, which
//   at this app's traffic is a rounding error. This is a deliberate trade: the
//   alternative (an AbortController plus a clearTimeout after `await fetch`)
//   clears the timer at the wrong moment, because `await fetch()` resolves as
//   soon as the RESPONSE HEADERS arrive. The body is still streaming at that
//   point, and every caller in this codebase then does `await response.json()`
//   or `await response.arrayBuffer()`. Clearing the deadline there would leave
//   the body read undeadlined and re-open exactly the hang this file exists to
//   close. The signal must outlive the fetch call, so it does.
// * The abort surfaces as a rejected promise (TimeoutError / AbortError), which
//   means every call site MUST have the fetch inside its try/catch. Returning
//   `null` or a 503 from that catch is the honest answer; swallowing it into a
//   success shape is not.
//
// A typo in the kind throws rather than silently returning no deadline. Failing
// closed is right: a missing deadline is the bug this module exists to prevent,
// and a thrown error inside a route's try/catch is a 500 someone will notice.
// ---------------------------------------------------------------------------

const UPSTREAM_TIMEOUT_MS = Object.freeze({
  places: 6000,        // Google Places (search, details, photo proxy)
  weather: 6000,       // OpenWeatherMap
  ticketmaster: 6000,  // Ticketmaster Discovery
  oauth: 6000,         // Google / Apple token + userinfo endpoints
  gemini: 12000,       // Gemini generation is genuinely slower
  // ROOST'S OWN DEADLINE, and the reason it is not the one above. Birdie runs
  // on a non-thinking model and answers well inside twelve seconds. Roost runs
  // on gemini-3.7-flash, which reasons before it writes, and the reasoning is
  // where the time goes: measured 2026-08-20, an ordinary advice question
  // spends about nine hundred thinking tokens and a hard one nearly two
  // thousand, which put a real question ("is it safe to serve milk that has
  // been out for three hours") past twelve seconds and returned the owner a
  // refusal that blamed itself for being busy. The trade the header above
  // describes still applies: this parks a connection and a pool slot for
  // longer. It is affordable here and nowhere else, because this surface is
  // Pro-gated, has its own rate limiter at ten an hour per account, and is
  // reached by a person who deliberately typed a question and is watching for
  // the answer. Do not point Birdie or anything user-facing at this key.
  geminiAdvisor: 30000,
  email: 8000,         // Resend
  // Image moderation + link unfurling. utils/moderation.js still hardcodes
  // AbortSignal.timeout(15000) rather than reading this; the value is recorded
  // here so the table is a complete inventory of outbound deadlines, and that
  // file should be migrated to upstreamSignal('moderation') so a future change
  // happens in one place.
  moderation: 15000,
});

// Usage: fetch(url, { signal: upstreamSignal('places') })
// The signal must be created per request — AbortSignal.timeout starts counting
// the moment it is constructed, so a module-level constant would be expired.
function upstreamSignal(kind) {
  const ms = UPSTREAM_TIMEOUT_MS[kind];
  if (!ms) throw new Error(`upstreamSignal: unknown upstream "${kind}"`);
  return AbortSignal.timeout(ms);
}

module.exports = { UPSTREAM_TIMEOUT_MS, upstreamSignal };
