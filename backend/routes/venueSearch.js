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
// PER_USER_HOURLY and GLOBAL_DAILY are imported, not retyped: VENUE_CACHE_MAX
// is sized AGAINST them and a copied constant is an inequality that silently
// stops holding. The photo proxy's own sub-ceiling no longer lives in this file
// at all: it is a dollar budget in services/photoStore.js, kept in Postgres.
const {
  allowPlacesSearch, allowGlobalPlacesCall, PER_USER_HOURLY, GLOBAL_DAILY,
} = require('../utils/placesBudget');
// ONE raw Place Details response per venue, shared with routes/crowd.js. This
// file and that one used to each buy their own copy of the same payload for the
// same place id in the same tick — see the header of services/placeDetailsCache.js
// and the Places section of services/costModel.js. The cache, the in-flight
// coalescing and the field mask for /details all live there now; what stays
// here is the charge and the response shape.
const {
  willCostUpstreamCall, fetchPlaceDetails,
} = require('../services/placeDetailsCache');
// The photo cache and the photo money, both durable, both in Postgres. Read the
// header of that file before changing any number here: it carries the annual
// dollar budget every photo limit is derived from, and the quoted Google terms
// the TTL is chosen against.
const {
  PHOTO_CACHE_TTL_MS, photoCacheKey, readStoredPhoto, writeStoredPhoto,
  chargePhotoFetch, photoSpendStatus,
  PHOTO_FETCH_BUDGET_MONTH, PHOTO_FETCH_BURST_PER_DAY, PHOTO_BUDGET_USD_PER_YEAR,
} = require('../services/photoStore');

const router = express.Router();

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;

// ---------------------------------------------------------------------------
// The two limits on the UNAUTHENTICATED photo proxy, and which job each one has.
// ---------------------------------------------------------------------------
// These used to be one thing wearing two hats: a per-IP hourly rate AND a
// PUBLIC_PHOTO_BUDGET of 1,500 fetches a day, both in this process's memory,
// both destroyed by every deploy. The day counter was doing the money job
// badly. 1,500 a day is 45,656 a month, which is $311 a month or $3,738 a
// year at $7.00 per 1,000, more than twelve times what Jayden has agreed to
// spend, and it was doing it in the one place a limit must never be reached,
// because reaching it means a real person sees a venue card with no picture on
// it.
//
// SPLIT, so each limit answers one question:
//
//   THE MONEY QUESTION is services/photoStore.js chargePhotoFetch(). It is a
//   real count of billable Google fetches in Postgres, derived from one annual
//   dollar figure, and it survives deploys and is shared across instances. It
//   is a ceiling on the INVOICE.
//
//   THE ABUSE QUESTION is allowPhotoFetch() below. It is a per-address rate on
//   cache MISSES only, and it exists so that one script cannot spend a shared
//   budget that everybody else is drawing on. It is not a ceiling on anything
//   in dollars.
//
// Cache hits, in memory or from places_photo_cache, pass BOTH without being
// counted by either, which is the property that makes "photos always show" and
// "the bill stays near zero" the same design instead of opposite ones.
const photoIpHits = new Map();
// 300/hour per address was sized against a 1,500/day pool. Against a monthly
// budget of PHOTO_FETCH_BUDGET_MONTH it was absurd: a single address could
// spend the whole month in about sixteen hours. 100 misses an hour is far more
// than any real session needs. A person opening the app sees a few dozen
// venue cards, and on every subsequent load those are hits, which are free and
// uncounted. It makes a single address a rounding error against the day's
// brake rather than a threat to it.
const PHOTO_MISS_PER_IP_HOURLY = 100;
function allowPhotoFetch(req) {
  const now = Date.now();
  const ip = req.ip || 'unknown';
  const hits = (photoIpHits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (hits.length >= PHOTO_MISS_PER_IP_HOURLY) return false;
  hits.push(now);
  photoIpHits.set(ip, hits);
  if (photoIpHits.size > 5000) prunePhotoIpHits(now, ip);
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

// ---------------------------------------------------------------------------
// The photo cache, and the restart that was costing most of the invoice.
// ---------------------------------------------------------------------------
// Places photos are the largest single line in this project's real spend, and
// this cache is the only thing standing between a venue card and a billed
// Google call. It held each photo for ONE HOUR, then for seven days, and the
// TTL was never the binding problem: the map below lives in this container's
// heap, so EVERY DEPLOY threw the whole thing away and re-bought every photo in
// it. On 2026-08-19 this service deployed roughly fifteen times in one night.
// The daily cap looked like it was defending the budget; what it was actually
// metering was the same handful of venues being purchased over and over, and
// when it bound, a real person saw a venue card with no picture on it.
//
// So the map is now an L1 in front of a durable L2 in Postgres
// (services/photoStore.js, migration 046). A deploy still empties L1 and now
// costs nothing: the first request after it reads the bytes back out of the
// database instead of out of Google.
//
// THE BYTES CANNOT GO STALE. A photo resource name (`places/{p}/photos/{q}`) is
// a handle for one specific immutable photo; Google mints a new name when the
// photo changes rather than swapping the bytes behind an old one. And what is
// cached is the BYTES, not the short-lived signed `photoUri` the metadata call
// returns, so an entry does not rot when that URL expires either. The TTL is
// therefore a TERMS decision and not a freshness one, which is why it lives in
// photoStore.js next to the clauses it was chosen against.
const PHOTO_CACHE_TTL = PHOTO_CACHE_TTL_MS;
// ---------------------------------------------------------------------------
// The cap is in BYTES now, because the entry count never bounded anything.
// ---------------------------------------------------------------------------
// `MAX_PHOTO_CACHE = 500` bounded the number of entries and said nothing about
// their size, so the memory this map could hold was 500 times whatever Google
// happened to return. Counting entries is the wrong unit for a cache of images:
// the thing that OOMs a container is bytes.
//
// 32 MB at the ~40 KB a 400px Places photo actually weighs is around 800
// photos, which is MORE than the old entry cap allowed while being bounded in
// the dimension that can hurt. Per-entry ceiling on top: anything over 2 MB is
// served but not stored, so one oversized response cannot take a sixteenth of
// the cache for itself. A 400px JPEG is never close to that.
const MAX_PHOTO_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_SINGLE_PHOTO_BYTES = 2 * 1024 * 1024;
// Evict to a LOW-WATER MARK, not back to the ceiling, for the same reason
// prunePhotoIpHits and venueCache do it: a cache sitting exactly on its limit
// pays the expired-entry scan on every single insert forever. Ten percent of
// headroom means that scan runs once per ~3 MB of new photos instead.
const PHOTO_CACHE_LOW_WATER = Math.floor(MAX_PHOTO_CACHE_BYTES * 0.9);
// In-memory photo cache (avoids re-fetching from Google on every page load).
// Insertion order is LRU order: a hit re-inserts its key at the back, so
// eviction from the front drops the LEAST RECENTLY USED entry rather than the
// oldest one. With a 7-day TTL that difference is the whole point: FIFO would
// evict a venue everybody looks at because it was cached first.
const photoCache = new Map();
let photoCacheBytes = 0;

function touchPhotoCache(cacheKey, entry) {
  photoCache.delete(cacheKey);
  photoCache.set(cacheKey, entry);
}

function storePhoto(cacheKey, entry) {
  if (entry.buffer.length > MAX_SINGLE_PHOTO_BYTES) return;
  const existing = photoCache.get(cacheKey);
  if (existing) photoCacheBytes -= existing.buffer.length;
  photoCache.delete(cacheKey);
  photoCache.set(cacheKey, entry);
  photoCacheBytes += entry.buffer.length;

  // Expired entries first: they are free to drop and dropping them may be
  // enough. Then least recently used until the budget is met.
  if (photoCacheBytes <= MAX_PHOTO_CACHE_BYTES) return;
  const now = Date.now();
  for (const [k, v] of photoCache) {
    if (k === cacheKey || now - v.ts <= PHOTO_CACHE_TTL) continue;
    photoCache.delete(k);
    photoCacheBytes -= v.buffer.length;
  }
  if (photoCacheBytes <= MAX_PHOTO_CACHE_BYTES) return;
  while (photoCacheBytes > PHOTO_CACHE_LOW_WATER && photoCache.size > 1) {
    const oldest = photoCache.keys().next().value;
    if (oldest === cacheKey) break;
    photoCacheBytes -= photoCache.get(oldest).buffer.length;
    photoCache.delete(oldest);
  }
}

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
// Round 25 — this map used to carry `detail:` keys too. The details flight now
// lives in services/placeDetailsCache.js, because the request that duplicated
// it arrives at routes/crowd.js and a flight only deduplicates what can see it.
const inflight = new Map();      // search: cacheKey -> Promise<descriptor>
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
      // A HASH, not the name. Google's Place Photos reference says in terms
      // "You cannot cache a photo name", and this key is written to a database
      // row, so it must not BE the name. It is also the L1 key, so one photo
      // has one identity in both tiers.
      const cacheKey = photoCacheKey(photoRef, maxWidth);

      // L1, this container's memory. Free, and the only tier that costs nothing
      // at all to consult.
      const cached = photoCache.get(cacheKey);
      if (cached && Date.now() - cached.ts < PHOTO_CACHE_TTL) {
        // A hit is what makes this entry recently used; without the re-insert
        // the map is FIFO and the eviction comment above would be a lie.
        touchPhotoCache(cacheKey, cached);
        return sendPhoto(res, cached);
      }

      // Everything past L1 rides ONE flight per key: the L2 database read, the
      // gates, and the Google call. A concurrent request for the same photo
      // therefore shares the answer without a second database round trip and
      // without a second charge: one purchase is one purchase however many
      // viewers are waiting on it. The gates moved INSIDE the flight when L2
      // arrived, because a photo already in Postgres must not be refused by a
      // spending limit: it costs nothing to serve.
      let flight = photoInflight.get(cacheKey);
      if (!flight) {
        flight = fetchPhotoOnce(photoRef, maxWidth, cacheKey, req);
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

// ---------------------------------------------------------------------------
// The header this was missing, and why it is the one that matters here.
// ---------------------------------------------------------------------------
// This route echoed an upstream `Content-Type` verbatim onto a response served
// from the API origin, with no `X-Content-Type-Options`. Helmet sets nosniff
// globally in server.js, but this handler calls res.set on the same header name
// helmet already wrote, and the one thing this response is guaranteed to be is a
// document a browser will render: the sniffing question is live on exactly the
// responses where an image is expected and something else arrives.
//
// So: nosniff explicitly, next to the type it constrains, and the type itself
// CLAMPED rather than echoed. `contentTypeFor` is not defence against Google 
// it is defence against believing a third party's header on our own origin. If
// the upstream ever answers `text/html` for a photo, this route serves a
// document, not a page.
const ALLOWED_PHOTO_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
]);
function photoContentType(raw) {
  // Parameters (`; charset=...`) are not part of the type and have no meaning
  // on an image; drop them rather than trying to validate them.
  const base = String(raw || '').split(';')[0].trim().toLowerCase();
  return ALLOWED_PHOTO_TYPES.has(base) ? base : 'image/jpeg';
}

function sendPhoto(res, { buffer, contentType }) {
  res.set('Content-Type', photoContentType(contentType));
  res.set('X-Content-Type-Options', 'nosniff');
  // Matched to PHOTO_CACHE_TTL, from the same constant, and marked immutable.
  // This was a flat 86400 against a server cache that was then seven days, so
  // the browser came back for bytes we already had, twenty-nine times out of
  // thirty. `immutable` is honest here rather than optimistic: the URL carries
  // a photo RESOURCE NAME, which Google mints anew when a venue's photo changes
  // rather than swapping the bytes behind an existing one, so a given URL can
  // only ever mean one image. Every second a client holds a photo is a second
  // it cannot ask us for one, which is the cheapest tier of all.
  res.set('Cache-Control', `public, max-age=${Math.floor(PHOTO_CACHE_TTL / 1000)}, immutable`);
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.send(buffer);
}

// The worker behind the photo proxy. Never rejects: resolves to
// { status: 200, buffer, contentType } or { status, error }, so a failure
// reaches every coalesced waiter as the same clean response and is never
// written to photoCache — only a real image is.
async function fetchPhotoOnce(photoRef, maxWidth, cacheKey, req) {
  try {
    // Step 0: L2, the durable cache in Postgres. This is the tier that makes a
    // deploy free. It is consulted BEFORE any gate, because serving bytes we
    // already own costs nothing and no limit in this file is entitled to refuse
    // it. Its miss path, not its hit path, is what the gates below are for.
    const stored = await readStoredPhoto(cacheKey);
    if (stored) {
      storePhoto(cacheKey, stored);
      return { status: 200, buffer: stored.buffer, contentType: stored.contentType };
    }

    // Step 0a: the abuse gate. Per address, on MISSES only, so one script cannot
    // spend a budget everyone draws on. Nothing about money is decided here.
    if (!allowPhotoFetch(req)) {
      return { status: 429, error: 'Too many photo requests right now' };
    }

    // Step 0b: the shared paid-Places ledger. This proxy is unauthenticated and
    // its first leg (the /media metadata call) is a PAID Places request, so its
    // spend has to reach the same ceiling every other paid Google surface does.
    // Cost 1: only the metadata leg is believed to be metered. The second leg
    // pulls bytes from Google's CDN with the returned photoUri. If an invoice
    // ever shows that leg billed too, this is a 2 (see utils/upstream.js).
    if (!allowGlobalPlacesCall(1)) {
      return { status: 429, error: 'Too many photo requests right now' };
    }

    // Step 0c: the money. A real count of billable Google fetches, in Postgres,
    // derived from one annual dollar figure and surviving deploys and instances.
    // Charged BEFORE the fetch because Google bills a request it received even
    // when we abort it on a timeout. This is the ONE limit in this path that is
    // denominated in dollars; if it refuses, every photo already bought keeps
    // serving from the two tiers above and only a venue nobody has looked at
    // yet comes up empty.
    const charge = await chargePhotoFetch();
    if (!charge.allowed) {
      return { status: 429, error: 'Too many photo requests right now' };
    }

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

    // Store in BOTH tiers. L1 is byte-budgeted and least-recently-used (see
    // MAX_PHOTO_CACHE_BYTES above); L2 is what makes the purchase outlive this
    // container. The L2 write is deliberately not awaited: the bytes are already
    // the caller's answer, and a failed write costs a future re-fetch rather
    // than this request. photoStore logs its own failures and never rejects, so
    // there is no unhandled rejection to leak here.
    storePhoto(cacheKey, { buffer, contentType, ts: Date.now() });
    if (buffer.length <= MAX_SINGLE_PHOTO_BYTES) writeStoredPhoto(cacheKey, { buffer, contentType });

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
// (runTextSearch charges before it calls and writes exactly one key), so an
// account's writes are its Places allowance and nothing else. It holds only
// `search:` entries now — the `detail:` half moved to
// services/placeDetailsCache.js — which only widens the margin. 30/hour spent around the clock is 720 entries in a day, which
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
//
// THE `maxWidth` ARGUMENT IS A REQUEST, NOT A SIZE, AND THAT IS LOAD-BEARING ON
// THE PHOTO BILL. GET /photo snaps whatever arrives to exactly two values
// (`requested <= 200 ? 160 : 400`), so shapeDetails' `photoUrl(photo.name, 600)`
// and the search results' default 400 both resolve to 400 and therefore to the
// SAME sha256(`${photoRef}|${maxWidth}`) cache key. A venue card and that same
// venue's detail sheet are one purchase, in L1 and in places_photo_cache alike.
//
// So the fix for "the detail sheet asked for 600 and got 400" is NOT to add 600
// to the snap set. That would give every venue a second cache key, a second
// row, and a second billable Google fetch, for a photo already bought. The
// photo proxy is the largest single line in this project's real spend (see
// services/photoStore.js). If a bigger detail image is ever genuinely wanted,
// change the 400 rather than adding a size next to it.
function photoUrl(photoName, maxWidth = 400) {
  return `/api/venues/photo?ref=${encodeURIComponent(photoName)}&maxwidth=${maxWidth}`;
}

// ---------------------------------------------------------------------------
// FIELD MASK. Hoisted out of the fetch call on purpose: it is the most
// expensive one-line decision in this file (a mask decides the Google SKU the
// request is billed at) and it belongs somewhere a reader looks before
// extending it, not buried in a header object. Same shape as
// routes/publicCrowd.js PLACE_FIELDS.
//
// THE DETAILS MASK USED TO LIVE HERE TOO, and it now lives in
// services/placeDetailsCache.js as PLACE_DETAILS_FIELD_MASK — unchanged, field
// for field. It moved because routes/crowd.js was asking Google for a STRICT
// SUBSET of it, for the same place id, in the same tick as this file's own
// /details call, and paying for it. One owner of the payload is what let the
// second call go away. Everything the note below says about tiers applies to
// that mask exactly as it did when it was here.
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
// field in both Text Search and Place Details, and the mask below and the
// details mask in services/placeDetailsCache.js both already ask for
// currentOpeningHours / rating / userRatingCount / priceLevel (plus
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
    // TWO BOUNDS, TWO SENTENCES. One `.withMessage` covering both ends of an
    // isLength meant an 81-character query was answered "Search query is
    // required", about a query the user had visibly just typed. That string is
    // display copy: frontend/src/App.js doVenueSearch puts the server's own
    // message straight into the search dropdown, deliberately, so that a
    // failure is never dressed as "no venues found". A message that contradicts
    // what the user can see on screen is worse than a generic one.
    query('query').trim()
      .isLength({ min: 1 }).withMessage('Search query is required')
      .isLength({ max: 80 }).withMessage('That search is too long. Try just the name of the place.'),
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
        // THE WINDOW IS AN HOUR, SO THE SENTENCE MAY NOT SAY SECONDS.
        // allowPlacesSearch is PER_USER_HOURLY (30) over a ROLLING 60 minutes,
        // not a per-second rate. "Give it a few seconds" was advice that could
        // not work: a user who spent their allowance in a burst waits most of
        // an hour, retries after five seconds on the strength of this line,
        // gets the same refusal, and concludes search is broken rather than
        // rationed. The copy has to describe the limit that actually exists.
        //
        // It is reachable without abuse. Every uncached search is one unit and
        // a pause mid-word fires its own request, so an evening of planning
        // spends them. If real sessions start landing here the answer is the
        // NUMBER, in utils/placesBudget.js, which is a money decision; this is
        // only the sentence being true about whatever the number is.
        if (!allowPlacesSearch(req.user.id)) {
          return res.status(429).json({ error: 'You have searched a lot in the last hour. Give it a few minutes.' });
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

    // ---------------------------------------------------------------------
    // GOOGLE'S ERROR TEXT IS A LOG LINE, NOT A SENTENCE FOR A 17-YEAR-OLD.
    // ---------------------------------------------------------------------
    // This used to answer `Places API: ${data.error.message}`, and
    // frontend/src/App.js doVenueSearch renders the server's message verbatim
    // in the search dropdown, deliberately, so a failure is never dressed as
    // "no venues found". That contract makes every string returned here
    // display copy, and Google's strings are not: the real ones read "API key
    // not valid. Please pass a valid API key.", "Requests to this API ... are
    // blocked.", "Quota exceeded for quota metric 'Requests'". Two things
    // wrong with each. It tells a user typing the name of a bar something they
    // cannot act on, and it narrates our billing and key state to anybody with
    // the app installed.
    //
    // So: the status AND the message go to the log, where an operator can act
    // on them, and the caller gets one plain sentence. The STATUS CODE is
    // unchanged (502, and still uncached, so the next request retries), which
    // is what any client keying off err.status still keys off.
    if (data.error) {
      console.error('Places API error:', data.error.status, data.error.message);
      return { status: 502, error: 'Venue search is not answering right now. Try again in a moment.' };
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

      // THE CACHE AND THE FLIGHT ARE NOT THIS FILE'S ANY MORE. They moved to
      // services/placeDetailsCache.js so routes/crowd.js could share them: the
      // client fires GET /api/venues/details and GET /api/crowd/:placeId
      // together (App.js openVenueDetail, one Promise.allSettled), so the two
      // used to buy the SAME Enterprise Place Details response twice, from two
      // caches that could not see each other. Now whichever of the two arrives
      // first leads the flight and the other rides it.
      //
      // Round 8: details is the same PAID Google surface as text search —
      // rotating valid place ids bypassed the shared budget entirely. Round 18:
      // only the leader charges, one Google call, one unit. Both still hold;
      // what changed is that "am I the leader" is now a question about a
      // process-wide flight rather than about this router's own map.
      //
      // NO `await` BETWEEN THE QUESTION AND THE FETCH. willCostUpstreamCall is
      // only true for the rest of this tick, and fetchPlaceDetails registers
      // its flight synchronously; putting anything asynchronous between them
      // turns the charge into a guess.
      if (willCostUpstreamCall(placeId) && !allowPlacesSearch(req.user.id)) {
        return res.status(429).json({ error: 'Loading venues too fast. Give it a few seconds.' });
      }
      const out = shapeDetails(await fetchPlaceDetails(placeId));
      if (out.status !== 200) return res.status(out.status).json({ error: out.error });
      res.json(out.result);
    } catch (err) {
      console.error('Venue details error:', err);
      res.status(500).json({ error: 'Failed to get venue details' });
    }
  }
);

// GET /details's PROJECTION of the shared raw payload. Pure: same Places
// response in, same body out, no I/O and no cached state of its own — which is
// what makes it safe for the raw entry to be shared with a consumer that
// projects different fields from it (routes/crowd.js fetchVenueFromGoogle).
//
// The status codes are the ones runPlaceDetails used to return, unchanged and
// deliberately not merged: a Google `error` body is 502 with Google's own
// message, and everything else — a network failure, an upstreamSignal abort, a
// non-JSON body from a proxy, a missing API key — is 500 "Failed to get venue
// details". routes/crowd.js answers the same two cases with one null, which is
// why services/placeDetailsCache.js hands back a discriminated result instead
// of picking one of the two behaviours for both callers.
function shapeDetails(out) {
  if (!out.ok) {
    // Same rule as runTextSearch above: Google's own message is logged, never
    // returned. It used to be the body of this 502, so a venue whose listing
    // Google had retired answered the detail sheet with "Places API: NOT_FOUND"
    // and a key problem answered it with the key problem. The 502 and the
    // "not cached, so the next request retries" behaviour are unchanged.
    if (out.kind === 'api') {
      console.error('Places API error (details):', out.message);
      return { status: 502, error: 'That venue is not loading right now. Try again in a moment.' };
    }
    console.error('Venue details error:', out.message);
    return { status: 500, error: 'Failed to get venue details' };
  }
  const p = out.place;
  const photos = (p.photos || []).slice(0, 5).map(photo => photoUrl(photo.name, 600));

  return {
    status: 200,
    result: {
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
        // The SAME key the search results and the map pins carry. Without it,
        // frontend/src/App.js openVenueDetail() replaced the seed object it was
        // handed (which had a working photo_url) with this one (which did not),
        // so opening the detail sheet on a venue whose Place Details response
        // happens to omit photos turned a card that WAS showing a picture into
        // one showing a map-pin glyph. photos[0] is that same picture; the key
        // was the only thing missing.
        photo_url: photos[0] || null,
        opening_hours: p.currentOpeningHours || null,
        types: p.types || [],
        location: p.location || null,
        google_maps_url: p.googleMapsUri || null,
        menu_url: null,
        // Same key the batch endpoint whitelists, same nullability. See the
        // field mask note above.
        utcOffsetMinutes: p.utcOffsetMinutes != null ? p.utcOffsetMinutes : null,
      },
    },
  };
}

module.exports = router;

// Tests only (backend/__tests__/placesProxyAbuse.test.js). The photo DAY
// counter this used to reset no longer exists in this file: the money ledger is
// in Postgres now (services/photoStore.js), so resetPhotoBudget only clears the
// per-IP abuse table. Production code must never reset a spending counter.
module.exports.__test = {
  // Round 23 — the two sized-against-something numbers and the constants they
  // are sized against, so the inequalities are pinned from one source.
  VENUE_CACHE_MAX,
  VENUE_CACHE_LOW_WATER,
  PHOTO_MISS_PER_IP_HOURLY,
  PER_USER_HOURLY,
  GLOBAL_DAILY,
  CACHE_TTL,
  setCache,
  getCached,
  venueCacheSize: () => venueCache.size,
  clearVenueCache: () => venueCache.clear(),
  allowPhotoFetch,
  // Round 26: the photo cache is the only thing between a venue card and a
  // billed Google call, so its TTL, its budget and its eviction ORDER are all
  // pinned by __tests__/photoCacheCost.test.js rather than trusted.
  PHOTO_CACHE_TTL,
  MAX_PHOTO_CACHE_BYTES,
  MAX_SINGLE_PHOTO_BYTES,
  photoContentType,
  storePhoto,
  touchPhotoCache,
  photoCacheKeys: () => [...photoCache.keys()],
  photoCacheBytes: () => photoCacheBytes,
  getPhotoCached: (k) => photoCache.get(k),
  clearPhotoCache: () => { photoCache.clear(); photoCacheBytes = 0; },
  resetPhotoBudget({ clearIps = true } = {}) {
    if (clearIps) photoIpHits.clear();
  },
  photoCacheKey,
  fetchPhotoOnce,
};

// Non-consuming read of the photo proxy's own spend, for the admin cost panel
// (routes/admin.js, priced by services/costModel.js). This is the ONE meter in
// the repo that can tell a Place Photos request apart from a Text Search or a
// Place Details request: the shared ledger in utils/placesBudget.js counts calls
// without recording which SKU each one was, and Google prices Photos at $7 per
// 1,000 against $20 and $35 for the other two. Without this split the panel
// could only ever quote a band four times as wide as the real number.
//
// THE CAVEAT THAT USED TO SIT HERE IS GONE, which is the point of the change.
// This number came out of a module-scope integer, so it read zero after every
// deploy and divided by the instance count, so the panel reported a fraction
// of the photo spend on exactly the days there was most of it. It now comes from
// places_photo_spend, so it is one shared count that survives restarts and is
// what the invoice will say.
//
// One direction of error remains and it is the safe one: allowGlobalPlacesCall
// is charged just before chargePhotoFetch, so a photo refused by the durable
// budget has still spent a unit of the shared Places day. That makes the SHARED
// ledger able to overcount photos, never this one.
module.exports.photoProxyStatus = () => photoSpendStatus();
module.exports.photoBudgetLimits = {
  budgetUsdPerYear: PHOTO_BUDGET_USD_PER_YEAR,
  fetchesPerMonth: PHOTO_FETCH_BUDGET_MONTH,
  burstPerDay: PHOTO_FETCH_BURST_PER_DAY,
};
