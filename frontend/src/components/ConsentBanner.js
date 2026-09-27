import React from 'react';
import { setConsent, consentUnanswered, onConsentChange } from '../services/analyticsConsent';
import { isNativeShell } from '../lib/nativeShell';

/**
 * THE ASK. One bar, two real buttons, no dark pattern.
 *
 * Both answers are the same size, the same weight and the same distance from
 * the thumb. A cookie bar whose "Accept" is a filled button and whose "Reject"
 * is grey six-point text under a "Manage preferences" link is the pattern this
 * deliberately is not, and the design standard would ban the styling even
 * if the law did not.
 *
 * IT IS HONEST ABOUT WHAT IT IS FOR. Flock sets no cookie, runs no ad pixel and
 * does no cross-site tracking, so the copy does not say "cookies" — it says
 * what actually happens, which is a page-view count. Claiming a cookie banner
 * when there is no cookie would be its own small lie.
 *
 * DECLINING IS FREE. Nothing about the site changes, nothing is gated, and the
 * bar does not come back to the account that answered, while it stays signed
 * in or when it signs straight back in on the same page
 * (services/analyticsConsent.js, WHOSE ANSWER IT IS). That is the whole point
 * of asking. A different account signing in on the same phone is a different
 * person, and is asked for itself.
 *
 * IT NEVER COVERS THE TAB BAR. Inside the app the bar used to sit on top of
 * the bottom navigation (fixed at the bottom, above everything by z-index),
 * so until a person answered it the five tabs were under it and a tap on
 * Discover landed on the bar. Screenshots of every screen showed it, and the
 * capture rig timed out on the first tab. The bar now measures the visible
 * main navigation and sits above it; on the marketing pages, which have no
 * tab bar, nothing changes.
 *
 * AND IT NEVER COVERS THE SIGN-IN FOOTER EITHER, which is the same bug one
 * screen earlier. Before sign-in there is no tab bar, so the clearance above
 * is zero and the bar sat flat over the bottom of the auth card, on the line
 * that reads "New here? Create an account" and, on the signup half, "Already
 * have an account? Sign in". A fresh install lands on that screen, and a tap
 * on either link landed on the bar until the analytics question was answered.
 * Walking the reviewer's path against production caught it: the click on
 * "Create an account" was intercepted by this dialog. So while it is open the
 * bar publishes its own height on the document as --cb-height, and the auth
 * column pads its bottom by that much, so the footer scrolls clear of the bar
 * instead of under it. The variable is removed the moment the bar closes.
 */
/*
 * INSIDE THE NATIVE APP IT IS A DIFFERENT QUESTION, ASKED LATER.
 *
 * The consent is real there too: services/api.js returns before every capture
 * without a yes, and index.js never starts PostHog without one, in the iOS
 * shell exactly as on the web. So the app keeps asking. What changed is how:
 *
 *   WORDS. "Page views" and "the site" are website words, and inside the app
 *   they read as a web page that wandered in. The app version says screens and
 *   the app, and it says what the privacy policy says about analytics in the
 *   app, where a person is signed in: the events carry an account number,
 *   never a name. "Anonymous" would not be true of those, so it is not used.
 *
 *   WHEN. A fresh install opens on the sign-in screen, and on a 375x667
 *   window the bar sat over the lower half of it, over Continue with Apple,
 *   which is the first thing App Review taps. In the app the bar now waits
 *   until the tab bar is on screen, i.e. until somebody is signed in, and then
 *   sits above the tabs as before. Nothing on the sign-in screens is ever
 *   under it. Until it is answered analytics stays off, which is what an
 *   unanswered question already meant, so waiting collects nothing extra and
 *   the only thing it costs is the sign-in event of a fresh install.
 *
 * The web is unchanged: same words, shown at once, same clearance rules.
 */
const WEB_COPY = 'Can we count anonymous page views to see what people read? No cookies, '
  + 'no advertising, no sharing. Saying no changes nothing about the site.';
export const APP_COPY = 'Can Flock count which screens you open and a few actions, like creating '
  + 'a flock? It is tied to your account number, not your name. No ads, no selling. '
  + 'Saying no changes nothing in the app.';

const HEIGHT_VAR = '--cb-height';
const MAIN_NAV = 'nav[aria-label="Main"]';

function visibleNavHeight() {
  if (typeof document === 'undefined') return 0;
  let best = 0;
  for (const nav of document.querySelectorAll(MAIN_NAV)) {
    const rect = nav.getBoundingClientRect();
    if (rect.height > best && rect.width > 0) best = rect.height;
  }
  return Math.round(best);
}

export default function ConsentBanner({ onAnswer }) {
  const [open, setOpen] = React.useState(() => consentUnanswered());
  const [clearance, setClearance] = React.useState(() => visibleNavHeight());
  const wrapRef = React.useRef(null);
  // Read once per mount: the shell is decided at boot and does not change.
  const [inApp] = React.useState(() => isNativeShell());
  // In the app, nothing until the tab bar is there. See the note above WEB_COPY.
  const waiting = inApp && clearance === 0;

  // THE ANSWER BELONGS TO AN ACCOUNT, so it can change under a bar that is
  // already mounted: a session ending takes it away, and the same account
  // signing in again on this page gets it back (services/analyticsConsent.js,
  // WHOSE ANSWER IT IS). Read once at mount, as this used to be, the bar stayed
  // closed after one person's answer and the next account on a shared phone
  // was never asked. Reopened with no clearance, so in the app it waits for the
  // next tab bar rather than floating over the sign-in screen at the height of
  // the last one.
  React.useEffect(() => onConsentChange(() => {
    const unanswered = consentUnanswered();
    if (unanswered) setClearance(0);
    setOpen(unanswered);
  }), []);

  React.useEffect(() => {
    if (!open) return undefined;
    let frame = 0;
    let observer = null;
    const measure = () => {
      frame = 0;
      const h = visibleNavHeight();
      if (inApp && h === 0) {
        // Still before sign-in, or signed out again: stay off screen, and
        // publish no footprint for a bar that is not there.
        setClearance(0);
        document.documentElement.style.removeProperty(HEIGHT_VAR);
        return;
      }
      // THE WATCH ENDS THE MOMENT IT HAS ITS ANSWER. The observer below exists
      // for one event, the tab bar mounting after sign-in, and until it was
      // stopped it kept a callback on every node the app added or removed for
      // the whole time the bar was open, each one scheduling two
      // getBoundingClientRect reads on the next frame. A measured tab bar is
      // the question answered, and resize still re-measures after it.
      // In the app the watch stays on while the bar is unanswered, because a
      // sign-out takes the tab bar away again and the bar has to leave with it
      // rather than float over the sign-in screen.
      if (h > 0 && observer && !inApp) { observer.disconnect(); observer = null; }
      setClearance((prev) => (prev === h ? prev : h));
      // The bar's own footprint: its height plus the 12px it floats above
      // whatever is under it. Published so a page can keep its own footer
      // above the bar; see the header comment.
      const el = wrapRef.current;
      const own = el ? Math.round(el.getBoundingClientRect().height) : 0;
      document.documentElement.style.setProperty(HEIGHT_VAR, `${own + 12 + h}px`);
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };
    // The tab bar mounts after sign-in, while the bar can already be showing,
    // so watch for it rather than measuring once. Watch the app's own root
    // rather than the whole document: the navigation is rendered inside it,
    // and everything outside it is this bar and the page furniture.
    if (typeof MutationObserver === 'function') {
      observer = new MutationObserver(schedule);
      observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true });
    }
    measure();
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('resize', schedule);
      if (observer) observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      // Closing, or unmounting: nothing is under the bar any more, so nothing
      // should keep padding for it.
      document.documentElement.style.removeProperty(HEIGHT_VAR);
    };
    // `waiting` is in the list so the effect runs again the moment the bar
    // first renders in the app: the run that saw the tab bar arrive had no
    // bar of its own to measure yet.
  }, [open, inApp, waiting]);

  if (!open || waiting) return null;
  const answer = (value) => {
    setConsent(value);
    setOpen(false);
    if (onAnswer) onAnswer(value);
  };
  return (
    <div
      ref={wrapRef}
      className="cb-wrap"
      role="dialog"
      aria-label="Analytics choice"
      style={{ '--cb-clearance': `${clearance}px` }}
    >
      <style>{CSS}</style>
      <p className="cb-copy">{inApp ? APP_COPY : WEB_COPY}</p>
      <div className="cb-actions">
        <button type="button" className="cb-btn" onClick={() => answer('no')}>No thanks</button>
        <button type="button" className="cb-btn" onClick={() => answer('yes')}>That's fine</button>
      </div>
    </div>
  );
}

const CSS = `
.cb-wrap {
  position: fixed;
  left: 12px;
  right: 12px;
  bottom: calc(12px + var(--cb-clearance, 0px) + env(safe-area-inset-bottom, 0px));
  z-index: 2147483000;
  max-width: 560px;
  margin: 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  padding: 14px 16px;
  border-radius: 14px;
  background: #fbf9f3;
  color: #33475e;
  border: 1px solid rgba(22, 40, 61, 0.16);
  box-shadow: 0 8px 28px rgba(22, 40, 61, 0.18);
  font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  line-height: 1.5;
}
@media (prefers-color-scheme: dark) {
  .cb-wrap {
    background: #1d293d;
    color: #c8c3b2;
    border-color: rgba(244, 239, 227, 0.18);
  }
}
.cb-copy { margin: 0; flex: 1 1 260px; min-width: 0; }
.cb-actions { display: flex; gap: 8px; flex: 0 0 auto; }
/* Both answers identical on purpose. Neither is the quiet one. */
.cb-btn {
  font: inherit;
  font-weight: 600;
  padding: 9px 14px;
  min-height: 44px;
  border-radius: 10px;
  border: 1px solid currentColor;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
`;
