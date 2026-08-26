/**
 * The verification resend refusal must show the server's real rate-limit
 * sentence, not a hardcoded "Try again in a few minutes".
 *
 * The backend resend route words its 429 refusal with the real window
 * (backend/utils/retryAfter.js: the resend budget's longest leg is a day, not
 * "a few minutes"), and api.js carries that sentence to the client as the
 * error's `message`. App.js was fixed to render it; SignupScreen and
 * VenueLoginScreen still special-cased 429 and printed their own guess over it.
 *
 * These drive each screen to its awaiting-verification state, tap "Send the
 * link again" with a resend call that rejects with a server-worded 429, and
 * assert the server sentence reaches the rendered status while the hardcoded
 * "few minutes" copy is gone. The source guard at the end pins that the
 * hardcoded string cannot creep back into either file.
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  login: jest.fn(),
  signup: jest.fn(),
  resendVerificationEmail: jest.fn(),
  googleLogin: jest.fn(),
  googleLoginWithToken: jest.fn(),
  appleLogin: jest.fn(),
}));

jest.mock('@react-oauth/google', () => ({
  useGoogleLogin: () => jest.fn(),
}));

jest.mock('@capacitor-community/apple-sign-in', () => ({
  SignInWithApple: { authorize: jest.fn() },
}));

const api = require('../services/api');
const SignupScreen = require('../components/auth/SignupScreen').default;
const VenueLoginScreen = require('../components/auth/VenueLoginScreen').default;

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');

// The exact sentence the server sends, standing in for utils/retryAfter.js
// output. Its "24 hours" is the whole point: the old hardcoded copy said "a
// few minutes" over a budget whose longest leg is a day.
const SERVER_MSG = 'That is a lot of emails. Try again in about 24 hours.';
const rateLimited = () => Object.assign(new Error(SERVER_MSG), { status: 429 });

const yearsAgo = (n) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().split('T')[0];
};

beforeEach(() => {
  jest.clearAllMocks();
  delete window.Capacitor;
});

async function driveToResendNote(getResendButton) {
  api.resendVerificationEmail.mockRejectedValueOnce(rateLimited());
  const button = await waitFor(getResendButton);
  fireEvent.click(button);
  await waitFor(() => {
    if (!api.resendVerificationEmail.mock.calls.length) throw new Error('not yet');
  });
}

test('SignupScreen renders the server rate-limit sentence, not "a few minutes"', async () => {
  api.signup.mockResolvedValueOnce({ emailVerificationRequired: true });
  const utils = render(
    React.createElement(SignupScreen, {
      onSignupSuccess: jest.fn(),
      onSwitchToLogin: jest.fn(),
    })
  );

  fireEvent.change(utils.getByLabelText('Name'), { target: { value: 'Sam' } });
  fireEvent.change(utils.getByLabelText('Email'), { target: { value: 'sam@example.com' } });
  fireEvent.change(utils.getByLabelText('Password'), { target: { value: 'Password1' } });
  fireEvent.change(utils.getByLabelText('Date of birth'), { target: { value: yearsAgo(25) } });
  fireEvent.submit(utils.container.querySelector('form'));

  await driveToResendNote(() => utils.getByText('Send the link again'));

  await waitFor(() => expect(utils.getByText(SERVER_MSG)).toBeTruthy());
  expect(utils.queryByText(/few minutes/i)).toBeNull();
});

test('VenueLoginScreen renders the server rate-limit sentence, not "a few minutes"', async () => {
  api.signup.mockResolvedValueOnce({ emailVerificationRequired: true });
  const utils = render(
    React.createElement(VenueLoginScreen, {
      onLoginSuccess: jest.fn(),
      onSwitchToSignup: jest.fn(),
      onSwitchToVenueLogin: jest.fn(),
    })
  );

  // The venue portal opens in sign-in mode; switch it to registration so the
  // signup path (which leads to email verification) is the one under test.
  fireEvent.click(utils.getByText('Create an account'));

  fireEvent.change(utils.getByLabelText('Your name'), { target: { value: 'Sam' } });
  fireEvent.change(utils.getByLabelText('Email'), { target: { value: 'venue@example.com' } });
  fireEvent.change(utils.getByLabelText('Password'), { target: { value: 'Password1' } });
  fireEvent.change(utils.getByLabelText('Date of birth'), { target: { value: yearsAgo(30) } });
  fireEvent.submit(utils.container.querySelector('form'));

  await driveToResendNote(() => utils.getByText('Send the link again'));

  await waitFor(() => expect(utils.getByText(SERVER_MSG)).toBeTruthy());
  expect(utils.queryByText(/few minutes/i)).toBeNull();
});

test('neither auth screen carries the hardcoded "few minutes" 429 copy any more', () => {
  const signup = read('frontend', 'src', 'components', 'auth', 'SignupScreen.js');
  const venue = read('frontend', 'src', 'components', 'auth', 'VenueLoginScreen.js');
  // Match only the copy inside a string literal, so the explanatory comment
  // that quotes the old words to explain the fix does not trip this.
  const hardcoded = /setResendNote\('[^']*few minutes/;
  expect(hardcoded.test(signup)).toBe(false);
  expect(hardcoded.test(venue)).toBe(false);
  // And the honest branch renders the server message first.
  expect(/status === 429\) setResendNote\(err\?\.message/.test(signup)).toBe(true);
  expect(/status === 429\) setResendNote\(err\?\.message/.test(venue)).toBe(true);
});
