/**
 * NO @HANDLE NOBODY CHOSE (2026-11-06).
 *
 * The You screen printed "@" and the local part of the account's email under
 * the name. Nobody ever chose it: there is no username column, and the old
 * Username field saved nothing. A tester who signed in with Apple's Hide My
 * Email read "@h7h8vgjm2n", the relay mailbox's random name, and everyone
 * else had half their email address on the screen they show friends. The card
 * shows the name alone until people can pick a handle; the handle was drawn
 * nowhere else and searched nowhere.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=youScreenNoHandle
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

test('a Hide My Email account shows its name and no relay mailbox name', () => {
  const { container } = render(React.createElement(ProfileSettings, props({
    authUser: { id: 42, name: 'Sam Rivera', email: 'h7h8vgjm2n@privaterelay.appleid.com' },
    profileName: 'Sam Rivera',
    profileHandle: 'h7h8vgjm2n',
  })));
  expect(screen.getByRole('heading', { name: 'Sam Rivera' })).toBeTruthy();
  expect(container.textContent).not.toMatch(/@h7h8vgjm2n/);
  expect(container.textContent).not.toMatch(/h7h8vgjm2n/);
});

test('an ordinary email is not printed as a handle either', () => {
  const { container } = render(React.createElement(ProfileSettings, props({
    authUser: { id: 42, name: 'Sam Rivera', email: 'sam.rivera@example.com' },
    profileName: 'Sam Rivera',
    profileHandle: 'sam.rivera',
  })));
  expect(container.textContent).not.toMatch(/@sam\.rivera|sam\.rivera/);
});

test('the screen takes no handle and App.js derives none', () => {
  expect(PARAMS).not.toContain('profileHandle');
  expect(APP_SRC).not.toMatch(/profileHandle/);
  expect(APP_SRC).not.toMatch(/authUser\?\.email\?\.split\('@'\)\[0\]/);
});
