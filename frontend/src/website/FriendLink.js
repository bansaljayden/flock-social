/**
 * /add/<code>: A FRIEND'S FLOCK CODE, FOR SOMEBODY WHO MAY NOT HAVE FLOCK.
 *
 * The link a person's share sheet sends carries
 * https://www.flockcorp.com/add/FLOCK-XXXXXXXX, and so does the QR on their
 * Add friends screen once the server switches it from the JSON older builds
 * read (FRIEND_QR_LINK, backend routes/friends.js GET /my-code). With Flock
 * installed, and once the app build that routes it is on the App Store, an
 * iPhone opens that in the app (services/pushNavigation.js). Everybody else
 * lands here: a phone without Flock, a laptop, Android, and until /add/* is
 * claimed in the association file, an iPhone with it. The page used to be the
 * not-found page, so a friend's code was a dead end for exactly the people it
 * was meant to bring in.
 *
 * WHAT IT DOES. It shows the code with a Copy button and the App Store badge,
 * and offers the web app: "Use Flock in your browser" goes to sign up and "I
 * already have an account" to /app, and both keep the code first
 * (lib/friendCode.js, a day at most), so the account that comes out the other
 * side is shown who sent it and asked whether to add them. A browser that
 * already holds a session keeps the code and goes straight to /app.
 *
 * WHAT IT DOES NOT DO. It never looks the code up and never names the person:
 * a page anybody can open with a guessed code must not be a directory. And it
 * sends nothing; the app asks before any request goes out.
 */
import React, { useEffect, useMemo, useState } from 'react';
import AppStoreBadge from './AppStoreBadge';
import { BirdieStill, WARM_BIRD } from '../components/ui/BirdieBird';
import { friendCodeFrom, rememberFriendCode } from '../lib/friendCode';
import { lsGet } from '../lib/storage';

// The app's own session key (services/api.js), read directly so this page
// does not pull the REST client into a chunk shipped to strangers.
const SESSION_KEY = 'flockToken';

const CSS = `
.fl {
  --fl-paper: #f1ede0;
  --fl-card: #fbf9f3;
  --fl-ink: #16283d;
  --fl-ink-2: #33475e;
  --fl-ink-3: #55637a;
  --fl-accent: #1e293b;
  --fl-accent-ink: #ffffff;
  --fl-rule: rgba(22, 40, 61, 0.16);
  font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--fl-paper);
  color: var(--fl-ink-2);
  -webkit-font-smoothing: antialiased;
  line-height: 1.55;
  min-height: 100vh;
  box-sizing: border-box;
  padding: clamp(24px, 6vw, 56px) 16px 56px;
}
@supports (min-height: 100dvh) { .fl { min-height: 100dvh; } }
@media (prefers-color-scheme: dark) {
  .fl {
    --fl-paper: #0f172a;
    --fl-card: #1d293d;
    --fl-ink: #f4efe3;
    --fl-ink-2: #c8c3b2;
    --fl-ink-3: #9aa4b2;
    --fl-accent: #f1ede0;
    --fl-accent-ink: #1e293b;
    --fl-rule: rgba(244, 239, 227, 0.18);
    color-scheme: dark;
  }
}
.fl *, .fl *::before, .fl *::after { box-sizing: border-box; }
.fl-wrap { max-width: 30rem; margin: 0 auto; }
.fl-mark {
  display: inline-block;
  font-size: 15px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--fl-ink);
  text-decoration: none;
  margin: 0 0 clamp(20px, 5vw, 32px);
}
.fl h1 {
  font-family: 'Fraunces', Georgia, serif;
  font-weight: 600;
  font-size: clamp(26px, 6vw, 34px);
  line-height: 1.15;
  letter-spacing: -0.01em;
  color: var(--fl-ink);
  margin: 12px 0 10px;
}
.fl p { margin: 0 0 18px; font-size: 16px; }
.fl-code {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 10px 10px 16px;
  border-radius: 14px;
  border: 1px solid var(--fl-rule);
  background: var(--fl-card);
  margin: 0 0 24px;
}
.fl-code-text {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 1px;
  color: var(--fl-ink);
  overflow-wrap: anywhere;
}
.fl-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 48px;
  padding: 10px 16px;
  border-radius: 12px;
  font: inherit;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
}
.fl-btn-primary { background: var(--fl-accent); color: var(--fl-accent-ink); border: 1px solid var(--fl-accent); }
.fl-btn-quiet { background: transparent; color: var(--fl-ink); border: 1px solid var(--fl-rule); margin-top: 10px; }
.fl-copy {
  flex-shrink: 0;
  min-height: 44px;
  min-width: 72px;
  padding: 0 14px;
  border-radius: 10px;
  border: 1px solid var(--fl-rule);
  background: transparent;
  color: var(--fl-ink);
  font: inherit;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
}
.fl-store { display: flex; justify-content: center; padding: 12px; margin: 0 0 20px; }
.fl-appstore { display: inline-block; line-height: 0; }
.fl-appstore img { height: 48px; width: auto; display: block; }
.fl-or { text-align: center; font-size: 14px; color: var(--fl-ink-3); margin: 0 0 14px; }
.fl-note { font-size: 14px; color: var(--fl-ink-3); margin: 22px 0 0; }
`;

const pathCode = () => {
  try { return friendCodeFrom(window.location.href, { origin: window.location.origin }); } catch { return null; }
};

export default function FriendLink() {
  const code = useMemo(pathCode, []);
  const signedIn = useMemo(() => Boolean(lsGet(SESSION_KEY)), []);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.title = code ? 'Add a friend | Flock' : 'Link not complete | Flock';
    // A friend's code is not for search engines; the host says so too
    // (cloudflare/_headers), and this covers any other host.
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, noarchive';
    document.head.appendChild(meta);
    return () => { meta.remove(); };
  }, [code]);

  // Signed in on this browser already: straight to the app, which asks.
  useEffect(() => {
    if (!code || !signedIn) return;
    rememberFriendCode(code);
    window.location.replace('/app');
  }, [code, signedIn]);

  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  // Keep the code, then hand the browser to the app's door. A real
  // navigation rather than a link, because the write has to land first.
  const go = (where) => {
    rememberFriendCode(code);
    window.location.assign(where);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // The code is on the screen in large type either way.
      setCopied(false);
    }
  };

  if (code && signedIn) {
    return (
      <main className="fl">
        <style>{CSS}</style>
        <p className="sr-only" role="status">Opening Flock.</p>
      </main>
    );
  }

  return (
    <main className="fl">
      <style>{CSS}</style>
      <div className="fl-wrap">
        <a className="fl-mark" href="/">Flock</a>
        <BirdieStill bird={WARM_BIRD} size={72} eager />
        {code ? (
          <>
            <h1>Add your friend on Flock</h1>
            <p>
              Your friend sent you their Flock code. Get the app and add them with it,
              or use Flock in your browser and the code comes with you.
            </p>
            <div className="fl-code">
              <span className="fl-code-text">{code}</span>
              <button type="button" className="fl-copy" onClick={copy} aria-label={`Copy the code, ${code}`}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="fl-store">
              <AppStoreBadge className="fl-appstore" />
            </div>
            <p className="fl-or">No iPhone? Flock runs in your browser too.</p>
            <button type="button" className="fl-btn fl-btn-primary" onClick={() => go('/signup')}>Use Flock in your browser</button>
            <button type="button" className="fl-btn fl-btn-quiet" onClick={() => go('/app')}>I already have an account</button>
            <p className="fl-note">Nothing is sent until you say so. Flock asks before adding anyone.</p>
          </>
        ) : (
          <>
            <h1>That link isn't complete</h1>
            <p>Ask your friend to send their Flock link again, or to tell you their code.</p>
            <a className="fl-btn fl-btn-quiet" href="/">Go to flockcorp.com</a>
          </>
        )}
      </div>
    </main>
  );
}
