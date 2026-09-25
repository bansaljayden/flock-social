/**
 * ONE ANSWER TO "IS THIS THE NATIVE APP", FOR EVERY SURFACE THAT SELLS.
 *
 * index.js boots on lib/nativeShell.js: the capacitor: protocol, a bridge
 * answering isNativePlatform() or getPlatform(), or a bridge that is present
 * and answers nothing all mean the app. The four surfaces that can sell (the
 * Pro sheet, the You tab's Flock Pro row, /pro and Roost's buy and manage
 * buttons) each used to ask window.Capacitor.isNativePlatform() alone, so a
 * shell the boot check called native could still have been shown Stripe
 * prices, a link to /pro or a Roost buy button, which inside the iOS app is an
 * App Review guideline 3.1.1 problem. They ask the same module now, and these
 * pin both halves: the detector's answers, and each surface's behaviour under a
 * bridge the old check would have read as a browser.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

jest.mock('../context/ThemeContext', () => ({ useTheme: () => ({ isDark: false }) }));
jest.mock('../services/api', () => ({
  cancelProSubscription: jest.fn(),
  getProStatus: jest.fn(),
  getToken: jest.fn(),
  getVenueBillingStatus: jest.fn(),
  openProPortal: jest.fn(),
  openVenuePortal: jest.fn(),
  resumeProSubscription: jest.fn(),
  startProCheckout: jest.fn(),
  startVenueCheckout: jest.fn(),
  trackPaywallShown: jest.fn(),
  trackPurchaseCompleted: jest.fn(),
}));
jest.mock('../services/purchases', () => ({
  isPurchasesAvailable: jest.fn(() => false),
  getProOffering: jest.fn(),
  purchase: jest.fn(),
  restore: jest.fn(),
}));
jest.mock('../services/firebase', () => ({
  getNotificationStatus: jest.fn(),
  requestNotificationPermission: jest.fn(),
}));

// eslint-disable-next-line import/first
import { detectNativeShell, isNativeShell } from '../lib/nativeShell';
// eslint-disable-next-line import/first
import { getProStatus, getToken, getVenueBillingStatus } from '../services/api';
// eslint-disable-next-line import/first
import PaywallSheet from '../components/PaywallSheet';
// eslint-disable-next-line import/first
import ProPage from '../website/ProPage';
// eslint-disable-next-line import/first
import VenueBillingControl from '../components/venue/VenueBillingControl';
// eslint-disable-next-line import/first
import { ProRow } from '../screens/ProfileSettings';

const SRC = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// What the old per-surface check could not see: a bridge that answers
// getPlatform() and nothing else. index.js boots it as the app.
const HALF_BRIDGE = { getPlatform: () => 'ios' };

afterEach(() => {
  jest.clearAllMocks();
  delete window.Capacitor;
});

describe('the detector', () => {
  test('a browser with no bridge is the web', () => {
    expect(detectNativeShell()).toBe(false);
    expect(isNativeShell()).toBe(false);
  });

  test('@capacitor/core loaded in a browser answers web, and that is the web', () => {
    window.Capacitor = { isNativePlatform: () => false, getPlatform: () => 'web' };
    expect(detectNativeShell()).toBe(false);
    expect(isNativeShell()).toBe(false);
  });

  test.each([
    ['answers isNativePlatform', { isNativePlatform: () => true }],
    ['answers only getPlatform', HALF_BRIDGE],
    ['is present and answers nothing', {}],
    ['throws when asked', { isNativePlatform: () => { throw new Error('bridge'); } }],
  ])('a bridge that %s is the app', (_label, bridge) => {
    window.Capacitor = bridge;
    expect(detectNativeShell()).toBe(true);
    expect(isNativeShell()).toBe(true);
  });

  test('capacitor://localhost is the app whatever the bridge says', () => {
    const shell = { location: { protocol: 'capacitor:' }, Capacitor: { isNativePlatform: () => false } };
    expect(detectNativeShell(shell)).toBe(true);
    expect(detectNativeShell({ location: { protocol: 'https:' } })).toBe(false);
  });

  test('a shell that booted as the app stays the app if the bridge changes its answer later', () => {
    window.Capacitor = {};
    jest.isolateModules(() => {
      const booted = require('../lib/nativeShell');
      // What @capacitor/core does to the same object once a plugin chunk loads.
      window.Capacitor = { isNativePlatform: () => false, getPlatform: () => 'web' };
      expect(booted.detectNativeShell()).toBe(false);
      expect(booted.isNativeShell()).toBe(true);
    });
  });
});

describe('every surface that sells asks the one module', () => {
  const SURFACES = [
    ['components/PaywallSheet.js', "from '../lib/nativeShell'"],
    ['website/ProPage.js', "from '../lib/nativeShell'"],
    ['screens/ProfileSettings.js', "from '../lib/nativeShell'"],
    ['components/venue/VenueBillingControl.js', "from '../../lib/nativeShell'"],
  ];

  test.each(SURFACES)('%s imports isNativeShell and keeps no check of its own', (file, from) => {
    const src = read(file);
    expect(src).toContain(`import { isNativeShell } ${from};`);
    // The old copies, each a different subset of what the boot check reads.
    expect(stripComments(src)).not.toMatch(/function isNative(Shell)?\s*\(/);
    expect(stripComments(src)).not.toMatch(/const isNativeShell\s*=/);
  });

  test('ProfileSettings asks it for the Pro row, the one place there that sells', () => {
    const src = read('screens/ProfileSettings.js');
    const row = src.slice(src.indexOf('export function ProRow('));
    expect(row).toMatch(/const native = isNativeShell\(\);/);
    expect(row).not.toMatch(/isNativePlatform/);
  });

  test('the boot router imports the same detector instead of defining one', () => {
    const index = read('index.js');
    expect(index).toContain("import { detectNativeShell } from './lib/nativeShell';");
    expect(index).toMatch(/const isNativeShell = detectNativeShell\(\);/);
    expect(stripComments(index)).not.toMatch(/const detectNativeShell\s*=/);
    expect(stripComments(index)).not.toMatch(/function detectNativeShell/);
  });
});

describe('under a bridge the old checks read as a browser', () => {
  beforeEach(() => { window.Capacitor = HALF_BRIDGE; });

  test('the Pro sheet sells nothing from Stripe and never asks for web prices', async () => {
    const { container } = render(<PaywallSheet open trigger="forecast" onClose={() => {}} />);
    await screen.findByText("Flock Pro can't be bought in the app yet.");
    expect(getProStatus).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/\$\s?\d/);
    expect(container.textContent).not.toMatch(/flockcorp|website/i);
  });

  test('/pro renders nothing', () => {
    getToken.mockReturnValue('t');
    const { container } = render(<ProPage />);
    expect(container.innerHTML).toBe('');
    expect(getProStatus).not.toHaveBeenCalled();
  });

  test('Roost shows only the email request and never asks for its plans', () => {
    render(<VenueBillingControl fallback={<button type="button">Email us about Pro</button>} />);
    expect(getVenueBillingStatus).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Email us about Pro' })).toBeTruthy();
    expect(screen.queryByText(/Try free|Subscribe|Checking Roost plans/)).toBeNull();
  });

  test('the You tab row opens the App Store sheet, with no link to /pro', async () => {
    const setPaywallTrigger = jest.fn();
    const { container } = render(
      <ProRow isPro={false} entitlements={{ paywallEnabled: true }} colors={{ navy: '#0d2847' }} setPaywallTrigger={setPaywallTrigger} showToast={() => {}} />
    );
    const row = screen.getByRole('button', { name: /Flock Pro/ });
    expect(container.querySelector('a[href="/pro"]')).toBeNull();
    row.click();
    await waitFor(() => expect(setPaywallTrigger).toHaveBeenCalledWith('settings'));
    expect(getProStatus).not.toHaveBeenCalled();
  });
});
