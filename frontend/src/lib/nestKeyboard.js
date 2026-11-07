/**
 * THE KEYBOARD OVER THE NEST'S BIRDIE FIELD (2026-11-06).
 *
 * The WebView does not resize for the keyboard (capacitor.config.ts,
 * `resize: 'none'`), so a field near the bottom of the Nest's page would sit
 * under the keys. While Birdie's field on the Nest has focus, the page's
 * scroll box (marked data-nest-scroll) takes the class nest-kb-open, which
 * pads its end by --kb-inset (index.css), so there is room to scroll the field
 * up; once the keys are up, the field is brought to 12px above them. On blur
 * the padding goes. --kb-height is written onto <html> by
 * hooks/useKeyboardInset.js; in a browser it is 0 and this does nothing.
 *
 * DOM only, no React state: the field's focus must not re-render the app.
 */
export const NEST_KB_GAP = 12;
// Long enough for the keyboard's rise (KEYBOARD_SHOW_MS in
// hooks/useKeyboardComposer.js is 250).
const AFTER_KEYS_MS = 320;

const scrollerOf = (el) => (el && typeof el.closest === 'function' ? el.closest('[data-nest-scroll]') : null);

export function liftNestField(e) {
  const field = e && e.currentTarget;
  const box = scrollerOf(field);
  if (!box) return;
  box.classList.add('nest-kb-open');
  setTimeout(() => {
    let kb = 0;
    try { kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kb-height')) || 0; } catch (_) { kb = 0; }
    if (!kb || document.activeElement !== field) return;
    const limit = window.innerHeight - kb - NEST_KB_GAP;
    const bottom = field.getBoundingClientRect().bottom;
    if (bottom > limit) box.scrollTop += bottom - limit;
  }, AFTER_KEYS_MS);
}

export function dropNestField(e) {
  const box = scrollerOf(e && e.currentTarget);
  if (box) box.classList.remove('nest-kb-open');
}
