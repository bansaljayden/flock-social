/**
 * A FIRST-TIME VENUE OWNER READS EVERY SCREEN ONCE.
 *
 * On 2026-08-21 the venue dashboard was reviewed from TestFlight and some
 * "parts just do not make much sense", without naming them. On 2026-10-20 the
 * owner screens were captured in light and dark (the screenshot rig, venue
 * tabs, the portal, onboarding, a verified and an unverified venue) and read as
 * a bar or cafe owner who knows nothing about the app. What was found and
 * fixed on the frontend is pinned here:
 *
 *   - the website's sign-in hint named an Apple button the website does not
 *     have; it now names the iPhone app for Apple accounts, and the iPhone app
 *     keeps the old line;
 *   - the Events tab used "flock" with no explanation, and cheered an owner to
 *     create a first event one line below "Only you can see these";
 *   - "People who tapped your tag" named a tag nobody had introduced;
 *   - "The Copper Finch" got a T on its logo tile;
 *   - onboarding opened with "things about the room that no dataset holds",
 *     which is how the code talks, not how an owner does.
 *
 * The other finding, the unverified venue's sentence printed on three cards of
 * one tab, is pinned in venueVerificationRequest.test.js and
 * venueAdvisorChat.test.js beside the rules it changes.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=venueOwnerSenseCheck
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  trackAuthScreen: jest.fn(),
  login: jest.fn(),
  signup: jest.fn(),
  resendVerificationEmail: jest.fn(),
  getCurrentUser: jest.fn(),
  googleLogin: jest.fn(),
  googleLoginWithToken: jest.fn(),
  appleLogin: jest.fn(),
  RESET_DONE_KEY: 'flock_reset_done',
}));

jest.mock('@react-oauth/google', () => ({
  useGoogleLogin: () => jest.fn(),
  GoogleOAuthProvider: ({ children }) => children,
}));

jest.mock('@capacitor-community/apple-sign-in', () => ({
  SignInWithApple: { authorize: jest.fn() },
}));

const mockSocialLogin = { initialize: jest.fn(), login: jest.fn() };
jest.mock('@capgo/capacitor-social-login', () => ({
  get SocialLogin() { return mockSocialLogin; },
}));

jest.mock('../components/auth/PasswordReset', () => ({
  ForgotPasswordScreen: () => null,
  ResetPasswordScreen: () => null,
  isPasswordResetRoute: () => false,
}));

process.env.REACT_APP_GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID || 'web-client.apps.googleusercontent.com';
process.env.REACT_APP_GOOGLE_IOS_CLIENT_ID = process.env.REACT_APP_GOOGLE_IOS_CLIENT_ID || 'ios-client.apps.googleusercontent.com';

const LoginScreen = require('../components/auth/LoginScreen').default;
const VenueLoginScreen = require('../components/auth/VenueLoginScreen').default;

const SRC_DIR = path.resolve(__dirname, '..');
const DASH = fs.readFileSync(path.join(SRC_DIR, 'screens', 'VenueDashboard.js'), 'utf8');
const ONBOARDING = fs.readFileSync(path.join(SRC_DIR, 'screens', 'VenueOnboarding.js'), 'utf8');

const WEB_HINT = 'Signed up with Google? Use that button. Signed up with Apple? Use the iPhone app.';
const IOS_HINT = 'Signed up with Google or Apple? Use that button.';

const asNativeIos = () => {
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
};

afterEach(() => {
  jest.clearAllMocks();
  delete window.Capacitor;
});

const mountLogin = () => render(React.createElement(LoginScreen, {
  onLoginSuccess: jest.fn(), onSwitchToSignup: jest.fn(), onSwitchToVenueLogin: jest.fn(),
}));
const mountVenueLogin = () => render(React.createElement(VenueLoginScreen, {
  onLoginSuccess: jest.fn(), onSwitchToUserLogin: jest.fn(),
}));

describe('the sign-in hint names only buttons the screen has', () => {
  test('the website: no Apple button, so Apple accounts are sent to the iPhone app', () => {
    for (const mount of [mountLogin, mountVenueLogin]) {
      const { container, unmount } = mount();
      expect(container.textContent).toContain(WEB_HINT);
      expect(container.textContent).not.toContain(IOS_HINT);
      unmount();
    }
  });

  test('the iPhone app: both buttons are there, so the line names both', () => {
    asNativeIos();
    for (const mount of [mountLogin, mountVenueLogin]) {
      const { container, unmount } = mount();
      expect(container.textContent).toContain(IOS_HINT);
      expect(container.textContent).not.toContain(WEB_HINT);
      unmount();
    }
  });
});

describe('the dashboard says what its words mean', () => {
  test('the Events tab explains "flock" right under the heading that uses it', () => {
    const at = DASH.indexOf('Flocks With You in Their Vote</h3>');
    expect(at).toBeGreaterThan(-1);
    expect(DASH.slice(at, at + 400)).toContain('A flock is a group of friends planning a night out in the Flock app.');
  });

  test('no cheer to create an event nobody can see', () => {
    expect(DASH).toContain('Only you can see these. We are not showing them to Flock users yet.');
    expect(DASH).not.toContain('No events yet. Create your first one!');
    expect(DASH).toContain('>No events yet.</p>');
  });

  test('the check-in line says what the tag is', () => {
    expect(DASH).not.toContain('People who tapped your tag');
    expect(DASH).toContain('People who checked in from the app or tapped a Flock tag at your venue.');
  });

  test('the logo tile skips a leading "The"', () => {
    expect(DASH).toContain("replace(/^the\\s+/i, '')");
    expect((DASH.match(/\{venueInitial\(venueData\.name\)\}/g) || []).length).toBe(2);
    expect(DASH).not.toContain("(venueData.name || 'V').charAt(0)");
  });
});

test('onboarding opens in an owner\'s words, not the code\'s', () => {
  expect(ONBOARDING).not.toContain('the rest are things about the room that no dataset holds. Every one of those is skippable.');
  expect(ONBOARDING).toContain('The rest are details about the room that only you know, and you can skip any of them.');
});
