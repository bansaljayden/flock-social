// Where a place opens in a maps app.
//
// App Review rejected 1.0 under Guideline 4 on 2026-10-07 (reviewed on an
// iPad): every way from the app to a map went to Google Maps, and Apple asked
// for "the option to launch the native Apple Maps app". So every Directions
// button now offers both apps (components/ui/MapsChooser.js), with Apple Maps
// first on an Apple device.
//
// Google keeps the link each caller already had: Google's own url for the
// place, or a search by its Google place id, both of which land on the right
// place page. Apple Maps cannot read a Google place id, so its link is built
// from what the app knows about the place: the coordinates when there are
// any, then the address, then the name.
//
// Apple's map link parameters (developer.apple.com, "Map Links"): `ll` puts
// the pin at a latitude and longitude, `address` shows an address without
// searching for it, and `q` labels the pin when the place is given by `ll` or
// `address`. `q` on its own is a search.

const MAX_LABEL = 120;
const MAX_ADDRESS = 240;

function clean(text, max) {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

// A usable latitude and longitude, or null. 0,0 is a point in the Gulf of
// Guinea and the value a missing fix tends to default to, so it counts as
// missing.
export function coordinates(lat, lng) {
  if (lat === null || lat === undefined || lat === '' || lng === null || lng === undefined || lng === '') return null;
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  if (la === 0 && lo === 0) return null;
  return { lat: la, lng: lo };
}

// The Apple Maps link for a place, or null when nothing locates it.
export function appleMapsUrl({ name, address, lat, lng } = {}) {
  const label = clean(name, MAX_LABEL);
  const where = clean(address, MAX_ADDRESS);
  const at = coordinates(lat, lng);
  const params = [];
  if (at) {
    params.push(`ll=${at.lat},${at.lng}`);
    params.push(`q=${encodeURIComponent(label || where || 'Location')}`);
  } else if (where) {
    params.push(`address=${encodeURIComponent(where)}`);
    if (label) params.push(`q=${encodeURIComponent(label)}`);
  } else if (label) {
    params.push(`q=${encodeURIComponent(label)}`);
  } else {
    return null;
  }
  return `https://maps.apple.com/?${params.join('&')}`;
}

function userAgent() {
  return typeof navigator !== 'undefined' && navigator ? String(navigator.userAgent || '') : '';
}

// iPhone, iPad and Mac, which all have Apple Maps. iPadOS reports itself as a
// Mac in Safari and in the app's web view, which is the right answer here too.
// The iOS app is served from capacitor://localhost.
export function onAppleDevice(ua = userAgent(), protocol = typeof window !== 'undefined' && window.location ? window.location.protocol : '') {
  return protocol === 'capacitor:' || /iPhone|iPad|iPod|Macintosh/i.test(ua);
}

// Apple Maps has no Android app, and its web version does not run in
// Android browsers, so an Android phone is offered Google Maps only.
export function onAndroid(ua = userAgent()) {
  return /Android/i.test(ua);
}

// The maps apps to offer for one place, in order. `googleUrl` is the caller's
// Google Maps link. Each choice carries an https link or is left out.
export function mapsChoices({ place, googleUrl } = {}, { apple = onAppleDevice(), android = onAndroid() } = {}) {
  const choices = [];
  const appleUrl = android ? null : appleMapsUrl(place || {});
  const google = typeof googleUrl === 'string' && /^https:\/\//i.test(googleUrl.trim()) ? googleUrl.trim() : null;
  if (appleUrl) choices.push({ app: 'apple', label: 'Apple Maps', url: appleUrl });
  if (google) choices.push({ app: 'google', label: 'Google Maps', url: google });
  if (!apple) choices.reverse();
  return choices;
}
