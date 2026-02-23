import React, { useState } from 'react';
import { login } from '../../services/api';

const colors = {
  navy: '#0d2847',
  navyLight: '#1a3a5c',
  navyMid: '#2d5a87',
  cream: '#f5f0e6',
  creamDark: '#e8e0d0',
  teal: '#14B8A6',
  red: '#EF4444',
};

const UsersIcon = ({ color = 'white', size = 40 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
    <circle cx="9" cy="7" r="4"></circle>
    <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
    <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
  </svg>
);

const EyeIcon = ({ color = 'rgba(245,240,230,0.5)', size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
    <circle cx="12" cy="12" r="3"></circle>
  </svg>
);

const EyeOffIcon = ({ color = 'rgba(245,240,230,0.5)', size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
    <line x1="1" y1="1" x2="23" y2="23"></line>
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

  return (
    <div style={{
      minHeight: '100vh',
      background: `linear-gradient(135deg, ${colors.navy} 0%, ${colors.navyLight} 50%, ${colors.navyMid} 100%)`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    }}>
      <div style={{
        width: '100%',
        maxWidth: '400px',
        animation: 'fadeInUp 0.6s ease-out',
      }}>
        {/* Logo - matches main app */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div style={{
            width: '80px',
            height: '80px',
            borderRadius: '24px',
            background: `linear-gradient(135deg, ${colors.navy}, ${colors.navyMid})`,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '16px',
            boxShadow: '0 8px 32px rgba(13,40,71,0.3)',
            border: '2px solid rgba(255,255,255,0.1)',
          }}>
            <UsersIcon color="white" size={40} />
          </div>
          <h1 style={{
            fontSize: '28px',
            fontWeight: '900',
            color: colors.cream,
            margin: '0 0 4px',
            letterSpacing: '-0.5px',
          }}>Flock</h1>
          <p style={{
            fontSize: '13px',
            color: 'rgba(245,240,230,0.5)',
            fontWeight: '500',
            margin: 0,
          }}>Welcome back</p>
        </div>

        {/* Card */}
        <div style={{
          backgroundColor: 'rgba(255,255,255,0.08)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderRadius: '24px',
          padding: '32px 28px',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
        }}>
          <form onSubmit={handleSubmit}>
            {error && (
              <div style={{
                backgroundColor: 'rgba(239,68,68,0.15)',
                border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: '12px',
                padding: '12px 16px',
                marginBottom: '20px',
                color: '#fca5a5',
                fontSize: '13px',
                fontWeight: '600',
              }}>{error}</div>
            )}

            <div style={{ marginBottom: '16px' }}>
              <label style={{
                display: 'block',
                fontSize: '13px',
                fontWeight: '600',
                color: colors.cream,
                marginBottom: '6px',
              }}>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                style={{
                  width: '100%',
                  padding: '14px 16px',
                  borderRadius: '14px',
                  border: '2px solid rgba(245,240,230,0.15)',
                  fontSize: '14px',
                  fontWeight: '500',
                  outline: 'none',
                  boxSizing: 'border-box',
                  transition: 'border-color 0.2s',
                  backgroundColor: 'rgba(255,255,255,0.06)',
                  color: colors.cream,
                }}
                onFocus={(e) => e.target.style.borderColor = colors.teal}
                onBlur={(e) => e.target.style.borderColor = 'rgba(245,240,230,0.15)'}
              />
            </div>

            <div style={{ marginBottom: '24px' }}>
              <label style={{
                display: 'block',
                fontSize: '13px',
                fontWeight: '600',
                color: colors.cream,
                marginBottom: '6px',
              }}>Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
                  style={{
                    width: '100%',
                    padding: '14px 48px 14px 16px',
                    borderRadius: '14px',
                    border: '2px solid rgba(245,240,230,0.15)',
                    fontSize: '14px',
                    fontWeight: '500',
                    outline: 'none',
                    boxSizing: 'border-box',
                    transition: 'border-color 0.2s',
                    backgroundColor: 'rgba(255,255,255,0.06)',
                    color: colors.cream,
                  }}
                  onFocus={(e) => e.target.style.borderColor = colors.teal}
                  onBlur={(e) => e.target.style.borderColor = 'rgba(245,240,230,0.15)'}
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
                background: `linear-gradient(135deg, ${colors.navy} 0%, ${colors.navyLight} 50%, ${colors.navyMid} 100%)`,
                color: 'white',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: '14px',
                padding: '14px 24px',
                fontWeight: '700',
                fontSize: '15px',
                cursor: loading ? 'not-allowed' : 'pointer',
                width: '100%',
                boxShadow: '0 4px 15px rgba(13,40,71,0.3), 0 2px 4px rgba(0,0,0,0.1)',
                transition: 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)',
                opacity: loading ? 0.7 : 1,
                letterSpacing: '0.3px',
              }}
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <div style={{
            textAlign: 'center',
            marginTop: '20px',
            fontSize: '14px',
            color: 'rgba(245,240,230,0.5)',
          }}>
            Don't have an account?{' '}
            <button
              onClick={onSwitchToSignup}
              style={{
                background: 'none',
                border: 'none',
                color: colors.teal,
                fontWeight: '700',
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
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        ::placeholder {
          color: rgba(245,240,230,0.3) !important;
        }
      `}</style>
    </div>
  );
};

export default LoginScreen;
