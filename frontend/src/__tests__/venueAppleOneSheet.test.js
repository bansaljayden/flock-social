/**
 * A NEW APPLE ID ON THE VENUE PORTAL FINISHES ON ONE APPLE SHEET.
 *
 * The consumer sign-in and sign-up screens finish a brand-new Apple account in
 * place: the server answers the first post 403 {needsDob, dobGranularity:
 * 'year'}, the credentials from that sheet are held, the year is asked where
 * the Apple button was, and Continue sends the SAME credentials with it.
 * "Run a venue? Sign in here" is inside the same iOS binary and offers the
 * same button, but dropped what was held: a new Apple ID got a red "tap
 * Continue with Apple again", a year field at the top of the form, and a
 * second Apple sheet. The review note promises one Continue and no second
 * sheet on every path a reviewer can reach, and this is one of them.
 *
 * What is pinned here:
 *   - the sign-in half: step in the Apple button's place, focused, with no
 *     red error and one year field, and Continue posts the same credentials
 *     plus the year with no second sheet;
 *   - an Apple ID that already has an account is simply signed in;
 *   - an under-13 refusal is shown as the server wrote it;
 *   - switching halves, or the password path's backfill ask, drops the step;
 *   - the sign-up half lets an empty year through to Apple's sheet, the way
 *     the consumer screens do, and asks it afterwards in the same step, while
 *     a half-typed year is still stopped before the sheet.
 *
 * appleOneSheetSignIn.test.js pins the same step on the consumer screens,
 * including the timeouts, which this screen shares through AppleYearStep.js.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern=venueAppleOneSheet
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
const VenueLoginScreen = require('../components/auth/VenueLoginScreen').default;

const SHEET = {
  identityToken: 'apple-id-token-v1',
  authorizationCode: 'apple-code-v1',
  user: 'apple-user-venue',
  givenName: 'Robin',
  familyName: 'Ortiz',
};

const httpError = (status, message, data) => Object.assign(new Error(message), { status, data });
const yearAsk = () => httpError(403,
  'No Flock account yet. Add the year you were born, then tap Continue with Apple again.',
  { needsDob: true, dobGranularity: 'year' });

const openVenue = () => {
  const onLoginSuccess = jest.fn();
  const utils = render(React.createElement(VenueLoginScreen, { onLoginSuccess, onSwitchToUserLogin: jest.fn() }));
  return { ...utils, onLoginSuccess };
};

const appleButton = (utils) => utils.queryByRole('button', { name: /continue with apple/i });
const continueButton = (utils) => utils.queryByRole('button', { name: /^continue$/i });
const yearFields = (utils) => utils.container.querySelectorAll('input[autocomplete="bday-year"]');

// Apple's sheet completes and the server asks for a year.
const firstTap = async (utils) => {
  mockAppleAuthorize.mockResolvedValueOnce({ response: { ...SHEET } });
  api.appleLogin.mockRejectedValueOnce(yearAsk());
  fireEvent.click(appleButton(utils));
  await waitFor(() => expect(continueButton(utils)).not.toBeNull());
};

beforeEach(() => {
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
});

afterEach(() => {
  jest.clearAllMocks();
  delete window.Capacitor;
});

describe('the venue sign-in half, a brand-new Apple ID', () => {
  it('asks the year in the Apple button\'s place, focused, with no red error and one year field', async () => {
    const utils = openVenue();
    await firstTap(utils);

    const field = utils.getByLabelText('Year of birth');
    expect(field.id).toBe('venue-apple-year');
    expect(document.activeElement).toBe(field);
    expect(utils.getByText('One more step: the year you were born.')).toBeTruthy();
    // Nothing failed, so nothing is red, and "tap Continue with Apple again"
    // is exactly what the step makes unnecessary.
    expect(utils.queryByRole('alert')).toBeNull();
    expect(utils.container.textContent).not.toContain('Continue with Apple again');
    // One thing to tap and one year field: Continue has taken the Apple
    // button's place and the form does not draw a second field at the top.
    expect(appleButton(utils)).toBeNull();
    expect(yearFields(utils).length).toBe(1);
    // The owner's hint, not the consumer one.
    expect(utils.getByText("Yours, not the venue's. We use it to check your age.")).toBeTruthy();
    // Continue creates the account, so the consent line is on screen first.
    expect(utils.container.querySelector('.auth-legal')).not.toBeNull();
  });

  it('Continue posts the SAME credentials plus the year and never opens a second sheet', async () => {
    const utils = openVenue();
    await firstTap(utils);
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '1990' } });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 81 } });
    fireEvent.click(continueButton(utils));

    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 81 }));
    expect(mockAppleAuthorize).toHaveBeenCalledTimes(1);
    expect(api.appleLogin).toHaveBeenCalledTimes(2);
    const [first, second] = api.appleLogin.mock.calls;
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toEqual({ givenName: 'Robin', familyName: 'Ortiz' });
    expect(second[2]).toBe('apple-code-v1');
    expect(second[3]).toBe('1990-12-31');
    expect(second[4]).toEqual({ dobGranularity: 'year' });
  });

  it('an Apple ID that already has an account is simply signed in, with no year asked', async () => {
    const utils = openVenue();
    mockAppleAuthorize.mockResolvedValueOnce({ response: { ...SHEET } });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 82 } });
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 82 }));
    expect(utils.queryByText('One more step: the year you were born.')).toBeNull();
  });

  it('an under-13 refusal is shown in the server\'s words, in the step, and nothing is tried again', async () => {
    const UNDERAGE = 'Flock could not create an account.';
    const utils = openVenue();
    await firstTap(utils);
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2019' } });
    api.appleLogin.mockRejectedValueOnce(httpError(403, UNDERAGE, { error: UNDERAGE }));
    fireEvent.click(continueButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNDERAGE));
    expect(continueButton(utils)).toBeNull();
    expect(utils.onLoginSuccess).not.toHaveBeenCalled();
    expect(api.appleLogin.mock.calls[1][3]).toBe('2019-12-31');
  });

  it('switching to the sign-up half drops what was held', async () => {
    const utils = openVenue();
    await firstTap(utils);
    fireEvent.click(utils.getByRole('button', { name: 'Create an account' }));
    expect(continueButton(utils)).toBeNull();
    expect(utils.queryByText('One more step: the year you were born.')).toBeNull();
    expect(appleButton(utils)).not.toBeNull();
    // The sign-up half's own year field, and only that one.
    expect(yearFields(utils).length).toBe(1);
    expect(utils.getByLabelText('Year of birth').id).toBe('venue-dob');
  });

  it('a password sign-in answered with the backfill ask closes the step for the date field', async () => {
    const utils = openVenue();
    await firstTap(utils);
    fireEvent.change(utils.getByLabelText('Email'), { target: { value: 'owner@example.com' } });
    fireEvent.change(utils.getByLabelText('Password'), { target: { value: 'Password1' } });
    api.login.mockRejectedValueOnce(httpError(403, 'Add your date of birth to continue.', { needsDob: true }));
    fireEvent.submit(utils.container.querySelector('form'));
    await waitFor(() => expect(utils.getByLabelText('Date of birth')).toBeTruthy());
    expect(api.login).toHaveBeenCalledWith('owner@example.com', 'Password1', undefined);
    expect(continueButton(utils)).toBeNull();
    expect(utils.queryByLabelText('Year of birth')).toBeNull();
  });
});

describe('the venue sign-up half', () => {
  const openSignupHalf = () => {
    const utils = openVenue();
    fireEvent.click(utils.getByRole('button', { name: 'Create an account' }));
    return utils;
  };

  it('an empty year opens Apple\'s sheet, and the year is asked after it in the Apple button\'s place', async () => {
    const utils = openSignupHalf();
    await firstTap(utils);

    expect(mockAppleAuthorize).toHaveBeenCalledTimes(1);
    // Sent with no year, which is what earns the creation 403.
    expect(api.appleLogin.mock.calls[0][3]).toBe('');
    const field = utils.getByLabelText('Year of birth');
    expect(field.id).toBe('venue-apple-year');
    expect(document.activeElement).toBe(field);
    expect(utils.queryByRole('alert')).toBeNull();
    // The form's own year field steps aside, so there is one on screen.
    expect(yearFields(utils).length).toBe(1);
    expect(utils.getByRole('button', { name: /^continue$/i })).toBeTruthy();
  });

  it('Continue creates the account with the same credentials plus the year, on one sheet', async () => {
    const utils = openSignupHalf();
    await firstTap(utils);
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '1985' } });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 83 } });
    fireEvent.click(continueButton(utils));

    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 83 }));
    expect(mockAppleAuthorize).toHaveBeenCalledTimes(1);
    const [first, second] = api.appleLogin.mock.calls;
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toEqual({ givenName: 'Robin', familyName: 'Ortiz' });
    expect(second[2]).toBe(first[2]);
    expect(second[3]).toBe('1985-12-31');
    expect(second[4]).toEqual({ dobGranularity: 'year' });
  });

  it('a half-typed year is not sent to Apple as no year at all', async () => {
    const utils = openSignupHalf();
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '19' } });
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe('Write the year in full, like 2004.'));
    expect(mockAppleAuthorize).not.toHaveBeenCalled();
  });

  it('Create account with the step open and no year points at the step\'s field and sends nothing', async () => {
    const utils = openSignupHalf();
    await firstTap(utils);
    fireEvent.change(utils.getByLabelText('Your name'), { target: { value: 'Robin' } });
    fireEvent.change(utils.getByLabelText('Email'), { target: { value: 'owner@example.com' } });
    fireEvent.change(utils.getByLabelText('Password'), { target: { value: 'Password1' } });
    fireEvent.submit(utils.container.querySelector('form'));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe('Add the year you were born.'));
    expect(api.signup).not.toHaveBeenCalled();
  });
});
