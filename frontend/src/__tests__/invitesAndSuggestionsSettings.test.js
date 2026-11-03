/**
 * "INVITES AND QUICK ADD", THE TWO SAFETY SWITCHES IN THE YOU TAB.
 *
 * Who can add the account to a flock (everyone, or friends only) and whether
 * Flock suggests it to people who are not its friends. Both live on the
 * account (GET and PUT /api/users/me/privacy) and the server enforces both, so
 * what the switches show must be the server's answer, never a guess. The real
 * ProfileSettings is rendered, with a Toggle built like App.js's, and driven
 * through:
 *
 *   - a row in the Safety and privacy card leads to the page, which App.js
 *     titles "Invites and Quick Add"
 *   - nothing is drawn as a switch until the account's answer is in, and the
 *     answer is drawn as it came (a teen's defaults included)
 *   - each switch sends its one field and lands where the server's answer
 *     lands; it moves on the tap, and a second tap while one is out does
 *     nothing
 *   - a refused write puts the switch back and says so; a failed read says so
 *     with a way to try again
 *   - the words under each switch say what the server does, plainly
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false invitesAndSuggestionsSettings
 */
const React = require('react');
const fs = require('fs');
const path = require('path');
const { render, screen, fireEvent, act, within } = require('@testing-library/react');

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
  getPrivacySettings: jest.fn(),
  setPrivacySettings: jest.fn(),
  // The real one: which sentence a refusal shows is part of the contract.
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
const settingsModule = require('../screens/ProfileSettings');

const ProfileSettings = settingsModule.default;
const {
  INVITES_SWITCH, INVITES_LINE, SUGGESTIONS_SWITCH, SUGGESTIONS_LINE,
} = settingsModule;

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const PROFILE_SRC = read('screens', 'ProfileSettings.js');
const APP_SRC = read('App.js');

// App.js's Toggle, the one every switch on this screen is drawn with, as
// usageAnalyticsSwitch.test.js copies it (and pins the original).
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
function props(overrides = {}) {
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
    colors: { navy: '#16283d', redText: '#b91c1c', creamDark: '#e8dcc4' },
    styles: { card: {}, input: {}, gradientButton: {} },
    entitlements: {},
    PROFILE_SUBSCREEN_TITLES: { invites: 'Invites and Quick Add' },
    deleteAlertRef: React.createRef(),
    newContact: {},
    profileScreen: 'invites',
    authUser: { id: 42, name: 'Ren' },
    sessionEndCopy: (reason) => `ended: ${reason}`,
    needsEmailVerification: () => false,
    ...overrides,
  };
}

const invitesSwitch = () => screen.getByRole('switch', { name: INVITES_SWITCH });
const suggestionsSwitch = () => screen.getByRole('switch', { name: SUGGESTIONS_SWITCH });
const checked = (el) => el.getAttribute('aria-checked');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const TEEN = { invitesFrom: 'friends', showInSuggestions: false };
const OPEN = { invitesFrom: 'everyone', showInSuggestions: true };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.REACT_APP_PURCHASES = 'off'; // no Pro row, nothing else fetching
  api.getProStatus.mockResolvedValue({});
  api.knownAnalyticsChoice.mockReturnValue(null);
  api.getAnalyticsChoice.mockResolvedValue({ optOut: false });
  api.getPrivacySettings.mockResolvedValue(TEEN);
});

afterEach(() => {
  delete process.env.REACT_APP_PURCHASES;
});

test('a row in the Safety and privacy card leads to the page, and App.js titles it', async () => {
  const setProfileScreen = jest.fn();
  render(React.createElement(ProfileSettings, props({ profileScreen: 'main', setProfileScreen })));
  await act(async () => {});
  const card = screen.getByText('Safety and privacy').nextElementSibling;
  const row = within(card).getByRole('button', { name: /Invites and Quick Add/ });
  fireEvent.click(row);
  expect(setProfileScreen).toHaveBeenCalledWith('invites');
  // The main list asks nothing about these settings; the page reads them.
  expect(api.getPrivacySettings).not.toHaveBeenCalled();
  expect(APP_SRC).toContain("invites: 'Invites and Quick Add',");
});

test('nothing is a switch until the answer is in, and then the answer is drawn as it came', async () => {
  const answer = deferred();
  api.getPrivacySettings.mockReturnValue(answer.promise);
  render(React.createElement(ProfileSettings, props()));
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
  expect(screen.getByRole('status').textContent).toBe('Loading your settings');
  // The headings and what each switch does are on screen while it loads.
  expect(screen.getByText(INVITES_LINE)).toBeTruthy();
  expect(screen.getByText(SUGGESTIONS_LINE)).toBeTruthy();

  // A teen's defaults: friends only, and not suggested.
  await act(async () => { answer.resolve(TEEN); });
  expect(checked(invitesSwitch())).toBe('true');
  expect(checked(suggestionsSwitch())).toBe('false');
  expect(screen.queryByRole('status')).toBeNull();
  expect(api.getPrivacySettings).toHaveBeenCalledTimes(1);
});

test('an answer that is not the shape the switches draw is a failed read, not a guess', async () => {
  api.getPrivacySettings.mockResolvedValue({ invitesFrom: 'nobody', showInSuggestions: 'yes' });
  render(React.createElement(ProfileSettings, props()));
  await act(async () => {});
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
  expect(screen.getByRole('alert').textContent).toBe('These settings are not loading right now.');
});

test('each switch sends its one field and lands where the server\'s answer lands', async () => {
  render(React.createElement(ProfileSettings, props()));
  await act(async () => {});
  expect(checked(invitesSwitch())).toBe('true');

  api.setPrivacySettings.mockResolvedValue({ invitesFrom: 'everyone', showInSuggestions: false });
  await act(async () => { fireEvent.click(invitesSwitch()); });
  expect(api.setPrivacySettings).toHaveBeenLastCalledWith({ invitesFrom: 'everyone' });
  expect(checked(invitesSwitch())).toBe('false');
  expect(checked(suggestionsSwitch())).toBe('false');

  api.setPrivacySettings.mockResolvedValue(OPEN);
  await act(async () => { fireEvent.click(suggestionsSwitch()); });
  expect(api.setPrivacySettings).toHaveBeenLastCalledWith({ showInSuggestions: true });
  expect(checked(suggestionsSwitch())).toBe('true');

  // And back: the server's answer, not the tap, is where it lands.
  api.setPrivacySettings.mockResolvedValue({ invitesFrom: 'friends', showInSuggestions: true });
  await act(async () => { fireEvent.click(invitesSwitch()); });
  expect(api.setPrivacySettings).toHaveBeenLastCalledWith({ invitesFrom: 'friends' });
  expect(checked(invitesSwitch())).toBe('true');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a switch moves on the tap, and a second tap while one is out does nothing', async () => {
  api.getPrivacySettings.mockResolvedValue(OPEN);
  render(React.createElement(ProfileSettings, props()));
  await act(async () => {});
  const put = deferred();
  api.setPrivacySettings.mockReturnValue(put.promise);
  fireEvent.click(invitesSwitch());
  expect(checked(invitesSwitch())).toBe('true');
  fireEvent.click(invitesSwitch());
  fireEvent.click(suggestionsSwitch());
  expect(api.setPrivacySettings).toHaveBeenCalledTimes(1);
  await act(async () => { put.resolve({ invitesFrom: 'friends', showInSuggestions: true }); });
  expect(checked(invitesSwitch())).toBe('true');
  expect(checked(suggestionsSwitch())).toBe('true');
});

test('a refused write puts the switch back and says so in plain words', async () => {
  render(React.createElement(ProfileSettings, props()));
  await act(async () => {});
  const put = deferred();
  api.setPrivacySettings.mockReturnValue(put.promise);
  fireEvent.click(suggestionsSwitch());
  expect(checked(suggestionsSwitch())).toBe('true');
  await act(async () => { put.reject(Object.assign(new Error('Failed to update these settings'), { status: 500 })); });
  expect(checked(suggestionsSwitch())).toBe('false');
  expect(screen.getByRole('alert').textContent).toBe("That didn't save. Try again.");
});

test('a failed read says so, draws no switch, and can be tried again', async () => {
  api.getPrivacySettings.mockRejectedValueOnce(Object.assign(new Error('Failed to read these settings'), { status: 500 }));
  render(React.createElement(ProfileSettings, props()));
  await act(async () => {});
  expect(screen.queryAllByRole('switch')).toHaveLength(0);
  expect(screen.getByRole('alert').textContent).toBe('These settings are not loading right now.');

  api.getPrivacySettings.mockResolvedValueOnce(OPEN);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
  expect(checked(invitesSwitch())).toBe('false');
  expect(checked(suggestionsSwitch())).toBe('true');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('the words say what the server does, plainly', () => {
  for (const line of [INVITES_SWITCH, INVITES_LINE, SUGGESTIONS_SWITCH, SUGGESTIONS_LINE]) {
    expect(line).not.toContain(String.fromCharCode(0x2014)); // no em dash
    expect(line).not.toMatch(/seamless|effortless|unlock|!/i);
  }
  // Friends only means friends only, and a refused stranger is not told why.
  expect(INVITES_LINE).toMatch(/only your friends can add you to a flock/);
  expect(INVITES_LINE).toMatch(/they aren't told why/);
  // The switch covers the suggestions and nothing else: name search and
  // friend codes still find the account, and the line says so.
  expect(SUGGESTIONS_LINE).toMatch(/Quick Add and under Suggested/);
  expect(SUGGESTIONS_LINE).toMatch(/searching your name or using your friend code/);
});
