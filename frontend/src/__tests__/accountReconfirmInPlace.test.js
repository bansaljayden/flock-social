/**
 * DELETING OR EXPORTING AN APPLE OR GOOGLE ACCOUNT NO LONGER SENDS THE PERSON
 * OUT OF THE APP.
 *
 * Both routes want proof beyond the 24-hour token (backend/routes/users.js).
 * An Apple or Google account has no password, so the server accepts a session
 * minted in the last five minutes and otherwise answers 401
 * reauthRequired:'reauth'. The dialog used to answer that with "Log out, sign
 * back in, then come straight here" and a dead Delete button, which is not the
 * easy in-app deletion Guideline 5.1.1(v) asks for.
 *
 * The real ProfileSettings is rendered here, with the dialog state held the
 * way FlockAppInner holds it, and driven through the whole trip:
 *   - the 401 re-prompt, then the account's own sign-in in place, then the
 *     same Delete tap finishing, with the typed DELETE still there
 *   - a different Apple ID never deletes anything: the session ends instead
 *   - Google on the web, and the export sheet, take the same path
 *   - where the provider cannot run (Apple outside the iOS app) the old
 *     sentence stays, because it is still the way
 */
const React = require('react');
const fs = require('fs');
const path = require('path');
const { render, screen, fireEvent, waitFor } = require('@testing-library/react');

jest.mock('../services/api', () => ({
  deleteAccount: jest.fn(),
  trackNotificationPermission: jest.fn(),
  updatePaymentMethods: jest.fn(),
  logoutAll: jest.fn(),
  getCurrentUser: jest.fn(),
  clearLocalSession: jest.fn(),
  getProStatus: jest.fn(),
  openProPortal: jest.fn(),
  cancelProSubscription: jest.fn(),
  resumeProSubscription: jest.fn(),
  appleLogin: jest.fn(),
  googleLogin: jest.fn(),
  googleLoginWithToken: jest.fn(),
}));
jest.mock('../services/firebase', () => ({
  getNotificationStatus: jest.fn(),
  requestNotificationPermission: jest.fn(),
}));

// The web Google flow: useGoogleLogin hands back a starter, and the popup's
// answer arrives through the options it was given. The provider is a pass
// through, because mounting the real one fetches Google's script.
let mockGoogleOptions = null;
jest.mock('@react-oauth/google', () => ({
  useGoogleLogin: (options) => { mockGoogleOptions = options; return () => options.onSuccess({ access_token: 'google-access-token' }); },
  GoogleOAuthProvider: ({ children }) => children,
}));

const mockAppleAuthorize = jest.fn();
jest.mock('@capacitor-community/apple-sign-in', () => ({
  SignInWithApple: { authorize: (...args) => mockAppleAuthorize(...args) },
}));

// The native Google sheet in the iOS app. Plain functions, not jest.fn, so the
// between-test mock reset leaves them answering.
jest.mock('@capgo/capacitor-social-login', () => ({
  SocialLogin: {
    initialize: () => Promise.resolve(),
    login: () => Promise.resolve({ result: { idToken: 'native-id-token' } }),
  },
}));

jest.mock('../components/ui/BirdieBird', () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, BirdieStill: Stub, BirdNote: Stub, WARM_BIRD: {} };
});

const api = require('../services/api');
const ProfileSettings = require('../screens/ProfileSettings').default;

const SRC = path.join(__dirname, '..');
const PROFILE_SRC = fs.readFileSync(path.join(SRC, 'screens', 'ProfileSettings.js'), 'utf8');

// Every parameter ProfileSettings takes, read off its own signature, so this
// harness cannot fall behind the screen's props. Each gets a neutral value of
// the kind its name says it is.
const PARAMS = (() => {
  const start = PROFILE_SRC.indexOf('export default function ProfileSettings({');
  const block = PROFILE_SRC.slice(start, PROFILE_SRC.indexOf('}) {', start));
  return [...block.matchAll(/^\s+([A-Za-z_]\w*),/gm)].map((m) => m[1]);
})();
const COMPONENTS = new Set(['DialogBehavior', 'ListSkeleton', 'SearchInputLocal', 'Toggle', 'BottomNav', 'SafetyButton']);
const ARRAYS = new Set(['blockedUsers', 'flocks', 'pendingRequests', 'trustedContacts', 'userInterests', 'suggestedInterests']);
function neutralProps() {
  const props = {};
  for (const name of PARAMS) {
    if (COMPONENTS.has(name)) props[name] = () => null;
    else if (ARRAYS.has(name)) props[name] = [];
    else if (name === 'showToast' || /^(set|handle|load|on[A-Z]|toggle|switch|confirm|open|needs|session|answer)/.test(name)) props[name] = jest.fn();
    else props[name] = undefined;
  }
  return {
    ...props,
    colors: {},
    styles: { card: {}, input: {}, gradientButton: {} },
    entitlements: {},
    PROFILE_SUBSCREEN_TITLES: {},
    deleteAlertRef: React.createRef(),
    newContact: {},
    profileScreen: 'main',
    sessionEndCopy: (reason) => `ended: ${reason}`,
    needsEmailVerification: () => false,
  };
}

// The dialog state lives in FlockAppInner; this holds it the same way, so the
// setters the screen calls are real ones.
function Harness({ authUser, onLogout, startWith = {} }) {
  const [deleteNeedsReauth, setDeleteNeedsReauth] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState('');
  const [deletingAccount, setDeletingAccount] = React.useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = React.useState(startWith.showDeleteAccount ?? true);
  const [deleteConfirmText, setDeleteConfirmText] = React.useState('DELETE');
  const [exportNeedsReauth, setExportNeedsReauth] = React.useState(startWith.exportNeedsReauth ?? false);
  const [exportError, setExportError] = React.useState('');
  const [showExportData, setShowExportData] = React.useState(startWith.showExportData ?? false);
  const props = {
    ...neutralProps(),
    authUser,
    onLogout,
    deleteNeedsReauth, setDeleteNeedsReauth,
    deleteError, setDeleteError,
    deletingAccount, setDeletingAccount,
    showDeleteAccount, setShowDeleteAccount,
    deleteConfirmText, setDeleteConfirmText,
    deletePassword: '', setDeletePassword: jest.fn(),
    exportNeedsReauth, setExportNeedsReauth,
    exportError, setExportError,
    showExportData, setShowExportData,
    exportPassword: '', setExportPassword: jest.fn(),
    exportingData: false,
    handleExportData: jest.fn(),
  };
  return React.createElement(ProfileSettings, props);
}

const reauthRefusal = () => Object.assign(new Error('For your security, sign in again and then delete your account.'), {
  status: 401, data: { reauthRequired: 'reauth' },
});
const asNativeIos = () => { window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' }; };
const asWeb = () => { delete window.Capacitor; };
const deleteButton = () => screen.getByRole('button', { name: 'Delete account, permanently' });
const APPLE_SHEET = { response: { identityToken: 'apple-id-token', authorizationCode: 'apple-code', user: 'apple-user' } };

beforeEach(() => {
  api.getProStatus.mockResolvedValue({});
  mockAppleAuthorize.mockResolvedValue(APPLE_SHEET);
});
afterEach(() => { asWeb(); });

describe('an Apple account deleting from the iOS app', () => {
  test('the 401 re-prompt, then Continue with Apple, then the same tap finishes', async () => {
    asNativeIos();
    const onLogout = jest.fn();
    api.deleteAccount.mockRejectedValueOnce(reauthRefusal()).mockResolvedValueOnce({ deleted: true });
    api.appleLogin.mockResolvedValue({ token: 'fresh', user: { id: 42 } });
    render(React.createElement(Harness, { authUser: { id: 42, sign_in_method: 'apple' }, onLogout }));

    fireEvent.click(deleteButton());
    await screen.findByText("Confirm it's you first");
    expect(screen.getByText(/For your security, confirm it's you with Apple\. Your account can still be deleted\./)).toBeInTheDocument();
    expect(screen.queryByText(/Sign out, sign back in/)).toBeNull();
    expect(deleteButton()).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue with Apple' }));
    await waitFor(() => expect(deleteButton()).not.toBeDisabled());
    // Marked as a re-confirmation, so it is not counted as a sign-in; what
    // that flag does is pinned in analyticsEvents.test.js.
    expect(api.appleLogin).toHaveBeenCalledWith('apple-id-token', undefined, 'apple-code', undefined, { reconfirm: true });
    expect(screen.queryByText("Confirm it's you first")).toBeNull();
    // The typed confirmation survived the trip, so one more tap is all it is.
    expect(screen.getByLabelText('Type DELETE to confirm')).toHaveValue('DELETE');
    expect(onLogout).not.toHaveBeenCalled();

    fireEvent.click(deleteButton());
    await waitFor(() => expect(onLogout).toHaveBeenCalledWith('ended: account_deleted'));
    expect(api.deleteAccount).toHaveBeenCalledTimes(2);
  });

  test('a different Apple ID never deletes anything: this device signs out instead', async () => {
    asNativeIos();
    const onLogout = jest.fn();
    api.deleteAccount.mockRejectedValueOnce(reauthRefusal());
    api.appleLogin.mockResolvedValue({ token: 'someone-else', user: { id: 77 } });
    render(React.createElement(Harness, { authUser: { id: 42, sign_in_method: 'apple' }, onLogout }));

    fireEvent.click(deleteButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Apple' }));
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
    expect(onLogout.mock.calls[0][0]).toMatch(/different Apple account, so Flock signed you out\. Nothing was deleted\./);
    expect(api.deleteAccount).toHaveBeenCalledTimes(1);
    expect(deleteButton()).toBeDisabled();
  });

  test('an Apple ID with no Flock account is told so, and the dialog stays shut', async () => {
    asNativeIos();
    const onLogout = jest.fn();
    api.deleteAccount.mockRejectedValueOnce(reauthRefusal());
    api.appleLogin.mockRejectedValue(Object.assign(new Error('Add your date of birth to continue.'), { status: 403, data: { needsDob: true } }));
    render(React.createElement(Harness, { authUser: { id: 42, sign_in_method: 'apple' }, onLogout }));

    fireEvent.click(deleteButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Apple' }));
    await screen.findByText(/That Apple account is not the one this Flock account uses/);
    expect(deleteButton()).toBeDisabled();
    expect(onLogout).not.toHaveBeenCalled();
  });

  test('a cancelled Apple sheet changes nothing and says nothing', async () => {
    asNativeIos();
    api.deleteAccount.mockRejectedValueOnce(reauthRefusal());
    mockAppleAuthorize.mockRejectedValue(new Error('The user canceled the authorization attempt. (1001)'));
    render(React.createElement(Harness, { authUser: { id: 42, sign_in_method: 'apple' }, onLogout: jest.fn() }));

    fireEvent.click(deleteButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with Apple' }));
    await waitFor(() => expect(mockAppleAuthorize).toHaveBeenCalled());
    expect(api.appleLogin).not.toHaveBeenCalled();
    expect(deleteButton()).toBeDisabled();
    expect(screen.getByText("Confirm it's you first")).toBeInTheDocument();
  });
});

describe('a Google account on the web', () => {
  test('Continue with Google in place clears the refusal', async () => {
    asWeb();
    api.deleteAccount.mockRejectedValueOnce(reauthRefusal());
    api.googleLoginWithToken.mockResolvedValue({ token: 'fresh', user: { id: 42 } });
    render(React.createElement(Harness, { authUser: { id: 42, sign_in_method: 'google' }, onLogout: jest.fn() }));

    fireEvent.click(deleteButton());
    await screen.findByText(/For your security, confirm it's you with Google\./);
    fireEvent.click(screen.getByRole('button', { name: /Continue with Google/ }));
    await waitFor(() => expect(deleteButton()).not.toBeDisabled());
    expect(api.googleLoginWithToken).toHaveBeenCalledWith('google-access-token', undefined, { reconfirm: true });
    expect(mockGoogleOptions).not.toBeNull();
  });
});

describe('a Google account in the iOS app', () => {
  test('the native sheet confirms in place, marked as a re-confirmation', async () => {
    asNativeIos();
    const prevIos = process.env.REACT_APP_GOOGLE_IOS_CLIENT_ID;
    const prevWeb = process.env.REACT_APP_GOOGLE_CLIENT_ID;
    process.env.REACT_APP_GOOGLE_IOS_CLIENT_ID = 'ios-client';
    process.env.REACT_APP_GOOGLE_CLIENT_ID = 'web-client';
    try {
      api.deleteAccount.mockRejectedValueOnce(reauthRefusal());
      api.googleLogin.mockResolvedValue({ token: 'fresh', user: { id: 42 } });
      render(React.createElement(Harness, { authUser: { id: 42, sign_in_method: 'google' }, onLogout: jest.fn() }));

      fireEvent.click(deleteButton());
      fireEvent.click(await screen.findByRole('button', { name: /Continue with Google/ }));
      await waitFor(() => expect(deleteButton()).not.toBeDisabled());
      expect(api.googleLogin).toHaveBeenCalledWith('native-id-token', undefined, { reconfirm: true });
    } finally {
      if (prevIos === undefined) delete process.env.REACT_APP_GOOGLE_IOS_CLIENT_ID;
      else process.env.REACT_APP_GOOGLE_IOS_CLIENT_ID = prevIos;
      if (prevWeb === undefined) delete process.env.REACT_APP_GOOGLE_CLIENT_ID;
      else process.env.REACT_APP_GOOGLE_CLIENT_ID = prevWeb;
    }
  });
});

describe('where the provider cannot run here', () => {
  test('an Apple account outside the iOS app keeps the sentence that still works', async () => {
    asWeb();
    api.deleteAccount.mockRejectedValueOnce(reauthRefusal());
    render(React.createElement(Harness, { authUser: { id: 42, sign_in_method: 'apple' }, onLogout: jest.fn() }));

    fireEvent.click(deleteButton());
    await screen.findByText('Sign in again first');
    expect(screen.getByText(/Sign out, sign back in, then come straight here\. Your account can still be deleted\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue with Apple' })).toBeNull();
  });
});

describe('the export sheet', () => {
  test('the same confirmation in place lets Get my data run again', async () => {
    asNativeIos();
    api.appleLogin.mockResolvedValue({ token: 'fresh', user: { id: 42 } });
    render(React.createElement(Harness, {
      authUser: { id: 42, sign_in_method: 'apple' },
      onLogout: jest.fn(),
      startWith: { showDeleteAccount: false, showExportData: true, exportNeedsReauth: true },
    }));

    expect(screen.getByText(/For your security, confirm it's you with Apple\. Then tap Get my data again\./)).toBeInTheDocument();
    const getMyData = screen.getByRole('button', { name: 'Get my data' });
    expect(getMyData).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Apple' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Get my data' })).not.toBeDisabled());
  });

  test('outside the iOS app an Apple account is told the way that still works', () => {
    asWeb();
    render(React.createElement(Harness, {
      authUser: { id: 42, sign_in_method: 'apple' },
      onLogout: jest.fn(),
      startWith: { showDeleteAccount: false, showExportData: true, exportNeedsReauth: true },
    }));
    expect(screen.getByText('Sign in again first')).toBeInTheDocument();
    expect(screen.getByText('For your security, sign out and back in, then try again.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue with Apple' })).toBeNull();
  });

  test('a different Apple ID ends the session and exports nothing', async () => {
    asNativeIos();
    const onLogout = jest.fn();
    api.appleLogin.mockResolvedValue({ token: 'someone-else', user: { id: 77 } });
    render(React.createElement(Harness, {
      authUser: { id: 42, sign_in_method: 'apple' },
      onLogout,
      startWith: { showDeleteAccount: false, showExportData: true, exportNeedsReauth: true },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Apple' }));
    await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(1));
    expect(onLogout.mock.calls[0][0]).toMatch(/Nothing was exported\./);
  });
});
