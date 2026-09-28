/**
 * useSheetDrag - pull a bottom sheet down by its grabber to close it.
 *
 * WHY. Five sheets drew an iOS grabber bar and none of them answered a pull:
 * a person who reached for it got nothing and had to go and find the X.
 * DESIGN-STANDARD.md lists swipe-down dismissal as convention 14. This makes the
 * grabber, and the header row next to it where a sheet has one, a real handle.
 *
 * WHAT IT DOES. Press on the handle and move down: the sheet follows the
 * finger with a transform only. Let go past DISMISS_PX, or flick down faster
 * than DISMISS_PX_PER_MS, and the sheet slides the rest of the way off and
 * then the sheet's own close runs, the same one its X and Escape call.
 * Anything less springs back. Moving up does nothing; a sheet does not open
 * further than it is.
 *
 * THE DECISIONS THAT ARE NOT OBVIOUS.
 *
 * 1. Pointer events, captured only once the drag has started. Capturing on
 *    press would retarget the release, and the click that follows it, to the
 *    handle, so the X in a header row would stop answering taps. Below
 *    DRAG_START_PX nothing is captured and a tap is a tap.
 *
 * 2. The handle needs `touch-action: none` (the `sheet-grab` class in
 *    index.css), or iOS treats the vertical move as a scroll and sends
 *    pointercancel before the sheet has moved.
 *
 * 3. `enabled` is read at the moment of the press. A sheet that refuses to
 *    close mid-request (the report sheet while it sends, the Pro sheet during
 *    a purchase) passes false and the handle is inert, the same rule its
 *    backdrop tap keeps.
 *
 * 4. The close runs after the slide, and the transform is only cleared if the
 *    sheet is still mounted a couple of frames later, so it never jumps back
 *    into view for a frame before React removes it.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/* Past this, a release closes the sheet. About a third of a short sheet. */
export const DISMISS_PX = 120;
/* A downward flick at this speed closes it from any distance. */
export const DISMISS_PX_PER_MS = 0.5;
/* Travel before a press becomes a drag (decision 1). */
export const DRAG_START_PX = 6;
/* The slide off, or the spring back, after the finger lifts. */
export const SETTLE_MS = 200;
const SETTLE_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

const perfNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

const clearStyles = (el) => {
  if (!el || !el.style) return;
  el.style.transition = '';
  el.style.transform = '';
  el.style.willChange = '';
};

export default function useSheetDrag(onClose, { enabled = true, sheetRef: given, clock = perfNow } = {}) {
  const ownRef = useRef(null);
  const sheetRef = given || ownRef;
  // Synced after render, never during it, so a render React throws away
  // cannot leave a close from a sheet that never committed.
  const onCloseRef = useRef(onClose);
  const enabledRef = useRef(enabled);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    enabledRef.current = enabled;
  });
  const drag = useRef(null);
  const timer = useRef(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onPointerDown = useCallback((e) => {
    drag.current = null;
    if (!enabledRef.current || timer.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const at = clock();
    drag.current = { id: e.pointerId, startY: e.clientY, lastY: e.clientY, lastT: at, v: 0, dy: 0, dragging: false, el: e.currentTarget };
  }, [clock]);

  const onPointerMove = useCallback((e) => {
    const s = drag.current;
    if (!s || e.pointerId !== s.id) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    const dy = e.clientY - s.startY;
    if (!s.dragging) {
      if (dy <= -DRAG_START_PX) { drag.current = null; return; }
      if (dy < DRAG_START_PX) return;
      s.dragging = true;
      try { if (s.el && s.el.setPointerCapture) s.el.setPointerCapture(e.pointerId); } catch (err) { /* already released */ }
      sheet.style.transition = 'none';
      sheet.style.willChange = 'transform';
    }
    const at = clock();
    const dt = at - s.lastT;
    if (dt > 0) s.v = (e.clientY - s.lastY) / dt;
    s.lastY = e.clientY;
    s.lastT = at;
    s.dy = Math.max(0, dy);
    sheet.style.transform = `translate3d(0, ${s.dy}px, 0)`;
  }, [clock, sheetRef]);

  const finish = useCallback((e, cancelled) => {
    const s = drag.current;
    if (!s || (e && e.pointerId !== s.id)) return;
    drag.current = null;
    if (!s.dragging) return;
    const sheet = sheetRef.current;
    if (!sheet) return;
    // A finger that stopped before lifting has no flick left in it.
    const flicked = clock() - s.lastT < 100 && s.v > DISMISS_PX_PER_MS;
    const close = !cancelled && enabledRef.current && (s.dy > DISMISS_PX || flicked);
    sheet.style.transition = `transform ${SETTLE_MS}ms ${SETTLE_EASE}`;
    sheet.style.transform = close ? 'translate3d(0, 100%, 0)' : 'translate3d(0, 0, 0)';
    timer.current = setTimeout(() => {
      timer.current = null;
      if (!close) { clearStyles(sheet); return; }
      try { if (onCloseRef.current) onCloseRef.current(); } finally {
        const raf = typeof window !== 'undefined' && window.requestAnimationFrame
          ? window.requestAnimationFrame.bind(window)
          : (fn) => setTimeout(fn, 16);
        raf(() => raf(() => { if (sheet.isConnected) clearStyles(sheet); }));
      }
    }, SETTLE_MS);
  }, [clock, sheetRef]);

  const onPointerUp = useCallback((e) => finish(e, false), [finish]);
  const onPointerCancel = useCallback((e) => finish(e, true), [finish]);

  return {
    sheetRef,
    handleProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
