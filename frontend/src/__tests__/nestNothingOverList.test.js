/**
 * NOTHING FLOATS OVER THE NEST'S LIST (2026-11-06).
 *
 * At rest, Birdie's disc and the red SOS disc sat on plan names and times at
 * 320, 390 and 430. Now the page ends at a strip above the tabs that holds
 * SOS, unchanged, and an "Ask Birdie" pill on the other side, shown while no
 * part of the Birdie section is on screen: with plans the section comes after
 * them, and the pill is the way to it from the top.
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

describe('the hairline over the strip', () => {
  // It reads --nest-edge now, which shows on the cream, so its rule has to be
  // right: content under the strip, not blank space. An empty Nest ends with
  // the Birdie section's margin and the box's end padding 13px past the strip
  // at 390, and the line drew over nothing.
  const { contentBelow } = require('../components/nest/NestDock');
  const rect = (el, top, height) => { el.getBoundingClientRect = () => ({ top, bottom: top + height, height }); };
  const box = (children) => {
    const b = document.createElement('div');
    rect(b, 0, 600);
    for (const [top, height] of children) {
      const c = document.createElement('div');
      rect(c, top, height);
      b.appendChild(c);
    }
    return b;
  };

  test('drawn while something drawn runs past the strip', () => {
    expect(contentBelow(box([[0, 300], [320, 400]]))).toBe(true);
  });

  test('not for blank space: margin and padding past the last thing drawn', () => {
    expect(contentBelow(box([[0, 300], [320, 270]]))).toBe(false);
    // An empty wrapper after the last section (Coming up with no plans) is
    // not content, wherever its margin put it.
    expect(contentBelow(box([[0, 300], [320, 270], [618, 0]]))).toBe(false);
  });

  test('measured when the page changes, not after every render of the app', () => {
    // The effect had no dependency list: NestDock renders with every app
    // render while the Nest is open (sockets, state), and each run read the
    // box's geometry. Now a resize of the box or of a band in it, or a band
    // arriving or leaving, is what re-measures, and the scroll handler moves
    // it as the page scrolls.
    const NestDock = require('../components/nest/NestDock').default;
    const b = box([[0, 300], [320, 400]]);
    let reads = 0;
    const real = b.getBoundingClientRect;
    b.getBoundingClientRect = () => { reads += 1; return real(); };
    const lineRef = React.createRef();
    const dockProps = { height: 72, sosSide: 'right', getScroller: () => b, inputRef: { current: null }, isDark: false, band: null, watchKey: 'k', lineRef };
    const { rerender } = render(<NestDock {...dockProps} />);
    expect(lineRef.current.style.opacity).toBe('1');
    const after = reads;
    for (let i = 0; i < 5; i += 1) rerender(<NestDock {...dockProps} />);
    expect(reads).toBe(after);
    const dock = require('fs').readFileSync(require('path').join(__dirname, '..', 'components', 'nest', 'NestDock.js'), 'utf8');
    expect(dock).toMatch(/const ro = new ResizeObserver\(update\);/);
    expect(dock).toMatch(/\}, \[watchKey\]\); \/\/ eslint-disable-line react-hooks\/exhaustive-deps\n\n  const ask = /);
  });

  test('the strip and the scroll handler read the same rule', () => {
    const dock = require('fs').readFileSync(require('path').join(__dirname, '..', 'components', 'nest', 'NestDock.js'), 'utf8');
    expect(dock).toMatch(/line\.style\.opacity = contentBelow\(root\) \? '1' : '0';/);
    expect(APP).toMatch(/const below = contentBelow\(e\.currentTarget\);/);
  });
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
      constructor(cb, opts) { this.cb = cb; this.opts = opts; fire = (...where) => cb(where.map(entry)); }
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
    band: box.querySelector('section'),
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

  test('shows while no part of the Birdie section is on screen, fading, and is hidden from touch and speech otherwise', () => {
    // With plans the section comes after them, near the end of the page, so
    // at rest the pill is the way to Birdie from the top. It goes the moment
    // any of the section is in view: it used to show while the FIELD was
    // under half on screen, which put the section's "Ask Birdie" heading
    // about 50px over an "Ask Birdie" pill, one label twice.
    const box = page();
    const { container } = render(<NestDock {...props(box)} />);
    expect(observed[0].el).toBe(box.querySelector('[data-nest-band="birdie"]'));
    expect(observed[0].opts.root).toBe(box);
    expect(observed[0].opts.threshold).toBe(0);
    const pill = container.querySelector('button');
    const hidden = () => {
      expect(pill.style.opacity).toBe('0');
      expect(pill.style.pointerEvents).toBe('none');
      expect(pill.getAttribute('aria-hidden')).toBe('true');
    };
    const shown = () => {
      expect(pill.style.opacity).toBe('1');
      expect(pill.getAttribute('aria-hidden')).toBeNull();
    };
    act(() => fire('below'));
    shown();
    act(() => fire('in'));
    hidden();
    act(() => fire('above'));
    shown();
    expect(pill.style.transition).toBe(`opacity ${NEST_DOCK_FADE_MS}ms ease`);
    expect(pill.textContent).toBe('Ask Birdie');
    act(() => fire('in'));
    hidden();
  });

  test('one callback with several records: the newest decides', () => {
    // The observer can hand over the section's first look (on screen, while
    // the list was still loading) and its move off screen in one callback,
    // oldest first. Reading only the first record kept the pill hidden about
    // one load in three on the rig (seeded Nest, 390, dark).
    const box = page();
    const { container } = render(<NestDock {...props(box)} />);
    const pill = container.querySelector('button');
    act(() => fire('in', 'below'));
    expect(pill.style.opacity).toBe('1');
    act(() => fire('below', 'in'));
    expect(pill.style.opacity).toBe('0');
  });

  test('watches the section the page hands it, and a new one at once when the page replaces it', () => {
    // Armed on a key, a section that changed in the same commit as something
    // else (a suggestion tapped while the chunk was cold) was never watched,
    // and the pill never came for that thread.
    const box = page();
    const first = box.querySelector('section');
    const { rerender } = render(<NestDock {...props(box)} />);
    expect(observed.map((o) => o.el)).toEqual([first]);
    const next = document.createElement('section');
    next.setAttribute('data-nest-band', 'birdie');
    box.replaceChild(next, first);
    rerender(<NestDock {...props(box, { band: next })} />);
    expect(observed.map((o) => o.el)).toEqual([first, next]);
  });

  test('before the yes to Gemini, a tap asks for it and focuses nothing', () => {
    // A focus inside the tap raised the keyboard over a field the consent
    // question was about to replace.
    const box = page();
    const onAskConsent = jest.fn();
    const { container } = render(<NestDock {...props(box, { consented: false, onAskConsent })} />);
    act(() => fire('below'));
    container.querySelector('button').click();
    expect(onAskConsent).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(box.querySelector('input'));
    expect(box.querySelector('section').scrollIntoView).toHaveBeenCalledTimes(1);
  });

  test('a tap focuses the field inside the tap, then brings the section into view', () => {
    const box = page();
    const { container } = render(<NestDock {...props(box)} />);
    act(() => fire('below'));
    container.querySelector('button').click();
    expect(document.activeElement).toBe(box.querySelector('input'));
    expect(box.querySelector('section').scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
