import React, { useState, useEffect } from 'react';
import { login, trackAuthScreen, RESET_DONE_KEY } from '../../services/api';
import useGoogleAuth, { isGoogleSignInAvailable } from './useGoogleAuth';
import AppleSignInButton from './AppleSignInButton';
import AuthShell, {
  ageFromDob, AuthError, AuthLabelRow, AuthNotice, AuthRule, formatDob, GoogleG, MIN_AGE, PasswordEye,
} from './AuthShell';
import {
  ForgotPasswordScreen, ResetPasswordScreen, isPasswordResetRoute,
} from './PasswordReset';

// The same three pages SignupScreen links, for the consent line below.
const TERMS_URL = 'https://www.flockcorp.com/terms';
const PRIVACY_URL = 'https://www.flockcorp.com/privacy';
const GUIDELINES_URL = 'https://www.flockcorp.com/guidelines';

const LoginScreen = ({ onLoginSuccess, onSwitchToSignup, onSwitchToVenueLogin }) => {
  // The password-reset screens hang off this one rather than off App.js: the
  // emailed link lands on /reset-password, index.js sends every unknown path to
  // the app, and the app renders this screen for anyone without a session. So
  // this component is already the thing on screen when the link is opened, and
  // it can route to the reset screen itself. Nothing in App.js needs to know.
  const [view, setView] = useState(() => (isPasswordResetRoute() ? 'reset' : 'login'));
  // Carried back from the reset flow, e.g. "Your password is set. Sign in."
  const [notice, setNotice] = useState('');

  // The arrival event for the login form, and only the login form: this
  // component also hosts the password-reset screens, so a /reset-password
  // landing must not be counted as a sign-in view. Fires whenever the login
  // view is the one actually on screen.
  useEffect(() => { if (view === 'login') trackAuthScreen('login'); }, [view]);

  // The standalone /reset-password page finishes with a full navigation to
  // /app, which cannot carry the onSignIn({ updated: true }) the in-app flow
  // passes. Read once and clear, so the notice appears exactly on the load that
  // followed the reset and never again.
  useEffect(() => {
    let flagged = false;
    try {
      flagged = sessionStorage.getItem(RESET_DONE_KEY) === '1';
      if (flagged) sessionStorage.removeItem(RESET_DONE_KEY);
    } catch { /* private mode */ }
    if (flagged) setNotice('Password updated. Sign in with the new one.');
  }, []);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Legacy accounts created before the age gate have no DOB on file. The
  // backend answers 403 {needsDob: true}; we collect a date and retry.
  const [needsDob, setNeedsDob] = useState(false);
  const [dob, setDob] = useState('');
  // The exact date the user has confirmed is not a typo. Held as the VALUE and
  // not as a boolean, so editing the field after confirming asks again instead
  // of carrying an old yes onto a new date.
  const [dobConfirmed, setDobConfirmed] = useState('');

  // -------------------------------------------------------------------------
  // WHY A DATE TYPED HERE IS NOT THE SAME AS A DATE TYPED ON SIGNUP
  //
  // This field is not a signup question. It appears on an account that already
  // exists, after a password has been checked or a provider token verified,
  // and what the server does with an under-13 date on this path is not "refuse
  // to create an account". It is enforceDobOnLogin in backend/routes/auth.js:
  // the date is WRITTEN to the row, token_version is bumped, every live
  // session is revoked, and every later sign-in is refused by the stored-age
  // freeze at the top of that same function. There is no undo, and no screen
  // anywhere in the app can edit a date of birth once it is stored.
  //
  // So one mistyped year on THIS field ends a real account and every flock in
  // it. A 16-year-old reaching for 2009 and landing on 2019 was one tap from
  // that, with nothing said and nothing to confirm.
  //
  // The fix is a read-back, not a cap. A cap would silently prevent the app
  // recording the one fact the law says cannot be un-known once we have it,
  // and the signup screen no longer carries one either: it used to cap its
  // picker at thirteen years ago and print the threshold above the field,
  // which is the arrangement that tells a child which birthday to type. Both
  // screens now take any date and let the server answer. An appeal line is not
  // the answer either. The server treats a date asserted on this path as
  // knowledge because the caller has just proved they hold the account, and
  // there is no staffed channel behind an "email us" sentence to make a
  // promise of review true.
  //
  // What is left is the honest one. Before an irreversible refusal, show the
  // date back in words and make the person say it is right. The refusal, the
  // freeze and the server are all unchanged, and an honest 12-year-old reaches
  // exactly the same outcome one tap later. The panel names no age and no
  // rule, for the reason set out above the age gate in backend/routes/auth.js:
  // a refusal that teaches which birthday gets in is not a neutral age screen.
  // -------------------------------------------------------------------------
  const dobAge = ageFromDob(dob);
  const dobUnderMin = dobAge !== null && dobAge < MIN_AGE;
  const dobNeedsCheck = needsDob && dobUnderMin && dobConfirmed !== dob;

  // Custom-styled Google button (the rendered GIS button ignores dark theming
  // when it shows the personalized "Continue as ..." variant). The hook picks
  // the path: native Google Sign-In on iOS, the GIS browser flow everywhere
  // else. Both end at POST /api/auth/google and both surface needsDob here.
  const startGoogle = useGoogleAuth({
    onSuccess: onLoginSuccess,
    onError: (msg, err) => {
      if (err?.data?.needsDob) {
        setNeedsDob(true);
        setError('Add your date of birth below, then tap Continue with Google again.');
      } else {
        setError(msg || 'Google sign-in failed');
      }
    },
    setBusy: setLoading,
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    // The form carries noValidate, so these checks are the only thing standing
    // between an incomplete form and a request. See the comment on the <form>.
    // Order follows the fields down the screen, and the date of birth is first
    // only when it is actually on screen, which is where it is rendered.
    if (needsDob && !dob) {
      setError('Add your date of birth to continue.');
      document.getElementById('login-dob')?.focus();
      return;
    }
    // Nothing leaves this screen while the date on it is unconfirmed. The
    // block above the declaration says what sending it would do.
    if (dobNeedsCheck) {
      setError('Check the date of birth below before you continue.');
      document.getElementById('login-dob-check')?.focus();
      return;
    }
    if (!email.trim()) {
      setError('Add the email address you signed up with.');
      document.getElementById('login-email')?.focus();
      return;
    }
    if (!password) {
      setError('Add your password.');
      document.getElementById('login-password')?.focus();
      return;
    }

    setLoading(true);
    try {
      const data = await login(email, password, needsDob && dob ? dob : undefined);
      onLoginSuccess(data.user);
    } catch (err) {
      if (err.data?.needsDob) {
        setNeedsDob(true);
        setError(needsDob && dob ? err.message : 'One more thing: add your date of birth below to continue.');
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const hero = (
    <>
      <img className="auth-mark" src="/logo192.png" alt="" aria-hidden="true" />
      <h1 className="auth-h1">Welcome back</h1>
      <p className="auth-sub">Plans die in the group chat. This is where they happen.</p>
    </>
  );

  if (view === 'reset') {
    return (
      <ResetPasswordScreen
        // Only the "password updated" screen reports a change. The dead-link
        // and "changed my mind" exits call this with nothing, so the sign-in
        // screen never announces something that did not happen.
        onSignIn={(result) => {
          setNotice(result?.updated ? 'Password updated. Sign in with the new one.' : '');
          setView('login');
        }}
        onRequestNew={() => setView('forgot')}
      />
    );
  }

  if (view === 'forgot') {
    return (
      <ForgotPasswordScreen
        initialEmail={email}
        onBack={() => setView('login')}
      />
    );
  }

  return (
    <AuthShell hero={hero}>
      {/* noValidate, for the reason written out at length on the signup form.
          iOS draws no validation bubble, so `required` on the fields below
          turned Sign in into a button that refused the submit and displayed
          nothing at all. Production PostHog recorded dead clicks on this
          screen's email and password fields too. handleSubmit is now the only
          gate and it always renders a message through AuthError. */}
      <form onSubmit={handleSubmit} noValidate>
        <AuthError>{error}</AuthError>
        <AuthNotice>{notice}</AuthNotice>

        {/* The retry field the error message points at. It sits first so
            "below" in that copy is literally true, and so it is the next
            thing under the reader's eye on the email, Google and Apple paths. */}
        {needsDob && (
          <div className="auth-field-row">
            <label className="auth-label" htmlFor="login-dob">Date of birth</label>
            <input
              id="login-dob"
              className="auth-field"
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              autoComplete="bday"
              aria-describedby="login-dob-hint"
              required
            />
            {/* The warning that costs nothing and arrives before the mistake.
                It is true of every account: nothing in the app edits a date of
                birth once it is stored. It names no age, so it tells a child
                nothing about which date gets in. */}
            <p className="auth-hint" id="login-dob-hint">
              This is saved to your account and cannot be changed later, so check the year.
            </p>
          </div>
        )}

        {dobNeedsCheck && (
          /* role="group", not "alert": nothing has failed and nothing has been
             sent. tabIndex -1 so the three submit paths can move focus here,
             which is also what scrolls it into view on a short screen. */
          <div
            className="auth-check"
            role="group"
            aria-labelledby="login-dob-check-title"
            id="login-dob-check"
            tabIndex={-1}
          >
            <h2 id="login-dob-check-title">Check this date</h2>
            <p>You entered {formatDob(dob)}.</p>
            <p>
              If that is right, Flock cannot keep an account for you and you will not be able to
              sign in again. That cannot be undone. If it is a typo, change it now.
            </p>
            <div className="auth-check-actions">
              <button
                type="button"
                onClick={() => { setError(''); document.getElementById('login-dob')?.focus(); }}
              >
                Change the date
              </button>
              <button
                type="button"
                onClick={() => { setError(''); setDobConfirmed(dob); }}
              >
                That date is right
              </button>
            </div>
          </div>
        )}

        <div className="auth-field-row">
          <label className="auth-label" htmlFor="login-email">Email</label>
          {/* autoComplete="username", not "email": on the sign-in form this
              field is the account identifier, and "username" is the token
              password managers pair with current-password below. "email"
              autofills an address but does not reliably bind the saved
              credential to it. The signup form keeps "email" — there the
              field is contact data and new-password does the pairing. */}
          <input
            id="login-email"
            className="auth-field"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck="false"
            required
          />
        </div>

        <div className="auth-field-row" style={{ marginBottom: '24px' }}>
          {/* The way back in for anyone who cannot remember it. It sits on the
              password label's line, which is where people look for it, and it
              carries whatever is already typed in the email field so the next
              screen does not ask for it twice. */}
          <AuthLabelRow>
            <label className="auth-label" htmlFor="login-password">Password</label>
            <button
              type="button"
              className="auth-link hit44"
              onClick={() => { setError(''); setNotice(''); setView('forgot'); }}
            >
              Forgot password?
            </button>
          </AuthLabelRow>
          <div className="auth-pw-wrap">
            <input
              id="login-password"
              className="auth-field"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your password"
              autoComplete="current-password"
              required
            />
            <PasswordEye shown={showPassword} onToggle={() => setShowPassword(!showPassword)} />
          </div>
        </div>

        <button type="submit" className="auth-primary" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <AuthRule label="or continue with" />

      {/* Hidden only when a native build carries no iOS Google client id, i.e.
          when the button could not work by any route. On web it always shows. */}
      {isGoogleSignInAvailable() && (
        <button
          type="button"
          className="auth-provider"
          onClick={() => {
            if (dobNeedsCheck) {
              setError('Check the date of birth above before you continue.');
              document.getElementById('login-dob-check')?.focus();
              return;
            }
            setError('');
            startGoogle({ dob: needsDob && dob ? dob : undefined });
          }}
          disabled={loading}
        >
          <GoogleG /> Continue with Google
        </button>
      )}

      {/* Apple guideline 4.8: Google login is offered above, so the native
          iOS app must offer Sign in with Apple too. Renders null on web.

          `dob` and the needsDob branch are not decoration. Apple never sends a
          date of birth, so the server refuses to CREATE an account without one
          and answers 403 {needsDob:true}. Someone whose first ever tap is
          Continue with Apple on this screen — a reviewer, say — used to get a
          message pointing at a field that was not on the page and a button
          that could never send it, which is a dead end on the first screen of
          the app. Same field, same retry as the Google and email paths. */}
      <AppleSignInButton
        onSuccess={onLoginSuccess}
        dob={needsDob && dob ? dob : undefined}
        /* Returning false stops the native sheet before it opens. Apple's flow
           is the one path that cannot be re-entered from a confirmation panel,
           because the sheet needs this button's own tap, so the guard has to
           sit in front of it rather than around it. */
        beforeAuthorize={() => {
          if (!dobNeedsCheck) return true;
          setError('Check the date of birth above before you continue.');
          document.getElementById('login-dob-check')?.focus();
          return false;
        }}
        onError={(m, err) => {
          if (err?.data?.needsDob) {
            setNeedsDob(true);
            setError(needsDob && dob ? m : 'Add your date of birth below, then tap Continue with Apple again.');
          } else {
            setError(m);
          }
        }}
      />

      {/* Guideline 1.2 / EULA consent, worded exactly as SignupScreen words
          it. The Google and Apple buttons above CREATE an account for anyone
          who has none, and the server stamps terms_accepted_at on that row,
          so the agreement has to be on this screen too. It appears once the
          server has asked for a date of birth, which is the one state from
          which the next tap creates the account: a first tap on either button
          is always answered needsDob before any row is written, and an
          account that already exists signs in without seeing it. */}
      {needsDob && (
        <p className="auth-legal">
          Creating an account means you agree to the{' '}
          <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">Terms</a>,{' '}
          <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">Privacy Policy</a>, and{' '}
          <a href={GUIDELINES_URL} target="_blank" rel="noopener noreferrer">Community Guidelines</a>.
        </p>
      )}

      {/* The server will not say which addresses belong to Google or Apple
          accounts, because answering that turns login into an account
          enumeration oracle. So the hint lives here instead, standing, for
          everyone: a returning OAuth user who types their email and password
          gets a password failure they cannot otherwise explain. */}
      <p className="auth-hint" style={{ textAlign: 'center', marginTop: '12px' }}>
        Signed up with Google or Apple? Use that button.
      </p>

      <p className="auth-foot">
        New here?
        <button type="button" className="auth-textbtn" onClick={onSwitchToSignup}>Create an account</button>
      </p>

      <button type="button" className="auth-venue" onClick={onSwitchToVenueLogin}>
        Run a venue? <span>Log in here</span>
      </button>
    </AuthShell>
  );
};

export default LoginScreen;
