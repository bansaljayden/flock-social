/**
 * "SIGNING IN…" GOES ON THE BUTTON THAT WAS TAPPED.
 *
 * The three auth screens handed useGoogleAuth the email form's own `loading`
 * setter as its busy flag. So while Google's sign-in ran, the form's button
 * (Sign in, or Create account) changed to its busy label, and the Google
 * button the person had just tapped went on saying Continue with Google, on
 * the sign-in screen, the sign-up screen and the venue portal alike.
 *
 * Each screen now keeps Google's round trip in a state of its own. Pinned
 * here, rendered, on all three: while Google's exchange is in flight the
 * Google button says "Signing in…" and is disabled, the form's button keeps
 * its own words and is disabled too (one sign-in at a time), and both come
 * back when the answer lands.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern=googleBusyLabel
 */

const React = require('react');
const { render, fireEvent, waitFor, act } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  trackAuthScreen: jest.fn(),
  login: jest.fn(),
  signup: jest.fn(),
  resendVerificationEmail: jest.fn(),
  googleLogin: jest.fn(),
  googleLoginWithToken: jest.fn(),
  appleLogin: jest.fn(),
  RESET_DONE_KEY: 'flock_reset_done',
  userMessage: (err, fallback) => (err && err.userFacing && err.message) || fallback,
}));

// GIS stand-in: the starter fires the success callback the real library would,
// so the exchange with the server is what the test holds open.
const mockWebStart = jest.fn();
jest.mock('@react-oauth/google', () => ({
  useGoogleLogin: (config) => {
    mockWebStart.mockImplementation(() => config.onSuccess({ access_token: 'web-access-token' }));
    return mockWebStart;
  },
}));

jest.mock('../components/auth/PasswordReset', () => ({
  ForgotPasswordScreen: () => null,
  ResetPasswordScreen: () => null,
  isPasswordResetRoute: () => false,
}));

// The web Google flow exists only in a build that carries a client id
// (useGoogleAuth reads it once, at load), so these load the module as one.
process.env.REACT_APP_GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID || 'web-client.apps.googleusercontent.com';
const api = require('../services/api');
const LoginScreen = require('../components/auth/LoginScreen').default;
const SignupScreen = require('../components/auth/SignupScreen').default;
const VenueLoginScreen = require('../components/auth/VenueLoginScreen').default;

const SCREENS = [
  {
    label: 'the sign-in screen',
    primary: 'Sign in',
    open: (onSuccess) => render(React.createElement(LoginScreen, {
      onLoginSuccess: onSuccess, onSwitchToSignup: jest.fn(), onSwitchToVenueLogin: jest.fn(),
    })),
  },
  {
    label: 'the sign-up screen',
    primary: 'Create account',
    open: (onSuccess) => {
      const utils = render(React.createElement(SignupScreen, { onSignupSuccess: onSuccess, onSwitchToLogin: jest.fn() }));
      // On the web the year is asked before Google's popup (SignupScreen.js).
      fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '1999' } });
      return utils;
    },
  },
  {
    label: 'the venue portal',
    primary: 'Sign in',
    open: (onSuccess) => render(React.createElement(VenueLoginScreen, { onLoginSuccess: onSuccess, onSwitchToUserLogin: jest.fn() })),
  },
];

beforeEach(() => {
  delete window.Capacitor;
});

afterEach(() => {
  jest.clearAllMocks();
});

SCREENS.forEach((screen) => {
  it(`${screen.label}: Google's "Signing in…" is on the Google button, not on ${screen.primary}`, async () => {
    const onSuccess = jest.fn();
    const utils = screen.open(onSuccess);
    let answer;
    api.googleLoginWithToken.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));

    fireEvent.click(utils.getByRole('button', { name: /continue with google/i }));
    const google = await waitFor(() => utils.getByRole('button', { name: 'Signing in…' }));
    expect(google.className).toBe('auth-provider');
    expect(google.disabled).toBe(true);
    // The busy words are on the button that was tapped, and only there.
    expect(utils.getAllByText('Signing in…')).toHaveLength(1);
    const primary = utils.container.querySelector('.auth-primary');
    expect(primary.textContent).toBe(screen.primary);
    // Still one sign-in at a time.
    expect(primary.disabled).toBe(true);

    await act(async () => { answer({ user: { id: 3 } }); });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ id: 3 }));
    expect(utils.getByRole('button', { name: /continue with google/i }).disabled).toBe(false);
    expect(utils.container.querySelector('.auth-primary').disabled).toBe(false);
  });
});

it('the form\'s own busy label is still the form\'s: Sign in says "Signing in…" while the password is checked', async () => {
  let answer;
  api.login.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
  const onSuccess = jest.fn();
  const utils = SCREENS[0].open(onSuccess);
  fireEvent.change(utils.getByLabelText('Email'), { target: { value: 'sam@example.com' } });
  fireEvent.change(utils.getByLabelText('Password'), { target: { value: 'Password1' } });
  fireEvent.click(utils.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(utils.container.querySelector('.auth-primary').textContent).toBe('Signing in…'));
  expect(utils.getByRole('button', { name: /continue with google/i }).disabled).toBe(true);
  await act(async () => { answer({ user: { id: 4 } }); });
  await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ id: 4 }));
});
