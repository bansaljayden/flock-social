/*
 * The annotated captures on the home page (website/AnnotatedShot.js, with
 * their notes and measured boxes in website/landingAnnotations.js).
 *
 * A note's leader has to end on the thing it names at every width, and its
 * marker must never cover what it names (2026-10-21: rings and numbers sat
 * on "5 of 5 voted", the $20 chip and "Pinned"). Both hold only while the
 * geometry below holds, so it is pinned here: the stage keeps the phone's own
 * ratio, every marker sits outside its target's text box, every phone number
 * clears the characters around it at the narrowest phone, and notes on one
 * side neither collide nor cross.
 */
const fs = require('fs');
const path = require('path');
const React = require('react');
const { render } = require('@testing-library/react');
const { layoutNotes, cropNotes, phoneHeight, phoneLeft, P, H } = require('../website/AnnotatedShot');
const { ANNOTATIONS } = require('../website/landingAnnotations');

jest.mock('../website/LiveDemo', () => ({ __esModule: true, default: () => null }));

const CSS = fs.readFileSync(path.join(__dirname, '..', 'website', 'LandingPage.css'), 'utf8');

const overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const entries = Object.entries(ANNOTATIONS);

// Width and height of a WebP file, from its header (lossy, lossless or
// extended), so the cut files can be checked against the crop they claim.
function webpSize(file) {
  const b = fs.readFileSync(file);
  expect(b.toString('ascii', 0, 4)).toBe('RIFF');
  expect(b.toString('ascii', 8, 12)).toBe('WEBP');
  const kind = b.toString('ascii', 12, 16);
  if (kind === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
  }
  if (kind === 'VP8X') return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
  throw new Error(`unknown WebP chunk ${kind} in ${file}`);
}

test('the stage is the phone\'s own ratio, in the SVG and in the CSS, so leaders land at every width', () => {
  expect(H).toBeCloseTo((P * 844) / 390, 6);
  expect(CSS).toMatch(/aspect-ratio: var\(--anno-w\) \/ var\(--anno-h, 519\.38\);/);
  expect(CSS).toMatch(/width: calc\(240 \/ var\(--anno-w\) \* 100%\);/);
  // From 1100px the whole stage, phone included, is drawn 1.3 times larger.
  expect(CSS).toMatch(/@media \(min-width: 1100px\) \{\s*\.lp-anno \{ --anno-scale: 1\.3; \}/);
  expect(CSS).toMatch(/\.lp-plate\.lp-anno \{ width: min\(calc\(var\(--anno-w\) \* var\(--anno-scale\) \* 1px\), 100%\);/);
});

describe.each(entries)('%s', (id, a) => {
  const x0 = phoneLeft(a.layout);
  // A capture cut down to its sheet is a shorter phone; every box, label and
  // number is checked in the cut's own percent (cropNotes).
  const crop = a.shot.crop || 0;
  const h = phoneHeight(crop);
  const toBox = ([x1, y1, x2, y2]) => [x0 + (x1 / 100) * P, (y1 / 100) * h, x0 + (x2 / 100) * P, (y2 / 100) * h];
  const rows = layoutNotes(a.layout, cropNotes(a.notes, crop), h);

  test('two to four notes, each naming a measured box on the screen', () => {
    expect(a.notes.length).toBeGreaterThanOrEqual(2);
    expect(a.notes.length).toBeLessThanOrEqual(4);
    for (const n of a.notes) {
      const [x1, y1, x2, y2] = n.box;
      expect(x1).toBeGreaterThanOrEqual(0);
      expect(x2).toBeLessThanOrEqual(100);
      expect(x1).toBeLessThan(x2);
      expect(y1).toBeLessThan(y2);
      expect(['text', 'box']).toContain(n.kind);
      if (n.side === 'left') expect(a.layout).not.toBe('right');
      if (n.side === 'right') expect(a.layout).not.toBe('left');
    }
  });

  test('every marker sits outside what it names, inside the phone', () => {
    for (const r of rows) {
      const target = toBox(r.box);
      if (r.kind === 'text') {
        const dot = [r.end.x - r.end.r, r.end.y - r.end.r, r.end.x + r.end.r, r.end.y + r.end.r];
        expect(`${id} "${r.text}" dot overlaps its text: ${overlap(dot, target)}`).toBe(`${id} "${r.text}" dot overlaps its text: false`);
        // At least a design unit of air between the dot and the text.
        const gap = r.side === 'left' ? target[0] - dot[2] : dot[0] - target[2];
        expect(gap).toBeGreaterThanOrEqual(1);
        expect(dot[0]).toBeGreaterThanOrEqual(x0);
        expect(dot[2]).toBeLessThanOrEqual(x0 + P);
      } else {
        // An outline around the whole element, clear of it on every side,
        // and the leader stops at the outline.
        const o = [r.outline.x, r.outline.y, r.outline.x + r.outline.w, r.outline.y + r.outline.h];
        expect(target[0] - o[0]).toBeGreaterThanOrEqual(1);
        expect(target[1] - o[1]).toBeGreaterThanOrEqual(1);
        expect(o[2] - target[2]).toBeGreaterThanOrEqual(1);
        expect(o[3] - target[3]).toBeGreaterThanOrEqual(1);
        expect(o[0]).toBeGreaterThanOrEqual(x0);
        expect(o[2]).toBeLessThanOrEqual(x0 + P);
        expect(r.ex).toBeCloseTo(r.side === 'left' ? o[0] : o[2], 6);
        // A box marker still names the characters inside it, which the
        // phone's number must clear.
        expect(Array.isArray(r.avoid) && r.avoid.length > 0).toBe(true);
      }
    }
  });

  test('on the narrowest phone, every number sits beside its element and clears its characters', () => {
    // An 18px number on a 224px phone (70vw at a 320px screen), in percent of
    // the capture.
    const hw = (9 / 224) * 100;
    const hh = (9 / (((224 * 844) / 390) * (100 - crop) / 100)) * 100;
    for (const r of rows) {
      const [x, y] = r.dot;
      const dot = [x - hw, y - hh, x + hw, y + hh];
      expect(dot[0]).toBeGreaterThanOrEqual(0);
      expect(dot[2]).toBeLessThanOrEqual(100);
      for (const box of r.avoid || [r.box]) {
        expect(`${id} number ${r.n} over ${JSON.stringify(box)}: ${overlap(dot, box)}`).toBe(`${id} number ${r.n} over ${JSON.stringify(box)}: false`);
      }
    }
  });

  test('notes on one side sit at least 10% apart, and their bends never cross', () => {
    for (const side of ['left', 'right']) {
      const mine = rows.filter((r) => r.side === side).sort((p, q) => p.top - q.top);
      for (let i = 1; i < mine.length; i++) expect(mine[i].top - mine[i - 1].top).toBeGreaterThanOrEqual(10);
      for (const r of mine) {
        expect(r.top).toBeGreaterThanOrEqual(4);
        expect(r.top).toBeLessThanOrEqual(96);
      }
      const spans = mine.map((r) => [Math.min(r.ly, r.ty), Math.max(r.ly, r.ty)]).sort((p, q) => p[0] - q[0]);
      for (let i = 1; i < spans.length; i++) expect(spans[i][0]).toBeGreaterThanOrEqual(spans[i - 1][1]);
    }
  });
});

test('a capture cut down to its sheet names nothing above the cut, and its files are that cut', () => {
  // The budget and the bill were full phones of the app's blurred chat with
  // the sheet in their lower half (2026-11-06). Their files are cut where
  // the crop says, and every note lands below the cut.
  const cut = entries.filter(([, a]) => a.shot.crop);
  expect(cut.map(([id]) => id)).toEqual(['budget', 'bill']);
  for (const [id, a] of cut) {
    const { crop } = a.shot;
    expect(crop).toBeGreaterThan(0);
    expect(crop).toBeLessThan(60);
    for (const n of a.notes) {
      expect(`${id} "${n.text}" box top ${n.box[1]}`).toBe(`${id} "${n.text}" box top ${Math.max(n.box[1], crop + 2)}`);
      expect(n.dot[1]).toBeGreaterThan(crop + 2);
      if (n.y !== undefined) expect(n.y).toBeGreaterThan(crop + 2);
    }
    const files = [a.shot.src, ...a.shot.srcSet.split(',').map((c) => c.trim().split(' ')[0])];
    for (const url of new Set(files)) {
      expect(url).toMatch(/-sheet(@2x|-480w)\.webp$/);
      const [w, hgt] = webpSize(path.join(__dirname, '..', '..', 'public', url));
      // The cut keeps the whole width and (100 - crop)% of the 390:844 height.
      expect(hgt / w).toBeCloseTo(((844 / 390) * (100 - crop)) / 100, 2);
    }
  }
  // A cut capture is drawn as the sheet on a dark plate, with no phone frame
  // left to run up into nothing above it: no border or padding on the plate,
  // the sheet's own rounded top corners, and the stage's room for the plate's
  // strip above it and none below.
  expect(CSS).toMatch(/\.lp-anno\.is-cropped \.lp-anno-device \{[^}]*padding: 0;[^}]*border: 0;[^}]*background: var\(--phone-glass\);/);
  expect(CSS).toMatch(/\.lp-anno\.is-cropped \.lp-anno-phone \.lp-shot \{ border-radius: 5\.1cqw 5\.1cqw 7cqw 7cqw; \}/);
  expect(CSS).toMatch(/\.lp-anno\.is-cropped \.lp-anno-stage \{ margin: calc\(16\.8 \/ var\(--anno-w\) \* 100%\) 0 0; \}/);
});

test('the page draws all five, one marker per note, and on a phone the numbers match the list', () => {
  // eslint-disable-next-line global-require
  const Page = require('../website/LandingPage').default;
  const { container, unmount } = render(React.createElement(Page));
  const figs = Array.from(container.querySelectorAll('figure.lp-anno'));
  expect(figs.map((f) => f.querySelector('img.lp-shot').getAttribute('src'))).toEqual(entries.map(([, a]) => a.shot.src));
  figs.forEach((fig, i) => {
    const { notes } = entries[i][1];
    const svg = fig.querySelector('svg.lp-anno-lines');
    expect(svg.querySelectorAll('circle.lp-anno-end').length + svg.querySelectorAll('g.lp-anno-mark').length).toBe(notes.length);
    const { crop } = entries[i][1].shot;
    expect(fig.classList.contains('is-cropped')).toBe(Boolean(crop));
    expect(fig.querySelector('.lp-reel-status') === null).toBe(Boolean(crop));
    expect(fig.querySelector('img.lp-shot').getAttribute('height')).toBe(String(Math.round((844 * (100 - (crop || 0))) / 100)));
    const dots = Array.from(fig.querySelectorAll('.lp-anno-dot')).map((d) => d.textContent);
    const nums = Array.from(fig.querySelectorAll('li.lp-anno-note .lp-anno-num')).map((d) => d.textContent);
    expect(dots).toEqual(nums);
    expect(nums).toEqual(notes.map((_, k) => String(k + 1)));
  });
  unmount();
  // Leaders only from 768px; numbers only under it.
  expect(CSS).toMatch(/\.lp-anno-lines \{ display: none; \}/);
  expect(CSS).toMatch(/@media \(min-width: 768px\) \{[\s\S]*?\.lp-anno-dot,\s*\.lp-anno-num \{ display: none; \}/);
});

test('the leaders are still: nothing on them animates', () => {
  const block = CSS.slice(CSS.indexOf('/* ============ annotated captures'), CSS.indexOf('/* A beat on a navy band'));
  expect(block.length).toBeGreaterThan(500);
  expect(block).not.toMatch(/animation|transition|@keyframes/);
});
