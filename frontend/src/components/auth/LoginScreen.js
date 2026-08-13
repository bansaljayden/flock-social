import React, { useState } from 'react';
import { login, googleLoginWithToken } from '../../services/api';
import { useGoogleLogin } from '@react-oauth/google';
import AppleSignInButton from './AppleSignInButton';
import AuthShell, { AuthError, AuthRule, GoogleG, PasswordEye } from './AuthShell';

const LoginScreen = ({ onLoginSuccess, onSwitchToSignup, onSwitchToVenueLogin }) => {
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
  // when it shows the personalized "Continue as ..." variant). Access token is
  // verified server-side against our client id.
  const startGoogle = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      setLoading(true);
      try {
        const data = await googleLoginWithToken(tokenResponse.access_token, needsDob && dob ? dob : undefined);
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

  return (
    <AuthShell hero={hero}>
      <form onSubmit={handleSubmit}>
        <AuthError>{error}</AuthError>

        {/* The retry field the error message points at. It sits first so
            "below" in that copy is literally true, and so it is the next
            thing under the reader's eye on both the email and Google paths. */}
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
          <input
            id="login-email"
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
          <label className="auth-label" htmlFor="login-password">Password</label>
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

      <button
        type="button"
        className="auth-provider"
        onClick={() => { setError(''); startGoogle(); }}
        disabled={loading}
      >
        <GoogleG /> Continue with Google
      </button>

      {/* Apple guideline 4.8: Google login is offered above, so the native
          iOS app must offer Sign in with Apple too. Renders null on web. */}
      <AppleSignInButton onSuccess={onLoginSuccess} onError={(m) => setError(m)} />

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
