/**
 * THE SCREENSHOT RIG'S OWN SIZE: --viewport and --scale (2026-11-05).
 *
 * scripts/capture-screenshots.mjs shot three fixed sizes (390x844 at 2 for
 * the site, 440x956 and 428x926 at 3 for the App Store). --viewport=430x932
 * --scale=3 shoots every screen asked for at one size of its own instead,
 * 1290x2796 here, an App Store 6.9-inch size, as opaque PNGs, to --out only.
 * The rig runs a whole local stack, so this lifts customSize out of its
 * source (as screenshotRigNotes.test.js does with writeManifest) and checks
 * the parsing, then the source for where the size is honoured.
 * FRONTEND test (jest via react-scripts).
 */
const fs = require('fs');
const path = require('path');

const RIG = fs.readFileSync(path.resolve(__dirname, '..', '..', 'scripts', 'capture-screenshots.mjs'), 'utf8').replace(/\r\n/g, '\n');

function lift(name) {
  const start = RIG.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no ${name} in the rig`);
  const src = RIG.slice(start, RIG.indexOf('\n}\n', start) + 2);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn ${name};`)();
}
const customSize = lift('customSize');

test('--viewport=430x932 --scale=3 is 1290x2796, written to its own output', () => {
  const s = customSize('430x932', '3');
  expect(s).toEqual({ id: 'custom-430x932@3', viewport: { width: 430, height: 932 }, dsf: 3, out: 'custom', custom: true });
  expect([s.viewport.width * s.dsf, s.viewport.height * s.dsf]).toEqual([1290, 2796]);
  expect(customSize('440x956', '3').id).toBe('custom-440x956@3');
});

test('neither option means the fixed sets, as before', () => {
  expect(customSize(null, null)).toBeNull();
  expect(customSize(undefined, undefined)).toBeNull();
});

test('one without the other, a malformed size, a desktop width, landscape or an odd scale is refused', () => {
  expect(() => customSize('430x932', null)).toThrow(/go together/);
  expect(() => customSize(null, '3')).toThrow(/go together/);
  expect(() => customSize('430*932', '3')).toThrow(/WIDTHxHEIGHT/);
  expect(() => customSize('430x', '3')).toThrow(/WIDTHxHEIGHT/);
  expect(() => customSize('600x1000', '2')).toThrow(/outside 320 to 500/);
  expect(() => customSize('300x700', '2')).toThrow(/outside 320 to 500/);
  expect(() => customSize('480x400', '2')).toThrow(/landscape/);
  expect(() => customSize('430x932', '5')).toThrow(/--scale takes 1, 2, 3 or 4/);
  expect(() => customSize('430x932', '2.5')).toThrow(/--scale takes/);
});

test('the rig honours the size everywhere a set used to decide: screens, owner screens, output', () => {
  // Every screen asked for, the narrow-only and owner screens included.
  expect(RIG).toContain('const wantsSize = (screen, size) => (size.custom ? true :');
  expect(RIG).toContain("if (ownerScreens.length > 0 && (size.id === 'web' || size.custom)) {");
  expect(RIG).toContain('const sizes = CUSTOM_SIZE ? [CUSTOM_SIZE] : SIZES.filter(');
  // Only ever to --out.
  expect(RIG).toContain("if (CUSTOM_SIZE && !OUT_OVERRIDE) die('a --viewport run writes only to --out=<folder>');");
  // Opaque PNG named by screen, mode and pixel size, into OUT_DIR.
  const start = RIG.indexOf("if (size.out === 'custom') {");
  const branch = RIG.slice(start, RIG.indexOf("} else if (size.out === 'web') {", start));
  expect(start).toBeGreaterThan(0);
  expect(branch).toContain(".flatten({ background: '#ffffff' }).removeAlpha()");
  expect(branch).toContain("withIccProfile('srgb')");
  expect(branch).toContain('-${mode}-${px.w}x${px.h}.png');
  expect(branch).toContain('path.join(OUT_DIR, file)');
  expect(branch).not.toContain('APPSTORE_DIR');
});
