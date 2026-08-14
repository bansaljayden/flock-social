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
  onboardingComplete: 'flockOnboardingComplete',
  userMode: 'flockUserMode',
  locationEnabled: 'flock_location_enabled',
  // App.js queueSync()s both of these on change, but until they were listed
  // here a first-time sync never pushed them up and a pull never wrote them
  // back to this device — so the safety toggle and interests synced one way
  // only, from whichever device happened to change them last.
  safetyOn: 'flock_safety_on',
  userInterests: 'flock_interests',
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

export function queueSync(partial) {
  pending = { ...pending, ...partial };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const payload = pending;
    pending = {};
    timer = null;
    if (!isLoggedIn()) return;
    updateUserSettings(payload).catch(err => {
      console.warn('[settings] sync failed:', err.message);
      // A sync lost to a dead spot is still the user's intent. Put it back in
      // the queue (anything queued since the flush wins a conflict) so the
      // next queueSync — or coming back online below — carries it up. Non-
      // network failures (413 payload too large, expired session) stay
      // dropped: re-sending those would fail identically forever.
      if (err && err.isNetworkError) {
        pending = { ...payload, ...pending };
      }
    });
  }, 600);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    // Flush anything a dead spot stranded. queueSync({}) merges nothing and
    // arms the normal debounce timer over the surviving pending payload.
    if (Object.keys(pending).length > 0) queueSync({});
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
  try {
    const { settings } = await getUserSettings();
    const serverHasSettings = settings && typeof settings === 'object' && Object.keys(settings).length > 0;

    if (!serverHasSettings) {
      // First-time sync: this account has no saved settings on the server.
      // If localStorage has anything, push it up so this device's state becomes the source of truth.
      const local = readLocalSettings();
      if (Object.keys(local).length > 0) {
        try {
          await updateUserSettings(local);
        } catch (err) {
          console.warn('[settings] initial push failed:', err.message);
        }
      }
      window.dispatchEvent(new CustomEvent('flock-settings-loaded', { detail: local }));
      return local;
    }

    for (const [key, lsKey] of Object.entries(SYNCED_KEYS)) {
      if (settings[key] === undefined || settings[key] === null) continue;
      const value = JSON_KEYS.has(key) ? JSON.stringify(settings[key]) : String(settings[key]);
      localStorage.setItem(lsKey, value);
    }
    window.dispatchEvent(new CustomEvent('flock-settings-loaded', { detail: settings }));
    return settings;
  } catch (err) {
    console.warn('[settings] pull failed:', err.message);
    return null;
  }
}
