import React, { useEffect, useState } from 'react';
import request from '../../services/api';
import AuthShell, { AUTH, AuthError, AuthNotice, PasswordEye } from './AuthShell';

/* ═══════════════════════════════════════════════════════════════════
   PASSWORD RESET — the two screens either side of the email.

   ForgotPasswordScreen asks for an address. ResetPasswordScreen is
   where the link lands. They live in one file because they are one
   flow and neither is reachable from anywhere except LoginScreen,
   which owns the routing between all three.

   TWO THINGS THIS FILE IS CAREFUL ABOUT.

   1. The request screen must never confirm that an account exists.
      The server answers the same sentence either way (see
      backend/routes/auth.js POST /forgot-password), and the copy here
      has to hold the same line: "If there's an account for that
      address, we sent a link", never "check your inbox" as a promise
      we cannot keep for a typo'd address.

   2. The token is a credential. It arrives in the URL FRAGMENT, which
      no server, proxy log or Referer header ever sees, and the screen
      takes it out of the address bar on mount so it does not sit in
      history, in a screenshot, or in the analytics pageview that
      posthog-js builds from window.location.href.
   ═══════════════════════════════════════════════════════════════════ */

// The path the emailed link points at (services/emailService.js builds it from
// the pinned production web URL). Any unknown path already boots the app, so
// nothing else has to know about this route.
export const RESET_PATH = '/reset-password';

// Shape check, identical to parseVerificationToken on the server: a 32-char hex
// selector, a dot, then the base64url verifier. A link that a mail client cut
// in half is refused here instead of costing a round trip.
const TOKEN_RE = /^[0-9a-f]{32}\.[A-Za-z0-9_-]{20,128}$/;

export function isPasswordResetRoute() {
  return typeof window !== 'undefined' && window.location.pathname === RESET_PATH;
}

// Fragment first, query second. The mailed link uses the fragment; the query is
// accepted because some mail clients and link scanners rewrite URLs, and a
// user who cannot get back into their account is not the person to lecture
// about which half of a URL their provider mangled.
export function readResetToken() {
  if (typeof window === 'undefined') return '';
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
  const fromQuery = new URLSearchParams(window.location.search).get('token');
  return String(fromHash || fromQuery || '').trim();
}

const heroOf = (title, sub) => (
  <>
    <img className="auth-mark" src="/logo192.png" alt="" aria-hidden="true" />
    <h1 className="auth-h1">{title}</h1>
    <p className="auth-sub">{sub}</p>
  </>
);

/* ── Screen 1: ask for the link ─────────────────────────────────── */

export const ForgotPasswordScreen = ({ onBack, initialEmail = '' }) => {
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    // noValidate is on the form, so the empty case is caught here rather than
    // by a browser that draws nothing on iOS.
    if (!email.trim()) {
      setError('Add the email address you signed up with.');
      document.getElementById('forgot-email')?.focus();
      return;
    }
    setLoading(true);
    try {
      await request('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch (err) {
      setError(err.message || 'Could not start a reset. Try again in a moment.');
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <AuthShell hero={heroOf('Check your email', "If there's an account for that address, we sent a link.")}>
        <AuthNotice>Sent to {email}, if that address has an account.</AuthNotice>
        <p className="auth-sub" style={{ margin: '0 0 20px', maxWidth: 'none' }}>
          The link works once and stops working after an hour. If nothing lands in a couple of
          minutes, look in your spam folder. Accounts created with Google or Apple have no
          password to reset, so those get an email saying which button to press instead.
        </p>
        <button type="button" className="auth-primary" onClick={onBack}>Back to sign in</button>
        <p className="auth-foot">
          Wrong address?
          <button type="button" className="auth-textbtn" onClick={() => { setSent(false); setError(''); }}>
            Try another one
          </button>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell hero={heroOf('Forgot your password?', 'Give us the address you sign in with.')}>
      {/* noValidate: see the signup screen. handleSubmit is the only gate. */}
      <form onSubmit={handleSubmit} noValidate>
        <AuthError>{error}</AuthError>

        <div className="auth-field-row" style={{ marginBottom: '24px' }}>
          <label className="auth-label" htmlFor="forgot-email">Email</label>
          <input
            id="forgot-email"
            className="auth-field"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck="false"
            autoFocus
            required
          />
          <p className="auth-hint">
            We send the same reply whether or not that address has an account, so nobody can
            use this screen to find out who is on Flock.
          </p>
        </div>

        <button type="submit" className="auth-primary" disabled={loading}>
          {loading ? 'Sending…' : 'Send me a link'}
        </button>
      </form>

      <p className="auth-foot">
        Remembered it?
        <button type="button" className="auth-textbtn" onClick={onBack}>Back to sign in</button>
      </p>
    </AuthShell>
  );
};

/* ── Screen 2: the link lands here ──────────────────────────────── */

// What each server reason means to a person. The server tells us which of the
// three it is, and saying "expired" when we mean "already used" would send
// someone hunting through their inbox for a link that will never work again.
const DEAD_LINK_COPY = {
  expired: {
    title: 'That link expired',
    sub: 'Reset links last one hour.',
    body: 'Ask for a new one and it will be in your inbox in a minute. The old link cannot be revived, which is the point of it expiring.',
  },
  used: {
    title: 'That link was already used',
    sub: 'Each link works exactly once.',
    body: 'If you already set a new password, sign in with it. If you did not, ask for a new link now and change the password, because someone else opened this one.',
  },
  invalid: {
    title: 'That link does not work',
    sub: 'It may be incomplete, or a newer one replaced it.',
    body: 'Email apps sometimes break long links across two lines. Asking for a new link is the quickest fix. Only the newest link for an account works.',
  },
};

export const ResetPasswordScreen = ({ onSignIn, onRequestNew }) => {
  // Captured once, at mount, BEFORE the address bar is cleaned below.
  const [token] = useState(readResetToken);
  // 'checking' | 'ready' | 'saving' | 'done' | one of DEAD_LINK_COPY's keys
  const [phase, setPhase] = useState(() => (TOKEN_RE.test(readResetToken()) ? 'checking' : 'invalid'));
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');

  // Take the credential out of the address bar. It has already been read into
  // state, and leaving it there puts it in browser history, in any screenshot
  // of this screen, and in the $current_url that posthog-js reads off
  // window.location.href. Scrubbing to "/" also means a refresh lands on
  // sign-in rather than on a screen holding a token it no longer has.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.pathname === RESET_PATH || window.location.hash) {
      window.history.replaceState({}, '', '/');
    }
  }, []);

  // Ask what state the link is in before showing a form. Finding out that a
  // link is dead AFTER choosing and typing a password twice is the version of
  // this screen that makes people give up.
  useEffect(() => {
    if (phase !== 'checking') return undefined;
    let cancelled = false;
    request('/api/auth/reset-password/check', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
      .then((data) => {
        if (cancelled) return;
        if (data && data.valid) setPhase('ready');
        else setPhase(DEAD_LINK_COPY[data?.reason] ? data.reason : 'invalid');
      })
      .catch(() => {
        // A network failure is not a dead link. Show the form and let the
        // submit be the thing that reports the real answer.
        if (!cancelled) setPhase('ready');
      });
    return () => { cancelled = true; };
  }, [phase, token]);

  // Mirrors backend/routes/auth.js exactly (8 characters, one uppercase, one
  // number), which is the same policy signup enforces. Showing a rule the
  // server does not have, or hiding one it does, is how people end up guessing.
  const checks = [
    { label: '8 characters', ok: password.length >= 8 },
    { label: 'One uppercase letter', ok: /[A-Z]/.test(password) },
    { label: 'One number', ok: /[0-9]/.test(password) },
  ];
  const matches = confirm.length > 0 && confirm === password;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!checks.every((c) => c.ok)) {
      setError('Your password is missing a requirement below');
      return;
    }
    if (!matches) {
      setError('The two passwords do not match');
      return;
    }
    setPhase('saving');
    try {
      await request('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token, password }),
      });
      setPassword('');
      setConfirm('');
      setPhase('done');
    } catch (err) {
      // The server names which of the three dead-link states it is, so the
      // screen can stop pretending there is still a form to fill in.
      if (DEAD_LINK_COPY[err.data?.reason]) {
        setPhase(err.data.reason);
        return;
      }
      setError(err.message || 'Could not set that password. Try again in a moment.');
      setPhase('ready');
    }
  };

  if (phase === 'checking') {
    return (
      <AuthShell hero={heroOf('Set a new password', 'One moment.')}>
        <p className="auth-sub" role="status" style={{ margin: 0, maxWidth: 'none' }}>Checking your link…</p>
      </AuthShell>
    );
  }

  if (phase === 'done') {
    return (
      <AuthShell hero={heroOf('Password updated', 'Sign in with the new one.')}>
        <AuthNotice>Your password is set.</AuthNotice>
        <p className="auth-sub" style={{ margin: '0 0 20px', maxWidth: 'none' }}>
          Every device that was signed in to this account has been signed out, this one
          included. If someone else had been in there, they are out now.
        </p>
        {/* The only caller that reports a change. Every other route to the
            sign-in screen passes nothing, so the screen underneath cannot end
            up claiming a password was updated when it was not. */}
        <button type="button" className="auth-primary" onClick={() => onSignIn({ updated: true })}>Sign in</button>
      </AuthShell>
    );
  }

  const dead = DEAD_LINK_COPY[phase];
  if (dead) {
    return (
      <AuthShell hero={heroOf(dead.title, dead.sub)}>
        <p className="auth-sub" style={{ margin: '0 0 20px', maxWidth: 'none' }}>{dead.body}</p>
        <button type="button" className="auth-primary" onClick={onRequestNew}>Send me a new link</button>
        <p className="auth-foot">
          Know your password?
          <button type="button" className="auth-textbtn" onClick={() => onSignIn()}>Sign in</button>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell hero={heroOf('Set a new password', 'Pick one you have not used anywhere else.')}>
      {/* noValidate: see the signup screen. handleSubmit is the only gate. */}
      <form onSubmit={handleSubmit} noValidate>
        <AuthError>{error}</AuthError>

        <div className="auth-field-row">
          <label className="auth-label" htmlFor="reset-password">New password</label>
          <div className="auth-pw-wrap">
            <input
              id="reset-password"
              className="auth-field"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              minLength={8}
              autoFocus
              required
            />
            <PasswordEye shown={showPassword} onToggle={() => setShowPassword(!showPassword)} />
          </div>
          {password.length > 0 && (
            <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: '7px' }}>
              {checks.map((c) => (
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

        <div className="auth-field-row" style={{ marginBottom: '24px' }}>
          <label className="auth-label" htmlFor="reset-confirm">Type it again</label>
          <input
            id="reset-confirm"
            className="auth-field"
            type={showPassword ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="The same password"
            autoComplete="new-password"
            required
          />
          {confirm.length > 0 && !matches && (
            <p className="auth-hint" style={{ color: AUTH.red }}>These do not match yet.</p>
          )}
        </div>

        <button type="submit" className="auth-primary" disabled={phase === 'saving'}>
          {phase === 'saving' ? 'Saving…' : 'Save new password'}
        </button>
      </form>

      <p className="auth-hint" style={{ textAlign: 'center', marginTop: '14px' }}>
        Saving signs the account out on every device.
      </p>

      <p className="auth-foot">
        Changed your mind?
        <button type="button" className="auth-textbtn" onClick={() => onSignIn()}>Back to sign in</button>
      </p>
    </AuthShell>
  );
};

/* ── Standalone page ────────────────────────────────────────────────

   LoginScreen renders the two screens above and owns the routing between
   them, which covers the normal case: the link opens the app, nobody is
   signed in, LoginScreen is what is on screen.

   It does NOT cover a browser that still has a live session, because
   App.js renders the app instead of the sign-in screen and LoginScreen
   never mounts. That is a real case: somebody resetting a password they
   suspect is known, on a laptop they are still signed in on.

   This wrapper is the fix, and it is deliberately self-contained (it
   needs no props and navigates by URL) so mounting it costs one branch:

     } else if (window.location.pathname === '/reset-password') {
       const PasswordResetPage = React.lazy(() => import('./components/auth/PasswordReset')
         .then((m) => ({ default: m.PasswordResetPage })));
       root.render(<React.Suspense fallback={null}><PasswordResetPage /></React.Suspense>);
     }

   in frontend/src/index.js, alongside /delete-account and the rest. That
   file is owned elsewhere, so this is the half that could be built here.
   ──────────────────────────────────────────────────────────────────── */

export const PasswordResetPage = () => {
  const [view, setView] = useState('reset');
  const goHome = () => { window.location.assign('/'); };

  if (view === 'forgot') {
    return <ForgotPasswordScreen onBack={goHome} />;
  }
  return <ResetPasswordScreen onSignIn={goHome} onRequestNew={() => setView('forgot')} />;
};

export default ResetPasswordScreen;
