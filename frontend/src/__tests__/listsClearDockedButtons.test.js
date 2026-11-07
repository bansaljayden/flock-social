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

test('the docked row is the dock gap plus the button\'s own 52px', () => {
  expect(APP).toContain('const FAB_DOCK_GAP = 12;');
  expect(APP).toContain('const FAB_SIZE = 52;');
  expect(APP).toContain('const dockedRowHeight = FAB_DOCK_GAP + FAB_SIZE;');
  // FAB_SIZE is the disc SafetyButton actually draws. (Birdie's disc left the
  // Nest on 2026-11-06.)
  expect(block('const SafetyButton = () =>')).toMatch(/width: '52px',\s*height: '52px'/);
  expect(APP).toMatch(/if \(isTop\) \{ pos\.top = '60px'; \} else \{ pos\.bottom = fabDockBottom; \}/);
});

test('the Nest\'s scroll ends at the strip above the tabs, and the strip is the docked row and 8px', () => {
  // NOTHING FLOATS OVER THE LIST (2026-11-06). The list used to pad its end by
  // the docked row, which kept only the LAST card clear: every card above it
  // still scrolled under SOS. Now the scroll box ends at a strip that holds
  // SOS, so no card can pass under it at any scroll position.
  const home = APP.slice(APP.indexOf('const HomeScreen = () => {'));
  const feed = home.slice(home.indexOf('<div ref={feedScroll.home.ref}'), home.indexOf('>', home.indexOf('<div ref={feedScroll.home.ref}')) + 1);
  expect(feed).toContain("padding: '0 var(--nest-gutter) 16px'");
  expect(APP).toContain('const nestDockHeight = FAB_DOCK_GAP + FAB_SIZE + NEST_DOCK_EXTRA;');
  const dock = fs.readFileSync(path.join(__dirname, '..', 'components', 'nest', 'NestDock.js'), 'utf8');
  expect(dock).toContain('export const NEST_DOCK_EXTRA = 8;');
  // A flex child between the scroll box and the tab bar, at one height.
  expect(dock).toMatch(/style=\{\{ position: 'relative', flexShrink: 0, height: `\$\{height\}px`, backgroundColor: 'var\(--bg-primary\)' \}\}/);
  expect(home.indexOf('<NestDock')).toBeGreaterThan(home.indexOf('<div ref={feedScroll.home.ref}'));
  expect(home.indexOf('<NestDock')).toBeLessThan(home.indexOf('{BottomNav()}'));
});

// The same sweep found the Messages list doing it with SOS: on a 390x667
// phone, scrolled to the end, SOS covered 2,366 px2 of the last conversation
// row's right end, where the member count and the unread badge sit.
test('the Messages list is handed the row and keeps it clear on top of its own 12px', () => {
  const LIST = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ChatListScreen.js'), 'utf8').replace(/\r\n/g, '\n');
  const props = APP.slice(APP.indexOf('const chatListScreenProps = {'), APP.indexOf('};', APP.indexOf('const chatListScreenProps = {')));
  expect(props).toMatch(/\n\s+dockedRowHeight,\n/);
  expect(LIST).toMatch(/\n\s+dockedRowHeight = 0,\n/);
  const scroller = LIST.slice(LIST.indexOf('<div ref={feedScroll.chat.ref}'), LIST.indexOf('>', LIST.indexOf('<div ref={feedScroll.chat.ref}')) + 1);
  expect(scroller).toContain('padding: `8px 12px ${12 + dockedRowHeight}px`');
});
