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
// ---------------------------------------------------------------------------

const UPSTREAM_TIMEOUT_MS = {
  places: 6000,        // Google Places (search, details, photo proxy)
  weather: 6000,       // OpenWeatherMap
  ticketmaster: 6000,  // Ticketmaster Discovery
  oauth: 6000,         // Google / Apple token + userinfo endpoints
  gemini: 12000,       // Gemini generation is genuinely slower
  email: 8000,         // Resend
};

// Usage: fetch(url, { signal: upstreamSignal('places') })
// The signal must be created per request — AbortSignal.timeout starts counting
// the moment it is constructed, so a module-level constant would be expired.
function upstreamSignal(kind) {
  const ms = UPSTREAM_TIMEOUT_MS[kind];
  if (!ms) throw new Error(`upstreamSignal: unknown upstream "${kind}"`);
  return AbortSignal.timeout(ms);
}

module.exports = { UPSTREAM_TIMEOUT_MS, upstreamSignal };
