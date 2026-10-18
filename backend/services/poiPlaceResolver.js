// A PLACE TAPPED ON THE MAP OPENS AS A VENUE, IN ANY CITY.
//
// Discover's basemap already draws restaurants, cafes, bars, nightlife and
// culture as small glyphs from street zoom (frontend
// components/map/flockStyle/buildFlockStyle.js). They come from OpenStreetMap
// through MapTiler and carry a name and a point, not a Google place id, so a tap
// on one did nothing, and outside the cities Flock collects in the map showed
// places nobody could open. This turns the tapped name and point into the Google
// place the rest of the app already opens (the venue sheet, its crowd card, Get
// Directions with Apple Maps first), with ONE Text Search that asks for the
// place id and nothing else.
//
// THE COST. A field mask of `places.id` alone is billed as "Places API Text
// Search Essentials (IDs Only)", which Google's pricing table lists at
// "Unlimited" free usage with no price per 1,000 (checked 2026-10-18 on
// developers.google.com/maps/billing-and-pricing/pricing). It is still a Text
// Search request against the project's daily Places quota, so the route charges
// it to the same per-user and global ledger every Places call draws on
// (utils/placesBudget.js), and an answer is cached, so a second tap on the same
// place spends nothing at all. ANY other field in POI_FIELD_MASK moves every
// call to Text Search Pro ($32 per 1,000) or higher: the venue sheet fetches the
// place's details itself, through services/placeDetailsCache.js, once it has the
// id, so nothing more is needed here. __tests__/poiPlaceResolver.test.js pins
// the mask.
//
// THE MATCH. The query is the glyph's own name, and the result is RESTRICTED
// (not biased) to a box about 150 m on each side of the tapped point, so the one
// id that comes back is a place by that name right there, or there is none and
// the answer is "not found". A generic name can still land on a near neighbour;
// the sheet then opens under that place's own name, which the person can see,
// rather than under the glyph's.
//
// THE CACHE. Google's Places terms exempt place ids from the caching limits, so
// ids may be kept; the bounds below are for memory. A "nothing there" answer is
// kept for an hour too, so repeated taps on a glyph Google does not know cost one
// lookup, not one per tap. Failures are never cached.

const { upstreamSignal } = require('../utils/upstream');
const { isPlaceIdShaped } = require('../utils/places');
const { recordPlacesResult } = require('../utils/placesHealth');

const POI_FIELD_MASK = 'places.id';
const POI_BOX_METERS = 150;
const POI_NAME_MAX = 120;

const FOUND_TTL_MS = 24 * 60 * 60 * 1000;
const NOT_FOUND_TTL_MS = 60 * 60 * 1000;
// Every write is behind a ledger charge, and the global day is 3000 charges, so
// one day's lookups fit with room to spare; the low-water mark keeps a full map
// from paying a scan on every write (the rule in routes/venueSearch.js setCache).
const POI_CACHE_MAX = 5000;
const POI_CACHE_LOW_WATER = 4500;

const METERS_PER_DEGREE = 111320;

const poiCache = new Map(); // key -> { placeId: string|null, ts, ttl }
const inflight = new Map(); // key -> Promise<descriptor>

// The name as the tile carries it, folded the way /search folds a query
// (NFKC, whitespace runs collapsed, trimmed). Null when it is not a usable name.
function normalizePoiName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!name || name.length > POI_NAME_MAX) return null;
  return name;
}

// Four decimals is about 11 m: two taps on the same glyph share an entry, and
// two different places a street apart do not.
function poiKey(name, lat, lng) {
  return `poi:${name.toLowerCase()}|${lat.toFixed(4)},${lng.toFixed(4)}`;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// A rectangle about `meters` on each side of the point, for locationRestriction.
// Longitude degrees shrink with latitude; the latitude used for that is held
// short of the poles so the box never grows without bound.
function boxAround(lat, lng, meters = POI_BOX_METERS) {
  const dLat = meters / METERS_PER_DEGREE;
  const dLng = meters / (METERS_PER_DEGREE * Math.cos((clamp(lat, -85, 85) * Math.PI) / 180));
  return {
    low: { latitude: clamp(lat - dLat, -90, 90), longitude: clamp(lng - dLng, -180, 180) },
    high: { latitude: clamp(lat + dLat, -90, 90), longitude: clamp(lng + dLng, -180, 180) },
  };
}

function readCache(key, now = Date.now()) {
  const entry = poiCache.get(key);
  if (!entry) return null;
  if (now - entry.ts > entry.ttl) {
    poiCache.delete(key);
    return null;
  }
  return entry;
}

function writeCache(key, placeId, now = Date.now()) {
  poiCache.delete(key);
  poiCache.set(key, { placeId, ts: now, ttl: placeId ? FOUND_TTL_MS : NOT_FOUND_TTL_MS });
  if (poiCache.size > POI_CACHE_MAX) {
    for (const [k, v] of poiCache) {
      if (now - v.ts > v.ttl) poiCache.delete(k);
    }
    while (poiCache.size > POI_CACHE_LOW_WATER) {
      poiCache.delete(poiCache.keys().next().value);
    }
  }
}

// The one Google call. Never rejects: resolves to a descriptor, so a coalesced
// waiter can never be handed a throw, and only a real answer is cached.
async function askGoogle({ name, lat, lng, apiKey, fetchImpl }) {
  try {
    const response = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': POI_FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: name,
        pageSize: 1,
        locationRestriction: { rectangle: boxAround(lat, lng) },
      }),
      signal: upstreamSignal('places'),
    });
    const httpStatus = response.status;
    const data = await response.json();
    // Same three guards, same order, as runTextSearch in routes/venueSearch.js:
    // Google's own error body first (it carries the status an operator needs),
    // then any non-2xx without one, then a body with no usable list.
    if (data && data.error) {
      console.error('Places POI lookup error:', data.error.status, data.error.message);
      recordPlacesResult(false, `error body ${data.error.status || ''}`.trim());
      return { status: 502 };
    }
    if (httpStatus < 200 || httpStatus >= 300) {
      console.error('Places POI lookup HTTP', httpStatus, 'with no error body');
      recordPlacesResult(false, `HTTP ${httpStatus}`);
      return { status: 502 };
    }
    if (!data || typeof data !== 'object' || (data.places !== undefined && !Array.isArray(data.places))) {
      console.error('Places POI lookup returned a body with no usable places list');
      recordPlacesResult(false, 'malformed body');
      return { status: 502 };
    }
    recordPlacesResult(true);
    const id = data.places && data.places[0] && data.places[0].id;
    // `places` absent is Google's "nothing here". An id that is not shaped
    // like one is treated the same way rather than handed to the client.
    if (!id || !isPlaceIdShaped(id)) return { status: 404 };
    return { status: 200, placeId: id };
  } catch (err) {
    // A timeout is reported apart from the rest, as /search does, because Google
    // has already received (and metered) a request that timed out here.
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    console.error('Places POI lookup upstream failure:', err && err.name, err && err.message);
    return { status: timedOut ? 504 : 502 };
  }
}

/**
 * The place id for a glyph tapped on the map.
 *
 * `charge` is called only when a NEW Google call is about to be made, never for
 * a cached answer or a request that joins one already in flight, so one call is
 * one unit however many taps share it. When it answers false nothing is asked.
 *
 * @returns {Promise<{status: 200, placeId: string} | {status: 404} |
 *   {status: 429, refused: true} | {status: 502|504}>}
 */
async function lookupPoiPlace({ name, lat, lng, apiKey, charge, fetchImpl = fetch }) {
  const key = poiKey(name, lat, lng);
  const hit = readCache(key);
  if (hit) return hit.placeId ? { status: 200, placeId: hit.placeId } : { status: 404 };
  let flight = inflight.get(key);
  if (!flight) {
    if (!charge()) return { status: 429, refused: true };
    flight = askGoogle({ name, lat, lng, apiKey, fetchImpl }).then((out) => {
      if (out.status === 200) writeCache(key, out.placeId);
      else if (out.status === 404) writeCache(key, null);
      return out;
    });
    inflight.set(key, flight);
    flight.then(() => inflight.delete(key));
  }
  return flight;
}

module.exports = {
  POI_FIELD_MASK,
  POI_BOX_METERS,
  POI_NAME_MAX,
  normalizePoiName,
  poiKey,
  boxAround,
  lookupPoiPlace,
  __test: {
    FOUND_TTL_MS,
    NOT_FOUND_TTL_MS,
    POI_CACHE_MAX,
    POI_CACHE_LOW_WATER,
    readCache,
    writeCache,
    cacheSize: () => poiCache.size,
    clear: () => { poiCache.clear(); inflight.clear(); },
  },
};
