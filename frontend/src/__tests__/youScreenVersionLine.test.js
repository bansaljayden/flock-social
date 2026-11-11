/**
 * THE VERSION LINE SAYS WHICH BUILD THIS IS (2026-11-06).
 *
 * The foot of the You screen read the literal "Flock v1.0.0" in the App
 * Store's 1.0, its 1.0.1 and the website alike, so a tester's screenshot said
 * nothing about which build they had. On the iPhone the line now reads the
 * version and build from iOS (@capacitor/app App.getInfo, a plugin the app
 * already ships, no new native dependency): "Flock 1.0.1 (50)". On the web it
 * names the short commit the build came from, which scripts/build.js sets as
 * REACT_APP_BUILD_ID, or the build date when there is no commit to read.
 *
 * THE ID IS ON THE PAGE, NOT IN A SCRIPT (2026-11-11). Compiled into
 * lib/appVersion.js it changed the bytes of the chunk that holds the You
 * screen on every commit, so that chunk and the main bundle (which lists
 * every chunk by name) were renamed on every deploy, and each rename took the
 * old file off the site under any tab still running it. The Cloudflare
 * deploys of 2026-11-10 and 11-11 show it: five in a row renamed exactly
 * those two files. The build now writes the id into index.html's
 * <meta name="flock-build"> and the screen reads it from there.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=youScreenVersionLine
 */
const { waitFor } = require('@testing-library/react');
const { versionLine, readVersionLine, readWebBuildId, initialVersionLine } = require('../lib/appVersion');
const { buildIdDefaults, envReadsIn } = require('../../scripts/build');
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
const APP_VERSION_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'appVersion.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');

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
    await expect(readVersionLine({ native: true, bridge: true, loadApp })).resolves.toBe('Flock 1.0.1 (50)');
    await expect(readVersionLine({ native: true, bridge: true, loadApp: () => Promise.reject(new Error('no plugin')) })).resolves.toBe('Flock');
    // A window.Capacitor with no native bridge under it is not asked.
    const neverLoad = jest.fn(loadApp);
    await expect(readVersionLine({ native: true, bridge: false, loadApp: neverLoad })).resolves.toBe('Flock');
    expect(neverLoad).not.toHaveBeenCalled();
  });
});

describe('the build names itself', () => {
  const NOW = new Date('2026-11-06T22:00:00Z');
  test('the host\'s commit, then git, then the date; one already set wins', () => {
    expect(buildIdDefaults({ CF_PAGES_COMMIT_SHA: '9F57F48ABCDEF0123' }, 'aaaaaaa', NOW)).toEqual({ REACT_APP_BUILD_ID: '9f57f48' });
    expect(buildIdDefaults({}, 'e59e63d', NOW)).toEqual({ REACT_APP_BUILD_ID: 'e59e63d' });
    expect(buildIdDefaults({}, null, NOW)).toEqual({ REACT_APP_BUILD_ID: '2026-11-06' });
    expect(buildIdDefaults({ REACT_APP_BUILD_ID: 'mine' }, 'e59e63d', NOW)).toEqual({});
  });
});

/** Puts the build's tag on the test page, the way the built index.html carries it. */
function stampPage(content) {
  const tag = document.createElement('meta');
  tag.setAttribute('name', 'flock-build');
  if (content !== undefined) tag.setAttribute('content', content);
  document.head.appendChild(tag);
  return tag;
}

describe('the id is on the page, and no script holds it', () => {
  afterEach(() => {
    document.querySelectorAll('meta[name="flock-build"]').forEach((tag) => tag.remove());
  });

  test('no file under src/ reads the variable, so the build leaves it out of every script', () => {
    // scripts/build.js defines for the bundler only what src/ reads
    // (narrowClientEnvironment). A read here would compile the commit into a
    // chunk again and rename it, and the main bundle, on every deploy.
    expect(envReadsIn(path.join(__dirname, '..')).has('REACT_APP_BUILD_ID')).toBe(false);
    expect(APP_VERSION_SRC).not.toMatch(/process\.env/);
  });

  test('index.html carries the tag for the build to fill in, below the policy tag', () => {
    const tags = INDEX_HTML.match(/<meta name="flock-build"[^>]*>/g);
    expect(tags).toEqual(['<meta name="flock-build" content="%REACT_APP_BUILD_ID%" />']);
    // The policy tag stays first after the charset (appOriginCsp.test.js).
    expect(INDEX_HTML.indexOf(tags[0])).toBeGreaterThan(INDEX_HTML.indexOf('http-equiv="Content-Security-Policy"'));
    expect(INDEX_HTML.indexOf(tags[0])).toBeLessThan(INDEX_HTML.indexOf('</head>'));
  });

  test('a commit, a date or a hand-set word is an id', () => {
    for (const id of ['9f57f48', '2026-11-06', 'mine', 'v1.0.3_rc-2']) {
      const tag = stampPage(id);
      expect(readWebBuildId()).toBe(id);
      tag.remove();
    }
    stampPage('  9f57f48  ');
    expect(readWebBuildId()).toBe('9f57f48');
  });

  test('the unfilled placeholder, an empty tag, no tag, or anything else is not', () => {
    expect(readWebBuildId()).toBeNull();
    for (const notAnId of ['%REACT_APP_BUILD_ID%', '', '   ', 'two words', '<b>9f57f48</b>', 'x'.repeat(41), undefined]) {
      const tag = stampPage(notAnId);
      expect(readWebBuildId()).toBeNull();
      tag.remove();
    }
    // Asked with no page at all (a script running outside a browser).
    expect(readWebBuildId(null)).toBeNull();
    expect(readWebBuildId({ querySelector() { throw new Error('no DOM'); } })).toBeNull();
  });

  test('the line is read when it is asked for, not when the file loads', async () => {
    expect(initialVersionLine(false)).toBe('Flock for web');
    await expect(readVersionLine({ native: false })).resolves.toBe('Flock for web');
    stampPage('9f57f48');
    expect(initialVersionLine(false)).toBe('Flock for web · 9f57f48');
    await expect(readVersionLine({ native: false })).resolves.toBe('Flock for web · 9f57f48');
    // The iPhone app never prints the web's id.
    expect(initialVersionLine(true)).toBe('Flock');
  });

  test('the screen prints the id the page carries', async () => {
    stampPage('9f57f48');
    render(React.createElement(ProfileSettings, props()));
    const line = document.querySelector('[data-version-line]');
    await waitFor(() => expect(line.textContent).toBe('Flock for web · 9f57f48'));
  });
});

describe('the screen', () => {
  test('no hard-coded version anywhere on it, and the line is the read', async () => {
    expect(PROFILE_SRC).not.toMatch(/>Flock v1\.0\.0</);
    render(React.createElement(ProfileSettings, props()));
    const line = document.querySelector('[data-version-line]');
    expect(line).not.toBeNull();
    // jsdom is not the iPhone app: the web line. Nothing fills the tag in
    // here, so there is no id after it.
    await waitFor(() => expect(line.textContent).toBe('Flock for web'));
  });
  test('no new native dependency: @capacitor/app is already in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    expect(pkg.dependencies['@capacitor/app']).toBeTruthy();
  });
});
