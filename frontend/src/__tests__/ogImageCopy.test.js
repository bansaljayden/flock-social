/**
 * The social card's headline is BAKED PIXELS, so nothing at runtime can catch
 * it going stale. This is the thing that does.
 *
 * On 2026-09-05 the hero headline changed and og-image.png did not, because
 * the card had been made by hand once in August and no script recorded how.
 * For the length of that gap every link preview showed a retired sentence
 * while og:image:alt in three separate files announced the new one, which is
 * the worse half of the bug: a screen reader reads alt text aloud as though it
 * were the image, so the card was actively lying to the people who most depend
 * on it being true.
 *
 * scripts/make-og-image.mjs regenerates the PNG. This asserts the copy it
 * would bake still equals the copy everything else claims. When it fails, the
 * fix is to run the script and commit the PNG, NOT to edit the expectation.
 *
 * Every file is read with CRLF normalised: the pre-commit hook stashes and
 * restores, which leaves CRLF working copies on Windows, and a source-reading
 * pin that forgets this fails for reasons that have nothing to do with copy.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const FRONTEND = path.join(SRC, '..');

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const generator = read(path.join(FRONTEND, 'scripts', 'make-og-image.mjs'));
const landing = read(path.join(SRC, 'website', 'LandingPage.js'));
const indexHtml = read(path.join(FRONTEND, 'public', 'index.html'));
const marketingPage = read(path.join(FRONTEND, 'api', 'marketing-page.js'));
const invitePreview = read(path.join(FRONTEND, 'api', 'invite-preview.js'));

/** The line the generator draws. */
function bakedHeadline() {
  const m = generator.match(/const HEADLINE = '([^']+)';/);
  expect(m).not.toBeNull();
  return m[1];
}

/** The hero <h1>, flattened to plain text the way a reader sees it. */
function heroHeadline() {
  const h1 = landing.match(/<h1 id="lp-h-hero">([\s\S]*?)<\/h1>/);
  expect(h1).not.toBeNull();
  return h1[1]
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the social card says what the page says', () => {
  test('the baked headline equals the landing hero headline', () => {
    expect(bakedHeadline()).toBe(heroHeadline());
  });

  test('every og:image:alt quotes that same headline', () => {
    const headline = bakedHeadline();
    // "Flock. " prefixes the alt text so a screen reader names the brand
    // before reading the line off the card.
    const expected = `Flock. ${headline}`;

    expect(indexHtml).toContain(`<meta property="og:image:alt" content="${expected}" />`);
    expect(indexHtml).toContain(`<meta name="twitter:image:alt" content="${expected}" />`);
    expect(marketingPage).toContain(`const OG_IMAGE_ALT = '${expected}';`);
    expect(invitePreview).toContain(`const OG_IMAGE_ALT = '${expected}';`);
  });

  test('the prerendered home document leads with the same headline', () => {
    const headline = bakedHeadline();
    expect(marketingPage).toContain(`["h1", "${headline}"]`);
  });

  test('the PNG exists, is a real 1200x630 PNG, and is under 300 KB', () => {
    const png = fs.readFileSync(path.join(FRONTEND, 'public', 'og-image.png'));

    // PNG signature, then IHDR width/height as big-endian uint32s.
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);

    // Facebook and Twitter both fetch this on every share. It was 84 KB by
    // hand and 92 KB generated; 300 KB is room to redesign, not a target.
    expect(png.length).toBeLessThan(300 * 1024);
  });

  test('the card is newer than the headline that is baked into it', () => {
    /* A stale PNG is exactly the bug this file exists for, and the copy checks
       above cannot see it: they compare source to source, and the image is
       neither. Compare mtimes instead. Regenerating is one command, and the
       generator names it in its own header. */
    const pngAt = fs.statSync(path.join(FRONTEND, 'public', 'og-image.png')).mtimeMs;
    const generatorAt = fs.statSync(path.join(FRONTEND, 'scripts', 'make-og-image.mjs')).mtimeMs;

    // One minute of slack: a fresh clone or a checkout can hand every file
    // effectively the same timestamp, and ordering within that is not a defect.
    expect(pngAt).toBeGreaterThan(generatorAt - 60 * 1000);
  });
});
