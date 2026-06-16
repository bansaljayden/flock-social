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

// Landing page only at /landing — everything else renders the app
if (window.location.pathname === '/landing') {
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
