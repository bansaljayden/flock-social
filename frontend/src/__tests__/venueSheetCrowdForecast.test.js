/**
 * THE CROWD FORECAST IS ON THE FIRST TAP (2026-11-06).
 *
 * Tapping a Discover search result opened the venue sheet (photo, rating,
 * hours, contact, reviews) with no forecast on it; the dial, the LIVE chip and
 * the hour-by-hour bars were on the map card underneath and showed only after
 * the sheet was closed with X. Birdie's Details opened the same sheet, where
 * the forecast never appeared at all. The sheet stays the first thing a tap
 * opens, and it now draws the map card's own forecast near its top: under the
 * header and the rating, price and open row, above the hours.
 *
 * It is the same component the card draws (CrowdForecastPanel in
 * components/venue/ConsumerVenueCard.js), fed the read openVenueDetail already
 * makes beside Place Details, so there is one forecast with one set of rules
 * and no second request. Rendered here with the real components.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=venueSheetCrowdForecast
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import VenueDetailSheet from '../components/overlays/VenueDetailSheet';
import { CrowdForecastPanel } from '../components/venue/ConsumerVenueCard';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const SHEET_SRC = read('components', 'overlays', 'VenueDetailSheet.js');
const CARD_SRC = read('components', 'venue', 'ConsumerVenueCard.js');
const APP_SRC = read('App.js');
const BIRDIE_SRC = read('components', 'birdie', 'BirdiePanel.js');

const PLACE = 'ChIJcopperFinch01';
const colors = {
  navy: '#0d2847', navyBg: '#0d2847', steel: '#2d5a87', amber: '#F59E0B', amberText: '#b45309',
  red: '#EF4444', redText: '#b91c1c', textSecondary: '#556274', textTertiary: '#586376', disabled: '#e5e7eb',
};
// The three App.js helpers, as App.js defines them, so the panel colours and
// dates the way it does in the app.
const crowdBand = (s) => (!Number.isFinite(s) ? null : s > 84 ? 'red' : s > 39 ? 'amber' : 'green');
const crowdColorFor = (s) => ({ red: '#EF4444', amber: '#F59E0B', green: '#22C55E' })[crowdBand(s)] || null;
const crowdInkFor = (s) => ({ red: 'var(--accent-red-text)', amber: 'var(--accent-amber-text)', green: 'var(--accent-green-text)' })[crowdBand(s)] || null;
const CROWD_FRESH_MS = 5 * 60 * 1000;
const HOUR_ORDERING_MIN_GAP = 10;

const HOURS = ['3 PM', '4 PM', '5 PM', '6 PM', '7 PM', '8 PM', '9 PM', '10 PM', '11 PM', '12 AM', '1 AM', '2 AM'];
const hourly = HOURS.map((hour, i) => ({ hour, score: 30 + (i % 4) * 5, open: i < 7 }));

/** A crowd read the way GET /api/crowd/:placeId answers, tagged for its place. */
function read30(over = {}) {
  return {
    forPlaceId: PLACE,
    score: 30,
    label: 'Not Busy',
    predictionMethod: 'ml',
    lastUpdated: new Date().toISOString(),
    hourly,
    bestTime: 'Now is good',
    bestIsNow: true,
    peak: '7 PM',
    isOpen: true,
    venueClock: { hour: new Date().getHours(), day: new Date().getDay(), local: true },
    confidenceBasis: 'venue_baseline',
    ...over,
  };
}

const VENUE = {
  place_id: PLACE,
  name: 'The Copper Finch',
  formatted_address: '214 Main St, Bethlehem, PA 18018',
  loading: false,
  rating: 4.3,
  user_ratings_total: 1891,
  price_level: 2,
  types: ['mexican_restaurant', 'restaurant'],
  opening_hours: { openNow: true, weekdayDescriptions: ['Monday: 11:00 AM - 9:30 PM', 'Tuesday: 11:00 AM - 9:30 PM', 'Wednesday: 11:00 AM - 9:30 PM', 'Thursday: 11:00 AM - 9:30 PM', 'Friday: 11:00 AM - 10:00 PM', 'Saturday: 11:00 AM - 10:00 PM', 'Sunday: 10:30 AM - 8:30 PM'] },
};

/** The sheet's parameter names, read off its signature, as the other sheet suites read them. */
const PARAMS = (() => {
  const start = SHEET_SRC.indexOf('const VenueDetailSheet = ({');
  const end = SHEET_SRC.indexOf('}) => {', start);
  return SHEET_SRC.slice(start, end).split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z_]\w*,$/.test(l)).map((l) => l.slice(0, -1));
})();

function sheetProps(over = {}) {
  const p = {};
  for (const name of PARAMS) p[name] = jest.fn();
  return Object.assign(p, {
    DialogBehavior: () => null,
    SearchInputLocal: () => null,
    httpUrl: (u) => (typeof u === 'string' && /^https?:/.test(u) ? u : null),
    colors,
    CROWD_FRESH_MS,
    HOUR_ORDERING_MIN_GAP,
    crowdColorFor,
    crowdInkFor,
    venueDetailModal: VENUE,
    venueDetailPhotoIdx: 0,
    venueDetailPlaceId: PLACE,
    venueDetailPromos: [],
    venueDetailEvents: [],
    venueDetailReviews: [],
    venueDetailReviewTotal: 0,
    venueDetailReviewsError: null,
    venueDetailReturnTo: null,
    pickingVenueForDm: null,
    pickingVenueForFlockId: null,
    showReviewForm: false,
    reviewRating: 0,
    reviewText: '',
    reviewSubmitting: false,
    flocks: [],
    flocksRef: { current: [] },
    meRef: { current: null },
    crowdData: read30(),
    crowdLoading: false,
    crowdFetchFailed: false,
    partySize: null,
  }, over);
}

function panelProps(over = {}) {
  return {
    venue: VENUE,
    CROWD_FRESH_MS,
    HOUR_ORDERING_MIN_GAP,
    crowdColorFor,
    crowdInkFor,
    colors,
    crowdData: read30(),
    crowdFetchFailed: false,
    crowdLoading: false,
    partySize: null,
    setPartySize: jest.fn(),
    setPaywallTrigger: jest.fn(),
    ...over,
  };
}

/** jsdom has no 2D canvas. A stand-in context the dial can draw into. */
const fakeContext = () => ({ clearRect() {}, drawImage() {}, beginPath() {}, arc() {}, stroke() {} });
let getContext;
beforeEach(() => {
  getContext = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(fakeContext);
});
afterEach(() => {
  getContext.mockRestore();
  delete window.matchMedia;
});

const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('the venue sheet shows the forecast on the first tap', () => {
  test('under the rating, price and open row and above the hours', () => {
    render(<VenueDetailSheet {...sheetProps()} />);
    const rating = screen.getByText('4.3');
    const heading = screen.getByText(/Expected Crowd by Hour/);
    const hours = screen.getByRole('heading', { name: 'Hours' });
    expect(screen.getByText('Not Busy')).toBeTruthy();
    expect(follows(rating, heading)).toBe(true);
    expect(follows(heading, hours)).toBe(true);
    // The dial, the reality check and the group chips came with it.
    expect(screen.getByRole('button', { name: 'There now? Rate the crowd' })).toBeTruthy();
    expect(screen.getByText('Group:')).toBeTruthy();
  });

  test('LIVE only for the model\'s own fresh number', () => {
    const { unmount } = render(<VenueDetailSheet {...sheetProps()} />);
    expect(screen.getByText('LIVE')).toBeTruthy();
    unmount();
    render(<VenueDetailSheet {...sheetProps({ crowdData: read30({ predictionMethod: 'rule_engine' }) })} />);
    expect(screen.queryByText('LIVE')).toBeNull();
    expect(screen.getByText('ESTIMATED')).toBeTruthy();
  });

  test('the owner\'s number is said as theirs, under no chip', () => {
    render(<VenueDetailSheet {...sheetProps({
      crowdData: read30({ score: 40, label: 'Steady', predictionMethod: 'owner_report', ownerReport: { applied: true, noun: 'bar', percent: 40, reportedAt: new Date().toISOString() } }),
    })} />);
    expect(screen.getByText("The bar says it's at 40% right now")).toBeTruthy();
    expect(screen.queryByText('LIVE')).toBeNull();
    expect(screen.queryByText('ESTIMATED')).toBeNull();
  });

  test('a closed venue reads closed, never a crowd', () => {
    render(<VenueDetailSheet {...sheetProps({
      venueDetailModal: { ...VENUE, opening_hours: { ...VENUE.opening_hours, openNow: false } },
      crowdData: read30({ isOpen: false }),
    })} />);
    expect(screen.getAllByText(/Closed Today|Currently Closed/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Not Busy')).toBeNull();
  });

  test('a read for another place is never drawn on this one', () => {
    const { unmount } = render(<VenueDetailSheet {...sheetProps({ crowdData: read30({ forPlaceId: 'ChIJsomewhereElse' }), crowdLoading: true })} />);
    expect(screen.queryByText('Not Busy')).toBeNull();
    expect(screen.getByText('Loading the crowd reading')).toBeTruthy();
    unmount();
    // Nothing in hand and nothing coming: said once, under no chip.
    render(<VenueDetailSheet {...sheetProps({ crowdData: read30({ forPlaceId: 'ChIJsomewhereElse' }), crowdLoading: false })} />);
    expect(screen.queryByText('Not Busy')).toBeNull();
    expect(screen.getAllByText('No crowd read for this spot right now.').length).toBeGreaterThan(0);
    expect(screen.queryByText('ESTIMATED')).toBeNull();
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  test('a covered forecast says so, and See Pro closes the sheet before the paywall opens over the map', () => {
    const calls = [];
    const p = sheetProps({
      crowdData: { forPlaceId: PLACE, forecastAccess: { locked: true, limit: 3 } },
      setVenueDetailModal: jest.fn((v) => calls.push(['close', v])),
      setPaywallTrigger: jest.fn((t, place) => calls.push(['paywall', t, place])),
    });
    render(<VenueDetailSheet {...p} />);
    expect(screen.getByText('Crowd level is part of Flock Pro')).toBeTruthy();
    expect(screen.queryByText('Not Busy')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'See Pro' }));
    expect(calls).toEqual([['close', null], ['paywall', 'forecast', PLACE]]);
  });

  test('while the details load, the forecast\'s shape waits between the stat tiles and the hours', () => {
    const { container } = render(<VenueDetailSheet {...sheetProps({ venueDetailModal: { place_id: PLACE, name: 'The Copper Finch', loading: true }, crowdData: null, crowdLoading: true })} />);
    const dial = Array.from(container.querySelectorAll('.skeleton')).find((b) => b.style.width === '60px' && b.style.height === '60px');
    expect(dial).toBeTruthy();
    const tiles = Array.from(container.querySelectorAll('div')).filter((d) => d.style.height === '62px' && d.style.borderRadius === '12px');
    const hoursTitle = Array.from(container.querySelectorAll('.skeleton')).find((b) => b.style.width === '72px' && b.style.height === '18px');
    expect(follows(tiles[2], dial)).toBe(true);
    expect(follows(dial, hoursTitle)).toBe(true);
    // No figure anywhere while nothing has been read.
    expect(container.textContent).not.toMatch(/Not Busy|\d+%|LIVE|ESTIMATED/);
  });

  test('a sheet with no place yet draws no forecast, and nothing from the map card\'s navigation', () => {
    render(<VenueDetailSheet {...sheetProps({ venueDetailModal: { ...VENUE, place_id: undefined } })} />);
    expect(screen.queryByText(/Expected Crowd by Hour/)).toBeNull();
    expect(screen.queryByText(/Less Crowded Nearby/i)).toBeNull();
  });
});

describe('one forecast, wired once', () => {
  test('App.js hands the sheet what the map card reads, and the paywall opener that takes a place', () => {
    const at = APP_SRC.indexOf('<VenueDetailSheet');
    const tag = APP_SRC.slice(at, APP_SRC.indexOf('/>', at));
    for (const prop of [
      'CROWD_FRESH_MS={CROWD_FRESH_MS}', 'HOUR_ORDERING_MIN_GAP={HOUR_ORDERING_MIN_GAP}',
      'crowdColorFor={crowdColorFor}', 'crowdInkFor={crowdInkFor}', 'crowdData={crowdData}',
      'crowdFetchFailed={crowdFetchFailed}', 'crowdLoading={crowdLoading}',
      'partySize={partySize}', 'setPartySize={setPartySize}', 'setPaywallTrigger={openPaywall}',
    ]) expect(tag).toContain(prop);
  });

  test('no second request: the read the sheet draws is the one openVenueDetail makes beside the details, and Birdie\'s Details goes through it', () => {
    expect(SHEET_SRC).not.toMatch(/getCrowdPrediction|getCrowdBatch/);
    const open = APP_SRC.slice(APP_SRC.indexOf('const openVenueDetail = useCallback'), APP_SRC.indexOf('const handleVenueQueryChange'));
    expect(open).toMatch(/Promise\.allSettled\(\[\s*getVenueDetails\(placeId\),\s*getCrowdPrediction\(placeId\),\s*\]\)/);
    expect(open).toContain('setCrowdData(crowd ? { ...crowd, forPlaceId: placeId } : null);');
    expect(BIRDIE_SRC).toMatch(/openVenueDetail\(v\.place_id, \{ name: v\.name, formatted_address: v\.address, place_id: v\.place_id, rating: v\.rating \}\);/);
  });

  test('the map card draws the same panel, with its own nearby list and way back', () => {
    expect(CARD_SRC).toMatch(/<CrowdForecastPanel\n\s+venue=\{activeVenue\}/);
    expect(CARD_SRC).not.toContain('{(() => {\n                // Only this venue\'s read.');
    // The card's nearby list and its way back draw only from data the card
    // passes. The sheet passes none of it.
    const panel = SHEET_SRC.slice(SHEET_SRC.indexOf('<CrowdForecastPanel'), SHEET_SRC.indexOf('/>', SHEET_SRC.indexOf('<CrowdForecastPanel')));
    expect(panel).toContain('venue={venueDetailModal}');
    for (const prop of ['crowdAlternatives=', 'allVenues=', 'venueDetailHistory=', 'openVenueDetail=', 'setActiveVenue=']) expect(panel).not.toContain(prop);
  });
});

describe('CrowdForecastPanel', () => {
  const nearbyProps = {
    crowdData: read30({ score: 70, label: 'Busy' }),
    crowdAlternatives: [{ placeId: 'ChIJquiet', name: 'The Quiet Room', score: 20, label: 'Quiet' }],
    venueDetailHistory: [{ activeVenue: { name: 'The Last Place' } }],
    allVenues: [],
  };

  test('the map card\'s nearby list and its way back draw only from what the card passes', () => {
    const { unmount } = render(<CrowdForecastPanel {...panelProps(nearbyProps)} />);
    expect(screen.getByText('Less Crowded Nearby')).toBeTruthy();
    expect(screen.getByText(/Back to The Last Place/)).toBeTruthy();
    unmount();
    // The sheet's call: the same read, none of the card's navigation.
    render(<CrowdForecastPanel {...panelProps({ crowdData: nearbyProps.crowdData })} />);
    expect(screen.getByText('Busy')).toBeTruthy();
    expect(screen.queryByText('Less Crowded Nearby')).toBeNull();
    expect(screen.queryByText(/Back to /)).toBeNull();
  });

  test('no read means no ESTIMATED chip over "No crowd read"', () => {
    render(<CrowdForecastPanel {...panelProps({ crowdData: null, crowdFetchFailed: true })} />);
    expect(screen.getAllByText('No crowd read for this spot right now.').length).toBeGreaterThan(0);
    expect(screen.queryByText('ESTIMATED')).toBeNull();
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  const dialText = (container) => container.querySelector('canvas').parentElement.querySelector('span').textContent;

  test('the dial counts up from 0 by default', () => {
    const { container } = render(<CrowdForecastPanel {...panelProps()} />);
    expect(dialText(container)).toBe('0%');
  });

  test('with Reduce Motion on, the dial shows its figure at once', () => {
    window.matchMedia = jest.fn((q) => ({ matches: /prefers-reduced-motion: reduce/.test(q), media: q, addListener() {}, removeListener() {} }));
    const { container } = render(<CrowdForecastPanel {...panelProps()} />);
    expect(dialText(container)).toBe('30%');
  });

  test('a WebView that hands out no 2D context still gets the figure, and no crash', () => {
    getContext.mockImplementation(() => null);
    const { container } = render(<CrowdForecastPanel {...panelProps()} />);
    expect(dialText(container)).toBe('30%');
  });
});
