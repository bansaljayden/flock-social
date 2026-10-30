import React, { useEffect, useState } from 'react';
import { appleLogin, getAppleNonce, userMessage } from '../../services/api';

// Sign in with Apple button, wired to backend POST /api/auth/apple
// (JWKS-verified). It draws in two places, and nowhere else:
//
// - The iPhone app, through the native sheet, under the app's bundle id.
//   Apple guideline 4.8: an iOS app that offers any third-party login (we show
//   Google) MUST offer Apple's too.
// - flockcorp.com, through Apple's own JS in a popup, under the website's
//   Services ID. See THE WEBSITE below.
//
// Styling follows Apple's HIG white button style, which is the one Apple
// asks for on a dark background. It shares the `.auth-provider` class with
// the Google button beside it, so the two are identical in height, radius,
// type and weight — which is also what guideline 4.8 means by offering
// Sign in with Apple at equal prominence. The screens put it first.

const isNativeIos = () =>
  typeof window !== 'undefined' &&
  window.Capacitor?.isNativePlatform?.() &&
  window.Capacitor?.getPlatform?.() === 'ios';

// THE WEBSITE.
//
// Apple's JS (appleid.auth.js, from Apple's CDN) opens Apple's sign-in page in
// a popup and hands back what the native sheet does: an identity token, a
// one-use authorization code, and the person's name on the first authorization
// only. The Services ID is grouped with the app's bundle id in the Apple
// Developer portal, so an Apple ID has one user identifier on both and signs in
// to the same Flock account wherever it is used.
//
// Apple opens the popup only for a return URL registered on that Services ID,
// and exactly two are: /auth/apple/callback on the apex and on www. The popup
// posts its answer back to this page rather than visiting that URL, but the URL
// still has to name the page's own host, so the button is drawn on those two
// hosts only. On a preview deploy or a laptop Apple would refuse the popup,
// which is a dead button, so there it draws nothing and the screens lay out as
// they do without Apple.
export const APPLE_WEB_CLIENT_ID = 'com.flockcorp.flock.web';
export const APPLE_JS_SRC = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
export const APPLE_WEB_HOSTS = ['flockcorp.com', 'www.flockcorp.com'];
export const appleWebRedirectURI = (host) => `https://${host}/auth/apple/callback`;

const appleWebHost = () => {
  if (typeof window === 'undefined' || isNativeIos()) return null;
  const host = String(window.location?.hostname || '').toLowerCase();
  return APPLE_WEB_HOSTS.includes(host) ? host : null;
};

// Whether this button draws anything. Exported so a screen can lay itself out
// around it (the auth screens put the providers first when Apple is one of
// them) from the same test the button makes, rather than a second copy of it.
export const isAppleSignInAvailable = () => Boolean(isNativeIos() || appleWebHost());

// What a failure on the website says. Each one names the fix.
const APPLE_WEB_LOAD_FAILED = "Apple sign-in didn't load. Check your connection, then tap Continue with Apple again.";
const APPLE_WEB_DID_NOT_OPEN = "Apple's sign-in window didn't open. If your browser blocked it, allow pop-ups for this site, then tap Continue with Apple again.";
const APPLE_WEB_NOT_FINISHED = "Apple sign-in didn't finish. Tap Continue with Apple again.";

// Those three are written for people, so they are thrown marked as such and
// userMessage (services/api.js) lets them through to the screen.
const webError = (message) => Object.assign(new Error(message), { userFacing: true });

// What any other failure says. The native sheet rejects with Apple's own text,
// "The operation couldn't be completed. (com.apple.AuthenticationServices.
// AuthorizationError error 1000.)" and the like, which is written for a log and
// was shown word for word under the button. A failure that is neither the
// server's own sentence nor one of the lines above gets this one, and its
// detail goes to the console. The delete and export dialogs (reconfirm) have no
// email form to point at, so theirs stops at "Try again."
const APPLE_DID_NOT_FINISH = "Apple sign-in didn't finish. Try again, or use email.";
const APPLE_RECONFIRM_DID_NOT_FINISH = "Apple sign-in didn't finish. Try again.";

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
// never written to storage, and it dies with the page. The website's popup
// names no user identifier beside the token, so there it is read off the
// token itself (appleSubOf below).
let lastDelivered = null;

// FINISHING A NEW ACCOUNT WITHOUT A SECOND SHEET.
//
// A brand-new Apple account is answered 403 {needsDob, dobGranularity:'year'}
// wherever the server asks for a year: Apple never sends one, and the website
// asks every new account for it. That answer used to end the sheet's
// usefulness, so the person typed a year and then had to tap Continue with
// Apple and go through Apple's sheet a second time. App Review's first action
// on build 38 was exactly that path, as a new user.
//
// The second sheet was never needed. The server refuses at the date check,
// BEFORE the one-use authorization code is exchanged (backend/routes/auth.js,
// the exchange sits under "The code exchange is a gate"), and its identity
// token replay guard releases the claim on every refusal (the `finally` on
// the /apple route, R4-A1), precisely so the same credential can come back
// with a birthday. The website's nonce is spent only by a sign-in that
// completes, so it comes back with them. So on that 403 the credentials from
// this sheet are held in a closure, handed to the screen as `resume`, and sent
// again with the year.
//
// Memory only. They are never written to storage, never put in React state
// that devtools or a crash report could serialise, and the closure is dropped
// by the screen the moment it is used or fails.
//
// Apple's authorization code is single-use and lasts about five minutes, and
// the server has to exchange it, so a hold older than that is never sent.
// What happens instead is below, under PAST THE CODE'S FEW MINUTES.
export const APPLE_CODE_LIFETIME_MS = 5 * 60 * 1000;

export class AppleResumeExpiredError extends Error {
  constructor() {
    super('Apple sign-in timed out');
    this.name = 'AppleResumeExpiredError';
    this.expired = true;
  }
}

// A dismissed sheet. The button stays quiet about it and the step tells it
// apart from a failure, so every way of saying it is matched in one place: the
// plugin's two, and the codes Apple's JS rejects with when the popup is closed,
// cancelled, or replaced by a newer one.
const APPLE_WEB_DISMISSALS = ['popup_closed_by_user', 'user_cancelled_authorize', 'user_trigger_new_signin_flow'];
const isCancelled = (err) => APPLE_WEB_DISMISSALS.includes(err?.error)
  || /cancel|1001/i.test(String(err?.message || err));

// Apple's JS rejects with { error: '<code>' } and no message. A code that is
// not a dismissal means the window did not do its job. Anything else is shown
// only when it was written for people (the server's sentence, an under-13
// refusal among them, or one of the website's lines above); userMessage
// decides that and logs what it keeps off the screen.
const failureMessage = (err, fallback) => {
  if (err && !err.message && err.error) return APPLE_WEB_DID_NOT_OPEN;
  return userMessage(err, fallback);
};

// The native sheet, and what it handed over.
const openNativeSheet = async () => {
  const { SignInWithApple } = await import('@capacitor-community/apple-sign-in');
  const result = await SignInWithApple.authorize({
    clientId: 'com.flockcorp.flock',
    // api.flockcorp.com, not the Railway-generated host. Inert today (the
    // native ASAuthorization path ignores redirectURI), but the Railway name
    // is an implementation detail that changes if the service is ever
    // recreated, which is the reasoning services/emailService.js already pins
    // for every other URL we mint.
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
  return { identityToken: r.identityToken, fullName: delivered || remembered, authorizationCode: r.authorizationCode };
};

// Apple's script, fetched once per page and only on the two hosts above, so
// nothing of Apple's loads where the button is not drawn. A failed load is
// forgotten, so the next tap tries again.
let appleJsLoading = null;
const loadAppleJs = () => {
  if (window.AppleID?.auth) return Promise.resolve(window.AppleID);
  if (!appleJsLoading) {
    appleJsLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = APPLE_JS_SRC;
      script.async = true;
      script.onload = () => (window.AppleID?.auth ? resolve(window.AppleID) : reject(webError(APPLE_WEB_LOAD_FAILED)));
      script.onerror = () => { script.remove(); reject(webError(APPLE_WEB_LOAD_FAILED)); };
      document.head.appendChild(script);
    });
    appleJsLoading.catch(() => { appleJsLoading = null; });
  }
  return appleJsLoading;
};

// THE NONCE. Every popup carries one the server issued (POST /apple/nonce),
// and the server refuses a website token without it, so an identity token
// lifted from somewhere else cannot be played back here. It is fetched when
// the person reaches for the button (the pointer over it, a press, keyboard
// focus) and not when the page loads: the nonce route is a sign-in door,
// metered per address at ten a minute (backend server.js authLimiter), and a
// school on one Wi-Fi must not spend that on page views. It is held until a
// popup uses it, and a dismissed popup leaves it for the next tap. The server
// keeps one for ten minutes; this keeps it for nine.
const NONCE_FRESH_MS = 9 * 60 * 1000;
let heldNonce = null; // { value, at }
let nonceFetching = null;

const freshNonce = () => (heldNonce && Date.now() - heldNonce.at < NONCE_FRESH_MS ? heldNonce : null);

const fetchNonce = () => {
  if (!nonceFetching) {
    nonceFetching = getAppleNonce()
      .then((data) => {
        if (!data?.nonce) throw webError(APPLE_WEB_NOT_FINISHED);
        heldNonce = { value: data.nonce, at: Date.now() };
        return heldNonce;
      })
      .finally(() => { nonceFetching = null; });
  }
  return nonceFetching;
};

// The warm-up: everything the popup needs, so that at the tap it can open at
// once. Browsers allow a popup only while they still count the tap as its
// reason, and a tap that first has to wait on the network can outlast that.
export const warmAppleWeb = () => {
  if (!appleWebHost()) return;
  loadAppleJs().catch(() => {});
  if (!freshNonce()) fetchNonce().catch(() => {});
};

const randomState = () => {
  const bytes = new Uint8Array(16);
  if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

// The Apple user identifier, read off the identity token so the website keeps
// the app's one-delivery name rule (lastDelivered above). Not verified here and
// used for nothing else; the server verifies the token.
const appleSubOf = (idToken) => {
  try {
    const part = String(idToken).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
    return JSON.parse(window.atob(padded)).sub || null;
  } catch {
    return null;
  }
};

const openWebAppleSheet = async () => {
  const host = appleWebHost();
  if (!host) throw new Error('Sign in with Apple is not available on this page.');
  // Ready before the tap when the warm-up got there first, so the popup opens
  // inside the tap itself. Otherwise this waits for what is missing; most
  // browsers still allow the popup then, and one that does not lands on
  // APPLE_WEB_DID_NOT_OPEN with everything ready for the next tap.
  let AppleID = window.AppleID?.auth ? window.AppleID : null;
  let nonce = freshNonce();
  if (!AppleID || !nonce) {
    [AppleID, nonce] = await Promise.all([loadAppleJs(), nonce || fetchNonce()]);
  }
  // This popup has the nonce now.
  heldNonce = null;
  const state = randomState();
  let response;
  try {
    AppleID.auth.init({
      clientId: APPLE_WEB_CLIENT_ID,
      scope: 'name email',
      redirectURI: appleWebRedirectURI(host),
      state,
      nonce: nonce.value,
      usePopup: true,
    });
    response = await AppleID.auth.signIn();
  } catch (err) {
    // No token came back, so the nonce was never used: it stays for the next
    // tap, unless a newer one is already waiting.
    if (!heldNonce) heldNonce = nonce;
    throw err;
  }
  const auth = response?.authorization || {};
  // The state goes out with the popup and has to come back with its answer.
  if (!auth.id_token || auth.state !== state) throw webError(APPLE_WEB_NOT_FINISHED);
  const n = response.user?.name;
  const delivered = (n?.firstName || n?.lastName)
    ? { givenName: n.firstName || '', familyName: n.lastName || '' }
    : undefined;
  const user = appleSubOf(auth.id_token);
  if (delivered) lastDelivered = user ? { user, fullName: delivered } : null;
  const remembered = lastDelivered && user && lastDelivered.user === user
    ? lastDelivered.fullName
    : undefined;
  return {
    identityToken: auth.id_token,
    fullName: delivered || remembered,
    authorizationCode: auth.code,
    nonce: nonce.value,
  };
};

// Apple's sheet, and what it handed over. Shared by the button's tap and by a
// hold that has outlived the code, so the name rule above (lastDelivered) is
// applied the same way to both.
const openAppleSheet = () => (isNativeIos() ? openNativeSheet() : openWebAppleSheet());

// What goes with the credentials as appleLogin's options, and only when there
// is something to send, so a plain native sign-in calls it exactly as it
// always has.
const loginOpts = (held, extra) => {
  const opts = { ...extra, ...(held?.nonce ? { nonce: held.nonce } : {}) };
  return Object.keys(opts).length ? [opts] : [];
};

const makeResume = (first) => {
  let held = first;
  let heldAt = Date.now();
  let used = false;
  return async (dob, dobGranularity) => {
    // One use. A second call, whatever happened to the first, is a stale
    // handle, and the server would refuse a spent credential anyway.
    if (used) throw new AppleResumeExpiredError();
    // PAST THE CODE'S FEW MINUTES the held code is worth nothing. This used
    // to refuse without posting, and the step then put the Apple button back
    // under a sentence saying so: a Continue that did nothing, then a second
    // tap and a sheet. Now this tap opens Apple's sheet itself and the year
    // already typed goes with what the new sheet hands over, so the Continue
    // the person pressed still finishes the account. A dismissed sheet has
    // sent nothing, so the handle stays good and the next Continue opens it
    // again.
    if (Date.now() - heldAt > APPLE_CODE_LIFETIME_MS) {
      try {
        held = await openAppleSheet();
      } catch (err) {
        if (isCancelled(err)) throw Object.assign(new Error('Apple sign-in was cancelled'), { cancelled: true });
        used = true;
        throw err;
      }
      heldAt = Date.now();
    }
    used = true;
    let data;
    try {
      data = await appleLogin(held.identityToken, held.fullName, held.authorizationCode, dob,
        ...loginOpts(held, dobGranularity ? { dobGranularity } : {}));
    } catch (err) {
      // Kept only when the request provably never reached Flock: offline, which
      // api.js refuses before sending, or a captive portal answering in Flock's
      // place. Any other connection failure may have landed after the server
      // accepted them (a lost 200), and a retry would only spend a 401.
      if (err?.isOffline || err?.isCaptivePortal) used = false;
      throw err;
    }
    // Accepted, so the same rule as a first-tap success: forget the name.
    lastDelivered = null;
    return data;
  };
};

// `dob` (optional): passed through on account CREATION — the server requires a
// date of birth for new accounts on every auth path (age gate). Existing
// accounts sign in fine without it.
//
// `beforeAuthorize` (optional): called on the tap, before Apple's sheet opens.
// Return false and nothing happens. It exists because this button is the one
// sign-in path a screen cannot re-enter on the user's behalf, since the native
// sheet and the website's popup both need this button's own tap. A screen with
// something to settle with the user first (the sign-in screen's date-of-birth
// read-back) therefore has to be able to stop the tap rather than undo what it
// did.
// `dobGranularity` (optional): 'year' when `dob` was derived from a typed
// birth year, so the server can refuse to write it onto an existing account.
// `className` / `style` (optional): the auth screens' .auth-provider look is
// the default; that stylesheet only exists while AuthShell is mounted, so a
// caller inside the app (OAuthReconfirm, in the delete and export dialogs)
// passes the same look inline. The title stays Apple's own either way.
// `reconfirm` (optional): the signed-in person proving it again (the delete and
// export dialogs), not a sign-in, so appleLogin skips the login analytics; see
// opts.reconfirm in services/api.js.
const AppleSignInButton = ({ onSuccess, onError, dob, dobGranularity, beforeAuthorize, className = 'auth-provider', style, reconfirm }) => {
  const [busy, setBusy] = useState(false);
  const onWebsite = !isNativeIos() && Boolean(appleWebHost());

  // Apple's script comes with the button. It is Apple's CDN, not a Flock
  // route, so it costs the sign-in meter nothing; the nonce waits for intent.
  useEffect(() => {
    if (onWebsite) loadAppleJs().catch(() => {});
  }, [onWebsite]);

  if (!isAppleSignInAvailable()) return null;

  const handleClick = async () => {
    if (busy) return;
    if (beforeAuthorize && beforeAuthorize() === false) return;
    setBusy(true);
    // What this sheet handed over, kept only for the catch below.
    let held = null;
    try {
      // Called before anything is awaited, so on the website the popup opens
      // inside this tap when the warm-up has everything ready.
      held = await openAppleSheet();
      const data = await appleLogin(held.identityToken, held.fullName, held.authorizationCode, dob,
        ...loginOpts(held, {
          ...(dobGranularity ? { dobGranularity } : {}),
          ...(reconfirm ? { reconfirm: true } : {}),
        }));
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
      //
      // The third argument is `resume`, and only on the creation 403 that asks
      // for a year: see makeResume above. Every other refusal gets none.
      const resume = held && err?.data?.needsDob && err.data.dobGranularity === 'year'
        ? makeResume(held)
        : undefined;
      held = null;
      // On the website a held sign-in may have to reopen the popup once its
      // code has run out (PAST THE CODE'S FEW MINUTES), and that tap should
      // find a nonce ready, so one is fetched while the year is typed.
      if (resume && onWebsite) fetchNonce().catch(() => {});
      if (isCancelled(err)) return;
      // The message is worked out only for a real failure, so a dismissed
      // sheet is not logged as one.
      onError?.(failureMessage(err, reconfirm ? APPLE_RECONFIRM_DID_NOT_FINISH : APPLE_DID_NOT_FINISH), err, resume);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={className}
      onClick={handleClick}
      onPointerEnter={onWebsite ? warmAppleWeb : undefined}
      onPointerDown={onWebsite ? warmAppleWeb : undefined}
      onTouchStart={onWebsite ? warmAppleWeb : undefined}
      onFocus={onWebsite ? warmAppleWeb : undefined}
      disabled={busy}
      style={{ ...style, color: '#000000' }}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ marginTop: '-2px' }}>
        <path d="M17.05 12.54c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.87-.76-1.48.02-2.84.86-3.6 2.18-1.53 2.66-.39 6.6 1.1 8.76.73 1.06 1.6 2.24 2.74 2.2 1.1-.05 1.52-.71 2.85-.71 1.33 0 1.7.71 2.87.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.4 1.2-2.46-.03-.01-2.28-.88-2.3-3.48zM14.9 5.6c.6-.74 1.01-1.76.9-2.78-.87.04-1.93.58-2.56 1.31-.56.65-1.05 1.69-.92 2.68.97.08 1.97-.49 2.58-1.21z" />
      </svg>
      {busy ? 'Signing in…' : 'Continue with Apple'}
    </button>
  );
};

export default AppleSignInButton;

// Test seam: module state is per page in the browser, and per test file here.
export const __resetAppleWebForTests = () => {
  lastDelivered = null;
  appleJsLoading = null;
  heldNonce = null;
  nonceFetching = null;
};
