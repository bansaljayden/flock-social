/**
 * "SHARE USAGE ANALYTICS", THE SWITCH IN THE YOU TAB.
 *
 * The app asks no analytics question on screen, so this switch is the one
 * place a person turns signed-in analytics off, and the privacy policy sends
 * them here by this name. The real ProfileSettings is rendered, with a Toggle
 * built exactly like App.js's (pinned below), and driven through:
 *
 *   - it sits in the Safety and privacy card, with its one line under it
 *   - it shows the account's answer, from what the page already knew and then
 *     from a fresh read
 *   - off calls the endpoint with optOut true, on with optOut false, and the
 *     switch lands where the server's answer lands
 *   - a tap before anything is known, or while one is in flight, does nothing
 *   - a refused off says so under the switch, and the switch stays where the
 *     account still is
 *
 * services/api.js's side of the same switch (PostHog stopped at the tap and
 * started again) is in accountAnalytics.test.js.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false usageAnalyticsSwitch
 */
const React = require('react');
const fs = require('fs');
const path = require('path');
const { render, screen, fireEvent, waitFor, act } = require('@testing-library/react');

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
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const PROFILE_SRC = read('screens', 'ProfileSettings.js');
const APP_SRC = read('App.js');

const LINE = 'Which screens you open and a few actions, tied to your account number. No ads, no selling.';

// App.js's Toggle, the one every switch on this screen is drawn with. Copied
// rather than imported (App.js does not export it); the first test pins the
// original so the copy cannot drift from it.
const Toggle = ({ on, onChange, label }) => (
  React.createElement('button', { className: 'hit44', role: 'switch', 'aria-checked': !!on, 'aria-label': label, onClick: onChange })
);

// Every parameter ProfileSettings takes, read off its own signature, each with
// a neutral value, as accountReconfirmInPlace.test.js does.
const PARAMS = (() => {
  const start = PROFILE_SRC.indexOf('export default function ProfileSettings({');
  const block = PROFILE_SRC.slice(start, PROFILE_SRC.indexOf('}) {', start));
  return [...block.matchAll(/^\s+([A-Za-z_]\w*),/gm)].map((m) => m[1]);
})();
const COMPONENTS = new Set(['DialogBehavior', 'ListSkeleton', 'SearchInputLocal', 'BottomNav', 'SafetyButton']);
const ARRAYS = new Set(['blockedUsers', 'flocks', 'pendingRequests', 'trustedContacts', 'userInterests', 'suggestedInterests']);
function props() {
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
  };
}

const theSwitch = () => screen.getByRole('switch', { name: 'Share usage analytics' });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  process.env.REACT_APP_PURCHASES = 'off'; // no Pro row, nothing else fetching
  api.getProStatus.mockResolvedValue({});
  api.knownAnalyticsChoice.mockReturnValue(null);
  api.getAnalyticsChoice.mockResolvedValue({ optOut: false });
});

afterEach(() => {
  delete process.env.REACT_APP_PURCHASES;
});

test('the Toggle here is App.js\'s Toggle', () => {
  expect(APP_SRC).toContain('const Toggle = ({ on, onChange, label }) => (');
  expect(APP_SRC).toContain('<button className="hit44" role="switch" aria-checked={!!on} aria-label={label} onClick={onChange}');
});

test('it sits in the Safety and privacy card, with its one line under it', async () => {
  render(React.createElement(ProfileSettings, props()));
  await waitFor(() => expect(theSwitch().getAttribute('aria-checked')).toBe('true'));

  const heading = screen.getByText('Safety and privacy');
  const card = heading.nextElementSibling;
  expect(card.contains(theSwitch())).toBe(true);
  expect(screen.getByText('Share usage analytics')).toBeTruthy();
  expect(screen.getByText(LINE)).toBeTruthy();
  expect(card.contains(screen.getByText(LINE))).toBe(true);
});

test('it is drawn from what the page already knew, then from a fresh read', async () => {
  api.knownAnalyticsChoice.mockReturnValue({ optOut: true });
  const read = deferred();
  api.getAnalyticsChoice.mockReturnValue(read.promise);
  render(React.createElement(ProfileSettings, props()));

  expect(theSwitch().getAttribute('aria-checked')).toBe('false');
  expect(api.getAnalyticsChoice).toHaveBeenCalledTimes(1);

  // Switched back on from another device since this page last read it.
  await act(async () => { read.resolve({ optOut: false }); });
  expect(theSwitch().getAttribute('aria-checked')).toBe('true');
});

test('off calls the endpoint with optOut true, on with optOut false, and the switch follows the server', async () => {
  render(React.createElement(ProfileSettings, props()));
  await waitFor(() => expect(theSwitch().getAttribute('aria-checked')).toBe('true'));

  api.setAnalyticsChoice.mockResolvedValue({ optOut: true });
  await act(async () => { fireEvent.click(theSwitch()); });
  expect(api.setAnalyticsChoice).toHaveBeenLastCalledWith(true);
  expect(theSwitch().getAttribute('aria-checked')).toBe('false');

  api.setAnalyticsChoice.mockResolvedValue({ optOut: false });
  await act(async () => { fireEvent.click(theSwitch()); });
  expect(api.setAnalyticsChoice).toHaveBeenLastCalledWith(false);
  expect(theSwitch().getAttribute('aria-checked')).toBe('true');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a tap does nothing before anything is known, or while a change is in flight', async () => {
  const read = deferred();
  api.getAnalyticsChoice.mockReturnValue(read.promise);
  render(React.createElement(ProfileSettings, props()));

  await act(async () => { fireEvent.click(theSwitch()); });
  expect(api.setAnalyticsChoice).not.toHaveBeenCalled();

  await act(async () => { read.resolve({ optOut: false }); });
  const put = deferred();
  api.setAnalyticsChoice.mockReturnValue(put.promise);
  await act(async () => { fireEvent.click(theSwitch()); });
  await act(async () => { fireEvent.click(theSwitch()); });
  expect(api.setAnalyticsChoice).toHaveBeenCalledTimes(1);
  await act(async () => { put.resolve({ optOut: true }); });
  expect(theSwitch().getAttribute('aria-checked')).toBe('false');
});

test('a refused off says so, and the switch stays where the account still is', async () => {
  render(React.createElement(ProfileSettings, props()));
  await waitFor(() => expect(theSwitch().getAttribute('aria-checked')).toBe('true'));

  api.setAnalyticsChoice.mockRejectedValue(Object.assign(new Error('Failed to update the analytics setting'), { status: 500 }));
  await act(async () => { fireEvent.click(theSwitch()); });

  expect(theSwitch().getAttribute('aria-checked')).toBe('true');
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toBe('That did not save to your account. Nothing more is sent until you next open Flock, so try again to keep it off.');
});

test('a session that ended mid-change shows no error of its own', async () => {
  render(React.createElement(ProfileSettings, props()));
  await waitFor(() => expect(theSwitch().getAttribute('aria-checked')).toBe('true'));

  api.setAnalyticsChoice.mockRejectedValue(Object.assign(new Error('Session expired'), { status: 401, sessionExpired: true }));
  await act(async () => { fireEvent.click(theSwitch()); });

  expect(screen.queryByRole('alert')).toBeNull();
});

test('the privacy policy sends people to this switch by its name, where it is', () => {
  const policy = read('website', 'PrivacyPolicy.js');
  expect(policy).toContain('You &rarr; Share usage analytics');
  // The switch is on the You tab's main screen, not behind a Settings screen
  // that does not exist.
  expect(policy).not.toMatch(/Settings &rarr; Share usage analytics/);
  expect(PROFILE_SRC).toContain(`const USAGE_ANALYTICS_LINE = '${LINE}';`);
  expect(PROFILE_SRC).toContain('<Toggle label="Share usage analytics"');
});
