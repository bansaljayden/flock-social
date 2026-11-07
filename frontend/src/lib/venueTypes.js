// THE TYPE CHIPS ON THE VENUE SHEET, WITHOUT GOOGLE'S CATCH-ALLS.
//
// Place Details lists every type a place carries, and nearly every listing
// carries a few that say nothing about it: "point_of_interest",
// "establishment", "food", "store", and the address families. The sheet drew
// the first six as chips, so a Mexican restaurant read "Mexican Restaurant,
// Restaurant, Food, Point Of Interest, Establishment". These are left out,
// the same catch-alls backend/routes/venueDashboard.js GENERIC_PLACE_TYPES
// names for its own comparison strip (that list also drops a few, such as
// place_of_worship, that do say what a place is, and those stay here).

const GENERIC = new Set([
  'establishment', 'point_of_interest', 'food', 'store', 'health', 'finance',
  'general_contractor', 'political', 'geocode', 'premise', 'subpremise',
  'plus_code', 'street_address', 'street_number', 'route', 'intersection',
  'neighborhood', 'locality', 'sublocality', 'postal_code', 'postal_town',
  'country', 'continent', 'archipelago', 'colloquial_area', 'floor', 'room',
  'post_box',
]);
const GENERIC_FAMILY = /^(administrative_area_level_|sublocality_level_|postal_code_)/;

export const isGenericPlaceType = (t) => typeof t === 'string' && (GENERIC.has(t) || GENERIC_FAMILY.test(t));

// "mexican_restaurant" -> "Mexican Restaurant", the way the map card's type
// line prints it.
export const placeTypeLabel = (t) => String(t).replace(/_/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());

// The chips to draw: the specific types, once each, at most `max`.
export const displayVenueTypes = (types, max = 6) => {
  if (!Array.isArray(types)) return [];
  const seen = new Set();
  const out = [];
  for (const t of types) {
    if (!t || isGenericPlaceType(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
};
