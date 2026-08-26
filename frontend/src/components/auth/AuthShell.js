import React, { useEffect, useRef, useState } from 'react';
import Icons from '../ui/Icons';

/* ═══════════════════════════════════════════════════════════════════
   AUTH SHELL — the shared surface behind Login and Signup.

   Composition: the screen is one photograph of a night city with a
   ledger laid over the bottom of it. The top third is the picture (the
   night you're going out into, the same duality the website runs on);
   the sheet is opaque navy and carries every piece of text and every
   control. That split is the accessibility fix as much as the design
   one: text never sits on moving footage, so its background colour is
   a known constant (#0b1220) and its contrast is a number we can hold
   ourselves to instead of an average of whatever frame is playing.

   Type follows the site: Fraunces carries exactly one line per screen
   (the h1), Hanken Grotesk carries everything else. One display moment,
   not a display font sprayed over UI labels.

   Both screens share this file so the two never drift apart, and so
   the 810KB backdrop is implemented once.
   ═══════════════════════════════════════════════════════════════════ */

// Text/surface constants. Same values as the website's tokens
// (src/website/LandingPage.css) — the auth screens are the front door of
// the same brand, so they use the brand's own navy/cream, not one-off greys.
export const AUTH = {
  cream: '#f4efe3',      // 16.3:1 on the sheet
  cream2: '#c8c3b2',     // 10.6:1 on the sheet — every secondary line
  sheet: '#0b1220',
  navy: '#0f172a',
  steel: '#6d9ac3',      // focus rings and links: 6.3:1 on the sheet
  red: '#fca5a5',        // 8.9:1 on the error surface
  green: '#34d399',      // 9.7:1 on the sheet
};

const POSTER = '/bg-city-poster.jpg';
const VIDEO = '/bg-city.mp4';

// Two reasons to never fetch the 810KB clip: the user asked the OS for less
// motion, or the connection/OS asked us for less data.
const wantsStill = () => {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true;
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))) return true;
  } catch (e) { /* no matchMedia / no NetworkInformation: fall through */ }
  return false;
};

const whenIdle = (fn) => (typeof window.requestIdleCallback === 'function'
  ? window.requestIdleCallback(fn, { timeout: 2500 })
  : window.setTimeout(fn, 700));
const cancelIdle = (id) => (typeof window.cancelIdleCallback === 'function'
  ? window.cancelIdleCallback(id)
  : window.clearTimeout(id));

/* The backdrop. The 22KB poster is the only thing on the cold-boot path; the
   video has NO src attribute at mount, so nothing is queued behind the app's
   own JS. Once the browser is idle we attach the source and fade the motion
   in over the still. If autoplay is refused (WKWebView does that when the
   muted ATTRIBUTE hasn't landed on the element) we drop the src and the
   poster simply stays — no grey iOS play glyph, no black rectangle. */
const AuthBackdrop = () => {
  const ref = useRef(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!v || wantsStill()) return undefined;

    let cancelled = false;
    const idle = whenIdle(() => {
      if (cancelled || !v) return;
      v.muted = true;
      v.setAttribute('muted', '');
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      const play = () => {
        v.play().then(() => { if (!cancelled) setLive(true); })
          .catch(() => { v.removeAttribute('src'); v.load(); });
      };
      v.addEventListener('canplay', play, { once: true });
      v.src = VIDEO;
      v.load();
    });

    return () => { cancelled = true; cancelIdle(idle); };
  }, []);

  return (
    <div className="auth-bg" aria-hidden="true">
      <img className="auth-plate" src={POSTER} alt="" decoding="async" fetchPriority="high" />
      <video
        ref={ref}
        className={`auth-video${live ? ' is-live' : ''}`}
        preload="metadata"
        poster={POSTER}
        loop
        muted
        playsInline
        tabIndex={-1}
        disablePictureInPicture
      />
      <div className="auth-scrim" />
    </div>
  );
};

/* Eye toggle for password fields. 44x44 real box (Apple HIG / WCAG 2.5.5)
   plus .hit44 as the belt-and-braces from index.css; icons inherit
   currentColor so hover/active states are one colour change.

   The glyphs come from components/ui/Icons.js, not a local <svg>: the old
   pair was hand-drawn with its own stroke geometry, so the one control that
   sits inside every password field on every auth screen came from a
   different drawing system than the rest of the app.

   Toggle semantics: ONE accessible name plus aria-pressed, per the standard
   toggle-button pattern. The old code changed the label AND flipped
   aria-pressed, which reads as "Hide password, not pressed" in one state — a
   double negative the listener has to untangle. The icon is decorative
   (aria-hidden inside Icons) because the name lives on the button. */
export const PasswordEye = ({ shown, onToggle }) => (
  <button
    type="button"
    className="auth-eye hit44"
    onClick={onToggle}
    aria-label="Show password"
    aria-pressed={shown}
  >
    {/* eyeOff || eye: Icons.js is shared surface; if eyeOff is ever dropped
        the toggle degrades to a static eye rather than a crash. */}
    {((shown && Icons.eyeOff) || Icons.eye)('currentColor', 20)}
  </button>
);

// Google's official light button mark. Custom button, official artwork.
export const GoogleG = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

/* A labelled rule, not a floating "or". The old divider was an 11px 35%-alpha
   glyph (1.94:1) that told the user nothing; this one names what follows and
   measures 10.6:1. */
export const AuthRule = ({ label }) => (
  <div className="auth-rule"><span>{label}</span></div>
);

/* role="alert" announces the message the moment it renders. Focus moves there
   too (tabIndex -1, programmatic only): on a failed submit the keyboard user
   is otherwise left standing on the submit button with no idea anything
   happened, and on a small screen the error can render above the fold they
   are looking at — focus() also scrolls it into view. The div is not in the
   tab order, so this costs the tab sequence nothing. */
export const AuthError = ({ children }) => {
  const ref = useRef(null);
  useEffect(() => {
    if (children && ref.current) ref.current.focus();
  }, [children]);
  return children
    ? <div className="auth-error" role="alert" tabIndex={-1} ref={ref}>{children}</div>
    : null;
};

/* The good-news counterpart to AuthError. Green rather than red, role="status"
   rather than "alert" so a screen reader announces it politely instead of
   interrupting: "we sent a link" and "your password is updated" are not
   emergencies. Same box as the error so the sheet does not jump when one
   replaces the other. */
export const AuthNotice = ({ children }) => (
  children ? <div className="auth-notice" role="status">{children}</div> : null
);

/* ---------------------------------------------------------------------------
   The age gate's client-side half, in ONE place.

   `backend/utils/age.js` is the authority: it recomputes the age from the
   stored date on every path and nothing here can talk it out of an answer.
   MIN_AGE below is a copy of the number in that file, and it exists so the
   two screens that draw a date-of-birth field cannot drift apart on what they
   SAY. It must never become a second opinion on what is allowed.
   --------------------------------------------------------------------------- */
export const MIN_AGE = 13;

export const ageFromDob = (value) => {
  if (!value) return null;
  const b = new Date(value);
  if (isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age -= 1;
  return age;
};

/* "2015-03-04" -> "March 4, 2015", for reading a date back to the person who
   typed it. Split field by field rather than handed to `new Date(value)`: an
   ISO date string is parsed as UTC midnight, so anywhere west of Greenwich
   toLocaleDateString prints the day BEFORE. On a panel whose whole job is
   "check this date", showing a different date than the field holds is the one
   failure it cannot have. Returns the raw string if the shape is unfamiliar,
   which is still the value the field is carrying. */
export const formatDob = (value) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) return String(value || '');
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const month = months[Number(m[2]) - 1];
  if (!month) return String(value);
  return `${month} ${Number(m[3])}, ${m[1]}`;
};

/* A label with a link on the same line, for "Password ... Forgot password?".
   The link is the smaller, quieter half: it is a way out of the screen, not the
   thing the screen is for. */
export const AuthLabelRow = ({ children }) => (
  <div className="auth-label-row">{children}</div>
);

/* One stylesheet for both screens. Kept in JS (not index.css) because the auth
   surface is owned here and index.css is shared with the whole app.

   The !important flags are deliberate: index.css force-sets background,
   colour and caret on `input:not([type=...])` nine times over, which scores a
   (0,9,1) specificity that no single class can outrank. Inline styles were the
   old workaround; a documented flag keeps the styling in one readable place. */
const AUTH_CSS = `
.auth-root {
  position: relative;
  height: 100vh;
  height: 100dvh;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: #080d18;
  font-family: var(--font-body);
  -webkit-font-smoothing: antialiased;
}
/* Extends 64px past the hero so the sheet's rounded top corners sit ON the
   photograph rather than on a seam. */
.auth-bg {
  position: absolute; left: 0; right: 0; top: 0; bottom: -64px;
  overflow: hidden; pointer-events: none; background: #080d18; z-index: 0;
}
.auth-plate, .auth-video {
  position: absolute; inset: 0; width: 100%; height: 100%;
  object-fit: cover;
  /* Dimmed enough that the skyline reads as a night, not a light show. The
     type's safety comes from the scrim below, not from crushing the picture. */
  filter: brightness(0.55) saturate(1.08) contrast(1.06);
}
.auth-video { opacity: 0; transition: opacity 900ms ease-out; }
.auth-video.is-live { opacity: 1; }
/* The type plate. The sky stays open at the top; the gradient climbs through
   the band so that by the time it reaches the headline and its line it is
   carrying most of the pixel. That is what makes hero copy safe over MOVING
   footage: the brightest pixel the clip can produce (measured with ffmpeg
   signalstats across every frame: the clip does hit a pure-white pixel in
   both bands) still composites to a background that leaves the headline at
   7.1:1 and its line at 6.5:1. Typical frames measure 16.8:1 and 10.7:1.
   No opacity was raised to get there, and nothing depends on which frame
   happens to be on screen. */
.auth-scrim {
  position: absolute; inset: 0;
  background: linear-gradient(180deg,
    rgba(8,13,26,0.12) 0%,
    rgba(8,13,26,0.22) 30%,
    rgba(8,13,26,0.55) 55%,
    rgba(8,13,26,0.86) 78%,
    rgba(11,18,32,0.95) 100%);
}

.auth-col {
  position: relative; z-index: 1;
  width: 100%; max-width: 440px; margin: 0 auto;
  min-height: 100%;
  display: flex; flex-direction: column;
}
.auth-hero {
  position: relative;
  flex: 1 1 auto;
  display: flex; flex-direction: column; justify-content: flex-end;
  min-height: 210px;
  padding: calc(var(--safe-top) + 36px) 24px 30px;
}
.auth-mark, .auth-h1, .auth-sub { position: relative; z-index: 1; }
.auth-mark {
  width: 56px; height: 56px; border-radius: 50%; display: block;
  margin: 0 0 18px; object-fit: cover;
  box-shadow: 0 10px 30px rgba(0,0,0,0.45);
}
.auth-h1 {
  font-family: var(--font-display);
  font-size: 34px; font-weight: 600; line-height: 1.05; letter-spacing: -0.005em;
  color: ${AUTH.cream}; margin: 0; text-wrap: balance;
}
/* 13.5em holds the line to its own sentence, so it breaks after the full
   stop instead of orphaning two words onto line two. */
.auth-sub {
  margin: 10px 0 0; max-width: 13.5em;
  font-size: 15px; line-height: 1.5; color: ${AUTH.cream2}; text-wrap: pretty;
}

.auth-sheet {
  background: rgba(11,18,32,0.97);
  border-top: 1px solid rgba(244,239,227,0.18);
  border-radius: 26px 26px 0 0;
  padding: 26px 22px calc(var(--safe-bottom) + 24px);
}

.auth-field-row { margin-bottom: 16px; }
.auth-label {
  display: block; margin: 0 0 7px 2px;
  font-size: 13px; font-weight: 600; color: ${AUTH.cream2};
}
.auth-field {
  width: 100%; box-sizing: border-box;
  height: 50px; padding: 0 14px;
  border-radius: 12px;
  /* Field boundary at 3.2:1 against the sheet (1.4.11 non-text minimum is
     3:1). The old 0.16 alpha composited to 1.8:1, which left the extent of
     the field to be guessed from the placeholder alone. */
  border: 1px solid rgba(244,239,227,0.34);
  background-color: #181f2c !important;
  color: ${AUTH.cream} !important;
  caret-color: ${AUTH.steel} !important;
  /* 16px: anything smaller makes iOS zoom the page on focus. */
  font-size: 16px; font-weight: 500; font-family: inherit;
  outline: none;
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}
.auth-field::placeholder { color: #9a978a; opacity: 1; }
.auth-field:focus {
  border-color: ${AUTH.steel};
  box-shadow: 0 0 0 3px rgba(109,154,195,0.22);
}
/* Keyboard focus ring for the controls on the sheet. index.css ships a global
   :focus-visible, but its blue composites to ~2.6:1 on this navy sheet
   (#0b1220), under the 3:1 WCAG 1.4.11 minimum for a non-text indicator. Steel
   is 6.3:1 here, so keyboard users get a ring that actually reads against the
   surface. Outline follows each control's own radius in modern browsers, so no
   radius is set here. */
.auth-root button:focus-visible,
.auth-root a:focus-visible {
  outline: 2px solid ${AUTH.steel};
  outline-offset: 2px;
}
/* An empty date field prints mm/dd/yyyy in the value colour, which reads as
   already answered. Required + empty is :invalid, so it can be dimmed to the
   placeholder colour like every other empty field. */
.auth-field[type="date"] { color-scheme: dark; }
.auth-field[type="date"]:invalid { color: #9a978a !important; }
.auth-hint { margin: 7px 2px 0; font-size: 12.5px; line-height: 1.45; color: ${AUTH.cream2}; }

.auth-pw-wrap { position: relative; }
.auth-pw-wrap .auth-field { padding-right: 52px; }
.auth-eye {
  position: absolute; right: 3px; top: 50%;
  transform: translateY(-50%);
  width: 44px; height: 44px;
  display: flex; align-items: center; justify-content: center;
  background: none; border: none; border-radius: 11px;
  color: ${AUTH.cream2}; cursor: pointer;
  transition: color 0.15s ease;
}
.auth-eye:hover { color: ${AUTH.cream}; }
.auth-eye:active { transform: translateY(-50%) scale(0.92); }

.auth-primary {
  width: 100%; height: 54px;
  border: none; border-radius: 14px;
  background: ${AUTH.cream}; color: ${AUTH.navy};
  font-size: 16px; font-weight: 800; letter-spacing: 0.2px; font-family: inherit;
  cursor: pointer;
  box-shadow: 0 10px 28px rgba(0,0,0,0.38);
  transition: filter 0.15s ease, transform 0.12s ease;
}
.auth-primary:hover:not(:disabled) { filter: brightness(1.03); }
.auth-primary:active:not(:disabled) { transform: scale(0.985); }
.auth-primary:disabled { opacity: 0.6; cursor: progress; box-shadow: none; }

/* The two providers are one control group: identical geometry, identical
   type, only the mark changes. Both use their owner's approved light button
   (Google: #fff / #1f1f1f; Apple: white style, which is the one Apple asks
   for on a dark background), which is also what guideline 4.8 means by equal
   prominence. */
.auth-provider {
  width: 100%; height: 48px;
  display: flex; align-items: center; justify-content: center; gap: 10px;
  border: 1px solid #747775; border-radius: 12px;
  background: #ffffff; color: #1f1f1f;
  font-size: 15px; font-weight: 500; font-family: inherit;
  cursor: pointer;
  transition: filter 0.15s ease, transform 0.12s ease;
}
.auth-provider + .auth-provider { margin-top: 10px; }
.auth-provider:hover:not(:disabled) { filter: brightness(0.96); }
.auth-provider:active:not(:disabled) { transform: scale(0.985); }
.auth-provider:disabled { opacity: 0.6; cursor: progress; }

.auth-rule { display: flex; align-items: center; gap: 12px; margin: 24px 0 14px; }
.auth-rule::before, .auth-rule::after {
  content: ''; flex: 1; height: 1px; background: rgba(244,239,227,0.18);
}
.auth-rule span { font-size: 12.5px; font-weight: 600; color: ${AUTH.cream2}; }

.auth-error {
  border-radius: 12px; padding: 11px 14px; margin-bottom: 18px;
  background: rgba(239,68,68,0.12);
  border: 1px solid rgba(239,68,68,0.34);
  color: ${AUTH.red}; font-size: 13.5px; font-weight: 500; line-height: 1.45;
}
.auth-notice {
  border-radius: 12px; padding: 11px 14px; margin-bottom: 18px;
  background: rgba(52,211,153,0.10);
  border: 1px solid rgba(52,211,153,0.30);
  color: ${AUTH.green}; font-size: 13.5px; font-weight: 500; line-height: 1.45;
}

/* The read-back panel on the sign-in screen's date-of-birth field. Not an
   error and not styled as one: at this point nothing has gone wrong and
   nothing has been sent. It is the field's own value, in words, with the
   consequence of sending it written out.

   The two buttons carry IDENTICAL weight on purpose. Making "change the date"
   the filled one would read as the screen telling a child to type a different
   birthday, and making the confirm the filled one would push a teenager
   through their own typo. Neither button is the recommended one, because the
   screen has no business having an opinion about which is true. */
.auth-check {
  border-radius: 12px; padding: 13px 14px; margin-bottom: 18px;
  background: rgba(244,239,227,0.06);
  border: 1px solid rgba(244,239,227,0.24);
  color: ${AUTH.cream}; font-size: 13.5px; line-height: 1.5;
}
.auth-check h2 {
  margin: 0 0 6px; font-size: 14px; font-weight: 700; font-family: inherit;
  color: ${AUTH.cream};
}
.auth-check p { margin: 0 0 6px; color: ${AUTH.cream2}; }
.auth-check p:last-of-type { margin-bottom: 12px; }
.auth-check-actions { display: flex; gap: 10px; flex-wrap: wrap; }
.auth-check-actions button {
  flex: 1 1 140px; min-height: 44px; padding: 10px 12px;
  border-radius: 11px; border: 1px solid rgba(244,239,227,0.38);
  background: none; color: ${AUTH.cream};
  font-family: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
  transition: background 0.15s ease;
}
.auth-check-actions button:hover { background: rgba(244,239,227,0.10); }
.auth-check-actions button:active { transform: scale(0.985); }

/* baseline alignment so the 13px label and the 13px link sit on one line, and
   the link keeps its 44px finger target through .hit44 without pushing the
   field down (the pseudo-element does not affect layout). */
.auth-label-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
}
.auth-label-row .auth-label { margin-bottom: 7px; }
.auth-link {
  background: none; border: none; padding: 0; margin: 0 2px 7px 0;
  color: ${AUTH.cream}; font-size: 13px; font-weight: 600; font-family: inherit;
  cursor: pointer;
  text-decoration: underline; text-underline-offset: 3px;
  text-decoration-color: rgba(244,239,227,0.5);
}
.auth-link:hover { text-decoration-color: ${AUTH.cream}; }

.auth-legal {
  margin: 14px 0 0; font-size: 12.5px; line-height: 1.6;
  color: ${AUTH.cream2}; text-align: center;
}
/* nowrap so "Privacy Policy" and "Community Guidelines" never split across
   two lines: a half-underlined document name reads like two links. */
.auth-legal a {
  color: ${AUTH.cream}; font-weight: 600; white-space: nowrap;
  text-decoration: underline; text-underline-offset: 2px;
  text-decoration-color: rgba(244,239,227,0.5);
}

.auth-foot {
  display: flex; align-items: center; justify-content: center; gap: 4px;
  margin-top: 22px; padding-top: 16px;
  border-top: 1px solid rgba(244,239,227,0.12);
  font-size: 14.5px; color: ${AUTH.cream2};
}
.auth-textbtn {
  min-height: 44px; padding: 0 8px;
  display: inline-flex; align-items: center;
  background: none; border: none;
  color: ${AUTH.cream}; font-size: 14.5px; font-weight: 700; font-family: inherit;
  cursor: pointer;
  text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1.5px;
  text-decoration-color: rgba(244,239,227,0.5);
}
.auth-textbtn:hover { text-decoration-color: ${AUTH.cream}; }

.auth-venue {
  display: flex; align-items: center; justify-content: center; gap: 5px;
  width: 100%; min-height: 48px; margin: 4px 0 0;
  background: none; border: none;
  color: ${AUTH.cream2}; font-size: 13.5px; font-family: inherit; cursor: pointer;
}
/* Quieter than the signup link on purpose: same 10.6:1 colour as the label
   around it, with the underline doing the work of saying "link". Venue owners
   are a fraction of the traffic and they know they are one. */
.auth-venue span {
  font-weight: 600;
  text-decoration: underline; text-underline-offset: 3px;
  text-decoration-color: rgba(200,195,178,0.55);
}
.auth-venue:hover span { text-decoration-color: ${AUTH.cream2}; }

/* Single-run entrance, ~200ms, no stagger and no scroll trigger. index.css's
   reduced-motion block collapses it to nothing. */
@keyframes authRise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.auth-hero, .auth-sheet { animation: authRise 0.45s cubic-bezier(0.16, 1, 0.3, 1) both; }
.auth-sheet { animation-delay: 0.06s; }

@media (max-height: 700px) {
  .auth-hero { min-height: 0; padding-top: calc(var(--safe-top) + 22px); padding-bottom: 22px; }
  .auth-mark { width: 46px; height: 46px; margin-bottom: 12px; }
  .auth-h1 { font-size: 29px; }
}
`;

const AuthShell = ({ hero, children }) => (
  <div className="auth-root">
    <div className="auth-col">
      {/* The picture is sized to the hero, not to the window. A full-screen
          cover of a 16:9 clip on a 19.5:9 phone puts the skyline behind the
          sheet and leaves nothing but sky on screen, and upscales the source
          3x. Bounding it to the hero band shows the whole frame, roughly at
          native resolution. */}
      <header className="auth-hero">
        <AuthBackdrop />
        {hero}
      </header>
      <main className="auth-sheet">{children}</main>
    </div>
    <style>{AUTH_CSS}</style>
  </div>
);

export default AuthShell;
