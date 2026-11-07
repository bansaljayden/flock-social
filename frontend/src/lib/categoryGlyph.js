// WHAT KIND OF PLACE, DRAWN, FOR A PLACE WITH NO PHOTO.
//
// A map pin with no photo carried the first letter of its category, "F" for
// Food, so a Mexican restaurant and a bakery were both a dark disc with an F
// in it, and a search row with no photo was an empty grey square. These are
// the glyphs instead: a fork and knife, a stemmed glass, a note, a ball, and a
// place mark for anything else, every one an Icons.js key.
//
// The map builds its pins as SVG text, so the glyphs reach it as markup
// (iconMarkup in Icons.js), keyed by the kind of place glyphCategoryFor
// (below) reads off a listing's types. The lookup is own-property only: an owner-typed category
// of "constructor" draws the place mark, never anything off Object.prototype.
//
// THE GLYPH IS NOT THE FILTER'S CATEGORY (review, 2026-11-06). The pins and
// rows first drew categorizeVenueTypes' answer, whose fallback is Food so the
// map's filters have somewhere to put everything: a fireplace shop, a state
// park and a museum all got a fork and knife, and its substring test made a
// barber shop a cocktail glass. A glyph that says something false is worse
// than the old "F", which said nothing. glyphCategoryFor draws the place mark
// for anything that is not food, drink, music or sport, and reads "bar" as a
// type of its own, never as letters inside another one.

import Icons, { iconMarkup } from '../components/ui/Icons';

// Each kind of place draws an Icons.js key: the fork and knife (`food`), the
// stemmed glass (`cocktail`), the note (`music`), the ball (`sports`) and the
// map pin (`mapPin`) for anything else. This file kept a second set of path
// data, drawn at its own strokes; the glyphs are the app's own now.
//
// FOUR FINER KINDS (2026-11-07). The drinks stopped sharing drawings, so a
// coffee shop draws the steaming cup (`coffee`), a pub or a brewery the
// foam-headed mug (`beer`), a wine bar or a winery the tall bowl (`wine`), and
// an arcade the controller (`gamepad`), where the first three drew the fork
// and knife or the cocktail glass and the arcade the plain place mark. Only
// the glyph is finer: the filters keep their five categories.
const GLYPHS = {
  Food: 'food', Nightlife: 'cocktail', 'Live Music': 'music', Sports: 'sports', Place: 'mapPin',
  Cafe: 'coffee', Beer: 'beer', Wine: 'wine', Games: 'gamepad',
};
const keyFor = (category) => (
  (typeof category === 'string' && Object.prototype.hasOwnProperty.call(GLYPHS, category) && GLYPHS[category]) || GLYPHS.Place
);
// The drawing as markup, one string per category, made once.
const MARKUP = {};
export const glyphPaths = (category) => {
  const key = keyFor(category);
  if (!MARKUP[key]) MARKUP[key] = [iconMarkup(key)];
  return MARKUP[key];
};

// The glyph as an SVG <g>, for a pin built as markup: scaled from the 24 grid
// to `size` units and centred on (cx, cy) of the host SVG's own viewBox.
// `color` is one of the map's own palette constants, never user text.
export const glyphSvgGroup = (category, { cx, cy, size, color, strokeWidth = 2.4 }) => {
  const k = size / 24;
  const x = cx - size / 2;
  const y = cy - size / 2;
  const d = glyphPaths(category).join('').replace(/currentColor/g, color);
  return `<g transform="translate(${x} ${y}) scale(${k})" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${d}</g>`;
};

// The same glyph as a React element, for a list row's empty thumbnail: the
// Icons.js key itself, at the set's one stroke.
export function CategoryGlyph({ category, color = 'currentColor', size = 20 }) {
  return Icons[keyFor(category)](color, size);
}

// A type that is a place to drink: "bar" and "pub" and "lounge" as types of
// their own or as the end of one (wine_bar, irish_pub, lounge_bar), a night
// club, a brewery or a liquor store. Never the letters "bar" inside another
// word (barber_shop, barbecue_restaurant), and not a juice bar, which is food.
const NIGHTLIFE_TYPE = /^(?:bar|bar_and_grill|pub|lounge|night_club|nightclub|brewpub|brewery|beer_garden|beer_hall|liquor_store|[a-z_]+_(?:bar|pub|lounge))$/;
const NOT_NIGHTLIFE_TYPE = /^(?:juice|smoothie|snack|salad|coffee|tea|dessert|ice_cream)_bar$/;
const typeTokens = (types) => (Array.isArray(types) ? types : [])
  .filter((x) => typeof x === 'string')
  .map((x) => x.trim().toLowerCase());
const isNightlifeType = (x) => NIGHTLIFE_TYPE.test(x) && !NOT_NIGHTLIFE_TYPE.test(x);

// The app's category for a Google listing's types: the closed set the map
// and its filters share. App.js categorizeVenue answers with this. Food is
// the fallback, so a filter has somewhere to put every listing; the glyph a
// pin or row draws comes from glyphCategoryFor instead.
export const categorizeVenueTypes = (types) => {
  if (!types || types.length === 0) return 'Food';
  const t = types.join(' ').toLowerCase();
  if (typeTokens(types).some(isNightlifeType)) return 'Nightlife';
  if (t.includes('music') || t.includes('concert') || t.includes('performing_arts')) return 'Live Music';
  if (t.includes('stadium') || t.includes('gym') || t.includes('sports') || t.includes('bowling') || t.includes('fitness')) return 'Sports';
  if (t.includes('restaurant') || t.includes('cafe') || t.includes('bakery') || t.includes('food') || t.includes('pizza') || t.includes('meal') || t.includes('diner') || t.includes('juice') || t.includes('smoothie') || t.includes('brunch') || t.includes('breakfast')) return 'Food';
  return 'Food'; // default for libraries, parks, museums, etc.
};

// The kind of place a pin or a row draws: Nightlife, Live Music, Sports or
// Food when the listing's types say so, by the rule above, and Place, the
// place mark, for everything else (a shop, a park, a museum, a listing with
// no types at all), where the filters' category falls back to Food.
//
// Within those, the finer kinds above, read off whole types only: a wine bar
// or a winery is Wine, a pub, brewery or beer hall Beer (and stays Nightlife
// to the filters), a coffee shop, cafe or tea house that is not also a
// restaurant Cafe, and an arcade or amusement centre Games.
const WINE_TYPE = /^(?:wine_bar|winery|wine_lounge)$/;
const BEER_TYPE = /^(?:pub|[a-z_]+_pub|brewery|brewpub|beer_garden|beer_hall|taproom)$/;
const CAFE_TYPE = /^(?:cafe|coffee_shop|tea_house|cafeteria_coffee|coffee)$/;
const GAMES_TYPE = /^(?:amusement_center|video_arcade|arcade|game_store_arcade)$/;
export const glyphCategoryFor = (types) => {
  const list = typeTokens(types);
  if (!list.length) return 'Place';
  const category = categorizeVenueTypes(list);
  if (category === 'Nightlife') {
    if (list.some((x) => WINE_TYPE.test(x))) return 'Wine';
    if (list.some((x) => BEER_TYPE.test(x))) return 'Beer';
    return category;
  }
  if (category !== 'Food') return category;
  if (list.some((x) => GAMES_TYPE.test(x))) return 'Games';
  const t = list.join(' ');
  if (list.some((x) => CAFE_TYPE.test(x)) && !t.includes('restaurant')) return 'Cafe';
  const food = ['restaurant', 'cafe', 'bakery', 'food', 'pizza', 'meal', 'diner', 'juice', 'smoothie', 'brunch', 'breakfast'];
  return food.some((w) => t.includes(w)) ? 'Food' : 'Place';
};
