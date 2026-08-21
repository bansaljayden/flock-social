/**
 * SiteFooter: the one footer shared by the seven public pages.
 *
 * WHY THIS FILE EXISTS. The seven pages (LandingPage, AboutPage, SupportPage,
 * PrivacyPolicy, TermsOfService, CommunityGuidelines, DeleteAccount) each
 * hand-rolled a footer, and the copies had drifted three ways: About and
 * Support had the mailbox but no legal links, Privacy had legal links but no
 * mailbox, and Terms, Guidelines and Delete account had nothing but a
 * copyright line. SLOP-AUDIT A5 requires the real legal links on the public
 * site, and /delete-account is the public URL Google Play requires, so the
 * footer is the surface that has to carry them everywhere. The extraction into
 * src/website/SiteFooter.js is only worth anything if the hand-rolled copies
 * cannot quietly come back, which is what this file pins.
 *
 * WHAT IS DELIBERATELY NOT HERE. GuestInvite keeps its own minimal gi-footer:
 * it is the page an invited stranger lands on, it is not one of the seven, and
 * its two-link footer (Privacy, Terms) is part of that page's own tested
 * design. ModerationDashboard is an internal console, not a public page.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 *
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render } = require('@testing-library/react');

// Same stubs as marketingSiteAccessibility.test.js: LiveDemo pulls a 1 MB map
// engine and BirdieBird runs a rAF loop over photographs; neither is a footer.
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
const read = (f) => fs.readFileSync(path.join(WEBSITE, f), 'utf8');

const PAGES = [
  'LandingPage',
  'AboutPage',
  'SupportPage',
  'PrivacyPolicy',
  'TermsOfService',
  'CommunityGuidelines',
  'DeleteAccount',
];

// NOTE: nothing here resets the module registry, for the reason the other
// suites give: a second copy of React breaks every hook in the first.
const load = (name) => {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(`../website/${name}`).default;
};

const LEGAL_HREFS = ['/privacy', '/terms', '/guidelines', '/delete-account'];
const MAILBOX = 'mailto:social@flockcorp.com';

const mountFooter = (name) => {
  const rendered = render(React.createElement(load(name)));
  const footers = rendered.container.querySelectorAll('footer');
  expect(footers).toHaveLength(1);
  return { ...rendered, footer: footers[0] };
};

// ───────────────────────────────────────────────────────────────────────────
describe('adoption: the hand-rolled footers cannot come back', () => {
  test.each(PAGES)('%s renders its footer through SiteFooter, not inline', (name) => {
    const src = read(`${name}.js`);
    expect(src).toMatch(/import SiteFooter from '\.\/SiteFooter'/);
    // A literal <footer …> in a page is a hand-rolled footer starting to grow
    // back beside the shared one. Comments are allowed to say "<footer>"
    // (LandingPage's landmark comment does), so only code is scanned.
    const code = src
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect({ page: name, inline: code.match(/<footer\b/g) })
      .toEqual({ page: name, inline: null });
  });

  test.each(PAGES)('%s renders exactly one footer element', (name) => {
    const { unmount } = mountFooter(name);
    unmount();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the contract every footer carries', () => {
  test.each(PAGES)('%s: the four legal links and the one mailbox', (name) => {
    const { footer, unmount } = mountFooter(name);
    const hrefs = Array.from(footer.querySelectorAll('a[href]'))
      .map((a) => a.getAttribute('href'));

    for (const href of LEGAL_HREFS) {
      if (!hrefs.includes(href)) {
        throw new Error(`${name}: footer is missing the ${href} link (SLOP-AUDIT A5)`);
      }
    }

    // The mailbox is present, and it is the ONLY address: every other
    // unmonitored box on flockcorp.com, and a footer that mails a dead box
    // is worse than one with no contact at all.
    const mailtos = hrefs.filter((h) => h.startsWith('mailto:'));
    expect(mailtos.length).toBeGreaterThan(0);
    for (const m of mailtos) expect(m).toBe(MAILBOX);
    unmount();
  });

  test.each(PAGES)('%s: every footer link has a name, and no em dash reaches a reader', (name) => {
    const { footer, unmount } = mountFooter(name);
    for (const a of footer.querySelectorAll('a')) {
      expect(a.textContent.trim().length).toBeGreaterThanOrEqual(3);
    }
    // SLOP-AUDIT A2 covers the component's copy too; the page-level scans in
    // the other suites no longer see this text because it left those files.
    expect(footer.textContent).not.toMatch(/—/);
    expect(footer.textContent).toContain('Flock Corp.');
    unmount();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('landmark and surface classes the other suites depend on', () => {
  test('the landing footer keeps lp-footer and sits OUTSIDE main', () => {
    // aiCrawlerSurface.test.js excludes the landing footer from the bot
    // surface by the exact selector `footer.lp-footer`, and outside <main> the
    // element is a real contentinfo landmark. Move or rename it and the bot
    // document silently starts quoting footer chrome.
    const { container, footer, unmount } = mountFooter('LandingPage');
    expect(footer.classList.contains('lp-footer')).toBe(true);
    expect(container.querySelector('main').contains(footer)).toBe(false);
    unmount();
  });

  test.each(PAGES.filter((p) => p !== 'LandingPage'))(
    '%s: the footer keeps pp-footer and stays inside main.pp',
    (name) => {
      // Inside, deliberately: .pp on <main> paints the whole page (tokens,
      // paper, padding), so a footer outside it would lose its colours in
      // both themes. It is the footer of the document, not a nested
      // contentinfo (which axe flags inside another landmark).
      const { container, footer, unmount } = mountFooter(name);
      expect(footer.classList.contains('pp-footer')).toBe(true);
      expect(container.querySelector('main.pp').contains(footer)).toBe(true);
      unmount();
    }
  );
});

// ───────────────────────────────────────────────────────────────────────────
describe('SiteFooter.js source hygiene', () => {
  const src = read('SiteFooter.js');
  const code = src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  test('names only the one real mailbox', () => {
    const addresses = [...src.matchAll(/[\w.]+@flockcorp\.com/g)].map((m) => m[0]);
    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses) expect(address).toBe('social@flockcorp.com');
  });

  test('no em dash outside comments (SLOP-AUDIT A2)', () => {
    expect(code).not.toMatch(/—/);
  });

  test('the legal variant threads linkStyle onto every anchor it renders', () => {
    // About and Support pass READABLE through linkStyle; an anchor added here
    // without it would silently step back onto the token their a11y pass
    // stepped off. Scanned at source because jsdom discards var() colours.
    const legal = code.slice(code.lastIndexOf('return ('));
    const anchors = legal.match(/<a\s[^>]*>/g) || [];
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) expect(a).toContain('style={linkStyle}');
  });
});
