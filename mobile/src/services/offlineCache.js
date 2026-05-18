import AsyncStorage from '@react-native-async-storage/async-storage';

// Tiny offline cache. Stores JSON-serializable values keyed by string.
// Each entry is { value, ts } so callers can decide whether to trust it
// (e.g. ignore caches older than 5 minutes for freshness-sensitive data).
//
// Used by useCachedFetch (see hooks/useCachedFetch.js): when a screen
// mounts, we hydrate from the cache instantly so the UI isn't empty,
// then fire the live request to refresh.

const PREFIX = 'flock_cache:';

export async function readCache(key) {
  try {
    const raw = await AsyncStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed; // { value, ts }
  } catch {
    return null;
  }
}

export async function writeCache(key, value) {
  try {
    await AsyncStorage.setItem(PREFIX + key, JSON.stringify({ value, ts: Date.now() }));
  } catch {
    // Best-effort. Device storage full / etc. — don't crash UI.
  }
}

export async function clearCache(key) {
  try {
    if (key) await AsyncStorage.removeItem(PREFIX + key);
    else {
      const all = await AsyncStorage.getAllKeys();
      const ours = all.filter((k) => k.startsWith(PREFIX));
      await AsyncStorage.multiRemove(ours);
    }
  } catch {}
}

// Canonical cache keys — define here so we don't typo across the codebase.
export const CacheKeys = {
  Flocks: 'flocks_list',
  DMs: 'dm_list',
  Friends: 'friends_list',
  Profile: 'profile_me',
  Stats: 'user_stats',
};

// Stale-after thresholds (ms) — used by `isFresh()` callers if they want
// to gate UI on freshness. Cache is still served past these, just marked
// stale so screens can show a "Reconnecting..." indicator.
export const FRESH = {
  short: 60 * 1000,           // 1 min — chat/lists during active use
  medium: 5 * 60 * 1000,      // 5 min — flock list, DM list
  long: 60 * 60 * 1000,       // 1 hour — friends, profile
};

export function isFresh(entry, withinMs) {
  return !!entry && Date.now() - entry.ts < withinMs;
}
