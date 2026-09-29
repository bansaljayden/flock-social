/**
 * A NEW GOOGLE ACCOUNT FINISHES ON ONE GOOGLE SHEET, ON THE IPHONE SIGN-UP.
 *
 * On iOS the sign-up screen puts the providers first, Apple on top, and a new
 * Apple account finishes in place: the year is asked after Apple's sheet, in
 * the Apple button's place, and Continue sends the same credentials with it.
 * Google, directly under it, still refused an empty year and sent the person
 * down to the email form's year field, then back up to Google. The two
 * buttons stacked together asked for the same thing in two different ways.
 *
 * Now Google does what Apple does. The server answers a new Google account
 * with no year 403 {needsDob, dobGranularity:'year'} and hands the
 * credential's replay claim back on that refusal (pinned server side in
 * backend/__tests__/oauthReplayAtomicity.test.js, "a needsDob refusal
 * releases the claim, Google"), so useGoogleAuth holds the proof and the
 * screen posts it again with the year. What is pinned here:
 *   - an empty year opens Google's sheet; a new account gets the step in the
 *     Google button's place, focused, with no error and no email form under it;
 *   - Continue posts the SAME token plus the year, and no second sheet opens;
 *   - an existing Google account is simply signed in;
 *   - an under-13 refusal is shown as the server wrote it, and nothing is
 *     tried again;
 *   - past the handle's few minutes the held token is never sent: Continue
 *     opens Google's sheet itself and sends the new token with the year, and
 *     a dismissed sheet keeps Continue;
 *   - on a connection that died after sending, the Google button comes back
 *     with the year kept, and one more sheet carries it;
 *   - offline keeps Continue and resends the same token;
 *   - one step at a time: Apple's step closes Google's, and the other way;
 *   - the web layout is untouched: the year is still asked first there.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test googleYearStepOnSignup --watchAll=false
 */

const React = require('react');
const { render, fireEvent, waitFor, act } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  trackAuthScreen: jest.fn(),
  login: jest.fn(),
  signup: jest.fn(),
  resendVerificationEmail: jest.fn(),
  getCurrentUser: jest.fn(),
  googleLogin: jest.fn(),
  googleLoginWithToken: jest.fn(),
  appleLogin: jest.fn(),
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

// The web Google flow exists only in a build that carries a client id
// (useGoogleAuth reads it once, at load), so these load the module as one.
process.env.REACT_APP_GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID || 'web-client.apps.googleusercontent.com';
const api = require('../services/api');
const SignupScreen = require('../components/auth/SignupScreen').default;
const { GOOGLE_RESUME_LIFETIME_MS } = require('../components/auth/useGoogleAuth');

const ENV = ['REACT_APP_GOOGLE_IOS_CLIENT_ID', 'REACT_APP_GOOGLE_CLIENT_ID'];
let savedEnv;

const asNativeIos = () => {
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
};

const httpError = (status, message, data) => Object.assign(new Error(message), { status, data });
const yearAsk = () => httpError(403,
  'No Flock account yet. Add the year you were born, then tap Continue with Google again.',
  { needsDob: true, dobGranularity: 'year' });

const sheetGives = (idToken = 'google-id-token-1') => {
  mockSocialLogin.login.mockResolvedValueOnce({ provider: 'google', result: { idToken, responseType: 'online' } });
};

const openSignup = () => {
  const onSignupSuccess = jest.fn();
  const utils = render(React.createElement(SignupScreen, { onSignupSuccess, onSwitchToLogin: jest.fn() }));
  return { ...utils, onSignupSuccess };
};

const googleButton = (utils) => utils.queryByRole('button', { name: /continue with google/i });
const appleButton = (utils) => utils.queryByRole('button', { name: /continue with apple/i });
const continueButton = (utils) => utils.queryByRole('button', { name: /^continue$/i });
const yearFields = (utils) => utils.container.querySelectorAll('input[autocomplete="bday-year"]');

// First tap with the year empty: Google's sheet completes, the server asks
// for a year.
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
  asNativeIos();
});

afterEach(() => {
  ENV.forEach((k, i) => { if (savedEnv[i] === undefined) delete process.env[k]; else process.env[k] = savedEnv[i]; });
  jest.restoreAllMocks();
  jest.clearAllMocks();
  delete window.Capacitor;
});

describe('the first Google tap for a new account, with the year empty', () => {
  it('opens Google\'s sheet, then asks the year in the Google button\'s place, focused, with no error', async () => {
    const utils = openSignup();
    await firstTap(utils);

    expect(mockSocialLogin.login).toHaveBeenCalledTimes(1);
    // Sent with no year at all, which is what earns the creation 403.
    expect(api.googleLogin).toHaveBeenCalledWith('google-id-token-1', undefined);

    const field = utils.getByLabelText('Year of birth');
    expect(field.id).toBe('signup-google-year');
    expect(document.activeElement).toBe(field);
    expect(utils.getByText('One more step: the year you were born.')).toBeTruthy();
    // Nothing failed, so nothing is red, and the server's "tap Continue with
    // Google again" is not repeated: the step is what makes that unnecessary.
    expect(utils.queryByRole('alert')).toBeNull();
    expect(utils.container.textContent).not.toContain('tap Continue with Google again');
    // One year field and one thing to tap: the form steps aside and Continue
    // takes the Google button's place.
    expect(yearFields(utils).length).toBe(1);
    expect(utils.queryByLabelText('Name')).toBeNull();
    expect(googleButton(utils)).toBeNull();
    // Apple is still offered above it, and the consent line above that.
    expect(appleButton(utils)).not.toBeNull();
    expect(utils.container.querySelector('.auth-legal')).not.toBeNull();
    expect(utils.getByText('One more step: the year you were born.').textContent).not.toMatch(/\d/);
  });

  it('Continue posts the SAME token plus the year and never opens a second sheet', async () => {
    const utils = openSignup();
    await firstTap(utils);
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2000' } });
    api.googleLogin.mockResolvedValueOnce({ user: { id: 61 } });
    fireEvent.click(continueButton(utils));

    await waitFor(() => expect(utils.onSignupSuccess).toHaveBeenCalledWith({ id: 61 }));
    expect(mockSocialLogin.login).toHaveBeenCalledTimes(1);
    expect(api.googleLogin).toHaveBeenCalledTimes(2);
    expect(api.googleLogin.mock.calls[1]).toEqual(['google-id-token-1', '2000-12-31', { dobGranularity: 'year' }]);
  });

  it('an empty year on Continue is answered on the device and nothing is posted', async () => {
    const utils = openSignup();
    await firstTap(utils);
    fireEvent.click(continueButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe('Add the year you were born.'));
    expect(api.googleLogin).toHaveBeenCalledTimes(1);
    expect(continueButton(utils)).not.toBeNull();
  });

  it('a Google account that already exists is simply signed in, with no year asked', async () => {
    const utils = openSignup();
    sheetGives();
    api.googleLogin.mockResolvedValueOnce({ user: { id: 62 } });
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.onSignupSuccess).toHaveBeenCalledWith({ id: 62 }));
    expect(utils.queryByText('One more step: the year you were born.')).toBeNull();
  });

  it('an account that exists with no birth date on file is sent to sign in, not left at a dead end', async () => {
    const utils = openSignup();
    sheetGives();
    api.googleLogin.mockRejectedValueOnce(httpError(403, 'Add your date of birth to continue.', { needsDob: true }));
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent)
      .toBe('This Google account already has a Flock account. Tap Sign in below and continue with Google there.'));
    expect(continueButton(utils)).toBeNull();
  });

  it('a half-typed year is not sent to Google as no year at all', async () => {
    const utils = openSignup();
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '20' } });
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe('Write the year in full, like 2004.'));
    expect(mockSocialLogin.login).not.toHaveBeenCalled();
  });

  it('a year typed in the form first goes with the first post, so a new account needs no step', async () => {
    const utils = openSignup();
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2000' } });
    sheetGives();
    api.googleLogin.mockResolvedValueOnce({ user: { id: 63 } });
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.onSignupSuccess).toHaveBeenCalledWith({ id: 63 }));
    expect(api.googleLogin).toHaveBeenCalledWith('google-id-token-1', '2000-12-31', { dobGranularity: 'year' });
  });
});

describe('when the held token cannot be used', () => {
  it('an under-13 refusal is shown in the server\'s words, in the step, and nothing is tried again', async () => {
    const UNDERAGE = 'Flock could not create an account.';
    const utils = openSignup();
    await firstTap(utils);
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2019' } });
    api.googleLogin.mockRejectedValueOnce(httpError(403, UNDERAGE, { error: UNDERAGE }));
    fireEvent.click(continueButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNDERAGE));
    expect(continueButton(utils)).toBeNull();
    expect(googleButton(utils)).not.toBeNull();
    expect(utils.onSignupSuccess).not.toHaveBeenCalled();
    expect(api.googleLogin).toHaveBeenCalledTimes(2);
    expect(api.googleLogin.mock.calls[1][1]).toBe('2019-12-31');
  });

  // This pinned a Continue that posted nothing, a sentence, and the Google
  // button back, a dead tap before the second sheet. The held token is still
  // never sent past its minutes; in the app the Continue that was pressed now
  // opens Google's sheet itself, the way Apple's does.
  it('past the handle\'s few minutes: Continue opens Google\'s sheet itself and finishes with the year, in one step', async () => {
    const utils = openSignup();
    const t0 = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
    await firstTap(utils);
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2001' } });

    clock.mockReturnValue(t0 + 10 * 60 * 1000);
    sheetGives('google-id-token-2');
    api.googleLogin.mockResolvedValueOnce({ user: { id: 64 } });
    fireEvent.click(continueButton(utils));

    await waitFor(() => expect(utils.onSignupSuccess).toHaveBeenCalledWith({ id: 64 }));
    expect(mockSocialLogin.login).toHaveBeenCalledTimes(2);
    expect(api.googleLogin).toHaveBeenCalledTimes(2);
    // The new sheet's token with the year typed, never the held one.
    expect(api.googleLogin.mock.calls[1]).toEqual(['google-id-token-2', '2001-12-31', { dobGranularity: 'year' }]);
  });

  it('past the handle\'s few minutes, a dismissed sheet keeps Continue, says why, and the next Continue opens it again', async () => {
    const utils = openSignup();
    const t0 = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
    await firstTap(utils);
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2001' } });

    clock.mockReturnValue(t0 + GOOGLE_RESUME_LIFETIME_MS + 1000);
    mockSocialLogin.login.mockRejectedValueOnce(Object.assign(new Error('The user canceled the sign-in flow.'), { code: 'USER_CANCELLED' }));
    fireEvent.click(continueButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(
      'Google sign-in timed out, so Google needs to check it is you again. Tap Continue to open it. Your year is still filled in.'));
    expect(api.googleLogin).toHaveBeenCalledTimes(1);
    expect(continueButton(utils)).not.toBeNull();
    expect(googleButton(utils)).toBeNull();

    sheetGives('google-id-token-3');
    api.googleLogin.mockResolvedValueOnce({ user: { id: 66 } });
    await act(async () => { fireEvent.click(continueButton(utils)); });
    await waitFor(() => expect(utils.onSignupSuccess).toHaveBeenCalledWith({ id: 66 }));
    expect(mockSocialLogin.login).toHaveBeenCalledTimes(3);
    expect(api.googleLogin.mock.calls[1]).toEqual(['google-id-token-3', '2001-12-31', { dobGranularity: 'year' }]);
  });

  it('a request refused while offline keeps Continue, and the retry sends the same token', async () => {
    const utils = openSignup();
    await firstTap(utils);
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2000' } });
    api.googleLogin.mockRejectedValueOnce(Object.assign(
      new Error("You're offline. This will work again once you're back on signal."), { isNetworkError: true, isOffline: true },
    ));
    fireEvent.click(continueButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent)
      .toBe("You're offline. This will work again once you're back on signal."));
    expect(continueButton(utils)).not.toBeNull();

    api.googleLogin.mockResolvedValueOnce({ user: { id: 65 } });
    await act(async () => { fireEvent.click(continueButton(utils)); });
    await waitFor(() => expect(utils.onSignupSuccess).toHaveBeenCalledWith({ id: 65 }));
    expect(mockSocialLogin.login).toHaveBeenCalledTimes(1);
    expect(api.googleLogin.mock.calls[2]).toEqual(['google-id-token-1', '2000-12-31', { dobGranularity: 'year' }]);
  });

  it('a connection that died after sending drops the token and asks for a fresh Google sheet', async () => {
    const utils = openSignup();
    await firstTap(utils);
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2000' } });
    api.googleLogin.mockRejectedValueOnce(Object.assign(
      new Error('Your signal dropped mid-reply. That may have gone through, so check before trying it again.'),
      { isNetworkError: true, isBadReply: true },
    ));
    fireEvent.click(continueButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent)
      .toMatch(/Tap Continue with Google to try again\. Your year is still filled in\./));
    expect(continueButton(utils)).toBeNull();
    expect(googleButton(utils)).not.toBeNull();
    expect(api.googleLogin).toHaveBeenCalledTimes(2);
  });

  it('is never written to storage', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    const utils = openSignup();
    await firstTap(utils);
    for (const [, value] of setItem.mock.calls) expect(String(value)).not.toContain('google-id-token-1');
  });
});

describe('one step at a time', () => {
  it('Sign up with email instead puts the form back and drops what was held', async () => {
    const utils = openSignup();
    await firstTap(utils);
    fireEvent.click(utils.getByRole('button', { name: 'Sign up with email instead' }));
    expect(utils.getByLabelText('Name')).toBeTruthy();
    expect(continueButton(utils)).toBeNull();
    expect(googleButton(utils)).not.toBeNull();
    expect(utils.queryByText('One more step: the year you were born.')).toBeNull();
  });

  it('Apple\'s step opening closes Google\'s, so there is still one year field', async () => {
    const utils = openSignup();
    await firstTap(utils);
    mockAppleAuthorize.mockResolvedValueOnce({
      response: { identityToken: 'apple-token', authorizationCode: 'apple-code', user: 'apple-user' },
    });
    api.appleLogin.mockRejectedValueOnce(httpError(403,
      'No Flock account yet. Add the year you were born, then tap Continue with Apple again.',
      { needsDob: true, dobGranularity: 'year' }));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(utils.getByLabelText('Year of birth').id).toBe('signup-apple-year'));
    expect(yearFields(utils).length).toBe(1);
    expect(utils.getAllByRole('button', { name: /^continue$/i }).length).toBe(1);
    // Google is back as a button under Apple's step.
    expect(googleButton(utils)).not.toBeNull();
  });

  it('Google\'s step opening closes Apple\'s', async () => {
    const utils = openSignup();
    mockAppleAuthorize.mockResolvedValueOnce({
      response: { identityToken: 'apple-token', authorizationCode: 'apple-code', user: 'apple-user' },
    });
    api.appleLogin.mockRejectedValueOnce(httpError(403,
      'No Flock account yet. Add the year you were born, then tap Continue with Apple again.',
      { needsDob: true, dobGranularity: 'year' }));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(utils.getByLabelText('Year of birth').id).toBe('signup-apple-year'));

    // Not firstTap: Apple's Continue is already on screen, so waiting for a
    // Continue would not wait for anything.
    sheetGives();
    api.googleLogin.mockRejectedValueOnce(yearAsk());
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.getByLabelText('Year of birth').id).toBe('signup-google-year'));
    expect(yearFields(utils).length).toBe(1);
    expect(utils.getAllByRole('button', { name: /^continue$/i }).length).toBe(1);
    expect(appleButton(utils)).not.toBeNull();
  });
});

describe('the hook hands a resume over for the year ask and nothing else', () => {
  const useGoogleAuth = require('../components/auth/useGoogleAuth').default;
  function Harness({ onSuccess, onError }) {
    const start = useGoogleAuth({ onSuccess, onError });
    return React.createElement('button', { type: 'button', onClick: () => start() }, 'go');
  }
  const run = async (onError) => {
    const utils = render(React.createElement(Harness, { onSuccess: jest.fn(), onError }));
    fireEvent.click(utils.getByRole('button', { name: 'go' }));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    return onError.mock.calls[0];
  };

  it('on the year ask: a one-use resume that posts the same token with the year', async () => {
    sheetGives();
    api.googleLogin.mockRejectedValueOnce(yearAsk());
    const [, err, resume] = await run(jest.fn());
    expect(err.data.dobGranularity).toBe('year');
    expect(typeof resume).toBe('function');

    api.googleLogin.mockResolvedValueOnce({ user: { id: 70 } });
    await expect(resume('2000-12-31', 'year')).resolves.toEqual({ user: { id: 70 } });
    expect(api.googleLogin.mock.calls[1]).toEqual(['google-id-token-1', '2000-12-31', { dobGranularity: 'year' }]);

    await expect(resume('2000-12-31', 'year')).rejects.toMatchObject({ expired: true });
    expect(api.googleLogin).toHaveBeenCalledTimes(2);
  });

  it('on any other refusal, exactly the two arguments every screen already reads', async () => {
    sheetGives();
    api.googleLogin.mockRejectedValueOnce(httpError(403, 'Add your date of birth to continue.', { needsDob: true }));
    const args = await run(jest.fn());
    expect(args).toHaveLength(2);
  });

  it('on the web the resume carries the same access token', async () => {
    delete window.Capacitor;
    api.googleLoginWithToken.mockRejectedValueOnce(yearAsk());
    const [, , resume] = await run(jest.fn());
    api.googleLoginWithToken.mockResolvedValueOnce({ user: { id: 71 } });
    await resume('2000-12-31', 'year');
    expect(api.googleLoginWithToken.mock.calls[1]).toEqual(['web-access-token', '2000-12-31', { dobGranularity: 'year' }]);
  });
});

describe('the web keeps the layout it had', () => {
  it('an empty year is still asked for first, above, and Google is never opened', async () => {
    delete window.Capacitor;
    const utils = openSignup();
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent)
      .toBe('Add the year you were born above first, then continue with Google.'));
    expect(mockWebStart).not.toHaveBeenCalled();
    expect(api.googleLoginWithToken).not.toHaveBeenCalled();
  });
});
