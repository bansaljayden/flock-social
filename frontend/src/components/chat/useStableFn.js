import React from 'react';

/**
 * STABLE IDENTITY, LATEST CLOSURE.
 *
 * MessageGroup and MessageRow are React.memo, and MessageGroup's header says
 * what that needs: memoised runs and stable callbacks. Every handler a chat
 * screen passes down used to be a fresh arrow, so the shallow compare failed
 * on every row, every render. Because the composer's draft lives in the
 * screen component, that meant a full re-render of the thread on each
 * keystroke.
 *
 * A plain useCallback would need a dep array over the thread, the search
 * state, the reply state and the viewer, and one missing entry is a stale
 * closure: a correctness bug traded for a speed win. This keeps the identity
 * fixed for the component's life and always calls the newest closure through
 * a ref, so there is nothing to get wrong. It is the useEvent RFC, in six
 * lines.
 *
 * useLayoutEffect, not useEffect: the ref must be current before any child
 * effect can fire the handler in the same commit.
 *
 * WHAT THAT DOES NOT COVER: a call made DURING RENDER. renderCard and
 * colourFor are called by MessageRow while it renders, and in the render
 * where a row first appears the ref still holds the previous render's
 * closure, because no layout effect has run yet. A render-time reader
 * therefore reads the row it is handed and never the screen's state; the
 * synthetic rows in the flock stream carry their card's data for exactly this
 * reason (search "EACH SYNTHETIC ROW" in screens/ChatDetail.js).
 *
 * WHY IT LIVES HERE RATHER THAN IN ChatDetail.js, where it was written.
 * DmDetail has the identical problem, so it imported this hook from the group
 * chat screen. Both screens are lazily loaded, and a cross-screen import makes
 * one chunk a hard dependency of the other's group: opening a DM could not
 * resolve until the group-chat chunk had arrived too, which is 146 KB raw for
 * eighteen lines of shared code. Avoiding a second copy of the hook was the
 * right call; hosting it inside the larger screen was what cost the bytes.
 * components/chat/groupRows.js set this precedent when the day separators
 * moved out of the same file for the same reason.
 */
export function useStableFn(fn) {
  const ref = React.useRef(fn);
  React.useLayoutEffect(() => { ref.current = fn; });
  return React.useCallback((...args) => ref.current(...args), []);
}

export default useStableFn;
