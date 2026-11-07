/**
 * The website's display face is Fraunces, from the app's own file.
 *
 * The marketing pages were set in Literata Display from 2026-10-21 to
 * 2026-11-06 and are back on Fraunces. These checks hold the pieces that have
 * to agree for that to be one face and one download, and for the pages to
 * hold still when it arrives:
 *
 * 1. src/index.css declares Fraunces from src/fonts/Fraunces-var.woff2, and the
 *    landing page preloads that same file, so the preload is a hit for the
 *    @font-face and not a second font.
 * 2. The Pages build's preload pattern matches the name webpack gives it.
 * 3. Each optical size the site sets waits in its own metric-matched local
 *    fallback (LandingPage.css's note has the measurements): the display cut
 *    (opsz 144, the h1s), the reading cut (opsz auto, the h2s, with a narrow
 *    face under 480px), the paper title's 36 and the labels' 9 (one face per
 *    weight). Each chain puts Fraunces first and its face second, each face's
 *    overrides are Fraunces' own 0.98 / 0.26 em over its size-adjust, /tap's
 *    copy of the display cut's face is the landing page's, and no website
 *    stylesheet declares a face file of its own.
 * 4. Every rule that fixes an optical size names the chain solved for it. One
 *    face for all of them, matched to opsz 100 by canvas, set the h1s 1.4 to
 *    3.0% wider than Fraunces and the h2s and labels 14 to 21% narrower, and
 *    /research's first screen jumped when the face arrived (layout shift 0.17
 *    at 340 to 350px wide, 0.07 to 0.08 at 430 to 470). The browser check is
 *    tools/e2e/website-face-swap.spec.js.
 * 5. The h1, on the home page and on /tap, is the display cut, opsz 144.
 * 6. The home hero's h1 runs its own ramp, 32px at 320, so its two lines are
 *    two lines in both faces there.
 *
 * This is a FRONTEND test (jest via react-scripts).
 */

const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(FRONTEND, rel), 'utf8').replace(/\r\n/g, '\n');
const build = require('../../scripts/build-cloudflare');

const WEBSITE = path.join(FRONTEND, 'src', 'website');
const websiteCss = fs.readdirSync(WEBSITE).filter((f) => f.endsWith('.css'));
const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Every @font-face body for one family, comments out, whitespace folded.
const facesOf = (css, family) => {
  const out = [];
  const re = /@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(noComments(css)))) {
    if (new RegExp(`font-family:\\s*'${family}';`).test(m[1])) out.push(m[1].replace(/\s+/g, ' ').trim());
  }
  return out;
};
const descriptor = (body, name) => {
  const m = new RegExp(`(?:^|;\\s*)${name}:\\s*([^;]+);`).exec(body);
  return m ? m[1].trim() : null;
};

// A font file in a url(): quoted either way or bare, with or without a query
// or a fragment after the name.
const FACE_FILE = /url\(\s*['"]?[^'")]*\.(?:woff2?|ttf|otf)(?:[?#][^'")]*)?['"]?\s*\)/i;

const LOCAL_SRC = "local('Times New Roman'), local('Liberation Serif'), local('DejaVu Serif'), local('Tinos')";
const TAIL = "'Iowan Old Style', Georgia, 'Times New Roman', serif";
// The faces, the size-adjust each was solved at, and the weights each covers
// (LandingPage.css, the note at the top).
const FACES = [
  ['Fraunces Fallback 144', '95.05%', '100 900'],
  ['Fraunces Fallback', '115.6%', '100 900'],
  ['Fraunces Fallback Narrow', '119.5%', '100 900'],
  ['Fraunces Fallback 36', '114.65%', '100 900'],
  ['Fraunces Fallback 9', '115%', '100 500'],
  ['Fraunces Fallback 9', '118.3%', '501 900'],
];

describe('the website sets its display type in Fraunces', () => {
  test('the app declares Fraunces from Fraunces-var.woff2, and the landing page preloads that file', () => {
    expect(read('src/index.css')).toMatch(/font-family: 'Fraunces';\s*src: url\('\.\/fonts\/Fraunces-var\.woff2'\) format\('woff2'\);/);
    expect(read('src/website/LandingPage.js')).toContain("import displayFontUrl from '../fonts/Fraunces-var.woff2';");
  });

  test('the Pages build preloads the name webpack emits for it', () => {
    expect(build.DISPLAY_FONT.test('/static/media/Fraunces-var.252d721d4b7469f6889f.woff2')).toBe(true);
    expect(build.DISPLAY_FONT.test('/static/media/HankenGrotesk-var.442fd9727f3ba8156605.woff2')).toBe(false);
  });

  test('each cut puts Fraunces first, then the fallback matched to it', () => {
    const landing = read('src/website/LandingPage.css');
    for (const [variable, family] of [
      ['--font-display', 'Fraunces Fallback'],
      ['--font-display-144', 'Fraunces Fallback 144'],
      ['--font-display-36', 'Fraunces Fallback 36'],
      ['--font-display-9', 'Fraunces Fallback 9'],
    ]) {
      expect(landing).toContain(`  ${variable}: 'Fraunces', '${family}', ${TAIL};\n`);
    }
    // The reading cut on a phone, where its h2s are 27 to 31px.
    expect(landing).toMatch(new RegExp(`@media \\(max-width: 479\\.98px\\) \\{\\n  \\.lp \\{ --font-display: 'Fraunces', 'Fraunces Fallback Narrow', ${TAIL.replace(/[()]/g, '\\$&')}; \\}\\n\\}`));
    expect(read('src/website/TapPage.css')).toContain(`  --font-display-144: 'Fraunces', 'Fraunces Fallback 144', ${TAIL};\n`);
  });

  test('each fallback is Times scaled to its cut, its overrides Fraunces\' own 0.98 / 0.26 em over that scale', () => {
    const landing = read('src/website/LandingPage.css');
    for (const [family, sizeAdjust, weight] of FACES) {
      const body = facesOf(landing, family).find((b) => descriptor(b, 'font-weight') === weight);
      expect(`${family} ${weight}: ${body !== undefined}`).toBe(`${family} ${weight}: true`);
      expect(descriptor(body, 'src')).toBe(LOCAL_SRC);
      expect(descriptor(body, 'size-adjust')).toBe(sizeAdjust);
      const s = parseFloat(sizeAdjust) / 100;
      const pct = (em) => `${Math.round((em / s) * 10000) / 100}%`;
      expect(`${family}: ${descriptor(body, 'ascent-override')}`).toBe(`${family}: ${pct(0.98)}`);
      expect(`${family}: ${descriptor(body, 'descent-override')}`).toBe(`${family}: ${pct(0.26)}`);
      expect(descriptor(body, 'line-gap-override')).toBe('0%');
    }
    // One face per family, but the text cut's two weights.
    expect(facesOf(landing, 'Fraunces Fallback 9')).toHaveLength(2);
    for (const family of ['Fraunces Fallback', 'Fraunces Fallback 144', 'Fraunces Fallback Narrow', 'Fraunces Fallback 36']) {
      expect(`${family}: ${facesOf(landing, family).length}`).toBe(`${family}: 1`);
    }
  });

  test('/tap carries the display cut\'s face as the landing page has it, and no other', () => {
    // The two stylesheets can be in one document after a client-side visit,
    // and the later of two faces with one name wins, so they must not differ.
    const landing = facesOf(read('src/website/LandingPage.css'), 'Fraunces Fallback 144');
    expect(landing).toHaveLength(1);
    expect(facesOf(read('src/website/TapPage.css'), 'Fraunces Fallback 144')).toEqual(landing);
    expect(noComments(read('src/website/TapPage.css')).match(/@font-face/g)).toHaveLength(1);
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
      const css = noComments(fs.readFileSync(path.join(WEBSITE, file), 'utf8'));
      expect(`${file}: ${FACE_FILE.test(css)}`).toBe(`${file}: false`);
      expect(`${file}: ${/Literata/.test(css)}`).toBe(`${file}: false`);
    }
  });

  test('every rule that fixes an optical size waits in the fallback solved for that size', () => {
    // A label at opsz 9 left in the reading cut's chain waits in a face set
    // for 30px headlines, and gains a line when Fraunces lands.
    const seen = [];
    for (const file of websiteCss) {
      const css = noComments(read(`src/website/${file}`));
      const re = /([^{}]+)\{([^{}]*font-variation-settings:\s*'opsz'\s*(\d+)[^{}]*)\}/g;
      let m;
      while ((m = re.exec(css))) {
        const [, selector, body, opsz] = m;
        const family = /font-family:\s*([^;]+);/.exec(body);
        const where = `${file} ${selector.trim()} (opsz ${opsz})`;
        expect(`${where}: ${family && family[1].trim()}`).toBe(`${where}: var(--font-display-${opsz})`);
        seen.push(`${selector.trim()} ${opsz}`);
      }
    }
    // The rules this is about, so a regex that stopped matching cannot pass.
    for (const rule of ['.lp h1 144', '.tap h1 144', '.lp-kicker 9', '.lp-beat-when 9', '.ab-role 9', '.ab-when 9', '.ab-coming 9', '.rs-paper-kicker 9', '.rs-paper-title 36', '.rs-row-label small 9', '.rs-note 9']) {
      expect(seen).toContain(rule);
    }
  });

  test('both h1s are the display cut, in the display cut\'s chain', () => {
    // At opsz auto the /tap headline set 17 to 19% wider than the fallback of
    // the time and went from two lines to three when the face arrived.
    for (const [file, selector] of [['src/website/LandingPage.css', '.lp h1'], ['src/website/TapPage.css', '.tap h1']]) {
      const rule = new RegExp(`\\n${selector.replace('.', '\\.')} \\{([^}]*)\\}`).exec(read(file));
      expect(`${selector}: ${rule !== null}`).toBe(`${selector}: true`);
      expect(rule[1]).toContain("font-variation-settings: 'opsz' 144;");
      expect(rule[1]).toContain('font-family: var(--font-display-144);');
    }
  });

  test('the home hero h1 runs its own ramp, 32px at 320 to 72px from 1280, so it holds two lines at 320 in both faces', () => {
    // On the shared ramp (34px at 320) "Nurturing friendship," is 283px in
    // Fraunces against the 280px a 320px screen leaves it, so the headline
    // took three lines once the face arrived where the fallback held two, and
    // everything under it dropped 35px.
    const css = read('src/website/LandingPage.css');
    const hero = /\n\.lp-hero-copy h1 \{([^}]*)\}/.exec(css);
    expect(hero).not.toBeNull();
    const m = /font-size: clamp\((\d+)px, ([\d.]+)rem \+ ([\d.]+)vw, (\d+)px\);/.exec(hero[1]);
    expect(m).not.toBeNull();
    const [lo, rem, vw, hi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    expect([lo, hi]).toEqual([32, 72]);
    // The middle term meets the floor at 320 and the ceiling at 1280, so the
    // ramp has no step at either end.
    const mid = (w) => rem * 16 + (vw * w) / 100;
    expect(mid(320)).toBeCloseTo(32, 1);
    expect(mid(1280)).toBeCloseTo(72, 1);
    // Scoped to the hero: the shared rule keeps its own ramp for every other
    // page's h1, and the hero's rule comes after it at the same specificity,
    // so it is the one that holds on the home page.
    const shared = /\n\.lp h1 \{([^}]*)\}/.exec(css);
    expect(shared[1]).toContain('font-size: clamp(34px, 1.33rem + 3.96vw, 72px);');
    expect(css.indexOf('\n.lp-hero-copy h1 {')).toBeGreaterThan(css.indexOf('\n.lp h1 {'));
    expect(css.match(/\n\s*\.lp-hero-copy >? ?h1 \{[^}]*font-size/g)).toHaveLength(1);
  });
});
