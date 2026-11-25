import React, { useState, useEffect, useRef } from 'react';
import { login, trackAuthScreen, userMessage, RESET_DONE_KEY } from '../../services/api';
import useGoogleAuth, { GOOGLE_BLOCKED_HINT, isGoogleSignInAvailable } from './useGoogleAuth';
import AppleSignInButton, { isAppleSignInAvailable } from './AppleSignInButton';
import AppleYearStep, { AppleStepContinue, useAppleYearStep } from './AppleYearStep';
import AuthShell, {
  ageFromDob, AuthError, AuthLabelRow, AuthNotice, AuthRule, formatDob, GoogleG, MIN_AGE, PasswordEye,
} from './AuthShell';
import BirthYearField, { birthYearToDob } from './BirthYearField';
import {
  ForgotPasswordScreen, ResetPasswordScreen, isPasswordResetRoute,
} from './PasswordReset';
import { asksForAge } from '../../lib/nativeShell';

// The same three pages SignupScreen links, for the consent line below.
const TERMS_URL = 'https://www.flockcorp.com/terms';
const PRIVACY_URL = 'https://www.flockcorp.com/privacy';
const GUIDELINES_URL = 'https://www.flockcorp.com/guidelines';

const PROVIDER_LABEL = { apple: 'Apple', google: 'Google' };
const NO_ACCOUNT_TEXT = {
  apple: 'No account uses this Apple ID. Make a new one, or sign in the way you made your account.',
  google: 'No account uses this Google account. Make a new one, or sign in the way you made your account.',
};

// The panel that NO FLOCK ACCOUNT YET (below) draws in the error line's
// place. role="group" and not "alert", for the reason the date read-back
// gives: nothing has failed, the server has asked a question. Focus moves to
// it when it opens, which is what announces it and what scrolls it into view
// on a short screen; the heading names it and the sentence describes it.
// Create account is the filled one because it is what the person was trying
// to do with a tap that found no account, and Not now is the way back to the
// buttons they may have meant.
const NoAccountPanel = ({ provider, busy, error, onCreate, onNotNow }) => {
  const ref = useRef(null);
  useEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    panel.focus();
    if (typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ block: 'center' });
  }, [provider]);
  return (
    <div
      className="auth-check"
      role="group"
      aria-labelledby="login-no-account-title"
      aria-describedby="login-no-account-text"
      id="login-no-account"
      tabIndex={-1}
      ref={ref}
    >
      <h2 id="login-no-account-title">No Flock account yet</h2>
      <p id="login-no-account-text">{NO_ACCOUNT_TEXT[provider]}</p>
      <AuthError>{error}</AuthError>
      <div className="auth-check-actions">
        <button type="button" className="auth-check-primary" disabled={busy} onClick={onCreate}>
          {busy ? 'Creating account…' : 'Create account'}
        </button>
        <button type="button" disabled={busy} onClick={onNotNow}>Not now</button>
      </div>
    </div>
  );
};

const LoginScreen = ({onLoginSuccess, onSwitchToSignup, onSwitchToVenueLogin }) => {
  // The password-reset screens hang off this one rather than off App.js: the
  // emailed link lands on /reset-password, index.js sends every unknown path to
  // the app, and the app renders this screen for anyone without a session. So
  // this component is already the thing on screen when the link is opened, and
  // it can route to the reset screen itself. Nothing in App.js needs to know.
  const [view, setView] = useState(() => (isPasswordResetRoute() ? 'reset' : 'login'));
  // Carried back from the reset flow, e.g. "Your password is set. Sign in."
  const [notice, setNotice] = useState('');
  // Drives the heading only. See the hero below for why it exists.
  const [hasSignedInHere] = useState(() => {
    try { return Boolean(window.localStorage.getItem('flockToken')); } catch (e) { return false; }
  });

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
  // Google's round trip, kept apart from the email form's. The two shared
  // `loading`, so a Google tap drew "Signing in…" on the email button while the
  // Google button went on saying Continue with Google.
  const [googleBusy, setGoogleBusy] = useState(false);
  // Legacy accounts created before the age gate have no DOB on file. The
  // backend answers 403 {needsDob: true}; we collect a date and retry.
  const [needsDob, setNeedsDob] = useState(false);
  const [dob, setDob] = useState('');
  // The exact date the user has confirmed is not a typo. Held as the VALUE and
  // not as a boolean, so editing the field after confirming asks again instead
  // of carrying an old yes onto a new date.
  const [dobConfirmed, setDobConfirmed] = useState('');

  // WHICH ASK THIS IS, decided by the server rather than guessed here.
  //
  // needsDob alone is ambiguous and that ambiguity shipped a bug. The same flag
  // comes back from two different situations: enforceDobOnLogin backfilling a
  // date onto an account that ALREADY EXISTS, and the Google/Apple handlers
  // refusing to CREATE one without a date. Those need different fields. The
  // backfill needs the exact date, because rounding it writes an under-13 value
  // and revokes every session permanently. Creation may only ask for the year,
  // because guideline 5.1.1(v) allows asking only for what the app needs, and
  // asking for the whole birthday there is what the app was rejected for.
  //
  // The creation 403s carry dobGranularity:'year'; the backfill 403 carries
  // nothing, so an older server or an unflagged path falls back to the full
  // date, which is the safe direction.
  const [dobGranularity, setDobGranularity] = useState(null);
  const [birthYear, setBirthYear] = useState('');
  const askYearOnly = dobGranularity === 'year';
  // The iPhone app asks nobody for a date of birth (lib/nativeShell.js), so
  // the server never answers it needsDob and none of the date fields on this
  // screen can open there. What that changes here is the consent line: see it
  // above the provider buttons.
  const askAge = asksForAge();
  // What actually gets sent, whichever field is on screen.
  const dobToSend = askYearOnly ? birthYearToDob(birthYear) : dob;
  // APPLE, GOOGLE, EMAIL, wherever Apple is one of the ways in: the iPhone
  // app and flockcorp.com. The sign-up screen and the venue portal keep the
  // same order from the same test, so whichever way somebody signed up with
  // sits in the same place on every screen (recognition rather than
  // recall), and the quickest way in, one sheet and an address Apple has
  // already proved, comes first. Where Apple is not offered (a preview
  // deploy, a laptop) the form stays on top, as it always was.
  const providersFirst = isAppleSignInAvailable();
  // Where the date read-back sits, seen from the provider buttons.
  const dobCheckWhere = providersFirst ? 'below' : 'above';

  // THE APPLE STEP. A new Apple account comes back 403 asking for a year, and
  // the credentials from that sheet can be sent again with it (the reason is
  // written out above makeResume in AppleSignInButton.js). While that is true
  // the year field moves down to where the Apple button was, which is where
  // the person is looking at 375x667, and a Continue in the actions bar takes
  // over from the Apple button. The step's states and its Continue live in
  // AppleYearStep.js, shared with the sign-up screen; this screen decides only
  // when to open it and what to show around it.
  const apple = useAppleYearStep({ fieldId: 'login-apple-year', onSuccess: onLoginSuccess });
  const appleStep = apple.step;
  // THE GOOGLE STEP, the same step for a new Google account. Its creation 403
  // comes with the proof from Google's sheet held (makeResume in
  // useGoogleAuth.js), and the sign-up screen already finishes with it. This
  // screen used to drop it and say "tap Continue with Google again", which
  // cost a brand-new account a second Google sheet. Now the year is asked in
  // the Google button's place and Continue posts the same proof with it.
  const google = useAppleYearStep({ fieldId: 'login-google-year', provider: 'Google', onSuccess: onLoginSuccess });
  // One step open at a time, so there is only ever one year field on screen.
  const stepOpen = Boolean(appleStep || google.step);
  const leaveSteps = () => { apple.leave(); google.leave(); };

  // NO FLOCK ACCOUNT YET. This screen's Apple and Google taps send intent
  // 'signin' (services/api.js, opts.intent), and the server answers a
  // credential with no account behind it 409 {noAccount, canCreate} instead
  // of making one. It used to make one. Somebody whose account was made with
  // Google tapped Continue with Apple with Hide My Email, got a second, empty
  // account, and the app opened it as if it were theirs, with no word that it
  // was new: no friends, no plans, and no way to tell why.
  //
  // So that answer is a question now, asked in the error line's place: make a
  // new account, or go back and use the way the account was made. The sheet's
  // proof comes with it as a one-use handle (THE SAME HOLD, FOR "CREATE
  // ACCOUNT" in useGoogleAuth.js and AppleSignInButton.js), kept in a ref and
  // never in state, for the reason AppleYearStep.js gives. Create account
  // sends the same proof with intent 'create', so nobody goes through the
  // sheet twice; past its five minutes the app opens the sheet again itself,
  // and the website puts its Google button back with a line saying so. Not
  // now drops the proof.
  //
  // `createFor` is the provider whose button a Create account has just sent
  // the person back to, to finish the account they asked for: the website's
  // Google button after its hold ran out ("Tap Continue with Google to make
  // your account."), a year step's button after a lost hold, and the server's
  // warning about an unconfirmed account, which ends "tap Continue with Google
  // again". The year ask sets it wherever it lands: on Create account, and on
  // the button's own 'create', the tap the first line sends the person to.
  // Either way the step it opens can lose its hold or meet the warning at its
  // Continue, and the button is then the way on. The warning sets it wherever
  // it lands too: on Create account, and on a tap of the button itself, such
  // as the one an earlier warning asked for made after the server's ten
  // minutes (warnBeforeEvictingUsedAccount in backend/routes/auth.js), which
  // is warned again in a sentence that again says to tap once more. That
  // button's NEXT tap sends 'create', so it makes the account it was asked to
  // make instead of asking the same question again, and no tap after it does.
  //
  // It used to be set the moment Create account was tapped and kept until Not
  // now. A create that failed any other way (a server error, a timeout) closed
  // the panel and so took Not now away with it, and from then on every tap of
  // that button sent 'create' for whichever Google account or Apple ID its
  // sheet returned: a new, empty account opened with no question, which is
  // the thing this panel is here to stop. Now only the three answers above
  // set it, the next tap of either provider spends it (freshAttempt below),
  // and every way off the providers forgets it: the email form's Sign in,
  // Forgot password, "Sign in with email instead" and Not now.
  const [offer, setOffer] = useState(null);
  const offerRef = useRef(null);
  // Counts the panel's closings, so a Create account still waiting on the
  // server when a new tap closes the panel does not draw a refusal onto a
  // screen that has moved on (the same rule as leftRef in AppleYearStep.js).
  const offerVisit = useRef(0);
  const [offerBusy, setOfferBusy] = useState(false);
  const [offerError, setOfferError] = useState('');
  const [createFor, setCreateFor] = useState(null);
  // The quiet line under the buttons when Google's sheet in the app closed
  // after long enough that Google may have refused the account
  // (GOOGLE_SLOW_DISMISS_MS in useGoogleAuth.js).
  const [googleHint, setGoogleHint] = useState(false);

  const closeOffer = () => {
    offerVisit.current += 1;
    offerRef.current = null;
    setOffer(null);
    setOfferError('');
  };
  const openOffer = (provider, resume) => {
    closeOffer();
    leaveSteps();
    setError('');
    offerRef.current = resume;
    setOffer(provider);
  };
  // A NEW TAP STARTS CLEAN. Either provider's button clears what an earlier
  // attempt left on screen: the error line, an open panel and its proof, the
  // Google hint. It used to clear only its own, so a Google failure stayed
  // under an Apple sheet the person then dismissed, and read as Apple's.
  //
  // It also spends createFor, whichever button was tapped. The tap it was
  // kept for has already read it: the Google button reads it before calling
  // this, and Apple's click posts the intent the button was drawn with. So a
  // sheet that tap opens and the person dismisses leaves nothing behind, and
  // the tap after it asks to sign in again, for whatever account it brings.
  //
  // And it closes the OTHER provider's year step, with the proof it holds,
  // as it closes the panel. A year step is only ever a 'create' (a year ask
  // answers nothing else), and what kept its button a 'create' is the
  // createFor this tap has just spent. It used to stay open, so on the
  // website Google's step outlived an Apple popup the person closed, its
  // Continue met the unconfirmed-account warning ("tap Continue with Google
  // again"), and that tap sent 'signin' and reopened the no-account panel; a
  // lost hold sent the person to the same tap. The tapped provider's own step
  // stays, because that tap is the one its line asks for.
  const freshAttempt = (provider) => {
    setError('');
    closeOffer();
    setGoogleHint(false);
    setCreateFor(null);
    (provider === 'apple' ? google : apple).leave();
  };

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
    intent: 'signin',
    onSlowDismiss: () => setGoogleHint(true),
    onSuccess: (user) => { leaveSteps(); onLoginSuccess(user); },
    onError: (msg, err, resume) => {
      if (err?.data?.noAccount && resume) {
        openOffer('google', resume);
        return;
      }
      // The unconfirmed-account warning, answered to this button's own tap.
      // Only a 'create' gets it (a 'signin' is told noAccount first), so this
      // is a tap a line sent the person back to: after a hold that ran out, or
      // after an earlier warning the server has since forgotten. Its sentence
      // ends "tap Continue with Google again", and that next tap has to do
      // what it says, as it does when the warning answers Create account
      // (createFor above). It used to send 'signin' and open the no-account
      // panel instead. Shown where any other refusal is, below.
      if (err?.data?.unconfirmedAccount) setCreateFor('google');
      if (err?.data?.needsDob) {
        const granularity = err.data.dobGranularity || null;
        setNeedsDob(true);
        setDobGranularity(granularity);
        // The year ask is the server agreeing to make this account once it
        // has a year, and it only ever answers a 'create' (a 'signin' is told
        // noAccount first): the tap a line sent the person back to, whose
        // 'create' freshAttempt has just spent. So this button's next tap
        // finishes the account, as it does after Create account's year ask
        // below (createFor above). It used to keep nothing, and when the step
        // then lost its hold, or its Continue met the warning ("tap Continue
        // with Google again"), the tap the line asked for sent 'signin' and
        // reopened the no-account panel.
        if (granularity === 'year') setCreateFor('google');
        // A new account asked for its year, with Google's proof held: the
        // Google step (THE GOOGLE STEP above). The server's sentence says to
        // tap Google again, which is what the step makes unnecessary, so it
        // is not shown.
        if (granularity === 'year' && resume) {
          setError('');
          apple.leave();
          google.hold(resume);
          return;
        }
        // Nothing held, or the full date a backfill needs: the field goes
        // up to the form, as it always did.
        leaveSteps();
        setError(granularity === 'year'
          ? 'Add the year you were born below, then tap Continue with Google again.'
          : 'Add your date of birth below, then tap Continue with Google again.');
      } else if (google.step) {
        // The retap after a timeout, answered: beside the button tapped.
        google.setError(msg || 'Google sign-in failed');
      } else {
        setError(msg || 'Google sign-in failed');
      }
    },
    setBusy: setGoogleBusy,
  });

  // Create account, in the panel: the held proof again, with intent 'create'.
  const createAccount = async () => {
    if (offerBusy || !offer) return;
    const provider = offer;
    const name = PROVIDER_LABEL[provider];
    const resume = offerRef.current;
    // Used once, whatever happens next.
    offerRef.current = null;
    const visit = offerVisit.current;
    // createFor is not set here. A panel is only ever opened by a provider's
    // tap, which spent it, so it is empty now, and only the three answers
    // below that send the person back to this provider's button set it.
    setOfferError('');
    setOfferBusy(true);
    try {
      if (!resume) throw Object.assign(new Error(`${name} sign-in timed out`), { expired: true });
      const data = await resume();
      // An account made is followed even if the panel was closed meanwhile:
      // the server has made it and handed over a session.
      closeOffer();
      leaveSteps();
      onLoginSuccess(data.user);
    } catch (err) {
      if (offerVisit.current !== visit) return;
      // Nothing was sent: the app's sheet, reopened past the proof's minutes,
      // was dismissed, or the request provably never reached Flock. The same
      // handle is still good, so the panel stays and Create account works
      // again. A dismissed sheet says nothing, as everywhere else.
      if (err?.cancelled || ((err?.isOffline || err?.isCaptivePortal) && !err?.expired)) {
        offerRef.current = resume;
        if (!err?.cancelled) setOfferError(err.message);
        return;
      }
      closeOffer();
      // The website asks every new account for its year, so a create there is
      // answered with the year ask, and its handle comes back on the error
      // (err.resume, bound to 'create'). The year step takes over exactly as
      // it does for any other new account.
      if (err?.data?.needsDob && err.data.dobGranularity === 'year') {
        const step = provider === 'apple' ? apple : google;
        setNeedsDob(true);
        setDobGranularity('year');
        // The step's button after a lost hold, or the line below, is the
        // provider's button, and its next tap finishes this account.
        setCreateFor(provider);
        if (err.resume) {
          step.hold(err.resume);
        } else {
          setError(`Add the year you were born below, then tap Continue with ${name} again.`);
        }
        return;
      }
      // The proof ran out where there is no sheet to reopen: the website's
      // Google popup, which a Continue must not wait on (useGoogleAuth.js
      // says why). Its button is still there, and its next tap sends 'create'.
      if (err?.expired) {
        setCreateFor(provider);
        setError(`Tap Continue with ${name} to make your account.`);
        return;
      }
      // The server's warning about an unconfirmed account that holds
      // something (warnBeforeEvictingUsedAccount in backend/routes/auth.js).
      // Its sentence ends by saying a tap on this button starts the new
      // account, so that tap sends 'create', and the server, which remembers
      // the warning, then makes it.
      if (err?.data?.unconfirmedAccount) {
        setCreateFor(provider);
        setError(userMessage(err, `${name} sign-in didn't finish. Try again, or use email.`));
        return;
      }
      // Anything else is the server's own sentence when it wrote one: an
      // address that belongs to another account says which way to sign in.
      // createFor stays empty, so the next tap asks again.
      setError(userMessage(err, `${name} sign-in didn't finish. Try again, or use email.`));
    } finally {
      setOfferBusy(false);
    }
  };

  const notNow = () => {
    closeOffer();
    setCreateFor(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    // Signing in with email is the panel's other answer, so it closes it, and
    // it is the person going another way, so a 'create' a provider's button
    // was keeping for its next tap goes too (createFor above). Kept, a wrong
    // password here left that tap making an account for whichever Google
    // account or Apple ID its sheet returned, with the line that said so gone.
    closeOffer();
    setCreateFor(null);

    // The form carries noValidate, so these checks are the only thing standing
    // between an incomplete form and a request. See the comment on the <form>.
    // Order follows the fields down the screen, and the date of birth is first
    // only when it is actually on screen, which is where it is rendered.
    // Only when the FULL-DATE field is the one on screen. In year mode the
    // year belongs to a provider's account-creation ask, not to this form,
    // which is a password sign-in and therefore a backfill on a row that
    // already exists: it sends no date, and if the server wants one it
    // answers with the backfill 403, which flips the screen to the date field.
    if (needsDob && !askYearOnly && !dob) {
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
      // Never dobToSend here: a derived December 31 must not reach a backfill.
      const data = await login(email, password, needsDob && !askYearOnly && dob ? dob : undefined);
      onLoginSuccess(data.user);
    } catch (err) {
      if (err.data?.needsDob) {
        setNeedsDob(true);
        // CLEARS any 'year' a provider tap left behind. Reaching here means
        // the password matched an account that already exists, so this is
        // enforceDobOnLogin backfilling a row, never creation, and the exact
        // date is required: rounding it would write an under-13 value, revoke
        // every session and lock a real person out permanently. The full-date
        // field is the only one this path may show.
        setDobGranularity(null);
        leaveSteps();
        setError(needsDob && !askYearOnly && dob
          ? err.message
          : 'One more thing: add your date of birth below to continue.');
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  // Every fresh install now opens on this screen, not on account creation, so
  // "Welcome back" can no longer be unconditional: it would greet people who
  // have never been here, which is the thing the old signup-first branch was
  // added to avoid. A stored token, valid or expired, is the evidence that
  // somebody has signed in on this device before. Read once at mount so the
  // heading cannot change under a person mid-session.
  const hero = (
    <>
      <img className="auth-mark" src="/logo192.png" alt="" aria-hidden="true" />
      <h1 className="auth-h1">{hasSignedInHere ? 'Welcome back' : 'Plan the night'}</h1>
      <p className="auth-sub">Nurturing friendship, one flock at a time.</p>
    </>
  );

  // Guideline 1.2 / EULA consent, worded exactly as SignupScreen words it.
  // Drawn in one of two places, never both: see where it is used below.
  const consent = (
    <p className="auth-legal">
      Creating an account means you agree to the{' '}
      <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">Terms</a>,{' '}
      <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">Privacy Policy</a>, and{' '}
      <a href={GUIDELINES_URL} target="_blank" rel="noopener noreferrer">Community Guidelines</a>, including the product analytics they describe.
    </p>
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

  const form = (
    <>
      {/* noValidate, for the reason written out at length on the signup form.
          iOS draws no validation bubble, so `required` on the fields below
          turned Sign in into a button that refused the submit and displayed
          nothing at all. Production PostHog recorded dead clicks on this
          screen's email and password fields too. handleSubmit is now the only
          gate and it always renders a message through AuthError. Its Sign in
          button is in AuthShell's actions bar and names this form by id. */}
      <form id="login-form" onSubmit={handleSubmit} noValidate>
        {/* NO FLOCK ACCOUNT YET takes the error line's place while it asks;
            openOffer clears the line, so the two never stand together. */}
        {offer ? (
          <NoAccountPanel
            provider={offer}
            busy={offerBusy}
            error={offerError}
            onCreate={createAccount}
            onNotNow={notNow}
          />
        ) : (
          <AuthError>{error}</AuthError>
        )}
        <AuthNotice>{notice}</AuthNotice>

        {/* The retry field the error message points at. It sits first so
            "below" in that copy is literally true, and so it is the next
            thing under the reader's eye on the email, Google and Apple paths.
            Not while a provider's step is open: the step has its own. */}
        {needsDob && !stepOpen && (
          askYearOnly ? (
            <BirthYearField
              id="login-dob"
              hintId="login-dob-hint"
              value={birthYear}
              onChange={setBirthYear}
            />
          ) : (
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
          )
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
            name="username"
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

        <div className="auth-field-row">
          {/* The way back in for anyone who cannot remember it. It sits on the
              password label's line, which is where people look for it, and it
              carries whatever is already typed in the email field so the next
              screen does not ask for it twice. */}
          <AuthLabelRow>
            <label className="auth-label" htmlFor="login-password">Password</label>
            <button
              type="button"
              className="auth-link hit44"
              /* Forgets createFor for the reason handleSubmit does: this
                 screen stays mounted under the forgot-password one, and its
                 way back lands here with the line gone. */
              onClick={() => { setError(''); setNotice(''); setCreateFor(null); setView('forgot'); }}
            >
              Forgot password?
            </button>
          </AuthLabelRow>
          <div className="auth-pw-wrap">
            <input
              id="login-password"
              name="password"
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
      </form>
    </>
  );

  const googleBlock = isGoogleSignInAvailable() && (
    <>
      {/* Hidden only when a native build carries no iOS Google client id, i.e.
          when the button could not work by any route. On web it always shows.
          While a new Google account's year is being asked, the Google step
          takes the button's place and its Continue is the actions bar's
          button (THE GOOGLE STEP above). */}
      {google.step && (
        <AppleYearStep
          idPrefix="login"
          provider="google"
          error={google.error}
          value={birthYear}
          onChange={(v) => { setBirthYear(v); google.setError(''); }}
        />
      )}
      {google.step !== 'resume' && (
        <button
          type="button"
          className="auth-provider"
          onClick={() => {
            if (dobNeedsCheck) {
              setError(`Check the date of birth ${dobCheckWhere} before you continue.`);
              document.getElementById('login-dob-check')?.focus();
              return;
            }
            // Read before freshAttempt spends it: 'signin' unless a Create
            // account has just sent the person back to this button to finish
            // their account (createFor, NO FLOCK ACCOUNT YET above).
            const create = createFor === 'google';
            freshAttempt('google');
            google.setError('');
            startGoogle({
              dob: needsDob && dobToSend ? dobToSend : undefined,
              dobGranularity: askYearOnly ? 'year' : undefined,
              ...(create ? { intent: 'create' } : {}),
            });
          }}
          disabled={loading || googleBusy}
        >
          <GoogleG /> {googleBusy ? 'Signing in…' : 'Continue with Google'}
        </button>
      )}
    </>
  );

  const appleBlock = (
    <>
      {/* Apple guideline 4.8: Google login is offered, so the native iOS app
          must offer Sign in with Apple too. On the web it draws only on
          flockcorp.com, through Apple's popup (AppleSignInButton.js).

          `dob` and the needsDob branch are not decoration. Apple never sends a
          date of birth, so the server refuses to CREATE an account without one
          and answers 403 {needsDob:true}. Someone whose first ever tap is
          Continue with Apple on this screen — a reviewer, say — used to get a
          message pointing at a field that was not on the page and a button
          that could never send it, which is a dead end on the first screen of
          the app.

          That first 403 is now finished in place (see THE APPLE STEP above):
          the year field appears where this button was, a Continue is the
          actions bar's button, and Continue sends the same Apple credentials
          again with the year. No second Apple sheet. */}
      {appleStep && (
        <AppleYearStep
          idPrefix="login"
          error={apple.error}
          value={birthYear}
          onChange={(v) => { setBirthYear(v); apple.setError(''); }}
        />
      )}

      {appleStep !== 'resume' && (
      <AppleSignInButton
        onSuccess={(user) => { leaveSteps(); onLoginSuccess(user); }}
        dob={needsDob && dobToSend ? dobToSend : undefined}
        dobGranularity={askYearOnly ? 'year' : undefined}
        /* 'signin' unless a Create account has just sent the person back to
           this button to finish their account (createFor, NO FLOCK ACCOUNT
           YET above). The click posts the intent the button was drawn with,
           so beforeAuthorize can spend it below. */
        intent={createFor === 'apple' ? 'create' : 'signin'}
        /* Returning false stops the native sheet before it opens. Apple's flow
           is the one path that cannot be re-entered from a confirmation panel,
           because the sheet needs this button's own tap, so the guard has to
           sit in front of it rather than around it. */
        beforeAuthorize={() => {
          if (dobNeedsCheck) {
            setError(`Check the date of birth ${dobCheckWhere} before you continue.`);
            document.getElementById('login-dob-check')?.focus();
            return false;
          }
          freshAttempt('apple');
          apple.setError('');
          return true;
        }}
        onError={(m, err, resume) => {
          if (err?.data?.noAccount && resume) {
            openOffer('apple', resume);
            return;
          }
          // The same warning answered to this tap, for the reason the Google
          // button's handler gives: its sentence says to tap Continue with
          // Apple again, so that tap sends 'create'.
          if (err?.data?.unconfirmedAccount) setCreateFor('apple');
          if (err?.data?.needsDob) {
            // Read off the answer, not off screen state: askYearOnly is the
            // PREVIOUS render's value, which is how the first message used to
            // say "date of birth" over a field labelled "Year of birth".
            const granularity = err.data.dobGranularity || null;
            setNeedsDob(true);
            setDobGranularity(granularity);
            // A year ask answers only a 'create', so the button's next tap
            // finishes the account, for the reason the Google button's
            // handler gives.
            if (granularity === 'year') setCreateFor('apple');
            if (granularity === 'year' && resume) {
              setError('');
              google.leave();
              apple.hold(resume);
              return;
            }
            leaveSteps();
            setError(needsDob && dobToSend
              ? m
              : granularity === 'year'
                ? 'Add the year you were born below, then tap Continue with Apple again.'
                : 'Add your date of birth below, then tap Continue with Apple again.');
          } else if (appleStep) {
            // The retap after a timeout, answered by the server: show it
            // next to the button that was tapped. Under-13 lands here, with
            // the server's own words, exactly as it did before.
            apple.setError(m);
          } else {
            setError(m);
          }
        }}
      />
      )}
    </>
  );

  // THE ONE FILLED BUTTON, in AuthShell's actions bar, where it is on every
  // auth screen. While a provider's step holds a sign-in it is that step's
  // Continue. While a step has lost its hold ('retap') the provider's own
  // button in the sheet is the way on, so the bar is left empty rather than
  // offering a second thing to press. Otherwise it is Sign in, which submits
  // the email form by its id.
  let actions = null;
  if (appleStep === 'resume') {
    actions = <AppleStepContinue busy={apple.busy} busyLabel="Signing in…" onClick={() => apple.continueWith(birthYear)} />;
  } else if (google.step === 'resume') {
    actions = <AppleStepContinue busy={google.busy} busyLabel="Signing in…" onClick={() => google.continueWith(birthYear)} />;
  } else if (!stepOpen) {
    actions = (
      <button type="submit" form="login-form" className="auth-primary" disabled={loading || googleBusy}>
        {loading ? 'Signing in…' : 'Sign in'}
      </button>
    );
  }

  return (
    <AuthShell hero={hero} actions={actions}>
      {/* THE ORDER (providersFirst above): Apple, Google, then the email
          form wherever Apple is offered; the form on top and the providers
          under it where it is not. Either way the form steps aside while a
          provider's year step is open (below). */}
      {!providersFirst && !stepOpen && (
        <>
          {form}
          <AuthRule label="or continue with" />
        </>
      )}

      {/* In the iPhone app a first tap on either provider button creates the
          account straight away, because the app asks for no date of birth and
          so is never answered needsDob first. The agreement therefore has to
          be on screen before those buttons are, from the start, rather than
          after a needsDob as on the website (see the consent line below).
          The line's own top margin is for sitting under a button; here it
          sits over two, so the gap goes below it, as on the sign-up screen. */}
      {!askAge && <div style={{ marginBottom: '16px' }}>{consent}</div>}

      {providersFirst ? (
        <>
          {appleBlock}
          {/* Wrapped for its gap: the stylesheet's .auth-provider +
              .auth-provider rule needs the two buttons to be siblings, and
              the Apple step puts its field between them. */}
          {googleBlock && <div style={{ marginTop: '10px' }}>{googleBlock}</div>}
        </>
      ) : (
        <>
          {googleBlock}
          {appleBlock}
        </>
      )}

      {/* Quiet, not red: nothing is known to have failed, only that Google's
          sheet stayed open a while and closed without an answer. role
          "status" so a screen reader hears it without being interrupted. */}
      {googleHint && (
        <p className="auth-hint" role="status" style={{ textAlign: 'center', marginTop: '12px' }}>
          {GOOGLE_BLOCKED_HINT}
        </p>
      )}

      {/* Guideline 1.2 / EULA consent, worded exactly as SignupScreen words
          it. The Google and Apple buttons above CREATE an account for anyone
          who has none, and the server stamps terms_accepted_at on that row,
          so the agreement has to be on this screen too. It appears once the
          server has asked for a date of birth, which is the one state from
          which the next tap creates the account: a first tap on either button
          is always answered needsDob before any row is written, and an
          account that already exists signs in without seeing it. That holds
          on the website; the iPhone app shows the line above the buttons. */}
      {/* The no-account panel's Create account makes the account too, so the
          agreement is on screen while it asks. */}
      {askAge && (needsDob || offer) && consent}

      {/* Under the providers, the email form; while a provider's year step
          is open it steps aside, in either order, as on the sign-up screen:
          one year field on screen and one thing to tap (fewer choices at the
          moment of deciding), and the bar's button is the step's Continue.
          Leaving drops the held sign-in, and a later provider tap opens a new
          sheet. */}
      {stepOpen ? (
        <button
          type="button"
          className="auth-textbtn"
          onClick={() => { leaveSteps(); setError(''); setCreateFor(null); }}
          style={{ display: 'block', margin: '16px auto 0' }}
        >
          Sign in with email instead
        </button>
      ) : providersFirst && (
        <>
          <AuthRule label="or sign in with email" />
          {form}
        </>
      )}

      {/* The server will not say which addresses belong to Google or Apple
          accounts, because answering that turns login into an account
          enumeration oracle. So the hint lives here instead, standing, for
          everyone: a returning OAuth user who types their email and password
          gets a password failure they cannot otherwise explain. It names
          only the buttons this screen has. Apple is one of them in the
          iPhone app and on flockcorp.com, and an Apple ID made on either
          signs in on the other as the same account. */}
      {!stepOpen && (
        <p className="auth-hint" style={{ textAlign: 'center', marginTop: '12px' }}>
          {isAppleSignInAvailable()
            ? 'Signed up with Google or Apple? Use that button.'
            : 'Signed up with Google? Use that button.'}
        </p>
      )}

      <p className="auth-foot">
        New here?
        <button type="button" className="auth-textbtn" onClick={onSwitchToSignup}>Create an account</button>
      </p>

      <button type="button" className="auth-venue" onClick={onSwitchToVenueLogin}>
        Run a venue? <span>Sign in here</span>
      </button>
    </AuthShell>
  );
};

export default LoginScreen;
