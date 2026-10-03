/**
 * Section links on the website (2026-10-03 site audit). Every site page is a
 * lazy chunk, so /#pricing, /privacy#ai and the /research menu's links to the
 * landing page's sections opened at the TOP of the page: the browser looked
 * for the id while #root was still empty. And the live demo's reserved box was
 * 195-414px shorter than the loaded demo, so links to sections below it landed
 * short once it arrived.
 *
 * website/hashLanding.js scrolls to the target once the page has rendered and
 * keeps it there while the page settles; the demo's box is reserved from
 * measurements. FRONTEND test (jest via react-scripts).
 */
import React from 'react';
import { render, act } from '@testing-library/react';
import HashLanding, { holdHashInView } from '../website/hashLanding';

const fs = require('fs');
const path = require('path');

let scrolled;
let roCallbacks;

beforeEach(() => {
  jest.useFakeTimers();
  scrolled = [];
  roCallbacks = [];
  Element.prototype.scrollIntoView = function scrollIntoView(opts) {
    scrolled.push({ id: this.id, opts });
  };
  window.ResizeObserver = class {
    constructor(cb) { this.cb = cb; roCallbacks.push(this); }
    observe() {}
    disconnect() { this.cb = null; }
  };
  window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  document.body.innerHTML = '<section id="pricing"></section><section id="birdie"></section>';
  window.history.replaceState(null, '', '/#pricing');
});

afterEach(() => {
  jest.useRealTimers();
  delete Element.prototype.scrollIntoView;
  window.history.replaceState(null, '', '/');
});

const resize = (height) => {
  for (const ro of roCallbacks) if (ro.cb) ro.cb([{ contentRect: { height } }]);
  act(() => { jest.advanceTimersByTime(1); });
};

test('a fresh visit to a section link lands on the section once the page has rendered', () => {
  render(<HashLanding />);
  expect(scrolled.map((s) => s.id)).toEqual(['pricing']);
  expect(scrolled[0].opts).toEqual({ block: 'start' }); // honours scroll-margin-top
});

test('it stays on the section while content above it grows, and only then', () => {
  holdHashInView(window);
  expect(scrolled).toHaveLength(1);
  resize(4000); // observe()'s first report is the current size, not a shift
  expect(scrolled).toHaveLength(1);
  resize(4000);
  expect(scrolled).toHaveLength(1);
  resize(4380); // the demo arrived above the target
  expect(scrolled).toHaveLength(2);
});

test('the visitor scrolling, tapping or typing ends the hold', () => {
  for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown']) {
    scrolled = [];
    holdHashInView(window);
    resize(1000);
    window.dispatchEvent(new Event(type));
    resize(2000);
    expect(scrolled).toHaveLength(1); // the landing, and no correction after
  }
});

test('the hold ends on its own after a few seconds', () => {
  holdHashInView(window);
  resize(1000);
  act(() => { jest.advanceTimersByTime(4001); });
  resize(2000);
  expect(scrolled).toHaveLength(1);
});

test('an in-page link scrolls natively; only a later shift is corrected', () => {
  render(<HashLanding />);
  scrolled = [];
  act(() => {
    window.history.replaceState(null, '', '/#birdie');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  expect(scrolled).toEqual([]); // no jump over the browser's smooth scroll
  const latest = roCallbacks[roCallbacks.length - 1];
  latest.cb([{ contentRect: { height: 5000 } }]);
  latest.cb([{ contentRect: { height: 5300 } }]);
  act(() => { jest.advanceTimersByTime(1); });
  expect(scrolled.map((s) => s.id)).toEqual(['birdie']);
});

test('a back/forward visit keeps the position the browser restores', () => {
  const real = window.performance.getEntriesByType;
  window.performance.getEntriesByType = () => [{ type: 'back_forward' }];
  try {
    render(<HashLanding />);
    expect(scrolled).toEqual([]);
  } finally {
    window.performance.getEntriesByType = real;
  }
});

test('index.js renders it after the page, inside the page\'s Suspense', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  expect(src).toMatch(/<Page \/>[\s\S]{0,400}<HashLanding \/>\s*<\/React\.Suspense>/);
});

test('the demo\'s reserved box follows the measured heights, not the stale 526/780', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'website', 'LandingPage.css'), 'utf8');
  expect(css).toMatch(/\.lpd-hold \{ margin-top: 34px; min-height: clamp\(696px, calc\(550px \+ 16\.5vw\), 750px\); \}/);
  expect(css).toMatch(/@media \(max-width: 860px\) \{ \.lpd-hold \{ min-height: calc\(790px \+ 50vw\); \} \}/);
  expect(css).toMatch(/@media \(max-width: 480px\) \{ \.lpd-hold \{ min-height: calc\(860px \+ 50vw\); \} \}/);
  expect(css).not.toMatch(/\.lpd-hold \{[^}]*min-height: (526|780)px/);
});
