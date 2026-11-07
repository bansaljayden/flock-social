/**
 * THE HONORS ROSETTE: TWO SMALL FILES, DRAWN AT ITS PAINTED SIZE, NEVER READ ALOUD.
 *
 * /about's Honors list has a painted rosette beside it (generated art,
 * 2026-11-07: a navy ribbon with the fairywren in its medallion, no words in
 * it). This holds the two files to WebP at 66 x 96 and 132 x 192 (1x and 2x of
 * the painted size) and to a byte budget, and holds the <img> to being
 * decorative, since the list beside it already says what the honor is.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test honorsRosetteArt --watchAll=false
 */

const fs = require('fs');
const path = require('path');

const ART = path.join(__dirname, '..', '..', 'public', 'art');
const ABOUT = fs.readFileSync(path.join(__dirname, '..', 'website', 'AboutPage.js'), 'utf8');

/** Width and height of a WebP, lossy (VP8) or lossless/alpha (VP8L, VP8X). */
function webpSize(buf) {
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buf.toString('ascii', 8, 12)).toBe('WEBP');
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (kind === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
  }
  return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
}

test.each([
  ['honors-rosette-96.webp', 66, 96, 6],
  ['honors-rosette-192.webp', 132, 192, 14],
])('%s is %i x %i and under %i KB', (file, width, height, kb) => {
  const buf = fs.readFileSync(path.join(ART, file));
  expect(webpSize(buf)).toEqual({ width, height });
  expect(buf.length).toBeLessThanOrEqual(kb * 1024);
});

test('the page draws it at the painted size with the 2x file, and hides it from screen readers', () => {
  const at = ABOUT.indexOf('className="ab-honors-badge"');
  expect(at).toBeGreaterThan(-1);
  const tag = ABOUT.slice(at, ABOUT.indexOf('/>', at));
  expect(tag).toContain('srcSet="/art/honors-rosette-96.webp 1x, /art/honors-rosette-192.webp 2x"');
  expect(tag).toContain('width={66}');
  expect(tag).toContain('height={96}');
  expect(tag).toContain('alt=""');
  expect(tag).toContain('aria-hidden="true"');
});
