/**
 * THREE SURFACES THAT REBUILT THEMSELVES WHILE PEOPLE WERE USING THEM.
 *
 * `EditProfileForm`, `NewDmModal` and `VerifyEmailSheet` were arrow functions
 * declared inside `FlockAppInner`'s render and mounted as elements. A function
 * expression declared in a render is a NEW function object on every render,
 * React compares component TYPES by identity, and a changed type is not
 * reconciled: the old subtree is unmounted and a fresh one is mounted in its
 * place. So an unrelated `setState` anywhere in the shell destroyed all three,
 * along with their state, their DOM and the caret sitting in it.
 *
 * What that was on a phone, in order of how bad it reads to the person holding
 * it:
 *
 *   1. Edit Profile erased itself about a second after you typed, in every
 *      field, because the shell re-rendered and the form was rebuilt from
 *      `profileName` and `profileBio` again. Tapping the photo button at the
 *      top of the same form did it too. Worst of all, SAVING did it: the save
 *      handler calls `setProfileName` and `setProfileBio`, which re-render the
 *      parent, which remounted the form and threw away the `editSuccess`
 *      message the handler had set one line earlier. A correct password
 *      produced a blanked password field and no confirmation of any kind.
 *
 *   2. The New Message sheet kept only the first word you typed and then
 *      moved focus to the Close button, where a space bar closed the sheet.
 *      Two helpers made that visible instantly, and neither was misbehaving.
 *      `SearchInputLocal` debounces its commit upward and clears the pending
 *      timer on unmount, so the search never left the browser and no result
 *      ever arrived. `DialogBehavior` moves focus to the first focusable child
 *      on mount, and the first focusable child of that sheet is Close.
 *
 *   3. The confirm-your-email sheet had the same focus problem for the same
 *      reason.
 *
 * The fix is the one three screens already used on 2026-08-26: bind the
 * component at module scope, where its identity is fixed for the life of the
 * page, and hand it everything it reads as an explicit prop.
 *
 * WHAT THIS FILE ADDS THAT `extractionEquivalence.test.js` DOES NOT. That suite
 * asks the same questions of `screens/`, and sections 1 to 3 below are its
 * checks applied to `components/`. Section 4 is new and is the general one: it
 * finds EVERY component still declared inside `FlockAppInner` and mounted as
 * an element, and holds each to the rule that it may not own anything a
 * remount would destroy. Seven of them are left and all seven are safe today.
 * An eighth that is not goes red here rather than in somebody's hands.
 *
 * ON THE PARSER. `@babel/parser` and `@babel/traverse` arrive with
 * react-scripts and are required without a fallback, which is the same
 * decision `extractionEquivalence.test.js` records: if an install ever moves
 * them this suite goes red and somebody looks, rather than quietly scanning
 * nothing. Comments are excluded by construction here, because a comment is
 * not any of the node types below.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test remountedSurfaces --watchAll=false
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

/* The three, the props object each is handed, and the file it moved to. */
const MOVED = [
  { component: 'EditProfileForm', file: 'EditProfileForm.js', props: 'editProfileFormProps' },
  { component: 'NewDmModal', file: 'NewDmModal.js', props: 'newDmModalProps' },
  { component: 'VerifyEmailSheet', file: 'VerifyEmailSheet.js', props: 'verifyEmailSheetProps' },
];

const APP_SOURCE = read('App.js');
const APP_AST = parse(APP_SOURCE);

const FILE_SOURCES = Object.fromEntries(
  MOVED.map((m) => [m.component, read('components', m.file)])
);
const FILE_ASTS = Object.fromEntries(
  MOVED.map((m) => [m.component, parse(FILE_SOURCES[m.component])])
);

/* ── App.js shape: the props objects, and FlockAppInner's scope ───────────── */

function readAppShape() {
  const objects = {};
  let innerPath = null;
  traverse(APP_AST, {
    VariableDeclarator(p) {
      const id = p.node.id;
      if (id.type !== 'Identifier') return;
      if (id.name === 'FlockAppInner') innerPath = p.get('init');
      if (!MOVED.some((m) => m.props === id.name)) return;
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

/** Module level bindings of App.js, by name. */
const APP_MODULE_BINDINGS = (() => {
  let out = null;
  traverse(APP_AST, { Program(p) { out = p.scope.bindings; } });
  return out;
})();

/**
 * The destructured parameter names of a component file's default export.
 * These files declare the component as a const and export the name, so the
 * export is followed back to its binding rather than read off the export node.
 */
function componentParameters(ast, name) {
  let out = null;
  traverse(ast, {
    Program(p) {
      const binding = p.scope.getBinding(name);
      if (!binding) return;
      const init = binding.path.node.init;
      if (!init || !init.params || init.params.length === 0) return;
      const first = init.params[0];
      if (first.type !== 'ObjectPattern') return;
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
  traverse(ast, { Program(p) { out = Object.keys(p.scope.globals).sort(); } });
  return out;
}

/* ── 0. the file did not scan nothing ────────────────────────────────────── */

describe('this suite is reading the code it claims to read', () => {
  it('found FlockAppInner and all three props objects', () => {
    // An anchor that misses returns undefined, and every loop below a missing
    // anchor iterates zero times and reports success. This is the assertion
    // that stops that.
    expect(FLOCK_APP_INNER).not.toBeNull();
    expect(Object.keys(PROPS_OBJECTS).sort()).toEqual(MOVED.map((m) => m.props).sort());
    MOVED.forEach(({ props }) => {
      expect(PROPS_OBJECTS[props].length).toBeGreaterThan(0);
    });
  });

  it('each moved file is a real file with a component in it', () => {
    MOVED.forEach(({ component }) => {
      expect(FILE_SOURCES[component].length).toBeGreaterThan(500);
      expect(componentParameters(FILE_ASTS[component], component)).not.toBeNull();
    });
  });
});

/* ── 1. bound at module scope, mounted with its props ────────────────────── */

describe('the three are stable component types now', () => {
  MOVED.forEach(({ component, props }) => {
    it(`${component} is imported at App.js module scope, not declared in the render`, () => {
      // THE FIX ITSELF. A module binding has one identity for the life of the
      // page. A binding inside FlockAppInner is rebuilt on every render, which
      // is what unmounted these three under people's hands.
      expect(Object.keys(APP_MODULE_BINDINGS)).toContain(component);
      // Compared as a list of NAMES, not as the binding object. A Babel
      // Binding holds the scope graph, so handing one to `expect` and letting
      // it fail makes jest try to serialise the whole AST, and the run dies
      // with a heap out of memory instead of printing the failure. That was
      // measured, not guessed: the first mutation run of this suite OOMed at
      // 4 GB rather than saying which component had moved back.
      expect(Object.keys(FLOCK_APP_INNER.scope.bindings).filter((n) => n === component))
        .toEqual([]);
    });

    it(`${component} is mounted as an element with a spread props object`, () => {
      expect(APP_SOURCE).toContain(`<${component} {...${props}} />`);
    });
  });
});

/* ── 2. the handover is exact, and nothing in it can go stale ────────────── */

describe('what App.js hands over is exactly what the component takes', () => {
  MOVED.forEach(({ component, props }) => {
    it(`${component} declares every name ${props} passes, and no others`, () => {
      const passedNames = PROPS_OBJECTS[props].map((p) => p.key).sort();
      const paramNames = componentParameters(FILE_ASTS[component], component)
        .map((p) => p.name)
        .sort();
      // Both directions. A parameter with nothing behind it is silently
      // undefined at runtime; a prop with no parameter is a name kept in one
      // file after the other stopped reading it.
      expect(paramNames).toEqual(passedNames);
    });

    it(`no ${component} parameter carries a default value`, () => {
      // A default turns "this prop went missing" into "this prop has a
      // plausible looking wrong value". The closure this replaced had no such
      // thing.
      const withDefault = componentParameters(FILE_ASTS[component], component)
        .filter((p) => p.hasDefault)
        .map((p) => p.name);
      expect(withDefault).toEqual([]);
    });

    it(`every property of ${props} is object shorthand`, () => {
      // Shorthand is what makes the name here and the parameter over there
      // impossible to drift apart, and it rules out the shapes that CAN go
      // stale: `foo: someRef.current` freezes a ref read at build time,
      // `foo: bar.baz` freezes a lookup.
      const notShorthand = PROPS_OBJECTS[props]
        .filter((p) => !p.shorthand)
        .map((p) => `${p.key} (line ${p.line})`);
      expect(notShorthand).toEqual([]);
    });

    it(`every name in ${props} binds to something that is never reassigned`, () => {
      // A closure read a live binding. An object literal reads it once, at the
      // instant the object is built. Those are the same answer for a const and
      // can differ for anything else, so anything else is refused.
      const bad = [];
      for (const prop of PROPS_OBJECTS[props]) {
        const name = prop.valueName || prop.key;
        const binding = FLOCK_APP_INNER.scope.getBinding(name);
        if (!binding) {
          bad.push(`${name}: no binding found in App.js`);
          continue;
        }
        if (!['const', 'module', 'param'].includes(binding.kind)) {
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
 * The same short list `extractionEquivalence.test.js` keeps, and for the same
 * reason: it OMITS the writable globals that share a name with an ordinary
 * local (name, status, length, top, self, parent, origin, event, closed, open,
 * focus, blur, history, screen, find). Those are exactly the names a missed
 * prop lands on without ever being undefined.
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

describe('every name a moved component reads has somewhere to come from', () => {
  MOVED.forEach(({ component }) => {
    it(`${component} reaches for no global outside the platform list`, () => {
      const stray = freeIdentifiers(FILE_ASTS[component])
        .filter((name) => !PLATFORM_GLOBALS.has(name));
      expect(stray).toEqual([]);
    });

    it(`${component} reaches no name through a string`, () => {
      // Scope analysis is blind to eval, to Function(), and to a lookup built
      // from a string.
      const src = FILE_SOURCES[component];
      expect(src).not.toMatch(/\beval\s*\(/);
      expect(src).not.toMatch(/new\s+Function\s*\(/);
      expect(src).not.toMatch(/\b(?:window|globalThis|self)\s*\[/);
    });
  });
});

/* ── 4. the general rule, over whatever is still declared in the render ──── */

/**
 * Every component whose binding lives inside `FlockAppInner` and which is
 * MOUNTED as a JSX element somewhere in that same component. Names only, found
 * by walking the tree rather than by being listed, so a new one is swept the
 * day it is written.
 */
function componentsDeclaredInRenderAndMounted() {
  const names = new Set();
  FLOCK_APP_INNER.traverse({
    JSXOpeningElement(p) {
      const tag = p.node.name;
      if (tag.type !== 'JSXIdentifier') return;
      if (!/^[A-Z]/.test(tag.name)) return;
      const binding = p.scope.getBinding(tag.name);
      if (!binding) return;
      let scope = binding.scope;
      while (scope) {
        if (scope.path.node === FLOCK_APP_INNER.node) { names.add(tag.name); return; }
        scope = scope.parent;
      }
    },
  });
  return [...names].sort();
}

/** The declaration path of a name bound anywhere inside FlockAppInner. */
function declarationInsideInner(name) {
  let found = null;
  FLOCK_APP_INNER.traverse({
    VariableDeclarator(p) {
      if (found) return;
      if (p.node.id.type === 'Identifier' && p.node.id.name === name) found = p;
    },
  });
  return found;
}

/**
 * Two helpers in App.js own state and effects of their own, and both were a
 * mechanism of this bug rather than a bystander. `SearchInputLocal` holds the
 * typed value and a debounce timer it clears on unmount. `DialogBehavior`
 * moves focus on mount. A component that renders either of them cannot be
 * allowed to remount for free, whatever it holds itself.
 */
const STATEFUL_CHILDREN = new Set(['SearchInputLocal', 'DialogBehavior']);
const UNCONTROLLED_FIELDS = new Set(['input', 'textarea', 'select']);

describe('nothing still declared in the render owns anything a remount destroys', () => {
  const mounted = componentsDeclaredInRenderAndMounted();

  it('the scan found components, so the rule below is being applied to something', () => {
    // The trap this closes: a walk that matches nothing reports every rule as
    // satisfied. App.js has had this shape for its whole life and the count
    // only ever moves by one or two, so a run that finds none has broken its
    // traversal rather than fixed the code.
    expect(mounted.length).toBeGreaterThan(3);
  });

  it('none of the three fixed ones is in that set any more', () => {
    MOVED.forEach(({ component }) => expect(mounted).not.toContain(component));
  });

  mounted.forEach((name) => {
    it(`${name} holds no state, no effect and no uncontrolled field of its own`, () => {
      const decl = declarationInsideInner(name);
      expect(decl).not.toBeNull();
      const findings = [];
      decl.traverse({
        CallExpression(p) {
          const callee = p.node.callee;
          const text = callee.type === 'Identifier'
            ? callee.name
            : (callee.type === 'MemberExpression'
              && callee.object.type === 'Identifier'
              && callee.object.name === 'React'
              && callee.property.type === 'Identifier'
                ? `React.${callee.property.name}`
                : '');
          if (/^(?:React\.)?use[A-Z]/.test(text)) {
            findings.push(`calls ${text} at line ${p.node.loc.start.line}`);
          }
        },
        JSXOpeningElement(p) {
          const tag = p.node.name;
          if (tag.type !== 'JSXIdentifier') return;
          if (STATEFUL_CHILDREN.has(tag.name)) {
            findings.push(`renders <${tag.name}> at line ${tag.loc.start.line}`);
            return;
          }
          if (!UNCONTROLLED_FIELDS.has(tag.name)) return;
          // A field the parent drives is safe: its value comes back from state
          // that outlives the remount. RevenueScreen's simulator is exactly
          // this, and its own comment says the state was hoisted for it.
          const controlled = p.node.attributes.some((a) => (
            a.type === 'JSXAttribute'
            && a.name.type === 'JSXIdentifier'
            && (a.name.name === 'value' || a.name.name === 'checked')
          ));
          if (!controlled) {
            findings.push(`renders an uncontrolled <${tag.name}> at line ${tag.loc.start.line}`);
          }
        },
      });
      // If this goes red, the fix is not to relax the rule. It is to move the
      // component to module scope and pass it props, the way the three above
      // were moved.
      expect(findings).toEqual([]);
    });
  });
});

/* ── 5. the two mechanisms that made the remount visible ─────────────────── */

describe('the helpers whose correct behaviour the remount weaponised', () => {
  it('SearchInputLocal still drops its pending debounce on unmount', () => {
    // This is right, and it is why a remounting parent lost the search. Pinned
    // so a future reader does not "fix" the wrong end of it.
    const at = APP_SOURCE.indexOf('const SearchInputLocal = React.memo(');
    expect(at).toBeGreaterThan(-1);
    const body = APP_SOURCE.slice(at, at + 1600);
    expect(body.length).toBe(1600);
    expect(body).toContain('React.useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);');
  });

  it('DialogBehavior still moves focus to the first focusable child on mount', () => {
    // Also right, and also why a remounting sheet stole the caret. Same reason
    // for pinning it.
    const at = APP_SOURCE.indexOf('const DialogBehavior = ({ onClose, label, modal = true }) => {');
    expect(at).toBeGreaterThan(-1);
    const body = APP_SOURCE.slice(at, at + 2200);
    expect(body.length).toBe(2200);
    expect(body).toContain('(list[0] || node).focus({ preventScroll: true });');
  });

  it('the New Message sheet receives both of them as props', () => {
    // The two are module scope in App.js and are not exported, so the sheet
    // reads them the way AddFriends does.
    const params = componentParameters(FILE_ASTS.NewDmModal, 'NewDmModal').map((p) => p.name);
    expect(params).toContain('SearchInputLocal');
    expect(params).toContain('DialogBehavior');
  });
});

/* ── 6. Edit Profile can now finish a save ───────────────────────────────── */

describe('the save that could never report itself', () => {
  const form = FILE_SOURCES.EditProfileForm;

  it('the form seeds its own state from props and keeps it in the component', () => {
    // Local state is the whole point: it survives a parent render now, which
    // is what stops the typing being erased.
    expect(form).toContain('const [editName, setEditName] = React.useState(profileName);');
    expect(form).toContain('const [editBio, setEditBio] = React.useState(profileBio);');
    expect(form).toContain("const [editSuccess, setEditSuccess] = React.useState('');");
  });

  it('the success message is set after the write and rendered from that state', () => {
    // It was always set. It could never be seen, because setProfileName and
    // setProfileBio in the same handler remounted the form that was holding
    // it.
    const at = form.indexOf('const handleSaveProfile = async () => {');
    expect(at).toBeGreaterThan(-1);
    const save = form.slice(at, form.indexOf('const pwFieldStyle', at));
    expect(save.length).toBeGreaterThan(1000);
    const setName = save.indexOf('setProfileName(data.user.name);');
    const setSuccess = save.indexOf("setEditSuccess('Profile updated successfully!');");
    expect(setName).toBeGreaterThan(-1);
    expect(setSuccess).toBeGreaterThan(setName);
    expect(form).toContain('{editSuccess && (');
  });
});
