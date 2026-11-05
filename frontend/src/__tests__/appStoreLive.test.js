/**
 * FLOCK IS ON THE APP STORE (Apple released 1.0 for iPhone on 2026-11-04).
 *
 * Until that day every public surface said, correctly, that the iPhone app was
 * in review, or not on the App Store yet, or would be "out" later; the home
 * page collected emails to hear the moment it was. This suite pins the other
 * side of that day:
 *
 *   1. the badge is Apple's own artwork, byte for byte, and links to the
 *      listing everywhere it appears (home twice, /how-it-works, /about, /tap);
 *   2. the day itself is on the record: the dated line in the home hero and
 *      the November 4, 2026 milestone on /about;
 *   3. nothing public still says the app is not out, in review or TestFlight
 *      only, and the JSON-LD names the listing as the app's.
 *
 * Apple's badge rules (artwork, size, clear space, no animation, credit line)
 * are written out in src/website/AppStoreBadge.js; the no-animation rule is
 * also held by marketingSiteAccessibility.test.js.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false appStoreLive
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react');

jest.mock('../website/LiveDemo', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../components/ui/BirdieBird', () => ({
  __esModule: true,
  default: () => null,
  WARM_BIRD: { body: '', head: '', flap: null, neck: '0 0' },
  BIRDIE: { body: '', head: '', flap: null, neck: '0 0' },
}));
// /tap records its taps through services/api.js, which it imports lazily.
jest.mock('../services/api', () => ({
  trackNfcTap: jest.fn(),
  trackNfcAction: jest.fn(),
}));

const FRONTEND = path.join(__dirname, '..', '..');
const WEBSITE = path.join(__dirname, '..', 'website');
const read = (...p) => fs.readFileSync(path.join(FRONTEND, ...p), 'utf8');

const LISTING = 'https://apps.apple.com/app/id6781442127';
const BADGE_FILE = path.join(FRONTEND, 'public', 'marks', 'download-on-the-app-store-black.svg');
// sha256 of the black US-English badge as Apple's badge service served it on
// 2026-11-05 (toolbox.marketingtools.apple.com/api/v2/badges/
// download-on-the-app-store/black/en-us). It is LF-only, so a checkout that
// writes CRLF is folded back before hashing.
const APPLE_BADGE_SHA256 = 'a26fc5b38380272c92e9019a2eb8b45542a66814b3e2b203772db8904b9fb99f';

const AppStoreBadge = require('../website/AppStoreBadge').default;
const { APP_STORE_URL, APP_STORE_BADGE } = require('../website/AppStoreBadge');
const LandingPage = require('../website/LandingPage').default;
const AboutPage = require('../website/AboutPage').default;
const HowItWorksPage = require('../website/HowItWorksPage').default;
const TapPage = require('../website/TapPage').default;
const api = require('../services/api');

const flat = (s) => s.replace(/\s+/g, ' ').trim();

// The home page asks /api/pro-offer on mount; nothing here should reach a network.
let realFetch;
beforeEach(() => {
  realFetch = global.fetch;
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }));
});
afterEach(() => {
  delete window.Capacitor;
  global.fetch = realFetch;
});

// ───────────────────────────────────────────────────────────────────────────
describe("Apple's badge, and only Apple's", () => {
  test('the file is the badge Apple serves, unmodified', () => {
    const bytes = fs.readFileSync(BADGE_FILE).toString('latin1').replace(/\r\n/g, '\n');
    expect(crypto.createHash('sha256').update(bytes, 'latin1').digest('hex')).toBe(APPLE_BADGE_SHA256);
    // Apple's own title for the artwork: the black (preferred) US/UK badge.
    expect(bytes).toContain('<title>Download_on_the_App_Store_Badge_US-UK_RGB_blk_4SVG_092917</title>');
    // Plain artwork: nothing that runs and nothing fetched from anywhere.
    expect(bytes).not.toMatch(/<script|href=|on[a-z]+=/i);
  });

  test('the component links that file to the listing, named by the badge\'s words', () => {
    expect(APP_STORE_URL).toBe(LISTING);
    expect(APP_STORE_BADGE).toBe('/marks/download-on-the-app-store-black.svg');
    const { container } = render(React.createElement(AppStoreBadge, { className: 'x' }));
    const a = container.querySelector('a');
    expect(a.getAttribute('href')).toBe(LISTING);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    const img = a.querySelector('img');
    expect(img.getAttribute('src')).toBe('/marks/download-on-the-app-store-black.svg');
    expect(img.getAttribute('alt')).toBe('Download on the App Store');
    // The artwork's own 119.66 x 40 box, so the space is held before it loads.
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['120', '40']);
  });

  test('no Apple logo is drawn anywhere on the site outside the badge', () => {
    // The homemade badge and /tap's button both drew the Apple mark as an SVG
    // path, a standalone Apple logo that Apple's guidelines do not allow.
    for (const f of fs.readdirSync(WEBSITE).filter((n) => n.endsWith('.js'))) {
      expect([f, fs.readFileSync(path.join(WEBSITE, f), 'utf8').includes('M17.05 12.54')]).toEqual([f, false]);
    }
  });

  test('every link to Flock on the App Store is the one listing', () => {
    const ids = new Set();
    for (const f of fs.readdirSync(WEBSITE).filter((n) => n.endsWith('.js'))) {
      for (const m of fs.readFileSync(path.join(WEBSITE, f), 'utf8').matchAll(/apps\.apple\.com\/app\/[^'"\s)]+/g)) ids.add(m[0]);
    }
    expect([...ids]).toEqual(['apps.apple.com/app/id6781442127']);
  });

  test('Apple and the Apple logo are credited once, in the footer', () => {
    const footer = read('src', 'website', 'SiteFooter.js');
    expect(flat(footer)).toContain('Apple, the Apple logo and iPhone are trademarks of Apple Inc., registered in the U.S. and other countries. App Store is a service mark of Apple Inc., registered in the U.S. and other countries.');
    const { container } = render(React.createElement(LandingPage));
    expect(container.querySelectorAll('footer .lp-footer-tm')).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the home page', () => {
  test('the hero carries the badge and the day, outside the part that moves', () => {
    const { container } = render(React.createElement(LandingPage));
    const row = container.querySelector('.lp-hero .lp-hero-store');
    expect(row).not.toBeNull();
    expect(row.closest('.lp-hero-copy')).toBeNull();
    expect(row.querySelector('a.lp-appstore').getAttribute('href')).toBe(LISTING);
    const note = row.querySelector('.lp-hero-store-note');
    expect(flat(note.textContent)).toBe('Now on the App Store. Released November 4, 2026');
    expect(note.querySelector('time').getAttribute('dateTime') || note.querySelector('time').getAttribute('datetime')).toBe('2026-11-04');
  });

  test('#get leads with the badge and points anyone without an iPhone at the web sign-up', () => {
    const { container } = render(React.createElement(LandingPage));
    const band = container.querySelector('#get');
    expect(flat(band.textContent)).toContain('Flock is on the App Store, free for iPhone.');
    expect(flat(band.textContent)).toContain('No iPhone? Flock runs in your browser too. Create your account.');
    const first = band.querySelector('a[href]');
    expect(first.classList.contains('lp-appstore')).toBe(true);
    expect(band.querySelector('a[href="/signup"]')).not.toBeNull();
    expect(band.querySelector('form, input')).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('/about', () => {
  test('November 4, 2026 is on the record, as the milestone the others led to', () => {
    const { container } = render(React.createElement(AboutPage));
    const items = Array.from(container.querySelectorAll('.ab-milestones li'));
    const last = items[items.length - 1];
    expect(flat(last.textContent)).toBe('November 4, 2026 Flock is on the App Store.');
    expect(last.classList.contains('is-milestone')).toBe(true);
    const when = last.querySelector('time.ab-when');
    expect(when.getAttribute('dateTime') || when.getAttribute('datetime')).toBe('2026-11-04');
    // Only that one entry is set apart.
    expect(container.querySelectorAll('.ab-milestones li.is-milestone')).toHaveLength(1);
  });

  test('the October entry says what happened then, and nothing says "in review"', () => {
    const { container } = render(React.createElement(AboutPage));
    const text = Array.from(container.querySelectorAll('.ab-milestones li')).map((li) => flat(li.textContent));
    expect(text).toContain('October 2026 iPhone app submitted to the App Store.');
    expect(flat(container.textContent)).not.toMatch(/in review|App Store review/i);
  });

  test('where things stand says it first, with the badge under it', () => {
    const { container } = render(React.createElement(AboutPage));
    const now = container.querySelector('section[aria-labelledby="ab-h-now"]');
    expect(flat(now.querySelector('p').textContent)).toBe('Flock is on the App Store for iPhone, and the web app is live at flockcorp.com.');
    expect(now.querySelector('.ab-store a.lp-appstore').getAttribute('href')).toBe(LISTING);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('/how-it-works', () => {
  test('its closing band offers the App Store first, then the web', () => {
    const { container } = render(React.createElement(HowItWorksPage));
    const band = container.querySelector('section[aria-labelledby="hw-h-try"]');
    expect(flat(band.textContent)).toContain('Flock is on the App Store for iPhone, and it runs in your browser too.');
    expect(flat(band.textContent)).not.toMatch(/with Apple for review/);
    const hrefs = Array.from(band.querySelectorAll('a[href]')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([LISTING, '/signup', '/app']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('/tap', () => {
  test('the badge closes the stack, says nothing is missing, and records the tap', async () => {
    const { container } = render(React.createElement(TapPage));
    const actions = container.querySelector('.tap-actions');
    const controls = Array.from(actions.children);
    expect(controls).toHaveLength(4);
    const badge = controls[3];
    expect(badge.classList.contains('tap-appstore')).toBe(true);
    expect(badge.getAttribute('href')).toBe(LISTING);
    expect(badge.querySelector('img').getAttribute('alt')).toBe('Download on the App Store');
    expect(flat(container.querySelector('.tap-lead').textContent)).toMatch(/It is free, in this browser and on the App Store\.$/);
    expect(flat(container.textContent)).not.toMatch(/nothing to download/);
    fireEvent.click(badge);
    await waitFor(() => expect(api.trackNfcAction).toHaveBeenCalledWith(expect.any(String), 'app_store'));
  });

  test('inside the iPhone app there is nothing to download, so no badge', () => {
    window.Capacitor = { isNativePlatform: () => true };
    const { container } = render(React.createElement(TapPage));
    expect(container.querySelector('.tap-appstore')).toBeNull();
    expect(container.querySelectorAll('.tap-actions > *')).toHaveLength(3);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('nothing public says the app is not out', () => {
  const STALE = /in App Store review|now in review|with Apple for review|not on the App Store yet|cannot be downloaded|once it is out|the moment the iPhone app is out|is on TestFlight|TestFlight, not|Join the waitlist|leave your email/i;

  test.each([
    ['home', LandingPage],
    ['/about', AboutPage],
    ['/how-it-works', HowItWorksPage],
    ['/tap', TapPage],
  ])('%s, as rendered', (name, Page) => {
    const { container } = render(React.createElement(Page));
    expect([name, (flat(container.textContent).match(STALE) || [])[0]]).toEqual([name, undefined]);
  });

  test.each([
    ['api/marketing-page.js'],
    ['public/llms.txt'],
    ['public/index.html'],
    ['src/screens/ProfileSettings.js'],
  ])('%s', (rel) => {
    const body = flat(read(...rel.split('/')));
    expect([rel, (body.match(STALE) || [])[0]]).toEqual([rel, undefined]);
  });

  test('llms.txt says where to get it and since when', () => {
    const llms = flat(read('public', 'llms.txt'));
    expect(llms).toContain(`Flock is on the App Store for iPhone, free, at ${LISTING} (released November 4, 2026)`);
  });

  test('the JSON-LD names the listing as the app\'s, and never as the company\'s', () => {
    const html = read('public', 'index.html');
    const graph = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1])['@graph'];
    const app = graph.find((e) => e['@id'] === 'https://www.flockcorp.com/#app');
    expect(app.sameAs).toEqual([LISTING]);
    expect(app.installUrl).toBe(LISTING);
    expect(app.operatingSystem).toMatch(/^iOS/);
    expect(app.operatingSystem).toMatch(/web browser/);
    // The listing's seller is the developer account's holder, not the LLC.
    const org = graph.find((e) => e['@type'] === 'Organization');
    expect(org.sameAs.some((u) => /apps\.apple\.com/.test(u))).toBe(false);
  });
});
