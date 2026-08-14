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

// "Known" = a venue that exists in our world already: a claimed venue profile,
// a deployed sensor/NFC site, a curated ML venue, or somewhere a flock has
// actually planned to meet. Deliberately does NOT consult venue_checkins —
// that would let the first forged row bootstrap every later one.
//
// KNOWN GAP (not this file's to close): the `flocks` clause is self-serve.
// Anyone can create a flock with an attacker-chosen venue_id and thereby mint a
// "known" venue, which is enough to open a `venue:{id}` subscription or to make
// a fabricated NFC tap land. Dropping that clause (or requiring the flock be
// confirmed / have >1 accepted member) is an owner decision for checkin.js and
// sockets/handlers.js, so the query below still matches what they do today.
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
         OR EXISTS (SELECT 1 FROM flocks WHERE venue_id = $1)
       ) AS known`,
      [placeId]
    );
    known = rows[0]?.known === true;
  } catch (_) {
    // Fail closed, and do not cache the failure — a transient database blip
    // must not pin a real venue to "unknown" for the next five minutes.
    return false;
  }

  if (knownVenueCache.size > KNOWN_VENUE_MAX_ENTRIES) knownVenueCache.clear();
  knownVenueCache.set(placeId, { known, ts: Date.now() });
  return known;
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
};
