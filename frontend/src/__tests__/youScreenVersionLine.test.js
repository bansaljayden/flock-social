/**
 * THE VERSION LINE SAYS WHICH BUILD THIS IS (2026-11-06).
 *
 * The foot of the You screen read the literal "Flock v1.0.0" in the App
 * Store's 1.0, its 1.0.1 and the website alike, so a tester's screenshot said
 * nothing about which build they had. On the iPhone the line now reads the
 * version and build from iOS (@capacitor/app App.getInfo, a plugin the app
 * already ships, no new native dependency): "Flock 1.0.1 (50)". On the web it
 * names the short commit the build came from, which scripts/build.js puts in
 * as REACT_APP_BUILD_ID, or the build date when there is no commit to read.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=youScreenVersionLine
 */
const { waitFor } = require('@testing-library/react');
const { versionLine, readVersionLine } = require('../lib/appVersion');
const { buildIdDefaults } = require('../../scripts/build');
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

describe('the words', () => {
  test('the iPhone app: version and build, "Flock 1.0.1 (50)"', () => {
    expect(versionLine({ native: true, version: '1.0.1', build: '50' })).toBe('Flock 1.0.1 (50)');
    expect(versionLine({ native: true, version: '1.0.1' })).toBe('Flock 1.0.1');
  });
  test('the web: the build it came from', () => {
    expect(versionLine({ buildId: '9f57f48' })).toBe('Flock for web · 9f57f48');
    expect(versionLine({})).toBe('Flock for web');
  });
  test('iOS is asked through @capacitor/app, and a failed ask says only "Flock"', async () => {
    const loadApp = () => Promise.resolve({ App: { getInfo: () => Promise.resolve({ version: '1.0.1', build: '50', name: 'Flock', id: 'x' }) } });
    await expect(readVersionLine({ native: true, loadApp })).resolves.toBe('Flock 1.0.1 (50)');
    await expect(readVersionLine({ native: true, loadApp: () => Promise.reject(new Error('no plugin')) })).resolves.toBe('Flock');
  });
});

describe('the build stamps the web bundle', () => {
  const NOW = new Date('2026-11-06T22:00:00Z');
  test('the host\'s commit, then git, then the date; one already set wins', () => {
    expect(buildIdDefaults({ CF_PAGES_COMMIT_SHA: '9F57F48ABCDEF0123' }, 'aaaaaaa', NOW)).toEqual({ REACT_APP_BUILD_ID: '9f57f48' });
    expect(buildIdDefaults({}, 'e59e63d', NOW)).toEqual({ REACT_APP_BUILD_ID: 'e59e63d' });
    expect(buildIdDefaults({}, null, NOW)).toEqual({ REACT_APP_BUILD_ID: '2026-11-06' });
    expect(buildIdDefaults({ REACT_APP_BUILD_ID: 'mine' }, 'e59e63d', NOW)).toEqual({});
  });
});

describe('the screen', () => {
  test('no hard-coded version anywhere on it, and the line is the read', async () => {
    expect(PROFILE_SRC).not.toMatch(/>Flock v1\.0\.0</);
    render(React.createElement(ProfileSettings, props()));
    const line = document.querySelector('[data-version-line]');
    expect(line).not.toBeNull();
    // jsdom is not the iPhone app: the web line.
    await waitFor(() => expect(line.textContent).toMatch(/^Flock for web/));
  });
  test('no new native dependency: @capacitor/app is already in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    expect(pkg.dependencies['@capacitor/app']).toBeTruthy();
  });
});
