/**
 * A SIGN-IN THAT FAILS SAYS SO IN WORDS FOR PEOPLE.
 *
 * The Apple button showed whatever the native plugin rejected with, which on
 * a real phone is Apple's own log line: "The operation couldn't be completed.
 * (com.apple.AuthenticationServices.AuthorizationError error 1000.)". Only the
 * 1001 dismissal was filtered. Google's native path did the same with the
 * SDK's text ("No presenting view controller found"), and with its own "did
 * not return a token".
 *
 * Now a failure that is not the server's own sentence (and not one of the
 * website's own Apple lines, which name a fix) reads "Apple sign-in didn't
 * finish. Try again, or use email." or the Google equivalent, the detail goes
 * to the console, and a dismissed sheet still says nothing. The delete and
 * export dialogs have no email form to point at, so theirs ends at "Try
 * again." The server's own sentence, an under-13 refusal say, is still shown
 * word for word.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern=providerSignInErrorCopy
 */

const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  // The real one: what is under test is which words reach the screen.
  userMessage: jest.requireActual('../services/api').userMessage,
  trackAuthScreen: jest.fn(),
  login: jest.fn(),
  signup: jest.fn(),
  resendVerificationEmail: jest.fn(),
  googleLogin: jest.fn(),
  googleLoginWithToken: jest.fn(),
  appleLogin: jest.fn(),
  getAppleNonce: jest.fn(),
  RESET_DONE_KEY: 'flock_reset_done',
}));

// GIS stand-in for the web path. Each test says how the popup ends.
let mockGisConfig = null;
const mockWebStart = jest.fn();
jest.mock('@react-oauth/google', () => ({
  GoogleOAuthProvider: ({ children }) => children,
  useGoogleLogin: (config) => {
    mockGisConfig = config;
    return mockWebStart;
  },
}));

const mockSocialLogin = { initialize: jest.fn(), login: jest.fn() };
jest.mock('@capgo/capacitor-social-login', () => ({
  get SocialLogin() { return mockSocialLogin; },
}));

const mockAppleAuthorize = jest.fn();
jest.mock('@capacitor-community/apple-sign-in', () => ({
  SignInWithApple: { authorize: (...args) => mockAppleAuthorize(...args) },
}));

jest.mock('../components/auth/PasswordReset', () => ({
  ForgotPasswordScreen: () => null,
  ResetPasswordScreen: () => null,
  isPasswordResetRoute: () => false,
}));

// Both client ids before the modules load: the web flow and OAuthReconfirm
// read the web id once, at load; the native button reads both per render.
process.env.REACT_APP_GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID || 'web-client.apps.googleusercontent.com';
const api = require('../services/api');
const LoginScreen = require('../components/auth/LoginScreen').default;
const AppleSignInButton = require('../components/auth/AppleSignInButton').default;
const OAuthReconfirm = require('../components/auth/OAuthReconfirm').default;

const APPLE_1000 = "The operation couldn't be completed. (com.apple.AuthenticationServices.AuthorizationError error 1000.)";
const APPLE_SAYS = "Apple sign-in didn't finish. Try again, or use email.";
const GOOGLE_SAYS = "Google sign-in didn't finish. Try again, or use email.";

const asNativeIos = () => {
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
};
const serverSays = (status, message, data = {}) => Object.assign(new Error(message), { status, data, userFacing: true });

const openLogin = () => render(React.createElement(LoginScreen, {
  onLoginSuccess: jest.fn(), onSwitchToSignup: jest.fn(), onSwitchToVenueLogin: jest.fn(),
}));
const appleButton = (utils) => utils.getByRole('button', { name: /continue with apple/i });
const googleButton = (utils) => utils.getByRole('button', { name: /continue with google/i });

let warn;
let savedIos;
beforeEach(() => {
  savedIos = process.env.REACT_APP_GOOGLE_IOS_CLIENT_ID;
  process.env.REACT_APP_GOOGLE_IOS_CLIENT_ID = 'ios-client.apps.googleusercontent.com';
  mockSocialLogin.initialize.mockResolvedValue(undefined);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  if (savedIos === undefined) delete process.env.REACT_APP_GOOGLE_IOS_CLIENT_ID;
  else process.env.REACT_APP_GOOGLE_IOS_CLIENT_ID = savedIos;
  delete window.Capacitor;
  mockGisConfig = null;
  jest.clearAllMocks();
});

describe('Apple', () => {
  it('the plugin\'s own error text never reaches the screen: it reads in words, and the detail is logged', async () => {
    asNativeIos();
    const utils = openLogin();
    mockAppleAuthorize.mockRejectedValueOnce(new Error(APPLE_1000));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(APPLE_SAYS));
    expect(utils.container.textContent).not.toContain('AuthorizationError');
    expect(warn).toHaveBeenCalledWith('[flock] error kept off the screen:', APPLE_1000);
    expect(api.appleLogin).not.toHaveBeenCalled();
  });

  it('a dismissed sheet (1001) still says nothing, and logs nothing', async () => {
    asNativeIos();
    const utils = openLogin();
    mockAppleAuthorize.mockRejectedValueOnce(new Error("The operation couldn't be completed. (com.apple.AuthenticationServices.AuthorizationError error 1001.)"));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(mockAppleAuthorize).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(utils.queryByRole('alert')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('the server\'s own sentence is still shown as written', async () => {
    asNativeIos();
    const UNDERAGE = 'Flock could not create an account.';
    const utils = openLogin();
    mockAppleAuthorize.mockResolvedValueOnce({ response: { identityToken: 'apple-token', authorizationCode: 'apple-code', user: 'apple-user' } });
    api.appleLogin.mockRejectedValueOnce(serverSays(403, UNDERAGE, { error: UNDERAGE }));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNDERAGE));
  });

  it('a server failure with no sentence for people gets the same words', async () => {
    asNativeIos();
    const utils = openLogin();
    mockAppleAuthorize.mockResolvedValueOnce({ response: { identityToken: 'apple-token', authorizationCode: 'apple-code', user: 'apple-user' } });
    // What api.js builds for a 500 that said only "Server error".
    api.appleLogin.mockRejectedValueOnce(Object.assign(new Error('Something went wrong on our end. Try again.'), { status: 500, userFacing: false }));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(APPLE_SAYS));
  });

  it('inside the delete and export dialogs the line has no email to point at', async () => {
    asNativeIos();
    const onError = jest.fn();
    const utils = render(React.createElement(AppleSignInButton, { onError, reconfirm: true }));
    mockAppleAuthorize.mockRejectedValueOnce(new Error(APPLE_1000));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0]).toBe("Apple sign-in didn't finish. Try again.");
  });
});

describe('Google', () => {
  it('the native SDK\'s own error text never reaches the screen', async () => {
    asNativeIos();
    const utils = openLogin();
    mockSocialLogin.login.mockRejectedValueOnce(new Error('No presenting view controller found'));
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(GOOGLE_SAYS));
    expect(warn).toHaveBeenCalledWith('[flock] error kept off the screen:', 'No presenting view controller found');
    expect(api.googleLogin).not.toHaveBeenCalled();
  });

  it('a dismissed sheet still says nothing', async () => {
    asNativeIos();
    const utils = openLogin();
    mockSocialLogin.login.mockRejectedValueOnce(Object.assign(new Error('The user canceled the sign-in flow.'), { code: 'USER_CANCELLED' }));
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(mockSocialLogin.login).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(utils.queryByRole('alert')).toBeNull();
  });

  it('the server\'s own sentence is still shown as written, and one with nothing for people gets the line', async () => {
    asNativeIos();
    const utils = openLogin();
    mockSocialLogin.login.mockResolvedValue({ provider: 'google', result: { idToken: 'google-token', responseType: 'online' } });
    api.googleLogin.mockRejectedValueOnce(serverSays(401, 'That Google sign-in has expired. Try again.'));
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe('That Google sign-in has expired. Try again.'));

    api.googleLogin.mockRejectedValueOnce(Object.assign(new Error('Something went wrong on our end. Try again.'), { status: 500, userFacing: false }));
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(GOOGLE_SAYS));
  });

  it('on the web, a popup that comes back with an OAuth error code reads in words too', async () => {
    const utils = openLogin();
    mockWebStart.mockImplementationOnce(() => mockGisConfig.onError({ error: 'access_denied' }));
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(GOOGLE_SAYS));
    expect(utils.container.textContent).not.toContain('access_denied');
    expect(warn).toHaveBeenCalledWith('[flock] Google sign-in did not finish:', 'access_denied');
  });

  it('inside the delete and export dialogs the line has no email to point at', async () => {
    asNativeIos();
    mockSocialLogin.login.mockRejectedValueOnce(new Error('No presenting view controller found'));
    const utils = render(React.createElement(OAuthReconfirm, { provider: 'google', expectedUserId: 1 }));
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe("Google sign-in didn't finish. Try again."));
  });
});
