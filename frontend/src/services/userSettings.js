// isLoggedIn() rather than a localStorage read of our own: api.js owns where the
// token lives and what counts as signed in (it also clears the key on a fatal
// auth failure). Reading the raw key here meant this file had a second, silent
// copy of that contract, so moving or renaming the token would have left these
// two guards answering "signed in" for an account api.js had already given up on.
import { getUserSettings, updateUserSettings, isLoggedIn } from './api';

// Map of synced setting keys → localStorage keys
// Keep this list in sync with the state initializers that read from localStorage.
const SYNCED_KEYS = {
  theme: 'flock-theme',
  themeMode: 'flock-theme-mode',
  mapType: 'flock_map_type',
  birdieCorner: 'flock_birdie_corner',
  sosCorner: 'flock_sos_corner',
  pinnedFlockIds: 'flock_pinned',
  flockOrder: 'flock_order',
  // `onboardingComplete: 'flockOnboardingComplete'` used to sit here and
  // synced nothing in either direction: no line in frontend/src writes
  // flockOnboardingComplete, so readLocalSettings never found it to push and
  // pullSettings only ever wrote it back for a reader that does not exist.
  //
  // DROPPED RATHER THAN REPOINTED at flockVenueOnboardingComplete, which is
  // the key that is really used. Two reasons, and the second is the one that
  // matters. It is written once (screens/VenueOnboarding.js) and read nowhere,
  // so syncing it would only put a write-only flag on the account. And the
  // server side of this map is a free-form JSONB merge with no key list
  // (routes/users.js PATCH /settings), so a stored `onboardingComplete` from
  // when this entry was live outlives the entry — repointing would make the
  // next pull write that unrelated value into the venue key, ready for
  // whichever reader gets added later.
  userMode: 'flockUserMode',
  locationEnabled: 'flock_location_enabled',
  // App.js queueSync()s both of these on change, but until they were listed
  // here a first-time sync never pushed them up and a pull never wrote them
  // back to this device — so the safety toggle and interests synced one way
  // only, from whichever device happened to change them last.
  safetyOn: 'flock_safety_on',
  userInterests: 'flock_interests',
  // Crowd alerts opt-out (the pre-peak push). The backend reads
  // settings.crowdAlerts with absent = ON (backend/services/pushHelper.js),
  // so this key only ever carries an explicit choice. Boolean-ish: its
  // readers in App.js compare !== 'false', per the String() landmine below.
  crowdAlerts: 'flock_crowd_alerts',
};

const JSON_KEYS = new Set(['pinnedFlockIds', 'flockOrder', 'userInterests']);

// THE String() LANDMINE — read before adding a synced key.
//
// pullSettings() writes every non-JSON value to localStorage as
// String(value), because localStorage only holds strings. A boolean false
// stored server-side therefore lands here as the STRING 'false', which is
// truthy. Every reader of these keys must compare against the string, never
// truthiness: App.js reads flock_location_enabled and flock_safety_on with
// `!== 'false'` / `=== 'false'`, and adopts safetyOn from the settings event
// with `String(s.safetyOn) !== 'false'`. The test file pins those exact
// reader patterns; if you add a boolean-ish key, write its reader the same
// way or route it through JSON_KEYS.

let pending = {};
let timer = null;

// ONE WRITE ON THE WIRE AT A TIME. Two PATCHes in flight can commit in
// either order, so a pin made while an older save was still travelling could
// end up under it on the account, and an older save that failed after a newer
// one had landed went back in the queue and was sent over it. A flush now
// waits for the write on the wire to settle, and what queued meanwhile goes
// next, merged, newest value winning.
let writing = false;
let retryTimer = null;
let retryDelay = 0;

// THE SESSION THESE WRITES AND PULLS BELONG TO. Signing out does not reload
// the page, so a save that failed for one account sat in the queue and went
// up under the next account's token, and a pull asked for one account could
// land on the next one's screen. api.js clearLocalSession announces
// 'flock-session-cleared'; the listener at the bottom drops what is held, and
// a write or pull from before then is ignored when it settles.
let session = 0;

// WHICH VALUES THIS DEVICE HOLDS NEWER THAN A PULL'S ANSWER.
//
// A pull's answer is the account as the server read it, and a change this
// device made around then can be newer: still in the queue, in a PATCH that
// has not settled, or queued or settled after the pull asked (a PATCH sent
// just before can still commit after the server read the answer).
// pullSettings leaves those keys out of what it writes and hands on, so the
// screen keeps the change and the account gets it. Each pull is judged by
// the moment it asked, and an answer older than one already applied is not
// applied at all, so two overlapping pulls cannot step the screen backwards.
const queuedAt = {};
const settledAt = {};
const inFlight = {};
let appliedAskedAt = 0;

function newerHere(key, askedAt) {
  if (Object.prototype.hasOwnProperty.call(pending, key)) return true;
  if (inFlight[key]) return true;
  if (queuedAt[key] !== undefined && queuedAt[key] >= askedAt) return true;
  return settledAt[key] !== undefined && settledAt[key] >= askedAt;
}

// Whether `value` is what the account already holds for `key`, by JSON, in
// `held` (a component's record of what the settings pull delivered and what
// it has sent since). When it is not, it is recorded as held, because the
// caller is about to send it. Adopting the pull's lists sets fresh arrays,
// and the effects that persist them used to queue those same lists straight
// back to the account on every launch; one sent after a change made on
// another device in the debounce window wrote that change away.
export function sameAsAccount(held, key, value) {
  const json = JSON.stringify(value);
  if (held[key] === json) return true;
  held[key] = json;
  return false;
}

export function queueSync(partial) {
  const now = Date.now();
  Object.keys(partial).forEach((key) => { queuedAt[key] = now; });
  pending = { ...pending, ...partial };
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 600);
}

// Sends what is queued, unless a write is already on the wire (it sends
// this when it settles). Returns the write, which never rejects, or null.
function flush() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (writing || Object.keys(pending).length === 0) return null;
  const payload = pending;
  pending = {};
  if (!isLoggedIn()) return null;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  const mine = session;
  const keys = Object.keys(payload);
  keys.forEach((key) => { inFlight[key] = (inFlight[key] || 0) + 1; });
  writing = true;
  const settle = () => {
    writing = false;
    if (mine !== session) return;
    const at = Date.now();
    keys.forEach((key) => {
      inFlight[key] -= 1;
      if (!inFlight[key]) delete inFlight[key];
      settledAt[key] = at;
    });
  };
  // What queued while this was on the wire goes next, unless its own
  // debounce is still running, whichever session it belongs to.
  const next = () => { if (!timer && Object.keys(pending).length > 0) flush(); };
  return updateUserSettings(payload).then(() => {
    settle();
    if (mine === session) retryDelay = 0;
    next();
  }, (err) => {
    settle();
    // A write for a session that has ended: its settings are not the next
    // account's, so it is neither re-queued nor announced.
    if (mine !== session) { next(); return; }
    console.warn('[settings] sync failed:', err.message);
    // A sync lost to a dead spot is still the user's intent. Put it back in
    // the queue (anything queued since the flush wins a conflict) and send it
    // again: when the connection comes back (the 'online' listener below), or
    // after a growing pause while the device says it is online, because
    // 'online' can fire before a dying request has failed and then never
    // fire again. Non-network failures (413 payload too large, expired
    // session) stay dropped: re-sending those would fail identically forever.
    const retryable = Boolean(err && err.isNetworkError);
    if (retryable) {
      pending = { ...payload, ...pending };
      retryLater();
    } else if (typeof window !== 'undefined') {
      // A save that cannot be retried used to be a console warning and
      // nothing else, so a switch could move on screen, never reach the
      // account, and keep disagreeing with the person's other device. Both
      // halves belong in the sentence: the local change stuck, the
      // account-wide one did not.
      window.dispatchEvent(new CustomEvent('flock-toast', {
        detail: { message: 'That setting did not save to your account. It still applies on this device.', type: 'error' },
      }));
    }
    if (!retryable) next();
  });
}

function retryLater() {
  if (retryTimer) return;
  // Offline: the 'online' listener sends it when the connection is back.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  retryDelay = Math.min(retryDelay ? retryDelay * 2 : 5000, 5 * 60 * 1000);
  retryTimer = setTimeout(() => { retryTimer = null; flush(); }, retryDelay);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    // Flush anything a dead spot stranded. queueSync({}) merges nothing and
    // arms the normal debounce timer over the surviving pending payload.
    if (Object.keys(pending).length > 0) queueSync({});
  });
  window.addEventListener('flock-session-cleared', () => {
    session += 1;
    pending = {};
    if (timer) { clearTimeout(timer); timer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retryDelay = 0;
    appliedAskedAt = 0;
    [queuedAt, settledAt, inFlight].forEach((record) => {
      Object.keys(record).forEach((key) => { delete record[key]; });
    });
  });
}

function readLocalSettings() {
  const out = {};
  for (const [key, lsKey] of Object.entries(SYNCED_KEYS)) {
    const raw = localStorage.getItem(lsKey);
    if (raw === null || raw === undefined) continue;
    if (JSON_KEYS.has(key)) {
      try { out[key] = JSON.parse(raw); } catch { /* ignore malformed JSON */ }
    } else {
      out[key] = raw;
    }
  }
  return out;
}

export async function pullSettings() {
  if (!isLoggedIn()) return null;
  const askedAt = Date.now();
  const mine = session;
  // The part of `values` this device holds nothing newer for.
  const takeable = (values) => {
    const out = {};
    Object.keys(values).forEach((key) => { if (!newerHere(key, askedAt)) out[key] = values[key]; });
    return out;
  };
  try {
    const { settings } = await getUserSettings();
    // An answer for a session that has since ended belongs to another
    // account's screen, and one older than an answer already applied is the
    // account as it was: neither is written or handed on.
    if (mine !== session || askedAt < appliedAskedAt) return null;
    appliedAskedAt = askedAt;
    const serverHasSettings = settings && typeof settings === 'object' && Object.keys(settings).length > 0;

    if (!serverHasSettings) {
      // First-time sync: this account has nothing saved, so this device's
      // values become the account's. They go up at once, through the same
      // one-at-a-time path as every save, so they land in order with anything
      // changed meanwhile and are retried if the connection drops. Nothing
      // is handed on, because nothing came from the account.
      const local = takeable(readLocalSettings());
      if (Object.keys(local).length > 0) {
        queueSync(local);
        const sending = flush();
        if (sending) await sending;
      }
      window.dispatchEvent(new CustomEvent('flock-settings-loaded', { detail: {} }));
      return local;
    }

    // Only what this device holds nothing newer for is written and handed
    // on. Writing a newer value over here left the next launch starting from
    // the older one, and ThemeContext re-reads these keys on the event below.
    const taken = takeable(settings);
    for (const [key, lsKey] of Object.entries(SYNCED_KEYS)) {
      if (taken[key] === undefined || taken[key] === null) continue;
      const value = JSON_KEYS.has(key) ? JSON.stringify(taken[key]) : String(taken[key]);
      localStorage.setItem(lsKey, value);
    }
    window.dispatchEvent(new CustomEvent('flock-settings-loaded', { detail: taken }));
    return settings;
  } catch (err) {
    console.warn('[settings] pull failed:', err.message);
    return null;
  }
}
