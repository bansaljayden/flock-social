import React, { useEffect, useState } from 'react';
import request from '../../services/api';
import AuthShell, { AuthError } from './AuthShell';

/* ═══════════════════════════════════════════════════════════════════
   CONFIRM YOUR EMAIL — where the link in the signup email lands.

   WHY THIS IS A PAGE WITH A BUTTON AND NOT A LINK THAT JUST WORKS.

   The link used to point at the API, and opening it confirmed the
   address on the spot. Opening it is not the same as a person opening
   it. School and work mail gateways (Defender Safe Links, Proofpoint,
   Mimecast) fetch every link in a message the moment it arrives, so the
   gateway was confirming addresses nobody had clicked. That is all an
   address squat needs: sign up with a password on somebody's school
   address and the gateway proves the address for you, after which the
   owner's first Google or Apple sign-in is handed the squat's row, and a
   ban of the squat locks the owner's address out for a year.
   backend/routes/auth.js (GET and POST /verify-email) has the rest.

   So the token rides in the URL FRAGMENT, which no server, proxy log or
   scanner request ever carries, and nothing is spent until somebody
   presses the button. A scanner that renders the page does not press it.

   The outcome is not shown here. The page goes to /?email_verified=<it>,
   which App.js already turns into one sentence whether or not this
   browser is signed in (EMAIL_VERIFIED_COPY), so there is one place that
   says what happened to a confirmation link.
   ═══════════════════════════════════════════════════════════════════ */

export const VERIFY_PATH = '/verify-email';

// The same shape the server parses (parseVerificationToken in
// backend/routes/auth.js, and TOKEN_RE in PasswordReset.js, which mints from
// the same function): a 32-char hex selector, a dot, the base64url verifier.
const TOKEN_RE = /^[0-9a-f]{32}\.[A-Za-z0-9_-]{20,128}$/;

// Fragment first, query second, for the reason readResetToken gives: some
// mail clients rewrite links, and the person holding one is not the one to
// lecture about which half of the URL their provider moved the token to.
export function readVerifyToken() {
  if (typeof window === 'undefined') return '';
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
  const fromQuery = new URLSearchParams(window.location.search).get('token');
  return String(fromHash || fromQuery || '').trim();
}

// A replace, not an assign: Back from the result must not land on a page whose
// token has already been spent.
function landOn(outcome) {
  window.location.replace(`/?email_verified=${outcome}`);
}

const VerifyEmailPage = () => {
  // Captured once, at mount, BEFORE the address bar is cleaned below.
  const [token] = useState(readVerifyToken);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { document.title = 'Confirm your email | Flock'; }, []);

  // Take the credential out of the address bar: out of history, out of any
  // screenshot of this page, and out of the URL analytics would report.
  useEffect(() => {
    if (window.location.hash || window.location.search) {
      window.history.replaceState({}, '', VERIFY_PATH);
    }
  }, []);

  // A link a mail app cut in half cannot be confirmed by pressing anything, so
  // it goes straight to the answer the button would have got.
  useEffect(() => {
    if (!TOKEN_RE.test(token)) landOn('invalid');
  }, [token]);

  const confirm = async () => {
    setError('');
    setSending(true);
    try {
      await request('/api/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      landOn('1');
    } catch (err) {
      // A 400 is the server's verdict on the link, and it names which one.
      if (err && err.status === 400) {
        landOn(err.data && err.data.reason === 'expired' ? 'expired' : 'invalid');
        return;
      }
      // Anything else is the wire, not the link. Stay, so pressing the button
      // again is the whole fix.
      setError((err && err.message) || 'Flock could not be reached. Try again in a moment.');
      setSending(false);
    }
  };

  return (
    <AuthShell
      hero={(
        <>
          <img className="auth-mark" src="/logo192.png" alt="" aria-hidden="true" />
          <h1 className="auth-h1">Confirm your email</h1>
          <p className="auth-sub">One button and you are done.</p>
        </>
      )}
    >
      <p className="auth-sub" style={{ margin: '0 0 20px', maxWidth: 'none' }}>
        This confirms the Flock account that was made with this address. If you did not
        sign up for Flock, close this page and nothing will happen.
      </p>
      <AuthError>{error}</AuthError>
      <button type="button" className="auth-primary" onClick={confirm} disabled={sending}>
        {sending ? 'Confirming…' : 'Confirm my email'}
      </button>
    </AuthShell>
  );
};

export default VerifyEmailPage;
