import React, { createContext, useState, useEffect, useContext, useCallback } from 'react';

const ThemeContext = createContext();

const isNightTime = () => {
  const hour = new Date().getHours();
  return hour >= 20 || hour < 6;
};

export const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState('light');
  const [themeMode, setThemeMode] = useState('auto');
  const [isNightModeActive, setIsNightModeActive] = useState(false);

  const applyTheme = useCallback((newTheme) => {
    setTheme(newTheme);
    document.documentElement.setAttribute('data-theme', newTheme);
  }, []);

  // Load saved preferences on mount
  useEffect(() => {
    const savedMode = localStorage.getItem('flock-theme-mode') || 'auto';
    const savedTheme = localStorage.getItem('flock-theme') || 'light';

    setThemeMode(savedMode);

    if (savedMode === 'auto') {
      const nightTime = isNightTime();
      setIsNightModeActive(nightTime);
      applyTheme(nightTime ? 'dark' : 'light');
    } else {
      setIsNightModeActive(false);
      applyTheme(savedTheme);
    }
  }, [applyTheme]);

  // Check time every minute for auto mode
  useEffect(() => {
    if (themeMode !== 'auto') return;

    const check = () => {
      const nightTime = isNightTime();
      if (nightTime && theme === 'light') {
        setIsNightModeActive(true);
        applyTheme('dark');
      } else if (!nightTime && theme === 'dark') {
        setIsNightModeActive(false);
        applyTheme('light');
      }
    };

    const interval = setInterval(check, 60000);
    return () => clearInterval(interval);
  }, [themeMode, theme, applyTheme]);

  const toggleTheme = useCallback(() => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setThemeMode('manual');
    setIsNightModeActive(false);
    applyTheme(newTheme);
    localStorage.setItem('flock-theme', newTheme);
    localStorage.setItem('flock-theme-mode', 'manual');
  }, [theme, applyTheme]);

  const setAutoMode = useCallback((auto) => {
    const newMode = auto ? 'auto' : 'manual';
    setThemeMode(newMode);
    localStorage.setItem('flock-theme-mode', newMode);

    if (auto) {
      const nightTime = isNightTime();
      setIsNightModeActive(nightTime);
      applyTheme(nightTime ? 'dark' : 'light');
    } else {
      setIsNightModeActive(false);
      localStorage.setItem('flock-theme', theme);
    }
  }, [theme, applyTheme]);

  return (
    <ThemeContext.Provider value={{
      theme,
      themeMode,
      isNightModeActive,
      toggleTheme,
      setAutoMode,
      isDark: theme === 'dark',
    }}>
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
