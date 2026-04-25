import { getUserSettings, updateUserSettings } from './api';

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
    if (!localStorage.getItem('flockToken')) return;
    updateUserSettings(payload).catch(err => console.warn('[settings] sync failed:', err.message));
  }, 600);
}

export async function pullSettings() {
  if (!localStorage.getItem('flockToken')) return null;
  try {
    const { settings } = await getUserSettings();
    if (!settings || typeof settings !== 'object') return null;
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
