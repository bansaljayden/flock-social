/**
 * "1 RESULT", NOT "ALL 1 RESULTS", AND THE CHIP CLEAR OF THE ZOOM BUTTONS
 * (2026-11-06).
 *
 * A tester's search for "torre" read "See All Results (1)" in the list and
 * "All 1 results" on the map; an earlier "All 12 re..." chip was cut off under
 * the zoom + button. The words are singular and plural now ("1 result" /
 * "All 12 results", "See 1 result" / "See all 12"), and the chip sits top left
 * and is not drawn while the list is open: with the list and the keyboard up
 * the map is a short strip and the zoom stack rises into the top right.
 *
 * FRONTEND test (jest via react-scripts).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import ExploreScreen, { resultsChipLabel, seeAllLabel } from '../screens/ExploreScreen';

const fs = require('fs');
const path = require('path');

const EXPLORE_SRC = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ExploreScreen.js'), 'utf8').replace(/\r\n/g, '\n');
const EXPLORE_PARAMS = (() => {
  const start = EXPLORE_SRC.indexOf('export default function ExploreScreen({');
  const end = EXPLORE_SRC.indexOf('}) {', start);
  return EXPLORE_SRC.slice(start, end).split('\n').map((l) => l.trim())
    .filter((l) => /^[A-Za-z_]\w*(\s*=.*)?,$/.test(l))
    .map((l) => l.replace(/\s*=.*$/, '').replace(/,$/, ''));
})();
const none = () => null;
const exploreProps = (over = {}) => {
  const p = {};
  for (const name of EXPLORE_PARAMS) p[name] = jest.fn();
  return Object.assign(p, {
    DialogBehavior: none, EmptyMark: none, MapLibreMapView: none, BottomNav: none, SafetyButton: none, SearchInputLocal: none,
    renderConsumerVenueCard: none, REVIEW_HIDE_LOCATION_BANNER: false, fmtMoney: String, ListSkeleton: none,
    activeVenue: null, allVenues: [], budgetFilteredVenues: [], budgetStatus: null, category: 'All', categoryExpanded: false,
    colors: {}, connectResults: [], connectSearch: '', connectSearchError: '', connectSearching: false, discoverNavOpen: false,
    eventsSearchQuery: '', eventsSearchTimerRef: { current: null }, featuredEvents: null, featuredEventsError: '', featuredEventsLoading: false,
    flockMemberLocations: {}, friendStatuses: {}, isDark: false, isExploreVisible: true, locationEnabled: true, locationError: '',
    locationLoading: false, mapVenuesLoaded: true, pickingVenueForCreate: false, pickingVenueForDm: false, pickingVenueForFlockId: null,
    sharingLocationForFlock: null, showConnectPanel: false, showEventsView: false, showSearchDropdown: false, tableParty: 2,
    userLocation: null, venueLoadError: '', venueQuery: '', venueResults: [], venueResultsFor: '', venueSearching: false,
  }, over);
};
const venue = (i) => ({ place_id: `p${i}`, name: `Place ${i}`, formatted_address: `${i} Main St` });
const list = (n) => Array.from({ length: n }, (_, i) => venue(i));

test('the words, one and many', () => {
  expect(resultsChipLabel(1)).toBe('1 result');
  expect(resultsChipLabel(12)).toBe('All 12 results');
  expect(seeAllLabel(1)).toBe('See 1 result');
  expect(seeAllLabel(12)).toBe('See all 12');
});

test('one result: the list button and the map chip say so in the singular', () => {
  const { unmount } = render(<ExploreScreen {...exploreProps({ venueQuery: 'torre', venueResults: list(1), venueResultsFor: 'torre', showSearchDropdown: true })} />);
  expect(screen.getByRole('button', { name: /See 1 result/ })).toBeTruthy();
  expect(screen.queryByText(/See All Results/)).toBeNull();
  unmount();
  render(<ExploreScreen {...exploreProps({ budgetFilteredVenues: list(1), allVenues: list(1) })} />);
  expect(screen.getByRole('button', { name: '1 result' })).toBeTruthy();
});

test('twelve: "See all 12" and "All 12 results"', () => {
  const { unmount } = render(<ExploreScreen {...exploreProps({ venueQuery: 'tor', venueResults: list(12), venueResultsFor: 'tor', showSearchDropdown: true })} />);
  expect(screen.getByRole('button', { name: /See all 12/ })).toBeTruthy();
  unmount();
  render(<ExploreScreen {...exploreProps({ budgetFilteredVenues: list(12), allVenues: list(12) })} />);
  expect(screen.getByRole('button', { name: 'All 12 results' })).toBeTruthy();
});

test('the chip is not drawn while the list is open, and sits top left when it is', () => {
  const { unmount } = render(<ExploreScreen {...exploreProps({ venueQuery: 'tor', venueResults: list(12), venueResultsFor: 'tor', showSearchDropdown: true, budgetFilteredVenues: list(12), allVenues: list(12) })} />);
  expect(screen.queryByRole('button', { name: 'All 12 results' })).toBeNull();
  unmount();
  render(<ExploreScreen {...exploreProps({ budgetFilteredVenues: list(12), allVenues: list(12) })} />);
  const chip = screen.getByRole('button', { name: 'All 12 results' });
  expect(chip.style.left).toBe('12px');
  expect(chip.style.right).toBe('');
});
