/**
 * Accessibility of the consumer auth screens:
 *   src/components/auth/AuthShell.js
 *   src/components/auth/SignupScreen.js
 *   src/components/auth/LoginScreen.js
 *
 * These are the first screens every user meets. The flagged defect this file
 * exists to hold shut: the password-rule checklist encoded met/unmet purely
 * in colour and an aria-hidden glyph, so a screen reader heard "8 characters"
 * identically whether the rule was satisfied or not (WCAG 1.4.1). The fix is
 * per-rule visually-hidden state text; the tests below assert the announced
 * name, not the styling, so the visual design stays free to move.
 *
 * SHAPE OF THE FILE
 *   1. Contrast is COMPUTED from the exported AUTH tokens and the values
 *      parsed out of AuthShell's own stylesheet string, never asserted from
 *      a comment. jsdom resolves no cascade, so the tokens are the thing
 *      under test (same doctrine as legalPagesAccessibility.test.js).
 *   2. Behavioural assertions (labels, alerts, focus, toggle state) run
 *      against the rendered screens with the network and OAuth layers mocked.
 *   3. jsdom implements no layout and no :focus-visible, so hit-target and
 *      focus-ring rules are checked as source, and say so where they appear.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

const fs = require('fs');
const path = require('path');
const React = require('react');
const { render, fireEvent, waitFor } = require('@testing-library/react');

// CRA's jest config ships resetMocks: true, which strips implementations off
// jest.fn() before every test — behaviour is therefore set per-test with
// mock*ValueOnce, never in this factory.
jest.mock('../services/api', () => ({
  signup: jest.fn(),
  login: jest.fn(),
  googleLoginWithToken: jest.fn(),
  resendVerificationEmail: jest.fn(),
}));

jest.mock('@react-oauth/google', () => ({
  useGoogleLogin: () => jest.fn(),
}));

// Native-iOS only; renders null on web anyway, but mocking it keeps this file
// from depending on Capacitor detection.
jest.mock('../components/auth/AppleSignInButton', () => () => null);

jest.mock('../components/auth/PasswordReset', () => ({
  ForgotPasswordScreen: () => null,
  ResetPasswordScreen: () => null,
  isPasswordResetRoute: () => false,
}));

const AUTH_DIR = path.join(__dirname, '..', 'components', 'auth');
const src = (f) => fs.readFileSync(path.join(AUTH_DIR, f), 'utf8');

const SignupScreen = require('../components/auth/SignupScreen').default;
const LoginScreen = require('../components/auth/LoginScreen').default;
const { AUTH } = require('../components/auth/AuthShell');

const SHELL_SRC = src('AuthShell.js');
const SIGNUP_SRC = src('SignupScreen.js');
const LOGIN_SRC = src('LoginScreen.js');

// ───────────────────────────────────────────────────────────────────────────
// WCAG 2.x contrast, from the spec, so every number in a failure message is
// reproducible by hand.
// ───────────────────────────────────────────────────────────────────────────
const hexToRgb = (h) => {
  let s = h.replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const luminance = ([r, g, b]) => {
  const f = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
// Composite fg at alpha over an opaque bg (how a translucent border or tint
// actually renders).
const over = (fg, alpha, bg) => fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]);

// Values parsed out of AuthShell's stylesheet, so a palette edit there cannot
// silently detach these tests from what ships.
const parsed = (re, label) => {
  const m = re.exec(SHELL_SRC);
  if (!m) throw new Error(`Could not find ${label} in AuthShell.js`);
  return m[1];
};
const FIELD_BG = parsed(/\.auth-field \{[\s\S]*?background-color: (#[0-9a-f]{6}) !important/i, 'field background');
const FIELD_BORDER_ALPHA = Number(parsed(/border: 1px solid rgba\(244,\s*239,\s*227,\s*([\d.]+)\)/, 'field border alpha'));
const PLACEHOLDER = parsed(/\.auth-field::placeholder \{ color: (#[0-9a-f]{6})/i, 'placeholder colour');
const ERROR_TINT_ALPHA = Number(parsed(/\.auth-error \{[\s\S]*?background: rgba\(239,\s*68,\s*68,\s*([\d.]+)\)/, 'error tint alpha'));
const NOTICE_TINT_ALPHA = Number(parsed(/\.auth-notice \{[\s\S]*?background: rgba\(52,\s*211,\s*153,\s*([\d.]+)\)/, 'notice tint alpha'));

const sheet = hexToRgb(AUTH.sheet);
const fieldBg = hexToRgb(FIELD_BG);

describe('contrast, computed from the shipped tokens (1.4.3 text / 1.4.11 non-text)', () => {
  const cases = [
    // [label, fg, bg, minimum]
    ['h1 / primary text: cream on sheet', hexToRgb(AUTH.cream), sheet, 4.5],
    ['labels, hints, unmet checklist rows: cream2 on sheet', hexToRgb(AUTH.cream2), sheet, 4.5],
    ['met checklist rows: green on sheet', hexToRgb(AUTH.green), sheet, 4.5],
    ['error text on its composited surface', hexToRgb(AUTH.red), over(hexToRgb('#ef4444'), ERROR_TINT_ALPHA, sheet), 4.5],
    ['notice text on its composited surface', hexToRgb(AUTH.green), over(hexToRgb('#34d399'), NOTICE_TINT_ALPHA, sheet), 4.5],
    ['typed input text: cream on field background', hexToRgb(AUTH.cream), fieldBg, 4.5],
    ['placeholder + empty-date text on field background', hexToRgb(PLACEHOLDER), fieldBg, 4.5],
    ['primary button: navy on cream', hexToRgb(AUTH.navy), hexToRgb(AUTH.cream), 4.5],
    ['provider button: #1f1f1f on white', hexToRgb('#1f1f1f'), hexToRgb('#ffffff'), 4.5],
    ['focus ring: steel on sheet (non-text)', hexToRgb(AUTH.steel), sheet, 3],
    ['focused field border: steel on field background (non-text)', hexToRgb(AUTH.steel), fieldBg, 3],
    ['eye toggle icon: cream2 on field background (non-text)', hexToRgb(AUTH.cream2), fieldBg, 3],
    ['field boundary: composited border on sheet (non-text)', over(hexToRgb('#f4efe3'), FIELD_BORDER_ALPHA, fieldBg), sheet, 3],
  ];
  it.each(cases)('%s', (label, fg, bg, min) => {
    const ratio = contrast(fg, bg);
    expect(ratio).toBeGreaterThanOrEqual(min);
  });
});

describe('password-rule checklist announces met/unmet (1.4.1)', () => {
  it('each rule carries its state in its accessible text, not only in colour', () => {
    const { container, getByLabelText, getAllByRole } = render(
      React.createElement(SignupScreen, { onSignupSuccess: () => {}, onSwitchToLogin: () => {} })
    );

    const pw = getByLabelText('Password');
    fireEvent.change(pw, { target: { value: 'abc' } });

    let rows = getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toMatch(/8 characters, not met yet/);
    expect(rows[1].textContent).toMatch(/One uppercase letter, not met yet/);
    expect(rows[2].textContent).toMatch(/One number, not met yet/);

    fireEvent.change(pw, { target: { value: 'Abcdefg1' } });
    rows = getAllByRole('listitem');
    expect(rows[0].textContent).toMatch(/8 characters, met/);
    expect(rows[1].textContent).toMatch(/One uppercase letter, met/);
    expect(rows[2].textContent).toMatch(/One number, met/);

    // The glyph is decorative (state lives in text), and met/unmet are two
    // different SHAPES from the icon system, so the sighted signal is not
    // colour-only either. 'abcdefgh' satisfies rule 1 only, giving one row of
    // each state to compare.
    fireEvent.change(pw, { target: { value: 'abcdefgh' } });
    const rowsMixed = getAllByRole('listitem');
    expect(rowsMixed[0].textContent).toMatch(/8 characters, met/);
    expect(rowsMixed[1].textContent).toMatch(/One uppercase letter, not met yet/);
    const metD = rowsMixed[0].querySelector('svg.flock-icon path').getAttribute('d');
    const unmetD = rowsMixed[1].querySelector('svg.flock-icon path').getAttribute('d');
    expect(metD).toBeTruthy();
    expect(unmetD).toBeTruthy();
    expect(metD).not.toEqual(unmetD);
    rowsMixed.forEach((r) => {
      expect(r.querySelector('[aria-hidden="true"] svg')).toBeTruthy();
    });

    // The list is named, so arrowing into it has context.
    expect(container.querySelector('ul[aria-label="Password requirements"]')).toBeTruthy();
  });

  it('the empty password field already describes the full rule set', () => {
    const { getByLabelText, container } = render(
      React.createElement(SignupScreen, { onSignupSuccess: () => {}, onSwitchToLogin: () => {} })
    );
    const pw = getByLabelText('Password');
    const describedBy = pw.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const desc = container.querySelector(`#${describedBy}`);
    expect(desc.textContent).toMatch(/8 characters/);
    expect(desc.textContent).toMatch(/uppercase/);
    expect(desc.textContent).toMatch(/number/);
  });
});

describe('icon-system convergence (no hand-rolled auth glyphs)', () => {
  // /<svg\s/ = a JSX element opening with attributes; prose in comments
  // writes "<svg>" and stays exempt.
  it('SignupScreen and LoginScreen contain no inline <svg>', () => {
    expect(SIGNUP_SRC).not.toMatch(/<svg\s/);
    expect(LOGIN_SRC).not.toMatch(/<svg\s/);
  });

  it('AuthShell keeps exactly one inline <svg>: the official Google artwork', () => {
    const count = (SHELL_SRC.match(/<svg\s/g) || []).length;
    expect(count).toBe(1);
    // and it is the brand mark, not a drawn control
    expect(/GoogleG[\s\S]{0,200}<svg\s/.test(SHELL_SRC)).toBe(true);
  });

  // Cap/join style is the icon system's own contract (it changed once already,
  // 2026-08); what the auth surface owes is to draw NOTHING with local stroke
  // geometry, so no strokeLinecap should appear here under any value.
  it('no locally drawn stroke geometry on the auth surface', () => {
    for (const s of [SHELL_SRC, SIGNUP_SRC, LOGIN_SRC]) {
      expect(s).not.toMatch(/strokeLinecap/);
    }
  });

  it('the eye toggle renders system icons and flips its pressed state', () => {
    const { getByRole, getByLabelText } = render(
      React.createElement(LoginScreen, {
        onLoginSuccess: () => {}, onSwitchToSignup: () => {}, onSwitchToVenueLogin: () => {},
      })
    );
    const toggle = getByRole('button', { name: 'Show password' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    // .flock-icon = drawn by Icons.js, whatever caps that system currently uses
    expect(toggle.querySelector('svg.flock-icon')).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(getByLabelText('Password').getAttribute('type')).toBe('text');
    // the shown state is the struck eye from Icons.js, not a local drawing
    const ds = Array.from(toggle.querySelectorAll('svg path')).map((p) => p.getAttribute('d'));
    expect(ds).toContain('M5 19 19 5');
  });
});

describe('labels and autocomplete (1.3.1 / 1.3.5 / 3.3.2)', () => {
  it('every signup input has a real, programmatically associated label', () => {
    const { getByLabelText } = render(
      React.createElement(SignupScreen, { onSignupSuccess: () => {}, onSwitchToLogin: () => {} })
    );
    expect(getByLabelText('Name').tagName).toBe('INPUT');
    expect(getByLabelText('Email').tagName).toBe('INPUT');
    expect(getByLabelText('Date of birth').tagName).toBe('INPUT');
    expect(getByLabelText('Password').tagName).toBe('INPUT');

    expect(getByLabelText('Name').getAttribute('autocomplete')).toBe('name');
    expect(getByLabelText('Email').getAttribute('autocomplete')).toBe('email');
    expect(getByLabelText('Date of birth').getAttribute('autocomplete')).toBe('bday');
    expect(getByLabelText('Password').getAttribute('autocomplete')).toBe('new-password');

    // The age-gate hint is described ON the field, not just near it.
    expect(getByLabelText('Date of birth').getAttribute('aria-describedby')).toBe('signup-dob-hint');
  });

  it('login pairs username with current-password, the way password managers key a credential', () => {
    const { getByLabelText } = render(
      React.createElement(LoginScreen, {
        onLoginSuccess: () => {}, onSwitchToSignup: () => {}, onSwitchToVenueLogin: () => {},
      })
    );
    expect(getByLabelText('Email').getAttribute('autocomplete')).toBe('username');
    expect(getByLabelText('Password').getAttribute('autocomplete')).toBe('current-password');
  });
});

describe('error announcement and focus management (3.3.1 / 4.1.3)', () => {
  it('a failed signup submit raises role=alert and moves focus to it', async () => {
    const { container, getByRole } = render(
      React.createElement(SignupScreen, { onSignupSuccess: () => {}, onSwitchToLogin: () => {} })
    );
    fireEvent.submit(container.querySelector('form'));
    await waitFor(() => {
      const alert = getByRole('alert');
      // The FIRST empty field, which on an untouched form is Name. This
      // assertion used to read /password is missing a requirement/, because
      // handleSubmit graded the password before it noticed the four empty
      // fields above it, and an empty form was answered with a complaint
      // about a password nobody had typed.
      expect(alert.textContent).toMatch(/name your friends know you by/i);
      expect(alert.getAttribute('tabindex')).toBe('-1');
      expect(document.activeElement).toBe(alert);
    });
  });

  // The regression this file now exists to hold shut, alongside the 1.4.1 one
  // in the header. Every field on these forms carries `required`, and iOS
  // WKWebView draws NO validation bubble: the submit is refused and nothing
  // appears. Production PostHog measured the result over 90 days. The largest
  // $dead_click cluster in the whole product was the signup screen inside the
  // native app, five of them on the Create account button itself, against
  // 1,792 pageviews and 6 signups.
  //
  // noValidate is what makes handleSubmit the only gate, and handleSubmit
  // always renders a message. Deleting the attribute silently restores a
  // primary button that does nothing, which is also App Store rejection
  // ground (SLOP-AUDIT K1, "every single button must work"), so it is pinned
  // here rather than left to review.
  it('every auth form disables native validation, so the button can never silently do nothing', () => {
    const forms = [
      ['signup', React.createElement(SignupScreen, { onSignupSuccess: () => {}, onSwitchToLogin: () => {} })],
      ['login', React.createElement(LoginScreen, {
        onLoginSuccess: () => {}, onSwitchToSignup: () => {}, onSwitchToVenueLogin: () => {},
      })],
    ];
    forms.forEach(([name, element]) => {
      const { container, unmount } = render(element);
      const form = container.querySelector('form');
      expect(form).not.toBeNull();
      expect(form.hasAttribute('novalidate')).toBe(true);
      // A field still carrying `required` is fine and desirable: it keeps the
      // semantics for assistive tech. It just must not be the thing deciding
      // whether the submit happens.
      unmount();
      expect(name).toBeTruthy();
    });
  });

  it('signup names the offending field in order down the form, not the last rule checked', async () => {
    const { container, getByLabelText, getByRole } = render(
      React.createElement(SignupScreen, { onSignupSuccess: () => {}, onSwitchToLogin: () => {} })
    );
    const submit = () => fireEvent.submit(container.querySelector('form'));

    submit();
    await waitFor(() => expect(getByRole('alert').textContent).toMatch(/name your friends know you by/i));

    fireEvent.change(getByLabelText('Name'), { target: { value: 'Sam' } });
    submit();
    await waitFor(() => expect(getByRole('alert').textContent).toMatch(/add your email address/i));

    fireEvent.change(getByLabelText('Email'), { target: { value: 'not-an-email' } });
    submit();
    await waitFor(() => expect(getByRole('alert').textContent).toMatch(/does not look right/i));

    fireEvent.change(getByLabelText('Email'), { target: { value: 'sam@example.com' } });
    submit();
    await waitFor(() => expect(getByRole('alert').textContent).toMatch(/add your date of birth/i));

    fireEvent.change(getByLabelText('Date of birth'), { target: { value: '2000-01-01' } });
    submit();
    await waitFor(() => expect(getByRole('alert').textContent).toMatch(/choose a password/i));

    // Only once everything above it is filled does the password checklist get
    // to be the complaint.
    fireEvent.change(getByLabelText('Password'), { target: { value: 'short' } });
    submit();
    await waitFor(() => expect(getByRole('alert').textContent).toMatch(/password is missing a requirement/i));
  });

  it('an empty sign-in submit says which field is missing instead of doing nothing', async () => {
    const { container, getByLabelText, getByRole } = render(
      React.createElement(LoginScreen, {
        onLoginSuccess: () => {}, onSwitchToSignup: () => {}, onSwitchToVenueLogin: () => {},
      })
    );
    fireEvent.submit(container.querySelector('form'));
    await waitFor(() => expect(getByRole('alert').textContent).toMatch(/email address you signed up with/i));

    fireEvent.change(getByLabelText('Email'), { target: { value: 'sam@example.com' } });
    fireEvent.submit(container.querySelector('form'));
    await waitFor(() => expect(getByRole('alert').textContent).toMatch(/add your password/i));

    // And the network was never touched for either of those.
    expect(require('../services/api').login).not.toHaveBeenCalled();
  });

  it('a rejected login lands the server message in the alert, focused', async () => {
    require('../services/api').login.mockRejectedValueOnce(new Error('Wrong email or password'));
    const { container, getByLabelText, getByRole } = render(
      React.createElement(LoginScreen, {
        onLoginSuccess: () => {}, onSwitchToSignup: () => {}, onSwitchToVenueLogin: () => {},
      })
    );
    fireEvent.change(getByLabelText('Email'), { target: { value: 'a@b.co' } });
    fireEvent.change(getByLabelText('Password'), { target: { value: 'nope' } });
    fireEvent.submit(container.querySelector('form'));
    await waitFor(() => {
      const alert = getByRole('alert');
      expect(alert.textContent).toMatch(/wrong email or password/i);
      expect(document.activeElement).toBe(alert);
    });
  });
});

describe('targets, focus visibility, zoom floor (2.5.5 / 2.4.7 / source-level: jsdom has no layout)', () => {
  it('the eye toggle owns a real 44px box plus the .hit44 overlay', () => {
    expect(SHELL_SRC).toMatch(/\.auth-eye \{[\s\S]*?width: 44px; height: 44px;/);
    const { getByRole } = render(
      React.createElement(LoginScreen, {
        onLoginSuccess: () => {}, onSwitchToSignup: () => {}, onSwitchToVenueLogin: () => {},
      })
    );
    expect(getByRole('button', { name: 'Show password' }).className).toMatch(/\bhit44\b/);
    expect(getByRole('button', { name: 'Forgot password?' }).className).toMatch(/\bhit44\b/);
  });

  it('the sheet defines its own visible :focus-visible ring (the global blue fails on this navy)', () => {
    expect(SHELL_SRC).toMatch(/button:focus-visible[\s\S]{0,200}outline: 2px solid/);
  });

  it('inputs hold the 16px iOS zoom floor', () => {
    expect(SHELL_SRC).toMatch(/\.auth-field \{[\s\S]*?font-size: 16px/);
  });

  it('the backdrop stays out of the accessibility tree and the tab order', () => {
    const { container } = render(
      React.createElement(LoginScreen, {
        onLoginSuccess: () => {}, onSwitchToSignup: () => {}, onSwitchToVenueLogin: () => {},
      })
    );
    const bg = container.querySelector('.auth-bg');
    expect(bg.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('video').getAttribute('tabindex')).toBe('-1');
  });
});

// ---------------------------------------------------------------------------
// The venue portal is an auth screen too, and it went a round without one.
//
// AUDIT 2026-08-26. LoginScreen has carried "Forgot password?" since the reset
// flow shipped. VenueLoginScreen, the front door of the product Flock charges
// for, had no route back into a forgotten account at all: the exits were
// guessing the password or writing to us. A venue account is signed into
// rarely, which is the kind people forget, and the person locked out is a
// paying customer.
//
// Only the REQUEST half belongs here. The emailed link lands on
// /reset-password, which the app routes to LoginScreen for anyone with no
// session, and that screen already consumes it.
// ---------------------------------------------------------------------------
const VenueLoginScreen = require('../components/auth/VenueLoginScreen').default;

describe('the venue portal has a way out of a forgotten password', () => {
  const mountVenue = () => render(
    React.createElement(VenueLoginScreen, {
      onLoginSuccess: () => {}, onSwitchToUserLogin: () => {},
    })
  );

  it('offers it beside the password label on the sign-in half', () => {
    const { getByRole } = mountVenue();
    expect(getByRole('button', { name: 'Forgot password?' }).className).toMatch(/\bhit44\b/);
  });

  // This file stubs PasswordReset to null (see the mock at the top), so what is
  // asserted is that the press LEAVES the sign-in form for the reset flow. The
  // request screen's own copy rule, that it never confirms whether an address
  // has an account, is tested where that screen is real.
  it('pressing it leaves the sign-in form for the reset flow', () => {
    const { getByRole, queryByRole, queryByLabelText } = mountVenue();
    fireEvent.click(getByRole('button', { name: 'Forgot password?' }));
    expect(queryByRole('button', { name: 'Forgot password?' })).toBeNull();
    expect(queryByLabelText('Email')).toBeNull();
  });

  it('it is the shared reset screen, not a second copy of the flow', () => {
    const venueSrc = src('VenueLoginScreen.js');
    expect(venueSrc).toContain("import { ForgotPasswordScreen } from './PasswordReset'");
    expect(venueSrc).toContain('<ForgotPasswordScreen');
  });

  it('the signup half does not offer it, because a new account has no password to forget', () => {
    const { getByRole, queryByRole } = mountVenue();
    fireEvent.click(getByRole('button', { name: 'Create an account' }));
    expect(queryByRole('button', { name: 'Forgot password?' })).toBeNull();
  });
});
