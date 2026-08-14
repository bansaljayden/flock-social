import React, { useState } from 'react';
import { login, signup, googleLoginWithToken, resendVerificationEmail } from '../../services/api';
import { useGoogleLogin } from '@react-oauth/google';
import AppleSignInButton from './AppleSignInButton';
import AuthShell, { AUTH, AuthError, AuthRule, GoogleG, PasswordEye } from './AuthShell';
import Icons from '../ui/Icons';

/* ═══════════════════════════════════════════════════════════════════
   VENUE PORTAL — the operator's front door.

   Audit 2026-08-14: this screen used to be its own hand-rolled surface
   (inline "liquid glass" card over a video, labels with no htmlFor, a
   26px eye button with no accessible name, 14px inputs that make iOS
   zoom on focus, body text at rgba(148,163,184,0.5) over MOVING
   footage, and a hardcoded 344px-wide Google button that overflowed a
   320px viewport). It also silently diverged from the consumer screens
   on three things that are not cosmetic: no Sign in with Apple beside
   the Google button (guideline 4.8), no terms/privacy consent on the
   signup path (1.2), and no handling of the email-verification reply,
   so a new venue owner landed in the app and met 403s.

   It now renders on the same AuthShell as Login and Signup, so the
   contrast ratios, focus rings, hit targets and reduced-motion /
   save-data backdrop rules are the shared ones rather than a second
   set that has to be audited separately. A venue owner is a customer
   we are asking for money; their front door gets the same standard.
   ═══════════════════════════════════════════════════════════════════ */

const TERMS_URL = 'https://www.flockcorp.com/terms';
const PRIVACY_URL = 'https://www.flockcorp.com/privacy';
const GUIDELINES_URL = 'https://www.flockcorp.com/guidelines';

// Matches backend/routes/auth.js and the age gate in backend/utils/age.js.
// Client-side only for the message; the server recomputes and is the truth.
const MIN_AGE = 13;

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

const VenueLoginScreen = ({ onLoginSuccess, onSwitchToUserLogin }) => {
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [dob, setDob] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Legacy accounts with no DOB on file get 403 {needsDob: true} at login.
  const [needsDob, setNeedsDob] = useState(false);
  // Signup sends a confirmation link and the account cannot do much until it
  // is clicked. The old venue screen ignored that reply and called
  // onLoginSuccess anyway, dropping the owner into a dashboard that 403s.
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
    setResendCooldown(60);
    try {
      await resendVerificationEmail();
      setResendNote('Sent. Check your inbox, and your spam folder.');
    } catch (err) {
      if (err?.status === 429) setResendNote('That is a lot of emails. Try again in a few minutes.');
      else setResendNote(err?.message || 'Could not send it just now. Try again shortly.');
    }
  };

  // Live password checklist, identical rules to backend/routes/auth.js, so
  // nobody submits a password the server will bounce for a rule they were
  // never shown. Only used on the signup path.
  const pwChecks = [
    { label: '8 characters', ok: password.length >= 8 },
    { label: 'One uppercase letter', ok: /[A-Z]/.test(password) },
    { label: 'One number', ok: /[0-9]/.test(password) },
  ];

  const maxDob = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - MIN_AGE);
    return d.toISOString().split('T')[0];
  })();

  const startGoogle = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      setLoading(true);
      try {
        const data = await googleLoginWithToken(tokenResponse.access_token, dob || undefined);
        onLoginSuccess(data.user);
      } catch (err) {
        if (err.data?.needsDob) {
          setNeedsDob(true);
          setError('Add your date of birth below, then tap Continue with Google again.');
        } else {
          setError(err.message || 'Google sign-in failed');
        }
      } finally {
        setLoading(false);
      }
    },
    onError: () => setError('Google sign-in failed'),
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (isSignup) {
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
    }

    setLoading(true);
    try {
      // signup's declared order is (name, email, password, dateOfBirth) — the
      // old call passed (email, password, name), mapping every field wrong.
      if (isSignup) {
        const data = await signup(name, email, password, dob);
        if (data?.emailVerificationRequired) {
          setAwaitingVerification(true);
          return;
        }
        onLoginSuccess(data.user);
      } else {
        const data = await login(email, password, needsDob && dob ? dob : undefined);
        onLoginSuccess(data.user);
      }
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

  const switchMode = () => {
    setIsSignup((v) => !v);
    setError('');
    setNeedsDob(false);
    // A password typed under the login rules is not carried into a signup form
    // that is about to grade it against a checklist.
    setPassword('');
  };

  const hero = (
    <>
      <img className="auth-mark" src="/logo192.png" alt="" aria-hidden="true" />
      <h1 className="auth-h1">{isSignup ? 'Register your venue' : 'Venue portal'}</h1>
      <p className="auth-sub">
        {/* Says only what a new account actually gets. Claiming is immediate;
            replying to reviews and publishing promotions wait on the admin
            verification step, so the copy says so rather than implying the
            dashboard is live the moment you sign up. */}
        {isSignup
          ? 'Claim your listing. We check it is yours before it goes live.'
          : 'Sign in to manage your venue.'}
      </p>
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
      )}
      >
        <p className="auth-sub" style={{ margin: '0 0 18px' }}>
          Your account exists. Clicking the link is what lets you claim your venue and reply to reviews. If it has not landed in a minute, check your spam folder.
        </p>
        {resendNote && <p role="status" className="auth-hint" style={{ margin: '0 0 12px' }}>{resendNote}</p>}
        <button
          type="button"
          onClick={handleResend}
          disabled={resendCooldown > 0}
          className="auth-primary"
        >
          {resendCooldown > 0 ? `Send it again in ${resendCooldown}s` : 'Send the link again'}
        </button>
        <p className="auth-foot">
          Already confirmed?
          <button type="button" className="auth-textbtn" onClick={() => { setAwaitingVerification(false); setIsSignup(false); }}>Sign in</button>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell hero={hero}>
      <form onSubmit={handleSubmit}>
        <AuthError>{error}</AuthError>

        {isSignup && (
          <div className="auth-field-row">
            <label className="auth-label" htmlFor="venue-name">Your name</label>
            <input
              id="venue-name"
              className="auth-field"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Who we should ask for"
              autoComplete="name"
              required
            />
          </div>
        )}

        {(isSignup || needsDob) && (
          <div className="auth-field-row">
            <label className="auth-label" htmlFor="venue-dob">Date of birth</label>
            <input
              id="venue-dob"
              className="auth-field"
              type="date"
              value={dob}
              max={isSignup ? maxDob : undefined}
              onChange={(e) => setDob(e.target.value)}
              autoComplete="bday"
              aria-describedby={isSignup ? 'venue-dob-hint' : undefined}
              required
            />
            {isSignup && <p className="auth-hint" id="venue-dob-hint">Yours, not the venue's. You have to be 13 or older to use Flock.</p>}
          </div>
        )}

        <div className="auth-field-row">
          <label className="auth-label" htmlFor="venue-email">Email</label>
          <input
            id="venue-email"
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

        <div className="auth-field-row" style={{ marginBottom: '24px' }}>
          <label className="auth-label" htmlFor="venue-password">Password</label>
          <div className="auth-pw-wrap">
            <input
              id="venue-password"
              className="auth-field"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isSignup ? 'At least 8 characters' : 'Your password'}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              minLength={isSignup ? 8 : undefined}
              required
            />
            <PasswordEye shown={showPassword} onToggle={() => setShowPassword(!showPassword)} />
          </div>
          {isSignup && password.length > 0 && (
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
                  {/* System glyphs, not a local <svg>. The old pair was drawn
                      with round caps at strokeWidth 2.4, which is neither of
                      the two things components/ui/Icons.js allows, so a rule
                      that renders inches from Icons-drawn UI elsewhere in the
                      app came from a different drawing system.
                      Icons.check for met; Icons.minus for not-yet, because the
                      set has no bare circle and the two circles it does have
                      say the wrong thing here — alertCircle reads as an error
                      against a rule the user simply has not reached yet.
                      Decorative: the rule's own text is right beside it, and
                      the state is already carried by colour AND by wording. */}
                  <span aria-hidden="true" style={{ display: 'inline-flex', flexShrink: 0 }}>
                    {(c.ok ? Icons.check : Icons.minus)('currentColor', 14)}
                  </span>
                  {c.label}
                </li>
              ))}
            </ul>
          )}
        </div>

        <button type="submit" className="auth-primary" disabled={loading}>
          {loading
            ? (isSignup ? 'Creating account…' : 'Signing in…')
            : (isSignup ? 'Create account' : 'Sign in')}
        </button>

        {/* Guideline 1.2 / EULA consent. The backend stamps terms_accepted_at on
            every signup path, so the agreement has to be on screen before any
            of the three buttons below is pressed. */}
        {isSignup && (
          <p className="auth-legal">
            Creating an account means you agree to the{' '}
            <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">Terms</a>,{' '}
            <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">Privacy Policy</a>, and{' '}
            <a href={GUIDELINES_URL} target="_blank" rel="noopener noreferrer">Community Guidelines</a>.
          </p>
        )}
      </form>

      <AuthRule label={isSignup ? 'or sign up with' : 'or continue with'} />

      <button
        type="button"
        className="auth-provider"
        disabled={loading}
        onClick={() => {
          setError('');
          if (isSignup) {
            // Age gate the Google path the same way the email path is gated.
            const age = ageFromDob(dob);
            if (age === null) {
              setError('Add your date of birth above first, then continue with Google.');
              return;
            }
            if (age < MIN_AGE) {
              setError(`You must be at least ${MIN_AGE} to use Flock`);
              return;
            }
          }
          startGoogle();
        }}
      >
        <GoogleG /> Continue with Google
      </button>

      {/* Apple guideline 4.8: the venue portal ships inside the same iOS binary
          and offers Google above, so it must offer Sign in with Apple too.
          Renders null on web. Its absence here was a standing 4.8 rejection
          risk that the consumer screens had already fixed. */}
      <AppleSignInButton onSuccess={onLoginSuccess} onError={(m) => setError(m)} dob={dob} />

      {/* The server will not say which addresses belong to Google or Apple
          accounts — answering that turns login into an account enumeration
          oracle — so the hint stands here for everyone, same as the consumer
          login screen. */}
      {!isSignup && (
        <p className="auth-hint" style={{ textAlign: 'center', marginTop: '12px' }}>
          Signed up with Google or Apple? Use that button.
        </p>
      )}

      <p className="auth-foot">
        {isSignup ? 'Already registered?' : 'New venue?'}
        <button type="button" className="auth-textbtn" onClick={switchMode}>
          {isSignup ? 'Sign in' : 'Create an account'}
        </button>
      </p>

      <button type="button" className="auth-venue" onClick={onSwitchToUserLogin}>
        Not a venue? <span>Back to user login</span>
      </button>
    </AuthShell>
  );
};

export default VenueLoginScreen;
