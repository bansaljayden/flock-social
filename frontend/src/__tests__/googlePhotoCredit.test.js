/**
 * GOOGLE'S CREDITS ON GOOGLE'S PHOTOS AND DATA (2026-10-21).
 *
 * Google's Places policies require the author's name and profile link with
 * every photo shown, a way to see the photo on Google Maps, and the "Google
 * Maps" attribution on any container that shows Places data off a Google map.
 * The app drew none of them. This file pins the client half; the server half
 * (the credit beside each photo URL) is backend placePhotoCredit.test.js.
 *
 *   - components/ui/GoogleCredit.js draws a credit only from Google links over
 *     https, and the mark to Google's spec;
 *   - the venue sheet credits the photo on screen and carries the mark;
 *   - each Happening-here card credits the photo it is drawn over, and a card
 *     on the drawn art or over a failed photo credits nobody;
 *   - the lists and cards that show Places data carry the mark.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=googlePhotoCredit
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

const {
  GoogleMapsMark, PhotoCredit, googleLink, usableCredit, creditAt,
} = require('../components/ui/GoogleCredit');
const VenueEventsSection = require('../components/overlays/VenueEventsSection').default;
const { eventPhotoIndex, eventPhoto } = require('../components/overlays/VenueEventsSection');
const VenueDetailSheet = require('../components/overlays/VenueDetailSheet').default;

const SRC = path.resolve(__dirname, '..');
const readSrc = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

const colors = { navy: '#0d2847', navyBg: '#0d2847', steel: '#2d5a87', amber: '#F5B942', cream: '#f1ede0' };
const PHOTO_A = 'https://api.test/api/venues/photo?ref=A&maxwidth=600';
const PHOTO_B = 'https://api.test/api/venues/photo?ref=B&maxwidth=600';
const CREDIT_A = { name: 'Dana Reyes', uri: 'https://maps.google.com/maps/contrib/111', maps_uri: 'https://www.google.com/maps/place//data=A' };
const CREDIT_B = { name: 'Lee Park', uri: 'https://maps.google.com/maps/contrib/222', maps_uri: 'https://www.google.com/maps/place//data=B' };

describe('the credit helpers', () => {
  test('only Google links over https count', () => {
    expect(googleLink('https://maps.google.com/maps/contrib/1')).toBe('https://maps.google.com/maps/contrib/1');
    expect(googleLink('https://goo.gl/maps/x')).toBe('https://goo.gl/maps/x');
    for (const bad of ['http://maps.google.com/x', 'javascript:alert(1)', 'https://evil.example/x', 'https://google.com.evil.example/x', 'https://u:p@www.google.com/x', '', null, 7]) {
      expect(googleLink(bad)).toBeNull();
    }
  });

  test('a credit needs a name or the photo\'s page; a profile link never stands alone', () => {
    expect(usableCredit(null)).toBeNull();
    expect(usableCredit({ name: ' ', uri: 'https://maps.google.com/maps/contrib/1' })).toBeNull();
    expect(usableCredit({ name: 'Dana', uri: 'https://evil.example/x' })).toEqual({ name: 'Dana', uri: null, maps_uri: null });
    expect(creditAt([CREDIT_A, null], 1)).toBeNull();
    expect(creditAt(undefined, 0)).toBeNull();
    expect(creditAt([CREDIT_A], 0)).toEqual(CREDIT_A);
  });
});

describe('what the credit and the mark look like', () => {
  test('the photo credit names the author, links the profile, and opens the photo on Google Maps', () => {
    render(React.createElement(PhotoCredit, { credit: CREDIT_A }));
    const credit = screen.getByTestId('photo-credit');
    expect(credit.textContent).toMatch(/^Photo: Dana Reyes/);
    const profile = within(credit).getByRole('link', { name: 'Dana Reyes' });
    expect(profile.getAttribute('href')).toBe(CREDIT_A.uri);
    expect(profile.getAttribute('target')).toBe('_blank');
    expect(profile.getAttribute('rel')).toBe('noopener noreferrer');
    const onMaps = within(credit).getByRole('link', { name: 'See this photo on Google Maps' });
    expect(onMaps.getAttribute('href')).toBe(CREDIT_A.maps_uri);
    expect(onMaps.getAttribute('rel')).toBe('noopener noreferrer');
  });

  test('no credit, or nothing usable in it, draws nothing', () => {
    for (const credit of [null, undefined, {}, { name: '', maps_uri: 'https://evil.example/x' }]) {
      const { container, unmount } = render(React.createElement(PhotoCredit, { credit }));
      expect(container.innerHTML).toBe('');
      unmount();
    }
  });

  test('a link that is not Google\'s is not drawn as a link', () => {
    render(React.createElement(PhotoCredit, { credit: { name: 'Dana Reyes', uri: 'https://evil.example/u', maps_uri: null } }));
    expect(screen.getByTestId('photo-credit').textContent).toBe('Photo: Dana Reyes');
    expect(screen.queryByRole('link')).toBeNull();
  });

  test('the mark is the words Google Maps, to Google\'s text spec', () => {
    const { rerender } = render(React.createElement(GoogleMapsMark, { dark: true }));
    const mark = screen.getByTestId('google-maps-attribution');
    expect(mark.textContent).toBe('Google Maps');
    expect(mark.getAttribute('translate')).toBe('no');
    expect(mark.style.fontSize).toBe('12px');
    expect(String(mark.style.fontWeight)).toBe('400');
    expect(mark.style.whiteSpace).toBe('nowrap');
    expect(mark.style.letterSpacing).toBe('normal');
    expect(mark.style.color.toUpperCase().replace(/\s/g, '')).toMatch(/#FFFFFF|RGB\(255,255,255\)/);
    rerender(React.createElement(GoogleMapsMark, { dark: false }));
    expect(screen.getByTestId('google-maps-attribution').style.color.toUpperCase().replace(/\s/g, '')).toMatch(/#5E5E5E|RGB\(94,94,94\)/);
    // Left to the theme, it reads the theme's token, which index.css sets to
    // the two colours Google allows. jsdom drops a var() colour, so this half
    // reads the source.
    expect(readSrc('components', 'ui', 'GoogleCredit.js')).toMatch(/'var\(--google-maps-attribution, #5E5E5E\)'/);
    const css = readSrc('index.css');
    expect(css).toMatch(/--google-maps-attribution:\s*#5E5E5E/);
    expect(css).toMatch(/\[data-theme="dark"\][\s\S]*--google-maps-attribution:\s*#FFFFFF/);
  });
});

describe('each Happening-here card credits its own photo', () => {
  const EVENTS = [
    { id: 41, title: 'Trivia Night', event_date: null, event_time: null },
    { id: 42, title: 'Live acoustic set', event_date: null, event_time: null },
  ];
  const mount = (over = {}) => render(React.createElement(VenueEventsSection, {
    events: EVENTS, photos: [PHOTO_A, PHOTO_B], credits: [CREDIT_A, CREDIT_B], colors, onReport: jest.fn(), ...over,
  }));

  test('the index helper and the URL helper agree', () => {
    expect(eventPhotoIndex([PHOTO_A, PHOTO_B], 0)).toBe(1);
    expect(eventPhotoIndex([PHOTO_A, PHOTO_B], 1)).toBe(0);
    expect(eventPhotoIndex(['', PHOTO_B], 0)).toBe(1);
    expect(eventPhotoIndex([], 0)).toBe(-1);
    expect(eventPhoto([PHOTO_A, PHOTO_B], 0)).toBe(PHOTO_B);
  });

  test('card i is over photo (i + 1) mod n and names whoever took that photo', () => {
    mount();
    const rows = screen.getAllByRole('listitem');
    expect(rows[0].querySelector('img').getAttribute('src')).toBe(PHOTO_B);
    expect(within(rows[0]).getByTestId('photo-credit').textContent).toMatch(/Lee Park/);
    expect(rows[1].querySelector('img').getAttribute('src')).toBe(PHOTO_A);
    expect(within(rows[1]).getByTestId('photo-credit').textContent).toMatch(/Dana Reyes/);
  });

  test('a card on the drawn art credits nobody', () => {
    mount({ photos: [], credits: [] });
    expect(screen.getAllByTestId('venue-event-art')).toHaveLength(2);
    expect(screen.queryByTestId('photo-credit')).toBeNull();
  });

  test('a photo that fails takes its credit with it', () => {
    mount();
    const rows = screen.getAllByRole('listitem');
    fireEvent.error(rows[0].querySelector('img'));
    const after = screen.getAllByRole('listitem');
    expect(within(after[0]).queryByTestId('photo-credit')).toBeNull();
    expect(within(after[1]).getByTestId('photo-credit').textContent).toMatch(/Dana Reyes/);
  });

  test('a photo Google sent no credit for draws none, and missing credits do not crash', () => {
    mount({ credits: [CREDIT_A, null] });
    expect(within(screen.getAllByRole('listitem')[0]).queryByTestId('photo-credit')).toBeNull();
    const { unmount } = mount({ credits: undefined });
    unmount();
  });
});

describe('the venue sheet', () => {
  const SHEET = readSrc('components', 'overlays', 'VenueDetailSheet.js');
  const PARAM_SRC = SHEET.slice(SHEET.indexOf('const VenueDetailSheet = ({'), SHEET.indexOf('}) => {', SHEET.indexOf('const VenueDetailSheet = ({')));
  const PARAMS = [...PARAM_SRC.matchAll(/^\s+([A-Za-z]+),/gm)].map((m) => m[1]);
  const props = (over = {}) => {
    const p = {};
    for (const name of PARAMS) p[name] = jest.fn();
    return Object.assign(p, {
      DialogBehavior: () => null,
      SearchInputLocal: () => null,
      httpUrl: (u) => (typeof u === 'string' && /^https?:/.test(u) ? u : null),
      colors,
      venueDetailModal: {
        place_id: 'ChIJcopperFinch01', name: 'The Copper Finch', formatted_address: '214 Main St', loading: false,
        photos: [PHOTO_A, PHOTO_B], photo_attributions: [CREDIT_A, CREDIT_B],
      },
      venueDetailPhotoIdx: 0,
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
      crowdData: null,
    }, over);
  };

  test('the header photo carries its own credit, and the next photo carries the next one', () => {
    const p = props();
    const { rerender } = render(React.createElement(VenueDetailSheet, p));
    expect(screen.getByTestId('photo-credit').textContent).toMatch(/Dana Reyes/);
    rerender(React.createElement(VenueDetailSheet, { ...p, venueDetailPhotoIdx: 1 }));
    expect(screen.getByTestId('photo-credit').textContent).toMatch(/Lee Park/);
  });

  test('the card carries the Google Maps mark, while loading too', () => {
    render(React.createElement(VenueDetailSheet, props()));
    expect(screen.getByTestId('google-maps-attribution').textContent).toBe('Google Maps');
    const { unmount } = render(React.createElement(VenueDetailSheet, props({ venueDetailModal: { place_id: 'ChIJcopperFinch01', name: 'The Copper Finch', loading: true, photo_url: PHOTO_A, photo_attribution: CREDIT_A } })));
    expect(screen.getAllByTestId('google-maps-attribution').length).toBeGreaterThanOrEqual(2);
    unmount();
  });

  test('a seed photo is credited from the seed\'s own credit', () => {
    render(React.createElement(VenueDetailSheet, props({
      venueDetailModal: { place_id: 'ChIJcopperFinch01', name: 'The Copper Finch', loading: false, photos: [], photo_url: PHOTO_B, photo_attribution: CREDIT_B },
    })));
    expect(screen.getByTestId('photo-credit').textContent).toMatch(/Lee Park/);
  });

  test('no Google photo, no photo credit: the mark still says where the facts came from', () => {
    render(React.createElement(VenueDetailSheet, props({
      venueDetailModal: { place_id: 'ChIJcopperFinch01', name: 'The Copper Finch', loading: false, photos: [], photo_url: null },
    })));
    expect(screen.queryByTestId('photo-credit')).toBeNull();
    expect(screen.getByTestId('google-maps-attribution')).toBeTruthy();
  });

  test('a header photo that fails becomes the bird, and the credit goes with it', () => {
    const { container } = render(React.createElement(VenueDetailSheet, props()));
    const header = container.querySelector(`img[src="${PHOTO_A}"]`);
    fireEvent.error(header);
    expect(screen.queryByTestId('photo-credit')).toBeNull();
  });
});

describe('the credits travel with the photos', () => {
  const APP = readSrc('App.js');

  test('a pin and a search row keep their photo\'s credit', () => {
    expect(APP).toMatch(/photo_url: v\.photo_url \|\| null,[\s\S]{0,300}photo_attribution: v\.photo_attribution \|\| null/);
  });

  test('opening the sheet takes each credit from the object its photo came from', () => {
    const open = APP.slice(APP.indexOf('const openVenueDetail = useCallback'), APP.indexOf('setCrowdData(crowd ?', APP.indexOf('const openVenueDetail = useCallback')));
    expect(open).toMatch(/photo_attribution: venue\.photo_url\s*\?\s*\(venue\.photo_attribution \|\| null\)\s*:\s*\(\(fallbackData && fallbackData\.photo_attribution\) \|\| null\)/);
    expect(open).toMatch(/photo_attributions: detailPhotos\s*\?\s*\(venue\.photo_attributions \|\| \[\]\)\s*:\s*\(\(fallbackData && fallbackData\.photo_attributions\) \|\| \[\]\)/);
  });

  test('every seed that hands the sheet a photo hands it the credit too', () => {
    for (const rel of [
      ['components', 'SearchResultsOverlay.js'],
      ['screens', 'ExploreScreen.js'],
      ['components', 'venue', 'ConsumerVenueCard.js'],
      ['components', 'map', 'MapLibreMapView.js'],
    ]) {
      const src = readSrc(...rel);
      const seeds = [...src.matchAll(/openVenueDetail\([^;]*photo_url: (?!null)[^;]*\)/g)].map((m) => m[0]);
      expect(seeds.length).toBeGreaterThan(0);
      for (const seed of seeds) expect(`${rel.join('/')}: ${/photo_attribution/.test(seed)}`).toBe(`${rel.join('/')}: true`);
    }
  });
});

describe('every container of Places data off a Google map carries the mark', () => {
  test.each([
    [['components', 'overlays', 'VenueDetailSheet.js']],
    [['components', 'SearchResultsOverlay.js']],
    [['screens', 'ExploreScreen.js']],
    [['components', 'venue', 'ConsumerVenueCard.js']],
    [['components', 'birdie', 'BirdiePanel.js']],
    [['website', 'LiveDemo.js']],
  ])('%j', (rel) => {
    expect(readSrc(...rel)).toMatch(/<GoogleMapsMark\b/);
  });

  test('the website demo credits its photo, and not the placeholder', () => {
    const demo = readSrc('website', 'LiveDemo.js');
    expect(demo).toMatch(/\{!photoFailed && \(\s*<PhotoCredit credit=\{selected\.photo_attribution\}/);
  });
});
