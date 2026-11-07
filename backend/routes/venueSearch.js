const express = require('express');
const { query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const { upstreamSignal } = require('../utils/upstream');
// The one shape rule for a Google place id. routes/checkin.js, flocks.js,
// feedback.js, venueProfile.js, venueDashboard.js, sockets/handlers.js and
// routes/crowd.js all gate on this; /details was the last paid Places surface
// that did not (see the block above it).
const { isPlaceIdShaped } = require('../utils/places');
// Google's `timeZone` off a place, as a validated IANA name or null. The same
// read routes/crowd.js makes for the card. See the field mask note below.
const { placeTimeZone } = require('../utils/venueZone');
// One row per place in a search answer.
const { dedupeSearchRows } = require('../utils/searchRowDedupe');
// Google's credit for a photo (author name and profile link, the photo's page
// on Google Maps), which the app has to draw with it. Off the same Photo object
// the masks below already ask for, so no new field and no new SKU.
const { photoCredit } = require('../utils/placePhotoCredit');
// Per-user Places budget: 30/hour fresh calls, 3000/day globally. Shared with
// crowd.js and ai.js so every paid Places fetch draws from the SAME pool
// (round 8). allowGlobalPlacesCall is the door for surfaces with no
// authenticated user to charge — here, the public photo proxy (round 15).
// PER_USER_HOURLY and GLOBAL_DAILY are imported, not retyped: VENUE_CACHE_MAX
// is sized AGAINST them and a copied constant is an inequality that silently
// stops holding. The photo proxy's own sub-ceiling no longer lives in this file
// at all: it is a dollar budget in services/photoStore.js, kept in Postgres.
const {
  allowPlacesSearch, allowGlobalPlacesCall, placesRetryAfter, globalPlacesRetryAfter,
  PER_USER_HOURLY, GLOBAL_DAILY,
} = require('../utils/placesBudget');
// Free outage detection, counted beside the spend it cannot see: a refused
// call costs nothing, so the money watch stays quiet through a total
// outage. See utils/placesHealth.js.
const { recordPlacesResult } = require('../utils/placesHealth');
const {
  waitPhrase, refusalBody, retryAfterSeconds, resetsAtISO,
  msUntilUtcMidnight, msUntilUtcMonthStart,
} = require('../utils/retryAfter');
// ONE raw Place Details response per venue, shared with routes/crowd.js. This
// file and that one used to each buy their own copy of the same payload for the
// same place id in the same tick — see the header of services/placeDetailsCache.js
// and the Places section of services/costModel.js. The cache, the in-flight
// coalescing and the field mask for /details all live there now; what stays
// here is the charge and the response shape.
const {
  willCostUpstreamCall, fetchPlaceDetails,
  // The photo proxy's heal reads a place's current photo names from the same
  // module: a cached payload when there is one, else a photos-only ask. See
  // healDeadPhoto below and PLACE_PHOTOS_FIELD_MASK there.
  photosLookupWillCost, fetchPlacePhotos,
} = require('../services/placeDetailsCache');
// A glyph tapped on the Discover map, turned into a place id with one free
// IDs-only Text Search. The cost note and the match rule live in that file.
const { lookupPoiPlace, normalizePoiName } = require('../services/poiPlaceResolver');
// The photo cache and the photo money, both durable, both in Postgres. Read the
// header of that file before changing any number here: it carries the annual
// dollar budget every photo limit is derived from, and the quoted Google terms
// the TTL is chosen against.
const {
  PHOTO_CACHE_TTL_MS, photoCacheKey, readStoredPhoto, writeStoredPhoto,
  chargePhotoFetch, refundPhotoFetch, photoSpendStatus,
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
// year at $7.00 per 1,000, more than twelve times the agreed budget to
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

// How long this address waits, in milliseconds. Non-consuming, and only
// meaningful after allowPhotoFetch has already said no. The window is a ROLLING
// hour, so the wait is until the OLDEST live hit ages out, which is a number
// this map already holds and the refusal used to throw away.
function photoFetchRetryMs(req) {
  const now = Date.now();
  const hits = (photoIpHits.get(req.ip || 'unknown') || []).filter((t) => now - t < 3600_000);
  if (hits.length < PHOTO_MISS_PER_IP_HOURLY) return 0;
  return Math.max(1, hits[hits.length - PHOTO_MISS_PER_IP_HOURLY] + 3600_000 - now);
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
// a handle for one specific photo, and Google never swaps the bytes behind it.
// And what is cached is the BYTES, not the short-lived signed `photoUri` the
// metadata call returns, so an entry does not rot when that URL expires
// either. The TTL is therefore a TERMS decision and not a freshness one, which
// is why it lives in photoStore.js next to the clauses it was chosen against.
//
// A NAME IS MINTED PER ANSWER, NOT PER PHOTO. Google gives the same photo a
// new resource name on every Places answer (measured 2026-11-06: two id,photos
// lookups of one place 3 s apart shared 0 of 10 names, for each of two
// places). So an entry is hit only by requests for names out of one answer: a
// search or details payload while it is cached, and the URLs stored on rows
// (flocks, messages), which is also why those stored names expire. A later
// answer about the same venue buys its photos again.
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

// Drop one entry and keep the byte counter honest. Every deletion outside the
// eviction loops in storePhoto goes through here, because a delete that forgets
// the subtraction leaves photoCacheBytes ABOVE what the map actually holds, and
// a counter that has drifted upward evicts live photos to make room that is
// already there. __tests__/photoCacheCost.test.js asserts the counter equals the
// sum of the buffers, which is what catches a missed subtraction.
//
// It takes a KEY and re-reads the map rather than taking an entry the caller
// already has in hand, which is what makes it safe to call twice: two requests
// for the same expired key both hold the same entry object, and a version that
// trusted that reference would subtract its length twice and push the counter
// below zero.
function dropPhotoEntry(cacheKey) {
  const entry = photoCache.get(cacheKey);
  if (!entry) return false;
  photoCache.delete(cacheKey);
  photoCacheBytes -= entry.buffer.length;
  return true;
}

// One L1 read, for GET /photo and for healDeadPhoto alike: the entry, or null.
//
// A hit is what makes the entry recently used; without the re-insert the map
// is FIFO and the eviction comment above would be a lie.
//
// An entry past the window is DELETED here rather than stepped over. This read
// is the one moment the process is certain these bytes are expired, and merely
// skipping them kept Places content in memory past the 30-day window until
// either the cache grew to 32 MB or a deploy threw it away (see
// prunePhotoMemory). The caller's answer is unchanged: its flight reads L2 or
// re-buys the photo exactly as it did when the entry was skipped, and
// storePhoto puts a fresh entry back.
function readPhotoMemory(cacheKey) {
  const cached = photoCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.ts < PHOTO_CACHE_TTL) {
    touchPhotoCache(cacheKey, cached);
    return cached;
  }
  dropPhotoEntry(cacheKey);
  return null;
}

// ---------------------------------------------------------------------------
// THE HEAP SIDE OF THE 30-DAY WINDOW, WHICH NOTHING WAS ENFORCING.
// ---------------------------------------------------------------------------
// PHOTO_CACHE_TTL is a TERMS decision and not a freshness one: the note above it
// says so, and services/photoStore.js carries the clause it was chosen against.
// That makes the deletion an obligation rather than housekeeping, so bytes past
// the window have to LEAVE whether or not anything is short of space. The
// durable tier honours that on a timer — server.js runs prunePhotoStore()
// hourly, and its comment there calls the deletion a terms obligation in as
// many words. L1 honoured it nowhere. An expired entry was SKIPPED by the read
// in GET /photo and left sitting in the map, and storePhoto's expired-entry
// sweep above only runs once photoCacheBytes is over MAX_PHOTO_CACHE_BYTES —
// 32 MB, which a container at this traffic never reaches. So time-expired
// Places bytes stayed in the heap until the next deploy emptied it, and the
// claim that the expiry is enforced on the read path AND on a timer was only
// ever true of the half that lives in Postgres.
//
// A FULL SCAN WITH NO EARLY BREAK, on purpose. photoCache insertion order is
// LRU order, not age order (touchPhotoCache re-inserts a hit at the back), so
// the first live entry says nothing about the rest of the map and stopping there
// would leave older bytes behind.
//
// Not folded into storePhoto either. Sweeping on every insert is the per-write
// scan the low-water mark above exists to avoid, and an insert-time sweep still
// never fires in the process that holds expired bytes the LONGEST: the one that
// has stopped buying photos.
//
// Synchronous, and it cannot throw: a caller on a timer needs no .catch.
function prunePhotoMemory(now = Date.now()) {
  let dropped = 0;
  for (const [k, v] of photoCache) {
    if (now - v.ts <= PHOTO_CACHE_TTL) continue;
    photoCache.delete(k);
    photoCacheBytes -= v.buffer.length;
    dropped += 1;
  }
  if (dropped > 0) console.log(`[Photo Proxy] expired ${dropped} cached photos from memory`);
  return dropped;
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

// ---------------------------------------------------------------------------
// A NAME GOOGLE REJECTS IS REMEMBERED, because asking again costs money.
// ---------------------------------------------------------------------------
// A failure is never written to the photo cache, and for a transient one (429,
// 5xx, a timeout) that is right: the next request should go back upstream.
// But a 400 or 404 on the metadata leg is Google saying this NAME is no good,
// and the answer will not change in an hour. One phone rendering five flock
// tiles whose stored photo names Google no longer accepts was five paid
// metadata calls per render, five 502s in the error rate, and five placeholder
// birds anyway. Those names are kept here, by the same hash the caches use
// (the name itself is never stored), for a day, and never asked about again
// for that day: GET /photo answers one with the place's current photo when it
// can (healDeadPhoto, below) and 404 when it cannot, without a charge for the
// name either way. Bounded, oldest out first; cleared with the rest of memory
// on a restart, which is when a re-ask is cheap enough to be worth it.
const DEAD_PHOTO_REF_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DEAD_PHOTO_REFS = 5000;
const deadPhotoRefs = new Map(); // photoCacheKey(ref, 0) -> ts
const deadPhotoKey = (photoRef) => photoCacheKey(photoRef, 0);

function rememberDeadPhotoRef(photoRef) {
  const key = deadPhotoKey(photoRef);
  deadPhotoRefs.delete(key);
  deadPhotoRefs.set(key, Date.now());
  while (deadPhotoRefs.size > MAX_DEAD_PHOTO_REFS) {
    deadPhotoRefs.delete(deadPhotoRefs.keys().next().value);
  }
}

function isDeadPhotoRef(photoRef) {
  const ts = deadPhotoRefs.get(deadPhotoKey(photoRef));
  if (ts === undefined) return false;
  if (Date.now() - ts > DEAD_PHOTO_REF_TTL_MS) {
    deadPhotoRefs.delete(deadPhotoKey(photoRef));
    return false;
  }
  return true;
}

const PHOTO_GONE = { status: 404, gone: true, error: 'That photo is no longer available.' };

// ---------------------------------------------------------------------------
// A DEAD NAME HEALS TO THE SAME PLACE'S CURRENT PHOTO.
// ---------------------------------------------------------------------------
// WHERE DEAD NAMES COME FROM. Every URL this proxy serves carries a Google
// photo NAME (photoUrl below; routes/ai.js and routes/publicCrowd.js build the
// same URL), and rows keep that URL long after the search that minted it:
// flocks.venue_photo_url (the plan's venue, copied as-is into a new plan by
// POST /flocks/:id/rerun), the venue cards in messages.venue_data and
// direct_messages.venue_data (and their copies in content_report_evidence),
// dm_pinned_venues.venue_photo_url and venue_profiles.photo_url. Google
// expires names ("the name can expire", Place Photos reference), so the
// chat list's flock tiles asked for names Google answers 400 INVALID_ARGUMENT
// and drew the placeholder bird on every load.
//
// THE PLACE ID IS INSIDE THE NAME (`places/{placeId}/photos/{photo}`), and a
// place id is the one part of it the terms let us keep. So healDeadPhoto
// answers a dead name with that place's CURRENT first photo:
//   * its current names come from services/placeDetailsCache.js
//     fetchPlacePhotos: free from a fresh venue-card payload or one already in
//     flight, else ONE photos-only Place Details request, which Google bills as
//     "Place Details Essentials IDs Only": $0, unlimited free usage. It is
//     still charged to the per-address gate and the shared Places ledger
//     before it is sent, as the photo proxy's own unit;
//   * the bytes then come through fetchPhotoOnce like any other photo, so L1,
//     L2, the gates and the photo budget apply to them unchanged, and a
//     current photo some card has already bought costs nothing more.
//
// SERVE TIME ONLY; NOTHING STORED IS REPAIRED. Writing the current name back
// into a flock row would store a photo NAME for months, which the Place Photos
// reference refuses ("You cannot cache a photo name") and services/photoStore.js
// keeps to in terms, and it would expire in its turn.
//
// WHAT IS REMEMBERED, PER PLACE, FOR A DAY (healedPlaces): the photoCacheKey
// of the current photo at both widths, which is a hash and never the name, or
// null when the lookup found nothing to show. A repeat request for ANY dead
// name of that place is then served from L1 or L2 with no Google call, and the
// entry is what holds a place to one lookup a day: it is written the moment a
// lookup is charged, and while it lives no second lookup is charged.
//
// WHAT A FAILED PURCHASE OF THE CURRENT PHOTO DOES TO THAT ENTRY depends on
// why it failed, because a retry is a lookup and, past the gates, a charged
// metadata call:
//   * Google refusing the photo as a dead name is its final word on that
//     name: the photo is forgotten (keys back to null) and the place keeps its
//     day. So is "Photo not found" (an answer with no image), but only for the
//     heal: the photo's position in the place's list goes on the entry's
//     `skips`, which the heal's pick passes over for a day, and not into the
//     shared dead-name memory, because a plain request for that name treats
//     the same answer as one to retry. A position and not a name, because
//     Google lists a place's photos in the same order on every answer but
//     names them anew each time: a skipped name never came round again, and
//     each reopened card bought the same image-less photo under its new name.
//   * A refusal of ours (one address's hourly gate, the shared ledger, the
//     photo budget) says when it lifts, so the place is held for that long,
//     never less than HEAL_RETRY_TTL_MS and never more than a day: one
//     address's spent hour does not hold every address off until tomorrow,
//     and a spent budget is not retried every hour until midnight.
//   * A Google fault after a charged call (a 5xx, a CDN failure, a timeout)
//     backs off: an hour, then two, then four, up to a day. The streak is kept
//     on the entry, which outlives its hold by a day for that, and a purchase
//     that succeeds clears it.
// Only the heal that wrote the entry may change it after its purchase answers:
// a newer heal of the place may have re-pointed it while the purchase was out,
// and an older answer must not undo that.
//
// A HOLD HOLDS WHEN THE NAMES ARE FREE TOO. A place's current photo names can
// come at no cost (a venue card's payload cached in the last ten minutes, or a
// details call in flight), and then no lookup is charged for the hold to stop.
// So the hold is checked again right before buying, and while it names a
// photo, no photo of the place is bought until it ends. It holds the place and
// not that one photo because Google names the same photo anew in every answer
// (see "A NAME IS MINTED PER ANSWER" above): matched by hash, a card reopened
// every ten minutes brought a name the hold had never seen each time, and a
// day-long 503 was a purchase every ten minutes, its fault streak climbing to
// a day's hold within the hour. After a forget (keys back to null) the next
// photo still goes ahead, and bytes some other request has bought meanwhile
// are served whatever the hold says.
//
// NO HEAL EVER WAITS ON A FLIGHT THAT IS HEALING (healingKeys). A heal runs
// inside the flight of the name it heals, and the photo it remembers or picks
// can be that very name, refused later: waiting on that flight is waiting on
// itself, the request never answers, and the flight never leaves photoInflight.
// So every wait a heal makes goes through joinableFlight, which refuses a
// flight whose key is healing. That rules out loops of heals as well: a heal
// only waits on a flight that has not started healing, so along any chain of
// waits each flight started healing later than the one waiting on it, and the
// chain can never come back round to where it began.
//
// BOUNDED. An entry follows a dead name, and a name becomes dead only after a
// metadata call the photo budget charged, so writes are bounded by its daily
// brake (PHOTO_FETCH_BURST_PER_DAY, 451) whoever is asking; MAX_HEALED_PLACES
// sits well above a day of that. Oldest out first, cleared on restart. An
// entry lives at most a day past its last write and holds two hashes, a fault
// count, two times and at most MAX_HEAL_SKIPS skipped positions (numbers, each
// for a day). healingKeys holds a key only for as long as that flight heals.
//
// A HEAL THAT CANNOT FINISH (no photos, a refusal, an error) answers PHOTO_GONE,
// the same 404 a dead name got before, and the app draws the bird as it did.
const HEALED_PLACE_TTL_MS = DEAD_PHOTO_REF_TTL_MS;
const HEAL_RETRY_TTL_MS = 60 * 60 * 1000;
const MAX_HEALED_PLACES = 5000;
// Places (New) lists at most ten photos for a place, so ten skips cover them all.
const MAX_HEAL_SKIPS = 10;
// placeId -> { keys: { 160, 400 } | null, until, faults, skips, keepUntil }.
// `until` ends the hold; `skips` are [{ index, until }], the positions in the
// place's photo list whose photo answered "Photo not found"; `keepUntil` ends
// the entry, and is later than `until` only while a fault streak or a skip has
// to be remembered.
const healedPlaces = new Map();
const healingKeys = new Set(); // cache keys of the flights healing right now

// `places/{placeId}/photos/{photo}` -> placeId, or null when that segment is not
// shaped like a place id (utils/places.js), so nothing else is ever looked up.
function placeIdOfPhotoRef(photoRef) {
  const m = /^places\/([^/]+)\/photos\//.exec(String(photoRef || ''));
  return m && isPlaceIdShaped(m[1]) ? m[1] : null;
}

// The place's entry, its hold over or not, until the entry itself expires.
function healedEntry(placeId) {
  const entry = healedPlaces.get(placeId);
  if (!entry) return null;
  if (Date.now() >= entry.keepUntil) {
    healedPlaces.delete(placeId);
    return null;
  }
  return entry;
}

// The place's entry while it holds the place, or null.
function readHealedPlace(placeId) {
  const entry = healedEntry(placeId);
  return entry && Date.now() < entry.until ? entry : null;
}

// Hold the place for `ttlMs`, carrying its fault streak unless told otherwise,
// and its skips always.
function rememberHealedPlace(placeId, keys, ttlMs = HEALED_PLACE_TTL_MS, faults = faultStreak(placeId)) {
  const now = Date.now();
  const until = now + ttlMs;
  const skips = liveSkips(healedEntry(placeId), now);
  healedPlaces.delete(placeId);
  healedPlaces.set(placeId, {
    keys,
    until,
    faults,
    skips,
    keepUntil: keepUntilFor(until, faults, skips, now),
  });
  while (healedPlaces.size > MAX_HEALED_PLACES) {
    healedPlaces.delete(healedPlaces.keys().next().value);
  }
}

function keepUntilFor(until, faults, skips, now) {
  return Math.max(until, faults > 0 ? now + HEALED_PLACE_TTL_MS : 0, ...skips.map((skip) => skip.until));
}

function liveSkips(entry, now = Date.now()) {
  return entry && entry.skips ? entry.skips.filter((skip) => now < skip.until) : [];
}

// Google answered "Photo not found" for the photo at `index` in the place's
// list, which this heal bought: the heal's pick passes over that position for a
// day, whatever the photo is named in later answers. Kept on the entry, never
// shared.
function skipForADay(entry, index) {
  const now = Date.now();
  entry.skips = [...liveSkips(entry, now).filter((skip) => skip.index !== index), { index, until: now + HEALED_PLACE_TTL_MS }]
    .slice(-MAX_HEAL_SKIPS);
  entry.keepUntil = keepUntilFor(entry.until, entry.faults, entry.skips, now);
}

// The positions in a place's photo list its entry skips today.
function skippedPositions(placeId) {
  return new Set(liveSkips(healedEntry(placeId)).map((skip) => skip.index));
}

function faultStreak(placeId) {
  const entry = healedEntry(placeId);
  return entry ? entry.faults : 0;
}

// How long a refusal of ours holds a place: its own wait, from an hour to a day.
function refusalHoldMs(retryMs) {
  return Math.min(HEALED_PLACE_TTL_MS, Math.max(HEAL_RETRY_TTL_MS, retryMs));
}

// How long the n-th Google fault in a row holds a place: 1h, 2h, 4h, up to a day.
function faultHoldMs(faults) {
  return Math.min(HEALED_PLACE_TTL_MS, HEAL_RETRY_TTL_MS * 2 ** Math.max(0, faults - 1));
}

// Google refused the photo this place heals to: forget it, keep the day.
function forgetHealedPhoto(placeId) {
  const entry = healedEntry(placeId);
  if (entry) entry.keys = null;
}

// The flight for `cacheKey` if a heal may wait on it, or null. One that is
// healing may be the waiter itself, or waiting on it.
function joinableFlight(cacheKey) {
  return healingKeys.has(cacheKey) ? null : (photoInflight.get(cacheKey) || null);
}

// What Google said, bounded, for the log. The body is JSON with an
// error.message on a 400; anything else is still worth a glance.
async function googleErrorText(res) {
  try {
    if (typeof res.text !== 'function') return '';
    // Google's error bodies are a few hundred bytes of JSON; the slice is for
    // the log line, not a defence, since the only upstream here is Google.
    const text = String(await res.text()).replace(/\s+/g, ' ').trim();
    return text.slice(0, 200);
  } catch {
    return '';
  }
}

/* ONLY A NO THAT IS ABOUT THIS NAME IS REMEMBERED. Google answers 400 for a
   bad API key ("API key not valid"), a quota or billing problem and a
   malformed request, as well as for a malformed photo name, and a 404 is
   what a name that once existed becomes. Remembering every 400 for a day
   would turn a ten-minute key outage into a day without photos for every
   name asked for during it, with the browser told to remember the no as
   well. So a 404 is always the name's fault; a 400 counts only when Google's
   own sentence talks about the resource and not about the key, the quota,
   or permission; and a 400 with no sentence at all is not remembered. */
function googleSaysNameIsBad(status, text) {
  if (status === 404) return true;
  if (status !== 400) return false;
  const t = String(text || '');
  if (!t) return false;
  if (/api key|apikey|quota|billing|permission|unauthenticated|rate limit|too many/i.test(t)) return false;
  return /photo|resource|name|not found|invalid/i.test(t);
}

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
//
// THREE MORE WAYS TO WALK, closed. The /media URL goes through the WHATWG URL
// parser inside fetch, which on an https URL reads `\` as `/`, reads `%2e` and
// `%2e%2e` (any case) as the dot-segments `.` and `..`, and drops tabs and
// newlines before it parses. So `places/ChIJabcdef/photos/a\..\..\..\x` reached
// /v1/places/x/media, and `%2e%2e` and `.\t.` walked the same way: still
// Google's host, never ours, but a path we did not mean to ask for, on our key.
// A segment may therefore hold no backslash, no `%`, and no control or space
// character. Google's names do not use any of them: they are letters, digits,
// `_` and `-` (every fixture under __tests__, and the six expired names logged
// on 2026-11-05).
// eslint-disable-next-line no-control-regex
const PHOTO_REF_RE = /^places\/[^/?#\\%\s\x00-\x1f\x7f]{1,128}\/photos\/[^/?#\\%\s\x00-\x1f\x7f]{1,2048}$/;
function isPhotoRefShaped(ref) {
  if (typeof ref !== 'string' || !PHOTO_REF_RE.test(ref)) return false;
  const segments = ref.split('/');
  return !segments.includes('..') && !segments.includes('.');
}

// ---------------------------------------------------------------------------
// WHAT A MISSING GOOGLE_PLACES_API_KEY IS ALLOWED TO SAY, and why it stays a 500.
// ---------------------------------------------------------------------------
// All three routes in this file answered this branch with our own internal
// string: "Google Places API key not configured" on /search and /details,
// "API key not configured" on /photo. frontend/src/App.js doVenueSearch renders
// the server's message verbatim in the search dropdown, on purpose (see the
// note above the /search validators), so a user who typed the name of a bar was
// shown a sentence about an environment variable. It is unactionable, and it
// narrates our deployment state to anybody with the app installed.
//
// THE COPY. A missing key is not a blip. It is off until an operator turns it
// back on, so a sentence ending "try again in a moment" would be a lie in the
// one direction that wastes the user's time. The honest sentence says three
// things: it is off, it is us, and retrying will not help.
//
// THE STATUS STAYS 500, DELIBERATELY, AND THIS IS THE SURPRISING HALF.
// 503 is the better code for "not configured" and is what routes/emailWebhook.js
// and routes/revenuecat.js use. It cannot be used here yet, because
// frontend/src/services/api.js buildHttpError REPLACES the server's message with
// "Flock's servers are having a moment. Try again in a minute." for every
// RETRYABLE_STATUSES member (502, 503, 504). On this branch that substitution
// would swap an accurate sentence for one that tells the user to wait out a
// minute that changes nothing. 500 is the only 5xx on which this file's copy
// actually reaches the person reading it. Move this to 503 in the SAME change
// that teaches buildHttpError to keep a JSON `error` string it was given.
const SEARCH_OFF = 'Venue search is turned off right now. Nothing you typed caused it, and retrying will not help.';
const DETAILS_OFF = 'Venue pages are turned off right now. Nothing you tapped caused it, and retrying will not help.';
// Google no longer has a listing under this venue's id (shapeDetails). Said
// plainly, with no suggestion to retry, because a retry gets the same answer.
const VENUE_GONE = 'This venue is no longer listed on Google, so its details cannot load.';
const PHOTOS_OFF = 'Venue photos are turned off right now. Retrying will not bring them back.';
// The one sentence for "Google did not answer", whichever way it failed to.
// Named rather than repeated because runTextSearch now has four exits that mean
// the same thing to a user and different things to a log, and four copies of a
// sentence is four chances for three of them to drift.
const UPSTREAM_SICK = 'Venue search is not answering right now. Try again in a moment.';

// ---------------------------------------------------------------------------
// WHAT A SPENT PLACES BUDGET IS ALLOWED TO SAY, in one place for this router.
//
// The rule the comment above the /search charge already stated and only that
// one call site obeyed: THE WINDOW IS AN HOUR, SO THE SENTENCE MAY NOT SAY
// SECONDS. /details was still answering "Loading venues too fast. Give it a few
// seconds." about the same ledger, so the same user got two different and
// mutually exclusive accounts of the same refusal depending on which request
// happened to be refused first.
//
// The daily leg gets its own sentence because it is not the same fact. The
// hourly leg is about this caller. The daily one is the whole app against a
// shared ceiling, and telling one person they searched too much when 3000 calls
// were spent by everybody is both untrue and unactionable.
// ---------------------------------------------------------------------------
function placesRefusal(res, userId, copy, cost = 1) {
  const { leg, ms } = placesRetryAfter(userId, cost);
  if (leg === 'global-day') return res.status(429).json(refusalBody(res, ms, copy.day(waitPhrase(ms))));
  // Not a window at all: an unidentifiable caller is refused every time, so
  // there is nothing honest to say about coming back later.
  if (leg === 'identity') return res.status(429).json({ error: copy.signedOut });
  return res.status(429).json(refusalBody(res, ms, copy.hour(waitPhrase(ms))));
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
      if (!API_KEY) return res.status(500).json({ error: PHOTOS_OFF });

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

      // Tier zero is the phone. A revalidation that names a copy we served
      // inside the 30-day window is answered 304 here, before L1, L2, the
      // gates or Google, because the only thing it asks is "are my bytes
      // still right" and the ETag already answers it: see photoEtag.
      const heldTag = heldPhotoEtag(req.headers['if-none-match'], cacheKey);
      if (heldTag) {
        setPhotoCacheHeaders(res, heldTag);
        return res.status(304).end();
      }

      // L1, this container's memory. Free, and the only tier that costs nothing
      // at all to consult. readPhotoMemory moves a hit to the back of the LRU
      // order and deletes an entry past the window.
      const cached = readPhotoMemory(cacheKey);
      if (cached) return sendPhoto(res, cached, cacheKey);

      // Everything past L1 rides ONE flight per key: the L2 database read, the
      // gates, and the Google call. A concurrent request for the same photo
      // therefore shares the answer without a second database round trip and
      // without a second charge: one purchase is one purchase however many
      // viewers are waiting on it. The gates moved INSIDE the flight when L2
      // arrived, because a photo already in Postgres must not be refused by a
      // spending limit: it costs nothing to serve.
      //
      // `heal` is this route's alone. A name Google has expired comes back as
      // the same place's current photo (healDeadPhoto); warmPhoto, which only
      // ever holds names a search just returned, leaves it off.
      const out = await photoFlight(photoRef, maxWidth, cacheKey, req, { heal: true });
      if (out.status !== 200) {
        // The header, not only the body. This response is what an <img> tag
        // receives, and an <img> never reads a JSON body: Retry-After is the
        // only channel a browser, a CDN or a retry loop can act on.
        if (out.retryMs) {
          res.set('Retry-After', String(retryAfterSeconds(out.retryMs)));
          return res.status(out.status).json({
            error: out.error,
            retryAfterSeconds: retryAfterSeconds(out.retryMs),
            resetsAt: resetsAtISO(out.retryMs),
          });
        }
        // A name that is gone is gone for the day here and for an hour in
        // the browser: an <img> re-rendered twenty times asks once, and a
        // wrong no (see googleSaysNameIsBad) costs a phone an hour, not a day.
        if (out.gone) res.set('Cache-Control', 'public, max-age=3600');
        return res.status(out.status).json({ error: out.error });
      }
      sendPhoto(res, out, cacheKey);
    } catch (err) {
      console.error('[Photo Proxy] Error:', err.message, '| ref:', req.query.ref?.slice(0, 60));
      res.status(500).json({ error: 'That photo could not be loaded. Try again in a moment.' });
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

// ---------------------------------------------------------------------------
// THE VALIDATOR, and why a revalidation never needs the bytes.
// ---------------------------------------------------------------------------
// Express gave every photo a weak ETag hashed from the BODY, so it could only
// answer "your copy is current" after this route had found the body: an L1
// read at best, and after any deploy an L2 read over the network to Postgres,
// or a paid Google fetch if L2 had let the row go. The conditional request
// carried everything needed to answer it without any of that.
//
// The ETag here is `p1-<32 hex of the cache key>-<when our copy was fetched,
// in base-36 seconds>`, weak because a re-fetch can hand back different bytes
// of the same photo at the same width. The key half says which photo and
// width (the key is already a hash, never the name). The time half says which
// purchase of it the phone holds, and it is what keeps the 30-day window in
// services/photoStore.js meaning something on the phone as well: a copy from
// a fetch inside the window is confirmed with a 304 and no lookup at all; a
// copy from an older fetch goes down the normal path, which reads L2 or
// re-buys the photo exactly as a revalidation always has. The server cannot
// be talked into anything by a forged tag. A 304 hands out no bytes and costs
// nothing, so the worst a made-up timestamp does is keep a phone showing a
// photo it already has.
const PHOTO_ETAG_RE = /^(?:W\/)?"p1-([0-9a-f]{32})-([0-9a-z]{1,11})"$/;

function photoEtag(cacheKey, fetchedAtMs) {
  return `W/"p1-${cacheKey.slice(0, 32)}-${Math.floor(fetchedAtMs / 1000).toString(36)}"`;
}

// The client's tag for THIS photo, if it names a copy fetched inside the
// window; null otherwise, and null for anything malformed or oversized, which
// then takes the ordinary path.
function heldPhotoEtag(ifNoneMatch, cacheKey, now = Date.now()) {
  if (typeof ifNoneMatch !== 'string' || !ifNoneMatch || ifNoneMatch.length > 4096) return null;
  const keyPart = cacheKey.slice(0, 32);
  for (const raw of ifNoneMatch.split(',')) {
    const tag = raw.trim();
    const m = PHOTO_ETAG_RE.exec(tag);
    if (!m || m[1] !== keyPart) continue;
    const fetchedAtMs = parseInt(m[2], 36) * 1000;
    // A stamp from the future was not minted here; one from outside the window
    // is exactly the copy that has to be looked at again.
    if (!Number.isFinite(fetchedAtMs) || fetchedAtMs > now + 60 * 1000) continue;
    if (now - fetchedAtMs >= PHOTO_CACHE_TTL) continue;
    return tag.startsWith('W/') ? tag : `W/${tag}`;
  }
  return null;
}

// Everything a photo response says about caching, for the 200 and the 304
// alike. A 304 updates the headers of the copy the browser already holds, so
// it has to repeat them: in particular Cross-Origin-Resource-Policy, which
// helmet sets to same-origin on every response, and a 304 left saying that
// would re-label a stored cross-origin photo as one the app may not embed.
function setPhotoCacheHeaders(res, etag) {
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
  if (etag) res.set('ETag', etag);
}

// A HEALED ANSWER IS THE ONE EXCEPTION TO `immutable`. Its URL names a photo
// Google refused, and its bytes are a different photo of the place, chosen
// today: a wrong "dead" verdict, or a later heal to another photo, must not
// stay pinned in a browser for 30 days. So it is kept for a day, the life of
// a healedPlaces entry, without `immutable`, and without our p1 validator,
// which heldPhotoEtag would confirm for the whole 30-day window. Express's own
// body-hash ETag still turns an unchanged answer into a 304.
const HEALED_PHOTO_MAX_AGE_S = Math.floor(HEALED_PLACE_TTL_MS / 1000);
function setHealedPhotoHeaders(res) {
  res.set('Cache-Control', `public, max-age=${HEALED_PHOTO_MAX_AGE_S}`);
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
}

function sendPhoto(res, { buffer, contentType, ts, healed }, cacheKey) {
  res.set('Content-Type', photoContentType(contentType));
  res.set('X-Content-Type-Options', 'nosniff');
  if (healed) {
    setHealedPhotoHeaders(res);
  } else {
    // No fetch time, no tag of ours: Express then falls back to its own
    // body-hash ETag, which is what every photo carried before.
    setPhotoCacheHeaders(res, cacheKey && Number.isFinite(ts) ? photoEtag(cacheKey, ts) : null);
  }
  res.send(buffer);
}

// The ONE flight per cache key that the in-flight note above describes, for
// GET /photo and for healDeadPhoto alike, so a heal that wants a photo another
// request is already buying rides that purchase instead of making its own.
function photoFlight(photoRef, maxWidth, cacheKey, req, opts) {
  let flight = photoInflight.get(cacheKey);
  if (!flight) {
    flight = fetchPhotoOnce(photoRef, maxWidth, cacheKey, req, opts);
    photoInflight.set(cacheKey, flight);
    flight.then(() => photoInflight.delete(cacheKey));
  }
  return flight;
}

// The worker behind the photo proxy. Never rejects: resolves to
// { status: 200, buffer, contentType, ts } or { status, error }, so a failure
// reaches every coalesced waiter as the same clean response and is never
// written to photoCache — only a real image is.
//
// `heal: true` (GET /photo only) turns the two PHOTO_GONE answers for a name
// Google has refused into healDeadPhoto's answer: the same place's current
// photo, or that same PHOTO_GONE when there is none to give. The heal runs
// through healInFlight, which marks this flight's key as healing for as long
// as it runs (see healingKeys).
async function fetchPhotoOnce(photoRef, maxWidth, cacheKey, req, { heal = false } = {}) {
  try {
    // Step 0: L2, the durable cache in Postgres. This is the tier that makes a
    // deploy free. It is consulted BEFORE any gate, because serving bytes we
    // already own costs nothing and no limit in this file is entitled to refuse
    // it. Its miss path, not its hit path, is what the gates below are for.
    const stored = await readStoredPhoto(cacheKey);
    if (stored) {
      storePhoto(cacheKey, stored);
      // `ts` is when this copy was bought, carried so the ETag can say so.
      return { status: 200, buffer: stored.buffer, contentType: stored.contentType, ts: stored.ts };
    }

    // Step 0-and-a-half: a name Google already refused today. Answered before
    // every gate below, because it costs nothing and would otherwise cost a
    // paid call, again, for the same no.
    if (isDeadPhotoRef(photoRef)) return heal ? healInFlight(cacheKey, photoRef, maxWidth, req) : PHOTO_GONE;

    // Step 0a: the abuse gate. Per address, on MISSES only, so one script cannot
    // spend a budget everyone draws on. Nothing about money is decided here.
    if (!allowPhotoFetch(req)) {
      const ms = photoFetchRetryMs(req);
      return {
        status: 429,
        retryMs: ms,
        error: `A lot of new photos have loaded from here in the last hour. New ones come back ${waitPhrase(ms)}. Photos already loaded keep showing.`,
      };
    }

    // Step 0b: the shared paid-Places ledger. This proxy is unauthenticated and
    // its first leg (the /media metadata call) is a PAID Places request, so its
    // spend has to reach the same ceiling every other paid Google surface does.
    // Cost 1: only the metadata leg is believed to be metered. The second leg
    // pulls bytes from Google's CDN with the returned photoUri. If an invoice
    // ever shows that leg billed too, this is a 2 (see utils/upstream.js).
    // `photo: true` marks the unit as this door's in the same in-memory window
    // as the rest of the ledger, which is what lets the admin cost panel split
    // photos from Text Search and Place Details without mixing a whole-day
    // durable count into a since-the-last-deploy one.
    if (!allowGlobalPlacesCall(1, { photo: true })) {
      // A shared UTC-day ceiling, not this address's doing, so the sentence
      // does not describe the caller as having done anything.
      const ms = globalPlacesRetryAfter(1).ms || msUntilUtcMidnight();
      return {
        status: 429,
        retryMs: ms,
        error: `Flock has reached its venue lookup limit for the day. New photos come back ${waitPhrase(ms)}. Photos already loaded keep showing.`,
      };
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
      // THREE DIFFERENT ANSWERS BEHIND ONE SENTENCE, and one of them was not a
      // rate limit at all. chargePhotoFetch already names which ceiling refused
      // it and this route was discarding that:
      //   day-burst          resets at 00:00 UTC, hours away
      //   month-budget       resets on the 1st, up to a month away
      //   ledger-unavailable is a Postgres fault, not a limit. It fails closed
      //                      on purpose, but answering 429 tells the caller
      //                      they asked too often, which is untrue, and tells
      //                      them to wait out a window that does not exist.
      //                      503 with a short Retry-After is what that is.
      if (charge.reason === 'ledger-unavailable') {
        return {
          status: 503,
          retryMs: 30_000,
          error: 'Photos are unavailable for a moment. Try again shortly.',
        };
      }
      const ms = charge.reason === 'month-budget' ? msUntilUtcMonthStart() : msUntilUtcMidnight();
      return {
        status: 429,
        retryMs: ms,
        error: `Flock has reached its photo budget for the ${charge.reason === 'month-budget' ? 'month' : 'day'}. New photos come back ${waitPhrase(ms)}. Photos already loaded keep showing.`,
      };
    }

    // Step 1: ask Google for the actual CDN url (JSON response)
    const metaUrl = `https://places.googleapis.com/v1/${photoRef}/media?maxWidthPx=${maxWidth}&key=${API_KEY}&skipHttpRedirect=true`;
    // Round 12: both legs of the photo proxy are outbound calls with no
    // deadline of their own — see utils/upstream.js.
    //
    // THE PHOTOS LEG OF THE PLACES ALARM. Place Photos has its own per-day
    // Google quota, so photos can be refused while search works, and this
    // proxy used to tell utils/placesHealth.js nothing. It records to its own
    // leg, once per request: a request that got its bytes, or a name Google
    // answered was bad, is Google working; a refusal, a CDN failure or no
    // answer at all is not.
    const PHOTOS = { leg: 'photos' };
    let metaRes;
    try {
      metaRes = await fetch(metaUrl, { signal: upstreamSignal('places') });
    } catch (err) {
      recordPlacesResult(false, 'unreachable', PHOTOS);
      throw err;
    }
    if (!metaRes.ok) {
      // The ref's length rides along with its prefix: a name Google rejects
      // is usually a truncated or stale one, and sixty characters of prefix
      // cannot show which. Google's own sentence says the rest.
      const why = await googleErrorText(metaRes);
      console.error('[Photo Proxy] Google API error:', metaRes.status, 'for ref:', photoRef.slice(0, 60),
        `(${photoRef.length} chars)`, why);
      if (googleSaysNameIsBad(metaRes.status, why)) {
        recordPlacesResult(true, null, PHOTOS);
        rememberDeadPhotoRef(photoRef);
        return heal ? healInFlight(cacheKey, photoRef, maxWidth, req) : PHOTO_GONE;
      }
      recordPlacesResult(false, `HTTP ${metaRes.status}`, PHOTOS);
      // A quota refusal (429) or a key or billing refusal (403) is Google
      // saying no before doing anything, and it bills nothing, so the charge
      // taken above goes back. During a photos outage every refused call used
      // to spend a unit of the month's budget for nothing. A timeout stays
      // charged: whether Google did the work is unknown.
      if (metaRes.status === 429 || metaRes.status === 403) await refundPhotoFetch(charge.day);
      return { status: 502, error: 'That photo is not loading right now. Try again in a moment.' };
    }
    const meta = await metaRes.json();
    if (!meta.photoUri) {
      // Google answered; it simply has no image for this name. `noImage` lets
      // the heal tell this final answer from a fault (healDeadPhoto).
      recordPlacesResult(true, null, PHOTOS);
      console.error('[Photo Proxy] No photoUri in response for ref:', photoRef.slice(0, 60));
      return { status: 404, noImage: true, error: 'Photo not found' };
    }

    // Step 2: fetch the actual image bytes from the CDN
    let imgRes;
    try {
      imgRes = await fetch(meta.photoUri, { signal: upstreamSignal('places') });
    } catch (err) {
      recordPlacesResult(false, 'photo CDN unreachable', PHOTOS);
      throw err;
    }
    if (!imgRes.ok) {
      recordPlacesResult(false, `photo CDN HTTP ${imgRes.status}`, PHOTOS);
      console.error('[Photo Proxy] CDN fetch failed:', imgRes.status, 'for ref:', photoRef.slice(0, 60));
      return { status: 502, error: 'That photo is not loading right now. Try again in a moment.' };
    }
    recordPlacesResult(true, null, PHOTOS);

    // Step 3: cache and return the image bytes
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

    // Store in BOTH tiers. L1 is byte-budgeted and least-recently-used (see
    // MAX_PHOTO_CACHE_BYTES above); L2 is what makes the purchase outlive this
    // container. The L2 write is deliberately not awaited: the bytes are already
    // the caller's answer, and a failed write costs a future re-fetch rather
    // than this request. photoStore logs its own failures and never rejects, so
    // there is no unhandled rejection to leak here.
    const ts = Date.now();
    storePhoto(cacheKey, { buffer, contentType, ts });
    if (buffer.length <= MAX_SINGLE_PHOTO_BYTES) writeStoredPhoto(cacheKey, { buffer, contentType });

    return { status: 200, buffer, contentType, ts };
  } catch (err) {
    console.error('[Photo Proxy] Error:', err.message, '| ref:', photoRef.slice(0, 60));
    return { status: 500, error: 'That photo could not be loaded. Try again in a moment.' };
  }
}

// What a heal answers with: the bytes, marked so sendPhoto gives them a day's
// Cache-Control instead of 30 days of `immutable` (setHealedPhotoHeaders). A
// copy, never the object a shared flight resolved to, because a direct
// request for that photo may be holding the same object.
const healedAnswer = (e) => ({
  status: 200, buffer: e.buffer, contentType: e.contentType, ts: e.ts, healed: true,
});

// The heal of the name behind the flight for `cacheKey`, with that key marked
// as healing while it runs, so no heal anywhere waits on this flight (see
// healingKeys and joinableFlight).
async function healInFlight(cacheKey, photoRef, maxWidth, req) {
  healingKeys.add(cacheKey);
  try {
    return await healDeadPhoto(photoRef, maxWidth, req);
  } finally {
    healingKeys.delete(cacheKey);
  }
}

// A healed place's current photo, from the tiers that cost nothing: L1, a
// purchase already in flight that is not itself healing, then L2. The
// asked-for width first, then the other, because a 400px photo drawn at 160
// beats the bird and buying the second width would be a second purchase. Null
// when no tier holds either.
async function heldHealedPhoto(keys, maxWidth) {
  for (const width of maxWidth === 160 ? [160, 400] : [400, 160]) {
    const key = keys[width];
    const mem = readPhotoMemory(key);
    if (mem) return healedAnswer(mem);
    const flight = joinableFlight(key);
    if (flight) {
      const out = await flight;
      if (out.status === 200) return healedAnswer(out);
      continue;
    }
    const stored = await readStoredPhoto(key);
    if (stored) {
      storePhoto(key, stored);
      return healedAnswer(stored);
    }
  }
  return null;
}

// Every heal buys the current photo at the card width. A pin is drawn from it
// as well as from a 160 (heldHealedPhoto above), so a card and a pin healing
// one dead name at the same moment ride one purchase instead of making two.
const HEAL_WIDTH = 400;

// The current photo's purchase: the ordinary flight for its key, joined when
// one is already buying it and started without `heal` when none is. Null when
// the flight holding that key is healing, which means Google has refused that
// photo too, and waiting on it could be waiting on this very heal.
function healPurchase(photoRef, cacheKey, req) {
  if (healingKeys.has(cacheKey)) return null;
  return photoFlight(photoRef, HEAL_WIDTH, cacheKey, req);
}

// Answer a name Google has refused with the same place's CURRENT first photo,
// or PHOTO_GONE. The block above healedPlaces says why and what it costs.
// Never rejects.
async function healDeadPhoto(deadRef, maxWidth, req) {
  try {
    const placeId = placeIdOfPhotoRef(deadRef);
    if (!placeId) return PHOTO_GONE;

    // Healed already today: the current photo by its hash, no Google call.
    // Unless the photo remembered is the very name Google has just refused:
    // then it is forgotten rather than served or waited on (its flight may be
    // the one running this heal), and the place keeps its day.
    const healed = readHealedPlace(placeId);
    if (healed && healed.keys) {
      if (healed.keys[160] === photoCacheKey(deadRef, 160) || healed.keys[400] === photoCacheKey(deadRef, 400)) {
        forgetHealedPhoto(placeId);
      } else {
        const held = await heldHealedPhoto(healed.keys, maxWidth);
        if (held) return held;
      }
    }

    // The place's current photo names. NO `await` FROM THE QUESTION TO THE
    // CALL: photosLookupWillCost is only true for this tick, and the stamp is
    // what makes any later request for this place wait a day for a lookup.
    // Free answers (a cached or in-flight payload, a place Google already said
    // is gone) skip every gate, because they cost nothing.
    if (photosLookupWillCost(placeId)) {
      // Looked up, or healed, within the day: the once-a-day rule stands.
      if (healed) return PHOTO_GONE;
      // The same two gates the metadata call passes. The unit is marked as
      // the photo proxy's: the SKU is $0, and the cost panel prices every
      // unmarked unit as Enterprise Place Details or Text Search.
      if (!allowPhotoFetch(req) || !allowGlobalPlacesCall(1, { photo: true })) return PHOTO_GONE;
      rememberHealedPlace(placeId, null);
    }
    const out = await fetchPlacePhotos(placeId);
    if (!out.ok) return PHOTO_GONE;

    // The first current photo, skipping the refused name itself and any name
    // already known dead, so a heal can never loop back into one, and any
    // position whose photo answered "Photo not found" today. Read without
    // changing the list, which may be a cached payload's own array, or a
    // flight's shared answer.
    const skipped = skippedPositions(placeId);
    const index = out.photos.findIndex((photo, i) => {
      const name = photo && photo.name;
      return !skipped.has(i) && isPhotoRefShaped(name) && name !== deadRef && !isDeadPhotoRef(name);
    });
    if (index < 0) return PHOTO_GONE;
    const current = out.photos[index].name;

    // Hashes, never the name (see healedPlaces). Written before the bytes are
    // fetched, and in the same tick as the flight below, so a request for
    // another dead name of this place rides this purchase.
    const keys = { 160: photoCacheKey(current, 160), 400: photoCacheKey(current, 400) };
    const mem = readPhotoMemory(keys[maxWidth]) || readPhotoMemory(keys[HEAL_WIDTH]);
    // The hold, checked again now that only buying is left: names that came
    // free never license a purchase before it ends. It holds the place, not
    // the photo its hashes name, because a free answer names that photo anew.
    if (!mem && healed && healed.keys) return PHOTO_GONE;
    // Bytes some other request bought end the place's fault streak.
    rememberHealedPlace(placeId, keys, HEALED_PLACE_TTL_MS, mem ? 0 : faultStreak(placeId));
    if (mem) return healedAnswer(mem);
    // ONE try per request. No `heal` on this purchase: the current name goes
    // through fetchPhotoOnce like any other, and if Google refuses it too the
    // answer is PHOTO_GONE, never a heal of the heal; the next request picks the
    // next photo.
    const purchase = healPurchase(current, keys[HEAL_WIDTH], req);
    const fresh = purchase ? await purchase : PHOTO_GONE;

    // The entry is this heal's to change only if it is still the one this heal
    // wrote. While the purchase was out, a newer heal of the place may have
    // forgotten this photo and chosen another; this older answer must not
    // forget that one or point the place back at this one.
    const entry = healedEntry(placeId);
    const mine = entry && entry.keys === keys ? entry : null;
    if (fresh.status === 200) {
      if (mine && mine.faults) {
        mine.faults = 0;
        mine.keepUntil = mine.until;
      }
      return healedAnswer(fresh);
    }
    if (mine) {
      if (fresh.gone || fresh.noImage) {
        // Google refused the photo just chosen: forget it, keep the day.
        mine.keys = null;
        // "Photo not found" is final for the heal only (see healedPlaces).
        if (fresh.noImage) skipForADay(mine, index);
      } else if (Number.isFinite(fresh.retryMs)) {
        // A gate, the ledger or the budget refused it, and said when to come back.
        rememberHealedPlace(placeId, keys, refusalHoldMs(fresh.retryMs));
      } else {
        // A Google fault after a charged call: back off, longer each time.
        const faults = mine.faults + 1;
        rememberHealedPlace(placeId, keys, faultHoldMs(faults), faults);
      }
    }
    return PHOTO_GONE;
  } catch (err) {
    console.error('[Photo Proxy] heal failed:', err.message);
    return PHOTO_GONE;
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
// AND WHY timeZone IS HERE BESIDE IT (2026-09-25). The offset is the one in
// force when Google answered, and the app keeps a result list and re-scores it
// through the batch once its scores are half an hour old. Across the venue's
// own clock change (2 AM on 2026-11-01 in New York) that snapshot is an hour
// off, so the pins were scored an hour away from the venue card, which reads
// the zone. `timeZone` is the venue's IANA name, right at any instant; the app
// forwards it with the offset and the batch prefers it. The details shape
// below carries it too: services/placeDetailsCache.js already asks for it.
//
// BILLING: NO CHANGE. Places API (New) prices per FIELD and bills a request at
// the HIGHEST SKU any requested field belongs to. utcOffsetMinutes and timeZone
// are both **Pro** fields in Text Search and Place Details, and the mask below
// and the details mask in services/placeDetailsCache.js both already ask for
// currentOpeningHours / rating / userRatingCount / priceLevel (plus
// nationalPhoneNumber and websiteUri on details) — all **Enterprise**. Both
// requests were already billed at Enterprise, so the marginal cost of either
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
  'places.timeZone',
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

// GET /api/venues/resolve-poi?name=Joe%27s%20Pizza&lat=37.3229&lng=-122.0322
//
// A place tapped on the Discover map (a restaurant, cafe, bar, club, cinema or
// museum the basemap draws from street zoom, in any city) answered with its
// Google place id, so the app can open it like any venue it found by search.
// One lookup per place, cached, charged to the caller's Places allowance only
// when Google is actually asked (services/poiPlaceResolver.js).
const MAP_PLACES_OFF = 'Opening places from the map is turned off right now. Search still works.';
const MAP_PLACE_NOT_FOUND = 'Google has no listing for that spot, so it cannot open here. Try searching for it by name.';
const MAP_PLACE_SICK = 'That place did not open. Try tapping it again in a moment.';
router.get('/resolve-poi',
  [
    query('name').isString().withMessage('That place has no name to look up.'),
    query('lat').isFloat({ min: -90, max: 90 }).withMessage('That spot is not on the map.'),
    query('lng').isFloat({ min: -180, max: 180 }).withMessage('That spot is not on the map.'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
      // `?name=a&name=b` arrives as an array, and so can either coordinate. Only
      // scalars reach the lookup, and nothing malformed costs a unit.
      if (typeof req.query.lat !== 'string' || typeof req.query.lng !== 'string') {
        return res.status(400).json({ error: 'That spot is not on the map.' });
      }
      const name = normalizePoiName(req.query.name);
      if (!name) return res.status(400).json({ error: 'That place has no name to look up.' });
      const lat = Number(req.query.lat);
      const lng = Number(req.query.lng);
      if (!API_KEY) {
        console.error('Map place lookup unavailable: GOOGLE_PLACES_API_KEY is unset');
        return res.status(500).json({ error: MAP_PLACES_OFF });
      }

      const out = await lookupPoiPlace({
        name, lat, lng, apiKey: API_KEY,
        charge: () => allowPlacesSearch(req.user.id),
      });
      if (out.refused) {
        return placesRefusal(res, req.user.id, {
          hour: (w) => `Flock looks up to ${PER_USER_HOURLY} places an hour, and this hour is used up. You can open places from the map again ${w}.`,
          day: (w) => `Flock has reached its venue lookup limit for the day. Places on the map open again ${w}.`,
          signedOut: 'Sign in again to open places from the map.',
        });
      }
      if (out.status === 200) return res.json({ place_id: out.placeId });
      if (out.status === 404) return res.status(404).json({ error: MAP_PLACE_NOT_FOUND });
      return res.status(out.status).json({ error: MAP_PLACE_SICK });
    } catch (err) {
      console.error('Map place lookup error:', err);
      res.status(500).json({ error: MAP_PLACE_SICK });
    }
  }
);

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
        console.error('Venue search unavailable: GOOGLE_PLACES_API_KEY is unset');
        return res.status(500).json({ error: SEARCH_OFF });
      }

      // Round 18: `?query=a&query=b` arrives as an ARRAY, walked past the
      // validator chain, and `.toLowerCase()` turned it into a 500 per request.
      // Anything that is not a scalar string is a 400, before it costs anything.
      //
      // NOT "Search query is required", which is what this said. The caller sent
      // one, twice, and is looking at it; a message that contradicts the screen
      // is the same defect as the length bound two lines above.
      if (typeof req.query.query !== 'string') {
        return res.status(400).json({ error: 'That search did not arrive as one term. Type it again.' });
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
          // "Give it a few minutes" was closer than "a few seconds" and still
          // not the window: 30 charges spent in a burst free their first unit a
          // full hour later, not a few minutes later. Say the real one.
          return placesRefusal(res, req.user.id, {
            hour: (w) => `Flock searches up to ${PER_USER_HOURLY} venues an hour, and this hour is used up. You can search again ${w}.`,
            day: (w) => `Flock has reached its venue lookup limit for the day. Search comes back ${w}.`,
            signedOut: 'Sign in again to search venues.',
          });
        }
        flight = runTextSearch(searchQuery, coarse, cacheKey);
        inflight.set(cacheKey, flight);
        flight.then(() => inflight.delete(cacheKey));
      }
      const out = await flight;
      if (out.status !== 200) return res.status(out.status).json({ error: out.error });
      res.json(out.result);
    } catch (err) {
      // Reached only when THIS handler throws. Every upstream failure is caught
      // inside runTextSearch and returned as a descriptor. So this sentence is
      // about us, and says so, rather than "Failed to search venues", which
      // reads to the person typing as though their search was the problem.
      console.error('Venue search error:', err);
      res.status(500).json({ error: 'Venue search hit a problem on our side. Try again in a moment.' });
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

    // Carried out of the try so the guards below can see it. The two reads are
    // deliberately in the same try: an upstreamSignal abort rejects the fetch
    // and a non-JSON body rejects the json(), and both are the same class of
    // failure (Google did not answer), so both belong to the same catch.
    const httpStatus = response.status;
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
    if (data && data.error) {
      console.error('Places API error:', data.error.status, data.error.message);
      recordPlacesResult(false, `error body ${data.error.status || ''}`.trim());
      return { status: 502, error: UPSTREAM_SICK };
    }

    // ---------------------------------------------------------------------
    // A FAILED SEARCH WAS BEING RENDERED AS "NO VENUES FOUND".
    // ---------------------------------------------------------------------
    // `response.ok` was never read on this path. Google's `{error:{...}}` body
    // is only ONE of the shapes a non-answer arrives in: a 5xx from Google's
    // edge, from Railway's egress or from any intermediary carries whatever
    // JSON that hop feels like ({"message":"backend unavailable"} is the shape
    // services/placeDetailsCache.js observed), and every one of those walked
    // past the check above into `data.places || []`. The route then answered
    // 200 {venues: [], total: 0}, which is the ONE answer the client is
    // allowed to print "No venues found. Try a different search." for. An
    // outage was being reported to the user as their spelling, which is the
    // exact defect the copy work above this function exists to prevent, and it
    // was reachable through the half of the path nobody had guarded.
    //
    // services/placeDetailsCache.js closed this for Place Details and wrote the
    // finding up in its own header; the fix never crossed to Text Search. The
    // guards are the same three, in the same order, for the same reasons.
    //
    // ORDER MATTERS: Google's own error body is read FIRST, because Places
    // (New) sends `{error:{...}}` under a 4xx and reclassifying it by status
    // would lose the status and message this file logs for an operator.
    if (httpStatus < 200 || httpStatus >= 300) {
      console.error('Places text search HTTP', httpStatus, 'with no error body');
      recordPlacesResult(false, `HTTP ${httpStatus}`);
      return { status: 502, error: UPSTREAM_SICK };
    }
    // A 200 whose body is not an object at all, or whose `places` is present
    // and is not a list. `places` ABSENT is the legitimate zero-result answer
    // and must stay a 200. Google omits the key rather than sending [].
    if (!data || typeof data !== 'object' || (data.places !== undefined && !Array.isArray(data.places))) {
      console.error('Places text search returned a body with no usable places list');
      recordPlacesResult(false, 'malformed body');
      return { status: 502, error: UPSTREAM_SICK };
    }

    // Map results to clean venue objects
    const venues = (data.places || []).map(place => {
      let photo = null;
      let credit = null;
      if (place.photos && place.photos.length > 0) {
        photo = photoUrl(place.photos[0].name);
        credit = photoCredit(place.photos[0]);
      }

      return {
        place_id: place.id,
        name: place.displayName?.text || '',
        formatted_address: place.formattedAddress || '',
        rating: place.rating || null,
        user_ratings_total: place.userRatingCount || 0,
        price_level: priceLevelToNum(place.priceLevel),
        photo_url: photo,
        // Who took photo_url, for the credit Google requires beside it.
        photo_attribution: credit,
        types: place.types || [],
        opening_hours: place.currentOpeningHours || null,
        location: place.location || null,
        // camelCase on purpose: this is the exact key POST /api/crowd/batch
        // whitelists off each body item, so the client forwards it untouched.
        // Nullable — Google omits it for some places, and a null here is what
        // makes the batch answer `venueClock.local: false` rather than pretend
        // the caller's clock was the venue's.
        utcOffsetMinutes: place.utcOffsetMinutes != null ? place.utcOffsetMinutes : null,
        // The venue's IANA zone as a plain name ("America/New_York"), under the
        // key the batch whitelists, or null when Google sends none. The batch
        // prefers it to the offset. See the field mask note above.
        timeZone: placeTimeZone(place),
      };
    });

    recordPlacesResult(true);
    // One row per place, before the answer is cached (utils/searchRowDedupe.js):
    // "tor" listed Tor Chimney & Fireplace twice in one answer.
    const rows = dedupeSearchRows(venues);
    const result = { venues: rows, total: rows.length };
    setCache(cacheKey, result);
    return { status: 200, result };
  } catch (err) {
    // A TIMEOUT AND A BUG ARE NOT THE SAME EVENT AND WERE ANSWERED AS ONE.
    // Everything reaching here used to be 500 "Failed to search venues", which
    // is wrong on both halves: the status blamed this server for an upstream
    // that did not answer, and the sentence reads to a user as though the
    // search itself was rejected.
    //
    // upstreamSignal('places') is AbortSignal.timeout(6000) and it REJECTS the
    // fetch with a TimeoutError; a non-JSON body (an HTML error page from a
    // proxy) rejects the json() with a SyntaxError. Both mean Google did not
    // answer, so both are gateway statuses, and the timeout gets the one code
    // that says what happened.
    //
    // WHY THE TIMEOUT IS A 500 AND NOT THE 504 IT OBVIOUSLY IS.
    // frontend/src/services/api.js retries every GET that answers 502, 503 or
    // 504, twice, with backoff (RETRYABLE_STATUSES). Each of those retries is
    // a fresh request to this route, which is a fresh utils/placesBudget.js
    // charge and a fresh PAID Google call, because a failure is never cached.
    // utils/upstream.js states the rule this would break in as many words:
    // aborting is a local act, Google has already received, parsed and metered
    // the request by the time our six-second deadline fires, so a retry is a
    // second invoice for a question we already paid to ask, and a slow upstream
    // is exactly when the retries pile up. Three invoices and twenty-one
    // seconds of spinner, to say the same thing.
    //
    // 500 also keeps the sentence. buildHttpError REPLACES the body message on
    // 502/503/504, so the honest "took too long" line only reaches a person on
    // a status the client does not treat as a gateway problem.
    //
    // Change this to 504 in the SAME commit that makes searchVenues pass
    // `retry: false`, and not before.
    //
    // The OTHER exits stay 502, deliberately, and the difference is whether
    // Google metered the request. An upstream that ANSWERED with a failure
    // (an error body, a 5xx from an edge, an HTML page from a proxy) is a
    // fast, usually transient no, and the client's retry is what turns a blip
    // into a result the user never had to see fail. An upstream that never
    // answered is the one case where the retry is guaranteed to be billed.
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    console.error('Venue search upstream failure:', err && err.name, err && err.message);
    if (timedOut) {
      return { status: 500, error: 'Venue search took too long to answer. Try that again in a moment.' };
    }
    return { status: 502, error: UPSTREAM_SICK };
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
        console.error('Venue details unavailable: GOOGLE_PLACES_API_KEY is unset');
        return res.status(500).json({ error: DETAILS_OFF });
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
        return placesRefusal(res, req.user.id, {
          hour: (w) => `Flock opens up to ${PER_USER_HOURLY} venue pages an hour, and this hour is used up. You can open another ${w}.`,
          day: (w) => `Flock has reached its venue lookup limit for the day. Venue details come back ${w}.`,
          signedOut: 'Sign in again to open venue details.',
        });
      }
      const out = shapeDetails(await fetchPlaceDetails(placeId));
      if (out.status !== 200) return res.status(out.status).json({ error: out.error });
      res.json(out.result);
    } catch (err) {
      console.error('Venue details error:', err);
      res.status(500).json({ error: 'Opening that venue hit a problem on our side. Try again in a moment.' });
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
    // Google answered that this place id names nothing: a listing that closed,
    // moved or was merged, usually on a venue a flock saved weeks ago. That is
    // an answer, not an outage, so it is a 404 and not the 502 below. A 502
    // told the user to try again in a moment, which cannot work, and every
    // retry was another paid call for the same answer.
    if (out.kind === 'not_found') {
      return { status: 404, error: VENUE_GONE };
    }
    // Same rule as runTextSearch above: Google's own message is logged, never
    // returned. It used to be the body of this 502, so a venue whose listing
    // Google had retired answered the detail sheet with "Places API: NOT_FOUND"
    // and a key problem answered it with the key problem. The 502 and the
    // "not cached, so the next request retries" behaviour are unchanged.
    if (out.kind === 'api') {
      console.error('Places API error (details):', out.message);
      return { status: 502, error: 'That venue is not loading right now. Try again in a moment.' };
    }
    // 'unconfigured' is not a failure of Google's and it is not transient, so
    // it may not wear the sentence that says to try again. The route's own
    // !API_KEY guard above normally catches it first; this is the second door,
    // because services/placeDetailsCache.js reads the environment at call time
    // and this file read it at require time. Same status, same reasoning as
    // SEARCH_OFF: 500 is the only 5xx whose message the client still prints.
    if (out.kind === 'unconfigured') {
      console.error('Venue details unavailable:', out.message);
      return { status: 500, error: DETAILS_OFF };
    }
    // Everything else is a transport failure, a timeout, or a body that was not
    // a place. "Failed to get venue details" told the user nothing and told an
    // operator nothing either, so the words change here.
    //
    // THE STATUS DOES NOT, and that is a decision rather than an omission.
    // 502 is the better code for an upstream that did not answer, but
    // services/placeDetailsCache.js reports a TIMEOUT and a bad body under one
    // `unreachable` kind, and timeouts dominate this class. A 502 here would
    // hand the whole class to the client's retry loop, and a retried Place
    // Details timeout is a second and third invoice for a request Google has
    // already metered. See the long note in runTextSearch's catch above, and
    // utils/upstream.js.
    console.error('Venue details upstream failure:', out.message);
    return { status: 500, error: 'That venue is not loading right now. Try again in a moment.' };
  }
  const p = out.place;
  const shown = (p.photos || []).slice(0, 5);
  const photos = shown.map(photo => photoUrl(photo.name, 600));
  // One credit per photo, index for index, null where Google sent none. The
  // sheet draws the credit of whichever photo is on screen.
  const photoAttributions = shown.map(photo => photoCredit(photo));

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
        photo_attributions: photoAttributions,
        // The SAME key the search results and the map pins carry. Without it,
        // frontend/src/App.js openVenueDetail() replaced the seed object it was
        // handed (which had a working photo_url) with this one (which did not),
        // so opening the detail sheet on a venue whose Place Details response
        // happens to omit photos turned a card that WAS showing a picture into
        // one showing a map-pin glyph. photos[0] is that same picture; the key
        // was the only thing missing.
        photo_url: photos[0] || null,
        photo_attribution: photoAttributions[0] || null,
        opening_hours: p.currentOpeningHours || null,
        types: p.types || [],
        location: p.location || null,
        google_maps_url: p.googleMapsUri || null,
        menu_url: null,
        // Same key the batch endpoint whitelists, same nullability. See the
        // field mask note above.
        utcOffsetMinutes: p.utcOffsetMinutes != null ? p.utcOffsetMinutes : null,
        // And the zone, the same way. Null for a payload cached before the
        // details mask asked for it.
        timeZone: placeTimeZone(p),
      },
    },
  };
}

module.exports = router;

// The heap half of the photo expiry, for the hourly timer in server.js that
// already runs prunePhotoStore() for the Postgres half. Exported the way
// routes/stories.js exports purgeExpiredStories, and for the same reason: an
// expiry that has to happen whether or not anybody asks for a photo needs a
// caller that is not a route. UNTIL THAT TIMER CALLS IT, the only thing that
// empties L1 of expired bytes is a read of that exact key or a 32 MB cache.
module.exports.prunePhotoMemory = prunePhotoMemory;

// Tests only (backend/__tests__/placesProxyAbuse.test.js). The photo DAY
// counter this used to reset no longer exists in this file: the money ledger is
// in Postgres now (services/photoStore.js), so resetPhotoBudget only clears the
// per-IP abuse table. Production code must never reset a spending counter.
module.exports.__test = {
  deadPhotoRefs,
  DEAD_PHOTO_REF_TTL_MS,
  MAX_DEAD_PHOTO_REFS,
  rememberDeadPhotoRef,
  // The heal (__tests__/photoHeal.test.js).
  healedPlaces,
  HEALED_PLACE_TTL_MS,
  HEAL_RETRY_TTL_MS,
  HEALED_PHOTO_MAX_AGE_S,
  refusalHoldMs,
  faultHoldMs,
  MAX_HEALED_PLACES,
  rememberHealedPlace,
  placeIdOfPhotoRef,
  isPhotoRefShaped,
  photoInflightSize: () => photoInflight.size,
  healingKeysSize: () => healingKeys.size,
  // Per-address misses, read without spending one.
  photoIpAddresses: () => [...photoIpHits.keys()],
  photoIpHitCount: (ip) => (photoIpHits.get(ip) || []).length,
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
  // The revalidation validator, pinned by __tests__/photoConditional.test.js.
  photoEtag,
  heldPhotoEtag,
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
/* ONE PHOTO, THROUGH THE ROUTE'S OWN PATH, for callers inside this process
   that want a photo cached before somebody asks for it.
   Published rather than reimplemented on purpose: fetchPhotoOnce is where the
   Postgres cache is read, the dead-name memo is consulted, the spend is
   charged, the size and content type are clamped and both cache tiers are
   written. A warmer that repeated any of that would be a second opinion on
   money, and the two would drift. It answers {status, buffer, contentType} on
   a hit and {status, error} otherwise; a warmer only cares which. */
module.exports.warmPhoto = (photoRef, maxWidth, req) =>
  fetchPhotoOnce(photoRef, maxWidth, photoCacheKey(photoRef, maxWidth), req);

module.exports.photoProxyStatus = () => photoSpendStatus();
module.exports.photoBudgetLimits = {
  budgetUsdPerYear: PHOTO_BUDGET_USD_PER_YEAR,
  fetchesPerMonth: PHOTO_FETCH_BUDGET_MONTH,
  burstPerDay: PHOTO_FETCH_BURST_PER_DAY,
};
