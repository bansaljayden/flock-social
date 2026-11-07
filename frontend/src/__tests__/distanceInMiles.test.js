/**
 * DISTANCES IN MILES FOR A US PHONE (2026-11-06).
 *
 * A tester in Pennsylvania read "15.7km", "39.6km" and "125.4km" in the
 * Discover search list. Every distance the app printed was in kilometres,
 * written three times over (the search dropdown, the full results list and
 * the map's calcDistance), and the events list a fourth. One formatDistance
 * (lib/distance.js) now prints them all, in miles where road distances are
 * posted in miles (the United States, the United Kingdom, Liberia, Myanmar)
 * and kilometres elsewhere, with a space before the unit.
 *
 * FRONTEND test (jest via react-scripts).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import ExploreScreen from '../screens/ExploreScreen';
import { formatDistance, usesMiles, haversineKm } from '../lib/distance';

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const EXPLORE_SRC = read('screens', 'ExploreScreen.js');
const OVERLAY_SRC = read('components', 'SearchResultsOverlay.js');
const APP_SRC = read('App.js');
const EVENTS_SRC = read('lib', 'eventWhereWhen.js');

describe('the unit follows the region', () => {
  test('miles in the US, the UK, Liberia and Myanmar; kilometres elsewhere', () => {
    expect(usesMiles('en-US')).toBe(true);
    expect(usesMiles('es-US')).toBe(true);
    expect(usesMiles('en-GB')).toBe(true);
    expect(usesMiles('en')).toBe(true);
    expect(usesMiles('en-CA')).toBe(false);
    expect(usesMiles('fr-FR')).toBe(false);
    expect(usesMiles('de')).toBe(false);
    expect(usesMiles('en-IN')).toBe(false);
  });

  test('miles: feet under a tenth, tenths under ten, whole miles past that', () => {
    const us = { locale: 'en-US' };
    expect(formatDistance(0.042, us)).toBe('150 ft');
    expect(formatDistance(0.001, us)).toBe('50 ft');
    expect(formatDistance(0.2, us)).toBe('0.1 mi');
    expect(formatDistance(15.7, us)).toBe('9.8 mi');
    expect(formatDistance(39.6, us)).toBe('25 mi');
    expect(formatDistance(125.4, us)).toBe('78 mi');
  });

  test('kilometres: metres under one, tenths under ten, whole kilometres past that', () => {
    const fr = { locale: 'fr-FR' };
    expect(formatDistance(0.042, fr)).toBe('40 m');
    expect(formatDistance(0.8, fr)).toBe('800 m');
    expect(formatDistance(2.345, fr)).toBe('2.3 km');
    expect(formatDistance(15.7, fr)).toBe('16 km');
  });

  test('nothing to print is printed as nothing', () => {
    expect(formatDistance(null)).toBe('');
    expect(formatDistance(NaN)).toBe('');
    expect(formatDistance(-1)).toBe('');
  });

  test('the haversine', () => {
    expect(haversineKm(40.6259, -75.3705, 40.6262, -75.3702)).toBeCloseTo(0.042, 2);
  });
});

test('the search dropdown prints miles on a US device', () => {
  // jsdom's navigator.language is en-US.
  expect(navigator.language).toBe('en-US');
  const src = EXPLORE_SRC;
  const start = src.indexOf('export default function ExploreScreen({');
  const params = src.slice(start, src.indexOf('}) {', start)).split('\n').map((l) => l.trim())
    .filter((l) => /^[A-Za-z_]\w*(\s*=.*)?,$/.test(l)).map((l) => l.replace(/\s*=.*$/, '').replace(/,$/, ''));
  const props = {};
  for (const name of params) props[name] = jest.fn();
  const none = () => null;
  Object.assign(props, {
    DialogBehavior: none, EmptyMark: none, MapLibreMapView: none, BottomNav: none, SafetyButton: none, SearchInputLocal: none, ListSkeleton: none,
    renderConsumerVenueCard: none, REVIEW_HIDE_LOCATION_BANNER: false, fmtMoney: String, activeVenue: null, allVenues: [], budgetFilteredVenues: [],
    budgetStatus: null, category: 'All', categoryExpanded: false, colors: {}, connectResults: [], connectSearch: '', connectSearchError: '',
    connectSearching: false, discoverNavOpen: false, eventsSearchQuery: '', eventsSearchTimerRef: { current: null }, featuredEvents: null,
    featuredEventsError: '', featuredEventsLoading: false, flockMemberLocations: {}, friendStatuses: {}, isDark: false, isExploreVisible: true,
    locationEnabled: true, locationError: '', locationLoading: false, mapVenuesLoaded: true, pickingVenueForCreate: false, pickingVenueForDm: false,
    pickingVenueForFlockId: null, sharingLocationForFlock: null, showConnectPanel: false, showEventsView: false, showSearchDropdown: true, tableParty: 2,
    userLocation: { lat: 40.6259, lng: -75.3705 }, venueLoadError: '', venueQuery: 'torre', venueResultsFor: 'torre', venueSearching: false,
    venueResults: [{ place_id: 'p_torre', name: 'Torre', formatted_address: '2960 Center Valley Pkwy', location: { latitude: 40.5512, longitude: -75.4072 } }],
  });
  render(<ExploreScreen {...props} />);
  const row = screen.getByRole('button', { name: /Torre/ });
  expect(row.textContent).toMatch(/\d+(\.\d)? mi/);
  expect(row.textContent).not.toMatch(/km/);
});

test('every place that printed a distance prints it through formatDistance', () => {
  expect(EXPLORE_SRC).toMatch(/\{formatDistance\(haversineKm\(userLocation\.lat, userLocation\.lng, venue\.location\.latitude, venue\.location\.longitude\)\)\}/);
  expect(OVERLAY_SRC).toMatch(/\{Icons\.mapPin\(colors\.steel, 12\)\} \{formatDistance\(dist\)\}/);
  expect(APP_SRC).toMatch(/const calcDistance = useCallback\(\(lat1, lng1, lat2, lng2\) => formatDistance\(distanceKm\(lat1, lng1, lat2, lng2\)\), \[distanceKm\]\);/);
  expect(EVENTS_SRC).toMatch(/return formatDistance\(km, options\);/);
  // No hand-built "km" string is left in any of them.
  for (const src of [EXPLORE_SRC, OVERLAY_SRC, EVENTS_SRC]) expect(src).not.toMatch(/toFixed\(1\)\}km/);
  expect(APP_SRC).not.toMatch(/`\$\{d\.toFixed\(1\)\}km`/);
});
