import React, { useState } from 'react';
import { appleLogin } from '../../services/api';

// Sign in with Apple button. Apple guideline 4.8: an iOS app that offers any
// third-party login (we show Google) MUST offer Apple's too, so this renders
// on the NATIVE app only — on web it returns null and the web login stays
// Google + email. Wired to backend POST /api/auth/apple (JWKS-verified).
//
// Styling follows Apple's HIG white button style, which is the one Apple
// asks for on a dark background. It shares the `.auth-provider` class with
// the Google button beside it, so the two are identical in height, radius,
// type and weight — which is also what guideline 4.8 means by offering
// Sign in with Apple at equal prominence.

const isNativeIos = () =>
  typeof window !== 'undefined' &&
  window.Capacitor?.isNativePlatform?.() &&
  window.Capacitor?.getPlatform?.() === 'ios';

// Apple delivers the person's name exactly once per Apple ID, on the first
// sheet that completes, and never again unless they revoke the app in
// Settings. The sheet completes on the device before the server has said
// anything, so a first tap that the server then refuses (the 403 needsDob a
// brand-new account gets when the date of birth is still blank) has already
// spent that one delivery. The second tap arrived with no name, and the server
// built the account from the email's local part, which for a private relay
// address is a random string like "xk7f9q2s".
//
// So the last name the plugin handed over is kept here, at module scope rather
// than in state, so it outlives the re-render between the two taps, and it is
// sent again whenever the plugin returns none. It is keyed on Apple's user
// identifier, and reused only when the plugin hands back the SAME identifier:
// a delivery with no identifier is not remembered and a later sheet with no
// identifier matches nothing, because the plugin's contract allows a null
// `user` and "missing matches anything" could hand one person's name to the
// next account created on a shared device (adversarial audit round 2,
// 2026-09-05). It is forgotten the moment the server accepts a sign-in, it is
// never written to storage, and it dies with the page.
let lastDelivered = null;

// `dob` (optional): passed through on account CREATION — the server requires a
// date of birth for new accounts on every auth path (age gate). Existing
// accounts sign in fine without it.
//
// `beforeAuthorize` (optional): called on the tap, before Apple's sheet opens.
// Return false and nothing happens. It exists because this button is the one
// sign-in path a screen cannot re-enter on the user's behalf, since the native
// sheet needs this button's own tap. A screen with something to settle with the
// user first (the sign-in screen's date-of-birth read-back) therefore has to be
// able to stop the tap rather than undo what it did.
const AppleSignInButton = ({ onSuccess, onError, dob, beforeAuthorize }) => {
  const [busy, setBusy] = useState(false);

  if (!isNativeIos()) return null;

  const handleClick = async () => {
    if (busy) return;
    if (beforeAuthorize && beforeAuthorize() === false) return;
    setBusy(true);
    try {
      const { SignInWithApple } = await import('@capacitor-community/apple-sign-in');
      const result = await SignInWithApple.authorize({
        clientId: 'com.flockcorp.flock',
        // api.flockcorp.com, not the Railway-generated host. Inert today (the
        // native ASAuthorization path ignores redirectURI and the button is
        // gated on iOS), but the Railway name is an implementation detail that
        // changes if the service is ever recreated, which is the reasoning
        // services/emailService.js already pins for every other URL we mint.
        redirectURI: 'https://api.flockcorp.com/api/auth/apple',
        scopes: 'email name',
      });
      const r = result?.response;
      if (!r?.identityToken) throw new Error('Apple sign-in was cancelled');
      // fullName only arrives on the first-ever authorization for the Apple ID.
      const delivered = (r.givenName || r.familyName)
        ? { givenName: r.givenName || '', familyName: r.familyName || '' }
        : undefined;
      if (delivered) lastDelivered = r.user ? { user: r.user, fullName: delivered } : null;
      const remembered = lastDelivered && r.user && lastDelivered.user === r.user
        ? lastDelivered.fullName
        : undefined;
      const fullName = delivered || remembered;
      const data = await appleLogin(r.identityToken, fullName, r.authorizationCode, dob);
      // Accepted: the account carries the name now, and nothing else on this
      // device should ever receive it.
      lastDelivered = null;
      onSuccess?.(data.user);
    } catch (err) {
      // User-cancelled flows should stay quiet; real failures surface.
      // The raw error goes out as a second argument so a screen can read
      // `err.data.needsDob` — the server answers 403 {needsDob:true} when a
      // brand-new Apple account arrives with no date of birth, and a screen
      // that only sees the message string cannot offer the retry field.
      const msg = String(err?.message || err);
      if (!/cancel|1001/i.test(msg)) onError?.(msg || 'Apple sign-in failed', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="auth-provider"
      onClick={handleClick}
      disabled={busy}
      style={{ color: '#000000' }}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ marginTop: '-2px' }}>
        <path d="M17.05 12.54c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.87-.76-1.48.02-2.84.86-3.6 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.24 2.74 2.2 1.1-.05 1.52-.71 2.85-.71 1.33 0 1.7.71 2.87.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.4 1.2-2.46-.03-.01-2.28-.88-2.3-3.48zM14.9 5.6c.6-.74 1.01-1.76.9-2.78-.87.04-1.93.58-2.56 1.31-.56.65-1.05 1.69-.92 2.68.97.08 1.97-.49 2.58-1.21z" />
      </svg>
      {busy ? 'Signing in…' : 'Continue with Apple'}
    </button>
  );
};

export default AppleSignInButton;
