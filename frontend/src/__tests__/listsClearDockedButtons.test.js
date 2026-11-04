/**
 * THE LAST ROW OF A LIST SCROLLS CLEAR OF THE DOCKED BUTTONS (2026-11-03).
 *
 * Birdie and SOS dock 12px above the tab bar as 52px discs. The Nest's list
 * ended 30px above the tab bar, so once it was long enough to scroll (a fourth
 * plan at 390x844, or three on a 390x667 phone) the last card's faces sat under
 * Birdie and its time chip under SOS, or under Birdie when Birdie was moved to
 * that corner. Measured on the screenshot rig, scrolled to the end: SOS covered
 * 31 x 18 px of "Sun 11:00 AM" at both heights; after, nothing overlaps and the
 * card ends 14px above the buttons.
 *
 * jsdom lays nothing out, so this pins the arithmetic the measurement checked:
 * the row's height is the dock gap plus the buttons' own size, and the Nest's
 * scroll area keeps that much clear under its last card.
 * FRONTEND test (jest via react-scripts).
 */
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8').replace(/\r\n/g, '\n');

const block = (start) => {
  const at = APP.indexOf(start);
  if (at < 0) throw new Error(`not found: ${start}`);
  return APP.slice(at, at + 2600);
};

test('the docked row is the dock gap plus the buttons\' own 52px', () => {
  expect(APP).toContain('const FAB_DOCK_GAP = 12;');
  expect(APP).toContain('const FAB_SIZE = 52;');
  expect(APP).toContain('const dockedRowHeight = FAB_DOCK_GAP + FAB_SIZE;');
  // FAB_SIZE is the discs SafetyButton and AIBubble actually draw.
  expect(block('const SafetyButton = () =>')).toMatch(/width: '52px',\s*height: '52px'/);
  expect(block('const AIBubble = () =>')).toMatch(/width: '52px',\s*height: '52px'/);
  // And both dock on the same row.
  expect(APP).toMatch(/if \(isTop\) \{ pos\.top = '60px'; \} else \{ pos\.bottom = fabDockBottom; \}/);
});

test('the Nest keeps the docked row clear under its last card', () => {
  const home = APP.slice(APP.indexOf('const HomeScreen = () => {'));
  const feed = home.slice(home.indexOf('<div ref={feedScroll.home.ref}'), home.indexOf('>', home.indexOf('<div ref={feedScroll.home.ref}')) + 1);
  expect(feed).toContain('padding: `4px 16px ${dockedRowHeight}px`');
});
