/**
 * The analytics consent bar never covers the app's tab bar, and never covers
 * the sign-in footer either.
 *
 * It is fixed to the bottom of the viewport and above everything by z-index,
 * so inside the app it sat on top of the five tabs until answered: a tap on
 * Discover landed on the bar, and the screenshot rig timed out on the first
 * tab. The bar now measures the visible main navigation and sits above it.
 * On pages with no tab bar (the marketing site) the clearance is zero.
 */
import React from 'react';
import { act, render } from '@testing-library/react';

jest.mock('../services/analyticsConsent', () => ({
  consentUnanswered: () => true,
  setConsent: jest.fn(),
  onConsentChange: () => () => {},
}));

const ConsentBanner = require('../components/ConsentBanner').default;

function mountNav(height) {
  const nav = document.createElement('nav');
  nav.setAttribute('aria-label', 'Main');
  nav.getBoundingClientRect = () => ({ height, width: 390, top: 0, left: 0, right: 390, bottom: height });
  document.body.appendChild(nav);
  return nav;
}

afterEach(() => {
  document.body.innerHTML = '';
});

test('with no tab bar on the page the bar sits at the bottom edge', () => {
  const { container } = render(<ConsentBanner />);
  const wrap = container.querySelector('.cb-wrap');
  expect(wrap).not.toBeNull();
  expect(wrap.style.getPropertyValue('--cb-clearance')).toBe('0px');
});

test('with the app tab bar mounted the bar clears its full height', async () => {
  mountNav(89);
  const { container } = render(<ConsentBanner />);
  const wrap = container.querySelector('.cb-wrap');
  expect(wrap.style.getPropertyValue('--cb-clearance')).toBe('89px');
});

test('a tab bar that appears after sign-in is picked up without a reload', async () => {
  const { container } = render(<ConsentBanner />);
  const wrap = container.querySelector('.cb-wrap');
  expect(wrap.style.getPropertyValue('--cb-clearance')).toBe('0px');
  await act(async () => {
    mountNav(89);
    // The observer schedules a measurement on the next animation frame.
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(wrap.style.getPropertyValue('--cb-clearance')).toBe('89px');
});

test('the bottom offset is built from the clearance variable', () => {
  const src = require('fs').readFileSync(require.resolve('../components/ConsentBanner.js'), 'utf8');
  expect(src).toMatch(/bottom: calc\(12px \+ var\(--cb-clearance, 0px\) \+ env\(safe-area-inset-bottom, 0px\)\)/);
  expect(src).toMatch(/nav\[aria-label="Main"\]/);
});

// Before sign-in there is no tab bar, so the clearance above is zero and the
// bar sat flat on the bottom of the auth card, over "New here? Create an
// account". Walking the reviewer's path against production found the click
// intercepted by this dialog. The bar now publishes its own footprint on the
// document while open, and the auth column pads by it.
test('while the bar is open the document carries its footprint, and it is gone once answered', async () => {
  const { container, getByText } = render(<ConsentBanner />);
  const wrap = container.querySelector('.cb-wrap');
  wrap.getBoundingClientRect = () => ({ height: 120, width: 366, top: 0, left: 0, right: 366, bottom: 120 });
  await act(async () => {
    window.dispatchEvent(new Event('resize'));
    // resize schedules a measurement on the next animation frame.
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  // 120 of bar + the 12px it floats above the page + 0 of tab bar.
  expect(document.documentElement.style.getPropertyValue('--cb-height')).toBe('132px');
  await act(async () => { getByText('No thanks').click(); });
  expect(document.documentElement.style.getPropertyValue('--cb-height')).toBe('');
});

test('the auth column pads its bottom by that footprint, so the footer links stay tappable', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'components', 'auth', 'AuthShell.js'), 'utf8');
  // The banner's footprint is now one term in a sum: the keyboard's own
  // quantized footprint (--kb-pad) is the other, added when the WebView stopped
  // resizing for the keyboard. What this test guards is that --cb-height is
  // still what the column clears, not that it is the only thing it clears.
  expect(src).toMatch(/\.auth-col \{[\s\S]*?padding-bottom: calc\(var\(--cb-height, 0px\)[^;]*\);/);
  const bar = fs.readFileSync(require.resolve('../components/ConsentBanner.js'), 'utf8');
  expect(bar).toMatch(/style\.setProperty\(HEIGHT_VAR/);
  expect(bar).toMatch(/style\.removeProperty\(HEIGHT_VAR\)/);
});

// Site pages keep focus clear of the bar (site audit 2026-10-03). A keyboard
// walk at 375px used to put focus fully under it on every page, a WCAG 2.2
// 2.4.11 failure, and the bar sat two Tab stops ahead of every skip link.
// Re-walked in Chromium at 375 and 1440 over eleven pages: zero stops covered.
describe('the page keeps clear of the bar while it is open', () => {
  test('the rules ship inside the bar, so they last exactly as long as it does', () => {
    const { container } = render(<ConsentBanner />);
    const css = container.querySelector('style').textContent;
    expect(css).toContain('#root:has(.lp, .pp, .gi, .tap, .rs) { padding-bottom: var(--cb-height, 0px); }');
    expect(css).toMatch(/\.lp main \*, \.lp footer \*, \.pp \*, \.gi \*, \.tap \*, \.rs \* \{\s*scroll-margin-bottom: calc\(var\(--cb-height, 0px\) \+ 8px\);/);
    // The sticky contents list is shortened rather than left under the bar.
    expect(css).toMatch(/@media \(min-width: 960px\) \{\s*\.pp-toc-inner \{ max-height: calc\(100vh - 80px - var\(--cb-height, 0px\)\); \}/);
  });

  test('never scroll-padding on the root, which re-centres the sticky header on every focus', () => {
    const { container } = render(<ConsentBanner />);
    expect(container.querySelector('style').textContent).not.toMatch(/scroll-padding/);
  });

  test('index.js mounts the site bar after the page, so the skip link is the first Tab stop', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const start = src.indexOf('if (page) {');
    const block = src.slice(start, src.indexOf('} else if', start));
    expect(block.indexOf('<ConsentBanner')).toBeGreaterThan(block.indexOf('</ErrorBoundary>'));
  });
});
