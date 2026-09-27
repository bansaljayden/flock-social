/**
 * useEdgeSwipeBack - drag a drill-in screen off to the right to go back.
 *
 * WHY. Navigation here is one state value with no history, so WKWebView's own
 * back swipe has nothing to go back to, and nothing else answered a swipe from
 * the left edge. The only way out of a chat, a DM, a plan, Add Friends, Past
 * flocks or a settings page was a small arrow in the top left corner, the
 * hardest place on a large phone to reach with the hand holding it.
 *
 * WHAT IT DOES. A touch that starts within EDGE_PX of the screen's left edge
 * and then moves mostly sideways drags the screen with the finger, with a
 * transform only, so nothing is laid out again while it moves. Let go past a
 * third of the width, or flick faster than FLICK_PX_PER_MS, and the screen
 * slides the rest of the way and then the back handler runs, the SAME one the
 * arrow calls. Anything less springs back. A touch that turns out to be a
 * vertical scroll is let go at once and the list scrolls as it always did.
 *
 * THE DECISIONS THAT ARE NOT OBVIOUS.
 *
 * 1. Native shell only, by default. In mobile Safari a swipe from the left
 *    edge is the browser's own back, which would leave the app for whatever
 *    page came before it, and it cannot be cancelled from a page. The two
 *    gestures would both fire.
 *
 * 2. Every listener is passive and nothing calls preventDefault. A non-passive
 *    touchmove on the screen root would put every scroll of the message list
 *    behind the main thread. The root does not scroll sideways and the list
 *    only scrolls vertically, so a sideways drag has nothing to fight.
 *
 * 3. Not from a sheet. DialogBehavior marks every modal sheet role="dialog"
 *    and aria-modal="true", and a sheet's backdrop covers the screen, so a
 *    touch at the edge while one is open lands on it. A sheet is closed by
 *    its own controls; dragging the screen out from under it would take the
 *    sheet too. A sheet mounted outside the screen root never reaches these
 *    listeners at all.
 *
 * 4. The back handler runs after the slide, not before, and the transform is
 *    only cleared if the screen is still mounted a couple of frames later.
 *    Clearing it first would flash the screen back into place for a frame
 *    before React unmounts it.
 *
 * 5. The reply swipe on a message and the pin bar's swipe both ignore a touch
 *    that starts in the band (startsInEdgeBand), so the two gestures never
 *    compete for the same finger. The other way round, a control that is a
 *    sideways drag in its own right marks itself data-edge-swipe="off" and
 *    keeps its touches, which is the plan's slide to complete.
 *
 * 6. The global reduced-motion rule in index.css collapses the settle
 *    transition, so the screen follows the finger and then simply goes.
 */

import { useCallback, useLayoutEffect, useRef } from 'react';
import { isNativeShell } from '../lib/nativeShell';

/* The band, in CSS pixels from the left edge of the screen. iOS uses about
   the same for its own edge pan; wider starts stealing taps on the controls
   that sit against the edge, narrower misses thumbs. */
export const EDGE_PX = 20;
/* Travel before the drag decides whether it is sideways or a scroll. */
export const DECIDE_PX = 10;
/* Past this share of the width, a release goes back. */
export const COMMIT_FRACTION = 1 / 3;
/* A rightward flick at this speed goes back from any distance. */
export const FLICK_PX_PER_MS = 0.5;
/* The slide out, or the spring back, after the finger lifts. */
export const SETTLE_MS = 220;
const SETTLE_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

export const edgeSwipeAvailable = () => isNativeShell();

/** Does a touch at this x start the back gesture, and so belong to nothing
 *  else? For the message row and the pin bar, which have swipes of their own. */
export const startsInEdgeBand = (clientX) => (
  edgeSwipeAvailable() && typeof clientX === 'number' && clientX <= EDGE_PX
);

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/* Walks from the touched element up to the screen root, not past it. A sheet
   inside the screen is found by what DialogBehavior stamps on it (role dialog,
   aria-modal); asking the whole document instead would let a stale attribute
   on some other surface switch the gesture off everywhere, because
   DialogBehavior sets aria-modal and never takes it off again. */
const startsOnSheetOrOwnDrag = (target, root) => {
  for (let el = target; el && el !== root; el = el.parentElement) {
    if (!el.getAttribute) continue;
    if (el.getAttribute('data-edge-swipe') === 'off') return true;
    if (el.getAttribute('aria-modal') === 'true') return true;
    const role = el.getAttribute('role');
    if (role === 'dialog' || role === 'alertdialog') return true;
  }
  return false;
};

/**
 * Bind the gesture to one element. Returns the unbind. Exported so the
 * behaviour can be driven directly by a test with synthetic touches; `clock`
 * is there for the same reason, since a flick is a speed.
 */
export function bindEdgeSwipe(node, { onBack, isEnabled = () => true, clock = now } = {}) {
  if (!node || typeof node.addEventListener !== 'function') return () => {};

  let start = null;
  let dragging = false;
  let offset = 0;
  let velocity = 0;
  let last = null;
  let timer = null;

  const clearStyles = () => {
    node.style.transition = '';
    node.style.transform = '';
    node.style.willChange = '';
    node.style.boxShadow = '';
  };
  const place = (px, ms) => {
    node.style.transition = ms > 0 ? `transform ${ms}ms ${SETTLE_EASE}` : 'none';
    node.style.transform = `translate3d(${px}px, 0, 0)`;
  };
  const width = () => {
    const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
    return (rect && rect.width) || node.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0) || 375;
  };

  const onStart = (e) => {
    start = null;
    dragging = false;
    if (timer || !isEnabled()) return;
    const touches = e.touches;
    if (!touches || touches.length !== 1) return;
    const t = touches[0];
    const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : { left: 0 };
    if (t.clientX - (rect.left || 0) > EDGE_PX) return;
    // Decision 3, and 5 for a control that is itself a sideways drag, such as
    // the plan's slide to complete: either one keeps every touch that starts
    // on it.
    if (startsOnSheetOrOwnDrag(e.target, node)) return;
    start = { x: t.clientX, y: t.clientY };
    last = { x: t.clientX, t: clock() };
    offset = 0;
    velocity = 0;
  };

  const onMove = (e) => {
    if (!start) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (!dragging) {
      if (Math.abs(dy) > DECIDE_PX && Math.abs(dy) >= Math.abs(dx)) { start = null; return; }
      if (dx < DECIDE_PX || dx < Math.abs(dy)) return;
      dragging = true;
      node.style.willChange = 'transform';
      node.style.boxShadow = '-8px 0 24px rgba(0,0,0,0.18)';
    }
    const at = clock();
    const dt = at - last.t;
    if (dt > 0) velocity = (t.clientX - last.x) / dt;
    last = { x: t.clientX, t: at };
    offset = Math.max(0, dx - DECIDE_PX);
    place(offset, 0);
  };

  const settle = (goBack) => {
    const w = width();
    place(goBack ? w : 0, SETTLE_MS);
    timer = setTimeout(() => {
      timer = null;
      if (!goBack) { clearStyles(); return; }
      try { if (onBack) onBack(); } finally {
        // Decision 4: leave the screen where it went unless it is still here.
        const raf = typeof window !== 'undefined' && window.requestAnimationFrame
          ? window.requestAnimationFrame.bind(window)
          : (fn) => setTimeout(fn, 16);
        raf(() => raf(() => { if (node.isConnected) clearStyles(); }));
      }
    }, SETTLE_MS);
  };

  const onEnd = () => {
    if (!start) return;
    const was = dragging;
    start = null;
    dragging = false;
    if (!was) return;
    // A finger that stopped before it lifted has no flick left in it, however
    // fast it was moving earlier.
    const stillFor = clock() - last.t;
    const flicked = stillFor < 100 && velocity > FLICK_PX_PER_MS;
    const goBack = offset > width() * COMMIT_FRACTION || flicked;
    settle(goBack);
  };

  const onCancel = () => {
    if (!start) return;
    const was = dragging;
    start = null;
    dragging = false;
    if (was) settle(false);
  };

  const passive = { passive: true };
  node.addEventListener('touchstart', onStart, passive);
  node.addEventListener('touchmove', onMove, passive);
  node.addEventListener('touchend', onEnd, passive);
  node.addEventListener('touchcancel', onCancel, passive);
  return () => {
    node.removeEventListener('touchstart', onStart, passive);
    node.removeEventListener('touchmove', onMove, passive);
    node.removeEventListener('touchend', onEnd, passive);
    node.removeEventListener('touchcancel', onCancel, passive);
    if (timer) { clearTimeout(timer); timer = null; }
  };
}

/**
 * Returns a callback ref for the screen's root element. A callback ref rather
 * than a ref object because the settings pages swap their root element per
 * page, and each new root has to be bound as it mounts.
 *
 *   const edgeBack = useEdgeSwipeBack(goBack);
 *   <div ref={edgeBack} className="screen-enter" ...>
 */
export default function useEdgeSwipeBack(onBack, { enabled = edgeSwipeAvailable() } = {}) {
  // Synced after render, never during it, so a render that React throws away
  // cannot leave a handler from a screen that never committed.
  const onBackRef = useRef(onBack);
  const enabledRef = useRef(enabled);
  useLayoutEffect(() => {
    onBackRef.current = onBack;
    enabledRef.current = enabled;
  });
  const unbindRef = useRef(null);
  return useCallback((node) => {
    if (unbindRef.current) { unbindRef.current(); unbindRef.current = null; }
    if (!node) return;
    unbindRef.current = bindEdgeSwipe(node, {
      onBack: () => { if (onBackRef.current) onBackRef.current(); },
      isEnabled: () => !!enabledRef.current,
    });
  }, []);
}
