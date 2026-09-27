/**
 * DISCOVER SEARCH: A SEARCH THAT IS NO LONGER WANTED WRITES NOTHING.
 *
 * Typing "tacos" and tapping the clear X inside the 800 ms debounce left the
 * timer armed, because the X sets the query straight to '' without passing
 * through handleVenueQueryChange. The timer then ran the search anyway: the
 * dropdown reopened with taco rows under an empty box, and the map swapped the
 * nearby pins the clear had just asked for for taco pins. A search already in
 * flight when the X was tapped did the same when it landed, and two debounced
 * searches could land out of order (a cache hit answers at once while an older
 * uncached one is still out) with the older one winning.
 *
 * These tests compile the REAL doVenueSearch out of App.js and run it against
 * stand-ins for its state setters, so they fail if the guard in the shipped
 * source regresses, not only if a pinned string moves.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test venueSearchStaleAnswers --watchAll=false
 */
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

// Everything doVenueSearch reads from the component's scope.
const SCOPE = [
  'venueQueryRef', 'venueSearchSeqRef', 'setVenueResults', 'setVenueSearching',
  'enhanceQuery', 'userLocation', 'searchCacheRef', 'setAllVenues',
  'venuesToMapPins', 'setActiveVenue', 'requestCrowdScores',
  'setShowSearchDropdown', 'searchVenues', 'setVenueLoadError', 'showToast',
];

function compileSearch(deps) {
  const m = APP.match(/const doVenueSearch = useCallback\((async \(q\) => \{[\s\S]*?\n {2}\}), \[[^\]]*\]\);/);
  expect(m).not.toBeNull();
  // eslint-disable-next-line no-new-func
  return new Function(...SCOPE, `return (${m[1]});`)(...SCOPE.map((k) => deps[k]));
}

const TACO = { place_id: 'taco-truck', name: 'Taco Truck' };
const TACOS = { place_id: 'taco-bar', name: 'Taco Bar' };
const PIZZA = { place_id: 'pizza', name: 'Pizza Place' };

function harness() {
  const box = { current: '' };
  const state = { results: [], pins: null, dropdown: false, searching: false, error: '' };
  const pending = new Map();
  const cache = { current: {} };
  const deps = {
    venueQueryRef: box,
    venueSearchSeqRef: { current: 0 },
    setVenueResults: (v) => { state.results = v; },
    setVenueSearching: (v) => { state.searching = v; },
    enhanceQuery: (q) => q,
    userLocation: null,
    searchCacheRef: cache,
    setAllVenues: (v) => { state.pins = v; },
    venuesToMapPins: (vs) => vs.map((v) => v.place_id),
    setActiveVenue: () => {},
    requestCrowdScores: () => {},
    setShowSearchDropdown: (v) => { state.dropdown = v; },
    searchVenues: (q) => new Promise((resolve, reject) => { pending.set(q, { resolve, reject }); }),
    setVenueLoadError: (v) => { state.error = v; },
    showToast: () => {},
  };
  return { box, state, pending, cache, doVenueSearch: compileSearch(deps) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let consoleError;
beforeEach(() => { consoleError = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { consoleError.mockRestore(); });

test('the box mirror the guard reads is kept current', () => {
  expect(APP).toContain('useEffect(() => { venueQueryRef.current = venueQuery; }, [venueQuery]);');
});

test('a debounced search that fires after the box was cleared does nothing', async () => {
  const h = harness();
  // "tacos" was typed, then the X set the box to '' with the timer still armed.
  h.box.current = '';
  h.doVenueSearch('tacos');
  await flush();
  expect(h.pending.size).toBe(0);
  expect(h.state.dropdown).toBe(false);
  expect(h.state.searching).toBe(false);
  expect(h.state.pins).toBeNull();
  expect(h.state.results).toEqual([]);
});

test('a search in flight when the box is cleared does not reopen the dropdown or repaint the map', async () => {
  const h = harness();
  h.box.current = 'tacos';
  const p = h.doVenueSearch('tacos');
  expect(h.state.searching).toBe(true);

  // The X: the box empties and the dropdown closes, then the answer lands.
  h.box.current = '';
  h.state.dropdown = false;
  h.pending.get('tacos').resolve({ venues: [TACO] });
  await p;

  expect(h.state.results).toEqual([]);
  expect(h.state.pins).toBeNull();
  expect(h.state.dropdown).toBe(false);
  expect(h.state.searching).toBe(false);
  // The answer is still right for its query, so it is kept for next time.
  expect(h.cache.current['tacos|'].data).toEqual([TACO]);
});

test('a search that fails after the box was cleared says nothing about it', async () => {
  const h = harness();
  h.box.current = 'tacos';
  const p = h.doVenueSearch('tacos');
  h.box.current = '';
  h.pending.get('tacos').reject(new Error('Search is not responding.'));
  await p;
  expect(h.state.error).toBe('');
  expect(h.state.pins).toBeNull();
  expect(h.state.searching).toBe(false);
});

test('an older search that lands after a newer one does not overwrite it', async () => {
  const h = harness();
  h.box.current = 'taco';
  const older = h.doVenueSearch('taco');

  // "tacos" is answered from the cache at once.
  h.cache.current['tacos|'] = { data: [TACOS], timestamp: Date.now() };
  h.box.current = 'tacos';
  await h.doVenueSearch('tacos');
  expect(h.state.results).toEqual([TACOS]);
  expect(h.state.searching).toBe(false);

  h.pending.get('taco').resolve({ venues: [TACO] });
  await older;
  expect(h.state.results).toEqual([TACOS]);
  expect(h.state.pins).toEqual(['taco-bar']);
  expect(h.state.searching).toBe(false);
});

test('an older search still out does not switch the spinner off under the newer one', async () => {
  const h = harness();
  h.box.current = 'taco';
  const older = h.doVenueSearch('taco');
  h.box.current = 'tacos';
  const newer = h.doVenueSearch('tacos');
  h.pending.get('taco').resolve({ venues: [TACO] });
  await older;
  expect(h.state.searching).toBe(true);
  h.pending.get('tacos').resolve({ venues: [TACOS] });
  await newer;
  expect(h.state.searching).toBe(false);
  expect(h.state.results).toEqual([TACOS]);
});

test('the search for what the box says still answers as before', async () => {
  const h = harness();
  h.box.current = 'pizza';
  const p = h.doVenueSearch('pizza');
  expect(h.state.dropdown).toBe(true);
  h.pending.get('pizza').resolve({ venues: [PIZZA] });
  await p;
  expect(h.state.results).toEqual([PIZZA]);
  expect(h.state.pins).toEqual(['pizza']);
  expect(h.state.searching).toBe(false);

  // Backspacing to an empty box still empties the results.
  h.state.results = [PIZZA];
  h.box.current = '';
  await h.doVenueSearch('');
  expect(h.state.results).toEqual([]);

  // And a failure of the current search is still said.
  h.box.current = 'bars';
  const failing = h.doVenueSearch('bars');
  h.pending.get('bars').reject(new Error('Search is not responding.'));
  await failing;
  expect(h.state.error).toBe('Search is not responding.');
  expect(h.state.searching).toBe(false);
});
