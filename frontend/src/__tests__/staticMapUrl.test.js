// ---------------------------------------------------------------------------
// STATIC MAP PREVIEWS OF A VENUE.
//
// lib/staticMapUrl.js builds a MapTiler Static Maps URL for one venue and
// components/map/StaticVenueMap.js draws it on a plan's venue card and in the
// venue sheet when there is no photo. What these tests hold:
//
//   THE URL IS DETERMINISTIC. Rounded coordinates, a fixed set of sizes, and
//   a memo, so the same card on the same device is one URL, which the device
//   cache serves after the first time. Every image is 15 requests of the
//   monthly pool.
//
//   NO KEY, NO MAP, AND NO BAD COORDINATE. Contributor and e2e builds have no
//   key; a venue with no position must not become a map of 0,0.
//
//   THE CREDIT IS ALWAYS DRAWN. The image is requested with attribution=false,
//   so the visible line is the licence condition. A render with the picture
//   and no credit fails here.
//
//   THE PIN IS OUR OWN ART, small, with explicit width and height, which is
//   what the API requires of a custom marker.
//
//   THE SCREENS USE IT WHERE THE PLAN SAYS: the plan card always when it has
//   coordinates (under the address with a photo, in its place without), and
//   the venue sheet only when there is no photo.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test staticMapUrl --watchAll=false
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, cleanup } = require('@testing-library/react');

jest.mock('../components/ui/MapsChooser', () => ({
  __esModule: true,
  default: () => null,
  openMapsChooser: jest.fn(() => true),
  closeMapsChooser: jest.fn(),
}));
jest.mock('../services/api', () => ({
  __esModule: true,
  submitVenueFeedback: jest.fn(),
  submitVenueReview: jest.fn(),
  getPublicReviews: jest.fn(() => Promise.resolve({ reviews: [] })),
}));

const {
  venueStaticMapUrl, STATIC_MAP_IDS, STATIC_PIN_URLS, STATIC_MAP_BUCKETS, STATIC_MAP_CREDIT, STATIC_MAP_MAX_URL,
} = require('../lib/staticMapUrl');
const StaticVenueMapModule = require('../components/map/StaticVenueMap');
const { openMapsChooser } = require('../components/ui/MapsChooser');
const FlockDetail = require('../screens/FlockDetail').default;
const VenueDetailSheet = require('../components/overlays/VenueDetailSheet').default;

const StaticVenueMap = StaticVenueMapModule.default;
const { paletteIsDark } = StaticVenueMapModule;

const SRC = path.resolve(__dirname, '..');
const readSrc = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

const KEY = 'test-maptiler-key';
const AT = { lat: 40.611234567, lng: -75.374612345 };

beforeEach(() => {
  process.env.REACT_APP_MAPTILER_KEY = KEY;
  openMapsChooser.mockClear();
});
afterEach(() => {
  cleanup();
  delete process.env.REACT_APP_MAPTILER_KEY;
});

const parse = (url) => new URL(url);

describe('the URL', () => {
  test('centres on the venue, longitude first, rounded to 5 decimals, at the bucket size and @2x', () => {
    const url = venueStaticMapUrl({ ...AT, size: 'strip' });
    const u = parse(url);
    expect(u.origin).toBe('https://api.maptiler.com');
    expect(u.pathname).toBe('/maps/streets-v4/static/-75.37461,40.61123,16/375x140@2x.webp');
    expect(u.searchParams.get('key')).toBe(KEY);
  });

  test('the three sizes are fixed and an unknown one draws nothing', () => {
    expect(Object.keys(STATIC_MAP_BUCKETS)).toEqual(['strip', 'sheet', 'thumb']);
    expect(parse(venueStaticMapUrl({ ...AT, size: 'sheet' })).pathname).toMatch(/\/430x220@2x\.webp$/);
    expect(parse(venueStaticMapUrl({ ...AT, size: 'thumb' })).pathname).toMatch(/,15\/88x88@2x\.webp$/);
    expect(venueStaticMapUrl({ ...AT, size: 'poster' })).toBeNull();
    // An own-property lookup: a prototype name is not a size.
    expect(venueStaticMapUrl({ ...AT, size: 'constructor' })).toBeNull();
  });

  test('the theme picks the map and the pin', () => {
    const light = parse(venueStaticMapUrl({ ...AT, dark: false }));
    const dark = parse(venueStaticMapUrl({ ...AT, dark: true }));
    expect(light.pathname.startsWith(`/maps/${STATIC_MAP_IDS.light}/`)).toBe(true);
    expect(dark.pathname.startsWith(`/maps/${STATIC_MAP_IDS.dark}/`)).toBe(true);
    expect(STATIC_MAP_IDS).toEqual({ light: 'streets-v4', dark: 'streets-v4-dark' });
    expect(light.searchParams.get('markers')).toBe(`icon:${STATIC_PIN_URLS.light}|anchor:bottom|scale:2|-75.37461,40.61123`);
    expect(dark.searchParams.get('markers')).toBe(`icon:${STATIC_PIN_URLS.dark}|anchor:bottom|scale:2|-75.37461,40.61123`);
    expect(STATIC_PIN_URLS.light).toBe('https://www.flockcorp.com/map/pin-light.svg');
    expect(STATIC_PIN_URLS.dark).toBe('https://www.flockcorp.com/map/pin-dark.svg');
  });

  test('the credit is never baked into the image, so the component has to draw it', () => {
    for (const size of Object.keys(STATIC_MAP_BUCKETS)) {
      for (const dark of [false, true]) {
        expect(parse(venueStaticMapUrl({ ...AT, size, dark })).searchParams.get('attribution')).toBe('false');
      }
    }
  });

  test('with no key there is no map', () => {
    delete process.env.REACT_APP_MAPTILER_KEY;
    expect(venueStaticMapUrl(AT)).toBeNull();
    process.env.REACT_APP_MAPTILER_KEY = '';
    expect(venueStaticMapUrl(AT)).toBeNull();
  });

  test('a missing or impossible coordinate is no map, never a map of 0,0', () => {
    for (const bad of [null, undefined, '', '  ', 'abc', NaN, Infinity, -Infinity, true, {}, []]) {
      expect(venueStaticMapUrl({ lat: bad, lng: AT.lng })).toBeNull();
      expect(venueStaticMapUrl({ lat: AT.lat, lng: bad })).toBeNull();
    }
    expect(venueStaticMapUrl({ lat: 86, lng: 0 })).toBeNull();
    expect(venueStaticMapUrl({ lat: 0, lng: 181 })).toBeNull();
    expect(venueStaticMapUrl()).toBeNull();
    // A numeric string is a coordinate; the API sometimes sends them that way.
    expect(venueStaticMapUrl({ lat: '40.6112', lng: '-75.3746' })).toContain('/static/-75.37460,40.61120,16/');
  });

  test('the same venue, size and theme is the identical string, so a re-render never asks again', () => {
    const a = venueStaticMapUrl({ ...AT, size: 'strip', dark: true });
    const b = venueStaticMapUrl({ lat: AT.lat, lng: AT.lng, size: 'strip', dark: true });
    expect(b).toBe(a);
    // Rounding is what makes the cache hit: a difference past the fifth
    // decimal is the same picture and the same URL.
    expect(venueStaticMapUrl({ lat: 40.6112340001, lng: -75.3746119999, size: 'strip', dark: true })).toBe(a);
    expect(venueStaticMapUrl({ ...AT, size: 'strip', dark: false })).not.toBe(a);
  });

  test('stays far under the API limit', () => {
    const url = venueStaticMapUrl({ lat: -85.05, lng: -179.99999, size: 'sheet', dark: true });
    expect(url.length).toBeLessThan(STATIC_MAP_MAX_URL);
    expect(STATIC_MAP_MAX_URL).toBe(8192);
  });

  test('the key appears only as the key= value', () => {
    const url = venueStaticMapUrl({ ...AT, dark: true });
    expect(url.split(KEY)).toHaveLength(2);
    expect(url).toContain(`?key=${KEY}&`);
  });
});

describe('the pin icons', () => {
  for (const theme of ['light', 'dark']) {
    test(`pin-${theme}.svg is small, sized and self-contained`, () => {
      const file = path.resolve(SRC, '..', 'public', 'map', `pin-${theme}.svg`);
      const bytes = fs.statSync(file).size;
      expect(bytes).toBeLessThan(64 * 1024);
      const svg = fs.readFileSync(file, 'utf8');
      // The API requires explicit width and height on an SVG marker.
      expect(svg).toMatch(/<svg [^>]*\bwidth="\d+"/);
      expect(svg).toMatch(/<svg [^>]*\bheight="\d+"/);
      // Drawn art only: no embedded or linked raster, no text that would
      // depend on a font the renderer may not have.
      expect(svg).not.toMatch(/<image|href=|<text|<filter|base64/i);
    });
  }
});

describe('paletteIsDark reads the theme off the palette a screen already holds', () => {
  test('the two palettes App.js builds answer correctly', () => {
    const app = readSrc('App.js');
    const creamOf = (name) => {
      const block = app.slice(app.indexOf(`const ${name} = {`), app.indexOf('};', app.indexOf(`const ${name} = {`)));
      return /cream: '(#[0-9a-fA-F]{6})'/.exec(block)[1];
    };
    expect(paletteIsDark({ cream: creamOf('colorsLight') })).toBe(false);
    expect(paletteIsDark({ cream: creamOf('colorsDark') })).toBe(true);
  });

  test('anything it cannot read is light', () => {
    expect(paletteIsDark({})).toBe(false);
    expect(paletteIsDark(undefined)).toBe(false);
    expect(paletteIsDark({ cream: 'navy' })).toBe(false);
  });
});

describe('StaticVenueMap', () => {
  test('a lazy image in a fixed box, with the credit beside it', () => {
    const { container } = render(<StaticVenueMap {...AT} name="Lucky's" size="strip" />);
    const img = container.querySelector('img');
    expect(img.getAttribute('src')).toBe(venueStaticMapUrl({ ...AT, size: 'strip' }));
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
    expect(img.getAttribute('width')).toBe('375');
    expect(img.getAttribute('height')).toBe('140');
    expect(img.getAttribute('alt')).toBe("Map of the streets around Lucky's");
    expect(container.firstChild.style.height).toBe('140px');
    expect(screen.getByText(STATIC_MAP_CREDIT)).toBeTruthy();
    expect(STATIC_MAP_CREDIT).toBe('© MapTiler © OpenStreetMap contributors');
  });

  test('every image it draws is attribution=false and every one has the credit at the 12px floor', () => {
    for (const size of Object.keys(STATIC_MAP_BUCKETS)) {
      for (const dark of [false, true]) {
        const { container, unmount } = render(<StaticVenueMap {...AT} name="X" size={size} dark={dark} />);
        const imgs = container.querySelectorAll('img');
        const credits = container.querySelectorAll('[data-map-credit]');
        expect(imgs).toHaveLength(1);
        expect(parse(imgs[0].getAttribute('src')).searchParams.get('attribution')).toBe('false');
        expect(credits).toHaveLength(1);
        expect(credits[0].textContent).toBe(STATIC_MAP_CREDIT);
        expect(parseFloat(credits[0].style.fontSize)).toBeGreaterThanOrEqual(12);
        expect(credits[0].style.whiteSpace).not.toBe('nowrap');
        unmount();
      }
    }
  });

  test('with onOpen it is one button that names the place, and a tap calls it', () => {
    const onOpen = jest.fn();
    render(<StaticVenueMap {...AT} name="Lucky's" onOpen={onOpen} />);
    const button = screen.getByRole('button', { name: "Map of Lucky's. Open it in a maps app" });
    expect(button.querySelector('img').getAttribute('alt')).toBe('');
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test('no key or no coordinates draws the fallback, and so does an image that fails', () => {
    const fallback = <p>plain box</p>;
    delete process.env.REACT_APP_MAPTILER_KEY;
    const first = render(<StaticVenueMap {...AT} fallback={fallback} />);
    expect(first.container.querySelector('img')).toBeNull();
    expect(screen.getByText('plain box')).toBeTruthy();
    first.unmount();

    process.env.REACT_APP_MAPTILER_KEY = KEY;
    const none = render(<StaticVenueMap lat={null} lng={null} />);
    expect(none.container.innerHTML).toBe('');
    none.unmount();

    const { container } = render(<StaticVenueMap {...AT} fallback={fallback} />);
    fireEvent.error(container.querySelector('img'));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-map-credit]')).toBeNull();
    expect(screen.getByText('plain box')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The two screens, rendered for real from their own parameter lists, the way
// endedPlanAsks.test.js renders the plan screen.
// ---------------------------------------------------------------------------
const paramsOf = (src, start, end) => {
  const from = src.indexOf(start);
  const to = src.indexOf(end, from);
  return src.slice(from, to)
    .split('\n')
    .slice(1)
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    .flatMap((l) => l.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
};

describe("a plan's venue card", () => {
  const PARAMS = paramsOf(readSrc('screens', 'FlockDetail.js'), 'export default function FlockDetail({', '}) {');
  const plan = (extra = {}) => ({
    id: 41,
    name: 'Friday',
    host: 'Ava',
    creatorId: 9,
    status: 'voting',
    venue: "Lucky's",
    venueId: 'ChIJlucky0001',
    venueAddress: '125 E 3rd St',
    venueLat: AT.lat,
    venueLng: AT.lng,
    members: [{ id: 9, name: 'Ava', status: 'accepted' }],
    guests: [],
    votes: [],
    ...extra,
  });
  const props = (flock, over = {}) => {
    const p = {};
    for (const name of PARAMS) p[name] = jest.fn();
    return Object.assign(p, {
      DialogBehavior: () => null,
      MissingFlockPanel: () => null,
      MOMENTUM_STAGES: [],
      authUser: { id: 9 },
      checkinSaving: false,
      colors: {},
      crowdPredictions: {},
      feedbackState: { crowdLevel: null, priceWorth: null, rating: null },
      feedbackSubmitting: false,
      getSelectedFlock: () => flock,
      recapSharing: false,
      rerunningFlockId: null,
      rosterError: null,
      showTimeEditor: false,
      slideFillRef: { current: null },
      slidePctRef: { current: 0 },
      slideRef: { current: null },
      slideStage: 'idle',
      slideThumbRef: { current: null },
      slidingRef: { current: false },
      styles: { card: {} },
      submittedFeedback: new Set(),
      timeEditDay: 'Tonight',
      timeEditHour: '9 PM',
      voteTotal: () => 0,
    }, over);
  };

  test('the parameter list was read', () => {
    expect(PARAMS).toContain('colors');
    expect(PARAMS.length).toBeGreaterThan(50);
  });

  test('with no photo the map takes the photo place, and a tap opens the maps chooser like Directions does', () => {
    const { container } = render(React.createElement(FlockDetail, props(plan())));
    const map = screen.getByRole('button', { name: "Map of Lucky's. Open it in a maps app" });
    // Full width at the top of the card: the first thing in it.
    expect(map.parentElement.firstChild).toBe(map);
    expect(screen.getByText(STATIC_MAP_CREDIT)).toBeTruthy();
    fireEvent.click(map);
    fireEvent.click(screen.getByRole('button', { name: /Directions/ }));
    expect(openMapsChooser).toHaveBeenCalledTimes(2);
    expect(openMapsChooser.mock.calls[0]).toEqual(openMapsChooser.mock.calls[1]);
    expect(openMapsChooser.mock.calls[0][0].place).toEqual({ name: "Lucky's", address: '125 E 3rd St', lat: AT.lat, lng: AT.lng });
    expect(container.querySelectorAll('[data-static-map]')).toHaveLength(1);
  });

  test('with a photo the photo stays on top and the map sits under the address', () => {
    const { container } = render(React.createElement(FlockDetail, props(plan({ venuePhoto: 'https://api.test/photo?ref=1' }))));
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs[0].getAttribute('src')).toBe('https://api.test/photo?ref=1');
    const map = container.querySelector('[data-static-map]');
    expect(map).toBeTruthy();
    const address = screen.getByText('125 E 3rd St');
    // eslint-disable-next-line no-bitwise
    expect(address.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('the map follows the theme in the palette the screen is handed', () => {
    const { container } = render(React.createElement(FlockDetail, props(plan(), { colors: { cream: '#0f172a' } })));
    expect(container.querySelector('[data-static-map] img').getAttribute('src')).toContain(`/maps/${STATIC_MAP_IDS.dark}/`);
  });

  test('no coordinates, or no key, and the card is what it was', () => {
    const first = render(React.createElement(FlockDetail, props(plan({ venueLat: null, venueLng: null }))));
    expect(first.container.querySelector('[data-static-map]')).toBeNull();
    first.unmount();
    delete process.env.REACT_APP_MAPTILER_KEY;
    const { container } = render(React.createElement(FlockDetail, props(plan())));
    expect(container.querySelector('[data-static-map]')).toBeNull();
  });
});

describe('the venue sheet header', () => {
  const PARAMS = paramsOf(readSrc('components', 'overlays', 'VenueDetailSheet.js'), 'const VenueDetailSheet = ({', '}) => {');
  const props = (venue) => {
    const p = {};
    for (const name of PARAMS) p[name] = jest.fn();
    return Object.assign(p, {
      DialogBehavior: () => null,
      SearchInputLocal: () => null,
      httpUrl: (u) => (typeof u === 'string' && /^https?:/.test(u) ? u : null),
      colors: {},
      venueDetailModal: { place_id: 'ChIJlucky0001', name: "Lucky's", formatted_address: '125 E 3rd St', loading: true, ...venue },
      venueDetailPhotoIdx: 0,
      venueDetailPromos: [],
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
    });
  };

  test('the parameter list was read', () => {
    expect(PARAMS).toContain('venueDetailModal');
    expect(PARAMS).toContain('colors');
  });

  test('no photo and a position: the block it is on, credited, and a tap opens the chooser', () => {
    const { container } = render(React.createElement(VenueDetailSheet, props({ lat: AT.lat, lng: AT.lng })));
    const img = container.querySelector('[data-static-map="sheet"] img');
    expect(img.getAttribute('src')).toBe(venueStaticMapUrl({ ...AT, size: 'sheet' }));
    expect(screen.getByText(STATIC_MAP_CREDIT)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: "Map of Lucky's. Open it in a maps app" }));
    expect(openMapsChooser).toHaveBeenCalledTimes(1);
    expect(openMapsChooser.mock.calls[0][0].place).toMatchObject({ lat: AT.lat, lng: AT.lng });
  });

  test('Place Details coordinates are the ones the map uses once they arrive', () => {
    const { container } = render(React.createElement(VenueDetailSheet, props({ location: { latitude: 40.7, longitude: -74.0 } })));
    expect(container.querySelector('[data-static-map] img').getAttribute('src')).toContain('/static/-74.00000,40.70000,16/');
  });

  test('a photo beats a map', () => {
    const { container } = render(React.createElement(VenueDetailSheet, props({ ...AT, photo_url: 'https://api.test/photo?ref=2' })));
    expect(container.querySelector('[data-static-map]')).toBeNull();
  });

  test('no position, or a failed image, is the plain box it always was', () => {
    const first = render(React.createElement(VenueDetailSheet, props({})));
    expect(first.container.querySelector('[data-static-map]')).toBeNull();
    // (The sheet has a bird further down, so look for the map by its host.)
    expect(first.container.querySelector('img[src*="api.maptiler.com"]')).toBeNull();
    first.unmount();
    const { container } = render(React.createElement(VenueDetailSheet, props({ ...AT })));
    fireEvent.error(container.querySelector('[data-static-map] img'));
    expect(container.querySelector('[data-static-map]')).toBeNull();
    expect(container.querySelector('img[src*="api.maptiler.com"]')).toBeNull();
    expect(container.querySelector('[data-map-credit]')).toBeNull();
  });

  test('a card with no place id and no Google url offers no broken Google link', () => {
    const p = props({ ...AT, place_id: undefined });
    render(React.createElement(VenueDetailSheet, p));
    fireEvent.click(screen.getByRole('button', { name: "Map of Lucky's. Open it in a maps app" }));
    expect(openMapsChooser.mock.calls[0][0].googleUrl).toBeNull();
  });
});
