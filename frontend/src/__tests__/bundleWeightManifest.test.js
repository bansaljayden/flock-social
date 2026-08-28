/**
 * Every runtime dependency must be reachable from the code, and the shipped
 * component directory must contain only components something renders.
 *
 * WHY THIS FILE EXISTS
 *
 * On 2026-08-26 `frontend/package.json` declared `three`, `@react-three/fiber`,
 * `@react-three/drei`, `@react-three/postprocessing` and `gsap` as runtime
 * dependencies of an app whose job is voting on a bar. Not one of them was
 * imported by a single line in `src/`. `@googlemaps/markerclusterer` was there
 * too, for a Google Maps integration that was never wired up (the maps are
 * MapLibre, which `noUnusedGoogleApiKey.test.js` documents at length).
 * `@radix-ui/react-slot` and `class-variance-authority` existed only to serve
 * `components/ui/button.js`, which nothing imported either.
 *
 * They cost no bytes in the bundle, and that is exactly what made them survive:
 * webpack never sees a package nobody imports, so no size report ever named
 * them and no build ever got slower in a way anyone noticed. What they did cost
 * was about 91 MB of `node_modules`, paid on every `npm ci` in CI and on every
 * Codemagic build, plus eleven packages' worth of supply-chain surface carried
 * for nothing.
 *
 * The same audit found eleven files in `src/components/ui/` that nothing in the
 * repository imported: the aceternity/shadcn block (animated-tooltip, button,
 * card, flip-words, infinite-moving-cards, meteors, moving-border,
 * multi-step-loader, placeholders-and-vanish-input, text-generate-effect,
 * typewriter-effect). Every one of them was deleted. The proof was not a grep
 * for imports: it was that none of their exported symbol names appeared in ANY
 * chunk of a completed production build.
 *
 * That block had a reputation for being load-bearing, recorded in
 * `.claude/CLAUDE.md` as "Icons + the shadcn-derived block (load-bearing)".
 * The reputation was true once and had quietly stopped being true. Which is the
 * real lesson here and the reason this file is a test rather than a note: the
 * question "is anything still using this?" has a mechanical answer, and left to
 * memory it drifts toward "probably, better not touch it" and the dead weight
 * becomes permanent.
 *
 * WHAT IS ASSERTED
 *
 * 1. Every package in `dependencies` is imported somewhere under `src/`, except
 *    for an explicit allowlist of packages that are used WITHOUT an import
 *    (native Capacitor platforms, the build toolchain, a Tailwind plugin). A
 *    new unused runtime dependency fails here.
 * 2. The specific packages removed on 2026-08-26 do not come back.
 * 3. The four `@testing-library/*` packages stay in `devDependencies`. They
 *    were in `dependencies`, which is wrong: they are test-only, and a
 *    production install has no reason to fetch them.
 * 4. Every `.js` file in `src/components/ui/` is imported by something outside
 *    itself.
 *
 * HOW TO RUN
 *   cd frontend && npx react-scripts test --watchAll=false -t "bundle weight"
 *
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..');
const SRC = path.join(FRONTEND, 'src');

const pkg = JSON.parse(fs.readFileSync(path.join(FRONTEND, 'package.json'), 'utf8'));

const CODE_EXT = ['.js', '.jsx', '.ts', '.tsx'];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (CODE_EXT.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const ALL_SOURCE = walk(SRC);

/* Every module specifier this app names, from static imports, dynamic
   `import()` and `require()` alike. `import 'maplibre-gl/dist/maplibre-gl.css'`
   counts as using maplibre-gl, which is why the match is on the package prefix
   rather than an exact string. */
function specifiersIn(files) {
  const found = new Set();
  const pattern = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = pattern.exec(source)) !== null) found.add(m[1]);
  }
  return found;
}

const ALL_SPECIFIERS = specifiersIn(ALL_SOURCE);

const isImported = (pkgName, specifiers) =>
  [...specifiers].some((s) => s === pkgName || s.startsWith(pkgName + '/'));

/**
 * Runtime dependencies that no line of `src/` imports, and legitimately so.
 * Every entry needs a reason, because "it must be needed for something" is how
 * the six packages this file exists to catch stayed for months.
 */
const USED_WITHOUT_AN_IMPORT = {
  '@capacitor/core': 'The native bridge, and a required peer of every Capacitor plugin.',
  '@capacitor/ios': 'The native iOS platform. Consumed by the Xcode project, never by JS.',
  '@capacitor/cli': 'Build-time CLI (`npx cap sync`). Belongs in devDependencies; moving it is a native-build change, not a bundle one.',
  '@capacitor-firebase/app': 'Native peer of @capacitor-firebase/messaging. Registered in the iOS project.',
  'react-scripts': 'The build and test toolchain itself.',
  '@vercel/og': 'The per-flock share image renderer for frontend/api/invite-og.js, an edge function Vercel bundles from this same package.json. CRA never sees it, so it adds nothing to the app bundle.',
  'tailwindcss-animate': 'A plugin required by tailwind.config.js at build time, alongside tailwindcss, which is already a devDependency.',
};

/**
 * Removed on 2026-08-26 after a build proved each one absent from every chunk.
 * If you are re-adding one of these, you are adding a first import for it, and
 * you should delete its line here in the same change.
 */
const REMOVED_AS_UNUSED = [
  'three',
  '@react-three/fiber',
  '@react-three/drei',
  '@react-three/postprocessing',
  'gsap',
  '@googlemaps/markerclusterer',
  '@radix-ui/react-slot',
  'class-variance-authority',
];

const TEST_ONLY = [
  '@testing-library/dom',
  '@testing-library/jest-dom',
  '@testing-library/react',
  '@testing-library/user-event',
];

describe('bundle weight: every runtime dependency is reachable from the code', () => {
  const declared = Object.keys(pkg.dependencies || {});

  it('declares no dependency that nothing imports', () => {
    const orphans = declared.filter(
      (name) => !isImported(name, ALL_SPECIFIERS) && !(name in USED_WITHOUT_AN_IMPORT)
    );
    expect(orphans).toEqual([]);
  });

  it('keeps a written reason for each dependency used without an import', () => {
    for (const [name, reason] of Object.entries(USED_WITHOUT_AN_IMPORT)) {
      // A stale allowlist is worse than no allowlist: it excuses a package that
      // is no longer installed at all. Prune the entry when you drop the dep.
      expect(declared).toContain(name);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});

describe('bundle weight: the packages removed as unused stay removed', () => {
  const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

  for (const name of REMOVED_AS_UNUSED) {
    it(`does not re-declare ${name}`, () => {
      expect(Object.keys(all)).not.toContain(name);
    });
  }

  it('confirms none of them is imported either', () => {
    const resurrected = REMOVED_AS_UNUSED.filter((n) => isImported(n, ALL_SPECIFIERS));
    expect(resurrected).toEqual([]);
  });
});

describe('bundle weight: test-only packages are devDependencies', () => {
  for (const name of TEST_ONLY) {
    it(`declares ${name} as a devDependency and not a dependency`, () => {
      expect(Object.keys(pkg.devDependencies || {})).toContain(name);
      expect(Object.keys(pkg.dependencies || {})).not.toContain(name);
    });
  }
});

describe('bundle weight: components/ui holds only components something imports', () => {
  const UI_DIR = path.join(SRC, 'components', 'ui');
  const uiModules = fs
    .readdirSync(UI_DIR)
    .filter((n) => CODE_EXT.includes(path.extname(n)));

  // Specifiers from every source file EXCEPT the ui directory itself, so a set
  // of dead components that import only each other cannot vouch for itself.
  const outsideUi = ALL_SOURCE.filter((f) => path.dirname(f) !== UI_DIR);
  const outsideSpecifiers = specifiersIn(outsideUi);

  const importedBases = new Set(
    [...outsideSpecifiers].map((s) => path.basename(s).replace(/\.(js|jsx|ts|tsx)$/, ''))
  );

  it('has at least the two modules the app is known to render', () => {
    // Guards against the check above passing because the directory is empty.
    expect(uiModules).toEqual(expect.arrayContaining(['BirdieBird.js', 'Icons.js']));
  });

  for (const file of uiModules) {
    const base = file.replace(/\.(js|jsx|ts|tsx)$/, '');
    it(`${file} is imported from outside components/ui`, () => {
      expect(importedBases.has(base)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// html5-qrcode stays off the startup path
// ---------------------------------------------------------------------------
// It carries its own barcode decoding engine and was the largest single item on
// the boot path: measured, the chunk holding it was 169.6 KB gzipped and every
// user downloaded it on every launch for a screen almost nobody opens. Moving
// it to a dynamic import() inside startQrScanner took roughly 106 KB gzipped
// off startup with no change to behaviour.
//
// This regression is invisible. A static import would silently pull it back
// into the boot chunk and nothing about the app would look or behave
// differently, so nobody would notice until somebody measured again. Hence a
// test rather than a comment.
describe('the QR scanner library is loaded on demand', () => {
  const appSource = fs.readFileSync(path.join(SRC, 'App.js'), 'utf8');

  test('nothing in src/ statically imports html5-qrcode', () => {
    const offenders = [];
    // Test files are excluded because they are never bundled, so a static
    // import in one costs a user nothing. This file in particular quotes the
    // very import form it is searching for, in the comment below, and would
    // otherwise report itself.
    for (const file of ALL_SOURCE.filter((f) => !f.includes('__tests__'))) {
      const body = fs.readFileSync(file, 'utf8');
      // `import ... from 'html5-qrcode'`, bare `import 'html5-qrcode'` and
      // `require('html5-qrcode')`. Deliberately does NOT match `import(` with
      // a parenthesis, which is the dynamic form this test exists to keep.
      const staticImport = /(?:^|\n)\s*import\s+(?:[^;'"]*\s+from\s+)?['"]html5-qrcode['"]|require\(\s*['"]html5-qrcode['"]\s*\)/;
      if (staticImport.test(body)) offenders.push(path.relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });

  test('App.js loads it with a dynamic import instead', () => {
    expect(appSource).toMatch(/await\s+import\(\s*['"]html5-qrcode['"]\s*\)/);
  });

  test('a failed chunk load is reported as a scanner problem, not a camera one', () => {
    // Telling somebody to check camera permissions when the real failure was
    // the network sends them to the wrong settings screen entirely.
    expect(appSource).toMatch(/ChunkLoadError/);
    expect(appSource).toMatch(/Couldn't load the scanner/);
  });
});

// ---------------------------------------------------------------------------
// The map's STYLESHEET stays off the startup path too
// ---------------------------------------------------------------------------
// maplibre-gl's engine has been behind `import('maplibre-gl')` for a while.
// Its stylesheet was not: `import 'maplibre-gl/dist/maplibre-gl.css'` sat at
// the top of App.js and at the top of website/LiveDemo.js, which put it in
// each of those modules' chunk GROUPS. Measured on 2026-08-26 it was 69,505
// bytes raw and 10,078 gzipped, every selector in it a `.maplibregl-` one, and
// it was 68% of all the CSS the app downloaded to boot.
//
// A CSS chunk is not a free rider on a group. webpack's mini-css runtime adds
// the stylesheet's load event to the same `Promise.all` the JS chunks are in,
// so `import('./App')` did not resolve until a sheet for a widget that was not
// on screen had arrived. That is dead time in front of a blank app, on a phone,
// on venue wifi, which is the whole situation this product is used in.
//
// Same shape of regression as html5-qrcode above and just as invisible: a
// static import would put it back with nothing looking or behaving any
// differently. Hence a test.
describe('the map stylesheet is loaded on demand', () => {
  // Comments are stripped before the scan. This very file quotes the import
  // form in the paragraph above, and App.js and LiveDemo.js both explain in
  // prose why the import is not there; a scanner that cannot tell a comment
  // from a line of code reports all three and is useless.
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const CODE = ALL_SOURCE.filter((f) => !f.includes('__tests__')).map((f) => ({
    rel: path.relative(SRC, f),
    body: stripComments(fs.readFileSync(f, 'utf8')),
  }));

  test('the comment stripper leaves real code alone', () => {
    // Without this, a stripper that ate everything would make the scan below
    // pass on an empty string and report a clean bundle forever.
    const sample = stripComments("// import 'maplibre-gl/dist/maplibre-gl.css';\nimport x from 'y';\n");
    expect(sample).toContain("import x from 'y'");
    expect(sample).not.toContain('maplibre-gl.css');
  });

  test('nothing in src/ statically imports the maplibre stylesheet', () => {
    // `import '...css'` and `require('...css')`. Deliberately does NOT match
    // `import(` with a parenthesis, which is the dynamic form being kept.
    const staticImport = /(?:^|\n)\s*import\s+(?:[^;'"]*\s+from\s+)?['"]maplibre-gl\/dist\/maplibre-gl\.css['"]|require\(\s*['"]maplibre-gl\/dist\/maplibre-gl\.css['"]\s*\)/;
    const offenders = CODE.filter((f) => staticImport.test(f.body)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test('both map call sites load it with a dynamic import instead', () => {
    // An empty offender list is indistinguishable from a scanner that read
    // nothing, so name the two files that must carry the dynamic form.
    const dynamic = /import\(\s*['"]maplibre-gl\/dist\/maplibre-gl\.css['"]\s*\)/;
    const carriers = CODE.filter((f) => dynamic.test(f.body)).map((f) => f.rel).sort();
    expect(carriers).toEqual([path.normalize('App.js'), path.normalize('website/LiveDemo.js')]);
  });

  test('the sheet is awaited before a map is constructed', () => {
    // Loading it late is only correct if the map waits for it. Without the
    // await, maplibre paints its controls and attribution as bare DOM for
    // however long the chunk takes.
    for (const rel of ['App.js', path.join('website', 'LiveDemo.js')]) {
      const body = CODE.find((f) => f.rel === rel).body;
      expect(body).toMatch(/await\s+styleSheetReady/);
    }
  });
});
