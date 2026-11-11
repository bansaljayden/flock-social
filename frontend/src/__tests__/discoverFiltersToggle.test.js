/**
 * THE FILTERS TOGGLE ON DISCOVER HAS A NAME WHEN IT IS AN X.
 *
 * Closed, the button under the map reads "Filters" (or "Filters · Food"), and
 * those words are its name. Open, it draws the category chips beside it and
 * becomes an x icon and nothing else, so it had no accessible name: a screen
 * reader said "button", and the click-through crawl of 2026-11-11 listed it as
 * an unnamed control at the Discover state its Filters tap opened. It is
 * "Close filters" now, and it says whether the row is open (aria-expanded).
 *
 * FRONTEND test (jest via react-scripts).
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test discoverFiltersToggle --watchAll=false
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ExploreScreen from '../screens/ExploreScreen';

const fs = require('fs');
const path = require('path');

// The same props builder discoverResultCounts.test.js uses: every parameter
// the screen declares, as a spy, then the values a render needs.
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

test('closed, its words are its name and it says the row is closed', () => {
  render(<ExploreScreen {...exploreProps({ category: 'Food' })} />);
  const toggle = screen.getByRole('button', { name: 'Filters · Food' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.hasAttribute('aria-label')).toBe(false);
});

test('open, the x is "Close filters", says the row is open, and closes it', () => {
  const p = exploreProps({ categoryExpanded: true });
  render(<ExploreScreen {...p} />);
  const toggle = screen.getByRole('button', { name: 'Close filters' });
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  // The chips it opened are there beside it.
  expect(screen.getByRole('button', { name: 'Nightlife' })).toBeTruthy();
  fireEvent.click(toggle);
  expect(p.setCategoryExpanded).toHaveBeenCalledWith(false);
});

test('no button on the open row is left without a name', () => {
  const { container } = render(<ExploreScreen {...exploreProps({ categoryExpanded: true })} />);
  const unnamed = [...container.querySelectorAll('button')].filter((b) => !(b.getAttribute('aria-label') || b.textContent || '').trim());
  expect(unnamed.map((b) => b.outerHTML.slice(0, 120))).toEqual([]);
});
