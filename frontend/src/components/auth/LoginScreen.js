import React, { useState } from 'react';
import { login } from '../../services/api';

const colors = {
  cream: '#f5f1e8',
  creamDark: '#e8dfd0',
  teal: '#14b8a6',
  tealDark: '#0d9488',
  navy: '#1e293b',
  red: '#EF4444',
};

const LoginScreen = ({ onLoginSuccess, onSwitchToSignup }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
      background: 'linear-gradient(135deg, #f5f1e8 0%, #e8dfd0 100%)',
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
        {/* Flock Logo */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '10px',
            marginBottom: '12px',
          }}>
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
              <circle cx="20" cy="20" r="20" fill={colors.teal} opacity="0.12" />
              <path d="M12 28c2-4 6-7 10-8 -2 1-4 3-5 5 3-3 7-5 11-5-3 1-6 3-8 6 2-2 5-3 8-3-4 2-7 5-8 9" stroke={colors.teal} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            <span style={{
              fontSize: '32px',
              fontWeight: '800',
              color: colors.teal,
              letterSpacing: '-1px',
            }}>Flock</span>
          </div>
          <p style={{
            color: '#94a3b8',
            fontSize: '15px',
            fontWeight: '500',
            margin: 0,
          }}>Welcome back</p>
        </div>

        {/* Card */}
        <div style={{
          backgroundColor: 'white',
          borderRadius: '24px',
          padding: '32px 28px',
          boxShadow: '0 4px 24px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)',
        }}>
          <form onSubmit={handleSubmit}>
            {error && (
              <div style={{
                backgroundColor: `${colors.red}10`,
                border: `1px solid ${colors.red}30`,
                borderRadius: '12px',
                padding: '12px 16px',
                marginBottom: '20px',
                color: colors.red,
                fontSize: '13px',
                fontWeight: '600',
              }}>{error}</div>
            )}

            <div style={{ marginBottom: '16px' }}>
              <label style={{
                display: 'block',
                fontSize: '13px',
                fontWeight: '600',
                color: colors.navy,
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
                  border: `2px solid ${colors.creamDark}`,
                  fontSize: '14px',
                  fontWeight: '500',
                  outline: 'none',
                  boxSizing: 'border-box',
                  transition: 'border-color 0.2s',
                  backgroundColor: '#faf8f5',
                }}
                onFocus={(e) => e.target.style.borderColor = colors.teal}
                onBlur={(e) => e.target.style.borderColor = colors.creamDark}
              />
            </div>

            <div style={{ marginBottom: '24px' }}>
              <label style={{
                display: 'block',
                fontSize: '13px',
                fontWeight: '600',
                color: colors.navy,
                marginBottom: '6px',
              }}>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
                style={{
                  width: '100%',
                  padding: '14px 16px',
                  borderRadius: '14px',
                  border: `2px solid ${colors.creamDark}`,
                  fontSize: '14px',
                  fontWeight: '500',
                  outline: 'none',
                  boxSizing: 'border-box',
                  transition: 'border-color 0.2s',
                  backgroundColor: '#faf8f5',
                }}
                onFocus={(e) => e.target.style.borderColor = colors.teal}
                onBlur={(e) => e.target.style.borderColor = colors.creamDark}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{
                background: colors.teal,
                color: 'white',
                border: 'none',
                borderRadius: '14px',
                padding: '14px 24px',
                fontWeight: '700',
                fontSize: '15px',
                cursor: loading ? 'not-allowed' : 'pointer',
                width: '100%',
                boxShadow: '0 4px 14px rgba(20,184,166,0.3)',
                transition: 'all 0.3s ease',
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
            color: '#94a3b8',
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
      `}</style>
    </div>
  );
};

export default LoginScreen;
