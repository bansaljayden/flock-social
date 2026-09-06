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
 */
export default function ConsentBanner({ onAnswer }) {
  const [open, setOpen] = React.useState(() => consentUnanswered());

  if (!open) return null;

  const answer = (value) => {
    setConsent(value);
    setOpen(false);
    if (onAnswer) onAnswer(value);
  };

  return (
    <div className="cb-wrap" role="dialog" aria-label="Analytics choice">
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
  bottom: calc(12px + env(safe-area-inset-bottom, 0px));
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
.cb-btn:hover { opacity: 0.75; }
`;
