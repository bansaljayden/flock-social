/**
 * WHERE THE FORM COMES FIRST, A PROVIDER'S YEAR STEP KEEPS THE AGREEMENT AND
 * THE FORM'S ERROR BOX ON SCREEN.
 *
 * On a host where Apple is not offered (a preview deploy, a laptop), the
 * sign-up screen and the venue portal draw the email form first and the
 * providers under it. While a provider's year step is open the form steps
 * aside so there is one year field on screen. But two things inside the form
 * are not fields, and they went with it:
 *
 *   - the agreement ("Creating an account means you agree to..."). On the
 *     venue portal's sign-in half a brand-new Google account is answered 403
 *     needsDob with the proof held, the Google step opens, and the bar's
 *     Continue created the account with no agreement on screen;
 *   - the form's error box. A message meant for it, "Add the year you were
 *     born above first, then continue with Google.", was written into a box
 *     nobody could see, so the Google button looked dead.
 *
 * While a step is open both are now drawn outside the form: the box above the
 * step and the agreement under it, word for word. The providers-first layout
 * (the iPhone app, flockcorp.com) is unchanged, and is pinned at the bottom.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false formFirstYearStepKeepsAgreement
 */

const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react');

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

// The web half of Google: hands the config back so a tap fires the success
// callback the real library would fire, with no popup.
const mockWebStart = jest.fn();
jest.mock('@react-oauth/google', () => ({
  useGoogleLogin: (config) => {
    mockWebStart.mockImplementation(() => config.onSuccess({ access_token: 'web-access-token' }));
    return mockWebStart;
  },
}));

jest.mock('@capacitor-community/apple-sign-in', () => ({
  SignInWithApple: { authorize: jest.fn() },
}));

jest.mock('../components/auth/PasswordReset', () => ({
  ForgotPasswordScreen: () => null,
  ResetPasswordScreen: () => null,
  isPasswordResetRoute: () => false,
}));

// The web Google flow exists only in a build that carries a client id
// (useGoogleAuth reads it once, at load), so these load the module as one.
process.env.REACT_APP_GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID || 'web-client.apps.googleusercontent.com';
const api = require('../services/api');
const SignupScreen = require('../components/auth/SignupScreen').default;
const VenueLoginScreen = require('../components/auth/VenueLoginScreen').default;

// Guideline 1.2 and 5.1.1(ii): the words and the three pages, as every auth
// screen draws them (firstSessionAccountFixes.test.js holds the three source
// copies to one another).
const CONSENT_TEXT = 'Creating an account means you agree to the Terms, Privacy Policy, and Community Guidelines, including the product analytics they describe.';
const CONSENT_HREFS = [
  'https://www.flockcorp.com/terms',
  'https://www.flockcorp.com/privacy',
  'https://www.flockcorp.com/guidelines',
];
const YEAR_FIRST = 'Add the year you were born above first, then continue with Google.';
const STEP_LINE = 'One more step to finish your account: the year you were born.';

const httpError = (status, message, data) => Object.assign(new Error(message), { status, data });
const yearAsk = () => httpError(403,
  'No Flock account yet. Add the year you were born, then tap Continue with Google again.',
  { needsDob: true, dobGranularity: 'year' });

const googleButton = (utils) => utils.queryByRole('button', { name: /continue with google/i });
const appleButton = (utils) => utils.queryByRole('button', { name: /continue with apple/i });
const continueButton = (utils) => utils.queryByRole('button', { name: /^continue$/i });
const consents = (utils) => Array.from(utils.container.querySelectorAll('.auth-legal'));
const before = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

// The agreement, once, word for word, with its three pages, and not inside a
// form (there is none on screen while a step is open).
const expectAgreementOnScreen = (utils) => {
  const all = consents(utils);
  expect(all).toHaveLength(1);
  const [p] = all;
  expect(p.textContent).toBe(CONSENT_TEXT);
  expect(Array.from(p.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(CONSENT_HREFS);
  expect(p.closest('form')).toBeNull();
  expect(p.closest('.auth-sheet')).not.toBeNull();
  return p;
};

const openVenue = () => {
  const onLoginSuccess = jest.fn();
  const utils = render(React.createElement(VenueLoginScreen, { onLoginSuccess, onSwitchToUserLogin: jest.fn() }));
  return { ...utils, onLoginSuccess };
};

const openSignup = () => {
  const onSignupSuccess = jest.fn();
  const utils = render(React.createElement(SignupScreen, { onSignupSuccess, onSwitchToLogin: jest.fn() }));
  return { ...utils, onSignupSuccess };
};

// A sign-up half with the form first asks the year before Google, so the step
// opens there only when the server asks for the year after Google's sheet
// anyway. The step is drawn for whatever the server says, so it is opened
// here that way.
const openStepFromYearFirst = async (utils) => {
  fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '1990' } });
  api.googleLoginWithToken.mockRejectedValueOnce(yearAsk());
  fireEvent.click(googleButton(utils));
  await waitFor(() => expect(continueButton(utils)).not.toBeNull());
};

// The hold is spent (a lapsed token is a 401), so the step puts the Google
// button back with the year kept. Emptying the year and tapping Google then
// earns the sentence meant for the form's box.
const toRetapWithEmptyYear = async (utils) => {
  api.googleLoginWithToken.mockRejectedValueOnce(httpError(401, 'Google sign-in expired.'));
  fireEvent.click(continueButton(utils));
  await waitFor(() => expect(googleButton(utils)).not.toBeNull());
  expect(continueButton(utils)).toBeNull();
  fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '' } });
  fireEvent.click(googleButton(utils));
};

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  delete window.Capacitor;
});

describe('the venue portal, form first', () => {
  it('lays the form out first on this host, with no agreement on the sign-in half until it is needed', () => {
    const utils = openVenue();
    expect(appleButton(utils)).toBeNull();
    expect(before(utils.getByLabelText('Email'), googleButton(utils))).toBe(true);
    expect(consents(utils)).toHaveLength(0);
  });

  it('a brand-new Google account on the sign-in half: the step\'s Continue has the agreement on screen', async () => {
    const utils = openVenue();
    api.googleLoginWithToken.mockRejectedValueOnce(yearAsk());
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(continueButton(utils)).not.toBeNull());

    // The step is open and the form has stepped aside.
    expect(utils.getByText(STEP_LINE)).toBeTruthy();
    expect(utils.getByLabelText('Year of birth').id).toBe('venue-google-year');
    expect(utils.queryByLabelText('Email')).toBeNull();
    expect(utils.container.querySelector('form')).toBeNull();
    // Fails without the fix: the agreement was inside the form.
    const p = expectAgreementOnScreen(utils);
    // Under the step, between the year and Continue (which is in the bar).
    expect(before(utils.getByLabelText('Year of birth'), p)).toBe(true);
    expect(continueButton(utils).closest('.auth-actions')).not.toBeNull();
    // Nothing failed, so nothing is red.
    expect(utils.queryByRole('alert')).toBeNull();
  });

  it('that Continue then posts the same Google proof with the year, and the account is in', async () => {
    const utils = openVenue();
    api.googleLoginWithToken.mockRejectedValueOnce(yearAsk());
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(continueButton(utils)).not.toBeNull());

    fireEvent.change(utils.getByLabelText('Year of birth'), { target: { value: '1984' } });
    api.googleLoginWithToken.mockResolvedValueOnce({ user: { id: 41 } });
    fireEvent.click(continueButton(utils));
    await waitFor(() => expect(utils.onLoginSuccess).toHaveBeenCalledWith({ id: 41 }));
    expect(mockWebStart).toHaveBeenCalledTimes(1);
    expect(api.googleLoginWithToken.mock.calls[1]).toEqual(['web-access-token', '1984-12-31', { dobGranularity: 'year' }]);
  });

  it('leaving the step puts the form back, with the agreement inside it and drawn once', async () => {
    const utils = openVenue();
    api.googleLoginWithToken.mockRejectedValueOnce(yearAsk());
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(continueButton(utils)).not.toBeNull());
    fireEvent.click(utils.getByRole('button', { name: 'Sign in with email instead' }));
    expect(utils.getByLabelText('Email')).toBeTruthy();
    const all = consents(utils);
    expect(all).toHaveLength(1);
    expect(all[0].closest('form')).not.toBeNull();
  });

  it('on the sign-up half, the form\'s sentence shows while the step is open instead of going nowhere', async () => {
    const utils = openVenue();
    fireEvent.click(utils.getByRole('button', { name: 'Create an account' }));
    await openStepFromYearFirst(utils);
    expectAgreementOnScreen(utils);
    await toRetapWithEmptyYear(utils);
    // Fails without the fix: the sentence went into the hidden form's box,
    // and the Google button seemed to do nothing.
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(YEAR_FIRST));
    expect(utils.getByRole('alert').closest('form')).toBeNull();
    expect(mockWebStart).toHaveBeenCalledTimes(1);
    // The year field the sentence points "above" to is the step's, above the
    // Google button.
    expect(before(utils.getByLabelText('Year of birth'), googleButton(utils))).toBe(true);
    expectAgreementOnScreen(utils);
  });
});

describe('the sign-up screen, form first', () => {
  it('keeps the year-first ask it always had', async () => {
    const utils = openSignup();
    expect(appleButton(utils)).toBeNull();
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(YEAR_FIRST));
    expect(mockWebStart).not.toHaveBeenCalled();
    // The agreement closes the form, above Google.
    const [p] = consents(utils);
    expect(p.closest('form')).not.toBeNull();
    expect(before(p, googleButton(utils))).toBe(true);
  });

  it('while the Google step is open, the agreement is on screen under it, once', async () => {
    const utils = openSignup();
    await openStepFromYearFirst(utils);
    expect(utils.queryByLabelText('Name')).toBeNull();
    expect(utils.container.querySelector('form')).toBeNull();
    // Fails without the fix: the agreement went with the form.
    const p = expectAgreementOnScreen(utils);
    expect(before(utils.getByLabelText('Year of birth'), p)).toBe(true);
    expect(before(p, utils.getByRole('button', { name: 'Sign up with email instead' }))).toBe(true);
    expect(utils.queryByRole('alert')).toBeNull();
  });

  it('the form\'s sentence shows while the step is open, in a box on screen', async () => {
    const utils = openSignup();
    await openStepFromYearFirst(utils);
    await toRetapWithEmptyYear(utils);
    // Fails without the fix: showProviderError wrote into the hidden form's
    // box with the form first.
    await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(YEAR_FIRST));
    const box = utils.getByRole('alert');
    expect(box.closest('form')).toBeNull();
    // Above the step, where the form's box was.
    expect(before(box, utils.getByText(STEP_LINE))).toBe(true);
    // One box: the step's own was cleared by the tap.
    expect(utils.getAllByRole('alert')).toHaveLength(1);
    expect(mockWebStart).toHaveBeenCalledTimes(1);
  });

  it('Sign up with email instead brings the form back with the box empty and the agreement inside it', async () => {
    const utils = openSignup();
    await openStepFromYearFirst(utils);
    await toRetapWithEmptyYear(utils);
    await waitFor(() => expect(utils.getByRole('alert')).toBeTruthy());
    fireEvent.click(utils.getByRole('button', { name: 'Sign up with email instead' }));
    expect(utils.getByLabelText('Name')).toBeTruthy();
    expect(utils.queryByRole('alert')).toBeNull();
    const all = consents(utils);
    expect(all).toHaveLength(1);
    expect(all[0].closest('form')).not.toBeNull();
  });
});

describe('the providers-first layout is unchanged', () => {
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

  beforeEach(() => {
    onHost('www.flockcorp.com');
    // Apple's JS as the page sees it once loaded, so nothing is fetched.
    window.AppleID = { auth: { init: jest.fn(), signIn: jest.fn() } };
    api.getAppleNonce.mockResolvedValue({ nonce: 'n-1', expiresInSeconds: 600 });
  });

  afterEach(() => {
    delete window.AppleID;
    window.location = realLocation;
  });

  it('flockcorp.com, the venue sign-in half: one agreement under the providers, no extra box', async () => {
    const utils = openVenue();
    expect(before(appleButton(utils), utils.getByLabelText('Email'))).toBe(true);
    api.googleLoginWithToken.mockRejectedValueOnce(yearAsk());
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(continueButton(utils)).not.toBeNull());
    const all = consents(utils);
    expect(all).toHaveLength(1);
    expect(before(appleButton(utils), all[0])).toBe(true);
    expect(before(utils.getByLabelText('Year of birth'), all[0])).toBe(true);
    expect(utils.queryByRole('alert')).toBeNull();
  });

  it('flockcorp.com, the sign-up screen: one agreement above Apple, as before', async () => {
    const utils = openSignup();
    api.googleLoginWithToken.mockRejectedValueOnce(yearAsk());
    fireEvent.click(googleButton(utils));
    await waitFor(() => expect(continueButton(utils)).not.toBeNull());
    const all = consents(utils);
    expect(all).toHaveLength(1);
    expect(before(all[0], appleButton(utils))).toBe(true);
    expect(utils.queryByRole('alert')).toBeNull();
  });
});
