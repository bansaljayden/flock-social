/**
 * THE KEYBOARD'S CURVE AND TIMING, IN ONE SMALL MODULE.
 *
 * The values are the chat composer's (hooks/useKeyboardComposer.js), measured
 * off a capture of Snapchat and written down in CHAT-REBUILD-PLAN.md: the keys
 * rise over 250ms and settle over 200ms on one cubic-bezier. They used to be
 * declared in the composer hook itself, and anything else that wanted to move
 * with the keyboard had to import them from there.
 *
 * That was fine while only the two chat screens did, because both load the
 * hook anyway. Add Friends now moves its scroll box with the keys too
 * (hooks/useScrollBoxKeyboard.js), and Add Friends is a static import of the
 * app chunk, so reaching into the composer hook for three numbers would have
 * pulled the whole hook into the first download of every session. They live
 * here instead, and the composer hook re-exports them, so every existing
 * import of them from the hook keeps working.
 *
 * keyboardEaseAt is the same curve evaluated in JavaScript, for motion that is
 * driven frame by frame (a scroll position cannot be given a CSS transition).
 */

/* The curve's two control points, the one source for both forms below. */
const EASE_POINTS = [0.38, 0.7, 0.125, 1];

export const KEYBOARD_EASE = `cubic-bezier(${EASE_POINTS.join(', ')})`;
export const KEYBOARD_SHOW_MS = 250;
export const KEYBOARD_HIDE_MS = 200;

/* One coordinate of a cubic bezier from (0,0) to (1,1) with control values a
   and b, at parameter s. */
const bezier = (a, b, s) => {
  const r = 1 - s;
  return 3 * a * s * r * r + 3 * b * s * s * r + s * s * s;
};

/**
 * How far along the keyboard's curve a motion is at time fraction `t`, from 0
 * to 1. The curve is given as x (time) against y (progress), so the s that
 * lands on x = t is found first, by bisection: x rises steadily with s for
 * these control points, and thirty halvings are well under a pixel on any
 * screen.
 */
export const keyboardEaseAt = (t) => {
  if (!(t > 0)) return 0;
  if (t >= 1) return 1;
  const [x1, y1, x2, y2] = EASE_POINTS;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i += 1) {
    const mid = (lo + hi) / 2;
    if (bezier(x1, x2, mid) < t) lo = mid;
    else hi = mid;
  }
  return bezier(y1, y2, (lo + hi) / 2);
};
