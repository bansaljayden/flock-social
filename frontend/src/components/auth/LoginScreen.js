import React, { useState } from 'react';
import { login } from '../../services/api';

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

const LoginScreen = ({ onLoginSuccess, onSwitchToSignup }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const data = await login(email, password);
      onLoginSuccess(data.user);
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
    transition: 'all 0.2s ease',
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
      fontFamily: "'Satoshi', -apple-system, BlinkMacSystemFont, sans-serif",
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
              width: '220px',
              height: '220px',
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
          }}>Welcome back</p>
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
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: 'rgba(148,163,184,0.9)', marginBottom: '8px' }}>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                style={inputStyle}
                onFocus={handleFocus}
                onBlur={handleBlur}
              />
            </div>

            <div style={{ marginBottom: '24px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: '500', color: 'rgba(148,163,184,0.9)', marginBottom: '8px' }}>Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
                  style={{ ...inputStyle, paddingRight: '48px' }}
                  onFocus={handleFocus}
                  onBlur={handleBlur}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{
                    position: 'absolute',
                    right: '12px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{
                background: `linear-gradient(135deg, ${colors.cream} 0%, ${colors.creamDark} 100%)`,
                color: colors.navy,
                border: 'none',
                borderRadius: '12px',
                padding: '14px 24px',
                fontWeight: '700',
                fontSize: '15px',
                cursor: loading ? 'not-allowed' : 'pointer',
                width: '100%',
                boxShadow: '0 4px 16px rgba(241,237,224,0.15)',
                transition: 'all 0.2s ease',
                opacity: loading ? 0.7 : 1,
                letterSpacing: '0.2px',
              }}
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <div style={{
            textAlign: 'center',
            marginTop: '24px',
            paddingTop: '20px',
            borderTop: '1px solid rgba(148,163,184,0.08)',
            fontSize: '14px',
            color: 'rgba(148,163,184,0.6)',
          }}>
            Don't have an account?{' '}
            <button
              onClick={onSwitchToSignup}
              style={{
                background: 'none',
                border: 'none',
                color: colors.cream,
                fontWeight: '600',
                cursor: 'pointer',
                fontSize: '14px',
                padding: 0,
              }}
            >Sign Up</button>
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

export default LoginScreen;
