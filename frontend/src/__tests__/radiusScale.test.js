/**
 * THE RADIUS SCALE (2026-11-07).
 *
 * Inline styles held 905 literal radii in 25 different values, so no two
 * screens agreed on what a card or a chip looked like. index.css now names
 * six steps and a bezel, and every inline radius in the app reads one of
 * them. This pins the tokens and fails on a new literal.
 *
 * What may still be written as a literal, and why:
 *   - 0, and 4px or less: bar geometry (a progress track, a tick, a chart
 *     bar's cap), where the radius is part of the drawing, not the surface.
 *   - 50%: a circle.
 *   - var(--chat-composer-pill-radius), the composer's own token, which
 *     chatInput.css sets to var(--r-xl).
 * The website pages (src/website) are outside the app and keep their own.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test radiusScale --watchAll=false
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8').replace(/\r\n/g, '\n');

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', 'website', '__tests__'].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.js$/.test(e.name) && !/\.test\.js$/.test(e.name)) files.push(p);
  }
})(SRC);

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// One literal token is fine when it is a step, 0, <= 4px or 50%.
const okToken = (t) => /^var\(--r-(xs|sm|md|lg|xl|pill|frame)\)$/.test(t) || t === 'var(--chat-composer-pill-radius)' || t === '0' || t === '50%' || /^([0-4](\.\d+)?)px$/.test(t);

test('index.css defines the scale once, on :root', () => {
  const want = { xs: '6px', sm: '10px', md: '12px', lg: '16px', xl: '20px', pill: '999px', frame: '44px' };
  for (const [k, v] of Object.entries(want)) {
    const hits = CSS.match(new RegExp(`\\n  --r-${k}: ([^;]+);`, 'g')) || [];
    expect({ k, hits }).toEqual({ k, hits: [`\n  --r-${k}: ${v};`] });
  }
});

test('every inline borderRadius string in the app is a step, 0, 50% or bar geometry', () => {
  const bad = [];
  for (const f of files) {
    const src = strip(fs.readFileSync(f, 'utf8'));
    // A value runs to the next comma or brace at depth 0; collect its quoted literals.
    for (const m of src.matchAll(/borderRadius:\s*([^,}\n]+(?:\?[^,}\n]+)?)/g)) {
      const expr = m[1];
      if (/^\s*\d+\s*$/.test(expr) && +expr > 4) bad.push(`${path.relative(SRC, f)}: borderRadius: ${expr.trim()}`);
      for (const lit of expr.matchAll(/'([^']*)'/g)) {
        const toks = lit[1].trim().split(/\s+/);
        if (toks.some((t) => !okToken(t))) bad.push(`${path.relative(SRC, f)}: '${lit[1]}'`);
      }
    }
  }
  expect(bad).toEqual([]);
});

test('skeleton and thumbnail radius props read the scale too', () => {
  const bad = [];
  for (const f of files) {
    const src = strip(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/\b(?:radius|thumbRadius)=\{(\d+)\}/g)) if (+m[1] > 4) bad.push(`${path.relative(SRC, f)}: ${m[0]}`);
    for (const m of src.matchAll(/\b(?:radius|thumbRadius)="([^"]+)"/g)) if (!okToken(m[1])) bad.push(`${path.relative(SRC, f)}: ${m[0]}`);
    for (const m of src.matchAll(/\bradius: (\d+) \}/g)) if (+m[1] > 4) bad.push(`${path.relative(SRC, f)}: ${m[0]}`);
  }
  expect(bad).toEqual([]);
});

test('the composer reads the scale through its own token', () => {
  const css = fs.readFileSync(path.join(SRC, 'components', 'chat', 'chatInput.css'), 'utf8');
  expect(css).toMatch(/--chat-composer-pill-radius: var\(--r-xl\);/);
});

test('the bezel token is the desktop phone frame and nothing else', () => {
  const users = files.filter((f) => /var\(--r-frame\)/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(SRC, f).replace(/\\/g, '/')).sort();
  expect(users).toEqual(['App.js', 'components/ui/Skeleton.js']);
});
