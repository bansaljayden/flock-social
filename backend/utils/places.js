// Shared Google place-id validation + known-venue lookup.
//
// This existed three times: routes/checkin.js (`validPlaceId` / `isKnownPlace`,
// uncached), sockets/handlers.js (`isPlaceIdShaped` / `isKnownVenue`, cached),
// and the raw EXISTS query copy-pasted between them. sockets/handlers.js even
// carries a comment asking for this file. Three copies of a security rule is
// three chances for one of them to drift, so it lives here now.
//
// Adopt it with:
//   const { isPlaceIdShaped, isKnownVenue } = require('../utils/places');   // routes/
//   const { isPlaceIdShaped, isKnownVenue } = require('./../utils/places'); // sockets/
//
// Behaviour notes for adopters:
//  - isKnownVenue() shape-checks first, so a malformed id never reaches SQL.
//  - it fails CLOSED: a database error answers "not known" instead of throwing,
//    so an adopter that used to bubble the error into a 500 will now answer 404
//    / refuse the subscription. That is the safer end of the trade.
//  - results are cached for 5 minutes in both directions, so a venue onboarded
//    seconds ago can take up to 5 minutes to accept taps. clearKnownVenueCache()
//    exists for tests and for an onboarding path that wants it immediate.
//  - ROUND 17: a flock naming a place id no longer makes that venue "known".
//    See the block above isKnownVenue for why, and for what a deployed NFC tag
//    needs instead.

const pool = require('../config/database');

// Google place ids; the bound keeps ids well under the VARCHAR(255) columns
// they get stored in, so an oversized id is a 400 rather than a 500.
const PLACE_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;

function isPlaceIdShaped(placeId) {
  return typeof placeId === 'string' && PLACE_ID_RE.test(placeId);
}

const KNOWN_VENUE_TTL_MS = 5 * 60 * 1000;
const KNOWN_VENUE_MAX_ENTRIES = 5000;
const knownVenueCache = new Map(); // placeId -> { known, ts }

// "Known" = a venue that exists in our world already, by evidence WE created:
// a claimed venue profile, a deployed sensor/NFC site, or a curated ML venue.
// Deliberately does NOT consult venue_checkins — that would let the first
// forged row bootstrap every later one.
//
// ---------------------------------------------------------------------------
// ROUND 17 — the `flocks` clause is GONE. This is the decision the previous
// pass left open; sockets/handlers.js already recorded the same verdict in a
// comment on behalf of both consumers, and this is it carried out.
//
// The clause was `OR EXISTS (SELECT 1 FROM flocks WHERE venue_id = $1)`, and it
// was SELF-SERVE: creating a flock is free and its venue_id is a
// client-supplied string, so any account could promote a place id of its
// choosing to "known". That is not a small thing, because "known" is the gate
// on both consumers:
//   - routes/checkin.js: a fabricated tap lands a venue_checkins row, and that
//     table is what routes/sensors.js sums for the public occupancy figure and
//     what the ML pipeline exports as training data (scripts/ml/RETRAIN.md).
//   - sockets/handlers.js join_venue: a `venue:{id}` room subscription.
// The other three clauses cannot be reached that way — venue_profiles needs a
// claim we verify, sensor_devices needs hardware we provision, ml_venues is
// curated by us.
//
// Nothing legitimate is lost. NFC tags are cut as part of venue onboarding, so
// a genuine tag's venue always has a venue_profiles or sensor_devices row; the
// flocks clause was never why a real tap succeeded. join_venue loses nothing
// either: both client subscriptions are sensor-backed views, and a room for a
// venue with no profile and no sensor can never carry a crowd_update (that emit
// requires a VERIFIED venue_profiles claim), so the only thing a bootstrapped
// room could ever have received was a check-in the subscriber fabricated.
//
// "Require a CONFIRMED flock" was the narrower alternative and it is not worth
// taking: confirming your own flock is also free, so it keeps the same hole
// behind one extra request.
//
// CONSEQUENCE TO KNOW ABOUT: a deployed NFC tag now needs a row in one of
// venue_profiles(google_place_id), sensor_devices(venue_place_id) or
// ml_venues(google_place_id). A tag cut before its venue exists in the database
// answers 404 until that row is written. Manual check-in
// (POST /api/checkin/:placeId) does not consult this function at all, so
// checking in at an unseen Google Places venue from inside the app still works.
// ---------------------------------------------------------------------------
async function isKnownVenue(placeId) {
  if (!isPlaceIdShaped(placeId)) return false;

  const hit = knownVenueCache.get(placeId);
  if (hit && Date.now() - hit.ts < KNOWN_VENUE_TTL_MS) return hit.known;

  let known = false;
  try {
    const { rows } = await pool.query(
      `SELECT (
         EXISTS (SELECT 1 FROM venue_profiles WHERE google_place_id = $1)
         OR EXISTS (SELECT 1 FROM sensor_devices WHERE venue_place_id = $1)
         OR EXISTS (SELECT 1 FROM ml_venues WHERE google_place_id = $1)
       ) AS known`,
      [placeId]
    );
    known = rows[0]?.known === true;
  } catch (_) {
    // Fail closed, and do not cache the failure — a transient database blip
    // must not pin a real venue to "unknown" for the next five minutes.
    return false;
  }

  rememberKnownVenue(placeId, known);
  return known;
}

// Round 17: this was `if (size > MAX) clear()`.
//
// Both halves of that were wrong for a cache an unauthenticated endpoint can
// write to. NEGATIVE answers are cached too (deliberately — that is what stops
// a spray of fabricated ids from becoming a query per request), so anyone can
// push the map over the bound with shaped-but-unknown ids, and a wholesale
// clear then throws away every genuine venue at once: the next tap at every
// real venue in the country re-queries, on demand, at a moment the sprayer
// chooses. Correctness never suffered — the answer is recomputed — but it is
// the same "one caller can reset shared state for everyone" shape that
// utils/probeBudget.js and the tap cache in routes/checkin.js both call out.
//
// The order is: expire what is genuinely stale, then drop NEGATIVE entries
// oldest-first, and only then fall back to oldest-of-anything.
//
// Negatives go first because the two kinds of entry are not worth the same. A
// `known: true` entry names a venue that actually exists, so there are only as
// many of them as we have venues and each one saves a query for a real tap. A
// `known: false` entry is whatever string the last caller made up, and the
// supply of those is unlimited — so evicting purely by age let a spray of
// fabricated ids push every genuine venue out, and the real taps that followed
// all went back to the database anyway. Dropping the made-up ids first makes
// the spray clean up after itself.
//
// A Map iterates in insertion order and `set` on an EXISTING key keeps that
// key's original position, so refreshing an entry has to delete before it sets
// — otherwise a venue that is looked up constantly looks permanently old and is
// the first thing an age-ordered pass removes.
function rememberKnownVenue(placeId, known) {
  const now = Date.now();
  knownVenueCache.delete(placeId);
  knownVenueCache.set(placeId, { known, ts: now });
  if (knownVenueCache.size <= KNOWN_VENUE_MAX_ENTRIES) return;

  for (const [k, v] of knownVenueCache) {
    if (now - v.ts >= KNOWN_VENUE_TTL_MS) knownVenueCache.delete(k);
  }
  for (const [k, v] of knownVenueCache) {
    if (knownVenueCache.size <= KNOWN_VENUE_MAX_ENTRIES) break;
    if (v.known !== true && k !== placeId) knownVenueCache.delete(k);
  }
  // Still over only if the cache is genuinely full of real venues. Oldest
  // written first at that point, which is the ordinary LRU case.
  while (knownVenueCache.size > KNOWN_VENUE_MAX_ENTRIES) {
    knownVenueCache.delete(knownVenueCache.keys().next().value);
  }
}

function clearKnownVenueCache() {
  knownVenueCache.clear();
}

module.exports = {
  PLACE_ID_RE,
  isPlaceIdShaped,
  // routes/checkin.js calls its copy `validPlaceId`; same function, so the
  // adopting diff can be a one-line require with no call-site churn.
  validPlaceId: isPlaceIdShaped,
  isKnownVenue,
  clearKnownVenueCache,
  KNOWN_VENUE_TTL_MS,
  KNOWN_VENUE_MAX_ENTRIES,
};

// Exposed for backend/__tests__/checkinFlow.test.js only.
module.exports.__test = { knownVenueCache, rememberKnownVenue };
