// A picture of the block a VENUE sits on, from MapTiler's Static Maps API.
//
// WHERE IT IS USED. A plan's venue card and the venue sheet when Places has no
// photo. Those are the two places a person decides how to get somewhere and
// used to see only an address or a navy box. components/map/StaticVenueMap.js
// draws it; nothing else may build one.
//
// VENUES ONLY, AND THAT IS A RULE, NOT A SCOPE NOTE. The image URL carries the
// coordinates in its path, and the browser fetches it from a third party. A
// venue's position is public. A person's is not: a live location card or an SOS
// alarm drawn through here would hand somebody's position to MapTiler from the
// handset, and the youngest permitted user is 13. So the only builder exported
// is the venue one, and src/__tests__/externalLinksAndCoordinatePrivacy.test.js
// holds the list of files allowed to import this module.
//
// NO PROXY AND NO STORED COPY. MapTiler's terms require end users to fetch from
// api.maptiler.com directly and forbid a server-side cache, a screenshot or a
// stored static image. A personal device cache is allowed. So the URL goes
// straight into an <img>, the device's HTTP cache serves repeats, and the memo
// below makes sure a list that renders again asks for the identical string, so
// the browser never sees a new URL for the same card. Nothing here, on our API
// or in public/ ever holds the picture itself.
//
// DETERMINISTIC ON PURPOSE. Coordinates are rounded to 5 decimals (about a
// metre) and sizes come from a fixed set, so the same venue at the same size and
// theme is always the same URL and the cache hits. Each image costs 15 requests
// out of the monthly pool, so a URL that drifted by a digit would be paid for
// again.
//
// NO KEY, NO MAP. Contributor and e2e builds carry no REACT_APP_MAPTILER_KEY,
// and then every builder answers null and the caller draws what it drew before.
//
// THE CREDIT. The image is requested with attribution=false so the credit is
// not baked into the corner at an unreadable size, which makes the visible
// STATIC_MAP_CREDIT line drawn by StaticVenueMap a licence condition: MapTiler
// requires the text on or next to a static image. Do not render one of these
// URLs anywhere without it.

const MAP_HOST = 'https://api.maptiler.com';

// TODO(owner ids): these are MapTiler's stock light and dark streets maps, so
// previews work today. Once the Flock light and dark styles are hosted in Map
// Designer, these two constants take those map ids, so a preview looks like the
// live map it stands in for. Nothing else has to change.
export const STATIC_MAP_IDS = Object.freeze({
  light: 'streets-v4',
  dark: 'streets-v4-dark',
});

// The pin is Flock's own art (frontend/public/map), fetched by MapTiler from
// the production site, because the API draws a custom marker only from a public
// URL. It has to be live before a preview can render, and a missing one fails
// the whole image, which StaticVenueMap catches and hides. The API allows one
// custom icon per image, under 64 KiB, with explicit width and height.
const PIN_ORIGIN = 'https://www.flockcorp.com';
export const STATIC_PIN_URLS = Object.freeze({
  light: `${PIN_ORIGIN}/map/pin-light.svg`,
  dark: `${PIN_ORIGIN}/map/pin-dark.svg`,
});

// Logical pixels; every request is @2x for a retina screen. The strip is a
// plan card's width on a large phone and the sheet is the venue sheet's
// header. thumb is the chat card square, which has no caller: its 88px card
// has no room for the credit at a readable size, so it stays a pin.
export const STATIC_MAP_BUCKETS = Object.freeze({
  strip: Object.freeze({ width: 375, height: 140, zoom: 16 }),
  sheet: Object.freeze({ width: 430, height: 220, zoom: 16 }),
  thumb: Object.freeze({ width: 88, height: 88, zoom: 15 }),
});

export const STATIC_MAP_CREDIT = '© MapTiler © OpenStreetMap contributors';

// The API answers 414 past this.
export const STATIC_MAP_MAX_URL = 8192;

// Bounded, because a long session in Discover can open hundreds of venues. The
// oldest entry goes first; a URL rebuilt after eviction is the same string.
const MEMO_CAP = 256;
const memo = new Map();

// Only a real number or a numeric string counts. Number(null) and Number('')
// are both 0, which would put a venue with no coordinates in the Gulf of Guinea.
const coord = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

// Web Mercator stops at 85.0511 degrees, and the API cannot draw past it.
const MAX_LAT = 85.0511;

// The URL of a static map centred on one venue, or null when there is no key,
// no usable coordinate, or no such size. `dark` picks the map and the pin.
export function venueStaticMapUrl({ lat, lng, size = 'strip', dark = false } = {}) {
  const key = process.env.REACT_APP_MAPTILER_KEY;
  if (!key) return null;
  const bucket = Object.prototype.hasOwnProperty.call(STATIC_MAP_BUCKETS, size) ? STATIC_MAP_BUCKETS[size] : null;
  if (!bucket) return null;
  const la = coord(lat);
  const ln = coord(lng);
  if (la === null || ln === null) return null;
  if (Math.abs(la) > MAX_LAT || Math.abs(ln) > 180) return null;

  const theme = dark ? 'dark' : 'light';
  const at = `${ln.toFixed(5)},${la.toFixed(5)}`;
  const memoKey = `${at}|${size}|${theme}|${key}`;
  const hit = memo.get(memoKey);
  if (hit !== undefined) return hit;

  const marker = `icon:${STATIC_PIN_URLS[theme]}|anchor:bottom|scale:2|${at}`;
  const url = `${MAP_HOST}/maps/${STATIC_MAP_IDS[theme]}/static/${at},${bucket.zoom}/`
    + `${bucket.width}x${bucket.height}@2x.webp`
    + `?key=${encodeURIComponent(key)}&attribution=false&markers=${encodeURIComponent(marker)}`;
  const out = url.length <= STATIC_MAP_MAX_URL ? url : null;

  if (memo.size >= MEMO_CAP) memo.delete(memo.keys().next().value);
  memo.set(memoKey, out);
  return out;
}
