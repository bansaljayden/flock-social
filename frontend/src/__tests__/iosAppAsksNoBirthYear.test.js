/**
 * THE IPHONE APP ASKS NOBODY FOR A DATE OF BIRTH.
 *
 * App Review rejected version 1.0 (build 47) on 2026-10-18 under guideline
 * 5.1.1(v): "Update the app to not require users to provide the following
 * personal information: Date of Birth". The reviewer's screen was Create
 * account, whose year field was required. Inside the iPhone app that field is
 * gone, nothing is sent, and the server creates the account without a date
 * (backend/utils/clientShell.js, pinned in backend/__tests__/
 * iosAppNoDateOfBirth.test.js); the App Store's 13+ age rating stands in its
 * place. The website keeps its neutral age screen exactly as it was.
 *
 * What is pinned here:
 *   - lib/nativeShell.js isIOSAppShell(): the capacitor: and ionic: protocols
 *     and the Capacitor iOS platform are the iPhone app; Android and the web
 *     are not;
 *   - consumer sign-up in the app: no year field, and the email form, the
 *     Apple button and the Google button all go without a date;
 *   - venue sign-up in the app: the same;
 *   - the website: the year field, its checks and the date sent are unchanged;
 *   - the consent line is on screen before any provider button that can now
 *     create an account in one tap (the sign-in screens), in the app only;
 *   - "confirm it's you" reads the server's new noAccount refusal, and every
 *     OAuth call made with opts.reconfirm says so to the server.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=iosAppAsksNoBirthYear
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  trackAuthScreen: jest.fn(),
  login: jest.fn(),
  signup: jest.fn(),
  resendVerificationEmail: jest.fn(),
  getCurrentUser: jest.fn(),
  googleLogin: jest.fn(),
  googleLoginWithToken: jest.fn(),
  appleLogin: jest.fn(),
  RESET_DONE_KEY: 'flock_reset_done',
}));

jest.mock('@react-oauth/google', () => ({
  useGoogleLogin: () => jest.fn(),
  GoogleOAuthProvider: ({ children }) => children,
}));

const mockAppleAuthorize = jest.fn();
jest.mock('@capacitor-community/apple-sign-in', () => ({
  SignInWithApple: { authorize: (...args) => mockAppleAuthorize(...args) },
}));

const mockSocialLogin = { initialize: jest.fn(), login: jest.fn() };
jest.mock('@capgo/capacitor-social-login', () => ({
  get SocialLogin() { return mockSocialLogin; },
}));

jest.mock('../components/auth/PasswordReset', () => ({
  ForgotPasswordScreen: () => null,
  ResetPasswordScreen: () => null,
  isPasswordResetRoute: () => false,
}));

process.env.REACT_APP_GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID || 'web-client.apps.googleusercontent.com';
process.env.REACT_APP_GOOGLE_IOS_CLIENT_ID = process.env.REACT_APP_GOOGLE_IOS_CLIENT_ID || 'ios-client.apps.googleusercontent.com';

const api = require('../services/api');
const { isIOSAppShell, asksForAge } = require('../lib/nativeShell');
const SignupScreen = require('../components/auth/SignupScreen').default;
const LoginScreen = require('../components/auth/LoginScreen').default;
const VenueLoginScreen = require('../components/auth/VenueLoginScreen').default;
const OAuthReconfirm = require('../components/auth/OAuthReconfirm').default;

const asNativeIos = () => {
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
};

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const SHEET = {
  identityToken: 'apple-id-token-1',
  authorizationCode: 'apple-code-1',
  user: 'apple-user-1',
  givenName: 'Sam',
  familyName: 'Lee',
};

afterEach(() => {
  jest.clearAllMocks();
  delete window.Capacitor;
});

const type = (el, value) => fireEvent.change(el, { target: { value } });

// ---------------------------------------------------------------------------
// How the app is recognised
// ---------------------------------------------------------------------------
describe('isIOSAppShell', () => {
  const fakeWin = (protocol, Capacitor) => ({ location: { protocol }, Capacitor });

  it('reads the page protocol the iPhone app is served from', () => {
    expect(isIOSAppShell(fakeWin('capacitor:'))).toBe(true);
    expect(isIOSAppShell(fakeWin('ionic:'))).toBe(true);
    expect(asksForAge(fakeWin('capacitor:'))).toBe(false);
  });

  it('accepts the Capacitor iOS platform, and nothing else', () => {
    expect(isIOSAppShell(fakeWin('http:', { isNativePlatform: () => true, getPlatform: () => 'ios' }))).toBe(true);
    // Android serves from https://localhost and is not the iPhone app.
    expect(isIOSAppShell(fakeWin('https:', { isNativePlatform: () => true, getPlatform: () => 'android' }))).toBe(false);
    // @capacitor/core defines window.Capacitor in a browser too, answering web.
    expect(isIOSAppShell(fakeWin('https:', { isNativePlatform: () => false, getPlatform: () => 'web' }))).toBe(false);
    expect(isIOSAppShell(fakeWin('https:'))).toBe(false);
    expect(asksForAge(fakeWin('https:'))).toBe(true);
    expect(isIOSAppShell(undefined)).toBe(false);
  });

  it('is the rule the server reads too, from the same origin', () => {
    const backend = fs.readFileSync(path.join(SRC, '..', '..', 'backend', 'utils', 'clientShell.js'), 'utf8');
    expect(backend).toMatch(/IOS_APP_ORIGINS = Object\.freeze\(\['capacitor:\/\/localhost', 'ionic:\/\/localhost'\]\)/);
    expect(read('lib', 'nativeShell.js')).toMatch(/const IOS_APP_PROTOCOLS = \['capacitor:', 'ionic:'\];/);
  });
});

// ---------------------------------------------------------------------------
// Consumer sign-up
// ---------------------------------------------------------------------------
describe('consumer sign-up in the iPhone app', () => {
  beforeEach(asNativeIos);

  it('draws no year field and never mentions a birth year', () => {
    const utils = render(React.createElement(SignupScreen, { onSignupSuccess: jest.fn(), onSwitchToLogin: jest.fn() }));
    expect(utils.queryByLabelText(/year of birth/i)).toBeNull();
    expect(utils.container.querySelector('#signup-dob')).toBeNull();
    expect(utils.container.textContent).not.toMatch(/born|birth/i);
  });

  it('creates an email account from name, email and password alone, sending no date', async () => {
    api.signup.mockResolvedValue({ user: { id: 9 } });
    const onSignupSuccess = jest.fn();
    const utils = render(React.createElement(SignupScreen, { onSignupSuccess, onSwitchToLogin: jest.fn() }));
    type(utils.getByLabelText('Name'), 'Sam Lee');
    type(utils.getByLabelText('Email'), 'sam@example.com');
    type(utils.getByLabelText('Password'), 'Password1');
    fireEvent.click(utils.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(api.signup).toHaveBeenCalledTimes(1));
    expect(api.signup).toHaveBeenCalledWith('Sam Lee', 'sam@example.com', 'Password1', undefined);
    await waitFor(() => expect(onSignupSuccess).toHaveBeenCalledWith({ id: 9 }));
  });

  it('Continue with Apple sends no date and no year granularity', async () => {
    mockAppleAuthorize.mockResolvedValueOnce({ response: { ...SHEET } });
    api.appleLogin.mockResolvedValue({ user: { id: 4 } });
    const onSignupSuccess = jest.fn();
    const utils = render(React.createElement(SignupScreen, { onSignupSuccess, onSwitchToLogin: jest.fn() }));
    fireEvent.click(utils.getByRole('button', { name: /continue with apple/i }));
    await waitFor(() => expect(api.appleLogin).toHaveBeenCalledTimes(1));
    const args = api.appleLogin.mock.calls[0];
    expect(args[0]).toBe('apple-id-token-1');
    expect(args[3]).toBeUndefined();
    expect(args.length).toBeLessThanOrEqual(4);
    await waitFor(() => expect(onSignupSuccess).toHaveBeenCalledWith({ id: 4 }));
  });

  it('Continue with Google goes straight to Google with no date and no year question', async () => {
    mockSocialLogin.initialize.mockResolvedValue(undefined);
    mockSocialLogin.login.mockResolvedValue({ provider: 'google', result: { idToken: 'native-id-token' } });
    api.googleLogin.mockResolvedValue({ user: { id: 5 } });
    const onSignupSuccess = jest.fn();
    const utils = render(React.createElement(SignupScreen, { onSignupSuccess, onSwitchToLogin: jest.fn() }));
    fireEvent.click(utils.getByRole('button', { name: /continue with google/i }));
    await waitFor(() => expect(api.googleLogin).toHaveBeenCalledTimes(1));
    expect(api.googleLogin.mock.calls[0][0]).toBe('native-id-token');
    expect(api.googleLogin.mock.calls[0][1]).toBeUndefined();
    await waitFor(() => expect(onSignupSuccess).toHaveBeenCalledWith({ id: 5 }));
    expect(utils.container.textContent).not.toMatch(/year you were born/i);
  });
});

describe('consumer sign-up on the website is unchanged', () => {
  it('keeps the year field, asks for it first, and sends the derived date', async () => {
    api.signup.mockResolvedValue({ user: { id: 2 } });
    const utils = render(React.createElement(SignupScreen, { onSignupSuccess: jest.fn(), onSwitchToLogin: jest.fn() }));
    expect(utils.getByLabelText('Year of birth')).toBeTruthy();
    type(utils.getByLabelText('Name'), 'Sam Lee');
    type(utils.getByLabelText('Email'), 'sam@example.com');
    type(utils.getByLabelText('Password'), 'Password1');
    fireEvent.click(utils.getByRole('button', { name: 'Create account' }));
    expect(utils.getByText('Add the year you were born.')).toBeTruthy();
    expect(api.signup).not.toHaveBeenCalled();
    type(utils.getByLabelText('Year of birth'), '2004');
    fireEvent.click(utils.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(api.signup).toHaveBeenCalledWith('Sam Lee', 'sam@example.com', 'Password1', '2004-12-31'));
  });
});

// ---------------------------------------------------------------------------
// Venue portal
// ---------------------------------------------------------------------------
describe('venue sign-up in the iPhone app', () => {
  beforeEach(asNativeIos);

  it('draws no year field and creates the account with no date', async () => {
    api.signup.mockResolvedValue({ user: { id: 11 } });
    const utils = render(React.createElement(VenueLoginScreen, { onLoginSuccess: jest.fn(), onSwitchToUserLogin: jest.fn() }));
    fireEvent.click(utils.getByRole('button', { name: 'Create an account' }));
    expect(utils.container.querySelector('#venue-dob')).toBeNull();
    expect(utils.queryByLabelText(/year of birth|date of birth/i)).toBeNull();
    type(utils.getByLabelText('Your name'), 'Pat Owner');
    type(utils.getByLabelText('Email'), 'owner@example.com');
    type(utils.getByLabelText('Password'), 'Password1');
    fireEvent.click(utils.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(api.signup).toHaveBeenCalledTimes(1));
    expect(api.signup).toHaveBeenCalledWith('Pat Owner', 'owner@example.com', 'Password1', undefined);
  });

  it('shows the consent line on the sign-in half before any provider button, because one tap now creates an account', () => {
    const utils = render(React.createElement(VenueLoginScreen, { onLoginSuccess: jest.fn(), onSwitchToUserLogin: jest.fn() }));
    const text = utils.container.textContent;
    const consentAt = text.indexOf('Creating an account means you agree to the');
    expect(consentAt).toBeGreaterThan(-1);
    expect(consentAt).toBeLessThan(text.indexOf('Continue with Apple'));
  });
});

describe('the venue portal on the website is unchanged', () => {
  it('its sign-in half shows no consent line until the server asks for a date', () => {
    const utils = render(React.createElement(VenueLoginScreen, { onLoginSuccess: jest.fn(), onSwitchToUserLogin: jest.fn() }));
    expect(utils.container.textContent).not.toMatch(/Creating an account means you agree to the/);
  });
});

// ---------------------------------------------------------------------------
// Consumer sign-in: the consent line
// ---------------------------------------------------------------------------
describe('the sign-in screen', () => {
  it('in the iPhone app carries the consent line from the start, above the provider buttons', () => {
    asNativeIos();
    const utils = render(React.createElement(LoginScreen, {
      onLoginSuccess: jest.fn(), onSwitchToSignup: jest.fn(), onSwitchToVenueLogin: jest.fn(),
    }));
    const text = utils.container.textContent;
    expect(text).toMatch(/Creating an account means you agree to the/);
    const consentAt = text.indexOf('Creating an account means you agree to the');
    expect(consentAt).toBeLessThan(text.indexOf('Continue with Apple'));
    expect(consentAt).toBeLessThan(text.indexOf('Continue with Google'));
    expect(utils.container.querySelectorAll('.auth-legal').length).toBe(1);
  });

  it('on the website shows it only once the server has asked for a date', () => {
    const utils = render(React.createElement(LoginScreen, {
      onLoginSuccess: jest.fn(), onSwitchToSignup: jest.fn(), onSwitchToVenueLogin: jest.fn(),
    }));
    expect(utils.container.textContent).not.toMatch(/Creating an account means you agree to the/);
  });
});

// ---------------------------------------------------------------------------
// "Confirm it's you"
// ---------------------------------------------------------------------------
describe('"confirm it\'s you" never creates an account', () => {
  it('reads the server\'s noAccount refusal as the wrong Apple ID', async () => {
    asNativeIos();
    mockAppleAuthorize.mockResolvedValueOnce({ response: { ...SHEET } });
    api.appleLogin.mockRejectedValueOnce(Object.assign(new Error('No Flock account uses this Apple ID.'), {
      status: 403, data: { noAccount: true },
    }));
    const utils = render(React.createElement(OAuthReconfirm, {
      provider: 'apple', expectedUserId: 1, onConfirmed: jest.fn(), onOtherAccount: jest.fn(),
    }));
    fireEvent.click(utils.getByRole('button', { name: /continue with apple/i }));
    await waitFor(() => expect(utils.getByRole('alert').textContent)
      .toBe('That Apple account is not the one this Flock account uses. Try again with the one you sign in with.'));
    // The call was a reconfirm, so the server is told not to create anything.
    expect(api.appleLogin.mock.calls[0][4]).toEqual({ reconfirm: true });
  });

  it('every OAuth call made with opts.reconfirm tells the server so', () => {
    const src = read('services', 'api.js');
    expect(src).toMatch(/const reconfirmField = \(opts\) => \(opts\?\.reconfirm \? \{ reconfirm: true \} : \{\}\);/);
    expect(src).toMatch(/const body = \{ access_token: accessToken, \.\.\.reconfirmField\(opts\) \};/);
    expect(src).toMatch(/const body = \{ credential, \.\.\.reconfirmField\(opts\) \};/);
    expect(src).toMatch(/const body = \{ identityToken, \.\.\.reconfirmField\(opts\) \};/);
  });
});
