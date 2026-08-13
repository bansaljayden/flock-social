import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import reportWebVitals from './reportWebVitals';
import ErrorBoundary from './components/ErrorBoundary';

// Guest invite URLs carry a bearer token in the path (/i/<token>): anyone
// holding one can RSVP and vote as that guest. Keep them out of every
// analytics and error payload that leaves the device.
const scrubGuestToken = (v) =>
  (typeof v === 'string' ? v.replace(/\/i\/[A-Za-z0-9_-]+/g, '/i/:token') : v);

// Sentry (B3) — no-op until REACT_APP_SENTRY_DSN is set (Vercel env). Never commit the DSN.
//
// Both SDKs below are behind an env-var check but used to be STATIC imports,
// so every build shipped both of them in the entry chunk whether or not they
// could ever run. They are dynamic imports now: with no DSN and no PostHog
// key, neither package is fetched at all. The init options are unchanged,
// scrubbing included. The one accepted cost is that Sentry attaches a moment
// after boot, so a crash in the first few hundred ms and the pageload
// transaction can be missed; ErrorBoundary re-reports render crashes through
// the same lazily-loaded SDK, which covers the case that matters.
if (process.env.REACT_APP_SENTRY_DSN) {
  import('@sentry/react').then((Sentry) => {
    Sentry.init({
      dsn: process.env.REACT_APP_SENTRY_DSN,
      environment: process.env.NODE_ENV,
      integrations: [Sentry.browserTracingIntegration()],
      tracesSampleRate: 0.1,
      // Round 10: PostHog scrubbed invite tokens but Sentry did not, so an error
      // or transaction raised on a guest page exported a replayable token in its
      // URL. Same scrub on every field that can carry one.
      beforeSend(event) {
        if (!event) return event;
        if (event.request?.url) event.request.url = scrubGuestToken(event.request.url);
        if (event.request?.headers?.Referer) event.request.headers.Referer = scrubGuestToken(event.request.headers.Referer);
        if (Array.isArray(event.breadcrumbs)) {
          for (const b of event.breadcrumbs) {
            if (b?.data?.url) b.data.url = scrubGuestToken(b.data.url);
            if (typeof b?.message === 'string') b.message = scrubGuestToken(b.message);
          }
        }
        return event;
      },
      beforeSendTransaction(event) {
        if (!event) return event;
        if (event.request?.url) event.request.url = scrubGuestToken(event.request.url);
        if (typeof event.transaction === 'string') event.transaction = scrubGuestToken(event.transaction);
        return event;
      },
    });
  }).catch(() => { /* monitoring is never load-bearing */ });
}

// PostHog — no-op until REACT_APP_POSTHOG_KEY is set (Vercel env + local .env).
// The phc_ key is public by design but stays in env vars per repo policy.
// defaults '2025-05-24' = SPA pageviews on history changes + sane privacy defaults.
if (process.env.REACT_APP_POSTHOG_KEY) {
  import('posthog-js').then(({ default: posthog }) => {
    posthog.init(process.env.REACT_APP_POSTHOG_KEY, {
      api_host: process.env.REACT_APP_POSTHOG_HOST || 'https://us.i.posthog.com',
      defaults: '2025-05-24',
      // Privacy boundary (round 3): autocapture could vacuum up interacted DOM
      // text (messages, budget amounts). We track pageviews + the explicit
      // events in api.js — nothing else.
      autocapture: false,
      // Guest invite URLs carry bearer tokens (/i/<token>); scrub them from
      // every event before it leaves the device.
      before_send: (event) => {
        if (!event) return event;
        const scrub = scrubGuestToken;
        if (event.properties) {
          for (const k of ['$current_url', '$pathname', '$referrer', '$initial_current_url', '$initial_referrer']) {
            if (event.properties[k]) event.properties[k] = scrub(event.properties[k]);
          }
        }
        return event;
      },
    });
  }).catch(() => { /* analytics is never load-bearing */ });
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
  // The boundary sits OUTSIDE Suspense on purpose, so it also catches a failed
  // chunk fetch — the App bundle 404ing against a stale cached index.html after
  // a deploy is a real production failure mode, and unhandled it is the same
  // white screen as a render crash. ThemeProvider writes data-theme onto
  // <html> and never removes it, so the fallback still paints in the user's
  // theme even though it renders after ThemeProvider has gone.
  root.render(
    <React.StrictMode>
      <ErrorBoundary label="app-root">
        <React.Suspense fallback={null}>
          <ThemeProvider>
            <App />
          </ThemeProvider>
        </React.Suspense>
      </ErrorBoundary>
    </React.StrictMode>
  );
}

reportWebVitals();
