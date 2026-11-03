/**
 * HOW OLD THE LOCATION BIRDIE IS SENT IS (backend routes/ai.js, HOW FAR A
 * VENUE IS).
 *
 * Birdie is sent the map's position (birdieContextRef in App.js), and that can
 * be where the phone was in an earlier session: it starts from localStorage,
 * and a launch fix can be hours old by the time anybody asks. The server tells
 * Birdie how far each venue is only from a fix it is told is fresh, so this
 * says how old the position being sent is, in whole seconds, when it is a fix
 * the device answered (deviceFixRef, stamped when it arrived) at the same
 * place the map shows. "The same place" allows the ten metres a live share lets
 * the map lag behind the fix, and stays well inside the kilometre the server
 * rounds the position to. Anything else (a restored position, a map moved by
 * hand, no fix at all) is null, and Birdie then gets no distance.
 */

// About 110 m north to south: the same place, for this purpose.
const SAME_PLACE_DEG = 0.001;
// Older than a day reads as a day. Stale either way, and inside what the
// server accepts.
const MAX_AGE_SEC = 24 * 60 * 60;

export function birdieLocationAgeSec(location, fix, now = Date.now()) {
  if (!location || !fix) return null;
  const values = [location.lat, location.lng, fix.lat, fix.lng, fix.at, now];
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  if (Math.abs(fix.lat - location.lat) > SAME_PLACE_DEG || Math.abs(fix.lng - location.lng) > SAME_PLACE_DEG) return null;
  const age = Math.floor((now - fix.at) / 1000);
  if (age < 0) return null;
  return Math.min(age, MAX_AGE_SEC);
}
