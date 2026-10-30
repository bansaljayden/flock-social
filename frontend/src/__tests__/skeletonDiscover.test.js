/**
 * DISCOVER'S WAITS: THE FIRST-RUN ROW, LIVE EVENTS, AN EVENT'S DETAILS, FIND
 * YOUR PEOPLE AND THE MAP'S OWN GROUND.
 *
 * A first run used to stack a ring and "Finding venues near you..." over
 * "Finding where you are...", both for the device's fix, and then say nothing
 * at all while the venue search ran. Live Events and Find Your People waited
 * behind rings, an event's details behind a ring under its header, and the map
 * chunk behind a fixed navy box whatever the theme. Each is rendered here in
 * its loading state.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false skeletonDiscover
 */
import React from 'react';
import fs from 'fs';
import path from 'path';
import { render, screen } from '@testing-library/react';
import ExploreScreen from '../screens/ExploreScreen';
import EventDetailOverlay from '../components/EventDetailOverlay';

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');
const EXPLORE_SRC = read('screens', 'ExploreScreen.js');

function expectNoSpinnerOrLoadingText(container) {
  // The recenter control turns while it asks the device for a fix: that is
  // the button showing its own action running, and it stays.
  const spinning = Array.from(container.querySelectorAll('*'))
    .filter((el) => /spin\b/.test(el.style.animation || ''))
    .filter((el) => el.getAttribute('aria-label') !== 'Recenter the map on me');
  expect(spinning).toEqual([]);
  expect(container.textContent).not.toMatch(/Loading\.\.\.|Loading…|Searching\.\.\.|Finding venues near you\.\.\.|Finding events near you\.\.\./);
}

/** Every parameter ExploreScreen takes, read off its signature. */
const EXPLORE_PARAMS = (() => {
  const start = EXPLORE_SRC.indexOf('export default function ExploreScreen({');
  const end = EXPLORE_SRC.indexOf('}) {', start);
  return EXPLORE_SRC.slice(start, end)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z_]\w*(\s*=.*)?,$/.test(l))
    .map((l) => l.replace(/\s*=.*$/, '').replace(/,$/, ''));
})();

const none = () => null;

function exploreProps(over = {}) {
  const p = {};
  for (const name of EXPLORE_PARAMS) p[name] = jest.fn();
  return Object.assign(p, {
    DialogBehavior: none,
    EmptyMark: none,
    ListSkeleton: none,
    MapLibreMapView: none,
    REVIEW_HIDE_LOCATION_BANNER: false,
    fmtMoney: (n) => String(n),
    BottomNav: none,
    SafetyButton: none,
    SearchInputLocal: none,
    renderConsumerVenueCard: none,
    activeVenue: null,
    allVenues: [],
    budgetFilteredVenues: [],
    budgetStatus: null,
    category: 'All',
    categoryExpanded: false,
    colors: {},
    connectResults: [],
    connectSearch: '',
    connectSearchError: '',
    connectSearching: false,
    discoverNavOpen: false,
    eventsSearchQuery: '',
    eventsSearchTimerRef: { current: null },
    featuredEvents: null,
    featuredEventsError: '',
    featuredEventsLoading: false,
    flockMemberLocations: {},
    friendStatuses: {},
    isDark: false,
    isExploreVisible: true,
    locationEnabled: true,
    locationError: '',
    locationLoading: false,
    mapVenuesLoaded: false,
    pickingVenueForCreate: false,
    pickingVenueForDm: false,
    pickingVenueForFlockId: null,
    sharingLocationForFlock: null,
    showConnectPanel: false,
    showEventsView: false,
    showSearchDropdown: false,
    tableParty: 2,
    userLocation: null,
    venueLoadError: '',
    venueQuery: '',
    venueResults: [],
    venueSearching: false,
  }, over);
}

describe('the first-run row', () => {
  test('the parameter list was read', () => {
    expect(EXPLORE_PARAMS).toContain('mapVenuesLoaded');
    expect(EXPLORE_PARAMS).toContain('locationLoading');
    expect(EXPLORE_PARAMS).toContain('isExploreVisible');
  });

  test('while the device finds the fix: one row, no ring, no second sentence', () => {
    const { container } = render(<ExploreScreen {...exploreProps({ locationLoading: true })} />);
    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0].textContent).toBe('Finding where you are. Venues near you show up once that lands.');
    expectNoSpinnerOrLoadingText(container);
  });

  test('once the fix lands and the venue search runs, the row stays and says so', () => {
    const { container } = render(<ExploreScreen {...exploreProps({ userLocation: { lat: 40, lng: -75 } })} />);
    expect(screen.getByRole('status').textContent).toBe('Finding venues near you.');
    expectNoSpinnerOrLoadingText(container);
  });

  test('once the venues are on the map, the row is gone', () => {
    render(<ExploreScreen {...exploreProps({ userLocation: { lat: 40, lng: -75 }, mapVenuesLoaded: true, allVenues: [{ place_id: 'p1', name: 'A' }] })} />);
    expect(screen.queryByText('Finding venues near you.')).toBeNull();
  });

  test('a refusal or a failure is the row below, not this one', () => {
    render(<ExploreScreen {...exploreProps({ userLocation: { lat: 40, lng: -75 }, venueLoadError: 'Venues are not loading right now. Try again in a moment.' })} />);
    expect(screen.queryByText('Finding venues near you.')).toBeNull();
    expect(screen.getByText('Venues are not loading right now. Try again in a moment.')).toBeTruthy();
  });

  test('with Location off it does not claim to be finding anything', () => {
    render(<ExploreScreen {...exploreProps({ locationEnabled: false, userLocation: { lat: 40, lng: -75 } })} />);
    expect(screen.queryByText('Finding venues near you.')).toBeNull();
  });

  test('nothing is drawn on the map while it waits: the map is handed no venues', () => {
    const map = jest.fn(() => null);
    render(<ExploreScreen {...exploreProps({ MapLibreMapView: map, locationLoading: true })} />);
    expect(map).toHaveBeenCalled();
    for (const [props] of map.mock.calls) expect(props.venues).toEqual([]);
  });
});

describe('Live Events', () => {
  test('the list waits with event cards in the card\'s own shape', () => {
    const { container } = render(<ExploreScreen {...exploreProps({ showEventsView: true, featuredEventsLoading: true, userLocation: { lat: 40, lng: -75 }, mapVenuesLoaded: true })} />);
    expect(screen.getByText('Finding events near you')).toBeTruthy();
    const headers = Array.from(container.querySelectorAll('.skeleton')).filter((b) => b.style.height === '132px');
    expect(headers).toHaveLength(3);
    expect(screen.queryByText('No events found nearby')).toBeNull();
    expectNoSpinnerOrLoadingText(container);
  });
});

describe('Find Your People', () => {
  test('a search waits with rows: the 42px face, two lines and the two buttons', () => {
    const { container } = render(<ExploreScreen {...exploreProps({ showConnectPanel: true, connectSearch: 'sam', connectSearching: true, userLocation: { lat: 40, lng: -75 }, mapVenuesLoaded: true })} />);
    expect(screen.getByText('Searching people')).toBeTruthy();
    const faces = Array.from(container.querySelectorAll('.skeleton')).filter((b) => b.style.width === '42px' && b.style.borderRadius === '50%');
    expect(faces).toHaveLength(3);
    expect(screen.queryByText(/No users found/)).toBeNull();
    expectNoSpinnerOrLoadingText(container);
  });
});

describe('an event\'s details', () => {
  const props = (over) => ({
    DialogBehavior: none,
    colors: { navy: '#14213d', navyBg: '#14213d' },
    fmtMoney: (n) => `${n}`,
    httpUrl: (u) => u,
    openExternal: () => {},
    eventDetail: { id: 'E1', name: 'A show', date: '2026-11-07', venue_name: 'The Fillmore' },
    eventDetailError: '',
    eventDetailLoading: true,
    setCurrentScreen: () => {},
    setEventDetail: () => {},
    setEventDetailError: () => {},
    setEventDetailLoading: () => {},
    setSelectedVenueForCreate: () => {},
    setShowEventsView: () => {},
    userLocation: null,
    ...over,
  });

  test('while the read is out: the list\'s own facts are drawn, and one About-shaped block stands where the copy lands', () => {
    const { container } = render(<EventDetailOverlay {...props()} />);
    expect(screen.getByText('The Fillmore')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Loading the rest of this event');
    // The label and three lines of copy.
    const bars = Array.from(container.querySelectorAll('.skeleton'));
    expect(bars.map((b) => b.style.width)).toEqual(['48px', '100%', '94%', '60%']);
    expectNoSpinnerOrLoadingText(container);
  });

  test('once it answers, the About copy replaces the block', () => {
    const { container } = render(<EventDetailOverlay {...props({ eventDetailLoading: false, eventDetail: { id: 'E1', name: 'A show', info: 'Doors at seven.' } })} />);
    expect(screen.getByText('Doors at seven.')).toBeTruthy();
    expect(container.querySelectorAll('.skeleton')).toHaveLength(0);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('the map\'s ground before the map', () => {
  test('the chunk fallback paints the map panel\'s own ground, from the theme, with no spinner', () => {
    const app = read('App.js');
    const start = app.indexOf('const MapChunkFallback = () => {');
    expect(start).toBeGreaterThan(-1);
    const fn = app.slice(start, app.indexOf('};', start));
    expect(fn).toContain('const { isDark } = useTheme();');
    expect(fn).toContain("backgroundColor: isDark ? '#0b1220' : 'var(--bg-primary)'");
    expect(fn).not.toContain('#1a2a3a');
    // The same two values the map's own loading panel stands on.
    const map = read('components', 'map', 'MapLibreMapView.js');
    expect(map).toContain("const MAP_GROUND = { light: 'var(--bg-primary)', dark: '#0b1220' };");
  });
});
