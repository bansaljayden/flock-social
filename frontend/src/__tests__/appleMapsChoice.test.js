// Every Directions button offers Apple Maps.
//
// App Review rejected 1.0 under Guideline 4 on 2026-10-07: "The app's location
// feature is not integrated with the built-in mapping functionality, which
// limits users to a third-party maps app ... give users the option to launch
// the native Apple Maps app." The venue sheet's Get Directions, a plan's
// Directions and an SOS alarm's map link all went to Google Maps only. Each
// now opens components/ui/MapsChooser.js, which offers Apple Maps (first on an
// Apple device) and the Google link the button already had.
const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, act } = require('@testing-library/react');

const {
  appleMapsUrl, coordinates, mapsChoices, onAppleDevice, onAndroid,
} = require('../lib/mapsLinks');
const MapsChooserModule = require('../components/ui/MapsChooser');

const MapsChooserHost = MapsChooserModule.default;
const { openMapsChooser, closeMapsChooser } = MapsChooserModule;

const SRC = path.resolve(__dirname, '..');
const readSrc = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD_AS_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

const VENUE = { name: "Lucky's Last Chance", address: '125 E 3rd St, Bethlehem, PA 18015', lat: 40.6112, lng: -75.3746 };
const GOOGLE = 'https://www.google.com/maps/place/?q=place_id:ChIJexample';

describe('the Apple Maps link', () => {
  test('coordinates place the pin and the name labels it', () => {
    expect(appleMapsUrl(VENUE)).toBe("https://maps.apple.com/?ll=40.6112,-75.3746&q=Lucky's%20Last%20Chance");
  });

  test("with no coordinates the name is searched for at its address, which lands on the place's own card", () => {
    // `address` with `q` showed the bare address card, titled with the street
    // address and not the name.
    expect(appleMapsUrl({ name: 'Lucky', address: '125 E 3rd St, Bethlehem' }))
      .toBe('https://maps.apple.com/?q=Lucky%2C%20125%20E%203rd%20St%2C%20Bethlehem');
  });

  test('an address alone is shown without a search', () => {
    expect(appleMapsUrl({ address: '125 E 3rd St, Bethlehem' }))
      .toBe('https://maps.apple.com/?address=125%20E%203rd%20St%2C%20Bethlehem');
  });

  test('a pin with no name is labelled with a plain word, never left to search', () => {
    expect(appleMapsUrl({ lat: 40.6112, lng: -75.3746 })).toBe('https://maps.apple.com/?ll=40.6112,-75.3746&q=Location');
  });

  test('a name alone is a search, and nothing at all is no link', () => {
    expect(appleMapsUrl({ name: 'Lucky' })).toBe('https://maps.apple.com/?q=Lucky');
    expect(appleMapsUrl({})).toBeNull();
    expect(appleMapsUrl({ name: '   ' })).toBeNull();
  });

  test('a missing or impossible position is not used', () => {
    expect(coordinates(0, 0)).toBeNull();
    expect(coordinates(null, -75)).toBeNull();
    expect(coordinates('', '')).toBeNull();
    expect(coordinates(91, 10)).toBeNull();
    expect(coordinates('abc', 10)).toBeNull();
    expect(coordinates('40.5', '-75.25')).toEqual({ lat: 40.5, lng: -75.25 });
    expect(appleMapsUrl({ name: 'Lucky', lat: 0, lng: 0 })).toBe('https://maps.apple.com/?q=Lucky');
  });

  test('a name with query characters cannot add a parameter', () => {
    const url = appleMapsUrl({ name: 'A&B=1#x', lat: 1, lng: 2 });
    expect(url).toBe('https://maps.apple.com/?ll=1,2&q=A%26B%3D1%23x');
  });

  test('a name cut through an emoji still makes a link', () => {
    // 119 letters, then an emoji: the cut at 120 fell inside the emoji, and
    // encodeURIComponent throws on the half it left. The cut is by code
    // point now, so the emoji stays whole.
    const long = `${'A'.repeat(119)}\u{1F37A} Bar`;
    expect(appleMapsUrl({ name: long, lat: 40.1, lng: -75.2 }))
      .toBe(`https://maps.apple.com/?ll=40.1,-75.2&q=${'A'.repeat(119)}%F0%9F%8D%BA`);
    // A name that arrives already cut by UTF-16 unit, as the server and
    // App.js cut a name at 80, ends in half an emoji. The half is dropped.
    const halfEmoji = `${'A'.repeat(79)}\u{1F98B}xyz`.slice(0, 80);
    expect(halfEmoji.charCodeAt(79)).toBe(0xd83e);
    expect(() => encodeURIComponent(halfEmoji)).toThrow(URIError);
    expect(appleMapsUrl({ name: halfEmoji, lat: 40.1, lng: -75.2 })).toBe(`https://maps.apple.com/?ll=40.1,-75.2&q=${'A'.repeat(79)}`);
    // So is a stray low half; whole emoji and curly quotes stay.
    expect(appleMapsUrl({ name: 'Joe’s \u{1F37A} Bar\uDC00' })).toBe('https://maps.apple.com/?q=Joe%E2%80%99s%20%F0%9F%8D%BA%20Bar');
    // An address is cut the same way, at 240.
    const longAddress = `${'B'.repeat(239)}\u{1F37A} St`;
    expect(appleMapsUrl({ address: longAddress })).toBe(`https://maps.apple.com/?address=${'B'.repeat(239)}%F0%9F%8D%BA`);
  });

  test('the link code parses on iOS 15: no regex lookbehind, no toWellFormed', () => {
    const code = readSrc('lib', 'mapsLinks.js');
    expect(code).not.toMatch(/\(\?<[=!]/);
    expect(code).not.toMatch(/\.(toWellFormed|isWellFormed)\(/);
  });
});

describe('which apps are offered, and in what order', () => {
  test('an iPhone, Safari on an iPad (which reports a Mac) and the iOS app list Apple Maps first', () => {
    expect(onAppleDevice(IPHONE, 'https:')).toBe(true);
    expect(onAppleDevice(IPAD_AS_MAC, 'https:')).toBe(true);
    expect(onAppleDevice('', 'capacitor:')).toBe(true);
    const choices = mapsChoices({ place: VENUE, googleUrl: GOOGLE }, { apple: true, android: false });
    expect(choices.map((c) => c.label)).toEqual(['Apple Maps', 'Google Maps']);
    expect(choices[1].url).toBe(GOOGLE);
  });

  test('elsewhere Google Maps comes first and Apple Maps is still there', () => {
    expect(onAppleDevice(WINDOWS, 'https:')).toBe(false);
    const choices = mapsChoices({ place: VENUE, googleUrl: GOOGLE }, { apple: false, android: false });
    expect(choices.map((c) => c.label)).toEqual(['Google Maps', 'Apple Maps']);
  });

  test('an Android phone, which has no Apple Maps, is offered Google Maps only', () => {
    expect(onAndroid(ANDROID)).toBe(true);
    const choices = mapsChoices({ place: VENUE, googleUrl: GOOGLE }, { apple: false, android: true });
    expect(choices.map((c) => c.label)).toEqual(['Google Maps']);
  });

  test('a Google link that is not a web link is left out', () => {
    const choices = mapsChoices({ place: VENUE, googleUrl: 'javascript:alert(1)' }, { apple: true, android: false });
    expect(choices.map((c) => c.label)).toEqual(['Apple Maps']);
  });

  test('an http Google link is upgraded to https, not dropped', () => {
    // The venue card shows Get Directions for an http google_maps_url, so
    // dropping it would leave the Google choice off a button still on screen.
    const choices = mapsChoices({ place: VENUE, googleUrl: ' http://maps.google.com/?cid=4242 ' }, { apple: true, android: false });
    expect(choices.map((c) => c.label)).toEqual(['Apple Maps', 'Google Maps']);
    expect(choices[1].url).toBe('https://maps.google.com/?cid=4242');
    expect(mapsChoices({ googleUrl: 'HTTP://maps.google.com/?cid=1' }, { apple: false, android: true })[0].url)
      .toBe('https://maps.google.com/?cid=1');
  });
});

describe('the Open in sheet', () => {
  let opened;
  let originalOpen;
  beforeEach(() => {
    opened = [];
    originalOpen = window.open;
    window.open = (...args) => { opened.push(args); return null; };
  });
  afterEach(() => { window.open = originalOpen; });

  test('it offers both apps, and a choice opens that app without an opener', () => {
    render(React.createElement(MapsChooserHost, {}));
    act(() => { openMapsChooser({ place: VENUE, googleUrl: GOOGLE }); });
    expect(screen.getByText('Open in')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apple Maps' }));
    expect(opened).toEqual([["https://maps.apple.com/?ll=40.6112,-75.3746&q=Lucky's%20Last%20Chance", '_blank', 'noopener,noreferrer']]);
    expect(screen.queryByText('Open in')).toBeNull();
  });

  test('Google Maps opens the link the button already had', () => {
    render(React.createElement(MapsChooserHost, {}));
    act(() => { openMapsChooser({ place: VENUE, googleUrl: GOOGLE }); });
    fireEvent.click(screen.getByRole('button', { name: 'Google Maps' }));
    expect(opened).toEqual([[GOOGLE, '_blank', 'noopener,noreferrer']]);
  });

  test('Cancel closes it and opens nothing', () => {
    render(React.createElement(MapsChooserHost, {}));
    act(() => { openMapsChooser({ place: VENUE, googleUrl: GOOGLE }); });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Open in')).toBeNull();
    expect(opened).toEqual([]);
  });

  test('with no sheet mounted the button still opens a map', () => {
    expect(openMapsChooser({ place: VENUE, googleUrl: GOOGLE })).toBe(true);
    expect(opened.length).toBe(1);
    expect(openMapsChooser({ place: {}, googleUrl: null })).toBe(false);
  });

  test('one app to offer opens straight away, with no sheet to choose from', () => {
    render(React.createElement(MapsChooserHost, {}));
    // A place with no Google link: Apple Maps is the only choice.
    let result;
    act(() => { result = openMapsChooser({ place: VENUE, googleUrl: null }); });
    expect(result).toBe(true);
    expect(screen.queryByText('Open in')).toBeNull();
    expect(opened).toEqual([["https://maps.apple.com/?ll=40.6112,-75.3746&q=Lucky's%20Last%20Chance", '_blank', 'noopener,noreferrer']]);
  });

  test('an Android phone goes straight to Google Maps', () => {
    const ua = jest.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ANDROID);
    try {
      render(React.createElement(MapsChooserHost, {}));
      act(() => { openMapsChooser({ place: VENUE, googleUrl: GOOGLE }); });
      expect(screen.queryByText('Open in')).toBeNull();
      expect(opened).toEqual([[GOOGLE, '_blank', 'noopener,noreferrer']]);
    } finally {
      ua.mockRestore();
    }
  });

  test('if the Apple link cannot be built, the tap still opens Google Maps', () => {
    // What a label cut through an emoji did before: encodeURIComponent threw
    // inside the tap, and nothing opened at all.
    render(React.createElement(MapsChooserHost, {}));
    const encode = jest.spyOn(global, 'encodeURIComponent').mockImplementation(() => { throw new URIError('URI malformed'); });
    try {
      let result;
      act(() => { result = openMapsChooser({ place: VENUE, googleUrl: GOOGLE }); });
      expect(result).toBe(true);
      expect(opened).toEqual([[GOOGLE, '_blank', 'noopener,noreferrer']]);
    } finally {
      encode.mockRestore();
    }
  });

  test('an arriving SOS alarm takes the sheet down', () => {
    render(React.createElement(MapsChooserHost, {}));
    act(() => { openMapsChooser({ place: VENUE, googleUrl: GOOGLE }); });
    expect(screen.getByText('Open in')).toBeTruthy();
    act(() => { closeMapsChooser(); });
    expect(screen.queryByText('Open in')).toBeNull();
    expect(opened).toEqual([]);
    // With nothing open it does nothing.
    expect(() => act(() => { closeMapsChooser(); })).not.toThrow();
  });

  test("the sheet's bottom padding uses the app's safe-area token", () => {
    // index.css, SAFE-AREA CONTRACT rule 1. The token reads the inset
    // Capacitor injects first, where the web view's own env() is unreliable.
    const sheet = readSrc('components', 'ui', 'MapsChooser.js');
    expect(sheet).toContain("padding: '16px 16px calc(16px + var(--safe-bottom))'");
    expect(sheet).not.toContain('env(safe-area-inset-bottom)');
  });
});

describe('every way to a map goes through the sheet', () => {
  const app = readSrc('App.js');
  const venueSheet = readSrc('components', 'overlays', 'VenueDetailSheet.js');
  const flockDetail = readSrc('screens', 'FlockDetail.js');

  test('the app mounts the one sheet with the shared dialog behaviour', () => {
    expect(app).toContain("import MapsChooserHost, { openMapsChooser, closeMapsChooser } from './components/ui/MapsChooser';");
    expect(app).toContain('<MapsChooserHost DialogBehavior={DialogBehavior} />');
  });

  // Whole files, not line by line: the plan's old Directions call spread its
  // Google link over three lines, and a per-line check read none of them.
  // Every app source file is read; a Google Maps link may appear only as the
  // googleUrl handed to the sheet. The staff moderation console is not the
  // app, and the two files that build the sheet are its own.
  test('no map link anywhere in the app opens Google Maps directly', () => {
    const skip = new Set([
      path.join('website', 'ModerationDashboard.js'),
      path.join('lib', 'mapsLinks.js'),
      path.join('components', 'ui', 'MapsChooser.js'),
    ]);
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(SRC, dir), { withFileTypes: true })) {
        const rel = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(rel);
        } else if (/\.(jsx?|tsx?)$/.test(entry.name) && !/\.test\./.test(entry.name) && !skip.has(rel)) {
          files.push(rel);
        }
      }
    };
    walk('');
    expect(files).toContain('App.js');
    expect(files).toContain(path.join('screens', 'FlockDetail.js'));
    const googleMaps = /google\.[a-z.]+\/maps|maps\.google\.|goo\.gl\/maps|maps\.app\.goo\.gl/i;
    const direct = files.filter((rel) => {
      // A googleUrl value runs to the comma that ends its line.
      const text = readSrc(rel).replace(/googleUrl:[\s\S]*?,\r?\n/g, '');
      return googleMaps.test(text);
    });
    expect(direct).toEqual([]);
  });

  test('the venue sheet, a plan and an SOS alarm each open the sheet', () => {
    expect(venueSheet).toContain("import { openMapsChooser } from '../ui/MapsChooser';");
    expect(venueSheet).toMatch(/openMapsChooser\(\{\s*place: \{\s*name: venueDetailModal\.name,/);
    expect(flockDetail).toContain("import { openMapsChooser } from '../components/ui/MapsChooser';");
    expect(flockDetail).toMatch(/openMapsChooser\(\{\s*place: \{ name: flock\.venue, address: flock\.venueAddress, lat: flock\.venueLat, lng: flock\.venueLng \}/);
    expect(app).toMatch(/openMapsChooser\(\{\s*place: \{ lat: safetyAlert\.lat, lng: safetyAlert\.lng \}/);
  });

  test("an SOS alarm's map pin carries no name: the sender's name and their emergency position do not go to Apple together", () => {
    const sos = app.slice(app.indexOf('{safetyAlert.lat !== null && ('), app.indexOf('{SOSModal()}'));
    expect(sos).toContain('openMapsChooser({');
    expect(sos).not.toMatch(/name: safetyAlert\.name/);
    expect(sos).toContain('googleUrl: `https://maps.google.com/?q=${safetyAlert.lat},${safetyAlert.lng}`');
  });

  test('every arriving SOS alarm takes the maps sheet down before it is drawn', () => {
    // The sheet sits at zIndex 10050 and the alarm at 220: an alarm arriving
    // under an open sheet was covered, and Escape dismissed it unseen.
    const arrivals = (app.match(/setSafetyAlert\(\{/g) || []).length;
    expect(arrivals).toBeGreaterThanOrEqual(2);
    expect((app.match(/closeMapsChooser\(\);\s*setSafetyAlert\(\{/g) || []).length).toBe(arrivals);
  });

  test("a plan's Details hands the venue card the plan's coordinates, so Apple Maps has the pin before the details load", () => {
    expect(flockDetail).toContain('photo_url: flock.venuePhoto, lat: flock.venueLat, lng: flock.venueLng })}');
    expect(venueSheet).toMatch(/lat: at\.latitude \?\? at\.lat \?\? venueDetailModal\.lat,/);
  });

  test("the map's venue seeds and a quieter place nearby carry their coordinates too", () => {
    const map = readSrc('components', 'map', 'MapLibreMapView.js');
    expect(map).toContain('photo_url: v.photo_url, lat: v.location?.latitude, lng: v.location?.longitude });');
    expect(map).toContain('photo_url: venuePhoto, lat: fLat, lng: fLng });');
    const card = readSrc('components', 'venue', 'ConsumerVenueCard.js');
    expect(card).toContain('const pin = v.location || allVenues.find(x => x.place_id === pid)?.location;');
    expect(card).toContain('openVenueDetail(pid, { name: v.name, place_id: pid, lat: pin?.latitude, lng: pin?.longitude }, { panMap: true });');
  });
});
