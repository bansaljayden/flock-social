/**
 * A COMMITTED SEARCH FRAMES THE RESULTS NEAR YOU (2026-11-06).
 *
 * A tester's map read "All 20 results" with one pin in view (it was left
 * zoomed on the venue he had opened), and a prefix search that found a place
 * 40 km away and a namesake 125 km away flew the map to New York. A committed
 * search, Return in the box, See all, or the count chip, now frames the
 * results within 25 km of the person, or the cluster when none is that close
 * (lib/fitResults.js). Return also searches at once instead of waiting out the
 * typing pause, and the frame comes with that search's pins (App.js
 * commitSearchPins).
 *
 * FRONTEND test (jest via react-scripts).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ExploreScreen from '../screens/ExploreScreen';
import { framePoints, clusterPoints, COMMITTED_FIT_RADIUS_KM } from '../lib/fitResults';

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const EXPLORE_SRC = read('screens', 'ExploreScreen.js');
const MAP_SRC = read('components', 'map', 'MapLibreMapView.js');
const APP_SRC = read('App.js');

const ME = [-75.3705, 40.6259];
const COPPER = [-75.3702, 40.6262]; // next door
const TORRE = [-75.4072, 40.5512]; // 9 km
const CHIMNEY = [-75.1299, 40.3101]; // ~40 km
const HIGH_TOR = [-73.9898, 41.1476]; // ~130 km

describe('which results a committed search frames', () => {
  test('the ones within 25 km of the person', () => {
    expect(COMMITTED_FIT_RADIUS_KM).toBe(25);
    expect(framePoints([CHIMNEY, TORRE, HIGH_TOR, COPPER], { center: ME })).toEqual([TORRE, COPPER]);
  });
  test('with none that close, the cluster the map always used', () => {
    expect(framePoints([CHIMNEY, HIGH_TOR], { center: ME })).toEqual(clusterPoints([CHIMNEY, HIGH_TOR]));
  });
  test('with no location, the cluster', () => {
    expect(framePoints([COPPER, TORRE, HIGH_TOR])).toEqual(clusterPoints([COPPER, TORRE, HIGH_TOR]));
    // The cluster drops the far outlier from three.
    expect(clusterPoints([COPPER, TORRE, HIGH_TOR])).toEqual([COPPER, TORRE]);
  });
  test('nothing to frame, nothing framed', () => {
    expect(framePoints([], { center: ME })).toEqual([]);
  });
});

const EXPLORE_PARAMS = (() => {
  const start = EXPLORE_SRC.indexOf('export default function ExploreScreen({');
  return EXPLORE_SRC.slice(start, EXPLORE_SRC.indexOf('}) {', start)).split('\n').map((l) => l.trim())
    .filter((l) => /^[A-Za-z_]\w*(\s*=.*)?,$/.test(l)).map((l) => l.replace(/\s*=.*$/, '').replace(/,$/, ''));
})();
const exploreProps = (over = {}) => {
  const props = {};
  for (const name of EXPLORE_PARAMS) props[name] = jest.fn();
  const none = () => null;
  return Object.assign(props, {
    DialogBehavior: none, EmptyMark: none, MapLibreMapView: (p) => <div data-testid="map" data-fit={p.fitRequest ? String(p.fitRequest.seq) : ''} />,
    BottomNav: none, SafetyButton: none, SearchInputLocal: none, ListSkeleton: none,
    renderConsumerVenueCard: none, REVIEW_HIDE_LOCATION_BANNER: false, fmtMoney: String, activeVenue: null, allVenues: [], budgetFilteredVenues: [],
    budgetStatus: null, category: 'All', categoryExpanded: false, colors: {}, connectResults: [], connectSearch: '', connectSearchError: '',
    connectSearching: false, discoverNavOpen: false, eventsSearchQuery: '', eventsSearchTimerRef: { current: null }, featuredEvents: null,
    featuredEventsError: '', featuredEventsLoading: false, flockMemberLocations: {}, friendStatuses: {}, isDark: false, isExploreVisible: true,
    locationEnabled: true, locationError: '', locationLoading: false, mapVenuesLoaded: true, pickingVenueForCreate: false, pickingVenueForDm: false,
    pickingVenueForFlockId: null, sharingLocationForFlock: null, showConnectPanel: false, showEventsView: false, showSearchDropdown: true, tableParty: 2,
    userLocation: null, venueLoadError: '', venueQuery: '', venueResults: [], venueResultsFor: '', venueSearching: false, mapFitRequest: null,
  }, over);
};
const box = () => screen.getByRole('textbox', { name: 'Search venues' });
const ROW = { place_id: 'p1', name: 'Copper Finch Cantina', formatted_address: '214 Main St' };

describe('what commits a search', () => {
  test('Return in the box searches now and asks for the frame, and the keyboard is told it is a search box', () => {
    const commitVenueSearch = jest.fn();
    render(<ExploreScreen {...exploreProps({ venueQuery: 'copper', commitVenueSearch })} />);
    expect(box().getAttribute('enterkeyhint')).toBe('search');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(commitVenueSearch).toHaveBeenCalledTimes(1);
  });

  test('Return with one letter does nothing', () => {
    const commitVenueSearch = jest.fn();
    render(<ExploreScreen {...exploreProps({ venueQuery: 'c', commitVenueSearch })} />);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(commitVenueSearch).not.toHaveBeenCalled();
  });

  test('See all commits the answer on screen, and the count chip frames the pins already there', () => {
    const requestMapFit = jest.fn();
    const commitVenueResults = jest.fn();
    const { unmount } = render(<ExploreScreen {...exploreProps({ venueQuery: 'copper', venueResults: [ROW], venueResultsFor: 'copper', requestMapFit, commitVenueResults })} />);
    fireEvent.click(screen.getByRole('button', { name: /See 1 result/ }));
    // commitVenueResults makes the rows the pins and asks for the frame with
    // them (App.js commitSearchPins).
    expect(commitVenueResults).toHaveBeenCalledTimes(1);
    unmount();
    render(<ExploreScreen {...exploreProps({ showSearchDropdown: false, budgetFilteredVenues: [ROW], allVenues: [ROW], requestMapFit, commitVenueResults })} />);
    fireEvent.click(screen.getByRole('button', { name: '1 result' }));
    expect(requestMapFit).toHaveBeenCalledTimes(1);
    expect(commitVenueResults).toHaveBeenCalledTimes(1);
  });

  test('the map is handed the request', () => {
    render(<ExploreScreen {...exploreProps({ mapFitRequest: { seq: 7, center: null, radiusKm: 25 } })} />);
    expect(screen.getByTestId('map').getAttribute('data-fit')).toBe('7');
  });
});

describe('the wiring', () => {
  test('App asks for the frame in the same render as the pins it frames', () => {
    // The pins and the request are written together (commitSearchPins), so
    // the map never frames the pins of an earlier answer; a Return that has
    // to wait for its answer leaves the query in pendingPinsCommitRef, and
    // the answer commits when it lands (discoverSearchCommitsPins.test.js).
    const pins = APP_SRC.slice(APP_SRC.indexOf('const commitSearchPins = useCallback('), APP_SRC.indexOf('const doVenueSearch = useCallback('));
    expect(pins).toMatch(/setAllVenues\(venues\.length > 0 \? venuesToMapPins\(venues\) : \[\]\);\s*setActiveVenue\(null\);\s*requestMapFit\(focus\);/);
    const commit = APP_SRC.slice(APP_SRC.indexOf('const commitVenueSearch = useCallback('), APP_SRC.indexOf('const commitVenueResults = useCallback('));
    expect(commit).toMatch(/pendingPinsCommitRef\.current = q;\s*runVenueSearchNow\(\);/);
    expect(APP_SRC).not.toMatch(/mapFitRequestReady|waitFor: waitFor/);
  });

  test('the map frames a request once, after its marker effect, with the 25 km rule', () => {
    expect(MAP_SRC).toMatch(/fitRequest = null \}\) => \{/);
    const effect = MAP_SRC.slice(MAP_SRC.indexOf('const lastFitSeqRef = useRef(null);'), MAP_SRC.indexOf('}, [fitRequest, venues, mapReady]);'));
    expect(effect).toMatch(/fitRequest\.seq === lastFitSeqRef\.current\) return;/);
    expect(effect).toMatch(/framePoints\(points, \{ center: at, radiusKm: fitRequest\.radiusKm \|\| COMMITTED_FIT_RADIUS_KM \}\)/);
    expect(MAP_SRC.indexOf('const lastFitSeqRef')).toBeGreaterThan(MAP_SRC.indexOf('const core = clusterPoints(points);'));
  });
});
