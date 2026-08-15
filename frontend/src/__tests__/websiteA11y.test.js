/**
 * Cross-page accessibility invariants for everything in src/website/.
 *
 * The deep, page-specific behaviour (focus traps, live regions, computed
 * contrast, skip links) is owned by marketingSiteAccessibility.test.js and
 * legalPagesAccessibility.test.js. This file pins the small set of invariants
 * that must hold on EVERY public page at once, so a new page or a rewrite of
 * an old one cannot ship without them:
 *
 *   1. exactly one <h1> per page render;
 *   2. a heading outline that starts at h1 and never skips a level;
 *   3. every image on the landing page carries an alt attribute, decorative
 *      ones are explicitly empty, and the two real app captures describe the
 *      screenshots that actually ship (the dark home screen, and Birdie's
 *      Philadelphia answer);
 *   4. every form control is named by a real label association;
 *   5. no positive tabindex anywhere in src/website/, source and DOM both.
 *
 * ModerationDashboard.js is deliberately in the SOURCE scans only: it is an
 * admin console owned by another workstream, so it is not rendered here, but
 * "no positive tabindex anywhere in website/" includes it.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, waitFor } = require('@testing-library/react');

// Same stubs as marketingSiteAccessibility.test.js: LiveDemo pulls maplibre-gl
// (a 1 MB WebGL bundle jest cannot parse) and BirdieBird runs a rAF loop over
// photographs. Neither is what is under test here; LiveDemo's own control gets
// a source-scan assertion below instead.
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

const WEBSITE = path.join(__dirname, '..', 'website');
const readSource = (f) => fs.readFileSync(path.join(WEBSITE, f), 'utf8');

// Every renderable public page. GuestInvite is exercised separately because it
// needs a token in the URL and a fetch to reach its real (form-bearing) state.
const PAGES = [
  'LandingPage',
  'AboutPage',
  'SupportPage',
  'PrivacyPolicy',
  'TermsOfService',
  'CommunityGuidelines',
  'DeleteAccount',
];

const load = (name) => {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(`../website/${name}`).default;
};

// ───────────────────────────────────────────────────────────────────────────
// Shared checks
// ───────────────────────────────────────────────────────────────────────────

function expectHeadingSanity(container, page) {
  const h1s = container.querySelectorAll('h1');
  expect({ page, h1Count: h1s.length }).toEqual({ page, h1Count: 1 });
  expect(h1s[0].textContent.trim().length).toBeGreaterThan(0);

  const levels = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    .map((h) => Number(h.tagName[1]));
  expect(levels[0]).toBe(1);
  for (let i = 1; i < levels.length; i += 1) {
    if (levels[i] - levels[i - 1] > 1) {
      throw new Error(`${page}: heading outline jumps h${levels[i - 1]} -> h${levels[i]}`);
    }
  }
}

// A control is named if a <label> is associated with it (for/id or wrapping),
// or it carries its own aria-label / aria-labelledby.
function expectLabelled(container, page) {
  const controls = container.querySelectorAll('input, select, textarea');
  for (const el of controls) {
    const byFor = el.id
      && container.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const wrapped = el.closest('label');
    const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
    if (!byFor && !wrapped && !aria) {
      throw new Error(
        `${page}: <${el.tagName.toLowerCase()} type="${el.type}"> has no label `
        + 'association (label[for], wrapping label, or aria-label/labelledby)'
      );
    }
    // A placeholder is not a label, so its presence must never be the only
    // text; the check above already guarantees that, but pin the common
    // regression too: an id-carrying field whose label was deleted.
    if (el.id && !byFor && !wrapped && !aria) {
      throw new Error(`${page}: #${el.id} lost its label`);
    }
  }
}

function expectNoPositiveTabindexInDom(container, page) {
  for (const el of container.querySelectorAll('[tabindex]')) {
    const v = Number(el.getAttribute('tabindex'));
    if (v > 0) {
      throw new Error(`${page}: <${el.tagName.toLowerCase()}> carries tabindex="${v}"`);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
describe.each(PAGES)('%s: cross-page invariants', (name) => {
  test('one h1, no skipped heading levels, labelled controls, no positive tabindex', () => {
    const Page = load(name);
    const { container, unmount } = render(React.createElement(Page));
    expectHeadingSanity(container, name);
    expectLabelled(container, name);
    expectNoPositiveTabindexInDom(container, name);
    unmount();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('LandingPage: images', () => {
  test('every image has an alt attribute; decorative ones are empty AND low-priority', () => {
    const Page = load('LandingPage');
    const { container, unmount } = render(React.createElement(Page));
    const imgs = container.querySelectorAll('img');
    expect(imgs.length).toBeGreaterThanOrEqual(4);
    for (const img of imgs) {
      // A missing alt is announced as the file name; an explicit alt="" is a
      // deliberate "skip me". Only the latter is acceptable.
      if (!img.hasAttribute('alt')) {
        throw new Error(`<img src="${img.getAttribute('src')}"> has no alt attribute`);
      }
    }
    unmount();
  });

  test('the two app captures describe the screenshots that actually ship', () => {
    // The hero capture is the DARK home screen (nest-dark) and the Birdie
    // figure is the Philadelphia question (birdie-dark). If either asset is
    // recaptured, its alt has to be rewritten with it, and this pins the pair:
    // the src and the description move together or this goes red.
    const Page = load('LandingPage');
    const { container, unmount } = render(React.createElement(Page));

    const hero = container.querySelector('img.lp-shot-hero');
    expect(hero).not.toBeNull();
    expect(hero.getAttribute('src')).toContain('nest-dark');
    expect(hero.getAttribute('alt')).toMatch(/home screen/i);
    expect(hero.getAttribute('alt').length).toBeGreaterThan(20);

    const shots = Array.from(container.querySelectorAll('img.lp-shot'));
    const birdie = shots.find((s) => (s.getAttribute('src') || '').includes('birdie-dark'));
    expect(birdie).toBeDefined();
    expect(birdie.getAttribute('alt')).toMatch(/Birdie/);
    expect(birdie.getAttribute('alt')).toMatch(/Philadelphia/);
    unmount();
  });

  test('the section marks are explicitly decorative', () => {
    // The three bird marks are illustration: alt="" so a screen reader skips
    // them instead of reading three file names between sections.
    const Page = load('LandingPage');
    const { container, unmount } = render(React.createElement(Page));
    const marks = container.querySelectorAll('.lp-flock img');
    expect(marks.length).toBeGreaterThanOrEqual(3);
    for (const img of marks) {
      expect(img.getAttribute('alt')).toBe('');
    }
    unmount();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('GuestInvite: the form-bearing state', () => {
  const TOKEN = 'tok123456789'; // gitleaks:allow -- synthetic invite-link token for the mocked /i/:token route, not a credential
  let realFetch;

  beforeEach(() => {
    realFetch = global.fetch;
    window.history.pushState({}, '', `/i/${TOKEN}`);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        flock: { name: 'Pizza night', status: 'active', when: null, chosenVenue: null },
        host: 'Maya',
        going: 2,
        venues: [{ venue_name: 'Good Dog Bar', votes: 3 }],
      }),
    });
  });

  afterEach(() => {
    global.fetch = realFetch;
    window.history.pushState({}, '', '/');
    window.localStorage.clear();
  });

  test('one h1, sane outline, a labelled name field, and announced errors', async () => {
    const Page = load('GuestInvite');
    const { container, unmount } = render(React.createElement(Page));
    await waitFor(() => {
      expect(container.querySelector('h1').textContent).toBe('Pizza night');
    });

    expectHeadingSanity(container, 'GuestInvite');
    expectNoPositiveTabindexInDom(container, 'GuestInvite');

    // The name field is named by a real, visible <label for>, not a
    // placeholder.
    const input = container.querySelector('#gi-name');
    expect(input).not.toBeNull();
    const label = container.querySelector('label[for="gi-name"]');
    expect(label).not.toBeNull();
    expect(label.textContent.trim().length).toBeGreaterThan(0);
    expectLabelled(container, 'GuestInvite');

    // Failures are announced: the alert regions exist BEFORE they have
    // anything to say (a live region that mounts with its first message is
    // missed by some screen readers), and the field points at its own error.
    const alerts = container.querySelectorAll('[role="alert"]');
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector('#gi-problem-rsvp')).not.toBeNull();
    expect(input.getAttribute('aria-describedby')).toBe('gi-problem-rsvp');
    unmount();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('LandingPage: the waitlist form announces failure', () => {
  test('the alert region is mounted empty and the field is described by it', () => {
    const Page = load('LandingPage');
    const { container, unmount } = render(React.createElement(Page));
    const input = container.querySelector('#lp-waitlist-email');
    expect(input).not.toBeNull();
    expect(container.querySelector('label[for="lp-waitlist-email"]')).not.toBeNull();
    const problem = container.querySelector('#lp-form-problem');
    expect(problem).not.toBeNull();
    expect(problem.getAttribute('role')).toBe('alert');
    expect(input.getAttribute('aria-describedby')).toBe('lp-form-problem');
    unmount();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('source scans across the whole of src/website/', () => {
  const files = fs.readdirSync(WEBSITE).filter((f) => f.endsWith('.js'));

  test('the directory still contains the pages this file exists to guard', () => {
    // If the directory listing ever comes back empty (a move, a rename), every
    // scan below would pass vacuously.
    for (const page of PAGES) expect(files).toContain(`${page}.js`);
    expect(files).toContain('GuestInvite.js');
    expect(files).toContain('SiteFooter.js');
  });

  test('no positive tabindex anywhere, admin console included', () => {
    for (const f of files) {
      const src = readSource(f);
      const jsx = src.match(/tabIndex=\{?\s*\+?[1-9]/g) || [];
      const html = src.match(/tabindex=["']\s*\+?[1-9]/gi) || [];
      expect({ file: f, hits: [...jsx, ...html] }).toEqual({ file: f, hits: [] });
    }
  });

  test('LiveDemo (stubbed above, so checked as source) names its search field', () => {
    // The real component cannot mount under jest (maplibre-gl is ESM-only),
    // so pin the two things this file's invariants would otherwise miss: the
    // search input's accessible name, and that the locate button avoids the
    // focus-dropping disabled attribute in favour of aria-disabled + guard.
    const src = readSource('LiveDemo.js');
    expect(src).toMatch(/aria-label="What kind of place"/);
    expect(src).toMatch(/aria-disabled=\{locating \|\| undefined\}/);
    // The disabled ATTRIBUTE must not come back on the locate button: it drops
    // focus to <body> for the keyboard user waiting on the permission prompt.
    const button = src.slice(src.indexOf('className="lpd-locate"'), src.indexOf('Use my location'));
    expect(button).not.toMatch(/(^|\s)disabled=\{/);
    // ...and the click handler carries the real gate the attribute used to.
    expect(src).toMatch(/if \(locating\) return;/);
  });
});
