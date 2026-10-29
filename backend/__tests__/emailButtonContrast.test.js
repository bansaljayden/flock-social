// Run: node --test __tests__/emailButtonContrast.test.js  (from backend/)
//
// THE BUTTONS IN OUR EMAILS CAN BE READ (2026-10-29).
//
// The emergency email's "View Location on Map" was white bold text on #ef4444
// (3.76:1) and the shared-location email's on #0ea5e9 (2.77:1). WCAG AA asks
// 4.5:1 of text that size: bold text is "large" only from 18.66px, and these
// set no size, so a mail client draws them at its body size. Someone reading
// an emergency email on a phone in the sun is who this is for. Every inline
// style in the backend that sets both a background and a text colour has to
// clear 4.5:1.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function luminance(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const NAMED = { white: '#ffffff', black: '#000000' };

test('every inline style with its own background and text colour clears 4.5:1', () => {
  const root = path.join(__dirname, '..');
  const files = ['routes', 'services', 'templates']
    .flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.js')).map((f) => path.join(d, f)));
  const bad = [];
  let checked = 0;
  for (const rel of files) {
    fs.readFileSync(path.join(root, rel), 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/style=\\?["']([^"'\\]*)/g)) {
        const bg = /background(?:-color)?:\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\b/.exec(m[1]);
        const fg = /(?:^|;)\s*color:\s*(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}|white|black)\b/.exec(m[1]);
        if (!bg || !fg) continue;
        checked += 1;
        const r = ratio(bg[1], NAMED[fg[1].toLowerCase()] || fg[1]);
        if (r < 4.5) bad.push(`${rel}:${i + 1} ${fg[1]} on ${bg[1]} is ${r.toFixed(2)}:1`);
      }
    });
  }
  assert.ok(checked >= 2, `found ${checked} styles to check; the scan is not reading the emails`);
  assert.deepStrictEqual(bad, []);
});
