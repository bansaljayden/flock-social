// ---------------------------------------------------------------------------
// INVITE HANDOFF — carrying an invite token across the auth round trip.
//
// The problem this exists for, in Jayden's words: "when I send an invite they
// don't get a direct link to being able to text in that flock". Someone opens
// /i/<token> in a group chat, taps the primary action, and has to make an
// account before they can be in the conversation. Making an account is not one
// screen: it is a signup form, or a Google popup, or a native Sign in with
// Apple sheet, followed by a re-render of the whole app from a clean auth
// state. The token lives in the URL of the page they just left. Without
// somewhere to put it, the trip they started is lost at exactly the step that
// makes them a user.
//
// WHY LOCALSTORAGE, AND NOT A URL PARAMETER OR A COOKIE.
//
//   * It has to survive a full page load. /i/<token> and the app are two
//     different entry points in index.js (there is no router), so leaving the
//     invite page for signup is a navigation, not a state change. Component
//     state and anything held in a module are both gone.
//   * It has to survive leaving the app entirely. Sign in with Apple opens a
//     native sheet; Google opens a popup; either can bounce the web view.
//   * A URL parameter was the obvious alternative and is the wrong one. The
//     token is a bearer credential: anyone holding it can read the plan and
//     answer for a guest. index.js's scrubUrlTokens strips exactly two shapes
//     from every analytics and error payload that leaves the device, `/i/<tok>`
//     and `token=`, and a third spelling invented here would ride out to
//     PostHog and Sentry inside $current_url on every pageview of the signup
//     screen. Keeping it out of the URL keeps it out of all of them.
//   * A cookie would ride on every request to the API for no reason, and the
//     app deliberately holds no session cookie at all (the JWT is a header).
//
// The mechanism itself is the one already in the codebase: localStorage is how
// GuestInvite.js remembers a guest identity across visits (`flock_guest_<tok>`)
// and how the theme survives first paint. Same store, same failure handling.
//
// WHAT IS DELIBERATELY NOT HERE: any navigation of its own. This module reads,
// writes, forgets and redeems. The one place that decides where the app goes
// afterwards is App.js's flock load, so the join and the list refresh cannot
// race each other and drop the person on an empty chat screen.
// ---------------------------------------------------------------------------

import { joinFlockByInviteToken } from './api';
import { emitPushNavigation } from './pushNavigation';

const KEY = 'flock_pending_invite';

// A stashed invite is a promise to do something the moment an account exists,
// and a promise with no expiry is a surprise. A day is long enough for "I'll
// sign up tonight" and short enough that an invite from last month does not
// silently pull someone into a plan they have forgotten about.
const TTL_MS = 24 * 60 * 60 * 1000;

// Mirrors the server's param('token').isLength({ min: 8, max: 64 }) in
// backend/routes/guest.js. Anything outside it was never a real token, so it
// is not worth a round trip and is certainly not worth storing.
const TOKEN_MIN = 8;
const TOKEN_MAX = 64;

// Safari private mode, "block all cookies", and a corrupt value all throw or
// return nonsense here. Not remembering is survivable. Throwing on the boot
// path of the whole app is not.
function read() {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(value) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* see read() */
  }
}

export function forgetInvite() {
  try { window.localStorage.removeItem(KEY); } catch { /* see read() */ }
}

const looksLikeToken = (t) =>
  typeof t === 'string' && t.length >= TOKEN_MIN && t.length <= TOKEN_MAX;

/**
 * Stash the invite this person is trying to accept. Called from the invite page
 * immediately before it sends them to signup or login.
 */
const looksLikeGuestToken = (t) =>
  typeof t === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t);

export function rememberInvite(token, extra = {}) {
  if (!looksLikeToken(token)) return false;
  write({
    token,
    at: Date.now(),
    // Carried only so the app can say the flock's name while it is joining.
    // Never used to decide anything: the server is the authority on which
    // flock this token belongs to.
    flockName: typeof extra.flockName === 'string' ? extra.flockName.slice(0, 80) : null,
    // The guest identity this person used on the invite page, if they RSVPed
    // by name before joining. The join presents it so the server can retire
    // that row instead of counting the same person twice. A UUID or nothing.
    guestToken: looksLikeGuestToken(extra.guestToken) ? extra.guestToken : null,
  });
  return true;
}

/** The stashed invite, or null. Expired entries are cleaned up on the way out. */
export function pendingInvite() {
  const saved = read();
  if (!saved || !looksLikeToken(saved.token)) {
    if (saved) forgetInvite();
    return null;
  }
  const at = Number(saved.at);
  // A missing or absurd timestamp reads as expired rather than as immortal:
  // fail toward forgetting, because the failure mode of remembering too long is
  // pulling somebody into a plan they did not ask for.
  if (!Number.isFinite(at) || Date.now() - at > TTL_MS || at > Date.now() + 60000) {
    forgetInvite();
    return null;
  }
  return {
    token: saved.token,
    flockName: saved.flockName || null,
    guestToken: looksLikeGuestToken(saved.guestToken) ? saved.guestToken : null,
  };
}

/**
 * Redeem a stashed invite, if there is one. NEVER rejects: this runs on the
 * app's boot path, and a failed join must not be able to stop the flock list
 * from loading.
 *
 * Resolves to one of three things:
 *
 *   { flockId, flockName, joined }        the trip finished. Open the chat.
 *   { needsEmailVerification, flockName } the join was refused because the
 *                                         account has not confirmed its email.
 *                                         The stash is KEPT and the next boot
 *                                         after they click the link finishes
 *                                         the join by itself.
 *   null                                  nothing to do, or nothing worth
 *                                         saying to the person.
 *
 * WHY THE SECOND ONE EXISTS, AND WHAT IT IS FOR. It is the reported failure:
 * "invite-link signup silently fails to join". A password signup writes
 * users.email_verified FALSE (backend/routes/auth.js), POST /api/guest/:token/
 * join sits behind requireVerified, and this function used to answer that 403
 * with a bare null, the same value it returns when there was no invite at all.
 * So the app could not tell "we tried and they need to confirm their email"
 * apart from "there is nothing here", and the person who had just made an
 * account specifically to get into a plan was dropped on an empty home screen
 * with nothing said. The refusal itself is correct and is not argued with here.
 * Only the silence is fixed: the caller is now told, and App.js already owns a
 * sheet for exactly this error (needsEmailVerification / VerifyEmailSheet).
 *
 * SAFE FOR A CALLER THAT DOES NOT KNOW ABOUT IT YET. The object carries no
 * flockId, so openJoinedFlock below returns false and navigates nowhere, which
 * is precisely what the old null did. A caller that has not been taught the new
 * shape behaves exactly as it did before.
 *
 * WHAT CLEARS THE STASH, and why each one:
 *   success            the trip is finished.
 *   404 / 409          the link was revoked or the plan is over. Retrying it
 *                      tomorrow will not help, and a stash that never clears is
 *                      a request that fires on every single app boot.
 *   429                the flock is full, or this account has hammered the
 *                      route. Same reasoning: another automatic attempt is not
 *                      what is missing.
 *   403 unverified     KEPT. This is the one refusal that resolves itself: they
 *                      click the link in their mail and the next boot finishes
 *                      the join. The TTL still bounds it.
 *   network failure    KEPT. Nothing happened; try again next boot.
 */
export async function redeemPendingInvite() {
  const saved = pendingInvite();
  if (!saved) return null;

  try {
    const result = await joinFlockByInviteToken(saved.token, saved.guestToken || undefined);
    forgetInvite();
    const flockId = Number(result && result.flockId);
    if (!Number.isInteger(flockId) || flockId <= 0) return null;
    return {
      flockId,
      flockName: (result && result.flockName) || saved.flockName || null,
      joined: !!(result && result.joined),
    };
  } catch (err) {
    const status = err && err.status;
    const unverified = err?.data?.emailVerificationRequired === true;
    const keep = unverified || (err && err.isNetworkError);
    if (!keep && (status === 404 || status === 409 || status === 429 || status === 400 || status === 403)) {
      forgetInvite();
    }
    // The one refusal the person can do something about, so it is the one
    // refusal that gets reported instead of swallowed. Everything else here is
    // either already finished (revoked, over, full) or will retry itself on the
    // next boot (a dropped connection), and neither is worth interrupting
    // somebody's first thirty seconds in the app to say.
    if (unverified) {
      return { needsEmailVerification: true, flockName: saved.flockName || null };
    }
    return null;
  }
}

/**
 * Open the flock that was just joined. Separate from the redeem so the caller
 * can load its flock list first: the chat screen reads from that list, and
 * navigating before it lands is how you get an empty room.
 *
 * Reuses the push-navigation bus rather than inventing a second way to open a
 * flock. That bus already has exactly one subscriber in App.js, it already
 * knows that opening a flock means selectedFlockId + the chat tab + the
 * chatDetail screen, and it already queues an intent that arrives before the UI
 * has subscribed.
 */
export function openJoinedFlock(result) {
  if (!result || !Number.isInteger(result.flockId)) return false;
  emitPushNavigation({ screen: 'flock', flockId: result.flockId, type: 'invite_link' });
  return true;
}

const inviteHandoff = {
  rememberInvite, pendingInvite, forgetInvite, redeemPendingInvite, openJoinedFlock,
};
export default inviteHandoff;
