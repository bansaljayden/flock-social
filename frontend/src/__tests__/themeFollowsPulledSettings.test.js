/**
 * The theme listener takes the pull's own values. It used to re-read storage,
 * so a write the pull could not make (storage at quota) left the old mode
 * there and every pull put the screen back in it (code review 12,
 * 2026-10-07).
 */
import React from 'react';
import { render, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../context/ThemeContext';

jest.mock('../services/userSettings', () => ({ queueSync: jest.fn() }));

let seen = null;
function Probe() {
  seen = useTheme();
  return null;
}
const pull = (detail) => act(() => {
  window.dispatchEvent(new CustomEvent('flock-settings-loaded', { detail }));
});

beforeEach(() => {
  localStorage.clear();
  seen = null;
});

test('a pulled manual mode is applied even when storage still says auto', () => {
  localStorage.setItem('flock-theme-mode', 'auto');
  render(React.createElement(ThemeProvider, null, React.createElement(Probe)));
  pull({ themeMode: 'manual', theme: 'dark' });
  expect(seen.themeMode).toBe('manual');
  expect(seen.theme).toBe('dark');
});

test('a key the pull did not hand on leaves the screen as it is', () => {
  localStorage.setItem('flock-theme-mode', 'auto');
  render(React.createElement(ThemeProvider, null, React.createElement(Probe)));
  pull({ themeMode: 'manual', theme: 'dark' });
  // The next pull hands on nothing for the theme: this device holds a newer
  // choice, or the account has none. Storage still says auto.
  pull({});
  expect(seen.themeMode).toBe('manual');
  expect(seen.theme).toBe('dark');
});
