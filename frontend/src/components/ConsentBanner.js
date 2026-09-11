import React from 'react';
import { setConsent, consentUnanswered } from '../services/analyticsConsent';

/**
 * THE ASK. One bar, two real buttons, no dark pattern.
 *
 * Both answers are the same size, the same weight and the same distance from
 * the thumb. A cookie bar whose "Accept" is a filled button and whose "Reject"
 * is grey six-point text under a "Manage preferences" link is the pattern this
 * deliberately is not, and the anti-slop standard would ban the styling even
 * if the law did not.
 *
 * IT IS HONEST ABOUT WHAT IT IS FOR. Flock sets no cookie, runs no ad pixel and
 * does no cross-site tracking, so the copy does not say "cookies" — it says
 * what actually happens, which is a page-view count. Claiming a cookie banner
 * when there is no cookie would be its own small lie.
 *
 * DECLINING IS FREE. Nothing about the site changes, nothing is gated, and the
 * bar does not come back. That is the whole point of asking.
 *
 * IT NEVER COVERS THE TAB BAR. Inside the app the bar used to sit on top of
 * the bottom navigation (fixed at the bottom, above everything by z-index),
 * so until a person answered it the five tabs were under it and a tap on
 * Discover landed on the bar. Screenshots of every screen showed it, and the
 * capture rig timed out on the first tab. The bar now measures the visible
 * main navigation and sits above it; on the marketing pages, which have no
 * tab bar, nothing changes.
 */
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

  React.useEffect(() => {
    if (!open) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const h = visibleNavHeight();
      setClearance((prev) => (prev === h ? prev : h));
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('resize', schedule);
    // The tab bar mounts after sign-in, while the bar can already be showing,
    // so watch the document for it rather than measuring once.
    const observer = typeof MutationObserver === 'function'
      ? new MutationObserver(schedule)
      : null;
    if (observer) observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.removeEventListener('resize', schedule);
      if (observer) observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [open]);

  if (!open) return null;
  const answer = (value) => {
    setConsent(value);
    setOpen(false);
    if (onAnswer) onAnswer(value);
  };
  return (
    <div
      className="cb-wrap"
      role="dialog"
      aria-label="Analytics choice"
      style={{ '--cb-clearance': `${clearance}px` }}
    >
      <style>{CSS}</style>
      <p className="cb-copy">
        Can we count anonymous page views to see what people read? No cookies,
        no advertising, no sharing. Saying no changes nothing about the site.
      </p>
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
