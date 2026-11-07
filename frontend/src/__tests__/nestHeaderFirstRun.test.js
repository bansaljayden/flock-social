/**
 * THE NEST HEADER, AS A BRAND-NEW ACCOUNT FIRST SEES IT.
 *
 * Three things sat above the empty state on a new account's first screen and
 * each one said something that was not so:
 *
 * 1. "0 flocks · 0 friends". A tally of nothing, directly above an empty
 *    state that already says there are no flocks and offers Start a flock and
 *    Add friends at full size. Since 2026-11-06 the Nest prints no count at
 *    all: a friend count is a popularity number on a teenager's first screen,
 *    and the flock count read "0 flocks" while the list was still loading.
 * 2. The Tonight? pulse, Down / Maybe / Not, captioned "Friends see your
 *    answer until it clears at 4 AM." With no friends that caption is false,
 *    and it was the first interactive thing on the screen.
 * 3. The greeting that cycled above the name. One of its lines was "Rounding
 *    up the group...", which on an empty screen reads as the app still
 *    loading. Since 2026-11-06 it does not cycle at all: it is one line that
 *    says the day ("Friday evening", lib/nestTime.js).
 *
 * HomeScreen is declared inside FlockAppInner, so it cannot be rendered on its
 * own. What can be done without rendering it is done: the pulse guard is
 * lifted out of App.js and run against the states that matter, including the
 * one where the stats read has not landed (friendCount null), which must not
 * be read as zero.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test nestHeaderFirstRun --watchAll=false
 */
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('App.js');
// The whole of HomeScreen. It used to end at the scroll box, because the
// header sat above it; the header scrolls with the page now (2026-11-06), so
// the slice runs to the end of the screen.
const HOME = (() => {
  const at = APP.indexOf('const HomeScreen = () => {');
  expect(at).toBeGreaterThan(-1);
  const end = APP.indexOf('// The past flocks screen was declared here', at);
  expect(end).toBeGreaterThan(at);
  return APP.slice(at, end);
})();
const LINES = HOME.split('\n');
// Source with its comments taken out, for the checks that a name is not USED:
// the notes that explain why a thing went still name it.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The JSX guard wrapping the element whose first line matches `opens`, where
// the element's content includes `marker`. Returned as the expression text
// between `{` and `&& (`, which is what gets run below.
function guardAbove(marker, opens) {
  const markerLine = LINES.findIndex((l) => l.includes(marker));
  expect(markerLine).toBeGreaterThan(-1);
  let open = markerLine;
  while (open >= 0 && !opens.test(LINES[open])) open -= 1;
  expect(open).toBeGreaterThan(-1);
  const guard = LINES[open - 1].trim().match(/^\{(.+) && \((<>)?$/);
  expect(guard).not.toBeNull();
  return { expr: guard[1], line: open - 1 };
}

// Runs a lifted guard. Only the names the header reads are in scope, so a
// guard that grew a new dependency fails here instead of passing on undefined.
const run = (expr, scope) => new Function('liveFlocks', 'friendCount', 'myPulse', `return (${expr});`)(
  scope.liveFlocks, scope.friendCount, scope.myPulse
);

describe('the Nest prints no count', () => {
  test('no flock or friend tally is drawn in the header', () => {
    expect(HOME).not.toMatch(/\{liveFlocks\.length\}<\/span>/);
    expect(HOME).not.toMatch(/\{friendCount\}<\/span>/);
    expect(HOME).not.toMatch(/'flock' : 'flocks'/);
    expect(HOME).not.toMatch(/'friend' : 'friends'/);
  });

  test('the numbers are still on You, where they were already shown', () => {
    const profile = read('screens', 'ProfileSettings.js');
    expect(profile).toMatch(/\{ l: 'Friends', v: friendCount \?\? '\\u2013' \}/);
  });
});

describe('the Tonight? pulse', () => {
  // The control moved into components/nest/NestPulse.js on 2026-11-06, under
  // the heading Out tonight?; the guard that decides whether it is drawn is
  // still App.js's, on the line above the element.
  const { expr } = guardAbove('<NestPulse', /^\s*<NestPulse/);
  const PULSE = read('components', 'nest', 'NestPulse.js');

  test('is not offered to an account with no friends to see the answer', () => {
    expect(run(expr, { liveFlocks: [], friendCount: 0, myPulse: null })).toBeFalsy();
  });

  test('stays while the friend count is still unknown, so a slow read does not hide it', () => {
    expect(run(expr, { liveFlocks: [], friendCount: null, myPulse: null })).toBeTruthy();
  });

  test('is offered once there is a friend', () => {
    expect(run(expr, { liveFlocks: [], friendCount: 1, myPulse: null })).toBeTruthy();
  });

  test('an answer already set keeps the control, so it can be changed or cleared', () => {
    expect(run(expr, { liveFlocks: [], friendCount: 0, myPulse: { status: 'down' } })).toBeTruthy();
  });

  test('the caption goes with the control, not after it', () => {
    // The caption is inside NestPulse, the element the guard draws, so
    // "Friends see your answer" is never on screen without the control.
    expect(PULSE).toContain('Friends see your answer until it clears at 4 AM.');
    expect(HOME).not.toContain('Friends see your answer');
    expect(PULSE).toMatch(/aria-label=\{`Tonight: \$\{opt\.label\}`\}/);
  });
});

describe('the line over the greeting', () => {
  // It was CyclingGreeting: six lines, a new one every three seconds, each
  // arriving on a slot-machine spin. Motion that starts by itself pulls the
  // eye whether or not there is anything to see (WCAG 2.2.2 asks for no
  // self-starting movement), and the line said nothing that changed.
  const DAYLINE = read('components', 'nest', 'NestDayLine.js');

  test('the cycling greeting and its spin are gone', () => {
    expect(APP).not.toMatch(/CyclingGreeting/);
    expect(APP).not.toMatch(/const GREETINGS = \[/);
    expect(read('index.css')).not.toMatch(/slotSpin/);
  });

  test('nothing in the header runs a timer, and the line comes from dayLine', () => {
    expect(HOME).toMatch(/<NestDayLine \/>/);
    expect(HOME).not.toMatch(/setInterval/);
    expect(DAYLINE).not.toMatch(/setInterval/);
    expect(DAYLINE).toMatch(/import \{ dayLine, useNow \} from '\.\.\/\.\.\/lib\/nestTime';/);
    expect(DAYLINE).toMatch(/const line = useNow\(60000, dayLine\);/);
    // The words are swapped when the part of the day changes, never animated.
    expect(code(DAYLINE)).not.toMatch(/animation|transition/);
  });

  test('the NIGHT chip is gone: auto night mode is the palette itself', () => {
    expect(code(HOME)).not.toMatch(/ NIGHT\b/);
    expect(code(HOME)).not.toMatch(/isNightModeActive/);
  });

  test('the name is a title, so a plan name can be the largest words on the page', () => {
    const h1 = HOME.match(/<h1 style=\{\{([^}]*)\}\}>Hey, /);
    expect(h1).not.toBeNull();
    expect(h1[1]).toMatch(/fontSize: 'var\(--t-title\)'/);
    expect(h1[1]).toMatch(/fontFamily: 'var\(--font-display\)'/);
  });
});

describe('nothing the Nest draws overshoots', () => {
  // A cubic-bezier whose y runs outside 0..1 carries the value past its end and
  // brings it back: the bounce. The greeting's spin used one, and so did the
  // FAB corner snap, the FAB press, the Birdie sheet and its send button. Every
  // curve in the files that draw the Nest and its floating buttons eases into
  // place and stops (2026-11-06).
  const FILES = ['App.js', 'index.css', 'lib/fabGlide.js', 'components/birdie/BirdiePanel.js'];

  test.each(FILES)('every cubic-bezier in %s stays inside 0..1', (file) => {
    const src = read(...file.split('/'));
    const curves = [...src.matchAll(/cubic-bezier\(([^)]+)\)/g)].map((m) => m[1].split(',').map(Number));
    expect(curves.length).toBeGreaterThan(0);
    for (const [x1, y1, x2, y2] of curves) {
      for (const v of [x1, y1, x2, y2]) expect(Number.isFinite(v)).toBe(true);
      expect({ file, y1, y2, over: y1 > 1 || y1 < 0 || y2 > 1 || y2 < 0 }).toEqual({ file, y1, y2, over: false });
    }
  });

  test('the tab icons do not bounce on a tap', () => {
    expect(APP).not.toMatch(/tabBounce|tab-bounce/);
  });

  test('the FAB press grows on hover only where a pointer can hover', () => {
    const css = read('index.css');
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{\s*\.fab-press:hover \{\s*transform: scale\(1\.08\);/);
    expect(css.replace(/@media \(hover: hover\) and \(pointer: fine\) \{\s*\.fab-press:hover/, '')).not.toMatch(/\.fab-press:hover/);
  });
});

describe('the header scrolls with the page', () => {
  test('it is the first thing inside the Nest\'s scroll box', () => {
    const box = HOME.indexOf('<div ref={feedScroll.home.ref} data-nest-scroll="" onScroll={handleScroll}');
    expect(box).toBeGreaterThan(-1);
    const after = code(HOME.slice(box));
    const firstTag = after.slice(after.indexOf('>') + 1).match(/<([a-zA-Z]+)[\s>]/);
    expect(firstTag[1]).toBe('header');
    expect(after).toMatch(/<header data-nest-band="header"/);
  });

  test('"Start a flock" sits in the header, in words, on the gate the old slab had', () => {
    const header = HOME.slice(HOME.indexOf('<header data-nest-band="header"'), HOME.indexOf('</header>'));
    expect(header).toMatch(/\{\(flocksLoading \|\| liveFlocks\.length > 0\) && \(\s*<button type="button" className="hit44" onClick=\{\(\) => setCurrentScreen\('create'\)\}/);
    expect(header).toMatch(/\{Icons\.plus\('var\(--accent-purple-text\)', 15\)\} Start a flock/);
    // The full-width navy slab is gone; its class went with it.
    expect(HOME).not.toMatch(/neo-btn-primary/);
  });

  test('the top edge draws its hairline only while something is scrolled under it', () => {
    expect(HOME).toMatch(/<div ref=\{headerRef\} aria-hidden="true" style=\{\{ height: '1px'[^}]*opacity: \(TAB_SCROLL\.get\('home'\) \|\| 0\) > 0 \? 1 : 0, transition: 'opacity 120ms ease' \}\} \/>/);
    const handler = APP.slice(APP.indexOf('const handleScroll = useCallback((e) => {'), APP.indexOf('}, [feedScroll]);'));
    expect(handler).toContain('feedScroll.home.onScroll(e);');
    // A DOM write, made only when the scroll crosses 0: no state, no render.
    expect(handler).toContain("if ((line.style.opacity === '1') !== under) line.style.opacity = under ? '1' : '0';");
    expect(handler).not.toMatch(/set[A-Z]\w*\(/);
  });
});
