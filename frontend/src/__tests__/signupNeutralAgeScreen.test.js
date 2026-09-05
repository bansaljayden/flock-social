/**
 * THE SIGNUP DATE OF BIRTH, AND THE BIRTHDAY THE SCREEN USED TO HAND OUT.
 *
 * Both of Flock's signup doors, the consumer one in `SignupScreen` and the
 * venue operator's in `VenueLoginScreen`, used to cap the date picker at
 * exactly thirteen years ago, print the threshold directly above the field,
 * and refuse a younger date locally without ever calling the API. The effect of
 * that was not that under-13s were kept out. It was that a 12-year-old was
 * shown which birthday passes, typed one, and the app recorded that false date
 * as their real one. It also made the whole server-side under-13 flow in
 * backend/routes/auth.js, a faithful FTC neutral age screen with a refusal that
 * names no age and a 24 hour retry lockout, unreachable from the screens that
 * most needed it.
 *
 * The amended COPPA rule (16 CFR Part 312, compliance date 2026-04-22) codifies
 * the neutral age screen, and the FTC's guidance is explicit that the screen
 * must not encourage a child to falsify their age.
 *
 * WHY BOTH DOORS ARE IN ONE FILE
 * A half-applied policy is worse than either version applied consistently: two
 * doors that disagree about what the app knows is a third state nobody
 * designed. So the shared block below runs the same assertions against both,
 * and a screen that drifts back on its own fails here.
 *
 * WHAT THESE TESTS PIN
 *   - The field takes any date and the screen prints no threshold.
 *   - Someone 13 or older signs up exactly as they did before: same call, same
 *     arguments, same result. Nothing on these screens decides that they are 13.
 *   - A 12-year-old's real date is sent, and what comes back is the server's
 *     neutral sentence, shown as written.
 *   - Google and Apple send the date the same way the form does.
 *
 * WHAT THEY DELIBERATELY DO NOT ASSERT
 *   Anything about which dates the server accepts. That is not these screens'
 *   job any more, and it is pinned where it is decided, in
 *   backend/__tests__/minorsCompliance.test.js (the 13th-birthday boundary, the
 *   lockout, the Google and Apple creation paths). What the files share is the
 *   refusal sentence, which is read out of the server source below rather than
 *   copied, so the two cannot drift.
 *
 *   Nothing about the venue portal's SIGN-IN half either. Its date-of-birth
 *   read-back is a different question on an account that already exists, it is
 *   deliberately unchanged, and it is pinned in loginDobReadback.test.js.
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
const VenueLoginScreen = require('../components/auth/VenueLoginScreen').default;

const REPO = path.resolve(__dirname, '..', '..', '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
const SIGNUP_SRC = read('frontend', 'src', 'components', 'auth', 'SignupScreen.js');
const VENUE_SRC = read('frontend', 'src', 'components', 'auth', 'VenueLoginScreen.js');
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

// Comments explain the old arrangement by quoting it, so a threshold pin has to
// run on the code rather than on the file.
const codeOnly = (src) => src
  .split('\n')
  .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  .join('\n');

// ---------------------------------------------------------------------------
// The two doors. Everything below this runs against both.
// ---------------------------------------------------------------------------
const DOORS = [
  {
    label: 'the consumer signup screen',
    src: SIGNUP_SRC,
    fieldId: 'id="signup-dob"',
    hintId: 'signup-dob-hint',
    nameLabel: 'Name',
    open: () => {
      const onCreated = jest.fn();
      const utils = render(
        React.createElement(SignupScreen, { onSignupSuccess: onCreated, onSwitchToLogin: jest.fn() })
      );
      return { ...utils, onCreated };
    },
  },
  {
    label: 'the venue portal signup screen',
    src: VENUE_SRC,
    fieldId: 'id="venue-dob"',
    hintId: 'venue-dob-hint',
    nameLabel: 'Your name',
    open: () => {
      const onCreated = jest.fn();
      const utils = render(
        React.createElement(VenueLoginScreen, { onLoginSuccess: onCreated, onSwitchToUserLogin: jest.fn() })
      );
      // The portal opens on its sign-in half. The signup half is behind this.
      fireEvent.click(utils.getByText('Create an account'));
      return { ...utils, onCreated };
    },
  },
];

beforeEach(asWeb);
afterEach(asWeb);

DOORS.forEach((door) => {
  // Everything except the date, so each test says only what it is about.
  const fillEverythingBut = (utils) => {
    fireEvent.change(utils.getByLabelText(door.nameLabel), { target: { value: 'Sam' } });
    fireEvent.change(utils.getByLabelText('Email'), { target: { value: 'sam@example.com' } });
    fireEvent.change(utils.getByLabelText('Password'), { target: { value: 'Password1' } });
  };
  const setDate = (utils, value) =>
    fireEvent.change(utils.getByLabelText('Date of birth'), { target: { value } });
  const submit = (utils) => fireEvent.submit(utils.container.querySelector('form'));

  describe(`${door.label}: the field is neutral, it takes any date and teaches nothing`, () => {
    it('the date picker is not capped, so a truthful under-13 date can be entered', () => {
      const utils = door.open();
      expect(utils.getByLabelText('Date of birth').hasAttribute('max')).toBe(false);

      // Source too, because the rendered attribute would also be absent if the
      // field were replaced by something that computes the cap another way.
      const field = door.src.slice(door.src.indexOf(door.fieldId), door.src.indexOf(door.hintId));
      expect(field).not.toMatch(/max=/);
    });

    it('no threshold number is printed anywhere on the screen', () => {
      const utils = door.open();
      // The password rules are the only numbers this screen may print.
      const text = visibleText(utils.container);
      expect(text).not.toMatch(/\b13\b/);
      expect(text).not.toMatch(/or older/i);
      expect(text).not.toMatch(/at least \d+ to use/i);
      expect(text).not.toMatch(/must be \d+/i);
    });

    it('the hint says what the date is for, names no number, and stays described on the field', () => {
      const utils = door.open();
      const field = utils.getByLabelText('Date of birth');
      expect(field.getAttribute('aria-describedby')).toBe(door.hintId);
      const hint = utils.container.querySelector(`#${door.hintId}`);
      expect(hint.textContent).toMatch(/check your age/);
      expect(hint.textContent).not.toMatch(/\d/);
    });
  });

  describe(`${door.label}: nothing changes for someone 13 or older`, () => {
    it('the form sends the same four values it always did and the account is created', async () => {
      const dob = yearsAgo(13);
      api.signup.mockResolvedValueOnce({ user: { id: 7, name: 'Sam' } });

      const utils = door.open();
      fillEverythingBut(utils);
      setDate(utils, dob);
      submit(utils);

      await waitFor(() => expect(api.signup).toHaveBeenCalledTimes(1));
      expect(api.signup).toHaveBeenCalledWith('Sam', 'sam@example.com', 'Password1', dob);
      await waitFor(() => expect(utils.onCreated).toHaveBeenCalledWith({ id: 7, name: 'Sam' }));
    });

    it('the confirm-your-email screen still follows a signup that needs one', async () => {
      api.signup.mockResolvedValueOnce({ emailVerificationRequired: true });

      const utils = door.open();
      fillEverythingBut(utils);
      setDate(utils, yearsAgo(21));
      submit(utils);

      await waitFor(() => expect(utils.getByText('Confirm your email')).toBeTruthy());
      expect(utils.onCreated).not.toHaveBeenCalled();
    });

    it('the empty date is still answered on the device', async () => {
      const utils = door.open();
      fillEverythingBut(utils);
      submit(utils);

      await waitFor(() => expect(utils.getByRole('alert').textContent).toBe('Add your date of birth.'));
      expect(api.signup).not.toHaveBeenCalled();
    });
  });

  describe(`${door.label}: a 12 year old reaches the server, and the server answers`, () => {
    it('the real date is sent rather than refused on the device', async () => {
      const dob = yearsAgo(12);
      api.signup.mockRejectedValueOnce(refusal());

      const utils = door.open();
      fillEverythingBut(utils);
      setDate(utils, dob);
      submit(utils);

      // The date leaves the device exactly as typed. This is the whole point:
      // the old screen never made this call, so the age screen it was standing
      // in front of could only ever refuse a child who had already lied to it.
      await waitFor(() => expect(api.signup).toHaveBeenCalledTimes(1));
      expect(api.signup).toHaveBeenCalledWith('Sam', 'sam@example.com', 'Password1', dob);
      await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNDERAGE_MSG));
    });

    it('the second try with an older year is sent too, so the lockout is what answers it', async () => {
      api.signup.mockRejectedValueOnce(refusal());
      api.signup.mockRejectedValueOnce(refusal());

      const utils = door.open();
      fillEverythingBut(utils);
      setDate(utils, yearsAgo(12));
      submit(utils);
      await waitFor(() => expect(api.signup).toHaveBeenCalledTimes(1));

      // Back-button behaviour, on a screen that never unmounts: change the year
      // to one that passes and submit again. The screen does not remember
      // anything and does not need to. The server refused the first attempt,
      // recorded it, and answers the second with the same sentence, which is
      // the FTC FAQ's "keep the child from simply re-entering an older age".
      // That memory is pinned in backend/__tests__/minorsCompliance.test.js;
      // what is pinned here is that the client still asks, so the lockout is
      // reachable at all.
      setDate(utils, yearsAgo(30));
      submit(utils);
      await waitFor(() => expect(api.signup).toHaveBeenCalledTimes(2));
      expect(api.signup.mock.calls[1][3]).toBe(yearsAgo(30));
      await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNDERAGE_MSG));
    });

    it('the refusal is shown as the server wrote it, with nothing added', async () => {
      api.signup.mockRejectedValueOnce(refusal());

      const utils = door.open();
      fillEverythingBut(utils);
      setDate(utils, yearsAgo(9));
      submit(utils);

      await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNDERAGE_MSG));
      expect(visibleText(utils.container)).not.toMatch(/\b13\b/);
      expect(visibleText(utils.container)).not.toMatch(/or older/i);
    });
  });

  describe(`${door.label}: Google and Apple do exactly what the form does`, () => {
    it('Google carries an under-13 date to the server instead of stopping at the button', async () => {
      const dob = yearsAgo(12);
      api.googleLoginWithToken.mockRejectedValueOnce(refusal());

      const utils = door.open();
      setDate(utils, dob);
      fireEvent.click(utils.getByRole('button', { name: /continue with google/i }));

      await waitFor(() => expect(api.googleLoginWithToken).toHaveBeenCalledTimes(1));
      expect(api.googleLoginWithToken).toHaveBeenCalledWith('web-access-token', dob);
      await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNDERAGE_MSG));
    });

    it('Google with a date that passes signs the account in, unchanged', async () => {
      const dob = yearsAgo(20);
      api.googleLoginWithToken.mockResolvedValueOnce({ user: { id: 9 } });

      const utils = door.open();
      setDate(utils, dob);
      fireEvent.click(utils.getByRole('button', { name: /continue with google/i }));

      await waitFor(() => expect(api.googleLoginWithToken).toHaveBeenCalledWith('web-access-token', dob));
      await waitFor(() => expect(utils.onCreated).toHaveBeenCalledWith({ id: 9 }));
    });

    it('Google still asks for the date first, because the server requires one to create an account', async () => {
      const utils = door.open();
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

      const utils = door.open();
      setDate(utils, dob);
      fireEvent.click(utils.getByRole('button', { name: /continue with apple/i }));

      await waitFor(() => expect(api.appleLogin).toHaveBeenCalledTimes(1));
      expect(api.appleLogin.mock.calls[0][3]).toBe(dob);
      await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(UNDERAGE_MSG));
    });
  });

  describe(`${door.label}: a date nobody alive can have is a typo, not an age claim`, () => {
    // The server reads any date short of the minimum as knowledge that a child
    // is signing up, and remembers the mailbox for 24 hours. A mistyped year in
    // the future would therefore cost a real person their account for a day.
    // Refusing it here names no threshold and turns away no truthful date.
    const NOT_RIGHT = 'That date of birth does not look right. Check it and try again.';

    it('the form says the date does not look right and sends nothing', async () => {
      const utils = door.open();
      fillEverythingBut(utils);
      setDate(utils, yearsAhead(1));
      submit(utils);

      await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(NOT_RIGHT));
      expect(api.signup).not.toHaveBeenCalled();
    });

    it('Google says the same thing and never opens the provider', async () => {
      const utils = door.open();
      setDate(utils, yearsAhead(1));
      fireEvent.click(utils.getByRole('button', { name: /continue with google/i }));

      await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(NOT_RIGHT));
      expect(mockWebStart).not.toHaveBeenCalled();
      expect(api.googleLoginWithToken).not.toHaveBeenCalled();
    });

    it('Apple says the same thing and never opens the sheet', async () => {
      asNativeIos();
      const utils = door.open();
      setDate(utils, yearsAhead(1));
      fireEvent.click(utils.getByRole('button', { name: /continue with apple/i }));

      await waitFor(() => expect(utils.getByRole('alert').textContent).toBe(NOT_RIGHT));
      expect(mockAppleAuthorize).not.toHaveBeenCalled();
      expect(api.appleLogin).not.toHaveBeenCalled();
    });

    it('an empty date is stopped before the Apple sheet opens, the same as Google', async () => {
      // This used to pin the opposite: an empty date reached Apple so that an
      // existing Apple account could sign in from this screen. Reversed
      // 2026-09-05. Apple hands over the person's name on the first sheet
      // that completes and never again, and a new account's first tap with
      // no date was always refused (needsDob), so that tap spent the one
      // delivery and the retry named the account after a relay address. The
      // sentence is not an age claim: it asks for the field, not a threshold.
      // An existing Apple account signs in from the login screen, where the
      // button asks nothing. firstSessionAccountFixes.test.js pins the rest.
      asNativeIos();
      const utils = door.open();
      fireEvent.click(utils.getByRole('button', { name: /continue with apple/i }));

      await waitFor(() => expect(utils.getByRole('alert').textContent)
        .toBe('Add your date of birth above first, then continue with Apple.'));
      expect(mockAppleAuthorize).not.toHaveBeenCalled();
      expect(api.appleLogin).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Source pins, per door, because the two files hold the threshold differently.
// ---------------------------------------------------------------------------
describe('neither screen holds a second opinion on age', () => {
  it('the server refusal both screens rely on names no age either', () => {
    expect(UNDERAGE_MSG).not.toMatch(/\d/);
    expect(UNDERAGE_MSG).not.toMatch(/age|old|birth/i);
  });

  it('the consumer screen keeps no minimum-age constant and no local age refusal', () => {
    expect(SIGNUP_SRC).not.toMatch(/MIN_AGE/);
    expect(SIGNUP_SRC).not.toMatch(/maxDob/);
    // The one piece of age arithmetic left is dobLooksReal's "a living person
    // could have been born on this date" check, and it compares against zero.
    expect(SIGNUP_SRC).toMatch(/years !== null && years >= 0/);
    expect(codeOnly(SIGNUP_SRC)).not.toMatch(/\b13\b/);
  });

  it('the venue screen keeps MIN_AGE for its sign-in read-back and for nothing else', () => {
    expect(VENUE_SRC).not.toMatch(/maxDob/);
    expect(VENUE_SRC).toMatch(/years !== null && years >= 0/);
    expect(codeOnly(VENUE_SRC)).not.toMatch(/\b13\b/);

    // Two mentions survive: the import, and the line that decides whether the
    // SIGN-IN half shows its read-back panel. That panel is a different
    // question on an account that already exists, it is deliberately unchanged,
    // and a third mention would mean the signup half grew a gate again.
    const mentions = codeOnly(VENUE_SRC).split('\n').filter((line) => line.includes('MIN_AGE'));
    expect(mentions).toHaveLength(2);
    expect(mentions[0]).toMatch(/from '\.\/AuthShell'|ageFromDob/);
    expect(mentions[1]).toMatch(/venueDobAge < MIN_AGE/);
  });

  it('the venue sign-in half still draws its own hint, which is not an age hint', () => {
    // Rendered on the sign-in half only, and it warns that the date cannot be
    // changed later. That sentence is about permanence, not about a threshold,
    // and removing it would take a real warning off a real irreversible act.
    const signIn = render(
      React.createElement(VenueLoginScreen, { onLoginSuccess: jest.fn(), onSwitchToUserLogin: jest.fn() })
    );
    expect(visibleText(signIn.container)).not.toMatch(/\b13\b/);
    expect(VENUE_SRC).toMatch(/This is saved to your account and cannot be changed later/);
  });
});
