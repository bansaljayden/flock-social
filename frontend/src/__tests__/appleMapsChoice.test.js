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
const { openMapsChooser } = MapsChooserModule;

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

  test('with no coordinates the address locates it and the name labels it', () => {
    expect(appleMapsUrl({ name: 'Lucky', address: '125 E 3rd St, Bethlehem' }))
      .toBe('https://maps.apple.com/?address=125%20E%203rd%20St%2C%20Bethlehem&q=Lucky');
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
});

describe('which apps are offered, and in what order', () => {
  test('an iPhone, an iPad (which reports a Mac) and the iOS app list Apple Maps first', () => {
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

  test('a Google link that is not https is left out', () => {
    const choices = mapsChoices({ place: VENUE, googleUrl: 'javascript:alert(1)' }, { apple: true, android: false });
    expect(choices.map((c) => c.label)).toEqual(['Apple Maps']);
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
});

describe('every way to a map goes through the sheet', () => {
  const app = readSrc('App.js');
  const venueSheet = readSrc('components', 'overlays', 'VenueDetailSheet.js');
  const flockDetail = readSrc('screens', 'FlockDetail.js');

  test('the app mounts the one sheet with the shared dialog behaviour', () => {
    expect(app).toContain("import MapsChooserHost, { openMapsChooser } from './components/ui/MapsChooser';");
    expect(app).toContain('<MapsChooserHost DialogBehavior={DialogBehavior} />');
  });

  test('no map link in these three files opens Google Maps directly any more', () => {
    for (const [name, text] of [['App.js', app], ['VenueDetailSheet.js', venueSheet], ['FlockDetail.js', flockDetail]]) {
      const direct = text.split('\n').filter((line) => /href=\{`https:\/\/(maps\.google\.com|www\.google\.com\/maps)/.test(line)
        || /openExternal\([^)]*google\.com\/maps/.test(line));
      expect([name, direct]).toEqual([name, []]);
    }
  });

  test('the venue sheet, a plan and an SOS alarm each open the sheet', () => {
    expect(venueSheet).toContain("import { openMapsChooser } from '../ui/MapsChooser';");
    expect(venueSheet).toMatch(/openMapsChooser\(\{\s*place: \{\s*name: venueDetailModal\.name,/);
    expect(flockDetail).toContain("import { openMapsChooser } from '../components/ui/MapsChooser';");
    expect(flockDetail).toMatch(/openMapsChooser\(\{\s*place: \{ name: flock\.venue, address: flock\.venueAddress, lat: flock\.venueLat, lng: flock\.venueLng \}/);
    expect(app).toMatch(/openMapsChooser\(\{\s*place: \{ name: safetyAlert\.name, lat: safetyAlert\.lat, lng: safetyAlert\.lng \}/);
  });

  test("a plan's Details hands the venue card the plan's coordinates, so Apple Maps has the pin before the details load", () => {
    expect(flockDetail).toContain('photo_url: flock.venuePhoto, lat: flock.venueLat, lng: flock.venueLng })}');
    expect(venueSheet).toMatch(/lat: at\.latitude \?\? at\.lat \?\? venueDetailModal\.lat,/);
  });
});
