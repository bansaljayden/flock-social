/**
 * A NEW APPLE ACCOUNT FINISHES ON ONE APPLE SHEET.
 *
 * App Review's first action on build 38 was Continue with Apple as a brand-new
 * user. The server answers that first post 403 {needsDob, dobGranularity:
 * 'year'}, because Apple never sends a birth year. The sign-in screen used to
 * answer with a red error ("date of birth", over a field labelled "Year of
 * birth", because the copy read the previous render's state), put the field at
 * the top of a form the person had scrolled past, and ask them to go through
 * Apple's sheet a second time.
 *
 * Now the credentials from that first sheet are held in memory, the year field
 * appears where the Apple button was, focused, and Continue posts the SAME
 * credentials with the year. The server side of why that is allowed is pinned
 * in backend/__tests__/oauthReplayAtomicity.test.js ("the year 403 spends
 * nothing"). What is pinned here:
 *   - one sheet, same identity token, same code, same name, plus the year;
 *   - the copy follows the server's granularity, not stale screen state;
 *   - past Apple's five minutes, or on a 401/503, the screen falls back to the
 *     Apple button with a plain sentence, and the year stays filled in;
 *   - a refusal such as under 13 is shown in the server's own words, and the
 *     held credentials are not tried again;
 *   - a request that never reached the server keeps Continue usable.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=appleOneSheet
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
}));

jest.mock('@react-oauth/google', () => ({ useGoogleLogin: () => jest.fn() }));

const mockAppleAuthorize = jest.fn();
jest.mock('@capacitor-community/apple-sign-in', () => ({
  SignInWithApple: { authorize: (...args) => mockAppleAuthorize(...args) },
}));

jest.mock('../components/auth/PasswordReset', () => ({
  ForgotPasswordScreen: () => null,
  ResetPasswordScreen: () => null,
  isPasswordResetRoute: () => false,
}));

const api = require('../services/api');
const LoginScreen = require('../components/auth/LoginScreen').default;
const SignupScreen = require('../components/auth/SignupScreen').default;
const { APPLE_CODE_LIFETIME_MS } = require('../components/auth/AppleSignInButton');

const asNativeIos = () => {
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
};

const SHEET = {
  identityToken: 'apple-id-token-1',
  authorizationCode: 'apple-code-1',
  user: 'apple-user-1',
  givenName: 'Sam',
  familyName: 'Lee',
};

const httpError = (status, message, data) => Object.assign(new Error(message), { status, data });
const yearAsk = () => httpError(403,
  'No Flock account yet. Add the year you were born, then tap Continue with Apple again.',
  { needsDob: true, dobGranularity: 'year' });

const open = (onLoginSuccess = jest.fn()) => {
  const utils = render(React.createElement(LoginScreen, {
    onLoginSuccess, onSwitchToSignup: jest.fn(), onSwitchToVenueLogin: jest.fn(),
  }));
  return { ...utils, onLoginSuccess };
};

const appleButton = (utils) => utils.queryByRole('button', { name: /continue with apple/i });
const continueButton = (utils) => utils.queryByRole('button', { name: /^continue$/i });

// First tap: Apple's sheet completes, the server asks for a year.
const firstTap = async (utils) => {
  mockAppleAuthorize.mockResolvedValueOnce({ response: { ...SHEET } });
  api.appleLogin.mockRejectedValueOnce(yearAsk());
  fireEvent.click(appleButton(utils));
  await waitFor(() => expect(continueButton(utils)).not.toBeNull());
};

beforeEach(() => {
  asNativeIos();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  delete window.Capacitor;
});

describe('the first Apple tap for a new account', () => {
  it('puts the year field where the Apple button was, focused, with its own line and no red error', async () => {
    const utils = open();
    await firstTap(utils);

    const field = utils.getByLabelText('Year of birth');
    expect(document.activeElement).toBe(field);
    expect(utils.getByText('One more step: the year you were born.')).toBeTruthy();
    // No stale "date of birth" sentence, and no error at all: nothing failed.
    expect(utils.queryByRole('alert')).toBeNull();
    expect(utils.container.textContent).not.toMatch(/date of birth/i);
    expect(utils.queryByLabelText('Date of birth')).toBeNull();
    // Continue replaces the Apple button, so there is one thing to tap.
    expect(appleButton(utils)).toBeNull();
    // Only one year field on screen: the step's, not a second one at the top.
    expect(utils.container.querySelectorAll('input[autocomplete="bday-year"]').length).toBe(1);
    // The consent line the account needs is on screen before Continue.
    expect(utils.container.querySelector('.auth-legal')).not.toBeNull();
    // The line names no age, the same rule as every other age screen.
    expect(utils.getByText('One more step: the year you were born.').textContent).not.toMatch(/\d/);
  });

  it('Continue posts the SAME credentials plus the year and never opens a second sheet', async () => {
    const utils = open();
    await firstTap(utils);

    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2000' } });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 41 } });
    fireEvent.click(continueButton(utils));

    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 41 }));
    expect(mockAppleAuthorize).toHaveBeenCalledTimes(1);
    expect(api.appleLogin).toHaveBeenCalledTimes(2);
    const [first, second] = api.appleLogin.mock.calls;
    expect(first[0]).toBe('apple-id-token-1');
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toEqual({ givenName: 'Sam', familyName: 'Lee' });
    expect(second[2]).toBe('apple-code-1');
    expect(second[3]).toBe('2000-12-31');
    expect(second[4]).toEqual({ dobGranularity: 'year' });
  });

  it('an empty year is answered on the device and nothing is posted', async () => {
    const utils = open();
    await firstTap(utils);
    fireEvent.click(continueButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe('Add the year you were born.'));
    expect(api.appleLogin).toHaveBeenCalledTimes(1);
    expect(continueButton(utils)).not.toBeNull();
  });
});

describe('the copy follows the server, not the previous render', () => {
  it('a full-date ask (no granularity) says date of birth and shows the date field', async () => {
    const utils = open();
    mockAppleAuthorize.mockResolvedValueOnce({ response: { ...SHEET } });
    api.appleLogin.mockRejectedValueOnce(httpError(403, 'Add your date of birth to continue.', { needsDob: true }));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent)
      .toBe('Add your date of birth below, then tap Continue with Apple again.'));
    expect(utils.getByLabelText('Date of birth')).toBeTruthy();
    expect(continueButton(utils)).toBeNull();
  });

  it('the year ask never says date of birth, even on the very first answer', async () => {
    const utils = open();
    await firstTap(utils);
    expect(utils.container.textContent).not.toMatch(/date of birth/i);
  });
});

describe('when the held credentials cannot be used', () => {
  it("past Apple's five minutes: no post, a plain sentence, and the Apple button back with the year kept", async () => {
    const utils = open();
    const t0 = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
    await firstTap(utils);
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2001' } });

    clock.mockReturnValue(t0 + APPLE_CODE_LIFETIME_MS + 1000);
    fireEvent.click(continueButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(
      'Apple sign-in did not finish in time. Tap Continue with Apple to try again. Your year is still filled in.'));
    expect(api.appleLogin).toHaveBeenCalledTimes(1);
    expect(continueButton(utils)).toBeNull();
    expect(appleButton(utils)).not.toBeNull();
    expect(utils.getByLabelText('Year of birth').value).toBe('2001');

    // One more sheet finishes it, carrying the year that is already typed.
    mockAppleAuthorize.mockResolvedValueOnce({ response: { ...SHEET, identityToken: 'apple-id-token-2', authorizationCode: 'apple-code-2' } });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 42 } });
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 42 }));
    const last = api.appleLogin.mock.calls[1];
    expect(last[0]).toBe('apple-id-token-2');
    expect(last[3]).toBe('2001-12-31');
    expect(last[4]).toEqual({ dobGranularity: 'year' });
  });

  it.each([
    [401, 'Apple sign-in expired, please try again'],
    [503, "Apple sign-in didn't complete. Try again in a moment."],
  ])('a %i from the server falls back to the Apple tap', async (status, message) => {
    const utils = open();
    await firstTap(utils);
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2000' } });
    api.appleLogin.mockRejectedValueOnce(httpError(status, message, { error: message }));
    fireEvent.click(continueButton(utils));
    await waitFor(() => expect(appleButton(utils)).not.toBeNull());
    expect(utils.getByRole('alert').textContent).toMatch(/^Apple sign-in did not finish in time\./);
    expect(continueButton(utils)).toBeNull();
    expect(mockAppleAuthorize).toHaveBeenCalledTimes(1);
  });

  it('an under-13 refusal is shown in the server\'s words and the credentials are not tried again', async () => {
    const UNDERAGE = 'Flock could not create an account.';
    const utils = open();
    await firstTap(utils);
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2019' } });
    api.appleLogin.mockRejectedValueOnce(httpError(403, UNDERAGE, { error: UNDERAGE }));
    fireEvent.click(continueButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNDERAGE));
    expect(continueButton(utils)).toBeNull();
    expect(utils.onLoginSuccess).not.toHaveBeenCalled();
    expect(api.appleLogin).toHaveBeenCalledTimes(2);
    // The year went to the server as typed; nothing on the device judged it.
    expect(api.appleLogin.mock.calls[1][3]).toBe('2019-12-31');
  });

  it('a request refused while offline keeps Continue, and the retry sends the same credentials', async () => {
    const utils = open();
    await firstTap(utils);
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2000' } });
    // api.js throws this before sending anything, so the server never saw them.
    api.appleLogin.mockRejectedValueOnce(Object.assign(
      new Error("You're offline. This will work again once you're back on signal."), { isNetworkError: true, isOffline: true },
    ));
    fireEvent.click(continueButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent)
      .toBe("You're offline. This will work again once you're back on signal."));
    expect(continueButton(utils)).not.toBeNull();

    api.appleLogin.mockResolvedValueOnce({ user: { id: 43 } });
    await act(async () => { fireEvent.click(continueButton(utils)); });
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 43 }));
    expect(mockAppleAuthorize).toHaveBeenCalledTimes(1);
    expect(api.appleLogin.mock.calls[2][0]).toBe('apple-id-token-1');
    expect(api.appleLogin.mock.calls[2][2]).toBe('apple-code-1');
  });

  it('a connection that died after sending drops the credentials and asks for a fresh Apple sheet', async () => {
    // A lost 200 looks exactly like this, and a retry of spent credentials
    // would only earn the replay guard's 401.
    const utils = open();
    await firstTap(utils);
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2000' } });
    api.appleLogin.mockRejectedValueOnce(Object.assign(
      new Error('Your signal dropped mid-reply. That may have gone through, so check before trying it again.'),
      { isNetworkError: true, isBadReply: true },
    ));
    fireEvent.click(continueButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent)
      .toMatch(/Tap Continue with Apple to try again\. Your year is still filled in\./));
    expect(continueButton(utils)).toBeNull();
    expect(appleButton(utils)).not.toBeNull();
    expect(api.appleLogin).toHaveBeenCalledTimes(2);
  });
});

describe('the signup screen stays as it was', () => {
  it('asks the year before the sheet and sends it on the first post', async () => {
    const utils = render(React.createElement(SignupScreen, { onSignupSuccess: jest.fn(), onSwitchToLogin: jest.fn() }));
    fireEvent.change(utils.getByLabelText(/year of birth/i), { target: { value: '2000' } });
    mockAppleAuthorize.mockResolvedValueOnce({ response: { ...SHEET } });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 44 } });
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(api.appleLogin).toHaveBeenCalledTimes(1));
    expect(api.appleLogin.mock.calls[0][3]).toBe('2000-12-31');
    expect(api.appleLogin.mock.calls[0][4]).toEqual({ dobGranularity: 'year' });
    expect(mockAppleAuthorize).toHaveBeenCalledTimes(1);
  });
});

describe('the held credentials', () => {
  it('are never written to storage', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    const utils = open();
    await firstTap(utils);
    for (const [, value] of setItem.mock.calls) {
      expect(String(value)).not.toContain('apple-id-token-1');
      expect(String(value)).not.toContain('apple-code-1');
    }
  });
});
