/*
 * cloudflare/paint-first.js, the one script a prerendered marketing page
 * loads at parse time (scripts/build-cloudflare.js servableSnapshot). It must
 * fetch main.js and the page's chunks once the browser reports the first
 * contentful paint, exactly once, and never leave a browser without the app:
 * no paint timing means load at once, and a paint that is never reported
 * means load a second after the page has.
 */
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'cloudflare', 'paint-first.js'), 'utf8');

let observers;
let currentScript;

function run({ supported = ['paint', 'largest-contentful-paint'] } = {}) {
  currentScript = document.createElement('script');
  currentScript.setAttribute('data-main', '/static/js/main.1a2b.js');
  currentScript.setAttribute('data-chunks', '/static/js/landing.5e6f.chunk.js /static/js/4242.1b1b.chunk.js');
  Object.defineProperty(document, 'currentScript', { configurable: true, get: () => currentScript });
  observers = [];
  window.PerformanceObserver = class {
    constructor(cb) { this.cb = cb; this.disconnected = false; observers.push(this); }
    observe(opts) { this.opts = opts; }
    disconnect() { this.disconnected = true; }
  };
  window.PerformanceObserver.supportedEntryTypes = supported;
  // eslint-disable-next-line no-new-func
  new Function(SOURCE)();
}

function paint(names) {
  const list = { getEntriesByName: (n) => (names.includes(n) ? [{ name: n }] : []) };
  for (const o of observers) o.cb(list, o);
}

const scripts = () => Array.from(document.head.querySelectorAll('script[src]')).map((s) => s.getAttribute('src'));
const preloads = () => Array.from(document.head.querySelectorAll('link[rel="preload"][as="script"]')).map((l) => l.getAttribute('href'));

beforeEach(() => {
  document.head.innerHTML = '';
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  delete window.PerformanceObserver;
  delete document.currentScript;
});

test('nothing is fetched until the first contentful paint is reported, then everything once', () => {
  run();
  expect(observers).toHaveLength(1);
  expect(observers[0].opts).toEqual({ type: 'paint', buffered: true });
  expect(scripts()).toEqual([]);

  paint(['first-paint']);
  expect(scripts()).toEqual([]);

  paint(['first-paint', 'first-contentful-paint']);
  expect(preloads()).toEqual(['/static/js/landing.5e6f.chunk.js', '/static/js/4242.1b1b.chunk.js']);
  expect(scripts()).toEqual(['/static/js/main.1a2b.js']);
  expect(observers[0].disconnected).toBe(true);

  // The load fallback firing later changes nothing.
  window.dispatchEvent(new Event('load'));
  jest.advanceTimersByTime(5000);
  expect(scripts()).toEqual(['/static/js/main.1a2b.js']);
  expect(preloads()).toHaveLength(2);
});

test('a browser without paint timing loads the app at once', () => {
  run({ supported: ['resource', 'navigation'] });
  expect(observers).toHaveLength(0);
  expect(scripts()).toEqual(['/static/js/main.1a2b.js']);
});

test('a paint that is never reported still gets the app, a second after load', () => {
  run();
  window.dispatchEvent(new Event('load'));
  jest.advanceTimersByTime(999);
  expect(scripts()).toEqual([]);
  jest.advanceTimersByTime(1);
  expect(scripts()).toEqual(['/static/js/main.1a2b.js']);
});

test('the loader is plain ES5 that any browser parses', () => {
  // It runs before everything else on the page, outside webpack and Babel.
  expect(SOURCE).not.toMatch(/=>|\bconst\b|\blet\b|`|\?\.|\?\?/);
});
