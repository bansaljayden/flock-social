/**
 * THE DISCOVER SEARCH KEEPS ITS ROWS AND STOPS WAITING ON OLD ANSWERS
 * (2026-11-06).
 *
 * A tester typed "tor", then "torre". The "tor" rows stayed for half a second,
 * a three-row skeleton replaced them for three seconds, and Torre appeared
 * about four seconds after the last key. Three changes:
 *
 *   - Rows for an older query stay on screen, dimmed under a 2px progress
 *     line, until the new answer replaces them. The skeleton is only for a
 *     list with no rows yet. No blink.
 *   - The wait before a search follows the typing (lib/searchCadence.js):
 *     three times the person's own gap between keys, 300 ms at the quickest,
 *     the old 800 at the slowest, so the paid Places searches a slow typist's
 *     pauses would fire are not sent. The measurement is pinned below.
 *   - A search a newer one replaced is aborted (AbortController per search),
 *     and a row tapped while a search is still waiting cancels it, so it can
 *     no longer reopen the list under the venue sheet.
 *
 * FRONTEND test (jest via react-scripts).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ExploreScreen from '../screens/ExploreScreen';
import { searchWaitMs, nextKeyGaps, SEARCH_WAIT_MIN_MS, SEARCH_WAIT_MAX_MS } from '../lib/searchCadence';

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const EXPLORE_SRC = read('screens', 'ExploreScreen.js');
const APP = read('App.js');
const API = read('services', 'api.js');

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
    renderConsumerVenueCard: none, REVIEW_HIDE_LOCATION_BANNER: false, fmtMoney: String,
    ListSkeleton: ({ label }) => <div data-testid="list-skeleton">{label}</div>,
    activeVenue: null, allVenues: [], budgetFilteredVenues: [], budgetStatus: null, category: 'All', categoryExpanded: false,
    colors: {}, connectResults: [], connectSearch: '', connectSearchError: '', connectSearching: false, discoverNavOpen: false,
    eventsSearchQuery: '', eventsSearchTimerRef: { current: null }, featuredEvents: null, featuredEventsError: '', featuredEventsLoading: false,
    flockMemberLocations: {}, friendStatuses: {}, isDark: false, isExploreVisible: true, locationEnabled: true, locationError: '',
    locationLoading: false, mapVenuesLoaded: true, pickingVenueForCreate: false, pickingVenueForDm: false, pickingVenueForFlockId: null,
    sharingLocationForFlock: null, showConnectPanel: false, showEventsView: false, showSearchDropdown: true, tableParty: 2,
    userLocation: null, venueLoadError: '', venueQuery: '', venueResults: [], venueResultsFor: '', venueSearching: false,
  }, over);
};
const COPPER = { place_id: 'p_copper', name: 'Copper Finch Cantina', formatted_address: '214 Main St', rating: 4.3, user_ratings_total: 12 };
const rowsBlock = () => screen.getByRole('button', { name: /Copper Finch Cantina/ }).parentElement;

describe('rows for an older query stay while the new one is asked', () => {
  test('a search out over rows: the rows stay, dimmed, under a progress line, and no skeleton', () => {
    render(<ExploreScreen {...exploreProps({ venueQuery: 'sparrow', venueResults: [COPPER], venueResultsFor: 'copper', venueSearching: true })} />);
    expect(screen.getByRole('button', { name: /Copper Finch Cantina/ })).toBeTruthy();
    expect(rowsBlock().style.opacity).toBe('0.5');
    expect(rowsBlock().getAttribute('aria-busy')).toBe('true');
    expect(document.querySelector('[data-search-progress]')).not.toBeNull();
    expect(screen.queryByTestId('list-skeleton')).toBeNull();
  });

  test('typed past the rows, before the search goes: dimmed already, from the first key', () => {
    render(<ExploreScreen {...exploreProps({ venueQuery: 'copper f', venueResults: [COPPER], venueResultsFor: 'copper', venueSearching: false })} />);
    expect(rowsBlock().style.opacity).toBe('0.5');
    expect(document.querySelector('[data-search-progress]')).not.toBeNull();
  });

  test('rows that answer the box are drawn at full strength with no line', () => {
    render(<ExploreScreen {...exploreProps({ venueQuery: 'copper', venueResults: [COPPER], venueResultsFor: 'copper' })} />);
    expect(rowsBlock().style.opacity).toBe('1');
    expect(document.querySelector('[data-search-progress]')).toBeNull();
  });

  test('a first search with no rows yet still gets the skeleton', () => {
    render(<ExploreScreen {...exploreProps({ venueQuery: 'copper', venueResults: [], venueSearching: true })} />);
    expect(screen.getByTestId('list-skeleton').textContent).toBe('Searching venues');
  });

  test('a row tapped while a search is waiting cancels that search', () => {
    const cancelPendingVenueSearch = jest.fn();
    const openVenueDetail = jest.fn();
    render(<ExploreScreen {...exploreProps({ venueQuery: 'copper', venueResults: [COPPER], venueResultsFor: 'copper', cancelPendingVenueSearch, openVenueDetail })} />);
    fireEvent.click(screen.getByRole('button', { name: /Copper Finch Cantina/ }));
    expect(cancelPendingVenueSearch).toHaveBeenCalledTimes(1);
    expect(openVenueDetail).toHaveBeenCalledWith('p_copper', expect.objectContaining({ name: 'Copper Finch Cantina' }));
  });
});

describe('the wait follows the typing', () => {
  test('three times the median gap, between 300 and 800 ms', () => {
    expect(SEARCH_WAIT_MIN_MS).toBe(300);
    expect(SEARCH_WAIT_MAX_MS).toBe(800);
    expect(searchWaitMs([])).toBe(300);
    expect(searchWaitMs([90, 110, 100])).toBe(300);
    expect(searchWaitMs([150, 160, 170])).toBe(480);
    expect(searchWaitMs([200, 400, 220])).toBe(660);
    expect(searchWaitMs([420, 380, 400])).toBe(800);
    // A stop to look at the screen is not typing rhythm.
    expect(searchWaitMs([100, 2400, 100])).toBe(300);
  });

  test('only the last six gaps under 1.5 s are kept', () => {
    let gaps = [];
    let at = null;
    [0, 100, 200, 300, 400, 500, 600, 700, 3000].forEach((t) => { gaps = nextKeyGaps(gaps, at, t); at = t; });
    expect(gaps).toEqual([100, 100, 100, 100, 100, 100]);
  });

  // THE MEASUREMENT. Searches sent for typed sequences, the shipped flat
  // 800 ms against the rhythm wait. A search is sent when the next key comes
  // later than the wait, and never twice for one query (the client cache).
  const searchesFor = (keys, waitFor) => {
    let gaps = [];
    let at = null;
    const sent = new Set();
    keys.forEach(([t, q], i) => {
      gaps = nextKeyGaps(gaps, at, t);
      at = t;
      const next = i + 1 < keys.length ? keys[i + 1][0] : Infinity;
      if (q.trim().length >= 2 && next - t > waitFor(gaps) && !sent.has(q)) sent.add(q);
    });
    return [...sent];
  };
  const typed = (word, gapMs, start = 0) => [...word].map((_, i) => [start + i * gapMs, word.slice(0, i + 1)]);
  const OLD = () => 800;

  test('steady typing at any speed sends one search per word, as before', () => {
    for (const gap of [90, 150, 260, 420]) {
      expect(searchesFor(typed('copper finch', gap), searchWaitMs)).toEqual(['copper finch']);
      expect(searchesFor(typed('copper finch', gap), OLD)).toEqual(['copper finch']);
    }
  });

  test('the recorded "tor" / "torre" sequence sends the same two searches', () => {
    // t at 24.0 s, "tor" by 24.75 s, a two-second look at the list, then
    // "re" by 27.0 s (FULL-WATCH S2, read off the recording).
    const keys = [[24000, 't'], [24375, 'to'], [24750, 'tor'], [26750, 'torr'], [27000, 'torre']];
    expect(searchesFor(keys, OLD)).toEqual(['tor', 'torre']);
    expect(searchesFor(keys, searchWaitMs)).toEqual(['tor', 'torre']);
  });

  test('the wait after the last key: 300 ms for a quick typist, 800 for a slow one', () => {
    const finalWait = (gap) => {
      let gaps = [];
      let at = null;
      typed('copper finch', gap).forEach(([t]) => { gaps = nextKeyGaps(gaps, at, t); at = t; });
      return searchWaitMs(gaps);
    };
    expect(finalWait(90)).toBe(300);
    expect(finalWait(150)).toBe(450);
    expect(finalWait(260)).toBe(780);
    expect(finalWait(420)).toBe(800);
  });

  test('the cost it does have: a quick typist pausing 450-800 ms mid-word sends one more search than before', () => {
    const keys = [...typed('copper', 150), ...typed('copper finch', 150, 450).slice(6)]; // a 600 ms pause after "copper"
    expect(searchesFor(keys, OLD)).toEqual(['copper finch']);
    expect(searchesFor(keys, searchWaitMs)).toEqual(['copper', 'copper finch']);
  });
});

describe('a replaced search is aborted', () => {
  test('doVenueSearch aborts the request the last search left out, and hands its own signal to searchVenues', () => {
    const fn = APP.slice(APP.indexOf('const doVenueSearch = useCallback('), APP.indexOf('const venueDetailSeqRef = useRef(0);'));
    expect(fn).toMatch(/if \(venueSearchAbortRef\.current\) \{ venueSearchAbortRef\.current\.abort\(\); venueSearchAbortRef\.current = null; \}/);
    expect(fn).toMatch(/searchVenues\(enhanced, loc, controller \? \{ signal: controller\.signal \} : undefined\)/);
    // An aborted search says nothing: it is checked before the error is logged or shown.
    expect(fn.indexOf("if (!current()) return;\n      console.error('Venue search error:'")).toBeGreaterThan(-1);
  });

  test('searchVenues forwards the signal to the request', () => {
    const fn = API.slice(API.indexOf('export async function searchVenues('), API.indexOf('// A place tapped on the Discover map'));
    expect(fn).toMatch(/searchVenues\(query, location, \{ signal \} = \{\}\)/);
    expect(fn).toMatch(/signal \? \{ retry: false, signal \} : \{ retry: false \}/);
  });

  test('the debounce reads the rhythm, not a flat 800', () => {
    const fn = APP.slice(APP.indexOf('const handleVenueQueryChange = useCallback('), APP.indexOf('const cancelPendingVenueSearch'));
    expect(fn).toMatch(/setTimeout\(\(\) => doVenueSearch\(val\), searchWaitMs\(searchKeyGapsRef\.current\)\)/);
    expect(fn).not.toMatch(/doVenueSearch\(val\), 800\)/);
  });
});
