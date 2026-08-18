/**
 * TWO PRE-SHIP GAPS, PINNED: the FTC AI disclosure on the landing page, and the
 * tab title the logged-in app never wrote. Both are from PRESHIP-SWEEP.md
 * (findings R1 and Q5).
 *
 * 1. "BIRDIE IS AI", ON THE PAGE THAT SELLS BIRDIE.
 *    The privacy policy already named Google Gemini and listed exactly what a
 *    Birdie conversation sends. The landing page did not contain the word AI
 *    anywhere, and its Birdie copy read "Ask Birdie the way you'd ask a friend
 *    who knows the city." An assistant marketed as a friend, on a page that
 *    never says it is software, is the deceptive-advertising shape the FTC
 *    describes, and Flock is in App Store review with a 13+ audience.
 *
 *    The disclosure is one sentence pair sitting directly under that line, so
 *    the warm framing and the fact arrive together. This suite pins it as
 *    CONTENT rather than as a string in one file, because there are two files:
 *    api/marketing-page.js serves AI crawlers a block-for-block mirror of this
 *    page, and a disclosure that reaches humans but not the mirror (or the
 *    reverse) is a divergence the cloaking guarantee does not allow.
 *
 *    aiCrawlerSurface.test.js already requires deep equality between the two
 *    for the WHOLE page. What that suite cannot say is which sentence matters,
 *    so it would stay green if the disclosure were deleted from both files at
 *    once. That is the failure this file exists to catch: it names the claim,
 *    and it re-checks the mirror at the same position rather than trusting the
 *    other suite's equality to carry it.
 *
 * 2. THE APP HAD NO TITLE OF ITS OWN.
 *    public/index.html ships "Flock | Plans that actually happen", and every
 *    marketing and legal page overwrites it in a mount effect. App.js wrote
 *    document.title exactly zero times, so /app, every screen in it, and any
 *    bookmark made from it read as the landing page's ad copy. Asserted by
 *    source scan, the way screenBoundaryCoverage.test.js and
 *    appIconFloorAndAlerts.test.js assert App.js wiring: the file is a
 *    ~20,000-line monolith whose root component boots a session, and no test
 *    is going to mount it to read one string.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 *
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// Same two stubs, for the same reasons, as aiCrawlerSurface.test.js and
// marketingSiteAccessibility.test.js: LiveDemo pulls a 1 MB map engine and
// BirdieBird runs a rAF loop over photographs. Neither carries copy.
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

const LandingPage = require('../website/LandingPage').default;
const api = require('../../api/marketing-page.js');

const APP = fs
  .readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
  .replace(/\r\n/g, '\n');

// The disclosure, as one string. Written here in the same characters the page
// uses (a curly apostrophe in "app's"), because the mirror has to match the
// rendered text byte for byte and a straight quote is exactly the kind of
// difference a copy-paste introduces silently.
const DISCLOSURE =
  'Birdie is AI. It runs on Google Gemini, and the crowd numbers it quotes are the app’s own.';

// ───────────────────────────────────────────────────────────────────────────
// Extraction, matching aiCrawlerSurface.test.js's rules for the home page.
// Kept local rather than imported: those rules ARE the cloaking guarantee, and
// a second copy means loosening them in one place cannot quietly loosen this
// suite too.
// ───────────────────────────────────────────────────────────────────────────
const EXCLUDE_HOME = [
  '.lp-skip', 'header.lp-nav', '#lp-menu', '.lp-chat', '.lp-split',
  '.lp-sos-mail', '.lp-appstore', 'form.lp-form', '.lp-form-status',
  'figure', 'footer.lp-footer',
];

function extractBlocks(markup, excludeSelectors) {
  const host = document.createElement('div');
  host.innerHTML = markup;
  for (const sel of excludeSelectors) {
    host.querySelectorAll(sel).forEach((n) => n.remove());
  }
  host.querySelectorAll('[aria-hidden="true"], .pp-num, .pp-toc-num').forEach((n) => n.remove());
  host.querySelectorAll('br').forEach((n) => n.replaceWith(document.createTextNode(' ')));
  const blocks = [];
  host.querySelectorAll('h1,h2,h3,p,li,a.pp-contact-mail').forEach((el) => {
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    const tag = el.tagName === 'A' ? 'p' : el.tagName.toLowerCase();
    if (text) blocks.push([tag, text]);
  });
  return blocks;
}

const renderedHome = extractBlocks(
  renderToStaticMarkup(React.createElement(LandingPage)),
  EXCLUDE_HOME
);
const mirroredHome = api.PAGE_BLOCKS.home;

const texts = (blocks) => blocks.map(([, text]) => text);

// ═══════════════════════════════════════════════════════════════════════════
// 1. The disclosure reaches a human
// ═══════════════════════════════════════════════════════════════════════════
describe('the landing page says Birdie is AI', () => {
  test('the rendered page carries the disclosure as its own paragraph', () => {
    expect(renderedHome).toContainEqual(['p', DISCLOSURE]);
  });

  test('it names the model, so the "friend who knows the city" line cannot stand alone', () => {
    // Belt and braces on the two facts the sentence is carrying, in case a
    // future edit keeps the sentence and drops half of it.
    const all = texts(renderedHome).join('\n');
    expect(all).toMatch(/\bBirdie is AI\b/);
    expect(all).toMatch(/Google Gemini/);
  });

  test('the disclosure sits with the anthropomorphic line, not somewhere else on the page', () => {
    // Adjacency is the whole point. A reader who takes in the friend framing
    // and stops reading must already have been told. Directly after, in DOM
    // order, is the strongest version of that this page's structure allows.
    const all = texts(renderedHome);
    const friend = all.findIndex((t) => /ask a friend who knows the city/.test(t));
    const disclosure = all.indexOf(DISCLOSURE);
    expect(friend).toBeGreaterThanOrEqual(0);
    expect(disclosure).toBe(friend + 1);
  });

  test('no em dash in the disclosure', () => {
    // SLOP-AUDIT rule 1. An en dash is allowed in numeric ranges elsewhere on
    // the page; neither belongs in this sentence.
    expect(DISCLOSURE).not.toMatch(/[—–]/);
    const paragraph = texts(renderedHome).find((t) => t.startsWith('Birdie is AI.'));
    expect(paragraph).toBeDefined();
    expect(paragraph).not.toMatch(/[—–]/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The disclosure reaches a crawler, in the same place
// ═══════════════════════════════════════════════════════════════════════════
describe('the AI-crawler mirror carries the same disclosure', () => {
  test('api/marketing-page.js serves it verbatim', () => {
    expect(mirroredHome).toContainEqual(['p', DISCLOSURE]);
  });

  test('at the same index as the rendered page, so the mirror stays block for block', () => {
    expect(mirroredHome.indexOf(mirroredHome.find(([, t]) => t === DISCLOSURE)))
      .toBe(renderedHome.indexOf(renderedHome.find(([, t]) => t === DISCLOSURE)));
    // And the whole page, which is what aiCrawlerSurface.test.js guards. Said
    // again here so a failure in THIS file is self-explaining: if the two
    // disagree, the disclosure assertions above are meaningless either way.
    expect(mirroredHome).toEqual(renderedHome);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. The app shell writes a tab title
// ═══════════════════════════════════════════════════════════════════════════
describe('the logged-in app has a title of its own', () => {
  test('App.js writes document.title', () => {
    expect(APP).toMatch(/document\.title\s*=/);
  });

  test('it is the brand, not the landing page\'s marketing headline', () => {
    const writes = APP.match(/document\.title\s*=\s*'[^']*'/g) || [];
    expect(writes.length).toBeGreaterThan(0);
    expect(writes).toContain("document.title = 'Flock'");
    for (const write of writes) {
      expect(write).not.toMatch(/Plans that actually happen/i);
    }
  });

  test('it runs once on mount, not on every render', () => {
    // A bare `document.title = ...` in the component body would also pass the
    // assertions above and would rewrite the title on every state change the
    // app makes, which is most of what the app does.
    expect(APP).toMatch(/useEffect\(\(\) => \{\s*document\.title = 'Flock';\s*\}, \[\]\);/);
  });
});
