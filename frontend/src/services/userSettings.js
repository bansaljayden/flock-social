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
};

const JSON_KEYS = new Set(['pinnedFlockIds', 'flockOrder']);

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
    updateUserSettings(payload).catch(err => console.warn('[settings] sync failed:', err.message));
  }, 600);
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
