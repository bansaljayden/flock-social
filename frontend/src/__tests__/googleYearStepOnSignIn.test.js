/**
 * A NEW GOOGLE ACCOUNT FINISHES ON ONE GOOGLE SHEET FROM THE SIGN-IN SCREENS.
 *
 * The server answers a brand-new Google account 403 {needsDob,
 * dobGranularity:'year'} and hands the credential's replay claim back on that
 * refusal, so useGoogleAuth holds the proof and passes it to the screen as
 * `resume`. The sign-up screen already finishes with it: the year is asked in
 * the Google button's place and Continue posts the same proof with it
 * (googleYearStepOnSignup.test.js). The sign-in screen and the venue portal's
 * sign-in half dropped it, showed a red "tap Continue with Google again", and
 * a brand-new account went through Google's sheet twice.
 *
 * What is pinned here, on both screens:
 *   - the step in the Google button's place, focused, no red error, one year
 *     field, the consent line on screen;
 *   - Continue posts the SAME token plus the year, and no second sheet opens;
 *   - the web's GIS path holds its access token the same way;
 *   - an under-13 refusal is shown as the server wrote it;
 *   - the full-date backfill ask still goes up to the form's date field;
 *   - one step at a time, with Apple's;
 *   - past the held token's few minutes, Continue opens Google's sheet
 *     itself in the app, and on the web deliberately puts the Google button
 *     back rather than wait on a popup (useGoogleAuth.js says why).
 *
 * And on the venue portal's sign-up half in the iOS app, an empty year now
 * reaches Google's sheet, as it does on the consumer sign-up screen: a
 * returning owner signs straight in and a new one gets the same step.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern=googleYearStepOnSignIn
 */

const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  trackAuthScreen: jest.fn(),
  login: jest.fn(),
  signup: jest.fn(),
  resendVerificationEmail: jest.fn(),
  googleLogin: jest.fn(),
  googleLoginWithToken: jest.fn(),
  appleLogin: jest.fn(),
  RESET_DONE_KEY: 'flock_reset_done',
}));

// The web half: hands the config back so a test can fire the success
// callback the real library would fire, with no popup.
const mockWebStart = jest.fn();
jest.mock('@react-oauth/google', () => ({
  useGoogleLogin: (config) => {
    mockWebStart.mockImplementation(() => config.onSuccess({ access_token: 'web-access-token' }));
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

// The web Google flow exists only in a build that carries a client id
// (useGoogleAuth reads it once, at load), so these load the module as one.
process.env.REACT_APP_GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID || 'web-client.apps.googleusercontent.com';
const api = require('../services/api');
const LoginScreen = require('../components/auth/LoginScreen').default;
const VenueLoginScreen = require('../components/auth/VenueLoginScreen').default;

const ENV = ['REACT_APP_GOOGLE_IOS_CLIENT_ID', 'REACT_APP_GOOGLE_CLIENT_ID'];
let savedEnv;

const httpError = (status, message, data) => Object.assign(new Error(message), { status, data });
const yearAsk = (provider = 'Google') => httpError(403,
  `No Flock account yet. Add the year you were born, then tap Continue with ${provider} again.`,
  { needsDob: true, dobGranularity: 'year' });

const sheetGives = (idToken = 'google-id-token-1') => {
  mockSocialLogin.login.mockResolvedValueOnce({ provider: 'google', result: { idToken, responseType: 'online' } });
};

const SCREENS = [
  {
    label: 'the sign-in screen',
    fieldId: 'login-google-year',
    open: () => {
      const onLoginSuccess = jest.fn();
      const utils = render(React.createElement(LoginScreen, {
        onLoginSuccess, onSwitchToSignup: jest.fn(), onSwitchToVenueLogin: jest.fn(),
      }));
      return { ...utils, onLoginSuccess };
    },
  },
  {
    label: 'the venue portal\'s sign-in half',
    fieldId: 'venue-google-year',
    open: () => {
      const onLoginSuccess = jest.fn();
      const utils = render(React.createElement(VenueLoginScreen, { onLoginSuccess, onSwitchToUserLogin: jest.fn() }));
      return { ...utils, onLoginSuccess };
    },
  },
];

const googleButton = (utils) => utils.queryByRole('button', { name: /continue with google/i });
const appleButton = (utils) => utils.queryByRole('button', { name: /continue with apple/i });
const continueButton = (utils) => utils.queryByRole('button', { name: /^continue$/i });
const yearFields = (utils) => utils.container.querySelectorAll('input[autocomplete="bday-year"]');

// Google's sheet completes and the server asks for a year.
const firstTap = async (utils) => {
  sheetGives();
  api.googleLogin.mockRejectedValueOnce(yearAsk());
  fireEvent.click(googleButton(utils));
  await waitFor(() => expect(continueButton(utils)).not.toBeNull());
};

beforeEach(() => {
  savedEnv = ENV.map((k) => process.env[k]);
  process.env.REACT_APP_GOOGLE_IOS_CLIENT_ID = 'ios-client.apps.googleusercontent.com';
  process.env.REACT_APP_GOOGLE_CLIENT_ID = 'web-client.apps.googleusercontent.com';
  mockSocialLogin.initialize.mockResolvedValue(undefined);
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
});

afterEach(() => {
  ENV.forEach((k, i) => { if (savedEnv[i] === undefined) delete process.env[k]; else process.env[k] = savedEnv[i]; });
  jest.restoreAllMocks();
  jest.clearAllMocks();
  delete window.Capacitor;
});

SCREENS.forEach((screen) => {
  describe(`${screen.label}, a brand-new Google account`, () => {
    it('asks the year in the Google button\'s place, focused, with no red error and one year field', async () => {
      const utils = screen.open();
      await firstTap(utils);

      const field = utils.getByLabelText('Year of birth');
      expect(field.id).toBe(screen.fieldId);
      expect(document.activeElement).toBe(field);
      expect(utils.getByText('One more step to finish your account: the year you were born.')).toBeTruthy();
      expect(utils.queryByRole('alert')).toBeNull();
      expect(utils.container.textContent).not.toContain('Continue with Google again');
      expect(googleButton(utils)).toBeNull();
      expect(yearFields(utils).length).toBe(1);
      // Apple is still offered, and Continue creates the account, so the
      // consent line is on screen before it.
      expect(appleButton(utils)).not.toBeNull();
      expect(utils.container.querySelector('.auth-legal')).not.toBeNull();
    });

    it('Continue posts the SAME token plus the year and never opens a second Google sheet', async () => {
      const utils = screen.open();
      await firstTap(utils);
      fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2000' } });
      api.googleLogin.mockResolvedValueOnce({ user: { id: 91 } });
      fireEvent.click(continueButton(utils));

      await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 91 }));
      expect(mockSocialLogin.login).toHaveBeenCalledTimes(1);
      expect(api.googleLogin).toHaveBeenCalledTimes(2);
      expect(api.googleLogin.mock.calls[1]).toEqual(['google-id-token-1', '2000-12-31', { dobGranularity: 'year' }]);
    });

    it('an under-13 refusal is shown in the server\'s words, in the step, and nothing is tried again', async () => {
      const UNDERAGE = 'Flock could not create an account.';
      const utils = screen.open();
      await firstTap(utils);
      fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2019' } });
      api.googleLogin.mockRejectedValueOnce(httpError(403, UNDERAGE, { error: UNDERAGE }));
      fireEvent.click(continueButton(utils));
      await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNDERAGE));
      expect(continueButton(utils)).toBeNull();
      expect(googleButton(utils)).not.toBeNull();
      expect(utils.onLoginSuccess).not.toHaveBeenCalled();
      expect(api.googleLogin.mock.calls[1][1]).toBe('2019-12-31');
    });

    it('the full-date backfill ask still goes up to the form\'s date field, as before', async () => {
      const utils = screen.open();
      sheetGives();
      api.googleLogin.mockRejectedValueOnce(httpError(403, 'Add your date of birth to continue.', { needsDob: true }));
      fireEvent.click(googleButton(utils));
      await waitFor(() => expect(utils.getByRole('alert').textContent)
        .toBe('Add your date of birth below, then tap Continue with Google again.'));
      expect(utils.getByLabelText('Date of birth')).toBeTruthy();
      expect(continueButton(utils)).toBeNull();
    });

    it('past the held token\'s few minutes, Continue opens Google\'s sheet itself and finishes with the year', async () => {
      const utils = screen.open();
      const t0 = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
      await firstTap(utils);
      fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '1995' } });

      clock.mockReturnValue(t0 + 10 * 60 * 1000);
      sheetGives('google-id-token-2');
      api.googleLogin.mockResolvedValueOnce({ user: { id: 93 } });
      fireEvent.click(continueButton(utils));

      await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 93 }));
      expect(mockSocialLogin.login).toHaveBeenCalledTimes(2);
      expect(api.googleLogin.mock.calls[1]).toEqual(['google-id-token-2', '1995-12-31', { dobGranularity: 'year' }]);
      expect(utils.queryByRole('alert')).toBeNull();
    });

    it('Apple\'s step opening closes Google\'s, so there is still one year field and one Continue', async () => {
      const utils = screen.open();
      await firstTap(utils);
      mockAppleAuthorize.mockResolvedValueOnce({
        response: { identityToken: 'apple-token', authorizationCode: 'apple-code', user: 'apple-user' },
      });
      api.appleLogin.mockRejectedValueOnce(yearAsk('Apple'));
      fireEvent.click(appleButton(utils));
      await waitFor(() => expect(utils.getByLabelText('Year of birth').id).not.toBe(screen.fieldId));
      expect(yearFields(utils).length).toBe(1);
      expect(utils.getAllByRole('button', { name: /^continue$/i }).length).toBe(1);
      expect(googleButton(utils)).not.toBeNull();
    });
  });
});

describe('the sign-in screen on the web', () => {
  it('holds the GIS access token the same way, so a new account needs one popup', async () => {
    delete window.Capacitor;
    const utils = SCREENS[0].open();
    api.googleLoginWithToken.mockRejectedValueOnce(yearAsk());
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(continueButton(utils)).not.toBeNull());

    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '1999' } });
    api.googleLoginWithToken.mockResolvedValueOnce({ user: { id: 92 } });
    fireEvent.click(continueButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 92 }));
    expect(mockWebStart).toHaveBeenCalledTimes(1);
    expect(api.googleLoginWithToken.mock.calls[1]).toEqual(['web-access-token', '1999-12-31', { dobGranularity: 'year' }]);
  });

  it('past the held token\'s minutes, Continue does not start a popup it would have to wait on; the Google button comes back', async () => {
    // Deliberate, and written out above makeResume in useGoogleAuth.js: a
    // blocked or closed GIS popup is not reliably reported, so a Continue
    // waiting on one could hang. The button starts the popup from its own tap.
    delete window.Capacitor;
    const utils = SCREENS[0].open();
    const t0 = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
    api.googleLoginWithToken.mockRejectedValueOnce(yearAsk());
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(continueButton(utils)).not.toBeNull());
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '1999' } });

    clock.mockReturnValue(t0 + 10 * 60 * 1000);
    fireEvent.click(continueButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(
      'Google sign-in did not finish in time. Tap Continue with Google to try again. Your year is still filled in.'));
    expect(mockWebStart).toHaveBeenCalledTimes(1);
    expect(api.googleLoginWithToken).toHaveBeenCalledTimes(1);

    api.googleLoginWithToken.mockResolvedValueOnce({ user: { id: 94 } });
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 94 }));
    expect(api.googleLoginWithToken.mock.calls[1]).toEqual(['web-access-token', '1999-12-31', { dobGranularity: 'year' }]);
  });
});

describe('the venue portal\'s sign-up half, in the iOS app', () => {
  const openSignupHalf = () => {
    const utils = SCREENS[1].open();
    fireEvent.click(utils.getByRole('button', { name: 'Create an account' }));
    return utils;
  };

  it('a returning Google owner with the year empty is signed straight in, with no year asked', async () => {
    const utils = openSignupHalf();
    sheetGives();
    api.googleLogin.mockResolvedValueOnce({ user: { id: 95 } });
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 95 }));
    expect(api.googleLogin).toHaveBeenCalledWith('google-id-token-1', undefined);
    expect(utils.queryByRole('alert')).toBeNull();
  });

  it('a new Google account with the year empty is asked it after the sheet, and Continue creates the account', async () => {
    const utils = openSignupHalf();
    await firstTap(utils);
    const field = utils.getByLabelText('Year of birth');
    expect(field.id).toBe('venue-google-year');
    expect(yearFields(utils).length).toBe(1);
    expect(utils.queryByRole('alert')).toBeNull();

    fireEvent.change(field, { target: { value: '1980' } });
    api.googleLogin.mockResolvedValueOnce({ user: { id: 96 } });
    fireEvent.click(continueButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 96 }));
    expect(mockSocialLogin.login).toHaveBeenCalledTimes(1);
    expect(api.googleLogin.mock.calls[1]).toEqual(['google-id-token-1', '1980-12-31', { dobGranularity: 'year' }]);
  });

  it('a half-typed year is not sent to Google as no year at all', async () => {
    const utils = openSignupHalf();
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '19' } });
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe('Write the year in full, like 2004.'));
    expect(mockSocialLogin.login).not.toHaveBeenCalled();
  });
});
