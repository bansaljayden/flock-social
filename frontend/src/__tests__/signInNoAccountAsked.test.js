/**
 * THE SIGN-IN SCREEN NEVER MAKES A NEW ACCOUNT BY SURPRISE.
 *
 * Somebody whose Flock account was made with Google tapped Continue with Apple
 * on the sign-in screen, with Hide My Email. The server made a second, empty
 * account for that Apple ID and the app opened it with no word that it was
 * new. Now the sign-in screen sends intent 'signin', the server answers a
 * credential with no account behind it 409 {noAccount, canCreate} and writes
 * nothing, and the screen asks: "No Flock account yet", with Create account
 * (the same credential again, intent 'create') and Not now. The sign-up
 * screen sends 'create'.
 *
 * Pinned here:
 *   F  the intents each screen sends; the panel; Create account sends the SAME
 *      credential with intent 'create' and signs in, with no second sheet; Not
 *      now forgets it; on the website a create still gets the year step and
 *      finishes; past the proof's five minutes the app reopens its sheet, and
 *      the website's Google button comes back with a line saying so; a create
 *      that does not finish leaves 'create' on no later tap, except the one
 *      tap a line sends the person back to, and the email form forgets that;
 *   G  a new tap with either provider clears the last error, the panel and the
 *      other provider's year step, so a dismissed sheet leaves the screen clean;
 *   H  a Google sheet in the app dismissed after more than three seconds gets
 *      a quiet hint (Google may have blocked the account), a quick one nothing;
 *   I  Apple's error 1000 names iCloud; 1001 stays silent;
 *   and services/api.js puts the intent in the request body.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false --testPathPattern=signInNoAccountAsked
 */

const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  // The real one, so the buttons choose their words as in the app.
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

// The web half: hands the config back so a test can fire the success
// callback the real library would fire, with no popup.
const mockWebStart = jest.fn();
jest.mock('@react-oauth/google', () => ({
  GoogleOAuthProvider: ({ children }) => children,
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

// The forgot-password screen is only its way back here, so a test can leave
// the sign-in screen for it and return.
jest.mock('../components/auth/PasswordReset', () => {
  const mockReact = require('react');
  return {
    ForgotPasswordScreen: ({ onBack }) => mockReact.createElement('button', { type: 'button', onClick: onBack }, 'Back to sign in'),
    ResetPasswordScreen: () => null,
    isPasswordResetRoute: () => false,
  };
});

// The web Google flow exists only in a build that carries a client id
// (useGoogleAuth reads it once, at load), so these load the module as one.
process.env.REACT_APP_GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID || 'web-client.apps.googleusercontent.com';
const api = require('../services/api');
const LoginScreen = require('../components/auth/LoginScreen').default;
const SignupScreen = require('../components/auth/SignupScreen').default;
const AppleSignInButton = require('../components/auth/AppleSignInButton').default;
const { __resetAppleWebForTests } = require('../components/auth/AppleSignInButton');

const ENV = ['REACT_APP_GOOGLE_IOS_CLIENT_ID', 'REACT_APP_GOOGLE_CLIENT_ID'];
let savedEnv;

const serverSays = (status, message, data = {}) => Object.assign(new Error(message), { status, data, userFacing: true });
const noAccount = (provider) => serverSays(409,
  provider === 'apple' ? 'No Flock account uses this Apple ID yet.' : 'No Flock account uses this Google account yet.',
  { error: 'x', noAccount: true, canCreate: true });
const yearAsk = (provider = 'Google') => serverSays(403,
  `No Flock account yet. Add the year you were born, then tap Continue with ${provider} again.`,
  { needsDob: true, dobGranularity: 'year' });

const SHEET = { identityToken: 'apple-id-token-1', authorizationCode: 'apple-code-1', user: 'apple-user-1' };
const appleSheetGives = (over = {}) => mockAppleAuthorize.mockResolvedValueOnce({ response: { ...SHEET, ...over } });
const googleSheetGives = (idToken = 'google-id-token-1') => {
  mockSocialLogin.login.mockResolvedValueOnce({ provider: 'google', result: { idToken, responseType: 'online' } });
};

const asNativeIos = () => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }; };

const openLogin = () => {
  const onLoginSuccess = jest.fn();
  const utils = render(React.createElement(LoginScreen, {
    onLoginSuccess, onSwitchToSignup: jest.fn(), onSwitchToVenueLogin: jest.fn(),
  }));
  return { ...utils, onLoginSuccess };
};
const openSignup = () => {
  const onSignupSuccess = jest.fn();
  const utils = render(React.createElement(SignupScreen, { onSignupSuccess, onSwitchToLogin: jest.fn() }));
  return { ...utils, onSignupSuccess };
};

const appleButton = (utils) => utils.queryByRole('button', { name: /continue with apple/i });
const googleButton = (utils) => utils.queryByRole('button', { name: /continue with google/i });
const createButton = (utils) => utils.queryByRole('button', { name: 'Create account' });
const notNowButton = (utils) => utils.queryByRole('button', { name: 'Not now' });
const panel = (utils) => utils.container.querySelector('#login-no-account');

const APPLE_PANEL_TEXT = 'No account uses this Apple ID. Make a new one, or sign in the way you made your account.';
const GOOGLE_PANEL_TEXT = 'No account uses this Google account. Make a new one, or sign in the way you made your account.';
const HINT = "Google didn't let you in? School accounts are often blocked. Use Apple, email, or a personal Google account.";

beforeEach(() => {
  savedEnv = ENV.map((k) => process.env[k]);
  process.env.REACT_APP_GOOGLE_IOS_CLIENT_ID = 'ios-client.apps.googleusercontent.com';
  process.env.REACT_APP_GOOGLE_CLIENT_ID = 'web-client.apps.googleusercontent.com';
  mockSocialLogin.initialize.mockResolvedValue(undefined);
  // The buttons log what they keep off the screen; quiet here.
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  __resetAppleWebForTests();
});

afterEach(() => {
  ENV.forEach((k, i) => { if (savedEnv[i] === undefined) delete process.env[k]; else process.env[k] = savedEnv[i]; });
  jest.restoreAllMocks();
  jest.clearAllMocks();
  mockAppleAuthorize.mockReset();
  mockSocialLogin.login.mockReset();
  delete window.Capacitor;
});

// ---------------------------------------------------------------------------
// F. Which intent each screen sends.
// ---------------------------------------------------------------------------
describe('F: the sign-in screen asks to sign in, the sign-up screen to create', () => {
  it('sign-in: Continue with Apple and Continue with Google send intent signin', async () => {
    asNativeIos();
    const utils = openLogin();
    appleSheetGives();
    api.appleLogin.mockResolvedValueOnce({ user: { id: 1 } });
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 1 }));
    expect(api.appleLogin.mock.calls[0][4]).toEqual({ intent: 'signin' });

    googleSheetGives();
    api.googleLogin.mockResolvedValueOnce({ user: { id: 2 } });
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 2 }));
    expect(api.googleLogin).toHaveBeenCalledWith('google-id-token-1', undefined, { intent: 'signin' });
  });

  it('sign-up: Continue with Apple and Continue with Google send intent create', async () => {
    asNativeIos();
    const utils = openSignup();
    appleSheetGives();
    api.appleLogin.mockResolvedValueOnce({ user: { id: 3 } });
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(utils.onSignupSuccess).toHaveBeenCalledWith({ id: 3 }));
    expect(api.appleLogin.mock.calls[0][4]).toEqual({ intent: 'create' });

    googleSheetGives();
    api.googleLogin.mockResolvedValueOnce({ user: { id: 4 } });
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.onSignupSuccess).toHaveBeenCalledWith({ id: 4 }));
    expect(api.googleLogin).toHaveBeenCalledWith('google-id-token-1', undefined, { intent: 'create' });
  });
});

// ---------------------------------------------------------------------------
// F. The panel, and what its two buttons do.
// ---------------------------------------------------------------------------
describe('F: no account behind the credential, on the sign-in screen', () => {
  const appleNoAccount = async (utils) => {
    appleSheetGives();
    api.appleLogin.mockRejectedValueOnce(noAccount('apple'));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(createButton(utils)).not.toBeNull());
  };
  const googleNoAccount = async (utils) => {
    googleSheetGives();
    api.googleLogin.mockRejectedValueOnce(noAccount('google'));
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(createButton(utils)).not.toBeNull());
  };

  it('Apple: shows the panel in place of the error line, focused, and makes nothing', async () => {
    asNativeIos();
    const utils = openLogin();
    await appleNoAccount(utils);
    expect(utils.getByRole('heading', { name: 'No Flock account yet' })).toBeTruthy();
    expect(utils.getByText(APPLE_PANEL_TEXT)).toBeTruthy();
    expect(notNowButton(utils)).not.toBeNull();
    expect(utils.queryByRole('alert')).toBeNull();
    expect(utils.container.textContent).not.toContain('No Flock account uses this Apple ID yet.');
    expect(document.activeElement).toBe(panel(utils));
    expect(utils.getByRole('group', { name: 'No Flock account yet' })).toBe(panel(utils));
    expect(utils.onLoginSuccess).not.toHaveBeenCalled();
    expect(api.appleLogin).toHaveBeenCalledTimes(1);
  });

  it('Apple: Create account sends the SAME credentials with intent create, opens no second sheet, and signs in', async () => {
    asNativeIos();
    const utils = openLogin();
    await appleNoAccount(utils);
    api.appleLogin.mockResolvedValueOnce({ user: { id: 11 }, created: true });
    fireEvent.click(createButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 11 }));
    expect(mockAppleAuthorize).toHaveBeenCalledTimes(1);
    expect(api.appleLogin).toHaveBeenCalledTimes(2);
    const [first, second] = api.appleLogin.mock.calls;
    expect(second.slice(0, 3)).toEqual(first.slice(0, 3));
    expect(second[0]).toBe('apple-id-token-1');
    expect(second[2]).toBe('apple-code-1');
    expect(second[4]).toEqual({ intent: 'create' });
  });

  it('Google: the panel names Google, and Create account sends the SAME token with intent create', async () => {
    asNativeIos();
    const utils = openLogin();
    await googleNoAccount(utils);
    expect(utils.getByText(GOOGLE_PANEL_TEXT)).toBeTruthy();
    api.googleLogin.mockResolvedValueOnce({ user: { id: 12 }, created: true });
    fireEvent.click(createButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 12 }));
    expect(mockSocialLogin.login).toHaveBeenCalledTimes(1);
    expect(api.googleLogin.mock.calls[1]).toEqual(['google-id-token-1', undefined, { intent: 'create' }]);
  });

  it('Not now closes the panel and forgets the credentials; the next tap asks to sign in again', async () => {
    asNativeIos();
    const utils = openLogin();
    await appleNoAccount(utils);
    fireEvent.click(notNowButton(utils));
    expect(panel(utils)).toBeNull();
    expect(createButton(utils)).toBeNull();
    expect(utils.queryByRole('alert')).toBeNull();
    expect(api.appleLogin).toHaveBeenCalledTimes(1);

    appleSheetGives({ identityToken: 'apple-id-token-2' });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 13 } });
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 13 }));
    expect(api.appleLogin.mock.calls[1][0]).toBe('apple-id-token-2');
    expect(api.appleLogin.mock.calls[1][4]).toEqual({ intent: 'signin' });
  });

  it('a server sentence on the create (an address another account uses) is shown as written', async () => {
    asNativeIos();
    const utils = openLogin();
    await appleNoAccount(utils);
    const SAYS = 'This email already has a Flock account that signs in with Google. Use Continue with Google.';
    api.appleLogin.mockRejectedValueOnce(serverSays(409, SAYS, { signInWith: 'google' }));
    fireEvent.click(createButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(SAYS));
    expect(panel(utils)).toBeNull();
    expect(utils.onLoginSuccess).not.toHaveBeenCalled();
  });

  it('past the proof\'s five minutes, the app\'s Create account opens Apple\'s sheet again and creates with the new one', async () => {
    asNativeIos();
    const utils = openLogin();
    const t0 = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
    await appleNoAccount(utils);

    clock.mockReturnValue(t0 + 10 * 60 * 1000);
    appleSheetGives({ identityToken: 'apple-id-token-2', authorizationCode: 'apple-code-2' });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 14 }, created: true });
    fireEvent.click(createButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 14 }));
    expect(mockAppleAuthorize).toHaveBeenCalledTimes(2);
    const second = api.appleLogin.mock.calls[1];
    expect(second[0]).toBe('apple-id-token-2');
    expect(second[2]).toBe('apple-code-2');
    expect(second[4]).toEqual({ intent: 'create' });
  });

  it('the same for Google in the app: past the minutes, a new sheet, and its token goes with intent create', async () => {
    asNativeIos();
    const utils = openLogin();
    const t0 = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
    await googleNoAccount(utils);

    clock.mockReturnValue(t0 + 10 * 60 * 1000);
    googleSheetGives('google-id-token-2');
    api.googleLogin.mockResolvedValueOnce({ user: { id: 15 }, created: true });
    fireEvent.click(createButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 15 }));
    expect(mockSocialLogin.login).toHaveBeenCalledTimes(2);
    expect(api.googleLogin.mock.calls[1]).toEqual(['google-id-token-2', undefined, { intent: 'create' }]);
  });
});

describe('F: the website', () => {
  const webNoAccount = async (utils) => {
    api.googleLoginWithToken.mockRejectedValueOnce(noAccount('google'));
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(createButton(utils)).not.toBeNull());
  };

  it('a create is asked for its year, and the year step finishes the account from the same popup', async () => {
    const utils = openLogin();
    await webNoAccount(utils);
    // The agreement is on screen while Create account is offered.
    expect(utils.container.querySelector('.auth-legal')).not.toBeNull();

    api.googleLoginWithToken.mockRejectedValueOnce(yearAsk());
    fireEvent.click(createButton(utils));
    await waitFor(() => expect(utils.getByLabelText('Year of birth').id).toBe('login-google-year'));
    expect(panel(utils)).toBeNull();
    expect(utils.queryByRole('alert')).toBeNull();
    expect(api.googleLoginWithToken.mock.calls[1]).toEqual(['web-access-token', undefined, { intent: 'create' }]);

    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '1999' } });
    api.googleLoginWithToken.mockResolvedValueOnce({ user: { id: 21 }, created: true });
    fireEvent.click(utils.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 21 }));
    expect(mockWebStart).toHaveBeenCalledTimes(1);
    expect(api.googleLoginWithToken.mock.calls[2])
      .toEqual(['web-access-token', '1999-12-31', { dobGranularity: 'year', intent: 'create' }]);
  });

  it('past the minutes, Create account waits on no popup: the line says to tap Google, and that tap creates', async () => {
    const utils = openLogin();
    const t0 = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
    await webNoAccount(utils);

    clock.mockReturnValue(t0 + 10 * 60 * 1000);
    fireEvent.click(createButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe('Tap Continue with Google to make your account.'));
    expect(api.googleLoginWithToken).toHaveBeenCalledTimes(1);
    expect(mockWebStart).toHaveBeenCalledTimes(1);
    expect(panel(utils)).toBeNull();

    api.googleLoginWithToken.mockResolvedValueOnce({ user: { id: 22 }, created: true });
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 22 }));
    expect(api.googleLoginWithToken.mock.calls[1]).toEqual(['web-access-token', undefined, { intent: 'create' }]);
  });
});

// ---------------------------------------------------------------------------
// F. A Create account that does not finish leaves 'create' on no later tap.
//
// It used to: the screen remembered 'create' from the moment Create account
// was tapped, so a create that failed (a server error, the unconfirmed-account
// warning) left every later tap of that button sending 'create', for whichever
// Google account or Apple ID its sheet returned, and the server made that one
// an empty account with no question. The one tap a line sends the person back
// to ("tap Continue with Google again") still sends 'create', and when that
// tap is answered with the same line, so does the one after it; no other tap
// does, and leaving for the email form forgets it.
// ---------------------------------------------------------------------------
describe("F: a create that does not finish leaves no 'create' behind", () => {
  const UNCONFIRMED = {
    google: 'This email already has a Flock account that was never confirmed. To keep its friends and plans, sign in with its email and password. To start a new account with Google instead, tap Continue with Google again.',
    apple: 'This email already has a Flock account that was never confirmed. To keep its friends and plans, sign in with its email and password. To start a new account with Apple instead, tap Continue with Apple again.',
  };
  const warned = (provider) => serverSays(409, UNCONFIRMED[provider], { error: UNCONFIRMED[provider], unconfirmedAccount: true });
  const cancelled = () => Object.assign(new Error('The user canceled the sign-in flow.'), { code: 'USER_CANCELLED' });
  const APPLE_DISMISSED = "The operation couldn't be completed. (com.apple.AuthenticationServices.AuthorizationError error 1001.)";

  const googlePanel = async (utils, idToken) => {
    googleSheetGives(idToken);
    api.googleLogin.mockRejectedValueOnce(noAccount('google'));
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(createButton(utils)).not.toBeNull());
  };
  const applePanel = async (utils) => {
    appleSheetGives();
    api.appleLogin.mockRejectedValueOnce(noAccount('apple'));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(createButton(utils)).not.toBeNull());
  };
  // Create account, answered with `refusal`; the panel closes and the line
  // shows what the server said.
  const createRefused = async (utils, provider, refusal) => {
    (provider === 'apple' ? api.appleLogin : api.googleLogin).mockRejectedValueOnce(refusal);
    fireEvent.click(createButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(refusal.message));
    expect(panel(utils)).toBeNull();
  };
  // The next Google tap's sheet returns a different Google account, which has
  // no Flock account either: it must be asked about, not made.
  const nextGoogleTapAsks = async (utils, call) => {
    googleSheetGives('google-id-token-b');
    api.googleLogin.mockRejectedValueOnce(noAccount('google'));
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(api.googleLogin).toHaveBeenCalledTimes(call + 1));
    expect(api.googleLogin.mock.calls[call]).toEqual(['google-id-token-b', undefined, { intent: 'signin' }]);
    await waitFor(() => expect(createButton(utils)).not.toBeNull());
    expect(utils.getByText(GOOGLE_PANEL_TEXT)).toBeTruthy();
    expect(utils.onLoginSuccess).not.toHaveBeenCalled();
  };

  it('Google: a create the server refuses leaves the next tap asking, for whichever account its sheet returns', async () => {
    asNativeIos();
    const utils = openLogin();
    await googlePanel(utils, 'google-id-token-a');
    await createRefused(utils, 'google', serverSays(500, 'Something went wrong on our end. Try again.'));
    await nextGoogleTapAsks(utils, 2);
  });

  it('Apple: the same, and the next sheet\'s Apple ID is asked about too', async () => {
    asNativeIos();
    const utils = openLogin();
    await applePanel(utils);
    await createRefused(utils, 'apple', serverSays(500, 'Something went wrong on our end. Try again.'));

    appleSheetGives({ identityToken: 'apple-id-token-2', authorizationCode: 'apple-code-2', user: 'apple-user-2' });
    api.appleLogin.mockRejectedValueOnce(noAccount('apple'));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(api.appleLogin).toHaveBeenCalledTimes(3));
    expect(api.appleLogin.mock.calls[2][0]).toBe('apple-id-token-2');
    expect(api.appleLogin.mock.calls[2][4]).toEqual({ intent: 'signin' });
    await waitFor(() => expect(createButton(utils)).not.toBeNull());
    expect(utils.onLoginSuccess).not.toHaveBeenCalled();
  });

  it('the unconfirmed-account warning says to tap again, and that one tap starts the new account', async () => {
    asNativeIos();
    const utils = openLogin();
    await googlePanel(utils, 'google-id-token-a');
    await createRefused(utils, 'google', warned('google'));

    googleSheetGives('google-id-token-a2');
    api.googleLogin.mockResolvedValueOnce({ user: { id: 31 }, created: true });
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 31 }));
    expect(api.googleLogin.mock.calls[2]).toEqual(['google-id-token-a2', undefined, { intent: 'create' }]);
  });

  // The server remembers its warning for ten minutes (WARNED_EVICTION_TTL_MS
  // in backend/routes/auth.js). A tap past that is warned again, in the same
  // words, and they again say one more tap starts the new account. That tap
  // used to send 'signin', because the warning only kept 'create' when it
  // answered Create account, and it reopened the panel instead.
  it('Google: the warning answered to that tap itself keeps the next tap starting over', async () => {
    asNativeIos();
    const utils = openLogin();
    await googlePanel(utils, 'google-id-token-a');
    await createRefused(utils, 'google', warned('google'));

    googleSheetGives('google-id-token-a2');
    api.googleLogin.mockRejectedValueOnce(warned('google'));
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(api.googleLogin).toHaveBeenCalledTimes(3));
    expect(api.googleLogin.mock.calls[2]).toEqual(['google-id-token-a2', undefined, { intent: 'create' }]);
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNCONFIRMED.google));
    expect(panel(utils)).toBeNull();

    googleSheetGives('google-id-token-a3');
    api.googleLogin.mockResolvedValueOnce({ user: { id: 32 }, created: true });
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 32 }));
    expect(api.googleLogin.mock.calls[3]).toEqual(['google-id-token-a3', undefined, { intent: 'create' }]);
    expect(panel(utils)).toBeNull();
  });

  it('Apple: the same, the warning answered to the Apple tap keeps the next one starting over', async () => {
    asNativeIos();
    const utils = openLogin();
    await applePanel(utils);
    await createRefused(utils, 'apple', warned('apple'));

    appleSheetGives({ identityToken: 'apple-id-token-2', authorizationCode: 'apple-code-2' });
    api.appleLogin.mockRejectedValueOnce(warned('apple'));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(api.appleLogin).toHaveBeenCalledTimes(3));
    expect(api.appleLogin.mock.calls[2][4]).toEqual({ intent: 'create' });
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNCONFIRMED.apple));
    expect(panel(utils)).toBeNull();

    appleSheetGives({ identityToken: 'apple-id-token-3', authorizationCode: 'apple-code-3' });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 33 }, created: true });
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 33 }));
    expect(api.appleLogin.mock.calls[3][0]).toBe('apple-id-token-3');
    expect(api.appleLogin.mock.calls[3][4]).toEqual({ intent: 'create' });
    expect(panel(utils)).toBeNull();
  });

  // The website asks a create for its year first, so there the warning
  // answers the year step's Continue and is shown in the step, and the tap it
  // sends the person back to is the Google button under it.
  it('the website: warned after the year step and again on that tap, the next tap still starts over', async () => {
    const utils = openLogin();
    api.googleLoginWithToken.mockRejectedValueOnce(noAccount('google'));
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(createButton(utils)).not.toBeNull());
    api.googleLoginWithToken.mockRejectedValueOnce(yearAsk());
    fireEvent.click(createButton(utils));
    await waitFor(() => expect(utils.getByLabelText('Year of birth').id).toBe('login-google-year'));
    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '1999' } });
    api.googleLoginWithToken.mockRejectedValueOnce(warned('google'));
    fireEvent.click(utils.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNCONFIRMED.google));

    const yearCreate = ['web-access-token', '1999-12-31', { dobGranularity: 'year', intent: 'create' }];
    api.googleLoginWithToken.mockRejectedValueOnce(warned('google'));
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(api.googleLoginWithToken).toHaveBeenCalledTimes(4));
    expect(api.googleLoginWithToken.mock.calls[3]).toEqual(yearCreate);
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNCONFIRMED.google));

    api.googleLoginWithToken.mockResolvedValueOnce({ user: { id: 34 }, created: true });
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 34 }));
    expect(api.googleLoginWithToken.mock.calls[4]).toEqual(yearCreate);
    expect(mockWebStart).toHaveBeenCalledTimes(3);
  });

  // Past the popup's five minutes the website's Create account sends the
  // person to the Google button ("Tap Continue with Google to make your
  // account."), and that tap's 'create' is asked for the year, so the year
  // step it opens is the button's own. A warning answered to that step's
  // Continue says to tap Continue with Google again, and that tap used to send
  // 'signin' and reopen the no-account panel: the step had kept nothing of
  // the 'create' its tap spent.
  it('the website: a year step the Google button itself opened keeps its next tap starting over', async () => {
    const utils = openLogin();
    const t0 = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
    api.googleLoginWithToken.mockRejectedValueOnce(noAccount('google'));
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(createButton(utils)).not.toBeNull());

    clock.mockReturnValue(t0 + 10 * 60 * 1000);
    fireEvent.click(createButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe('Tap Continue with Google to make your account.'));

    api.googleLoginWithToken.mockRejectedValueOnce(yearAsk());
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.getByLabelText('Year of birth').id).toBe('login-google-year'));
    expect(api.googleLoginWithToken.mock.calls[1]).toEqual(['web-access-token', undefined, { intent: 'create' }]);

    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '1999' } });
    api.googleLoginWithToken.mockRejectedValueOnce(warned('google'));
    fireEvent.click(utils.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNCONFIRMED.google));

    const yearCreate = ['web-access-token', '1999-12-31', { dobGranularity: 'year', intent: 'create' }];
    expect(api.googleLoginWithToken.mock.calls[2]).toEqual(yearCreate);
    api.googleLoginWithToken.mockResolvedValueOnce({ user: { id: 35 }, created: true });
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(api.googleLoginWithToken).toHaveBeenCalledTimes(4));
    expect(api.googleLoginWithToken.mock.calls[3]).toEqual(yearCreate);
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 35 }));
    expect(panel(utils)).toBeNull();
  });

  it('Google: that tap is spent even when its sheet is dismissed, so the tap after it asks', async () => {
    asNativeIos();
    const utils = openLogin();
    await googlePanel(utils, 'google-id-token-a');
    await createRefused(utils, 'google', warned('google'));

    mockSocialLogin.login.mockRejectedValueOnce(cancelled());
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(mockSocialLogin.login).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(utils.queryByRole('alert')).toBeNull();

    await nextGoogleTapAsks(utils, 2);
  });

  it('Apple: the same, with Apple\'s sheet dismissed', async () => {
    asNativeIos();
    const utils = openLogin();
    await applePanel(utils);
    await createRefused(utils, 'apple', warned('apple'));

    mockAppleAuthorize.mockRejectedValueOnce(new Error(APPLE_DISMISSED));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(mockAppleAuthorize).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));

    appleSheetGives({ identityToken: 'apple-id-token-3', authorizationCode: 'apple-code-3', user: 'apple-user-3' });
    api.appleLogin.mockRejectedValueOnce(noAccount('apple'));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(api.appleLogin).toHaveBeenCalledTimes(3));
    expect(api.appleLogin.mock.calls[2][0]).toBe('apple-id-token-3');
    expect(api.appleLogin.mock.calls[2][4]).toEqual({ intent: 'signin' });
    await waitFor(() => expect(createButton(utils)).not.toBeNull());
  });

  it("the email form's Sign in forgets it: after a wrong password, the next Google tap asks", async () => {
    asNativeIos();
    const utils = openLogin();
    await googlePanel(utils, 'google-id-token-a');
    await createRefused(utils, 'google', warned('google'));

    // What the warning offers first: the account's email and password.
    fireEvent.change(utils.getByLabelText('Email'), { target: { value: 'ava@gmail.com' } });
    fireEvent.change(utils.getByLabelText('Password'), { target: { value: 'not-the-password' } });
    api.login.mockRejectedValueOnce(serverSays(401, 'Invalid email or password'));
    fireEvent.click(utils.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe('Invalid email or password'));

    await nextGoogleTapAsks(utils, 2);
  });

  it('Forgot password forgets it too: back on the sign-in screen, the next Google tap asks', async () => {
    asNativeIos();
    const utils = openLogin();
    await googlePanel(utils, 'google-id-token-a');
    await createRefused(utils, 'google', warned('google'));

    fireEvent.click(utils.getByRole('button', { name: 'Forgot password?' }));
    fireEvent.click(utils.getByRole('button', { name: 'Back to sign in' }));

    await nextGoogleTapAsks(utils, 2);
  });
});

// ---------------------------------------------------------------------------
// G. A new tap starts clean.
// ---------------------------------------------------------------------------
describe('G: a new attempt clears what the last one left', () => {
  it('a Google failure is cleared by an Apple tap, so a dismissed Apple sheet leaves nothing on screen', async () => {
    asNativeIos();
    const utils = openLogin();
    mockSocialLogin.login.mockRejectedValueOnce(new Error('No presenting view controller found'));
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe("Google sign-in didn't finish. Try again, or use email."));

    mockAppleAuthorize.mockRejectedValueOnce(new Error("The operation couldn't be completed. (com.apple.AuthenticationServices.AuthorizationError error 1001.)"));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(mockAppleAuthorize).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(utils.queryByRole('alert')).toBeNull();
  });

  it('an open panel is closed by a tap on the other provider, and its credentials go with it', async () => {
    asNativeIos();
    const utils = openLogin();
    appleSheetGives();
    api.appleLogin.mockRejectedValueOnce(noAccount('apple'));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(createButton(utils)).not.toBeNull());

    mockSocialLogin.login.mockRejectedValueOnce(Object.assign(new Error('The user canceled the sign-in flow.'), { code: 'USER_CANCELLED' }));
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(mockSocialLogin.login).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(panel(utils)).toBeNull();
    expect(utils.queryByRole('alert')).toBeNull();
    expect(api.appleLogin).toHaveBeenCalledTimes(1);
  });

  // A year step is the same kind of thing as the panel: a held proof waiting
  // on the person, for a 'create'. Only the website has one on this screen
  // (the app asks no year), and only flockcorp.com draws Apple there, so
  // these two run on that host with Apple's JS in place. The step used to
  // stay open under the other provider's dismissed popup, without the
  // 'create' its button falls back to, which that tap had spent: its
  // Continue met the unconfirmed-account warning ("tap Continue with Google
  // again"), and that tap sent 'signin' and reopened the panel.
  describe('the website: a year step, and a tap on the other provider', () => {
    const realLocation = window.location;
    let appleInit;
    let appleSignIn;
    beforeEach(() => {
      delete window.location;
      window.location = {
        hostname: 'www.flockcorp.com',
        host: 'www.flockcorp.com',
        origin: 'https://www.flockcorp.com',
        protocol: 'https:',
        pathname: '/app',
        search: '',
        hash: '',
        href: 'https://www.flockcorp.com/app',
      };
      appleInit = jest.fn();
      appleSignIn = jest.fn();
      window.AppleID = { auth: { init: appleInit, signIn: appleSignIn } };
      api.getAppleNonce.mockResolvedValue({ nonce: 'n-1', expiresInSeconds: 600 });
    });
    afterEach(() => {
      delete window.AppleID;
      window.location = realLocation;
    });
    const continueButton = (utils) => utils.queryByRole('button', { name: /^continue$/i });

    it("Google's step closes at an Apple tap, and its held popup is never sent", async () => {
      const utils = openLogin();
      api.googleLoginWithToken.mockRejectedValueOnce(noAccount('google'));
      fireEvent.click(googleButton(utils));
      await waitFor(() => expect(createButton(utils)).not.toBeNull());
      api.googleLoginWithToken.mockRejectedValueOnce(yearAsk());
      fireEvent.click(createButton(utils));
      await waitFor(() => expect(utils.getByLabelText('Year of birth').id).toBe('login-google-year'));
      fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '1999' } });

      appleSignIn.mockRejectedValueOnce({ error: 'popup_closed_by_user' });
      fireEvent.click(appleButton(utils));
      await waitFor(() => expect(appleSignIn).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(utils.container.querySelector('#login-google-year')).toBeNull();
      expect(continueButton(utils)).toBeNull();
      expect(utils.queryByRole('alert')).toBeNull();
      expect(api.appleLogin).not.toHaveBeenCalled();

      // The next Google tap is a new question, with the year still filled in.
      api.googleLoginWithToken.mockRejectedValueOnce(noAccount('google'));
      fireEvent.click(googleButton(utils));
      await waitFor(() => expect(createButton(utils)).not.toBeNull());
      expect(api.googleLoginWithToken).toHaveBeenCalledTimes(3);
      expect(api.googleLoginWithToken.mock.calls[2])
        .toEqual(['web-access-token', '1999-12-31', { dobGranularity: 'year', intent: 'signin' }]);
      expect(utils.onLoginSuccess).not.toHaveBeenCalled();
    });

    it("Apple's step closes at a Google tap, and its held popup is never sent", async () => {
      const utils = openLogin();
      appleSignIn.mockImplementation(async () => ({
        authorization: { id_token: 'apple-web-token', code: 'apple-web-code', state: appleInit.mock.calls[appleInit.mock.calls.length - 1][0].state },
      }));
      api.appleLogin.mockRejectedValueOnce(noAccount('apple'));
      fireEvent.click(appleButton(utils));
      await waitFor(() => expect(createButton(utils)).not.toBeNull());
      api.appleLogin.mockRejectedValueOnce(yearAsk('Apple'));
      fireEvent.click(createButton(utils));
      await waitFor(() => expect(utils.getByLabelText('Year of birth').id).toBe('login-apple-year'));
      fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '1999' } });

      // A Google popup closed without an answer: GIS calls nothing back.
      mockWebStart.mockImplementationOnce(() => {});
      fireEvent.click(googleButton(utils));
      await waitFor(() => expect(mockWebStart).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(utils.container.querySelector('#login-apple-year')).toBeNull();
      expect(continueButton(utils)).toBeNull();
      expect(utils.queryByRole('alert')).toBeNull();
      expect(api.appleLogin).toHaveBeenCalledTimes(2);
      expect(api.googleLoginWithToken).not.toHaveBeenCalled();

      // The next Apple tap is a new question, from a new popup.
      api.appleLogin.mockRejectedValueOnce(noAccount('apple'));
      fireEvent.click(appleButton(utils));
      await waitFor(() => expect(api.appleLogin).toHaveBeenCalledTimes(3));
      expect(appleSignIn).toHaveBeenCalledTimes(2);
      expect(api.appleLogin.mock.calls[2][4]).toMatchObject({ dobGranularity: 'year', intent: 'signin' });
      await waitFor(() => expect(createButton(utils)).not.toBeNull());
      expect(utils.onLoginSuccess).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// H. A Google sheet in the app that stayed open, then closed with no answer.
// ---------------------------------------------------------------------------
describe('H: the quiet hint after a slow Google dismissal in the app', () => {
  const cancel = () => Object.assign(new Error('The user canceled the sign-in flow.'), { code: 'USER_CANCELLED' });
  const sheetClosesAfter = (clock, t0, ms) => {
    mockSocialLogin.login.mockImplementationOnce(() => {
      clock.mockReturnValue(t0 + ms);
      return Promise.reject(cancel());
    });
  };

  [['the sign-in screen', openLogin], ['the sign-up screen', openSignup]].forEach(([label, open]) => {
    it(`${label}: closed after more than three seconds, the hint shows, quietly`, async () => {
      asNativeIos();
      const t0 = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
      const utils = open();
      sheetClosesAfter(clock, t0, 4000);
      fireEvent.click(googleButton(utils));
      await waitFor(() => expect(utils.getByText(HINT)).toBeTruthy());
      const hint = utils.getByText(HINT);
      expect(hint.getAttribute('role')).toBe('status');
      expect(hint.closest('.auth-error')).toBeNull();
      expect(utils.queryByRole('alert')).toBeNull();

      // The next tap clears it.
      sheetClosesAfter(clock, t0, 4000 + 500);
      clock.mockReturnValue(t0 + 4000);
      fireEvent.click(googleButton(utils));
      await waitFor(() => expect(mockSocialLogin.login).toHaveBeenCalledTimes(2));
      await new Promise((r) => setTimeout(r, 20));
      expect(utils.queryByText(HINT)).toBeNull();
    });

    it(`${label}: a quick dismissal still says nothing`, async () => {
      asNativeIos();
      const t0 = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);
      const utils = open();
      sheetClosesAfter(clock, t0, 1500);
      fireEvent.click(googleButton(utils));
      await waitFor(() => expect(mockSocialLogin.login).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 20));
      expect(utils.queryByText(HINT)).toBeNull();
      expect(utils.queryByRole('alert')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// I. Apple's error 1000 names the fix.
// ---------------------------------------------------------------------------
describe('I: Apple error 1000', () => {
  const APPLE_1000 = "The operation couldn't be completed. (com.apple.AuthenticationServices.AuthorizationError error 1000.)";

  it('on the sign-in screen it says to check iCloud, and the log text stays off the screen', async () => {
    asNativeIos();
    const utils = openLogin();
    mockAppleAuthorize.mockRejectedValueOnce(new Error(APPLE_1000));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent)
      .toBe("Apple sign-in didn't finish. Make sure you're signed in to iCloud in Settings, or use email."));
    expect(utils.container.textContent).not.toContain('AuthorizationError');
    expect(api.appleLogin).not.toHaveBeenCalled();
  });

  it('in the delete and export dialogs it says to try again, with no email to point at', async () => {
    asNativeIos();
    const onError = jest.fn();
    const utils = render(React.createElement(AppleSignInButton, { onError, reconfirm: true }));
    mockAppleAuthorize.mockRejectedValueOnce(new Error(APPLE_1000));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onError.mock.calls[0][0])
      .toBe("Apple sign-in didn't finish. Make sure you're signed in to iCloud in Settings, then try again.");
  });

  it('1001 is a dismissal and still says nothing', async () => {
    asNativeIos();
    const utils = openLogin();
    mockAppleAuthorize.mockRejectedValueOnce(new Error("The operation couldn't be completed. (com.apple.AuthenticationServices.AuthorizationError error 1001.)"));
    fireEvent.click(appleButton(utils));
    await waitFor(() => expect(mockAppleAuthorize).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(utils.queryByRole('alert')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The request itself: the intent reaches the server in the body.
// ---------------------------------------------------------------------------
describe('services/api.js sends the intent in the body', () => {
  const realApi = jest.requireActual('../services/api');
  const jsonResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
  const bodyOfLastPost = () => JSON.parse(global.fetch.mock.calls[global.fetch.mock.calls.length - 1][1].body);

  beforeEach(() => {
    global.fetch = jest.fn(() => Promise.resolve(jsonResponse(409, {
      error: 'No Flock account uses this Apple ID yet.', noAccount: true, canCreate: true,
    })));
  });

  it('googleLogin, googleLoginWithToken and appleLogin carry signin or create, and nothing else', async () => {
    await expect(realApi.googleLogin('id-token', undefined, { intent: 'signin' })).rejects.toMatchObject({ status: 409 });
    expect(bodyOfLastPost()).toEqual({ credential: 'id-token', intent: 'signin' });
    await expect(realApi.googleLoginWithToken('access', undefined, { intent: 'create' })).rejects.toMatchObject({ status: 409 });
    expect(bodyOfLastPost()).toEqual({ access_token: 'access', intent: 'create' });
    await expect(realApi.appleLogin('apple-token', undefined, 'code', undefined, { intent: 'signin' })).rejects.toMatchObject({ status: 409 });
    expect(bodyOfLastPost()).toEqual({ identityToken: 'apple-token', authorizationCode: 'code', intent: 'signin' });
    // No intent, or a word the server does not know, sends none.
    await expect(realApi.appleLogin('apple-token', undefined, 'code', undefined, { intent: 'other' })).rejects.toMatchObject({ status: 409 });
    expect(bodyOfLastPost()).toEqual({ identityToken: 'apple-token', authorizationCode: 'code' });
    await expect(realApi.googleLogin('id-token')).rejects.toMatchObject({ status: 409 });
    expect(bodyOfLastPost()).toEqual({ credential: 'id-token' });
  });
});
