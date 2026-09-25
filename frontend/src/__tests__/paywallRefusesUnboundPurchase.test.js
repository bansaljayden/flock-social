/**
 * THE PRO SHEET SAYS SO WHEN THE STORE CANNOT BE TOLD WHO IS BUYING.
 *
 * services/purchases.js now refuses to send a buy or a restore to the App Store
 * until RevenueCat holds the signed-in account (purchaseAccountBinding.test.js
 * has why). A refusal the sheet swallowed would be a Buy button that does
 * nothing, so the sheet says what happened: nothing was charged, and what to do.
 *
 * The real purchases.js runs here, under a fake RevenueCat plugin, so this is
 * the chain a tap actually takes: sheet, purchase(), the account check, and the
 * store call that must not happen.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */
import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';

const KEY_BEFORE = process.env.REACT_APP_REVENUECAT_IOS_KEY;
process.env.REACT_APP_REVENUECAT_IOS_KEY = 'appl_test_key';
afterAll(() => {
  if (KEY_BEFORE === undefined) delete process.env.REACT_APP_REVENUECAT_IOS_KEY;
  else process.env.REACT_APP_REVENUECAT_IOS_KEY = KEY_BEFORE;
});

jest.mock('../context/ThemeContext', () => ({ useTheme: () => ({ isDark: false }) }));
jest.mock('../services/api', () => ({
  getProStatus: jest.fn(),
  startProCheckout: jest.fn(),
  trackPaywallShown: jest.fn(),
  trackPurchaseCompleted: jest.fn(),
}));

// Plain functions over one state object: react-scripts sets resetMocks: true.
const mockRc = {
  reset() {
    this.appUserID = '$RCAnonymousID:0000aaaa';
    this.logInFails = false;
    this.charged = [];
    this.restoredFor = [];
  },
};
mockRc.reset();

const PKGS = [
  { identifier: '$rc_monthly', packageType: 'MONTHLY', product: { priceString: '$3.99', price: 3.99, introPrice: null }, presentedOfferingContext: {} },
  { identifier: '$rc_annual', packageType: 'ANNUAL', product: { priceString: '$29.99', price: 29.99, introPrice: null }, presentedOfferingContext: {} },
];

jest.mock('@revenuecat/purchases-capacitor', () => ({
  Purchases: {
    configure: (opts) => { if (opts && opts.appUserID) mockRc.appUserID = opts.appUserID; return Promise.resolve(); },
    isConfigured: () => Promise.resolve({ isConfigured: true }),
    getAppUserID: () => Promise.resolve({ appUserID: mockRc.appUserID }),
    logIn: ({ appUserID }) => {
      if (mockRc.logInFails) return Promise.reject(new Error('The Internet connection appears to be offline.'));
      mockRc.appUserID = appUserID;
      return Promise.resolve({ customerInfo: { entitlements: { active: {} } }, created: false });
    },
    logOut: () => Promise.resolve({ customerInfo: { entitlements: { active: {} } } }),
    getOfferings: () => Promise.resolve({ all: { default: { availablePackages: PKGS } }, current: null }),
    purchasePackage: () => {
      mockRc.charged.push(mockRc.appUserID);
      return Promise.resolve({ customerInfo: { entitlements: { active: { pro: {} } } } });
    },
    restorePurchases: () => {
      mockRc.restoredFor.push(mockRc.appUserID);
      return Promise.resolve({ customerInfo: { entitlements: { active: {} } } });
    },
  },
}));

// Required, not imported: an import is hoisted above the key assignment at the
// top of this file, and purchases.js reads the key when it loads.
const PaywallSheet = require('../components/PaywallSheet').default;
const { trackPurchaseCompleted } = require('../services/api');
const { initPurchases } = require('../services/purchases');

const MONTHLY_CTA = 'Get Pro, $3.99/month';
const REFUSED_BUY = 'Nothing was charged. Flock could not confirm your account with the App Store. Check your connection and try again.';
const REFUSED_RESTORE = 'Flock could not confirm your account with the App Store. Check your connection and try again.';

beforeEach(() => {
  mockRc.reset();
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { delete window.Capacitor; });

test('a buy the store cannot bind to this account is refused out loud, and retried once it can', async () => {
  // RevenueCat still holds the last account on this phone, and the new
  // session's logIn cannot get through.
  await initPurchases(3);
  mockRc.logInFails = true;
  await initPurchases(7);

  const onUpgraded = jest.fn();
  render(<PaywallSheet open trigger="settings" onClose={() => {}} onUpgraded={onUpgraded} showToast={() => {}} />);
  const cta = await screen.findByRole('button', { name: MONTHLY_CTA });
  await act(async () => { cta.click(); });

  expect(await screen.findByRole('alert')).toHaveTextContent(REFUSED_BUY);
  expect(mockRc.charged).toEqual([]);
  expect(trackPurchaseCompleted).not.toHaveBeenCalled();
  expect(onUpgraded).not.toHaveBeenCalled();

  // Signal back: the same tap now buys, as the account that is signed in.
  mockRc.logInFails = false;
  await act(async () => { screen.getByRole('button', { name: MONTHLY_CTA }).click(); });
  await waitFor(() => expect(onUpgraded).toHaveBeenCalledTimes(1));
  expect(mockRc.charged).toEqual(['7']);
  expect(trackPurchaseCompleted).toHaveBeenCalledWith('app_store', 'monthly');
});

test('a restore the store cannot bind to this account says why, instead of a bare failure', async () => {
  await initPurchases(3);
  mockRc.logInFails = true;
  await initPurchases(7);

  const showToast = jest.fn();
  render(<PaywallSheet open trigger="settings" onClose={() => {}} showToast={showToast} />);
  await screen.findByRole('button', { name: MONTHLY_CTA });
  await act(async () => { screen.getByRole('button', { name: 'Restore purchases' }).click(); });

  await waitFor(() => expect(showToast).toHaveBeenCalledWith(REFUSED_RESTORE, 'error'));
  expect(mockRc.restoredFor).toEqual([]);
});
