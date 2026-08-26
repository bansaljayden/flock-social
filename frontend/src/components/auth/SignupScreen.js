import React, { useState } from 'react';
import { signup, resendVerificationEmail } from '../../services/api';
import useGoogleAuth, { isGoogleSignInAvailable } from './useGoogleAuth';
import AppleSignInButton from './AppleSignInButton';
import AuthShell, { AUTH, AuthError, AuthRule, GoogleG, PasswordEye } from './AuthShell';
import Icons from '../ui/Icons';

// Same live pages the in-app Settings screen and the paywall sheet link to.
const TERMS_URL = 'https://www.flockcorp.com/terms';
const PRIVACY_URL = 'https://www.flockcorp.com/privacy';
const GUIDELINES_URL = 'https://www.flockcorp.com/guidelines';

const SignupScreen = ({ onSignupSuccess, onSwitchToLogin }) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [dob, setDob] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Signup now sends a confirmation link, and the account cannot do much until
  // it is clicked. Landing straight in the app and meeting a bare 403 on the
  // first real action is a bad first five minutes, so the screen says what
  // happened and offers to send the link again.
  const [awaitingVerification, setAwaitingVerification] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendNote, setResendNote] = useState('');

  React.useEffect(() => {
    if (resendCooldown <= 0) return undefined;
    const t = setTimeout(() => setResendCooldown((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  const handleResend = async () => {
    if (resendCooldown > 0) return;
    setResendNote('');
    // Start the cooldown before the request, so a double tap cannot get through.
    setResendCooldown(60);
    try {
      await resendVerificationEmail();
      setResendNote('Sent. Check your inbox, and your spam folder.');
    } catch (err) {
      if (err?.status === 429) setResendNote('That is a lot of emails. Try again in a few minutes.');
      else setResendNote(err?.message || 'Could not send it just now. Try again shortly.');
    }
  };

  // Custom-styled Google button; DOB is validated in onClick BEFORE this
  // launches (the server re-checks age on account creation regardless).
  // The hook routes native iOS through Google's own SDK and everything else
  // through the GIS browser flow; both post to the same /api/auth/google.
  const startGoogle = useGoogleAuth({
    onSuccess: onSignupSuccess,
    // The DOB is already collected and age-gated above before this can fire,
    // so a needsDob 403 is not reachable from this screen; the message is
    // surfaced verbatim either way, exactly as before.
    onError: (msg) => setError(msg || 'Google sign-in failed'),
    setBusy: setLoading,
  });

  // Flock requires users to be at least 13 (matches Terms of Service + the
  // server-side age gate in backend/utils/age.js). Client check is for UX only;
  // the backend re-computes age from date_of_birth and is the source of truth.
  const MIN_AGE = 13;
  // Live password checklist. Mirrors backend/routes/auth.js EXACTLY (8 chars,
  // 1 uppercase, 1 number) so nobody submits a password the server will bounce
  // for a rule they were never shown. Shown only once the field has content.
  const pwChecks = [
    { label: '8 characters', ok: password.length >= 8 },
    { label: 'One uppercase letter', ok: /[A-Z]/.test(password) },
    { label: 'One number', ok: /[0-9]/.test(password) },
  ];

  const ageFromDob = (value) => {
    if (!value) return null;
    const b = new Date(value);
    if (isNaN(b.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - b.getFullYear();
    const m = now.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age -= 1;
    return age;
  };
  // Latest date that still satisfies the minimum age — caps the date picker.
  const maxDob = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - MIN_AGE);
    return d.toISOString().split('T')[0];
  })();

  // Rough shape check only. The server is the authority on what it will accept
  // (express-validator's isEmail on /signup); this exists so an obvious typo is
  // answered on the device instead of costing a round trip.
  const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // The first thing wrong with the form, in the order the fields appear on
  // screen, as [field id, what to say]. Order matters: the old code checked the
  // password rules first, so someone who had filled in nothing at all was told
  // about a password requirement while the empty Name field sat above it.
  const firstProblem = () => {
    if (!name.trim()) return ['signup-name', 'Add the name your friends know you by.'];
    if (!email.trim()) return ['signup-email', 'Add your email address.'];
    if (!EMAIL_SHAPE.test(email.trim())) return ['signup-email', 'That email address does not look right. Check it and try again.'];
    if (!dob) return ['signup-dob', 'Add your date of birth.'];
    if (ageFromDob(dob) === null) return ['signup-dob', 'That date of birth does not look right. Check it and try again.'];
    if (!password) return ['signup-password', 'Choose a password.'];
    if (!pwChecks.every((c) => c.ok)) return ['signup-password', 'Your password is missing a requirement listed below it.'];
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    // THIS IS THE FORM'S ONLY VALIDATION, and it has to be, because the form
    // carries `noValidate`. See the comment on the <form> element for why.
    //
    // Focus the offending field as well as setting the error. AuthError moves
    // focus to itself when its text CHANGES, which announces the message and
    // scrolls it into view; on a second tap with the same message unchanged its
    // effect does not re-fire, and this focus() is then what puts something on
    // screen. Between the two, every tap of Create account moves something.
    const problem = firstProblem();
    if (problem) {
      const [fieldId, message] = problem;
      setError(message);
      document.getElementById(fieldId)?.focus();
      return;
    }

    const age = ageFromDob(dob);
    if (age < MIN_AGE) {
      setError(`You must be at least ${MIN_AGE} to use Flock`);
      document.getElementById('signup-dob')?.focus();
      return;
    }

    setLoading(true);

    try {
      const data = await signup(name, email, password, dob);
      if (data?.emailVerificationRequired) {
        setAwaitingVerification(true);
        return;
      }
      onSignupSuccess(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const hero = (
    <>
      <img className="auth-mark" src="/logo192.png" alt="" aria-hidden="true" />
      <h1 className="auth-h1">Create your account</h1>
      <p className="auth-sub">Four fields and you're in.</p>
    </>
  );

  if (awaitingVerification) {
    return (
      <AuthShell hero={(
        <>
          <img className="auth-mark" src="/logo192.png" alt="" aria-hidden="true" />
          <h1 className="auth-h1">Confirm your email</h1>
          <p className="auth-sub">We sent a link to {email}. Open it and you are in.</p>
        </>
      )}>
        <p className="auth-sub" style={{ margin: '0 0 18px' }}>
          Your account exists. Clicking the link is what lets you start a flock, add friends and save a payment handle. If it has not landed in a minute, check your spam folder.
        </p>
        {resendNote && <p role="status" className="auth-hint" style={{ margin: '0 0 12px' }}>{resendNote}</p>}
        <button
          type="button"
          onClick={handleResend}
          disabled={resendCooldown > 0}
          className="auth-primary"
          style={{ opacity: resendCooldown > 0 ? 0.5 : 1, cursor: resendCooldown > 0 ? 'not-allowed' : 'pointer' }}
        >
          {resendCooldown > 0 ? `Send it again in ${resendCooldown}s` : 'Send the link again'}
        </button>
        <p className="auth-foot">
          Already confirmed?
          <button type="button" className="auth-textbtn" onClick={onSwitchToLogin}>Sign in</button>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell hero={hero}>
      {/* noValidate, and this is the most load-bearing attribute on the screen.
          Every field below carries `required`, and one carries `minLength` and
          one `max`. On iOS there is no validation bubble: WKWebView refuses the
          submit, focuses nothing the user can see, and draws NOTHING. So an
          incomplete form met a Create account button that did not visibly
          respond, with no way to find out which field was the problem.

          Production PostHog measured it. Over 90 days the single largest
          cluster of $dead_click in the whole product was this screen inside the
          native app: five on this button, five on the date field, six on the
          email field, three on the age hint below the date field, and two on
          each of the four labels. 1,792 pageviews produced 6 signups.

          Turning the browser's validation off makes handleSubmit the only gate,
          and handleSubmit always renders a message through AuthError, which
          announces itself and scrolls into view. The rule is that this button
          must never be tappable without something happening. */}
      <form onSubmit={handleSubmit} noValidate>
        <AuthError>{error}</AuthError>

        <div className="auth-field-row">
          <label className="auth-label" htmlFor="signup-name">Name</label>
          <input
            id="signup-name"
            className="auth-field"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="What your friends call you"
            autoComplete="name"
            required
          />
        </div>

        <div className="auth-field-row">
          <label className="auth-label" htmlFor="signup-email">Email</label>
          <input
            id="signup-email"
            className="auth-field"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck="false"
            required
          />
        </div>

        <div className="auth-field-row">
          <label className="auth-label" htmlFor="signup-dob">Date of birth</label>
          <input
            id="signup-dob"
            className="auth-field"
            type="date"
            value={dob}
            max={maxDob}
            onChange={(e) => setDob(e.target.value)}
            autoComplete="bday"
            aria-describedby="signup-dob-hint"
            required
          />
          <p className="auth-hint" id="signup-dob-hint">You have to be 13 or older to use Flock.</p>
        </div>

        <div className="auth-field-row" style={{ marginBottom: '24px' }}>
          <label className="auth-label" htmlFor="signup-password">Password</label>
          <div className="auth-pw-wrap">
            <input
              id="signup-password"
              className="auth-field"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              minLength={8}
              aria-describedby="signup-pw-rules"
              required
            />
            <PasswordEye shown={showPassword} onToggle={() => setShowPassword(!showPassword)} />
          </div>
          {/* The full rule set, described ON the field. The visible checklist
              only exists once the field has content, so without this a screen
              reader lands on an empty password field and hears nothing about
              what a valid password is; the placeholder names one rule of
              three. sr-only, because the visual design already carries the
              rules through the placeholder and the live checklist. */}
          <p className="sr-only" id="signup-pw-rules">
            Password must be at least 8 characters, with one uppercase letter and one number.
          </p>
          {password.length > 0 && (
            <ul aria-label="Password requirements" style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: '7px' }}>
              {pwChecks.map((c) => (
                <li
                  key={c.label}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    fontSize: '12.5px', fontWeight: '500',
                    color: c.ok ? AUTH.green : AUTH.cream2,
                  }}
                >
                  {/* System glyphs (Icons.check met / Icons.minus not-yet),
                      same pair as VenueLoginScreen; the old row drew a local
                      <svg> from outside the icon system. Decorative: the
                      state is announced by the sr-only text below, and shown
                      visually by glyph shape plus colour, so neither channel
                      is colour-only (1.4.1). */}
                  <span aria-hidden="true" style={{ display: 'inline-flex', flexShrink: 0 }}>
                    {(c.ok ? Icons.check : Icons.minus)('currentColor', 14)}
                  </span>
                  {c.label}
                  {/* The met/unmet signal a screen reader was never getting:
                      the old row encoded state in colour and a glyph, both
                      aria-hidden, so "8 characters" read identically whether
                      satisfied or not. */}
                  <span className="sr-only">{c.ok ? ', met' : ', not met yet'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <button type="submit" className="auth-primary" disabled={loading}>
          {loading ? 'Creating account…' : 'Create account'}
        </button>

        {/* Guideline 1.2 / EULA consent. The backend stamps terms_accepted_at
            on EVERY signup path (email, Google, Apple), so the agreement has
            to be shown on this screen before any of those buttons are hit.
            It sits directly under Create account and above the Google/Apple
            buttons so it covers all three without scrolling. The Terms page
            carries the zero-tolerance-for-objectionable-content language
            Apple's 1.2 template requires. */}
        <p className="auth-legal">
          Creating an account means you agree to the{' '}
          <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">Terms</a>,{' '}
          <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">Privacy Policy</a>, and{' '}
          <a href={GUIDELINES_URL} target="_blank" rel="noopener noreferrer">Community Guidelines</a>.
        </p>
      </form>

      <AuthRule label="or sign up with" />

      {/* Hidden only when a native build carries no iOS Google client id, i.e.
          when the button could not work by any route. On web it always shows. */}
      {isGoogleSignInAvailable() && (
        <button
          type="button"
          className="auth-provider"
          disabled={loading}
          onClick={() => {
            setError('');
            // Age gate the Google sign-up path too: DOB must be entered and
            // >= 13 before we create an account (parity with email signup).
            const age = ageFromDob(dob);
            if (age === null) {
              setError('Add your date of birth above first, then continue with Google.');
              return;
            }
            if (age < MIN_AGE) {
              setError(`You must be at least ${MIN_AGE} to use Flock`);
              return;
            }
            startGoogle({ dob });
          }}
        >
          <GoogleG /> Continue with Google
        </button>
      )}

      {/* Apple guideline 4.8 parity with the Google button above; native
          iOS only (returns null on web). Apple accounts don't carry DOB,
          and Apple requires its account holders to be 13+, so the age
          gate here matches the Google path's server-side behavior. */}
      <AppleSignInButton onSuccess={onSignupSuccess} onError={(m) => setError(m)} dob={dob} />

      <p className="auth-foot">
        Already have an account?
        <button type="button" className="auth-textbtn" onClick={onSwitchToLogin}>Sign in</button>
      </p>
    </AuthShell>
  );
};

export default SignupScreen;
