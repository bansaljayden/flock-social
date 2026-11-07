/**
 * THE BOTTOM OF THE YOU SCREEN IS GROUPED LIKE THE TOP (2026-11-06).
 *
 * A tester's You screen ended in four unlabelled rows (Sign out everywhere,
 * Sign out, Get a copy of my data, Delete account) that read as part of
 * Device above them, then a centred uppercase "LEGAL" eyebrow unlike every
 * other label on the screen, with Support filed under it as if it were a
 * legal document. The four rows are labelled "Sign out and your data",
 * Support is its own row under "Help", and "Legal" is a group label like
 * Account, Safety and privacy, and Device, over Terms of service, Privacy
 * policy and Community guidelines in sentence case.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=youScreenBottomGroups
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

const follows = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const label = (text) => screen.getByRole('heading', { name: text });

test('every group at the bottom has a label drawn like the ones above it', () => {
  render(React.createElement(ProfileSettings, props()));
  const device = label('Device');
  const signOut = label('Sign out and your data');
  const help = label('Help');
  const legal = label('Legal');
  for (const h of [signOut, help, legal]) {
    expect(h.tagName).toBe(device.tagName);
    expect(h.style.fontSize).toBe(device.style.fontSize);
    expect(h.style.fontWeight).toBe(device.style.fontWeight);
    expect(h.style.color).toBe(device.style.color);
    expect(h.style.textTransform).toBe('');
    expect(h.style.textAlign).toBe('');
  }
  // In order: Device, then the sign-out group, then Help, then Legal.
  expect(follows(device, signOut)).toBe(true);
  expect(follows(signOut, screen.getByText('Sign out everywhere'))).toBe(true);
  expect(follows(screen.getByText('Delete account'), help)).toBe(true);
  expect(follows(help, legal)).toBe(true);
});

test('Support is its own row under Help, not a pill under Legal', () => {
  render(React.createElement(ProfileSettings, props()));
  const support = screen.getByRole('button', { name: /Support/ });
  expect(follows(label('Help'), support)).toBe(true);
  expect(follows(support, label('Legal'))).toBe(true);
  for (const doc of ['Terms of service', 'Privacy policy', 'Community guidelines']) {
    expect(follows(label('Legal'), screen.getByRole('button', { name: doc }))).toBe(true);
  }
  expect(screen.queryByText('Terms of Service')).toBeNull();
});
