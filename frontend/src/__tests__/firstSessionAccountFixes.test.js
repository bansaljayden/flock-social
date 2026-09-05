/**
 * FIRST-SESSION ACCOUNT DEFECTS, traced 2026-09-04.
 *
 * Five things a reviewer could hit in their first session, each pinned to the
 * screen that carried it:
 *
 *   1. EditProfileForm demanded a current password from every account, while
 *      the server compares one only when the row has one. An Apple or Google
 *      account could not save a name or a bio. The form now reads
 *      authUser.sign_in_method, the field the export and delete sheets already
 *      read, and the three sign-in responses now carry it (pinned in
 *      backend/__tests__/signInMethodAndSignupRace.test.js).
 *   2. AppleSignInButton forgot the name Apple delivers exactly once. A first
 *      tap the server refused (needsDob) spent that delivery, and the retry
 *      created the account from the email's local part, which for a private
 *      relay address is a random string. The button now remembers the last
 *      delivered name for the same Apple user and resends it. SignupScreen
 *      also stops the sheet opening with no date of birth, as its Google
 *      button already did, so the first tap is one the server can accept.
 *   3. LoginScreen and the venue sign-in half create accounts through their
 *      Google and Apple buttons and stamped terms_accepted_at without ever
 *      showing the Terms. Both now render SignupScreen's consent paragraph,
 *      word for word, from the moment the server asks for a date of birth.
 *   4. ProfileSettings wrote "fifteen minutes" over a lockout sentence that
 *      the server now words from the real window.
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
  trackAuthScreen: jest.fn(),
  login: jest.fn(),
  signup: jest.fn(),
  resendVerificationEmail: jest.fn(),
  googleLogin: jest.fn(),
  googleLoginWithToken: jest.fn(),
  appleLogin: jest.fn(),
  updateProfile: jest.fn(),
  RESET_DONE_KEY: 'flock_reset_done',
}));

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

jest.mock('../components/auth/PasswordReset', () => ({
  ForgotPasswordScreen: () => null,
  ResetPasswordScreen: () => null,
  isPasswordResetRoute: () => false,
}));

const api = require('../services/api');
const EditProfileForm = require('../components/EditProfileForm').default;
const AppleSignInButton = require('../components/auth/AppleSignInButton').default;
const SignupScreen = require('../components/auth/SignupScreen').default;
const LoginScreen = require('../components/auth/LoginScreen').default;
const VenueLoginScreen = require('../components/auth/VenueLoginScreen').default;

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const SIGNUP_SRC = read('components/auth/SignupScreen.js');
const LOGIN_SRC = read('components/auth/LoginScreen.js');
const VENUE_SRC = read('components/auth/VenueLoginScreen.js');
const PROFILE_SRC = read('screens/ProfileSettings.js');

const asWeb = () => { delete window.Capacitor; };
const asNativeIos = () => {
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
};

const needsDob = () => Object.assign(new Error('No Flock account yet. Sign up with your date of birth first.'), {
  status: 403, data: { needsDob: true },
});

afterEach(() => {
  jest.clearAllMocks();
  asWeb();
});

// ---------------------------------------------------------------------------
// 1. Edit profile on an Apple or Google account
// ---------------------------------------------------------------------------

const openEditProfile = (authUser) => {
  const props = {
    authUser,
    colors: { navy: '#000', navyBg: '#111', steel: '#222', red: '#f00', redText: '#c00', creamDark: '#eee' },
    styles: { input: {}, gradientButton: {} },
    confirmClick: jest.fn(),
    profileBio: '',
    profileName: 'Sam',
    profilePhone: '',
    profilePic: null,
    setCropImageSrc: jest.fn(),
    setCropOffset: jest.fn(),
    setCropZoom: jest.fn(),
    setProfileBio: jest.fn(),
    setProfileName: jest.fn(),
    setProfilePhone: jest.fn(),
    onUserUpdated: jest.fn(),
    setShowPicModal: jest.fn(),
  };
  return render(React.createElement(EditProfileForm, props));
};

describe('editing a profile on an account that has no password', () => {
  it('shows no password fields and saves without one', async () => {
    api.updateProfile.mockResolvedValueOnce({ user: { name: 'Sam', email: 'sam@privaterelay.appleid.com', bio: '' } });
    const { queryByText, queryByLabelText, getByText } = openEditProfile({
      email: 'sam@privaterelay.appleid.com', sign_in_method: 'apple',
    });

    expect(queryByText('Security')).toBeNull();
    expect(queryByLabelText('Current password')).toBeNull();
    expect(queryByLabelText('New password')).toBeNull();

    fireEvent.click(getByText('Save Changes'));
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1));
    const payload = api.updateProfile.mock.calls[0][0];
    expect(payload.name).toBe('Sam');
    expect('current_password' in payload).toBe(false);
    expect(queryByText('Current password is required to save changes')).toBeNull();
  });

  it('still asks a password account for its password, and sends it', async () => {
    const { getByText, getByLabelText, getByRole } = openEditProfile({
      email: 'sam@example.com', sign_in_method: 'password',
    });
    expect(getByText('Security')).toBeTruthy();

    fireEvent.click(getByText('Save Changes'));
    await waitFor(() => expect(getByRole('alert').textContent).toBe('Current password is required to save changes'));
    expect(api.updateProfile).not.toHaveBeenCalled();

    api.updateProfile.mockResolvedValueOnce({ user: { name: 'Sam', email: 'sam@example.com', bio: '' } });
    fireEvent.change(getByLabelText('Current password'), { target: { value: 'Password1' } });
    fireEvent.click(getByText('Save Changes'));
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1));
    expect(api.updateProfile.mock.calls[0][0].current_password).toBe('Password1');
  });

  it('keeps the field when the payload predates sign_in_method, the same rule the account sheets apply', () => {
    const { getByText } = openEditProfile({ email: 'sam@example.com' });
    expect(getByText('Security')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2. Apple's one-time name delivery
// ---------------------------------------------------------------------------

describe('the name Apple sends once', () => {
  const tapApple = (utils) => fireEvent.click(utils.getByRole('button', { name: /continue with apple/i }));

  it('is resent on the retry after the server asked for a date of birth', async () => {
    asNativeIos();
    const onError = jest.fn();
    const onSuccess = jest.fn();
    const utils = render(React.createElement(AppleSignInButton, { onSuccess, onError }));

    // First tap: the sheet completes on the device with the name, the server
    // refuses for want of a date of birth. Apple will not send the name again.
    mockAppleAuthorize.mockResolvedValueOnce({
      response: { identityToken: 'apple-token-1', user: 'apple-user-A', givenName: 'Sam', familyName: 'Lee', authorizationCode: 'code-1' },
    });
    api.appleLogin.mockRejectedValueOnce(needsDob());
    tapApple(utils);
    await waitFor(() => expect(api.appleLogin).toHaveBeenCalledTimes(1));
    expect(api.appleLogin.mock.calls[0][1]).toEqual({ givenName: 'Sam', familyName: 'Lee' });
    await waitFor(() => expect(onError).toHaveBeenCalled());

    // Second tap: no name from the plugin. The button must send the one it
    // was given, or the server names the account after a relay address.
    mockAppleAuthorize.mockResolvedValueOnce({
      response: { identityToken: 'apple-token-2', user: 'apple-user-A', authorizationCode: 'code-2' },
    });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 7 } });
    tapApple(utils);
    await waitFor(() => expect(api.appleLogin).toHaveBeenCalledTimes(2));
    expect(api.appleLogin.mock.calls[1][1]).toEqual({ givenName: 'Sam', familyName: 'Lee' });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ id: 7 }));
  });

  it('is not remembered when the plugin hands over no Apple user id', async () => {
    // The plugin's contract allows a null `user`. A name with no id cannot be
    // keyed to anyone, so it is not kept, and a later sheet with no id
    // matches nothing (adversarial audit round 2, 2026-09-05).
    asNativeIos();
    const onError = jest.fn();
    const utils = render(React.createElement(AppleSignInButton, { onSuccess: jest.fn(), onError }));
    mockAppleAuthorize.mockResolvedValueOnce({
      response: { identityToken: 'apple-token-n1', givenName: 'Sam', familyName: 'Lee', authorizationCode: 'code-n1' },
    });
    api.appleLogin.mockRejectedValueOnce(needsDob());
    tapApple(utils);
    await waitFor(() => expect(onError).toHaveBeenCalled());

    mockAppleAuthorize.mockResolvedValueOnce({ response: { identityToken: 'apple-token-n2', authorizationCode: 'code-n2' } });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 11 } });
    tapApple(utils);
    await waitFor(() => expect(api.appleLogin).toHaveBeenCalledTimes(2));
    expect(api.appleLogin.mock.calls[1][1]).toBeUndefined();
  });

  it('is forgotten the moment the server accepts it', async () => {
    asNativeIos();
    const utils = render(React.createElement(AppleSignInButton, { onSuccess: jest.fn(), onError: jest.fn() }));
    mockAppleAuthorize.mockResolvedValueOnce({
      response: { identityToken: 'apple-token-f1', user: 'apple-user-F', givenName: 'Sam', familyName: 'Lee' },
    });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 12 } });
    tapApple(utils);
    await waitFor(() => expect(api.appleLogin).toHaveBeenCalledTimes(1));

    // Same Apple user, a second sheet with no name: nothing is resent, because
    // the account already carries it and nothing else on the device may.
    mockAppleAuthorize.mockResolvedValueOnce({ response: { identityToken: 'apple-token-f2', user: 'apple-user-F' } });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 12 } });
    tapApple(utils);
    await waitFor(() => expect(api.appleLogin).toHaveBeenCalledTimes(2));
    expect(api.appleLogin.mock.calls[1][1]).toBeUndefined();
  });

  it('is never sent for a different Apple user on the same device', async () => {
    asNativeIos();
    const utils = render(React.createElement(AppleSignInButton, { onSuccess: jest.fn(), onError: jest.fn() }));
    mockAppleAuthorize.mockResolvedValueOnce({
      response: { identityToken: 'apple-token-3', user: 'apple-user-B', authorizationCode: 'code-3' },
    });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 8 } });
    tapApple(utils);
    await waitFor(() => expect(api.appleLogin).toHaveBeenCalledTimes(1));
    expect(api.appleLogin.mock.calls[0][1]).toBeUndefined();
  });

  it('is not spent at all from the signup screen until a date of birth is in', async () => {
    asNativeIos();
    const utils = render(React.createElement(SignupScreen, { onSignupSuccess: jest.fn(), onSwitchToLogin: jest.fn() }));
    tapApple(utils);
    await waitFor(() => expect(utils.getByRole('alert').textContent)
      .toBe('Add your date of birth above first, then continue with Apple.'));
    expect(mockAppleAuthorize).not.toHaveBeenCalled();
    expect(api.appleLogin).not.toHaveBeenCalled();
  });

  it('opens the sheet from the signup screen once a date is in', async () => {
    asNativeIos();
    const utils = render(React.createElement(SignupScreen, { onSignupSuccess: jest.fn(), onSwitchToLogin: jest.fn() }));
    fireEvent.change(utils.getByLabelText(/date of birth/i), { target: { value: '2000-01-01' } });
    mockAppleAuthorize.mockResolvedValueOnce({ response: { identityToken: 'apple-token-4', user: 'apple-user-C' } });
    api.appleLogin.mockResolvedValueOnce({ user: { id: 9 } });
    tapApple(utils);
    await waitFor(() => expect(mockAppleAuthorize).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.appleLogin).toHaveBeenCalledTimes(1));
    expect(api.appleLogin.mock.calls[0][3]).toBe('2000-01-01');
  });
});

// ---------------------------------------------------------------------------
// 3. Consent on the sign-in screens
// ---------------------------------------------------------------------------

// SignupScreen's paragraph, lifted from its source so the two sign-in screens
// are held to the same words rather than to a copy typed here.
const CONSENT_BLOCK = (() => {
  const m = SIGNUP_SRC.match(/<p className="auth-legal">[\s\S]*?<\/p>/);
  if (!m) throw new Error('SignupScreen no longer carries the auth-legal paragraph');
  return m[0];
})();
const CONSENT_TEXT = 'Creating an account means you agree to the Terms, Privacy Policy, and Community Guidelines.';

const consentOn = (container) => container.querySelector('.auth-legal');

const askForDob = async (utils, emailLabel = 'Email') => {
  api.login.mockRejectedValueOnce(Object.assign(new Error('Add your date of birth to continue.'), {
    status: 403, data: { needsDob: true },
  }));
  fireEvent.change(utils.getByLabelText(emailLabel), { target: { value: 'sam@example.com' } });
  fireEvent.change(utils.getByLabelText('Password'), { target: { value: 'Password1' } });
  fireEvent.submit(utils.container.querySelector('form'));
  await waitFor(() => expect(utils.getByLabelText(/date of birth/i)).toBeTruthy());
};

describe('the Terms are on screen before a sign-in screen creates an account', () => {
  it('LoginScreen shows the consent paragraph once the server has asked for a date of birth', async () => {
    const utils = render(React.createElement(LoginScreen, {
      onLoginSuccess: jest.fn(), onSwitchToSignup: jest.fn(), onSwitchToVenueLogin: jest.fn(),
    }));
    expect(consentOn(utils.container)).toBeNull();
    await askForDob(utils);
    const p = consentOn(utils.container);
    expect(p).not.toBeNull();
    expect(p.textContent).toBe(CONSENT_TEXT);
    const hrefs = Array.from(p.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      'https://www.flockcorp.com/terms',
      'https://www.flockcorp.com/privacy',
      'https://www.flockcorp.com/guidelines',
    ]);
  });

  it('the venue sign-in half reveals the date field when Apple answers needsDob', async () => {
    // The Apple callback read only the message, so a brand-new Apple account
    // on the sign-in half was told to try again with no field to fill
    // (adversarial audit round 2, 2026-09-05). Same transition as Google.
    asNativeIos();
    const utils = render(React.createElement(VenueLoginScreen, {
      onLoginSuccess: jest.fn(), onSwitchToUserLogin: jest.fn(),
    }));
    expect(utils.queryByLabelText(/date of birth/i)).toBeNull();
    mockAppleAuthorize.mockResolvedValueOnce({ response: { identityToken: 'apple-token-v1', user: 'apple-user-V' } });
    api.appleLogin.mockRejectedValueOnce(needsDob());
    fireEvent.click(utils.getByRole('button', { name: /continue with apple/i }));
    await waitFor(() => expect(utils.getByLabelText(/date of birth/i)).toBeTruthy());
    expect(utils.getByRole('alert').textContent).toBe('Add your date of birth below, then tap Continue with Apple again.');
    expect(consentOn(utils.container)).not.toBeNull();
  });

  it('the venue sign-in half shows it too', async () => {
    const utils = render(React.createElement(VenueLoginScreen, {
      onLoginSuccess: jest.fn(), onSwitchToUserLogin: jest.fn(),
    }));
    expect(consentOn(utils.container)).toBeNull();
    await askForDob(utils);
    const p = consentOn(utils.container);
    expect(p).not.toBeNull();
    expect(p.textContent).toBe(CONSENT_TEXT);
  });

  it('both screens carry SignupScreen\'s paragraph word for word', () => {
    // Indentation differs by nesting depth; the words and the markup may not.
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    expect(norm(LOGIN_SRC)).toContain(norm(CONSENT_BLOCK));
    expect(norm(VENUE_SRC)).toContain(norm(CONSENT_BLOCK));
    expect(CONSENT_BLOCK).not.toMatch(/—/);
  });
});

// ---------------------------------------------------------------------------
// 4. The lockout sentence is the server's
// ---------------------------------------------------------------------------

test('ProfileSettings no longer writes its own window over a 429', () => {
  expect(PROFILE_SRC).not.toMatch(/fifteen minutes/);
  expect(PROFILE_SRC).toMatch(/if \(err\?\.status === 429\) \{[\s\S]{0,400}setDeleteError\(err\?\.message \|\| /);
});
