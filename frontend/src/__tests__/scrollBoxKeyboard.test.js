/**
 * A SCROLL BOX'S FIELDS STAY ABOVE THE KEYBOARD (hooks/useScrollBoxKeyboard.js).
 *
 * capacitor.config.ts sets the keyboard plugin to resize 'none', so the
 * WebView never shrinks for the keys and WebKit cannot scroll a covered field
 * into view. Add Friends' three fields sat under the keys with no scroll left
 * to free them, and no test looked at a full screen's fields, which is how it
 * shipped (Add Friends keyboard audit, 2026-11-23, kb-6). This runs the hook
 * against a box with a laid-out geometry: an iPhone 15 Pro (852pt tall), a box
 * under a 149pt header, and the keyboard sent the way the native bridge sends
 * it, as a window event carrying its height.
 *
 * Also here: lib/keyboardMotion.js, the curve and timings the hook moves on,
 * which the chat composer's hook re-exports.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test scrollBoxKeyboard --watchAll=false
 */
import React, { useRef } from 'react';
import { render, act, fireEvent } from '@testing-library/react';
import useScrollBoxKeyboard, { revealInBox, isTextField, KEYS_GAP, TOP_GAP, DRAG_BLUR_PX } from '../hooks/useScrollBoxKeyboard';
import { KEYBOARD_EASE, KEYBOARD_HIDE_MS, KEYBOARD_SHOW_MS, keyboardEaseAt } from '../lib/keyboardMotion';
import * as composer from '../hooks/useKeyboardComposer';

const SCREEN_H = 852;
const BOX_TOP = 149;
const BOX_BOTTOM = SCREEN_H;
const KEYS = 336;
const KEYS_TOP = SCREEN_H - KEYS;

/* The bridge builds these with document.createEvent('Events') and copies the
   data onto the event object (native-bridge.js). */
const nativeEvent = (name, data) => {
  const ev = document.createEvent('Events');
  ev.initEvent(name, false, false);
  Object.assign(ev, data || {});
  return ev;
};
const keysUp = (height = KEYS) => act(() => { window.dispatchEvent(nativeEvent('keyboardWillShow', { keyboardHeight: height })); });
const keysDown = () => act(() => { window.dispatchEvent(nativeEvent('keyboardWillHide')); });

/* A touch as WebKit delivers it to a document listener: bubbling, with the
   finger's position in `touches`. */
const touch = (type, target, y) => {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'touches', { value: y == null ? [] : [{ clientY: y }] });
  act(() => { target.dispatchEvent(ev); });
};

function Screen({ keep = '' }) {
  const box = useRef(null);
  const room = useRef(null);
  useScrollBoxKeyboard(box, room);
  return (
    <div ref={box} data-testid="box">
      <p data-testid="blank">Some words above the field</p>
      <div data-kb-keep={keep} data-testid="region">
        <input aria-label="Field" />
        <button type="button">Go</button>
      </div>
      <div ref={room} data-testid="room" aria-hidden="true" />
    </div>
  );
}

/**
 * Lays the box out the way WebKit does: `content` is its content's height up
 * to the room element, `pad` its bottom padding, the region sits at
 * `regionTop` in the content for `regionHeight`, and the field is the region's
 * last 44pt (or its first, with fieldFirst). Rects follow the box's scroll,
 * scrollHeight is never less than the box, and scrollTop is clamped to the
 * scroll range and held to whole points.
 */
function laidOut(ui, { content = 1000, pad = 0, regionTop = 900, regionHeight = 90, keep = '', fieldFirst = false } = {}) {
  const utils = render(ui || <Screen keep={keep} />);
  const box = utils.getByTestId('box');
  const room = utils.getByTestId('room');
  const region = utils.getByTestId('region');
  const field = utils.getByLabelText('Field');
  const clientHeight = BOX_BOTTOM - BOX_TOP;
  const roomHeight = () => parseFloat(room.style.height) || 0;
  box.style.paddingBottom = `${pad}px`;
  Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => Math.max(clientHeight, content + roomHeight() + pad) });
  let scrolled = 0;
  Object.defineProperty(box, 'scrollTop', {
    configurable: true,
    get: () => scrolled,
    set: (v) => { scrolled = Math.floor(Math.max(0, Math.min(v, box.scrollHeight - clientHeight))); },
  });
  box.getBoundingClientRect = () => ({ top: BOX_TOP, bottom: BOX_BOTTOM, left: 0, right: 393, width: 393, height: clientHeight });
  const at = (top, height) => () => {
    const y = BOX_TOP + top - box.scrollTop;
    return { top: y, bottom: y + height, left: 20, right: 373, width: 353, height };
  };
  region.getBoundingClientRect = at(regionTop, regionHeight);
  field.getBoundingClientRect = at(fieldFirst ? regionTop : regionTop + regionHeight - 44, 44);
  room.getBoundingClientRect = () => at(content, roomHeight())();
  return { ...utils, box, room, region, field };
}

let reduced = true;
beforeEach(() => {
  reduced = true;
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: SCREEN_H });
  window.matchMedia = jest.fn(() => ({ matches: reduced, addListener() {}, removeListener() {} }));
});
afterEach(() => {
  delete window.matchMedia;
  document.documentElement.style.removeProperty('--kb-height');
});

describe('the keys come up', () => {
  test('a field under them rises with its region to 12pt above them, and the box gains the room to do it', () => {
    const { box, room, region, field } = laidOut();
    act(() => { field.focus(); });
    keysUp();
    // The region ended at 1139 on screen; it has to end at 516 - 12 = 504.
    expect(box.scrollTop).toBe(1139 - (KEYS_TOP - KEYS_GAP));
    expect(region.getBoundingClientRect().bottom).toBe(KEYS_TOP - KEYS_GAP);
    // Room: enough for the end of the content to clear the keys
    // (852 - 516 + 12 = 348), which is more than this lift needed (338).
    expect(room.style.height).toBe(`${BOX_BOTTOM - KEYS_TOP + KEYS_GAP}px`);
    expect(room.style.transition).toBe('none');
  });

  test('a room that reflows the content above the region is measured again before the lift', () => {
    // WebKit for Windows, measured on the Contacts tab: once the box can
    // scroll it gains a classic scrollbar, the column narrows by 5pt and the
    // card above the phone field wraps one more line, 20pt. Lifted by the
    // distance read before the room existed, the field ended 20pt short.
    const { box, room, region, field } = laidOut(null, { content: 485, regionTop: 377, regionHeight: 69 });
    const roomHeight = () => parseFloat(room.style.height) || 0;
    const shift = () => (roomHeight() > 0 ? 20 : 0);
    const clientHeight = BOX_BOTTOM - BOX_TOP;
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => Math.max(clientHeight, 485 + shift() + roomHeight()) });
    const at = (top, height) => () => {
      const y = BOX_TOP + top + shift() - box.scrollTop;
      return { top: y, bottom: y + height, left: 20, right: 373, width: 353, height };
    };
    region.getBoundingClientRect = at(377, 69);
    field.getBoundingClientRect = at(377 + 69 - 44, 44);
    room.getBoundingClientRect = () => at(485, roomHeight())();
    act(() => { field.focus(); });
    keysUp();
    expect(region.getBoundingClientRect().bottom).toBe(KEYS_TOP - KEYS_GAP);
  });

  test('a second show for a shorter keyboard moves nothing, and the room does not shrink', () => {
    const { box, room, field } = laidOut();
    act(() => { field.focus(); });
    keysUp();
    const scrolled = box.scrollTop;
    const height = room.style.height;
    keysUp(291);
    expect(box.scrollTop).toBe(scrolled);
    expect(room.style.height).toBe(height);
  });

  test('a taller keyboard (the QuickType bar arriving) lifts the region the rest of the way', () => {
    const { region, field } = laidOut();
    act(() => { field.focus(); });
    keysUp(291);
    expect(region.getBoundingClientRect().bottom).toBe(SCREEN_H - 291 - KEYS_GAP);
    keysUp(KEYS);
    expect(region.getBoundingClientRect().bottom).toBe(KEYS_TOP - KEYS_GAP);
  });

  test('a region taller than the space above the keys keeps its top in the box and lifts by the field instead', () => {
    // A field with a long answer under it: the region runs 749 to 1349.
    const { region, field } = laidOut(null, { content: 1400, regionTop: 600, regionHeight: 600, fieldFirst: true });
    act(() => { field.focus(); });
    keysUp();
    // Lifting the region's bottom to 504 would put its top far above the box,
    // so the field's own bottom goes to 504, and the region starts on screen.
    expect(field.getBoundingClientRect().bottom).toBe(KEYS_TOP - KEYS_GAP);
    expect(region.getBoundingClientRect().top).toBeGreaterThanOrEqual(BOX_TOP + TOP_GAP);
  });

  test('a tab shorter than the box, on fractional points, still brings its field the whole way up', () => {
    // The QR code tab: its content ends above the box's bottom padding, and
    // the code box is its last block. Measured in WebKit before this was
    // fixed: the region ended at 505, a point under its line, because the
    // scroll range ran out a fraction short and WebKit scrolls in whole points.
    const { region, field } = laidOut(null, { content: 497.6, pad: 58, regionTop: 417.6, regionHeight: 80 });
    act(() => { field.focus(); });
    keysUp();
    expect(region.getBoundingClientRect().bottom).toBeLessThanOrEqual(KEYS_TOP - KEYS_GAP);
    expect(region.getBoundingClientRect().bottom).toBeGreaterThan(KEYS_TOP - KEYS_GAP - 1);
  });

  test('a field already above them is not moved, but the box still gets its room', () => {
    const { box, room, field } = laidOut(null, { regionTop: 100, regionHeight: 60 });
    act(() => { field.focus(); });
    keysUp();
    expect(box.scrollTop).toBe(0);
    expect(room.style.height).toBe(`${BOX_BOTTOM - KEYS_TOP + KEYS_GAP}px`);
  });

  test('a "top" region goes to 8pt under the top of the box, once for each focus', () => {
    const { box, region, field } = laidOut(null, { regionTop: 300, regionHeight: 60, keep: 'top' });
    act(() => { field.focus(); });
    keysUp();
    expect(region.getBoundingClientRect().top).toBe(BOX_TOP + TOP_GAP);
    // The person scrolls the results; a later show for the same focus (the
    // emoji keyboard) must not pull the field back to the top.
    box.scrollTop = 120;
    keysUp(381);
    expect(box.scrollTop).toBe(120);
  });

  test('a "top" region already at the top (a sticky search field) stays where it is', () => {
    const { box, field } = laidOut(null, { regionTop: 0, regionHeight: 64, keep: 'top' });
    act(() => { field.focus(); });
    keysUp();
    expect(box.scrollTop).toBe(0);
  });

  test('without a focused field in the box, a show moves nothing', () => {
    const { box, room } = laidOut();
    keysUp();
    expect(box.scrollTop).toBe(0);
    expect(room.style.height).toBe('');
  });

  test('focus moving to the field while the keys are already up lifts it at the height already known', () => {
    const { region, field } = laidOut();
    keysUp();
    act(() => { field.focus(); });
    expect(region.getBoundingClientRect().bottom).toBe(KEYS_TOP - KEYS_GAP);
  });

  test('the rise runs on the keyboard\'s own curve and time, frame by frame', () => {
    reduced = false;
    const frames = [];
    const raf = jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return frames.length; });
    const caf = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    try {
      const { box, field } = laidOut();
      act(() => { field.focus(); });
      keysUp();
      const to = 1139 - (KEYS_TOP - KEYS_GAP);
      expect(box.scrollTop).toBe(0);
      act(() => { frames.shift()(1000); });
      act(() => { frames.shift()(1000 + KEYBOARD_SHOW_MS / 2); });
      // Half the time, most of the way: the box holds whole points.
      expect(box.scrollTop).toBe(Math.floor(to * keyboardEaseAt(0.5)));
      expect(box.scrollTop).toBeGreaterThan(to / 2);
      act(() => { frames.shift()(1000 + KEYBOARD_SHOW_MS); });
      expect(box.scrollTop).toBe(to);
      expect(frames).toHaveLength(0);
    } finally {
      raf.mockRestore();
      caf.mockRestore();
    }
  });

  test('a finger on the box stops a rise still running, where it is', () => {
    reduced = false;
    const frames = [];
    const raf = jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { frames.push(cb); return 7; });
    const caf = jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    try {
      const { getByTestId, field } = laidOut();
      act(() => { field.focus(); });
      keysUp();
      touch('touchstart', getByTestId('blank'), 400);
      expect(caf).toHaveBeenCalledWith(7);
    } finally {
      raf.mockRestore();
      caf.mockRestore();
    }
  });
});

describe('the keys go down', () => {
  test('the room collapses over the keyboard\'s 200ms on its curve, so the content slides down with the keys', () => {
    reduced = false;
    const { room, field } = laidOut();
    act(() => { field.focus(); });
    keysUp();
    keysDown();
    expect(room.style.height).toBe('0px');
    expect(room.style.transition).toBe(`height ${KEYBOARD_HIDE_MS}ms ${KEYBOARD_EASE}`);
  });

  test('keyboardDidHide is a backstop for a will-hide that never came', () => {
    const { room, field } = laidOut();
    act(() => { field.focus(); });
    keysUp();
    act(() => { window.dispatchEvent(nativeEvent('keyboardDidHide')); });
    expect(room.style.height).toBe('0px');
  });

  test('under reduced motion it collapses at once', () => {
    const { room, field } = laidOut();
    act(() => { field.focus(); });
    keysUp();
    keysDown();
    expect(room.style.transition).toBe('none');
  });
});

describe('putting the keys away from the box', () => {
  test(`a drag of more than ${DRAG_BLUR_PX}pt puts them away`, () => {
    const { getByTestId, field } = laidOut();
    act(() => { field.focus(); });
    keysUp();
    touch('touchstart', getByTestId('blank'), 400);
    touch('touchmove', getByTestId('blank'), 400 + DRAG_BLUR_PX + 6);
    expect(document.activeElement).not.toBe(field);
  });

  test('a small wobble does not', () => {
    const { getByTestId, field } = laidOut();
    act(() => { field.focus(); });
    keysUp();
    touch('touchstart', getByTestId('blank'), 400);
    touch('touchmove', getByTestId('blank'), 400 + DRAG_BLUR_PX - 4);
    expect(document.activeElement).toBe(field);
  });

  test('a drag that began on the field itself (moving the caret) does not', () => {
    const { field } = laidOut();
    act(() => { field.focus(); });
    keysUp();
    touch('touchstart', field, 400);
    touch('touchmove', field, 460);
    expect(document.activeElement).toBe(field);
  });

  test('a tap on blank space puts them away, a tap on a button does not', () => {
    const { getByTestId, getByRole, field } = laidOut();
    act(() => { field.focus(); });
    keysUp();
    fireEvent.click(getByRole('button', { name: 'Go' }));
    expect(document.activeElement).toBe(field);
    fireEvent.click(getByTestId('blank'));
    expect(document.activeElement).not.toBe(field);
  });

  test('in a browser, where no keyboard event ever comes, drags and taps leave the field alone', () => {
    const { getByTestId, room, field } = laidOut();
    act(() => { field.focus(); });
    touch('touchstart', getByTestId('blank'), 400);
    touch('touchmove', getByTestId('blank'), 480);
    fireEvent.click(getByTestId('blank'));
    expect(document.activeElement).toBe(field);
    expect(room.style.height).toBe('');
  });
});

describe('leaving', () => {
  test('unmounting takes the room away and stops listening', () => {
    const { box, room, field, unmount } = laidOut();
    act(() => { field.focus(); });
    keysUp();
    expect(room.style.height).not.toBe('0px');
    const scrolled = box.scrollTop;
    unmount();
    expect(room.style.height).toBe('0px');
    window.dispatchEvent(nativeEvent('keyboardWillShow', { keyboardHeight: 400 }));
    expect(box.scrollTop).toBe(scrolled);
  });
});

describe('revealInBox, for an answer that lands after the field was put away', () => {
  const boxOf = (scrollTop = 0) => {
    const box = document.createElement('div');
    box.scrollTop = scrollTop;
    Object.defineProperty(box, 'clientHeight', { configurable: true, value: BOX_BOTTOM - BOX_TOP });
    Object.defineProperty(box, 'scrollHeight', { configurable: true, value: 2000 });
    box.getBoundingClientRect = () => ({ top: BOX_TOP, bottom: BOX_BOTTOM });
    return box;
  };
  const el = (box, top, height) => ({
    getBoundingClientRect: () => ({ top: top - box.scrollTop, bottom: top + height - box.scrollTop }),
  });

  test('with the keys down, an answer under the bottom edge comes up to 12pt above it', () => {
    const box = boxOf();
    const answer = el(box, 820, 60);
    revealInBox(box, answer);
    expect(answer.getBoundingClientRect().bottom).toBe(BOX_BOTTOM - KEYS_GAP);
  });

  test('with the keys up, it comes up to 12pt above them', () => {
    document.documentElement.style.setProperty('--kb-height', `${KEYS}px`);
    const box = boxOf();
    const answer = el(box, 600, 60);
    revealInBox(box, answer);
    expect(answer.getBoundingClientRect().bottom).toBe(KEYS_TOP - KEYS_GAP);
  });

  test('its top is never pushed out of the box, however tall it is', () => {
    const box = boxOf();
    const answer = el(box, 700, 900);
    revealInBox(box, answer);
    expect(answer.getBoundingClientRect().top).toBe(BOX_TOP + KEYS_GAP);
  });

  test('an answer already in view moves nothing', () => {
    const box = boxOf(40);
    revealInBox(box, el(box, 400, 60));
    expect(box.scrollTop).toBe(40);
  });

  test('nothing to reveal, or nothing to reveal it in, is not an error', () => {
    expect(() => revealInBox(null, null)).not.toThrow();
    expect(() => revealInBox(boxOf(), null)).not.toThrow();
  });
});

describe('what counts as a field', () => {
  test('text inputs and text areas do; buttons, boxes and switches do not', () => {
    const make = (html) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstChild; };
    expect(isTextField(make('<input />'))).toBe(true);
    expect(isTextField(make('<input type="tel" />'))).toBe(true);
    expect(isTextField(make('<input type="search" />'))).toBe(true);
    expect(isTextField(make('<textarea></textarea>'))).toBe(true);
    expect(isTextField(make('<input type="checkbox" />'))).toBe(false);
    expect(isTextField(make('<input type="range" />'))).toBe(false);
    expect(isTextField(make('<button>Go</button>'))).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});

/* ── The sweep ───────────────────────────────────────────────────────────
   A field in a scroll box with nothing to bring it up shipped under the keys
   on Add Friends with every test green (keyboard audit, kb-6). Every text
   field in screens/ that sits inside an element scrolling on its own must be
   in a box this hook keeps (data-kb-scroll), in the Nest's (data-nest-scroll),
   or inside a sheet that rises with the keys (.kb-lift, or a style padded by
   the keyboard variables). Other screens had fields like that before this
   hook existed; they are counted per file below, and a count may only come
   down. A new one fails here: register its box with the hook. */
describe('a field in a full screen\'s scroll box is kept above the keys', () => {
  const fs = require('fs');
  const path = require('path');
  const parser = require('@babel/parser');
  const traverse = require('@babel/traverse').default;
  const DIR = path.join(__dirname, '..', 'screens');
  const PARSE = { sourceType: 'module', plugins: ['jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'dynamicImport'] };
  const NOT_TEXT = new Set(['checkbox', 'radio', 'file', 'range', 'hidden', 'button', 'submit', 'color']);

  /* Fields in scroll boxes no keyboard handling reaches, as of 2026-11-23. */
  const KNOWN = {
    'CalendarScreen.js': 3,
    'CreateScreen.js': 2,
    'ProfileSettings.js': 7,
    'RevenueScreen.js': 6,
    'VenueDashboard.js': 3,
    'VenueOnboarding.js': 6,
  };

  const sweep = () => {
    const found = {};
    for (const file of fs.readdirSync(DIR).filter((n) => n.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(DIR, file), 'utf8');
      const attr = (opening, name) => opening.attributes.find((a) => a.type === 'JSXAttribute' && a.name && a.name.name === name);
      const text = (node) => (node ? src.slice(node.start, node.end) : '');
      const scrolls = (opening) => /overflow(Y)?:\s*'(auto|scroll)'/.test(text(attr(opening, 'style')));
      const kept = (opening) => !!(attr(opening, 'data-kb-scroll') || attr(opening, 'data-nest-scroll'));
      const rises = (opening) => /kb-lift|--kb-inset|--kb-height|bottomInset/.test(text(attr(opening, 'className')) + text(attr(opening, 'style')));
      traverse(parser.parse(src, PARSE), {
        JSXOpeningElement(p) {
          const name = p.node.name && p.node.name.name;
          if (!['input', 'textarea', 'SearchInputLocal'].includes(name)) return;
          const type = attr(p.node, 'type');
          if (type && type.value && type.value.type === 'StringLiteral' && NOT_TEXT.has(type.value.value)) return;
          let inScroller = false;
          let covered = false;
          for (let q = p.parentPath; q; q = q.parentPath) {
            if (!q.node || q.node.type !== 'JSXElement' || q.node.openingElement === p.node) continue;
            const opening = q.node.openingElement;
            if (scrolls(opening)) inScroller = true;
            if (kept(opening) || rises(opening)) { covered = true; break; }
          }
          if (!inScroller) return;
          found[file] = found[file] || { kept: 0, bare: 0 };
          found[file][covered ? 'kept' : 'bare'] += 1;
        },
      });
    }
    return found;
  };
  const FOUND = sweep();

  test('the sweep sees Add Friends\' three fields, each in a box the hook keeps', () => {
    expect(FOUND['AddFriends.js']).toEqual({ kept: 3, bare: 0 });
  });

  test('no screen has gained a field the keys can cover; a fixed one lowers its count here', () => {
    // A file over its count has a new field nothing lifts: register its box
    // with useScrollBoxKeyboard. A file under it had one fixed: lower KNOWN.
    const bare = Object.fromEntries(Object.entries(FOUND).filter(([, n]) => n.bare > 0).map(([file, n]) => [file, n.bare]));
    expect(bare).toEqual(KNOWN);
  });
});

describe('lib/keyboardMotion.js', () => {
  test('the curve and the two durations are the composer\'s, measured off the capture', () => {
    expect(KEYBOARD_EASE).toBe('cubic-bezier(0.38, 0.7, 0.125, 1)');
    expect(KEYBOARD_SHOW_MS).toBe(250);
    expect(KEYBOARD_HIDE_MS).toBe(200);
  });

  test('the chat composer\'s hook hands out the same three values', () => {
    expect(composer.KEYBOARD_EASE).toBe(KEYBOARD_EASE);
    expect(composer.KEYBOARD_SHOW_MS).toBe(KEYBOARD_SHOW_MS);
    expect(composer.KEYBOARD_HIDE_MS).toBe(KEYBOARD_HIDE_MS);
  });

  test('the curve in JavaScript starts at 0, ends at 1, never goes back, and never runs past the end', () => {
    expect(keyboardEaseAt(0)).toBe(0);
    expect(keyboardEaseAt(-1)).toBe(0);
    expect(keyboardEaseAt(1)).toBe(1);
    expect(keyboardEaseAt(2)).toBe(1);
    let last = 0;
    for (let i = 1; i <= 100; i += 1) {
      const y = keyboardEaseAt(i / 100);
      expect(y).toBeGreaterThanOrEqual(last);
      expect(y).toBeLessThanOrEqual(1);
      last = y;
    }
    // An ease out: most of the way there by half time.
    expect(keyboardEaseAt(0.5)).toBeGreaterThan(0.75);
  });
});
