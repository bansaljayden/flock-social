/**
 * mark-crowd.webp density and weight.
 *
 * WHY THIS FILE EXISTS
 *
 * The empty-state crowd mark is drawn by EmptyMark into a box 329px wide at
 * most (160px tall, aspect 1024x498). The 2x WebP behind it shipped at 2048px
 * and 391,212 bytes, roughly six times the pixels the box can ever paint, and
 * every byte of it landed inside the Capacitor download on every boot. It was
 * re-encoded to 1024px at the file's own original quality, which is all a 2x
 * DPR display of a 329px box needs, and dropped to about 122 KB with the image
 * visually identical.
 *
 * The regression is invisible: a 2048px file dropped back in its place would
 * look and behave exactly the same on screen and nothing about the build size
 * report would name it. Hence a test rather than a note. The picture element's
 * pairing is pinned here too, because "serve a smaller 2x" is only correct if
 * the <picture> still offers both densities for the browser to choose between.
 *
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..');
const MARKS = path.join(FRONTEND, 'public', 'marks');
const APP = fs.readFileSync(path.join(FRONTEND, 'src', 'App.js'), 'utf8');

/**
 * Canvas dimensions of a WebP file, read from the container header, so the test
 * carries no native image dependency of its own. Handles the three container
 * shapes: VP8X (extended, which is what a lossy WebP with an alpha channel
 * uses, and what all four marks are), VP8 (simple lossy) and VP8L (lossless).
 */
function webpDimensions(buf) {
  if (buf.length < 30) throw new Error('file too short to be a WebP');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('not a RIFF/WEBP file');
  }
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8X') {
    const width = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
    const height = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
    return { width, height };
  }
  if (fourcc === 'VP8 ') {
    const width = ((buf[27] << 8) | buf[26]) & 0x3fff;
    const height = ((buf[29] << 8) | buf[28]) & 0x3fff;
    return { width, height };
  }
  if (fourcc === 'VP8L') {
    const bits = buf[21] | (buf[22] << 8) | (buf[23] << 16) | (buf[24] << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  throw new Error('unknown WebP container: ' + fourcc);
}

describe('the header parser reads a known WebP', () => {
  // Without this, a parser that returned a fixed small number would make every
  // width assertion below pass on any file, including a 2048px one.
  test('reads the shipped 1x mark as 1024x498', () => {
    const buf = fs.readFileSync(path.join(MARKS, 'mark-crowd-400.webp'));
    expect(webpDimensions(buf)).toEqual({ width: 1024, height: 498 });
  });
});

describe('mark-crowd.webp is sized for the box it paints, not six times it', () => {
  const webpPath = path.join(MARKS, 'mark-crowd.webp');

  test('the 2x WebP is no wider than 1024px', () => {
    // 2x of a 329px box is 658px; 1024 covers it with room for a 3x display.
    // 2048px is the weight this row removed and the shape it must not return to.
    const buf = fs.readFileSync(webpPath);
    expect(webpDimensions(buf).width).toBeLessThanOrEqual(1024);
  });

  test('it is a real image, not a truncated stub, and well under the old weight', () => {
    // A floor as well as a ceiling: an empty or truncated file is a broken mark
    // that would still satisfy a width cap, and reads as success without this.
    const bytes = fs.statSync(webpPath).size;
    expect(bytes).toBeGreaterThan(50 * 1024);
    expect(bytes).toBeLessThan(200 * 1024);
  });

  test('all four files the <picture> can choose still exist', () => {
    // <picture> falls back to the <img> when the browser cannot decode the
    // source TYPE, never when the chosen URL 404s, so a missing file is a
    // broken mark and not a silent downgrade. Four files per stem.
    for (const file of ['mark-crowd-400.webp', 'mark-crowd.webp', 'mark-crowd-400.png', 'mark-crowd.png']) {
      expect(fs.existsSync(path.join(MARKS, file))).toBe(true);
    }
  });
});

describe('the EmptyMark <picture> still serves both densities', () => {
  // The re-encode is only correct if the element still offers the 1x and the 2x
  // for the browser to pick. These are the exact template srcSets EmptyMark
  // builds; they appear nowhere else in the file, comments included.
  test('the WebP source pairs the -400 as 1x with the full file as 2x', () => {
    expect(APP).toContain('srcSet={`/marks/mark-${name}-400.webp 1x, /marks/mark-${name}.webp 2x`}');
  });

  test('the PNG fallback keeps the same 1x and 2x pairing', () => {
    expect(APP).toContain('srcSet={`/marks/mark-${name}-400.png 1x, /marks/mark-${name}.png 2x`}');
  });

  test('the crowd empty state is one of the marks this covers', () => {
    expect(APP).toContain('<EmptyMark name="crowd" />');
  });
});
