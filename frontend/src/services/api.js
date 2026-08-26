const BASE_URL = process.env.REACT_APP_API_URL || 'https://flock-app-production.up.railway.app';

// Analytics — a tracking failure must never break a real request. Users are
// identified by their id only; no email or name goes to PostHog.
//
// posthog-js is pulled in with a dynamic import and only when a key is
// configured, so a build with analytics switched off never ships the SDK at
// all. index.js owns init() (including the guest-invite-token scrub in
// before_send); this module only reaches for the singleton, which is the same
// webpack module instance either way. Calls that land before init are dropped
// exactly as they were when this was a static import.
let posthogPromise = null;
function withPostHog(fn) {
  if (!process.env.REACT_APP_POSTHOG_KEY) return;
  if (!posthogPromise) {
    posthogPromise = import('posthog-js').then((m) => m.default).catch(() => null);
  }
  posthogPromise.then((posthog) => {
    if (!posthog) return;
    try { fn(posthog); } catch (_) { /* analytics only */ }
  });
}

function track(event, props) {
  withPostHog((posthog) => posthog.capture(event, props));
}
function identifyUser(user) {
  if (!user?.id) return;
  withPostHog((posthog) => posthog.identify(String(user.id)));
}

function getToken() {
  return localStorage.getItem('flockToken');
}

function setToken(token) {
  localStorage.setItem('flockToken', token);
  sessionExpiryAnnounced = false; // fresh session, the expiry notice may fire again someday
}

/**
 * SIGN-OUT — what leaves the device, and what stays.
 *
 * Flock's audience is 13-22 and borrowed phones are normal, so everything the
 * signed-in account wrote to this device has to go when they sign out. It used
 * to be three keys (flockToken, flockUserMode, flockVenueOnboardingComplete),
 * which left the previous user's last known location, pinned venues, interests
 * and deleted-DM list sitting there for whoever signed in next.
 *
 * The rule here is DEFAULT DENY: every key this app owns is namespaced
 * `flock*`, so sign-out removes every `flock*` key except the handful listed
 * in KEEP_ON_SIGN_OUT below. A prefix family like `flock_checkin_<placeId>`
 * therefore needs no enumeration, and a key added next month is covered
 * without anyone remembering to come back here.
 *
 * The full inventory as of this change (derived by grepping localStorage
 * writes across frontend/src), for the reader deciding where a new key goes:
 *
 *   CLEARED — belongs to the account, not the handset:
 *     flockToken                 the credential itself
 *     flockUserMode              user / venue / admin surface
 *     flockOnboardingComplete    per-account onboarding
 *     flockVenueOnboardingComplete
 *     flockBirdBest              the bird game's personal high score
 *     flock_user_lat/_lng        last known location. The worst leak of the set
 *     flock_deleted_dms          which DMs this person hid
 *     flock_pinned, flock_order  their flock list, pinned and ordered
 *     flock_interests            their tastes
 *     flock_checkin_<placeId>    where they physically were, and when
 *     flock_loc_dismissed        which location prompts they dismissed
 *     flock_safety_on            safety toggle. Server-side per account
 *     flock_crowd_alerts         push opt-out. Server-side per account
 *     flock_location_enabled     their location consent, re-asked per account
 *     flock_birdie_corner, flock_sos_corner   synced per account
 *     flock_push_token           the FCM registration this session owned
 *     flock_pending_invite       an invite stashed for whoever redeems it
 *     flock_guest_<token>        a guest identity from an invite page
 *
 *   KEPT — device facts, nothing personal in them, and every one of them is
 *   overwritten by pullSettings() the moment the next account signs in:
 *     flock-theme, flock-theme-mode   dark/light. Dropping it means the next
 *                                     person gets a flash of the wrong theme
 *                                     for zero privacy gain.
 *     flock_map_type                  street vs satellite. A display choice.
 *     flock_notif_denied              this BROWSER denied notification
 *                                     permission. That is true of the handset
 *                                     regardless of who holds it; clearing it
 *                                     just re-prompts into a denial.
 *
 * sessionStorage is not written anywhere in the app today. It is swept on the
 * same rule anyway so a future writer is covered by default rather than by
 * remembering. Cookies are deliberately absent: the JWT rides in a header and
 * Flock sets no auth cookie at all, so there is nothing there to clear.
 */
const KEEP_ON_SIGN_OUT = new Set([
  'flock-theme',
  'flock-theme-mode',
  'flock_map_type',
  'flock_notif_denied',
]);

function sweepStore(store) {
  if (!store) return;
  // Snapshot the names first: removing while iterating a live Storage
  // re-indexes it and silently skips keys.
  const keys = [];
  for (let i = 0; i < store.length; i += 1) {
    const key = store.key(i);
    if (key && key.startsWith('flock') && !KEEP_ON_SIGN_OUT.has(key)) keys.push(key);
  }
  keys.forEach((key) => {
    try { store.removeItem(key); } catch (_) { /* see below */ }
  });
}

/**
 * THE ONE CREDENTIAL THAT IS NOT IN localStorage.
 *
 * On iOS, "Continue with Google" runs Google's own SDK through
 * @capgo/capacitor-social-login (see components/auth/useGoogleAuth.js for why
 * the web GIS popup cannot work inside the WebView). GIDSignIn keeps its own
 * session in the iOS keychain, which is a store this file's sweep cannot see
 * and the server cannot reach. So the wipe above could clear every flock* key
 * perfectly and the previous user would still be ONE TAP from signing back in:
 * hand the phone over, tap Continue with Google, and the native sheet
 * completes against the account that is still authenticated, with no password.
 * That is the shared-phone leak the sweep exists to close, one layer down.
 *
 * THREE RULES, and each of them is why this is shaped the way it is:
 *
 *  1. NATIVE iOS ONLY. The guard is read off the injected window.Capacitor
 *     global rather than by importing @capacitor/core, the same way
 *     useGoogleAuth.js and AppleSignInButton.js decide it — the web bundle
 *     must not pull the native runtime in. It is duplicated here rather than
 *     imported from useGoogleAuth.js on purpose: that module imports THIS one,
 *     and it also imports React and @react-oauth/google, none of which belong
 *     in the dependency graph of the API client.
 *  2. LAZILY IMPORTED. The dynamic import sits behind the guard, so a web
 *     sign-out never fetches the plugin chunk at all.
 *  3. IT CANNOT BLOCK OR BREAK SIGN-OUT. Fire and forget: no await, and the
 *     promise's rejection is swallowed. The plugin can be absent, disabled in
 *     capacitor.config.ts, or reject outright (it does when Google was
 *     initialized in offline mode, and when the GoogleSignIn dependency is not
 *     linked) and the local wipe has already happened regardless. Same
 *     property the server call has: signing out in a basement with no signal
 *     still signs you out of the phone.
 */
function endNativeGoogleSession() {
  try {
    const native =
      typeof window !== 'undefined' &&
      window.Capacitor?.isNativePlatform?.() &&
      window.Capacitor?.getPlatform?.() === 'ios';
    if (!native) return;
    import('@capgo/capacitor-social-login')
      .then((m) => m.SocialLogin?.logout({ provider: 'google' }))
      .catch(() => { /* see rule 3: sign-out has already happened */ });
  } catch (_) { /* same */ }
}

/**
 * Wipe this device's copy of the signed-in account. Synchronous and total: it
 * never awaits anything, so no failure anywhere can leave a half-signed-out
 * device. Every caller that ends a session goes through here — logout(), the
 * 401 handler, and account deletion — so there is exactly one answer to "what
 * does sign-out clear".
 *
 * Safari private mode and "block all cookies" make storage access throw rather
 * than return null, and a throw here would abort a sign-out. Hence the guards.
 */
export function clearLocalSession() {
  try { sweepStore(window.localStorage); } catch (_) { /* storage blocked */ }
  try { sweepStore(window.sessionStorage); } catch (_) { /* storage blocked */ }
  // Round 3: without reset, activity on a shared device stays attributed to
  // the previous account, and the next login can merge identities.
  withPostHog((posthog) => posthog.reset());
  // LAST, and after the storage sweep has already run, so nothing this touches
  // can come between a user tapping Log out and their data leaving the device.
  endNativeGoogleSession();
}

/**
 * NETWORK RELIABILITY — read before changing request().
 *
 * Flock's users are teenagers on phone data: subway platforms, venue
 * basements, the walk between wifi and cellular. Three rules hold here:
 *
 *  1. Nothing hangs forever. Every request runs under an abort timeout, so a
 *     connection that silently dies settles in seconds instead of whenever
 *     the OS gives up. Callers' finally blocks and spinners always run.
 *  2. Reads retry, writes never do. GETs get two automatic retries with
 *     backoff on network failures and 502/503/504, because a blip while
 *     loading a feed should be invisible. Anything non-GET is sent exactly
 *     once: re-POSTing through a flaky connection is how duplicate flocks,
 *     duplicate messages and duplicate bills happen. If a write fails, the
 *     user sees an honest error and decides whether to try again.
 *  3. Errors speak human and carry flags. navigator.onLine false is "you're
 *     offline" (the OfflineGate in App.js is already up for that); a fetch
 *     that dies while online is "couldn't reach Flock"; an abort is a
 *     timeout. Machine-readable: err.status, err.code, err.data plus
 *     err.isOffline / err.isNetworkError / err.isTimeout / err.sessionExpired.
 */
const DEFAULT_TIMEOUT_MS = 15000;
const UPLOAD_TIMEOUT_MS = 90000; // uploads on weak signal are slow, not stuck
const AI_TIMEOUT_MS = 60000; // Birdie can legitimately think for a while
const RETRYABLE_STATUSES = [502, 503, 504];
const RETRY_DELAYS_MS = [800, 2000];

function isOffline() {
  // Per spec, false means definitely offline; true just means "maybe".
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function connectionError() {
  if (isOffline()) {
    const err = new Error("You're offline. This will work again once you're back on signal.");
    err.isOffline = true;
    err.isNetworkError = true;
    return err;
  }
  const err = new Error("Couldn't reach Flock. Give it a second and try again.");
  err.isNetworkError = true;
  return err;
}

function timeoutError() {
  const err = new Error('That took too long. Check your signal and try again.');
  err.isTimeout = true;
  err.isNetworkError = true;
  return err;
}

// Venue wifi with a sign-in page. The captive portal answers every request
// itself: 200 OK, an HTML login page, no matter what URL was asked for. Every
// endpoint here speaks JSON, so a 2xx that is not JSON means the reply never
// came from Flock at all. Before this guard, that HTML page was returned to
// the caller as if it were data, and getFlocks().flocks (etc.) blew up with a
// TypeError deep in App.js instead of an honest connection error. Not retried:
// the portal answers instantly and identically every time, so the only fix is
// the user signing in to the network or leaving it.
function captivePortalError() {
  const err = new Error('This network is blocking Flock. If this wifi has a sign-in page, open it, or switch to cellular data.');
  err.isNetworkError = true;
  err.isCaptivePortal = true;
  return err;
}

// A 2xx whose JSON body could not be read: the connection died mid-download,
// after the status line arrived. For a GET this is just a network blip and is
// retried like one. For a write it is genuinely ambiguous — the server most
// likely committed before the reply was lost — so the copy tells the user to
// check before firing the same write again, instead of inviting a double-post
// with a plain "try again".
function badReplyError(method) {
  const err = new Error(method === 'GET'
    ? "Couldn't reach Flock. Give it a second and try again."
    : 'Your signal dropped mid-reply. That may have gone through, so check before trying it again.');
  err.isNetworkError = true;
  err.isBadReply = true;
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    // Both failure modes become errors with copy a person can act on. The
    // raw TypeError ("Failed to fetch") used to surface verbatim in every
    // catch block that renders err.message.
    if (e && e.name === 'AbortError') throw timeoutError();
    throw connectionError();
  } finally {
    clearTimeout(timer);
  }
}

// Distinguishes "the body said null" from "the body could not be read at
// all". On an error status the difference is cosmetic (the status code is the
// signal); on a 2xx it is the difference between returning data and returning
// a lie, so request() checks for this sentinel before handing data back.
const PARSE_FAILED = Symbol('flock-parse-failed');

async function parseBody(res) {
  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    // A body that dies mid-download, or a proxy error page mislabeled as
    // JSON, must not surface as a SyntaxError.
    return res.json().catch(() => PARSE_FAILED);
  }
  return res.text().catch(() => PARSE_FAILED);
}

// Guard a 2xx before it is returned as data. Every endpoint is JSON, so a
// success that is not usable JSON is a network problem wearing a 200. Returns
// the error to throw, or null when the reply is genuine.
function badResponseGuard(res, data, method) {
  if (res.status === 204) return null;
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return captivePortalError();
  if (data === PARSE_FAILED) return badReplyError(method);
  return null;
}

// Mid-session token death (24h JWT expiry, password change, account claim).
// Without this, every request fails 401 forever while the UI looks merely
// flaky. We clear the token so isLoggedIn() goes false and the next boot
// lands on sign-in, and we announce it once: App.js listens for 'flock-toast'
// and routes to sign-in on 'flock-session-expired'; socket.js tears down its
// connection on the same event so the dead token stops being re-presented.
//
// Exclusions: the auth flows themselves (a wrong password is 401 and is not
// an expired session), requests that carried no token, and account deletion
// answering { reauthRequired } (that 401 is a re-prompt, not a dead session).
// '/api/auth/logout' covers '/api/auth/logout-all' too: a 401 while telling
// the server we are leaving is not an expired session needing a notice — we
// are signing out on this device either way, and announcing "your session
// expired" over a sign-out the user asked for is a lie with a toast on it.
const AUTH_FLOW_PREFIXES = ['/api/auth/login', '/api/auth/signup', '/api/auth/google', '/api/auth/apple', '/api/auth/logout'];
let sessionExpiryAnnounced = false;
const SESSION_EXPIRED_COPY = 'Your session expired. Sign in again to pick up where you left off.';

function handleSessionExpiry(endpoint, hadToken, data) {
  if (!hadToken) return false;
  if (AUTH_FLOW_PREFIXES.some((p) => endpoint.startsWith(p))) return false;
  if (data && typeof data === 'object' && data.reauthRequired) return false;
  // A dead token is a sign-out, so it clears what a sign-out clears. Dropping
  // only the token here was the second half-clearing path that let the
  // previous user's location and deleted-DM list outlive their session.
  clearLocalSession();
  if (typeof window !== 'undefined' && !sessionExpiryAnnounced) {
    sessionExpiryAnnounced = true;
    window.dispatchEvent(new CustomEvent('flock-session-expired'));
    window.dispatchEvent(new CustomEvent('flock-toast', {
      detail: { message: SESSION_EXPIRED_COPY, type: 'info' },
    }));
  }
  return true;
}

function buildHttpError(res, data, endpoint, hadToken) {
  let message = data && typeof data === 'object'
    ? (data.error || data.errors?.[0]?.msg)
    : data;
  // A gateway 502/503/504 body is an HTML error page, not display copy.
  if (typeof message === 'string' && message.trim().startsWith('<')) message = null;
  const expired = res.status === 401 && handleSessionExpiry(endpoint, hadToken, data);
  if (expired) {
    message = SESSION_EXPIRED_COPY;
  } else if (RETRYABLE_STATUSES.includes(res.status)) {
    message = "Flock's servers are having a moment. Try again in a minute.";
  }
  // Carry the machine-readable bits: callers key off err.code (e.g.
  // 'UPGRADE_REQUIRED' from the Birdie free-tier meter) and err.status. The
  // message alone is display copy and not a stable contract.
  const err = new Error(message || 'Something went wrong on our end. Try again.');
  err.status = res.status;
  if (expired) err.sessionExpired = true;
  if (data && typeof data === 'object') {
    err.code = data.code;
    err.data = data;
  }
  return err;
}

async function request(endpoint, options = {}) {
  const token = getToken();
  const { timeout, retry, ...fetchOptions } = options;
  const headers = {
    'Content-Type': 'application/json',
    ...fetchOptions.headers,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const method = (fetchOptions.method || 'GET').toUpperCase();
  // Reads only (see the reliability note above), and even a GET can opt out
  // with retry: false when it has server-side effects (the NFC check-in tap).
  const canRetry = method === 'GET' && retry !== false;
  const timeoutMs = timeout || DEFAULT_TIMEOUT_MS;

  let attempt = 0;
  for (;;) {
    // Fail fast when the device knows it has no network. The alternative is
    // a spinner that runs the full timeout for a request that cannot succeed.
    if (isOffline()) throw connectionError();

    let res;
    try {
      res = await fetchWithTimeout(`${BASE_URL}${endpoint}`, { ...fetchOptions, headers }, timeoutMs);
    } catch (err) {
      // Timeouts are excluded on purpose: one already cost the full 15s, and
      // a stalled connection is not a blip. Retrying it would stack up to
      // ~48s of spinner. Fast connection failures are the ones worth re-running.
      if (canRetry && !err.isOffline && !err.isTimeout && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt] * (0.75 + Math.random() * 0.5));
        attempt += 1;
        continue;
      }
      throw err;
    }

    if (canRetry && RETRYABLE_STATUSES.includes(res.status) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt] * (0.75 + Math.random() * 0.5));
      attempt += 1;
      continue;
    }

    const data = await parseBody(res);
    if (!res.ok) throw buildHttpError(res, data === PARSE_FAILED ? null : data, endpoint, !!token);

    const guardErr = badResponseGuard(res, data, method);
    if (guardErr) {
      // A truncated body on a GET is a blip worth one more shot. A captive
      // portal is not: it answers the retry with the same login page.
      if (guardErr.isBadReply && canRetry && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt] * (0.75 + Math.random() * 0.5));
        attempt += 1;
        continue;
      }
      throw guardErr;
    }
    return data;
  }
}

// Auth
// Re-send the signup confirmation link. Rate limited server-side: one every
// 60 seconds and five an hour, so the caller must sit on a cooldown rather
// than letting the button be tapped repeatedly.
export async function resendVerificationEmail() {
  return request('/api/auth/resend-verification', { method: 'POST' });
}

export async function signup(name, email, password, dateOfBirth) {
  const body = { name, email, password };
  // Send DOB only when provided so the backend's server-side age gate (>= 13)
  // can compute and enforce age. Field name + ISO format match POST /api/auth/signup.
  if (dateOfBirth) body.date_of_birth = dateOfBirth;
  const data = await request('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  setToken(data.token);
  identifyUser(data.user);
  track('signup', { method: 'email' });
  return data;
}

// Add report/block helpers next to the auth client so they share the request() wrapper.
// Contract mirrors backend/routes/moderation.js exactly.
export async function reportContent({ contentType, contentId, reportedUserId, reason, details }) {
  return request('/api/reports', {
    method: 'POST',
    body: JSON.stringify({
      content_type: contentType,
      content_id: contentId,
      reported_user_id: reportedUserId,
      reason,
      details: details || undefined,
    }),
  });
}

export async function blockUser(userId) {
  return request(`/api/blocks/${userId}`, { method: 'POST' });
}

export async function unblockUser(userId) {
  return request(`/api/blocks/${userId}`, { method: 'DELETE' });
}

export async function getBlockedUsers() {
  return request('/api/blocks');
}

// Permanently delete the signed-in user's account (Apple Guideline 5.1.1(v)).
// Backend hard-deletes the user row (DELETE /api/users/me); we drop the local
// token afterward so the app falls back to the logged-out state.
// Deletion now requires proof the person holding the token is the account
// owner, because a stolen token could otherwise destroy an account outright
// and, for Apple users, revoke their Apple grant. Password accounts send their
// password; OAuth accounts prove a recent sign-in instead, so they send
// nothing and the backend checks how old the token is.
//
// A 401 here carries `reauthRequired`, which is 'password' when the caller
// should be asked for one, or 'reauth' when they need to sign in again. The
// caller is expected to catch that and re-prompt rather than treat it as a
// failure. Deletion must stay reachable and must genuinely complete: it is an
// App Store requirement, not a nicety.
export async function deleteAccount(password) {
  const data = await request('/api/users/me', {
    method: 'DELETE',
    ...(password ? { body: JSON.stringify({ password }) } : {}),
  });
  // The account is gone, so there is no server left to tell and no token worth
  // presenting — but the device wipe is the same one sign-out performs. The
  // caller (App.js) still runs endSession() afterwards for the UI teardown.
  clearLocalSession();
  return data;
}

export async function login(email, password, dateOfBirth) {
  // dateOfBirth: only for legacy accounts created before DOB was required —
  // the backend answers 403 {needsDob: true} and the login screen retries
  // with the collected date.
  const body = { email, password };
  if (dateOfBirth) body.date_of_birth = dateOfBirth;
  const data = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  setToken(data.token);
  identifyUser(data.user);
  track('login', { method: 'email' });
  return data;
}

// Custom-button flow: useGoogleLogin yields an OAuth access token, verified
// server-side (tokeninfo aud check + userinfo). Same backend route.
export async function googleLoginWithToken(accessToken, dateOfBirth) {
  const body = { access_token: accessToken };
  if (dateOfBirth) body.date_of_birth = dateOfBirth;
  const data = await request('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  setToken(data.token);
  identifyUser(data.user);
  track('login', { method: 'google' });
  return data;
}

export async function googleLogin(credential, dateOfBirth) {
  const body = { credential };
  // Pass DOB on consumer sign-up so the backend age gate (>= 13) fires for new
  // OAuth accounts too, matching email signup. Existing-user logins omit it.
  if (dateOfBirth) body.date_of_birth = dateOfBirth;
  const data = await request('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  setToken(data.token);
  identifyUser(data.user);
  track('login', { method: 'google' });
  return data;
}

// Sign in with Apple (native iOS only). The plugin hands us Apple's signed
// identityToken; the backend verifies it against Apple's JWKS and issues our
// JWT (backend/routes/auth.js POST /apple). fullName only arrives on the very
// FIRST authorization for an Apple ID, so pass it through when present.
export async function appleLogin(identityToken, fullName, authorizationCode, dateOfBirth) {
  const body = { identityToken };
  if (fullName) body.fullName = fullName;
  if (authorizationCode) body.authorizationCode = authorizationCode;
  if (dateOfBirth) body.date_of_birth = dateOfBirth; // required server-side for NEW accounts (age gate)
  const data = await request('/api/auth/apple', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  setToken(data.token);
  identifyUser(data.user);
  track('login', { method: 'apple' });
  return data;
}

// Venue intelligence: the owner's own model-powered forecast + the
// competitor strip view. Real computation, replaces the old demo numbers.
export async function getVenueIntelligence() {
  return request('/api/venue-dashboard/intelligence');
}
export async function getVenueStrip() {
  return request('/api/venue-dashboard/strip');
}

// The owner's live 0-100 number. Free at every tier — the number users see is
// never for sale; it is labelled as the venue's own claim (the category-
// derived "the {venue-type} says" attribution the API computes), expires
// server-side after 90 minutes, and recent user reports outrank it.
export async function getVenueBusyNow() {
  return request('/api/venue-dashboard/busy-now');
}
export async function updateVenueBusyNow(percent) {
  return request('/api/venue-dashboard/busy-now', { method: 'POST', body: JSON.stringify({ percent }) });
}
export async function clearVenueBusyNow() {
  return request('/api/venue-dashboard/busy-now', { method: 'DELETE' });
}

// Deterministic weekly summary — SQL aggregates over the venue's own rows,
// nothing modelled, nothing invented.
export async function getVenueThisWeek() {
  return request('/api/venue-dashboard/this-week');
}

// Roost's T0 insight cards (components/VenueInsightCards.js). Deterministic
// facts with a source on every number, refusals as data. A 403 is the Pro
// gate answering, which the component renders as a plan line, not an error.
export async function getVenueAdvisorCards() {
  return request('/api/venue/advisor/cards');
}

// Roost, the venue advisor's chat surface (components/VenueAdvisorChat.js).
// /questions serves the four suggested chips this venue's data can answer, the
// rest grouped behind a disclosure, and whether the typed-question field is on.
export async function getAdvisorQuestions() {
  return request('/api/venue/advisor/questions');
}

// The chip path. Exactly one intent id from the registry, and nothing else:
// the server 400s any other key on this endpoint BY SHAPE, which is the
// guarantee that a chip answer is never reachable by typing. Do not add a
// free-text parameter here; free text has its own door below.
export async function askAdvisor(intentId) {
  return request('/api/venue/advisor/ask', {
    method: 'POST',
    body: JSON.stringify({ intentId }),
  });
}

// The typed path. One question, answered as exactly one of three things, and
// the response says which: a grounded answer built from this venue's facts, a
// labeled piece of general operating advice, or a refusal naming what is
// missing. ADVISOR_FREETEXT_ENABLED gates it on the server and defaults ON, so
// /questions reports freeText true on an ordinary deploy; the component still
// asks, because the answer decides whether the field it always draws is live or
// drawn quiet with the reason under it.
export async function askAdvisorQuestion(question) {
  return request('/api/venue/advisor/question', {
    method: 'POST',
    body: JSON.stringify({ question }),
  });
}

// Shareable guest invite link for a flock (guests RSVP + vote, no account).
export async function createFlockInviteLink(flockId, regenerate = false) {
  const data = await request(`/api/flocks/${flockId}/invite-link`, {
    method: 'POST',
    body: JSON.stringify({ regenerate }),
  });
  track('invite_link_created', { regenerate });
  return data;
}

// The other end of that link: redeem it for real membership.
//
// The invite page's primary action, and the only authenticated route on the
// guest surface. Answers { flockId, flockName, joined }, where `joined: false`
// means the caller was already a member and should simply be taken to the chat.
// The token is a bearer credential, so it is never put in a query string and
// never sent to analytics: the event below carries whether it worked, not what
// was redeemed. See services/inviteHandoff.js for the state machine around it.
export async function joinFlockByInviteToken(token) {
  const data = await request(`/api/guest/${encodeURIComponent(token)}/join`, { method: 'POST' });
  track('invite_link_joined', { already_member: data?.joined === false });
  return data;
}

export async function getCurrentUser() {
  return request('/api/auth/me');
}

// Sign out: tell the server, then wipe the device. In that order, and the
// second half is not conditional on the first.
//
// POST /api/auth/logout takes no body, requires the bearer token, and answers
// { message }. Today the backend calls it advisory (tokens carry no per-session
// id, so single-device revocation would have to bump token_version and sign the
// user out of their laptop too) — but the call is made anyway, because the
// client's job is to declare the session over and the day that route learns to
// revoke, every shipped app already asks it to. POST /api/auth/logout-all is
// the one that truly revokes, by bumping token_version; no UI reaches it, so
// nothing here calls it.
//
// FAILURE BEHAVIOR, which is the whole point: the local wipe is synchronous and
// runs whether the server answers, refuses, or never hears us. A user hitting
// Log out in a basement with no signal is signed out of that phone, full stop.
// A short timeout keeps a hung connection from holding the caller.
const LOGOUT_TIMEOUT_MS = 4000;

export async function logout() {
  const token = getToken();
  // Issued before the wipe so it carries a live credential, with the header
  // pinned explicitly so the order of these two lines can never quietly become
  // load-bearing. .catch() here, not try/await: nothing this returns can
  // change what happens next.
  const told = token
    ? request('/api/auth/logout', {
      method: 'POST',
      timeout: LOGOUT_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null)
    : null;
  clearLocalSession();
  if (told) await told;
}

// Flock Pro — { isPremium, paywallEnabled, birdie: { limit, used, remaining } }.
// Source of truth for premium state; users.is_premium is set by the RevenueCat
// webhook, so re-fetch after a purchase/restore to pick up the flip.
export async function getEntitlements() {
  return request('/api/entitlements');
}

// Venue profile
export async function createVenueProfile(data) {
  return request('/api/venue-profile', { method: 'POST', body: JSON.stringify(data) });
}

export async function getVenueProfile() {
  return request('/api/venue-profile');
}

export async function updateVenueProfile(data) {
  return request('/api/venue-profile', { method: 'PUT', body: JSON.stringify(data) });
}

// The owner's half of verification. Until this existed the dashboard told an
// unverified owner to verify their venue in three places and nothing anywhere
// started one, so the instruction was a dead end (found on TestFlight,
// 2026-08-21). No body: the claim already names the place, and there is
// nothing an owner could type that a hand-checked ownership decision should
// be made from.
//
// Idempotent server-side, first press wins, so a second tap cannot move the
// claim in the admin queue. Answers 200 with { verification_status,
// verification_requested_at, message } on success and on a repeat; the
// message is display copy and is printed verbatim by both surfaces that
// offer the button.
export async function requestVenueVerification() {
  return request('/api/venue-profile/request-verification', { method: 'POST' });
}

// Venue dashboard CRUD
export async function getVenuePromotions() {
  return request('/api/venue-dashboard/promotions');
}
export async function createVenuePromotion(data) {
  return request('/api/venue-dashboard/promotions', { method: 'POST', body: JSON.stringify(data) });
}
export async function updateVenuePromotion(id, data) {
  return request(`/api/venue-dashboard/promotions/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}
export async function deleteVenuePromotion(id) {
  return request(`/api/venue-dashboard/promotions/${id}`, { method: 'DELETE' });
}

export async function getVenueEvents() {
  return request('/api/venue-dashboard/events');
}
export async function createVenueEvent(data) {
  return request('/api/venue-dashboard/events', { method: 'POST', body: JSON.stringify(data) });
}
export async function updateVenueEvent(id, data) {
  return request(`/api/venue-dashboard/events/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}
export async function deleteVenueEvent(id) {
  return request(`/api/venue-dashboard/events/${id}`, { method: 'DELETE' });
}

export async function getIncomingFlocks() {
  return request('/api/venue-dashboard/incoming-flocks');
}

export async function getVenueReviews() {
  return request('/api/venue-dashboard/reviews');
}
export async function replyToReview(id, reply) {
  return request(`/api/venue-dashboard/reviews/${id}/reply`, { method: 'POST', body: JSON.stringify({ reply }) });
}
export async function submitVenueReview(googlePlaceId, rating, text) {
  return request('/api/venue-dashboard/submit-review', { method: 'POST', body: JSON.stringify({ googlePlaceId, rating, text }) });
}
export async function getPublicReviews(placeId) {
  return request(`/api/venue-dashboard/public-reviews/${encodeURIComponent(placeId)}`);
}
export async function getPublicPromotions(placeId) {
  return request(`/api/venue-dashboard/public-promotions/${encodeURIComponent(placeId)}`);
}

export function isLoggedIn() {
  return !!getToken();
}

// Profile
// `bio` rides the same PUT (server caps it at 200 characters). It is optional
// here for the same express-validator reason saveFlockVenue strips nullish:
// undefined keys fall out of JSON.stringify, so an older backend that has not
// learned the field yet simply never sees it.
// `phone` rides the same PUT. It is the ONLY way a number reaches the account
// (signup deliberately does not accept one), and without a number on file the
// phone-discovery switch has nothing to hash, so this is what makes that switch
// reachable at all. An untouched field is spelled `undefined` and falls out of
// JSON.stringify, so it never rewrites the stored value.
export async function updateProfile({ name, email, phone, bio, current_password, new_password }) {
  return request('/api/users/profile', {
    method: 'PUT',
    body: JSON.stringify({ name, email, phone, bio, current_password, new_password }),
  });
}

// The whole profile row, which is where `phone_discoverable` lives.
// GET /api/auth/me (what `getCurrentUser` reads, and what the app's `authUser`
// is) does not select that column, so a Settings switch drawn from `authUser`
// would read Off for somebody who is findable. This is the read that tells the
// truth about it.
export async function getUserProfile() {
  return request('/api/users/profile');
}

// The person card behind a tap on someone's face: id, name, photo, bio.
// Answers 404 when either side has blocked the other (and on a backend that
// does not ship the route yet), so callers treat any failure as "no card",
// never as an error worth showing.
export async function getUserCard(id) {
  return request(`/api/users/${id}/card`);
}

// Flocks
export async function getFlocks() {
  return request('/api/flocks');
}

export async function getFlock(id) {
  return request(`/api/flocks/${id}`);
}

export async function createFlock({ name, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, venue_photo_url, event_time, invited_user_ids, budget_enabled, budget_context, ghost_mode_enabled }) {
  const data = await request('/api/flocks', {
    method: 'POST',
    body: JSON.stringify({ name, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, venue_photo_url, event_time, invited_user_ids, budget_enabled, budget_context, ghost_mode_enabled }),
  });
  track('flock_created', { has_venue: !!venue_name, invited_count: invited_user_ids?.length || 0 });
  return data;
}

export async function deleteFlock(id) {
  return request(`/api/flocks/${id}`, { method: 'DELETE' });
}

// Completed and cancelled flocks, newest first. Answers { flocks: [...] } with
// each row carrying its venue fields and a members array of
// { id, name, profile_image_url }.
export async function getFlockHistory() {
  return request('/api/flocks/history');
}

// "Do it again": clone a finished flock into a fresh one. Mirrors createFlock's
// contract — event_time is the one field POST /api/flocks requires from this
// client, so the caller passes the fresh time and gets back { flock } exactly
// like createFlock does.
export async function rerunFlock(id, { event_time } = {}) {
  const data = await request(`/api/flocks/${id}/rerun`, {
    method: 'POST',
    body: JSON.stringify({ event_time }),
  });
  track('flock_rerun', {});
  return data;
}

// --- Flock edits (PUT /api/flocks/:id, creator only) ---
//
// App.js used to call this route with two bare fetch()es that never looked at
// res.ok, so a 403 (not the creator), a 404 (deleted flock) or a 400 all read
// as success and the optimistic local state quietly diverged from the server.
// Routed through request(), they now throw the standard error object
// (err.status, err.code, err.data) that every other caller already handles.
//
// The nullish stripping is not cosmetic. backend/routes/flocks.js validates
// with express-validator v7, whose .optional() skips `undefined` only — it
// does NOT skip `null`. Sending `venue_latitude: null` (which the old App.js
// code did on every venue with no coordinates) fails isFloat() and the whole
// request comes back 400 with nothing saved. Omit the key instead.
function withoutNullish(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

// Assign or change a flock's venue.
// venue: { name, addr, place_id, lat, lng, rating, photo_url }
// Resolves to the updated flock row. Throws on any non-2xx.
export async function saveFlockVenue(flockId, venue = {}) {
  return request(`/api/flocks/${flockId}`, {
    method: 'PUT',
    body: JSON.stringify(withoutNullish({
      venue_name: venue.name,
      venue_address: venue.addr,
      venue_id: venue.place_id,
      venue_latitude: venue.lat,
      venue_longitude: venue.lng,
      venue_rating: venue.rating,
      venue_photo_url: venue.photo_url,
    })),
  });
}

// Set or change a flock's time. Same PUT /api/flocks/:id, same creator-only
// rule; `eventTime` must be ISO 8601 or the server answers 400.
export async function setFlockEventTime(flockId, eventTime) {
  return request(`/api/flocks/${flockId}`, {
    method: 'PUT',
    body: JSON.stringify({ event_time: eventTime }),
  });
}

// Move a flock through its lifecycle. Statuses match the server's enum
// exactly; anything else is rejected here rather than spending a round trip.
const FLOCK_STATUSES = ['planning', 'confirmed', 'completed', 'cancelled'];

export async function setFlockStatus(flockId, status) {
  if (!FLOCK_STATUSES.includes(status)) {
    throw new Error(`Unknown flock status: ${status}`);
  }
  return request(`/api/flocks/${flockId}`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
}

export async function leaveFlock(id) {
  return request(`/api/flocks/${id}/leave`, { method: 'POST' });
}

export async function inviteToFlock(flockId, userIds) {
  return request(`/api/flocks/${flockId}/invite`, {
    method: 'POST',
    body: JSON.stringify({ user_ids: userIds }),
  });
}

export async function acceptFlockInvite(flockId) {
  return request(`/api/flocks/${flockId}/join`, { method: 'POST' });
}

export async function declineFlockInvite(flockId) {
  return request(`/api/flocks/${flockId}/decline`, { method: 'POST' });
}

export async function submitAttendance(flockId, attendance) {
  return request(`/api/flocks/${flockId}/attendance`, {
    method: 'POST',
    body: JSON.stringify({ attendance }),
  });
}

export async function getAdminAnalytics() {
  return request('/api/admin/analytics');
}

// The cost panel. Admin only, gated server side by requireAdmin on the whole
// admin router, so this is the only reader and there is no client-side check
// worth writing here.
//
// Everything it returns is labelled with what KIND of number it is: `observed`
// is priced from the app's own meters, `worstCase` is priced from the ceilings
// in the code, and `reconciled` is the only figure a human has read off an
// invoice. The screen must keep them apart. See backend/services/costModel.js.
export async function getAdminCosts() {
  return request('/api/admin/costs');
}

// Venue votes — member votes carry voter identities, guest-link votes are
// folded in as guest_count only.
export async function getFlockVotes(flockId) {
  return request(`/api/flocks/${flockId}/votes`);
}

export async function voteForVenue(flockId, venueName, venueId) {
  return request(`/api/flocks/${flockId}/vote`, {
    method: 'POST',
    body: JSON.stringify({ venue_name: venueName, venue_id: venueId || undefined }),
  });
}

export async function clearVenueVote(flockId) {
  return request(`/api/flocks/${flockId}/vote`, { method: 'DELETE' });
}

// Messages
export async function getMessages(flockId) {
  return request(`/api/flocks/${flockId}/messages`);
}

// A message carries text, an image, or both. `image_url` was missing here, so
// the REST transport — the fallback the socket client uses while its connection
// is down — could not send a photo at all: it posted a message_type of 'image'
// with no image and the server stored an empty row. Photos in a flock chat
// therefore worked only while the socket was up, which is exactly when the
// fallback is not being used. The field name matches what the flock-message and
// DM routes read (`image_url`, a data: URL).
export async function sendMessage(flockId, text, opts = {}) {
  return request(`/api/flocks/${flockId}/messages`, {
    method: 'POST',
    // A message carrying a photo IS an upload: the image travels in the body as
    // a data: URL. On the 15s default it timed out on exactly the weak signal
    // that put the send on this transport in the first place.
    timeout: opts.image_url ? UPLOAD_TIMEOUT_MS : undefined,
    body: JSON.stringify({
      message_text: text || '',
      message_type: opts.message_type || 'text',
      venue_data: opts.venue_data || undefined,
      image_url: opts.image_url || undefined,
    }),
  });
}

export async function addReaction(messageId, emoji) {
  return request(`/api/messages/${messageId}/react`, {
    method: 'POST',
    body: JSON.stringify({ emoji }),
  });
}

// DMs
export async function getDMConversations() {
  return request('/api/dm');
}

export async function getDMs(userId) {
  return request(`/api/dm/${userId}`);
}

// The DM twin already forwarded `image_url`; the rest of the body is normalised
// to match sendMessage above so the two transports and the two surfaces cannot
// drift. `message_text` is NOT NULL server-side, so an image-only DM sends '',
// never null.
export async function sendDM(userId, text, opts = {}) {
  return request(`/api/dm/${userId}`, {
    method: 'POST',
    timeout: opts.image_url ? UPLOAD_TIMEOUT_MS : undefined,
    body: JSON.stringify({
      message_text: text || '',
      message_type: opts.message_type || 'text',
      venue_data: opts.venue_data || undefined,
      image_url: opts.image_url || undefined,
      reply_to_id: opts.reply_to_id || undefined,
    }),
  });
}

export async function addDmReaction(dmId, emoji) {
  return request(`/api/dm/messages/${dmId}/react`, { method: 'POST', body: JSON.stringify({ emoji }) });
}

export async function removeDmReaction(dmId, emoji) {
  return request(`/api/dm/messages/${dmId}/react/${encodeURIComponent(emoji)}`, { method: 'DELETE' });
}

export async function getDmVenueVotes(userId) {
  return request(`/api/dm/${userId}/venue-votes`);
}

export async function voteDmVenue(userId, venueName, venueId) {
  return request(`/api/dm/${userId}/venue-votes`, { method: 'POST', body: JSON.stringify({ venue_name: venueName, venue_id: venueId }) });
}

export async function getDmPinnedVenue(userId) {
  return request(`/api/dm/${userId}/pinned-venue`);
}

// Resolve relative photo URLs to full backend URLs
function resolvePhotoUrl(url) {
  if (url && url.startsWith('/api/')) return `${BASE_URL}${url}`;
  return url;
}

// Venues
export async function searchVenues(query, location) {
  let endpoint = `/api/venues/search?query=${encodeURIComponent(query)}`;
  if (location) endpoint += `&location=${encodeURIComponent(location)}`;
  const data = await request(endpoint);
  if (data.venues) {
    data.venues = data.venues.map(v => ({ ...v, photo_url: resolvePhotoUrl(v.photo_url) }));
  }
  return data;
}

export async function getVenueDetails(placeId) {
  const data = await request(`/api/venues/details?place_id=${encodeURIComponent(placeId)}`);
  if (data.venue && data.venue.photos) {
    data.venue.photos = data.venue.photos.map(url => resolvePhotoUrl(url));
  }
  // photo_url as well as photos. searchVenues resolves this key and this one
  // did not, so a venue opened from its detail sheet was the one surface in the
  // app holding a RELATIVE proxy path, which renders as a broken image against
  // the web origin rather than the API origin.
  if (data.venue && data.venue.photo_url) {
    data.venue.photo_url = resolvePhotoUrl(data.venue.photo_url);
  }
  return data;
}

// Profile Image. Multipart, so it cannot ride request() (which would set a
// JSON Content-Type and break the browser's boundary header), but it shares
// the same rails: offline fail-fast, a long upload leash instead of the 15s
// default, honest errors with err.status attached. Never retried — the server
// may have stored the image even when the response got lost.
export async function uploadProfileImage(file) {
  if (isOffline()) throw connectionError();
  const token = getToken();
  const formData = new FormData();
  formData.append('image', file);
  const res = await fetchWithTimeout(`${BASE_URL}/api/users/upload-image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  }, UPLOAD_TIMEOUT_MS);
  const data = await parseBody(res);
  if (!res.ok) throw buildHttpError(res, data === PARSE_FAILED ? null : data, '/api/users/upload-image', !!token);
  // Same 200-but-not-JSON guard as request(): venue wifi portals intercept
  // multipart POSTs too, and never retried for the same reason as above.
  const guardErr = badResponseGuard(res, data, 'POST');
  if (guardErr) throw guardErr;
  return data;
}

export async function saveProfileImageUrl(url) {
  return request('/api/users/profile-image', {
    method: 'PUT',
    body: JSON.stringify({ url }),
  });
}

// Users
export async function searchUsers(query) {
  return request(`/api/users/search?q=${encodeURIComponent(query)}`);
}

export async function getSuggestedUsers() {
  return request('/api/users/suggested');
}

export async function getUserStats() {
  return request('/api/users/stats');
}

export async function getUserSettings() {
  return request('/api/users/settings');
}

export async function updateUserSettings(partial) {
  return request('/api/users/settings', {
    method: 'PATCH',
    body: JSON.stringify(partial),
  });
}

// Friends
export async function sendFriendRequest(userId) {
  return request('/api/friends/request', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  });
}

export async function getFriends() {
  return request('/api/friends');
}

export async function acceptFriendRequest(userId) {
  return request('/api/friends/accept', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  });
}

export async function declineFriendRequest(userId) {
  return request('/api/friends/decline', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  });
}

export async function removeFriend(userId) {
  return request(`/api/friends/${userId}`, { method: 'DELETE' });
}

export async function getPendingRequests() {
  return request('/api/friends/pending');
}

export async function getOutgoingRequests() {
  return request('/api/friends/outgoing');
}

export async function getFriendSuggestions() {
  return request('/api/friends/suggestions');
}

export async function getMyFriendCode() {
  return request('/api/friends/my-code');
}

export async function addFriendByCode(code) {
  return request('/api/friends/add-by-code', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export async function findFriendsByPhone(phones) {
  return request('/api/friends/find-by-phone', {
    method: 'POST',
    body: JSON.stringify({ phones }),
  });
}

// The consent switch behind find-by-phone. Turning it ON is the moment the
// server writes the digest it matches against, and turning it OFF is the
// moment that digest is erased, so this is not a cosmetic preference: nobody
// can be found by number until their own account has said yes.
// A 400 comes back when there is no usable number on the account, and the
// message it carries is the one to show.
export async function setPhoneDiscovery(enabled) {
  return request('/api/users/phone-discovery', {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  });
}

// Stories
// Product decision 2026-08-14: stories will never get a UI. The backend route
// stays (it works and is tested), but no story surface ships, so this wrapper
// is intentionally uncalled. It is kept rather than deleted because the
// ROUND 22 takedown comment in backend/routes/admin.js and the purpose-string
// comment in frontend/ios/App/App/Info.plist both cite "getStories has zero
// callers" as their checkable evidence, and tests in both suites pin that
// App.js never references it. Do not wire this into App.js.
export async function getStories() {
  return request('/api/stories');
}

// Safety
export async function getTrustedContacts() {
  return request('/api/safety/contacts');
}

export async function addTrustedContact({ name, phone, email, relationship }) {
  return request('/api/safety/contacts', {
    method: 'POST',
    body: JSON.stringify({ name, phone, email, relationship }),
  });
}

export async function updateTrustedContact(id, { name, phone, email, relationship }) {
  return request(`/api/safety/contacts/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name, phone, email, relationship }),
  });
}

export async function deleteTrustedContact(id) {
  return request(`/api/safety/contacts/${id}`, { method: 'DELETE' });
}

// Safety endpoints get double the default leash. The server fans the alert
// out to trusted contacts before answering, and an SOS is the one request
// that must not give up early on a weak connection.
export async function sendEmergencyAlert({ latitude, longitude, includeLocation }) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return request('/api/safety/alert', {
    method: 'POST',
    timeout: 30000,
    body: JSON.stringify({ latitude, longitude, includeLocation, timezone }),
  });
}

export async function shareLocationWithContacts({ latitude, longitude }) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return request('/api/safety/share-location', {
    method: 'POST',
    timeout: 30000,
    body: JSON.stringify({ latitude, longitude, timezone }),
  });
}

// Crowd Intelligence
export async function getCrowdPrediction(placeId) {
  const now = new Date();
  const localHour = now.getHours();
  const localDay = now.getDay();
  return request(`/api/crowd/${encodeURIComponent(placeId)}?localHour=${localHour}&localDay=${localDay}`);
}

export async function getCrowdBatch(venues) {
  const now = new Date();
  return request('/api/crowd/batch', {
    method: 'POST',
    body: JSON.stringify({ venues, localHour: now.getHours(), localDay: now.getDay() }),
  });
}

export async function getCrowdAlternatives(placeId) {
  const now = new Date();
  return request(`/api/crowd/${encodeURIComponent(placeId)}/alternatives?localHour=${now.getHours()}&localDay=${now.getDay()}`);
}

// Venue Feedback
//
// The device clock rides along, the same way getCrowdBatch already sends it.
// day_of_week / hour on a feedback row are bucket keys, and the read side
// (/api/crowd) looks them up with this same device's clock. The backend
// prefers the venue's own timezone from ml_venues, but most venues are not in
// that table, and without a hint it falls back to the server clock, which is
// UTC on Railway: a 9pm Friday report gets filed as 2am Saturday, so the
// Friday-night lookup never finds it and the Saturday lookup finds a crowd
// level from a different part of the week entirely.
//
// snake_case here on purpose: routes/feedback.js validates `local_day` and
// `local_hour`, while the crowd routes take camelCase. A caller that supplies
// its own values keeps them.
export async function submitVenueFeedback(data) {
  const now = new Date();
  const body = { ...data };
  if (body.local_day == null) body.local_day = now.getDay();
  if (body.local_hour == null) body.local_hour = now.getHours();
  const res = await request('/api/feedback', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  track('crowd_feedback', { crowd_level: data.crowd_level });
  return res;
}

// Weather
export async function getWeather(lat, lon) {
  return request(`/api/weather?lat=${lat}&lon=${lon}`);
}

// Budget Matching
export async function submitBudget(flockId, { amount, skipped }) {
  return request(`/api/budget/${flockId}/submit`, {
    method: 'POST',
    body: JSON.stringify({ amount, skipped }),
  });
}

export async function getBudgetStatus(flockId) {
  return request(`/api/budget/${flockId}`);
}

export async function lockBudget(flockId) {
  return request(`/api/budget/${flockId}/lock`, { method: 'POST' });
}

export async function sendBudgetReminder(flockId) {
  return request(`/api/budget/${flockId}/remind`, { method: 'POST' });
}

// Bill Splitting
export async function createBillSplit(flockId, { totalAmount, tipPercent, splitType, paidBy, customShares }) {
  return request(`/api/billing/${flockId}/create`, {
    method: 'POST',
    body: JSON.stringify({ totalAmount, tipPercent, splitType, paidBy, customShares }),
  });
}

export async function getBillSplit(flockId) {
  return request(`/api/billing/${flockId}`);
}

export async function settleShare(flockId) {
  return request(`/api/billing/${flockId}/settle`, { method: 'POST' });
}

export async function ghostCommit(flockId) {
  return request(`/api/billing/${flockId}/ghost-commit`, { method: 'POST' });
}

export async function getVenmoLink(flockId) {
  return request(`/api/billing/${flockId}/venmo-link`);
}

// Venmo Username
export async function updateVenmoUsername(username) {
  return request('/api/users/venmo-username', {
    method: 'PUT',
    body: JSON.stringify({ venmo_username: username }),
  });
}

// Payment Methods (multi-provider)
export async function updatePaymentMethods({ venmo_username, cashapp_cashtag, zelle_identifier }) {
  return request('/api/users/payment-methods', {
    method: 'PUT',
    body: JSON.stringify({ venmo_username, cashapp_cashtag, zelle_identifier }),
  });
}

export async function getPaymentLinks(flockId) {
  return request(`/api/billing/${flockId}/payment-links`);
}

// Events (Ticketmaster)
//
// `location` here, `radius` below it and `location` in searchVenues were the
// three query VALUES in this file still built by raw interpolation. Every
// caller in App.js passes `${userLocation.lat},${userLocation.lng}` for the
// two location parameters, so the comma is the value's own punctuation and has
// to be percent-encoded to stay that way; a value carrying an `&` would
// otherwise end its parameter and start another one that the backend's
// validator never saw declared. Express decodes the query before any route
// reads it, so the wire format is the only thing that changes here.
export async function searchEvents(location, query, options = {}) {
  let endpoint = `/api/events/search?location=${encodeURIComponent(location)}`;
  if (query) endpoint += `&query=${encodeURIComponent(query)}`;
  if (options.radius) endpoint += `&radius=${encodeURIComponent(options.radius)}`;
  if (options.category) endpoint += `&category=${encodeURIComponent(options.category)}`;
  return request(endpoint);
}

export async function getEventDetails(eventId) {
  return request(`/api/events/details?id=${encodeURIComponent(eventId)}`);
}

export async function getFeaturedEvents(location, interests = []) {
  let endpoint = `/api/events/featured?location=${encodeURIComponent(location)}`;
  if (interests.length > 0) endpoint += `&interests=${encodeURIComponent(interests.join(','))}`;
  return request(endpoint);
}

// Weather forecast (5-day)
export async function getWeatherForecast(lat, lon) {
  return request(`/api/weather/forecast?lat=${lat}&lon=${lon}`);
}

// Activity feed
export async function getActivityFeed() {
  return request('/api/flocks/activity');
}

// AI Assistant (Birdie). Model responses can honestly take 20s+; the default
// 15s abort would cut Birdie off mid-thought, so this one gets a longer leash.
export async function sendAiChat(messages, location, currentContext) {
  return request('/api/ai/chat', {
    method: 'POST',
    timeout: AI_TIMEOUT_MS,
    body: JSON.stringify({ messages, location, currentContext, localHour: new Date().getHours(), localDay: new Date().getDay() }),
  });
}

// Push Notifications
// timezone is the device's own IANA zone name, and it is what makes quiet
// hours possible at all: the backend has no other source for a recipient's
// local clock, and evaluating "do not ring at 3am" against the server's UTC
// would mute the entire night out for a US user. Optional, because a client
// whose runtime cannot answer must still be able to register for push;
// services/pushHelper.js treats an unknown zone as "deliver now".
export async function registerDeviceToken(token, deviceType = 'web', timezone) {
  const body = { token, deviceType };
  if (timezone) body.timezone = timezone;
  return request('/api/notifications/register', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function unregisterDeviceToken(token) {
  return request('/api/notifications/unregister', {
    method: 'DELETE',
    body: JSON.stringify({ token }),
  });
}

export async function unregisterAllTokens() {
  return request('/api/notifications/unregister-all', { method: 'DELETE' });
}

// Sensor + check-in — hardware-driven occupancy + NFC tap pipeline
export async function getSensorCurrent(placeId) {
  return request(`/api/sensors/${encodeURIComponent(placeId)}/current`);
}

export async function getSensorHistory(placeId, hours = 24) {
  return request(`/api/sensors/${encodeURIComponent(placeId)}/history?hours=${encodeURIComponent(hours)}`);
}

export async function checkInManual(placeId) {
  return request(`/api/checkin/${encodeURIComponent(placeId)}`, { method: 'POST' });
}

export async function getNfcCheckin(placeId, sig) {
  // The tag's HMAC rides along as ?sig — the backend records the tap as
  // presence-verified only when it matches (round 9).
  // retry: false — this GET WRITES a check-in row. An automatic replay on a
  // gateway blip would record the same tap twice.
  const qs = sig ? `?sig=${encodeURIComponent(sig)}` : '';
  return request(`/api/checkin/${encodeURIComponent(placeId)}${qs}`, { retry: false });
}

// Personal calendar events — persisted per-user (CRUD, /api/calendar)
export async function getCalendarEvents(start, end) {
  const qs = start && end ? `?start=${start}&end=${end}` : '';
  return request(`/api/calendar${qs}`);
}

export async function createCalendarEvent({ title, date, venue, time, color }) {
  return request('/api/calendar', {
    method: 'POST',
    body: JSON.stringify({ title, date, venue, time, color }),
  });
}

export async function updateCalendarEvent(id, fields) {
  return request(`/api/calendar/${id}`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  });
}

export async function deleteCalendarEvent(id) {
  return request(`/api/calendar/${id}`, { method: 'DELETE' });
}

// Availability Pulse — 3-tap status: down / maybe / not
export async function setAvailability({ status, note, expiresAt }) {
  return request('/api/availability', {
    method: 'POST',
    body: JSON.stringify({ status, note, expires_at: expiresAt }),
  });
}

export async function clearAvailability() {
  return request('/api/availability', { method: 'DELETE' });
}

export async function getMyAvailability() {
  return request('/api/availability/me');
}

export async function getFriendsAvailability() {
  return request('/api/availability/friends');
}

/* ── THE NFC TAGS ───────────────────────────────────────────────────────────
   The only two capture calls in this file that belong to a page rather than to
   an API call, and they are here for the reason every capture is here: this
   module is the one place a PostHog capture call may appear, which
   __tests__/analyticsPrivacy.test.js enforces by scanning all of src/.

   src/website/TapPage.js is the caller. It reaches this module through a
   dynamic import so that the REST client is not in its chunk, so nothing below
   may assume it is being called from a signed-in session; it is usually a
   stranger who just tapped a card at a competition.

   `tag` is the ?s= value from the URL (the acrylic table stand sends
   s=stand, the handout cards send s=card, anything else and anything missing
   arrives as 'unknown'). TapPage bounds it to 32 lowercase url-safe
   characters before it gets here. `choice` is one of a short fixed list of
   button names the page itself defines. Neither is, or can become, a person. */
export function trackNfcTap(tag) {
  track('nfc_tap', { source: tag });
}

export function trackNfcAction(tag, choice) {
  track('nfc_tap_action', { source: tag, action: choice });
}

export { getToken, BASE_URL };
export default request;
