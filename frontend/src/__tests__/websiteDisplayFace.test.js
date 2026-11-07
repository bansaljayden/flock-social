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
 * 4. The h1 is the display cut, opsz 144, the cut the fallback is matched to.
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

  test('no website stylesheet declares a face file of its own', () => {
    for (const file of websiteCss) {
      const css = fs.readFileSync(path.join(WEBSITE, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(`${file}: ${/url\([^)]*\.woff2?\)/.test(css)}`).toBe(`${file}: false`);
      expect(`${file}: ${/Literata/.test(css)}`).toBe(`${file}: false`);
    }
  });

  test('the h1 is the display cut, the one the fallback is matched to', () => {
    const rule = /\n\.lp h1 \{([^}]*)\}/.exec(read('src/website/LandingPage.css'));
    expect(rule).not.toBeNull();
    expect(rule[1]).toContain("font-variation-settings: 'opsz' 144;");
  });
});
