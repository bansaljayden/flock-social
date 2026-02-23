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
        {/* Logo / Header */}
        <div style={{ textAlign: 'center', marginBottom: '36px' }}>
          <div style={{
            fontSize: '48px',
            marginBottom: '8px',
          }}>🐦</div>
          <h1 style={{
            color: 'white',
            fontSize: '32px',
            fontWeight: '800',
            margin: '0 0 8px 0',
            letterSpacing: '-0.5px',
          }}>Flock</h1>
          <p style={{
            color: 'rgba(255,255,255,0.6)',
            fontSize: '15px',
            fontWeight: '500',
            margin: 0,
          }}>Welcome back</p>
        </div>

        {/* Card */}
        <div style={{
          backgroundColor: 'rgba(255,255,255,0.95)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          borderRadius: '24px',
          padding: '32px 28px',
          boxShadow: '0 25px 80px -12px rgba(0,0,0,0.4)',
        }}>
          <form onSubmit={handleSubmit}>
            {error && (
              <div style={{
                backgroundColor: `${colors.red}15`,
                border: `1px solid ${colors.red}40`,
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
                  backgroundColor: 'rgba(255,255,255,0.95)',
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
                  backgroundColor: 'rgba(255,255,255,0.95)',
                }}
                onFocus={(e) => e.target.style.borderColor = colors.teal}
                onBlur={(e) => e.target.style.borderColor = colors.creamDark}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{
                background: `linear-gradient(135deg, ${colors.navy} 0%, ${colors.navyLight} 50%, ${colors.navyMid} 100%)`,
                color: 'white',
                border: 'none',
                borderRadius: '14px',
                padding: '14px 24px',
                fontWeight: '700',
                fontSize: '15px',
                cursor: loading ? 'not-allowed' : 'pointer',
                width: '100%',
                boxShadow: '0 4px 15px rgba(13,40,71,0.3)',
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
            color: '#666',
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
