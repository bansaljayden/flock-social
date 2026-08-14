import React, { createContext, useState, useEffect, useContext, useCallback, useMemo, useRef } from 'react';
import { queueSync } from '../services/userSettings';

const ThemeContext = createContext();

// Storage keys. src/index.js resolves the theme from these same two keys
// before the App chunk is even requested, and src/services/userSettings.js
// mirrors them to the server. Renaming one means renaming it in three places.
const THEME_KEY = 'flock-theme';
const MODE_KEY = 'flock-theme-mode';

// Safari private mode and "block all cookies" make localStorage itself throw
// on access, not just return null. Uncaught inside a mount effect that is a
// white screen, so nothing in this file touches storage directly.
const readStore = (key) => {
  try { return window.localStorage.getItem(key); } catch { return null; }
};

const writeStore = (key, value) => {
  try { window.localStorage.setItem(key, value); } catch { /* not remembering is survivable */ }
};

// Auto mode is a CLOCK, not the OS setting, and the settings screen says so
// out loud ("Auto dark at 8 PM, light at 6 AM"). Keep this window in sync with
// the copy in App.js and with the same three lines in src/index.js.
const isNightTime = () => {
  const hour = new Date().getHours();
  return hour >= 20 || hour < 6;
};

// Both values are validated rather than trusted. A corrupted "flock-theme" of
// anything other than dark/light used to be written straight onto
// <html data-theme>, which matches no token block in index.css and paints an
// unstyled page.
const readMode = () => (readStore(MODE_KEY) === 'manual' ? 'manual' : 'auto');
const readSavedTheme = () => (readStore(THEME_KEY) === 'dark' ? 'dark' : 'light');
const resolveTheme = (mode) => (mode === 'auto' ? (isNightTime() ? 'dark' : 'light') : readSavedTheme());

const setDomTheme = (theme) => {
  try { document.documentElement.setAttribute('data-theme', theme); } catch { /* no document, no paint to fix */ }
};

const readDomTheme = () => {
  try { return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
};

// Applied at module load, which is before the provider's first render and
// therefore before first paint. This used to happen in a mount effect, i.e.
// after React had already painted a light screen, so every dark-mode user got
// a full-brightness cream flash on launch. index.js applies the same result
// even earlier; this line is what keeps the provider correct on its own, and
// it re-resolves the clock in case the chunk download crossed 8 PM.
try { setDomTheme(resolveTheme(readMode())); } catch { /* never block the app on a theme */ }

export const ThemeProvider = ({ children }) => {
  // Seeded from the attribute that is already on <html>, so the first render
  // agrees with the first paint instead of correcting it one frame later.
  const [theme, setTheme] = useState(readDomTheme);
  const [themeMode, setThemeMode] = useState(readMode);
  const [isNightModeActive, setIsNightModeActive] = useState(() => readMode() === 'auto' && isNightTime());

  // The auto-mode watcher needs the current theme without listing it as a
  // dependency, otherwise every sunset tears the interval down and restarts
  // its 60 second phase.
  const themeRef = useRef(theme);

  const applyTheme = useCallback((newTheme) => {
    themeRef.current = newTheme;
    setTheme(newTheme);
    setDomTheme(newTheme);
  }, []);

  // Auto mode: follow the clock.
  useEffect(() => {
    if (themeMode !== 'auto') return undefined;

    const check = () => {
      const nightTime = isNightTime();
      setIsNightModeActive(nightTime);
      const wanted = nightTime ? 'dark' : 'light';
      if (themeRef.current !== wanted) applyTheme(wanted);
    };

    // Run once immediately: on a slow cold start the value resolved at module
    // load can already be minutes old.
    check();

    const interval = setInterval(check, 60000);

    // A backgrounded WebView freezes its timers. Without these, an app that
    // spent the evening in someone's pocket comes back still painted for the
    // afternoon and only corrects itself up to a minute later.
    const onVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', check);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', check);
    };
  }, [themeMode, applyTheme]);

  const toggleTheme = useCallback(() => {
    const newTheme = themeRef.current === 'light' ? 'dark' : 'light';
    setThemeMode('manual');
    setIsNightModeActive(false);
    applyTheme(newTheme);
    writeStore(THEME_KEY, newTheme);
    writeStore(MODE_KEY, 'manual');
    queueSync({ theme: newTheme, themeMode: 'manual' });
  }, [applyTheme]);

  const setAutoMode = useCallback((auto) => {
    const newMode = auto ? 'auto' : 'manual';
    setThemeMode(newMode);
    writeStore(MODE_KEY, newMode);

    if (auto) {
      const nightTime = isNightTime();
      setIsNightModeActive(nightTime);
      applyTheme(nightTime ? 'dark' : 'light');
      queueSync({ themeMode: 'auto' });
    } else {
      // Leaving auto keeps whatever is on screen right now as the manual
      // choice, so the lights do not change under the user's hands.
      const current = themeRef.current;
      setIsNightModeActive(false);
      writeStore(THEME_KEY, current);
      queueSync({ themeMode: 'manual', theme: current });
    }
  }, [applyTheme]);

  // Re-apply theme settings when the user logs in and server settings are
  // pulled. pullSettings() writes to localStorage, then dispatches this event.
  useEffect(() => {
    const onSync = () => {
      const savedMode = readMode();
      setThemeMode(savedMode);
      if (savedMode === 'auto') {
        const nightTime = isNightTime();
        setIsNightModeActive(nightTime);
        applyTheme(nightTime ? 'dark' : 'light');
      } else {
        setIsNightModeActive(false);
        applyTheme(readSavedTheme());
      }
    };
    window.addEventListener('flock-settings-loaded', onSync);
    return () => window.removeEventListener('flock-settings-loaded', onSync);
  }, [applyTheme]);

  const value = useMemo(() => ({
    theme,
    themeMode,
    isNightModeActive,
    toggleTheme,
    setAutoMode,
    isDark: theme === 'dark',
  }), [theme, themeMode, isNightModeActive, toggleTheme, setAutoMode]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
};
