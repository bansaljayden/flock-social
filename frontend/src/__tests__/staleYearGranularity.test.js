/**
 * A PROVIDER'S ANSWER MUST NOT LEAK INTO THE PASSWORD FORM.
 *
 * The sign-in screen shows a YEAR field when a Google or Apple tap comes back
 * with 403 {needsDob, dobGranularity:'year'}: the provider has no Flock account
 * yet, so this is account creation, and creation may ask only for a year. It
 * shows a full DATE field when the password path comes back with 403
 * {needsDob} and no flag: the password matched an account that already exists,
 * so this is enforceDobOnLogin writing to a real row, and a derived December
 * 31 written there is permanent and can freeze a real account.
 *
 * The bug this pins: the flag was screen state, set by the provider tap and
 * never cleared, so a person who tapped Google, saw the year field, realised
 * their account was an email one and signed in with a password was either
 * stuck (the empty-date guard read a field year mode never fills, so Sign in
 * did nothing, forever) or, on the venue portal, sent the derived date into
 * the backfill. Both screens now treat the password path as a backfill no
 * matter what a provider answered a moment earlier.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern=staleYear
 */

const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  trackAuthScreen: jest.fn(),
  login: jest.fn(),
  signup: jest.fn(),
  resendVerificationEmail: jest.fn(),
  googleLoginWithToken: jest.fn(),
}));

// The hook is replaced so a tap on the Google button answers at once with the
// creation 403, which is the state under test; the real hook would go to
// Google. isGoogleSignInAvailable stays true so the button renders.
let mockGoogleAnswer = null;
jest.mock('../components/auth/useGoogleAuth', () => ({
  __esModule: true,
  isGoogleSignInAvailable: () => true,
  default: ({ onError }) => () => {
    if (mockGoogleAnswer) onError(mockGoogleAnswer.message, mockGoogleAnswer);
  },
}));

jest.mock('../components/auth/AppleSignInButton', () => () => null);
jest.mock('../components/auth/PasswordReset', () => ({
  ForgotPasswordScreen: () => null,
  ResetPasswordScreen: () => null,
  isPasswordResetRoute: () => false,
}));

const api = require('../services/api');
const LoginScreen = require('../components/auth/LoginScreen').default;
const VenueLoginScreen = require('../components/auth/VenueLoginScreen').default;

const creation403 = () => Object.assign(
  new Error('No Flock account yet. Add the year you were born, then tap Continue with Google again.'),
  { status: 403, data: { needsDob: true, dobGranularity: 'year' } },
);
const backfill403 = () => Object.assign(
  new Error('Add your date of birth to continue.'),
  { status: 403, data: { needsDob: true } },
);

beforeEach(() => {
  mockGoogleAnswer = creation403();
  api.login.mockReset();
});

describe('the consumer sign-in screen', () => {
  const open = () => render(React.createElement(LoginScreen, {
    onLoginSuccess: jest.fn(), onSwitchToSignup: jest.fn(), onSwitchToVenueLogin: jest.fn(),
  }));

  it('a Google creation answer shows the year field, and the password form still submits', async () => {
    const { getByText, getByLabelText, queryByLabelText, container } = open();
    fireEvent.click(getByText('Continue with Google'));
    await waitFor(() => expect(getByLabelText('Year of birth')).toBeTruthy());
    expect(queryByLabelText('Date of birth')).toBeNull();

    // The person types a year into the provider's field, then signs in with a
    // password instead. The email form must not consult the year at all.
    fireEvent.change(getByLabelText('Year of birth'), { target: { value: '2013' } });
    fireEvent.change(getByLabelText('Email'), { target: { value: 'sam@example.com' } });
    fireEvent.change(getByLabelText('Password'), { target: { value: 'Password1' } });
    api.login.mockRejectedValueOnce(backfill403());
    fireEvent.submit(container.querySelector('form'));

    // It was sent, and it carried no date: not the derived December 31, and
    // not a refusal to send at all.
    await waitFor(() => expect(api.login).toHaveBeenCalledTimes(1));
    expect(api.login).toHaveBeenCalledWith('sam@example.com', 'Password1', undefined);

    // The server's backfill answer replaces the year field with the date one.
    await waitFor(() => expect(getByLabelText('Date of birth')).toBeTruthy());
    expect(queryByLabelText('Year of birth')).toBeNull();
    expect(container.querySelector('input[type="date"]')).not.toBeNull();
  });

  it('the derived date never reaches the password backfill even with a year typed', async () => {
    const { getByText, getByLabelText, container } = open();
    fireEvent.click(getByText('Continue with Google'));
    await waitFor(() => expect(getByLabelText('Year of birth')).toBeTruthy());
    fireEvent.change(getByLabelText('Year of birth'), { target: { value: '2004' } });
    fireEvent.change(getByLabelText('Email'), { target: { value: 'sam@example.com' } });
    fireEvent.change(getByLabelText('Password'), { target: { value: 'Password1' } });
    api.login.mockResolvedValueOnce({ user: { id: 7 } });
    fireEvent.submit(container.querySelector('form'));
    await waitFor(() => expect(api.login).toHaveBeenCalledTimes(1));
    for (const call of api.login.mock.calls) {
      expect(call[2]).toBeUndefined();
    }
  });
});

describe('the venue portal sign-in half', () => {
  const open = () => render(React.createElement(VenueLoginScreen, {
    onLoginSuccess: jest.fn(), onSwitchToUserLogin: jest.fn(),
  }));

  it('a Google creation answer does not make the password backfill send a derived date', async () => {
    const { getByText, getByLabelText, queryByLabelText, container, queryByText } = open();
    fireEvent.click(getByText('Continue with Google'));
    await waitFor(() => expect(getByLabelText('Year of birth')).toBeTruthy());

    // A year that computes under the floor. In the old code this raised the
    // read-back panel with a date nobody typed and, once confirmed, sent
    // December 31 into the backfill. Now the panel has nothing to say about a
    // provider's year, and the password form sends no date.
    fireEvent.change(getByLabelText('Year of birth'), { target: { value: '2013' } });
    expect(queryByText('Check this date')).toBeNull();

    fireEvent.change(getByLabelText('Email'), { target: { value: 'owner@example.com' } });
    fireEvent.change(getByLabelText('Password'), { target: { value: 'Password1' } });
    api.login.mockRejectedValueOnce(backfill403());
    fireEvent.submit(container.querySelector('form'));
    await waitFor(() => expect(api.login).toHaveBeenCalledTimes(1));
    expect(api.login).toHaveBeenCalledWith('owner@example.com', 'Password1', undefined);

    await waitFor(() => expect(getByLabelText('Date of birth')).toBeTruthy());
    expect(queryByLabelText('Year of birth')).toBeNull();
  });

  it('switching halves clears the provider answer and both fields', async () => {
    const { getByText, getByLabelText, queryByLabelText } = open();
    fireEvent.click(getByText('Continue with Google'));
    await waitFor(() => expect(getByLabelText('Year of birth')).toBeTruthy());
    fireEvent.change(getByLabelText('Year of birth'), { target: { value: '2004' } });

    // To the signup half and back: the year typed under the provider's rules
    // is not carried, and the sign-in half comes back with no field asked.
    fireEvent.click(getByText('Create an account'));
    await waitFor(() => expect(getByLabelText('Year of birth').value).toBe(''));
    fireEvent.click(getByText('Sign in'));
    await waitFor(() => expect(queryByLabelText('Year of birth')).toBeNull());
    expect(queryByLabelText('Date of birth')).toBeNull();
  });
});
