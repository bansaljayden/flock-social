/**
 * THE SIGNUP DATE OF BIRTH, AND THE BIRTHDAY THE SCREEN USED TO HAND OUT.
 *
 * `SignupScreen` used to cap its date picker at exactly thirteen years ago,
 * print "You have to be 13 or older to use Flock" directly above the field, and
 * refuse a younger date in `handleSubmit` and on the Google button without ever
 * calling the API. The effect of that was not that under-13s were kept out. It
 * was that a 12-year-old was shown which birthday passes, typed one, and the
 * app recorded that false date as their real one. It also made the whole
 * server-side under-13 flow in backend/routes/auth.js, a faithful FTC neutral
 * age screen with a refusal that names no age and a 24 hour retry lockout,
 * unreachable from the screen that most needed it.
 *
 * The amended COPPA rule (16 CFR Part 312, compliance date 2026-04-22) codifies
 * the neutral age screen, and the FTC's guidance is explicit that the screen
 * must not encourage a child to falsify their age.
 *
 * WHAT THESE TESTS PIN
 *   - The field takes any date and the screen prints no threshold.
 *   - Someone 13 or older signs up exactly as they did before: same call, same
 *     arguments, same result. Nothing on this screen decides that they are 13.
 *   - A 12-year-old's real date is sent, and what comes back is the server's
 *     neutral sentence, shown as written.
 *   - Google and Apple send the date the same way the form does.
 *
 * WHAT THEY DELIBERATELY DO NOT ASSERT
 *   Anything about which dates the server accepts. That is not this screen's
 *   job any more, and it is pinned where it is decided, in
 *   backend/__tests__/minorsCompliance.test.js (the 13th-birthday boundary, the
 *   lockout, the Google and Apple creation paths). What the two files share is
 *   the refusal sentence, which is read out of the server source below rather
 *   than copied, so the two cannot drift.
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
  signup: jest.fn(),
  resendVerificationEmail: jest.fn(),
  googleLogin: jest.fn(),
  googleLoginWithToken: jest.fn(),
  appleLogin: jest.fn(),
}));

// Stands in for Google Identity Services: hands the config back so a test can
// fire the success callback the real library would fire, with no popup.
const mockWebStart = jest.fn();
jest.mock('@react-oauth/google', () => ({
  useGoogleLogin: (config) => {
    mockWebStart.mockImplementation(() => config.onSuccess({ access_token: 'web-access-token' }));
    return mockWebStart;
  },
}));

const mockAppleAuthorize = jest.fn();
jest.mock('@capacitor-community/apple-sign-in', () => ({
  SignInWithApple: { authorize: (...args) => mockAppleAuthorize(...args) },
}));

const api = require('../services/api');
const SignupScreen = require('../components/auth/SignupScreen').default;

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
const SIGNUP_SRC = read('frontend', 'src', 'components', 'auth', 'SignupScreen.js');
const AUTH_ROUTE_SRC = read('backend', 'routes', 'auth.js');

// The refusal a 12-year-old actually receives, taken from the server rather
// than typed here. If somebody rewrites that sentence, these tests move with it.
const UNDERAGE_MSG = (() => {
  const m = AUTH_ROUTE_SRC.match(/const UNDERAGE_MSG = "([^"]+)";/);
  if (!m) throw new Error('UNDERAGE_MSG is no longer declared in backend/routes/auth.js');
  return m[1];
})();

const refusal = () => Object.assign(new Error(UNDERAGE_MSG), { status: 403, data: {} });

const yearsAgo = (n) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().split('T')[0];
};
const yearsAhead = (n) => yearsAgo(-n);

const asWeb = () => { delete window.Capacitor; };
const asNativeIos = () => {
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
};

// The screen's own words, without AuthShell's injected <style> block. That
// block carries pixel sizes, and a rule reading "font-size: 13.5px" is not the
// screen telling a child anything.
const visibleText = (container) => {
  const clone = container.cloneNode(true);
  clone.querySelectorAll('style, script').forEach((node) => node.remove());
  return clone.textContent;
};

const renderSignup = () => {
  const onSignupSuccess = jest.fn();
  const utils = render(
    React.createElement(SignupScreen, { onSignupSuccess, onSwitchToLogin: jest.fn() })
  );
  return { ...utils, onSignupSuccess };
};

// Everything except the date, so each test says only what it is about.
const fillEverythingBut = ({ getByLabelText }) => {
  fireEvent.change(getByLabelText('Name'), { target: { value: 'Sam' } });
  fireEvent.change(getByLabelText('Email'), { target: { value: 'sam@example.com' } });
  fireEvent.change(getByLabelText('Password'), { target: { value: 'Password1' } });
};

beforeEach(asWeb);
afterEach(asWeb);

describe('the field is neutral: it takes any date and teaches nothing', () => {
  it('the date picker is not capped, so a truthful under-13 date can be entered', () => {
    const { getByLabelText } = renderSignup();
    expect(getByLabelText('Date of birth').hasAttribute('max')).toBe(false);

    // Source too, because the rendered attribute would also be absent if the
    // field were replaced by something that computes the cap another way.
    const field = SIGNUP_SRC.slice(
      SIGNUP_SRC.indexOf('id="signup-dob"'),
      SIGNUP_SRC.indexOf('signup-dob-hint')
    );
    expect(field).not.toMatch(/max=/);
  });

  it('no threshold number is printed anywhere on the screen', () => {
    const { container } = renderSignup();
    // The password rules are the only numbers this screen is allowed to print.
    const text = visibleText(container);
    expect(text).not.toMatch(/\b13\b/);
    expect(text).not.toMatch(/or older/i);
    expect(text).not.toMatch(/at least \d+ to use/i);
    expect(text).not.toMatch(/must be \d+/i);
  });

  it('the hint under the field says what the date is for, and stays described on the field', () => {
    const { getByLabelText, getByText } = renderSignup();
    expect(getByText('We use this to check your age.')).toBeTruthy();
    expect(getByLabelText('Date of birth').getAttribute('aria-describedby')).toBe('signup-dob-hint');
  });

  it('the server refusal this screen relies on names no age either', () => {
    expect(UNDERAGE_MSG).not.toMatch(/\d/);
    expect(UNDERAGE_MSG).not.toMatch(/age|old|birth/i);
  });
});

describe('nothing changes for someone 13 or older', () => {
  it('the form sends the same four values it always did and the account is created', async () => {
    const dob = yearsAgo(13);
    api.signup.mockResolvedValueOnce({ user: { id: 7, name: 'Sam' } });

    const utils = renderSignup();
    fillEverythingBut(utils);
    fireEvent.change(utils.getByLabelText('Date of birth'), { target: { value: dob } });
    fireEvent.submit(utils.container.querySelector('form'));

    await waitFor(() => expect(api.signup).toHaveBeenCalledTimes(1));
    expect(api.signup).toHaveBeenCalledWith('Sam', 'sam@example.com', 'Password1', dob);
    await waitFor(() => expect(utils.onSignupSuccess).toHaveBeenCalledWith({ id: 7, name: 'Sam' }));
  });

  it('the confirm-your-email screen still follows a signup that needs one', async () => {
    api.signup.mockResolvedValueOnce({ emailVerificationRequired: true });

    const utils = renderSignup();
    fillEverythingBut(utils);
    fireEvent.change(utils.getByLabelText('Date of birth'), { target: { value: yearsAgo(21) } });
    fireEvent.submit(utils.container.querySelector('form'));

    await waitFor(() => expect(utils.getByText('Confirm your email')).toBeTruthy());
    expect(utils.onSignupSuccess).not.toHaveBeenCalled();
  });

  it('the empty and malformed cases are still answered on the device', async () => {
    const utils = renderSignup();
    fillEverythingBut(utils);
    fireEvent.submit(utils.container.querySelector('form'));

    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe('Add your date of birth.'));
    expect(api.signup).not.toHaveBeenCalled();
  });
});

describe('a 12 year old reaches the server, and the server answers', () => {
  it('the real date is sent rather than refused on the device', async () => {
    const dob = yearsAgo(12);
    api.signup.mockRejectedValueOnce(refusal());

    const utils = renderSignup();
    fillEverythingBut(utils);
    fireEvent.change(utils.getByLabelText('Date of birth'), { target: { value: dob } });
    fireEvent.submit(utils.container.querySelector('form'));

    // The date leaves the device exactly as typed. This is the whole point: the
    // old screen never made this call, so the age screen it was standing in
    // front of could only ever refuse a child who had already lied to it.
    await waitFor(() => expect(api.signup).toHaveBeenCalledTimes(1));
    expect(api.signup).toHaveBeenCalledWith('Sam', 'sam@example.com', 'Password1', dob);
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNDERAGE_MSG));
  });

  it('the second try with an older year is sent too, so the lockout is what answers it', async () => {
    api.signup.mockRejectedValueOnce(refusal());
    api.signup.mockRejectedValueOnce(refusal());

    const utils = renderSignup();
    fillEverythingBut(utils);
    fireEvent.change(utils.getByLabelText('Date of birth'), { target: { value: yearsAgo(12) } });
    fireEvent.submit(utils.container.querySelector('form'));
    await waitFor(() => expect(api.signup).toHaveBeenCalledTimes(1));

    // Back-button behaviour, on a screen that never unmounts: change the year to
    // one that passes and submit again. The screen does not remember anything
    // and does not need to. The server refused the first attempt, recorded it,
    // and answers the second with the same sentence, which is the FTC FAQ's
    // "keep the child from simply re-entering an older age". That memory is
    // pinned in backend/__tests__/minorsCompliance.test.js; what is pinned here
    // is that the client still asks, so the lockout is reachable at all.
    fireEvent.change(utils.getByLabelText('Date of birth'), { target: { value: yearsAgo(30) } });
    fireEvent.submit(utils.container.querySelector('form'));
    await waitFor(() => expect(api.signup).toHaveBeenCalledTimes(2));
    expect(api.signup.mock.calls[1][3]).toBe(yearsAgo(30));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNDERAGE_MSG));
  });

  it('the refusal is shown as the server wrote it, with nothing added', async () => {
    api.signup.mockRejectedValueOnce(refusal());

    const utils = renderSignup();
    fillEverythingBut(utils);
    fireEvent.change(utils.getByLabelText('Date of birth'), { target: { value: yearsAgo(9) } });
    fireEvent.submit(utils.container.querySelector('form'));

    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNDERAGE_MSG));
    expect(visibleText(utils.container)).not.toMatch(/\b13\b/);
    expect(visibleText(utils.container)).not.toMatch(/or older/i);
  });
});

describe('Google and Apple do exactly what the form does', () => {
  it('Google carries an under-13 date to the server instead of stopping at the button', async () => {
    const dob = yearsAgo(12);
    api.googleLoginWithToken.mockRejectedValueOnce(refusal());

    const utils = renderSignup();
    fireEvent.change(utils.getByLabelText('Date of birth'), { target: { value: dob } });
    fireEvent.click(utils.getByRole('button', { name: /continue with google/i }));

    await waitFor(() => expect(api.googleLoginWithToken).toHaveBeenCalledTimes(1));
    expect(api.googleLoginWithToken).toHaveBeenCalledWith('web-access-token', dob);
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNDERAGE_MSG));
  });

  it('Google with a date that passes signs the account in, unchanged', async () => {
    const dob = yearsAgo(20);
    api.googleLoginWithToken.mockResolvedValueOnce({ user: { id: 9 } });

    const utils = renderSignup();
    fireEvent.change(utils.getByLabelText('Date of birth'), { target: { value: dob } });
    fireEvent.click(utils.getByRole('button', { name: /continue with google/i }));

    await waitFor(() => expect(api.googleLoginWithToken).toHaveBeenCalledWith('web-access-token', dob));
    await waitFor(() => expect(utils.onSignupSuccess).toHaveBeenCalledWith({ id: 9 }));
  });

  it('Google still asks for the date first, because the server requires one to create an account', async () => {
    const utils = renderSignup();
    fireEvent.click(utils.getByRole('button', { name: /continue with google/i }));

    await waitFor(() => expect(utils.getByRole('alert').textContent)
      .toBe('Add your date of birth above first, then continue with Google.'));
    expect(api.googleLoginWithToken).not.toHaveBeenCalled();
  });

  it('Apple carries an under-13 date to the server too', async () => {
    asNativeIos();
    const dob = yearsAgo(12);
    mockAppleAuthorize.mockResolvedValueOnce({ response: { identityToken: 'apple-token' } });
    api.appleLogin.mockRejectedValueOnce(refusal());

    const utils = renderSignup();
    fireEvent.change(utils.getByLabelText('Date of birth'), { target: { value: dob } });
    fireEvent.click(utils.getByRole('button', { name: /continue with apple/i }));

    await waitFor(() => expect(api.appleLogin).toHaveBeenCalledTimes(1));
    expect(api.appleLogin.mock.calls[0][3]).toBe(dob);
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNDERAGE_MSG));
  });
});

describe('a date nobody alive can have is a typo, and is not sent as an age claim', () => {
  // The server reads any date short of the minimum as knowledge that a child is
  // signing up, and remembers the mailbox for 24 hours. A mistyped year in the
  // future would therefore cost a real person their account for a day. Refusing
  // it here names no threshold and turns away no truthful date.
  it('the form says the date does not look right and sends nothing', async () => {
    const utils = renderSignup();
    fillEverythingBut(utils);
    fireEvent.change(utils.getByLabelText('Date of birth'), { target: { value: yearsAhead(1) } });
    fireEvent.submit(utils.container.querySelector('form'));

    await waitFor(() => expect(utils.getByRole('alert').textContent)
      .toBe('That date of birth does not look right. Check it and try again.'));
    expect(api.signup).not.toHaveBeenCalled();
  });

  it('Google says the same thing and never opens the provider', async () => {
    const utils = renderSignup();
    fireEvent.change(utils.getByLabelText('Date of birth'), { target: { value: yearsAhead(1) } });
    fireEvent.click(utils.getByRole('button', { name: /continue with google/i }));

    await waitFor(() => expect(utils.getByRole('alert').textContent)
      .toBe('That date of birth does not look right. Check it and try again.'));
    expect(mockWebStart).not.toHaveBeenCalled();
    expect(api.googleLoginWithToken).not.toHaveBeenCalled();
  });

  it('Apple says the same thing and never opens the sheet', async () => {
    asNativeIos();
    const utils = renderSignup();
    fireEvent.change(utils.getByLabelText('Date of birth'), { target: { value: yearsAhead(1) } });
    fireEvent.click(utils.getByRole('button', { name: /continue with apple/i }));

    await waitFor(() => expect(utils.getByRole('alert').textContent)
      .toBe('That date of birth does not look right. Check it and try again.'));
    expect(mockAppleAuthorize).not.toHaveBeenCalled();
    expect(api.appleLogin).not.toHaveBeenCalled();
  });

  it('an empty date still reaches Apple, because an existing Apple account signs in without one', async () => {
    asNativeIos();
    mockAppleAuthorize.mockResolvedValueOnce({ response: { identityToken: 'apple-token' } });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 4 } });

    const utils = renderSignup();
    fireEvent.click(utils.getByRole('button', { name: /continue with apple/i }));

    await waitFor(() => expect(api.appleLogin).toHaveBeenCalledTimes(1));
    expect(api.appleLogin.mock.calls[0][3]).toBe('');
  });
});

describe('the screen holds no second opinion on age', () => {
  it('no minimum-age constant and no local age refusal survive in the source', () => {
    expect(SIGNUP_SRC).not.toMatch(/MIN_AGE/);
    expect(SIGNUP_SRC).not.toMatch(/maxDob/);
    // The one piece of age arithmetic left is dobLooksReal's "a living person
    // could have been born on this date" check, and it compares against zero.
    expect(SIGNUP_SRC).toMatch(/years !== null && years >= 0/);
    const code = SIGNUP_SRC.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/\b13\b/);
  });
});
