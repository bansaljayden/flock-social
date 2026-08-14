const express = require('express');
const { query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { upstreamSignal } = require('../utils/upstream');
// Shape before content — see validators/shape.js.
const { scalarOnly } = require('../validators/shape');
// The per-user budget, from the one module that implements it. See below for
// what the hand-rolled version in this file used to do.
const { createUserBudget } = require('../utils/probeBudget');

const router = express.Router();

const TM_API_KEY = process.env.TICKETMASTER_API_KEY;

// Server-side event cache (1 hour TTL — Ticketmaster free tier has 5K calls/day limit)
const eventCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

// A FAILURE IS NOT REMEMBERED AS LONG AS AN ANSWER (§O round: "connection
// lost"). A Ticketmaster 429, or any non-ok response, is answered with an empty
// list — deliberate graceful degradation — and that empty list used to be
// cached under the same one-hour TTL as a real result. So one throttled second
// blanked event search for a whole metro area for the next hour, long after the
// upstream had recovered, and nothing in the response said so. A rate limit
// lasts seconds; remembering it for an hour turns a blip into an outage we
// inflicted on ourselves.
//
// Ninety seconds is the same trade services/weatherService.js makes with
// WX_NEGATIVE_TTL (sixty): long enough that a sustained outage does not
// re-charge the paid budget on every request, short enough that a recovering
// upstream is picked up while the user is still on the screen.
const NEGATIVE_TTL = 90 * 1000;

function ttlOf(entry) {
  return entry.negative ? NEGATIVE_TTL : CACHE_TTL;
}

// ---------------------------------------------------------------------------
// A DEAD UPSTREAM IS REMEMBERED FOR A MOMENT (§O round: "connection lost").
//
// The cache above only remembers ANSWERS, keyed by what was asked. A network
// failure is not an answer to a question — it is a fact about Ticketmaster —
// and it was not remembered at all. So while the upstream was unreachable,
// every request paid the budget for a fetch, waited out the full deadline in
// utils/upstream.js, and failed; the slower the upstream got, the more of the
// day's allowance went into requests that returned nothing, on the three
// endpoints at once because they all key their caches differently and none of
// them would ever hit.
//
// Charging the budget for a call that timed out is correct and deliberate — an
// aborted paid request still bills at the vendor. What was wrong is making the
// call at all when we learned a second ago that nobody is answering.
//
// One breaker for the whole router, because there is one upstream. It is
// checked BEFORE the budget is charged, so a refusal here costs nothing.
//
// IT TAKES TWO FAILURES IN A ROW TO OPEN IT, and any response at all closes it.
// That threshold is the whole design and it was added on the second read of
// this patch: the Ticketmaster deadline is 6 seconds, which one slow response
// on a bad connection can exceed, and a breaker that opens on a single timeout
// would take event search away from EVERY user for ninety seconds because ONE
// request was slow. That is a worse outage than the one being prevented, and we
// would have caused it. Two consecutive failures is the difference between "one
// request was unlucky" and "nobody is home".
//
// An HTTP error is not a failure here. A 429 or a 500 means Ticketmaster
// answered — that is a different problem, handled by the negative cache above,
// and it must not be confused with the host being unreachable.
const TM_FAILURES_TO_OPEN = 2;
let tmDownUntil = 0;
let tmConsecutiveFailures = 0;
function upstreamIsDown() { return Date.now() < tmDownUntil; }
function noteUpstreamDown(where, err) {
  tmConsecutiveFailures += 1;
  if (tmConsecutiveFailures >= TM_FAILURES_TO_OPEN) tmDownUntil = Date.now() + NEGATIVE_TTL;
  console.warn(`[Events] ${where}: Ticketmaster unreachable (${tmConsecutiveFailures} in a row) —`, err?.message);
}
function noteUpstreamAnswered() {
  tmConsecutiveFailures = 0;
  tmDownUntil = 0;
}
const UPSTREAM_DOWN = { error: 'Event search is unavailable right now. Try again in a moment.' };

function getCached(key) {
  const entry = eventCache.get(key);
  if (entry && Date.now() - entry.ts < ttlOf(entry)) return entry.data;
  if (entry) eventCache.delete(key);
  return null;
}

let lastCacheKey = null;

function setCache(key, data, negative = false) {
  lastCacheKey = key;
  eventCache.set(key, { data, ts: Date.now(), negative });
  if (eventCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of eventCache) {
      if (now - v.ts > ttlOf(v)) eventCache.delete(k);
    }
    // Still oversized after expiry sweep: evict oldest so unique-keyword
    // spam can't grow the map without bound (round 5).
    while (eventCache.size > 100) {
      eventCache.delete(eventCache.keys().next().value);
    }
  }
}

// ---------------------------------------------------------------------------
// Upstream budget: per-user 20 fresh searches/hour and 200/day, global
// 2000/day. The documented Ticketmaster ceiling is 5K/day.
//
// This was a hand-rolled counter, and it carried the exact defect
// utils/probeBudget.js was extracted to stop:
//
//     if (tmUserHits.size > 5000) tmUserHits.clear();
//
// A wholesale clear hands EVERY tracked caller a fresh allowance, including
// whoever pushed the map over the threshold — so anyone who had spent their
// twenty searches could recover them by making the map big, which on a
// user-id-keyed map costs a few cheap accounts. routes/friends.js carried the
// same line and was already fixed by moving to the shared module; this file was
// the last copy. probeBudget evicts LEAST CONSUMED first for precisely this
// reason, and never clears.
//
// COST IS COUNTED IN CALLS, NOT REQUESTS. /search fires a second, location-free
// query whenever the caller typed a keyword — utils/upstream.js calls that "the
// only deliberate second charge in the codebase" — and the old counter recorded
// it as one. The global ceiling therefore said 2000 and permitted up to 4000,
// which is most of the way to the vendor's 5K on a route that is one of several
// spending it.
// ---------------------------------------------------------------------------
// The daily figure is new — the hand-rolled counter had an hourly limit and no
// daily one, so a single account could take 20 an hour around the clock and
// spend a quarter of the global ceiling on its own. 200 is ten times the hourly
// burst, which is far more browsing than anyone does in a day, and one tenth of
// the global budget, which is the property that matters: no one account can
// deny event search to everybody else.
const TM_GLOBAL_DAILY = 2000;
const tmUserBudget = createUserBudget({ name: 'ticketmaster', hourly: 20, daily: 200 });
let tmDayKey = new Date().toISOString().slice(0, 10);
let tmDayCount = 0;

// The day rollover, in ONE place. It was written out at each call site, which
// is two copies of a spending control that have to agree and no reason they
// would.
function chargeGlobal(cost) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== tmDayKey) { tmDayKey = today; tmDayCount = 0; }
  if (tmDayCount + cost > TM_GLOBAL_DAILY) return false;
  tmDayCount += cost;
  return true;
}

// `cost` is how many upstream calls the caller is about to make. Charged BEFORE
// the fetch, never after: an aborted paid request still bills at the vendor
// (utils/upstream.js).
//
// The per-user unit is taken only once the global budget has agreed to pay, so
// a caller refused by the global ceiling does not also lose one of their own
// twenty — they were never going to get the call either way.
function allowUpstream(userId, cost = 1) {
  if (tmDayCount + cost > TM_GLOBAL_DAILY) return false;
  if (!tmUserBudget.allow(userId)) return false;
  return chargeGlobal(cost);
}

// The global half of the ledger on its own, for a second call inside a request
// whose per-user unit is already spent. Refusing here skips an optional top-up;
// it never fails a request that has already produced an answer.
const chargeUpstreamExtra = (cost = 1) => chargeGlobal(cost);

// ---------------------------------------------------------------------------
// A COORDINATE, NOT A THREE-CHARACTER STRING (§O round: "wrong thing").
//
// Both search endpoints took `location` as `.trim().isLength({ min: 3 })`, so
// every one of these passed validation:
//
//   location=abc          -> latlong=NaN,NaN sent to Ticketmaster, and paid for
//   location=91,0         -> a latitude that does not exist, paid for
//   location=1,           -> latlong=1,NaN, paid for
//   ?location=a&location=b -> req.query.location is an ARRAY (express-validator
//                            expands an array field into one instance per
//                            element and validates each on its own, so both
//                            elements passed), `location.split` threw, and the
//                            blanket catch in /search turned the caller's own
//                            malformed request into `200 {events: [], total: 0}`
//                            — "there is nothing happening near you". On
//                            /featured the same request was a 500.
//
// Every one of those spent a call from a metered budget on a question that
// could not be answered, and told the user a lie about the answer. The
// coordinate is settled here, once, before anything else looks at it.
// ---------------------------------------------------------------------------
function parseLocation(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(',');
  if (parts.length !== 2) return null;
  const lat = Number(parts[0].trim());
  const lng = Number(parts[1].trim());
  // Number('') is 0 and Number(' ') is 0, so the emptiness check is explicit.
  if (parts[0].trim() === '' || parts[1].trim() === '') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

const locationParam = () =>
  scalarOnly(query('location'), 'location')
    .custom((v) => parseLocation(v) !== null)
    .withMessage('A location is required, as "latitude,longitude"');

// ---------------------------------------------------------------------------
// A USER-SUPPLIED STRING IS NOT AN OBJECT KEY (§O round: "wrong thing").
//
// Both search endpoints look their filter up in a plain object literal —
// `segMap[category]`, `interestToTM[interest]` — and test the result for
// truthiness. Plain object literals inherit from Object.prototype, so:
//
//   ?category=constructor  ->  segMap.constructor is the Object FUNCTION,
//                              which is truthy, so the branch was taken and
//                              `classificationName=function Object() { [native
//                              code] }` went into the Ticketmaster URL
//   ?category=toString     ->  the same, with Object.prototype.toString
//   ?category=__proto__    ->  "[object Object]"
//
// Nothing is polluted — these are reads — but a caller could choose a garbage
// upstream parameter and spend a metered call on a query that could not return
// anything, and on /featured the junk value reached `classificationName`
// through a list the interest filter had already "validated". A lookup table
// keyed by user input has to answer only for keys it actually declares.
// ---------------------------------------------------------------------------
const ownLookup = (table, key) =>
  (typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key)) ? table[key] : undefined;

// Ticketmaster discovery ids are short base62-ish strings (`G5vYZ9j3fV4Ay`).
// The id used to be interpolated raw into the upstream URL PATH, so a caller
// could put a `/`, a `..`, a `?` or a `#` into it and choose which endpoint on
// that host we called and which query string it carried — and every attempt
// spent a call from the daily budget on a request that could never return an
// event. It is a format, it is checked as one, and it is encoded at the call
// site as well.
const TM_EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

// Map Ticketmaster segment to simple category
function mapEventCategory(classifications) {
  if (!classifications || !classifications[0]) return 'other';
  const seg = (classifications[0].segment?.name || '').toLowerCase();
  const genre = (classifications[0].genre?.name || '').toLowerCase();
  if (seg.includes('music')) return 'concert';
  if (seg.includes('sport')) return 'sports';
  if (seg.includes('arts') || seg.includes('theatre') || seg.includes('theater')) return 'arts';
  if (seg.includes('film')) return 'film';
  if (genre.includes('comedy')) return 'comedy';
  if (genre.includes('festival')) return 'festival';
  return 'other';
}

// Format price range
function formatPriceRange(priceRanges) {
  if (!priceRanges || !priceRanges[0]) return null;
  const p = priceRanges[0];
  if (p.min && p.max) return { min: p.min, max: p.max, currency: p.currency || 'USD' };
  if (p.min) return { min: p.min, max: null, currency: p.currency || 'USD' };
  return null;
}

// Get the best event image — prefer non-fallback, then check attractions, then fallback
function getBestImage(event) {
  const imgs = event.images || [];
  // Prefer non-fallback 16:9 images
  const real = imgs.filter(i => !i.fallback);
  const best = real.find(i => i.ratio === '16_9' && i.width >= 500)
    || real.find(i => i.ratio === '16_9')
    || real[0];
  if (best) return best.url;

  // Check attraction images (artist/team photos)
  const attractions = event._embedded?.attractions || [];
  for (const a of attractions) {
    const aImgs = (a.images || []).filter(i => !i.fallback);
    const aBest = aImgs.find(i => i.ratio === '16_9' && i.width >= 500)
      || aImgs.find(i => i.ratio === '16_9')
      || aImgs[0];
    if (aBest) return aBest.url;
  }

  // Last resort: any image including fallbacks
  const fallback = imgs.find(i => i.ratio === '16_9' && i.width >= 500)
    || imgs.find(i => i.ratio === '16_9')
    || imgs[0];
  return fallback?.url || null;
}

// Map a raw Ticketmaster event to our clean format
function mapEvent(e) {
  const venue = e._embedded?.venues?.[0];
  const attraction = e._embedded?.attractions?.[0];

  return {
    id: e.id,
    name: e.name,
    category: mapEventCategory(e.classifications),
    date: e.dates?.start?.localDate || null,
    time: e.dates?.start?.localTime || null,
    datetime_utc: e.dates?.start?.dateTime || null,
    venue_name: venue?.name || null,
    venue_address: [venue?.address?.line1, venue?.city?.name, venue?.state?.stateCode].filter(Boolean).join(', '),
    venue_city: venue?.city?.name || null,
    venue_state: venue?.state?.stateCode || null,
    location: venue?.location ? {
      latitude: parseFloat(venue.location.latitude),
      longitude: parseFloat(venue.location.longitude),
    } : null,
    image_url: getBestImage(e),
    price_range: formatPriceRange(e.priceRanges),
    url: e.url || null,
    status: e.dates?.status?.code || null,
    genre: e.classifications?.[0]?.genre?.name || null,
    subgenre: e.classifications?.[0]?.subGenre?.name || null,
    segment: e.classifications?.[0]?.segment?.name || null,
    attraction_name: attraction?.name || null,
    seatmap_url: e.seatmap?.staticUrl || null,
    info: e.info || null,
    please_note: e.pleaseNote || null,
    distance_miles: e.distance || null,
  };
}

// All routes require auth
router.use(authenticate);

// GET /api/events/search?location=lat,lng&query=concerts&radius=30
router.get('/search',
  [
    locationParam(),
    scalarOnly(query('query').optional(), 'query').trim(),
    // `checkFalsy`, for the same reason as the story feed's page size: `?radius=`
    // is what a client that builds its query string from unset state sends,
    // `.optional()` skips only `undefined`, and the search then failed outright
    // over a parameter the caller did not choose. `'0'` is a non-empty string,
    // so an explicit zero is still refused as the out-of-range value it is.
    scalarOnly(query('radius').optional({ checkFalsy: true }), 'radius').isInt({ min: 1, max: 100 })
      .withMessage('Search within 1 to 100 miles'),
    scalarOnly(query('category').optional(), 'category').trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      if (!TM_API_KEY) {
        return res.status(500).json({ error: 'Ticketmaster API key not configured' });
      }

      // Already proved to be a real coordinate by locationParam() above, so
      // there is no second, differently-written parse here — the two copies of
      // `location.split(',').map(Number)` this route used to carry (one for the
      // cache key, one for the request) were the same expression twice with no
      // guarantee they agreed.
      const { lat, lng } = parseLocation(req.query.location);
      // Normalized + capped: raw keywords made every request a cache miss, and
      // the general API limiter alone let one client burn the whole 5k/day
      // Ticketmaster quota (round 5).
      const searchQuery = (req.query.query || '').toLowerCase().trim().slice(0, 40);
      const radiusMiles = parseInt(req.query.radius) || 50;
      const categoryFilter = (req.query.category || '').slice(0, 40);

      const coarseLoc = `${lat.toFixed(1)},${lng.toFixed(1)}`;
      const cacheKey = `events:${coarseLoc}|${searchQuery}|${radiusMiles}|${categoryFilter}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);

      if (upstreamIsDown()) return res.status(503).json(UPSTREAM_DOWN);

      // A keyword search fires a second, location-free query below, so it is
      // charged for two. See allowUpstream.
      if (!allowUpstream(req.user.id, searchQuery ? 2 : 1)) {
        return res.status(429).json({ error: 'Event search is busy right now. Try again in a bit.' });
      }

      // Search with location bias
      const localParams = new URLSearchParams({
        apikey: TM_API_KEY,
        latlong: `${lat},${lng}`,
        radius: radiusMiles,
        unit: 'miles',
        size: 20,
        sort: 'date,asc',
      });

      if (searchQuery) localParams.set('keyword', searchQuery);
      if (categoryFilter) {
        const segMap = { concert: 'Music', sports: 'Sports', arts: 'Arts & Theatre', film: 'Film', comedy: 'Arts & Theatre' };
        const seg = ownLookup(segMap, categoryFilter);
        if (seg) localParams.set('classificationName', seg);
      }

      // If user typed a keyword, also search without location (catches team names, artists, etc.)
      // Round 12: every Ticketmaster call now carries a deadline (utils/upstream.js).
      const fetches = [fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${localParams}`, { signal: upstreamSignal('ticketmaster') })];
      if (searchQuery) {
        const wideParams = new URLSearchParams({
          apikey: TM_API_KEY,
          keyword: searchQuery,
          size: 15,
          sort: 'date,asc',
          countryCode: 'US',
        });
        if (categoryFilter) {
          const segMap = { concert: 'Music', sports: 'Sports', arts: 'Arts & Theatre', film: 'Film', comedy: 'Arts & Theatre' };
          const seg = ownLookup(segMap, categoryFilter);
          if (seg) wideParams.set('classificationName', seg);
        }
        fetches.push(fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${wideParams}`, { signal: upstreamSignal('ticketmaster') }));
      }

      // allSettled, not all: the optional keyword-wide search timing out must
      // not throw away the local results that already came back (round 12).
      const settled = await Promise.allSettled(fetches);
      if (settled[0].status === 'rejected') {
        noteUpstreamDown('search', settled[0].reason);
        return res.status(503).json(UPSTREAM_DOWN);
      }
      noteUpstreamAnswered();
      const responses = settled.map((s) => (s.status === 'fulfilled' ? s.value : null));

      // Handle Ticketmaster rate limits and outages gracefully — return empty
      // instead of 500, but remember the FAILURE under the short negative TTL,
      // not the hour-long success TTL. A 429 lasts seconds.
      if (!responses[0].ok) {
        console.warn('[Events] Ticketmaster search returned', responses[0].status, '— returning empty');
        const empty = { events: [], total: 0 };
        setCache(cacheKey, empty, true);
        return res.json(empty);
      }

      // responses[0].ok is guaranteed by the guard above. The wide search is
      // still optional in every direction — rejected, not-ok, or absent.
      //
      // A BODY THAT WILL NOT PARSE IS AN UPSTREAM FAILURE, not a search with no
      // results. `await response.json()` on a truncated or hung body throws —
      // the deadline covers the body stream too — and that throw used to land
      // in the blanket catch at the bottom, which answers `200 {events: []}`.
      // So a broken upstream read to the user as "nothing is happening near
      // you", and because nothing was cached it re-charged the paid budget on
      // every retry. services/weatherService.js draws exactly this distinction
      // and for exactly this reason.
      const localData = await responses[0].json().catch((e) => {
        console.warn('[Events] Malformed search body:', e.message);
        return null;
      });
      if (!localData) {
        const empty = { events: [], total: 0 };
        setCache(cacheKey, empty, true);
        return res.json(empty);
      }
      const wideData = responses[1]?.ok ? await responses[1].json().catch(() => ({})) : {};

      // Merge: local results first, then wide results (deduped)
      const localEvents = localData._embedded?.events || [];
      const wideEvents = wideData._embedded?.events || [];
      const seenIds = new Set(localEvents.map(e => e.id));
      const rawEvents = [...localEvents, ...wideEvents.filter(e => !seenIds.has(e.id))].slice(0, 30);

      const events = rawEvents.map(mapEvent);

      const result = { events, total: events.length };
      setCache(cacheKey, result);
      res.json(result);
    } catch (err) {
      console.error('[Events] Search error:', err);
      res.json({ events: [], total: 0 }); // graceful degradation — never 500 for events
    }
  }
);

// GET /api/events/featured?location=lat,lng&interests=Live+Music,Sports — curated "what's happening nearby"
router.get('/featured',
  [
    locationParam(),
    scalarOnly(query('interests').optional(), 'interests').trim(),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      if (!TM_API_KEY) {
        return res.status(500).json({ error: 'Ticketmaster API key not configured' });
      }

      const { lat, lng } = parseLocation(req.query.location);
      const interests = req.query.interests || '';

      // THE CACHE KEY IS PART OF THE SPENDING CONTROL (§O round: "two at
      // once"). /search rounds the coordinate to 0.1 degrees precisely so that
      // two phones a block apart share one paid Ticketmaster call. /featured
      // keyed on the RAW location string and the RAW interests string, so:
      //
      //   * every metre of GPS jitter was a fresh upstream call for a list that
      //     covers a 30-mile radius and could not possibly have differed; and
      //   * `sports,live music` and `live music,sports` were two entries for
      //     one question, as was any difference in case or spacing.
      //
      // The result was a cache that almost never hit on the endpoint the app
      // calls on open — the worst place in this router to be paying per user
      // rather than per area. Coarsen and normalise, exactly as /search does.
      //
      // The length cap is not decoration either: an unbounded key is an
      // unbounded Map entry, and the eviction below counts entries, not bytes.
      const coarseLoc = `${lat.toFixed(1)},${lng.toFixed(1)}`;
      const normalizedInterests = [...new Set(
        interests.toLowerCase().split(',').map((i) => i.trim()).filter(Boolean)
      )].sort().join(',').slice(0, 100);
      const cacheKey = `featured:${coarseLoc}|${normalizedInterests}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);

      if (upstreamIsDown()) return res.status(503).json(UPSTREAM_DOWN);

      if (!allowUpstream(req.user.id)) {
        return res.status(429).json({ error: 'Event search is busy right now. Try again in a bit.' });
      }

      // Map user interests to Ticketmaster classification keywords
      const interestToTM = {
        'live music': 'Music',
        'cocktails': '',
        'beer & brews': '',
        'sports': 'Sports',
        'dancing': 'Music',
        'karaoke': 'Music',
        'comedy': 'Arts & Theatre',
        'wine': '',
        'gaming': '',
        'art & culture': 'Arts & Theatre',
        'food': '',
        'chill vibes': '',
        'nightlife': 'Music',
      };

      // Build classification filter from interests. Derived from the SAME
      // normalised list the cache key is built from, so two requests that share
      // a cache entry cannot have asked Ticketmaster different questions.
      const tmClassifications = [...new Set(
        normalizedInterests.split(',').map((i) => ownLookup(interestToTM, i)).filter(Boolean)
      )].sort();

      // Fetch upcoming events in the next 7 days
      const startDate = new Date();
      const endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

      const params = new URLSearchParams({
        apikey: TM_API_KEY,
        latlong: `${lat},${lng}`,
        radius: 30,
        unit: 'miles',
        size: 20,
        sort: 'relevance,desc',
        startDateTime: fmt(startDate),
        endDateTime: fmt(endDate),
      });

      // If user has relevant interests, filter by classification
      if (tmClassifications.length > 0 && tmClassifications.length <= 2) {
        params.set('classificationName', tmClassifications.join(','));
      }

      // An unreachable upstream is a 503, not a 500. It used to throw straight
      // into the outer catch, which answers "Failed to get featured events"
      // with a 500 — our fault, retry-hostile, and indistinguishable in the
      // logs from a bug in this file. /search already drew that line; these two
      // did not. Round 12 gave every one of these calls a deadline; a deadline
      // that fires is precisely this path.
      const response = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`, { signal: upstreamSignal('ticketmaster') }) // round 12
        .catch((e) => { noteUpstreamDown('featured', e); return null; });
      if (!response) return res.status(503).json(UPSTREAM_DOWN);
      noteUpstreamAnswered();

      if (!response.ok) {
        // Rate limited or failed — gracefully return empty, and remember the
        // FAILURE under the short negative TTL rather than the hour-long
        // success TTL. See NEGATIVE_TTL.
        console.warn('[Events] Featured: Ticketmaster', response.status, '— returning empty');
        const empty = { events: [], total: 0 };
        setCache(cacheKey, empty, true);
        return res.json(empty);
      }

      // A body that will not parse is a failure, not an empty list. See the
      // same guard in /search.
      const data = await response.json().catch((e) => {
        console.warn('[Events] Malformed featured body:', e.message);
        return null;
      });
      if (!data) {
        const empty = { events: [], total: 0 };
        setCache(cacheKey, empty, true);
        return res.json(empty);
      }
      let rawEvents = data._embedded?.events || [];

      // If we filtered by classification and got few results, fetch more
      // without the filter. This is a SECOND paid call, and it was not charged
      // at all — the global ledger was one call short on every request that
      // took this branch. It is charged before it is made (utils/upstream.js:
      // an aborted paid request still bills), against the global ceiling only:
      // the caller's own hourly allowance was already spent on this request and
      // charging it twice would refuse them a search they only made once.
      if (tmClassifications.length > 0 && rawEvents.length < 5 && chargeUpstreamExtra(1)) {
        params.delete('classificationName');
        // The unfiltered top-up is optional — a timeout here must not lose the
        // interest-matched events we already have (round 12).
        const fallbackRes = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`, { signal: upstreamSignal('ticketmaster') })
          .catch((e) => { console.warn('[Events] Featured top-up failed:', e.message); return null; });
        if (fallbackRes?.ok) {
          const fallbackData = await fallbackRes.json();
          const fallbackEvents = fallbackData._embedded?.events || [];
          // Merge: interest-matched first, then others
          const existingIds = new Set(rawEvents.map(e => e.id));
          rawEvents = [...rawEvents, ...fallbackEvents.filter(e => !existingIds.has(e.id))].slice(0, 20);
        }
      }

      const events = rawEvents.map(mapEvent);

      const result = { events, total: events.length };
      setCache(cacheKey, result);
      res.json(result);
    } catch (err) {
      console.error('[Events] Featured error:', err);
      res.status(500).json({ error: 'Failed to get featured events' });
    }
  }
);

// GET /api/events/details?id=xxx — Full event details (like venue details page)
router.get('/details',
  scalarOnly(query('id'), 'event id').trim().matches(TM_EVENT_ID)
    .withMessage('That event link is not one we can look up'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      if (!TM_API_KEY) {
        return res.status(500).json({ error: 'Ticketmaster API key not configured' });
      }

      const eventId = req.query.id;
      const cacheKey = `event_detail:${eventId}`;
      const cached = getCached(cacheKey);
      if (cached) return res.json(cached);

      if (upstreamIsDown()) return res.status(503).json(UPSTREAM_DOWN);

      if (!allowUpstream(req.user.id)) {
        return res.status(429).json({ error: 'Event lookups are busy right now. Try again in a bit.' });
      }

      // encodeURIComponent as well as the format check above. The allowlist is
      // what stops the path being chosen by the caller; the encoding is what
      // keeps that true if the allowlist is ever widened.
      const response = await fetch(
        `https://app.ticketmaster.com/discovery/v2/events/${encodeURIComponent(eventId)}?apikey=${TM_API_KEY}`,
        { signal: upstreamSignal('ticketmaster') }
      ).catch((e) => { noteUpstreamDown('details', e); return null; }); // round 12
      // Unreachable is a 503, the same as /search. See the note on /featured.
      if (!response) return res.status(503).json(UPSTREAM_DOWN);
      noteUpstreamAnswered();

      if (!response.ok) {
        return res.status(response.status === 404 ? 404 : 502).json({ error: 'Event not found' });
      }

      // Same rule as the two search endpoints: an unreadable body is the
      // upstream failing, and it must not be reported as an event made
      // entirely of nulls (which is what mapEvent produces from `{}`, and what
      // the blanket catch below would have turned into a 500 anyway).
      const e = await response.json().catch((err) => {
        console.warn('[Events] Malformed details body:', err.message);
        return null;
      });
      if (!e || typeof e !== 'object') {
        return res.status(502).json({ error: 'Event not found' });
      }
      const venue = e._embedded?.venues?.[0];
      const attraction = e._embedded?.attractions?.[0];

      // Collect unique images — TM serves same photo in many sizes, dedupe by base filename
      const getImageKey = (url) => {
        // Extract the unique image hash from URL (e.g. "c9d1f714-57de-4e29-9d62-cb403420d615")
        const match = url.match(/\/([a-f0-9-]{20,})_/);
        return match ? match[1] : url;
      };
      const allImgs = (e.images || []).filter(i => !i.fallback);
      const attractionImgs = (attraction?.images || []).filter(i => !i.fallback);
      const seenKeys = new Set();
      const photos = [...allImgs, ...attractionImgs]
        .filter(i => i.ratio === '16_9' && i.width >= 500)
        .sort((a, b) => (b.width || 0) - (a.width || 0))
        .filter(i => { const k = getImageKey(i.url); if (seenKeys.has(k)) return false; seenKeys.add(k); return true; })
        .slice(0, 4)
        .map(i => i.url);

      const result = {
        event: {
          ...mapEvent(e),
          // Extended details
          photos,
          venue_details: venue ? {
            name: venue.name,
            address: venue.address?.line1 || null,
            city: venue.city?.name || null,
            state: venue.state?.stateCode || null,
            postal_code: venue.postalCode || null,
            country: venue.country?.name || null,
            location: venue.location ? {
              latitude: parseFloat(venue.location.latitude),
              longitude: parseFloat(venue.location.longitude),
            } : null,
            upcoming_events: venue.upcomingEvents?._total || 0,
          } : null,
          attractions: (e._embedded?.attractions || []).map(a => ({
            name: a.name,
            url: a.url || null,
            image_url: getBestImage({ images: a.images || [], _embedded: {} }),
          })),
          date_end: e.dates?.end?.localDate || null,
          time_end: e.dates?.end?.localTime || null,
          timezone: e.dates?.timezone || null,
          on_sale: e.dates?.status?.code === 'onsale',
          ticketing: e.ticketing ? {
            safe_tix: e.ticketing.safeTix?.enabled || false,
          } : null,
        },
      };

      setCache(cacheKey, result);
      res.json(result);
    } catch (err) {
      console.error('[Events] Details error:', err);
      res.status(500).json({ error: 'Failed to get event details' });
    }
  }
);

module.exports = router;

// Test hooks only. The cache and the budget are process-wide in-memory state,
// so a test suite needs a clean start per case and a way to move the clock the
// cache reads without moving the process clock. Nothing in the server calls it.
module.exports.__test = {
  reset() {
    eventCache.clear();
    lastCacheKey = null;
    tmUserBudget.reset();
    tmDayCount = 0;
    tmDayKey = new Date().toISOString().slice(0, 10);
    tmDownUntil = 0;
    tmConsecutiveFailures = 0;
  },
  clearBreaker() { tmDownUntil = 0; tmConsecutiveFailures = 0; },
  breakerOpen: () => tmDownUntil > Date.now(),
  FAILURES_TO_OPEN: TM_FAILURES_TO_OPEN,
  // Pretend every cached entry was written `ms` ago.
  ageCache(ms) {
    for (const entry of eventCache.values()) entry.ts -= ms;
  },
  lastCacheKey: () => lastCacheKey,
  spent: () => tmDayCount,
  budgetLimits: { ...tmUserBudget.limits, globalDaily: TM_GLOBAL_DAILY },
  parseLocation,
  CACHE_TTL,
  NEGATIVE_TTL,
};
