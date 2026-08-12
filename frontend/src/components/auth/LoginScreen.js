import React, { useState } from 'react';
import { login, googleLoginWithToken } from '../../services/api';
import { useGoogleLogin } from '@react-oauth/google';

// Google's official "G" mark, required branding for a custom button.
const GoogleG = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);
import AppleSignInButton from './AppleSignInButton';

const colors = {
  navyDark: '#0f172a',
  cream: '#f0ead8',
  creamDark: '#e0dac9',
  navy: '#1a2744',
};

// Video city background.
// WKWebView (Capacitor) blocks autoplay unless the muted ATTRIBUTE is on the
// element — React's `muted` prop doesn't always reach the DOM — and a blocked
// video renders iOS's grey play glyph over the form. Set attributes + play()
// imperatively; if playback still refuses, hide the video (navy bg remains).
const CityBackground = () => {
  const vidRef = React.useRef(null);
  React.useEffect(() => {
    const v = vidRef.current;
    if (!v) return;
    v.muted = true;
    v.setAttribute('muted', '');
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    const tryPlay = () => v.play().catch(() => { v.style.display = 'none'; });
    if (v.readyState >= 2) tryPlay();
    else v.addEventListener('loadeddata', tryPlay, { once: true });
  }, []);
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none', backgroundColor: '#0a1528' }}>
      <video ref={vidRef} autoPlay muted loop playsInline preload="auto" style={{
        position: 'absolute', width: '100%', height: '100%', objectFit: 'cover',
        filter: 'brightness(0.65) saturate(1)',
      }}>
        <source src="/bg-city.mp4" type="video/mp4" />
      </video>
      {/* Navy tint overlay to match Flock palette */}
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(6,10,20,0.45) 0%, rgba(10,21,40,0.15) 40%, rgba(6,10,20,0.4) 100%)' }} />
    </div>
  );
};

const EyeIcon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="rgba(148,163,184,0.6)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
  </svg>
);

const EyeOffIcon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="rgba(148,163,184,0.6)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);

const LoginScreen = ({ onLoginSuccess, onSwitchToSignup, onSwitchToVenueLogin }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Custom-styled Google button (the rendered GIS button ignores dark theming
  // when it shows the personalized "Continue as ..." variant). Access token is
  // verified server-side against our client id.
  const startGoogle = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      setLoading(true);
      try {
        const data = await googleLoginWithToken(tokenResponse.access_token);
        onLoginSuccess(data.user);
      } catch (err) {
        setError(err.message || 'Google sign-in failed');
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
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '20px',
      fontFamily: "'Hanken Grotesk', -apple-system, BlinkMacSystemFont, sans-serif",
      position: 'relative',
      overflow: 'hidden',
    }}>
      <CityBackground />

      <div style={{ width: '100%', maxWidth: '400px', position: 'relative', zIndex: 1, animation: 'fadeInUp 0.8s ease-out' }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <img src="/flock-logo.png" alt="Flock" style={{ width: '160px', height: '160px', borderRadius: '50%', objectFit: 'cover', display: 'block', margin: '0 auto 12px', boxShadow: '0 8px 40px rgba(0,0,0,0.4)', animation: 'floatIn 0.8s ease-out' }} />
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '30px', fontWeight: '600', color: colors.cream, margin: '0 0 2px', letterSpacing: '-0.005em' }}>Welcome back</h1>
          <p style={{ fontSize: '14px', color: 'rgba(148,163,184,0.5)', fontWeight: '400', margin: 0 }}>Sign in to continue</p>
        </div>

        {/* Liquid Glass card */}
        <div style={{ position: 'relative', borderRadius: '28px', padding: '32px 28px' }}>
          <div style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', borderRadius: '28px', zIndex: 0,
            boxShadow: '0 0 6px rgba(0,0,0,0.03), 0 2px 6px rgba(0,0,0,0.08), inset 3px 3px 0.5px -3.5px rgba(255,255,255,0.09), inset -3px -3px 0.5px -3.5px rgba(255,255,255,0.85), inset 1px 1px 1px -0.5px rgba(255,255,255,0.6), inset -1px -1px 1px -0.5px rgba(255,255,255,0.6), inset 0 0 6px 6px rgba(255,255,255,0.12), inset 0 0 2px 2px rgba(255,255,255,0.06), 0 0 12px rgba(0,0,0,0.15)',
          }} />
          <div style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', borderRadius: '28px', zIndex: -1, overflow: 'hidden',
            backdropFilter: 'url(#liquid-glass)', WebkitBackdropFilter: 'url(#liquid-glass)',
          }} />
          <div style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', borderRadius: '28px', zIndex: 0,
            background: 'linear-gradient(145deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.03) 50%, rgba(255,255,255,0.05) 100%)',
            border: '1px solid rgba(255,255,255,0.15)', borderTop: '1px solid rgba(255,255,255,0.25)', borderLeft: '1px solid rgba(255,255,255,0.18)',
            pointerEvents: 'none',
          }} />
          <svg style={{ position: 'absolute', width: 0, height: 0 }}>
            <defs>
              <filter id="liquid-glass" x="0%" y="0%" width="100%" height="100%" colorInterpolationFilters="sRGB">
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
            {error && (
              <div style={{ backgroundColor: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: '12px', padding: '10px 14px', marginBottom: '20px', color: '#fca5a5', fontSize: '13px', fontWeight: '500' }}>{error}</div>
            )}

            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'rgba(148,163,184,0.7)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required className="login-input" />
            </div>

            <div style={{ marginBottom: '28px' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: '600', color: 'rgba(148,163,184,0.7)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Password</label>
              <div style={{ position: 'relative' }}>
                <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" required className="login-input" style={{ paddingRight: '44px' }} />
                <button type="button" onClick={() => setShowPassword(!showPassword)} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.7 }}>
                  {showPassword ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
                </button>
              </div>
            </div>

            <button type="submit" disabled={loading} className="login-btn" style={{ opacity: loading ? 0.7 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}>
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', margin: '22px 0' }}>
            <div style={{ flex: 1, height: '1px', background: 'linear-gradient(90deg, transparent, rgba(148,163,184,0.12), transparent)' }} />
            <span style={{ fontSize: '11px', color: 'rgba(148,163,184,0.35)', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '1px' }}>or</span>
            <div style={{ flex: 1, height: '1px', background: 'linear-gradient(90deg, transparent, rgba(148,163,184,0.12), transparent)' }} />
          </div>

          <button
            type="button"
            onClick={() => { setError(''); startGoogle(); }}
            disabled={loading}
            style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '13px', borderRadius: '12px', border: '1px solid rgba(148,163,184,0.25)', backgroundColor: 'rgba(255,255,255,0.04)', color: colors.cream, fontSize: '15px', fontWeight: '600', cursor: loading ? 'wait' : 'pointer' }}
          >
            <GoogleG /> Continue with Google
          </button>

          {/* Apple guideline 4.8: Google login is offered above, so the native
              iOS app must offer Sign in with Apple too. Renders null on web. */}
          <AppleSignInButton onSuccess={onLoginSuccess} onError={(m) => setError(m)} />

          <p style={{ textAlign: 'center', marginTop: '22px', paddingTop: '18px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: '14px', color: 'rgba(148,163,184,0.5)', margin: '22px 0 0' }}>
            Don't have an account?{' '}
            <button onClick={onSwitchToSignup} style={{ background: 'none', border: 'none', color: colors.cream, fontWeight: '700', cursor: 'pointer', fontSize: '14px', padding: 0 }}>Sign Up</button>
          </p>
          </div>
        </div>

        <button onClick={onSwitchToVenueLogin} className="venue-link-btn">
          Are you a venue? <span style={{ fontWeight: '700', color: colors.cream }}>Login here</span>
        </button>
      </div>

      <style>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes floatIn {
          from { opacity: 0; transform: translateY(-16px) scale(0.9); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .login-input {
          width: 100%;
          padding: 12px 14px;
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.12);
          font-size: 14px;
          font-weight: 400;
          outline: none;
          box-sizing: border-box;
          transition: border-color 0.2s, box-shadow 0.2s, background 0.2s;
          background: rgba(255,255,255,0.06);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          color: white;
          font-family: inherit;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.06);
        }
        .login-input::placeholder { color: rgba(255,255,255,0.25); }
        .login-input:focus {
          border-color: rgba(255,255,255,0.25);
          box-shadow: 0 0 0 3px rgba(255,255,255,0.05), inset 0 1px 0 rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.1);
        }
        .login-btn {
          width: 100%;
          padding: 14px;
          border-radius: 14px;
          border: none;
          background: linear-gradient(135deg, #f0ead8 0%, #d4c9a8 100%);
          color: #1a2744;
          font-size: 15px;
          font-weight: 800;
          letter-spacing: 0.3px;
          font-family: inherit;
          box-shadow: 0 4px 20px rgba(240,234,216,0.15);
          transition: transform 0.15s, box-shadow 0.15s;
        }
        .login-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(240,234,216,0.2); }
        .login-btn:active:not(:disabled) { transform: translateY(0); }
        .venue-link-btn {
          display: block; width: 100%; margin-top: 14px; padding: 11px 20px; border-radius: 14px;
          border: 1px solid rgba(148,163,184,0.1); background: rgba(15,23,42,0.3);
          backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
          color: rgba(148,163,184,0.5); font-size: 13px; font-family: inherit;
          cursor: pointer; transition: border-color 0.2s, color 0.2s, background 0.2s; text-align: center;
        }
        .venue-link-btn:hover { border-color: rgba(148,163,184,0.2); color: rgba(148,163,184,0.8); background: rgba(15,23,42,0.5); }
      `}</style>
    </div>
  );
};

export default LoginScreen;
