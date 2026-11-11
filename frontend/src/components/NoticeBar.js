import React, { useLayoutEffect, useRef } from 'react';

/*
 * THE NOTICE AT THE TOP OF THE APP TAKES ROOM INSTEAD OF COVERING THE SCREEN.
 *
 * App.js shows one sentence in a bar across the top: what happened to the
 * confirmation link that was just opened, why the session ended, what a venue
 * tap or an invitation link needs before it can go on. The bar is fixed at
 * top: 0, above the screen, and it used to sit OVER whatever the screen had
 * there. Measured in a 390 x 664 browser, one line of notice is 45px tall and
 * two lines are 67px:
 *
 *   - signed out, the bird mark on the sign-in screen is at 22 to 68px, so one
 *     line covered the top of it and two lines covered all of it;
 *   - signed in, the Nest's "Hey, <name>" heading is at 33 to 56px, so one
 *     line covered half of it and two lines all of it, along with the profile
 *     button beside it; on Discover the search field was under the bar;
 *   - a toast, which lands at 50px, lost its top 17px under a two-line notice.
 *
 * In the iOS app the bar is taller by the status bar and the sign-in screen
 * only allowed for the status bar, so the session, venue-tap and invitation
 * sentences covered the top of the mark there too.
 *
 * Dismiss takes the bar away, so nothing was out of reach for good. But a
 * person who arrives from a confirmation link reads the page before they
 * dismiss anything, and the page they read had its top missing.
 *
 * THE FIX IS ONE NUMBER. While the bar is up it publishes its own measured
 * height on <html> as --notice-h, and removes it when it goes. index.css folds
 * that into --safe-top, the token every screen already pads its top by to
 * clear the iPhone's status bar (the SAFE-AREA CONTRACT block there). So the
 * shell's top spacer, the sign-in screens, the full-screen overlays and the
 * error card all start below the bar without a change to any of them, and
 * move back the moment it is dismissed.
 *
 * TWO THINGS THAT HAVE TO STAY TRUE:
 *
 *   1. The bar pads ITS OWN top by --device-top, the status bar alone, and
 *      never by --safe-top. --safe-top contains this bar's height, so padding
 *      by it would make the bar taller by its own height each time it measured
 *      itself.
 *   2. The height it publishes already includes that status-bar padding, which
 *      is why index.css takes the larger of the two with max() and does not
 *      add them. Adding would count the status bar twice.
 *
 * WHEN IT MEASURES. After every render, because the sentence is the one thing
 * that changes the height from inside React (a longer sentence wraps to a
 * second line). And when the bar's box changes for a reason React never hears
 * about: the window's width, a phone turned on its side, the web font arriving.
 * Both in layout effects, so the first frame that is painted already has the
 * room and the screen under the bar does not jump.
 */
export const NOTICE_HEIGHT_VAR = '--notice-h';

function publishHeight(el) {
  if (!el) return;
  const height = el.getBoundingClientRect().height;
  // A bar with no box yet publishes nothing, rather than "0px" or "NaNpx": the
  // page keeps the room it had.
  if (!(height > 0)) return;
  // Rounded UP. 44.6px of bar needs 45px of room; rounded down, a hairline of
  // the heading shows under the bar's bottom border.
  const value = Math.ceil(height) + 'px';
  const style = document.documentElement.style;
  // Compared with what is on <html> now, not with a number remembered from the
  // last call. In development React's StrictMode runs the cleanup below and
  // then both effects again on the same instance, and a remembered "already
  // published" would leave the variable removed while the bar is on screen.
  if (style.getPropertyValue(NOTICE_HEIGHT_VAR) !== value) style.setProperty(NOTICE_HEIGHT_VAR, value);
}

export default function NoticeBar({ children, onDismiss }) {
  const barRef = useRef(null);

  useLayoutEffect(() => { publishHeight(barRef.current); });

  useLayoutEffect(() => {
    const el = barRef.current;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => { frame = 0; publishHeight(el); });
    };
    window.addEventListener('resize', schedule);
    // The observer hears a font arriving, which no window event reports. Where
    // there is none (jsdom, an old WebView) the resize listener still covers a
    // dragged window and a turned phone.
    let observer = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(schedule);
      observer.observe(el);
    }
    return () => {
      // A frame still waiting would publish the height of a bar that has gone,
      // and the app would keep an empty band at its top until the next reload.
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      if (observer) observer.disconnect();
      document.documentElement.style.removeProperty(NOTICE_HEIGHT_VAR);
    };
  }, []);

  return (
    <div
      ref={barRef}
      role="status"
      data-notice-bar=""
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9000,
        padding: 'calc(var(--device-top, 0px) + 10px) 14px 12px',
        backgroundColor: 'rgba(11,18,32,0.97)',
        borderBottom: '1px solid rgba(244,239,227,0.18)',
        fontFamily: "'Hanken Grotesk', -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <div style={{ maxWidth: '440px', margin: '0 auto', display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--t-body)', lineHeight: 1.45, color: '#f1ede0' }}>{children}</span>
        <button
          type="button"
          className="hit44"
          onClick={onDismiss}
          style={{ flexShrink: 0, background: 'none', border: 'none', padding: '0 2px', color: 'rgba(241,237,224,0.6)', fontSize: 'var(--t-label)', fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
