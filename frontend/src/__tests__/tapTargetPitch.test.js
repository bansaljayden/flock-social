// 44PT TO A FINGER, WHERE TWO .hit44 OVERLAYS MEET.
//
// index.css's .hit44 lays a transparent 44x44 box over a control drawn
// smaller. Two of them closer than 44 centre to centre overlap, and the later
// one wins the overlap, so the first control loses its edge. The 2026-10-20
// proportion audit (scripts/audit-proportions.mjs) measured three places that
// did: the Plans day cells (40 tall on a 2px gap), the Messages header buttons
// (36 wide on a 6px gap), and two website links drawn under 44 with no overlay
// at all. These pin the arithmetic that fixed them.

import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const px = (s) => Number(String(s).replace('px', ''));

test('Plans day cells sit on a 44pt row pitch', () => {
  const cal = read('screens', 'CalendarScreen.js');
  const grid = cal.slice(cal.indexOf('{/* Calendar grid.'));
  const gap = px(grid.match(/gridTemplateColumns: 'repeat\(7, 1fr\)', gap: '(\d+)px'/)[1]);
  const cell = px(grid.match(/className="hit44" key=\{day\}[\s\S]*?height: '(\d+)px'/)[1]);
  const spacer = px(grid.match(/key=\{`e-\$\{i\}`\} style=\{\{ height: '(\d+)px' \}\}/)[1]);
  expect(cell + gap).toBeGreaterThanOrEqual(44);
  // The empty leading cells keep the same height, or the first row shifts.
  expect(spacer).toBe(cell);
});

test('the Messages header buttons sit on a 44pt pitch', () => {
  const list = read('screens', 'ChatListScreen.js');
  const row = list.slice(list.indexOf('aria-label="Reorder your flocks"') - 600, list.indexOf('aria-label="Search chats"') + 400);
  const gap = px(row.match(/<div style=\{\{ display: 'flex', gap: '(\d+)px' \}\}>/)[1]);
  const widths = [...row.matchAll(/style=\{\{ width: '(\d+)px', height: '\d+px', borderRadius/g)].map((m) => px(m[1]));
  expect(widths).toHaveLength(3);
  widths.forEach((w) => expect(w + gap).toBeGreaterThanOrEqual(44));
});

test('the two Messages toggles say which state they are in', () => {
  const list = read('screens', 'ChatListScreen.js');
  expect(list).toContain('aria-label="Reorder your flocks" aria-pressed={editingFlockList}');
  expect(list).toContain('aria-label="Search chats" aria-expanded={showChatSearch}');
});

// A band placed from the padding box: its drawn height, less the border it
// sits inside, plus the band above and below.
const bandHeight = (drawn, border, top, bottom) => drawn - 2 * border + top + bottom;

test('Open Flock in the website bar reaches 44 without growing', () => {
  const css = read('website', 'LandingPage.css');
  const btn = css.slice(css.indexOf('.lp-nav .lp-nav-open {'));
  const drawn = px(btn.match(/height: (\d+)px;/)[1]);
  const band = css.slice(css.indexOf('.lp-nav .lp-nav-open::after {'));
  const top = -px(band.match(/top: (-\d+)px;/)[1]);
  const bottom = -px(band.match(/bottom: (-\d+)px;/)[1]);
  // .lp-btn's border is 1px.
  expect(css).toMatch(/\.lp-btn \{[\s\S]*?border: 1px solid transparent;/);
  expect(bandHeight(drawn, 1, top, bottom)).toBeGreaterThanOrEqual(44);
  expect(btn.slice(0, btn.indexOf('}'))).toContain('position: relative;');
});

test('the legal pages\' contents chips reach 44 and split the row gap', () => {
  const css = read('website', 'PrivacyPolicy.css');
  const mobile = css.slice(css.indexOf('@media (max-width: 959px) {'));
  const rowGap = px(mobile.match(/\.pp-toc ol \{[\s\S]*?gap: (\d+)px;/)[1]);
  const band = mobile.slice(mobile.indexOf('.pp-toc a::after {'));
  const top = -px(band.match(/top: (-\d+)px;/)[1]);
  const bottom = -px(band.match(/bottom: (-\d+)px;/)[1]);
  // Measured 38 tall at 320 to 430px: the text inherits .pp's 1.7 line height.
  const drawn = 38;
  expect(bandHeight(drawn, 1, top, bottom)).toBeGreaterThanOrEqual(44);
  // The rows are a pitch of drawn + gap, and that is what each chip keeps
  // where two bands meet, so it has to be 44 too.
  expect(drawn + rowGap).toBeGreaterThanOrEqual(44);
  // And a band never reaches the next chip's drawn box.
  expect(top - 1).toBeLessThan(rowGap);
  expect(bottom - 1).toBeLessThan(rowGap);
});
