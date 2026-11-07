/**
 * THE VENUE SHEET SAYS SOMETHING IN EVERY ROW (2026-11-06).
 *
 * A tester's Torre and Bolete sheets carried filler: chips reading "Point Of
 * Interest" and "Establishment", a "View Menu" row that opened a Google web
 * search, and an open tile that said "Open Now" with no closing time or
 * "Closed" at 3:44 PM for a place opening at five. Now:
 *
 *   - Google's catch-all types are not drawn as chips (lib/venueTypes.js).
 *   - The menu row says "View menu" only for a real menu link, and "Find the
 *     menu online" when it is a web search.
 *   - The open tile reads "Open until 9:30 PM" or "Opens 5 PM" from the
 *     week's periods on the venue's clock (lib/venueHours.js), with Google's
 *     openNow deciding open or closed.
 *
 * FRONTEND test (jest via react-scripts).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import VenueDetailSheet from '../components/overlays/VenueDetailSheet';
import { openStatus } from '../lib/venueHours';
import { displayVenueTypes, placeTypeLabel, isGenericPlaceType } from '../lib/venueTypes';

const noop = () => {};
const sheetProps = (modal) => ({
  DialogBehavior: () => null, SearchInputLocal: () => null, httpUrl: (u) => (typeof u === 'string' && /^https?:\/\//.test(u) ? u : null),
  colors: { navy: '#0d2847', navyBg: '#0d2847', steel: '#2d5a87', red: '#b91c1c', amber: '#f59e0b', textSecondary: '#475569', textTertiary: '#64748b' },
  venueDetailModal: modal,
  setVenueDetailModal: noop, venueDetailPhotoIdx: 0, setVenueDetailPhotoIdx: noop, venueDetailPlaceId: modal.place_id, venueDetailPromos: [], venueDetailEvents: [],
  venueDetailReviews: [], setVenueDetailReviews: noop, venueDetailReviewTotal: 0, setVenueDetailReviewTotal: noop, venueDetailReviewsError: '', loadVenueDetailReviews: noop,
  venueDetailReturnTo: null, setVenueDetailReturnTo: noop, setVenueDetailHistory: noop,
  showReviewForm: false, setShowReviewForm: noop, reviewRating: 0, setReviewRating: noop, reviewText: '', setReviewText: noop, reviewSubmitting: false, setReviewSubmitting: noop,
  pickingVenueForDm: false, setPickingVenueForDm: noop, pickingVenueForFlockId: null, setPickingVenueForFlockId: noop, setPickingVenueForCreate: noop, setSelectedVenueForCreate: noop,
  selectedDmId: null, setSelectedDmId: noop, setSelectedFlockId: noop, setCurrentTab: noop, setCurrentScreen: noop,
  flocks: [], flocksRef: { current: [] }, meRef: { current: null }, venueDetailCrowd: null, partySize: null, setPartySize: noop, setPaywallTrigger: noop, venueOwnerView: false,
  CROWD_FRESH_MS: 300000, HOUR_ORDERING_MIN_GAP: 10, crowdColorFor: () => '#22c55e', crowdInkFor: () => '#166534',
  confirmClick: noop, showToast: noop, setModerationTarget: noop, pinDmVenueNow: noop, updateFlockVenue: noop, updateFlockVotes: noop, shareVenueToChat: noop,
});

// Torre's week as Place Details sends it: Mon-Thu 11-9:30, Fri-Sat 11-10, Sun 10:30-8:30.
const day = (d, oh, om, ch, cm) => ({ open: { day: d, hour: oh, minute: om }, close: { day: d, hour: ch, minute: cm } });
const TORRE_PERIODS = [day(0, 10, 30, 20, 30), day(1, 11, 0, 21, 30), day(2, 11, 0, 21, 30), day(3, 11, 0, 21, 30), day(4, 11, 0, 21, 30), day(5, 11, 0, 22, 0), day(6, 11, 0, 22, 0)];
// Bolete's: closed Mon and Tue, Wed-Thu 5-9:30, Fri-Sat 5-10, Sun 10-2.
const BOLETE_PERIODS = [day(0, 10, 0, 14, 0), day(3, 17, 0, 21, 30), day(4, 17, 0, 21, 30), day(5, 17, 0, 22, 0), day(6, 17, 0, 22, 0)];
// Thursday 2026-11-05 15:44 in Bethlehem (UTC-5), the minute of the recording.
const THU_344PM = new Date('2026-11-05T20:44:00Z');
const EST = -300;

describe('the open tile, from the periods', () => {
  test('open: until when it closes today', () => {
    expect(openStatus({ periods: TORRE_PERIODS }, { now: THU_344PM, utcOffsetMinutes: EST })).toEqual({ open: true, text: 'Open until 9:30 PM' });
  });
  test('closed, opening later today: the hour it opens', () => {
    expect(openStatus({ periods: BOLETE_PERIODS }, { now: THU_344PM, utcOffsetMinutes: EST })).toEqual({ open: false, text: 'Opens 5 PM' });
  });
  test('closed until another day: that day and hour', () => {
    // Monday 2026-11-09 18:00 local: Bolete is closed until Wednesday 5 PM.
    expect(openStatus({ periods: BOLETE_PERIODS }, { now: new Date('2026-11-09T23:00:00Z'), utcOffsetMinutes: EST })).toEqual({ open: false, text: 'Opens Wed 5 PM' });
  });
  test('a period past midnight, and one with no close (open around the clock)', () => {
    const lateBar = [{ open: { day: 5, hour: 20, minute: 0 }, close: { day: 6, hour: 2, minute: 0 } }];
    expect(openStatus({ periods: lateBar }, { now: new Date('2026-11-07T05:30:00Z'), utcOffsetMinutes: EST })).toEqual({ open: true, text: 'Open until 2 AM' });
    expect(openStatus({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] }, { now: THU_344PM, utcOffsetMinutes: EST })).toEqual({ open: true, text: 'Open 24 hours' });
  });
  test('the legacy shape, and nothing readable', () => {
    expect(openStatus({ periods: [{ open: { day: 4, time: '1100' }, close: { day: 4, time: '2130' } }] }, { now: THU_344PM, utcOffsetMinutes: EST }).text).toBe('Open until 9:30 PM');
    expect(openStatus({ openNow: true }, { now: THU_344PM })).toBeNull();
    expect(openStatus(null)).toBeNull();
    expect(openStatus({ periods: [{ open: { day: 9 } }] })).toBeNull();
  });
});

describe('the type chips', () => {
  test("Google's catch-alls are left out, the rest kept once each, in order", () => {
    expect(displayVenueTypes(['mexican_restaurant', 'restaurant', 'food', 'point_of_interest', 'establishment'])).toEqual(['mexican_restaurant', 'restaurant']);
    expect(displayVenueTypes(['bar', 'bar', 'store', 'administrative_area_level_1', 'place_of_worship'])).toEqual(['bar', 'place_of_worship']);
    expect(displayVenueTypes(null)).toEqual([]);
    expect(isGenericPlaceType('sublocality_level_2')).toBe(true);
    expect(placeTypeLabel('american_restaurant')).toBe('American Restaurant');
  });
});

describe('the sheet', () => {
  const TORRE = {
    place_id: 'p_torre', name: 'Torre', formatted_address: '2960 Center Valley Pkwy', loading: false, rating: 4.3, user_ratings_total: 1891, price_level: 2,
    types: ['mexican_restaurant', 'restaurant', 'food', 'point_of_interest', 'establishment'],
    opening_hours: { openNow: true, periods: TORRE_PERIODS, weekdayDescriptions: ['Monday: 11:00 AM - 9:30 PM'] },
    utcOffsetMinutes: EST, menu_url: null, website: 'https://example.com/',
  };
  beforeEach(() => { jest.useFakeTimers('modern'); jest.setSystemTime(THU_344PM); });
  afterEach(() => { jest.useRealTimers(); });

  test('no catch-all chips, the open tile says until when, and a web search is called one', () => {
    render(<VenueDetailSheet {...sheetProps(TORRE)} />);
    expect(screen.getByText('Mexican Restaurant')).toBeTruthy();
    expect(screen.getByText('Restaurant')).toBeTruthy();
    expect(screen.queryByText('Point Of Interest')).toBeNull();
    expect(screen.queryByText('Establishment')).toBeNull();
    expect(screen.queryByText('Food')).toBeNull();
    expect(document.querySelector('[data-open-tile]').textContent).toBe('Open until 9:30 PM');
    expect(screen.queryByText('View Menu')).toBeNull();
    expect(screen.getByText('Find the menu online')).toBeTruthy();
  });

  test('a real menu link is "View menu"', () => {
    render(<VenueDetailSheet {...sheetProps({ ...TORRE, menu_url: 'https://example.com/menu' })} />);
    const link = screen.getByText('View menu').closest('a');
    expect(link.getAttribute('href')).toBe('https://example.com/menu');
  });

  test("Google's openNow decides open or closed: a closed-for-the-holiday place is not said to be open until 9:30", () => {
    render(<VenueDetailSheet {...sheetProps({ ...TORRE, opening_hours: { ...TORRE.opening_hours, openNow: false } })} />);
    expect(document.querySelector('[data-open-tile]').textContent).toBe('Closed');
  });

  test('a closed venue opening later says when', () => {
    render(<VenueDetailSheet {...sheetProps({ ...TORRE, opening_hours: { openNow: false, periods: BOLETE_PERIODS } })} />);
    expect(document.querySelector('[data-open-tile]').textContent).toBe('Opens 5 PM');
  });
});
