/**
 * iOS FOCUS-ZOOM FLOOR — every focusable text control computes to >= 16px.
 *
 * THE BUG THIS EXISTS TO STOP COMING BACK. Flock ships as a Capacitor app, so
 * every screen is a WKWebView. WKWebView zooms the whole viewport when a
 * focused <input>, <select> or <textarea> has a computed font-size under 16px.
 * Jayden hit it on a real device on the Birdie composer and on the venue and
 * admin dashboards. It is not a design choice and no screen benefits from it.
 *
 * THE FIX UNDER TEST is two rules in src/index.css, and only 16px on the
 * control itself can deliver it:
 *
 *   1. A TOKEN RE-SCOPE. App.js writes nearly every field as an INLINE style,
 *      `style={{ fontSize: 'var(--t-body)' }}` and friends. An inline
 *      declaration outranks any normal stylesheet rule, so no base rule can
 *      beat it. But `var()` resolves against the ELEMENT'S OWN computed custom
 *      properties, so redefining the four sub-16px roles on input/textarea/
 *      select makes those same inline declarations compute to 16px, with no
 *      !important and without editing App.js. This is what reaches Birdie.
 *   2. A font-size FLOOR for controls that declare no size of their own
 *      (Tailwind preflight otherwise gives them the parent's size).
 *
 * WHAT THIS FILE ACTUALLY VERIFIES, AND WHAT IT ONLY SCANS.
 *
 *   jsdom implements no cascade resolution, no var() substitution and no
 *   media queries, so `getComputedStyle` cannot answer "what size does this
 *   field render at". Nothing here pretends otherwise. Instead:
 *
 *   - The stylesheet is PARSED and the declared values are the thing under
 *     test. Change --t-meta's control-scoped value to 12px and this goes red
 *     with the measured number.
 *   - The cascade is RE-DERIVED here, not observed: selector specificity is
 *     computed by the counter in this file and compared, which is how the
 *     "does the floor beat .lpd-input" question is answered. That counter
 *     handles the selector shapes this repo actually uses (type, class,
 *     attribute, :not() of a simple selector, descendant). It is not a
 *     general CSS engine, and it is asserted against known selectors below
 *     so a wrong answer shows up as a failing self-check rather than a
 *     silently passing suite.
 *   - Token resolution for App.js's inline styles is SIMULATED: the token
 *     values are read out of the control-scoped rule in index.css and
 *     substituted into the `var(--t-*)` each field declares. That is a real
 *     end-to-end check of the App.js surface, but it is arithmetic on source
 *     text, not a render.
 *   - Everything else is an explicit SOURCE SCAN and says so at the
 *     assertion.
 *
 *   NOT COVERED, on purpose: whether iOS itself honours the floor (only a
 *   device can say), anything injected at runtime (there is none — the repo
 *   creates no controls via createElement or innerHTML), and layout fallout
 *   from fields getting taller.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 *
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const ROOT = path.join(SRC, '..');
const INDEX_CSS = path.join(SRC, 'index.css');
const INDEX_HTML = path.join(ROOT, 'public', 'index.html');

const MIN = 16;

const readFile = (p) => fs.readFileSync(p, 'utf8');

/* ── walking the tree ─────────────────────────────────────────────────── */

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      collect(p, out);
    } else if (/\.(js|jsx|css)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

const ALL_FILES = collect(SRC);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

/* Strip /* *\/ comments so a size quoted inside prose is never read as a rule.
   The 16px FLOOR block in index.css talks about 12px and 15px in English. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/* Every innermost `selector { body }` pair. Good enough for flat rule sets and
   for rules nested one level inside @media, which is all this repo has. */
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selector = m[1].replace(/\s+/g, ' ').trim();
    if (!selector || selector.startsWith('@')) continue;
    out.push({ selector, body: m[2] });
  }
  return out;
}

const declaration = (body, prop) => {
  const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i'));
  return m ? m[1].trim() : null;
};

const px = (value) => {
  const m = String(value).match(/^(-?\d+(?:\.\d+)?)px$/);
  return m ? parseFloat(m[1]) : null;
};

/* ── specificity ──────────────────────────────────────────────────────── */

/**
 * (ids, classes, types) for one compound/complex selector.
 * :not() contributes the specificity of its argument, which is exactly why the
 * floor rule's :not([type=...]) chain outranks a bare class rule.
 */
function specificity(selector) {
  let s = selector.trim();
  let ids = 0;
  let classes = 0;
  let types = 0;

  // :not(...) / :is(...) — take the argument's specificity (single-arg here).
  s = s.replace(/:(?:not|is)\(([^()]*)\)/g, (_, inner) => {
    const [i, c, t] = specificity(inner);
    ids += i;
    classes += c;
    types += t;
    return ' ';
  });
  // :where() contributes nothing.
  s = s.replace(/:where\([^()]*\)/g, ' ');

  ids += (s.match(/#[\w-]+/g) || []).length;
  s = s.replace(/#[\w-]+/g, ' ');

  classes += (s.match(/\[[^\]]*\]/g) || []).length; // attribute selectors
  s = s.replace(/\[[^\]]*\]/g, ' ');

  // Pseudo-elements count as types; remaining pseudo-classes as classes.
  const pseudoEls = s.match(/::[\w-]+/g) || [];
  types += pseudoEls.length;
  s = s.replace(/::[\w-]+/g, ' ');

  classes += (s.match(/:[\w-]+/g) || []).length;
  s = s.replace(/:[\w-]+/g, ' ');

  classes += (s.match(/\.[\w-]+/g) || []).length;
  s = s.replace(/\.[\w-]+/g, ' ');

  types += (s.match(/(^|[\s>+~])([a-zA-Z][\w-]*)/g) || []).length;

  return [ids, classes, types];
}

const spec = (selectorList) =>
  selectorList
    .split(',')
    .map((s) => specificity(s))
    .reduce((a, b) => (cmpSpec(b, a) > 0 ? b : a), [0, 0, 0]);

function cmpSpec(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/* ── the control surface ──────────────────────────────────────────────── */

const CONTROL_TAGS = ['input', 'textarea', 'select'];

/** Does this selector list target a focusable text control? */
const targetsControl = (selectorList) =>
  selectorList
    .split(',')
    .some((s) =>
      /(^|[\s>+~])(input|textarea|select)\b/i.test(s.trim()) ||
      /\[contenteditable/i.test(s)
    );

/**
 * Selectors that carry no tag name but are applied to a control in JSX.
 * Derived from the className values actually present on control elements, so
 * a new class rule under 16px on a field is caught even though the selector
 * never says "input".
 */
function controlClassNames() {
  const names = new Set();
  for (const file of ALL_FILES) {
    if (!/\.jsx?$/.test(file)) continue;
    for (const tag of controlTags(readFile(file))) {
      const m = tag.text.match(/className\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"|\{\s*'([^']*)')/);
      const raw = m && (m[1] || m[2] || m[3] || m[4]);
      if (raw) raw.split(/\s+/).filter(Boolean).forEach((n) => names.add(n));
    }
  }
  return names;
}

/** Every <input>/<textarea>/<select> opening tag in a JS source, with line no. */
function controlTags(source) {
  const out = [];
  const re = /<(input|textarea|select)\b/g;
  let m;
  while ((m = re.exec(source))) {
    // Walk to the '>' that closes the tag, ignoring any inside JSX braces.
    let depth = 0;
    let end = -1;
    for (let j = m.index; j < source.length; j += 1) {
      const c = source[j];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) {
        end = j;
        break;
      }
    }
    out.push({
      tag: m[1],
      line: source.slice(0, m.index).split('\n').length,
      text: source.slice(m.index, end < 0 ? m.index + 400 : end + 1),
    });
  }
  return out;
}

/* Rules from real .css files AND from the <style>{`...`}</style> template
   literals this app keeps in JS (AuthShell's .auth-field lives in one). */
function allStyleRules() {
  const out = [];
  for (const file of ALL_FILES) {
    const source = readFile(file);
    if (file.endsWith('.css')) {
      for (const r of rules(stripComments(source))) out.push({ file, ...r });
      continue;
    }
    for (const m of source.matchAll(/<style>\{`([\s\S]*?)`\}<\/style>/g)) {
      // Template placeholders would break brace matching; neutralise them.
      const css = stripComments(m[1]).replace(/\$\{[^}]*\}/g, 'X');
      for (const r of rules(css)) out.push({ file, ...r });
    }
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   KNOWN OUTSTANDING — sub-16px sizes on controls that this agent does not
   own and could not edit. Each is a one-line fix in someone else's file.

   A NEW offender anywhere fails the suite. An entry here that has since
   been fixed does NOT fail it: several agents work this repo in parallel
   and a correct fix should never break a test. Prune by hand when fixed.
   ═══════════════════════════════════════════════════════════════════════ */
const KNOWN_OUTSTANDING = [
  // .lpd-input (the LiveDemo field) was listed here at 15px; its owner fixed
  // it to 16px at source on 2026-08-14 and the entry was pruned, per the rule
  // above.
  //
  // src/components/ui/placeholders-and-vanish-input.js was listed here for a
  // Tailwind `text-sm` (14px) on the shadcn vanish input, annotated "zero
  // callers, so this is dormant". The bundle audit on 2026-08-26 confirmed the
  // zero-callers half and acted on it: that component, and ten more like it,
  // were imported by nothing in the repo and appeared in no built chunk, so
  // they were deleted rather than restyled. A deleted file cannot have a font
  // size, and the assertion below that every entry names a file that EXISTS
  // would have gone red on the deletion. Pruned, per the rule above.
];

const isKnown = (file) => KNOWN_OUTSTANDING.some((k) => rel(file) === k.file);

/* ═══════════════════════════════════════════════════════════════════════
   1. VIEWPORT — pinch zoom must keep working
   ═══════════════════════════════════════════════════════════════════════ */

describe('viewport meta does not trade pinch zoom for a fix it cannot deliver', () => {
  const html = readFile(INDEX_HTML);
  const viewport = (html.match(/<meta\s+name="viewport"[^>]*>/i) || [])[0];

  it('declares a viewport', () => {
    expect(viewport).toBeTruthy();
  });

  it('never sets user-scalable=no or maximum-scale', () => {
    // Both fail WCAG 1.4.4 (Resize Text), and Safari has ignored them for
    // FOCUS zoom since iOS 10 — so they break the working thing and do not
    // fix the broken one. The floor in index.css is the actual fix.
    expect(viewport).not.toMatch(/user-scalable/i);
    expect(viewport).not.toMatch(/maximum-scale/i);
    expect(viewport).not.toMatch(/minimum-scale/i);
  });

  it('keeps viewport-fit=cover (the safe-area contract depends on it)', () => {
    expect(viewport).toMatch(/viewport-fit\s*=\s*cover/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   2. THE TOKEN RE-SCOPE — what makes App.js's inline styles land at 16px
   ═══════════════════════════════════════════════════════════════════════ */

describe('index.css re-scopes the sub-16px type roles on form controls', () => {
  const css = stripComments(readFile(INDEX_CSS));
  const controlRules = rules(css).filter((r) => targetsControl(r.selector));

  const tokenRule = controlRules.find((r) => /--t-body\s*:/.test(r.body));

  it('a control-scoped rule redefines the type tokens', () => {
    expect(tokenRule).toBeTruthy();
    for (const tag of CONTROL_TAGS) {
      expect(tokenRule.selector).toMatch(new RegExp(`(^|[\\s,>+~])${tag}\\b`));
    }
  });

  it.each(['--t-body', '--t-label', '--t-meta', '--t-micro'])(
    '%s is at least 16px on a control',
    (token) => {
      const value = px(declaration(tokenRule.body, token));
      expect(value).not.toBeNull();
      expect(value).toBeGreaterThanOrEqual(MIN);
    }
  );

  it('leaves --t-display and --t-title alone so larger fields stay larger', () => {
    // A control that asked for 19px should get 19px, not be flattened to 16.
    expect(declaration(tokenRule.body, '--t-display')).toBeNull();
    expect(declaration(tokenRule.body, '--t-title')).toBeNull();
  });

  it('the page-level roles are untouched — this is a control-only override', () => {
    // The type scale is the design; only its use on fields is overridden.
    const rootRule = rules(css).find(
      (r) => r.selector === ':root' && /--t-body\s*:/.test(r.body)
    );
    expect(px(declaration(rootRule.body, '--t-body'))).toBe(15);
    expect(px(declaration(rootRule.body, '--t-meta'))).toBe(12);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   3. THE FLOOR RULE — for controls that declare no size of their own
   ═══════════════════════════════════════════════════════════════════════ */

describe('index.css floors font-size on controls that declare no size', () => {
  const css = stripComments(readFile(INDEX_CSS));
  const floorRule = rules(css).find(
    (r) => targetsControl(r.selector) && px(declaration(r.body, 'font-size')) !== null
  );

  it('exists and is at least 16px', () => {
    expect(floorRule).toBeTruthy();
    expect(px(declaration(floorRule.body, 'font-size'))).toBeGreaterThanOrEqual(MIN);
  });

  it('covers input, textarea and select', () => {
    for (const tag of CONTROL_TAGS) {
      expect(floorRule.selector).toMatch(new RegExp(`(^|[\\s,>+~])${tag}\\b`));
    }
  });

  it('exempts the control types that never trigger focus zoom', () => {
    // Forcing 16px onto a range slider or a hidden file picker changes paint
    // for no benefit — neither can zoom the viewport. The photo-crop and
    // camera zoom sliders are range inputs.
    for (const type of ['checkbox', 'radio', 'file', 'color', 'range']) {
      expect(floorRule.selector).toContain(`:not([type="${type}"])`);
    }
  });

  it('outranks a single-class rule — the :not() chain is load-bearing', () => {
    // SOURCE-DERIVED, not observed: specificity is computed by this file.
    // A bare `input` selector is (0,0,1) and loses to .lpd-input (0,1,0),
    // which is 15px. The :not([type=...]) chain lifts it above every class
    // rule in the build, which is why no !important is needed anywhere.
    const floor = spec(floorRule.selector);
    expect(cmpSpec(floor, [0, 1, 0])).toBeGreaterThan(0);
    expect(cmpSpec(floor, [0, 1, 1])).toBeGreaterThan(0);
  });

  it('self-check: the specificity counter agrees with hand-computed values', () => {
    // If this counter is wrong, the assertion above passes for the wrong
    // reason. These are worked out by hand against CSS Selectors L4.
    expect(specificity('input')).toEqual([0, 0, 1]);
    expect(specificity('.lpd-input')).toEqual([0, 1, 0]);
    expect(specificity('.lp-form input')).toEqual([0, 1, 1]);
    expect(specificity('input:not([type="range"])')).toEqual([0, 1, 1]);
    expect(specificity('#a .b input')).toEqual([1, 1, 1]);
    expect(specificity(':where(.x) input')).toEqual([0, 0, 1]);
  });

  it('is declared after @tailwind base, which sets font-size:100% on controls', () => {
    // Equal specificity with preflight's `input,select,textarea{font-size:100%}`,
    // so source order decides. SOURCE SCAN: index positions in the file.
    const raw = readFile(INDEX_CSS);
    expect(raw.indexOf('@tailwind base')).toBeGreaterThanOrEqual(0);
    expect(raw.indexOf(floorRule.selector.split(',')[0].trim())).toBeGreaterThan(
      raw.indexOf('@tailwind base')
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   4. THE APP SURFACE — every token-driven field resolves to >= 16px
   ═══════════════════════════════════════════════════════════════════════ */

describe('every var(--t-*) field in the app resolves to at least 16px', () => {
  const css = stripComments(readFile(INDEX_CSS));
  const tokenRule = rules(css).find(
    (r) => targetsControl(r.selector) && /--t-body\s*:/.test(r.body)
  );
  const rootRule = rules(css).find(
    (r) => r.selector === ':root' && /--t-body\s*:/.test(r.body)
  );

  /* Token values as they compute ON A CONTROL: the control-scoped rule wins,
     otherwise the :root value is inherited. */
  const onControl = (token) => {
    const scoped = px(declaration(tokenRule.body, token));
    return scoped !== null ? scoped : px(declaration(rootRule.body, token));
  };

  const fields = [];
  for (const file of ALL_FILES) {
    if (!/\.jsx?$/.test(file)) continue;
    const source = readFile(file);
    for (const t of controlTags(source)) {
      const m = t.text.match(/fontSize\s*:\s*'var\(\s*(--t-[\w-]+)\s*\)'/);
      if (m) fields.push({ file, line: t.line, tag: t.tag, token: m[1], text: t.text });
    }
  }

  it('found the token-driven fields (guards against a broken scan)', () => {
    // If the scanner silently matches nothing, every assertion below is
    // vacuous. App.js alone carries well over a dozen of these.
    expect(fields.length).toBeGreaterThan(12);
  });

  it('resolves each one to >= 16px', () => {
    const under = fields
      .map((f) => ({ ...f, size: onControl(f.token) }))
      .filter((f) => !(f.size >= MIN));
    expect(
      under.map((f) => `${rel(f.file)}:${f.line} <${f.tag}> ${f.token} -> ${f.size}px`)
    ).toEqual([]);
  });

  it('the Birdie composer specifically — the field the bug was reported on', () => {
    const birdie = fields.find((f) => /aria-label="Ask me anything"/.test(f.text));
    expect(birdie).toBeTruthy();
    expect(birdie.token).toBe('--t-body');
    expect(onControl(birdie.token)).toBeGreaterThanOrEqual(MIN);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   5. REGRESSION SWEEP — nothing new may declare a control under 16px
   ═══════════════════════════════════════════════════════════════════════ */

describe('no stylesheet rule puts a focusable control under 16px', () => {
  const classNames = controlClassNames();

  const offenders = allStyleRules()
    .filter((r) => {
      if (!/font-size/i.test(r.body)) return false;
      const hitsControl =
        targetsControl(r.selector) ||
        r.selector
          .split(',')
          .some((s) =>
            (s.match(/\.([\w-]+)/g) || []).some((c) => classNames.has(c.slice(1)))
          );
      return hitsControl;
    })
    .map((r) => ({ ...r, size: px(declaration(r.body, 'font-size')) }))
    .filter((r) => r.size !== null && r.size < MIN);

  it('SOURCE SCAN: any rule under 16px is either fixed or a known handoff', () => {
    const unexpected = offenders.filter((o) => !isKnown(o.file));
    expect(
      unexpected.map((o) => `${rel(o.file)}  ${o.selector}  ${o.size}px`)
    ).toEqual([]);
  });

  it('found rules to check (guards against a scan that matches nothing)', () => {
    const scanned = allStyleRules().filter((r) => targetsControl(r.selector));
    expect(scanned.length).toBeGreaterThan(0);
  });
});

describe('no inline style puts a focusable control under 16px', () => {
  const offenders = [];
  for (const file of ALL_FILES) {
    if (!/\.jsx?$/.test(file)) continue;
    const source = readFile(file);
    for (const t of controlTags(source)) {
      // A range/file/checkbox/radio control cannot zoom the viewport.
      if (/type\s*=\s*["'](range|file|checkbox|radio|color|submit|button)["']/.test(t.text)) continue;
      for (const m of t.text.matchAll(/fontSize\s*:\s*['"](\d+(?:\.\d+)?)px['"]/g)) {
        const size = parseFloat(m[1]);
        if (size < MIN) offenders.push({ file, line: t.line, tag: t.tag, size });
      }
    }
  }

  it('SOURCE SCAN: any literal px under 16px is a known handoff', () => {
    // An inline literal is the ONE thing the index.css floor cannot reach:
    // a normal stylesheet declaration loses to the style attribute, and the
    // token re-scope only helps fields written as var(--t-*).
    const unexpected = offenders.filter((o) => !isKnown(o.file));
    expect(
      unexpected.map((o) => `${rel(o.file)}:${o.line} <${o.tag}> ${o.size}px`)
    ).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
   6. THE HANDOFF LIST IS ITSELF UNDER TEST
   ═══════════════════════════════════════════════════════════════════════ */

describe('the known-outstanding list stays meaningful', () => {
  it('every entry names a file that exists', () => {
    for (const k of KNOWN_OUTSTANDING) {
      expect(fs.existsSync(path.join(ROOT, k.file))).toBe(true);
    }
  });

  it('every entry carries a concrete one-line fix', () => {
    for (const k of KNOWN_OUTSTANDING) {
      expect(k.fix.length).toBeGreaterThan(10);
    }
  });

  it('nothing is left that the floor cannot reach', () => {
    // This was NOT empty when the floor was written: ModerationSheet.js's
    // report textarea was an inline literal 13px, which no stylesheet rule
    // can override. Its owner fixed it to 16px on 2026-08-14, so the floor
    // plus the token re-scope now cover every focusable control in the app.
    // If this list ever grows again, a field has shipped with a hardcoded
    // sub-16px literal and only its own file can fix it.
    const unreachable = KNOWN_OUTSTANDING.filter((k) => !k.reachedByFloor);
    expect(unreachable.map((k) => k.file)).toEqual([]);
  });
});
