import React, { useState } from 'react';
import { login, signup, googleLogin } from '../../services/api';
import { GoogleLogin } from '@react-oauth/google';

const colors = {
  navyDark: '#0f172a',
  cream: '#f0ead8',
  creamDark: '#e0dac9',
  navy: '#1a2744',
};

// Video city background — different clip than user login
const SceneBackground = () => (
  <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
    <video autoPlay muted loop playsInline style={{
      position: 'absolute', width: '100%', height: '100%', objectFit: 'cover',
      filter: 'brightness(0.65) saturate(1)',
    }}>
      <source src="/bg-city-venue.mp4" type="video/mp4" />
    </video>
    <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(6,10,20,0.45) 0%, rgba(10,21,40,0.15) 40%, rgba(6,10,20,0.4) 100%)' }} />
  </div>
);

const EyeIcon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="rgba(148,163,184,0.6)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
  </svg>
);

const EyeOffIcon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="rgba(148,163,184,0.6)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);

const VenueLoginScreen = ({ onLoginSuccess, onSwitchToUserLogin }) => {
  const [isSignup, setIsSignup] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = isSignup ? await signup(email, password, name) : await login(email, password);
      onLoginSuccess(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', fontFamily: "'Satoshi', -apple-system, BlinkMacSystemFont, sans-serif", position: 'relative', overflow: 'hidden' }}>
      <SceneBackground />
      <div style={{ width: '100%', maxWidth: '400px', position: 'relative', zIndex: 1, animation: 'fadeInUp 0.8s ease-out' }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <img src="/flock-logo.png" alt="Flock" style={{ width: '160px', height: '160px', borderRadius: '50%', objectFit: 'cover', display: 'block', margin: '0 auto 12px', boxShadow: '0 8px 40px rgba(0,0,0,0.4)', animation: 'floatIn 0.8s ease-out' }} />
          <h1 style={{ fontSize: '28px', fontWeight: '900', color: colors.cream, margin: '0 0 2px', letterSpacing: '-0.5px' }}>Venue Portal</h1>
          <p style={{ fontSize: '14px', color: 'rgba(148,163,184,0.5)', fontWeight: '400', margin: 0 }}>{isSignup ? 'Register your venue' : 'Sign in to manage your venue'}</p>
        </div>

        <div style={{ position: 'relative', borderRadius: '28px', padding: '32px 28px' }}>
          <div style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', borderRadius: '28px', zIndex: 0,
            boxShadow: '0 0 6px rgba(0,0,0,0.03), 0 2px 6px rgba(0,0,0,0.08), inset 3px 3px 0.5px -3.5px rgba(255,255,255,0.09), inset -3px -3px 0.5px -3.5px rgba(255,255,255,0.85), inset 1px 1px 1px -0.5px rgba(255,255,255,0.6), inset -1px -1px 1px -0.5px rgba(255,255,255,0.6), inset 0 0 6px 6px rgba(255,255,255,0.12), inset 0 0 2px 2px rgba(255,255,255,0.06), 0 0 12px rgba(0,0,0,0.15)',
          }} />
          <div style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', borderRadius: '28px', zIndex: -1, overflow: 'hidden',
            backdropFilter: 'url(#liquid-glass-v)', WebkitBackdropFilter: 'url(#liquid-glass-v)',
          }} />
          <div style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', borderRadius: '28px', zIndex: 0,
            background: 'linear-gradient(145deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.03) 50%, rgba(255,255,255,0.05) 100%)',
            border: '1px solid rgba(255,255,255,0.15)', borderTop: '1px solid rgba(255,255,255,0.25)', borderLeft: '1px solid rgba(255,255,255,0.18)',
            pointerEvents: 'none',
          }} />
          <svg style={{ position: 'absolute', width: 0, height: 0 }}>
            <defs>
              <filter id="liquid-glass-v" x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
                <feTurbulence type="fractalNoise" baseFrequency="0.04 0.04" numOctaves="1" seed="2" result="turbulence" />
                <feGaussianBlur in="turbulence" stdDeviation="3" result="blurredNoise" />
                <feDisplacementMap in="SourceGraphic" in2="blurredNoise" scale="50" xChannelSelector="R" yChannelSelector="B" result="displaced" />
                <feGaussianBlur in="displaced" stdDeviation="5" result="finalBlur" />
                <feComposite in="finalBlur" in2="finalBlur" operator="over" />
              </filter>
            </defs>
          </svg>
          <div style={{ position: 'relative', zIndex: 1 }}>
          <form onSubmit={handleSubmit}>
            {error && <div style={{ backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '12px', padding: '10px 14px', marginBottom: '20px', color: '#fca5a5', fontSize: '13px', fontWeight: '500' }}>{error}</div>}

            {isSignup && (
              <div style={{ marginBottom: '20px' }}>
                <label className="login-label">Name</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" required className="login-input" />
              </div>
            )}

            <div style={{ marginBottom: '20px' }}>
              <label className="login-label">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required className="login-input" />
            </div>

            <div style={{ marginBottom: '28px' }}>
              <label className="login-label">Password</label>
              <div style={{ position: 'relative' }}>
                <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" required className="login-input" style={{ paddingRight: '44px' }} />
                <button type="button" onClick={() => setShowPassword(!showPassword)} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center', opacity: 0.7 }}>
                  {showPassword ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
                </button>
              </div>
            </div>

            <button type="submit" disabled={loading} className="login-btn" style={{ opacity: loading ? 0.7 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}>
              {loading ? 'Signing in...' : isSignup ? 'Create Account' : 'Sign In'}
            </button>
          </form>

          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', margin: '22px 0' }}>
            <div style={{ flex: 1, height: '1px', background: 'linear-gradient(90deg, transparent, rgba(148,163,184,0.12), transparent)' }} />
            <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.35)', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '1px' }}>or</span>
            <div style={{ flex: 1, height: '1px', background: 'linear-gradient(90deg, transparent, rgba(148,163,184,0.12), transparent)' }} />
          </div>

          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <GoogleLogin
              onSuccess={async (response) => { setError(''); setLoading(true); try { const data = await googleLogin(response.credential); onLoginSuccess(data.user); } catch (err) { setError(err.message || 'Google sign-in failed'); } finally { setLoading(false); } }}
              onError={() => setError('Google sign-in failed')}
              theme="filled_black" shape="pill" size="large" width="344" text="continue_with"
            />
          </div>

          <p style={{ textAlign: 'center', marginTop: '22px', paddingTop: '18px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: '14px', color: 'rgba(148,163,184,0.5)', margin: '22px 0 0' }}>
            {isSignup ? 'Already have an account? ' : "Don't have an account? "}
            <button onClick={() => { setIsSignup(!isSignup); setError(''); }} style={{ background: 'none', border: 'none', color: colors.cream, fontWeight: '700', cursor: 'pointer', fontSize: '14px', padding: 0 }}>{isSignup ? 'Sign In' : 'Sign Up'}</button>
          </p>
          </div>{/* close content wrapper */}
        </div>{/* close glass card */}

        <button onClick={onSwitchToUserLogin} className="venue-link-btn">
          Not a venue? <span style={{ fontWeight: '700', color: colors.cream }}>Back to user login</span>
        </button>
      </div>

      <style>{`
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(30px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes floatIn { from { opacity: 0; transform: translateY(-16px) scale(0.9); } to { opacity: 1; transform: translateY(0) scale(1); } }
        .login-label { display: block; font-size: 12px; font-weight: 600; color: rgba(148,163,184,0.7); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
        .login-input { width: 100%; padding: 12px 14px; border-radius: 12px; border: 1.5px solid rgba(148,163,184,0.1); font-size: 14px; font-weight: 400; outline: none; box-sizing: border-box; transition: border-color 0.2s, box-shadow 0.2s, background-color 0.2s; background-color: rgba(15,23,42,0.4); color: white; font-family: inherit; }
        .login-input::placeholder { color: rgba(148,163,184,0.3); }
        .login-input:focus { border-color: rgba(240,234,216,0.3); box-shadow: 0 0 0 3px rgba(240,234,216,0.05); background-color: rgba(15,23,42,0.6); }
        .login-btn { width: 100%; padding: 14px; border-radius: 14px; border: none; background: linear-gradient(135deg, #f0ead8 0%, #d4c9a8 100%); color: #1a2744; font-size: 15px; font-weight: 800; letter-spacing: 0.3px; font-family: inherit; box-shadow: 0 4px 20px rgba(240,234,216,0.15); transition: transform 0.15s, box-shadow 0.15s; }
        .login-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(240,234,216,0.2); }
        .login-btn:active:not(:disabled) { transform: translateY(0); }
        .venue-link-btn { display: block; width: 100%; margin-top: 14px; padding: 11px 20px; border-radius: 14px; border: 1px solid rgba(148,163,184,0.1); background: rgba(15,23,42,0.3); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); color: rgba(148,163,184,0.5); font-size: 13px; font-family: inherit; cursor: pointer; transition: border-color 0.2s, color 0.2s, background 0.2s; text-align: center; }
        .venue-link-btn:hover { border-color: rgba(148,163,184,0.2); color: rgba(148,163,184,0.8); background: rgba(15,23,42,0.5); }
      `}</style>
    </div>
  );
};

export default VenueLoginScreen;
