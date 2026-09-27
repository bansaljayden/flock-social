/**
 * useKeyboardInset - tells every bottom sheet how tall the keyboard is.
 *
 * WHY THIS EXISTS. capacitor.config.ts sets the Keyboard plugin to
 * `resize: 'none'` for the whole app. In that mode the plugin moves nothing,
 * and it also removes WKWebView's own keyboard observers, so WebKit cannot
 * scroll a covered field into view either. The chat composer has its own dock
 * (useKeyboardComposer), and the sign-in screens pad themselves in AuthShell.
 * Everything else with a field near the bottom of the screen was left under
 * the keys: Birdie's box, the budget and bill amounts, the invite search, the
 * New Message search and the report sheet's details. People typed blind, or put
 * the keyboard away to reach Submit.
 *
 * WHAT IT DOES. The plugin fires `keyboardWillShow` on window with the height
 * in points from the bottom of the screen (Keyboard.m), and `keyboardWillHide`
 * with none. This hook writes that height onto <html> as `--kb-height`, and
 * index.css derives `--kb-inset` from it: the height less the home indicator
 * strip, never below zero. A sheet already pads its own bottom by
 * var(--safe-bottom), so the inset is the distance it actually has to rise,
 * the same arithmetic as decision 3 in useKeyboardComposer. The `.kb-lift`
 * class puts that inset under a bottom-anchored backdrop, and the flex-end
 * sheet inside rides up with it.
 *
 * WHY WINDOW EVENTS AND NOT addListener. The composer hook binds through the
 * plugin object, which means loading it. This hook is mounted once in the shell
 * and runs on every screen, so it listens for the events the native bridge
 * already dispatches on window, which costs nothing and needs no import. In a
 * browser nothing dispatches them, the variable is never written, and every
 * `var(--kb-height, 0px)` falls back to zero: the web build is untouched.
 *
 * WHY THE HIDE IS HEARD TWICE. `keyboardWillHide` is the one that starts the
 * sheet down with the keys. `keyboardDidHide` is a backstop: a will-hide that
 * lands while the app is going to the background can be dropped, and a stale
 * height would leave a sheet floating a keyboard's height up with nothing
 * under it.
 */

import { useEffect } from 'react';

export const KB_HEIGHT_VAR = '--kb-height';

/** The height carried by a plugin event, in whole CSS pixels, or 0. The bridge
 *  copies the event data onto the event object itself, so it is
 *  `event.keyboardHeight`, not `event.detail`. */
export const keyboardHeightFromEvent = (event) => {
  const raw = event && (event.keyboardHeight != null
    ? event.keyboardHeight
    : event.detail && event.detail.keyboardHeight);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

export default function useKeyboardInset() {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    const root = document.documentElement;
    if (!root || !root.style) return undefined;

    const write = (px) => {
      root.style.setProperty(KB_HEIGHT_VAR, `${px}px`);
    };
    const onShow = (event) => write(keyboardHeightFromEvent(event));
    const onHide = () => write(0);

    window.addEventListener('keyboardWillShow', onShow);
    window.addEventListener('keyboardWillHide', onHide);
    window.addEventListener('keyboardDidHide', onHide);
    return () => {
      window.removeEventListener('keyboardWillShow', onShow);
      window.removeEventListener('keyboardWillHide', onHide);
      window.removeEventListener('keyboardDidHide', onHide);
      root.style.removeProperty(KB_HEIGHT_VAR);
    };
  }, []);
}
