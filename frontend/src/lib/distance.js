// HOW FAR, IN THE UNITS THE PERSON READS DISTANCE IN.
//
// Every distance in the app was printed in kilometres ("15.7km"), and the
// people using it are mostly in the United States, where a road sign, a map
// and a friend all say miles. One function, so the search dropdown, the full
// results list, the map card and the events list cannot disagree about it.
//
// The unit follows the device's region, the way Apple Maps and Google Maps
// do: miles where road distances are posted in miles (the United States, the
// United Kingdom, Liberia and Myanmar), kilometres everywhere else. A bare
// language with no region ("en") is read as its most likely region, which for
// English is the United States.
//
// Miles: feet under a tenth of a mile (rounded to 50 ft, never "0 ft"),
// tenths under ten miles, whole miles after that. Kilometres: metres under
// one kilometre (rounded to 10 m), tenths under ten, whole kilometres after.
// A space before the unit, as both systems print it.
//
// THE UNIT IS CHOSEN AFTER THE ROUNDING (review, 2026-11-06). It was chosen
// on the raw figure and the figure rounded after, so 0.0996 mi printed
// "550 ft", more than the "0.1 mi" (528 ft) a slightly longer distance got,
// 9.96 mi printed "10.0 mi" where the rule says "10 mi", and 0.996 km printed
// "1000 m". A figure that rounds up to the next unit is printed in it.

const MILE_REGIONS = new Set(['US', 'GB', 'LR', 'MM']);
export const KM_PER_MILE = 1.609344;
const FEET_PER_MILE = 5280;

const regionOf = (locale) => {
  if (!locale || typeof locale !== 'string') return null;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Locale === 'function') {
      const loc = new Intl.Locale(locale);
      const max = typeof loc.maximize === 'function' ? loc.maximize() : loc;
      if (max.region) return max.region.toUpperCase();
    }
  } catch { /* a tag Intl refuses: read it by hand below */ }
  const m = /^[a-z]{2,3}(?:[-_][A-Za-z]{4})?[-_]([A-Za-z]{2}|\d{3})\b/.exec(locale);
  if (m) return m[1].toUpperCase();
  return /^en\b/i.test(locale) ? 'US' : null;
};

// The device's own locale: the first language the browser or WebView
// reports, then whatever Intl resolves by default.
export const deviceLocale = () => {
  try {
    if (typeof navigator !== 'undefined') {
      const list = Array.isArray(navigator.languages) && navigator.languages.length ? navigator.languages : [navigator.language];
      if (list[0]) return list[0];
    }
  } catch { /* no navigator */ }
  try { return new Intl.DateTimeFormat().resolvedOptions().locale; } catch { return 'en-US'; }
};

export const usesMiles = (locale = deviceLocale()) => MILE_REGIONS.has(regionOf(locale) || '');

export const formatDistance = (km, { locale } = {}) => {
  if (typeof km !== 'number' || !Number.isFinite(km) || km < 0) return '';
  if (usesMiles(locale === undefined ? deviceLocale() : locale)) {
    const mi = km / KM_PER_MILE;
    const tenths = Math.round(mi * 10) / 10;
    if (tenths >= 10) return `${Math.round(mi)} mi`;
    const feet = Math.max(50, Math.round((mi * FEET_PER_MILE) / 50) * 50);
    if (mi < 0.1 && feet < FEET_PER_MILE / 10) return `${feet} ft`;
    return `${Math.max(0.1, tenths).toFixed(1)} mi`;
  }
  const tenthsKm = Math.round(km * 10) / 10;
  if (tenthsKm >= 10) return `${Math.round(km)} km`;
  const metres = Math.max(10, Math.round((km * 1000) / 10) * 10);
  if (km < 1 && metres < 1000) return `${metres} m`;
  return `${Math.max(1, tenthsKm).toFixed(1)} km`;
};

// "1.3 mi away" / "400 ft away" on a phone that reads miles, "2.1 km away" /
// "400 m away" elsewhere, for where a person is: the flock chat's who-is-here
// line. Null for no position, never "0 ft away".
export const formatDistanceAway = (km, options) => {
  if (km == null || km === '') return null;
  const d = Number(km);
  if (!Number.isFinite(d) || d < 0) return null;
  const said = formatDistance(d, options);
  return said ? `${said} away` : null;
};

// The great-circle distance in kilometres between two points.
export const haversineKm = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
