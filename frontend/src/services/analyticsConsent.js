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
  try {
    window.localStorage.setItem(KEY, answer === 'yes' ? 'yes' : 'no');
  } catch { /* a browser that refuses to remember the answer will ask again */ }
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
