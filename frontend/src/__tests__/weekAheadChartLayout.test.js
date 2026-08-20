/**
 * WEEK AHEAD — the chart that painted over its own heading, locked shut.
 *
 * WHY THIS FILE EXISTS. The venue dashboard's "Week Ahead (projected evening
 * peak)" card drew six day columns of bar + weekday + score inside a flex row
 * that declared `height: 60px` and `alignItems: flex-end`. At 390px a column
 * measures 81px, so every column hung 21px out of the top of its own row, and
 * a bar is painted after the heading that precedes it: six red blocks landed
 * across the lower half of the title and cut the words in two. Jayden reported
 * it from a screenshot.
 *
 * The fix is structural rather than a nudge — the bar now lives in its own
 * fixed-height well and the two labels sit under that well in flow, so no box
 * in the card has a height its contents can exceed. That is exactly the kind of
 * thing a later edit undoes by "simplifying" one div away, which is why it is
 * pinned here.
 *
 * Source-scanning, because the defect is a CHOICE at a call site. jsdom has no
 * layout engine: it reports every one of these boxes as 0x0 and would call the
 * broken version and the fixed version identical. The geometry was verified in
 * a real browser at 390px and 320px; these assertions stand in for it.
 *
 * LF-normalized at the read. This repo is cloned with core.autocrlf=true and
 * has no .gitattributes, so every tracked file is CRLF on disk and a pattern
 * anchored on a bare `\n` would match nothing.
 */

const fs = require('fs');
const path = require('path');

const APP = fs
  .readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8')
  .replace(/\r\n/g, '\n');

/** The IIFE that draws the chart, from the heading down to the card's close. */
function chartBlock() {
  const start = APP.indexOf('Week Ahead (projected evening peak)');
  expect(start).toBeGreaterThan(-1);
  const end = APP.indexOf('Your Strip Tonight', start);
  expect(end).toBeGreaterThan(start);
  return APP.slice(start, end);
}

/** A `const NAME = <number>;` from App.js, so the test reads the real value. */
function numericConst(name) {
  const m = APP.match(new RegExp(`const ${name} = ([0-9.]+);`));
  expect(m).not.toBeNull();
  return Number(m[1]);
}

describe('nothing in the card has a height its contents can overflow', () => {
  test('the day-column row does not declare a fixed height', () => {
    // The whole defect in one assertion. `alignItems: flex-end` on a row whose
    // children are taller than the row does not clip and does not push the row
    // open: it overflows UPWARD, into the heading. A row with no height is as
    // tall as the tallest column and cannot do that to anything.
    const row = chartBlock().match(
      /<div style=\{\{ display: 'flex', gap: '4px', alignItems: 'flex-end'[^}]*\}\}>/
    );
    expect(row).not.toBeNull();
    expect(row[0]).not.toMatch(/height:/);
  });

  test('the bar sits in a well sized so no score can overflow it', () => {
    const block = chartBlock();
    const well = numericConst('WEEK_BAR_WELL_PX');

    // The well is a real fixed-height box — that is what keeps the six bars on
    // one baseline now that the row is free to grow.
    expect(block).toMatch(/height: `\$\{WEEK_BAR_WELL_PX\}px`/);

    // Heights are `score * <scale>`, and the score scale tops out at 100, so
    // the well has to clear 100 * scale. Read the scale out of the source
    // rather than restating it, so tuning the chart cannot silently make the
    // well too short.
    const scale = block.match(/\(d\.peakScore \|\| 0\) \* ([0-9.]+)/);
    expect(scale).not.toBeNull();
    expect(well).toBeGreaterThanOrEqual(100 * Number(scale[1]));

    // And the drawn height is clamped to the well regardless, so a score the
    // server should never send cannot reach back over the heading either.
    expect(block).toMatch(/Math\.min\(WEEK_BAR_WELL_PX, Math\.max\(3,/);
  });
});

describe('the week is drawn in the deep weight of the shared crowd bands', () => {
  test('the chart asks for the deep colour, not the standard one', () => {
    const block = chartBlock();
    expect(block).toMatch(/crowdColorDeepFor\(d\.peakScore\)/);
    expect(block).not.toMatch(/crowdColorFor\(/);
  });

  test('deep and standard read the same thresholds from one place', () => {
    // 1d0538b put this chart on the app-wide crowd scale so that 78 means the
    // same thing here as on a map pin. Going darker must not reintroduce a
    // second set of thresholds — both colour functions route through
    // crowdBandFor, and only crowdBandFor names the numbers.
    const band = APP.match(/const crowdBandFor = \(score\) => \{[\s\S]*?\n\};/);
    expect(band).not.toBeNull();
    expect(band[0]).toMatch(/score > 60/);
    expect(band[0]).toMatch(/score > 40/);

    for (const name of ['crowdColorFor', 'crowdColorDeepFor']) {
      const fn = APP.match(new RegExp(`const ${name} = \\([^)]*\\) => \\{[\\s\\S]*?\\n\\};`));
      expect(fn).not.toBeNull();
      expect(fn[0]).toMatch(/crowdBandFor\(score\)/);
      expect(fn[0]).not.toMatch(/score > /);
    }
  });

  test('the deep end is theme tokens, not hardcoded hex', () => {
    // The point of using --accent-*-text is that both themes are already
    // resolved: the dark palette lightens these deliberately, because on a dark
    // card the deep end of a hue is the unreadable one. A literal hex here
    // would be a light-mode-only decision.
    const fn = APP.match(/const crowdColorDeepFor = \(score\) => \{[\s\S]*?\n\};/);
    expect(fn).not.toBeNull();
    expect(fn[0]).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    for (const token of ['--accent-red-text', '--accent-amber-text', '--accent-green-text']) {
      expect(fn[0]).toContain(`var(${token})`);
    }
  });

  test('a flat week still reads, and a week with spread still shows it', () => {
    const block = chartBlock();
    const floor = numericConst('WEEK_BAR_WEIGHT_MIN');

    // Every bar is drawn in the deep colour now, so the faint end of the ramp
    // has to stay heavy or the quiet nights wash out to pink. It also has to
    // stay below 1, or the week loses the differentiation 1d0538b added.
    expect(floor).toBeGreaterThanOrEqual(0.6);
    expect(floor).toBeLessThan(1);

    // A week whose evenings are all within rounding of each other has no
    // quietest night to draw faint, and dividing by that zero range would give
    // every bar NaN opacity. It draws at full strength instead.
    expect(block).toMatch(/if \(hi === lo\) return 1;/);
    expect(block).toMatch(
      /return WEEK_BAR_WEIGHT_MIN \+ \(1 - WEEK_BAR_WEIGHT_MIN\) \* \(\(s - lo\) \/ \(hi - lo\)\);/
    );
  });
});
