import React, { useState } from 'react';
import { appleLogin } from '../../services/api';

// Sign in with Apple button. Apple guideline 4.8: an iOS app that offers any
// third-party login (we show Google) MUST offer Apple's too, so this renders
// on the NATIVE app only — on web it returns null and the web login stays
// Google + email. Wired to backend POST /api/auth/apple (JWKS-verified).
//
// Styling follows Apple's HIG for the white button: system-looking mark,
// "Continue with Apple" text, pill shape matching the Google button beside it.

const isNativeIos = () =>
  typeof window !== 'undefined' &&
  window.Capacitor?.isNativePlatform?.() &&
  window.Capacitor?.getPlatform?.() === 'ios';

const AppleSignInButton = ({ onSuccess, onError }) => {
  const [busy, setBusy] = useState(false);

  if (!isNativeIos()) return null;

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { SignInWithApple } = await import('@capacitor-community/apple-sign-in');
      const result = await SignInWithApple.authorize({
        clientId: 'com.flockcorp.flock',
        redirectURI: 'https://flock-app-production.up.railway.app/api/auth/apple',
        scopes: 'email name',
      });
      const r = result?.response;
      if (!r?.identityToken) throw new Error('Apple sign-in was cancelled');
      // fullName only arrives on the first-ever authorization for the Apple ID.
      const fullName = (r.givenName || r.familyName)
        ? { givenName: r.givenName || '', familyName: r.familyName || '' }
        : undefined;
      const data = await appleLogin(r.identityToken, fullName, r.authorizationCode);
      onSuccess?.(data.user);
    } catch (err) {
      // User-cancelled flows should stay quiet; real failures surface.
      const msg = String(err?.message || err);
      if (!/cancel|1001/i.test(msg)) onError?.(msg || 'Apple sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      style={{
        width: '100%',
        maxWidth: '344px',
        height: '40px',
        margin: '10px auto 0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        borderRadius: '20px',
        border: 'none',
        background: '#ffffff',
        color: '#000000',
        fontSize: '14px',
        fontWeight: '600',
        fontFamily: 'inherit',
        cursor: busy ? 'default' : 'pointer',
        opacity: busy ? 0.7 : 1,
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M17.05 12.54c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.87-.76-1.48.02-2.84.86-3.6 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.24 2.74 2.2 1.1-.05 1.52-.71 2.85-.71 1.33 0 1.7.71 2.87.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.4 1.2-2.46-.03-.01-2.28-.88-2.3-3.48zM14.9 5.6c.6-.74 1.01-1.76.9-2.78-.87.04-1.93.58-2.56 1.31-.56.65-1.05 1.69-.92 2.68.97.08 1.97-.49 2.58-1.21z" />
      </svg>
      {busy ? 'Signing in…' : 'Continue with Apple'}
    </button>
  );
};

export default AppleSignInButton;
