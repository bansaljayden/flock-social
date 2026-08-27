/**
 * TWO SCREENS THAT DESCRIBED SOMETHING THE SERVER HAD NOT DONE.
 *
 *   1. "WE SENT A LINK", WHEN THE SERVER SAID IT HAD NOT.
 *      `POST /api/auth/signup` answers with `verificationSent`, which is the
 *      server's own record of whether the mail left. It is false when the mail
 *      provider is missing or erroring, and also whenever the per-IP hourly
 *      send budget is spent, which on a shared school or campus connection is
 *      an ordinary Wednesday. Nothing on the client read it. The confirm
 *      screen said "We sent a link to you@example.com" either way, so somebody
 *      whose mail never left sat refreshing an inbox that would stay empty,
 *      unable to start a flock or add a friend, with the one button on the
 *      screen offering to send it "again".
 *
 *   2. "SEARCH BY NAME OR EMAIL", WHEN THE SERVER MATCHES NAMES.
 *      `GET /api/users/search` matches `users.name` and nothing else, and its
 *      own header comment says why: "no email exposure". A search box that
 *      offers an email promises a lookup that has never existed, and the
 *      person who types one gets "No users found" about a friend who is right
 *      there. Three call sites carried the claim.
 *
 * These are rendered rather than pinned wherever rendering reaches them, which
 * is the whole of the first one: both auth screens are ordinary components and
 * the branch under test is one flag. The search copy is a set of literal
 * strings spread across four files, so that half is a source sweep, and it is
 * a sweep over STRINGS ONLY. Comments are stripped first, because App.js is
 * full of prose that quotes the very copy being checked and a scan that cannot
 * tell code from prose reports whatever the prose says.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test honestSendAndSearchCopy --watchAll=false
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

jest.mock('@react-oauth/google', () => ({
  useGoogleLogin: () => jest.fn(),
}));

jest.mock('@capacitor-community/apple-sign-in', () => ({
  SignInWithApple: { authorize: jest.fn() },
}));

const api = require('../services/api');
const SignupScreen = require('../components/auth/SignupScreen').default;
const VenueLoginScreen = require('../components/auth/VenueLoginScreen').default;

const SRC = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const yearsAgo = (n) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().split('T')[0];
};

beforeEach(() => {
  jest.clearAllMocks();
  delete window.Capacitor;
});

/* ═══════════════════════════════════════════════════════════════════════════
   1. The confirm screen agrees with the server
   ═══════════════════════════════════════════════════════════════════════════ */

/** Drive the consumer signup form to its confirm screen. */
function signUpConsumer(signupReply) {
  api.signup.mockResolvedValueOnce(signupReply);
  const utils = render(
    React.createElement(SignupScreen, {
      onSignupSuccess: jest.fn(),
      onSwitchToLogin: jest.fn(),
    })
  );
  fireEvent.change(utils.getByLabelText('Name'), { target: { value: 'Sam' } });
  fireEvent.change(utils.getByLabelText('Email'), { target: { value: 'sam@example.com' } });
  fireEvent.change(utils.getByLabelText('Password'), { target: { value: 'Password1' } });
  fireEvent.change(utils.getByLabelText('Date of birth'), { target: { value: yearsAgo(25) } });
  fireEvent.submit(utils.container.querySelector('form'));
  return utils;
}

/** Drive the venue portal's registration form to the same screen. */
function signUpVenue(signupReply) {
  api.signup.mockResolvedValueOnce(signupReply);
  const utils = render(
    React.createElement(VenueLoginScreen, {
      onLoginSuccess: jest.fn(),
      onSwitchToSignup: jest.fn(),
      onSwitchToVenueLogin: jest.fn(),
    })
  );
  fireEvent.click(utils.getByText('Create an account'));
  fireEvent.change(utils.getByLabelText('Your name'), { target: { value: 'Sam' } });
  fireEvent.change(utils.getByLabelText('Email'), { target: { value: 'venue@example.com' } });
  fireEvent.change(utils.getByLabelText('Password'), { target: { value: 'Password1' } });
  fireEvent.change(utils.getByLabelText('Date of birth'), { target: { value: yearsAgo(30) } });
  fireEvent.submit(utils.container.querySelector('form'));
  return utils;
}

const SCREENS = [
  ['the signup screen', signUpConsumer],
  ['the venue portal', signUpVenue],
];

describe('what the confirm screen claims about the email', () => {
  SCREENS.forEach(([label, driveTo]) => {
    test(`${label} says a link was sent when the server sent one`, async () => {
      const utils = driveTo({ emailVerificationRequired: true, verificationSent: true });
      await waitFor(() => expect(utils.getByText(/confirm your email/i)).toBeTruthy());
      expect(utils.queryByText(/we sent a link/i)).not.toBeNull();
      expect(utils.queryByText(/did not go out/i)).toBeNull();
    });

    test(`${label} does NOT say a link was sent when the server says it was not`, async () => {
      // THE DEFECT. The browser suite asserts exactly this: the screen's claim
      // and `verificationSent` have to be the same answer.
      const utils = driveTo({ emailVerificationRequired: true, verificationSent: false });
      await waitFor(() => expect(utils.getByText(/confirm your email/i)).toBeTruthy());
      expect(utils.queryByText(/we sent a link/i)).toBeNull();
      // And it says what did happen, rather than going quiet.
      expect(utils.queryByText(/did not go out/i)).not.toBeNull();
      // A7: the honest no-send copy must STILL name the address, so a typo in
      // the email is recoverable and the person knows which inbox to fix. The
      // browser signup spec asserts the address is on this screen, and the
      // honest branch is exactly where it is easiest to drop.
      expect(utils.getByText(/did not go out/i).textContent).toMatch(/@example\.com/);
    });

    test(`${label} offers to send it, not to send it "again", when nothing was sent`, async () => {
      // "again" is a claim of its own, and it is the one the person is about
      // to disprove by looking in their inbox.
      const utils = driveTo({ emailVerificationRequired: true, verificationSent: false });
      await waitFor(() => expect(utils.getByText('Send the link')).toBeTruthy());
      expect(utils.queryByText('Send the link again')).toBeNull();
    });

    test(`${label} treats a reply with no such field as sent`, async () => {
      // A backend that predates the field is not a failed send, and reading
      // an absent field as false would tell every user of an older server
      // that their mail did not leave.
      const utils = driveTo({ emailVerificationRequired: true });
      await waitFor(() => expect(utils.getByText(/confirm your email/i)).toBeTruthy());
      expect(utils.queryByText(/we sent a link/i)).not.toBeNull();
    });

    test(`${label} stops saying it did not go out once a resend does`, async () => {
      // The resend route answers with the same flag. A send that works has to
      // be allowed to correct the screen, or the copy is stuck on a fact that
      // has stopped being true.
      const utils = driveTo({ emailVerificationRequired: true, verificationSent: false });
      const button = await waitFor(() => utils.getByText('Send the link'));
      api.resendVerificationEmail.mockResolvedValueOnce({ verificationSent: true });
      fireEvent.click(button);
      await waitFor(() => expect(utils.getByText(/sent\. check your inbox/i)).toBeTruthy());
      expect(utils.queryByText(/did not go out/i)).toBeNull();
    });

    test(`${label} does not claim a resend landed when the server says it did not`, async () => {
      const utils = driveTo({ emailVerificationRequired: true, verificationSent: false });
      const button = await waitFor(() => utils.getByText('Send the link'));
      api.resendVerificationEmail.mockResolvedValueOnce({ verificationSent: false });
      fireEvent.click(button);
      await waitFor(() => expect(utils.getByText(/did not go out either/i)).toBeTruthy());
      expect(utils.queryByText(/sent\. check your inbox/i)).toBeNull();
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. People search says what the server does
   ═══════════════════════════════════════════════════════════════════════════ */

/** Comments dropped, strings kept, so prose cannot pass or fail this sweep. */
function codeOnly(src) {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

// Every file that draws a people search box or describes one.
const SEARCH_FILES = [
  ['App.js', read('App.js')],
  ['components/NewDmModal.js', read('components', 'NewDmModal.js')],
  ['screens/AddFriends.js', read('screens', 'AddFriends.js')],
];

describe('the comment stripper is doing its job', () => {
  it('drops a line comment and a block comment, keeps a string', () => {
    const out = codeOnly([
      '// placeholder="Search by name or email..."',
      '/* aria-label="Search people by name or email" */',
      "const kept = 'Search by name...';",
    ].join('\n'));
    expect(out).not.toMatch(/or email/);
    expect(out).toContain("'Search by name...'");
  });
});

describe('nothing offers an email lookup the server cannot do', () => {
  it('the sweep is reading real files, not empty ones', () => {
    // The trap: a read that returns '' passes every "does not contain" check
    // below in perfect silence.
    SEARCH_FILES.forEach(([name, src]) => {
      expect(`${name}:${src.length > 2000}`).toBe(`${name}:true`);
    });
  });

  SEARCH_FILES.forEach(([name, src]) => {
    it(`${name} promises no email match in any string it renders`, () => {
      const code = codeOnly(src);
      expect(code).not.toMatch(/by name or email/);
      expect(code).not.toMatch(/or by the email they signed up with/);
    });
  });

  it('all three people search boxes are still labelled, by name', () => {
    // Two in App.js (the flock invite field and the Find Your People panel)
    // and one in the New Message sheet. Counted, so removing a label rather
    // than fixing it does not read as a pass.
    const app = codeOnly(read('App.js'));
    const dm = codeOnly(read('components', 'NewDmModal.js'));
    expect((app.match(/aria-label="Search people by name"/g) || []).length).toBe(2);
    expect((app.match(/placeholder="Search by name\.\.\."/g) || []).length).toBe(2);
    expect((dm.match(/aria-label="Search people by name"/g) || []).length).toBe(1);
    expect((dm.match(/placeholder="Search by name\.\.\."/g) || []).length).toBe(1);
  });

  it('the empty state does not send anyone looking for an email either', () => {
    const app = codeOnly(read('App.js'));
    expect(app).toContain('>Find friends by name<');
  });

  it('and the route this is describing really does match names only', () => {
    // If the server ever gains an email match, this goes red here and the copy
    // can be widened on purpose rather than by accident.
    const users = fs.readFileSync(
      path.join(SRC, '..', '..', 'backend', 'routes', 'users.js'),
      'utf8'
    );
    const at = users.indexOf("router.get('/search'");
    expect(at).toBeGreaterThan(-1);
    const route = users.slice(at, at + 6000);
    expect(route.length).toBe(6000);
    expect(route).not.toMatch(/email ILIKE/i);
  });
});
