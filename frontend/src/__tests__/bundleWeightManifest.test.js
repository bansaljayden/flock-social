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
