/**
 * The website's display face is Fraunces, from the app's own file.
 *
 * The marketing pages were set in Literata Display from 2026-10-21 to
 * 2026-11-06 and are back on Fraunces. These checks hold the pieces that have
 * to agree for that to be one face and one download:
 *
 * 1. src/index.css declares Fraunces from src/fonts/Fraunces-var.woff2, and the
 *    landing page preloads that same file, so the preload is a hit for the
 *    @font-face and not a second font.
 * 2. The Pages build's preload pattern matches the name webpack gives it.
 * 3. The website's stylesheets put Fraunces first, then the metric-matched
 *    fallback, with the same metrics in every copy, and declare no face file
 *    of their own.
 * 4. The h1, on the home page and on /tap, is the display cut, opsz 144, the
 *    cut the fallback comes closest to.
 *
 * This is a FRONTEND test (jest via react-scripts).
 */

const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(FRONTEND, rel), 'utf8');
const build = require('../../scripts/build-cloudflare');

const WEBSITE = path.join(FRONTEND, 'src', 'website');
const websiteCss = fs.readdirSync(WEBSITE).filter((f) => f.endsWith('.css'));

const fallbackOf = (css) => {
  const m = /@font-face\s*\{[^}]*font-family:\s*'Fraunces Fallback';([^}]*)\}/.exec(css);
  return m && m[1].replace(/\s+/g, ' ').trim();
};

// A font file in a url(): quoted either way or bare, with or without a query
// or a fragment after the name.
const FACE_FILE = /url\(\s*['"]?[^'")]*\.(?:woff2?|ttf|otf)(?:[?#][^'")]*)?['"]?\s*\)/i;

describe('the website sets its display type in Fraunces', () => {
  test('the app declares Fraunces from Fraunces-var.woff2, and the landing page preloads that file', () => {
    expect(read('src/index.css')).toMatch(/font-family: 'Fraunces';\s*src: url\('\.\/fonts\/Fraunces-var\.woff2'\) format\('woff2'\);/);
    expect(read('src/website/LandingPage.js')).toContain("import displayFontUrl from '../fonts/Fraunces-var.woff2';");
  });

  test('the Pages build preloads the name webpack emits for it', () => {
    expect(build.DISPLAY_FONT.test('/static/media/Fraunces-var.252d721d4b7469f6889f.woff2')).toBe(true);
    expect(build.DISPLAY_FONT.test('/static/media/HankenGrotesk-var.442fd9727f3ba8156605.woff2')).toBe(false);
  });

  test('the landing page and /tap put Fraunces first, then the matched fallback', () => {
    const chain = "'Fraunces', 'Fraunces Fallback', 'Iowan Old Style', Georgia, 'Times New Roman', serif";
    expect(read('src/website/LandingPage.css')).toContain(`--font-display: ${chain};`);
    expect(read('src/website/TapPage.css')).toContain(`--font-display: ${chain};`);
  });

  test('the fallback carries the same metrics in both copies', () => {
    const landing = fallbackOf(read('src/website/LandingPage.css'));
    expect(landing).toContain('size-adjust: 97.77%;');
    expect(landing).toContain('ascent-override: 100.24%;');
    expect(landing).toContain('descent-override: 26.59%;');
    expect(fallbackOf(read('src/website/TapPage.css'))).toBe(landing);
  });

  test('the face-file pattern sees a url() however it is written', () => {
    // The first version wanted ".woff2)" straight after the name, so it never
    // matched the quoted url('...') every @font-face here is written with.
    for (const css of [
      "src: url('../fonts/Literata-Display-600.woff2') format('woff2');",
      'src: url("../fonts/Literata-Display-600.woff2") format("woff2");',
      'src: url(../fonts/Literata-Display-600.woff2) format(woff2);',
      "src: url( '../fonts/Face.woff' );",
      "src: url('../fonts/Face.woff2?v=2#face') format('woff2');",
      "src: url('../fonts/Face.ttf') format('truetype'), url('../fonts/Face.otf');",
    ]) {
      expect(`${css} ${FACE_FILE.test(css)}`).toBe(`${css} true`);
    }
    for (const css of [
      "background: url('../art/bird.png') no-repeat;",
      "src: local('Times New Roman'), local('Liberation Serif'), local('DejaVu Serif');",
    ]) {
      expect(`${css} ${FACE_FILE.test(css)}`).toBe(`${css} false`);
    }
  });

  test('no website stylesheet declares a face file of its own', () => {
    for (const file of websiteCss) {
      const css = fs.readFileSync(path.join(WEBSITE, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(`${file}: ${FACE_FILE.test(css)}`).toBe(`${file}: false`);
      expect(`${file}: ${/Literata/.test(css)}`).toBe(`${file}: false`);
    }
  });

  test('both h1s are the display cut, the one the fallback comes closest to', () => {
    // The fallback sets an h1 within 3% of Fraunces at opsz 144. At opsz auto
    // the /tap headline set 17 to 19% wider than the fallback and went from
    // two lines to three when the face arrived.
    for (const [file, selector] of [['src/website/LandingPage.css', '.lp h1'], ['src/website/TapPage.css', '.tap h1']]) {
      const rule = new RegExp(`\\n${selector.replace('.', '\\.')} \\{([^}]*)\\}`).exec(read(file));
      expect(`${selector}: ${rule !== null}`).toBe(`${selector}: true`);
      expect(rule[1]).toContain("font-variation-settings: 'opsz' 144;");
    }
  });
});
