/**
 * "ADD" ON THE INTERESTS SCREEN NEVER DOES NOTHING.
 *
 * The 2026-10-20 button sweep pressed Add on You > Interests with the field
 * empty and nothing happened: no focus, no message, no change. It swallowed a
 * duplicate the same way. Now an empty field takes the tap (the keyboard
 * opens), a duplicate says it is already on the list, and the button is drawn
 * quieter until there is something to add.
 *
 * The real ProfileSettings is rendered on its Interests page, with every
 * parameter given a neutral value the way usageAnalyticsSwitch.test.js does.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false interestsAddNeverSilent
 */
const React = require('react');
const fs = require('fs');
const path = require('path');
const { render, screen, fireEvent } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  deleteAccount: jest.fn(),
  trackNotificationPermission: jest.fn(),
  updatePaymentMethods: jest.fn(),
  logoutAll: jest.fn(),
  getCurrentUser: jest.fn(),
  clearLocalSession: jest.fn(),
  getProStatus: jest.fn(() => Promise.resolve({})),
  openProPortal: jest.fn(),
  cancelProSubscription: jest.fn(),
  resumeProSubscription: jest.fn(),
  appleLogin: jest.fn(),
  googleLogin: jest.fn(),
  googleLoginWithToken: jest.fn(),
  getAnalyticsChoice: jest.fn(() => Promise.resolve({ optOut: false })),
  setAnalyticsChoice: jest.fn(),
  knownAnalyticsChoice: jest.fn(() => null),
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

const ProfileSettings = require('../screens/ProfileSettings').default;

const PROFILE_SRC = fs.readFileSync(path.join(__dirname, '..', 'screens', 'ProfileSettings.js'), 'utf8');

// Every parameter ProfileSettings takes, read off its own signature.
const PARAMS = (() => {
  const start = PROFILE_SRC.indexOf('export default function ProfileSettings({');
  const block = PROFILE_SRC.slice(start, PROFILE_SRC.indexOf('}) {', start));
  return [...block.matchAll(/^\s+([A-Za-z_]\w*),/gm)].map((m) => m[1]);
})();
const COMPONENTS = new Set(['DialogBehavior', 'ListSkeleton', 'BottomNav', 'SafetyButton']);
const ARRAYS = new Set(['blockedUsers', 'flocks', 'pendingRequests', 'trustedContacts', 'userInterests', 'suggestedInterests']);

// App.js's SearchInputLocal, reduced to what this screen relies on: a real
// field that forwards its ref and hands its value up.
const SearchInputLocal = ({ inputRef, initialValue, onCommit, ...rest }) => (
  React.createElement('input', { ...rest, ref: inputRef, defaultValue: initialValue, onChange: (e) => onCommit(e.target.value) })
);

function props(overrides) {
  const out = {};
  for (const name of PARAMS) {
    if (COMPONENTS.has(name)) out[name] = () => null;
    else if (ARRAYS.has(name)) out[name] = [];
    else if (name === 'showToast' || /^(set|handle|load|on[A-Z]|toggle|switch|confirm|open|needs|session|answer)/.test(name)) out[name] = jest.fn();
    else out[name] = undefined;
  }
  return {
    ...out,
    SearchInputLocal,
    Toggle: () => null,
    colors: { navy: '#16283d', redText: '#b91c1c', navyMidBg: '#1e3a5c', creamDark: '#e8e0d5' },
    styles: { card: {}, input: {}, gradientButton: {} },
    entitlements: {},
    PROFILE_SUBSCREEN_TITLES: { interests: 'Interests' },
    deleteAlertRef: React.createRef(),
    newContact: {},
    authUser: { id: 42, name: 'Ren' },
    sessionEndCopy: (reason) => `ended: ${reason}`,
    needsEmailVerification: () => false,
    profileScreen: 'interests',
    newInterest: '',
    ...overrides,
  };
}

const addButton = () => screen.getByRole('button', { name: 'Add' });
const field = () => screen.getByRole('textbox', { name: 'Add an interest' });

test('with nothing typed, Add sends the tap to the field and changes nothing', () => {
  const p = props();
  render(React.createElement(ProfileSettings, p));
  expect(addButton().style.opacity).toBe('0.55');
  fireEvent.click(addButton());
  expect(document.activeElement).toBe(field());
  expect(p.setUserInterests).not.toHaveBeenCalled();
  expect(p.showToast).not.toHaveBeenCalled();
});

test('whitespace alone counts as nothing typed', () => {
  const p = props({ newInterest: '   ' });
  render(React.createElement(ProfileSettings, p));
  fireEvent.click(addButton());
  expect(document.activeElement).toBe(field());
  expect(p.setUserInterests).not.toHaveBeenCalled();
});

test('a new interest is added, trimmed, and the field is cleared', () => {
  const p = props({ newInterest: '  Bowling ', userInterests: ['Trivia'] });
  render(React.createElement(ProfileSettings, p));
  expect(addButton().style.opacity).toBe('1');
  fireEvent.click(addButton());
  expect(p.setUserInterests).toHaveBeenCalledWith(['Trivia', 'Bowling']);
  expect(p.setNewInterest).toHaveBeenCalledWith('');
  expect(p.showToast).not.toHaveBeenCalled();
});

test('one already on the list says so instead of doing nothing', () => {
  const p = props({ newInterest: 'Trivia', userInterests: ['Trivia'] });
  render(React.createElement(ProfileSettings, p));
  fireEvent.click(addButton());
  expect(p.setUserInterests).not.toHaveBeenCalled();
  expect(p.showToast).toHaveBeenCalledWith('Trivia is already on your list', 'info');
});
