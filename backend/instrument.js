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

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: SENTRY_ENVIRONMENT,
    release: SENTRY_RELEASE,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
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
