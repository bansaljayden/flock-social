const express = require('express');
const { query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { upstreamSignal } = require('../utils/upstream');
// The one shape rule for a Google place id. routes/checkin.js, flocks.js,
// feedback.js, venueProfile.js, venueDashboard.js, sockets/handlers.js and
// routes/crowd.js all gate on this; /details was the last paid Places surface
// that did not (see the block above it).
const { isPlaceIdShaped } = require('../utils/places');
// Per-user Places budget: 30/hour fresh calls, 3000/day globally. Shared with
// crowd.js and ai.js so every paid Places fetch draws from the SAME pool
// (round 8). allowGlobalPlacesCall is the door for surfaces with no
// authenticated user to charge — here, the public photo proxy (round 15).
// PER_USER_HOURLY and GLOBAL_DAILY are imported, not retyped: two numbers in
// this file are sized AGAINST them (VENUE_CACHE_MAX and PUBLIC_PHOTO_BUDGET)
// and a copied constant is an inequality that silently stops holding.
const {
  allowPlacesSearch, allowGlobalPlacesCall, PER_USER_HOURLY, GLOBAL_DAILY,
} = require('../utils/placesBudget');

const router = express.Router();

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// Upstream budget for the UNAUTHENTICATED photo proxy: cache misses cost a
// Google call, so one client cannot burn the quota (round 6). Cache hits are
// free and never counted.
const photoIpHits = new Map();
let photoDayKey = new Date().toISOString().slice(0, 10);
let photoDayCount = 0;
// ---------------------------------------------------------------------------
// PUBLIC_PHOTO_BUDGET, and why 4000 was not a ceiling (round 23).
// ---------------------------------------------------------------------------
// This was 4000 against a GLOBAL_DAILY of 3000. A sub-ceiling ABOVE the ceiling
// it sits under never binds: the effective limit on this unauthenticated door
// was the whole shared Places day, so 10 addresses at the 300/hour per-IP rate
// could spend every paid Google call the authenticated product had for the rest
// of the UTC day, in about an hour. The per-IP dimension existed; the thing it
// was supposed to be a fraction OF did not.
//
// THE PIN: PUBLIC_PHOTO_BUDGET (1500) < GLOBAL_DAILY (3000). Half the day, so
// the photo proxy can never starve venue search, the crowd card, the owner
// dashboard or Birdie — the four surfaces that charge the same ledger with a
// real user behind them. Pinned by __tests__/placesProxyAbuse.test.js against
// both files' real numbers.
const PUBLIC_PHOTO_BUDGET = 1500;
function allowPhotoFetch(req) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== photoDayKey) { photoDayKey = today; photoDayCount = 0; }
  if (photoDayCount >= PUBLIC_PHOTO_BUDGET) return false;
  const now = Date.now();
  const ip = req.ip || 'unknown';
  const hits = (photoIpHits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (hits.length >= 300) return false;
  hits.push(now);
  photoIpHits.set(ip, hits);
  if (photoIpHits.size > 5000) prunePhotoIpHits(now, ip);
  photoDayCount++;
  return true;
}

// Round 18: this was `if (size > 5000) photoIpHits.clear()` — the exact
// "one caller can reset shared state for everyone" shape utils/probeBudget.js
// and utils/placesBudget.js both refuse, reachable here by anyone who can show
// up from enough addresses: flood the table past its ceiling and every
// throttled address, your own included, gets a fresh 300/hour. Prune expired
// hits first, then evict LEAST CONSUMED first (a flood entry has one hit; an
// address that has spent its whole allowance is the last to go, so the flood
// cleans up after itself instead of laundering the flooder's counter). Evict
// to a low-water mark, not the ceiling, so a full table does not pay a scan
// and sort on every request.
function prunePhotoIpHits(now, keepIp) {
  for (const [k, v] of photoIpHits) {
    const live = v.filter((t) => now - t < 3600_000);
    if (live.length === 0) photoIpHits.delete(k);
    else if (live.length !== v.length) photoIpHits.set(k, live);
  }
  if (photoIpHits.size <= 5000) return;
  const bySpend = [...photoIpHits.entries()].sort((a, b) => a[1].length - b[1].length);
  for (const [k] of bySpend) {
    if (photoIpHits.size <= 4500) break;
    if (k === keepIp) continue;
    photoIpHits.delete(k);
  }
}

// In-memory photo cache (avoids re-fetching from Google on every page load)
const photoCache = new Map();
const PHOTO_CACHE_TTL = 60 * 60 * 1000; // 1 hour
const MAX_PHOTO_CACHE = 500;

// In-flight coalescing (round 18). The caches above only help requests that
// arrive AFTER the first one has finished; N concurrent requests for the same
// uncached key were N budget charges and N paid Google calls — a hot venue's
// photo cost one metadata call per viewer in the gap. The first request to
// find neither a cache entry nor a flight (the leader) pays the budget and
// makes the call; everyone else awaits the same promise. Sound because the
// route code from cache check to flight registration is synchronous — Node
// runs one turn at a time, so a second request cannot interleave into that
// window. The worker functions NEVER reject: they resolve to a
// { status, ... } descriptor, so awaiting a flight cannot throw into a
// follower and the cleanup .then() cannot leak an unhandled rejection.
// Entries are deleted the moment they settle, so a failure is never pinned —
// the next request after a failed flight goes back upstream.
const inflight = new Map();      // search:/detail: cacheKey -> Promise<descriptor>
const photoInflight = new Map(); // photo cacheKey -> Promise<descriptor>

// A Google photo resource name is exactly `places/{place}/photos/{photo}` and
// nothing else. `ref` was bounded only by "at least one character" and was then
// interpolated raw into the /media URL this proxy builds around our API key, so
// a ref carrying `?` or `#` rewrote that URL's query string (dropping the key
// and the size, and turning a paid metadata call into a guaranteed error), extra
// `/` segments reached a different Google path entirely, and an unbounded ref
// became an unbounded photoCache key.
//
// Structural rather than a charset guess, deliberately: the two segments may
// hold whatever alphabet Google mints a photo name from, but they may not add
// path segments, open a query string or fragment, or walk with `..`. Same
// principle as isPlaceIdShaped one route below — a paid Google call must not be
// spent on a string that cannot be a real name.
//
// The photo token is generously bounded (Google mints long ones and a false 400
// here is a missing image on every card); the length only keeps the photoCache
// key finite. The STRUCTURE is what does the work. Every ref this proxy is ever
// asked for was minted by us from `place.photos[].name` — photoUrl() below,
// routes/ai.js and routes/publicCrowd.js all build the same URL — and the repo
// has never called the legacy Places API, so there is no older `photoreference`
// shape to grandfather.
const PHOTO_REF_RE = /^places\/[^/?#]{1,128}\/photos\/[^/?#]{1,2048}$/;
function isPhotoRefShaped(ref) {
  if (typeof ref !== 'string' || !PHOTO_REF_RE.test(ref)) return false;
  const segments = ref.split('/');
  return !segments.includes('..') && !segments.includes('.');
}

// Photo proxy — streams image bytes through our server so the browser
// never has to follow a cross-origin redirect (avoids CORP / 401 blocks).
router.get('/photo',
  query('ref').trim().isLength({ min: 1 }).withMessage('Photo ref is required')
    .bail()
    .custom(isPhotoRefShaped).withMessage('Photo ref is not a valid photo name'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      // The validator's own message, so "missing" and "not a photo name" are
      // distinguishable in a log instead of both reading as "Missing photo ref".
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
      if (!API_KEY) return res.status(500).json({ error: 'API key not configured' });

      const photoRef = req.query.ref;
      // Snapped to two sizes: arbitrary maxwidth values let one photo ref mint
      // unlimited cache entries and full-res fetches (round 5). 400 covers
      // cards, 160 covers pins/thumbnails.
      const requested = parseInt(req.query.maxwidth) || 400;
      const maxWidth = requested <= 200 ? 160 : 400;
      const cacheKey = `${photoRef}|${maxWidth}`;

      // Check cache first
      const cached = photoCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < PHOTO_CACHE_TTL) {
        return sendPhoto(res, cached);
      }

      // A concurrent request for the SAME uncached photo rides the existing
      // flight like a cache hit: no per-IP charge, no ledger charge — one
      // Google call is one unit however many viewers share its answer.
      let flight = photoInflight.get(cacheKey);
      if (!flight) {
        if (!allowPhotoFetch(req)) {
          return res.status(429).json({ error: 'Too many photo requests right now' });
        }
        // allowPhotoFetch is a per-IP request limit with its own separate 4000/day
        // counter, which is not the same thing as the shared Places ledger: this
        // proxy is unauthenticated and its first leg (the /media metadata call) is
        // a PAID Places request, so its spend never reached the "global" daily
        // ceiling. Charged before the fetch. Cost 1: only the metadata leg is
        // believed to be metered — the second leg pulls bytes from Google's CDN
        // with the returned photoUri. If an invoice ever shows that leg billed
        // too, this is a 2 (see the note in utils/upstream.js).
        if (!allowGlobalPlacesCall(1)) {
          return res.status(429).json({ error: 'Too many photo requests right now' });
        }
        flight = fetchPhotoOnce(photoRef, maxWidth, cacheKey);
        photoInflight.set(cacheKey, flight);
        flight.then(() => photoInflight.delete(cacheKey));
      }
      const out = await flight;
      if (out.status !== 200) return res.status(out.status).json({ error: out.error });
      sendPhoto(res, out);
    } catch (err) {
      console.error('[Photo Proxy] Error:', err.message, '| ref:', req.query.ref?.slice(0, 60));
      res.status(500).json({ error: 'Failed to fetch photo' });
    }
  }
);

function sendPhoto(res, { buffer, contentType }) {
  res.set('Content-Type', contentType);
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.send(buffer);
}

// The worker behind the photo proxy. Never rejects: resolves to
// { status: 200, buffer, contentType } or { status, error }, so a failure
// reaches every coalesced waiter as the same clean response and is never
// written to photoCache — only a real image is.
async function fetchPhotoOnce(photoRef, maxWidth, cacheKey) {
  try {
    // Step 1: ask Google for the actual CDN url (JSON response)
    const metaUrl = `https://places.googleapis.com/v1/${photoRef}/media?maxWidthPx=${maxWidth}&key=${API_KEY}&skipHttpRedirect=true`;
    // Round 12: both legs of the photo proxy are outbound calls with no
    // deadline of their own — see utils/upstream.js.
    const metaRes = await fetch(metaUrl, { signal: upstreamSignal('places') });
    if (!metaRes.ok) {
      console.error('[Photo Proxy] Google API error:', metaRes.status, 'for ref:', photoRef.slice(0, 60));
      return { status: 502, error: 'Google API error' };
    }
    const meta = await metaRes.json();
    if (!meta.photoUri) {
      console.error('[Photo Proxy] No photoUri in response for ref:', photoRef.slice(0, 60));
      return { status: 404, error: 'Photo not found' };
    }

    // Step 2: fetch the actual image bytes from the CDN
    const imgRes = await fetch(meta.photoUri, { signal: upstreamSignal('places') });
    if (!imgRes.ok) {
      console.error('[Photo Proxy] CDN fetch failed:', imgRes.status, 'for ref:', photoRef.slice(0, 60));
      return { status: 502, error: 'CDN fetch failed' };
    }

    // Step 3: cache and return the image bytes
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

    // Store in cache (evict old entries if too large)
    if (photoCache.size >= MAX_PHOTO_CACHE) {
      const now = Date.now();
      for (const [k, v] of photoCache) {
        if (now - v.ts > PHOTO_CACHE_TTL) photoCache.delete(k);
      }
      // If still too large, delete oldest
      if (photoCache.size >= MAX_PHOTO_CACHE) {
        const firstKey = photoCache.keys().next().value;
        photoCache.delete(firstKey);
      }
    }
    photoCache.set(cacheKey, { buffer, contentType, ts: Date.now() });

    return { status: 200, buffer, contentType };
  } catch (err) {
    console.error('[Photo Proxy] Error:', err.message, '| ref:', photoRef.slice(0, 60));
    return { status: 500, error: 'Failed to fetch photo' };
  }
}

// All other routes require authentication
router.use(authenticate);

// ---------------------------------------------------------------------------
// Server-side venue search cache (5 min TTL), and the number that was wrong.
// ---------------------------------------------------------------------------
// The KEY here is fine and the eviction ORDER is fine. The CAP was the weak
// number. At 200 entries against an ~80-character free-text query space, a few
// hundred unique searches flushed the SHARED cache, and every flushed entry is
// a fresh PAID Google call the next user makes — the eviction half of the
// amplification/eviction pair this repo's inventory is organised around. A
// cache whose ceiling one caller's allowance can reach is not protecting
// anybody but its own memory.
//
// THE PIN: PER_USER_HOURLY * 24 (720) < VENUE_CACHE_MAX (750).
// Every write to this map is behind allowPlacesSearch, one unit per entry
// (runTextSearch and the details worker each charge before they call and each
// write exactly one key), so an account's writes are its Places allowance and
// nothing else. 30/hour spent around the clock is 720 entries in a day, which
// is less than the cache holds: ONE ACCOUNT CANNOT EVICT THE SHARED WORKING SET
// EVEN BY SPENDING EVERY UNIT IT HAS, ALL DAY. Same shape as
// EVENT_USER_DAILY(400) < EVENT_CACHE_MAX(500) in services/mlPredictor.js and
// VISION_USER_DAILY < VISION_GLOBAL_DAILY in utils/visionBudget.js, and pinned
// the same way by a test that reads PER_USER_HOURLY from placesBudget rather
// than retyping 30.
//
// The 24 is deliberately the pessimistic reading. The real figure is far
// smaller: entries live 5 minutes, so what one account can actually hold in a
// live cache is the 30 units its rolling hour allows, not 720. The pin is
// written against the number an attacker could reach if the TTL were removed,
// because the TTL is a freshness decision and someone will change it.
//
// MEMORY. 750 entries is not 750 entries' worth of risk: the cache can never
// hold more than the number of charged calls made inside one 5-minute TTL
// window, and GLOBAL_DAILY caps that at 3000 for the whole day. The ceiling is
// there so eviction is unreachable, not because it is expected to fill.
const venueCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const VENUE_CACHE_MAX = 750;
const VENUE_CACHE_LOW_WATER = Math.floor(VENUE_CACHE_MAX * 0.9);

function getCached(key) {
  const entry = venueCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  if (entry) venueCache.delete(key);
  return null;
}

function setCache(key, data) {
  // Delete first so a refreshed key moves to the END of insertion order.
  // Map.set on an existing key keeps its original position, which would make
  // the oldest-first fallback below evict the most frequently refreshed (i.e.
  // hottest) query. Same fix as services/weatherService.js's setCache.
  venueCache.delete(key);
  venueCache.set(key, { data, ts: Date.now() });
  // Evict old entries if cache grows too large
  if (venueCache.size > VENUE_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of venueCache) {
      if (now - v.ts > CACHE_TTL) venueCache.delete(k);
    }
    // Fresh-but-oversized: evict oldest, down to a low-water mark rather than
    // to exactly the ceiling. Stopping at the ceiling makes a full cache pay a
    // full scan on every write, which is a CPU lever; same rule as
    // utils/probeBudget.js and routes/publicCrowd.js.
    while (venueCache.size > VENUE_CACHE_LOW_WATER) {
      venueCache.delete(venueCache.keys().next().value);
    }
  }
}

// Build photo URL — proxied through our backend so the API key stays server-side
function photoUrl(photoName, maxWidth = 400) {
  return `/api/venues/photo?ref=${encodeURIComponent(photoName)}&maxwidth=${maxWidth}`;
}

// ---------------------------------------------------------------------------
// FIELD MASKS. Hoisted out of the two fetch calls on purpose: they are the most
// expensive one-line decisions in this file (a mask decides the Google SKU the
// request is billed at) and they belong somewhere a reader looks before
// extending them, not buried in a header object. Same shape as
// routes/publicCrowd.js PLACE_FIELDS.
//
// WHY utcOffsetMinutes IS HERE. It is the venue's own UTC offset, and it is what
// makes POST /api/crowd/batch score each row on the VENUE's wall clock instead
// of the viewer's. That endpoint already reads the field off every item in its
// body — but nothing put it there. These results are where the app's vote list
// comes from, so a venue discovered by search arrived with no offset and
// silently fell back to the caller's hour: an LA bar scored at the viewer's
// 11 PM instead of its own 8 PM, while that same bar's detail card (which
// fetches the offset itself — routes/crowd.js fetchVenueFromGoogle) showed the
// right one. The marketing demo has requested it since it was written.
//
// BILLING: NO CHANGE. Places API (New) prices per FIELD and bills a request at
// the HIGHEST SKU any requested field belongs to. utcOffsetMinutes is a **Pro**
// field in both Text Search and Place Details, and both masks below already ask
// for currentOpeningHours / rating / userRatingCount / priceLevel (plus
// nationalPhoneNumber and websiteUri on details) — all **Enterprise**. Both
// requests were already billed at Enterprise, so the marginal cost of this
// field is zero.
//
// THE RULE FOR THE NEXT EDIT: adding a field only ever costs nothing while the
// mask already contains something from an equal or higher tier. Adding an
// Enterprise field to a Pro-only mask, or a Pro field to an Essentials-only
// mask, RAISES what every call on that surface is billed at. Check the tier of
// what you are adding against what is already there before you add it.
// __tests__/venueSearchOffset.test.js pins that both masks still carry an
// Enterprise field, so this note cannot quietly become false.
const SEARCH_FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress', 'places.rating',
  'places.userRatingCount', 'places.priceLevel', 'places.photos', 'places.types',
  'places.currentOpeningHours', 'places.location', 'places.utcOffsetMinutes',
].join(',');

const DETAILS_FIELD_MASK = [
  'id', 'displayName', 'formattedAddress', 'nationalPhoneNumber', 'websiteUri',
  'rating', 'userRatingCount', 'priceLevel', 'photos', 'currentOpeningHours',
  'types', 'location', 'googleMapsUri', 'utcOffsetMinutes',
].join(',');

// Map price level enum to numeric
function priceLevelToNum(priceLevel) {
  const map = {
    'PRICE_LEVEL_FREE': 0,
    'PRICE_LEVEL_INEXPENSIVE': 1,
    'PRICE_LEVEL_MODERATE': 2,
    'PRICE_LEVEL_EXPENSIVE': 3,
    'PRICE_LEVEL_VERY_EXPENSIVE': 4,
  };
  return map[priceLevel] ?? null;
}

// GET /api/venues/search?query=restaurants+wildwood&location=lat,lng
router.get('/search',
  [
    query('query').trim().isLength({ min: 1, max: 80 }).withMessage('Search query is required'),
    query('location').optional().trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      if (!API_KEY) {
        return res.status(500).json({ error: 'Google Places API key not configured' });
      }

      // Round 18: `?query=a&query=b` arrives as an ARRAY, walked past the
      // validator chain, and `.toLowerCase()` turned it into a 500 per request.
      // Anything that is not a scalar string is a 400, before it costs anything.
      if (typeof req.query.query !== 'string') {
        return res.status(400).json({ error: 'Search query is required' });
      }

      // Round 18 — the cache key is a NORMAL FORM, not the raw string. "Bars
      // Downtown", "bars   downtown" and full-width variants are the same
      // question, and every casing/whitespace/width spelling used to mint its
      // own cache entry and its own paid Google call. NFKC folds compatibility
      // variants, \s+ collapses whitespace runs, and the result is BOTH what
      // is cached under and what is sent to Google, so the key can never
      // disagree with the answer stored under it.
      const searchQuery = req.query.query
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      if (!searchQuery) {
        return res.status(400).json({ error: 'Search query is required' });
      }

      // Location: "lat,lng", parsed ONCE and snapped to the same 2-decimal
      // grid (~1.1 km) the cache key has always used. Two fixes live here:
      //   * the snapped value is now also what is SENT to Google (the bias
      //     radius is 20 km, so a ≤800 m snap is noise), which closes the
      //     jitter channel — two requests that share a cache key can no
      //     longer differ upstream, and the cached answer honestly matches
      //     its key;
      //   * anything that is not two in-range finite numbers — an array from
      //     `?location=a&location=b`, "abc,def", latitude 999 — is ignored
      //     outright. The old code let garbage share the no-location cache
      //     key while sending Google a locationBias of nulls (a paid call
      //     spent on a guaranteed error), and an array crashed the handler
      //     into a 500.
      let coarse = null;
      const rawLoc = req.query.location;
      if (typeof rawLoc === 'string' && rawLoc.length > 0 && rawLoc.length <= 64) {
        const parts = rawLoc.split(',');
        if (parts.length === 2) {
          const la = Number(parts[0]);
          const ln = Number(parts[1]);
          if (Number.isFinite(la) && Number.isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180) {
            coarse = { lat: Number(la.toFixed(2)), lng: Number(ln.toFixed(2)) };
          }
        }
      }
      const cacheKey = `search:${searchQuery}|${coarse ? `${coarse.lat.toFixed(2)},${coarse.lng.toFixed(2)}` : ''}`;
      const cached = getCached(cacheKey);
      if (cached) {
        return res.json(cached);
      }

      let flight = inflight.get(cacheKey);
      if (!flight) {
        // Upstream budget (round 7): text search is a PAID Google call and the
        // general API limiter alone let one account burn it with unique
        // queries. Only the leader charges — one Google call is one unit,
        // however many concurrent requests share its answer.
        if (!allowPlacesSearch(req.user.id)) {
          return res.status(429).json({ error: 'Searching too fast. Give it a few seconds.' });
        }
        flight = runTextSearch(searchQuery, coarse, cacheKey);
        inflight.set(cacheKey, flight);
        flight.then(() => inflight.delete(cacheKey));
      }
      const out = await flight;
      if (out.status !== 200) return res.status(out.status).json({ error: out.error });
      res.json(out.result);
    } catch (err) {
      console.error('Venue search error:', err);
      res.status(500).json({ error: 'Failed to search venues' });
    }
  }
);

// The worker behind GET /search. Never rejects: resolves to
// { status: 200, result } or { status, error }, so a failure reaches every
// coalesced waiter as the same clean response and is never cached — setCache
// runs only on a real answer, so an upstream 429/5xx can never pin itself.
async function runTextSearch(searchQuery, coarse, cacheKey) {
  try {
    // Use Places API (New) - Text Search
    const body = { textQuery: searchQuery };
    if (coarse) {
      body.locationBias = {
        circle: { center: { latitude: coarse.lat, longitude: coarse.lng }, radius: 20000.0 }
      };
    }

    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': API_KEY,
        'X-Goog-FieldMask': SEARCH_FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: upstreamSignal('places'), // round 12
    });

    const data = await response.json();

    if (data.error) {
      console.error('Places API error:', data.error.status, data.error.message);
      return { status: 502, error: `Places API: ${data.error.message}` };
    }

    // Map results to clean venue objects
    const venues = (data.places || []).map(place => {
      let photo = null;
      if (place.photos && place.photos.length > 0) {
        photo = photoUrl(place.photos[0].name);
      }

      return {
        place_id: place.id,
        name: place.displayName?.text || '',
        formatted_address: place.formattedAddress || '',
        rating: place.rating || null,
        user_ratings_total: place.userRatingCount || 0,
        price_level: priceLevelToNum(place.priceLevel),
        photo_url: photo,
        types: place.types || [],
        opening_hours: place.currentOpeningHours || null,
        location: place.location || null,
        // camelCase on purpose: this is the exact key POST /api/crowd/batch
        // whitelists off each body item, so the client forwards it untouched.
        // Nullable — Google omits it for some places, and a null here is what
        // makes the batch answer `venueClock.local: false` rather than pretend
        // the caller's clock was the venue's.
        utcOffsetMinutes: place.utcOffsetMinutes != null ? place.utcOffsetMinutes : null,
      };
    });

    const result = { venues, total: venues.length };
    setCache(cacheKey, result);
    return { status: 200, result };
  } catch (err) {
    console.error('Venue search error:', err);
    return { status: 500, error: 'Failed to search venues' };
  }
}

// GET /api/venues/details?place_id=xxx - Get full details for a venue
router.get('/details',
  // SHAPED, not merely non-empty. Three things were riding on "at least one
  // character":
  //   * a PAID Place Details call was spent on any string at all, including ids
  //     that cannot be real;
  //   * `place_id` was interpolated raw into the Google URL below, so a `/`,
  //     `?` or `#` in it rewrote the path or the query string of a request
  //     carrying our server-restricted API key — the same escape routes/crowd.js
  //     closed with encodeURIComponent and routes/publicCrowd.js never had;
  //   * there was no max length, so the `detail:` cache key was unbounded.
  // isPlaceIdShaped answers all three (bounded 6-128, [A-Za-z0-9_-] only), and
  // it is the same predicate checkin.js, flocks.js, feedback.js, venueProfile.js,
  // venueDashboard.js, sockets/handlers.js and crowd.js gate on.
  query('place_id').trim()
    .isLength({ min: 1, max: 200 }).withMessage('place_id is required')
    .bail()
    .custom((v) => isPlaceIdShaped(v)).withMessage('place_id is not a valid place id'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      if (!API_KEY) {
        return res.status(500).json({ error: 'Google Places API key not configured' });
      }

      const placeId = req.query.place_id;

      const detailCacheKey = `detail:${placeId}`;
      const cached = getCached(detailCacheKey);
      if (cached) return res.json(cached);

      let flight = inflight.get(detailCacheKey);
      if (!flight) {
        // Round 8: details is the same PAID Google surface as text search —
        // rotating valid place ids bypassed the shared budget entirely.
        // Only the leader charges (round 18): one Google call, one unit.
        if (!allowPlacesSearch(req.user.id)) {
          return res.status(429).json({ error: 'Loading venues too fast. Give it a few seconds.' });
        }
        flight = runPlaceDetails(placeId, detailCacheKey);
        inflight.set(detailCacheKey, flight);
        flight.then(() => inflight.delete(detailCacheKey));
      }
      const out = await flight;
      if (out.status !== 200) return res.status(out.status).json({ error: out.error });
      res.json(out.result);
    } catch (err) {
      console.error('Venue details error:', err);
      res.status(500).json({ error: 'Failed to get venue details' });
    }
  }
);

// The worker behind GET /details. Same contract as runTextSearch: never
// rejects, never caches a failure.
async function runPlaceDetails(placeId, detailCacheKey) {
  try {
    // ENCODED, belt and braces behind the shape check above: one path segment,
    // always. Matches routes/crowd.js fetchVenueFromGoogle and
    // routes/publicCrowd.js.
    const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: {
        'X-Goog-Api-Key': API_KEY,
        'X-Goog-FieldMask': DETAILS_FIELD_MASK,
      },
      signal: upstreamSignal('places'), // round 12
    });

    const p = await response.json();

    if (p.error) {
      return { status: 502, error: `Places API: ${p.error.message}` };
    }

    const photos = (p.photos || []).slice(0, 5).map(photo => photoUrl(photo.name, 600));

    const result = {
      venue: {
        place_id: p.id,
        name: p.displayName?.text || '',
        formatted_address: p.formattedAddress || '',
        formatted_phone_number: p.nationalPhoneNumber || null,
        website: p.websiteUri || null,
        rating: p.rating || null,
        user_ratings_total: p.userRatingCount || 0,
        price_level: priceLevelToNum(p.priceLevel),
        photos,
        opening_hours: p.currentOpeningHours || null,
        types: p.types || [],
        location: p.location || null,
        google_maps_url: p.googleMapsUri || null,
        menu_url: null,
        // Same key the batch endpoint whitelists, same nullability. See the
        // field mask note above.
        utcOffsetMinutes: p.utcOffsetMinutes != null ? p.utcOffsetMinutes : null,
      },
    };
    setCache(detailCacheKey, result);
    return { status: 200, result };
  } catch (err) {
    console.error('Venue details error:', err);
    return { status: 500, error: 'Failed to get venue details' };
  }
}

module.exports = router;

// Tests only (backend/__tests__/placesProxyAbuse.test.js). resetPhotoBudget
// with { clearIps: false } rolls only the day counter — what a real UTC
// midnight does; the per-IP table survives it, which is why the flood pin can
// exist at all. Production code must never reset a spending counter.
module.exports.__test = {
  // Round 23 — the two sized-against-something numbers and the constants they
  // are sized against, so the inequalities are pinned from one source.
  VENUE_CACHE_MAX,
  VENUE_CACHE_LOW_WATER,
  PUBLIC_PHOTO_BUDGET,
  PER_USER_HOURLY,
  GLOBAL_DAILY,
  CACHE_TTL,
  setCache,
  getCached,
  venueCacheSize: () => venueCache.size,
  clearVenueCache: () => venueCache.clear(),
  allowPhotoFetch,
  resetPhotoBudget({ clearIps = true } = {}) {
    photoDayKey = new Date().toISOString().slice(0, 10);
    photoDayCount = 0;
    if (clearIps) photoIpHits.clear();
  },
};
