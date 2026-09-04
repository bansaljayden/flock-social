import React, { useState, useEffect } from 'react';
import { signup, resendVerificationEmail, trackAuthScreen, getCurrentUser } from '../../services/api';
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

  // The arrival event for the signup form. screen_viewed only fires inside
  // the authed shell, so this screen, shown before it, had no denominator of
  // its own and the land-to-submit drop was invisible.
  useEffect(() => { trackAuthScreen('signup'); }, []);
  // Signup now sends a confirmation link, and the account cannot do much until
  // it is clicked. Landing straight in the app and meeting a bare 403 on the
  // first real action is a bad first five minutes, so the screen says what
  // happened and offers to send the link again.
  const [awaitingVerification, setAwaitingVerification] = useState(false);
  // Did the mail actually go out. POST /api/auth/signup answers this in
  // `verificationSent`, and nothing read it: the screen said "We sent a link"
  // whatever the server had done. It is false whenever the provider is
  // missing or erroring, and also whenever the per-IP hourly send budget is
  // spent, which on a shared school or campus connection is an ordinary
  // Wednesday. Telling somebody a link is in their inbox when nothing was sent
  // leaves them refreshing mail that will never arrive, unable to start a
  // flock or add a friend, with the only button on the screen repeating the
  // same claim.
  const [linkSent, setLinkSent] = useState(true);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendNote, setResendNote] = useState('');
  // The address is on the do-not-mail list (a bounce or a spam report on an
  // earlier account). Asking again cannot help.
  const [mailRefused, setMailRefused] = useState(false);
  // On iOS the confirmation link opens in Safari, not in the app, so nothing
  // here ever hears about it. Without this button the screen stayed on
  // "Confirm your email" after they had, with only "Send the link again".
  const [confirmChecking, setConfirmChecking] = useState(false);
  const handleConfirmed = async () => {
    if (confirmChecking) return;
    setConfirmChecking(true);
    setResendNote('');
    try {
      const me = await getCurrentUser();
      const user = me?.user || me;
      if (user?.email_verified) {
        onSignupSuccess(user);
        return;
      }
      setResendNote('Not confirmed yet. Open the link in the email, then come back and tap this again.');
    } catch (err) {
      setResendNote(err?.message || 'Could not check just now. Try again in a moment.');
    } finally {
      setConfirmChecking(false);
    }
  };

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
      // The resend route answers with the same `verificationSent` flag, so a
      // send that was accepted but not made does not get reported as one that
      // was. A 200 here used to print "Sent. Check your inbox" either way.
      const data = await resendVerificationEmail();
      const sent = data?.verificationSent !== false;
      setLinkSent((was) => was || sent);
      if (data?.mailRefused) setMailRefused(true);
      setResendNote(data?.mailRefused
        ? 'We cannot mail this address: mail to it bounced or was reported as spam before. Email social@flockcorp.com from it and we will clear that.'
        : sent
          ? 'Sent. Check your inbox, and your spam folder.'
          : 'That one did not go out either. Nothing is wrong with your account, and the link is still worth asking for.');
    } catch (err) {
      // The server words this refusal with the real window (backend
      // utils/retryAfter.js: the resend budget's longest leg is a day, not "a
      // few minutes"), and api.js carries that sentence as err.message. Render
      // it rather than a hardcoded guess; fall back to generic copy only when
      // the body carried no sentence.
      if (err?.status === 429) setResendNote(err?.message || 'That is a lot of emails. Try again later.');
      else setResendNote(err?.message || 'Could not send it just now. Try again shortly.');
    }
  };

  // Custom-styled Google button. The date entered above is passed through and
  // the server decides on it, the same as the form does.
  // The hook routes native iOS through Google's own SDK and everything else
  // through the GIS browser flow; both post to the same /api/auth/google.
  const startGoogle = useGoogleAuth({
    onSuccess: onSignupSuccess,
    onError: (msg) => setError(msg || 'Google sign-in failed'),
    setBusy: setLoading,
  });

  // THIS SCREEN NAMES NO MINIMUM AGE AND ENFORCES NONE. Read this before
  // putting either back.
  //
  // Flock is 13+. That rule lives in the Terms and in the App Store age
  // rating, and backend/routes/auth.js enforces it on all three
  // account-creation paths. What this screen used to do was print "You have to
  // be 13 or older" above a date picker capped at exactly thirteen years ago,
  // then refuse a younger date locally without ever calling the API. That does
  // not keep a 12-year-old out. It shows them which birthday passes, they type
  // one, and the app stores that false date as their real one. The FTC's
  // amended COPPA rule, compliance date 2026-04-22, codifies the neutral age
  // screen, and its guidance is explicit that the screen must not encourage a
  // child to falsify their age.
  //
  // So the field takes any date, the date is sent, and the server answers. Its
  // refusal names no age either, and it remembers the attempt, so going back
  // and typing an older year gets the same sentence. Nothing changes for
  // anyone 13 or older: same four fields, same account.

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
  // Present, and a date a living person could have been born on. Neither half
  // is a statement about age: the server is the only thing on any path that
  // decides that. The second half exists because a date in the FUTURE is not an
  // age claim, it is a typo, and it must not be sent as one. The server reads
  // any date short of the minimum as knowledge that a child is signing up and
  // remembers the mailbox for 24 hours, so a mistyped year would cost a real
  // person their account for a day. Refusing a birth date nobody alive can have
  // costs nothing and teaches nothing: it names no threshold and it turns away
  // no truthful date.
  const dobLooksReal = (value) => {
    const years = ageFromDob(value);
    return years !== null && years >= 0;
  };

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
    if (!dobLooksReal(dob)) return ['signup-dob', 'That date of birth does not look right. Check it and try again.'];
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

    setLoading(true);

    try {
      const data = await signup(name, email, password, dob);
      if (data?.emailVerificationRequired) {
        // Absent is treated as sent, because that is what an older backend
        // that does not report the field means. Only an explicit false is a
        // failed send.
        setLinkSent(data.verificationSent !== false);
        if (data.mailRefused) {
          setMailRefused(true);
          setResendNote('We cannot mail this address: mail to it bounced or was reported as spam before. Email social@flockcorp.com from it and we will clear that.');
        }
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
          {linkSent
            ? <p className="auth-sub">We sent a link to {email}. Open it and you are in.</p>
            : <p className="auth-sub">The link to {email} did not go out. Ask for it below.</p>}
        </>
      )}>
        <p className="auth-sub" style={{ margin: '0 0 18px' }}>
          {linkSent
            ? 'Your account exists. Clicking the link is what lets you start a flock, add friends and save a payment handle. If it has not landed in a minute, check your spam folder.'
            : 'Your account exists and your password works. Our mail did not leave, so there is nothing in your inbox to look for yet. Ask for the link below, and check your spam folder once it arrives.'}
        </p>
        {resendNote && <p role="status" className="auth-hint" style={{ margin: '0 0 12px' }}>{resendNote}</p>}
        <button
          type="button"
          onClick={handleResend}
          disabled={resendCooldown > 0 || mailRefused}
          className="auth-primary"
          style={{ opacity: (resendCooldown > 0 || mailRefused) ? 0.5 : 1, cursor: (resendCooldown > 0 || mailRefused) ? 'not-allowed' : 'pointer' }}
        >
          {/* "again" is a claim too. Nothing was sent the first time when
              linkSent is false, and a button that says otherwise repeats the
              sentence the hero has just stopped making. */}
          {resendCooldown > 0
            ? `Try again in ${resendCooldown}s`
            : (linkSent ? 'Send the link again' : 'Send the link')}
        </button>
        <button
          type="button"
          onClick={handleConfirmed}
          disabled={confirmChecking}
          className="auth-provider"
          style={{ marginTop: '10px', opacity: confirmChecking ? 0.6 : 1 }}
        >
          {confirmChecking ? 'Checking' : 'I opened the link, continue'}
        </button>
        <p className="auth-foot">
          Signed up before?
          <button type="button" className="auth-textbtn" onClick={onSwitchToLogin}>Sign in</button>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell hero={hero}>
      {/* noValidate, and this is the most load-bearing attribute on the screen.
          Every field below carries `required`, and one carries `minLength`.
          On iOS there is no validation bubble: WKWebView refuses the
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
            onChange={(e) => setDob(e.target.value)}
            autoComplete="bday"
            aria-describedby="signup-dob-hint"
            required
          />
          {/* Says what the date is for and nothing else. The number this field
              used to print above itself was the part that taught a child which
              birthday to type instead. */}
          <p className="auth-hint" id="signup-dob-hint">We use this to check your age.</p>
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
            // The server requires a date of birth to create an account on this
            // path, so the field has to be filled before Google's sheet is any
            // use. What the date says about age is not decided here, exactly as
            // it is not decided in handleSubmit.
            if (!dob) {
              setError('Add your date of birth above first, then continue with Google.');
              return;
            }
            if (!dobLooksReal(dob)) {
              setError('That date of birth does not look right. Check it and try again.');
              return;
            }
            startGoogle({ dob });
          }}
        >
          <GoogleG /> Continue with Google
        </button>
      )}

      {/* Apple guideline 4.8 parity with the Google button above; native
          iOS only (returns null on web). Apple accounts do not carry a date of
          birth, so whatever is in the field is passed through and the server
          decides, the same as the other two paths. An empty field is allowed
          past on purpose: an Apple account that already exists signs in without
          one, and a new one gets the server's needsDob answer back. The only
          thing stopped here is the date no living person can have, for the
          reason spelled out on dobLooksReal. */}
      <AppleSignInButton
        onSuccess={onSignupSuccess}
        onError={(m) => setError(m)}
        dob={dob}
        beforeAuthorize={() => {
          setError('');
          if (dob && !dobLooksReal(dob)) {
            setError('That date of birth does not look right. Check it and try again.');
            return false;
          }
          return true;
        }}
      />

      <p className="auth-foot">
        Already have an account?
        <button type="button" className="auth-textbtn" onClick={onSwitchToLogin}>Sign in</button>
      </p>
    </AuthShell>
  );
};

export default SignupScreen;
