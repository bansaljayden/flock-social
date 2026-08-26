import React, { useState } from 'react';
import { login } from '../../services/api';
import useGoogleAuth, { isGoogleSignInAvailable } from './useGoogleAuth';
import AppleSignInButton from './AppleSignInButton';
import AuthShell, { AuthError, AuthLabelRow, AuthNotice, AuthRule, GoogleG, PasswordEye } from './AuthShell';
import {
  ForgotPasswordScreen, ResetPasswordScreen, isPasswordResetRoute,
} from './PasswordReset';

const LoginScreen = ({ onLoginSuccess, onSwitchToSignup, onSwitchToVenueLogin }) => {
  // The password-reset screens hang off this one rather than off App.js: the
  // emailed link lands on /reset-password, index.js sends every unknown path to
  // the app, and the app renders this screen for anyone without a session. So
  // this component is already the thing on screen when the link is opened, and
  // it can route to the reset screen itself. Nothing in App.js needs to know.
  const [view, setView] = useState(() => (isPasswordResetRoute() ? 'reset' : 'login'));
  // Carried back from the reset flow, e.g. "Your password is set. Sign in."
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Legacy accounts created before the age gate have no DOB on file. The
  // backend answers 403 {needsDob: true}; we collect a date and retry.
  const [needsDob, setNeedsDob] = useState(false);
  const [dob, setDob] = useState('');

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
              required
            />
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
          onClick={() => { setError(''); startGoogle({ dob: needsDob && dob ? dob : undefined }); }}
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
        onError={(m, err) => {
          if (err?.data?.needsDob) {
            setNeedsDob(true);
            setError(needsDob && dob ? m : 'Add your date of birth below, then tap Continue with Apple again.');
          } else {
            setError(m);
          }
        }}
      />

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
