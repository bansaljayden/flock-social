// Sentry initialization (B3).
// Must be required BEFORE any other module in server.js so the SDK can
// auto-instrument HTTP/Express.
//
// THE ONE HUMAN STEP: set SENTRY_DSN in the Railway service variables.
// Everything else is already wired and goes live the moment that variable
// exists (Railway redeploys on a variable change, nothing else to do):
//   * environment tagging  — RAILWAY_ENVIRONMENT, falling back to NODE_ENV;
//   * release tagging      — Railway's own commit SHA, so every event names
//                            the exact push that produced it (this service
//                            deploys on every push with no test gate);
//   * request errors       — Sentry.setupExpressErrorHandler in server.js;
//   * floating promises    — the unhandledRejection handler in server.js
//                            calls Sentry.captureException;
//   * uncaught exceptions  — @sentry/node's default onUncaughtException
//                            integration captures, flushes, and exits.
// Never commit the DSN; it lives in the Railway dashboard only.
require('dotenv').config();
const Sentry = require('@sentry/node');

const SENTRY_ENVIRONMENT =
  process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV || 'development';
// Railway injects the deploy's commit SHA. Locally it is undefined, which
// Sentry treats as "no release" — fine for development.
const SENTRY_RELEASE = process.env.RAILWAY_GIT_COMMIT_SHA || undefined;

// ─── THE SCRUBBER ───────────────────────────────────────────────────────────
//
// SECURITY ROUND 5, 2026-08-20. Everything below is dormant today because
// SENTRY_DSN is unset — which is exactly why it had to be written today. The
// "one human step" this file advertises is a single Railway variable, and
// until now that one step also shipped every one of the following off our
// infrastructure, with nobody reviewing a diff at the moment it happened:
//
//   1. LIVE TOKENS IN URLS. @sentry/node filters `query_string` against its
//      credential deny-list but NOT `request.url`, which the SDK includes
//      unconditionally. Two of this app's URLs carry a working credential in
//      the query string: GET /api/venue-digest/opt-out?token=… (a signed
//      opt-out token with a 180-DAY life) and the email verification and
//      password-reset links in routes/auth.js. One 500 on any of them and a
//      usable token is sitting in a third-party issue tracker.
//   2. LOCAL VARIABLES. `localVariablesIntegration` is on by default and
//      captures in-scope variables for every stack frame of an unhandled
//      exception. The frames that throw most often in this codebase are in
//      routes/auth.js and routes/users.js, where the locals in scope are
//      `email`, `password`, `current_password`, `token` and the whole `user`
//      row.
//   3. CONSOLE BREADCRUMBS. `consoleIntegration` is on by default and attaches
//      the last console lines to every event. This app logs raw email
//      addresses next to raw user ids on the auth paths, a trusted contact's
//      email on the SOS path, and a name↔id pair on every socket connection.
//      Without this, one error carries a slice of that mapping table with it.
//
// The three are turned off or rewritten below. This is a DENY-BY-DEFAULT pass
// on the two fields that can hold a credential and an ALLOW-NOTHING stance on
// frame locals, rather than an attempt to enumerate every secret name: a
// scrubber written as a list of things to remove fails the day somebody adds a
// field, and this one fails closed instead.
const CRED_QUERY_KEYS = /^(token|code|key|secret|password|pass|auth|jwt|session|sig|signature|access_token|refresh_token|id_token)$/i;

// Strip the query string from a URL, keeping every credential-free parameter
// so the event still says which variant of a route failed. Anything that does
// not parse as a URL loses its query half wholesale — an unparseable URL is
// not a thing to guess about.
function scrubUrl(raw) {
  if (typeof raw !== 'string' || raw === '') return raw;
  const cut = raw.indexOf('?');
  if (cut < 0) return raw;
  const path = raw.slice(0, cut);
  let params;
  try {
    params = new URLSearchParams(raw.slice(cut + 1));
  } catch (e) {
    return path;
  }
  for (const k of [...params.keys()]) {
    if (CRED_QUERY_KEYS.test(k)) params.set(k, '[Filtered]');
  }
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path;
}

// Anything that looks like an address, anywhere in a string. Breadcrumbs and
// messages are free-form by construction, so this is a shape match rather than
// a field name match: the log lines that carry addresses (routes/auth.js,
// routes/safety.js) build them by interpolation and have no field to name.
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A JWT, wherever it turns up: three dot-separated base64url runs.
const JWT_SHAPE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

function scrubText(s) {
  if (typeof s !== 'string') return s;
  return s.replace(JWT_SHAPE, '[jwt]').replace(EMAIL_SHAPE, '[email]');
}

// One pass over an event: the request URL, every breadcrumb message, the
// exception messages, and the top-level message. Frame locals are not scrubbed
// here — they are switched off at the integration, because a value-shaped
// scrubber over arbitrary locals is a promise this file cannot keep.
function scrubEvent(event) {
  try {
    if (event.request) {
      if (event.request.url) event.request.url = scrubUrl(event.request.url);
      // Belt and braces: the SDK filters this already, and it costs one line
      // to not depend on that continuing to be true.
      delete event.request.query_string;
      delete event.request.cookies;
      delete event.request.data;
    }
    if (Array.isArray(event.breadcrumbs)) {
      for (const b of event.breadcrumbs) {
        if (b && typeof b.message === 'string') b.message = scrubText(b.message);
        if (b && b.data && typeof b.data.url === 'string') b.data.url = scrubUrl(b.data.url);
      }
    }
    if (event.message) event.message = scrubText(event.message);
    if (event.exception && Array.isArray(event.exception.values)) {
      for (const v of event.exception.values) {
        if (v && typeof v.value === 'string') v.value = scrubText(v.value);
      }
    }
  } catch (e) {
    // A scrubber that throws must not become a reason the event is dropped
    // silently OR sent unscrubbed. Dropping is the safe half of that choice.
    return null;
  }
  return event;
}

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: SENTRY_ENVIRONMENT,
    release: SENTRY_RELEASE,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
    // Stated rather than left to the default, because the default is the thing
    // being relied on and a default can change under a minor version bump.
    sendDefaultPii: false,
    // Frame locals off. See note 2 above.
    includeLocalVariables: false,
    integrations: (defaults) => defaults.filter(
      (i) => i && i.name !== 'LocalVariables' && i.name !== 'Console'
    ),
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
    beforeBreadcrumb: (crumb) => {
      if (!crumb) return crumb;
      if (typeof crumb.message === 'string') crumb.message = scrubText(crumb.message);
      if (crumb.data && typeof crumb.data.url === 'string') crumb.data.url = scrubUrl(crumb.data.url);
      return crumb;
    },
  });
  console.log(
    `Sentry initialized [environment=${SENTRY_ENVIRONMENT}` +
    (SENTRY_RELEASE ? `, release=${SENTRY_RELEASE.slice(0, 12)}` : '') + ']'
  );
} else {
  // One line, once per boot, so the absence is a fact in the Railway log
  // rather than a surprise during the first incident. Errors still reach the
  // Railway logs through the console handlers in server.js; what is missing
  // without the DSN is aggregation and alerting.
  console.log(
    'Sentry DISABLED: SENTRY_DSN is unset. One step turns it on — add SENTRY_DSN ' +
    'to the Railway service variables. No code change needed.'
  );
}

// Exposed so __tests__ can drive the scrubber without a DSN and without the
// SDK: the scrubber is the security control here, and a control nothing can
// exercise is a control nobody can prove still works.
module.exports = { scrubUrl, scrubText, scrubEvent };
