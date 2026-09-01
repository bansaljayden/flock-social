/**
 * Accessibility of the four public marketing surfaces:
 *   src/website/LandingPage.{js,css}
 *   src/website/GuestInvite.{js,css}
 *   src/website/AboutPage.js
 *   src/website/SupportPage.js
 *
 * These are the only thing a person sees before deciding to install Flock, and
 * /i/:token is the growth path: someone who was invited lands there with no
 * account, on a phone, in a hurry.
 *
 * WHAT THIS COVERS, AND WHY EACH PART IS SHAPED THE WAY IT IS
 *
 *   1. CONTRAST IS COMPUTED, NOT ASSERTED. jsdom has no layout and no cascade
 *      resolution, so `getComputedStyle` cannot tell you what colour a string
 *      actually renders in. Instead the custom properties are read out of the
 *      real stylesheets and run through the WCAG 2.x relative-luminance
 *      formula here. That makes the token values themselves the thing under
 *      test: nudge --cream-3 or --gi-ink-3 and this file goes red with the
 *      measured ratio in the failure message.
 *
 *   2. KEYBOARD BEHAVIOUR IS EXERCISED, NOT INSPECTED. The menu is opened,
 *      Escape is pressed, Tab is pressed, and focus is asserted after each,
 *      against a real render.
 *
 *   3. A FEW THINGS ARE SOURCE SCANS, DELIBERATELY. jsdom does not implement
 *      `inert`, media queries, ::placeholder or :focus-visible, so the rules
 *      that depend on them are checked as text. Those assertions say so.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 *
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent, act, waitFor } = require('@testing-library/react');

// LiveDemo pulls maplibre-gl (a 1 MB WebGL bundle) and BirdieBird runs a rAF
// loop over four photographs. Neither is what is under test, and jsdom reports
// no IntersectionObserver, which makes LandingPage's WhenNear render its
// children immediately. Stub both so the page mounts.
jest.mock('../website/LiveDemo', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../components/ui/BirdieBird', () => ({
  __esModule: true,
  default: () => null,
  WARM_BIRD: { body: '', head: '', flap: null, neck: '0 0' },
  BIRDIE: { body: '', head: '', flap: null, neck: '0 0' },
}));

const WEBSITE = path.join(__dirname, '..', 'website');
const readCss = (f) => fs.readFileSync(path.join(WEBSITE, f), 'utf8');
const readJs = (f) => fs.readFileSync(path.join(WEBSITE, f), 'utf8');

// ───────────────────────────────────────────────────────────────────────────
// WCAG 2.x contrast, from the spec rather than from a library, so the numbers
// in the failure messages are reproducible by hand.
// ───────────────────────────────────────────────────────────────────────────
function parseColor(value) {
  const v = String(value).trim();
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hexMatch) {
    let h = hexMatch[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat([1]);
  }
  const rgba = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(v);
  if (rgba) {
    return [
      Number(rgba[1]), Number(rgba[2]), Number(rgba[3]),
      rgba[4] === undefined ? 1 : Number(rgba[4]),
    ];
  }
  throw new Error(`Cannot parse colour: ${value}`);
}

// A translucent foreground has no contrast of its own. Composite it onto the
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
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
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

// Sanity-check the maths against two pairs whose ratios are fixed by the spec,
// so a broken helper can never make the real assertions pass vacuously.
test('the contrast helper agrees with the WCAG reference values', () => {
  expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
  expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.478, 2);
  expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
});

// ───────────────────────────────────────────────────────────────────────────
// Pull `--token: value;` declarations out of a stylesheet. `scope` narrows to
// one rule block, which is how the dark-mode overrides are read separately
// from the light ones they shadow.
// ───────────────────────────────────────────────────────────────────────────
function tokens(css, scope) {
  let body = css;
  if (scope) {
    const at = css.indexOf(scope);
    if (at === -1) throw new Error(`Scope not found in stylesheet: ${scope}`);
    // Walk braces from the scope marker so a nested block cannot truncate it.
    const start = css.indexOf('{', at);
    let depth = 0;
    let end = start;
    for (let i = start; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    body = css.slice(start, end);
  }
  const out = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi;
  let m = re.exec(body);
  while (m) {
    // Later wins, like the cascade.
    out[m[1]] = m[2].trim();
    m = re.exec(body);
  }
  return out;
}

function expectRatio(fg, bg, min, label) {
  const got = contrast(fg, bg);
  if (got < min) {
    throw new Error(
      `${label}: ${fg} on ${bg} measures ${got.toFixed(2)}:1, needs ${min}:1`
    );
  }
  expect(got).toBeGreaterThanOrEqual(min);
}

// ───────────────────────────────────────────────────────────────────────────
describe('contrast, computed from the shipped tokens', () => {
  const lpCss = readCss('LandingPage.css');
  const lp = tokens(lpCss, '.lp {');

  const giCss = readCss('GuestInvite.css');
  const giLight = tokens(giCss, '.gi {');
  const giDark = tokens(giCss, '@media (prefers-color-scheme: dark)');

  test('LandingPage body-size text clears 4.5:1 on the ground it sits on', () => {
    // The hero is a radial gradient; #1b2a44 is its LIGHTEST stop, so it is the
    // worst case for anything painted over the hero.
    const heroLightest = '#1b2a44';
    // Likewise for the CTA band's linear-gradient.
    const ctaLightest = '#142238';

    expectRatio(lp['--ink-2'], lp['--paper'], 4.5, 'lead / list copy on cream');
    expectRatio(lp['--ink-3'], lp['--paper'], 4.5, '--ink-3 captions on cream');
    expectRatio(lp['--ink-3'], lp['--paper-2'], 4.5, '.lp-msg-dead on the chat bubble fill');
    expectRatio(lp['--ink-3'], '#ffffff', 4.5, '--ink-3 on the white plates');
    expectRatio(lp['--cream-2'], lp['--navy'], 4.5, 'lead / list copy on navy');
    expectRatio(lp['--cream-2'], ctaLightest, 4.5, '.lp-form-msg on the CTA gradient');
    expectRatio(lp['--cream-3'], lp['--navy'], 4.5, '--cream-3 fine print on navy');
    expectRatio(lp['--cream-3'], lp['--navy-deep'], 4.5, 'footer links');
    expectRatio(lp['--cream-3'], heroLightest, 4.5, '.lp-plate-cap on the hero gradient');
    expectRatio(lp['--steel'], lp['--paper'], 4.5, '.lp-kicker / .lp-step-n on cream');
    expectRatio(lp['--steel-lift'], lp['--navy'], 4.5, '.lp-kicker on navy');
  });

  test('the waitlist placeholder is body text and clears 4.5:1 (was 4.30)', () => {
    // The field fill is cream at 7% over the CTA gradient's lightest stop.
    const fieldOverCta = flatten('rgba(244, 239, 227, 0.07)', '#142238')
      .map(Math.round);
    const fieldHex = `rgb(${fieldOverCta.join(', ')})`;

    // The rule the markup actually uses, read out of the stylesheet, so
    // swapping it back to --cream-3 fails here rather than passing silently.
    const rule = /\.lp-form input::placeholder\s*\{\s*color:\s*var\((--[a-z0-9-]+)\)/i
      .exec(lpCss);
    expect(rule).not.toBeNull();
    const placeholder = lp[rule[1]];
    expectRatio(placeholder, fieldHex, 4.5, `.lp-form input::placeholder (${rule[1]})`);

    // ...and it must still read as a placeholder rather than as an entered
    // value, i.e. it may not simply be set to the input's own text colour.
    expect(placeholder).not.toBe(lp['--cream']);
  });

  test('text fields clear the 3:1 non-text boundary (WCAG 1.4.11)', () => {
    // An input carries no label text of its own, so its border is the whole
    // "there is a control here" signal. Buttons are exempt: their own labels
    // identify them.
    const fieldOverCta = flatten('rgba(244, 239, 227, 0.07)', '#142238').map(Math.round);
    expectRatio(lp['--field-edge'], `rgb(${fieldOverCta.join(', ')})`, 3,
      '.lp-form input border vs its own fill');
    expectRatio(lp['--field-edge'], '#142238', 3,
      '.lp-form input border vs the CTA gradient behind it');

    expectRatio(giLight['--gi-field-edge'], giLight['--gi-field'], 3,
      '.gi-input border vs its fill (light)');
    expectRatio(giLight['--gi-field-edge'], giLight['--gi-paper'], 3,
      '.gi-input border vs the paper (light)');
    expectRatio(giDark['--gi-field-edge'], giDark['--gi-field'], 3,
      '.gi-input border vs its fill (dark)');
    expectRatio(giDark['--gi-field-edge'], giDark['--gi-paper'], 3,
      '.gi-input border vs the paper (dark)');

    // And the border must actually be wired to the token.
    expect(giCss).toMatch(/\.gi-input\s*\{[^}]*border:\s*1px solid var\(--gi-field-edge\)/);
    expect(lpCss).toMatch(/\.lp-form input\s*\{[^}]*border:\s*1px solid var\(--field-edge\)/);
  });

  test('GuestInvite clears 4.5:1 in BOTH themes', () => {
    for (const [name, t] of [['light', giLight], ['dark', giDark]]) {
      expectRatio(t['--gi-ink-2'], t['--gi-paper'], 4.5, `${name}: body on paper`);
      expectRatio(t['--gi-ink-2'], t['--gi-panel'], 4.5, `${name}: .gi-venue text on the panel`);
      expectRatio(t['--gi-ink-3'], t['--gi-paper'], 4.5, `${name}: .gi-sub / .gi-meta`);
      expectRatio(t['--gi-ink-3'], t['--gi-panel'], 4.5, `${name}: .gi-venue-count`);
      expectRatio(t['--gi-ink-3'], t['--gi-field'], 4.5, `${name}: the "Maya" placeholder`);
      expectRatio(t['--gi-accent'], t['--gi-paper'], 4.5, `${name}: links and .gi-msg`);
      expectRatio(t['--gi-accent'], t['--gi-panel'], 4.5, `${name}: the "Your vote" tag`);
      expectRatio(t['--gi-bad'], t['--gi-paper'], 4.5, `${name}: the error text`);
      expectRatio(t['--gi-paper'], t['--gi-ink'], 4.5, `${name}: the primary button label`);
      expectRatio(t['--gi-accent-ink'], t['--gi-accent'], 4.5, `${name}: the pressed button label`);
      // The focus ring is drawn in --gi-accent and has to be visible against
      // the page it lands on.
      expectRatio(t['--gi-accent'], t['--gi-paper'], 3, `${name}: focus ring`);
    }
  });

  test('focus rings clear 3:1 against the surface they are drawn on', () => {
    expectRatio(lp['--steel'], lp['--paper'], 3, 'ring on cream');
    expectRatio(lp['--steel-lift'], lp['--navy'], 3, 'ring on navy');
    expectRatio(lp['--steel-lift'], lp['--navy-deep'], 3, 'ring in the footer');
    // The corner block's ring is drawn INSIDE the button, on its own --steel
    // fill, where --steel-lift would measure 2.41:1.
    expectRatio(lp['--cream'], lp['--steel'], 3, 'ring inside the menu button');
    expect(lpCss).toMatch(
      /\.lp-nav \.lp-menu-btn:focus-visible\s*\{[^}]*outline-color:\s*var\(--cream\)[^}]*outline-offset:\s*-\d/
    );

    // The skip link is the first thing a keyboard user ever focuses here, and
    // it floats over navy. The generic --steel ring measures 2.49:1 there, so
    // it gets its own, drawn inside its cream block in --navy.
    expectRatio(lp['--navy'], lp['--cream'], 3, 'ring inside the skip link');
    const skipRing = /\.lp a\.lp-skip:focus-visible[^{]*\{([^}]*)\}/.exec(lpCss);
    expect(skipRing).not.toBeNull();
    expect(skipRing[1]).toMatch(/outline:\s*\d+px solid var\(--navy\)/);
    expect(skipRing[1]).toMatch(/outline-offset:\s*-\d/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('LandingPage structure and keyboard operation', () => {
  // NOTE: nothing in this file resets the module registry, deliberately. Doing
  // so hands the component under test a SECOND copy of React while
  // @testing-library keeps the first, and every hook then reads null off a
  // foreign dispatcher. Nothing here needs a fresh module either: LandingPage's
  // only module-scope effect is idempotent (it guards on link[data-lp-font])
  // and GuestInvite reads the URL inside its render, not at import time.
  // eslint-disable-next-line global-require
  const LandingPage = require('../website/LandingPage').default;

  beforeEach(() => {
    global.fetch = jest.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    }));
  });

  test('there is exactly one main landmark, one h1, and a skip link into it', () => {
    const { container } = render(React.createElement(LandingPage));

    const mains = container.querySelectorAll('main');
    expect(mains).toHaveLength(1);
    expect(mains[0].id).toBe('lp-main');
    // Not focusable by Tab, but focusable as a skip target.
    expect(mains[0].getAttribute('tabindex')).toBe('-1');

    expect(container.querySelectorAll('h1')).toHaveLength(1);

    const skip = container.querySelector('a.lp-skip');
    expect(skip).not.toBeNull();
    expect(skip.getAttribute('href')).toBe('#lp-main');
    // It has to be the first focusable thing in the document, or it is useless.
    const focusables = container.querySelectorAll('a[href], button, input');
    expect(focusables[0]).toBe(skip);
  });

  test('the anchored sections are named regions, not anonymous divs', () => {
    const { container } = render(React.createElement(LandingPage));
    // Every destination the in-page menu offers.
    for (const id of ['how', 'birdie', 'money', 'safety', 'pricing', 'crowds']) {
      const section = container.querySelector(`section#${id}`);
      expect(section).not.toBeNull();
      const labelledBy = section.getAttribute('aria-labelledby');
      expect(labelledBy).toBeTruthy();
      // The label must resolve to real text, not a dangling id.
      const label = container.querySelector(`#${labelledBy}`);
      expect(label).not.toBeNull();
      expect(label.textContent.trim().length).toBeGreaterThan(0);
    }
  });

  test('every image either describes itself or is explicitly decorative', () => {
    const { container } = render(React.createElement(LandingPage));
    const imgs = Array.from(container.querySelectorAll('img'));
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      // alt must be PRESENT. Empty is a decision ("this is decoration");
      // missing is an omission, and a screen reader falls back to reading the
      // file name, so "mark-money-400.png" gets announced inside a paragraph
      // about splitting a bill. alt="" alone is the correct decorative marker;
      // aria-hidden on top of it is belt-and-braces, not a requirement.
      expect(img.hasAttribute('alt')).toBe(true);
      const alt = img.getAttribute('alt');
      if (alt !== '') {
        // A real description, not a filename or a single word.
        expect(alt.length).toBeGreaterThan(12);
        expect(alt).not.toMatch(/\.(png|jpe?g|webp|svg)$/i);
        expect(alt).not.toMatch(/^(image|photo|icon|logo|screenshot)$/i);
      }
    }
  });

  test('the heading outline never skips a level', () => {
    const { container } = render(React.createElement(LandingPage));
    const levels = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6'))
      .map((h) => Number(h.tagName[1]));
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
    }
  });

  test('no duplicate ids, and every aria reference resolves', () => {
    // A duplicated id silently breaks aria-labelledby / aria-describedby /
    // htmlFor: the browser resolves the FIRST match and nothing warns.
    const { container } = render(React.createElement(LandingPage));
    const ids = Array.from(container.querySelectorAll('[id]')).map((e) => e.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);

    const refs = ['aria-labelledby', 'aria-describedby', 'aria-controls'];
    for (const attr of refs) {
      for (const el of container.querySelectorAll(`[${attr}]`)) {
        for (const id of el.getAttribute(attr).split(/\s+/).filter(Boolean)) {
          if (!container.querySelector(`#${CSS.escape(id)}`)) {
            throw new Error(`${attr}="${id}" on <${el.tagName.toLowerCase()}> points at nothing`);
          }
        }
      }
    }
    for (const label of container.querySelectorAll('label[for]')) {
      expect(container.querySelector(`#${CSS.escape(label.htmlFor)}`)).not.toBeNull();
    }

    // Every in-page anchor the chrome offers has to land somewhere. A menu
    // entry pointing at a section that was renamed is a dead link that looks
    // alive.
    for (const a of container.querySelectorAll('a[href^="#"]')) {
      const id = a.getAttribute('href').slice(1);
      expect(container.querySelector(`#${CSS.escape(id)}`)).not.toBeNull();
    }
  });

  test('every accessible name contains its own visible label (WCAG 2.5.3)', () => {
    const { container } = render(React.createElement(LandingPage));
    // Compared on letters and digits only. Speech engines ignore punctuation
    // and whitespace, and the DOM's whitespace between two grid rows is not
    // what the reader sees anyway.
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

    // 2.5.3 governs CONTROLS whose name comes from their content: links,
    // buttons, fields. A landmark like <nav aria-label="Site menu"> is named
    // for the rotor and is not addressable by speech in the first place, so it
    // is correctly out of scope and deliberately not selected here.
    const controls = container.querySelectorAll(
      'a[aria-label], button[aria-label], input[aria-label], '
      + '[role="button"][aria-label], [role="link"][aria-label]'
    );
    for (const el of controls) {
      const visible = norm(el.textContent);
      // Icon-only controls have no visible label to contain, and are exempt.
      if (!visible) continue;
      const name = norm(el.getAttribute('aria-label'));
      if (!name.includes(visible)) {
        throw new Error(
          `aria-label "${el.getAttribute('aria-label')}" does not contain the `
          + `visible text "${el.textContent.replace(/\s+/g, ' ').trim()}", so speech `
          + 'input cannot address this control'
        );
      }
    }
    // Guard against the whole assertion going vacuous if the badge ever loses
    // its aria-label: the App Store badge is the case this was written for.
    const badge = container.querySelector('.lp-appstore');
    expect(badge.getAttribute('aria-label')).toBeTruthy();
    expect(norm(badge.getAttribute('aria-label'))).toContain(norm(badge.textContent));
  });

  test('browser-driven scrolls clear the sticky bar, not just anchor jumps', () => {
    // WCAG 2.4.11. Tab, find-in-page and screen-reader jumps all scroll to the
    // viewport's top edge, where a 64px opaque sticky header sits.
    const css = readCss('LandingPage.css');
    const rule = /html:has\(\.lp\)\s*\{[^}]*scroll-padding-top:\s*(\d+)px/.exec(css);
    expect(rule).not.toBeNull();
    expect(Number(rule[1])).toBeGreaterThanOrEqual(64);
  });

  test('the menu traps focus, closes on Escape, and hands focus back', () => {
    const { container } = render(React.createElement(LandingPage));
    const btn = container.querySelector('.lp-menu-btn');
    expect(btn.getAttribute('aria-label')).toBeTruthy(); // icon-only control
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-controls')).toBe('lp-menu');

    btn.focus();
    fireEvent.click(btn);

    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const panel = container.querySelector('#lp-menu');
    const firstLink = panel.querySelector('a[href]');
    // Opening moves focus into the panel rather than leaving it behind.
    expect(document.activeElement).toBe(firstLink);

    // Tab from the last item wraps to the corner block, not out to the page.
    const items = [btn, ...panel.querySelectorAll('a[href]')];
    const last = items[items.length - 1];
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(btn);

    // Shift+Tab from the first item wraps backwards, also inside.
    firstLink.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(btn);

    // Escape closes and returns focus where it came from. Focus is parked on a
    // LINK first, deliberately: the wrap assertions above leave it on the
    // corner block, so asserting from there would pass even with the
    // focus-restore deleted. (Caught by mutation: replacing
    // `menuBtnRef.current.focus()` with a no-op left the suite green.)
    firstLink.focus();
    expect(document.activeElement).toBe(firstLink);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(btn);
  });

  test('the page behind the open menu is inert, so a virtual cursor cannot walk into it', () => {
    const { container } = render(React.createElement(LandingPage));
    const main = container.querySelector('main');
    const footer = container.querySelector('footer');
    expect(main.hasAttribute('inert')).toBe(false);
    expect(footer.hasAttribute('inert')).toBe(false);

    fireEvent.click(container.querySelector('.lp-menu-btn'));
    expect(main.hasAttribute('inert')).toBe(true);
    expect(footer.hasAttribute('inert')).toBe(true);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(main.hasAttribute('inert')).toBe(false);
    expect(footer.hasAttribute('inert')).toBe(false);
  });

  test('the waitlist field has a real label and is not identified by its placeholder', () => {
    render(React.createElement(LandingPage));
    const input = screen.getByLabelText(/email address/i);
    expect(input.tagName).toBe('INPUT');
    expect(input.id).toBeTruthy();
    // The <label> is a real element pointing at it, not an aria-label string.
    const label = document.querySelector(`label[for="${input.id}"]`);
    expect(label).not.toBeNull();
    expect(input.getAttribute('aria-label')).toBeNull();
  });

  test('an empty waitlist submit is announced assertively, marks the field, and focuses it', () => {
    const { container } = render(React.createElement(LandingPage));
    const input = screen.getByLabelText(/email address/i);
    const submit = Array.from(container.querySelectorAll('button'))
      .find((b) => /join the waitlist/i.test(b.textContent));

    expect(input.getAttribute('aria-invalid')).toBeNull();

    fireEvent.click(submit);

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert.textContent).toMatch(/enter your email/i);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    // The description points at the region carrying the complaint.
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
    expect(document.activeElement).toBe(input);
    // The polite region must NOT also be carrying the failure, or it is read
    // twice and success and failure look identical.
    const status = container.querySelector('[role="status"]');
    expect(status.textContent).toBe('');

    // Typing clears the invalid state rather than leaving a red field forever.
    fireEvent.change(input, { target: { value: 'a@b.co' } });
    expect(input.getAttribute('aria-invalid')).toBeNull();
  });

  test('both live regions are mounted before they have anything to say', () => {
    const { container } = render(React.createElement(LandingPage));
    // A live region added to the DOM at the same moment its text appears is
    // missed by VoiceOver and NVDA often enough to be a bug.
    expect(container.querySelector('[role="status"].lp-form-msg')).not.toBeNull();
    expect(container.querySelector('[role="alert"].lp-form-msg')).not.toBeNull();
  });

  test('the submit button uses aria-disabled, so pressing it does not drop focus to <body>', async () => {
    let resolveFetch;
    global.fetch = jest.fn(() => new Promise((res) => { resolveFetch = res; }));

    const { container } = render(React.createElement(LandingPage));
    const input = screen.getByLabelText(/email address/i);
    fireEvent.change(input, { target: { value: 'someone@example.com' } });
    const submit = Array.from(container.querySelectorAll('button'))
      .find((b) => /join the waitlist/i.test(b.textContent));

    submit.focus();
    fireEvent.click(submit);

    await waitFor(() => expect(submit.getAttribute('aria-disabled')).toBe('true'));
    // `disabled` would have blanked this.
    expect(submit.disabled).toBe(false);
    expect(document.activeElement).toBe(submit);

    await act(async () => {
      resolveFetch({ ok: true, json: () => Promise.resolve({}) });
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('LandingPage motion', () => {
  const css = readCss('LandingPage.css');

  // Source scans: jsdom evaluates no media queries, so there is nothing to
  // render-test here.
  test('every transform-based effect has a reduced-motion answer', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.lp-btn:active { transform: none; }');
    expect(reduced).toContain('.lp-appstore:hover { transform: none; }');
    // The demo's own block, further down the file.
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*\.lpd-live-dot \{ animation: none; \}/);
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*\.lpd-pin:hover \.lpd-pin-photo \{ transform: none; \}/);
  });

  test('no scroll-triggered reveal system has come back', () => {
    // SLOP-AUDIT A10, and an accessibility bug in its own right: content that
    // only appears once a scroll handler fires ships blank when it does not.
    expect(css).not.toMatch(/\.lp-reveal/);
    expect(readJs('LandingPage.js')).not.toMatch(/lp-reveal|is-revealed/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('GuestInvite: the page an invited stranger lands on', () => {
  const PLAN = {
    flock: { name: 'Friday Night Out', when: null, status: 'planning', chosenVenue: null },
    host: 'Maya',
    going: 3,
    venues: [{ venue_name: 'The Bookstore Speakeasy', votes: 2 }],
  };

  // eslint-disable-next-line global-require
  const GuestInvite = require('../website/GuestInvite').default;

  const mount = (respond) => {
    window.history.pushState({}, '', '/i/abcdefgh12');
    global.fetch = jest.fn(respond);
    return render(React.createElement(GuestInvite));
  };

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  const okPlan = () => Promise.resolve({
    ok: true, status: 200, json: () => Promise.resolve(PLAN),
  });

  test('the name field has a visible label, not just a placeholder', async () => {
    const { container } = mount(okPlan);
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });

    const input = screen.getByLabelText(/your name/i);
    const label = container.querySelector(`label[for="${input.id}"]`);
    expect(label).not.toBeNull();
    // A visible one: not clipped off-screen the way a utility class would be.
    expect(label.className).toMatch(/gi-label/);
    expect(label.textContent.trim()).toBe('Your name');
    // The placeholder is an example, and it is not the name.
    expect(input.getAttribute('placeholder')).toBe('Maya');
  });

  test('answering with no name complains in an alert, marks the field, and focuses it', async () => {
    const { container } = mount(okPlan);
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });

    const input = screen.getByLabelText(/your name/i);
    fireEvent.click(screen.getByRole('button', { name: /i'm in/i }));

    const alert = container.querySelector('#gi-problem-rsvp');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toMatch(/put your name in/i);
    // Not colour alone: the field is programmatically invalid and the message
    // is wired to it as a description.
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('gi-problem-rsvp');
    expect(document.activeElement).toBe(input);
  });

  test('every venue row is a real button when voting is open, and a plain row when it is not', async () => {
    window.localStorage.setItem(
      'flock_guest_abcdefgh12',
      JSON.stringify({ guestToken: 'g-1', name: 'Sam', status: 'in' })
    );
    const { container } = mount(okPlan);
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });

    const voteBtn = screen.getByRole('button', { name: /bookstore speakeasy/i });
    expect(voteBtn.tagName).toBe('BUTTON');
    // Toggle state is exposed, and there is a text tag too, so it is never
    // carried by the border colour alone.
    expect(voteBtn.getAttribute('aria-pressed')).toBe('false');

    // Nothing interactive may be a bare div with an onClick.
    const rows = container.querySelectorAll('.gi-venue');
    for (const row of rows) {
      if (row.tagName !== 'BUTTON') {
        expect(row.getAttribute('onclick')).toBeNull();
        expect(row.getAttribute('tabindex')).toBeNull();
      }
    }
  });

  test('a link that dies mid-session moves focus to the message instead of losing it', async () => {
    window.localStorage.setItem(
      'flock_guest_abcdefgh12',
      JSON.stringify({ guestToken: 'g-1', name: 'Sam', status: 'in' })
    );
    let call = 0;
    mount(() => {
      call += 1;
      if (call === 1) return okPlan();
      // The host revoked the link while the tab was open.
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });

    const voteBtn = screen.getByRole('button', { name: /bookstore speakeasy/i });
    voteBtn.focus();
    await act(async () => { fireEvent.click(voteBtn); });

    const heading = await screen.findByRole('heading', { level: 1, name: /this invite has closed/i });
    // Without this the whole page is swapped silently and focus falls to
    // <body>, i.e. back to the top of the document with nothing announced.
    expect(document.activeElement).toBe(heading);
  });

  test('a dead guest token sends focus to the field that fixes it', async () => {
    // The server can 403 a VOTE because the RSVP behind the stored token was
    // removed. The page drops the identity and puts the name field back, which
    // is a control that did not exist a moment ago and sits above the fold
    // while focus is on a venue button near the bottom of the page.
    window.localStorage.setItem(
      'flock_guest_abcdefgh12',
      JSON.stringify({ guestToken: 'g-dead', name: 'Sam', status: 'in' })
    );
    let call = 0;
    const { container } = mount(() => {
      call += 1;
      if (call === 1) return okPlan();
      return Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: 'gone' }),
      });
    });
    await screen.findByRole('heading', { level: 1, name: /friday night out/i });

    const voteBtn = screen.getByRole('button', { name: /bookstore speakeasy/i });
    voteBtn.focus();
    await act(async () => { fireEvent.click(voteBtn); });

    const input = await screen.findByLabelText(/your name/i);
    await waitFor(() => expect(document.activeElement).toBe(input));
    // And the complaint is wired to the field as its description, so landing
    // on it reads the reason rather than racing the alert.
    expect(input.getAttribute('aria-describedby')).toBe('gi-problem-rsvp');
    expect(container.querySelector('#gi-problem-rsvp').textContent)
      .toMatch(/not on this plan anymore/i);
  });

  test('the loading state announces itself rather than showing silent skeletons', async () => {
    const { container } = mount(() => new Promise(() => {}));
    const live = container.querySelector('[role="status"]');
    expect(live).not.toBeNull();
    expect(live.textContent).toMatch(/loading/i);
    // The skeletons themselves are decoration and must not be announced.
    for (const skel of container.querySelectorAll('.gi-skel')) {
      expect(skel.textContent).toBe('');
    }
  });

  test('nothing on the page depends on hover', () => {
    const css = readCss('GuestInvite.css');
    // Every :hover rule must be inside the pointer-gated block, and may only
    // change decoration. A phone has no hover at all.
    const hoverRules = css.match(/^[^\n@]*:hover[^\n]*$/gm) || [];
    expect(hoverRules.length).toBeGreaterThan(0);
    for (const rule of hoverRules) {
      expect(rule).toMatch(/border[a-z-]*-color|opacity/);
      expect(rule).not.toMatch(/display|visibility|content|width|height/);
    }
    expect(css).toContain('@media (hover: hover) and (pointer: fine)');
  });

  test('the skeleton animation is opt-in on prefers-reduced-motion', () => {
    const css = readCss('GuestInvite.css');
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.gi-skel \{ animation:/
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('About and Support', () => {
  test('both render one main landmark and one h1', () => {
    for (const name of ['AboutPage', 'SupportPage']) {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const Page = require(`../website/${name}`).default;
      const { container, unmount } = render(React.createElement(Page));
      expect(container.querySelectorAll('main')).toHaveLength(1);
      expect(container.querySelectorAll('h1')).toHaveLength(1);
      unmount();
    }
  });

  test('the heading outline never skips a level', () => {
    for (const name of ['AboutPage', 'SupportPage']) {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const Page = require(`../website/${name}`).default;
      const { container, unmount } = render(React.createElement(Page));
      const levels = Array.from(container.querySelectorAll('h1,h2,h3,h4,h5,h6'))
        .map((h) => Number(h.tagName[1]));
      expect(levels[0]).toBe(1);
      for (let i = 1; i < levels.length; i += 1) {
        expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
      }
      unmount();
    }
  });

  test('the meta lines and footer links step off the failing --pp-ink-3 token', () => {
    // This used to assert --pp-ink-3 was BROKEN: it was #6b7a8c at 3.75:1 on the
    // cream paper, behind a comment claiming 4.6:1, and this pass could not edit
    // that file. It has since been fixed to #586473 (5.14:1 on paper, 4.70:1 on
    // the panels), so an assertion that it is still under 4.5 now fails for the
    // right reason. Flipped to assert the property rather than the defect: a
    // test that pins a known bug has to be flipped the day the bug is fixed, and
    // if that is forgotten it reads as a regression.
    const pp = tokens(readCss('PrivacyPolicy.css'), '.pp {');
    expectRatio(pp['--pp-ink-3'], pp['--pp-paper'], 4.5, 'the meta token on paper');
    expectRatio(pp['--pp-ink-2'], pp['--pp-paper'], 4.5, 'the token they moved to');

    // The override itself is a SOURCE scan, not a render assertion, and this is
    // a jsdom limitation rather than a preference: cssstyle validates the
    // `color` longhand and silently discards any var() reference, so
    // `el.style.color` reads "" and the style attribute is never even written.
    // Verified directly: setting `style.color = 'var(--pp-ink-2)'` on a jsdom
    // element leaves getAttribute('style') === null. Real browsers accept
    // var() in every property. What IS asserted against the render below is the
    // part jsdom can see: which elements carry the override at all.
    for (const name of ['AboutPage', 'SupportPage']) {
      const src = readJs(`${name}.js`);
      expect(src).toMatch(/const READABLE = \{ color: 'var\(--pp-ink-2\)' \};/);
      // The three places --pp-ink-3 reaches on these two pages.
      expect(src).toMatch(/className="pp-back" style=\{READABLE\}/);
      expect(src).toMatch(/className="pp-meta" style=\{READABLE\}/);
      const footer = src.slice(src.indexOf('pp-footer'));
      const footerLinks = footer.match(/<a\s[^>]*>/g) || [];
      expect(footerLinks.length).toBeGreaterThan(0);
      for (const a of footerLinks) expect(a).toContain('style={READABLE}');

      // eslint-disable-next-line global-require, import/no-dynamic-require
      const Page = require(`../website/${name}`).default;
      const { container, unmount } = render(React.createElement(Page));
      // The arrow glyph is decoration and must not end up in the link's name.
      const back = container.querySelector('.pp-back');
      expect(back.querySelector('[aria-hidden="true"]')).not.toBeNull();
      expect(back.textContent.replace(/[←\s]+/g, ' ').trim()).toBe('flockcorp.com');
      unmount();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('copy rules (SLOP-AUDIT)', () => {
  const FILES = ['LandingPage.js', 'GuestInvite.js', 'AboutPage.js', 'SupportPage.js'];

  // Comments carry the reasoning for these files and are allowed to use any
  // punctuation they like. Only what reaches the screen is under this rule.
  const stripComments = (src) => src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  test('no em dashes in user-visible copy (A2)', () => {
    for (const f of FILES) {
      const visible = stripComments(readJs(f));
      const hits = (visible.match(/.{0,40}—.{0,40}/g) || []);
      expect({ file: f, hits }).toEqual({ file: f, hits: [] });
    }
  });

  test('the site does not claim the "groups considered you" metric, which does not exist', () => {
    // backend has no route, no query and no UI for it; the only occurrence in
    // the repo is a comment quoting the VENUE-BILLING.md pricing table.
    for (const f of FILES) {
      const visible = stripComments(readJs(f));
      expect(visible).not.toMatch(/groups considered/i);
    }
  });

  // AUDIT 2026-08-26. landingPageClaims.test.js has deleted the venue
  // monetisation pitch from LandingPage.js five separate times, and every one
  // of its patterns reads exactly one file. /about, llms.txt and the crawler
  // document were never in that loop, so the identical claims went on being
  // published from all three. Confirmed live before this test was written:
  //
  //   curl -A GPTBot https://www.flockcorp.com/about
  //     "...let it put a deal in front of nearby groups, which matters most on
  //      the slow nights when a couple of extra tables changes the week."
  //   https://www.flockcorp.com/llms.txt
  //     "Venues pay to appear in front of groups that are choosing a place."
  //     "Venues pay for placement in front of nearby groups that are picking a
  //      place."
  //
  // Both name promoted placement in vote lists and the slow-night push offer.
  // README.md lists both under "Not built yet"; vote rows come from Google
  // Places in distance order and nothing in the repo reorders them, and no
  // code pushes anything to a group because a venue is quiet. The present
  // tense is the other half: there is no `stripe` dependency,
  // VENUE_BILLING_ENABLED is unset, and the only writer of
  // venue_profiles.tier is an admin comp route, so no venue has ever paid.
  //
  // marketing-page.js's own header says claim truth here is "enforced
  // transitively" through the claim-audited source pages. It was not, because
  // the audit covered one page. This is the loop that covers the surface.
  test('no page or crawler file sells promoted placement, a slow-night offer, or venues that pay', () => {
    const surfaces = [
      ...FILES.map((f) => [`website/${f}`, stripComments(readJs(f))]),
      ['public/llms.txt', fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'llms.txt'), 'utf8')],
      ['api/marketing-page.js', stripComments(fs.readFileSync(
        path.join(__dirname, '..', '..', 'api', 'marketing-page.js'), 'utf8'
      ))],
    ];

    const BANNED = [
      // Promoted placement, in every phrasing it has worn.
      [/show up in venue voting/i, 'promoted placement in vote lists'],
      [/promoted (placement|listing|spot)/i, 'promoted placement in vote lists'],
      [/(pay|pays|paying|paid) (for placement|to (show|be|get|appear))/i, 'paying to be surfaced'],
      [/in front of (nearby |local |)(groups|flocks|people)/i, 'a venue placed in front of groups'],
      // The slow-night push offer.
      [/slow night/i, 'slow-night push offers'],
      [/put an offer up/i, 'slow-night push offers'],
      // Promotions are pull, not push: GET /public-promotions/:placeId is read
      // when a user opens that venue. Nothing sends one anywhere.
      [/to nearby groups/i, "pushing a venue's post to groups"],
      [/(notify|alert|push) (nearby|local) (groups|users|flocks)/i, "pushing a venue's post to groups"],
      // Present tense. A heading that frames the business model is fine
      // ("Why venues pay (and users never do)"); asserting that venues pay FOR
      // or TO something is a statement about money that has never changed hands.
      [/venues (pay|are paying) (for|to)\b/i, 'venues paying, which none does'],
    ];

    const hits = [];
    for (const [name, text] of surfaces) {
      for (const [re, why] of BANNED) {
        const m = text.match(re);
        if (m) hits.push(`${name}: "${m[0]}" (${why})`);
      }
    }
    expect(hits).toEqual([]);
  });

  test('the crowd-model numbers on /about match the committed model metadata', () => {
    const meta = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'backend', 'scripts', 'ml', 'models', 'model_metadata.json'),
      'utf8'
    ));
    // Collapsed, because these sentences wrap across source lines.
    const copy = readJs('AboutPage.js').replace(/\s+/g, ' ');

    expect(meta.feature_count).toBe(106);
    expect(copy).toMatch(/106 signals/);

    // "1.9 million ... across 30 cities and held out another 395,000"
    expect(Math.round(meta.training_rows / 100000) / 10).toBeCloseTo(1.9, 5);
    expect(meta.training_cities.length).toBe(30);
    expect(Math.round(meta.holdout_rows / 1000)).toBe(395);
    expect(copy).toMatch(/1\.9 million/);
    expect(copy).toMatch(/30 cities/);
    expect(copy).toMatch(/395,000/);

    // "on 68,000 realtime observations it cuts the average error by 2.3 points"
    expect(Math.round(meta.ship_gate.realtime_rows / 1000)).toBe(67);
    expect(meta.ship_gate.realtime_mae_improvement).toBeCloseTo(2.06, 2);
    expect(copy).toMatch(/67,000 realtime observations/);
    expect(copy).toMatch(/2\.1 points/);
  });
});
