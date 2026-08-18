/**
 * NATIVE GOOGLE SIGN-IN ON iOS — the fix for a dead button that was in App
 * Review.
 *
 * THE DEFECT. All three auth screens drove "Continue with Google" with
 * `useGoogleLogin` from @react-oauth/google, which is Google Identity Services'
 * browser popup. Inside the iOS Capacitor WebView that cannot complete, twice
 * over: Capacitor's iOS WebViewDelegationHandler hands every `window.open` to
 * UIApplication.open and returns nil, so the popup leaves for Safari with no
 * opener to postMessage a token back to; and the WebView origin is
 * `capacitor://localhost`, which GIS refuses because it is not an http/https
 * origin registered in the Google Cloud console. Tapping the button threw the
 * user out of the app and nothing came back.
 *
 * THE FIX, and what these tests hold shut:
 *   1. On native iOS the tap runs Google's own SDK
 *      (@capgo/capacitor-social-login) and nothing else; everywhere else the
 *      existing GIS flow is untouched, down to the same api function.
 *   2. The ID token goes to the endpoint that already exists,
 *      POST /api/auth/google, in the field it already accepts — `credential`,
 *      which backend/routes/auth.js verifies with google-auth-library against
 *      GOOGLE_CLIENT_ID. No new route, no new token shape.
 *   3. The audience actually matches. An ID token minted for the iOS OAuth
 *      client would carry the iOS client id in `aud` and be rejected, so the
 *      plugin is initialized with iOSServerClientId = the WEB client id, which
 *      Google documents as becoming the token's audience.
 *   4. needsDob works identically on both paths: the server answers
 *      403 {needsDob:true} for a first-time OAuth account with no date of
 *      birth, and the screen must be able to read that off the raw error.
 *   5. The plugin is imported lazily, inside the handler, so the web bundle
 *      never pulls the native module in.
 *
 * The api layer is mocked because what is under test is which token reaches
 * which function; services/api.js's own contract (that googleLogin posts
 * `credential` to /api/auth/google) is asserted here as source, from the file
 * that decides it.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, fireEvent, waitFor, screen } = require('@testing-library/react');

// ---------------------------------------------------------------------------
// Mocks. CRA ships resetMocks: true, so implementations are set per test.
// ---------------------------------------------------------------------------
jest.mock('../services/api', () => ({
  login: jest.fn(),
  signup: jest.fn(),
  resendVerificationEmail: jest.fn(),
  googleLogin: jest.fn(),
  googleLoginWithToken: jest.fn(),
}));

// The web half. Standing in for GIS lets a test prove the web path is still
// the one taken off-iOS without a browser popup ever being involved.
const mockWebStart = jest.fn();
jest.mock('@react-oauth/google', () => ({
  useGoogleLogin: (config) => {
    // Hand the config back to the test so it can fire the success callback
    // the real library would fire.
    mockWebStart.mockImplementation(() => config.onSuccess({ access_token: 'web-access-token' }));
    return mockWebStart;
  },
}));

const mockSocialLogin = {
  initialize: jest.fn(),
  login: jest.fn(),
};
jest.mock('@capgo/capacitor-social-login', () => ({
  get SocialLogin() {
    mockNativeModuleLoads += 1;
    return mockSocialLogin;
  },
}));

jest.mock('../components/auth/AppleSignInButton', () => () => null);
jest.mock('../components/auth/PasswordReset', () => ({
  ForgotPasswordScreen: () => null,
  ResetPasswordScreen: () => null,
  isPasswordResetRoute: () => false,
}));

let mockNativeModuleLoads = 0;

const api = require('../services/api');

const SRC = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const HOOK_SRC = SRC('components', 'auth', 'useGoogleAuth.js');
const API_SRC = SRC('services', 'api.js');
const SCREENS = ['LoginScreen.js', 'SignupScreen.js', 'VenueLoginScreen.js'];

const asNativeIos = () => {
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
};
const asWeb = () => { delete window.Capacitor; };

// CRA substitutes each REACT_APP_* expression at build time; the hook reads
// them through one-line getters so a test can set them per case without
// reloading React (two React copies in one render is a null-dispatcher crash).
const LoginScreen = require('../components/auth/LoginScreen').default;

const loadLoginScreen = ({ ios = '', web = 'web-client-id.apps.googleusercontent.com' } = {}) => {
  process.env.REACT_APP_GOOGLE_IOS_CLIENT_ID = ios;
  process.env.REACT_APP_GOOGLE_CLIENT_ID = web;
  return LoginScreen;
};

const ENV_BACKUP = { ...process.env };

beforeEach(() => {
  mockNativeModuleLoads = 0;
  mockWebStart.mockReset();
  asWeb();
});

afterEach(() => {
  process.env = { ...ENV_BACKUP };
  asWeb();
});

const googleButton = () => screen.queryByRole('button', { name: /Continue with Google/ });
const clickGoogle = () => fireEvent.click(googleButton());

// ---------------------------------------------------------------------------
// 1. Which path runs where.
// ---------------------------------------------------------------------------
describe('the native path is used on native iOS and nowhere else', () => {
  test('native iOS runs the plugin and never the GIS browser flow', async () => {
    asNativeIos();
    mockSocialLogin.initialize.mockResolvedValue(undefined);
    mockSocialLogin.login.mockResolvedValue({
      provider: 'google',
      result: { idToken: 'native-id-token', responseType: 'online' },
    });
    api.googleLogin.mockResolvedValue({ user: { id: 7 } });

    const Screen = loadLoginScreen({ ios: 'ios-client-id.apps.googleusercontent.com' });
    const onLoginSuccess = jest.fn();
    render(React.createElement(Screen, { onLoginSuccess }));

    clickGoogle();
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledWith({ id: 7 }));

    expect(mockSocialLogin.login).toHaveBeenCalledTimes(1);
    // The popup that leaves the app is exactly what must not happen.
    expect(mockWebStart).not.toHaveBeenCalled();
    expect(api.googleLoginWithToken).not.toHaveBeenCalled();
  });

  test('web is byte-for-byte the flow it already had', async () => {
    asWeb();
    api.googleLoginWithToken.mockResolvedValue({ user: { id: 3 } });

    const Screen = loadLoginScreen({ ios: 'ios-client-id.apps.googleusercontent.com' });
    const onLoginSuccess = jest.fn();
    render(React.createElement(Screen, { onLoginSuccess }));

    clickGoogle();
    await waitFor(() => expect(onLoginSuccess).toHaveBeenCalledWith({ id: 3 }));

    expect(api.googleLoginWithToken).toHaveBeenCalledWith('web-access-token', undefined);
    expect(mockSocialLogin.login).not.toHaveBeenCalled();
    expect(mockNativeModuleLoads).toBe(0);
  });

  test('a native build with no iOS client id hides the button instead of shipping a dead one', () => {
    asNativeIos();
    const Screen = loadLoginScreen({ ios: '' });
    render(React.createElement(Screen, { onLoginSuccess: jest.fn() }));
    expect(googleButton()).toBeNull();
    // Email sign-in is still there, so the screen is never left without a way in.
    expect(screen.getByRole('button', { name: /Sign in/ })).toBeTruthy();
  });

  test('the same absence does not hide anything on the web', () => {
    asWeb();
    const Screen = loadLoginScreen({ ios: '' });
    render(React.createElement(Screen, { onLoginSuccess: jest.fn() }));
    expect(googleButton()).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2. The token, the field name and the audience.
// ---------------------------------------------------------------------------
describe('the native token reaches the endpoint that already exists', () => {
  test('the ID token is posted through googleLogin, which sends `credential`', async () => {
    asNativeIos();
    mockSocialLogin.initialize.mockResolvedValue(undefined);
    mockSocialLogin.login.mockResolvedValue({
      provider: 'google',
      result: { idToken: 'native-id-token', responseType: 'online' },
    });
    api.googleLogin.mockResolvedValue({ user: { id: 1 } });

    const Screen = loadLoginScreen({ ios: 'ios-client-id.apps.googleusercontent.com' });
    render(React.createElement(Screen, { onLoginSuccess: jest.fn() }));
    clickGoogle();

    await waitFor(() => expect(api.googleLogin).toHaveBeenCalledWith('native-id-token', undefined));

    // The other half of the contract, read from the file that decides it: an
    // ID token is `credential`, and it goes to the route the web flow uses.
    const fn = API_SRC.slice(API_SRC.indexOf('export async function googleLogin(credential'));
    expect(fn).toMatch(/const body = \{ credential \}/);
    expect(fn.slice(0, fn.indexOf('export async function apple'))).toContain("'/api/auth/google'");
  });

  test('the plugin is initialized with the WEB client id as the server client id', async () => {
    asNativeIos();
    mockSocialLogin.initialize.mockResolvedValue(undefined);
    mockSocialLogin.login.mockResolvedValue({
      provider: 'google', result: { idToken: 't', responseType: 'online' },
    });
    api.googleLogin.mockResolvedValue({ user: {} });

    // Distinct from the other cases on purpose: initialize() is memoized on
    // the client-id pair, so a fresh pair is what proves this call happened.
    const Screen = loadLoginScreen({
      ios: 'ios-audience.apps.googleusercontent.com',
      web: 'web-audience.apps.googleusercontent.com',
    });
    render(React.createElement(Screen, { onLoginSuccess: jest.fn() }));
    clickGoogle();

    await waitFor(() => expect(mockSocialLogin.initialize).toHaveBeenCalled());
    const cfg = mockSocialLogin.initialize.mock.calls[0][0].google;
    expect(cfg.iOSClientId).toBe('ios-audience.apps.googleusercontent.com');
    // If this is ever dropped, the ID token's `aud` becomes the iOS client id
    // and backend/routes/auth.js rejects every native sign-in with a 401.
    expect(cfg.iOSServerClientId).toBe('web-audience.apps.googleusercontent.com');
    // 'offline' returns only a serverAuthCode, and nothing on the backend
    // exchanges one.
    expect(cfg.mode).toBe('online');
  });

  test('a login that returns no ID token is an error, not a silent success', async () => {
    asNativeIos();
    mockSocialLogin.initialize.mockResolvedValue(undefined);
    mockSocialLogin.login.mockResolvedValue({ provider: 'google', result: { idToken: null } });

    const Screen = loadLoginScreen({ ios: 'ios-client-id.apps.googleusercontent.com' });
    const onLoginSuccess = jest.fn();
    render(React.createElement(Screen, { onLoginSuccess }));
    clickGoogle();

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/did not return a token/));
    expect(onLoginSuccess).not.toHaveBeenCalled();
    expect(api.googleLogin).not.toHaveBeenCalled();
  });

  test('a dismissed sheet is not reported as a failure', async () => {
    asNativeIos();
    mockSocialLogin.initialize.mockResolvedValue(undefined);
    const cancelled = Object.assign(new Error('The user cancelled the sign-in flow.'), {
      code: 'USER_CANCELLED',
    });
    mockSocialLogin.login.mockRejectedValue(cancelled);

    const Screen = loadLoginScreen({ ios: 'ios-client-id.apps.googleusercontent.com' });
    render(React.createElement(Screen, { onLoginSuccess: jest.fn() }));
    clickGoogle();

    await waitFor(() => expect(mockSocialLogin.login).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. The age gate survives the platform split.
// ---------------------------------------------------------------------------
describe('needsDob is handled on the native path exactly as on the web one', () => {
  test('a 403 needsDob reveals the date field and the retry sends the date', async () => {
    asNativeIos();
    mockSocialLogin.initialize.mockResolvedValue(undefined);
    mockSocialLogin.login.mockResolvedValue({
      provider: 'google', result: { idToken: 'native-id-token', responseType: 'online' },
    });
    // The shape services/api.js throws: message plus the parsed body on .data.
    api.googleLogin.mockRejectedValueOnce(
      Object.assign(new Error('Date of birth required'), {
        status: 403, data: { needsDob: true },
      })
    );

    const Screen = loadLoginScreen({ ios: 'ios-client-id.apps.googleusercontent.com' });
    render(React.createElement(Screen, { onLoginSuccess: jest.fn() }));
    clickGoogle();

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toMatch(/Add your date of birth below/)
    );

    // The field the message points at has to exist, or the message is a dead
    // end on the first screen of the app.
    const field = screen.getByLabelText(/date of birth/i);
    fireEvent.change(field, { target: { value: '2000-01-01' } });

    api.googleLogin.mockResolvedValue({ user: { id: 9 } });
    clickGoogle();
    await waitFor(() =>
      expect(api.googleLogin).toHaveBeenLastCalledWith('native-id-token', '2000-01-01')
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Shape of the change, so it cannot quietly regress.
// ---------------------------------------------------------------------------
describe('the split is written once and the plugin stays out of the web bundle', () => {
  test('the plugin is imported lazily, inside the handler', () => {
    // A static import would put @capgo/capacitor-social-login (and the native
    // shim it wraps) into the web bundle for every visitor.
    expect(HOOK_SRC).toMatch(/await import\('@capgo\/capacitor-social-login'\)/);
    expect(HOOK_SRC).not.toMatch(/^import .*@capgo\/capacitor-social-login/m);
  });

  test('no auth screen imports the plugin or useGoogleLogin directly', () => {
    for (const f of SCREENS) {
      const src = SRC('components', 'auth', f);
      expect({ file: f, ok: !/@capgo\/capacitor-social-login/.test(src) })
        .toEqual({ file: f, ok: true });
      // The whole point of the hook is that the platform choice is written
      // once; a screen reaching for useGoogleLogin again has forked it.
      expect({ file: f, ok: !/useGoogleLogin/.test(src) })
        .toEqual({ file: f, ok: true });
      expect({ file: f, ok: /useGoogleAuth/.test(src) })
        .toEqual({ file: f, ok: true });
    }
  });

  test('the detection matches the one Sign in with Apple already uses', () => {
    const apple = SRC('components', 'auth', 'AppleSignInButton.js');
    for (const probe of ['isNativePlatform', "getPlatform?.() === 'ios'"]) {
      expect(apple).toContain(probe);
      expect(HOOK_SRC).toContain(probe);
    }
  });
});
