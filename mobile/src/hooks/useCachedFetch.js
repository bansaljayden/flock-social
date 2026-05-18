import { useEffect, useState, useCallback, useRef } from 'react';
import { readCache, writeCache } from '../services/offlineCache';

// Hook that hydrates from AsyncStorage immediately and then fetches live.
// Behavior:
//   1. On mount, read cached value (if any) and put it in state with `cached: true`.
//   2. Kick off the live fetch.
//   3. On success: update state with live value, persist to cache, mark `cached: false`.
//   4. On failure: keep showing cached value, set `error`.
//
// Caller passes:
//   - cacheKey: stable string (use CacheKeys constants)
//   - fetcher: async () => any
//   - extract: (response) => array | object   (selector to pull just the
//                                              relevant slice off the response)
//   - deps: any[] — passed through to useEffect
//
// Returns:
//   { data, loading, error, cached, refresh }

export function useCachedFetch({ cacheKey, fetcher, extract = (x) => x, deps = [] }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cached, setCached] = useState(false);
  const [error, setError] = useState(null);

  // Track most-recent in-flight request so a fast caller-triggered refresh
  // doesn't cause an older fetch's response to clobber a newer one's.
  const reqIdRef = useRef(0);

  const live = useCallback(async () => {
    const id = ++reqIdRef.current;
    try {
      const res = await fetcher();
      if (id !== reqIdRef.current) return;
      const value = extract(res);
      setData(value);
      setCached(false);
      setError(null);
      writeCache(cacheKey, value);
    } catch (e) {
      if (id !== reqIdRef.current) return;
      setError(e);
    } finally {
      if (id === reqIdRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, fetcher, extract]);

  // Hydrate from cache + kick off live on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const entry = await readCache(cacheKey);
      if (cancelled) return;
      if (entry?.value != null) {
        setData(entry.value);
        setCached(true);
        // We can stop the loading spinner once we have anything to show
        setLoading(false);
      }
      live();
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, ...deps]);

  return { data, loading, error, cached, refresh: live };
}
