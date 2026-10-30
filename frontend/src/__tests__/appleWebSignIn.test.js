/**
 * SIGN IN WITH APPLE ON THE WEBSITE.
 *
 * flockcorp.com signs in with Apple through Apple's own JS in a popup, under
 * the Services ID com.flockcorp.flock.web (grouped with the app's bundle id,
 * so an Apple ID is one Flock account on both; the server half is pinned in
 * backend/__tests__/appleWebSignIn.test.js). What is pinned here:
 *   - the button exists on the two hosts Apple has a return URL for, and on
 *     no other website host, so no preview or laptop shows a dead button;
 *   - Apple's script comes from Apple's CDN, once;
 *   - the nonce is fetched when the person reaches for the button, not on
 *     page load (the nonce route is a metered sign-in door), and the popup
 *     opens inside the tap once it is ready;
 *   - the popup is configured with the Services ID, this host's return URL,
 *     the nonce and a state, and the token goes to the server with the nonce;
 *   - a dismissed popup says nothing, a blocked one says how to fix it, and an
 *     answer whose state does not match is never posted;
 *   - a new account is asked for its year and finishes from the same popup;
 *   - on the website the screens order the ways in Apple, Google, email, and
 *     the "use the iPhone app" stopgap is gone.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=appleWebSignIn
 */

const React = require('react');
const { render, fireEvent, waitFor, act } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  // The real one, so the sign-in buttons choose their words as in the app.
  userMessage: jest.requireActual('../services/api').userMessage,
  trackAuthScreen: jest.fn(),
  login: jest.fn(),
  signup: jest.fn(),
  resendVerificationEmail: jest.fn(),
  getCurrentUser: jest.fn(),
  googleLogin: jest.fn(),
  googleLoginWithToken: jest.fn(),
  appleLogin: jest.fn(),
  getAppleNonce: jest.fn(),
  RESET_DONE_KEY: 'flock_reset_done',
}));

jest.mock('@react-oauth/google', () => ({
  useGoogleLogin: () => jest.fn(),
  GoogleOAuthProvider: ({ children }) => children,
}));

jest.mock('@capacitor-community/apple-sign-in', () => ({
  SignInWithApple: { authorize: jest.fn() },
}));

jest.mock('../components/auth/PasswordReset', () => ({
  ForgotPasswordScreen: () => null,
  ResetPasswordScreen: () => null,
  isPasswordResetRoute: () => false,
}));

const api = require('../services/api');
const appleModule = require('../components/auth/AppleSignInButton');
const AppleSignInButton = appleModule.default;
const {
  isAppleSignInAvailable, APPLE_JS_SRC, APPLE_WEB_CLIENT_ID, appleWebRedirectURI, __resetAppleWebForTests,
} = appleModule;
const LoginScreen = require('../components/auth/LoginScreen').default;
const SignupScreen = require('../components/auth/SignupScreen').default;
const VenueLoginScreen = require('../components/auth/VenueLoginScreen').default;
const { canReconfirmHere } = require('../components/auth/OAuthReconfirm');

const realLocation = window.location;
const onHost = (hostname) => {
  delete window.location;
  window.location = {
    hostname,
    host: hostname,
    origin: `https://${hostname}`,
    protocol: 'https:',
    pathname: '/app',
    search: '',
    hash: '',
    href: `https://${hostname}/app`,
  };
};

// Apple's JS, as the page sees it once appleid.auth.js has run. signIn
// answers with whatever state init was last given unless a test says not.
let appleInit;
let appleSignIn;
const installAppleJs = () => {
  appleInit = jest.fn();
  appleSignIn = jest.fn();
  window.AppleID = { auth: { init: appleInit, signIn: appleSignIn } };
};
const lastInit = () => appleInit.mock.calls[appleInit.mock.calls.length - 1][0];

// An identity token whose payload names a user identifier, which is all the
// button reads off it (for the one-delivery name rule).
const b64url = (s) => window.btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const idToken = (sub) => `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ sub }))}.sig`;

const popupAnswer = (over = {}) => async () => ({
  authorization: { id_token: idToken('apple-sub-1'), code: 'code-1', state: lastInit().state, ...over },
  user: { email: 'x@privaterelay.appleid.com', name: { firstName: 'Ada', lastName: 'Park' } },
});

const httpError = (status, message, data) => Object.assign(new Error(message), { status, data });
const yearAsk = () => httpError(403,
  'No Flock account yet. Add the year you were born, then tap Continue with Apple again.',
  { needsDob: true, dobGranularity: 'year' });

const appleButton = (utils) => utils.queryByRole('button', { name: /continue with apple/i });
const googleButton = (utils) => utils.queryByRole('button', { name: /continue with google/i });
const before = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  __resetAppleWebForTests();
  onHost('www.flockcorp.com');
  installAppleJs();
  api.getAppleNonce.mockResolvedValue({ nonce: 'n-1', expiresInSeconds: 600 });
});

afterEach(() => {
  jest.clearAllMocks();
  delete window.AppleID;
  delete window.Capacitor;
  window.location = realLocation;
  document.head.querySelectorAll(`script[src="${APPLE_JS_SRC}"]`).forEach((s) => s.remove());
});

describe('where the website draws the button', () => {
  it('draws it on flockcorp.com and www.flockcorp.com, the two hosts Apple has a return URL for', () => {
    for (const host of ['flockcorp.com', 'www.flockcorp.com']) {
      onHost(host);
      expect(isAppleSignInAvailable()).toBe(true);
      const utils = render(React.createElement(AppleSignInButton, {}));
      expect(appleButton(utils)).not.toBeNull();
      utils.unmount();
    }
  });

  it('draws nothing on any other website host, so a preview never shows a dead button', () => {
    for (const host of ['localhost', '127.0.0.1', 'flock-app-git-x.vercel.app', 'staging.flockcorp.com',
      'flockcorp.com.evil.example', 'evilflockcorp.com']) {
      onHost(host);
      expect(isAppleSignInAvailable()).toBe(false);
      const utils = render(React.createElement(AppleSignInButton, {}));
      expect(appleButton(utils)).toBeNull();
      utils.unmount();
    }
  });

  it('the return URL is the registered one for the page\'s own host', () => {
    expect(appleWebRedirectURI('www.flockcorp.com')).toBe('https://www.flockcorp.com/auth/apple/callback');
    expect(appleWebRedirectURI('flockcorp.com')).toBe('https://flockcorp.com/auth/apple/callback');
  });
});

describe('getting the popup ready', () => {
  it("loads Apple's script from Apple's CDN once, however many buttons are drawn", () => {
    delete window.AppleID;
    render(React.createElement('div', null,
      React.createElement(AppleSignInButton, { key: 'a' }),
      React.createElement(AppleSignInButton, { key: 'b' })));
    const scripts = document.head.querySelectorAll('script');
    const apple = [...scripts].filter((s) => s.src === APPLE_JS_SRC);
    expect(apple).toHaveLength(1);
    expect(APPLE_JS_SRC).toBe('https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js');
  });

  it('fetches the nonce when the person reaches for the button, not when the page loads, and only once', async () => {
    const utils = render(React.createElement(AppleSignInButton, {}));
    await flush();
    expect(api.getAppleNonce).not.toHaveBeenCalled();
    fireEvent.pointerDown(appleButton(utils));
    fireEvent.focus(appleButton(utils));
    await flush();
    expect(api.getAppleNonce).toHaveBeenCalledTimes(1);
  });
});

describe('a tap', () => {
  it('opens Apple\'s popup with the Services ID, this host\'s return URL, the nonce and a state, then posts the token with the nonce', async () => {
    const onSuccess = jest.fn();
    const utils = render(React.createElement(AppleSignInButton, { onSuccess }));
    fireEvent.pointerDown(appleButton(utils));
    await flush();
    appleSignIn.mockImplementation(popupAnswer());
    api.appleLogin.mockResolvedValueOnce({ user: { id: 7 } });

    fireEvent.click(appleButton(utils));
    // Inside the tap: nothing is awaited before Apple's window is asked for.
    expect(appleSignIn).toHaveBeenCalledTimes(1);
    expect(lastInit()).toEqual({
      clientId: APPLE_WEB_CLIENT_ID,
      scope: 'name email',
      redirectURI: 'https://www.flockcorp.com/auth/apple/callback',
      state: expect.stringMatching(/^[0-9a-f]{32}$/),
      nonce: 'n-1',
      usePopup: true,
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ id: 7 }));
    expect(api.appleLogin).toHaveBeenCalledWith(
      idToken('apple-sub-1'), { givenName: 'Ada', familyName: 'Park' }, 'code-1', undefined, { nonce: 'n-1' },
    );
  });

  it('on the apex host the return URL is the apex one', async () => {
    onHost('flockcorp.com');
    const utils = render(React.createElement(AppleSignInButton, {}));
    appleSignIn.mockImplementation(popupAnswer());
    api.appleLogin.mockResolvedValueOnce({ user: { id: 1 } });
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(appleInit).toHaveBeenCalled());
    expect(lastInit().redirectURI).toBe('https://flockcorp.com/auth/apple/callback');
  });

  it('without the warm-up the tap fetches the nonce first and then opens the popup', async () => {
    const utils = render(React.createElement(AppleSignInButton, {}));
    appleSignIn.mockImplementation(popupAnswer());
    api.appleLogin.mockResolvedValueOnce({ user: { id: 2 } });
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(api.appleLogin).toHaveBeenCalled());
    expect(api.getAppleNonce).toHaveBeenCalledTimes(1);
    expect(lastInit().nonce).toBe('n-1');
    expect(api.appleLogin.mock.calls[0][4]).toEqual({ nonce: 'n-1' });
  });

  it('a closed popup says nothing and keeps the nonce for the next tap', async () => {
    const onError = jest.fn();
    const utils = render(React.createElement(AppleSignInButton, { onError }));
    appleSignIn.mockRejectedValueOnce({ error: 'popup_closed_by_user' });
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(appleSignIn).toHaveBeenCalledTimes(1));
    await flush();
    expect(onError).not.toHaveBeenCalled();
    expect(api.appleLogin).not.toHaveBeenCalled();

    appleSignIn.mockImplementation(popupAnswer());
    api.appleLogin.mockResolvedValueOnce({ user: { id: 3 } });
    fireEvent.click(appleButton(utils));
    expect(appleSignIn).toHaveBeenCalledTimes(2);
    expect(lastInit().nonce).toBe('n-1');
    expect(api.getAppleNonce).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.appleLogin).toHaveBeenCalled());
  });

  it('a blocked popup says how to fix it', async () => {
    const onError = jest.fn();
    const utils = render(React.createElement(AppleSignInButton, { onError }));
    appleSignIn.mockRejectedValueOnce({ error: 'popup_blocked_by_browser' });
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0]).toMatch(/allow pop-ups for this site, then tap Continue with Apple again/);
    expect(onError.mock.calls[0][0]).not.toMatch(/—/);
    expect(api.appleLogin).not.toHaveBeenCalled();
  });

  it('an answer that does not carry the state it was sent with is never posted', async () => {
    const onError = jest.fn();
    const utils = render(React.createElement(AppleSignInButton, { onError }));
    appleSignIn.mockImplementation(popupAnswer({ state: 'somebody-else' }));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(api.appleLogin).not.toHaveBeenCalled();
    expect(onError.mock.calls[0][0]).toMatch(/Tap Continue with Apple again/);
  });

  it("when Apple's script cannot load, it says to check the connection", async () => {
    delete window.AppleID;
    const onError = jest.fn();
    const utils = render(React.createElement(AppleSignInButton, { onError }));
    fireEvent.click(appleButton(utils));
    const script = [...document.head.querySelectorAll('script')].find((s) => s.src === APPLE_JS_SRC);
    act(() => { script.onerror(); });
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0]).toMatch(/didn't load\. Check your connection/);
  });

  it('the delete and export dialogs can confirm an Apple account on the website too', () => {
    expect(canReconfirmHere('apple')).toBe(true);
    onHost('localhost');
    expect(canReconfirmHere('apple')).toBe(false);
  });
});

describe('a new account from the website', () => {
  it('is asked for its year where the button was, and Continue finishes it from the same popup', async () => {
    const onLoginSuccess = jest.fn();
    const utils = render(React.createElement(LoginScreen, {
      onLoginSuccess, onSwitchToSignup: jest.fn(), onSwitchToVenueLogin: jest.fn(),
    }));
    appleSignIn.mockImplementation(popupAnswer());
    api.appleLogin.mockRejectedValueOnce(yearAsk());
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(utils.queryByRole('button', { name: /^continue$/i })).not.toBeNull());

    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '2000' } });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 9 } });
    fireEvent.click(utils.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledWith({ id: 9 }));

    expect(appleSignIn).toHaveBeenCalledTimes(1);
    const [first, second] = api.appleLogin.mock.calls;
    expect(second.slice(0, 3)).toEqual(first.slice(0, 3));
    expect(second[3]).toBe('2000-12-31');
    expect(second[4]).toEqual({ dobGranularity: 'year', nonce: 'n-1' });
  });
});

describe('the order of the ways in', () => {
  const emailField = (utils) => utils.container.querySelector('input[type="email"]');

  it('the sign-in screen offers Apple, then Google, then email, and names Apple in its hint', () => {
    const utils = render(React.createElement(LoginScreen, {
      onLoginSuccess: jest.fn(), onSwitchToSignup: jest.fn(), onSwitchToVenueLogin: jest.fn(),
    }));
    expect(before(appleButton(utils), googleButton(utils))).toBe(true);
    expect(before(googleButton(utils), emailField(utils))).toBe(true);
    expect(utils.getByText('or sign in with email')).toBeTruthy();
    expect(utils.getByText('Signed up with Google or Apple? Use that button.')).toBeTruthy();
    expect(utils.container.textContent).not.toMatch(/iPhone app/);
  });

  it('the sign-up screen offers Apple, then Google, then email', () => {
    const utils = render(React.createElement(SignupScreen, { onSignupSuccess: jest.fn(), onSwitchToLogin: jest.fn() }));
    expect(before(appleButton(utils), googleButton(utils))).toBe(true);
    expect(before(googleButton(utils), emailField(utils))).toBe(true);
    expect(utils.getByText('or sign up with email')).toBeTruthy();
  });

  it('the venue portal offers Apple, then Google, then email, on both halves', () => {
    const utils = render(React.createElement(VenueLoginScreen, { onLoginSuccess: jest.fn(), onSwitchToUserLogin: jest.fn() }));
    expect(before(appleButton(utils), googleButton(utils))).toBe(true);
    expect(before(googleButton(utils), emailField(utils))).toBe(true);
    expect(utils.getByText('Signed up with Google or Apple? Use that button.')).toBeTruthy();
    expect(utils.container.textContent).not.toMatch(/iPhone app/);

    fireEvent.click(utils.getByRole('button', { name: 'Create an account' }));
    expect(before(appleButton(utils), googleButton(utils))).toBe(true);
    expect(before(googleButton(utils), emailField(utils))).toBe(true);
    expect(utils.getByText('or sign up with email')).toBeTruthy();
    // The agreement is on screen above every button that creates an account.
    expect(before(utils.container.querySelector('.auth-legal'), appleButton(utils))).toBe(true);
  });

  it('while a year step is open the email form steps aside, and one tap brings it back', async () => {
    const utils = render(React.createElement(LoginScreen, {
      onLoginSuccess: jest.fn(), onSwitchToSignup: jest.fn(), onSwitchToVenueLogin: jest.fn(),
    }));
    appleSignIn.mockImplementation(popupAnswer());
    api.appleLogin.mockRejectedValueOnce(yearAsk());
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(utils.queryByRole('button', { name: /^continue$/i })).not.toBeNull());
    expect(emailField(utils)).toBeNull();
    expect(utils.queryByText('Signed up with Google or Apple? Use that button.')).toBeNull();
    fireEvent.click(utils.getByRole('button', { name: 'Sign in with email instead' }));
    expect(emailField(utils)).not.toBeNull();
    expect(appleButton(utils)).not.toBeNull();
  });

  it('off the registered hosts the screens keep the layout they had, and the hint names no app', () => {
    onHost('localhost');
    const utils = render(React.createElement(LoginScreen, {
      onLoginSuccess: jest.fn(), onSwitchToSignup: jest.fn(), onSwitchToVenueLogin: jest.fn(),
    }));
    expect(appleButton(utils)).toBeNull();
    expect(before(emailField(utils), googleButton(utils))).toBe(true);
    expect(utils.getByText('Signed up with Google? Use that button.')).toBeTruthy();
    expect(utils.container.textContent).not.toMatch(/iPhone app/);
  });
});

describe('registration says what it needs before it needs it', () => {
  const fs = require('fs');
  const path = require('path');

  it('the sign-up screen shows every password rule before anything is typed', () => {
    onHost('localhost');
    const utils = render(React.createElement(SignupScreen, { onSignupSuccess: jest.fn(), onSwitchToLogin: jest.fn() }));
    expect(utils.getByLabelText('Password').value).toBe('');
    const rules = utils.container.querySelector('ul[aria-label="Password requirements"]');
    expect(rules).not.toBeNull();
    expect([...rules.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '8 characters, not met yet', 'One uppercase letter, not met yet', 'One number, not met yet',
    ]);
  });

  it('so does the venue portal when an owner creates an account, and its field carries the rule', () => {
    onHost('localhost');
    const utils = render(React.createElement(VenueLoginScreen, { onLoginSuccess: jest.fn(), onSwitchToUserLogin: jest.fn() }));
    expect(utils.container.querySelector('ul[aria-label="Password requirements"]')).toBeNull();
    fireEvent.click(utils.getByRole('button', { name: 'Create an account' }));
    const rules = utils.container.querySelector('ul[aria-label="Password requirements"]');
    expect(rules).not.toBeNull();
    expect(rules.querySelectorAll('li')).toHaveLength(3);
    const field = utils.getByLabelText('Password');
    expect(document.getElementById(field.getAttribute('aria-describedby')).textContent)
      .toMatch(/at least 8 characters, with one uppercase letter and one number/);
  });

  it('the confirm-your-email screens name the address the server really sends from', () => {
    // sendVerificationEmail takes sendEmail's default sender; if either moves,
    // the sentence on the screen sends people looking for the wrong address.
    const backend = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'backend', 'services', 'emailService.js'), 'utf8');
    expect(backend).toMatch(/from = 'Flock <social@flockcorp\.com>'/);
    const verification = backend.slice(backend.indexOf('async function sendVerificationEmail'));
    expect(verification.slice(0, verification.indexOf('\n}\n'))).not.toMatch(/\bfrom:/);
    for (const screen of ['SignupScreen.js', 'VenueLoginScreen.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'components', 'auth', screen), 'utf8');
      expect([screen, src.includes('It comes from social@flockcorp.com.')]).toEqual([screen, true]);
    }
  });

  it('no auth screen puts an em dash in front of a person', () => {
    // Comments may keep theirs; what renders may not. Every quoted string and
    // every JSX text run in the five auth files is checked.
    for (const file of ['LoginScreen.js', 'SignupScreen.js', 'VenueLoginScreen.js', 'AppleSignInButton.js', 'AppleYearStep.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'components', 'auth', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const strings = src.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`|>[^<>{}\n]+</g) || [];
      const dashed = strings.filter((s) => s.includes('\u2014'));
      expect([file, dashed]).toEqual([file, []]);
    }
  });
});
