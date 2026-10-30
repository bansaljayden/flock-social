/**
 * THE PRIMARY BUTTON IS IN THE SAME PLACE ON EVERY AUTH SCREEN.
 *
 * Every sign-in and sign-up screen draws on AuthShell, whose column is a
 * viewport-tall flex column with a hero that stretches. The filled button had
 * no place of its own, so it sat wherever each screen's content ended: under
 * the consent line, Apple, Google, a divider and two fields on Sign in; under
 * a password checklist on Create account, below the fold on a phone; on the
 * confirm screen the filled button was "Send the link again" while the way
 * forward was an outlined button above it. An error pushed it down, and with
 * the WebView not resizing for the keyboard it stayed under the keys until the
 * person scrolled.
 *
 * AuthShell now takes the screen's one filled button as `actions` and draws it
 * in a bar after the sheet, stuck to the bottom of the scroller and lifted by
 * the keyboard's footprint. What is pinned here, rendered:
 *   - every screen and state has exactly one filled button, and it is in the
 *     bar, the last thing in <main>, alone;
 *   - messages and links stay in the sheet, so they cannot move it;
 *   - a submit button in the bar still submits its form (form="...");
 *   - a provider's held year step puts its Continue in the bar and nothing
 *     else filled stays on screen;
 *   - the confirm screen's filled button is the way forward;
 *   - the keyboard's footprint reaches the bar.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern=authActionsBar
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, fireEvent, waitFor, act } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  __esModule: true,
  default: jest.fn(),
  trackAuthScreen: jest.fn(),
  login: jest.fn(),
  signup: jest.fn(),
  resendVerificationEmail: jest.fn(),
  getCurrentUser: jest.fn(),
  googleLogin: jest.fn(),
  googleLoginWithToken: jest.fn(),
  appleLogin: jest.fn(),
  getAppleNonce: jest.fn(),
  clearLocalSession: jest.fn(),
  RESET_DONE_KEY: 'flock_reset_done',
  userMessage: (err, fallback) => (err && err.userFacing && err.message) || fallback,
}));

jest.mock('@react-oauth/google', () => ({ useGoogleLogin: () => jest.fn() }));

const mockAppleAuthorize = jest.fn();
jest.mock('@capacitor-community/apple-sign-in', () => ({
  SignInWithApple: { authorize: (...args) => mockAppleAuthorize(...args) },
}));

const api = require('../services/api');
const LoginScreen = require('../components/auth/LoginScreen').default;
const SignupScreen = require('../components/auth/SignupScreen').default;
const VenueLoginScreen = require('../components/auth/VenueLoginScreen').default;
const VerifyEmailPage = require('../components/auth/VerifyEmailPage').default;
const { ForgotPasswordScreen, ResetPasswordScreen } = require('../components/auth/PasswordReset');

const SHELL_SRC = fs.readFileSync(path.join(__dirname, '..', 'components', 'auth', 'AuthShell.js'), 'utf8');

// The shape the server mints for both link kinds: 32 hex, a dot, a verifier.
const TOKEN = `${'0123456789abcdef'.repeat(2)}.${'Ab-_'.repeat(11)}`;

const asNativeIos = () => {
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
};

const httpError = (status, message, data) => Object.assign(new Error(message), { status, data, userFacing: true });

/** The rule, checked on whatever is on screen: one filled button, in the bar,
 *  the bar last in <main> after the sheet, and nothing else in the bar. */
const theOneFilledButton = (container) => {
  const filled = container.querySelectorAll('.auth-primary');
  expect(filled).toHaveLength(1);
  const bar = container.querySelector('.auth-actions');
  expect(bar).not.toBeNull();
  expect(bar.contains(filled[0])).toBe(true);
  const main = bar.parentElement;
  expect(main.tagName).toBe('MAIN');
  expect(main.lastElementChild).toBe(bar);
  expect(bar.previousElementSibling.classList.contains('auth-sheet')).toBe(true);
  expect(bar.children).toHaveLength(1);
  return filled[0];
};

const openLogin = () => render(React.createElement(LoginScreen, {
  onLoginSuccess: jest.fn(), onSwitchToSignup: jest.fn(), onSwitchToVenueLogin: jest.fn(),
}));
const openSignup = (onSignupSuccess = jest.fn()) => render(React.createElement(SignupScreen, {
  onSignupSuccess, onSwitchToLogin: jest.fn(),
}));
const openVenue = () => render(React.createElement(VenueLoginScreen, {
  onLoginSuccess: jest.fn(), onSwitchToUserLogin: jest.fn(),
}));

const fillSignup = (utils, { name = 'Sam', email = 'sam@example.com', year = '1999', password = 'Password1' } = {}) => {
  fireEvent.change(utils.getByLabelText('Name'), { target: { value: name } });
  fireEvent.change(utils.getByLabelText('Email'), { target: { value: email } });
  const yearField = utils.queryByLabelText('Year of birth');
  if (yearField) fireEvent.change(yearField, { target: { value: year } });
  fireEvent.change(utils.getByLabelText('Password'), { target: { value: password } });
};

const realInnerHeight = window.innerHeight;

beforeEach(() => {
  delete window.Capacitor;
  window.history.replaceState({}, '', '/');
});

afterEach(() => {
  jest.clearAllMocks();
  delete window.Capacitor;
  delete window.visualViewport;
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: realInnerHeight });
});

describe('every auth screen keeps exactly one filled button, in the bar', () => {
  it('Sign in, on the web (the form first)', () => {
    const { container, getByRole } = openLogin();
    expect(theOneFilledButton(container)).toBe(getByRole('button', { name: 'Sign in' }));
  });

  it('Sign in, in the iPhone app (the providers first)', () => {
    asNativeIos();
    const { container, getByRole } = openLogin();
    expect(theOneFilledButton(container)).toBe(getByRole('button', { name: 'Sign in' }));
  });

  it('Create account, on the web and in the iPhone app', () => {
    const web = openSignup();
    expect(theOneFilledButton(web.container)).toBe(web.getByRole('button', { name: 'Create account' }));
    web.unmount();
    asNativeIos();
    const app = openSignup();
    expect(theOneFilledButton(app.container)).toBe(app.getByRole('button', { name: 'Create account' }));
  });

  it('the venue portal, on both halves', () => {
    const utils = openVenue();
    expect(theOneFilledButton(utils.container)).toBe(utils.getByRole('button', { name: 'Sign in' }));
    fireEvent.click(utils.getByRole('button', { name: 'Create an account' }));
    expect(theOneFilledButton(utils.container)).toBe(utils.getByRole('button', { name: 'Create account' }));
  });

  it('Forgot password, before and after the link is sent', async () => {
    api.default.mockResolvedValueOnce({ ok: true });
    const utils = render(React.createElement(ForgotPasswordScreen, { onBack: jest.fn(), initialEmail: 'sam@example.com' }));
    const send = theOneFilledButton(utils.container);
    expect(send.textContent).toBe('Send me a link');
    fireEvent.click(send);
    await waitFor(() => expect(utils.getByText(/Sent to sam@example.com/)).toBeTruthy());
    expect(theOneFilledButton(utils.container).textContent).toBe('Back to sign in');
  });

  it('Set a new password: the form, then the done screen', async () => {
    window.history.replaceState({}, '', `/reset-password#token=${TOKEN}`);
    api.default.mockResolvedValueOnce({ valid: true, email: 'sam@example.com' });
    const utils = render(React.createElement(ResetPasswordScreen, { onSignIn: jest.fn(), onRequestNew: jest.fn() }));
    await waitFor(() => expect(utils.getByLabelText('New password')).toBeTruthy());
    const save = theOneFilledButton(utils.container);
    expect(save.textContent).toBe('Save new password');

    fireEvent.change(utils.getByLabelText('New password'), { target: { value: 'Password1' } });
    fireEvent.change(utils.getByLabelText('Type it again'), { target: { value: 'Password1' } });
    api.default.mockResolvedValueOnce({});
    fireEvent.click(save);
    await waitFor(() => expect(utils.getByText('Your password is set.')).toBeTruthy());
    expect(api.default).toHaveBeenLastCalledWith('/api/auth/reset-password', expect.objectContaining({ method: 'POST' }));
    expect(theOneFilledButton(utils.container).textContent).toBe('Sign in');
  });

  it('a dead reset link offers a new one from the bar', async () => {
    window.history.replaceState({}, '', `/reset-password#token=${TOKEN}`);
    api.default.mockResolvedValueOnce({ valid: false, reason: 'expired' });
    const utils = render(React.createElement(ResetPasswordScreen, { onSignIn: jest.fn(), onRequestNew: jest.fn() }));
    await waitFor(() => expect(utils.getByText('That link expired')).toBeTruthy());
    expect(theOneFilledButton(utils.container).textContent).toBe('Send me a new link');
  });

  it('while the link is being checked there is nothing to press, and the sheet ends the screen', () => {
    window.history.replaceState({}, '', `/reset-password#token=${TOKEN}`);
    api.default.mockReturnValueOnce(new Promise(() => {}));
    const { container } = render(React.createElement(ResetPasswordScreen, { onSignIn: jest.fn(), onRequestNew: jest.fn() }));
    expect(container.querySelector('.auth-primary')).toBeNull();
    expect(container.querySelector('.auth-actions')).toBeNull();
    // :last-child is what puts the home indicator inset back under the sheet.
    const sheet = container.querySelector('.auth-sheet');
    expect(sheet.parentElement.lastElementChild).toBe(sheet);
  });

  it('Confirm your email (the page the signup link lands on)', () => {
    window.history.replaceState({}, '', `/verify-email#token=${TOKEN}`);
    const { container, getByRole } = render(React.createElement(VerifyEmailPage));
    expect(theOneFilledButton(container)).toBe(getByRole('button', { name: 'Confirm my email' }));
  });
});

describe('a button in the bar still belongs to its form', () => {
  it('Sign in submits the sign-in form: an empty one is answered, and nothing is sent', async () => {
    const { container, getByRole } = openLogin();
    const button = getByRole('button', { name: 'Sign in' });
    const form = container.querySelector('form');
    expect(button.getAttribute('type')).toBe('submit');
    // The form owner a browser resolves from form="...", which is also the
    // button Enter in a field presses (implicit submission).
    expect(button.form).toBe(form);
    expect(form.contains(button)).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(getByRole('alert').textContent).toMatch(/email address you signed up with/i));
    expect(api.login).not.toHaveBeenCalled();
  });

  it('Create account submits the sign-up form', async () => {
    const utils = openSignup();
    const button = utils.getByRole('button', { name: 'Create account' });
    expect(button.form).toBe(utils.container.querySelector('form'));
    fireEvent.click(button);
    await waitFor(() => expect(utils.getByRole('alert').textContent).toMatch(/name your friends know you by/i));
    expect(api.signup).not.toHaveBeenCalled();
  });

  it('the venue portal\'s button submits its form, on both halves', async () => {
    const utils = openVenue();
    expect(utils.getByRole('button', { name: 'Sign in' }).form).toBe(utils.container.querySelector('form'));
    fireEvent.click(utils.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toMatch(/add your email address/i));
    fireEvent.click(utils.getByRole('button', { name: 'Create an account' }));
    fireEvent.click(utils.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toMatch(/add your name/i));
    expect(api.login).not.toHaveBeenCalled();
    expect(api.signup).not.toHaveBeenCalled();
  });
});

describe('messages and links cannot move the button', () => {
  it('an error renders in the sheet, and the bar still holds only the button', async () => {
    api.login.mockRejectedValueOnce(httpError(401, 'Wrong email or password'));
    const { container, getByLabelText, getByRole } = openLogin();
    fireEvent.change(getByLabelText('Email'), { target: { value: 'sam@example.com' } });
    fireEvent.change(getByLabelText('Password'), { target: { value: 'nope' } });
    fireEvent.click(getByRole('button', { name: 'Sign in' }));
    const alert = await waitFor(() => getByRole('alert'));
    expect(alert.textContent).toBe('Wrong email or password');
    expect(alert.closest('.auth-sheet')).not.toBeNull();
    expect(alert.closest('.auth-actions')).toBeNull();
    theOneFilledButton(container);
  });

  it('the links under the form stay in the sheet', () => {
    const { container, getByRole } = openLogin();
    for (const name of ['Forgot password?', 'Create an account']) {
      const link = getByRole('button', { name });
      expect(link.closest('.auth-sheet')).not.toBeNull();
    }
    expect(container.querySelector('.auth-legal')).toBeNull();
    const signup = openSignup();
    // The consent line stays in the sheet too, ahead of the bar's button.
    expect(signup.container.querySelector('.auth-legal').closest('.auth-sheet')).not.toBeNull();
  });
});

describe('a held year step puts its Continue in the bar', () => {
  const yearAsk = () => httpError(403,
    'No Flock account yet. Add the year you were born, then tap Continue with Apple again.',
    { needsDob: true, dobGranularity: 'year' });

  it('on the sign-in screen: Continue is the one filled button, and the email form steps aside', async () => {
    asNativeIos();
    const utils = openLogin();
    mockAppleAuthorize.mockResolvedValueOnce({ response: { identityToken: 'apple-token', authorizationCode: 'apple-code', user: 'apple-user' } });
    api.appleLogin.mockRejectedValueOnce(yearAsk());
    fireEvent.click(utils.getByRole('button', { name: /continue with apple/i }));
    await waitFor(() => expect(utils.queryByRole('button', { name: /^continue$/i })).not.toBeNull());

    expect(theOneFilledButton(utils.container)).toBe(utils.getByRole('button', { name: /^continue$/i }));
    expect(utils.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(utils.container.querySelector('input[type="email"]')).toBeNull();
    // The year field is where the Apple button was, in the sheet.
    expect(utils.getByLabelText('Year of birth').closest('.auth-sheet')).not.toBeNull();

    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2000' } });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 7 } });
    fireEvent.click(utils.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(api.appleLogin).toHaveBeenCalledTimes(2));
  });

  it('a step that has lost its hold leaves the bar empty: the provider\'s own button is the way on', async () => {
    asNativeIos();
    const utils = openSignup();
    mockAppleAuthorize.mockResolvedValueOnce({ response: { identityToken: 'apple-token', authorizationCode: 'apple-code', user: 'apple-user' } });
    api.appleLogin.mockRejectedValueOnce(yearAsk());
    fireEvent.click(utils.getByRole('button', { name: /continue with apple/i }));
    await waitFor(() => expect(utils.queryByRole('button', { name: /^continue$/i })).not.toBeNull());
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2000' } });
    // The server refuses the held credentials for good (a 401 lapse).
    api.appleLogin.mockRejectedValueOnce(httpError(401, 'Apple sign-in expired.'));
    fireEvent.click(utils.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(utils.getByRole('button', { name: /continue with apple/i })).toBeTruthy());
    expect(utils.container.querySelector('.auth-primary')).toBeNull();
    expect(utils.container.querySelector('.auth-actions')).toBeNull();
  });
});

describe('the confirm screen after signing up', () => {
  const toConfirmScreen = async (onSignupSuccess = jest.fn()) => {
    api.signup.mockResolvedValueOnce({ emailVerificationRequired: true, verificationSent: true, user: { id: 5 } });
    const utils = openSignup(onSignupSuccess);
    fillSignup(utils);
    fireEvent.click(utils.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(utils.getByText('Confirm your email')).toBeTruthy());
    return utils;
  };

  it('the filled button is the way forward, and sending the link again is the outlined one in the sheet', async () => {
    const utils = await toConfirmScreen();
    expect(theOneFilledButton(utils.container)).toBe(utils.getByRole('button', { name: 'I opened the link, continue' }));
    const resend = utils.getByRole('button', { name: 'Send the link again' });
    expect(resend.className).toBe('auth-secondary');
    expect(resend.closest('.auth-sheet')).not.toBeNull();
  });

  it('the filled button checks the account and goes on when the address is confirmed', async () => {
    const onSignupSuccess = jest.fn();
    const utils = await toConfirmScreen(onSignupSuccess);
    api.getCurrentUser.mockResolvedValueOnce({ user: { id: 5, email_verified: true } });
    fireEvent.click(utils.getByRole('button', { name: 'I opened the link, continue' }));
    await waitFor(() => expect(onSignupSuccess).toHaveBeenCalledWith({ id: 5, email_verified: true }));
  });

  it('the venue portal\'s confirm screen keeps its one filled button in the bar too', async () => {
    api.signup.mockResolvedValueOnce({ emailVerificationRequired: true, verificationSent: true });
    const utils = openVenue();
    fireEvent.click(utils.getByRole('button', { name: 'Create an account' }));
    fireEvent.change(utils.getByLabelText('Your name'), { target: { value: 'Sam' } });
    fireEvent.change(utils.getByLabelText('Email'), { target: { value: 'venue@example.com' } });
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '1980' } });
    fireEvent.change(utils.getByLabelText('Password'), { target: { value: 'Password1' } });
    fireEvent.click(utils.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(utils.getByText('Confirm your email')).toBeTruthy());
    expect(theOneFilledButton(utils.container).textContent).toBe('Send the link again');
  });
});

describe('the bar rides the keyboard', () => {
  it('the keyboard\'s quantized footprint and its slack are set where the bar reads them', () => {
    // A 344px keyboard over an 844px window: 320 once rounded down to the
    // 80px step, with the step itself as slack under the button.
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 844 });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { height: 500, offsetTop: 0, addEventListener: jest.fn(), removeEventListener: jest.fn() },
    });
    let utils;
    act(() => { utils = openLogin(); });
    const root = utils.container.querySelector('.auth-root');
    expect(root.style.getPropertyValue('--kb-pad')).toBe('320px');
    expect(root.style.getPropertyValue('--kb-slack')).toBe('80px');
  });

  it('with no keyboard both are zero', () => {
    const { container } = openLogin();
    const root = container.querySelector('.auth-root');
    expect(root.style.getPropertyValue('--kb-pad')).toBe('0px');
    expect(root.style.getPropertyValue('--kb-slack')).toBe('0px');
  });

  it('the stylesheet sticks the bar to the bottom, lifted by the keyboard, and keeps the sheet from carrying the inset twice', () => {
    // A rule runs to the first brace that ends a line; the stylesheet's
    // ${AUTH...} interpolations close with a brace too, but mid-line.
    const block = (selector) => {
      const at = SHELL_SRC.indexOf(`${selector} {`);
      expect(at).toBeGreaterThan(-1);
      return SHELL_SRC.slice(at, at + SHELL_SRC.slice(at).search(/\}\r?\n/));
    };
    const bar = block('.auth-actions');
    expect(bar).toMatch(/position: sticky;/);
    expect(bar).toMatch(/bottom: calc\(var\(--cb-height, 0px\) \+ var\(--kb-pad, 0px\)\);/);
    expect(bar).toMatch(/padding: 12px 22px max\(calc\(var\(--safe-bottom\) \+ 16px\), calc\(var\(--kb-slack, 0px\) \+ 12px\)\);/);
    // Opaque, in the sheet's own colour, so the sheet scrolls under it.
    expect(bar).toMatch(/background: \$\{AUTH\.sheet\};/);
    expect(block('.auth-sheet')).not.toMatch(/--safe-bottom/);
    expect(block('.auth-sheet:last-child')).toMatch(/padding-bottom: calc\(var\(--safe-bottom\) \+ 24px\);/);
    // A field or an error a screen focuses scrolls into view above the bar.
    expect(block('.auth-root')).toMatch(/scroll-padding-bottom: calc\(var\(--kb-pad, 0px\) \+ 160px\);/);
  });
});
