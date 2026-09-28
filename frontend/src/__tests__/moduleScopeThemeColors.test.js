/**
 * A COMPONENT AT MODULE SCOPE CANNOT SEE THE THEME, AND ON 2026-09-22 TWO DID
 * NOT KNOW IT.
 *
 * App.js has two things called `colors`. At module scope there is
 * `const colors = colorsLight`, the light palette, fixed for the life of the
 * page. Inside FlockAppInner there is a second one, a useMemo on isDark that
 * SHADOWS the first and is the only palette that follows the theme. Code that
 * reads `colors.navy` inside the component gets cream in dark mode. The same
 * expression one scope out gets #1e293b at every hour.
 *
 * NavIcon and Toggle were moved out of FlockAppInner to module scope to stop
 * them remounting on every render, and the comment written with that move said
 * both read only `colors`, "which is module scope". After 8 PM the selected tab
 * icon was 1.26:1 on its highlight and a switch that was on looked exactly like
 * one that was off (#2d5a87 on #2d5a87). Every screenshot in the repo predated
 * the move, so nothing showed it.
 *
 * The fix takes the palette out of both (NavIcon strokes currentColor and
 * BottomNav sets the colour from the live palette; Toggle paints with CSS
 * tokens index.css redefines for dark). This file pins that, and adds the
 * general rule that would have caught it: no function anywhere in App.js may
 * read the MODULE-SCOPE `colors`. A module-scope component that needs the
 * palette takes `colors` as a prop, as VenueDashboardSkeleton, PromoModal and
 * EventModal already do, and then its reads bind to the parameter, not to the
 * light constant.
 *
 * The check resolves each `colors` identifier through Babel's scope tracker
 * rather than by text, so a parameter or a local named `colors` is the correct
 * binding and passes, and a comment that mentions `colors.navy` is not code.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test moduleScopeThemeColors --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const SRC = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(SRC, 'App.js'), 'utf8');
const CSS = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8');

const AST = parser.parse(APP, {
  sourceType: 'module',
  plugins: ['jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator', 'objectRestSpread', 'dynamicImport'],
});

const lineOf = (node) => (node && node.loc ? node.loc.start.line : -1);

/** The top-level statement a path sits in, looked through an `export`, so an
 *  exported `export const PromoModal = ...` names its declaration the way an
 *  unexported one does (PromoModal and EventModal are exported for
 *  venueModalDoubleSubmit.test.js). */
function topLevelDeclaration(p) {
  const top = p.findParent((q) => q.parentPath && q.parentPath.isProgram());
  if (top && (top.isExportNamedDeclaration() || top.isExportDefaultDeclaration()) && top.node.declaration) {
    return top.get('declaration');
  }
  return top;
}

/** Every function-level read of the module-scope `colors`, with the name of
 *  the top-level declaration it sits in. */
function moduleColorsReadsInsideFunctions() {
  const hits = [];
  traverse(AST, {
    Identifier(p) {
      if (p.node.name !== 'colors') return;
      if (!p.isReferencedIdentifier()) return;
      const binding = p.scope.getBinding('colors');
      // No binding would be a global; there is none in a browser, and
      // treating it as a hit keeps a deleted constant from passing silently.
      const isModule = !binding || binding.scope.path.isProgram();
      if (!isModule) return;
      if (!p.getFunctionParent()) return; // top-level code, e.g. a static styles object
      const top = topLevelDeclaration(p);
      let owner = '(unknown)';
      if (top && top.isVariableDeclaration()) owner = top.node.declarations.map((d) => d.id.name).join(', ');
      else if (top && top.isFunctionDeclaration() && top.node.id) owner = top.node.id.name;
      hits.push({ owner, line: lineOf(p.node) });
    },
  });
  return hits;
}

/** The source text of the top-level `const <name> = ...` declaration. */
function topLevelSource(name) {
  const node = AST.program.body.find((s) => s.type === 'VariableDeclaration'
    && s.declarations.some((d) => d.id && d.id.name === name));
  expect(node).toBeTruthy();
  return APP.slice(node.start, node.end);
}

/** Custom properties declared across every top-level block whose selector is
 *  exactly `selector` (index.css opens :root more than once). */
function tokenBlock(selector) {
  const out = {};
  let from = 0;
  let found = 0;
  for (;;) {
    const open = CSS.indexOf(`\n${selector} {`, from);
    if (open === -1) break;
    const close = CSS.indexOf('}', open);
    const block = CSS.slice(open, close);
    for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    found += 1;
    from = close;
  }
  expect(found).toBeGreaterThan(0);
  return out;
}

const luminance = (hex) => {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('no function reads the light-only module palette', () => {
  test('the module constant is still the light palette, so this check means something', () => {
    expect(APP).toMatch(/\nconst colors = colorsLight;/);
    expect(APP).toMatch(/const colors = useMemo\(\(\) => isDark \? colorsDark : colorsLight, \[isDark\]\);/);
  });

  test('every `colors` read inside a function binds to a parameter or the live palette', () => {
    const hits = moduleColorsReadsInsideFunctions();
    // A failure names the declaration. The fix is to take `colors` as a
    // prop, or to stop reading a palette (currentColor, or a CSS token that
    // index.css redefines for dark).
    expect(hits.map((h) => `${h.owner} (App.js:${h.line})`)).toEqual([]);
  });

  test('the components that take `colors` as a prop are still seen as reading it', () => {
    // Guards the check itself: if the walk stopped resolving parameters, the
    // test above would pass on nothing. These three read `colors.` and are
    // handed it, so each must be found with a parameter binding.
    const seen = new Set();
    traverse(AST, {
      Identifier(p) {
        if (p.node.name !== 'colors' || !p.isReferencedIdentifier()) return;
        const binding = p.scope.getBinding('colors');
        if (binding && binding.kind === 'param') {
          const top = topLevelDeclaration(p);
          if (top && top.isVariableDeclaration()) top.node.declarations.forEach((d) => seen.add(d.id.name));
        }
      },
    });
    ['VenueDashboardSkeleton', 'PromoModal', 'EventModal'].forEach((name) => expect(seen.has(name)).toBe(true));
  });
});

describe('the two components that moved out on 09-22', () => {
  test('NavIcon strokes currentColor and reads no palette', () => {
    const src = topLevelSource('NavIcon');
    expect(src).toMatch(/const color = 'currentColor';/);
    expect(src).not.toMatch(/colors\./);
    const strokes = [...src.matchAll(/stroke=\{([^}]+)\}/g)].map((m) => m[1]);
    expect(strokes.length).toBeGreaterThanOrEqual(5);
    strokes.forEach((s) => expect(s).toBe('color'));
  });

  test('the tab bar sets the icon colour from the live palette', () => {
    const at = APP.indexOf('<NavIcon id={t.id} />');
    expect(at).toBeGreaterThan(-1);
    const wrapper = APP.slice(APP.lastIndexOf('<div', at), at);
    expect(wrapper).toMatch(/color: currentTab === t\.id \? colors\.navy : colors\.textTertiary/);
    // And it is inside FlockAppInner, where `colors` is the useMemo one.
    const inner = APP.indexOf('const FlockAppInner = ');
    expect(at).toBeGreaterThan(inner);
  });

  test('Toggle paints on and off from CSS tokens', () => {
    const src = topLevelSource('Toggle');
    expect(src).toMatch(/backgroundColor: on \? 'var\(--toggle-on\)' : 'var\(--toggle-off\)'/);
    expect(src).not.toMatch(/colors\./);
  });
});

describe('the switch tokens separate on from off in both themes', () => {
  const light = tokenBlock(':root');
  const dark = tokenBlock('[data-theme="dark"]');

  test('both themes define --toggle-on', () => {
    expect(light['--toggle-on']).toMatch(/^#[0-9a-f]{6}$/i);
    expect(dark['--toggle-on']).toMatch(/^#[0-9a-f]{6}$/i);
  });

  test('on and off are not the same colour, and are measurably apart', () => {
    // Dark was 1.00:1 (both #2d5a87). The knob position also carries the
    // state, so this floor is for the fill as a second cue, not the only one.
    expect(contrast(light['--toggle-on'], light['--toggle-off'])).toBeGreaterThanOrEqual(2);
    expect(contrast(dark['--toggle-on'], dark['--toggle-off'])).toBeGreaterThanOrEqual(2);
  });

  test('an on switch clears 3:1 against the card it sits on', () => {
    expect(contrast(light['--toggle-on'], light['--bg-card-solid'])).toBeGreaterThanOrEqual(3);
    expect(contrast(dark['--toggle-on'], dark['--bg-card-solid'])).toBeGreaterThanOrEqual(3);
  });
});
