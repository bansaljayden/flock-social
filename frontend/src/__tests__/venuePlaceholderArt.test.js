/**
 * THE VENUE PHOTO PLACEHOLDER IS THE PAINTED WREN, SMALL, AND THE ONLY ONE.
 *
 * When a venue photo fails to load, every card, chat card and the website's
 * live demo swap in lib/venuePhoto.js's VENUE_PHOTO_PLACEHOLDER. Since
 * 2026-11-07 that is a painted fairywren over a mid steel-blue wash (generated
 * art, never a Places photo), so it sits on the cream and navy themes alike.
 * This holds the file to its format and its byte budget, and holds the call
 * sites to the constant, so a hardcoded path cannot drift back to the old
 * photoreal sparrow.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test venuePlaceholderArt --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const { VENUE_PHOTO_PLACEHOLDER } = require('../lib/venuePhoto');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const SRC = path.join(__dirname, '..');

/** Width and height of a lossy (VP8) WebP, from its frame header. */
function webpSize(buf) {
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buf.toString('ascii', 8, 12)).toBe('WEBP');
  expect(buf.toString('ascii', 12, 16)).toBe('VP8 ');
  return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
}

test('the placeholder is a WebP at 800 x 600 (a full-width card at 2x) under 16 KB', () => {
  expect(VENUE_PHOTO_PLACEHOLDER).toBe('/marks/venue-placeholder.webp');
  const buf = fs.readFileSync(path.join(PUBLIC, VENUE_PHOTO_PLACEHOLDER));
  expect(webpSize(buf)).toEqual({ width: 800, height: 600 });
  expect(buf.length).toBeLessThanOrEqual(16 * 1024);
});

test('the old .jpg name serves the same picture, under 32 KB, for anything that still asks for it', () => {
  const buf = fs.readFileSync(path.join(PUBLIC, 'marks', 'venue-placeholder.jpg'));
  expect(buf[0]).toBe(0xff);
  expect(buf[1]).toBe(0xd8);
  expect(buf.length).toBeLessThanOrEqual(32 * 1024);
});

test('every fallback in the app names the constant, never a path of its own', () => {
  const hits = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name === '__tests__' || name === 'node_modules') continue;
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.(js|jsx|mjs)$/.test(name) && /venue-placeholder\.(jpg|webp)'/.test(fs.readFileSync(full, 'utf8'))) {
        hits.push(path.relative(SRC, full).split(path.sep).join('/'));
      }
    }
  };
  walk(SRC);
  expect(hits).toEqual(['lib/venuePhoto.js']);
});
