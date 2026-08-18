import { useRef } from 'react';
import { useGoogleLogin } from '@react-oauth/google';
import { googleLogin, googleLoginWithToken } from '../../services/api';

/**
 * "Continue with Google", on both platforms, from one place.
 *
 * WHY THIS FILE EXISTS. Until it did, all three auth screens called
 * `useGoogleLogin` from @react-oauth/google and nothing else, which is Google
 * Identity Services' browser popup. Inside the iOS Capacitor WebView that is a
 * DEAD BUTTON, for two independent reasons:
 *
 *   1. Capacitor's iOS WebViewDelegationHandler.createWebViewWith hands every
 *      `window.open` to UIApplication.open and returns nil, so the popup leaves
 *      for Safari and GIS has no opener left to postMessage the token back to.
 *      The user is thrown out of the app and nothing ever returns.
 *   2. The WebView origin is `capacitor://localhost`, and GIS only accepts
 *      http/https origins registered in the Google Cloud console, so the
 *      request is refused before a consent screen can even render.
 *
 * So iOS gets the native path (GoogleSignIn via @capgo/capacitor-social-login,
 * an ASWebAuthenticationSession that stays inside the app) and every other
 * platform keeps the exact web flow it already had.
 *
 * THE TOKEN. The two paths do NOT send the same proof, on purpose, because
 * backend/routes/auth.js POST /api/auth/google accepts two and only two:
 *
 *   credential   — a Google ID token, signature-verified by google-auth-library
 *                  with `audience: GOOGLE_CLIENT_ID`.
 *   access_token — an OAuth access token, whose `aud` is checked against the
 *                  same client id via tokeninfo before userinfo is trusted.
 *
 * The web flow yields an access token, so it keeps posting `access_token`.
 * The native flow yields an ID token, so it posts `credential`. Same route,
 * same field names, no new endpoint and no new token shape.
 *
 * THE AUDIENCE, which is the part that is easy to get wrong. An ID token minted
 * for an iOS OAuth client carries that iOS client id in `aud`, and the backend
 * would reject it — it verifies against ONE audience, the web client id in
 * GOOGLE_CLIENT_ID. GIDConfiguration's `serverClientID` exists exactly for
 * this: Google documents it as "the client ID of the home server ... returned
 * as the audience property of the OpenID Connect ID token". So the plugin is
 * initialized with iOSServerClientId = REACT_APP_GOOGLE_CLIENT_ID (the same web
 * client id the backend enforces) and the token verifies unchanged. Do not drop
 * that field to "simplify" the config; sign-in starts 401ing if you do.
 *
 * ENV. REACT_APP_GOOGLE_CLIENT_ID is the existing web client id, already set
 * for the web build. REACT_APP_GOOGLE_IOS_CLIENT_ID is new and must be an iOS
 * OAuth client for bundle id com.flockcorp.flock; its reversed form is also a
 * URL scheme in ios/App/App/Info.plist. If the iOS one is missing at build
 * time the native button HIDES rather than throwing (see
 * isGoogleSignInAvailable) — a button that cannot work is the defect this file
 * was written to remove, not one to reintroduce with a nicer error message.
 *
 * SIGNING OUT IS NOT IN THIS FILE, and that is deliberate. GIDSignIn keeps its
 * own session in the iOS keychain, so clearing localStorage does not end it and
 * the next person holding the phone can re-authenticate as the previous user in
 * one tap. The matching SocialLogin.logout() call therefore lives in
 * services/api.js's clearLocalSession(), which is the single function every
 * session-ending path converges on — logout(), the 401 handler and account
 * deletion. Adding a second sign-out call here would create exactly the
 * half-clearing second path that convergence exists to prevent. If a provider
 * is ever added to the login path above, add it to endNativeGoogleSession()
 * in that file in the same change.
 */

// Same detection AppleSignInButton.js uses, and for the same reason: read it
// off the injected global rather than importing @capacitor/core, so the web
// bundle never pulls the native runtime in.
export const isNativeIos = () =>
  typeof window !== 'undefined' &&
  window.Capacitor?.isNativePlatform?.() &&
  window.Capacitor?.getPlatform?.() === 'ios';

// CRA's DefinePlugin substitutes each of these expressions with a string
// literal at BUILD time, so wrapping them in a function costs nothing in the
// bundle and keeps the values readable from a test without reloading React.
const iosClientId = () => process.env.REACT_APP_GOOGLE_IOS_CLIENT_ID || '';
const serverClientId = () => process.env.REACT_APP_GOOGLE_CLIENT_ID || '';

/**
 * Should a "Continue with Google" button be on screen at all?
 *
 * Web: yes, unconditionally — unchanged from before this file existed.
 * Native iOS: only when this build actually carries both client ids. A build
 * without them cannot complete a Google sign-in by any route, and shipping the
 * button anyway is precisely the dead button App review flags. Sign in with
 * Apple and email both still work, so the screen is never left without a way in.
 */
export const isGoogleSignInAvailable = () =>
  (isNativeIos() ? Boolean(iosClientId() && serverClientId()) : true);

// One initialize() per app run. Kept at module scope rather than in the hook so
// three screens mounting and unmounting cannot re-initialize the native SDK.
// Keyed on the client ids so a failed attempt (or a changed pair) re-runs
// instead of parking every later tap behind a rejected promise.
let initKey = null;
let initPromise = null;

/**
 * Runs the native sheet and returns Google's ID token.
 *
 * The plugin import is INSIDE this function on purpose: it is the only thing
 * that keeps @capgo/capacitor-social-login (and the GoogleSignIn native shim it
 * wraps) out of the web bundle, since the web build never reaches this line.
 */
async function nativeGoogleIdToken() {
  const { SocialLogin } = await import('@capgo/capacitor-social-login');
  const key = `${iosClientId()}|${serverClientId()}`;
  if (initKey !== key) {
    initKey = key;
    initPromise = SocialLogin.initialize({
      google: {
        iOSClientId: iosClientId(),
        // = the web client id. See THE AUDIENCE above.
        iOSServerClientId: serverClientId(),
        // 'offline' would return only a serverAuthCode, and nothing on our
        // backend exchanges one — /api/auth/google takes a token, not a code.
        mode: 'online',
      },
    }).catch((err) => {
      initKey = null;
      throw err;
    });
  }
  await initPromise;
  // No `scopes`: the provider's own default (email, profile, openid) is what
  // the backend needs, and passing them again would send them as ADDITIONAL
  // scopes on top of the same defaults.
  const res = await SocialLogin.login({ provider: 'google', options: {} });
  const idToken = res?.result?.idToken;
  if (!idToken) throw new Error('Google sign-in did not return a token');
  return idToken;
}

const isCancellation = (err) =>
  err?.code === 'USER_CANCELLED' || /cancel/i.test(String(err?.message || ''));

/**
 * @param {object}   opts
 * @param {function} opts.onSuccess  called with the signed-in user
 * @param {function} opts.onError    (message, error) — the raw error is the
 *   second argument so a screen can read `err.data.needsDob`. The server
 *   answers 403 {needsDob:true} when a brand-new OAuth account arrives without
 *   a date of birth, and a screen that only sees the message string cannot
 *   offer the retry field. Identical on both paths.
 * @param {function} [opts.setBusy]  toggled around the whole exchange
 * @returns {function} start — call it as `start()` or `start({ dob })`
 */
export default function useGoogleAuth({ onSuccess, onError, setBusy }) {
  // Handlers are inline arrows in the screens, so they change identity every
  // render; a ref refreshed here is what keeps the async paths below calling
  // the CURRENT ones instead of the ones captured when the flow started.
  const handlers = useRef({});
  handlers.current = { onSuccess, onError, setBusy };

  // The date of birth is supplied at the tap, not at hook-call time, and the
  // native round trip outlives the render that started it.
  const dobRef = useRef(undefined);
  const runningRef = useRef(false);

  // Posts whichever proof we ended up with and reports the result. `send` is a
  // thunk so the two paths share every line after the token exists.
  const exchange = async (send) => {
    const { onSuccess: ok, onError: fail, setBusy: busy } = handlers.current;
    busy?.(true);
    try {
      const data = await send();
      ok?.(data.user);
    } catch (err) {
      fail?.(err?.message || 'Google sign-in failed', err);
    } finally {
      busy?.(false);
    }
  };

  // Web / Android / anything that is not native iOS: byte-for-byte the flow
  // these screens already shipped — GIS popup, access token, same api call.
  const startWeb = useGoogleLogin({
    onSuccess: (tokenResponse) =>
      exchange(() => googleLoginWithToken(tokenResponse.access_token, dobRef.current)),
    onError: () => handlers.current.onError?.('Google sign-in failed'),
  });

  return (options) => {
    dobRef.current = options?.dob || undefined;

    if (!isNativeIos()) {
      startWeb();
      return;
    }

    (async () => {
      // The button is disabled while `busy` is set, but the native sheet is a
      // separate window and a second tap can still land underneath it. Two
      // concurrent GIDSignIn presentations is a hang on device.
      if (runningRef.current) return;
      runningRef.current = true;
      const { onError: fail, setBusy: busy } = handlers.current;
      try {
        let idToken;
        busy?.(true);
        try {
          idToken = await nativeGoogleIdToken();
        } catch (err) {
          // A dismissed sheet is not a failure to report, same rule as
          // AppleSignInButton.
          if (!isCancellation(err)) fail?.(err?.message || 'Google sign-in failed', err);
          return;
        } finally {
          busy?.(false);
        }
        await exchange(() => googleLogin(idToken, dobRef.current));
      } finally {
        runningRef.current = false;
      }
    })();
  };
}
