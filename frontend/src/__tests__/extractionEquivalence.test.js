/**
 * NINE SCREENS LEFT App.js. THIS PINS WHAT THEY CAN STILL SEE.
 *
 * On 2026-08-26 the venue owner dashboard, Add Friends and the flock chat
 * screen moved out of `App.js` into `src/screens/`; on 2026-08-27 the
 * one-to-one DM thread, the profile and settings screen, the admin costs and
 * revenue console and the venue signup onboarding followed them; the flock
 * plan detail screen and the create screen followed on 2026-09-01. Each was an
 * arrow function declared inside
 * `FlockAppInner` that CLOSED OVER that component's state and was called or
 * mounted rather than mounted at module scope. Each is now a separate component
 * that receives an explicit props object built in `renderScreen`.
 *
 * Every one of those moves was proved byte identical against the deleted lines,
 * and that proof is real but it is not the interesting one. A byte identical
 * body proves the code did not change. It does not prove the code still sees
 * the same things, and there are four ways it can quietly stop:
 *
 *   1. A STALE PROP. A closure reads a live binding. A prop is a value copied
 *      into an object literal at one instant. If any of those names were a
 *      `let` that a later line of the same render reassigns, the screen would
 *      read the old value where it used to read the current one. Nothing about
 *      a byte identical body would show it, and no existing suite looks.
 *
 *   2. A NAME THAT RESOLVES SOMEWHERE ELSE. The props list was derived by
 *      scope analysis. If the analysis missed a name, the screen file does not
 *      necessarily fail to build, because the browser hands out globals called
 *      `name`, `status`, `length`, `origin`, `event`, `top`, `closed` and two
 *      dozen more. A missed prop with one of those names compiles clean, is
 *      never undefined, and is always wrong. The allowlist below deliberately
 *      does NOT contain them, so a free identifier of that shape fails here.
 *
 *   3. A REMOUNT. These used to be CALLED. They are MOUNTED now, and a
 *      component whose identity is rebuilt every render is a new component
 *      TYPE to React, which unmounts and remounts the whole subtree on every
 *      unrelated state change. That is the exact defect the admin costs and
 *      revenue console carried until it moved out on 2026-08-27; the comment
 *      beside `numVenues` in App.js still records what it looked like. The
 *      moved screens must be bound at module scope, where the identity is
 *      fixed, and must not be declared inside `FlockAppInner`.
 *
 *   4. A CHUNK THAT CANNOT BE RETRIED. The dashboard is fetched now.
 *      `React.lazy` stores a rejection permanently, so without a re-arm the
 *      crash screen's "Try again" is a button that can never work. See
 *      `rearmLazyScreens` in App.js.
 *
 * WHAT THIS FILE IS NOT. It does not render anything. It is scope analysis on
 * source, which is the only level at which "does this name still mean what it
 * meant" is answerable at all, and it says so at each assertion.
 *
 * A COVERAGE NOTE, because it belongs next to these files rather than in a
 * commit message. Nine suites were repointed at the new screen files. Three of
 * the sweeps were repointed only partially, and `screens/AddFriends.js` is
 * currently in NONE of them: `accessibilitySweep` and `birdBrandMoments` read
 * App.js plus ChatDetail plus VenueDashboard, and `iconAndAlertSweep` and
 * `appIconFloorAndAlerts` read App.js plus ChatDetail only. Widening all four
 * to the full set was measured on 2026-08-26 and every assertion still passes,
 * so nothing is broken today, but 474 lines of a screen a brand new account
 * opens first are no longer swept. The bird floor is restated at the bottom of
 * this file because that one is cheap to carry. The rest wants those suites
 * repointed.
 *
 * ON THE PARSER. `@babel/parser` and `@babel/traverse` are not direct
 * dependencies of frontend/. They arrive with react-scripts, which is, and
 * which cannot run without them. They are required here WITHOUT a fallback on
 * purpose: if a future install ever moves them, this suite goes red and
 * somebody looks, which is the opposite of the failure a source scanning test
 * should have.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test extractionEquivalence --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const PARSE_OPTIONS = {
  sourceType: 'module',
  plugins: [
    'jsx',
    'classProperties',
    'optionalChaining',
    'nullishCoalescingOperator',
    'objectRestSpread',
    'dynamicImport',
  ],
};
const parse = (code) => parser.parse(code, PARSE_OPTIONS);

/* The nine screens, the props object each one is handed, and the component
   name it exports. Adding another screen means adding a row here. */
const SCREENS = [
  { component: 'ChatDetail', file: 'ChatDetail.js', props: 'chatDetailProps' },
  { component: 'AddFriends', file: 'AddFriends.js', props: 'addFriendsProps' },
  { component: 'VenueDashboard', file: 'VenueDashboard.js', props: 'venueDashboardProps' },
  { component: 'DmDetail', file: 'DmDetail.js', props: 'dmDetailProps' },
  { component: 'ProfileSettings', file: 'ProfileSettings.js', props: 'profileSettingsProps' },
  { component: 'RevenueScreen', file: 'RevenueScreen.js', props: 'revenueScreenProps' },
  { component: 'VenueOnboarding', file: 'VenueOnboarding.js', props: 'venueOnboardingProps' },
  { component: 'FlockDetail', file: 'FlockDetail.js', props: 'flockDetailProps' },
  { component: 'CreateScreen', file: 'CreateScreen.js', props: 'createScreenProps' },
];

const APP_SOURCE = read('App.js');
const APP_AST = parse(APP_SOURCE);

/* ── App.js: the props objects and FlockAppInner's scope ──────────────────── */

/**
 * Every `const <name>Props = { ... }` in renderScreen, as a list of
 * { key, shorthand, valueName } plus the scope those names resolve in.
 */
function readAppShape() {
  const objects = {};
  let innerPath = null;
  traverse(APP_AST, {
    VariableDeclarator(p) {
      const id = p.node.id;
      if (id.type !== 'Identifier') return;
      if (id.name === 'FlockAppInner') innerPath = p.get('init');
      if (!SCREENS.some((s) => s.props === id.name)) return;
      objects[id.name] = p.node.init.properties.map((prop) => ({
        key: prop.type === 'ObjectProperty' && prop.key.type === 'Identifier' ? prop.key.name : null,
        shorthand: prop.type === 'ObjectProperty' && prop.shorthand === true,
        valueName: prop.type === 'ObjectProperty' && prop.value.type === 'Identifier'
          ? prop.value.name
          : null,
        line: prop.loc.start.line,
      }));
    },
  });
  return { objects, innerPath };
}

const { objects: PROPS_OBJECTS, innerPath: FLOCK_APP_INNER } = readAppShape();

/** The destructured parameter names of a screen's default export. */
function screenParameters(ast) {
  let out = null;
  traverse(ast, {
    ExportDefaultDeclaration(p) {
      const fn = p.node.declaration;
      const first = fn.params[0];
      out = first.properties.map((prop) => ({
        name: prop.type === 'ObjectProperty' ? prop.key.name : `...${prop.argument.name}`,
        hasDefault: prop.type === 'ObjectProperty' && prop.value.type === 'AssignmentPattern',
      }));
    },
  });
  return out;
}

/** Every identifier a file references and never declares, imports or receives. */
function freeIdentifiers(ast) {
  let out = [];
  traverse(ast, {
    Program(p) {
      out = Object.keys(p.scope.globals).sort();
    },
  });
  return out;
}

const SCREEN_SOURCES = Object.fromEntries(
  SCREENS.map((s) => [s.component, read('screens', s.file)])
);
const SCREEN_ASTS = Object.fromEntries(
  SCREENS.map((s) => [s.component, parse(SCREEN_SOURCES[s.component])])
);

/* ── 1. the props object and the parameter list are the same set ─────────── */

describe('what App.js hands over is exactly what the screen takes', () => {
  SCREENS.forEach(({ component, props }) => {
    it(`${component} declares every name ${props} passes, and no others`, () => {
      const passed = PROPS_OBJECTS[props];
      expect(passed).toBeDefined();
      const params = screenParameters(SCREEN_ASTS[component]);
      const passedNames = passed.map((p) => p.key).sort();
      const paramNames = params.map((p) => p.name).sort();
      // Both directions. A parameter with nothing behind it is silently
      // undefined at runtime; a prop with no parameter is a name that was kept
      // in one file after the other stopped reading it.
      expect(paramNames).toEqual(passedNames);
    });

    it(`no ${component} parameter carries a default value`, () => {
      // A default turns "this prop went missing" into "this prop has a
      // plausible looking wrong value", which is the one outcome worse than a
      // crash. The closure this replaced had no such thing.
      const withDefault = screenParameters(SCREEN_ASTS[component])
        .filter((p) => p.hasDefault)
        .map((p) => p.name);
      expect(withDefault).toEqual([]);
    });
  });
});

/* ── 2. no prop can be stale ─────────────────────────────────────────────── */

describe('no prop is a copy of something that moves', () => {
  SCREENS.forEach(({ props }) => {
    it(`every property of ${props} is object shorthand`, () => {
      // Shorthand is what makes the name here and the parameter over there
      // impossible to drift apart, and it is also what rules out the shapes
      // that CAN go stale: `foo: someRef.current` freezes a ref read at build
      // time, `foo: bar.baz` freezes a lookup. A plain name does not freeze
      // anything a const cannot already be trusted to hold still.
      const notShorthand = PROPS_OBJECTS[props]
        .filter((p) => !p.shorthand)
        .map((p) => `${p.key} (line ${p.line})`);
      expect(notShorthand).toEqual([]);
    });

    it(`every name in ${props} binds to something that is never reassigned`, () => {
      // THE STALE PROP CHECK, and the reason this file exists. renderScreen
      // builds these objects part way through a render. A closure would have
      // read the binding later, live; the object reads it once, now. The two
      // are the same answer for a const and can differ for anything else, so
      // anything else is refused: not a `let`, not a `var`, and not a const
      // that some other line assigns to.
      const bad = [];
      for (const prop of PROPS_OBJECTS[props]) {
        const name = prop.valueName || prop.key;
        const binding = FLOCK_APP_INNER.scope.getBinding(name);
        if (!binding) {
          bad.push(`${name}: no binding found in App.js`);
          continue;
        }
        // `param` is FlockAppInner's own two arguments, authUser and onLogout.
        // `module` is an import. `hoisted` is a module-scope function
        // declaration: ProfileSettings is handed sessionEndCopy, which is
        // `function sessionEndCopy(reason)` at the bottom of App.js, and a
        // function declaration is as immutable as a const for the purpose this
        // check protects. It CAN be reassigned, unlike a const, so the safety
        // is not the kind alone: the constantViolations check just below is
        // what actually forbids a reassigned one, and it runs for every kind.
        if (!['const', 'module', 'param', 'hoisted'].includes(binding.kind)) {
          bad.push(`${name}: declared as ${binding.kind}`);
        }
        if (binding.constantViolations.length > 0) {
          const lines = binding.constantViolations.map((v) => v.node.loc.start.line);
          bad.push(`${name}: reassigned at line(s) ${lines.join(', ')}`);
        }
      }
      expect(bad).toEqual([]);
    });
  });
});

/* ── 3. nothing resolves to a browser global by accident ─────────────────── */

/**
 * The platform names the screens are allowed to reach for. Everything a screen
 * needs from App.js arrives as a prop or an import, so this list is short on
 * purpose and, more to the point, it OMITS the writable globals that share a
 * name with an ordinary local: name, status, length, top, self, parent,
 * origin, event, closed, close, open, focus, blur, history, screen, scroll,
 * print, stop, find, frames, external. Those are exactly the names a missed
 * prop would land on without ever being undefined.
 */
const PLATFORM_GLOBALS = new Set([
  'Array', 'Blob', 'Boolean', 'Date', 'Error', 'File', 'FileReader', 'Infinity',
  'Intl', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'RegExp',
  'Set', 'String', 'Symbol', 'URL', 'URLSearchParams', 'WeakMap', 'WeakSet',
  'cancelAnimationFrame', 'clearInterval', 'clearTimeout', 'console',
  'decodeURIComponent', 'document', 'encodeURIComponent', 'fetch', 'isFinite',
  'isNaN', 'localStorage', 'navigator', 'parseFloat', 'parseInt',
  'requestAnimationFrame', 'sessionStorage', 'setInterval', 'setTimeout',
  'undefined', 'window',
]);

describe('every name a screen reads has somewhere to come from', () => {
  SCREENS.forEach(({ component }) => {
    it(`${component} reaches for no global outside the platform list`, () => {
      const stray = freeIdentifiers(SCREEN_ASTS[component])
        .filter((name) => !PLATFORM_GLOBALS.has(name));
      // A name here is either a prop the extraction missed, or a module level
      // helper in App.js that never travelled. Either way it is NOT undefined
      // at runtime if the browser happens to define it, which is why the build
      // stays green and this does not.
      expect(stray).toEqual([]);
    });

    it(`${component} reaches no name through a string`, () => {
      // Scope analysis is blind to eval, to Function(), and to a lookup built
      // from a string, so a screen that used any of them could be reading
      // something the props object never enumerated.
      const src = SCREEN_SOURCES[component];
      expect(src).not.toMatch(/\beval\s*\(/);
      expect(src).not.toMatch(/new\s+Function\s*\(/);
      expect(src).not.toMatch(/\b(?:window|globalThis|self)\s*\[/);
    });
  });
});

/* ── 4. mounting them cannot remount them ────────────────────────────────── */

describe('the moved screens are stable component types', () => {
  /** The names App.js binds at module scope. */
  const moduleBindings = (() => {
    let out = null;
    traverse(APP_AST, { Program(p) { out = p.scope.bindings; } });
    return out;
  })();

  SCREENS.forEach(({ component }) => {
    it(`${component} is bound at App.js module scope, not inside FlockAppInner`, () => {
      // The defect this rules out is written up in App.js beside numVenues:
      // the admin costs and revenue console was declared inside FlockAppInner
      // and mounted as an element, so every render made a new function, React
      // read a new component type, and the whole subtree unmounted and
      // remounted. Any state or focus inside it was lost to a toast arriving.
      // That console is one of the SCREENS below now; a module binding has one
      // identity for the life of the page and cannot do that.
      expect(Object.keys(moduleBindings)).toContain(component);
      const insideInner = FLOCK_APP_INNER.scope.bindings[component];
      expect(insideInner).toBeUndefined();
    });
  });

  it('renderScreen mounts each of them as an element with a spread props object', () => {
    // Pins the shape the rest of this file reasons about. If one of them goes
    // back to being called, the props object stops being the interface and
    // every assertion above is describing something that is no longer there.
    SCREENS.forEach(({ component, props }) => {
      expect(APP_SOURCE).toContain(`<${component} {...${props}} />`);
    });
  });
});

/* ── 5. a chunk that failed can be asked for again ───────────────────────── */

describe('the lazily fetched screen can be retried', () => {
  /** Module level bindings whose initialiser is React.lazy(...). */
  const lazyNames = (() => {
    const out = [];
    traverse(APP_AST, {
      Program(p) {
        for (const [name, binding] of Object.entries(p.scope.bindings)) {
          const init = binding.path.node.init;
          if (!init || init.type !== 'CallExpression') continue;
          const callee = init.callee;
          const isLazy = (callee.type === 'MemberExpression'
            && callee.object.name === 'React' && callee.property.name === 'lazy')
            || (callee.type === 'Identifier' && callee.name === 'lazy');
          if (isLazy) out.push({ name, binding });
        }
      },
    });
    return out;
  })();

  it('there is at least one, so this describe block is not scanning nothing', () => {
    expect(lazyNames.map((l) => l.name)).toContain('VenueDashboard');
  });

  lazyNames.forEach(({ name, binding }) => {
    it(`${name} is re-armed somewhere rather than held for the life of the page`, () => {
      // React.lazy remembers a rejection as hard as it remembers a module:
      // once an import throws, the payload's status is 2 and every later
      // render re-throws the stored error without asking the network again.
      // For a chunk that failed to download that is permanent, and the crash
      // screen's "Try again" would be a button that can never work. A lazy
      // that is reassigned at least once is a lazy something can rebuild.
      expect(binding.constantViolations.length).toBeGreaterThan(0);
    });
  });

  it('both ways out of the screen crash fallback re-arm', () => {
    // Try again calls it directly. Go to Nest gets it through
    // leaveCrashedScreen, because a remembered rejection outlives the screen:
    // leaving without re-arming means the next visit throws before it asks for
    // anything. leaveCrashedScreen's own handler text is pinned by
    // screenBoundaryCoverage, so the re-arm goes inside it rather than beside
    // it.
    expect(APP_SOURCE).toContain('onClick={() => { rearmLazyScreens(); reset(); }}');
    const exit = APP_SOURCE.slice(
      APP_SOURCE.indexOf('const leaveCrashedScreen = () => {'),
      APP_SOURCE.indexOf('const screenCrashFallback = ')
    );
    expect(exit).toContain('rearmLazyScreens();');
  });
});

/* ── 6. the bird floor, which no sweep covers for these files any more ───── */

describe('birds in the moved screens keep the size floor', () => {
  // birdBrandMoments owns this rule and reads App.js, ChatDetail and
  // VenueDashboard. AddFriends is in no sweep at all, and it draws four birds.
  // Restated here over all three files so the floor survives the split.
  SCREENS.forEach(({ component }) => {
    it(`${component} renders no still bird below 40px`, () => {
      const src = SCREEN_SOURCES[component];
      const tags = [
        ...(src.match(/<BirdieStill\b[^>]*>/g) || []),
        ...(src.match(/<BirdNote\b[\s\S]*?\/>/g) || []),
      ];
      const tooSmall = tags
        .map((tag) => tag.match(/size=\{(\d+)\}/))
        .filter((m) => m && Number(m[1]) < 40)
        .map((m) => m[0]);
      // No size prop defaults to 96 on BirdieStill and 64 on BirdNote, and
      // both clear the floor, so an absent size is not a finding.
      expect(tooSmall).toEqual([]);
    });
  });
});
