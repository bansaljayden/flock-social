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
  const app = readSrc('App.js');

  test('the category initial is an own-property lookup', () => {
    // The result is interpolated into an innerHTML string, and
    // `initialMap['constructor']` answers with the source of a native function.
    expect(app).toMatch(/Object\.prototype\.hasOwnProperty\.call\(initialMap, category\)/);
  });
});
