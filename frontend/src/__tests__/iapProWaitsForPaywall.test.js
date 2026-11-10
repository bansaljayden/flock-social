/**
 * THE APP STORE BUILD SHOWS FLOCK PRO ONLY WHERE THE SERVER HAS THE PAYWALL ON.
 *
 * PAYWALL_ENABLED is off in production (2026-11-10). The build that sells Pro
 * through Apple (REACT_APP_PURCHASES=iap, lib/purchasesBuild.js) carries the
 * Pro sheet and the You tab's Flock Pro row, and they must not appear to
 * anybody before the paywall is turned on, except the App Review account,
 * which has to find the subscription and buy it in sandbox while the switch is
 * still off for everyone else.
 *
 * The flow, read end to end:
 *   - The server decides per account. GET /api/entitlements answers
 *     paywallEnabled from services/entitlements.js paywallEnabled(userId):
 *     true with PAYWALL_ENABLED=true, or for an account on
 *     PAYWALL_PREVIEW_USER_IDS, false for everybody else
 *     (backend/__tests__/entitlementGates.test.js, "the review list turns the
 *     paywall on for the listed accounts only" and "a review account is
 *     metered exactly like a free account will be, and nobody else is").
 *   - App.js keeps that answer as `entitlements` (null until it lands, and
 *     after a failed read).
 *   - Every way into the Pro sheet waits for it: the You tab's row and the
 *     crowd alerts button read entitlements.paywallEnabled; Birdie's spent
 *     day reads it too (outOfChirps); Birdie's 429 and the venue card's
 *     locked forecast come only from a server that meters this account, which
 *     it does only when paywallEnabled(userId) is true.
 *
 * So below: the real You tab, rendered as the App Store build inside the app,
 * for a normal account with the paywall off, for one whose entitlements have
 * not arrived, for the preview account, and for an account that already has
 * Pro; then the other openers, read as source.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test iapProWaitsForPaywall --watchAll=false
 */
const React = require('react');
const fs = require('fs');
const path = require('path');
const { render, screen, waitFor, act } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  deleteAccount: jest.fn(),
  trackNotificationPermission: jest.fn(),
  updatePaymentMethods: jest.fn(),
  logoutAll: jest.fn(),
  currentAccount: jest.fn(),
  getCurrentUser: jest.fn(),
  clearLocalSession: jest.fn(),
  getProStatus: jest.fn(),
  openProPortal: jest.fn(),
  cancelProSubscription: jest.fn(),
  resumeProSubscription: jest.fn(),
  getAnalyticsChoice: jest.fn(),
  setAnalyticsChoice: jest.fn(),
  knownAnalyticsChoice: jest.fn(),
  getPrivacySettings: jest.fn(),
  setPrivacySettings: jest.fn(),
  appleLogin: jest.fn(),
  googleLogin: jest.fn(),
  googleLoginWithToken: jest.fn(),
  userMessage: jest.requireActual('../services/api').userMessage,
}));
jest.mock('../services/firebase', () => ({
  getNotificationStatus: jest.fn(),
  requestNotificationPermission: jest.fn(),
}));
jest.mock('@react-oauth/google', () => ({
  useGoogleLogin: () => () => {},
  GoogleOAuthProvider: ({ children }) => children,
}));
jest.mock('@capacitor-community/apple-sign-in', () => ({
  SignInWithApple: { authorize: () => Promise.resolve({}) },
}));
jest.mock('@capgo/capacitor-social-login', () => ({
  SocialLogin: { initialize: () => Promise.resolve(), login: () => Promise.resolve({}) },
}));
jest.mock('../components/ui/BirdieBird', () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, BirdieStill: Stub, BirdNote: Stub, WARM_BIRD: {} };
});

const api = require('../services/api');
const ProfileSettings = require('../screens/ProfileSettings').default;

const SRC = path.join(__dirname, '..');
const REPO = path.join(SRC, '..', '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const readRepo = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8').replace(/\r\n/g, '\n');
const PROFILE_SRC = read('screens', 'ProfileSettings.js');
const APP_SRC = read('App.js');

// GET /api/entitlements, as services/entitlements.js getEntitlements answers
// it with PAYWALL_ENABLED off: an ordinary account is unmetered, and the
// account on PAYWALL_PREVIEW_USER_IDS is metered as a free account will be.
const PAYWALL_OFF = {
  isPremium: false, paywallEnabled: false, graceEndsAt: null,
  birdie: { limit: 150, used: 0, remaining: 150, resetsAt: null },
  forecast: { limit: null, used: 0, remaining: null },
};
const PREVIEW_ACCOUNT = {
  isPremium: false, paywallEnabled: true, graceEndsAt: null,
  birdie: { limit: 10, used: 0, remaining: 10, resetsAt: null },
  forecast: { limit: 30, used: 0, remaining: 30 },
};

// App.js's Toggle, as usageAnalyticsSwitch.test.js copies it.
const Toggle = ({ on, onChange, label }) => (
  React.createElement('button', { className: 'hit44', role: 'switch', 'aria-checked': !!on, 'aria-label': label, onClick: onChange })
);

// Every parameter ProfileSettings takes, read off its own signature, each with
// a neutral value, as usageAnalyticsSwitch.test.js does.
const PARAMS = (() => {
  const start = PROFILE_SRC.indexOf('export default function ProfileSettings({');
  const block = PROFILE_SRC.slice(start, PROFILE_SRC.indexOf('}) {', start));
  return [...block.matchAll(/^\s+([A-Za-z_]\w*),/gm)].map((m) => m[1]);
})();
const COMPONENTS = new Set(['DialogBehavior', 'ListSkeleton', 'SearchInputLocal', 'BottomNav', 'SafetyButton']);
const ARRAYS = new Set(['blockedUsers', 'flocks', 'pendingRequests', 'trustedContacts', 'userInterests', 'suggestedInterests']);
function youTab({ entitlements, isPro = false }) {
  const out = {};
  for (const name of PARAMS) {
    if (COMPONENTS.has(name)) out[name] = () => null;
    else if (ARRAYS.has(name)) out[name] = [];
    else if (name === 'showToast' || /^(set|handle|load|on[A-Z]|toggle|switch|confirm|open|needs|session|answer)/.test(name)) out[name] = jest.fn();
    else out[name] = undefined;
  }
  const props = {
    ...out,
    Toggle,
    colors: { navy: '#16283d', redText: '#b91c1c' },
    styles: { card: {}, input: {}, gradientButton: {} },
    entitlements,
    entitlementsUnknown: typeof entitlements?.isPremium !== 'boolean',
    isPro,
    PROFILE_SUBSCREEN_TITLES: {},
    deleteAlertRef: React.createRef(),
    newContact: {},
    profileScreen: 'main',
    authUser: { id: 42, name: 'Ren' },
    sessionEndCopy: (reason) => `ended: ${reason}`,
    needsEmailVerification: () => false,
  };
  return { props, ...render(React.createElement(ProfileSettings, props)) };
}

const FLAG_BEFORE = process.env.REACT_APP_PURCHASES;
beforeEach(() => {
  process.env.REACT_APP_PURCHASES = 'iap';
  // Inside the iPhone app.
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
  api.getProStatus.mockResolvedValue({ isPremium: true, hasWebSubscription: false, canManageWeb: false });
  api.knownAnalyticsChoice.mockReturnValue(null);
  api.getAnalyticsChoice.mockResolvedValue({ optOut: false });
  api.getPrivacySettings.mockResolvedValue({});
});
afterEach(() => {
  if (FLAG_BEFORE === undefined) delete process.env.REACT_APP_PURCHASES;
  else process.env.REACT_APP_PURCHASES = FLAG_BEFORE;
  delete window.Capacitor;
});

const proRow = () => screen.queryByRole('button', { name: /^Flock Pro/ });
const alertsProButton = () => screen.queryByRole('button', { name: 'Crowd alerts come with Flock Pro' });
const alertsSwitch = () => screen.queryByRole('switch', { name: 'Crowd alerts' });

describe('the You tab in the App Store build, with PAYWALL_ENABLED off', () => {
  test('an ordinary account sees no Flock Pro row and no Pro button: crowd alerts is a plain switch', async () => {
    const { container } = youTab({ entitlements: PAYWALL_OFF });
    await act(async () => {});
    expect(proRow()).toBeNull();
    expect(alertsProButton()).toBeNull();
    expect(alertsSwitch()).toBeTruthy();
    expect(container.textContent).not.toMatch(/Flock Pro|Restore purchases|\$\s?\d/);
    expect(api.getProStatus).not.toHaveBeenCalled();
  });

  test('before the entitlements arrive, or after a failed read, the same: nothing about Pro', async () => {
    for (const entitlements of [null, undefined, { error: 'Server error' }]) {
      const { container, unmount } = youTab({ entitlements });
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {});
      expect(proRow()).toBeNull();
      expect(alertsProButton()).toBeNull();
      expect(container.textContent).not.toMatch(/Flock Pro/);
      unmount();
    }
  });

  test('the account on PAYWALL_PREVIEW_USER_IDS sees the row, and it opens the App Store sheet', async () => {
    const { props, container } = youTab({ entitlements: PREVIEW_ACCOUNT });
    await act(async () => {});
    const row = proRow();
    expect(row).toBeTruthy();
    expect(container.querySelector('a[href="/pro"]')).toBeNull();
    row.click();
    await waitFor(() => expect(props.setPaywallTrigger).toHaveBeenCalledWith('settings'));
    // Crowd alerts are Pro's for that account, and say so with the same sheet.
    expect(alertsSwitch()).toBeNull();
    alertsProButton().click();
    expect(props.setPaywallTrigger).toHaveBeenLastCalledWith('settings');
  });

  test('an account that already has Pro is told so, paywall or not, with nothing to buy', async () => {
    youTab({ entitlements: { ...PAYWALL_OFF, isPremium: true }, isPro: true });
    expect(await screen.findByText('Flock Pro is on')).toBeTruthy();
    // Its subscription came through Apple (the status read says no web one),
    // so Manage opens Apple's own screen.
    expect(await screen.findByRole('button', { name: 'Manage' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Get Pro|Subscribe|Cancel subscription/ })).toBeNull();
  });
});

describe('every other way into the Pro sheet waits for the same answer', () => {
  test("Birdie's spent day, on the Nest and in the panel, needs the paywall on for this account", () => {
    expect(APP_SRC).toContain('const outOfChirps = !!entitlements?.paywallEnabled && !isPro && aiRemaining === 0');
    expect(read('components', 'nest', 'NestBirdieSection.js')).toMatch(/\{outOfChirps && \(/);
    expect(read('components', 'birdie', 'BirdiePanel.js')).toMatch(/\{outOfChirps \? \(/);
  });

  test("Birdie's limit and a locked forecast come only from a server that meters this account", () => {
    // The sheet opens on the 429 (App.js), which the server sends only past
    // the free daily limit, a limit it applies only when the paywall is on
    // for this account.
    expect(APP_SRC).toContain("if (err?.code === 'UPGRADE_REQUIRED') {");
    const ai = readRepo('backend', 'routes', 'ai.js');
    expect(ai).toContain('if (paywallEnabled(userId)) {');
    // The venue card's offers all hang off forecastAccess.locked, which the
    // server sets only for a metered account.
    const crowd = readRepo('backend', 'routes', 'crowd.js');
    expect(crowd).toContain('if (!paywallEnabled(userId)) return UNMETERED_ACCESS;');
    const card = read('components', 'venue', 'ConsumerVenueCard.js');
    const offers = card.split("setPaywallTrigger('forecast'").length - 1;
    const behindLock = card.split('forecastAccess?.locked').length - 1;
    expect(offers).toBe(5);
    expect(behindLock).toBeGreaterThanOrEqual(offers);
  });

  test('the per-account answer is what the server reads, PAYWALL_PREVIEW_USER_IDS included', () => {
    const entitlements = readRepo('backend', 'services', 'entitlements.js');
    expect(entitlements).toContain("const on = boolFlag('PAYWALL_ENABLED') || (userId != null && previewUserIds().has(String(userId)));");
    // And the You tab's App Store row returns nothing without it.
    const row = PROFILE_SRC.slice(PROFILE_SRC.indexOf('function ProRowInner('));
    expect(row).toContain('    if (!entitlements?.paywallEnabled) return null;\n');
  });
});
