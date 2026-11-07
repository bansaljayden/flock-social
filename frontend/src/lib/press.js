// HOW A PRESS FEELS. The JavaScript half of the press system whose CSS half is
// the PRESS block at the end of index.css; read that block first.
//
// iOS highlights a control the moment a finger lands on it and acts when the
// finger lifts (WWDC18 "Designing Fluid Interfaces": "the button should
// highlight immediately when I touch down on it ... But, we shouldn't confirm
// the tap until my touch goes up"). A web page gets the second half for free:
// click fires on release, and a touch that turns into a scroll sends no click
// and drops :active, which is UIScrollView's touch cancelling. The first half
// needed two things here.
//
//   1. :active AT ALL. Safari on iOS only applies :active when a touch handler
//      is listening on the element or an ancestor (Apple's Safari Web Content
//      Guide, "Handling Events"). One empty, passive touchstart listener on the
//      document is that handler for every control in the app, the ones drawn
//      in portals and sheets included. Passive, so it can never hold a scroll.
//
//   2. WHICH KIND OF PRESS. iOS presses different controls differently: a text
//      or icon button fades, a filled button dims a little, a list row fills
//      grey behind its content. The app draws its ~1,000 buttons with inline
//      styles, so CSS cannot see which ones are filled. On pointerdown, before
//      the browser paints the press, this reads the button's resting face once
//      and writes data-press-auto="fill" or "text"; index.css draws the press
//      from that. It is read again on every press because a control's face
//      changes (a segment fills when chosen). A button that says what it is
//      with its own data-press, or that draws its own press (OWN_PRESS), is
//      left alone.
//
// Nothing here runs on the press path except one getComputedStyle on the
// pressed element, and nothing here can throw into it.

/** Everything the press system treats as a button. */
export const PRESSABLE = 'button, [role="button"]';

/* Controls that already draw a press of their own, so the shared one would be
   a second press on top: the glass system (index.css, which uses the shared
   tokens itself), the floating create button, the Nest card's stretched
   button (the card takes its press), the auth screen's buttons, the chat's
   cards, sheet rows and tiles, and the emergency sheet. index.css excludes the
   same list from the generic rule; src/__tests__/pressFeel.test.js holds the
   two lists equal. */
export const OWN_PRESS = [
  '.glass-btn',
  '.fab-press',
  '.nest-stretch',
  '.shimmer-btn',
  '.shimmer-btn-light',
  '.auth-eye',
  '.auth-primary',
  '.auth-provider',
  '.auth-secondary',
  '.chat-card-tappable',
  '.chat-venue-action',
  '.cs-row',
  '.cs-menu-item',
  '.cs-tile',
  '.es-btn',
  '.es-call',
];

/** The CSS transition a control with its own inline `transition` adds so its release still eases back. */
export const PRESS_TRANSITION = 'transform var(--press-out) var(--press-ease), opacity var(--press-out) var(--press-ease)';

/** True when a computed colour paints nothing. */
export function isClear(color) {
  if (!color) return true;
  const c = String(color).trim().toLowerCase();
  if (c === 'transparent' || c === 'none') return true;
  // The space-separated forms carry alpha after a slash: rgb(r g b / 0),
  // color(srgb r g b / 0). The comma form only as a fourth part: rgba(r, g, b, 0).
  const slash = c.match(/\/\s*([0-9.]+)%?\s*\)$/);
  if (slash) return Number(slash[1]) === 0;
  const parts = c.match(/^(?:rgba?|hsla?)\(([^)]*)\)$/);
  if (!parts) return false;
  const values = parts[1].split(',');
  return values.length === 4 && Number(values[3].trim().replace('%', '')) === 0;
}

/**
 * The press a button gets from its resting face: 'fill' when it paints a
 * background, a border or a shadow, 'text' when it is only its label or icon.
 * `cs` is a CSSStyleDeclaration or anything shaped like one.
 */
export function classifyPress(cs) {
  if (!cs) return 'fill';
  if (!isClear(cs.backgroundColor)) return 'fill';
  if (cs.backgroundImage && cs.backgroundImage !== 'none') return 'fill';
  const bordered = ['Top', 'Right', 'Bottom', 'Left'].some((side) => (
    parseFloat(cs[`border${side}Width`]) > 0
    && cs[`border${side}Style`] && cs[`border${side}Style`] !== 'none'
    && !isClear(cs[`border${side}Color`])
  ));
  if (bordered) return 'fill';
  if (cs.boxShadow && cs.boxShadow !== 'none') return 'fill';
  return 'text';
}

/** Writes data-press-auto on the button a press landed in. Exported for the tests. */
export function markPress(target, win = typeof window !== 'undefined' ? window : null) {
  try {
    if (!target || typeof target.closest !== 'function' || !win) return null;
    const el = target.closest(PRESSABLE);
    if (!el || el.hasAttribute('data-press')) return null;
    if (OWN_PRESS.some((sel) => el.matches(sel))) return null;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
    const kind = classifyPress(win.getComputedStyle(el));
    if (el.getAttribute('data-press-auto') !== kind) el.setAttribute('data-press-auto', kind);
    return kind;
  } catch {
    return null;
  }
}

let installed = false;

/** Once, at boot (index.js). Safe to call again; safe without a document. */
export function installPress(doc = typeof document !== 'undefined' ? document : null) {
  if (installed || !doc || typeof doc.addEventListener !== 'function') return false;
  installed = true;
  const noop = () => {};
  doc.addEventListener('touchstart', noop, { passive: true, capture: true });
  doc.addEventListener('pointerdown', (e) => { markPress(e.target, doc.defaultView); }, { passive: true, capture: true });
  return true;
}

/** Test seam: forget that installPress ran. */
export function resetPressForTests() { installed = false; }
