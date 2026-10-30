/**
 * THE YOU TAB'S NUMBERS AND THE TRUSTED CONTACTS WAIT IN THEIR OWN SHAPES.
 *
 * The four stat tiles printed flocks.length, a confident 0, while the flock
 * list loaded, and the other three printed the failure dash before their read
 * had answered: nothing told "not read yet" from "the read failed". The flag
 * App.js now keeps for the stats read (userStatsLoaded) and the list's own
 * loading flag draw a 28x20 bar in each tile until its read lands, and a read
 * that failed still shows the dash. The trusted contacts list said
 * "Loading..."; it draws two of its own rows.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false skeletonYouTab
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
    profileHandle: 'jay',
    sessionEndCopy: (reason) => `ended: ${reason}`,
    needsEmailVerification: () => false,
    flocksError: '',
    ...over,
  };
}

/** The four tiles, by their label. */
const tile = (label) => screen.getByText(label, { selector: 'p' }).parentElement;

describe('the stat tiles', () => {
  test('the parameter list was read, and carries both loading flags', () => {
    expect(PARAMS).toContain('userStatsLoaded');
    expect(PARAMS).toContain('flocksLoading');
  });

  test('before either read answers: a 28x20 bar in every tile, and no 0 and no dash', () => {
    render(React.createElement(ProfileSettings, props({ flocksLoading: true, userStatsLoaded: false, friendCount: null, streak: null, reliabilityScore: null })));
    for (const label of ['Flocks', 'Friends', 'Streak', 'Reliable']) {
      const t = tile(label);
      const bar = t.querySelector('.skeleton');
      expect(bar).not.toBeNull();
      expect(bar.style.width).toBe('28px');
      expect(bar.style.height).toBe('20px');
      expect(within(t).getByText('Loading')).toBeTruthy();
      expect(t.textContent).not.toMatch(/\b0\b|–/);
    }
  });

  test('a stats read that failed keeps its dash, and a list that failed keeps its dash', () => {
    render(React.createElement(ProfileSettings, props({ flocksLoading: false, flocksError: 'The list did not load.', userStatsLoaded: true, friendCount: null, streak: null, reliabilityScore: null })));
    for (const label of ['Flocks', 'Friends', 'Streak', 'Reliable']) {
      const t = tile(label);
      expect(t.querySelector('.skeleton')).toBeNull();
      expect(t.textContent).toBe(`–${label}`);
    }
  });

  test('reads that landed print their numbers', () => {
    render(React.createElement(ProfileSettings, props({ flocks: [{ id: 1 }, { id: 2 }], flocksLoading: false, userStatsLoaded: true, friendCount: 4, streak: 3, reliabilityScore: 87.4 })));
    expect(tile('Flocks').textContent).toBe('2Flocks');
    expect(tile('Friends').textContent).toBe('4Friends');
    expect(tile('Streak').textContent).toBe('3Streak');
    expect(tile('Reliable').textContent).toBe('87%Reliable');
  });

  test('a refresh of a list already on screen keeps its number', () => {
    render(React.createElement(ProfileSettings, props({ flocks: [{ id: 1 }], flocksLoading: true, userStatsLoaded: true, friendCount: 1, streak: 0, reliabilityScore: null })));
    expect(tile('Flocks').textContent).toBe('1Flocks');
  });

  test('App.js keeps the flag and hands both flags over', () => {
    expect(APP_SRC).toContain('const [userStatsLoaded, setUserStatsLoaded] = useState(false);');
    expect(APP_SRC).toMatch(/setReliabilityScore\(readReliability\(d\.reliabilityScore\)\);\s*\}\)\.catch\(\(\) => \{\}\)\.finally\(\(\) => setUserStatsLoaded\(true\)\);/);
    const bag = APP_SRC.slice(APP_SRC.indexOf('const profileSettingsProps = {'), APP_SRC.indexOf('<ProfileSettings {...profileSettingsProps} />'));
    expect(bag).toMatch(/^\s+flocksLoading,$/m);
    expect(bag).toMatch(/^\s+userStatsLoaded,$/m);
  });
});

describe('the trusted contacts', () => {
  test('while the list loads: two of its rows, the 40px initial and the lines, ruled like the list, no "Loading..."', () => {
    const { container } = render(React.createElement(ProfileSettings, props({ profileScreen: 'safety', safetyLoading: true, trustedContacts: [], trustedContactsLoaded: false })));
    expect(screen.getByText('Loading your trusted contacts')).toBeTruthy();
    const initials = Array.from(container.querySelectorAll('.skeleton')).filter((b) => b.style.width === '40px' && b.style.borderRadius === '50%');
    expect(initials).toHaveLength(2);
    // Bare rows: no card around each, the list's own padding.
    initials.forEach((b) => expect(b.parentElement.style.padding).toBe('10px 0px'));
    expect(container.textContent).not.toMatch(/Loading\.\.\./);
    expect(screen.queryByText('No trusted contacts yet')).toBeNull();
  });

  test('a list that landed empty says so, with no skeleton', () => {
    const { container } = render(React.createElement(ProfileSettings, props({ profileScreen: 'safety', safetyLoading: false, trustedContacts: [], trustedContactsLoaded: true })));
    expect(screen.getByText('No trusted contacts yet')).toBeTruthy();
    expect(container.querySelectorAll('.skeleton')).toHaveLength(0);
  });
});
