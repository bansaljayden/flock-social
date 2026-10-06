/**
 * THE DELETION SHEET'S SUBSCRIPTION WARNING, INSIDE THE APP THAT SELLS PRO.
 *
 * Deleting a Flock account cancels a Flock Pro subscription bought on the web
 * (the server closes the Stripe customer) and cannot cancel one bought in the
 * App Store, so the sheet has to say the second, and Apple expects it to.
 *
 * In a build with purchases on, the native app showed the web's sentence:
 * "Flock Pro bought on flockcorp.com is cancelled when you delete your
 * account", which names the website as a place Pro is bought, inside the app.
 * And it showed it only with the paywall on or to a known subscriber, so an
 * account whose Pro status could not be read lost the warning, while the build
 * that sells nothing already warned that account.
 *
 * Now, inside the app with purchases on, the sheet gives the App Store half
 * alone, to a subscriber, to anyone while Pro is on sale, and to an account
 * whose status is unknown. The website keeps its sentence and its rule, and the
 * build that sells nothing keeps its neutral one.
 *
 * The real ProfileSettings is rendered with the sheet open, every prop given a
 * neutral value read off the screen's own signature (accountReconfirmInPlace
 * does the same).
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test deletionNoteInApp --watchAll=false
 */
const React = require('react');
const fs = require('fs');
const path = require('path');
const { render, screen, act } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  deleteAccount: jest.fn(),
  trackNotificationPermission: jest.fn(),
  updatePaymentMethods: jest.fn(),
  logoutAll: jest.fn(),
  getCurrentUser: jest.fn(),
  clearLocalSession: jest.fn(),
  getProStatus: jest.fn(),
  openProPortal: jest.fn(),
  cancelProSubscription: jest.fn(),
  resumeProSubscription: jest.fn(),
  appleLogin: jest.fn(),
  googleLogin: jest.fn(),
  googleLoginWithToken: jest.fn(),
  getAnalyticsChoice: jest.fn(),
  setAnalyticsChoice: jest.fn(),
  knownAnalyticsChoice: jest.fn(),
}));
jest.mock('../services/firebase', () => ({
  getNotificationStatus: jest.fn(),
  requestNotificationPermission: jest.fn(),
}));
jest.mock('@react-oauth/google', () => ({
  useGoogleLogin: () => () => {},
  GoogleOAuthProvider: ({ children }) => children,
}));
jest.mock('@capacitor-community/apple-sign-in', () => ({ SignInWithApple: { authorize: () => Promise.resolve({}) } }));
jest.mock('@capgo/capacitor-social-login', () => ({
  SocialLogin: { initialize: () => Promise.resolve(), login: () => Promise.resolve({ result: {} }) },
}));
jest.mock('../components/ui/BirdieBird', () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, BirdieStill: Stub, BirdNote: Stub, WARM_BIRD: {} };
});

const api = require('../services/api');
const ProfileSettings = require('../screens/ProfileSettings').default;

const SRC = path.join(__dirname, '..');
const PROFILE_SRC = fs.readFileSync(path.join(SRC, 'screens', 'ProfileSettings.js'), 'utf8');

const PARAMS = (() => {
  const start = PROFILE_SRC.indexOf('export default function ProfileSettings({');
  const block = PROFILE_SRC.slice(start, PROFILE_SRC.indexOf('}) {', start));
  return [...block.matchAll(/^\s+([A-Za-z_]\w*),/gm)].map((m) => m[1]);
})();
const COMPONENTS = new Set(['DialogBehavior', 'ListSkeleton', 'SearchInputLocal', 'Toggle', 'BottomNav', 'SafetyButton']);
const ARRAYS = new Set(['blockedUsers', 'flocks', 'pendingRequests', 'trustedContacts', 'userInterests', 'suggestedInterests']);

function sheet({ entitlements, isPro, entitlementsUnknown }) {
  const props = {};
  for (const name of PARAMS) {
    if (COMPONENTS.has(name)) props[name] = () => null;
    else if (ARRAYS.has(name)) props[name] = [];
    else if (name === 'showToast' || /^(set|handle|load|on[A-Z]|toggle|switch|confirm|open|needs|session|answer)/.test(name)) props[name] = jest.fn();
    else props[name] = undefined;
  }
  return render(React.createElement(ProfileSettings, {
    ...props,
    colors: {},
    styles: { card: {}, input: {}, gradientButton: {} },
    PROFILE_SUBSCREEN_TITLES: {},
    deleteAlertRef: React.createRef(),
    newContact: {},
    profileScreen: 'main',
    sessionEndCopy: (reason) => `ended: ${reason}`,
    needsEmailVerification: () => false,
    authUser: { id: 42, sign_in_method: 'password' },
    showDeleteAccount: true,
    deleteConfirmText: '',
    deletePassword: '',
    entitlements,
    isPro,
    entitlementsUnknown,
  }));
}

// The sheet's own words, so nothing else on the You tab can answer for it.
const sheetText = () => screen.getByText('Delete your account?').parentElement.textContent;

const APP_STORE_NOTE = 'Deleting your account does not cancel Flock Pro bought in the App Store. It keeps renewing until you cancel it in your Apple ID settings, under Subscriptions.';
const WEB_NOTE = 'Flock Pro bought on flockcorp.com is cancelled when you delete your account. Flock Pro bought in the App Store is not: cancel it first in your Apple ID settings, under Subscriptions.';
const NEUTRAL_NOTE = 'Deleting your account does not cancel a subscription paid through the App Store. Cancel it first in the Settings app: tap your name, then Subscriptions.';

// What App.js hands the screen in each state the entitlement snapshot can be in.
const STATES = {
  unknown: { entitlements: null, isPro: false, entitlementsUnknown: true },
  failedRead: { entitlements: { error: 'Server error' }, isPro: false, entitlementsUnknown: true },
  subscriber: { entitlements: { isPremium: true, paywallEnabled: true }, isPro: true, entitlementsUnknown: false },
  onSale: { entitlements: { isPremium: false, paywallEnabled: true }, isPro: false, entitlementsUnknown: false },
  nothingSold: { entitlements: { isPremium: false, paywallEnabled: false }, isPro: false, entitlementsUnknown: false },
};

const FLAG_BEFORE = process.env.REACT_APP_PURCHASES;
const inTheApp = () => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }; };
const opened = async (state) => {
  const r = sheet(STATES[state]);
  // The Pro row's status read and the analytics switch's read settle first.
  await act(async () => {});
  return r;
};

beforeEach(() => {
  delete process.env.REACT_APP_PURCHASES;
  api.getProStatus.mockResolvedValue({});
  api.getAnalyticsChoice.mockResolvedValue({ optOut: false });
  api.knownAnalyticsChoice.mockReturnValue(null);
});
afterEach(() => {
  if (FLAG_BEFORE === undefined) delete process.env.REACT_APP_PURCHASES;
  else process.env.REACT_APP_PURCHASES = FLAG_BEFORE;
  delete window.Capacitor;
});

describe('inside the app, with purchases on', () => {
  beforeEach(() => { inTheApp(); });

  test.each(['unknown', 'failedRead', 'subscriber', 'onSale'])('%s: the App Store warning, and nothing about the website', async (state) => {
    const { unmount } = await opened(state);
    const text = sheetText();
    expect(text).toContain(APP_STORE_NOTE);
    expect(text).not.toMatch(/flockcorp|website|on the web/i);
    expect(text).not.toContain(WEB_NOTE);
    unmount();
  });

  test('an account that is known not to have Pro, with nothing on sale, is not told about a subscription', async () => {
    await opened('nothingSold');
    expect(sheetText()).not.toMatch(/App Store|Subscriptions/);
  });

  test('the warning says the subscription keeps renewing and where to stop it', () => {
    expect(APP_STORE_NOTE).toMatch(/keeps renewing until you cancel it in your Apple ID settings, under Subscriptions/);
    expect(APP_STORE_NOTE).not.toMatch(/—|\$\d|http/);
  });
});

describe('on the website, with purchases on, as before', () => {
  test('with Pro on sale, the sentence that names both stores', async () => {
    await opened('onSale');
    expect(sheetText()).toContain(WEB_NOTE);
  });

  test('a subscriber gets it too', async () => {
    await opened('subscriber');
    expect(sheetText()).toContain(WEB_NOTE);
  });

  test('an unknown answer keeps the rule the website has always had', async () => {
    await opened('unknown');
    expect(sheetText()).not.toContain(WEB_NOTE);
    expect(sheetText()).not.toContain(APP_STORE_NOTE);
  });
});

describe('a build that sells nothing, unchanged', () => {
  beforeEach(() => { process.env.REACT_APP_PURCHASES = 'off'; });

  test.each([['on the web', false], ['in the app', true]])('%s, a subscriber or an unknown answer gets the neutral warning', async (_where, native) => {
    if (native) inTheApp();
    for (const state of ['unknown', 'subscriber']) {
      // eslint-disable-next-line no-await-in-loop
      const { unmount } = await opened(state);
      expect(sheetText()).toContain(NEUTRAL_NOTE);
      expect(sheetText()).not.toMatch(/Flock Pro|flockcorp/);
      unmount();
    }
  });

  test('an account known not to pay is not told about a subscription', async () => {
    inTheApp();
    await opened('onSale');
    expect(sheetText()).not.toContain(NEUTRAL_NOTE);
  });
});
