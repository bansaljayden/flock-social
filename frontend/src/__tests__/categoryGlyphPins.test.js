/**
 * A PLACE WITH NO PHOTO SHOWS WHAT KIND OF PLACE IT IS (2026-11-06).
 *
 * On the Discover map a venue with no photo was a dark disc with an "F" in it
 * (Food's initial), the same for a Mexican restaurant, a cafe and a bakery,
 * and in the search list a row with no photo was an empty square with its
 * text indented beside the gap. Pins and rows now draw the category's glyph
 * (lib/categoryGlyph.js): a fork and knife, a glass, a note, a ball, or a
 * place mark. The row draws it under the photo, so the slot is never empty
 * while a photo is on its way either.
 *
 * FRONTEND test (jest via react-scripts).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import ExploreScreen from '../screens/ExploreScreen';
import { glyphPaths, glyphSvgGroup, categorizeVenueTypes, CategoryGlyph } from '../lib/categoryGlyph';

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const MAP_SRC = read('components', 'map', 'MapLibreMapView.js');
const EXPLORE_SRC = read('screens', 'ExploreScreen.js');
const APP_SRC = read('App.js');

test('each category has its own drawing, and anything else the place mark', () => {
  const food = glyphPaths('Food');
  const glass = glyphPaths('Nightlife');
  const note = glyphPaths('Live Music');
  const ball = glyphPaths('Sports');
  const place = glyphPaths('Somewhere else');
  expect(new Set([food, glass, note, ball, place].map((p) => p.join('|'))).size).toBe(5);
  // Nothing off Object.prototype.
  expect(glyphPaths('constructor')).toBe(place);
  expect(glyphPaths('__proto__')).toBe(place);
  expect(glyphPaths(undefined)).toBe(place);
});

test('the pin markup is the glyph, centred and scaled, with no letter in it', () => {
  const g = glyphSvgGroup('Food', { cx: 16, cy: 14.5, size: 11, color: '#1e293b' });
  expect(g).toMatch(/^<g transform="translate\(10\.5 9\) scale\(0\.458\d*\)" fill="none" stroke="#1e293b"/);
  expect(g).toContain('<path d="M8 3 8 21"/>');
  expect(g).not.toMatch(/<text/);
});

test('the map draws the glyph on both pin shapes and no initial', () => {
  expect(MAP_SRC).toMatch(/glyphSvgGroup\(category, \{ cx: 16, cy: 14\.5, size: 11, color: body, strokeWidth: 2\.6 \}\)/);
  expect(MAP_SRC).toMatch(/glyphSvgGroup\(category, \{ cx: 22, cy: 22, size: 20, color: edge, strokeWidth: 2\.2 \}\)/);
  expect(MAP_SRC).not.toMatch(/initialMap/);
  expect(MAP_SRC).not.toMatch(/font-weight="bold" font-family="Hanken Grotesk,sans-serif" fill="\$\{(body|edge)\}">\$\{initial\}/);
});

test('one rule says what kind of place a listing is, for the pins and the rows', () => {
  expect(APP_SRC).toMatch(/const categorizeVenue = useCallback\(\(types\) => categorizeVenueTypes\(types\), \[\]\);/);
  expect(categorizeVenueTypes(['mexican_restaurant', 'restaurant', 'food'])).toBe('Food');
  expect(categorizeVenueTypes(['bar', 'restaurant'])).toBe('Nightlife');
  expect(categorizeVenueTypes(['performing_arts_theater'])).toBe('Live Music');
  expect(categorizeVenueTypes(['bowling_alley'])).toBe('Sports');
  expect(categorizeVenueTypes([])).toBe('Food');
});

test('a search row with no photo draws the glyph in its thumbnail; one with a photo draws it under the photo', () => {
  const start = EXPLORE_SRC.indexOf('export default function ExploreScreen({');
  const params = EXPLORE_SRC.slice(start, EXPLORE_SRC.indexOf('}) {', start)).split('\n').map((l) => l.trim())
    .filter((l) => /^[A-Za-z_]\w*(\s*=.*)?,$/.test(l)).map((l) => l.replace(/\s*=.*$/, '').replace(/,$/, ''));
  const props = {};
  for (const name of params) props[name] = jest.fn();
  const none = () => null;
  Object.assign(props, {
    DialogBehavior: none, EmptyMark: none, MapLibreMapView: none, BottomNav: none, SafetyButton: none, SearchInputLocal: none, ListSkeleton: none,
    renderConsumerVenueCard: none, REVIEW_HIDE_LOCATION_BANNER: false, fmtMoney: String, activeVenue: null, allVenues: [], budgetFilteredVenues: [],
    budgetStatus: null, category: 'All', categoryExpanded: false, colors: { navyMid: '#2d5a87' }, connectResults: [], connectSearch: '', connectSearchError: '',
    connectSearching: false, discoverNavOpen: false, eventsSearchQuery: '', eventsSearchTimerRef: { current: null }, featuredEvents: null,
    featuredEventsError: '', featuredEventsLoading: false, flockMemberLocations: {}, friendStatuses: {}, isDark: false, isExploreVisible: true,
    locationEnabled: true, locationError: '', locationLoading: false, mapVenuesLoaded: true, pickingVenueForCreate: false, pickingVenueForDm: false,
    pickingVenueForFlockId: null, sharingLocationForFlock: null, showConnectPanel: false, showEventsView: false, showSearchDropdown: true, tableParty: 2,
    userLocation: null, venueLoadError: '', venueQuery: 'tor', venueResultsFor: 'tor', venueSearching: false,
    venueResults: [
      { place_id: 'p_chimney', name: 'Tor Chimney and Fireplace', formatted_address: '4095 Ferry Rd', types: ['general_contractor', 'point_of_interest'] },
      { place_id: 'p_torre', name: 'Torre', formatted_address: '2960 Center Valley Pkwy', types: ['mexican_restaurant', 'restaurant'], photo_url: 'https://x.test/torre.jpg' },
    ],
  });
  render(<ExploreScreen {...props} />);
  const thumbOf = (name) => screen.getByRole('button', { name: new RegExp(name) }).querySelector('[data-row-thumb]');
  const chimney = thumbOf('Tor Chimney');
  expect(chimney.querySelector('svg path')).not.toBeNull();
  expect(chimney.querySelector('img')).toBeNull();
  const torre = thumbOf('^Torre');
  expect(torre.querySelector('svg path')).not.toBeNull();
  expect(torre.querySelector('img').getAttribute('src')).toBe('https://x.test/torre.jpg');
  // The fork and knife, Torre being a restaurant.
  const { container } = render(<CategoryGlyph category="Food" />);
  expect(torre.querySelector('svg').innerHTML).toBe(container.querySelector('svg').innerHTML);
});
