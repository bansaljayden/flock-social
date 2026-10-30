/**
 * THE YOU TAB SAYS WHERE NOTIFICATIONS GO OFF, AND SIGN OUT EVERYWHERE ANSWERS
 * THE TAP.
 *
 *   - Push Notifications read "On" once allowed and nothing more, and the app
 *     has no switch of its own for the permission, so there was no way off
 *     from here. The row now says where to turn them off, in the words the
 *     denied note uses to say where to turn them back on.
 *   - "Sign out everywhere" sat still while the server was asked and took a
 *     second tap. It says it is signing out from the tap, and one tap is one
 *     request.
 *
 * The analytics switch that moves on the tap is in usageAnalyticsSwitch.test.js
 * and the Pro row's cancel in purchaseSurfacesTruth.test.js. The real
 * ProfileSettings is rendered with a props object read off its own signature,
 * the way usageAnalyticsSwitch.test.js builds it.
 */
const React = require('react');
const fs = require('fs');
const path = require('path');
const { render, screen, fireEvent, act } = require('@testing-library/react');

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

const PROFILE_SRC = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ProfileSettings.js'), 'utf8').replace(/\r\n/g, '\n');

const Toggle = ({ on, onChange, label }) => (
  React.createElement('button', { className: 'hit44', role: 'switch', 'aria-checked': !!on, 'aria-label': label, onClick: onChange })
);

const PARAMS = (() => {
  const start = PROFILE_SRC.indexOf('export default function ProfileSettings({');
  const block = PROFILE_SRC.slice(start, PROFILE_SRC.indexOf('}) {', start));
  return [...block.matchAll(/^\s+([A-Za-z_]\w*),/gm)].map((m) => m[1]);
})();
const COMPONENTS = new Set(['DialogBehavior', 'ListSkeleton', 'SearchInputLocal', 'BottomNav', 'SafetyButton']);
const ARRAYS = new Set(['blockedUsers', 'flocks', 'pendingRequests', 'trustedContacts', 'userInterests', 'suggestedInterests']);
function props(over = {}) {
  const out = {};
  for (const name of PARAMS) {
    if (COMPONENTS.has(name)) out[name] = () => null;
    else if (ARRAYS.has(name)) out[name] = [];
    else if (name === 'showToast' || /^(set|handle|load|on[A-Z]|toggle|switch|confirm|open|needs|session|answer)/.test(name)) out[name] = jest.fn();
    else out[name] = undefined;
  }
  return {
    ...out,
    Toggle,
    colors: { navy: '#16283d', redText: '#b91c1c' },
    styles: { card: {}, input: {}, gradientButton: {} },
    entitlements: {},
    PROFILE_SUBSCREEN_TITLES: {},
    deleteAlertRef: React.createRef(),
    newContact: {},
    profileScreen: 'main',
    authUser: { id: 42, name: 'Ren' },
    sessionEndCopy: (reason) => `ended: ${reason}`,
    needsEmailVerification: () => false,
    ...over,
  };
}

// react-scripts resets every mock between tests, so the answers go in here.
beforeEach(() => {
  process.env.REACT_APP_PURCHASES = 'off'; // no Pro row, nothing else fetching
  api.getProStatus.mockResolvedValue({});
  api.knownAnalyticsChoice.mockReturnValue(null);
  api.getAnalyticsChoice.mockResolvedValue({ optOut: false });
  api.currentAccount.mockReturnValue('42');
});
afterEach(() => {
  delete process.env.REACT_APP_PURCHASES;
  delete window.Capacitor;
});

describe('push notifications that are on', () => {
  test('inside the app the row says to turn them off in the Settings app', async () => {
    window.Capacitor = { isNativePlatform: () => true };
    render(React.createElement(ProfileSettings, props({ notifStatus: 'granted' })));
    await act(async () => {});
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.getByText('Turn them off in the Settings app, under Notifications and then Flock.')).toBeTruthy();
  });

  test('on the web it says where the browser keeps it', async () => {
    render(React.createElement(ProfileSettings, props({ notifStatus: 'granted' })));
    await act(async () => {});
    expect(screen.getByText('Turn them off in your browser, under site settings for this page.')).toBeTruthy();
  });

  test('a row that is not on yet says nothing about turning them off', async () => {
    render(React.createElement(ProfileSettings, props({ notifStatus: 'default' })));
    await act(async () => {});
    expect(screen.queryByText(/Turn them off/)).toBeNull();
  });
});

describe('Sign out everywhere', () => {
  test('says it is signing out from the tap, and one tap is one request', async () => {
    let answer;
    api.logoutAll.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const p = props();
    render(React.createElement(ProfileSettings, p));
    await act(async () => {});
    const button = screen.getByRole('button', { name: 'Sign out everywhere' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.logoutAll).toHaveBeenCalledTimes(1);
    expect(api.logoutAll).toHaveBeenCalledWith({ account: '42' });
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Signing out…');
    await act(async () => { answer({}); });
    expect(p.onLogout).toHaveBeenCalledWith('ended: signed_out_everywhere');
  });

  test('a failed server call still signs this phone out, and says it was this phone only', async () => {
    api.logoutAll.mockRejectedValue(new Error('offline'));
    const p = props();
    render(React.createElement(ProfileSettings, p));
    await act(async () => {});
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' })); });
    expect(p.onLogout).toHaveBeenCalledWith('ended: signed_out_here_only');
  });
});
