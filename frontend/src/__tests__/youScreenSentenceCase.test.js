/**
 * SETTINGS SPEAK IN SENTENCE CASE, AND THE SAFETY ROW SAYS WHAT IT OPENS
 * (2026-11-06).
 *
 * A tester's You screen mixed "Edit Photo", "Edit Profile", "Push
 * Notifications" and "Smart Night Mode" with "Blocked accounts", "Find me by
 * phone" and every other row in sentence case, and a row called "Safety" sat
 * inside the group called "Safety and privacy". Every label on the screen,
 * its subscreens and the profile form is sentence case now (product names
 * such as Cash App, Flock Pro and Quick Add keep their capitals), and the row
 * and its subscreen are "SOS and safety". The support page, and its crawler
 * copy, name the rows by their new words.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=youScreenSentenceCase
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

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');

test('the rows and switches read in sentence case, and the safety row is "SOS and safety"', () => {
  render(React.createElement(ProfileSettings, props({ themeMode: 'manual' })));
  for (const label of ['Edit photo', 'Edit profile', 'SOS and safety', 'Smart night mode', 'Dark mode', 'Push notifications']) {
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  }
  for (const old of ['Edit Photo', 'Edit Profile', 'Smart Night Mode', 'Dark Mode', 'Push Notifications']) {
    expect(screen.queryByText(old)).toBeNull();
  }
  // No row called just "Safety" inside "Safety and privacy".
  expect(screen.queryByText('Safety', { selector: 'span' })).toBeNull();
});

test('the subscreen title matches the row', () => {
  expect(APP_SRC).toMatch(/edit: 'Edit profile',/);
  expect(APP_SRC).toMatch(/safety: 'SOS and safety',/);
});

// Every text node and quoted label in the settings screen and the profile
// form with two or more capitalised words in a row, less product names.
const PRODUCT_NAMES = /Cash App|Flock Pro|Keep Pro|Keeping Pro|Quick Add|Google|Gemini|Apple|App Store|Hanken Grotesk|PostHog|Hide My Email|Sign in with|Flock Social|Flock v/;
const titleCaseLabels = (src) => (src.match(/[>'"][A-Z][a-z]+ [A-Z][a-z]+[^<'"\n]*[<'"]/g) || [])
  .filter((s) => !PRODUCT_NAMES.test(s));

test('no Title Case label is left on the settings screen or the profile form', () => {
  const hits = [...titleCaseLabels(read('screens', 'ProfileSettings.js')), ...titleCaseLabels(read('components', 'EditProfileForm.js'))]
    // Words quoted inside comments that describe the old labels.
    .filter((s) => !/^"/.test(s));
  expect(hits).toEqual([]);
});

test('the support page names the rows by their words', () => {
  const support = read('website', 'SupportPage.js');
  const mirror = fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'marketing-page.js'), 'utf8');
  for (const page of [support, mirror]) {
    expect(page).toMatch(/the You tab, then SOS and safety, then Trusted contacts/);
    expect(page).toMatch(/check that Push notifications says On\./);
    expect(page).not.toMatch(/Push Notifications shows as enabled|then Safety, then Trusted Contacts/);
  }
});
