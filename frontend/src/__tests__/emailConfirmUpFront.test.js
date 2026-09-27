/**
 * AN UNCONFIRMED ADDRESS IS SAID BEFORE IT IS NEEDED, AND NOTICED WHEN IT IS
 * DONE.
 *
 * Signup offers "Continue for now, confirm later". That door led to a Nest
 * whose two buttons, Start a flock and Add friends, are both refused by the
 * server until the link is opened (UNVERIFIED_DENY, backend/middleware/auth.js),
 * and nothing on the Nest or the create screen read authUser.email_verified.
 * The first anybody heard of it was the sheet a 403 raised, after a whole plan
 * had been filled in. And on iOS the link opens in Safari, so nothing in the
 * app noticed it had been opened: the sheet had a new link and Not now, and
 * no way to say "done".
 *
 * What is pinned:
 *   1. EmailConfirmLine, rendered: what it says, what it does not claim, and
 *      its two controls in each of their states.
 *   2. VerifyEmailSheet, rendered: it has the re-check now.
 *   3. App.js's checkEmailConfirmed, patchSessionUser and the foreground
 *      re-read, lifted out and executed against stand-ins.
 *   4. Where the line is drawn: the Nest, and the create screen above its
 *      form, from one element App.js builds only for an unconfirmed account.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test emailConfirmUpFront --watchAll=false
 */
const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, screen, fireEvent } = require('@testing-library/react');

const EmailConfirmLine = require('../components/EmailConfirmLine').default;
const VerifyEmailSheet = require('../components/VerifyEmailSheet').default;

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('App.js');
const CREATE = read('screens', 'CreateScreen.js');

// ═══════════════════════════════════════════════════════════════════════════
// 1. The line
// ═══════════════════════════════════════════════════════════════════════════

const lineProps = (over = {}) => ({
  email: 'maya@example.com',
  onResend: jest.fn(),
  onCheck: jest.fn(),
  cooldown: 0,
  refused: false,
  checking: false,
  note: '',
  ...over,
});

describe('the confirm line', () => {
  test('says what is waiting on the link and where the link goes', () => {
    render(React.createElement(EmailConfirmLine, lineProps()));
    const line = screen.getByTestId('email-confirm-line');
    expect(line.textContent).toContain('Confirm your email to start a flock or add friends. The link goes to maya@example.com.');
    // Where it goes, never that it was sent: whether the signup mail left is
    // known only to the signup screen.
    expect(line.textContent).not.toMatch(/we sent|in your inbox/i);
    expect(line.textContent).not.toContain('—');
  });

  test('without an address on the session it still says what is waiting', () => {
    render(React.createElement(EmailConfirmLine, lineProps({ email: '' })));
    const line = screen.getByTestId('email-confirm-line');
    expect(line.textContent).toContain('Confirm your email to start a flock or add friends.');
    expect(line.textContent).not.toContain('The link goes to');
  });

  test('Send the link and I\'ve confirmed each do their one thing', () => {
    const p = lineProps();
    render(React.createElement(EmailConfirmLine, p));
    fireEvent.click(screen.getByRole('button', { name: 'Send the link' }));
    expect(p.onResend).toHaveBeenCalledTimes(1);
    expect(p.onCheck).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: "I've confirmed" }));
    expect(p.onCheck).toHaveBeenCalledTimes(1);
  });

  test('a link asked for a moment ago counts down, and cannot be asked for again yet', () => {
    const p = lineProps({ cooldown: 42 });
    render(React.createElement(EmailConfirmLine, p));
    const resend = screen.getByRole('button', { name: 'Send it again in 42s' });
    expect(resend).toBeDisabled();
    fireEvent.click(resend);
    expect(p.onResend).not.toHaveBeenCalled();
  });

  test('an address mail cannot reach is said, and the button stops offering', () => {
    const p = lineProps({ refused: true, note: 'We cannot mail this address.' });
    render(React.createElement(EmailConfirmLine, p));
    expect(screen.getByRole('button', { name: 'We cannot mail that address' })).toBeDisabled();
    expect(screen.getByRole('status').textContent).toBe('We cannot mail this address.');
  });

  test('a check in flight says so and cannot be stacked', () => {
    const p = lineProps({ checking: true });
    render(React.createElement(EmailConfirmLine, p));
    const check = screen.getByRole('button', { name: 'Checking' });
    expect(check).toBeDisabled();
    fireEvent.click(check);
    expect(p.onCheck).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The sheet a refusal raises
// ═══════════════════════════════════════════════════════════════════════════

const sheetProps = (over = {}) => ({
  DialogBehavior: () => null,
  authUser: { id: 1, email: 'maya@example.com', email_verified: false },
  checkEmailConfirmedNow: jest.fn(),
  isDark: false,
  resendVerification: jest.fn(),
  setVerifyPrompt: jest.fn(),
  verifyChecking: false,
  verifyCooldown: 0,
  verifyNote: '',
  verifyPrompt: 'start a flock',
  verifyRefused: false,
  ...over,
});

describe('the verify sheet can be told the link was opened', () => {
  test('I\'ve confirmed re-checks the account', () => {
    const p = sheetProps();
    render(React.createElement(VerifyEmailSheet, p));
    fireEvent.click(screen.getByRole('button', { name: "I've confirmed" }));
    expect(p.checkEmailConfirmedNow).toHaveBeenCalledTimes(1);
    // It does not close the sheet itself: only a confirmed answer does, and
    // that is App.js clearing verifyPrompt.
    expect(p.setVerifyPrompt).not.toHaveBeenCalled();
  });

  test('while it checks, it says so and waits', () => {
    const p = sheetProps({ verifyChecking: true });
    render(React.createElement(VerifyEmailSheet, p));
    expect(screen.getByRole('button', { name: 'Checking' })).toBeDisabled();
  });

  test('the resend and Not now are still there', () => {
    const p = sheetProps();
    render(React.createElement(VerifyEmailSheet, p));
    fireEvent.click(screen.getByRole('button', { name: 'Send the link again' }));
    expect(p.resendVerification).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(p.setVerifyPrompt).toHaveBeenCalledWith(null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. App.js, lifted out and executed
// ═══════════════════════════════════════════════════════════════════════════

/* Both anchors are exact, so an edit that changes a handler's inputs breaks
   the lift loudly instead of testing a stale copy. */
function lift(open, close) {
  const start = APP.indexOf(open);
  if (start === -1) throw new Error(`lift: "${open}" moved`);
  const end = APP.indexOf(close, start);
  if (end === -1) throw new Error(`lift: the close after "${open}" moved`);
  return APP.slice(start + open.length, end);
}

const CHECK_BODY = lift('const checkEmailConfirmed = useCallback(', ', [patchSessionUser, showToast]);');
// The arrow handed to useStableFn, closed again: the anchor is the `});` that
// ends the call, so the arrow's own closing brace is put back here.
const PATCH_BODY = `${lift('const patchSessionUser = useStableFn(', '\n  });')}\n  }`;
const NEEDS_BODY = lift('const needsEmailVerification = useCallback(', ', [patchSessionUser]);');
// The effect's body, from its first statement to the line before its deps.
const FOREGROUND_BODY = (() => {
  const start = APP.indexOf('    if (!emailUnconfirmed) return undefined;');
  if (start === -1) throw new Error('lift: the foreground effect moved');
  const end = APP.indexOf('\n  }, [emailUnconfirmed, checkEmailConfirmed]);', start);
  if (end === -1) throw new Error('lift: the foreground effect deps moved');
  return APP.slice(start, end);
})();

function checkScope(over = {}) {
  return {
    verifyCheckInFlight: { current: false },
    setVerifyChecking: jest.fn(),
    setVerifyNote: jest.fn(),
    getCurrentUser: jest.fn().mockResolvedValue({ user: { id: 1, email_verified: true } }),
    patchSessionUser: jest.fn(),
    setVerifyPrompt: jest.fn(),
    showToast: jest.fn(),
    ...over,
  };
}

function makeCheck(s) {
  const names = Object.keys(s);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `return (${CHECK_BODY});`)(...names.map((n) => s[n]));
}

describe('checkEmailConfirmed, lifted out of App.js and executed', () => {
  test('the lift found the real handler', () => {
    expect(CHECK_BODY).toContain('getCurrentUser()');
    expect(CHECK_BODY.length).toBeGreaterThan(300);
  });

  test('a confirmed answer patches the session, closes the sheet and says so', async () => {
    const s = checkScope();
    await makeCheck(s)(false);
    expect(s.getCurrentUser).toHaveBeenCalledTimes(1);
    expect(s.patchSessionUser).toHaveBeenCalledWith({ email_verified: true });
    expect(s.setVerifyPrompt).toHaveBeenCalledWith(null);
    expect(s.showToast).toHaveBeenCalledWith('Your email is confirmed.');
    expect(s.setVerifyChecking).toHaveBeenLastCalledWith(false);
    expect(s.verifyCheckInFlight.current).toBe(false);
  });

  test('a tap on an account still unconfirmed is told so, and nothing is patched', async () => {
    const s = checkScope({ getCurrentUser: jest.fn().mockResolvedValue({ user: { id: 1, email_verified: false } }) });
    await makeCheck(s)(false);
    expect(s.patchSessionUser).not.toHaveBeenCalled();
    expect(s.setVerifyPrompt).not.toHaveBeenCalled();
    expect(s.setVerifyNote).toHaveBeenLastCalledWith('Not confirmed yet. Open the link in the email, then tap this again.');
  });

  test('the quiet read on coming back says nothing when the answer is still no', async () => {
    const s = checkScope({ getCurrentUser: jest.fn().mockResolvedValue({ user: { id: 1, email_verified: false } }) });
    await makeCheck(s)(true);
    expect(s.getCurrentUser).toHaveBeenCalledTimes(1);
    expect(s.setVerifyNote).not.toHaveBeenCalled();
    expect(s.setVerifyChecking).not.toHaveBeenCalled();
  });

  test('the quiet read still closes everything when the answer is yes', async () => {
    const s = checkScope();
    await makeCheck(s)(true);
    expect(s.patchSessionUser).toHaveBeenCalledWith({ email_verified: true });
    expect(s.showToast).toHaveBeenCalledWith('Your email is confirmed.');
  });

  test('a failed read is said on a tap, in the server\'s words, and swallowed on the quiet one', async () => {
    const failing = () => jest.fn().mockRejectedValue(Object.assign(new Error('You are offline.'), { isOffline: true }));
    const tap = checkScope({ getCurrentUser: failing() });
    await makeCheck(tap)(false);
    expect(tap.setVerifyNote).toHaveBeenLastCalledWith('You are offline.');
    expect(tap.verifyCheckInFlight.current).toBe(false);

    const quiet = checkScope({ getCurrentUser: failing() });
    await makeCheck(quiet)(true);
    expect(quiet.setVerifyNote).not.toHaveBeenCalled();
  });

  test('a quiet read stands aside for one already going; a tap does not', async () => {
    const quiet = checkScope({ verifyCheckInFlight: { current: true } });
    await makeCheck(quiet)(true);
    expect(quiet.getCurrentUser).not.toHaveBeenCalled();

    const tap = checkScope({ verifyCheckInFlight: { current: true } });
    await makeCheck(tap)(false);
    expect(tap.getCurrentUser).toHaveBeenCalledTimes(1);
  });
});

describe('the session copy is patched only when it would change', () => {
  const makePatch = (authUser, onUserPatch) =>
    // eslint-disable-next-line no-new-func
    new Function('authUser', 'onUserPatch', `return (${PATCH_BODY});`)(authUser, onUserPatch);

  test('a new fact is passed up', () => {
    const onUserPatch = jest.fn();
    makePatch({ id: 1, email_verified: true }, onUserPatch)({ email_verified: false });
    expect(onUserPatch).toHaveBeenCalledWith({ email_verified: false });
  });

  test('a fact the copy already holds is not: every patch is a new object and effects re-run on it', () => {
    const onUserPatch = jest.fn();
    makePatch({ id: 1, email_verified: false }, onUserPatch)({ email_verified: false });
    expect(onUserPatch).not.toHaveBeenCalled();
  });

  test('a 403 asking for a confirmed address marks the session unconfirmed and raises the sheet', () => {
    const s = { setVerifyNote: jest.fn(), setVerifyPrompt: jest.fn(), patchSessionUser: jest.fn() };
    // eslint-disable-next-line no-new-func
    const needs = new Function('setVerifyNote', 'setVerifyPrompt', 'patchSessionUser', `return (${NEEDS_BODY});`)(
      s.setVerifyNote, s.setVerifyPrompt, s.patchSessionUser
    );
    expect(needs({ data: { emailVerificationRequired: true } }, 'start a flock')).toBe(true);
    expect(s.setVerifyPrompt).toHaveBeenCalledWith('start a flock');
    expect(s.patchSessionUser).toHaveBeenCalledWith({ email_verified: false });

    const other = { setVerifyNote: jest.fn(), setVerifyPrompt: jest.fn(), patchSessionUser: jest.fn() };
    // eslint-disable-next-line no-new-func
    const needs2 = new Function('setVerifyNote', 'setVerifyPrompt', 'patchSessionUser', `return (${NEEDS_BODY});`)(
      other.setVerifyNote, other.setVerifyPrompt, other.patchSessionUser
    );
    expect(needs2({ status: 500, data: {} }, 'start a flock')).toBe(false);
    expect(other.patchSessionUser).not.toHaveBeenCalled();
  });
});

describe('coming back to the app re-reads an unconfirmed account', () => {
  function fakeTarget() {
    const listeners = {};
    return {
      visibilityState: 'visible',
      listeners,
      addEventListener: jest.fn((type, fn) => { (listeners[type] = listeners[type] || []).push(fn); }),
      removeEventListener: jest.fn((type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); }),
      fire(type) { (listeners[type] || []).forEach((fn) => fn()); },
    };
  }
  const runEffect = (emailUnconfirmed, checkEmailConfirmed, doc, win) =>
    // eslint-disable-next-line no-new-func
    new Function('emailUnconfirmed', 'checkEmailConfirmed', 'document', 'window', FOREGROUND_BODY)(
      emailUnconfirmed, checkEmailConfirmed, doc, win
    );

  test('a confirmed account adds no listener at all', () => {
    const doc = fakeTarget();
    const win = fakeTarget();
    expect(runEffect(false, jest.fn(), doc, win)).toBeUndefined();
    expect(doc.addEventListener).not.toHaveBeenCalled();
    expect(win.addEventListener).not.toHaveBeenCalled();
  });

  test('back from Safari: one quiet read for the focus and visibilitychange iOS fires together', () => {
    const doc = fakeTarget();
    const win = fakeTarget();
    const check = jest.fn();
    const cleanup = runEffect(true, check, doc, win);
    doc.fire('visibilitychange');
    win.fire('focus');
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(true);

    // Going to the background is not coming back.
    const hiddenDoc = fakeTarget();
    hiddenDoc.visibilityState = 'hidden';
    const check2 = jest.fn();
    runEffect(true, check2, hiddenDoc, fakeTarget());
    hiddenDoc.fire('visibilitychange');
    expect(check2).not.toHaveBeenCalled();

    cleanup();
    expect(doc.listeners.visibilitychange).toEqual([]);
    expect(win.listeners.focus).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Where it is drawn
// ═══════════════════════════════════════════════════════════════════════════

describe('the line is drawn on the Nest and above the create form', () => {
  test('App.js builds it only for an account the server calls unconfirmed', () => {
    expect(APP).toContain('const emailUnconfirmed = authUser?.email_verified === false;');
    expect(APP).toMatch(/const emailConfirmLine = emailUnconfirmed \? \(\n\s*<EmailConfirmLine\n/);
    // The sheet shows the note when it is open, so the line does not repeat
    // it underneath.
    expect(APP).toContain("note={verifyPrompt ? '' : verifyNote}");
    expect(APP).toContain('onResend={resendVerification}');
    expect(APP).toContain('onCheck={checkEmailConfirmedNow}');
  });

  test('the Nest draws it at the top of its feed, above the empty state', () => {
    const home = APP.slice(APP.indexOf('const HomeScreen = () => {'));
    const feed = home.indexOf('<div ref={feedScroll.home.ref}');
    const line = home.indexOf('{emailConfirmLine && <div');
    const empty = home.indexOf("'No flocks yet'");
    expect(feed).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(feed);
    expect(empty).toBeGreaterThan(line);
  });

  test('the create screen is handed the same element and draws it before the form', () => {
    const props = APP.slice(APP.indexOf('const createScreenProps = {'), APP.indexOf('};', APP.indexOf('const createScreenProps = {')));
    expect(props).toMatch(/\n\s*emailConfirmLine,\n/);
    const line = CREATE.indexOf('{emailConfirmLine && <div');
    const firstField = CREATE.indexOf('htmlFor="flock-name-input"');
    expect(line).toBeGreaterThan(-1);
    expect(firstField).toBeGreaterThan(line);
  });

  test('the sheet is handed the re-check', () => {
    const props = APP.slice(APP.indexOf('const verifyEmailSheetProps = {'), APP.indexOf('};', APP.indexOf('const verifyEmailSheetProps = {')));
    expect(props).toMatch(/\n\s*checkEmailConfirmedNow,\n/);
    expect(props).toMatch(/\n\s*verifyChecking,\n/);
  });
});
