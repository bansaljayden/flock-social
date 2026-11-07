/**
 * CLOSING THE VENUE SHEET DOES NOT RAISE THE KEYBOARD (2026-11-06).
 *
 * A tester searched "torre", tapped the result, read the sheet and closed it
 * with X to see the crowd card underneath. The search box took focus back and
 * the iPhone keyboard slid up over the card's hourly bars, busiest hours and
 * wait. Two causes: the dropdown row left focus in #search-input when it
 * opened the sheet, and the sheet's dialog behaviour hands focus back to
 * whatever held it at open (App.js restoreFocusTo), which re-raised the
 * keyboard.
 *
 *   - The row blurs the box before it opens the sheet.
 *   - restoreFocusTo passes over text fields on a coarse pointer and focuses
 *     the nearest control beside it; a mouse and keyboard still get the field.
 *
 * FRONTEND test (jest via react-scripts).
 */
import { restoreFocusTo } from '../App';
import { isTextEntryField, isCoarsePointer } from '../lib/textEntry';

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');

// jsdom lays nothing out, so every element measures 0x0 and the app's
// isFocusable() would refuse all of them. Give attached elements a box.
const realWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return this.isConnected ? 120 : 0; } });
});
afterAll(() => {
  if (realWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', realWidth);
});

const pointer = (coarse) => {
  window.matchMedia = (q) => ({ matches: q === '(pointer: coarse)' ? coarse : false, media: q, addEventListener() {}, removeEventListener() {} });
};

const searchBar = () => {
  document.body.innerHTML = `
    <div id="bar">
      <div id="box">
        <input id="search-input" type="text" aria-label="Search venues" />
        <button id="clear" aria-label="Clear search">x</button>
      </div>
      <button id="features">Features</button>
    </div>`;
  return { input: document.getElementById('search-input'), clear: document.getElementById('clear') };
};

afterEach(() => { delete window.matchMedia; document.body.innerHTML = ''; });

test('on a touch screen the sheet closing does not put the caret back in the search box', () => {
  pointer(true);
  const { input, clear } = searchBar();
  restoreFocusTo(input);
  expect(document.activeElement).not.toBe(input);
  expect(document.activeElement).toBe(clear);
});

test('with a mouse and keyboard the search box gets its caret back, as before', () => {
  pointer(false);
  const { input } = searchBar();
  restoreFocusTo(input);
  expect(document.activeElement).toBe(input);
});

test('a button opener is restored on a touch screen too: only text fields are passed over', () => {
  pointer(true);
  searchBar();
  const features = document.getElementById('features');
  restoreFocusTo(features);
  expect(document.activeElement).toBe(features);
});

test('what counts as a field that raises the keyboard', () => {
  const el = (tag, type) => { const e = document.createElement(tag); if (type) e.type = type; return e; };
  expect(isTextEntryField(el('input'))).toBe(true);
  expect(isTextEntryField(el('input', 'search'))).toBe(true);
  expect(isTextEntryField(el('input', 'email'))).toBe(true);
  expect(isTextEntryField(el('textarea'))).toBe(true);
  expect(isTextEntryField(el('input', 'checkbox'))).toBe(false);
  expect(isTextEntryField(el('input', 'range'))).toBe(false);
  expect(isTextEntryField(el('button'))).toBe(false);
  expect(isTextEntryField(null)).toBe(false);
  delete window.matchMedia;
  expect(isCoarsePointer()).toBe(false);
});

test('the dropdown row lets go of the search box before it opens the sheet', () => {
  const explore = read('screens', 'ExploreScreen.js');
  const row = explore.slice(explore.indexOf("key={venue.place_id}"), explore.indexOf('openVenueDetail(venue.place_id'));
  expect(row).toMatch(/document\.getElementById\('search-input'\)/);
  expect(row).toMatch(/box\.blur\(\)/);
});
