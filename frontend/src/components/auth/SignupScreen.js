import React, { useState } from 'react';
import { signup, googleLoginWithToken, resendVerificationEmail } from '../../services/api';
import { useGoogleLogin } from '@react-oauth/google';
import AppleSignInButton from './AppleSignInButton';
import AuthShell, { AUTH, AuthError, AuthRule, GoogleG, PasswordEye } from './AuthShell';

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
  const startGoogle = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      setLoading(true);
      try {
        const data = await googleLoginWithToken(tokenResponse.access_token, dob);
        onSignupSuccess(data.user);
      } catch (err) {
        setError(err.message || 'Google sign-in failed');
      } finally {
        setLoading(false);
      }
    },
    onError: () => setError('Google sign-up failed'),
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

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!pwChecks.every((c) => c.ok)) {
      setError('Your password is missing a requirement below');
      return;
    }

    const age = ageFromDob(dob);
    if (age === null) {
      setError('Please enter your date of birth');
      return;
    }
    if (age < MIN_AGE) {
      setError(`You must be at least ${MIN_AGE} to use Flock`);
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
      <form onSubmit={handleSubmit}>
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
              required
            />
            <PasswordEye shown={showPassword} onToggle={() => setShowPassword(!showPassword)} />
          </div>
          {password.length > 0 && (
            <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: '7px' }}>
              {pwChecks.map((c) => (
                <li
                  key={c.label}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    fontSize: '12.5px', fontWeight: '500',
                    color: c.ok ? AUTH.green : AUTH.cream2,
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    {c.ok ? <polyline points="20 6 9 17 4 12" /> : <circle cx="12" cy="12" r="9" />}
                  </svg>
                  {c.label}
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
          startGoogle();
        }}
      >
        <GoogleG /> Continue with Google
      </button>

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
