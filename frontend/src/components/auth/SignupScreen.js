import React, { useState } from 'react';
import { signup, googleLoginWithToken } from '../../services/api';
import { useGoogleLogin } from '@react-oauth/google';
import AppleSignInButton from './AppleSignInButton';
import { Meteors } from '../ui/meteors';

const colors = {
  navyDark: '#0f172a',
  cream: '#f0ead8',
  creamDark: '#e0dac9',
  navy: '#1a2744',
};

const EyeIcon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="rgba(148,163,184,0.8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
);

const EyeOffIcon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="rgba(148,163,184,0.8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);

const SignupScreen = ({ onSignupSuccess, onSwitchToLogin }) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [dob, setDob] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
      onSignupSuccess(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = {
    width: '100%',
    padding: '13px 16px',
    borderRadius: '12px',
    border: '1.5px solid rgba(148,163,184,0.15)',
    fontSize: '14px',
    fontWeight: '400',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
    backgroundColor: 'rgba(15,23,42,0.6)',
    color: 'white',
  };

  const handleFocus = (e) => { e.target.style.borderColor = colors.cream; e.target.style.boxShadow = '0 0 0 3px rgba(241,237,224,0.08)'; };
  const handleBlur = (e) => { e.target.style.borderColor = 'rgba(148,163,184,0.15)'; e.target.style.boxShadow = 'none'; };

  return (
    <div style={{
      minHeight: '100vh',
      background: colors.navyDark,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      fontFamily: "'Hanken Grotesk', -apple-system, BlinkMacSystemFont, sans-serif",
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute',
        top: '-20%',
        left: '-10%',
        width: '50%',
        height: '50%',
        background: 'radial-gradient(circle, rgba(241,237,224,0.05) 0%, transparent 70%)',
        borderRadius: '50%',
        pointerEvents: 'none',
      }}/>
      <div style={{
        position: 'absolute',
        bottom: '-15%',
        right: '-10%',
        width: '45%',
        height: '45%',
        background: 'radial-gradient(circle, rgba(241,237,224,0.03) 0%, transparent 70%)',
        borderRadius: '50%',
        pointerEvents: 'none',
      }}/>

      <Meteors number={15} />
      <div style={{
        width: '100%',
        maxWidth: '380px',
        animation: 'fadeInUp 0.7s ease-out',
        position: 'relative',
        zIndex: 1,
      }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <img
            src="/flock-logo.png"
            alt="Flock"
            style={{
              width: '200px',
              height: '200px',
              borderRadius: '50%',
              boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
              marginBottom: '12px',
              animation: 'floatIn 0.8s ease-out',
            }}
          />
          <p style={{
            fontSize: '15px',
            color: 'rgba(148,163,184,0.7)',
            fontWeight: '400',
            margin: 0,
          }}>Create your account</p>
        </div>

        {/* Form */}
        <div style={{
          backgroundColor: 'rgba(30,41,59,0.6)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderRadius: '20px',
          padding: '28px 24px',
          border: '1px solid rgba(148,163,184,0.1)',
        }}>
          <form onSubmit={handleSubmit}>
            {error && (
              <div style={{
                backgroundColor: 'rgba(239,68,68,0.1)',
                border: '1px solid rgba(239,68,68,0.25)',
                borderRadius: '12px',
                padding: '12px 14px',
                marginBottom: '20px',
                color: '#fca5a5',
                fontSize: '13px',
                fontWeight: '500',
              }}>{error}</div>
            )}

            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: 'rgba(148,163,184,0.9)', marginBottom: '8px' }}>Name</label>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" required style={inputStyle} onFocus={handleFocus} onBlur={handleBlur}/>
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: 'rgba(148,163,184,0.9)', marginBottom: '8px' }}>Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required style={inputStyle} onFocus={handleFocus} onBlur={handleBlur}/>
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: 'rgba(148,163,184,0.9)', marginBottom: '8px' }}>Date of birth</label>
              <input type="date" value={dob} max={maxDob} onChange={(e) => setDob(e.target.value)} required style={{ ...inputStyle, colorScheme: 'dark' }} onFocus={handleFocus} onBlur={handleBlur}/>
              <p style={{ fontSize: '11px', color: 'rgba(148,163,184,0.5)', margin: '6px 2px 0' }}>You must be at least 13 to use Flock.</p>
            </div>

            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: 'rgba(148,163,184,0.9)', marginBottom: '8px' }}>Password</label>
              <div style={{ position: 'relative' }}>
                <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" required minLength={8} style={{ ...inputStyle, paddingRight: '48px' }} onFocus={handleFocus} onBlur={handleBlur}/>
                <button type="button" onClick={() => setShowPassword(!showPassword)} style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
              {password.length > 0 && (
                <div style={{ marginTop: '10px', display: 'grid', gap: '6px' }}>
                  {pwChecks.map((c) => (
                    <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', fontWeight: '500', color: c.ok ? '#34d399' : 'rgba(148,163,184,0.75)' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={c.ok ? '#34d399' : 'rgba(148,163,184,0.55)'} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        {c.ok ? <polyline points="20 6 9 17 4 12" /> : <circle cx="12" cy="12" r="9" />}
                      </svg>
                      {c.label}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button type="submit" disabled={loading} style={{
              background: `linear-gradient(135deg, ${colors.cream} 0%, ${colors.creamDark} 100%)`,
              color: colors.navy, border: 'none', borderRadius: '12px', padding: '14px 24px', fontWeight: '700', fontSize: '15px',
              cursor: loading ? 'not-allowed' : 'pointer', width: '100%', boxShadow: '0 4px 16px rgba(241,237,224,0.15)',
              transition: 'border-color 0.2s ease, box-shadow 0.2s ease', opacity: loading ? 0.7 : 1, letterSpacing: '0.2px',
            }}>
              {loading ? 'Creating account...' : 'Create Account'}
            </button>
          </form>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '20px 0' }}>
            <div style={{ flex: 1, height: '1px', backgroundColor: 'rgba(148,163,184,0.12)' }} />
            <span style={{ fontSize: '12px', color: 'rgba(148,163,184,0.4)', fontWeight: '500' }}>or</span>
            <div style={{ flex: 1, height: '1px', backgroundColor: 'rgba(148,163,184,0.12)' }} />
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setError('');
              // Age gate the Google sign-up path too: DOB must be entered and
              // >= 13 before we create an account (parity with email signup).
              const age = ageFromDob(dob);
              if (age === null) {
                setError('Please enter your date of birth first');
                return;
              }
              if (age < MIN_AGE) {
                setError(`You must be at least ${MIN_AGE} to use Flock`);
                return;
              }
              startGoogle();
            }}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '13px', borderRadius: '12px', border: '1px solid rgba(148,163,184,0.25)', backgroundColor: 'rgba(255,255,255,0.04)', color: '#f4efe3', fontSize: '15px', fontWeight: '600', cursor: loading ? 'wait' : 'pointer' }}
          >
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
            </svg>
            Continue with Google
          </button>

          {/* Apple guideline 4.8 parity with the Google button above; native
              iOS only (returns null on web). Apple accounts don't carry DOB,
              and Apple requires its account holders to be 13+, so the age
              gate here matches the Google path's server-side behavior. */}
          <AppleSignInButton onSuccess={onSignupSuccess} onError={(m) => setError(m)} dob={dob} />

          <div style={{ textAlign: 'center', marginTop: '20px', paddingTop: '20px', borderTop: '1px solid rgba(148,163,184,0.08)', fontSize: '14px', color: 'rgba(148,163,184,0.6)' }}>
            Already have an account?{' '}
            <button onClick={onSwitchToLogin} style={{ background: 'none', border: 'none', color: colors.cream, fontWeight: '600', cursor: 'pointer', fontSize: '14px', padding: 0 }}>Sign In</button>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(24px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes floatIn {
          from { opacity: 0; transform: translateY(-12px) scale(0.9); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        ::placeholder {
          color: rgba(148,163,184,0.35) !important;
        }
      `}</style>
    </div>
  );
};

export default SignupScreen;
