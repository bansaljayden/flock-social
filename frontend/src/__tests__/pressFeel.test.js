/**
 * A PRESS FEELS LIKE iOS.
 *
 * the maintainer, 2026-11-07: "make the buttons like iOS, feel good to the touch,
 * like how Apple does it." What iOS does, and where each number here comes
 * from, is in the PRESS block at the end of index.css and in lib/press.js:
 * the highlight lands on touch-down with no animation, the action fires on
 * release, a text button fades, a filled one dims and presses in, a list row
 * fills grey, nothing springs past full size, Reduce Motion drops the scale
 * and keeps the fade, and a disabled control does not answer at all. Haptics
 * follow Apple's three families: an impact for a commit, the selection tick
 * for a changed choice, the success notification for a plan locked in, and
 * nothing on the web.
 *
 * Sections:
 *   1. the shared press styles in index.css;
 *   2. lib/press.js, which classifies a press and turns :active on for iOS;
 *   3. services/haptics.js: silent on the web, the iOS calls in the app;
 *   4. the call sites.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test pressFeel --watchAll=false
 */
import React from 'react';
import { render, fireEvent } from '@testing-library/react';

const mockPlugin = {
  impact: jest.fn(() => Promise.resolve()),
  notification: jest.fn(() => Promise.resolve()),
  selectionStart: jest.fn(() => Promise.resolve()),
  selectionChanged: jest.fn(() => Promise.resolve()),
  selectionEnd: jest.fn(() => Promise.resolve()),
};
jest.mock('@capacitor/haptics', () => ({
  Haptics: {
    impact: (...a) => mockPlugin.impact(...a),
    notification: (...a) => mockPlugin.notification(...a),
    selectionStart: (...a) => mockPlugin.selectionStart(...a),
    selectionChanged: (...a) => mockPlugin.selectionChanged(...a),
    selectionEnd: (...a) => mockPlugin.selectionEnd(...a),
  },
  ImpactStyle: { Light: 'LIGHT', Medium: 'MEDIUM', Heavy: 'HEAVY' },
  NotificationType: { Success: 'SUCCESS', Warning: 'WARNING', Error: 'ERROR' },
}));
let mockNative = true;
jest.mock('../lib/nativeShell', () => ({
  ...jest.requireActual('../lib/nativeShell'),
  isNativeShell: () => mockNative,
}));

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const CSS = read('index.css');
const PRESS_CSS = CSS.slice(CSS.indexOf('PRESS. How a control answers a finger'));
// The rules alone, for the checks a comment's own words would trip.
const PRESS_RULES = PRESS_CSS.slice(PRESS_CSS.indexOf('*/') + 2).replace(/\/\*[\s\S]*?\*\//g, '');
const press = require('../lib/press');

const flush = async () => {
  for (let i = 0; i < 6; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

beforeEach(() => {
  mockNative = true;
  Object.values(mockPlugin).forEach((fn) => fn.mockImplementation(() => Promise.resolve()));
});

/* ── 1. The shared press styles ────────────────────────────────────────── */

describe('index.css PRESS', () => {
  test('the block exists once, at the end, after everything it has to outweigh', () => {
    expect(CSS.split('PRESS. How a control answers a finger').length).toBe(2);
    expect(CSS.indexOf('PRESS. How a control answers a finger')).toBeGreaterThan(CSS.indexOf('[data-theme="dark"] .glass-secondary {'));
  });

  test('timings and sizes are custom properties, with the iOS values', () => {
    const root = PRESS_CSS.match(/:root \{([^}]*)\}/)[1];
    expect(root).toContain('--press-in: 0ms;');
    expect(root).toContain('--press-out: 200ms;');
    expect(root).toContain('--press-ease: cubic-bezier(0.215, 0.61, 0.355, 1);');
    expect(root).toContain('--press-scale: 0.97;');
    expect(root).toContain('--press-tab-scale: 0.95;');
    expect(root).toContain('--press-fill-opacity: 0.8;');
    expect(root).toContain('--press-text-opacity: 0.5;');
    expect(root).toMatch(/--press-row-fill: rgba\(/);
    expect(PRESS_CSS).toMatch(/\[data-theme="dark"\] \{\s*--press-row-fill: rgba\(/);
  });

  test('the release eases out and never overshoots: every bezier y stays inside 0..1', () => {
    const [, , y1, , y2] = PRESS_CSS.match(/--press-ease: cubic-bezier\(([\d.]+), ([\d.]+), ([\d.]+), ([\d.]+)\)/).map(Number);
    expect(y1).toBeLessThanOrEqual(1);
    expect(y2).toBeLessThanOrEqual(1);
    expect(y1).toBeGreaterThanOrEqual(0);
  });

  test('no press anywhere scales past full size', () => {
    const scales = [...PRESS_CSS.matchAll(/--press-(?:tab-)?scale: ([\d.]+);/g)].map((m) => Number(m[1]));
    expect(scales.length).toBeGreaterThan(0);
    scales.forEach((s) => expect(s).toBeLessThanOrEqual(1));
    expect(PRESS_CSS).not.toMatch(/scale\(1\.\d/);
  });

  test('the press goes in at once and comes back on the release', () => {
    expect(PRESS_CSS).toMatch(/:where\(button, \[role="button"\]\) \{\s*transition: transform var\(--press-out\) var\(--press-ease\), opacity var\(--press-out\) var\(--press-ease\)/);
    const fill = PRESS_CSS.slice(PRESS_CSS.indexOf('/* fill,'), PRESS_CSS.indexOf('/* text */'));
    expect(fill).toContain('transform: scale(var(--press-scale));');
    expect(fill).toContain('opacity: var(--press-fill-opacity);');
    expect(fill).toContain('transition-duration: var(--press-in) !important;');
  });

  test('text fades and does not move; a row fills and does not move; a tab presses in and does not dim', () => {
    const text = PRESS_CSS.slice(PRESS_CSS.indexOf('/* text */'), PRESS_CSS.indexOf('/* tab:'));
    expect(text).toMatch(/:where\(\[data-press="text"\], \[data-press-auto="text"\]\)/);
    expect(text).toContain('transform: none;');
    expect(text).toContain('opacity: var(--press-text-opacity);');
    const tab = PRESS_CSS.slice(PRESS_CSS.indexOf('/* tab:'), PRESS_CSS.indexOf('/* row.'));
    expect(tab).toContain('transform: scale(var(--press-tab-scale));');
    expect(tab).toContain('opacity: 1;');
    const row = PRESS_CSS.slice(PRESS_CSS.indexOf('/* row.'), PRESS_CSS.indexOf('/* The presses drawn elsewhere'));
    expect(row).toMatch(/:root :is\(\.press-row, \.nest-row-btn, \[data-press="row"\]\)/);
    expect(row).toContain('transform: none !important;');
    expect(row).toContain('background-image: linear-gradient(var(--press-row-fill), var(--press-row-fill)) !important;');
  });

  test('a disabled control gets no press in any of the four kinds, nor on glass', () => {
    // The four top-level press rules (the Reduce Motion ones are indented).
    const actives = [...PRESS_RULES.matchAll(/^([^\s@][^{\n]*:active[^{\n]*)\{/gm)].map((m) => m[1]);
    expect(actives.length).toBe(4);
    actives.forEach((sel) => expect(sel).toContain(':not(:disabled)'));
    expect(CSS).toMatch(/\.glass-btn:where\(:active:not\(:disabled\):not\(\[aria-disabled="true"\]\):not\(\.press-row\)\) \{\s*transform: scale\(var\(--press-scale\)\) !important;/);
  });

  test('every press rule weighs nothing, so a component\'s own press always wins', () => {
    const selectors = [...PRESS_RULES.matchAll(/^([^\s@/*][^{\n]*:active[^{\n]*)\{/gm)].map((m) => m[1].trim());
    selectors.forEach((sel) => {
      // The row rule's :root :is() is the one deliberate weight, documented in place.
      if (sel.startsWith(':root :is(')) return;
      expect(sel.startsWith(':where(')).toBe(true);
    });
  });

  test('the controls that draw their own press are the list lib/press.js keeps', () => {
    const rule = PRESS_CSS.match(/:not\(:disabled\):not\(\[aria-disabled="true"\]\):not\(([^)]*\[data-press="none"\])\)\)/);
    expect(rule).not.toBeNull();
    const inCss = rule[1].split(',').map((s) => s.trim()).filter((s) => s !== '[data-press="none"]');
    expect(inCss).toEqual(press.OWN_PRESS);
  });

  test('Reduce Motion drops the scales and keeps the fades', () => {
    expect(PRESS_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*:root \{\s*--press-scale: 1;\s*--press-tab-scale: 1;\s*\}\s*\}/);
    const reduced = PRESS_CSS.slice(PRESS_CSS.indexOf('/* The presses drawn elsewhere'));
    expect(reduced).toContain('[data-nest-plan]:has(.nest-stretch:active) { transform: none; }');
    expect(reduced).toContain('.fab-press:active { transform: none !important; }');
    expect(PRESS_CSS).not.toMatch(/--press-(?:text|fill)-opacity: 1;/);
  });

  test('no grey tap flash, and no callout or selection on a control; fields and .selectable keep theirs', () => {
    expect(PRESS_CSS).toMatch(/html \{\s*-webkit-tap-highlight-color: transparent;\s*\}/);
    expect(PRESS_CSS).toMatch(/html\.flock-app button,\s*html\.flock-app \[role="button"\] \{\s*-webkit-touch-callout: none;\s*-webkit-user-select: none;\s*user-select: none;\s*\}/);
    // The allow-list above still says text, and outweighs a :where().
    expect(CSS).toMatch(/html\.flock-app \.selectable,[\s\S]*?-webkit-user-select: text;/);
    expect(CSS).toMatch(/html\.flock-app input,\s*html\.flock-app textarea,/);
  });

  test('touch-action: manipulation stays on every control, so no tap waits on a double-tap zoom', () => {
    expect(CSS).toMatch(/button, a, \[role="button"\], input, select, textarea \{\s*touch-action: manipulation;\s*\}/);
  });

  test('the old global press is gone, and App.js keeps no press or touch hover of its own', () => {
    expect(CSS).not.toMatch(/button:active, \[role="button"\]:active \{/);
    const app = read('App.js');
    expect(app).not.toMatch(/^\s*button:active \{/m);
    expect(app).not.toMatch(/^\s*button:hover \{/m);
    expect(app).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{\s*button:hover:not\(:active\) \{\s*opacity: 0\.85;/);
  });

  test('keyboard focus rings are not touched by the press', () => {
    expect(PRESS_RULES).not.toMatch(/outline|focus/);
  });
});

/* ── 2. lib/press.js ───────────────────────────────────────────────────── */

describe('lib/press.js', () => {
  test('a clear colour reads as clear in every form a browser computes', () => {
    ['transparent', 'rgba(0, 0, 0, 0)', 'rgb(0 0 0 / 0)', 'color(srgb 1 1 1 / 0)', '', null].forEach((c) => expect(press.isClear(c)).toBe(true));
    ['rgb(13, 40, 71)', 'rgba(255, 255, 255, 0.62)', '#0d2847', 'rgb(0 0 0 / 0.5)'].forEach((c) => expect(press.isClear(c)).toBe(false));
  });

  test('a button that paints a background, a border or a shadow is a fill; a bare label is text', () => {
    const bare = { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', boxShadow: 'none' };
    expect(press.classifyPress(bare)).toBe('text');
    expect(press.classifyPress({ ...bare, backgroundColor: 'rgb(13, 40, 71)' })).toBe('fill');
    expect(press.classifyPress({ ...bare, backgroundImage: 'linear-gradient(red, blue)' })).toBe('fill');
    expect(press.classifyPress({ ...bare, borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: 'rgb(0, 0, 0)' })).toBe('fill');
    expect(press.classifyPress({ ...bare, borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: 'transparent' })).toBe('text');
    expect(press.classifyPress({ ...bare, boxShadow: '0 1px 2px rgba(0,0,0,0.1)' })).toBe('fill');
  });

  test('a press marks the button it landed in, from a child too, and reads it again each time', () => {
    const { container } = render(
      <div>
        <button type="button" style={{ backgroundColor: 'transparent', borderStyle: 'none' }}><span>Add friends</span></button>
        <button type="button" style={{ backgroundColor: 'rgb(13, 40, 71)', borderStyle: 'none' }}>Start a flock</button>
      </div>
    );
    const [textBtn, fillBtn] = container.querySelectorAll('button');
    expect(press.markPress(textBtn.querySelector('span'))).toBe('text');
    expect(textBtn.getAttribute('data-press-auto')).toBe('text');
    expect(press.markPress(fillBtn)).toBe('fill');
    expect(fillBtn.getAttribute('data-press-auto')).toBe('fill');
    // A segment that becomes the choice fills, and its next press says so.
    textBtn.style.backgroundColor = 'rgb(245, 214, 222)';
    expect(press.markPress(textBtn)).toBe('fill');
    expect(textBtn.getAttribute('data-press-auto')).toBe('fill');
  });

  test('it leaves alone a button that says what it is, one that draws its own press, and a disabled one', () => {
    const { container } = render(
      <div>
        <button type="button" data-press="tab">Nest</button>
        <button type="button" className="glass-btn glass-navy">Join</button>
        <button type="button" className="nest-stretch">Friday</button>
        <button type="button" disabled>Saving</button>
        <div role="button" aria-disabled="true" tabIndex={0}>Off</div>
        <p>Not a control</p>
      </div>
    );
    container.querySelectorAll('button, [role="button"], p').forEach((el) => {
      expect(press.markPress(el)).toBeNull();
      expect(el.hasAttribute('data-press-auto')).toBe(false);
    });
  });

  test('installPress adds one passive touchstart (iOS :active) and one passive pointerdown, once', () => {
    press.resetPressForTests();
    const added = [];
    const doc = { addEventListener: (type, fn, opts) => added.push([type, opts]), defaultView: window };
    expect(press.installPress(doc)).toBe(true);
    expect(press.installPress(doc)).toBe(false);
    expect(added).toEqual([
      ['touchstart', { passive: true, capture: true }],
      ['pointerdown', { passive: true, capture: true }],
    ]);
    expect(press.installPress(null)).toBe(false);
    press.resetPressForTests();
  });

  test('a pointerdown on the real document classifies the press before it paints', () => {
    press.resetPressForTests();
    press.installPress(document);
    const { container } = render(<button type="button" style={{ backgroundColor: 'transparent', borderStyle: 'none' }}>Edit</button>);
    const btn = container.querySelector('button');
    fireEvent.pointerDown(btn);
    expect(btn.getAttribute('data-press-auto')).toBe('text');
  });

  test('index.js installs it before the first render, on every route', () => {
    const index = read('index.js');
    expect(index).toContain("import { installPress } from './lib/press';");
    const at = index.indexOf('installPress();');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(index.indexOf('ReactDOM.createRoot'));
  });
});

/* ── 3. services/haptics.js ────────────────────────────────────────────── */

describe('services/haptics.js', () => {
  const fresh = () => {
    let mod;
    jest.isolateModules(() => { mod = require('../services/haptics'); });
    return mod;
  };

  test('on the web every verb is silent and nothing throws', async () => {
    mockNative = false;
    const h = fresh();
    ['hapticTap', 'hapticSuccess', 'hapticSelection', 'hapticLocked', 'hapticWarning', 'hapticAlarm'].forEach((verb) => {
      expect(() => h[verb]()).not.toThrow();
    });
    await flush();
    Object.values(mockPlugin).forEach((fn) => expect(fn).not.toHaveBeenCalled());
  });

  test('selection is the selection tick: start, changed, end, in that order', async () => {
    const h = fresh();
    const order = [];
    mockPlugin.selectionStart.mockImplementation(() => { order.push('start'); return Promise.resolve(); });
    mockPlugin.selectionChanged.mockImplementation(() => { order.push('changed'); return Promise.resolve(); });
    mockPlugin.selectionEnd.mockImplementation(() => { order.push('end'); return Promise.resolve(); });
    h.hapticSelection();
    await flush();
    expect(order).toEqual(['start', 'changed', 'end']);
    expect(mockPlugin.impact).not.toHaveBeenCalled();
  });

  test('a lock-in is the success notification, not an impact', async () => {
    const h = fresh();
    h.hapticLocked();
    await flush();
    expect(mockPlugin.notification).toHaveBeenCalledWith({ type: 'SUCCESS' });
    expect(mockPlugin.impact).not.toHaveBeenCalled();
  });

  test('a commit stays a light impact', async () => {
    const h = fresh();
    h.hapticTap();
    await flush();
    expect(mockPlugin.impact).toHaveBeenCalledWith({ style: 'LIGHT' });
  });

  test('a selection the plugin refuses is swallowed', async () => {
    const h = fresh();
    mockPlugin.selectionStart.mockImplementation(() => Promise.reject(new Error('no taptic engine')));
    expect(() => h.hapticSelection()).not.toThrow();
    await flush();
    expect(mockPlugin.selectionChanged).not.toHaveBeenCalled();
  });
});

/* ── 4. The call sites ─────────────────────────────────────────────────── */

describe('where the press and the haptics are used', () => {
  const APP = read('App.js');

  test('the tab bar presses as a tab and ticks only when the tab changes', () => {
    expect(APP).toContain('<button className="hit44 main-nav-tab" key={t.id} onClick={() => handleTabClick(t.id)} data-press="tab"');
    const at = APP.indexOf('const handleTabClick = (tabId) => {');
    const body = APP.slice(at, APP.indexOf('\n    };', at));
    expect(body).toMatch(/if \(tabId !== currentTab\) hapticSelection\(\);\s*setCurrentTab\(tabId\);/);
    expect(body.match(/haptic[A-Z]\w*\(/g)).toEqual(['hapticSelection(']);
  });

  test('the lock-in moments are the success notification', () => {
    expect(APP.match(/hapticLocked\(\)/g).length).toBe(2);
    expect(APP).toContain('onLockMoment={hapticLocked}');
  });

  test('a choice chip ticks when it becomes the choice, and not when it already is', async () => {
    const { ChoiceChip } = require('../components/ui/FormBits');
    const onClick = jest.fn();
    const { getByRole, rerender } = render(<ChoiceChip selected={false} onClick={onClick}>Tonight</ChoiceChip>);
    fireEvent.click(getByRole('button', { name: 'Tonight' }));
    await flush();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(mockPlugin.selectionChanged).toHaveBeenCalledTimes(1);
    rerender(<ChoiceChip selected onClick={onClick}>Tonight</ChoiceChip>);
    fireEvent.click(getByRole('button', { name: 'Tonight' }));
    await flush();
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(mockPlugin.selectionChanged).toHaveBeenCalledTimes(1);
    // Its own colour change keeps the shared release.
    expect(read('components', 'ui', 'FormBits.js')).toContain('transition: `background-color 0.15s ease, color 0.15s ease, ${PRESS_TRANSITION}`,');
  });

  test('the travel mode segment ticks only on a change', () => {
    expect(read('screens', 'ChatDetail.js')).toContain('onClick={() => { if (myTravel.mode !== mode) hapticSelection(); updateTravel({ ...myTravel, mode }); }}');
  });

  test('Down / Maybe / Not keeps its light impact and the shared release', () => {
    const pulse = read('components', 'nest', 'NestPulse.js');
    expect(pulse).toContain('transition: `background-color 160ms var(--ease-out), color 160ms var(--ease-out), ${PRESS_TRANSITION}`,');
    const at = APP.indexOf('const handleSetPulse = useCallback(async (status) => {');
    expect(APP.slice(at, at + 400)).toMatch(/pulseBusyRef\.current = true;\s*hapticTap\(\);/);
  });

  test('a message send keeps its light impact', () => {
    expect(read('components', 'chat', 'ChatInputBar.js')).toMatch(/hapticTap\(\);/);
  });

  test('list rows fill instead of shrinking: Needs you, the You screen, the chat list', () => {
    expect(read('components', 'nest', 'NestRows.js')).toContain('className="nest-row-btn"');
    const you = read('screens', 'ProfileSettings.js');
    expect(you).toContain('<button key={m.s} className="hit44 glass-btn glass-secondary press-row"');
    expect(you).toContain('<button className="hit44 glass-btn glass-secondary press-row" onClick={() => openExternal(\'https://www.flockcorp.com/support\')}');
    expect(you).toContain('<button className="hit44 glass-btn glass-secondary press-row" onClick={() => setPaywallTrigger(\'settings\')}');
    const chats = read('screens', 'ChatListScreen.js');
    expect(chats).toContain('<button className="hit44 press-row" key={`dm-${dm.userId}`}');
    expect(chats).toContain('<button className="hit44 press-row" onClick={() => { if (editingFlockList) return; setSelectedFlockId(f.id);');
  });
});
