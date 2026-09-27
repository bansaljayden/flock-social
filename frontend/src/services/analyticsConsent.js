/**
 * ANALYTICS CONSENT.
 *
 * PostHog used to initialise at module scope in index.js, on page load, before
 * render and before any interaction. Every first-time visitor to flockcorp.com,
 * a legal page, or a guest invite link got a `$pageview` sent with their IP and
 * a distinct_id written to localStorage, with no notice and no choice.
 *
 * WHAT FLOCK COLLECTS IS ALREADY UNUSUALLY RESTRAINED — autocapture off,
 * session recording off, heatmaps off, dead clicks off, exception capture off,
 * surveys off, person profiles for identified users only, and every event
 * scrubbed by `before_send`. There is no cookie, no ad pixel and no
 * cross-site tracking. That is not the point. Under ePrivacy Art. 5(3) the
 * localStorage write ITSELF needs consent however small the payload is, and
 * legitimate interest does not substitute for it.
 *
 * SO: no storage and no network until somebody says yes.
 *
 * THREE STATES, and the third is the one that matters:
 *   'yes'      they agreed. Analytics runs.
 *   'no'       they declined. Nothing is written and nothing is sent, ever.
 *   unset      they have not been asked yet. Treated exactly like 'no' until
 *              they answer, because "we have not asked" is not permission.
 *
 * The answer itself is one key in localStorage. That write is the one storage
 * operation that does not need consent, because it exists solely to record the
 * choice, which is what makes it strictly necessary.
 */

const KEY = 'flock_analytics_consent';

/**
 * WHOSE ANSWER IT IS.
 *
 * In the app the question is about an account: the app copy says the events
 * carry "your account number". So an answer is good for the account that gave
 * it and for nobody else. The stored key is swept with every other flock* key
 * when a session ends (services/api.js clearLocalSession), which means the next
 * account on a shared phone is asked for itself and nothing is sent for it
 * until it answers. Keeping the key across sign-out, as one fix tried, handed
 * A's yes to B: B was identified to PostHog by account id without ever seeing
 * the bar, which is the "unset is not permission" rule above broken one person
 * later.
 *
 * Sweeping it outright asked everybody again after every sign-out and every
 * 24h token expiry, including the person who had said no, which breaks the
 * bar's promise that declining is remembered. So the answer is HELD, in this
 * module and nowhere else, from the end of a session until the next sign-in on
 * the same page, and given back only when that sign-in is the same account.
 * The daily case is covered by that: an expired token is found at launch, the
 * sign-in screen follows in the same page, and the person who signs in there
 * is usually the one who answered. Anyone else is asked.
 *
 * Memory, not storage, on purpose. Writing "account 42 answered no" to the
 * device would leave behind exactly what the sign-out sweep exists to remove:
 * which account used this phone. A page that closes before the next sign-in
 * forgets the hold, and the next sign-in is asked, which costs one tap and
 * never sends anything unasked.
 *
 * An answer given while nobody is signed in (the web bar on the landing page
 * or the sign-in screen) has no account yet. It stays for the next sign-in on
 * this browser, which is nearly always the person who answered, on their way
 * from the landing page or the sign-in form into the app. From then on it is
 * that account's, and leaves with its session like any other.
 */
let heldAtSignOut = null;
const listeners = new Set();

/** 'yes' | 'no' | null. Never throws: private windows and locked-down
 *  webviews make localStorage itself raise, and this runs during boot. */
export function readConsent() {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'yes' || v === 'no' ? v : null;
  } catch {
    return null;
  }
}

/** True only for an explicit yes. Unset is not consent. */
export function hasAnalyticsConsent() {
  return readConsent() === 'yes';
}

/** True when nobody has answered yet, which is when the banner is due. */
export function consentUnanswered() {
  return readConsent() === null;
}

export function setConsent(answer) {
  // An answer given at this device now replaces whatever a signed-out account
  // left waiting below: it is the newer word from whoever is holding it.
  heldAtSignOut = null;
  try {
    window.localStorage.setItem(KEY, answer === 'yes' ? 'yes' : 'no');
  } catch { /* a browser that refuses to remember the answer will ask again */ }
}

/** Hear about a change to the answer in force that the bar did not make itself:
 *  a session ending took it away, or a sign-in gave a held one back. Returns
 *  the unsubscribe. The bar uses it to open again for the next account, and
 *  index.js uses it to start analytics for a yes that comes back. */
export function onConsentChange(listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function announceConsentChange() {
  const answer = readConsent();
  listeners.forEach((listener) => {
    try { listener(answer); } catch { /* one listener cannot stop the others */ }
  });
}

/** Called by services/api.js as a session ends, BEFORE its sweep removes the
 *  key. `account` is the id of the account whose session it was, or nothing
 *  when that is not known, in which case nothing is held and the next sign-in
 *  is asked. */
export function holdConsentAtSignOut(account) {
  const answer = readConsent();
  // Nothing in force means nothing new to hold. One ending can clear twice
  // (a boot's 401, then the logout App.js sends after it, by which time the
  // token that named the account is gone), and the second must not drop what
  // the first one held.
  if (answer === null) return;
  heldAtSignOut = account !== undefined && account !== null && String(account)
    ? { account: String(account), answer }
    : null;
}

/** Called by services/api.js whenever it learns which account is signed in.
 *  Gives the held answer back to that account and to no other, and only when
 *  nothing newer has been answered since. The hold is spent either way. */
export function restoreConsentFor(account) {
  const held = heldAtSignOut;
  heldAtSignOut = null;
  if (!held || account === undefined || account === null) return;
  if (held.account !== String(account) || readConsent() !== null) return;
  try {
    window.localStorage.setItem(KEY, held.answer);
  } catch { return; /* not remembered, so the bar asks, which is safe */ }
  announceConsentChange();
}

/**
 * Turn analytics off and forget the identifier.
 *
 * Called when somebody declines after previously agreeing. opt_out_capturing
 * stops the SDK and clears its stored id, so declining does not leave the
 * distinct_id that consent originally created sitting in localStorage.
 */
export function revokeAnalytics() {
  // READ BEFORE THE WRITE. Below this line the answer is 'no' and the
  // question "could the SDK be running?" can no longer be asked.
  //
  // Declining without ever having accepted was downloading 247 KB of
  // posthog-js in order to call opt_out_capturing on an SDK that had never
  // been initialised and had never stored anything — the most expensive
  // possible way to do nothing, charged to the one person who just said they
  // did not want it. Only a previous yes can have loaded it, and only a
  // previous yes can have left a distinct_id behind to clear.
  const wasConsented = readConsent() === 'yes';
  setConsent('no');
  if (!wasConsented) return;
  try {
    import('posthog-js')
      .then(({ default: posthog }) => {
        try { posthog.opt_out_capturing(); } catch { /* never initialised */ }
        try { posthog.reset(true); } catch { /* ditto */ }
      })
      .catch(() => {});
  } catch { /* analytics is never load-bearing */ }
}
