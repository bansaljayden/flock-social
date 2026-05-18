import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Appearance } from 'react-native';
import { lightColors, darkColors } from '../theme/colors';
import { typography } from '../theme/typography';
import { spacing, radius, screenPadding } from '../theme/spacing';

// Mirrors the web app's three-state theme: 'auto' follows system, 'light' and
// 'dark' are explicit overrides. Persisted in AsyncStorage under 'flock_theme'.

const STORAGE_KEY = 'flock_theme';

const ThemeContext = createContext({
  mode: 'dark',
  isDark: true,
  colors: darkColors,
  typography,
  spacing,
  radius,
  screenPadding,
  setMode: () => {},
});

export function ThemeProvider({ children }) {
  const [mode, setModeState] = useState('dark'); // 'auto' | 'light' | 'dark'
  const [systemScheme, setSystemScheme] = useState(Appearance.getColorScheme() || 'dark');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((stored) => {
      if (stored === 'light' || stored === 'dark' || stored === 'auto') setModeState(stored);
    });
    const sub = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemScheme(colorScheme || 'dark');
    });
    return () => sub.remove();
  }, []);

  const setMode = async (next) => {
    setModeState(next);
    await AsyncStorage.setItem(STORAGE_KEY, next);
  };

  const isDark = mode === 'dark' || (mode === 'auto' && systemScheme === 'dark');
  const colors = isDark ? darkColors : lightColors;

  const value = useMemo(() => ({
    mode, isDark, colors, typography, spacing, radius, screenPadding, setMode,
  }), [mode, isDark, colors]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
