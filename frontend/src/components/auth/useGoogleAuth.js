import { useRef } from 'react';
import { useGoogleLogin } from '@react-oauth/google';
import { googleLogin, googleLoginWithToken, userMessage } from '../../services/api';

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

// NO CLIENT ID, NO GOOGLE LIBRARY. @react-oauth/google calls
// google.accounts.oauth2.initTokenClient({ client_id }) from an effect as soon
// as Google's script loads, and with an empty id that THROWS ("Missing required
// parameter client_id") inside the hook every auth screen calls: the whole
// sign-in screen went to the crash screen, email and password included, and so
// did every browser test on the local stack, whose build carries no id. The id
// is inlined at build time, so this is decided once per build and the hook
// order never changes between renders.
export const WEB_GOOGLE_CONFIGURED = Boolean(process.env.REACT_APP_GOOGLE_CLIENT_ID);
const useWebGoogleLogin = WEB_GOOGLE_CONFIGURED ? useGoogleLogin : () => null;

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
  //
  // forcePrompt, ALWAYS (2026-11-22). Without it the plugin first tries
  // GIDSignIn's restorePreviousSignIn (GoogleProvider.swift), which hands back
  // the ID token it already holds, unchanged, for most of that token's hour.
  // The server makes every Google ID token single use (routes/auth.js
  // claimOauthIdentity), so a "Confirm it's you" more than five minutes after
  // a Google sign-in (users.js hasFreshSession) sent the same token again and
  // was answered "Google sign-in expired, please try again" on every tap for up
  // to an hour, with no Google sheet ever shown. forcePrompt skips the restore
  // and runs GIDSignIn.signIn, which shows Google's sheet and mints a new
  // token. On a phone with no saved Google session it changes nothing; where
  // one is saved (a lost response, a reinstall, a sign-out whose plugin logout
  // did not land) the restore was either refused or a silent sign-in as the
  // previous Google user. Needs a real iPhone before the build ships.
  const res = await SocialLogin.login({ provider: 'google', options: { forcePrompt: true } });
  const idToken = res?.result?.idToken;
  if (!idToken) throw new Error('Google sign-in did not return a token');
  return idToken;
}

const isCancellation = (err) =>
  err?.code === 'USER_CANCELLED' || /cancel/i.test(String(err?.message || ''));

// What a failure says when it is not the server's own sentence. The native
// SDK rejects with text written for a log ("No presenting view controller
// found" reached the sign-in screen as it was), and so does a sheet that hands
// back no token; userMessage (services/api.js) shows a message only when it
// was written for people, logs the rest and uses this line instead. A
// dismissed sheet still says nothing. The delete and export dialogs
// (reconfirm) have no email form to point at, so theirs stops at "Try again."
const didNotFinish = (reconfirm) => (reconfirm
  ? "Google sign-in didn't finish. Try again."
  : "Google sign-in didn't finish. Try again, or use email.");

// FINISHING A NEW ACCOUNT WITHOUT A SECOND SHEET.
//
// A brand-new Google account that arrives with no birth year is answered
// 403 {needsDob, dobGranularity:'year'}. The server refuses before it creates
// anything and hands the credential's replay claim back on every refusal (the
// `finally` on POST /api/auth/google), precisely so the same proof can come
// back with a year. So on that one answer the proof this sheet produced is
// kept in a closure and handed to the screen as a third argument to onError,
// `resume(dob, dobGranularity)`, the same shape as the Apple button's. A
// screen that has the year asked in place posts it with the proof it already
// has, and nobody goes through Google's sheet twice.
//
// Memory only, one use, and short. A Google token lives about an hour, but
// holding a live credential for longer than it takes to type four digits buys
// nothing, so past GOOGLE_RESUME_LIFETIME_MS the held proof is never sent.
//
// What happens instead depends on where. In the iOS app `reopen` is given:
// the Continue the person pressed opens Google's sheet itself and the year
// goes with the new token, so it is still one step, the way Apple's is (see
// makeResume in AppleSignInButton.js). A dismissed sheet sends nothing and
// the next Continue opens it again.
//
// On the web there is no `reopen`, and the handle refuses without posting so
// the screen puts the Google button back. That is deliberate. GIS's popup
// hands its token to a callback, and whether a popup that was blocked or
// closed is ever reported depends on the browser, and it is never reported
// when Google's script has not loaded, because the starter then does nothing
// at all. A Continue waiting on that could stay "Signing in" for good. The
// Google button starts the popup from its own tap and waits on nothing, so it
// costs one more tap but can never hang.
export const GOOGLE_RESUME_LIFETIME_MS = 5 * 60 * 1000;

// THE SAME HOLD, FOR "CREATE ACCOUNT". The sign-in screen sends intent
// 'signin', and a Google account with no Flock account behind it is then
// answered 409 {noAccount, canCreate} with nothing written and the claim
// handed back, exactly as the year ask is (services/api.js, opts.intent). So
// that answer gets a handle too, bound to intent 'create', and the sign-in
// screen's Create account posts the same proof with it (LoginScreen.js, NO
// FLOCK ACCOUNT YET). Every rule above holds unchanged: one use, memory only,
// past five minutes a new sheet in the app and the Google button back on the
// web.
//
// A handle carries its intent to every post it makes, so a create that the
// website then answers with the year ask comes back with a handle of its own
// on the error (`err.resume`), bound to 'create' as well and counting from the
// same sheet: the year step finishes the account the person asked for, and
// the five minutes are the proof's, not the handle's.
const isYearAsk = (err) => Boolean(err?.data?.needsDob && err.data.dobGranularity === 'year');

const makeResume = (first, reopen, intent, since = Date.now()) => {
  let post = first;
  let heldAt = since;
  let used = false;
  return async (dob, dobGranularity) => {
    if (used) throw Object.assign(new Error('Google sign-in timed out'), { expired: true });
    if (Date.now() - heldAt > GOOGLE_RESUME_LIFETIME_MS) {
      if (!reopen) {
        used = true;
        throw Object.assign(new Error('Google sign-in timed out'), { expired: true });
      }
      try {
        post = await reopen();
      } catch (err) {
        // Dismissed: nothing was sent, so the handle stays good.
        if (isCancellation(err)) throw Object.assign(new Error('Google sign-in was cancelled'), { cancelled: true });
        used = true;
        throw err;
      }
      heldAt = Date.now();
    }
    used = true;
    try {
      return await post(dob, dobGranularity, intent);
    } catch (err) {
      // Kept only when the request provably never reached Flock: offline,
      // which api.js refuses before sending, or a captive portal answering in
      // Flock's place. Anything else may have landed.
      if (err?.isOffline || err?.isCaptivePortal) used = false;
      else if (isYearAsk(err)) err.resume = makeResume(post, reopen, intent, heldAt);
      throw err;
    }
  };
};

// The one answer that gets the Create account handle: the sign-in screen's
// own tap, refused for having no account, with the server saying one may be
// made.
const isCreatableNoAccount = (err, intent) => intent === 'signin'
  && Boolean(err?.data?.noAccount && err.data.canCreate);

// A dismissed native sheet that had been open this long may not have been
// dismissed by the person at all. When Google blocks an account (a school or
// Workspace "Access blocked" page), the person closes that page and
// GoogleSignIn reports it as a cancel, the same as a tap on Cancel, so Flock
// said nothing and the button looked broken. A real change of mind is quick;
// reading a refusal and closing it is not. So past this a screen may show a
// quiet hint (opts.onSlowDismiss), and a quick dismissal still shows nothing.
export const GOOGLE_SLOW_DISMISS_MS = 3000;
export const GOOGLE_BLOCKED_HINT = "Google didn't let you in? School accounts are often blocked. Use Apple, email, or a personal Google account.";

// The optional third argument of both api calls, spelled once.
const granularityArg = (dobGranularity) => (dobGranularity ? [{ dobGranularity }] : []);

/**
 * @param {object}   opts
 * @param {function} opts.onSuccess  called with the signed-in user
 * @param {function} opts.onError    (message, error, resume?). The raw error
 *   is the second argument so a screen can read `err.data.needsDob`. The
 *   server answers 403 {needsDob:true} when a brand-new OAuth account arrives
 *   without a date of birth, and a screen that only sees the message string
 *   cannot offer the retry field. `resume` comes only with the creation 403
 *   that asks for a year, and with the sign-in screen's noAccount answer (THE
 *   SAME HOLD, FOR "CREATE ACCOUNT" above). Identical on both paths.
 * @param {function} [opts.setBusy]  toggled around the whole exchange
 * @param {boolean}  [opts.reconfirm] the signed-in person proving it again
 *   (the delete and export dialogs), not a sign-in: the token is stored as
 *   usual and the login analytics are skipped (opts.reconfirm in
 *   services/api.js)
 * @param {string}   [opts.intent] 'signin' or 'create', sent with every post
 *   (opts.intent in services/api.js). A tap can name its own: `start({ intent })`.
 * @param {function} [opts.onSlowDismiss] native iOS only: Google's sheet was
 *   dismissed after GOOGLE_SLOW_DISMISS_MS, which may have been Google
 *   refusing the account (see that constant)
 * @returns {function} start — call it as `start()` or `start({ dob })`
 */
export default function useGoogleAuth({ onSuccess, onError, setBusy, reconfirm, intent, onSlowDismiss }) {
  // Handlers are inline arrows in the screens, so they change identity every
  // render; a ref refreshed here is what keeps the async paths below calling
  // the CURRENT ones instead of the ones captured when the flow started.
  const handlers = useRef({});
  handlers.current = { onSuccess, onError, setBusy, reconfirm, onSlowDismiss };
  // The intent of the tap in flight, set at the tap like the date below: the
  // web popup answers long after the render that started it.
  const intentRef = useRef(undefined);

  // The date of birth is supplied at the tap, not at hook-call time, and the
  // native round trip outlives the render that started it.
  const dobRef = useRef(undefined);
  // 'year' when dobRef holds a date derived from a typed birth year. Travels
  // with the date so the server can refuse to write it onto an existing row.
  const dobGranularityRef = useRef(undefined);
  const runningRef = useRef(false);

  // The trailing options argument for the api call, sent only when it holds
  // something, so a plain sign-in calls it exactly as it always has: the
  // year-only birth date when that is what was given, and reconfirm when the
  // signed-in person is proving it again inside a dialog, and the screen's
  // intent when it has one.
  const loginOpts = (dobGranularity, postIntent) => {
    const opts = {
      ...granularityArg(dobGranularity)[0],
      ...(handlers.current.reconfirm ? { reconfirm: true } : {}),
      ...(postIntent ? { intent: postIntent } : {}),
    };
    return Object.keys(opts).length ? [opts] : [];
  };

  // Posts whichever proof we ended up with and reports the result. `post` is
  // (dob, dobGranularity, intent) => the api call, so the two paths share
  // every line after the token exists, and a creation 403 or the sign-in
  // screen's noAccount can hand the same call back as `resume` to be made
  // again. `reopen`, native only, is how that resume gets a new token once
  // the held one is past its minutes.
  const exchange = async (post, reopen) => {
    const { onSuccess: ok, onError: fail, setBusy: busy } = handlers.current;
    const tapIntent = intentRef.current;
    busy?.(true);
    try {
      const data = await post(dobRef.current, dobGranularityRef.current, tapIntent);
      ok?.(data.user);
    } catch (err) {
      const message = userMessage(err, didNotFinish(handlers.current.reconfirm));
      if (isYearAsk(err)) fail?.(message, err, makeResume(post, reopen, tapIntent));
      else if (isCreatableNoAccount(err, tapIntent)) fail?.(message, err, makeResume(post, reopen, 'create'));
      else fail?.(message, err);
    } finally {
      busy?.(false);
    }
  };

  // The native post for a given ID token, spelled once for the tap and for a
  // held sign-in's new sheet.
  const nativePost = (idToken) => (dob, dobGranularity, postIntent) => googleLogin(idToken, dob,
    ...loginOpts(dobGranularity, postIntent));

  // Google's sheet again, for a held sign-in past its minutes. Behind the same
  // guard as a tap: two GIDSignIn presentations at once hang on device, and a
  // sheet already up counts as this one dismissed, so nothing is sent.
  const reopenNative = async () => {
    if (runningRef.current) throw Object.assign(new Error('Google sign-in was cancelled'), { code: 'USER_CANCELLED' });
    runningRef.current = true;
    try {
      return nativePost(await nativeGoogleIdToken());
    } finally {
      runningRef.current = false;
    }
  };

  // Web / Android / anything that is not native iOS: byte-for-byte the flow
  // these screens already shipped — GIS popup, access token, same api call.
  const startWebGoogle = useWebGoogleLogin({
    onSuccess: (tokenResponse) =>
      exchange((dob, dobGranularity, postIntent) => googleLoginWithToken(tokenResponse.access_token, dob,
        ...loginOpts(dobGranularity, postIntent))),
    // GIS answers with an OAuth error code (access_denied and the like): a
    // detail for the console, not a sentence for the screen.
    onError: (response) => {
      console.warn('[flock] Google sign-in did not finish:', response?.error || response);
      handlers.current.onError?.(didNotFinish(handlers.current.reconfirm));
    },
  });
  const startWeb = startWebGoogle || (() => handlers.current.onError?.('Google sign-in is not set up in this build.'));

  return (options) => {
    dobRef.current = options?.dob || undefined;
    dobGranularityRef.current = options?.dobGranularity || undefined;
    intentRef.current = options?.intent || intent || undefined;

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
        const openedAt = Date.now();
        try {
          idToken = await nativeGoogleIdToken();
        } catch (err) {
          // A dismissed sheet is not a failure to report, same rule as
          // AppleSignInButton. Anything else is the SDK's own words, which are
          // logged rather than shown (didNotFinish above). One that stayed
          // open a while may have been Google's refusal (GOOGLE_SLOW_DISMISS_MS).
          if (isCancellation(err)) {
            if (Date.now() - openedAt > GOOGLE_SLOW_DISMISS_MS) handlers.current.onSlowDismiss?.();
          } else {
            fail?.(userMessage(err, didNotFinish(handlers.current.reconfirm)), err);
          }
          return;
        } finally {
          busy?.(false);
        }
        await exchange(nativePost(idToken), reopenNative);
      } finally {
        runningRef.current = false;
      }
    })();
  };
}
