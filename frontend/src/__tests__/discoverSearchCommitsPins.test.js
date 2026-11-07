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
 * After review (2026-11-06):
 *
 *   - while the full results list is open, every answer for what the box
 *     says becomes the pins: the list draws the pins under a search box of
 *     its own, and a search typed there used to leave the old pins and their
 *     count under the new words;
 *   - the count chip follows the box: with words in it the pins do not
 *     answer, it counts and opens the box's answer, and with no answer in
 *     hand it is not drawn;
 *   - Return after a search that failed sends it again (the one retry);
 *   - a row named exactly what was searched leads the four rows.
 *
 * FRONTEND test (jest via react-scripts).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ExploreScreen from '../screens/ExploreScreen';
import { nearestFirst, nameKey } from '../lib/distance';

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

describe('the place the person named leads', () => {
  // Four places nearer than Torre that Google matched on "torre" too.
  const near = (id, name, dLat) => ({ place_id: id, name, location: at(ME.lat + dLat, ME.lng) });
  const NEARER = [near('p_n1', 'Torre Pizza Bar', 0.01), near('p_n2', 'Torrefazione', 0.02), near('p_n3', 'Torres Liquors', 0.03), near('p_n4', 'Copper Finch Cantina', 0.001)];

  test('a row whose name is the query comes first, the rest nearest first', () => {
    expect(nearestFirst([...NEARER, TORRE], ME, 'torre').map((v) => v.place_id))
      .toEqual(['p_torre', 'p_n4', 'p_n1', 'p_n2', 'p_n3']);
  });
  test('distance alone would have pushed it off the four rows', () => {
    expect(nearestFirst([...NEARER, TORRE], ME).slice(0, 4).map((v) => v.place_id)).not.toContain('p_torre');
  });
  test('word for word: case, accents, apostrophes and spacing aside', () => {
    expect(nameKey("  Joe's  Café ")).toBe('joes cafe');
    expect(nameKey('JOES-CAFE')).toBe('joes cafe');
    const joes = { place_id: 'p_joes', name: "Joe's Café", location: at(41.5, -75) };
    expect(nearestFirst([COPPER, joes], ME, 'joes cafe')[0].place_id).toBe('p_joes');
  });
  test('a prefix is not a name: "tor" stays nearest first', () => {
    expect(nearestFirst([HIGH_TOR, CHIMNEY, TORRE, COPPER], ME, 'tor').map((v) => v.place_id))
      .toEqual(['p_copper', 'p_torre', 'p_chimney', 'p_hightor']);
  });
  test('with no position for the person, the named place first and the rest as the search gave them', () => {
    expect(nearestFirst([HIGH_TOR, CHIMNEY, TORRE, COPPER], null, 'Torre').map((v) => v.place_id))
      .toEqual(['p_torre', 'p_hightor', 'p_chimney', 'p_copper']);
  });
  test('two places of that name: the nearer first', () => {
    const farTorre = { ...TORRE, place_id: 'p_torre_far', location: at(41.5, -74) };
    expect(nearestFirst([farTorre, COPPER, TORRE], ME, 'torre').map((v) => v.place_id))
      .toEqual(['p_torre', 'p_torre_far', 'p_copper']);
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
    mapFitRequest: null, pinsFor: 'tor',
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

  test('lead with the place named in full, read against the words the rows answer', () => {
    const torreBar = { place_id: 'p_tb', name: 'Tor Chimney & Fireplace', location: at(ME.lat + 0.01, ME.lng) };
    render(<ExploreScreen {...exploreProps({ userLocation: ME, venueQuery: 'torre', venueResultsFor: 'torre', pinsFor: 'torre', venueResults: [HIGH_TOR, torreBar, COPPER, TORRE] })} />);
    expect(rowNames()[0]).toBe('Torre');
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

  test('with words in the box the pins do not answer, the chip counts the box\'s answer and its tap makes it the pins', () => {
    const commitVenueResults = jest.fn();
    const requestMapFit = jest.fn();
    const setShowSearchResults = jest.fn();
    const nearby = [HIGH_TOR, CHIMNEY, NOWHERE];
    render(<ExploreScreen {...exploreProps({
      showSearchDropdown: false, venueQuery: 'torre', venueResultsFor: 'torre', pinsFor: '',
      // A repeat is one pin (venuesToMapPins), so it is one in the count.
      venueResults: [TORRE, COPPER, TORRE], budgetFilteredVenues: nearby, allVenues: nearby,
      commitVenueResults, requestMapFit, setShowSearchResults,
    })} />);
    expect(screen.queryByRole('button', { name: 'All 3 results' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All 2 results' }));
    expect(setShowSearchResults).toHaveBeenCalledWith(true);
    expect(commitVenueResults).toHaveBeenCalledTimes(1);
    expect(commitVenueResults.mock.calls[0]).toEqual([]);
    expect(requestMapFit).not.toHaveBeenCalled();
  });

  test('the box\'s answer is counted under the group\'s budget, as its pins would be', () => {
    const pricey = { ...COPPER, place_id: 'p_pricey', name: 'Pricey', price_level: 4 };
    render(<ExploreScreen {...exploreProps({
      showSearchDropdown: false, venueQuery: 'torre', venueResultsFor: 'torre', pinsFor: '',
      venueResults: [TORRE, pricey], budgetFilteredVenues: [HIGH_TOR], allVenues: [HIGH_TOR],
      budgetStatus: { isReady: true, ceiling: 30 }, getMaxPriceLevel: () => 2,
    })} />);
    expect(screen.getByRole('button', { name: '1 result' })).toBeTruthy();
  });

  test('with no answer in hand for the box there is no count to promise, and no chip', () => {
    const chip = () => screen.queryByRole('button', { name: /^(1 result|All \d+ results)$/ });
    const nearby = [HIGH_TOR, CHIMNEY];
    const base = { showSearchDropdown: false, venueQuery: 'torre', pinsFor: '', budgetFilteredVenues: nearby, allVenues: nearby };
    // Still to go, or out: the rows answer an older query.
    let r = render(<ExploreScreen {...exploreProps({ ...base, venueResultsFor: 'tor', venueResults: [CHIMNEY] })} />);
    expect(chip()).toBeNull();
    r.unmount();
    r = render(<ExploreScreen {...exploreProps({ ...base, venueResultsFor: 'torre', venueResults: [TORRE], venueSearching: true })} />);
    expect(chip()).toBeNull();
    r.unmount();
    // Failed.
    r = render(<ExploreScreen {...exploreProps({ ...base, venueResultsFor: 'torre', venueResults: [], venueLoadError: 'Search is not responding. Try again in a moment.' })} />);
    expect(chip()).toBeNull();
    r.unmount();
    // The box cleared to one letter: the pins are all there is to count.
    render(<ExploreScreen {...exploreProps({ ...base, venueQuery: 't', venueResultsFor: '', venueResults: [] })} />);
    expect(chip().textContent).toBe('All 2 results');
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
  'setAllVenues', 'venuesToMapPins', 'setActiveVenue', 'searchResultsOpenRef',
];
const compile = (re, scope, deps) => {
  const m = APP.match(re);
  expect(m).not.toBeNull();
  // eslint-disable-next-line no-new-func
  return new Function(...scope, `return (${m[1]});`)(...scope.map((k) => deps[k]));
};

function searchHarness() {
  const state = { results: [], resultsFor: '', pins: null, pinsFor: null, commits: [], dropdown: false, searching: false, error: '' };
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
    commitSearchPins: (venues, focus, forQuery) => { state.commits.push({ venues, focus: focus || null }); state.pins = venues.map((v) => v.place_id); state.pinsFor = forQuery; },
    // Writing the pins any other way is what this file is against.
    setAllVenues: (v) => { state.pins = ['set directly', v]; },
    venuesToMapPins: (vs) => vs,
    setActiveVenue: () => {},
    searchResultsOpenRef: { current: false },
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
    // The pins say which words they answer (the count chip reads it).
    expect(h.state.pinsFor).toBe('torre');
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
    'cancelPendingVenueSearch', 'runVenueSearchNow', 'venueLoadError'];
  const commitHarness = (over) => {
    const calls = [];
    const deps = {
      venueQueryRef: { current: 'torre ' }, venueResultsFor: '', venueResults: [], pendingPinsCommitRef: { current: null },
      commitSearchPins: (v, focus, forQuery) => calls.push(['commit', v, forQuery]), cancelPendingVenueSearch: () => calls.push(['cancel']),
      runVenueSearchNow: () => calls.push(['search']), venueLoadError: '', ...over,
    };
    const fn = compile(/const commitVenueSearch = useCallback\((\(\) => \{[\s\S]*?\n {2}\}), \[[^\]]*\]\);/, COMMIT_SCOPE, deps);
    return { deps, calls, fn };
  };

  test('rows that already answer the box become the pins with no search sent', () => {
    const h = commitHarness({ venueResultsFor: 'torre', venueResults: [TORRE] });
    h.fn();
    expect(h.calls).toEqual([['cancel'], ['commit', [TORRE], 'torre']]);
    expect(h.deps.pendingPinsCommitRef.current).toBeNull();
  });

  test('a search for these words that failed is sent again: Return is the retry', () => {
    const h = commitHarness({ venueResultsFor: 'torre', venueResults: [], venueLoadError: 'Search is not responding. Try again in a moment.' });
    h.fn();
    expect(h.calls).toEqual([['search']]);
    expect(h.deps.pendingPinsCommitRef.current).toBe('torre');
  });

  test('the retry\'s answer becomes the pins when it lands', async () => {
    const h = searchHarness();
    h.deps.venueQueryRef.current = 'torre';
    const first = h.doVenueSearch('torre');
    h.pending.get('torre').reject(new Error('down'));
    await first;
    expect(h.state.commits).toEqual([]);
    h.deps.pendingPinsCommitRef.current = 'torre';
    const again = h.doVenueSearch('torre');
    h.pending.get('torre').resolve({ venues: [TORRE] });
    await again;
    expect(h.state.error).toBe('');
    expect(h.state.commits).toEqual([{ venues: [TORRE], focus: null }]);
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

describe('while the full results list is open, the list follows the box', () => {
  test('a query typed in the list: its answer becomes the pins it draws', async () => {
    const h = searchHarness();
    h.deps.searchResultsOpenRef.current = true;
    h.deps.venueQueryRef.current = 'torre';
    const p = h.doVenueSearch('torre');
    h.pending.get('torre').resolve({ venues: [TORRE, COPPER] });
    await p;
    expect(h.state.commits).toEqual([{ venues: [TORRE, COPPER], focus: null }]);
    expect(h.state.pinsFor).toBe('torre');
  });

  test('from the cache too, and a search that failed leaves the list empty under its sentence', async () => {
    const h = searchHarness();
    h.deps.searchResultsOpenRef.current = true;
    h.deps.searchCacheRef.current['torr|'] = { data: [TORRE], timestamp: Date.now() };
    h.deps.venueQueryRef.current = 'torr';
    await h.doVenueSearch('torr');
    h.deps.venueQueryRef.current = 'bars';
    const failing = h.doVenueSearch('bars');
    h.pending.get('bars').reject(new Error('down'));
    await failing;
    expect(h.state.commits).toEqual([{ venues: [TORRE], focus: null }, { venues: [], focus: null }]);
    expect(h.state.error).toBe('Search is not responding. Try again in a moment.');
  });

  test('read when the answer lands: the list opened over a search still out (See all over older rows) takes it', async () => {
    const h = searchHarness();
    h.deps.venueQueryRef.current = 'torre';
    const p = h.doVenueSearch('torre');
    h.deps.searchResultsOpenRef.current = true;
    h.pending.get('torre').resolve({ venues: [TORRE] });
    await p;
    expect(h.state.commits).toEqual([{ venues: [TORRE], focus: null }]);
  });

  test('and the list closed before it landed leaves the map alone, as any typed search does', async () => {
    const h = searchHarness();
    h.deps.searchResultsOpenRef.current = true;
    h.deps.venueQueryRef.current = 'torre';
    const p = h.doVenueSearch('torre');
    h.deps.searchResultsOpenRef.current = false;
    h.pending.get('torre').resolve({ venues: [TORRE] });
    await p;
    expect(h.state.commits).toEqual([]);
    expect(h.state.pins).toBeNull();
  });

  test('an answer for words the box no longer says still writes nothing', async () => {
    const h = searchHarness();
    h.deps.searchResultsOpenRef.current = true;
    h.deps.venueQueryRef.current = 'tor';
    const p = h.doVenueSearch('tor');
    h.deps.venueQueryRef.current = 'torre';
    h.pending.get('tor').resolve({ venues: [CHIMNEY] });
    await p;
    expect(h.state.commits).toEqual([]);
  });

  test('the ref is the list\'s own state, and the overlay types through handleVenueQueryChange', () => {
    expect(APP).toMatch(/searchResultsOpenRef\.current = showSearchResults;/);
    const overlay = read('components', 'SearchResultsOverlay.js');
    expect(overlay).toMatch(/onCommit=\{handleVenueQueryChange\}/);
    expect(overlay).toMatch(/budgetFilteredVenues/);
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

  test('the rows under the box are drawn nearest first, the place named in full leading', () => {
    expect(EXPLORE_SRC).toMatch(/nearestFirst\(venueResults\.filter\(withinBudget\), userLocation, venueResultsFor\)\.slice\(0, 4\)/);
  });

  test('every way the pins change says which words they answer', () => {
    const commit = APP.slice(APP.indexOf('const commitSearchPins = useCallback('), APP.indexOf('const doVenueSearch = useCallback('));
    expect(commit).toMatch(/setPinsFor\(forQuery\);/);
    const search = APP.slice(APP.indexOf('const doVenueSearch = useCallback('), APP.indexOf('// Open the full venue details modal'));
    expect(search.match(/commitSearchPins\([^)]*, null, q\.trim\(\)\)/g)).toHaveLength(3);
    const results = APP.slice(APP.indexOf('const commitVenueResults = useCallback('), APP.indexOf('// Invite user search with debounce'));
    expect(results).toMatch(/commitSearchPins\(venueResults, focus, venueResultsFor\);/);
    // The places around a point answer no words.
    const near = APP.slice(APP.indexOf('const browseVenuesAt = useCallback('), APP.indexOf('const loadVenuesAtLocationRef = useRef('));
    expect((near.match(/setAllVenues\(/g) || []).length).toBe((near.match(/setPinsFor\(''\);/g) || []).length);
    expect(APP).toMatch(/\n {4}pinsFor,\n {2}\};/);
  });
});
