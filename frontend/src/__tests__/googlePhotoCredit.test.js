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
 *   - the venue sheet credits the photo on screen and carries the mark, and
 *     draws a seed photo only with its credit (2026-11-06);
 *   - each Happening-here card credits the photo it is drawn over, and a card
 *     on the drawn art or over a failed photo credits nobody;
 *   - the plan screen's venue photo is a 72px thumbnail beside the venue's
 *     name, drawn at once as a button to the venue sheet, under a map that
 *     heads the card; with no place id there is no photo (2026-11-06);
 *   - every thumbnail reaches the credited sheet: chat and DM venue cards,
 *     the pinned venue, the Create screen's pick, and a vote or share row's
 *     photo through a button of its own (ThumbToSheet);
 *   - the lists, cards, strips and the map that show Places data carry the
 *     mark, and every Places photo drawn large carries its credit.
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
  submitVenueFeedback: jest.fn(),
}));

const {
  GoogleMapsMark, PhotoCredit, ThumbToSheet, googleLink, usableCredit, creditAt, isPlacesPhotoUrl,
} = require('../components/ui/GoogleCredit');
const VenueEventsSection = require('../components/overlays/VenueEventsSection').default;
const { eventPhotoIndex, eventPhoto } = require('../components/overlays/VenueEventsSection');
const VenueDetailSheet = require('../components/overlays/VenueDetailSheet').default;
const VenueCardRow = require('../components/chat/cards/VenueCardRow').default;
const PinStrip = require('../components/chat/sheets/PinStrip').default;
const PollCard = require('../components/chat/cards/PollCard').default;
const FlockDetail = require('../screens/FlockDetail').default;

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

  test('a Places photo is one the photo proxy serves; an event\'s own image is not', () => {
    expect(isPlacesPhotoUrl(PHOTO_A)).toBe(true);
    expect(isPlacesPhotoUrl('/api/venues/photo?ref=places%2FP%2Fphotos%2FR&maxwidth=400')).toBe(true);
    expect(isPlacesPhotoUrl('https://s1.ticketm.net/dam/a/123/poster.jpg')).toBe(false);
    expect(isPlacesPhotoUrl(null)).toBe(false);
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
      // The sheet's own crowd read: none of this place, none on the way.
      venueDetailCrowd: null,
      partySize: null,
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

  test('a seed photo that came without its credit is not drawn: the map stands in, and the events go on the art', () => {
    // A chat card, a pinned venue or a failed details read hands the sheet a
    // photo with no credit. It waits for Place Details' credited photos.
    for (const loading of [true, false]) {
      const { container, unmount } = render(React.createElement(VenueDetailSheet, props({
        venueDetailModal: { place_id: 'ChIJcopperFinch01', name: 'The Copper Finch', loading, photos: [], photo_url: PHOTO_A, photo_attribution: null, lat: 40.6, lng: -75.4 },
        venueDetailEvents: [{ id: 41, title: 'Trivia Night', event_date: null, event_time: null }],
      })));
      expect(container.querySelector(`img[src="${PHOTO_A}"]`)).toBeNull();
      expect(screen.queryByTestId('photo-credit')).toBeNull();
      if (!loading) expect(screen.getAllByTestId('venue-event-art')).toHaveLength(1);
      unmount();
    }
  });

  test('a venue taken from the sheet into a new plan keeps its photo\'s credit', () => {
    const p = props();
    render(React.createElement(VenueDetailSheet, p));
    fireEvent.click(screen.getByRole('button', { name: /Add to Flock/ }));
    expect(p.setSelectedVenueForCreate).toHaveBeenCalledTimes(1);
    expect(p.setSelectedVenueForCreate.mock.calls[0][0]).toMatchObject({ photo_url: PHOTO_A, photo_attribution: CREDIT_A });
  });

  test('and so does one a member puts on a plan\'s table', () => {
    const p = props({
      pickingVenueForFlockId: 5,
      flocksRef: { current: [{ id: 5, creatorId: 99, votes: [] }] },
      meRef: { current: { id: 7 } },
    });
    render(React.createElement(VenueDetailSheet, p));
    fireEvent.click(screen.getByRole('button', { name: /Suggest to flock/ }));
    expect(p.shareVenueToChat).toHaveBeenCalledTimes(1);
    expect(p.shareVenueToChat.mock.calls[0][1]).toMatchObject({ photo_url: PHOTO_A, photo_attribution: CREDIT_A });
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
      // 2026-11-06: the Create screen's pick, and a vote or share row's photo
      // in either chat screen.
      ['screens', 'CreateScreen.js'],
      ['screens', 'ChatDetail.js'],
      ['screens', 'DmDetail.js'],
    ]) {
      const src = readSrc(...rel);
      const seeds = [...src.matchAll(/openVenueDetail\([^;]*photo_url: (?!null)[^;]*\)/g)].map((m) => m[0]);
      expect(seeds.length).toBeGreaterThan(0);
      for (const seed of seeds) expect(`${rel.join('/')}: ${/photo_attribution/.test(seed)}`).toBe(`${rel.join('/')}: true`);
    }
  });

  test('a chat card and a pinned venue keep no credit, so they hand the sheet no photo', () => {
    // The card's and the pin's seeds name the place and nothing it cannot
    // credit; the sheet shows its map until the details answer.
    for (const [rel, ids] of [
      [['screens', 'ChatDetail.js'], ['vc.place_id', 'flock.venueId']],
      [['screens', 'DmDetail.js'], ['vd.place_id', 'pinned.place_id']],
    ]) {
      const src = readSrc(...rel);
      for (const id of ids) {
        const seed = src.slice(src.indexOf(`openVenueDetail(${id}, {`), src.indexOf('}, { panMap: true })', src.indexOf(`openVenueDetail(${id}, {`)));
        expect(seed.length).toBeGreaterThan(20);
        expect(`${id}: ${/photo_url/.test(seed)}`).toBe(`${id}: false`);
      }
    }
  });

  test('the pan after the sheet opens carries the photo\'s credit to the pin it may drop', () => {
    // sheetOpen after it: the sheet is already open on the place, so the pan
    // does not reopen it (venueSheetCrowdForecast.test.js).
    expect(APP).toMatch(/window\.__flockPanToVenue\(\{ place_id: placeId, [^;]*photo_attribution: panFromList \? \(\(venue\.photo_attributions \|\| \[\]\)\[0\] \|\| null\) : \(venue\.photo_attribution \|\| null\), sheetOpen: true \}\)/);
  });

  test('the owner\'s own venue on the dashboard map keeps its photo\'s credit', () => {
    expect(APP).toMatch(/photo_url: \(v\.photos && v\.photos\[0\]\) \|\| null,\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*photo_attribution: \(v\.photo_attributions && v\.photo_attributions\[0\]\) \|\| null,/);
  });

  test('the dashboard keeps the credit with the cover photo it picks and with each logo choice', () => {
    expect(APP).toMatch(/url: photos\[i\] \|\| null, credit: \(data\?\.venue\?\.photo_attributions \|\| \[\]\)\[i\] \|\| null/);
    expect(APP).toContain('setVenueLogoPicker({ photos: data?.venue?.photos || [], credits: data?.venue?.photo_attributions || [] })');
    const dash = readSrc('screens', 'VenueDashboard.js');
    expect(dash).toContain('const coverCredit = venueCoverUrl ? usableCredit(venueCoverCredit) : null;');
    expect(dash).toMatch(/\{coverCredit && \(\s*<PhotoCredit credit=\{coverCredit\}/);
    // Each logo tile's credit sits in a 44px row under the tile, outside its
    // button (venueLogoPickerCredit.test.js renders it).
    expect(dash).toContain('const credit = usableCredit(creditAt(venueLogoPicker.credits, i));');
    expect(dash).toMatch(/<\/button>\s*\{credit && \(\s*<div data-testid="logo-photo-credit-row" style=\{\{ height: '44px'[^}]*\}\}>\s*<PhotoCredit credit=\{credit\} \/>/);
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
    // 2026-11-06: the plan screen's venue card, the chat list, both chat
    // screens (vote and share lists, the share sheets' current venue), the
    // chat venue card, the pinned venue, the Create screen's pick, the
    // Nest's plan cards, the Discover map and the guest invite's venue list.
    [['screens', 'FlockDetail.js']],
    [['screens', 'ChatListScreen.js']],
    [['screens', 'ChatDetail.js']],
    [['screens', 'DmDetail.js']],
    [['components', 'chat', 'cards', 'VenueCardRow.js']],
    [['components', 'chat', 'sheets', 'PinStrip.js']],
    [['screens', 'CreateScreen.js']],
    [['App.js']],
    [['components', 'map', 'MapLibreMapView.js']],
    [['website', 'GuestInvite.js']],
    // 2026-11-06, second pass: the in-chat poll card.
    [['components', 'chat', 'cards', 'PollCard.js']],
  ])('%j', (rel) => {
    expect(readSrc(...rel)).toMatch(/<GoogleMapsMark\b/);
  });

  test('both chat screens end each venue list on the mark, and the current venue carries it', () => {
    for (const rel of [['screens', 'ChatDetail.js'], ['screens', 'DmDetail.js']]) {
      const src = readSrc(...rel);
      // The vote list, the share list and the share sheet's current venue.
      expect(`${rel[1]}: ${(src.match(/<GoogleMapsMark\b/g) || []).length}`).toBe(`${rel[1]}: 3`);
    }
  });

  test('the map carries one mark, only while Google places are pinned, and above the POI notice while it shows and a left-docked SOS', () => {
    const map = readSrc('components', 'map', 'MapLibreMapView.js');
    expect((map.match(/<GoogleMapsMark\b/g) || []).length).toBe(1);
    expect(map).toMatch(/\{mapReady && !mapFailed && !keyRefused && Array\.isArray\(venues\) && venues\.some\(\(v\) => v && v\.place_id\) && \(\s*<div[^>]*>\s*<GoogleMapsMark dark=\{false\} \/>/);
    // The notice is centred at the bottom, 24px up, and at 320px wide it
    // reaches the mark's corner: the mark stands 8px above its measured top.
    expect(map).toContain('<p role="status" aria-live="polite" ref={poiNoticeRef} style={{ position: \'absolute\', bottom: \'24px\'');
    expect(map).toContain('const el = poiNotice ? poiNoticeRef.current : null;');
    expect(map).toContain('const measure = () => setPoiNoticeHeight(el.offsetHeight);');
    // The mark's offset is the highest of its own 40px, 8px over the notice
    // and 8px over a docked SOS on its side (mapGoogleMarkClearsSos.test.js).
    expect(map).toContain('bottom: `${googleMarkBottom(poiNoticeHeight, bottomLeftClear)}px`');
    expect(map).toMatch(/export const googleMarkBottom = \(noticeHeight, bottomLeftClear\) => Math\.max\(\s*40,\s*noticeHeight \? 24 \+ noticeHeight \+ 8 : 0,\s*bottomLeftClear \? bottomLeftClear \+ 8 : 0,\s*\);/);
    // Measured again while it shows: a rotation rewraps the notice. The watch
    // is taken down when the notice goes, and the effect follows the notice.
    expect(map).toMatch(/const watch = new ResizeObserver\(measure\);\s*watch\.observe\(el\);\s*return \(\) => watch\.disconnect\(\);/);
    expect(map).toMatch(/window\.addEventListener\('resize', measure\);\s*return \(\) => window\.removeEventListener\('resize', measure\);\s*\}, \[poiNotice\]\);/);
  });

  test('the guest invite page themes the mark itself, in both of its schemes', () => {
    // The app's token follows <html data-theme>, which that page never sets.
    const css = readSrc('website', 'GuestInvite.css');
    expect(css).toMatch(/\.gi \{[\s\S]*?--google-maps-attribution: #5E5E5E;/);
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*\.gi \{[\s\S]*?--google-maps-attribution: #FFFFFF;/);
  });

  test('the website demo credits its photo, and not the placeholder', () => {
    const demo = readSrc('website', 'LiveDemo.js');
    expect(demo).toMatch(/\{!photoFailed && \(\s*<PhotoCredit credit=\{selected\.photo_attribution\}/);
  });
});

describe('every list that names Google places ends on the mark', () => {
  const OPTS = [
    { id: 'ChIJkome000001', placeId: 'ChIJkome000001', name: 'Kome', voteCount: 2 },
    { id: 'Bolete', name: 'Bolete', voteCount: 1 },
  ];

  test('the in-chat poll card, when an option is a Google place, and only then', () => {
    const { unmount } = render(React.createElement(PollCard, { title: 'Where are we going?', options: OPTS, votedCount: 3, memberCount: 5 }));
    expect(screen.getByTestId('google-maps-attribution').textContent).toBe('Google Maps');
    unmount();
    render(React.createElement(PollCard, { title: 'Where are we going?', options: OPTS.map(({ placeId, ...o }) => o), votedCount: 3, memberCount: 5 }));
    expect(screen.queryByTestId('google-maps-attribution')).toBeNull();
    // The chat hands the card each option's place id.
    expect(readSrc('screens', 'ChatDetail.js')).toMatch(/name: v\.venue,\s*\/\/[^\n]*\n\s*\/\/[^\n]*\n\s*placeId: v\.place_id \|\| null,/);
  });

  test('the plan screen\'s venue votes, when a vote is for a Google place', () => {
    const detail = readSrc('screens', 'FlockDetail.js');
    expect(detail).toMatch(/\{flock\.votes\.some\(\(v\) => v\.place_id\) && \(\s*<div[^>]*>\s*<GoogleMapsMark \/>/);
    // The venue card's mark and the votes list's.
    expect((detail.match(/<GoogleMapsMark\b/g) || []).length).toBe(2);
  });

  test('the chat list\'s invites, when an invite names a venue (an invite card carries no place id)', () => {
    const list = readSrc('screens', 'ChatListScreen.js');
    expect(list).toMatch(/\{pendingFlockInvites\.some\(\(f\) => f\.venue && f\.venue !== 'TBD'\) && \(\s*<div[^>]*>\s*<GoogleMapsMark \/>/);
    // The invites list's mark and the Flocks list's.
    expect((list.match(/<GoogleMapsMark\b/g) || []).length).toBe(2);
  });

  test('the owner\'s logo, a listing photo, is drawn only on the owner\'s dashboard, where a tap opens the credited picker', () => {
    // venue_profiles.photo_url reaches the app only through the owner's own
    // GET /api/venue-profile (backend routes/venueProfile.js); no consumer
    // screen reads it. The 64px logo is a thumbnail, and its tap opens the
    // logo picker, whose tiles each carry their photo's credit.
    const readers = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
        } else if (/\.js$/.test(entry.name) && /venueLogoUrl/.test(fs.readFileSync(full, 'utf8'))) {
          readers.push(path.relative(SRC, full).split(path.sep).join('/'));
        }
      }
    };
    walk(SRC);
    expect(readers.sort()).toEqual(['App.js', 'screens/VenueDashboard.js']);
    const dash = readSrc('screens', 'VenueDashboard.js');
    expect(dash).toMatch(/onClick=\{\(\) => openVenueLogoPicker\(\)\}[\s\S]{0,900}<img src=\{venueLogoUrl\}/);
  });
});

describe('every Places photo drawn large carries its credit', () => {
  test.each([
    [['components', 'overlays', 'VenueDetailSheet.js']],
    [['components', 'overlays', 'VenueEventsSection.js']],
    [['website', 'LiveDemo.js']],
    // 2026-11-06: the venue dashboard's cover and logo picker. The plan
    // screen's venue photo is a thumbnail (below).
    [['screens', 'VenueDashboard.js']],
  ])('%j', (rel) => {
    expect(readSrc(...rel)).toMatch(/<(PhotoCredit|CreditedPhoto)\b/);
  });
});

describe('every thumbnail reaches the credited sheet', () => {
  test('the policy names the routes, the chat list\'s one included', () => {
    const policy = readSrc('components', 'ui', 'GoogleCredit.js');
    expect(policy).toMatch(/chat list's 46px plan tile opens the chat, and from there the route\s*\n\s*\*\s*is the chat, then "Open the plan"/);
    expect(policy).toMatch(/screens\/FlockDetail\.js/);
    expect(policy).toMatch(/ThumbToSheet/);
  });

  test('a chat venue card draws a Google photo and the mark only with a place behind it', () => {
    const venue = { name: 'Kome', addr: '17 W Broad St', photo_url: PHOTO_A, place_id: 'ChIJkome000001' };
    const first = render(React.createElement(VenueCardRow, { venue, onOpen: jest.fn(), onAction: jest.fn() }));
    expect(first.container.querySelector(`img[src="${PHOTO_A}"]`)).toBeTruthy();
    const mark = screen.getByTestId('google-maps-attribution');
    expect(mark.textContent).toBe('Google Maps');
    // A 16px line of its own in the text column.
    expect(mark.parentElement.className).toBe('chat-venue-text');
    expect(mark.style.lineHeight).toBe('16px');
    first.unmount();

    const { container } = render(React.createElement(VenueCardRow, {
      venue: { ...venue, place_id: undefined }, placeholder: '/marks/venue-placeholder.jpg', onOpen: jest.fn(), onAction: jest.fn(),
    }));
    expect(container.querySelector(`img[src="${PHOTO_A}"]`)).toBeNull();
    expect(container.querySelector('img').getAttribute('src')).toBe('/marks/venue-placeholder.jpg');
    expect(screen.queryByTestId('google-maps-attribution')).toBeNull();
  });

  test('the pinned venue carries the mark beside "Pinned"; a vote does not', () => {
    const { unmount } = render(React.createElement(PinStrip, { model: { kind: 'venue', name: 'Kome', thumbUrl: PHOTO_A, caption: 'Pinned', placeId: 'ChIJkome000001' }, onOpen: jest.fn() }));
    const mark = screen.getByTestId('google-maps-attribution');
    expect(mark.parentElement.className).toBe('cs-strip-caption');
    expect(mark.parentElement.textContent).toBe('Pinned Google Maps');
    // The strip's accessible name reads as words.
    expect(screen.getByRole('button', { name: /Kome Pinned Google Maps/ })).toBeTruthy();
    unmount();
    const vote = render(React.createElement(PinStrip, { model: { kind: 'vote', votedCount: 1, memberCount: 4 }, onOpen: jest.fn() }));
    expect(screen.queryByTestId('google-maps-attribution')).toBeNull();
    vote.unmount();
    render(React.createElement(PinStrip, { model: { kind: 'venue', name: 'Somewhere', caption: 'Pinned' }, onOpen: jest.fn() }));
    expect(screen.queryByTestId('google-maps-attribution')).toBeNull();
  });

  test('both chat screens open the pinned venue\'s sheet itself, not a pan to whatever pin is nearby', () => {
    const chat = readSrc('screens', 'ChatDetail.js');
    const strip = chat.slice(chat.indexOf('const openPinStrip = (model) => {'), chat.indexOf('const openListVenue = (venue) => {'));
    expect(strip).toMatch(/openVenueDetail\(flock\.venueId, \{[^;]*\}, \{ panMap: true \}\)/);
    expect(strip).not.toMatch(/window\.__flockPanToVenue\(\{ place_id/);
    expect(chat).toMatch(/thumbUrl: \(flock\.venueId && flock\.venuePhoto\) \|\| undefined, caption: 'Pinned', placeId: flock\.venueId \|\| null/);
    const dm = readSrc('screens', 'DmDetail.js');
    const pin = dm.slice(dm.indexOf('const openPinnedVenueOnMap = () => {'), dm.indexOf('const openListVenue = (venue) => {'));
    expect(pin).toMatch(/openVenueDetail\(pinned\.place_id, \{[^;]*\}, \{ panMap: true \}\)/);
    expect(pin).not.toMatch(/__flockPanToVenue/);
    expect(dm).toMatch(/thumbUrl: dmPinnedVenue\.place_id \? resolveVenuePhoto\(dmPinnedVenue\.photo_url\) : null,\s*placeId: dmPinnedVenue\.place_id \|\| null,/);
  });

  test('a vote or share row\'s photo is a button of its own that opens the sheet, beside the row and not inside it', () => {
    const onOpen = jest.fn();
    const onRow = jest.fn();
    render(React.createElement('div', { onClick: onRow, style: { position: 'relative' } },
      React.createElement('button', { type: 'button' }, 'Vote'),
      React.createElement(ThumbToSheet, { label: 'Open Kome', onOpen, left: '13px', size: '36px', radius: '8px' })));
    const thumb = screen.getByRole('button', { name: 'Open Kome' });
    expect(thumb.parentElement.closest('button')).toBeNull();
    expect(thumb.parentElement.tagName).toBe('DIV');
    expect(thumb.style.position).toBe('absolute');
    fireEvent.click(thumb);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onRow).not.toHaveBeenCalled();
    for (const rel of [['screens', 'ChatDetail.js'], ['screens', 'DmDetail.js']]) {
      const src = readSrc(...rel);
      expect(`${rel[1]}: ${(src.match(/<ThumbToSheet label=\{`Open \$\{venue\.name\}`\} onOpen=\{\(\) => openListVenue\(venue\)\}/g) || []).length}`).toBe(`${rel[1]}: 2`);
    }
  });

  test('the Create screen\'s pick opens its sheet with its credit, and an event\'s own image stays', () => {
    const create = readSrc('screens', 'CreateScreen.js');
    expect(create).toContain('const showPhoto = !!v.photo_url && (!!v.place_id || !isPlacesPhotoUrl(v.photo_url));');
    expect(create).toMatch(/\{v\.place_id \? \(\s*<button[\s\S]*?onClick=\{\(\) => openVenueDetail\(v\.place_id, \{[^;]*photo_attribution: v\.photo_attribution \|\| null/);
  });

  test('the chat list draws a plan tile\'s photo only with its place, and names the route in the policy', () => {
    const list = readSrc('screens', 'ChatListScreen.js');
    expect(list).toContain('{f.venuePhoto && f.venueId ? (');
  });
});

describe('the plan screen\'s venue photo is a small thumbnail whose tap opens the credited sheet', () => {
  // Google renames a photo on every answer, so the plan's stored photo cannot
  // carry its own credit (components/ui/GoogleCredit.js). It is drawn as it
  // was stored, on the first paint, at thumbnail size beside the venue's
  // name, and a tap opens the venue's sheet, which draws Google's current
  // photos credited. Until 2026-11-06 it was the card's 375x170 header.
  const FLOCK_SRC = readSrc('screens', 'FlockDetail.js');
  const PARAMS = (() => {
    const from = FLOCK_SRC.indexOf('export default function FlockDetail({');
    const to = FLOCK_SRC.indexOf('}) {', from);
    return FLOCK_SRC.slice(from, to).split('\n').slice(1).map((l) => l.replace(/\/\/.*$/, '').trim())
      .filter(Boolean).flatMap((l) => l.split(',')).map((w) => w.trim()).filter(Boolean);
  })();
  const AT = { lat: 40.611234567, lng: -75.374612345 };
  const plan = (extra = {}) => ({
    id: 41, name: 'Friday', host: 'Ava', creatorId: 9, status: 'voting', venue: 'Copper Finch', venueId: 'ChIJcopperFinch01',
    venueAddress: '125 E 3rd St', venueLat: AT.lat, venueLng: AT.lng, venueRating: 4.6,
    members: [{ id: 9, name: 'Ava', status: 'accepted' }], guests: [], votes: [], venuePhoto: PHOTO_A, ...extra,
  });
  const planProps = (flock) => {
    const p = {};
    for (const name of PARAMS) p[name] = jest.fn();
    return Object.assign(p, {
      DialogBehavior: () => null, MissingFlockPanel: () => null, MOMENTUM_STAGES: [], authUser: { id: 9 }, checkinSaving: false,
      colors: {}, crowdPredictions: {}, feedbackState: { crowdLevel: null, priceWorth: null, rating: null }, feedbackSubmitting: false,
      getSelectedFlock: () => flock, recapSharing: false, rerunningFlockId: null, rosterError: null, showTimeEditor: false,
      slideFillRef: { current: null }, slidePctRef: { current: 0 }, slideRef: { current: null }, slideStage: 'idle',
      slideThumbRef: { current: null }, slidingRef: { current: false }, styles: { card: {} }, submittedFeedback: new Set(),
      timeEditDay: 'Tonight', timeEditHour: '9 PM', voteTotal: () => 0,
    });
  };
  const SEED = { name: 'Copper Finch', formatted_address: '125 E 3rd St', place_id: 'ChIJcopperFinch01', rating: 4.6, lat: AT.lat, lng: AT.lng };
  // StaticVenueMap draws only with a MapTiler key.
  beforeEach(() => { process.env.REACT_APP_MAPTILER_KEY = 'k'; });
  afterEach(() => { delete process.env.REACT_APP_MAPTILER_KEY; });

  test('the stored photo is on the first paint, small beside the name, as a button to the venue sheet, under the map', () => {
    const p = planProps(plan());
    const { container } = render(React.createElement(FlockDetail, p));
    const photo = container.querySelector(`img[src="${PHOTO_A}"]`);
    expect(photo).not.toBeNull();
    const door = photo.closest('button');
    expect(door.getAttribute('aria-label')).toBe('Open Copper Finch');
    // Thumbnail size: inside 64 to 88px, never the old 375x170 header, and
    // still at least the 44px a finger needs.
    for (const side of [photo.getAttribute('width'), photo.getAttribute('height'), door.style.width, door.style.height]) {
      const px = parseInt(side, 10);
      expect(px).toBeGreaterThanOrEqual(64);
      expect(px).toBeLessThanOrEqual(88);
    }
    // Beside the name, in one row with it.
    const name = screen.getByRole('heading', { level: 3, name: 'Copper Finch' });
    expect(door.parentElement.contains(name)).toBe(true);
    expect(door.contains(name)).toBe(false);
    // The card opens on the map, its one map, and the photo is not in it.
    const card = container.querySelector('[data-static-map]').parentElement;
    const maps = card.querySelectorAll('[data-static-map]');
    expect(maps).toHaveLength(1);
    expect(card.firstElementChild).toBe(maps[0]);
    expect(card.contains(door)).toBe(true);
    expect(maps[0].contains(door)).toBe(false);
    // A thumbnail carries no credit of its own; the sheet credits.
    expect(screen.queryByTestId('photo-credit')).toBeNull();
    fireEvent.click(door);
    expect(p.openVenueDetail).toHaveBeenCalledTimes(1);
    expect(p.openVenueDetail).toHaveBeenCalledWith('ChIJcopperFinch01', SEED);
  });

  test('Details opens the same sheet with the same seed, which hands it no photo', () => {
    const p = planProps(plan());
    render(React.createElement(FlockDetail, p));
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(p.openVenueDetail).toHaveBeenCalledWith('ChIJcopperFinch01', SEED);
    const seed = p.openVenueDetail.mock.calls[0][1];
    expect(seed).not.toHaveProperty('photo_url');
    expect(seed).not.toHaveProperty('photo_attribution');
  });

  test('with no place id there is no sheet to open, so no Google photo and no photo button: the map alone', () => {
    const { container } = render(React.createElement(FlockDetail, planProps(plan({ venueId: null }))));
    expect(container.querySelector(`img[src="${PHOTO_A}"]`)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open Copper Finch' })).toBeNull();
    const maps = container.querySelectorAll('[data-static-map]');
    expect(maps).toHaveLength(1);
    expect(maps[0].parentElement.firstElementChild).toBe(maps[0]);
    expect(container.querySelector('.plan-venue-photo')).toBeNull();
    // The name keeps its row, with nothing in the photo's place.
    expect(screen.getByRole('heading', { level: 3, name: 'Copper Finch' })).toBeTruthy();
    expect(screen.queryByTestId('google-maps-attribution')).toBeNull();
  });

  test('beside the photo the name has its column to itself and the rating sits under it', () => {
    // On a 320px phone the column beside the photo is 178px. With the rating
    // in the name's row the name had 120px, and "Mediterranean" broke after
    // its twelfth letter (rig measurement, 2026-11-06). jsdom has no layout,
    // so the structure is pinned: nothing shares the name's line.
    const { container } = render(React.createElement(FlockDetail, planProps(plan())));
    const door = container.querySelector('.plan-venue-photo');
    const name = screen.getByRole('heading', { level: 3, name: 'Copper Finch' });
    const column = name.parentElement;
    expect(column.parentElement).toBe(door.parentElement);
    expect(column.firstElementChild).toBe(name);
    expect(column.style.display).toBe('');
    expect(name.style.flex).toBe('');
    expect(name.style.overflowWrap).toBe('break-word');
    const rating = screen.getByText('4.6');
    expect(name.contains(rating)).toBe(false);
    const ratingRow = rating.parentElement;
    expect(ratingRow.parentElement).toBe(column);
    expect([...column.children].indexOf(ratingRow)).toBe(1);
    // The address follows the rating.
    const address = screen.getByText('125 E 3rd St');
    // eslint-disable-next-line no-bitwise
    expect(ratingRow.compareDocumentPosition(address) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('until the photo arrives its box is the skeleton ground at its final size', () => {
    const { container } = render(React.createElement(FlockDetail, planProps(plan())));
    const door = container.querySelector('.plan-venue-photo');
    // jsdom drops a var() colour, so the source carries the pin: the box is
    // the skeleton token, which both themes define.
    expect(FLOCK_SRC).toMatch(/className="plan-venue-photo"[^>]*backgroundColor: 'var\(--skeleton-bg\)'/);
    expect((readSrc('index.css').match(/--skeleton-bg: #[0-9a-f]{6};/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(door.style.flexShrink).toBe('0');
    expect(door.style.width).toBe(door.style.height);
    const photo = door.querySelector('img');
    expect([photo.getAttribute('width'), photo.getAttribute('height')]).toEqual([door.style.width.replace('px', ''), door.style.height.replace('px', '')]);
  });

  test('no Google photo on the plan screen is drawn at header size', () => {
    // Every <img> of the plan's stored photo in the screen's source carries
    // thumbnail dimensions; the 375x170 header is gone.
    const imgs = FLOCK_SRC.match(/<img src=\{flock\.venuePhoto\}[^>]*>/g) || [];
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toMatch(/width="72" height="72"/);
    expect(FLOCK_SRC).not.toMatch(/height="170"/);
  });

  test('the photo button draws its keyboard ring on both sides of its rounded edge', () => {
    const { container } = render(React.createElement(FlockDetail, planProps(plan())));
    const door = container.querySelector(`img[src="${PHOTO_A}"]`).closest('button');
    expect(door.classList.contains('plan-venue-photo')).toBe(true);
    // The button clips its photo to rounded corners. jsdom has no
    // :focus-visible, so the rule itself is pinned: the outline 2px inside,
    // on the photo, and a ring of the same colour 2px outside, on the card,
    // where its contrast does not depend on the photo.
    expect(door.style.borderRadius).toBe('12px');
    expect(door.style.overflow).toBe('hidden');
    const css = readSrc('index.css');
    expect(css).toMatch(/\.plan-venue-photo:focus-visible\s*\{\s*outline-offset:\s*-2px;\s*box-shadow:\s*0 0 0 2px var\(--focus-ring\);\s*\}/);
  });

  test('the policy puts the plan screen\'s photo under the thumbnail rule, and says why it is small', () => {
    const policy = readSrc('components', 'ui', 'GoogleCredit.js');
    expect(policy).toMatch(/the plan screen's venue photo \(screens\/FlockDetail\.js\), a 72px button\s*\n\s*\*\s*beside the venue's name that opens the sheet/);
    expect(policy).toMatch(/A THUMBNAIL IS SMALL\./);
    expect(policy).not.toMatch(/header photo \(screens\/FlockDetail/);
    expect(policy).toMatch(/new resource name on every answer/);
    expect(policy).toMatch(/\(checked\s*\n\s*\*\s*2026-11-06: 0 of 10 names repeated across two lookups, for each of two\s*\n\s*\*\s*places\)/);
    // The shared photo-and-credit piece went back to the sheet, its one user.
    expect(policy).not.toMatch(/CreditedPhoto/);
  });
});
