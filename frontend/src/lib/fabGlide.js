/**
 * THE FLOATING BUTTONS GLIDE TO THEIR CORNER AFTER A DRAG (2026-11-04).
 *
 * Birdie's button and SOS are dragged by a transform that follows the finger
 * (App.js handleFabPointerMove), with their transition switched off so the
 * button never lags behind. The release then picks a corner, and the snap was
 * meant to glide: .fab-corner in index.css carries a 0.4s spring on top,
 * bottom, left and right. It never played after a drag. The pointer down wrote
 * `transition: none` on the element and nothing wrote it back, so from the
 * first drag on, the button jumped to its corner on every release, and every
 * move the stylesheet should have animated (Birdie stepping aside when SOS is
 * dragged into its corner) jumped too.
 *
 * Handing the stylesheet back its transition is not enough on its own: a move
 * to another side swaps `left` for `right` (or `top` for `bottom`), a length to
 * `auto` does not interpolate, and the transform the drag drew is cleared in
 * the same instant, so the button would jump back to where the drag began and
 * only then move. So the release plays the snap as a transform instead: the
 * corner is committed with the transition still off, the button is drawn back
 * exactly where the finger let go of it, and that offset runs out to nothing
 * on .fab-corner's own curve and duration, so it settles from the drop point
 * into the corner and from the drag's 1.08 back to its own size. When it lands
 * the inline transition comes off, and the stylesheet's corner transition is
 * back for every move the button does not make itself.
 *
 * Reduced motion: no glide, the button is simply in its corner. The global
 * rule in index.css collapses transitions anyway; this skips the transform
 * altogether, the way hooks/useKeyboardComposer.js skips its slide.
 */

// .fab-corner's own transition in index.css. Pinned to it by
// __tests__/fabGlide.test.js, so the snap a drag plays and the one the
// stylesheet plays cannot drift apart.
export const FAB_GLIDE_MS = 400;
export const FAB_GLIDE_EASE = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

// Long enough past the glide that a missed transitionend (a tab in the
// background, a transform that never changed) still lands it.
const LANDING_SLACK_MS = 100;

// The landing each button is waiting on: its fallback timer and its listener.
const landings = new WeakMap();

const prefersReducedMotion = () => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (_) {
    return false;
  }
};

/**
 * Stops waiting on a glide that has not landed: its timer and listeners go,
 * and its styles are left to the caller. A drag that starts mid-glide calls
 * this first, so the landing can never switch the transition back on under
 * the finger.
 */
export function stopFabGlide(el) {
  const landing = el ? landings.get(el) : null;
  if (!landing) return;
  landings.delete(el);
  clearTimeout(landing.timer);
  el.removeEventListener('transitionend', landing.onEnd);
  el.removeEventListener('transitioncancel', landing.onEnd);
}

/**
 * Glides `el` from `from` (its box as drawn when the finger let go, the drag's
 * transform included) to where it rests now. Call it with the new corner
 * already in the DOM, the drag's transform cleared and the transition still
 * off. Whatever happens, `el` is left with no inline transition once it has
 * landed, so the stylesheet's corner transition applies again.
 */
export function glideFabHome(el, from) {
  if (!el || !el.style) return;
  stopFabGlide(el);
  const connected = el.isConnected !== false;
  // The resting box. Reading layout also commits the corner while the
  // transition is still off, so the stylesheet never plays the same move on
  // top of the glide.
  const to = connected ? el.getBoundingClientRect() : null;
  const box = (r) => r && Number.isFinite(r.left) && Number.isFinite(r.top) && Number.isFinite(r.width) && Number.isFinite(r.height);
  if (!box(from) || !box(to) || prefersReducedMotion()) {
    el.style.transition = '';
    return;
  }
  // Centre to centre, because the drag's scale grows the button about its
  // centre: drawn at this offset and this scale, it is exactly where it was
  // dropped.
  const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
  const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
  const scale = to.width > 0 && from.width > 0 ? from.width / to.width : 1;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(scale - 1) < 0.005) {
    el.style.transition = '';
    return;
  }
  el.style.transition = 'none';
  el.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
  // The start frame has to be committed before the transition goes on, or the
  // two writes are read as one and nothing moves.
  void el.offsetWidth;
  el.style.transition = `transform ${FAB_GLIDE_MS}ms ${FAB_GLIDE_EASE}`;
  el.style.transform = '';
  const land = () => {
    stopFabGlide(el);
    el.style.transition = '';
  };
  // Its own transform only: the disc inside has a press transition of its own,
  // and that event bubbles up here too.
  const onEnd = (ev) => {
    if (ev.target === el && (!ev.propertyName || ev.propertyName === 'transform')) land();
  };
  el.addEventListener('transitionend', onEnd);
  el.addEventListener('transitioncancel', onEnd);
  landings.set(el, { timer: setTimeout(land, FAB_GLIDE_MS + LANDING_SLACK_MS), onEnd });
}
