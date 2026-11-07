/**
 * NOTHING FLOATS OVER THE NEST'S LIST (2026-11-06).
 *
 * At rest, Birdie's disc and the red SOS disc sat on plan names and times at
 * 320, 390 and 430. Now the page ends at a strip above the tabs that holds
 * SOS, unchanged, and an "Ask Birdie" pill on the other side, shown only once
 * the whole Birdie section has scrolled above the page.
 *
 *   - HomeScreen itself draws nothing absolutely or fixed positioned; the one
 *     floating control on the Nest is SafetyButton, called as on every tab.
 *   - The strip renders, at one height.
 *   - The pill changes side with SOS, fades rather than moves, focuses the
 *     field inside the tap, and is hidden from touch and from a screen reader
 *     while the field is in view.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test nestNothingOverList --watchAll=false
 */
import React from 'react';
import { render, act } from '@testing-library/react';
import NestDock, { NEST_DOCK_FADE_MS } from '../components/nest/NestDock';

const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const HOME = strip(APP.slice(APP.indexOf('const HomeScreen = () => {'), APP.indexOf('// The past flocks screen was declared here')));

test('HomeScreen draws nothing absolutely positioned; SOS is the one floating control, as on every tab', () => {
  expect(HOME).not.toMatch(/position: '(absolute|fixed)'/);
  expect(HOME).not.toMatch(/AIBubble/);
  expect(HOME).toMatch(/\{SafetyButton\(\)\}/);
});

test('the strip renders between the page and the tabs', () => {
  expect(HOME).toMatch(/<NestDock\n\s+height=\{nestDockHeight\}/);
});

describe('the Ask Birdie pill', () => {
  let observed;
  let fire;
  // where: 'in' (on screen), 'below' (not reached yet), 'above' (scrolled past)
  const entry = (where) => {
    const rootBounds = { top: 0, bottom: 600 };
    const rect = where === 'below' ? { top: 640, bottom: 900 } : where === 'above' ? { top: -400, bottom: -20 } : { top: 300, bottom: 560 };
    return { isIntersecting: where === 'in', intersectionRatio: where === 'in' ? 1 : 0, boundingClientRect: rect, rootBounds };
  };
  beforeEach(() => {
    observed = [];
    window.IntersectionObserver = class {
      constructor(cb, opts) { this.cb = cb; this.opts = opts; fire = (where) => cb([entry(where)]); }
      observe(el) { observed.push({ el, opts: this.opts }); }
      disconnect() {}
    };
  });
  afterEach(() => { delete window.IntersectionObserver; });

  const page = () => {
    const box = document.createElement('div');
    box.innerHTML = '<section data-nest-band="birdie"><div data-nest-birdie-field=""><input /></div></section>';
    document.body.appendChild(box);
    box.querySelector('section').scrollIntoView = jest.fn();
    return box;
  };
  const props = (box, over = {}) => ({
    height: 72,
    sosSide: 'right',
    getScroller: () => box,
    inputRef: { current: box.querySelector('input') },
    isDark: false,
    watchKey: 'k',
    lineRef: React.createRef(),
    ...over,
  });

  test('sits on the side opposite SOS', () => {
    const box = page();
    const { container, rerender } = render(<NestDock {...props(box)} />);
    // jsdom drops a var() length from the style, so the side is read off the
    // button's data-side and the source's one rule.
    const side = () => container.querySelector('button').getAttribute('data-side');
    expect(side()).toBe('left');
    rerender(<NestDock {...props(box, { sosSide: 'left' })} />);
    expect(side()).toBe('right');
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'components', 'nest', 'NestDock.js'), 'utf8');
    expect(src).toContain("[left ? 'left' : 'right']: 'var(--nest-gutter)',");
  });

  test('shows only once the whole Birdie section has scrolled above the page, fading, and is hidden from touch and speech otherwise', () => {
    // It showed while the FIELD was under half on screen, which at rest,
    // with the section just below the fold, put the section's "Ask Birdie"
    // heading about 50px over an "Ask Birdie" pill: one label twice, read as
    // a glitch. Now it is only a way back up for someone who scrolled past.
    const box = page();
    const { container } = render(<NestDock {...props(box)} />);
    expect(observed[0].el).toBe(box.querySelector('[data-nest-band="birdie"]'));
    expect(observed[0].opts.root).toBe(box);
    const pill = container.querySelector('button');
    const hidden = () => {
      expect(pill.style.opacity).toBe('0');
      expect(pill.style.pointerEvents).toBe('none');
      expect(pill.getAttribute('aria-hidden')).toBe('true');
    };
    act(() => fire('below'));
    hidden();
    act(() => fire('in'));
    hidden();
    act(() => fire('above'));
    expect(pill.style.opacity).toBe('1');
    expect(pill.getAttribute('aria-hidden')).toBeNull();
    expect(pill.style.transition).toBe(`opacity ${NEST_DOCK_FADE_MS}ms ease`);
    expect(pill.textContent).toBe('Ask Birdie');
    act(() => fire('in'));
    hidden();
  });

  test('a tap focuses the field inside the tap, then brings the section into view', () => {
    const box = page();
    const { container } = render(<NestDock {...props(box)} />);
    act(() => fire('above'));
    container.querySelector('button').click();
    expect(document.activeElement).toBe(box.querySelector('input'));
    expect(box.querySelector('section').scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
