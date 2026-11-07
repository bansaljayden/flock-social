/**
 * THE DISCOVER MAP MOVES WHEN THE PERSON COMMITS, AND THE FOUR ROWS ARE
 * NEAREST FIRST (2026-11-06, S4 of the tester's recording).
 *
 * Typing "tor" from Bethlehem PA listed Tor Chimney & Fireplace (40 km) and
 * High Tor State Park (125 km) above anything near, and every debounced
 * keystroke swapped the map's pins for that keystroke's answer and refit the
 * map to them: it flew over blank tiles to New York while the person was
 * still typing "torre", and was still there when Torre (16 km) reached the
 * list. Now:
 *
 *   - the four rows under the box are ordered by distance from the person
 *     (lib/distance.js nearestFirst), rows with no position last;
 *   - a typed search fills the list and nothing else. The map's pins become a
 *     search's results, and the map moves, only when the person commits: a
 *     row tap (the map goes to that place), Return (the results within 25 km
 *     are framed once they land), or See all (the same frame).
 *
 * FRONTEND test (jest via react-scripts).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ExploreScreen from '../screens/ExploreScreen';
import { nearestFirst } from '../lib/distance';

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const EXPLORE_SRC = read('screens', 'ExploreScreen.js');
const MAP_SRC = read('components', 'map', 'MapLibreMapView.js');
const APP = read('App.js');

// Bethlehem PA, where the recording was made, and the places "tor" found.
const ME = { lat: 40.6259, lng: -75.3705 };
const at = (lat, lng) => ({ latitude: lat, longitude: lng });
const COPPER = { place_id: 'p_copper', name: 'Copper Finch Cantina', formatted_address: '214 Main St', location: at(40.6262, -75.3702) };
const TORRE = { place_id: 'p_torre', name: 'Torre', formatted_address: 'Lehigh Valley Mall', location: at(40.5512, -75.4072) };
const CHIMNEY = { place_id: 'p_chimney', name: 'Tor Chimney & Fireplace', formatted_address: 'Doylestown PA', location: at(40.3101, -75.1299) };
const HIGH_TOR = { place_id: 'p_hightor', name: 'High Tor State Park', formatted_address: 'New City NY', location: at(41.1476, -73.9898) };
const NOWHERE = { place_id: 'p_nowhere', name: 'Tor Online Shop', formatted_address: '', location: null };

describe('nearest first', () => {
  test('rows with a position by distance, then the rest in the order they came', () => {
    expect(nearestFirst([HIGH_TOR, NOWHERE, CHIMNEY, TORRE, COPPER], ME).map((v) => v.place_id))
      .toEqual(['p_copper', 'p_torre', 'p_chimney', 'p_hightor', 'p_nowhere']);
  });
  test('with no position for the person, the search\'s own order', () => {
    const list = [HIGH_TOR, CHIMNEY, TORRE];
    expect(nearestFirst(list, null)).toEqual(list);
    expect(nearestFirst(list, null)).not.toBe(list);
  });
  test('a position given as null is no position, not 0,0', () => {
    const half = { place_id: 'p_half', location: { latitude: null, longitude: null } };
    expect(nearestFirst([half, TORRE], ME).map((v) => v.place_id)).toEqual(['p_torre', 'p_half']);
  });
  test('two places the same distance away keep the search\'s order', () => {
    const twin = { ...TORRE, place_id: 'p_twin', name: 'Torre Too' };
    expect(nearestFirst([twin, TORRE], ME).map((v) => v.place_id)).toEqual(['p_twin', 'p_torre']);
  });
});

const EXPLORE_PARAMS = (() => {
  const start = EXPLORE_SRC.indexOf('export default function ExploreScreen({');
  return EXPLORE_SRC.slice(start, EXPLORE_SRC.indexOf('}) {', start)).split('\n').map((l) => l.trim())
    .filter((l) => /^[A-Za-z_]\w*(\s*=.*)?,$/.test(l)).map((l) => l.replace(/\s*=.*$/, '').replace(/,$/, ''));
})();
const none = () => null;
const exploreProps = (over = {}) => {
  const props = {};
  for (const name of EXPLORE_PARAMS) props[name] = jest.fn();
  return Object.assign(props, {
    DialogBehavior: none, EmptyMark: none, MapLibreMapView: none, BottomNav: none, SafetyButton: none, SearchInputLocal: none,
    ListSkeleton: none, renderConsumerVenueCard: none, REVIEW_HIDE_LOCATION_BANNER: false, fmtMoney: String, activeVenue: null,
    allVenues: [], budgetFilteredVenues: [], budgetStatus: null, category: 'All', categoryExpanded: false, colors: {}, connectResults: [],
    connectSearch: '', connectSearchError: '', connectSearching: false, discoverNavOpen: false, eventsSearchQuery: '',
    eventsSearchTimerRef: { current: null }, featuredEvents: null, featuredEventsError: '', featuredEventsLoading: false,
    flockMemberLocations: {}, friendStatuses: {}, isDark: false, isExploreVisible: true, locationEnabled: true, locationError: '',
    locationLoading: false, mapVenuesLoaded: true, pickingVenueForCreate: false, pickingVenueForDm: false, pickingVenueForFlockId: null,
    sharingLocationForFlock: null, showConnectPanel: false, showEventsView: false, showSearchDropdown: true, tableParty: 2,
    userLocation: null, venueLoadError: '', venueQuery: 'tor', venueResults: [], venueResultsFor: 'tor', venueSearching: false,
    mapFitRequest: null,
  }, over);
};
const NAMES = [COPPER, TORRE, CHIMNEY, HIGH_TOR, NOWHERE].map((v) => v.name);
// The rows in the order drawn: every button whose text leads with a name.
const rowNames = () => screen.getAllByRole('button').map((b) => b.textContent)
  .map((t) => NAMES.filter((n) => t.startsWith(n)).sort((a, b) => b.length - a.length)[0])
  .filter(Boolean);

describe('the four rows under the box', () => {
  test('are the four nearest of the answer, nearest first', () => {
    render(<ExploreScreen {...exploreProps({ userLocation: ME, venueResults: [HIGH_TOR, NOWHERE, CHIMNEY, TORRE, COPPER] })} />);
    expect(rowNames()).toEqual(['Copper Finch Cantina', 'Torre', 'Tor Chimney & Fireplace', 'High Tor State Park']);
    // See all still counts the whole answer.
    expect(screen.getByRole('button', { name: /See all 5/ })).toBeTruthy();
  });

  test('keep the search\'s order when the person\'s position is not known', () => {
    render(<ExploreScreen {...exploreProps({ venueResults: [HIGH_TOR, CHIMNEY, TORRE, COPPER] })} />);
    expect(rowNames()).toEqual(['High Tor State Park', 'Tor Chimney & Fireplace', 'Torre', 'Copper Finch Cantina']);
  });
});

describe('what moves the map', () => {
  test('a row tap commits the answer with that place to go to, and opens its sheet', () => {
    const commitVenueResults = jest.fn();
    const openVenueDetail = jest.fn();
    const pan = jest.fn();
    window.__flockPanToVenue = pan;
    render(<ExploreScreen {...exploreProps({ userLocation: ME, venueResults: [CHIMNEY, TORRE], commitVenueResults, openVenueDetail })} />);
    fireEvent.click(screen.getByRole('button', { name: /^Torre/ }));
    expect(commitVenueResults).toHaveBeenCalledTimes(1);
    expect(commitVenueResults.mock.calls[0][0]).toBe(TORRE);
    expect(openVenueDetail).toHaveBeenCalledWith('p_torre', expect.objectContaining({ place_id: 'p_torre', name: 'Torre' }));
    // The map goes there through the commit, once its pins are the answer's,
    // not before them (a pin the map does not hold yet cannot be found).
    expect(pan).not.toHaveBeenCalled();
    delete window.__flockPanToVenue;
  });

  test('See all commits the answer on screen and frames it', () => {
    const commitVenueResults = jest.fn();
    const requestMapFit = jest.fn();
    render(<ExploreScreen {...exploreProps({ venueResults: [TORRE], commitVenueResults, requestMapFit })} />);
    fireEvent.click(screen.getByRole('button', { name: /See 1 result/ }));
    expect(commitVenueResults).toHaveBeenCalledTimes(1);
    expect(commitVenueResults.mock.calls[0]).toEqual([]);
  });

  test('the count chip frames the pins already on the map, which are already an answer', () => {
    const commitVenueResults = jest.fn();
    const requestMapFit = jest.fn();
    render(<ExploreScreen {...exploreProps({ showSearchDropdown: false, budgetFilteredVenues: [TORRE], allVenues: [TORRE], commitVenueResults, requestMapFit })} />);
    fireEvent.click(screen.getByRole('button', { name: '1 result' }));
    expect(requestMapFit).toHaveBeenCalledTimes(1);
    expect(commitVenueResults).not.toHaveBeenCalled();
  });

  test('the map is handed the request as App makes it', () => {
    let seen = null;
    const Map = (p) => { seen = p.fitRequest; return null; };
    const req = { seq: 3, focus: null, center: null, radiusKm: 25 };
    render(<ExploreScreen {...exploreProps({ MapLibreMapView: Map, mapFitRequest: req })} />);
    expect(seen).toBe(req);
  });
});

// ---------------------------------------------------------------------------
// The real doVenueSearch and commitVenueSearch, compiled out of App.js and run
// against stand-ins for the state they write.
// ---------------------------------------------------------------------------
const SEARCH_SCOPE = [
  'venueQueryRef', 'venueSearchSeqRef', 'setVenueResults', 'setVenueSearching', 'enhanceQuery', 'userLocation',
  'searchCacheRef', 'requestCrowdScores', 'setShowSearchDropdown', 'searchVenues', 'setVenueLoadError', 'showToast',
  'userMessage', 'setVenueResultsFor', 'venueSearchAbortRef', 'pendingPinsCommitRef', 'commitSearchPins',
  'setAllVenues', 'venuesToMapPins', 'setActiveVenue',
];
const compile = (re, scope, deps) => {
  const m = APP.match(re);
  expect(m).not.toBeNull();
  // eslint-disable-next-line no-new-func
  return new Function(...scope, `return (${m[1]});`)(...scope.map((k) => deps[k]));
};

function searchHarness() {
  const state = { results: [], resultsFor: '', pins: null, commits: [], dropdown: false, searching: false, error: '' };
  const pending = new Map();
  const deps = {
    venueQueryRef: { current: '' },
    venueSearchSeqRef: { current: 0 },
    setVenueResults: (v) => { state.results = v; },
    setVenueSearching: (v) => { state.searching = v; },
    enhanceQuery: (q) => q,
    userLocation: null,
    searchCacheRef: { current: {} },
    requestCrowdScores: () => {},
    setShowSearchDropdown: (v) => { state.dropdown = v; },
    searchVenues: (q) => new Promise((resolve, reject) => { pending.set(q, { resolve, reject }); }),
    setVenueLoadError: (v) => { state.error = v; },
    showToast: () => {},
    userMessage: (err, fallback) => fallback,
    setVenueResultsFor: (v) => { state.resultsFor = v; },
    venueSearchAbortRef: { current: null },
    pendingPinsCommitRef: { current: null },
    commitSearchPins: (venues, focus) => { state.commits.push({ venues, focus: focus || null }); state.pins = venues.map((v) => v.place_id); },
    // Writing the pins any other way is what this file is against.
    setAllVenues: (v) => { state.pins = ['set directly', v]; },
    venuesToMapPins: (vs) => vs,
    setActiveVenue: () => {},
  };
  const doVenueSearch = compile(/const doVenueSearch = useCallback\((async \(q\) => \{[\s\S]*?\n {2}\}), \[[^\]]*\]\);/, SEARCH_SCOPE, deps);
  return { deps, state, pending, doVenueSearch };
}
let consoleError;
beforeEach(() => { consoleError = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { consoleError.mockRestore(); });

describe('a typed search fills the list and leaves the map alone', () => {
  test('its answer lands in the rows and the pins are not touched', async () => {
    const h = searchHarness();
    h.deps.venueQueryRef.current = 'tor';
    const p = h.doVenueSearch('tor');
    h.pending.get('tor').resolve({ venues: [HIGH_TOR, CHIMNEY] });
    await p;
    expect(h.state.results).toEqual([HIGH_TOR, CHIMNEY]);
    expect(h.state.resultsFor).toBe('tor');
    expect(h.state.pins).toBeNull();
    expect(h.state.commits).toEqual([]);
  });

  test('an answer from the cache leaves the pins alone too, and so does a failure or an empty answer', async () => {
    const h = searchHarness();
    h.deps.searchCacheRef.current['torr|'] = { data: [TORRE], timestamp: Date.now() };
    h.deps.venueQueryRef.current = 'torr';
    await h.doVenueSearch('torr');
    expect(h.state.results).toEqual([TORRE]);
    h.deps.venueQueryRef.current = 'zzq';
    const empty = h.doVenueSearch('zzq');
    h.pending.get('zzq').resolve({ venues: [] });
    await empty;
    h.deps.venueQueryRef.current = 'bars';
    const failing = h.doVenueSearch('bars');
    h.pending.get('bars').reject(new Error('down'));
    await failing;
    expect(h.state.error).toBe('Search is not responding. Try again in a moment.');
    expect(h.state.pins).toBeNull();
    expect(h.state.commits).toEqual([]);
  });
});

describe('Return commits', () => {
  test('a committed query\'s answer becomes the pins when it lands, once', async () => {
    const h = searchHarness();
    h.deps.venueQueryRef.current = 'torre';
    h.deps.pendingPinsCommitRef.current = 'torre';
    const p = h.doVenueSearch('torre');
    expect(h.state.commits).toEqual([]);
    h.pending.get('torre').resolve({ venues: [TORRE, COPPER] });
    await p;
    expect(h.state.commits).toEqual([{ venues: [TORRE, COPPER], focus: null }]);
  });

  test('from the cache at once', async () => {
    const h = searchHarness();
    h.deps.searchCacheRef.current['torre|'] = { data: [TORRE], timestamp: Date.now() };
    h.deps.venueQueryRef.current = 'torre';
    h.deps.pendingPinsCommitRef.current = 'torre';
    await h.doVenueSearch('torre');
    expect(h.state.commits).toEqual([{ venues: [TORRE], focus: null }]);
  });

  test('an answer for another query does not take the commit', async () => {
    const h = searchHarness();
    h.deps.venueQueryRef.current = 'tor';
    h.deps.pendingPinsCommitRef.current = 'torre';
    const p = h.doVenueSearch('tor');
    h.pending.get('tor').resolve({ venues: [CHIMNEY] });
    await p;
    expect(h.state.commits).toEqual([]);
  });

  test('a committed search that fails leaves no pins from somewhere else', async () => {
    const h = searchHarness();
    h.deps.venueQueryRef.current = 'torre';
    h.deps.pendingPinsCommitRef.current = 'torre';
    const p = h.doVenueSearch('torre');
    h.pending.get('torre').reject(new Error('down'));
    await p;
    expect(h.state.commits).toEqual([{ venues: [], focus: null }]);
  });

  const COMMIT_SCOPE = ['venueQueryRef', 'venueResultsFor', 'venueResults', 'pendingPinsCommitRef', 'commitSearchPins',
    'cancelPendingVenueSearch', 'runVenueSearchNow'];
  const commitHarness = (over) => {
    const calls = [];
    const deps = {
      venueQueryRef: { current: 'torre ' }, venueResultsFor: '', venueResults: [], pendingPinsCommitRef: { current: null },
      commitSearchPins: (v) => calls.push(['commit', v]), cancelPendingVenueSearch: () => calls.push(['cancel']),
      runVenueSearchNow: () => calls.push(['search']), ...over,
    };
    const fn = compile(/const commitVenueSearch = useCallback\((\(\) => \{[\s\S]*?\n {2}\}), \[[^\]]*\]\);/, COMMIT_SCOPE, deps);
    return { deps, calls, fn };
  };

  test('rows that already answer the box become the pins with no search sent', () => {
    const h = commitHarness({ venueResultsFor: 'torre', venueResults: [TORRE] });
    h.fn();
    expect(h.calls).toEqual([['cancel'], ['commit', [TORRE]]]);
    expect(h.deps.pendingPinsCommitRef.current).toBeNull();
  });

  test('otherwise the box\'s search goes now and its answer is awaited', () => {
    const h = commitHarness({ venueResultsFor: 'tor', venueResults: [CHIMNEY] });
    h.fn();
    expect(h.calls).toEqual([['search']]);
    expect(h.deps.pendingPinsCommitRef.current).toBe('torre');
  });

  test('typing again gives up a commit still waiting', () => {
    const typed = APP.slice(APP.indexOf('const handleVenueQueryChange = useCallback('), APP.indexOf('}, [doVenueSearch, showSearchResults]);'));
    expect(typed).toMatch(/pendingPinsCommitRef\.current = null;/);
  });
});

describe('the wiring', () => {
  test('pins follow a search only through commitSearchPins, which frames them in the same render', () => {
    const search = APP.slice(APP.indexOf('const doVenueSearch = useCallback('), APP.indexOf('// Open the full venue details modal'));
    expect(search).not.toMatch(/setAllVenues\(/);
    const commit = APP.slice(APP.indexOf('const commitSearchPins = useCallback('), APP.indexOf('const doVenueSearch = useCallback('));
    expect(commit).toMatch(/setAllVenues\(venues\.length > 0 \? venuesToMapPins\(venues\) : \[\]\);/);
    expect(commit).toMatch(/requestMapFit\(focus\);/);
  });

  test('a request with a place to go to sends the map there instead of framing the set', () => {
    const fit = MAP_SRC.slice(MAP_SRC.indexOf('const lastFitSeqRef = useRef(null);'), MAP_SRC.indexOf('}, [fitRequest, venues, mapReady]);'));
    expect(fit).toMatch(/if \(fitRequest\.focus\) return;/);
    expect(fit.indexOf('if (fitRequest.focus) return;')).toBeLessThan(fit.indexOf('framePoints('));
    const focusAt = MAP_SRC.indexOf('const lastFocusSeqRef = useRef(null);');
    const focus = MAP_SRC.slice(focusAt, MAP_SRC.indexOf('}, [fitRequest, venues, mapReady]);', focusAt));
    expect(focus).toMatch(/window\.__flockPanToVenue\(fitRequest\.focus\);/);
    // After the effect that builds __flockPanToVenue over the new pins: on the
    // render that brings them, every cleanup runs first and deletes the old one.
    expect(focusAt).toBeGreaterThan(MAP_SRC.indexOf('window.__flockPanToVenue = (target) => {'));
    expect(focusAt).toBeGreaterThan(MAP_SRC.indexOf('delete window.__flockPanToVenue;'));
  });

  test('the rows under the box are drawn nearest first', () => {
    expect(EXPLORE_SRC).toMatch(/nearestFirst\(venueResults\.filter\([\s\S]*?\), userLocation\)\.slice\(0, 4\)/);
  });
});
