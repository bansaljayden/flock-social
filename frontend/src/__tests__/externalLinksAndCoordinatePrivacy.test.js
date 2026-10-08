// ---------------------------------------------------------------------------
// Two client-side security properties that had no test behind them.
//
// 1. COORDINATES DO NOT LEAVE THE DEVICE INSIDE A URL.
//    Four first-party endpoints take the handset's live GPS fix as a query
//    string (/api/weather, /api/weather/forecast, /api/events/search,
//    /api/events/featured). That is the feature working. What is not the
//    feature working is Sentry copying the url of every fetch into a
//    breadcrumb, a request.url, a transaction name and a span description, and
//    PostHog copying url strings into event properties, both of them attached
//    to the account id api.js identifies with, for a user who may be 13.
//    analyticsPrivacy.test.js already forbids a tracked property KEY that could
//    carry coordinates; these tests cover the same value arriving inside a URL.
//    The venue map previews carry a position in the URL path and the map key
//    in the query, so both are swept too, and the previews may be built only
//    for venues: the files allowed to draw one are listed below.
//
// 2. A NEW TAB GETS NO HANDLE BACK TO THE APP.
//    Browsers imply noopener for an anchor with target="_blank" and do NOT
//    imply it for window.open. Every anchor in the app already carries
//    rel="noopener noreferrer"; the window.open calls carried nothing, so the
//    page that opened kept a live window.opener and could repaint the tab
//    behind it with a sign-in screen the user has no reason to distrust. The
//    destinations include a Ticketmaster event url and a wallet web link, which
//    are strings that arrive over the API from somebody else.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test --watchAll=false
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

jest.mock('react-dom/client', () => ({
  createRoot: () => ({ render: () => {} }),
}));

const SRC = path.resolve(__dirname, '..');
const readSrc = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

let scrubUrlTokens;

beforeAll(() => {
  delete process.env.REACT_APP_POSTHOG_KEY;
  delete process.env.REACT_APP_SENTRY_DSN;
  ({ scrubUrlTokens } = require('../index'));
});

describe('scrubUrlTokens redacts a position, not a place name', () => {
  test('the lat/lon pair the weather endpoints carry', () => {
    expect(scrubUrlTokens('/api/weather?lat=40.6259&lon=-75.3705'))
      .toBe('/api/weather?lat=redacted&lon=redacted');
    expect(scrubUrlTokens('https://api.flock/api/weather/forecast?lat=40.6&lon=-75.4&units=i'))
      .toBe('https://api.flock/api/weather/forecast?lat=redacted&lon=redacted&units=i');
    expect(scrubUrlTokens('/x?latitude=40.6&longitude=-75.4'))
      .toBe('/x?latitude=redacted&longitude=redacted');
    expect(scrubUrlTokens('/x?lng=-75.4')).toBe('/x?lng=redacted');
  });

  test('the "lat,lng" pair the events endpoints pass as location', () => {
    expect(scrubUrlTokens('/api/events/featured?location=40.6259,-75.3705&interests=food'))
      .toBe('/api/events/featured?location=redacted&interests=food');
    // encodeURIComponent is what services/api.js sends, so the encoded comma is
    // the form this actually has to catch on the wire.
    expect(scrubUrlTokens('/api/events/search?location=40.6259%2C-75.3705&query=fest'))
      .toBe('/api/events/search?location=redacted&query=fest');
  });

  test('a place name a person typed stays readable, and near-miss parameters are untouched', () => {
    expect(scrubUrlTokens('/api/events/search?location=Bethlehem'))
      .toBe('/api/events/search?location=Bethlehem');
    expect(scrubUrlTokens('/jobs?relocation=yes')).toBe('/jobs?relocation=yes');
    expect(scrubUrlTokens('/menu?flat=1&salon=2')).toBe('/menu?flat=1&salon=2');
    expect(scrubUrlTokens('/privacy?tab=1')).toBe('/privacy?tab=1');
  });

  test('it still does everything it did before', () => {
    expect(scrubUrlTokens('https://flockcorp.com/i/aB3_x-9Zq')).toBe('https://flockcorp.com/i/:token');
    expect(scrubUrlTokens('/reset-password#token=abc.def')).toBe('/reset-password#token=redacted');
    expect(scrubUrlTokens(42)).toBe(42);
    expect(scrubUrlTokens(null)).toBe(null);
  });
});

// The static map previews (lib/staticMapUrl.js) put coordinates in the URL
// PATH and in markers=, and the MapTiler key in key=. Sentry's resource spans
// record image URLs, so the sweep has to know those shapes too.
describe('scrubUrlTokens redacts a static map preview', () => {
  test('the /static/<lng>,<lat>,<zoom>/ path segment, and the bounds form', () => {
    expect(scrubUrlTokens('https://api.maptiler.com/maps/streets-v4/static/-75.37461,40.61123,16/375x140@2x.webp'))
      .toBe('https://api.maptiler.com/maps/streets-v4/static/redacted/375x140@2x.webp');
    expect(scrubUrlTokens('GET https://api.maptiler.com/maps/x/static/-75.4,40.6,-75.3,40.7/430x220.png'))
      .toBe('GET https://api.maptiler.com/maps/x/static/redacted/430x220.png');
    expect(scrubUrlTokens('/maps/x/static/-75.4%2C40.6%2C16/88x88.png'))
      .toBe('/maps/x/static/redacted/88x88.png');
  });

  test('markers= goes whole, encoded or not', () => {
    expect(scrubUrlTokens('/s.webp?attribution=false&markers=icon%3Ahttps%3A%2F%2Fwww.flockcorp.com%2Fmap%2Fpin-light.svg%7Canchor%3Abottom%7Cscale%3A2%7C-75.37461%2C40.61123'))
      .toBe('/s.webp?attribution=false&markers=redacted');
    expect(scrubUrlTokens('/s.png?markers=icon:https://x/p.svg|anchor:bottom|-75.4,40.6&attribution=false'))
      .toBe('/s.png?markers=redacted&attribution=false');
  });

  test('key= is redacted on any host, and only as a whole parameter name', () => {
    expect(scrubUrlTokens('https://api.maptiler.com/maps/basic-v2/style.json?key=AbC123xyz'))
      .toBe('https://api.maptiler.com/maps/basic-v2/style.json?key=redacted');
    expect(scrubUrlTokens('/a?x=1&key=AbC&y=2')).toBe('/a?x=1&key=redacted&y=2');
    expect(scrubUrlTokens('/a?monkey=1&keys=2&apikeyx=3')).toBe('/a?monkey=1&keys=2&apikeyx=3');
  });

  test('build assets and the auto-fit endpoint carry no coordinates and are untouched', () => {
    expect(scrubUrlTokens('https://www.flockcorp.com/static/js/main.4f2a1c.js')).toBe('https://www.flockcorp.com/static/js/main.4f2a1c.js');
    expect(scrubUrlTokens('/static/media/logo.2b3c.svg')).toBe('/static/media/logo.2b3c.svg');
    expect(scrubUrlTokens('/maps/x/static/auto/375x140.png')).toBe('/maps/x/static/auto/375x140.png');
  });

  test('a URL the builder actually makes leaves with no coordinate and no key in it', () => {
    jest.isolateModules(() => {
      process.env.REACT_APP_MAPTILER_KEY = 'pk-preview-test-key';
      try {
        const { venueStaticMapUrl } = require('../lib/staticMapUrl');
        for (const dark of [false, true]) {
          for (const size of ['strip', 'sheet', 'thumb']) {
            const url = venueStaticMapUrl({ lat: 40.611234, lng: -75.374612, size, dark });
            expect(url).toContain('40.61123');
            const out = scrubUrlTokens(`GET ${url}`);
            expect(out).not.toMatch(/40\.6112|75\.3746/);
            expect(out).not.toMatch(/40\.61123|%2C40/);
            expect(out).not.toContain('pk-preview-test-key');
            expect(out).toContain('key=redacted');
            expect(out).toContain('markers=redacted');
            expect(out).toContain('/static/redacted/');
          }
        }
      } finally {
        delete process.env.REACT_APP_MAPTILER_KEY;
      }
    });
  });
});

// A person's position must never go into a third-party URL from the handset.
// The static map builder is for venues, and this is the list of files allowed
// to reach it. A live location card, an SOS alarm (App.js) or a member marker
// that wanted a picture would have to be added here, in review, on purpose.
describe('static map previews are for venues only', () => {
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full, out);
      } else if (/\.jsx?$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  };
  const importers = (re) => walk(SRC)
    .filter((file) => re.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
    .sort();

  test('only the venue map component imports the URL builder', () => {
    expect(importers(/from\s+['"][./]*(?:lib\/)?staticMapUrl['"]|require\(\s*['"][./]*(?:lib\/)?staticMapUrl['"]\s*\)/))
      .toEqual(['components/map/StaticVenueMap.js']);
  });

  test("only a plan's venue card and the venue sheet draw a preview", () => {
    expect(importers(/from\s+['"][./]*(?:components\/)?(?:map\/)?StaticVenueMap['"]|require\(\s*['"][./]*(?:components\/)?(?:map\/)?StaticVenueMap['"]\s*\)/))
      .toEqual(['components/overlays/VenueDetailSheet.js', 'screens/FlockDetail.js']);
  });

  test('no location card, SOS surface or member file mentions it at all', () => {
    const people = walk(SRC)
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'))
      .filter((rel) => rel === 'App.js' || /LocationCard|SOS|Safety|Member|Roster|Trusted/i.test(rel));
    expect(people).toContain('App.js');
    for (const rel of people) {
      const text = readSrc(...rel.split('/'));
      expect(`${rel}: ${/staticMapUrl|StaticVenueMap|venueStaticMapUrl/.test(text)}`).toBe(`${rel}: false`);
    }
  });
});

describe('the fetch url Sentry records is swept everywhere it appears', () => {
  const index = readSrc('index.js');

  test('spans and the trace context are scrubbed, not only the transaction name', () => {
    // browserTracingIntegration writes "GET <url>" as span.description and the
    // same url into span.data / contexts.trace.data. Scrubbing only
    // event.transaction left the string one field to the right.
    expect(index).toMatch(/const scrubSentrySpans =/);
    expect(index).toMatch(/span\.description = scrubUrlTokens\(span\.description\)/);
    expect(index).toMatch(/event\?\.contexts\?\.trace\?\.data/);
  });

  test('both Sentry hooks call it', () => {
    expect(index.match(/scrubSentrySpans\(event\);/g) || []).toHaveLength(2);
  });
});

describe('services/api.js builds its query strings with encodeURIComponent', () => {
  const api = readSrc('services', 'api.js');

  test('the events endpoints encode location, radius and category', () => {
    expect(api).toMatch(/\/api\/events\/search\?location=\$\{encodeURIComponent\(location\)\}/);
    expect(api).toMatch(/\/api\/events\/featured\?location=\$\{encodeURIComponent\(location\)\}/);
    expect(api).toMatch(/&radius=\$\{encodeURIComponent\(options\.radius\)\}/);
  });

  test('no query VALUE in this file is interpolated raw', () => {
    // Keys are ours; values come from callers. `=${x}` with no encoder around
    // x is the shape that lets a value end its own parameter and start another.
    const raw = [];
    const re = /[?&][A-Za-z_]+=\$\{([^}]+)\}/g;
    let m;
    while ((m = re.exec(api)) !== null) {
      const expr = m[1];
      if (/encodeURIComponent|^(?:lat|lon|localHour|localDay|start|end|hours)$/.test(expr)) continue;
      if (/now\.get(?:Hours|Day)\(\)/.test(expr)) continue;
      raw.push(m[0]);
    }
    expect(raw).toEqual([]);
  });
});

describe('every new tab is opened without an opener', () => {
  const app = readSrc('App.js');

  test('App.js has one gate for external links and it passes noopener', () => {
    expect(app).toMatch(/const openExternal = \(u\) => \{/);
    expect(app).toMatch(/window\.open\(url, '_blank', 'noopener,noreferrer'\)/);
    // The gate is httpUrl, so a non-http(s) value opens nothing rather than a
    // blank tab on the string "null".
    expect(app).toMatch(/const url = httpUrl\(u\);/);
  });

  test('no call site in src/ opens a window with a bare target', () => {
    const walk = (dir, out = []) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full, out);
        } else if (/\.jsx?$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) {
          out.push(full);
        }
      }
      return out;
    };
    const offenders = [];
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      const re = /\b\w*\.?open\(([^)]*)'_blank'\s*\)/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        // The wallet deep link is the one deliberate exception: a custom scheme
        // has no window on the far side to hold an opener, and
        // attemptPaymentHandoff's timing race is measured against the bare call.
        if (/appUrl/.test(m[1])) continue;
        offenders.push(`${path.relative(SRC, file)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the map marker label cannot be built from a prototype property', () => {
  // The map is components/map/MapLibreMapView.js since 2026-09-13, and the pin
  // builder that does this lookup went with it. Read there, because a pattern
  // pointed at App.js would now match nothing and report a clean sink.
  const map = readSrc('components', 'map', 'MapLibreMapView.js');

  test('the category initial is an own-property lookup', () => {
    // The result is interpolated into an innerHTML string, and
    // `initialMap['constructor']` answers with the source of a native function.
    expect(map).toMatch(/Object\.prototype\.hasOwnProperty\.call\(initialMap, category\)/);
  });
});
