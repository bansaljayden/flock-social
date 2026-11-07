/**
 * THE KEYBOARD OVER THE NEST'S BIRDIE FIELD (lib/nestKeyboard.js).
 *
 * The WebView does not resize for the keys (capacitor.config.ts resize:
 * 'none'), so while Birdie's field on the Nest has focus the page's scroll box
 * takes room at its end the height of the keyboard, and the field is brought
 * to 12px above the keys once they are up. In a browser --kb-height is 0 and
 * nothing moves.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test nestKeyboard --watchAll=false
 */
import { liftNestField, dropNestField, NEST_KB_GAP } from '../lib/nestKeyboard';

const fs = require('fs');
const path = require('path');

afterEach(() => {
  jest.useRealTimers();
  document.body.innerHTML = '';
  document.documentElement.style.removeProperty('--kb-height');
});

const page = () => {
  document.body.innerHTML = '<div data-nest-scroll=""><section><input /></section></div>';
  const box = document.querySelector('[data-nest-scroll]');
  const field = document.querySelector('input');
  return { box, field };
};

test('focus pads the page\'s end by the keyboard, blur takes it away', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'index.css'), 'utf8');
  expect(css).toMatch(/\.nest-kb-open \{\s*padding-bottom: calc\(16px \+ var\(--kb-inset, 0px\)\) !important;\s*\}/);
  const { box, field } = page();
  liftNestField({ currentTarget: field });
  expect(box.classList.contains('nest-kb-open')).toBe(true);
  dropNestField({ currentTarget: field });
  expect(box.classList.contains('nest-kb-open')).toBe(false);
});

test('once the keys are up, the field comes to 12px above them', () => {
  jest.useFakeTimers();
  const { box, field } = page();
  document.documentElement.style.setProperty('--kb-height', '336px');
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
  field.focus();
  field.getBoundingClientRect = () => ({ top: 700, bottom: 744 });
  box.scrollTop = 100;
  liftNestField({ currentTarget: field });
  jest.advanceTimersByTime(400);
  // 744 - (844 - 336 - 12) = 248 further down the page.
  expect(box.scrollTop).toBe(100 + 744 - (844 - 336 - NEST_KB_GAP));
});

test('with no keyboard (a browser), nothing scrolls', () => {
  jest.useFakeTimers();
  const { box, field } = page();
  field.focus();
  field.getBoundingClientRect = () => ({ top: 700, bottom: 744 });
  box.scrollTop = 100;
  liftNestField({ currentTarget: field });
  jest.advanceTimersByTime(400);
  expect(box.scrollTop).toBe(100);
});
