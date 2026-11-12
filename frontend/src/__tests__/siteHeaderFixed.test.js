/**
 * THE SITE'S BAR IS FIXED, SO THE PAGE DOES NOT SHOW ABOVE IT ON AN iPHONE.
 *
 * 2026-11-11, his words: "the header of our website's kind of weird ... the
 * page goes through it". Safari on iOS 26 stopped reading
 * <meta name="theme-color"> and colours the strip behind the clock and
 * battery from an opaque position: fixed element at the top of the page.
 * The bar was position: sticky, which does not count, so the page scrolled up
 * through that strip, above the navy bar.
 *
 * Pinned (as text where jsdom has no layout): the bar is fixed at the top
 * edge, full width, opaque navy; a spacer right after it in the markup holds
 * the same 64px the row is, on the home page and on every page that uses
 * SiteNav; both pad by the status bar's height (--device-top), and the bar by
 * the scrollbar the menu's scroll lock takes away.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test siteHeaderFixed --watchAll=false
 */
const fs = require('fs');
const path = require('path');
const React = require('react');
const { render } = require('@testing-library/react');

jest.mock('../website/LiveDemo', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/ui/BirdieBird', () => ({
  __esModule: true,
  default: () => null,
  WARM_BIRD: { body: '', head: '', flap: null, neck: '0 0' },
  BIRDIE: { body: '', head: '', flap: null, neck: '0 0' },
}));

const CSS = fs.readFileSync(path.join(__dirname, '..', 'website', 'LandingPage.css'), 'utf8').replace(/\r\n/g, '\n');
const rule = (sel) => {
  const m = new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(CSS);
  return m ? m[1] : null;
};

test('the bar is fixed to the top edge, full width and opaque', () => {
  const nav = rule('.lp-nav');
  expect(nav).not.toBeNull();
  expect(nav).toMatch(/position: fixed;/);
  expect(nav).not.toMatch(/position: sticky/);
  for (const side of ['top', 'left', 'right']) expect(nav).toMatch(new RegExp(`\\b${side}: 0;`));
  expect(nav).toMatch(/background: var\(--navy\);/);
  expect(nav).not.toMatch(/backdrop-filter|opacity|rgba/);
  expect(nav).toMatch(/padding-top: var\(--device-top, 0px\);/);
  expect(nav).toMatch(/padding-right: var\(--lp-scrollbar, 0px\);/);
});

test('the spacer is as tall as the row, plus the status bar', () => {
  expect(rule('.lp-nav-in')).toMatch(/height: 64px;/);
  expect(rule('.lp-nav-space')).toMatch(/height: calc\(64px \+ var\(--device-top, 0px\)\);/);
});

const PAGES = [
  ['/', '../website/LandingPage'],
  ['/about', '../website/AboutPage'],
  ['/ai', '../website/AiPage'],
  ['/flux', '../website/FluxPage'],
  ['/how-it-works', '../website/HowItWorksPage'],
  ['/research', '../website/ResearchPage'],
];

test.each(PAGES)('%s: the spacer comes right after the bar, hidden from screen readers', (_route, mod) => {
  const Page = require(mod).default;
  const { container, unmount } = render(React.createElement(Page));
  const bars = container.querySelectorAll('header.lp-nav');
  expect(bars).toHaveLength(1);
  const next = bars[0].nextElementSibling;
  expect(next.className).toBe('lp-nav-space');
  expect(next.getAttribute('aria-hidden')).toBe('true');
  expect(next.childNodes).toHaveLength(0);
  expect(container.querySelectorAll('.lp-nav-space')).toHaveLength(1);
  unmount();
});
