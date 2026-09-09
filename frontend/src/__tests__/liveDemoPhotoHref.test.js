/**
 * The website's venue photos load through the proxy path the server hands
 * out, which is already percent-encoded (`ref=places%2F...`). Running that
 * through encodeURI encoded the `%` a second time (`%252F`), the proxy decoded
 * it once, saw `places%2F...` and answered 400 "Photo ref is not a valid photo
 * name" for every venue: every pin showed its initial, every card the
 * placeholder bird, and the site looked as if Places had stopped working.
 *
 * photoHrefFor escapes only what can break a CSS url("...") or an img src
 * (quotes, backslash, whitespace, angle brackets, control characters) and
 * leaves the rest of the URL exactly as the server wrote it.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../services/api', () => ({ BASE_URL: 'https://api.example.test' }), { virtual: false });

const SRC = fs.readFileSync(path.join(__dirname, '..', 'website', 'LiveDemo.js'), 'utf8');

describe('photoHrefFor', () => {
  let photoHrefFor;
  beforeAll(() => {
    // eslint-disable-next-line global-require
    ({ photoHrefFor } = require('../website/LiveDemo'));
  });

  test('keeps the server\'s percent-encoding intact', () => {
    const p = '/api/venues/photo?ref=places%2FChIJabc%2Fphotos%2FAVoNoXT3x0&maxwidth=160';
    expect(photoHrefFor(p)).toBe('https://api.example.test' + p);
  });

  test('encodes the characters that could leave a CSS url("...") or an img src', () => {
    const out = photoHrefFor('/api/venues/photo?ref=a"b\\c d<e>');
    expect(out).not.toMatch(/["\\\s<>]/);
    expect(out).toContain('%22');
    expect(out).toContain('%5C');
  });
});

describe('LiveDemo.js', () => {
  test('never runs a photo URL through encodeURI again', () => {
    expect(SRC).not.toMatch(/encodeURI\(`\$\{BASE_URL\}/);
    // Both photo sites, the pin and the card, go through the helper.
    expect((SRC.match(/photoHrefFor\((venue\.photo_url|selectedPhoto)\)/g) || []).length).toBe(2);
  });
});
