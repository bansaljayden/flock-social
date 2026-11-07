/**
 * THE CROWD FORECAST IS ON THE FIRST TAP (2026-11-06).
 *
 * Tapping a Discover search result opened the venue sheet (photo, rating,
 * hours, contact, reviews) with no forecast on it; the dial, its source line and
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
import { freshCrowdReadFor } from '../lib/crowdReadInHand';
import { compactHourLabel } from '../lib/crowd';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const SHEET_SRC = read('components', 'overlays', 'VenueDetailSheet.js');
const CARD_SRC = read('components', 'venue', 'ConsumerVenueCard.js');
const APP_SRC = read('App.js');
const BIRDIE_SRC = read('components', 'birdie', 'BirdiePanel.js');
const MAP_SRC = read('components', 'map', 'MapLibreMapView.js');

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

/** The sheet's own read as App.js keeps it (venueDetailCrowd). */
const sheetRead = (read, over = {}) => ({ placeId: PLACE, read, loading: false, failed: false, ...over });

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
    venueDetailCrowd: sheetRead(read30()),
    partySize: null,
    venueOwnerView: false,
  }, over);
}

function panelProps(over = {}) {
  return {
    venue: VENUE,
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

  test('no LIVE or ESTIMATED label, whatever made the number: the line under the dial says what did', () => {
    // The model's own fresh number.
    const first = render(<VenueDetailSheet {...sheetProps()} />);
    expect(screen.getByText('From the Flock crowd model.')).toBeTruthy();
    expect(first.container.textContent).not.toMatch(/\bLIVE\b|ESTIMATED/);
    first.unmount();
    // A category estimate says it is one.
    const second = render(<VenueDetailSheet {...sheetProps({ venueDetailCrowd: sheetRead(read30({ predictionMethod: 'rule_engine', confidenceBasis: 'category_pattern' })) })} />);
    expect(screen.getByText('An estimate from typical patterns for this kind of place.')).toBeTruthy();
    expect(second.container.textContent).not.toMatch(/\bLIVE\b|ESTIMATED/);
    second.unmount();
    // The case a recording caught: a fresh reply whose number is the venue's
    // reading from an hour ago, carried forward. The chip said LIVE beside it.
    // Now the line gives its age and does not call it live.
    const third = render(<VenueDetailSheet {...sheetProps({ venueDetailCrowd: sheetRead(read30({ numberSource: 'live_reading_1h', confidenceBasis: 'model_holdout' })) })} />);
    expect(screen.getByText("From this venue's reading taken an hour ago.")).toBeTruthy();
    expect(third.container.textContent).not.toMatch(/\bLIVE\b|ESTIMATED|live reading taken/);
  });

  test('the owner\'s number is said as theirs, under no chip', () => {
    render(<VenueDetailSheet {...sheetProps({
      venueDetailCrowd: sheetRead(read30({ score: 40, label: 'Steady', predictionMethod: 'owner_report', ownerReport: { applied: true, noun: 'bar', percent: 40, reportedAt: new Date().toISOString() } })),
    })} />);
    expect(screen.getByText("The bar says it's at 40% right now")).toBeTruthy();
    expect(screen.queryByText('LIVE')).toBeNull();
    expect(screen.queryByText('ESTIMATED')).toBeNull();
  });

  test('a closed venue reads closed, never a crowd', () => {
    render(<VenueDetailSheet {...sheetProps({
      venueDetailModal: { ...VENUE, opening_hours: { ...VENUE.opening_hours, openNow: false } },
      venueDetailCrowd: sheetRead(read30({ isOpen: false })),
    })} />);
    expect(screen.getAllByText(/Closed Today|Currently Closed/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Not Busy')).toBeNull();
  });

  test('while this place\'s read is out, the forecast waits for it', () => {
    render(<VenueDetailSheet {...sheetProps({ venueDetailCrowd: sheetRead(null, { loading: true }) })} />);
    expect(screen.queryByText('Not Busy')).toBeNull();
    expect(screen.getByText('Loading the crowd reading')).toBeTruthy();
  });

  test('a read for another place is never drawn on this one', () => {
    const elsewhere = 'ChIJsomewhereElse';
    render(<VenueDetailSheet {...sheetProps({ venueDetailCrowd: sheetRead(read30({ forPlaceId: elsewhere }), { placeId: elsewhere }) })} />);
    expect(screen.queryByText('Not Busy')).toBeNull();
    // Nothing in hand and nothing coming: said once, under no chip.
    expect(screen.getAllByText('No crowd read for this spot right now.')).toHaveLength(1);
    expect(screen.queryByText('ESTIMATED')).toBeNull();
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  test('a covered forecast says so, and See Pro closes the sheet before the paywall opens over the map', () => {
    const calls = [];
    const p = sheetProps({
      venueDetailCrowd: sheetRead({ forPlaceId: PLACE, forecastAccess: { locked: true, limit: 3 } }),
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
    const { container } = render(<VenueDetailSheet {...sheetProps({ venueDetailModal: { place_id: PLACE, name: 'The Copper Finch', loading: true }, venueDetailCrowd: sheetRead(null, { loading: true }) })} />);
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

describe('no read, no verdict', () => {
  // Probed on the sheet before the fix, with the Group chips' party set: no
  // read and a party of 4 drew "No crowd read for this spot right now. Walk
  // right in (4)"; the loading chip drew "Walk right in (4)" under it; a
  // closed room with 6 drew "Closed Today ... Expect a wait (6)". The verdict
  // was the placeholder 0 plus the party's weight. No read also said "No
  // crowd read" twice, over an empty chart heading, and kept the two tiles in
  // the tree at opacity 0, where VoiceOver read "Est. Wait Right Now, No wait".
  const VERDICT = /Walk right in|Should be fine|Might wait briefly|Expect a wait|Reservation needed|Call ahead recommended|Book ahead|Buy tickets|No issues for groups/;

  test('with no read: said once, and no group verdict, chips, chart heading or tiles', () => {
    render(<VenueDetailSheet {...sheetProps({ venueDetailCrowd: sheetRead(null, { failed: true }), partySize: 4 })} />);
    expect(screen.getAllByText('No crowd read for this spot right now.')).toHaveLength(1);
    expect(screen.queryByText(VERDICT)).toBeNull();
    expect(screen.queryByText('(4)')).toBeNull();
    expect(screen.queryByText('Group:')).toBeNull();
    expect(screen.queryByText(/Expected Crowd by Hour/)).toBeNull();
    expect(screen.queryByText('Busiest hours')).toBeNull();
    expect(screen.queryByText(/Est\. Wait/)).toBeNull();
  });

  test('while the read is out: the loading chip and nothing under it that needs a read', () => {
    render(<VenueDetailSheet {...sheetProps({ venueDetailCrowd: sheetRead(null, { loading: true }), partySize: 4 })} />);
    expect(screen.getByText('Loading the crowd reading')).toBeTruthy();
    expect(screen.queryByText(VERDICT)).toBeNull();
    expect(screen.queryByText('(4)')).toBeNull();
    expect(screen.queryByText('Busiest hours')).toBeNull();
  });

  test('a closed room: closed, and no verdict for a party', () => {
    render(<VenueDetailSheet {...sheetProps({
      venueDetailModal: { ...VENUE, opening_hours: { ...VENUE.opening_hours, openNow: false } },
      venueDetailCrowd: sheetRead(read30({ isOpen: false, score: 70 })),
      partySize: 6,
    })} />);
    expect(screen.getAllByText(/Closed Today|Currently Closed/).length).toBeGreaterThan(0);
    expect(screen.queryByText(VERDICT)).toBeNull();
    expect(screen.queryByText('(6)')).toBeNull();
  });

  test('a read of this place with no number is no read: said once, and nothing pulses', () => {
    const { container } = render(<VenueDetailSheet {...sheetProps({ venueDetailCrowd: sheetRead({ forPlaceId: PLACE, score: null }), partySize: 4 })} />);
    expect(screen.getAllByText('No crowd read for this spot right now.')).toHaveLength(1);
    expect(container.querySelectorAll('.skeleton')).toHaveLength(0);
    expect(screen.queryByText(VERDICT)).toBeNull();
  });

  test('an open room with a read still answers for the party', () => {
    render(<VenueDetailSheet {...sheetProps({ partySize: 4 })} />);
    expect(screen.getByText('Walk right in')).toBeTruthy();
    expect(screen.getByText('(4)')).toBeTruthy();
    // The wait is said once, on the line under the dial; the tile that
    // said it again is gone.
    expect(screen.queryByText('Est. Wait')).toBeNull();
    expect(screen.getAllByText(/^Est\. wait: |^No wait expected$/)).toHaveLength(1);
  });
});

describe('a venue account gets the forecast without the consumer actions', () => {
  // A venue account on its dashboard taps a place on the dashboard map, a
  // competitor for one, and this sheet opens. It drew "There now? Rate the
  // crowd", which posts /api/feedback (routes/feedback.js checks no role), and
  // See Pro; the dashboard's map card leaves both out for a venue account.
  test('no reality check and no See Pro, with the reading itself unchanged', () => {
    const { unmount } = render(<VenueDetailSheet {...sheetProps({ venueOwnerView: true })} />);
    expect(screen.getByText('Not Busy')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /There now\?/ })).toBeNull();
    unmount();
    render(<VenueDetailSheet {...sheetProps({ venueOwnerView: true, venueDetailCrowd: sheetRead({ forPlaceId: PLACE, forecastAccess: { locked: true, limit: 3 } }) })} />);
    expect(screen.getByText('Crowd level is part of Flock Pro')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'See Pro' })).toBeNull();
  });

  test('a person still gets both', () => {
    render(<VenueDetailSheet {...sheetProps({ venueOwnerView: false })} />);
    expect(screen.getByRole('button', { name: 'There now? Rate the crowd' })).toBeTruthy();
  });

  test('App.js says which it is: venue mode, or the venue dashboard', () => {
    const at = APP_SRC.indexOf('<VenueDetailSheet');
    const tag = APP_SRC.slice(at, APP_SRC.indexOf('/>', at));
    expect(tag).toContain("venueOwnerView={userMode === 'venue' || currentScreen === 'venueDashboard'}");
    const panel = SHEET_SRC.slice(SHEET_SRC.indexOf('<CrowdForecastPanel'), SHEET_SRC.indexOf('/>', SHEET_SRC.indexOf('<CrowdForecastPanel')));
    expect(panel).toContain('venueOwnerView={!!venueOwnerView}');
  });
});

describe('the hours fit a phone', () => {
  test('each bar\'s hour prints compact, with the full hour kept for a screen reader', () => {
    const { container } = render(<VenueDetailSheet {...sheetProps()} />);
    const short = screen.getByText('4p');
    expect(short.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('4 PM').className).toBe('sr-only');
    expect(screen.getByText('Now')).toBeTruthy();
    // Every other label is the one a narrow window blanks; "Now" never is.
    const labels = Array.from(container.querySelectorAll('.crowd-hour'));
    expect(labels.length).toBeGreaterThan(2);
    labels.forEach((el, i) => expect(el.classList.contains('crowd-hour-alt')).toBe(i % 2 === 1));
    expect(labels[0].textContent).toBe('Now');
    expect(read('index.css')).toMatch(/@media \(max-width: 359px\) \{\s*\.crowd-hour-alt \.crowd-hour-text \{\s*visibility: hidden;\s*\}\s*\}/);
  });

  test('compactHourLabel shortens an hour and leaves anything else alone', () => {
    expect(['10 PM', '12 AM', '9:30 PM', '1 am', '11 P.M.'].map(compactHourLabel)).toEqual(['10p', '12a', '9:30p', '1a', '11p']);
    expect(['Now', 'Noon', '', null, 21].map(compactHourLabel)).toEqual(['Now', 'Noon', '', null, 21]);
  });
});

describe('one forecast, wired once', () => {
  test('App.js hands the sheet its own read, the map card\'s helpers, and the paywall opener that takes a place', () => {
    const at = APP_SRC.indexOf('<VenueDetailSheet');
    const tag = APP_SRC.slice(at, APP_SRC.indexOf('/>', at));
    // CROWD_FRESH_MS is not among them: only the LIVE chip read it, and the
    // chip is gone.
    expect(tag).not.toContain('CROWD_FRESH_MS=');
    for (const prop of [
      'HOUR_ORDERING_MIN_GAP={HOUR_ORDERING_MIN_GAP}',
      'crowdColorFor={crowdColorFor}', 'crowdInkFor={crowdInkFor}', 'venueDetailCrowd={venueDetailCrowd}',
      'partySize={partySize}', 'setPartySize={setPartySize}', 'setPaywallTrigger={openPaywall}',
    ]) expect(tag).toContain(prop);
    // Never the map card's read or its flags.
    for (const prop of ['crowdData={', 'crowdLoading={', 'crowdFetchFailed={']) expect(tag).not.toContain(prop);
  });

  test('no second request: the read the sheet draws is the one openVenueDetail makes beside the details, and Birdie\'s Details goes through it', () => {
    expect(SHEET_SRC).not.toMatch(/getCrowdPrediction|getCrowdBatch/);
    const open = APP_SRC.slice(APP_SRC.indexOf('const openVenueDetail = useCallback'), APP_SRC.indexOf('const handleVenueQueryChange'));
    expect(open).toMatch(/Promise\.allSettled\(\[\s*getVenueDetails\(placeId\),\s*getCrowdPrediction\(placeId\),\s*\]\)/);
    expect(open).toContain("setVenueDetailCrowd({ placeId: sheetPlaceId, read: crowd ? { ...crowd, forPlaceId: sheetPlaceId } : null, loading: false, failed: crowdResult.status !== 'fulfilled' });");
    expect(BIRDIE_SRC).toMatch(/openVenueDetail\(v\.place_id, \{ name: v\.name, formatted_address: v\.address, place_id: v\.place_id, rating: v\.rating, \.\.\.\(v\.usual \? \{ planDay: \{ date: v\.usual\.date, usual: v\.usual \} \} : \{\}\) \}\);/);
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

describe('the sheet keeps its own read, and the map card keeps its own', () => {
  // A sheet opened with panMap (a chat or DM venue card, a plan's venue, a
  // "Less crowded nearby" row, the return from checkout, an NFC tap) pans the
  // map, and the card switches to the place. The card's effect used to clear
  // the read both shared and ask again: the sheet's forecast went read,
  // skeletons, read, with the dial counting up twice, and when the pan settled
  // on another pin within 100 m the sheet ended on "No crowd read" for a venue
  // whose read it had, and where no pin was near, the pan dropped a temporary
  // one and reopened the sheet. Measured on the local stack before the fix,
  // through a "Less crowded nearby" row: two crowd GETs and a read, loading,
  // read sheet onto a pin; "No crowd read" onto a pin 50 m away; three crowd
  // GETs and two details GETs onto a temporary pin. After: one of each, and
  // the read stays up.
  const effect = APP_SRC.slice(APP_SRC.indexOf('// Fetch crowd data when activeVenue changes (map pin tapped)'), APP_SRC.indexOf('// Sensor: fetch + subscribe when active venue changes'));
  const open = APP_SRC.slice(APP_SRC.indexOf('const openVenueDetail = useCallback'), APP_SRC.indexOf('const handleVenueQueryChange'));

  test('the sheet takes no part of the map card\'s crowd state', () => {
    for (const name of ['crowdData', 'crowdLoading', 'crowdFetchFailed']) expect(PARAMS).not.toContain(name);
    expect(PARAMS).toContain('venueDetailCrowd');
  });

  test('openVenueDetail writes only the sheet\'s read, and asks for no "less crowded" list the sheet does not draw', () => {
    expect(open).toContain('setVenueDetailCrowd({ placeId, read: null, loading: true, failed: false });');
    expect(open).not.toMatch(/setCrowd(Data|Loading|FetchFailed|Alternatives)\(/);
    expect(open).not.toContain('getCrowdAlternatives(');
  });

  test('the card\'s effect uses a fresh read of the same place before it asks again, the sheet\'s included', () => {
    const check = 'const inHand = freshCrowdReadFor(pid, [crowdDataRef.current, venueDetailCrowdRef.current && venueDetailCrowdRef.current.read], CROWD_FRESH_MS);';
    expect(effect).toContain(check);
    expect(effect.indexOf(check)).toBeLessThan(effect.indexOf('getCrowdPrediction(pid)'));
    const branch = effect.slice(effect.indexOf('if (inHand) {'), effect.indexOf('setCrowdLoading(true);'));
    // Nothing in it clears a read or says one is on the way.
    expect(branch).not.toContain('setCrowdData(null)');
    expect(branch).toContain('setCrowdLoading(false);');
    expect(branch).toContain('setCrowdData({ ...inHand, forPlaceId: pid });');
    expect(branch).toContain('return () => { cancelled = true; };');
    // The refs it reads are the live state, assigned on every render.
    expect(APP_SRC).toContain('crowdDataRef.current = crowdData;');
    expect(APP_SRC).toContain('venueDetailCrowdRef.current = venueDetailCrowd;');
  });

  test('the pan does not reopen a sheet that is already open on the place', () => {
    expect(open).toMatch(/window\.__flockPanToVenue\(\{ place_id: placeId, [^\n]*sheetOpen: true \}\);/);
    expect(MAP_SRC).toContain('if (placeId && !target?.sheetOpen) openVenueDetail(placeId,');
  });

  test('the five-minute refresh writes the sheet\'s read, never the card\'s', () => {
    const refresh = APP_SRC.slice(APP_SRC.indexOf('const venueDetailPlaceId = venueDetailModal?.place_id;'), APP_SRC.indexOf('}, [venueDetailPlaceId]);'));
    expect(refresh).toContain('setVenueDetailCrowd(prev =>');
    expect(refresh).not.toContain('setCrowdData(');
  });

  test('the read the sheet draws is the read the sheet holds, whatever the card holds', () => {
    // The same sheet, re-rendered as App.js does when the card's own read is
    // cleared and fetched again underneath it: the sheet is handed nothing of
    // that, so the forecast stays on its read with no loading shape.
    const { rerender } = render(<VenueDetailSheet {...sheetProps()} />);
    expect(screen.getByText('Not Busy')).toBeTruthy();
    rerender(<VenueDetailSheet {...sheetProps({ crowdData: null, crowdLoading: true })} />);
    expect(screen.getByText('Not Busy')).toBeTruthy();
    expect(screen.queryByText('Loading the crowd reading')).toBeNull();
  });
});

describe('freshCrowdReadFor', () => {
  const now = Date.parse('2026-11-06T22:00:00Z');
  const at = (minsAgo, over = {}) => ({ forPlaceId: PLACE, score: 30, lastUpdated: new Date(now - minsAgo * 60000).toISOString(), ...over });

  test('a read of the place stamped inside the window is in hand', () => {
    const r = at(1);
    expect(freshCrowdReadFor(PLACE, [null, r], CROWD_FRESH_MS, now)).toBe(r);
  });

  test('another place\'s read, a stale one and an unstamped one are not', () => {
    expect(freshCrowdReadFor(PLACE, [at(1, { forPlaceId: 'ChIJother' })], CROWD_FRESH_MS, now)).toBeNull();
    expect(freshCrowdReadFor(PLACE, [at(6)], CROWD_FRESH_MS, now)).toBeNull();
    expect(freshCrowdReadFor(PLACE, [at(1, { lastUpdated: undefined })], CROWD_FRESH_MS, now)).toBeNull();
    expect(freshCrowdReadFor(null, [at(1)], CROWD_FRESH_MS, now)).toBeNull();
  });

  test('the card\'s own read wins over the sheet\'s when both are in hand', () => {
    const card = at(2);
    const sheet = at(1);
    expect(freshCrowdReadFor(PLACE, [card, sheet], CROWD_FRESH_MS, now)).toBe(card);
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

// A LATER DAY (2026-11-06). Birdie's Details from a card about another day
// hands the sheet that day (planDay): the sheet says how busy the place usually
// is then, over a forecast whose bars it titles as today's. On Thursday the
// chart for "the 13th" was Thursday's hours under a heading that did not say so.
describe('a plan for another day', () => {
  const later = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const usualFor = (date) => ({
    date, weekday: new Date(`${date}T12:00:00`).getDay(), source: 'venue_pattern',
    busiest: { start: 19, end: 21 }, hours: [{ h: 17, v: 44 }, { h: 18, v: 61 }, { h: 19, v: 75 }, { h: 20, v: 75 }, { h: 21, v: 60 }],
  });

  test('the sheet leads with that day\'s usual night and titles the bars as today\'s', () => {
    const date = later(7);
    const planDay = { date, usual: usualFor(date) };
    render(<VenueDetailSheet {...sheetProps({ venueDetailModal: { ...VENUE, planDay } })} />);
    const strip = document.querySelector('[data-usual-night]');
    expect(strip).toBeTruthy();
    const dd = new Date(`${date}T12:00:00`);
    expect(strip.textContent).toBe(`${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dd.getDay()]} ${dd.getDate()} · Usually busiest 7-9 PM`);
    const heading = screen.getByText(/Today's Crowd by Hour/);
    expect(follows(strip, heading)).toBe(true);
    expect(screen.queryByText(/Expected Crowd by Hour/)).toBeNull();
  });

  test('today, or no plan, is the sheet it was', () => {
    const today = later(0);
    const { unmount } = render(<VenueDetailSheet {...sheetProps({ venueDetailModal: { ...VENUE, planDay: { date: today, usual: usualFor(today) } } })} />);
    expect(screen.getByText(/Expected Crowd by Hour/)).toBeTruthy();
    expect(document.querySelector('[data-usual-night]')).toBeNull();
    unmount();
    render(<VenueDetailSheet {...sheetProps()} />);
    expect(screen.getByText(/Expected Crowd by Hour/)).toBeTruthy();
    expect(document.querySelector('[data-usual-night]')).toBeNull();
  });

  test('openVenueDetail keeps the plan day through the swap to Place Details', () => {
    const open = APP_SRC.slice(APP_SRC.indexOf('const openVenueDetail = useCallback'), APP_SRC.indexOf('const handleVenueQueryChange'));
    expect(open).toContain('...(fallbackData && fallbackData.planDay ? { planDay: fallbackData.planDay } : {}),');
  });
});
