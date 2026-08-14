import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import reportWebVitals from './reportWebVitals';
import ErrorBoundary from './components/ErrorBoundary';

// Bearer tokens ride in URLs in two places. Guest invites carry one in the
// path (/i/<token>): anyone holding it can RSVP and vote as that guest. The
// password reset email lands with one in the fragment (#token=...) or, after
// a mail scanner rewrites the link, in the query (?token=...) --
// components/auth/PasswordReset.js accepts both, and it strips the token from
// the address bar only AFTER mount, which is after the $pageview has already
// been built from window.location.href. Anyone holding a reset token can take
// the account. Both patterns are scrubbed from every analytics and error
// payload that leaves the device.
//
// Exported for src/__tests__/analyticsPrivacy.test.js only.
export const scrubUrlTokens = (v) =>
  (typeof v === 'string'
    ? v
      .replace(/\/i\/[A-Za-z0-9_-]+/g, '/i/:token')
      .replace(/([?#&]token=)[^&#\s"']*/gi, '$1redacted')
    : v);

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
        if (event.request?.url) event.request.url = scrubUrlTokens(event.request.url);
        if (event.request?.headers?.Referer) event.request.headers.Referer = scrubUrlTokens(event.request.headers.Referer);
        if (Array.isArray(event.breadcrumbs)) {
          for (const b of event.breadcrumbs) {
            if (b?.data?.url) b.data.url = scrubUrlTokens(b.data.url);
            if (typeof b?.message === 'string') b.message = scrubUrlTokens(b.message);
          }
        }
        return event;
      },
      beforeSendTransaction(event) {
        if (!event) return event;
        if (event.request?.url) event.request.url = scrubUrlTokens(event.request.url);
        if (typeof event.transaction === 'string') event.transaction = scrubUrlTokens(event.transaction);
        return event;
      },
    });
  }).catch(() => { /* monitoring is never load-bearing */ });
}

// Walks an event's property bags and scrubs every string in them, so a token
// can never ride out inside a property the fixed-key list of an earlier
// version did not know about ($session_entry_current_url and friends arrive
// with SDK upgrades, not with our code). Depth-capped because the input is
// attacker-influencable via the URL and this must never be the thing that
// recurses forever. Mutates in place: before_send hands us the event to edit.
const scrubEventStrings = (val, depth = 0) => {
  if (typeof val === 'string') return scrubUrlTokens(val);
  if (depth >= 4 || !val || typeof val !== 'object') return val;
  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) val[i] = scrubEventStrings(val[i], depth + 1);
    return val;
  }
  for (const k of Object.keys(val)) val[k] = scrubEventStrings(val[k], depth + 1);
  return val;
};

// PostHog — no-op until REACT_APP_POSTHOG_KEY is set (Vercel env + local .env).
// The phc_ key is public by design but stays in env vars per repo policy.
//
// PRIVACY POSTURE (2026-08-14). The youngest permitted user is 13
// (backend/utils/age.js), so this config is minimize-by-default: pageviews
// plus the hand-written events in services/api.js, and nothing that could
// carry message text, coordinates, a recording, or a URL-borne token. Every
// capture surface whose default is "let the PostHog project settings decide"
// is pinned OFF here, so a dashboard toggle can never widen collection on
// minors without a code change (posthog.com/docs/libraries/js/config:
// capture_heatmaps / capture_dead_clicks / capture_exceptions all default to
// undefined = remote-controlled; disable_session_recording defaults to false
// = remote-controlled).
//
// What this deliberately does NOT fix: the request that delivers an event
// carries the device IP, and no client option can prevent that (the `ip`
// config is a documented no-op; posthog.com/tutorials/web-redact-properties
// says $ip cannot be redacted client-side). The fix is the project-level
// "Discard client IP data" toggle in the PostHog dashboard, which is a
// human-hands step. $geoip_disable below asks ingestion not to derive
// city/region from that IP in the meantime (the property server SDKs set via
// their disableGeoip option).
//
// The privacy policy (website/PrivacyPolicy.js) currently discloses a PostHog
// cookie; persistence 'localStorage' below means that stopped being true in
// the good direction. Do not switch persistence back to a cookie mode without
// re-reading that page.
//
// Exported for src/__tests__/analyticsPrivacy.test.js, which locks every
// value here and fails on the commit that loosens one.
export const POSTHOG_PRIVACY_CONFIG = {
  api_host: process.env.REACT_APP_POSTHOG_HOST || 'https://us.i.posthog.com',
  // '2025-05-24' = SPA pageviews on history changes. Later dated defaults only
  // tune replay/rageclick/storage timing, none of which run here.
  defaults: '2025-05-24',
  // Privacy boundary (round 3): autocapture could vacuum up interacted DOM
  // text (messages, budget amounts). We track pageviews + the explicit
  // events in api.js — nothing else.
  autocapture: false,
  // Session replay of a teenager's screen is off in code, not in a dashboard.
  // Before this line the SDK default (false = "follow project settings") left
  // recording one PostHog toggle away with no commit to review.
  disable_session_recording: true,
  capture_heatmaps: false,
  capture_dead_clicks: false,
  // Exception autocapture can embed thrown-error text, which can quote user
  // content. Sentry owns errors, with the same scrub applied above.
  capture_exceptions: false,
  disable_surveys: true,
  // The SDK default since v1.167, made explicit because we rely on it:
  // marketing-site visitors never get a person profile, only signed-in users
  // do (api.js identifies by numeric account id, never name or email).
  person_profiles: 'identified_only',
  // Device-local storage only: no analytics cookie rides on every request,
  // nothing is shared across subdomains, and clearing site data removes it.
  // The distinct_id still survives a reload, which identified analytics needs.
  persistence: 'localStorage',
  // A browser asking not to be tracked is honored, 13+ audience or not.
  respect_dnt: true,
  // Masks ad-click ids (gclid, fbclid, ...) in captured URLs, plus any
  // ?token= query value as a second net under scrubUrlTokens.
  mask_personal_data_properties: true,
  custom_personal_data_properties: ['token'],
  before_send: (event) => {
    if (!event) return event;
    if (event.properties) {
      scrubEventStrings(event.properties);
      // Ask ingestion to skip GeoIP enrichment: no city/region derived from
      // a minor's IP. Belt to the dashboard's "Discard client IP" suspenders.
      event.properties.$geoip_disable = true;
    }
    if (event.$set) scrubEventStrings(event.$set);
    if (event.$set_once) scrubEventStrings(event.$set_once);
    return event;
  },
};

if (process.env.REACT_APP_POSTHOG_KEY) {
  import('posthog-js').then(({ default: posthog }) => {
    posthog.init(process.env.REACT_APP_POSTHOG_KEY, POSTHOG_PRIVACY_CONFIG);
  }).catch(() => { /* analytics is never load-bearing */ });
}

// ---------------------------------------------------------------------------
// WHERE ARE WE
//
// There is no router. This file reads the URL once and mounts exactly one of
// three things: a marketing/legal page, the guest invite page, or the app.
// Everything below is that decision, and the decision is made ONCE at boot --
// nothing here re-runs on a history change (the app owns its own navigation).
// ---------------------------------------------------------------------------

// The iOS/Android shell loads the bundle at "/" too. It must ALWAYS boot the
// app: if the marketing site rendered there, the native app would open on a
// landing page. Web visitors to "/" get the marketing site; the app moves to
// "/app". Everything else (invites, NFC check-ins, admin) still renders the app.
//
// iOS serves the app from capacitor://localhost, but ANDROID serves it from
// https://localhost, so the protocol check alone never identified the Android
// shell: it rode entirely on window.Capacitor answering isNativePlatform().
// Every signal the bridge can give is accepted now, and the one ambiguous
// case (a bridge that is present but answers badly) resolves to "native",
// because booting the marketing page inside the native app is far worse than
// booting the app in a browser tab. window.Capacitor does not exist in the web
// build at this point: nothing in src/ imports @capacitor/core, and the
// plugins that do are dynamic imports inside the App chunk.
const detectNativeShell = () => {
  if (typeof window === 'undefined') return false;
  try {
    if (window.location.protocol === 'capacitor:') return true;
    const cap = window.Capacitor;
    if (!cap) return false;
    if (typeof cap.isNativePlatform === 'function') return cap.isNativePlatform() === true;
    if (typeof cap.getPlatform === 'function') return cap.getPlatform() !== 'web';
    return true;
  } catch {
    return typeof window.Capacitor !== 'undefined';
  }
};

const isNativeShell = detectNativeShell();

const rawPath = typeof window !== 'undefined' ? window.location.pathname : '/';
const rawSearch = typeof window !== 'undefined' ? window.location.search : '';

// MATCHING ONLY. Never hand this to a page: /i/<token> tokens and Google place
// ids in /checkin/<id> are case sensitive, and the pages read the raw pathname
// themselves. The old chain compared the raw path with ===, so "/Privacy" and
// "/privacy/" both missed every branch and silently booted the entire App
// bundle in place of the one-screen legal page the visitor asked for.
const path = (() => {
  const lowered = String(rawPath || '/').toLowerCase().replace(/\/{2,}/g, '/');
  const trimmed = lowered.length > 1 ? lowered.replace(/\/+$/, '') : lowered;
  return trimmed || '/';
})();

// The backend's web push links are "/?flock=123", "/?dm=45" and "/?tab=you"
// (backend/services/firebaseService.js deepLinkPath), and the app parses them
// in services/pushNavigation.js. On the web "/" is the marketing site, so
// every one of those taps used to land a logged-in user on the landing page
// and the intent was dropped on the floor. A query string that only the app
// can answer means the app boots, root or not.
const APP_INTENT_PARAMS = ['flock', 'dm', 'tab', 'admin', 'venue', 'email_verified'];
const appIntentQuery = new URLSearchParams(rawSearch);
const hasAppIntent = APP_INTENT_PARAMS.some((k) => appIntentQuery.has(k));

// Paths the app owns. Anything that matches neither these nor a page below is
// a genuinely wrong URL and gets a 404 instead of a silent app boot.
const APP_PATHS = [
  /^\/app(\/|$)/,                 // canonical web entry (backend/server.js)
  /^\/signup$/,                   // App.js picks the signup screen off this
  /^\/checkin\/.+/,               // NFC tag tap (App.js matches the id loosely too)
  /^\/(?:f|flock)\/\d+$/,         // deep links, services/pushNavigation.js
  /^\/dm\/\d+$/,
  // The password reset email points here (backend/services/emailService.js).
  // NOTHING in the frontend reads the token yet, so this currently lands on
  // the login screen. That is a broken flow either way, but a 404 would be a
  // worse answer than the login screen while it is being fixed.
  /^\/reset-password$/,
];

// ---------------------------------------------------------------------------
// THEME BEFORE FIRST PAINT
//
// ThemeProvider used to be the only thing that set <html data-theme>, and it
// does that in an effect, i.e. after the first paint. A dark-mode user opening
// the app got a full-brightness cream flash first. Worse, the provider now
// loads inside the lazy App chunk, so "after the effect" can be a second or
// more on a cold phone.
//
// This runs synchronously before render instead. Keep the storage keys and the
// night window in sync with src/context/ThemeContext.js, which reads the
// attribute this leaves behind as its own initial state.
// ---------------------------------------------------------------------------
const readStore = (key) => {
  // Safari private mode and "block all cookies" make localStorage itself
  // throw. Uncaught here that is a white screen before React ever mounts.
  try { return window.localStorage.getItem(key); } catch { return null; }
};

const isNightTime = () => {
  const hour = new Date().getHours();
  return hour >= 20 || hour < 6;
};

function applyStoredTheme() {
  const mode = readStore('flock-theme-mode') === 'manual' ? 'manual' : 'auto';
  const saved = readStore('flock-theme') === 'dark' ? 'dark' : 'light';
  const theme = mode === 'auto' ? (isNightTime() ? 'dark' : 'light') : saved;
  document.documentElement.setAttribute('data-theme', theme);
}

// ---------------------------------------------------------------------------
// LOADING STATES
//
// Every route used to mount with <Suspense fallback={null}>, which paints
// nothing at all: on a cold phone the visitor holds a blank white screen for
// as long as the chunk takes. These fallbacks are deliberately not spinners
// (SLOP-AUDIT F2/M): they either paint the colour the page is about to paint,
// or, where the wait is longest and the visitor is a stranger, they show the
// shape of the page that is coming.
// ---------------------------------------------------------------------------

// Landing hero is navy from the very top (.lp-hero), so cream would flash.
function LandingLoading() {
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0f172a' }}>
      <p className="sr-only" role="status">Loading Flock.</p>
    </div>
  );
}

// Legal and info pages (.pp) are cream on light, navy on dark, chosen by the
// system setting rather than the app's own theme.
function PaperLoading() {
  return (
    <div className="paper-loading">
      <style>{`
        .paper-loading { position: fixed; inset: 0; background: #f1ede0; }
        @media (prefers-color-scheme: dark) {
          .paper-loading { background: #0f172a; }
        }
      `}</style>
      <p className="sr-only" role="status">Loading the page.</p>
    </div>
  );
}

// Moderation dashboard paints its own near-black page.
function DarkLoading() {
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0e0e11' }}>
      <p className="sr-only" role="status">Loading the dashboard.</p>
    </div>
  );
}

// The app: <html> already carries data-theme by the time this renders, so
// var(--bg-primary) is the right colour in both themes. On iOS this sits
// between the native splash and the first app paint, which is exactly what
// capacitor.config.ts's backgroundColor is matched to.
function AppLoading() {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg-primary)' }}>
      <p className="sr-only" role="status">Loading Flock.</p>
    </div>
  );
}

// The guest invite is the one route where the person waiting has never seen
// Flock before, is on a phone, on mobile data, and will close the tab. A blank
// screen there is the single most expensive blank screen in the product, so it
// gets the real thing: the same masthead and the same skeleton GuestInvite
// itself shows while it fetches the plan, so the handoff between "chunk
// loading" and "plan loading" is invisible.
//
// Self-contained styles on purpose: GuestInvite.css ships inside the chunk
// that has not arrived yet. Values mirror src/website/GuestInvite.css.
const GUEST_LOADING_CSS = `
.gil {
  --gil-paper: #f1ede0;
  --gil-ink: #16283d;
  --gil-ink-3: #55637a;
  --gil-skel: rgba(22, 40, 61, 0.08);
  font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--gil-paper);
  color: var(--gil-ink-3);
  -webkit-font-smoothing: antialiased;
  line-height: 1.6;
  min-height: 100vh;
  padding: clamp(20px, 5vw, 48px) clamp(16px, 5vw, 40px) 72px;
}
@supports (min-height: 100dvh) { .gil { min-height: 100dvh; } }
@media (prefers-color-scheme: dark) {
  .gil {
    --gil-paper: #0f172a;
    --gil-ink: #f4efe3;
    --gil-ink-3: #9aa4b2;
    --gil-skel: rgba(244, 239, 227, 0.09);
    color-scheme: dark;
  }
}
.gil *, .gil *::before, .gil *::after { box-sizing: border-box; }
.gil-wrap { max-width: 34rem; margin: 0 auto; }
.gil-brand {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin: 0 0 clamp(24px, 6vw, 40px);
}
.gil-mark {
  font-size: 15px;
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--gil-ink);
  text-decoration: none;
}
.gil-line { font-size: 13.5px; color: var(--gil-ink-3); }
.gil-skel { display: block; border-radius: 8px; background: var(--gil-skel); }
.gil-h1 { height: clamp(34px, 8vw, 48px); max-width: 16rem; margin-bottom: 14px; }
.gil-meta { height: 15px; max-width: 12rem; margin-bottom: 32px; }
.gil-block { height: 120px; margin-bottom: 12px; border-radius: 12px; }
.gil-row { height: 56px; margin-bottom: 8px; border-radius: 12px; }
@media (prefers-reduced-motion: no-preference) {
  .gil-skel { animation: gil-pulse 1.4s ease-in-out infinite; }
}
@keyframes gil-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
`;

function GuestInviteLoading() {
  return (
    <main className="gil">
      <style>{GUEST_LOADING_CSS}</style>
      <div className="gil-wrap">
        <p className="gil-brand">
          <a className="gil-mark" href="/">Flock</a>
          <span className="gil-line">Where a group picks the place and the time.</span>
        </p>
        <p className="sr-only" role="status">Loading the invite.</p>
        <span className="gil-skel gil-h1" />
        <span className="gil-skel gil-meta" />
        <span className="gil-skel gil-block" />
        <span className="gil-skel gil-row" />
        <span className="gil-skel gil-row" />
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// ERROR FALLBACK FOR PAGES
//
// ErrorBoundary's default copy talks about your account, your flocks and your
// messages, which is right for the app and wrong for someone reading the
// privacy policy or opening an invite with no account at all. Same boundary,
// honest copy.
// ---------------------------------------------------------------------------
function pageErrorFallback({ error, eventId, reload }) {
  const isChunkError = !!error && (
    error.name === 'ChunkLoadError'
    || /Loading (CSS )?chunk/i.test(error.message || '')
  );
  const offlineNow = typeof navigator !== 'undefined' && navigator.onLine === false;

  return (
    <div className="page-error" role="alert">
      <style>{PAGE_ERROR_CSS}</style>
      <div className="page-error-card">
        <h1>{isChunkError ? "This page didn't finish loading" : "This page didn't load"}</h1>
        <p>
          {isChunkError
            ? 'Part of the page never arrived. That happens on a weak connection, or right after we ship an update.'
            : 'Something on this page broke while it was opening. Nothing you did caused it.'}
        </p>
        <p>
          {offlineNow
            ? "You're offline right now. Try again once you're back on signal."
            : 'Reloading usually fixes it.'}
        </p>
        <div className="page-error-actions">
          <button type="button" onClick={reload}>Reload the page</button>
          <a href="/">Go to flockcorp.com</a>
        </div>
        <p className="page-error-detail">{(error && error.message) || 'Unknown error'}</p>
        {eventId && <p className="page-error-detail">Reference {eventId}</p>}
      </div>
    </div>
  );
}

const PAGE_ERROR_CSS = `
.page-error {
  --pe-paper: #f1ede0;
  --pe-card: #fbf9f3;
  --pe-ink: #16283d;
  --pe-ink-2: #33475e;
  --pe-ink-3: #55637a;
  --pe-accent: #2d5a87;
  --pe-accent-ink: #f4efe3;
  --pe-rule: rgba(22, 40, 61, 0.16);
  font-family: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: var(--pe-paper);
  color: var(--pe-ink-2);
  line-height: 1.6;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(20px, 5vw, 48px) 20px;
}
@media (prefers-color-scheme: dark) {
  .page-error {
    --pe-paper: #0f172a;
    --pe-card: #1d293d;
    --pe-ink: #f4efe3;
    --pe-ink-2: #c8c3b2;
    --pe-ink-3: #9aa4b2;
    --pe-accent: #8fb4d6;
    --pe-accent-ink: #0f172a;
    --pe-rule: rgba(244, 239, 227, 0.18);
    color-scheme: dark;
  }
}
.page-error *, .page-error *::before, .page-error *::after { box-sizing: border-box; }
.page-error-card {
  width: 100%;
  max-width: 32rem;
  background: var(--pe-card);
  border: 1px solid var(--pe-rule);
  border-radius: 14px;
  padding: clamp(20px, 5vw, 28px);
}
.page-error h1 {
  margin: 0 0 12px;
  font-size: clamp(22px, 5vw, 28px);
  line-height: 1.2;
  letter-spacing: -0.02em;
  color: var(--pe-ink);
}
.page-error p { margin: 0 0 12px; font-size: 15px; }
.page-error-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 20px;
}
.page-error-actions button,
.page-error-actions a {
  flex: 1 1 10rem;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 10px 16px;
  border-radius: 10px;
  font: inherit;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
}
.page-error-actions button {
  background: var(--pe-accent);
  color: var(--pe-accent-ink);
  border: 1px solid var(--pe-accent);
}
.page-error-actions a {
  background: transparent;
  color: var(--pe-ink);
  border: 1px solid var(--pe-rule);
}
.page-error-detail {
  margin: 16px 0 0;
  font-size: 11.5px;
  line-height: 1.5;
  word-break: break-word;
  color: var(--pe-ink-3);
}
`;

// ---------------------------------------------------------------------------
// 404
//
// Every unknown path used to boot the whole App bundle, so a typo in a legal
// URL downloaded roughly a megabyte of JavaScript and then showed a login
// screen. This is a real page instead. It cannot send a 404 status (the host
// rewrites everything to index.html for the SPA), so it says noindex loudly
// enough that a crawler will not keep it.
// ---------------------------------------------------------------------------
function NotFound() {
  React.useEffect(() => {
    document.title = 'Page not found | Flock';
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => { meta.remove(); };
  }, []);

  return (
    <main className="page-error">
      <style>{PAGE_ERROR_CSS}</style>
      <div className="page-error-card">
        <h1>There's nothing at this address</h1>
        <p>
          The link was either mistyped or it points at a page we no longer have.
        </p>
        <div className="page-error-actions">
          <a href="/">Flock home</a>
          <a href="/support">Support</a>
        </div>
        {/* Scrubbed for the same reason every other outbound copy of the path
            is: a guest invite token must not end up quoted on screen, in a
            screenshot, or in a support email. /i/ never reaches this page
            today, but the scrub costs nothing and outlives the assumption. */}
        <p className="page-error-detail">Asked for {scrubUrlTokens(rawPath)}</p>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// ROUTE TABLE
// ---------------------------------------------------------------------------
const PAGES = [
  {
    id: 'privacy',
    test: (p) => p === '/privacy',
    load: () => import('./website/PrivacyPolicy'),
    Loading: PaperLoading,
  },
  {
    id: 'support',
    test: (p) => p === '/support',
    load: () => import('./website/SupportPage'),
    Loading: PaperLoading,
  },
  {
    id: 'terms',
    test: (p) => p === '/terms',
    load: () => import('./website/TermsOfService'),
    Loading: PaperLoading,
  },
  {
    id: 'guidelines',
    test: (p) => p === '/guidelines',
    load: () => import('./website/CommunityGuidelines'),
    Loading: PaperLoading,
  },
  {
    id: 'about',
    test: (p) => p === '/about',
    load: () => import('./website/AboutPage'),
    Loading: PaperLoading,
  },
  {
    id: 'delete-account',
    test: (p) => p === '/delete-account',
    load: () => import('./website/DeleteAccount'),
    Loading: PaperLoading,
  },
  {
    id: 'guest-invite',
    // Bare "/i" too: a link that got truncated in a group chat should hear
    // "that link is not complete" from the invite page, which knows what an
    // invite is, rather than a generic 404.
    test: (p) => p === '/i' || p.startsWith('/i/'),
    load: () => import('./website/GuestInvite'),
    Loading: GuestInviteLoading,
  },
  {
    id: 'moderation',
    test: (p) => p === '/admin/moderation',
    load: () => import('./website/ModerationDashboard'),
    Loading: DarkLoading,
  },
];

const LANDING_PAGE = {
  id: 'landing',
  load: () => import('./website/LandingPage'),
  Loading: LandingLoading,
};

// "/" is the marketing site on the web and the app inside the native shell.
const isMarketingRoot = !isNativeShell && !hasAppIntent
  && (path === '/' || path === '/landing' || path === '/index.html');

const page = isMarketingRoot ? LANDING_PAGE : PAGES.find((r) => r.test(path));

// The native shell must never 404 and never render a marketing page: whatever
// path the WebView happens to be sitting on, the app is the only correct
// answer inside it.
const wantsApp = !page && (
  isNativeShell
  || hasAppIntent
  || path === '/'
  || APP_PATHS.some((re) => re.test(path))
);

const root = ReactDOM.createRoot(document.getElementById('root'));

if (page) {
  const Page = React.lazy(page.load);
  const { Loading } = page;
  root.render(
    <React.StrictMode>
      {/* Outside Suspense on purpose: this also catches a chunk that 404s
          against a stale cached index.html after a deploy, which is a real
          production failure mode and, unhandled, is the same white screen as
          a render crash. /i/ in particular had no boundary at all, so a
          single throw in the guest page white-screened the one surface the
          product spreads through. */}
      <ErrorBoundary label={page.id} fallback={pageErrorFallback}>
        <React.Suspense fallback={<Loading />}>
          <Page />
        </React.Suspense>
      </ErrorBoundary>
    </React.StrictMode>
  );
} else if (wantsApp) {
  // Nothing about the theme is worth a white screen: everything below this
  // point still renders if the attribute never gets written.
  try { applyStoredTheme(); } catch { /* index.css defaults to the light tokens */ }

  // ThemeProvider used to be pulled in with a synchronous require(), which put
  // it, services/userSettings.js and all of services/api.js into the ENTRY
  // chunk: every visitor to the landing page and every guest opening an invite
  // downloaded the app's REST client before seeing anything. It loads with the
  // App chunk now, which already imports it anyway.
  const AppRoot = React.lazy(() => Promise.all([
    import('./App'),
    import('./context/ThemeContext'),
  ]).then(([app, theme]) => {
    const App = app.default;
    const { ThemeProvider } = theme;
    return {
      default: function AppWithTheme() {
        return (
          <ThemeProvider>
            <App />
          </ThemeProvider>
        );
      },
    };
  }));

  root.render(
    <React.StrictMode>
      {/* ThemeProvider writes data-theme onto <html> and never removes it, and
          applyStoredTheme above set it before this first render, so the
          fallback paints in the user's theme even though it renders before
          ThemeProvider exists and, on a crash, after it is gone. */}
      <ErrorBoundary label="app-root">
        <React.Suspense fallback={<AppLoading />}>
          <AppRoot />
        </React.Suspense>
      </ErrorBoundary>
    </React.StrictMode>
  );
} else {
  // Boundaried like every other route, so "no route matched" can never become
  // "no route matched AND the page that says so threw".
  root.render(
    <React.StrictMode>
      <ErrorBoundary label="not-found" fallback={pageErrorFallback}>
        <NotFound />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

reportWebVitals();
