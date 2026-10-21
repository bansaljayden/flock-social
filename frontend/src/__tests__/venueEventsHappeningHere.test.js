/**
 * "HAPPENING HERE": A VENUE'S OWN EVENTS ON ITS CARD (2026-10-20).
 *
 * GET /api/venue-dashboard/public-events/:placeId decides who may see each
 * event and puts them soonest first (backend venuePublicEventsRealDb.test.js).
 * This file pins the client half:
 *
 *   - the section draws what it is given, in that order, with the date read on
 *     the reader's own calendar, and draws nothing when there is nothing;
 *   - the background is the venue's own photo, the URL the top of the card is
 *     already showing, and anything wrong with it falls back to drawn art,
 *     never to a broken image or a committed photo file;
 *   - every event has a Report control that opens the existing report sheet
 *     as a 'venue_event';
 *   - App.js loads the list with the card, drops a reported or taken-down event
 *     live, and hands the list to the sheet.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=venueEventsHappeningHere
 */
const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, within } = require('@testing-library/react');

jest.mock('../components/ui/MapsChooser', () => ({
  __esModule: true,
  default: () => null,
  openMapsChooser: jest.fn(() => true),
  closeMapsChooser: jest.fn(),
}));
jest.mock('../services/api', () => ({
  __esModule: true,
  submitVenueReview: jest.fn(),
  getPublicReviews: jest.fn(() => Promise.resolve({ reviews: [] })),
}));

const SectionModule = require('../components/overlays/VenueEventsSection');
const VenueDetailSheet = require('../components/overlays/VenueDetailSheet').default;
const {
  parseEventDay, eventDayLabel, eventWhenLine, eventPickerBounds, localDayString, EVENT_STATUS_LINE,
} = require('../lib/venueEvents');

const VenueEventsSection = SectionModule.default;
const { FIRST_SHOWN } = SectionModule;

const SRC = path.resolve(__dirname, '..');
const readSrc = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = readSrc('App.js');
const API = readSrc('services', 'api.js');
const SHEET = readSrc('components', 'overlays', 'VenueDetailSheet.js');
const SECTION = readSrc('components', 'overlays', 'VenueEventsSection.js');

const colors = { navy: '#0d2847', navyBg: '#0d2847', steel: '#2d5a87', amber: '#F5B942' };
const PHOTO = 'https://api.test/api/venues/photo?ref=abc&w=800';

// Dates on the test machine's own calendar, the way the card reads them.
const dayFromNow = (n) => {
  const now = new Date();
  return localDayString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));
};
const EVENTS = [
  { id: 31, title: 'Live jazz', event_date: dayFromNow(0), event_time: '9 PM' },
  { id: 32, title: 'Trivia night', event_date: dayFromNow(1), event_time: '8 PM' },
  { id: 33, title: 'Open mic', event_date: dayFromNow(9), event_time: null },
  { id: 34, title: 'Salsa class', event_date: dayFromNow(12), event_time: '7:30 PM' },
  { id: 35, title: 'Comedy hour', event_date: dayFromNow(20), event_time: 'doors at 8' },
];

describe('the dates read on the reader\'s own calendar', () => {
  // Wednesday 21 October 2026, 8 pm, wherever the test runs.
  const NOW = new Date(2026, 9, 21, 20, 0, 0);

  test('a calendar date is that day locally, and anything else is not a date', () => {
    expect(parseEventDay('2026-10-24').getDate()).toBe(24);
    expect(parseEventDay('2026-10-24').getHours()).toBe(0);
    for (const bad of ['Friday', '10/24', '2026-02-30', '2026-13-01', '', null, undefined, 20261024]) {
      expect(parseEventDay(bad)).toBeNull();
    }
  });

  test('today, tomorrow, the coming week by name, then the date', () => {
    expect(eventDayLabel('2026-10-21', NOW)).toBe('Today');
    expect(eventDayLabel('2026-10-22', NOW)).toBe('Tomorrow');
    expect(eventDayLabel('2026-10-24', NOW)).toBe('Saturday');
    expect(eventDayLabel('2026-10-27', NOW)).toBe('Tuesday');
    expect(eventDayLabel('2026-10-28', NOW)).toBe('Wed, Oct 28');
    expect(eventDayLabel('2027-01-15', NOW)).toBe('Fri, Jan 15, 2027');
    // The server keeps an event until the morning after it.
    expect(eventDayLabel('2026-10-20', NOW)).toBe('Last night');
    expect(eventDayLabel('Friday', NOW)).toBeNull();
  });

  test('one line for when: the day and the owner\'s own time, or an older event\'s words as typed', () => {
    expect(eventWhenLine('2026-10-22', '9 PM', NOW)).toBe('Tomorrow · 9 PM');
    expect(eventWhenLine('2026-10-21', null, NOW)).toBe('Today');
    expect(eventWhenLine('this Friday', 'doors 9', NOW)).toBe('this Friday · doors 9');
    expect(eventWhenLine(null, null, NOW)).toBe('');
    expect(`${eventWhenLine('2026-10-22', '9 PM', NOW)}`).not.toMatch(/—/);
  });

  test('the picker offers today through a year on, inside what the server takes', () => {
    expect(eventPickerBounds(NOW)).toEqual({ min: '2026-10-21', max: '2027-10-21' });
  });

  test('the owner\'s status lines are plain and carry no em dash', () => {
    expect(Object.keys(EVENT_STATUS_LINE).sort()).toEqual(['needs_date', 'other_place', 'past', 'shown']);
    for (const line of Object.values(EVENT_STATUS_LINE)) expect(line).not.toMatch(/—/);
  });
});

describe('the Happening here section', () => {
  const mount = (over = {}) => {
    const onReport = jest.fn();
    const utils = render(React.createElement(VenueEventsSection, { events: EVENTS.slice(0, 2), photoUrl: PHOTO, colors, onReport, ...over }));
    return { ...utils, onReport };
  };

  test('nothing to show draws nothing at all, not an empty heading', () => {
    for (const events of [[], undefined, null]) {
      const { container, unmount } = mount({ events });
      expect(container.innerHTML).toBe('');
      unmount();
    }
  });

  test('each event in the order given, with its day and time over the venue\'s own photo', () => {
    const { container } = mount();
    expect(screen.getByRole('heading', { name: /Happening here/ })).toBeTruthy();
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'Today · 9 PMLive jazz',
      'Tomorrow · 8 PMTrivia night',
    ]);
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    for (const img of imgs) {
      expect(img.getAttribute('src')).toBe(PHOTO);
      expect(img.getAttribute('alt')).toBe('');
    }
    expect(screen.queryByTestId('venue-event-art')).toBeNull();
  });

  test('a photo that fails to load turns every card to the drawn art, never a broken image', () => {
    const { container } = mount();
    fireEvent.error(container.querySelector('img'));
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getAllByTestId('venue-event-art')).toHaveLength(2);
    // The art is drawn, hidden from screen readers, and uses the app's navy.
    const art = screen.getAllByTestId('venue-event-art')[0];
    expect(art.tagName.toLowerCase()).toBe('svg');
    expect(art.getAttribute('aria-hidden')).toBe('true');
    expect(art.querySelector('rect').getAttribute('fill')).toBe(colors.navyBg);
  });

  test('no photo at all (none on Google, or the photo budget spent) is the drawn art from the start', () => {
    for (const photoUrl of [null, undefined, '']) {
      const { container, unmount } = mount({ photoUrl });
      expect(container.querySelectorAll('img')).toHaveLength(0);
      expect(screen.getAllByTestId('venue-event-art')).toHaveLength(2);
      unmount();
    }
  });

  test('the next venue\'s photo gets its own chance after the last one failed', () => {
    const { container, rerender, onReport } = mount();
    fireEvent.error(container.querySelector('img'));
    expect(container.querySelectorAll('img')).toHaveLength(0);
    rerender(React.createElement(VenueEventsSection, { events: EVENTS.slice(0, 2), photoUrl: `${PHOTO}&next=1`, colors, onReport }));
    expect(container.querySelectorAll('img')).toHaveLength(2);
  });

  test('every event can be reported, by name', () => {
    const { onReport } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Report Trivia night' }));
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onReport.mock.calls[0][0]).toMatchObject({ id: 32, title: 'Trivia night' });
  });

  test('a long list shows the first few and offers the rest', () => {
    mount({ events: EVENTS });
    expect(FIRST_SHOWN).toBe(3);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    const more = screen.getByRole('button', { name: 'Show all 5 events' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('Comedy hour')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  test('no Places photo is part of the code: the fallback is drawn, and no image is imported', () => {
    expect(SECTION).not.toMatch(/import [^;]+ from '[^']+\.(jpe?g|png|webp|gif|avif)'/);
    expect(SECTION).toMatch(/<svg/);
    expect(SECTION).not.toMatch(/VENUE_PHOTO_PLACEHOLDER/);
  });
});

describe('on the venue card', () => {
  const PARAM_SRC = SHEET.slice(SHEET.indexOf('const VenueDetailSheet = ({'), SHEET.indexOf('}) => {'));
  const PARAMS = [...PARAM_SRC.matchAll(/^\s+([A-Za-z]+),/gm)].map((m) => m[1]);
  const props = (over = {}) => {
    const p = {};
    for (const name of PARAMS) p[name] = jest.fn();
    return Object.assign(p, {
      DialogBehavior: () => null,
      SearchInputLocal: () => null,
      httpUrl: (u) => (typeof u === 'string' && /^https?:/.test(u) ? u : null),
      colors,
      venueDetailModal: { place_id: 'ChIJcopperFinch01', name: 'The Copper Finch', formatted_address: '12 Main St', loading: false, photos: [PHOTO, `${PHOTO}&n=2`] },
      venueDetailPhotoIdx: 0,
      venueDetailPromos: [],
      venueDetailEvents: EVENTS.slice(0, 2),
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
      crowdData: null,
    }, over);
  };

  test('the sheet takes the list as a prop', () => {
    expect(PARAMS).toContain('venueDetailEvents');
  });

  test('the card shows its events over the photo the top of the card is showing, and reports them as venue events', () => {
    const p = props();
    render(React.createElement(VenueDetailSheet, p));
    const section = screen.getByRole('heading', { name: /Happening here/ }).closest('section');
    const imgs = section.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0].getAttribute('src')).toBe(PHOTO);
    fireEvent.click(within(section).getByRole('button', { name: 'Report Live jazz' }));
    expect(p.setModerationTarget).toHaveBeenCalledWith({ userName: 'this venue', contentType: 'venue_event', contentId: 31 });
  });

  test('a card with only a seed photo uses that one', () => {
    render(React.createElement(VenueDetailSheet, props({
      venueDetailModal: { place_id: 'ChIJcopperFinch01', name: 'The Copper Finch', loading: false, photos: [], photo_url: `${PHOTO}&seed=1` },
    })));
    const section = screen.getByRole('heading', { name: /Happening here/ }).closest('section');
    expect(section.querySelector('img').getAttribute('src')).toBe(`${PHOTO}&seed=1`);
  });

  test('a venue with no events looks exactly as it did', () => {
    render(React.createElement(VenueDetailSheet, props({ venueDetailEvents: [] })));
    expect(screen.queryByText(/Happening here/)).toBeNull();
  });
});

describe('App.js loads, retracts and hands over the list', () => {
  test('the call is the public events read for that place', () => {
    expect(API).toContain('export async function getPublicEvents(placeId) {');
    expect(API).toContain('`/api/venue-dashboard/public-events/${encodeURIComponent(placeId)}`');
  });

  test('the card\'s effect loads it, empties it first, and drops an answer for a card that moved on', () => {
    const effect = APP.slice(APP.indexOf('let eventsFor = true;'), APP.indexOf('}, [venueDetailPlaceId, loadVenueDetailReviews]);'));
    expect(effect).toContain('setVenueDetailEvents([]);');
    expect(effect).toContain('getPublicEvents(venueDetailPlaceId)');
    expect(effect).toContain('if (eventsFor) setVenueDetailEvents(');
    expect(effect).toContain('eventsFor = false;');
    // And a closed card clears it.
    expect(APP).toMatch(/if \(!venueDetailPlaceId\) \{[^\n]*setVenueDetailEvents\(\[\]\);/);
  });

  test('a moderator\'s takedown and the reader\'s own report both drop it live', () => {
    const branch = APP.slice(APP.indexOf("        case 'venue_event':"), APP.indexOf("        case 'venue_review':"));
    expect(branch).toContain('if (hidden) setVenueDetailEvents(prev => dropContentById(prev, ev.contentId));');
    expect(APP).toContain("if (ev.contentType === 'venue_event') setVenueDetailEvents(prev => dropContentById(prev, ev.contentId));");
  });

  test('the sheet is handed the list', () => {
    expect(APP).toContain('venueDetailEvents={venueDetailEvents}');
    expect(SHEET).toContain('events={venueDetailEvents}');
    expect(SHEET).toContain("photoUrl={(venueDetailModal.photos && venueDetailModal.photos[0]) || venueDetailModal.photo_url || null}");
  });
});
