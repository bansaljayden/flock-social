/**
 * A NEW ACCOUNT'S YOU SCREEN IS NOT A TALLY OF NOTHING (2026-11-06).
 *
 * A tester's new account read "0 Flocks, 0 Friends, 0 Streak" with a lit
 * flame beside the zero, and a dash for Reliable. The flame is lit only for a
 * streak above zero, and when every read has landed and every number is zero
 * or not there yet the four tiles give way to one line, the rule the Nest's
 * stat line keeps. A read still out keeps its bar and a failed read its dash.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=youScreenEmptyStats
 */
const React = require('react');
const fs = require('fs');
const path = require('path');
const { render, screen, within } = require('@testing-library/react');

// Plain functions, not jest.fn: the suite resets mock implementations before
// each test, which would leave the reads the screen makes on mount answering
// undefined.
jest.mock('../services/api', () => ({
  deleteAccount: () => Promise.resolve(),
  trackNotificationPermission: () => {},
  updatePaymentMethods: () => Promise.resolve(),
  logoutAll: () => Promise.resolve(),
  getCurrentUser: () => Promise.resolve({}),
  clearLocalSession: () => {},
  getProStatus: () => Promise.resolve({}),
  openProPortal: () => Promise.resolve(),
  cancelProSubscription: () => Promise.resolve(),
  resumeProSubscription: () => Promise.resolve(),
  appleLogin: () => Promise.resolve(),
  googleLogin: () => Promise.resolve(),
  googleLoginWithToken: () => Promise.resolve(),
  getAnalyticsChoice: () => Promise.resolve({ optOut: false }),
  setAnalyticsChoice: () => Promise.resolve(),
  knownAnalyticsChoice: () => null,
  currentAccount: () => null,
}));
jest.mock('../services/firebase', () => ({
  getNotificationStatus: () => 'granted',
  requestNotificationPermission: () => Promise.resolve(),
}));
jest.mock('@react-oauth/google', () => ({
  useGoogleLogin: () => () => {},
  GoogleOAuthProvider: ({ children }) => children,
}));
jest.mock('@capacitor-community/apple-sign-in', () => ({
  SignInWithApple: { authorize: () => Promise.resolve({}) },
}));

const ProfileSettings = require('../screens/ProfileSettings').default;

const PROFILE_SRC = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ProfileSettings.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

// Every parameter the screen takes, read off its signature, each with a
// neutral value of the kind its name says (accountReconfirmInPlace.test.js
// builds its harness the same way).
const PARAMS = (() => {
  const start = PROFILE_SRC.indexOf('export default function ProfileSettings({');
  const block = PROFILE_SRC.slice(start, PROFILE_SRC.indexOf('}) {', start));
  return [...block.matchAll(/^\s+([A-Za-z_]\w*),/gm)].map((m) => m[1]);
})();
const COMPONENTS = new Set(['DialogBehavior', 'ListSkeleton', 'SearchInputLocal', 'Toggle', 'BottomNav', 'SafetyButton']);
const ARRAYS = new Set(['blockedUsers', 'flocks', 'pendingRequests', 'trustedContacts', 'userInterests', 'suggestedInterests']);
function props(over = {}) {
  const p = {};
  for (const name of PARAMS) {
    if (COMPONENTS.has(name)) p[name] = () => null;
    else if (ARRAYS.has(name)) p[name] = [];
    else if (name === 'showToast' || /^(set|handle|load|on[A-Z]|toggle|switch|confirm|open|needs|session|answer)/.test(name)) p[name] = jest.fn();
    else p[name] = undefined;
  }
  return {
    ...p,
    authUser: { id: 42, name: 'Jay' },
    colors: {},
    styles: { card: {}, input: {}, gradientButton: {} },
    entitlements: {},
    PROFILE_SUBSCREEN_TITLES: {},
    deleteAlertRef: React.createRef(),
    newContact: {},
    profileScreen: 'main',
    profileName: 'Jay',
    sessionEndCopy: (reason) => `ended: ${reason}`,
    needsEmailVerification: () => false,
    flocksError: '',
    ...over,
  };
}

/** The four tiles, by their label. */
const tile = (label) => screen.getByText(label, { selector: 'p' }).parentElement;

const landed = { flocks: [], flocksLoading: false, flocksError: '', userStatsLoaded: true };

test('a brand-new account: one line, no tiles, no flame', () => {
  const { container } = render(React.createElement(ProfileSettings, props({ ...landed, friendCount: 0, streak: 0, reliabilityScore: null })));
  expect(container.querySelector('[data-stats-empty]').textContent).toBe('Start a flock to get your streak going.');
  for (const label of ['Flocks', 'Friends', 'Streak', 'Reliable']) expect(screen.queryByText(label, { selector: 'p' })).toBeNull();
});

test('a zero streak among real numbers: the tiles, and no flame on the zero', () => {
  render(React.createElement(ProfileSettings, props({ ...landed, flocks: [{ id: 1 }], friendCount: 2, streak: 0, reliabilityScore: null })));
  expect(tile('Streak').textContent).toBe('0Streak');
  expect(tile('Streak').querySelector('svg')).toBeNull();
});

test('a streak above zero lights the flame', () => {
  render(React.createElement(ProfileSettings, props({ ...landed, flocks: [{ id: 1 }], friendCount: 2, streak: 3, reliabilityScore: 90 })));
  expect(tile('Streak').querySelector('svg')).not.toBeNull();
});

test('reads still out, or a read that failed, keep the tiles', () => {
  const { unmount } = render(React.createElement(ProfileSettings, props({ ...landed, userStatsLoaded: false, friendCount: null, streak: null })));
  expect(document.querySelector('[data-stats-empty]')).toBeNull();
  expect(tile('Friends')).toBeTruthy();
  unmount();
  // Stats read landed but failed: friendCount null, not 0.
  render(React.createElement(ProfileSettings, props({ ...landed, friendCount: null, streak: null, reliabilityScore: null })));
  expect(document.querySelector('[data-stats-empty]')).toBeNull();
  expect(tile('Friends').textContent).toBe('–Friends');
});
