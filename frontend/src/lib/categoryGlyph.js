// WHAT KIND OF PLACE, DRAWN, FOR A PLACE WITH NO PHOTO.
//
// A map pin with no photo carried the first letter of its category, "F" for
// Food, so a Mexican restaurant and a bakery were both a dark disc with an F
// in it, and a search row with no photo was an empty grey square. These are
// the glyphs instead: a fork and knife, a stemmed glass, a note, a ball, and a
// place mark for anything else, drawn on the app's 24-unit grid with round
// strokes like components/ui/Icons.js (the glass and the note are its
// drawings).
//
// The map builds its pins as SVG text, so the glyphs are path data here,
// constants keyed by the kind of place glyphCategoryFor (below) reads off a
// listing's types. The lookup is own-property only: an owner-typed category
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

import React from 'react';

const GLYPHS = {
  // Fork (three tines and a bowl) beside a knife with its blade on the left.
  Food: ['M5 3 5 8', 'M8 3 8 21', 'M11 3 11 8', 'M5 8A3 3 0 0 0 11 8', 'M18 21 18 3C15.5 3 14 5.5 14 9L14 13 18 13'],
  // Stemware, Icons.cocktail's drawing.
  Nightlife: ['M4 6 20 6 12 14Z', 'M12 14 12 20', 'M8 20 16 20'],
  // Two beamed notes, Icons.music's drawing.
  'Live Music': ['M9 17 9 5 19 5 19 15', 'M3 17A3 3 0 1 0 9 17A3 3 0 1 0 3 17Z', 'M13 15A3 3 0 1 0 19 15A3 3 0 1 0 13 15Z'],
  // A ball with its seams, Icons.sports's drawing.
  Sports: ['M3 12A9 9 0 1 0 21 12A9 9 0 1 0 3 12Z', 'M4.5 8 19.5 8', 'M4.5 16 19.5 16'],
  // A place mark with its centre.
  Place: ['M12 21C12 21 5 14.5 5 9.5A7 7 0 0 1 19 9.5C19 14.5 12 21 12 21Z', 'M10 9.5A2 2 0 1 0 14 9.5A2 2 0 1 0 10 9.5Z'],
};

export const glyphPaths = (category) => (
  (typeof category === 'string' && Object.prototype.hasOwnProperty.call(GLYPHS, category) && GLYPHS[category]) || GLYPHS.Place
);

// The glyph as an SVG <g>, for a pin built as markup: scaled from the 24 grid
// to `size` units and centred on (cx, cy) of the host SVG's own viewBox.
// `color` is one of the map's own palette constants, never user text.
export const glyphSvgGroup = (category, { cx, cy, size, color, strokeWidth = 2.4 }) => {
  const k = size / 24;
  const x = cx - size / 2;
  const y = cy - size / 2;
  const d = glyphPaths(category).map((p) => `<path d="${p}"/>`).join('');
  return `<g transform="translate(${x} ${y}) scale(${k})" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${d}</g>`;
};

// The same glyph as a React element, for a list row's empty thumbnail.
export function CategoryGlyph({ category, color = 'currentColor', size = 20, strokeWidth = 2 }) {
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {glyphPaths(category).map((d) => <path key={d} d={d} />)}
    </svg>
  );
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
export const glyphCategoryFor = (types) => {
  const list = typeTokens(types);
  if (!list.length) return 'Place';
  const category = categorizeVenueTypes(list);
  if (category !== 'Food') return category;
  const t = list.join(' ');
  const food = ['restaurant', 'cafe', 'bakery', 'food', 'pizza', 'meal', 'diner', 'juice', 'smoothie', 'brunch', 'breakfast'];
  return food.some((w) => t.includes(w)) ? 'Food' : 'Place';
};
