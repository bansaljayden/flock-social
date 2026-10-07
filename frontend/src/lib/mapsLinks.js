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
// from what the app knows about the place: a pin at its coordinates, carrying
// its name, when there are any; otherwise a search for the name at its
// address, which lands on the place's own card; then the address alone, then
// the name alone.
//
// Apple documents its map links at
// https://developer.apple.com/documentation/mapkit/unified-map-urls (the
// older "Map Links" page redirects there). Those unified links (/place,
// /search, /directions) need iOS 18.4 or later and the app supports iOS 15,
// so these keep the earlier parameters, which maps.apple.com still maps onto
// the unified ones: `ll` with `q` is a pin named `q` at a latitude and
// longitude (/place?coordinate=..&name=..), `address` shows an address
// without searching for it (/place?address=..), and `q` on its own is a
// search (/search?query=..).

const MAX_LABEL = 120;
const MAX_ADDRESS = 240;

// One half of a UTF-16 surrogate pair, without the other half.
function loneSurrogate(c) {
  const unit = c.charCodeAt(0);
  return c.length === 1 && unit >= 0xd800 && unit <= 0xdfff;
}

// Cut by code point, not by UTF-16 unit. A cut through an emoji used to leave
// half of it behind, encodeURIComponent throws on half an emoji, and the tap
// opened nothing. Text that arrives already cut that way (names are cut by
// UTF-16 unit elsewhere in the app and on the server) loses the stray half
// for the same reason. Array.from walks the text by code point: a regex
// lookbehind or String.prototype.toWellFormed would be shorter, and the iOS 15
// web view has neither.
function clean(text, max) {
  if (typeof text !== 'string') return '';
  const whole = Array.from(text).filter((c) => !loneSurrogate(c)).join('');
  return Array.from(whole.replace(/\s+/g, ' ').trim()).slice(0, max).join('');
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
  } else if (label) {
    // Not `address` with `q`: Apple Maps shows that as the bare address card
    // and titles it with the street address, not the name. A search for the
    // name at its address lands on the place's own card.
    params.push(`q=${encodeURIComponent(where ? `${label}, ${where}` : label)}`);
  } else if (where) {
    params.push(`address=${encodeURIComponent(where)}`);
  } else {
    return null;
  }
  return `https://maps.apple.com/?${params.join('&')}`;
}

function userAgent() {
  return typeof navigator !== 'undefined' && navigator ? String(navigator.userAgent || '') : '';
}

// iPhone, iPad and Mac, which all have Apple Maps. Safari on an iPad reports a
// Mac, which is the right answer here too. The iOS app is an iPhone app, so on
// an iPad its web view reports an iPhone; it is known by its capacitor:
// protocol anyway, since it is served from capacitor://localhost.
export function onAppleDevice(ua = userAgent(), protocol = typeof window !== 'undefined' && window.location ? window.location.protocol : '') {
  return protocol === 'capacitor:' || /iPhone|iPad|iPod|Macintosh/i.test(ua);
}

// Apple Maps has no Android app, and its web version does not run in
// Android browsers, so an Android phone is offered Google Maps only.
export function onAndroid(ua = userAgent()) {
  return /Android/i.test(ua);
}

// The caller's Google link as https, or null. An http one is upgraded rather
// than left out: Google serves its maps links over https too, and the venue
// card's Get Directions shows for an http google_maps_url, so dropping it
// would take the Google choice away from a button still on screen.
function httpsLink(url) {
  if (typeof url !== 'string') return null;
  const link = url.trim();
  if (/^https:\/\//i.test(link)) return link;
  if (/^http:\/\//i.test(link)) return `https://${link.slice('http://'.length)}`;
  return null;
}

// The maps apps to offer for one place, in order. `googleUrl` is the caller's
// Google Maps link. Each choice carries an https link or is left out.
export function mapsChoices({ place, googleUrl } = {}, { apple = onAppleDevice(), android = onAndroid() } = {}) {
  const choices = [];
  const appleUrl = android ? null : appleMapsUrl(place || {});
  const google = httpsLink(googleUrl);
  if (appleUrl) choices.push({ app: 'apple', label: 'Apple Maps', url: appleUrl });
  if (google) choices.push({ app: 'google', label: 'Google Maps', url: google });
  if (!apple) choices.reverse();
  return choices;
}
