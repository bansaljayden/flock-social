/**
 * TAPPING THE SEARCH BOX AGAIN BRINGS ITS RESULTS BACK (2026-11-06).
 *
 * A tester had "melt" in the Discover search box with the list closed, tapped
 * the box, and got the keyboard over no list; the only way back to the
 * results was to select the query and type it again. A tap on the box with
 * two or more letters in it reopens the list, and rows that answer an older
 * query send the search the box is owed instead of sitting dimmed.
 *
 * FRONTEND test (jest via react-scripts).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ExploreScreen from '../screens/ExploreScreen';

const fs = require('fs');
const path = require('path');

const EXPLORE_SRC = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ExploreScreen.js'), 'utf8').replace(/\r\n/g, '\n');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
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
const MELT = { place_id: 'p_melt', name: 'Melt', formatted_address: '2880 Center Valley Pkwy' };
const box = () => screen.getByRole('textbox', { name: 'Search venues' });

test('a tap on the box with a query in it reopens the closed list', () => {
  const setShowSearchDropdown = jest.fn();
  const runVenueSearchNow = jest.fn();
  render(<ExploreScreen {...exploreProps({ venueQuery: 'melt', venueResults: [MELT], venueResultsFor: 'melt', setShowSearchDropdown, runVenueSearchNow })} />);
  fireEvent.click(box());
  expect(setShowSearchDropdown).toHaveBeenCalledWith(true);
  // The rows already answer "melt": nothing to send.
  expect(runVenueSearchNow).not.toHaveBeenCalled();
});

test('rows that answer an older query send the search the box is owed', () => {
  const runVenueSearchNow = jest.fn();
  render(<ExploreScreen {...exploreProps({ venueQuery: 'melting', venueResults: [MELT], venueResultsFor: 'melt', runVenueSearchNow })} />);
  fireEvent.click(box());
  expect(runVenueSearchNow).toHaveBeenCalledTimes(1);
});

test('one letter or none: the tap is only a tap', () => {
  const setShowSearchDropdown = jest.fn();
  render(<ExploreScreen {...exploreProps({ venueQuery: 'm', setShowSearchDropdown })} />);
  fireEvent.click(box());
  expect(setShowSearchDropdown).not.toHaveBeenCalled();
});

test('a tap and not a focus, so the sheet handing focus back on a laptop does not reopen the list over the card', () => {
  const input = EXPLORE_SRC.slice(EXPLORE_SRC.indexOf('<input aria-label="Search venues"'), EXPLORE_SRC.indexOf('/>', EXPLORE_SRC.indexOf('<input aria-label="Search venues"')));
  expect(input).toMatch(/onClick=\{reopenSearchList\}/);
  expect(input).not.toMatch(/onFocus=/);
  // The search it sends skips the wait and is the box's own query.
  const run = APP_SRC.slice(APP_SRC.indexOf('const runVenueSearchNow = useCallback('), APP_SRC.indexOf('}, [doVenueSearch]);', APP_SRC.indexOf('const runVenueSearchNow = useCallback(')));
  expect(run).toMatch(/clearTimeout\(searchTimerRef\.current\)/);
  expect(run).toMatch(/doVenueSearch\(q\)/);
});
