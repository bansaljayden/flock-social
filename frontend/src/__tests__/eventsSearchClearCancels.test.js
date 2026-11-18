/**
 * A CLEARED EVENTS SEARCH STAYS CLEARED.
 *
 * The events drawer's search box commits upward and the Ticketmaster search
 * goes out 280ms behind that (screens/ExploreScreen.js). The X button and a
 * box emptied by hand both read "this week nearby" straight away, but neither
 * cancelled the search still waiting on its timer, so it went out a moment
 * later and its answer, being the newest request, replaced the nearby list:
 * search results for a word no longer in the box, under "This week nearby".
 * A late answer to a search already sent is dropped by fetchFeaturedEvents's
 * own sequence, since the clear's read is newer.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test eventsSearchClearCancels --watchAll=false
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ExploreScreen from '../screens/ExploreScreen';

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

// The box itself is App.js's; this one hands its commit to the test.
const commits = {};
const SearchInputLocal = (props) => {
  commits[props['aria-label']] = props.onCommit;
  return <input aria-label={props['aria-label']} readOnly value="" />;
};

const HERE = { lat: 39.95, lng: -75.16 };
const exploreProps = (over = {}) => {
  const p = {};
  for (const name of EXPLORE_PARAMS) p[name] = jest.fn();
  return Object.assign(p, {
    DialogBehavior: none, EmptyMark: none, MapLibreMapView: none, BottomNav: none, SafetyButton: none, SearchInputLocal,
    renderConsumerVenueCard: none, REVIEW_HIDE_LOCATION_BANNER: false, fmtMoney: String, ListSkeleton: none,
    activeVenue: null, allVenues: [], budgetFilteredVenues: [], budgetStatus: null, category: 'All', categoryExpanded: false,
    colors: {}, connectResults: [], connectSearch: '', connectSearchError: '', connectSearching: false, discoverNavOpen: false,
    eventsSearchQuery: '', eventsSearchTimerRef: { current: null }, featuredEvents: [], featuredEventsError: '', featuredEventsLoading: false,
    flockMemberLocations: {}, friendStatuses: {}, isDark: false, isExploreVisible: true, locationEnabled: true, locationError: '',
    locationLoading: false, mapVenuesLoaded: true, pickingVenueForCreate: false, pickingVenueForDm: false, pickingVenueForFlockId: null,
    sharingLocationForFlock: null, showConnectPanel: false, showEventsView: true, showSearchDropdown: false, tableParty: 2,
    userLocation: HERE, venueLoadError: '', venueQuery: '', venueResults: [], venueResultsFor: '', venueSearching: false,
  }, over);
};

const searchedFor = (fetch, word) => fetch.mock.calls.some(([, q]) => q === word);

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

test('the X cancels a search still waiting to go out', () => {
  const props = exploreProps();
  const { rerender } = render(<ExploreScreen {...props} />);
  act(() => { commits['Search events']('jazz'); });
  // App.js now holds the word, so the X is drawn.
  rerender(<ExploreScreen {...props} eventsSearchQuery="jazz" />);
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(props.fetchFeaturedEvents).toHaveBeenLastCalledWith(`${HERE.lat},${HERE.lng}`);
  act(() => { jest.advanceTimersByTime(1000); });
  expect(searchedFor(props.fetchFeaturedEvents, 'jazz')).toBe(false);
});

test('a box emptied by hand cancels it too', () => {
  const props = exploreProps();
  render(<ExploreScreen {...props} />);
  act(() => { commits['Search events']('jazz'); });
  act(() => { commits['Search events'](''); });
  act(() => { jest.advanceTimersByTime(1000); });
  expect(searchedFor(props.fetchFeaturedEvents, 'jazz')).toBe(false);
  expect(props.fetchFeaturedEvents).toHaveBeenLastCalledWith(`${HERE.lat},${HERE.lng}`);
});

test('a search left alone still goes out after the pause', () => {
  const props = exploreProps();
  render(<ExploreScreen {...props} />);
  act(() => { commits['Search events']('jazz'); });
  act(() => { jest.advanceTimersByTime(280); });
  expect(props.fetchFeaturedEvents).toHaveBeenLastCalledWith(`${HERE.lat},${HERE.lng}`, 'jazz');
});
