/**
 * useKeyboardComposer - the dock that makes the composer ride the keyboard.
 *
 * WHAT THIS IS
 * The chat rebuild's keyboard lane (W3 in CHAT-REBUILD-PLAN.md). It owns the
 * one piece of motion the new chat is allowed to have: the message list and
 * the input bar rising with the keyboard and settling with no jump. Nothing
 * else in this hook animates.
 *
 * WHAT IT REPLACES
 * Nothing yet, because nothing did this. Today both chat screens leave the
 * composer wherever the WebView's own resize puts it, and both of them blur
 * the focused field inside their `onScroll` handler, so the keyboard closes
 * every time a message arrives and pushes the list. That blur is deleted by
 * `useBottomAnchor`, not here. This hook only moves things.
 *
 * THE DECISIONS BEHIND THE SURPRISING PARTS
 *
 * 1. The Capacitor Keyboard plugin is NOT installed. `@capacitor/keyboard` is
 *    absent from package.json on purpose: this file has to build and run today
 *    on the web, and light up on device the moment the plugin lands. So the
 *    plugin is reached two ways, neither of them a static import:
 *      a. `window.Capacitor.Plugins.Keyboard`, which is populated once any
 *         module has registered the plugin. Costs nothing and cannot fail.
 *      b. a dynamic `import()` whose specifier is BUILT AT RUNTIME and marked
 *         `webpackIgnore`. A literal `import('@capacitor/keyboard')` is
 *         resolved statically by webpack even inside a try/catch, so CRA's
 *         build would fail today with "Module not found". Splitting the
 *         specifier is what keeps the bundler out of it.
 *    Both are behind `Capacitor.isNativePlatform()`, so a browser never even
 *    attempts the import and the web path is zero risk.
 *
 * 2. The slide is an INLINE transform, not a CSS custom property. A transform
 *    driven by `var(--something)` does not reliably transition in WebKit: the
 *    custom property is not a registered animatable type, so the value jumps
 *    and the element teleports. The transform string is written straight onto
 *    the element's style, which is the one form WebKit always interpolates.
 *
 * 3. The height that arrives with `keyboardWillShow` is measured in POINTS
 *    from the bottom of the SCREEN, so it already contains the home indicator
 *    strip. The composer carries its own `var(--safe-bottom)` padding, so the
 *    distance anything actually has to move is `keyboardHeight - safeBottom`.
 *    Lifting by the raw height leaves a safe-area-sized gap above the keys.
 *
 * 4. After the slide the layout is SNAPPED once: the transform is cleared and
 *    the same number is published as `bottomInset` for the shell to apply as
 *    real layout. Between those two the list's scroll position is restored by
 *    the distance measured before the slide (`scrollHeight - scrollTop -
 *    clientHeight`), so the bottom of the conversation stays where the eye
 *    left it. The restore runs in a layout effect keyed on `bottomInset`, so
 *    it happens in the same frame the shell re-lays-out and before paint.
 *
 * 5. The caret is hidden for the duration. iOS draws the text caret natively,
 *    outside the compositor, so it does not ride a CSS transform: left visible
 *    it detaches from the field and slides on its own. `chatInput.css` carries
 *    the class.
 *
 * 6. The hide starts from the input's `focusout` as well as from
 *    `keyboardWillHide`. The native dismissal is already under way by the time
 *    the plugin event arrives, so waiting for it alone shows a bar hanging
 *    over a keyboard that is no longer there.
 *
 * 7. The emoji keyboard changes height WHILE OPEN, and iOS reports that as a
 *    second `keyboardWillShow`. Every move is therefore computed as a delta
 *    against the inset already committed, so a second show runs exactly the
 *    same choreography as the first.
 *
 * 10. A MOVE IS IDENTIFIED BY WHERE IT IS GOING, not by where the last one
 *    arrived. `insetRef` is only written at the END of a slide, so for the
 *    whole 250ms it still holds the old position, and a second event naming
 *    the place we are currently animating AWAY FROM used to compute a delta of
 *    zero and return early, leaving the stale timer to commit a number nobody
 *    wanted: a show cancelled by a focusout committed a 302px lift with no
 *    keyboard on screen, and a hide cancelled by a refocus dropped the
 *    composer behind a keyboard that was still up. `targetRef` holds the
 *    in-flight destination and is what the guard compares. Two consequences
 *    worth knowing before editing `moveTo`: the guard runs BEFORE the timer is
 *    cleared, so a duplicate show for a rise already in flight is a no-op
 *    rather than a cancellation with nothing left to commit it; and the delta
 *    can now legitimately be zero, which is a slide back to the committed
 *    position and not a reason to skip. Because a cancelled move commits an
 *    unchanged `bottomInset`, and React bails out of a render that changes
 *    nothing, the snap effect is keyed on a counter instead.
 *
 * 11. THE TEARDOWN NEEDS TWO FACTS, AND ONE HANDLE CANNOT CARRY BOTH. Whether
 *    the resize mode was changed, and whether the listeners are bound, are
 *    tracked separately from `pluginRef`. They were not: a failure to register
 *    the listeners nulled the plugin handle, which is the only thing that can
 *    set the mode back to 'native', so the app kept a WebView that no longer
 *    resized for anybody's keyboard until it was relaunched.
 *
 * 8. `dismissOnDrag` is a threshold, and that is an honest substitute rather
 *    than a shortcut. WebKit exposes no interactive keyboard dismissal to
 *    JavaScript: there is no way to drag the keyboard down with the finger the
 *    way a native scroll view can. What can be done is to notice the gesture
 *    that means it. The list has to be pinned to the bottom (within 2px, so it
 *    cannot scroll any further) and the finger has to have travelled more than
 *    24px downward. Then the field is blurred, which is the only lever there
 *    is.
 *
 * 9. `prefers-reduced-motion` snaps with no transition at all. The global rule
 *    in index.css already collapses transition durations, but this hook also
 *    skips the timer, so the layout commits on the same tick instead of a
 *    250ms wait for an animation that is not running.
 *
 * WHAT THE SHELL HAS TO DO WITH THIS
 *   const kb = useKeyboardComposer();
 *   <div style={{ paddingBottom: kb.bottomInset }}>       // committed layout
 *     <div ref={kb.registerList} onTouchStart={kb.dismissOnDrag}
 *          onTouchMove={kb.dismissOnDrag} onTouchEnd={kb.dismissOnDrag} />
 *     <ChatInputBar registerBar={kb.registerBar} registerInput={kb.registerInput} />
 *   </div>
 * `bottomInset` is the COMMITTED number and only changes at the snap, so it is
 * safe to lay out with. `keyboardHeight` changes the instant the event lands
 * and is for reading, not for layout. `kb.hideKeyboard()` is the one imperative
 * call: use it before opening anything that covers this screen.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/* The curve and the two durations are Snapchat's, measured off the capture and
   written down in CHAT-REBUILD-PLAN.md. They live here as JS constants and
   deliberately are NOT mirrored as CSS tokens: the transform is set inline, so
   a second copy in a stylesheet could only ever drift out of agreement with
   this one. */
export const KEYBOARD_EASE = 'cubic-bezier(0.38, 0.7, 0.125, 1)';
export const KEYBOARD_SHOW_MS = 250;
export const KEYBOARD_HIDE_MS = 200;

/* The list counts as "at the bottom" inside 2px. Anything looser and a thread
   resting one subpixel short of the end refuses to dismiss. */
export const BOTTOM_EPSILON = 2;

/* How far the finger has to travel down before a drag reads as "put the
   keyboard away". 24px is roughly a thumb's idle wobble plus a margin. */
export const DRAG_DISMISS_PX = 24;

/* Set by this hook on the focused field for the length of a slide. Defined in
   chatInput.css. */
export const CARET_HIDDEN_CLASS = 'chat-composer-caret-hidden';

const isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined';

const prefersReducedMotion = () => {
  if (!isBrowser() || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (err) {
    return false;
  }
};

/**
 * The home indicator strip, in CSS pixels, resolved rather than guessed.
 * `getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom')`
 * hands back the unresolved `env(...)` text in more than one WebView, so the
 * value is measured off a real element that has been asked to be that tall.
 */
const measureSafeBottom = () => {
  if (!isBrowser() || !document.body) return 0;
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:absolute;left:-9999px;top:0;width:0;visibility:hidden;pointer-events:none;padding-bottom:var(--safe-bottom, env(safe-area-inset-bottom, 0px));';
  document.body.appendChild(probe);
  let value = 0;
  try {
    value = parseFloat(window.getComputedStyle(probe).paddingBottom) || 0;
  } catch (err) {
    value = 0;
  }
  probe.remove();
  return value;
};

/**
 * The Keyboard plugin, or null when it is not there. See decision 1 above for
 * why neither branch is a static import.
 *
 * ONE LINE FOR THE INTEGRATION PASS. Once `@capacitor/keyboard` is actually in
 * package.json, the split specifier and the `webpackIgnore` comment can both
 * go and the line becomes `await import('@capacitor/keyboard')`, which webpack
 * then resolves into its own chunk. Leave them alone until the install lands:
 * a literal specifier for a package that is not there fails the CRA build with
 * "Module not found" even from inside this try/catch, because webpack resolves
 * it before any of this code runs.
 *
 * `@capacitor/core` is deliberately never imported here, statically or
 * dynamically. index.js relies on `window.Capacitor` being absent in the web
 * build to tell the marketing site from the native shell, and importing core
 * would define it.
 */
const loadKeyboardPlugin = async () => {
  if (!isBrowser()) return null;
  const cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null;
  if (cap.Plugins && cap.Plugins.Keyboard) return cap.Plugins.Keyboard;
  try {
    const specifier = ['@capacitor', 'keyboard'].join('/');
    const mod = await import(/* webpackIgnore: true */ specifier);
    if (!mod) return null;
    return mod.Keyboard || (mod.default && mod.default.Keyboard) || null;
  } catch (err) {
    /* The plugin is not installed yet. The visualViewport path below is the
       whole behaviour until it is. */
    return null;
  }
};

const applyLift = (el, px, ms) => {
  if (!el || !el.style) return;
  el.style.transition = ms > 0 ? `transform ${ms}ms ${KEYBOARD_EASE}` : 'none';
  el.style.transform = `translate3d(0, ${-px}px, 0)`;
  el.style.willChange = 'transform';
};

/**
 * Put the WebView's own keyboard resizing back. Called from the teardown and
 * from the cancelled-mount path, both of which can be the only one that runs.
 */
const restoreResizeMode = (Keyboard) => {
  if (!Keyboard || typeof Keyboard.setResizeMode !== 'function') return;
  try {
    const result = Keyboard.setResizeMode({ mode: 'native' });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (err) {
    /* Leaving the screen. A failed restore is not worth a crash. */
  }
};

const clearLift = (el) => {
  if (!el || !el.style) return;
  el.style.transition = 'none';
  el.style.transform = '';
  /* Read a layout property so the browser commits the untransformed position
     before the transition property is handed back. Without it the element
     animates from the snapped layout back to where it already is. */
  void el.offsetHeight;
  el.style.transition = '';
  el.style.willChange = '';
};

export default function useKeyboardComposer(options = {}) {
  const { enabled = true } = options;

  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [bottomInset, setBottomInset] = useState(0);
  const [transitioning, setTransitioning] = useState(false);
  /* Bumped once per commit and nothing else. See decision 10. */
  const [snapTick, setSnapTick] = useState(0);

  const listRef = useRef(null);
  const barRef = useRef(null);
  const inputRef = useRef(null);

  const safeBottomRef = useRef(0);
  const insetRef = useRef(0);
  /* Where the CURRENT slide is going, written the moment one is armed.
     `insetRef` is where the last one ARRIVED. Decision 10 is the difference. */
  const targetRef = useRef(0);
  const distanceRef = useRef(0);
  const timerRef = useRef(null);
  const pendingSnapRef = useRef(false);
  const pluginRef = useRef(null);
  /* Two facts the teardown needs and one handle cannot carry, see decision 11:
     whether this screen actually changed the WebView's resize mode, and whether
     the will-show and will-hide listeners are bound. */
  const resizeModeChangedRef = useRef(false);
  const eventsBoundRef = useRef(false);
  const dragStartRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    safeBottomRef.current = measureSafeBottom();
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const setCaretHidden = useCallback((hidden) => {
    const el = inputRef.current;
    if (!el || !el.classList) return;
    if (hidden) el.classList.add(CARET_HIDDEN_CLASS);
    else el.classList.remove(CARET_HIDDEN_CLASS);
  }, []);

  /**
   * One move, start to finish. `height` is the reported keyboard height in
   * points from the bottom of the screen. `instant` skips the transition, which
   * is what the visualViewport path wants: the browser is already animating the
   * viewport, so animating on top of it double-counts the motion.
   */
  const moveTo = useCallback((height, { hiding = false, instant = false } = {}) => {
    if (!mountedRef.current) return;
    const nextHeight = Math.max(0, Number(height) || 0);
    setKeyboardHeight(nextHeight);

    const target = Math.max(0, nextHeight - safeBottomRef.current);

    /* Decision 10, and the ORDER of these two lines is the whole of it.
       A slide already heading for this exact place is left alone: iOS delivers
       keyboardWillShow twice for one rise often enough that cancelling the
       first timer on the second event would strand the lift with nothing left
       to commit it. Anything else cancels the slide in flight. */
    if (target === targetRef.current) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    targetRef.current = target;

    const ms = instant || prefersReducedMotion() ? 0 : hiding ? KEYBOARD_HIDE_MS : KEYBOARD_SHOW_MS;

    /* Measured BEFORE anything moves. This is the number the restore puts back
       after the snap, and it is the whole reason the bottom of the thread does
       not jump. */
    const list = listRef.current;
    distanceRef.current = list ? list.scrollHeight - list.scrollTop - list.clientHeight : 0;

    /* Measured against the COMMITTED inset, not the cancelled target, because
       `applyLift` overwrites the transform rather than adding to it. A slide
       cancelled back to the place it started from therefore has a delta of
       zero, which is correct: it animates the element back to translate3d(0)
       and off whatever displacement the cancelled slide had reached. */
    const delta = target - insetRef.current;

    if (ms > 0) {
      setCaretHidden(true);
      setTransitioning(true);
      applyLift(barRef.current, delta, ms);
      applyLift(listRef.current, delta, ms);
    }

    const commit = () => {
      timerRef.current = null;
      if (!mountedRef.current) return;
      pendingSnapRef.current = true;
      insetRef.current = target;
      setBottomInset(target);
      /* The snap effect is keyed on this counter and not on `bottomInset`.
         A cancelled slide commits the number that was already there, React
         bails out of a render that changes nothing, and an effect keyed on the
         inset would never run: the transform would stay applied, the caret
         would stay hidden, and `transitioning` would stay true for the rest of
         the session. The counter always changes, so the snap always runs. */
      setSnapTick((t) => t + 1);
    };

    if (ms > 0) timerRef.current = setTimeout(commit, ms);
    else commit();
  }, [setCaretHidden]);

  /* The snap. Keyed on `snapTick` rather than on `bottomInset` (decision 10),
     but still runs in the same commit the shell applies `bottomInset` in,
     because both are set together: the transform comes off and the scroll goes
     back before the browser has painted either. */
  useLayoutEffect(() => {
    if (!pendingSnapRef.current) return;
    pendingSnapRef.current = false;

    clearLift(barRef.current);
    clearLift(listRef.current);

    const list = listRef.current;
    if (list) {
      const target = list.scrollHeight - list.clientHeight - distanceRef.current;
      list.scrollTop = Math.max(0, target);
    }

    setCaretHidden(false);
    setTransitioning(false);
  }, [snapTick, setCaretHidden]);

  /* One read of where the keyboard IS, for the two moments no event covers:
     the mount itself, and the instant the plugin listeners finish binding.
     CHAT-REBUILD-PLAN.md's settled decision 4 makes "already up when the chat
     opens" the normal opening state, so the will-show for the rise that opened
     this screen has usually fired before anything was listening and nothing
     else is coming. `moveTo` ignores a target that is already committed or
     already in flight, so a listener that binds late cannot apply this a
     second time. */
  const readViewport = useCallback(() => {
    if (!isBrowser()) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const height = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    moveTo(height, { hiding: height === 0, instant: true });
  }, [moveTo]);

  /* ---------------------------------------------------------------- *
   * Device path: the Capacitor Keyboard plugin.
   * ---------------------------------------------------------------- */
  useEffect(() => {
    if (!enabled || !isBrowser()) return undefined;
    let cancelled = false;
    const handles = [];

    (async () => {
      const Keyboard = await loadKeyboardPlugin();
      if (!Keyboard || cancelled) return;
      pluginRef.current = Keyboard;

      /* The chat screens own their own layout, so the WebView must not resize
         itself underneath them. App-wide the mode stays 'native'; this is the
         one screen that turns it off, and it is put back on the way out. */
      try {
        if (typeof Keyboard.setResizeMode === 'function') {
          await Keyboard.setResizeMode({ mode: 'none' });
          resizeModeChangedRef.current = true;
        }
      } catch (err) {
        /* An older plugin build without setResizeMode still delivers the
           events, which is the part that matters. */
      }

      if (cancelled) {
        /* The screen left while that bridge call was in flight, so the cleanup
           below has already run and found nothing to put back. Put it back
           here instead, or the whole app keeps a WebView that no longer
           resizes for anyone's keyboard. */
        if (resizeModeChangedRef.current) {
          resizeModeChangedRef.current = false;
          restoreResizeMode(Keyboard);
        }
        return;
      }

      try {
        const show = await Keyboard.addListener('keyboardWillShow', (info) => {
          moveTo(info && info.keyboardHeight, { hiding: false });
        });
        const hide = await Keyboard.addListener('keyboardWillHide', () => {
          moveTo(0, { hiding: true });
        });
        if (cancelled) {
          if (show && show.remove) show.remove();
          if (hide && hide.remove) hide.remove();
          if (resizeModeChangedRef.current) {
            resizeModeChangedRef.current = false;
            restoreResizeMode(Keyboard);
          }
          return;
        }
        handles.push(show, hide);
        eventsBoundRef.current = true;
        /* Three bridge round trips have been awaited since mount, so the rise
           that opened this screen is already over and no will-show is left to
           hear. Read the state instead of waiting for the next event. */
        readViewport();
      } catch (err) {
        /* Decision 11. Registration failed, so this screen falls back to the
           visualViewport path, but `pluginRef` is NOT nulled: it is the only
           handle the teardown has for putting the resize mode back, and mode
           'none' has already been set by the time we get here. Nulling it left
           every other screen in the app without a resizing keyboard for the
           rest of the session. */
        eventsBoundRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
      handles.forEach((h) => {
        try {
          if (h && typeof h.remove === 'function') h.remove();
        } catch (err) {
          /* A handle whose bridge has already gone. Nothing to undo. */
        }
      });
      eventsBoundRef.current = false;
      const Keyboard = pluginRef.current;
      pluginRef.current = null;
      if (resizeModeChangedRef.current) {
        resizeModeChangedRef.current = false;
        restoreResizeMode(Keyboard);
      }
    };
  }, [enabled, moveTo, readViewport]);

  /* ---------------------------------------------------------------- *
   * Web path: visualViewport. This is the whole behaviour until the plugin
   * is installed, and it stays as the fallback afterwards for anyone reading
   * the app in a browser.
   * ---------------------------------------------------------------- */
  useEffect(() => {
    if (!enabled || !isBrowser()) return undefined;
    const vv = window.visualViewport;
    if (!vv) return undefined;

    let frame = 0;
    const read = () => {
      frame = 0;
      /* The plugin gives a will-show event ahead of the motion, which is
         strictly better, so it wins whenever it is LISTENING. A plugin handle
         that is present but whose listeners never bound is not driving
         anything, and gating on the handle alone left this screen with no
         keyboard behaviour at all in that case. */
      if (eventsBoundRef.current) return;
      readViewport();
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(read);
    };

    vv.addEventListener('resize', schedule);
    vv.addEventListener('scroll', schedule);
    /* A bound listener only hears the NEXT change, and on this screen the
       change that matters has usually already happened. Read once, through the
       same guard the events use. */
    read();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      vv.removeEventListener('resize', schedule);
      vv.removeEventListener('scroll', schedule);
    };
  }, [enabled, readViewport]);

  const hideKeyboard = useCallback(() => {
    const el = inputRef.current;
    if (el && typeof el.blur === 'function') el.blur();
    const Keyboard = pluginRef.current;
    if (Keyboard && typeof Keyboard.hide === 'function') {
      try {
        const result = Keyboard.hide();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (err) {
        /* The blur above is the part that actually closes it. */
      }
    }
  }, []);

  const handleFocusOut = useCallback(() => {
    /* Decision 6. The native dismissal has already started, so the slide down
       starts here rather than waiting for keyboardWillHide. If the keyboard is
       in fact staying up (focus moved to another field), the next
       keyboardWillShow puts it straight back with the same choreography. */
    moveTo(0, { hiding: true });
  }, [moveTo]);

  const registerList = useCallback((el) => {
    listRef.current = el || null;
  }, []);

  const registerBar = useCallback((el) => {
    barRef.current = el || null;
  }, []);

  const registerInput = useCallback((el) => {
    const previous = inputRef.current;
    if (previous === el) return;
    if (previous && typeof previous.removeEventListener === 'function') {
      previous.removeEventListener('focusout', handleFocusOut);
    }
    inputRef.current = el || null;
    if (el && typeof el.addEventListener === 'function') {
      el.addEventListener('focusout', handleFocusOut);
    }
  }, [handleFocusOut]);

  useEffect(() => () => {
    const el = inputRef.current;
    if (el && typeof el.removeEventListener === 'function') {
      el.removeEventListener('focusout', handleFocusOut);
    }
  }, [handleFocusOut]);

  /**
   * Decision 8. Spread onto the list's touch handlers:
   *   onTouchStart / onTouchMove / onTouchEnd (or the pointer equivalents).
   * Returns true only on the call that actually dismissed.
   */
  const dismissOnDrag = useCallback((event) => {
    if (!event) return false;
    const type = event.type;
    const touch =
      (event.touches && event.touches[0]) ||
      (event.changedTouches && event.changedTouches[0]) ||
      event;
    const y = touch && typeof touch.clientY === 'number' ? touch.clientY : null;

    if (type === 'touchstart' || type === 'pointerdown' || type === 'mousedown') {
      dragStartRef.current = y;
      return false;
    }
    if (
      type === 'touchend' || type === 'touchcancel' ||
      type === 'pointerup' || type === 'pointercancel' || type === 'mouseup'
    ) {
      dragStartRef.current = null;
      return false;
    }
    if (dragStartRef.current == null || y == null) return false;
    if (y - dragStartRef.current <= DRAG_DISMISS_PX) return false;

    const list = listRef.current;
    if (!list) return false;
    const fromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (fromBottom > BOTTOM_EPSILON) return false;

    dragStartRef.current = null;
    hideKeyboard();
    return true;
  }, [hideKeyboard]);

  return {
    keyboardHeight,
    transitioning,
    bottomInset,
    dismissOnDrag,
    /* The shell needs this as much as the drag does: the "+" sheet, the flock
       profile sheet, the long-press menu and the photo viewer all open over
       this screen, and the parent cannot put the keyboard down by itself
       because the plugin handle never leaves this hook. */
    hideKeyboard,
    registerList,
    registerBar,
    registerInput,
  };
}
