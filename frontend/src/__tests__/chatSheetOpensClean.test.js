/**
 * A SHEET MUST OPEN WHERE IT IS SUPPOSED TO (2026-09-05).
 *
 * Tapping the plus in the chat bar opens the composer sheet while the keyboard
 * is up, and that combination has one trap in it that is easy to fall into and
 * hard to read afterwards.
 *
 * The keyboard dock does not resize the WebView. It lifts two elements with a
 * transform: the message list and the input bar. A transformed element becomes
 * the containing block for any `position: fixed` descendant, so a sheet
 * rendered INSIDE the bar would stop being positioned against the viewport and
 * would open against a bar that is itself part way through a 250ms slide. The
 * sheet would land in the wrong place, and it would land somewhere different
 * depending on how far through the animation the tap arrived.
 *
 * Nothing about that failure looks like a bug in the sheet. It looks like the
 * sheet is fine and the phone is broken. So this pins the shape that avoids it:
 * the bar draws the button, the screen owns the sheet, and the two are
 * siblings.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test chatSheetOpensClean --watchAll=false
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

const bar = read('components/chat/ChatInputBar.js');
const sheetsCss = read('components/chat/sheets/sheets.css');
const hook = read('hooks/useKeyboardComposer.js');

test('the input bar reports the tap and renders no sheet of its own', () => {
  // The bar takes onPlus and calls it. It must not import or render a sheet,
  // because anything it renders sits inside the element the keyboard lifts.
  expect(bar).toMatch(/onPlus/);
  expect(bar).not.toMatch(/from '\.\/sheets\//);
  expect(bar).not.toMatch(/ComposerPlusSheet|FlockProfileSheet|PinStrip|PinnedMessageBar/);
});

test('the keyboard dock lifts only the list and the bar, never a shared ancestor', () => {
  // If this ever lifts a screen root instead, every fixed-position sheet, menu
  // and toast inside it starts positioning against that root.
  const calls = hook.match(/applyLift\([^)]*\)/g) || [];
  expect(calls.length).toBeGreaterThan(0);
  calls.forEach((c) => {
    expect(c).toMatch(/applyLift\((barRef|listRef)\.current,/);
  });
});

test('the sheet is anchored to the viewport and sits above the chat', () => {
  expect(sheetsCss).toMatch(/\.cs-backdrop \{[\s\S]{0,200}position: fixed;[\s\S]{0,200}inset: 0;/);
  // Bottom aligned, so it rises from the edge the thumb is nearest.
  expect(sheetsCss).toMatch(/align-items: flex-end;/);
  // Dark enough that anything still settling underneath is not visible while
  // it opens, which is the other half of opening clean.
  expect(sheetsCss).toMatch(/background: rgba\(0, 0, 0, 0\.7\);/);
});

test('the open is animated, respects reduced motion, and clears the home indicator', () => {
  expect(sheetsCss).toMatch(/animation: cs-rise 200ms/);
  expect(sheetsCss).toMatch(/animation: cs-fade 150ms/);
  expect(sheetsCss).toMatch(/padding: 8px 0 calc\(12px \+ var\(--safe-bottom\)\);/);
  const reduced = sheetsCss.slice(sheetsCss.indexOf('@media (prefers-reduced-motion: reduce)'));
  expect(reduced).toMatch(/\.cs-backdrop,/);
  expect(reduced).toMatch(/animation: none;/);
});

test('opening a sheet takes the keyboard down first', () => {
  const profile = read('components/chat/sheets/FlockProfileSheet.js');
  expect(profile).toMatch(/function useKeyboardDismiss\(open\)/);
  // Only a text control is blurred: blurring a button would steal focus for
  // nothing and break the focus restore on close.
  expect(profile).toMatch(/tag === 'input' \|\| tag === 'textarea'/);
  expect(profile).toMatch(/useKeyboardDismiss\(!!open\)/);
});
