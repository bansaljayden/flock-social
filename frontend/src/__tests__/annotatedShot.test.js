/*
 * The annotated captures on the home page (website/AnnotatedShot.js).
 *
 * A note's leader has to end on the thing it names at every width. That holds
 * only while the stage keeps the phone's own ratio and every leader is drawn
 * in the stage's units, so both are pinned here, together with the rules a
 * reader would notice breaking: every end point on the screen, notes on one
 * side far enough apart not to collide, and the narrow layout's numbers
 * matching its list.
 */
const fs = require('fs');
const path = require('path');
const React = require('react');
const { render } = require('@testing-library/react');

jest.mock('../website/LiveDemo', () => ({ __esModule: true, default: () => null }));

const CSS = fs.readFileSync(path.join(__dirname, '..', 'website', 'LandingPage.css'), 'utf8');
const PHONE_W = 240;
const PHONE_H = (PHONE_W * 844) / 390;

function figures() {
  // eslint-disable-next-line global-require
  const Page = require('../website/LandingPage').default;
  const { container, unmount } = render(React.createElement(Page));
  const out = Array.from(container.querySelectorAll('figure.lp-anno')).map((fig) => {
    const svg = fig.querySelector('svg.lp-anno-lines');
    const [, , W, H] = svg.getAttribute('viewBox').split(' ').map(Number);
    const rect = svg.querySelector('clipPath rect');
    const x0 = Number(rect.getAttribute('x'));
    const ends = Array.from(svg.querySelectorAll('circle.lp-anno-ring')).map((c) => [Number(c.getAttribute('cx')), Number(c.getAttribute('cy'))]);
    const notes = Array.from(fig.querySelectorAll('li.lp-anno-note')).map((li) => ({
      side: li.classList.contains('is-left') ? 'left' : 'right',
      top: parseFloat(li.style.top),
      num: li.querySelector('.lp-anno-num').textContent,
      text: li.textContent,
    }));
    const dots = Array.from(fig.querySelectorAll('.lp-anno-dot')).map((d) => d.textContent);
    const img = fig.querySelector('img.lp-shot');
    return { W, H, x0, w: Number(rect.getAttribute('width')), ends, notes, dots, src: img.getAttribute('src'), fig };
  });
  unmount();
  return out;
}

test('five captures are annotated: the vote, the budget, the bill, the SOS sheet and the dashboard', () => {
  const srcs = figures().map((f) => f.src);
  expect(srcs).toEqual([
    '/screenshots/chat-dark@2x.webp',
    '/screenshots/budget-dark@2x.webp',
    '/screenshots/bill-split-dark@2x.webp',
    '/screenshots/sos-dark@2x.webp',
    '/screenshots/owner-dashboard-dark@2x.webp',
  ]);
});

test('the stage is the phone\'s own ratio, in the SVG and in the CSS, so leaders land at every width', () => {
  for (const f of figures()) {
    expect(f.H).toBeCloseTo(PHONE_H, 2);
    expect(f.w).toBe(PHONE_W);
  }
  expect(CSS).toMatch(/aspect-ratio: var\(--anno-w\) \/ 519\.38;/);
  expect(CSS).toMatch(/width: calc\(240 \/ var\(--anno-w\) \* 100%\);/);
});

test('every leader ends on the screen, and notes on one side do not collide', () => {
  for (const f of figures()) {
    expect(f.ends).toHaveLength(f.notes.length);
    expect(f.notes.length).toBeGreaterThanOrEqual(2);
    expect(f.notes.length).toBeLessThanOrEqual(4);
    for (const [x, y] of f.ends) {
      expect(x).toBeGreaterThan(f.x0);
      expect(x).toBeLessThan(f.x0 + PHONE_W);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(PHONE_H);
    }
    for (const side of ['left', 'right']) {
      const tops = f.notes.filter((n) => n.side === side).map((n) => n.top).sort((a, b) => a - b);
      for (let i = 1; i < tops.length; i++) expect(tops[i] - tops[i - 1]).toBeGreaterThanOrEqual(10);
      for (const t of tops) {
        expect(t).toBeGreaterThanOrEqual(4);
        expect(t).toBeLessThanOrEqual(96);
      }
    }
  }
});

test('on a phone the dots and the list carry the same numbers, in order', () => {
  for (const f of figures()) {
    const nums = f.notes.map((n) => n.num);
    expect(f.dots).toEqual(nums);
    expect(nums).toEqual(nums.map((_, i) => String(i + 1)));
  }
  // The leaders are hidden under 768px and the numbers above it.
  expect(CSS).toMatch(/\.lp-anno-lines \{ display: none; \}/);
  expect(CSS).toMatch(/@media \(min-width: 768px\) \{[\s\S]*?\.lp-anno-dot,\s*\.lp-anno-num \{ display: none; \}/);
});

test('the leaders are still: nothing on them animates', () => {
  const block = CSS.slice(CSS.indexOf('/* ============ annotated captures'), CSS.indexOf('/* A beat on a navy band'));
  expect(block.length).toBeGreaterThan(500);
  expect(block).not.toMatch(/animation|transition|@keyframes/);
});
