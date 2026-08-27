/**
 * THE SIGN-IN SCREEN'S DATE OF BIRTH, AND THE TYPO THAT USED TO END AN ACCOUNT.
 *
 * `LoginScreen`'s date field is not a signup question. It appears on an account
 * that already exists, after a password has been checked or a provider token
 * verified, and `enforceDobOnLogin` in backend/routes/auth.js does not answer an
 * under-13 date on that path by declining to create an account. It WRITES the
 * date to the row, bumps token_version, revokes every live session, and refuses
 * every later sign-in from the stored-age freeze at the top of the same
 * function. Nothing in the app can edit a date of birth afterwards.
 *
 * So the field could end a real account, and every flock in it, on one mistyped
 * year, with no confirmation and no undo. The fix under test is a read-back:
 * before an under-13 date can be sent from this screen, the date is shown back
 * in words with the consequence stated, and the person has to say it is right.
 *
 * WHAT THESE TESTS DELIBERATELY DO NOT ASSERT
 *   - That an under-13 date is unenterable. It has to stay enterable. Capping
 *     the field would put this path outside the age gate and would stop the app
 *     recording the one fact COPPA says cannot be un-known once we have it. The
 *     signup field used to be capped that way and no longer is.
 *   - Anything about the server's refusal. It is unchanged, and an honest
 *     12-year-old reaches it one tap later than before.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  // The auth screens report their own arrival (auth_screen_viewed, added
  // 2026-08-27); a factory that omits the tracker crashes the mount effect.
  trackAuthScreen: jest.fn(),
  login: jest.fn(),
  signup: jest.fn(),
  resendVerificationEmail: jest.fn(),
  googleLoginWithToken: jest.fn(),
}));

jest.mock('@react-oauth/google', () => ({
  useGoogleLogin: () => jest.fn(),
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

const AUTH_DIR = path.join(__dirname, '..', 'components', 'auth');
const LOGIN_SRC = fs.readFileSync(path.join(AUTH_DIR, 'LoginScreen.js'), 'utf8');
const APPLE_SRC = fs.readFileSync(path.join(AUTH_DIR, 'AppleSignInButton.js'), 'utf8');

// The screen only shows the date field after the server has asked for one, so
// every test starts by getting the 403 that reveals it.
const renderWithDobAsked = async () => {
  api.login.mockRejectedValueOnce(
    Object.assign(new Error('Add your date of birth to continue.'), {
      status: 403, data: { needsDob: true },
    })
  );
  const utils = render(
    React.createElement(LoginScreen, {
      onLoginSuccess: jest.fn(), onSwitchToSignup: jest.fn(), onSwitchToVenueLogin: jest.fn(),
    })
  );
  fireEvent.change(utils.getByLabelText('Email'), { target: { value: 'sam@example.com' } });
  fireEvent.change(utils.getByLabelText('Password'), { target: { value: 'Password1' } });
  fireEvent.submit(utils.container.querySelector('form'));
  await waitFor(() => expect(utils.getByLabelText(/date of birth/i)).toBeTruthy());
  expect(api.login).toHaveBeenCalledTimes(1);
  return utils;
};

const yearsAgo = (n) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().split('T')[0];
};

describe('an under-13 date cannot leave the sign-in screen unread', () => {
  it('reads the date back in words before anything is sent', async () => {
    const { getByLabelText, getByText } = await renderWithDobAsked();
    fireEvent.change(getByLabelText(/date of birth/i), { target: { value: '2015-03-04' } });

    // The exact day matters. new Date('2015-03-04') is UTC midnight, so a
    // naive toLocaleDateString shows March 3 to anybody west of Greenwich, and
    // a panel that asks you to check a date must not print a different one.
    expect(getByText('You entered March 4, 2015.')).toBeTruthy();
    expect(getByText('Check this date')).toBeTruthy();
  });

  it('blocks the submit while the date is unconfirmed', async () => {
    const { container, getByLabelText, getByRole } = await renderWithDobAsked();
    fireEvent.change(getByLabelText(/date of birth/i), { target: { value: '2015-03-04' } });

    fireEvent.submit(container.querySelector('form'));
    await waitFor(() => expect(getByRole('alert').textContent).toMatch(/check the date of birth/i));
    // One call: the one that revealed the field. The mistyped date never left
    // the device, so no row was written and no session was revoked.
    expect(api.login).toHaveBeenCalledTimes(1);
  });

  it('sends the date once the person says it is right', async () => {
    const { container, getByLabelText, getByText } = await renderWithDobAsked();
    fireEvent.change(getByLabelText(/date of birth/i), { target: { value: '2015-03-04' } });
    fireEvent.click(getByText('That date is right'));

    api.login.mockRejectedValueOnce(Object.assign(new Error("We can't create a Flock account for you."), {
      status: 403, data: {},
    }));
    fireEvent.submit(container.querySelector('form'));
    await waitFor(() => expect(api.login).toHaveBeenCalledTimes(2));
    expect(api.login).toHaveBeenLastCalledWith('sam@example.com', 'Password1', '2015-03-04');
  });

  it('asks again if the date changes after being confirmed', async () => {
    const { container, getByLabelText, getByText, queryByText } = await renderWithDobAsked();
    const field = getByLabelText(/date of birth/i);
    fireEvent.change(field, { target: { value: '2015-03-04' } });
    fireEvent.click(getByText('That date is right'));
    expect(queryByText('Check this date')).toBeNull();

    // A second typo after the first was confirmed is still a typo.
    fireEvent.change(field, { target: { value: '2016-07-02' } });
    expect(getByText('You entered July 2, 2016.')).toBeTruthy();
    fireEvent.submit(container.querySelector('form'));
    await waitFor(() => expect(api.login).toHaveBeenCalledTimes(1));
  });

  it('never appears for a date the age gate accepts', async () => {
    const { container, getByLabelText, queryByText } = await renderWithDobAsked();
    fireEvent.change(getByLabelText(/date of birth/i), { target: { value: yearsAgo(20) } });
    expect(queryByText('Check this date')).toBeNull();

    api.login.mockResolvedValueOnce({ user: { id: 4 } });
    fireEvent.submit(container.querySelector('form'));
    await waitFor(() => expect(api.login).toHaveBeenCalledTimes(2));
  });

  it('guards the Google path, not just the form', async () => {
    const { getByText, getByLabelText, getByRole } = await renderWithDobAsked();
    fireEvent.change(getByLabelText(/date of birth/i), { target: { value: '2015-03-04' } });

    fireEvent.click(getByText(/continue with google/i));
    await waitFor(() => expect(getByRole('alert').textContent).toMatch(/check the date of birth/i));
    expect(api.googleLoginWithToken).not.toHaveBeenCalled();
  });
});

describe('the shape of the choice, so it is not undone by accident', () => {
  it('the field stays uncapped', async () => {
    // A max here would make the server-side under-13 flow unreachable from this
    // screen, which is the defect the signup screen carried until its cap came
    // off. The reasoning is written out above the declaration in LoginScreen.js.
    //
    // Asked of the RENDERED input rather than of a span of source. The span
    // this used to read ran from id="login-dob" to the first later mention of
    // login-dob-hint, and that mention is the input's own aria-describedby, so
    // it stopped INSIDE the attribute list with two attributes still to go. A
    // max written at the end of that list, which is where anybody adding an
    // attribute would put one, capped the field with all ten tests green.
    // getByLabelText cannot go vacuous either: it throws when the field is not
    // on screen, where an empty span quietly contained no max.
    const { getByLabelText } = await renderWithDobAsked();
    expect(getByLabelText(/date of birth/i).hasAttribute('max')).toBe(false);
  });

  it('the screen names no age and no rule, with the panel up', async () => {
    // A refusal that teaches which birthday gets in is not a neutral age
    // screen (16 CFR 312, and the note above the age gate in routes/auth.js).
    //
    // Asked of the WHOLE rendered screen, because a rule does not become
    // neutral by being printed somewhere other than the panel. The span this
    // used to read ran from the panel heading's id to the actions div, so it
    // covered neither the hint paragraph above the field, whose own source
    // comment claims it names no age, nor anything written below the two
    // buttons. Both are on screen and both were unguarded.
    const { getByLabelText, container } = await renderWithDobAsked();
    fireEvent.change(getByLabelText(/date of birth/i), { target: { value: '2015-03-04' } });

    // The stylesheet is not something a person reads, and it is inside the
    // container: a hex colour or a 13px rule would fail these negatives on a
    // screen that says nothing about an age. Strip it and read what is left.
    const visible = container.cloneNode(true);
    visible.querySelectorAll('style, script').forEach((el) => el.remove());
    const onScreen = visible.textContent;
    // The panel is up. Without this the two negatives below would pass on a
    // screen that had stopped reading the date back at all, which is the same
    // vacuity as the empty span.
    expect(onScreen).toContain('You entered March 4, 2015.');
    expect(onScreen).not.toMatch(/\b13\b/);
    expect(onScreen).not.toMatch(/\b(older|younger|age|ages|minimum)\b/i);
  });

  it('Apple is stopped before its sheet opens, not after', () => {
    // The one path a screen cannot re-enter for the user: the native sheet
    // needs the button's own tap, so an after-the-fact undo does not exist.
    expect(APPLE_SRC).toMatch(/if \(beforeAuthorize && beforeAuthorize\(\) === false\) return;/);
    expect(LOGIN_SRC).toMatch(/beforeAuthorize=\{\(\) => \{/);
  });
});

describe('the venue portal carries the same read-back on its sign-in half', () => {
  // Same field, same server path, and the account it would end belongs to a
  // customer. The SIGNUP half of that form is a different question: it takes
  // any date and lets the server answer, and is pinned in
  // signupNeutralAgeScreen.test.js alongside the consumer one.
  it('blocks the submit until the date is confirmed', async () => {
    api.login.mockRejectedValueOnce(
      Object.assign(new Error('Add your date of birth to continue.'), {
        status: 403, data: { needsDob: true },
      })
    );
    const { container, getByLabelText, getByText, getByRole } = render(
      React.createElement(VenueLoginScreen, { onLoginSuccess: jest.fn(), onSwitchToUserLogin: jest.fn() })
    );
    fireEvent.change(getByLabelText('Email'), { target: { value: 'bar@example.com' } });
    fireEvent.change(getByLabelText('Password'), { target: { value: 'Password1' } });
    fireEvent.submit(container.querySelector('form'));
    await waitFor(() => expect(getByLabelText(/date of birth/i)).toBeTruthy());

    fireEvent.change(getByLabelText(/date of birth/i), { target: { value: '2015-03-04' } });
    expect(getByText('You entered March 4, 2015.')).toBeTruthy();
    fireEvent.submit(container.querySelector('form'));
    await waitFor(() => expect(getByRole('alert').textContent).toMatch(/check the date of birth/i));
    expect(api.login).toHaveBeenCalledTimes(1);

    fireEvent.click(getByText('That date is right'));
    api.login.mockRejectedValueOnce(Object.assign(new Error("We can't create a Flock account for you."), {
      status: 403, data: {},
    }));
    fireEvent.submit(container.querySelector('form'));
    await waitFor(() => expect(api.login).toHaveBeenCalledTimes(2));
    expect(api.login).toHaveBeenLastCalledWith('bar@example.com', 'Password1', '2015-03-04');
  });
});
