// ---------------------------------------------------------------------------
// ONE RAW PLACE DETAILS RESPONSE PER VENUE, SHARED BY EVERY CONSUMER OF IT.
// ---------------------------------------------------------------------------
// THE BILL THIS FILE EXISTS TO HALVE. Opening one venue's detail screen used to
// make TWO paid Enterprise Place Details calls for the SAME place id, in the
// same tick. frontend/src/App.js openVenueDetail fires getVenueDetails and
// getCrowdPrediction inside one Promise.allSettled; the first landed on
// routes/venueSearch.js runPlaceDetails and the second on routes/crowd.js
// fetchVenueFromGoogle. The second mask was a STRICT SUBSET of the first
// (crowd asked for id, displayName, formattedAddress, rating, userRatingCount,
// priceLevel, types, location, currentOpeningHours, utcOffsetMinutes; details
// asked for all ten plus nationalPhoneNumber, websiteUri, photos and
// googleMapsUri), so the second call bought nothing the first had not already
// paid for. They cached separately — 5 minutes on place id in venueSearch,
// 10 minutes on place id PLUS hour in crowd — and each charged
// utils/placesBudget.js. Place Details at Enterprise is $20 per 1,000 and is
// the biggest non-photo line on the Places bill; collapsing the pair onto one
// cached raw response halves it. See the header of services/costModel.js, which
// found and priced this, and __tests__/placeDetailsSharedCache.test.js, which
// pins it.
//
// WHY A CACHE ALONE WOULD NOT HAVE DONE IT, and why the in-flight map below is
// the load-bearing half. The two requests are CONCURRENT: the client fires them
// together, so the second one reaches the server before the first one's Google
// response has come back, and a plain TTL cache is still empty when it looks.
// Deduplication has to happen on the FLIGHT, not just on the result — the
// follower rides the leader's promise and neither pays twice. This is the same
// shape routes/venueSearch.js already used for its own photo and search
// coalescing (round 18); what is new is that the flight is now shared ACROSS
// route files, which is the only place the duplicate could be seen from.
//
// NO FIELD MASK CHANGED, WHICH IS THE POINT. PLACE_DETAILS_FIELD_MASK below is
// byte-for-byte routes/venueSearch.js's old DETAILS_FIELD_MASK — the superset —
// so every field either consumer read before is still fetched, and the three
// TRAINED MODEL COLUMNS (`rating`, `userRatingCount`, `priceLevel`, which
// services/mlPredictor.js buildFeatureMap emits as `rating`, `price_level`,
// `review_count` and `log_review_count`) are untouched. buildFeatureMap fills a
// missing input with the CORPUS MEDIAN rather than failing, so a mask change
// here would not break a screen, it would silently score every venue as a
// 4.0-star, mid-priced, zero-review venue. That has shipped twice already
// (badge.js round 10, venueDashboard.js round 20). This change moves WHERE the
// mask lives, not what is in it, and __tests__/placesFieldMaskModelInputs.test.js
// now sweeps services/ as well as routes/ so it still covers this file.
//
// ---------------------------------------------------------------------------
// THE KEY: PLACE ID ALONE. WHY THE HOUR CAME OUT OF IT.
// ---------------------------------------------------------------------------
// routes/crowd.js keys its own cache `full:${placeId}:${localHour}:${localDay}`.
// That hour is REAL and it stays where it is — but it was never protecting the
// Places payload, it protects the DERIVED PREDICTION, which is a function of
// the hour and genuinely differs between 8 PM and 9 PM. Nothing Google returns
// under this mask varies with the hour it was asked at:
//
//   immutable per venue   id, displayName, formattedAddress, location, types,
//                         utcOffsetMinutes, googleMapsUri, nationalPhoneNumber,
//                         websiteUri, photos (the refs, not the bytes)
//   slow moving           rating, userRatingCount, priceLevel — the model
//                         inputs. A venue's star average and review count move
//                         over days and weeks; its price band over years.
//   time sensitive        currentOpeningHours, and only half of it.
//                         `.periods` is a WEEKLY schedule: day-shaped, not
//                         hour-shaped, and the closed-hours zeroing, the hours
//                         list and crowdEngine.isOpenAt all read it rather than
//                         the boolean. `.openNow` is the single field Google
//                         computes at request time, so it is the only thing in
//                         the payload that can be wrong by the age of a cache
//                         entry.
//
// So the payload is keyed on place id and nothing else, and the hour stays on
// the prediction cache that needs it. The practical consequence is the one the
// old key cost: crowd's payload MISSED ON EVERY HOUR BOUNDARY, re-buying an
// identical Places response because the clock had rolled.
//
// TTL = 10 MINUTES, and openNow is what bounds it. Ten is not a new tolerance:
// routes/crowd.js has always served `isOpen` up to ten minutes stale from its
// own cache, on the same screen, for the same venue. What changes is that the
// detail card's opening-hours block now shares that ten rather than its own
// five. Everything else in the payload is slower-moving than either number by
// orders of magnitude. Do NOT raise this to hours to buy more cache hits: the
// saving is already taken by the in-flight coalescing above (the duplicate pair
// is simultaneous), and every additional minute is spent entirely on openNow
// being wrong.
//
// ---------------------------------------------------------------------------
// THE LEDGER: CHARGED ONCE PER REAL UPSTREAM FETCH, NEVER ON A HIT.
// ---------------------------------------------------------------------------
// This module does NOT charge utils/placesBudget.js itself, deliberately. The
// two callers charge different ceilings for different reasons — routes/crowd.js
// charges 1 for the card and 2 for /alternatives (Details + Text Search), and
// venueSearch charges 1 — and a module that charged on their behalf would have
// to know all of that. What it owns instead is the ONE question they cannot
// answer for themselves: `willCostUpstreamCall(placeId)`, true exactly when
// fetchPlaceDetails would issue a new paid Google request. A caller charges when
// that is true and does not when it is false, which is placesBudget's own rule
// ("cache hits must be answered before the charge... charging for a call you did
// not make masks the real burn rate") applied one level up.
//
// THAT ANSWER IS ONLY VALID FOR THE REST OF THE CURRENT TICK. willCostUpstreamCall
// is synchronous and so is the registration of a flight inside fetchPlaceDetails
// (an async function runs its body up to the first `await` synchronously at call
// time). Callers therefore go ask -> charge -> fetch with NO await in between,
// exactly as routes/venueSearch.js already did between its cache read and its
// flight registration. Node runs one turn at a time, so nothing can interleave.
// Put an await between the question and the fetch and the answer becomes a
// guess.
//
// A FAILED FETCH IS NEVER CACHED. Neither a Google `error` body nor a network
// failure nor an upstreamSignal abort writes an entry, so the next request
// retries rather than being served a poisoned negative for ten minutes. The
// flight is drained either way. The LEDGER charge for a failed call is NOT
// refunded, and that is correct: utils/upstream.js says Google bills a request
// it received even when we abort it on timeout, so a charge-on-success design
// undercounts precisely when things are going wrong.
// ---------------------------------------------------------------------------

// WHO SHARES THIS, AND WHO DELIBERATELY DOES NOT. The two consumers are
// routes/venueSearch.js GET /details and routes/crowd.js, which are the two
// halves of one screen and both charge allowPlacesSearch against the SAME
// authenticated user. routes/badge.js, routes/publicCrowd.js and the Birdie
// tool in routes/ai.js also fetch Place Details, and they are NOT wired in here
// — not because it would not save calls, but because it would move money across
// a line utils/placesBudget.js draws on purpose. The first two charge
// allowGlobalPlacesCall, which enforces UNAUTH_DAILY (M5-1): the reserve that
// keeps unauthenticated traffic from spending the signed-in product's day. A
// shared cache between the two ledgers means an unauthenticated request can be
// served a payload an account paid for and vice versa, so the reserve stops
// being an accounting fact. If that is ever wanted it needs its own argument
// about which ledger a cache hit belongs to, not an extra import.
const { upstreamSignal } = require('../utils/upstream');

// The union of everything any consumer of a Place Details response reads. This
// is routes/venueSearch.js's former DETAILS_FIELD_MASK unchanged; routes/crowd.js
// asked for a strict subset of it, which is why one call can serve both.
//
// BILLING: every one of rating, userRatingCount, priceLevel and
// currentOpeningHours is an ENTERPRISE field, so this request bills at Place
// Details $20 per 1,000 against a 1,000-call monthly free allowance rather than
// the Pro $17 and 5,000. That is priced, argued and REFUSED in the header of
// services/costModel.js: three of the four are trained model columns and the
// fourth drives the closed-hours zeroing. utcOffsetMinutes, nationalPhoneNumber,
// websiteUri, googleMapsUri and photos are Pro or below and are therefore free
// riders on a mask that already reaches Enterprise. THE RULE FOR THE NEXT EDIT
// is venueSearch's: adding a field costs nothing only while the mask already
// contains something of an equal or higher tier.
const PLACE_DETAILS_FIELD_MASK = [
  'id', 'displayName', 'formattedAddress', 'nationalPhoneNumber', 'websiteUri',
  'rating', 'userRatingCount', 'priceLevel', 'photos', 'currentOpeningHours',
  'types', 'location', 'googleMapsUri', 'utcOffsetMinutes',
].join(',');

// See the TTL argument in the header. Bounded by `currentOpeningHours.openNow`,
// which is the only field Google computes at request time.
const PLACE_DETAILS_TTL = 10 * 60 * 1000;

// Entries are small JSON objects (a few KB with photo refs), and the thing that
// costs money is dropping one, not keeping it. The cap is sized the way
// venueSearch's VENUE_CACHE_MAX is: against what ONE ACCOUNT can mint. Every
// write here is behind one allowPlacesSearch unit, and PER_USER_HOURLY is 30
// against a 10-minute TTL, so a single account can hold at most 30 live entries
// however hard it tries — two orders of magnitude below this ceiling. One
// caller cannot evict the shared working set, which is the property
// __tests__/cacheKeyInventory.js exists to make somebody argue for.
const PLACE_DETAILS_CACHE_MAX = 500;
const PLACE_DETAILS_CACHE_LOW_WATER = Math.floor(PLACE_DETAILS_CACHE_MAX * 0.9);

// placeId -> { place, ts }. Only successful fetches are ever written.
const detailsCache = new Map();
// placeId -> Promise<result>. Self-draining; the worker never rejects.
const detailsInflight = new Map();

function readFresh(placeId) {
  const entry = detailsCache.get(placeId);
  if (!entry) return null;
  if (Date.now() - entry.ts >= PLACE_DETAILS_TTL) {
    detailsCache.delete(placeId);
    return null;
  }
  return entry.place;
}

function write(placeId, place) {
  // Delete before set so a refresh moves the entry to the END of the insertion
  // order. Without it, Map keeps the original position and the oldest-first
  // eviction below deletes the hottest venue in the process.
  detailsCache.delete(placeId);
  detailsCache.set(placeId, { place, ts: Date.now() });
  if (detailsCache.size <= PLACE_DETAILS_CACHE_MAX) return;
  const now = Date.now();
  for (const [k, v] of detailsCache) {
    if (now - v.ts >= PLACE_DETAILS_TTL) detailsCache.delete(k);
  }
  // Evict to a low-water mark rather than to exactly the ceiling, so a full
  // cache does not pay a scan on every single insert.
  while (detailsCache.size > PLACE_DETAILS_CACHE_LOW_WATER) {
    detailsCache.delete(detailsCache.keys().next().value);
  }
}

/**
 * Would calling fetchPlaceDetails(placeId) right now issue a NEW paid Google
 * request? True exactly when the caller must charge utils/placesBudget.js
 * first; false when a fresh cache entry or an existing in-flight fetch will
 * serve it for nothing.
 *
 * SYNCHRONOUS, AND ONLY TRUE FOR THIS TICK. Call it, charge, and call
 * fetchPlaceDetails with no `await` in between. See the header.
 *
 * @param {string} placeId
 * @returns {boolean}
 */
function willCostUpstreamCall(placeId) {
  if (detailsInflight.has(placeId)) return false;
  return readFresh(placeId) === null;
}

// The worker. NEVER REJECTS — every exit is a result object — because the
// in-flight map is drained with `.then()` and a rejecting worker would both
// leak an entry and hand every follower an unhandled rejection.
//
// The result is a discriminated union rather than a bare null, because the two
// callers need different things from a failure and they always did:
// routes/venueSearch.js answered a Google `error` body with 502 "Places API:
// <message>" and anything else with 500, while routes/crowd.js turned both into
// null (and then a 502). Collapsing them here would have quietly changed one of
// those, which is the kind of thing a "pure refactor" ships by accident.
async function fetchOnce(placeId) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return { ok: false, kind: 'unconfigured', message: 'Google Places API key not configured' };

  let p;
  try {
    // ENCODED, one path segment always. Both former call sites did this and
    // both explained why: `placeId` reaches them percent-DECODED by Express, so
    // interpolating it raw lets a `/`, `?` or `#` rewrite the path or query of
    // a request carrying our server-restricted API key. Callers shape-check the
    // id before they get here (utils/places.js isPlaceIdShaped), but this
    // function is not a route handler and nothing in its signature says its
    // argument was validated, so it defends itself.
    const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': PLACE_DETAILS_FIELD_MASK,
      },
      // Round 12: no deadline meant a hung Google socket parked the request and
      // its pg pool slot for ~5 minutes. See utils/upstream.js.
      signal: upstreamSignal('places'),
    });
    p = await response.json();
  } catch (err) {
    // An upstreamSignal abort REJECTS the fetch, and a non-JSON body from a
    // proxy throws here too. Both are Google failing rather than this server.
    console.error('[PlaceDetails] upstream unreachable:', err.message);
    return { ok: false, kind: 'unreachable', message: err.message };
  }

  if (!p) return { ok: false, kind: 'unreachable', message: 'empty response body' };
  if (p.error) return { ok: false, kind: 'api', message: p.error.message };

  // Cached only here, on the success path. A failure above returns without
  // writing, so the next request retries instead of being served a poisoned
  // negative for the rest of the TTL.
  write(placeId, p);
  return { ok: true, place: p };
}

/**
 * The raw Places Details payload for one place id, from cache, from an existing
 * in-flight fetch, or from Google.
 *
 * Does NOT charge utils/placesBudget.js — ask willCostUpstreamCall() first and
 * charge yourself. See the header for why the charge lives in the callers.
 *
 * @param {string} placeId
 * @returns {Promise<{ok: true, place: object} | {ok: false, kind: string, message: string}>}
 *   Never rejects.
 */
function fetchPlaceDetails(placeId) {
  const cached = readFresh(placeId);
  if (cached) return Promise.resolve({ ok: true, place: cached });

  let flight = detailsInflight.get(placeId);
  if (!flight) {
    flight = fetchOnce(placeId);
    detailsInflight.set(placeId, flight);
    // Drain on settle. fetchOnce never rejects, so this cannot leak.
    flight.then(() => detailsInflight.delete(placeId));
  }
  return flight;
}

module.exports = {
  willCostUpstreamCall,
  fetchPlaceDetails,
  PLACE_DETAILS_FIELD_MASK,
  PLACE_DETAILS_TTL,
  PLACE_DETAILS_CACHE_MAX,
  PLACE_DETAILS_CACHE_LOW_WATER,
};

// Tests only. Production code must never clear a cache that stands in front of
// a paid API — the entries ARE the saving.
module.exports.__test = {
  reset() {
    detailsCache.clear();
    detailsInflight.clear();
  },
  size: () => detailsCache.size,
  inflightSize: () => detailsInflight.size,
};
