import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AuthError, ageFromDob } from './AuthShell';
import BirthYearField, { birthYearToDob } from './BirthYearField';

// THE APPLE STEP, SHARED BY THE SIGN-IN AND SIGN-UP SCREENS.
//
// A brand-new Apple account is answered 403 {needsDob, dobGranularity:'year'},
// because Apple never sends a birth year. AppleSignInButton hands the screen a
// `resume` for that one answer: the credentials from the sheet that was just
// completed, held in a closure, ready to be sent again with a year (the reason
// that is allowed, and the rules for holding them, are written out above
// makeResume in AppleSignInButton.js). This is what a screen does with it:
// the year field and a Continue button take the place of the Apple button,
// and Continue posts the same credentials with the year. No second sheet.
//
// It was written inside LoginScreen for App Review's new-user path and moved
// here so the sign-up screen can finish a new Apple account the same way.
// Before that, sign-up refused to open Apple's sheet at all until the year
// field in its email form had been filled, which on the iPhone layout meant
// scrolling past the whole form to reach Apple, being sent back up to the
// year, and coming down again. That refusal existed because a refused first
// tap used to spend Apple's one delivery of the person's name; the held
// credentials carry that name, so the reason is gone.
//
//   step null      no Apple step on screen
//   step 'resume'  holding this sheet's credentials; Continue sends them again,
//                  or, once Apple's code has run out, opens Apple's sheet
//                  itself and sends the new one's with the year
//   step 'retap'   they are gone (the server said no, the connection died
//                  after sending, or a Google handle ran out); the provider's
//                  button is back and carries the year, so one more sheet ends it
//
// The handle lives in a ref, never in state, so nothing that reads component
// state can reach it, and it is dropped the moment it is used.
//
// `fieldId` is the id of the step's year field, focused when the step opens.
// `onSuccess` gets the user the server returns. `provider` is the name the
// step's own sentences use. Google's creation 403 is the same answer with the
// same kind of handle (see makeResume in useGoogleAuth.js), so the sign-up
// screen finishes a new Google account with this step too, and the only
// thing that differs is which button a sentence sends the person back to.
export function useAppleYearStep({ fieldId, onSuccess, provider = 'Apple' }) {
  const [step, setStep] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const resumeRef = useRef(null);
  // Counts the times the screen has closed the step. A Continue that is still
  // waiting on the server when the step is closed (the venue portal's "Create
  // an account", say) must not reopen it when its refusal lands: that drew
  // the step, "Your year is still filled in." and an empty field on the other
  // half of the form. The count is how the reply knows it is late.
  const leftRef = useRef(0);

  const leave = useCallback(() => {
    leftRef.current += 1;
    resumeRef.current = null;
    setStep(null);
    setError('');
  }, []);

  // The creation 403 arrived with credentials that can be sent again.
  const hold = useCallback((resume) => {
    resumeRef.current = resume;
    setError('');
    setStep('resume');
  }, []);

  // The creation 403 arrived with nothing held, so there is nothing to send
  // again: the step opens with the Apple button, which carries the year.
  const retap = useCallback((message) => {
    resumeRef.current = null;
    setError(message || '');
    setStep('retap');
  }, []);

  useEffect(() => {
    if (step !== 'resume') return;
    const field = document.getElementById(fieldId);
    if (!field) return;
    // preventScroll off on purpose: focusing is also what brings the field
    // into view on a short screen. scrollIntoView is the backstop for a
    // WebView that focuses without scrolling.
    field.focus();
    if (typeof field.scrollIntoView === 'function') field.scrollIntoView({ block: 'center' });
  }, [step, fieldId]);

  // Continue on the Apple step: the same credentials, now with the year.
  const continueWith = async (birthYear) => {
    if (busy) return;
    setError('');
    const sendDob = birthYearToDob(birthYear);
    // Two local checks, the same two the sign-up form makes: an empty field,
    // and a year nobody alive can have. Neither names an age; the server is
    // the only thing on any path that decides that.
    if (!sendDob) {
      setError('Add the year you were born.');
      document.getElementById(fieldId)?.focus();
      return;
    }
    const years = ageFromDob(sendDob);
    if (years === null || years < 0) {
      setError('That year does not look right. Check it and try again.');
      document.getElementById(fieldId)?.focus();
      return;
    }
    const resume = resumeRef.current;
    // Used once, whatever happens next.
    resumeRef.current = null;
    const visit = leftRef.current;
    setBusy(true);
    try {
      if (!resume) throw Object.assign(new Error(`${provider} sign-in timed out`), { expired: true });
      const data = await resume(sendDob, 'year');
      // An acceptance is followed even when the step was closed meanwhile:
      // the server has made the account and handed over a session, and the
      // person did press Continue.
      leave();
      onSuccess(data.user);
    } catch (err) {
      // Closed while this was in flight: the screen has moved on, so the
      // refusal changes nothing on it, and nothing held is put back.
      if (leftRef.current !== visit) return;
      // Provably never reached Flock (offline, or a captive portal answered):
      // the same credentials are still good, so Continue stays and can be
      // tapped again. Any other connection failure is ambiguous and falls
      // through to a fresh Apple sheet below.
      if ((err?.isOffline || err?.isCaptivePortal) && !err?.expired) {
        resumeRef.current = resume;
        setError(err.message);
        return;
      }
      // The hold had outlived Apple's code, so this Continue opened Apple's
      // sheet again (makeResume in AppleSignInButton.js), and the sheet was
      // dismissed. Nothing was sent and the handle is still good, so Continue
      // stays and opens it again. The sentence says why Apple asked twice.
      if (err?.cancelled) {
        resumeRef.current = resume;
        setError(`${provider} sign-in timed out, so ${provider} needs to check it is you again. Tap Continue to open it. Your year is still filled in.`);
        return;
      }
      // Otherwise the credentials are gone. Put the provider's button back;
      // it carries the year now, so one more sheet finishes the account.
      setStep('retap');
      // A lapsed token (401), a failed code exchange (503), a request that
      // timed out and a Google handle past its few minutes all mean the same
      // thing to the person: the sheet has to be done again. Anything else is
      // the server's answer word for word, which keeps the under-13 refusal
      // exactly what it was.
      const status = err?.status;
      const timedOut = err?.expired || err?.isTimeout || status === 401 || status === 503 || !status;
      setError(timedOut
        ? `${provider} sign-in did not finish in time. Tap Continue with ${provider} to try again. Your year is still filled in.`
        : (err?.message || `${provider} sign-in failed`));
    } finally {
      setBusy(false);
    }
  };

  return { step, error, setError, busy, hold, retap, leave, continueWith };
}

// The step itself: what is being asked, and the field to answer it in. The
// screen draws it where the provider's button is and puts Continue (below) in
// the button's place while the step is 'resume'. `idPrefix` keeps the screens'
// ids apart and `provider` the two providers' on one screen:
// `${idPrefix}-${provider}-year` is the field, `signup-apple-year` say.
// `hint` replaces the field's own line where a screen needs a different one;
// the venue portal's says the year is the owner's, not the venue's.
export default function AppleYearStep({ idPrefix, provider = 'apple', error, value, onChange, hint }) {
  const id = `${idPrefix}-${provider}`;
  return (
    <div className="auth-apple-step" id={`${id}-step`}>
      <AuthError>{error}</AuthError>
      <p className="auth-step-line" id={`${id}-step-line`}>
        One more step: the year you were born.
      </p>
      <BirthYearField
        id={`${id}-year`}
        hintId={`${id}-year-hint`}
        value={value}
        onChange={onChange}
        hint={hint}
      />
    </div>
  );
}

// Continue, in the Apple button's place. `busyLabel` because the same tap
// signs an existing account in on one screen and creates one on the other.
export function AppleStepContinue({ busy, busyLabel, onClick }) {
  return (
    <button type="button" className="auth-primary" disabled={busy} onClick={onClick}>
      {busy ? busyLabel : 'Continue'}
    </button>
  );
}
