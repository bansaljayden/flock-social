/**
 * useScrollBoxKeyboard - keeps the field being typed in, and what it answers
 * with, above the keyboard, in a screen whose content is one scroll box.
 *
 * WHY THIS EXISTS. capacitor.config.ts sets the keyboard plugin to
 * `resize: 'none'` for the whole app. The WebView then never shrinks for the
 * keys, and the plugin removes WKWebView's own keyboard observers, so WebKit
 * cannot scroll a covered field into view either. Sheets rise with `.kb-lift`
 * (hooks/useKeyboardInset.js) and the chat composer has its own dock
 * (useKeyboardComposer.js), but a full screen with fields in an ordinary
 * scroll box had nothing: on Add Friends the friend code and phone fields sat
 * under the keys with no scroll left to free them, search results landed
 * under the keys, and the phone pad, which has no Return key, could not be
 * put away at all.
 *
 * WHAT IT DOES, on the plugin's own window events (the ones useKeyboardInset
 * already hears), and with no React state, so a focus never re-renders the
 * screen:
 *
 *   1. keyboardWillShow, with a field inside the box focused: the box gains
 *      room at its end (the spacer element passed in, the box's last child) so
 *      it can scroll far enough, and the field's REGION is brought into view
 *      over the keyboard's own 250ms on its own curve, so it rises with the
 *      keys rather than after them. The region is the field's nearest
 *      ancestor marked data-kb-keep (the field, its button and its answer), or
 *      the field alone:
 *        data-kb-keep="top"  the region goes to 8px under the box's top, once
 *                            per focus. For a search field: its results get
 *                            the room under it.
 *        data-kb-keep        the region's bottom goes to 12px above the keys,
 *                            and never further than would push its top out of
 *                            the box (then the field's own bottom is used). A
 *                            shorter keyboard never scrolls anything down.
 *      The room only grows while the keys are up. iOS sends another show each
 *      time the QuickType bar or the emoji keyboard changes the height, and a
 *      room that shrank under the scroll position would clamp it.
 *   2. Focus moving to another field while the keys are up: the same, at the
 *      height already known.
 *   3. keyboardWillHide (keyboardDidHide is a backstop, as it is in
 *      useKeyboardInset): the room collapses over the keyboard's 200ms, so the
 *      content slides down with the keys instead of jumping in one frame.
 *   4. A drag of more than 10px in the box blurs the field, unless the touch
 *      began on the field itself, like a native scroll view's dismiss on drag.
 *      It has to be the touch: the lift itself scrolls the box, so a blur on
 *      scroll would close the very keys it was answering.
 *   5. A tap on blank space in the box (not a field, a button, a link or a
 *      label) blurs the field.
 *
 * In a browser no plugin event fires: the room stays 0, nothing moves, and
 * the browser keeps its own way of showing a focused field.
 *
 * revealInBox is the other half, for an answer that lands after the field was
 * put away (Look up's result): it scrolls the box by hand so the element ends
 * above the keys, or above the box's own bottom padding when they are down.
 * Not scrollIntoView, which can also scroll the overflow-hidden shell
 * containers above the box.
 *
 *   const box = useRef(null);
 *   const room = useRef(null);
 *   useScrollBoxKeyboard(box, room);
 *   <div ref={box} style={{ overflowY: 'auto' }}>
 *     ...content, with data-kb-keep on each field's region...
 *     <div ref={room} aria-hidden="true" />   // last child, and no style prop
 *   </div>
 *
 * The room element must carry no style prop: React would put its height back
 * on the next render and drop the scroll position.
 */
import { useEffect } from 'react';
import { keyboardHeightFromEvent } from './useKeyboardInset';
import { KEYBOARD_EASE, KEYBOARD_HIDE_MS, KEYBOARD_SHOW_MS, keyboardEaseAt } from '../lib/keyboardMotion';

/** Room left between a lifted region and the top of the keys. */
export const KEYS_GAP = 12;
/** Where a data-kb-keep="top" region lands under the top of the box. */
export const TOP_GAP = 8;
/** A drag longer than this, in the box, puts the keys away. */
export const DRAG_BLUR_PX = 10;

const NOT_TEXT = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit']);

/** A control that raises the keyboard when it has focus. */
export const isTextField = (el) => {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return !NOT_TEXT.has(String(el.getAttribute('type') || 'text').toLowerCase());
  return el.isContentEditable === true;
};

/* What a tap may land on without putting the keys away. */
const KEEPS_KEYS = 'input, textarea, select, button, a, label, [role="button"], [role="link"], [role="switch"], [role="tab"], [contenteditable=""], [contenteditable="true"]';

const prefersReducedMotion = () => {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (err) {
    return false;
  }
};

const px = (value) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

const bottomPadding = (box) => {
  try {
    return px(window.getComputedStyle(box).paddingBottom);
  } catch (err) {
    return 0;
  }
};

const clampScroll = (box, value) => Math.max(0, Math.min(value, box.scrollHeight - box.clientHeight));

/* The keyboard's height as useKeyboardInset last wrote it, or 0. */
const keyboardHeightNow = () => {
  try {
    const root = document.documentElement;
    return px(root.style.getPropertyValue('--kb-height')) || px(window.getComputedStyle(root).getPropertyValue('--kb-height'));
  } catch (err) {
    return 0;
  }
};

/**
 * Scroll `box` so `el` ends `gap` px above the keys, or above the box's bottom
 * padding while they are down. Its top is never pushed out of the box, and a
 * box that cannot scroll that far scrolls as far as it can.
 */
export function revealInBox(box, el, gap = KEYS_GAP) {
  if (!box || !el || typeof window === 'undefined') return;
  const kb = keyboardHeightNow();
  const boxRect = box.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const floor = boxRect.bottom - bottomPadding(box);
  const limit = (kb > 0 ? Math.min(floor, window.innerHeight - kb) : floor) - gap;
  if (rect.bottom <= limit) return;
  const headroom = rect.top - (boxRect.top + gap);
  const delta = Math.min(rect.bottom - limit, Math.max(0, headroom));
  if (delta <= 0) return;
  box.scrollTop = clampScroll(box, box.scrollTop + delta);
}

export default function useScrollBoxKeyboard(boxRef, spacerRef) {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;

    let keys = 0;          // the keyboard's height while it is up, else 0
    let liftedFor = null;  // the field a "top" region has been lifted for
    let frame = 0;         // the lift's animation frame, while it runs
    let drag = null;       // where the touch that is down began
    let sized = null;      // the room element this hook last gave a height

    const stopLift = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
    };

    const focusedField = () => {
      const box = boxRef.current;
      const el = document.activeElement;
      return box && isTextField(el) && box.contains(el) ? el : null;
    };

    const spacerHeight = (spacer) => px(spacer.style.height);

    /* Room at the end of the box: enough to scroll `target` into reach, and
       enough for the end of the content to clear the keys. Never less than it
       already has while the keys are up. Where the content ends is read off
       the room element itself (its top, in the box's own coordinates), not off
       scrollHeight, which cannot say how tall the content is when it is
       shorter than the box: the QR code tab is, and the code box came up a
       pixel short of its line. */
    const makeRoom = (box, spacer, keysTop, target) => {
      const current = spacerHeight(spacer);
      const boxRect = box.getBoundingClientRect();
      const pad = bottomPadding(box);
      const forTheEnd = boxRect.bottom - pad - keysTop + KEYS_GAP;
      const contentEnd = spacer.getBoundingClientRect().top - boxRect.top + box.scrollTop;
      const forTarget = target - (contentEnd + pad - box.clientHeight);
      const room = Math.ceil(Math.max(current, forTheEnd, forTarget, 0));
      if (room !== current) {
        spacer.style.transition = 'none';
        spacer.style.height = `${room}px`;
        sized = spacer;
      }
    };

    const scrollTo = (box, to) => {
      stopLift();
      const from = box.scrollTop;
      if (Math.abs(to - from) < 1) return;
      if (prefersReducedMotion() || typeof window.requestAnimationFrame !== 'function') {
        box.scrollTop = to;
        return;
      }
      let start = null;
      const step = (now) => {
        if (start === null) start = now;
        const t = Math.min(1, (now - start) / KEYBOARD_SHOW_MS);
        box.scrollTop = from + (to - from) * keyboardEaseAt(t);
        frame = t < 1 ? window.requestAnimationFrame(step) : 0;
      };
      frame = window.requestAnimationFrame(step);
    };

    /* How far the region has to move, in the layout as it stands now. */
    const deltaFor = (box, field, region, toTop, keysTop) => {
      const boxRect = box.getBoundingClientRect();
      const rect = region.getBoundingClientRect();
      if (toTop) {
        if (liftedFor === field) return 0;
        const d = rect.top - (boxRect.top + TOP_GAP);
        // Already at the top (a sticky field sits there): leave it.
        return d < 0 && rect.top >= boxRect.top ? 0 : d;
      }
      let d = rect.bottom - (keysTop - KEYS_GAP);
      if (rect.top - d < boxRect.top + TOP_GAP) {
        d = field.getBoundingClientRect().bottom - (keysTop - KEYS_GAP);
      }
      // Whole points, rounded up, so a region on a fractional position ends
      // on or above its line rather than a fraction under it.
      return d > 0 ? Math.ceil(d) : 0;
    };

    const lift = () => {
      const box = boxRef.current;
      const spacer = spacerRef.current;
      const field = focusedField();
      if (!box || !spacer || !field || keys <= 0) return;
      const keep = field.closest('[data-kb-keep]');
      const region = keep && box.contains(keep) ? keep : field;
      const toTop = region.getAttribute('data-kb-keep') === 'top';
      const keysTop = window.innerHeight - keys;
      makeRoom(box, spacer, keysTop, box.scrollTop + deltaFor(box, field, region, toTop, keysTop));
      // Measured again in the layout the room made, before anything moves.
      // Growing the room can reflow what sits above the region: a box that
      // starts to scroll gains a classic scrollbar in a desktop engine, the
      // column narrows and a card wraps one more line, which left the phone
      // field 20pt under the keys in WebKit for Windows. iOS draws its
      // scrollbar over the content, but nothing here should depend on that.
      const delta = deltaFor(box, field, region, toTop, keysTop);
      const target = box.scrollTop + delta;
      makeRoom(box, spacer, keysTop, target);
      liftedFor = field;
      if (delta !== 0) scrollTo(box, clampScroll(box, target));
    };

    const onShow = (event) => {
      const height = keyboardHeightFromEvent(event);
      if (!height) return;
      keys = height;
      lift();
    };

    const onHide = () => {
      keys = 0;
      liftedFor = null;
      drag = null;
      stopLift();
      const spacer = spacerRef.current;
      if (!spacer || spacerHeight(spacer) === 0) return;
      spacer.style.transition = prefersReducedMotion() ? 'none' : `height ${KEYBOARD_HIDE_MS}ms ${KEYBOARD_EASE}`;
      spacer.style.height = '0px';
    };

    const inBox = (target) => {
      const box = boxRef.current;
      return !!(box && target && box.contains(target));
    };

    const onFocusIn = (event) => {
      if (keys > 0 && inBox(event.target)) lift();
    };

    const onTouchStart = (event) => {
      // The person has taken over: a lift still running stops where it is.
      stopLift();
      const touch = event.touches && event.touches[0];
      if (!touch || !inBox(event.target)) { drag = null; return; }
      const field = focusedField();
      drag = { y: touch.clientY, onField: !!(field && (field === event.target || field.contains(event.target))) };
    };

    const onTouchMove = (event) => {
      if (!drag || drag.onField || keys <= 0) return;
      const touch = event.touches && event.touches[0];
      if (!touch || Math.abs(touch.clientY - drag.y) <= DRAG_BLUR_PX) return;
      drag = null;
      const field = focusedField();
      if (field) field.blur();
    };

    const onTouchEnd = () => { drag = null; };

    const onClick = (event) => {
      if (keys <= 0 || !inBox(event.target)) return;
      const target = event.target;
      if (target.closest && target.closest(KEEPS_KEYS)) return;
      const field = focusedField();
      if (field) field.blur();
    };

    const passive = { passive: true };
    window.addEventListener('keyboardWillShow', onShow);
    window.addEventListener('keyboardWillHide', onHide);
    window.addEventListener('keyboardDidHide', onHide);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('touchstart', onTouchStart, passive);
    document.addEventListener('touchmove', onTouchMove, passive);
    document.addEventListener('touchend', onTouchEnd, passive);
    document.addEventListener('touchcancel', onTouchEnd, passive);
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keyboardWillShow', onShow);
      window.removeEventListener('keyboardWillHide', onHide);
      window.removeEventListener('keyboardDidHide', onHide);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('touchstart', onTouchStart, passive);
      document.removeEventListener('touchmove', onTouchMove, passive);
      document.removeEventListener('touchend', onTouchEnd, passive);
      document.removeEventListener('touchcancel', onTouchEnd, passive);
      document.removeEventListener('click', onClick);
      stopLift();
      if (sized) {
        sized.style.transition = 'none';
        sized.style.height = '0px';
      }
    };
  }, [boxRef, spacerRef]);
}
