import React, { useState } from 'react';
import { GoogleOAuthProvider } from '@react-oauth/google';
import AppleSignInButton from './AppleSignInButton';
import useGoogleAuth, { isGoogleSignInAvailable, isNativeIos } from './useGoogleAuth';
import { GoogleG } from './AuthShell';

/**
 * "Confirm it's you" for an Apple or Google account, inside the dialog that
 * asked, instead of "log out, sign back in, then come straight here".
 *
 * WHY. Deleting an account and exporting its data both need proof beyond the
 * 24-hour session token (backend/routes/users.js). A password account types
 * its password. An Apple or Google account has none, so the server accepts a
 * session minted in the last five minutes instead (hasFreshSession), and past
 * that answers reauthRequired 'reauth'. The only way to a fresh session used to
 * be leaving the dialog, signing out and signing back in, which turned the one
 * flow App Review checks under Guideline 5.1.1(v) into a trip out of the app.
 *
 * WHAT IT DOES. It runs the account's own provider sheet right here, through
 * the same calls the sign-in screen makes (appleLogin / googleLogin in
 * services/api.js). Those store the fresh token they are answered with, which
 * is exactly the proof the refused request was missing, so the dialog only has
 * to clear its refusal and let the person press the button again. The route
 * note at DELETE /api/users/me describes this flow. Both calls are made with
 * reconfirm set, because this is the signed-in person proving it again and not
 * a sign-in: the token is stored, and no login is recorded and the device is
 * not identified again (opts.reconfirm in services/api.js).
 *
 * A DIFFERENT ACCOUNT. The sheet will happily sign in whichever Apple ID or
 * Google account the person picks, and by the time the answer arrives this
 * device already holds that account's token. If its id is not the id of the
 * account that opened the dialog, the dialog must never go on to delete or
 * export anything, so onOtherAccount runs instead, and the caller ends the
 * session on this device. An Apple ID or Google account with no Flock account
 * behind it is refused by the server before any token is issued (needsDob),
 * and says so here.
 *
 * WHERE IT CANNOT RUN. Sign in with Apple exists only inside the iOS app, and a
 * native build without the iOS Google client id has no Google sheet. There,
 * canReconfirmHere() is false and the caller keeps its old sentence, which is
 * still true for that device.
 *
 * THE GOOGLE PROVIDER. useGoogleAuth calls useGoogleLogin unconditionally, and
 * that needs a GoogleOAuthProvider above it. The app mounts one only over the
 * signed-out screens, because mounting it fetches Google's script. This mounts
 * its own, and only while a Google account is being asked to confirm, so the
 * script is fetched for that moment and not on every launch.
 *
 * The button titles are the providers' own ("Continue with Apple", "Continue
 * with Google"). Apple's guidelines name the titles a Sign in with Apple button
 * may carry, and a custom verb is not one of them; the sentence above the
 * button says why it is there.
 */

const GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID || '';

export const PROVIDER_NAMES = { apple: 'Apple', google: 'Google' };

export const canReconfirmHere = (provider) => {
  if (provider === 'apple') return Boolean(isNativeIos());
  if (provider === 'google') return Boolean(isGoogleSignInAvailable());
  return false;
};

// The auth screens' provider button, restated inline because its stylesheet
// is injected by AuthShell, which is not mounted inside the app.
const PROVIDER_BUTTON = {
  width: '100%', minHeight: '48px',
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
  border: '1px solid #747775', borderRadius: '12px',
  background: '#ffffff', color: '#1f1f1f',
  fontSize: 'var(--t-body)', fontWeight: '500', fontFamily: 'inherit',
  cursor: 'pointer',
};

function GoogleButton({ onUser, onFailure }) {
  const [busy, setBusy] = useState(false);
  const start = useGoogleAuth({ onSuccess: onUser, onError: onFailure, setBusy, reconfirm: true });
  return (
    <button type="button" className="hit44" onClick={() => start()} disabled={busy} style={{ ...PROVIDER_BUTTON, opacity: busy ? 0.6 : 1, cursor: busy ? 'progress' : 'pointer' }}>
      <GoogleG /> {busy ? 'Checking…' : 'Continue with Google'}
    </button>
  );
}

export default function OAuthReconfirm({ provider, expectedUserId, onConfirmed, onOtherAccount }) {
  const [error, setError] = useState('');
  const name = PROVIDER_NAMES[provider] || 'your sign-in';

  const onUser = (user) => {
    if (user && user.id != null && String(user.id) === String(expectedUserId)) {
      setError('');
      onConfirmed?.();
      return;
    }
    onOtherAccount?.();
  };

  const onFailure = (message, err) => {
    if (err?.data?.needsDob) {
      setError(`That ${name} account is not the one this Flock account uses. Try again with the one you sign in with.`);
      return;
    }
    setError(message || `${name} did not confirm it. Try again.`);
  };

  return (
    <div style={{ marginTop: '10px' }}>
      {provider === 'apple' && (
        <AppleSignInButton
          onSuccess={onUser}
          onError={onFailure}
          className="hit44"
          style={PROVIDER_BUTTON}
          reconfirm
        />
      )}
      {provider === 'google' && (
        <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
          <GoogleButton onUser={onUser} onFailure={onFailure} />
        </GoogleOAuthProvider>
      )}
      {error && (
        <p role="alert" style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: '#EF4444', margin: '8px 0 0', lineHeight: 1.4 }}>{error}</p>
      )}
    </div>
  );
}
