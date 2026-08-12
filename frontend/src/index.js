import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import './index.css';
import reportWebVitals from './reportWebVitals';

// Sentry (B3) — no-op until REACT_APP_SENTRY_DSN is set (Vercel env). Never commit the DSN.
if (process.env.REACT_APP_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.REACT_APP_SENTRY_DSN,
    environment: process.env.NODE_ENV,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.1,
  });
}

const root = ReactDOM.createRoot(document.getElementById('root'));

// The iOS/Android shell loads the bundle at "/" too. It must ALWAYS boot the
// app — if the marketing site rendered there, the native app would open on a
// landing page. Web visitors to "/" get the marketing site; the app moves to
// "/app". Everything else (invites, NFC check-ins, admin) still renders the app.
const isNativeShell = typeof window !== 'undefined'
  && (window.Capacitor?.isNativePlatform?.() === true || window.location.protocol === 'capacitor:');
const path = window.location.pathname;
const isMarketingRoot = !isNativeShell && (path === '/' || path === '/landing' || path === '/index.html');

if (isMarketingRoot) {
  const LandingPage = React.lazy(() => import('./website/LandingPage'));
  root.render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
        <LandingPage />
      </React.Suspense>
    </React.StrictMode>
  );
} else if (window.location.pathname === '/privacy') {
  const PrivacyPolicy = React.lazy(() => import('./website/PrivacyPolicy'));
  root.render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
        <PrivacyPolicy />
      </React.Suspense>
    </React.StrictMode>
  );
} else if (window.location.pathname === '/support') {
  const SupportPage = React.lazy(() => import('./website/SupportPage'));
  root.render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
        <SupportPage />
      </React.Suspense>
    </React.StrictMode>
  );
} else if (window.location.pathname === '/terms') {
  const TermsOfService = React.lazy(() => import('./website/TermsOfService'));
  root.render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
        <TermsOfService />
      </React.Suspense>
    </React.StrictMode>
  );
} else if (window.location.pathname === '/guidelines') {
  const CommunityGuidelines = React.lazy(() => import('./website/CommunityGuidelines'));
  root.render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
        <CommunityGuidelines />
      </React.Suspense>
    </React.StrictMode>
  );
} else if (window.location.pathname.startsWith('/i/')) {
  const GuestInvite = React.lazy(() => import('./website/GuestInvite'));
  root.render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
        <GuestInvite />
      </React.Suspense>
    </React.StrictMode>
  );
} else if (window.location.pathname === '/about') {
  const AboutPage = React.lazy(() => import('./website/AboutPage'));
  root.render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
        <AboutPage />
      </React.Suspense>
    </React.StrictMode>
  );
} else if (window.location.pathname === '/delete-account') {
  const DeleteAccount = React.lazy(() => import('./website/DeleteAccount'));
  root.render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
        <DeleteAccount />
      </React.Suspense>
    </React.StrictMode>
  );
} else if (window.location.pathname === '/admin/moderation') {
  const ModerationDashboard = React.lazy(() => import('./website/ModerationDashboard'));
  root.render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
        <ModerationDashboard />
      </React.Suspense>
    </React.StrictMode>
  );
} else {
  const App = React.lazy(() => import('./App'));
  const { ThemeProvider } = require('./context/ThemeContext');
  root.render(
    <React.StrictMode>
      <React.Suspense fallback={null}>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </React.Suspense>
    </React.StrictMode>
  );
}

reportWebVitals();
