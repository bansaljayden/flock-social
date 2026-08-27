/**
 * Accessibility of the four legal / account surfaces:
 *   src/website/PrivacyPolicy.{js,css}
 *   src/website/TermsOfService.js
 *   src/website/CommunityGuidelines.js
 *   src/website/DeleteAccount.js
 *
 * These are long documents rather than marketing pages, and two of them are
 * compliance surfaces: /delete-account is the URL Google Play requires, and
 * /privacy is what an App Review human opens. The people who read them are
 * often here because something has gone wrong.
 *
 * WHY EACH PART IS SHAPED THE WAY IT IS
 *
 *   1. CONTRAST IS COMPUTED, NEVER ASSERTED. jsdom resolves no cascade, so
 *      getComputedStyle cannot tell you what colour anything renders in. The
 *      custom properties are read out of the real stylesheet and pushed
 *      through the WCAG 2.x relative-luminance formula here, which makes the
 *      token values themselves the thing under test.
 *
 *   2. THE COMMENTS ARE UNDER TEST TOO. --pp-ink-3 shipped a 1.4.3 failure for
 *      months behind a comment that claimed "4.6:1 on paper" while the value
 *      measured 3.75:1. A comment that states a ratio is a claim about the
 *      code, and an unchecked claim is how that one survived. Every "N / M"
 *      ratio comment in PrivacyPolicy.css is now re-derived from the hex
 *      beside it, in both themes.
 *
 *   3. THE ENTRANCE ANIMATION IS TESTED AS A CONTENT-VISIBILITY RISK, not as
 *      a style. `animation: ... both` over `from { opacity: 0 }` ships the
 *      page's <h1> and its plain-English summary BLANK anywhere the animation
 *      is held at time zero. Same class SLOP-AUDIT A10 bans scroll reveals for.
 *
 *   4. jsdom implements no media queries, no :focus-visible and no layout, so
 *      the rules that depend on them are checked as source. Those assertions
 *      say so where they appear.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 *
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, fireEvent } = require('@testing-library/react');

const WEBSITE = path.join(__dirname, '..', 'website');
const read = (f) => fs.readFileSync(path.join(WEBSITE, f), 'utf8');

const PP_CSS = read('PrivacyPolicy.css');

// The four pages this file owns. All four import PrivacyPolicy.css.
const PAGES = ['PrivacyPolicy', 'TermsOfService', 'CommunityGuidelines', 'DeleteAccount'];

// NOTE: nothing here resets the module registry. Doing so hands a component a
// second copy of React while @testing-library keeps the first, and every hook
// then reads null off a foreign dispatcher.
const load = (name) => {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(`../website/${name}`).default;
};

// ───────────────────────────────────────────────────────────────────────────
// WCAG 2.x contrast, written from the spec rather than pulled from a library,
// so every number in a failure message is reproducible by hand.
// ───────────────────────────────────────────────────────────────────────────
function parseColor(value) {
  const v = String(value).trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat([1]);
  }
  const rgba = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i
    .exec(v);
  if (rgba) {
    return [
      Number(rgba[1]), Number(rgba[2]), Number(rgba[3]),
      rgba[4] === undefined ? 1 : Number(rgba[4]),
    ];
  }
  throw new Error(`Cannot parse colour: ${value}`);
}

// A translucent foreground has no contrast of its own; composite it onto the
// opaque ground first, which is what the browser paints.
function flatten(color, ground) {
  const [r, g, b, a] = parseColor(color);
  if (a === 1) return [r, g, b];
  const [br, bg, bb] = parseColor(ground);
  return [r, g, b].map((c, i) => c * a + [br, bg, bb][i] * (1 - a));
}

function luminance([r, g, b]) {
  const ch = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(fg, bg) {
  const ground = flatten(bg, '#ffffff');
  const front = flatten(fg, bg);
  const l1 = luminance(front);
  const l2 = luminance(ground);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function expectRatio(fg, bg, min, label) {
  const got = contrast(fg, bg);
  if (got < min) {
    throw new Error(`${label}: ${fg} on ${bg} measures ${got.toFixed(2)}:1, needs ${min}:1`);
  }
  expect(got).toBeGreaterThanOrEqual(min);
}

// A broken helper would make every real assertion below pass vacuously, so it
// is checked against pairs whose ratios are fixed by the WCAG formula itself
// (black/white and grey/white are the values quoted in the spec's own
// examples; the primaries are arithmetic).
test('the contrast helper reproduces the WCAG reference values', () => {
  expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
  expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.478, 2);
  expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.542, 2);
  expect(contrast('#595959', '#ffffff')).toBeCloseTo(7.005, 2);
  expect(contrast('#0000ff', '#ffffff')).toBeCloseTo(8.592, 2);
  expect(contrast('#ff0000', '#ffffff')).toBeCloseTo(3.998, 2);
  expect(contrast('#008000', '#ffffff')).toBeCloseTo(5.137, 2);
  // Exercises the LINEAR segment of the sRGB transfer function (channels at or
  // below 0.03928 divide by 12.92 instead of taking the power). Every pair
  // above has zero or large channels only, so all of them survive a wrong
  // divisor here; this one does not. Added after a mutation run showed
  // `s / 12.92 -> s / 12.0` leaving the whole suite green.
  expect(contrast('#050505', '#ffffff')).toBeCloseTo(20.381, 3);
  expect(contrast('#0a0a0a', '#ffffff')).toBeCloseTo(19.798, 3);
  // Symmetric, and unaffected by argument order.
  expect(contrast('#16283d', '#f1ede0')).toBeCloseTo(contrast('#f1ede0', '#16283d'), 10);
  // Alpha compositing: 50% black over white composites to rgb(127.5), ~3.98:1.
  expect(contrast('rgba(0,0,0,0.5)', '#ffffff')).toBeCloseTo(3.977, 2);
});

// ───────────────────────────────────────────────────────────────────────────
// Read `--token: value;` declarations out of one rule block. Braces are walked
// from the scope marker so a nested block cannot truncate the body.
// ───────────────────────────────────────────────────────────────────────────
// `marker` may be a string or a RegExp. Regexes are how the multi-line
// selectors are found: this repo's CSS is checked in with CRLF endings, so a
// literal "@media (...) {\n  .pp-toc-inner" never matches on disk.
function blockAt(css, marker) {
  let end;
  if (marker instanceof RegExp) {
    const m = new RegExp(marker.source, marker.flags.replace('g', '')).exec(css);
    end = m ? m.index + m[0].length : -1;
  } else {
    const at = css.indexOf(marker);
    end = at === -1 ? -1 : at + marker.length;
  }
  if (end === -1) throw new Error(`Scope not found in stylesheet: ${marker}`);
  // Search from just inside the marker, so a marker that already includes its
  // own opening brace still resolves to that brace and not to a later one.
  const start = css.indexOf('{', end - 1);
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, i);
    }
  }
  throw new Error(`Unbalanced braces after ${marker}`);
}

function tokens(css, marker) {
  const body = blockAt(css, marker);
  const out = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi;
  let m = re.exec(body);
  while (m) {
    out[m[1]] = m[2].trim(); // later wins, like the cascade
    m = re.exec(body);
  }
  return out;
}

const LIGHT = tokens(PP_CSS, '.pp {');
const DARK = tokens(PP_CSS, '@media (prefers-color-scheme: dark)');

// ───────────────────────────────────────────────────────────────────────────
describe('contrast, computed from the shipped tokens', () => {
  // Every ink token on this stylesheet lands on one of exactly two grounds:
  // the page (--pp-paper) or a recessed panel (--pp-paper-2: .pp-summary,
  // .pp-contact). Nothing here is large-scale text in the 1.4.3 sense: the
  // smallest of them is 12px and the largest that uses an ink token below
  // --pp-ink is 16px, so 4.5:1 is the bar everywhere.
  const THEMES = [['light', LIGHT], ['dark', DARK]];

  test('every ink token clears 4.5:1 on both grounds, in both themes', () => {
    for (const [name, t] of THEMES) {
      for (const ground of ['--pp-paper', '--pp-paper-2']) {
        expectRatio(t['--pp-ink'], t[ground], 4.5, `${name}: headings on ${ground}`);
        expectRatio(t['--pp-ink-2'], t[ground], 4.5, `${name}: body copy on ${ground}`);
        expectRatio(t['--pp-ink-3'], t[ground], 4.5, `${name}: meta text on ${ground}`);
        expectRatio(t['--pp-accent'], t[ground], 4.5, `${name}: link text on ${ground}`);
      }
    }
  });

  test('--pp-ink-3 is fixed, and is not the value that failed', () => {
    // THE ROUTED FINDING. #6b7a8c measured 3.75:1 on --pp-paper and 3.42:1 on
    // --pp-paper-2 while its comment claimed 4.6:1. It carries .pp-meta,
    // .pp-back, .pp-footer a, .pp-summary p, .pp-toc a, .pp-toc-label and
    // .pp li::marker across SIX pages: Privacy, Terms, Guidelines, Delete
    // account, About and Support. All of those are 12-16px text.
    expect(LIGHT['--pp-ink-3'].toLowerCase()).not.toBe('#6b7a8c');
    expect(contrast('#6b7a8c', LIGHT['--pp-paper'])).toBeLessThan(4.5);

    expectRatio(LIGHT['--pp-ink-3'], LIGHT['--pp-paper'], 4.5, '.pp-meta / .pp-toc a on paper');
    expectRatio(LIGHT['--pp-ink-3'], LIGHT['--pp-paper-2'], 4.5, '.pp-summary p on the panel');
    expectRatio(DARK['--pp-ink-3'], DARK['--pp-paper'], 4.5, 'dark: meta on paper');
    expectRatio(DARK['--pp-ink-3'], DARK['--pp-paper-2'], 4.5, 'dark: meta on the panel');
  });

  test('the skip link and its focus ring are legible on their own block', () => {
    // .pp-skip paints --pp-paper on --pp-ink and draws its ring INSIDE itself
    // in --pp-paper, because the generic .pp a ring is --pp-accent at +3px on
    // whatever the page happens to show behind a fixed-position element.
    for (const [name, t] of [['light', LIGHT], ['dark', DARK]]) {
      expectRatio(t['--pp-paper'], t['--pp-ink'], 4.5, `${name}: skip-link label`);
      expectRatio(t['--pp-paper'], t['--pp-ink'], 3, `${name}: skip-link focus ring`);
    }
    const skip = blockAt(PP_CSS, '.pp a.pp-skip {');
    expect(skip).toMatch(/background:\s*var\(--pp-ink\)/);
    expect(skip).toMatch(/color:\s*var\(--pp-paper\)/);
    // Two rules share this selector pair (the un-hide and the ring); the
    // lookahead picks the ring without consuming its opening brace.
    const ring = blockAt(
      PP_CSS,
      /\.pp a\.pp-skip:focus,\s*\.pp a\.pp-skip:focus-visible\s*\{(?=\s*outline)/
    );
    expect(ring).toMatch(/outline:\s*3px solid var\(--pp-paper\)/);
    // Drawn inside. A positive offset would put the ring on the page behind it.
    expect(ring).toMatch(/outline-offset:\s*-\d/);

    // The un-hide must answer :focus as well as :focus-visible. A skip link is
    // reached only by keyboard, so if an engine ever declines to call that
    // "visible" focus, the link holds focus while sitting off-screen, which is
    // an invisible-focus bug rather than a cosmetic one.
    const unhide = blockAt(PP_CSS, /\.pp a\.pp-skip:focus,\s*\.pp a\.pp-skip:focus-visible\s*\{(?=\s*transform)/);
    expect(unhide).toMatch(/transform:\s*none/);
    const unhideSel = /(\.pp a\.pp-skip:focus,\s*\.pp a\.pp-skip:focus-visible)\s*\{\s*transform/.exec(PP_CSS);
    expect(unhideSel).not.toBeNull();
    expect(unhideSel[1]).toContain(':focus,');
    expect(unhideSel[1]).toContain(':focus-visible');
  });

  test('the skip link outranks the generic .pp a rule that would otherwise recolour it', () => {
    // Caught by re-audit, in Chromium, after this file's source-scan version of
    // the assertion above passed on a rule that never applied. `.pp a` is
    // (0,1,1); a bare `.pp-skip` is (0,1,0) and loses BOTH `color` and
    // `border: 0` to it, which paints the label in --pp-accent on the --pp-ink
    // block: 2.08:1 light, 2.59:1 dark, on the one control a keyboard user
    // meets first. A source scan of the declarations cannot see that, so what
    // is asserted here is the selector's rank.
    // The failure this guards against is real in both themes: if `.pp a` wins,
    // this is what the label measures.
    expect(contrast(LIGHT['--pp-accent'], LIGHT['--pp-ink'])).toBeLessThan(3);
    expect(contrast(DARK['--pp-accent'], DARK['--pp-ink'])).toBeLessThan(3);

    // Every .pp-skip rule must carry the type selector that lets it win.
    // Comments discuss the broken form by name, so they are stripped first.
    const code = PP_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    // The optional trailing brace matters: without it this scan only saw the
    // selector lines ending in a comma and never the ones ending in ` {`,
    // which is most of them. A mutation run caught that too.
    const rules = [...code.matchAll(/^([^{}\n]*\.pp-skip[^{}\n]*?)\s*\{?\s*$/gm)].map((m) => m[1].trim());
    // Three selector lines: the block, the un-hide, the ring.
    expect(rules.length).toBeGreaterThanOrEqual(3);
    for (const sel of rules) {
      if (!/\.pp\s+a\.pp-skip/.test(sel)) {
        throw new Error(
          `"${sel}" is a bare .pp-skip selector. It is outranked by \`.pp a\`, `
          + 'so the skip link paints in --pp-accent on --pp-ink (2.08:1). '
          + 'Write it as `.pp a.pp-skip`.'
        );
      }
    }
  });

  test('focus rings clear 3:1 against the surfaces they are drawn on (WCAG 1.4.11)', () => {
    // The generic ring is --pp-accent, and it lands on the page or on a panel.
    for (const [name, t] of [['light', LIGHT], ['dark', DARK]]) {
      expectRatio(t['--pp-accent'], t['--pp-paper'], 3, `${name}: ring on paper`);
      expectRatio(t['--pp-accent'], t['--pp-paper-2'], 3, `${name}: ring on a panel`);
    }
    expect(PP_CSS).toMatch(/outline:\s*2px solid var\(--pp-accent\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the ratio comments in the stylesheet are true', () => {
  // This is the guard for how the bug survived. `--pp-ink-3: #6b7a8c; /* meta
  // — 4.6:1 on paper */` was read by four separate passes as a measurement.
  // Every ratio comment is now re-derived from the hex beside it.
  //
  // Format: `--token: #hex;   /* label — <on paper> / <on paper-2> */`
  const RATIO = /(--pp-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\s*;[ \t]*\/\*[^*]*?([\d.]+)\s*\/\s*([\d.]+)\s*\*\//g;

  const documented = (block) => {
    const out = [];
    const re = new RegExp(RATIO.source, 'g');
    let m = re.exec(block);
    while (m) {
      out.push({ token: m[1], hex: m[2], onPaper: Number(m[3]), onPanel: Number(m[4]) });
      m = re.exec(block);
    }
    return out;
  };

  for (const [name, marker] of [['light', '.pp {'], ['dark', '@media (prefers-color-scheme: dark)']]) {
    test(`${name}: every documented ratio matches the value beside it`, () => {
      const block = blockAt(PP_CSS, marker);
      const rows = documented(block);
      const t = name === 'light' ? LIGHT : DARK;

      // Guard against the whole test going vacuous if the comment format is
      // reworded and the parser silently stops matching. There are four ink
      // tokens per theme and every one of them carries a ratio.
      expect(rows.map((r) => r.token).sort()).toEqual(
        ['--pp-accent', '--pp-ink', '--pp-ink-2', '--pp-ink-3']
      );

      for (const row of rows) {
        // The comment has to be attached to the value it describes.
        expect(row.hex.toLowerCase()).toBe(t[row.token].toLowerCase());

        const paper = contrast(row.hex, t['--pp-paper']);
        const panel = contrast(row.hex, t['--pp-paper-2']);
        if (Math.abs(paper - row.onPaper) > 0.005 || Math.abs(panel - row.onPanel) > 0.005) {
          throw new Error(
            `${name} ${row.token} (${row.hex}) is commented "${row.onPaper} / ${row.onPanel}" `
            + `but measures ${paper.toFixed(2)} / ${panel.toFixed(2)} `
            + `on ${t['--pp-paper']} / ${t['--pp-paper-2']}. `
            + 'Fix the comment or fix the colour, but do not ship a false measurement.'
          );
        }
      }
    });
  }

  test('no ratio comment anywhere in the file is left in the old prose form', () => {
    // "4.6:1 on paper" was the shape of the wrong one. The new form carries
    // both grounds, so the single-ground form must not come back: it is the
    // form that let a panel failure hide behind a page measurement.
    const offenders = (PP_CSS.match(/[\d.]+:1 on paper/gi) || []);
    expect(offenders).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the entrance animation cannot ship the page blank', () => {
  test('pp-settle never touches opacity', () => {
    // THE SECOND ROUTED FINDING. The keyframes were
    //   from { opacity: 0; transform: translateY(8px); }
    // driven by `animation: pp-settle 0.5s ... both`. animation-fill-mode:
    // both holds the `from` frame before the animation runs, so anything that
    // leaves it at time zero (a "disable animations" extension setting
    // animation-play-state: paused, an injected animation-delay, a print
    // stylesheet) paints the <h1> and the plain-English summary of a PRIVACY
    // POLICY at zero opacity with nothing left to reveal them.
    const frames = [...PP_CSS.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)].map((m) => m[1]);
    expect(frames).toContain('pp-settle');

    for (const name of frames) {
      const body = blockAt(PP_CSS, `@keyframes ${name}`);
      if (/opacity\s*:\s*0(?!\.[1-9])/.test(body)) {
        throw new Error(
          `@keyframes ${name} starts or ends at opacity 0. Content that is only `
          + 'visible once an animation has run ships blank when it does not run.'
        );
      }
    }
  });

  test('the settle is transform-only and is gated on prefers-reduced-motion', () => {
    const settle = blockAt(PP_CSS, '@keyframes pp-settle');
    expect(settle).toMatch(/transform:\s*translateY\(/);
    expect(settle).not.toMatch(/opacity/);

    // The rule that drives it must sit inside a no-preference block: the
    // marker only matches if that @media wrapper is immediately in front of it.
    const noPref = blockAt(
      PP_CSS,
      /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.pp-header,\s*\.pp-summary/
    );
    expect(noPref).toMatch(/animation:\s*pp-settle/);
    // Source scan: jsdom evaluates no media queries. Nothing outside a
    // no-preference block may run this animation. Comments quote the old
    // broken declaration, so they are stripped before counting.
    const code = PP_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect([...code.matchAll(/animation:\s*pp-settle/g)].length).toBe(1);
    // And the fill mode may not be one that holds a start frame forward.
    expect(code).not.toMatch(/animation:[^;]*pp-settle[^;]*\b(both|forwards)\b/);
  });

  test('smooth scrolling is also gated on prefers-reduced-motion', () => {
    // Source scan, same reason. A 12-entry contents rail that smooth-scrolls
    // is a vestibular trigger for the exact user who set the preference.
    const smooth = /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*html:has\(\.pp\)\s*\{\s*scroll-behavior:\s*smooth/;
    expect(PP_CSS).toMatch(smooth);
    // ...and it must not also be set unconditionally somewhere else.
    expect((PP_CSS.match(/scroll-behavior:\s*smooth/g) || []).length).toBe(1);
  });

  test('nothing on these pages is a scroll-triggered reveal (SLOP-AUDIT A10)', () => {
    // Comments are allowed to name the pattern they rejected; only code counts.
    // PrivacyPolicy.js explains at length why its contents rail is scroll-based
    // rather than an IntersectionObserver, and that sentence is not a reveal.
    const stripComments = (src) => src
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(stripComments(PP_CSS)).not.toMatch(/\.pp-reveal|is-revealed/);
    for (const p of PAGES) {
      const code = stripComments(read(`${p}.js`));
      expect({ page: p, hits: code.match(/pp-reveal|is-revealed|IntersectionObserver/g) })
        .toEqual({ page: p, hits: null });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Accessible name, computed the way an AT computes it: aria-label wins, then
// aria-labelledby, then the subtree with aria-hidden branches removed.
// ───────────────────────────────────────────────────────────────────────────
function visibleText(el) {
  let out = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3) out += node.textContent;
    else if (node.nodeType === 1) {
      if (node.getAttribute('aria-hidden') === 'true') continue;
      out += visibleText(node);
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

function accessibleName(el, root) {
  if (el.hasAttribute('aria-label')) return el.getAttribute('aria-label').trim();
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    return by.split(/\s+/).filter(Boolean)
      .map((id) => {
        const t = root.querySelector(`#${CSS.escape(id)}`);
        return t ? visibleText(t) : '';
      })
      .join(' ').replace(/\s+/g, ' ').trim();
  }
  return visibleText(el);
}

// ───────────────────────────────────────────────────────────────────────────
describe.each(PAGES)('%s: document structure', (name) => {
  const mount = () => render(React.createElement(load(name)));

  test('exactly one main landmark and exactly one h1', () => {
    const { container, unmount } = mount();
    expect(container.querySelectorAll('main')).toHaveLength(1);
    const h1s = container.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent.trim().length).toBeGreaterThan(0);
    unmount();
  });

  test('the heading outline starts at h1 and never skips a level', () => {
    const { container, unmount } = mount();
    const levels = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6'))
      .map((h) => Number(h.tagName[1]));
    expect(levels.length).toBeGreaterThan(1);
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i] - levels[i - 1] > 1) {
        throw new Error(`heading outline jumps h${levels[i - 1]} -> h${levels[i]}`);
      }
    }
    unmount();
  });

  test('no duplicate ids, and every aria reference resolves', () => {
    // A duplicated id silently breaks aria-labelledby: the browser resolves
    // the FIRST match and nothing warns.
    const { container, unmount } = mount();
    const ids = Array.from(container.querySelectorAll('[id]')).map((e) => e.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);

    for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      for (const el of container.querySelectorAll(`[${attr}]`)) {
        for (const id of el.getAttribute(attr).split(/\s+/).filter(Boolean)) {
          if (!container.querySelector(`#${CSS.escape(id)}`)) {
            throw new Error(`${attr}="${id}" on <${el.tagName.toLowerCase()}> points at nothing`);
          }
        }
      }
    }
    unmount();
  });

  test('every in-page anchor lands on an element that exists', () => {
    const { container, unmount } = mount();
    const anchors = container.querySelectorAll('a[href^="#"]');
    for (const a of anchors) {
      const id = a.getAttribute('href').slice(1);
      if (!container.querySelector(`#${CSS.escape(id)}`)) {
        throw new Error(`"${a.textContent.trim()}" points at #${id}, which is not on the page`);
      }
    }
    unmount();
  });

  test('the back link is named "flockcorp.com", with the arrow marked decorative', () => {
    const { container, unmount } = mount();
    const back = container.querySelector('.pp-back');
    expect(back).not.toBeNull();
    // The arrow has to be inside an aria-hidden element rather than loose in
    // the link text, or the name is "← flockcorp.com".
    expect(back.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(accessibleName(back, container)).toBe('flockcorp.com');
    expect(back.getAttribute('href')).toBeTruthy();
    unmount();
  });

  test('no arrow or ellipsis glyph is left loose in any link or heading name', () => {
    // ←, →, ⋯ are icons drawn as characters. A speech engine either announces
    // the character's Unicode name inside the sentence or, at default
    // punctuation levels, says nothing at all and leaves the sentence without
    // its subject. Either way the glyph must sit in an aria-hidden branch with
    // real text beside it.
    const { container, unmount } = mount();
    for (const el of container.querySelectorAll('a, h1, h2, h3, button')) {
      const nameText = accessibleName(el, container);
      const bad = nameText.match(/[←→⋯…↔⇒»]/g);
      if (bad) {
        throw new Error(
          `<${el.tagName.toLowerCase()}> is named "${nameText}", which still contains `
          + `the decorative glyph(s) ${bad.join(' ')}`
        );
      }
    }
    unmount();
  });

  test('every link has a destination and a name', () => {
    const { container, unmount } = mount();
    const links = container.querySelectorAll('a');
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      expect(a.getAttribute('href')).toBeTruthy();
      const nameText = accessibleName(a, container);
      if (nameText.length < 3) {
        throw new Error(`<a href="${a.getAttribute('href')}"> has no usable accessible name`);
      }
    }
    unmount();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('PrivacyPolicy: the contents rail and skipping past it', () => {
  const PrivacyPolicy = load('PrivacyPolicy');
  const mount = () => render(React.createElement(PrivacyPolicy));

  test('the skip link is the first focusable thing and lands on a real target', () => {
    const { container, unmount } = mount();
    const focusables = container.querySelectorAll('a[href], button, input, [tabindex="0"]');
    const skip = container.querySelector('a.pp-skip');
    expect(skip).not.toBeNull();
    // First in DOM order, or a keyboard user reaches the contents rail before
    // the thing that exists to skip the contents rail.
    expect(focusables[0]).toBe(skip);
    expect(skip.getAttribute('href')).toBe('#pp-body');
    expect(skip.textContent.trim().length).toBeGreaterThan(5);

    const target = container.querySelector('#pp-body');
    expect(target).not.toBeNull();
    // Focusable as a destination, not by Tab. Without this the browser moves
    // the scroll and leaves focus in the rail, so the next Tab walks straight
    // back into the list the user just skipped.
    expect(target.getAttribute('tabindex')).toBe('-1');
    // ...and the target must actually contain the document, not sit beside it.
    expect(target.querySelector('h1')).not.toBeNull();
    expect(target.querySelectorAll('.pp-doc section').length).toBeGreaterThan(5);
    // The rail must be OUTSIDE it, or skipping to it skips nothing.
    expect(target.querySelector('.pp-toc')).toBeNull();
    unmount();
  });

  test('the contents rail is a nav named by the heading a sighted reader sees', () => {
    const { container, unmount } = mount();
    const nav = container.querySelector('nav.pp-toc');
    expect(nav).not.toBeNull();
    // Labelled by the on-screen "Contents", not by a separate string that can
    // drift away from it. It used to say "Sections" while the page said
    // "Contents".
    const label = nav.getAttribute('aria-labelledby');
    expect(label).toBeTruthy();
    expect(nav.getAttribute('aria-label')).toBeNull();
    const source = container.querySelector(`#${CSS.escape(label)}`);
    expect(source).not.toBeNull();
    expect(accessibleName(nav, container)).toBe(source.textContent.trim());
    expect(accessibleName(nav, container)).toBe('Contents');
    unmount();
  });

  test('every contents entry lands on a section that exists, and every section is listed', () => {
    const { container, unmount } = mount();
    const links = Array.from(container.querySelectorAll('.pp-toc a[href^="#"]'));
    expect(links.length).toBeGreaterThan(5);

    const targets = links.map((a) => a.getAttribute('href').slice(1));
    for (const id of targets) {
      const section = container.querySelector(`section#${CSS.escape(id)}`);
      expect(section).not.toBeNull();
      // The landing point must carry a heading, or the jump arrives nowhere
      // a screen reader can orient from.
      expect(section.querySelector('h2')).not.toBeNull();
    }

    // ...and nothing in the document is unreachable from the rail.
    const sections = Array.from(container.querySelectorAll('.pp-doc section[id]'))
      .map((s) => s.id);
    expect(sections.sort()).toEqual([...targets].sort());
    unmount();
  });

  test('the reading position is exposed as aria-current="location", on exactly one entry', () => {
    const { container, unmount } = mount();
    const links = Array.from(container.querySelectorAll('.pp-toc a[href^="#"]'));

    // Deliberately NOT the first entry. activeId initialises to SECTIONS[0],
    // so asserting on entry 0 would pass with the click handler deleted.
    const idx = links.length - 3;
    expect(idx).toBeGreaterThan(0);
    const target = links[idx];
    expect(target.getAttribute('aria-current')).toBeNull();

    fireEvent.click(target);

    expect(target.getAttribute('aria-current')).toBe('location');
    const marked = links.filter((a) => a.hasAttribute('aria-current'));
    expect(marked).toEqual([target]);
    // The entry that WAS current has to have given it up.
    expect(links[0].getAttribute('aria-current')).toBeNull();
    unmount();
  });

  test('the stylesheet styles the aria-current value the component actually writes', () => {
    // These are in two files and drift apart silently: the CSS matched
    // [aria-current='true'] for as long as the JS wrote 'true', and changing
    // one alone leaves the reading position with no visual indicator at all.
    const js = read('PrivacyPolicy.js');
    const written = /aria-current=\{[^}]*\?\s*'([a-z]+)'/.exec(js);
    expect(written).not.toBeNull();
    expect(written[1]).toBe('location');
    expect(PP_CSS).toContain(`.pp-toc a[aria-current='${written[1]}']`);

    // The indicator is not colour alone: the weight changes too (WCAG 1.4.1).
    const rule = blockAt(PP_CSS, `.pp-toc a[aria-current='${written[1]}']`);
    expect(rule).toMatch(/font-weight:\s*[6-9]00/);
  });

  test('the plain-English summary is a named landmark, not an anonymous "complementary"', () => {
    const { container, unmount } = mount();
    const aside = container.querySelector('aside.pp-summary');
    expect(aside).not.toBeNull();
    const by = aside.getAttribute('aria-labelledby');
    expect(by).toBeTruthy();
    const heading = container.querySelector(`#${CSS.escape(by)}`);
    expect(heading).not.toBeNull();
    expect(heading.tagName).toBe('H2');
    expect(accessibleName(aside, container)).toBe('The short version');
    unmount();
  });

  test('the contents rail leaves room for the focus ring it clips', () => {
    // Source scan: jsdom has no layout, so the clipping cannot be observed.
    // overflow-y:auto forces the computed overflow-x from `visible` to `auto`,
    // which makes the rail a scroll container on both axes and clips the +3px
    // ring on a focused entry down both edges.
    // Comments stripped first: this rule's own comment explains the clipping
    // and contains the literal "overflow-y:auto", which satisfied the scan
    // below even when the declaration had been changed to `visible`. A mutation
    // run caught that.
    const rail = blockAt(PP_CSS, /@media \(min-width: 960px\)\s*\{\s*\.pp-toc-inner/)
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rail).toMatch(/position:\s*sticky/);
    expect(rail).toMatch(/overflow-y:\s*auto/);
    const pad = /padding:\s*(\d+)px/.exec(rail);
    if (!pad) throw new Error('.pp-toc-inner scrolls but reserves no room for the focus ring');
    // 2px outline + 3px offset = 5px of ring outside the link box.
    expect(Number(pad[1])).toBeGreaterThanOrEqual(5);
  });

  test('the back link clears the 24px minimum target size on its own declarations', () => {
    // Computed from the stylesheet, because jsdom reports every box as 0x0.
    // .pp sets line-height 1.7; .pp-back is an inline-block at 14px, so what
    // this rule declares is a 23.8px line box, under WCAG 2.5.8's floor.
    //
    // Chromium measures the shipped link at 24.8px, not 23.8px, because `.pp a`
    // contributes a 1px border-bottom that `.pp-back { border: 0 }` is too weak
    // to remove. That extra pixel is deliberately NOT counted here: it is an
    // accident of specificity that a later tidy-up would delete, and a target
    // that passes only because of a border nobody meant to draw is not passing.
    const root = blockAt(PP_CSS, '.pp {');
    const lineHeight = Number(/line-height:\s*([\d.]+)/.exec(root)[1]);
    const back = blockAt(PP_CSS, '.pp-back {');
    const fontSize = Number(/font-size:\s*(\d+)px/.exec(back)[1]);
    const padding = /padding:\s*(\d+)px/.exec(back);
    const padY = padding ? Number(padding[1]) : 0;

    const height = fontSize * lineHeight + padY * 2;
    if (height < 24) {
      throw new Error(
        `.pp-back is ${height.toFixed(1)}px tall (${fontSize}px x ${lineHeight} `
        + `+ 2 x ${padY}px padding), under the 24px minimum`
      );
    }
    expect(height).toBeGreaterThanOrEqual(24);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the flat documents: Terms, Guidelines, Delete account', () => {
  const FLAT = ['TermsOfService', 'CommunityGuidelines', 'DeleteAccount'];

  test('their sections are direct children of .pp, which is what gives them a measure', () => {
    // These three have no .pp-shell and no .pp-doc. Everything with a class in
    // this stylesheet carries max-width: var(--pp-measure); their bare
    // <section>s carried nothing, so the heading and the footer sat at 72ch
    // while the legal text between them ran the full width of the viewport.
    expect(PP_CSS).toMatch(/\.pp > section \{[^}]*max-width:\s*var\(--pp-measure\)/);
    expect(PP_CSS).toMatch(/--pp-measure:\s*\d+ch/);

    for (const name of FLAT) {
      const { container, unmount } = render(React.createElement(load(name)));
      const main = container.querySelector('main.pp');
      const direct = Array.from(main.children).filter((c) => c.tagName === 'SECTION');
      // If this ever drops to zero the rule above stops applying and nothing
      // else would notice.
      expect(direct.length).toBeGreaterThan(2);
      expect(direct.length).toBe(container.querySelectorAll('section').length);
      unmount();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('CommunityGuidelines: the reporting instructions survive being read aloud', () => {
  test('the ⋯ menu is named, and named the same thing the app names it', () => {
    const { container, unmount } = render(React.createElement(load('CommunityGuidelines')));
    const text = container.textContent;
    // The glyph is still on screen for a sighted reader.
    expect(text).toContain('⋯');

    // ...and it is inside an aria-hidden branch, so it is not also spoken.
    // `.find()` returns undefined when it finds nothing, and
    // `expect(undefined).not.toBeNull()` PASSES, so this assertion was vacuous
    // in its first form and a mutation run caught it: un-hiding the glyph left
    // the suite green.
    const hidden = Array.from(container.querySelectorAll('[aria-hidden="true"]'))
      .find((el) => el.textContent.includes('⋯'));
    expect(hidden).toBeDefined();

    // The glyph must NOT survive into what is read out.
    const spokenPara = Array.from(container.querySelectorAll('p'))
      .find((el) => /menu at the top/.test(el.textContent));
    expect(visibleText(spokenPara)).not.toMatch(/[⋯…]/);
    expect(visibleText(spokenPara)).toMatch(/The More options menu at the top/);

    // What gets read instead, and it has to match the button's real name in
    // the app or the instruction sends a screen-reader user hunting for a
    // control that announces itself differently.
    // The DM "More options" button moved to screens/DmDetail.js on 2026-08-27,
    // so its aria-label is read from there alongside App.js.
    const app = fs.readFileSync(
      path.join(__dirname, '..', 'App.js'), 'utf8'
    ) + fs.readFileSync(
      path.join(__dirname, '..', 'screens', 'DmDetail.js'), 'utf8'
    );
    const dmMenu = /<button aria-label="([^"]+)"[^>]*onClick=\{\(\) => setShowDmMenu/.exec(app);
    expect(dmMenu).not.toBeNull();

    const spoken = Array.from(container.querySelectorAll('.pp-sr-only'))
      .map((el) => el.textContent.trim());
    expect(spoken).toContain(dmMenu[1]);
    unmount();
  });

  test('.pp-sr-only hides visually without leaving the accessibility tree', () => {
    // display:none and visibility:hidden both remove the text from the tree as
    // well, which would make every visually-hidden label on these pages a
    // no-op. Source scan: jsdom resolves no cascade.
    const rule = blockAt(PP_CSS, '.pp-sr-only {');
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/clip:\s*rect\(/);
    expect(rule).not.toMatch(/display:\s*none/);
    expect(rule).not.toMatch(/visibility:\s*hidden/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('DeleteAccount: the destructive page', () => {
  const mount = () => render(React.createElement(load('DeleteAccount')));

  test('the email route out is a real, named, self-describing link', () => {
    // For someone who has already uninstalled, this link IS the deletion path.
    const { container, unmount } = mount();
    const links = Array.from(container.querySelectorAll('a[href^="mailto:"]'));
    expect(links.length).toBeGreaterThan(0);

    const prefilled = links.find((a) => a.getAttribute('href').includes('subject='));
    expect(prefilled).not.toBeNull();
    const name = accessibleName(prefilled, container);
    expect(name).toMatch(/request deletion by email/i);
    // A mailto that opens a composer with a draft already in it is a surprise
    // unless it is announced, and it is not visible in the link text.
    expect(name).toMatch(/email app/i);
    expect(name).not.toMatch(/[→←]/);

    const href = decodeURIComponent(prefilled.getAttribute('href'));
    expect(href).toMatch(/subject=Delete my Flock account/i);
    expect(href).toMatch(/Email on the account/i);
    unmount();
  });

  test('the irreversibility is stated in text, before the instructions', () => {
    const { container, unmount } = mount();
    const body = container.textContent.replace(/\s+/g, ' ');
    expect(body).toMatch(/irreversible/i);
    // Before the first "how to" heading, not buried at the bottom.
    const warnAt = body.search(/irreversible/i);
    const howAt = body.search(/In the app/i);
    expect(warnAt).toBeGreaterThan(-1);
    expect(warnAt).toBeLessThan(howAt);
    unmount();
  });

  test('if this page ever gains a state machine, it must also gain a live region', () => {
    // Today /delete-account is a static instruction page: no useState, no
    // fetch, nothing to announce. The real destructive flow with its confirm
    // and error states lives in App.js, behind Profile -> Delete account.
    //
    // This assertion is the guard on that boundary rather than a claim about
    // today. The moment somebody wires a form into this page, "the result was
    // shown in red text somewhere on the page" stops being acceptable for a
    // deletion, and this fails until a role="alert"/role="status" region is
    // added with it.
    const src = read('DeleteAccount.js');
    const interactive = /useState|useReducer|fetch\(|onSubmit|onClick/.test(src);
    if (interactive) {
      expect(src).toMatch(/role="(alert|status)"/);
    } else {
      // Pin the premise, so the branch above cannot quietly become dead code.
      expect(src).not.toMatch(/useState|useReducer|fetch\(|onSubmit|onClick/);
    }
  });
});
