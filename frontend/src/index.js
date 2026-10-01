import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import reportWebVitals from './reportWebVitals';
import ErrorBoundary from './components/ErrorBoundary';
// Already in the entry chunk through ErrorBoundary, so the two page-level
// fallbacks below get their birds for free.
import { BirdieStill, BIRDIE, WARM_BIRD } from './components/ui/BirdieBird';
import FloppyBird from './components/ui/FloppyBird';
// The website's analytics bar. The app routes do not mount it: there, the
// signed-in account's own setting decides (followAccountForAnalytics below).
import ConsentBanner from './components/ConsentBanner';
import { hasAnalyticsConsent, onConsentChange, followAccountForAnalytics } from './services/analyticsConsent';
import { detectNativeShell } from './lib/nativeShell';
// Bearer tokens and live coordinates are scrubbed from every analytics and
// error payload that leaves the device. The rules and the reasons are in
// lib/scrubUrlTokens.js, which the crash report shares; re-exported here for
// src/__tests__/analyticsPrivacy.test.js.
import { scrubUrlTokens } from './lib/scrubUrlTokens';

export { scrubUrlTokens };

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
//
// SPANS ARE A FOURTH PLACE THE URL APPEARS, and they were the one place
// nothing swept. browserTracingIntegration turns every fetch into a span whose
// description is "GET <the whole url, query string included>" and whose
// data carries http.url / url.query. A transaction event holds those spans
// alongside the transaction name that beforeSendTransaction already scrubbed,
// so scrubbing only the name left the same string one field to the right.
// The trace context on an ERROR event carries the same data bag.
const scrubSentrySpans = (event) => {
  const bags = [];
  if (Array.isArray(event?.spans)) {
    for (const span of event.spans) {
      if (typeof span?.description === 'string') span.description = scrubUrlTokens(span.description);
      if (span?.data) bags.push(span.data);
    }
  }
  if (event?.contexts?.trace?.data) bags.push(event.contexts.trace.data);
  for (const bag of bags) {
    for (const key of Object.keys(bag)) {
      if (typeof bag[key] === 'string') bag[key] = scrubUrlTokens(bag[key]);
    }
  }
};

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
        scrubSentrySpans(event);
        return event;
      },
      beforeSendTransaction(event) {
        if (!event) return event;
        if (event.request?.url) event.request.url = scrubUrlTokens(event.request.url);
        if (typeof event.transaction === 'string') event.transaction = scrubUrlTokens(event.transaction);
        scrubSentrySpans(event);
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
// human-hands step. IT HAS BEEN DONE: project 555076 reports
// anonymize_ips true, read off the project settings on 2026-08-26. That is a
// statement about one date and about a switch in somebody else's dashboard,
// so re-check it rather than assuming it, and treat $geoip_disable below as
// the thing this code can actually guarantee. It asks ingestion not to derive
// city or region from that IP either way (the property server SDKs set via
// their disableGeoip option).
//
// A SECOND THING THAT DASHBOARD SAYS, and it is the reason the pinned config
// below is load-bearing rather than tidy. The project settings currently have
// heatmaps_opt_in true and capture_dead_clicks true, both switched on. The
// only reason neither is collected is that this object refuses them in code.
// The refusal is visible in the data: $dead_click stopped arriving on
// 2026-08-17 and $dead_swipe on 2026-08-14, which is when these lines
// shipped. Delete a line here and collection widens the same day, with no
// dashboard change to review. That is what analyticsPrivacy.test.js is for.
//
// The privacy policy (website/PrivacyPolicy.js) says PostHog keeps its
// identifier in local storage rather than in a cookie, which is what
// persistence 'localStorage' below makes true. Do not switch persistence back
// to a cookie mode without changing that page in the same commit. That is the
// config for an explicit yes to the website's bar. The app's signed-in default
// stores nothing at all: POSTHOG_SIGNED_IN_CONFIG, directly under this one.
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
  // PostHog's own web-vitals and network-timing capture, pinned off here
  // rather than left to a project setting: the privacy policy promises the
  // screens a person opens and a short list of hand-written events, and the
  // app's performance numbers already go through that list (trackWebVital).
  capture_performance: false,
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

// THE APP'S SIGNED-IN DEFAULT WRITES NOTHING TO THE DEVICE.
//
// In the app, analytics for a signed-in account runs because the account has
// not switched it off in Settings, not because this device said yes to
// anything. So PostHog there keeps its identifier, its session and everything
// else in memory for the life of the page: no local storage, no session
// storage, no cookie. The account is named by its number on every launch, so
// nothing needs to survive a reload. Every other value is POSTHOG_PRIVACY_CONFIG
// itself, spread rather than restated, so a privacy setting cannot drift
// between the two; analyticsPrivacy.test.js pins that this differs in
// persistence and in nothing else, and that the real SDK writes nothing with it.
export const POSTHOG_SIGNED_IN_CONFIG = {
  ...POSTHOG_PRIVACY_CONFIG,
  persistence: 'memory',
};

// ---------------------------------------------------------------------------
// WHERE ANALYTICS IS ALLOWED TO RUN
//
// frontend/.env carries a live REACT_APP_POSTHOG_KEY, which means every
// `npm start` has been reporting into the production project since analytics
// was switched on. Measured against PostHog on 2026-08-25: of 1,794 pageviews
// in the whole history of the project, 1,526 came from a localhost origin and
// 244 from www.flockcorp.com. The headline number a person would read off the
// dashboard, and every ratio built on it, was mostly a dev server, restarted
// over and over by whoever was working that day, each restart of a cleared
// browser profile arriving as another new visitor.
//
// The test is on the ORIGIN, not on NODE_ENV, because a production build
// served locally with `serve -s build` is still not a user, and NODE_ENV is
// 'production' for exactly that case.
//
// TWO ORIGINS MUST NOT BE CAUGHT BY IT, and both of them look local:
//   * iOS serves the app from capacitor://localhost. Not an http origin, so
//     the protocol test lets it through.
//   * ANDROID serves it from https://localhost, which is indistinguishable
//     from a dev server by hostname and protocol alone. window.Capacitor is
//     injected by the native bridge before this bundle runs and is absent from
//     the web build (see detectNativeShell in lib/nativeShell.js, which relies
//     on the same fact), so the bridge is the only thing that separates them.
//
// REACT_APP_POSTHOG_ALLOW_LOCAL=true opts a local build back in, for anyone
// deliberately testing that the pipeline still works end to end.
//
// Exported for src/__tests__/analyticsPrivacy.test.js.
export const isLocalAnalyticsOrigin = (loc, hasNativeBridge) => {
  try {
    if (!loc) return false;
    if (hasNativeBridge) return false;
    if (loc.protocol !== 'http:' && loc.protocol !== 'https:') return false;
    const host = String(loc.hostname || '').toLowerCase();
    return host === 'localhost'
      || host === '127.0.0.1'
      || host === '0.0.0.0'
      || host === '[::1]'
      || host === '::1'
      || host.endsWith('.local');
  } catch {
    return false;
  }
};

const analyticsEnabled = !!process.env.REACT_APP_POSTHOG_KEY && (
  process.env.REACT_APP_POSTHOG_ALLOW_LOCAL === 'true'
  || typeof window === 'undefined'
  || !isLocalAnalyticsOrigin(window.location, !!window.Capacitor)
);

/* NOTHING UNTIL SOMEBODY SAYS YES.
   This used to run here, at module scope, on page load — before render, before
   routing, and before any interaction. A first-time visitor to flockcorp.com, a
   legal page, or a guest invite got a $pageview sent with their IP and a
   distinct_id written to localStorage, unasked.

   What Flock collects is unusually restrained (autocapture, session recording,
   heatmaps, dead clicks, exception capture and surveys are all pinned off in
   POSTHOG_PRIVACY_CONFIG above, and every event is scrubbed by before_send).
   That is not the point: under ePrivacy Art. 5(3) the localStorage write itself
   needs consent however small the payload, and legitimate interest is not a
   substitute for it.

   The config object is unchanged and is still handed to init verbatim, which
   __tests__/analyticsPrivacy.test.js pins. Only the MOMENT moved.

   That is the WEBSITE's rule, and the bar is the website's question. The app
   routes ask nothing and start PostHog from the signed-in account's own
   setting instead: see THE APP, below.

   ONE INIT, TWO PINNED CONFIGS. This is the only posthog.init in the codebase,
   and it is handed one of the two exported objects above, never a copy:
   POSTHOG_PRIVACY_CONFIG when this device holds an explicit yes to the bar,
   which is what lets PostHog keep its identifier in local storage, and
   POSTHOG_SIGNED_IN_CONFIG, which keeps everything in memory, otherwise. */
function initPostHog(deviceStorage) {
  return import('posthog-js').then(({ default: posthog }) => {
    posthog.init(process.env.REACT_APP_POSTHOG_KEY, deviceStorage ? POSTHOG_PRIVACY_CONFIG : POSTHOG_SIGNED_IN_CONFIG);
    return posthog;
  });
}

export function startAnalytics() {
  if (!analyticsEnabled || !hasAnalyticsConsent()) return;
  // Returned so a caller can wait for init before anything else reaches the
  // SDK. A call that lands before init is dropped (services/api.js).
  return initPostHog(true).then((posthog) => {
    // A sign-out turns the SDK off (clearLocalSession in services/api.js), so
    // that nothing is recorded for the next person before they answer. The
    // yes that reaches here is that answer, so capture comes back on. A second
    // init on the same page is a no-op in posthog-js and would not do it, and
    // the opt-out is remembered across launches, so it is asked every time.
    // No $opt_in event: the answer itself is not something to record.
    if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing({ captureEventName: false });
  }).catch(() => { /* analytics is never load-bearing */ });
}

/* A YES THAT COMES BACK WITH ITS OWN ACCOUNT, on the website's own pages. A
   session ending takes the analytics answer with it and turns the SDK off;
   when the same account signs in again on this page,
   services/analyticsConsent.js gives the answer back without asking (WHOSE
   ANSWER IT IS there). Nothing tapped the bar, so nothing called
   startAnalytics, and a yes restored that way would otherwise sit in storage
   with the SDK still off. Once init has run, the account signed in now is
   named; api.js does nothing when nobody is. The sweep itself announces too,
   and leaves no yes, so this starts nothing then. Registered below, for every
   route but the app's. */
function startAnalyticsForReturningYes() {
  if (!hasAnalyticsConsent()) return;
  const started = startAnalytics();
  if (!started) return;
  started
    .then(() => import('./services/api'))
    .then((api) => api.identifySignedInUser())
    .catch(() => { /* analytics is never load-bearing */ });
}

/* THE APP: THE ACCOUNT'S OWN SETTING DECIDES, AND NOTHING IS STORED FOR IT.

   On the app routes, web and iOS, there is no analytics question on screen.
   Signed-in product analytics is part of the service agreed to at signup, and
   the account can switch it off in Settings ("Share usage analytics"), which
   is remembered on the account (GET and PUT /api/users/me/analytics).
   services/api.js reads that answer after every sign-in and at launch, sends
   nothing before it has it and nothing while signed out, and calls these two
   through the driver registered below (services/analyticsConsent.js).

   start() starts PostHog for an account whose answer is on, with
   POSTHOG_SIGNED_IN_CONFIG, so nothing at all is written to the device for it,
   unless this browser holds an explicit yes from the website's bar, the one
   case that already agreed to local storage. It resolves true once PostHog is
   running, and api.js names the account and sends what it held. stop() resets
   PostHog and turns capture off, and clears anything PostHog kept for this
   project on the device. Neither ever calls opt_in_capturing or
   opt_out_capturing, because both of those WRITE a record of the choice to
   local storage; capture is turned off and on with
   opt_out_capturing_by_default instead, which lives in memory.

   One posthog-js instance per page: init runs once, and a later account on
   the same page, after a sign-out, is started again with set_config. */
let accountPostHog = null;

// Removals only: PostHog's keys for this project, in local and session
// storage. Before the app's first start in memory mode, this takes away what
// older builds left behind: an identifier nobody will read again, and the
// opt-out record their sign-out wrote, which init would otherwise obey and
// keep capture off with no way back that does not write a new record. After a
// stop, it is the "clears anything it held" half of switching off.
function clearPostHogStorage({ optOutRecordOnly = false } = {}) {
  const key = process.env.REACT_APP_POSTHOG_KEY || '';
  if (!key) return;
  const optOutRecord = `__ph_opt_in_out_${key}`;
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      const store = window[name];
      const doomed = [];
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i);
        if (!k) continue;
        if (k === optOutRecord || (!optOutRecordOnly && k.startsWith(`ph_${key}`))) doomed.push(k);
      }
      doomed.forEach((k) => store.removeItem(k));
    } catch { /* storage blocked: nothing readable to clear */ }
  }
}

function startAccountAnalytics() {
  if (!analyticsEnabled) return Promise.resolve(false);
  const deviceStorage = hasAnalyticsConsent();
  if (!accountPostHog) {
    clearPostHogStorage({ optOutRecordOnly: deviceStorage });
    accountPostHog = initPostHog(deviceStorage).catch(() => null);
  } else {
    accountPostHog = accountPostHog.then((posthog) => {
      try {
        if (posthog) {
          posthog.set_config({
            persistence: deviceStorage ? POSTHOG_PRIVACY_CONFIG.persistence : POSTHOG_SIGNED_IN_CONFIG.persistence,
            opt_out_capturing_by_default: false,
          });
        }
      } catch { /* analytics is never load-bearing */ }
      return posthog;
    });
  }
  const running = accountPostHog.then((posthog) => !!posthog);
  // How fast the app is on a real device, measured only once analytics is on
  // for this account, for the same reason the website waits for its yes.
  running.then((on) => { if (on) attachWebVitals(); });
  return running;
}

function stopAccountAnalytics() {
  // NOT STARTED ON THIS PAGE IS NOT THE SAME AS NOTHING ON THE DEVICE. A page
  // that ran with an explicit website yes left the account's identity in
  // PostHog's local-storage record; if a later page never starts PostHog (the
  // account now reads off, or the read failed) and signs out, that record would
  // otherwise stay, and the next anonymous yes on the website would load it and
  // send its page view under that account's number.
  if (!accountPostHog) {
    clearPostHogStorage();
    return;
  }
  accountPostHog = accountPostHog.then((posthog) => {
    try {
      if (posthog) {
        // Forget the account, then turn capture off. Moving to memory first
        // takes an explicit yes's local-storage copy off the device as well.
        // reset(true) replaces the device id too: a sign-out does not reload
        // the page, and a kept $device_id would ride on the next account's
        // events and link two people who share a phone.
        posthog.reset(true);
        posthog.set_config({
          persistence: POSTHOG_SIGNED_IN_CONFIG.persistence,
          opt_out_capturing_by_default: true,
        });
      }
    } catch { /* analytics is never load-bearing */ }
    clearPostHogStorage();
    return posthog;
  });
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
// booting the app in a browser tab. The check lives in lib/nativeShell.js,
// because every surface that sells Pro or Roost has to reach the same answer
// this boot check does: a shell booted as native never shows a web price.
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
  // Handled by its own branch below: the standalone PasswordResetPage mounts
  // for this path whether or not a session exists. (This comment used to say
  // nothing read the token, which had stopped being true, and the signed-IN
  // case genuinely broke: App.js rendered the app and the token went unread.)
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
  // RECORDING-ONLY: the review recording's build forces the light theme, because
  // the Mac mini that films it keeps UTC time and any run after 20:00 UTC
  // would otherwise come out dark. Production never sets the flag.
  if (process.env.REACT_APP_REVIEW_FORCE_LIGHT === 'true') return false;
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
// (DESIGN-STANDARD F2/M): they either paint the colour the page is about to paint,
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

// /tap is navy edge to edge from the very first pixel (TapPage.css paints the
// element, not the photograph), so cream would flash. Same shape as
// LandingLoading and deliberately its own function: the two pages are free to
// change colour independently, and a shared fallback would drift silently.
function TapLoading() {
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0f172a' }}>
      <p className="sr-only" role="status">Loading Flock.</p>
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
        <BirdieStill bird={WARM_BIRD} size={72} eager style={{ margin: '0 0 12px' }} />
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
        {/* Two birds on the one page that has nothing else on it. */}
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', margin: '0 0 12px' }}>
          <BirdieStill bird={BIRDIE} size={72} eager />
          <BirdieStill bird={WARM_BIRD} size={56} eager />
        </div>
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
        {/* The one page with nothing else on it already gets two birds.
            This makes one of them flyable. Collapsed until asked for. */}
        <FloppyBird />
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
    // A REACT_APP_PURCHASES=off build (the App Store one) carries no copy of
    // the policy, which names where each plan is bought, and points at the
    // published text instead (website/LegalOnTheWeb.js has why). The literal
    // test keeps the full page's chunk out of that build.
    load: process.env.REACT_APP_PURCHASES === 'off'
      ? () => import('./website/LegalOnTheWeb').then((m) => ({ default: () => <m.default doc="privacy" /> }))
      : () => import('./website/PrivacyPolicy'),
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
    // Same as /privacy: the Terms price Roost and set out how Flock Pro is
    // sold, so a REACT_APP_PURCHASES=off build points at the published text.
    load: process.env.REACT_APP_PURCHASES === 'off'
      ? () => import('./website/LegalOnTheWeb').then((m) => ({ default: () => <m.default doc="terms" /> }))
      : () => import('./website/TermsOfService'),
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
    // Same as /terms: the About page sets out Roost and Flock Pro and asks
    // venues to write in for early access, so a REACT_APP_PURCHASES=off build
    // points at the published page and leaves this one's chunk out.
    load: process.env.REACT_APP_PURCHASES === 'off'
      ? () => import('./website/LegalOnTheWeb').then((m) => ({ default: () => <m.default doc="about" /> }))
      : () => import('./website/AboutPage'),
    Loading: PaperLoading,
  },
  {
    // What the research found, in plain words, and the paper. Linked from the
    // landing page's menu only.
    id: 'research',
    test: (p) => p === '/research',
    load: () => import('./website/ResearchPage'),
    Loading: PaperLoading,
  },
  // Flock Pro on the web. WEB ONLY: inside the native shell this route does
  // not match, so the WebView falls through to the app like any other path.
  // Apple does not allow the app to point at a web price outside the US, and
  // the page repeats the check itself in case it is ever mounted another way.
  // A REACT_APP_PURCHASES=off build (the App Store one) has no /pro at all:
  // the literal test lets webpack leave the page's chunk out of that build
  // (lib/purchasesBuild.js).
  ...(process.env.REACT_APP_PURCHASES === 'off' ? [] : [{
    id: 'pro',
    test: (p) => p === '/pro' && !isNativeShell,
    load: () => import('./website/ProPage'),
    Loading: PaperLoading,
  }]),
  {
    // Every physical NFC tag Flock has points at this one URL: the acrylic
    // table stand at the DECA booth (/tap?s=stand) and the business cards
    // handed to judges (/tap?s=card). A chip holds exactly one URL, so the
    // page is the thing that changes, never the tags. It has to be a PAGE and
    // not a fall-through: booting the app bundle here would show a judge a
    // login screen, and a 404 would show them nothing at all. `path` is
    // already lowercased and de-trailing-slashed above, so /TAP and /tap/ both
    // land here; the ?s= query is read by the page off the raw location.
    id: 'tap',
    test: (p) => p === '/tap',
    load: () => import('./website/TapPage'),
    Loading: TapLoading,
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

// The marketing page sells Flock Pro, and the native shell never shows it
// (isMarketingRoot below), so a REACT_APP_PURCHASES=off build, which is only
// ever the App Store one, does not carry it (lib/purchasesBuild.js).
const LANDING_PAGE = process.env.REACT_APP_PURCHASES === 'off' ? null : {
  id: 'landing',
  load: () => import('./website/LandingPage'),
  Loading: LandingLoading,
};

// "/" is the marketing site on the web and the app inside the native shell.
const isMarketingRoot = !!LANDING_PAGE && !isNativeShell && !hasAppIntent
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

// services/api.js binds each page load to the account it began with, refuses
// every request once another tab of this browser has signed in as somebody
// else (or signed out), and announces 'flock-account-switched' when it sees
// that (WHOSE TAB THIS IS). The reload lives here, above every page, and not
// in the app alone: /pro and the moderation console send through api.js too,
// and a page with nobody listening sat refusing every action, telling the
// visitor it was reloading when nothing was. Reloading starts the tab over as
// whoever is signed in now. A DOM event, so api.js stays out of this chunk.
window.addEventListener('flock-account-switched', () => { window.location.reload(); });

// The app itself is what mounts below when no page claimed the path and it is
// neither of the two standalone auth pages, which match APP_PATHS but render
// on their own. Spelled out once, because analytics follows it.
const appMounted = wantsApp && !page && path !== '/reset-password' && path !== '/verify-email';

// WHO DECIDES ANALYTICS ON THIS PAGE.
//
// The app: the signed-in account's own setting, through the driver above. No
// bar is mounted, nothing runs before sign-in, and nothing is stored for it.
//
// Every other route: the website's bar, as before. A returning visitor who
// already said yes starts once the page they came for has loaded. That used
// to be a bare call at module scope, hundreds of lines above root.render(),
// which put import('posthog-js') (~70 KB gzipped), the init and a cold DNS +
// TLS handshake to PostHog AHEAD of the route chunk the person was waiting
// for; afterLoad (a hoisted declaration at the foot of this file) defers it.
// ConsentBanner's onAnswer still calls startAnalytics DIRECTLY, so a fresh yes
// starts at once rather than waiting for a load event that has long since
// fired, and the two cannot both run on the first answer of a visit, because
// the bar only renders when nobody has answered.
if (appMounted) {
  followAccountForAnalytics({
    enabled: analyticsEnabled,
    start: startAccountAnalytics,
    stop: stopAccountAnalytics,
  });
} else {
  onConsentChange(startAnalyticsForReturningYes);
  if (hasAnalyticsConsent()) afterLoad(startAnalytics);
}

const root = ReactDOM.createRoot(document.getElementById('root'));

if (page) {
  const Page = React.lazy(page.load);
  const { Loading } = page;
  root.render(
    <React.StrictMode>
      {/* The website's ask, on every route but the app's. Renders nothing
          once answered, and declining is remembered. */}
      <ConsentBanner onAnswer={startAnalytics} />
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
} else if (path === '/reset-password') {
  // The signed-IN reset case. Signed out, the app boots and LoginScreen
  // routes into its reset view; signed IN, App.js rendered the app and the
  // emailed token was never read, on exactly the machine someone resets a
  // suspect password from. PasswordResetPage is self-contained (no props,
  // navigates by URL) and its own file spells out this branch.
  const PasswordResetPage = React.lazy(() => import('./components/auth/PasswordReset')
    .then((m) => ({ default: m.PasswordResetPage })));
  root.render(
    <React.StrictMode>
      {/* The website's ask, on every route but the app's. Renders nothing
          once answered, and declining is remembered. */}
      <ConsentBanner onAnswer={startAnalytics} />
      <ErrorBoundary label="reset-password" fallback={pageErrorFallback}>
        <React.Suspense fallback={null}><PasswordResetPage /></React.Suspense>
      </ErrorBoundary>
    </React.StrictMode>
  );
} else if (path === '/verify-email') {
  // Where the signup confirmation link lands (backend/services/emailService.js
  // verificationLink). Its own page for the reset page's reason, that it has
  // to work whether or not this browser holds a session, and for one of its
  // own: it spends the token only when somebody presses its button, because a
  // mail scanner fetching a link is not a person confirming an address.
  const VerifyEmailPage = React.lazy(() => import('./components/auth/VerifyEmailPage'));
  root.render(
    <React.StrictMode>
      {/* The website's ask, on every route but the app's. Renders nothing
          once answered, and declining is remembered. */}
      <ConsentBanner onAnswer={startAnalytics} />
      <ErrorBoundary label="verify-email" fallback={pageErrorFallback}>
        <React.Suspense fallback={null}><VerifyEmailPage /></React.Suspense>
      </ErrorBoundary>
    </React.StrictMode>
  );
} else if (appMounted) {
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
      {/* No analytics bar in the app, on the web or in the iOS shell. Signed
          in, the account's own setting decides (followAccountForAnalytics
          above, and "Share usage analytics" in Settings); signed out, nothing
          runs at all. */}
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
      {/* The website's ask, on every route but the app's. Renders nothing
          once answered, and declining is remembered. */}
      <ConsentBanner onAnswer={startAnalytics} />
      <ErrorBoundary label="not-found" fallback={pageErrorFallback}>
        <NotFound />
      </ErrorBoundary>
    </React.StrictMode>
  );
}

// ---------------------------------------------------------------------------
// THE TWO EVENTS THIS FILE OWNS
//
// Both go through services/api.js, because __tests__/analyticsPrivacy.test.js
// requires every posthog.capture in src/ to live in that one file, and that
// rule is worth more than the two lines it costs here.
//
// The import is dynamic AND deferred to after the load event. Dynamic so the
// REST client does not rejoin the entry chunk, which is the regression the
// ThemeProvider note above describes. Deferred because the guest invite page
// does not import api.js at all and is the most expensive blank screen in the
// product: a stranger, on a phone, on mobile data, who will close the tab. An
// analytics chunk must never be in the queue ahead of the one they are waiting
// for.
//
// Nothing here is load-bearing. A rejected import, a missing api.js export or
// a thrown capture all end in the same place: the page renders and the event
// is lost, which is the correct trade for a number.
// ---------------------------------------------------------------------------

// THREE CALLERS NOW, and one of them is above this line. A hoisted function
// declaration on purpose: startAnalytics for a returning consented visitor is
// deferred here too, and that call sits in WHO DECIDES ANALYTICS ON THIS PAGE,
// above the render, where the reasoning for it belongs. Keep this a
// declaration rather than a const, or that call breaks at boot.
function afterLoad(fn) {
  if (typeof window === 'undefined') return;
  if (document.readyState === 'complete') { setTimeout(fn, 0); return; }
  window.addEventListener('load', () => setTimeout(fn, 0), { once: true });
}

if (analyticsEnabled) {
  afterLoad(() => {
    import('./services/api').then((api) => {
      // A bare "/i" is a link that lost its token on the way through a group
      // chat. It is a different event from a real invite being opened, and
      // telling them apart is the only reason this argument exists. The token
      // itself is not passed, is not read here, and has no property to sit in.
      // In the app, services/api.js holds this until the signed-in account's
      // setting is known, and drops it when nobody is signed in.
      if (page && page.id === 'guest-invite') api.trackInviteLinkOpened(path !== '/i');
      else if (appMounted) api.trackAppOpened(isNativeShell ? 'native' : 'web');
    }).catch(() => { /* see above */ });
  });
}

/* THE ARGUMENT IS THE WHOLE POINT.
   This line was `reportWebVitals()`, CRA's default. reportWebVitals only
   imports web-vitals when it is handed a function, so with no argument the
   module never loaded, no metric was ever collected, and nothing in this
   product has ever measured its own speed anywhere but on a developer's
   machine.

   GATED ON CONSENT AT THE CALL, not merely at the capture. track() already
   refuses to send without consent, so passing the callback unconditionally
   would leak nothing - but it would still DOWNLOAD web-vitals for somebody who
   said no, which is precisely the shape just closed in services/api.js. It is
   not going back in through a different door.

   Behind afterLoad, because a measurement must not compete with the thing it
   is measuring. The metrics themselves are collected by the browser from the
   moment the page starts regardless of when the library attaches; web-vitals
   reads them out of the performance timeline, so deferring the import costs no
   accuracy. LCP and CLS are reported on hide, long after this.

   IN THE APP THE GATE IS THE ACCOUNT'S SETTING, so web-vitals is attached by
   startAccountAnalytics once analytics is running for a signed-in account,
   and never for anyone signed out or switched off. Once per page either way. */
let webVitalsAttached = false;
function attachWebVitals() {
  if (webVitalsAttached) return;
  webVitalsAttached = true;
  // ONE OBSERVER PER PAGE, BUT ANALYTICS BELONGS TO AN ACCOUNT. Some metrics
  // (CLS, LCP) arrive only when the page is hidden, which can be after a
  // sign-out and another account's sign-in on the same page, since a sign-out
  // does not reload it. The analytics run in progress when measuring starts is
  // recorded here, and a metric that arrives after that run has ended (a
  // sign-out, an account change, switching off) is dropped rather than sent
  // under whoever is signed in by then.
  const runAtAttach = import('./services/api')
    .then((api) => api.analyticsRunToken())
    .catch(() => undefined);
  reportWebVitals((metric) => {
    Promise.all([import('./services/api'), runAtAttach])
      .then(([api, run]) => api.trackWebVital(metric, page ? page.id : (wantsApp ? 'app' : 'other'), run))
      .catch(() => { /* a number is never load-bearing */ });
  });
}

if (analyticsEnabled && !appMounted && hasAnalyticsConsent()) {
  afterLoad(attachWebVitals);
}
