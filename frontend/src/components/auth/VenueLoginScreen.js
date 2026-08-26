import React, { useState } from 'react';
import { login, signup, resendVerificationEmail } from '../../services/api';
import useGoogleAuth, { isGoogleSignInAvailable } from './useGoogleAuth';
import AppleSignInButton from './AppleSignInButton';
import AuthShell, {
  ageFromDob, AUTH, AuthError, AuthRule, formatDob, GoogleG, MIN_AGE, PasswordEye,
} from './AuthShell';
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

// THE SIGNUP HALF OF THIS FORM NAMES NO MINIMUM AGE AND ENFORCES NONE, for the
// reasons written out at length in SignupScreen.js. It used to cap its picker
// at exactly thirteen years ago, print "You have to be 13 or older" above the
// field, and refuse a younger date locally without ever calling the API, which
// is the arrangement that shows a child which birthday passes rather than
// keeping them out. The date now goes to the server and the server answers.
//
// MIN_AGE is still imported, and it is used for one thing only: the LOGIN
// half's read-back panel below, which is a different question about an account
// that already exists. See the comment on dobConfirmed.
// backend/utils/age.js is the only authority on what is allowed.

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
  // Same read-back as the consumer sign-in screen, and for the same reason: on
  // the LOGIN half of this form a date is not a question about whether an
  // account may be created, it is enforceDobOnLogin writing an under-13 date to
  // an existing row, revoking its live sessions and freezing every later
  // sign-in, with no undo and no screen that can edit the date afterwards. This
  // form is the venue portal, so the account it would end is a customer's. The
  // signup half asks nothing of this panel: creating an account and freezing
  // one are not the same act, and only the second is irreversible.
  const [dobConfirmed, setDobConfirmed] = useState('');
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

  // Present, and a date a living person could have been born on. Neither half
  // is a statement about age: on the signup path the server is the only thing
  // that decides that. The second half exists because a date in the FUTURE is
  // not an age claim, it is a typo, and the server reads any date short of the
  // minimum as knowledge that a child is signing up and remembers the mailbox
  // for 24 hours. A mistyped year would cost a venue owner their account for a
  // day. Refusing a birth date nobody alive can have names no threshold and
  // turns away no truthful date. Same helper, same wording, as SignupScreen.
  const dobLooksReal = (value) => {
    const years = ageFromDob(value);
    return years !== null && years >= 0;
  };

  // Native iOS runs Google's own SDK, everything else the GIS browser flow;
  // one hook, one backend route, and the needsDob 403 handled the same on both.
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

  const fail = (fieldId, message) => {
    setError(message);
    document.getElementById(fieldId)?.focus();
  };

  const venueDobAge = ageFromDob(dob);
  const dobNeedsCheck = !isSignup && needsDob
    && venueDobAge !== null && venueDobAge < MIN_AGE && dobConfirmed !== dob;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    // The form carries noValidate, so every empty-field case has to be caught
    // here or the button does nothing at all on iOS. See the <form> comment.
    // The sign-in half had no checks whatsoever, so an empty form met a button
    // that refused to submit and said nothing.
    if (isSignup && !name.trim()) return fail('venue-name', 'Add your name.');
    if (isSignup && !dob) return fail('venue-dob', 'Add your date of birth.');
    if (dobNeedsCheck) return fail('venue-dob-check', 'Check the date of birth below before you continue.');
    if (!email.trim()) return fail('venue-email', 'Add your email address.');
    if (!password) return fail('venue-password', isSignup ? 'Choose a password.' : 'Add your password.');

    if (isSignup) {
      if (!pwChecks.every((c) => c.ok)) {
        return fail('venue-password', 'Your password is missing a requirement listed below it.');
      }
      // Shape only. What the date says about age is the server's call.
      if (!dobLooksReal(dob)) {
        return fail('venue-dob', 'That date of birth does not look right. Check it and try again.');
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
      {/* noValidate: see the signup screen. iOS shows no validation bubble, so
          `required` here meant the button silently refused to submit. */}
      <form onSubmit={handleSubmit} noValidate>
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
              onChange={(e) => setDob(e.target.value)}
              autoComplete="bday"
              aria-describedby="venue-dob-hint"
              required
            />
            {/* "Yours, not the venue's" stays: an operator filling this in for
                a bar that opened in 1974 is a real mistake, and saying so names
                no threshold. What followed it was the threshold, and that is
                the part that taught a child which birthday to type. */}
            {isSignup && <p className="auth-hint" id="venue-dob-hint">Yours, not the venue's. We use it to check your age.</p>}
            {!isSignup && (
              <p className="auth-hint" id="venue-dob-hint">
                This is saved to your account and cannot be changed later, so check the year.
              </p>
            )}
          </div>
        )}

        {dobNeedsCheck && (
          <div
            className="auth-check"
            role="group"
            aria-labelledby="venue-dob-check-title"
            id="venue-dob-check"
            tabIndex={-1}
          >
            <h2 id="venue-dob-check-title">Check this date</h2>
            <p>You entered {formatDob(dob)}.</p>
            <p>
              If that is right, Flock cannot keep an account for you and you will not be able to
              sign in again. That cannot be undone. If it is a typo, change it now.
            </p>
            <div className="auth-check-actions">
              <button
                type="button"
                onClick={() => { setError(''); document.getElementById('venue-dob')?.focus(); }}
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

      {/* Hidden only when a native build carries no iOS Google client id, i.e.
          when the button could not work by any route. On web it always shows. */}
      {isGoogleSignInAvailable() && (
        <button
          type="button"
          className="auth-provider"
          disabled={loading}
          onClick={() => {
            if (dobNeedsCheck) {
              setError('Check the date of birth above before you continue.');
              document.getElementById('venue-dob-check')?.focus();
              return;
            }
            setError('');
            if (isSignup) {
              // The server requires a date of birth to create an account on
              // this path, so the field has to be filled first. What the date
              // says about age is not decided here, exactly as it is not
              // decided in handleSubmit.
              if (!dob) {
                setError('Add your date of birth above first, then continue with Google.');
                return;
              }
              if (!dobLooksReal(dob)) {
                setError('That date of birth does not look right. Check it and try again.');
                return;
              }
            }
            startGoogle({ dob: dob || undefined });
          }}
        >
          <GoogleG /> Continue with Google
        </button>
      )}

      {/* Apple guideline 4.8: the venue portal ships inside the same iOS binary
          and offers Google above, so it must offer Sign in with Apple too.
          Renders null on web. Its absence here was a standing 4.8 rejection
          risk that the consumer screens had already fixed. */}
      <AppleSignInButton
        onSuccess={onLoginSuccess}
        onError={(m) => setError(m)}
        dob={dob}
        beforeAuthorize={() => {
          if (dobNeedsCheck) {
            setError('Check the date of birth above before you continue.');
            document.getElementById('venue-dob-check')?.focus();
            return false;
          }
          // The impossible date, stopped for the reason on dobLooksReal. An
          // empty field still goes through: an Apple account that already
          // exists signs in without one.
          if (dob && !dobLooksReal(dob)) {
            setError('That date of birth does not look right. Check it and try again.');
            return false;
          }
          return true;
        }}
      />

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
