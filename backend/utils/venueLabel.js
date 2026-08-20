// ---------------------------------------------------------------------------
// The owner-report attribution label, computed in ONE place.
//
// When a venue's own live reading is published ("we are at X% right now"),
// every surface labels the number as the venue's claim, not Flock's. That
// label used to be hardcoded "the bar says" everywhere, and Flock serves
// cafes, breakfast spots, restaurants and clubs — a coffee shop's reading
// captioned "the bar says" is wrong on the surface where being exactly right
// is the whole point (the label is what keeps an owner-set number honest).
//
// So: category in, short human word out. The category vocabulary is the 13
// tokens the crowd model was trained on (ml_venues.venue_category,
// services/mlPredictor.js guessCategory), plus whatever free text an owner
// typed into venue_profiles.category ("Bar / Nightclub", "Cafe / Coffee") —
// normalizeCategory folds both into the same 13 tokens or null. Anything this
// file cannot place says "the venue says", which is always true.
//
// services/ownerReports.js computes the label here and ships it on the
// ownerReport block (`attribution`, `noun`); clients render the field and
// never the literal. __tests__/venueLabel.test.js pins the mapping AND greps
// the repo so the old hardcoded string cannot come back.
// ---------------------------------------------------------------------------

// The 13 trained categories -> the word a person would use for the place.
// 'entertainment' (bowling alleys, arcades, amusement parks) has no single
// honest word, so it takes the fallback on purpose.
const NOUN_BY_CATEGORY = {
  bar: 'bar',
  brewery: 'brewery',
  nightclub: 'club',
  cafe: 'cafe',
  restaurant: 'restaurant',
  fast_food: 'restaurant',
  dessert: 'shop',
  gym: 'gym',
  mall: 'mall',
  museum: 'museum',
  movie_theater: 'theater',
  entertainment: 'venue',
  park: 'park',
};

const FALLBACK_NOUN = 'venue';

// Free-text words -> canonical category. venue_profiles.category is owner-
// typed prose ("Bar / Nightclub", "Brewery / Winery", "Lounge"), and the
// venue signup chips use display strings, so single words are matched, first
// hit wins. Words not listed fall through to the fallback noun — a wrong
// guess here puts a wrong word on a consumer surface, so unlisted stays
// unmatched.
const WORD_TO_CATEGORY = {
  bar: 'bar', pub: 'bar', tavern: 'bar', lounge: 'bar', nightlife: 'bar',
  nightclub: 'nightclub', club: 'nightclub', night: 'nightclub',
  cafe: 'cafe', coffee: 'cafe', coffeehouse: 'cafe', espresso: 'cafe',
  restaurant: 'restaurant', diner: 'restaurant', bistro: 'restaurant',
  eatery: 'restaurant', grill: 'restaurant', kitchen: 'restaurant',
  pizzeria: 'restaurant', brunch: 'restaurant', breakfast: 'restaurant',
  food: 'restaurant',
  brewery: 'brewery', brewpub: 'brewery', taproom: 'brewery', winery: 'brewery',
  gym: 'gym', fitness: 'gym',
  mall: 'mall',
  museum: 'museum',
  theater: 'movie_theater', theatre: 'movie_theater', cinema: 'movie_theater',
  park: 'park',
  bakery: 'dessert', dessert: 'dessert', gelato: 'dessert',
  arcade: 'entertainment', bowling: 'entertainment',
};

// Anything -> one of the 13 category tokens, or null. Accepts the canonical
// tokens themselves (ml_venues.venue_category) and owner-typed prose
// (venue_profiles.category).
function normalizeCategory(raw) {
  if (typeof raw !== 'string') return null;
  const token = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (Object.prototype.hasOwnProperty.call(NOUN_BY_CATEGORY, token)) return token;
  // Owner prose: first recognized word wins ("Bar / Nightclub" -> bar).
  for (const word of raw.toLowerCase().split(/[^a-z]+/)) {
    if (word && Object.prototype.hasOwnProperty.call(WORD_TO_CATEGORY, word)) {
      return WORD_TO_CATEGORY[word];
    }
  }
  return null;
}

// Google Places types -> category token, or null when nothing matched.
//
// This mirrors services/mlPredictor.js guessCategory — same matches, same
// ordering (night_club before bar because Google returns both on most clubs;
// amusement_park before park because Google returns 'park' on many amusement
// parks) — with ONE deliberate difference: guessCategory must always pick a
// category for the model, so unmatched types fall back to 'restaurant'. A
// LABEL must not: calling a casino "the restaurant says" is the exact wrong
// claim this module exists to stop, so unmatched types return null here and
// the caller falls back to "the venue says". __tests__/venueLabel.test.js
// pins agreement with guessCategory on every list this function does match.
function categoryFromTypes(types) {
  if (!Array.isArray(types) || types.length === 0) return null;
  if (types.includes('night_club')) return 'nightclub';
  if (types.includes('bar') || types.includes('pub')) return 'bar';
  if (types.includes('cafe') || types.includes('coffee_shop')) return 'cafe';
  if (types.includes('gym') || types.includes('fitness_center')) return 'gym';
  if (types.includes('shopping_mall')) return 'mall';
  if (types.includes('museum')) return 'museum';
  if (types.includes('movie_theater')) return 'movie_theater';
  if (types.includes('fast_food_restaurant') || types.includes('meal_takeaway')) return 'fast_food';
  if (types.includes('bakery') || types.includes('ice_cream_shop')) return 'dessert';
  if (types.includes('brewery')) return 'brewery';
  if (types.includes('bowling_alley') || types.includes('amusement_park')
      || types.includes('video_arcade')) return 'entertainment';
  if (types.includes('park') || types.includes('national_park')
      || types.includes('state_park')) return 'park';
  // Explicit restaurant types only — Google's cuisine types all end in
  // _restaurant (italian_restaurant, breakfast_restaurant, ...). Checked
  // after fast_food so fast_food_restaurant keeps its own word.
  if (types.some((t) => typeof t === 'string' && (t === 'restaurant' || t.endsWith('_restaurant')))) {
    return 'restaurant';
  }
  return null;
}

// The short word: 'bar', 'cafe', 'club', ... — 'venue' when unknown.
function venueNoun(category) {
  const token = normalizeCategory(category);
  return token ? NOUN_BY_CATEGORY[token] : FALLBACK_NOUN;
}

// The full label: "the bar says", "the cafe says", "the venue says".
// Lowercase leading "the" — a client starting a sentence with it uses the
// noun and capitalizes itself.
function ownerAttribution(category) {
  return `the ${venueNoun(category)} says`;
}

module.exports = {
  NOUN_BY_CATEGORY,
  FALLBACK_NOUN,
  normalizeCategory,
  categoryFromTypes,
  venueNoun,
  ownerAttribution,
};
